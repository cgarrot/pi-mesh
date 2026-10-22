// test/presence-caps.test.ts — B: capability advertisement + protocol version.
// Proto<2 peers advertise nothing (legacy degradation); caps are routing hints.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildFrame, effectiveCaps, validateFrame } from "../src/protocol/envelope.js";
import { loadConfig, normalizeCaps } from "../src/shared/config.js";
import { presenceFrame, peersSnapshot } from "../src/broker/rooms.js";
import { BrokerState, type PeerRecord } from "../src/broker/state.js";

function peer(over: Partial<PeerRecord>): PeerRecord {
  return {
    alias: "a",
    socket: {} as never,
    rooms: new Map([["default", "member"]]),
    connectedAt: 0,
    lastSeenAt: 0,
    helloDone: true,
    reservations: [],
    ...over,
  };
}

describe("B: presence caps + proto", () => {
  it("hello with caps/proto validates and keeps the fields", () => {
    const frame = buildFrame({ type: "hello", from: "alice", caps: ["deploy", "git"], proto: 2 });
    assert.equal(validateFrame(frame).ok, true);
    assert.deepEqual(frame.caps, ["deploy", "git"]);
    assert.equal(frame.proto, 2);
  });

  it("rejects malformed caps and proto instead of silently dropping them", () => {
    const badCap = buildFrame({ type: "hello", from: "alice" });
    badCap.caps = ["Deploy"]; // uppercase is not normalized on the wire
    const r1 = validateFrame(badCap);
    assert.equal(r1.ok, false);
    if (!r1.ok) assert.equal(r1.detail, "bad caps");

    const badProto = buildFrame({ type: "hello", from: "alice" });
    badProto.proto = 0;
    const r2 = validateFrame(badProto);
    assert.equal(r2.ok, false);
    if (!r2.ok) assert.equal(r2.detail, "bad proto");
  });

  it("legacy hello (no proto/caps) still validates", () => {
    const frame = buildFrame({ type: "hello", from: "old-client" });
    assert.equal(validateFrame(frame).ok, true);
    assert.equal(frame.proto, undefined);
    assert.equal(frame.caps, undefined);
  });

  it("effectiveCaps honors caps only from proto>=2 peers", () => {
    assert.deepEqual(effectiveCaps(2, ["deploy"]), ["deploy"]);
    assert.deepEqual(effectiveCaps(3, ["deploy"]), ["deploy"]);
    assert.deepEqual(effectiveCaps(1, ["deploy"]), []);
    assert.deepEqual(effectiveCaps(undefined, ["deploy"]), []);
    assert.deepEqual(effectiveCaps(2, undefined), []);
  });

  it("presence frames carry caps/proto so clients refresh their cache", () => {
    const frame = presenceFrame("alice", "online", "default", ["deploy"], 2);
    assert.deepEqual(frame.caps, ["deploy"]);
    assert.equal(frame.proto, 2);
    assert.equal(validateFrame(frame).ok, true);
  });

  it("peersSnapshot exposes caps/proto and omits empty caps", () => {
    const state = new BrokerState();
    state.peers.set("alice", peer({ alias: "alice", caps: ["deploy"], proto: 2 }));
    state.peers.set("legacy", peer({ alias: "legacy" }));
    const snap = peersSnapshot(state);
    const alice = snap.find((p) => p.alias === "alice");
    const legacy = snap.find((p) => p.alias === "legacy");
    assert.deepEqual(alice?.caps, ["deploy"]);
    assert.equal(alice?.proto, 2);
    assert.equal(legacy?.caps, undefined);
    assert.equal(legacy?.proto, undefined);
  });

  it("normalizes MESH_CAPS (lowercase, de-dupe, drop invalid, bound)", () => {
    assert.deepEqual(normalizeCaps([" Deploy ", "git", "git", "", "a b", "x".repeat(33)]), ["deploy", "git"]);
    const cfg = loadConfig("/tmp/mesh-caps-nonexistent", { MESH_CAPS: "deploy, git, ,deploy" } as NodeJS.ProcessEnv);
    assert.deepEqual(cfg.caps, ["deploy", "git"]);
    const many = Array.from({ length: 20 }, (_, i) => `cap${i}`);
    assert.equal(normalizeCaps(many).length, 16);
  });
});
