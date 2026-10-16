// index.ts — OpenCode plugin entrypoint (double mode: V1 + V2).
//
// The default export carries both plugin generations so a single package
// serves every OpenCode installation:
//   - the V2 half (ctx.command / ctx.tool / ctx.session) — the documented
//     current API, used when the running OpenCode supports it;
//   - the V1 half (`server()` hook map) — used by older OpenCode instances:
//     observation hooks only, because the V1 tool map is zod-based and the
//     runtime-facing hooks are what it exposes.
import { define } from "@opencode-ai/plugin/v2/promise";
import type { PluginContext } from "@opencode-ai/plugin/v2/promise";
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

const v2 = define({
  id: "pi-mesh",
  async setup(ctx: PluginContext): Promise<void> {
    attachOpenCodeSession(ctx);
    await attachDefaultSink(async (runtime, frames) => {
      await injectBatch(runtime, frames);
    });
    const plugin = ctx as unknown as V2PluginContext;
    if (typeof plugin.command?.transform === "function") {
      await plugin.command.transform((editor: V2CommandEditor) => {
        applyMeshCommand(editor, ensureSession);
      });
    }
    // Older OpenCode builds do not expose the tool domain yet — in that
    // case the mesh_* tools are not registered (no other path exists).
    if (typeof plugin.tool?.transform === "function") {
      await plugin.tool.transform((editor: V2ToolEditor) => {
        applyMeshTools(editor, ensureSession);
      });
    }
  },
});

/** Resolve (or create) the runtime of an OpenCode session. */
function ensureSession(sessionID: string): Promise<MeshSessionRuntime> {
  return ensureSessionRuntime(sessionID);
}

const plugin = {
  id: v2.id,
  setup: v2.setup,
  // The V1 half: opencode instances that predate the V2 plugin API call
  // `server()` to obtain the legacy hook map (observation hooks plus the
  // zod-based tool map).
  server: () => {
    const hooks = buildV1Hooks();
    applyMeshToolsV1(hooks, ensureSession);
    return Promise.resolve(hooks);
  },
};

export default plugin;
