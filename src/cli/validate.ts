// cli/validate.ts — the Phase 1 validation table: every bound comes from
// shared/config.ts (V5) and every violation is a usage error (exit 2),
// reported honestly BEFORE anything touches the network.
import {
  ALIAS_REGEX,
  MAX_BODY_BYTES,
  MAX_REF_CHARS,
  MAX_REFS,
  MAX_REPLY_TARGETS,
  MAX_AWAIT_REPLY_TIMEOUT_MS,
  MIN_AWAIT_REPLY_TIMEOUT_MS,
  ROOM_REGEX,
} from "../shared/config.js";
import { isValidAlias, isValidRoom } from "../protocol/envelope.js";

export type Validation = { ok: true } | { ok: false; error: string };

export function validateAlias(alias: string): Validation {
  return isValidAlias(alias) && ALIAS_REGEX.test(alias)
    ? { ok: true }
    : { ok: false, error: `invalid alias "${alias}" (expected ${ALIAS_REGEX})` };
}

export function validateRoom(room: string): Validation {
  return isValidRoom(room) && ROOM_REGEX.test(room)
    ? { ok: true }
    : { ok: false, error: `invalid room "${room}" (expected ${ROOM_REGEX})` };
}

export function validateTimeoutMs(raw: string): Validation {
  const n = Number(raw);
  if (!Number.isFinite(n)) return { ok: false, error: `invalid --timeout "${raw}" (not a number)` };
  if (!Number.isInteger(n)) return { ok: false, error: `invalid --timeout "${raw}" (not an integer)` };
  if (n < MIN_AWAIT_REPLY_TIMEOUT_MS || n > MAX_AWAIT_REPLY_TIMEOUT_MS) {
    return {
      ok: false,
      error: `--timeout out of bounds: ${MIN_AWAIT_REPLY_TIMEOUT_MS}..${MAX_AWAIT_REPLY_TIMEOUT_MS} ms`,
    };
  }
  return { ok: true };
}

/** Body: 1..MAX_BODY_BYTES bytes — empty or oversized is refused loudly,
 * never silently truncated (the broker would reject the frame anyway). */
export function validateBody(body: string): Validation {
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes < 1) return { ok: false, error: "message body is empty" };
  if (bytes > MAX_BODY_BYTES) {
    return { ok: false, error: `message body is ${bytes}B (max ${MAX_BODY_BYTES}B)` };
  }
  return { ok: true };
}

/** Comma-separated repo-relative refs (≤ MAX_REFS, each ≤ MAX_REF_CHARS). */
export function validateRefsCsv(raw: string): Validation {
  const parts = raw.split(",").map((p) => p.trim()).filter((p) => p !== "");
  if (parts.length === 0) return { ok: false, error: "--refs is empty" };
  if (parts.length > MAX_REFS) {
    return { ok: false, error: `too many refs: ${parts.length} (max ${MAX_REFS})` };
  }
  for (const p of parts) {
    if (p.length > MAX_REF_CHARS) {
      return { ok: false, error: `ref too long: "${p}" (max ${MAX_REF_CHARS} chars)` };
    }
    if (p.startsWith("/") || p.includes("..") || p.startsWith("\\")) {
      return { ok: false, error: `ref must be repo-relative: "${p}"` };
    }
  }
  return { ok: true };
}

/** Comma-separated reply targets (≤ MAX_REPLY_TARGETS, each a valid alias). */
export function validateReplyToCsv(raw: string): Validation {
  const parts = raw.split(",").map((p) => p.trim()).filter((p) => p !== "");
  if (parts.length === 0) return { ok: false, error: "--reply-to is empty" };
  if (parts.length > MAX_REPLY_TARGETS) {
    return { ok: false, error: `too many reply targets: ${parts.length} (max ${MAX_REPLY_TARGETS})` };
  }
  for (const p of parts) {
    const v = validateAlias(p.replace(/^@/, "").toLowerCase());
    if (!v.ok) return v;
  }
  return { ok: true };
}

/** Split a validated CSV into its trimmed parts. */
export function csvParts(raw: string): string[] {
  return raw.split(",").map((p) => p.trim().replace(/^@/, "").toLowerCase()).filter((p) => p !== "");
}
