// rpc/worker.ts — C: a controller-owned headless pi worker.
// Why not the host's RpcClient: pi-mesh must not depend on the host package
// (extensions are installed separately). This is the minimal JSONL client for
// the commands C needs: prompt/steer/follow_up/abort/abort_bash/get_queue/
// set_steering_mode/stop.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type {
  RpcEventRecord,
  RpcState,
  RpcResponse,
  RpcWorkerOptions,
  SteeringMode,
} from "./protocol.js";

const STDERR_RING = 8 * 1024;
const MAX_LINE_BYTES = 1_048_576; // a line without LF beyond this = protocol_error

interface Pending {
  resolve: (response: RpcResponse) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class RpcWorker extends EventEmitter {
  readonly cwd: string;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  private readonly timeoutMs: number;
  private stdoutBuf = "";
  private stderrBuf = "";
  private seq = 0;
  private stopped = false;

  constructor(opts: RpcWorkerOptions) {
    super();
    this.cwd = opts.cwd;
    this.timeoutMs = opts.defaultTimeoutMs ?? 30_000;
    const cmd = opts.command ?? defaultPiCommand(opts);
    this.child = spawn(cmd.bin, cmd.args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      // Controller-owned: stop() is responsible for cleanup; no orphans.
      detached: false,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    // A failed spawn can surface on any of the stdio streams; never let an
    // unhandled 'error' become an uncaughtException.
    this.child.stdout.on("error", () => {});
    this.child.stderr.on("error", () => {});
    this.child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrBuf = (this.stderrBuf + chunk).slice(-STDERR_RING);
    });
    this.child.on("error", (err) => {
      this.stopped = true;
      this.failPending(err);
      // EventEmitter throws on an unhandled "error" event; only re-emit when
      // a consumer is listening.
      if (this.listenerCount("error") > 0) this.emit("error", err);
    });
    this.child.on("exit", (code, signal) => {
      this.stopped = true;
      this.failPending(new Error(`rpc_worker_exited (code=${code ?? "null"} signal=${signal ?? "null"})`));
      this.emit("exit", { code, signal });
    });
    // EPIPE while shutting down must not crash the controller.
    this.child.stdin.on("error", () => {});
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get alive(): boolean {
    return !this.stopped && this.child.exitCode === null;
  }

  get stderrTail(): string {
    return this.stderrBuf;
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    if (this.stdoutBuf.length > MAX_LINE_BYTES) {
      this.emit("protocol_error", { line: this.stdoutBuf.slice(0, 200), reason: "line_too_long" });
      this.stdoutBuf = "";
    }
    for (;;) {
      const nl = this.stdoutBuf.indexOf("\n");
      if (nl < 0) break;
      let line = this.stdoutBuf.slice(0, nl);
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.trim() === "") continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        this.emit("protocol_error", { line });
        continue;
      }
      if (isResponse(record)) {
        const id = record.id;
        if (id !== undefined) {
          const waiter = this.pending.get(id);
          if (waiter !== undefined) {
            this.pending.delete(id);
            clearTimeout(waiter.timer);
            waiter.resolve(record);
            continue;
          }
        }
        this.emit("event", record);
        this.emit(record.type, record);
        continue;
      }
      if (isEvent(record)) {
        this.emit("event", record);
        this.emit(record.type, record);
      }
    }
  }

  request(command: Record<string, unknown> & { type: string }, timeoutMs = this.timeoutMs): Promise<RpcResponse> {
    if (!this.alive) return Promise.reject(new Error("rpc_worker_not_running"));
    const id = `rpc_${++this.seq}`;
    const payload = { id, ...command };
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rpc_timeout: ${command.type}`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, (err) => {
        if (err === null || err === undefined) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private async ok(command: Record<string, unknown> & { type: string }, timeoutMs?: number): Promise<unknown> {
    const res = await this.request(command, timeoutMs);
    if (!res.success) throw new Error(res.error ?? `${command.type} failed`);
    return res.data;
  }

  async prompt(
    message: string,
    opts: { streamingBehavior?: "steer" | "followUp"; timeoutMs?: number } = {},
  ): Promise<unknown> {
    return this.ok(
      {
        type: "prompt",
        message,
        ...(opts.streamingBehavior !== undefined ? { streamingBehavior: opts.streamingBehavior } : {}),
      },
      opts.timeoutMs,
    );
  }

  async steer(message: string, timeoutMs?: number): Promise<unknown> {
    return this.ok({ type: "steer", message }, timeoutMs);
  }

  async followUp(message: string, timeoutMs?: number): Promise<unknown> {
    return this.ok({ type: "follow_up", message }, timeoutMs);
  }

  async abort(timeoutMs?: number): Promise<unknown> {
    return this.ok({ type: "abort" }, timeoutMs);
  }

  /** Abort only the running bash tool; the turn survives and can be steered. */
  async abortBash(timeoutMs?: number): Promise<unknown> {
    return this.ok({ type: "abort_bash" }, timeoutMs);
  }

  /** Real pi command: state (pendingMessageCount/steeringMode/...). */
  async getState(timeoutMs?: number): Promise<RpcState> {
    return (await this.ok({ type: "get_state" }, timeoutMs)) as RpcState;
  }

  async setSteeringMode(mode: SteeringMode, timeoutMs?: number): Promise<unknown> {
    return this.ok({ type: "set_steering_mode", mode }, timeoutMs);
  }

  /** Wait for one event type (optionally filtered). Subscribe via the event
   *  emitter for streams; this helper is for run-level synchronization. */
  waitForEvent(
    type: string,
    predicate: (event: RpcEventRecord) => boolean = () => true,
    timeoutMs = this.timeoutMs,
  ): Promise<RpcEventRecord> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener(type, handler);
        reject(new Error(`rpc_event_timeout: ${type}`));
      }, timeoutMs);
      timer.unref();
      const handler = (event: RpcEventRecord): void => {
        if (!predicate(event)) return;
        clearTimeout(timer);
        this.removeListener(type, handler);
        resolve(event);
      };
      this.on(type, handler);
    });
  }

  async stop(graceMs = 2_000): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.failPending(new Error("rpc_worker_stopped"));
    if (this.child.exitCode !== null) return;
    // Orderly shutdown first: closing stdin lets pi flush its session file.
    try {
      this.child.stdin.end();
    } catch {
      // already closed
    }
    this.child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.child.kill("SIGKILL");
        resolve();
      }, Math.max(100, graceMs));
      timer.unref();
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private failPending(err: Error): void {
    for (const [id, waiter] of this.pending) {
      this.pending.delete(id);
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
  }
}

function isResponse(value: unknown): value is RpcResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { type?: unknown }).type === "response" &&
    typeof (value as { command?: unknown }).command === "string" &&
    typeof (value as { success?: unknown }).success === "boolean"
  );
}

function isEvent(value: unknown): value is RpcEventRecord {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

function defaultPiCommand(opts: RpcWorkerOptions): { bin: string; args: string[] } {
  const args: string[] = [];
  const override = process.env.PI_RPC_BIN;
  if (override !== undefined && override !== "") {
    return { bin: override, args: ["--mode", "rpc", "--no-session", ...modelArgs(opts)] };
  }
  const entry = process.argv[1];
  if (entry !== undefined) {
    args.push(entry, "--mode", "rpc", "--no-session", ...modelArgs(opts));
    return { bin: process.execPath, args };
  }
  return { bin: "pi", args: ["--mode", "rpc", "--no-session", ...modelArgs(opts)] };
}

function modelArgs(opts: RpcWorkerOptions): string[] {
  const out: string[] = [];
  if (opts.model !== undefined) out.push("--model", opts.model);
  if (opts.name !== undefined) out.push("--name", opts.name);
  return out;
}
