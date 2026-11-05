import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import path from "node:path";
import meshExtension from "../src/extension/index.js";
import { MeshClient } from "../src/client/client.js";
import type { InboundMessage, SendMessageOptions, SessionContext, SessionHookHandler } from "../src/extension/pi-types.js";
import { makeTempDirs, sleep, startTestBroker, waitFor } from "./helpers.js";

async function setup(t: TestContext) {
  const dirs = makeTempDirs("reset-lifetime-");
  let broker = await startTestBroker(dirs.runtimeDir, { stateDir: dirs.stateDir });
  const config = { alias: "subject", brokerUrl: `unix://${broker.socketPath}`, inboundBatchMs: 10, inboundBatchMaxHoldMs: 30, debug: false };
  writeFileSync(path.join(dirs.stateDir, "config.json"), JSON.stringify(config));
  const oldState = process.env.MESH_STATE_DIR;
  const oldAlias = process.env.PI_MESH_ALIAS;
  process.env.MESH_STATE_DIR = dirs.stateDir;
  const observer = new MeshClient({ alias: "observer", runtimeDir: dirs.runtimeDir, config });
  const hooks = new Map<string, SessionHookHandler[]>();
  let command: (args: string, ctx: SessionContext) => Promise<void>;
  const sent: { message: InboundMessage; options?: SendMessageOptions }[] = [];
  let paints = 0;
  let throwReady = false;
  let failures = 0;
  let alias = "subject";
  const events = new EventEmitter();
  events.on("mesh:alias", (info: { alias: string }) => { alias = info.alias; });
  const ctx: SessionContext = {
    cwd: dirs.root, mode: "tui", isIdle: () => false,
    ui: { notify: () => {}, setWidget: () => { paints += 1; }, setStatus: () => {} },
  };
  const pi = {
    events,
    on: (event: string, fn: SessionHookHandler) => { hooks.set(event, [...hooks.get(event) ?? [], fn]); },
    registerTool: () => {},
    registerCommand: (_name: string, spec: { handler: typeof command }) => { command = spec.handler; },
    sendMessage: (message: InboundMessage, options?: SendMessageOptions) => {
      if (throwReady && message.customType === "mesh-context") { failures += 1; throw new Error("ready context unavailable"); }
      sent.push({ message, options });
    },
    appendEntry: () => {},
  };
  meshExtension(pi as never);
  const fire = async (event: string, payload = {}) => {
    for (const hook of hooks.get(event) ?? []) await hook(payload, ctx);
  };
  t.after(async () => {
    throwReady = false;
    await fire("session_shutdown");
    await observer.close();
    await broker.close();
    if (oldState === undefined) delete process.env.MESH_STATE_DIR;
    else process.env.MESH_STATE_DIR = oldState;
    if (oldAlias === undefined) delete process.env.PI_MESH_ALIAS;
    else process.env.PI_MESH_ALIAS = oldAlias;
    dirs.cleanup();
  });
  await observer.connect();
  await fire("session_start");
  await waitFor(() => sent.some((entry) => entry.message.customType === "mesh-context"));
  const fail = async () => {
    throwReady = true;
    await broker.close();
    await waitFor(() => !observer.isOnline());
    broker = await startTestBroker(dirs.runtimeDir, { stateDir: dirs.stateDir });
    await waitFor(() => failures > 0 && observer.isOnline());
    throwReady = false;
  };
  return { sent, hooks, ctx, observer, fire, fail, events, reset: () => command("reset", ctx), paints: () => paints, alias: () => alias };
}

test("public reset restores HUD and aborted-batch recovery after terminal callback failure", async (t) => {
  const f = await setup(t);
  await f.fail();
  const paints = f.paints();
  await f.reset();
  assert.ok(f.paints() > paints, "reset reattaches its valid UI context");
  const before = f.sent.length;
  assert.equal((await f.observer.send({ to: f.alias(), message: "post-reset batch" })).status, "delivered");
  await waitFor(() => f.sent.slice(before).some((entry) => entry.message.customType === "mesh-inbound"));
  await f.fire("turn_end", { message: { stopReason: "aborted" } });
  await waitFor(() => f.sent.slice(before).some((entry) => entry.options?.deliverAs === "nextTurn"), 1500);
});

test("old provider and turn hooks cannot rearm holds against the reset attachment", async (t) => {
  const f = await setup(t);
  const oldProvider = [...f.hooks.get("after_provider_response")!];
  const oldTurns = [...f.hooks.get("turn_end")!];
  await f.fail();
  // Late events after terminal failure must be inert, as must the same old
  // callbacks after a fresh client has been attached to the shared runtime.
  for (const hook of oldProvider) await hook({ status: 429 }, f.ctx);
  await f.reset();
  for (const hook of oldProvider) await hook({ status: 429 }, f.ctx);
  for (const hook of oldTurns) await hook({ message: { stopReason: "error", errorMessage: "429 rate limit" } }, f.ctx);
  const before = f.sent.length;
  assert.equal((await f.observer.send({ to: f.alias(), message: "not held by old provider" })).status, "delivered");
  await waitFor(() => f.sent.slice(before).some((entry) => entry.message.content.includes("not held by old provider")), 1500);
  await sleep(100);
});

test("real in-flight local control is cancelled by public reset, not acked by the fresh client", async (t) => {
  const f = await setup(t);
  let requestId: string | undefined;
  f.events.on("mesh-ctl", (request: { ctlId: string }) => { requestId = request.ctlId; });
  const response = f.observer.control({ to: f.alias(), action: "job_stop", target: "job-1", timeoutMs: 500 });
  await waitFor(() => requestId !== undefined);
  const channel = `mesh-ctl:reply:${requestId}`;
  assert.equal(f.events.listenerCount(channel), 1);
  await f.reset();
  assert.equal(f.events.listenerCount(channel), 0);
  f.events.emit(channel, { status: "stopped" });
  assert.notEqual((await response).status, "stopped", "a disposed request must not claim success via a replacement");
});
