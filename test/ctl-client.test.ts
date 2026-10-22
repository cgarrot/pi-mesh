// test/ctl-client.test.ts — the SENDER path: MeshClient.control() against a
// REAL broker (no mocks). Covers the ack mapping, timeout, offline, self and
// target validation — the coverage gap the review flagged.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MeshClient } from "../src/client/client.js";
import { makeTempDirs, startTestBroker } from "./helpers.js";

describe("client.control: real broker", () => {
  it("maps a matching ctl_ack to stopped; offline is unreachable; silent is timeout", async (t) => {
    const dirs = makeTempDirs();
    const broker = await startTestBroker(dirs.runtimeDir);
    const alice = new MeshClient({ alias: "alice", runtimeDir: dirs.runtimeDir, config: {} });
    const bob = new MeshClient({ alias: "bob", runtimeDir: dirs.runtimeDir, config: {} });
    const carol = new MeshClient({ alias: "carol", runtimeDir: dirs.runtimeDir, config: {} });
    t.after(async () => {
      await alice.close();
      await bob.close();
      await carol.close();
      await broker.close();
      dirs.cleanup();
    });
    await alice.connect();
    await bob.connect();
    await carol.connect();

    // Bob is a well-behaved target: it answers the ctl id with its action.
    bob.on("frame", (frame) => {
      if (frame.type === "ctl" && frame.to === "bob" && frame.from !== undefined) {
        bob.sendCtlAck({ replyTo: frame.id, to: frame.from, status: "stopped", action: frame.action });
      }
    });

    const ok = await alice.control({ to: "bob", action: "job_stop", target: "j_1", timeoutMs: 2_000 });
    assert.equal(ok.status, "stopped");
    assert.equal(ok.target, "j_1");
    assert.equal(typeof ok.ctlId, "string", "the sender can audit the ctl id");

    const offline = await alice.control({ to: "ghost", action: "job_stop", target: "j_1", timeoutMs: 2_000 });
    assert.equal(offline.status, "unreachable");

    // Carol never answers: the sender must say timeout (may have acted), not a
    // false success, and must NOT retry.
    const silent = await alice.control({ to: "carol", action: "job_stop", target: "j_1", timeoutMs: 150 });
    assert.equal(silent.status, "timeout");
    assert.match(silent.reason, /may have acted/);

    const self = await alice.control({ to: "alice", action: "job_stop", target: "j_1" });
    assert.equal(self.status, "error");
    assert.match(self.reason, /self_control/);

    const badTarget = await alice.control({ to: "bob", action: "job_stop", target: "bad target!" });
    assert.equal(badTarget.status, "error");
    assert.match(badTarget.reason, /invalid_target/);

    const noReason = await alice.control({ to: "bob", action: "abort" });
    assert.equal(noReason.status, "error");
    assert.match(noReason.reason, /force_requires_reason/);
  });
});
