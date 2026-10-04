#!/usr/bin/env node
// cli/mesh.ts — debug/admin CLI entrypoint (exposed as the `pimesh` bin by
// package.json — npm sets the executable bit at install). Pure dispatcher:
// every command lives in cmd/ and talks to the mesh through MeshClient
// (never the broker internals). Ephemeral clients: alias cli-<rand6>.
import { parseArgs, type ArgSpec } from "./args.js";
import { sayErr } from "./out.js";
import { setColorOverride } from "./out.js";
import { EXIT_USAGE } from "./codes.js";
import { CLI_LEDGER_DEFAULT_LIMIT, CLI_LEDGER_MAX_LIMIT } from "../shared/config.js";
import { validateAlias, validateRoom } from "./validate.js";
import { cmdBroker } from "./cmd/broker.js";
import { cmdPeers } from "./cmd/peers.js";
import { cmdSend, parseSendArgs, readStdinBody, SEND_USAGE, type SendArgs } from "./cmd/send.js";
import { cmdReply, REPLY_USAGE } from "./cmd/reply.js";
import { cmdPing, PING_USAGE } from "./cmd/ping.js";
import { cmdWait, WAIT_USAGE } from "./cmd/wait.js";
import { cmdLedger, LEDGER_USAGE } from "./cmd/ledger.js";
import { cmdTailFollow, TAILF_USAGE } from "./cmd/tailf.js";
import { cmdStatus, STATUS_USAGE } from "./cmd/status.js";
import { cmdConfigShow, CONFIG_USAGE } from "./cmd/configshow.js";
import { cmdRoom } from "./cmd/rooms.js";
import { cmdReserve, cmdRelease, RESERVE_USAGE, RELEASE_USAGE } from "./cmd/reserve.js";
import { cmdWatch, WATCH_USAGE } from "./cmd/watch.js";
import { cmdSessions, SESSIONS_USAGE } from "./cmd/sessions.js";
import { cmdAttach, ATTACH_USAGE } from "./cmd/attach.js";
import { cmdTail } from "./cmd/ledger.js";
import { cmdDoctor } from "./cmd/doctor.js";
import { GENERAL_USAGE, printCommandHelp, printGeneralUsage } from "./cmd/help.js";

const SEND_SPECS: ArgSpec[] = [
  { name: "room", kind: "value", short: "R", meta: "ROOM" },
  { name: "priority", kind: "value", meta: "P", help: "normal|urgent|force" },
  { name: "reason", kind: "value", meta: "R", help: "required for force" },
  { name: "interrupt", kind: "flag", help: "with force: abort the recipient's blocked turn (last resort)" },
  { name: "refs", kind: "value", meta: "A,B", help: "repo-relative refs (max 8)" },
  { name: "reply-to", kind: "value", meta: "A,B", help: "who receives the reply (max 8)" },
  { name: "broadcast", kind: "flag", help: "fan out to the whole room (no alias)" },
  { name: "await", kind: "flag", help: "wait for an explicit reply" },
  { name: "launch", kind: "flag", help: "awaitReply without blocking (dies at exit)" },
  { name: "timeout", kind: "value", meta: "MS" },
  { name: "alias", kind: "value", meta: "A", help: "strict alias for this invocation" },
  { name: "require-online", kind: "flag", help: "queued_offline exits 1 instead of 4" },
];

const PEERS_SPECS: ArgSpec[] = [{ name: "room", kind: "value", short: "R", meta: "ROOM" }];

const JOIN_SPECS: ArgSpec[] = [{ name: "observer", kind: "flag" }];

// leave takes NO options (observer is join-only) — a --observer on leave
// is an unknown-option usage error, never silently ignored.
const LEAVE_SPECS: ArgSpec[] = [];

const RESERVE_SPECS: ArgSpec[] = [
  { name: "reason", kind: "value", meta: "R", help: "why (visible to peers)" },
  { name: "hold", kind: "value", meta: "MS", help: "keep the claim alive (Ctrl-C releases)" },
];

const RELEASE_SPECS: ArgSpec[] = [{ name: "all", kind: "flag", help: "release everything this process holds" }];

const WATCH_SPECS: ArgSpec[] = [
  { name: "alias", kind: "value", meta: "A", help: "strict alias (collision = exit 1)" },
  { name: "json", kind: "flag", help: "NDJSON frames (bodies redacted)" },
];

const SESSIONS_SPECS: ArgSpec[] = [{ name: "json", kind: "flag", help: "NDJSON identities" }];

