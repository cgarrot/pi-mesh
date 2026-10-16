// index.ts — OpenCode plugin entrypoint (double mode: V1 + V2).
//
// The default export carries both plugin generations so a single package
// serves every OpenCode installation:
//   - the V2 half (ctx.command / ctx.tool / ctx.session) — the documented
//     current API, used when the running OpenCode supports it;
//   - the V1 half (`server()` hook map) — used by older OpenCode instances:
//     observation hooks only, because the V1 tool map is zod-based and the
//     runtime-facing hooks are what it exposes.
import type { V2CommandEditor, V2PluginContext, V2ToolEditor } from "./v2-surface.js";
import { buildV1Hooks } from "./hooks.js";
import { applyMeshCommand } from "./register-commands.js";
import { applyMeshTools, applyMeshToolsV1 } from "./register-tools.js";
import {
  attachDefaultSink,
  attachOpenCodeSession,
  ensureSessionRuntime,
} from "./client-runtime.js";
import type { MeshSessionRuntime } from "./client-runtime.js";
import { injectBatch } from "./inject.js";

/** Resolve (or create) the runtime of an OpenCode session. */
function ensureSession(sessionID: string): Promise<MeshSessionRuntime> {
  return ensureSessionRuntime(sessionID);
}

/**
 * The default export carries both plugin generations so a single package
 * serves every OpenCode installation.
 *
 * It is a plain object on purpose: the `define()` helper from
 * `@opencode-ai/plugin/v2/promise` is *not* imported. That subpath does not
 * exist in every OpenCode installation (the installed plugin package only
 * exposes the V1 entry in older builds), and importing it makes the whole
 * plugin fail to load there. Constructing the object by hand is enough —
 * both halves are plain functions.
 */
export default {
  id: "pi-mesh",
  async setup(ctx: V2PluginContext): Promise<void> {
    attachOpenCodeSession(ctx);
    await attachDefaultSink(async (runtime, frames) => {
      await injectBatch(runtime, frames);
    });
    // Older OpenCode builds do not expose the V2 domains yet — in that case
    // the mesh_* tools are not registered (no other path exists).
    if (typeof ctx.command?.transform === "function") {
      await ctx.command.transform((editor: V2CommandEditor) => {
        applyMeshCommand(editor, ensureSession);
      });
    }
    if (typeof ctx.tool?.transform === "function") {
      await ctx.tool.transform((editor: V2ToolEditor) => {
        applyMeshTools(editor, ensureSession);
      });
    }
  },
  // The V1 half: opencode instances that predate the V2 plugin API call
  // `server()` to obtain the legacy hook map (observation hooks plus the
  // zod-based tool map).
  server: () => {
    const hooks = buildV1Hooks();
    applyMeshToolsV1(hooks, ensureSession);
    return Promise.resolve(hooks);
  },
};
