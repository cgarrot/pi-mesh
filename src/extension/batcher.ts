// extension/batcher.ts —: group inbound messages arriving in a burst and
// inject them as ONE batched message. After a long tool call (sleep, load)
// N replies queue up; injecting them one-by-one forces N turns and N LLM
// calls. A batch is one turn: the agent sees the whole lot and answers once.
import type { MeshFrame, MeshPriority } from "../protocol/envelope.js";
import { formatInboundContent, inboundDetails, type FormatOpts } from "./inbound.js";
import type { DeliverAs, InboundMessage } from "./pi-types.js";

export interface BatchedInjection {
  content: string;
  deliverAs: DeliverAs;
}

/** Bounds for the batched content: named constants). */
export const BATCH_MAX_MESSAGES = 12;
export const BATCH_MAX_BODY_CHARS = 240;

/** Per-frame format opts builder — defaults keep the legacy behaviour. */
type FormatFor = (frame: MeshFrame) => FormatOpts;

function priorityRank(p: MeshPriority): number {
  return p === "force" ? 3 : p === "urgent" ? 2 : 1;
}

/**
 * one message per frame (formatted), batched content = numbered list.
 * The delivery mode is the most interrupting one in the lot (steer wins over
 * followUp); force frames NEVER go through the batcher (they have their own
 * abort path).
 */
export function buildBatchMessage(frames: MeshFrame[], formatFor: FormatFor = () => ({})): BatchedInjection {
  const shown = frames.slice(0, BATCH_MAX_MESSAGES);
  const overflow = frames.length - shown.length;
  const parts: string[] = [`[mesh batch — ${frames.length} message${frames.length > 1 ? "s" : ""}]`];
  shown.forEach((f, i) => {
    const opts = formatFor(f);
    const body = formatInboundContent(f, {
      ...opts,
      replyChain: (f as unknown as { __replyChain?: boolean }).__replyChain === true,
    });
    parts.push(`${i + 1}) ${body}`);
  });
  if (overflow > 0) parts.push(`… (+${overflow} more — see mesh_history)`);
  parts.push(
    "",
    "Treat each message independently. Urgent items first. Do NOT acknowledge them one by one.",
  );
  const hasUrgent = frames.some((f) => f.priority === "urgent");
  const hasReply = frames.some((f) => f.type === "reply");
  // idle-arrived urgent may be batched (bypass is busy-gated); the batch
  // rides as a steer so the instruction still lands at the next boundary.
  const deliverAs: DeliverAs = hasUrgent || hasReply ? "steer" : "followUp";
  return { content: parts.join("\n"), deliverAs };
}

export function batchDetails(frames: MeshFrame[]): Record<string, unknown> {
  return {
    kind: "mesh-batch",
    count: frames.length,
    messages: frames.map((f) => inboundDetails(f)),
  };
}

/**
 * Returns true when the frame must bypass the batcher.
 * force/remind always do. urgent only while the agent is busy: when idle the
 * 250ms window coalesces a burst instead of spending one turn per message.
 */
export function bypassesBatch(frame: MeshFrame, busy = false): boolean {
  if (frame.priority === "force" || frame.type === "remind") return true;
  return frame.priority === "urgent" && busy;
}

/** Build a single (non-batched) inbound message — used when batchMs = 0. */
export function buildSingleMessage(frame: MeshFrame, formatFor: FormatFor = () => ({})): InboundMessage {
  return {
    customType: "mesh-inbound",
    content: formatInboundContent(frame, {
      ...formatFor(frame),
      replyChain: (frame as unknown as { __replyChain?: boolean }).__replyChain === true,
    }),
    display: true,
    details: inboundDetails(frame),
  };
}

export { priorityRank };

/**
 * accumulates inbound frames and injects them as ONE batched message
 * (single turn). KEY: while the agent is BUSY (e.g. a long sleep/bash), the
 * batcher HOLDS the frames — they do not enter pi's queue one by one. When
 * the busy period ends (tool_result) or the agent turns idle, everything is
 * flushed as a single injection, so the whole burst lands in the
 * conversation at once. Frames that must not wait (force, remind) bypass
 * the batcher entirely.
 */
export class InboundBatcher {
  private frames: MeshFrame[] = [];
  private timer: NodeJS.Timeout | null = null;
  private maxTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly windowMs: number,
    private readonly maxHoldMs: number,
    private readonly isBusy: () => boolean,
    private readonly onFlush: (frames: MeshFrame[]) => void,
  ) {}

  push(frame: MeshFrame): void {
    this.frames.push(frame);
    if (this.timer === null && this.windowMs > 0) {
      this.timer = setTimeout(() => this.onWindow(), this.windowMs);
      this.timer.unref();
    }
  }

  /** The short window elapsed: flush only when the agent is NOT busy —
  *  otherwise hold (a long tool call is running; more messages may come)
  *  and arm a max-hold fallback so nothing is retained forever.
  *  EXCEPTION: a batch containing urgent flushes immediately — an urgent
  *  instruction must not wait for the max-hold just because the agent turned
  *  busy inside the window. */
  private onWindow(): void {
    this.timer = null;
    if (this.frames.length === 0) return;
    const hasUrgent = this.frames.some((f) => f.priority === "urgent");
    if (this.isBusy() && !hasUrgent) {
      if (this.maxTimer === null) {
        this.maxTimer = setTimeout(() => this.flushNow(), this.maxHoldMs);
        this.maxTimer.unref();
      }
      return;
    }
    this.flushNow();
  }

  /** Flush everything now (called on tool_result: the busy period ended). */
  flushNow(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.maxTimer !== null) {
      clearTimeout(this.maxTimer);
      this.maxTimer = null;
    }
    if (this.frames.length === 0) return;
    const batch = this.frames;
    this.frames = [];
    this.onFlush(batch);
  }

  get pending(): number {
    return this.frames.length;
  }
}