const ATTACH_SPECS: ArgSpec[] = [
  { name: "session", kind: "value", meta: "ID", help: "adopt a persisted session identity" },
  { name: "room", kind: "value", short: "R", meta: "ROOM", help: "join this room first" },
  { name: "json", kind: "flag", help: "script mode: NDJSON stdin commands / stdout events" },
  { name: "no-read", kind: "flag", help: "never emit read receipts" },
];

const REPLY_SPECS: ArgSpec[] = [
  { name: "to", kind: "value", meta: "A", help: "target member (one-shot has no inbox)" },
  { name: "room", kind: "value", short: "R", meta: "ROOM", help: "required (with --to or --reply-all)" },
  { name: "reply-all", kind: "flag", help: "fan the answer out to the whole room" },
  { name: "refs", kind: "value", meta: "A,B", help: "repo-relative refs (max 8)" },
];

const PING_SPECS: ArgSpec[] = [{ name: "timeout", kind: "value", meta: "MS" }];

const WAIT_SPECS: ArgSpec[] = [{ name: "timeout", kind: "value", meta: "MS" }];

const PEERS_SPECS_STATUS: ArgSpec[] = [
  { name: "all", kind: "flag", help: "every peer of the mesh (all rooms)" },
  { name: "reservations", kind: "flag", help: "list reservations held by peers" },
  { name: "json", kind: "flag", help: "one NDJSON object" },
];

const LEDGER_SPECS: ArgSpec[] = [
  { name: "limit", kind: "value", meta: "N", help: "max records (1..200)" },
  { name: "from", kind: "value", meta: "A", help: "sender filter" },
  { name: "to", kind: "value", meta: "A", help: "recipient filter" },
  { name: "room", kind: "value", short: "R", meta: "ROOM", help: "room filter" },
  { name: "event", kind: "value", meta: "E", help: "event filter (sent|delivered|reply|…)" },
  { name: "json", kind: "flag", help: "NDJSON output" },
];

const TAIL_SPECS: ArgSpec[] = [
  { name: "follow", kind: "flag", short: "f", help: "stream new records until Ctrl-C" },
  { name: "limit", kind: "value", meta: "N", help: "backlog lines first" },
];

