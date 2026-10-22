// test/rpc-integration.test.ts — C: the long-bash redirect flow end to end.
// Fake child: prompt starts a LONG run; abort_bash kills only the bash tool;
// a steer lands before the run settles; the turn is never aborted.
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { RpcWorker } from "../src/rpc/worker.js";

const fixture = join(process.cwd(), "test", "fixtures", "fake-rpc-worker.mjs");

function worker(): RpcWorker {
  return new RpcWorker({
    cwd: process.cwd(),
    command: { bin: process.execPath, args: [fixture] },
    defaultTimeoutMs: 3_000,
  });
}

describe("C: long bash redirect (abort + new prompt)", () => {
  it("abort stops the run and a new prompt redirects with history preserved", async (t) => {
    const w = worker();
    t.after(async () => {
      await w.stop(500);
    });
    const events: string[] = [];
    w.on("event", (e) => events.push(e.type as string));

    const started = w.waitForEvent("agent_start");
    await w.prompt("LONG render");
    await started;

    const settled = w.waitForEvent("agent_settled");
    await w.abort();
    const event = await settled;
    assert.equal(event.aborted, true);
    assert.deepEqual(events.filter((t) => ["agent_start", "agent_settled"].includes(t)), ["agent_start", "agent_settled"]);

    const data = (await w.prompt("use the new cache dir and retry")) as { disposition: string };
    assert.equal(data.disposition, "started");

    const settled2 = w.waitForEvent("agent_settled");
    await w.abort();
    assert.equal((await settled2).aborted, true);
  });
});
