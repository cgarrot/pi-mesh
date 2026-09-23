# pi-mesh — live agent-to-agent communication for Pi

![CI](https://github.com/cgarrot/pi-mesh/actions/workflows/ci.yml/badge.svg)
![Release](https://github.com/cgarrot/pi-mesh/actions/workflows/release.yml/badge.svg)
![npm](https://img.shields.io/npm/v/pi-mesh-extension)
![License](https://img.shields.io/npm/l/pi-mesh-extension)

**pi-mesh** is a standalone **Pi extension** for live agent-to-agent
communication. Local Pi agents talk to each other in < 50 ms through a tiny
local broker (NDJSON frames over a unix socket or named pipe, protocol
`mesh.v1`). Presence is **observed** (live sockets), statuses are **honest**
(`delivered` ≠ `read` ≠ `answered`), and the durable ledger is **hash-only**
(message bodies are never persisted). Zero runtime dependencies, Node ≥ 20.

```
                ┌────────────────────────────────────────────┐
                │  broker (detached) $TMPDIR/mesh-<uid>/     │
                │  peers / rooms / mailbox / rates (memory) │
                └───────▲───────────────▲─────────────▲──────┘
                        │ connexions persistantes NDJSON │
        ┌───────────────┴───┐   ┌───────┴────────┐   ┌┴───────────────┐
        │ client (agent A)  │   │ client (agent B)│   │ CLI mesh       │
        └───────▲───────────┘   └───────▲────────┘   └────────────────┘
        ┌───────┴───────────┐   ┌────────┴────────┐
        │ extension Pi A    │   │ extension Pi B  │
        │ mesh_send/reply/… │   │ injection       │
        │ ledger hash-only  │   │ followUp/steer/ │
        │ transcript opt-in │   │ abort+steer     │
        └───────────────────┘   └─────────────────┘
```

## Features

- **Honest statuses** — `delivered` = written on the recipient socket (or its
  mailbox), `read` = injected into the recipient session, `answered` = an
  explicit `mesh_reply` arrived. `expired` explicitly says late replies are
  still delivered. Never a completion. When a queued message later leaves
  the mailbox without being delivered (TTL expiry or cap eviction), the
  sender receives an async `ack(dropped_offline)` carrying the original
  msg id — a live `awaitReply` mission settles immediately instead of
  burning its whole timeout, and the session gets an inline re-send hint.
- **Rooms & roles** — presence per room, `member` / `observer` roles,
  declarative policy (allow/deny lists, `force` authorization, rate limits).
- **Offline mailbox** — per-alias queue (cap 100, TTL 1 h) flushed at the next
  hello; senders get the honest `queued_offline` status.
- **Broadcast & reply variants** — `broadcast: true` fans out to a whole
  room (honest `deliveredCount/totalCount`), `mesh_reply` supports
  `replyAll` and targeted `to:` replies. `mesh_send` `replyTo: [aliases]`
  designates WHO receives the reply instead of the sender (single or
  several; default: the sender).
- **Group orchestration** — `mesh_wait_all` + launch mode (`awaitReply: true,
  block: false`): send a mission burst, then get ONE honest group verdict
  (who answered with the answer, who is missing). No sleep, no polling.
  Each answer is ALSO delivered to the session as a `[mesh]` reply event
  (wake-on-answer): an idle sender wakes the moment a mission is answered,
  and the answer frame lands in the inbox so it can itself be replied to.
  While a `mesh_wait_all` is in flight the verdict carries the batch instead
  (no double delivery). A blocking `mesh_send` (default) can be aborted with
  ESC — the pending settles immediately as `cancelled` and a late reply is
  still injected.
- **Inbound batching** — bursts are held while the agent is busy (long tool
  call) and injected as ONE batched message; live preview entries show the
  burst in real time while it happens (zero LLM tokens).
- **Per-agent colors** — every alias gets a stable color; messages, batches
  and live entries render inside the pi custom-message box with the sender's
  color, so agents are recognizable at a glance.
- **Read receipts & activity** — `mesh_status` shows who read your messages
  and who is `● working` / `○ idle` / `✕ stuck` (announced turn state + idle
  heuristic), plus a `likely done` summary.
- **File reservations** — claim repo paths before editing; other agents'
  `edit`/`write` calls on those paths are blocked with the holder's name.
  Reservations live with the connection and expire via TTL.
- **Identity persistence** — alias, rooms and reservations survive `/reload`
  (one file per pi session, never overwritten); `/mesh new` and pi `fork`
  hand the identity over; `/mesh reset` factory-resets in place.
- **Multi-machine** — TCP/TLS broker with a shared token; everything works
  unchanged across machines (VPS, LAN, Tailscale…).
- **Hash-only ledger** — durable history with bodies never stored, plus an
  opt-in redacted transcript. Zero loops: rate caps, anti-duplicate window,
  self-send block, reply dedup, ack-of-ack protection.

## Install

**As a Pi package** (recommended — the extension auto-loads):

```bash
pi install npm:pi-mesh-extension
```

**From source:**

```bash
git clone git@github.com:cgarrot/pi-mesh.git
cd pi-mesh
npm install
npm run build
```

Pi auto-loads the project extension. Open **two Pi sessions** in this
directory (each session gets its own alias):

```bash
# session 1            # session 2
pi                      pi
> /mesh alias           > /mesh alias
# → @agent-a1b2c3       # → @agent-d4e5f6
```

Then, in session 1 (tool call by the agent, or ask it):

```
mesh_send { "to": "agent-d4e5f6", "message": "hello from A" }
# → "delivered m_lxyz_ab12cd34"
```

Session 2 receives `[mesh] @agent-a1b2c3 14:32:05 hello from A (m_lxyz_ab12cd34)`
as a follow-up turn and answers with
`mesh_reply { "msgId": "m_lxyz_ab12cd34", "message": "hi A" }`.
(The short format is the v0.5 default — `contextVerbosity: "full"` restores
the legacy `[mesh] @from (room X, priority, HH:MM:SS) body` prefix.)

The broker **auto-spawns** on first use (lockfile in `$TMPDIR/mesh-<uid>/`).
No daemon management needed. Try `npm run smoke` for a full headless demo
(2 clients, mailbox, broker-kill recovery).

## Tools (Pi extension)

| tool | params | returns (honest one-liner + `details`) |
|---|---|---|
| `mesh_send` | `to?`, `message`, `room?`, `broadcast?`, `priority?`, `reason?`, `awaitReply?`, `block?`, `timeoutMs?`, `refs?`, `replyTo?` | `delivered` / `queued_offline` / `reply: …` / `expired` / `blocked: …` — impossible targets (`"*"`, `"<room>-broadcast"`) refused **locally**; unseen aliases get a soft warning; `awaitReply` toward a peer busy longer than the timeout gets a burst-pattern advisory |
| `mesh_reply` | `msgId`, `message`, `replyAll?`, `to?`, `refs?` | `delivered` or `blocked: reply_without_target` |
| `mesh_wait_all` | `timeoutMs?` | block the turn until every awaited mission is answered (or timeout) — group verdict: who answered (with the answer), who is missing |
| `mesh_status` | `room?`, `all?` | live broker snapshot — peers sharing a room, per-peer version (`⚠` on skew), turn state (`● working / ○ idle / ✕ stuck`), `likely done` summary, read receipts, missions, broker counters |
| `mesh_ledger` | `limit?`, `from?`, `to?`, `room?`, `event?` | durable **hash-only** history — bodies never stored, survives restarts |
| `mesh_history` | `limit?`, `withBodies?` | local **memory ring** (debug — never the ledger) |
| `mesh_reserve` | `paths`, `reason?`, `autoReleaseMs?` | reserve files/dirs — peers' `edit`/`write` get blocked on them; claims expire for conflict checks after `reservationTtlMs` (default 6 h, re-reserve to renew) and can self-release (`autoReleaseMs`) |
| `mesh_release` | `paths?` (omit = all) | release reservations, peers notified immediately |

**The orchestrator pattern** (injected in every session's identity context
and in the bundled skill):

1. Launch the burst: `mesh_send(..., awaitReply: true, block: false)` per
   mission — each returns `delivered` immediately, the mission stays tracked
   in the background (reminders, expiry, answer capture). Every answer
   arrives as a `[mesh]` reply event the moment it lands (the session wakes
   if idle; keep working in the meantime), so `mesh_wait_all` is only needed
   when you must collect the whole batch before continuing.
2. One `mesh_wait_all` for the group verdict — fast answers that arrived
   before the call are included; already-verdict'd missions are never
   re-listed. The verdict is ALSO rendered in the conversation as a colored
   entry: every line with the answering agent's color as the full-width
   background and ADAPTIVE text (dark on light backgrounds, light on dark
   ones — always readable), separated by empty lines (display-only, zero
   LLM tokens).
3. Re-send ONLY to the missing (`✗ NOT ANSWERED`). Never poll with
   `mesh_history`.

**Delivery modes** — `normal` → followUp · `urgent` → steer (interrupts the
current reflection) · `force` → controlled abort of the recipient's turn +
delivery once it settles (requires a `reason`, hashed, never persisted).
Replies always steer. Reply-à-reply (ack-of-ack chains) is delivered as
followUp with an INFO ONLY label — the LLM decides whether it matters.
Reminders arrive with an explicit "reply due for msgId" instruction.

**Read receipts** — when a message is injected into a session, the client
sends a `read` frame back to the sender; `mesh_status` shows
`reads: m_xxx → @agent-2 at 10:22`. This completes the honest-status
promise: `delivered ≠ read ≠ answered`.

## CLI (debug/admin)

```bash
node dist/src/cli/mesh.js broker start|stop|status
node dist/src/cli/mesh.js peers [--room R]     # with per-peer versions
node dist/src/cli/mesh.js send <alias> "text" [--room R] [--await] [--timeout MS]
node dist/src/cli/mesh.js tail                 # follows the local hash-only ledger
node dist/src/cli/mesh.js doctor               # socket? lock stale? pid? protocol?
```

## Configuration

`<stateDir>/config.json` (default `<cwd>/.mesh/config.json`, all optional).
Precedence: defaults < config file < environment.

```jsonc
{ "alias": "alice", "rooms": ["default"], "transcript": false,
  "mailboxCap": 100, "mailboxTtlMs": 3600000, "ledgerMaxBytes": 5242880,
  "activityIdleMs": 120000, "activityStuckMs": 900000,
  "reservationTtlMs": 21600000,
  "watchdog": true, "watchdogSpikeBytes": 2097152, "watchdogMaxCalls": 64,
  "contextVerbosity": "compact",
  "inboundBroadcasts": "immediate",
  "inboundBatchMs": 250, "inboundBatchMaxHoldMs": 30000 }
```

### Deferring unrelated broadcasts

Set `"inboundBroadcasts": "deferred"` or `MESH_INBOUND_BROADCASTS=deferred`
to avoid a model turn for every unrelated room update. The default,
`"immediate"`, preserves existing behavior. Invalid values are ignored
(invalid file values fall back to the default).

Only broadcasts and orphan `replyAll` replies without a case-insensitive
mention of your alias (`@alice` or `alice`, whole alias) are deferred.
Direct messages, mission answers (including LAUNCH wake-on-answer), urgent
and force priority, reminders, and reservation updates remain immediate.
Receipt, transcript, ledger, and mailbox behavior is unchanged.

Deferred frames form a separate, timer-free batch; the next user prompt
queues it with `deliverAs: "nextTurn"` and **no** `triggerTurn`. It begins
`[mesh deferred — N broadcast(s) not addressed to you]`. In the TUI,
`mesh:deferred N` remains in the footer until that prompt starts.
`/mesh inbox` lists sender, time, and a 120-character preview;
`/mesh inbox flush` delivers the pending batch now as one triggered follow-up.
An unrelated direct-message turn does not consume the deferred inbox.

The batch is held locally until input, because Pi has no public API to
cancel an already-enqueued `nextTurn` message (otherwise manual flush would
deliver it twice). If prompt preflight is cancelled after input, messages
already handed to Pi remain queued for the next successful prompt, not
re-sent by flush. Deferred state is session-local and cleared on reset,
reload, or shutdown; use the existing mesh history for older frames.

v0.6 highlights:

- **Wake-on-answer** — every LAUNCH mission answer (`awaitReply: true,
  block: false`) is delivered to the session the moment it lands (stored in
  the inbox, injected with `triggerTurn` through the hardened inbound path):
  an idle sender wakes, a busy one gets the batch, and the answer frame can
  itself be replied to. While a `mesh_wait_all` is in flight the verdict
  carries the batch instead — never a double delivery. Answers are now
  MORE visible than late (orphan) replies, never less.
- **Cancelable blocking sends** — ESC on a blocking `awaitReply` send
  settles it immediately as an honest `cancelled` (was: hanging until the
  30-min timeout); the mission is dropped and a late reply still arrives
  via the orphan-inject path.

v0.5 highlights:

- **Context watchdog** — notifies when ONE turn grows the session file by
  >2 MB or carries >64 tool calls (degenerate generation; measured incident:
  3450 duplicate calls, +7.9 MB, ×10 turn latency). A ≥1 MB file **drop** is
  detected as a compaction and triggers a mesh-context resync. Opt out:
  `"watchdog": false` or `MESH_WATCHDOG=0`.
- **Compact inbound context** — `[mesh] @from HH:MM:SS body (m_id)` by
  default; the full `↩ reply …` instruction shows on first sight per sender,
  every 20 messages and after 30-min silences (survives `/compact`). The
  legacy format: `"contextVerbosity": "full"` / `MESH_CONTEXT_VERBOSE=1`.
- **Reconnect diff** — the ~500-token identity block is sent once per
  session; reconnects inject a one-line peer diff instead.
- **Reservation TTL 6 h** (was unlimited) — stale claims stop blocking
  peers; long runs re-reserve to renew or use `autoReleaseMs`.
  Opt out: `"reservationTtlMs": 0`.
- **`/mesh stale`** — reservations held by peers, with age and TTL state.
- **`npm run report`** — session/ledger health report: bursts, rejected
  results, blocked sends, leaked reservations, **per-session generation
  latency (median/p90 + last-20-turns median — the "degraded NOW" signal
  a full-session median masks)**; exit 1 on findings. v0.5.3.

`.mesh/policy.json` (declarative governance, evaluated at send time):

```jsonc
{ "allow": [{ "from": "*", "to": "*", "room": "*" }],
  "deny":  [{ "from": "observer-*", "to": "*" }],
  "forceAllowedFrom": ["lead"],
  "rateLimits": { "msgPerMin": 30, "urgentPerMin": 15, "forcePerMin": 1 } }
```

Env overrides: `MESH_ALIAS`, `MESH_ROOMS`, `MESH_RUNTIME_DIR`,
`MESH_STATE_DIR`, `MESH_BROKER_URL`, `MESH_BROKER_TOKEN`, `MESH_LISTEN`,
`MESH_TLS_CERT/KEY/CA`, `MESH_TLS_INSECURE`, `MESH_MAX_FRAME_BYTES`,
`MESH_MAILBOX_CAP`, `MESH_MAILBOX_TTL_MS`, `MESH_TRANSCRIPT=1`,
`MESH_ACTIVITY_IDLE_MS`, `MESH_ACTIVITY_STUCK_MS`,
`MESH_RESERVATION_TTL_MS`, `MESH_INBOUND_BATCH_MS`,
`MESH_INBOUND_BATCH_MAX_HOLD_MS`, `MESH_POLICY`, `MESH_WATCHDOG=0`,
`MESH_CONTEXT_VERBOSE=1`.

**Commands** — `/mesh status [room] · join <room> [as <alias>] [observer] ·
leave <room> · alias [<new-alias>] · new [--history] · reset · log [on|off] ·
ping <alias> · broker · help`.

- `/mesh join ops as agent-1` claims the alias `agent-1` and joins room
  `ops` in one step (live rename, rooms + reservations re-declared).
- `/mesh new [--history]` opens a fresh pi session like `/new` but hands
  over the mesh identity (alias, rooms, reservations; `--history` also
  transfers the last 30 mesh frames as context). Stale handoffs expire
  after 15 min.
- `/mesh reset` factory-resets the identity of the CURRENT session (fresh
  alias, default rooms, no reservations) without leaving it; `/reload`
  preserves the identity.
- **Identity survives `/reload`**: alias, rooms and reservations are
  persisted in `<stateDir>/identity-<sessionId>.json` — one file per pi
  session, stable across reloads, sessions sharing a stateDir never
  overwrite each other. Stale persisted reservations older than 24 h are
  dropped at load; if a crashed session still holds the alias, the client
  falls back to a random one (notified + persisted) instead of looping.
- **HUD**: a live widget above the editor shows the connection dot, rooms,
  peers with per-agent colors and turn-state markers (`●`/`○`/`✕`),
  pending awaits, transcript state and the last inbound preview.
- `/mesh broker` reports the version, session file size and compaction
  count, with a `/mesh new` hint past 15 MB.
- `/mesh stale` lists every reservation held by peers with its age —
  the operator sees in one glance who to ping or wait for.

The **`mesh-coordination` skill** (skills/mesh-coordination) is bundled in
the package: a protocol guide for agents (reply once per msgId, expired ≠
lost, reservation etiquette, the launch → wait_all rhythm) — loaded on
demand like any pi skill.

## Multi-machine

The mesh is loopback-only by default; to connect several machines (a VPS, a
LAN PC, a MacBook over Wi-Fi …) start the broker on ONE machine with
`MESH_LISTEN=tcp://…` and a shared token, and point the other machines'
clients at it. Since **v0.4.18** the broker listens on **both endpoints at
once** (dual listen): the local unix socket keeps serving local sessions
tokenless (file-perm protected, zero disruption) while the tcp/tls endpoint
admits remote machines with the token.

```bash
# Machine A (broker + agents) — open the port in the firewall
MESH_LISTEN=tcp://0.0.0.0:8712 MESH_BROKER_TOKEN=change-me pi
# → broker up endpoints=tcp://0.0.0.0:8712 + unix:///tmp/mesh-<uid>/broker.sock

# Machine B (clients only — no local broker is spawned)
MESH_BROKER_URL=tcp://<machine-A>:8712 MESH_BROKER_TOKEN=change-me pi
```

- The broker standalone honors `MESH_LISTEN`/`listen` in `config.json`
  (tcp:// and tls://); the local unix socket stays up in tcp/tls mode so
  already-running local sessions reconnect untouched.
- The token is **required for tcp/tls connections** (per connection: a hello
  without it is refused with `invalid_token`, token travels hashed); local
  unix-socket connections never need it.
- The CLI (`mesh doctor|peers|send|reserve|join`) honors `MESH_BROKER_URL`
  / `MESH_BROKER_TOKEN` / `.mesh/config.json` exactly like extension
  clients — remote machines can debug with `mesh doctor`.
- `tcp://` for LAN/VPN (Tailscale/ZeroTier/WireGuard recommended),
  `tls://` for a VPS (set `MESH_TLS_CERT`/`MESH_TLS_KEY` on the broker;
  clients may set `MESH_TLS_CA`, or `MESH_TLS_INSECURE=1` for self-signed —
  dev only).
- **Remote peers are visible**: every peer carries its connection origin
  (`via=tcp:<ip>` / `tls:<ip>`; broker-local unix peers have none) — shown in
  `mesh_status` (`via=… ⟵ other machine`), `/mesh status`, the session
  context block, and the HUD peers line (`alias⌁<last-ip-octet>`).
- **Privacy note**: `via` exposes the peer IP as seen by the broker — fine
  on a trusted LAN/home mesh; for a multi-org mesh, gate or truncate it
  before it rides any presence broadcast (future policy hook).
- `MESH_DEBUG=1` (env or `"debug": true` in config.json) logs wire-level
  client lifecycle events to `<stateDir>/client-debug.log` — no bodies.
- Everything works unchanged across machines: rooms, broadcast, read
  receipts, mailbox, reservations, turn state (state lives in the broker).
  `mesh doctor` checks the endpoint/auth on any machine.
- Aliases must stay **unique mesh-wide**: prefix per machine
  (`MESH_ALIAS=pcB-agent-2`). Identities/ledgers stay local to each
  machine; reservations protect the same repo paths when both machines
  share the same git checkout (always reserve repo-relative paths).

## Reliability notes

- **Broker is stateless**: kill it any time, clients re-hello and re-declare
  rooms + reservations; it re-spawns automatically.
- **Mailbox is volatile**: a broker restart loses queued offline messages;
  senders always get the honest `queued_offline` status.
- **Zero loops**: rate caps (client and broker), anti-duplicate send window,
  self-send block, reply dedup (first answer wins, exact re-sends dropped),
  reply-à-reply protection, `force` requires a reason.
- **No body is ever persisted** outside the opt-in transcript: the ledger is
  hash-only with a fail-closed forbidden-key scan; `identity-pending.json`
  (the `/mesh new --history` handover) is the only opt-in body staging,
  deleted after consumption.
- **Bounds**: frame 64 KiB, body 32 KiB, mailbox 100/1 h, reminds ≤ 2,
  16 rooms/peer, 64 peers/room — every bound is a named constant.
- **Broker down** → tools answer `blocked{broker_unavailable}`, never crash.
- **Turn state** is announced by each session (busy on the first tool call,
  idle when the run settles) and shared with the room; peers without
  announcements fall back to the idle/stuck heuristic. Provider errors are
  detected from the HTTP status: TRANSIENT ones (429 rate limit, 5xx) flag
  the agent `⛔ rate-limited` (peers pause reminders — no ping-pong of turns
  that burn rate-limited requests; `mesh_wait_all` says "retry later");
  PERMANENT ones (401/403/404…) flag `✖ blocked` (retrying won't heal —
  needs a human). The flag sticks for a 30 s cooldown after the last error.
  While flagged, the session also HOLDS inbound injections (messages and
  reminders are queued, nothing burns a failed turn). Detection reads the
  FAILED ASSISTANT TURN (the SDK throws on HTTP errors, so the response
  status is not observable): the same classification pi uses — quota /
  budget limits (FreeUsageLimitError, insufficient_quota…) and auth
  errors → `blocked` with a LONG hold (30 min, the limit must reset or
  the model must change); plain 429/5xx → `rate_limited` with a 60 s
  hold. Switching the model (`model_select`) lifts the hold and delivers
  the backlog immediately.

## Platform notes

- **Windows**: AF_UNIX sockets are unavailable on win32 (`listen` throws
  `EACCES`), so the broker endpoint falls back to a **named pipe**
  (`\\.\pipe\mesh-<hash>-broker`). Everything else is unchanged; the full
  test suite + smoke pass on Windows.

## Known limitations

- Broker restarts lose rooms/mailbox (clients re-declare on hello).
- One shared token for the whole mesh on TCP/TLS — no per-alias
  authorization yet (policy covers `force` and deny lists).
- Aliases are unique mesh-wide by convention (prefix per machine) — no
  cross-machine collision detection beyond the broker's live check.
- The broker is a single process — no clustering or failover.

## Development

```bash
npm run build   # strict tsc (ESM, NodeNext)
npm test        # build + node --test dist/test/*.test.js (392 tests)
npm run smoke   # E2E without Pi: broker + 2 headless clients
```

CI runs the full suite on Node 24 (GitHub Actions); the suite is verified on
Node 20 as well. Publishing is automatic on `v*` tags (see
`.github/workflows/release.yml`, needs the `NPM_TOKEN` secret):

```bash
npm version patch && git push && git push --tags
```

Layout: `src/protocol` (frames, envelope) · `src/broker` (server, rooms,
mailbox, ratelimit, policy) · `src/client` (MeshClient, pending, reconnect) ·
`src/extension` (Pi adapter: tools, commands, inbound, guards, ledger,
transcript) · `src/cli` · `test/` · `scripts/mesh-smoke.mjs`.

## License

MIT — see [LICENSE](LICENSE).

## For other extensions

After connect/reconnect (and rename), mesh publishes the resolved identity:

```typescript
pi.events.on("mesh:alias", (data) => {
  const { alias, rooms } = data as { alias: string; rooms: string[] };
  // Refresh your own status or integration. No model turn is triggered.
});
const alias = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-mesh:alias")];
```

`alias` has no leading `@`. The symbol is a convenience snapshot of the
latest connected alias in this process, not a cross-process registry;
subscribe to the event for updates. It is undefined before the first
connection and is not a connection-health signal. In-process child sessions
share `globalThis`; consumers needing per-session identity should use their
session's event lifecycle rather than treating the symbol as session-local.
