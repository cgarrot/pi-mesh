import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { MeshCallbackError, MeshClient } from "../src/client/client.js";
import { attachClientListeners } from "../src/extension/attach.js";
import { MeshHud } from "../src/extension/hud.js";
import { InjectionGuard } from "../src/extension/injection-guard.js";
import type { SessionContext, SessionHookHandler } from "../src/extension/pi-types.js";
import type { MeshRuntime } from "../src/extension/tools.js";
import { buildFrame } from "../src/protocol/envelope.js";
import { makeTempDirs, sleep, startTestBroker, waitFor } from "./helpers.js";

async function setup(t: TestContext) {
  const dirs = makeTempDirs("adapter-callback-");
  const broker = await startTestBroker(dirs.runtimeDir, { stateDir: dirs.stateDir });
  const client = new MeshClient({
    alias: "subject", runtimeDir: dirs.runtimeDir,
    config: { brokerUrl: `unix://${broker.socketPath}`, debug: false, inboundBatchMs: 30, inboundBatchMaxHoldMs: 100, inboundBroadcasts: "deferred" },
  });
  const calls: string[] = [];
  let stale = false;
  let busyChecks = 0;
  const touch = (name: string) => {
    calls.push(name);
    if (stale) throw new Error("simulated stale Pi context");
  };
  const ctx: SessionContext = {
    cwd: dirs.root, mode: "tui",
    isIdle: () => { busyChecks += 1; touch("isIdle"); return false; },
    ui: {
      notify: () => touch("notify"),
      setWidget: () => touch("setWidget"),
      setStatus: () => touch("setStatus"),
    },
  };
  const hooks = new Map<string, SessionHookHandler>();
  const pi = {
    on: (event: string, hook: SessionHookHandler) => { hooks.set(event, hook); },
    sendMessage: () => touch("sendMessage"),
    appendEntry: () => touch("appendEntry"),
  };
  const rt = {
    client, ctx,
    ledger: { append: () => {} }, transcript: { record: () => {}, isEnabled: () => false },
    injectionGuard: new InjectionGuard(),
    ledgerFailures: 0, transcriptFailures: 0, injectionFailures: 0,
  } as unknown as MeshRuntime;
  const hud = new MeshHud({ getRuntime: () => rt });
  hud.attach(ctx);
  attachClientListeners(pi as never, rt, () => hud, ctx, client, () => {});
  const reads: string[] = [];
  client.sendRead = (id: string) => { reads.push(id); };
  t.after(async () => {
    stale = false;
    rt.markDetached?.();
    rt.stopHold?.();
    rt.stopReclaim?.();
    for (const timer of rt.reserveTimers?.values() ?? []) clearTimeout(timer);
    rt.batcher?.flushNow();
    hud.detach();
    await client.close();
    await broker.close();
    dirs.cleanup();
  });
  await client.connect();
  const frame = buildFrame({ type: "msg", from: "sender", to: "subject", room: "default", body: "work" });
  return { client, rt, hud, hooks, ctx, calls, reads, frame, poison: () => { stale = true; }, busyChecks: () => busyChecks };
}

