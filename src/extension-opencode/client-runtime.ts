// client-runtime.ts — per-session lifecycle of the mesh runtime inside an
// OpenCode plugin: identity, connect, guards/batching, ledger/transcript,
// activity announcements, teardown.
//
// Reuse: guards, batching, ledger, transcript and the generic MeshClient
// are shared with the Pi adapter — this file only wires them to an
// OpenCode session. Only the host-specific parts (how an inbound message
// reaches a session) live here and in inject.ts.
import { appendFileSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join as joinPath } from "node:path";
import { loadConfig, type MeshConfig } from "../shared/config.js";
import { runtimeDir, stateDir } from "../shared/paths.js";
import { identityFromClient, MeshIdentity, type PersistedIdentity } from "../shared/identity-store.js";
import { InboundBatcher, bypassesBatch } from "../extension/batcher.js";
import { DeferredInbox } from "../extension/deferred-inbox.js";
import { classifyInbound } from "../extension/inbound-policy.js";
import type { FormatOpts } from "../extension/inbound.js";
import { ReplyHintTracker } from "../extension/reply-hints.js";
import type { ExtensionAPI } from "../extension/pi-types.js";
import { MeshGuards } from "../extension/guards.js";
import { MeshLedger } from "../extension/ledger.js";
import { MeshTranscript } from "../extension/transcript.js";
import { computePeerStatus, MeshClient, type MeshClientOpts } from "../client/client.js";
import type { MeshFrame, MeshPeerInfo } from "../protocol/envelope.js";
import type { V2SessionHooks } from "./v2-surface.js";
import { injectFrame } from "./inject.js";

/** The turn states the broker understands (mirrored from client.ts). */
export type ActivityState = "busy" | "idle" | "rate_limited" | "blocked";

/** How OpenCode delivers a message into a session ("steer" / "queue"). */
export type MeshDelivery = "steer" | "queue";

/** Deliver already-batched inbound frames into an OpenCode session. */
export type MeshInboundSink = (
  runtime: MeshSessionRuntime,
  frames: readonly MeshFrame[],
) => Promise<void>;

export interface MeshSessionRuntime {
  /** Generic mesh client — the only thing that touches the broker. */
  client: MeshClient;
  /** Client-side send guards (duplicates, caps, loop warning). */
  guards: MeshGuards;
  /** Inbound batching (frames arriving in a burst become one turn). */
  batcher: InboundBatcher;
  /** Durable, hash-only mesh ledger. */
  ledger: MeshLedger;
  /** Inbound/outbound transcript (opt-in). */
  transcript: MeshTranscript;
  readonly stateDir: string;
  readonly sessionId: string;
  /** The alias the user chose explicitly — retried at every attach even
   *  after a conflict forced a random fallback (self-healing identity). */
  preferredAlias: string;
  /** Alias after connect (random until then). */
  readonly alias: string;
  /** Rooms this session has joined. */
  readonly rooms: readonly string[];
  /** The session's home room — used for display only. */
  readonly homeRoom: string;
  /** Wall-clock start of the session. */
  readonly startedAt: number;
  /** Announce a turn state to the broker (best effort, never throws). */
  sendActivity(state: ActivityState): void;
  /** Whether a turn is (probably) running — best effort. */
  isBusy(): boolean;
  /** Announce "busy" (our own injections) and schedule the "idle" fallback. */
  notifyBusy(): void;
  /** Announce "idle" immediately. */
  notifyIdle(): void;
  /** Arm a fire-and-forget auto-release timer (mesh_reserve). */
  armAutoRelease(pattern: string, timer: NodeJS.Timeout): void;
  /**
   * Submit text into this session's OpenCode run ("steer" interrupts the
   * running turn, "queue" delivers at the next user prompt).
   */
  submit(text: string, delivery: MeshDelivery): Promise<unknown>;
  /** Abort this session's running turn (force+interrupt delivery). */
  interrupt?(): void;
  /** Per-frame formatting (verbosity, home room, reply hints). */
  formatFor(frame: MeshFrame): FormatOpts;
  /** Failure counters (Pi HUD parity). */
  ledgerFailures: number;
  transcriptFailures: number;
  injectionFailures: number;
  /** While set and in the future, inbound frames are held (provider rate limit). */
  rateLimitedUntil?: number;
  /** Deliver every frame held during the rate-limit hold. */
  flushHeld?(): void;
  /** Deferred broadcast inbox (opt-in `inboundBroadcasts: "deferred"`). */
  deferredInbox?: DeferredInbox;
  /** Real turn state from server events (best effort). */
  markTurnActive(): void;
  markTurnIdle(): void;
  /** True while frames are held for a later delivery (never detach then). */
  holdsInbound?(): boolean;
  readonly runtimeDir: string;
  /** Stop the sidebar status beacon timer (idempotent, best effort). */
  stopStatus?(): void;
}

