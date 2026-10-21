// test/injection-guard.test.ts — D47: bounded re-delivery of batches
// injected while a run was in flight (pi purges the agent followUp queue
// on ESC aborts — restoreQueuedMessagesToEditor → clearQueue).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InjectionGuard } from "../src/extension/injection-guard.js";
import type { MeshFrame } from "../src/protocol/envelope.js";

function frame(id: string): MeshFrame {
  return { v: 1, type: "msg", id, ts: new Date().toISOString(), from: "bob", to: "lead", room: "default", body: "x" } as MeshFrame;
}

describe("InjectionGuard (D47)", () => {
  it("idle sends are safe — nothing to guard", () => {
    const g = new InjectionGuard();
    g.note([frame("m1")], "followUp", false);
    assert.equal(g.pending, false);
    assert.equal(g.onTurnEnd("aborted"), "none");
  });

  it("busy send + aborted turn → resend", () => {
    const g = new InjectionGuard();
    g.note([frame("m1")], "followUp", true);
    assert.equal(g.onTurnEnd("aborted"), "resend");
    const entry = g.takeForResend();
    assert.ok(entry !== null);
    assert.equal(entry.tries, 1);
    assert.equal(entry.frames.length, 1);
    assert.equal(g.pending, false);
  });

  it("busy send + error turn → resend (the observed ESC-as-error case)", () => {
    const g = new InjectionGuard();
    g.note([frame("m1")], "steer", true);
    assert.equal(g.onTurnEnd("error"), "resend");
  });

  it("normal turn confirms an old unconfirmed batch", () => {
    const g = new InjectionGuard({ confirmAfterMs: 10 });
    const t0 = Date.now() - 100; // sent long ago
    g.note([frame("m1")], "followUp", true, t0);
    assert.equal(g.onTurnEnd("toolUse", Date.now()), "confirmed");
    assert.equal(g.pending, false);
  });

  it("normal turn holds a FRESH unconfirmed batch (the run may still consume it)", () => {
    const g = new InjectionGuard({ confirmAfterMs: 60_000 });
    g.note([frame("m1")], "followUp", true);
    assert.equal(g.onTurnEnd("toolUse"), "hold");
    assert.equal(g.pending, true);
  });

  it("agent_settled re-delivers only past the grace window, bounded by maxTries", () => {
    const g = new InjectionGuard({ settledGraceMs: 20, maxTries: 1 });
    g.note([frame("m1")], "followUp", true, Date.now() - 100);
    assert.equal(g.onSettled(), "resend");
    const first = g.takeForResend();
    assert.ok(first !== null);
    // the re-delivery itself lands in nextTurn (never the purgeable queue),
    // but keep the accounting honest: no third chance.
    g.note(first.frames, "followUp", true, Date.now() - 100);
    assert.equal(g.onSettled(), "confirmed", "maxTries reached");
    assert.equal(g.takeForResend(), null);
  });

  it("agent_settled holds a batch younger than the grace window", () => {
    const g = new InjectionGuard({ settledGraceMs: 5_000 });
    g.note([frame("m1")], "followUp", true);
    assert.equal(g.onSettled(), "hold");
  });

  it("clear() drops everything (session_shutdown)", () => {
    const g = new InjectionGuard();
    g.note([frame("m1")], "followUp", true);
    g.clear();
    assert.equal(g.pending, false);
    assert.equal(g.onTurnEnd("aborted"), "none");
  });
});
