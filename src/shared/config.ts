// shared/config.ts — ALL named numeric bounds + config.json/env loading.
// Every bound in the system is a named constant here or derived from MeshConfig.
import { readFileSync } from "node:fs";
import { configPath } from "./paths.js";

// ---- Framing) ----
export const DEFAULT_MAX_FRAME_BYTES = 65_536; // 64 KiB
export const HARD_MIN_FRAME_BYTES = 1_024;
export const HARD_MAX_FRAME_BYTES = 1_048_576; // 1 MiB
export const MAX_BODY_BYTES = 32_768; // 32 KiB 
export const MAX_FRAME_ID_CHARS = 64;
export const MAX_REFS = 8;
export const MAX_REF_CHARS = 256;
/** max aliases a sender can designate to receive the reply. */
export const MAX_REPLY_TARGETS = 8;

// ---- Timeouts ----
export const HELLO_TIMEOUT_MS = 5_000;
export const WRITE_TIMEOUT_MS = 5_000;
export const DEFAULT_HEARTBEAT_MS = 15_000; // client ping 
export const DEFAULT_BROKER_SILENCE_MS = 45_000; // broker cutoff 
export const SWEEP_INTERVAL_MS = 15_000; // broker silence sweep 
export const STATUS_REQ_TIMEOUT_MS = 5_000;
export const ACK_TIMEOUT_MS = 5_000;

// ---- Mailbox) ----
export const DEFAULT_MAILBOX_CAP = 100;
export const DEFAULT_MAILBOX_TTL_MS = 3_600_000; // 1 h
export const MAILBOX_PURGE_INTERVAL_MS = 60_000;

// ---- Rooms ----
export const DEFAULT_MAX_ROOMS_PER_PEER = 16;
export const MAX_PEERS_PER_ROOM = 64;
export const DEFAULT_ROOM = "default";

// ---- Rate limits ----
export const DEFAULT_RATE_MSG_PER_MIN = 30;
// 15/min: an orchestrator launching N agents sends one urgent each (steer) —
// 5/min (the old default) blocked a 8-agent mission blast (rate_limited
// urgent). The msg bucket (30) and the duplicate window still bound spam.
export const DEFAULT_RATE_URGENT_PER_MIN = 15;
export const DEFAULT_RATE_FORCE_PER_MIN = 1;
export const RATE_BUCKET_WINDOW_MS = 60_000;

// ---- Reconnect / outbox ----
export const RECONNECT_BASE_MS = 250;
export const RECONNECT_MAX_MS = 5_000;
export const OUTBOX_FLUSH_CAP = 50;

// ---- awaitReply ----
export const DEFAULT_AWAIT_REPLY_TIMEOUT_MS = 1_800_000; // 30 min — missions run long;
// a short default (was 10 min) made orchestration "expire" while agents were
// still working, which triggered re-sends and duplicate replies.
export const MIN_AWAIT_REPLY_TIMEOUT_MS = 25;
export const MAX_AWAIT_REPLY_TIMEOUT_MS = 1_800_000; // 30 min
export const MAX_REMINDS = 2;

// ---- ensureBroker ----
export const ENSURE_BROKER_POLL_MS = 50;
export const ENSURE_BROKER_MAX_POLLS = 60; // 3 s
export const LOCK_RETRY_MAX = 3;

// ---- Inbound batching ----
export const DEFAULT_INBOUND_BATCH_MS = 250;
/** One bounded retry when session injection throws (transient host state
 *  such as a turn teardown) before the failure is counted — the broker
 *  already acked `delivered`, so a silent drop is the worst outcome. */
export const INJECTION_RETRY_MS = 250;

// ---- Activity status ----
export const DEFAULT_ACTIVITY_IDLE_MS = 120_000; // 2 min without heartbeat/tools
export const DEFAULT_ACTIVITY_STUCK_MS = 900_000; // 15 min idle WITH reservations
/** Reservations expire after this long for CONFLICT CHECKS (peer side).
 *  6 h covers a long-but-legit run (measured: 3 h GPU render runs) with ×2
 *  margin, while stale claims left behind by a finished agent (measured:
 *  5 h+ held while idle) stop blocking peers. 0 = unlimited (opt-out). */
