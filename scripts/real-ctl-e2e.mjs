#!/usr/bin/env node
// scripts/real-ctl-e2e.mjs — TWO REAL PI SESSIONS, isolated broker.
//
// alice = this script's MeshClient (the controller)
// bob   = a real `pi --mode rpc` session loading the LOCAL pi-mesh, pi-jobd
//         and pi-subagents sources, with the bash tool only.
//
// Covers: idle abort, busy abort, redirect mid-tool, remote job stop, policy
// deny, offline, timeout, self. No mocks on the wire.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MeshClient } from "../dist/src/client/client.js";
import { JobdClient } from "/Users/cgarrot/zob/pi-jobd/dist/src/client.js";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const jobdRepo = resolve(repo, "../pi-jobd");
const subagentsRepo = resolve(repo, "../pi-subagents");
const piBin = process.env.PI_BIN ?? "pi";
const root = mkdtempSync(join(tmpdir(), "pi-mesh-real-e2e-"));
const rtDir = join(root, "rt");
const stateDir = join(root, "state");
const bobCwd = join(root, "bob");
const jobdState = join(root, "jobd-bob");
const policyPath = join(stateDir, "policy.json");
mkdirSync(rtDir, { recursive: true });
mkdirSync(stateDir, { recursive: true });
mkdirSync(bobCwd, { recursive: true });
writeFileSync(
  policyPath,
  `${JSON.stringify(
    {
      allow: [{ from: "*", to: "*", room: "*" }],
      deny: [],
      forceAllowedFrom: ["alice"],
      forceDowngrade: false,
      rateLimits: { msgPerMin: 600, urgentPerMin: 120, forcePerMin: 60 },
    },
    null,
    2,
  )}\n`,
);

// The surrounding pi session may export a REMOTE broker endpoint (the real
// mesh). The test must be hermetic: drop it before spawning bob/auto-spawn.
delete process.env.MESH_BROKER_URL;
delete process.env.MESH_BROKER_TOKEN;

// The controller's client + the broker it auto-spawns use these.
process.env.MESH_RUNTIME_DIR = rtDir;
process.env.MESH_STATE_DIR = stateDir;
process.env.MESH_POLICY = policyPath;
process.env.MESH_ALIAS = "alice";
process.env.PI_JOBD_STATE_DIR = jobdState;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const traceFile = process.env.E2E_TRACE; // opt-in debug log
function trace(line) {
  if (!traceFile) return;
  try { appendFileSync(traceFile, `${new Date().toISOString()} ${line}\n`); } catch { /* ignore */ }
}
process.on("exit", (code) => trace(`EXIT ${code}`));
process.on("uncaughtException", (err) => trace(`UNCAUGHT ${err?.stack ?? err}`));
process.on("unhandledRejection", (err) => trace(`UNHANDLED ${err?.stack ?? err}`));
let passed = 0;
let failed = 0;

