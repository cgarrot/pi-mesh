// test/rpc-worker.test.ts — C: the minimal RPC JSONL client.
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { RpcWorker } from "../src/rpc/worker.js";

const fixture = join(process.cwd(), "test", "fixtures", "fake-rpc-worker.mjs");

function worker(defaultTimeoutMs = 2_000): RpcWorker {
  return new RpcWorker({
    cwd: process.cwd(),
    command: { bin: process.execPath, args: [fixture] },
    defaultTimeoutMs,
  });
}

describe("C: RpcWorker JSONL client", () => {
  it("prompt correlates by id and streams events", async (t) => {
    const w = worker();
    t.after(async () => {
      await w.stop(500);
    });
    const started = w.waitForEvent("agent_start");
    const data = (await w.prompt("hello")) as { disposition: string };
    assert.equal(data.disposition, "started");
    await started;
  });

  it("steer/follow_up/abort_bash/get_queue/set_steering_mode map to commands", async (t) => {
    const w = worker();
    t.after(async () => {
      await w.stop(500);
    });
    const steerSeen = w.waitForEvent("steer_seen", (e) => e.message === "do X");
    assert.deepEqual(await w.steer("do X"), { disposition: "queued" });
    assert.equal((await steerSeen).message, "do X");

    const followSeen = w.waitForEvent("follow_up_seen");
    assert.deepEqual(await w.followUp("later"), { disposition: "queued" });
    await followSeen;

    const bashAborted = w.waitForEvent("bash_aborted");
    assert.deepEqual(await w.abortBash(), { aborted: true });
    await bashAborted;

    const state = await w.getState();
    assert.equal(state.pendingMessageCount, 2);
    assert.equal(state.steeringMode, "all");
    assert.deepEqual(await w.setSteeringMode("all"), { mode: "all" });
  });

  it("keeps U+2028 inside a JSON string (no readline splitting)", async (t) => {
    const w = worker();
    t.after(async () => {
      await w.stop(500);
    });
    const data = (await w.prompt("U2028")) as { text: string };
    assert.equal(data.text, "a\u2028b");
  });

  it("times out one request without poisoning the next", async (t) => {
    const w = worker(5_000);
    t.after(async () => {
      await w.stop(500);
    });
    await assert.rejects(() => w.prompt("SLOW", { timeoutMs: 50 }), /rpc_timeout/);
    const data = (await w.prompt("hello")) as { disposition: string };
    assert.equal(data.disposition, "started");
  });

  it("forwards streamingBehavior on prompt", async (t) => {
    const w = worker();
    t.after(async () => {
      await w.stop(500);
    });
    const seen = w.waitForEvent("prompt_seen", (e) => e.streamingBehavior === "steer");
    await w.prompt("while streaming", { streamingBehavior: "steer" });
    assert.equal((await seen).message, "while streaming");
  });

  it("survives a response without an id (degraded to an event)", async (t) => {
    const w = worker();
    t.after(async () => {
      await w.stop(500);
    });
    const ev = w.waitForEvent("response", (e) => e.command === "NOID");
    await assert.rejects(() => w.request({ type: "NOID" }, 100), /rpc_timeout/);
    assert.equal((await ev).success, true);
  });

  it("parses a response split across chunks", async (t) => {
    const w = worker();
    t.after(async () => {
      await w.stop(500);
    });
    const res = await w.request({ type: "SPLIT" }, 2_000);
    assert.deepEqual(res.data, { text: "half" });
  });

  it("resolves concurrent out-of-order responses by id", async (t) => {
    const w = worker();
    t.after(async () => {
      await w.stop(500);
    });
    const [a, b] = await Promise.all([w.request({ type: "DELAY_A" }), w.request({ type: "DELAY_B" })]);
    assert.deepEqual(a.data, { which: "A" });
    assert.deepEqual(b.data, { which: "B" });
  });

  it("reports a spawn error honestly", async (t) => {
    const w = new RpcWorker({
      cwd: process.cwd(),
      command: { bin: "/nonexistent-node-for-rpc-test", args: [] },
      defaultTimeoutMs: 500,
    });
    t.after(async () => {
      await w.stop(200);
    });
    await assert.rejects(() => w.getState(300), /ENOENT|rpc_worker_not_running|rpc_worker_exited/);
    assert.equal(w.alive, false);
  });

  it("rejects pending work when stopped and reports !alive", async (t) => {
    const w = worker(5_000);
    t.after(async () => {
      await w.stop(500);
    });
    // Attach the rejection handler BEFORE stop() rejects pending work.
    const pending = w.prompt("SLOW").catch((err: Error) => err);
    await w.stop(200);
    const err = await pending;
    assert.ok(err instanceof Error);
    assert.match(err.message, /rpc_worker_(stopped|exited)/);
    assert.equal(w.alive, false);
  });
});
