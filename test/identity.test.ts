// test/identity.test.ts — D23: mesh identity persistence across /reload.
// The pi sessionId is stable across reloads; alias/rooms/reservations are
// persisted in <stateDir>/identity.json and re-loaded by the next session.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MeshClient } from "../src/client/client.js";
import {
  chooseInitialIdentity,
  PENDING_TTL_MS,
  identityFileExists,
  identityFromClient,
  identityPath,
  MeshIdentity,
  RESERVATION_TTL_MS,
  saveIdentityOf,
} from "../src/shared/identity-store.js";
import { makeTempDirs, startTestBroker, waitFor, type TempDirs } from "./helpers.js";

function tmpStateDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mesh-identity-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const SID = "019fdead-0000-7000-8000-000000000001";

describe("MeshIdentity persistence", () => {
  it("save → load roundtrip (same sessionId)", () => {
    const { dir, cleanup } = tmpStateDir();
    try {
      const id = new MeshIdentity(dir);
      const now = new Date().toISOString();
      id.save({
        version: 1,
        sessionId: SID,
        alias: "agent-7",
        rooms: ["default", "ops"],
        reservations: [{ pattern: "web/x.js", reason: "integrating", since: now }],
        updatedAt: now,
      });
      const loaded = id.load(SID);
      assert.equal(loaded?.alias, "agent-7");
      assert.deepEqual(loaded?.rooms, ["default", "ops"]);
      assert.equal(loaded?.reservations[0]?.pattern, "web/x.js");
      assert.ok(identityFileExists(dir, SID));
    } finally {
      cleanup();
    }
  });

  it("different sessionId → null (fresh identity for a new session)", () => {
    const { dir, cleanup } = tmpStateDir();
    try {
      const id = new MeshIdentity(dir);
      id.save(identityFromClient(SID, {
        alias: "agent-1",
        rooms: ["default"],
        reservations: [],
      }));
      assert.equal(id.load("019fdead-0000-7000-8000-000000000002"), null);
      assert.equal(id.load(""), null);
    } finally {
      cleanup();
    }
  });

  it("expired reservations are dropped at load (TTL)", () => {
    const { dir, cleanup } = tmpStateDir();
    try {
      const id = new MeshIdentity(dir);
      const old = new Date(Date.now() - RESERVATION_TTL_MS - 60_000).toISOString();
      const fresh = new Date(Date.now() - 60_000).toISOString();
      id.save({
        version: 1,
        sessionId: SID,
        alias: "agent-1",
        rooms: ["default"],
        reservations: [
          { pattern: "web/stale.js", since: old },
          { pattern: "web/fresh.js", since: fresh },
        ],
        updatedAt: fresh,
      });
      const loaded = id.load(SID);
      assert.deepEqual(
        loaded?.reservations.map((r) => r.pattern),
        ["web/fresh.js"],
      );
    } finally {
      cleanup();
    }
  });

  it("corrupt file → null (graceful)", () => {
    const { dir, cleanup } = tmpStateDir();
    try {
      writeFileSync(identityPath(dir, SID), "{not json", "utf8");
      assert.equal(new MeshIdentity(dir).load(SID), null);
    } finally {
      cleanup();
    }
  });

  it("sessions sharing a stateDir do NOT overwrite each other (the multi-agent bug)", () => {
    const { dir, cleanup } = tmpStateDir();
    try {
      const id = new MeshIdentity(dir);
      const sidA = "019faaaa-0000-7000-8000-000000000001";
      const sidB = "019faaaa-0000-7000-8000-000000000002";
      id.save(identityFromClient(sidA, { alias: "agent-1", rooms: ["cs-room"], reservations: [] }));
      id.save(identityFromClient(sidB, { alias: "agent-2", rooms: ["cs-room"], reservations: [] }));
      // agent-2's save must NOT clobber agent-1's file
      assert.equal(id.load(sidA)?.alias, "agent-1");
      assert.equal(id.load(sidB)?.alias, "agent-2");
      assert.equal(identityFileExists(dir, sidA), true);
      assert.equal(identityFileExists(dir, sidB), true);
    } finally {
      cleanup();
    }
  });

  it("legacy single-file identity.json is migrated to the per-session file", () => {
    const { dir, cleanup } = tmpStateDir();
    try {
      // write the legacy format (v0.1.3-v0.1.7: one file, sessionId inside)
      writeFileSync(
        identityPath(dir, "").replace("identity-.json", "identity.json"),
        JSON.stringify(identityFromClient(SID, { alias: "agent-1", rooms: ["cs-room"], reservations: [] })),
        "utf8",
      );
      const id = new MeshIdentity(dir);
      const loaded = id.load(SID);
      assert.equal(loaded?.alias, "agent-1");
      assert.deepEqual(loaded?.rooms, ["cs-room"]);
      assert.ok(identityFileExists(dir, SID), "migrated to per-session file");
    } finally {
      cleanup();
    }
  });
});

