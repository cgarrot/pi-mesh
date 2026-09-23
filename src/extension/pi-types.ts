// extension/pi-types.ts — minimal LOCAL interfaces for the Pi ExtensionAPI surface.
// ZERO imports from Pi packages: the extension is a thin adapter.
// Tool parameters are plain JSON Schema objects (zero-dependency: NO typebox).

/** JSON Schema object (plain, zero-dependency constraint). */
export type JsonSchema = Record<string, unknown>;

export interface ToolTextContent {
  type: "text";
  text: string;
}

export interface ToolResult {
  content: ToolTextContent[];
  details?: Record<string, unknown>;
}

/** Theme colors supported by the Pi TUI theme.fg: full surface used
 *  by the per-agent palette). */
export type ThemeColor =
  | "accent"
  | "border"
  | "borderAccent"
  | "borderMuted"
  | "success"
  | "error"
  | "warning"
  | "muted"
  | "dim"
  | "text"
  | "thinkingText"
  | "userMessageText"
  | "customMessageText"
  | "customMessageLabel"
  | "toolTitle"
  | "toolOutput"
  | "mdHeading"
  | "mdLink"
  | "mdLinkUrl"
  | "mdCode"
  | "mdCodeBlock"
  | "mdCodeBlockBorder"
  | "mdQuote"
  | "mdQuoteBorder"
  | "mdHr"
  | "mdListBullet"
  | "toolDiffAdded"
  | "toolDiffRemoved"
  | "toolDiffContext"
  | "syntaxComment"
  | "syntaxKeyword"
  | "syntaxFunction"
  | "syntaxVariable"
  | "syntaxString"
  | "syntaxNumber"
  | "syntaxType"
  | "syntaxOperator"
  | "syntaxPunctuation"
  | "thinkingOff"
  | "thinkingMinimal"
  | "thinkingLow"
  | "thinkingMedium"
  | "thinkingHigh"
  | "thinkingXhigh"
  | "thinkingMax"
  | "bashMode";

export interface UiTheme {
  fg(color: ThemeColor, text: string): string;
}

/** Context passed by Pi to tool execute / command handler / session hooks. */
export interface SessionContext {
  cwd: string;
  mode?: "tui" | "rpc" | "json" | "print";
  /** Pi session manager (read-only surface) — stable sessionId across reloads. */
  sessionManager?: {
    getSessionId(): string;
    getSessionFile?(): string;
  };
  /** Pi command actions — newSession lets /mesh new open a fresh session.
  *  Direct method on the command context (not under actions). Post-replacement
  *  work must go through withSession (the old ctx is stale after the call). */
  newSession?(opts?: {
    parentSession?: string;
    withSession?(ctx: SessionContext): Promise<void>;
  }): Promise<{ cancelled: boolean }>;
  ui: {
    notify(message: string, opts?: { level?: string }): void;
  /**
  * Footer-widget above the editor by default; undefined clears it.
  * SAFE form ONLY: string[] (pi wraps each line in a Text component and
  * truncates itself). The factory form is FORBIDDEN here — its return
  * value must be a component object with render(width), not string[].
  */
    setWidget(id: string, content: string[] | undefined): void;
  /** Compact status in the built-in footer; undefined clears it. */
    setStatus(id: string, text: string | undefined): void;
  /** TUI theme (interactive sessions); absent in headless contexts. */
    theme?: UiTheme;
  };
  /** Request abort of the current agent turn (force priority). Optional. */
  abort?(): void;
  /** True when the agent is idle (no running turn). Optional. */
  isIdle?(): boolean;
}

export type ToolExecuteFn = (
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  onUpdate: ((partial: ToolResult) => void) | undefined,
  ctx: SessionContext,
) => Promise<ToolResult>;

export interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string;
  /** Plain JSON Schema object — NOT typebox. */
  parameters: JsonSchema;
  execute: ToolExecuteFn;
}

export interface CommandDefinition {
  description: string;
  handler: (args: string, ctx: SessionContext) => void | Promise<void>;
}

export type DeliverAs = "followUp" | "steer" | "nextTurn";

