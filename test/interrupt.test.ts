// test/interrupt.test.ts — the `interrupt` feature (plan INTERRUPT-PLAN):
// protocol guard, client guard + frame, broker downgrade STRIP (D6),
// receipt never settling a mission, and the extension repeater path (D2)
// with honest outcomes (aborted / already_idle / still_busy /
// abort_unavailable).
import test from "node:test";
import assert from "node:assert/strict";
import { buildFrame, parseFrameLine } from "../src/protocol/envelope.js";
import { sha256 } from "../src/protocol/frames.js";
import { MeshClient } from "../src/client/client.js";
import { injectInbound, type InjectOpts, type InterruptReport } from "../src/extension/inbound.js";
import type { MeshFrame } from "../src/protocol/envelope.js";
import type { ExtensionAPI, SessionContext } from "../src/extension/pi-types.js";
import { makeTempDirs, startTestBroker, sleep } from "./helpers.js";

// ---- protocol ----

test("protocol: interrupt requires priority=force; receipt tolerated", () => {
  const bad = parseFrameLine(
    JSON.stringify(buildFrame({ type: "msg", from: "aa", to: "bb", room: "rr", body: "x", interrupt: true, priority: "urgent" })),
  );
  assert.ok(!bad.ok);
  if (bad.ok) return;
  assert.equal(bad.code, "invalid_frame");

  const good = parseFrameLine(
    JSON.stringify(
      buildFrame({ type: "msg", from: "aa", to: "bb", room: "rr", body: "x", interrupt: true, priority: "force", reasonHash: sha256("why") }),
    ),
  );
  assert.ok(good.ok);
  if (good.ok) assert.equal(good.frame.interrupt, true);

  const receipt = parseFrameLine(JSON.stringify(buildFrame({ type: "reply", from: "bb", to: "aa", room: "rr", replyTo: "m_x", body: "receipt", receipt: true })));
  assert.ok(receipt.ok);
  if (receipt.ok) assert.equal(receipt.frame.receipt, true);
});

// ---- client guards + wire ----

test("client: interrupt without force+reason is refused; with them it rides the frame", async () => {
  const dirs = makeTempDirs("itr-client-");
  const broker = await startTestBroker(dirs.runtimeDir, { policy: { forceAllowedFrom: ["sender"] } });
  const recipient = new MeshClient({ alias: "recip", runtimeDir: dirs.runtimeDir });
  await recipient.connect();
  const seen: MeshFrame[] = [];
  recipient.on("frame", (f: MeshFrame) => {
    if (f.type === "msg") seen.push(f);
  });
  try {
    const sender = new MeshClient({ alias: "sender", runtimeDir: dirs.runtimeDir });
    await sender.connect();

    const noForce = await sender.send({ to: "recip", message: "hi", interrupt: true });
    assert.equal(noForce.status, "error");
    if (noForce.status === "error") assert.match(noForce.reason, /interrupt_requires_force_reason/);

    const forceNoReason = await sender.send({ to: "recip", message: "hi", interrupt: true, priority: "force" });
    assert.equal(forceNoReason.status, "error");

    const ok = await sender.send({ to: "recip", message: "unblock now", interrupt: true, priority: "force", reason: "stuck 20 min" });
    assert.equal(ok.status, "delivered");
    await sleep(300);
    const frame = seen.find((f) => f.body === "unblock now");
    assert.ok(frame !== undefined, "interrupt frame not delivered");
    assert.equal(frame.interrupt, true);
    assert.equal(frame.priority, "force");
    await sender.close();
  } finally {
    await recipient.close();
    await broker.close();
    dirs.cleanup();
  }
});

test("client: a receipt reply never settles a pending mission (meta, not the answer)", async () => {
  const dirs = makeTempDirs("itr-receipt-");
  const broker = await startTestBroker(dirs.runtimeDir);
  const recipient = new MeshClient({ alias: "recip", runtimeDir: dirs.runtimeDir });
  await recipient.connect();
  recipient.on("inbound", (f: MeshFrame) => {
    if (f.type === "msg" && f.id !== undefined) {
      // answer with a RECEIPT first, then the real answer
      void recipient.reply(f.id, "⚠ m_x interrupted: turn aborted, message delivered", { receipt: true }).then(() =>
        recipient.reply(f.id, "the real answer"),
      );
    }
  });
  try {
    const sender = new MeshClient({ alias: "sender", runtimeDir: dirs.runtimeDir });
    await sender.connect();
    const res = await sender.send({ to: "recip", message: "work", awaitReply: true, timeoutMs: 5000 });
    assert.equal(res.status, "reply");
    if (res.status === "reply") assert.equal(res.response, "the real answer"); // NOT the receipt
    await sender.close();
  } finally {
    await recipient.close();
    await broker.close();
    dirs.cleanup();
  }
});

// ---- broker D6: downgrade strips interrupt ----

test("broker D6: forceDowngrade strips the interrupt flag from the routed frame", async () => {
  const dirs = makeTempDirs("itr-d6-");
  const broker = await startTestBroker(dirs.runtimeDir, { policy: { forceDowngrade: true } });
  const recipient = new MeshClient({ alias: "recip", runtimeDir: dirs.runtimeDir });
  await recipient.connect();
  const seen: MeshFrame[] = [];
  recipient.on("frame", (f: MeshFrame) => {
    if (f.type === "msg") seen.push(f);
  });
  try {
    const sender = new MeshClient({ alias: "sender", runtimeDir: dirs.runtimeDir });
    await sender.connect();
    const res = await sender.send({ to: "recip", message: "down", interrupt: true, priority: "force", reason: "r" });
    assert.equal(res.status, "delivered");
    await sleep(300);
    const frame = seen.find((f) => f.body === "down");
    assert.ok(frame !== undefined);
    assert.equal(frame.priority, "urgent"); // downgraded
    assert.notEqual(frame.interrupt, true); // D6: flag STRIPPED
    await sender.close();
  } finally {
    await recipient.close();
    await broker.close();
    dirs.cleanup();
  }
});