export const DEFAULT_RESERVATION_TTL_MS = 21_600_000; // 6 h

// ---- Context watchdog ----
/** notify when ONE turn grows the session file by this much (bytes). */
export const DEFAULT_WATCHDOG_SPIKE_BYTES = 2_097_152; // 2 MiB
/** notify when ONE assistant message carries more tool calls than this. */
export const DEFAULT_WATCHDOG_MAX_CALLS = 64;
/** a session-file drop of this size = compaction (context resync trigger). */
export const DEFAULT_WATCHDOG_COMPACTION_BYTES = 1_048_576; // 1 MiB

// ---- Inbound context verbosity ----
export type InboundBroadcastPolicy = "immediate" | "deferred";

export type ContextVerbosity = "compact" | "full";

// ---- Identity defaults ----
export const ALIAS_RAND_CHARS = 6;
export const MSG_ID_RAND_CHARS = 8;
export const ALIAS_REGEX = /^[a-z][a-z0-9-]{1,31}$/;
export const ROOM_REGEX = /^[a-z0-9][a-z0-9.-]{0,63}$/;
export const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/;

// ---- Transcript / ledger ----
export const TRANSCRIPT_RING_SIZE = 200;
export const DEFAULT_LEDGER_MAX_BYTES = 5_242_880; // 5 MiB
export const DEFAULT_TRANSCRIPT_RETENTION_DAYS = 7;

export type MeshEndpoint =
  | { kind: "unix"; path: string }
  | { kind: "tcp"; host: string; port: number }
  | { kind: "tls"; host: string; port: number };