/** Per-session runtimes, keyed by OpenCode sessionID. */
const runtimes = new Map<string, MeshSessionRuntime>();

/** Register (or replace) the runtime of a session. */
export function registerRuntime(runtime: MeshSessionRuntime): void {
  runtimes.set(runtime.sessionId, runtime);
}

/** Drop the runtime of a session (session ended). */
export function unregisterRuntime(sessionID: string): void {
  void disposeRuntime(sessionID);
}

/** Close one session's runtime: stop timers, clear queues, close the broker
 *  connection (the alias/rooms free at the broker), write a final offline
 *  beacon. Idempotent, best effort. */
export async function disposeRuntime(sessionID: string): Promise<void> {
  const runtime = runtimes.get(sessionID);
  if (runtime === undefined) return;
  runtimes.delete(sessionID);
  logMeshEvent(runtime.stateDir, "dispose", { session: sessionID.slice(0, 22), alias: runtime.client.alias });
  await disposeRuntime_(runtime);
}

/** The actual teardown, keyed by the runtime object (NOT the map — see
 *  disposeAllRuntimes: clearing the map first used to make the per-id
 *  lookup find nothing, so NO client was ever closed and every unload
 *  leaked live sockets holding their aliases: the zombie factory behind
 *  the whole evening's alias wars). */
async function disposeRuntime_(runtime: MeshSessionRuntime): Promise<void> {
  try {
    runtime.stopStatus?.();
  } catch {
    // best effort
  }
  try {
    runtime.deferredInbox?.clear();
  } catch {
    // best effort
  }
  try {
    beaconPeers.set(runtime, []);
  } catch {
    // best effort
  }
  try {
    await runtime.client.close();
  } catch {
    // best effort — teardown must never throw
  }
  try {
    await writeStatusBeacon(runtime);
  } catch {
    // best effort — the sidebar falls back to "offline" by staleness anyway
  }
}

// ---- sidebar status beacon ------------------------------------------------
// The CLI (TUI) plugin reads this file to render the mesh card in the
// sidebar — the same data the Pi HUD shows, scoped to one OpenCode session.

/** How often the status beacon is refreshed (ms). */
const STATUS_HEARTBEAT_MS = 2_000;

/** How often a fallen-back runtime retries its PREFERRED alias (self
 *  healing: when the conflict holder disconnects — leaked runtime, other
 *  window, crash — the session reclaims its name automatically). Tests
 *  override with MESH_ALIAS_RECLAIM_MS. */
const ALIAS_RECLAIM_MS = 60_000;
function readAliasReclaimMs(): number {
  const raw = Number(process.env.MESH_ALIAS_RECLAIM_MS ?? "");
  if (Number.isFinite(raw) && raw > 0) return raw;
  return ALIAS_RECLAIM_MS;
}

