// cli/cmd/peers.ts — live broker snapshot, one line per peer.
import { say } from "../out.js";
import { EXIT_OK, EXIT_MESH_FAILURE } from "../codes.js";
import { ephemeralClient } from "../ctx.js";

export async function cmdPeers(room: string | undefined): Promise<number> {
  const client = ephemeralClient();
  try {
    await client.connect();
  } catch {
    say("blocked: broker_unavailable");
    return EXIT_MESH_FAILURE;
  }
  const snap = await client.status(room);
  for (const p of snap.peers) {
    const v = p.clientVersion !== undefined && p.clientVersion !== "" ? `v${p.clientVersion}` : "v?";
    say(`${p.alias}\trooms=${p.rooms.join(",")}\tv=${v}\tsince=${p.since ?? "?"}`);
  }
  if (snap.stats !== undefined) {
    const s = snap.stats;
    say(`broker: relayed=${s.relayed} refused=${s.refused} mailboxDelivered=${s.mailboxDelivered} mailboxDropped=${s.mailboxDropped}`);
  }
  await client.close();
  return EXIT_OK;
}
