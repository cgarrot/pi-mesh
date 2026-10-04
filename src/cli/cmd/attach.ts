// cli/cmd/attach.ts — the STANDALONE PEER (plan D10): a full mesh member
// with NO Pi session behind it. Receives messages WITH bodies (it IS the
// recipient — unlike watch, see D8), can send/reply/reserve from a REPL or
// a scriptable NDJSON pipe, and can ADOPT a dead session's identity
// (alias + rooms + fresh reservations + mailbox inheritance).
//
// Honesty rules (D10.1):
// - read receipts ONLY in interactive TTY mode, at render time (--no-read
//   opts out; --json/pipe NEVER emits read — a pipe is not an attention
//   surface)
// - no activity announcements (no session = no busy/idle turns)
// - adoption is a documented steal: if the original session returns it
//   falls back to a random alias (existing broker behavior)
import { randomBytes } from "node:crypto";
import readline from "node:readline/promises";
import { say, sayErr, jsonLine, colorizeSender, useColor, dim } from "../out.js";
import { EXIT_OK, EXIT_MESH_FAILURE, EXIT_USAGE } from "../codes.js";
import { MeshClient, type SendResult, type WaitAllSummary } from "../../client/client.js";
import { ALIAS_RAND_CHARS, ATTACH_BULK_READ_THRESHOLD, DEFAULT_ROOM, STANDALONE_ALIAS_PREFIX } from "../../shared/config.js";
import { resolveCliConfig } from "../ctx.js";
import { MeshIdentity, type PersistedIdentity } from "../../shared/identity-store.js";
import { stateDir } from "../../shared/paths.js";
import { nowIso } from "../../protocol/frames.js";
import type { FileReservation, MeshFrame } from "../../protocol/envelope.js";
import { validateAlias, validateBody, validateRefsCsv, validateReplyToCsv, validateRoom, csvParts } from "../validate.js";

export const ATTACH_USAGE = "usage: mesh attach [alias] [--session ID] [--room R] [--json] [--no-read]";

export interface AttachOpts {
  alias: string | undefined;
  sessionId: string | undefined;
  room: string | undefined;
  asJson: boolean;
  noRead: boolean;
}

/** Resolve the identity to attach as: explicit session, named alias
 * (adoption candidate when its persisted identity is offline), or fresh. */
function resolveIdentity(opts: AttachOpts): { kind: "fresh" | "adopt"; alias: string; rooms: string[]; reservations: FileReservation[]; sessionId?: string } | { kind: "error"; error: string } {
  const store = new MeshIdentity(stateDir());

  if (opts.sessionId !== undefined) {
    const id = store.load(opts.sessionId);
    if (id === null) return { kind: "error", error: `no persisted identity for session ${opts.sessionId} in ${stateDir()} (scope: current stateDir only)` };
    return { kind: "adopt", ...refresh(id), sessionId: opts.sessionId };
  }

  if (opts.alias !== undefined) {
    const aliasV = validateAlias(opts.alias.replace(/^@/, "").toLowerCase());
    if (!aliasV.ok) return { kind: "error", error: aliasV.error };
    const alias = opts.alias.replace(/^@/, "").toLowerCase();
    const matches = store.list().identities.filter((id) => id.alias === alias);
    if (matches.length === 1) {
      return { kind: "adopt", ...refresh(matches[0] as PersistedIdentity & { sessionId: string }), sessionId: (matches[0] as { sessionId: string }).sessionId };
    }
    if (matches.length > 1) {
      return { kind: "error", error: `ambiguous: ${matches.length} persisted identities hold alias "${alias}" — pick one with --session <id> (mesh sessions)` };
    }
    // no persisted identity: a fresh strict standalone under that name
    // (still joins the default room — see the no-arg case)
    return { kind: "fresh", alias, rooms: [DEFAULT_ROOM], reservations: [], sessionId: undefined };
  }

  return {
    kind: "fresh",
    alias: `${STANDALONE_ALIAS_PREFIX}-${randomBytes(ALIAS_RAND_CHARS / 2).toString("hex").slice(0, ALIAS_RAND_CHARS)}`,
    // a peer in NO room can neither receive nor send (not_in_any_room) —
    // a fresh standalone joins the default room like any session would
    rooms: [DEFAULT_ROOM],
    reservations: [],
  };
}