/** Sessions idle this long CAN detach from the broker — overridable with
 *  MESH_OPENCODE_IDLE_DETACH_MS. DEFAULT 0 = NEVER (Pi parity): a Pi
 *  session stays online for its whole lifetime, and peers must be able to
 *  reach an idle agent (messages queue in its turn, not in the mailbox).
 *  The old 15-min default made agents "leave" rooms while their session
 *  lived — observed as random offlines in the sidebar. */
function readIdleDetachMs(): number {
  const raw = Number(process.env.MESH_OPENCODE_IDLE_DETACH_MS ?? "");
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 0;
}

/** Sidebar status beacon: <stateDir>/mesh-status-<sessionId>.json. */
export function statusBeaconPath(stateDir: string, sessionID: string): string {
  return `${stateDir}/mesh-status-${sessionID}.json`;
}

// ---- user notifications (CLI toast bridge) --------------------------------
// Commands must never inject chat messages; their feedback travels through
// this append-only file, which the sidebar CLI plugin turns into toasts.

/** Notification file: <stateDir>/mesh-notify-<sessionId>.jsonl. */
export function notifyPath(stateDir: string, sessionID: string): string {
  return `${stateDir}/mesh-notify-${sessionID}.jsonl`;
}

/** Append one user-facing notification (best effort, never throws). */
export function notifySession(
  stateDirPath: string,
  sessionID: string,
  text: string,
  level: "info" | "warning" | "error" = "info",
): void {
  try {
    const file = notifyPath(stateDirPath, sessionID);
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), level, text }) + "\n", "utf8");
  } catch {
    // a notification must never break a command
  }
}

/** Last identity snapshot per runtime (skip redundant disk writes). */
const lastIdentity = new WeakMap<MeshSessionRuntime, string>();

/** Persist the session identity when alias/rooms/reservations changed —
 *  keeps the alias stable across reloads (same contract as the Pi adapter).
 *  Also called right after `/mesh join|leave|alias`. The PREFERRED alias
 *  survives fallbacks: `alias` may be a random fallback, but what the user
 *  chose is retried at the next attach. */
export function persistIdentity(runtime: MeshSessionRuntime): void {
  try {
    const identity = identityFromClient(runtime.sessionId, runtime.client);
    identity.preferredAlias = runtime.preferredAlias;
    const key = JSON.stringify({
      alias: identity.alias,
      preferredAlias: identity.preferredAlias,
      rooms: identity.rooms,
      reservations: identity.reservations,
    });
    if (lastIdentity.get(runtime) === key) return;
    lastIdentity.set(runtime, key);
    new MeshIdentity(runtime.stateDir).save(identity);
  } catch {
    // identity persistence is best effort — never break a session
  }
}

/** Compact per-peer state carried by the sidebar beacon. */
interface BeaconPeer {
  alias: string;
  rooms: string[];
  state: "busy" | "idle" | "rate_limited" | "blocked" | "stuck" | "active";
  /** D40: peer reaches the broker from another machine. */
  remote: boolean;
}

function beaconPeer(p: MeshPeerInfo, runtime: MeshSessionRuntime): BeaconPeer {
  const announced = p.activity?.state;
  const state: BeaconPeer["state"] =
    announced ??
    computePeerStatus(
      p.lastSeenAt,
      (p.reservations?.length ?? 0) > 0,
      runtime.client.activityIdleMs,
      runtime.client.activityStuckMs,
    ).status;
  return {
    alias: p.alias,
    rooms: [...p.rooms],
    state,
    remote: p.via !== undefined,
  };
}

/** Cached peer list per runtime — the beacon write never awaits the broker. */
const beaconPeers = new WeakMap<MeshSessionRuntime, BeaconPeer[]>();
/** At most one in-flight peer refresh per runtime. */
const peerRefreshInFlight = new WeakSet<MeshSessionRuntime>();

