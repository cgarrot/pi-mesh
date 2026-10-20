// shared/lease-trailer.ts — B: the Mesh-Lease commit trailer.
// A commit that belongs to a leased task carries:
//   Mesh-Lease: <task>#<leaseId>#<epoch>:<fence>
// The commit-msg hook parses this and asks the broker whether that exact
// epoch:fence still holds — a restarted broker or a re-claimed task makes the
// trailer stale and the commit is rejected.
export interface LeaseRef {
  task: string;
  leaseId: string;
  epoch: number;
  fence: number;
}

export function formatLeaseTrailer(ref: LeaseRef): string {
  return `Mesh-Lease: ${ref.task}#${ref.leaseId}#${ref.epoch}:${ref.fence}`;
}

const TRAILER_RE =
  /^Mesh-Lease:[ \t]*([A-Za-z0-9][A-Za-z0-9._:/-]{0,127})#([^#\s]{1,128})#(\d{1,16}):(\d{1,16})[ \t]*$/m;

/** Parse the first Mesh-Lease trailer from a commit message. Undefined when
 *  the message has none (a normal commit) or the line is malformed. */
export function parseLeaseTrailer(text: string): LeaseRef | undefined {
  const m = TRAILER_RE.exec(text);
  if (m === null) return undefined;
  return { task: m[1]!, leaseId: m[2]!, epoch: Number(m[3]), fence: Number(m[4]) };
}
