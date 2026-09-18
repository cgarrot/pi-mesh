// extension/tools.ts — the mesh tools (send/reply/status/history/wait_all/
// ledger/reserve/release). Plain JSON Schema parameters (zero-dependency).
// Honest statuses: delivered ≠ read ≠ answered. Offline → blocked.
import { computePeerStatus, MeshClient, type SendResult } from "../client/client.js";
import type { MeshPriority } from "../protocol/envelope.js";
import { buildFrame, normalizeAlias } from "../protocol/envelope.js";
import { sha256 } from "../protocol/frames.js";
import {
  DEFAULT_AWAIT_REPLY_TIMEOUT_MS,
  DEFAULT_ROOM,
  MAX_AWAIT_REPLY_TIMEOUT_MS,
  MAX_BODY_BYTES,
  MAX_REFS,
  MAX_REPLY_TARGETS,
  MIN_AWAIT_REPLY_TIMEOUT_MS,
  TRANSCRIPT_RING_SIZE,
} from "../shared/config.js";
import { MESH_VERSION } from "../shared/version.js";
import type { DeferredInbox } from "./deferred-inbox.js";
import type { MeshGuards } from "./guards.js";
import { LOOP_GUARD_WARNING, REPLY_REPEAT_WARNING } from "./guards.js";
import { identityFromClient, type MeshIdentity } from "./identity.js";
import type { MeshLedger } from "./ledger.js";
import type { ExtensionAPI, SessionContext, ToolResult } from "./pi-types.js";
import { textResult } from "./pi-types.js";
import type { MeshTranscript } from "./transcript.js";

/** Shared per-session runtime, built at session_start (index.ts). */
export interface MeshRuntime {
  client: MeshClient;
  ledger: MeshLedger;
  transcript: MeshTranscript;
  guards: MeshGuards;
  ctx: SessionContext | null;
  stateDir: string;
  runtimeDir: string;
  /** Pi session id — stable across /reload (identity key). */
  sessionId: string;
  /** Identity persistence (alias/rooms/reservations survive reloads). */
  identity: MeshIdentity;
  /** transferred history from a /mesh new handoff (injected at ready). */
  pendingHistory?: string[];
  /** inbound batching (flush remaining frames on shutdown). */
  batcher?: { flushNow(): void };
  /** Unaddressed broadcasts held separately from immediate traffic. */
  deferredInbox?: DeferredInbox;
  /** Display-only entry outside the LLM context (mesh-verdict colors). */
  appendEntry?: (type: string, data: unknown) => void;
  /** pending auto-release timers per reserved pattern (mesh_reserve
  *  autoReleaseMs) — cleared on release and at session_shutdown. */
  reserveTimers?: Map<string, NodeJS.Timeout>;
  /** While set (ms epoch), inbound frames are HELD, not injected — the
   *  provider is rejecting turns (429) and every injection burns one. */
  rateLimitedUntil?: number;
  /** Deliver everything queued while rate-limited (called at hold expiry). */
  flushHeld?: () => void;
  /** D41: flip the client-handler detach guard (session_shutdown). */
  markDetached?: () => void;
  /** D41: clear the rate-limit hold timer (session_shutdown). */
  stopHold?: () => void;
  /** Called by the context watchdog when a compaction is detected —
  *  lets attach.ts resync the mesh context block (conventions lost). */
  onCompactionDetected?: () => void;
  startedAt: number;
  /** inbound-path disk/injection failure counters (see index.ts). */
  ledgerFailures: number;
  transcriptFailures: number;
  injectionFailures: number;
}

export type GetRuntime = () => MeshRuntime | null;

const SEND_RESULT_SCHEMA = "mesh.send-result.v1";

