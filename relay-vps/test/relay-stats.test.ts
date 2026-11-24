/**
 * `relay-vps/relay-stats.mjs`, the one-screen summary of relay load: parsers of `ss`, `nft`, `/metrics`, the adapter
 * log and `systemctl show`, and the rendered text, where a failed read makes only its own section unavailable.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  countDecision, emptyAccessCounts, parseLimits, parseMetrics, parseNftCounters, parseShow, parseSs, readCount, render,
  sourceOf,
} from '../relay-stats.mjs';
import type { Reads } from '../relay-stats.mjs';
import { emptyState, evaluate } from '../relay-watch.mjs';

const NFT_CONF = readFileSync(path.resolve(import.meta.dirname, '../nftables.conf'), 'utf8');
const NOW = Date.parse('2026-11-13T12:00:00Z');

const SS = [
  '0      0      [::ffff:203.0.113.10]:443   [::ffff:198.51.100.7]:50001',
  '0      0      [::ffff:203.0.113.10]:443   [::ffff:198.51.100.7]:50002',
  '0      0      203.0.113.10:443            198.51.100.7:50003',
  '0      0      [2001:db8:ffff::1]:443      [2001:db8:1:2::a]:40000',
  '0      0      [2001:db8:ffff::1]:443      [2001:db8:1:2:ffff:ffff:ffff:b%eth0]:40001',
  '0      0      [::ffff:203.0.113.10]:443   [::ffff:192.0.2.9]:61000',
  '',
].join('\n');

const NFT = `table inet relay {
	set conn4 {
		type ipv4_addr
		size 65536
		flags dynamic
	}
	chain input {
		type filter hook input priority filter; policy accept;
		iif "lo" accept
		iifname "tailscale0" tcp dport 22 accept
		tcp dport 22 drop
		tcp dport { 80, 443 } ct state new jump relay_tcp
	}
	chain relay_tcp {
		add @rate4 { ip saddr limit rate over 10/second burst 10 packets } counter packets 12 bytes 720 drop comment "na adres 10/s (v4)"
		add @rate6 { ip6 saddr & ffff:ffff:ffff:ffff:: limit rate over 10/second burst 10 packets } counter packets 0 bytes 0 drop comment "na /64 10/s (v6)"
		add @conn4 { ip saddr ct count over 50 } counter packets 3 bytes 180 reject with tcp reset comment "na adres 50 równoczesnych (v4)"
		add @conn6 { ip6 saddr & ffff:ffff:ffff:ffff:: ct count over 50 } counter packets 0 bytes 0 reject with tcp reset comment "na /64 50 równoczesnych (v6)"
		ct count over 8000 counter packets 0 bytes 0 reject with tcp reset comment "globalnie 8000 równoczesnych"
		limit rate over 50/second burst 50 packets counter packets 7 bytes 420 drop comment "globalnie 50/s nowych"
		counter packets 1234 bytes 74040 accept
	}
}
`;

const METRICS = [
  '# HELP relayserver_bytes_sent_total Number of bytes sent.',
  '# TYPE relayserver_bytes_sent_total counter',
  'relayserver_bytes_sent_total 642919',
  'relayserver_bytes_recv_total 672919',
  'relayserver_send_packets_dropped_total 25',
  'relayserver_accepts_total 10',
  'relayserver_disconnects_total 8',
  'relayserver_unique_client_keys_total 4',
  '# EOF',
].join('\n');

const IDS = ['abababab01', 'cdcdcdcd02', 'efefefef03'];
const JOURNAL = [
  'event=listen host=127.0.0.1 port=8081',
  `2026-11-13T11:00:00.000Z decision=allow src=worker id=${IDS[0]} ms=12.1 why=200`,
  `2026-11-13T11:00:01.000Z decision=allow src=worker id=${IDS[0]} ms=11.0 why=200`,
  `2026-11-13T11:00:02.000Z decision=deny src=worker id=${IDS[1]} ms=10.4 why=403`,
  `2026-11-13T11:00:03.000Z decision=deny src=cache id=${IDS[1]} ms=0.1 why=cache`,
  `2026-11-13T11:00:04.000Z decision=allow src=failopen id=${IDS[2]} ms=3001.0 why=fetch:TimeoutError:`,
];

const show = (fields: Record<string, string>): string =>
  Object.entries(fields).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';

function goodReads(): Reads {
  const access = emptyAccessCounts();
  for (const line of JOURNAL) countDecision(access, line);
  return {
    ss: { value: SS },
    limits: parseLimits(NFT_CONF),
    state: {
      value: {
        ...emptyState(), month: '2026-11', monthBytes: 1.25e12, lastRunMs: NOW - 3 * 60_000,
        samples: [[NOW - 63 * 60_000, 0], [NOW - 3 * 60_000, 450e6]],
        connPeaks: { '2026-11-12': 41, '2026-11-13': 17 },
      },
    },
    nft: { value: NFT },
    nftShow: { value: show({ ActiveEnterTimestamp: `@${String((NOW - 2 * 3_600_000) / 1000)}` }) },
    metrics: { value: METRICS },
    relayShow: {
      value: show({ ActiveState: 'active', ActiveEnterTimestamp: `@${String((NOW - 26 * 3_600_000) / 1000)}`,
        MemoryCurrent: '52428800', MemoryMax: '1073741824' }),
    },
    access: { value: access },
  };
}

describe('relay-stats.mjs: parsers', () => {
  it('sources: IPv4 per address (also IPv4-mapped), IPv6 per /64, scope dropped', () => {
    expect(sourceOf('198.51.100.7:50003')).toBe('198.51.100.7');
    expect(sourceOf('[::ffff:198.51.100.7]:50001')).toBe('198.51.100.7');
    expect(sourceOf('[2001:db8:1:2::a]:40000')).toBe('2001:db8:1:2::/64');
    expect(sourceOf('[2001:db8:1:2:ffff:ffff:ffff:b%eth0]:40001')).toBe('2001:db8:1:2::/64');
    expect(sourceOf('[2001:db8::1]:1')).toBe('2001:db8:0:0::/64');
    expect(sourceOf('[::1]:1')).toBe('0:0:0:0::/64');
  });

  it('ss: 3 connections from one IPv4, 2 from one IPv6 /64, 1 other = 6 in total, 3 sources, top 3', () => {
    const now = parseSs(SS);
    expect(now.total).toBe(6);
    expect(now.bySource).toEqual([['198.51.100.7', 3], ['2001:db8:1:2::/64', 2], ['192.0.2.9', 1]]);
  });

  it('limits come from the firewall file: 50 per source, 8000 globally; defaults without the rules', () => {
    expect(parseLimits(NFT_CONF)).toEqual({ perSource: 50, global: 8000 });
    expect(parseLimits('table inet relay {}')).toEqual({ perSource: 50, global: 8000 });
    expect(parseLimits('ip saddr ct count over 20 }\n\tct count over 900 counter reject'))
      .toEqual({ perSource: 20, global: 900 });
  });

  it('nft: the six commented drop and reject rules with packet counters; the accept counter is skipped', () => {
    expect(parseNftCounters(NFT)).toEqual([
      { comment: 'na adres 10/s (v4)', packets: 12 },
      { comment: 'na /64 10/s (v6)', packets: 0 },
      { comment: 'na adres 50 równoczesnych (v4)', packets: 3 },
      { comment: 'na /64 50 równoczesnych (v6)', packets: 0 },
      { comment: 'globalnie 8000 równoczesnych', packets: 0 },
      { comment: 'globalnie 50/s nowych', packets: 7 },
    ]);
  });

  it('nft: every commented drop or reject rule of the repo firewall file is read once counters are listed', () => {
    const listed = NFT_CONF.replace(/\bcounter (drop|reject)/g, 'counter packets 5 bytes 300 $1');
    const rows = parseNftCounters(listed);
    const comments = [...NFT_CONF.matchAll(/counter (?:drop|reject)[^\n]*comment "([^"]*)"/g)].map((m) => m[1]);
    expect(comments.length).toBeGreaterThanOrEqual(6);
    expect(rows).toEqual(comments.map((comment) => ({ comment, packets: 5 })));
  });

  it('metrics: the five relay counters; labelled series are summed; a missing counter is null', () => {
    expect(parseMetrics(METRICS)).toEqual({
      accepts: 10, disconnects: 8, bytesSent: 642919, bytesRecv: 672919, sendDropped: 25,
    });
    expect(parseMetrics('relayserver_accepts_total{a="1"} 2\nrelayserver_accepts_total{a="2"} 3\n')).toEqual({
      accepts: 5, disconnects: null, bytesSent: null, bytesRecv: null, sendDropped: null,
    });
  });

  it('systemctl show: key=value lines', () => {
    expect(parseShow('ActiveState=active\nMemoryMax=infinity\nActiveEnterTimestamp=\n'))
      .toEqual({ ActiveState: 'active', MemoryMax: 'infinity', ActiveEnterTimestamp: '' });
  });

  it('journal: counts per src and per decision; lines without a decision are skipped', () => {
    const counts = emptyAccessCounts();
    for (const line of JOURNAL) countDecision(counts, line);
    countDecision(counts, 'decision=deny src=bad-request id=- ms=0.1');
    expect(counts).toEqual({
      total: 6,
      byDecision: { allow: 3, deny: 3 },
      bySrc: { worker: { allow: 2, deny: 1 }, cache: { deny: 1 }, failopen: { allow: 1 }, 'bad-request': { deny: 1 } },
    });
  });
});

describe('relay-stats.mjs: report', () => {
  it('every section with its numbers and limits', () => {
    const text = render(goodReads(), NOW);
    expect(text).toMatch(/^relay-stats 2026-11-13 12:00 UTC$/m);
    expect(text).toMatch(/^ {2}established on :80 and :443: 6 \(limit 8000 globally, relay-watch alert above 6000\)$/m);
    expect(text).toMatch(/^ {2}sources: 3 \(IPv4 per address, IPv6 per \/64; limit 50 each\)$/m);
    expect(text).toMatch(/^ {6}3 {2}198\.51\.100\.7$/m);
    expect(text).toMatch(/^ {2}today 2026-11-13: 17$/m);
    expect(text).toMatch(/^ {2}yesterday 2026-11-12: 41$/m);
    expect(text).toMatch(/^Firewall rejects \(packets since the last rule load\)$/m);
    expect(text).toMatch(/^ {2}nftables service started 2026-11-13 10:00 UTC, 2h 0m ago$/m);
    expect(text).toMatch(/^ {9}7 {2}globalnie 50\/s nowych$/m);
    expect(text).toMatch(/iroh-relay active since 2026-11-12 10:00 UTC, up 1d 2h/);
    expect(text).toMatch(/^ {2}accepts 10, disconnects 8$/m);
    expect(text).toMatch(/^ {2}bytes sent 642\.9 kB, received 672\.9 kB$/m);
    expect(text).toMatch(/^ {2}send packets dropped 25$/m);
    expect(text).toMatch(/^ {2}memory 52\.4 MB of 1\.07 GB$/m);
    expect(text).toMatch(/^ {2}2026-11: 1\.25 TB out \(alert at 15 TB\)$/m);
    expect(text).toMatch(/^ {2}last 1h 0m: 1\.00 Mbit\/s average of the 100 Mbit\/s tc cap$/m);
    expect(text).toMatch(/^ {2}5 decisions: allow 3, deny 2$/m);
    expect(text).toMatch(/^ {2}worker 3 \(allow 2, deny 1\)$/m);
    expect(text).toMatch(/^ {2}failopen 1 \(allow 1\)$/m);
    expect(readCount(goodReads())).toBe(7);
  });

  it('no adapter id value appears anywhere in the output', () => {
    const text = render(goodReads(), NOW);
    for (const id of IDS) expect(text).not.toContain(id.slice(0, 6));
    expect(text).not.toMatch(/\bid=/);
  });

  it('failed metrics fetch: the relay counters are unavailable, every other section still prints', () => {
    const reads = { ...goodReads(), metrics: { error: 'curl: (7) Failed to connect to 127.0.0.1 port 9090' } };
    const text = render(reads, NOW);
    expect(text).toMatch(/^ {2}counters unavailable: curl: \(7\) Failed to connect/m);
    expect(text).not.toMatch(/accepts \d/);
    expect(text).toMatch(/iroh-relay active since/);
    for (const head of ['Now', 'Peak', 'Firewall rejects', 'Relay', 'Traffic', 'Access hook']) {
      expect(text).toMatch(new RegExp(`^${head}\\b`, 'm'));
    }
    expect(text).toMatch(/established on :80 and :443: 6/);
    expect(readCount(reads)).toBe(6);
  });

  it('nothing could be read: every section says unavailable and the read count is 0', () => {
    const error = { error: 'spawnSync ss ENOENT' };
    const reads: Reads = { ss: error, limits: parseLimits(''), state: error, nft: error, nftShow: error,
      metrics: error, relayShow: error, access: error };
    const text = render(reads, NOW);
    expect(text.match(/unavailable: spawnSync ss ENOENT/g)?.length).toBeGreaterThanOrEqual(6);
    expect(readCount(reads)).toBe(0);
  });

  it('state without peaks or samples of this month: says so instead of numbers', () => {
    const reads = { ...goodReads(), state: { value: { ...emptyState(), month: '2026-10', monthBytes: 9e12 } } };
    const text = render(reads, NOW);
    expect(text).toMatch(/^ {2}today 2026-11-13: no sample yet$/m);
    expect(text).toMatch(/^ {2}2026-11: no sample yet$/m);
    expect(text).toMatch(/^ {2}rate: not enough samples$/m);
  });

  it('firewall: the header does not tie the counters to the nftables service start (nft -f resets them too)', () => {
    const text = render(goodReads(), NOW);
    const head = text.split('\n').find((line) => line.startsWith('Firewall rejects')) ?? '';
    expect(head).not.toMatch(/nftables start|2026-11-13 10:00/);
  });

  it('rate: a 5-minute window is labelled as such, not as the last hour', () => {
    const t = Date.parse('2026-11-13T11:55:00Z');
    const first = evaluate(null, { txBytes: 0, conns: 0, unauthorized: 0 }, t);
    const second = evaluate(first.state, { txBytes: 3.75e9, conns: 0, unauthorized: 0 }, t + 5 * 60_000);
    const text = render({ ...goodReads(), state: { value: second.state } }, NOW);
    expect(text).toMatch(/^ {2}last 5m: 100\.00 Mbit\/s average of the 100 Mbit\/s tc cap$/m);
    expect(text).not.toMatch(/last hour/);
  });

  it('rate: samples older than 15 minutes print no rate', () => {
    const reads = goodReads();
    const text = render(reads, NOW + 48 * 3_600_000);
    expect(text).toMatch(/^ {2}rate: no recent samples \(newest 2d 0h old\)$/m);
    expect(text).not.toMatch(/Mbit\/s average/);
  });

  it('access: a src with a hyphen (bad-request) is printed whole, still without id values', () => {
    const reads = goodReads();
    if ('value' in reads.access) countDecision(reads.access.value, 'decision=deny src=bad-request id=- ms=0.1');
    const text = render(reads, NOW);
    expect(text).toMatch(/^ {2}bad-request 1 \(deny 1\)$/m);
    expect(text).not.toMatch(/^ {2}bad 1/m);
    for (const id of IDS) expect(text).not.toContain(id.slice(0, 6));
    expect(text).not.toMatch(/\bid=/);
  });
});
