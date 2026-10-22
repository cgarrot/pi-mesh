// broker/lease.ts — B: one-writer task leases with an epoch fence.
// The epoch is persisted in <stateDir>/broker-epoch: a broker restart must
// never re-issue an old fence (a stale worker would otherwise commit over
// the new owner). Fences are monotonic within an epoch.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeMsgId, nowIso } from "../protocol/frames.js";
import { MAX_LEASE_TTL_MS, MIN_LEASE_TTL_MS } from "../shared/config.js";

export interface LeaseRecord {
  leaseId: string;
  task: string;
  owner: string;
  paths: string[];
  fence: number;
  epoch: number;
  grantedAt: string;
  expiresAt: string;
}

export type ClaimOutcome =
  | { status: "granted"; lease: LeaseRecord; reused: boolean }
  | { status: "held"; holder: string }
  | { status: "invalid"; reason: string };

export type ReleaseOutcome =
  | { status: "released"; lease: LeaseRecord }
  | { status: "not_held" };

/** Read the persisted broker epoch (0 if absent/corrupt). */
export function readEpoch(stateDirPath: string): number {
  try {
    const raw = readFileSync(join(stateDirPath, "broker-epoch"), "utf8").trim();
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** Bump the persisted epoch: max(previous + 1, now). A clock going backwards
 *  still yields a strictly increasing epoch, so old fences stay stale. */
export function nextEpoch(stateDirPath: string, now: number = Date.now()): number {
  const previous = readEpoch(stateDirPath);
  const next = Math.max(previous + 1, now);
  try {
    mkdirSync(stateDirPath, { recursive: true });
    writeFileSync(join(stateDirPath, "broker-epoch"), `${next}\n`, "utf8");
  } catch {
    // Persistence is best effort; the in-memory epoch still increases.
  }
  return next;
}

export class LeaseTable {
  private readonly byTask = new Map<string, LeaseRecord>();
  private counter = 0;

  constructor(
    readonly epoch: number,
    private readonly now: () => number = Date.now,
  ) {}

  private isLive(lease: LeaseRecord): boolean {
    return Date.parse(lease.expiresAt) > this.now();
  }

  private prune(): void {
    for (const [task, lease] of this.byTask) {
      if (!this.isLive(lease)) this.byTask.delete(task);
    }
  }

  get(task: string): LeaseRecord | undefined {
    const lease = this.byTask.get(task);
    if (lease === undefined) return undefined;
    if (!this.isLive(lease)) {
      this.byTask.delete(task);
      return undefined;
    }
    return lease;
  }

  claim(task: string, owner: string, paths: string[], ttlMs: number): ClaimOutcome {
    if (task.trim() === "") return { status: "invalid", reason: "task is required" };
    if (paths.length === 0) return { status: "invalid", reason: "paths is required" };
    if (!Number.isFinite(ttlMs) || ttlMs < MIN_LEASE_TTL_MS || ttlMs > MAX_LEASE_TTL_MS) {
      return { status: "invalid", reason: `ttlMs must be ${MIN_LEASE_TTL_MS}..${MAX_LEASE_TTL_MS}` };
    }
    this.prune();
    const existing = this.byTask.get(task);
    if (existing !== undefined) {
      if (existing.owner !== owner) return { status: "held", holder: existing.owner };
      return { status: "granted", lease: existing, reused: true };
    }
    const lease: LeaseRecord = {
      leaseId: makeMsgId(),
      task,
      owner,
      paths: [...paths],
      fence: ++this.counter,
      epoch: this.epoch,
      grantedAt: nowIso(),
      expiresAt: new Date(this.now() + ttlMs).toISOString(),
    };
    this.byTask.set(task, lease);
    return { status: "granted", lease, reused: false };
  }

  release(task: string, owner: string, leaseId: string): ReleaseOutcome {
    const lease = this.get(task);
    if (lease === undefined) return { status: "not_held" };
    if (lease.owner !== owner || lease.leaseId !== leaseId) return { status: "not_held" };
    this.byTask.delete(task);
    return { status: "released", lease };
  }

  snapshot(): LeaseRecord[] {
    this.prune();
    return [...this.byTask.values()].sort((a, b) => a.task.localeCompare(b.task));
  }

  /** Task 5 hook: is this epoch:fence the current holder for the task? */
  verify(task: string, owner: string, epoch: number, fence: number): boolean {
    const lease = this.get(task);
    return lease !== undefined && lease.owner === owner && lease.epoch === epoch && lease.fence === fence;
  }
}

/** Ensure the state dir exists before the broker writes the epoch file. */
export function ensureStateDir(stateDirPath: string): void {
  if (!existsSync(stateDirPath)) mkdirSync(stateDirPath, { recursive: true });
}
