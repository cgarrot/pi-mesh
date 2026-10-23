// test/config-v05.test.ts — v0.5 config surface: watchdog defaults, compact
// context verbosity, reservation TTL default + explicit 0 opt-out.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { loadConfig, MAX_CTL_ALLOW_FROM } from "../src/shared/config.js";

function tmpStateDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mesh-cfg-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("loadConfig ctl.allowFrom (steer-class default-deny)", () => {
  it("defaults to an empty allowlist", () => {
    const { dir, cleanup } = tmpStateDir();
    try {
      assert.deepEqual(loadConfig(dir, {}).ctlAllowFrom, []);
    } finally {
      cleanup();
    }
  });

  it("config.json ctl.allowFrom normalizes, dedupes and drops invalid entries", () => {
    const { dir, cleanup } = tmpStateDir();
    try {
      writeFileSync(
        path.join(dir, "config.json"),
        JSON.stringify({ ctl: { allowFrom: ["@Alice", "bob", "bad alias", "alice", "BOB"] } }),
      );
      assert.deepEqual(loadConfig(dir, {}).ctlAllowFrom, ["alice", "bob"]);
    } finally {
      cleanup();
    }
  });

  it("MESH_CTL_ALLOW_FROM overrides the file and is bounded", () => {
    const { dir, cleanup } = tmpStateDir();
    try {
      writeFileSync(path.join(dir, "config.json"), JSON.stringify({ ctl: { allowFrom: ["from-file"] } }));
      assert.deepEqual(
        loadConfig(dir, { MESH_CTL_ALLOW_FROM: "carol,@Bob" }).ctlAllowFrom,
        ["carol", "bob"],
      );
      const many = Array.from({ length: MAX_CTL_ALLOW_FROM + 8 }, (_, i) => `a${i}`).join(",");
      assert.equal(loadConfig(dir, { MESH_CTL_ALLOW_FROM: many }).ctlAllowFrom?.length, MAX_CTL_ALLOW_FROM);
    } finally {
      cleanup();
    }
  });
});

describe("loadConfig v0.5 defaults", () => {
  it("watchdog on, 2 MiB spike / 64 calls / 1 MiB compaction, compact verbosity, 6 h reservation TTL", () => {
    const { dir, cleanup } = tmpStateDir();
    try {
      const cfg = loadConfig(dir, {});
      assert.equal(cfg.watchdog, true);
      assert.equal(cfg.watchdogSpikeBytes, 2_097_152);
      assert.equal(cfg.watchdogMaxCalls, 64);
      assert.equal(cfg.watchdogCompactionBytes, 1_048_576);
      assert.equal(cfg.contextVerbosity, "compact");
      assert.equal(cfg.reservationTtlMs, 21_600_000);
    } finally {
      cleanup();
    }
  });

  it("config.json opt-outs: watchdog off, full verbosity, reservationTtlMs 0", () => {
    const { dir, cleanup } = tmpStateDir();
    try {
      writeFileSync(path.join(dir, "config.json"), JSON.stringify({
        watchdog: false,
        contextVerbosity: "full",
        reservationTtlMs: 0,
      }));
      const cfg = loadConfig(dir, {});
      assert.equal(cfg.watchdog, false);
      assert.equal(cfg.contextVerbosity, "full");
      assert.equal(cfg.reservationTtlMs, 0, "explicit 0 is a VALID opt-out, not coerced back to 6 h");
    } finally {
      cleanup();
    }
  });

  it("env overrides: MESH_WATCHDOG=0 off, MESH_CONTEXT_VERBOSE=1 full, MESH_RESERVATION_TTL_MS=0 unlimited", () => {
    const { dir, cleanup } = tmpStateDir();
    try {
      mkdirSync(dir, { recursive: true });
      const cfg = loadConfig(dir, { MESH_WATCHDOG: "0", MESH_CONTEXT_VERBOSE: "1", MESH_RESERVATION_TTL_MS: "0" });
      assert.equal(cfg.watchdog, false);
      assert.equal(cfg.contextVerbosity, "full");
      assert.equal(cfg.reservationTtlMs, 0);
    } finally {
      cleanup();
    }
  });
});