describe("identity reload E2E (simulated /reload)", () => {
  let dirs: TempDirs;
  let broker: Awaited<ReturnType<typeof startTestBroker>>;
  let bob: MeshClient;

  before(async () => {
    dirs = makeTempDirs("mesh-id-e2e-");
    broker = await startTestBroker(dirs.runtimeDir);
    bob = new MeshClient({ alias: "bob", runtimeDir: dirs.runtimeDir });
    await bob.connect();
  });

  after(async () => {
    await bob.close().catch(() => {});
    await broker.close();
    rmSync(dirs.root, { recursive: true, force: true });
  });

  it("a new client reloading the persisted identity gets alias+rooms+reservations back", async () => {
    const stateDir = dirs.stateDir;
    const id = new MeshIdentity(stateDir);

    // "session" 1: alice joins ops, reserves a file, persists identity
    const alice = new MeshClient({ alias: "alice", rooms: ["default"], runtimeDir: dirs.runtimeDir });
    await alice.connect();
    await alice.join("ops");
    await alice.reserve(["web/viewer.js"], "reload test");
    id.save(identityFromClient(SID, alice));
    await alice.close(); // broker purges everything with the connection

    // "session" 2 (after /reload — same sessionId): reload the identity
    const persisted = id.load(SID);
    assert.equal(persisted?.alias, "alice");
    assert.ok(persisted?.rooms.includes("ops"));

    const alice2 = new MeshClient({
      alias: persisted?.alias,
      rooms: persisted?.rooms,
      initialReservations: persisted?.reservations,
      runtimeDir: dirs.runtimeDir,
    });
    await alice2.connect();

    // the identity is fully restored on the broker
    const snap = await alice2.status();
    const self = snap.peers.find((p) => p.alias === "alice");
    assert.ok(self?.rooms.includes("ops"));
    await waitFor(() => (bob.reservationsOf("alice").length > 0 ? true : undefined));
    assert.equal(bob.reservationsOf("alice")[0]?.pattern, "web/viewer.js");
    await alice2.close();
  });
});

describe("client: alias_taken fallback", () => {
  it("connect with a taken alias falls back to a random alias (no infinite loop)", async () => {
    const dirs = makeTempDirs("mesh-aliastaken-");
    const broker = await startTestBroker(dirs.runtimeDir);
    const holder = new MeshClient({ alias: "taken", runtimeDir: dirs.runtimeDir });
    await holder.connect();
    try {
      const fallback = new MeshClient({ alias: "taken", runtimeDir: dirs.runtimeDir });
      const fellBack = new Promise<{ from: string; to: string }>((resolve) => {
        fallback.on("alias_fallback", (e: { from: string; to: string }) => resolve(e));
      });
      const welcome = await fallback.connect();
      assert.equal(welcome.alias, fallback.alias);
      assert.notEqual(fallback.alias, "taken");
      assert.ok(fallback.isOnline());
      const fallbackEvent = await fellBack;
      assert.equal(fallbackEvent.from, "taken");
      // the original holder is untouched
      assert.equal(holder.alias, "taken");
      await fallback.close();
    } finally {
      await holder.close();
      await broker.close();
      rmSync(dirs.root, { recursive: true, force: true });
    }
  });
});

