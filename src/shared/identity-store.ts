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
/** Named agent-slot identity: identity-key-<key>.json (see MeshConfig.identityKey). */
export const IDENTITY_KEY_PREFIX = "identity-key-";
export const IDENTITY_PENDING_NAME = "identity-pending.json";
export const IDENTITY_VERSION = 1;
/** A slot key becomes a filename component — strict charset, no traversal. */
export const IDENTITY_KEY_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Persisted reservations older than this are NOT re-declared at hello. */
export const RESERVATION_TTL_MS = 86_400_000; // 24 h
/** a /mesh new handoff is only valid for this long. */
export const PENDING_TTL_MS = 900_000; // 15 min

export interface PersistedIdentity {
  version: typeof IDENTITY_VERSION;
  sessionId: string;
  alias: string;
  /**
   * The last alias the user EXPLICITLY chose (/mesh alias, /mesh join … as …).
   * When a conflict forced a random fallback, `alias` holds the fallback but
   * `preferredAlias` keeps the chosen one — the next attach retries it, so
   * the identity self-heals once the holder disconnects. Optional for
   * backward compatibility with identities written before the field.
   */
  preferredAlias?: string;
  rooms: string[];
  reservations: FileReservation[];
  updatedAt: string;
}

/** Snapshot the current client state into a persistable identity.
 *
 * `preferredAlias` is the alias the user CHOSE. It must survive a conflict
 * fallback: `alias` becomes the random fallback (what we are connected as),
 * `preferredAlias` stays the chosen name so the next attach can retry it.
 * Omitting it here was the Pi-side write/read asymmetry — every save wiped
 * the field the loader was taught to preserve, so a fallback permanently
 * destroyed the chosen name (the "my agent changed name" bug). */
export function identityFromClient(
  sessionId: string,
  client: {
    alias: string;
    rooms: readonly string[];
    reservations: readonly FileReservation[];
  },
  preferredAlias?: string,
): PersistedIdentity {
  const preferred =
    preferredAlias !== undefined && preferredAlias !== "" ? preferredAlias : undefined;
  return {
    version: IDENTITY_VERSION,
    sessionId,
    alias: client.alias,
    ...(preferred !== undefined ? { preferredAlias: preferred } : {}),
    rooms: [...client.rooms],
    reservations: client.reservations.map((r) => ({ ...r })),
    updatedAt: nowIso(),
  };
}

/** How the initial alias/rooms were chosen — surfaced by /mesh broker and
 *  used by tests (no guessing in the integration assertions). */
export type IdentityChoiceReason = "config-alias" | "preferred" | "persisted" | "fresh";

export interface IdentityChoice {
  /** Alias requested at hello (undefined → the client picks a random one). */
  alias: string | undefined;
  /** The alias this session should keep reclaiming. */
  preferredAlias: string | undefined;
  rooms: string[];
  reason: IdentityChoiceReason;
}

/**
 * Decide the alias/rooms a session starts with.
 *
 * Alias precedence: explicit config (config.json alias / MESH_ALIAS, a pin)
 * → the persisted PREFERRED alias (self-heals a conflict fallback) → the
 * persisted alias → undefined (random). Rooms: an explicitly PINNED room
 * list (config.json "roomsPinned" / MESH_ROOMS, a launcher pin) → the
 * persisted rooms (live membership must survive reloads) → config rooms.
 *
 * Pure + exported so the Pi adapter and the tests agree on the contract.
 */
export function chooseInitialIdentity(
  config: { alias?: string; rooms: readonly string[]; roomsPinned?: boolean },
  persisted: PersistedIdentity | null,
): IdentityChoice {
  const pinnedAlias = config.alias !== undefined && config.alias !== "" ? config.alias : undefined;
  const preferredAlias = pinnedAlias ?? persisted?.preferredAlias ?? persisted?.alias;
  const reason: IdentityChoiceReason =
    pinnedAlias !== undefined
      ? "config-alias"
      : persisted === null
        ? "fresh"
        : persisted.preferredAlias !== undefined
          ? "preferred"
          : "persisted";
  const configured = config.rooms.filter((r) => typeof r === "string" && r.trim() !== "");
  let rooms: string[];
  if (config.roomsPinned === true && configured.length > 0) {
    rooms = configured; // explicit launcher/config pin wins over stale disk state
  } else if (persisted !== null && persisted.rooms.length > 0) {
    rooms = [...persisted.rooms];
  } else {
    rooms = configured.length > 0 ? configured : ["default"];
  }
  return { alias: preferredAlias, preferredAlias, rooms, reason };
}

/**
 * Persist a runtime's identity — THE single write path for the adapters.
 *
 * Every save MUST carry preferredAlias and, when configured, the slot key:
 * scattered `identity.save(identityFromClient(...))` calls were the exact
 * place where the chosen alias got dropped (reserve/release/auto-release
 * wiped it silently, so a later conflict re-randomized the name).
 */
