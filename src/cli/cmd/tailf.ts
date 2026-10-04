// cli/cmd/tailf.ts — `mesh tail -f`: follow the local hash-only ledger.
// Rotation-safe: the watcher targets the STATE DIR, not the file (a rotation
// renames ledger.jsonl → ledger-<date>.jsonl.N and a fresh file appears).
// Torn lines (a write half-done at read time) are CARRIED: the trailing
// fragment without \n is kept and prefixed to the next read, so no record
// is ever lost to a read/write race.
import { existsSync, readFileSync, watch } from "node:fs";
import { say } from "../out.js";
import { EXIT_OK, EXIT_USAGE } from "../codes.js";
import { sayErr } from "../out.js";
import { CLI_TAIL_BACKLOG_MAX_LINES, CLI_TAIL_LINES } from "../../shared/config.js";
import { LEDGER_FILE_NAME, ledgerPath, stateDir } from "../../shared/paths.js";

interface LedgerLine {
  event?: string;
  ts?: string;
  [key: string]: unknown;
}

/** Parse complete NDJSON lines; return records + the trailing carry. */
function parseLines(text: string, carry = ""): { records: LedgerLine[]; carry: string } {
  const records: LedgerLine[] = [];
  const joined = carry + text;
  const parts = joined.split("\n");
  const nextCarry = (parts.pop() ?? ""); // no trailing \n → partial line
  for (const line of parts) {
    const t = line.trim();
    if (t === "") continue;
    try {
      records.push(JSON.parse(t) as LedgerLine);
    } catch {
      // genuinely malformed COMPLETE line — skip (torn tails are carried)
    }
  }
  return { records, carry: nextCarry };
}

export const TAILF_USAGE = "usage: mesh tail -f [--limit N]";

/** Follow the ledger: print the last `limit` lines, then stream new ones
 * until SIGINT. Bodies are never present in the ledger (hash-only). */
export async function cmdTailFollow(limitRaw: string | undefined): Promise<number> {
  let limit = CLI_TAIL_LINES;
  if (limitRaw !== undefined) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1 || n > CLI_TAIL_BACKLOG_MAX_LINES) {
      sayErr(`invalid --limit "${limitRaw}" (1..${CLI_TAIL_BACKLOG_MAX_LINES})`);
      return EXIT_USAGE;
    }
    limit = n;
  }
  const dir = stateDir();
  const file = ledgerPath(dir);

  let offset = 0;
  let carry = "";
  let backlog: string[] = [];
  if (existsSync(file)) {
    const buf = readFileSync(file);
    offset = buf.byteLength;
    const parsed = parseLines(buf.toString("utf8"));
    // keep the trailing fragment as carry too — a broker mid-write at
    // startup would otherwise lose that half line forever (same race the
    // streaming path carries)
    carry = parsed.carry;
    backlog = parsed.records.slice(-limit).map((l) => JSON.stringify(l));
  }
  for (const l of backlog) say(l);
  if (!existsSync(file)) say(`(waiting for ${LEDGER_FILE_NAME} in ${dir})`);

  return await new Promise<number>((resolve) => {
    let debounce: NodeJS.Timeout | undefined;
    const readNew = (): void => {
      clearTimeout(debounce);
      // coalesce bursts: one read per event-loop turn max
      debounce = setTimeout(() => {
        try {
          if (!existsSync(file)) return; // rotated away — next event reopens
          const buf = readFileSync(file); // Buffer: byte-exact offsets
          if (buf.byteLength < offset) {
            offset = 0; // truncated/replaced — reread everything
            carry = "";
          }
          if (buf.byteLength === offset) return;
          const addedText = buf.subarray(offset).toString("utf8");
          offset = buf.byteLength;
          const parsed = parseLines(addedText, carry);
          carry = parsed.carry;
          for (const l of parsed.records) say(JSON.stringify(l));
        } catch {
          // vanished mid-read — the next watch event retries
        }
      }, 50);
      debounce.unref?.();
    };

    let watcher: ReturnType<typeof watch> | null = null;
    try {
      watcher = watch(dir, (_event, filename) => {
        if (filename === undefined || String(filename).startsWith("ledger")) readNew();
      });
      // async watcher errors (dir removed, EMFILE…) must never crash the
      // process — report honestly and stop following.
      watcher.on("error", (err: Error) => {
        say(`(watch error: ${err.message} — stopping)`);
        clearTimeout(debounce);
        resolve(EXIT_OK);
      });
    } catch {
      say(`(cannot watch ${dir} — stopping)`);
      resolve(EXIT_OK);
      return;
    }

    const stop = (): void => {
      watcher?.close();
      clearTimeout(debounce);
      resolve(EXIT_OK); // SIGINT is the agreed way out — success, not failure
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
