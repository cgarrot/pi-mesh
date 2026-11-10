import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { MeshCallbackError, MeshClient } from "../src/client/client.js";
import { makeTempDirs, sleep, startTestBroker, waitFor } from "./helpers.js";

async function setup(t: TestContext) {
  const dirs = makeTempDirs("callback-failure-");
  let broker = await startTestBroker(dirs.runtimeDir, { stateDir: dirs.stateDir });
  const config = { brokerUrl: `unix://${broker.socketPath}`, debug: false };
  const clients: MeshClient[] = [];
  const client = (alias: string): MeshClient => {
    const c = new MeshClient({ alias, runtimeDir: dirs.runtimeDir, config });
    clients.push(c);
    return c;
  };
  t.after(async () => {
    await Promise.all(clients.map((c) => c.close()));
    await broker.close();
    dirs.cleanup();
  });
  const observer = client("observer");
  await observer.connect();
  return {
    client, observer,
    async restart() {
      await broker.close();
      await waitFor(() => clients.every((c) => !c.isOnline()));
      broker = await startTestBroker(dirs.runtimeDir, { stateDir: dirs.stateDir });
      return broker;
    },
  };
}

async function expectRoster(observer: MeshClient, expected: string[]): Promise<void> {
  let aliases: string[] = [];
  let error: unknown;
  let sampling = false;
  const sample = setInterval(() => {
    if (sampling) return;
    sampling = true;
    void observer.status().then((status) => {
      aliases = status.peers.map((p) => p.alias).sort();
    }, (err: unknown) => { error = err; }).finally(() => { sampling = false; });
  }, 20);
  try {
    await waitFor(() => error !== undefined || JSON.stringify(aliases) === JSON.stringify([...expected].sort()));
    if (error !== undefined) throw error;
  } finally {
    clearInterval(sample);
  }
}

test("throwing ready closes the accepted socket before reporting failure", async (t) => {
  const { client, observer } = await setup(t);
  const subject = client("subject");
  const cause = new Error("simulated callback failure: alias_taken");
  const reported: MeshCallbackError[] = [];
  subject.on("ready", () => { throw cause; });
  subject.on("callback_error", (error: MeshCallbackError) => {
    assert.equal(subject.isOnline(), false);
    reported.push(error);
  });
  const connect = subject.connect();
  assert.equal(subject.connect(), connect, "concurrent callers share the failing handshake");
  await assert.rejects(connect, (error: unknown) => {
    assert.ok(error instanceof MeshCallbackError);
    assert.equal(error.code, "callback_failed");
    assert.equal(error.cause, cause);
    assert.equal(error, reported[0]);
    return true;
  });
  // Public roster, not private socket fields: the broker must release the alias.
  await expectRoster(observer, ["observer"]);
  await assert.rejects(subject.connect(), (error: unknown) => error === reported[0]);
  await subject.close();
  await assert.rejects(subject.connect(), MeshCallbackError);
  assert.deepEqual(await subject.rename("new-name"), { ok: false, reason: "callback_failed" });
  assert.equal(reported.length, 1);
});

test("automatic reconnect callback failure stops churn beyond 12 seconds; healthy reconnect survives", async (t) => {
  const fixture = await setup(t);
  const subject = fixture.client("subject");
  const healthy = fixture.client("healthy");
  let subjectReady = 0;
  let healthyReady = 0;
  let fallbacks = 0;
  const failures: MeshCallbackError[] = [];
  subject.on("ready", () => {
    if (++subjectReady > 1) throw new Error("simulated stale callback");
  });
  subject.on("callback_error", (error: MeshCallbackError) => failures.push(error));
  subject.on("alias_fallback", () => { fallbacks += 1; });
  healthy.on("ready", () => { healthyReady += 1; });
  await subject.connect();
  await healthy.connect();
  // Real transport outage, without inspecting or modifying MeshClient internals.
  const broker = await fixture.restart();
  let accepted = 0;
  broker.server.on("connection", () => { accepted += 1; });
  await waitFor(() => failures.length === 1 && healthyReady === 2 && fixture.observer.isOnline());
  await expectRoster(fixture.observer, ["observer", "healthy"]);
  const acceptedAfterFailure = accepted;
  // Observation window, not a readiness sleep: old behavior churned every ~12s.
  await sleep(12_500);
  await expectRoster(fixture.observer, ["observer", "healthy"]);
  assert.equal(accepted, acceptedAfterFailure, "no hidden handshake retries or sockets");
  assert.equal(subjectReady, 2);
  assert.equal(fallbacks, 0);
  assert.equal(subject.alias, "subject");
  assert.equal(subject.isOnline(), false);
  assert.equal(healthy.alias, "healthy");
  assert.equal(healthy.isOnline(), true);
});

test("ready failure under alias fallback preserves typed cause instead of original alias_taken", async (t) => {
  const { client, observer } = await setup(t);
  const holder = client("taken");
  await holder.connect();
  const subject = client("taken");
  const cause = "alias_taken inside callback is not a transport error";
  let ready = 0;
  subject.on("ready", () => { ready += 1; throw cause; });
  await assert.rejects(subject.connect(), (error: unknown) => error instanceof MeshCallbackError && error.cause === cause);
  assert.notEqual(subject.alias, "taken", "actually exercised fallback handshake");
  await expectRoster(observer, ["observer", "taken"]);
  await assert.rejects(subject.connect(), MeshCallbackError);
  assert.equal(ready, 1);
});

