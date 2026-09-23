// client/client.ts — MeshClient: connect/send/reply/status/join/leave/close.
// Pi-independent: emits events; the extension adapter consumes them.
import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import net, { type Socket } from "node:net";
import tls from "node:tls";
import { randomBytes } from "node:crypto";
import {
  buildFrame,
  isValidAlias,
  isValidRefPath,
  isValidReservationPattern,
  isValidRoom,
  normalizeAlias,
  parseFrameLine,
  type FileReservation,
  type MeshFrame,
  type MeshPeerInfo,
  type MeshPriority,
  type MeshRole,
} from "../protocol/envelope.js";
import { encodeFrame, FrameDecoder, sha256 } from "../protocol/frames.js";
import {
  ACK_TIMEOUT_MS,
  ALIAS_RAND_CHARS,
  parseEndpoint,
  DEFAULT_AWAIT_REPLY_TIMEOUT_MS,
  DEFAULT_CONFIG,
  DEFAULT_ROOM,
  HELLO_TIMEOUT_MS,
  MAX_AWAIT_REPLY_TIMEOUT_MS,
  MAX_BODY_BYTES,
  MAX_REFS,
  MAX_REPLY_TARGETS,
  MIN_AWAIT_REPLY_TIMEOUT_MS,
  OUTBOX_FLUSH_CAP,
  STATUS_REQ_TIMEOUT_MS,
  TRANSCRIPT_RING_SIZE,
  type MeshConfig,
} from "../shared/config.js";
import { runtimeDir, stateDir } from "../shared/paths.js";
import { MESH_VERSION } from "../shared/version.js";
import { PendingReplies } from "./pending.js";
import { backoffMs, ensureBroker } from "./reconnect.js";

export interface WelcomeInfo {
  alias: string;
  rooms: string[];
  peers: MeshPeerInfo[];
  mailboxCount: number;
}

export interface StatusSnapshot {
  peers: MeshPeerInfo[];
  rooms: string[];
  /** M2: broker counters (status_res) — relayed/refused/mailbox. */
  stats?: { relayed: number; refused: number; mailboxDelivered: number; mailboxDropped: number };
}

export interface SendOpts {
  to?: string;
  message: string;
  room?: string;
  priority?: MeshPriority;
  reason?: string; // force only — hashed, never persisted 
  awaitReply?: boolean;
  /** with awaitReply — return the delivery result IMMEDIATELY and keep
  *  the mission tracked in the background (reminds, expiry, answered);
  *  mesh_wait_all reports the group verdict later. The general
  *  orchestrator pattern: launch a burst, then wait_all once. */
  block?: boolean;
  timeoutMs?: number;
  refs?: string[];
  /** fan out to every room member (room required, to must be absent). */
  broadcast?: boolean;
  /** aliases that should receive the reply instead of the sender
  *  (default: the sender). Single alias or list — the recipient's
  *  mesh_reply without an explicit `to` goes to ALL of them. Include
  *  yourself if you also want the answer (e.g. with awaitReply). */
  replyTo?: string | string[];
  /** Abort a BLOCKING awaitReply send (ESC): cancels the pending, cleans
   *  the mission, and returns {status:"error", reason:"cancelled"} — a
   *  late reply still arrives via the orphan-inject path. Ignored for
   *  LAUNCH sends (they never block). */
  signal?: AbortSignal;
}

export interface ReplyOpts {
  refs?: string[];
  /** target a different member than the original sender. */
  to?: string;
  /** fan the answer out to the whole room of the original message. */
  replyAll?: boolean;
}

export type SendResult =
  | { status: "delivered"; msgId: string; deliveredCount?: number; totalCount?: number }
  | { status: "queued_offline"; msgId: string; deliveredCount?: number; totalCount?: number }
  | { status: "reply"; msgId: string; response: string; outputHash: string }
  | { status: "expired" | "blocked" | "error"; msgId?: string; reason: string };

export function isBroadcastResult(res: SendResult): res is Extract<SendResult, { deliveredCount?: number }> {
  return res.status === "delivered" || res.status === "queued_offline";
}

// ---- activity status ----

export interface PeerActivityStatus {
  status: "active" | "idle" | "stuck";
  idleFor?: string;
}

