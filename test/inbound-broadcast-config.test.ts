import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "../src/shared/config.js";

describe("inboundBroadcasts config", () => {
  it("defaults < config.json < env; invalid values preserve the lower layer", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mesh-policy-cfg-"));
    try {
      assert.equal(loadConfig(dir, {}).inboundBroadcasts, "immediate");
      for (const value of ["immediate", "deferred"]) {
        writeFileSync(path.join(dir, "config.json"), JSON.stringify({ inboundBroadcasts: value }));
        assert.equal(loadConfig(dir, {}).inboundBroadcasts, value);
        assert.equal(loadConfig(dir, { MESH_INBOUND_BROADCASTS: "invalid" }).inboundBroadcasts, value);
        for (const override of ["immediate", "deferred"]) {
          assert.equal(loadConfig(dir, { MESH_INBOUND_BROADCASTS: override }).inboundBroadcasts, override);
        }
      }
      for (const invalid of [true, 1, null, "DEFERRED", "invalid"]) {
        writeFileSync(path.join(dir, "config.json"), JSON.stringify({ inboundBroadcasts: invalid }));
        assert.equal(loadConfig(dir, {}).inboundBroadcasts, "immediate");
        assert.equal(loadConfig(dir, { MESH_INBOUND_BROADCASTS: "deferred" }).inboundBroadcasts, "deferred");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
