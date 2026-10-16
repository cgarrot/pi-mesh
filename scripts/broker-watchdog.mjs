#!/usr/bin/env node
// scripts/broker-watchdog.mjs — standalone broker supervisor loop.
//
// WHY: the standalone broker (dual tcp+unix listen) is a plain detached
// process. A crash, a reboot/logout, or a stale broker.lock with a
// RECYCLED OS pid left the mesh dead until a human (or an agent) repaired
// it by hand — and the recycled-pid lock even made manual restarts spin
// ("lock held by a live process"). This loop makes the standalone broker
// self-healing on every machine where it runs:
//
//   every CHECK_INTERVAL_MS: probe the unix socket AND the configured tcp
//   endpoint; after FAIL_CYCLES consecutive unhealthy cycles (≈2×15 s, so a
//   legit mid-(re)start broker is never raced):
//     · lock pid alive AND its command line is a mesh broker → SIGTERM
//       (wedged holder: process up, endpoints not answering), SIGKILL
//       after TERM_GRACE_MS;
//     · lock pid alive but NOT a broker process (recycled pid) or dead →
//       clear lock + stale socket file (harmless: the socket provably
//       serves nobody);
//     · respawn the broker detached — cwd = os.homedir() so its stateDir is
//       ~/.mesh (config.json listen/brokerToken), broker stdout appended to
//       ~/.mesh/broker-standalone.log.
//
//   NEVER kills a pid whose command line is not a mesh broker entry — a
//   recycled pid may belong to an unrelated innocent process.
//
// Supervised by launchd (KeepAlive restarts THIS loop if it dies). All
// state transitions are logged to ~/.mesh/broker-watchdog.log (truncated
// when > LOG_MAX_BYTES).
import { spawn, execFileSync } from "node:child_process";
import { openSync, readFileSync, statSync, truncateSync, unlinkSync, writeSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { connectProbe, connectProbeTcp } = await import(
  pathToFileURL(path.join(ROOT, "dist", "src", "client", "reconnect.js")).href
);
const { brokerLockPath, brokerSocketPath, runtimeDir } = await import(
  pathToFileURL(path.join(ROOT, "dist", "src", "shared", "paths.js")).href
);
const { parseEndpoint } = await import(
  pathToFileURL(path.join(ROOT, "dist", "src", "shared", "config.js")).href
);

const HOME = os.homedir();
const STATE_DIR = path.join(HOME, ".mesh");
const BROKER_ENTRY = path.join(ROOT, "dist", "src", "broker", "broker.js");
// $MESH_BROKER_EXEC_PATH override or the runtime that launched the
// watchdog — never assume process.execPath is node (compiled hosts, #8).
const BROKER_EXEC = (process.env.MESH_BROKER_EXEC_PATH || "").trim() || process.execPath;
const BROKER_LOG = path.join(STATE_DIR, "broker-standalone.log");
const WATCHDOG_LOG = path.join(STATE_DIR, "broker-watchdog.log");

const CHECK_INTERVAL_MS = 15_000;
const PROBE_TIMEOUT_MS = 2_000;
const FAIL_CYCLES = 2; // unhealthy cycles before repair (never race a startup)
const TERM_GRACE_MS = 5_000;
const LOG_MAX_BYTES = 262_144; // 256 KiB

function ts() {
  return new Date().toISOString();
}

const logFd = openSync(WATCHDOG_LOG, "a");
function log(line) {
  try {
  // openSync returns an integer fd — writeSync, never fd.write()
    writeSync(logFd, `${ts()} ${line}\n`);
  } catch {
  // best effort
  }
}
try {
  if (statSync(WATCHDOG_LOG).size > LOG_MAX_BYTES) truncateSync(WATCHDOG_LOG);
} catch {
  // fresh log
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Full command line of a pid ("" when unavailable). */
function pidCommand(pid) {
  try {
    return execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/** True when the pid's command line is a mesh broker entry point. */
function isMeshBrokerPid(pid) {
  const cmd = pidCommand(pid);
  return /broker\.js/.test(cmd) && /(pi-mesh|pi-mesh-extension)/.test(cmd);
}

/** Read the tcp endpoint (host/port) from ~/.mesh/config.json `listen`. */
function tcpEndpoint() {
  try {
    const cfg = JSON.parse(readFileSync(path.join(STATE_DIR, "config.json"), "utf8"));
    const ep = typeof cfg.listen === "string" ? parseEndpoint(cfg.listen) : null;
    if (ep !== null && (ep.kind === "tcp" || ep.kind === "tls")) return { host: ep.host, port: ep.port };
  } catch {
  // no config / no listen → unix-only broker
  }
  return null;
}

async function healthy(dir) {
  const sockPath = brokerSocketPath(dir);
  if (!(await connectProbe(sockPath, PROBE_TIMEOUT_MS))) return false;
  const tcp = tcpEndpoint();
  if (tcp !== null && !(await connectProbeTcp(tcp.host, tcp.port, PROBE_TIMEOUT_MS))) return false;
  return true;
}

function readLockPid(dir) {
  try {
    const pid = Number(readFileSync(brokerLockPath(dir), "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

/** Terminate a PROVEN broker pid: SIGTERM, then SIGKILL after the grace. */
async function killBroker(pid) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + TERM_GRACE_MS;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
  // gone
  }
  await new Promise((r) => setTimeout(r, 250));
}

function clearStaleFiles(dir) {
  for (const f of [brokerLockPath(dir), brokerSocketPath(dir)]) {
    try {
      unlinkSync(f);
    } catch {
  // already gone
    }
  }
}

function spawnBroker(dir) {
  const brokerLogFd = openSync(BROKER_LOG, "a");
  const child = spawn(BROKER_EXEC, [BROKER_ENTRY], {
    detached: true,
    stdio: ["ignore", brokerLogFd, brokerLogFd],
    cwd: HOME, // stateDir = ~/.mesh → config.json listen + brokerToken
    env: { ...process.env, MESH_RUNTIME_DIR: dir },
  });
  child.unref();
  return child.pid ?? null;
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

// ---- main loop ----

const dir = runtimeDir();
log(`watchdog up pid=${process.pid} runtimeDir=${dir} broker=${BROKER_ENTRY}`);
let failStreak = 0;
for (;;) {
  let ok = false;
  try {
    ok = await healthy(dir);
  } catch (err) {
    log(`probe error: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (ok) {
    if (failStreak >= FAIL_CYCLES) log("recovered — endpoints answering again");
    failStreak = 0;
  } else {
        failStreak += 1;
    if (failStreak >= FAIL_CYCLES) {
  // last-chance re-probe: a broker may have come up BETWEEN the last
  // cycle's probe and now (session auto-spawn racing this watchdog) —
  // repairing against a fresh live broker would unlink its socket file
  // and orphan it. Re-verify, and only repair on a confirmed outage.
      if (await healthy(dir)) {
        log("recovered (re-probe at repair point) — endpoints answering again");
        failStreak = 0;
        await sleep(CHECK_INTERVAL_MS);
        continue;
      }
      log(`unhealthy ${failStreak} cycles — repairing`);
      const pid = readLockPid(dir);
      if (pid > 0 && pidAlive(pid)) {
        if (isMeshBrokerPid(pid)) {
          log(`wedged broker pid=${pid} (alive, endpoints dead) → SIGTERM/SIGKILL`);
          await killBroker(pid);
        } else {
          log(`lock pid=${pid} alive but NOT a broker (recycled pid) → treat lock as stale`);
        }
      }
  // clear lock + stale socket file; the (possibly recycled) holder
  // serves nobody on the socket path — removal is safe. broker.ts
  // acquireLock would clear it too; doing it here just removes the delay.
      clearStaleFiles(dir);
      const spawned = spawnBroker(dir);
      log(`broker respawned pid=${spawned ?? "?"} (launchd-independent supervision)`);
  // give it a startup window before the next probe cycle
      await sleep(3_000);
      failStreak = 0;
    }
  }
  await sleep(CHECK_INTERVAL_MS);
}
