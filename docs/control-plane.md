# Control plane (`ctl` frames)

`ctl` lets an authorized peer **act on** another agent's turn or on work that
agent owns (a detached job, an RPC worker) — without pi-mesh executing
anything itself.

The design rule: **pi-mesh transports and authorizes; the target acts.** The
broker never runs a shell command and never imports an execution engine.

```
alice ──ctl(abort|redirect|job_*|run_*)──▶ broker ──policy──▶ bob's pi-mesh
                                                              │
                              ┌───────────────────────────────┤
                              │ abort/redirect: bob's turn    │
                              │ job_*: pi-jobd (event bus)    │
                              │ run_*: pi-subagents (bus)     │
                              └───────────────┬───────────────┘
alice ◀──────────── ctl_ack(status, settled) ─┘
```

## Wire shape

```jsonc
// request
{ "type": "ctl", "id": "m_…", "from": "alice", "to": "bob", "room": "default",
  "action": "abort|redirect|job_stop|job_pause|job_resume|run_stop|run_steer",
  "target": "j_… | rpc_…",        // opaque job/run id (not a shell string)
  "body": "new instruction",       // redirect / run_steer only
  "reasonHash": "sha256(…)" }      // abort/redirect REQUIRED

// reply
{ "type": "ctl_ack", "id": "m_…", "replyTo": "m_…", "from": "bob", "to": "alice",
  "status": "aborted|redirected|stopped|paused|resumed|steered|not_busy|…",
  "action": "abort", "settled": true }
```

`ctl` is **online-only**: no mailbox, no `queued_offline`. If the target is
offline the broker answers `unreachable`; a destructive action queued for
later would be a surprise. If the ack never arrives, the sender reports an
honest **timeout** and **never retries** — the target may have acted.

## Policy

| action | policy class | requirement |
|---|---|---|
| `abort`, `redirect` | `force` | `forceAllowedFrom` must include the sender, **and** a `reasonHash` is mandatory |
| `job_*`, `run_*` | `normal` | the regular allow/deny rules |

An abort is destructive: the target's in-flight reasoning is lost (history
stays). That is why it is force-class by default, not an ordinary message.

`run_steer` is **normal-class** (like `mesh_send(priority: "urgent")`): an
authorized peer can inject an instruction into a worker without a reason.
`redirect` aborts a human-facing turn, hence force-class. The asymmetry is
deliberate — add a `deny` rule if remote steering should be narrower.

## Ack binding (forged/stale acks)

The broker keeps a bounded `ctl id → {from, to, action}` map (TTL 60 s):

- a `ctl_ack` is relayed **only** if `replyTo` matches a pending ctl,
- the ack must come from the ctl's target and go to its sender,
- the ack `action` must match the request action.

Anything else is dropped silently. A peer cannot answer someone else's
mission, and a target cannot turn an `abort` into a `stopped`.

## Local dispatch (how the target acts)

The target's pi-mesh handles `abort`/`redirect` itself (`ctx.abort` +
`isIdle`, then a steer injection). Job and run actions are dispatched to the
owning extension over the **local** event bus — no package imports:

```
emit  "mesh-ctl"                  { ctlId, action, target, message?, from, to }
on    "mesh-ctl:reply:<ctlId>"    { status, reason?, settled? }
```

- `pi-jobd` answers `job_*` for jobs whose `owner` equals this session's mesh
  alias (`PI_MESH_ALIAS`, set by pi-mesh). A CLI-started job (OS user) is not
  remotely controllable — deliberate.
- `pi-subagents` answers `run_*` for its controller-owned RPC workers.
- If no extension answers within 5 s, pi-mesh acks `unsupported` — never a
  false success.

The status vocabulary is closed and honest: `aborted`, `redirected`,
`stopped`, `paused`, `resumed`, `steered`, `not_busy`, `still_busy`,
`abort_unavailable`, `not_found`, `not_pausable`, `not_paused`,
`not_running`, `not_supported`, `unsupported`, `not_authorized`,
`identity_mismatch`, `timeout`, `error`. A target-side `timeout` means the
local handler did not answer within 12 s (it may still be acting) — it is not
reported as "unsupported", which would claim no handler exists.

## Audit (hash-only ledger)

Both ends record one durable `ctl` entry. The target records when it acks;
the sender records the same ctl id with the returned status (`recordCtl` in
`extension/tools.ts`), so an abort ordered by an agent leaves a trace on both
sides:

```jsonc
{ "event": "ctl", "id": "m_…", "from": "alice", "to": "bob",
  "action": "redirect", "target": "rpc_…", "code": "redirected",
  "bodyHash": "sha256(the instruction)", "reasonHash": "sha256(why)" }
```

The instruction itself is **never** written: only its hash, exactly like every
other message body. A ledger write failure increments `ledgerFailures`; it
never blocks or fakes the control action. A sender-side record has
`from` = the sender, `to` = the target, `code` = the returned status.

## Threat model

- The trust boundary is the **host process**: an extension that can listen on
  `pi.events` can already run local code / bash. The event bus adds no
  privilege; it only decouples the packages.
- The broker enforces `from`/`to` policy. `abort`/`redirect` are force-class
  and require an explicit `forceAllowedFrom` entry plus a reason.
- The ctl id binding prevents a **peer** from forging an ack for someone
  else's mission. It does not protect against a compromised target (which can
  lie about its own state — no protocol can).
- The mesh never carries a shell string: `target` is an opaque id and the
  action is a closed enum.
- A lost ack is reported as a timeout; destructive actions are never retried
  automatically.
- `PI_MESH_ALIAS` is process-global: one Pi session per host process is
  assumed. A stale value after a disconnect is harmless locally, but it can
  make a remote job control `not_authorized` (the job owner no longer matches
  the live alias).

## Recipient-side authorization (follow-up)

Broker policy and sender gates answer "may this peer send a ctl into this
room?"; they do not answer "does this target accept being driven by this
peer?". A follow-up adds a **target-side opt-in allowlist**, asymmetric by
action class:

- **stop-class** (`job_stop` / `job_pause` / `job_resume` / `run_stop`):
  unchanged — same-room sender, broker policy, and the jobd owner rule
  (`job.owner === local mesh alias`). Bounded, observable, reversible.
- **steer-class** (`run_steer`, and any future action that injects an
  instruction into a worker): **default-deny**, with a per-session
  `ctl.allowFrom` allowlist. A refusal is `not_authorized` and names the
  missing permission. Rationale: a message reaches a session through the
  visible inbox (renderer, injection guard); a steer injects directly into a
  headless worker with the controller's trust, with no human in the loop.

The allowlist is **target-side only**; the broker stays a dumb, policy-checked
router. The allowlist and the jobd owner rule are independent — both must
pass (the peer is allowed to drive this session **and** the job belongs to
this alias). Tracking: the follow-up issue.

## Tools

| tool | action |
|---|---|
| `mesh_abort` | abort a peer's current turn (force-class, reason required) |
| `mesh_redirect` | abort → settle → inject the new instruction (atomic) |
| `mesh_job_control` | stop/pause/resume a peer's detached job |
| `mesh_run_control` | stop/steer a peer's RPC worker |

A plain steer is still `mesh_send(priority: "urgent")` — no new tool.

## What this is not

- Not a remote shell: `target` is an opaque id, actions are a closed enum.
- Not an execution engine: the broker relays and checks; the target's
  extension acts locally.
- Not a queue: offline is `unreachable`, timeout is `unknown`, no retry.
- Not a completion: `aborted` means the turn settled, not that the peer
  adopted your plan. `redirected` means the instruction was injected.
