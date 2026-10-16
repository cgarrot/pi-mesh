// test/opencode-adapter.test.ts — unit coverage for the OpenCode adapter:
// /mesh arg parsing, status rendering, tool registration shapes (V2 + V1)
// and the send/reply execution core (validation, guards, ledger parity,
// re-reply warning) against a fake runtime — no broker needed.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
const { join } = path;

import { meshArgs, renderMeshStatus, runMeshCommand } from "../src/extension-opencode/register-commands.js";
import { applyMeshTools, applyMeshToolsV1 } from "../src/extension-opencode/register-tools.js";
import type { EnsureRuntime } from "../src/extension-opencode/register-tools.js";
import type { MeshSessionRuntime } from "../src/extension-opencode/client-runtime.js";
import type { V2ToolDefinition } from "../src/extension-opencode/v2-surface.js";
import { injectBatch, injectFrame } from "../src/extension-opencode/inject.js";
import { MeshGuards } from "../src/extension/guards.js";
import { MeshLedger } from "../src/extension/ledger.js";
import { MeshTranscript } from "../src/extension/transcript.js";
import { buildFrame } from "../src/protocol/envelope.js";

// ---------------------------------------------------------------- fakes

interface FakeClientBits {
  isOnline: () => boolean;
  alias: string;
  rooms: string[];
  reservations: never[];
  knowsPeer: (alias: string) => boolean;
  knownPeerList: readonly string[];
  busyForMs: (alias: string) => number | undefined;
  peekInbox: (msgId: string) => unknown;
  connect: () => Promise<unknown>;
  send: (input: unknown) => Promise<unknown>;
  reply: (msgId: string, message: string, opts?: unknown) => Promise<unknown>;
  forgetRoom: (room: string) => void;
  rename?: (alias: string) => Promise<unknown>;
  status?: () => Promise<unknown>;
  leave?: (room: string) => Promise<void>;
}

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "oc-adapter-"));
  tempDirs.push(dir);
  return dir;
}
test.after(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

function fakeRuntime(overrides: Record<string, unknown> = {}): MeshSessionRuntime {
  const dir = tempDir();
  const client = {
    isOnline: () => true,
    alias: "oc-unit",
    rooms: ["default"] as string[],
    knowsPeer: (_alias: string) => false,
    knownPeerList: [] as readonly string[],
    busyForMs: (_alias: string) => undefined,
    peekInbox: (_msgId: string) => undefined,
    reservations: [] as never[],
    connect: async () => {
      throw new Error("broker_unavailable");
    },
    send: async () => ({ status: "delivered", msgId: "m_unit1" }),
    reply: async () => ({ status: "delivered", msgId: "m_unit2" }),
    forgetRoom: (room: string) => {
      client.rooms = client.rooms.filter((r) => r !== room);
    },
    ...((overrides.client as Record<string, unknown>) ?? {}),
  } as FakeClientBits & Record<string, unknown>;
  const clientRef = client as FakeClientBits;
  const base = {
    client,
    guards: new MeshGuards(),
    ledger: new MeshLedger(dir),
    transcript: new MeshTranscript(dir, false),
    stateDir: dir,
    sessionId: "ses-unit",
    preferredAlias: client.alias,
    alias: client.alias,
    rooms: [...client.rooms],
    homeRoom: "default",
    startedAt: Date.now(),
    sendActivity: () => {},
    isBusy: () => false,
    notifyBusy: () => {},
    notifyIdle: () => {},
    armAutoRelease: () => {},
    submit: async () => ({}),
    formatFor: () => ({}),
    ledgerFailures: 0,
    transcriptFailures: 0,
    injectionFailures: 0,
    markTurnActive: () => {},
    markTurnIdle: () => {},
    runtimeDir: dir,
    ...overrides,
  };
  delete (base as Record<string, unknown>).client; // replaced by the merged one above
  return { ...base, client } as unknown as MeshSessionRuntime;
}

/** Capture V2 tool registrations against a fake editor. */
function captureTools(ensure: EnsureRuntime): Map<string, V2ToolDefinition> {
  const tools = new Map<string, V2ToolDefinition>();
  applyMeshTools(
    {
      add(tool: V2ToolDefinition) {
        tools.set(tool.name, tool);
      },
    },
    ensure,
  );
  return tools;
}

const CTX = { sessionID: "ses-unit", agent: "build" } as never;

// ---------------------------------------------------------------- /mesh leave

test("/mesh leave offline: drops the room locally, honest message", async () => {
  const rt = fakeRuntime({
    client: { isOnline: () => false, rooms: ["default", "zoma"] },
  });
  const out = await runMeshCommand(rt, ["leave", "default"]);
  assert.match(out, /left default locally \(offline/);
  assert.match(out, /zoma/);
  assert.deepEqual([...rt.client.rooms], ["zoma"]);
});

test("/mesh leave online: broker round-trip and persist", async () => {
  const left: string[] = [];
  const fakeClient = {
    rooms: ["default", "zoma"] as string[],
    leave: async (room: string) => {
      left.push(room);
      // mutate IN PLACE: the merged fake client shares this array
      fakeClient.rooms.splice(fakeClient.rooms.indexOf(room), 1);
    },
  };
  const rt = fakeRuntime({ client: fakeClient });
  const out = await runMeshCommand(rt, ["leave", "default"]);
  assert.match(out, /left default \(rooms: zoma\)/);
  assert.deepEqual(left, ["default"]);
});

test("/mesh alias success: preferredAlias updated and persisted", async () => {
  const rt = fakeRuntime({
    client: { rename: async () => ({ ok: true, alias: "azo-unit" }) },
  });
  const out = await runMeshCommand(rt, ["alias", "azo-unit"]);
  assert.match(out, /alias changed @azo-unit/);
  assert.equal(rt.preferredAlias, "azo-unit");
  const id = JSON.parse(readFileSync(join(rt.stateDir, "identity-ses-unit.json"), "utf8"));
  assert.equal(id.preferredAlias, "azo-unit");
});

test("/mesh alias taken: Pi-style holder hint (who, since when)", async () => {
  const rt = fakeRuntime({
    client: {
      rename: async () => ({ ok: false, reason: "alias_taken" }),
      status: async () => ({
        peers: [{ alias: "azo-unit", since: "2026-10-16T18:00:00Z" }],
      }),
    },
  });
  const out = await runMeshCommand(rt, ["alias", "azo-unit"]);
  assert.match(out, /failed: alias_taken — @azo-unit is connected since 2026-10-16T18:00:00Z/);
});

// ---------------------------------------------------------------- meshArgs

test("meshArgs parses every invocation shape", () => {
  assert.deepEqual(meshArgs(undefined), []);
  assert.deepEqual(meshArgs(""), []);
  assert.deepEqual(meshArgs("/mesh"), []);
  assert.deepEqual(meshArgs("status"), ["status"]);
  assert.deepEqual(meshArgs("join zoma"), ["join", "zoma"]);
  assert.deepEqual(meshArgs("/mesh join zoma"), ["join", "zoma"]);
  assert.deepEqual(meshArgs("  /mesh   ping   @x  "), ["ping", "@x"]);
});

// ---------------------------------------------------------------- status

test("renderMeshStatus renders online/busy/offline with live rooms", () => {
  const online = fakeRuntime({ rooms: ["default", "zoma"] });
  assert.equal(renderMeshStatus(online), "mesh — @oc-unit ● online\nrooms: default, zoma");

  const busy = fakeRuntime({ rooms: ["default"], isBusy: () => true });
  assert.match(renderMeshStatus(busy), /● busy/);

  const offline = fakeRuntime({
    rooms: ["default"],
    client: { isOnline: () => false },
  });
  assert.match(renderMeshStatus(offline), /○ offline/);
});

// ---------------------------------------------------------------- registration

test("applyMeshTools registers the eight mesh tools with strict schemas", () => {
  const tools = captureTools(async () => fakeRuntime());
  assert.deepEqual(
    [...tools.keys()].sort(),
    [
      "mesh_history",
      "mesh_ledger",
      "mesh_release",
      "mesh_reply",
      "mesh_reserve",
      "mesh_send",
      "mesh_status",
      "mesh_wait_all",
    ],
  );
  assert.deepEqual(tools.get("mesh_send")?.input.required, ["message"]);
  assert.equal(tools.get("mesh_send")?.input.additionalProperties, false);
  assert.deepEqual(tools.get("mesh_reply")?.input.required, ["msgId", "message"]);
  assert.deepEqual(tools.get("mesh_reserve")?.input.required, ["paths"]);
  for (const tool of tools.values()) {
    assert.ok(tool.description.length > 20, `${tool.name} needs a description`);
    assert.equal(typeof tool.execute, "function", `${tool.name} needs execute`);
  }
});

test("applyMeshToolsV1 fills the legacy zod tool map", async () => {
  const hooks: { tool?: Record<string, { description: string; args: object; execute: unknown }> } = {};
  await applyMeshToolsV1(hooks as Parameters<typeof applyMeshToolsV1>[0], async () => fakeRuntime());
  assert.equal(Object.keys(hooks.tool ?? {}).length, 8);
  for (const def of Object.values(hooks.tool ?? {})) {
    assert.ok(def.description.length > 0);
    assert.equal(typeof def.execute, "function");
  }
});

// ---------------------------------------------------------------- mesh_send core

test("mesh_send: message is required", async () => {
  const rt = fakeRuntime();
  const tools = captureTools(async () => rt);
  const out = await tools.get("mesh_send")!.execute({}, CTX);
  assert.match(out.content, /invalid_frame/);
});

test("mesh_send: broadcast and to are mutually exclusive", async () => {
  const rt = fakeRuntime();
  const tools = captureTools(async () => rt);
  const out = await tools.get("mesh_send")!.execute({ to: "peer", broadcast: true, message: "x" }, CTX);
  assert.match(out.content, /broadcast_with_to/);
});

test("mesh_send: to:'*' is blocked locally (M1) and ledgered", async () => {
  const rt = fakeRuntime();
  const tools = captureTools(async () => rt);
  const out = await tools.get("mesh_send")!.execute({ to: "*", message: "hi" }, CTX);
  assert.match(out.content, /blocked: invalid_target/);
  const blocked = rt.ledger.read(10).find((r) => r.event === "blocked");
  assert.equal(blocked?.code, "invalid_target");
});

test("mesh_send: delivered send writes sent + delivered ledger records", async () => {
  const rt = fakeRuntime();
  const tools = captureTools(async () => rt);
  const out = await tools.get("mesh_send")!.execute({ to: "peer", message: "hello" }, CTX);
  assert.match(out.content, /^delivered/);
  const events = rt.ledger.read(10).map((r) => r.event);
  assert.deepEqual(events, ["sent", "delivered"]);
  const sent = rt.ledger.read(10)[0];
  assert.ok(sent !== undefined);
  assert.equal(sent.to, "peer");
  assert.equal(sent.room, "default");
});

test("mesh_send: duplicate body inside the guard window is blocked and ledgered", async () => {
  const rt = fakeRuntime();
  const tools = captureTools(async () => rt);
  const send = tools.get("mesh_send")!.execute;
  await send({ to: "peer", message: "same-body" }, CTX);
  const out = await send({ to: "peer", message: "same-body" }, CTX);
  assert.match(out.content, /^blocked:/);
  const events = rt.ledger.read(10).map((r) => r.event);
  assert.equal(events[events.length - 1], "blocked");
});

test("mesh_send: offline after a failed connect retry is honest + ledgered", async () => {
  const rt = fakeRuntime({ client: { isOnline: () => false } });
  const tools = captureTools(async () => rt);
  const out = await tools.get("mesh_send")!.execute({ to: "peer", message: "hello" }, CTX);
  assert.match(out.content, /blocked: broker_unavailable/);
  const blocked = rt.ledger.read(10).find((r) => r.event === "blocked");
  assert.equal(blocked?.code, "broker_unavailable");
});

test("mesh_send: queued_offline send is ledgered as queued_offline", async () => {
  const rt = fakeRuntime({
    client: { send: async () => ({ status: "queued_offline", msgId: "m_q1" }) },
  });
  const tools = captureTools(async () => rt);
  const out = await tools.get("mesh_send")!.execute({ to: "ghost", message: "hello" }, CTX);
  assert.match(out.content, /queued_offline/);
  const events = rt.ledger.read(10).map((r) => r.event);
  assert.deepEqual(events, ["sent", "queued_offline"]);
});

// ---------------------------------------------------------------- mesh_reply core

test("mesh_reply: msgId and message are required", async () => {
  const rt = fakeRuntime();
  const tools = captureTools(async () => rt);
  const out = await tools.get("mesh_reply")!.execute({ message: "x" }, CTX);
  assert.match(out.content, /invalid_frame/);
});

test("mesh_reply: replyAll and to are mutually exclusive", async () => {
  const rt = fakeRuntime();
  const tools = captureTools(async () => rt);
  const out = await tools.get("mesh_reply")!.execute(
    { msgId: "m_1", message: "x", to: "peer", replyAll: true },
    CTX,
  );
  assert.match(out.content, /reply_all_with_to/);
});

test("mesh_reply: unknown msgId → reply_without_target BEFORE any send, ledgered", async () => {
  const rt = fakeRuntime();
  const tools = captureTools(async () => rt);
  const out = await tools.get("mesh_reply")!.execute({ msgId: "m_nope", message: "x" }, CTX);
  assert.match(out.content, /reply_without_target/);
  const blocked = rt.ledger.read(10).find((r) => r.event === "blocked");
  assert.equal(blocked?.code, "reply_without_target");
  assert.equal(rt.ledger.read(10).find((r) => r.event === "sent"), undefined);
});

test("mesh_reply: delivered reply writes sent + delivered; repeat reply warns", async () => {
  const orig = { from: "peer", room: "default", priority: "normal" };
  const rt = fakeRuntime({ client: { peekInbox: () => orig } });
  const tools = captureTools(async () => rt);
  const reply = tools.get("mesh_reply")!.execute;
  const first = await reply({ msgId: "m_orig", message: "answer" }, CTX);
  assert.match(first.content, /^delivered/);
  assert.deepEqual(rt.ledger.read(10).map((r) => r.event), ["sent", "delivered"]);

  const second = await reply({ msgId: "m_orig", message: "answer again" }, CTX);
  assert.match(second.content, /already replied/);
  assert.match(second.content, /^delivered/);
});

// ---------------------------------------------------------------- inject mapping

test("injectFrame maps priority to OpenCode delivery modes", async () => {
  const submits: { text: string; delivery: string }[] = [];
  let interrupts = 0;
  const rt = fakeRuntime({
    submit: async (text: string, delivery: string) => {
      submits.push({ text, delivery });
    },
    interrupt: () => {
      interrupts += 1;
    },
  });

  await injectFrame(rt, buildFrame({ type: "msg", from: "a", to: "oc", room: "default", body: "calm", priority: "normal" }));
  await injectFrame(rt, buildFrame({ type: "msg", from: "a", to: "oc", room: "default", body: "now", priority: "urgent" }));
  await injectFrame(rt, buildFrame({ type: "msg", from: "a", to: "oc", room: "default", body: "abort", priority: "force" }), { interrupt: true });
  await injectFrame(rt, buildFrame({ type: "reply", from: "a", to: "oc", room: "default", body: "re" }));

  assert.deepEqual(
    submits.map((s) => s.delivery),
    ["queue", "steer", "steer", "steer"],
  );
  assert.equal(interrupts, 1);
  assert.match(submits[0]!.text, /calm/);
});

test("injectBatch submits one batched message per burst", async () => {
  const submits: { text: string; delivery: string }[] = [];
  const rt = fakeRuntime({
    submit: async (text: string, delivery: string) => {
      submits.push({ text, delivery });
    },
  });
  await injectBatch(rt, [
    buildFrame({ type: "msg", from: "a", to: "oc", room: "default", body: "one" }),
    buildFrame({ type: "msg", from: "b", to: "oc", room: "default", body: "two" }),
  ]);
  assert.equal(submits.length, 1);
  assert.match(submits[0]!.text, /one/);
  assert.match(submits[0]!.text, /two/);
});
