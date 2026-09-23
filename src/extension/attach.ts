// extension/attach.ts — client→session wiring, shared by session_start and
// /mesh reset: both need a fully-wired MeshClient, and reset must be
// able to REPLACE the client in-place without a pi reload.
import { readFileSync } from "node:fs";
import type { WelcomeInfo } from "../client/client.js";
import type { MeshFrame } from "../protocol/envelope.js";
import { buildBatchMessage, bypassesBatch, batchDetails, InboundBatcher } from "./batcher.js";
import { DeferredInbox } from "./deferred-inbox.js";
import { classifyInbound } from "./inbound-policy.js";
import type { MeshHud } from "./hud.js";
import { handleInboundSideEffects, injectInbound, type FormatOpts } from "./inbound.js";
import { ReplyHintTracker } from "./reply-hints.js";
import type { ExtensionAPI, InboundMessage, SessionContext } from "./pi-types.js";
import type { MeshRuntime } from "./tools.js";

/** live-entry previews shown while the agent is busy (cooldown). */
const LIVE_COOLDOWN_MS = 1_500;
const liveCooldowns = new Map<string, number>();

/** One full mesh-context block per session — reconnects send a SHORT diff
 *  (measured: cs-master received the ~500-token block 5× — pure duplication).
 *  A compaction resets the flag: the block is re-sent exactly when the
 *  context lost it. */
let fullContextSent = false;
let lastPeersOnline: Set<string> = new Set();
/** Hint tracker — shared per session (compaction resets re-teach). */
const hintTracker = new ReplyHintTracker();

/** Format opts for one inbound frame (compact mode + gated hints). */
export function formatOptsFor(
  frame: MeshFrame,
  verbose: boolean,
  homeRoom: string,
  hints: ReplyHintTracker = hintTracker,
): FormatOpts {
  return {
    verbose,
    homeRoom,
    showReplyHint: hints.shouldShow(frame.from),
  };
}

/** Compact reconnect diff line (~30 tokens vs ~500 for the full block). */
export function buildReconnectDiff(prev: readonly string[], next: readonly string[]): string {
  const before = new Set(prev);
  const after = new Set(next);
  const joined = [...after].filter((a) => !before.has(a));
  const left = [...before].filter((b) => !after.has(b));
  const parts: string[] = [];
  if (joined.length > 0) parts.push(`+${joined.map((a) => `@${a}`).join(", ")}`);
  if (left.length > 0) parts.push(`−${left.map((a) => `@${a}`).join(", ")}`);
  const chg = parts.length > 0 ? ` Peers: ${parts.join(" · ")}.` : " No peer changes.";
  return `[mesh] reconnected${chg} Rooms: ${after.size > 0 ? "online" : "none"} — full status: mesh_status.`;
}

/** Public, process-local identity bridge for other extensions. */
export function exposeAlias(pi: ExtensionAPI, alias: string, rooms: readonly string[]): void {
  (globalThis as Record<symbol, unknown>)[Symbol.for("pi-mesh:alias")] = alias;
  pi.events?.emit("mesh:alias", { alias, rooms: [...rooms] });
}

/** session name keeps the first user message after the mesh identity. */
const SESSION_NAME_MSG_MAX = 80;

const SESSION_NAME_SCAN_BYTES = 256 * 1024; // first 256 KiB of the session file

/**
 * Read the FIRST user message of the session file (what pi's /resume shows
 * when no name is set). Best effort; the scan stops at the first user text.
 */
function firstUserMessage(sessionFile: string | undefined): string | undefined {
  if (sessionFile === undefined || sessionFile === "") return undefined;
  let head: string;
  try {
    head = readFileSync(sessionFile, "utf8").slice(0, SESSION_NAME_SCAN_BYTES);
  } catch {
    return undefined;
  }
  for (const line of head.split("\n")) {
    if (line.trim() === "") continue;
    let entry: { type?: string; message?: { role?: string; content?: unknown } };
    try {
      entry = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
    } catch {
      continue;
    }
    if (entry.type !== "message" || entry.message?.role !== "user") continue;
    const content = entry.message.content;
    const text = Array.isArray(content)
      ? content
          .map((c) => (typeof c === "object" && c !== null && (c as { type?: string; text?: string }).type === "text" ? (c as { text?: string }).text ?? "" : ""))
          .join(" ")
          .trim()
      : typeof content === "string"
        ? content.trim()
        : "";
    if (text.length > 0) return text.length > SESSION_NAME_MSG_MAX ? `${text.slice(0, SESSION_NAME_MSG_MAX - 1)}…` : text;
  }
  return undefined;
}

