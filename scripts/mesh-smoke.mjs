#!/usr/bin/env node
// scripts/mesh-smoke.mjs — Wave A E2E smoke (no Pi): broker + 2 headless clients.
// Steps: (1) msg→ack(delivered)→auto-reply; (2) offline→queued_offline→mailbox;
// (3) SIGKILL broker → re-ready <2s → delivered (E2); (4) status includes bob.
import { fork } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BROKER_ENTRY = path.join(ROOT, "dist", "src", "broker", "broker.js");
const CLIENT_ENTRY = path.join(ROOT, "dist", "src", "client", "client.js");

// Socket endpoint: same resolution as the runtime (named pipe on Windows).
const { socketPathForDir, brokerLockPath } = await import(
  pathToFileURL(path.join(ROOT, "dist", "src", "shared", "paths.js")).href,
);

const RE_READY_BUDGET_MS = 2000;
const STEP_TIMEOUT_MS = 10000;
const BROKER_BOOT_POLL_MS = 50;
const BROKER_BOOT_POLLS = 60;

const tmp = mkdtempSync(path.join(os.tmpdir(), "mesh-smoke-"));
const runtimeDir = path.join(tmp, "run");
const stateDir = path.join(tmp, "state");

const results = [];
function report(step, ok, detail = "") {
  results.push({ step, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`);
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label}`)), ms)),
  ]);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

let broker = null;
function startBroker() {
  broker = fork(BROKER_ENTRY, [], {
    stdio: "ignore",
    env: { ...process.env, MESH_RUNTIME_DIR: runtimeDir, MESH_STATE_DIR: stateDir },
  });
}

function probe(sockPath) {
  return new Promise((resolve) => {
    const s = net.createConnection(sockPath);
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => { s.destroy(); resolve(false); });
  });
}

// Deterministic startup: wait until THIS broker listens before clients connect,
// so clients never win the ensureBroker spawn race (SIGKILL target is unambiguous).
async function waitBrokerUp() {
  const sockPath = socketPathForDir(runtimeDir);
  for (let i = 0; i < BROKER_BOOT_POLLS; i += 1) {
    if (await probe(sockPath)) return;
    await sleep(BROKER_BOOT_POLL_MS);
  }
  throw new Error("broker did not start");
}

async function waitBrokerDown() {
  for (let i = 0; i < BROKER_BOOT_POLLS; i += 1) {
    if (broker.exitCode !== null || broker.signalCode !== null) return;
    await sleep(BROKER_BOOT_POLL_MS);
  }
  throw new Error("broker did not die");
}

const { MeshClient } = await import(pathToFileURL(CLIENT_ENTRY).href);

let alice;
let bob;
try {
  startBroker();
  await waitBrokerUp();

  alice = new MeshClient({ alias: "alice", runtimeDir, config: {} });
  bob = new MeshClient({ alias: "bob", runtimeDir, config: {} });
  await withTimeout(alice.connect(), STEP_TIMEOUT_MS, "alice connect");
  await withTimeout(bob.connect(), STEP_TIMEOUT_MS, "bob connect");

  // ---- Step 1: alice.send awaitReply → bob auto-replies on inbound ----
  try {
    bob.once("inbound", (frame) => {
      if (frame.type === "msg") {
        void bob.reply(frame.id, `ack:${frame.body}`);
      }
    });
    const r1 = await withTimeout(
      alice.send({ to: "bob", message: "ping-1", awaitReply: true, timeoutMs: STEP_TIMEOUT_MS }),
      STEP_TIMEOUT_MS * 2,
      "step1 send",
    );
    report(
      "step1 msg→delivered→reply",
      r1.status === "reply" && r1.response === "ack:ping-1",
      `status=${r1.status} response=${r1.response ?? ""}`,
    );
  } catch (err) {
    report("step1 msg→delivered→reply", false, String(err));
  }

  // ---- Step 2: bob offline → queued_offline → mailbox on reconnect ----
  try {
    await bob.close();
    await sleep(200); // let broker observe the close
    const r2 = await withTimeout(
      alice.send({ to: "bob", message: "offline-msg" }),
      STEP_TIMEOUT_MS,
      "step2 send",
    );
    const mailboxPromise = new Promise((resolve) => {
      bob.once("inbound", (frame) => resolve(frame));
    });
    await withTimeout(bob.connect(), STEP_TIMEOUT_MS, "bob reconnect");
    const mf = await withTimeout(mailboxPromise, STEP_TIMEOUT_MS, "mailbox delivery");
    report(
      "step2 queued_offline→mailbox",
      r2.status === "queued_offline" && mf.type === "mailbox" && mf.body === "offline-msg",
      `ack=${r2.status} frame=${mf.type} body=${mf.body ?? ""}`,
    );
  } catch (err) {
    report("step2 queued_offline→mailbox", false, String(err));
  }

  // ---- Step 3: SIGKILL broker → alice re-ready <2s → delivered (E2) ----
  try {
    broker.kill("SIGKILL");
    await waitBrokerDown();
    const t0 = Date.now();
    await withTimeout(
      Promise.all([
        new Promise((resolve) => alice.once("ready", resolve)),
        new Promise((resolve) => bob.once("ready", resolve)),
      ]),
      STEP_TIMEOUT_MS,
      "re-ready",
    );
    const reReadyMs = Date.now() - t0;
    const r3 = await withTimeout(
      alice.send({ to: "bob", message: "post-crash" }),
      STEP_TIMEOUT_MS,
      "step3 send",
    );
    report(
      "step3 broker-kill→reconnect→delivered",
      reReadyMs < RE_READY_BUDGET_MS && r3.status === "delivered",
      `reReadyMs=${reReadyMs} send=${r3.status}`,
    );
  } catch (err) {
    report("step3 broker-kill→reconnect→delivered", false, String(err));
  }

  // ---- Step 4: alice.status() includes bob ----
  try {
    // bob may need a moment to re-hello after broker respawn
    let snap = { peers: [] };
    for (let i = 0; i < 40; i += 1) {
      snap = await alice.status();
      if (snap.peers.some((p) => p.alias === "bob")) break;
      await sleep(BROKER_BOOT_POLL_MS);
    }
    report(
      "step4 status includes bob",
      snap.peers.some((p) => p.alias === "bob"),
      `peers=${snap.peers.map((p) => p.alias).join(",")}`,
    );
  } catch (err) {
    report("step4 status includes bob", false, String(err));
  }
} catch (err) {
  for (const s of ["step1", "step2", "step3", "step4"]) {
    if (!results.some((r) => r.step.startsWith(s))) report(s, false, String(err));
  }
} finally {
  try {
    if (alice) await alice.close();
  } catch {}
  try {
    if (bob) await bob.close();
  } catch {}
  try {
    if (broker && broker.exitCode === null) broker.kill("SIGTERM");
  } catch {}
  // Step 3 SIGKILLs the broker on purpose; the clients then auto-reconnect,
  // which spawns a SECOND broker. That one is not in `broker` — without this
  // the smoke leaked one detached broker per run.
  try {
    const pid = Number(readFileSync(brokerLockPath(runtimeDir), "utf8").trim());
    if (Number.isInteger(pid) && pid > 0) process.kill(pid, "SIGTERM");
  } catch {}
  await sleep(300);
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0 ? "PASS all 4 steps" : `FAIL ${failed.length} step(s)`);
process.exit(failed.length === 0 ? 0 : 1);
