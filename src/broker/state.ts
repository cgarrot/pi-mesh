// broker/state.ts — in-memory tables only; presence = live connections.
import type { Socket } from "node:net";
import type { MeshFrame, MeshRole, FileReservation } from "../protocol/envelope.js";

export interface PeerRecord {
  alias: string;
  socket: Socket;
  rooms: Map<string, MeshRole>;
  pid?: number;
  clientVersion?: string;
  connectedAt: number; // ms
  lastSeenAt: number; // ms — updated on every received frame
  helloDone: boolean;
  /** File reservations declared by the peer. Live with the connection. */
  reservations: FileReservation[];
  /** Phase 3: last announced turn state (busy = a turn is running). */
  activity?: { state: "busy" | "idle" | "rate_limited" | "blocked"; at: string };
  /** D40: connection origin — "tcp:<remote-ip>" / "tls:<remote-ip>" for
  *  network peers, undefined for broker-local unix-socket peers. */
  via?: string;
  /** B: routed capabilities (effective caps after proto negotiation). */
  caps?: string[];
  /** B: client protocol version (absent = legacy 1). */
  proto?: number;
}

export interface StoredMsg {
  frame: MeshFrame;
  enqueuedAt: number; // ms
}

export interface TokenBucket {
  tokens: number;
  lastRefillAt: number; // ms
}

export interface PeerRates {
  msg: TokenBucket;
  urgent: TokenBucket;
  force: TokenBucket;
}

export interface BrokerStats {
  startedAt: number; // ms
  relayed: number;
  refused: number;
  mailboxDelivered: number;
  mailboxDropped: number;
}

/** Broker state: 100% memory, rebuilt by re-hello after restart. */
export class BrokerState {
  readonly peers = new Map<string, PeerRecord>();
  readonly rooms = new Map<string, Set<string>>();
  readonly mailbox = new Map<string, StoredMsg[]>();
  readonly rates = new Map<string, PeerRates>();
  /** Aliases seen at least once since broker start (mailbox eligibility).
  *  Map<alias, lastHelloAt> — stale aliases are pruned by the sweep
  *  (no live peer, no mailbox, unseen > 24 h). */
  readonly knownAliases = new Map<string, number>();
  readonly stats: BrokerStats = {
    startedAt: Date.now(),
    relayed: 0,
    refused: 0,
    mailboxDelivered: 0,
    mailboxDropped: 0,
  };
}

export function newBucket(tokens: number): TokenBucket {
  return { tokens, lastRefillAt: Date.now() };
}
