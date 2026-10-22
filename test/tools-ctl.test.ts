// test/tools-ctl.test.ts — the four control tools: parameter validation,
// honest one-line results, and the exact ControlOpts sent to the client.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ControlOpts, CtlResult } from "../src/client/client.js";
import type { ExtensionAPI, SessionContext, ToolDefinition } from "../src/extension/pi-types.js";
import { registerTools, type MeshRuntime } from "../src/extension/tools.js";

function toolsFor(result: CtlResult, sent: ControlOpts[], ledger: Array<Record<string, unknown>> = []): Map<string, ToolDefinition> {
  const rt = {
    client: {
      alias: "alice",
      control: (opts: ControlOpts) => {
        sent.push(opts);
        return Promise.resolve(result);
      },
    },
    ledger: { append: (entry: Record<string, unknown>) => ledger.push(entry) },
    ledgerFailures: 0,
  } as unknown as MeshRuntime;
  const tools = new Map<string, ToolDefinition>();
  const pi = { registerTool: (def: ToolDefinition) => tools.set(def.name, def) } as unknown as ExtensionAPI;
  registerTools(pi, () => rt);
  return tools;
}

async function call(tools: Map<string, ToolDefinition>, name: string, params: Record<string, unknown>): Promise<{ text: string; details: Record<string, unknown> }> {
  const tool = tools.get(name);
  assert.ok(tool, `${name} registered`);
  const ctx = { cwd: "/tmp", ui: { notify: () => {}, setWidget: () => {}, setStatus: () => {} } } as unknown as SessionContext;
  const res = await tool.execute("tc", params, undefined, undefined, ctx);
  return { text: res.content[0]!.text, details: (res.details ?? {}) as Record<string, unknown> };
}

describe("control tools: mesh_abort / mesh_redirect", () => {
  it("abort sends action=abort with the required reason and reports settled", async () => {
    const sent: ControlOpts[] = [];
    const ledger: Array<Record<string, unknown>> = [];
    const tools = toolsFor({ status: "aborted", settled: true, ctlId: "m_1" }, sent, ledger);
    const out = await call(tools, "mesh_abort", { to: "bob", reason: "stuck build" });
    assert.equal(sent[0]?.action, "abort");
    assert.equal(sent[0]?.reason, "stuck build");
    assert.equal(out.details.status, "aborted");
    assert.match(out.text, /aborted @bob \(settled=true\)/);
    assert.equal(ledger[0]?.event, "ctl");
    assert.equal(ledger[0]?.id, "m_1");
    assert.equal(ledger[0]?.action, "abort");
    assert.equal(ledger[0]?.code, "aborted");
    assert.equal(Object.prototype.hasOwnProperty.call(ledger[0], "body"), false);
  });

  it("redirect carries the message and reports still_busy honestly", async () => {
    const sent: ControlOpts[] = [];
    const tools = toolsFor({ status: "still_busy", settled: false }, sent);
    const out = await call(tools, "mesh_redirect", { to: "@Bob", message: "use the cache", reason: "wrong plan" });
    assert.equal(sent[0]?.action, "redirect");
    assert.equal(sent[0]?.message, "use the cache");
    assert.match(out.text, /still_busy @bob/);
    assert.match(out.text, /instruction NOT injected/);
  });

  it("missing reason is refused locally (force-class contract)", async () => {
    const sent: ControlOpts[] = [];
    const tools = toolsFor({ status: "aborted", settled: true }, sent);
    const out = await call(tools, "mesh_abort", { to: "bob" });
    assert.equal(out.details.status, "error");
    assert.equal(sent.length, 0, "no ctl must be sent without a reason");
  });

  it("a timeout is reported as NOT retried", async () => {
    const tools = toolsFor({ status: "timeout", reason: "no ctl_ack within 15000ms — the target may have acted" }, []);
    const out = await call(tools, "mesh_abort", { to: "bob", reason: "x" });
    assert.equal(out.details.status, "timeout");
    assert.match(out.text, /NOT retried/);
  });

  it("offline peer says unreachable (never queued)", async () => {
    const tools = toolsFor({ status: "unreachable", reason: "peer is offline" }, []);
    const out = await call(tools, "mesh_abort", { to: "bob", reason: "x" });
    assert.match(out.text, /unreachable @bob: peer offline/);
  });
});

describe("control tools: job / run", () => {
  it("job_control maps stop to job_stop with an opaque target", async () => {
    const sent: ControlOpts[] = [];
    const tools = toolsFor({ status: "stopped", target: "j_1" }, sent);
    const out = await call(tools, "mesh_job_control", { to: "bob", jobId: "j_1", action: "stop" });
    assert.equal(sent[0]?.action, "job_stop");
    assert.equal(sent[0]?.target, "j_1");
    assert.match(out.text, /stopped j_1 on @bob/);
  });

  it("run_control steer requires a message and maps to run_steer", async () => {
    const sent: ControlOpts[] = [];
    const tools = toolsFor({ status: "steered", target: "rpc_1" }, sent);
    const missing = await call(tools, "mesh_run_control", { to: "bob", runId: "rpc_1", action: "steer" });
    assert.equal(missing.details.status, "error");
    assert.equal(sent.length, 0);

    const out = await call(tools, "mesh_run_control", { to: "bob", runId: "rpc_1", action: "steer", message: "use the cache" });
    assert.equal(sent[0]?.action, "run_steer");
    assert.equal(sent[0]?.target, "rpc_1");
    assert.equal(sent[0]?.message, "use the cache");
    assert.match(out.text, /steered rpc_1 on @bob/);
  });

  it("job actions reject an invalid action before sending", async () => {
    const sent: ControlOpts[] = [];
    const tools = toolsFor({ status: "stopped" }, sent);
    const out = await call(tools, "mesh_job_control", { to: "bob", jobId: "j_1", action: "explode" });
    assert.equal(out.details.status, "error");
    assert.equal(sent.length, 0);
  });
});