describe("MeshIdentity.reset (D28: /mesh reset)", () => {
  it("removes the per-session identity file; load → null", () => {
    const { dir, cleanup } = tmpStateDir();
    try {
      const id = new MeshIdentity(dir);
      id.save(identityFromClient(SID, { alias: "agent-1", rooms: ["cs-room"], reservations: [] }));
      assert.equal(id.load(SID)?.alias, "agent-1");
      id.reset(SID);
      assert.equal(id.load(SID), null);
      assert.equal(identityFileExists(dir, SID), false);
    } finally {
      cleanup();
    }
  });

  it("reset only removes THIS session's identity (others untouched)", () => {
    const { dir, cleanup } = tmpStateDir();
    try {
      const id = new MeshIdentity(dir);
      const sidA = "019faaaa-0000-7000-8000-0000000000a1";
      const sidB = "019faaaa-0000-7000-8000-0000000000a2";
      id.save(identityFromClient(sidA, { alias: "agent-1", rooms: ["cs-room"], reservations: [] }));
      id.save(identityFromClient(sidB, { alias: "agent-2", rooms: ["cs-room"], reservations: [] }));
      id.reset(sidA);
      assert.equal(id.load(sidA), null);
      assert.equal(id.load(sidB)?.alias, "agent-2", "other sessions keep their identity");
    } finally {
      cleanup();
    }
  });
});

describe("reset E2E (D28): fresh client after reset", () => {
  it("close + identity.reset + new client → new alias, default rooms, no reservations", async () => {
    const dirs = makeTempDirs("mesh-reset-e2e-");
    const broker = await startTestBroker(dirs.runtimeDir);
    const stateDir = dirs.stateDir;
    const id = new MeshIdentity(stateDir);

    // session 1: persistent identity with cs-room + a reservation
    const first = new MeshClient({
      alias: "agent-1",
      rooms: ["cs-room"],
      runtimeDir: dirs.runtimeDir,
    });
    await first.connect();
    await first.join("cs-room");
    await first.reserve(["web/x.js"], "reset me");
    id.save(identityFromClient(SID, first));
    await first.close();

    // the reset itself: identity wiped, fresh client spawned
    id.reset(SID);
    assert.equal(id.load(SID), null);

    const second = new MeshClient({
      alias: undefined, // random — like /new
      rooms: ["default"],
      runtimeDir: dirs.runtimeDir,
    });
    await second.connect();

    assert.notEqual(second.alias, "agent-1");
    assert.deepEqual(second.rooms, ["default"]);
    assert.equal(second.reservations.length, 0);
    // broker agrees: the new peer is only in default
    const snap = await second.status();
    const self = snap.peers.find((p) => p.alias === second.alias);
    assert.deepEqual(self?.rooms, ["default"]);
    await second.close();
    await broker.close();
    rmSync(dirs.root, { recursive: true, force: true });
  });
});

