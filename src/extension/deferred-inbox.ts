// extension/deferred-inbox.ts — a separate, timer-free broadcast batch.
import type { MeshFrame } from "../protocol/envelope.js";
import { batchDetails, buildBatchMessage } from "./batcher.js";
import { localTime, type FormatOpts } from "./inbound.js";
import type { ExtensionAPI } from "./pi-types.js";

export class DeferredInbox {
  private pending: MeshFrame[] = [];
  private queued: MeshFrame[] = [];
  private draining = false;

  constructor(
    private readonly pi: Pick<ExtensionAPI, "sendMessage">,
    private readonly formatFor: (frame: MeshFrame) => FormatOpts,
    private readonly changed: (count: number) => void,
  ) {}

  get count(): number {
    return this.pending.length + this.queued.length;
  }

  push(frame: MeshFrame): void {
    this.pending.push(frame);
    this.changed(this.count);
  }

  list(): string {
    const frames = [...this.queued, ...this.pending];
    if (frames.length === 0) return "mesh: deferred inbox empty";
    return `mesh: deferred ${frames.length}\n` + frames.map((f) =>
      `@${f.from ?? "?"} ${localTime(f.ts)} ${(f.body ?? "").replace(/\s+/g, " ").slice(0, 120)}`,
    ).join("\n");
  }

  private send(frames: MeshFrame[], immediate: boolean): void {
    const batch = buildBatchMessage(frames, this.formatFor);
    const content = batch.content.replace(/^\[mesh batch[^\n]*\]/,
      `[mesh deferred — ${frames.length} broadcast(s) not addressed to you]`);
    this.pi.sendMessage({
      customType: "mesh-inbound",
      content,
      display: true,
      details: batchDetails(frames),
    }, immediate ? { deliverAs: "followUp", triggerTurn: true } : { deliverAs: "nextTurn" });
  }

  /** Queue at input, BEFORE Pi drains nextTurn. Holding locally until then
   *  lets /mesh inbox flush promote the batch without duplicate injections:
   *  Pi's public API cannot remove an already-queued nextTurn message. */
  queueForPrompt(): void {
    if (this.pending.length === 0) return;
    this.send(this.pending, false);
    this.queued.push(...this.pending);
    this.pending = [];
  }

  /** Only user-prompt preflight drains nextTurn; mesh-triggered agent_start
   *  does not. Do not clear the inbox just because a direct message woke us. */
  promptStarting(): void {
    this.draining = true;
  }

  agentStarting(): void {
    if (!this.draining) return;
    this.draining = false;
    this.queued = [];
    this.changed(this.count);
  }

  flush(): number {
    const count = this.pending.length;
    if (count === 0) return 0;
    this.send(this.pending, true);
    this.pending = [];
    this.changed(this.count);
    return count;
  }

  clear(): void {
    this.pending = [];
    this.queued = [];
    this.draining = false;
    this.changed(0);
  }
}
