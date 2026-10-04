// cli/cmd/ping.ts — liveness check: a one-shot await send with a short
// timeout. Honest outcomes: reply (0) or expired (3) — "expired" here means
// "no answer within the budget", never "peer is down" (delivered is a
// separate, stronger signal carried by the ack).
import { say, sayErr } from "../out.js";
import { EXIT_EXPIRED, EXIT_MESH_FAILURE, EXIT_USAGE } from "../codes.js";
import { ephemeralClient } from "../ctx.js";
import { CLI_PING_TIMEOUT_MS } from "../../shared/config.js";
import { validateAlias, validateTimeoutMs } from "../validate.js";
import { exitCodeFor, printResult } from "./send.js";

export const PING_USAGE = "usage: mesh ping <alias> [--timeout MS]";

export async function cmdPing(alias: string, timeoutRaw: string | undefined): Promise<number> {
  const aV = validateAlias(alias.replace(/^@/, "").toLowerCase());
  if (!aV.ok) {
    sayErr(aV.error);
    return EXIT_USAGE;
  }
  let timeout = CLI_PING_TIMEOUT_MS;
  if (timeoutRaw !== undefined) {
    const v = validateTimeoutMs(timeoutRaw);
    if (!v.ok) {
      sayErr(v.error);
      return EXIT_USAGE;
    }
    timeout = Number(timeoutRaw);
  }
  const client = ephemeralClient();
  try {
    await client.connect();
  } catch (err) {
    say(`blocked: ${err instanceof Error ? err.message : String(err)}`);
    await client.close();
    return EXIT_MESH_FAILURE;
  }
  const result = await client.send({
    to: alias.replace(/^@/, "").toLowerCase(),
    message: "ping",
    awaitReply: true,
    timeoutMs: timeout,
  });
  printResult(result);
  await client.close();
  return exitCodeFor(result, false);
}
