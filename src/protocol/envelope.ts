// protocol/envelope.ts — MeshFrame type, closed sets, build/validate/parse.
// No Pi imports. Validation rules applied by BOTH broker and client.
import {
  ALIAS_REGEX,
  MAX_BODY_BYTES,
  MAX_FRAME_ID_CHARS,
  MAX_REFS,
  MAX_REF_CHARS,
  MAX_REPLY_TARGETS,
  ROOM_REGEX,
  SHA256_HEX_REGEX,
} from "../shared/config.js";
import { makeMsgId, nowIso, sha256 } from "./frames.js";

export type MeshPriority = "normal" | "urgent" | "force";
export type MeshRole = "member" | "observer";

export interface FileReservation {
  pattern: string;
  reason?: string;
  since?: string;
}

export interface MeshPeerInfo {
  alias: string;
  rooms: string[];
  role?: MeshRole;
  since?: string;
  /** last broker-seen activity (heartbeat/tool frames) — status calc. */
  lastSeenAt?: string;
  reservations?: FileReservation[];
  /** M1: extension version (from the hello frame). */
  clientVersion?: string;
  /** Announced turn state (busy/idle/rate_limited). */
  activity?: { state: "busy" | "idle" | "rate_limited" | "blocked"; at: string };
  /** D40: how this peer reaches the broker — "tcp:<ip>"/"tls:<ip>" for
  *  remote machines, undefined for broker-local (unix socket) peers. */
  via?: string;
}



export interface MeshFrame {
  v: 1;
  type: string;
  id: string;
  from?: string;
  to?: string;
  room?: string;
  replyTo?: string;
  /** msg: aliases the sender designates to receive the reply (default: the
  *  sender). reply: fan-out targets chosen by the replier. */
  replyTargets?: string[];
  priority?: MeshPriority;
  body?: string; // TRANSIENT — never persisted 
  bodyHash?: string;
  refs?: string[];
  reasonHash?: string; // force only
  expiresAt?: string;
  code?: string;
  status?: string;
  peers?: MeshPeerInfo[];
  rooms?: string[];
  role?: MeshRole;
  mailboxCount?: number;
  queuedAt?: string; // mailbox frames 
  interruptStatus?: string; // ack for force 
  reservations?: FileReservation[]; // hello/welcome/reserve/status_res 
  broadcast?: boolean; // msg: fan-out to every room member 
  replyAll?: boolean; // reply: fan-out the answer to the whole room 
  deliveredCount?: number; // ack: broadcast/replyAll deliveries 
  totalCount?: number; // ack: broadcast/replyAll targets 
  /** msgId the sender is acknowledging as READ (read receipt). */
  reads?: string;
  /** shared auth token hash (hello only) — required on tcp/tls brokers. */
  token?: string;
  /** msg: sender demands the recipient's running tool be interrupted
  *  (abort the stuck turn) so the message lands with priority. Requires
  *  priority=force + reason at SEND time (reason travels hashed only). */
  interrupt?: boolean;
  /** reply: machine receipt (e.g. interrupt outcome) — rendered INFO ONLY,
  *  followUp without triggerTurn: it must never wake or cascade. */
  receipt?: boolean;
  /** M1: extension version of the sender (hello) — shown in status snapshots
  *  so stale sessions are visible at a glance. */
  clientVersion?: string;
  /** M2: broker counters (status_res). */
  stats?: { relayed: number; refused: number; mailboxDelivered: number; mailboxDropped: number };
  ts: string;
}

// ---- Closed sets ----
export const FRAME_TYPES = [
  "hello",
  "welcome",
  "msg",
  "ack",
  "reply",
  "remind",
  "presence",
  "mailbox",
  "status_req",
  "status_res",
  "join",
  "leave",
  "reserve",
  "read",
  "ping",
  "pong",
  "activity",
  "error",
] as const;
export type MeshFrameType = (typeof FRAME_TYPES)[number];

export const ERROR_CODES = [
  "invalid_frame",
  "oversized",
  "hello_required",
  "invalid_alias",
  "alias_taken",
  "invalid_room",
  "invalid_token",
  "not_member",
  "observer_readonly",
  "last_room",
  "peer_not_found",
  "rate_limited",
  "policy_denied",
  "force_requires_reason",
  "hash_mismatch",
  "reply_without_target",
  "timeout",
  "expired",
  "shutting_down",
  "internal",
] as const;
export type MeshErrorCode = (typeof ERROR_CODES)[number];

