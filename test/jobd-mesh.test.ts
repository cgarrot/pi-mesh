// test/jobd-mesh.test.ts — A: the daemon answers mesh stop without the LLM.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { JobDaemon } from "../src/jobd/daemon.js";
import { JobdClient } from "../src/jobd/client.js";
import { attachMeshToDaemon, connectDaemonMesh } from "../src/jobd/mesh.js";
import { ensureJobd } from "../src/jobd/lifecycle.js";
import { MeshClient } from "../src/client/client.js";
import { makeTempDirs, startTestBroker, type TempDirs } from "./helpers.js";

function procState(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const close = stat.lastIndexOf(")");
  return stat.slice(close + 2, close + 3);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function setupMesh(t: { after: (fn: () => void | Promise<void>) => void }): Promise<{
  dirs: TempDirs;
  socket: string;
  client: JobdClient;
  sender: MeshClient;
  daemon: JobDaemon;
}> {
  const dirs = makeTempDirs();
  t.after(() => dirs.cleanup());
  const broker = await startTestBroker(dirs.runtimeDir);
  t.after(async () => {
    await broker.close();
  });
  const socket = join(dirs.runtimeDir, "jobd.sock");
  const daemon = new JobDaemon({ socketPath: socket, stateDir: dirs.stateDir, owner: "lead" });
  await daemon.start();
  const mesh = await connectDaemonMesh({ owner: "lead", daemonAlias: "lead-jobd", runtimeDir: dirs.runtimeDir });
  attachMeshToDaemon(daemon, mesh);
  const sender = new MeshClient({ alias: "lead-sender", runtimeDir: dirs.runtimeDir, config: {} });
  await sender.connect();
  t.after(async () => {
    await sender.close();
    await mesh.close();
    for (const job of daemon.list()) if (job.state === "running" && job.pid) {
      try { process.kill(-job.pid, "SIGKILL"); } catch { /* gone */ }
    }
    await daemon.close();
  });
  return { dirs, socket, client: new JobdClient({ socketPath: socket }), sender, daemon };
}

describe("A: mesh control to the daemon", () => {
  it("stop is executed by the daemon and acked in <2s", async (t) => {
    const { client, sender } = await setupMesh(t);
    const job = await client.run({ command: "sleep 30", cwd: process.cwd(), owner: "lead" });
    const started = Date.now();
    const res = await sender.control({ to: "lead-jobd", target: job.jobId, timeoutMs: 4_000 });
    assert.equal(res.status, "stopped");
    assert.ok(Date.now() - started < 2_000);
    await waitFor(() => (alive(job.pid!) ? undefined : true));
    assert.equal(alive(job.pid!), false);
  });

  it("a broker refusal settles with the real reason, not a timeout", async (t) => {
    const { sender } = await setupMesh(t);
    const started = Date.now();
    const res = await sender.control({ to: "missing-jobd", target: "j_x", timeoutMs: 4_000 });
    assert.equal(res.status, "error");
    if (res.status === "error") assert.equal(res.reason, "peer_not_found");
    assert.ok(Date.now() - started < 1_500, "refusal must not wait for the full timeout");
  });

  it("a lost job is an error, never a false stopped", async (t) => {
    const dirs = makeTempDirs();
    t.after(() => dirs.cleanup());
    const broker = await startTestBroker(dirs.runtimeDir);
    t.after(async () => {
      await broker.close();
    });
    const socket = join(dirs.runtimeDir, "jobd.sock");
    const stateDir = dirs.stateDir;
    const first = new JobDaemon({ socketPath: socket, stateDir, owner: "lead" });
    await first.start();
    const c1 = new JobdClient({ socketPath: socket });
    const job = await c1.run({ command: "sleep 30", cwd: process.cwd(), owner: "lead" });
    c1.close();
    await first.close();

    const second = new JobDaemon({ socketPath: socket, stateDir, owner: "lead" });
    await second.start();
    const mesh = await connectDaemonMesh({ owner: "lead", daemonAlias: "lead-jobd", runtimeDir: dirs.runtimeDir, stateDir, socketPath: socket });
    attachMeshToDaemon(second, mesh);
    const sender = new MeshClient({ alias: "lead-sender2", runtimeDir: dirs.runtimeDir, config: {} });
    await sender.connect();
    t.after(async () => {
      await sender.close();
      await mesh.close();
      try {
        process.kill(-job.pid!, "SIGKILL");
      } catch {
        // gone
      }
      await second.close();
    });
    const res = await sender.control({ to: "lead-jobd", target: job.jobId });
    assert.equal(res.status, "error");
    if (res.status === "error") assert.match(res.reason, /orphaned/);
  });

  it("falls back deterministically to -2 and records the actual alias", async (t) => {
    const dirs = makeTempDirs();
    t.after(() => dirs.cleanup());
    const broker = await startTestBroker(dirs.runtimeDir);
    t.after(async () => {
      await broker.close();
    });
    const holder = new MeshClient({ alias: "lead-jobd", runtimeDir: dirs.runtimeDir, config: {} });
    await holder.connect();
    t.after(async () => {
      await holder.close();
    });
    const mesh = await connectDaemonMesh({
      owner: "lead",
      daemonAlias: "lead-jobd",
      runtimeDir: dirs.runtimeDir,
      stateDir: dirs.stateDir,
    });
    t.after(async () => {
      await mesh.close();
    });
    assert.equal(mesh.alias, "lead-jobd-2");
    const info = JSON.parse(readFileSync(join(dirs.stateDir, "daemon.json"), "utf8")) as { alias: string; canonical: string };
    assert.equal(info.alias, "lead-jobd-2");
    assert.equal(info.canonical, "lead-jobd");
  });

  it("pause/resume via mesh; non-pausable is refused", async (t) => {
    const { client, sender } = await setupMesh(t);
    const job = await client.run({ command: "sleep 30", cwd: process.cwd(), owner: "lead", pausable: true });
    const paused = await sender.control({ to: "lead-jobd", target: job.jobId, action: "pause" });
    assert.equal(paused.status, "paused");
    await waitFor(() => (procState(job.pid!) === "T" ? true : undefined));
    const resumed = await sender.control({ to: "lead-jobd", target: job.jobId, action: "resume" });
    assert.equal(resumed.status, "resumed");

    const plain = await client.run({ command: "sleep 30", cwd: process.cwd(), owner: "lead" });
    const refused = await sender.control({ to: "lead-jobd", target: plain.jobId, action: "pause" });
    assert.equal(refused.status, "not_pausable");
    assert.notEqual(procState(plain.pid!), "T");
  });

  it("unknown target is an honest not_found", async (t) => {
    const { sender } = await setupMesh(t);
    const res = await sender.control({ to: "lead-jobd", target: "j_missing" });
    assert.equal(res.status, "not_found");
  });

  it("ensureJobd spawns a detached local-only daemon", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "mesh-jobd-spawn-"));
    const stateDir = join(root, "state");
    const socketPath = join(root, "jobd.sock");
    const client = await ensureJobd({ socketPath, stateDir, owner: "spawner", mesh: false });
    const pidFile = join(stateDir, "jobd.pid");
    t.after(() => {
      try {
        const pid = Number(readFileSync(pidFile, "utf8").trim());
        process.kill(pid, "SIGTERM");
        setTimeout(() => {
          try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
        }, 300).unref();
      } catch {
        // already gone
      }
    });
    assert.equal(existsSync(pidFile), true);
    const job = await client.run({ command: "sleep 30", cwd: process.cwd(), owner: "spawner" });
    assert.equal((await client.list("spawner")).length, 1);
    const stopped = await client.stop(job.jobId, 500);
    assert.equal(stopped?.state, "stopped");
  });
});
