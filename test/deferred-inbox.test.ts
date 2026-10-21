import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DeferredInbox } from "../src/extension/deferred-inbox.js";
import { attachClientListeners } from "../src/extension/attach.js";
import { MeshClient } from "../src/client/client.js";
import { buildFrame, type MeshFrame } from "../src/protocol/envelope.js";
import type { InboundMessage, SendMessageOptions, SessionHookHandler, SessionContext } from "../src/extension/pi-types.js";
import type { MeshRuntime } from "../src/extension/tools.js";

const frame: MeshFrame = {
  v: 1, type: "msg", id: "m-deferred", from: "alice", ts: "2026-01-01T12:00:00Z",
  body: "status for @someone-else", broadcast: true,
};

function setup(sendMessage?: (msg: InboundMessage, opts?: SendMessageOptions) => void) {
  const sent: { msg: InboundMessage; opts?: SendMessageOptions }[] = [];
  const counts: number[] = [];
  const onSent: MeshFrame[][] = [];
  const inbox = new DeferredInbox(
    { sendMessage: sendMessage ?? ((msg, opts) => { sent.push({ msg, opts }); }) },
    () => ({}),
    (n) => counts.push(n),
    (frames) => onSent.push(frames),
  );
  return { inbox, sent, counts, onSent };
}

describe("deferred inbox", () => {
  it("batches only on next input, no triggerTurn; clears on the consuming agent_start", () => {
    const { inbox, sent, counts } = setup();
    inbox.push(frame);
    inbox.push({ ...frame, id: "m-two", body: "second update" });
    assert.equal(sent.length, 0);
    assert.equal(inbox.count, 2);
    assert.match(inbox.list(), /@alice .*status for @someone-else/);
    inbox.agentStarting(); // unrelated immediate mesh turn must NOT clear it
    assert.equal(inbox.count, 2);
    inbox.queueForPrompt();
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]!.opts, { deliverAs: "nextTurn" });
    assert.match(sent[0]!.msg.content, /^\[mesh deferred — 2 broadcast\(s\) not addressed to you\]/);
    inbox.promptStarting();
    inbox.agentStarting();
    assert.equal(inbox.count, 0);
    assert.equal(counts.at(-1), 0);
  });

  it("manual flush sends one immediate followUp and does not re-queue it", () => {
    const { inbox, sent, onSent } = setup();
    inbox.push(frame);
    inbox.push(frame);
    assert.equal(inbox.flush(), 2);
    assert.deepEqual(sent[0]!.opts, { deliverAs: "followUp", triggerTurn: true });
    assert.equal(onSent.length, 1);
    inbox.queueForPrompt();
    assert.equal(sent.length, 1);
    assert.equal(inbox.count, 0);
    assert.equal(inbox.flush(), 0);
  });

  it("a throwing flush keeps the batch and emits no read", () => {
    const onSent: MeshFrame[][] = [];
    const inbox = new DeferredInbox(
      { sendMessage: () => { throw new Error("stale"); } },
      () => ({}),
      () => {},
      (frames) => onSent.push(frames),
    );
    inbox.push(frame);
    assert.throws(() => inbox.flush());
    assert.equal(inbox.count, 1, "keeping the batch lets a retry deliver it");
    assert.equal(onSent.length, 0, "no receipt until the send succeeds");
  });

  it("emits onSent only when the queued batch is consumed by the prompt's agent_start", () => {
    const { inbox, sent, onSent } = setup();
    inbox.push(frame);
    inbox.queueForPrompt();
    assert.equal(sent.length, 1);
    assert.equal(onSent.length, 0, "queued nextTurn is not read yet");
    inbox.agentStarting(); // unrelated mesh-triggered turn
    assert.equal(onSent.length, 0);
    inbox.promptStarting();
    inbox.agentStarting();
    assert.equal(onSent.length, 1);
    assert.equal(onSent[0]![0]!.id, frame.id);
  });

  it("cancelled preflight does not lose, duplicate or promote already-queued messages", () => {
    const { inbox, sent } = setup();
    inbox.push(frame);
    inbox.queueForPrompt();
    inbox.agentStarting(); // direct message after cancelled/failed user preflight
    assert.equal(inbox.count, 1);
    assert.equal(inbox.flush(), 0);
    inbox.queueForPrompt();
    assert.equal(sent.length, 1);
    inbox.promptStarting();
    inbox.push(frame); // arrives after nextTurn drain: belongs to NEXT prompt
    inbox.agentStarting();
    assert.equal(inbox.count, 1);
    inbox.clear();
    assert.equal(inbox.count, 0);
  });

  it("failed send retains the local batch; preview is limited to 120 characters", () => {
    const inbox = new DeferredInbox({ sendMessage: () => { throw new Error("stale"); } }, () => ({}), () => {});
    inbox.push({ ...frame, body: "x".repeat(200) });
    assert.throws(() => inbox.flush(), /stale/);
    assert.equal(inbox.count, 1);
    assert.ok(inbox.list().endsWith("x".repeat(120)));
    assert.ok(!inbox.list().includes("x".repeat(121)));
  });
});

