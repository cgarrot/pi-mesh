// test/cli-send.test.ts — Phase 2: send/reply/ping/wait against a hermetic
// broker with an in-process auto-responder. Locks the D5 exit contract.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { MeshClient } from "../src/client/client.js";
import type { MeshFrame } from "../src/protocol/envelope.js";
import { makeTempDirs, startTestBroker, sleep } from "./helpers.js";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli", "mesh.js");

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

/** Auto-replying peer: answers every inbound msg with "pong: <body>". */
async function startResponder(runtimeDir: string, alias = "responder"): Promise<MeshClient> {
  const client = new MeshClient({ alias, runtimeDir });
  await client.connect();
  client.on("inbound", (f: MeshFrame) => {
    if (f.type === "msg" && f.from !== undefined && f.id !== undefined) {
      void client.reply(f.id, `pong: ${f.body ?? ""}`);
    }
  });
  return client;
}

test("cli send: delivered (0), await-reply (0), force-without-reason (2)", async () => {
  const dirs = makeTempDirs("cli-send-");
  const broker = await startTestBroker(dirs.runtimeDir);
  const responder = await startResponder(dirs.runtimeDir);
  try {
    const env = { MESH_RUNTIME_DIR: dirs.runtimeDir, MESH_STATE_DIR: dirs.stateDir };

    const fire = await runCli(["send", "responder", "hello"], env);
    assert.equal(fire.code, 0, `stderr: ${fire.err}`);
    assert.match(fire.out, /^delivered m_/);

    const awaited = await runCli(["send", "responder", "ping-me", "--await", "--timeout", "5000"], env);
    assert.equal(awaited.code, 0, `stderr: ${awaited.err}`);
    assert.match(awaited.out, /^reply m_.*: pong: ping-me/);

    const force = await runCli(["send", "responder", "move", "--priority", "force"], env);
    assert.equal(force.code, 2);
    assert.match(force.err, /requires --reason/);
  } finally {
    await responder.close();
    await broker.close();
    dirs.cleanup();
  }
});

test("cli send: queued_offline exits 4 (honest partial), 1 with --require-online", async () => {
  const dirs = makeTempDirs("cli-queued-");
  const broker = await startTestBroker(dirs.runtimeDir);
  // ghost: connects once (becomes a known alias), then goes offline
  const ghost = new MeshClient({ alias: "ghost", runtimeDir: dirs.runtimeDir });
  await ghost.connect();
  await ghost.close();
  try {
    const env = { MESH_RUNTIME_DIR: dirs.runtimeDir, MESH_STATE_DIR: dirs.stateDir };
    const queued = await runCli(["send", "ghost", "later"], env);
    assert.equal(queued.code, 4, `out: ${queued.out}`);
    assert.match(queued.out, /^queued_offline m_/);

    const strict = await runCli(["send", "ghost", "later", "--require-online"], env);
    assert.equal(strict.code, 1);
  } finally {
    await broker.close();
    dirs.cleanup();
  }
});

test("cli send: unknown alias is blocked peer_not_found (1), never a fake delivery", async () => {
  const dirs = makeTempDirs("cli-unknown-");
  const broker = await startTestBroker(dirs.runtimeDir);
  // a second live peer so the room has members, but the TARGET never existed
  const responder = await startResponder(dirs.runtimeDir);
  try {
    const env = { MESH_RUNTIME_DIR: dirs.runtimeDir, MESH_STATE_DIR: dirs.stateDir };
    const res = await runCli(["send", "never-was", "hi"], env);
    assert.equal(res.code, 1);
    assert.match(res.out, /blocked: peer_not_found/);
  } finally {
    await responder.close();
    await broker.close();
    dirs.cleanup();
  }
});

test("cli send --broadcast: honest counts, reply fan-in works", async () => {
  const dirs = makeTempDirs("cli-bcast-");
  const broker = await startTestBroker(dirs.runtimeDir);
  const responder = await startResponder(dirs.runtimeDir);
  try {
    const env = { MESH_RUNTIME_DIR: dirs.runtimeDir, MESH_STATE_DIR: dirs.stateDir };
    const res = await runCli(["send", "room update", "--broadcast"], env);
    assert.equal(res.code, 0, `stderr: ${res.err}`);
    assert.match(res.out, /delivered \d+\/\d+ m_/);
  } finally {
    await responder.close();
    await broker.close();
    dirs.cleanup();
  }
});

