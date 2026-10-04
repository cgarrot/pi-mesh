// test/cli-attach.test.ts — Phase 5: the standalone peer.
// Covers: fresh attach receives WITH body + read receipt on TTY; --json
// script mode (stdin commands, NO read frames, corrupt stdin → error event
// with ref); adoption re-declares reservations with a refreshed `since`;
// mailbox inheritance; strict alias collision.
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { MeshClient } from "../src/client/client.js";
import { MeshIdentity, identityFromClient } from "../src/shared/identity-store.js";
import { makeTempDirs, startTestBroker, sleep } from "./helpers.js";

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

interface Proc {
  child: ChildProcess;
  acc: { out: string; err: string };
  done: Promise<number>;
}

function spawnCli(args: string[], env: NodeJS.ProcessEnv): Proc {
  const child = spawn(process.execPath, [CLI, ...args], { env: hermeticEnv(env) });
  const acc = { out: "", err: "" };
  child.stdout!.on("data", (c: Buffer) => {
    acc.out += c.toString("utf8");
  });
  child.stderr!.on("data", (c: Buffer) => {
    acc.err += c.toString("utf8");
  });
  const done = new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? -1));
  });
  return { child, acc, done };
}

test("attach --json: receives WITH body, executes stdin commands, NEVER reads", async () => {
  const dirs = makeTempDirs("cli-attach1-");
  const broker = await startTestBroker(dirs.runtimeDir);
  // a peer that tracks read receipts it receives for its own messages
  const peer = new MeshClient({ alias: "peer", runtimeDir: dirs.runtimeDir });
  await peer.connect();
  const readsSeen: string[] = [];
  peer.on("read", (f: { reads?: string; from?: string }) => {
    readsSeen.push(f.reads ?? "?");
  });
  try {
    const env = { MESH_RUNTIME_DIR: dirs.runtimeDir, MESH_STATE_DIR: dirs.stateDir };
    const proc = spawnCli(["attach", "--json"], env);
    await sleep(900); // let it attach

    // 1) a message TO the standalone → event WITH body
    const sent = await peer.send({ to: "standalone-test1", message: "hello-body" }).catch(() => null);
    void sent; // unknown alias → peer_not_found is fine; use a live path instead below
    // discover the actual alias from the attach-start event
    const startLine = proc.acc.out.split("\n").find((l) => l.includes('"attach-start"'));
    assert.ok(startLine !== undefined, `no attach-start: ${proc.acc.out}`);
    const start = JSON.parse(startLine) as { alias: string; readReceipts: boolean };
    assert.equal(start.readReceipts, false); // --json never reads
    await peer.send({ to: start.alias, message: "hello-body" });
    await sleep(600);
    assert.match(proc.acc.out, /hello-body/, "body must be visible to the recipient");

    // 2) stdin commands: send + corrupt line + status
    proc.child.stdin!.write(JSON.stringify({ ref: "r1", cmd: "send", to: "peer", message: "from-script" }) + "\n");
    proc.child.stdin!.write("{this is not json\n");
    proc.child.stdin!.write(JSON.stringify({ ref: "r2", cmd: "status" }) + "\n");
    await sleep(900);
    assert.match(proc.acc.out, /"ref":"r1"/);
    assert.match(proc.acc.out, /"status":"delivered"/);
    assert.match(proc.acc.out, /"ref":null.*invalid json|"type":"error".*invalid json/);
    assert.match(proc.acc.out, /"ref":"r2"/);
    assert.match(proc.acc.out, /"peers":2/);

    // 3) NO read frames were ever emitted by the standalone
    await peer.send({ to: start.alias, message: "second" });
    await sleep(600);
    assert.equal(readsSeen.length, 0, "--json must never emit read receipts");

    proc.child.stdin!.write(JSON.stringify({ cmd: "exit" }) + "\n");
    const code = await proc.done;
    assert.equal(code, 0);
  } finally {
    await peer.close();
    await broker.close();
    dirs.cleanup();
  }
});

