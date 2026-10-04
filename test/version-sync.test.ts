// test/version-sync.test.ts — B6 regression guard: MESH_VERSION must equal
// the package.json version. scripts/sync-version.mjs enforces it at build
// time; this test catches a hand-edited src/shared/version.ts slipping
// through a publish that skipped the build hook.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { MESH_VERSION } from "../src/shared/version.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { version: string };

test("MESH_VERSION stays in sync with package.json (B6)", () => {
  assert.equal(MESH_VERSION, pkg.version);
});
