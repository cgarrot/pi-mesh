// test/attach.test.ts — D31: updateSessionName keeps the first user message.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { exposeAlias, updateSessionName } from "../src/extension/attach.js";

function fakePi(initial?: string): {
  pi: { setSessionName(name: string): void; getSessionName(): string | undefined };
  names: string[];
} {
  let current: string | undefined = initial;
  const names: string[] = [];
  return {
    pi: {
      setSessionName: (name: string) => {
        names.push(name);
        current = name;
      },
      getSessionName: () => current,
    },
    names,
  };
}

function fakeRt(alias: string, rooms: string[], sessionFile?: string): never {
  return {
    client: { alias, rooms },
    ctx: sessionFile !== undefined ? { sessionManager: { getSessionFile: () => sessionFile } } : {},
  } as never;
}

function tmpSessionFile(lines: unknown[]): { file: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mesh-sname-"));
  const file = path.join(dir, "session.jsonl");
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n"), "utf8");
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("updateSessionName (D31): /resume shows identity + first message", () => {
  it("sets 'mesh @alias · rooms — first user message'", () => {
    const { file, cleanup } = tmpSessionFile([
      { type: "session", version: 3, id: "x", timestamp: "2026-08-11T00:00:00.000Z", cwd: "C:/x" },
      { type: "custom_message", customType: "mesh-context", content: "[mesh] you are...", display: false },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "analyse le shader" }] } },
      { type: "message", message: { role: "assistant", content: "ok" } },
    ]);
    try {
      const { pi, names } = fakePi(undefined);
      updateSessionName(pi as never, fakeRt("agent-1", ["cs-room"], file));
      assert.deepEqual(names, ["mesh @agent-1 · cs-room — analyse le shader"]);
    } finally {
      cleanup();
    }
  });

  it("skips mesh-context/mesh-inbound custom messages, takes the real first user text", () => {
    const { file, cleanup } = tmpSessionFile([
      { type: "session", version: 3, id: "x", timestamp: "2026-08-11T00:00:00.000Z", cwd: "C:/x" },
      { type: "custom_message", customType: "mesh-message", content: "[mesh] @agent-2 ...", display: true },
      { type: "message", message: { role: "user", content: "continues" } },
    ]);
    try {
      const { pi, names } = fakePi(undefined);
      updateSessionName(pi as never, fakeRt("main", ["voice"], file));
      assert.deepEqual(names, ["mesh @main · voice — continues"]);
    } finally {
      cleanup();
    }
  });

  it("long first messages are truncated", () => {
    const long = "x".repeat(500);
    const { file, cleanup } = tmpSessionFile([
      { type: "session", version: 3, id: "x", timestamp: "2026-08-11T00:00:00.000Z", cwd: "C:/x" },
      { type: "message", message: { role: "user", content: long } },
    ]);
    try {
      const { pi, names } = fakePi(undefined);
      updateSessionName(pi as never, fakeRt("a", ["r"], file));
      assert.ok(names[0]!.length < 150);
      assert.ok(names[0]!.endsWith("…"));
    } finally {
      cleanup();
    }
  });

  it("no user message yet → identity only", () => {
    const { file, cleanup } = tmpSessionFile([
      { type: "session", version: 3, id: "x", timestamp: "2026-08-11T00:00:00.000Z", cwd: "C:/x" },
    ]);
    try {
      const { pi, names } = fakePi(undefined);
      updateSessionName(pi as never, fakeRt("main", [], file));
      assert.deepEqual(names, ["mesh @main"]);
    } finally {
      cleanup();
    }
  });

  it("refreshes existing mesh names; never overwrites user names", () => {
    const { pi, names } = fakePi("mesh @agent-1 · cs-room");
    updateSessionName(pi as never, fakeRt("agent-1", ["cs-room", "voice"]));
    assert.deepEqual(names, ["mesh @agent-1 · cs-room,voice"]);

    const { pi: pi2, names: names2 } = fakePi("my session");
    updateSessionName(pi2 as never, fakeRt("agent-1", ["cs-room"]));
    assert.deepEqual(names2, []);
  });
});


