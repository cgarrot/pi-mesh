// jobd/protocol.ts — A: local supervisor protocol (Unix socket, JSON-lines).
// This socket is 0600 and same-user only: `run` is equivalent to the local
// bash tool. The MESH control plane only carries stop/pause/resume (see envelope).
export type JobState = "running" | "paused" | "exited" | "stopped" | "failed" | "lost";

export interface JobRecord {
  jobId: string;
  pid?: number;
  command: string;
  cwd: string;
  owner: string;
  state: JobState;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  logPath: string;
  daemonAlias?: string;
  /** v2: the job explicitly opted into SIGSTOP/SIGCONT. */
  pausable?: boolean;
}

export type JobdRequest =
  | { id: string; cmd: "run"; command: string; cwd: string; owner: string; pausable?: boolean }
  | { id: string; cmd: "pause"; jobId: string }
  | { id: string; cmd: "resume"; jobId: string }
  | { id: string; cmd: "status"; jobId: string }
  | { id: string; cmd: "list"; owner?: string }
  | { id: string; cmd: "stop"; jobId: string; graceMs?: number };

export type JobdResponse =
  | { id: string; ok: true; job?: JobRecord; jobs?: JobRecord[]; status?: string }
  | { id: string; ok: false; error: string };