/** Adoption refresh (review): reset reservation `since` to NOW — an inherited
 * 23 h-old claim is "fresh" for the 24 h store rule but nearly expired for
 * the 6 h conflict TTL; the age shown to peers must be the ADOPTANT's age. */
function refresh(id: PersistedIdentity): { alias: string; rooms: string[]; reservations: FileReservation[] } {
  return {
    alias: id.alias,
    rooms: [...id.rooms],
    reservations: id.reservations.map((r) => ({ ...r, since: nowIso() })),
  };
}

function frameLine(f: MeshFrame, color: boolean): string {
  const ts = f.ts !== undefined ? new Date(f.ts).toISOString().slice(11, 19) : "??:??:??";
  const from = f.from !== undefined ? colorizeSender(f.from, color) : "?";
  switch (f.type) {
    case "msg":
    case "reply":
      return `${ts} ${f.type === "msg" ? "" : "↩ "}${from}${f.room !== undefined ? ` [${f.room}]` : ""} ${f.body ?? ""} ${dim(`(${f.replyTo ?? f.id ?? "?"})`, color)}`;
    case "presence":
      return `${ts} presence ${from} ${f.status ?? ""}`.trimEnd();
    case "activity":
      return `${ts} activity ${from} ${f.status ?? ""}`.trimEnd();
    case "reserve":
      return `${ts} reserve ${from} ${(f.reservations ?? []).map((r) => r.pattern).join(", ")}`;
    case "read":
      return `${ts} read ${from} → ${f.reads ?? ""}`;
    case "mailbox":
      return `${ts} mailbox ${from} ${f.body ?? ""}`.trimEnd();
    case "ack":
      return `${ts} ack ${f.status ?? ""}`.trimEnd();
    case "error":
      return `${ts} error ${f.code ?? ""}`.trimEnd();
    default:
      return `${ts} ${f.type} ${from}`;
  }
}