function sendDetails(
  partial: Record<string, unknown>,
): Record<string, unknown> {
  return { schema: SEND_RESULT_SCHEMA, bodyStored: false, ...partial };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

function resultText(res: SendResult): string {
  switch (res.status) {
    case "delivered":
      if (res.deliveredCount !== undefined && res.totalCount !== undefined) {
        return `delivered ${res.msgId} (${res.deliveredCount}/${res.totalCount} online)`;
      }
      return `delivered ${res.msgId}`;
    case "queued_offline":
      if (res.deliveredCount !== undefined && res.totalCount !== undefined) {
        return `queued_offline ${res.msgId} (${res.totalCount} targets offline)`;
      }
      return `queued_offline ${res.msgId}`;
    case "reply":
      return `reply ${res.msgId}: ${res.response}`;
    case "expired":
      return `expired ${res.msgId ?? ""} (late replies are still delivered and injected)`;
    case "blocked":
      return `blocked: ${res.reason}`;
    case "error":
      if (res.reason === "cancelled") {
        return `cancelled ${res.msgId ?? ""} (ESC — mission dropped; a late reply is still delivered and injected)`;
      }
      return `error: ${res.reason}`;
  }
}

/** Best-effort ledger append — a ledger failure never crashes the session. */
function safeLedger(rt: MeshRuntime, input: Parameters<MeshLedger["append"]>[0]): void {
  try {
    rt.ledger.append(input);
  } catch {
  // fail-closed throw is for forbidden keys; our records never contain them
  }
}

// ---------------------------------------------------------------- send guards

/** Minimum busy duration before an awaitReply warning (a 30 s bash turn
 *  must not nag — measured incident: 6/6 expired missions toward agents
 *  running 4-10 min GPU renders). */
export const BUSY_WARN_MIN_MS = 300_000; // 5 min

export interface TargetCheck {
  /** Hard local error — the target can NEVER be a real alias. */
  error?: string;
  /** How to fix it (appended to the error text). */
  hint?: string;
  /** Non-blocking caution (alias unseen — may be offline/renamed). */
  warning?: string;
}

/**
 * Local mesh_send target validation (M1). Catches address-space
 * confusions BEFORE the broker round-trip — observed in the wild:
 * to:"*" and to:"cs-room-broadcast" (broadcast intent), both doomed.
 * A syntactically-fine alias that is simply not (yet) known is only a
 * WARNING: presence is best-effort, never a reason to block a send.
 */
export function checkSendTarget(
  to: string,
  knowsPeer: (alias: string) => boolean,
  knownCount: number,
): TargetCheck {
  if (to === "*") {
    return {
      error: "invalid_target",
      hint: '"*" is not an alias — to reach a whole room use broadcast: true (omit to)',
    };
  }
  if (/^[a-z0-9][a-z0-9.-]*-broadcast$/.test(to) && !knowsPeer(to)) {
    return {
      error: "invalid_target",
      hint: `"${to}" looks like a room-broadcast pseudo-target — use broadcast: true (no such alias online)`,
    };
  }
  if (knownCount > 0 && !knowsPeer(to)) {
    return {
      warning: `@${to} not in the latest presence — offline or renamed? (the send still goes out; statuses stay honest)`,
    };
  }
  return {};
}

/** Busy-target warning for awaitReply sends. Pure. */
export function busyTargetWarning(
  to: string,
  busyMs: number | undefined,
  timeoutMs: number,
  minBusyMs: number = BUSY_WARN_MIN_MS,
): string | undefined {
  if (busyMs === undefined || busyMs < minBusyMs) return undefined;
  if (timeoutMs >= busyMs) return undefined; // the timeout outlives the busy span
  return (
    `⚠ @${to} has been busy for ${formatElapsed(busyMs)} while timeoutMs is ` +
    `${formatElapsed(timeoutMs)} — the mission will likely expire. Prefer burst mode ` +
    `(awaitReply: true, block: false) + mesh_wait_all, or raise timeoutMs.`
  );
}

// ---------------------------------------------------------------- mesh_send

const MESH_SEND_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    to: { type: "string", description: "Target alias ('@' tolerated, case-insensitive). OMIT when broadcast: true." },
    message: { type: "string", description: "Message body (1..32 KiB)." },
    room: {
      type: "string",
      description: "Room id. Default: 'default' when still joined, else your " +
        "first joined room (a session that left 'default' sends into its " +
        "remaining room). Required for broadcast.",
    },
    broadcast: {
      type: "boolean",
      description: "Fan out to EVERY member of room (to must be omitted). Returns deliveredCount/totalCount.",
    },
    priority: {
      type: "string",
      enum: ["normal", "urgent", "force"],
      description: "normal→followUp, urgent→steer, force→abort+steer (requires reason).",
    },
    reason: {
      type: "string",
      description: "Required when priority=force. Hashed (reasonHash), never persisted.",
    },
    awaitReply: { type: "boolean", description: "Wait for an explicit mesh_reply (default false)." },
    block: {
      type: "boolean",
      description: "D46: with awaitReply — false = LAUNCH mode: return the delivery " +
        "result immediately, keep the mission tracked in the background, and " +
        "call mesh_wait_all for the group verdict. Each answer is ALSO " +
        "delivered to the session as a [mesh] reply event (an idle session " +
        "wakes). Default true (blocks until the reply or the timeout; ESC " +
        "cancels a blocking wait).",
    },
    timeoutMs: {
      type: "number",
      minimum: MIN_AWAIT_REPLY_TIMEOUT_MS,
      maximum: MAX_AWAIT_REPLY_TIMEOUT_MS,
      description: `awaitReply timeout in ms (default ${DEFAULT_AWAIT_REPLY_TIMEOUT_MS}).`,
    },
    refs: {
      type: "array",
      items: { type: "string" },
      maxItems: MAX_REFS,
      description: "Repo-relative reference paths (≤ 8).",
    },
    replyTo: {
      type: "array",
      items: { type: "string" },
      maxItems: MAX_REPLY_TARGETS,
      description: "Alias(es) that should receive the reply instead of the sender " +
        "(default: the sender). The recipient's mesh_reply without an explicit " +
        "`to` goes to ALL of them. Include yourself to also get the answer " +
        "(e.g. with awaitReply).",
    },
  },
  required: ["to", "message"],
};