// ---- D41: detached guard — client frames after reload/switch never crash ----
import { attachClientListeners } from "../src/extension/attach.js";
import { MeshClient } from "../src/client/client.js";
import type { MeshFrame } from "../src/protocol/envelope.js";

describe("attachClientListeners (D41): stale ctx after reload must not throw", () => {
  it("presence/inbound frames on a detached client are swallowed, no pi.* call", () => {
    const calls: string[] = [];
    const pi = {
      appendEntry: (..._a: unknown[]) => {
        calls.push("appendEntry");
        throw new Error("This extension ctx is stale after session replacement or reload.");
      },
      sendMessage: (..._a: unknown[]) => {
        calls.push("sendMessage");
        throw new Error("This extension ctx is stale after session replacement or reload.");
      },
      on: () => {},
      setSessionName: () => {},
      getSessionName: () => undefined,
    };
    const client = new MeshClient({ alias: "stale-test" });
    const rt: {
      client: MeshClient;
      ledger: { append: () => void };
      transcript: { record: () => void };
      counters: { ledgerFailures: number; transcriptFailures: number; injectionFailures: number };
      markDetached?: () => void;
      stopHold?: () => void;
    } = {
      client,
      ledger: { append: () => {} },
      transcript: { record: () => {} },
      counters: { ledgerFailures: 0, transcriptFailures: 0, injectionFailures: 0 },
    };
    attachClientListeners(
      pi as never,
      rt as never,
      () => null,
      {} as never,
      client as never,
      () => {},
    );
    // simulate session_shutdown → detach
    rt.markDetached!();
    const presence: MeshFrame = {
      v: 1, type: "presence", id: "p1", from: "someone", status: "online", room: "default",
      ts: new Date().toISOString(),
    } as unknown as MeshFrame;
    const msg: MeshFrame = {
      v: 1, type: "msg", id: "m1", from: "someone", to: "stale-test", body: "hi",
      room: "default", ts: new Date().toISOString(),
    } as unknown as MeshFrame;
    client.emit("presence", presence);
    client.emit("inbound", msg);
    client.emit("ready", { alias: "stale-test", rooms: ["default"], peers: [], mailboxCount: 0 });
    // no throw, no pi.* call attempted while detached
    assert.deepEqual(calls, []);
    client.close();
  });

  it("NOT detached: a throwing ctx is caught, never an uncaughtException", () => {
    const pi = {
      appendEntry: () => {
        throw new Error("stale ctx");
      },
      sendMessage: () => {},
      on: () => {},
    };
    const client = new MeshClient({ alias: "stale-test-2" });
    const rt = {
      client,
      ledger: { append: () => {} },
      transcript: { record: () => {} },
      counters: { ledgerFailures: 0, transcriptFailures: 0, injectionFailures: 0 },
    };
    attachClientListeners(pi as never, rt as never, () => null, {} as never, client as never, () => {});
    assert.doesNotThrow(() => {
      client.emit("presence", {
        v: 1, type: "presence", id: "p2", from: "x", status: "online", room: "default",
        ts: new Date().toISOString(),
      } as unknown as MeshFrame);
    });
    client.close();
  });
});

describe("public mesh alias bridge", () => {
  it("emits resolved alias and a rooms snapshot without triggering a turn", () => {
    const key = Symbol.for("pi-mesh:alias");
    const globals = globalThis as Record<symbol, unknown>;
    const previous = globals[key];
    const events: unknown[] = [];
    const rooms = ["default"];
    try {
      exposeAlias({ events: { emit: (event: string, data: unknown) => events.push({ event, data }) } } as never, "alice", rooms);
      rooms.push("another");
      assert.equal(globals[key], "alice");
      assert.deepEqual(events, [{ event: "mesh:alias", data: { alias: "alice", rooms: ["default"] } }]);
      exposeAlias({} as never, "bob", []); // hosts without the event bus
      assert.equal(globals[key], "bob");
    } finally {
      if (previous === undefined) delete globals[key];
      else globals[key] = previous;
    }
  });
});
