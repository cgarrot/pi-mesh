// test/project-room.test.ts — roomMode: derivation and room composition.
//
// Issue #20: a shared broker puts every project on the machine into one room,
// so an untargeted broadcast crosses unrelated projects. The fix is a room
// derived from the project's identity — and, crucially, ADDED to `default`
// rather than replacing it, because the broker refuses a directed message
// unless sender and target share a room (`not_member`). Scoping by project
// *instead* of `default` would silently break cross-project talk.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_MAX_ROOMS_PER_PEER, DEFAULT_ROOM, ROOM_REGEX, normalizeRoomMode } from "../src/shared/config.js";
import {
  deriveProjectRoom,
  dropRecordedProjectRoom,
  isDerivedProjectRoomName,
  projectRootOf,
  resolveRoomScope,
  slugifyProjectName,
} from "../src/shared/project-room.js";
import { identityFromClient } from "../src/shared/identity-store.js";

const STATE = "/home/dev/zob/pi-mesh/.mesh";

describe("roomMode: deriveProjectRoom", () => {
  it("is deterministic — two sessions of one project must share the room", () => {
    assert.equal(deriveProjectRoom(STATE), deriveProjectRoom(STATE));
  });

  it("survives starting a session from a subdirectory", () => {
    // The state dir (not the cwd) is the identity, so a session launched in
    // src/ must not land in a room of its own.
    assert.equal(deriveProjectRoom("/home/dev/zob/pi-mesh/.mesh"), deriveProjectRoom("/home/dev/zob/pi-mesh/.mesh/"));
  });

  it("is always a valid room name", () => {
    for (const dir of ["/a/.mesh", "/a b/My Project/.mesh", "/x/Ünïcode-ß/.mesh", "/.mesh", "/x/.mesh"]) {
      const room = deriveProjectRoom(dir);
      assert.match(room, ROOM_REGEX, `${dir} → ${room}`);
      assert.ok(room.length <= 64);
    }
  });

  it("distinguishes two projects that share a basename", () => {
    const a = deriveProjectRoom("/home/dev/work/api/.mesh");
    const b = deriveProjectRoom("/home/dev/other/api/.mesh");
    assert.notEqual(a, b);
    assert.match(a, /^proj\.api\./);
    assert.match(b, /^proj\.api\./);
  });

  it("collapses an empty or unusable basename to a valid slug", () => {
    assert.equal(slugifyProjectName(""), "x");
    assert.equal(slugifyProjectName("!!!"), "x");
    assert.equal(slugifyProjectName("  "), "x");
    assert.equal(slugifyProjectName("My_Project 2"), "my-project-2");
    assert.equal(slugifyProjectName("---lead---"), "lead");
    assert.ok(slugifyProjectName("y".repeat(200)).length <= 24);
  });

  it("treats a custom state dir as the project itself", () => {
    assert.equal(projectRootOf("/tmp/custom-state"), "/tmp/custom-state");
    assert.equal(projectRootOf("/home/dev/proj/.mesh"), "/home/dev/proj");
    // a custom dir keeps its own name in the slug, not ".mesh"
    assert.match(deriveProjectRoom("/tmp/pi-mesh-state"), /^proj\.pi-mesh-state\./);
  });

  it("recognises only real derived names (a user-named room is never touched)", () => {
    assert.equal(isDerivedProjectRoomName("proj.api.abc123"), true);
    assert.equal(isDerivedProjectRoomName("proj.api.mine"), false); // no 6-hex suffix
    assert.equal(isDerivedProjectRoomName("proj.abc123"), false);
    assert.equal(isDerivedProjectRoomName("ops"), false);
  });
});