export const PRIORITIES = ["normal", "urgent", "force"] as const;
export const ROLES = ["member", "observer"] as const;
export const ACK_STATUSES = ["delivered", "queued_offline", "dropped_offline", "ok"] as const;

// ---- Ledger safety, rule 8) ----
export const FORBIDDEN_PERSISTED_KEYS = [
  "body",
  "task",
  "prompt",
  "output",
  "content",
  "message",
  "rationale",
  "text",
  "diff",
  "patch",
] as const;

/** Recursive scan: true if any object key is forbidden (fail-closed before ledger append). */
export function hasForbiddenPersistedKey(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasForbiddenPersistedKey);
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if ((FORBIDDEN_PERSISTED_KEYS as readonly string[]).includes(k)) return true;
    if (hasForbiddenPersistedKey(v)) return true;
  }
  return false;
}

// ---- Alias / room / refs ----
/** trim + strip leading '@' + lowercase. No -/_ equivalence. */
export function normalizeAlias(raw: string): string {
  let s = raw.trim();
  while (s.startsWith("@")) s = s.slice(1);
  return s.toLowerCase();
}

export function isValidAlias(alias: string): boolean {
  return ALIAS_REGEX.test(alias);
}

export function isValidRoom(room: string): boolean {
  return ROOM_REGEX.test(room);
}

// ---- Reservations ----
export const MAX_RESERVATION_PATTERN_CHARS = 512;
export const MAX_RESERVATION_REASON_CHARS = 512;

export function isValidReservationPattern(pattern: string): boolean {
  return pattern.length > 0 && pattern.length <= MAX_RESERVATION_PATTERN_CHARS && !pattern.includes("\0");
}

/** Shape-check a reservations array; returns false on any malformed entry. */
export function isValidReservations(value: unknown): value is FileReservation[] {
  if (!Array.isArray(value)) return false;
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return false;
    const r = item as Record<string, unknown>;
    if (typeof r.pattern !== "string" || !isValidReservationPattern(r.pattern)) return false;
    if (r.reason !== undefined && (typeof r.reason !== "string" || r.reason.length > MAX_RESERVATION_REASON_CHARS)) {
      return false;
    }
    if (r.since !== undefined && (typeof r.since !== "string" || Number.isNaN(Date.parse(r.since)))) return false;
  }
  return true;
}

/** Repo-relative refs only: reject "..", leading "/", "\", ".env". */
export function isValidRefPath(ref: string): boolean {
  if (ref.length === 0 || ref.length > MAX_REF_CHARS) return false;
  if (ref.startsWith("/") || ref.startsWith("~")) return false;
  if (ref.includes("\\")) return false;
  if (ref.split("/").some((seg) => seg === "..")) return false;
  if (ref === ".env" || ref.startsWith(".env.") || ref.endsWith("/.env")) return false;
  if (ref.includes(".env/") || ref.includes("/.env/")) return false;
  return true;
}

// ---- Build ----
export interface BuildFrameOpts {
  type: MeshFrameType;
  id?: string;
  from?: string;
  to?: string;
  room?: string;
  replyTo?: string;
  replyTargets?: string[];
  priority?: MeshPriority;
  body?: string;
  refs?: string[];
  reasonHash?: string;
  expiresAt?: string;
  code?: MeshErrorCode;
  status?: string;
  peers?: MeshPeerInfo[];
  rooms?: string[];
  role?: MeshRole;
  mailboxCount?: number;
  queuedAt?: string;
  interruptStatus?: string;
  reservations?: FileReservation[];
  broadcast?: boolean;
  replyAll?: boolean;
  deliveredCount?: number;
  totalCount?: number;
  reads?: string;
  token?: string;
  interrupt?: boolean;
  receipt?: boolean;
  /** M1: extension version (hello). */
  clientVersion?: string;
  /** M2: broker counters (status_res). */
  stats?: { relayed: number; refused: number; mailboxDelivered: number; mailboxDropped: number };
}

