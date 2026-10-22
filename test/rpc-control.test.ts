// test/rpc-control.test.ts — C: abort vs abort_bash vs steer semantics.
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { RpcWorker } from "../src/rpc/worker.js";

const fixture = join(process.cwd(), "test", "fixtures", "fake-rpc-worker.mjs");

function worker(defaultTimeoutMs = 3_000): RpcWorker {
  return new RpcWorker({
    cwd: process.cwd(),
    command: { bin: process.execPath, args: [fixture] },
    defaultTimeoutMs,
  });
}

describe("C: abort vs abort_bash", () => {
  it("abort ends the run (agent_settled aborted=true)", async (t) => {
    const w = worker();
    t.after(async () => {
      await w.stop(500);
    });
    await w.prompt("LONG run");
    const settled = w.waitForEvent("agent_settled");
    await w.abort();
    const event = await settled;
    assert.equal(event.aborted, true);
  });

  it("abort stops the run; a new prompt recovers", async (t) => {
    const w = worker();
    t.after(async () => {
      await w.stop(500);
    });
    await w.prompt("LONG run");
    const settled = w.waitForEvent("agent_settled");
    await w.abort();
    assert.equal((await settled).aborted, true);
    const data = (await w.prompt("Reply exactly RECOVERED")) as { disposition: string };
    assert.equal(data.disposition, "started");
    const settled2 = w.waitForEvent("agent_settled");
    await w.abort(); // cleanup the fake run
    await settled2;
  });

  it("a child exit rejects pending requests with rpc_worker_exited", async (t) => {
    const w = worker(5_000);
    t.after(async () => {
      await w.stop(500);
    });
    const pending = w.prompt("SLOW").catch((err: Error) => err);
    assert.ok(w.pid !== undefined);
    process.kill(w.pid!, "SIGKILL");
    const err = await pending;
    assert.ok(err instanceof Error);
    assert.match(err.message, /rpc_worker_exited/);
    assert.equal(w.alive, false);
  });
});
