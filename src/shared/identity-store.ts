// shared/identity-store.ts — mesh identity persistence.
//
// Problem: /reload (and pi extension reloads in general) fire
// session_shutdown + session_start: the old MeshClient is closed (the broker
// purges alias, rooms and reservations with the connection) and a NEW client
// is created — with a NEW random alias. The agent "loses" its mesh identity
// on every reload.
//
// Fix: persist the identity per pi-sessionId in
// <stateDir>/identity-<sessionId>.json — ONE FILE PER SESSION, because many
// sessions share the same stateDir (<cwd>/.mesh): a single shared file would
// be overwritten by every session's shutdown, making the others lose their
// identity on the next reload. The pi sessionId is stable across reloads
// (the session manager survives), so a reload re-loads the exact same alias,
// rooms and reservations. A different sessionId (new session, fork) gets a
// fresh identity.
//
// Migration: a legacy single-file <stateDir>/identity.json (v0.1.3-v0.1.7)
// is read once and moved to the per-session file when its sessionId matches.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { nowIso } from "../protocol/frames.js";
import { isValidReservations, type FileReservation } from "../protocol/envelope.js";

export const IDENTITY_FILE_NAME = "identity.json"; // legacy single-file name
export const IDENTITY_PREFIX = "identity-";
export const IDENTITY_PENDING_NAME = "identity-pending.json";
export const IDENTITY_VERSION = 1;
/** Persisted reservations older than this are NOT re-declared at hello. */
export const RESERVATION_TTL_MS = 86_400_000; // 24 h
/** a /mesh new handoff is only valid for this long. */
export const PENDING_TTL_MS = 900_000; // 15 min

export interface PersistedIdentity {
  version: typeof IDENTITY_VERSION;
  sessionId: string;
  alias: string;
  rooms: string[];
  reservations: FileReservation[];
  updatedAt: string;
}

/** Snapshot the current client state into a persistable identity. */
export function identityFromClient(
  sessionId: string,
  client: {
    alias: string;
    rooms: readonly string[];
    reservations: readonly FileReservation[];
  },
): PersistedIdentity {
  return {
    version: IDENTITY_VERSION,
    sessionId,
    alias: client.alias,
    rooms: [...client.rooms],
    reservations: client.reservations.map((r) => ({ ...r })),
    updatedAt: nowIso(),
  };
}

/** Drop reservations whose `since` is older than the TTL (stale claims). */
function freshReservations(list: FileReservation[], now: number = Date.now()): FileReservation[] {
  return list.filter((r) => {
    if (r.since === undefined) return true; // unknown age → keep (best effort)
    const t = Date.parse(r.since);
    if (Number.isNaN(t)) return true;
    return now - t < RESERVATION_TTL_MS;
  });
}

export class MeshIdentity {
  constructor(private readonly stateDir: string) {}

  /** Per-session file: <stateDir>/identity-<sessionId>.json */
  private pathFor(sessionId: string): string {
    return path.join(this.stateDir, `${IDENTITY_PREFIX}${sessionId}.json`);
  }

  private get legacyPath(): string {
    return path.join(this.stateDir, IDENTITY_FILE_NAME);
  }

  private parse(raw: string, sessionId: string, ignoreSessionId = false): PersistedIdentity | null {
    try {
      const value: unknown = JSON.parse(raw);
      if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
      const id = value as Record<string, unknown>;
      if (id.version !== IDENTITY_VERSION) return null;
      if (!ignoreSessionId && id.sessionId !== sessionId) return null;
      if (typeof id.alias !== "string" || id.alias === "") return null;
      const rooms = Array.isArray(id.rooms)
        ? id.rooms.filter((r): r is string => typeof r === "string")
        : [];
      const reservations = isValidReservations(id.reservations)
        ? freshReservations(id.reservations)
        : [];
      return {
        version: IDENTITY_VERSION,
        sessionId,
        alias: id.alias,
        rooms,
        reservations,
        updatedAt: typeof id.updatedAt === "string" ? id.updatedAt : nowIso(),
      };
    } catch {
      return null;
    }
  }

  /**
  * Load the identity belonging to `sessionId`. Returns null when absent,
  * from another session, malformed, or on an older version — callers then
  * start fresh (random alias, default rooms, no reservations).
  */
  load(sessionId: string): PersistedIdentity | null {
    if (sessionId === "") return null;
    try {
      const raw = readFileSync(this.pathFor(sessionId), "utf8");
      return this.parse(raw, sessionId);
    } catch {
  // fall through to the legacy single-file identity (v0.1.3-v0.1.7)
    }
    try {
      const raw = readFileSync(this.legacyPath, "utf8");
      const id = this.parse(raw, sessionId);
      if (id === null) return null;
  // migrate: move the legacy file to the per-session file, then remove it
      try {
        mkdirSync(this.stateDir, { recursive: true });
        renameSync(this.legacyPath, this.pathFor(sessionId));
      } catch {
  // best effort — the legacy file may be re-read next time
      }
      return id;
    } catch {
      return null;
    }
  }

