// cli/args.ts — zero-dependency argument parser (V3: no commander/yargs).
// Supports: --flag, --opt value, --opt=value, -o value, `--` end-of-options,
// repeated value options, and auto --help/-h detection. Every parse error is
// a usage error (exit 2) — the caller prints usage + the reason.

export type ArgKind = "flag" | "value" | "repeat";

export interface ArgSpec {
  /** long name without leading dashes (e.g. "room") */
  name: string;
  kind: ArgKind;
  /** short single-letter alias without the dash (e.g. "R") */
  short?: string;
  /** one-line help shown by `mesh help <cmd>` */
  help?: string;
  /** placeholder for the value in usage lines (e.g. "MS") */
  meta?: string;
}

export interface ParsedArgs {
  /** names of flags present */
  flags: Set<string>;
  /** option name → value (last wins) */
  values: Map<string, string>;
  /** option name → all values (repeat kind) */
  repeats: Map<string, string[]>;
  /** positional operands, in order */
  positionals: string[];
}

export type ParseResult =
  | { ok: true; parsed: ParsedArgs; help: boolean }
  | { ok: false; error: string };

/** Parse argv against specs. Never throws — errors are honest strings. */
export function parseArgs(argv: string[], specs: ArgSpec[]): ParseResult {
  const byLong = new Map<string, ArgSpec>();
  const byShort = new Map<string, ArgSpec>();
  for (const s of specs) {
    byLong.set(s.name, s);
    if (s.short !== undefined) byShort.set(s.short, s);
  }

  const flags = new Set<string>();
  const values = new Map<string, string>();
  const repeats = new Map<string, string[]>();
  const positionals: string[] = [];
  let help = false;
  let noMoreOptions = false;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] ?? "";

    if (noMoreOptions || a === "-" || !a.startsWith("-")) {
      positionals.push(a);
      continue;
    }
    if (a === "--") {
      noMoreOptions = true;
      continue;
    }

    // --help / -h : recorded, parsing continues (later args still validated)
    if (a === "--help" || a === "-h") {
      help = true;
      continue;
    }

    let name: string;
    let inlineValue: string | undefined;
    if (a.startsWith("--")) {
      const body = a.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        name = body.slice(0, eq);
        inlineValue = body.slice(eq + 1);
      } else {
        name = body;
      }
    } else {
      name = a.slice(1);
    }

    const spec = byLong.get(name) ?? byShort.get(name);
    if (spec === undefined) {
      return { ok: false, error: `unknown option: ${a}` };
    }

    if (spec.kind === "flag") {
      if (inlineValue !== undefined) {
        return { ok: false, error: `option --${spec.name} takes no value` };
      }
      flags.add(spec.name);
      continue;
    }

    // value / repeat: inline (--opt=v) or the next argv token
    let value = inlineValue;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined) {
        return { ok: false, error: `option --${spec.name} requires a value` };
      }
      value = next;
      i += 1;
    }
    values.set(spec.name, value);
    const list = repeats.get(spec.name) ?? [];
    list.push(value);
    repeats.set(spec.name, list);
  }

  return { ok: true, parsed: { flags, values, repeats, positionals }, help };
}

/** Render the usage fragment for a spec list: [--room R] [--await] ... */
export function specUsage(specs: ArgSpec[]): string {
  return specs
    .map((s) => {
      const flag = s.short !== undefined ? `-${s.short}, --${s.name}` : `--${s.name}`;
      if (s.kind === "flag") return `[${flag}]`;
      return `[${flag} ${s.meta ?? s.name.toUpperCase()}]`;
    })
    .join(" ");
}
