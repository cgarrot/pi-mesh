// test/helpers.ts — hermetic test utilities: mkdtemp dirs, real in-process
// brokers, raw NDJSON socket clients, bounded waitFor. No shared state (I-safe).
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import net, { type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { createBroker, type RunningBroker } from "../src/broker/broker.js";
import { DEFAULT_POLICY, type MeshPolicy } from "../src/broker/policy.js";
import {
  buildFrame,
  parseFrameLine,
  type BuildFrameOpts,
  type MeshFrame,
} from "../src/protocol/envelope.js";
import { encodeFrame, FrameDecoder } from "../src/protocol/frames.js";
import {
  DEFAULT_CONFIG,
  DEFAULT_MAX_FRAME_BYTES,
  type MeshConfig,
} from "../src/shared/config.js";
import { socketPathForDir } from "../src/shared/paths.js";

export interface TempDirs {
  root: string;
  runtimeDir: string;
  stateDir: string;
  cleanup: () => void;
}

/** Hermetic per-test dirs (no shared runtimeDir/stateDir across tests). */
export function makeTempDirs(prefix = "mesh-test-"): TempDirs {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  const runtimeDir = path.join(root, "run");
  const stateDir = path.join(root, "state");
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  return {
    root,
    runtimeDir,
    stateDir,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // best effort
      }
    },
  };
}

export interface BrokerOverrides {
  config?: Partial<MeshConfig>;
  policy?: Partial<MeshPolicy>;
}

/** Start a REAL broker on a unix socket inside runtimeDir (mkdtemp). */
export async function startTestBroker(
  runtimeDir: string,
  overrides: BrokerOverrides = {},
): Promise<RunningBroker> {
  mkdirSync(runtimeDir, { recursive: true });
  const socketPath = socketPathForDir(runtimeDir);
  rmSync(socketPath, { force: true }); // stale socket from a previous broker
  const config: MeshConfig = { ...DEFAULT_CONFIG, ...overrides.config };
  const policy: MeshPolicy = {
    ...DEFAULT_POLICY,
    ...overrides.policy,
    rateLimits: { ...DEFAULT_POLICY.rateLimits, ...overrides.policy?.rateLimits },
  };
  return createBroker({ config, policy, socketPath });
}

export function brokerSocketPathOf(runtimeDir: string): string {
  return socketPathForDir(runtimeDir);
}

/** Bounded poll — every test wait goes through here (suite stays < 60 s). */
export async function waitFor<T>(
  fn: () => T | undefined | false,
  timeoutMs = 3000,
  intervalMs = 10,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > deadline) throw new Error(`waitFor timeout (${timeoutMs}ms)`);
    await sleep(intervalMs);
  }
}

export function sleep(ms: number): Promise<void> {
  // NOTE: ref'd on purpose — tests must keep the event loop alive while
  // awaiting resolutions driven by the (unref'd) timers under test.
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Keep the event loop alive until `p` settles (SUT timers may be unref'd). */
export async function withKeepAlive<T>(p: Promise<T>): Promise<T> {
  const iv = setInterval(() => {}, 50);
  try {
    return await p;
  } finally {
    clearInterval(iv);
  }
}

/**
 * Raw NDJSON client (node:net) for broker-level tests: no handshake magic,
 * full control over what goes on the wire (invalid frames included).
 */
export class RawClient {
  readonly frames: MeshFrame[] = [];
  closed = false;
  private readonly decoder: FrameDecoder;

  private constructor(
    private readonly socket: Socket,
    private readonly maxBytes: number,
  ) {
    this.decoder = new FrameDecoder(maxBytes);
    socket.on("data", (chunk) => {
      let lines: string[] = [];
      try {
        lines = this.decoder.push(chunk);
      } catch {
        return; // oversized partial — broker-side tests only
      }
      for (const line of lines) {
        const parsed = parseFrameLine(line);
        if (parsed.ok) this.frames.push(parsed.frame);
      }
    });
    socket.on("close", () => {
      this.closed = true;
    });
    socket.on("error", () => {});
  }

  static connect(socketPath: string, maxBytes: number = DEFAULT_MAX_FRAME_BYTES): Promise<RawClient> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      socket.once("connect", () => resolve(new RawClient(socket, maxBytes)));
      socket.once("error", reject);
    });
  }

  /** Build + send a frame (buildFrame does NOT validate — invalid frames OK). */
  send(opts: BuildFrameOpts): void {
    this.socket.write(encodeFrame(buildFrame(opts), this.maxBytes));
  }

  /** Send a pre-built (possibly mutated/invalid) frame object. */
  sendFrame(frame: MeshFrame): void {
    this.socket.write(encodeFrame(frame, this.maxBytes));
  }

  /** Raw bytes on the wire (oversized / malformed lines). */
  sendRaw(data: string | Buffer): void {
    this.socket.write(data);
  }

  /** First matching frame (scans the full history every poll). */
  waitFrame(pred: (f: MeshFrame) => boolean, timeoutMs = 3000): Promise<MeshFrame> {
    return waitFor(() => this.frames.find(pred), timeoutMs);
  }

  /** Wait until at least n frames match. */
  waitFrames(pred: (f: MeshFrame) => boolean, n: number, timeoutMs = 3000): Promise<MeshFrame[]> {
    return waitFor(() => {
      const m = this.frames.filter(pred);
      return m.length >= n ? m : undefined;
    }, timeoutMs);
  }

  /** Bounded wait for socket close. */
  waitClosed(timeoutMs = 3000): Promise<boolean> {
    return waitFor(() => (this.closed ? true : undefined), timeoutMs);
  }

  hello(
    alias: string,
    rooms?: string[],
    role?: "member" | "observer",
    caps?: string[],
    proto?: number,
  ): void {
    this.send({ type: "hello", from: alias, rooms, role, caps, proto });
  }

  close(): void {
    this.socket.destroy();
  }
}
