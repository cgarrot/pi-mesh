// test/cap-integration.test.ts — B: end-to-end cap routing + leases (MeshClient).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MeshClient } from "../src/client/client.js";
import type { MeshFrame } from "../src/protocol/envelope.js";
import type { MeshTaskPackage } from "../src/protocol/task-package.js";
import { brokerSocketPathOf, makeTempDirs, RawClient, sleep, startTestBroker, type TempDirs } from "./helpers.js";

const PKG: MeshTaskPackage = {
  task: "mesh-b-int",
  goalAcceptance: "cap route lands on an idle capable peer with the package",
  paths: ["src/broker/rooms.ts"],
  branchBase: { branch: "agent/a/mesh-b", base: "f929821" },
  reply: { to: "lead", deadline: "2026-10-21T00:00:00Z", format: "commit + tests" },
};

async function setup(t: { after: (fn: () => void | Promise<void>) => void }): Promise<TempDirs> {
  const dirs = makeTempDirs();
  t.after(() => dirs.cleanup());
  const broker = await startTestBroker(dirs.runtimeDir, { stateDir: dirs.stateDir });
  t.after(async () => {
    await broker.close();
  });
  return dirs;
}

async function mc(
  t: { after: (fn: () => void | Promise<void>) => void },
  dirs: TempDirs,
  alias: string,
  caps: string[] = [],
): Promise<MeshClient> {
  const client = new MeshClient({
    alias,
    rooms: ["default"],
    runtimeDir: dirs.runtimeDir,
    config: { caps, inboundBatchMs: 0 },
  });
  t.after(async () => {
    await client.close();
  });
  await client.connect();
  return client;
}

function onceInbound(client: MeshClient, pred: (f: MeshFrame) => boolean): Promise<MeshFrame> {
  return new Promise((resolve) => {
    const handler = (frame: MeshFrame): void => {
      if (pred(frame)) {
        client.removeListener("inbound", handler);
        resolve(frame);
      }
    };
    client.on("inbound", handler);
  });
}

describe("B: end-to-end cap routing", () => {
  it("idle capable peer wins and the package arrives intact", async (t) => {
    const dirs = await setup(t);
    const lead = await mc(t, dirs, "lead");
    const idle = await mc(t, dirs, "idle1", ["deploy"]);
    const busy = await mc(t, dirs, "busy1", ["deploy"]);
    busy.sendActivity("busy");
    await sleep(40);

    const got = onceInbound(idle, (f) => f.type === "msg" && f.taskPackage?.task === PKG.task);
    const res = await lead.send({ to: "cap:deploy", message: "take this", taskPackage: PKG, priority: "urgent" });
    assert.equal(res.status, "delivered");
    assert.equal(res.routedTo, "idle1");
    const frame = await got;
    assert.equal(frame.to, "idle1");
    assert.equal(frame.routedCap, "deploy");
    assert.deepEqual(frame.taskPackage, PKG);
  });

  it("busy fallback: the least-busy capable peer still gets it", async (t) => {
    const dirs = await setup(t);
    const lead = await mc(t, dirs, "lead");
    const worker = await mc(t, dirs, "worker", ["deploy"]);
    worker.sendActivity("busy");
    await sleep(40);
    const res = await lead.send({ to: "cap:deploy", message: "fallback", taskPackage: PKG });
    assert.equal(res.status, "delivered");
    assert.equal(res.routedTo, "worker");
  });

  it("legacy peer (proto 1, caps ignored) -> honest caps_unsupported error", async (t) => {
    const dirs = await setup(t);
    const lead = await mc(t, dirs, "lead");
    const legacy = await RawClient.connect(brokerSocketPathOf(dirs.runtimeDir));
    t.after(() => legacy.close());
    legacy.hello("legacy", ["default"], "member", ["deploy"], 1);
    await legacy.waitFrame((f) => f.type === "welcome");

    const res = await lead.send({ to: "cap:deploy", message: "anybody?", taskPackage: PKG });
    assert.equal(res.status, "error");
    assert.equal(res.reason, "caps_unsupported");
  });
});

describe("B: end-to-end leases", () => {
  it("claim → held for the second owner → status → release → reclaim", async (t) => {
    const dirs = await setup(t);
    const lead = await mc(t, dirs, "lead");
    const other = await mc(t, dirs, "other");

    const g1 = await lead.claim({ task: "int-task", paths: ["src/a.ts"], ttlMs: 60_000 });
    assert.equal(g1.status, "granted");
    if (g1.status !== "granted") return;

    const g2 = await other.claim({ task: "int-task", paths: ["src/a.ts"], ttlMs: 60_000 });
    assert.equal(g2.status, "held");
    if (g2.status === "held") assert.equal(g2.holder, "lead");

    const st = await lead.leaseStatus("int-task");
    assert.equal(st.status, "current");
    if (st.status === "current") {
      assert.equal(st.lease.leaseId, g1.lease.leaseId);
      assert.equal(st.lease.fence, g1.lease.fence);
    }

    const rel = await lead.releaseLease({ task: "int-task", leaseId: g1.lease.leaseId });
    assert.equal(rel.status, "released");

    const g3 = await other.claim({ task: "int-task", paths: ["src/a.ts"], ttlMs: 60_000 });
    assert.equal(g3.status, "granted");
    if (g3.status === "granted") assert.ok(g3.lease.fence > g1.lease.fence);
  });
});