export function formatDurationShort(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m${seconds % 60}s`;
  return `${seconds}s`;
}

/**
 * activity status from the broker's lastSeenAt — idle after
 * activityIdleMs, STUCK when idle past activityStuckMs AND holding
 * reservations (a peer with claims that never progresses blocks others).
 */
export function computePeerStatus(
  lastSeenAt: string | undefined,
  hasReservations: boolean,
  idleMs: number,
  stuckMs: number,
  now: number = Date.now(),
): PeerActivityStatus {
  if (lastSeenAt === undefined) return { status: "active" };
  const t = Date.parse(lastSeenAt);
  if (Number.isNaN(t)) return { status: "active" };
  const elapsed = now - t;
  if (elapsed < idleMs) return { status: "active" };
  if (hasReservations && elapsed >= stuckMs) return { status: "stuck", idleFor: formatDurationShort(elapsed) };
  return { status: "idle", idleFor: formatDurationShort(elapsed) };
}

export interface MeshClientOpts {
  alias?: string;
  rooms?: string[];
  /** Reservations to declare at hello (persisted identity reload). */
  initialReservations?: FileReservation[];
  runtimeDir?: string;
  config?: Partial<MeshConfig>;
  onFrame?: (f: MeshFrame) => void;
  /** Disable auto-reconnect (ephemeral CLI clients). */
  noReconnect?: boolean;
}

interface AckWaiter {
  resolve: (frame: MeshFrame) => void;
  timer: NodeJS.Timeout;
}

const BLOCKED_CODES = new Set([
  "policy_denied",
  "rate_limited",
  "peer_not_found",
  "not_member",
  "observer_readonly",
  "force_requires_reason",
]);

/** D39: offline watchdog kick interval (ms). */
const WATCHDOG_INTERVAL_MS = 60_000;

/** alias_taken: retries of the original alias before falling back to random. */
const ALIAS_RETRY_ATTEMPTS = 4;
const ALIAS_RETRY_DELAY_MS = 250;

/** a reply target stays "handled" for 30 min (duplicates dropped). */
const HANDLED_REPLY_WINDOW_MS = 1_800_000;

/** a mission answered within this window and not yet reported by a
 *  wait_all verdict still belongs to the current batch — a fast answer
 *  that resolved BEFORE wait_all was called must still appear in it. */
const RECENT_ANSWER_WINDOW_MS = 300_000; // 5 min

export interface WaitAllSummary {
  status: "complete" | "timeout" | "cancelled";
  total: number;
  answered: number;
  elapsedMs: number;
  missing: { msgId: string; to: string }[];
  answers: { msgId: string; to: string; response: string }[];
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref();
  });
}

function defaultAlias(): string {
  return `agent-${randomBytes(ALIAS_RAND_CHARS / 2).toString("hex").slice(0, ALIAS_RAND_CHARS)}`;
}

export class MeshClient extends EventEmitter {
  /** Current alias — mutable via rename (in-flight alias change). */
  private aliasInternal: string;
  private readonly initialRooms: string[];
  /** All rooms this client is (or will be) a member of — re-declared at hello. */
  private readonly joinedRooms: Set<string>;
  private readonly runtimeDir: string;
  private readonly config: MeshConfig;
  private readonly noReconnect: boolean;

  private socket: Socket | null = null;
  private online = false;
  private intentionallyClosed = false;
  private aliasFallbackDone = false;
  private connecting: Promise<WelcomeInfo> | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  /** D39 watchdog: guarantees recovery if the reconnect chain ever dies
  *  (observed once on a remote TCP client: socket gone, no retry). */
  private watchdogTimer: NodeJS.Timeout | null = null;
  private helloTimer: NodeJS.Timeout | null = null;

  private readonly ackWaiters = new Map<string, AckWaiter>();
  private readonly statusWaiters = new Map<string, AckWaiter>();
  private readonly outbox: MeshFrame[] = [];
  private readonly inbox = new Map<string, MeshFrame>(); // msgId → inbound msg (mesh_reply target)
  private readonly awaitTargets = new Map<string, { to: string; room: string }>();
  private readonly pending: PendingReplies;
  /** waitAll() calls currently in flight (a counter: two concurrent
   *  waits must not clear each other's suppression) — while > 0, matched
   *  LAUNCH answers skip session injection (the verdict carries that
   *  batch). */
  private waitAllInFlight = 0;
  /** Memory-only ring buffer of last frames (bodies included) for mesh_history. */
  readonly transcript: MeshFrame[] = [];
  /** Own file reservations — declared at hello, updated via reserve/release. */
  private ownReservations: FileReservation[] = [];
  /** msgIds we sent that have been READ by peers (read receipts). */
  private readonly readBy = new Map<string, { alias: string; at: string }>();
  /** ids of replies WE sent — used to tag reply-à-reply chains. */
  private readonly sentReplies = new Set<string>();
  /** missions sent with awaitReply — who answered (for mesh_wait_all).
  *  status: waiting | answered | expired | failed: a mission that was
  *  blocked/errored at ack or expired is NOT 'waiting' forever). Bounded
  * capped at 200 entries, oldest dropped first. */
  private readonly awaitedMissions = new Map<
    string,
    {
      to: string;
      room: string;
      status: "waiting" | "answered" | "expired" | "failed";
      answered: boolean;
      response?: string;
      at?: string;
    }
  >();
  /** missions already reported by a wait_all verdict — never re-listed
  *  by a later wait_all (each batch is summarized once). */
  private readonly reportedMissions = new Set<string>();
  /** inbox/receipt/mission history caps (Map insertion order = age). */
  private static readonly MISSION_CAP = 200;
  private static readonly MISSION_DROP = 50;
  private static readonly INBOX_CAP = 512;
  private static readonly INBOX_DROP = 128;
  private static readonly READBY_CAP = 200;
  private static readonly READBY_DROP = 50;
  /** Latest known reservations per peer, fed by welcome/reserve broadcasts. */
  private readonly peerReservations = new Map<string, FileReservation[]>();
  /** Latest announced turn state per peer (activity frames). */
  private readonly peerActivity = new Map<string, { state: "busy" | "idle" | "rate_limited" | "blocked"; at: string }>();
  /** Aliases seen online (welcome + presence join) — send-guard hints.
  *  Best-effort: a missing entry is a WARNING, never a block. */
  private readonly knownPeers = new Set<string>();
  /**
  * replyTo msgIds already answered/handled: the FIRST reply to a given
  * message is consumed (pending match) or injected (orphan); later replies
  * are deduped by (replyTo + body hash) — an EXACT re-send of an already
  * handled answer is dropped silently (agents re-answering on reminds), but
  * a DIFFERENT answer to the same msgId (e.g. an ack "reçue" then the final
  * report) is still delivered.
  */
  private readonly handledReplyTargets = new Map<string, number>();

  constructor(opts: MeshClientOpts = {}) {
    super();
    this.aliasInternal = normalizeAlias(opts.alias ?? defaultAlias());
    this.initialRooms = opts.rooms ?? [...DEFAULT_CONFIG.rooms];
    this.joinedRooms = new Set(this.initialRooms);
    this.runtimeDir = opts.runtimeDir ?? runtimeDir();
    this.config = { ...DEFAULT_CONFIG, ...opts.config, rooms: this.initialRooms };
    this.noReconnect = opts.noReconnect === true;
    if (opts.initialReservations !== undefined) {
      this.ownReservations = opts.initialReservations.map((r) => ({ ...r }));
    }
    if (opts.onFrame) this.on("frame", opts.onFrame);
    this.pending = new PendingReplies((msgId) => this.sendRemind(msgId));
  }

  get alias(): string {
    return this.aliasInternal;
  }

  /** All rooms this client is a member of (re-declared at every hello). */
  get rooms(): readonly string[] {
    return [...this.joinedRooms];
  }

  /** activity status thresholds from config. */
  get activityIdleMs(): number {
    return this.config.activityIdleMs;
  }

  /**
  * true when a reply targets ANOTHER reply (one we sent, or one we
  * received) — i.e. a reply-à-reply (ack-of-ack chain). Such replies are
  * injected with an info-only label in followUp mode: the LLM decides
  * whether the content is worth reacting to, instead of a silent drop.
  */
  isReplyToReply(replyTo: string): boolean {
    return this.sentReplies.has(replyTo) || this.inbox.get(replyTo)?.type === "reply";
  }

  /** who read a msgId we sent ({alias, at}) — from read receipts. */
  readsOf(msgId: string): { alias: string; at: string }[] {
    this.pruneReadBy();
    const r = this.readBy.get(msgId);
    return r !== undefined && r.alias !== this.alias ? [{ ...r }] : [];
  }

  /** all read receipts we hold, newest first. */
  readReceipts(limit = 5): { msgId: string; alias: string; at: string }[] {
    this.pruneReadBy();
    return [...this.readBy.entries()]
      .reverse()
      .slice(0, limit)
      .map(([msgId, r]) => ({ msgId, alias: r.alias, at: r.at }));
  }

  // ---- awaited missions (mesh_wait_all) ----

  /** cancel every pending awaited mission (e.g. before a reset).
  *  awaitedMissions is wiped here, so recently-answered missions of past
  *  batches cannot leak into the next wait_all verdict. */
  cancelAllAwaited(): void {
    for (const id of [...this.awaitTargets.keys()]) {
      this.awaitedMissions.delete(id);
      this.pending.cancel(id, "cancelled");
    }
    this.awaitTargets.clear();
  }

  /** bound the awaitedMissions history (oldest dropped first). */
  private pruneAwaitedMissions(): void {
    while (this.awaitedMissions.size > MeshClient.MISSION_CAP) {
      const oldest = this.awaitedMissions.keys().next().value;
      if (oldest === undefined) break;
      this.awaitedMissions.delete(oldest);
    }
  }

  /** bound the read-receipt store (oldest dropped first). */
  private pruneReadBy(): void {
    while (this.readBy.size > MeshClient.READBY_CAP) {
      const oldest = this.readBy.keys().next().value;
      if (oldest === undefined) break;
      this.readBy.delete(oldest);
    }
  }

  /** bound the inbox (oldest dropped first) — reply targeting stays
  *  reliable for recent messages; ancient ones get reply_without_target. */
  private pruneInbox(): void {
    while (this.inbox.size > MeshClient.INBOX_CAP) {
      const oldest = this.inbox.keys().next().value;
      if (oldest === undefined) break;
      this.inbox.delete(oldest);
    }
  }

  /** Missions sent with awaitReply and their answer state: status is
  *  honest — waiting/answered/expired/failed). */
  missionStatus(): { msgId: string; to: string; answered: boolean; status: string }[] {
    this.pruneAwaitedMissions();
    return [...this.awaitedMissions.entries()].map(([msgId, m]) => ({
      msgId,
      to: m.to,
      answered: m.answered,
      status: m.status,
    }));
  }

  /**
  * block until EVERY awaited mission is answered (or timeout), then
  * return the honest group summary. The turn is suspended inside this tool
  * call — no sleep, no wasted tokens; inbound replies keep flowing and the
  * batch is delivered right after the result.
  * snapshot: still-pending missions (awaitTargets) PLUS missions
  * answered recently (≤ 5 min) that no previous verdict reported yet — a
  * fast answer that resolved before this call must still be in the summary.
  */
  async waitAll(timeoutMs: number, signal?: AbortSignal): Promise<WaitAllSummary> {
    const start = Date.now();
    const deadline = start + Math.max(25, timeoutMs);
    const now = Date.now();
    const targets = new Set<string>(this.awaitTargets.keys());
    for (const [id, m] of this.awaitedMissions) {
      if (m.status !== "answered" || m.at === undefined) continue;
      if (this.reportedMissions.has(id)) continue;
      if (now - Date.parse(m.at) <= RECENT_ANSWER_WINDOW_MS) targets.add(id);
    }
    const targetList = [...targets];
    this.waitAllInFlight += 1; // answers arriving now are carried by the verdict
    return new Promise((resolve) => {
      let settled = false;
      const done = (status: "complete" | "timeout" | "cancelled"): void => {
        if (settled) return;
        settled = true;
        this.waitAllInFlight -= 1;
        if (signal !== undefined) signal.removeEventListener("abort", onAbort);
        if (status !== "cancelled") {
  // answered missions of this verdict are reported once — a
  // later wait_all (next batch) must not re-list them. Missions still
  // missing stay reportable (the agent may wait again for them). A
  // CANCELLED verdict reports nothing: the agent may re-wait for the
  // same batch after the interrupt.
          for (const id of targetList) {
            if (this.awaitedMissions.get(id)?.answered === true) this.reportedMissions.add(id);
          }
          if (this.reportedMissions.size > 512) {
            let dropped = 0;
            for (const id of this.reportedMissions) {
              if (dropped >= 256) break;
              this.reportedMissions.delete(id);
              dropped += 1;
            }
          }
        }
        resolve(this.summarize(start, status, targetList));
      };
      const onAbort = (): void => done("cancelled");
      if (signal !== undefined) {
        if (signal.aborted) {
          done("cancelled");
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      const tick = (): void => {
        const missing = targetList.filter((id) => this.awaitedMissions.get(id)?.answered !== true);
        if (missing.length === 0) {
          done("complete");
          return;
        }
        if (Date.now() >= deadline) {
          done("timeout");
          return;
        }
        const t = setTimeout(tick, 200);
        t.unref();
      };
      tick();
    });
  }

  private summarize(
    startMs: number,
    status: "complete" | "timeout" | "cancelled",
    targets: string[],
  ): WaitAllSummary {
    const answers: { msgId: string; to: string; response: string }[] = [];
    const missing: { msgId: string; to: string }[] = [];
    for (const msgId of targets) {
      const m = this.awaitedMissions.get(msgId);
      if (m === undefined) continue;
      if (m.answered && m.response !== undefined) {
        answers.push({ msgId, to: m.to, response: m.response });
      } else {
        missing.push({ msgId, to: m.to });
      }
    }
    return {
      status,
      total: targets.length,
      answered: answers.length,
      elapsedMs: Date.now() - startMs,
      missing,
      answers,
    };
  }

  /** Announce this session's turn state to the mesh (busy on tool_call,
  *  idle on agent_settled, rate_limited on provider 429s). Fire-and-forget;
  *  the broker shares it with room members and status snapshots. */
  sendActivity(state: "busy" | "idle" | "rate_limited" | "blocked"): void {
    if (!this.online) return;
    const frame = buildFrame({ type: "activity", from: this.alias, status: state });
    this.writeOrQueue(frame);
  }

  /** Last known turn state of a peer (from snapshots/activity frames). */
  activityOf(alias: string): { state: "busy" | "idle" | "rate_limited" | "blocked"; at: string } | undefined {
    return this.peerActivity.get(alias);
  }

  /** How long a peer has been BUSY (ms), or undefined when not busy/unknown.
  *  Used to warn awaitReply senders: a busy-since-long peer with a short
  *  timeout will expire (measured: 6/6 expired missions in cs-room). */
  busyForMs(alias: string, now: number = Date.now()): number | undefined {
    const a = this.peerActivity.get(alias);
    if (a === undefined || a.state !== "busy") return undefined;
    const t = Date.parse(a.at);
    if (Number.isNaN(t)) return undefined;
    return Math.max(0, now - t);
  }

  /** Aliases known online (welcome/presence cache) — best-effort hints. */
  knowsPeer(alias: string): boolean {
    return this.knownPeers.has(alias);
  }

  get knownPeerList(): readonly string[] {
    return [...this.knownPeers];
  }

  /** inbound context verbosity ("compact" | "full"). */
  get contextVerbosity(): "compact" | "full" {
    return this.config.contextVerbosity === "full" ? "full" : "compact";
  }

  /** the session's home room: the room tag is omitted for its frames. */
  get homeRoom(): string {
    return this.joinedRooms.size > 0 ? [...this.joinedRooms][0] ?? "default" : "default";
  }

  /** send a read receipt for an inbound msgId back to its sender. */
  sendRead(msgId: string, to: string): void {
    if (!this.online) return;
    const frame = buildFrame({ type: "read", from: this.alias, to, reads: msgId });
    this.writeOrQueue(frame);
    this.ring(frame);
  }

  get activityStuckMs(): number {
    return this.config.activityStuckMs;
  }

  /** reservation TTL (0 = unlimited,. */
  get reservationTtlMs(): number {
    return this.config.reservationTtlMs;
  }

  get inboundBroadcasts(): "immediate" | "deferred" {
    return this.config.inboundBroadcasts ?? "immediate";
  }

  /** inbound batching window (0 = disabled). */
  get inboundBatchMs(): number {
    return this.config.inboundBatchMs ?? 0;
  }

  /** max hold while busy (safety cap). */
  get inboundBatchMaxHoldMs(): number {
    return this.config.inboundBatchMaxHoldMs ?? 30_000;
  }

  isOnline(): boolean {
    return this.online;
  }

  /** Additive (HUD): number of live awaitReply pendings. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
  * Additive read-only peek at an inbound frame by msgId (ledger enrichment).
  * NEVER mutates the inbox — callers rely on it surviving for future replies.
  */
  peekInbox(msgId: string): MeshFrame | undefined {
    return this.inbox.get(msgId);
  }

  // ---- file reservations ----

  /** This client's reservations (live, mutable by reserve/release). */
  get reservations(): readonly FileReservation[] {
    return this.ownReservations;
  }

  /** Known reservations of a peer alias (from welcome/status/reserve broadcasts). */
  reservationsOf(alias: string): readonly FileReservation[] {
    return this.peerReservations.get(alias) ?? [];
  }

  /** Snapshot of every peer alias currently holding reservations. */
  get peerReservationAliases(): readonly string[] {
    return [...this.peerReservations.keys()];
  }

  /** Live peer→reservations map (read-only view, includes self). */
  get peerReservationMap(): ReadonlyMap<string, readonly FileReservation[]> {
    return this.peerReservations;
  }

  private setOwnReservations(next: FileReservation[]): void {
    this.ownReservations = next;
    this.peerReservations.set(this.alias, next);
  }

  private applyPeerReservations(alias: string, reservations: FileReservation[] | undefined): void {
    if (reservations !== undefined && reservations.length > 0) {
      this.peerReservations.set(alias, [...reservations]);
    } else {
      this.peerReservations.delete(alias);
    }
  }

  private ring(frame: MeshFrame): void {
  // keep the ring USEFUL — heartbeats/acks (ping/pong/ack) flood it
  // (4 pongs/min) and push real messages (msg/reply/reserve/…) out in
  // minutes, so mesh_history only showed pongs. Only frames the session
  // cares about are kept.
    if (
      frame.type === "ping" || frame.type === "pong" || frame.type === "ack" ||
      frame.type === "activity" // Phase 3: turn-state noise, not history
    ) return;
    this.transcript.push(frame);
    if (this.transcript.length > TRANSCRIPT_RING_SIZE) {
      this.transcript.splice(0, this.transcript.length - TRANSCRIPT_RING_SIZE);
    }
  }

  /** replies to the same msgId are deduped for this long. */
  private pruneHandledReplyTargets(now: number = Date.now()): void {
    for (const [id, ts] of this.handledReplyTargets) {
      if (now - ts > HANDLED_REPLY_WINDOW_MS) this.handledReplyTargets.delete(id);
    }
  }

  /**
  * True when this EXACT answer (replyTo + body) was already consumed.
  * Marks the key on first sight so re-sends are dropped.
  */
  private isDuplicateReply(replyTo: string, body: string, now: number = Date.now()): boolean {
    const key = `${replyTo}|${sha256(body)}`;
    const ts = this.handledReplyTargets.get(key);
    if (ts !== undefined && now - ts < HANDLED_REPLY_WINDOW_MS) return true;
    this.handledReplyTargets.set(key, now);
    this.pruneHandledReplyTargets(now);
    return false;
  }

  /** Mark a reply target as consumed (after pending match or orphan inject). */
  private markReplyHandled(replyTo: string, body: string, now: number = Date.now()): void {
    this.handledReplyTargets.set(`${replyTo}|${sha256(body)}`, now);
    this.pruneHandledReplyTargets(now);
  }

  // ---- connection lifecycle ----

  connect(): Promise<WelcomeInfo> {
    if (this.online && this.socket) {
      return Promise.resolve({
        alias: this.alias,
        rooms: [...this.joinedRooms],
        peers: [],
        mailboxCount: 0,
      });
    }
  // explicit connect re-arms auto-reconnect after a prior close
    this.intentionallyClosed = false;
    this.connecting ??= this.doConnectWithAliasFallback().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  /**
  * doConnect, but on alias_taken: first RETRY the original alias with a
  * short backoff — the old connection may be mid-close (the /reload
  * handover, where session_shutdown and session_start are back-to-back).
  * Only after the retries fail (a genuinely live peer holds the alias,
  * e.g. a crashed session that never disconnected) fall back to a fresh
  * random alias instead of looping forever. Emits `alias_fallback` so the
  * extension can notify the user and persist the new identity.
  */
  private async doConnectWithAliasFallback(): Promise<WelcomeInfo> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.doConnect();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("alias_taken")) throw err;
        if (attempt < ALIAS_RETRY_ATTEMPTS) {
          await sleepMs(ALIAS_RETRY_DELAY_MS * 2 ** attempt);
          continue;
        }
        if (this.aliasFallbackDone) throw err;
        this.aliasFallbackDone = true;
        const previous = this.aliasInternal;
        this.aliasInternal = defaultAlias();
        try {
          const welcome = await this.doConnect();
          this.emit("alias_fallback", { from: previous, to: this.aliasInternal });
          return welcome;
        } catch {
          this.aliasFallbackDone = false;
          throw err; // surface the original alias_taken
        }
      }
    }
  }

  private async doConnect(): Promise<WelcomeInfo> {
  // explicit broker URL (tcp/tls/unix) → connect there; otherwise the
  // local auto-spawned broker (ensureBroker).
    const endpoint = this.config.brokerUrl !== undefined ? parseEndpoint(this.config.brokerUrl) : null;
    let socket: Socket;
    if (endpoint !== null && (endpoint.kind === "tcp" || endpoint.kind === "tls")) {
      const opts = {
        host: endpoint.host,
        port: endpoint.port,
        ...(endpoint.kind === "tls"
          ? {
              ca: this.config.tlsCa !== undefined ? readFileSync(this.config.tlsCa) : undefined,
              rejectUnauthorized: this.config.tlsInsecure === true ? false : undefined,
            }
          : {}),
      };
      socket = endpoint.kind === "tls" ? tls.connect(opts) : net.createConnection(opts);
    } else if (endpoint !== null && endpoint.kind === "unix") {
      socket = net.createConnection(endpoint.path);
    } else {
      const sockPath = await ensureBroker(this.runtimeDir); // throws broker_unavailable 
      socket = net.createConnection(sockPath);
    }
    this.socket = socket;
    this.debug(`doConnect: socket created → ${this.config.brokerUrl ?? "local unix"}`);
  // persistent error listener — a write racing a broker-side destroy
  // (e.g. invalid_token: broker answers + closes) must never surface as an
  // unhandled 'error' event after the handshake promise already settled.
  // MESH_DEBUG logs the wire-level reason (no bodies).
    socket.on("error", (err: Error) => {
      this.debug(`socket error: ${err.name}: ${err.message}`);
    });
    const decoder = new FrameDecoder(this.config.maxFrameBytes);

    const welcome = await new Promise<WelcomeInfo>((resolve, reject) => {
      let settled = false;
      const fail = (reason: string): void => {
        if (settled) return;
        settled = true;
        clearTimeout(this.helloTimer ?? undefined);
        socket.destroy();
        reject(new Error(reason));
      };
      this.helloTimer = setTimeout(() => fail("timeout: hello handshake"), HELLO_TIMEOUT_MS);
      this.helloTimer.unref();

      socket.once("connect", () => {
        const hello = buildFrame({
          type: "hello",
          from: this.alias,
          rooms: [...this.joinedRooms],
          reservations: this.ownReservations.length > 0 ? [...this.ownReservations] : undefined,
          token: this.config.brokerToken !== undefined ? sha256(this.config.brokerToken) : undefined,
          clientVersion: MESH_VERSION, // M1: peers see each other's version
        });
        socket.write(encodeFrame(hello, this.config.maxFrameBytes));
      });
      socket.once("error", () => fail("broker_unavailable"));
      socket.on("data", (chunk) => {
        let lines: string[];
        try {
          lines = decoder.push(chunk);
        } catch {
          fail("oversized");
          return;
        }
        for (const line of lines) {
          const parsed = parseFrameLine(line);
          if (!parsed.ok) continue;
          const frame = parsed.frame;
          if (!settled) {
            if (frame.type === "welcome") {
              settled = true;
              clearTimeout(this.helloTimer ?? undefined);
              this.online = true;
              this.reconnectAttempt = 0;
              this.attachSocket(socket, decoder);
  // seed the peer reservation cache from the welcome snapshot
              for (const p of frame.peers ?? []) this.applyPeerReservations(p.alias, p.reservations);
  // Phase 3: seed the activity cache too
              for (const p of frame.peers ?? []) {
                if (p.activity !== undefined && p.alias !== undefined) {
                  this.peerActivity.set(p.alias, p.activity);
                }
              }
  // send-guard cache: aliases present in the welcome are known online
              this.knownPeers.clear();
              for (const p of frame.peers ?? []) {
                if (p.alias !== undefined && p.alias !== this.alias) this.knownPeers.add(p.alias);
              }
              this.debug("handshake: welcome received");
              resolve({
                alias: this.alias,
                rooms: frame.rooms ?? [...this.joinedRooms],
                peers: frame.peers ?? [],
                mailboxCount: frame.mailboxCount ?? 0,
              });
            } else if (frame.type === "error") {
              fail(frame.code ?? "internal");
            }
          } else {
            this.onFrame(frame);
          }
        }
      });
      socket.on("close", () => {
        if (!settled) fail("broker_unavailable");
      });
    });

    this.startHeartbeat();
    this.startWatchdog();
    this.flushOutbox();
    this.emit("ready", welcome);
    return welcome;
  }

  /** Post-handshake wiring: frames dispatched, close → reconnect w/ backoff. */
  private attachSocket(socket: Socket, _decoder: FrameDecoder): void {
    socket.on("close", () => this.onSocketClosed(socket));
    socket.on("error", () => {});
  }

  private onSocketClosed(closedSocket?: Socket): void {
    this.debug(`onSocketClosed: online=${this.online} stale=${closedSocket !== undefined && this.socket !== closedSocket}`);
  // An explicit connect is in flight — it owns the socket lifecycle.
    if (this.connecting) {
      this.debug("onSocketClosed: ignored — connect already in flight");
      return;
    }
  // Ignore stale closes from sockets we have already replaced (rename
  // retry loop, late close of a detached socket): only the CURRENT
  // socket's close may tear the connection down.
    if (closedSocket !== undefined && this.socket !== closedSocket) return;
    const wasOnline = this.online;
    this.online = false;
    this.socket = null;
    this.stopHeartbeat();
  // in-flight sends: honest error, never delivered)
    for (const [id, w] of this.ackWaiters) {
      clearTimeout(w.timer);
      w.resolve(
        buildFrame({ type: "error", code: "internal", id, status: "connection_lost" }),
      );
    }
    this.ackWaiters.clear();
    for (const [id, w] of this.statusWaiters) {
      clearTimeout(w.timer);
      w.resolve(buildFrame({ type: "error", code: "internal", id }));
    }
    this.statusWaiters.clear();
    if (this.intentionallyClosed || this.noReconnect) {
      if (wasOnline) this.emit("closed");
      return;
    }
  // backoff 250ms ×2^n cap 5s → ensureBroker → re-hello
    const delay = backoffMs(this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch(() => {
  // ensureBroker/connect failed → onSocketClosed not called (no socket);
  // schedule next attempt via the same backoff path.
        this.onSocketClosed();
      });
    }, delay);
    this.reconnectTimer.unref();
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  private onFrame(frame: MeshFrame): void {
    this.ring(frame);
    switch (frame.type) {
      case "ack": {
        const w = this.ackWaiters.get(frame.id);
        if (w) {
          this.ackWaiters.delete(frame.id);
          clearTimeout(w.timer);
          w.resolve(frame);
          break;
        }
  // async drop notice: the broker dropped a message we sent earlier
  // from the recipient's offline mailbox (TTL expiry or cap eviction).
  // No send is waiting for this ack — settle any live awaitReply mission
  // NOW (it can never be answered from a dropped message) and tell the
  // extension so the session learns the message will not arrive.
        if (frame.status === "dropped_offline") {
          if (this.pending.has(frame.id)) this.pending.cancel(frame.id, "dropped_offline");
          const m = this.awaitedMissions.get(frame.id);
          if (m !== undefined) {
            m.status = "failed";
            m.response = "dropped_offline";
          }
          this.emit("dropped_offline", frame);
        }
        break;
      }
      case "status_res": {
        const w = this.statusWaiters.get(frame.id);
        if (w) {
          this.statusWaiters.delete(frame.id);
          clearTimeout(w.timer);
          w.resolve(frame);
        }
        break;
      }
      case "msg":
      case "mailbox":
        if (frame.id) {
          this.inbox.set(frame.id, frame);
          this.pruneInbox();
        }
        this.emit("inbound", frame);
        break;
      case "reserve": {
  // full-state replacement broadcast (empty array = released)
        const alias = frame.from;
        if (alias !== undefined && alias !== this.alias) {
          this.applyPeerReservations(alias, frame.reservations);
          this.emit("reservations", { from: alias, reservations: frame.reservations ?? [] });
        }
        break;
      }
      case "remind":
        this.emit("inbound", frame);
        break;
      case "reply": {
        const replyTo = frame.replyTo;
        const body = frame.body ?? "";
  // wake-on-answer: consult the launch flag BEFORE handleReply consumes it
        const wake = replyTo !== undefined && this.pending.isLaunch(replyTo) && this.waitAllInFlight === 0;
        const matched = replyTo !== undefined ? this.pending.handleReply(frame) : false;
        if (matched) {
  // awaited reply — the send promise already carries the answer
          if (replyTo !== undefined) {
            this.markReplyHandled(replyTo, body);
            const m = this.awaitedMissions.get(replyTo);
            if (m !== undefined) {
              m.status = "answered";
              m.answered = true;
              m.response = body;
              m.at = frame.ts;
            }
          }
          if (wake) {
  // LAUNCH mission, no wait_all in flight: deliver the answer to the
  // session like an orphan reply — stored in the inbox (so it can itself
  // be replied to) and injected with triggerTurn, waking an idle session.
  // While wait_all is active the verdict carries this batch instead (no
  // double delivery).
            if (frame.id) {
              this.inbox.set(frame.id, frame);
              this.pruneInbox();
            }
            this.emit("inbound", frame, { matchedReply: true });
          } else {
            this.emit("reply", frame);
          }
        } else if (replyTo !== undefined && this.isDuplicateReply(replyTo, body)) {
  // this EXACT answer (same msgId + same body) was already
  // consumed (awaitReply) or injected (orphan) — a re-send on a
  // remind. Drop it silently. Different answers to the same msgId
  // (ack then final report) are NOT duplicates and still pass.
          this.pending.unmatchedReplyCount += 1;
        } else {
  // ORPHAN reply: the sender did not awaitReply, so no pending
  // exists — but the answer must still reach the session. Surface it
  // like an inbound frame (stored in the inbox so it can itself be
  // replied to). Without this, mesh_reply returned "delivered" yet
  // the sender never saw the response.
          if (replyTo !== undefined) this.markReplyHandled(replyTo, body);
          if (frame.id) {
            this.inbox.set(frame.id, frame);
            this.pruneInbox();
          }
          this.emit("inbound", frame);
        }
        break;
      }
      case "read": {
  // read receipt for one of our msgIds — tracked, no turn.
        const msgId = frame.reads;
        if (msgId !== undefined && frame.from !== undefined) {
          this.readBy.set(msgId, { alias: frame.from, at: frame.ts });
        }
        this.emit("read", frame);
        break;
      }
      case "activity": {
        // a peer announced busy/idle/rate_limited — cache it (status/HUD)
        if (frame.from !== undefined && (frame.status === "busy" || frame.status === "idle" || frame.status === "rate_limited" || frame.status === "blocked")) {
          this.peerActivity.set(frame.from, { state: frame.status, at: frame.ts });
        }
        this.emit("frame", frame);
        break;
      }
      case "presence":
        if (frame.status === "offline") {
          this.peerReservations.delete(frame.from ?? "");
          this.peerActivity.delete(frame.from ?? ""); // gone — forget its state
          this.knownPeers.delete(frame.from ?? "");
        } else if (frame.status === "online" && frame.from !== undefined) {
          this.knownPeers.add(frame.from); // joined — the send guard knows it
        }
        this.emit("presence", frame);
        break;
      case "pong":
        break;
      case "error": {
  // broker refusals carry the original frame id → resolve the waiter
        const w = this.ackWaiters.get(frame.id);
        if (w) {
          this.ackWaiters.delete(frame.id);
          clearTimeout(w.timer);
          w.resolve(frame);
        }
        const sw = this.statusWaiters.get(frame.id);
        if (sw) {
          this.statusWaiters.delete(frame.id);
          clearTimeout(sw.timer);
          sw.resolve(frame);
        }
        this.emit("frame", frame);
        return; // skip double-emit below
      }
      default:
        break;
    }
    this.emit("frame", frame);
  }

  /** Wire-level lifecycle debug log (MESH_DEBUG=1). NEVER logs bodies. */
  private debug(line: string): void {
    if (this.config.debug !== true) return;
    try {
      mkdirSync(stateDir(), { recursive: true });
      appendFileSync(
        `${stateDir()}/client-debug.log`,
        `${new Date().toISOString()} [${this.alias}] ${line}\n`,
      );
    } catch {
      // best effort — never break the connection path
    }
  }

  /** D39: kick a connect() every WATCHDOG_INTERVAL_MS while offline. Any
  *  state where online=false, no in-flight connect and no timer must heal
  *  itself; connect() is idempotent while a connect is already running. */
  private startWatchdog(): void {
    if (this.watchdogTimer !== null) return;
    this.watchdogTimer = setInterval(() => {
      if (
        this.online ||
        this.connecting !== null ||
        this.reconnectTimer !== null ||
        this.intentionallyClosed ||
        this.noReconnect
      ) {
        return; // healthy, already connecting, or a backoff is armed
      }
      this.debug(`watchdog: offline without in-flight connect — kicking connect() (attempts=${this.reconnectAttempt})`);
      this.connect().catch((err: unknown) => {
        this.debug(`watchdog: connect failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, WATCHDOG_INTERVAL_MS);
    this.watchdogTimer.unref();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.online && this.socket && !this.socket.destroyed) {
        this.socket.write(
          encodeFrame(buildFrame({ type: "ping", from: this.alias }), this.config.maxFrameBytes),
        );
      }
    }, this.config.heartbeatMs);
    this.heartbeatTimer.unref();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private flushOutbox(): void {
    const n = Math.min(this.outbox.length, OUTBOX_FLUSH_CAP);
    for (let i = 0; i < n; i += 1) {
      const frame = this.outbox.shift();
      if (frame && this.socket && !this.socket.destroyed) {
        this.socket.write(encodeFrame(frame, this.config.maxFrameBytes));
      }
    }
  }

  private writeOrQueue(frame: MeshFrame): void {
    if (this.online && this.socket && !this.socket.destroyed) {
      this.socket.write(encodeFrame(frame, this.config.maxFrameBytes));
    } else if (this.outbox.length < OUTBOX_FLUSH_CAP) {
      this.outbox.push(frame);
    }
  }

  // ---- send / reply ----

  async send(opts: SendOpts): Promise<SendResult> {
    const broadcast = opts.broadcast === true;
    const to = opts.to !== undefined ? normalizeAlias(opts.to) : undefined;
    if (broadcast) {
  // broadcast needs a room and must NOT carry a target
      if (to !== undefined) return { status: "error", reason: "broadcast_with_to" };
    } else {
      if (to === undefined || !isValidAlias(to)) return { status: "error", reason: "invalid_alias" };
      if (to === this.alias) return { status: "blocked", reason: "self_send" };
    }
  // Room resolution: explicit room wins; otherwise prefer "default" when
  // still joined, else the first joined room (the client may have left
  // "default" — sending into it would be refused as not_member).
    const room = opts.room ?? (this.joinedRooms.has(DEFAULT_ROOM)
      ? DEFAULT_ROOM
      : [...this.joinedRooms][0]);
    if (room === undefined || !isValidRoom(room)) {
      return { status: "error", reason: "not_in_any_room" };
    }
    if (Buffer.byteLength(opts.message, "utf8") > MAX_BODY_BYTES) {
      return { status: "error", reason: "invalid_frame: body too large" };
    }
    if (opts.refs !== undefined) {
      if (opts.refs.length > MAX_REFS || !opts.refs.every(isValidRefPath)) {
        return { status: "error", reason: "invalid_frame: bad refs" };
      }
    }
  // replyTo: normalize to a bounded alias list (single or several).
    let replyTargets: string[] | undefined;
    if (opts.replyTo !== undefined) {
      const raw = Array.isArray(opts.replyTo) ? opts.replyTo : [opts.replyTo];
      if (raw.length === 0 || raw.length > MAX_REPLY_TARGETS) {
        return { status: "error", reason: "invalid_frame: bad replyTo" };
      }
      replyTargets = raw.map(normalizeAlias);
      if (!replyTargets.every(isValidAlias)) {
        return { status: "error", reason: "invalid_alias" };
      }
    }
    const priority = opts.priority ?? "normal";
    if (priority === "force" && (opts.reason === undefined || opts.reason.trim() === "")) {
      return { status: "error", reason: "force_requires_reason" };
    }
  // block:false is ONLY meaningful with awaitReply — a fire-and-forget
  // send has nothing for wait_all to track.
    const launch = opts.awaitReply === true && opts.block === false;
    if (opts.block === false && opts.awaitReply !== true) {
      return { status: "error", reason: "block_requires_awaitReply" };
    }
    const timeoutMs = Math.min(
      MAX_AWAIT_REPLY_TIMEOUT_MS,
      Math.max(MIN_AWAIT_REPLY_TIMEOUT_MS, opts.timeoutMs ?? DEFAULT_AWAIT_REPLY_TIMEOUT_MS),
    );

    if (!this.online) {
      try {
        await this.connect();
      } catch {
        return { status: "blocked", reason: "broker_unavailable" };
      }
    }

    const expiresAt = opts.awaitReply ? new Date(Date.now() + timeoutMs).toISOString() : undefined;
    const frame = buildFrame({
      type: "msg",
      from: this.alias,
      to,
      room,
      priority,
      body: opts.message,
      refs: opts.refs,
      broadcast: broadcast ? true : undefined,
      replyTargets,
      reasonHash: priority === "force" ? sha256(opts.reason ?? "") : undefined,
      expiresAt,
    });

  // register pending BEFORE write to avoid a reply/registration race
    let pendingPromise: Promise<import("./pending.js").PendingResolution> | null = null;
    if (opts.awaitReply) {
      this.awaitTargets.set(frame.id, { to: to ?? "*", room });
      this.awaitedMissions.set(frame.id, { to: to ?? "*", room, status: "waiting", answered: false });
      this.pruneAwaitedMissions();
      pendingPromise = this.pending.register(frame.id, Date.now() + timeoutMs, launch);
    }

    const ackPromise = this.waitAck(frame.id);
    this.writeOrQueue(frame);
    this.ring(frame);
    const ack = await ackPromise;

    if (ack.type === "error") {
      if (opts.awaitReply) {
        this.pending.cancel(frame.id, ack.code ?? "error");
        this.awaitTargets.delete(frame.id);
  // the mission is DEAD (blocked/rate_limited/…) — never "waiting".
        const m = this.awaitedMissions.get(frame.id);
        if (m !== undefined) {
          m.status = "failed";
          m.response = ack.code ?? "error";
        }
      }
      const code = ack.code ?? "internal";
      if (BLOCKED_CODES.has(code)) return { status: "blocked", msgId: frame.id, reason: code };
      return { status: "error", msgId: frame.id, reason: code };
    }

    if (!opts.awaitReply || pendingPromise === null) {
      if (ack.status === "delivered") {
        return {
          status: "delivered",
          msgId: frame.id,
          deliveredCount: ack.deliveredCount,
          totalCount: ack.totalCount,
        };
      }
      if (ack.status === "queued_offline") {
        return {
          status: "queued_offline",
          msgId: frame.id,
          deliveredCount: ack.deliveredCount,
          totalCount: ack.totalCount,
        };
      }
  // an unknown/unexpected ack status (e.g. dropped_offline on a msg)
  // is an honest error — never misreported as delivered.
      return {
        status: "error",
        msgId: frame.id,
        reason: `unexpected_ack_status: ${ack.status ?? "missing"}`,
      };
    }

  // LAUNCH mode — the delivery result returns immediately; the
  // pending stays live in the background (reminds at T/2 & 3T/4, expiry,
  // answered tracking) and mesh_wait_all reports the group verdict later.
    if (launch) {
      void pendingPromise.then((resolution) => {
        this.awaitTargets.delete(frame.id);
        if (resolution.kind === "expired") {
          const m = this.awaitedMissions.get(frame.id);
          if (m !== undefined) m.status = "expired"; // in the background too
          this.emit("expired", { msgId: frame.id });
        }
      });
      if (ack.status === "delivered") {
        return {
          status: "delivered",
          msgId: frame.id,
          deliveredCount: ack.deliveredCount,
          totalCount: ack.totalCount,
        };
      }
      if (ack.status === "queued_offline") {
        return {
          status: "queued_offline",
          msgId: frame.id,
          deliveredCount: ack.deliveredCount,
          totalCount: ack.totalCount,
        };
      }
      return {
        status: "error",
        msgId: frame.id,
        reason: `unexpected_ack_status: ${ack.status ?? "missing"}`,
      };
    }

    // ESC on a blocking send: settle immediately instead of hanging until
    // the mission timeout (signal → pending.cancel → resolution error).
    let onAbort: (() => void) | undefined;
    if (opts.signal !== undefined) {
      if (opts.signal.aborted) {
        this.pending.cancel(frame.id, "cancelled");
      } else {
        onAbort = () => this.pending.cancel(frame.id, "cancelled");
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
    }
    let resolution: import("./pending.js").PendingResolution;
    try {
      resolution = await pendingPromise;
    } finally {
      if (onAbort !== undefined && opts.signal !== undefined) {
        opts.signal.removeEventListener("abort", onAbort);
      }
    }
    this.awaitTargets.delete(frame.id);
    if (resolution.kind === "reply" && resolution.frame) {
      return {
        status: "reply",
        msgId: frame.id,
        response: resolution.frame.body ?? "",
        outputHash: resolution.frame.bodyHash ?? "",
      };
    }
    if (resolution.kind === "expired") {
  // expired missions are NOT "waiting" forever in missionStatus.
      const m = this.awaitedMissions.get(frame.id);
      if (m !== undefined) m.status = "expired";
      this.emit("expired", { msgId: frame.id });
      return { status: "expired", msgId: frame.id, reason: "expired" };
    }
    // cancelled = the sender aborted: drop the mission entirely (a late
    // reply takes the orphan path and is injected) — never "waiting".
    if (resolution.kind === "error" && resolution.reason === "cancelled") {
      this.awaitedMissions.delete(frame.id);
      return { status: "error", msgId: frame.id, reason: "cancelled" };
    }
    return { status: "error", msgId: frame.id, reason: resolution.reason ?? "error" };
  }

  async reply(msgId: string, body: string, opts: ReplyOpts = {}): Promise<SendResult> {
    const original = this.inbox.get(msgId);
    if (!original || original.from === undefined) {
      return { status: "error", msgId, reason: "reply_without_target" };
    }
    const { refs, to, replyAll } = opts;
    if (replyAll === true && to !== undefined) {
      return { status: "error", msgId, reason: "reply_all_with_to" };
    }
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
      return { status: "error", msgId, reason: "invalid_frame: body too large" };
    }
    if (refs !== undefined && (refs.length > MAX_REFS || !refs.every(isValidRefPath))) {
      return { status: "error", msgId, reason: "invalid_frame: bad refs" };
    }
    if (!this.online) {
      try {
        await this.connect();
      } catch {
        return { status: "blocked", msgId, reason: "broker_unavailable" };
      }
    }
  // reply variants
  //  - default: to the original sender (1:1)
  //  - to=<alias>: targeted at another member of the conversation
  //  - replyAll: fan out to the whole room of the original message
  //  - the original msg may carry replyTargets (sender-designated): the
  //    default reply then fans out to ALL of them instead of the sender.
    const designated = original.replyTargets;
    const target =
      replyAll === true
        ? undefined
        : to !== undefined
          ? normalizeAlias(to)
          : designated !== undefined && designated.length > 0
            ? undefined
            : original.from;
    if (replyAll !== true && to === undefined && designated !== undefined && designated.length > 0) {
  // fan-out to the sender-designated targets (bounded, validated at send)
      if (designated.length > MAX_REPLY_TARGETS) {
        return { status: "error", msgId, reason: "invalid_frame: bad replyTargets" };
      }
      const frame = buildFrame({
        type: "reply",
        from: this.alias,
        room: original.room,
        replyTo: msgId,
        replyTargets: [...designated],
        body,
        refs,
      });
      const ackPromise = this.waitAck(frame.id);
      this.writeOrQueue(frame);
      this.ring(frame);
      const ack = await ackPromise;
      if (ack.type === "error") {
        return { status: "error", msgId: frame.id, reason: ack.code ?? "internal" };
      }
      if (ack.status === "dropped_offline") {
        return { status: "error", msgId: frame.id, reason: "dropped_offline" };
      }
      this.sentReplies.add(frame.id);
      if (this.sentReplies.size > 512) {
        let dropped = 0;
        for (const id of this.sentReplies) {
          if (dropped >= 256) break;
          this.sentReplies.delete(id);
          dropped += 1;
        }
      }
      return {
        status: "delivered",
        msgId: frame.id,
        deliveredCount: ack.deliveredCount,
        totalCount: ack.totalCount,
      };
    }
    if (replyAll !== true && (target === undefined || !isValidAlias(target))) {
      return { status: "error", msgId, reason: "invalid_alias" };
    }
    const frame = buildFrame({
      type: "reply",
      from: this.alias,
      to: target,
      room: original.room,
      replyTo: msgId,
      body,
      refs,
      replyAll: replyAll === true ? true : undefined,
    });
    const ackPromise = this.waitAck(frame.id);
    this.writeOrQueue(frame);
    this.ring(frame);
    const ack = await ackPromise;
    if (ack.type === "error") {
      return { status: "error", msgId: frame.id, reason: ack.code ?? "internal" };
    }
    if (ack.status === "dropped_offline") {
      return { status: "error", msgId: frame.id, reason: "dropped_offline" };
    }
  // remember this reply id so ack-of-ack targeting it can be dropped.
  // cap the set — drop the OLDEST half (insertion order), not all.
    this.sentReplies.add(frame.id);
    if (this.sentReplies.size > 512) {
      let dropped = 0;
      for (const id of this.sentReplies) {
        if (dropped >= 256) break;
        this.sentReplies.delete(id);
        dropped += 1;
      }
    }
    return {
      status: "delivered",
      msgId: frame.id,
      deliveredCount: ack.deliveredCount,
      totalCount: ack.totalCount,
    };
  }

  /** client-side remind, broker stays mute. Max 2 enforced by PendingReplies.
   *  Skips a rate-limited target: poking a peer whose provider rejects every
   *  turn (429) only burns turns — the mission stays pending and wait_all
   *  reports the real reason. */
  private sendRemind(msgId: string): void {
    const target = this.awaitTargets.get(msgId);
    if (!target) return;
    // skip BOTH failure states: transient (rate_limited) and permanent
    // (blocked — auth errors etc. won't heal by poking)
    const act = this.peerActivity.get(target.to)?.state;
    if (act === "rate_limited" || act === "blocked") return;
    const frame = buildFrame({
      type: "remind",
      id: msgId,
      from: this.alias,
      to: target.to,
      room: target.room,
      replyTo: msgId,
      body: `reminder: reply expected for ${msgId}`,
    });
    this.writeOrQueue(frame);
    this.ring(frame);
  }

  /**
  * (re)declare this client's file reservations (add or replace).
  * The broker broadcasts the new full state to every peer. Patterns that are
  * invalid or empty are rejected before the network round-trip.
  */
  async reserve(patterns: string[], reason?: string): Promise<SendResult> {
    const valid: string[] = [];
    for (const raw of patterns) {
      const pattern = raw.trim();
      if (pattern.length === 0 || !isValidReservationPattern(pattern)) {
        return { status: "error", reason: `invalid_pattern: ${raw.slice(0, 80)}` };
      }
      valid.push(pattern);
    }
    if (valid.length === 0) return { status: "error", reason: "invalid_pattern" };
    if (!this.online) {
      try {
        await this.connect();
      } catch {
        return { status: "blocked", reason: "broker_unavailable" };
      }
    }
    const merged = [...this.ownReservations];
    for (const pattern of valid) {
      const idx = merged.findIndex((r) => r.pattern === pattern);
      const entry: FileReservation = {
        pattern,
        reason: reason !== undefined && reason.trim() !== "" ? reason.trim().slice(0, 512) : undefined,
        since: new Date().toISOString(),
      };
      if (idx !== -1) merged[idx] = entry;
      else merged.push(entry);
    }
    const frame = buildFrame({ type: "reserve", from: this.alias, reservations: merged });
    const ack = await this.roundTrip(frame);
    if (ack.type === "error") return { status: "error", reason: ack.code ?? "internal" };
    this.setOwnReservations(merged);
    this.emit("reservations", { from: this.alias, reservations: merged });
    return { status: "delivered", msgId: frame.id };
  }

  /**
  * release reservations. `patterns` undefined → release ALL.
  * Returns the released patterns.
  */
  async release(patterns?: string[]): Promise<{ released: string[] } & SendResult> {
    const releasing = patterns === undefined
      ? this.ownReservations.map((r) => r.pattern)
      : patterns.map((p) => p.trim()).filter((p) => p.length > 0);
    if (releasing.length === 0) return { status: "delivered", msgId: "", released: [] };
    const merged = this.ownReservations.filter((r) => !releasing.includes(r.pattern));
    if (!this.online) {
      try {
        await this.connect();
      } catch {
        return { status: "blocked", reason: "broker_unavailable", released: [] };
      }
    }
    const frame = buildFrame({ type: "reserve", from: this.alias, reservations: merged });
    const ack = await this.roundTrip(frame);
    if (ack.type === "error") return { status: "error", reason: ack.code ?? "internal", released: [] };
    this.setOwnReservations(merged);
    this.emit("reservations", { from: this.alias, reservations: merged });
    return { status: "delivered", msgId: frame.id, released: releasing };
  }

  private waitAck(id: string): Promise<MeshFrame> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.ackWaiters.delete(id);
        resolve(buildFrame({ type: "error", code: "timeout", id }));
      }, ACK_TIMEOUT_MS);
      timer.unref();
      this.ackWaiters.set(id, { resolve, timer });
    });
  }

  // ---- status / rooms / close ----

  status(room?: string): Promise<StatusSnapshot> {
    return new Promise((resolve) => {
      if (!this.online) {
        resolve({ peers: [], rooms: [] });
        return;
      }
      const frame = buildFrame({ type: "status_req", from: this.alias, room });
      const timer = setTimeout(() => {
        this.statusWaiters.delete(frame.id);
        resolve({ peers: [], rooms: [] });
      }, STATUS_REQ_TIMEOUT_MS);
      timer.unref();
      this.statusWaiters.set(frame.id, {
        timer,
        resolve: (res) =>
          resolve({
            peers: res.peers ?? [],
            rooms: res.rooms ?? [],
            stats: res.stats,
          }),
      });
      this.writeOrQueue(frame);
    });
  }

  async join(room: string, role: MeshRole = "member"): Promise<void> {
    const frame = buildFrame({ type: "join", from: this.alias, room, role });
    const ack = await this.roundTrip(frame);
    if (ack.type === "error") throw new Error(ack.code ?? "internal");
    this.joinedRooms.add(room);
  }

  async leave(room: string): Promise<void> {
    const frame = buildFrame({ type: "leave", from: this.alias, room });
    const ack = await this.roundTrip(frame);
    if (ack.type === "error") {
      if (ack.code === "not_member") {
  // Resync: the broker does not know us in this room — make sure a
  // future reconnect does not try to rejoin it.
        this.joinedRooms.delete(room);
      }
      throw new Error(ack.code ?? "internal");
    }
    this.joinedRooms.delete(room);
  }

  /**
  * In-flight alias change: detach from the broker under the old alias, then
  * re-hello under the new one. Rooms and reservations are re-declared in the
  * hello (broker state for the old alias — rooms, reservations, mailbox — is
  * dropped with the connection). On failure (e.g. alias_taken) the previous
  * alias is restored and the session reconnects under it.
  * `unchanged: true` when the alias was already the requested one (no-op).
  */
  async rename(newAlias: string): Promise<
    | { ok: true; alias: string; unchanged?: boolean }
    | { ok: false; reason: string }
  > {
    const target = normalizeAlias(newAlias);
    if (!isValidAlias(target)) return { ok: false, reason: "invalid_alias" };
    if (target === this.aliasInternal) return { ok: true, alias: target, unchanged: true };
    if (!this.online) {
      try {
        await this.connect();
      } catch {
        return { ok: false, reason: "broker_unavailable" };
      }
    }
    const oldAlias = this.aliasInternal;
    const oldSocket = this.socket;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

  // 1. detach the old alias (no reconnect loop — intentionallyClosed)
    this.intentionallyClosed = true;
    this.stopHeartbeat();
    this.pending.cancelAll("renamed");
    this.socket = null;
    this.online = false;
    if (oldSocket && !oldSocket.destroyed) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ACK_TIMEOUT_MS);
        t.unref();
        oldSocket.once("close", () => {
          clearTimeout(t);
          resolve();
        });
        oldSocket.end();
      });
    }

  // 2. re-hello under the new alias. NO alias_fallback here: rename
  //  handles alias_taken itself (restore the previous identity below).
  //  A transient alias_taken is RETRIED with backoff: right after
  //  /mesh reset (or a crashed session), the old socket's close may not
  //  have reached the broker yet — a single attempt would fail the
  //  rename even though the alias is about to be free. intentionallyClosed
  //  stays true during the retries so onSocketClosed never schedules a
  //  competing reconnect.
    this.aliasInternal = target;
    let lastErr: unknown;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.doConnect();
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("alias_taken") || attempt >= ALIAS_RETRY_ATTEMPTS) break;
        await sleepMs(ALIAS_RETRY_DELAY_MS * 2 ** attempt);
      }
    }
    if (lastErr !== undefined) {
  // restore the previous identity so the session stays usable
      this.aliasInternal = oldAlias;
      this.intentionallyClosed = true;
      try {
        await this.connect();
      } catch {
  // broker down entirely — nothing more we can do
      }
      const detail = lastErr instanceof Error ? lastErr.message : String(lastErr);
      return { ok: false, reason: detail.includes("alias_taken") ? "alias_taken" : detail };
    }
    this.intentionallyClosed = false;
    this.emit("renamed", { from: oldAlias, to: target });
    return { ok: true, alias: target };
  }

  private async roundTrip(frame: MeshFrame): Promise<MeshFrame> {
    if (!this.online) {
      try {
        await this.connect();
      } catch {
        return buildFrame({ type: "error", code: "shutting_down", id: frame.id });
      }
    }
    const ackPromise = this.waitAck(frame.id);
    this.writeOrQueue(frame);
    return ackPromise;
  }

  async close(): Promise<void> {
    this.intentionallyClosed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopHeartbeat();
    this.stopWatchdog();
    this.pending.cancelAll("shutting_down");
    const socket = this.socket;
    this.socket = null;
    this.online = false;
    if (socket && !socket.destroyed) {
      await new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
        socket.end();
        setTimeout(resolve, ACK_TIMEOUT_MS).unref();
      });
    }
    this.emit("closed");
  }
}
