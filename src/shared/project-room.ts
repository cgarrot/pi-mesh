// Project-scoped room derivation (roomMode).
//
// A mesh on a shared broker puts every project on the machine into one room,
// so an untargeted broadcast crosses unrelated projects (issue #20). The fix
// is a room derived from the project's identity, so agents working in the
// same directory share it and nobody else does.
//
// The identity source is the STATE DIR — `$MESH_STATE_DIR` or `<cwd>/.mesh`
// (see paths.ts). That is already the project's identity for the identity
// store, the ledger and the policy, so this invents no second concept.
//
// Constraints this file must respect (verified, not assumed):
//   - ROOM_REGEX is /^[a-z0-9][a-z0-9.-]{0,63}$/ — NO colon, so `proj:<x>`
//     is rejected by the broker with `invalid_room`. Hence dots.
//   - Pure and dependency-free: no subprocess (a `git remote` lookup would be
//     execution, which the vision forbids), no fs, no env read at call time.
//   - Deterministic: the same state dir always yields the same room, or two
//     sessions of the same project silently stop seeing each other.
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname } from "node:path";

import { DEFAULT_MAX_ROOMS_PER_PEER, DEFAULT_ROOM, type RoomMode } from "./config.js";

/** Reserved namespace so a derived room is recognisable in mesh_status. */
export const PROJECT_ROOM_PREFIX = "proj.";

/** How much of the basename survives slugification. */
export const PROJECT_ROOM_SLUG_MAX = 24;

/** Hex characters of the path digest kept for collision resistance. */
export const PROJECT_ROOM_HASH_CHARS = 6;

/**
 * Lowercase, collapse anything outside [a-z0-9] to a single dash, trim
 * leading/trailing dashes, bound the length. Falls back to "x" because a room
 * name must start with [a-z0-9].
 */
export function slugifyProjectName(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, PROJECT_ROOM_SLUG_MAX)
    .replace(/-+$/, "");
  return slug === "" ? "x" : slug;
}

/**
 * The project directory a state dir belongs to: `<project>/.mesh` → the
 * project, anything else (a custom `$MESH_STATE_DIR`) → the dir itself.
 */
export function projectRootOf(stateDir: string): string {
  const trimmed = stateDir.replace(/[\\/]+$/, "");
  return basename(trimmed) === ".mesh" ? dirname(trimmed) : trimmed;
}

/**
 * Canonicalise the state dir before hashing it.
 *
 * Without this, two sessions of the SAME project reached through different
 * spellings (`/var/...` vs `/private/var/...` on macOS, a symlinked $PWD, a
 * trailing slash) derive DIFFERENT rooms and stop seeing each other — silently,
 * which is the worst failure mode for this feature. `stateDir()` does no
 * canonicalisation of its own.
 *
 * Falls back to the raw string when the path does not exist (pure tests,
 * not-yet-created dirs): determinism matters more than canonicality, and a
 * nonexistent path cannot be spelled two ways in practice.
 */
export function canonicalStateDir(stateDir: string): string {
  try {
    return realpathSync(stateDir);
  } catch {
    return stateDir.replace(/[\\/]+$/, "") || stateDir;
  }
}

/**
 * `proj.<slug>.<hex6>` — readable in mesh_status, collision-resistant across
 * different projects sharing a basename, and always ROOM_REGEX-valid.
 *
 * The digest is taken over the state dir (the project's identity), not the
 * cwd, so starting a session from a subdirectory keeps the same room.
 */
export function deriveProjectRoom(stateDir: string): string {
  const root = projectRootOf(canonicalStateDir(stateDir));
  const digest = createHash("sha256").update(root).digest("hex").slice(0, PROJECT_ROOM_HASH_CHARS);
  return `${PROJECT_ROOM_PREFIX}${slugifyProjectName(basename(root) || root)}.${digest}`;
}

/** True when `room` is a derived project room (used to keep it out of the persisted identity). */
export function isProjectRoom(room: string, roomName?: string): boolean {
  if (roomName !== undefined) return room === roomName;
  return room.startsWith(PROJECT_ROOM_PREFIX);
}

/** Matches only a room produced by `deriveProjectRoom` — used to recognise a
 *  STALE derived room (project moved/renamed) without ever touching a room a
 *  user named by hand. */
const DERIVED_PROJECT_ROOM_REGEX = /^proj\..+\.[0-9a-f]{6}$/;

export function isDerivedProjectRoomName(room: string): boolean {
  return DERIVED_PROJECT_ROOM_REGEX.test(room);
}

/**
 * True only for a room this project derived at an EARLIER path/name — the
 * ghost a move leaves behind. Deliberately scoped to our own slug so a room
 * somebody typed by hand (`proj.other.ab12cd`, or another project's derived
 * name they joined on purpose) is never dropped.
 */
export function isStaleOwnProjectRoom(room: string, projectRoom: string): boolean {
  if (room === projectRoom) return false;
  const slug = projectRoom.slice(PROJECT_ROOM_PREFIX.length, projectRoom.lastIndexOf("."));
  return room.startsWith(`${PROJECT_ROOM_PREFIX}${slug}.`);
}

