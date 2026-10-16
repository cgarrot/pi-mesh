// test/reconnect.test.ts — brokerEntryPath resolution branches (hermetic
// mkdtemp fixtures): sibling dist, repo-root dist fallback (jiti-from-src),
// $MESH_BROKER_ENTRY override priority, descriptive error when nothing exists.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { brokerEntryPath } from "../src/client/reconnect.js";
import { brokerExecPath } from "../src/shared/exec.js";

let roots: string[] = [];

function fixture(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "mesh-reconnect-test-"));
  roots.push(root);
  return root;
}

function touchBroker(rel: string): (root: string) => string {
  return (root: string) => {
    const p = path.join(root, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, "// broker entry stub\n");
    return p;
  };
}

afterEach(() => {
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
  roots = [];
});

describe("brokerEntryPath", () => {
  it("(a) sibling dist: moduleDir=<fix>/dist/src/client with ../broker/broker.js present → sibling path", () => {
    const root = fixture();
    const broker = touchBroker(path.join("dist", "src", "broker", "broker.js"))(root);
    const moduleDir = path.join(root, "dist", "src", "client");
    mkdirSync(moduleDir, { recursive: true });
    assert.equal(brokerEntryPath({}, moduleDir), broker);
  });

  it("(b) repo-root fallback: moduleDir=<fix>/src/client (no sibling .js) + package.json + dist broker → dist path", () => {
    const root = fixture();
    const broker = touchBroker(path.join("dist", "src", "broker", "broker.js"))(root);
    writeFileSync(path.join(root, "package.json"), '{"name":"fix"}\n');
    const moduleDir = path.join(root, "src", "client");
    mkdirSync(moduleDir, { recursive: true });
    // sanity: the sibling candidate must NOT exist (TS source tree)
    assert.equal(brokerEntryPath({}, moduleDir), broker);
  });

  it("(c) override: $MESH_BROKER_ENTRY wins even when candidates exist", () => {
    const root = fixture();
    touchBroker(path.join("dist", "src", "broker", "broker.js"))(root);
    const moduleDir = path.join(root, "dist", "src", "client");
    mkdirSync(moduleDir, { recursive: true });
    const override = path.join(root, "custom", "my-broker.js"); // need not exist
    assert.equal(
      brokerEntryPath({ MESH_BROKER_ENTRY: override }, moduleDir),
      override,
    );
  });

  it("(d) no candidates → descriptive error mentioning `npm run build`, MESH_BROKER_ENTRY, and tried paths", () => {
    const root = fixture();
    writeFileSync(path.join(root, "package.json"), '{"name":"fix"}\n');
    const moduleDir = path.join(root, "src", "client");
    mkdirSync(moduleDir, { recursive: true });
    const sibling = path.resolve(moduleDir, "..", "broker", "broker.js");
    const distFallback = path.join(root, "dist", "src", "broker", "broker.js");
    assert.throws(
      () => brokerEntryPath({}, moduleDir),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /broker entry not found/);
        assert.match(err.message, /npm run build/);
        assert.match(err.message, /MESH_BROKER_ENTRY/);
        assert.ok(err.message.includes(sibling), `missing tried sibling path in: ${err.message}`);
        assert.ok(
          err.message.includes(distFallback),
          `missing tried dist fallback path in: ${err.message}`,
        );
        return true;
      },
    );
  });
});

describe("brokerExecPath (#8 compiled hosts)", () => {
  it("default: process.execPath when no override (Node behavior preserved)", () => {
    assert.equal(brokerExecPath({}), process.execPath);
  });

  it("override: $MESH_BROKER_EXEC_PATH wins", () => {
    assert.equal(
      brokerExecPath({ MESH_BROKER_EXEC_PATH: "/opt/bun/bin/bun" }),
      "/opt/bun/bin/bun",
    );
  });

  it("blank override (empty / whitespace) falls back to process.execPath", () => {
    assert.equal(brokerExecPath({ MESH_BROKER_EXEC_PATH: "" }), process.execPath);
    assert.equal(brokerExecPath({ MESH_BROKER_EXEC_PATH: "   " }), process.execPath);
  });

  it("override is trimmed (quoted shell values)", () => {
    assert.equal(
      brokerExecPath({ MESH_BROKER_EXEC_PATH: "  /usr/bin/node  " }),
      "/usr/bin/node",
    );
  });
});
