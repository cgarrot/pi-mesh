/**
 * Tool metadata shape: `promptGuidelines` MUST be a `string[]`.
 *
 * Regression for #19. pi's codemode builds a declaration for every callable
 * tool before running a script and calls `guidelines.flatMap(...)` directly
 * (`dist/extensions/codemode/tool.js`). A bare string throws
 * "guidelines.flatMap is not a function" — every codemode script fails — and
 * the system prompt iterates the string, rendering one bullet per CHARACTER.
 *
 * The local `ToolDefinition` mirror is now typed `string[]` (so tsc catches
 * it), but this runtime check is the safety net: it also catches a `as any`
 * cast, and it fails for ANY registered tool, not just the four that had it.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { registerTools, type MeshRuntime } from "../src/extension/tools.js";
import type { ExtensionAPI, ToolDefinition } from "../src/extension/pi-types.js";

function collectTools(): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerTool: (def: ToolDefinition) => void tools.set(def.name, def),
  } as unknown as ExtensionAPI;
  registerTools(pi, () => ({}) as MeshRuntime);
  return tools;
}

describe("tool metadata: promptGuidelines", () => {
  it("every registered tool declares promptGuidelines as a string[]", () => {
    const tools = collectTools();
    assert.ok(tools.size > 0, "expected the extension to register tools");

    const offenders: string[] = [];
    for (const [name, def] of tools) {
      const guidelines = (def as { promptGuidelines?: unknown }).promptGuidelines;
      if (guidelines === undefined) continue;
      if (!Array.isArray(guidelines)) {
        offenders.push(`${name}: ${typeof guidelines} (pi calls guidelines.flatMap — this breaks codemode)`);
        continue;
      }
      for (const [i, entry] of guidelines.entries()) {
        if (typeof entry !== "string") offenders.push(`${name}[${i}]: ${typeof entry}, expected string`);
      }
    }
    assert.deepEqual(offenders, [], "promptGuidelines must be string[]");
  });

  it("no guideline is multi-line or padded (one bullet = one sentence-group)", () => {
    // A guideline is a bullet in the system prompt. Embedded newlines would
    // silently create extra bullets that nobody wrote; leading/trailing spaces
    // survive into the rendered prompt.
    for (const [name, def] of collectTools()) {
      const guidelines = def.promptGuidelines;
      if (guidelines === undefined) continue;
      for (const [i, entry] of guidelines.entries()) {
        assert.equal(entry.includes("\n"), false, `${name}[${i}] must not contain a newline`);
        assert.equal(entry, entry.trim(), `${name}[${i}] must be trimmed`);
        assert.ok(entry.length > 0, `${name}[${i}] must not be empty`);
      }
    }
  });

  it("promptSnippet stays a single line", () => {
    for (const [name, def] of collectTools()) {
      if (def.promptSnippet === undefined) continue;
      assert.equal(def.promptSnippet.includes("\n"), false, `${name} promptSnippet must be one line`);
    }
  });
});
