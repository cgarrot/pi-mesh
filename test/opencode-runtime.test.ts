// test/opencode-runtime.test.ts — integration coverage for the OpenCode
// adapter's client-runtime against a REAL in-process broker:
//   - live alias/rooms getters (the /mesh status stale-rooms regression),
//   - inbound delivery into the attached session prompt,
//   - the first-call connect race (a tool call right after runtime creation
//     must not answer broker_unavailable),
//   - the status beacon file,
//   - attachOpenCodeSession fallbacks (ctx.session vs top-level vs none).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MeshClient } from "../src/client/client.js";
import { DEFAULT_CONFIG } from "../src/shared/config.js";
import { makeTempDirs, startTestBroker, waitFor, type TempDirs } from "./helpers.js";
import type { RunningBroker } from "../src/broker/broker.js";
import {
  attachOpenCodeSession,
  createSessionRuntime,
  disposeAllRuntimes,
  disposeRuntime,
  ensureSessionRuntime,
  runtimeBySession,
  statusBeaconPath,
  type MeshSessionRuntime,
} from "../src/extension-opencode/client-runtime.js";
import { renderMeshStatus } from "../src/extension-opencode/register-commands.js";
import { applyMeshTools } from "../src/extension-opencode/register-tools.js";
import type { V2ToolDefinition } from "../src/extension-opencode/v2-surface.js";

const CFG = { ...DEFAULT_CONFIG, inboundBatchMs: 0 };

interface Fixture {
  dirs: TempDirs;
  broker: RunningBroker;
  prompts: { input: unknown }[];
}

const fixtures: Fixture[] = [];

async function setup(): Promise<Fixture> {
  const dirs = makeTempDirs("oc-runtime-");
  process.env.MESH_STATE_DIR = dirs.stateDir;
  process.env.MESH_RUNTIME_DIR = dirs.runtimeDir;
  const broker = await startTestBroker(dirs.runtimeDir);
  const prompts: { input: unknown }[] = [];
  attachOpenCodeSession({
    session: {
      prompt: async (input: unknown) => {
        prompts.push({ input });
        return {};
      },
      interrupt: async () => ({}),
      wait: async () => ({}),
    },
  });
  const fx: Fixture = { dirs, broker, prompts };
  fixtures.push(fx);
  return fx;
}

test.after(async () => {
  for (const fx of fixtures) {
    try {
      await fx.broker.close();
    } catch {
      // best effort
    }
    fx.dirs.cleanup();
  }
  delete process.env.MESH_STATE_DIR;
  delete process.env.MESH_RUNTIME_DIR;
});

test("runtime: alias/rooms are live after join/rename (stale-status regression)", async (t) => {
  const fx = await setup();
  t.after(async () => {
    await disposeRuntime("ses-live");
  });
  const rt = await createSessionRuntime("ses-live", CFG, async () => {});
  await waitFor(() => (rt.client.isOnline() ? true : undefined));
  assert.match(renderMeshStatus(rt), /rooms: default/);

  await rt.client.join("zoma");
  // the fix: renderMeshStatus reflects the JOINED room immediately
  assert.match(renderMeshStatus(rt), /zoma/);

  await rt.client.rename("oc-renamed");
  assert.match(renderMeshStatus(rt), /@oc-renamed/);
  assert.equal(rt.alias, "oc-renamed");
  assert.deepEqual([...rt.rooms], ["default", "zoma"]);
});

test("runtime: inbound frames reach the attached session prompt", async (t) => {
  const fx = await setup();
  t.after(async () => {
    await disposeRuntime("ses-inbound");
  });
  const rt = await createSessionRuntime("ses-inbound", CFG, async () => {});
  await waitFor(() => (rt.client.isOnline() ? true : undefined));

  const sender = new MeshClient({ alias: "sender", runtimeDir: fx.dirs.runtimeDir, config: CFG });
  await sender.connect();
  t.after(async () => {
    await sender.close();
  });
  const res = (await sender.send({ to: rt.client.alias, message: "ping-opencode" })) as {
    status: string;
  };
  assert.equal(res.status, "delivered");

  await waitFor(() => (fx.prompts.length > 0 ? true : undefined));
  const text = JSON.stringify(fx.prompts[0]!.input);
  assert.match(text, /ping-opencode/);
  // inbound side effects: honest read receipt + ledger record
  assert.ok(rt.ledger.read(10).some((r) => r.event === "inbound"));
});

