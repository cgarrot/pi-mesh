// test/ctl-extension.test.ts — the TARGET-side ctl handler, without a broker.
// Verifies the honest ack vocabulary and the atomic redirect contract.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildFrame, type MeshFrame } from "../src/protocol/envelope.js";
import { sha256 } from "../src/protocol/frames.js";
import { handleCtlFrame } from "../src/extension/ctl.js";
import type { MeshRuntime } from "../src/extension/tools.js";

type Handler = (data: unknown) => void;

interface Harness {
  rt: MeshRuntime;
  pi: { sendMessage: (msg: unknown, opts?: unknown) => void; events?: { emit: (e: string, d: unknown) => void; on?: (e: string, h: Handler) => void } };
  acks: Array<Record<string, unknown>>;
  messages: Array<{ msg: unknown; opts: unknown }>;
  ledger: Array<Record<string, unknown>>;
  setIdle: (v: boolean) => void;
  aborted: () => boolean;
  handlers: Map<string, Handler[]>;
}

function harness(opts: { busy?: boolean; withAbort?: boolean; withBus?: boolean; failSend?: boolean; ctlAllowFrom?: string[] } = {}): Harness {
  const acks: Array<Record<string, unknown>> = [];
  const messages: Array<{ msg: unknown; opts: unknown }> = [];
  const ledger: Array<Record<string, unknown>> = [];
  const handlers = new Map<string, Handler[]>();
  let idle = !(opts.busy ?? false);
  let aborted = false;
  const events = (opts.withBus ?? true)
    ? {
        emit: (channel: string, data: unknown): void => {
          for (const handler of handlers.get(channel) ?? []) handler(data);
        },
        on: (channel: string, handler: Handler): void => {
          const list = handlers.get(channel) ?? [];
          list.push(handler);
          handlers.set(channel, list);
        },
      }
    : undefined;
  const ctx = (opts.withAbort ?? true)
    ? {
        abort: (): void => {
          aborted = true;
        },
        isIdle: (): boolean => idle,
      }
    : {};
  const rt = {
    client: { alias: "bob", sendCtlAck: (ack: Record<string, unknown>) => acks.push(ack) },
    ctx,
    ledger: { append: (entry: Record<string, unknown>) => ledger.push(entry) },
    ledgerFailures: 0,
    ctlAllowFrom: opts.ctlAllowFrom ?? [],
  } as unknown as MeshRuntime;
  return {
    rt,
    pi: {
      sendMessage: (msg, o) => {
        if (opts.failSend === true) throw new Error("host refused the injection");
        messages.push({ msg, opts: o });
      },
      ...(events !== undefined ? { events } : {}),
    },
    acks,
    messages,
    ledger,
    setIdle: (v) => {
      idle = v;
    },
    aborted: () => aborted,
    handlers,
  };
}

function ctl(opts: { action?: string; id?: string; target?: string; body?: string } = {}): MeshFrame {
  return buildFrame({
    type: "ctl",
    id: opts.id ?? "m_ctl_1",
    from: "alice",
    to: "bob",
    room: "default",
    action: opts.action ?? "abort",
    ...(opts.target !== undefined ? { target: opts.target } : {}),
    ...(opts.body !== undefined ? { body: opts.body } : {}),
    reasonHash: sha256("because"),
  });
}

describe("ctl handler: abort / redirect", () => {
  it("an idle target says not_busy (nothing was aborted)", async () => {
    const h = harness();
    await handleCtlFrame(h.rt, ctl(), h.pi);
    assert.equal(h.acks.length, 1);
    assert.equal(h.acks[0]!.status, "not_busy");
    assert.equal(h.acks[0]!.settled, true);
    assert.equal(h.aborted(), false);
  });

  it("a busy target aborts and acks settled only after isIdle", async () => {
    const h = harness({ busy: true });
    const run = handleCtlFrame(h.rt, ctl(), h.pi, { settleTimeoutMs: 500 });
    setTimeout(() => h.setIdle(true), 60);
    await run;
    assert.equal(h.aborted(), true);
    assert.equal(h.acks[0]!.status, "aborted");
    assert.equal(h.acks[0]!.settled, true);
  });

  it("redirect aborts, settles, THEN injects the instruction", async () => {
    const h = harness({ busy: true });
    const run = handleCtlFrame(h.rt, ctl({ action: "redirect", body: "use the cache dir" }), h.pi, { settleTimeoutMs: 500 });
    setTimeout(() => h.setIdle(true), 60);
    await run;
    assert.equal(h.acks[0]!.status, "redirected");
    assert.equal(h.acks[0]!.settled, true);
    assert.equal(h.messages.length, 1);
    const sent = h.messages[0]!.msg as { content: string; details: Record<string, unknown> };
    assert.match(sent.content, /use the cache dir/);
    assert.equal(sent.details.kind, "ctl", "details stay hash-only metadata");
  });

  it("records a hash-only ctl ledger entry (never the instruction)", async () => {
    const h = harness();
    await handleCtlFrame(h.rt, ctl({ action: "redirect", body: "the secret instruction" }), h.pi);
    assert.equal(h.ledger.length, 1);
    const entry = h.ledger[0]!;
    assert.equal(entry.event, "ctl");
    assert.equal(entry.action, "redirect");
    assert.equal(entry.code, "redirected");
    assert.equal(entry.bodyHash, sha256("the secret instruction"));
    assert.equal(Object.prototype.hasOwnProperty.call(entry, "body"), false);
  });

  it("a host that refuses the injection is an error, never redirected", async () => {
    const h = harness({ busy: true, failSend: true });
    const run = handleCtlFrame(h.rt, ctl({ action: "redirect", body: "nope" }), h.pi, { settleTimeoutMs: 500 });
    setTimeout(() => h.setIdle(true), 60);
    await run;
    assert.equal(h.acks[0]!.status, "error");
    assert.equal(h.messages.length, 0);
  });

  it("a turn that never settles is still_busy and the instruction is NOT injected", async () => {
    const h = harness({ busy: true });
    await handleCtlFrame(h.rt, ctl({ action: "redirect", body: "nope" }), h.pi, { settleTimeoutMs: 120 });
    assert.equal(h.acks[0]!.status, "still_busy");
    assert.equal(h.acks[0]!.settled, false);
    assert.equal(h.messages.length, 0, "atomic redirect: no injection behind a live turn");
  });

  it("a host without an abort surface says abort_unavailable", async () => {
    const h = harness({ busy: true, withAbort: false });
    await handleCtlFrame(h.rt, ctl(), h.pi);
    assert.equal(h.acks[0]!.status, "abort_unavailable");
  });
});

