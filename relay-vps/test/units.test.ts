/**
 * Jednostki systemd relaya (`relay-vps/*.service`) i pliki, które je spinają: kierunek wiązań (relay nie może
 * zostać martwy po śmierci adaptera), `tc` jako warunek startu, gotowość adaptera przed relayem, limity zasobów
 * i zgodność portu adaptera w trzech plikach. Ścieżki z linii Exec istnieją w repo i w `install.sh`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = path.resolve(import.meta.dirname, '..');
const read = (name: string): string => readFileSync(path.join(DIR, name), 'utf8');

type Unit = Record<string, Record<string, string[]>>;

/** Prosty parser pliku jednostki: sekcja → klucz → wartości (klucz powtórzony dokłada wartość). */
function unit(name: string): Unit {
  const out: Unit = {};
  let section = '';
  for (const raw of read(name).split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const head = /^\[(.+)\]$/.exec(line);
    if (head) {
      section = head[1] ?? '';
      out[section] = {};
      continue;
    }
    const eq = line.indexOf('=');
    const key = line.slice(0, eq);
    const sec = out[section] ?? {};
    (sec[key] ??= []).push(line.slice(eq + 1));
    out[section] = sec;
  }
  return out;
}

/** Lista nazw z wartości typu `After=a b c` (wszystkie wystąpienia klucza). */
const names = (u: Unit, section: string, key: string): string[] =>
  (u[section]?.[key] ?? []).flatMap((value) => value.split(/\s+/)).filter((one) => one !== '');
const one = (u: Unit, section: string, key: string): string | undefined => u[section]?.[key]?.at(-1);

const relay = unit('iroh-relay.service');
const access = unit('relay-access.service');
const tc = unit('relay-tc.service');

describe('iroh-relay.service', () => {
  it('adapter przez Wants= i After=, bez BindsTo= i bez Requires= na adapter (śmierć adaptera nie zatrzymuje relaya)', () => {
    expect(names(relay, 'Unit', 'Wants')).toContain('relay-access.service');
    expect(names(relay, 'Unit', 'After')).toContain('relay-access.service');
    expect(relay.Unit?.BindsTo).toBeUndefined();
    expect(names(relay, 'Unit', 'Requires')).not.toContain('relay-access.service');
  });

  it('tc jest warunkiem startu: Requires= i After= relay-tc.service, ExecStartPre z prawami roota sprawdza qdisc', () => {
    expect(names(relay, 'Unit', 'Requires')).toEqual(['relay-tc.service']);
    expect(names(relay, 'Unit', 'After')).toContain('relay-tc.service');
    expect(relay.Service?.ExecStartPre).toEqual(['+/opt/relay-vps/relay-tc.sh check']);
  });

  it('start tylko z plikiem konfiguracji; restart zawsze; limity zasobów; dziennik bez kolorów; maska 0077', () => {
    expect(one(relay, 'Unit', 'AssertPathExists')).toBe('/etc/iroh-relay/config.toml');
    expect(one(relay, 'Service', 'ExecStart')).toBe('/usr/local/bin/iroh-relay --config-path /etc/iroh-relay/config.toml');
    expect(one(relay, 'Service', 'Restart')).toBe('always');
    expect(one(relay, 'Service', 'LimitNOFILE')).toBe('65536');
    expect(one(relay, 'Service', 'MemoryMax')).toBe('1G');
    expect(one(relay, 'Service', 'TasksMax')).toBe('512');
    expect(relay.Service?.Environment).toContain('NO_COLOR=1');
    expect(one(relay, 'Service', 'UMask')).toBe('0077');
    expect(one(relay, 'Service', 'StateDirectoryMode')).toBe('0700');
    expect(one(relay, 'Service', 'EnvironmentFile')).toBe('/etc/iroh-relay/relay.env');
    expect(one(relay, 'Service', 'User')).toBe('iroh-relay');
    expect(one(relay, 'Install', 'WantedBy')).toBe('multi-user.target');
  });
});