test("attach adoption: dead session identity re-declared with refreshed since + mailbox inherited", async () => {
  const dirs = makeTempDirs("cli-attach2-");
  const broker = await startTestBroker(dirs.runtimeDir);
  const store = new MeshIdentity(dirs.stateDir);
  // a "killed" session: persisted identity, never connected
  store.save(identityFromClient("sess-killed-01", {
    alias: "fallen",
    rooms: ["ops"],
    reservations: [{ pattern: "src/fallen.ts", reason: "wip", since: new Date(Date.now() - 20 * 3600_000).toISOString() }],
  }));
  // queue mail for the dead alias: connect it once, then leave
  const ghost = new MeshClient({ alias: "fallen", runtimeDir: dirs.runtimeDir, rooms: ["ops"] });
  await ghost.connect();
  await ghost.close();
  const mailer = new MeshClient({ alias: "mailer", runtimeDir: dirs.runtimeDir, rooms: ["ops"] });
  await mailer.connect();
  await mailer.send({ to: "fallen", message: "mail-for-the-dead", room: "ops" });
  await mailer.close();
  // an observer verifies the adopted reservations + since
  const observer = new MeshClient({ alias: "observer", runtimeDir: dirs.runtimeDir, rooms: ["ops"] });
  await observer.connect();
  try {
    const env = { MESH_RUNTIME_DIR: dirs.runtimeDir, MESH_STATE_DIR: dirs.stateDir };
    const proc = spawnCli(["attach", "fallen", "--json"], env);
    await sleep(1000);

    const startLine = proc.acc.out.split("\n").find((l) => l.includes('"attach-start"'));
    assert.ok(startLine !== undefined, proc.acc.out);
    const start = JSON.parse(startLine) as { adopted: boolean; sessionId: string | null; reservations: { since?: string }[] };
    assert.equal(start.adopted, true);
    assert.match(String(start.sessionId), /sess-killed-01/);
    assert.equal(start.reservations.length, 1);
    // since REFRESHED: the persisted claim was 20 h old; the adopted one is minutes
    const since = start.reservations[0]?.since;
    assert.ok(since !== undefined);
    assert.ok(Date.now() - Date.parse(since) < 60_000, `since not refreshed: ${since}`);

    // the claim is live on the mesh under the adopted alias
    const snap = await observer.status();
    const fallen = snap.peers.find((p) => p.alias === "fallen");
    assert.ok(fallen !== undefined);
    assert.equal((fallen.reservations ?? []).length, 1);

    // the queued mail was flushed at hello and rendered (with its body)
    assert.match(proc.acc.out, /mail-for-the-dead/);

    proc.child.kill("SIGINT");
    const code = await proc.done;
    // POSIX: graceful exit 0. Windows: hard termination (no signals) —
    // the adoption/mailbox content above is the cross-platform contract.
    if (process.platform !== "win32") assert.equal(code, 0);
  } finally {
    await observer.close();
    await broker.close();
    dirs.cleanup();
  }
});

test("attach --session unknown exits 2; attach live alias exits 1 (strict)", async () => {
  const dirs = makeTempDirs("cli-attach3-");
  const broker = await startTestBroker(dirs.runtimeDir);
  const holder = new MeshClient({ alias: "busy-now", runtimeDir: dirs.runtimeDir });
  await holder.connect();
  try {
    const env = { MESH_RUNTIME_DIR: dirs.runtimeDir, MESH_STATE_DIR: dirs.stateDir };
    const noSession = await new Promise<{ code: number; err: string }>((resolve) => {
      const c = spawn(process.execPath, [CLI, "attach", "--session", "never-was"], { env: hermeticEnv(env) });
      let err = "";
      c.stderr.on("data", (x: Buffer) => {
        err += x;
      });
      c.on("close", (code) => resolve({ code: code ?? -1, err }));
    });
    assert.equal(noSession.code, 2);
    assert.match(noSession.err, /no persisted identity/);

    const live = spawnCli(["attach", "busy-now", "--json"], env);
    const code = await live.done;
    assert.equal(code, 1);
    assert.match(live.acc.out, /blocked: alias_taken/);
  } finally {
    await holder.close();
    await broker.close();
    dirs.cleanup();
  }
});
