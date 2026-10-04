---
name: mesh-coordination
description: Guide for using the multi-agent mesh (pi-mesh) — messaging, replies, reservations, anti-loop rules. Read it when you coordinate with other agents or answer a mesh message.
---

# Mesh coordination (pi-mesh)

You are connected to a local mesh of pi agents. Rules and reflexes to avoid
duplicates, loops and confusion.

## Know your identity

- Your alias is injected at session start: `[mesh] you are @<alias> (rooms: …)`.
  It is **stable across /reload** and only changes via `/mesh alias <name>`,
  `/mesh reset` (fresh random alias) or `/mesh new` (identity handed to the
  next session).
- The pi session name `mesh @<alias> · <rooms>` mirrors that identity — it is
  NOT a separate agent.
- **If in doubt, `mesh_status` shows your alias** (first line) and who is
  online. Never guess who you are from the conversation alone.
- A session that inherits an alias (e.g. `/mesh new` handoff) IS that agent:
  same alias, same rooms, same reservations.
- You can NEVER take an alias held by a live peer (`alias_taken`): the error
  names the holder. Close that session first, or pick another alias.

## Get oriented

- `mesh_status` — who is online, in which room, **status** (`○idle`,
  `✕stuck` = idle long with reservations), and read receipts (`reads:`).
- `mesh_history` — recent exchanges (memory).
- `mesh_ledger` — durable history (hash-only): filter by
  `from/to/room/event`. **Use it to verify before re-sending.**

## Sending

- `mesh_send { to: "agent-X", message }` — direct message (shared room
  required).
- **Room resolution**: without an explicit `room`, the message goes to
  `default` when you are still in it, otherwise to your FIRST joined room.
  A session that left `default` (e.g. only in `cs-room`) sends into its
  remaining room — never assume `default`. If in doubt, `mesh_status` shows
  your rooms.
- `mesh_send { broadcast: true, room: "cs-room", message }` — announce to the
  whole room (the result reports `delivered N/M`).
- `awaitReply: true` waits for an answer (30 min default timeout).
- **`replyTo: ["agent-Y", "agent-Z"]`** — designate WHO receives the reply
  instead of you (single alias or list). The recipient's plain `mesh_reply`
  then goes to ALL of them. Include yourself in the list if you also want the
  answer (e.g. with `awaitReply`). Default: the reply comes back to the
  sender.
- A message whose sender set `replyTo` shows `(reply goes to @Y, @Z)` —
  answer it with `mesh_reply` as usual; it will be routed to those targets.
  You can still override with `to:` (single) or `replyAll: true` (room).

## Replying (GOLDEN RULES)

1. **Always `mesh_reply { msgId, message }` with the EXACT msgId received** —
   never answer with a new `mesh_send`.
2. **One answer per msgId.** If the result says `⚠️ already replied to this
   msgId recently` — you ALREADY replied: do not insist, the answer is gone
   (`delivered`).
3. **`replyAll: true`** to answer the WHOLE room of the original message
   (e.g. "mission done" visible to everyone).
4. **`to: "agent-Y"`** to forward the answer to another agent than the
   sender.
5. A **reminder** says *"IGNORE this reminder if you ALREADY replied to this
   msgId"*: if you already replied, **ignore it**.
6. **NEVER reply to a reply** (reply-à-reply). Replies to replies arrive with
   the **INFO ONLY** label: read them (a proof or a correction can be
   important), but **never answer with an acknowledgment** — to react
   (question, correction), send a **new message** (`mesh_send`), not a reply.

## Launch a burst, then wait_all (delay-free, general pattern)

1. **Launch** every mission with `awaitReply: true, block: false` — the
   tool returns `delivered` immediately and the mission stays tracked in
   the background (reminds, expiry, answers). A burst of N missions costs
   one turn, not N blocking calls. **Each answer arrives the moment it
   lands as a `[mesh]` reply event** (an idle session wakes; keep working
   in the meantime) and lands in the inbox, so it can be replied to.
2. **`mesh_wait_all { timeoutMs }`** — the turn is suspended INSIDE the
   tool call (no sleep, no polling). It returns the honest group verdict:
   who answered (with the answer), who is missing. Fast answers that
   arrived before the call are included; already-verdict'd missions are
   not re-listed. While it runs, answers are carried by the verdict (not
   injected again). Reach for it only when you must collect the whole
   batch before continuing.
3. **ESC cancels a pending `mesh_wait_all`** — the verdict says
   `(CANCELLED — ESC)` and reports NOTHING: the missions stay reportable,
   so a later `mesh_wait_all` re-lists them. Use it to abort a long wait
   without losing the batch.
4. Re-send ONLY to the missing (`✗ NOT ANSWERED`).
- Never poll with `mesh_history`/`mesh_status` to check who answered —
  that is what `mesh_wait_all` is for.
- `block: false` without `awaitReply` is refused; `awaitReply` without
  `block: false` blocks the turn until that one reply (fine for a single
  awaited send — and ESC now cancels it: the mission is dropped and a
  late reply is still injected).

## Orchestrator rhythm (delay-free)

- **NEVER `sleep` while awaiting replies.** A `sleep` is a long tool call:
  incoming messages stay queued until it finishes, then arrive in one big
  burst. Instead: END YOUR TURN — inbound replies trigger a new turn
  automatically (triggerTurn), delivered between tool calls.
- **Process replies as they arrive**, one at a time. Do not batch-answer.
- **`awaitReply: true`** resolves each mission as its answer lands — keep
  the loop tight: send, treat the reply, move on.
- **NEVER send acknowledgments** ("received", "thanks", "ok"). An ack
  generates an ack-of-ack and burns tokens (INFO ONLY replies are already
  labelled; read them, do not answer them).

## Anti-loops (orchestrator)

- **`expired` ≠ lost.** A late answer is delivered and injected
  automatically. Before re-sending a mission: check `mesh_ledger` or
  `mesh_history` to see whether the answer already arrived.
- Do not re-assign an already delivered mission: check the register
  (MISSIONS.md / work folder) AND `mesh_ledger` first.
- Agents can be `✕stuck` (idle with reservations): contact them via
  `mesh_send` before concluding they are lost.

## File reservations

- **`mesh_reserve { paths: [...] }` BEFORE editing** a shared file;
  `mesh_release` as soon as you are done.
- If an `edit`/`write` is **blocked**: another agent reserved the path —
  `mesh_send` the owner to coordinate, do not force it.
- Reservations disappear on disconnect (and after the configured TTL).

## Honest statuses

`delivered` = written on the recipient's socket (≠ read ≠ answered).
`reads:` in `mesh_status` shows who has taken knowledge of your messages.

## Unblocking a stuck agent (escalation ladder)

A peer stuck inside a long/hung command (`✕stuck`, or not answering while a
tool runs) is unblocked through the ESCALATION LADDER — never jump to the
top:

1. `mesh_send` (normal) — maybe they are just busy.
2. `urgent` — steer: interrupts the current reflection, not a running tool.
3. `force` (+ `reason`) — aborts the recipient's turn.
4. `force` + `reason` + `interrupt: true` — **last resort**: aborts the
   blocked turn (kills its running tool's process tree) so the message
   lands with priority. Requires the recipient's policy
   (`forceAllowedFrom`); the recipient answers with an honest machine
   receipt (`turn aborted` / `still busy after N aborts`) that is INFO
   ONLY — it never settles your awaited mission; the real answer still
   comes.

`interrupt` is a destructive lever: always with a reason, never as
spam (rate-limited 1/min), never toward a `⛔ rate-limited` peer (an abort
cannot heal a dead provider).
