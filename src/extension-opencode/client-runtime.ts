// client-runtime.ts — per-session lifecycle of the mesh runtime inside an
// OpenCode plugin: identity, connect, guards/batching, ledger/transcript,
// activity announcements, teardown.
//
// Reuse: guards, batching, ledger, transcript and the generic MeshClient
// are shared with the Pi adapter — this file only wires them to an
// OpenCode session. Only the host-specific parts (how an inbound message
// reaches a session) live here and in inject.ts.
import { loadConfig, type MeshConfig } from "../shared/config.js";
import { runtimeDir, stateDir } from "../shared/paths.js";
import { MeshIdentity } from "../shared/identity-store.js";
import { InboundBatcher } from "../extension/batcher.js";
import { MeshGuards } from "../extension/guards.js";
import { MeshLedger } from "../extension/ledger.js";
import { MeshTranscript } from "../extension/transcript.js";
import { MeshClient, type MeshClientOpts } from "../client/client.js";
import type { MeshFrame } from "../protocol/envelope.js";
import type { V2SessionHooks } from "./v2-surface.js";

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
}

/** Per-session runtimes, keyed by OpenCode sessionID. */
const runtimes = new Map<string, MeshSessionRuntime>();

/** Register (or replace) the runtime of a session. */
export function registerRuntime(runtime: MeshSessionRuntime): void {
  runtimes.set(runtime.sessionId, runtime);
}

/** Drop the runtime of a session (session ended). */
export function unregisterRuntime(sessionID: string): void {
  runtimes.delete(sessionID);
}

/** The runtime bound to a sessionID, if any. */
export function runtimeBySession(sessionID: string): MeshSessionRuntime | undefined {
  return runtimes.get(sessionID);
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
    ...(stored?.alias !== undefined ? { alias: stored.alias } : {}),
    ...(stored !== null && stored.rooms.length > 0 ? { rooms: [...stored.rooms] } : {}),
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

  // Whether a turn runs is not observable without session hooks, so the
  // batcher only ever sees OUR OWN injections ("busy" until they settle).
  let busyUntilMs = 0;
  const isBusy = (): boolean => Date.now() < busyUntilMs;
  const sendActivity = (state: ActivityState): void => client.sendActivity(state);

  let idleTimer: NodeJS.Timeout | null = null;
  const notifyBusy = (): void => {
    busyUntilMs = Date.now() + Math.max(1_000, cfg.activityIdleMs);
    sendActivity("busy");
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      busyUntilMs = 0;
      sendActivity("idle");
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

  const runtime: MeshSessionRuntime = {
    client,
    guards,
    ledger,
    transcript,
    stateDir: dir,
    sessionId,
    alias: client.alias,
    rooms: [...client.rooms],
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
  };
  runtime.batcher = new InboundBatcher(
    cfg.inboundBatchMs ?? 0,
    cfg.inboundBatchMaxHoldMs ?? 0,
    isBusy,
    (frames) => {
      void deliver(runtime, frames, sink);
    },
  );

  registerRuntime(runtime);

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

/** The OpenCode V2 session context, attached by the plugin entrypoint. */
let attachedSessionContext: V2SessionHooks | null = null;

/** Called by index.ts once the V2 plugin context is available. */
export function attachOpenCodeSession(ctx: unknown): void {
  attachedSessionContext = ctx as unknown as V2SessionHooks;
}

async function submitInto(
  sessionID: string,
  text: string,
  delivery: MeshDelivery,
): Promise<unknown> {
  const session = attachedSessionContext;
  if (session === null) {
    throw new Error("pi-mesh: OpenCode plugin context is not attached");
  }
  return session.prompt({ sessionID, text, delivery });
}

/** Inject a batched set of inbound frames into the OpenCode session. */
async function deliver(
  runtime: MeshSessionRuntime,
  frames: readonly MeshFrame[],
  sink: MeshInboundSink,
): Promise<void> {
  await sink(runtime, frames);
}
