// shared/exec.ts — broker runtime executable resolution (compiled-host
// support, #8). Compiled hosts (omp, SEA bundles, bun-compiled apps) set
// process.execPath to the HOST BINARY, not a JS runtime: forking with the
// default execPath re-runs the host (agent CLI) instead of the broker.
// $MESH_BROKER_EXEC_PATH pins the runtime used to spawn the broker
// (client auto-spawn, `mesh broker start`, standalone watchdog).
// Orthogonal to $MESH_BROKER_ENTRY, which pins the script.

export const ENV_BROKER_EXEC = "MESH_BROKER_EXEC_PATH";

/**
 * Resolve the executable used to spawn the broker, in order:
 * 1. $MESH_BROKER_EXEC_PATH override (highest priority, trimmed).
 * 2. process.execPath — unchanged Node behavior when no override is set.
 */
export function brokerExecPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[ENV_BROKER_EXEC];
  if (override !== undefined && override.trim() !== "") return override.trim();
  return process.execPath;
}