async function execMeshSend(
  getRuntime: GetRuntime,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const rt = getRuntime();
  if (rt === null) return textResult("blocked: session_not_started", sendDetails({ status: "blocked", reason: "session_not_started" }));
  const broadcast = params.broadcast === true;
  const toRaw = str(params.to);
  const message = str(params.message);
  if (message === undefined) {
    return textResult("error: invalid_frame (message is required)", sendDetails({ status: "error", reason: "invalid_frame" }));
  }
  if (!broadcast && toRaw === undefined) {
    return textResult("error: invalid_frame (to is required unless broadcast: true)", sendDetails({ status: "error", reason: "invalid_frame" }));
  }
  if (broadcast && toRaw !== undefined) {
    return textResult("error: broadcast_with_to (omit 'to' when broadcasting)", sendDetails({ status: "error", reason: "broadcast_with_to" }));
  }
  // A8: ledger records + tool details store the CANONICAL alias ('@Bob' → 'bob')
  // so ledger predicates are insensitive to how the model typed the alias.
  // Guards (checkSend) and client.send normalize idempotently; result text unchanged.
  const to = toRaw !== undefined ? normalizeAlias(toRaw) : "*"; // '*' = broadcast target
  // Room resolution mirrors the client: explicit room wins; otherwise
  // "default" when still joined, else the FIRST joined room. A session
  // that left "default" (e.g. agent-master in cs-room only) must NOT
  // default its sends to "default" — the broker would refuse not_member.
  const room =
    str(params.room) ??
    (rt.client.rooms.includes(DEFAULT_ROOM) ? DEFAULT_ROOM : rt.client.rooms[0] ?? DEFAULT_ROOM);
  const priority = (str(params.priority) ?? "normal") as MeshPriority;
  const reason = str(params.reason);
  const awaitReply = params.awaitReply === true;
  const block = params.block === false ? false : true;
  const launch = awaitReply && !block; // track + return immediately
  const timeoutMs = typeof params.timeoutMs === "number" ? params.timeoutMs : undefined;
  const refs = Array.isArray(params.refs)
    ? params.refs.filter((r): r is string => typeof r === "string")
    : undefined;
  const replyTo = Array.isArray(params.replyTo)
    ? params.replyTo.filter((r): r is string => typeof r === "string")
    : str(params.replyTo) !== undefined
      ? [str(params.replyTo) as string]
      : undefined;
  const bodyHash = sha256(message);
  const reasonHash = priority === "force" && reason !== undefined ? sha256(reason) : undefined;
  // M1 send guards: local rejection of impossible targets + soft warning
  // for unseen aliases — BEFORE any broker round-trip. NOTE: to==="*" here
  // can ONLY come from an explicit to:"*" (broadcast sends skip this block
  // — they set to internally and never re-enter), so it is caught too.
  const sendWarnings: string[] = [];
  if (!broadcast) {
    const check = checkSendTarget(
      to,
      (a) => rt.client.knowsPeer(a),
      rt.client.knownPeerList.length,
    );
    if (check.error !== undefined) {
      safeLedger(rt, {
        event: "blocked", from: rt.client.alias, to, room, priority, bodyHash, reasonHash, refs, code: check.error,
      });
      return textResult(
        `blocked: ${check.error} — ${check.hint ?? ""}`,
        sendDetails({ status: "blocked", reason: check.error, to, room, priority, bodyHash }),
      );
    }
    if (check.warning !== undefined) sendWarnings.push(check.warning);
  }
  // M2 busy-target warning: awaitReply toward a peer busy for longer than
  // the timeout is a near-certain expiry (measured: 6/6 in cs-room).
  if (!broadcast && awaitReply) {
    const busyWarn = busyTargetWarning(
      to,
      rt.client.busyForMs(to),
      timeoutMs ?? DEFAULT_AWAIT_REPLY_TIMEOUT_MS,
    );
    if (busyWarn !== undefined) sendWarnings.push(busyWarn);
  }

  // Guards: self-send, duplicate window, client caps, observer.
  const guard = rt.guards.checkSend({ from: rt.client.alias, to, room, body: message, priority });
  if (!guard.ok) {
    safeLedger(rt, {
      event: "blocked", from: rt.client.alias, to, room, priority, bodyHash, reasonHash, refs, code: guard.reason,
    });
    return textResult(`blocked: ${guard.reason}`, sendDetails({ status: "blocked", reason: guard.reason, to, room, priority, bodyHash }));
  }

  if (!rt.client.isOnline()) {
  // broker absent → tools answer blocked, never crash the session.
    try {
      await rt.client.connect();
    } catch {
      safeLedger(rt, { event: "blocked", from: rt.client.alias, to, room, priority, bodyHash, refs, code: "broker_unavailable" });
      return textResult("blocked: broker_unavailable", sendDetails({ status: "blocked", reason: "broker_unavailable", to, room, priority, bodyHash }));
    }
  }

  // transcript: outbound frame WITH body (redacted at record time) — opt-in only.
  if (rt.transcript.isEnabled()) {
    rt.transcript.record("out", buildFrame({ type: "msg", from: rt.client.alias, to, room, priority, body: message, refs, broadcast: broadcast ? true : undefined }));
  }
  safeLedger(rt, {
    event: "sent", from: rt.client.alias, to, room, priority, bodyHash, reasonHash, refs,
    code: broadcast ? "broadcast" : undefined,
  });

  const res = await rt.client.send({
    to: broadcast ? undefined : to,
    message, room, priority, reason, awaitReply, block, timeoutMs, refs, broadcast, replyTo,
    signal: !launch && signal !== undefined ? signal : undefined,
  });

  // `delivered` is ledgered ONLY here — after the broker ack (client.send
  // resolves delivered exclusively post-ack).
  switch (res.status) {
    case "delivered":
      safeLedger(rt, {
        event: "delivered", id: res.msgId, from: rt.client.alias, to, room, priority, bodyHash, reasonHash, refs,
        code: broadcast ? `broadcast:${res.deliveredCount ?? 0}/${res.totalCount ?? 0}` : undefined,
      });
      break;
    case "queued_offline":
      safeLedger(rt, {
        event: "queued_offline", id: res.msgId, from: rt.client.alias, to, room, priority, bodyHash, reasonHash, refs,
        code: broadcast ? `broadcast:${res.deliveredCount ?? 0}/${res.totalCount ?? 0}` : undefined,
      });
      break;
    case "reply":
      safeLedger(rt, { event: "reply", id: res.msgId, from: rt.client.alias, to, room, priority, bodyHash, refs, code: res.outputHash });
      break;
    case "expired":
      safeLedger(rt, { event: "expired", id: res.msgId, from: rt.client.alias, to, room, priority, bodyHash, refs, code: "expired" });
      break;
    case "blocked":
      safeLedger(rt, { event: "blocked", id: res.msgId, from: rt.client.alias, to, room, priority, bodyHash, refs, code: res.reason });
      break;
    case "error":
      safeLedger(rt, { event: "error", id: res.msgId, from: rt.client.alias, to, room, priority, bodyHash, refs, code: res.reason });
      break;
  }

  const details = sendDetails({
    status: res.status,
    msgId: "msgId" in res ? res.msgId : undefined,
    to, room, priority, bodyHash,
    broadcast: broadcast || undefined,
    deliveredCount: "deliveredCount" in res ? res.deliveredCount : undefined,
    totalCount: "totalCount" in res ? res.totalCount : undefined,
    reason: "reason" in res ? res.reason : undefined,
  });
  if (guard.warnings.includes(LOOP_GUARD_WARNING)) details.loopGuard = "matched";
  if (sendWarnings.length > 0) {
    details.warnings = sendWarnings;
    details.warning = sendWarnings.join(" | ");
  }
  // launch-mode hint so the agent knows the verdict comes from wait_all
  const hint =
    launch && (res.status === "delivered" || res.status === "queued_offline")
      ? ` (mission tracked — answers arrive as [mesh] reply events; mesh_wait_all gives the group verdict)`
      : "";
  const warnSuffix =
    sendWarnings.length > 0 ? `\n${sendWarnings.map((w) => `  ${w}`).join("\n")}` : "";
  return textResult(`${resultText(res)}${hint}${warnSuffix}`, details);
}

