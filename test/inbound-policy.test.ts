import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyInbound } from "../src/extension/inbound-policy.js";
import type { MeshFrame } from "../src/protocol/envelope.js";

const frame: MeshFrame = {
  v: 1, type: "msg", id: "m-policy", ts: new Date().toISOString(),
  from: "other", body: "status for @someone-else", broadcast: true,
};

describe("inbound broadcast policy", () => {
  it("defers broadcasts and orphan replyAll replies without a mention", () => {
    assert.equal(classifyInbound(frame, "me", "deferred"), "deferred");
    assert.equal(classifyInbound({ ...frame, type: "reply", broadcast: false, replyAll: true }, "me", "deferred"), "deferred");
  });

  it("accepts case-insensitive, optional-@ whole-alias mentions", () => {
    for (const body of ["@me: hello", "hello me!", "(@ME)", "ME", "for @me, thanks"]) {
      assert.equal(classifyInbound({ ...frame, body }, "@me", "deferred"), "immediate", body);
    }
    for (const body of ["@someone", "@me-other", "other-me", "@me2", "@me_too"]) {
      assert.equal(classifyInbound({ ...frame, body }, "me", "deferred"), "deferred", body);
    }
    assert.equal(classifyInbound({ ...frame, body: "@agent-one: hi" }, "agent-one", "deferred"), "immediate");
  });

  it("always delivers direct messages, urgent/force, reminds and reservations immediately", () => {
    for (const f of [
      { ...frame, broadcast: false, to: "me" },
      { ...frame, type: "reply", broadcast: false },
      { ...frame, priority: "urgent" as const },
      { ...frame, priority: "force" as const },
      { ...frame, type: "remind" },
      { ...frame, type: "reserve" },
      { ...frame, type: "release" },
    ]) assert.equal(classifyInbound(f, "me", "deferred"), "immediate");
  });

  it("keeps matched LAUNCH mission replies immediate even with replyAll", () => {
    assert.equal(classifyInbound({ ...frame, type: "reply", replyAll: true }, "me", "deferred", true), "immediate");
  });

  it("defaults to immediate; immediate policy never defers", () => {
    assert.equal(classifyInbound(frame, "me"), "immediate");
    for (const type of ["msg", "mailbox", "reply", "remind", "reserve"]) {
      assert.equal(classifyInbound({ ...frame, type, replyAll: true }, "me", "immediate"), "immediate");
    }
  });
});
