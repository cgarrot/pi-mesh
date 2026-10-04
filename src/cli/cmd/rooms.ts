// cli/cmd/rooms.ts — join/leave (debug-only: membership dies with the
// process — the honest note is printed so nobody relies on it persisting).
import { say, sayErr } from "../out.js";
import { EXIT_OK, EXIT_MESH_FAILURE, EXIT_USAGE } from "../codes.js";
import { ephemeralClient } from "../ctx.js";

export async function cmdRoom(room: string | undefined, sub: "join" | "leave", observer: boolean): Promise<number> {
  if (room === undefined) {
    sayErr(`usage: mesh ${sub} <room> [observer]`);
    return EXIT_USAGE;
  }
  const client = ephemeralClient();
  try {
    await client.connect();
    if (sub === "join") {
      await client.join(room, observer ? "observer" : "member");
      say(`joined ${room} (dies with this process — CLI membership is connection-scoped)`);
    } else {
      await client.leave(room);
      say(`left ${room}`);
    }
  } catch (err) {
    sayErr(`${sub} failed: ${err instanceof Error ? err.message : String(err)}`);
    await client.close();
    return EXIT_MESH_FAILURE;
  }
  await client.close();
  return EXIT_OK;
}