async function check(name, fn) {
  trace(`CHECK start ${name}`);
  try {
    await fn();
    passed += 1;
    trace(`CHECK PASS ${name}`);
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    trace(`CHECK FAIL ${name}: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`  FAIL  ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function waitFor(fn, ms, label) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(100);
  }
  throw new Error(`timeout: ${label}`);
}

/** Minimal JSONL driver for the real bob RPC session. */
class Bob {
  constructor(alias, cwd, extraArgs) {
    this.alias = alias;
    this.cwd = cwd;
    this.history = [];
    this.pending = new Map();
    this.seq = 0;
    this.buf = "";
    const env = {
      ...process.env,
      MESH_ALIAS: alias,
      MESH_ROOMS: "default",
      MESH_STATE_DIR: stateDir,
      MESH_RUNTIME_DIR: rtDir,
      MESH_POLICY: policyPath,
      PI_JOBD_STATE_DIR: jobdState,
    };
    this.proc = spawn(
      piBin,
      [
        "--mode", "rpc",
        "--no-session",
        "--no-extensions",
        "--no-mcp",
        ...extraArgs,
        "-e", join(repo, "index.ts"),
        "-e", join(jobdRepo, "index.ts"),
        "-e", join(subagentsRepo, "index.ts"),
      ],
      { cwd, env, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.proc.stdout.setEncoding("utf8");
    this.proc.stderr.setEncoding("utf8");
    this.stderr = "";
    this.proc.stderr.on("data", (c) => {
      this.stderr = (this.stderr + c).slice(-4_000);
    });
    this.proc.on("error", (err) => {
      this.stderr = `spawn error: ${err.message}`;
    });
    this.proc.on("exit", (code, signal) => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(`bob exited (code=${code} signal=${signal}) stderr=${this.stderr.slice(-300)}`));
      }
      this.pending.clear();
      this.history.push({ type: "bob_exit", code, signal });
    });
    this.proc.stdout.on("data", (chunk) => {
      this.buf += chunk;
      for (;;) {
        const nl = this.buf.indexOf("\n");
        if (nl < 0) break;
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (line.trim() === "") continue;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        if (rec.type === "response" && this.pending.has(rec.id)) {
          const p = this.pending.get(rec.id);
          this.pending.delete(rec.id);
          clearTimeout(p.timer);
          if (rec.success) p.resolve(rec);
          else p.reject(new Error(rec.error ?? `${rec.command} failed`));
          continue;
        }
        this.history.push(rec);
      }
    });
  }

  historyIndex() {
    return this.history.length;
  }

  request(command, timeoutMs = 30_000) {
    const id = `r${++this.seq}`;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rpc timeout: ${command.type} (stderr=${this.stderr.slice(-300)})`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject, timer });
      this.proc.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
    });
  }

  async prompt(message, timeoutMs = 30_000) {
    await this.request({ type: "prompt", message }, timeoutMs);
  }

  async state() {
    const res = await this.request({ type: "get_state" }, 15_000);
    return res.data;
  }

  async waitEvent(type, pred = () => true, timeoutMs = 60_000, since = 0) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = this.history.slice(since).find((r) => r.type === type && pred(r));
      if (hit) return hit;
      await sleep(100);
    }
    throw new Error(`timeout waiting ${type} (stderr=${this.stderr.slice(-500)})`);
  }

  async stop() {
    try {
      await this.request({ type: "stop" }, 3_000);
    } catch {
      // ignore
    }
    await sleep(300);
    try {
      this.proc.kill("SIGKILL");
    } catch {
      // gone
    }
  }
}

async function main() {
  // REF'd on purpose: MeshClient's connect timers are unref'd, so an unref'd
  // watchdog would let the event loop drain and Node exit 0 mid-connect.
  const watchdog = setTimeout(() => {
    console.error("E2E WATCHDOG (240s) — aborting, see the last PASS/FAIL line");
    process.exit(3);
  }, 240_000);
  console.log("pi-mesh real ctl E2E (two real pi sessions)");
  console.log(`root: ${root}`);

  trace("alice connecting");
  const alice = new MeshClient({ alias: "alice", rooms: ["default"], runtimeDir: rtDir, config: {}, noReconnect: true });
  await alice.connect();
  trace("alice connected");
  const bob = new Bob("bob", bobCwd, ["--tools", "bash"]);
  try {
    // knownPeers is only seeded at welcome/presence-join; a peer that joins
    // AFTER us is visible in a status snapshot. Poll the broker, not the hint.
    await waitFor(async () => {
      const snapshot = await alice.status();
      return snapshot.peers.some((p) => p.alias === "bob");
    }, 25_000, "bob online");
    await bob.state();
    trace("bob online");
    console.log("  bob online");

    await check("idle abort -> not_busy (no fake abort)", async () => {
      const res = await alice.control({ to: "bob", action: "abort", reason: "e2e-idle", timeoutMs: 15_000 });
      assert.equal(res.status, "not_busy", JSON.stringify(res));
    });

    await check("busy abort -> aborted + agent_settled aborted=true", async () => {
      const tool = bob.waitEvent("tool_execution_start", () => true, 90_000);
      await bob.prompt("You MUST call the bash tool NOW with exactly: sleep 30 . Do not answer with text. Call the tool.");
      await tool;
      assert.equal((await bob.state()).isStreaming, true);
      const since = bob.historyIndex();
      const settled = bob.waitEvent("agent_settled", () => true, 30_000, since);
      const res = await alice.control({ to: "bob", action: "abort", reason: "e2e-busy", timeoutMs: 15_000 });
      assert.equal(res.status, "aborted", JSON.stringify(res));
      assert.equal(res.settled, true);
      const event = await settled;
      assert.equal(event.aborted, true);
      await bob.waitEvent("agent_settled", () => true, 5_000, 0).catch(() => {});
    });

    await check("redirect mid-tool -> new instruction executes (file proof)", async () => {
      const tool = bob.waitEvent("tool_execution_start", () => true, 90_000);
      await bob.prompt("You MUST call the bash tool NOW with exactly: sleep 60 . Do not answer with text. Call the tool.");
      await tool;
      const since = bob.historyIndex();
      const res = await alice.control({
        to: "bob",
        action: "redirect",
        message: "Use the bash tool with exactly: echo MESH_REDIRECT_OK > mesh-redirect-ok.txt . Then reply DONE.",
        reason: "e2e-redirect",
        timeoutMs: 20_000,
      });
      assert.equal(res.status, "redirected", JSON.stringify(res));
      assert.equal(res.settled, true);
      await bob.waitEvent("tool_execution_start", () => true, 90_000, since);
      await waitFor(() => existsSync(join(bobCwd, "mesh-redirect-ok.txt")), 90_000, "redirect proof file");
      assert.equal(readFileSync(join(bobCwd, "mesh-redirect-ok.txt"), "utf8").trim(), "MESH_REDIRECT_OK");
    });

    await check("remote job stop through the mesh (jobd owner=bob)", async () => {
      const out = execFileSync(
        process.execPath,
        [join(jobdRepo, "dist/src/cli.js"), "run", "sleep 60", "--owner", "bob"],
        { env: { ...process.env, PI_JOBD_STATE_DIR: jobdState }, encoding: "utf8" },
      );
      const m = /started (j_[A-Za-z0-9_]+)/.exec(out);
      assert.ok(m, out);
      const jobId = m[1];
      const res = await alice.control({ to: "bob", action: "job_stop", target: jobId, timeoutMs: 20_000 });
      assert.equal(res.status, "stopped", JSON.stringify(res));
      const status = JSON.parse(
        execFileSync(
          process.execPath,
          [join(jobdRepo, "dist/src/cli.js"), "status", jobId, "--json"],
          { env: { ...process.env, PI_JOBD_STATE_DIR: jobdState }, encoding: "utf8" },
        ),
      );
      assert.equal(status.state, "stopped");
    });

    await check("policy deny: carol is not in forceAllowedFrom", async () => {
      const carol = new MeshClient({ alias: "carol", rooms: ["default"], runtimeDir: rtDir, config: {}, noReconnect: true });
      await carol.connect();
      try {
        const res = await carol.control({ to: "bob", action: "abort", reason: "denied", timeoutMs: 10_000 });
        assert.equal(res.status, "not_authorized", JSON.stringify(res));
      } finally {
        await carol.close();
      }
    });

    await check("offline target -> unreachable (never queued)", async () => {
      const res = await alice.control({ to: "ghost", action: "job_stop", target: "j_1", timeoutMs: 5_000 });
      assert.equal(res.status, "unreachable", JSON.stringify(res));
    });

    await check("silent peer -> timeout (may have acted, no retry)", async () => {
      const dave = new MeshClient({ alias: "dave", rooms: ["default"], runtimeDir: rtDir, config: {}, noReconnect: true });
      await dave.connect();
      try {
        const res = await alice.control({ to: "dave", action: "job_stop", target: "j_1", timeoutMs: 400 });
        assert.equal(res.status, "timeout", JSON.stringify(res));
        assert.match(res.reason, /may have acted/);
      } finally {
        await dave.close();
      }
    });

    await check("self control is refused locally", async () => {
      const res = await alice.control({ to: "alice", action: "job_stop", target: "j_1" });
      assert.equal(res.status, "error");
      assert.match(res.reason, /self_control/);
    });
  } finally {
    clearTimeout(watchdog);
    trace("finally start");
    await bob.stop();
    await alice.close();
    try {
      await new JobdClient({ stateDir: jobdState }).shutdown();
    } catch {
      // ignore
    }
    try {
      const lock = readFileSync(join(rtDir, "broker.lock"), "utf8").trim();
      const pid = Number(lock);
      if (Number.isInteger(pid) && pid > 0) process.kill(pid, "SIGTERM");
    } catch {
      // no broker
    }
    rmSync(root, { recursive: true, force: true });
  }
  trace(`DONE passed=${passed} failed=${failed}`);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("CRASHED:", err);
  rmSync(root, { recursive: true, force: true });
  process.exit(1);
});
