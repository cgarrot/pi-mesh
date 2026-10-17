// index.ts — OpenCode plugin entrypoint (double mode: V1 + V2).
//
// The default export carries both plugin generations so a single package
// serves every OpenCode installation:
//   - the V2 half (ctx.command / ctx.tool / ctx.session) — the documented
//     current API, used when the running OpenCode supports it;
//   - the V1 half (`server()` hook map) — used by older OpenCode instances:
//     observation hooks only, because the V1 tool map is zod-based and the
//     runtime-facing hooks are what it exposes.
import type { V2CommandEditor, V2PluginContext, V2ToolEditor } from "./v2-surface.js";
import { buildV1Hooks } from "./hooks.js";
import { applyMeshCommand } from "./register-commands.js";
import { applyMeshTools, applyMeshToolsV1 } from "./register-tools.js";
import {
  anyOnlineRuntime,
  attachDefaultSink,
  attachOpenCodeSession,
  configureRooms,
  disposeAllRuntimes,
  disposeRuntime,
  ensureSessionRuntime,
  logMeshEvent,
  runtimeBySession,
} from "./client-runtime.js";
import type { MeshSessionRuntime } from "./client-runtime.js";
import { findConflict } from "../shared/reservations.js";
import { stateDir } from "../shared/paths.js";
import { injectBatch } from "./inject.js";

/** Resolve (or create) the runtime of an OpenCode session. */
function ensureSession(sessionID: string): Promise<MeshSessionRuntime> {
  return ensureSessionRuntime(sessionID);
}

/** `options.rooms`: default rooms for fresh sessions (plugin options). */
function readOptionRooms(options: unknown): string[] | undefined {
  if (options === null || typeof options !== "object") return undefined;
  const value = (options as { rooms?: unknown }).rooms;
  if (!Array.isArray(value)) return undefined;
  const rooms = value.filter((room): room is string => typeof room === "string");
  return rooms.length > 0 ? rooms : undefined;
}

/** sessionID of a server event, across event payload shapes. */
function eventSessionID(event: unknown): string | undefined {
  if (event === null || typeof event !== "object") return undefined;
  const e = event as {
    sessionID?: unknown;
    data?: { sessionID?: unknown };
    properties?: { sessionID?: unknown };
  };
  for (const candidate of [e.data?.sessionID, e.properties?.sessionID, e.sessionID]) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return undefined;
}

/** Attach a mesh runtime for a sessionID (idempotent, best effort). */
function attachSession(sessionID: string): void {
  void ensureSessionRuntime(sessionID).catch(() => {
    // attach is best effort — tools retry lazily
  });
}

/** Sessions the server deleted — never attach them again. */
const deletedSessions = new Set<string>();

/**
 * Block edit/write on paths reserved by another agent (Pi parity).
 * Throws from the tool hook to abort the tool call.
 */
function enforceReservation(event: unknown): void {
  if (event === null || typeof event !== "object") return;
  const record = event as { tool?: unknown; input?: unknown; args?: unknown };
  const tool = typeof record.tool === "string" ? record.tool : "";
  if (tool !== "edit" && tool !== "write") return;
  const sessionID = eventSessionID(event);
  const runtime = (sessionID !== undefined ? runtimeBySession(sessionID) : undefined) ?? anyOnlineRuntime();
  if (runtime === undefined || !runtime.client.isOnline()) return;
  const input = (record.input ?? record.args) as { path?: unknown; filePath?: unknown } | undefined;
  const path =
    typeof input?.path === "string" && input.path !== ""
      ? input.path
      : typeof input?.filePath === "string" && input.filePath !== ""
        ? input.filePath
        : "";
  if (path === "") return;
  const conflict = findConflict(
    path,
    runtime.client.peerReservationMap,
    runtime.client.alias,
    runtime.client.reservationTtlMs,
  );
  if (conflict === undefined) return;
  const lines = [`${path}`, `Reserved by: @${conflict.alias}`];
  if (conflict.reservation.reason !== undefined && conflict.reservation.reason !== "") {
    lines.push(`Reason: "${conflict.reservation.reason}"`);
  }
  if (conflict.reservation.since !== undefined) lines.push(`Since: ${conflict.reservation.since}`);
  lines.push("");
  lines.push(`Coordinate via mesh_send({ to: "${conflict.alias}", message: "..." }) — or wait for mesh_release.`);
  throw new Error(lines.join("\n"));
}

/**
 * Subscribe to the server event stream: any session-scoped event attaches
 * (or re-attaches) that session's runtime — the OpenCode equivalent of
 * Pi's session_start. Observed event types include session.tool.success,
 * session.step.ended and session.reasoning.*, all carrying data.sessionID.
 * A superseded instance (hot reload) stops its loop immediately.
 */
function attachOnSessionEvents(
  ctx: V2PluginContext,
  signal: AbortSignal,
  attach: (sessionID: string) => void,
  isCurrent: () => boolean,
): void {
  const subscribe = ctx.event?.subscribe;
  if (typeof subscribe !== "function") return;
  void (async () => {
    try {
      for await (const event of subscribe.call(ctx.event, { signal })) {
        if (!isCurrent()) return; // superseded — stop consuming
        if (event === null || typeof event !== "object") continue;
        const type = (event as { type?: unknown }).type;
        if (typeof type !== "string") continue;
        const sessionID = eventSessionID(event);
        if (sessionID === undefined) continue;
        if (type === "session.deleted") {
          // the session is gone: detach from the broker (alias/rooms free).
          deletedSessions.add(sessionID);
          logPluginEvent("session_deleted", { session: sessionID.slice(0, 22) });
          void disposeRuntime(sessionID);
          continue;
        }
        if (deletedSessions.has(sessionID)) continue;
        attach(sessionID);
        // Real turn state: any session event marks busy, session.idle idle.
        const runtime = runtimeBySession(sessionID);
        if (runtime === undefined) continue;
        if (type === "session.idle") runtime.markTurnIdle();
        else runtime.markTurnActive();
      }
    } catch {
      // the stream can end on shutdown/reload — nothing to do
    }
  })();
}

