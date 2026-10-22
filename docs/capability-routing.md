# Capability routing + task leases

Two primitives that turn "wait for a busy teammate" into "route to an idle
qualified peer" and make task ownership auditable:

1. **`cap:<name>` routing** — send a task to whoever is idle AND advertises the
   capability, instead of a specific alias.
2. **Task leases with an epoch fence** — one writer per task; a commit whose
   `Mesh-Lease` trailer is stale is rejected by the `commit-msg` hook.

Both are protocol-level: peers on the same broker get them without extra setup.

## 1. Advertise capabilities

```bash
MESH_CAPS=deploy,git,python pi          # env (csv)
```

or in `<cwd>/.mesh/config.json`:

```json
{ "caps": ["deploy", "git"] }
```

Rules: lowercase `[a-z0-9][a-z0-9._-]*`, ≤16 caps, ≤32 chars each; invalid
entries are dropped (a bad value never breaks the hello). Caps are **routing
hints only** — authorization is still `policy.json`'s `from`/`to` rules.

Legacy peers (protocol 1) advertise nothing, so a cap route can never silently
target an old client: you get an honest `caps_unsupported`.

## 2. Send to a capability

`to: "cap:<name>"` requires the **five-field task package** — a lane has no
access to your session context, so the contract must travel with the task:

```json
{
  "to": "cap:deploy",
  "priority": "urgent",
  "taskPackage": {
    "task": "eia-hotfix-1",
    "goalAcceptance": "urgent 绕过 batch；测试全绿",
    "paths": ["src/extension/batcher.ts"],
    "branchBase": { "branch": "agent/a/eia-hotfix-1", "base": "f929821" },
    "reply": { "to": "lead", "deadline": "2026-10-21T12:00:00+08:00", "format": "commit + tests" }
  }
}
```

- Missing/extra fields are rejected (`invalid_task_package`); the recipient
  sees the contract inline (`[task …] goal / paths / branch / reply`).
- Routing: **idle-first**, then least-busy (`busyForMs` smallest); observers
  are never chosen; policy is evaluated per candidate.
- Honest failures: `caps_unsupported` (nobody advertises caps), 
  `no_capable_peer` (caps advertised but no match / nobody online),
  `policy_denied`.
- v1 has **no cap queue**: nobody idle/online → error; offline peers stay
  reachable by alias/mailbox as before.

## 3. Claim the task (single writer)

```
mesh_claim({ task: "eia-hotfix-1", paths: ["src/..."], ttlMs: 3600000 })
→ lease granted l_xxx task=eia-hotfix-1 fence=<epoch>:<fence> expires=<iso>
```

- One holder per task: a second owner gets `lease held by @lead`.
- Same owner re-claiming is idempotent (same leaseId/fence).
- The lease expires by TTL; the broker stores it in memory, and the epoch is
  persisted in `<stateDir>/broker-epoch` — **a broker restart always
  invalidates old fences** (a stale worker cannot resurrect a task).

Carry the lease into your commits:

```
Mesh-Lease: <task>#<leaseId>#<epoch>:<fence>
```

## 4. Gate commits on stale fences

```bash
cp scripts/hooks/commit-msg .git/hooks/commit-msg
chmod +x .git/hooks/commit-msg
```

Policy (see the hook header):

| case | result |
|---|---|
| no `Mesh-Lease` trailer | allow (not every commit is a task commit) |
| trailer matches the broker | allow |
| trailer stale (restart / re-claim / TTL) | **reject** — re-claim with `mesh_claim`, amend the trailer |
| broker or `pimesh` unavailable | fail-open with a loud warning |

Manual check:

```bash
pimesh lease verify --task T --lease-id ID --epoch N --fence N
# exit 0 = current, 5 = stale, 1 = broker unavailable
```

## Limits

- Caps are not authorization; policy still decides who may receive what.
- A provider rate-limit/block hold delays EVERY inbound priority, including
  urgent — urgent is not a delivery guarantee.
- Lease state is broker memory: after a restart, re-claim before continuing
  (the old fence is stale by design). Leases are **not broadcast** to the
  room — a peer discovers a lease by claiming it (`lease held by @owner`),
  so `mesh_claim` before editing is the convention that makes it work.
- Cap routing and leases need a **protocol-2 broker**. After upgrading the
  package, restart the long-lived broker once (`pimesh broker stop`); an old
  broker answers `error: broker_too_old` instead of silently timing out.