test("ready failure during rename does not roll back and reconnect the previous alias", async (t) => {
  const { client, observer } = await setup(t);
  const subject = client("original");
  await subject.connect();
  let ready = 0;
  subject.on("ready", () => { ready += 1; throw new Error("alias_taken from callback"); });
  assert.deepEqual(await subject.rename("renamed"), { ok: false, reason: "callback_failed" });
  await expectRoster(observer, ["observer"]);
  assert.equal(subject.alias, "renamed");
  assert.equal(ready, 1);
  await assert.rejects(subject.connect(), MeshCallbackError);
});

test("throwing diagnostic listeners and a ready/close race cannot derail terminal cleanup", async (t) => {
  const { client, observer } = await setup(t);
  const subject = client("subject");
  const cause = { detail: "non-Error callback throw" };
  let closing: Promise<void> | undefined;
  let reconnecting: Promise<unknown> | undefined;
  let reports = 0;
  subject.on("ready", () => {
    closing = subject.close();
    throw cause;
  });
  subject.once("callback_error", () => { throw new Error("diagnostic failed"); });
  subject.on("callback_error", (error: MeshCallbackError) => {
    reports += 1;
    assert.equal(error.cause, cause);
    reconnecting = assert.rejects(subject.connect(), MeshCallbackError);
  });
  await assert.rejects(subject.connect(), MeshCallbackError);
  await closing;
  await reconnecting;
  await expectRoster(observer, ["observer"]);
  assert.equal(reports, 1, "later teardown listeners still execute");
  assert.equal(subject.listenerCount("callback_error"), 1, "once semantics preserved");
});

test("rename on an offline client reports callback failure from its initial connect", async (t) => {
  const { client, observer } = await setup(t);
  const subject = client("subject");
  subject.on("ready", () => { throw new Error("initial ready"); });
  assert.deepEqual(await subject.rename("renamed"), { ok: false, reason: "callback_failed" });
  await expectRoster(observer, ["observer"]);
});

test("ready failure during rename rollback is not hidden by the original alias conflict", async (t) => {
  const { client, observer } = await setup(t);
  const holder = client("taken");
  const subject = client("original");
  await holder.connect();
  await subject.connect();
  subject.on("ready", () => { throw new Error("rollback callback failed"); });
  assert.deepEqual(await subject.rename("taken"), { ok: false, reason: "callback_failed" });
  await expectRoster(observer, ["observer", "taken"]);
  await assert.rejects(subject.connect(), MeshCallbackError);
});

test("rejected async diagnostics are contained without delaying or replacing the ready error", async (t) => {
  const { client, observer } = await setup(t);
  const subject = client("subject");
  const cause = new Error("original ready failure");
  let laterReports = 0;
  subject.on("ready", () => { throw cause; });
  subject.on("callback_error", async () => { throw new Error("async diagnostic rejection"); });
  subject.on("callback_error", () => ({ then: () => { throw new Error("rejected thenable"); } }));
  subject.on("callback_error", () => new Promise(() => {})); // reporting must not be awaited
  subject.on("callback_error", () => { laterReports += 1; });
  await assert.rejects(subject.connect(), (error: unknown) => error instanceof MeshCallbackError && error.cause === cause);
  await expectRoster(observer, ["observer"]);
  await sleep(30); // node:test fails on any unhandled diagnostic rejection
  assert.equal(laterReports, 1);
});

test("terminal reconnect failure promptly cancels active waitAll and fails pending missions", async (t) => {
  const fixture = await setup(t);
  const subject = fixture.client("subject");
  const recipient = fixture.client("recipient");
  let received = 0;
  recipient.on("inbound", () => { received += 1; });
  await subject.connect();
  await recipient.connect();
  let sent: Awaited<ReturnType<MeshClient["send"]>> | undefined;
  void subject.send({ to: "recipient", message: "blocking mission", awaitReply: true, timeoutMs: 60_000 }).then((result) => { sent = result; });
  const launched = await subject.send({ to: "recipient", message: "launch mission", awaitReply: true, block: false, timeoutMs: 60_000 });
  assert.equal(launched.status, "delivered");
  await waitFor(() => received === 2);
  assert.equal(subject.pendingCount, 2);
  const abort = new AbortController();
  t.after(() => abort.abort()); // finite even against the broken implementation
  const summaries: Awaited<ReturnType<MeshClient["waitAll"]>>[] = [];
  for (let i = 0; i < 2; i += 1) {
    void subject.waitAll(60_000, abort.signal).then((summary) => summaries.push(summary));
  }
  let failed = false;
  subject.on("ready", () => { throw new Error("reconnect ready failure"); });
  subject.on("callback_error", () => { failed = true; });
  await fixture.restart();
  await waitFor(() => failed);
  await waitFor(() => summaries.length === 2 && sent !== undefined, 1500);
  for (const summary of summaries) {
    assert.equal(summary.status, "cancelled");
    assert.equal(summary.total, 2);
    assert.equal(summary.answered, 0);
    assert.equal(summary.missing.length, 2);
  }
  assert.equal(sent!.status, "error");
  assert.ok("reason" in sent! && sent.reason === "callback_failed");
  assert.equal(subject.pendingCount, 0);
  assert.deepEqual(subject.missionStatus().map((mission) => mission.status), ["failed", "failed"]);
  assert.equal((await subject.waitAll(60_000)).status, "cancelled", "later waits cannot hang on a terminal client");
});
