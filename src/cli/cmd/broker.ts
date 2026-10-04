// cli/cmd/broker.ts — local broker lifecycle (spawn detached / SIGTERM / probe).
import { readFileSync } from "node:fs";
import { say, sayErr } from "../out.js";
import { EXIT_OK, EXIT_MESH_FAILURE, EXIT_USAGE } from "../codes.js";
import { STATUS_REQ_TIMEOUT_MS } from "../../shared/config.js";
import { brokerLockPath, brokerSocketPath, runtimeDir } from "../../shared/paths.js";
import { connectProbe } from "../../client/reconnect.js";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function cmdBroker(sub: string | undefined): Promise<number> {
  const dir = runtimeDir();
  const sock = brokerSocketPath(dir);
  switch (sub) {
    case "start": {
      const { spawn } = await import("node:child_process");
      const { brokerEntryPath } = await import("../../client/reconnect.js");
      const child = spawn(process.execPath, [brokerEntryPath()], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, MESH_RUNTIME_DIR: dir },
      });
      child.unref();
      say(`broker spawned pid=${child.pid ?? "?"} sock=${sock}`);
      return EXIT_OK;
    }
    case "stop": {
      try {
        const pid = Number(readFileSync(brokerLockPath(dir), "utf8").trim());
        if (Number.isFinite(pid) && pidAlive(pid)) {
          process.kill(pid, "SIGTERM");
          say(`SIGTERM sent to broker pid=${pid}`);
          return EXIT_OK;
        }
      } catch {
        // no lock
      }
      say("no live broker lock found");
      return EXIT_MESH_FAILURE;
    }
    case "status": {
      const alive = await connectProbe(sock, STATUS_REQ_TIMEOUT_MS);
      let pid = "?";
      try {
        pid = readFileSync(brokerLockPath(dir), "utf8").trim();
      } catch {
        // no lock
      }
      say(`socket=${sock} reachable=${alive} lockPid=${pid}`);
      return alive ? EXIT_OK : EXIT_MESH_FAILURE;
    }
    default:
      sayErr("usage: mesh broker start|stop|status");
      return EXIT_USAGE;
  }
}