// ---------------------------------------------------------------- mesh_reply

const MESH_REPLY_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    msgId: { type: "string", description: "Exact msgId of an inbound message (I5 strict correlation)." },
    message: { type: "string", description: "Reply body (1..32 KiB)." },
    to: {
      type: "string",
      description: "Override the reply target: by default the reply goes to the " +
        "original sender — or to the alias(es) the sender designated with " +
        "replyTo on the original message. Use `to` to send it elsewhere.",
    },
    replyAll: {
      type: "boolean",
      description: "Fan the answer out to the whole room of the original message " +
        "(mutually exclusive with `to`).",
    },
    refs: { type: "array", items: { type: "string" }, maxItems: MAX_REFS },
  },
  required: ["msgId", "message"],
};

async function execMeshReply(
  getRuntime: GetRuntime,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const rt = getRuntime();
  if (rt === null) return textResult("blocked: session_not_started", sendDetails({ status: "blocked", reason: "session_not_started" }));
  const msgId = str(params.msgId);
  const message = str(params.message);
  if (msgId === undefined || message === undefined) {
    return textResult("error: invalid_frame (msgId and message are required)", sendDetails({ status: "error", reason: "invalid_frame" }));
  }
  const refs = Array.isArray(params.refs)
    ? params.refs.filter((r): r is string => typeof r === "string")
    : undefined;
  const replyAll = params.replyAll === true;
  const toRaw = str(params.to);
  if (replyAll && toRaw !== undefined) {
    return textResult("error: reply_all_with_to (replyAll and to are mutually exclusive)", sendDetails({ status: "error", reason: "reply_all_with_to", msgId }));
  }
  const bodyHash = sha256(message);

  if (!rt.client.isOnline()) {
    try {
      await rt.client.connect();
    } catch {
      return textResult("blocked: broker_unavailable", sendDetails({ status: "blocked", reason: "broker_unavailable", msgId, bodyHash }));
    }
  }

  // Peek the original BEFORE reply — read-only, and safe against any
  // future inbox eviction during the round-trip.
  const orig = rt.client.peekInbox(msgId);
  if (orig === undefined || orig.from === undefined) {
  // msgId unknown to the local inbox (or no usable sender) → explicit
  // refusal BEFORE the network call (mirrors client.reply's guard), so no
  // 'sent' record is ever ledgered for a blocked reply.
    safeLedger(rt, { event: "blocked", id: msgId, from: rt.client.alias, bodyHash, refs, code: "reply_without_target" });
    return textResult(
      "blocked: reply_without_target — use the exact msgId from an inbound [mesh] " +
        "message (a 'reply to m_...' reference inside a message is NOT a valid target)",
      sendDetails({ status: "blocked", reason: "reply_without_target", msgId, bodyHash }),
    );
  }
  // causal anchoring: 'sent' is ledgered BEFORE the network call,
  // mirroring execMeshSend ordering, enriched with to/room/priority from the
  // peeked original (undefined keys omitted by the ledger, as below).
  safeLedger(rt, {
    event: "sent", from: rt.client.alias, to: toRaw ?? orig.from, room: orig.room, priority: orig.priority, bodyHash, refs,
    code: replyAll ? "reply_all" : toRaw !== undefined ? "reply_to" : undefined,
  });
  // flag re-replies to the same msgId (warning only — never blocks)
  const replyGuard = rt.guards.checkReply(msgId);
  const res = await rt.client.reply(msgId, message, { refs, to: toRaw, replyAll });
  if (res.status === "error" && res.reason === "reply_without_target") {
  // defense in depth: inbox eviction between peek and reply.
    safeLedger(rt, { event: "blocked", id: msgId, from: rt.client.alias, bodyHash, refs, code: "reply_without_target" });
    return textResult(
      "blocked: reply_without_target — use the exact msgId from an inbound [mesh] " +
        "message (a 'reply to m_...' reference inside a message is NOT a valid target)",
      sendDetails({ status: "blocked", reason: "reply_without_target", msgId, bodyHash }),
    );
  }
  if (rt.transcript.isEnabled()) {
    rt.transcript.record("out", buildFrame({
      type: "reply", from: rt.client.alias, to: toRaw, room: orig.room, replyTo: msgId,
      body: message, refs, replyAll: replyAll ? true : undefined,
    }));
  }
  safeLedger(rt, {
    event: res.status === "delivered" ? "delivered" : "error",
    id: "msgId" in res ? res.msgId : msgId,
    from: rt.client.alias,
    to: toRaw ?? orig?.from,
    room: orig?.room,
    priority: orig?.priority,
    bodyHash, refs,
    code: res.status === "delivered"
      ? (replyAll ? `reply_all:${res.deliveredCount ?? 0}/${res.totalCount ?? 0}` : toRaw !== undefined ? "reply_to" : undefined)
      : ("reason" in res ? res.reason : "error"),
  });
  const details = sendDetails({
    status: res.status,
    msgId: "msgId" in res ? res.msgId : msgId,
    replyTo: msgId,
    to: toRaw ?? orig?.from,
    room: orig?.room,
    priority: orig?.priority,
    replyAll: replyAll || undefined,
    deliveredCount: "deliveredCount" in res ? res.deliveredCount : undefined,
    totalCount: "totalCount" in res ? res.totalCount : undefined,
    bodyHash,
    reason: "reason" in res ? res.reason : undefined,
  });
  if (replyGuard.warnings.includes(REPLY_REPEAT_WARNING)) details.alreadyReplied = "matched";
  const text = replyGuard.warnings.includes(REPLY_REPEAT_WARNING)
    ? `${resultText(res)} — ⚠️ already replied to this msgId recently (check before re-answering)`
    : resultText(res);
  return textResult(text, details);
}

// ---------------------------------------------------------------- mesh_status