describe("ctl handler: local dispatch (job_*/run_*)", () => {
  it("forwards job_stop to the event bus and relays the handler's status", async () => {
    const h = harness();
    h.handlers.set("mesh-ctl", [
      (data) => {
        const req = data as { ctlId: string; action: string; target?: string };
        assert.equal(req.action, "job_stop");
        assert.equal(req.target, "j_1");
        // The pi-jobd extension answers on the ctlId-scoped channel.
        const reply = (h.handlers.get(`mesh-ctl:reply:${req.ctlId}`) ?? [])[0];
        assert.ok(reply);
        reply({ status: "stopped", settled: true });
      },
    ]);
    await handleCtlFrame(h.rt, ctl({ action: "job_stop", target: "j_1" }), h.pi);
    assert.equal(h.acks[0]!.status, "stopped");
    assert.equal(h.acks[0]!.settled, true);
  });

  it("no event bus → unsupported (never a false success)", async () => {
    const h = harness({ withBus: false });
    await handleCtlFrame(h.rt, ctl({ action: "run_stop", target: "r_1" }), h.pi);
    assert.equal(h.acks[0]!.status, "unsupported");
  });

  it("run_steer is default-deny: no ctl.allowFrom means not_authorized", async () => {
    const h = harness();
    await handleCtlFrame(h.rt, ctl({ action: "run_steer", target: "rpc_1", body: "do the thing" }), h.pi);
    assert.equal(h.acks[0]!.status, "not_authorized");
    assert.equal(h.acks[0]!.reason, "ctl.allowFrom");
  });

  it("run_steer from an allowlisted peer reaches the local handler", async () => {
    const h = harness({ ctlAllowFrom: ["alice"] });
    h.handlers.set("mesh-ctl", [
      (data) => {
        const req = data as { ctlId: string };
        const reply = (h.handlers.get(`mesh-ctl:reply:${req.ctlId}`) ?? [])[0];
        assert.ok(reply);
        reply({ status: "steered" });
      },
    ]);
    await handleCtlFrame(h.rt, ctl({ action: "run_steer", target: "rpc_1", body: "do the thing" }), h.pi);
    assert.equal(h.acks[0]!.status, "steered");
  });

  it("stop-class is not gated by the allowlist (job_stop still works)", async () => {
    const h = harness({ ctlAllowFrom: [] });
    h.handlers.set("mesh-ctl", [
      (data) => {
        const req = data as { ctlId: string };
        const reply = (h.handlers.get(`mesh-ctl:reply:${req.ctlId}`) ?? [])[0];
        assert.ok(reply);
        reply({ status: "stopped" });
      },
    ]);
    await handleCtlFrame(h.rt, ctl({ action: "job_stop", target: "j_1" }), h.pi);
    assert.equal(h.acks[0]!.status, "stopped");
  });

  it("an out-of-vocabulary local status is clamped to error (never a rejected ack)", async () => {
    const h = harness();
    h.handlers.set("mesh-ctl", [
      (data) => {
        const req = data as { ctlId: string };
        const reply = (h.handlers.get(`mesh-ctl:reply:${req.ctlId}`) ?? [])[0];
        assert.ok(reply);
        reply({ status: "totally_bogus" });
      },
    ]);
    await handleCtlFrame(h.rt, ctl({ action: "job_stop", target: "j_1" }), h.pi, { localTimeoutMs: 1_000 });
    assert.equal(h.acks[0]!.status, "error");
  });

  it("a silent local handler times out (timeout, not a false unsupported)", async () => {
    const h = harness();
    // No "mesh-ctl" handler registered.
    await handleCtlFrame(h.rt, ctl({ action: "job_pause", target: "j_1" }), h.pi, { localTimeoutMs: 80 });
    assert.equal(h.acks[0]!.status, "timeout");
  });
});
