/**
 * `rarog setup`, Tailscale only (`setup-tailscale-only.ts`): a first setup with the iroh module and `tailscale` in
 * `PATH` asks before the plan screen whether the app connects only through Tailscale, and `--tailscale-only` chooses
 * that without the question. The choice writes `RAROG_IROH=0` with the relay, the Tailscale address on a pool port and
 * no iroh key; the answer itself writes nothing and opens no run log, so "Continue?" stays the one consent to write.
 * A mapping of this server that Tailscale Funnel publishes is a refusal. An existing `config.json` keeps its
 * transport. Runs on the shared harness (`helpers/setup-harness.ts`).
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { visibleWidth } from '../src/cli/screen/style.ts';
import { TAILSCALE_ONLY_NOTES, TAILSCALE_ONLY_QUESTION } from '../src/cli/setup-tailscale-only.ts';
import { TAILSCALE_PORTS } from '../src/cli/setup-tailscale-port.ts';
import { DEFAULT_IROH_RELAY } from '../src/cli/setup.ts';
import {
  FAKE_IROH_KEY, IROH_INTEL, KEY_LINE, TS_HOST, bin, calls, configDir, configFile, dataDirOf, home, runSetup,
  secretFile, serveMappings, state, summaryLine, tailscaleStatus, treeHash, useSetupHarness, visibleLines, write,
  writeConfig, writeServeStatus,
} from './helpers/setup-harness.ts';
import { IS_MAC, macOnly } from './platform.ts';

useSetupHarness();

const ONLY = '--tailscale-only';
/** The address a first setup takes from the fake `tailscale status`: the first port of the pool. */
const ADDRESS = `https://${TS_HOST}:8931`;
const logDir = (): string => path.join(dataDirOf(), 'logs');
const configEnv = (): Record<string, string> =>
  (JSON.parse(readFileSync(configFile(), 'utf8')) as { env: Record<string, string> }).env;
/** stdout with every run of white space as one space (a sentence wrapped at the screen width reads whole). */
const flat = (text: string): string => text.replace(/\s+/gu, ' ');
/** The plan screen's item lines (`  • …`). */
const planItems = (stdout: string): string[] => stdout.split('\n').filter((one) => one.startsWith('  • '));
const statusJson = (fields: Readonly<Record<string, unknown>>): void => {
  writeFileSync(path.join(state, 'status-json'), JSON.stringify(tailscaleStatus(fields)));
};

describe('the question before the plan', () => {
  // The explanation lines are in the width test of every question note (`setup-pytania.test.ts`).
  it('the question with its form fits one line of a 60-column terminal', () => {
    expect(visibleWidth(`? ${TAILSCALE_ONLY_QUESTION} [y/N] `)).toBeLessThan(60);
  });
});

