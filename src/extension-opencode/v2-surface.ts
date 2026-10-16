// v2-surface.ts — local mirror of the *documented* OpenCode V2 plugin API
// (https://opencode.ai/v2/docs/build/plugins).
//
// The typings published inside @opencode-ai/plugin lag behind those docs:
// the installed typings do not yet expose the session/tool/permission
// domains. Everything declared here is typed locally — exactly like
// extension/pi-types.ts does for Pi — and the members we rely on are
// reached through a single cast (see client-runtime.ts / index.ts).
// Keep this file minimal: only declare what the adapter really uses.

/** Minimal view of the V2 PluginContext, reached through a cast. */
export interface V2PluginContext {
  /** Register or replace slash commands. */
  command: V2CommandHooks;
  /** Register or replace tools. */
  tool: V2ToolHooks;
  /** Submit prompts and interrupt running turns. */
  session: V2SessionHooks;
  /** Server event stream (session lifecycle → eager mesh attach). */
  event?: V2EventHooks;
  /** Plugin options from the configuration object form. */
  options?: unknown;
}

export interface V2EventHooks {
  subscribe(options?: { signal?: AbortSignal }): AsyncIterable<unknown>;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export interface V2CommandEditor {
  add(command: V2CommandDefinition): void;
  update?(name: string, update: (command: V2CommandDefinition) => void): void;
  remove?(name: string): void;
  list?(): readonly V2CommandDefinition[];
}

export interface V2CommandDefinition {
  name: string;
  description?: string;
  /** The executor the V2 runtime calls (the documented key is `execute`;
   *  a `handler` key is ignored and the command silently does nothing).
   *  The invocation carries the session, the prompt being submitted and
   *  the requested delivery mode. */
  execute: (input: {
    sessionID: string;
    prompt?: { text?: string };
    delivery?: "steer" | "queue";
  }) => Promise<void> | void;
}

export interface V2CommandHooks {
  /** Register (or replace) slash commands. */
  transform(callback: (editor: V2CommandEditor) => Promise<void> | void): void;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export interface V2ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema describing the tool input. */
  input: {
    type: "object";
    properties: Record<string, unknown>;
    required: readonly string[];
    additionalProperties: false;
  };
  execute: (
    input: Record<string, unknown>,
    context: V2ToolExecutionContext,
  ) => Promise<V2ToolResult>;
}

export interface V2ToolHooks {
  transform(editor: V2ToolEditor): Promise<void> | void;
}

export interface V2ToolEditor {
  add(tool: V2ToolDefinition): void;
  update?(name: string, update: (tool: V2ToolDefinition) => void): void;
  remove?(name: string): void;
  list?(): readonly V2ToolDefinition[];
}

export interface V2ToolHooks {
  /** Register (or replace) tools. */
  transform(callback: (editor: V2ToolEditor) => Promise<void> | void): void;
  /** Intercept tool execution ("execute.before" / "execute.after"); a
   *  throw from the callback aborts the tool call. */
  hook?(name: string, callback: (event: unknown) => void | Promise<void>): unknown;
}

export interface V2ToolExecutionContext {
  sessionID: string;
  agent: string;
  abort: AbortSignal;
  progress(status: { status: string }): Promise<void>;
}

export interface V2ToolResult {
  content: string;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface V2SessionHooks {
  prompt(input: {
    sessionID: string;
    text: string;
    /** "steer" interrupts the running turn, "queue" delivers at the next
     *  user prompt. */
    delivery: "steer" | "queue";
  }): Promise<unknown>;
  interrupt(input: { sessionID: string; continue: boolean }): Promise<unknown>;
  wait(input: { sessionID: string }): Promise<unknown>;
}
