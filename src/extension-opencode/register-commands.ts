// register-commands.ts — register the `/mesh` slash command.
//
// V2 only: the legacy V1 plugin API exposes no command domain, so older
// OpenCode instances do not get this command (they still get the mesh
// tools, through the V1 tool map).
import type {
  V2CommandDefinition,
  V2CommandEditor,
} from "./v2-surface.js";
import {
  ensureSessionRuntime,
  type MeshSessionRuntime,
} from "./client-runtime.js";

/** Render a status report for the session's runtime. */
export function renderMeshStatus(runtime: MeshSessionRuntime): string {
  return `mesh status — alias @${runtime.client.alias}`;
}

export function applyMeshCommand(
  editor: V2CommandEditor,
  ensure: (sessionID: string) => Promise<MeshSessionRuntime>,
): void {
  editor.add({
    name: "mesh",
    description:
      "Report the current mesh status: online peers, rooms and missions. " +
      "Reads the broker snapshot.",
    handler: async (input) => {
      const runtime = await ensure(input.sessionID);
      const text = renderMeshStatus(runtime);
      await runtime.submit(text, "steer");
    },
  });
}
