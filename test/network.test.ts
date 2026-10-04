// test/network.test.ts — D37: TCP/TLS broker + token auth (multi-machine).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import path from "node:path";
import { MeshClient } from "../src/client/client.js";
import { createBroker } from "../src/broker/broker.js";
import { DEFAULT_POLICY } from "../src/broker/policy.js";
import { DEFAULT_CONFIG, parseEndpoint } from "../src/shared/config.js";
import { socketPathForDir } from "../src/shared/paths.js";
import { makeTempDirs, type TempDirs } from "./helpers.js";

async function tcpBroker(token: string): Promise<{
  broker: Awaited<ReturnType<typeof createBroker>>;
  port: number;
  dirs: TempDirs;
}> {
  const dirs = makeTempDirs("mesh-net-");
  const broker = await createBroker({
    config: { ...DEFAULT_CONFIG, brokerToken: token },
    policy: DEFAULT_POLICY,
    tcpListen: { host: "127.0.0.1", port: 0, tls: false },
  });
  const addr = broker.server.address();
  const port = typeof addr === "object" && addr !== null && "port" in addr ? addr.port : 0;
  return { broker, port, dirs };
}

function netClient(alias: string, port: number, token: string | undefined): MeshClient {
  return new MeshClient({
    alias,
    runtimeDir: "/nonexistent",
    config: {
      brokerUrl: `tcp://127.0.0.1:${port}`,
      brokerToken: token,
    },
  });
}

describe("parseEndpoint (D37)", () => {
  it("parses tcp/tls/unix URLs", () => {
    assert.deepEqual(parseEndpoint("tcp://0.0.0.0:8712"), { kind: "tcp", host: "0.0.0.0", port: 8712 });
    assert.deepEqual(parseEndpoint("tls://mesh.example.com:8712"), { kind: "tls", host: "mesh.example.com", port: 8712 });
    assert.deepEqual(parseEndpoint("unix:///tmp/mesh.sock"), { kind: "unix", path: "/tmp/mesh.sock" });
    assert.deepEqual(parseEndpoint("tcp://[::1]:9000"), { kind: "tcp", host: "::1", port: 9000 });
    assert.equal(parseEndpoint("http://x:1"), null);
    assert.equal(parseEndpoint("tcp://host"), null);
  });
});

describe("TCP broker + token auth (D37)", () => {
  it("hello without the token is refused with invalid_token", async () => {
    const { broker, port, dirs } = await tcpBroker("secret123");
    try {
      const hacker = netClient("hacker", port, undefined);
      await assert.rejects(() => hacker.connect(), /invalid_token/);
    } finally {
      await broker.close();
      rmSync(dirs.root, { recursive: true, force: true });
    }
  });

  it("hello with the right token connects; messages flow between TCP clients", async () => {
    const { broker, port, dirs } = await tcpBroker("secret123");
    const alice = netClient("alice", port, "secret123");
    const bob = netClient("bob", port, "secret123");
    try {
      const w = await alice.connect();
      assert.equal(w.alias, "alice");
      await bob.connect();
      const got = new Promise<{ body?: string }>((resolve) => {
        bob.once("inbound", (f) => resolve(f));
      });
      const sent = await alice.send({ to: "bob", message: "over-tcp" });
      assert.equal(sent.status, "delivered");
      const msg = await got;
      assert.equal(msg.body, "over-tcp");
      // presence visible cross-client
      const snap = await alice.status();
      assert.ok(snap.peers.some((p) => p.alias === "bob"));
    } finally {
      await alice.close().catch(() => {});
      await bob.close().catch(() => {});
      await broker.close();
      rmSync(dirs.root, { recursive: true, force: true });
    }
  });

  it("wrong token is refused", async () => {
    const { broker, port, dirs } = await tcpBroker("secret123");
    try {
      const evil = netClient("evil", port, "wrong");
      await assert.rejects(() => evil.connect(), /invalid_token/);
    } finally {
      await broker.close();
      rmSync(dirs.root, { recursive: true, force: true });
    }
  });
});

