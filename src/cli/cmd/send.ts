// cli/cmd/send.ts — one-shot send with FULL SendOpts parity (Phase 2):
// priority/reason/refs/reply-to/broadcast/await/launch/alias/require-online.
// Honest exit contract (plan D5):
//   0 delivered / reply / cancelled-by-SIGINT · 1 blocked/error (or
//   queued_offline with --require-online) · 2 usage · 3 expired ·
//   4 honest partial (queued_offline, broadcast deliveredCount < totalCount).
// The CLI is not a session: it never emits read receipts (plan §2.0.7).
import { say, sayErr } from "../out.js";
import { EXIT_OK, EXIT_MESH_FAILURE, EXIT_EXPIRED, EXIT_PARTIAL, EXIT_USAGE } from "../codes.js";
import type { SendResult } from "../../client/client.js";
import type { MeshPriority } from "../../protocol/envelope.js";
import { ephemeralClient } from "../ctx.js";
import { CLI_SEND_TIMEOUT_MS, MAX_BODY_BYTES } from "../../shared/config.js";
import { csvParts, validateAlias, validateBody, validateRefsCsv, validateReplyToCsv, validateTimeoutMs, type Validation } from "../validate.js";

/** Single source of truth for the send usage line (dispatcher + parser). */
export const SEND_USAGE = "usage: mesh send [alias] <text…> [--room R] [--priority P] [--reason R] [--refs A,B] [--reply-to A,B] [--broadcast] [--await | --launch] [--timeout MS] [--alias A] [--require-online]";

export interface SendArgs {
  to: string | undefined;
  text: string;
  room?: string;
  priority: string | undefined;
  reason: string | undefined;
  refsCsv: string | undefined;
  replyToCsv: string | undefined;
  broadcast: boolean;
  awaitReply: boolean;
  launch: boolean;
  timeoutMs: string | undefined;
  alias: string | undefined;
  requireOnline: boolean;
}

export function printResult(r: SendResult): void {
  switch (r.status) {
    case "delivered":
      if (r.totalCount !== undefined && r.deliveredCount !== undefined && r.deliveredCount < r.totalCount) {
        say(`partial ${r.deliveredCount}/${r.totalCount} ${r.msgId}`);
      } else if (r.totalCount !== undefined && r.deliveredCount !== undefined) {
        say(`delivered ${r.deliveredCount}/${r.totalCount} ${r.msgId}`);
      } else {
        say(`delivered ${r.msgId}`);
      }
      break;
    case "queued_offline":
      say(`queued_offline ${r.msgId}`);
      break;
    case "reply":
      say(`reply ${r.msgId}: ${r.response}`);
      break;
    case "expired":
      say(`expired ${r.msgId ?? ""}`);
      break;
    case "blocked":
      say(`blocked: ${r.reason}`);
      break;
    case "error":
      say(`error: ${r.reason}`);
      break;
  }
}

/** Honest exit code for a SendResult (D5 contract). */
export function exitCodeFor(r: SendResult, requireOnline: boolean): number {
  if (r.status === "error") {
    // cancelled (SIGINT on --await) is an honest, agreed outcome — not a failure
    if (r.reason === "cancelled") return EXIT_OK;
    return EXIT_MESH_FAILURE;
  }
  if (r.status === "blocked") return EXIT_MESH_FAILURE;
  if (r.status === "expired") return EXIT_EXPIRED;
  if (r.status === "queued_offline") return requireOnline ? EXIT_MESH_FAILURE : EXIT_PARTIAL;
  if (r.status === "delivered" && r.totalCount !== undefined && r.deliveredCount !== undefined && r.deliveredCount < r.totalCount) {
    return EXIT_PARTIAL;
  }
  return EXIT_OK;
}

