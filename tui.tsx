/** @jsxImportSource @opentui/solid */
// tui.tsx — pi-mesh CLI (TUI) plugin: a sidebar card mirroring the current
// session's mesh state (the OpenCode counterpart of the Pi HUD).
//
// Data comes from the server-side plugin (server.ts → src/extension-opencode/):
//   - <stateDir>/mesh-status-<sessionId>.json — live beacon, refreshed every 2 s
//     (alias, rooms, connection state, peer list with activity);
//   - <stateDir>/identity-<sessionId>.json    — persisted alias/rooms fallback.
// <stateDir> is $MESH_STATE_DIR or <project>/.mesh — with a ~/.mesh fallback:
// the OpenCode SERVER often runs from $HOME (daemon) while the CLI/TUI is
// launched from a project directory, so the server's beacons land in ~/.mesh
// while the project-local .mesh stays empty ("no session attached"). The
// sidebar picks the FIRST candidate that knows the session.
//
// Register it in cli.json (e.g. global ~/.config/opencode/cli.json):
//   "plugins": [{ "package": "/path/to/pi-mesh/tui.tsx" }]
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { For, Show, createSignal, onCleanup } from "solid-js"
import { open, readFile, stat } from "node:fs/promises"
import os from "node:os"
import { join } from "node:path"

const POLL_MS = 2_000
const STALE_MS = 7_000

type MeshPeer = {
  alias: string
  rooms: string[]
  state: string
  remote: boolean
}

type MeshStatus = {
  alias: string
  rooms: string[]
  online: boolean
  busy: boolean
  peers: MeshPeer[]
  /** true when the beacon was written by another (older) plugin instance. */
  foreign: boolean
  /** time of the beacon write this state came from. */
  updatedAt: number
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(file, "utf8"))
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
    return value as Record<string, unknown>
  } catch {
    return undefined
  }
}

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []

const peerList = (value: unknown): MeshPeer[] => {
  if (!Array.isArray(value)) return []
  const out: MeshPeer[] = []
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue
    const p = item as Record<string, unknown>
    if (typeof p.alias !== "string" || p.alias.length === 0) continue
    out.push({
      alias: p.alias,
      rooms: stringList(p.rooms),
      state: typeof p.state === "string" ? p.state : "active",
      remote: p.remote === true,
    })
  }
  return out
}

/** Activity first (busy → blocked → idle → active), then alias. */
const rank = (state: string): number =>
  state === "busy" ? 0 : state === "rate_limited" ? 1 : state === "blocked" ? 2 : state === "stuck" ? 3 : state === "idle" ? 4 : 5

async function readStatus(meshDir: string, sessionID: string): Promise<MeshStatus | undefined> {
  const stored = await readJson(join(meshDir, `identity-${sessionID}.json`))
  const live = await readJson(join(meshDir, `mesh-status-${sessionID}.json`))
  // The persisted identity is the session's truth for alias and rooms (a
  // stale beacon from an old plugin instance must not rename the session);
  // the live beacon only provides freshness, activity and the peer list.
  const storedAlias = typeof stored?.alias === "string" ? stored.alias : undefined
  const liveAlias = typeof live?.alias === "string" ? live.alias : undefined
  const alias = storedAlias ?? liveAlias
  if (alias === undefined) return undefined
  const rooms = stringList(stored?.rooms ?? live?.rooms)
  const at = typeof live?.updatedAt === "string" ? Date.parse(live.updatedAt) : Number.NaN
  const fresh = Number.isFinite(at) && Date.now() - at < STALE_MS
  // A beacon written under another alias belongs to a stale plugin
  // instance (hot-reload leftovers) — its live fields are not ours.
  const foreign = storedAlias !== undefined && liveAlias !== undefined && liveAlias !== storedAlias
  const trusted = !foreign
  const online = trusted && live?.online === true && fresh
  // Visible peers = share at least one room with this session (Pi's rule);
  // no rooms → no visibility.
  const mine = new Set(rooms)
  const peers =
    !online || mine.size === 0
      ? []
      : peerList(live?.peers)
          .filter((p) => p.alias !== alias && p.rooms.some((r) => mine.has(r)))
          .sort((a, b) => rank(a.state) - rank(b.state) || a.alias.localeCompare(b.alias))
  return {
    alias,
    rooms,
    online,
    busy: trusted && live?.busy === true && fresh,
    peers,
    foreign,
    updatedAt: Number.isFinite(at) ? at : Date.now(),
  }
}

const marker = (state: string): string =>
  state === "busy"
    ? "●"
    : state === "rate_limited"
      ? "⛔"
      : state === "blocked"
        ? "✖"
        : state === "stuck"
          ? "✕"
          : state === "idle"
            ? "○"
            : "·"

type MeshNotification = { level: string; text: string }

/** First candidate dir that knows the session (identity or beacon file).
 *  Falls back to the primary candidate when none does (fresh session,
 *  nothing written yet — the server may create it there later). */
async function pickMeshDir(dirs: readonly string[], sessionID: string): Promise<string> {
  if (dirs.length <= 1) return dirs[0] ?? join(process.cwd(), ".mesh")
  for (const dir of dirs) {
    for (const name of [`identity-${sessionID}.json`, `mesh-status-${sessionID}.json`]) {
      try {
        await stat(join(dir, name))
        return dir
      } catch {
        // not there — next candidate
      }
    }
  }
  return dirs[0]!
}

