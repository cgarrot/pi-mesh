// jobd/daemon.ts — A: detached local job supervisor (Unix socket, 0600).
// Why a daemon: a pi session (and its LLM) must not be the parent of long
// work. Jobs run in their own process group, survive the session, and can be
// stopped by the daemon without waking the target's model.
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { makeMsgId, nowIso } from "../protocol/frames.js";
import type { JobdRequest, JobdResponse, JobRecord } from "./protocol.js";
import { attachMeshToDaemon, connectDaemonMesh } from "./mesh.js";
import type { MeshClient } from "../client/client.js";

const STOP_GRACE_MS = 5_000;
const MAX_COMMAND_CHARS = 8_192;

export interface JobDaemonOptions {
  socketPath: string;
  stateDir: string;
  owner: string;
  daemonAlias?: string;
}

interface InternalJob extends JobRecord {
  stopRequested?: boolean;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class JobDaemon {
  readonly socketPath: string;
  readonly stateDir: string;
  readonly owner: string;
  readonly daemonAlias: string;
  private readonly jobsDir: string;
  private readonly jobs = new Map<string, InternalJob>();
  private server: Server | null = null;
  private started = false;
  private meshAliasValue: string;

  constructor(opts: JobDaemonOptions) {
    this.socketPath = opts.socketPath;
    this.stateDir = opts.stateDir;
    this.owner = opts.owner;
    this.daemonAlias = opts.daemonAlias ?? `${opts.owner}-jobd`;
    this.meshAliasValue = this.daemonAlias;
    this.jobsDir = join(opts.stateDir, "jobs");
  }

  async start(): Promise<void> {
    if (this.started) return;
    mkdirSync(this.jobsDir, { recursive: true });
    await this.prepareSocket();
    this.server = createServer((socket) => this.onConnection(socket));
    await new Promise<void>((resolveListen, rejectListen) => {
      this.server!.once("error", rejectListen);
      this.server!.listen(this.socketPath, () => {
        this.server!.removeListener("error", rejectListen);
        resolveListen();
      });
    });
    try {
      // Same-user only: the socket is the local trust boundary (run == bash).
      chmodSync(this.socketPath, 0o600);
    } catch {
      // non-POSIX hosts: best effort
    }
    try {
      writeFileSync(join(this.stateDir, "jobd.pid"), `${process.pid}\n`, "utf8");
    } catch {
      // best effort
    }
    this.started = true;
    // Only after the socket is OURS: a daemon that lost the race must not
    // rewrite live jobs as lost in the shared registry.
    this.loadRegistry();
  }

  async close(): Promise<void> {
    if (this.server !== null) {
      await new Promise<void>((resolveClose) => this.server!.close(() => resolveClose()));
      this.server = null;
    }
    try {
      if (existsSync(this.socketPath)) unlinkSync(this.socketPath);
      const pidFile = join(this.stateDir, "jobd.pid");
      if (existsSync(pidFile)) unlinkSync(pidFile);
    } catch {
      // best effort
    }
    // Never leave a job SIGSTOPed forever because its daemon went away.
    for (const job of this.jobs.values()) {
      if (job.state !== "paused" || job.pid === undefined) continue;
      if (!this.isAlive(job.pid)) {
        job.state = "failed";
        job.endedAt = nowIso();
      } else {
        this.signalGroup(job.pid, "SIGCONT");
        job.state = "running";
      }
      this.persist(job);
    }
    this.started = false;
    // Jobs are detached on purpose: shutting the daemon down must not kill
    // work. A restart marks them lost (no re-attach in v1).
  }

  run(opts: { command: string; cwd: string; owner: string; pausable?: boolean }): JobRecord {
    const command = opts.command.trim();
    if (command.length === 0 || command.length > MAX_COMMAND_CHARS) {
      throw new Error("jobd_invalid: command must be 1..8192 chars");
    }
    const cwd = resolve(opts.cwd);
    if (!existsSync(cwd)) throw new Error(`jobd_invalid: cwd does not exist: ${cwd}`);
    const jobId = `j_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const logPath = join(this.jobsDir, `${jobId}.log`);
    const fd = openSync(logPath, "a");
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("/bin/bash", ["-lc", command], {
        cwd,
        detached: true,
        stdio: ["ignore", fd, fd],
        env: process.env,
      });
    } finally {
      closeSync(fd);
    }
    const pid = child.pid ?? -1;
    const job: InternalJob = {
      jobId,
      pid: pid > 0 ? pid : undefined,
      command,
      cwd,
      owner: opts.owner,
      state: "running",
      startedAt: nowIso(),
      logPath,
      daemonAlias: this.meshAliasValue,
      pausable: opts.pausable === true ? true : undefined,
    };
    this.jobs.set(jobId, job);
    this.persist(job);
    child.once("exit", (code, signal) => {
      // paused is NOT terminal: an externally killed/OOM-killed paused job
      // must still record its real ending instead of staying "paused".
      if (job.state !== "running" && job.state !== "paused") return;
      job.state = job.stopRequested === true ? "stopped" : code === 0 ? "exited" : "failed";
      job.exitCode = code;
      job.signal = signal;
      job.endedAt = nowIso();
      this.persist(job);
    });
    child.once("error", () => {
      if (job.state !== "running") return;
      job.state = "failed";
      job.endedAt = nowIso();
      this.persist(job);
    });
    child.unref();
    return job;
  }

  /** The alias actually held after deterministic fallback (-2, -3, …). */
  get meshAlias(): string {
    return this.meshAliasValue;
  }

  setMeshAlias(alias: string): void {
    this.meshAliasValue = alias;
  }

  status(jobId: string): JobRecord | undefined {
    return this.jobs.get(jobId);
  }

  list(owner?: string): JobRecord[] {
    return [...this.jobs.values()]
      .filter((job) => owner === undefined || job.owner === owner)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  private isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private signalGroup(pid: number, sig: NodeJS.Signals): void {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        // already gone
      }
    }
  }

  /** SIGSTOP is opt-in: a job that did not declare pausable is never stopped. */
  pause(jobId: string): { status: "paused" | "not_pausable" | "not_running"; job?: JobRecord } {
    const job = this.jobs.get(jobId);
    if (job === undefined) return { status: "not_running" };
    if (job.pausable !== true) return { status: "not_pausable", job };
    if (job.state === "paused") return { status: "paused", job };
    if (job.state !== "running" || job.pid === undefined) return { status: "not_running", job };
    if (!this.isAlive(job.pid)) {
      job.state = "failed";
      job.endedAt = nowIso();
      this.persist(job);
      return { status: "not_running", job };
    }
    this.signalGroup(job.pid, "SIGSTOP");
    // The exit handler may have won the race while we signalled; never
    // overwrite a terminal record with "paused".
    if (job.state !== "running") return { status: "not_running", job };
    job.state = "paused";
    this.persist(job);
    return { status: "paused", job };
  }

  resume(jobId: string): { status: "resumed" | "not_paused" | "not_running"; job?: JobRecord } {
    const job = this.jobs.get(jobId);
    if (job === undefined) return { status: "not_running" };
    if (job.state !== "paused") return { status: "not_paused", job };
    if (job.pid === undefined || !this.isAlive(job.pid)) {
      job.state = "failed";
      job.endedAt = nowIso();
      this.persist(job);
      return { status: "not_running", job };
    }
    this.signalGroup(job.pid, "SIGCONT");
    job.state = "running";
    this.persist(job);
    return { status: "resumed", job };
  }

  async stop(jobId: string, graceMs = STOP_GRACE_MS): Promise<JobRecord | undefined> {
    const job = this.jobs.get(jobId);
    if (job === undefined) return undefined;
    if ((job.state !== "running" && job.state !== "paused") || job.pid === undefined) return job;
    job.stopRequested = true;
    const pid = job.pid;
    // A SIGSTOPed process will not act on SIGTERM until it is continued.
    if (job.state === "paused") {
      this.signalGroup(pid, "SIGCONT");
      job.state = "running";
      this.persist(job);
    }
    this.signalGroup(pid, "SIGTERM");
    const deadline = Date.now() + Math.max(100, graceMs);
    while (Date.now() < deadline && job.state === "running") {
      await sleep(50);
    }
    if (job.state === "running") {
      this.signalGroup(pid, "SIGKILL");
      const killDeadline = Date.now() + 500;
      while (Date.now() < killDeadline && job.state === "running") await sleep(25);
    }
    if (job.state === "running") {
      // The exit handler did not fire (rare). Record the honest terminal state.
      job.state = "stopped";
      job.endedAt = nowIso();
      this.persist(job);
    }
    return job;
  }

  private async prepareSocket(): Promise<void> {
    if (!existsSync(this.socketPath)) return;
    const live = await new Promise<boolean>((resolveLive) => {
      const probe = createConnection(this.socketPath);
      const done = (value: boolean): void => {
        probe.destroy();
        resolveLive(value);
      };
      probe.once("connect", () => done(true));
      probe.once("error", () => done(false));
      setTimeout(() => done(false), 300).unref();
    });
    if (live) throw new Error("jobd_already_running: another daemon owns the socket");
    try {
      unlinkSync(this.socketPath);
    } catch {
      // best effort
    }
  }

  private onConnection(socket: Socket): void {
    const lines = createInterface({ input: socket });
    socket.on("error", () => {});
    lines.once("line", (line) => {
      void this.handleLine(socket, line);
    });
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    let request: JobdRequest;
    try {
      request = JSON.parse(line) as JobdRequest;
    } catch {
      this.reply(socket, { id: "?", ok: false, error: "jobd_bad_request: invalid JSON" });
      return;
    }
    try {
      const response = await this.handle(request);
      this.reply(socket, response);
    } catch (err) {
      this.reply(socket, {
        id: request.id ?? "?",
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handle(request: JobdRequest): Promise<JobdResponse> {
    switch (request.cmd) {
      case "run": {
        if (typeof request.owner !== "string" || request.owner.length === 0) {
          return { id: request.id, ok: false, error: "jobd_invalid: owner is required" };
        }
        const job = this.run({
          command: request.command,
          cwd: request.cwd,
          owner: request.owner,
          pausable: request.pausable === true,
        });
        return { id: request.id, ok: true, job };
      }
      case "status": {
        const job = this.status(String(request.jobId));
        return job === undefined
          ? { id: request.id, ok: false, error: "job_not_found" }
          : { id: request.id, ok: true, job };
      }
      case "list":
        return { id: request.id, ok: true, jobs: this.list(request.owner) };
      case "pause": {
        const out = this.pause(String(request.jobId));
        if (out.job === undefined) return { id: request.id, ok: false, error: "job_not_found" };
        return { id: request.id, ok: true, job: out.job, status: out.status };
      }
      case "resume": {
        const out = this.resume(String(request.jobId));
        if (out.job === undefined) return { id: request.id, ok: false, error: "job_not_found" };
        return { id: request.id, ok: true, job: out.job, status: out.status };
      }
      case "stop": {
        const job = await this.stop(String(request.jobId), request.graceMs);
        return job === undefined
          ? { id: request.id, ok: false, error: "job_not_found" }
          : { id: request.id, ok: true, job };
      }
      default:
        return { id: "?", ok: false, error: "jobd_bad_request: unknown cmd" };
    }
  }

  private reply(socket: Socket, response: JobdResponse): void {
    try {
      socket.write(`${JSON.stringify(response)}\n`);
    } finally {
      socket.end();
    }
  }

  private persist(job: JobRecord): void {
    const target = join(this.jobsDir, `${job.jobId}.json`);
    const tmp = `${target}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify(job, null, 2)}\n`, "utf8");
      renameSync(tmp, target);
    } catch {
      // Registry persistence is best effort; the in-memory table is primary.
    }
  }

  private loadRegistry(): void {
    let names: string[] = [];
    try {
      names = readdirSync(this.jobsDir).filter((name) => name.endsWith(".json"));
    } catch {
      return;
    }
    for (const name of names) {
      try {
        const raw = JSON.parse(readFileSync(join(this.jobsDir, name), "utf8")) as InternalJob;
        if (typeof raw.jobId !== "string") continue;
        // A restarted daemon cannot re-attach to an existing process tree.
        if (raw.state === "running" || raw.state === "paused") {
          raw.state = "lost";
          raw.endedAt = nowIso();
        }
        this.jobs.set(raw.jobId, raw);
        this.persist(raw);
      } catch {
        // skip corrupt records
      }
    }
  }
}

// ---- entry point (detached spawn target) ----

function argValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const socketPath = argValue(process.argv, "--socket");
  const stateDir = argValue(process.argv, "--state-dir");
  const owner = argValue(process.argv, "--owner");
  if (socketPath === undefined || stateDir === undefined || owner === undefined) {
    process.stderr.write("jobd: --socket, --state-dir and --owner are required\n");
    process.exit(2);
  }
  const daemon = new JobDaemon({
    socketPath,
    stateDir,
    owner,
    daemonAlias: argValue(process.argv, "--daemon-alias"),
  });
  await daemon.start();
  let mesh: MeshClient | null = null;
  if (!process.argv.includes("--no-mesh")) {
    try {
      const connected = await connectDaemonMesh({
        owner,
        daemonAlias: daemon.daemonAlias,
        stateDir,
        socketPath,
      });
      daemon.setMeshAlias(connected.alias);
      attachMeshToDaemon(daemon, connected);
      mesh = connected;
    } catch (err) {
      process.stderr.write(`jobd: mesh unavailable (${err instanceof Error ? err.message : String(err)}); local jobs still run\n`);
    }
  }
  process.stderr.write(`jobd: ready socket=${socketPath} owner=${owner} alias=${daemon.daemonAlias}\n`);
  const shutdown = (): void => {
    void (mesh?.close() ?? Promise.resolve())
      .catch(() => {})
      .then(() => daemon.close())
      .finally(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((err: unknown) => {
    process.stderr.write(`jobd: fatal ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
