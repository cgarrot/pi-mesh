// register-commands.ts — register the `/mesh` slash command.
//
// V2 only: the legacy V1 plugin API exposes no command domain, so older
// OpenCode instances do not get this command (they still get the mesh
// tools, through the V1 tool map).
//
// The V2 command editor wants `{ name, description, execute(input) }` —
// `execute` is the key the runtime calls (a `handler` key is ignored and
// the command silently does nothing).
//
// Silence rule: the command NEVER injects chat messages. Outcomes travel
// through the notification bridge (`.mesh/mesh-notify-<sessionId>.jsonl`),
// which the sidebar CLI plugin turns into toasts; the sidebar itself shows
// alias/rooms/agents live.
//
// The subcommands mirror the Pi extension's `/mesh` for what makes sense
// outside a Pi TUI: status, join/leave (rooms), alias, ping, stale, broker,
// log, inbox. Rooms are never joined by default — `/mesh join <room>`.
import { readFileSync } from "node:fs";
import type { V2CommandDefinition, V2CommandEditor } from "./v2-surface.js";
import {
  notifySession,
  persistIdentity,
  runtimeBySession,
  type MeshSessionRuntime,
} from "./client-runtime.js";
import { buildStaleReport, parseJoinArgs } from "../extension/commands.js";
import { brokerLockPath, brokerSocketPath, stateDir } from "../shared/paths.js";
import type { MeshRole } from "../protocol/envelope.js";

const HELP_TEXT = [
  "/mesh status [room]        — broker snapshot (online peers, rooms)",
  "/mesh join <room> [as <alias>] [observer]",
  "/mesh leave <room>",
  "/mesh alias [<new-alias>]  — show or change this session's alias",
  "/mesh ping <alias>         — send a one-shot ping",
  "/mesh stale                — reservations held by peers (TTL insight)",
  "/mesh broker              — session/broker state, failure counters",
  "/mesh log [on|off]         — opt-in transcript (redacted bodies)",
  "/mesh inbox [flush]        — deferred broadcasts: list, or deliver now",
  "/mesh help",
].join("\n");

/** Render a status report for the session's runtime. */
export function renderMeshStatus(runtime: MeshSessionRuntime): string {
  const state = runtime.client.isOnline()
    ? runtime.isBusy()
      ? "● busy"
      : "● online"
    : "○ offline";
  const rooms = runtime.rooms.length > 0 ? runtime.rooms.join(", ") : "none";
  return `mesh — @${runtime.alias} ${state}\nrooms: ${rooms}`;
}

/** Args after `/mesh`, however the host passes the invocation text
 *  ("join zoma", "/mesh join zoma" and "" all resolve sensibly). */
