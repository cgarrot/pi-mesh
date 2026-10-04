// cli/cmd/reserve.ts — one-shot reserve with HONEST semantics (plan 2.5):
// - default = dry-run: claim, show conflicts, release at process exit
//   (the claim is connection-scoped — the note says so explicitly)
// - --hold <ms> keeps the process alive holding the claim (countdown,
//   Ctrl-C releases cleanly); capped under the reservation TTL — holding
//   "forever" would be a lie: the TTL expires the claim anyway.
import { say, sayErr } from "../out.js";
import { EXIT_OK, EXIT_MESH_FAILURE, EXIT_USAGE, EXIT_PARTIAL } from "../codes.js";
import { ephemeralClient } from "../ctx.js";
import { CLI_HOLD_MAX_MS, CLI_HOLD_TICK_MS, CLI_RESERVE_GRACE_MS, CLI_RESERVE_SETTLE_MS } from "../../shared/config.js";
import { findConflict } from "../../shared/reservations.js";
import type { FileReservation } from "../../protocol/envelope.js";
import type { MeshClient } from "../../client/client.js";

export const RESERVE_USAGE = "usage: mesh reserve <path>... [--reason R] [--hold MS]";
export const RELEASE_USAGE = "usage: mesh release [<pattern>...] [--all]";

async function conflictsFor(client: MeshClient, patterns: string[]): Promise<string[]> {
  const lines: string[] = [];
  const snap = await client.status();
  const byPeer = new Map<string, readonly FileReservation[]>();
  for (const p of snap.peers) {
    if (p.reservations !== undefined && p.reservations.length > 0) {
      byPeer.set(p.alias, p.reservations);
    }
  }
  for (const pattern of patterns) {
    const c = findConflict(pattern, byPeer, client.alias, client.reservationTtlMs);
    if (c !== undefined) {
      lines.push(`conflict: ${pattern} held by @${c.alias}${c.reservation.reason !== undefined ? ` — ${c.reservation.reason}` : ""}`);
    }
  }
  return lines;
}

export interface ReserveArgs {
  paths: string[];
  reason: string | undefined;
  holdMs: number | undefined;
}

export async function cmdReserve(args: ReserveArgs): Promise<number> {
  const { paths, reason, holdMs } = args;
  if (paths.length === 0) {
    sayErr(RESERVE_USAGE);
    return EXIT_USAGE;
  }
  if (holdMs !== undefined && (!Number.isInteger(holdMs) || holdMs < 1_000 || holdMs > CLI_HOLD_MAX_MS)) {
    sayErr(`invalid --hold ${holdMs} (1000..${CLI_HOLD_MAX_MS} ms, under the reservation TTL)`);
    return EXIT_USAGE;
  }

  const client = ephemeralClient();
  try {
    await client.connect();
  } catch (err) {
    say(`blocked: ${err instanceof Error ? err.message : String(err)}`);
    await client.close();
    return EXIT_MESH_FAILURE;
  }

  // settle: let the welcome snapshot + any live reserve broadcasts land so
  // the conflict check sees current peer claims (best effort, bounded)
  await new Promise((r) => setTimeout(r, CLI_RESERVE_SETTLE_MS));

  const res = await client.reserve(paths, reason);
  if (res.status !== "delivered") {
    sayErr(`reserve failed: ${"reason" in res ? res.reason : res.status}`);
    await client.close();
    return EXIT_MESH_FAILURE;
  }
  say(`reserved ${paths.join(", ")}`);

  // effective hold cap: the CONFIGURED TTL wins when smaller — a hold that
  // would expire mid-countdown is refused, never silently truncated
  if (holdMs !== undefined) {
    const ttl = client.reservationTtlMs;
    const effectiveMax = ttl === 0 ? CLI_HOLD_MAX_MS : Math.min(CLI_HOLD_MAX_MS, ttl);
    if (holdMs >= effectiveMax) {
      sayErr(`--hold ${holdMs} must stay under the effective reservation TTL (${effectiveMax} ms)`);
      await client.release(paths);
      await client.close();
      return EXIT_USAGE;
    }
  }

  // dry-run conflict report against the peers' CURRENT claims
  const conflicts = await conflictsFor(client, paths);
  for (const line of conflicts) sayErr(line);

  if (holdMs === undefined) {
    say("(released on exit — CLI reservations are connection-scoped)");
    await new Promise((r) => setTimeout(r, CLI_RESERVE_GRACE_MS)); // let peers receive the broadcast
    await client.close();
    return conflicts.length > 0 ? EXIT_PARTIAL : EXIT_OK;
  }

  // --hold: keep the process (and the connection, and the claim) alive
  say(`holding for ${Math.round(holdMs / 1000)}s — Ctrl-C to release (TTL still applies)`);
  let stopping = false;
  const stop = (): void => {
    // second signal while cleaning up (or a dead broker trapping the
    // release) → exit NOW rather than becoming unkillable
    if (stopping) process.exit(EXIT_OK);
    stopping = true;
    say("releasing…");
    const force = setTimeout(() => process.exit(EXIT_OK), 3_000);
    force.unref();
    void client.release(paths).then(() => {
      void client.close().then(() => process.exit(EXIT_OK));
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const deadline = Date.now() + holdMs;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(CLI_HOLD_TICK_MS, remaining)));
    const left = deadline - Date.now();
    if (left > 0) say(`holding… ${Math.ceil(left / 1000)}s left`);
  }
  await client.release(paths);
  say("hold elapsed — released");
  await client.close();
  return conflicts.length > 0 ? EXIT_PARTIAL : EXIT_OK;
}

/** One-shot release: honest no-op — a fresh process holds NO claims (they
 * die with their connection). Real releases happen in the SAME process
 * (reserve --hold → Ctrl-C) or a persistent peer (attach, Phase 5). */
export async function cmdRelease(patterns: string[], all: boolean): Promise<number> {
  if (!all && patterns.length === 0) {
    sayErr(RELEASE_USAGE);
    return EXIT_USAGE;
  }
  const client = ephemeralClient();
  try {
    await client.connect();
  } catch (err) {
    say(`blocked: ${err instanceof Error ? err.message : String(err)}`);
    await client.close();
    return EXIT_MESH_FAILURE;
  }
  // one-shot processes hold NOTHING of their own — skip the pointless
  // network round-trip and say where releases actually happen
  if (client.reservations.length === 0) {
    say("released nothing — one-shot CLI processes hold no claims");
    say("(reservations are connection-scoped: release where you hold — `reserve --hold` + Ctrl-C, or attach)");
    await client.close();
    return EXIT_OK;
  }
  const res = await client.release(all ? undefined : patterns);
  const released = "released" in res ? res.released : [];
  say(`released ${released.join(", ")}`);
  await client.close();
  return EXIT_OK;
}
