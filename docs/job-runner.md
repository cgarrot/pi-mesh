# Job runner + stop/pause/resume control plane

Long work should not block the agent. This feature runs a command as a
**detached, supervised job** and lets a peer stop/pause/resume it through a
**daemon that executes the command itself** — no LLM turn, no queued message
behind a long tool call.

## Quick start

```
mesh_run({ command: "npm run render -- --long", cwd: "/repo", pausable: true })
→ job started j_7k2… pid=4242 log=…/jobs/j_7k2….log

mesh_job({ jobId: "j_7k2…", action: "status" })   # running/paused/exited/stopped/failed/lost
mesh_job({ action: "list" })                     # this daemon's jobs
mesh_job({ jobId: "j_7k2…", action: "pause" })   # SIGSTOP (pausable only)
mesh_job({ jobId: "j_7k2…", action: "resume" })  # SIGCONT
mesh_job({ jobId: "j_7k2…", action: "stop" })    # local stop

mesh_control({ to: "lead", jobId: "j_7k2…", action: "stop" })   # → lead-jobd
mesh_control({ to: "lead", jobId: "j_7k2…", action: "pause" })
```

`mesh_control` targets the daemon alias: `<owner>-jobd` (passing
`lead-jobd` directly also works; `daemon.json` records the actual alias after
a `-2` collision). It returns `stopped` / `paused` / `resumed` /
`not_pausable` / `not_found` / `error` from the daemon's `control_ack`.

## How it works

```
pi session ──0600 unix socket──▶ jobd (detached) ──spawn──▶ job (own process group)
     │                              ▲
     └── mesh control:stop|pause|resume ─┘  (a peer can send it too)
```

- Each session owner gets its own daemon: socket
  `<runtimeDir>/jobd-<owner>.sock` (0600), state
  `<stateDir>/jobd/<owner>/` (jobs/registry/pid/daemon.json), alias
  `<owner>-jobd`. Two sessions never share a socket, alias, registry or job
  table; cross-owner control is explicit (`to: "bob-jobd"`).
- The first `mesh_run` auto-spawns the daemon (detached; it survives the pi
  session).
- Jobs run via `/bin/bash -lc <command>` in their **own process group**,
  with output appended to
  `<stateDir>/jobd/<owner>/jobs/<jobId>.log` and a JSON registry at
  `<stateDir>/jobd/<owner>/jobs/<jobId>.json`.
- The daemon joins the mesh as `<owner>-jobd` (caps `jobd`) and handles
  `control` frames directly. The protocol only allows
  `action=stop|pause|resume` and a job-id-shaped `target`; **no shell string
  crosses the mesh**.
- `stop` sends SIGTERM to the process group, waits a bounded grace (5 s),
  then SIGKILL; the terminal state (`stopped` / `exited` / `failed`) and exit
  code/signal are recorded. A paused job is SIGCONTed first, then stopped.
- `pause`/`resume` are **opt-in**: a job must be started with
  `pausable: true`; otherwise the daemon returns `not_pausable` and never
  applies SIGSTOP. `pause` = SIGSTOP to the group, `resume` = SIGCONT.

## Lifecycle and limits

| Situation | Behavior |
|---|---|
| pi session exits | daemon + jobs keep running |
| daemon restarts | running/paused jobs become `lost` (no re-attach in v2) |
| daemon closes normally | paused jobs are SIGCONTed first (never left stopped forever) |
| daemon dies | jobs are orphaned; stop/pause is unavailable until manual cleanup |
| daemon crashes with a paused job | the process stays SIGSTOPed; resume it with `kill -CONT <pid>` (after restart the record is `lost`) |
| job already finished | `stop` returns the terminal record; the ack says `stopped` with `state=…` |
| broker down | local jobs still run; mesh control is unavailable until reconnect |

Out of scope in v2: orphan adoption by pid (deferred to v3: pid reuse, lost
exit codes, cross-platform), remote `run` over mesh, job queues, log rotation.
SIGSTOP is opt-in because it is unsafe for git/pip/network transfers.

Mixed versions: a v2 `pause`/`resume` sent to a pre-v2 daemon is rejected by its
frame validation and surfaces as a **timeout** (fail-closed; nothing is
executed). Upgrade all daemons in a mesh together; `stop` remains compatible.

## Security model

- `mesh_run` is **local-only** and equivalent to the agent's own bash tool;
  the 0600 socket + same-user assumption is the trust boundary.
- The mesh control plane cannot start processes: action is a closed enum
  (`stop` / `pause` / `resume`), target must match
  `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`.
- Who may control: the broker's `policy.json` `from`/`to` rules decide
  whether the control frame is relayed; the daemon then only acts on jobs it
  owns (and only pauses jobs that opted in).
- Logs/registry are best effort; a lost registry record does not kill the OS
  process.
