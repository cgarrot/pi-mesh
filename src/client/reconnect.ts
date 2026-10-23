// client/reconnect.ts — ensureBroker auto-spawn, connect probe, backoff.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ENSURE_BROKER_MAX_POLLS,
  ENSURE_BROKER_POLL_MS,
  LOCK_RETRY_MAX,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
} from "../shared/config.js";
import { brokerExecPath } from "../shared/exec.js";
import { brokerLockPath, brokerSocketPath } from "../shared/paths.js";

const BROKER_ENTRY_REL = "../broker/broker.js";
const ENV_BROKER_ENTRY = "MESH_BROKER_ENTRY";

/** Walk up from `startDir` to the nearest directory containing package.json. */
function findPackageRoot(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Resolve the broker entry, in order
 * 1. $MESH_BROKER_ENTRY override (highest priority, returned as-is).
 * 2. Sibling candidate: <moduleDir>/../broker/broker.js — only if it exists on disk.
 * 3. Repo-root fallback: nearest package.json walking up from moduleDir, then
 *  <root>/dist/src/broker/broker.js — only if it exists (covers jiti-loaded
 *  TS sources, where the sibling is broker.ts, not broker.js).
 * 4. Otherwise throw a descriptive error listing the tried paths.
 * Never returns a path that does not exist on disk (except the explicit override).
 */
export function brokerEntryPath(
  env: NodeJS.ProcessEnv = process.env,
  moduleDir: string = path.dirname(fileURLToPath(import.meta.url)),
): string {
  const override = env[ENV_BROKER_ENTRY];
  if (override && override.trim() !== "") return override;
  const sibling = path.resolve(moduleDir, BROKER_ENTRY_REL);
  if (existsSync(sibling)) return sibling;
  const root = findPackageRoot(moduleDir);
  const distFallback =
    root === undefined ? undefined : path.join(root, "dist", "src", "broker", "broker.js");
  if (distFallback !== undefined && existsSync(distFallback)) return distFallback;
  const tried = [sibling, ...(distFallback === undefined ? [] : [distFallback])];
  throw new Error(
    `broker entry not found: run \`npm run build\` or set ${ENV_BROKER_ENTRY} (tried: ${tried.join(", ")})`,
  );
}

/** Try to connect to the broker socket. */
export function connectProbe(socketPath: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

/** Try to connect to a remote tcp/tls broker endpoint (host/port probe). */
export function connectProbeTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref();
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function spawnBroker(runtimeDir: string, lockPath: string, entry: string): void {
  // spawn (not fork): no IPC channel is ever used (stdio ignore + unref),
  // and a compiled host's process.execPath must not be re-executed as if it
  // were node (#8). Plain spawn also never inherits the host's execArgv —
  // a pinned foreign runtime (bun, …) cannot receive node-specific launch
  // flags like --inspect.
  const exec = brokerExecPath();
  const child = spawn(exec, [entry], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, MESH_RUNTIME_DIR: runtimeDir },
  });
  child.unref();
  if (child.pid !== undefined) {
    try {
      writeFileSync(lockPath, String(child.pid));
    } catch {
  // broker rewrites the lock itself at startup
    }
  }
}

/**
 * ensureBroker
 * 1. connect OK → return.
 * 2. open(lock,"wx"): success → fork detached broker → poll connect 50ms × 60.
 *  EEXIST → pid alive ? poll wait : unlink + retry (× LOCK_RETRY_MAX).
 */
export async function ensureBroker(runtimeDir: string): Promise<string> {
  const sockPath = brokerSocketPath(runtimeDir);
  const lockPath = brokerLockPath(runtimeDir);
  mkdirSync(runtimeDir, { recursive: true });
  // Opt-out for hermetic harnesses: connecting to a runtime dir with no
  // broker must FAIL instead of silently spawning a detached daemon (which
  // then leaks: a test that closes its peers never kills it). Only the
  // SPAWN is disabled — an already-listening broker still connects.
  const noAutoSpawn =
    process.env.MESH_NO_AUTO_BROKER === "1" || process.env.MESH_NO_AUTO_BROKER === "true";

  for (let attempt = 0; attempt < LOCK_RETRY_MAX; attempt += 1) {
    if (await connectProbe(sockPath, ENSURE_BROKER_POLL_MS * ENSURE_BROKER_MAX_POLLS)) {
      return sockPath;
    }
    // One short re-probe covers the "another peer is spawning right now"
    // case without ever creating a broker ourselves.
    if (noAutoSpawn) {
      if (await connectProbe(sockPath, ENSURE_BROKER_POLL_MS * ENSURE_BROKER_MAX_POLLS)) {
        return sockPath;
      }
      throw new Error(
        `broker_unavailable: no broker is listening on ${sockPath} and auto-spawn is disabled (MESH_NO_AUTO_BROKER)`,
      );
    }
    let lockCreated = false;
    try {
      writeFileSync(lockPath, "", { flag: "wx" });
      lockCreated = true;
    } catch {
      lockCreated = false;
    }
    if (lockCreated) {
      let entry: string | undefined;
      try {
        entry = brokerEntryPath();
        spawnBroker(runtimeDir, lockPath, entry);
      } catch (err) {
        try {
          unlinkSync(lockPath);
        } catch {
  // best effort
        }
        const detail = err instanceof Error ? ` (${err.message})` : "";
        throw new Error(
          `broker_unavailable: spawn failed${entry === undefined ? "" : ` (exec: ${brokerExecPath()}, entry: ${entry})`}${detail}` +
            ` — on a compiled host (omp, SEA, …) set MESH_BROKER_EXEC_PATH to a JS runtime (README "Compiled hosts")`,
        );
      }
    } else {
  // lock exists: live pid → just wait; dead pid → unlink + retry
      let pid = Number.NaN;
      try {
        pid = Number(readFileSync(lockPath, "utf8").trim());
      } catch {
        pid = Number.NaN;
      }
      if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) {
  // someone is spawning; fall through to poll-wait below
      } else {
        try {
          unlinkSync(lockPath);
        } catch {
  // already gone
        }
        continue; // stale lock  → retry loop
      }
    }
  // poll connect 50 ms × 60 (3 s)
    for (let i = 0; i < ENSURE_BROKER_MAX_POLLS; i += 1) {
      await sleep(ENSURE_BROKER_POLL_MS);
      if (await connectProbe(sockPath, ENSURE_BROKER_POLL_MS)) return sockPath;
    }
  // timed out; if we created the lock, clean it before retry
    if (lockCreated) {
      try {
        unlinkSync(lockPath);
      } catch {
  // best effort
      }
    } else if (!(await connectProbe(sockPath, ENSURE_BROKER_POLL_MS))) {
  // FOREIGN lock that never served the socket within the 3 s poll
  // window: the holder is dead-but-uncleaned or a recycled PID (never a
  // live broker — one would have answered). Clear it so the next attempt
  // can spawn instead of burning LOCK_RETRY_MAX windows and failing.
      try {
        unlinkSync(lockPath);
      } catch {
  // already gone
      }
    }
  }
  throw new Error(
    "broker_unavailable: broker did not come up — run `pimesh doctor`; on a compiled host set MESH_BROKER_EXEC_PATH (README \"Compiled hosts\")",
  );
}

/** Reconnect backoff: 250 ms × 2^n, capped at 5 s. */
export function backoffMs(attempt: number): number {
  const exp = RECONNECT_BASE_MS * 2 ** Math.max(0, attempt);
  return Math.min(RECONNECT_MAX_MS, exp);
}
