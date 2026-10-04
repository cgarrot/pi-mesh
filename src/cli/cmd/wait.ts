// cli/cmd/wait.ts — one-shot wait_all. HONEST LIMIT: missions live in the
// memory of the process that LAUNCHED them — a fresh CLI process has none.
// The scripted path is `send --await` (synchronous); multi-mission waiting
// belongs to a persistent peer (Phase 5 attach --json).
import { say, sayErr } from "../out.js";
import { EXIT_OK, EXIT_USAGE, EXIT_EXPIRED, EXIT_PARTIAL, EXIT_MESH_FAILURE } from "../codes.js";
import { ephemeralClient } from "../ctx.js";
import { CLI_WAIT_TIMEOUT_MS } from "../../shared/config.js";
import { validateTimeoutMs } from "../validate.js";

export const WAIT_USAGE = "usage: mesh wait [--timeout MS]";

export async function cmdWait(timeoutRaw: string | undefined): Promise<number> {
  let timeout = CLI_WAIT_TIMEOUT_MS;
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
  } catch {
    say("blocked: broker_unavailable");
    return EXIT_MESH_FAILURE;
  }
  const summary = await client.waitAll(timeout);
  if (summary.total === 0) {
    say("no awaited missions in this process — missions are memory of the sending process");
    say("(scripted path: mesh send --await; persistent missions: attach, Phase 5)");
    await client.close();
    return EXIT_OK;
  }
  say(`verdict ${summary.status} answered=${summary.answered}/${summary.total} in ${summary.elapsedMs}ms`);
  for (const a of summary.answers) say(`  + ${a.to}: ${a.response}`);
  for (const m of summary.missing) say(`  x ${m.to} (${m.msgId})`);
  await client.close();
  // plan D5 mapping: complete → 0 ; cancelled (agreed outcome) → 0 ;
  // timeout with NO answer → 3 (expired) ; timeout with some answers → 4
  // (honest partial — the missing ones are listed above).
  if (summary.status === "complete" || summary.status === "cancelled") return EXIT_OK;
  return summary.answered === 0 ? EXIT_EXPIRED : EXIT_PARTIAL;
}
