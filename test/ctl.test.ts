// test/ctl.test.ts — the control-plane frame at the broker level.
// A ctl is ONLINE-ONLY (never mailboxed), force-class actions need policy,
// and a ctl_ack is relayed ONLY to the peer that sent the pending ctl
// (forged/stale acks are dropped).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunningBroker } from "../src/broker/broker.js";
import { buildFrame, type MeshFrame } from "../src/protocol/envelope.js";
import { sha256 } from "../src/protocol/frames.js";
import { makeTempDirs, RawClient, startTestBroker, type TempDirs } from "./helpers.js";

interface Fixture {
  dirs: TempDirs;
  broker: RunningBroker;
  sock: string;
}

async function withBroker(
  t: { after: (fn: () => void | Promise<void>) => void },
  overrides: Parameters<typeof startTestBroker>[1] = {},
): Promise<Fixture> {
  const dirs = makeTempDirs();
  t.after(() => dirs.cleanup());
  const broker = await startTestBroker(dirs.runtimeDir, overrides);
  t.after(async () => {
    await broker.close();
  });
  return { dirs, broker, sock: broker.socketPath };
}

async function clientWith(
  t: { after: (fn: () => void) => void },
  sock: string,
  alias: string,
  rooms: string[],
  role: "member" | "observer",
): Promise<RawClient> {
  const raw = await RawClient.connect(sock);
  t.after(() => raw.close());
  raw.hello(alias, rooms, role, [], 2);
  await raw.waitFrame((f) => f.type === "welcome");
  return raw;
}

async function client(t: { after: (fn: () => void) => void }, sock: string, alias: string): Promise<RawClient> {
  return clientWith(t, sock, alias, ["default"], "member");
}

function ctl(id: string, opts: { to?: string; action?: string; target?: string; body?: string; reason?: boolean; from?: string } = {}): MeshFrame {
  return buildFrame({
    type: "ctl",
    id,
    from: opts.from ?? "alice",
    to: opts.to ?? "bob",
    room: "default",
    action: opts.action ?? "abort",
    ...(opts.target !== undefined ? { target: opts.target } : {}),
    ...(opts.body !== undefined ? { body: opts.body } : {}),
    ...(opts.reason !== false ? { reasonHash: sha256("because") } : {}),
  });
}

