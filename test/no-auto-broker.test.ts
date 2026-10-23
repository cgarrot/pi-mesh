// test/no-auto-broker.test.ts — MESH_NO_AUTO_BROKER=1 makes a connect with no
// broker FAIL instead of spawning a detached one. Hermetic harnesses (and any
// embedder that owns its broker) must be able to say "do not spawn".
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import { MeshClient } from "../src/client/client.js";
import { brokerSocketPathOf, makeTempDirs, startTestBroker } from "./helpers.js";

describe("MESH_NO_AUTO_BROKER: no silent auto-spawn", () => {
  it("connect rejects with broker_unavailable and spawns nothing", async (t) => {
    const dirs = makeTempDirs();
    t.after(() => dirs.cleanup());
    const previous = process.env.MESH_NO_AUTO_BROKER;
    process.env.MESH_NO_AUTO_BROKER = "1";
    const client = new MeshClient({ alias: "hermetic", runtimeDir: dirs.runtimeDir, config: {}, noReconnect: true });
    t.after(async () => {
      await client.close().catch(() => {});
      if (previous === undefined) delete process.env.MESH_NO_AUTO_BROKER;
      else process.env.MESH_NO_AUTO_BROKER = previous;
    });

    await assert.rejects(client.connect(), /broker_unavailable|auto-spawn is disabled/);
    // The whole point: no socket, no broker process was created.
    assert.equal(existsSync(brokerSocketPathOf(dirs.runtimeDir)), false, "no broker socket must appear");
  });

  it("an ALREADY running broker still connects (only the spawn is disabled)", async (t) => {
    const dirs = makeTempDirs();
    const broker = await startTestBroker(dirs.runtimeDir);
    t.after(async () => {
      await broker.close();
      dirs.cleanup();
    });
    const previous = process.env.MESH_NO_AUTO_BROKER;
    process.env.MESH_NO_AUTO_BROKER = "1";
    const client = new MeshClient({ alias: "joiner", runtimeDir: dirs.runtimeDir, config: {}, noReconnect: true });
    t.after(async () => {
      await client.close().catch(() => {});
      if (previous === undefined) delete process.env.MESH_NO_AUTO_BROKER;
      else process.env.MESH_NO_AUTO_BROKER = previous;
    });
    await client.connect();
    assert.equal(client.isOnline(), true);
  });
});
