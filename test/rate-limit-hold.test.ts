// test/rate-limit-hold.test.ts — while the session is rate-limited (429),
// inbound frames are HELD (no injection → no burned turns) and delivered
// when the hold expires (flushHeld).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { MeshClient } from "../src/client/client.js";
import { attachClientListeners } from "../src/extension/attach.js";
import { makeTempDirs, startTestBroker, type TempDirs } from "./helpers.js";

function fakePi() {
  const sent: unknown[] = [];
  const entries: { customType: string }[] = [];
  return {
    pi: {
      sendMessage: (m: unknown) => {
        sent.push(m);
      },
      appendEntry: (customType: string) => {
        entries.push({ customType });
      },
      on: () => {},
    } as never,
    sent,
    entries,
    ctx: { isIdle: () => true } as never,
  };
}

describe("rate-limited inbound hold", () => {
  let dirs: TempDirs;
  let broker: Awaited<ReturnType<typeof startTestBroker>>;
  let sender: MeshClient;

  before(async () => {
    dirs = makeTempDirs("mesh-rlhold-");
    broker = await startTestBroker(dirs.runtimeDir);
    sender = new MeshClient({ alias: "rl-src", runtimeDir: dirs.runtimeDir });
    await sender.connect();
  });

  after(async () => {
    await sender.close().catch(() => {});
    await broker.close();
    rmSync(dirs.root, { recursive: true, force: true });
  });

  it("frames are held while rate-limited and delivered on flushHeld", async () => {
    const { pi, sent } = fakePi();
    const me = new MeshClient({
      alias: "rl-me",
      runtimeDir: dirs.runtimeDir,
      config: { inboundBatchMs: 0 }, // no batching — injection is immediate
    });
    await me.connect();
    const rt = {
      client: me,
      ctx: { isIdle: () => true },
      rateLimitedUntil: Date.now() + 60_000, // provider is rejecting turns
    } as never;
    attachClientListeners(pi as never, rt, () => null, { isIdle: () => true } as never, me, () => {}, 0);

    await sender.send({ to: "rl-me", message: "one" });
    await sender.send({ to: "rl-me", message: "two" });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(sent.length, 0, "NOTHING is injected while rate-limited");

    // hold expires → flushHeld delivers everything
    const flush = (rt as { flushHeld?: () => void }).flushHeld;
    assert.ok(flush !== undefined, "flushHeld exposed");
    flush!();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(sent.length, 2, "held frames delivered on flush");
    const contents = sent.map((m) => JSON.stringify(m));
    assert.ok(contents.some((c) => c.includes("one")), "first frame delivered");
    assert.ok(contents.some((c) => c.includes("two")), "second frame delivered");
    await me.close();
  });

  it("frames flow normally when NOT rate-limited", async () => {
    const { pi, sent } = fakePi();
    const me = new MeshClient({
      alias: "rl-me2",
      runtimeDir: dirs.runtimeDir,
      config: { inboundBatchMs: 0 },
    });
    await me.connect();
    attachClientListeners(pi as never, { client: me, ctx: { isIdle: () => true } } as never, () => null, { isIdle: () => true } as never, me, () => {}, 0);
    await sender.send({ to: "rl-me2", message: "free" });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(sent.length, 1, "normal delivery when not rate-limited");
    await me.close();
  });
});
