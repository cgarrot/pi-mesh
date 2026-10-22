// jobd/mesh.ts — A: the daemon's control-plane face.
// The daemon is a mesh peer (`<owner>-jobd`, caps ["jobd"]) so a stop command
// is executed immediately by this process, not by the target session's LLM.
// The mesh protocol only carries action=stop|pause|resume + target jobId
// (validated in envelope.ts) — no shell strings.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MeshClient } from "../client/client.js";
import type { MeshFrame } from "../protocol/envelope.js";
import type { JobDaemon } from "./daemon.js";

export function attachMeshToDaemon(daemon: JobDaemon, mesh: MeshClient): void {
  mesh.on("inbound", (frame: MeshFrame) => {
    if (frame.type !== "control") return;
    const target = frame.target;
    const from = frame.from;
    if (from === undefined) return;
    if (target === undefined) {
      mesh.sendControlAck({
        to: from,
        replyTo: frame.id,
        target: "unknown",
        status: "error",
        detail: "control without target",
      });
      return;
    }
    if (frame.action === "pause") {
      const out = daemon.pause(target);
      if (out.job === undefined) {
        mesh.sendControlAck({ to: from, replyTo: frame.id, target, status: "not_found" });
      } else if (out.status === "not_pausable") {
        mesh.sendControlAck({ to: from, replyTo: frame.id, target, status: "not_pausable", detail: "start it with pausable:true" });
      } else if (out.status === "paused") {
        mesh.sendControlAck({ to: from, replyTo: frame.id, target, status: "paused", detail: `state=${out.job.state}` });
      } else {
        mesh.sendControlAck({ to: from, replyTo: frame.id, target, status: "error", detail: `cannot pause (state=${out.job.state})` });
      }
      return;
    }
    if (frame.action === "resume") {
      const out = daemon.resume(target);
      if (out.job === undefined) {
        mesh.sendControlAck({ to: from, replyTo: frame.id, target, status: "not_found" });
      } else if (out.status === "resumed") {
        mesh.sendControlAck({ to: from, replyTo: frame.id, target, status: "resumed", detail: `state=${out.job.state}` });
      } else {
        mesh.sendControlAck({ to: from, replyTo: frame.id, target, status: "error", detail: `cannot resume (state=${out.job.state})` });
      }
      return;
    }
    if (frame.action !== "stop") {
      mesh.sendControlAck({ to: from, replyTo: frame.id, target, status: "error", detail: "unsupported control action" });
      return;
    }
    void daemon
      .stop(target, 5_000)
      .then((job) => {
        if (job === undefined) {
          mesh.sendControlAck({ to: from, replyTo: frame.id, target, status: "not_found" });
          return;
        }
        if (job.state === "lost") {
          mesh.sendControlAck({
            to: from,
            replyTo: frame.id,
            target,
            status: "error",
            detail: "orphaned by daemon restart (state=lost); the OS process cannot be re-attached in v1",
          });
          return;
        }
        mesh.sendControlAck({
          to: from,
          replyTo: frame.id,
          target,
          status: "stopped",
          detail: `state=${job.state}`,
        });
      })
      .catch((err: unknown) => {
        mesh.sendControlAck({
          to: from,
          replyTo: frame.id,
          target,
          status: "error",
          detail: err instanceof Error ? err.message : String(err),
        });
      });
  });
}

/** Deterministic alias fallback: `<owner>-jobd`, `<owner>-jobd-2`, … .
 *  The actual alias is written to <stateDir>/daemon.json so callers can
 *  address the daemon after a collision. strictAlias keeps the client from
 *  silently taking a random agent-* identity. */
export async function connectDaemonMesh(opts: {
  owner: string;
  daemonAlias: string;
  runtimeDir?: string;
  stateDir?: string;
  socketPath?: string;
}): Promise<MeshClient> {
  const canonical = opts.daemonAlias;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const alias = attempt === 1 ? canonical : `${canonical}-${attempt}`;
    const mesh = new MeshClient({
      alias,
      strictAlias: true,
      runtimeDir: opts.runtimeDir,
      config: { caps: ["jobd"] },
    });
    try {
      await mesh.connect();
      if (opts.stateDir !== undefined) {
        try {
          mkdirSync(opts.stateDir, { recursive: true });
          writeFileSync(
            join(opts.stateDir, "daemon.json"),
            `${JSON.stringify(
              {
                alias: mesh.alias,
                canonical,
                owner: opts.owner,
                socketPath: opts.socketPath,
                pid: process.pid,
                updatedAt: new Date().toISOString(),
              },
              null,
              2,
            )}\n`,
            "utf8",
          );
        } catch {
          // best effort
        }
      }
      return mesh;
    } catch (err) {
      lastErr = err;
      await mesh.close().catch(() => {});
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("alias_taken")) throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("jobd_alias_unavailable");
}
