// register-tools.ts — register the eight mesh tools with OpenCode.
//
// Two registration paths, one execution core:
//  - V2 (`ctx.tool.transform`): JSON-Schema `input`, the execute callback
//    receives a Record<string, unknown> plus a V2 execution context.
//  - V1 (`Hooks.tool`): zod `args` shape, the execute callback receives
//    typed args (the V1 ToolDefinition is zod-based).
// Both paths share `runTool` so behaviour cannot drift.
//
// zod is loaded LAZILY (dynamic import in applyMeshToolsV1): the V2 path —
// every current OpenCode — never touches it, so the published package keeps
// its zero-runtime-dependency contract. A legacy V1 host without zod
// installed simply gets no mesh tool map (the observation hooks still run).
import type { ToolContext } from "@opencode-ai/plugin";
import type { ToolDefinition as V1ToolDefinition } from "@opencode-ai/plugin";
import type { MeshSessionRuntime } from "./client-runtime.js";
import { buildFrame, normalizeAlias, type MeshFrame } from "../protocol/envelope.js";
import { sha256 } from "../protocol/frames.js";
import { DEFAULT_AWAIT_REPLY_TIMEOUT_MS } from "../shared/config.js";
import { busyTargetWarning, checkSendTarget } from "../extension/tools.js";
import { REPLY_REPEAT_WARNING } from "../extension/guards.js";
import type { MeshLedger } from "../extension/ledger.js";
import type {
  V2ToolDefinition,
  V2ToolEditor,
  V2ToolExecutionContext,
} from "./v2-surface.js";

