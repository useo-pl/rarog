/**
 * `rarog setup`, transport (`setup-transport.ts`): iroh when the native module is there (with the server key in the
 * secrets file, under one lock with `config.json`), the server address from `tailscale status` on a port of the pool
 * 8931–8960, and step 4, `tailscale serve --bg --https=<P>`, which maps only an unmapped and free pool port, after a
 * question, for an address taken in this run; `--tailscale`, which adds that address to an existing `config.json`
 * without one. Runs on the shared harness (`helpers/setup-harness.ts`).
 */
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { CONFIG_WRITES } from '../src/cli/config-rewrite.ts';
import type { ConfigWrites } from '../src/cli/config-rewrite.ts';
import { main } from '../src/cli/main.ts';
import { configFileText } from '../src/cli/serve.ts';
import type { SetupDeps, TcpProbe } from '../src/cli/setup-context.ts';
import { DEFAULT_IROH_RELAY } from '../src/cli/setup.ts';
import {
  FAKE_IROH_KEY, FAKE_SECRET, HAS_CHECKOUT, IROH_INTEL, KEY_LINE, TS_HOST, TS_IPS, bin, calls,
  checkoutOnly, configDir, configFile, env, home, listenHerdr, otherMappings, runSetup, secretFile, serveMappings, state,
  summaryLine, t, tailscaleStatus, treeHash, useSetupHarness, write, writeConfig, writeServeStatus,
} from './helpers/setup-harness.ts';
import type { Question } from './helpers/setup-harness.ts';
import { IS_MAC, macOnly } from './platform.ts';

useSetupHarness();

// ---------------------------------------------------------------------------
// tailscale serve
// ---------------------------------------------------------------------------

