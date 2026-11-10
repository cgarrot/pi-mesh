import { EventEmitter } from "node:events";
import { handleCtlFrame } from "../src/extension/ctl.js";
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
  const broker = await startTestBroker(dirs.runtimeDir, { stateDir: dirs.stateDir, policy: { forceAllowedFrom: ["sender"] } });
  const client = new MeshClient({
    alias: "subject", runtimeDir: dirs.runtimeDir,
    config: { brokerUrl: `unix://${broker.socketPath}`, debug: false, inboundBatchMs: 30, inboundBatchMaxHoldMs: 100, inboundBroadcasts: "deferred" },
  });
  let sender: MeshClient | undefined;
  const sendForce = async (interrupt: boolean) => {
    sender = new MeshClient({ alias: "sender", runtimeDir: dirs.runtimeDir, config: { brokerUrl: `unix://${broker.socketPath}`, debug: false } });
    await sender.connect();
    return sender.send({ to: client.alias, message: "force work", priority: "force", reason: "test", interrupt });
  };
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
  const messages: { content: string }[] = [];
  const events = new EventEmitter();
  const pi = {
    events,
    on: (event: string, hook: SessionHookHandler) => { hooks.set(event, hook); },
    sendMessage: (message: { content: string }) => { touch("sendMessage"); messages.push(message); },
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
  let currentHud = hud;
  attachClientListeners(pi as never, rt, () => currentHud, ctx, client, () => {});
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
    await sender?.close();
    await broker.close();
    dirs.cleanup();
  });
  await client.connect();
  const frame = buildFrame({ type: "msg", from: "sender", to: "subject", room: "default", body: "work" });
  return { client, rt, hud, hooks, ctx, calls, reads, frame, pi, messages, sendForce, setHud: (next: MeshHud) => { currentHud = next; }, poison: () => { stale = true; }, busyChecks: () => busyChecks };
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
  const before = f.messages.length;
  f.rt.batcher!.flushNow();
  assert.deepEqual(f.reads, [f.frame.id]);
  assert.equal(f.messages.length, before + 1);
  assert.match(f.messages[before]!.content, /mesh batch/);
  assert.ok(f.messages[before]!.content.includes(f.frame.body!));
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

for (const interrupt of [false, true]) {
  test(`pending force delivery is cancelled on callback failure (interrupt=${interrupt})`, async (t) => {
    const f = await setup(t);
    let idle = false;
    f.ctx.isIdle = () => { f.calls.push("force-isIdle"); return idle; };
    f.ctx.abort = () => { f.calls.push("force-abort"); };
    assert.equal((await f.sendForce(interrupt)).status, "delivered");
    await waitFor(() => f.calls.includes("force-abort"));
    assert.deepEqual(f.reads, [], "pending delivery is not yet read");
    f.client.once("ready", () => { throw new Error("terminal ready"); });
    assert.deepEqual(await f.client.rename("renamed"), { ok: false, reason: "callback_failed" });
    const before = [...f.calls];
    const receipts = [...f.reads];
    await sleep(interrupt ? 1700 : 200); // includes the interrupt re-abort deadline
    idle = true;
    await sleep(100);
    assert.deepEqual(f.calls, before, "no poll, abort or injection after teardown");
    assert.deepEqual(f.reads, receipts);
  });
}

test("late failure suspends only the captured HUD, not a distinct runtime's live HUD", async (t) => {
  const f = await setup(t);
  const next = new MeshClient({ alias: "next" });
  t.after(() => next.close());
  const nextRt = { ...f.rt, client: next };
  let paints = 0;
  const nextHud = new MeshHud({ getRuntime: () => nextRt });
  nextHud.attach({ ...f.ctx, ui: { ...f.ctx.ui, setWidget: () => { paints += 1; }, setStatus: () => {} } });
  t.after(() => nextHud.detach());
  f.setHud(nextHud);
  f.client.emit("callback_error", new MeshCallbackError(new Error("old failure")));
  const before = paints;
  nextHud.refresh();
  assert.equal(paints, before + 1);
});

test("in-flight redirect stops before stale context polling or injection", async (t) => {
  const f = await setup(t);
  let idle = false;
  f.ctx.isIdle = () => { f.calls.push("ctl-isIdle"); return idle; };
  f.ctx.abort = () => { f.calls.push("ctl-abort"); };
  const pending = handleCtlFrame(f.rt, buildFrame({ type: "ctl", from: "sender", to: f.client.alias, action: "redirect", body: "redirect" }), f.pi, { settleTimeoutMs: 500 });
  assert.ok(f.calls.includes("ctl-abort"));
  f.client.emit("callback_error", new MeshCallbackError(new Error("terminal")));
  const before = [...f.calls];
  idle = true;
  await pending;
  assert.deepEqual(f.calls, before);
});

test("in-flight local control detaches its reply listener and never acks via replacement", async (t) => {
  const f = await setup(t);
  const frame = buildFrame({ type: "ctl", from: "sender", to: f.client.alias, action: "job_stop", target: "job-1" });
  const pending = handleCtlFrame(f.rt, frame, f.pi, { localTimeoutMs: 500 });
  const channel = `mesh-ctl:reply:${frame.id}`;
  assert.equal(f.pi.events.listenerCount(channel), 1);
  f.rt.markDetached!();
  const next = new MeshClient({ alias: "next" });
  t.after(() => next.close());
  let acknowledgements = 0;
  next.sendCtlAck = () => { acknowledgements += 1; };
  f.rt.client = next;
  f.pi.events.emit(channel, { status: "stopped" });
  await pending;
  assert.equal(acknowledgements, 0);
  assert.equal(f.pi.events.listenerCount(channel), 0);
});