/** The text result handed back to the model, plus optional metadata. */
export interface ToolOutcome {
  /** The message content shown to the model. */
  content: string;
  metadata?: Record<string, unknown>;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
function bool(v: unknown): boolean | undefined {
  return v === true;
}
function strArr(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string");
  return out.length > 0 ? out : undefined;
}

function textResult(text: string, metadata?: Record<string, unknown>): ToolOutcome {
  return { content: text, metadata };
}

// ---------------------------------------------------------------------------
// Shared execution core
// ---------------------------------------------------------------------------

type Signal = AbortSignal | undefined;

/** Resolve (or create) the runtime of the invoking session. */
export type EnsureRuntime = (sessionID: string) => Promise<MeshSessionRuntime>;

async function ensureRuntime(
  ensure: EnsureRuntime,
  sessionID: string,
): Promise<MeshSessionRuntime> {
  const runtime = await ensure(sessionID);
  // First-call race: a freshly attached runtime's initial connect() may
  // still be in flight — drive/await it (memoized inside the client, so a
  // concurrent connect shares the same promise) before the tool answers.
  // Without this, the FIRST mesh tool call of a session occasionally
  // returned broker_unavailable (observed live). Pi retries connect the
  // same way before giving up.
  if (!runtime.client.isOnline()) {
    try {
      await runtime.client.connect();
    } catch {
      // still offline → each tool answers blocked: broker_unavailable
    }
  }
  return runtime;
}

/** Best-effort ledger append — a ledger failure never breaks a tool call. */
function safeLedger(
  runtime: MeshSessionRuntime,
  input: Parameters<MeshLedger["append"]>[0],
): void {
  try {
    runtime.ledger.append(input);
  } catch {
    runtime.ledgerFailures += 1;
  }
}

/** Best-effort transcript record (opt-in) — same contract. */
function safeTranscript(
  runtime: MeshSessionRuntime,
  direction: "out",
  frame: MeshFrame,
): void {
  try {
    runtime.transcript.record(direction, frame);
  } catch {
    runtime.transcriptFailures += 1;
  }
}

async function execMeshSend(
  ensure: EnsureRuntime,
  sessionID: string,
  params: Record<string, unknown>,
  signal: Signal,
): Promise<ToolOutcome> {
  const runtime = await ensureRuntime(ensure, sessionID);
  const message = str(params.message);
  if (message === undefined) {
    return textResult("error: invalid_frame (message is required)");
  }
  const broadcast = params.broadcast === true;
  const toRaw = str(params.to);
  if (!broadcast && toRaw === undefined) {
    return textResult("error: invalid_frame (to is required unless broadcast: true)");
  }
  if (broadcast && toRaw !== undefined) {
    return textResult("error: broadcast_with_to (omit 'to' when broadcasting)");
  }
  // '*' = broadcast target (mirrors the Pi tool); normalized for guards.
  const to = toRaw !== undefined ? normalizeAlias(toRaw) : "*";
  // Room resolution mirrors the client: explicit room wins; otherwise
  // "default" when still joined, else the FIRST joined room.
  const targetRoom =
    str(params.room) ??
    (runtime.client.rooms.includes("default") ? "default" : runtime.client.rooms[0] ?? "default");
  const priority = (str(params.priority) ?? "normal") as
    | "normal"
    | "urgent"
    | "force";
  const reason = str(params.reason);
  const interrupt = params.interrupt === true;
  const awaitReply = params.awaitReply === true;
  const block = params.block === false ? false : true;
  const launch = awaitReply && !block; // track + return immediately
  const timeoutMs = num(params.timeoutMs);
  const refs = strArr(params.refs);
  const replyTo = parseReplyTo(params.replyTo);
  const bodyHash = sha256(message);
  const reasonHash = priority === "force" && reason !== undefined ? sha256(reason) : undefined;

  // M1 target validation + M2 busy-target warning — BEFORE any round-trip
  // (same helpers as the Pi tool: to:"*" and room-broadcast pseudo-targets
  // are doomed; a busy-for-longer-than-timeout target is a near-certain
  // expiry). Soft warnings never block a send.
  const warnings: string[] = [];
  if (!broadcast) {
    const check = checkSendTarget(
      to,
      (alias) => runtime.client.knowsPeer(alias),
      runtime.client.knownPeerList.length,
    );
    if (check.error !== undefined) {
      safeLedger(runtime, {
        event: "blocked", from: runtime.client.alias, to, room: targetRoom,
        priority, bodyHash, reasonHash, refs, code: check.error,
      });
      return textResult(`blocked: ${check.error} — ${check.hint ?? ""}`, { reason: check.error });
    }
    if (check.warning !== undefined) warnings.push(check.warning);
    if (awaitReply) {
      const busyWarn = busyTargetWarning(
        to,
        runtime.client.busyForMs(to),
        timeoutMs ?? DEFAULT_AWAIT_REPLY_TIMEOUT_MS,
      );
      if (busyWarn !== undefined) warnings.push(busyWarn);
    }
  }

  // Send guards (self-send, duplicate window, caps, loop) — BEFORE any
  // broker round-trip. Pi parity: guard failures are ledgered.
  const guard = runtime.guards.checkSend({
    from: runtime.client.alias,
    to,
    room: targetRoom,
    body: message,
    priority,
  });
  if (!guard.ok) {
    safeLedger(runtime, {
      event: "blocked", from: runtime.client.alias, to, room: targetRoom,
      priority, bodyHash, reasonHash, refs, code: guard.reason,
    });
    return textResult(`blocked: ${guard.reason}`, { reason: guard.reason });
  }
  warnings.push(...guard.warnings);

  if (!runtime.client.isOnline()) {
    // broker absent → retry the (memoized) connect once, then answer honestly.
    try {
      await runtime.client.connect();
    } catch {
      safeLedger(runtime, {
        event: "blocked", from: runtime.client.alias, to, room: targetRoom,
        priority, bodyHash, refs, code: "broker_unavailable",
      });
      return textResult("blocked: broker_unavailable", { reason: "broker_unavailable" });
    }
  }

  // Transcript: outbound frame WITH body (redacted at record time) — opt-in.
  if (runtime.transcript.isEnabled()) {
    safeTranscript(
      runtime,
      "out",
      buildFrame({
        type: "msg", from: runtime.client.alias, to, room: targetRoom, priority,
        body: message, refs, broadcast: broadcast ? true : undefined,
      }),
    );
  }
  // Causal anchoring: 'sent' is ledgered BEFORE the network call (Pi parity).
  safeLedger(runtime, {
    event: "sent", from: runtime.client.alias, to, room: targetRoom,
    priority, bodyHash, reasonHash, refs,
    code: broadcast ? "broadcast" : undefined,
  });

  const res = await runtime.client.send({
    to: broadcast ? undefined : to,
    message,
    room: targetRoom,
    priority,
    reason,
    awaitReply,
    block,
    timeoutMs,
    refs,
    broadcast,
    replyTo,
    interrupt,
    // a launch-mode mission survives the calling turn's end
    signal: !launch && signal !== undefined ? signal : undefined,
  });

  // `delivered` is ledgered ONLY here — after the broker ack (client.send
  // resolves delivered exclusively post-ack). Full status set = Pi parity.
  const msgId = "msgId" in res ? res.msgId : undefined;
  const cast =
    broadcast && "deliveredCount" in res
      ? `broadcast:${res.deliveredCount ?? 0}/${"totalCount" in res ? res.totalCount ?? 0 : 0}`
      : undefined;
  switch (res.status) {
    case "delivered":
      safeLedger(runtime, { event: "delivered", id: msgId, from: runtime.client.alias, to, room: targetRoom, priority, bodyHash, reasonHash, refs, code: cast });
      break;
    case "queued_offline":
      safeLedger(runtime, { event: "queued_offline", id: msgId, from: runtime.client.alias, to, room: targetRoom, priority, bodyHash, reasonHash, refs, code: cast });
      break;
    case "reply":
      safeLedger(runtime, { event: "reply", id: msgId, from: runtime.client.alias, to, room: targetRoom, priority, bodyHash, refs, code: "outputHash" in res ? res.outputHash : undefined });
      break;
    case "expired":
      safeLedger(runtime, { event: "expired", id: msgId, from: runtime.client.alias, to, room: targetRoom, priority, bodyHash, refs, code: "expired" });
      break;
    case "blocked":
      safeLedger(runtime, { event: "blocked", id: msgId, from: runtime.client.alias, to, room: targetRoom, priority, bodyHash, refs, code: res.reason });
      break;
    default:
      safeLedger(runtime, { event: "error", id: msgId, from: runtime.client.alias, to, room: targetRoom, priority, bodyHash, refs, code: "reason" in res ? res.reason : "error" });
      break;
  }
  return describeOutcome(res, warnings, {
    msgId,
    to,
    room: targetRoom,
    priority,
    broadcast: broadcast || undefined,
    reason: "reason" in res ? res.reason : undefined,
  });
}

function parseReplyTo(v: unknown): string[] | undefined {
  if (Array.isArray(v)) {
    const out = v.filter((x): x is string => typeof x === "string");
    return out.length > 0 ? out : undefined;
  }
  if (typeof v === "string" && v !== "") return [v];
  return undefined;
}

function describeOutcome(
  res: Awaited<ReturnType<MeshSessionRuntime["client"]["send"]>>,
  warnings: string[],
  detail: Record<string, unknown>,
): ToolOutcome {
  const msgId =
    "msgId" in res && typeof res.msgId === "string" ? res.msgId : undefined;
  let text: string;
  switch (res.status) {
    case "delivered":
      text = `delivered${msgId !== undefined ? ` (m_${msgId})` : ""}`;
      break;
    case "queued_offline":
      text = "queued_offline (the target's session is not running)";
      break;
    case "reply":
      text = `replied to m_${msgId ?? "?"}`;
      break;
    case "expired":
      text = "expired (awaitReply timeout)";
      break;
    case "blocked":
      text = `blocked: ${res.reason}`;
      break;
    default:
      text = `error: ${res.reason}`;
  }
  const warn = warnings.length > 0 ? ` — ⚠ ${warnings.join("; ")}` : "";
  return textResult(`${text}${warn}`, detail);
}

async function execMeshReply(
  ensure: EnsureRuntime,
  sessionID: string,
  params: Record<string, unknown>,
  _signal: Signal,
): Promise<ToolOutcome> {
  const runtime = await ensureRuntime(ensure, sessionID);
  const msgId = str(params.msgId);
  const message = str(params.message);
  if (msgId === undefined || message === undefined) {
    return textResult("error: invalid_frame (msgId and message are required)");
  }
  const toRaw = str(params.to);
  const replyAll = params.replyAll === true;
  const refs = strArr(params.refs);
  if (replyAll && toRaw !== undefined) {
    return textResult("error: reply_all_with_to (replyAll and to are mutually exclusive)");
  }
  const bodyHash = sha256(message);

  if (!runtime.client.isOnline()) {
    // broker absent → retry the (memoized) connect once, then answer honestly.
    try {
      await runtime.client.connect();
    } catch {
      return textResult("blocked: broker_unavailable");
    }
  }

  // Peek the original BEFORE reply — read-only, and safe against any
  // future inbox eviction during the round-trip. An unknown msgId is
  // refused BEFORE the network call, so no 'sent' record is ever ledgered
  // for a blocked reply (Pi parity).
  const orig = runtime.client.peekInbox(msgId);
  if (orig === undefined || orig.from === undefined) {
    safeLedger(runtime, {
      event: "blocked", id: msgId, from: runtime.client.alias,
      bodyHash, refs, code: "reply_without_target",
    });
    return textResult("blocked: reply_without_target (use the exact msgId from an inbound message)");
  }
  // causal anchoring: 'sent' is ledgered BEFORE the network call,
  // enriched with to/room/priority from the peeked original.
  safeLedger(runtime, {
    event: "sent", from: runtime.client.alias, to: toRaw ?? orig.from,
    room: orig.room, priority: orig.priority, bodyHash, refs,
    code: replyAll ? "reply_all" : toRaw !== undefined ? "reply_to" : undefined,
  });
  // flag re-replies to the same msgId (warning only — never blocks)
  const replyGuard = runtime.guards.checkReply(msgId);
  const res = await runtime.client.reply(msgId, message, {
    refs,
    to: toRaw,
    replyAll,
  });
  if (res.status === "error" && res.reason === "reply_without_target") {
    // defense in depth: inbox eviction between peek and reply.
    safeLedger(runtime, {
      event: "blocked", id: msgId, from: runtime.client.alias,
      bodyHash, refs, code: "reply_without_target",
    });
    return textResult("blocked: reply_without_target (use the exact msgId from an inbound message)");
  }
  if (runtime.transcript.isEnabled()) {
    safeTranscript(
      runtime,
      "out",
      buildFrame({
        type: "reply", from: runtime.client.alias, to: toRaw, room: orig.room,
        replyTo: msgId, body: message, refs, replyAll: replyAll ? true : undefined,
      }),
    );
  }
  safeLedger(runtime, {
    event: res.status === "delivered" ? "delivered" : "error",
    id: "msgId" in res ? res.msgId : msgId,
    from: runtime.client.alias,
    to: toRaw ?? orig.from,
    room: orig.room,
    priority: orig.priority,
    bodyHash,
    refs,
    code:
      res.status !== "delivered"
        ? "reason" in res
          ? res.reason
          : "error"
        : replyAll && "deliveredCount" in res
          ? `reply_all:${res.deliveredCount ?? 0}/${"totalCount" in res ? res.totalCount ?? 0 : 0}`
          : toRaw !== undefined
            ? "reply_to"
            : undefined
  });
  const repeatWarn = replyGuard.warnings.includes(REPLY_REPEAT_WARNING);
  return describeOutcome(
    res,
    repeatWarn ? ["already replied to this msgId recently (check before re-answering)"] : [],
    {
      replyTo: msgId,
      to: toRaw ?? orig.from,
      room: orig.room,
      priority: orig.priority,
      replyAll: replyAll || undefined,
    },
  );
}

async function execMeshStatus(
  ensure: EnsureRuntime,
  sessionID: string,
  params: Record<string, unknown>,
): Promise<ToolOutcome> {
  const runtime = await ensureRuntime(ensure, sessionID);
  if (!runtime.client.isOnline()) {
    return textResult("blocked: broker_unavailable");
  }
  const room = str(params.room);
  const all = params.all === true;
  const snap = await runtime.client.status(room);
  const mine = new Set<string>(
    room !== undefined ? [room] : [...runtime.client.rooms],
  );
  // `all` shows the whole broker; the default view stays room-scoped.
  const peers = all
    ? snap.peers
    : snap.peers.filter(
        (p) =>
          p.alias === runtime.client.alias ||
          mine.size === 0 ||
          p.rooms.some((r) => mine.has(r)),
      );
  const lines = [
    `mesh status — alias @${runtime.client.alias}${room !== undefined ? ` room=${room}` : ""}${all ? " all" : ""}`,
    `peers (${peers.length}):`,
    ...peers.map((p) => {
      const state = p.activity?.state;
      const tag =
        state === "busy"
          ? " ● working"
          : state === "rate_limited"
            ? " ⛔ rate-limited"
            : state === "blocked"
              ? " ✖ blocked"
              : " ○ idle";
      return `  @${p.alias} rooms=${p.rooms.join(",")}${tag}`;
    }),
    `mesh rooms: ${snap.rooms.length > 0 ? snap.rooms.join(", ") : "(none)"}`,
  ];
  return textResult(lines.join("\n"));
}

async function execMeshHistory(
  ensure: EnsureRuntime,
  sessionID: string,
  params: Record<string, unknown>,
): Promise<ToolOutcome> {
  const runtime = await ensureRuntime(ensure, sessionID);
  const limit = Math.min(100, Math.max(1, num(params.limit) ?? 20));
  if (!runtime.client.isOnline()) {
    return textResult("blocked: broker_unavailable");
  }
  const frames = runtime.client.transcript.slice(-limit);
  const lines = frames.map((f) => {
    const body = f.body !== undefined ? ` ${f.body}` : "";
    return `${f.ts} ${f.type} ${f.from ?? "?"}→${f.to ?? "*"}${body}`;
  });
  return textResult(lines.length > 0 ? lines.join("\n") : "(empty history)");
}

async function execMeshWaitAll(
  ensure: EnsureRuntime,
  sessionID: string,
  params: Record<string, unknown>,
  signal: Signal,
): Promise<ToolOutcome> {
  const runtime = await ensureRuntime(ensure, sessionID);
  if (!runtime.client.isOnline()) {
    return textResult("blocked: broker_unavailable");
  }
  const timeoutMs = Math.min(1_800_000, Math.max(25, num(params.timeoutMs) ?? 300_000));
  const res = await runtime.client.waitAll(timeoutMs, signal);
  const head = `wait_all: ${res.answered}/${res.total} answered after ${Math.round(res.elapsedMs / 1000)}s`;
  const lines = [head];
  for (const a of res.answers) {
    lines.push(`  ✓ @${a.to}: ${a.response.replace(/\s+/g, " ").trim().slice(0, 140)}`);
  }
  for (const m of res.missing) {
    lines.push(`  ✗ @${m.to}: NOT ANSWERED (${m.msgId.slice(0, 18)})`);
  }
  if (res.total === 0) {
    lines.push("  (no awaited missions — send with awaitReply: true first)");
  }
  return textResult(lines.join("\n"));
}

async function execMeshLedger(
  ensure: EnsureRuntime,
  sessionID: string,
  params: Record<string, unknown>,
): Promise<ToolOutcome> {
  const runtime = await ensureRuntime(ensure, sessionID);
  if (!runtime.client.isOnline()) {
    return textResult("blocked: broker_unavailable");
  }
  const limit = Math.min(200, Math.max(1, num(params.limit) ?? 20));
  const records = runtime.ledger.read(limit, {
    from: str(params.from),
    to: str(params.to),
    room: str(params.room),
    event: str(params.event),
  });
  if (records.length === 0) {
    return textResult("(no ledger records matching)");
  }
  const lines = records.map((r) => {
    const id = r.id !== undefined ? ` ${r.id.slice(0, 18)}` : "";
    return `${r.ts.slice(11, 19)} ${r.event}${id} ${r.from ?? "?"}→${r.to ?? "*"}${r.room !== undefined ? ` @${r.room}` : ""}${r.code !== undefined ? ` [${r.code}]` : ""}`;
  });
  return textResult(lines.join("\n"));
}

async function execMeshReserve(
  ensure: EnsureRuntime,
  sessionID: string,
  params: Record<string, unknown>,
): Promise<ToolOutcome> {
  const runtime = await ensureRuntime(ensure, sessionID);
  const rawPaths = Array.isArray(params.paths)
    ? params.paths.filter((p): p is string => typeof p === "string")
    : [];
  if (rawPaths.length === 0) {
    return textResult("error: invalid_pattern (paths required)");
  }
  const reason = str(params.reason);
  const autoReleaseMs = num(params.autoReleaseMs);
  if (!runtime.client.isOnline()) {
    return textResult("blocked: broker_unavailable");
  }
  const res = await runtime.client.reserve(rawPaths, reason);
  if (res.status !== "delivered") {
    const reason = "reason" in res ? res.reason : "error";
    return textResult(`blocked: ${reason}`);
  }
  if (autoReleaseMs !== undefined) {
    armReserveTimers(runtime, rawPaths, autoReleaseMs);
  }
  return textResult(`reserved ${rawPaths.length} path(s) — peers notified`);
}

async function execMeshRelease(
  ensure: EnsureRuntime,
  sessionID: string,
  params: Record<string, unknown>,
): Promise<ToolOutcome> {
  const runtime = await ensureRuntime(ensure, sessionID);
  const rawPaths = Array.isArray(params.paths)
    ? params.paths.filter((p): p is string => typeof p === "string")
    : undefined;
  if (!runtime.client.isOnline()) {
    return textResult("blocked: broker_unavailable");
  }
  const res = await runtime.client.release(rawPaths);
  if (res.status !== "delivered") {
    const reason = "reason" in res ? res.reason : "error";
    return textResult(`blocked: ${reason}`);
  }
  const released = "released" in res ? res.released : [];
  return textResult(
    released.length > 0
      ? `released: ${released.join(", ")}`
      : "no reservations to release",
  );
}

/** Fire-and-forget auto-release timer (mesh_reserve autoReleaseMs). Never throws. */
function armReserveTimers(
  runtime: MeshSessionRuntime,
  patterns: string[],
  ms: number,
): void {
  for (const pattern of patterns) {
    const timer = setTimeout(() => {
      void runtime.client.release([pattern]).catch(() => {});
    }, ms);
    timer.unref();
    runtime.armAutoRelease(pattern, timer);
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

interface MeshToolSpec {
  name: string;
  description: string;
  /** JSON Schema describing the tool input (V2 registration). */
  input: {
    type: "object";
    properties: Record<string, unknown>;
    required: readonly string[];
    additionalProperties: false;
  };
  /** Zod raw shape builder for the V1 registration (zod loaded lazily). */
  v1Shape: (z: typeof import("zod").z) => Record<string, unknown>;
  /** Executed with (params, signal, context) — the context carries the
   *  invoking sessionID, which decides which mesh runtime is used. */
  execute: (
    params: Record<string, unknown>,
    signal: Signal,
    context: { sessionID: string },
  ) => Promise<ToolOutcome>;
}

const DESCRIPTIONS: {
  mesh_send: string;
  mesh_reply: string;
  mesh_status: string;
  mesh_history: string;
  mesh_wait_all: string;
  mesh_ledger: string;
  mesh_reserve: string;
  mesh_release: string;
} = {
  mesh_send:
    "Send a message to another local agent via the mesh broker. " +
    "Statuses are honest: delivered = written on the recipient socket (or " +
    "queued_offline in its mailbox), never read/answered. awaitReply waits " +
    "for an explicit mesh_reply; otherwise expired after timeoutMs.",
  mesh_reply:
    "Reply to an inbound mesh message by exact msgId (strict correlation). " +
    "This is the way to answer inbound [mesh] messages. " +
    "Refused with reply_without_target when the msgId is not in the local inbox.",
  mesh_status:
    "Real-time snapshot from the broker (status_req): online peers, rooms. " +
    "Presence is observed (live sockets), never a file registry.",
  mesh_history:
    "Last frames from the local in-memory ring buffer (debug). " +
    "Memory only — never the ledger.",
  mesh_wait_all:
    "Block this turn until EVERY mission sent with awaitReply:true is answered " +
    "(or timeout), then return the group summary — who answered, who is missing. " +
    "The honest alternative to sleep-while-waiting: no wasted tokens, no polling.",
  mesh_ledger:
    "Durable mesh history from the hash-only ledger (bodies never stored). " +
    "Filter by sender/recipient/room/event. Use this instead of mesh_history " +
    "for anything older than the in-memory ring.",
  mesh_reserve:
    "Reserve files/directories so other agents' edit/write tools get blocked " +
    "on them. Trailing '/' reserves a subtree. Reservations expire for " +
    "conflict checks after reservationTtlMs — re-reserve to renew.",
  mesh_release:
    "Release reservations. Omit paths to release all. " +
    "Peers are notified immediately.",
};

type JsonSchemaObject = {
  type: "object";
  properties: Record<string, unknown>;
  required: readonly string[];
  additionalProperties: false;
};

function buildInputSchema(
  properties: Record<string, unknown>,
  required: readonly string[],
): JsonSchemaObject {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}
function buildSpecs(ensure: EnsureRuntime): MeshToolSpec[] {
  return [
    {
      name: "mesh_send",
      description: DESCRIPTIONS.mesh_send,
      input: buildInputSchema(
        {
          to: {
            type: "string",
            description:
              "Target alias ('@' tolerated, case-insensitive). OMIT when broadcast: true.",
          },
          message: { type: "string", description: "Message body (1..32 KiB)." },
          room: {
            type: "string",
            description:
              "Room id. Default: 'default' when still joined, else your first joined room.",
          },
          broadcast: {
            type: "boolean",
            description: "Fan out to EVERY member of room (to must be omitted).",
          },
          priority: {
            type: "string",
            enum: ["normal", "urgent", "force"],
            description: "normal→queued, urgent→steer, force→abort+steer (requires reason).",
          },
          interrupt: {
            type: "boolean",
            description:
              "With priority=force: abort the recipient's BLOCKED turn so this " +
              "message lands with priority. Last resort — requires reason.",
          },
          reason: {
            type: "string",
            description: "Required when priority=force. Hashed, never persisted.",
          },
          awaitReply: { type: "boolean", description: "Wait for an explicit mesh_reply (default false)." },
          block: {
            type: "boolean",
            description:
              "with awaitReply — false = launch mode: return immediately and " +
              "track the mission; call mesh_wait_all for the group verdict.",
          },
          timeoutMs: {
            type: "number",
            description: "awaitReply timeout in ms.",
          },
          refs: {
            type: "array",
            items: { type: "string" },
            description: "Repo-relative reference paths (≤ 8).",
          },
          replyTo: {
            type: "array",
            items: { type: "string" },
            description: "Alias(es) that should receive the reply instead of the sender.",
          },
        },
        ["message"],
      ),
      v1Shape: (z) => ({
        to: z.string().optional(),
        message: z.string(),
        room: z.string().optional(),
        broadcast: z.boolean().optional(),
        priority: z.enum(["normal", "urgent", "force"]).optional(),
        interrupt: z.boolean().optional(),
        reason: z.string().optional(),
        awaitReply: z.boolean().optional(),
        block: z.boolean().optional(),
        timeoutMs: z.number().optional(),
        refs: z.array(z.string()).max(8).optional(),
        replyTo: z.array(z.string()).max(8).optional(),
      }),
      execute: (params, signal, context) =>
        execMeshSend(ensure, context.sessionID, params, signal),
    },
    {
      name: "mesh_reply",
      description: DESCRIPTIONS.mesh_reply,
      input: buildInputSchema(
        {
          msgId: { type: "string", description: "Exact msgId of an inbound message." },
          message: { type: "string", description: "Reply body (1..32 KiB)." },
          to: { type: "string", description: "Override the reply target." },
          replyAll: { type: "boolean", description: "Fan the answer out to the whole room." },
          refs: { type: "array", items: { type: "string" } },
        },
        ["msgId", "message"],
      ),
      v1Shape: (z) => ({
        msgId: z.string(),
        message: z.string(),
        to: z.string().optional(),
        replyAll: z.boolean().optional(),
        refs: z.array(z.string()).optional(),
      }),
      execute: (params, signal, context) =>
        execMeshReply(ensure, context.sessionID, params, signal),
    },
    {
      name: "mesh_status",
      description: DESCRIPTIONS.mesh_status,
      input: buildInputSchema(
        {
          room: { type: "string", description: "Restrict the snapshot to one room." },
          all: { type: "boolean", description: "Show every peer of the mesh." },
        },
        [],
      ),
      v1Shape: (z) => ({
        room: z.string().optional(),
        all: z.boolean().optional(),
      }),
      execute: (params, _signal, context) =>
        execMeshStatus(ensure, context.sessionID, params),
    },
    {
      name: "mesh_history",
      description: DESCRIPTIONS.mesh_history,
      input: buildInputSchema(
        {
          limit: { type: "number", description: "Max frames (default 20)." },
          withBodies: { type: "boolean", description: "Include bodies." },
        },
        [],
      ),
      v1Shape: (z) => ({
        limit: z.number().optional(),
        withBodies: z.boolean().optional(),
      }),
      execute: (params, _signal, context) =>
        execMeshHistory(ensure, context.sessionID, params),
    },
    {
      name: "mesh_wait_all",
      description: DESCRIPTIONS.mesh_wait_all,
      input: buildInputSchema(
        {
          timeoutMs: { type: "number", description: "How long to wait for all answers." },
        },
        [],
      ),
      v1Shape: (z) => ({
        timeoutMs: z.number().optional(),
      }),
      execute: (params, signal, context) =>
        execMeshWaitAll(ensure, context.sessionID, params, signal),
    },
    {
      name: "mesh_ledger",
      description: DESCRIPTIONS.mesh_ledger,
      input: buildInputSchema(
        {
          limit: { type: "number", description: "Max records (default 20)." },
          from: { type: "string", description: "Filter: sender alias." },
          to: { type: "string", description: "Filter: recipient alias." },
          room: { type: "string", description: "Filter: room." },
          event: { type: "string", description: "Filter: sent | delivered | …" },
        },
        [],
      ),
      v1Shape: (z) => ({
        limit: z.number().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        room: z.string().optional(),
        event: z.string().optional(),
      }),
      execute: (params, _signal, context) =>
        execMeshLedger(ensure, context.sessionID, params),
    },
    {
      name: "mesh_reserve",
      description: DESCRIPTIONS.mesh_reserve,
      input: buildInputSchema(
        {
          paths: {
            type: "array",
            items: { type: "string" },
            description: "Paths to reserve (trailing '/' reserves a subtree).",
          },
          reason: { type: "string", description: "Why you reserve them." },
          autoReleaseMs: {
            type: "number",
            description: "Auto-release after this long (fire-and-forget).",
          },
        },
        ["paths"],
      ),
      v1Shape: (z) => ({
        paths: z.array(z.string()).min(1),
        reason: z.string().optional(),
        autoReleaseMs: z.number().optional(),
      }),
      execute: (params, _signal, context) =>
        execMeshReserve(ensure, context.sessionID, params),
    },
    {
      name: "mesh_release",
      description: DESCRIPTIONS.mesh_release,
      input: buildInputSchema(
        {
          paths: {
            type: "array",
            items: { type: "string" },
            description: "Specific patterns to release. Omit to release ALL.",
          },
        },
        [],
      ),
      v1Shape: (z) => ({
        paths: z.array(z.string()).optional(),
      }),
      execute: (params, _signal, context) =>
        execMeshRelease(ensure, context.sessionID, params),
    },
  ];
}

/** Register the mesh tools with a V2 editor (ctx.tool.transform). */
export function applyMeshTools(
  editor: V2ToolEditor,
  ensure: EnsureRuntime,
): void {
  for (const spec of buildSpecs(ensure)) {
    const execute = (
      input: Record<string, unknown>,
      context: V2ToolExecutionContext,
    ): Promise<ToolOutcome> =>
      runSpec(spec, context.sessionID, input, context.abort, ensure);
    editor.add({
      name: spec.name,
      description: spec.description,
      input: spec.input,
      execute,
    });
  }
}

/** Register the mesh tools with the legacy V1 Hooks object.
 *
 * zod is loaded HERE, lazily: the V2 path (every current OpenCode) never
 * imports it, keeping the published package free of runtime dependencies.
 * A legacy host without zod gets no mesh tool map — the observation hooks
 * keep working; the promise resolves regardless so `server()` never throws.
 */
export async function applyMeshToolsV1(
  hooks: { tool?: Record<string, V1ToolDefinition> },
  ensure: EnsureRuntime,
): Promise<void> {
  let z: typeof import("zod").z;
  try {
    z = (await import("zod")).z;
  } catch {
    return; // zod unavailable — V1 tool map silently unavailable
  }
  const map: Record<string, V1ToolDefinition> = {};
  for (const spec of buildSpecs(ensure)) {
    map[spec.name] = {
      description: spec.description,
      args: spec.v1Shape(z) as V1ToolDefinition["args"],
      execute: async (args, context: ToolContext) => {
        const outcome = await runSpec(
          spec,
          context.sessionID,
          args as Record<string, unknown>,
          context.abort,
          ensure,
        );
        return { output: outcome.content, metadata: outcome.metadata };
      },
    };
  }
  hooks.tool = map;
}

async function runSpec(
  spec: MeshToolSpec,
  sessionID: string,
  params: Record<string, unknown>,
  signal: Signal,
  ensure: EnsureRuntime,
): Promise<ToolOutcome> {
  switch (spec.name) {
    case "mesh_send":
      return execMeshSend(ensure, sessionID, params, signal);
    case "mesh_reply":
      return execMeshReply(ensure, sessionID, params, signal);
    case "mesh_status":
      return execMeshStatus(ensure, sessionID, params);
    case "mesh_history":
      return execMeshHistory(ensure, sessionID, params);
    case "mesh_wait_all":
      return execMeshWaitAll(ensure, sessionID, params, signal);
    case "mesh_ledger":
      return execMeshLedger(ensure, sessionID, params);
    case "mesh_reserve":
      return execMeshReserve(ensure, sessionID, params);
    case "mesh_release":
      return execMeshRelease(ensure, sessionID, params);
    default:
      return Promise.resolve(textResult(`unknown tool ${spec.name}`));
  }
}