describe('relay-access.service', () => {
  it('BindsTo= i Before= po stronie adaptera (stop relaya zatrzymuje adapter, relay czeka na adapter)', () => {
    expect(names(access, 'Unit', 'BindsTo')).toEqual(['iroh-relay.service']);
    expect(names(access, 'Unit', 'Before')).toEqual(['iroh-relay.service']);
    expect(one(access, 'Service', 'Restart')).toBe('always');
    expect(access.Install).toBeUndefined();
  });

  it('ExecStartPost czeka na port adaptera; port ten sam w access-adapter.conf i w `access.http.url`', () => {
    const post = one(access, 'Service', 'ExecStartPost') ?? '';
    const port = /\/dev\/tcp\/127\.0\.0\.1\/(\d+)\)/.exec(post)?.[1];
    expect(port).toBe('8081');
    expect(post).not.toContain('$');
    expect(read('access-adapter.conf')).toMatch(new RegExp(`^ADAPTER_PORT=${String(port)}$`, 'm'));
    expect(read('access-adapter.conf')).toMatch(/^ADAPTER_HOST=127\.0\.0\.1$/m);
    expect(read('config.toml')).toContain(`url = "http://127.0.0.1:${String(port)}/v1/access"`);
  });

  it('adapter bez sekretu: tylko access-adapter.conf, użytkownik dynamiczny', () => {
    expect(access.Service?.EnvironmentFile).toEqual(['/etc/iroh-relay/access-adapter.conf']);
    expect(one(access, 'Service', 'DynamicUser')).toBe('yes');
    expect(one(access, 'Service', 'ExecStart')).toBe('/usr/bin/node /opt/relay-vps/access-adapter.mjs');
    const keys = read('access-adapter.conf').split('\n').filter((line) => /^\w+=/.test(line))
      .map((line) => line.slice(0, line.indexOf('=')));
    expect(keys).toEqual(['WORKER_URL', 'ADAPTER_HOST', 'ADAPTER_PORT', 'ADAPTER_DEADLINE_MS', 'ADAPTER_NEG_TTL_MS']);
  });
});

