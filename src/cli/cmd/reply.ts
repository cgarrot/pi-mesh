// cli/cmd/reply.ts — one-shot reply. HONEST LIMIT: the original message
// (and thus its sender/room) lives in the SENDING process's inbox — a fresh
// CLI process has none, so --room plus either --to or --reply-all is
// REQUIRED (the broker would answer reply_without_target otherwise).
// Persistent replies belong to a live session or a persistent peer (Phase 5).
import { say, sayErr } from "../out.js";
import { EXIT_OK, EXIT_MESH_FAILURE, EXIT_USAGE } from "../codes.js";
import { ephemeralClient } from "../ctx.js";
import { csvParts, validateAlias, validateBody, validateRefsCsv } from "../validate.js";
import { exitCodeFor, printResult } from "./send.js";

export const REPLY_USAGE =
  "usage: mesh reply <msgId> <text…> (--to <alias> | --reply-all) --room <room> [--refs A,B]";

export interface ReplyArgs {
  msgId: string;
  text: string;
  to: string | undefined;
  room: string | undefined;
  refsCsv: string | undefined;
  replyAll: boolean;
}

export async function cmdReply(args: ReplyArgs): Promise<number> {
  const bodyV = validateBody(args.text);
  if (!bodyV.ok) {
    sayErr(bodyV.error);
    return EXIT_USAGE;
  }
  const hasTarget = (args.to !== undefined) !== args.replyAll; // exactly one of --to / --reply-all
  if (!hasTarget || args.room === undefined) {
    sayErr("--room and exactly one of --to / --reply-all are required: a one-shot CLI has no inbox");
    sayErr(REPLY_USAGE);
    return EXIT_USAGE;
  }
  if (args.to !== undefined) {
    const toV = validateAlias(args.to.replace(/^@/, "").toLowerCase());
    if (!toV.ok) {
      sayErr(toV.error);
      return EXIT_USAGE;
    }
  }
  if (args.refsCsv !== undefined) {
    const v = validateRefsCsv(args.refsCsv);
    if (!v.ok) {
      sayErr(v.error);
      return EXIT_USAGE;
    }
  }

  const client = ephemeralClient();
  try {
    await client.connect();
  } catch (err) {
    say(`blocked: ${err instanceof Error ? err.message : String(err)}`);
    await client.close();
    return EXIT_MESH_FAILURE;
  }
  const result = await client.reply(args.msgId, args.text, {
    to: args.to !== undefined ? args.to.replace(/^@/, "").toLowerCase() : undefined,
    replyAll: args.replyAll || undefined,
    room: args.room,
    refs: args.refsCsv !== undefined ? csvParts(args.refsCsv) : undefined,
  });
  printResult(result);
  await client.close();
  return exitCodeFor(result, false);
}