/** Parse `tcp://host:port`, `tls://host:port`, `unix:///path`. */
export function parseEndpoint(url: string): MeshEndpoint | null {
  const m = /^(tcp|tls|unix):\/\/(.+)$/.exec(url.trim());
  if (m === null || m[1] === undefined || m[2] === undefined) return null;
  const scheme = m[1];
  const rest = m[2];
  if (scheme === "unix") return { kind: "unix", path: rest };
  const hm = /^(\[[0-9a-fA-F:]+\]|[^:]+):(\d{1,5})$/.exec(rest);
  if (hm === null || hm[1] === undefined || hm[2] === undefined) return null;
  const port = Number(hm[2]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { kind: scheme as "tcp" | "tls", host: hm[1].replace(/^\[|\]$/g, ""), port };
}

export interface MeshConfig {
  alias?: string;
  rooms: string[];
  maxFrameBytes: number;
  heartbeatMs: number;
  brokerSilenceMs: number;
  mailboxCap: number;
  mailboxTtlMs: number;
  maxRoomsPerPeer: number;
  transcript: boolean;
  transcriptRetentionDays: number;
  ledgerMaxBytes: number;
  /** idle after this long without activity (status display). */
  activityIdleMs: number;
  /** flagged stuck when idle this long AND holding reservations. */
  activityStuckMs: number;
  /** reservations expire after this long (0 = unlimited).
  *  Conflict checks (edit/write blocking) ignore expired peer claims. */
  reservationTtlMs: number;
  /** context watchdog: notify on abnormal one-turn growth / tool-call
  *  bursts (rejected duplicate calls after a degenerate generation). */
  watchdog?: boolean;
  watchdogSpikeBytes?: number;
  watchdogMaxCalls?: number;
  watchdogCompactionBytes?: number;
  /** "compact" (default): minimal inbound prefix + reply hints on first
  *  sight only. "full": legacy verbose format (rollback switch). */
  contextVerbosity?: ContextVerbosity;
  /** broker listen endpoint (broker side). Default: local socket. */
  listen?: string;
  /** broker endpoint the CLIENT connects to (remote or local). */
  brokerUrl?: string;
  /** shared auth token — REQUIRED for tcp/tls endpoints. */
  brokerToken?: string;
  /** TLS server cert/key (broker, for tls:// listen). */
  tlsCert?: string;
  tlsKey?: string;
  /** TLS CA (client, to verify a custom server cert). */
  tlsCa?: string;
  /** accept self-signed certs (INSECURE — LAN/dev only). */
  tlsInsecure?: boolean;
  /** group inbound messages and inject them as ONE batched message
  *  (ms). 0 disables batching. While the agent is busy (long tool call)
  *  frames are HELD; when the busy period ends they are injected as one
  *  batch. */
  inboundBatchMs?: number;
  /** Unaddressed room broadcasts: wake now (default) or wait for a prompt. */
  inboundBroadcasts?: InboundBroadcastPolicy;
  /** safety cap — flush even while busy after this long (ms). */
  inboundBatchMaxHoldMs?: number;
  /** client connection-lifecycle debug log (MESH_DEBUG=1) — wire-level
  *  events only, NEVER bodies (hash-only discipline). */
  debug?: boolean;
}

export const DEFAULT_CONFIG: MeshConfig = {
  rooms: [DEFAULT_ROOM],
  maxFrameBytes: DEFAULT_MAX_FRAME_BYTES,
  heartbeatMs: DEFAULT_HEARTBEAT_MS,
  brokerSilenceMs: DEFAULT_BROKER_SILENCE_MS,
  mailboxCap: DEFAULT_MAILBOX_CAP,
  mailboxTtlMs: DEFAULT_MAILBOX_TTL_MS,
  maxRoomsPerPeer: DEFAULT_MAX_ROOMS_PER_PEER,
  transcript: false,
  transcriptRetentionDays: DEFAULT_TRANSCRIPT_RETENTION_DAYS,
  ledgerMaxBytes: DEFAULT_LEDGER_MAX_BYTES,
  activityIdleMs: DEFAULT_ACTIVITY_IDLE_MS,
  activityStuckMs: DEFAULT_ACTIVITY_STUCK_MS,
  reservationTtlMs: DEFAULT_RESERVATION_TTL_MS,
  watchdog: true,
  watchdogSpikeBytes: DEFAULT_WATCHDOG_SPIKE_BYTES,
  watchdogMaxCalls: DEFAULT_WATCHDOG_MAX_CALLS,
  watchdogCompactionBytes: DEFAULT_WATCHDOG_COMPACTION_BYTES,
  contextVerbosity: "compact",
  inboundBroadcasts: "immediate",
  inboundBatchMs: DEFAULT_INBOUND_BATCH_MS,
  inboundBatchMaxHoldMs: 30_000,
};

function clampFrameBytes(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_MAX_FRAME_BYTES;
  return Math.min(HARD_MAX_FRAME_BYTES, Math.max(HARD_MIN_FRAME_BYTES, Math.floor(n)));
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function envInt(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/**
 * Load config: defaults < <stateDir>/config.json < env.
 * Env overrides: MESH_ALIAS, MESH_ROOMS (csv), MESH_MAX_FRAME_BYTES,
 * MESH_MAILBOX_CAP, MESH_MAILBOX_TTL_MS, MESH_TRANSCRIPT.
 */
export function loadConfig(stateDir?: string, env: NodeJS.ProcessEnv = process.env): MeshConfig {
  let fileCfg: Partial<MeshConfig> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath(stateDir, env), "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      fileCfg = parsed as Partial<MeshConfig>;
    }
  } catch {
  // missing/invalid config.json → defaults (graceful,
  }

  const cfg: MeshConfig = {
    ...DEFAULT_CONFIG,
    rooms:
      Array.isArray(fileCfg.rooms) && fileCfg.rooms.every((r) => typeof r === "string")
        ? [...fileCfg.rooms]
        : [...DEFAULT_CONFIG.rooms],
    maxFrameBytes: clampFrameBytes(positiveInt(fileCfg.maxFrameBytes, DEFAULT_CONFIG.maxFrameBytes)),
    heartbeatMs: positiveInt(fileCfg.heartbeatMs, DEFAULT_CONFIG.heartbeatMs),
    brokerSilenceMs: positiveInt(fileCfg.brokerSilenceMs, DEFAULT_CONFIG.brokerSilenceMs),
    mailboxCap: positiveInt(fileCfg.mailboxCap, DEFAULT_CONFIG.mailboxCap),
    mailboxTtlMs: positiveInt(fileCfg.mailboxTtlMs, DEFAULT_CONFIG.mailboxTtlMs),
    maxRoomsPerPeer: positiveInt(fileCfg.maxRoomsPerPeer, DEFAULT_CONFIG.maxRoomsPerPeer),
    transcript: fileCfg.transcript === true,
    transcriptRetentionDays: positiveInt(
      fileCfg.transcriptRetentionDays,
      DEFAULT_CONFIG.transcriptRetentionDays,
    ),
    ledgerMaxBytes: positiveInt(fileCfg.ledgerMaxBytes, DEFAULT_CONFIG.ledgerMaxBytes),
    activityIdleMs: positiveInt(fileCfg.activityIdleMs, DEFAULT_CONFIG.activityIdleMs),
    activityStuckMs: positiveInt(fileCfg.activityStuckMs, DEFAULT_CONFIG.activityStuckMs),
  // reservationTtlMs: 0 is a VALID opt-out (unlimited) — same pattern as
  // inboundBatchMs (positiveInt alone would coerce an explicit 0 back to
  // the 6 h default, making the opt-out unreachable).
  reservationTtlMs: fileCfg.reservationTtlMs === 0
    ? 0
    : positiveInt(fileCfg.reservationTtlMs, DEFAULT_CONFIG.reservationTtlMs),
  watchdog: fileCfg.watchdog === false ? false : true,
  watchdogSpikeBytes: positiveInt(
    fileCfg.watchdogSpikeBytes ?? DEFAULT_CONFIG.watchdogSpikeBytes,
    DEFAULT_CONFIG.watchdogSpikeBytes ?? DEFAULT_WATCHDOG_SPIKE_BYTES,
  ),
  watchdogMaxCalls: positiveInt(
    fileCfg.watchdogMaxCalls ?? DEFAULT_CONFIG.watchdogMaxCalls,
    DEFAULT_CONFIG.watchdogMaxCalls ?? DEFAULT_WATCHDOG_MAX_CALLS,
  ),
  watchdogCompactionBytes: positiveInt(
    fileCfg.watchdogCompactionBytes ?? DEFAULT_CONFIG.watchdogCompactionBytes,
    DEFAULT_CONFIG.watchdogCompactionBytes ?? DEFAULT_WATCHDOG_COMPACTION_BYTES,
  ),
  contextVerbosity: fileCfg.contextVerbosity === "full" ? "full" : "compact",
    inboundBroadcasts: fileCfg.inboundBroadcasts === "deferred" ? "deferred" : "immediate",
    inboundBatchMs: fileCfg.inboundBatchMs === 0
      ? 0
      : positiveInt(fileCfg.inboundBatchMs ?? DEFAULT_INBOUND_BATCH_MS, DEFAULT_INBOUND_BATCH_MS),
    inboundBatchMaxHoldMs: positiveInt(
      fileCfg.inboundBatchMaxHoldMs ?? 30_000,
      30_000,
    ),
  };
  if (typeof fileCfg.alias === "string" && fileCfg.alias.trim() !== "") cfg.alias = fileCfg.alias;
  if (typeof fileCfg.listen === "string" && parseEndpoint(fileCfg.listen) !== null) cfg.listen = fileCfg.listen;
  if (typeof fileCfg.brokerUrl === "string" && parseEndpoint(fileCfg.brokerUrl) !== null) cfg.brokerUrl = fileCfg.brokerUrl;
  if (typeof fileCfg.brokerToken === "string" && fileCfg.brokerToken.trim() !== "") cfg.brokerToken = fileCfg.brokerToken;
  if (typeof fileCfg.tlsCert === "string" && fileCfg.tlsCert !== "") cfg.tlsCert = fileCfg.tlsCert;
  if (typeof fileCfg.tlsKey === "string" && fileCfg.tlsKey !== "") cfg.tlsKey = fileCfg.tlsKey;
  if (typeof fileCfg.tlsCa === "string" && fileCfg.tlsCa !== "") cfg.tlsCa = fileCfg.tlsCa;
  if (fileCfg.tlsInsecure === true) cfg.tlsInsecure = true;
  if (fileCfg.debug === true) cfg.debug = true;

  // env overrides (priority over config file)
  const envListen = env.MESH_LISTEN;
  if (envListen !== undefined && parseEndpoint(envListen) !== null) cfg.listen = envListen;
  const envBrokerUrl = env.MESH_BROKER_URL;
  if (envBrokerUrl !== undefined && parseEndpoint(envBrokerUrl) !== null) cfg.brokerUrl = envBrokerUrl;
  const envToken = env.MESH_BROKER_TOKEN;
  if (envToken !== undefined && envToken.trim() !== "") cfg.brokerToken = envToken;
  const envCert = env.MESH_TLS_CERT;
  if (envCert !== undefined && envCert !== "") cfg.tlsCert = envCert;
  const envKey = env.MESH_TLS_KEY;
  if (envKey !== undefined && envKey !== "") cfg.tlsKey = envKey;
  const envCa = env.MESH_TLS_CA;
  if (envCa !== undefined && envCa !== "") cfg.tlsCa = envCa;
  if (env.MESH_TLS_INSECURE === "1" || env.MESH_TLS_INSECURE === "true") cfg.tlsInsecure = true;
  const envAlias = env.MESH_ALIAS;
  if (envAlias && envAlias.trim() !== "") cfg.alias = envAlias;
  const envRooms = env.MESH_ROOMS;
  if (envRooms && envRooms.trim() !== "") {
    cfg.rooms = envRooms
      .split(",")
      .map((r) => r.trim())
      .filter((r) => r.length > 0);
  }
  const envFrame = envInt(env, "MESH_MAX_FRAME_BYTES");
  if (envFrame !== undefined) cfg.maxFrameBytes = clampFrameBytes(envFrame);
  const envCap = envInt(env, "MESH_MAILBOX_CAP");
  if (envCap !== undefined) cfg.mailboxCap = envCap;
  const envTtl = envInt(env, "MESH_MAILBOX_TTL_MS");
  if (envTtl !== undefined) cfg.mailboxTtlMs = envTtl;
  const envIdle = envInt(env, "MESH_ACTIVITY_IDLE_MS");
  if (envIdle !== undefined) cfg.activityIdleMs = envIdle;
  const envStuck = envInt(env, "MESH_ACTIVITY_STUCK_MS");
  if (envStuck !== undefined) cfg.activityStuckMs = envStuck;
  const envResTtl = envInt(env, "MESH_RESERVATION_TTL_MS");
  if (envResTtl !== undefined) cfg.reservationTtlMs = envResTtl;
  // MESH_RESERVATION_TTL_MS=0 = explicit opt-out (unlimited)
  if (env.MESH_RESERVATION_TTL_MS === "0") cfg.reservationTtlMs = 0;
  if (env.MESH_WATCHDOG === "0" || env.MESH_WATCHDOG === "false") cfg.watchdog = false;
  if (env.MESH_CONTEXT_VERBOSE === "1" || env.MESH_CONTEXT_VERBOSE === "true") cfg.contextVerbosity = "full";
  if (env.MESH_INBOUND_BROADCASTS === "immediate" || env.MESH_INBOUND_BROADCASTS === "deferred") {
    cfg.inboundBroadcasts = env.MESH_INBOUND_BROADCASTS;
  }
  if (env.MESH_INBOUND_BATCH_MS !== undefined) {
    const n = Number(env.MESH_INBOUND_BATCH_MS);
    cfg.inboundBatchMs = Number.isFinite(n) && n >= 0 ? Math.floor(n) : cfg.inboundBatchMs;
  }
  if (env.MESH_DEBUG === "1" || env.MESH_DEBUG === "true") cfg.debug = true;
  const envTranscript = env.MESH_TRANSCRIPT;
  if (envTranscript !== undefined) cfg.transcript = envTranscript === "1" || envTranscript === "true";

  return cfg;
}