const MESH_STATUS_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    room: { type: "string", description: "Restrict the snapshot to one room." },
    all: {
      type: "boolean",
      description: "D29: show EVERY peer of the mesh (all rooms). Default: only peers " +
        "sharing a room with this session (the room visibility rule).",
    },
  },
};

async function execMeshStatus(
  getRuntime: GetRuntime,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const rt = getRuntime();
  if (rt === null) return textResult("blocked: session_not_started", sendDetails({ status: "blocked", reason: "session_not_started" }));
  const room = str(params.room);
  if (!rt.client.isOnline()) {
    try {
      await rt.client.connect();
    } catch {
      return textResult("blocked: broker_unavailable", sendDetails({ status: "blocked", reason: "broker_unavailable" }));
    }
  }
  const snap = await rt.client.status(room);
  // by default, only peers VISIBLE from this session (sharing at least
  // one room) are listed — an agent alone in "voice" must not see the
  // cs-room agents. all:true (or an explicit room filter) lifts that.
  const mine = new Set(room !== undefined ? [room] : rt.client.rooms);
  const visible = snap.peers.filter(
    (p) => p.alias === rt.client.alias || mine.size === 0 || p.rooms.some((r) => mine.has(r)),
  );
  const peers = params.all === true ? snap.peers : visible;
  const localVersion = MESH_VERSION;
  // missions FIRST: the summary line needs them (likely-done inference)
  const missions = rt.client.missionStatus();
  const lines = [
    `mesh status — alias @${rt.client.alias}${room !== undefined ? ` room=${room}` : ""} (my rooms: ${rt.client.rooms.join(",") || "none"})`,
    `peers (${peers.length}):`,
    ...peers.map((p) => {
      const v = p.clientVersion !== undefined && p.clientVersion !== "" ? ` v${p.clientVersion}` : " v?";
      const skew = p.clientVersion !== undefined && p.clientVersion !== localVersion ? " ⚠" : "";
      const since = p.since !== undefined ? ` since=${p.since}` : "";
  // D40: remote-machine peers (tcp/tls to the broker) carry their origin
      const via = p.via !== undefined ? ` via=${p.via} ⟵ other machine` : "";
  // Phase 3: announced turn state wins; heuristic (lastSeenAt) as
  // fallback for peers that never announce (old versions)
      if (p.activity !== undefined) {
        const tag = p.activity.state === "busy"
          ? " ● working"
          : p.activity.state === "rate_limited"
            ? " ⛔ rate-limited"
            : p.activity.state === "blocked"
              ? " ✖ blocked (needs intervention)"
              : ` ○ idle (since ${localTime(p.activity.at)})`;
        return `  @${p.alias} rooms=${p.rooms.join(",")}${v}${skew}${since}${via}${tag}`;
      }
      const act = computePeerStatus(p.lastSeenAt, (p.reservations?.length ?? 0) > 0, rt.client.activityIdleMs, rt.client.activityStuckMs);
      const actTag = act.status === "active" ? "" : act.status === "stuck" ? ` ✕stuck ${act.idleFor}` : ` ○idle ${act.idleFor}`;
      return `  @${p.alias} rooms=${p.rooms.join(",")}${v}${skew}${since}${via}${actTag}`;
    }),
    `mesh rooms: ${snap.rooms.length > 0 ? snap.rooms.join(", ") : "(none)"}`,
  ];
  // Phase 3: who is likely done — idle AND no mission of ours still
  // waiting on them (their last verdicts were all answered)
  const summary = buildStatusSummary(peers, missions);
  if (summary.total > 0) {
    lines.push(
      `summary: ${summary.working} working · ${summary.idle} idle · ${summary.stuck} stuck · ${summary.rateLimited} rate-limited · ${summary.blocked} blocked · ${summary.likelyDone} likely done`,
    );
  }
  // M2: broker counters — relayed/refused/mailbox at a glance
  if (snap.stats !== undefined) {
    const s = snap.stats;
    lines.push(`broker: relayed=${s.relayed} refused=${s.refused} mailboxDelivered=${s.mailboxDelivered} mailboxDropped=${s.mailboxDropped}`);
  }
  const receipts = rt.client.readReceipts(3);
  if (receipts.length > 0) {
    lines.push(
      "",
      "reads:",
      ...receipts.map((r) => `  ${r.msgId.slice(0, 18)} → @${r.alias} at ${r.at.slice(11, 19)}`),
    );
  }
  if (missions.length > 0) {
    lines.push("", "missions:");
    for (const m of missions) {
      const tag =
        m.status === "answered"
          ? "✓ answered"
          : m.status === "expired"
            ? "✗ expired"
            : m.status === "failed"
              ? "✗ failed"
              : "✗ waiting";
      lines.push(`  ${m.msgId.slice(0, 18)} → @${m.to} ${tag}`);
    }
  }
  return textResult(lines.join("\n"), {
    schema: "mesh.status.v1",
    alias: rt.client.alias,
    room,
    peers: peers.map((p) => ({ alias: p.alias, rooms: p.rooms, since: p.since, via: p.via })),
    rooms: snap.rooms,
  });
}

// ---------------------------------------------------------------- mesh_history

const MESH_HISTORY_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    limit: { type: "number", minimum: 1, maximum: TRANSCRIPT_RING_SIZE, description: "Max frames (default 20)." },
    withBodies: { type: "boolean", description: "Include bodies (default true)." },
  },
};

function execMeshHistory(
  getRuntime: GetRuntime,
  params: Record<string, unknown>,
): ToolResult {
  const rt = getRuntime();
  if (rt === null) return textResult("blocked: session_not_started", sendDetails({ status: "blocked", reason: "session_not_started" }));
  const limitRaw = typeof params.limit === "number" ? Math.floor(params.limit) : 20;
  const limit = Math.min(TRANSCRIPT_RING_SIZE, Math.max(1, limitRaw));
  const withBodies = params.withBodies !== false;
  // mesh_history reads the client MEMORY ring only — never the ledger.
  const frames = rt.client.transcript.slice(-limit);
  const lines = frames.map((f) => {
    const head = `${f.ts} ${f.type} ${f.from ?? "?"}→${f.to ?? "*"}`;
    const body = withBodies && f.body !== undefined ? ` ${f.body}` : "";
    return `${head}${body}`;
  });
  return textResult(
    lines.length > 0 ? lines.join("\n") : "(empty history)",
    { schema: "mesh.history.v1", count: frames.length, withBodies },
  );
}