/** Build a protocol-valid frame; bodyHash auto-computed when body present. */
export function buildFrame(opts: BuildFrameOpts): MeshFrame {
  const frame: MeshFrame = {
    v: 1,
    type: opts.type,
    id: opts.id ?? makeMsgId(),
    ts: nowIso(),
  };
  if (opts.from !== undefined) frame.from = opts.from;
  if (opts.to !== undefined) frame.to = opts.to;
  if (opts.room !== undefined) frame.room = opts.room;
  if (opts.replyTo !== undefined) frame.replyTo = opts.replyTo;
  if (opts.replyTargets !== undefined) frame.replyTargets = [...opts.replyTargets];
  if (opts.priority !== undefined) frame.priority = opts.priority;
  if (opts.body !== undefined) {
    frame.body = opts.body;
    frame.bodyHash = sha256(opts.body);
  }
  if (opts.refs !== undefined) frame.refs = [...opts.refs];
  if (opts.reasonHash !== undefined) frame.reasonHash = opts.reasonHash;
  if (opts.expiresAt !== undefined) frame.expiresAt = opts.expiresAt;
  if (opts.code !== undefined) frame.code = opts.code;
  if (opts.status !== undefined) frame.status = opts.status;
  if (opts.peers !== undefined) frame.peers = opts.peers;
  if (opts.rooms !== undefined) frame.rooms = opts.rooms;
  if (opts.role !== undefined) frame.role = opts.role;
  if (opts.mailboxCount !== undefined) frame.mailboxCount = opts.mailboxCount;
  if (opts.queuedAt !== undefined) frame.queuedAt = opts.queuedAt;
  if (opts.interruptStatus !== undefined) frame.interruptStatus = opts.interruptStatus;
  if (opts.reservations !== undefined) frame.reservations = [...opts.reservations];
  if (opts.broadcast !== undefined) frame.broadcast = opts.broadcast;
  if (opts.replyAll !== undefined) frame.replyAll = opts.replyAll;
  if (opts.deliveredCount !== undefined) frame.deliveredCount = opts.deliveredCount;
  if (opts.totalCount !== undefined) frame.totalCount = opts.totalCount;
  if (opts.reads !== undefined) frame.reads = opts.reads;
  if (opts.token !== undefined) frame.token = opts.token;
  if (opts.interrupt !== undefined) frame.interrupt = opts.interrupt;
  if (opts.receipt !== undefined) frame.receipt = opts.receipt;
  if (opts.clientVersion !== undefined) frame.clientVersion = opts.clientVersion;
  if (opts.stats !== undefined) frame.stats = { ...opts.stats };
  return frame;
}

