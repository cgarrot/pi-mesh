// test/pi-lifecycle.test.ts — end-to-end Pi adapter lifecycle against a REAL
// broker: the exact failure the operator reported ("we put the agent in room
// aso12, and every time it comes back with another name, in another room").
//
// The factory is driven with a fake ExtensionAPI: session_start /
// session_shutdown / command handlers are the real ones, so this covers
// identity load → hello → /mesh join → persist → /reload → re-attach.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import meshExtension from "../src/extension/index.js";
import type { ExtensionAPI, InboundMessage, SessionContext, SessionHookHandler } from "../src/extension/pi-types.js";
import { MeshIdentity, identityFromClient } from "../src/shared/identity-store.js";
import { makeTempDirs, startTestBroker, waitFor } from "./helpers.js";

const SID = "019fdead-2222-7000-8000-0000000000b1";

interface Harness {
  pi: ExtensionAPI;
  emitted: InboundMessage[];
  sessionName: () => string | undefined;
  emit: (event: string, ctx: SessionContext) => Promise<void>;
  command: (name: string) => (args: string, ctx: SessionContext) => Promise<void>;
}

function fakePi(): Harness {
  const handlers = new Map<string, SessionHookHandler[]>();
  const emitted: InboundMessage[] = [];
  const commands = new Map<string, (args: string, ctx: SessionContext) => Promise<void>>();
  let name: string | undefined;
  const pi: ExtensionAPI = {
    events: { emit: () => {} },
    on: ((event: string, handler: SessionHookHandler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }) as ExtensionAPI["on"],
    registerTool: () => {},
    registerCommand: (n, def) => {
      commands.set(n, async (args: string, ctx: SessionContext) => {
        await def.handler(args, ctx);
      });
    },
    sendMessage: (msg: InboundMessage) => {
      emitted.push(msg);
    },
    appendEntry: () => {},
    setSessionName: (n: string) => {
      name = n;
    },
    getSessionName: () => name,
  };
  return {
    pi,
    emitted,
    sessionName: () => name,
    emit: async (event, ctx) => {
      for (const h of handlers.get(event) ?? []) await h({ type: event }, ctx);
    },
    command: (n) => {
      const c = commands.get(n);
      assert.ok(c !== undefined, `command ${n} registered`);
      return c;
    },
  };
}

function context(sessionId: string, overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    cwd: process.cwd(),
    mode: "tui",
    sessionManager: { getSessionId: () => sessionId },
    ui: {
      notify: () => {},
      setWidget: () => {},
      setStatus: () => {},
    },
    isIdle: () => true,
    ...overrides,
  };
}

