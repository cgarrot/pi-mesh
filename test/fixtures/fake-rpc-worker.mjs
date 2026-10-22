#!/usr/bin/env node
// Minimal fake pi --mode rpc child for deterministic tests.
let running = false;
let settledTimer = null;
const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
const respond = (id, command, data, success = true, error) => {
  out({ id, type: "response", command, success, ...(data === undefined ? {} : { data }), ...(error ? { error } : {}) });
};

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  for (;;) {
    const nl = buf.indexOf("\n");
    if (nl < 0) break;
    const line = buf.slice(0, nl).replace(/\r$/, "");
    buf = buf.slice(nl + 1);
    if (line.trim() !== "") handle(line);
  }
});
process.stdin.on("end", () => process.exit(0));

function handle(line) {
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch {
    out({ type: "protocol_error" });
    return;
  }
  switch (cmd.type) {
    case "prompt": {
      if (cmd.streamingBehavior !== undefined) {
        out({ type: "prompt_seen", message: cmd.message, streamingBehavior: cmd.streamingBehavior });
      }
      if (cmd.message === "SLOW") {
        setTimeout(() => respond(cmd.id, "prompt", { disposition: "started" }), 300);
        return;
      }
      if (cmd.message === "U2028") {
        out({ type: "agent_start" });
        respond(cmd.id, "prompt", { disposition: "started", text: "a\u2028b" });
        return;
      }
      running = true;
      out({ type: "agent_start" });
      respond(cmd.id, "prompt", { disposition: "started" });
      if (String(cmd.message).includes("LONG")) {
        settledTimer = setTimeout(() => {
          if (!running) return;
          running = false;
          out({ type: "agent_settled", aborted: false });
        }, 60_000);
        settledTimer.unref?.();
      }
      return;
    }
    case "steer": {
      out({ type: "steer_seen", message: cmd.message });
      respond(cmd.id, "steer", { disposition: "queued" });
      return;
    }
    case "follow_up": {
      out({ type: "follow_up_seen", message: cmd.message });
      respond(cmd.id, "follow_up", { disposition: "queued" });
      return;
    }
    case "abort_bash": {
      out({ type: "bash_aborted" });
      respond(cmd.id, "abort_bash", { aborted: true });
      return;
    }
    case "abort": {
      running = false;
      out({ type: "agent_settled", aborted: true });
      respond(cmd.id, "abort");
      return;
    }
    case "NOID": {
      out({ type: "response", command: "NOID", success: true, data: { ok: true } });
      return;
    }
    case "SPLIT": {
      const payload = `${JSON.stringify({ id: cmd.id, type: "response", command: "SPLIT", success: true, data: { text: "half" } })}\n`;
      process.stdout.write(payload.slice(0, 10));
      setTimeout(() => process.stdout.write(payload.slice(10)), 20);
      return;
    }
    case "DELAY_A": {
      setTimeout(() => respond(cmd.id, "DELAY_A", { which: "A" }), 80);
      return;
    }
    case "DELAY_B": {
      setTimeout(() => respond(cmd.id, "DELAY_B", { which: "B" }), 20);
      return;
    }
    case "get_state":
      respond(cmd.id, "get_state", {
        pendingMessageCount: 2,
        steeringMode: "all",
        isStreaming: running,
        sessionName: "fake",
      });
      return;
    case "set_steering_mode":
      respond(cmd.id, "set_steering_mode", { mode: cmd.mode });
      return;
    default:
      respond(cmd.id, cmd.type, undefined, false, `unknown command: ${cmd.type}`);
  }
}
