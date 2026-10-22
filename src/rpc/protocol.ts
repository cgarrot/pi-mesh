// rpc/protocol.ts — C: the subset of pi RPC mode we drive.
// Records are strict JSONL: one JSON object per line, split on LF only
// (U+2028/U+2029 are valid inside JSON strings and must not split records).
export interface RpcResponse {
  id?: string;
  type: "response";
  command: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface RpcEventRecord {
  type: string;
  [key: string]: unknown;
}

/** `get_state` data (the real RPC command; there is no `get_queue`). */
export interface RpcState {
  pendingMessageCount?: number;
  steeringMode?: string;
  followUpMode?: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
  sessionName?: string;
  [key: string]: unknown;
}

export type SteeringMode = "all" | "one-at-a-time";

export interface RpcWorkerOptions {
  cwd: string;
  model?: string;
  name?: string;
  /** Test/embedding override: spawn exactly this argv (no pi flags added). */
  command?: { bin: string; args: string[] };
  env?: NodeJS.ProcessEnv;
  defaultTimeoutMs?: number;
}
