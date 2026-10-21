// test/batcher.test.ts — D40: inbound batching (burst → one injection).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InboundBatcher, batchDetails, buildBatchMessage, bypassesBatch } from "../src/extension/batcher.js";
import { buildFrame, type MeshFrame } from "../src/protocol/envelope.js";

function msg(priority: "normal" | "urgent" | "force" = "normal"): MeshFrame {
  return buildFrame({ type: "msg", from: "agent-2", to: "lead", room: "cs-room", body: "hello", priority });
}

function reply(): MeshFrame {
  return buildFrame({ type: "reply", from: "agent-3", to: "lead", room: "cs-room", replyTo: "m_mission_1234567", body: "done" });
}

describe("buildBatchMessage (D40)", () => {
  it("numbers the messages and opens with the count", () => {
    const b = buildBatchMessage([msg(), reply()]);
    assert.ok(b.content.startsWith("[mesh batch — 2 messages]"));
    assert.ok(b.content.includes("1) [mesh] @agent-2"));
    assert.ok(b.content.includes("2) [mesh] @agent-3"));
    assert.ok(b.content.includes("Do NOT acknowledge them one by one."));
  });

  it("steer when the lot contains a reply or urgent; followUp for plain msgs", () => {
    assert.equal(buildBatchMessage([reply()]).deliverAs, "steer");
    assert.equal(buildBatchMessage([msg("urgent")]).deliverAs, "steer");
    assert.equal(buildBatchMessage([msg(), msg()]).deliverAs, "followUp");
  });

  it("caps the shown messages and reports the overflow", () => {
    const frames = Array.from({ length: 15 }, () => msg());
    const b = buildBatchMessage(frames);
    assert.ok(b.content.includes("(+3 more"), b.content.slice(-80));
  });

  it("details carry the per-message metadata", () => {
    const f = msg();
    const d = batchDetails([f]);
    assert.equal(d.kind, "mesh-batch");
    assert.equal(d.count, 1);
    assert.equal((d.messages as { msgId: string }[])[0]?.msgId, f.id);
  });
});

describe("InboundBatcher (D40)", () => {
  it("pushes during the window, flushes ONCE with all frames", async () => {
    let flushes = 0;
    let got: MeshFrame[] = [];
    const b = new InboundBatcher(50, 500, () => false, (frames) => {
      flushes += 1;
      got = frames;
    });
    b.push(msg());
    b.push(msg());
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(flushes, 1);
    assert.equal(got.length, 2);
  });

  it("flushNow delivers immediately and resets", async () => {
    let flushes = 0;
    const b = new InboundBatcher(5000, 500, () => false, () => {
      flushes += 1;
    });
    b.push(msg());
    b.flushNow();
    assert.equal(flushes, 1);
    b.flushNow();
    assert.equal(flushes, 1, "empty flush is a no-op");
  });

  it("HOLDS frames while busy, flushes everything when the busy period ends", async () => {
    let busy = true;
    let flushes = 0;
    let got: MeshFrame[] = [];
    const b = new InboundBatcher(50, 5000, () => busy, (frames) => {
      flushes += 1;
      got = frames;
    });
    b.push(msg());
    b.push(msg());
    await new Promise((r) => setTimeout(r, 120)); // window elapsed, but busy
    assert.equal(flushes, 0, "no flush while busy (long tool call running)");
    assert.equal(b.pending, 2, "frames are held");
    busy = false; // tool_result: busy period over
    b.flushNow();
    assert.equal(flushes, 1);
    assert.equal(got.length, 2, "the WHOLE burst is delivered at once");
    assert.equal(b.pending, 0);
  });

  it("flushes even while busy after the max-hold cap", async () => {
    let flushes = 0;
    const b = new InboundBatcher(30, 80, () => true, () => {
      flushes += 1;
    });
    b.push(msg());
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(flushes, 1, "max-hold safety cap flushes despite busy");
  });

  it("bypassesBatch: force/remind always; urgent only while busy; normal/reply batched", () => {
    const urgent = buildFrame({ type: "msg", from: "x", priority: "urgent", id: "m3" });
    assert.equal(bypassesBatch(buildFrame({ type: "msg", from: "x", priority: "force", id: "m1" }), true), true);
    assert.equal(bypassesBatch(buildFrame({ type: "remind", from: "x", replyTo: "m1", id: "m2" }), false), true);
    assert.equal(bypassesBatch(urgent, false), false, "idle urgent coalesces in the window");
    assert.equal(bypassesBatch(urgent, true), true, "busy urgent must not wait for max-hold");
    assert.equal(bypassesBatch(msg(), true), false);
    assert.equal(bypassesBatch(reply(), true), false);
  });

  it("flushes a batch containing urgent at the window even while busy", async () => {
    let flushes = 0;
    const b = new InboundBatcher(20, 5000, () => true, () => {
      flushes += 1;
    });
    b.push(buildFrame({ type: "msg", from: "x", priority: "urgent", id: "u1" }));
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(flushes, 1, "urgent must not wait for max-hold when the agent turns busy");
  });
});
