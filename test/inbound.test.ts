// test/inbound.test.ts — injected content format: first line byte-identical
// (§9.1, HUD/docs depend on it), plus an explicit mesh_reply instruction line
// carrying the exact msgId so the receiving model knows HOW to answer.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatInboundContent, handleInboundFrame, localTime, sendReadReceipt } from "../src/extension/inbound.js";
import { buildFrame, type MeshFrame } from "../src/protocol/envelope.js";

const msgFrame = (): MeshFrame =>
  buildFrame({ type: "msg", from: "alice", to: "bob", room: "default", body: "hello" });

describe("formatInboundContent: verbose format (contextVerbosity full)", () => {
  it("msg frame first line is exactly `[mesh] @from (room X, priority) body`", () => {
    const f = msgFrame();
    const firstLine = formatInboundContent(f, { verbose: true }).split("\n")[0];
    assert.equal(firstLine, `[mesh] @alice (room default, normal, ${localTime(f.ts)}) hello`);
  });

  it("mailbox frame keeps the same first-line format", () => {
    const f = buildFrame({
      type: "mailbox",
      from: "alice",
      to: "bob",
      room: "ops",
      priority: "urgent",
      body: "queued",
    });
    const firstLine = formatInboundContent(f, { verbose: true }).split("\n")[0];
    assert.equal(firstLine, `[mesh] @alice (room ops, urgent, ${localTime(f.ts)}) queued`);
  });
});

describe("formatInboundContent: compact default (v0.5)", () => {
  it("msg frame: `[mesh] @from HH:MM:SS body (m_id)` — room omitted at home, hint present by default", () => {
    const f = msgFrame();
    const firstLine = formatInboundContent(f).split("\n")[0];
    assert.equal(firstLine, `[mesh] @alice ${localTime(f.ts)} hello (${f.id})`);
    const content = formatInboundContent(f);
    assert.ok(content.includes(`↩ reply with the mesh_reply tool using msgId "${f.id}"`));
  });

  it("foreign room + urgent priority are tagged; hint can be gated off", () => {
    const f = buildFrame({
      type: "msg",
      from: "alice",
      to: "bob",
      room: "ops",
      priority: "urgent",
      body: "run",
    });
    const firstLine = formatInboundContent(f, { homeRoom: "default" }).split("\n")[0] ?? "";
    assert.ok(firstLine.startsWith(`[mesh] @alice [ops] urgent ${localTime(f.ts)} run (`), firstLine);
    const noHint = formatInboundContent(f, { showReplyHint: false });
    assert.ok(!noHint.includes("↩ reply"));
    assert.ok(noHint.includes(`(${f.id})`), "msgId suffix ALWAYS present");
  });

  it("same room as home → no room tag", () => {
    const f = buildFrame({ type: "msg", from: "a", to: "b", room: "cs-room", body: "x" });
    const firstLine = formatInboundContent(f, { homeRoom: "cs-room" }).split("\n")[0] ?? "";
    assert.ok(firstLine.startsWith(`[mesh] @a ${localTime(f.ts)} x (`), firstLine);
    assert.ok(!firstLine.includes("[cs-room]"));
  });
});

describe("formatInboundContent: mesh_reply instruction line", () => {
  it("msg frame carries a 2nd line instructing reply via mesh_reply with the exact msgId", () => {
    const f = msgFrame();
    const content = formatInboundContent(f);
    const lines = content.split("\n");
    assert.equal(lines.length, 2);
    assert.equal(lines[1], `↩ reply with the mesh_reply tool using msgId "${f.id}"`);
  });

  it("mailbox frame carries the same msgId instruction line", () => {
    const f = buildFrame({ type: "mailbox", from: "alice", to: "bob", body: "queued" });
    const content = formatInboundContent(f);
    assert.ok(
      content.includes(`\n↩ reply with the mesh_reply tool using msgId "${f.id}"`),
      `mailbox content must include the msgId instruction line, got: ${content}`,
    );
  });

  it("empty-body msg frame still carries the instruction line", () => {
    const f = buildFrame({ type: "msg", from: "alice", to: "bob" });
    const content = formatInboundContent(f);
    assert.ok(content.endsWith(`↩ reply with the mesh_reply tool using msgId "${f.id}"`));
  });
});

describe("formatInboundContent: remind frames carry the replyTo instruction", () => {
  it("remind uses frame.replyTo in the instruction when present", () => {
    const f = buildFrame({ type: "remind", from: "broker", to: "bob", replyTo: "msg-123" });
    const content = formatInboundContent(f, { verbose: true });
    assert.equal(
      content,
      `[mesh] @broker (room default, normal, ${localTime(f.ts)}) reminder: reply due for msg-123` +
        ' — reply with the mesh_reply tool using msgId "msg-123" ' +
        '(IGNORE this reminder if you ALREADY replied to this msgId)',
    );
  });

  it("remind falls back to frame.id when replyTo is absent", () => {
    // defensive fallback: a remind frame without replyTo (buildFrame does not
    // enforce replyTo; validation is a separate step).
    const f = buildFrame({ type: "remind", from: "broker", to: "bob" });
    assert.equal(f.replyTo, undefined);
    const verbose = formatInboundContent(f, { verbose: true });
    assert.ok(
      verbose.includes(`reply due for ${f.id} — reply with the mesh_reply tool using msgId "${f.id}"`),
      `remind must fall back to frame.id, got: ${verbose}`,
    );
    const compact = formatInboundContent(f);
    assert.ok(compact.includes(`reply due for ${f.id}`), compact);
    assert.ok(compact.includes(`msgId "${f.id}"`), compact);
  });
});