/**
 * name the pi session so /resume and the session selector show the mesh
 * identity AND the conversation: `mesh @agent-1 · cs-room — <first message>`.
 * A user-defined name is NEVER overwritten; the mesh name is refreshed on
 * ready/rename/join/leave. The first message is kept exactly like pi's
 * default display (session.name ?? session.firstMessage) so nothing is lost.
 */
export function updateSessionName(pi: ExtensionAPI, rt: MeshRuntime): void {
  try {
    if (typeof pi.getSessionName !== "function" || typeof pi.setSessionName !== "function") return;
    const current = pi.getSessionName();
    if (current !== undefined && current !== "" && !current.startsWith("mesh ")) return;
    const rooms = rt.client.rooms.length > 0 ? ` · ${rt.client.rooms.join(",")}` : "";
    const first = firstUserMessage(rt.ctx?.sessionManager?.getSessionFile?.());
    pi.setSessionName(`mesh @${rt.client.alias}${rooms}${first !== undefined ? ` — ${first}` : ""}`);
  } catch {
  // best effort
  }
}

/**
 * Attach every client event handler to `client`. `rt` is the CURRENT runtime
 * object (its `.client` field may be replaced later by /mesh reset — the
 * handlers always read the runtime they were attached with, so the reset path
 * re-attaches on the new client).
 */