export function saveIdentityOf(
  store: MeshIdentity,
  owner: {
    sessionId: string;
    client: { alias: string; rooms: readonly string[]; reservations: readonly FileReservation[] };
    preferredAlias?: string;
    identityKey?: string;
  },
): void {
  try {
    store.save(identityFromClient(owner.sessionId, owner.client, owner.preferredAlias), owner.identityKey);
  } catch {
  // best effort — identity persistence never breaks a session
  }
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

  /** Identity file for a session — or for a NAMED agent slot when `key` is set
   *  (identity-key-<key>.json: one slot, many sessions/restarts). */
  private pathFor(sessionId: string, key?: string): string {
    if (key !== undefined && key !== "") {
      if (!IDENTITY_KEY_REGEX.test(key)) throw new Error("invalid_identity_key");
      return path.join(this.stateDir, `${IDENTITY_KEY_PREFIX}${key}.json`);
    }
    return path.join(this.stateDir, `${IDENTITY_PREFIX}${sessionId}.json`);
  }

  /** Path a session's identity lives at (diagnostics: /mesh broker). */
  fileFor(sessionId: string, key?: string): string {
    try {
      return this.pathFor(sessionId, key);
    } catch {
      return this.pathFor(sessionId);
    }
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
      // The preferred alias is OPTIONAL (older identities predate it) —
      // preserve it on load: it is what makes a conflicted identity
      // self-heal at the next attach.
      const preferredAlias =
        typeof id.preferredAlias === "string" && id.preferredAlias !== ""
          ? id.preferredAlias
          : undefined;
      return {
        version: IDENTITY_VERSION,
        sessionId,
        alias: id.alias,
        ...(preferredAlias !== undefined ? { preferredAlias } : {}),
        rooms,
        reservations,
        updatedAt: typeof id.updatedAt === "string" ? id.updatedAt : nowIso(),
      };
    } catch {
      return null;
    }
  }

  /**
  * Load the identity belonging to `sessionId` (or to the named slot `key`).
  * Returns null when absent, from another session, malformed, or on an older
  * version — callers then start fresh (random alias, default rooms).
  */
  load(sessionId: string, key?: string): PersistedIdentity | null {
    if (key !== undefined && key !== "") {
      // A slot is shared by several sessions/restarts: the stored sessionId is
      // the LAST writer, never this session — accept it and rebind below.
      let raw: string;
      try {
        raw = readFileSync(this.pathFor(sessionId, key), "utf8");
      } catch {
        return null;
      }
      return this.parse(raw, sessionId, true);
    }
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
  * factory-reset this session's identity (or the named slot's) — /mesh reset
  * behaves like /new (fresh alias, default rooms, no reservations) while
  * staying in the same pi session. Best effort — never throws.
  */
  reset(sessionId: string, key?: string): void {
    if (key !== undefined && key !== "") {
      try {
        unlinkSync(this.pathFor(sessionId, key));
      } catch {
  // already gone
      }
      return;
    }
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
  * Stage the current identity for the NEXT session (created by /mesh new or
  * a pi fork): alias + rooms + reservations (and optionally a compact
  * history) travel through identity-pending.json and are consumed by the
  * next session_start.
  *
  * `forParent` (a session FILE path) BINDS the handoff to the intended
  * child: every session shares the same stateDir, so an unbound file was
  * consumable by ANY new session in the directory — another agent could
  * steal the alias AND the room list (identity-pending was the last global
  * mutable slot in an otherwise per-session store).
  */
  savePending(
    identity: PersistedIdentity,
    history?: string[],
    opts: { forParent?: string } = {},
  ): void {
    try {
      mkdirSync(this.stateDir, { recursive: true });
      const forParent = opts.forParent !== undefined && opts.forParent !== "" ? opts.forParent : undefined;
      const payload = { ...identity, history, ...(forParent !== undefined ? { handoffFor: forParent } : {}) };
      const tmp = this.pendingPath + ".tmp";
      writeFileSync(tmp, JSON.stringify(payload, null, 2) + "\n", "utf8");
      renameSync(tmp, this.pendingPath);
    } catch {
  // best effort
    }
  }

  /** Drop a staged handoff (the direct-write path already delivered it). */
  clearPending(): void {
    try {
      unlinkSync(this.pendingPath);
    } catch {
  // already gone
    }
  }

  /**
  * Take the staged identity (if fresh enough) and clear the file.
  * Returns { identity, history } or null. The history is the compact
  * transferred conversation (--history flag).
  *
  * `opts.parentFile` is the new session's header.parentSession: when the
  * handoff was bound with savePending({forParent}), a DIFFERENT session
  * (or a session with no parent, i.e. a brand-new conversation) leaves the
  * file staged and gets null. Unbound (legacy) handoffs keep the old
  * single-consumer behavior.
  */
  consumePending(opts: { parentFile?: string; now?: number } = {}): { identity: PersistedIdentity; history?: string[] } | null {
    const now = opts.now ?? Date.now();
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
      // Bound handoff: only the intended child may take it. A mismatch
      // (another agent's new session) leaves the file staged for the real
      // child — the difference between an isolated handoff and a race.
      const forParent = typeof p.handoffFor === "string" && p.handoffFor !== "" ? p.handoffFor : undefined;
      if (forParent !== undefined) {
        const consumer = opts.parentFile;
        if (consumer === undefined || consumer !== forParent) return null;
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
  save(identity: PersistedIdentity, key?: string): void {
    try {
      mkdirSync(this.stateDir, { recursive: true });
      const target = this.pathFor(identity.sessionId, key);
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
      if (name.startsWith(IDENTITY_KEY_PREFIX)) continue; // named slots: not session-adoptable
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
