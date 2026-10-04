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
  PENDING_TTL_MS,
  identityFileExists,
  identityFromClient,
  identityPath,
  MeshIdentity,
  RESERVATION_TTL_MS,
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
