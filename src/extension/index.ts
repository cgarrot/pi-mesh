// extension/index.ts — Pi extension entrypoint. Thin adapter: all logic
// lives in client/; this file wires lifecycle, events, ledger and transcript.
// connect is NON-blocking — tools answer `blocked` when the broker is down.
import { MeshClient, type WelcomeInfo } from "../client/client.js";
import { loadConfig } from "../shared/config.js";
import { runtimeDir, stateDir } from "../shared/paths.js";
import { statSync } from "node:fs";
import { registerCommands } from "./commands.js";
import { MeshGuards } from "./guards.js";
import { MeshHud } from "./hud.js";
import { attachClientListeners } from "./attach.js";
import { injectInbound } from "./inbound.js";
import { renderLiveEntry, renderMeshInbound, renderVerdictEntry } from "./renderer.js";
import type { PersistedIdentity } from "../shared/identity-store.js";
import { identityFromClient, MeshIdentity } from "../shared/identity-store.js";
import { MeshLedger } from "./ledger.js";
import type { ExtensionAPI } from "./pi-types.js";
import { findConflict } from "../shared/reservations.js";
import { registerTools, type MeshRuntime } from "./tools.js";
import { providerErrorState, providerErrorStateFromMessage } from "./provider-errors.js";
import { MeshTranscript } from "./transcript.js";
import { analyzeTurn, countRejected, countToolCalls, renderVerdict, type TurnSample } from "./watchdog.js";
import type { MeshFrame } from "../protocol/envelope.js";
import type { SessionContext } from "./pi-types.js";