// ---------------------------------------------------------------- mesh_wait_all

const MESH_WAIT_ALL_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    timeoutMs: {
      type: "number",
      minimum: MIN_AWAIT_REPLY_TIMEOUT_MS,
      maximum: MAX_AWAIT_REPLY_TIMEOUT_MS,
      description: "How long to wait for all answers (default 300000 = 5 min).",
    },
  },
};

/** Phase 3: group verdict of a status snapshot — counts by state, and
 *  "likely done" = idle peers with NO mission of ours still waiting on
 *  them. Pure, exported for tests. */
export interface StatusSummary {
  total: number;
  working: number;
  idle: number;
  stuck: number;
  rateLimited: number;
  blocked: number;
  likelyDone: number;
}

export function buildStatusSummary(
  peers: { alias: string; activity?: { state: "busy" | "idle" | "rate_limited" | "blocked"; at: string }; reservations?: { pattern: string }[]; lastSeenAt?: string }[],
  missions: { to: string; status: string }[],
  idleMs = 120_000,
  stuckMs = 900_000,
  now = Date.now(),
): StatusSummary {
  const waitingOn = new Set(
    missions.filter((m) => m.status === "waiting").map((m) => m.to),
  );
  let working = 0;
  let idle = 0;
  let stuck = 0;
  let rateLimited = 0;
  let blocked = 0;
  let likelyDone = 0;
  for (const p of peers) {
    if (p.activity !== undefined) {
      if (p.activity.state === "busy") {
        working += 1;
        continue;
      }
      if (p.activity.state === "rate_limited") {
        rateLimited += 1;
        continue;
      }
      if (p.activity.state === "blocked") {
        blocked += 1;
        continue;
      }
      idle += 1;
      if (!waitingOn.has(p.alias)) likelyDone += 1;
      continue;
    }
  // heuristic fallback (no announced activity)
    const act = computePeerStatus(p.lastSeenAt, (p.reservations?.length ?? 0) > 0, idleMs, stuckMs, now);
    if (act.status === "active") working += 1;
    else if (act.status === "stuck") stuck += 1;
    else {
      idle += 1;
      if (!waitingOn.has(p.alias)) likelyDone += 1;
    }
  }
  return { total: peers.length, working, idle, stuck, rateLimited, blocked, likelyDone };
}

/** Local HH:MM:SS from an ISO timestamp (best effort, display only). */
function localTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "??:??:??";
  return new Date(t).toTimeString().slice(0, 8);
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}

async function execMeshWaitAll(
  getRuntime: GetRuntime,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const rt = getRuntime();
  if (rt === null) return textResult("blocked: session_not_started", sendDetails({ status: "blocked", reason: "session_not_started" }));
  const timeoutMs = Math.min(
    MAX_AWAIT_REPLY_TIMEOUT_MS,
    Math.max(MIN_AWAIT_REPLY_TIMEOUT_MS, typeof params.timeoutMs === "number" ? params.timeoutMs : 300_000),
  );
  const res = await rt.client.waitAll(timeoutMs, signal);
  const head = `wait_all: ${res.answered}/${res.total} answered${res.status === "timeout" ? " (TIMEOUT)" : res.status === "cancelled" ? " (CANCELLED — ESC)" : ""} after ${formatElapsed(res.elapsedMs)}`;
  const lines = [head];
  for (const a of res.answers) {
    const body = a.response.replace(/\s+/g, " ").trim();
    lines.push(`  ✓ @${a.to}: ${body.slice(0, 140)}`);
  }
  for (const m of res.missing) {
    const act = rt.client.activityOf(m.to)?.state;
    const busyMs = rt.client.busyForMs(m.to);
    const reason =
      busyMs !== undefined && busyMs > 60_000
        ? ` — still busy (${formatElapsed(busyMs)})`
        : act === "rate_limited"
          ? " — rate-limited, retry later"
          : act === "blocked"
            ? " — blocked (provider error, needs intervention)"
            : "";
    lines.push(`  ✗ @${m.to}: NOT ANSWERED (${m.msgId.slice(0, 18)})${reason}`);
  }
  if (res.total === 0) lines.push("  (no awaited missions — send with awaitReply: true first)");
  // display the colored verdict entry (agent colors + agent-color backgrounds)
  if (rt.appendEntry !== undefined) {
    try {
      rt.appendEntry("mesh-verdict", {
        head,
        answers: res.answers.map((a) => ({ to: a.to, response: a.response })),
        missing: res.missing.map((m) => ({ to: m.to, msgId: m.msgId })),
      });
    } catch {
      // display only — never breaks the tool result
    }
  }
  return textResult(lines.join("\n"), {
    schema: "mesh.wait-all.v1",
    status: res.status,
    total: res.total,
    answered: res.answered,
    elapsedMs: res.elapsedMs,
    missing: res.missing,
  });
}

// ---------------------------------------------------------------- mesh_ledger

const MESH_LEDGER_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    limit: { type: "number", minimum: 1, maximum: 200, description: "Max records (default 20)." },
    from: { type: "string", description: "Filter: sender alias." },
    to: { type: "string", description: "Filter: recipient alias." },
    room: { type: "string", description: "Filter: room." },
    event: {
      type: "string",
      description: "Filter: sent | delivered | queued_offline | reply | expired | blocked | error | inbound | reserved | released",
    },
  },
};

