// test/broker-exec.test.ts — $MESH_BROKER_EXEC_PATH regression suite (#8).
// A compiled host (omp, SEA, bun-compiled app) sets process.execPath to the
// HOST BINARY: forking/spawning the broker with it re-runs the host instead
// of the broker. These tests prove the override is honored end-to-end:
//   1. client auto-spawn (ensureBroker) with an explicit exec works,
//      then a full message/reply round-trip goes through that broker,
//   2. a FOREIGN exec (wrapper script standing in for a pinned runtime) is
//      the one that actually runs the entry — with exactly one argument,
//      no inherited host launch flags (posix only),
//   3. `mesh broker start` honors the override,
//   4. `mesh doctor` prints the resolved brokerExec for diagnosis.
import { spawn } from "node:child_process";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { brokerEntryPath, connectProbe, ensureBroker } from "../src/client/reconnect.js";
import { brokerLockPath, brokerSocketPath } from "../src/shared/paths.js";
import { makeTempDirs, RawClient, sleep, waitFor, withKeepAlive, type TempDirs } from "./helpers.js";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli", "mesh.js");

// The REAL compiled broker entry (tests run from dist/test after build).
const REAL_ENTRY = brokerEntryPath();

interface SpawnedBroker {
  sock: string;
  pid: number;
}

/** Kill a broker started via ensureBroker/CLI (lock pid + socket cleanup). */
async function stopSpawnedBroker(dirs: TempDirs): Promise<void> {
  try {
    const pid = Number(readFileSync(brokerLockPath(dirs.runtimeDir), "utf8").trim());
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already gone
      }
      await waitFor(() => {
        try {
          process.kill(pid, 0);
          return undefined;
        } catch {
          return true;
        }
      }, 3000);
    }
  } catch {
    // no lock — nothing to kill
  }
  rmSync(brokerSocketPath(dirs.runtimeDir), { force: true });
}

test("#8 (1) auto-spawn via $MESH_BROKER_EXEC_PATH + full msg/reply round-trip", async (t) => {
  const dirs = makeTempDirs("mesh-exec-rt-");
  // Hermetic: the spawned child broker reads state from MESH_STATE_DIR and
  // honors MESH_RUNTIME_DIR (set by spawnBroker itself).
  process.env.MESH_STATE_DIR = dirs.stateDir;
  process.env.MESH_BROKER_EXEC_PATH = process.execPath; // explicit pin
  delete process.env.MESH_BROKER_ENTRY;
  t.after(async () => {
    await stopSpawnedBroker(dirs);
    delete process.env.MESH_STATE_DIR;
    delete process.env.MESH_BROKER_EXEC_PATH;
    dirs.cleanup();
  });

  // withKeepAlive: ensureBroker's internal timers are unref'd — an isolated
  // test process would drain its event loop before the spawn poll finishes.
  const sock = await withKeepAlive(ensureBroker(dirs.runtimeDir));
  assert.ok(await connectProbe(sock, 500), "broker socket must answer after override spawn");

  // message/reply round-trip through the override-spawned broker
  const a = await RawClient.connect(sock);
  const b = await RawClient.connect(sock);
  t.after(() => {
    a.close();
    b.close();
  });
  a.hello("exec-rt-a");
  b.hello("exec-rt-b");
  await a.waitFrame((f) => f.type === "welcome");
  await b.waitFrame((f) => f.type === "welcome");

  a.send({ type: "msg", from: "exec-rt-a", to: "exec-rt-b", body: "ping #8" });
  const msg = await b.waitFrame((f) => f.type === "msg" && f.from === "exec-rt-a");
  assert.equal(msg.body, "ping #8");

  b.send({ type: "reply", from: "exec-rt-b", to: "exec-rt-a", body: "pong #8", replyTo: msg.id });
  const reply = await a.waitFrame((f) => f.type === "reply" && f.from === "exec-rt-b");
  assert.equal(reply.body, "pong #8");
  assert.equal(reply.replyTo, msg.id);
});