/** New notification lines appended by the server plugin (`/mesh` feedback). */
async function readNotifications(
  meshDir: string,
  sessionID: string,
  state: { offset: number },
): Promise<MeshNotification[]> {
  const file = join(meshDir, `mesh-notify-${sessionID}.jsonl`)
  try {
    const info = await stat(file)
    const size = info.size
    // First read: skip history (no toast flood on mount).
    if (state.offset === -1) {
      state.offset = size
      return []
    }
    if (size < state.offset) state.offset = 0 // rotated/truncated
    if (size === state.offset) return []
    const handle = await open(file, "r")
    try {
      const length = size - state.offset
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, state.offset)
      state.offset = size
      const out: MeshNotification[] = []
      for (const line of buffer.toString("utf8").split("\n")) {
        if (line.trim() === "") continue
        try {
          const value: unknown = JSON.parse(line)
          if (value === null || typeof value !== "object") continue
          const record = value as { level?: unknown; text?: unknown }
          if (typeof record.text !== "string" || record.text.length === 0) continue
          out.push({ level: typeof record.level === "string" ? record.level : "info", text: record.text })
        } catch {
          // skip malformed lines
        }
      }
      return out
    } finally {
      await handle.close()
    }
  } catch {
    return []
  }
}

function MeshSidebar(props: { sessionID: string; meshDirs: readonly string[] }) {
  const context = usePlugin()
  const [status, setStatus] = createSignal<MeshStatus | undefined>()
  const notifyState = { offset: -1 }

  const toast = (text: string, level: string): void => {
    try {
      const ui = (context as unknown as { ui?: { toast?: unknown } }).ui
      if (ui === undefined) return
      const variant = level === "error" ? "error" : level === "warning" ? "warning" : "info"
      const input = {
        message: text.length > 400 ? `${text.slice(0, 397)}…` : text,
        variant,
        duration: 5_000,
      }
      const handler = ui.toast
      if (typeof handler === "function") {
        ;(handler as (value: unknown) => void)(input)
        return
      }
      const show = (handler as { show?: unknown } | undefined)?.show
      if (typeof show === "function") {
        ;(show as (value: unknown) => void)(input)
      }
    } catch {
      // toasts are best effort — the sidebar still reflects the state
    }
  }

  const refresh = (): void => {
    void (async () => {
      const dir = await pickMeshDir(props.meshDirs, props.sessionID)
      return dir
    })().then((meshDir) => {
      void readStatus(meshDir, props.sessionID).then((next) => {
        if (next === undefined) return
        setStatus((prev) => {
          if (!next.foreign) return next
          // A stale plugin instance wrote the beacon: keep the last trusted
          // picture while it is recent (they vanish on the next restart).
          if (prev !== undefined && !prev.foreign && Date.now() - prev.updatedAt < STALE_MS * 2) return prev
          return next
        })
      }, () => {})
      void readNotifications(meshDir, props.sessionID, notifyState).then((items) => {
        for (const item of items) toast(item.text, item.level)
      }, () => {})
    }, () => {})
  }
  const timer = setInterval(refresh, POLL_MS)
  timer.unref?.()
  onCleanup(() => clearInterval(timer))
  refresh()

  const theme = context.theme as { text?: { base?: string; muted?: string } }
  const dot = (current: MeshStatus): string =>
    current.online ? (current.busy ? "● busy" : "● online") : "○ offline"

  return (
    <box flexDirection="column" paddingTop={1}>
      <text fg={theme.text?.base}>pi-mesh</text>
      <Show when={status()} fallback={<text fg={theme.text?.muted}>· no session attached</text>}>
        {(current) => (
          <box flexDirection="column">
            <text fg={theme.text?.base}>@{current().alias} {dot(current())}</text>
            <text fg={theme.text?.muted}>
              rooms: {current().rooms.length > 0 ? current().rooms.join(", ") : "none"}
            </text>
            <Show when={current().peers.length > 0}>
              <text fg={theme.text?.muted}>agents ({current().peers.length}):</text>
              <For each={current().peers}>
                {(peer) => (
                  <text fg={theme.text?.base}>
                    {" "}
                    {marker(peer.state)} {peer.alias}
                    {peer.remote ? " ⌁" : ""}
                  </text>
                )}
              </For>
            </Show>
          </box>
        )}
      </Show>
    </box>
  )
}

export default Plugin.define({
  id: "pi-mesh.cli",
  async setup(context) {
    const options = (context.options ?? {}) as { meshDir?: string }

    // Candidate stateDirs, in priority order. Explicit overrides are
    // STRICT (single candidate); the default path adds ~/.mesh as a
    // fallback because the OpenCode server (daemon) usually runs from
    // $HOME while this TUI is launched from a project directory.
    const stateDirs = (): string[] => {
      if (typeof options.meshDir === "string" && options.meshDir.length > 0) return [options.meshDir]
      const env = process.env.MESH_STATE_DIR
      if (typeof env === "string" && env.length > 0) return [env]
      const ctx = context as unknown as {
        location?: { directory?: string }
        state?: { path?: { directory?: string; worktree?: string } }
      }
      const directory = ctx.location?.directory ?? ctx.state?.path?.directory ?? ctx.state?.path?.worktree
      const primary = join(directory ?? process.cwd(), ".mesh")
      const home = join(os.homedir(), ".mesh")
      return primary === home ? [primary] : [primary, home]
    }

    context.ui.slot({
      append: "sidebar.content",
      render: (props: { sessionID?: string; session_id?: string }) => {
        const sessionID = props?.sessionID ?? props?.session_id ?? ""
        return <MeshSidebar sessionID={sessionID} meshDirs={stateDirs()} />
      },
    })
  },
})