function execMeshLedger(
  getRuntime: GetRuntime,
  params: Record<string, unknown>,
): ToolResult {
  const rt = getRuntime();
  if (rt === null) return textResult("blocked: session_not_started", sendDetails({ status: "blocked", reason: "session_not_started" }));
  const limitRaw = typeof params.limit === "number" ? Math.floor(params.limit) : 20;
  const limit = Math.min(200, Math.max(1, limitRaw));
  const records = rt.ledger.read(limit, {
    from: str(params.from),
    to: str(params.to),
    room: str(params.room),
    event: str(params.event),
  });
  if (records.length === 0) {
    return textResult("(no ledger records matching)", { schema: "mesh.ledger.v1", count: 0 });
  }
  const lines = records.map((r) => {
    const id = r.id !== undefined ? ` ${r.id.slice(0, 18)}` : "";
    return `${r.ts.slice(11, 19)} ${r.event}${id} ${r.from ?? "?"}→${r.to ?? "*"}${r.room !== undefined ? ` @${r.room}` : ""}${r.code !== undefined ? ` [${r.code}]` : ""}`;
  });
  return textResult(lines.join("\n"), {
    schema: "mesh.ledger.v1",
    count: records.length,
    filter: { from: str(params.from), to: str(params.to), room: str(params.room), event: str(params.event) },
  });
}

// ---------------------------------------------------------------- mesh_reserve

const MESH_RESERVE_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    paths: {
      type: "array",
      items: { type: "string" },
      description:
        "Paths to reserve. Use a trailing '/' for a directory subtree " +
        "(e.g. 'web/tools/'). Relative paths are compared against edit/write " +
        "paths as-is (backslashes tolerated).",
    },
    reason: { type: "string", description: "Why you're reserving these paths (visible to peers)." },
    autoReleaseMs: {
      type: "number",
      minimum: 1_000,
      maximum: 86_400_000,
      description:
        "Auto-release after this long (bounded runs — e.g. GPU renders). " +
        "Fire-and-forget local timer; mesh_release({}) cancels everything.",
    },
  },
  required: ["paths"],
};

/** Arm one auto-release timer per freshly reserved pattern. */
function armReserveTimers(rt: MeshRuntime, patterns: string[], ms: number): void {
  rt.reserveTimers ??= new Map();
  for (const pattern of patterns) {
    const prev = rt.reserveTimers.get(pattern);
    if (prev !== undefined) clearTimeout(prev);
    const t = setTimeout(() => {
      rt.reserveTimers?.delete(pattern);
      void rt.client.release([pattern]).catch(() => {}); // best effort
      try {
        rt.identity.save(identityFromClient(rt.sessionId, rt.client));
      } catch {
  // best effort
      }
    }, ms);
    t.unref();
    rt.reserveTimers.set(pattern, t);
  }
}

/** Clear auto-release timers (release/shutdown). */
function clearReserveTimers(rt: MeshRuntime, patterns?: string[]): void {
  if (rt.reserveTimers === undefined) return;
  for (const [pattern, t] of [...rt.reserveTimers]) {
    if (patterns === undefined || patterns.includes(pattern)) {
      clearTimeout(t);
      rt.reserveTimers.delete(pattern);
    }
  }
}

async function execMeshReserve(
  getRuntime: GetRuntime,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const rt = getRuntime();
  if (rt === null) return textResult("blocked: session_not_started", sendDetails({ status: "blocked", reason: "session_not_started" }));
  const rawPaths = Array.isArray(params.paths)
    ? params.paths.filter((p): p is string => typeof p === "string")
    : [];
  if (rawPaths.length === 0) {
    return textResult("error: invalid_pattern (paths required)", sendDetails({ status: "error", reason: "invalid_pattern" }));
  }
  const reason = str(params.reason);
  const autoReleaseMs =
    typeof params.autoReleaseMs === "number" && params.autoReleaseMs >= 1_000
      ? Math.min(86_400_000, Math.floor(params.autoReleaseMs))
      : undefined;
  const res = await rt.client.reserve(rawPaths, reason);
  if (res.status === "delivered") {
    safeLedger(rt, { event: "reserved", id: res.msgId, from: rt.client.alias, refs: rawPaths, code: reason });
    if (autoReleaseMs !== undefined) armReserveTimers(rt, rawPaths, autoReleaseMs);
  // reservations must survive /reload → persist identity now.
    rt.identity.save(identityFromClient(rt.sessionId, rt.client));
    const auto = autoReleaseMs !== undefined ? ` — auto-release in ${formatElapsed(autoReleaseMs)}` : "";
    return textResult(`reserved ${rawPaths.length} path(s) — peers notified${auto}`, sendDetails({ status: "delivered", paths: rawPaths, reason, autoReleaseMs }));
  }
  const resReason = "reason" in res ? res.reason : "error";
  safeLedger(rt, { event: "blocked", from: rt.client.alias, refs: rawPaths, code: resReason });
  return textResult(`blocked: ${resReason}`, sendDetails({ status: "blocked", reason: resReason }));
}

// ---------------------------------------------------------------- mesh_release

const MESH_RELEASE_PARAMETERS: Record<string, unknown> = {
  type: "object",
  properties: {
    paths: {
      type: "array",
      items: { type: "string" },
      description: "Specific patterns to release. Omit to release ALL reservations.",
    },
  },
};

async function execMeshRelease(
  getRuntime: GetRuntime,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const rt = getRuntime();
  if (rt === null) return textResult("blocked: session_not_started", sendDetails({ status: "blocked", reason: "session_not_started" }));
  const rawPaths = Array.isArray(params.paths)
    ? params.paths.filter((p): p is string => typeof p === "string")
    : undefined;
  const res = await rt.client.release(rawPaths);
  clearReserveTimers(rt, rawPaths); // release cancels pending auto-releases
  if (res.status === "delivered") {
    safeLedger(rt, { event: "released", from: rt.client.alias, refs: res.released.length > 0 ? res.released : undefined });
  // persist the reduced reservation set before returning.
    rt.identity.save(identityFromClient(rt.sessionId, rt.client));
    return textResult(
      res.released.length > 0
        ? `released: ${res.released.join(", ")}`
        : "no reservations to release",
      sendDetails({ status: "delivered", released: res.released }),
    );
  }
  const resReason = "reason" in res ? res.reason : "error";
  return textResult(`blocked: ${resReason}`, sendDetails({ status: "blocked", reason: resReason }));
}

