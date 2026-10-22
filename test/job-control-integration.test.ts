// test/job-control-integration.test.ts — v2: cross-session pause/resume.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { JobDaemon } from "../src/jobd/daemon.js";
import { JobdClient } from "../src/jobd/client.js";
import { attachMeshToDaemon, connectDaemonMesh } from "../src/jobd/mesh.js";
import { jobdSocketPath } from "../src/extension/tools.js";
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

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone
    }
  }
}

interface Harness {
  dirs: TempDirs;
  daemon: JobDaemon;
  jobd: JobdClient;
  alice: MeshClient;
  bob: MeshClient;
}

async function setup(t: { after: (fn: () => void | Promise<void>) => void }): Promise<Harness> {
  const dirs = makeTempDirs();
  t.after(() => dirs.cleanup());
  const broker = await startTestBroker(dirs.runtimeDir);
  t.after(async () => {
    await broker.close();
  });
  const socket = jobdSocketPath(dirs.runtimeDir, "alice");
  const daemon = new JobDaemon({ socketPath: socket, stateDir: join(dirs.stateDir, "alice"), owner: "alice" });
  await daemon.start();
  const daemonMesh = await connectDaemonMesh({
    owner: "alice",
    daemonAlias: "alice-jobd",
    runtimeDir: dirs.runtimeDir,
    stateDir: join(dirs.stateDir, "alice"),
    socketPath: socket,
  });
  attachMeshToDaemon(daemon, daemonMesh);
  const alice = new MeshClient({ alias: "alice", runtimeDir: dirs.runtimeDir, config: {} });
  const bob = new MeshClient({ alias: "bob", runtimeDir: dirs.runtimeDir, config: {} });
  await alice.connect();
  await bob.connect();
  t.after(async () => {
    await alice.close();
    await bob.close();
    await daemonMesh.close();
    for (const job of daemon.list()) killGroup(job.pid);
    await daemon.close();
  });
  return { dirs, daemon, jobd: new JobdClient({ socketPath: socket }), alice, bob };
}

describe("v2: cross-session pause/resume", () => {
  it("bob pauses/resumes alice's pausable job, then stops it while paused", async (t) => {
    const { jobd, bob } = await setup(t);
    const job = await jobd.run({ command: "sleep 30", cwd: process.cwd(), owner: "alice", pausable: true });

    const paused = await bob.control({ to: "alice-jobd", target: job.jobId, action: "pause" });
    assert.equal(paused.status, "paused");
    await waitFor(() => (procState(job.pid!) === "T" ? true : undefined));

    const resumed = await bob.control({ to: "alice-jobd", target: job.jobId, action: "resume" });
    assert.equal(resumed.status, "resumed");
    await waitFor(() => (procState(job.pid!) !== "T" ? true : undefined));

    // Pause again, then stop: the daemon must SIGCONT before SIGTERM.
    assert.equal((await bob.control({ to: "alice-jobd", target: job.jobId, action: "pause" })).status, "paused");
    await waitFor(() => (procState(job.pid!) === "T" ? true : undefined));
    const stopped = await bob.control({ to: "alice-jobd", target: job.jobId, action: "stop" });
    assert.equal(stopped.status, "stopped");
    await waitFor(() => (alive(job.pid!) ? undefined : true));
    assert.equal(alive(job.pid!), false);
  });

  it("a non-pausable job is refused, never SIGSTOPed", async (t) => {
    const { jobd, bob } = await setup(t);
    const job = await jobd.run({ command: "sleep 30", cwd: process.cwd(), owner: "alice" });
    const refused = await bob.control({ to: "alice-jobd", target: job.jobId, action: "pause" });
    assert.equal(refused.status, "not_pausable");
    assert.notEqual(procState(job.pid!), "T");
    await bob.control({ to: "alice-jobd", target: job.jobId, action: "stop" });
  });
});
