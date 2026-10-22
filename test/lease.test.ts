// test/lease.test.ts — B: one-writer task leases with an epoch fence.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunningBroker } from "../src/broker/broker.js";
import { buildFrame, type MeshFrame } from "../src/protocol/envelope.js";
import {
  brokerSocketPathOf,
  makeTempDirs,
  RawClient,
  startTestBroker,
  type TempDirs,
} from "./helpers.js";

function claimFrame(from: string, task: string, ttlMs = 60_000): MeshFrame {
  return buildFrame({ type: "claim", from, room: "default", task, paths: ["src/a.ts"], ttlMs });
}

function releaseFrame(from: string, task: string, leaseId: string): MeshFrame {
  return buildFrame({ type: "release", from, room: "default", task, leaseId });
}

async function client(t: { after: (fn: () => void) => void }, sock: string, alias: string): Promise<RawClient> {
  const raw = await RawClient.connect(sock);
  t.after(() => raw.close());
  raw.hello(alias, ["default"], "member", [], 2);
  await raw.waitFrame((f) => f.type === "welcome");
  return raw;
}

async function broker(t: { after: (fn: () => void | Promise<void>) => void }, dirs: TempDirs): Promise<RunningBroker> {
  const b = await startTestBroker(dirs.runtimeDir, { stateDir: dirs.stateDir });
  t.after(async () => {
    await b.close();
  });
  return b;
}

describe("B: task leases with epoch fence", () => {
  it("grants one owner; a second owner is held", async (t) => {
    const dirs = makeTempDirs();
    t.after(() => dirs.cleanup());
    await broker(t, dirs);
    const sock = brokerSocketPathOf(dirs.runtimeDir);
    const alice = await client(t, sock, "alice");
    const bob = await client(t, sock, "bob");

    const f1 = claimFrame("alice", "task-a");
    alice.sendFrame(f1);
    const g1 = await alice.waitFrame((f) => f.type === "lease" && f.replyTo === f1.id);
    assert.equal(g1.status, "granted");
    assert.equal(g1.owner, "alice");
    assert.ok((g1.fence ?? 0) >= 1);
    assert.ok((g1.epoch ?? 0) >= 1);

    const f2 = claimFrame("bob", "task-a");
    bob.sendFrame(f2);
    const g2 = await bob.waitFrame((f) => f.type === "lease" && f.replyTo === f2.id);
    assert.equal(g2.status, "held");
    assert.equal(g2.owner, "alice");
  });

  it("same-owner claim is idempotent (same lease/fence)", async (t) => {
    const dirs = makeTempDirs();
    t.after(() => dirs.cleanup());
    await broker(t, dirs);
    const sock = brokerSocketPathOf(dirs.runtimeDir);
    const alice = await client(t, sock, "alice");

    const f1 = claimFrame("alice", "task-a");
    alice.sendFrame(f1);
    const g1 = await alice.waitFrame((f) => f.type === "lease" && f.replyTo === f1.id);
    const f2 = claimFrame("alice", "task-a");
    alice.sendFrame(f2);
    const g2 = await alice.waitFrame((f) => f.type === "lease" && f.replyTo === f2.id);
    assert.equal(g2.status, "granted");
    assert.equal(g2.leaseId, g1.leaseId);
    assert.equal(g2.fence, g1.fence);
    assert.equal(g2.body, "reused");
  });

  it("TTL expiry frees the task and the next grant gets a higher fence", async (t) => {
    const dirs = makeTempDirs();
    t.after(() => dirs.cleanup());
    await broker(t, dirs);
    const sock = brokerSocketPathOf(dirs.runtimeDir);
    const alice = await client(t, sock, "alice");
    const bob = await client(t, sock, "bob");

    const f1 = claimFrame("alice", "task-ttl", 1_000);
    alice.sendFrame(f1);
    const g1 = await alice.waitFrame((f) => f.type === "lease" && f.replyTo === f1.id);
    await new Promise((r) => setTimeout(r, 1_100));

    const f2 = claimFrame("bob", "task-ttl", 1_000);
    bob.sendFrame(f2);
    const g2 = await bob.waitFrame((f) => f.type === "lease" && f.replyTo === f2.id);
    assert.equal(g2.status, "granted");
    assert.equal(g2.owner, "bob");
    assert.ok((g2.fence ?? 0) > (g1.fence ?? 0));
  });

  it("release frees the task; a wrong leaseId cannot release it", async (t) => {
    const dirs = makeTempDirs();
    t.after(() => dirs.cleanup());
    await broker(t, dirs);
    const sock = brokerSocketPathOf(dirs.runtimeDir);
    const alice = await client(t, sock, "alice");
    const bob = await client(t, sock, "bob");

    const f1 = claimFrame("alice", "task-rel");
    alice.sendFrame(f1);
    const g1 = await alice.waitFrame((f) => f.type === "lease" && f.replyTo === f1.id);

    const bad = releaseFrame("bob", "task-rel", g1.leaseId ?? "");
    bob.sendFrame(bad);
    const r0 = await bob.waitFrame((f) => f.type === "lease" && f.replyTo === bad.id);
    assert.equal(r0.status, "not_held");

    const rel = releaseFrame("alice", "task-rel", g1.leaseId ?? "");
    alice.sendFrame(rel);
    const r1 = await alice.waitFrame((f) => f.type === "lease" && f.replyTo === rel.id);
    assert.equal(r1.status, "released");

    const f2 = claimFrame("bob", "task-rel");
    bob.sendFrame(f2);
    const g2 = await bob.waitFrame((f) => f.type === "lease" && f.replyTo === f2.id);
    assert.equal(g2.status, "granted");
    assert.ok((g2.fence ?? 0) > (g1.fence ?? 0));
  });

  it("a broker restart bumps the epoch; old fences are stale", async (t) => {
    const dirs = makeTempDirs();
    t.after(() => dirs.cleanup());
    const b1 = await startTestBroker(dirs.runtimeDir, { stateDir: dirs.stateDir });
    const sock = brokerSocketPathOf(dirs.runtimeDir);
    const alice = await client(t, sock, "alice");
    const f1 = claimFrame("alice", "task-epoch");
    alice.sendFrame(f1);
    const g1 = await alice.waitFrame((f) => f.type === "lease" && f.replyTo === f1.id);
    alice.close();
    await b1.close();

    const b2 = await startTestBroker(dirs.runtimeDir, { stateDir: dirs.stateDir });
    t.after(async () => {
      await b2.close();
    });
    const bob = await client(t, sock, "bob");
    const f2 = claimFrame("bob", "task-epoch");
    bob.sendFrame(f2);
    const g2 = await bob.waitFrame((f) => f.type === "lease" && f.replyTo === f2.id);
    assert.equal(g2.status, "granted");
    assert.ok((g2.epoch ?? 0) > (g1.epoch ?? 0), "epoch must increase across restart");
    assert.ok((g2.fence ?? 0) > 0);
    await b2.close();
  });
});
