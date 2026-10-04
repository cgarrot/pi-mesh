// test/cli-help.test.ts — --help contract: every command exits 0 and prints
// usage; bad usage exits 2 with the reason on stderr.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDirs } from "./helpers.js";

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

test("mesh --help and help exit 0 with usage on stdout", async () => {
  const dirs = makeTempDirs("cli-help-");
  const env = { MESH_RUNTIME_DIR: dirs.runtimeDir, MESH_STATE_DIR: dirs.stateDir };
  try {
    for (const args of [["--help"], ["help"]]) {
      const res = await runCli(args, env);
      assert.equal(res.code, 0);
      assert.match(res.out, /usage: mesh <command>/);
    }
    const perCommand = await runCli(["help", "send"], env);
    assert.equal(perCommand.code, 0);
    assert.match(perCommand.out, /usage: mesh send/);
    assert.match(perCommand.out, /--await/);
  } finally {
    dirs.cleanup();
  }
});

test("per-command --help exits 0", async () => {
  const dirs = makeTempDirs("cli-help2-");
  const env = { MESH_RUNTIME_DIR: dirs.runtimeDir, MESH_STATE_DIR: dirs.stateDir };
  try {
    for (const cmd of ["peers", "send", "join", "leave", "reserve"]) {
      const res = await runCli([cmd, "--help"], env);
      assert.equal(res.code, 0, `${cmd} --help failed: ${res.err}`);
      assert.match(res.out, /usage: mesh/);
    }
  } finally {
    dirs.cleanup();
  }
});

test("usage errors exit 2 with the reason on stderr", async () => {
  const dirs = makeTempDirs("cli-help3-");
  const env = { MESH_RUNTIME_DIR: dirs.runtimeDir, MESH_STATE_DIR: dirs.stateDir };
  try {
    const unknown = await runCli(["--frobnicate"], env); // unknown option on no command → treated as command
    assert.equal(unknown.code, 2);
    assert.match(unknown.err, /usage:/);

    const badOpt = await runCli(["peers", "--nope"], env);
    assert.equal(badOpt.code, 2);
    assert.match(badOpt.err, /unknown option: --nope/);

    const noText = await runCli(["send", "only-alias"], env);
    assert.equal(noText.code, 2);
    assert.match(noText.err, /usage: mesh send/);
  } finally {
    dirs.cleanup();
  }
});

test("validation table is wired: bad room/alias exit 2 before any connection", async () => {
  const dirs = makeTempDirs("cli-help5-");
  const env = { MESH_RUNTIME_DIR: dirs.runtimeDir, MESH_STATE_DIR: dirs.stateDir };
  try {
    const badRoom = await runCli(["peers", "--room", "BAD ROOM!"], env);
    assert.equal(badRoom.code, 2);
    assert.match(badRoom.err, /invalid room/);

    const badAlias = await runCli(["send", "@Not Valid!", "hi"], env);
    assert.equal(badAlias.code, 2);
    assert.match(badAlias.err, /invalid alias/);

    const badJoin = await runCli(["join", "Ünïcode"], env);
    assert.equal(badJoin.code, 2);
    assert.match(badJoin.err, /invalid room/);
  } finally {
    dirs.cleanup();
  }
});

test("send rejects a non-numeric --timeout before any connection (known-edge fixed)", async () => {
  const dirs = makeTempDirs("cli-help4-");
  const env = { MESH_RUNTIME_DIR: dirs.runtimeDir, MESH_STATE_DIR: dirs.stateDir };
  try {
    const res = await runCli(["send", "someone", "hi", "--timeout", "abc"], env);
    assert.equal(res.code, 2);
    assert.match(res.err, /invalid --timeout/);
  } finally {
    dirs.cleanup();
  }
});
