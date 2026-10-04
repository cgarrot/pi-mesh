// cli/cmd/help.ts — usage + per-command help (exit 0 for --help).
import { say, dim, useColor } from "../out.js";
import { specUsage, type ArgSpec } from "../args.js";
import { CLI_PING_TIMEOUT_MS, CLI_SEND_TIMEOUT_MS, CLI_TAIL_BACKLOG_MAX_LINES, CLI_TAIL_LINES, CLI_WAIT_TIMEOUT_MS, DEFAULT_RESERVATION_TTL_MS } from "../../shared/config.js";

export const COMMANDS: readonly string[] = [
  "broker",
  "peers",
  "status",
  "stale",
  "send",
  "reply",
  "ping",
  "wait",
  "join",
  "leave",
  "reserve",
  "release",
  "ledger",
  "tail",
  "watch",
  "sessions",
  "attach",
  "config",
  "doctor",
  "help",
];

export const GENERAL_USAGE =
  "usage: mesh <command> [args]\n" +
  "commands: broker start|stop|status · peers · status [--reservations] · stale · send · reply · ping · wait · join · leave · reserve [--hold] · release · ledger · tail [-f] · watch · sessions · attach (standalone peer) · config show · doctor · help <command>";

interface CommandHelp {
  usage: string;
  specs?: ArgSpec[];
  notes?: string[];
}