describe("roomMode: canonicalisation", () => {
  it("two spellings of the same directory derive ONE room", async () => {
    const { mkdtempSync, mkdirSync, symlinkSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "mesh-realpath-"));
    try {
      const real = join(root, "project");
      mkdirSync(join(real, ".mesh"), { recursive: true });
      const link = join(root, "link");
      symlinkSync(real, link);
      // A symlinked path (or /var vs /private/var on macOS) must not put two
      // sessions of the same project in two different rooms.
      assert.equal(deriveProjectRoom(join(link, ".mesh")), deriveProjectRoom(join(real, ".mesh")));
      assert.equal(deriveProjectRoom(join(real, ".mesh/")), deriveProjectRoom(join(real, ".mesh")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("roomMode: resolveRoomScope", () => {
  it('"default" reproduces the pre-roomMode behaviour exactly', () => {
    const scope = resolveRoomScope({ roomMode: "default", rooms: ["default", "ops"], stateDir: STATE });
    assert.deepEqual(scope.rooms, ["default", "ops"]);
    assert.equal(scope.projectRoom, undefined);
    assert.equal(scope.broadcastRoom, DEFAULT_ROOM);
  });

  it('"both" adds the project room AND keeps default', () => {
    const scope = resolveRoomScope({ roomMode: "both", rooms: ["default"], stateDir: STATE });
    assert.deepEqual(scope.rooms, ["default", deriveProjectRoom(STATE)]);
    assert.equal(scope.broadcastRoom, deriveProjectRoom(STATE));
  });

  it('"both" restores default when the persisted list lost it', () => {
    const scope = resolveRoomScope({ roomMode: "both", rooms: ["ops"], stateDir: STATE });
    assert.ok(scope.rooms.includes(DEFAULT_ROOM));
    assert.ok(scope.rooms.includes(deriveProjectRoom(STATE)));
  });

  it('"project" drops default (strict isolation) unless it is configured', () => {
    const strict = resolveRoomScope({ roomMode: "project", rooms: ["default"], stateDir: STATE });
    assert.deepEqual(strict.rooms, [deriveProjectRoom(STATE)]);

    const explicit = resolveRoomScope({
      roomMode: "project",
      rooms: ["default"],
      configuredRooms: ["default"],
      stateDir: STATE,
    });
    assert.deepEqual(explicit.rooms, ["default", deriveProjectRoom(STATE)]);
  });

  it("a pinned room list wins over roomMode (documented launcher contract)", () => {
    // config.ts: "the pinned list wins … a launcher can place an agent in a
    // room for good". Adding a derived room on top would break that, and the
    // pi-lifecycle test that encodes it.
    const scope = resolveRoomScope({ roomMode: "both", rooms: ["aso12"], pinned: true, stateDir: STATE });
    assert.deepEqual(scope.rooms, ["aso12"]);
    assert.equal(scope.projectRoom, undefined);
    // never DEFAULT_ROOM: the pin does not contain it, and broadcastRoom must
    // name a room this client is actually in.
    assert.equal(scope.broadcastRoom, "aso12");
    // the no-op is NOT silent — a documented option that does nothing is the
    // real bug, the precedence itself is fine.
    assert.equal(scope.degraded, "pinned");
  });

  it('a pin with roomMode "default" is not reported as degraded', () => {
    const scope = resolveRoomScope({ roomMode: "default", rooms: ["aso12"], pinned: true, stateDir: STATE });
    assert.equal(scope.degraded, undefined);
    assert.equal(scope.broadcastRoom, "aso12");
  });

  it("drops the ghost OUR project left at an earlier path", () => {
    // Same slug, different digest = the same project moved. That is the only
    // room this feature invented, so it is the only one it may remove.
    const current = deriveProjectRoom(STATE);
    const slug = current.slice("proj.".length, current.lastIndexOf("."));
    const ghost = `proj.${slug}.abc123`;
    const scope = resolveRoomScope({ roomMode: "both", rooms: ["default", ghost], stateDir: STATE });
    assert.equal(scope.rooms.includes(ghost), false);
    assert.ok(scope.rooms.includes(current));
  });

  it("never removes a room it did not invent", () => {
    // another project's derived name, joined on purpose, and a hand-typed one
    const scope = resolveRoomScope({
      roomMode: "both",
      rooms: ["default", "proj.other.ab12cd", "proj.mine"],
      stateDir: STATE,
    });
    assert.ok(scope.rooms.includes("proj.other.ab12cd"));
    assert.ok(scope.rooms.includes("proj.mine"));
  });

  it("an explicit /mesh leave default survives a restart in both mode", () => {
    // persisted ["proj.x"] with no default = the user left it; re-adding would
    // silently undo a deliberate action.
    const scope = resolveRoomScope({
      roomMode: "both",
      rooms: ["proj.other.ab12cd"],
      persistedRooms: true,
      stateDir: STATE,
    });
    assert.equal(scope.rooms.includes(DEFAULT_ROOM), false);
  });

  it("a fresh session still gets default in both mode", () => {
    const scope = resolveRoomScope({ roomMode: "both", rooms: [], persistedRooms: false, stateDir: STATE });
    assert.ok(scope.rooms.includes(DEFAULT_ROOM));
  });

  it("honours an explicit projectRoomName override", () => {
    const scope = resolveRoomScope({
      roomMode: "both",
      rooms: ["default"],
      projectRoomName: "proj.shared-team",
      stateDir: STATE,
    });
    assert.equal(scope.projectRoom, "proj.shared-team");
    assert.equal(scope.broadcastRoom, "proj.shared-team");
  });

  it("never exceeds maxRoomsPerPeer and says so instead of dropping rooms silently", () => {
    for (const n of [1, 10, 14, 15, 16]) {
      const rooms = Array.from({ length: n }, (_, i) => `r${i}`);
      const scope = resolveRoomScope({ roomMode: "both", rooms, maxRoomsPerPeer: DEFAULT_MAX_ROOMS_PER_PEER, stateDir: STATE });
      assert.ok(
        scope.rooms.length <= DEFAULT_MAX_ROOMS_PER_PEER,
        `${n} configured → ${scope.rooms.length} rooms exceeds the cap`,
      );
      if (n >= DEFAULT_MAX_ROOMS_PER_PEER - 1) {
        // The feature could not apply: it must report it, not pretend.
        // `broadcastRoom` then falls back to the legacy rule (default if it
        // survived, else the first joined room) — never the project room.
        assert.equal(scope.degraded, "room_cap");
        assert.notEqual(scope.broadcastRoom, deriveProjectRoom(STATE));
      } else {
        assert.equal(scope.degraded, undefined);
        assert.equal(scope.broadcastRoom, deriveProjectRoom(STATE));
      }
    }
  });

  it("keeps user-configured rooms when it has to shed for the cap", () => {
    const rooms = Array.from({ length: DEFAULT_MAX_ROOMS_PER_PEER }, (_, i) => `r${i}`);
    const scope = resolveRoomScope({ roomMode: "both", rooms, stateDir: STATE });
    for (const room of rooms) {
      if (scope.rooms.length === DEFAULT_MAX_ROOMS_PER_PEER) break;
    }
    // every configured room that survived must be a real one, and default is
    // shed before a user room.
    assert.equal(scope.rooms.includes(deriveProjectRoom(STATE)), false);
    assert.equal(scope.rooms[0], "r0");
  });
});

describe("roomMode: normalizeRoomMode", () => {
  it("accepts the three modes", () => {
    assert.equal(normalizeRoomMode("default"), "default");
    assert.equal(normalizeRoomMode("project"), "project");
    assert.equal(normalizeRoomMode("both"), "both");
    assert.equal(normalizeRoomMode("BOTH"), "both");
    assert.equal(normalizeRoomMode(" project "), "project");
  });

  it("falls back to the default for anything else — never reinterprets a typo", () => {
    for (const bad of ["projectt", "prob", "", null, undefined, 42, {}, []]) {
      assert.equal(normalizeRoomMode(bad), "both");
    }
  });
});

describe("roomMode: persistence keeps exact names, never patterns", () => {
  const client = {
    alias: "solo",
    rooms: ["default", "proj.pi-mesh.9b5d4a"],
    reservations: [],
    projectRoomName: "proj.pi-mesh.9b5d4a",
  };

  it("records the derived room it invented, exactly", () => {
    const identity = identityFromClient("ses-1", client);
    assert.deepEqual(identity.rooms, ["default", "proj.pi-mesh.9b5d4a"]);
    assert.equal(identity.projectRoom, "proj.pi-mesh.9b5d4a");
  });

  it("drops ONLY that recorded room on the next start", () => {
    const identity = identityFromClient("ses-1", client);
    const rooms = dropRecordedProjectRoom(identity.rooms, identity.projectRoom);
    assert.deepEqual(rooms, ["default"]);
  });

  it("a moved project leaves no ghost, and hand-joined rooms survive", () => {
    // The project moved: the recorded name is stale, and the user also joined
    // another project's derived room on purpose.
    const persisted = {
      rooms: ["default", "proj.pi-mesh.9b5d4a", "proj.other.ab12cd", "proj.mine"],
      projectRoom: "proj.pi-mesh.9b5d4a",
    };
    const rooms = dropRecordedProjectRoom(persisted.rooms, persisted.projectRoom);
    assert.equal(rooms.includes("proj.pi-mesh.9b5d4a"), false, "ghost must be dropped");
    assert.ok(rooms.includes("proj.other.ab12cd"), "another project's room is not ours to drop");
    assert.ok(rooms.includes("proj.mine"), "a hand-typed room must never be filtered");
  });

  it("works on an identity written before roomMode existed", () => {
    const rooms = dropRecordedProjectRoom(["default", "ops"], undefined);
    assert.deepEqual(rooms, ["default", "ops"]);
  });

  it("a session without a project room records no projectRoom field", () => {
    const identity = identityFromClient("ses-2", { alias: "solo", rooms: ["default"], reservations: [] });
    assert.equal(identity.projectRoom, undefined);
  });
});