export function meshArgs(raw: string | undefined): string[] {
  const cleaned = (raw ?? "").trim().replace(/^\/?mesh\b/, "").trim();
  return cleaned.length > 0 ? cleaned.split(/\s+/).filter((s) => s.length > 0) : [];
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Execute one `/mesh …` invocation; returns the text to notify. */
export async function runMeshCommand(
  runtime: MeshSessionRuntime,
  args: readonly string[],
): Promise<string> {
  const [sub, ...rest] = args;
  switch (sub) {
    case undefined:
    case "status":
      return renderMeshStatus(runtime);
    case "join": {
      // `/mesh join <room> [as <alias>] [observer]` — same parsing as Pi.
      const parsed = parseJoinArgs([...rest]);
      if (parsed.asAlias !== undefined) {
        const renamed = await runtime.client.rename(parsed.asAlias);
        if (!renamed.ok) {
          return `mesh: rename to "${parsed.asAlias}" failed: ${renamed.reason} — joining as @${runtime.client.alias}`;
        }
        persistIdentity(runtime);
      }
      if (parsed.room === undefined) {
        return "usage: /mesh join <room> [as <alias>] [observer]";
      }
      const role: MeshRole = parsed.observer ? "observer" : "member";
      try {
        await runtime.client.join(parsed.room, role);
      } catch (err) {
        return `mesh: join failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      persistIdentity(runtime);
      return `mesh: joined ${parsed.room} as ${role} (@${runtime.client.alias}, rooms: ${[...runtime.client.rooms].join(", ")})`;
    }
    case "leave": {
      const room = rest[0];
      if (room === undefined) return "usage: /mesh leave <room>";
      try {
        await runtime.client.leave(room);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === "not_member") {
          return `mesh: not in room "${room}" — nothing to leave`;
        }
        return `mesh: leave failed: ${message}`;
      }
      persistIdentity(runtime);
      const rooms = runtime.client.rooms.length > 0 ? [...runtime.client.rooms].join(", ") : "default";
      return `mesh: left ${room} (rooms: ${rooms})`;
    }
    case "alias": {
      const next = rest[0];
      if (next === undefined) return `mesh alias: @${runtime.client.alias}`;
      const renamed = await runtime.client.rename(next);
      if (!renamed.ok) {
        return `mesh: rename to "${next}" failed: ${renamed.reason}`;
      }
      persistIdentity(runtime);
      return renamed.unchanged === true
        ? `mesh alias: @${runtime.client.alias}`
        : `mesh: alias changed @${renamed.alias}`;
    }
    case "ping": {
      const alias = rest[0];
      if (alias === undefined) return "usage: /mesh ping <alias>";
      const res = await runtime.client.send({ to: alias, message: "ping" });
      const result = res as { status: string; msgId?: string; reason?: string };
      switch (result.status) {
        case "delivered":
          return `mesh: pong-path ok — delivered ${result.msgId ?? "?"}`;
        case "queued_offline":
          return `mesh: @${alias} offline — queued ${result.msgId ?? "?"}`;
        default:
          return `mesh: ping ${result.status}${result.reason !== undefined ? `: ${result.reason}` : ""}`;
      }
    }
    case "stale": {
      const rows = buildStaleReport(
        runtime.client.peerReservationMap,
        runtime.client.alias,
        runtime.client.reservationTtlMs,
        (alias) => runtime.client.activityOf(alias),
      );
      return rows.length === 0
        ? "mesh: no peer reservations (nothing stale)"
        : `mesh reservations held by peers:\n${rows.join("\n")}`;
    }
    case "broker": {
      const socket = brokerSocketPath(runtime.runtimeDir);
      let lock = "absent";
      try {
        const pid = Number(readFileSync(brokerLockPath(runtime.runtimeDir), "utf8").trim());
        if (Number.isFinite(pid)) lock = `pid=${pid} alive=${pidAlive(pid)}`;
      } catch {
        // no lock file
      }
      const uptimeS = Math.floor((Date.now() - runtime.startedAt) / 1000);
      return [
        "mesh broker:",
        `  socket: ${socket}`,
        `  lock: ${lock}`,
        `  online: ${runtime.client.isOnline()}`,
        `  session uptime: ${uptimeS}s`,
        `  failures: ledger=${runtime.ledgerFailures} transcript=${runtime.transcriptFailures} inject=${runtime.injectionFailures}`,
      ].join("\n");
    }
    case "log": {
      const arg = rest[0];
      if (arg === "on") {
        runtime.transcript.setEnabled(true);
        return "mesh: transcript ON (bodies redacted, retention applies)";
      }
      if (arg === "off") {
        runtime.transcript.setEnabled(false);
        return "mesh: transcript OFF";
      }
      return `mesh: transcript is ${runtime.transcript.isEnabled() ? "ON" : "OFF"}`;
    }
    case "inbox": {
      const inbox = runtime.deferredInbox;
      if (inbox === undefined) return "mesh: no deferred inbox on this session";
      if (rest.length === 0) return inbox.list();
      if (rest.length === 1 && rest[0] === "flush") {
        const count = inbox.flush();
        return `mesh: flushed ${count} deferred broadcast(s)`;
      }
      return "usage: /mesh inbox [flush]";
    }
    case "help":
      return HELP_TEXT;
    default:
      return `mesh: unknown subcommand '${sub}'\n${HELP_TEXT}`;
  }
}

export function applyMeshCommand(
  editor: V2CommandEditor,
  ensure: (sessionID: string) => Promise<MeshSessionRuntime>,
): void {
  const command: V2CommandDefinition = {
    name: "mesh",
    description:
      "mesh agent coms: status, join/leave rooms, alias, ping, stale, broker, log, inbox. " +
      "Rooms start at `default`; join others explicitly.",
    execute: async (input) => {
      // The chat stays CLEAN: outcomes are TUI notifications (toast bridge),
      // never injected messages. The sidebar reflects alias/rooms/agents.
      try {
        const runtime = await ensure(input.sessionID);
        const text = await runMeshCommand(runtime, meshArgs(input.prompt?.text));
        notifySession(runtime.stateDir, runtime.sessionId, text);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const runtime = runtimeBySession(input.sessionID);
        notifySession(runtime?.stateDir ?? stateDir(), input.sessionID, `mesh: ${message}`, "error");
      }
    },
  };
  editor.add(command);
}
