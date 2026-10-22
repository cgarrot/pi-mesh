// test/job-tools.test.ts — A task_0004: mesh_run / mesh_job / mesh_control.
// Fake-runtime pattern from tools-send.test.ts; the jobd client is ALWAYS an
// injected fake (jobdFactory) — no real daemon, no socket. ensureJobd itself
// is a stub until task_0003 and is never reached here.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ControlResult } from "../src/client/client.js";
import type { ExtensionAPI, SessionContext, ToolDefinition } from "../src/extension/pi-types.js";
import { registerTools, type MeshRuntime } from "../src/extension/tools.js";
import type { JobdClient } from "../src/jobd/client.js";
import type { JobRecord } from "../src/jobd/protocol.js";
import { makeTempDirs } from "./helpers.js";

function baseJob(over: Partial<JobRecord> = {}): JobRecord {
  return {
    jobId: "j_live",
    pid: 111,
    command: "sleep 60",
    cwd: "/tmp",
    owner: "alice",
    state: "running",
    startedAt: "2026-10-21T08:00:00.000Z",
    logPath: "/state/jobs/j_live.log",
    ...over,
  };
}

interface JobdCalls {
  run: { command: string; cwd: string; owner: string }[];
  status: string[];
  list: (string | undefined)[];
  stop: string[];
  pause: string[];
  resume: string[];
}

interface FakeJobdOpts {
  /** jobs addressable by jobId (status/stop); missing id → undefined. */
  known?: Record<string, JobRecord>;
  /** what list() returns. */
  listJobs?: JobRecord[];
  /** record returned by run(). */
  runJob?: JobRecord;
}

/** Fake JobdClient with call spies — status/stop return undefined for
 * unknown ids (honest not_found), stop marks the record stopped. */
function fakeJobd(calls: JobdCalls, opts: FakeJobdOpts = {}): JobdClient {
  const known = opts.known ?? { j_live: baseJob() };
  return {
    run: async (o: { command: string; cwd: string; owner: string }) => {
      calls.run.push(o);
      return opts.runJob ?? baseJob({ jobId: "j_run1", pid: 4242, command: o.command, cwd: o.cwd, owner: o.owner, logPath: "/state/jobs/j_run1.log" });
    },
    status: async (jobId: string) => {
      calls.status.push(jobId);
      return known[jobId] === undefined ? undefined : { ...known[jobId] };
    },
    list: async (owner?: string) => {
      calls.list.push(owner);
      return (opts.listJobs ?? [baseJob()]).map((j) => ({ ...j }));
    },
    stop: async (jobId: string) => {
      calls.stop.push(jobId);
      const j = known[jobId];
      return j === undefined ? undefined : { ...j, state: "stopped" as const, endedAt: "2026-10-21T08:01:00.000Z" };
    },
    pause: async (jobId: string) => {
      calls.pause.push(jobId);
      const j = known[jobId];
      if (j === undefined) return { status: "not_running" };
      if (j.pausable !== true) return { status: "not_pausable", job: { ...j } };
      return { status: "paused", job: { ...j, state: "paused" as const } };
    },
    resume: async (jobId: string) => {
      calls.resume.push(jobId);
      const j = known[jobId];
      if (j === undefined) return { status: "not_running" };
      if (j.state !== "paused") return { status: "not_paused", job: { ...j } };
      return { status: "resumed", job: { ...j, state: "running" as const } };
    },
    close: () => {},
  } as unknown as JobdClient;
}

interface ControlCall {
  to: string;
  target: string;
  timeoutMs?: number;
}

function makeRuntime(
  jobd: JobdClient,
  controlResult: ControlResult = { status: "stopped", target: "" },
  ctx: SessionContext | null = null,
): { rt: MeshRuntime; controlCalls: ControlCall[] } {
  const controlCalls: ControlCall[] = [];
  const rt = {
    client: {
      alias: "alice",
      rooms: ["default"],
      isOnline: () => true,
      control: (opts: ControlCall) => {
        controlCalls.push(opts);
        return Promise.resolve({ ...controlResult, target: opts.target });
      },
      connect: () => Promise.reject(new Error("must not connect in these tests")),
    },
    jobdFactory: () => Promise.resolve(jobd),
    ctx,
    stateDir: "/unused",
    runtimeDir: "/unused",
    startedAt: Date.now(),
    ledgerFailures: 0,
    transcriptFailures: 0,
    injectionFailures: 0,
  } as unknown as MeshRuntime;
  return { rt, controlCalls };
}

function toolRuntime(rt: MeshRuntime): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerTool: (def: ToolDefinition) => tools.set(def.name, def),
  } as unknown as ExtensionAPI;
  registerTools(pi, () => rt);
  return tools;
}

