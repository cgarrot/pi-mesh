// test/fence-hook.test.ts — B: Mesh-Lease trailer parsing + commit-msg gate.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildFrame, type MeshFrame } from "../src/protocol/envelope.js";
import { formatLeaseTrailer, parseLeaseTrailer, type LeaseRef } from "../src/shared/lease-trailer.js";
import { fenceVerdict } from "../src/cli/cmd/lease.js";
import type { LeaseResult } from "../src/client/client.js";
import { brokerSocketPathOf, makeTempDirs, RawClient, startTestBroker } from "./helpers.js";

const REF: LeaseRef = { task: "mesh-b", leaseId: "l_123", epoch: 1770000000000, fence: 3 };

describe("B: lease trailer + fence verdict", () => {
  it("format → parse round-trip; malformed lines are rejected", () => {
    const line = formatLeaseTrailer(REF);
    assert.equal(line, `Mesh-Lease: ${REF.task}#${REF.leaseId}#${REF.epoch}:${REF.fence}`);
    assert.deepEqual(parseLeaseTrailer(`subject\n\nbody\n${line}\n`), REF);
    assert.equal(parseLeaseTrailer("no trailer here"), undefined);
    assert.equal(parseLeaseTrailer("Mesh-Lease: only-task"), undefined);
    assert.equal(parseLeaseTrailer("Mesh-Lease: t#id#x:y"), undefined);
  });

  it("fenceVerdict: ok only on an exact match; error = unavailable", () => {
    const ok: LeaseResult = {
      status: "current",
      lease: { leaseId: REF.leaseId, task: REF.task, owner: "a", paths: [], epoch: REF.epoch, fence: REF.fence, expiresAt: "x" },
    };
    assert.equal(fenceVerdict(ok, REF), "ok");
    assert.equal(fenceVerdict({ ...ok, lease: { ...ok.lease, fence: REF.fence + 1 } }, REF), "stale");
    assert.equal(fenceVerdict({ ...ok, lease: { ...ok.lease, epoch: REF.epoch + 1 } }, REF), "stale");
    assert.equal(fenceVerdict({ status: "not_held" }, REF), "stale");
    assert.equal(fenceVerdict({ status: "error", reason: "timeout" }, REF), "unavailable");
  });
});

describe("B: lease_status over the broker", () => {
  it("current while held, not_held after release", async (t) => {
    const dirs = makeTempDirs();
    t.after(() => dirs.cleanup());
    const broker = await startTestBroker(dirs.runtimeDir, { stateDir: dirs.stateDir });
    t.after(async () => {
      await broker.close();
    });
    const sock = brokerSocketPathOf(dirs.runtimeDir);
    const alice = await RawClient.connect(sock);
    t.after(() => alice.close());
    alice.hello("alice", ["default"], "member", [], 2);
    await alice.waitFrame((f) => f.type === "welcome");

    const claim = buildFrame({ type: "claim", from: "alice", room: "default", task: "mesh-b", paths: ["src/a.ts"], ttlMs: 60_000 });
    alice.sendFrame(claim);
    const grant = await alice.waitFrame((f) => f.type === "lease" && f.replyTo === claim.id);
    assert.equal(grant.status, "granted");

    const q: MeshFrame = buildFrame({ type: "lease_status", from: "alice", room: "default", task: "mesh-b" });
    alice.sendFrame(q);
    const cur = await alice.waitFrame((f) => f.type === "lease" && f.replyTo === q.id);
    assert.equal(cur.status, "current");
    assert.equal(cur.leaseId, grant.leaseId);
    assert.equal(cur.epoch, grant.epoch);
    assert.equal(cur.fence, grant.fence);

    const rel = buildFrame({ type: "release", from: "alice", room: "default", task: "mesh-b", leaseId: grant.leaseId ?? "" });
    alice.sendFrame(rel);
    await alice.waitFrame((f) => f.type === "lease" && f.replyTo === rel.id);
    const q2: MeshFrame = buildFrame({ type: "lease_status", from: "alice", room: "default", task: "mesh-b" });
    alice.sendFrame(q2);
    const after = await alice.waitFrame((f) => f.type === "lease" && f.replyTo === q2.id);
    assert.equal(after.status, "not_held");
  });
});

describe("B: commit-msg hook behavior", () => {
  function runHook(msg: string, stubExit: number): { code: number; out: string; called: boolean } {
    const dir = mkdtempSync(join(tmpdir(), "mesh-hook-"));
    const bin = join(dir, "bin");
    const log = join(dir, "log");
    mkdirSync(bin, { recursive: true });
    const stub = join(bin, "pimesh");
    writeFileSync(stub, `#!/bin/sh\necho "$@" >> ${JSON.stringify(log)}\nexit ${stubExit}\n`);
    chmodSync(stub, 0o755);
    const msgFile = join(dir, "COMMIT_EDITMSG");
    writeFileSync(msgFile, msg);
    const hook = join(process.cwd(), "scripts", "hooks", "commit-msg");
    const res = spawnSync("bash", [hook, msgFile], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      encoding: "utf8",
    });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    return { code: res.status ?? -1, out, called: existsSync(log) };
  }

  it("no trailer → allow without calling pimesh", () => {
    const r = runHook("feat: normal commit\n\nno lease here\n", 5);
    assert.equal(r.code, 0);
    assert.equal(r.called, false);
  });

  it("stale (pimesh exit 5) → hook rejects", () => {
    const r = runHook(`feat: task work\n\n${formatLeaseTrailer(REF)}\n`, 5);
    assert.equal(r.code, 1);
    assert.match(r.out, /stale/);
  });

  it("ok (exit 0) and unavailable (exit 1) → hook allows", () => {
    const msg = `feat: task work\n\n${formatLeaseTrailer(REF)}\n`;
    assert.equal(runHook(msg, 0).code, 0);
    assert.equal(runHook(msg, 1).code, 0);
  });
});
