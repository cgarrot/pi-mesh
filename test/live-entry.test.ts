// test/live-entry.test.ts — D43/B9: live inbound entries while the agent is
// busy, with the per-agent cooldown (at most one entry per agent per window;
// the batch carries the full set at the end).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { MeshClient } from "../src/client/client.js";
import { attachClientListeners } from "../src/extension/attach.js";
import { makeTempDirs, startTestBroker, type TempDirs } from "./helpers.js";

interface LiveEntry {
  customType: string;
  data?: { from?: string; body?: string };
}

function fakePi() {
  const entries: LiveEntry[] = [];
  const sent: unknown[] = [];
  // isIdle() === false means BUSY (a tool call is running) → live entries.
  const idle = { value: true };
  return {
    pi: {
      appendEntry: (customType: string, data?: unknown) => {
        entries.push({ customType, data: data as { from?: string; body?: string } });
      },
      sendMessage: (m: unknown) => {
        sent.push(m);
      },
      on: () => {},
    } as never,
    entries,
    sent,
    idle,
    ctx: {
      isIdle: () => idle.value,
    } as never,
  };
}

describe("live inbound entries (D43/B9)", () => {
  let dirs: TempDirs;
  let broker: Awaited<ReturnType<typeof startTestBroker>>;
  let sender: MeshClient;

  before(async () => {
    dirs = makeTempDirs("mesh-live-");
    broker = await startTestBroker(dirs.runtimeDir);
    sender = new MeshClient({ alias: "live-src", runtimeDir: dirs.runtimeDir });
    await sender.connect();
  });

  after(async () => {
    await sender.close().catch(() => {});
    await broker.close();
    rmSync(dirs.root, { recursive: true, force: true });
  });

  it("busy agent gets live entries; cooldown merges the burst per agent", async () => {
    const { pi, entries, idle } = fakePi();
    const me = new MeshClient({
      alias: "live-me",
      runtimeDir: dirs.runtimeDir,
      config: { inboundBatchMs: 60_000, inboundBatchMaxHoldMs: 60_000 },
    });
    await me.connect();
    // busy: the agent is inside a tool call (sleep) → frames are held
    idle.value = false;
    attachClientListeners(
      pi as never,
      { client: me, ctx: { isIdle: () => idle.value } } as never,
      () => null,
      { isIdle: () => idle.value } as never,
      me,
      () => {},
      10_000, // cooldown: 10 s — a fast burst only shows the FIRST entry
    );
    await sender.send({ to: "live-me", message: "one" });
    await sender.send({ to: "live-me", message: "two" });
    await sender.send({ to: "live-me", message: "three" });
    // wait for the frames to arrive
    await new Promise((r) => setTimeout(r, 300));
    const live = entries.filter((e) => e.customType === "mesh-live");
    assert.equal(live.length, 1, "burst from the same agent collapses to ONE live entry");
    assert.equal(live[0]!.data?.from, "live-src");
    // second burst after the cooldown window → a new live entry
    await new Promise((r) => setTimeout(r, 10_200));
    await sender.send({ to: "live-me", message: "four" });
    await new Promise((r) => setTimeout(r, 300));
    const live2 = entries.filter((e) => e.customType === "mesh-live");
    assert.equal(live2.length, 2, "new burst after the cooldown shows again");
    await me.close();
  });

  it("cooldown 0 → every held frame gets its live entry", async () => {
    const { pi, entries, idle } = fakePi();
    const me = new MeshClient({
      alias: "live-me2",
      runtimeDir: dirs.runtimeDir,
      config: { inboundBatchMs: 60_000, inboundBatchMaxHoldMs: 60_000 },
    });
    await me.connect();
    idle.value = false; // busy → live entries
    attachClientListeners(
      pi as never,
      { client: me, ctx: { isIdle: () => idle.value } } as never,
      () => null,
      { isIdle: () => idle.value } as never,
      me,
      () => {},
      0, // no cooldown
    );
    await sender.send({ to: "live-me2", message: "a" });
    await sender.send({ to: "live-me2", message: "b" });
    await new Promise((r) => setTimeout(r, 300));
    const live = entries.filter((e) => e.customType === "mesh-live");
    assert.equal(live.length, 2, "cooldown 0 keeps every live entry");
    await me.close();
  });
});
