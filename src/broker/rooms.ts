// broker/rooms.ts — membership, roles, presence broadcasts.
import { buildFrame, isValidRoom, type FileReservation, type MeshErrorCode, type MeshRole } from "../protocol/envelope.js";
import {
  DEFAULT_ROOM,
  MAX_PEERS_PER_ROOM,
  type MeshConfig,
} from "../shared/config.js";
import type { BrokerState, PeerRecord } from "./state.js";

export type RoomResult = { ok: true } | { ok: false; code: MeshErrorCode };

/** Join a room (creating it). Enforces caps and roomId syntax. */
export function joinRoom(
  state: BrokerState,
  config: MeshConfig,
  peer: PeerRecord,
  roomId: string,
  role: MeshRole = "member",
): RoomResult {
  if (!isValidRoom(roomId)) return { ok: false, code: "invalid_room" };
  if (peer.rooms.has(roomId)) {
    peer.rooms.set(roomId, role); // role update on re-join
    return { ok: true };
  }
  if (peer.rooms.size >= config.maxRoomsPerPeer) return { ok: false, code: "invalid_room" };
  let members = state.rooms.get(roomId);
  if (!members) {
    members = new Set();
    state.rooms.set(roomId, members);
  }
  if (!members.has(peer.alias) && members.size >= MAX_PEERS_PER_ROOM) {
    return { ok: false, code: "invalid_room" };
  }
  members.add(peer.alias);
  peer.rooms.set(roomId, role);
  return { ok: true };
}

/**
 * Leave a room. A peer MAY end up in zero rooms (it simply cannot send or
 * receive room messages until it joins one again). Previously the last room
 * was refused — that made "default" un-leavable, and since the hello
 * re-auto-joined it, "default" kept coming back after /mesh leave default.
 */
export function leaveRoom(state: BrokerState, peer: PeerRecord, roomId: string): RoomResult {
  if (!peer.rooms.has(roomId)) return { ok: false, code: "not_member" };
  peer.rooms.delete(roomId);
  const members = state.rooms.get(roomId);
  if (members) {
    members.delete(peer.alias);
    if (members.size === 0) state.rooms.delete(roomId);
  }
  return { ok: true };
}

export function presenceFrame(
  alias: string,
  status: "online" | "offline",
  room: string,
  caps?: string[],
  proto?: number,
): ReturnType<typeof buildFrame> {
  return buildFrame({ type: "presence", from: alias, status, room, caps, proto });
}

/** Write a frame to every online member of a room (optionally excluding one). */
export function broadcastToRoom(
  state: BrokerState,
  roomId: string,
  frame: ReturnType<typeof buildFrame>,
  excludeAlias?: string,
  write?: (peer: PeerRecord, frame: ReturnType<typeof buildFrame>) => void,
): void {
  const members = state.rooms.get(roomId);
  if (!members) return;
  for (const alias of members) {
    if (alias === excludeAlias) continue;
    const peer = state.peers.get(alias);
    if (peer && write) write(peer, frame);
  }
}

/** Broadcast presence(online) to all rooms the peer belongs to. */
export function announceOnline(
  state: BrokerState,
  peer: PeerRecord,
  write: (peer: PeerRecord, frame: ReturnType<typeof buildFrame>) => void,
): void {
  for (const roomId of peer.rooms.keys()) {
    broadcastToRoom(state, roomId, presenceFrame(peer.alias, "online", roomId, peer.caps, peer.proto), peer.alias, write);
  }
}

/** Detach peer from all rooms; returns room ids it belonged to. */
export function detachFromRooms(state: BrokerState, peer: PeerRecord): string[] {
  const roomIds = [...peer.rooms.keys()];
  for (const roomId of roomIds) {
    const members = state.rooms.get(roomId);
    if (members) {
      members.delete(peer.alias);
      if (members.size === 0) state.rooms.delete(roomId);
    }
  }
  peer.rooms.clear();
  return roomIds;
}

/** Peers visible from a set of rooms (union), for welcome/status snapshots. */
export function peersSnapshot(state: BrokerState, roomId?: string): {
  alias: string;
  rooms: string[];
  role?: MeshRole;
  since?: string;
  lastSeenAt?: string;
  reservations?: FileReservation[];
  clientVersion?: string;
  activity?: { state: "busy" | "idle" | "rate_limited" | "blocked"; at: string };
  via?: string;
  caps?: string[];
  proto?: number;
}[] {
  const out: {
    alias: string;
    rooms: string[];
    role?: MeshRole;
    since?: string;
    lastSeenAt?: string;
    reservations?: FileReservation[];
    clientVersion?: string;
    activity?: { state: "busy" | "idle" | "rate_limited" | "blocked"; at: string };
    via?: string;
    caps?: string[];
    proto?: number;
  }[] = [];
  for (const peer of state.peers.values()) {
    if (!peer.helloDone) continue;
    if (roomId !== undefined && !peer.rooms.has(roomId)) continue;
    const rooms = [...peer.rooms.keys()];
    out.push({
      alias: peer.alias,
      rooms,
      role: roomId !== undefined ? peer.rooms.get(roomId) : peer.rooms.get(DEFAULT_ROOM),
      since: new Date(peer.connectedAt).toISOString(),
      lastSeenAt: new Date(peer.lastSeenAt).toISOString(),
      reservations: peer.reservations.length > 0 ? [...peer.reservations] : undefined,
      clientVersion: peer.clientVersion,
      activity: peer.activity,
      via: peer.via,
      caps: peer.caps !== undefined && peer.caps.length > 0 ? [...peer.caps] : undefined,
      proto: peer.proto,
    });
  }
  return out;
}
