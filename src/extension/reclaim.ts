// extension/reclaim.ts — Pi parity with the OpenCode alias auto-reclaim.
//
// A conflict (a ghost socket from a crash/kill, our own dying connection
// during a message-triggered reconnect) forces a random fallback alias. The
// PREFERRED alias is persisted and retried at the next attach, but a long
// lived Pi session would keep the random name until a reload. OpenCode
// reclaims automatically every ALIAS_RECLAIM_MS; Pi had no such loop — the
// asymmetry behind "the OpenCode agents recover their name, the Pi ones
// don't".
//
// Safety: rename() detaches the socket and cancels in-flight awaitReply
// missions, so the reclaim NEVER fires while the session is busy or while a
// mission is pending. A live holder of the alias simply makes the rename fail
// (silent — it is retried on the next tick).
import type { MeshClient } from "../client/client.js";

/** Default reclaim tick: 60 s (OpenCode parity). */
export const DEFAULT_ALIAS_RECLAIM_MS = 60_000;

/** $MESH_ALIAS_RECLAIM_MS override (tests + operators; 0 disables). */
export function readAliasReclaimMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.MESH_ALIAS_RECLAIM_MS ?? "");
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  return DEFAULT_ALIAS_RECLAIM_MS;
}

export interface AliasReclaimOptions {
  client: MeshClient;
  /** The alias this session should hold (live read: /mesh alias updates it). */
  preferredAlias: () => string;
  /** A turn is running — never rename mid-turn. */
  isBusy?: () => boolean;
  /** Called after a successful reclaim (persist identity, rename session, notify). */
  onReclaimed: (alias: string) => void;
  /** Tick interval (ms). 0 disables the loop (returns a no-op stop). */
  intervalMs?: number;
}

export interface AliasReclaimHandle {
  stop(): void;
  /** One reclaim attempt (exported for tests / explicit calls). */
  tick(): Promise<"reclaimed" | "skipped" | "blocked">;
}

/**
 * Start the reclaim loop. Never throws; the timer is unref'd so it can never
 * keep the host process alive. Returns a handle whose stop() clears the timer.
 */
export function startAliasReclaim(opts: AliasReclaimOptions): AliasReclaimHandle {
  let ticking = false;

  const tick = async (): Promise<"reclaimed" | "skipped" | "blocked"> => {
    if (ticking) return "blocked"; // a slow rename must not stack ticks
    const want = opts.preferredAlias();
    if (want === "") return "skipped";
    if (opts.client.alias === want) return "skipped"; // already ours
    if (!opts.client.isOnline()) return "skipped";
    if (opts.isBusy?.() === true) return "blocked"; // mid-turn: never detach
    if (opts.client.pendingCount > 0) return "blocked"; // rename cancels missions
    ticking = true;
    try {
      const res = await opts.client.rename(want);
      if (res.ok && res.unchanged !== true) {
        opts.onReclaimed(want);
        return "reclaimed";
      }
      return res.ok ? "skipped" : "blocked"; // holder alive → retry next tick
    } catch {
      return "blocked"; // best effort — the next tick retries
    } finally {
      ticking = false;
    }
  };

  const intervalMs = opts.intervalMs ?? readAliasReclaimMs();
  if (intervalMs <= 0) return { stop: () => {}, tick };
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref();
  return {
    stop: () => clearInterval(timer),
    tick,
  };
}
