// test/rpc-tool.test.ts — C: mesh_rpc tool over a real fake-child worker.
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI, SessionContext, ToolDefinition } from "../src/extension/pi-types.js";
import { registerTools, type MeshRuntime } from "../src/extension/tools.js";
import { RpcWorker } from "../src/rpc/worker.js";

const fixture = join(process.cwd(), "test", "fixtures", "fake-rpc-worker.mjs");

function makeRuntime(): { rt: MeshRuntime; created: RpcWorker[] } {
  const created: RpcWorker[] = [];
  const rt = {
    client: { alias: "alice", rooms: ["default"], isOnline: () => true },
    ctx: { cwd: process.cwd() } as SessionContext,
    stateDir: "/unused",
    runtimeDir: "/unused",
    startedAt: Date.now(),
    ledgerFailures: 0,
    transcriptFailures: 0,
    injectionFailures: 0,
    rpcFactory: (opts: ConstructorParameters<typeof RpcWorker>[0]) => {
      const worker = new RpcWorker({
        ...opts,
        command: { bin: process.execPath, args: [fixture] },
        defaultTimeoutMs: 2_000,
      });
      created.push(worker);
      return worker;
    },
  } as unknown as MeshRuntime;
  return { rt, created };
}

function toolRuntime(rt: MeshRuntime): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>();
  const pi = { registerTool: (def: ToolDefinition) => tools.set(def.name, def) } as unknown as ExtensionAPI;
  registerTools(pi, () => rt);
  return tools;
}

function getTool(rt: MeshRuntime, name: string): ToolDefinition {
  const tool = toolRuntime(rt).get(name);
  assert.ok(tool, `${name} registered`);
  return tool;
}

const CTX = { cwd: process.cwd() } as SessionContext;

describe("C: mesh_rpc tool", () => {
  it("starts one worker, prompts/steers/queues, then stops", async (t) => {
    const { rt, created } = makeRuntime();
    const tool = getTool(rt, "mesh_rpc");
    t.after(async () => {
      await rt.rpcWorker?.stop(500);
    });

    const started = await tool.execute("tc1", { action: "start" }, undefined, undefined, CTX);
    assert.match(started.content[0]!.text, /rpc worker started pid=/);
    assert.equal(started.details?.status, "delivered");
    assert.equal(created.length, 1);
    assert.equal(rt.rpcWorker, created[0]);

    const again = await tool.execute("tc2", { action: "start" }, undefined, undefined, CTX);
    assert.match(again.content[0]!.text, /already_running/);

    const prompt = await tool.execute("tc3", { action: "prompt", message: "hello" }, undefined, undefined, CTX);
    assert.match(prompt.content[0]!.text, /prompt accepted/);

    const steer = await tool.execute("tc4", { action: "steer", message: "do X" }, undefined, undefined, CTX);
    assert.match(steer.content[0]!.text, /steer queued/);

    const follow = await tool.execute("tc5", { action: "follow_up", message: "later" }, undefined, undefined, CTX);
    assert.match(follow.content[0]!.text, /follow_up queued/);

    const redirect = await tool.execute(
      "tc6",
      { action: "redirect", message: "use the new plan" },
      undefined,
      undefined,
      CTX,
    );
    assert.match(redirect.content[0]!.text, /redirected after aborting the previous turn/);

    const state = await tool.execute("tc7", { action: "state" }, undefined, undefined, CTX);
    assert.match(state.content[0]!.text, /state pending=2 steering=all/);

    const mode = await tool.execute("tc8", { action: "set_steering_mode", mode: "all" }, undefined, undefined, CTX);
    assert.match(mode.content[0]!.text, /steering mode: all/);

    const stopped = await tool.execute("tc9", { action: "stop" }, undefined, undefined, CTX);
    assert.match(stopped.content[0]!.text, /rpc worker stopped/);
    assert.equal(rt.rpcWorker, null);
  });

  it("start fails honestly when the child cannot spawn", async () => {
    const { rt } = makeRuntime();
    rt.rpcFactory = (opts) =>
      new RpcWorker({
        ...opts,
        command: { bin: "/nonexistent-node-for-rpc-tool", args: [] },
        defaultTimeoutMs: 300,
      });
    const tool = getTool(rt, "mesh_rpc");
    const res = await tool.execute("tc1", { action: "start" }, undefined, undefined, CTX);
    assert.match(res.content[0]!.text, /failed to start/);
    assert.equal(rt.rpcWorker ?? null, null);
  });

  it("missing worker and bad arguments are honest errors", async (t) => {
    const { rt } = makeRuntime();
    const tool = getTool(rt, "mesh_rpc");
    t.after(async () => {
      await rt.rpcWorker?.stop(500);
    });

    const noWorker = await tool.execute("tc1", { action: "prompt", message: "x" }, undefined, undefined, CTX);
    assert.match(noWorker.content[0]!.text, /rpc_worker_not_running/);

    const noMessage = await tool.execute("tc2", { action: "prompt" }, undefined, undefined, CTX);
    assert.match(noMessage.content[0]!.text, /message is required/);

    const badMode = await tool.execute("tc3", { action: "set_steering_mode", mode: "nope" }, undefined, undefined, CTX);
    assert.match(badMode.content[0]!.text, /mode must be/);

    const badAction = await tool.execute("tc4", { action: "restart" }, undefined, undefined, CTX);
    assert.match(badAction.content[0]!.text, /invalid_action/);
  });
});