describe("formatInboundContent: orphan replies (the cs-room fix)", () => {
  it("reply frame is labelled as an answer to the original msgId", () => {
    const f = buildFrame({
      type: "reply",
      from: "bob",
      to: "alice",
      room: "cs-room",
      replyTo: "m_orig_12345678",
      body: "MISSION COMPLETE",
    });
    const content = formatInboundContent(f, { verbose: true });
    assert.ok(
      content.startsWith(`[mesh] @bob (room cs-room, normal, ${localTime(f.ts)}) reply to m_orig_12345678: MISSION COMPLETE`),
      `got: ${content}`,
    );
    assert.ok(
      content.includes(`answer back with the mesh_reply tool using msgId "${f.id}"`),
      `got: ${content}`,
    );
  });

  it("compact reply keeps the msgId suffix even without the hint line", () => {
    const f = buildFrame({
      type: "reply",
      from: "bob",
      to: "alice",
      replyTo: "m_orig_12345678",
      body: "DONE",
    });
    const content = formatInboundContent(f, { showReplyHint: false });
    assert.ok(content.includes(`(${f.id})`), "compact reply MUST keep the msgId suffix");
    assert.ok(!content.includes("↩"));
  });
});

describe("reply-to-reply info-only format (D39)", () => {
  it("labels the reply-à-reply so the LLM decides; missions stay normal", () => {
    const chain = buildFrame({
      type: "reply",
      from: "agent-4",
      to: "lead",
      room: "cs-room",
      replyTo: "m_reply_12345678", // targets a reply → chain
      body: "CONFIRMÉ — preuve ligne-à-ligne fam1538",
    });
    const content = formatInboundContent(chain, { replyChain: true });
    assert.ok(content.includes("INFO ONLY"), content);
    assert.ok(content.includes("via mesh_send"), content);
    assert.ok(content.includes(`(${chain.id})`), `chain reply keeps its msgId suffix: ${content}`);

    const mission = buildFrame({
      type: "reply",
      from: "agent-4",
      to: "lead",
      room: "cs-room",
      replyTo: "m_mission_1234567", // targets a mission → normal
      body: "MISSION TERMINÉE",
    });
    const normal = formatInboundContent(mission, { replyChain: false, showReplyHint: true });
    assert.ok(normal.includes("answer with the mesh_reply tool"), normal);
    assert.ok(!normal.includes("INFO ONLY"), normal);
  });
});

describe("handleInboundFrame: injection retry (a silent drop is the worst outcome)", () => {
  const frame = (): MeshFrame =>
    buildFrame({ type: "msg", from: "alice", to: "bob", room: "default", body: "hello" });

  const makeDeps = () => {
    const counters = { ledgerFailures: 0, transcriptFailures: 0, injectionFailures: 0 };
    return {
      deps: {
        ledger: { append: (_input: unknown) => {} },
        transcript: { record: (_dir: "in" | "out", _f: MeshFrame) => {} },
        selfAlias: "bob",
        counters,
        retryMs: 5,
      },
      counters,
    };
  };
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it("a transient sendMessage throw retries once and recovers (no failure counted)", async () => {
    let calls = 0;
    const pi = {
      sendMessage: (): void => {
        calls += 1;
        if (calls === 1) throw new Error("transient host state");
      },
    };
    const { deps, counters } = makeDeps();
    handleInboundFrame(pi as never, null, frame(), deps as never);
    assert.equal(calls, 1); // first attempt threw synchronously
    await sleep(30); // retryMs 5 — the retry has fired
    assert.equal(calls, 2);
    assert.equal(counters.injectionFailures, 0);
  });

  it("a persistent failure is counted exactly once, after the retry", async () => {
    let calls = 0;
    const pi = {
      sendMessage: (): void => {
        calls += 1;
        throw new Error("host is gone");
      },
    };
    const { deps, counters } = makeDeps();
    handleInboundFrame(pi as never, null, frame(), deps as never);
    await sleep(30);
    assert.equal(calls, 2);
    assert.equal(counters.injectionFailures, 1);
  });

  it("side effects (ledger/transcript/read receipt) still run on the injection-failure path", async () => {
    const pi = { sendMessage: (): void => {
      throw new Error("nope");
    } };
    const ledgerEvents: string[] = [];
    const { counters } = makeDeps();
    const deps = {
      ledger: { append: (input: { event?: string }) => { ledgerEvents.push(input.event ?? "?"); } },
      transcript: { record: (_dir: "in" | "out", _f: MeshFrame) => {} },
      selfAlias: "bob",
      counters,
      retryMs: 5,
    };
    handleInboundFrame(pi as never, null, frame(), deps as never);
    await sleep(30);
    assert.ok(ledgerEvents.includes("inbound"));
  });
});

describe("sendReadReceipt (D34): only new messages echo", () => {
  it("msg/mailbox send a receipt with id+from; reply/remind do not", () => {
    const calls: string[] = [];
    const read = (id: string, from: string): void => { calls.push(`${id}<-${from}`); };
    const msg = buildFrame({ type: "msg", from: "alice", to: "bob", body: "x" });
    sendReadReceipt(msg, read);
    const box = buildFrame({ type: "mailbox", from: "carol", to: "bob", body: "y" });
    sendReadReceipt(box, read);
    const reply = buildFrame({ type: "reply", from: "dave", to: "bob", replyTo: "m1", body: "z" });
    sendReadReceipt(reply, read);
    const remind = buildFrame({ type: "remind", from: "erin", to: "bob", replyTo: "m1" });
    sendReadReceipt(remind, read);
    assert.deepEqual(calls, [`${msg.id}<-alice`, `${box.id}<-carol`]);
  });

  it("a throwing read never breaks the handler", () => {
    const msg = buildFrame({ type: "msg", from: "alice", to: "bob", body: "x" });
    assert.doesNotThrow(() => sendReadReceipt(msg, () => { throw new Error("offline"); }));
  });
});