  /**
  * factory-reset this session's identity — /mesh reset behaves like
  * /new (fresh alias, default rooms, no reservations) while staying in the
  * same pi session. Best effort — never throws.
  */
  reset(sessionId: string): void {
    if (sessionId === "") return;
    try {
      unlinkSync(this.pathFor(sessionId));
    } catch {
  // already gone
    }
  }

  // ---- /mesh new identity handoff ----

  private get pendingPath(): string {
    return path.join(this.stateDir, IDENTITY_PENDING_NAME);
  }

  /**
  * Stage the current identity for the NEXT session (created by /mesh new)
  * alias + rooms + reservations (and optionally a compact history) travel
  * through identity-pending.json, consumed by the next session_start.
  */
  savePending(
    identity: PersistedIdentity,
    history?: string[],
  ): void {
    try {
      mkdirSync(this.stateDir, { recursive: true });
      const payload = { ...identity, history };
      const tmp = this.pendingPath + ".tmp";
      writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", "utf8");
      renameSync(tmp, this.pendingPath);
    } catch {
  // best effort
    }
  }

  /**
  * Take the staged identity (if fresh enough) and clear the file.
  * Returns { identity, history } or null. The history is the compact
  * transferred conversation --history flag).
  */
  consumePending(now: number = Date.now()): { identity: PersistedIdentity; history?: string[] } | null {
    let raw: string;
    try {
      raw = readFileSync(this.pendingPath, "utf8");
    } catch {
      return null;
    }
    try {
      const value: unknown = JSON.parse(raw);
      if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
      const p = value as Record<string, unknown>;
      if (typeof p.updatedAt !== "string") return null;
      const age = now - Date.parse(p.updatedAt);
      if (Number.isNaN(age) || age < 0 || age > PENDING_TTL_MS) {
        try {
          unlinkSync(this.pendingPath); // stale handoff — drop it
        } catch {
  // already gone
        }
        return null;
      }
      const parsed = this.parse(raw, "", true); // pending carries the OLD sessionId
      if (parsed === null) return null;
      const history = Array.isArray(p.history)
        ? p.history.filter((h): h is string => typeof h === "string")
        : undefined;
      unlinkSync(this.pendingPath);
      return { identity: parsed, history: history !== undefined && history.length > 0 ? history : undefined };
    } catch {
      return null;
    }
  }

  /** Persist atomically (tmp + rename). Best effort — never throws. */
  save(identity: PersistedIdentity): void {
    try {
      mkdirSync(this.stateDir, { recursive: true });
      const target = this.pathFor(identity.sessionId);
      const tmp = target + ".tmp";
      writeFileSync(tmp, JSON.stringify(identity, null, 2) + "\n", "utf8");
      renameSync(tmp, target);
    } catch {
  // best effort
    }
  }

  /** List every persisted identity in this stateDir (sessions command /
   *  adoption targets). Corrupt or unusable files are SKIPPED and REPORTED
   *  in `skipped` — a store layer does not print; the caller decides how to
   *  surface the loss. READ-ONLY: nothing is written, moved or deleted. */
  list(): { identities: ListedIdentity[]; skipped: string[] } {
    const identities: ListedIdentity[] = [];
    const skipped: string[] = [];
    let names: string[];
    try {
      names = readdirSync(this.stateDir);
    } catch {
      return { identities, skipped }; // no stateDir — no identities
    }
    for (const name of names) {
      if (!name.startsWith(IDENTITY_PREFIX) || !name.endsWith(".json")) continue;
      const sessionId = name.slice(IDENTITY_PREFIX.length, -".json".length);
      if (sessionId === "" || sessionId === "pending") continue; // legacy single file / handoff staging
      try {
        const id = this.parse(readFileSync(path.join(this.stateDir, name), "utf8"), sessionId);
        if (id !== null) {
          identities.push({ ...id, sessionId });
        } else {
          skipped.push(name); // unreadable/corrupt/foreign-version
        }
      } catch {
        skipped.push(name);
      }
    }
    return { identities, skipped };
  }
}

export interface ListedIdentity extends PersistedIdentity {
  sessionId: string;
}

/** Path of the per-session identity file (exported for tests). */
export function identityPath(stateDir: string, sessionId: string): string {
  return path.join(stateDir, `${IDENTITY_PREFIX}${sessionId}.json`);
}

export function identityFileExists(stateDir: string, sessionId: string): boolean {
  return existsSync(identityPath(stateDir, sessionId));
}
