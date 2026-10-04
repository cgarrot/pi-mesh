# Contributing to pi-mesh

Thanks for helping! This project is small and focused — please read the
README first, then these guidelines.

## Project shape

- **Zero runtime dependencies.** Everything is plain Node (ESM, NodeNext).
  The only dependency is the Pi SDK (`@mariozechner/pi-tui`, dev/peer only,
  for the message renderers).
- **Layered**: `protocol/` (frames + validation) → `broker/` (server) →
  `client/` (MeshClient) → `extension/` (thin Pi adapter). The first three
  layers must never import Pi.
- **Honesty is a feature**: `delivered ≠ read ≠ answered`, statuses are
  never inflated, errors are explicit. Keep it that way.

## Design rules

- **One tool = one action.** Before adding a tool, check whether
  `mesh_send` + a convention covers the need. Deterministic needs
  (waiting, locking, checking) deserve tools; soft patterns (standby,
  naming) deserve conventions — never the other way around.
- **Every bound is a named constant** in `src/shared/config.ts`.
- **Comment the WHY, not the what.** No dev-tracking codes in comments;
  explain invariants in plain language.
- **Never persist message bodies** outside the opt-in transcript. The
  ledger stays hash-only; the forbidden-key scan is fail-closed.
- **Interrupt wording is honest by construction**: the extension reports
  `turn aborted` / `still busy` — never "process killed" (not observable
  from inside), and receipts never settle an awaited mission.

## CLI rules (`pimesh`)

- **Zero runtime dependencies** — the CLI ships the same homemade arg
  parser and ANSI helpers as the rest of the package (no commander/chalk).
- **Honest exit codes** (README): 0/1/2/3/4 — never inflate a status.
- **Never print a body you were not addressed**: `watch` shows `bodyHash`
  only; `attach` (a recipient) may show bodies; `send --json` never echoes
  the body it sent.
- **No read receipts from one-shot commands** — only interactive `attach`
  on a TTY reads, at render time.
- **The CLI never writes identity files** (`sessions` is read-only;
  adoption only READS a dead session's identity).
- **Token never in argv** (env/config only; `config show` masks it).
- **An explicit `--alias` is strict** — a collision exits 1
  (`blocked:alias_taken`), never a silent fallback identity.
- **Every bound is a named constant** — CLI_* constants live in
  `src/shared/config.ts` like every other bound.

## Development loop

```bash
npm install
npm run build       # strict tsc (ESM, NodeNext)
npm test            # build + node --test dist/test/*.test.js
npm run smoke       # E2E without Pi (broker + 2 headless clients)
```

- Tests run on Node 20 and Node 24 — the suite must pass on both
  (`npx -y node@24 scripts/run-tests.mjs`).
- Windows is a first-class platform (named pipes instead of AF_UNIX) —
  never break it.

## Releasing

Maintainers only:

```
npm version patch          # bumps package.json + creates the v* commit
npm run build              # REGENERATES src/shared/version.ts (generated file)
git add src/shared/version.ts && git commit --amend --no-edit
git push && git push --tags
```

The `Release` GitHub Action runs the full suite and publishes
`pi-mesh-extension` to npm (requires the `NPM_TOKEN` secret).
The build step is NOT optional: `npm version` alone would leave the
committed (generated) `version.ts` one version behind, and the tagged tree
would fail `version-sync.test.ts`.

## Reporting issues

Include: pi version, OS, `mesh doctor` output, and the exact tool call or
command that failed. Bugs about honest statuses (a status that overstates
delivery/read/answer) are always taken seriously.