/** Refresh the cached peer list in the background (never throws). */
function refreshBeaconPeers(runtime: MeshSessionRuntime): void {
  if (!runtime.client.isOnline()) {
    beaconPeers.set(runtime, []);
    return;
  }
  if (peerRefreshInFlight.has(runtime)) return;
  peerRefreshInFlight.add(runtime);
  runtime.client
    .status()
    .then((snap) => {
      beaconPeers.set(
        runtime,
        snap.peers
          .filter((p) => p.alias !== runtime.client.alias)
          .map((p) => beaconPeer(p, runtime)),
      );
    })
    .catch(() => {
      // keep the previous cache — a snapshot failure must not clear it
    })
    .finally(() => {
      peerRefreshInFlight.delete(runtime);
    });
}

/** Diagnostic trail for the alias/presence churn: append-only JSONL in
 *  <stateDir>/mesh-opencode.log. Small, always-on — every dispose,
 *  fallback, reclaim, deleted-session and plugin generation lands here
 *  with a timestamp, so the next incident reads like a story. */
export function logMeshEvent(stateDirPath: string, event: string, detail: Record<string, unknown> = {}): void {
  try {
    const file = joinPath(stateDirPath, "mesh-opencode.log");
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), event, ...detail }) + "\n", "utf8");
  } catch {
    // best effort — diagnostics must never break the runtime
  }
}

/** Best-effort write of the session's live mesh state (never throws). */
async function writeStatusBeacon(runtime: MeshSessionRuntime): Promise<void> {
  try {
    persistIdentity(runtime);
    // Peer list for the sidebar: refreshed in the background, written from
    // cache so a slow/hung broker round-trip can never stall the beacon.
    refreshBeaconPeers(runtime);
    const payload = JSON.stringify({
      sessionId: runtime.sessionId,
      alias: runtime.client.alias,
      rooms: [...runtime.client.rooms],
      homeRoom: runtime.client.homeRoom,
      online: runtime.client.isOnline(),
      busy: runtime.isBusy(),
      peers: beaconPeers.get(runtime) ?? [],
      updatedAt: new Date().toISOString(),
    });
    await writeFile(statusBeaconPath(runtime.stateDir, runtime.sessionId), payload + "\n", "utf8");
  } catch {
    // a failed beacon must never break a session
  }
}

/** Extra rooms used as DEFAULT rooms on a fresh session (plugin options). */
let configuredRooms: readonly string[] = [];

/** Configure the default rooms of fresh OpenCode sessions (`options.rooms`).
 *  Persisted identities always win — the user joins rooms with `/mesh join`. */
export function configureRooms(rooms: readonly string[] | undefined): void {
  configuredRooms = rooms !== undefined ? [...rooms] : [];
}

/** Rooms at session start — Pi semantics: the persisted identity wins; the
 *  configured defaults (config.json ∪ plugin options) apply on first start. */
function initialRooms(cfg: MeshConfig, stored: PersistedIdentity | null): string[] {
  if (stored !== null && stored.rooms.length > 0) return [...stored.rooms];
  const out: string[] = [];
  for (const room of [...cfg.rooms, ...configuredRooms]) {
    const value = typeof room === "string" ? room.trim() : "";
    if (value.length > 0 && !out.includes(value)) out.push(value);
  }
  return out.length > 0 ? out : ["default"];
}

/** The runtime bound to a sessionID, if any. */
export function runtimeBySession(sessionID: string): MeshSessionRuntime | undefined {
  return runtimes.get(sessionID);
}

/** Any online runtime — fallback when a hook event carries no sessionID. */
export function anyOnlineRuntime(): MeshSessionRuntime | undefined {
  for (const runtime of runtimes.values()) {
    if (runtime.client.isOnline()) return runtime;
  }
  return undefined;
}

/** Close every session runtime — called when the plugin unloads/reloads so
 *  no status timers or broker connections survive the module instance.
 *  Takes a snapshot of the RUNTIME OBJECTS (not ids): the old id-based loop
 *  ran after runtimes.clear() and the per-id lookup found nothing, so no
 *  client was ever closed — every reload leaked live sockets that kept
 *  holding their aliases and injecting messages. */