/** Process-global generation: a newer plugin instance supersedes all older
 *  ones, so a superseded instance must never attach again. */
const GENERATION_KEY = Symbol.for("pi-mesh.opencode.generation");

function nextGeneration(): number {
  const store = globalThis as unknown as Record<symbol, number | undefined>;
  const next = (store[GENERATION_KEY] ?? 0) + 1;
  store[GENERATION_KEY] = next;
  return next;
}
function logPluginEvent(event: string, detail: Record<string, unknown> = {}): void {
  logMeshEvent(stateDir(), event, detail); // best effort — never throws
}

function generationIsCurrent(mine: number): boolean {
  const store = globalThis as unknown as Record<symbol, number | undefined>;
  return store[GENERATION_KEY] === mine;
}

/**
 * Reloads load a fresh module instance while the previous instance's broker
 * connections and timers may still be alive (the runtime does not always
 * call the returned cleanup on plugin reload). A process-global slot lets
 * the newest instance dispose the previous one's runtimes deterministically
 * — before it attaches its own, so the identity alias is reclaimed.
 */
const PREVIOUS_DISPOSER = Symbol.for("pi-mesh.opencode.dispose-runtimes");

/** Dispose the previous instance's runtimes; awaited (bounded) so the
 *  identity alias is free before this instance attaches. */
async function disposePreviousInstance(): Promise<void> {
  const store = globalThis as unknown as Record<symbol, (() => Promise<void>) | undefined>;
  const previous = store[PREVIOUS_DISPOSER];
  store[PREVIOUS_DISPOSER] = (): Promise<void> => disposeAllRuntimes();
  if (previous === undefined) return;
  try {
    await Promise.race([
      Promise.resolve(previous()),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        timer.unref();
      }),
    ]);
  } catch {
    // best effort — a stale instance must never break the new one
  }
}

/**
 * The default export carries both plugin generations so a single package
 * serves every OpenCode installation.
 *
 * It is a plain object on purpose: the `define()` helper from
 * `@opencode-ai/plugin/v2/promise` is *not* imported. That subpath does not
 * exist in every OpenCode installation (the installed plugin package only
 * exposes the V1 entry in older builds), and importing it makes the whole
 * plugin fail to load there. Constructing the object by hand is enough —
 * both halves are plain functions.
 */
export default {
  id: "pi-mesh",
  async setup(ctx: V2PluginContext): Promise<() => void> {
    // Take the generation FIRST so older instances stop attaching, then
    // dispose the previous instance's runtimes (hot reloads) and wait for
    // the closes — the identity alias is then free for this instance.
    const generation = nextGeneration();
    const isCurrent = (): boolean => generationIsCurrent(generation);
    logPluginEvent("plugin_setup", { generation });
    await disposePreviousInstance();
    attachOpenCodeSession(ctx);
    // options.rooms: default rooms for FRESH sessions (Pi semantics — the
    // persisted identity always wins; rooms change via `/mesh join`).
    configureRooms(readOptionRooms(ctx.options));
    await attachDefaultSink(async (runtime, frames) => {
      await injectBatch(runtime, frames);
    });
    // Attach mesh runtimes as sessions act: the sidebar/beacon goes live
    // without a mesh tool call and survives plugin reloads.
    const attach = (sessionID: string): void => {
      if (isCurrent()) attachSession(sessionID);
    };
    const controller = new AbortController();
    attachOnSessionEvents(ctx, controller.signal, attach, isCurrent);
    // Older OpenCode builds do not expose the V2 domains yet — in that case
    // the mesh_* tools are not registered (no other path exists).
    if (typeof ctx.command?.transform === "function") {
      await ctx.command.transform((editor: V2CommandEditor) => {
        applyMeshCommand(editor, ensureSession);
      });
    }
    if (typeof ctx.tool?.transform === "function") {
      await ctx.tool.transform((editor: V2ToolEditor) => {
        applyMeshTools(editor, ensureSession);
      });
    }
    // Reservation enforcement (Pi parity): edit/write on a path another
    // agent reserved is blocked; throwing from the hook aborts the call.
    const toolHook = ctx.tool?.hook;
    if (typeof toolHook === "function") {
      void Promise.resolve(
        toolHook.call(ctx.tool, "execute.before", (event: unknown) => {
          if (isCurrent()) enforceReservation(event);
        }),
      ).catch(() => {
        // hook registration unsupported — reservation enforcement stays off
      });
    }
    // Cleanup runs when the plugin unloads (when the runtime calls it):
    // stop the event stream, timers and broker connections.
    return () => {
      controller.abort();
      void disposeAllRuntimes();
    };
  },
  // The V1 half: opencode instances that predate the V2 plugin API call
  // `server()` to obtain the legacy hook map (observation hooks plus the
  // zod-based tool map — zod is imported lazily inside applyMeshToolsV1,
  // so a host without it degrades to observation-only instead of failing).
  server: async () => {
    const hooks = buildV1Hooks();
    await applyMeshToolsV1(hooks, ensureSession);
    return hooks;
  },
};
