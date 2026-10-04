// test/cli-rooms.test.ts — Phase 0 regression (B1): join/leave/reserve ARE
// dispatched in main() (they were defined but unreachable — README promised
// them). Spawns the BUILT CLI against a hermetic broker like a user would.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDirs, startTestBroker } from "./helpers.js";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli", "mesh.js");

// Hermetic child env: strip every MESH_* override that could leak the test
// toward a REAL broker (env wins over config — an inherited MESH_BROKER_URL
// once made these tests join rooms and reserve paths on the live mesh).
const SCRUB_ENV_KEYS = [
  "MESH_BROKER_URL",
  "MESH_BROKER_TOKEN",
  "MESH_LISTEN",
  "MESH_TLS_CERT",
  "MESH_TLS_KEY",
  "MESH_TLS_CA",
  "MESH_TLS_INSECURE",
  "MESH_POLICY",
  "MESH_ALIAS",
  "MESH_ROOMS",
];

function hermeticEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // scrub the INHERITED env only, then merge the test's explicit values
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const key of SCRUB_ENV_KEYS) delete base[key];
  return { ...base, ...extra };
}

interface CliResult {
  code: number;
  out: string;
  err: string;
}

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: hermeticEnv(env),
    });
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

test("cli join/leave/reserve are dispatched against a live broker (B1)", async () => {
  const dirs = makeTempDirs("cli-rooms-");
  const broker = await startTestBroker(dirs.runtimeDir);
  try {
    const env = { MESH_RUNTIME_DIR: dirs.runtimeDir, MESH_STATE_DIR: dirs.stateDir };

    const join = await runCli(["join", "ops"], env);
    assert.equal(join.code, 0, `stderr: ${join.err}`);
    assert.match(join.out, /joined ops/);

    // Each invocation spawns a FRESH ephemeral alias (cli-<rand6>) — room
    // membership is connection-scoped, so a leave in another process is
    // honestly refused (not_member), never a silent success. This locks
    // the debug-only semantics documented in the CLI plan (§2.2).
    const leave = await runCli(["leave", "ops"], env);
    assert.equal(leave.code, 1);
    assert.match(leave.err, /not_member/);

    const reserve = await runCli(["reserve", "src/a.ts", "--reason", "phase0-test"], env);
    assert.equal(reserve.code, 0, `stderr: ${reserve.err}`);
    // regression (review #1): the --reason VALUE must never be reserved as a
    // phantom path — only src/a.ts is claimed.
    assert.match(reserve.out, /^reserved src\/a\.ts$/m);
    assert.doesNotMatch(reserve.out, /phase0-test\)/);
    assert.doesNotMatch(reserve.out, /a\.ts, phase0-test/);
    // honest scoping note (review B3): the claim dies with the connection
    assert.match(reserve.out, /connection-scoped/);
  } finally {
    await broker.close();
    dirs.cleanup();
  }
});

test("cli unknown command exits 2 with usage", async () => {
  const dirs = makeTempDirs("cli-usage-");
  try {
    const res = await runCli(["frobnicate"], {
      MESH_RUNTIME_DIR: dirs.runtimeDir,
      MESH_STATE_DIR: dirs.stateDir,
    });
    assert.equal(res.code, 2);
    assert.match(res.err, /usage:/);
    // the usage now documents the previously unreachable commands
    assert.match(res.err, /join/);
    assert.match(res.err, /reserve/);
  } finally {
    dirs.cleanup();
  }
});
