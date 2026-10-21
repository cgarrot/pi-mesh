// extension/injection-guard.ts — bounded re-delivery of injected batches.
// MEASURED INCIDENT (2026-10-18, azo-8 session): a mesh batch flushed while a
// run was being ESC-aborted landed in pi's agent followUp queue; the TUI
// abort path calls restoreQueuedMessagesToEditor → session.clearQueue() →
// agent.clearAllQueues(), which PURGES that queue. The broker had already
// acked "delivered", the mesh-live preview was on screen, yet the message
// never reached the LLM context (agent had to call mesh_history manually).
// This guard keeps the flushed frames and re-delivers them — via
// deliverAs:"nextTurn", a pi queue the abort purge does NOT touch — when the
// surrounding turn ends aborted/errored or the session settles with the
// injection still unconfirmed. Bounded tries; never blocks the hot path.
import type { MeshFrame } from "../protocol/envelope.js";
import type { DeliverAs } from "./pi-types.js";

/** Resend the batch through the abort-safe "nextTurn" queue. */
export type ResendFn = (frames: MeshFrame[], originalDeliverAs: DeliverAs, tries: number) => void;

/** Identity of a batch = its frame ids (ordered) — the redelivery bound is
*  per-batch, so a re-note of the SAME frames keeps its try count. */
function batchKey(frames: MeshFrame[]): string {
  return frames.map((f) => f.id ?? "").join(",");
}

export interface InjectionGuardTuning {
  /** Max re-deliveries per unconfirmed batch. Default 2. */
  maxTries?: number;
  /** A completed (non-aborted) turn_end older than this confirms delivery. */
  confirmAfterMs?: number;
  /** On agent_settled, an unconfirmed batch older than this is re-sent. */
  settledGraceMs?: number;
}

/** Decision returned by the turn_end hook (index.ts schedules the resend). */
export type GuardDecision = "resend" | "confirmed" | "hold" | "none";

/**
 * Pure policy object (no pi imports, no timers — the caller schedules).
 * Lifecycle:
 *  - note() after every pi.sendMessage of a batch: busy sends are
 *    "unconfirmed" (they may sit in the purged-on-abort queue), idle sends
 *    are considered safe (direct append or a fresh triggered run).
 *  - onTurnEnd(stopReason): aborted/error → "resend" (the purge risk just
 *    materialized); a normal stop → "confirmed" once the send is older than
 *    confirmAfterMs (the run consumed its queues), else "hold".
 *  - onSettled(): the session went idle with an unconfirmed batch past the
 *    grace window → "resend" (covers purges that never surface as an
 *    aborted turn_end, e.g. an extension ctx.abort()).
 */
export class InjectionGuard {
  private unconfirmed: { frames: MeshFrame[]; deliverAs: DeliverAs; sentAt: number; tries: number; key: string } | null = null;
  /** per-batch try counts (bounded) — survive re-notes of the same frames. */
  private readonly triesByKey = new Map<string, number>();
  private static readonly TRIES_CAP = 32;
  readonly maxTries: number;
  readonly confirmAfterMs: number;
  readonly settledGraceMs: number;

  constructor(tuning: InjectionGuardTuning = {}) {
    this.maxTries = tuning.maxTries ?? 2;
    this.confirmAfterMs = tuning.confirmAfterMs ?? 8_000;
    this.settledGraceMs = tuning.settledGraceMs ?? 2_000;
  }

  /** Call right after sending a batch. `busyAtSend` = a turn was running.
  *  A re-note of the SAME frames keeps its accumulated try count. */
  note(frames: MeshFrame[], deliverAs: DeliverAs, busyAtSend: boolean, now: number = Date.now()): void {
    if (!busyAtSend) {
      this.unconfirmed = null;
      this.triesByKey.delete(batchKey(frames));
      return;
    }
    const key = batchKey(frames);
    this.unconfirmed = {
      frames: [...frames],
      deliverAs,
      sentAt: now,
      tries: this.triesByKey.get(key) ?? 0,
      key,
    };
  }

  /** Anything pending? (session_shutdown drops it — the runtime is gone). */
  get pending(): boolean {
    return this.unconfirmed !== null;
  }

  /** Take the unconfirmed batch for a resend (consumes it; tries+1). */
  takeForResend(now: number = Date.now()): { frames: MeshFrame[]; deliverAs: DeliverAs; tries: number } | null {
    const u = this.unconfirmed;
    if (u === null || u.tries >= this.maxTries) return null;
    this.unconfirmed = null;
    this.triesByKey.set(u.key, u.tries + 1);
    while (this.triesByKey.size > InjectionGuard.TRIES_CAP) {
      const oldest = this.triesByKey.keys().next().value;
      if (oldest === undefined) break;
      this.triesByKey.delete(oldest);
    }
    return { frames: [...u.frames], deliverAs: u.deliverAs, tries: u.tries + 1 };
  }

  onTurnEnd(stopReason: string | undefined, now: number = Date.now()): GuardDecision {
    const u = this.unconfirmed;
    if (u === null) return "none";
    if (stopReason === "aborted" || stopReason === "error") {
      // The just-ended run may have taken our queued batch with it (purge
      // on abort) — or will consume it on the auto-retry. Resend via the
      // abort-safe nextTurn queue; a consumed original at worst duplicates
      // the batch once (bounded by maxTries).
      return u.tries < this.maxTries ? "resend" : "confirmed";
    }
    if (now - u.sentAt >= this.confirmAfterMs) {
      this.unconfirmed = null;
      return "confirmed";
    }
    return "hold";
  }

  onSettled(now: number = Date.now()): GuardDecision {
    const u = this.unconfirmed;
    if (u === null) return "none";
    if (now - u.sentAt < this.settledGraceMs) return "hold";
    return u.tries < this.maxTries ? "resend" : "confirmed";
  }

  /** Drop everything (session_shutdown). */
  clear(): void {
    this.unconfirmed = null;
    this.triesByKey.clear();
  }
}
