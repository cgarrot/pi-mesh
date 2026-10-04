// shared/reservations.ts — file reservation matching.
// Pure functions, no Pi imports: pattern normalization + conflict lookup
// against a peer→reservations map. Mirrors the old pi-mesh semantics: a
// trailing "/" reserves a whole directory subtree, anything else is exact.
// Lives in shared/ (not extension/) so the CLI dry-run conflict check uses
// the EXACT same matching semantics as the edit/write guards (V4 kept).
import type { FileReservation } from "../protocol/envelope.js";

/** Normalize a path/pattern for comparison: forward slashes, no "./", and
 *  case-folded on Windows (NTFS is case-insensitive). */
export function normalizePath(p: string): string {
  let out = p.replace(/\\/g, "/").replace(/^\.\//, "");
  if (process.platform === "win32") out = out.toLowerCase();
  return out;
}

/** True when `filePath` falls under reservation `pattern`. */
export function pathMatchesReservation(filePath: string, pattern: string): boolean {
  const file = normalizePath(filePath);
  const pat = normalizePath(pattern);
  if (pat.endsWith("/")) {
    return file.startsWith(pat) || file + "/" === pat;
  }
  return file === pat;
}

/**
 * a reservation older than ttlMs is expired and does not block anyone.
 * ttlMs 0 = unlimited default).
 */
export function isReservationExpired(
  reservation: FileReservation,
  ttlMs: number,
  now: number = Date.now(),
): boolean {
  if (ttlMs <= 0) return false;
  if (reservation.since === undefined) return false;
  const t = Date.parse(reservation.since);
  if (Number.isNaN(t)) return false;
  return now - t > ttlMs;
}

/** First conflicting reservation for `filePath`, or undefined. */
export function findConflict(
  filePath: string,
  reservationsByPeer: ReadonlyMap<string, readonly FileReservation[]>,
  selfAlias: string,
  ttlMs: number = 0,
): { alias: string; reservation: FileReservation } | undefined {
  for (const [alias, reservations] of reservationsByPeer) {
    if (alias === selfAlias) continue;
    for (const reservation of reservations) {
      if (isReservationExpired(reservation, ttlMs)) continue;
      if (pathMatchesReservation(filePath, reservation.pattern)) {
        return { alias, reservation };
      }
    }
  }
  return undefined;
}
