// test/task-package.test.ts — B: the five-field assignment contract.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildFrame, validateFrame } from "../src/protocol/envelope.js";
import {
  capTargetName,
  checkCapSend,
  isCapTarget,
  taskPackageSummary,
  validateTaskPackage,
  type MeshTaskPackage,
} from "../src/protocol/task-package.js";
import { formatInboundContent, inboundDetails } from "../src/extension/inbound.js";

const pkg = (over: Partial<MeshTaskPackage> = {}): unknown => ({
  task: "mesh-b-routing",
  goalAcceptance: "idle cap peer receives the task; busy peer is skipped; tests pass",
  paths: ["src/broker/rooms.ts", "test/cap-routing.test.ts"],
  branchBase: { branch: "agent/a/mesh-b", base: "f929821" },
  reply: { to: "agent-lead", deadline: "2026-10-21T12:00:00+08:00", format: "commit + test summary" },
  ...over,
});

describe("B: five-field task package", () => {
  it("accepts a complete package and normalizes the deadline", () => {
    const r = validateTaskPackage(pkg());
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.value.task, "mesh-b-routing");
      assert.deepEqual(r.value.paths, ["src/broker/rooms.ts", "test/cap-routing.test.ts"]);
      assert.equal(r.value.reply.deadline, "2026-10-21T04:00:00.000Z");
    }
  });

  it("rejects missing and extra fields (unknown contract is a different contract)", () => {
    const missing = pkg() as Record<string, unknown>;
    delete missing.reply;
    const r1 = validateTaskPackage(missing);
    assert.equal(r1.ok, false);
    if (!r1.ok) assert.match(r1.reason, /exactly/);

    const extra = { ...(pkg() as Record<string, unknown>), owner: "a" };
    const r2 = validateTaskPackage(extra);
    assert.equal(r2.ok, false);
    if (!r2.ok) assert.match(r2.reason, /exactly/);
  });

  it("rejects bad task ids, unsafe paths and bad deadlines", () => {
    assert.equal(validateTaskPackage(pkg({ task: "../escape" })).ok, false);
    assert.equal(validateTaskPackage(pkg({ paths: ["/etc/passwd"] })).ok, false);
    assert.equal(validateTaskPackage(pkg({ paths: ["src/../secret"] })).ok, false);
    assert.equal(validateTaskPackage(pkg({ paths: [] })).ok, false);
    assert.equal(validateTaskPackage(pkg({ paths: Array.from({ length: 33 }, (_, i) => `p${i}`) })).ok, false);
    assert.equal(
      validateTaskPackage(pkg({ reply: { to: "a", deadline: "tomorrow", format: "x" } })).ok,
      false,
    );
  });

  it("cap targets: valid names only; the package gate is explicit", () => {
    assert.equal(capTargetName("cap:deploy"), "deploy");
    assert.equal(capTargetName("CAP:Deploy"), "deploy");
    assert.equal(capTargetName("cap:not a cap"), undefined);
    assert.equal(capTargetName("agent-a"), undefined);
    assert.equal(isCapTarget("cap:git"), true);
    assert.equal(isCapTarget("agent-a"), false);

    assert.deepEqual(checkCapSend("agent-a", pkg()), { ok: false, reason: "not_a_cap_target" });
    assert.deepEqual(checkCapSend("cap:deploy", undefined), { ok: false, reason: "task_package_required" });
    const bad = checkCapSend("cap:deploy", { task: "x" });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.match(bad.reason, /invalid_task_package/);
    const good = checkCapSend("cap:deploy", pkg());
    assert.equal(good.ok, true);
    if (good.ok) assert.equal(good.cap, "deploy");
  });

  it("frames carry the package and validate its shape", () => {
    const frame = buildFrame({
      type: "msg",
      from: "alice",
      to: "cap:deploy",
      body: "take this",
      taskPackage: pkg() as MeshTaskPackage,
    });
    assert.equal(validateFrame(frame).ok, true);
    assert.equal(frame.taskPackage?.task, "mesh-b-routing");

    const bad = buildFrame({ type: "msg", from: "alice", to: "bob", body: "x" });
    bad.taskPackage = { task: "x" } as never;
    const r = validateFrame(bad);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.detail ?? "", /bad taskPackage/);
  });

  it("injects the contract into the message content (the lane cannot read your session)", () => {
    const frame = buildFrame({
      type: "msg",
      from: "alice",
      to: "bob",
      body: "take this",
      taskPackage: pkg() as MeshTaskPackage,
    });
    const compact = formatInboundContent(frame);
    const full = formatInboundContent(frame, { verbose: true });
    for (const text of [compact, full]) {
      assert.match(text, /\[task mesh-b-routing\]/);
      assert.match(text, /paths: src\/broker\/rooms\.ts/);
      assert.match(text, /branch: agent\/a\/mesh-b @ f929821/);
    }
    assert.equal(inboundDetails(frame).taskPackage, frame.taskPackage);
  });

  it("summaries are bounded", () => {
    const s = taskPackageSummary(pkg({
      goalAcceptance: "x".repeat(2000),
      paths: Array.from({ length: 12 }, (_, i) => `src/${i}/file.ts`),
    }) as MeshTaskPackage);
    assert.ok(s.length < 900);
    assert.match(s, /\(\+4\)/);
  });
});
