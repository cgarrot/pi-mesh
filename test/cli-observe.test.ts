// test/cli-observe.test.ts — Phase 3: ledger filters, tail -f (real follow),
// status --reservations, config show token masking. All hermetic.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { MeshClient } from "../src/client/client.js";
import { makeTempDirs, startTestBroker } from "./helpers.js";

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
  // scrub the INHERITED env only, then merge the test's explicit values —
  // an explicit extra (e.g. MESH_BROKER_TOKEN for the masking test) must
  // survive the scrub of the ambient one.
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const key of SCRUB_ENV_KEYS) delete base[key];
  return { ...base, ...extra };
}

function runCli(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 15_000): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: hermeticEnv(env) });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      err += c.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, out, err });
    });
  });
}

/** Kill a long-running child (tail -f) and collect what it printed. */
function killAfter(child: { kill: (s: NodeJS.Signals) => void }, ms: number): void {
  setTimeout(() => child.kill("SIGINT"), ms);
}

test("mesh ledger: filters, limit, rotations oldest-first", async () => {
  const dirs = makeTempDirs("cli-ledger-");
  mkdirSync(dirs.stateDir, { recursive: true });
  const rec = (event: string, from: string, to: string, n: number): string =>
    JSON.stringify({ schema: "mesh.ledger.v1", event, from, to, room: "default", id: `m_x${n}`, ts: new Date(2026, 0, 1, 0, 0, n).toISOString(), bodyStored: false });
  // rotation (older) + current (newer)
  writeFileSync(path.join(dirs.stateDir, "ledger-2026-01-01.jsonl.1"), [rec("sent", "alice", "bob", 1), rec("delivered", "bob", "alice", 2)].join("\n") + "\n");
  writeFileSync(path.join(dirs.stateDir, "ledger.jsonl"), [rec("sent", "carol", "bob", 3), rec("reply", "bob", "carol", 4), rec("sent", "alice", "carol", 5)].join("\n") + "\n");
  try {
    const env = { MESH_RUNTIME_DIR: dirs.runtimeDir, MESH_STATE_DIR: dirs.stateDir };

    const all = await runCli(["ledger"], env);
    assert.equal(all.code, 0);
    assert.equal(all.out.trim().split("\n").length, 5); // rotations + current, oldest first

    const fromAlice = await runCli(["ledger", "--from", "alice"], env);
    const aliceLines = fromAlice.out.trim().split("\n");
    assert.equal(aliceLines.length, 2);
    assert.ok(aliceLines.every((l) => l.includes('"from":"alice"')));

    const replies = await runCli(["ledger", "--event", "reply"], env);
    assert.equal(replies.out.trim().split("\n").length, 1);
    assert.match(replies.out, /"event":"reply"/);

    const limited = await runCli(["ledger", "--limit", "2"], env);
    assert.equal(limited.out.trim().split("\n").length, 2);
    // the LAST records, not the first
    assert.match(limited.out, /m_x5/);
    assert.doesNotMatch(limited.out, /m_x1/);

    const bad = await runCli(["ledger", "--limit", "999"], env);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /invalid --limit/);
  } finally {
    dirs.cleanup();
  }
});

test("mesh tail -f: backlog then streams appended records", async () => {
  const dirs = makeTempDirs("cli-tailf-");
  mkdirSync(dirs.stateDir, { recursive: true });
  const ledger = path.join(dirs.stateDir, "ledger.jsonl");
  writeFileSync(ledger, JSON.stringify({ event: "sent", from: "alice", ts: "2026-01-01T00:00:00Z" }) + "\n");
  try {
    const env = { MESH_RUNTIME_DIR: dirs.runtimeDir, MESH_STATE_DIR: dirs.stateDir };
    const child = spawn(process.execPath, [CLI, "tail", "-f"], { env: hermeticEnv(env) });
    let out = "";
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    // after the backlog had time to print, append two records
    await new Promise((r) => setTimeout(r, 700));
    appendFileSync(ledger, JSON.stringify({ event: "reply", from: "bob", ts: "2026-01-01T00:00:01Z" }) + "\n");
    appendFileSync(ledger, JSON.stringify({ event: "blocked", from: "carol", ts: "2026-01-01T00:00:02Z" }) + "\n");
    killAfter(child, 1200);
    const code = await new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? -1)));
    assert.equal(code, 0, "SIGINT exits 0 (agreed outcome)");
    assert.match(out, /"event":"sent"/); // backlog
    assert.match(out, /"event":"reply"/); // streamed
    assert.match(out, /"event":"blocked"/); // streamed
  } finally {
    dirs.cleanup();
  }
});

