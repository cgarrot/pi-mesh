// test/job-integration.test.ts — A: a peer stops another session's long job.
// The daemon (not the target's LLM) executes the stop; the job survives the
// session that started it.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { JobDaemon } from "../src/jobd/daemon.js";
import { JobdClient } from "../src/jobd/client.js";
import { attachMeshToDaemon, connectDaemonMesh } from "../src/jobd/mesh.js";
import { MeshClient } from "../src/client/client.js";
import { makeTempDirs, startTestBroker, type TempDirs } from "./helpers.js";

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
  const socket = join(dirs.runtimeDir, "jobd.sock");
  const daemon = new JobDaemon({ socketPath: socket, stateDir: dirs.stateDir, owner: "owner" });
  await daemon.start();
  const daemonMesh = await connectDaemonMesh({ owner: "owner", daemonAlias: "owner-jobd", runtimeDir: dirs.runtimeDir });
  attachMeshToDaemon(daemon, daemonMesh);
  const alice = new MeshClient({ alias: "alice", runtimeDir: dirs.runtimeDir, config: {} });
  const bob = new MeshClient({ alias: "bob", runtimeDir: dirs.runtimeDir, config: {} });
  await alice.connect();
  await bob.connect();
  t.after(async () => {
    await alice.close();
    await bob.close();
    await daemonMesh.close();
    for (const job of daemon.list()) {
      if (job.state === "running" && job.pid !== undefined) {
        try {
          process.kill(-job.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
    await daemon.close();
  });
  return { dirs, daemon, jobd: new JobdClient({ socketPath: socket }), alice, bob };
}

describe("A: cross-session stop", () => {
  it("bob stops a long job started by alice; the daemon acks in <2s", async (t) => {
    const { jobd, bob } = await setup(t);
    const job = await jobd.run({ command: "sleep 30", cwd: process.cwd(), owner: "owner" });
    const started = Date.now();
    const res = await bob.control({ to: "owner-jobd", target: job.jobId, timeoutMs: 4_000 });
    assert.equal(res.status, "stopped");
    assert.ok(Date.now() - started < 2_000);
    await waitFor(() => (alive(job.pid!) ? undefined : true));
    assert.equal(alive(job.pid!), false);
  });

  it("the job survives the session that started it; another peer can still stop it", async (t) => {
    const { jobd, alice, bob } = await setup(t);
    const job = await jobd.run({ command: "sleep 30", cwd: process.cwd(), owner: "owner" });
    await alice.close(); // session A disappears; the daemon/job do not
    assert.equal(alive(job.pid!), true);
    const res = await bob.control({ to: "owner-jobd", target: job.jobId });
    assert.equal(res.status, "stopped");
    await waitFor(() => (alive(job.pid!) ? undefined : true));
    assert.equal(alive(job.pid!), false);
  });

  it("a daemon restart marks the old running job lost (no re-attach in v1)", async (t) => {
    const root = mkdtempSync(join(tmpdir(), "mesh-job-int-"));
    const socket = join(root, "jobd.sock");
    const stateDir = join(root, "state");
    const first = new JobDaemon({ socketPath: socket, stateDir, owner: "owner2" });
    await first.start();
    const c1 = new JobdClient({ socketPath: socket });
    const job = await c1.run({ command: "sleep 30", cwd: process.cwd(), owner: "owner2" });
    c1.close();
    await first.close();
    t.after(() => {
      try {
        process.kill(-job.pid!, "SIGKILL");
      } catch {
        // gone
      }
    });
    const second = new JobDaemon({ socketPath: socket, stateDir, owner: "owner2" });
    await second.start();
    const c2 = new JobdClient({ socketPath: socket });
    t.after(async () => {
      try {
        process.kill(-job.pid!, "SIGKILL");
      } catch {
        // gone
      }
      await second.close();
    });
    assert.equal((await c2.status(job.jobId))?.state, "lost");
    assert.equal(existsSync(join(stateDir, "jobs", `${job.jobId}.json`)), true);
    assert.match(readFileSync(join(stateDir, "jobs", `${job.jobId}.json`), "utf8"), /"lost"/);
  });
});