export async function disposeAllRuntimes(): Promise<void> {
  const list = [...runtimes.values()];
  runtimes.clear();
  logMeshEvent(stateDir(), "dispose_all", { count: list.length, aliases: list.map((r) => r.client.alias) });
  for (const runtime of list) {
    try {
      await disposeRuntime_(runtime);
    } catch {
      // best effort — a reload must never fail on teardown
    }
  }
}

/**
 * Create the per-session mesh runtime. Connects asynchronously: tools answer
 * "broker_unavailable" until connect() resolves, exactly like the Pi
 * adapter. `sink` is where the batched inbound frames are injected into the
 * OpenCode session (see inject.ts).
 */
export async function createSessionRuntime(
  sessionId: string,
  cfg: MeshConfig = loadConfig(),
  sink: MeshInboundSink,
): Promise<MeshSessionRuntime> {
  const dir = stateDir();
  const rtDir = runtimeDir();
  const identity = new MeshIdentity(dir);
  const stored = identity.load(sessionId);

  const clientOpts: MeshClientOpts = {
    runtimeDir: rtDir,
    config: cfg,
    // Pi semantics: the persisted identity wins; configured defaults
    // apply on first start. Rooms change through `/mesh join` / `/mesh leave`.
    // The PREFERRED alias is retried first — after a conflict forced a
    // random fallback, the chosen identity self-heals at the next attach.
    rooms: initialRooms(cfg, stored),
    ...((stored?.preferredAlias ?? stored?.alias) !== undefined
      ? { alias: (stored?.preferredAlias ?? stored?.alias) as string }
      : {}),
    ...(stored !== null && stored.reservations.length > 0
      ? { initialReservations: [...stored.reservations] }
      : {}),
  };
  const client = new MeshClient(clientOpts);

  const guards = new MeshGuards();
  const ledger = new MeshLedger(dir, cfg.ledgerMaxBytes);
  const transcript = new MeshTranscript(
    dir,
    cfg.transcript,
    cfg.transcriptRetentionDays,
  );

  // ---- turn state + activity ----------------------------------------------
  // Real turn state arrives through server events (index.ts forwards them);
  // busyUntilMs stays as the fallback for our OWN injections.
  let turnActive = false;
  let busyUntilMs = 0;
  let lastEventAtMs = Date.now();
  const isBusy = (): boolean => turnActive || Date.now() < busyUntilMs;
  const sendActivity = (state: ActivityState): void => client.sendActivity(state);

  let idleTimer: NodeJS.Timeout | null = null;
  const notifyBusy = (): void => {
    busyUntilMs = Date.now() + Math.max(1_000, cfg.activityIdleMs);
    sendActivity("busy");
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      busyUntilMs = 0;
      if (!turnActive) sendActivity("idle");
    }, Math.max(1_000, cfg.activityIdleMs));
    idleTimer.unref();
  };
  const notifyIdle = (): void => {
    busyUntilMs = 0;
    sendActivity("idle");
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = null;
  };

  const autoReleaseTimers = new Set<NodeJS.Timeout>();
  const armAutoRelease = (pattern: string, timer: NodeJS.Timeout): void => {
    // Fire-and-forget: never throws, never blocks. The timer is kept
    // referenced so it cannot be garbage collected mid-flight.
    void pattern;
    autoReleaseTimers.add(timer);
    timer.unref();
  };

  // ---- inbound pipeline (Pi parity) ----------------------------------------
  const hintTracker = new ReplyHintTracker();
  const formatFor = (frame: MeshFrame): FormatOpts => ({
    verbose: cfg.contextVerbosity === "full",
    homeRoom: client.homeRoom,
    showReplyHint: hintTracker.shouldShow(frame.from),
  });

  const runtime: MeshSessionRuntime = {
    client,
    guards,
    ledger,
    transcript,
    stateDir: dir,
    sessionId,
    preferredAlias: stored?.preferredAlias ?? stored?.alias ?? client.alias,
    // Live views: join/leave/rename reach every consumer immediately
    // (`/mesh status` used to show the rooms snapshot taken at creation).
    get alias(): string {
      return client.alias;
    },
    get rooms(): readonly string[] {
      return [...client.rooms];
    },
    homeRoom: client.homeRoom,
    startedAt: Date.now(),
    sendActivity,
    isBusy,
    notifyBusy,
    notifyIdle,
    // Assigned right after creation (the batcher needs the runtime above).
    batcher: null as unknown as InboundBatcher,
    armAutoRelease,
    submit: (text, delivery) => submitInto(sessionId, text, delivery),
    interrupt: (): void => {
      void interruptInto(sessionId).catch(() => {
        // abort is best effort — the message is injected anyway
      });
    },
    formatFor,
    ledgerFailures: 0,
    transcriptFailures: 0,
    injectionFailures: 0,
    markTurnActive: (): void => {
      lastEventAtMs = Date.now();
      if (!turnActive) {
        turnActive = true;
        sendActivity("busy");
      }
    },
    markTurnIdle: (): void => {
      lastEventAtMs = Date.now();
      turnActive = false;
      notifyIdle();
      try {
        runtime.flushHeld?.();
      } catch {
        // best effort
      }
      try {
        // deferred broadcasts ride the next user prompt (never wake the agent)
        runtime.deferredInbox?.queueForPrompt();
      } catch {
        // best effort
      }
    },
    runtimeDir: rtDir,
  };
  runtime.holdsInbound = (): boolean =>
    heldFrames.length > 0 || (runtime.deferredInbox?.count ?? 0) > 0;
  runtime.batcher = new InboundBatcher(
    cfg.inboundBatchMs ?? 0,
    cfg.inboundBatchMaxHoldMs ?? 0,
    isBusy,
    (frames) => {
      void deliver(runtime, frames, sink).catch(() => {
        runtime.injectionFailures += 1;
      });
    },
  );

  // Deferred broadcast inbox (opt-in `inboundBroadcasts: "deferred"`).
  const inboxHost = {
    sendMessage: (message: { content: string }, options?: unknown): void => {
      const deliverAs = (options as { deliverAs?: string } | undefined)?.deliverAs;
      const delivery: MeshDelivery = deliverAs === "followUp" ? "steer" : "queue";
      void runtime.submit(message.content, delivery).catch(() => {
        runtime.injectionFailures += 1;
      });
    },
  } as unknown as Pick<ExtensionAPI, "sendMessage">;
  const deferredInbox = new DeferredInbox(inboxHost, formatFor, () => {
    // the status beacon refreshes every 2 s — nothing to push here
  });
  runtime.deferredInbox = deferredInbox;

  // Frames held while the provider rejects turns (rate-limit hold).
  const heldFrames: { frame: MeshFrame; matchedReply: boolean }[] = [];
  runtime.flushHeld = (): void => {
    const frames = heldFrames.splice(0);
    for (const { frame, matchedReply } of frames) deliverFrame(frame, matchedReply);
  };

  /** Ledger/transcript/receipts/reply-chain — mirror of Pi's side effects. */
  const sideEffects = (frame: MeshFrame): void => {
    (frame as unknown as { __replyChain?: boolean }).__replyChain =
      frame.type === "reply" && frame.replyTo !== undefined && client.isReplyToReply(frame.replyTo);
    if ((frame.type === "msg" || frame.type === "mailbox") && frame.id !== undefined && frame.from !== undefined) {
      try {
        // the message reached this session → honest read receipt
        client.sendRead(frame.id, frame.from);
      } catch {
        // best effort — a failed receipt must never break delivery
      }
    }
    if (frame.type === "msg" || frame.type === "mailbox" || frame.type === "remind" || frame.type === "reply") {
      try {
        ledger.append({
          event: "inbound",
          id: frame.id,
          from: frame.from,
          to: client.alias,
          room: frame.room,
          priority: frame.priority ?? "normal",
          bodyHash: frame.bodyHash,
          refs: frame.refs,
        });
      } catch {
        runtime.ledgerFailures += 1;
      }
    }
    try {
      transcript.record("in", frame);
    } catch {
      runtime.transcriptFailures += 1;
    }
  };

  /** One inbound frame: side effects → policy → immediate or batched. */
  const deliverFrame = (frame: MeshFrame, matchedReply: boolean): void => {
    try {
      sideEffects(frame);
    } catch {
      // side effects are best effort — delivery must still happen
    }
    if (classifyInbound(frame, client.alias, cfg.inboundBroadcasts, matchedReply) === "deferred") {
      deferredInbox.push(frame);
      return;
    }
    if (bypassesBatch(frame) || (cfg.inboundBatchMs ?? 0) <= 0) {
      runtime.batcher.flushNow(); // keep ordering with any pending batch
      void injectFrame(runtime, frame, { interrupt: frame.interrupt === true }).catch(() => {
        runtime.injectionFailures += 1;
      });
      return;
    }
    runtime.batcher.push(frame);
  };

  client.on("inbound", (frame: MeshFrame, meta?: { matchedReply?: boolean }) => {
    if (runtime.rateLimitedUntil !== undefined && runtime.rateLimitedUntil > Date.now()) {
      heldFrames.push({ frame, matchedReply: meta?.matchedReply === true });
      return;
    }
    deliverFrame(frame, meta?.matchedReply === true);
  });

  registerRuntime(runtime);

  // Pi parity (attach.ts): a live peer holds our alias and the client fell
  // back to a random one — say it LOUD (toast bridge), persist the fallback
  // for this attach, and KEEP the preferred alias so the chosen identity is
  // retried at the next attach (self-healing once the holder disconnects).
  client.on("alias_fallback", ({ from, to }: { from: string; to: string }) => {
    logMeshEvent(dir, "alias_fallback", { session: sessionId.slice(0, 22), from, to });
    notifySession(
      dir,
      sessionId,
      `mesh: alias @${from} taken — connected as @${to}` +
        (runtime.preferredAlias === from ? ` (@${from} is retried on the next attach)` : ""),
      "warning",
    );
    try {
      persistIdentity(runtime);
    } catch {
      // best effort
    }
  });

  // Sidebar status beacon: refresh while the session lives (the CLI plugin
  // polls it). unref() so it never keeps the process alive. Pi parity: the
  // runtime stays attached for the session's WHOLE lifetime — an idle
  // detach (opt-in via MESH_OPENCODE_IDLE_DETACH_MS > 0) releases the
  // broker connection; pending messages then queue in the broker mailbox
  // and arrive on the next attach.
  const detachAfterMs = readIdleDetachMs();
  const statusTimer = setInterval(() => {
    void writeStatusBeacon(runtime);
    if (
      detachAfterMs > 0 &&
      Date.now() - lastEventAtMs > detachAfterMs &&
      runtime.holdsInbound?.() !== true
    ) {
      void disposeRuntime(sessionId);
    }
  }, STATUS_HEARTBEAT_MS);

  // Self-healing alias: a conflict may have forced a random fallback (the
  // holder can be a leaked runtime, another window, a crashed session).
  // Retry the PREFERRED alias periodically — the session reclaims its
  // name AUTOMATICALLY as soon as the holder disconnects: no restart, no
  // user action. Failures are silent (a live peer keeps its alias); only
  // the successful reclaim is visible (toast + persist).
  const reclaimTimer = setInterval(() => {
    if (!client.isOnline()) return;
    if (runtime.preferredAlias === client.alias) return;
    void client
      .rename(runtime.preferredAlias)
      .then((res) => {
        if (res.ok && res.unchanged !== true) {
          logMeshEvent(dir, "alias_reclaimed", { session: sessionId.slice(0, 22), alias: runtime.preferredAlias });
          persistIdentity(runtime);
          notifySession(dir, sessionId, `mesh: alias @${runtime.preferredAlias} reclaimed`);
        } else if (!res.ok) {
          logMeshEvent(dir, "reclaim_blocked", { session: sessionId.slice(0, 22), want: runtime.preferredAlias, reason: res.reason });
        }
      })
      .catch(() => {
        // best effort — the next tick retries
      });
  }, readAliasReclaimMs());
  reclaimTimer.unref();

  statusTimer.unref();
  runtime.stopStatus = (): void => {
    clearInterval(statusTimer);
    clearInterval(reclaimTimer);
  };
  void writeStatusBeacon(runtime); // immediate first paint

  void client.connect().catch(() => {
    // Broker absent: tools answer "broker_unavailable" until the host
    // reconnects — never crash the plugin.
  });

  return runtime;
}