export default function meshExtension(pi: ExtensionAPI): void {
  let runtime: MeshRuntime | null = null;
  let hud: MeshHud | null = null;
  const getRuntime = (): MeshRuntime | null => runtime;

  // Tools + command are registered IMMEDIATELY (they answer `blocked` offline).
  registerTools(pi, getRuntime);
  registerCommands(pi, getRuntime, () => hud?.onLocalChange(), () => hud);
  // live inbound entries rendered while a tool call runs (outside the
  // LLM context — zero tokens), so bursts are visible in real time.
  if (typeof pi.registerEntryRenderer === "function") {
    pi.registerEntryRenderer<{ from?: string; room?: string; body?: string; at?: string }>(
      "mesh-live",
      (entry, _options, theme) => ({
        render: (width: number) =>
          renderLiveEntry(entry.data, width, {
            fg: (color, text) => theme.fg(color, text),
            bg: (color, text) => theme.bg?.(color, text) ?? text,
            bold: (text) => theme.bold?.(text) ?? text,
          }),
        invalidate: () => {},
      }),
    );
  }
  // mesh-verdict: the colored mesh_wait_all result (display only — the
  // entry lives OUTSIDE the LLM context; the tool result carries the text).
  if (typeof pi.registerEntryRenderer === "function") {
    pi.registerEntryRenderer<{ head?: string; answers?: { to: string; response: string }[]; missing?: { to: string; msgId: string }[] }>(
      "mesh-verdict",
      (entry, _options, theme) => ({
        render: (width: number) =>
          renderVerdictEntry(entry.data, width, {
            fg: (color, text) => theme.fg(color, text),
            bg: (color, text) => theme.bg?.(color, text) ?? text,
            bold: (text) => theme.bold?.(text) ?? text,
            fgAnsi: (color) => (theme as unknown as { getFgAnsi(c: string): string }).getFgAnsi(color),
          }),
        invalidate: () => {},
      }),
    );
  }
  // colored rendering of mesh messages (simple + batches).
  if (typeof pi.registerMessageRenderer === "function") {
    pi.registerMessageRenderer<{ kind?: string; count?: number }>(
      "mesh-inbound",
      (message, _options, theme) => {
        const content = typeof message.content === "string" ? message.content : "";
        const details = message.details;
        return {
          render: (width: number) =>
            renderMeshInbound(content, details, width, {
              fg: (color, text) => theme.fg(color, text),
              bg: (color, text) => theme.bg?.(color, text) ?? text,
              bold: (text) => theme.bold?.(text) ?? text,
            }),
          invalidate: () => {},
        };
      },
    );
  }


  /** Persist the current client state as this session's identity. */
  const saveIdentity = (rt: MeshRuntime): void => {
    rt.identity.save(identityFromClient(rt.sessionId, rt.client));
  };
  /** Live HUD accessor (the module-level `hud` variable is reassigned). */
  const getHudRef = (): MeshHud | null => hud;

  pi.on("session_start", (_event, ctx) => {
    const sDir = stateDir(); // <cwd>/.mesh or $MESH_STATE_DIR
    const rDir = runtimeDir();
    const config = loadConfig(sDir);
  // the pi sessionId is stable across /reload — reuse the persisted
  // identity (alias, rooms, reservations) so the agent does NOT lose its
  // mesh identity when the extension is reloaded.
    const sessionId = ctx.sessionManager?.getSessionId() ?? "";
    const identity = new MeshIdentity(sDir);
  // /mesh new handoff — the staged identity (alias/rooms/reservations
  // and optionally the history) is consumed by the next session_start.
    let persisted: PersistedIdentity | null = identity.load(sessionId);
    let pendingHistory: string[] | undefined;
    if (persisted === null) {
      const pending = identity.consumePending();
      if (pending !== null) {
        persisted = pending.identity;
        pendingHistory = pending.history;
      }
    }
    const client = new MeshClient({
  // explicit config.alias always wins; then the persisted alias; else random
      alias: config.alias ?? persisted?.alias,
      rooms: persisted !== null && persisted.rooms.length > 0 ? persisted.rooms : config.rooms,
      initialReservations: persisted?.reservations,
      runtimeDir: rDir,
      config,
    });
    const ledger = new MeshLedger(sDir, config.ledgerMaxBytes);
    const transcript = new MeshTranscript(sDir, config.transcript, config.transcriptRetentionDays);
    const guards = new MeshGuards();
    runtime = {
      client,
      ledger,
      transcript,
      guards,
      ctx,
      stateDir: sDir,
      runtimeDir: rDir,
      sessionId,
      identity,
      pendingHistory,
      startedAt: Date.now(),
      ledgerFailures: 0,
      transcriptFailures: 0,
      injectionFailures: 0,
      appendEntry: (type, data) => pi.appendEntry(type, data),
      interruptReceipts: config.interruptReceipts !== false,
      interruptCount: 0,
    };
    const rt = runtime;

    // ---- context watchdog (M1) ---------------------------------------------
    // Detects degenerate turns (hundreds of rejected duplicate tool calls —
    // measured incident: 3450 calls, +7.9 MB, latency ×10) and compactions.
    // Notification + display-only entry: ZERO tokens in the LLM context.
    let lastSample: TurnSample | null = null;
    const watchdogCfg = () => ({
      spikeBytes: config.watchdogSpikeBytes ?? 2_097_152,
      maxCalls: config.watchdogMaxCalls ?? 64,
      compactionBytes: config.watchdogCompactionBytes ?? 1_048_576,
    });
    const sampleTurn = (message: unknown, toolResults: readonly unknown[]): TurnSample => {
      let fileBytes: number | null = null;
      try {
        const file = ctx.sessionManager?.getSessionFile?.();
        if (file !== undefined && file !== "") {
          fileBytes = statSync(file).size;
        }
      } catch {
  // stat is best-effort — analysis still works count-based
      }
      return {
        fileBytes,
        toolCalls: countToolCalls(message),
        rejectedCalls: countRejected(toolResults),
        at: Date.now(),
      };
    };
    const runWatchdog = (message: unknown, toolResults: readonly unknown[]): void => {
      if (config.watchdog === false) return;
      try {
        const sample = sampleTurn(message, toolResults);
        const verdict = analyzeTurn(sample, lastSample, watchdogCfg());
        lastSample = sample;
        if (verdict.type === "ok") return;
        if (verdict.type === "compaction") {
          try {
            rt.onCompactionDetected?.();
          } catch {
  // best effort
          }
          return; // silent — the resync message is the visible part
        }
        const text = renderVerdict(verdict);
        ctx.ui.notify(text, { level: "warning" });
        rt.appendEntry?.("mesh-watchdog", { verdict, at: sample.at });
      } catch {
  // the watchdog must NEVER break a turn
      }
    };

    attachClientListeners(pi, rt, getHudRef, ctx, client, saveIdentity);

  // Phase 3: announce turn state to the mesh — busy on the first tool
  // call of a turn, idle when the whole run settles. Only on CHANGE
  // (2 frames per turn, never spams the room).
    let announcedActivity: "busy" | "idle" | "rate_limited" | "blocked" | null = null;
    let lastErrorAt = 0;
    const ERROR_COOLDOWN_MS = 30_000;
    const RATE_LIMIT_HOLD_MS = 60_000;
    const BLOCKED_HOLD_MS = 30 * 60_000; // quota/auth: long hold, no ping-pong
    let holdTimer: NodeJS.Timeout | null = null;
    const startHold = (state: "rate_limited" | "blocked"): void => {
      const holdMs = state === "rate_limited" ? RATE_LIMIT_HOLD_MS : BLOCKED_HOLD_MS;
      rt.rateLimitedUntil = Date.now() + holdMs;
      if (holdTimer !== null) clearTimeout(holdTimer);
      holdTimer = setTimeout(() => {
        holdTimer = null;
        rt.rateLimitedUntil = undefined;
      // D41: after a reload the old holdTimer can fire on a CLOSED client;
      // session_shutdown's stopHold() clears this timer, and this try/catch
      // is the belt-and-braces (announce may touch a stale client/session).
        try {
          announce("idle");
          rt.flushHeld?.();
        } catch {
          // delivery is best effort — never break the timer
        }
      }, holdMs);
      holdTimer.unref();
    };
  // D41: cleared at session_shutdown — a surviving timer would fire after
  // the session (and its client) are gone.
    rt.stopHold = () => {
      if (holdTimer !== null) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
      rt.rateLimitedUntil = undefined;
    };
    const announce = (state: "busy" | "idle" | "rate_limited" | "blocked"): void => {
      if (announcedActivity === state) return;
      announcedActivity = state;
      client.sendActivity(state);
    };
    announce("idle"); // present and waiting from the start
    pi.on("tool_call", (_event, _ctx) => announce("busy"));
    pi.on("agent_settled", (_event, _ctx) => {
      // failure states stick for a cooldown — an agent whose provider is
      // rejecting turns must stay flagged so senders stop reminding; it
      // flips back to idle once a settle happens WITHOUT a fresh error.
      if (Date.now() - lastErrorAt > ERROR_COOLDOWN_MS) announce("idle");
    });
    // provider error detection. The GROUND TRUTH is the failed assistant
    // turn (turn_end carries stopReason "error" + errorMessage) — the SDK
    // throws on HTTP errors, so the response-status event never fires for
    // them. Quota/budget limits (FreeUsageLimitError…) are PERMANENT:
    // long hold + blocked; 429/5xx are transient: short hold + rate_limited.
    pi.on("turn_end", (event, _ctx) => {
      const msg = (event as { message?: { stopReason?: string; errorMessage?: string }; toolResults?: unknown[] }).message;
      // M1 watchdog runs FIRST — independent of provider-error detection.
      runWatchdog(msg, (event as { toolResults?: unknown[] }).toolResults ?? []);
      if (msg === undefined || msg.stopReason !== "error") return;
      const state = providerErrorStateFromMessage(msg.errorMessage ?? "");
      if (state === undefined) return;
      lastErrorAt = Date.now();
      announce(state);
      startHold(state);
    });
    // a model/provider switch means a human intervened (e.g. the quota is
    // exhausted) — lift the hold and deliver the backlog right away.
    pi.on("model_select", (_event, _ctx) => {
      if (holdTimer !== null) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
      rt.rateLimitedUntil = undefined;
      announce("idle");
      try {
        rt.flushHeld?.();
      } catch {
        // best effort
      }
    });
    // status-code fallback (fires on responses that DO carry a status)
    pi.on("after_provider_response", (event, _ctx) => {
      const state = providerErrorState((event as { status?: number }).status ?? 0);
      if (state === undefined) return;
      lastErrorAt = Date.now();
      announce(state);
      startHold(state);
    });

  // reservation enforcement: block edit/write on paths another agent
  // has reserved. Runs FIRST (before any other tool handling); the block
  // message tells the agent who holds the reservation and why.
    pi.on("tool_call", (event, _ctx) => {
      const rt = runtime;
      if (rt === null) return;
      if (!rt.client.isOnline()) return;
      if (event.toolName !== "edit" && event.toolName !== "write") return;
      const path = typeof event.input?.path === "string" ? event.input.path : undefined;
      if (path === undefined || path === "") return;
      const conflict = findConflict(path, rt.client.peerReservationMap, rt.client.alias, rt.client.reservationTtlMs);
      if (conflict === undefined) return;
      const holder = conflict.alias;
      const res = conflict.reservation;
      const lines = [
        `${path}`,
        `Reserved by: @${holder}`,
      ];
      if (res.reason !== undefined && res.reason !== "") lines.push(`Reason: "${res.reason}"`);
      if (res.since !== undefined) lines.push(`Since: ${res.since}`);
      lines.push("");
      lines.push(
        `Coordinate via mesh_send({ to: "${holder}", message: "..." }) — ` +
          `or wait for mesh_release.`,
      );
      return { block: true, reason: lines.join("\n") };
    });

  // HUD above the editor: attach after runtime creation, non-blocking.
    hud = new MeshHud({ getRuntime });
    hud.setConnecting(true);
    hud.attach(ctx);

  // NON-blocking connect: failures leave tools answering `blocked`.
    client.connect().catch(() => {});
  });

  // a pi FORK creates a fresh session — hand the mesh identity over
  // (like /mesh new, without history) so the forked session keeps alias,
  // rooms and reservations instead of starting anonymous.
  // when a tool call ends (e.g. the sleep), the busy period is over —
  // deliver every held inbound message as ONE batch, so the next LLM call
  // sees the whole lot in a single turn instead of one message per turn.
  pi.on("tool_result", async (_event, _ctx) => {
    try {
      runtime?.batcher?.flushNow();
    } catch {
  // a send during teardown must never break the handler
    }
  });

  pi.on("session_before_fork", (_event, ctx) => {
    const rt = runtime;
    if (rt === null) return;
    try {
      rt.identity.savePending(identityFromClient(rt.sessionId, rt.client));
    } catch {
  // best effort
    }
  });

  pi.on("session_shutdown", async () => {
    const rt = runtime;
    runtime = null;
    const h = hud;
    hud = null;
    h?.detach(); // clears BOTH widget and status
  // D41: flip the client-handler guard BEFORE anything else — frames still
  // in flight on the old socket must never touch the (about-to-be-stale)
  // pi/ctx. This is the fix for the "extension ctx is stale" crash.
    try {
      rt?.markDetached?.();
      rt?.stopHold?.();
    } catch {
      // best effort
    }
    if (rt !== null) {
  // cancel any pending auto-release timers (mesh_reserve autoReleaseMs)
      try {
        if (rt.reserveTimers !== undefined) {
          for (const t of rt.reserveTimers.values()) clearTimeout(t);
          rt.reserveTimers.clear();
        }
      } catch {
  // best effort
      }
  // deliver anything still buffered —: pi.sendMessage may throw
  // while the runtime is shutting down; never break session_shutdown.
      try {
        rt.batcher?.flushNow();
      } catch {
  // best effort
      }
  // persist the identity BEFORE closing — the broker purges
  // alias/rooms/reservations with the connection, and the next
  // session_start (e.g. /reload) re-loads them from disk.
      try {
        saveIdentity(rt);
      } catch {
  // best effort
      }
  // AWAIT the close: /reload fires session_start right after this
  // handler, and the new client re-hellos under the same alias. If the
  // old socket is still alive at the broker, the hello is refused with
  // alias_taken and the session falls back to a random alias. Waiting
  // for the socket to actually close (bounded, ≤ ACK_TIMEOUT_MS) makes
  // the alias handover clean.
      try {
        await rt.client.close();
      } catch {
  // best effort
      }
    }
  });
}