const HELP: Record<string, CommandHelp> = {
  broker: {
    usage: "mesh broker start|stop|status",
    notes: [
      "start spawns the detached local broker (lockfile in $TMPDIR/mesh-<uid>).",
      "stop sends SIGTERM to the broker pid from the lock.",
      "status probes the socket and prints the lock pid.",
    ],
  },
  peers: {
    usage: "mesh peers [--room R]",
    specs: [{ name: "room", kind: "value", short: "R", meta: "ROOM", help: "restrict to one room" }],
    notes: ["Compact one-line snapshot (legacy format).", "Exit 1 when the broker is unreachable."],
  },
  status: {
    usage: "mesh status [room]",
    specs: [
      { name: "all", kind: "flag", help: "every peer of the mesh (all rooms)" },
      { name: "reservations", kind: "flag", help: "list reservations held by peers" },
      { name: "json", kind: "flag", help: "one NDJSON object" },
    ],
    notes: [
      "Markers: ● busy/working · ○ idle · ✕ blocked · ⛔ rate-limited · ⚠ version skew.",
      "via= shows remote peers (tcp/tls origin).",
      "`stale` is sugar for `status --reservations`.",
    ],
  },
  stale: {
    usage: "mesh stale",
    notes: ["Alias of `mesh status --reservations` — reservations held by peers, with age and TTL state."],
  },
  config: {
    usage: "mesh config show",
    notes: ["Resolved config (defaults < file < env) and paths. The token is masked (sha256 prefix)."],
  },
  ledger: {
    usage: "mesh ledger",
    specs: [
      { name: "limit", kind: "value", meta: "N", help: "max records (1..200)" },
      { name: "from", kind: "value", meta: "A", help: "sender filter" },
      { name: "to", kind: "value", meta: "A", help: "recipient filter" },
      { name: "room", kind: "value", short: "R", meta: "ROOM", help: "room filter" },
      { name: "event", kind: "value", meta: "E", help: "sent|delivered|reply|expired|blocked|…" },
      { name: "json", kind: "flag", help: "NDJSON output" },
    ],
    notes: ["Local hash-only ledger (bodies are never stored) — current file + rotations."],
  },
  send: {
    usage: "mesh send [alias] <text…>",
    specs: [
      { name: "room", kind: "value", short: "R", meta: "ROOM", help: "target room" },
      { name: "priority", kind: "value", meta: "P", help: "normal|urgent|force" },
      { name: "reason", kind: "value", meta: "R", help: "required for force (hashed, never persisted)" },
      { name: "interrupt", kind: "flag", help: "with force: abort the recipient's blocked turn (last resort)" },
      { name: "refs", kind: "value", meta: "A,B", help: "repo-relative refs (max 8)" },
      { name: "reply-to", kind: "value", meta: "A,B", help: "who receives the reply instead of you" },
      { name: "broadcast", kind: "flag", help: "fan out to the whole room (no alias)" },
      { name: "await", kind: "flag", help: "wait for an explicit reply" },
      { name: "launch", kind: "flag", help: "awaitReply, non-blocking (dies at exit)" },
      { name: "timeout", kind: "value", meta: "MS", help: `--await budget (default ${CLI_SEND_TIMEOUT_MS})` },
      { name: "alias", kind: "value", meta: "A", help: "strict alias (collision = exit 1)" },
      { name: "require-online", kind: "flag", help: "queued_offline exits 1 instead of 4" },
    ],
    notes: [
      "Exit codes: 0 delivered/reply · 1 blocked/error · 2 usage · 3 expired · 4 queued_offline/partial.",
      "A trailing `-` reads the body from stdin (1..32 KiB).",
      "Rate caps apply (broker: 30 msg/min, 15 urgent/min, 1 force/min).",
      "Ephemeral alias: the CLI is not a session and never emits read receipts.",
    ],
  },
  reply: {
    usage: "mesh reply <msgId> <text…>",
    specs: [
      { name: "to", kind: "value", meta: "A", help: "target member (one-shot has no inbox)" },
      { name: "room", kind: "value", short: "R", meta: "ROOM", help: "required" },
      { name: "reply-all", kind: "flag", help: "fan the answer out to the whole room" },
      { name: "refs", kind: "value", meta: "A,B", help: "repo-relative refs (max 8)" },
    ],
    notes: ["--room and exactly one of --to / --reply-all: a fresh process never saw the inbound frame."],
  },
  ping: {
    usage: "mesh ping <alias>",
    specs: [{ name: "timeout", kind: "value", meta: "MS", help: `budget (default ${CLI_PING_TIMEOUT_MS})` }],
    notes: ["Expired (exit 3) means no answer within the budget — never that the peer is down."],
  },
  wait: {
    usage: "mesh wait",
    specs: [{ name: "timeout", kind: "value", meta: "MS", help: `budget (default ${CLI_WAIT_TIMEOUT_MS})` }],
    notes: [
      "Honest limit: missions live in the LAUNCHING process — a fresh CLI has none.",
      "Scripted path: mesh send --await. Persistent missions: attach (Phase 5).",
    ],
  },
  join: {
    usage: "mesh join <room> [observer]",
    notes: ["Debug-only: the membership dies with this process (connection-scoped)."],
  },
  leave: {
    usage: "mesh leave <room>",
    notes: ["Debug-only: only rooms joined by THIS connection (see join)."],
  },
  reserve: {
    usage: "mesh reserve <path>… [--reason R] [--hold MS]",
    specs: [
      { name: "reason", kind: "value", meta: "R", help: "why (visible to peers)" },
      { name: "hold", kind: "value", meta: "MS", help: `keep the claim alive, 1000..${DEFAULT_RESERVATION_TTL_MS} ms (Ctrl-C releases)` },
    ],
    notes: [
      "Default = dry-run: claim, report conflicts (exit 4), release at exit.",
      "--hold keeps THIS process alive holding the claim (capped under the TTL).",
      "Reservations are connection-scoped: they die with the process.",
    ],
  },
  release: {
    usage: "mesh release [<pattern>…]",
    specs: [{ name: "all", kind: "flag", help: "release everything this process holds" }],
    notes: ["One-shot processes hold no claims — releases happen where you hold: `reserve --hold` + Ctrl-C, or attach."],
  },
  watch: {
    usage: "mesh watch [room]",
    specs: [
      { name: "alias", kind: "value", meta: "A", help: "strict alias (collision = exit 1)" },
      { name: "json", kind: "flag", help: "NDJSON frames (bodies redacted)" },
    ],
    notes: [
      "Joins the room as an OBSERVER (cannot send) and streams frames live.",
      "Bodies are NEVER shown — only bodyHash (text and --json alike).",
      "Ctrl-C stops (exit 0).",
    ],
  },
  sessions: {
    usage: "mesh sessions",
    specs: [{ name: "json", kind: "flag", help: "NDJSON identities" }],
    notes: [
      "Persisted identities (identity-<sessionId>.json) in the CURRENT stateDir — adoption targets for attach.",
      "Scope: <cwd>/.mesh or MESH_STATE_DIR only (same scope as ledger/tail).",
      "Read-only: the CLI never creates or deletes identity files.",
    ],
  },
  attach: {
    usage: "mesh attach [alias]",
    specs: [
      { name: "session", kind: "value", meta: "ID", help: "adopt a persisted session identity" },
      { name: "room", kind: "value", short: "R", meta: "ROOM", help: "join this room first" },
      { name: "json", kind: "flag", help: "script mode: NDJSON stdin commands / stdout events" },
      { name: "no-read", kind: "flag", help: "never emit read receipts" },
    ],
    notes: [
      "Standalone peer: a full mesh member with NO session behind it.",
      "Receives messages WITH bodies (it is the recipient), sends/replies/reserves from a REPL.",
      "attach <alias> adopts a dead session's identity (rooms + reservations + mailbox).",
      "Read receipts: interactive TTY only, at render time (--json/pipe never reads).",
      "No activity announcements — peers see the idle heuristic.",
    ],
  },
  tail: {
    usage: "mesh tail [-f]",
    specs: [
      { name: "follow", kind: "flag", short: "f", help: "stream new records until Ctrl-C" },
      { name: "limit", kind: "value", meta: "N", help: `backlog lines first (default ${CLI_TAIL_LINES}, max ${CLI_TAIL_BACKLOG_MAX_LINES})` },
    ],
    notes: [
      `Without -f: last ${CLI_TAIL_LINES} lines. With -f: backlog then stream (rotation-safe).`,
      "Bodies are never present in the ledger (hash-only).",
    ],
  },
  doctor: {
    usage: "mesh doctor",
    notes: ["Socket reachable? lock stale? config path? protocol version?", "Exit 1 when the broker is unreachable."],
  },
  help: {
    usage: "mesh help [command]",
    notes: [
      "Show general usage or one command's options.",
      "Option syntax: --opt value, --opt=value, -o value; attached short forms (-Rops) are not supported.",
    ],
  },
};

export function printGeneralUsage(): void {
  say(GENERAL_USAGE);
}

export function printCommandHelp(cmd: string): boolean {
  const h = HELP[cmd];
  if (h === undefined) return false;
  const color = useColor();
  say(`usage: ${h.usage}`);
  if (h.specs !== undefined && h.specs.length > 0) say(`options: ${specUsage(h.specs)}`);
  for (const n of h.notes ?? []) say(dim(`  ${n}`, color));
  return true;
}