/** D38 dual listen: local unix socket (tokenless) + tcp (token) at once. */
async function dualBroker(token: string): Promise<{
  broker: Awaited<ReturnType<typeof createBroker>>;
  port: number;
  dirs: TempDirs;
}> {
  const dirs = makeTempDirs("mesh-dual-");
  // socketPathForDir: named pipe on Windows (AF_UNIX is unavailable there —
  // a raw broker.sock path fails with EACCES), broker.sock on POSIX.
  const socketPath = socketPathForDir(dirs.runtimeDir);
  const broker = await createBroker({
    config: { ...DEFAULT_CONFIG, brokerToken: token },
    policy: DEFAULT_POLICY,
    socketPath,
    tcpListen: { host: "127.0.0.1", port: 0, tls: false },
    alsoUnix: true,
  });
  const addr = broker.server.address();
  const port = typeof addr === "object" && addr !== null && "port" in addr ? addr.port : 0;
  return { broker, port, dirs };
}

describe("dual listen: unix (tokenless) + tcp (token) — D38", () => {
  it("local unix client needs no token, tcp client does, messages flow both ways", async () => {
    const { broker, port, dirs } = await dualBroker("lan-token");
    const local = new MeshClient({ alias: "local-agent", runtimeDir: dirs.runtimeDir });
    const remote = netClient("remote-agent", port, "lan-token");
    try {
      assert.ok(port > 0, "tcp port assigned");
      assert.ok(
        broker.socketPath.includes(socketPathForDir(dirs.runtimeDir)),
        `both endpoints reported: ${broker.socketPath}`,
      );
      await local.connect(); // unix — NO token configured, must pass
      await remote.connect(); // tcp — token, must pass
      const got = new Promise<{ body?: string }>((resolve) => {
        remote.once("inbound", (f) => resolve(f));
      });
      const sent = await local.send({ to: "remote-agent", message: "lan-hello" });
      assert.equal(sent.status, "delivered");
      assert.equal((await got).body, "lan-hello");
      const back = new Promise<{ body?: string }>((resolve) => {
        local.once("inbound", (f) => resolve(f));
      });
      const sentBack = await remote.send({ to: "local-agent", message: "unix-back" });
      assert.equal(sentBack.status, "delivered");
      assert.equal((await back).body, "unix-back");
      const snap = await local.status();
      assert.ok(snap.peers.some((p) => p.alias === "remote-agent"));
    } finally {
      await local.close().catch(() => {});
      await remote.close().catch(() => {});
      await broker.close();
      rmSync(dirs.root, { recursive: true, force: true });
    }
  });

  it("tcp without token still refused while unix stays open", async () => {
    const { broker, port, dirs } = await dualBroker("lan-token");
    const local = new MeshClient({ alias: "local-2", runtimeDir: dirs.runtimeDir });
    try {
      const rogue = netClient("rogue", port, undefined);
      await assert.rejects(() => rogue.connect(), /invalid_token/);
      await local.connect(); // unix unaffected by the tcp refusal
      const snap = await local.status();
      assert.ok(Array.isArray(snap.peers));
      await local.close();
    } finally {
      await broker.close();
      rmSync(dirs.root, { recursive: true, force: true });
    }
  });

  it("D40: snapshot tags remote peers with via=tcp:<ip>, local peers undefined", async () => {
    const { broker, port, dirs } = await dualBroker("lan-token");
    const local = new MeshClient({ alias: "local-3", runtimeDir: dirs.runtimeDir });
    const remote = netClient("remote-3", port, "lan-token");
    try {
      await local.connect();
      await remote.connect();
      const snap = await local.status();
      const mine = snap.peers.find((p) => p.alias === "local-3");
      const far = snap.peers.find((p) => p.alias === "remote-3");
      assert.ok(mine !== undefined && far !== undefined);
      assert.equal(mine.via, undefined, "unix-socket peer is broker-local");
      assert.ok(/^tcp:127\.0\.0\.1$|^tcp:::1$/.test(far.via ?? ""), `tcp peer tagged, got ${far.via}`);
    } finally {
      await local.close().catch(() => {});
      await remote.close().catch(() => {});
      await broker.close();
      rmSync(dirs.root, { recursive: true, force: true });
    }
  });
});