describe("attached inbound policy", () => {
  for (const mode of ["tui", "print"] as const) {
    it(`separates mixed traffic, preserves matched replies, and guards footer (${mode})`, async () => {
      const client = new MeshClient({ alias: "bob", config: { inboundBroadcasts: "deferred", inboundBatchMs: 0 } });
      const sent: { msg: InboundMessage; opts?: SendMessageOptions }[] = [];
      const statuses: (string | undefined)[] = [];
      const hooks = new Map<string, SessionHookHandler>();
      const ctx: SessionContext = {
        cwd: "/tmp", mode, isIdle: () => true,
        ui: { notify: () => {}, setWidget: () => {}, setStatus: (_id, text) => { statuses.push(text); } },
      };
      const rt = { client, ctx } as MeshRuntime;
      const pi = {
        on: (event: string, hook: SessionHookHandler) => { hooks.set(event, hook); },
        sendMessage: (msg: InboundMessage, opts?: SendMessageOptions) => { sent.push({ msg, opts }); },
        appendEntry: () => {},
      };
      attachClientListeners(pi as never, rt, () => null, ctx, client, () => {});
      try {
        client.emit("inbound", frame);
        client.emit("inbound", { ...frame, broadcast: false, body: "direct" });
        client.emit("inbound", { ...frame, body: "hi @BOB" });
        client.emit("inbound", { ...frame, type: "reply", replyAll: true }, { matchedReply: true });
        assert.equal(sent.length, 3);
        assert.ok(sent.every((s) => s.opts?.triggerTurn === true));
        assert.equal(rt.deferredInbox?.count, 1);
        if (mode === "tui") assert.equal(statuses.at(-1), "mesh:deferred 1");
        else assert.equal(statuses.length, 0);
        await hooks.get("agent_start")!({}, ctx);
        assert.equal(rt.deferredInbox?.count, 1);
        await hooks.get("input")!({}, ctx);
        assert.deepEqual(sent.at(-1)!.opts, { deliverAs: "nextTurn" });
        await hooks.get("before_agent_start")!({}, ctx);
        await hooks.get("agent_start")!({}, ctx);
        assert.equal(rt.deferredInbox?.count, 0);
        rt.markDetached?.();
        client.emit("inbound", frame);
        await hooks.get("input")!({}, ctx);
        assert.equal(sent.length, 4);
      } finally {
        await client.close();
      }
    });
  }
});

function attachSetup(mode: "tui" | "print", isIdle: () => boolean, batchMs = 250) {
  const client = new MeshClient({ alias: "bob", config: { inboundBroadcasts: "deferred", inboundBatchMs: batchMs } });
  const sent: { msg: InboundMessage; opts?: SendMessageOptions }[] = [];
  const reads: { id: string; from: string }[] = [];
  client.sendRead = (msgId: string, to: string): void => { reads.push({ id: msgId, from: to }); };
  const hooks = new Map<string, SessionHookHandler>();
  const ctx: SessionContext = {
    cwd: "/tmp", mode, isIdle,
    ui: { notify: () => {}, setWidget: () => {}, setStatus: () => {} },
  };
  const rt = { client, ctx } as MeshRuntime;
  const pi = {
    on: (event: string, hook: SessionHookHandler) => { hooks.set(event, hook); },
    sendMessage: (msg: InboundMessage, opts?: SendMessageOptions) => { sent.push({ msg, opts }); },
    appendEntry: () => {},
  };
  attachClientListeners(pi as never, rt, () => null, ctx, client, () => {});
  return { client, rt, ctx, sent, reads, hooks };
}

describe("attach: read receipts at the injection points", () => {
  it("batch flush reads msg/mailbox once each and skips replies", async () => {
    const { client, rt, sent, reads } = attachSetup("print", () => true, 250);
    try {
      const m1 = buildFrame({ type: "msg", from: "alice", to: "bob", body: "one" });
      const m2 = buildFrame({ type: "mailbox", from: "carol", to: "bob", body: "two" });
      const r1 = buildFrame({ type: "reply", from: "dave", to: "bob", replyTo: m1.id, body: "three" });
      client.emit("inbound", m1);
      client.emit("inbound", m2);
      client.emit("inbound", r1, { matchedReply: true });
      assert.equal(reads.length, 0, "batcher holds the burst");
      assert.equal(sent.length, 0);
      rt.batcher!.flushNow();
      assert.equal(sent.length, 1);
      assert.deepEqual(reads, [
        { id: m1.id, from: "alice" },
        { id: m2.id, from: "carol" },
      ]);
    } finally {
      await client.close();
    }
  });

  it("urgent bypasses only while busy and reads exactly once", async () => {
    let busy = true;
    const { client, rt, sent, reads } = attachSetup("print", () => !busy, 250);
    try {
      const u1 = buildFrame({ type: "msg", from: "alice", to: "bob", body: "now", priority: "urgent" });
      client.emit("inbound", u1);
      assert.deepEqual(reads, [{ id: u1.id, from: "alice" }]);
      assert.equal(sent.length, 1, "busy urgent is injected immediately");

      busy = false;
      reads.length = 0;
      const u2 = buildFrame({ type: "msg", from: "carol", to: "bob", body: "later", priority: "urgent" });
      client.emit("inbound", u2);
      assert.equal(reads.length, 0, "idle urgent coalesces in the window");
      assert.equal(sent.length, 1, "idle urgent is not injected yet");
      rt.batcher!.flushNow();
      assert.equal(sent.length, 2);
      assert.deepEqual(reads, [{ id: u2.id, from: "carol" }]);
    } finally {
      await client.close();
    }
  });
});