export function attachClientListeners(
  pi: ExtensionAPI,
  rt: MeshRuntime,
  getHud: () => MeshHud | null,
  ctx: SessionContext,
  client: import("../client/client.js").MeshClient,
  saveIdentity: (rt: MeshRuntime) => void,
  /** min gap between two live entries of the SAME agent (anti-flood). */
  liveCooldownMs: number = LIVE_COOLDOWN_MS,
): void {
  // D41: after /reload, session switch or replacement, the OLD client may
  // still receive frames while the pi/ctx it captured is STALE — calling
  // pi.* then throws "extension ctx is stale" as an uncaughtException and
  // kills pi. `detached` flips at session_shutdown; every pi/ctx touch in
  // client handlers goes through guarded try/catch as belt-and-braces.
  let detached = false;
  const guarded = (fn: () => void): void => {
    if (detached) return;
    try {
      fn();
    } catch {
      // stale ctx / shutting down — the event belongs to the old session
    }
  };

  const deps = {
    ledger: rt.ledger,
    transcript: rt.transcript,
    selfAlias: client.alias,
    counters: rt,
    read: (msgId: string, from: string) => client.sendRead(msgId, from),
    isReplyToReply: (replyTo: string) => client.isReplyToReply(replyTo),
  };
  // batch inbound messages over a short window → ONE injection (one
  // turn) for a burst; force/remind bypass the batcher (immediate delivery).
  const batcher = new InboundBatcher(
    client.inboundBatchMs,
    client.inboundBatchMaxHoldMs,
    () => rt.ctx?.isIdle?.() === false, // busy = a turn is running (e.g. sleep)
    (frames: MeshFrame[]) => {
    const batch = buildBatchMessage(frames, (f) =>
      formatOptsFor(f, client.contextVerbosity === "full", client.homeRoom),
    );
    guarded(() => {
      pi.sendMessage(
        {
          customType: "mesh-inbound",
          content: batch.content,
          display: true,
          details: batchDetails(frames),
        },
        { triggerTurn: true, deliverAs: batch.deliverAs },
      );
    });
  },
  );
  const deferredInbox = new DeferredInbox(pi, (frame) =>
    formatOptsFor(frame, client.contextVerbosity === "full", client.homeRoom),
  (count) => guarded(() => {
    if (ctx.mode === "tui") ctx.ui.setStatus("mesh-inbox", count > 0 ? `mesh:deferred ${count}` : undefined);
  }));
  rt.deferredInbox = deferredInbox;
  pi.on("input", (_event, inputCtx) => {
    if (!detached && inputCtx.isIdle?.() !== false) guarded(() => deferredInbox.queueForPrompt());
  });
  pi.on("before_agent_start", () => {
    if (!detached) deferredInbox.promptStarting();
  });
  pi.on("agent_start", () => guarded(() => deferredInbox.agentStarting()));
  // rate-limited hold: while the provider rejects turns (429), inbound
  // frames are NOT injected — every injection would burn another failed
  // turn. They are queued and delivered when the hold expires.
  const heldFrames: { frame: MeshFrame; matchedReply: boolean }[] = [];
  const deliver = (frame: MeshFrame, matchedReply: boolean): void => {
    handleInboundSideEffects(frame, deps);
    getHud()?.noteInbound(frame); // preview: transient memory only, never persisted
    if (classifyInbound(frame, client.alias, client.inboundBroadcasts, matchedReply) === "deferred") {
      deferredInbox.push(frame);
      return;
    }
    const opts: FormatOpts = {
      ...formatOptsFor(frame, client.contextVerbosity === "full", client.homeRoom),
    };
    if (bypassesBatch(frame) || client.inboundBatchMs <= 0) {
      batcher.flushNow(); // deliver any pending batch first (ordering)
      guarded(() => {
        injectInbound(pi, rt.ctx, frame, {
          ...opts,
          replyChain: (frame as unknown as { __replyChain?: boolean }).__replyChain === true,
        });
      });
      return;
    }
    // while the agent is busy (sleep/long tool), the frame is HELD for
    // the batch — show it LIVE in the conversation right now (entry outside
    // the LLM context) so the burst is visible in real time.
    // at most one live entry per agent per cooldown — a 30-reply burst
    // shows a representative preview instead of flooding the conversation
    // (the batch carries the full set at the end).
    if (rt.ctx?.isIdle?.() === false) {
      const from = frame.from ?? "";
      const last = liveCooldowns.get(from) ?? 0;
      const now = Date.now();
      if (now - last >= liveCooldownMs) {
        liveCooldowns.set(from, now);
        if (liveCooldowns.size > 128) liveCooldowns.clear(); // bound
        guarded(() => {
          pi.appendEntry("mesh-live", {
            from: frame.from,
            room: frame.room,
            priority: frame.priority,
            body: frame.body,
            at: frame.ts,
          });
        });
      }
    }
    batcher.push(frame);
  };
  // flush everything queued while rate-limited (called at hold expiry)
  rt.flushHeld = (): void => {
    const frames = heldFrames.splice(0);
    for (const { frame, matchedReply } of frames) deliver(frame, matchedReply);
  };
  client.on("inbound", (frame: MeshFrame, meta?: { matchedReply?: boolean }) => {
    if (detached) return; // old session's client after reload/switch — D41
    if (rt === null) return; // session shutting down
    if (rt.rateLimitedUntil !== undefined && rt.rateLimitedUntil > Date.now()) {
      heldFrames.push({ frame, matchedReply: meta?.matchedReply === true }); // no injection while the provider rejects turns
      return;
    }
    deliver(frame, meta?.matchedReply === true);
  });
  rt.batcher = batcher;

  // presence → appendEntry ONLY, no turn
  client.on("presence", (frame: MeshFrame) => {
    if (detached) return; // D41: stale ctx after reload/switch — never throw
    guarded(() => {
      pi.appendEntry("mesh", {
        kind: "mesh-presence",
        alias: frame.from,
        status: frame.status,
        room: frame.room,
        ts: frame.ts,
      });
    });
    getHud()?.scheduleStatusRefresh(); // debounced ≤1/s trailing (hello floods)
  });

  client.on("ready", (welcome: WelcomeInfo) => {
    if (detached) return; // D41
    guarded(() => exposeAlias(pi, client.alias, client.rooms));
    guarded(() => updateSessionName(pi, rt));
    getHud()?.setConnecting(false);
    getHud()?.fetchStatus(); // fire-and-forget, never blocks session_start
  // persist identity as soon as we are connected (covers the very
  // first connect AND every reconnect/rename/reset). Disk-only — safe.
    saveIdentity(rt);
  // identity: tell the agent who it is, once per connection, so it
  // never has to guess its alias (the old file-based mesh had agents
  // confusing each other's identities). display:false keeps it out of
  // the UI; triggerTurn:false avoids an extra turn. The context keeps the
  // FULL picture: peers sharing a room are listed first, the other
  // sessions (with their rooms) after — the agent must know who is where.
  //
  // M2: the FULL block goes out ONCE per session; reconnects (and
  // renames) send a one-line diff instead — measured in cs-room: the
  // master received the ~500-token block 5×, pure context duplication.
    const othersNow = welcome.peers.filter((p) => p.alias !== client.alias).map((p) => p.alias);
    if (fullContextSent) {
      pi.sendMessage(
        {
          customType: "mesh-context",
          content: buildReconnectDiff([...lastPeersOnline], othersNow),
          display: false,
        },
        { triggerTurn: false },
      );
      lastPeersOnline = new Set(othersNow);
      return;
    }
    fullContextSent = true;
    lastPeersOnline = new Set(othersNow);
  // watchdog hook: a compaction wipes the context — re-teach everything
  // (full block + reply hints) exactly when it was lost.
    rt.onCompactionDetected = () => {
      fullContextSent = false;
      hintTracker.reset();
      client.sendActivity("idle"); // harmless; keeps presence fresh
    };
    const roomList = (welcome.rooms.length > 0 ? welcome.rooms.join(",") : "default");
    const myRooms = new Set(roomList.split(","));
    const others = welcome.peers.filter((p) => p.alias !== client.alias);
    const online = others.filter((p) => p.rooms.some((r) => myRooms.has(r)));
    const far = others.filter((p) => !p.rooms.some((r) => myRooms.has(r)));
  // D40: peers on OTHER machines are tagged with their connection origin
  // (via) so the agent knows who is remote (e.g. a MacBook over the LAN).
    const viaTag = (p: { via?: string }): string =>
      p.via !== undefined ? ` [${p.via} — other machine]` : "";
    const peerLine =
      online.length > 0
        ? `Online peers: ${online.map((p) => `@${p.alias}${viaTag(p)}`).join(", ")}.`
        : "Online peers: (none).";
    const farLine =
      far.length > 0
        ? ` Other sessions: ${far
            .slice(0, 12)
            .map((p) => `@${p.alias} (${p.rooms.join(",") || "?"})${viaTag(p)}`)
            .join(", ")}${far.length > 12 ? ` (+${far.length - 12} more)` : ""}.`
        : "";
    let context =
      `[mesh] you are @${client.alias} (rooms: ${roomList}). ` +
      `Your alias is stable across /reload; it changes only via /mesh alias, ` +
      `/mesh reset or /mesh new — if in doubt, mesh_status shows your alias. ` +
      `${peerLine}${farLine} ` +
      `mesh_send/mesh_reply to talk, mesh_status for a live snapshot, ` +
      `mesh_reserve to claim files before editing them. ` +
  // the general orchestrator pattern — launch bursts, wait_all once
      `Mission bursts: mesh_send(..., awaitReply: true, block: false) then ` +
      `mesh_wait_all for the group verdict — never mesh_history to check. ` +
      `ESC cancels a pending mesh_wait_all (verdict CANCELLED, missions stay reportable). ` +
      `mesh_send replyTo: [aliases] designates who receives the reply instead of you.`;
  // a /mesh new handoff may carry the previous session's history —
  // inject it as context so the fresh conversation keeps the thread.
    if (rt.pendingHistory !== undefined && rt.pendingHistory.length > 0) {
      context += `\n\n[mesh] transferred history from the previous session:\n${rt.pendingHistory.join("\n")}`;
    }
    guarded(() => {
      pi.sendMessage(
        {
          customType: "mesh-context",
          content: context,
          display: false,
        },
        { triggerTurn: false },
      );
    });
  });
  client.on("renamed", () => {
    guarded(() => exposeAlias(pi, client.alias, client.rooms));
    guarded(() => updateSessionName(pi, rt));
    saveIdentity(rt); // disk-only
  });
  client.on("alias_fallback", ({ from, to }: { from: string; to: string }) => {
  // Another live peer holds our persisted alias (e.g. crashed session) —
  // we took a random one; persist it so the next reload does not fight
  // for the same alias again.
    saveIdentity(rt); // disk-only
    guarded(() => {
      ctx.ui.notify(`mesh: alias @${from} taken — now connected as @${to}`, { level: "warning" });
    });
  });
  client.on("closed", () => getHud()?.onClosed());
  client.on("expired", ({ msgId }: { msgId: string }) => getHud()?.noteExpired(msgId));

  // async drop receipt: the broker dropped one of OUR messages from the
  // recipient's offline mailbox (TTL expiry or cap eviction). The client
  // already settled any live awaitReply mission; the session must LEARN
  // the message will never arrive so a re-send decision is possible.
  client.on("dropped_offline", (frame: MeshFrame) => {
    if (detached) return; // D41: stale ctx after reload/switch — never throw
    const target = frame.to ?? "?";
    guarded(() => {
      pi.sendMessage(
        {
          customType: "mesh-inbound",
          content:
            `[mesh] drop notice: message ${frame.id} to @${target} was dropped from the ` +
            `offline mailbox (TTL expiry or cap). It will never be delivered — ` +
            `re-send with mesh_send if still relevant.`,
          display: true,
          details: { kind: "mesh-drop-notice", msgId: frame.id, to: target },
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    });
    try {
      rt.ledger.append({
        event: "dropped_offline",
        id: frame.id,
        to: target,
        room: frame.room,
      });
    } catch {
      // best effort — the inline notice already went out
    }
  });

  // D41: flip the guard — called from session_shutdown before client.close().
  // Frames still in flight on the old socket are then dropped silently
  // instead of reaching the stale pi/ctx.
  rt.markDetached = () => {
    deferredInbox.clear();
    detached = true;
  };
}
