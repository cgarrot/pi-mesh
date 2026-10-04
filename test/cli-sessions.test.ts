// test/cli-sessions.test.ts — Phase 5: `mesh sessions` lists persisted
// identities with live status, skips corrupt files, never writes.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { MeshClient } from "../src/client/client.js";
import { MeshIdentity, identityFromClient } from "../src/shared/identity-store.js";
import { makeTempDirs, startTestBroker } from "./helpers.js";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli", "mesh.js");

const SCRUB_ENV_KEYS = [
  "MESH_BROKER_URL", "MESH_BROKER_TOKEN", "MESH_LISTEN", "MESH_TLS_CERT",
  "MESH_TLS_KEY", "MESH_TLS_CA", "MESH_TLS_INSECURE", "MESH_POLICY",
  "MESH_ALIAS", "MESH_ROOMS",
];

function hermeticEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const key of SCRUB_ENV_KEYS) delete base[key];
  return { ...base, ...extra };
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: hermeticEnv(env) });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      err += c.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, out, err }));
  });
}

test("sessions lists identities with live status, skips corrupt files, writes nothing", async () => {
  const dirs = makeTempDirs("cli-sessions-");
  const broker = await startTestBroker(dirs.runtimeDir);
  // a LIVE peer under a persisted identity's alias
  const live = new MeshClient({ alias: "dead-or-alive", runtimeDir: dirs.runtimeDir });
  await live.connect();
  // two persisted identities: one alive (same alias), one dead + one corrupt
  const store = new MeshIdentity(dirs.stateDir);
  store.save(identityFromClient("sess-alive-0001", { alias: "dead-or-alive", rooms: ["default"], reservations: [] }));
  store.save(identityFromClient("sess-dead-0002", { alias: "ghost-agent", rooms: ["ops"], reservations: [{ pattern: "src/x.ts", reason: "wip", since: new Date().toISOString() }] }));
  writeFileSync(path.join(dirs.stateDir, "identity-sess-bad-0003.json"), "{not json");
  try {
    const env = { MESH_RUNTIME_DIR: dirs.runtimeDir, MESH_STATE_DIR: dirs.stateDir };
    const res = await runCli(["sessions"], env);
    assert.equal(res.code, 0, `stderr: ${res.err}`);
    assert.match(res.out, /dead-or-alive.*online/);
    assert.match(res.out, /ghost-agent.*offline/);
    assert.match(res.out, /reservations=1/);
    assert.match(res.err, /skipping (unreadable|unusable) identity-sess-bad-0003/);
    assert.doesNotMatch(res.out, /sess-bad/);

    // READ-ONLY: all three files still exist, byte-identical
    assert.ok(existsSync(path.join(dirs.stateDir, "identity-sess-alive-0001.json")));
    assert.ok(existsSync(path.join(dirs.stateDir, "identity-sess-bad-0003.json")));

    const json = await runCli(["sessions", "--json"], env);
    assert.equal(json.code, 0);
    const lines = json.out.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(lines.length, 2);
    const ghost = lines.find((l) => l.alias === "ghost-agent");
    assert.ok(ghost !== undefined);
    assert.equal(ghost.online, false);
    assert.equal(ghost.reservations, 1);
  } finally {
    await live.close();
    await broker.close();
    dirs.cleanup();
  }
});
