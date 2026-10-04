// cli/cmd/configshow.ts — mesh config show: the RESOLVED config (defaults <
// file < env) plus the resolved paths. The token is NEVER printed (D9) —
// only a sha256 prefix so operators can compare setups without leaking it.
import { createHash } from "node:crypto";
import { say } from "../out.js";
import { EXIT_OK } from "../codes.js";
import { loadConfig } from "../../shared/config.js";
import { brokerSocketPath, configPath, ledgerPath, policyPath, runtimeDir, stateDir } from "../../shared/paths.js";

export const CONFIG_USAGE = "usage: mesh config show";

function maskToken(token: string | undefined): string {
  if (token === undefined || token === "") return "absent";
  return `set (sha256:${createHash("sha256").update(token, "utf8").digest("hex").slice(0, 8)})`;
}

export async function cmdConfigShow(): Promise<number> {
  const cfg = loadConfig(stateDir());
  const rows: [string, string][] = [
    ["runtimeDir", runtimeDir()],
    ["socket", brokerSocketPath()],
    ["stateDir", stateDir()],
    ["configFile", configPath()],
    ["ledgerFile", ledgerPath()],
    ["policyFile", policyPath()],
    ["alias (config)", cfg.alias ?? "(ephemeral)"],
    ["rooms", cfg.rooms.join(",")],
    ["brokerUrl", cfg.brokerUrl ?? "(local unix socket)"],
    ["listen", cfg.listen ?? "(unix socket)"],
    ["token", maskToken(cfg.brokerToken)],
    ["maxFrameBytes", String(cfg.maxFrameBytes)],
    ["heartbeatMs", String(cfg.heartbeatMs)],
    ["mailbox", `cap=${cfg.mailboxCap} ttl=${cfg.mailboxTtlMs}ms`],
    ["activity", `idle=${cfg.activityIdleMs}ms stuck=${cfg.activityStuckMs}ms`],
    ["reservationTtlMs", String(cfg.reservationTtlMs)],
    ["ledgerMaxBytes", String(cfg.ledgerMaxBytes)],
    ["transcript", cfg.transcript ? `on (retention ${cfg.transcriptRetentionDays}d)` : "off"],
    ["watchdog", cfg.watchdog ? "on" : "off"],
    ["tls", `cert=${cfg.tlsCert ?? "-"} key=${cfg.tlsKey ?? "-"} ca=${cfg.tlsCa ?? "-"} insecure=${cfg.tlsInsecure === true ? "YES" : "no"}`],
    ["maxRoomsPerPeer", String(cfg.maxRoomsPerPeer)],
    ["inboundBatchMaxHoldMs", String(cfg.inboundBatchMaxHoldMs)],
    ["contextVerbosity", cfg.contextVerbosity ?? "compact"],
    ["inboundBroadcasts", cfg.inboundBroadcasts ?? "immediate"],
    ["inboundBatchMs", String(cfg.inboundBatchMs)],
    ["debug", cfg.debug ? "on" : "off"],
  ];
  for (const [k, v] of rows) say(`${k}: ${v}`);
  return EXIT_OK;
}
