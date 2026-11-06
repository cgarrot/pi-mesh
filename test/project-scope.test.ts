// test/project-scope.test.ts — roomMode end to end over a real broker.
//
// The unit tests prove the composition; this proves the BEHAVIOUR the feature
// exists for (issue #20) and the guarantee it must not break:
//   - an untargeted broadcast reaches agents of the SAME project only;
//   - a directed message between two projects still works in "both" mode,
//     because both keep `default` (the broker refuses `not_member` otherwise);
//   - `room: "default"` is still the loud, explicit mode;
//   - `roomMode: "project"` is strict isolation and fails honestly.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { MeshClient } from "../src/client/client.js";
import type { MeshFrame } from "../src/protocol/envelope.js";
import { deriveProjectRoom, resolveRoomScope } from "../src/shared/project-room.js";
import { makeTempDirs, startTestBroker, waitFor, type TempDirs } from "./helpers.js";

const PROJECT_A = "/tmp/pi-mesh-fixture-a/.mesh";
const PROJECT_B = "/tmp/pi-mesh-fixture-b/.mesh";

/** A client placed in a project scope, as the extension would build it. */
function projectClient(args: {
  alias: string;
  runtimeDir: string;
  stateDir: string;
  roomMode?: "default" | "project" | "both";
  pinned?: boolean;
}): MeshClient {
  const scope = resolveRoomScope({
    roomMode: args.roomMode ?? "both",
    rooms: ["default"],
    stateDir: args.stateDir,
    ...(args.pinned === true ? { pinned: true } : {}),
  });
  return new MeshClient({
    alias: args.alias,
    runtimeDir: args.runtimeDir,
    rooms: scope.rooms,
    ...(scope.projectRoom !== undefined ? { projectRoom: scope.projectRoom } : {}),
  });
}

function broadcasts(client: MeshClient): MeshFrame[] {
  const frames: MeshFrame[] = [];
  client.on("frame", (frame) => {
    if (frame.type === "msg" && frame.broadcast === true) frames.push(frame);
  });
  return frames;
}

function directs(client: MeshClient): MeshFrame[] {
  const frames: MeshFrame[] = [];
  client.on("frame", (frame) => {
    if (frame.type === "msg" && frame.broadcast !== true) frames.push(frame);
  });
  return frames;
}

