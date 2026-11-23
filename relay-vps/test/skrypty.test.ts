/**
 * Skrypty powłoki relaya na atrapach narzędzi systemu: `relay-tc.sh` (drzewo qdisc jako warunek startu i strażnik
 * z crona) i `relay-certs-backup.sh` (archiwum cert_dir 0600, cel z argumentu albo z pliku, domyślnie nic nie
 * wychodzi). Atrapy `tc`, `logger`, `systemctl` i `scp` stoją pierwsze w PATH i zapisują wywołania do pliku.
 */
import { spawnSync } from 'node:child_process';
import type { SpawnSyncReturns } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const DIR = path.resolve(import.meta.dirname, '..');
const made: string[] = [];
afterAll(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Katalog z atrapami narzędzi; `calls` zbiera ich wywołania. */
function sandbox(tcQdisc = '', tcClass = '') {
  const base = mkdtempSync(path.join(tmpdir(), 'rarog-relay-skrypty-'));
  made.push(base);
  const bin = path.join(base, 'bin');
  mkdirSync(bin);
  const calls = path.join(base, 'calls.log');
  writeFileSync(path.join(base, 'qdisc.txt'), tcQdisc);
  writeFileSync(path.join(base, 'class.txt'), tcClass);
  const fake = (name: string, body: string): void => {
    writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >>"${calls}"\n${body}\n`, { mode: 0o755 });
  };
  // Atrapa `tc` pokazuje drzewo z plików; ostatni krok `apply` (fq_codel pod 1:10) podmienia je na pełne drzewo.
  writeFileSync(path.join(base, 'qdisc.ok'), QDISC_OK);
  writeFileSync(path.join(base, 'class.ok'), CLASS_OK);
  fake('tc', [
    `case "$1 $2" in`,
    `  "qdisc show") cat "${base}/qdisc.txt" ;;`,
    `  "class show") cat "${base}/class.txt" ;;`,
    `  "qdisc add") case "$*" in *fq_codel*) cp "${base}/qdisc.ok" "${base}/qdisc.txt"; cp "${base}/class.ok" "${base}/class.txt" ;; esac ;;`,
    'esac',
    'exit 0',
  ].join('\n'));
  fake('logger', 'exit 0');
  fake('systemctl', 'exit 0');
  fake('scp', 'exit 0');
  const run = (script: string, args: string[], env: Record<string, string> = {}): SpawnSyncReturns<string> =>
    spawnSync('/bin/bash', [path.join(DIR, script), ...args], {
      encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH ?? ''}`, ...env },
    });
  const log = (): string => {
    try {
      return readFileSync(calls, 'utf8');
    } catch {
      return '';
    }
  };
  return { base, run, log };
}

const QDISC_OK = [
  'qdisc htb 1: root refcnt 2 r2q 10 default 0x10 direct_packets_stat 0 direct_qlen 1000',
  'qdisc fq_codel 10: parent 1:10 limit 10240p flows 1024 quantum 1514 target 5ms interval 100ms memory_limit 32Mb',
].join('\n');
const CLASS_OK = 'class htb 1:10 root leaf 10: prio 0 rate 100Mbit ceil 100Mbit burst 1600b cburst 1600b\n';
const UBUNTU_DEFAULT = 'qdisc fq_codel 0: root refcnt 2 limit 10240p flows 1024 quantum 1514 target 5ms\n';