test("cli send --alias collision: honest alias_taken (1), no fallback identity", async () => {
  const dirs = makeTempDirs("cli-strict-");
  const broker = await startTestBroker(dirs.runtimeDir);
  const holder = await startResponder(dirs.runtimeDir, "held-name");
  try {
    const env = { MESH_RUNTIME_DIR: dirs.runtimeDir, MESH_STATE_DIR: dirs.stateDir };
    const res = await runCli(["send", "responder-x", "hi", "--alias", "held-name"], env);
    assert.equal(res.code, 1);
    assert.match(res.out, /blocked: alias_taken/);
  } finally {
    await holder.close();
    await broker.close();
    dirs.cleanup();
  }
});

test("cli ping: reply (0) and expired (3) — expired never claims the peer is down", async () => {
  const dirs = makeTempDirs("cli-ping-");
  const broker = await startTestBroker(dirs.runtimeDir);
  const responder = await startResponder(dirs.runtimeDir);
  // silent: connected, receives, but never replies
  const silent = new MeshClient({ alias: "silent", runtimeDir: dirs.runtimeDir });
  await silent.connect();
  try {
    const env = { MESH_RUNTIME_DIR: dirs.runtimeDir, MESH_STATE_DIR: dirs.stateDir };
    const ok = await runCli(["ping", "responder", "--timeout", "5000"], env);
    assert.equal(ok.code, 0, `stderr: ${ok.err}`);
    assert.match(ok.out, /^reply m_.*: pong: ping$/m);

    const expired = await runCli(["ping", "silent", "--timeout", "25"], env);
    assert.equal(expired.code, 3);
    assert.match(expired.out, /^expired m_/);
  } finally {
    await silent.close();
    await responder.close();
    await broker.close();
    dirs.cleanup();
  }
});

test("cli reply one-shot: --to/--room required (2), delivers with both (0)", async () => {
  const dirs = makeTempDirs("cli-reply-");
  const broker = await startTestBroker(dirs.runtimeDir);
  const responder = await startResponder(dirs.runtimeDir);
  try {
    const env = { MESH_RUNTIME_DIR: dirs.runtimeDir, MESH_STATE_DIR: dirs.stateDir };
    const noTo = await runCli(["reply", "m_x_abc", "an answer"], env);
    assert.equal(noTo.code, 2);
    assert.match(noTo.err, /exactly one of --to \/ --reply-all are required/);

    const delivered = await runCli(["reply", "m_x_abc", "an answer", "--to", "responder", "--room", "default"], env);
    assert.equal(delivered.code, 0, `stderr: ${delivered.err}`);
    assert.match(delivered.out, /^delivered m_/m);

    const fanout = await runCli(["reply", "m_x_abc", "for everyone", "--reply-all", "--room", "default"], env);
    assert.equal(fanout.code, 0, `stderr: ${fanout.err}`);
    assert.match(fanout.out, /delivered \d+\/\d+ m_/);

    const badRoom = await runCli(["reply", "m_x_abc", "x", "--to", "responder", "--room", "BAD ROOM!"], env);
    assert.equal(badRoom.code, 2);
    assert.match(badRoom.err, /invalid room/);
  } finally {
    await responder.close();
    await broker.close();
    dirs.cleanup();
  }
});

test("cli wait: honest no-missions message (0)", async () => {
  const dirs = makeTempDirs("cli-wait-");
  const broker = await startTestBroker(dirs.runtimeDir);
  try {
    const env = { MESH_RUNTIME_DIR: dirs.runtimeDir, MESH_STATE_DIR: dirs.stateDir };
    const res = await runCli(["wait", "--timeout", "1000"], env);
    assert.equal(res.code, 0, `stderr: ${res.err}`);
    assert.match(res.out, /no awaited missions in this process/);
  } finally {
    await broker.close();
    dirs.cleanup();
  }
});

test("cli send stdin body via trailing dash", async () => {
  const dirs = makeTempDirs("cli-stdin-");
  const broker = await startTestBroker(dirs.runtimeDir);
  const responder = await startResponder(dirs.runtimeDir);
  try {
    const env = { MESH_RUNTIME_DIR: dirs.runtimeDir, MESH_STATE_DIR: dirs.stateDir };
    const res = await new Promise<{ code: number; out: string; err: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, "send", "responder", "-", "--await", "--timeout", "5000"], {
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
      child.stdin.write("body from stdin");
      child.stdin.end();
    });
    assert.equal(res.code, 0, `stderr: ${res.err}`);
    assert.match(res.out, /: pong: body from stdin/);
  } finally {
    await responder.close();
    await broker.close();
    dirs.cleanup();
  }
});
