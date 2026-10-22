// test/control-protocol.test.ts — A: stop-only control frames + client mapping.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildFrame, validateFrame } from "../src/protocol/envelope.js";
import { controlOutcome, MeshClient } from "../src/client/client.js";

describe("A: control protocol (stop only)", () => {
  it("a valid control frame carries to + action=stop + target", () => {
    const frame = buildFrame({ type: "control", from: "lead", to: "lead-jobd", action: "stop", target: "j_123" });
    assert.equal(validateFrame(frame).ok, true);
    assert.equal(frame.action, "stop");
    assert.equal(frame.target, "j_123");
  });

  it("rejects missing to/target/action and non-stop actions", () => {
    const noTo = buildFrame({ type: "control", from: "lead", action: "stop", target: "j_1" });
    assert.equal(validateFrame(noTo).ok, false);

    const noTarget = buildFrame({ type: "control", from: "lead", to: "lead-jobd", action: "stop" });
    assert.equal(validateFrame(noTarget).ok, false);

    const noAction = buildFrame({ type: "control", from: "lead", to: "lead-jobd", target: "j_1" });
    assert.equal(validateFrame(noAction).ok, false);

    const restart = buildFrame({ type: "control", from: "lead", to: "lead-jobd", target: "j_1" });
    (restart as { action?: string }).action = "restart";
    const r = validateFrame(restart);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.detail, "bad action");

    for (const action of ["pause", "resume"] as const) {
      const ok = buildFrame({ type: "control", from: "lead", to: "lead-jobd", action, target: "j_1" });
      assert.equal(validateFrame(ok).ok, true, `action=${action} must be valid`);
    }
  });

  it("rejects a target that is not a job id (no shell strings over the mesh)", () => {
    const bad = buildFrame({ type: "control", from: "lead", to: "lead-jobd", action: "stop" });
    bad.target = "j_1; rm -rf /";
    const r = validateFrame(bad);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.detail, "bad target");
  });

  it("control_ack statuses are closed; target is required", () => {
    const okAck = buildFrame({ type: "control_ack", from: "lead-jobd", to: "lead", replyTo: "m1", status: "stopped", target: "j_1" });
    assert.equal(validateFrame(okAck).ok, true);
    for (const status of ["paused", "resumed", "not_pausable"] as const) {
      const ack = buildFrame({ type: "control_ack", from: "lead-jobd", to: "lead", replyTo: "m1", status, target: "j_1" });
      assert.equal(validateFrame(ack).ok, true, `status=${status} must be valid`);
    }
    const badAck = buildFrame({ type: "control_ack", from: "lead-jobd", to: "lead", replyTo: "m1", status: "pausing", target: "j_1" });
    assert.equal(validateFrame(badAck).ok, false);
  });

  it("controlOutcome maps the three honest outcomes", () => {
    const base = { type: "control_ack" as const, from: "d", to: "lead", target: "j_1" };
    assert.deepEqual(controlOutcome(buildFrame({ ...base, status: "stopped" })), { status: "stopped", target: "j_1" });
    assert.deepEqual(controlOutcome(buildFrame({ ...base, status: "not_found" })), { status: "not_found", target: "j_1" });
    assert.deepEqual(controlOutcome(buildFrame({ ...base, status: "paused" })), { status: "paused", target: "j_1" });
    assert.deepEqual(controlOutcome(buildFrame({ ...base, status: "resumed" })), { status: "resumed", target: "j_1" });
    assert.deepEqual(controlOutcome(buildFrame({ ...base, status: "not_pausable" })), { status: "not_pausable", target: "j_1" });
    const err = controlOutcome(buildFrame({ ...base, status: "error", body: "boom" }));
    assert.equal(err.status, "error");
    if (err.status === "error") assert.equal(err.reason, "boom");
  });

  it("client.control fails honestly when offline or the alias is invalid", async () => {
    const client = new MeshClient({ alias: "lead", config: {} });
    const offline = await client.control({ to: "lead-jobd", target: "j_1" });
    assert.equal(offline.status, "error");
    if (offline.status === "error") assert.equal(offline.reason, "broker_unavailable");

    const badAlias = await client.control({ to: "not an alias!", target: "j_1" });
    assert.equal(badAlias.status, "error");
    if (badAlias.status === "error") assert.equal(badAlias.reason, "invalid_alias");
    await client.close();
  });
});
