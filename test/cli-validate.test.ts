// test/cli-validate.test.ts — the Phase 1 validation table, pure unit tests.
import test from "node:test";
import assert from "node:assert/strict";
import {
  csvParts,
  validateAlias,
  validateBody,
  validateReplyToCsv,
  validateRefsCsv,
  validateRoom,
  validateTimeoutMs,
} from "../src/cli/validate.js";
import { MAX_BODY_BYTES, MAX_REFS } from "../src/shared/config.js";

test("validateAlias: regex + normalization happens at call site", () => {
  assert.ok(validateAlias("agent-abc123").ok);
  assert.ok(validateAlias("ab").ok); // min length 2 per ALIAS_REGEX
  assert.ok(!validateAlias("a").ok);
  assert.ok(!validateAlias("-abc").ok);
  assert.ok(!validateAlias("Abc").ok);
  assert.ok(!validateAlias("abc def").ok);
});

test("validateRoom", () => {
  assert.ok(validateRoom("default").ok);
  assert.ok(validateRoom("ops").ok);
  assert.ok(!validateRoom("OPS").ok);
  assert.ok(!validateRoom("with space").ok);
  assert.ok(!validateRoom("").ok);
});

test("validateTimeoutMs: integer within bounds only", () => {
  assert.ok(validateTimeoutMs("30000").ok);
  assert.ok(validateTimeoutMs("25").ok);
  assert.ok(!validateTimeoutMs("abc").ok);
  assert.ok(!validateTimeoutMs("1.5").ok);
  assert.ok(!validateTimeoutMs("24").ok); // below MIN (25)
  assert.ok(!validateTimeoutMs("1800001").ok); // above MAX (30 min)
});

test("validateBody: 1..MAX_BODY_BYTES, never silently truncated", () => {
  assert.ok(validateBody("hi").ok);
  assert.ok(!validateBody("").ok);
  const exactly = "a".repeat(MAX_BODY_BYTES);
  assert.ok(validateBody(exactly).ok, "exactly max must pass");
  const over = "a".repeat(MAX_BODY_BYTES + 1);
  const v = validateBody(over);
  assert.ok(!v.ok);
  if (!v.ok) assert.match(v.error, new RegExp(`${MAX_BODY_BYTES}B`));
});

test("validateRefsCsv: ≤ MAX_REFS repo-relative entries", () => {
  assert.ok(validateRefsCsv("src/a.ts").ok);
  assert.ok(validateRefsCsv("src/a.ts, docs/x.md , pkg.json").ok);
  assert.ok(!validateRefsCsv("/abs/path").ok);
  assert.ok(!validateRefsCsv("a/../..").ok);
  const many = Array.from({ length: MAX_REFS + 1 }, (_, i) => `f${i}.ts`).join(",");
  assert.ok(!validateRefsCsv(many).ok);
  assert.ok(!validateRefsCsv(",,,").ok);
});

test("validateReplyToCsv + csvParts", () => {
  assert.ok(validateReplyToCsv("alice").ok);
  assert.ok(validateReplyToCsv("@Alice, bob").ok);
  assert.ok(!validateReplyToCsv("not valid!").ok);
  assert.deepEqual(csvParts("@Alice, bob"), ["alice", "bob"]);
});
