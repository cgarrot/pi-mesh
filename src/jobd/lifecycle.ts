// jobd/lifecycle.ts — A: make sure the detached job daemon is running.
// The daemon must outlive the pi session; ensureJobd spawns it detached and
// waits for the 0600 socket. Callers get a stateless JobdClient.
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { JobdClient } from "./client.js";

const START_TIMEOUT_MS = 5_000;
const pending = new Map<string, Promise<JobdClient>>();

async function reachable(client: JobdClient, socketPath: string): Promise<boolean> {
  if (!existsSync(socketPath)) return false;
  try {
    await client.list();
    return true;
  } catch {
    return false;
  }
}

export async function ensureJobd(opts: {
  socketPath: string;
  stateDir: string;
  owner: string;
  /** false = local-only daemon (tests / mesh deliberately disabled). */
  mesh?: boolean;
}): Promise<JobdClient> {
  const client = new JobdClient({ socketPath: opts.socketPath });
  if (await reachable(client, opts.socketPath)) return client;

  const existing = pending.get(opts.socketPath);
  if (existing !== undefined) return existing;

  const task = (async (): Promise<JobdClient> => {
    mkdirSync(opts.stateDir, { recursive: true });
    const daemonPath = fileURLToPath(new URL("./daemon.js", import.meta.url));
    const logFd = openSync(join(opts.stateDir, "jobd.log"), "a");
    const args = [
      daemonPath,
      "--socket",
      opts.socketPath,
      "--state-dir",
      opts.stateDir,
      "--owner",
      opts.owner,
    ];
    if (opts.mesh === false) args.push("--no-mesh");
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
      cwd: process.cwd(),
    });
    closeSync(logFd);
    child.unref();

    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      if (await reachable(client, opts.socketPath)) return client;
    }
    throw new Error(`jobd_unavailable: daemon did not start (see ${join(opts.stateDir, "jobd.log")})`);
  })().finally(() => pending.delete(opts.socketPath));

  pending.set(opts.socketPath, task);
  return task;
}