describe("ctl: routing + ack correlation", () => {
  it("delivers a force-class ctl when policy allows it, and relays the matching ack", async (t) => {
    const { sock } = await withBroker(t, { policy: { forceAllowedFrom: ["alice"] } });
    const alice = await client(t, sock, "alice");
    const bob = await client(t, sock, "bob");

    const frame = ctl("m_ctl_1");
    alice.sendFrame(frame);
    const got = await bob.waitFrame((f) => f.type === "ctl" && f.id === "m_ctl_1");
    assert.equal(got.action, "abort");
    assert.equal(got.from, "alice");
    assert.equal(got.to, "bob");

    bob.sendFrame(
      buildFrame({
        type: "ctl_ack",
        id: "m_ack_1",
        replyTo: "m_ctl_1",
        from: "bob",
        to: "alice",
        status: "aborted",
        action: "abort",
        settled: true,
      }),
    );
    const ack = await alice.waitFrame((f) => f.type === "ctl_ack" && f.replyTo === "m_ctl_1");
    assert.equal(ack.status, "aborted");
    assert.equal(ack.settled, true);
    assert.equal(ack.from, "bob");
  });

  it("an offline target is an honest unreachable error (no mailbox)", async (t) => {
    const { sock } = await withBroker(t, { policy: { forceAllowedFrom: ["alice"] } });
    const alice = await client(t, sock, "alice");
    const frame = ctl("m_ctl_ghost", { to: "ghost" });
    alice.sendFrame(frame);
    const err = await alice.waitFrame((f) => f.type === "error" && f.id === "m_ctl_ghost");
    assert.equal(err.code, "unreachable");
  });

  it("force-class ctl is denied by the default policy (abort needs force auth)", async (t) => {
    const { sock } = await withBroker(t);
    const alice = await client(t, sock, "alice");
    await client(t, sock, "bob");
    alice.sendFrame(ctl("m_ctl_denied"));
    const err = await alice.waitFrame((f) => f.type === "error" && f.id === "m_ctl_denied");
    assert.equal(err.code, "policy_denied");
  });

  it("an observer cannot use a control action (no write through read-only)", async (t) => {
    const { sock } = await withBroker(t, { policy: { forceAllowedFrom: ["alice"] } });
    await client(t, sock, "bob");
    const observer = await clientWith(t, sock, "obs", ["default"], "observer");
    observer.sendFrame(ctl("m_ctl_obs", { from: "obs", to: "bob" }));
    const err = await observer.waitFrame((f) => f.type === "error" && f.id === "m_ctl_obs");
    assert.equal(err.code, "observer_readonly");
  });

  it("a non-member cannot ctl into a room it did not join", async (t) => {
    const { sock } = await withBroker(t, { policy: { forceAllowedFrom: ["alice"] } });
    await client(t, sock, "bob");
    const outsider = await clientWith(t, sock, "outsider", ["other"], "member");
    outsider.sendFrame(ctl("m_ctl_nomember", { from: "outsider", to: "bob" }));
    const err = await outsider.waitFrame((f) => f.type === "error" && f.id === "m_ctl_nomember");
    assert.equal(err.code, "not_member");
  });

  it("the target must be in the named room (self-reported room is bounded)", async (t) => {
    const { sock } = await withBroker(t, { policy: { forceAllowedFrom: ["alice"] } });
    const alice = await client(t, sock, "alice");
    await clientWith(t, sock, "elsewhere", ["other"], "member");
    alice.sendFrame(ctl("m_ctl_target_room", { to: "elsewhere", from: "alice" }));
    const err = await alice.waitFrame((f) => f.type === "error" && f.id === "m_ctl_target_room");
    assert.equal(err.code, "not_member");
  });

  it("forceDowngrade never downgrades an abort: it is denied", async (t) => {
    const { sock } = await withBroker(t, { policy: { forceAllowedFrom: [], forceDowngrade: true } });
    const alice = await client(t, sock, "alice");
    await client(t, sock, "bob");
    alice.sendFrame(ctl("m_ctl_downgrade"));
    const err = await alice.waitFrame((f) => f.type === "error" && f.id === "m_ctl_downgrade");
    assert.equal(err.code, "policy_denied", "an abort cannot be downgraded to urgent");
  });

  it("an ack with the wrong action is dropped", async (t) => {
    const { sock } = await withBroker(t, { policy: { forceAllowedFrom: ["alice"] } });
    const alice = await client(t, sock, "alice");
    const bob = await client(t, sock, "bob");
    alice.sendFrame(ctl("m_ctl_action"));
    await bob.waitFrame((f) => f.type === "ctl" && f.id === "m_ctl_action");
    // Wrong action: the sender asked for an abort, not a job_stop.
    bob.sendFrame(
      buildFrame({ type: "ctl_ack", id: "m_ack_wrong", replyTo: "m_ctl_action", from: "bob", to: "alice", status: "aborted", action: "job_stop" }),
    );
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(alice.frames.filter((f) => f.type === "ctl_ack" && f.replyTo === "m_ctl_action").length, 0);
    bob.sendFrame(
      buildFrame({ type: "ctl_ack", id: "m_ack_right", replyTo: "m_ctl_action", from: "bob", to: "alice", status: "aborted", action: "abort" }),
    );
    const ack = await alice.waitFrame((f) => f.type === "ctl_ack" && f.replyTo === "m_ctl_action");
    assert.equal(ack.action, "abort");
  });

  it("job actions use normal policy and carry an opaque target", async (t) => {
    const { sock } = await withBroker(t);
    const alice = await client(t, sock, "alice");
    const bob = await client(t, sock, "bob");
    alice.sendFrame(ctl("m_ctl_job", { action: "job_stop", target: "j_abc123", reason: false }));
    const got = await bob.waitFrame((f) => f.type === "ctl" && f.id === "m_ctl_job");
    assert.equal(got.action, "job_stop");
    assert.equal(got.target, "j_abc123");
    bob.sendFrame(
      buildFrame({ type: "ctl_ack", id: "m_ack_job", replyTo: "m_ctl_job", from: "bob", to: "alice", status: "stopped", action: "job_stop" }),
    );
    const ack = await alice.waitFrame((f) => f.type === "ctl_ack" && f.replyTo === "m_ctl_job");
    assert.equal(ack.status, "stopped");
  });

  it("a forged ack from another peer is dropped (pair mismatch)", async (t) => {
    const { sock } = await withBroker(t, { policy: { forceAllowedFrom: ["alice"] } });
    const alice = await client(t, sock, "alice");
    const bob = await client(t, sock, "bob");
    const charlie = await client(t, sock, "charlie");

    alice.sendFrame(ctl("m_ctl_forge"));
    await bob.waitFrame((f) => f.type === "ctl" && f.id === "m_ctl_forge");

    // Charlie tries to answer Alice's mission — the pending pair says bob.
    charlie.sendFrame(
      buildFrame({ type: "ctl_ack", id: "m_ack_fake", replyTo: "m_ctl_forge", from: "charlie", to: "alice", status: "aborted" }),
    );
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(alice.frames.filter((f) => f.type === "ctl_ack" && f.replyTo === "m_ctl_forge").length, 0);

    bob.sendFrame(
      buildFrame({ type: "ctl_ack", id: "m_ack_real", replyTo: "m_ctl_forge", from: "bob", to: "alice", status: "aborted", action: "abort" }),
    );
    const ack = await alice.waitFrame((f) => f.type === "ctl_ack" && f.replyTo === "m_ctl_forge");
    assert.equal(ack.from, "bob");
  });

  it("an ack with no pending ctl is dropped", async (t) => {
    const { sock } = await withBroker(t);
    const alice = await client(t, sock, "alice");
    const bob = await client(t, sock, "bob");
    bob.sendFrame(
      buildFrame({ type: "ctl_ack", id: "m_ack_stale", replyTo: "m_never_sent", from: "bob", to: "alice", status: "aborted" }),
    );
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(alice.frames.filter((f) => f.type === "ctl_ack").length, 0);
  });
});