/**
 * Get (creating on demand) the runtime of an OpenCode session. `sink` is
 * where batched inbound frames are injected (see inject.ts).
 */
export async function ensureSessionRuntime(
  sessionID: string,
  cfg: MeshConfig = loadConfig(),
  sink?: MeshInboundSink,
): Promise<MeshSessionRuntime> {
  const existing = runtimeBySession(sessionID);
  if (existing !== undefined) return existing;
  return createSessionRuntime(sessionID, cfg, sink ?? defaultSink);
}

/**
 * Called by index.ts once the plugin is running, so inbound batches reach
 * the OpenCode session. Imported lazily to avoid a module cycle.
 */
let defaultSink: MeshInboundSink = async () => {
  // No sink attached (e.g. unit tests) — nothing to deliver.
};

/** Attach the inbound-delivery function used when no sink is supplied. */
export async function attachDefaultSink(fn: MeshInboundSink): Promise<void> {
  defaultSink = fn;
}

/** The OpenCode V2 session domain ({prompt, interrupt, wait}), attached by
 *  the plugin entrypoint. NOTE: the session methods live at `ctx.session`,
 *  NOT at the top of the plugin context — storing the raw ctx breaks
 *  `session.prompt` (observed: "session.prompt is not a function"). */
let attachedSessionContext: V2SessionHooks | null = null;

