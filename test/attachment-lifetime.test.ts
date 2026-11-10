import test from "node:test";
import assert from "node:assert/strict";
import { AttachmentLifetime } from "../src/extension/attachment-lifetime.js";
import { sleep } from "./helpers.js";

test("attachment stop cancels child timers and promptly resolves pending waits", async () => {
  const owner = new AttachmentLifetime();
  const child = owner.fork();
  let calls = 0;
  child.after(10, () => { calls += 1; });
  const waiting = child.wait(60_000);
  owner.onStop(() => { throw new Error("failed cleanup"); });
  owner.onStop(() => { calls += 1; });
  owner.stop();
  owner.stop();
  assert.equal(await waiting, false);
  await sleep(20);
  assert.equal(calls, 1);
  assert.equal(child.active, false);
});

test("finishing a child does not cancel its attachment; ownership loss resolves waits", async () => {
  let owned = true;
  const owner = new AttachmentLifetime(() => owned);
  owner.fork().stop();
  assert.equal(owner.active, true);
  const waiting = owner.wait(10);
  owned = false;
  await sleep(20);
  assert.equal(await waiting, false);
  owner.stop();
});
