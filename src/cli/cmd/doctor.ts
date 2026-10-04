// cli/cmd/doctor.ts — endpoint/auth/config diagnostics. Exit 1 when the
// broker is unreachable. The token is NEVER printed (D9) — only its hash
// prefix so operators can compare configs without leaking secrets.
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { say } from "../out.js";
import { EXIT_OK, EXIT_MESH_FAILURE } from "../codes.js";
import { loadConfig, parseEndpoint, STATUS_REQ_TIMEOUT_MS } from "../../shared/config.js";
import { brokerLockPath, brokerSocketPath, configPath, policyPath, runtimeDir, stateDir } from "../../shared/paths.js";
import { loadPolicy } from "../../broker/policy.js";
import { connectProbe, connectProbeTcp } from "../../client/reconnect.js";
import { MESH_VERSION } from "../../shared/version.js";

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function cmdDoctor(): Promise<number> {
  const dir = runtimeDir();
  const sock = brokerSocketPath(dir);
  const lock = brokerLockPath(dir);
  const cfg = loadConfig(stateDir());
  const url = cfg.brokerUrl;
  const listen = cfg.listen;
  const endpoint = url !== undefined ? parseEndpoint(url) : null;
  const reachable = endpoint === null
    ? await connectProbe(sock, STATUS_REQ_TIMEOUT_MS)
    : endpoint.kind === "unix"
      ? await connectProbe(endpoint.path, STATUS_REQ_TIMEOUT_MS)
      : await connectProbeTcp(endpoint.host, endpoint.port, STATUS_REQ_TIMEOUT_MS);

  let lockInfo = "absent";
  let stale = false;
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, "utf8").trim());
    if (Number.isFinite(pid)) {
      const alive = pidAlive(pid);
      lockInfo = `pid=${pid} alive=${alive}`;
      stale = !alive;
    } else {
      lockInfo = "present (no pid)";
    }
  }

  let cfgInfo = "absent (defaults)";
  if (existsSync(configPath(stateDir()))) cfgInfo = configPath(stateDir());

  // T1 visibility: force (and interrupt) is DENIED until the policy opts
  // in — say so instead of letting senders discover it the hard way.
  let forceInfo = "denied by default (forceAllowedFrom empty) — see README \"Unblocking a stuck agent\"";
  try {
    const policy = loadPolicy(policyPath(stateDir()));
    if (policy.forceAllowedFrom.length > 0) forceInfo = `allowed from: ${policy.forceAllowedFrom.join(",")}`;
  } catch {
    // unreadable policy — keep the default hint
  }

  const tokenInfo =
    cfg.brokerToken !== undefined && cfg.brokerToken !== ""
      ? `set (sha256:${createHash("sha256").update(cfg.brokerToken, "utf8").digest("hex").slice(0, 8)})`
      : "absent";

  for (const line of [
    `runtimeDir: ${dir}`,
    url !== undefined ? `endpoint: ${url} reachable=${reachable}` : `socket: ${sock} reachable=${reachable}`,
    `brokerUrl: ${url ?? "(local unix socket)"}`,
    `listen: ${listen ?? "(unix socket)"}`,
    `lock: ${lockInfo}${stale ? " STALE" : ""}`,
    `config: ${cfgInfo}`,
    `force: ${forceInfo}`,
    `token: ${tokenInfo}`,
    `protocol: mesh.v1`,
    `cliVersion: ${MESH_VERSION}`,
  ]) {
    say(line);
  }
  return reachable ? EXIT_OK : EXIT_MESH_FAILURE;
}
