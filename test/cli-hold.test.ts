// test/cli-hold.test.ts — Phase 4: reserve dry-run conflicts (exit 4),
// --hold keeps the claim alive and Ctrl-C releases it, release one-shot is
// an honest no-op.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { MeshClient } from "../src/client/client.js";
import { makeTempDirs, startTestBroker, sleep, waitFor } from "./helpers.js";

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
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const key of SCRUB_ENV_KEYS) delete base[key];
  return { ...base, ...extra };
}

interface Child {
  child: ReturnType<typeof spawn>;
  out: string;
  err: string;
  done: Promise<number>;
}

function spawnCli(args: string[], env: NodeJS.ProcessEnv): Child {
  const child = spawn(process.execPath, [CLI, ...args], { env: hermeticEnv(env) });
  // accumulate into an object and expose via getters: a shorthand
  // { out, err } would snapshot the EMPTY strings at return time (strings
  // are immutable — the += in the handlers rebinds locals, not properties)
  const acc = { out: "", err: "" };
  child.stdout.on("data", (c: Buffer) => {
    acc.out += c.toString("utf8");
  });
  child.stderr.on("data", (c: Buffer) => {
    acc.err += c.toString("utf8");
  });
  const done = new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? -1));
  });
  return {
    child,
    get out(): string {
      return acc.out;
    },
    get err(): string {
      return acc.err;
    },
    done,
  };
}

/** Await an (async) predicate — helpers.waitFor is sync-only: an async
 * predicate returns a Promise, which is truthy and would pass instantly. */
async function until(fn: () => Promise<boolean> | boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error("until: timeout");
    await sleep(100);
  }
}

test("reserve dry-run reports peer conflicts and exits 4 (honest partial)", async () => {
  const dirs = makeTempDirs("cli-hold1-");
  const broker = await startTestBroker(dirs.runtimeDir);
  const holder = new MeshClient({ alias: "holder", runtimeDir: dirs.runtimeDir });
  await holder.connect();
  await holder.reserve(["src/shared.ts"], "mine");
  await sleep(300); // let the reserve broadcast settle
  try {
    const env = { MESH_RUNTIME_DIR: dirs.runtimeDir, MESH_STATE_DIR: dirs.stateDir };
    const proc = spawnCli(["reserve", "src/shared.ts", "--reason", "mine-too"], env);
    const code = await proc.done;
    assert.equal(code, 4, `out: ${proc.out}\nerr: ${proc.err}`);
    assert.match(proc.out, /reserved src\/shared\.ts/);
    assert.match(proc.err, /conflict: src\/shared\.ts held by @holder/);
    assert.match(proc.out, /released on exit/);
  } finally {
    await holder.close();
    await broker.close();
    dirs.cleanup();
  }
});

test("reserve --hold keeps the claim; SIGINT releases it cleanly (exit 0)", async () => {
  const dirs = makeTempDirs("cli-hold2-");
  const broker = await startTestBroker(dirs.runtimeDir);
  const observer = new MeshClient({ alias: "observer", runtimeDir: dirs.runtimeDir });
  await observer.connect();
  try {
    const env = { MESH_RUNTIME_DIR: dirs.runtimeDir, MESH_STATE_DIR: dirs.stateDir };
    const proc = spawnCli(["reserve", "src/held.ts", "--reason", "holding", "--hold", "60000"], env);

    // the claim becomes visible to peers…
    await until(async () => {
      const snap = await observer.status();
      return snap.peers.some((p) => (p.reservations ?? []).some((r) => r.pattern === "src/held.ts"));
    });
    assert.match(proc.out, /holding for 60s/);

    // Ctrl-C → release + clean exit 0
    proc.child.kill("SIGINT");
    const code = await proc.done;
    assert.equal(code, 0, `out: ${proc.out}\nerr: ${proc.err}`);
    assert.match(proc.out, /releasing/);

    // …and the claim is gone
    await until(async () => {
      const snap = await observer.status();
      return !snap.peers.some((p) => (p.reservations ?? []).some((r) => r.pattern === "src/held.ts"));
    });
  } finally {
    await observer.close();
    await broker.close();
    dirs.cleanup();
  }
});

test("reserve --hold out of bounds exits 2 before any claim", async () => {
  const dirs = makeTempDirs("cli-hold3-");
  try {
    const env = { MESH_RUNTIME_DIR: dirs.runtimeDir, MESH_STATE_DIR: dirs.stateDir };
    const proc = spawnCli(["reserve", "src/x.ts", "--hold", "99999999999"], env);
    const code = await proc.done;
    assert.equal(code, 2);
    assert.match(proc.err, /invalid --hold/);
  } finally {
    dirs.cleanup();
  }
});

test("release one-shot: honest no-op (a fresh process holds nothing)", async () => {
  const dirs = makeTempDirs("cli-hold4-");
  const broker = await startTestBroker(dirs.runtimeDir);
  try {
    const env = { MESH_RUNTIME_DIR: dirs.runtimeDir, MESH_STATE_DIR: dirs.stateDir };
    const proc = spawnCli(["release", "src/whatever.ts"], env);
    const code = await proc.done;
    assert.equal(code, 0, `err: ${proc.err}`);
    assert.match(proc.out, /released nothing/);
    assert.match(proc.out, /connection-scoped/);
  } finally {
    await broker.close();
    dirs.cleanup();
  }
});
