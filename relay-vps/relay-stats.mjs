#!/usr/bin/env node
// relay-stats: one-screen summary of relay load for root over SSH (/usr/local/bin/relay-stats links here). Node
// without dependencies. Sections:
//   Now               established TCP connections on 80 and 443 (the same `ss` list as relay-watch), sources
//                     grouped like the nftables budgets (IPv4 per address, IPv6 per /64), the top 5, the limits from
//                     /etc/nftables.conf;
//   Peak              highest connection count of today and yesterday (UTC) from the relay-watch state;
//   Firewall rejects  packet counters of the commented drop and reject rules in `table inet relay`, which reset on
//                     every rule load (service start or `nft -f`);
//   Relay             counters from the relay metrics (127.0.0.1:9090), uptime and memory of iroh-relay.service;
//   Traffic           this month's outgoing bytes and the average rate over the relay-watch sample window (up to
//                     about an hour; none when the newest sample is older than 15 min);
//   Access hook       adapter decisions of the last 24 h per src and decision (EndpointId prefixes are not printed).
// A read that fails makes only its own section say "unavailable: <reason>". Exit code 0, or 1 when nothing could be
// read. Parsers and the text are pure functions (tests: relay-vps/test/relay-stats.test.ts); `main` runs commands.

import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CONN_ALERT, LINK_BYTES_PER_S, MONTH_ALERT_BYTES, SS_ARGS, dayOf, forEachLine } from './relay-watch.mjs';

/** Firewall budgets used when /etc/nftables.conf cannot be read (same numbers as relay-vps/nftables.conf). */
export const PER_SOURCE_LIMIT = 50;
export const GLOBAL_LIMIT = 8000;
const TOP = 5;
/** Newest relay-watch sample older than this (cron runs every 5 min) gives no rate. */
const FRESH_MS = 15 * 60_000;
const DAY_MS = 86_400_000;
const METRICS = {
  accepts: 'relayserver_accepts_total',
  disconnects: 'relayserver_disconnects_total',
  bytesSent: 'relayserver_bytes_sent_total',
  bytesRecv: 'relayserver_bytes_recv_total',
  sendDropped: 'relayserver_send_packets_dropped_total',
};

/** Per-source and global concurrent connection limits from the nftables file. */
export function parseLimits(nftConf) {
  const perSource = /\bip saddr ct count over (\d+)/.exec(nftConf)?.[1];
  const global = /^\s*ct count over (\d+)/m.exec(nftConf)?.[1];
  return {
    perSource: perSource === undefined ? PER_SOURCE_LIMIT : Number(perSource),
    global: global === undefined ? GLOBAL_LIMIT : Number(global),
  };
}

