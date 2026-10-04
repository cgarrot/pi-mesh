// test/reservations.test.ts — D21 file reservation matching (pure functions).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findConflict,
  normalizePath,
  pathMatchesReservation,
} from "../src/shared/reservations.js";
import type { FileReservation } from "../src/protocol/envelope.js";

describe("reservations: path matching", () => {
  it("exact file pattern matches the file only", () => {
    assert.ok(pathMatchesReservation("web/webgpu-viewer.js", "web/webgpu-viewer.js"));
    assert.ok(!pathMatchesReservation("web/webgpu-viewer.html", "web/webgpu-viewer.js"));
    assert.ok(!pathMatchesReservation("web/tools/webgpu-viewer.js", "web/webgpu-viewer.js"));
  });

  it("trailing slash reserves the whole subtree", () => {
    assert.ok(pathMatchesReservation("web/tools/a.js", "web/tools/"));
    assert.ok(pathMatchesReservation("web/tools/deep/nested/b.js", "web/tools/"));
    assert.ok(pathMatchesReservation("web/tools", "web/tools/"));
    assert.ok(!pathMatchesReservation("web/toolbox/a.js", "web/tools/"));
  });

  it("normalizes backslashes and ./ prefixes", () => {
    assert.ok(pathMatchesReservation("web\\tools\\a.js", "web/tools/"));
    assert.ok(pathMatchesReservation("./web/tools/a.js", "web/tools/"));
  });

  it("normalizePath case-folds on Windows", () => {
    // The fold is platform-dependent; on Windows NTFS paths compare case-insensitively.
    const folded = normalizePath("Web/Tools/A.js");
    if (process.platform === "win32") {
      assert.equal(folded, "web/tools/a.js");
    } else {
      assert.equal(folded, "Web/Tools/A.js");
    }
  });
});

describe("reservations: conflict lookup", () => {
  const aliceRes: FileReservation[] = [
    { pattern: "web/webgpu-viewer.js", reason: "integrating", since: "2026-08-10T00:00:00.000Z" },
    { pattern: "web/shaders/", since: "2026-08-10T00:00:00.000Z" },
  ];
  const map = new Map<string, readonly FileReservation[]>([
    ["alice", aliceRes],
    ["bob", [{ pattern: "web/tools/analyze_vmat.mjs" }]],
  ]);

  it("returns the holder for a conflicting path", () => {
    const c = findConflict("web/webgpu-viewer.js", map, "carol");
    assert.ok(c !== undefined);
    assert.equal(c?.alias, "alice");
    assert.equal(c?.reservation.reason, "integrating");
  });

  it("matches directory reservations", () => {
    const c = findConflict("web/shaders/vertexlit.wgsl", map, "carol");
    assert.equal(c?.alias, "alice");
  });

  it("ignores the caller's own reservations", () => {
    assert.equal(findConflict("web/webgpu-viewer.js", map, "alice"), undefined);
  });

  it("returns undefined when no one holds the path", () => {
    assert.equal(findConflict("web/other/file.js", map, "carol"), undefined);
  });

  it("honors a second holder on the same path", () => {
    const c = findConflict("web/tools/analyze_vmat.mjs", map, "carol");
    assert.equal(c?.alias, "bob");
  });
});

describe("reservation TTL (D33)", () => {
  it("expired reservations do not block (ttlMs > 0)", () => {
    const old = new Date(Date.now() - 3 * 3600_000).toISOString(); // 3h old
    const fresh = new Date(Date.now() - 600_000).toISOString(); // 10 min
    const map = new Map<string, readonly FileReservation[]>([
      ["bob", [{ pattern: "web/stale.js", since: old }]],
      ["carol", [{ pattern: "web/fresh.js", since: fresh }]],
    ]);
    assert.equal(findConflict("web/stale.js", map, "alice", 3600_000), undefined);
    assert.equal(findConflict("web/fresh.js", map, "alice", 3600_000)?.alias, "carol");
  });

  it("ttl 0 = unlimited (I11 default)", () => {
    const old = new Date(Date.now() - 3 * 3600_000).toISOString();
    const map = new Map<string, readonly FileReservation[]>([
      ["bob", [{ pattern: "web/stale.js", since: old }]],
    ]);
    assert.equal(findConflict("web/stale.js", map, "alice", 0)?.alias, "bob");
  });
});

// ---- v0.5: the DEFAULT TTL is now 6 h (DEFAULT_RESERVATION_TTL_MS) ----
import { DEFAULT_RESERVATION_TTL_MS } from "../src/shared/config.js";

describe("reservation TTL default change (v0.5)", () => {
  it("default is 6 h — 7 h idle-held leaks expire, 3 h GPU runs survive", () => {
    assert.equal(DEFAULT_RESERVATION_TTL_MS, 21_600_000);
    const now = Date.now();
    const gpuRun = new Date(now - 3 * 3_600_000).toISOString(); // 3 h — legit
    const leak = new Date(now - 7 * 3_600_000).toISOString(); // 7 h idle — leak
    const map = new Map<string, readonly FileReservation[]>([
      ["gpu-agent", [{ pattern: "webgpu-viewer.js", since: gpuRun }]],
      ["leak-agent", [{ pattern: "tools/old.js", since: leak }]],
    ]);
    assert.equal(findConflict("webgpu-viewer.js", map, "me", DEFAULT_RESERVATION_TTL_MS)?.alias, "gpu-agent");
    assert.equal(findConflict("tools/old.js", map, "me", DEFAULT_RESERVATION_TTL_MS), undefined);
  });
});