/** Registered tool or assert (TS strict: Map.get is T | undefined). */
function getTool(rt: MeshRuntime, name: string): ToolDefinition {
  const tool = toolRuntime(rt).get(name);
  assert.ok(tool, `${name} tool registered`);
  return tool;
}

function emptyCalls(): JobdCalls {
  return { run: [], status: [], list: [], stop: [], pause: [], resume: [] };
}

const CTX = (cwd: string) => ({ cwd }) as unknown as SessionContext;

describe("mesh_run", () => {
  it("passes command/cwd/owner to jobd and returns jobId/pid/logPath", async () => {
    const calls = emptyCalls();
    const { rt } = makeRuntime(fakeJobd(calls));
    const tool = getTool(rt, "mesh_run");

    const res = await tool.execute("tc1", { command: "sleep 30", cwd: "/tmp/x", owner: "bob" }, undefined, undefined, CTX("/ctx/dir"));
    assert.deepEqual(calls.run, [{ command: "sleep 30", cwd: "/tmp/x", owner: "bob" }]);
    assert.match(res.content[0]!.text, /started j_run1 pid=4242 log=\/state\/jobs\/j_run1\.log/);
    assert.equal(res.details?.status, "delivered");
    assert.equal(res.details?.jobId, "j_run1");
    assert.equal(res.details?.pid, 4242);
    assert.equal(res.details?.logPath, "/state/jobs/j_run1.log");
  });

  it("defaults cwd to ctx.cwd and owner to the session alias", async () => {
    const calls = emptyCalls();
    const { rt } = makeRuntime(fakeJobd(calls), undefined, CTX("/ctx/dir"));
    const tool = getTool(rt, "mesh_run");

    await tool.execute("tc2", { command: "make build" }, undefined, undefined, CTX("/ctx/dir"));
    assert.deepEqual(calls.run, [{ command: "make build", cwd: "/ctx/dir", owner: "alice" }]);
  });

  it("falls back to process.cwd() when ctx is null and cwd is omitted", async () => {
    const calls = emptyCalls();
    const { rt } = makeRuntime(fakeJobd(calls), undefined, null);
    const tool = getTool(rt, "mesh_run");

    await tool.execute("tc3", { command: "true" }, undefined, undefined, CTX("/whatever"));
    assert.equal(calls.run[0]?.cwd, process.cwd());
  });

  it("missing command → honest error, jobd never called", async () => {
    const calls = emptyCalls();
    const { rt } = makeRuntime(fakeJobd(calls));
    const tool = getTool(rt, "mesh_run");

    const res = await tool.execute("tc4", {}, undefined, undefined, CTX("/ctx"));
    assert.match(res.content[0]!.text, /^error:/);
    assert.equal(res.details?.status, "error");
    assert.deepEqual(calls.run, []);
  });
});

describe("mesh_job", () => {
  it("status returns the job record (text + details)", async () => {
    const calls = emptyCalls();
    const { rt } = makeRuntime(fakeJobd(calls));
    const tool = getTool(rt, "mesh_job");

    const res = await tool.execute("tc5", { jobId: "j_live", action: "status" }, undefined, undefined, CTX("/ctx"));
    assert.deepEqual(calls.status, ["j_live"]);
    assert.match(res.content[0]!.text, /j_live running pid=111 owner=alice/);
    assert.equal(res.details?.status, "delivered");
    assert.equal((res.details?.job as JobRecord).state, "running");
  });

  it("status of an unknown job → honest not_found", async () => {
    const { rt } = makeRuntime(fakeJobd(emptyCalls()));
    const tool = getTool(rt, "mesh_job");

    const res = await tool.execute("tc6", { jobId: "j_missing", action: "status" }, undefined, undefined, CTX("/ctx"));
    assert.match(res.content[0]!.text, /not_found/);
    assert.equal(res.details?.status, "not_found");
  });

  it("list calls client.list with the session alias and returns all jobs", async () => {
    const calls = emptyCalls();
    const { rt } = makeRuntime(
      fakeJobd(calls, { listJobs: [baseJob(), baseJob({ jobId: "j_done", pid: 222, state: "exited", exitCode: 0 })] }),
    );
    const tool = getTool(rt, "mesh_job");

    const res = await tool.execute("tc7", { jobId: "-", action: "list" }, undefined, undefined, CTX("/ctx"));
    assert.deepEqual(calls.list, [undefined]);
    assert.match(res.content[0]!.text, /jobs \(2\)/);
    assert.match(res.content[0]!.text, /j_done exited/);
    assert.equal(res.details?.count, 2);
    assert.equal((res.details?.jobs as JobRecord[]).length, 2);
  });

  it("stop calls client.stop(jobId) and reports the stopped state", async () => {
    const calls = emptyCalls();
    const { rt } = makeRuntime(fakeJobd(calls));
    const tool = getTool(rt, "mesh_job");

    const res = await tool.execute("tc8", { jobId: "j_live", action: "stop" }, undefined, undefined, CTX("/ctx"));
    assert.deepEqual(calls.stop, ["j_live"]);
    assert.match(res.content[0]!.text, /stop sent: j_live stopped/);
    assert.equal((res.details?.job as JobRecord).state, "stopped");
  });

  it("missing jobId / missing or invalid action → honest errors", async () => {
    const calls = emptyCalls();
    const { rt } = makeRuntime(fakeJobd(calls));
    const tool = getTool(rt, "mesh_job");

    const noId = await tool.execute("tc9", { action: "status" }, undefined, undefined, CTX("/ctx"));
    assert.match(noId.content[0]!.text, /^error:/);
    assert.equal(noId.details?.status, "error");

    const noAction = await tool.execute("tc10", { jobId: "j_live" }, undefined, undefined, CTX("/ctx"));
    assert.match(noAction.content[0]!.text, /^error:/);

    const badAction = await tool.execute("tc11", { jobId: "j_live", action: "restart" }, undefined, undefined, CTX("/ctx"));
    assert.match(badAction.content[0]!.text, /invalid_action/);

    const notPausable = await tool.execute("tc11b", { jobId: "j_live", action: "pause" }, undefined, undefined, CTX("/ctx"));
    assert.match(notPausable.content[0]!.text, /not_pausable/);
    assert.deepEqual(calls.pause, ["j_live"]);
    assert.deepEqual([calls.status.length, calls.stop.length, calls.resume.length], [0, 0, 0]);
  });
});

