// jobd/client.ts — A: thin Unix-socket client for the local job daemon.
// One connection per request keeps it stateless and easy to test; the daemon
// accepts concurrent connections. The socket is 0600 (same-user trust).
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { makeMsgId } from "../protocol/frames.js";
import type { JobdRequest, JobdResponse, JobRecord } from "./protocol.js";

export class JobdClient {
  private readonly timeoutMs: number;

  constructor(private readonly opts: { socketPath: string; timeoutMs?: number }) {
    this.timeoutMs = opts.timeoutMs ?? 5_000;
  }

  get socketPath(): string {
    return this.opts.socketPath;
  }

  private call(request: JobdRequest, timeoutMs = this.timeoutMs): Promise<JobdResponse> {
    return new Promise((resolve, reject) => {
      const socket = connect(this.opts.socketPath);
      const lines = createInterface({ input: socket });
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        lines.removeAllListeners();
        socket.removeAllListeners();
        // A late connect error (ENOENT/ECONNREFUSED) must not become an
        // uncaught exception after we already settled this request.
        socket.on("error", () => {});
        socket.destroy();
        fn();
      };
      const timer = setTimeout(() => finish(() => reject(new Error("jobd_timeout"))), timeoutMs);
      timer.unref();
      socket.once("error", (err) => finish(() => reject(err)));
      lines.once("line", (line) => {
        finish(() => {
          try {
            resolve(JSON.parse(line) as JobdResponse);
          } catch (err) {
            reject(err);
          }
        });
      });
      socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    });
  }

  private async expect(request: JobdRequest, timeoutMs?: number): Promise<JobdResponse & { ok: true }> {
    const res = await this.call(request, timeoutMs);
    if (!res.ok) throw new Error(res.error);
    return res;
  }

  async run(opts: { command: string; cwd: string; owner: string; pausable?: boolean }): Promise<JobRecord> {
    const res = await this.expect({ id: makeMsgId(), cmd: "run", ...opts });
    if (res.job === undefined) throw new Error("jobd_protocol_error: missing job");
    return res.job;
  }

  async status(jobId: string): Promise<JobRecord | undefined> {
    const res = await this.expect({ id: makeMsgId(), cmd: "status", jobId });
    return res.job;
  }

  async list(owner?: string): Promise<JobRecord[]> {
    const res = await this.expect({ id: makeMsgId(), cmd: "list", owner });
    return res.jobs ?? [];
  }

  async pause(jobId: string): Promise<{ status: string; job?: JobRecord }> {
    const res = await this.expect({ id: makeMsgId(), cmd: "pause", jobId });
    return { status: res.status ?? "paused", job: res.job };
  }

  async resume(jobId: string): Promise<{ status: string; job?: JobRecord }> {
    const res = await this.expect({ id: makeMsgId(), cmd: "resume", jobId });
    return { status: res.status ?? "resumed", job: res.job };
  }

  async stop(jobId: string, graceMs = 5_000): Promise<JobRecord | undefined> {
    // The daemon may use the full grace before SIGKILL; the client must wait
    // for grace + margin or it would report a timeout for a successful stop.
    const timeout = Math.max(this.timeoutMs, graceMs + 2_000);
    const res = await this.expect({ id: makeMsgId(), cmd: "stop", jobId, graceMs }, timeout);
    return res.job;
  }

  close(): void {
    // Stateless client: nothing to release. Kept for API symmetry.
  }
}
