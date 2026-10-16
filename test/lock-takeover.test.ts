// test/lock-takeover.test.ts — recycled-PID lock resilience (regression).
//
// Failure mode fixed here: after a hard broker death (SIGKILL, power loss,
// panic) broker.lock survives while the OS recycles the stale PID for an
// unrelated LIVE process. The old pidAlive()-only check read that as "lock
// held by a live process" and refused takeover forever — the broker could
// never restart without a human deleting the lock by hand.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import net from "node:net";
import { describe, it } from "node:test";
import { acquireLock } from "../src/broker/broker.js";
import { connectProbe, ensureBroker } from "../src/client/reconnect.js";
import { brokerLockPath } from "../src/shared/paths.js";
import { brokerSocketPathOf, makeTempDirs, waitFor } from "./helpers.js";

/** A live foreign process that is NOT a broker (pid recycling stand-in). */
function liveForeignPid(): { pid: number; stop: () => void } {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], {
    stdio: "ignore",
  });
  return {
    pid: child.pid as number,
    stop: () => {
      try {
        child.kill("SIGKILL");
      } catch {
  // already gone
      }
    },
  };
}

function seedLock(dir: string, pid: number): void {
  writeFileSync(brokerLockPath(dir), String(pid));
}

describe("broker lock takeover (recycled PID)", () => {
  it("live foreign PID + dead socket → stale lock is taken over", async (t) => {
    const dirs = makeTempDirs("mesh-lock-takeover-");
    t.after(() => dirs.cleanup());
    const foreign = liveForeignPid();
    t.after(() => foreign.stop());
    seedLock(dirs.runtimeDir, foreign.pid);

  // OLD behavior: pidAlive(foreign.pid) === true → return false (refused).
  // NEW: the live foreign PID must serve the socket; silence → takeover.
    const ok = await acquireLock(dirs.runtimeDir);
    assert.equal(ok, true, "recycled-PID lock must be taken over when the socket is dead");
    assert.equal(
      Number(readFileSync(brokerLockPath(dirs.runtimeDir), "utf8").trim()),
      process.pid,
      "lock must now carry OUR pid",
    );
  });

  it("live foreign PID + LIVE socket → lock respected (no hijack)", async (t) => {
    const dirs = makeTempDirs("mesh-lock-live-holder-");
    t.after(() => dirs.cleanup());
    const foreign = liveForeignPid();
    t.after(() => foreign.stop());
    seedLock(dirs.runtimeDir, foreign.pid);

  // a genuine holder answers on the socket path
    const server = net.createServer(() => {});
    await new Promise<void>((resolve) => server.listen(brokerSocketPathOf(dirs.runtimeDir), resolve));
    t.after(() => server.close());

    const ok = await acquireLock(dirs.runtimeDir);
    assert.equal(ok, false, "a lock whose socket is served must NOT be stolen");
  });

  it("ensureBroker clears a foreign stale lock and spawns a broker", async (t) => {
    const dirs = makeTempDirs("mesh-ensure-stale-lock-");
    t.after(() => dirs.cleanup());
    const foreign = liveForeignPid();
    t.after(() => foreign.stop());
    seedLock(dirs.runtimeDir, foreign.pid);

  // OLD behavior: 3 attempts × 3 s waiting on the "live" holder → throw.
  // NEW: the foreign lock is cleared after the first silent window and the
  // broker is spawned + connected within the retry budget.
    const sockPath = await ensureBroker(dirs.runtimeDir);
    assert.equal(typeof sockPath, "string");
    assert.equal(await connectProbe(sockPath, 1000), true, "spawned broker must answer");

  // cleanup: SIGTERM the spawned broker and wait for it to exit
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
          return false;
        } catch {
          return true;
        }
      }, 5000);
    }
  });
});
