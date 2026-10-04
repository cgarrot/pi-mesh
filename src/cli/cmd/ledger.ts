// cli/cmd/ledger.ts — mesh tail + mesh ledger: read the LOCAL hash-only
// ledger (current file + rotations, oldest first). The ledger never stores
// bodies (fail-closed at write time), so there is nothing to redact here.
// The record shape is declared locally (structural): importing the
// extension's LedgerRecord would cross the layer boundary (V4).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { say, sayErr, jsonLine } from "../out.js";
import { EXIT_OK, EXIT_USAGE } from "../codes.js";
import { CLI_LEDGER_MAX_LIMIT, CLI_TAIL_LINES } from "../../shared/config.js";
import { LEDGER_FILE_NAME, ledgerPath, stateDir } from "../../shared/paths.js";

interface LedgerLine {
  event?: string;
  from?: string;
  to?: string;
  room?: string;
  ts?: string;
  [key: string]: unknown;
}

export interface LedgerFilters {
  limit: number;
  from?: string;
  to?: string;
  room?: string;
  event?: string;
}

/** Every ledger file (rotations first — oldest to newest — then current).
 * Natural sort on the trailing .N: lexicographic would put .10 before .2. */
function ledgerFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    for (const name of readdirSync(dir)) {
      if (/^ledger-\d{4}-\d{2}-\d{2}\.jsonl(\.\d+)?$/.test(name)) files.push(path.join(dir, name));
    }
  } catch {
    // state dir absent — only the current file may still exist
  }
  files.sort((a, b) => {
    const na = Number(/\.(\d+)$/.exec(a)?.[1] ?? "-1");
    const nb = Number(/\.(\d+)$/.exec(b)?.[1] ?? "-1");
    if (na !== nb) return na - nb;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const current = ledgerPath(dir);
  if (existsSync(current)) files.push(current);
  return files;
}

function readLines(files: string[]): LedgerLine[] {
  const lines: LedgerLine[] = [];
  for (const f of files) {
    try {
      for (const line of readFileSync(f, "utf8").split("\n")) {
        const t = line.trim();
        if (t === "") continue;
        try {
          lines.push(JSON.parse(t) as LedgerLine);
        } catch {
          // torn write at the tail of a file — skip, never crash
        }
      }
    } catch {
      // unreadable file — skip
    }
  }
  return lines;
}

function matches(l: LedgerLine, f: LedgerFilters): boolean {
  if (f.from !== undefined && l.from !== f.from) return false;
  if (f.to !== undefined && l.to !== f.to) return false;
  if (f.room !== undefined && l.room !== f.room) return false;
  if (f.event !== undefined && l.event !== f.event) return false;
  return true;
}

/** mesh tail: last N lines of the ledger (no follow — that is `tail -f`). */
export async function cmdTail(limitRaw: string | undefined): Promise<number> {
  let limit = CLI_TAIL_LINES;
  if (limitRaw !== undefined) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1 || n > CLI_LEDGER_MAX_LIMIT) {
      sayErr(`invalid --limit "${limitRaw}" (1..${CLI_LEDGER_MAX_LIMIT})`);
      return EXIT_USAGE;
    }
    limit = n;
  }
  const files = ledgerFiles(stateDir());
  if (files.length === 0) {
    say("(no ledger)");
    return EXIT_OK;
  }
  const lines = readLines(files).slice(-limit);
  if (lines.length === 0) say("(no ledger)");
  for (const l of lines) say(JSON.stringify(l));
  return EXIT_OK;
}

/** mesh ledger: filtered history over current + rotated files. */
export async function cmdLedger(filters: LedgerFilters, asJson: boolean): Promise<number> {
  if (filters.limit < 1 || filters.limit > CLI_LEDGER_MAX_LIMIT || !Number.isInteger(filters.limit)) {
    sayErr(`invalid --limit (1..${CLI_LEDGER_MAX_LIMIT})`);
    return EXIT_USAGE;
  }
  const files = ledgerFiles(stateDir());
  const all = readLines(files).filter((l) => matches(l, filters));
  const selected = all.slice(-filters.limit);
  if (selected.length === 0) {
    if (asJson) return EXIT_OK; // no lines, no output — scripts prefer silence
    say("(no matching ledger records)");
    return EXIT_OK;
  }
  for (const l of selected) {
    if (asJson) jsonLine(l);
    else say(JSON.stringify(l));
  }
  return EXIT_OK;
}

export const LEDGER_USAGE = "usage: mesh ledger [--limit N] [--from A] [--to A] [--room R] [--event E] [--json]";
