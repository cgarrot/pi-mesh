// extension/ledger.ts — hash-only append-only ledger <stateDir>/ledger.jsonl.
// body-free durable: never a message body, only hashes + metadata.
// fix: callers write `delivered` ONLY after the broker ack (enforced by wiring).
// recursive forbidden-key scan before EVERY append → throw fail-closed.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { hasForbiddenPersistedKey } from "../protocol/envelope.js";
import { nowIso } from "../protocol/frames.js";
import { DEFAULT_LEDGER_MAX_BYTES } from "../shared/config.js";
import { LEDGER_FILE_NAME } from "../shared/paths.js";

export const LEDGER_SCHEMA = "mesh.ledger.v1";

export type LedgerEventName =
  | "sent"
  | "delivered"
  | "queued_offline"
  | "reply"
  | "expired"
  | "blocked"
  | "error"
  | "inbound"
  | "reserved"
  | "released"
  | "dropped_offline"
  | "ctl";

export interface LedgerRecord {
  schema: typeof LEDGER_SCHEMA;
  event: LedgerEventName;
  id?: string;
  from?: string;
  to?: string;
  room?: string;
  priority?: string;
  bodyHash?: string;
  reasonHash?: string;
  refs?: string[];
  code?: string;
  /** C: control action / opaque target (never a body). */
  action?: string;
  target?: string;
  ts: string;
  bodyStored: false;
}

/** Fields the caller supplies; schema/ts/bodyStored are stamped by the ledger. */
export type LedgerInput = Omit<LedgerRecord, "schema" | "ts" | "bodyStored">;

export class MeshLedger {
  constructor(
    readonly stateDir: string,
    private readonly maxBytes: number = DEFAULT_LEDGER_MAX_BYTES,
  ) {}

  get path(): string {
    return path.join(this.stateDir, LEDGER_FILE_NAME);
  }

  /**
  * Append one record. Fail-closed: recursive scan of forbidden persisted
  * keys BEFORE writing — a violation throws and zero bytes are appended.
  */
  append(input: LedgerInput): LedgerRecord {
    const record: LedgerRecord = {
      schema: LEDGER_SCHEMA,
      ...input,
      ts: nowIso(),
      bodyStored: false,
    };
    if (hasForbiddenPersistedKey(record)) {
      throw new Error("mesh ledger fail-closed: forbidden persisted key (E25)");
    }
    mkdirSync(this.stateDir, { recursive: true });
    this.rotateIfNeeded();
    appendFileSync(this.path, JSON.stringify(record) + "\n", "utf8");
    return record;
  }

  /**
  * read the last `limit` records, optionally filtered (hash-only — the
  * ledger never contains bodies,. For agents: durable mesh history.
  */
  read(limit: number = 20, filter?: { from?: string; to?: string; room?: string; event?: string }): LedgerRecord[] {
    let content: string;
    try {
      content = readFileSync(this.path, "utf8");
    } catch {
      return [];
    }
    const out: LedgerRecord[] = [];
    for (const line of content.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const r = JSON.parse(line) as LedgerRecord;
        if (r.schema !== LEDGER_SCHEMA) continue;
        if (filter?.from !== undefined && r.from !== filter.from) continue;
        if (filter?.to !== undefined && r.to !== filter.to) continue;
        if (filter?.room !== undefined && r.room !== filter.room) continue;
        if (filter?.event !== undefined && r.event !== filter.event) continue;
        out.push(r);
      } catch {
  // skip malformed
      }
    }
    return out.slice(-limit);
  }

  /** Simple rotation: when ledger.jsonl exceeds maxBytes → ledger-<date>.jsonl.1. */
  private rotateIfNeeded(): void {
    let size = 0;
    try {
      size = statSync(this.path).size;
    } catch {
      return; // no file yet
    }
    if (size <= this.maxBytes) return;
    const date = new Date().toISOString().slice(0, 10);
  // ledger-<date>.jsonl.N — N increments so repeated rotations never overwrite
    let n = 1;
    while (existsSync(path.join(this.stateDir, `ledger-${date}.jsonl.${n}`))) n += 1;
    renameSync(this.path, path.join(this.stateDir, `ledger-${date}.jsonl.${n}`));
  }
}
