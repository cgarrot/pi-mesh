// cli/cmd/status.ts — mesh status / peers / stale: live broker snapshot
// with activity markers, remote origins (via=), versions and reservations.
// Activity and reservation TTLs reuse the CLIENT's own config getters and
// computePeerStatus() — the same semantics the extension renders, never a
// parallel hardcoded heuristic.
import { say, sayErr, jsonLine } from "../out.js";
import { EXIT_OK, EXIT_MESH_FAILURE } from "../codes.js";
import { ephemeralClient } from "../ctx.js";
import { computePeerStatus, formatDurationShort, type MeshClient } from "../../client/client.js";
import { MESH_VERSION } from "../../shared/version.js";

export const STATUS_USAGE = "usage: mesh status [room] [--all] [--reservations] [--json]  (alias: peers)";

function activityMarker(client: MeshClient, p: { activity?: { state: string }; lastSeenAt?: string; reservations?: unknown[] }): string {
  if (p.activity !== undefined) {
    switch (p.activity.state) {
      case "busy":
        return "●";
      case "rate_limited":
        return "⛔";
      case "blocked":
        return "✕";
      default:
        return "○";
    }
  }
  // no announcement: same heuristic as the extension (idle vs genuinely
  // stuck while holding reservations) — via the tested computePeerStatus()
  const st = computePeerStatus(p.lastSeenAt, (p.reservations?.length ?? 0) > 0, client.activityIdleMs, client.activityStuckMs);
  return st.status === "stuck" ? "✕" : st.status === "idle" ? "○" : "●";
}

function reservationAge(since: string | undefined): string {
  if (since === undefined) return "?";
  const ms = Date.now() - Date.parse(since);
  return Number.isNaN(ms) ? "?" : formatDurationShort(ms);
}

function reservationTtlState(since: string | undefined, ttlMs: number): string {
  if (ttlMs === 0) return "no-ttl";
  if (since === undefined) return "unknown-age";
  const age = Date.now() - Date.parse(since);
  if (Number.isNaN(age)) return "unknown-age";
  if (age >= ttlMs) return "EXPIRED";
  if (age >= ttlMs / 2) return "half-ttl";
  return "fresh";
}

export interface StatusOpts {
  room: string | undefined;
  all: boolean;
  reservations: boolean;
  json: boolean;
}

export async function cmdStatus(opts: StatusOpts): Promise<number> {
  const client = ephemeralClient();
  try {
    await client.connect();
  } catch {
    say("blocked: broker_unavailable");
    return EXIT_MESH_FAILURE;
  }
  const snap = await client.status(opts.all && opts.room === undefined ? undefined : opts.room);
  const stats = snap.stats;

  if (opts.json) {
    jsonLine({
      peers: snap.peers.map((p) => ({
        alias: p.alias,
        rooms: p.rooms,
        via: p.via,
        version: p.clientVersion,
        since: p.since,
        lastSeenAt: p.lastSeenAt,
        activity: p.activity ?? null,
        reservations: p.reservations ?? [],
      })),
      rooms: snap.rooms,
      stats: stats ?? null,
      cliVersion: MESH_VERSION,
    });
    await client.close();
    return EXIT_OK;
  }

  for (const p of snap.peers) {
    const v = p.clientVersion !== undefined && p.clientVersion !== "" ? `v${p.clientVersion}` : "v?";
    const skew = p.clientVersion !== undefined && p.clientVersion !== MESH_VERSION ? " ⚠" : "";
    const via = p.via !== undefined ? ` via=${p.via}` : "";
    const act = p.activity !== undefined ? ` ${p.activity.state}` : "";
    say(
      `${activityMarker(client, p)} ${p.alias}\trooms=${p.rooms.join(",")}\t${v}${skew}${via}${act}\tsince=${p.since ?? "?"}`,
    );
  }
  if (opts.reservations) {
    const ttl = client.reservationTtlMs; // honors the =0 opt-out
    let any = false;
    for (const p of snap.peers) {
      for (const r of p.reservations ?? []) {
        any = true;
        say(`  ⚿ ${p.alias} holds ${r.pattern} (age ${reservationAge(r.since)}, ${reservationTtlState(r.since, ttl)})${r.reason !== undefined ? ` — ${r.reason}` : ""}`);
      }
    }
    if (!any) say("  (no reservations held by peers)");
  }
  if (stats !== undefined) {
    say(
      `broker: relayed=${stats.relayed} refused=${stats.refused} mailboxDelivered=${stats.mailboxDelivered} mailboxDropped=${stats.mailboxDropped}`,
    );
  }
  await client.close();
  return EXIT_OK;
}