export async function cmdAttach(opts: AttachOpts): Promise<number> {
  const resolved = resolveIdentity(opts);
  if (resolved.kind === "error") {
    sayErr(resolved.error);
    sayErr(ATTACH_USAGE);
    return EXIT_USAGE;
  }
  const identity = resolved;
  const rooms = opts.room !== undefined ? [opts.room, ...identity.rooms.filter((r) => r !== opts.room)] : identity.rooms;

  // Interactive read receipts only: TTY + not --no-read + not --json.
  const interactive = !opts.asJson && process.stdout.isTTY === true;
  const readEnabled = interactive && !opts.noRead;

  const client = new MeshClient({
    alias: identity.alias,
    rooms,
    initialReservations: identity.reservations.length > 0 ? identity.reservations : undefined,
    strictAlias: opts.alias !== undefined || opts.sessionId !== undefined,
    onFrame: (f) => {
      if (opts.asJson) {
        // script mode: full frames out (bodies allowed — we ARE the
        // recipient), read frames NEVER emitted
        if (f.type === "ping" || f.type === "pong") return;
        const { body, ...rest } = f;
        jsonLine({ type: "frame", frame: { ...rest, body: body ?? undefined } });
        return;
      }
      if (f.type === "ping" || f.type === "pong" || f.type === "ack") return; // wire noise
      say(frameLine(f, useColor()));
      // read receipt at RENDER time — the terminal IS the attention surface
      if (readEnabled && (f.type === "msg" || f.type === "reply") && f.from !== undefined && f.id !== undefined) {
        client.sendRead(f.id, f.from);
      }
    },
    config: resolveCliConfig(),
  });

  let welcome;
  try {
    welcome = await client.connect();
  } catch (err) {
    say(`blocked: ${err instanceof Error ? err.message : String(err)}`);
    await client.close();
    return EXIT_MESH_FAILURE;
  }

  if (welcome.mailboxCount > ATTACH_BULK_READ_THRESHOLD && readEnabled) {
    say(`(mailbox flush: ${welcome.mailboxCount} queued messages will each emit a read receipt — consider --no-read if that is noisy for the senders)`);
  }

  // banner: everything the operator must know, honestly
  if (opts.asJson) {
    jsonLine({
      type: "attach-start",
      alias: identity.alias,
      rooms: welcome.rooms,
      adopted: identity.kind === "adopt",
      sessionId: identity.sessionId ?? null,
      reservations: identity.reservations.map((r) => ({ pattern: r.pattern, since: r.since })),
      mailboxCount: welcome.mailboxCount,
      readReceipts: readEnabled,
      note: identity.kind === "adopt" ? "alias adopted from a dead session; if it returns, it gets a fresh alias" : undefined,
    });
  } else {
    say(`attached as ${identity.alias} — rooms: ${welcome.rooms.join(", ") || "(none)"}`);
    if (identity.kind === "adopt") {
      say(`(alias adopted from session ${identity.sessionId}; if that session returns it will get a fresh alias)`);
    }
    if (identity.reservations.length > 0) {
      say(`reservations re-declared (${identity.reservations.length}, since refreshed to now): ${identity.reservations.map((r) => r.pattern).join(", ")}`);
    }
    if (welcome.mailboxCount > 0) say(`mailbox: ${welcome.mailboxCount} queued message(s) delivered`);
    say(`read receipts: ${readEnabled ? "on (rendered on this TTY)" : "off"} — the CLI only reads what it shows`);
  }

  const printSend = (r: SendResult): string => {
    switch (r.status) {
      case "delivered":
      case "queued_offline":
        return `${r.status} ${r.msgId}${r.deliveredCount !== undefined && r.totalCount !== undefined ? ` ${r.deliveredCount}/${r.totalCount}` : ""}`;
      case "expired":
        return `expired ${r.msgId ?? ""} (late replies still arrive)`;
      default:
        return `${r.status}: ${"reason" in r ? r.reason : ""}`;
    }
  };

  const stop = (): Promise<number> => client.close().then(() => EXIT_OK);
  // ONE signal installer for every mode (double close was possible when a
  // mode added its own handlers on top of these)
  const finish = new Promise<number>((resolve) => {
    let stopping = false;
    const handler = (): void => {
      if (stopping) process.exit(EXIT_OK);
      stopping = true;
      const force = setTimeout(() => process.exit(EXIT_OK), 3_000);
      force.unref();
      void stop().then(resolve);
    };
    process.once("SIGINT", handler);
    process.once("SIGTERM", handler);
  });

  if (opts.asJson) {
    // ---- script mode: stdin NDJSON commands / stdout NDJSON events ----
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on("line", (line) => {
      const t = line.trim();
      if (t === "") return;
      void (async () => {
        let cmd: Record<string, unknown>;
        try {
          cmd = JSON.parse(t) as Record<string, unknown>;
        } catch {
          jsonLine({ type: "error", ref: null, message: "invalid json" });
          return;
        }
        const ref = typeof cmd.ref === "string" ? cmd.ref : null;
        try {
          const out = await runCommand(client, cmd);
          jsonLine({ type: "result", ref, ...out });
          if (out.exit === true) {
            void client.close().then(() => process.exit(EXIT_OK));
          }
        } catch (err) {
          jsonLine({ type: "error", ref, message: err instanceof Error ? err.message : String(err) });
        }
      })();
    });
    rl.on("close", () => {
      void client.close().then(() => process.exit(EXIT_OK));
    });
    // hold the process open until stdin closes or a signal fires
    return await finish;
  }

  // ---- interactive REPL ----
  if (!interactive) {
    // not a TTY and no --json: frames still render (piped), input disabled
    say("(not a TTY — output only; use --json for scriptable stdin commands)");
    return await finish;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
  rl.on("line", (line) => {
    const t = line.trim();
    if (t === "") return;
    void (async () => {
      try {
        if (t.startsWith("/")) {
          const out = await replCommand(client, t);
          if (out !== null) say(out);
          if (out === "__exit__") {
            rl.close();
            void client.close().then(() => process.exit(EXIT_OK));
          }
        } else {
          const space = t.indexOf(" ");
          if (space === -1) {
            say("usage: <alias> <text…>  |  /help");
            return;
          }
          const to = t.slice(0, space);
          const text = t.slice(space + 1);
          const v = validateAlias(to.replace(/^@/, "").toLowerCase());
          const bv = validateBody(text);
          if (!v.ok) say(v.error);
          else if (!bv.ok) say(bv.error);
          else {
            const r = await client.send({ to: to.replace(/^@/, "").toLowerCase(), message: text });
            say(printSend(r));
          }
        }
      } catch (err) {
        say(`error: ${err instanceof Error ? err.message : String(err)}`);
      }
      rl.prompt();
    })();
  });
  rl.on("close", () => {
    void client.close().then(() => process.exit(EXIT_OK));
  });
  rl.prompt();
  return await new Promise<number>(() => {});
}

/** One NDJSON command (script mode). Never throws for bad input — errors
 * ride the event stream with the caller's ref. */
async function runCommand(client: MeshClient, cmd: Record<string, unknown>): Promise<Record<string, unknown> & { exit?: boolean }> {
  const type = typeof cmd.cmd === "string" ? cmd.cmd : "";
  switch (type) {
    case "send": {
      const to = typeof cmd.to === "string" ? cmd.to.replace(/^@/, "").toLowerCase() : undefined;
      const message = typeof cmd.message === "string" ? cmd.message : "";
      if (to === undefined) throw new Error("send: missing to");
      const bv = validateBody(message);
      if (!bv.ok) throw new Error(`send: ${bv.error}`);
      const av = validateAlias(to);
      if (!av.ok) throw new Error(`send: ${av.error}`);
      const room = typeof cmd.room === "string" ? cmd.room : undefined;
      if (room !== undefined) {
        const rv = validateRoom(room);
        if (!rv.ok) throw new Error(`send: ${rv.error}`);
      }
      const priority = cmd.priority === "urgent" || cmd.priority === "force" ? cmd.priority : undefined;
      const reason = typeof cmd.reason === "string" ? cmd.reason : undefined;
      if (priority === "force" && (reason === undefined || reason === "")) {
        throw new Error("send: force requires a reason (hashed, never persisted)");
      }
      const timeoutMs = typeof cmd.timeoutMs === "number" ? cmd.timeoutMs : undefined;
      if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 25 || timeoutMs > 1_800_000)) {
        throw new Error("send: timeoutMs out of bounds (25..1800000)");
      }
      // refs: array (normalized through the same table) or csv string
      let refs: string[] | undefined;
      if (typeof cmd.refs === "string") {
        const rv = validateRefsCsv(cmd.refs);
        if (!rv.ok) throw new Error(`send: ${rv.error}`);
        refs = csvParts(cmd.refs);
      } else if (Array.isArray(cmd.refs)) {
        refs = (cmd.refs as unknown[]).filter((x): x is string => typeof x === "string");
        const rv = validateRefsCsv(refs.join(","));
        if (!rv.ok) throw new Error(`send: ${rv.error}`);
      }
      // replyTo: array or csv — same bound as the one-shot CLI
      let replyTo: string[] | undefined;
      const replyToRaw = typeof cmd.replyTo === "string" ? cmd.replyTo : Array.isArray(cmd.replyTo) ? (cmd.replyTo as unknown[]).filter((x): x is string => typeof x === "string").join(",") : undefined;
      if (replyToRaw !== undefined) {
        const rv = validateReplyToCsv(replyToRaw);
        if (!rv.ok) throw new Error(`send: ${rv.error}`);
        replyTo = csvParts(replyToRaw);
      }
      const r = await client.send({
        to,
        message,
        room,
        priority,
        reason,
        refs,
        replyTo,
        broadcast: cmd.broadcast === true || undefined,
        awaitReply: cmd.awaitReply === true || undefined,
        timeoutMs,
      });
      return { result: printResultJson(r) };
    }
    case "reply": {
      const msgId = typeof cmd.msgId === "string" ? cmd.msgId : "";
      const message = typeof cmd.message === "string" ? cmd.message : "";
      if (msgId === "") throw new Error("reply: missing msgId");
      const bv = validateBody(message);
      if (!bv.ok) throw new Error(`reply: ${bv.error}`);
      // in-process inbox carries the original → plain reply works here
      const r = await client.reply(msgId, message, {
        to: typeof cmd.to === "string" ? cmd.to.replace(/^@/, "").toLowerCase() : undefined,
        replyAll: cmd.replyAll === true || undefined,
      });
      return { result: printResultJson(r) };
    }
    case "status": {
      const snap = await client.status();
      return { peers: snap.peers.length, rooms: snap.rooms, stats: snap.stats ?? null };
    }
    case "reserve": {
      const paths = Array.isArray(cmd.paths) ? (cmd.paths as unknown[]).filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
      if (paths.length === 0) throw new Error("reserve: missing paths");
      const r = await client.reserve(paths, typeof cmd.reason === "string" ? cmd.reason : undefined);
      return { result: printResultJson(r) };
    }
    case "release": {
      const patterns = cmd.all === true ? undefined : Array.isArray(cmd.patterns) ? (cmd.patterns as unknown[]).filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
      if (patterns !== undefined && patterns.length === 0) throw new Error("release: missing patterns (or use all: true)");
      const r = await client.release(patterns);
      return { released: "released" in r ? r.released : [] };
    }
    case "wait": {
      const summary: WaitAllSummary = await client.waitAll(typeof cmd.timeoutMs === "number" ? cmd.timeoutMs : 300_000);
      return { verdict: summary };
    }
    case "exit":
      return { exit: true };
    default:
      throw new Error(`unknown cmd: ${type || "(none)"}`);
  }
}

