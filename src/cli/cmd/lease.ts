// cli/cmd/lease.ts — B: verify a Mesh-Lease trailer against the broker.
// Honest exit codes: 0 = fence current; 5 = stale (hook rejects);
// 1 = broker unavailable (the HOOK decides fail-open, not the CLI).
import { say, sayErr } from "../out.js";
import { EXIT_OK, EXIT_MESH_FAILURE, EXIT_USAGE, EXIT_LEASE_STALE } from "../codes.js";
import { ephemeralClient } from "../ctx.js";
import type { LeaseResult } from "../../client/client.js";
import type { LeaseRef } from "../../shared/lease-trailer.js";

export const LEASE_USAGE =
  "usage: mesh lease verify --task T --lease-id ID --epoch N --fence N [--timeout-ms MS]";

export interface LeaseVerifyArgs extends LeaseRef {
  timeoutMs?: number;
}

export type FenceVerdict = "ok" | "stale" | "unavailable";

/** Pure decision, shared with the tests: does the broker still hold exactly
 *  this epoch:fence for the task? */
export function fenceVerdict(res: LeaseResult, ref: LeaseRef): FenceVerdict {
  if (res.status === "error") return "unavailable";
  if (res.status !== "current") return "stale";
  const lease = res.lease;
  if (lease.leaseId !== ref.leaseId) return "stale";
  if (lease.epoch !== ref.epoch || lease.fence !== ref.fence) return "stale";
  return "ok";
}

export async function cmdLeaseVerify(args: LeaseVerifyArgs): Promise<number> {
  const client = ephemeralClient();
  try {
    await client.connect();
  } catch (err) {
    say(`⚠ broker unavailable — lease NOT verified (${err instanceof Error ? err.message : String(err)})`);
    await client.close();
    return EXIT_MESH_FAILURE;
  }
  let res: LeaseResult;
  try {
    res = await client.leaseStatus(args.task, args.timeoutMs);
  } finally {
    await client.close();
  }
  const verdict = fenceVerdict(res, args);
  if (verdict === "ok") {
    say(`lease ok task=${args.task} fence=${args.epoch}:${args.fence}`);
    return EXIT_OK;
  }
  if (verdict === "stale") {
    sayErr(`stale lease task=${args.task} (${args.epoch}:${args.fence}) — re-claim with mesh_claim and amend the trailer`);
    return EXIT_LEASE_STALE;
  }
  say(`⚠ lease status unavailable (${"reason" in res ? res.reason : "?"}) — lease NOT verified`);
  return EXIT_MESH_FAILURE;
}

export function usageError(reason: string): number {
  sayErr(reason);
  sayErr(LEASE_USAGE);
  return EXIT_USAGE;
}
