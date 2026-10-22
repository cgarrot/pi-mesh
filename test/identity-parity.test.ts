// test/identity-parity.test.ts — Pi parity for alias/room stability.
//
// The OpenCode adapter learned to KEEP the chosen alias across a conflict
// fallback (persisted preferredAlias + reclaim loop); the Pi adapter did not.
// These tests drive the Pi-side primitives against a REAL broker:
//   1. a fallback persists alias=<fallback> AND preferredAlias=<chosen>,
//   2. the next attach retries the chosen alias and gets it,
//   3. the reclaim loop takes the name back without a reload,
//   4. the loop never renames mid-turn nor with a live mission pending.
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { describe, it } from "node:test";
import { MeshClient } from "../src/client/client.js";
import { startAliasReclaim } from "../src/extension/reclaim.js";
import { chooseInitialIdentity, identityFromClient, MeshIdentity } from "../src/shared/identity-store.js";
import { makeTempDirs, startTestBroker, waitFor } from "./helpers.js";

const SID = "019fdead-1111-7000-8000-0000000000aa";

describe("Pi parity: conflict fallback keeps the chosen alias", () => {
  it("fallback → save → next attach retries and wins the preferred alias", async () => {
    const dirs = makeTempDirs("mesh-pi-parity-");
    const broker = await startTestBroker(dirs.runtimeDir);
    const identity = new MeshIdentity(dirs.stateDir);
    const holder = new MeshClient({ alias: "aso-12", runtimeDir: dirs.runtimeDir });
    await holder.connect();
    try {
      // first attach: the alias is held by the ghost → random fallback
      const first = new MeshClient({ alias: "aso-12", runtimeDir: dirs.runtimeDir });
      await first.connect();
      assert.notEqual(first.alias, "aso-12", "the conflict forced a fallback");
      // the Pi save path: chosen alias travels WITH the fallback
      identity.save(identityFromClient(SID, first, "aso-12"));
      await first.close();

      const stored = identity.load(SID);
      assert.equal(stored?.alias.startsWith("agent-"), true);
      assert.equal(stored?.preferredAlias, "aso-12");

      // the holder disconnects → the next attach takes the chosen name back
      await holder.close();
      const choice = chooseInitialIdentity({ rooms: ["default"] }, stored);
      assert.equal(choice.alias, "aso-12");
      const second = new MeshClient({ alias: choice.alias, rooms: choice.rooms, runtimeDir: dirs.runtimeDir });
      await second.connect();
      assert.equal(second.alias, "aso-12", "the chosen alias self-healed at attach");
      await second.close();
    } finally {
      await holder.close().catch(() => {});
      await broker.close();
      dirs.cleanup();
    }
  });
});

describe("Pi parity: alias reclaim loop", () => {
  it("reclaims the preferred alias as soon as the holder disconnects", async () => {
    const dirs = makeTempDirs("mesh-pi-reclaim-");
    const broker = await startTestBroker(dirs.runtimeDir);
    const holder = new MeshClient({ alias: "aso-77", runtimeDir: dirs.runtimeDir });
    await holder.connect();
    const fallback = new MeshClient({ alias: "aso-77", runtimeDir: dirs.runtimeDir });
    const reclaimed: string[] = [];
    const handle = startAliasReclaim({
      client: fallback,
      preferredAlias: () => "aso-77",
      onReclaimed: (alias) => reclaimed.push(alias),
      intervalMs: 40,
    });
    try {
      await fallback.connect();
      assert.notEqual(fallback.alias, "aso-77");
      // holder alive → blocked (never steals a live alias)
      assert.equal(await handle.tick(), "blocked");
      await holder.close();
      // Wait for the EVENT, not for client.alias: rename() sets the alias
      // optimistically before the re-hello ack and reverts it on
      // alias_taken, so polling the alias can observe a rename that has not
      // completed yet (onReclaimed not called).
      await waitFor(() => (reclaimed.length === 1 ? true : undefined), 5_000);
      assert.equal(fallback.alias, "aso-77");
      assert.deepEqual(reclaimed, ["aso-77"], "onReclaimed fires exactly once for the rename");
    } finally {
      handle.stop();
      await fallback.close().catch(() => {});
      await holder.close().catch(() => {});
      await broker.close();
      dirs.cleanup();
    }
  });

  it("never renames mid-turn or while a mission is pending", async () => {
    const dirs = makeTempDirs("mesh-pi-reclaim-gate-");
    const broker = await startTestBroker(dirs.runtimeDir);
    const holder = new MeshClient({ alias: "aso-88", runtimeDir: dirs.runtimeDir });
    await holder.connect();
    const client = new MeshClient({ alias: "aso-88", runtimeDir: dirs.runtimeDir });
    let busy = false;
    const handle = startAliasReclaim({
      client,
      preferredAlias: () => "aso-88",
      isBusy: () => busy,
      onReclaimed: () => {},
      intervalMs: 0, // manual ticks only
    });
    try {
      await client.connect();
      await holder.close();
      busy = true;
      assert.equal(await handle.tick(), "blocked", "busy turn → no rename");
      busy = false;
      assert.equal(await handle.tick(), "reclaimed");
      assert.equal(client.alias, "aso-88");
    } finally {
      handle.stop();
      await client.close().catch(() => {});
      await holder.close().catch(() => {});
      await broker.close();
      dirs.cleanup();
    }
  });
});