// ---- Validate ----
export type ValidationResult =
  | { ok: true; frame: MeshFrame }
  | { ok: false; code: MeshErrorCode; detail: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** strict ISO-8601 shape — Date.parse alone accepts '2024', 'March 5 2024'. */
const ISO_8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

function isValidIso(s: unknown): s is string {
  return typeof s === "string" && ISO_8601_REGEX.test(s) && !Number.isNaN(Date.parse(s));
}

export interface ValidateOpts {
  maxBodyBytes?: number;
}

/** Validate an arbitrary value against rules. Unknown keys tolerated. */
export function validateFrame(value: unknown, opts: ValidateOpts = {}): ValidationResult {
  const maxBody = opts.maxBodyBytes ?? MAX_BODY_BYTES;
  if (!isRecord(value)) return { ok: false, code: "invalid_frame", detail: "not an object" };

  // Rule 1: v/type/id/ts
  if (value.v !== 1) return { ok: false, code: "invalid_frame", detail: "v !== 1" };
  if (typeof value.type !== "string" || !(FRAME_TYPES as readonly string[]).includes(value.type)) {
    return { ok: false, code: "invalid_frame", detail: "unknown type" };
  }
  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.id.length > MAX_FRAME_ID_CHARS
  ) {
    return { ok: false, code: "invalid_frame", detail: "bad id" };
  }
  if (!isValidIso(value.ts)) return { ok: false, code: "invalid_frame", detail: "bad ts" };

  // Rule 2: aliases
  for (const key of ["from", "to"] as const) {
    const alias = value[key];
    if (alias !== undefined && (typeof alias !== "string" || !isValidAlias(alias))) {
      return { ok: false, code: "invalid_alias", detail: `bad ${key}` };
    }
  }

  // Rule 3: room
  if (value.room !== undefined && (typeof value.room !== "string" || !isValidRoom(value.room))) {
    return { ok: false, code: "invalid_room", detail: "bad room" };
  }

  // Rule 4: body size + hash
  if (value.body !== undefined) {
    if (typeof value.body !== "string") {
      return { ok: false, code: "invalid_frame", detail: "body not string" };
    }
    if (Buffer.byteLength(value.body, "utf8") > maxBody) {
      return { ok: false, code: "invalid_frame", detail: "body too large" };
    }
    if (value.bodyHash !== undefined) {
      if (typeof value.bodyHash !== "string" || !SHA256_HEX_REGEX.test(value.bodyHash)) {
        return { ok: false, code: "invalid_frame", detail: "bad bodyHash" };
      }
      if (sha256(value.body) !== value.bodyHash) {
        return { ok: false, code: "hash_mismatch", detail: "bodyHash mismatch" };
      }
    }
  } else if (value.bodyHash !== undefined) {
    return { ok: false, code: "invalid_frame", detail: "bodyHash without body" };
  }

  // priority / role enums
  if (
    value.priority !== undefined &&
    !(PRIORITIES as readonly string[]).includes(value.priority as string)
  ) {
    return { ok: false, code: "invalid_frame", detail: "bad priority" };
  }
  if (value.role !== undefined && !(ROLES as readonly string[]).includes(value.role as string)) {
    return { ok: false, code: "invalid_frame", detail: "bad role" };
  }

  // Rule 5: force ⇒ reasonHash
  if (value.priority === "force") {
    if (typeof value.reasonHash !== "string" || !SHA256_HEX_REGEX.test(value.reasonHash)) {
      return { ok: false, code: "force_requires_reason", detail: "force without reasonHash" };
    }
  }

  // interrupt is a force MODIFIER, never a standalone escalation: an
  // interrupt frame without force would bypass the force policy/reason
  // guarantees (downgraded frames are stripped by the broker anyway).
  if (value.interrupt === true && value.priority !== "force") {
    return { ok: false, code: "invalid_frame", detail: "interrupt requires priority=force" };
  } else if (value.reasonHash !== undefined) {
    if (typeof value.reasonHash !== "string" || !SHA256_HEX_REGEX.test(value.reasonHash)) {
      return { ok: false, code: "invalid_frame", detail: "bad reasonHash" };
    }
  }

  // Rule 6: reply/remind ⇒ replyTo
  if (value.type === "reply" || value.type === "remind") {
    if (typeof value.replyTo !== "string" || value.replyTo.length === 0) {
      return { ok: false, code: "reply_without_target", detail: "missing replyTo" };
    }
  }
  if (value.replyTo !== undefined && typeof value.replyTo !== "string") {
    return { ok: false, code: "invalid_frame", detail: "bad replyTo" };
  }

  // Rule 6b: replyTargets — bounded alias list on msg/reply frames
  if (value.replyTargets !== undefined) {
    if (!Array.isArray(value.replyTargets) || value.replyTargets.length === 0 || value.replyTargets.length > MAX_REPLY_TARGETS) {
      return { ok: false, code: "invalid_frame", detail: "bad replyTargets" };
    }
    for (const t of value.replyTargets) {
      if (typeof t !== "string" || !isValidAlias(t)) {
        return { ok: false, code: "invalid_frame", detail: "bad replyTarget" };
      }
    }
    if (value.type !== "msg" && value.type !== "reply") {
      return { ok: false, code: "invalid_frame", detail: "replyTargets on non-msg/reply" };
    }
    if (value.type === "reply" && value.to !== undefined) {
      return { ok: false, code: "invalid_frame", detail: "replyTargets with to" };
    }
  }

  // Rule 7: refs
  if (value.refs !== undefined) {
    if (!Array.isArray(value.refs) || value.refs.length > MAX_REFS) {
      return { ok: false, code: "invalid_frame", detail: "bad refs" };
    }
    for (const ref of value.refs) {
      if (typeof ref !== "string" || !isValidRefPath(ref)) {
        return { ok: false, code: "invalid_frame", detail: "bad ref path" };
      }
    }
  }

  // Rule 8: reservations (hello/welcome/reserve/status_res) — shape-checked
  if (value.reservations !== undefined && !isValidReservations(value.reservations)) {
    return { ok: false, code: "invalid_frame", detail: "bad reservations" };
  }

  // Rule 9b: auth token — hello only, bounded
  if (value.token !== undefined) {
    if (value.type !== "hello") {
      return { ok: false, code: "invalid_frame", detail: "token on non-hello" };
    }
    if (typeof value.token !== "string" || value.token.length === 0 || value.token.length > 128) {
      return { ok: false, code: "invalid_frame", detail: "bad token" };
    }
  }

  // M1: clientVersion — bounded string (hello carries it)
  if (value.clientVersion !== undefined) {
    if (typeof value.clientVersion !== "string" || value.clientVersion.length === 0 || value.clientVersion.length > 64) {
      return { ok: false, code: "invalid_frame", detail: "bad clientVersion" };
    }
  }

  // Rule 9: broadcast / replyAll fan-out
  if (value.broadcast !== undefined) {
    if (typeof value.broadcast !== "boolean") {
      return { ok: false, code: "invalid_frame", detail: "bad broadcast" };
    }
    if (value.broadcast === true) {
      if (value.to !== undefined) {
        return { ok: false, code: "invalid_frame", detail: "broadcast with to" };
      }
      if (typeof value.room !== "string") {
        return { ok: false, code: "invalid_room", detail: "broadcast without room" };
      }
    }
  }
  if (value.replyAll !== undefined) {
    if (typeof value.replyAll !== "boolean") {
      return { ok: false, code: "invalid_frame", detail: "bad replyAll" };
    }
    if (value.replyAll === true) {
      if (value.to !== undefined) {
        return { ok: false, code: "invalid_frame", detail: "replyAll with to" };
      }
      if (value.type !== "reply") {
        return { ok: false, code: "invalid_frame", detail: "replyAll on non-reply" };
      }
    }
  }
  // read receipts — only on "read" frames, with a target msgId
  if (value.type === "read") {
    if (typeof value.reads !== "string" || value.reads.length === 0 || value.reads.length > MAX_FRAME_ID_CHARS) {
      return { ok: false, code: "invalid_frame", detail: "bad reads" };
    }
    if (typeof value.to !== "string") {
      return { ok: false, code: "invalid_frame", detail: "read without to" };
    }
  }
  for (const key of ["deliveredCount", "totalCount"] as const) {
    const n = value[key];
    if (n !== undefined && (typeof n !== "number" || !Number.isInteger(n) || n < 0)) {
      return { ok: false, code: "invalid_frame", detail: `bad ${key}` };
    }
  }

  // activity announcements — busy/idle/rate_limited/blocked with a valid from
  if (value.type === "activity") {
    if (value.status !== "busy" && value.status !== "idle" && value.status !== "rate_limited" && value.status !== "blocked") {
      return { ok: false, code: "invalid_frame", detail: "bad activity status" };
    }
    if (typeof value.from !== "string") {
      return { ok: false, code: "invalid_alias", detail: "activity without from" };
    }
  }

  // ack statuses — closed set when present. "dropped_offline" also rides
  // ASYNCHRONOUS drop notices from the mailbox (TTL expiry / cap eviction):
  // an unsolicited ack with no pending send is legal by design.
  if (value.type === "ack" && value.status !== undefined) {
    if (
      typeof value.status !== "string" ||
      !(ACK_STATUSES as readonly string[]).includes(value.status)
    ) {
      return { ok: false, code: "invalid_frame", detail: "bad ack status" };
    }
  }

  // error frames: closed code set
  if (value.type === "error") {
    if (
      typeof value.code !== "string" ||
      !(ERROR_CODES as readonly string[]).includes(value.code)
    ) {
      return { ok: false, code: "invalid_frame", detail: "bad error code" };
    }
  }
  if (value.expiresAt !== undefined && !isValidIso(value.expiresAt)) {
    return { ok: false, code: "invalid_frame", detail: "bad expiresAt" };
  }

  return { ok: true, frame: value as unknown as MeshFrame };
}

/** Parse one NDJSON line into a validated frame. */
export function parseFrameLine(line: string, opts: ValidateOpts = {}): ValidationResult {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { ok: false, code: "invalid_frame", detail: "JSON parse error" };
  }
  return validateFrame(value, opts);
}
