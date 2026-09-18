// test/wake-on-answer.test.ts — LAUNCH answers are delivered to the session
// (inbox + inbound event, waking an idle session); a wait_all in flight
// carries them instead (no double delivery); a blocking send is ESC-cancellable
// and a late reply to a cancelled mission takes the orphan path.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { rmSync } from "node:fs";
import { MeshClient } from "../src/client/client.js";
import type { MeshFrame } from "../src/protocol/envelope.js";
import { makeTempDirs, sleep, startTestBroker, waitFor, type TempDirs } from "./helpers.js";

describe("wake-on-answer (LAUNCH missions)", () => {
  let dirs: TempDirs;
  let broker: Awaited<ReturnType<typeof startTestBroker>>;
  let lead: MeshClient;
  let carol: MeshClient;
  let bob: MeshClient;

  before(async () => {
    dirs = makeTempDirs("mesh-wake-");
    broker = await startTestBroker(dirs.runtimeDir);
    lead = new MeshClient({ alias: "lead", runtimeDir: dirs.runtimeDir });
    carol = new MeshClient({ alias: "carol", runtimeDir: dirs.runtimeDir });
    bob = new MeshClient({ alias: "bob", runtimeDir: dirs.runtimeDir });
    await Promise.all([lead.connect(), carol.connect(), bob.connect()]);
  });

  after(async () => {
    await lead.close().catch(() => {});
    await carol.close().catch(() => {});
    await bob.close().catch(() => {});
    await broker.close();
    rmSync(dirs.root, { recursive: true, force: true });
  });

  function resetPeers(): void {
    carol.removeAllListeners("inbound");
    bob.removeAllListeners("inbound");
  }

  it("a LAUNCH answer is stored in the inbox and emitted as inbound (wakes the session)", async () => {
    lead.cancelAllAwaited();
    resetPeers();
    carol.on("inbound", (f: MeshFrame) => {
      if (f.type === "msg") void carol.reply(f.id, "carol answer");
    });
    const sent = await lead.send({ to: "carol", message: "wake me", awaitReply: true, block: false, timeoutMs: 30_000 });
    assert.equal(sent.status, "delivered");

    let matchedReply = false;
    const injected = await new Promise<MeshFrame>((resolve) => {
      lead.once("inbound", (frame: MeshFrame, meta?: { matchedReply?: boolean }) => {
        matchedReply = meta?.matchedReply === true;
        resolve(frame);
      });
    });
    assert.equal(matchedReply, true, "LAUNCH wake metadata bypasses broadcast deferral");
    assert.equal(injected.type, "reply");
    assert.equal(injected.replyTo, sent.msgId); // correlates the mission
    assert.equal(injected.body, "carol answer");
    // the answer frame itself is replyable (inbox, not just an event)
    assert.ok(lead.peekInbox(injected.id ?? "") !== undefined);
    // and the mission is answered as before
    const m = lead.missionStatus().find((x) => x.msgId === sent.msgId);
    assert.ok(m !== undefined && m.answered);
    lead.removeAllListeners("inbound");
  });

  it("a BLOCKING answer resolves the send promise and does NOT emit inbound", async () => {
    lead.cancelAllAwaited();
    resetPeers();
    carol.on("inbound", (f: MeshFrame) => {
      if (f.type === "msg") void carol.reply(f.id, "blocking answer");
    });
    let inboundCount = 0;
    lead.on("inbound", () => { inboundCount += 1; });
    const res = await lead.send({ to: "carol", message: "block me", awaitReply: true, timeoutMs: 30_000 });
    assert.equal(res.status, "reply");
    assert.equal(res.response, "blocking answer");
    assert.equal(inboundCount, 0, "blocking answers stay in the tool result");
    lead.removeAllListeners("inbound");
  });

  it("while wait_all is in flight the verdict carries the batch — no inbound; after it, injection resumes", async () => {
    lead.cancelAllAwaited();
    resetPeers();
    let carolGot: MeshFrame | undefined;
    carol.on("inbound", (f: MeshFrame) => {
      if (f.type === "msg") carolGot = f;
    });
    let inboundCount = 0;
    lead.on("inbound", () => { inboundCount += 1; });

    // batch 1: answer arrives WHILE wait_all is running
    const sent = await lead.send({ to: "carol", message: "during wait", awaitReply: true, block: false, timeoutMs: 30_000 });
    const verdictP = lead.waitAll(10_000);
    await waitFor(() => (carolGot !== undefined ? true : undefined));
    const during = carolGot as MeshFrame | undefined;
    assert.ok(during !== undefined);
    await carol.reply(during.id, "answered mid-wait");
    const verdict = await verdictP;
    assert.equal(verdict.status, "complete");
    assert.ok(verdict.answers.some((a) => a.response === "answered mid-wait"));
    assert.equal(inboundCount, 0, "no double delivery while wait_all is active");

    // batch 2: after the verdict, injection resumes
    carolGot = undefined;
    const sent2 = await lead.send({ to: "carol", message: "after wait", awaitReply: true, block: false, timeoutMs: 30_000 });
    assert.notEqual(sent2.msgId, sent.msgId);
    await waitFor(() => (carolGot !== undefined ? true : undefined));
    const after = carolGot as MeshFrame | undefined;
    assert.ok(after !== undefined);
    await carol.reply(after.id, "answered after wait");
    await waitFor(() => (inboundCount > 0 ? true : undefined));
    assert.equal(inboundCount, 1, "post-verdict answers are injected again");
    lead.removeAllListeners("inbound");
  });

  it("an identical re-sent answer after wake injection is deduped; a different body still passes", async () => {
    lead.cancelAllAwaited();
    resetPeers();
    let carolGot: MeshFrame | undefined;
    carol.on("inbound", (f: MeshFrame) => {
      if (f.type === "msg") carolGot = f;
    });
    let inboundCount = 0;
    lead.on("inbound", () => { inboundCount += 1; });

    const sent = await lead.send({ to: "carol", message: "dedup me", awaitReply: true, block: false, timeoutMs: 30_000 });
    await waitFor(() => (carolGot !== undefined ? true : undefined));
    const msg = carolGot as MeshFrame | undefined;
    assert.ok(msg !== undefined);
    await carol.reply(msg.id, "the answer");
    await waitFor(() => (inboundCount === 1 ? true : undefined));

    // identical re-send (e.g. the peer re-answering on a remind) → dropped
    await carol.reply(msg.id, "the answer");
    await sleep(300);
    assert.equal(inboundCount, 1, "exact duplicate of an injected answer is dropped");

    // a DIFFERENT answer to the same msgId (ack then final report) still passes
    await carol.reply(msg.id, "correction: actually 42");
    await waitFor(() => (inboundCount === 2 ? true : undefined));
    lead.removeAllListeners("inbound");
  });

  it("ESC (AbortSignal) cancels a blocking send; the mission is dropped and a late reply is injected", async () => {
    lead.cancelAllAwaited();
    resetPeers();
    // bob answers LATE — after the abort
    bob.on("inbound", (f: MeshFrame) => {
      if (f.type === "msg") setTimeout(() => void bob.reply(f.id, "late bob"), 600).unref();
    });
    const ac = new AbortController();
    const t0 = Date.now();
    const p = lead.send({ to: "bob", message: "esc me", awaitReply: true, timeoutMs: 30_000, signal: ac.signal });
    setTimeout(() => ac.abort(), 250).unref();
    const res = await p;
    assert.equal(res.status, "error");
    assert.equal(res.reason, "cancelled");
    assert.ok(Date.now() - t0 < 5000, "settles at the abort, not the 30-min timeout");
    assert.equal(lead.pendingCount, 0, "pending cancelled");
    const m = lead.missionStatus().find((x) => x.msgId === res.msgId);
    assert.equal(m, undefined, "cancelled mission is dropped, never 'waiting'");

    // the late reply arrives → orphan path → injected
    const injected = await new Promise<MeshFrame>((resolve) => {
      lead.once("inbound", resolve);
    });
    assert.equal(injected.type, "reply");
    assert.equal(injected.replyTo, res.msgId);
    assert.equal(injected.body, "late bob");
    lead.removeAllListeners("inbound");
  });
});
