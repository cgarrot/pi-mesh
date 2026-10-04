// cli/cmd/watch.ts — `mesh watch [room]`: a live observer for the mesh.
// Joins the room as an OBSERVER (cannot send) and prints frames as they
// happen. REDACTION IS ABSOLUTE (plan D8): observer_readonly only blocks
// SENDING — a targeted send/reply to the watcher WOULD deliver a body, so
// the renderer strips `body` at the print point, text AND --json; only
// bodyHash ever appears. `mesh watch | tee` cannot leak message content.
import { randomBytes } from "node:crypto";
import { say, sayErr, colorizeSender, jsonLine, useColor } from "../out.js";
import { EXIT_OK, EXIT_USAGE, EXIT_MESH_FAILURE } from "../codes.js";
import { MeshClient } from "../../client/client.js";
import { ALIAS_RAND_CHARS, DEFAULT_ROOM } from "../../shared/config.js";
import { resolveCliConfig } from "../ctx.js";
import type { MeshFrame } from "../../protocol/envelope.js";

export const WATCH_USAGE = "usage: mesh watch [room] [--alias A] [--json]";

/** A frame with the body STRIPPED — the only shape that ever reaches output.
 * `body` is the single content field (envelope); unknown keys could ride the
 * spread, but two validation layers (buildFrame + parseFrameLine) reject
 * anything malformed before onFrame — defense in depth, not extra scanning. */
function redacted(frame: MeshFrame): Omit<MeshFrame, "body"> & { bodyHash?: string } {
  const { body: _body, ...rest } = frame;
  void _body;
  return { ...rest, bodyHash: frame.bodyHash ?? (frame.body !== undefined ? "(unhashed-body-redacted)" : undefined) };
}

function renderLine(frame: Omit<MeshFrame, "body"> & { bodyHash?: string }, color: boolean): string {
  const ts = new Date(frame.ts).toISOString().slice(11, 19);
  const from = frame.from !== undefined ? colorizeSender(frame.from, color) : "?";
  const room = frame.room !== undefined ? ` [${frame.room}]` : "";
  const detail: string[] = [];
  if (frame.bodyHash !== undefined) detail.push(frame.bodyHash);
  if (frame.type === "presence" && frame.status !== undefined) detail.push(frame.status);
  if (frame.type === "activity" && frame.status !== undefined) detail.push(frame.status);
  if (frame.type === "reserve" && frame.reservations !== undefined) detail.push(`${frame.reservations.length} pattern(s)`);
  if (frame.type === "ack" && frame.status !== undefined) detail.push(frame.status);
  if (frame.type === "error" && frame.code !== undefined) detail.push(frame.code);
  return `${ts} ${frame.type.padEnd(9)} ${from}${room} ${detail.join(" ")}`.trimEnd();
}

export interface WatchOpts {
  room: string | undefined;
  alias: string | undefined;
  asJson: boolean;
}

export async function cmdWatch(opts: WatchOpts): Promise<number> {
  const room = opts.room ?? DEFAULT_ROOM;
  const alias = opts.alias ?? `watch-${randomBytes(ALIAS_RAND_CHARS / 2).toString("hex").slice(0, ALIAS_RAND_CHARS)}`;
  const client = new MeshClient({
    // an explicit alias is strict (D7): collision = honest alias_taken
    alias,
    rooms: [],
    strictAlias: opts.alias !== undefined,
    onFrame: (f) => {
      if (f.type === "ping" || f.type === "pong") return; // wire noise
      if (opts.asJson) jsonLine(redacted(f));
      else say(renderLine(redacted(f), useColor())); // redacted FIRST — defense in depth
    },
    config: resolveCliConfig(),
  });

  try {
    await client.connect();
  } catch (err) {
    say(`blocked: ${err instanceof Error ? err.message : String(err)}`);
    await client.close();
    return EXIT_MESH_FAILURE;
  }
  await client.join(room, "observer");
  if (!opts.asJson) {
    say(`watching room "${room}" as ${alias} (observer) — Ctrl-C to stop; bodies are never shown`);
  } else {
    jsonLine({ type: "watch-start", room, alias, role: "observer", note: "bodies redacted" });
  }

  return await new Promise<number>((resolve) => {
    let stopping = false;
    const stop = (): void => {
      // second signal → exit NOW (close() is not proven idempotent)
      if (stopping) process.exit(EXIT_OK);
      stopping = true;
      const force = setTimeout(() => process.exit(EXIT_OK), 3_000);
      force.unref();
      void client.close().then(() => resolve(EXIT_OK));
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
