// hooks.ts — legacy V1 hooks used by the OpenCode plugin.
//
// Only the hooks exposed by the installed @opencode-ai/plugin typings are
// used here. The V1 API is still the path used by opencode instances that
// predate the V2 plugin API, so the plugin registers:
//   - "event"               : observe the server's event stream (best effort);
//   - "chat.message"       : observe messages received into any session
//                           (inbound mesh messages are visible here — a
//                           debugging aid; nothing is modified);
//   - "tool.execute.before": observe tool calls (debugging aid).
//
// Neither hook modifies behaviour — mesh tools/commands are registered
// through the V2 path when available.
import type { Hooks } from "@opencode-ai/plugin";

/** Observation counters — useful for the (rare) case of debugging. */
export interface MeshHookObservations {
  events: number;
  chatMessages: number;
  toolCalls: number;
}

export const observations: MeshHookObservations = {
  events: 0,
  chatMessages: 0,
  toolCalls: 0,
};

interface EventInput {
  event: unknown;
}
interface ChatMessageInput {
  sessionID: string;
  messageID?: string;
}
interface ToolExecuteBeforeInput {
  tool: string;
  sessionID: string;
  /** Present in the real hook payload; optional here so the callback fits. */
  callID?: string;
  args?: unknown;
}

export function buildV1Hooks(): Hooks {
  return {
    async event(input: EventInput): Promise<void> {
      observations.events += 1;
    },
    async "chat.message"(input: ChatMessageInput): Promise<void> {
      observations.chatMessages += 1;
    },
    async "tool.execute.before"(input: ToolExecuteBeforeInput): Promise<void> {
      observations.toolCalls += 1;
    },
  };
}