describe('relay-tc.service i pliki instalacji', () => {
  it('oneshot z RemainAfterExit=, przed relayem', () => {
    expect(one(tc, 'Service', 'Type')).toBe('oneshot');
    expect(one(tc, 'Service', 'RemainAfterExit')).toBe('yes');
    expect(names(tc, 'Unit', 'Before')).toEqual(['iroh-relay.service']);
    expect(one(tc, 'Service', 'ExecStart')).toBe('/opt/relay-vps/relay-tc.sh apply');
  });

  it('każdy plik z /opt/relay-vps w jednostkach i w cronie ma źródło w relay-vps/ i wpis w install.sh', () => {
    const install = read('install.sh');
    const used = [read('iroh-relay.service'), read('relay-access.service'), read('relay-tc.service'), read('iroh-relay.cron')]
      .flatMap((text) => [...text.matchAll(/\/opt\/relay-vps\/([\w.-]+)/g)].map((m) => m[1] ?? ''));
    expect(new Set(used)).toEqual(new Set(['relay-tc.sh', 'access-adapter.mjs', 'relay-watch.mjs', 'relay-certs-backup.sh']));
    for (const file of used) {
      expect(read(file).length).toBeGreaterThan(0);
      expect(install).toContain(`put "$SRC/${file}" /opt/relay-vps/${file} `);
    }
    for (const [src, dst] of [['iroh-relay.service', '/etc/systemd/system/iroh-relay.service'],
      ['relay-access.service', '/etc/systemd/system/relay-access.service'],
      ['relay-tc.service', '/etc/systemd/system/relay-tc.service'], ['config.toml', '/etc/iroh-relay/config.toml'],
      ['access-adapter.conf', '/etc/iroh-relay/access-adapter.conf'], ['iroh-relay.cron', '/etc/cron.d/iroh-relay'],
      ['nftables.conf', '/etc/nftables.conf'],
      ['journald-relay.conf', '/etc/systemd/journald.conf.d/60-iroh-relay.conf'],
      ['rsyslog-relay.conf', '/etc/rsyslog.d/10-iroh-relay.conf']]) {
      expect(install).toContain(`put "$SRC/${src}" ${dst} `);
    }
  });

  it('install.sh: relay-stats.mjs is copied without a relay restart and linked as /usr/local/bin/relay-stats', () => {
    const install = read('install.sh');
    expect(read('relay-stats.mjs').startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(install).toMatch(/^put "\$SRC\/relay-stats\.mjs" \/opt\/relay-vps\/relay-stats\.mjs 0755$/m);
    // relay-stats imports relay-watch.mjs from the same directory
    expect(read('relay-stats.mjs')).toContain("from './relay-watch.mjs'");
    expect(install).toContain('put "$SRC/relay-watch.mjs" /opt/relay-vps/relay-watch.mjs ');
    expect(install).toContain('ln -sfn /opt/relay-vps/relay-stats.mjs /usr/local/bin/relay-stats');
    expect(install).toMatch(/readlink \/usr\/local\/bin\/relay-stats/);
  });

  it('install.sh: znacznik restartu przed podmianą pliku relaya, usuwany po sprawdzeniu każdej usługi osobno', () => {
    const install = read('install.sh');
    const put = /\nput\(\) \{([\s\S]*?)\n\}/.exec(install)?.[1] ?? '';
    expect(put.indexOf('need_restart')).toBeGreaterThan(-1);
    expect(put.indexOf('need_restart')).toBeLessThan(put.indexOf('install -D'));
    // relay_changed=1 tylko w need_restart (z touch znacznika) i przy odczycie znacznika z przerwanego przebiegu
    expect(install.match(/relay_changed=1/g)).toHaveLength(2);
    expect(install.indexOf('need_restart\n  install -m 0755 "$tmp/iroh-relay"')).toBeGreaterThan(-1);
    // `systemctl is-active a b` daje 0, gdy aktywna jest choć jedna jednostka: sprawdzenie zawsze po jednej
    expect(install).not.toMatch(/systemctl is-active (?:--quiet )?[\w@.-]+\.service [\w@.-]+\.service/);
    const end = install.slice(install.indexOf('failed=()'));
    expect(end.indexOf('exit 1')).toBeGreaterThan(-1);
    expect(end.indexOf('exit 1')).toBeLessThan(end.indexOf('rm -f -- "$PENDING"'));
  });

  it('dziennik relaya i adaptera (IP, skrót EndpointId): journald 7 dni, poza /var/log/syslog', () => {
    expect(read('journald-relay.conf')).toMatch(/^MaxRetentionSec=7day$/m);
    expect(read('journald-relay.conf')).toMatch(/^MaxFileSec=1day$/m);
    expect(one(access, 'Service', 'SyslogIdentifier')).toBe('relay-access');
    expect(read('rsyslog-relay.conf'))
      .toMatch(/^if \$programname == 'iroh-relay' or \$programname == 'relay-access' then stop$/m);
  });

  it('restart po aktualizacji o 04:00', () => {
    const conf = read('unattended-upgrades.conf');
    expect(conf).toContain('Unattended-Upgrade::Automatic-Reboot "true";');
    expect(conf).toContain('Unattended-Upgrade::Automatic-Reboot-Time "04:00";');
  });
});

describe('nftables.conf', () => {
  const nft = read('nftables.conf');
  const input = /chain input \{([\s\S]*?)\n\t\}/.exec(nft)?.[1] ?? '';

  it('SSH tylko z tailnetu, przed limitami relaya; limity na 80/tcp, 443/tcp i 7842/udp', () => {
    const rules = input.split('\n').map((line) => line.trim()).filter((line) => line !== '' && !line.startsWith('#'));
    const tailnet = rules.indexOf('iifname "tailscale0" tcp dport 22 accept');
    const drop = rules.indexOf('tcp dport 22 drop');
    expect(tailnet).toBeGreaterThan(-1);
    expect(drop).toBe(tailnet + 1);
    expect(rules.filter((line) => line.includes('dport 22'))).toHaveLength(2);
    expect(drop).toBeLessThan(rules.findIndex((line) => line.includes('jump relay_tcp')));
    expect(rules).toContain('tcp dport { 80, 443 } ct state new jump relay_tcp');
    expect(rules).toContain('udp dport 7842 ct state new jump relay_udp');
    expect(input).toContain('policy accept;');
  });

  it('limity IPv6 per /64, budżety z decyzji: 10/s i 50 równoczesnych na adres, 8000 i 50/s globalnie', () => {
    expect(nft.match(/ip6 saddr & ffff:ffff:ffff:ffff:: /g)).toHaveLength(3);
    expect(nft).not.toMatch(/ip6 saddr limit|ip6 saddr ct count/);
    expect(nft).toMatch(/ip saddr limit rate over 10\/second burst 10 packets/);
    expect(nft).toMatch(/ip saddr ct count over 50 \}/);
    expect(nft).toMatch(/ip6 saddr & ffff:ffff:ffff:ffff:: ct count over 50 \}/);
    expect(nft).toMatch(/\tct count over 8000 counter reject with tcp reset/);
    expect(nft).toMatch(/\tlimit rate over 50\/second burst 50 packets counter drop/);
  });
});