/** Called by index.ts once the V2 plugin context is available. */
export function attachOpenCodeSession(ctx: unknown): void {
  const record =
    ctx !== null && typeof ctx === "object" ? (ctx as { session?: unknown; prompt?: unknown }) : undefined;
  const domain = record?.session;
  if (
    domain !== null &&
    domain !== undefined &&
    typeof (domain as { prompt?: unknown }).prompt === "function"
  ) {
    attachedSessionContext = domain as V2SessionHooks;
    return;
  }
  // Fallback for builds that expose the session methods at the top level.
  if (typeof record?.prompt === "function") {
    attachedSessionContext = record as unknown as V2SessionHooks;
    return;
  }
  attachedSessionContext = null;
}

async function submitInto(
  sessionID: string,
  text: string,
  delivery: MeshDelivery,
): Promise<unknown> {
  const session = attachedSessionContext;
  if (session === null || typeof session.prompt !== "function") {
    throw new Error("pi-mesh: OpenCode session.prompt is not available — inbound delivery disabled");
  }
  return session.prompt({ sessionID, text, delivery });
}

/** Abort the session's running turn (force+interrupt inbound delivery). */
async function interruptInto(sessionID: string): Promise<unknown> {
  const session = attachedSessionContext;
  if (session === null || typeof session.interrupt !== "function") {
    throw new Error("pi-mesh: OpenCode session.interrupt is not available");
  }
  return session.interrupt({ sessionID, continue: false });
}

/** Inject a batched set of inbound frames into the OpenCode session. */
async function deliver(
  runtime: MeshSessionRuntime,
  frames: readonly MeshFrame[],
  sink: MeshInboundSink,
): Promise<void> {
  await sink(runtime, frames);
}
