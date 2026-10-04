// cli/out.ts — stdout/stderr helpers: colors auto-disabled when not a TTY
// (or NO_COLOR / TERM=dumb / --no-color), NDJSON --json writer, per-alias
// stable ANSI colors. The hash matches the extension's agentColor so an
// alias keeps its color per surface (terminal here, pi theme there) — the
// palettes differ (ANSI vs pi ThemeColor), which is expected.
import { createHash } from "node:crypto";

/** Global --no-color override (set once by the dispatcher). */
let colorOverride: boolean | null = null;

export function setColorOverride(value: boolean | null): void {
  colorOverride = value;
}

/** True when colors may be emitted (TTY, no NO_COLOR, not TERM=dumb). */
export function useColor(noColorFlag = false): boolean {
  if (colorOverride === false) return false;
  if (noColorFlag) return false;
  // NO_COLOR spec: any NON-EMPTY value disables color — an empty string
  // explicitly does NOT.
  const noColor = process.env.NO_COLOR;
  if (noColor !== undefined && noColor !== "") return false;
  if ((process.env.TERM ?? "") === "dumb") return false;
  return process.stdout.isTTY === true;
}

export function say(line = ""): void {
  process.stdout.write(line + "\n");
}

export function sayErr(line = ""): void {
  process.stderr.write(line + "\n");
}

/** One NDJSON line for --json mode (never pretty-printed: scripts). */
export function jsonLine(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + "\n");
}

// ---- ANSI helpers (16-color subset: portable everywhere incl. Windows) ----

const ANSI_DIM = "\u001b[2m";
const ANSI_BOLD = "\u001b[1m";
const ANSI_RESET = "\u001b[0m";

export function dim(text: string, color = false): string {
  return color ? `${ANSI_DIM}${text}${ANSI_RESET}` : text;
}

export function bold(text: string, color = false): string {
  return color ? `${ANSI_BOLD}${text}${ANSI_RESET}` : text;
}

/** Foreground palette for aliases — bright, readable on dark AND light. */
const ALIAS_COLORS = [
  32, // green
  36, // cyan
  35, // magenta
  33, // yellow
  34, // blue
  91, // bright red
  92, // bright green
  93, // bright yellow
  94, // bright blue
  95, // bright magenta
  96, // bright cyan
] as const;

/** Stable color for an alias — same hash as the extension agentColor
 * (per-surface stability); the ANSI palette differs from the pi theme. */
export function colorFor(alias: string): number {
  let h = 0;
  for (let i = 0; i < alias.length; i += 1) {
    h = (h * 31 + alias.charCodeAt(i)) >>> 0;
  }
  return ALIAS_COLORS[h % ALIAS_COLORS.length] ?? 36;
}

/** Colorize `@alias` with its stable color (no-op without color). */
export function colorizeSender(alias: string, color: boolean): string {
  const name = `@${alias}`;
  if (!color) return name;
  return `\u001b[${colorFor(alias)}m${name}${ANSI_RESET}`;
}

/** sha256 hex prefix — ids/hashes in dim output (never bodies). */
export function shortHash(value: string, chars = 8): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, chars);
}