// ---- extension repeater (D2) with a mock host ----

interface MockHost {
  pi: Pick<ExtensionAPI, "sendMessage">;
  ctx: SessionContext;
  sent: { message: { content: string }; opts: { triggerTurn?: boolean; deliverAs?: string } }[];
  aborts: number;
  idle: boolean;
  abortSettles: boolean; // when true, each abort flips idle
}

function mockHost(opts: { idle: boolean; abortSettles?: boolean; hasAbort?: boolean }): MockHost {
  const host: MockHost = {
    sent: [],
    aborts: 0,
    idle: opts.idle,
    abortSettles: opts.abortSettles ?? false,
    pi: {
      sendMessage: (message, sendOpts) => {
        host.sent.push({
          message: message as { content: string },
          opts: (sendOpts ?? {}) as { triggerTurn?: boolean; deliverAs?: string },
        });
      },
    },
    ctx: {
      cwd: "/tmp",
      ui: { notify: () => {} },
      isIdle: () => host.idle,
      ...(opts.hasAbort === false
        ? {}
        : {
            abort: () => {
              host.aborts += 1;
              if (host.abortSettles) host.idle = true;
            },
          }),
    } as unknown as SessionContext,
  };
  return host;
}

function interruptFrame(): MeshFrame {
  return buildFrame({
    type: "msg",
    from: "sender",
    to: "recip",
    room: "default",
    body: "unblock",
    priority: "force",
    reasonHash: sha256("stuck"),
    interrupt: true,
  });
}

const fastTimings: NonNullable<InjectOpts["interruptTimings"]> = { pollMs: 10, maxMs: 400, reabortAfterMs: 40, reabortMax: 2 };

test("extension D2: busy → abort settles → delivered steer, report aborted", async () => {
  const host = mockHost({ idle: false, abortSettles: true });
  let report: InterruptReport | undefined;
  injectInbound(host.pi, host.ctx, interruptFrame(), {
    interruptTimings: fastTimings,
    onInterruptReport: (r) => {
      report = r;
    },
  });
  await sleep(300);
  assert.equal(host.aborts, 1);
  assert.equal(host.sent.length, 1);
  assert.equal(host.sent[0]?.opts.triggerTurn, true);
  assert.equal(host.sent[0]?.opts.deliverAs, "steer");
  assert.equal(report?.outcome, "aborted");
  assert.equal(report?.aborts, 1);
});

test("extension D2: already idle → no abort, delivered, report already_idle", async () => {
  const host = mockHost({ idle: true });
  let report: InterruptReport | undefined;
  injectInbound(host.pi, host.ctx, interruptFrame(), {
    interruptTimings: fastTimings,
    onInterruptReport: (r) => {
      report = r;
    },
  });
  await sleep(100);
  assert.equal(host.aborts, 0);
  assert.equal(host.sent.length, 1);
  assert.equal(report?.outcome, "already_idle");
});

test("extension D2: swallowed first abort → re-abort settles (bounded retries)", async () => {
  // first abort does nothing; the SECOND one settles
  const host = mockHost({ idle: false });
  let report: InterruptReport | undefined;
  const ctx = host.ctx as unknown as { abort(): void; isIdle(): boolean };
  const realAbort = ctx.abort.bind(ctx);
  let calls = 0;
  ctx.abort = () => {
    calls += 1;
    if (calls >= 2) host.idle = true;
    realAbort();
  };
  injectInbound(host.pi, host.ctx, interruptFrame(), {
    interruptTimings: fastTimings,
    onInterruptReport: (r) => {
      report = r;
    },
  });
  await sleep(400);
  assert.equal(calls, 2); // first + one re-abort
  assert.equal(report?.outcome, "aborted");
  assert.equal(report?.aborts, 2);
});

test("extension D2: never settles → still_busy at the deadline (message still delivered)", async () => {
  const host = mockHost({ idle: false }); // aborts never settle
  let report: InterruptReport | undefined;
  injectInbound(host.pi, host.ctx, interruptFrame(), {
    interruptTimings: fastTimings,
    onInterruptReport: (r) => {
      report = r;
    },
  });
  await sleep(700);
  assert.equal(report?.outcome, "still_busy");
  assert.ok((report?.aborts ?? 0) >= 2); // retried up to the bound
  assert.equal(host.sent.length, 1); // delivered anyway (queued steer)
});

test("extension D2: no abort surface → abort_unavailable, message queued as steer", async () => {
  const host = mockHost({ idle: false, hasAbort: false });
  let report: InterruptReport | undefined;
  injectInbound(host.pi, host.ctx, interruptFrame(), {
    onInterruptReport: (r) => {
      report = r;
    },
  });
  await sleep(100);
  assert.equal(report?.outcome, "abort_unavailable");
  assert.equal(host.sent.length, 1);
});

test("extension: a receipt reply renders followUp WITHOUT a triggered turn", async () => {
  const host = mockHost({ idle: true });
  const receipt = buildFrame({ type: "reply", from: "recip", to: "sender", room: "default", replyTo: "m_x", body: "⚠ interrupted", receipt: true });
  injectInbound(host.pi, host.ctx, receipt, {});
  await sleep(50);
  assert.equal(host.sent.length, 1);
  assert.equal(host.sent[0]?.opts.triggerTurn, false);
  assert.equal(host.sent[0]?.opts.deliverAs, "followUp");
});
