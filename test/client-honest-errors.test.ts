// test/client-honest-errors.test.ts — regression tests for the honest
// round-trip error codes and the alias-fallback re-arm:
//   1. a CLOSED client answers shutting_down (close is final for sends),
//   2. an offline client whose connect fails surfaces the REAL reason
//      (broker_unavailable) — not a blanket "shutting_down",
//   3. a client that fell back to a random alias once can fall back AGAIN
//      on a future conflict (it used to stay offline forever),
//   4. forgetRoom drops a room locally for offline hosts.
import test from "node:test";
import assert from "node:assert/strict";
import { MeshClient } from "../src/client/client.js";
import { DEFAULT_CONFIG } from "../src/shared/config.js";
import { makeTempDirs, startTestBroker, waitFor, sleep } from "./helpers.js";

test("closed client: leave answers shutting_down (close is final for sends)", async (t) => {
  const dirs = makeTempDirs("honest-closed-");
  const broker = await startTestBroker(dirs.runtimeDir);
  t.after(async () => {
    await broker.close();
    dirs.cleanup();
  });
  const client = new MeshClient({ alias: "closed-x", runtimeDir: dirs.runtimeDir, config: DEFAULT_CONFIG });
  await client.connect();
  await client.close();
  await assert.rejects(client.leave("default"), /shutting_down/);
});

test("offline client with failing connect surfaces the real reason, not shutting_down", async (t) => {
  const dirs = makeTempDirs("honest-offline-");
  // the client's internal timers are unref'd — keep the loop alive
  const keepAlive = setInterval(() => {}, 100);
  t.after(() => {
    clearInterval(keepAlive);
    delete process.env.MESH_BROKER_ENTRY;
    dirs.cleanup();
  });
  // Force ensureBroker's fork to fail: the entry override points nowhere,
  // so connect() rejects broker_unavailable instead of spawning anything.
  process.env.MESH_BROKER_ENTRY = "/nonexistent/mesh-broker.js";
  const client = new MeshClient({ alias: "off-x", runtimeDir: dirs.runtimeDir, config: DEFAULT_CONFIG });
  await assert.rejects(client.leave("default"), /broker_unavailable/);
});

test("alias fallback re-arms after a successful connect (no permanent offline)", async (t) => {
  const dirs = makeTempDirs("honest-fallback-");
  const broker = await startTestBroker(dirs.runtimeDir);
  const keepAlive = setInterval(() => {}, 100);
  t.after(async () => {
    clearInterval(keepAlive);
    await broker.close();
    dirs.cleanup();
  });

  // A holds the alias; B falls back to a random one (first fallback).
  const a = new MeshClient({ alias: "fb-x", runtimeDir: dirs.runtimeDir, config: DEFAULT_CONFIG });
  await a.connect();
  const b = new MeshClient({ alias: "fb-x", runtimeDir: dirs.runtimeDir, config: DEFAULT_CONFIG });
  await b.connect();
  const firstFallback = b.alias;
  assert.notEqual(firstFallback, "fb-x");
  assert.ok(b.isOnline());

  // Simulate a hard socket drop on B with the auto-reconnect BLOCKED, so a
  // third client can DETERMINISTICALLY grab B's fallback alias mid-gap.
  const internals = b as unknown as { intentionallyClosed: boolean; socket: { destroy(): void } };
  internals.intentionallyClosed = true; // block the reconnect timer
  internals.socket.destroy();
  await sleep(250); // let the broker reap the dead connection
  const c = new MeshClient({ alias: firstFallback, runtimeDir: dirs.runtimeDir, config: DEFAULT_CONFIG });
  await c.connect();
  assert.equal(c.alias, firstFallback);

  // B reconnects manually: its alias is taken by C → without the re-arm
  // fix it would throw alias_taken forever and stay offline.
  internals.intentionallyClosed = false;
  await b.connect();
  assert.ok(b.isOnline());
  assert.notEqual(b.alias, "fb-x");
  assert.notEqual(b.alias, firstFallback);
  await c.close();
  await b.close();
  await a.close();
});

test("forgetRoom drops the room locally (offline leave)", async () => {
  const dirs = makeTempDirs("honest-forget-");
  const client = new MeshClient({
    alias: "forget-x",
    rooms: ["default", "zoma"],
    runtimeDir: dirs.runtimeDir,
    config: DEFAULT_CONFIG,
  });
  assert.deepEqual([...client.rooms], ["default", "zoma"]);
  client.forgetRoom("default");
  assert.deepEqual([...client.rooms], ["zoma"]);
  dirs.cleanup();
});