test("terminal ready failure discards queued adapter work without stale Pi calls or read receipts", async (t) => {
  const f = await setup(t);
  const checks = f.busyChecks();
  f.client.emit("inbound", f.frame);
  // Let the short batching window arm its max-hold timer while busy.
  const afterInbound = f.busyChecks();
  assert.ok(afterInbound > checks);
  await waitFor(() => f.busyChecks() > afterInbound);
  f.client.emit("inbound", { ...f.frame, id: "deferred", broadcast: true, body: "for someone else" });
  f.rt.deferredInbox!.queueForPrompt();
  f.rt.deferredInbox!.promptStarting();
  assert.equal(f.rt.deferredInbox!.count, 1);
  f.rt.rateLimitedUntil = Date.now() + 10_000;
  f.client.emit("inbound", { ...f.frame, id: "held" });
  f.rt.injectionGuard!.note([f.frame], "followUp", true);
  let stoppedHold = 0;
  let stoppedReclaim = 0;
  f.rt.stopHold = () => { stoppedHold += 1; };
  f.rt.stopReclaim = () => { stoppedReclaim += 1; };
  f.rt.resendBatch = () => { f.calls.push("resendBatch"); };
  f.rt.onCompactionDetected = () => { f.calls.push("compaction"); };
  const reserveTimer = setTimeout(() => f.calls.push("reservation-timer"), 150);
  f.rt.reserveTimers = new Map([["some-path", reserveTimer]]);
  f.hud.scheduleStatusRefresh();
  let externalPresence = 0;
  f.client.on("presence", () => { externalPresence += 1; });
  f.poison();
  // Real handshake + attached ready callback: HUD touches the poisoned ctx.
  assert.deepEqual(await f.client.rename("renamed"), { ok: false, reason: "callback_failed" });
  const afterFailure = [...f.calls];
  assert.equal(f.rt.deferredInbox!.count, 0);
  assert.equal(f.rt.injectionGuard!.pending, false);
  assert.equal(stoppedHold, 1);
  assert.equal(stoppedReclaim, 1);
  assert.equal(f.rt.reserveTimers.size, 0);
  assert.equal(f.client.listenerCount("ready"), 0, "remove only this adapter's client callbacks");
  f.rt.flushHeld?.();
  f.rt.batcher?.flushNow();
  f.rt.resendBatch?.([f.frame], "followUp", 1);
  f.rt.onCompactionDetected?.();
  for (const event of ["input", "before_agent_start", "agent_start"]) await f.hooks.get(event)!({}, f.ctx);
  f.client.emit("inbound", f.frame);
  f.client.emit("presence", f.frame);
  f.client.emit("expired", { msgId: f.frame.id });
  f.client.emit("closed");
  f.client.emit("callback_error", new MeshCallbackError(new Error("duplicate")));
  await sleep(200); // prove canceled batch/max-hold/reservation timers do not run
  f.hud.refresh(); // a queued/in-flight status completion must no longer use ctx
  assert.deepEqual(f.calls, afterFailure);
  assert.deepEqual(f.reads, []);
  assert.equal(externalPresence, 1, "external event observers are preserved");
  assert.equal(stoppedHold, 1, "terminal cleanup is idempotent");
});

test("normal adapter batching still injects and acknowledges read on explicit flush", async (t) => {
  const f = await setup(t);
  f.client.emit("inbound", f.frame);
  assert.deepEqual(f.reads, []);
  f.rt.batcher!.flushNow();
  assert.deepEqual(f.reads, [f.frame.id]);
  assert.ok(f.calls.includes("sendMessage"));
});

test("one failed adapter cleanup hook cannot leave other teardown work active", async (t) => {
  const f = await setup(t);
  let holdCalls = 0;
  let reclaimCalls = 0;
  f.rt.stopHold = () => {
    if (++holdCalls === 1) throw new Error("failed hold cleanup");
  };
  f.rt.stopReclaim = () => { reclaimCalls += 1; };
  f.poison();
  assert.deepEqual(await f.client.rename("renamed"), { ok: false, reason: "callback_failed" });
  const calls = [...f.calls];
  assert.equal(holdCalls, 1);
  assert.equal(reclaimCalls, 1);
  f.hud.refresh();
  f.client.emit("inbound", f.frame);
  assert.deepEqual(f.calls, calls);
  assert.deepEqual(f.reads, []);
});

test("late failure of a replaced client does not tear down the replacement runtime", async (t) => {
  const f = await setup(t);
  const replacement = new MeshClient({ alias: "replacement" }); // never connected
  t.after(() => replacement.close());
  f.rt.markDetached?.();
  f.rt.client = replacement;
  f.rt.injectionGuard = new InjectionGuard();
  f.rt.injectionGuard.note([f.frame], "followUp", true);
  let stops = 0;
  f.rt.stopHold = () => { stops += 1; };
  f.rt.stopReclaim = () => { stops += 1; };
  const resend = () => {};
  f.rt.resendBatch = resend;
  f.client.emit("callback_error", new MeshCallbackError(new Error("late old callback")));
  assert.equal(f.rt.injectionGuard.pending, true);
  assert.equal(f.rt.resendBatch, resend);
  assert.equal(stops, 0);
});