export interface InboundMessage {
  customType: string;
  content: string;
  display: boolean;
  details?: Record<string, unknown>;
}

export interface SendMessageOptions {
  triggerTurn?: boolean;
  deliverAs?: DeliverAs;
}

export type SessionEventName =
  | "input"
  | "before_agent_start"
  | "agent_start"
  | "session_start"
  | "session_shutdown"
  | "session_before_fork"
  | "tool_result"
  | "agent_settled" // turn finished → announce idle
  | "after_provider_response" // provider HTTP status (fallback signal)
  | "turn_end" // failed turns carry stopReason "error" + errorMessage
  | "model_select"; // human switched the model → lift the hold

export type SessionHookHandler = (
  event: unknown,
  ctx: SessionContext,
) => void | Promise<void>;

// ---- tool_call hook (reservation enforcement, ----

export interface ToolCallEvent {
  toolName: string;
  input: Record<string, unknown>;
}

export interface ToolCallEventResult {
  block: boolean;
  reason: string;
}

export type ToolCallHandler = (
  event: ToolCallEvent,
  ctx: SessionContext,
) => ToolCallEventResult | undefined | void;

/** The subset of the Pi ExtensionAPI used by the mesh extension. */
export interface ExtensionAPI {
  /** Shared process-local event bus (optional on older hosts). */
  events?: { emit(event: string, data: unknown): void };
  on(event: "tool_call", handler: ToolCallHandler): void;
  on(event: SessionEventName, handler: SessionHookHandler): void;
  registerTool(tool: ToolDefinition): void;
  registerCommand(name: string, def: CommandDefinition): void;
  sendMessage(msg: InboundMessage, opts?: SendMessageOptions): void;
  appendEntry(customType: string, data?: unknown): void;
  /** Session display name — shown in /resume and the session selector. */
  setSessionName?(name: string): void;
  getSessionName?(): string | undefined;
  /** Register a custom renderer for CustomMessageEntry: colors). */
  registerMessageRenderer?<T = unknown>(
    customType: string,
    renderer: MessageRenderer<T>,
  ): void;
  /** Register a renderer for CustomEntry — LIVE display outside the LLM
  *  context: inbound frames shown while a tool call runs). */
  registerEntryRenderer?<T = unknown>(
    customType: string,
    renderer: EntryRenderer<T>,
  ): void;
}

/** Minimal local surface of pi's EntryRenderer. */
export interface EntryRenderer<T = unknown> {
  (
    entry: { customType: string; data?: T },
    options: unknown,
    theme: RenderTheme,
  ):
    | {
        render(width: number): string[];
        invalidate(): void;
      }
    | undefined;
}

/** Local theme surface for renderers. */
/** Background theme colors (theme.bg surface, box rendering). */
export type ThemeBg =
  | "selectedBg"
  | "scrollbarThumb"
  | "userMessageBg"
  | "customMessageBg"
  | "toolPendingBg"
  | "toolSuccessBg"
  | "toolErrorBg";

export interface RenderTheme {
  fg(color: ThemeColor, text: string): string;
  /** background application — absent in headless/test themes. */
  bg?(color: ThemeBg, text: string): string;
  /** Bold helper for the box label. */
  bold?(text: string): string;
  /** Raw foreground ANSI code for a theme color — used to build the
   *  per-agent BACKGROUND (38→48) for verdict lines. */
  fgAnsi?(color: ThemeColor): string;
}

/** Minimal local surface of pi's MessageRenderer — a factory that
 *  receives the custom message + theme and returns the render object. */
export interface MessageRenderer<T = unknown> {
  (
    message: { content?: unknown; details?: T },
    options: unknown,
    theme: RenderTheme,
  ):
    | {
        render(width: number): string[];
        invalidate(): void;
      }
    | undefined;
}

/** Helper: a single-paragraph text tool result. */
export function textResult(text: string, details?: Record<string, unknown>): ToolResult {
  const out: ToolResult = { content: [{ type: "text", text }] };
  if (details !== undefined) out.details = details;
  return out;
}
