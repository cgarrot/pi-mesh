// test/jobd.test.ts — A: detached job supervisor (real processes, no mocks).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { JobDaemon } from "../src/jobd/daemon.js";
import { JobdClient } from "../src/jobd/client.js";

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 3_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Linux /proc state: R/S = running, T = stopped (SIGSTOP). */
function procState(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const close = stat.lastIndexOf(")");
  return stat.slice(close + 2, close + 3);
}

function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

async function setup(t: { after: (fn: () => void | Promise<void>) => void }): Promise<{
  daemon: JobDaemon;
  client: JobdClient;
  stateDir: string;
  socketPath: string;
}> {
  const root = mkdtempSync(join(tmpdir(), "mesh-jobd-"));
  const stateDir = join(root, "state");
  const socketPath = join(root, "jobd.sock");
  const daemon = new JobDaemon({ socketPath, stateDir, owner: "lead" });
  await daemon.start();
  const client = new JobdClient({ socketPath });
  t.after(async () => {
    for (const job of daemon.list()) {
      if (job.state === "running") killGroup(job.pid);
    }
    client.close();
    await daemon.close();
  });
  return { daemon, client, stateDir, socketPath };
}

describe("A: job daemon core", () => {
  it("run → status running → stop kills the process group", async (t) => {
    const { client } = await setup(t);
    const job = await client.run({ command: "sleep 30", cwd: process.cwd(), owner: "lead" });
    assert.ok(job.jobId.startsWith("j_"));
    assert.ok((job.pid ?? 0) > 0);
    assert.equal(job.state, "running");
    assert.ok(existsSync(job.logPath));
    assert.equal((await client.status(job.jobId))?.state, "running");

    const started = Date.now();
    const stopped = await client.stop(job.jobId, 500);
    assert.equal(stopped?.state, "stopped");
    assert.ok(Date.now() - started < 2_000, "stop should be bounded");
    const pid = job.pid!;
    await waitFor(() => (alive(pid) ? undefined : true));
    assert.equal(alive(pid), false);
  });

  it("captures exit code + log for a failing command", async (t) => {
    const { client, daemon } = await setup(t);
    const job = await client.run({ command: "echo hello-jobd; exit 3", cwd: process.cwd(), owner: "lead" });
    const done = await waitFor(() => {
      const cur = daemon.status(job.jobId);
      return cur !== undefined && cur.state !== "running" ? cur : undefined;
    });
    assert.equal(done.state, "failed");
    assert.equal(done.exitCode, 3);
    await waitFor(() => (readFileSync(job.logPath, "utf8").includes("hello-jobd") ? true : undefined));
  });

  it("list filters by owner", async (t) => {
    const { client } = await setup(t);
    const a = await client.run({ command: "sleep 30", cwd: process.cwd(), owner: "lead" });
    const b = await client.run({ command: "sleep 30", cwd: process.cwd(), owner: "other" });
    const leadJobs = await client.list("lead");
    assert.equal(leadJobs.some((j) => j.jobId === a.jobId), true);
    assert.equal(leadJobs.some((j) => j.jobId === b.jobId), false);
  });

  it("pauses/resumes only a pausable job (SIGSTOP state T)", async (t) => {
    const { client } = await setup(t);
    const job = await client.run({ command: "sleep 30", cwd: process.cwd(), owner: "lead", pausable: true });
    const paused = await client.pause(job.jobId);
    assert.equal(paused.status, "paused");
    await waitFor(() => (procState(job.pid!) === "T" ? true : undefined));
    const resumed = await client.resume(job.jobId);
    assert.equal(resumed.status, "resumed");
    await waitFor(() => (procState(job.pid!) !== "T" ? true : undefined));
    assert.equal((await client.stop(job.jobId, 500))?.state, "stopped");
  });

  it("is idempotent: double pause/resume, honest not_paused", async (t) => {
    const { client } = await setup(t);
    const job = await client.run({ command: "sleep 30", cwd: process.cwd(), owner: "lead", pausable: true });
    assert.equal((await client.pause(job.jobId)).status, "paused");
    assert.equal((await client.pause(job.jobId)).status, "paused");
    assert.equal((await client.resume(job.jobId)).status, "resumed");
    assert.equal((await client.resume(job.jobId)).status, "not_paused");
  });

  it("daemon close resumes a paused job (never stopped forever)", async (t) => {
    const { daemon, client } = await setup(t);
    const job = await client.run({ command: "sleep 30", cwd: process.cwd(), owner: "lead", pausable: true });
    await client.pause(job.jobId);
    await waitFor(() => (procState(job.pid!) === "T" ? true : undefined));
    await daemon.close();
    await waitFor(() => (procState(job.pid!) !== "T" ? true : undefined));
    killGroup(job.pid);
  });

  it("records an externally killed paused job instead of staying paused", async (t) => {
    const { daemon, client } = await setup(t);
    const job = await client.run({ command: "sleep 30", cwd: process.cwd(), owner: "lead", pausable: true });
    await client.pause(job.jobId);
    await waitFor(() => (procState(job.pid!) === "T" ? true : undefined));
    process.kill(-job.pid!, "SIGKILL");
    const done = await waitFor(() => {
      const cur = daemon.status(job.jobId);
      return cur !== undefined && cur.state !== "paused" ? cur : undefined;
    });
    assert.ok(done.state === "failed" || done.state === "stopped");
  });

  it("never SIGSTOPs a job that did not declare pausable", async (t) => {
    const { client } = await setup(t);
    const job = await client.run({ command: "sleep 30", cwd: process.cwd(), owner: "lead" });
    const paused = await client.pause(job.jobId);
    assert.equal(paused.status, "not_pausable");
    assert.notEqual(procState(job.pid!), "T");
  });

  it("stopping a paused job continues it first, then terminates", async (t) => {
    const { client } = await setup(t);
    const job = await client.run({ command: "sleep 30", cwd: process.cwd(), owner: "lead", pausable: true });
    await client.pause(job.jobId);
    await waitFor(() => (procState(job.pid!) === "T" ? true : undefined));
    const stopped = await client.stop(job.jobId, 500);
    assert.equal(stopped?.state, "stopped");
    await waitFor(() => (alive(job.pid!) ? undefined : true));
    assert.equal(alive(job.pid!), false);
  });

  it("kills a TERM-ignoring job after the grace (SIGKILL fallback)", async (t) => {
    const { client } = await setup(t);
    const job = await client.run({ command: "trap '' TERM; sleep 30", cwd: process.cwd(), owner: "lead" });
    const started = Date.now();
    const stopped = await client.stop(job.jobId, 200);
    assert.equal(stopped?.state, "stopped");
    assert.ok(Date.now() - started < 3_000);
    await waitFor(() => (alive(job.pid!) ? undefined : true));
    assert.equal(alive(job.pid!), false);
  });

  it("answers malformed socket lines without crashing", async (t) => {
    const { socketPath } = await setup(t);
    const socket = connect(socketPath);
    const line = await new Promise<string>((resolveLine, rejectLine) => {
      socket.on("connect", () => socket.write("not json\n"));
      socket.on("data", (chunk) => resolveLine(chunk.toString()));
      socket.on("error", rejectLine);
    });
    socket.destroy();
    const res = JSON.parse(line.trim()) as { ok: boolean; error?: string };
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /bad_request/);
  });

  it("unknown job ids are honest errors", async (t) => {
    const { client } = await setup(t);
    await assert.rejects(() => client.status("j_missing"), /job_not_found/);
  });

  it("a daemon restart marks previously-running jobs lost", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "mesh-jobd-lost-"));
    const stateDir = join(root, "state");
    const socketPath = join(root, "jobd.sock");
    const first = new JobDaemon({ socketPath, stateDir, owner: "lead" });
    await first.start();
    const c1 = new JobdClient({ socketPath });
    const job = await c1.run({ command: "sleep 30", cwd: process.cwd(), owner: "lead" });
    c1.close();
    await first.close(); // jobs intentionally survive
    t.after(() => killGroup(job.pid));

    const second = new JobDaemon({ socketPath, stateDir, owner: "lead" });
    await second.start();
    t.after(async () => {
      killGroup(job.pid);
      await second.close();
    });
    const c2 = new JobdClient({ socketPath });
    t.after(() => c2.close());
    const lost = await c2.status(job.jobId);
    assert.equal(lost?.state, "lost");
    assert.equal(alive(job.pid!), true, "the OS process keeps running");
  });
});
