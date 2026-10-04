// test/cli-args.test.ts — the zero-dependency parser: pure unit tests.
import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs, specUsage, type ArgSpec } from "../src/cli/args.js";

const SPECS: ArgSpec[] = [
  { name: "room", kind: "value", short: "R", meta: "ROOM" },
  { name: "await", kind: "flag" },
  { name: "timeout", kind: "value", meta: "MS" },
  { name: "ref", kind: "repeat", meta: "P" },
];

test("flags and values", () => {
  const r = parseArgs(["--await", "--room", "ops", "--timeout=500"], SPECS);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.help, false);
  assert.ok(r.parsed.flags.has("await"));
  assert.equal(r.parsed.values.get("room"), "ops");
  assert.equal(r.parsed.values.get("timeout"), "500");
  assert.deepEqual(r.parsed.positionals, []);
});

test("short options take the next token", () => {
  const r = parseArgs(["-R", "ops", "positional"], SPECS);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.parsed.values.get("room"), "ops");
  assert.deepEqual(r.parsed.positionals, ["positional"]);
});

test("repeat collects every occurrence, last value wins in values", () => {
  const r = parseArgs(["--ref", "a.ts", "--ref", "b.ts", "--room", "x", "--room", "y"], SPECS);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.parsed.repeats.get("ref"), ["a.ts", "b.ts"]);
  assert.equal(r.parsed.values.get("room"), "y");
});

test("-- stops option parsing (dash-prefixed positionals after it)", () => {
  const r = parseArgs(["a", "--", "--not-a-flag", "-x"], SPECS);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.parsed.positionals, ["a", "--not-a-flag", "-x"]);
});

test("bare dash is positional (stdin convention)", () => {
  const r = parseArgs(["send", "-", "extra"], SPECS);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.parsed.positionals, ["send", "-", "extra"]);
});

test("dash-prefixed tokens are options (typo detection) — `--` is the escape", () => {
  const strict = parseArgs(["-5"], SPECS);
  assert.ok(!strict.ok);
  if (strict.ok) return;
  assert.match(strict.error, /unknown option: -5/);

  const escaped = parseArgs(["--", "-5"], SPECS);
  assert.ok(escaped.ok);
  if (!escaped.ok) return;
  assert.deepEqual(escaped.parsed.positionals, ["-5"]);
});

test("unknown option is an honest error", () => {
  const r = parseArgs(["--frobnicate"], SPECS);
  assert.ok(!r.ok);
  if (r.ok) return;
  assert.match(r.error, /unknown option/);
});

test("value option without value is an error", () => {
  const r = parseArgs(["--room"], SPECS);
  assert.ok(!r.ok);
  if (r.ok) return;
  assert.match(r.error, /requires a value/);
});

test("flag with inline value is an error", () => {
  const r = parseArgs(["--await=true"], SPECS);
  assert.ok(!r.ok);
  if (r.ok) return;
  assert.match(r.error, /takes no value/);
});

test("--help is detected and does not error", () => {
  for (const h of ["--help", "-h"]) {
    const r = parseArgs([h, "--room", "ops"], SPECS);
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.help, true);
  }
});

test("specUsage renders flags and value placeholders", () => {
  const usage = specUsage(SPECS);
  assert.match(usage, /\[-R, --room ROOM\]/);
  assert.match(usage, /\[--await\]/);
  assert.match(usage, /\[--timeout MS\]/);
  assert.match(usage, /\[--ref P\]/);
});
