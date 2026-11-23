/** Types of `relay-stats.mjs` for the tests in `relay-vps/test/`. */
import type { WatchState } from './relay-watch.mjs';

/** A read of one command or file: its value, or the reason it failed. */
export type Read<T> = { value: T } | { error: string };

export interface Limits {
  /** Concurrent connections per IPv4 address or IPv6 /64. */
  perSource: number;
  /** Concurrent connections in total. */
  global: number;
}

export interface AccessCounts {
  total: number;
  /** decision → count. */
  byDecision: Record<string, number>;
  /** src → decision → count. */
  bySrc: Record<string, Record<string, number>>;
}

export interface RelayCounters {
  accepts: number | null;
  disconnects: number | null;
  bytesSent: number | null;
  bytesRecv: number | null;
  sendDropped: number | null;
}

export interface Reads {
  /** `ss -Htn state established '( sport = :443 )'`. */
  ss: Read<string>;
  limits: Limits;
  /** relay-watch state file, parsed. */
  state: Read<Partial<WatchState>>;
  /** `nft -t list table inet relay`. */
  nft: Read<string>;
  /** `systemctl show nftables.service` with `ActiveEnterTimestamp` (`--timestamp=unix`). */
  nftShow: Read<string>;
  /** The relay metrics text. */
  metrics: Read<string>;
  /** `systemctl show iroh-relay.service` with ActiveState, ActiveEnterTimestamp, MemoryCurrent, MemoryMax. */
  relayShow: Read<string>;
  /** Adapter decisions of the last 24 h. */
  access: Read<AccessCounts>;
}

export const PER_SOURCE_LIMIT: number;
export const GLOBAL_LIMIT: number;
export function parseLimits(nftConf: string): Limits;
export function sourceOf(peer: string): string;
export function parseSs(text: string): { total: number; bySource: [string, number][] };
export function parseNftCounters(text: string): { comment: string; packets: number }[];
export function parseMetrics(text: string): RelayCounters;
export function parseShow(text: string): Record<string, string>;
export function emptyAccessCounts(): AccessCounts;
export function countDecision(counts: AccessCounts, line: string): void;
export function readCount(reads: Reads): number;
export function render(reads: Reads, nowMs: number): string;