test("runtime: first tool call right after creation does not race the connect", async (t) => {
  const fx = await setup();
  t.after(async () => {
    await disposeRuntime("ses-race");
  });
  // NO waitFor(isOnline) here — the runtime's initial connect() is very
  // likely still in flight when the tool runs; ensureRuntime must await it
  // (memoized) instead of answering broker_unavailable.
  const rt = await ensureSessionRuntime("ses-race", CFG, async () => {});

  const tools = new Map<string, V2ToolDefinition>();
  applyMeshTools(
    {
      add(tool: V2ToolDefinition) {
        tools.set(tool.name, tool);
      },
    },
    async () => rt,
  );
  const out = await tools.get("mesh_status")!.execute(
    {},
    { sessionID: "ses-race", agent: "build" } as never,
  );
  assert.doesNotMatch(out.content, /broker_unavailable/);
  assert.match(out.content, /mesh status — alias @/);
});

test("runtime: the status beacon file reflects the live session", async (t) => {
  const fx = await setup();
  t.after(async () => {
    await disposeRuntime("ses-beacon");
  });
  const rt = await createSessionRuntime("ses-beacon", CFG, async () => {});
  await waitFor(() => {
    try {
      const raw = JSON.parse(
        readFileSync(statusBeaconPath(fx.dirs.stateDir, "ses-beacon"), "utf8"),
      ) as { alias?: string; online?: boolean; rooms?: string[] };
      return raw.online === true ? raw : undefined;
    } catch {
      return undefined;
    }
  });
  const beacon = JSON.parse(
    readFileSync(statusBeaconPath(fx.dirs.stateDir, "ses-beacon"), "utf8"),
  ) as { sessionId: string; alias: string; rooms: string[] };
  assert.equal(beacon.sessionId, "ses-beacon");
  assert.deepEqual(beacon.rooms, ["default"]);
});

test("runtime: alias self-healing — fallback keeps the preferred alias, retried at the next attach", async (t) => {
  const fx = await setup();
  t.after(async () => {
    await disposeRuntime("ses-heal");
  });

  // A live peer holds the wanted alias.
  const holder = new MeshClient({ alias: "heal-x", runtimeDir: fx.dirs.runtimeDir, config: CFG });
  await holder.connect();
  t.after(async () => {
    await holder.close();
  });

  // The session WANTS heal-x (identity with preferredAlias).
  new (await import("../src/shared/identity-store.js")).MeshIdentity(fx.dirs.stateDir).save({
    version: 1,
    sessionId: "ses-heal",
    alias: "heal-x",
    preferredAlias: "heal-x",
    rooms: ["default"],
    reservations: [],
    updatedAt: new Date().toISOString(),
  } as never);

  // Attach #1: alias_taken → random fallback, PREFERRED kept on disk.
  // (the alias_taken retry ladder takes ~4s — wait generously)
  const rt1 = await createSessionRuntime("ses-heal", CFG, async () => {});
  await waitFor(() => (rt1.client.isOnline() ? true : undefined), 15_000);
  assert.notEqual(rt1.client.alias, "heal-x");
  const id1 = JSON.parse(
    readFileSync(fx.dirs.stateDir + "/identity-ses-heal.json", "utf8"),
  ) as { alias: string; preferredAlias?: string };
  assert.notEqual(id1.alias, "heal-x");
  assert.equal(id1.preferredAlias, "heal-x");
  await disposeRuntime("ses-heal");
  // let the broker reap attach #1's socket before #2 retries the alias
  await new Promise((r) => setTimeout(r, 300));

  // The holder disconnects → the alias frees.
  await holder.close();
  await new Promise((r) => setTimeout(r, 300));

  // Attach #2: the preferred alias is retried and reclaimed — self-healed.
  const rt2 = await createSessionRuntime("ses-heal", CFG, async () => {});
  await waitFor(() => (rt2.client.isOnline() ? true : undefined), 15_000);
  assert.equal(rt2.client.alias, "heal-x");
  assert.equal(rt2.preferredAlias, "heal-x");
});

test("runtime: idle sessions stay attached by default (Pi parity — no random offlines)", async (t) => {
  const fx = await setup();
  delete process.env.MESH_OPENCODE_IDLE_DETACH_MS; // default = never
  t.after(async () => {
    await disposeRuntime("ses-idle-default");
  });
  const rt = await createSessionRuntime("ses-idle-default", CFG, async () => {});
  await waitFor(() => (rt.client.isOnline() ? true : undefined));
  rt.markTurnIdle();
  // a few beacon ticks pass — the runtime must STAY attached
  await new Promise((r) => setTimeout(r, 3_000));
  assert.equal(runtimeBySession("ses-idle-default"), rt);
  assert.ok(rt.client.isOnline());
});