// ---------------------------------------------------------------- registration

export function registerTools(pi: ExtensionAPI, getRuntime: GetRuntime): void {
  pi.registerTool({
    name: "mesh_send",
    label: "Mesh Send",
    description:
      "Send a message to another local agent via the mesh broker. " +
      "Statuses are honest: delivered = written on the recipient socket (or " +
      "queued_offline in its mailbox), never read/answered. awaitReply waits " +
      "for an explicit mesh_reply; otherwise expired after timeoutMs.",
    promptSnippet: "Message another local agent over mesh (delivered ≠ read ≠ answered).",
    promptGuidelines:
      "Use mesh_reply(msgId) to answer an inbound [mesh] message. " +
      "priority=force requires reason and aborts the recipient turn. " +
      "delivered/queued_offline are NOT completions. " +
      "LAUNCH sends (awaitReply + block:false) return immediately — each " +
      "answer then arrives as a [mesh] reply event that wakes the session; " +
      "call mesh_wait_all only when you must collect the whole batch before " +
      "continuing. " +
      "An 'expired' awaitReply is NOT a lost message: late replies are " +
      "delivered and injected automatically — do not re-send the request, " +
      "check mesh_history first. " +
      "replyTo: [aliases] designates who receives the reply instead of you " +
      "(include yourself to also get the answer, e.g. with awaitReply).",
    parameters: MESH_SEND_PARAMETERS,
    execute: (_toolCallId, params, signal, _onUpdate, _ctx) => execMeshSend(getRuntime, params, signal),
  });

  pi.registerTool({
    name: "mesh_reply",
    label: "Mesh Reply",
    description:
      "Reply to an inbound mesh message by exact msgId (strict correlation). " +
      "This is the way to answer inbound [mesh] messages. " +
      "Refused with reply_without_target when the msgId is not in the local inbox.",
    promptSnippet: "Reply to a mesh message by msgId.",
    promptGuidelines:
      "Only msgIds seen in inbound [mesh] messages are valid targets. " +
      "Replies interrupt the recipient (steer). If the result warns " +
      "'already replied', you already answered this msgId — do not re-answer. " +
      "By default the reply goes to the original sender — or to the alias(es) " +
      "the sender designated with replyTo (shown as 'reply goes to @X' on the " +
      "inbound message). Override with to: (single) or replyAll: true (room).",
    parameters: MESH_REPLY_PARAMETERS,
    execute: (_toolCallId, params, _signal, _onUpdate, _ctx) => execMeshReply(getRuntime, params),
  });

  pi.registerTool({
    name: "mesh_status",
    label: "Mesh Status",
    description:
      "Real-time snapshot from the broker (status_req): online peers, rooms. " +
      "Presence is observed (live sockets), never a file registry.",
    promptSnippet: "Show online mesh peers and rooms.",
    parameters: MESH_STATUS_PARAMETERS,
    execute: (_toolCallId, params, _signal, _onUpdate, _ctx) => execMeshStatus(getRuntime, params),
  });

  pi.registerTool({
    name: "mesh_history",
    label: "Mesh History",
    description:
      "Last frames from the local in-memory ring buffer (debug). " +
      "Memory only — never the ledger.",
    promptSnippet: "Show recent mesh frames (memory ring, debug).",
    parameters: MESH_HISTORY_PARAMETERS,
    execute: (_toolCallId, params, _signal, _onUpdate, _ctx) =>
      Promise.resolve(execMeshHistory(getRuntime, params)),
  });

  pi.registerTool({
    name: "mesh_wait_all",
    label: "Mesh Wait All",
    description:
      "Block this turn until EVERY mission sent with awaitReply:true is answered " +
      "(or timeout), then return the group summary — who answered, who is missing. " +
      "The honest alternative to sleep-while-waiting: no wasted tokens, no polling.",
    promptSnippet: "Wait for all pending mission replies and get the summary.",
    parameters: MESH_WAIT_ALL_PARAMETERS,
    execute: (_toolCallId, params, signal, _onUpdate, _ctx) => execMeshWaitAll(getRuntime, params, signal),
  });

  pi.registerTool({
    name: "mesh_ledger",
    label: "Mesh Ledger",
    description:
      "Durable mesh history from the hash-only ledger (bodies never stored, I1). " +
      "Filter by sender/recipient/room/event. Use this instead of mesh_history " +
      "for anything older than the in-memory ring.",
    promptSnippet: "Query the durable mesh ledger.",
    parameters: MESH_LEDGER_PARAMETERS,
    execute: (_toolCallId, params, _signal, _onUpdate, _ctx) =>
      Promise.resolve(execMeshLedger(getRuntime, params)),
  });

  pi.registerTool({
    name: "mesh_reserve",
    label: "Mesh Reserve",
    description:
      "Reserve files/directories so other agents' edit/write tools get blocked " +
      "on them. Trailing '/' reserves a subtree. Reservations expire for " +
      "conflict checks after reservationTtlMs (default 6 h) — re-reserve to " +
      "renew. autoReleaseMs bounds a run: the claim self-releases. Peers are " +
      "notified immediately; use mesh_release when done.",
    promptSnippet: "Claim files before editing to avoid concurrent edits.",
    promptGuidelines:
      "Reserve before editing a shared file, release when done. " +
      "mesh_release({}) releases everything. Long run (>4 h)? Re-reserve " +
      "periodically or set autoReleaseMs.",
    parameters: MESH_RESERVE_PARAMETERS,
    execute: (_toolCallId, params, _signal, _onUpdate, _ctx) => execMeshReserve(getRuntime, params),
  });

  pi.registerTool({
    name: "mesh_release",
    label: "Mesh Release",
    description:
      "Release reservations. Omit paths to release all. " +
      "Peers are notified immediately.",
    promptSnippet: "Release claimed files.",
    parameters: MESH_RELEASE_PARAMETERS,
    execute: (_toolCallId, params, _signal, _onUpdate, _ctx) => execMeshRelease(getRuntime, params),
  });
}

export { MAX_BODY_BYTES };
