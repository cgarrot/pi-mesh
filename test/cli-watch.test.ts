// test/cli-watch.test.ts — Phase 4: the observer stream. The critical
// assertion is REDACTION (plan D8): a broadcast msg carries a body on the
// wire, and `watch` must NEVER print it — text or --json.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { MeshClient } from "../src/client/client.js";
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
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const key of SCRUB_ENV_KEYS) delete base[key];
  return { ...base, ...extra };
}

test("watch --json streams frames and NEVER prints bodies (D8 redaction)", async () => {
  const dirs = makeTempDirs("cli-watch1-");
  const broker = await startTestBroker(dirs.runtimeDir);
  const member = new MeshClient({ alias: "member", runtimeDir: dirs.runtimeDir });
  await member.connect();
  try {
    const env = { MESH_RUNTIME_DIR: dirs.runtimeDir, MESH_STATE_DIR: dirs.stateDir };
    const child = spawn(process.execPath, [CLI, "watch", "default", "--json"], { env: hermeticEnv(env) });
    let out = "";
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    let err = "";
    child.stderr.on("data", (c: Buffer) => {
      err += c.toString("utf8");
    });
    const done = new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? -1)));

    // let the watcher join, then broadcast a message WITH a body
    await sleep(800);
    await member.send({ message: "secret-body-must-not-leak", broadcast: true, room: "default" });
    await sleep(800);

    child.kill("SIGINT");
    const code = await done;
    // POSIX: handler exits 0. Windows: no signal delivery (hard kill) —
    // the redaction content is the cross-platform contract.
    if (process.platform !== "win32") assert.equal(code, 0, `err: ${err}`);
    assert.match(out, /"type":"watch-start"/);
    assert.match(out, /"role":"observer"/);

    // the broadcast msg frame MUST appear as an event…
    const lines = out.trim().split("\n").filter((l) => l.includes('"type":"msg"'));
    assert.ok(lines.length > 0, `no msg frame in output: ${out}`);
    // …with the body REDACTED everywhere
    assert.doesNotMatch(out, /secret-body-must-not-leak/, "BODY LEAKED in watch output");
    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      assert.equal(parsed.body, undefined, "body key present in a msg frame");
      assert.ok(parsed.bodyHash === undefined || typeof parsed.bodyHash === "string");
    }
  } finally {
    await member.close();
    await broker.close();
    dirs.cleanup();
  }
});

test("watch text mode shows events, hides bodies, SIGINT exits 0", async () => {
  const dirs = makeTempDirs("cli-watch2-");
  const broker = await startTestBroker(dirs.runtimeDir);
  const member = new MeshClient({ alias: "member", runtimeDir: dirs.runtimeDir });
  await member.connect();
  let late: MeshClient | null = null;
  try {
    const env = { MESH_RUNTIME_DIR: dirs.runtimeDir, MESH_STATE_DIR: dirs.stateDir };
    const child = spawn(process.execPath, [CLI, "watch"], { env: hermeticEnv(env) });
    let out = "";
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    const done = new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? -1)));

    await sleep(800);
    await member.send({ message: "classified-body", broadcast: true, room: "default" });
    await member.reserve(["watched.ts"], "demo");
    // a NEW peer joining default AFTER the watcher started → the presence
    // broadcast is observable by the watcher (join("side") would not be)
    late = new MeshClient({ alias: "late-joiner", runtimeDir: dirs.runtimeDir });
    await late.connect();
    await sleep(900);

    child.kill("SIGINT");
    const code = await done;
    if (process.platform !== "win32") assert.equal(code, 0);
    assert.match(out, /watching room "default"/);
    assert.match(out, /presence/);
    assert.match(out, /msg/);
    assert.doesNotMatch(out, /classified-body/);
  } finally {
    if (late !== null) await late.close().catch(() => {});
    await member.close();
    await broker.close();
    dirs.cleanup();
  }
});

test("watch --alias collision: honest alias_taken (exit 1)", async () => {
  const dirs = makeTempDirs("cli-watch3-");
  const broker = await startTestBroker(dirs.runtimeDir);
  const holder = new MeshClient({ alias: "taken", runtimeDir: dirs.runtimeDir });
  await holder.connect();
  try {
    const env = { MESH_RUNTIME_DIR: dirs.runtimeDir, MESH_STATE_DIR: dirs.stateDir };
    const child = spawn(process.execPath, [CLI, "watch", "--alias", "taken"], { env: hermeticEnv(env) });
    let out = "";
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    const done = new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? -1)));
    const code = await done;
    assert.equal(code, 1);
    assert.match(out, /blocked: alias_taken/);
  } finally {
    await holder.close();
    await broker.close();
    dirs.cleanup();
  }
});