export async function main(argv: string[]): Promise<number> {
  // --no-color is global: strip it once, before any command parsing, and
  // force colors off for the whole run (pipes/NO_COLOR already do).
  const stripped: string[] = [];
  for (const a of argv) {
    if (a === "--no-color") setColorOverride(false);
    else stripped.push(a);
  }
  const [cmd, ...rest] = stripped;
  if (cmd === undefined || cmd === "--help" || cmd === "-h") {
    if (cmd === undefined) sayErr(GENERAL_USAGE);
    else printGeneralUsage();
    return cmd === undefined ? EXIT_USAGE : 0;
  }
  if (cmd === "help") {
    const topic = rest[0];
    if (topic === undefined) {
      printGeneralUsage();
      return 0;
    }
    if (!printCommandHelp(topic)) {
      sayErr(`unknown command: ${topic}`);
      sayErr(GENERAL_USAGE);
      return EXIT_USAGE;
    }
    return 0;
  }

  switch (cmd) {
    case "sessions": {
      const r = parseArgs(rest, SESSIONS_SPECS);
      if (!r.ok) {
        sayErr(`${r.error}`);
        sayErr(SESSIONS_USAGE);
        return EXIT_USAGE;
      }
      if (r.help) {
        printCommandHelp("sessions");
        return 0;
      }
      if (r.parsed.positionals.length > 0) {
        sayErr(`unexpected argument: ${r.parsed.positionals[0]}`);
        return EXIT_USAGE;
      }
      return cmdSessions(r.parsed.flags.has("json"));
    }
    case "attach": {
      const r = parseArgs(rest, ATTACH_SPECS);
      if (!r.ok) {
        sayErr(`${r.error}`);
        sayErr(ATTACH_USAGE);
        return EXIT_USAGE;
      }
      if (r.help) {
        printCommandHelp("attach");
        return 0;
      }
      if (r.parsed.positionals.length > 1) {
        sayErr(`unexpected argument: ${r.parsed.positionals[1]}`);
        return EXIT_USAGE;
      }
      const alias = r.parsed.positionals[0];
      if (alias !== undefined) {
        const v = validateAlias(alias.replace(/^@/, "").toLowerCase());
        if (!v.ok) {
          sayErr(v.error);
          return EXIT_USAGE;
        }
      }
      const room = r.parsed.values.get("room");
      if (room !== undefined) {
        const v = validateRoom(room);
        if (!v.ok) {
          sayErr(v.error);
          return EXIT_USAGE;
        }
      }
      const session = r.parsed.values.get("session");
      if (session !== undefined && alias !== undefined) {
        sayErr("--session and a positional alias are mutually exclusive");
        return EXIT_USAGE;
      }
      return cmdAttach({
        alias: alias?.replace(/^@/, "").toLowerCase(),
        sessionId: session,
        room,
        asJson: r.parsed.flags.has("json"),
        noRead: r.parsed.flags.has("no-read"),
      });
    }
    case "broker": {
      if (rest[0] === "--help" || rest[0] === "-h") {
        printCommandHelp("broker");
        return 0;
      }
      return cmdBroker(rest[0]);
    }
    case "peers": {
      const r = parseArgs(rest, PEERS_SPECS);
      if (!r.ok) {
        sayErr(`${r.error}`);
        return EXIT_USAGE;
      }
      if (r.help) {
        printCommandHelp("peers");
        return 0;
      }
      // Phase 1 validation table: refuse loudly BEFORE any network touch.
      const room = r.parsed.values.get("room");
      if (room !== undefined) {
        const v = validateRoom(room);
        if (!v.ok) {
          sayErr(v.error);
          return EXIT_USAGE;
        }
      }
      return cmdPeers(room);
    }
    case "status":
    case "stale": {
      const r = parseArgs(rest, PEERS_SPECS_STATUS);
      if (!r.ok) {
        sayErr(`${r.error}`);
        sayErr(STATUS_USAGE);
        return EXIT_USAGE;
      }
      if (r.help) {
        printCommandHelp("status");
        return 0;
      }
      if (r.parsed.positionals.length > 1) {
        sayErr(`unexpected argument: ${r.parsed.positionals[1]}`);
        return EXIT_USAGE;
      }
      const room = r.parsed.positionals[0] ?? r.parsed.values.get("room");
      if (room !== undefined) {
        const v = validateRoom(room);
        if (!v.ok) {
          sayErr(v.error);
          return EXIT_USAGE;
        }
      }
      // `stale` is sugar for `status --reservations` (fusion, plan §2.2)
      return cmdStatus({
        room,
        all: r.parsed.flags.has("all"),
        reservations: cmd === "stale" || r.parsed.flags.has("reservations"),
        json: r.parsed.flags.has("json"),
      });
    }
    case "config": {
      if (rest[0] === "show" || rest.length === 0) {
        if (rest[0] === "--help" || rest[0] === "-h") {
          printCommandHelp("config");
          return 0;
        }
        if (rest.length > 1) {
          sayErr(`unexpected argument: ${rest[1]}`);
          return EXIT_USAGE;
        }
        return cmdConfigShow();
      }
      sayErr(`unknown config subcommand: ${rest[0]}`);
      sayErr(CONFIG_USAGE);
      return EXIT_USAGE;
    }
    case "ledger": {
      const r = parseArgs(rest, LEDGER_SPECS);
      if (!r.ok) {
        sayErr(`${r.error}`);
        sayErr(LEDGER_USAGE);
        return EXIT_USAGE;
      }
      if (r.help) {
        printCommandHelp("ledger");
        return 0;
      }
      if (r.parsed.positionals.length > 0) {
        sayErr(`unexpected argument: ${r.parsed.positionals[0]}`);
        return EXIT_USAGE;
      }
      const room = r.parsed.values.get("room");
      if (room !== undefined) {
        const v = validateRoom(room);
        if (!v.ok) {
          sayErr(v.error);
          return EXIT_USAGE;
        }
      }
      const limitRaw = r.parsed.values.get("limit");
      let limit = CLI_LEDGER_DEFAULT_LIMIT;
      if (limitRaw !== undefined) {
        const n = Number(limitRaw);
        if (!Number.isInteger(n) || n < 1 || n > CLI_LEDGER_MAX_LIMIT) {
          sayErr(`invalid --limit "${limitRaw}" (1..${CLI_LEDGER_MAX_LIMIT})`);
          return EXIT_USAGE;
        }
        limit = n;
      }
      const norm = (a: string | undefined): string | undefined =>
        a !== undefined ? a.trim().replace(/^@/, "").toLowerCase() : undefined;
      return cmdLedger(
        { limit, from: norm(r.parsed.values.get("from")), to: norm(r.parsed.values.get("to")), room, event: r.parsed.values.get("event") },
        r.parsed.flags.has("json"),
      );
    }
    case "send": {
      const r = parseArgs(rest, SEND_SPECS);
      if (!r.ok) {
        sayErr(`${r.error}`);
        sayErr(SEND_USAGE);
        return EXIT_USAGE;
      }
      if (r.help) {
        printCommandHelp("send");
        return 0;
      }
      // `-` as the LAST positional = the message body comes from stdin
      let positionals = r.parsed.positionals;
      if (positionals.length > 0 && positionals[positionals.length - 1] === "-") {
        const stdinBody = await readStdinBody();
        positionals = [...positionals.slice(0, -1), stdinBody.trim()];
      }
      const parsed: { ok: true; args: SendArgs } | { ok: false; error: string } = parseSendArgs(positionals, {
        room: r.parsed.values.get("room"),
        priority: r.parsed.values.get("priority"),
        reason: r.parsed.values.get("reason"),
        refsCsv: r.parsed.values.get("refs"),
        replyToCsv: r.parsed.values.get("reply-to"),
        broadcast: r.parsed.flags.has("broadcast"),
        interrupt: r.parsed.flags.has("interrupt"),
        awaitReply: r.parsed.flags.has("await"),
        launch: r.parsed.flags.has("launch"),
        timeoutMs: r.parsed.values.get("timeout"),
        alias: r.parsed.values.get("alias"),
        requireOnline: r.parsed.flags.has("require-online"),
      });
      if (!parsed.ok) {
        sayErr(parsed.error);
        return EXIT_USAGE;
      }
      // Phase 1 validation table: room refused BEFORE connecting (alias,
      // priority, refs… are validated inside cmdSend — same contract).
      if (parsed.args.room !== undefined) {
        const roomV = validateRoom(parsed.args.room);
        if (!roomV.ok) {
          sayErr(roomV.error);
          return EXIT_USAGE;
        }
      }
      return cmdSend(parsed.args);
    }
    case "join": {
      const r = parseArgs(rest, JOIN_SPECS);
      if (!r.ok) {
        sayErr(`${r.error}`);
        return EXIT_USAGE;
      }
      if (r.help) {
        printCommandHelp("join");
        return 0;
      }
      const room = r.parsed.positionals[0];
      // strictness: exactly <room> [observer] — extra positionals are typos
      const extra = r.parsed.positionals.slice(1).filter((p) => p !== "observer");
      if (extra.length > 0) {
        sayErr(`unexpected argument: ${extra[0]}`);
        return EXIT_USAGE;
      }
      if (room !== undefined) {
        const v = validateRoom(room);
        if (!v.ok) {
          sayErr(v.error);
          return EXIT_USAGE;
        }
      }
      const observer = r.parsed.flags.has("observer") || r.parsed.positionals.includes("observer");
      return cmdRoom(room, "join", observer);
    }
    case "leave": {
      const r = parseArgs(rest, LEAVE_SPECS);
      if (!r.ok) {
        sayErr(`${r.error}`);
        return EXIT_USAGE;
      }
      if (r.help) {
        printCommandHelp("leave");
        return 0;
      }
      const room = r.parsed.positionals[0];
      if (r.parsed.positionals.length > 1) {
        sayErr(`unexpected argument: ${r.parsed.positionals[1]}`);
        return EXIT_USAGE;
      }
      if (room !== undefined) {
        const v = validateRoom(room);
        if (!v.ok) {
          sayErr(v.error);
          return EXIT_USAGE;
        }
      }
      return cmdRoom(room, "leave", false);
    }
    case "reply": {
      const r = parseArgs(rest, REPLY_SPECS);
      if (!r.ok) {
        sayErr(`${r.error}`);
        sayErr(REPLY_USAGE);
        return EXIT_USAGE;
      }
      if (r.help) {
        printCommandHelp("reply");
        return 0;
      }
      const [msgId, ...textParts] = r.parsed.positionals;
      const text = textParts.join(" ");
      if (msgId === undefined || text === "") {
        sayErr(REPLY_USAGE);
        return EXIT_USAGE;
      }
      // mirror of the send path: room refused BEFORE any network touch
      const replyRoom = r.parsed.values.get("room");
      if (replyRoom !== undefined) {
        const v = validateRoom(replyRoom);
        if (!v.ok) {
          sayErr(v.error);
          return EXIT_USAGE;
        }
      }
      return cmdReply({
        msgId,
        text,
        to: r.parsed.values.get("to"),
        room: replyRoom,
        refsCsv: r.parsed.values.get("refs"),
        replyAll: r.parsed.flags.has("reply-all"),
      });
    }
    case "ping": {
      const r = parseArgs(rest, PING_SPECS);
      if (!r.ok) {
        sayErr(`${r.error}`);
        sayErr(PING_USAGE);
        return EXIT_USAGE;
      }
      if (r.help) {
        printCommandHelp("ping");
        return 0;
      }
      const alias = r.parsed.positionals[0];
      if (alias === undefined || r.parsed.positionals.length > 1) {
        sayErr(PING_USAGE);
        return EXIT_USAGE;
      }
      return cmdPing(alias, r.parsed.values.get("timeout"));
    }
    case "wait": {
      const r = parseArgs(rest, WAIT_SPECS);
      if (!r.ok) {
        sayErr(`${r.error}`);
        sayErr(WAIT_USAGE);
        return EXIT_USAGE;
      }
      if (r.help) {
        printCommandHelp("wait");
        return 0;
      }
      if (r.parsed.positionals.length > 0) {
        sayErr(`unexpected argument: ${r.parsed.positionals[0]}`);
        return EXIT_USAGE;
      }
      return cmdWait(r.parsed.values.get("timeout"));
    }
    case "reserve": {
      const r = parseArgs(rest, RESERVE_SPECS);
      if (!r.ok) {
        sayErr(`${r.error}`);
        sayErr(RESERVE_USAGE);
        return EXIT_USAGE;
      }
      if (r.help) {
        printCommandHelp("reserve");
        return 0;
      }
      const holdRaw = r.parsed.values.get("hold");
      let holdMs: number | undefined;
      if (holdRaw !== undefined) {
        const n = Number(holdRaw);
        holdMs = Number.isFinite(n) ? Math.round(n) : Number.NaN;
      }
      return cmdReserve({ paths: r.parsed.positionals, reason: r.parsed.values.get("reason"), holdMs });
    }
    case "release": {
      const r = parseArgs(rest, RELEASE_SPECS);
      if (!r.ok) {
        sayErr(`${r.error}`);
        sayErr(RELEASE_USAGE);
        return EXIT_USAGE;
      }
      if (r.help) {
        printCommandHelp("release");
        return 0;
      }
      return cmdRelease(r.parsed.positionals, r.parsed.flags.has("all"));
    }
    case "watch": {
      const r = parseArgs(rest, WATCH_SPECS);
      if (!r.ok) {
        sayErr(`${r.error}`);
        sayErr(WATCH_USAGE);
        return EXIT_USAGE;
      }
      if (r.help) {
        printCommandHelp("watch");
        return 0;
      }
      if (r.parsed.positionals.length > 1) {
        sayErr(`unexpected argument: ${r.parsed.positionals[1]}`);
        return EXIT_USAGE;
      }
      const room = r.parsed.positionals[0];
      if (room !== undefined) {
        const v = validateRoom(room);
        if (!v.ok) {
          sayErr(v.error);
          return EXIT_USAGE;
        }
      }
      const alias = r.parsed.values.get("alias");
      if (alias !== undefined) {
        const v = validateAlias(alias.replace(/^@/, "").toLowerCase());
        if (!v.ok) {
          sayErr(v.error);
          return EXIT_USAGE;
        }
      }
      return cmdWatch({ room, alias: alias?.replace(/^@/, "").toLowerCase(), asJson: r.parsed.flags.has("json") });
    }
    case "tail": {
      const r = parseArgs(rest, TAIL_SPECS);
      if (!r.ok) {
        sayErr(`${r.error}`);
        sayErr(TAILF_USAGE);
        return EXIT_USAGE;
      }
      if (r.help) {
        printCommandHelp("tail");
        return 0;
      }
      if (r.parsed.positionals.length > 0) {
        sayErr(`unexpected argument: ${r.parsed.positionals[0]}`);
        return EXIT_USAGE;
      }
      if (r.parsed.flags.has("follow")) {
        return cmdTailFollow(r.parsed.values.get("limit"));
      }
      return cmdTail(r.parsed.values.get("limit"));
    }
    case "doctor": {
      // no options: --help helps, anything else is a usage error (never a
      // silently-ignored argument).
      if (rest[0] === "--help" || rest[0] === "-h") {
        printCommandHelp("doctor");
        return 0;
      }
      if (rest.length > 0) {
        sayErr(`unexpected argument: ${rest[0]} (mesh doctor takes no options)`);
        return EXIT_USAGE;
      }
      return cmdDoctor();
    }
    default:
      sayErr(`unknown command: ${cmd}`);
      sayErr(GENERAL_USAGE);
      return EXIT_USAGE;
  }
}

/** One-shot processes must not die on unref'd client timers (reconnect/
 * retry sleeps are unref'd by design for long-lived sessions): keep the
 * event loop alive until the command completes, then let process.exit run. */
function withKeepAlive<T>(p: Promise<T>): Promise<T> {
  const iv = setInterval(() => {}, 1_000);
  return p.finally(() => clearInterval(iv));
}

withKeepAlive(main(process.argv.slice(2)))
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`mesh cli fatal: ${String(err)}\n`);
    process.exit(1);
  });
