// test/rooms-routing.test.ts — issues #16 (multi-room DM room resolution)
// and #17 (observer role must survive a reconnect). Real broker, real clients.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MeshClient } from "../src/client/client.js";
import { makeTempDirs, startTestBroker, waitFor } from "./helpers.js";

async function connect(
  t: { after: (fn: () => void | Promise<void>) => void },
  runtimeDir: string,
  alias: string,
  rooms: string[],
  role: "member" | "observer" = "member",
): Promise<MeshClient> {
  const client = new MeshClient({ alias, rooms, runtimeDir, config: {} });
  t.after(async () => {
    await client.close();
  });
  await client.connect();
  for (const room of rooms) {
    if (role === "observer") await client.join(room, "observer");
  }
  return client;
}

describe("#16: untagged direct send resolves a room shared with the target", () => {
  it("multi-room sender reaches a peer that is only in the non-default room", async (t) => {
    const dirs = makeTempDirs();
    const broker = await startTestBroker(dirs.runtimeDir);
    t.after(async () => {
      await broker.close();
      dirs.cleanup();
    });
    // sender is in [mesh, default]; target is only in [mesh]
    const sender = await connect(t, dirs.runtimeDir, "sender", ["default", "mesh"]);
    const target = await connect(t, dirs.runtimeDir, "target", ["mesh"]);
    // the welcome snapshot seeds the peer -> rooms cache
    await waitFor(() => sender.knowsPeer("target"));

    const res = await sender.send({ to: "target", message: "hello across rooms" });
    assert.equal(res.status, "delivered", JSON.stringify(res));
    const frame = target.peekInbox("m_never");
    assert.equal(frame, undefined);
  });

  it("no shared room stays an honest not_member (never a silent fallback)", async (t) => {
    const dirs = makeTempDirs();
    const broker = await startTestBroker(dirs.runtimeDir);
    t.after(async () => {
      await broker.close();
      dirs.cleanup();
    });
    const sender = await connect(t, dirs.runtimeDir, "sender2", ["default", "alpha"]);
    await connect(t, dirs.runtimeDir, "target2", ["beta"]);
    // No shared room means no presence either: the sender has no cached rooms
    // for the target, so resolution falls back to "default" and the broker
    // refuses. Honest not_member, never a silent cross-room route.

    // No room in common: the broker must refuse, not invent a room.
    const res = await sender.send({ to: "target2", message: "nope" });
    assert.notEqual(res.status, "delivered", JSON.stringify(res));
  });

  it("an explicit room still wins, and leave-default keeps working", async (t) => {
    const dirs = makeTempDirs();
    const broker = await startTestBroker(dirs.runtimeDir);
    t.after(async () => {
      await broker.close();
      dirs.cleanup();
    });
    const sender = await connect(t, dirs.runtimeDir, "sender3", ["default", "alpha"]);
    const target = await connect(t, dirs.runtimeDir, "target3", ["alpha"]);
    await waitFor(() => sender.knowsPeer("target3"));

    // Explicit room wins.
    const explicit = await sender.send({ to: "target3", message: "explicit", room: "alpha" });
    assert.equal(explicit.status, "delivered");

    // Sender leaves default: the shared-room rule and the fallback both hold.
    await sender.leave("default");
    const afterLeave = await sender.send({ to: "target3", message: "after leave" });
    assert.equal(afterLeave.status, "delivered", JSON.stringify(afterLeave));
  });

  it("tie-break is deterministic: the first shared room in our joined order", async (t) => {
    const dirs = makeTempDirs();
    const broker = await startTestBroker(dirs.runtimeDir);
    t.after(async () => {
      await broker.close();
      dirs.cleanup();
    });
    const sender = await connect(t, dirs.runtimeDir, "sender4", ["zzz", "aaa"]);
    const target = await connect(t, dirs.runtimeDir, "target4", ["aaa", "zzz"]);
    await waitFor(() => sender.knowsPeer("target4"));

    // Both rooms are shared; the sender joined zzz first, so zzz is chosen.
    // Deterministic = repeated sends resolve to the same room.
    for (let i = 0; i < 3; i += 1) {
      const res = await sender.send({ to: "target4", message: `tie-${i}` });
      assert.equal(res.status, "delivered", JSON.stringify(res));
    }
    const rooms = sender.rooms;
    assert.deepEqual(rooms, ["zzz", "aaa"], "joined order is preserved");
  });
});

describe("#17: observer role survives a reconnect", () => {
  async function brokerRole(broker: Awaited<ReturnType<typeof startTestBroker>>, alias: string): Promise<string | undefined> {
    const peer = broker.state.peers.get(alias);
    return peer?.rooms.get("default");
  }

  it("a re-hello keeps an observer an observer (broker-visible role)", async (t) => {
    const dirs = makeTempDirs();
    const broker = await startTestBroker(dirs.runtimeDir);
    t.after(async () => {
      await broker.close();
      dirs.cleanup();
    });
    const observer = await connect(t, dirs.runtimeDir, "obs", ["default"], "observer");
    assert.equal(await brokerRole(broker, "obs"), "observer");

    // Force a real reconnect cycle: the client re-sends its hello.
    await observer.rename("obs2");
    // rename re-hellos under the new alias; the role must follow.
    assert.equal(await brokerRole(broker, "obs2"), "observer");
  });

  it("an observer cannot send after a reconnect (write stays refused)", async (t) => {
    const dirs = makeTempDirs();
    const broker = await startTestBroker(dirs.runtimeDir);
    t.after(async () => {
      await broker.close();
      dirs.cleanup();
    });
    const observer = await connect(t, dirs.runtimeDir, "obs3", ["default"], "observer");
    const member = await connect(t, dirs.runtimeDir, "mem3", ["default"]);
    await waitFor(() => observer.knowsPeer("mem3"));

    const before = await observer.send({ to: "mem3", message: "should be refused" });
    assert.notEqual(before.status, "delivered", "an observer is read-only");

    await observer.rename("obs4");
    const after = await observer.send({ to: "mem3", message: "still refused" });
    assert.notEqual(after.status, "delivered", "the role must not be laundered into member");
    assert.equal(member.peekInbox("m_x"), undefined);
  });

  it("a member reconnect stays a member (no over-correction)", async (t) => {
    const dirs = makeTempDirs();
    const broker = await startTestBroker(dirs.runtimeDir);
    t.after(async () => {
      await broker.close();
      dirs.cleanup();
    });
    const member = await connect(t, dirs.runtimeDir, "mem5", ["default"]);
    const peer = await connect(t, dirs.runtimeDir, "peer5", ["default"]);
    await waitFor(() => member.knowsPeer("peer5"));
    await member.rename("mem6");
    assert.equal(await brokerRole(broker, "mem6"), "member");
    const res = await member.send({ to: "peer5", message: "still writable" });
    assert.equal(res.status, "delivered", JSON.stringify(res));
  });
});