test("runtime: idle detach remains available via MESH_OPENCODE_IDLE_DETACH_MS (opt-in)", async (t) => {
  const fx = await setup();
  process.env.MESH_OPENCODE_IDLE_DETACH_MS = "400";
  t.after(async () => {
    delete process.env.MESH_OPENCODE_IDLE_DETACH_MS;
    await disposeRuntime("ses-idle-optin");
  });
  const rt = await createSessionRuntime("ses-idle-optin", CFG, async () => {});
  await waitFor(() => (rt.client.isOnline() ? true : undefined));
  rt.markTurnIdle();
  await waitFor(() => (runtimeBySession("ses-idle-optin") === undefined ? true : undefined), 5_000);
  assert.equal(runtimeBySession("ses-idle-optin"), undefined);
});

test("runtime: disposeAllRuntimes REALLY closes every client (reload zombie factory fix)", async (t) => {
  const fx = await setup();
  const rtA = await createSessionRuntime("ses-disp-a", CFG, async () => {});
  const rtB = await createSessionRuntime("ses-disp-b", CFG, async () => {});
  await waitFor(() => (rtA.client.isOnline() && rtB.client.isOnline() ? true : undefined));
  t.after(async () => {
    await disposeRuntime("ses-disp-a");
    await disposeRuntime("ses-disp-b");
  });

  await disposeAllRuntimes();
  // both clients must be CLOSED (socket gone), not merely unregistered —
  // the old id-based loop after runtimes.clear() closed NOTHING.
  await waitFor(() => (!rtA.client.isOnline() && !rtB.client.isOnline() ? true : undefined), 5_000);
  assert.equal(runtimeBySession("ses-disp-a"), undefined);
  assert.equal(runtimeBySession("ses-disp-b"), undefined);
  // and their aliases are FREE at the broker again
  const probe = new MeshClient({ alias: rtA.client.alias, runtimeDir: fx.dirs.runtimeDir, config: CFG });
  await probe.connect();
  assert.equal(probe.alias, rtA.client.alias);
  await probe.close();
});

test("runtime: alias auto-reclaim — falls back, then reclaims when the holder dies", async (t) => {
  const fx = await setup();
  process.env.MESH_ALIAS_RECLAIM_MS = "300";
  t.after(async () => {
    delete process.env.MESH_ALIAS_RECLAIM_MS;
    await disposeRuntime("ses-reclaim");
  });

  const holder = new MeshClient({ alias: "rc-x", runtimeDir: fx.dirs.runtimeDir, config: CFG });
  await holder.connect();

  const { MeshIdentity } = await import("../src/shared/identity-store.js");
  new MeshIdentity(fx.dirs.stateDir).save({
    version: 1,
    sessionId: "ses-reclaim",
    alias: "rc-x",
    preferredAlias: "rc-x",
    rooms: ["default"],
    reservations: [],
    updatedAt: new Date().toISOString(),
  } as never);

  const rt = await createSessionRuntime("ses-reclaim", CFG, async () => {});
  await waitFor(() => (rt.client.isOnline() ? true : undefined), 15_000);
  assert.notEqual(rt.client.alias, "rc-x"); // fell back

  // the holder dies → the runtime must reclaim rc-x BY ITSELF
  await holder.close();
  await waitFor(() => (rt.client.alias === "rc-x" ? true : undefined), 15_000);
  assert.equal(rt.client.alias, "rc-x");
  const id = JSON.parse(readFileSync(fx.dirs.stateDir + "/identity-ses-reclaim.json", "utf8"));
  assert.equal(id.alias, "rc-x");
});

test("runtime: submit fails loud and clear without a session domain", async (t) => {
  const fx = await setup();
  t.after(async () => {
    await disposeRuntime("ses-nosession");
    // re-attach the good context for any later fixture use
    attachOpenCodeSession({
      session: { prompt: async () => ({}), interrupt: async () => ({}), wait: async () => ({}) },
    });
  });
  attachOpenCodeSession({}); // neither ctx.session nor top-level prompt
  const rt: MeshSessionRuntime = await createSessionRuntime("ses-nosession", CFG, async () => {});
  await assert.rejects(rt.submit("x", "queue"), /session\.prompt is not available/);
});

test("runtime: top-level prompt fallback attaches", async (t) => {
  const fx = await setup();
  const seen: string[] = [];
  attachOpenCodeSession({ prompt: async (input: { text?: string }) => {
    seen.push(input.text ?? "");
    return {};
  } });
  t.after(async () => {
    await disposeRuntime("ses-toplevel");
    attachOpenCodeSession({
      session: { prompt: async () => ({}), interrupt: async () => ({}), wait: async () => ({}) },
    });
  });
  const rt = await createSessionRuntime("ses-toplevel", CFG, async () => {});
  await rt.submit("via-top-level", "queue");
  assert.deepEqual(seen, ["via-top-level"]);
});

