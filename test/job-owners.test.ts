// test/job-owners.test.ts — v2: one daemon per session owner (no shared
// socket/alias/job table). Two owners must not see or steal each other's jobs.
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { JobDaemon } from "../src/jobd/daemon.js";
import { JobdClient } from "../src/jobd/client.js";
import { attachMeshToDaemon, connectDaemonMesh } from "../src/jobd/mesh.js";
import { jobdSocketPath, jobdStateDir } from "../src/extension/tools.js";
import { MeshClient } from "../src/client/client.js";
import { makeTempDirs, startTestBroker, type TempDirs } from "./helpers.js";

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

interface OwnerHarness {
  dirs: TempDirs;
  daemons: JobDaemon[];
  sockets: string[];
  jobds: JobdClient[];
  senders: MeshClient[];
}

async function setup(t: { after: (fn: () => void | Promise<void>) => void }): Promise<OwnerHarness> {
  const dirs = makeTempDirs();
  t.after(() => dirs.cleanup());
  const broker = await startTestBroker(dirs.runtimeDir);
  t.after(async () => {
    await broker.close();
  });
  const daemons: JobDaemon[] = [];
  const sockets: string[] = [];
  const jobds: JobdClient[] = [];
  const senders: MeshClient[] = [];
  const daemonMeshes: MeshClient[] = [];
  for (const owner of ["alice", "bob"] as const) {
    const socket = jobdSocketPath(dirs.runtimeDir, owner);
    const stateDir = jobdStateDir(dirs.stateDir, owner);
    const daemon = new JobDaemon({ socketPath: socket, stateDir, owner });
    await daemon.start();
    const mesh = await connectDaemonMesh({
      owner,
      daemonAlias: `${owner}-jobd`,
      runtimeDir: dirs.runtimeDir,
      stateDir,
      socketPath: socket,
    });
    attachMeshToDaemon(daemon, mesh);
    daemonMeshes.push(mesh);
    daemons.push(daemon);
    sockets.push(socket);
    jobds.push(new JobdClient({ socketPath: socket }));
    const sender = new MeshClient({ alias: owner, runtimeDir: dirs.runtimeDir, config: {} });
    await sender.connect();
    senders.push(sender);
  }
  t.after(async () => {
    for (const s of senders) await s.close();
    for (const m of daemonMeshes) await m.close();
    for (const d of daemons) {
      for (const job of d.list()) if (job.pid !== undefined) killGroup(job.pid);
      await d.close();
    }
  });
  return { dirs, daemons, sockets, jobds, senders };
}

describe("v2: per-owner daemons", () => {
  it("derives distinct sockets and aliases per owner", async (t) => {
    const { dirs, sockets } = await setup(t);
    assert.equal(sockets[0], jobdSocketPath(dirs.runtimeDir, "alice"));
    assert.equal(sockets[1], jobdSocketPath(dirs.runtimeDir, "bob"));
    assert.notEqual(sockets[0], sockets[1]);
    assert.match(sockets[0]!, /jobd-alice\.sock$/);
    assert.match(sockets[1]!, /jobd-bob\.sock$/);
  });

  it("each daemon only sees its owner's jobs; cross-owner control still works", async (t) => {
    const { daemons, jobds, senders } = await setup(t);
    assert.ok(daemons.length === 2 && jobds.length === 2 && senders.length === 2);
    const aliceJob = await jobds[0]!.run({ command: "sleep 30", cwd: process.cwd(), owner: "alice" });
    const bobJob = await jobds[1]!.run({ command: "sleep 30", cwd: process.cwd(), owner: "bob" });
    assert.deepEqual(daemons[0]!.list().map((j) => j.jobId), [aliceJob.jobId]);
    assert.deepEqual(daemons[1]!.list().map((j) => j.jobId), [bobJob.jobId]);

    // alice stops bob's job through bob's daemon alias; alice's own job stays.
    const res = await senders[0]!.control({ to: "bob-jobd", target: bobJob.jobId });
    assert.equal(res.status, "stopped");
    assert.equal(daemons[0]!.status(aliceJob.jobId)?.state, "running");
    assert.notEqual(daemons[1]!.status(bobJob.jobId)?.state, "running");
  });

  it("restarting one owner's daemon never marks the other owner's jobs lost", async (t) => {
    const { dirs, daemons, jobds } = await setup(t);
    const bobJob = await jobds[1]!.run({ command: "sleep 30", cwd: process.cwd(), owner: "bob" });
    await daemons[0]!.close();
    const restarted = new JobDaemon({
      socketPath: jobdSocketPath(dirs.runtimeDir, "alice"),
      stateDir: jobdStateDir(dirs.stateDir, "alice"),
      owner: "alice",
    });
    await restarted.start();
    t.after(async () => {
      await restarted.close();
    });
    assert.equal(daemons[1]!.status(bobJob.jobId)?.state, "running");
    assert.equal(restarted.list().some((job) => job.jobId === bobJob.jobId), false);
  });
});