function printResultJson(r: SendResult): Record<string, unknown> {
  const base: Record<string, unknown> = { status: r.status };
  if ("msgId" in r && r.msgId !== undefined) base.msgId = r.msgId;
  if ("reason" in r && r.reason !== undefined) base.reason = r.reason;
  if ("response" in r) base.response = r.response;
  if ("deliveredCount" in r && r.deliveredCount !== undefined) base.deliveredCount = r.deliveredCount;
  if ("totalCount" in r && r.totalCount !== undefined) base.totalCount = r.totalCount;
  return base;
}

/** REPL slash commands (interactive). Returns null for silent ones. */
async function replCommand(client: MeshClient, line: string): Promise<string | null> {
  const parts = line.slice(1).split(/\s+/);
  const cmd = parts[0] ?? "";
  switch (cmd) {
    case "help":
      return [
        "/reply <msgId> <text…>   — reply using the in-process inbox",
        "/reply-all <msgId> <text…>",
        "/status                  — peers + reservations",
        "/reserve <path>… [ -- <reason>] — claim (connection-scoped)",
        "/release [pattern…]      — release claims",
        "/rooms                   — current rooms",
        "/exit                    — leave cleanly",
        "<alias> <text…>          — send a message",
      ].join("\n");
    case "reply":
    case "reply-all": {
      const msgId = parts[1];
      // strict extraction: everything after the msgId token (an indexOf
      // could land on a substring of the msgId itself)
      const text = parts.slice(2).join(" ");
      if (msgId === undefined || text === "") return "usage: /reply <msgId> <text…>";
      const r = await client.reply(msgId, text, { replyAll: cmd === "reply-all" || undefined });
      return r.status === "delivered" ? `delivered ${r.msgId}` : `${r.status}: ${"reason" in r ? r.reason : ""}`;
    }
    case "status": {
      const snap = await client.status();
      const lines = snap.peers.map((p) => `  ${p.alias}\trooms=${p.rooms.join(",")}${(p.reservations ?? []).length > 0 ? `\treservations=${(p.reservations ?? []).map((r) => r.pattern).join(",")}` : ""}`);
      return [`peers (${snap.peers.length}):`, ...lines].join("\n");
    }
    case "reserve": {
      // multi-path: /reserve p1 p2/ -- an optional reason
      const dd = line.indexOf(" -- ");
      const pathPart = dd === -1 ? line.slice("/reserve ".length) : line.slice("/reserve ".length, dd);
      const reasonPart = dd === -1 ? undefined : line.slice(dd + 4).trim();
      const paths = pathPart.trim().split(/\s+/).filter((p) => p !== "");
      if (paths.length === 0 || (paths.length === 1 && paths[0] === "")) return "usage: /reserve <path>... [ -- <reason>]";
      const r = await client.reserve(paths, reasonPart !== "" ? reasonPart : undefined);
      return r.status === "delivered" ? `reserved ${paths.join(", ")} (dies with this process)` : `${r.status}: ${"reason" in r ? r.reason : ""}`;
    }
    case "release": {
      const patterns = parts.slice(1);
      const r = await client.release(patterns.length > 0 ? patterns : undefined);
      return `released ${("released" in r ? r.released : []).join(", ") || "(nothing)"}`;
    }
    case "rooms":
      return `rooms: ${client.rooms.join(", ") || "(none)"}`;
    case "exit":
      return "__exit__";
    default:
      return `unknown command: /${cmd} (/help)`;
  }
}
