/**
 * extension/ctl.ts — handle an inbound `ctl` frame on the TARGET side.
 *
 * Two classes of action:
 *   - abort/redirect: act on the LOCAL turn (ctx.abort / steer). The ack is
 *     honest: aborted / not_busy / still_busy / abort_unavailable.
 *   - job_* and run_*: dispatch to a local extension over `pi.events` (pi-jobd,
 *     pi-subagents). pi-mesh never imports them: the channel is the contract.
 *
 * Never a claim beyond what was observed: `aborted` means the turn settled;
 * `redirected` means it settled AND the new instruction was injected.
 */
import { CTL_LOCAL_TIMEOUT_MS, CTL_SETTLE_TIMEOUT_MS } from "../shared/config.js";
import type { MeshFrame } from "../protocol/envelope.js";
import type { ExtensionAPI, SessionContext } from "./pi-types.js";
import type { MeshRuntime } from "./tools.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type CtlAckStatus =
  | "aborted"
  | "redirected"
  | "not_busy"
  | "still_busy"
  | "abort_unavailable"
  | "unsupported"
  | "error"
  | string;

interface LocalCtlReply {
  status?: string;
  reason?: string;
  settled?: boolean;
}

/** Inject the redirect instruction as a REAL user/steer message. Returns
 *  false when the host refused it: the ack must never claim an injection that
 *  did not happen. */
function injectRedirect(pi: Pick<ExtensionAPI, "sendMessage">, frame: MeshFrame): boolean {
  const body = frame.body ?? "";
  try {
    pi.sendMessage(
      {
        customType: "mesh-inbound",
        content:
          `[mesh] @${frame.from ?? "?"} redirected your turn: ${body}\n` +
          `↩ answer with the mesh_reply tool using msgId "${frame.id}"`,
        display: true,
        // details are persisted in the session: hash-only, never the body.
        details: { kind: "ctl", action: "redirect", from: frame.from, bodyHash: frame.bodyHash },
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
    return true;
  } catch {
    return false;
  }
}

/** Wait for one local extension to answer a job_* and run_* control request. */
function requestLocalControl(
  pi: Pick<ExtensionAPI, "events">,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<LocalCtlReply> {
  const events = pi.events;
  if (events === undefined || typeof events.on !== "function") {
    return Promise.resolve({ status: "unsupported", reason: "host has no event bus" });
  }
  const requestId = String(payload.ctlId ?? "");
  const channel = `mesh-ctl:reply:${requestId}`;
  return new Promise<LocalCtlReply>((resolve) => {
    let done = false;
    const settle = (reply: LocalCtlReply): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      events.off?.(channel, handler);
      resolve(reply);
    };
    const handler = (data: unknown): void => {
      if (typeof data === "object" && data !== null) settle(data as LocalCtlReply);
      else settle({ status: "error", reason: "local handler returned no status" });
    };
    const timer = setTimeout(() => {
      // A missing extension and a slow handler are indistinguishable here.
      // "timeout" is the honest status: it may still be acting.
      settle({ status: "timeout", reason: `no local handler answered within ${timeoutMs}ms (not installed, or still acting)` });
    }, timeoutMs);
    // Ref'd on purpose: while a ctl is in flight, the host must not exit
    // before the local handler answers (the bound is small and explicit).
    events.on!(channel, handler);
    try {
      events.emit("mesh-ctl", payload);
    } catch {
      settle({ status: "error", reason: "local event bus failed" });
    }
  });
}

export interface CtlHandlerOpts {
  /** Test/operator override for the local settlement wait. */
  settleTimeoutMs?: number;
  localTimeoutMs?: number;
}

export async function handleCtlFrame(
  rt: MeshRuntime,
  frame: MeshFrame,
  pi: Pick<ExtensionAPI, "sendMessage" | "events">,
  opts: CtlHandlerOpts = {},
): Promise<void> {
  const settleTimeoutMs = opts.settleTimeoutMs ?? CTL_SETTLE_TIMEOUT_MS;
  const replyTo = frame.id;
  const to = frame.from;
  if (to === undefined) return;
  const action = frame.action ?? "";
  let acked = false;
  const ack = (status: CtlAckStatus, extra: { settled?: boolean } = {}): void => {
    // One ack per ctl, and one durable hash-only audit line: action, target,
    // status and the body/reason hashes — never the instruction the peer sent.
    if (acked) return;
    acked = true;
    {
      try {
        rt.ledger.append({
          event: "ctl",
          id: frame.id,
          from: frame.from,
          to: rt.client.alias,
          code: status,
          action,
          ...(frame.target !== undefined ? { target: frame.target } : {}),
          ...(frame.bodyHash !== undefined ? { bodyHash: frame.bodyHash } : {}),
          ...(frame.reasonHash !== undefined ? { reasonHash: frame.reasonHash } : {}),
        });
      } catch {
        rt.ledgerFailures += 1;
      }
    }
    rt.client.sendCtlAck({
      replyTo,
      to,
      status,
      action,
      ...(extra.settled !== undefined ? { settled: extra.settled } : {}),
    });
  };

  if (action === "abort" || action === "redirect") {
    const ctx = rt.ctx as (SessionContext & { abort?(): void; isIdle?(): boolean }) | null;
    if (ctx === null || typeof ctx.abort !== "function" || typeof ctx.isIdle !== "function") {
      ack("abort_unavailable");
      return;
    }
    const wasBusy = !ctx.isIdle();
    if (!wasBusy) {
      // Nothing to abort: a redirect still delivers its instruction; a bare
      // abort says not_busy.
      if (action === "redirect") {
        if (injectRedirect(pi, frame)) ack("redirected", { settled: true });
        else ack("error");
      } else {
        ack("not_busy", { settled: true });
      }
      return;
    }
    try {
      ctx.abort();
    } catch {
      ack("abort_unavailable");
      return;
    }
    const deadline = Date.now() + settleTimeoutMs;
    while (Date.now() < deadline && !ctx.isIdle()) await sleep(50);
    const settled = ctx.isIdle();
    if (action === "redirect") {
      if (settled) {
        if (injectRedirect(pi, frame)) ack("redirected", { settled: true });
        else ack("error");
      } else {
        // The contract is atomic: do not inject behind a turn that is still
        // running. The sender can retry or fall back to mesh_send.
        ack("still_busy", { settled: false });
      }
      return;
    }
    ack(settled ? "aborted" : "still_busy", { settled });
    return;
  }

  if (action === "job_stop" || action === "job_pause" || action === "job_resume" || action === "run_stop" || action === "run_steer") {
    const local = await requestLocalControl(
      pi,
      {
        ctlId: replyTo,
        action,
        target: frame.target,
        message: frame.body,
        from: frame.from,
        to: rt.client.alias,
      },
      opts.localTimeoutMs ?? CTL_LOCAL_TIMEOUT_MS,
    );
    ack(local.status ?? "error", { ...(local.settled !== undefined ? { settled: local.settled } : {}) });
    return;
  }

  ack("unsupported");
}