describe.skipIf(!IS_MAC)(macOnly('rarog setup: Tailscale only for a new config.json', 'launchd'), () => {
  for (const reply of ['', 'n', null] as const) {
    it(`1. iroh module and tailscale, ${reply === null ? 'EOF' : `"${reply}"`} to the question: iroh with the address, as before`,
      async () => {
        const run = await runSetup({ tailscaleOnly: reply });
        expect(run.asked[0]).toBe('tailscale-only');
        expect(run.asked[1]).toBe('continue');
        const env = configEnv();
        expect(env['RAROG_IROH']).toBe('1');
        expect(env['RAROG_IROH_RELAY']).toBe(DEFAULT_IROH_RELAY);
        expect(env['RAROG_ORIGINS']).toBe(ADDRESS);
        expect(readFileSync(secretFile(), 'utf8')).toMatch(KEY_LINE);
        // The standard path reads Tailscale only after "Continue?", as before the question existed.
        expect(calls('tailscale')[0]).toBe('status --json');
        expect(calls('tailscale').filter((one) => one === 'status --json')).toHaveLength(1);
      });
  }

  it('2. "y": RAROG_IROH=0 with the relay, the pool address, no iroh key; step 4 maps the address', async () => {
    const run = await runSetup({ tailscaleOnly: 'y' });
    expect(run.asked.slice(0, 2)).toEqual(['tailscale-only', 'continue']);
    const env = configEnv();
    expect(env['RAROG_IROH']).toBe('0');
    expect(env['RAROG_IROH_RELAY']).toBe(DEFAULT_IROH_RELAY);
    expect(env['RAROG_ORIGINS']).toBe(ADDRESS);
    expect(env['RAROG_IROH_KEY']).toBeUndefined();
    expect(existsSync(secretFile())).toBe(false);
    expect(calls('tailscale')).toContain('serve --bg --https=8931 8930');
    expect(summaryLine(run.stdout, 'tailscale serve')).toMatch(/ok {7}tailscale serve: mapping to port 8930/u);
    // The plan names the choice, not the server key or a missing module.
    expect(planItems(run.stdout).filter((one) => one.includes('config'))).toEqual([
      expect.stringMatching(/^ {2}• config, Tailscale only \(chosen\) +~\/\.config\/rarog$/u),
    ]);
    expect(run.stdout).toContain('Tailscale only (chosen)');
    // The header sentence describes setup in general; every line after it speaks of this run.
    const lines = run.stdout.split('\n').filter((one) => !one.startsWith('rarog setup: creates only what is missing'));
    expect(lines.filter((one) => /no iroh native module|server key/u.test(one))).toEqual([]);
  });

  it('2. on the step screen: the explanation right above the question, the plan item under it', async () => {
    const run = await runSetup({
      tailscaleOnly: 'y', verbose: false, terminal: { tty: true, columns: 60, color: false }, echo: true,
    });
    const lines = visibleLines(run.stdout);
    const at = lines.findIndex((one) => one.startsWith(`? ${TAILSCALE_ONLY_QUESTION}`));
    expect(at, lines.join('\n')).toBeGreaterThan(TAILSCALE_ONLY_NOTES.length - 1);
    expect(lines.slice(at - TAILSCALE_ONLY_NOTES.length, at)).toEqual(TAILSCALE_ONLY_NOTES.map((one) => `  ${one}`));
    expect(lines.slice(at + 1)).toContainEqual(expect.stringMatching(/^ {2}• config, Tailscale only \(chosen\) /u));
  });

  for (const [backend, name, fix] of [
    ['NeedsLogin', 'a logged-in Tailscale', 'log in to Tailscale (tailscale up)'],
    ['Stopped', 'a running Tailscale', 'start Tailscale (tailscale up)'],
  ] as const) {
    for (const how of ['question', 'flag'] as const) {
      it(`3. ${how === 'flag' ? ONLY : '"y"'} with Tailscale ${backend}: refused before the plan, nothing on disk`,
        async () => {
          statusJson({ BackendState: backend });
          const before = treeHash(home);
          const run = how === 'flag' ? await runSetup({ argv: [ONLY] }) : await runSetup({ tailscaleOnly: 'y' });
          expect(run.asked).toEqual(how === 'flag' ? [] : ['tailscale-only']);
          expect(run.code).toBe(1);
          expect(flat(run.stdout)).toContain(`Rarog cannot run without ${name}; nothing changed.`);
          expect(flat(run.stdout)).toContain(`Fix: ${fix}, then rarog setup${how === 'flag' ? ` ${ONLY}` : ''}`);
          expect(treeHash(home)).toEqual(before);
          expect(existsSync(configDir())).toBe(false);
          expect(existsSync(logDir())).toBe(false);
        });
    }
  }

  it('4. "y", HTTPS off in the tailnet after "Continue?": no transport, config.json not created', async () => {
    const run = await runSetup({
      tailscaleOnly: 'y',
      answer: (question) => {
        // The state changes during the plan question: the read before the plan saw HTTPS on.
        if (question === 'continue') statusJson({ CertDomains: [] });
        return 't';
      },
    });
    expect(run.asked.slice(0, 2)).toEqual(['tailscale-only', 'continue']);
    expect(existsSync(configFile())).toBe(false);
    expect(existsSync(secretFile())).toBe(false);
    expect(summaryLine(run.stdout, 'HTTPS is off')).toContain('no transport: Tailscale only (chosen)');
    expect(run.stdout).not.toContain('no iroh native module');
    expect(run.code).toBe(1);
  });

  it('4. "y", every pool port mapped by another site: no transport, config.json not created', async () => {
    writeServeStatus(serveMappings(TAILSCALE_PORTS.map((one) => [one, 3000] as const)));
    const run = await runSetup({ tailscaleOnly: 'y' });
    expect(existsSync(configFile())).toBe(false);
    expect(existsSync(secretFile())).toBe(false);
    expect(summaryLine(run.stdout, 'no transport')).toContain('no transport: Tailscale only (chosen)');
    expect(run.code).toBe(1);
  });

  /** `tailscale serve status --json` with port 443 mapped to this server (and `more`), Funnel on 443 when `funnel`. */
  const ours443 = (funnel: boolean, more: readonly (readonly [number, number])[] = []): void => {
    writeServeStatus({
      ...serveMappings([[443, 8930], ...more]), ...(funnel ? { AllowFunnel: { [`${TS_HOST}:443`]: true } } : {}),
    });
  };
  /** The fake client's calls other than reads: setup changed a mapping (or Funnel) when this is not empty. */
  const tailscaleWrites = (): string[] =>
    calls('tailscale').filter((one) => one !== 'status --json' && one !== 'serve status --json');

  for (const [name, more] of [['alone', []], ['and on pool port 8945', [[8945, 8930]]]] as const) {
    it(`4. "y", this server on 443 ${name}, Funnel on 443: refused, config.json not created, the mapping left alone`,
      async () => {
        ours443(true, more);
        const run = await runSetup({ tailscaleOnly: 'y' });
        expect(run.asked.slice(0, 2)).toEqual(['tailscale-only', 'continue']);
        expect(existsSync(configFile())).toBe(false);
        expect(existsSync(secretFile())).toBe(false);
        expect(tailscaleWrites()).toEqual([]);
        const summary = summaryLine(run.stdout, 'Tailscale Funnel');
        expect(summary).toContain(`Tailscale Funnel makes https://${TS_HOST} public on the internet`);
        expect(summary).toContain('no transport: Tailscale only (chosen)');
        expect(summary).toContain('tailscale funnel --https=443 off, then rarog setup');
        expect(run.code).toBe(1);
      });
  }

  it('4. "y", Funnel on 443 on the step screen: the sentence and Fix: tailscale funnel --https=443 off', async () => {
    ours443(true);
    const run = await runSetup({ tailscaleOnly: 'y', verbose: false });
    expect(flat(run.stdout)).toContain(`Tailscale Funnel makes https://${TS_HOST} public on the internet`);
    expect(flat(run.stdout)).toContain('Fix: tailscale funnel --https=443 off, then rarog setup');
    expect(existsSync(configFile())).toBe(false);
  });

  it('4. "y", this server on 443 without Funnel: the address without a port, as before', async () => {
    ours443(false);
    const run = await runSetup({ tailscaleOnly: 'y' });
    const env = configEnv();
    expect(env['RAROG_IROH']).toBe('0');
    expect(env['RAROG_ORIGINS']).toBe(`https://${TS_HOST}`);
    expect(tailscaleWrites()).toEqual([]);
    expect(summaryLine(run.stdout, 'tailscale serve')).toMatch(/ok {7}tailscale serve: mapping to port 8930/u);
  });

  it(`5. ${ONLY} without tailscale in PATH: refused before the plan, never iroh`, async () => {
    rmSync(path.join(bin, 'tailscale'));
    const before = treeHash(home);
    const run = await runSetup({ argv: [ONLY] });
    expect(run.asked).toEqual([]);
    expect(run.code).toBe(1);
    expect(flat(run.stdout)).toContain('Rarog cannot run without tailscale; nothing changed.');
    expect(flat(run.stdout)).toContain(`Fix: install Tailscale, then rarog setup ${ONLY}`);
    expect(treeHash(home)).toEqual(before);
    expect(existsSync(logDir())).toBe(false);
  });

  it('6. iroh module, no tailscale, no flag: no question, iroh as before', async () => {
    rmSync(path.join(bin, 'tailscale'));
    const run = await runSetup({ tailscaleOnly: 'y' });
    expect(run.asked).not.toContain('tailscale-only');
    expect(configEnv()['RAROG_IROH']).toBe('1');
    expect(configEnv()['RAROG_ORIGINS']).toBeUndefined();
  });

  it('7. no iroh module: no question, Tailscale only as before (no RAROG_IROH)', async () => {
    const run = await runSetup({ tailscaleOnly: 'y', deps: { irohModule: () => IROH_INTEL } });
    expect(run.asked).not.toContain('tailscale-only');
    expect(configEnv()['RAROG_IROH']).toBeUndefined();
    expect(configEnv()['RAROG_ORIGINS']).toBe(ADDRESS);
  });

  it(`8. ${ONLY} in a terminal: no question, as after "y"`, async () => {
    const run = await runSetup({ argv: [ONLY] });
    expect(run.asked).not.toContain('tailscale-only');
    expect(run.asked[0]).toBe('continue');
    const env = configEnv();
    expect(env['RAROG_IROH']).toBe('0');
    expect(env['RAROG_IROH_RELAY']).toBe(DEFAULT_IROH_RELAY);
    expect(env['RAROG_ORIGINS']).toBe(ADDRESS);
    expect(existsSync(secretFile())).toBe(false);
  });

  it(`8. ${ONLY} with --iroh-relay: the relay flag is ignored with a warning, the default relay stays`, async () => {
    const run = await runSetup({ argv: [ONLY, '--iroh-relay', 'https://relay.example.org/'] });
    expect(run.stdout).toContain('WARNING: --iroh-relay ignored: Tailscale only (chosen)');
    expect(configEnv()['RAROG_IROH']).toBe('0');
    expect(configEnv()['RAROG_IROH_RELAY']).toBe(DEFAULT_IROH_RELAY);
  });

  it(`8. ${ONLY} with --tailscale: ${ONLY} alone`, async () => {
    const run = await runSetup({ argv: [ONLY, '--tailscale'] });
    expect(run.stdout).not.toContain('--tailscale adds nothing');
    expect(configEnv()['RAROG_IROH']).toBe('0');
    expect(configEnv()['RAROG_ORIGINS']).toBe(ADDRESS);
  });

  for (const argv of [[], [ONLY]] as const) {
    it(`9. no terminal${argv.length === 0 ? '' : ` with ${ONLY}`}: no question and nothing written, as before`,
      async () => {
        const before = treeHash(home);
        const run = await runSetup({ answer: null, argv });
        expect(run.asked).toEqual([]);
        expect(existsSync(configDir())).toBe(false);
        expect(treeHash(home)).toEqual(before);
        expect(run.stdout).not.toContain('Rarog cannot run');
        expect(run.code).toBe(1);
      });
  }

  for (const reply of ['n', null] as const) {
    it(`10. "y", then ${reply === null ? 'EOF' : '"n"'} on "Continue?": nothing on disk, no log directory either`,
      async () => {
        const before = treeHash(home);
        const run = await runSetup({ tailscaleOnly: 'y', answer: () => reply });
        expect(run.asked).toEqual(['tailscale-only', 'continue']);
        expect(existsSync(configDir())).toBe(false);
        expect(existsSync(logDir())).toBe(false);
        expect(existsSync(dataDirOf())).toBe(false);
        expect(treeHash(home)).toEqual(before);
        expect(run.stdout).toMatch(/(?:^|\] )Nothing changed\.\n$/mu);
        expect(run.code).toBe(1);
      });
  }

  for (const argv of [[ONLY], [ONLY, '--tailscale']] as const) {
    it(`11. an existing config.json with ${argv.join(' ')}: nothing written, a line with the way by hand`, async () => {
      writeConfig({ RAROG_IROH: '1', RAROG_IROH_RELAY: DEFAULT_IROH_RELAY });
      write(secretFile(), `RAROG_IROH_KEY=${FAKE_IROH_KEY}\n`, 0o600);
      const before = treeHash(home);
      const run = await runSetup({ argv });
      expect(run.asked).toEqual([]);
      expect(treeHash(home)).toEqual(before);
      expect(calls('tailscale')).toEqual([]);
      expect(flat(run.stdout)).toContain('Fix: switch by hand: docs/server-config.md, "Tailscale only"');
      expect(run.code).toBe(1);
    });
  }

  it('12. an existing config.json without the flag: no question, its transport stays; a missing key as before', async () => {
    writeConfig({ RAROG_IROH: '1', RAROG_IROH_RELAY: DEFAULT_IROH_RELAY });
    const text = readFileSync(configFile(), 'utf8');
    const run = await runSetup({ tailscaleOnly: 'y' });
    expect(run.asked).not.toContain('tailscale-only');
    expect(run.asked).toContain('key');
    expect(readFileSync(configFile(), 'utf8')).toBe(text);
    expect(readFileSync(secretFile(), 'utf8')).toMatch(KEY_LINE);
  });
});