describe("mesh_control", () => {
  it("appends '-jobd' to a bare owner alias and reports stopped", async () => {
    const { rt, controlCalls } = makeRuntime(undefined as unknown as JobdClient, { status: "stopped", target: "" });
    const tool = getTool(rt, "mesh_control");

    const res = await tool.execute("tc12", { to: "bob", jobId: "j_remote" }, undefined, undefined, CTX("/ctx"));
    assert.deepEqual(controlCalls, [{ to: "bob-jobd", target: "j_remote", action: "stop", timeoutMs: undefined }]);
    assert.match(res.content[0]!.text, /stopped j_remote via @bob-jobd/);
    assert.equal(res.details?.status, "stopped");
    assert.equal(res.details?.to, "bob-jobd");
  });

  it("keeps a '-jobd' alias as-is and normalizes '@Owner' casing/prefix", async () => {
    const { rt, controlCalls } = makeRuntime(undefined as unknown as JobdClient, { status: "stopped", target: "" });
    const tool = getTool(rt, "mesh_control");

    await tool.execute("tc13", { to: "carol-jobd", jobId: "j_1" }, undefined, undefined, CTX("/ctx"));
    await tool.execute("tc14", { to: "@Bob", jobId: "j_2" }, undefined, undefined, CTX("/ctx"));
    assert.deepEqual(
      controlCalls.map((c) => c.to),
      ["carol-jobd", "bob-jobd"],
    );
  });

  it("forwards timeoutMs and mirrors not_found / error outcomes honestly", async () => {
    const nf = makeRuntime(undefined as unknown as JobdClient, { status: "not_found", target: "" });
    const nfTool = getTool(nf.rt, "mesh_control");
    const nfRes = await nfTool.execute("tc15", { to: "bob", jobId: "j_gone", timeoutMs: 2500 }, undefined, undefined, CTX("/ctx"));
    assert.equal(nf.controlCalls[0]?.timeoutMs, 2500);
    assert.match(nfRes.content[0]!.text, /not_found/);
    assert.equal(nfRes.details?.status, "not_found");

    const err = makeRuntime(undefined as unknown as JobdClient, { status: "error", target: "", reason: "timeout" });
    const errTool = getTool(err.rt, "mesh_control");
    const errRes = await errTool.execute("tc16", { to: "bob-jobd", jobId: "j_x" }, undefined, undefined, CTX("/ctx"));
    assert.match(errRes.content[0]!.text, /error: timeout/);
    assert.equal(errRes.details?.status, "error");
    assert.equal(errRes.details?.reason, "timeout");
  });

  it("missing to or jobId → honest error, no control call", async () => {
    const { rt, controlCalls } = makeRuntime(undefined as unknown as JobdClient);
    const tool = getTool(rt, "mesh_control");

    const noTo = await tool.execute("tc17", { jobId: "j_1" }, undefined, undefined, CTX("/ctx"));
    assert.match(noTo.content[0]!.text, /^error:/);
    const noJob = await tool.execute("tc18", { to: "bob" }, undefined, undefined, CTX("/ctx"));
    assert.match(noJob.content[0]!.text, /^error:/);
    assert.deepEqual(controlCalls, []);
  });
});