export interface RoomScope {
  /** Rooms to join, in order. */
  rooms: string[];
  /** The derived project room, or undefined when `roomMode` is "default". */
  projectRoom?: string;
  /** Where an untargeted broadcast goes. */
  broadcastRoom: string;
  /** Why roomMode could not fully apply — surfaced, never a silent no-op. */
  degraded?: "room_cap" | "pinned";
}

/**
 * Compose the effective room set for a session.
 *
 * Invariants this must not violate:
 *  - `roomMode: "default"` is byte-for-byte today's behaviour.
 *  - a derived room never REPLACES membership in "both" mode, because the
 *    broker refuses a directed message unless sender and target share a room.
 *  - a stale derived room from a previous path/config is dropped, so moving a
 *    project does not leave a ghost room behind.
 *  - an explicit `rooms` entry in config always survives (`default` included).
 */
export function resolveRoomScope(args: {
  roomMode: RoomMode | undefined;
  rooms: readonly string[];
  stateDir: string;
  projectRoomName?: string;
  configuredRooms?: readonly string[];
  maxRoomsPerPeer?: number;
  /** The incoming list came from disk and was non-empty — an explicit
   *  `/mesh leave default` must survive a restart. Without this, "both"
   *  resurrects `default` on every start and silently undoes the leave. */
  persistedRooms?: boolean;
  /** config.json "roomsPinned" / $MESH_ROOMS: an explicit pin is a launcher
   *  placing the agent in a room FOR GOOD. It wins over everything, including
   *  roomMode — adding a derived room on top of a pin would break the
   *  documented contract ("the pinned list wins") and the test that encodes
   *  it. A pinned agent therefore behaves exactly as before. */
  pinned?: boolean;
}): RoomScope {
  const mode = args.roomMode ?? "both";
  const base = args.rooms.filter((room) => typeof room === "string" && room.trim() !== "");

  // Legacy rule, also used when roomMode cannot apply: default if joined,
  // else the first joined room. Never a project room.
  const legacyBroadcastRoom = (list: readonly string[]): string =>
    list.includes(DEFAULT_ROOM) ? DEFAULT_ROOM : (list[0] ?? DEFAULT_ROOM);

  if (mode === "default" || args.pinned === true) {
    const rooms = base.length > 0 ? base : [DEFAULT_ROOM];
    return {
      rooms,
      broadcastRoom: legacyBroadcastRoom(rooms),
      // A pin disables roomMode by design; say so instead of a silent no-op.
      ...(args.pinned === true && mode !== "default" ? { degraded: "pinned" as const } : {}),
    };
  }

  const projectRoom = args.projectRoomName ?? deriveProjectRoom(args.stateDir);
  // Drop the ghost OUR project left at an earlier path — never a room the
  // user joined by hand (another project's derived name, or a custom one).
  const cleaned = base.filter((room) => !isStaleOwnProjectRoom(room, projectRoom));
  const rooms: string[] = [...cleaned];

  const configured = args.configuredRooms ?? [];
  const defaultIsConfigured = configured.includes(DEFAULT_ROOM);
  // An explicit leave outranks the "both" membership guarantee.
  const leftDefault = args.persistedRooms === true && !base.includes(DEFAULT_ROOM);

  if (mode === "both") {
    if (!rooms.includes(DEFAULT_ROOM) && !leftDefault) rooms.push(DEFAULT_ROOM);
  } else if (!defaultIsConfigured) {
    // "project": strict isolation — default only survives if the user asked
    // for it explicitly in config.json rooms.
    const at = rooms.indexOf(DEFAULT_ROOM);
    if (at >= 0) rooms.splice(at, 1);
  }

  if (!rooms.includes(projectRoom)) rooms.push(projectRoom);

  const cap = args.maxRoomsPerPeer ?? DEFAULT_MAX_ROOMS_PER_PEER;
  if (rooms.length > cap) {
    // Shed in reverse priority: the derived room is a convenience, `default`
    // is the cross-project link, user-configured rooms are explicit intent.
    // The returned list must NEVER exceed the broker's cap — an oversized
    // hello would make a join fail and silently drop rooms.
    const trimmed = rooms.filter((room) => room !== projectRoom);
    while (trimmed.length > cap && trimmed.includes(DEFAULT_ROOM)) {
      trimmed.splice(trimmed.indexOf(DEFAULT_ROOM), 1);
    }
    return {
      rooms: trimmed.slice(0, Math.max(1, cap)),
      broadcastRoom: legacyBroadcastRoom(trimmed),
      degraded: "room_cap",
    };
  }

  return { rooms, projectRoom, broadcastRoom: projectRoom };
}

/**
 * Remove the derived room a PREVIOUS start recorded from the persisted list.
 *
 * Matching on the recorded NAME (not a `proj.*` pattern) is what makes this
 * safe: a hand-typed room and another project's derived room both survive,
 * while the ghost of a moved or renamed project is dropped exactly.
 */
export function dropRecordedProjectRoom(
  rooms: readonly string[],
  recordedProjectRoom: string | undefined,
): string[] {
  if (recordedProjectRoom === undefined) return [...rooms];
  return rooms.filter((room) => room !== recordedProjectRoom);
}