describe('relay-tc.sh', () => {
  const noConf = { RELAY_TC_CONF: '/nie/ma/tc.conf' };

  it('check: pełne drzewo htb + klasa 100Mbit + fq_codel pod 1:10 = kod 0', () => {
    const s = sandbox(QDISC_OK, CLASS_OK);
    expect(s.run('relay-tc.sh', ['check'], noConf).status).toBe(0);
    expect(s.log()).toContain('tc qdisc show dev eth0');
  });

  it.each([
    ['domyślny fq_codel Ubuntu w roocie', UBUNTU_DEFAULT, '', 'no htb 1: root'],
    ['htb bez fq_codel', QDISC_OK.split('\n')[0] ?? '', CLASS_OK, 'no fq_codel'],
    ['klasa z innym tempem', QDISC_OK, CLASS_OK.replaceAll('100Mbit', '1Gbit'), 'is not 100Mbit'],
  ])('check: %s = kod 1 z powodem', (_name, qdisc, cls, message) => {
    const res = sandbox(qdisc, cls).run('relay-tc.sh', ['check'], noConf);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(message);
  });

  it('interfejs: zmienna, potem linia z tc.conf (czytana, nie wykonywana), potem eth0', () => {
    const s = sandbox(QDISC_OK, CLASS_OK);
    const conf = path.join(s.base, 'tc.conf');
    writeFileSync(conf, `# komentarz\nRELAY_TC_IF=ens3\ntouch ${s.base}/wykonane\n`);
    s.run('relay-tc.sh', ['check'], { RELAY_TC_CONF: conf });
    expect(s.log()).toContain('tc qdisc show dev ens3');
    expect(readdirSync(s.base)).not.toContain('wykonane');
    s.run('relay-tc.sh', ['check'], { RELAY_TC_CONF: conf, RELAY_TC_IF: 'enp1s0' });
    expect(s.log()).toContain('tc qdisc show dev enp1s0');
  });

  it('cron bez drzewa: alert do sysloga i pliku, stop iroh-relay, kod 1; z drzewem nic', () => {
    const bad = sandbox(UBUNTU_DEFAULT, '');
    const alertLog = path.join(bad.base, 'alert.log');
    const res = bad.run('relay-tc.sh', ['cron'], { ...noConf, RELAY_ALERT_LOG: alertLog });
    expect(res.status).toBe(1);
    expect(bad.log()).toMatch(/^logger -t relay-alert -p daemon\.crit ALERT relay-tc: no qdisc on eth0/m);
    expect(bad.log()).toContain('systemctl stop iroh-relay.service');
    expect(readFileSync(alertLog, 'utf8')).toMatch(/^ALERT relay-tc: no qdisc on eth0, stopping iroh-relay/);
    const good = sandbox(QDISC_OK, CLASS_OK);
    expect(good.run('relay-tc.sh', ['cron'], { ...noConf, RELAY_ALERT_LOG: alertLog }).status).toBe(0);
    expect(good.log()).not.toContain('systemctl');
  });

  it('cron bez drzewa: porażka logger i zapisu pliku alertów nie blokuje stopu relaya', () => {
    const s = sandbox(UBUNTU_DEFAULT, '');
    writeFileSync(path.join(s.base, 'bin', 'logger'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const res = s.run('relay-tc.sh', ['cron'], { ...noConf, RELAY_ALERT_LOG: '/dev/null/alert.log' });
    expect(res.status).toBe(1);
    expect(s.log()).toContain('systemctl stop iroh-relay.service');
  });

  it('apply na domyślnym qdisc: kasuje root i zakłada htb, klasę 100mbit i fq_codel', () => {
    const s = sandbox(UBUNTU_DEFAULT, '');
    expect(s.run('relay-tc.sh', ['apply'], noConf).status).toBe(0);
    const calls = s.log().split('\n').filter((line) => /^tc (qdisc|class) (add|del)/.test(line));
    expect(calls).toEqual([
      'tc qdisc del dev eth0 root',
      'tc qdisc add dev eth0 root handle 1: htb default 10',
      'tc class add dev eth0 parent 1: classid 1:10 htb rate 100mbit ceil 100mbit',
      'tc qdisc add dev eth0 parent 1:10 handle 10: fq_codel',
    ]);
  });

  it('apply na pełnym drzewie niczego nie zmienia (htb nie ma operacji change); nieznana komenda = kod 2', () => {
    const s = sandbox(QDISC_OK, CLASS_OK);
    expect(s.run('relay-tc.sh', ['apply'], noConf).status).toBe(0);
    expect(s.log()).not.toMatch(/^tc (qdisc|class) (add|del|replace)/m);
    expect(s.run('relay-tc.sh', ['inne'], noConf).status).toBe(2);
  });
});

describe('relay-certs-backup.sh', () => {
  function withCerts() {
    const s = sandbox();
    const parent = path.join(s.base, 'state');
    mkdirSync(path.join(parent, 'certs'), { recursive: true });
    writeFileSync(path.join(parent, 'certs', 'cached_cert_x'), 'CERT', { mode: 0o600 });
    const env = {
      RELAY_CERT_PARENT: parent, RELAY_BACKUP_DIR: path.join(s.base, 'backups'),
      RELAY_BACKUP_CONF: path.join(s.base, 'backup.conf'), RELAY_ALERT_LOG: path.join(s.base, 'alert.log'),
    };
    return { ...s, env };
  }

  it('bez celu: archiwum lokalne 0600 w katalogu 0700, nic nie wychodzi', () => {
    const s = withCerts();
    const res = s.run('relay-certs-backup.sh', [], s.env);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('no target, nothing sent');
    expect(statSync(path.join(s.env.RELAY_BACKUP_DIR, 'certs.tar')).mode & 0o777).toBe(0o600);
    expect(statSync(s.env.RELAY_BACKUP_DIR).mode & 0o777).toBe(0o700);
    expect(s.log()).not.toContain('scp');
    const list = spawnSync('tar', ['-tf', path.join(s.env.RELAY_BACKUP_DIR, 'certs.tar')], { encoding: 'utf8' });
    expect(list.stdout).toContain('certs/cached_cert_x');
  });

  it('cel lokalny z argumentu: kopia z datą, 0600', () => {
    const s = withCerts();
    const target = path.join(s.base, 'cel');
    mkdirSync(target);
    expect(s.run('relay-certs-backup.sh', [target], s.env).status).toBe(0);
    const [copy] = readdirSync(target);
    expect(copy).toMatch(/^iroh-relay-certs-\d{8}T\d{6}Z\.tar$/);
    expect(statSync(path.join(target, copy ?? '')).mode & 0o777).toBe(0o600);
  });

  it('cel z dwukropkiem z backup.conf idzie przez scp; porażka scp = alert i kod 1', () => {
    const s = withCerts();
    writeFileSync(s.env.RELAY_BACKUP_CONF, '# cel\nRELAY_BACKUP_TARGET=kopia@example.invalid:relay/\n');
    expect(s.run('relay-certs-backup.sh', [], s.env).status).toBe(0);
    expect(s.log()).toMatch(/^scp -q -p -o BatchMode=yes .*certs\.tar kopia@example\.invalid:relay\/iroh-relay-certs-/m);
    writeFileSync(path.join(s.base, 'bin', 'scp'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    expect(s.run('relay-certs-backup.sh', [], s.env).status).toBe(1);
    expect(readFileSync(s.env.RELAY_ALERT_LOG, 'utf8')).toMatch(/^ALERT relay-certs-backup: scp to the target failed/);
  });
});

describe('install.sh: SSH tylko z tailnetu wymaga działającego Tailscale', () => {
  /**
   * Atrapy roota i x86_64; `tailscale` (stan z `status --json`, kod `ip -4`) i `ip` według przypadku; `apt-get` pada,
   * więc przebieg kończy się na kroku 1. PATH to tylko katalog atrap z dowiązaniami do `dirname` i `grep`, więc
   * prawdziwy `tailscale` hosta nie zastąpi atrapy.
   */
  function installRun(tools: { state?: string; ip4?: number; ip?: number }): { r: SpawnSyncReturns<string>; log: string } {
    const base = mkdtempSync(path.join(tmpdir(), 'rarog-relay-install-'));
    made.push(base);
    const bin = path.join(base, 'bin');
    mkdirSync(bin);
    const calls = path.join(base, 'calls.log');
    const fake = (name: string, body: string): void => {
      writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >>"${calls}"\n${body}\n`, { mode: 0o755 });
    };
    fake('id', 'echo 0');
    fake('uname', 'echo x86_64');
    fake('dpkg-query', 'exit 1');
    fake('apt-get', 'exit 1');
    if (tools.state !== undefined) {
      fake('tailscale', [
        'case "$1" in',
        `  status) printf '{\n  "Version": "1.104.7",\n  "BackendState": "${tools.state}",\n}\n' ;;`,
        `  ip) exit ${String(tools.ip4 ?? 0)} ;;`,
        'esac',
      ].join('\n'));
    }
    if (tools.ip !== undefined) fake('ip', `exit ${String(tools.ip)}`);
    for (const tool of ['dirname', 'grep']) {
      const real = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
      symlinkSync(real, path.join(bin, tool));
    }
    const r = spawnSync('/bin/bash', [path.join(DIR, 'install.sh')], { encoding: 'utf8', env: { PATH: bin } });
    let log = '';
    try {
      log = readFileSync(calls, 'utf8');
    } catch {
      // brak wywołań
    }
    return { r, log };
  }

  it.each([
    ['brak programu tailscale', { ip: 0 }],
    ['Tailscale zatrzymany', { state: 'Stopped', ip: 0 }],
    ['Tailscale w stanie Starting (status daje kod 0)', { state: 'Starting', ip: 0 }],
    ['Running bez adresu w tailnecie', { state: 'Running', ip4: 1, ip: 0 }],
    ['brak interfejsu tailscale0', { state: 'Running', ip: 1 }],
  ])('%s: kod 2 przed jakąkolwiek zmianą', (_name, tools) => {
    const { r, log } = installRun(tools);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('tailscale0');
    expect(r.stdout).not.toContain('== 1. packages');
    expect(log).not.toContain('apt-get');
  });

  it('Tailscale działa i tailscale0 jest: instalacja idzie dalej (krok 1)', () => {
    const { r, log } = installRun({ state: 'Running', ip: 0 });
    expect(r.stderr).not.toContain('Tailscale on the VPS is not running');
    expect(r.stdout).toContain('== 1. packages');
    expect(log).toContain('tailscale status --json');
    expect(log).toContain('tailscale ip -4');
    expect(log).toContain('ip link show tailscale0');
    expect(log).toContain('apt-get update');
  });
});
