// cli/ctx.ts — shared CLI context: config resolution + ephemeral client
// factory. One place so every command honors .mesh/config.json + env
// (MESH_BROKER_URL/TOKEN/…) exactly like extension clients do.
import { randomBytes } from "node:crypto";
import { MeshClient } from "../client/client.js";
import { ALIAS_RAND_CHARS, type MeshConfig } from "../shared/config.js";
import { loadConfig } from "../shared/config.js";
import { stateDir } from "../shared/paths.js";

/** Client config from <cwd>/.mesh/config.json + env. */
export function resolveCliConfig(): Partial<MeshConfig> {
  return loadConfig(stateDir());
}

export function cliAlias(): string {
  return `cli-${randomBytes(ALIAS_RAND_CHARS / 2).toString("hex").slice(0, ALIAS_RAND_CHARS)}`;
}

export interface EphemeralClientOpts {
  alias?: string;
  rooms?: string[];
}

/** Ephemeral one-shot client: fresh cli-<rand6> alias, no auto-reconnect.
 * An EXPLICIT alias is strict (D7): a collision is a hard error, never a
 * silent fallback to a random identity. */
export function ephemeralClient(opts: EphemeralClientOpts = {}): MeshClient {
  return new MeshClient({
    alias: opts.alias ?? cliAlias(),
    rooms: opts.rooms,
    noReconnect: true,
    strictAlias: opts.alias !== undefined,
    config: resolveCliConfig(),
  });
}
