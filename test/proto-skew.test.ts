// test/proto-skew.test.ts — a new client against a pre-v2 (legacy) broker.
// The detached broker outlives package upgrades, so a new client regularly
// meets an old broker. Cap sends and lease frames are protocol-2 only: the
// client must say "broker_too_old" instead of leaking a misleading
// invalid_alias or burning a 5 s timeout (honesty is a feature).
import assert from "node:assert/strict";
import net from "node:net";
import { describe, it } from "node:test";
import { MeshClient } from "../src/client/client.js";
import { buildFrame, parseFrameLine } from "../src/protocol/envelope.js";
import { encodeFrame, FrameDecoder } from "../src/protocol/frames.js";
import { DEFAULT_MAX_FRAME_BYTES } from "../src/shared/config.js";
import { brokerSocketPathOf, makeTempDirs } from "./helpers.js";

/** A legacy broker: welcomes the hello (no `proto` field) and acks every msg
 *  as delivered. It never answers lease frames — exactly what v1 did. */
async function startLegacyBroker(): Promise<{ close: () => Promise<void>; sock: string; dirs: ReturnType<typeof makeTempDirs> }> {
  const dirs = makeTempDirs();
  const server = net.createServer((socket) => {
    const decoder = new FrameDecoder(DEFAULT_MAX_FRAME_BYTES);
    socket.on("data", (chunk) => {
      let lines: string[] = [];
      try {
        lines = decoder.push(chunk);
      } catch {
        return;
      }
      for (const line of lines) {
        const parsed = parseFrameLine(line);
        if (!parsed.ok) continue;
        const f = parsed.frame;
        if (f.type === "hello") {
          socket.write(
            encodeFrame(
              buildFrame({ type: "welcome", id: f.id, from: f.from, rooms: ["default"], peers: [] }),
              DEFAULT_MAX_FRAME_BYTES,
            ),
          );
        } else if (f.type === "msg") {
          socket.write(encodeFrame(buildFrame({ type: "ack", id: f.id, status: "delivered" }), DEFAULT_MAX_FRAME_BYTES));
        }
      }
    });
    socket.on("error", () => {});
  });
  const sock = brokerSocketPathOf(dirs.runtimeDir);
  await new Promise<void>((resolve) => server.listen(sock, resolve));
  return {
    sock,
    dirs,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

describe("client: legacy (protocol 1) broker", () => {
  it("cap sends and lease commands fail fast with broker_too_old; alias sends still work", async (t) => {
    const legacy = await startLegacyBroker();
    const alice = new MeshClient({ alias: "alice", runtimeDir: legacy.dirs.runtimeDir, config: {}, noReconnect: true });
    t.after(async () => {
      await alice.close();
      await legacy.close();
      legacy.dirs.cleanup();
    });
    await alice.connect();
    assert.equal(alice.brokerProto, 1, "a welcome without proto is legacy 1");

    const pkg = {
      task: "t1",
      goalAcceptance: "cap routing refused honestly",
      paths: ["src/a.ts"],
      branchBase: { branch: "b", base: "main" },
      reply: { to: "lead", deadline: "2030-01-01T00:00:00Z", format: "commit" },
    };
    const capRes = await alice.send({ to: "cap:deploy", message: "x", taskPackage: pkg });
    assert.equal(capRes.status, "error");
    if (capRes.status === "error") assert.match(capRes.reason, /broker_too_old/);

    const claimRes = await alice.claim({ task: "t1", paths: ["src/a.ts"] });
    assert.equal(claimRes.status, "error");
    if (claimRes.status === "error") assert.match(claimRes.reason, /broker_too_old/);

    const releaseRes = await alice.releaseLease({ task: "t1", leaseId: "l1" });
    assert.equal(releaseRes.status, "error");
    if (releaseRes.status === "error") assert.match(releaseRes.reason, /broker_too_old/);

    // A plain alias send is protocol-1 compatible and must not be blocked.
    const plain = await alice.send({ to: "bob", message: "hi" });
    assert.equal(plain.status, "delivered");

    // The control plane is protocol-2 only: fail fast, not a 15 s timeout.
    const ctl = await alice.control({ to: "bob", action: "job_stop", target: "j_1", timeoutMs: 2_000 });
    assert.equal(ctl.status, "error");
    if (ctl.status === "error") assert.match(ctl.reason, /broker_too_old/);
  });
});
