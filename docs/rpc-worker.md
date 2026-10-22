# Headless RPC worker (`mesh_rpc`)

A controller-owned `pi --mode rpc` worker for cases where a runaway run must be
stopped **now**, even while it is inside a long `bash` call. The controller
speaks the RPC protocol directly, so it can:

- `abort` — stop the whole run (the running bash tool included) in ~8ms,
- `redirect` — abort, wait for settlement, then prompt the replacement
  instruction in one call,
- `steer` / `follow_up` — deliver the next instruction at the next boundary
  (no abort),
- `get_state` / `set_steering_mode` — inspect pending/steering state.

This is the C line: **deterministic stop + restart instead of waiting for the
worker's LLM to read a message**. It is not a mesh proxy and does not replace
the job daemon.

> **Verified limitation (real pi 0.73.x):** `abort_bash` only aborts a *direct
> RPC bash command* (`session.executeBash`); it does **not** abort the agent's
> `bash` **tool**. `agent-session.abortBash()` iterates
> `_bashAbortControllers`, which only direct bash populates. Use `abort` or
> `redirect` for agent tool calls. The smoke that proved this is below.

## Quick start

```
mesh_rpc({ action: "start", cwd: "/repo", model: "glm-5.3" })
→ rpc worker started pid=4242 cwd=/repo

mesh_rpc({ action: "prompt", message: "run the integration suite" })
mesh_rpc({ action: "status" })
mesh_rpc({ action: "state" })

# the worker is stuck in a 10-minute bash:
mesh_rpc({ action: "redirect", message: "use the new cache dir and retry" })
# same thing, explicit: abort (stops the run, bash included) then prompt
mesh_rpc({ action: "abort" })
mesh_rpc({ action: "prompt", message: "use the new cache dir and retry" })

mesh_rpc({ action: "stop" })           # TERM→KILL, worker gone
```

One worker per controller session. Starting twice while alive is an error;
`stop` clears it. The session shutdown handler also stops the worker so a
controller exit cannot leak a headless pi process.

## `abort` / `redirect` / `steer`

| command | effect | history |
|---|---|---|
| `abort` | stops the run; the running bash tool ends (`Command aborted`) | committed messages/tool results stay |
| `redirect` | `abort` → wait `agent_settled` → `prompt(message)` | new turn sees the aborted result |
| `steer` | queues a steering message, **no abort** | delivered at the next boundary |
| `follow_up` | queues a follow-up | delivered when the agent would stop |

`redirect` is the one-call fast path for "stop the 10-minute command and do
this instead". The in-flight turn's reasoning is lost (the session history is
not); that is the bounded cost of not forking pi core.

`abort_bash` remains an RPC primitive for direct RPC `bash`, but `mesh_rpc`
does **not** expose it — it is a no-op for agent tool calls and would be a
false promise.

## How it works

- `RpcWorker` spawns `pi --mode rpc --no-session` with an argv array (no
  shell), parses strict LF-delimited JSON (never readline, so U+2028 inside a
  string is safe), correlates responses by `id`, and streams session events.
- It deliberately does **not** import the host's `RpcClient`: pi-mesh must not
  add `@earendil-works/pi-coding-agent` as a dependency. The command surface
  is the documented RPC subset.
- Binary resolution: `PI_RPC_BIN` override, else `process.execPath` +
  `process.argv[1]` (the pi CLI entry), else `pi` on PATH.
- The worker is local-only and controller-owned (`detached: false`); `stop()`
  is SIGTERM, then SIGKILL after a bounded grace. Pending requests reject on
  stop/child exit.
- Tests use `test/fixtures/fake-rpc-worker.mjs` for protocol/framing; a real
  pi smoke is required for host semantics (see above).

## Real smoke (required gate; not CI by default)

Run with `PI_RPC_REAL=1` (or manually) against the installed pi:

```
mesh_rpc({ action: "start", cwd: "/tmp", model: "<your model>" })
mesh_rpc({ action: "prompt", message: "Use bash to run: sleep 60; echo DONE > /tmp/rpc-smoke-marker. Then reply DONE." })
# after tool_execution_start(bash):
mesh_rpc({ action: "redirect", message: "Reply exactly RECOVERED" })
mesh_rpc({ action: "state" })
mesh_rpc({ action: "stop" })
```

Verified on 2026-10-21 (pi 0.73.x, GLM-5.3):

- `abort_bash` returned success but the bash ran 60s and the marker existed;
- `abort` ended the tool in **8ms** (`Command aborted`), `agent_settled
  aborted=true`, marker absent;
- the next `prompt("Reply exactly RECOVERED")` returned `RECOVERED` normally.

Fake-child tests must not be the only gate for host semantics; a fake cannot
prove what pi core does.

## Limits

- No remote/cross-machine workers, no worker pool, no auto-restart, no UI
  forwarding, no RPC proxy over mesh.
- The worker is headless: you cannot watch its TUI. Its own mesh extension (if
  installed) joins the mesh separately under its own alias.
- Each worker costs model tokens; starting one is an explicit choice. `stop`
  is the only cleanup guarantee; a crashed controller relies on the OS.
- `redirect` loses the in-flight turn's reasoning (history is preserved). If
  preserving the turn itself is a hard requirement, that is a pi-core feature
  (tool-level abort), not a pi-mesh extension. Do not fake it with a no-op.