test("#8 (2) foreign exec is the one that runs the entry — exactly one arg, no host flags", async (t) => {
  if (process.platform === "win32") {
    t.skip("wrapper script test is posix-only");
    return;
  }
  const dirs = makeTempDirs("mesh-exec-wrap-");
  // A wrapper standing in for a pinned foreign runtime (bun, omp shim…):
  // it records how it was invoked, then execs the real node binary.
  const markerCount = path.join(dirs.root, "wrap-count");
  const markerArg1 = path.join(dirs.root, "wrap-arg1");
  const wrapper = path.join(dirs.root, "wrap.sh");
  writeFileSync(
    wrapper,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$#" > ${JSON.stringify(markerCount)}`,
      `printf '%s\\n' "$1" > ${JSON.stringify(markerArg1)}`,
      `exec ${JSON.stringify(process.execPath)} "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(wrapper, 0o755);

  process.env.MESH_STATE_DIR = dirs.stateDir;
  process.env.MESH_BROKER_EXEC_PATH = wrapper;
  delete process.env.MESH_BROKER_ENTRY;
  t.after(async () => {
    await stopSpawnedBroker(dirs);
    delete process.env.MESH_STATE_DIR;
    delete process.env.MESH_BROKER_EXEC_PATH;
    dirs.cleanup();
  });

  const sock = await withKeepAlive(ensureBroker(dirs.runtimeDir));
  assert.ok(await connectProbe(sock, 500), "broker must come up via the wrapper exec");

  // The wrapper — NOT process.execPath — ran the entry…
  const count = readFileSync(markerCount, "utf8").trim();
  // …with exactly one argument (the entry) and no inherited launch flags.
  assert.equal(count, "1", "foreign runtime must receive the entry and nothing else");
  assert.equal(readFileSync(markerArg1, "utf8").trim(), REAL_ENTRY);
});

test("#8 (3) `mesh broker start` honors $MESH_BROKER_EXEC_PATH", async (t) => {
  const dirs = makeTempDirs("mesh-exec-cli-");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MESH_STATE_DIR: dirs.stateDir,
    MESH_RUNTIME_DIR: dirs.runtimeDir,
    MESH_BROKER_EXEC_PATH: process.execPath,
    MESH_BROKER_ENTRY: REAL_ENTRY,
  };
  for (const key of [
    "MESH_BROKER_URL",
    "MESH_BROKER_TOKEN",
    "MESH_LISTEN",
    "MESH_ALIAS",
    "MESH_ROOMS",
  ]) {
    delete env[key];
  }
  t.after(async () => {
    await stopSpawnedBroker(dirs);
    dirs.cleanup();
  });

  const res = await new Promise<{ code: number; out: string; err: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, "broker", "start"], { env });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => resolve({ code: code ?? -1, out, err }));
    child.on("error", reject);
  });
  assert.equal(res.code, 0, `broker start must succeed (out=${res.out} err=${res.err})`);

  const sock = brokerSocketPath(dirs.runtimeDir);
  let up = false; // bounded poll — `broker start` returns before the socket binds
  up = await withKeepAlive((async () => {
    for (let i = 0; i < 50; i += 1) {
      if (await connectProbe(sock, 300)) return true;
      await sleep(250); // give the detached broker time to bind
    }
    return false;
  })());
  assert.ok(up, "broker socket must answer after CLI start");
});

test("#8 (4) `mesh doctor` prints the resolved brokerExec", async () => {
  const dirs = makeTempDirs("mesh-exec-doc-");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MESH_STATE_DIR: dirs.stateDir,
    MESH_RUNTIME_DIR: dirs.runtimeDir,
    MESH_BROKER_EXEC_PATH: "/opt/foreign/runtime",
  };
  const res = await new Promise<{ out: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, "doctor"], { env });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("close", () => resolve({ out }));
    child.on("error", reject);
  });
  assert.match(res.out, /brokerExec: \/opt\/foreign\/runtime/);
  dirs.cleanup();
});
