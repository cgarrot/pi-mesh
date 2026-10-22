// protocol/task-package.ts — B: the five-field assignment contract.
// The package must be self-contained: a lane has no access to the sender's
// session context, so task/goal/paths/branch/reply travel with the frame.
import { MAX_TASK_PACKAGE_BYTES, MAX_TASK_PATHS, normalizeCaps } from "../shared/config.js";

export interface MeshTaskPackage {
  task: string;
  goalAcceptance: string;
  paths: string[];
  branchBase: { branch: string; base: string };
  reply: { to: string; deadline: string; format: string };
}

export type TaskPackageResult =
  | { ok: true; value: MeshTaskPackage }
  | { ok: false; reason: string };

const TASK_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const EXACT_KEYS = ["task", "goalAcceptance", "paths", "branchBase", "reply"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, field: string, max: number): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (v.length === 0 || v.length > max) return null;
  return v;
}

function relativePath(value: unknown): string | null {
  const p = text(value, "paths", 256);
  if (p === null || p.startsWith("/") || p.includes("\\")) return null;
  if (p.split("/").some((part) => part === "..")) return null;
  return p;
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((k) => actual.includes(k));
}

/** Validate (and copy) a five-field task package. Extra fields are rejected:
 *  an assignment contract with unknowns is a different contract. */
export function validateTaskPackage(value: unknown): TaskPackageResult {
  if (!isRecord(value)) return { ok: false, reason: "taskPackage must be an object" };
  if (JSON.stringify(value).length > MAX_TASK_PACKAGE_BYTES) {
    return { ok: false, reason: `taskPackage exceeds ${MAX_TASK_PACKAGE_BYTES} bytes` };
  }
  const top = Object.keys(value);
  if (top.length !== EXACT_KEYS.length || !EXACT_KEYS.every((k) => top.includes(k))) {
    return { ok: false, reason: `taskPackage must have exactly: ${EXACT_KEYS.join(", ")}` };
  }

  const task = text(value.task, "task", 128);
  if (task === null || !TASK_ID_REGEX.test(task)) {
    return { ok: false, reason: "task must match [A-Za-z0-9][A-Za-z0-9._:/-]{0,127}" };
  }
  const goalAcceptance = text(value.goalAcceptance, "goalAcceptance", 1024);
  if (goalAcceptance === null) return { ok: false, reason: "goalAcceptance must be 1..1024 chars" };

  if (!Array.isArray(value.paths) || value.paths.length === 0 || value.paths.length > MAX_TASK_PATHS) {
    return { ok: false, reason: `paths must be an array of 1..${MAX_TASK_PATHS} entries` };
  }
  const paths: string[] = [];
  for (const raw of value.paths) {
    const p = relativePath(raw);
    if (p === null) return { ok: false, reason: "paths must be repo-relative (no absolute, no .., no backslash)" };
    if (!paths.includes(p)) paths.push(p);
  }

  if (!isRecord(value.branchBase) || !exactKeys(value.branchBase, ["branch", "base"])) {
    return { ok: false, reason: "branchBase must have exactly: branch, base" };
  }
  const branch = text(value.branchBase.branch, "branchBase.branch", 128);
  const base = text(value.branchBase.base, "branchBase.base", 256);
  if (branch === null) return { ok: false, reason: "branchBase.branch must be 1..128 chars" };
  if (base === null) return { ok: false, reason: "branchBase.base must be 1..256 chars" };

  if (!isRecord(value.reply) || !exactKeys(value.reply, ["to", "deadline", "format"])) {
    return { ok: false, reason: "reply must have exactly: to, deadline, format" };
  }
  const to = text(value.reply.to, "reply.to", 128);
  const deadline = text(value.reply.deadline, "reply.deadline", 64);
  const format = text(value.reply.format, "reply.format", 256);
  if (to === null) return { ok: false, reason: "reply.to must be 1..128 chars" };
  if (deadline === null || Number.isNaN(Date.parse(deadline))) {
    return { ok: false, reason: "reply.deadline must be an ISO date-time" };
  }
  if (format === null) return { ok: false, reason: "reply.format must be 1..256 chars" };

  return {
    ok: true,
    value: {
      task,
      goalAcceptance,
      paths,
      branchBase: { branch, base },
      reply: { to, deadline: new Date(deadline).toISOString(), format },
    },
  };
}

/** `cap:<name>` targets route by capability; names are normalized like caps. */
export function capTargetName(to: string): string | undefined {
  const lower = to.trim().toLowerCase();
  if (!lower.startsWith("cap:")) return undefined;
  const name = lower.slice(4).trim();
  return normalizeCaps([name]).length === 1 ? name : undefined;
}

export function isCapTarget(to: string): boolean {
  return capTargetName(to) !== undefined;
}

export type CapSendGate =
  | { ok: true; cap: string; value: MeshTaskPackage }
  | { ok: false; reason: string };

/** Gate for `to: "cap:<name>"`: the cap must be valid AND the five-field
 *  package must be present/valid. This is the one place the tool and tests
 *  share, so "cap without contract" cannot slip through either path. */
export function checkCapSend(to: string, pkg: unknown): CapSendGate {
  const cap = capTargetName(to);
  if (cap === undefined) return { ok: false, reason: "not_a_cap_target" };
  if (pkg === undefined) return { ok: false, reason: "task_package_required" };
  const v = validateTaskPackage(pkg);
  if (!v.ok) return { ok: false, reason: `invalid_task_package: ${v.reason}` };
  return { ok: true, cap, value: v.value };
}

/** Compact, bounded rendering for the injected content (the lane must see
 *  the contract without opening another file). */
export function taskPackageSummary(pkg: MeshTaskPackage): string {
  const clamp = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  return [
    `[task ${clamp(pkg.task, 80)}] ${clamp(pkg.goalAcceptance, 300)}`,
    `paths: ${pkg.paths.slice(0, 8).map((p) => clamp(p, 80)).join(", ")}${pkg.paths.length > 8 ? ` (+${pkg.paths.length - 8})` : ""}`,
    `branch: ${clamp(pkg.branchBase.branch, 80)} @ ${clamp(pkg.branchBase.base, 80)}`,
    `reply: ${clamp(pkg.reply.to, 60)} by ${clamp(pkg.reply.deadline, 40)} — ${clamp(pkg.reply.format, 120)}`,
  ].join("\n");
}