/** First four groups of an IPv6 address, as the /64 prefix. */
function prefix64(addr) {
  const groups = (text) => (text === '' ? [] : text.split(':').flatMap((g) => (g.includes('.') ? ['0', '0'] : [g])));
  const cut = addr.indexOf('::');
  let all;
  if (cut === -1) {
    all = groups(addr);
  } else {
    const head = groups(addr.slice(0, cut));
    const tail = groups(addr.slice(cut + 2));
    all = [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail];
  }
  return `${all.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

/** Budget source of a peer `addr:port` from `ss`: IPv4 address (also IPv4-mapped IPv6) or IPv6 /64. */
export function sourceOf(peer) {
  const bracket = /^\[([^\]]+)\]:\d+$/.exec(peer);
  const addr = (bracket ? bracket[1] : peer.replace(/:\d+$/, '')).replace(/%.*$/, '');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  if (mapped) return mapped[1];
  return addr.includes(':') ? prefix64(addr.toLowerCase()) : addr;
}

/** Established connections from `ss -Htn state established`: total and `[source, count]` sorted by count. */
export function parseSs(text) {
  const counts = new Map();
  let total = 0;
  for (const line of text.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    total += 1;
    const source = sourceOf(cols[3]);
    counts.set(source, (counts.get(source) ?? 0) + 1);
  }
  const bySource = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return { total, bySource };
}

/** Packet counters of the commented drop and reject rules from `nft list table`, in listing order. */
export function parseNftCounters(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const m = /\bcounter packets (\d+) bytes \d+ (?:drop|reject)\b.*\bcomment "([^"]*)"/.exec(line);
    if (m) rows.push({ comment: m[2], packets: Number(m[1]) });
  }
  return rows;
}

/** The five relay counters from the metrics text (labelled series summed); a missing counter is null. */
export function parseMetrics(text) {
  const sums = new Map();
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z_:][\w:]*)(?:\{[^}]*\})?\s+(\S+)/.exec(line);
    if (!m) continue;
    const value = Number(m[2]);
    if (Number.isFinite(value)) sums.set(m[1], (sums.get(m[1]) ?? 0) + value);
  }
  return Object.fromEntries(Object.entries(METRICS).map(([key, name]) => [key, sums.get(name) ?? null]));
}

/** `systemctl show` output as key → value. */
export function parseShow(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

/** Empty tally of adapter decisions. */
export function emptyAccessCounts() {
  return { total: 0, byDecision: {}, bySrc: {} };
}

/** Counts one adapter log line (`decision=… src=…`) into `counts`; other lines are skipped. Reads no other field. */
export function countDecision(counts, line) {
  const decision = /\bdecision=([\w-]+)/.exec(line)?.[1];
  const src = /\bsrc=([\w-]+)/.exec(line)?.[1];
  if (decision === undefined || src === undefined) return;
  counts.total += 1;
  counts.byDecision[decision] = (counts.byDecision[decision] ?? 0) + 1;
  const perSrc = (counts.bySrc[src] ??= {});
  perSrc[decision] = (perSrc[decision] ?? 0) + 1;
}

/** Number of reads that succeeded (the limits always have a value and do not count). */
export function readCount(reads) {
  return ['ss', 'state', 'nft', 'nftShow', 'metrics', 'relayShow', 'access']
    .filter((key) => reads[key] && !('error' in reads[key])).length;
}

/** Decimal byte size: two decimals below 10, one above. */
function formatBytes(n) {
  const units = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];
  let value = n;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  if (unit === 0) return `${String(n)} B`;
  return `${value.toFixed(value < 10 ? 2 : 1)} ${units[unit]}`;
}

function formatDuration(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  if (d > 0) return `${String(d)}d ${String(h)}h`;
  if (h > 0) return `${String(h)}h ${String(m)}m`;
  return `${String(m)}m`;
}

const formatTime = (ms) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/** `@<unix seconds>` from `systemctl show --timestamp=unix` as ms; null when empty or unknown. */
function unixStamp(value) {
  const m = /^@(\d+)$/.exec(value ?? '');
  return m ? Number(m[1]) * 1000 : null;
}

const unavailable = (result) => `unavailable: ${String(result.error).replace(/\s+/g, ' ').trim().slice(0, 200)}`;

function nowSection(reads) {
  const { limits } = reads;
  if ('error' in reads.ss) return ['Now', `  ${unavailable(reads.ss)}`];
  const { total, bySource } = parseSs(reads.ss.value);
  const lines = ['Now',
    `  established on :80 and :443: ${String(total)} (limit ${String(limits.global)} globally, `
      + `relay-watch alert above ${String(CONN_ALERT)})`,
    `  sources: ${String(bySource.length)} (IPv4 per address, IPv6 per /64; limit ${String(limits.perSource)} each)`];
  for (const [source, count] of bySource.slice(0, TOP)) lines.push(`  ${String(count).padStart(5)}  ${source}`);
  return lines;
}

function peakSection(reads, nowMs) {
  if ('error' in reads.state) return ['Peak', `  ${unavailable(reads.state)}`];
  const state = reads.state.value;
  const lastRun = typeof state.lastRunMs === 'number'
    ? `last run ${formatDuration(nowMs - state.lastRunMs)} ago` : 'no run yet';
  const peaks = state.connPeaks ?? {};
  const day = (label, key) => {
    const value = peaks[key];
    return `  ${label} ${key}: ${typeof value === 'number' ? String(value) : 'no sample yet'}`;
  };
  return [`Peak (relay-watch, every 5 min; ${lastRun})`, day('today', dayOf(nowMs)),
    day('yesterday', dayOf(nowMs - DAY_MS))];
}

// Counters start at every rule load: a service (re)start, and also `nft -f /etc/nftables.conf`, which flushes the
// ruleset without touching the service. The service start is shown on its own line, not as the counter start.
function firewallSection(reads, nowMs) {
  const lines = ['Firewall rejects (packets since the last rule load)'];
  if ('error' in reads.nftShow) {
    lines.push(`  nftables service ${unavailable(reads.nftShow)}`);
  } else {
    const started = unixStamp(parseShow(reads.nftShow.value).ActiveEnterTimestamp);
    lines.push(started === null ? '  nftables service not active'
      : `  nftables service started ${formatTime(started)}, ${formatDuration(nowMs - started)} ago`);
  }
  if ('error' in reads.nft) return [...lines, `  ${unavailable(reads.nft)}`];
  const rows = parseNftCounters(reads.nft.value);
  if (rows.length === 0) lines.push('  no counted drop or reject rules in table inet relay');
  for (const row of rows) lines.push(`  ${String(row.packets).padStart(8)}  ${row.comment}`);
  return lines;
}

function relaySection(reads, nowMs) {
  const lines = ['Relay (counters since relay start)'];
  if ('error' in reads.relayShow) {
    lines.push(`  service ${unavailable(reads.relayShow)}`);
  } else {
    const unit = parseShow(reads.relayShow.value);
    const since = unixStamp(unit.ActiveEnterTimestamp);
    lines.push(`  iroh-relay ${unit.ActiveState || '?'}`
      + (since === null ? '' : ` since ${formatTime(since)}, up ${formatDuration(nowMs - since)}`));
    const current = Number(unit.MemoryCurrent);
    const max = Number(unit.MemoryMax);
    lines.push(`  memory ${/^\d+$/.test(unit.MemoryCurrent ?? '') ? formatBytes(current) : '?'} of `
      + `${/^\d+$/.test(unit.MemoryMax ?? '') ? formatBytes(max) : (unit.MemoryMax || '?')}`);
  }
  if ('error' in reads.metrics) return [...lines, `  counters ${unavailable(reads.metrics)}`];
  const m = parseMetrics(reads.metrics.value);
  if (Object.values(m).every((value) => value === null)) {
    return [...lines, '  counters unavailable: no relayserver_* counters in the metrics'];
  }
  const num = (value) => (value === null ? '?' : String(value));
  const bytes = (value) => (value === null ? '?' : formatBytes(value));
  return [...lines,
    `  accepts ${num(m.accepts)}, disconnects ${num(m.disconnects)}`,
    `  bytes sent ${bytes(m.bytesSent)}, received ${bytes(m.bytesRecv)}`,
    `  send packets dropped ${num(m.sendDropped)}`];
}

function trafficSection(reads, nowMs) {
  if ('error' in reads.state) return ['Traffic', `  ${unavailable(reads.state)}`];
  const state = reads.state.value;
  const month = new Date(nowMs).toISOString().slice(0, 7);
  const lines = ['Traffic (relay-watch)'];
  lines.push(state.month === month
    ? `  ${month}: ${formatBytes(state.monthBytes)} out (alert at ${String(MONTH_ALERT_BYTES / 1e12)} TB)`
    : `  ${month}: no sample yet`);
  const samples = Array.isArray(state.samples) ? state.samples : [];
  const first = samples[0];
  const last = samples.at(-1);
  const cap = (LINK_BYTES_PER_S * 8) / 1e6;
  if (!first || !last || last[0] <= first[0]) {
    lines.push('  rate: not enough samples');
  } else if (nowMs - last[0] > FRESH_MS) {
    lines.push(`  rate: no recent samples (newest ${formatDuration(nowMs - last[0])} old)`);
  } else {
    // relay-watch keeps up to 70 min of samples; the label names the window actually measured
    const mbit = ((last[1] - first[1]) / ((last[0] - first[0]) / 1000) * 8) / 1e6;
    lines.push(`  last ${formatDuration(last[0] - first[0])}: ${mbit.toFixed(2)} Mbit/s average of the `
      + `${String(cap)} Mbit/s tc cap`);
  }
  return lines;
}

function accessSection(reads) {
  const head = 'Access hook (relay-access, last 24 h)';
  if ('error' in reads.access) return [head, `  ${unavailable(reads.access)}`];
  const counts = reads.access.value;
  if (counts.total === 0) return [head, '  no decisions'];
  const list = (tally) => Object.entries(tally).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([key, n]) => `${key} ${String(n)}`).join(', ');
  const lines = [head, `  ${String(counts.total)} decisions: ${list(counts.byDecision)}`];
  const bySrc = Object.entries(counts.bySrc)
    .map(([src, tally]) => [src, tally, Object.values(tally).reduce((a, b) => a + b, 0)])
    .sort((a, b) => b[2] - a[2] || (a[0] < b[0] ? -1 : 1));
  for (const [src, tally, n] of bySrc) lines.push(`  ${src} ${String(n)} (${list(tally)})`);
  return lines;
}

/**
 * The report text. `reads`: each command's output as `{value}` or `{error}` (`access` holds the decision tally,
 * `state` the parsed relay-watch state); `limits` from `parseLimits`.
 */
export function render(reads, nowMs) {
  const sections = [[`relay-stats ${formatTime(nowMs)}`], nowSection(reads), peakSection(reads, nowMs),
    firewallSection(reads, nowMs), relaySection(reads, nowMs), trafficSection(reads, nowMs), accessSection(reads)];
  return `${sections.map((lines) => lines.join('\n')).join('\n\n')}\n`;
}

/** Output of a command as `{value}`, or `{error}` when it cannot run or exits non-zero. */
function run(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024 * 1024 });
  if (res.error) return { error: `${cmd}: ${res.error.message}` };
  if (res.status !== 0) return { error: `${cmd}: exit ${String(res.status)} ${res.stderr ?? ''}` };
  return { value: res.stdout };
}

function readJson(file) {
  try {
    return { value: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (err) {
    return { error: String(err?.message ?? err) };
  }
}

async function readAccess(nowMs) {
  const counts = emptyAccessCounts();
  try {
    await forEachLine('journalctl', ['-u', 'relay-access.service', '--since',
      `@${String(Math.floor((nowMs - DAY_MS) / 1000))}`, '-o', 'cat', '--no-pager'], (line) => countDecision(counts, line));
    return { value: counts };
  } catch (err) {
    return { error: String(err?.message ?? err) };
  }
}

async function main() {
  const now = Date.now();
  const stateDir = process.env.RELAY_WATCH_STATE_DIR || '/var/lib/relay-watch';
  let nftConf = '';
  try {
    nftConf = readFileSync('/etc/nftables.conf', 'utf8');
  } catch { /* defaults */ }
  const show = (unit, props) => run('systemctl', ['show', unit, '--timestamp=unix', ...props.flatMap((p) => ['-p', p])]);
  const reads = {
    ss: run('ss', SS_ARGS),
    limits: parseLimits(nftConf),
    state: readJson(path.join(stateDir, 'state.json')),
    nft: run('nft', ['-t', 'list', 'table', 'inet', 'relay']),
    nftShow: show('nftables.service', ['ActiveEnterTimestamp']),
    metrics: run('curl', ['-fsS', '--max-time', '5', 'http://127.0.0.1:9090/metrics']),
    relayShow: show('iroh-relay.service', ['ActiveState', 'ActiveEnterTimestamp', 'MemoryCurrent', 'MemoryMax']),
    access: await readAccess(now),
  };
  process.stdout.write(render(reads, now));
  if (readCount(reads) === 0) process.exitCode = 1;
}

// realpath: /usr/local/bin/relay-stats is a symlink, and Node resolves the main module to the real file.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