describe.skipIf(!IS_MAC)(macOnly('rarog setup: tailscale serve', 'launchd'), () => {
  beforeEach(() => { mkdirSync(path.join(home, 'Projects')); });

  /** Odpowiedzi „t” tylko do planu (config.json) i do tailscale. */
  const answer = (q: Question): string | null => (q === 'continue' || q === 'tailscale' ? 't' : 'n');

  it('no iroh module and tailscale status fails: neither config.json nor a key is written, the message says tailscale up', async () => {
    writeFileSync(path.join(state, 'status-err'), 'Tailscale is stopped.\n');
    const run = await runSetup({ answer, deps: { irohModule: () => IROH_INTEL } });
    expect(existsSync(configFile())).toBe(false);
    expect(existsSync(secretFile())).toBe(false);
    expect(summaryLine(run.stdout, 'tailscale status')).toMatch(/PROBLEM .*Tailscale is stopped\..*tailscale up/);
    // Read before the plan (the refusal check) and again after its question (the address).
    expect(calls('tailscale')).toEqual(['status --json', 'status --json']);
  });

  it('pusty serve status (także pusty napis): pytanie i tailscale serve --bg --https=8931 <port>', async () => {
    writeFileSync(path.join(state, 'serve-status'), '');
    const run = await runSetup({ answer });
    expect(run.asked).toContain('tailscale');
    // Step 2 picks the port, step 4 reads the state before and after its question; the last serve status: exit 0
    // counts only with the mapping in place.
    expect(calls('tailscale')).toEqual(['status --json', 'serve status --json', 'serve status --json',
      'serve status --json', 'serve --bg --https=8931 8930', 'serve status --json']);
    expect(summaryLine(run.stdout, 'tailscale serve')).toMatch(/ok {7}tailscale serve: mapping to port 8930/);
  });

  it('błąd tailscale serve --bg: komunikat dosłownie, linia po linii', async () => {
    const stderr = 'Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.example.com/f/serve?node=abc\n';
    writeFileSync(path.join(state, 'serve-err'), stderr);
    const run = await runSetup({ answer });
    for (const text of stderr.trimEnd().split('\n').filter((one) => one.trim() !== '')) expect(run.stdout).toContain(text);
    expect(summaryLine(run.stdout, 'tailscale serve --bg')).toMatch(/PROBLEM .*failed/);
    expect(run.code).toBe(1);
  });

  it('tailscale serve --bg fails on the step screen: one sentence, Fix: serve status, its message in the run log', async () => {
    writeFileSync(path.join(state, 'serve-err'), 'Serve is not enabled on your tailnet.\nTo enable, visit:\n\n'
      + '         https://login.example.com/f/serve?node=abc\n');
    const run = await runSetup({ answer, verbose: false });
    const lines = run.stdout.split('\n');
    // The harness prints a question without its answer, so the step line can follow it on the same line.
    const at = lines.findIndex((line) => line.includes('[4/10] '));
    expect(lines[at]?.replace(/^.*?(?=\[4\/10\] )/u, ''), run.stdout)
      .toMatch(/^\[4\/10\] FAIL {4}Tailscale: tailscale serve --bg --https=8931 8930 failed( \(\S+\))?$/u);
    // A reason setup does not recognise points at the state, not at the command that failed.
    expect(lines[at + 1]).toBe('   Fix: tailscale serve status, then rarog setup');
    // Tailscale's own message goes to the run log, which the Log: line names.
    const log = /^ {3}Log: ~\/(\S+)$/u.exec(lines[at + 2] ?? '')?.[1] ?? '';
    expect(readFileSync(path.join(home, log), 'utf8')).toContain('https://login.example.com/f/serve?node=abc');
    expect(run.stdout).not.toContain('message above');
  });

  it('istniejące mapowanie na nasz port: ok, bez pytania i bez serve --bg', async () => {
    writeConfig({ RAROG_ORIGINS: `https://${TS_HOST}`, RAROG_PORT: '8931' });
    writeServeStatus(serveMappings([[443, 8931]]));
    const run = await runSetup({ answer });
    expect(run.asked).not.toContain('tailscale');
    expect(calls('tailscale')).toEqual(['serve status --json']);
    expect(summaryLine(run.stdout, 'tailscale serve')).toMatch(/ok {7}tailscale serve: mapping to port 8931/);
  });

  it('obce mapowanie: PROBLEM, setup go nie rusza', async () => {
    writeConfig({ RAROG_ORIGINS: `https://${TS_HOST}`, RAROG_PORT: '8931' });
    writeFileSync(path.join(state, 'serve-status'),
      JSON.stringify({ Web: { [`${TS_HOST}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } }));
    const run = await runSetup({ answer });
    expect(run.asked).not.toContain('tailscale');
    expect(calls('tailscale')).toEqual(['serve status --json']);
    expect(summaryLine(run.stdout, 'tailscale serve')).toMatch(/PROBLEM .*foreign mapping/);
  });

  for (const [name, mapping] of [
    ['inna ścieżka', { [`${TS_HOST}:443`]: { Handlers: { '/inna': { Proxy: 'http://127.0.0.1:8931' } } } }],
    ['inny host', { 'inny.example.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8931' } } } }],
    ['port z tym samym początkiem', { [`${TS_HOST}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:89310' } } } }],
  ] as const) {
    it(`nasz backend pod złym adresem (${name}): PROBLEM, bez serve --bg`, async () => {
      writeConfig({ RAROG_ORIGINS: `https://${TS_HOST}`, RAROG_PORT: '8931' });
      writeFileSync(path.join(state, 'serve-status'), JSON.stringify({ TCP: { 443: { HTTPS: true } }, Web: mapping }));
      const run = await runSetup({ answer });
      expect(run.asked).not.toContain('tailscale');
      expect(calls('tailscale')).toEqual(['serve status --json']);
      expect(summaryLine(run.stdout, 'tailscale serve')).toMatch(/PROBLEM .*foreign mapping/);
    });
  }

  for (const odd of ['[]', '42', 'false', 'null']) {
    it(`serve status ${odd} (nieznany kształt): PROBLEM, bez pytania i bez serve --bg`, async () => {
      writeConfig({ RAROG_ORIGINS: `https://${TS_HOST}:8931`, RAROG_PORT: '8930' });
      writeFileSync(path.join(state, 'serve-status'), odd);
      const run = await runSetup({ answer });
      expect(run.asked).not.toContain('tailscale');
      expect(calls('tailscale').some((line) => line.startsWith('serve --bg'))).toBe(false);
      expect(summaryLine(run.stdout, 'tailscale serve')).toMatch(/PROBLEM .*state unknown/);
    });
  }

  it('mapowanie na wybranym porcie pojawiło się w trakcie pytania: bez serve --bg', async () => {
    const run = await runSetup({
      answer: (q) => {
        if (q === 'tailscale') writeServeStatus(serveMappings([[8931, 3000]]));
        return answer(q);
      },
    });
    expect(run.asked).toContain('tailscale');
    expect(calls('tailscale'))
      .toEqual(['status --json', 'serve status --json', 'serve status --json', 'serve status --json']);
    expect(summaryLine(run.stdout, 'tailscale serve')).toMatch(/PROBLEM .*changed meanwhile/);
  });

  describe('an address with a pool port already in config.json', () => {
    beforeEach(() => { writeConfig({ RAROG_ORIGINS: `https://${TS_HOST}:8931`, RAROG_PORT: '8930' }); });

    it('(h) the other mappings on 3000 and no 8931: MISSING with Fix: tailscale serve --bg --https=8931 <port>', async () => {
      writeServeStatus(serveMappings([[3000, 3000]]));
      const run = await runSetup({ answer, verbose: false });
      expect(run.asked).not.toContain('tailscale');
      expect(calls('tailscale')).toEqual(['serve status --json']);
      const lines = run.stdout.split('\n');
      const at = lines.findIndex((one) => one.includes('[4/10] '));
      expect(lines[at]?.replace(/^.*?(?=\[4\/10\] )/u, ''), run.stdout)
        .toMatch(/^\[4\/10\] warn {4}Tailscale: no mapping to this server$/u);
      expect(lines[at + 1]).toBe('   Fix: tailscale serve --bg --https=8931 8930');
    });

    it('(i) 8931 points elsewhere: PROBLEM foreign mapping, no question and no serve', async () => {
      writeServeStatus(serveMappings([...otherMappings(), [8931, 3000]]));
      const run = await runSetup({ answer });
      expect(run.asked).not.toContain('tailscale');
      expect(calls('tailscale')).toEqual(['serve status --json']);
      expect(summaryLine(run.stdout, 'tailscale serve'))
        .toMatch(/PROBLEM .*foreign mapping; check tailscale serve status, then tailscale serve --bg --https=8931 8930/);
    });

    it('8931 ours among the seven other mappings: ok, no question and no serve', async () => {
      writeServeStatus(serveMappings([...otherMappings(), [8931, 8930]]));
      const run = await runSetup({ answer });
      expect(run.asked).not.toContain('tailscale');
      expect(calls('tailscale')).toEqual(['serve status --json']);
      expect(run.stdout).toContain(`mapping ${TS_HOST}:8931 → port 8930: present`);
      expect(summaryLine(run.stdout, 'tailscale serve')).toMatch(/ok {7}tailscale serve: mapping to port 8930/);
    });
  });

  describe('(k) an address without a port in config.json: port 443 alone decides', () => {
    beforeEach(() => { writeConfig({ RAROG_ORIGINS: `https://${TS_HOST}`, RAROG_PORT: '8930' }); });

    it('ours on 443 among the seven other mappings: ok', async () => {
      writeServeStatus(serveMappings([...otherMappings(), [443, 8930]]));
      const run = await runSetup({ answer });
      expect(calls('tailscale')).toEqual(['serve status --json']);
      expect(summaryLine(run.stdout, 'tailscale serve')).toMatch(/ok {7}tailscale serve: mapping to port 8930/);
    });

    for (const [name, mappings] of [
      ['the seven other mappings', otherMappings()],
      ['our backend on another HTTPS port', [[8443, 8930]]],
    ] as const) {
      it(`no mapping on 443, ${name}: MISSING with Fix: tailscale serve --bg <port>, not foreign`, async () => {
        writeServeStatus(serveMappings(mappings));
        const run = await runSetup({ answer });
        expect(run.asked).not.toContain('tailscale');
        expect(calls('tailscale')).toEqual(['serve status --json']);
        expect(summaryLine(run.stdout, 'tailscale serve')).toMatch(/MISSING .*tailscale serve: tailscale serve --bg 8930$/);
      });
    }

    it('443 mapped elsewhere among the seven other mappings: PROBLEM foreign mapping', async () => {
      writeServeStatus(serveMappings([...otherMappings(), [443, 3000]]));
      const run = await runSetup({ answer });
      expect(calls('tailscale')).toEqual(['serve status --json']);
      expect(summaryLine(run.stdout, 'tailscale serve'))
        .toMatch(/PROBLEM .*foreign mapping; check tailscale serve status, then tailscale serve --bg 8930$/);
    });
  });

  it('--public-url is gone: unknown argument, code 64, nothing written', async () => {
    let stderr = '';
    const code = await main(['setup', '--public-url', 'https://rarog.example.net'], {
      stdout: () => {}, stderr: (text) => { stderr += text; }, env: env(), cwd: t.home,
    });
    expect(code).toBe(64);
    expect(stderr).toContain('unknown argument "--public-url"');
    expect(existsSync(configDir())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Transport: iroh and Tailscale
// ---------------------------------------------------------------------------

describe.skipIf(!IS_MAC)(macOnly('rarog setup: transport iroh and Tailscale', 'launchd'), () => {
  beforeEach(() => { mkdirSync(path.join(home, 'Projects')); });

  /** "y" only to the plan (config.json) and to the iroh key in step 3, "n" to the rest. */
  const configOnly = (q: Question): string | null => (q === 'continue' || q === 'key' ? 't' : 'n');
  const configJson = (): { env: Record<string, string> } =>
    JSON.parse(readFileSync(configFile(), 'utf8')) as { env: Record<string, string> };
  /** The key's value from the secrets file (the test checks with it that setup never prints it). */
  const keyIn = (): string => KEY_LINE.exec(readFileSync(secretFile(), 'utf8'))?.[1] ?? 'no key';
  const withoutTailscale = (): void => { rmSync(path.join(bin, 'tailscale')); };
  /** The PID of a process that has exited (a killed setup's lock carries one). */
  const deadPid = async (): Promise<number> => {
    const child = spawn('true');
    await new Promise((resolve) => { child.on('exit', resolve); });
    return child.pid ?? 0;
  };

  it('iroh module and tailscale in PATH: key in a new secrets file, config with iroh and the Tailscale address', async () => {
    const run = await runSetup({ answer: configOnly });
    expect(configJson().env).toMatchObject({
      RAROG_ORIGINS: `https://${TS_HOST}:8931`, RAROG_IROH: '1', RAROG_IROH_RELAY: DEFAULT_IROH_RELAY,
    });
    // The UDP port stays with the port the system gives: a firewall rule is up to the machine's owner, not to setup.
    expect(configJson().env).not.toHaveProperty('RAROG_IROH_PORT');
    expect(readFileSync(secretFile(), 'utf8')).toMatch(/^RAROG_IROH_KEY=[0-9a-f]{64}\n$/);
    expect(run.stdout).not.toContain(keyIn());
    expect(run.stdout).toContain(`transport iroh: RAROG_IROH=1, relay ${DEFAULT_IROH_RELAY}`);
    expect(run.stdout).toContain(`RAROG_IROH_KEY is created in ${secretFile()}`);
    expect(run.stdout).toContain('transport Tailscale: RAROG_ORIGINS from tailscale status');
    expect(calls('tailscale')[0]).toBe('status --json');
    expect(summaryLine(run.stdout, 'config.json')).toMatch(/^ {2}ok {7}.*config\.json: created$/);
    expect(existsSync(path.join(configDir(), 'lock'))).toBe(false);
  });

  it('iroh module without tailscale: config without RAROG_ORIGINS, tools complete, step 4 not used', async () => {
    withoutTailscale();
    const run = await runSetup({ answer: configOnly });
    expect(configJson().env).toMatchObject({ RAROG_IROH: '1', RAROG_IROH_RELAY: DEFAULT_IROH_RELAY });
    expect(configJson().env).not.toHaveProperty('RAROG_ORIGINS');
    expect(run.stdout).toContain('no tailscale in PATH: no HTTPS address (RAROG_ORIGINS); the app connects over iroh');
    expect(summaryLine(run.stdout, 'tools:')).toMatch(/^ {2}ok {7}tools: all present$/);
    expect(summaryLine(run.stdout, 'tailscale serve')).toMatch(/^ {2}info {5}tailscale serve: not used \(iroh only\)$/);
    expect(run.stdout).not.toContain(keyIn());
  });

  it('Intel (no native module) with tailscale: Tailscale only, no RAROG_IROH and no secrets file', async () => {
    const run = await runSetup({ answer: configOnly, deps: { irohModule: () => IROH_INTEL } });
    expect(configJson().env).toMatchObject({ RAROG_ORIGINS: `https://${TS_HOST}:8931` });
    expect(Object.keys(configJson().env).filter((name) => name.startsWith('RAROG_IROH'))).toEqual([]);
    expect(existsSync(path.dirname(secretFile()))).toBe(false);
    expect(run.stdout).toContain('iroh: no native module on this machine');
    expect(run.stdout).not.toContain('transport iroh');
  });

  it('Intel without tailscale: MISSING tailscale in the tools, no config.json question and no write', async () => {
    withoutTailscale();
    const before = treeHash(home);
    const run = await runSetup({ answer: null, deps: { irohModule: () => IROH_INTEL } });
    expect(run.stdout).toContain('MISSING tailscale — this machine has no iroh native module');
    expect(treeHash(home)).toEqual(before);
    expect(run.code).toBe(1);
  });

  it('own relay: --iroh-relay goes into RAROG_IROH_RELAY in the canonical form', async () => {
    const run = await runSetup({ answer: configOnly, argv: ['--iroh-relay', 'https://Relay.Example.org:443'] });
    expect(configJson().env['RAROG_IROH_RELAY']).toBe('https://relay.example.org/');
    expect(run.stdout).toContain('transport iroh: RAROG_IROH=1, relay https://relay.example.org/');
  });

  it('--iroh-relay without the iroh module: a warning, config with Tailscale only', async () => {
    const run = await runSetup({
      answer: configOnly, argv: ['--iroh-relay', 'https://relay.example.org'], deps: { irohModule: () => IROH_INTEL },
    });
    expect(run.stdout).toContain('WARNING: --iroh-relay ignored: no iroh native module on this machine');
    expect(Object.keys(configJson().env).filter((name) => name.startsWith('RAROG_IROH'))).toEqual([]);
  });

  it('--iroh-relay invalid or given twice: usage, code 64, nothing written', async () => {
    for (const argv of [['--iroh-relay', 'http://relay.example.org'], ['--iroh-relay', 'https://relay.example.org/x'],
      ['--iroh-relay'], ['--iroh-relay', 'https://a.example.org', '--iroh-relay', 'https://b.example.org']]) {
      let stderr = '';
      const code = await main(['setup', ...argv], {
        stdout: () => {}, stderr: (text) => { stderr += text; }, env: env(), cwd: t.home,
      });
      expect(code, argv.join(' ')).toBe(64);
      expect(stderr).toContain('--iroh-relay');
    }
    expect(existsSync(configDir())).toBe(false);
  });

  it('existing config.json without iroh: unchanged, no key; --iroh-relay ignored with a sentence', async () => {
    writeConfig({ RAROG_ORIGINS: `https://${TS_HOST}` });
    const before = readFileSync(configFile(), 'utf8');
    const run = await runSetup({ answer: configOnly, argv: ['--iroh-relay', 'https://relay.example.org'] });
    expect(readFileSync(configFile(), 'utf8')).toBe(before);
    expect(existsSync(path.dirname(secretFile()))).toBe(false);
    expect(run.stdout).not.toContain('config and server key');
    expect(run.asked).not.toContain('key');
    expect(run.stdout).toContain('--iroh-relay ignored: config.json exists and setup does not change its relay');
  });

  it('setup killed after the key, before config.json: the retry takes over the dead lock and keeps that key', async () => {
    // What a killed setup leaves: the key in the secrets file, no config.json, and its lock (the `finally` that
    // releases it never ran) with the PID of a process that is gone.
    write(secretFile(), `SONIOX_API_KEY=${FAKE_SECRET}\nRAROG_IROH_KEY=${FAKE_IROH_KEY}\n`, 0o600);
    chmodSync(path.dirname(secretFile()), 0o700);
    const lock = path.join(configDir(), 'lock');
    write(lock, `${String(await deadPid())}\n`, 0o600);
    const before = readFileSync(secretFile(), 'utf8');
    const run = await runSetup({ answer: configOnly });
    expect(readFileSync(secretFile(), 'utf8')).toBe(before);
    expect(configJson().env).toMatchObject({ RAROG_IROH: '1', RAROG_IROH_RELAY: DEFAULT_IROH_RELAY });
    expect(summaryLine(run.stdout, 'config.json')).toMatch(/^ {2}ok {7}.*config\.json: created$/);
    expect(existsSync(lock)).toBe(false);
    expect(run.stdout).toContain(`RAROG_IROH_KEY is already in ${secretFile()} and stays`);
    expect(run.stdout).not.toContain(FAKE_IROH_KEY);
    expect(run.stdout).not.toContain(FAKE_SECRET);
  });

  it('key of the wrong shape: PROBLEM without the value in the message, no config.json, file unchanged', async () => {
    const bad = 'bad-key-0123456789';
    write(secretFile(), `RAROG_IROH_KEY=${bad}\n`, 0o600);
    chmodSync(path.dirname(secretFile()), 0o700);
    const run = await runSetup({ answer: configOnly });
    expect(existsSync(configFile())).toBe(false);
    expect(readFileSync(secretFile(), 'utf8')).toBe(`RAROG_IROH_KEY=${bad}\n`);
    expect(summaryLine(run.stdout, 'config.json')).toMatch(/PROBLEM .*RAROG_IROH_KEY .*is not 64 hex characters/);
    expect(run.stdout).not.toContain(bad);
  });

  for (const [name, empty] of [['empty', ''], ['only white space', '  \t']] as const) {
    it(`line RAROG_IROH_KEY= (${name}): the key goes into that line, the rest of the file byte for byte`, async () => {
      write(secretFile(), `# a\nRAROG_IROH_KEY=${empty}\r\nSONIOX_API_KEY=${FAKE_SECRET}`, 0o600);
      chmodSync(path.dirname(secretFile()), 0o700);
      const run = await runSetup({ answer: configOnly });
      expect(readFileSync(secretFile(), 'utf8'))
        .toMatch(new RegExp(`^# a\\nRAROG_IROH_KEY=[0-9a-f]{64}\\r\\nSONIOX_API_KEY=${FAKE_SECRET}$`));
      expect(configJson().env).toMatchObject({ RAROG_IROH: '1', RAROG_IROH_RELAY: DEFAULT_IROH_RELAY });
      expect(summaryLine(run.stdout, 'config.json')).toMatch(/^ {2}ok {7}.*config\.json: created$/);
      expect(run.stdout).not.toContain(keyIn());
      expect(run.stdout).not.toContain(FAKE_SECRET);
    });
  }

  it('lock held by another live process: PROBLEM with its PID, no key and no config.json', async () => {
    const lock = path.join(configDir(), 'lock');
    write(lock, `${String(process.ppid)}\n`, 0o600);
    const run = await runSetup({ answer: configOnly });
    expect(run.asked).toContain('continue');
    expect(existsSync(configFile())).toBe(false);
    expect(existsSync(path.dirname(secretFile()))).toBe(false);
    expect(summaryLine(run.stdout, 'config.json'))
      .toMatch(new RegExp(`PROBLEM .*rarog setup: another call is running \\(PID ${String(process.ppid)}`));
    expect(readFileSync(lock, 'utf8')).toBe(`${String(process.ppid)}\n`);
  });

  describe('config.json with RAROG_IROH=1 and no key (step 3)', () => {
    beforeEach(() => { writeConfig({ RAROG_IROH: '1', RAROG_IROH_RELAY: DEFAULT_IROH_RELAY }); });

    it('"y": the key in a new secrets file, step ok, config.json unchanged', async () => {
      const before = readFileSync(configFile(), 'utf8');
      const run = await runSetup({ answer: configOnly });
      expect(run.asked).toContain('key');
      expect(readFileSync(secretFile(), 'utf8')).toMatch(/^RAROG_IROH_KEY=[0-9a-f]{64}\n$/);
      expect(readFileSync(configFile(), 'utf8')).toBe(before);
      expect(summaryLine(run.stdout, 'private.env')).toMatch(/^ {2}ok {7}\/.*private\.env: present$/);
      expect(run.stdout).not.toContain(keyIn());
    });

    it('"n": MISSING with the command, nothing written and no service question', async () => {
      const run = await runSetup({ answer: (q) => (q === 'key' ? 'n' : configOnly(q)) });
      expect(run.asked).toContain('key');
      expect(existsSync(path.dirname(secretFile()))).toBe(false);
      expect(summaryLine(run.stdout, 'RAROG_IROH_KEY')).toMatch(/MISSING .*RAROG_IROH_KEY missing: run rarog setup/);
      expect(run.installs).toBe(0);
    });

    it('without a terminal: no question and no write, MISSING', async () => {
      const before = treeHash(home);
      const run = await runSetup({ answer: null });
      expect(treeHash(home)).toEqual(before);
      expect(summaryLine(run.stdout, 'RAROG_IROH_KEY')).toMatch(/MISSING .*RAROG_IROH_KEY missing: run rarog setup/);
    });

    it('with service.wrapper: the secrets manager supplies the key, no question', async () => {
      writeConfig({ RAROG_IROH: '1', RAROG_IROH_RELAY: DEFAULT_IROH_RELAY }, ['/opt/secrets/bin/run', '--']);
      const run = await runSetup({ answer: configOnly });
      expect(run.asked).not.toContain('key');
      expect(existsSync(path.dirname(secretFile()))).toBe(false);
      expect(run.stdout).toContain('skipped: service.wrapper from config.json supplies the secrets');
    });
  });
});

// ---------------------------------------------------------------------------
// Transport before config.json: the Tailscale port from the pool 8931–8960
// ---------------------------------------------------------------------------

describe.skipIf(!IS_MAC)(macOnly('rarog setup: the Tailscale port from the pool 8931–8960', 'launchd'), () => {
  beforeEach(async () => {
    mkdirSync(path.join(home, 'Projects'));
    await listenHerdr(path.join(home, '.config', 'herdr', 'herdr.sock'));
  });

  /** "y" to the plan and to tailscale serve, "n" to the rest (no hook copy, so no git checkout needed). */
  const answer = (q: Question): string | null => (q === 'continue' || q === 'tailscale' ? 't' : 'n');
  const configJson = (): { env: Record<string, string> } =>
    JSON.parse(readFileSync(configFile(), 'utf8')) as { env: Record<string, string> };
  const served = (): string[] => calls('tailscale').filter((call) => call.startsWith('serve --bg'));
  /** Each TCP probe as `<address>:<port>`. */
  const probes: string[] = [];
  beforeEach(() => { probes.length = 0; });
  /** TCP probe per `<address>:<port>`: the given answer (`hang` = never answers), `refused` elsewhere; records each. */
  const tcpOn = (answers: Readonly<Record<string, TcpProbe | 'hang'>> = {}): Pick<SetupDeps, 'tcpProbe'> => ({
    tcpProbe: (host: string, port: number) => {
      const at = `${host}:${String(port)}`;
      probes.push(at);
      const said = answers[at] ?? 'refused';
      return said === 'hang' ? new Promise<TcpProbe>(() => {}) : Promise.resolve(said);
    },
  });
  /** `lsof -F pcn` output: one listener this user can see, on `address` (`<ip>:<port>`, `*:<port>`). */
  const listener = (pid: number, name: string, address: string): void => {
    writeFileSync(path.join(state, 'lsof-out'), `p${String(pid)}\nc${name}\nf7\nn${address}\n`);
  };

  for (const [name, mappings] of [
    ['other mappings on 3000 and 8899', [[3000, 3000], [8899, 8899]]],
    ['the seven measured mappings', otherMappings()],
  ] as const) {
    it(`(a) ${name}, 8931 free: https://<host>:8931, serve --bg --https=8931 8930 after the question, the others kept`, async () => {
      writeServeStatus(serveMappings(mappings));
      const run = await runSetup({ answer, deps: tcpOn() });
      expect(configJson().env).toMatchObject({ RAROG_ORIGINS: `https://${TS_HOST}:8931`, RAROG_IROH: '1' });
      expect(run.stdout).toContain(`server address: https://${TS_HOST}:8931`);
      expect(run.asked).toContain('tailscale');
      expect(served()).toEqual(['serve --bg --https=8931 8930']);
      expect(summaryLine(run.stdout, 'tailscale serve')).toMatch(/ok {7}tailscale serve: mapping to port 8930/);
      // The fake client adds the mapping to the others, as the client does.
      expect(JSON.parse(readFileSync(path.join(state, 'serve-status'), 'utf8')))
        .toEqual(serveMappings([...mappings, [8931, 8930]]));
    });
  }

  it.skipIf(!HAS_CHECKOUT)(checkoutOnly('iroh, a free pool port, tailscale: iroh and the Tailscale address, serve after the question, code 0'), async () => {
    const run = await runSetup({ deps: tcpOn() });
    expect(configJson().env).toMatchObject({ RAROG_ORIGINS: `https://${TS_HOST}:8931`, RAROG_IROH: '1' });
    expect(run.asked).toContain('tailscale');
    expect(served()).toEqual(['serve --bg --https=8931 8930']);
    expect(run.code).toBe(0);
  });

  it('(b) 8931 in TCP, 8932 in Foreground, 8933 accepts on a Tailscale IP, 8934 silent: 8935; lsof names 8933', async () => {
    writeServeStatus({
      TCP: { 8931: { TCPForward: '127.0.0.1:22' } },
      Foreground: { 'session-1': serveMappings([[8932, 8930]]) },
    });
    listener(4242, 'caddy', `${TS_IPS[0]}:8933`);
    const run = await runSetup({
      answer, deps: tcpOn({ [`${TS_IPS[0]}:8933`]: 'listening', [`${TS_IPS[1]}:8934`]: 'unknown' }),
    });
    expect(configJson().env).toMatchObject({ RAROG_ORIGINS: `https://${TS_HOST}:8935` });
    expect(served()).toEqual(['serve --bg --https=8935 8930']);
    expect(run.stdout).toContain('mapped: 8931, 8932; in use: 8933 (caddy (PID 4242)); not checked: 8934');
    // A mapped port is not probed.
    expect(probes.filter((one) => /:893[12]$/u.test(one))).toEqual([]);
  });

  it('(b) a probe that never answers: its port not checked after the one deadline, the next port taken', async () => {
    const run = await runSetup({ answer, deps: tcpOn({ [`${TS_IPS[1]}:8931`]: 'hang' }) });
    expect(configJson().env).toMatchObject({ RAROG_ORIGINS: `https://${TS_HOST}:8932` });
    expect(run.stdout).toContain('not checked: 8931');
    expect(served()).toEqual(['serve --bg --https=8932 8930']);
  });

  it('(b) a Tailscale address silent on every pool port (own IPv6 on macOS): the ports go by the other one', async () => {
    const silent: Record<string, 'hang'> = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`${TS_IPS[1]}:${String(8931 + i)}`, 'hang'] as const));
    const run = await runSetup({ answer, deps: tcpOn({ ...silent, [`${TS_IPS[0]}:8931`]: 'listening' }) });
    expect(configJson().env).toMatchObject({ RAROG_ORIGINS: `https://${TS_HOST}:8932` });
    expect(served()).toEqual(['serve --bg --https=8932 8930']);
    expect(run.stdout).not.toMatch(/not checked: |port 8932 not checked/u);
    expect(run.stdout).toContain(`Tailscale address ${TS_IPS[1]} answered no probe; the ports go by ${TS_IPS[0]}`);
  });

  it('(b) every Tailscale address silent on every port: no port checked, nothing written', async () => {
    const silent: Record<string, 'hang'> = Object.fromEntries(TS_IPS.flatMap((ip) =>
      Array.from({ length: 30 }, (_, i) => [`${ip}:${String(8931 + i)}`, 'hang'] as const)));
    const run = await runSetup({ answer, deps: tcpOn(silent) });
    expect(run.stdout).toContain('30 not checked');
    expect(served()).toEqual([]);
  });

  it('(c) a listener on loopback only on 8931: 8931 free; the probes go to the Tailscale IPs only, all at once', async () => {
    listener(4242, 'node', '127.0.0.1:8931');
    let inFlight = 0;
    let most = 0;
    const run = await runSetup({
      answer,
      deps: {
        tcpProbe: async (host: string, port: number) => {
          probes.push(`${host}:${String(port)}`);
          inFlight += 1;
          most = Math.max(most, inFlight);
          await new Promise((resolve) => { setImmediate(resolve); });
          inFlight -= 1;
          return host === '127.0.0.1' || host === '::1' ? 'listening' : 'refused';
        },
      },
    });
    expect(configJson().env).toMatchObject({ RAROG_ORIGINS: `https://${TS_HOST}:8931` });
    expect(served()).toEqual(['serve --bg --https=8931 8930']);
    expect(run.stdout).not.toContain('tailscale serve ports skipped');
    expect(new Set(probes.map((one) => one.replace(/:[0-9]+$/u, '')))).toEqual(new Set(TS_IPS));
    // Step 2 probes the 30 pool ports on both Tailscale IPs together.
    expect(most).toBe(60);
  });

  it('(c) no lsof and every probe refused: 8931 free, no other question', async () => {
    rmSync(path.join(bin, 'lsof'));
    const run = await runSetup({ answer, deps: tcpOn() });
    expect(configJson().env).toMatchObject({ RAROG_ORIGINS: `https://${TS_HOST}:8931` });
    expect(run.asked).not.toContain('inne');
    expect(served()).toEqual(['serve --bg --https=8931 8930']);
  });

  for (const [name, proxy] of [['127.0.0.1', 'http://127.0.0.1:8930'], ['localhost', 'http://localhost:8930/']] as const) {
    it(`(d) 8940 ours (proxy on ${name}) next to the seven others, 8931 free: https://<host>:8940, no serve`, async () => {
      writeServeStatus(serveMappings([...otherMappings(), [8940, proxy]]));
      const run = await runSetup({ answer, deps: tcpOn() });
      expect(configJson().env).toMatchObject({ RAROG_ORIGINS: `https://${TS_HOST}:8940` });
      expect(run.asked).not.toContain('tailscale');
      expect(served()).toEqual([]);
      expect(probes).toEqual([]);
      expect(summaryLine(run.stdout, 'tailscale serve')).toMatch(/ok {7}tailscale serve: mapping to port 8930/);
    });
  }

  for (const [name, status] of [
    ['mapped with --http, no HTTPS', { TCP: { 8940: { HTTP: true } }, Web: serveMappings([[8940, 8930]]).Web }],
    ['a second handler', {
      TCP: { 8940: { HTTPS: true } },
      Web: {
        [`${TS_HOST}:8940`]: {
          Handlers: { '/': { Proxy: 'http://127.0.0.1:8930' }, '/x': { Proxy: 'http://127.0.0.1:3000' } },
        },
      },
    }],
    ['no TCP entry', { Web: serveMappings([[8940, 8930]]).Web }],
    ['another host on the same port', {
      TCP: { 8940: { HTTPS: true } },
      Web: { ...serveMappings([[8940, 8930]]).Web, ...serveMappings([[8940, 3000]], 'inny.example.ts.net').Web },
    }],
  ] as const) {
    it(`(d) 8940 with our backend but ${name}: foreign, not probed, so 8931`, async () => {
      writeServeStatus(status);
      await runSetup({ answer, deps: tcpOn() });
      expect(configJson().env).toMatchObject({ RAROG_ORIGINS: `https://${TS_HOST}:8931` });
      expect(probes.filter((one) => one.endsWith(':8940'))).toEqual([]);
      expect(served()).toEqual(['serve --bg --https=8931 8930']);
    });
  }

  it('(e) ours on 443, 8931 free: the address without a port, no serve', async () => {
    writeServeStatus(serveMappings([...otherMappings(), [443, 8930]]));
    const run = await runSetup({ answer, deps: tcpOn() });
    expect(configJson().env).toMatchObject({ RAROG_ORIGINS: `https://${TS_HOST}` });
    expect(run.asked).not.toContain('tailscale');
    expect(served()).toEqual([]);
    expect(probes).toEqual([]);
    expect(summaryLine(run.stdout, 'tailscale serve')).toMatch(/ok {7}tailscale serve: mapping to port 8930/);
  });

  it('(e) ours on 443 and on 8945: the pool port first', async () => {
    writeServeStatus(serveMappings([[443, 8930], [8945, 8930]]));
    await runSetup({ answer, deps: tcpOn() });
    expect(configJson().env).toMatchObject({ RAROG_ORIGINS: `https://${TS_HOST}:8945` });
    expect(served()).toEqual([]);
  });

  /** The whole pool: 8931 and 8932 mapped by others, 8933 silent on one Tailscale IP, every other port accepts. */
  const poolTaken = (): Pick<SetupDeps, 'tcpProbe'> => {
    writeServeStatus(serveMappings([...otherMappings(), [8931, 3000], [8932, 3001]]));
    return {
      tcpProbe: (host: string, port: number) => {
        if (port !== 8933) return Promise.resolve('listening');
        return Promise.resolve(host === TS_IPS[1] ? 'unknown' : 'refused');
      },
    };
  };
  const NO_PORT = 'no free port in 8931–8960 for tailscale serve: 2 mapped, 27 in use, 1 not checked';

  it('(f) the whole pool taken, with iroh: iroh only, the reason in the Tailscale step, no serve', async () => {
    const run = await runSetup({ answer, deps: poolTaken() });
    expect(configJson().env).toMatchObject({ RAROG_IROH: '1' });
    expect(configJson().env).not.toHaveProperty('RAROG_ORIGINS');
    expect(run.asked).not.toContain('tailscale');
    expect(served()).toEqual([]);
    expect(summaryLine(run.stdout, 'tailscale serve'))
      .toBe(`  info     tailscale serve: not used (iroh only; ${NO_PORT})`);
  });

  it('(f) the whole pool taken, without the iroh module: refusal, no transport, no config.json, code 1', async () => {
    const run = await runSetup({ answer, deps: { ...poolTaken(), irohModule: () => IROH_INTEL } });
    expect(existsSync(configFile())).toBe(false);
    expect(existsSync(path.dirname(secretFile()))).toBe(false);
    expect(served()).toEqual([]);
    expect(summaryLine(run.stdout, 'no free port')).toMatch(new RegExp(`PROBLEM .*${NO_PORT}; no transport`, 'u'));
    expect(run.code).toBe(1);
  });

  it('(g) tailscale serve status fails: iroh only, the whole pool not checked, no probe', async () => {
    writeFileSync(path.join(state, 'serve-status-err'), 'serve config unavailable\n');
    const run = await runSetup({ answer, deps: tcpOn() });
    expect(configJson().env).not.toHaveProperty('RAROG_ORIGINS');
    expect(probes).toEqual([]);
    expect(served()).toEqual([]);
    expect(run.stdout).toContain('tailscale serve status --json: serve config unavailable');
    expect(summaryLine(run.stdout, 'tailscale serve')).toContain('0 mapped, 0 in use, 30 not checked)');
  });

  it('no Tailscale IP in tailscale status: the whole pool not checked, iroh only', async () => {
    writeFileSync(path.join(state, 'status-json'), JSON.stringify(tailscaleStatus({}, { TailscaleIPs: [] })));
    const run = await runSetup({ answer, deps: tcpOn() });
    expect(configJson().env).not.toHaveProperty('RAROG_ORIGINS');
    expect(probes).toEqual([]);
    expect(summaryLine(run.stdout, 'tailscale serve')).toContain('0 mapped, 0 in use, 30 not checked)');
  });

  for (const [now, said] of [
    ['listening', 'port 8931 is in use; free it, then tailscale serve --bg --https=8931 8930'],
    ['unknown', 'port 8931 not checked; check who listens on port 8931, then tailscale serve --bg --https=8931 8930'],
  ] as const) {
    it(`(j) 8931 free in step 2, ${now} on a Tailscale IP right before serve: PROBLEM, no serve`, async () => {
      let after: TcpProbe = 'refused';
      const run = await runSetup({
        deps: {
          tcpProbe: (host: string, port: number) =>
            Promise.resolve(port === 8931 && host === TS_IPS[0] ? after : 'refused'),
        },
        answer: (q) => {
          if (q === 'tailscale') after = now;
          return answer(q);
        },
      });
      expect(run.asked).toContain('tailscale');
      expect(configJson().env).toMatchObject({ RAROG_ORIGINS: `https://${TS_HOST}:8931` });
      expect(served()).toEqual([]);
      expect(summaryLine(run.stdout, 'tailscale serve')).toBe(`  PROBLEM  tailscale serve: ${said}`);
      expect(run.code).toBe(1);
    });
  }

  it.skipIf(!HAS_CHECKOUT)(checkoutOnly('iroh and tailscale status fails: iroh without an address, info line, code 0'), async () => {
    writeFileSync(path.join(state, 'status-err'), 'Tailscale is stopped.\n');
    const run = await runSetup();
    expect(configJson().env).toMatchObject({ RAROG_IROH: '1' });
    expect(configJson().env).not.toHaveProperty('RAROG_ORIGINS');
    expect(served()).toEqual([]);
    expect(run.stdout).toContain('Tailscale is stopped.');
    expect(summaryLine(run.stdout, 'tailscale serve')).toMatch(/^ {2}info {5}tailscale serve: not used \(iroh only; tailscale status --json: Tailscale is stopped\./);
    expect(run.code).toBe(0);
  });

  it.skipIf(!HAS_CHECKOUT)(checkoutOnly('iroh without tailscale: iroh only, code 0 (as before)'), async () => {
    rmSync(path.join(bin, 'tailscale'));
    const run = await runSetup();
    expect(configJson().env).toMatchObject({ RAROG_IROH: '1' });
    expect(configJson().env).not.toHaveProperty('RAROG_ORIGINS');
    expect(calls('tailscale')).toEqual([]);
    expect(run.code).toBe(0);
  });

  it.skipIf(!HAS_CHECKOUT)(checkoutOnly('no iroh module, 8931 free, tailscale: Tailscale only, serve, code 0'), async () => {
    const run = await runSetup({ deps: { irohModule: () => IROH_INTEL } });
    expect(configJson().env).toMatchObject({ RAROG_ORIGINS: `https://${TS_HOST}:8931` });
    expect(configJson().env).not.toHaveProperty('RAROG_IROH');
    expect(served()).toEqual(['serve --bg --https=8931 8930']);
    expect(run.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tailscale says why: the state from `tailscale status --json`, HTTPS off, serve without a mapping
// ---------------------------------------------------------------------------

describe.skipIf(!IS_MAC)(macOnly('rarog setup: Tailscale says why', 'launchd'), () => {
  beforeEach(() => { mkdirSync(path.join(home, 'Projects')); });

  /** "y" to the plan and to tailscale serve, "n" to the rest (no hook copy, so no git checkout needed). */
  const answer = (q: Question): string | null => (q === 'continue' || q === 'tailscale' ? 't' : 'n');
  const statusJson = (json: unknown): void => { writeFileSync(path.join(state, 'status-json'), JSON.stringify(json)); };
  const served = (): boolean => calls('tailscale').some((call) => call.startsWith('serve --bg'));
  const configEnv = (): Record<string, string> =>
    (JSON.parse(readFileSync(configFile(), 'utf8')) as { env: Record<string, string> }).env;
  /** The step line of a run without a terminal and without `--verbose`: `[4/10] <status> Tailscale: <result>`. */
  const tailscaleLine = (stdout: string): string =>
    stdout.split('\n').find((one) => one.includes('[4/10] '))?.replace(/^.*?(?=\[4\/10\] )/u, '') ?? '(no [4/10] line)';
  /** The run log the `Log:` line under the step names. */
  const runLog = (stdout: string): string => {
    const name = /^ {3}Log: ~\/(\S+)$/mu.exec(stdout)?.[1];
    return name === undefined ? '(no Log: line)' : readFileSync(path.join(home, name), 'utf8');
  };
  const SERVE_FIX = '   Fix: tailscale serve status, then rarog setup';
  const HTTPS_FIX = 'Fix: enable HTTPS in the Tailscale admin console, then tailscale serve --bg --https=8931 8930';
  /** The `Fix:` under the `[4/10]` line, its wrapped prose lines joined. */
  const fixOf = (stdout: string): string => {
    const lines = stdout.split('\n');
    const after = lines.slice(lines.findIndex((one) => one.includes('[4/10] ')) + 1);
    const end = after.findIndex((one, index) => !(index === 0 ? one.startsWith('   Fix: ') : /^ {5,}\S/u.test(one)));
    return after.slice(0, end).map((one) => one.trim()).join(' ');
  };

  for (const [backend, said] of [
    ['NeedsLogin', 'logged out'], ['NeedsMachineAuth', 'logged out'], ['Stopped', 'stopped'],
  ] as const) {
    it(`BackendState ${backend}: – Tailscale ${said} (iroh only), no address, no serve`, async () => {
      // The DNS name stays in the status of a stopped client: the state decides, not the name.
      statusJson(tailscaleStatus({ BackendState: backend }));
      const run = await runSetup({ answer, verbose: false });
      expect(tailscaleLine(run.stdout), run.stdout)
        .toMatch(new RegExp(`^\\[4/10\\] skip +Tailscale: ${said} \\(iroh only\\)`, 'u'));
      expect(configEnv()).toMatchObject({ RAROG_IROH: '1' });
      expect(configEnv()).not.toHaveProperty('RAROG_ORIGINS');
      expect(calls('tailscale')).toEqual(['status --json']);
    });
  }

  it('the daemon does not answer (status fails): – Tailscale not running (iroh only)', async () => {
    writeFileSync(path.join(state, 'status-err'),
      'failed to connect to local tailscaled; it doesn\'t appear to be running\n');
    const run = await runSetup({ answer, verbose: false });
    expect(tailscaleLine(run.stdout), run.stdout).toMatch(/^\[4\/10\] skip +Tailscale: not running \(iroh only\)/u);
    expect(configEnv()).not.toHaveProperty('RAROG_ORIGINS');
    expect(served()).toBe(false);
  });

  for (const [name, fields, self] of [
    ['no https key in Self.CapMap', {}, { CapMap: { 'https://tailscale.com/cap/funnel-ports?ports=443': null } }],
    ['CertDomains empty', { CertDomains: [] }, {}],
    ['CertDomains null', { CertDomains: null }, {}],
    // `CapMap` is `omitempty` in the client's PeerStatus: empty `CertDomains` alone is proof enough.
    ['CertDomains null, no Self.CapMap', { CertDomains: null }, { CapMap: undefined }],
  ] as const) {
    it(`HTTPS off in the tailnet (${name}): ✗ in one sentence with Fix:, no serve and no serve question`, async () => {
      statusJson(tailscaleStatus(fields, self));
      const run = await runSetup({ answer, verbose: false });
      expect(tailscaleLine(run.stdout), run.stdout).toMatch(/^\[4\/10\] FAIL +Tailscale: HTTPS is off in your tailnet$/u);
      expect(fixOf(run.stdout)).toBe(HTTPS_FIX);
      expect(run.asked).not.toContain('tailscale');
      expect(served()).toBe(false);
      // The address stays in config.json: once HTTPS is on, the mapping needs only tailscale serve.
      expect(configEnv()).toMatchObject({ RAROG_ORIGINS: `https://${TS_HOST}:8931` });
      expect(run.code).toBe(1);
    });
  }

  it('HTTPS off, then on and the Fix: command run: the next setup has no ✗ Tailscale', async () => {
    statusJson(tailscaleStatus({ CertDomains: [] }));
    const first = await runSetup({ answer, verbose: false });
    expect(fixOf(first.stdout)).toBe(HTTPS_FIX);
    // HTTPS on in the tailnet, then the command from Fix: as the user runs it.
    statusJson(tailscaleStatus());
    const command = /then (tailscale serve --bg --https=[0-9]+ [0-9]+)$/u.exec(HTTPS_FIX)?.[1]?.split(' ') ?? [];
    expect(spawnSync(path.join(bin, command[0] ?? ''), command.slice(1), { env: env() }).status).toBe(0);
    const second = await runSetup({ answer, verbose: false });
    expect(second.stdout).not.toMatch(/\[4\/10\] FAIL/u);
    expect(second.stdout).not.toContain('HTTPS is off');
    expect(second.asked).not.toContain('tailscale');
  });

  it('the address comes from tailscale status read after the plan, not before it (Intel Mac in a terminal)', async () => {
    const next = 'rarog-next.example.ts.net';
    const run = await runSetup({
      verbose: false, terminal: { tty: true, columns: 60, color: false }, deps: { irohModule: () => IROH_INTEL },
      answer: (q) => {
        // The client moves to another tailnet while the plan question waits.
        if (q === 'continue') statusJson(tailscaleStatus({}, { DNSName: `${next}.` }));
        return q === 'continue' ? 't' : 'n';
      },
    });
    expect(run.asked).toContain('continue');
    expect(configEnv()).toMatchObject({ RAROG_ORIGINS: `https://${next}:8931` });
  });

  it('an older client without BackendState, CertDomains and Self.CapMap: no new diagnosis, serve as before', async () => {
    statusJson(tailscaleStatus({ BackendState: undefined, CertDomains: undefined }, { CapMap: undefined }));
    const run = await runSetup({ answer, verbose: false });
    expect(run.asked).toContain('tailscale');
    expect(served()).toBe(true);
    expect(tailscaleLine(run.stdout), run.stdout).toMatch(/^\[4\/10\] ok +Tailscale: /u);
  });

  it('serve --bg exits 0 without the mapping (the enable address on stdout): ✗, Fix: serve status, stdout in the log', async () => {
    writeFileSync(path.join(state, 'serve-out'), 'Serve is not enabled on your tailnet.\nTo enable, visit:\n\n'
      + '         https://login.example.com/f/serve?node=abc\n');
    writeFileSync(path.join(state, 'serve-noop'), '');
    const run = await runSetup({ answer, verbose: false });
    expect(served()).toBe(true);
    expect(tailscaleLine(run.stdout), run.stdout).toMatch(/^\[4\/10\] FAIL +Tailscale: /u);
    expect(run.stdout).toContain(SERVE_FIX);
    expect(runLog(run.stdout)).toContain('https://login.example.com/f/serve?node=abc');
    expect(run.code).toBe(1);
  });

  it('serve --bg exits 1 with its reason on stdout: the reason in the log, Fix: serve status, not the failed command', async () => {
    writeFileSync(path.join(state, 'serve-out'), 'error: listener already exists for port 443\n');
    writeFileSync(path.join(state, 'serve-code'), '1');
    const run = await runSetup({ answer, verbose: false });
    expect(tailscaleLine(run.stdout), run.stdout)
      .toMatch(/^\[4\/10\] FAIL +Tailscale: tailscale serve --bg --https=8931 8930 failed$/u);
    expect(run.stdout).toContain(SERVE_FIX);
    expect(runLog(run.stdout)).toContain('error: listener already exists for port 443');
    expect(run.code).toBe(1);
  });

  it('serve --bg waits (for the feature to be enabled) past the timeout: the same ✗, its stdout in the log', async () => {
    writeFileSync(path.join(state, 'serve-out'), 'To enable, visit: https://login.example.com/f/serve?node=abc\n');
    writeFileSync(path.join(state, 'serve-hang'), '');
    const run = await runSetup({ answer, verbose: false, deps: { tailscaleTimeoutMs: 2000 } });
    expect(tailscaleLine(run.stdout), run.stdout).toMatch(/^\[4\/10\] FAIL +Tailscale: tailscale serve --bg --https=8931 8930 /u);
    expect(run.stdout).toContain(SERVE_FIX);
    expect(runLog(run.stdout)).toContain('https://login.example.com/f/serve?node=abc');
    expect(run.code).toBe(1);
  });

  for (const [backend, name, fix] of [
    ['NeedsLogin', 'logged-in', 'log in to Tailscale'], ['Stopped', 'running', 'start Tailscale'],
  ] as const) {
    it(`an Intel Mac, Tailscale ${backend}, first setup in a terminal: refusal before the plan, nothing written`, async () => {
      statusJson(tailscaleStatus({ BackendState: backend }));
      const before = treeHash(home);
      const run = await runSetup({
        answer, verbose: false, terminal: { tty: true, columns: 60, color: false },
        deps: { irohModule: () => IROH_INTEL },
      });
      const said = run.stdout.replace(/\s+/gu, ' ');
      expect(run.code, run.stdout).toBe(1);
      expect(run.asked).toEqual([]);
      expect(said).toContain(`Rarog cannot run without a ${name} Tailscale; nothing changed.`);
      expect(said).toContain(`Fix: ${fix} (tailscale up); then rarog setup`);
      expect(treeHash(home)).toEqual(before);
      expect(calls('tailscale')).toEqual(['status --json']);
    });
  }

  it('an Intel Mac, Tailscale logged out, without a terminal: no refusal before the plan, nothing written', async () => {
    statusJson(tailscaleStatus({ BackendState: 'NeedsLogin' }));
    const run = await runSetup({ answer: null, verbose: false, deps: { irohModule: () => IROH_INTEL } });
    expect(run.stdout).not.toContain('cannot run without');
    expect(existsSync(configFile())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// rarog setup --tailscale: the Tailscale address for an existing config.json without one
// ---------------------------------------------------------------------------

describe.skipIf(!IS_MAC)(macOnly('rarog setup --tailscale', 'launchd'), () => {
  beforeEach(async () => {
    mkdirSync(path.join(home, 'Projects'));
    await listenHerdr(path.join(home, '.config', 'herdr', 'herdr.sock'));
  });

  /** "y" to the plan and to tailscale serve, "n" to the rest (no hook copy, so no git checkout needed). */
  const answer = (q: Question): string | null => (q === 'continue' || q === 'tailscale' ? 't' : 'n');
  const FLAG = ['--tailscale'];
  // The retry command of this installation (the clone's form in tests).
  const RETRY = 'node bin/rarog.mjs setup --tailscale';
  const ADDRESS = `https://${TS_HOST}:8931`;
  const WRAPPER = ['/opt/secrets/bin/run', '--'];
  const IROH_ONLY = { RAROG_IROH: '1', RAROG_IROH_RELAY: DEFAULT_IROH_RELAY };
  const served = (): string[] => calls('tailscale').filter((call) => call.startsWith('serve --bg'));
  const configText = (): string => readFileSync(configFile(), 'utf8');
  const tmpFiles = (): string[] => readdirSync(configDir()).filter((name) => name.endsWith('.tmp'));
  /** `config.json` in the layout setup writes, with the service wrapper (so step 3 asks for no key). */
  const setupText = (values: Record<string, string>): string =>
    configFileText({ version: 1, env: values, service: { wrapper: WRAPPER } });
  const setupConfig = (values: Record<string, string>): string => {
    const text = setupText(values);
    write(configFile(), text, 0o600);
    return text;
  };
  /** The product's write steps, `meanwhile` run right after the temporary file is created. */
  const writesWith = (meanwhile: () => void, rename: ConfigWrites['rename'] = CONFIG_WRITES.rename): ConfigWrites => ({
    create: (file, bytes, fileMode) => {
      CONFIG_WRITES.create(file, bytes, fileMode);
      meanwhile();
    },
    rename,
  });

  it('no config.json: the usual first setup with the address; a line that the flag adds nothing', async () => {
    const run = await runSetup({ answer, argv: FLAG });
    expect((JSON.parse(configText()) as { env: Record<string, string> }).env)
      .toMatchObject({ RAROG_ORIGINS: ADDRESS, RAROG_IROH: '1' });
    expect(run.stdout).toContain('--tailscale adds nothing: no config.json yet');
    expect(served()).toEqual(['serve --bg --https=8931 8930']);
    expect(run.stdout).not.toContain('devices revoke --all');
  });

  it('config.json with an address: "already has an address", nothing written, no plan item', async () => {
    const before = setupConfig({ RAROG_ORIGINS: 'https://rarog.example.org', ...IROH_ONLY });
    const run = await runSetup({ answer, argv: FLAG });
    expect(run.stdout).toContain('config.json already has an address (https://rarog.example.org); --tailscale adds'
      + ' nothing.');
    expect(configText()).toBe(before);
    expect(run.stdout).not.toContain('Tailscale address in config.json');
    expect(calls('tailscale')).toEqual([]);
    expect(run.stdout).not.toContain('The server reads the new address at start');
  });

  for (const [name, origins, kept] of [
    ['missing', undefined, ''],
    ['empty', '', ''],
    ['blank', '  \t', ''],
    ['only commas', ' , ,', ''],
    ['only entries the server skips', 'rarog.example.org,ftp://x.example.org', ',rarog.example.org,ftp://x.example.org'],
  ] as const) {
    it(`RAROG_ORIGINS ${name}: the plan item, "y" adds the address in front, the rest byte for byte, mode 0600`,
      async () => {
        const values: Record<string, string> = origins === undefined
          ? { ...IROH_ONLY } : { ...IROH_ONLY, RAROG_ORIGINS: origins };
        setupConfig(values);
        const run = await runSetup({ answer, argv: FLAG });
        expect(run.stdout).toMatch(/Tailscale address in config\.json\s+https:\/\/rarog-test\.example\.ts\.net:8931/u);
        // Only RAROG_ORIGINS changes; every other key and `service` keep their bytes.
        expect(configText()).toBe(setupText({ ...values, RAROG_ORIGINS: `${ADDRESS}${kept}` }));
        expect(lstatSync(configFile()).mode & 0o777).toBe(0o600);
        expect(tmpFiles()).toEqual([]);
        expect(served()).toEqual(['serve --bg --https=8931 8930']);
        expect(summaryLine(run.stdout, 'tailscale serve'))
          .toBe(`  ok       tailscale serve: address ${ADDRESS} added to config.json; mapping to port 8930`);
      });
  }

  it('a missing key: the address is added at the end of env, every line before it unchanged', async () => {
    const before = setupConfig({ ...IROH_ONLY });
    await runSetup({ answer, argv: FLAG });
    expect(configText().replace(`,\n    "RAROG_ORIGINS": "${ADDRESS}"`, '')).toBe(before);
  });

  it('the step screen: Tailscale changed, the restart note and the note for paired devices', async () => {
    setupConfig({ ...IROH_ONLY });
    const run = await runSetup({ answer, argv: FLAG, verbose: false });
    const said = run.stdout.replace(/\s+/gu, ' ');
    expect(said).toMatch(/\[4\/10\] ok +Tailscale: address added; mapping to port 8930/u);
    expect(said).toContain('The server reads the new address at start: run ');
    // The command of this installation (`rarog` from a package, `node bin/rarog.mjs` in the clone).
    expect(said).toMatch(new RegExp('Devices paired before keep connecting over iroh\\. To give them the address: (.+)'
      + ' devices revoke --all, then \\1 pair, then pair the other devices from the first one\'s app \\(Settings →'
      + ' Pairing → Pair New Device\\)\\. A revoked device loses its unsent messages and drafts\\.', 'u'));
  });

  it('--data-dir: the commands in the notes keep it', async () => {
    setupConfig({ ...IROH_ONLY });
    const dataDir = path.join(home, 'custom-data');
    const run = await runSetup({ answer, argv: [...FLAG, '--data-dir', dataDir], verbose: false });
    // The notes wrap long paths, so the comparison drops whitespace.
    const said = run.stdout.replace(/\s+/gu, '');
    expect(said).toContain(`devicesrevoke--all--data-dir'${dataDir}',then`);
    expect(said).toContain(`pair--data-dir'${dataDir}',thenpair`);
  });

  it('"n" to the plan: nothing written, no serve', async () => {
    const before = setupConfig({ ...IROH_ONLY });
    const run = await runSetup({ answer: (q) => (q === 'continue' ? 'n' : 't'), argv: FLAG });
    expect(run.asked).toContain('continue');
    expect(configText()).toBe(before);
    expect(served()).toEqual([]);
  });

  it('without the flag: an existing config.json without an address stays as it is', async () => {
    const before = setupConfig({ ...IROH_ONLY });
    const run = await runSetup({ answer });
    expect(configText()).toBe(before);
    expect(run.stdout).not.toContain('Tailscale address in config.json');
  });

  for (const [name, prepare, said, fix] of [
    ['no tailscale in PATH', () => { rmSync(path.join(bin, 'tailscale')); }, 'tailscale not in PATH',
      `install Tailscale, then ${RETRY}`],
    ['Tailscale logged out', () => {
      writeFileSync(path.join(state, 'status-json'), JSON.stringify(tailscaleStatus({ BackendState: 'NeedsLogin' })));
    }, 'BackendState NeedsLogin (logged out)', `log in to Tailscale (tailscale up), then ${RETRY}`],
    ['Tailscale not running', () => { writeFileSync(path.join(state, 'status-err'), 'Tailscale is stopped.\n'); },
      'Tailscale is stopped.', `start Tailscale (tailscale up), then ${RETRY}`],
    ['HTTPS off in the tailnet', () => {
      writeFileSync(path.join(state, 'status-json'), JSON.stringify(tailscaleStatus({ CertDomains: [] })));
    }, 'HTTPS is off in your tailnet', `enable HTTPS in the Tailscale admin console, then ${RETRY}`],
  ] as const) {
    it(`${name}: PROBLEM with the reason and Fix:, nothing written, no plan item`, async () => {
      const before = setupConfig({ ...IROH_ONLY });
      prepare();
      const run = await runSetup({ answer, argv: FLAG });
      const summary = summaryLine(run.stdout, 'tailscale serve');
      expect(summary).toMatch(/^ {2}PROBLEM {2}tailscale serve: /u);
      expect(summary).toContain(said);
      expect(summary).toContain(fix);
      expect(configText()).toBe(before);
      expect(run.stdout).not.toContain('Tailscale address in config.json');
      expect(served()).toEqual([]);
      expect(run.code).toBe(1);
    });
  }

  it('no free port in the pool: PROBLEM with the reason, nothing written', async () => {
    const before = setupConfig({ ...IROH_ONLY });
    writeServeStatus(serveMappings([...otherMappings(), [8931, 3000], [8932, 3001]]));
    const run = await runSetup({ answer, argv: FLAG, deps: { tcpProbe: () => Promise.resolve('listening') } });
    expect(summaryLine(run.stdout, 'tailscale serve'))
      .toMatch(/^ {2}PROBLEM {2}tailscale serve: no free port in 8931–8960 for tailscale serve: 2 mapped, 28 in use/u);
    expect(configText()).toBe(before);
    expect(served()).toEqual([]);
    expect(run.code).toBe(1);
  });

  it('without a terminal: MISSING, Fix: rarog setup --tailscale in a terminal, nothing written', async () => {
    const before = setupConfig({ ...IROH_ONLY });
    const run = await runSetup({ answer: null, argv: FLAG });
    expect(summaryLine(run.stdout, 'tailscale serve'))
      .toBe(`  MISSING  tailscale serve: config.json has no address; run ${RETRY} in a terminal`);
    expect(configText()).toBe(before);
    expect(calls('tailscale')).toEqual([]);
  });

  it('a file outside the layout setup writes: no plan item, PROBLEM with the hand edit, nothing written', async () => {
    writeConfig({ ...IROH_ONLY }, WRAPPER);
    const before = configText();
    const run = await runSetup({ answer, argv: FLAG });
    expect(run.stdout).not.toContain('Tailscale address in config.json');
    expect(summaryLine(run.stdout, 'tailscale serve')).toContain('is not in the layout rarog setup writes');
    expect(summaryLine(run.stdout, 'tailscale serve'))
      .toContain(`Set "RAROG_ORIGINS": "${ADDRESS}" in its "env" object by hand`);
    expect(configText()).toBe(before);
    expect(served()).toEqual([]);
  });

  it('a file over 64 KiB with the address: PROBLEM, nothing written, no temporary file', async () => {
    // RAROG_ORIGINS of a skipped entry is kept, so the new text is longer by the address.
    const room = 65_536 - Buffer.byteLength(setupText({ ...IROH_ONLY, RAROG_ORIGINS: '' }));
    const before = setupConfig({ ...IROH_ONLY, RAROG_ORIGINS: 'x'.repeat(room) });
    expect(Buffer.byteLength(before)).toBe(65_536);
    const run = await runSetup({ answer, argv: FLAG });
    expect(summaryLine(run.stdout, 'tailscale serve')).toContain('the file would be larger than 64 KiB');
    expect(configText()).toBe(before);
    expect(tmpFiles()).toEqual([]);
    expect(served()).toEqual([]);
  });

  it('the file changed between reading and writing: PROBLEM, the other change stays, no temporary file', async () => {
    setupConfig({ ...IROH_ONLY });
    const other = setupText({ ...IROH_ONLY, RAROG_PORT: '8939' });
    const run = await runSetup({
      answer, argv: FLAG, deps: { configWrites: writesWith(() => { writeFileSync(configFile(), other); }) },
    });
    expect(summaryLine(run.stdout, 'tailscale serve')).toContain('changed meanwhile');
    expect(configText()).toBe(other);
    expect(tmpFiles()).toEqual([]);
    expect(served()).toEqual([]);
  });

  it('an address written during the plan question: PROBLEM, that address stays, nothing added', async () => {
    setupConfig({ ...IROH_ONLY });
    const other = setupText({ ...IROH_ONLY, RAROG_ORIGINS: 'https://rarog.example.org' });
    const run = await runSetup({
      answer: (q) => {
        if (q === 'continue') writeFileSync(configFile(), other);
        return answer(q);
      },
      argv: FLAG,
    });
    expect(summaryLine(run.stdout, 'tailscale serve')).toContain('has an address in RAROG_ORIGINS now');
    expect(configText()).toBe(other);
    expect(served()).toEqual([]);
  });

  it('rename fails: PROBLEM with its code, the file untouched, no temporary file', async () => {
    const before = setupConfig({ ...IROH_ONLY });
    const busy = (): void => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); };
    const run = await runSetup({ answer, argv: FLAG, deps: { configWrites: writesWith(() => {}, busy) } });
    expect(summaryLine(run.stdout, 'tailscale serve')).toContain('EBUSY');
    expect(configText()).toBe(before);
    expect(tmpFiles()).toEqual([]);
    expect(served()).toEqual([]);
  });

  it('cut short after the write, before serve: a run without the flag gives the command, the flag runs serve', async () => {
    setupConfig({ ...IROH_ONLY });
    // "n" to serve leaves what a run cut short between the write and serve leaves: the address, no mapping.
    const first = await runSetup({ answer: (q) => (q === 'continue' ? 't' : 'n'), argv: FLAG });
    expect(first.asked).toContain('tailscale');
    expect(served()).toEqual([]);
    const written = configText();
    expect(written).toContain(`"RAROG_ORIGINS": "${ADDRESS}"`);
    const plain = await runSetup({ answer });
    expect(plain.asked).not.toContain('tailscale');
    expect(summaryLine(plain.stdout, 'tailscale serve'))
      .toBe('  MISSING  tailscale serve: tailscale serve --bg --https=8931 8930');
    const again = await runSetup({ answer, argv: FLAG });
    expect(again.stdout).toContain(`config.json already has an address (${ADDRESS}); --tailscale adds nothing.`);
    expect(again.asked).toContain('tailscale');
    expect(served()).toEqual(['serve --bg --https=8931 8930']);
    expect(summaryLine(again.stdout, 'tailscale serve')).toMatch(/ok {7}tailscale serve: mapping to port 8930/u);
    expect(configText()).toBe(written);
    // The server still runs without the address, so the finishing run gives the same notes as the first.
    expect(again.stdout).toContain('The server reads the new address at start: run ');
    expect(again.stdout.replace(/\s+/gu, ' ')).toContain('Devices paired before keep connecting over iroh.');
  });

  it('a pool address of another machine: no serve, the command', async () => {
    setupConfig({ ...IROH_ONLY, RAROG_ORIGINS: 'https://other.example.ts.net:8931' });
    const run = await runSetup({ answer, argv: FLAG });
    expect(run.asked).not.toContain('tailscale');
    expect(served()).toEqual([]);
    expect(run.stdout).toContain('is not this machine\'s Tailscale name');
  });
});