test("mesh status --reservations shows peer claims with age; stale = alias", async () => {
  const dirs = makeTempDirs("cli-status-");
  const broker = await startTestBroker(dirs.runtimeDir);
  const holder = new MeshClient({ alias: "holder", runtimeDir: dirs.runtimeDir });
  await holder.connect();
  await holder.reserve(["src/owned.ts"], "working on it");
  try {
    const env = { MESH_RUNTIME_DIR: dirs.runtimeDir, MESH_STATE_DIR: dirs.stateDir };
    const res = await runCli(["status", "--reservations"], env);
    assert.equal(res.code, 0, `stderr: ${res.err}`);
    assert.match(res.out, /holder/);
    assert.match(res.out, /src\/owned\.ts/);
    assert.match(res.out, /working on it/);

    const stale = await runCli(["stale"], env);
    assert.equal(stale.code, 0);
    assert.match(stale.out, /src\/owned\.ts/);

    const json = await runCli(["status", "--json"], env);
    assert.equal(json.code, 0);
    const parsed = JSON.parse(json.out.trim().split("\n")[0] ?? "{}") as { peers: { alias: string; reservations: { pattern: string }[] }[] };
    const h = parsed.peers.find((p) => p.alias === "holder");
    assert.ok(h !== undefined);
    assert.equal(h.reservations.length, 1);
    assert.equal(h.reservations[0]?.pattern, "src/owned.ts");
  } finally {
    await holder.close();
    await broker.close();
    dirs.cleanup();
  }
});

test("mesh tail -f: torn line is carried, not lost", async () => {
  const dirs = makeTempDirs("cli-tailf2-");
  mkdirSync(dirs.stateDir, { recursive: true });
  const ledger = path.join(dirs.stateDir, "ledger.jsonl");
  try {
    const env = { MESH_RUNTIME_DIR: dirs.runtimeDir, MESH_STATE_DIR: dirs.stateDir };
    const child = spawn(process.execPath, [CLI, "tail", "-f"], { env: hermeticEnv(env) });
    let out = "";
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString("utf8");
    });
    await new Promise((r) => setTimeout(r, 700));
    // first write: HALF a line (no newline) — the second completes it
    appendFileSync(ledger, '{"event":"sent","from":"alice","ts":"2026');
    await new Promise((r) => setTimeout(r, 400));
    appendFileSync(ledger, '-01-01T00:00:03Z"}\n');
    killAfter(child, 900);
    await new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? -1)));
    // the torn record MUST appear complete exactly once
    const matches = out.match(/"event":"sent","from":"alice"/g) ?? [];
    assert.equal(matches.length, 1, `out: ${JSON.stringify(out)}`);
  } finally {
    dirs.cleanup();
  }
});

test("mesh tail -f --limit invalid exits 2 (validation parity)", async () => {
  const dirs = makeTempDirs("cli-tailf3-");
  mkdirSync(dirs.stateDir, { recursive: true });
  try {
    const env = { MESH_RUNTIME_DIR: dirs.runtimeDir, MESH_STATE_DIR: dirs.stateDir };
    const res = await runCli(["tail", "-f", "--limit", "abc"], env);
    assert.equal(res.code, 2);
    assert.match(res.err, /invalid --limit/);
  } finally {
    dirs.cleanup();
  }
});

test("mesh config show masks the token, honors stateDir config", async () => {
  const dirs = makeTempDirs("cli-config-");
  mkdirSync(dirs.stateDir, { recursive: true });
  writeFileSync(
    path.join(dirs.stateDir, "config.json"),
    JSON.stringify({ rooms: ["ops"], mailboxCap: 42 }),
  );
  try {
    const env = { MESH_RUNTIME_DIR: dirs.runtimeDir, MESH_STATE_DIR: dirs.stateDir, MESH_BROKER_TOKEN: "super-secret-token" };
    const res = await runCli(["config", "show"], env);
    assert.equal(res.code, 0, `stderr: ${res.err}`);
    assert.match(res.out, /rooms: ops/);
    assert.match(res.out, /cap=42/);
    assert.doesNotMatch(res.out, /super-secret-token/);
    assert.match(res.out, /token: set \(sha256:[0-9a-f]{8}\)/);
  } finally {
    dirs.cleanup();
  }
});