export function parseSendArgs(positionals: string[], opts: Omit<SendArgs, "to" | "text">):
  { ok: true; args: SendArgs } | { ok: false; error: string } {
  const [first, ...rest] = positionals;
  // broadcast: no target alias — everything is the message
  const to = opts.broadcast || first === undefined ? undefined : first;
  const text = (opts.broadcast ? positionals : rest).join(" ");
  if (!opts.broadcast && (to === undefined || to === "")) return { ok: false, error: SEND_USAGE };
  if (text === "") return { ok: false, error: SEND_USAGE };
  return { ok: true, args: { ...opts, to, text } };
}

function fail(v: Validation): number {
  if (!v.ok) sayErr(v.error);
  return EXIT_USAGE;
}

/** Read the whole stdin as the message body, capped at MAX_BODY_BYTES + 1
 * bytes so an oversized body is DETECTED (exit 2), never truncated. */
export function readStdinBody(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    process.stdin.on("data", (c: Buffer) => {
      total += c.byteLength;
      chunks.push(c);
      if (total > MAX_BODY_BYTES) {
        process.stdin.destroy();
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

export async function cmdSend(args: SendArgs): Promise<number> {
  // validation table: refuse loudly BEFORE any network touch
  const bodyV = validateBody(args.text);
  if (!bodyV.ok) return fail(bodyV);
  if (args.to !== undefined) {
    const v = validateAlias(args.to.replace(/^@/, "").toLowerCase());
    if (!v.ok) return fail(v);
  }
  if (args.priority !== undefined && !["normal", "urgent", "force"].includes(args.priority)) {
    return fail({ ok: false, error: `invalid --priority "${args.priority}" (normal|urgent|force)` });
  }
  if (args.priority === "force" && (args.reason === undefined || args.reason === "")) {
    return fail({ ok: false, error: "--priority force requires --reason (hashed, never persisted)" });
  }
  if (args.refsCsv !== undefined) {
    const v = validateRefsCsv(args.refsCsv);
    if (!v.ok) return fail(v);
  }
  if (args.replyToCsv !== undefined) {
    const v = validateReplyToCsv(args.replyToCsv);
    if (!v.ok) return fail(v);
  }
  if (args.alias !== undefined) {
    const v = validateAlias(args.alias.replace(/^@/, "").toLowerCase());
    if (!v.ok) return fail(v);
  }
  let timeout = CLI_SEND_TIMEOUT_MS;
  if (args.timeoutMs !== undefined) {
    const v = validateTimeoutMs(args.timeoutMs);
    if (!v.ok) return fail(v);
    timeout = Number(args.timeoutMs);
  }
  if (args.awaitReply && args.launch) {
    return fail({ ok: false, error: "--await and --launch are mutually exclusive" });
  }

  const client = ephemeralClient({ alias: args.alias });
  // connect EXPLICITLY: send() would swallow a connect failure into
  // broker_unavailable — a strict-alias collision must surface as
  // alias_taken, never as a lying "broker down".
  try {
    await client.connect();
  } catch (err) {
    say(`blocked: ${err instanceof Error ? err.message : String(err)}`);
    await client.close();
    return EXIT_MESH_FAILURE;
  }
  // SIGINT on a blocking --await: settle honestly as cancelled (v0.6 ESC parity)
  if (args.awaitReply) {
    process.once("SIGINT", () => {
      client.cancelAllAwaited();
    });
  }

  const result = await client.send({
    to: args.to,
    message: args.text,
    room: args.room,
    priority: args.priority as MeshPriority | undefined,
    reason: args.reason,
    refs: args.refsCsv !== undefined ? csvParts(args.refsCsv) : undefined,
    replyTo: args.replyToCsv !== undefined ? csvParts(args.replyToCsv) : undefined,
    broadcast: args.broadcast || undefined,
    awaitReply: args.awaitReply || args.launch || undefined,
    block: args.launch ? false : undefined,
    timeoutMs: args.launch ? undefined : timeout,
  });
  printResult(result);
  if (result.status === "queued_offline" && args.requireOnline) {
    say("(--require-online: queued_offline treated as failure)");
  }
  if (args.launch) {
    say("(launched — the mission is tracked by THIS process and dies at exit; use --await to wait inline)");
  }
  await client.close();
  return exitCodeFor(result, args.requireOnline);
}
