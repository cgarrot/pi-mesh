// test/cap-routing.test.ts — B: `cap:<name>` routes to an idle capable peer.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunningBroker } from "../src/broker/broker.js";
import { buildFrame, type MeshFrame } from "../src/protocol/envelope.js";
import type { MeshTaskPackage } from "../src/protocol/task-package.js";
import {
  brokerSocketPathOf,
  makeTempDirs,
  RawClient,
  sleep,
  startTestBroker,
  waitFor,
  type TempDirs,
} from "./helpers.js";

const PKG: MeshTaskPackage = {
  task: "mesh-b-routing",
  goalAcceptance: "cap:deploy reaches an idle capable peer",
  paths: ["src/broker/rooms.ts"],
  branchBase: { branch: "agent/a/mesh-b", base: "f929821" },
  reply: { to: "lead", deadline: "2026-10-21T00:00:00Z", format: "commit + tests" },
};

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
  return { dirs, broker, sock: brokerSocketPathOf(dirs.runtimeDir) };
}

async function client(t: { after: (fn: () => void) => void }, sock: string, alias: string, caps?: string[], proto = 2): Promise<RawClient> {
  const raw = await RawClient.connect(sock);
  t.after(() => raw.close());
  raw.hello(alias, ["default"], "member", caps, proto);
  await raw.waitFrame((f) => f.type === "welcome");
  return raw;
}

function capSend(id: string, to = "cap:deploy"): MeshFrame {
  return buildFrame({
    type: "msg",
    id,
    from: "lead",
    to,
    room: "default",
    body: "take this",
    taskPackage: PKG,
  });
}

describe("B: cap routing in the broker", () => {
  it("idle capable peer wins; ack names the resolved alias and the package arrives", async (t) => {
    const { sock } = await withBroker(t);
    const lead = await client(t, sock, "lead");
    const idle = await client(t, sock, "idle1", ["deploy"]);
    const busy = await client(t, sock, "busy1", ["deploy"]);
    busy.send({ type: "activity", from: "busy1", status: "busy", room: "default" });
    await sleep(30);

    const frame = capSend("m_cap_1");
    lead.sendFrame(frame);
    const ack = await lead.waitFrame((f) => f.type === "ack" && f.id === frame.id);
    assert.equal(ack.status, "delivered");
    assert.equal(ack.routedTo, "idle1");

    const got = await idle.waitFrame((f) => f.type === "msg" && f.id === frame.id);
    assert.equal(got.to, "idle1");
    assert.equal(got.routedCap, "deploy");
    assert.equal(got.taskPackage?.task, "mesh-b-routing");
    await sleep(50);
    assert.equal(busy.frames.filter((f) => f.type === "msg" && f.id === frame.id).length, 0);
  });

  it("no idle peer -> least-busy capable peer (busy fallback)", async (t) => {
    const { sock } = await withBroker(t);
    const lead = await client(t, sock, "lead");
    const older = await client(t, sock, "busy-older", ["deploy"]);
    const newer = await client(t, sock, "busy-newer", ["deploy"]);
    older.send({ type: "activity", from: "busy-older", status: "busy", room: "default" });
    await sleep(20);
    newer.send({ type: "activity", from: "busy-newer", status: "busy", room: "default" });
    await sleep(20);

    const frame = capSend("m_cap_busy");
    lead.sendFrame(frame);
    const ack = await lead.waitFrame((f) => f.type === "ack" && f.id === frame.id);
    assert.equal(ack.status, "delivered");
    assert.equal(ack.routedTo, "busy-newer", "least-busy (shortest busyForMs) wins");
  });

  it("no peer advertises caps -> caps_unsupported; no cap peer -> no_capable_peer", async (t) => {
    const { sock } = await withBroker(t);
    const lead = await client(t, sock, "lead");
    const legacy = await client(t, sock, "legacy", ["deploy"], 1); // proto 1: caps ignored
    const f1 = capSend("m_cap_legacy");
    lead.sendFrame(f1);
    const e1 = await lead.waitFrame((f) => f.type === "error" && f.id === f1.id);
    assert.equal(e1.code, "caps_unsupported");

    const other = await client(t, sock, "git1", ["git"]);
    const f2 = capSend("m_cap_other");
    lead.sendFrame(f2);
    const e2 = await lead.waitFrame((f) => f.type === "error" && f.id === f2.id);
    assert.equal(e2.code, "no_capable_peer");
    assert.ok(other !== undefined);
  });

  it("policy filters candidates; all denied -> policy_denied", async (t) => {
    const { sock } = await withBroker(t, {
      policy: { allow: [{ from: "lead", to: "nobody", room: "*" }] },
    });
    const lead = await client(t, sock, "lead");
    await client(t, sock, "idle1", ["deploy"]);
    const frame = capSend("m_cap_denied");
    lead.sendFrame(frame);
    const err = await lead.waitFrame((f) => f.type === "error" && f.id === frame.id);
    assert.equal(err.code, "policy_denied");
  });

  it("observers are never cap-routed", async (t) => {
    const { sock } = await withBroker(t);
    const lead = await client(t, sock, "lead");
    const obs = await RawClient.connect(sock);
    t.after(() => obs.close());
    obs.hello("observer", ["default"], "observer", ["deploy"], 2);
    await obs.waitFrame((f) => f.type === "welcome");

    const frame = capSend("m_cap_obs");
    lead.sendFrame(frame);
    const err = await lead.waitFrame((f) => f.type === "error" && f.id === frame.id);
    assert.equal(err.code, "no_capable_peer");
  });

  it("cap route carries the package unchanged", async (t) => {
    const { sock } = await withBroker(t);
    const lead = await client(t, sock, "lead");
    const idle = await client(t, sock, "idle1", ["deploy"]);
    const frame = capSend("m_cap_pkg");
    lead.sendFrame(frame);
    const got = await idle.waitFrame((f) => f.type === "msg" && f.id === frame.id);
    assert.deepEqual(got.taskPackage, PKG);
    await waitFor(() => lead.frames.some((f) => f.type === "ack" && f.id === frame.id));
  });
});