/** Isolate the process env for one lifecycle test (no cross-test bleed). */
function isolateEnv(stateDirPath: string, runtimeDirPath: string): () => void {
  const keys = [
    "MESH_STATE_DIR",
    "MESH_RUNTIME_DIR",
    "MESH_BROKER_URL",
    "MESH_BROKER_TOKEN",
    "MESH_ALIAS",
    "MESH_ROOMS",
    "MESH_IDENTITY_KEY",
    "MESH_ALIAS_RECLAIM_MS",
  ];
  const prev = new Map(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  process.env.MESH_STATE_DIR = stateDirPath;
  process.env.MESH_RUNTIME_DIR = runtimeDirPath;
  process.env.MESH_ALIAS_RECLAIM_MS = "0"; // deterministic: no background rename
  return () => {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

describe("Pi lifecycle: room + alias stability", () => {
  it("/mesh join aso12 survives a reload (same alias, same room)", async () => {
    const dirs = makeTempDirs("mesh-pi-life-");
    const broker = await startTestBroker(dirs.runtimeDir);
    const restore = isolateEnv(dirs.stateDir, dirs.runtimeDir);
    try {
      const h = fakePi();
      meshExtension(h.pi);
      const ctx = context(SID);
      await h.emit("session_start", ctx);
      // connected + session named with the live identity
      await waitFor(() => (h.sessionName()?.startsWith("mesh @") === true ? true : undefined));
      const first = h.sessionName();
      assert.ok(first !== undefined && first.includes("default"), `fresh session starts in default (${first})`);

      await h.command("mesh")("join aso12", ctx);
      await waitFor(() => (h.sessionName()?.includes("aso12") === true ? true : undefined));
      const joined = h.sessionName();
      assert.ok(joined !== undefined);
      const joinedAlias = /@([a-z0-9-]+)/.exec(joined)?.[1];
      assert.ok(joinedAlias !== undefined && joinedAlias.length > 0);

      // /reload: shutdown persists, start reloads the SAME identity
      await h.emit("session_shutdown", ctx);
      await h.emit("session_start", ctx);
      await waitFor(() =>
        h.sessionName() !== undefined && h.sessionName()?.includes("aso12") === true ? true : undefined,
      );
      assert.equal(
        h.sessionName(),
        joined,
        "reload must keep BOTH the alias and the room (no churn)",
      );
    } finally {
      restore();
      await broker.close();
      dirs.cleanup();
    }
  });

  it("the PREFERRED alias is retried at attach (a stored fallback never becomes the name)", async () => {
    const dirs = makeTempDirs("mesh-pi-life-pref-");
    const broker = await startTestBroker(dirs.runtimeDir);
    const restore = isolateEnv(dirs.stateDir, dirs.runtimeDir);
    try {
      // disk state: a conflict left alias=<random>, preferred=<chosen>
      new MeshIdentity(dirs.stateDir).save(
        identityFromClient(SID, { alias: "agent-fallback", rooms: ["aso12"], reservations: [] }, "aso-12"),
      );
      const h = fakePi();
      meshExtension(h.pi);
      await h.emit("session_start", context(SID));
      await waitFor(() => (h.sessionName() !== undefined ? true : undefined));
      const name = h.sessionName() ?? "";
      assert.ok(name.startsWith("mesh @aso-12 "), `chosen alias retried, got: ${name}`);
      assert.ok(name.includes("aso12"), `room kept, got: ${name}`);
    } finally {
      restore();
      await broker.close();
      dirs.cleanup();
    }
  });

  it("a MESH_ROOMS pin wins over a stale persisted room list", async () => {
    const dirs = makeTempDirs("mesh-pi-life-pin-");
    const broker = await startTestBroker(dirs.runtimeDir);
    const restore = isolateEnv(dirs.stateDir, dirs.runtimeDir);
    process.env.MESH_ROOMS = "aso12";
    try {
      new MeshIdentity(dirs.stateDir).save(
        identityFromClient(SID, { alias: "aso-12", rooms: ["default"], reservations: [] }, "aso-12"),
      );
      const h = fakePi();
      meshExtension(h.pi);
      await h.emit("session_start", context(SID));
      await waitFor(() => (h.sessionName() !== undefined ? true : undefined));
      const name = h.sessionName() ?? "";
      assert.ok(name.startsWith("mesh @aso-12 "));
      assert.ok(name.includes("aso12"), `launcher pin beats stale disk state, got: ${name}`);
      assert.ok(!name.includes("default"), `stale room list dropped, got: ${name}`);
    } finally {
      restore();
      await broker.close();
      dirs.cleanup();
    }
  });

  it("identityKey keeps alias+rooms for a BRAND-NEW session id (agent slot)", async () => {
    const dirs = makeTempDirs("mesh-pi-life-slot-");
    const broker = await startTestBroker(dirs.runtimeDir);
    const restore = isolateEnv(dirs.stateDir, dirs.runtimeDir);
    process.env.MESH_IDENTITY_KEY = "aso12";
    try {
      // the slot was established by a previous (now gone) session
      new MeshIdentity(dirs.stateDir).save(
        identityFromClient("019fdead-2222-7000-8000-0000000000ff", {
          alias: "aso-12",
          rooms: ["aso12"],
          reservations: [],
        }, "aso-12"),
        "aso12",
      );
      const h = fakePi();
      meshExtension(h.pi);
      await h.emit("session_start", context(SID)); // new sessionId, no own identity
      await waitFor(() => (h.sessionName() !== undefined ? true : undefined));
      const name = h.sessionName() ?? "";
      assert.ok(name.startsWith("mesh @aso-12 "), `slot alias kept, got: ${name}`);
      assert.ok(name.includes("aso12"), `slot room kept, got: ${name}`);
    } finally {
      restore();
      await broker.close();
      dirs.cleanup();
    }
  });
});