describe("roomMode 'both': project scope over a real broker", () => {
  let dirs: TempDirs;
  let broker: Awaited<ReturnType<typeof startTestBroker>>;
  let alice: MeshClient; // project A
  let alex: MeshClient; // project A — same state dir, same project room
  let bob: MeshClient; // project B
  let alexBroadcasts: MeshFrame[];
  let bobBroadcasts: MeshFrame[];
  let bobDirects: MeshFrame[];

  before(async () => {
    dirs = makeTempDirs("mesh-room-scope-");
    broker = await startTestBroker(dirs.runtimeDir);
    alice = projectClient({ alias: "alice", runtimeDir: dirs.runtimeDir, stateDir: PROJECT_A });
    alex = projectClient({ alias: "alex", runtimeDir: dirs.runtimeDir, stateDir: PROJECT_A });
    bob = projectClient({ alias: "bob", runtimeDir: dirs.runtimeDir, stateDir: PROJECT_B });
    alexBroadcasts = broadcasts(alex);
    bobBroadcasts = broadcasts(bob);
    bobDirects = directs(bob);
    await Promise.all([alice.connect(), alex.connect(), bob.connect()]);
  });

  after(async () => {
    for (const client of [alice, alex, bob]) await client.close().catch(() => {});
    await broker.close().catch(() => {});
    try {
      rmSync(dirs.root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("everyone keeps default AND joins a room derived from their project", () => {
    for (const client of [alice, alex, bob]) assert.ok(client.rooms.includes("default"));
    assert.ok(alice.rooms.includes(deriveProjectRoom(PROJECT_A)));
    assert.ok(bob.rooms.includes(deriveProjectRoom(PROJECT_B)));
    // the two projects never share their project room
    assert.equal(alice.rooms.includes(deriveProjectRoom(PROJECT_B)), false);
  });

  it("an untargeted broadcast reaches the same project and NOT another one", async () => {
    const res = await alice.send({ broadcast: true, message: "alpha-local" });
    assert.equal(res.status, "delivered");
    // the scope is disclosed, not inferred
    assert.equal((res as { room?: string }).room, deriveProjectRoom(PROJECT_A));

    await waitFor(() => (alexBroadcasts.length === 1 ? true : undefined), 3_000);
    assert.equal(alexBroadcasts[0]?.body, "alpha-local");
    // absence assertion: give the fan-out time to (not) cross projects
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(bobBroadcasts.length, 0, "another project must not receive this broadcast");
  });

  it("room: default is still the loud, explicit mode", async () => {
    const res = await alice.send({ broadcast: true, room: "default", message: "alpha-global" });
    assert.equal(res.status, "delivered");
    await waitFor(() => (bobBroadcasts.length === 1 ? true : undefined), 3_000);
    assert.equal(bobBroadcasts[0]?.body, "alpha-global");
  });

  it("a directed message between two projects still works", async () => {
    const res = await alice.send({ to: "bob", message: "alpha-direct" });
    assert.equal(res.status, "delivered");
    await waitFor(() => (bobDirects.length === 1 ? true : undefined), 3_000);
    assert.equal(bobDirects[0]?.body, "alpha-direct");
  });

  it("broadcastRoom reports a distinct destination per project", () => {
    assert.equal(alice.broadcastRoom, deriveProjectRoom(PROJECT_A));
    assert.equal(alex.broadcastRoom, deriveProjectRoom(PROJECT_A));
    assert.equal(bob.broadcastRoom, deriveProjectRoom(PROJECT_B));
    assert.notEqual(alice.broadcastRoom, bob.broadcastRoom);
  });
});

describe("roomMode 'default': the escape hatch changes nothing", () => {
  let dirs: TempDirs;
  let broker: Awaited<ReturnType<typeof startTestBroker>>;
  let first: MeshClient;
  let second: MeshClient;
  let secondBroadcasts: MeshFrame[];

  before(async () => {
    dirs = makeTempDirs("mesh-room-legacy-");
    broker = await startTestBroker(dirs.runtimeDir);
    first = projectClient({ alias: "first", runtimeDir: dirs.runtimeDir, stateDir: PROJECT_A, roomMode: "default" });
    second = projectClient({ alias: "second", runtimeDir: dirs.runtimeDir, stateDir: PROJECT_B, roomMode: "default" });
    secondBroadcasts = broadcasts(second);
    await Promise.all([first.connect(), second.connect()]);
  });

  after(async () => {
    for (const client of [first, second]) await client.close().catch(() => {});
    await broker.close().catch(() => {});
    try {
      rmSync(dirs.root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("no project room, and broadcasts cross projects as before", async () => {
    assert.deepEqual([...first.rooms], ["default"]);
    const res = await first.send({ broadcast: true, message: "legacy-global" });
    assert.equal(res.status, "delivered");
    assert.equal((res as { room?: string }).room, "default");
    await waitFor(() => (secondBroadcasts.length === 1 ? true : undefined), 3_000);
  });
});

describe("roomMode 'project': strict isolation breaks cross-project on purpose", () => {
  let dirs: TempDirs;
  let broker: Awaited<ReturnType<typeof startTestBroker>>;
  let gamma: MeshClient;
  let delta: MeshClient;

  before(async () => {
    dirs = makeTempDirs("mesh-room-strict-");
    broker = await startTestBroker(dirs.runtimeDir);
    gamma = projectClient({ alias: "gamma", runtimeDir: dirs.runtimeDir, stateDir: PROJECT_A, roomMode: "project" });
    delta = projectClient({ alias: "delta", runtimeDir: dirs.runtimeDir, stateDir: PROJECT_B, roomMode: "project" });
    await Promise.all([gamma.connect(), delta.connect()]);
  });

  after(async () => {
    for (const client of [gamma, delta]) await client.close().catch(() => {});
    await broker.close().catch(() => {});
    try {
      rmSync(dirs.root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("'project' mode drops default", () => {
    assert.equal(gamma.rooms.includes("default"), false);
    assert.equal(delta.rooms.includes("default"), false);
  });

  it("a directed message fails honestly (not_member), never silently", async () => {
    const res = gamma.send !== undefined ? await gamma.send({ to: "delta", message: "should-not-route" }) : undefined;
    assert.ok(res !== undefined);
    assert.equal(res.status, "blocked");
    assert.equal((res as { reason: string }).reason, "not_member");
  });
});

describe("roomMode + a MESH_ROOMS pin", () => {
  let dirs: TempDirs;
  let broker: Awaited<ReturnType<typeof startTestBroker>>;
  let pinned: MeshClient;

  before(async () => {
    dirs = makeTempDirs("mesh-room-pin-");
    broker = await startTestBroker(dirs.runtimeDir);
    // a launcher placed this agent in a room for good
    pinned = new MeshClient({ alias: "pinned", runtimeDir: dirs.runtimeDir, rooms: ["aso12"] });
    await pinned.connect();
  });

  after(async () => {
    await pinned.close().catch(() => {});
    await broker.close().catch(() => {});
    try {
      rmSync(dirs.root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("the pin wins: no project room is added", () => {
    assert.deepEqual([...pinned.rooms], ["aso12"]);
    assert.equal(pinned.broadcastRoom, "aso12");
  });
});