describe("identity pending handoff (D30: /mesh new)", () => {
  it("savePending → consumePending transfers identity + history (old sessionId ignored)", () => {
    const { dir, cleanup } = tmpStateDir();
    try {
      const id = new MeshIdentity(dir);
      const sidA = "019faaaa-0000-7000-8000-0000000000b1";
      id.savePending(
        identityFromClient(sidA, { alias: "agent-1", rooms: ["cs-room"], reservations: [{ pattern: "web/x.js", since: new Date().toISOString() }] }),
        ["10:00 msg agent-1→agent-2 MISSION", "10:05 reply agent-2→agent-1 done"],
      );
      // consumed by a DIFFERENT session (new sessionId)
      const taken = id.consumePending();
      assert.equal(taken?.identity.alias, "agent-1");
      assert.deepEqual(taken?.identity.rooms, ["cs-room"]);
      assert.equal(taken?.identity.reservations[0]?.pattern, "web/x.js");
      assert.deepEqual(taken?.history, ["10:00 msg agent-1→agent-2 MISSION", "10:05 reply agent-2→agent-1 done"]);
      assert.equal(id.consumePending(), null, "file cleared after consume");
    } finally {
      cleanup();
    }
  });

  it("stale pending (older than TTL) is dropped", () => {
    const { dir, cleanup } = tmpStateDir();
    try {
      const id = new MeshIdentity(dir);
      const stale = identityFromClient("019faaaa-0000-7000-8000-0000000000b2", {
        alias: "agent-1",
        rooms: ["cs-room"],
        reservations: [],
      });
      stale.updatedAt = new Date(Date.now() - PENDING_TTL_MS - 60_000).toISOString();
      id.savePending(stale);
      assert.equal(id.consumePending(), null);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Pi parity: the chosen alias must survive a conflict fallback, and the
// /mesh new / fork handoff must be bound to its intended child session.
// (The OpenCode adapter had both; the Pi adapter wrote the fallback and lost
// the chosen name — "my agent keeps changing name and room".)
// ---------------------------------------------------------------------------

describe("identity: preferredAlias survives every save (Pi write path)", () => {
  it("identityFromClient carries preferredAlias and parse preserves it", () => {
    const { dir, cleanup } = tmpStateDir();
    try {
      const id = new MeshIdentity(dir);
      // a conflict fallback: connected as the random alias, chosen one kept
      const persisted = identityFromClient(
        SID,
        { alias: "agent-abc123", rooms: ["aso12"], reservations: [] },
        "aso-12",
      );
      assert.equal(persisted.preferredAlias, "aso-12");
      id.save(persisted);
      const loaded = id.load(SID);
      assert.equal(loaded?.alias, "agent-abc123");
      assert.equal(loaded?.preferredAlias, "aso-12", "preferred alias must NOT be wiped by a save");
      assert.deepEqual(loaded?.rooms, ["aso12"]);
    } finally {
      cleanup();
    }
  });

  it("save → reload → retry preferred: the attach choice is the chosen alias", () => {
    const { dir, cleanup } = tmpStateDir();
    try {
      const id = new MeshIdentity(dir);
      id.save(identityFromClient(SID, { alias: "agent-abc123", rooms: ["aso12"], reservations: [] }, "aso-12"));
      const choice = chooseInitialIdentity({ rooms: ["default"] }, id.load(SID));
      assert.equal(choice.alias, "aso-12", "preferred alias is retried at attach");
      assert.equal(choice.preferredAlias, "aso-12");
      assert.deepEqual(choice.rooms, ["aso12"], "persisted rooms win over defaults");
      assert.equal(choice.reason, "preferred");
    } finally {
      cleanup();
    }
  });
});

describe("identity: naming precedence (alias + rooms)", () => {
  const persisted = {
    version: 1 as const,
    sessionId: SID,
    alias: "agent-fallback",
    preferredAlias: "aso-12",
    rooms: ["aso12"],
    reservations: [],
    updatedAt: new Date().toISOString(),
  };

  it("explicit config alias wins over the persisted preference", () => {
    const choice = chooseInitialIdentity({ alias: "pinned", rooms: ["default"] }, persisted);
    assert.equal(choice.alias, "pinned");
    assert.equal(choice.preferredAlias, "pinned");
    assert.equal(choice.reason, "config-alias");
  });

  it("a PINNED room list (MESH_ROOMS / roomsPinned) wins over stale persisted rooms", () => {
    const choice = chooseInitialIdentity(
      { rooms: ["aso12"], roomsPinned: true },
      { ...persisted, rooms: ["default"] },
    );
    assert.deepEqual(choice.rooms, ["aso12"], "an explicit room pin must not be overridden by disk state");
  });

  it("without a pin, live membership survives the reload", () => {
    const choice = chooseInitialIdentity({ rooms: ["default"] }, persisted);
    assert.deepEqual(choice.rooms, ["aso12"]);
  });

  it("a fresh session gets the configured rooms", () => {
    const choice = chooseInitialIdentity({ rooms: ["aso12"] }, null);
    assert.equal(choice.alias, undefined);
    assert.deepEqual(choice.rooms, ["aso12"]);
    assert.equal(choice.reason, "fresh");
  });
});

describe("identity: named agent slot (identityKey)", () => {
  it("one slot survives a NEW session id (restart/new conversation)", () => {
    const { dir, cleanup } = tmpStateDir();
    try {
      const id = new MeshIdentity(dir);
      const oldSession = "019faaaa-0000-7000-8000-0000000000c1";
      const newSession = "019faaaa-0000-7000-8000-0000000000c2";
      id.save(
        identityFromClient(oldSession, { alias: "aso-12", rooms: ["aso12"], reservations: [] }, "aso-12"),
        "aso12",
      );
      assert.equal(id.load(newSession), null, "per-session identity does not leak");
      const slot = id.load(newSession, "aso12");
      assert.equal(slot?.alias, "aso-12");
      assert.equal(slot?.preferredAlias, "aso-12");
      assert.deepEqual(slot?.rooms, ["aso12"]);
      assert.notEqual(id.fileFor(newSession, "aso12"), id.fileFor(newSession), "slot file is its own path");
    } finally {
      cleanup();
    }
  });

  it("reset wipes the slot, and an invalid key cannot escape the stateDir", () => {
    const { dir, cleanup } = tmpStateDir();
    try {
      const id = new MeshIdentity(dir);
      id.save(identityFromClient(SID, { alias: "aso-12", rooms: ["aso12"], reservations: [] }), "aso12");
      id.reset(SID, "aso12");
      assert.equal(id.load(SID, "aso12"), null);
      assert.equal(id.load(SID, "../escape"), null, "path traversal key is refused");
    } finally {
      cleanup();
    }
  });
});

describe("identity handoff: bound to the intended child session", () => {
  const parent = "/tmp/mesh-parent-session.jsonl";
  const other = "/tmp/mesh-other-session.jsonl";

  it("another new session in the same stateDir can NOT steal alias+rooms", () => {
    const { dir, cleanup } = tmpStateDir();
    try {
      const id = new MeshIdentity(dir);
      id.savePending(
        identityFromClient(SID, { alias: "aso-12", rooms: ["aso12"], reservations: [] }, "aso-12"),
        undefined,
        { forParent: parent },
      );
      // an unrelated session (no parent) and a sibling's child: both refused
      assert.equal(id.consumePending({ parentFile: undefined }), null);
      assert.equal(id.consumePending({ parentFile: other }), null);
      // the intended child takes it exactly once
      const taken = id.consumePending({ parentFile: parent });
      assert.equal(taken?.identity.alias, "aso-12");
      assert.deepEqual(taken?.identity.rooms, ["aso12"]);
      assert.equal(id.consumePending({ parentFile: parent }), null);
    } finally {
      cleanup();
    }
  });

  it("legacy (unbound) handoffs keep the single-consumer behavior", () => {
    const { dir, cleanup } = tmpStateDir();
    try {
      const id = new MeshIdentity(dir);
      id.savePending(identityFromClient(SID, { alias: "legacy", rooms: ["room-a"], reservations: [] }));
      assert.equal(id.consumePending({ parentFile: other })?.identity.alias, "legacy");
    } finally {
      cleanup();
    }
  });
});

describe("identity: single write path (saveIdentityOf)", () => {
  it("reservation / rename / shutdown saves all keep preferredAlias + slot key", () => {
    const { dir, cleanup } = tmpStateDir();
    try {
      const id = new MeshIdentity(dir);
      const rt = {
        sessionId: SID,
        preferredAlias: "aso-12",
        identityKey: "aso12",
        client: { alias: "agent-fallback", rooms: ["aso12"], reservations: [] },
      };
      saveIdentityOf(id, rt);
      const stored = id.load(SID, "aso12");
      assert.equal(stored?.alias, "agent-fallback");
      assert.equal(stored?.preferredAlias, "aso-12", "a reserve/release save must not erase the chosen alias");
      assert.deepEqual(stored?.rooms, ["aso12"]);
      // a later plain per-session save must not appear (slot is its own file)
      assert.equal(id.load(SID), null);
    } finally {
      cleanup();
    }
  });
});
