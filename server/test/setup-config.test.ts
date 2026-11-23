/**
 * `rarog setup`, step 2 (`setup-config.ts`): `config.json` written only when missing, never over another run's
 * file, never through a directory swapped for a symlink; an existing but broken file is only diagnosed. Runs on the
 * shared harness (`helpers/setup-harness.ts`).
 */
import { chmodSync, mkdirSync, readFileSync, readdirSync, readlinkSync, symlinkSync, existsSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { main } from '../src/cli/main.ts';
import {
  YES, configDir, configFile, env, home, listenHerdr, runSetup, secretFile, summaryLine, t, treeHash,
  useSetupHarness, write,
} from './helpers/setup-harness.ts';
import type { Question } from './helpers/setup-harness.ts';
import { IS_MAC, macOnly } from './platform.ts';

useSetupHarness();

// ---------------------------------------------------------------------------
// Pusty dom: pytania, odpowiedzi, zapisy
// ---------------------------------------------------------------------------

describe.skipIf(!IS_MAC)(macOnly('rarog setup w pustym domu', 'launchd'), () => {
  beforeEach(async () => {
    mkdirSync(path.join(home, 'Projects'));
    await listenHerdr(path.join(home, '.config', 'herdr', 'herdr.sock'));
  });

  it('two setups racing: one writes, the other gets EEXIST and overwrites nothing; one iroh key', async () => {
    const waiting = new Map<Question, (() => void)[]>();
    /** Oba przebiegi czekają na siebie przy tym samym pytaniu: pytają oba, zanim którykolwiek zapisze. */
    const together = async (question: Question): Promise<void> => new Promise<void>((resolve) => {
      const list = waiting.get(question) ?? [];
      list.push(resolve);
      waiting.set(question, list);
      if (list.length === 2) for (const release of list) release();
    });
    const answer = async (question: Question): Promise<string | null> => {
      if (question !== 'continue') return 'n';
      await together(question);
      return YES(question);
    };
    const [a, b] = await Promise.all([runSetup({ answer }), runSetup({ answer })]);
    expect([a, b].filter((run) => run.stdout.includes('config.json appeared meanwhile'))).toHaveLength(1);
    expect(JSON.parse(readFileSync(configFile(), 'utf8'))).toMatchObject({ version: 1 });
    expect(readdirSync(configDir()).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    // One iroh key: the second run reads the first one's key instead of adding its own; no lock left after the runs.
    expect(readFileSync(secretFile(), 'utf8').match(/^RAROG_IROH_KEY=/gm)).toHaveLength(1);
    expect(readdirSync(path.dirname(secretFile())).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(existsSync(path.join(configDir(), 'lock'))).toBe(false);
  });

  it('`rarog voice-agent set-model` accepts the config.json setup writes (iroh entries too)', async () => {
    const run = await runSetup({ answer: (q) => (q === 'continue' ? YES(q) : 'n') });
    expect(summaryLine(run.stdout, 'config.json')).toMatch(/^ {2}ok {7}.*config\.json: created$/);
    const before = JSON.parse(readFileSync(configFile(), 'utf8')) as { version: number; env: Record<string, string> };
    expect(before.env).toMatchObject({ RAROG_IROH: '1' });
    let stderr = '';
    const code = await main(['voice-agent', 'set-model', 'gpt-realtime-2.1-mini'], {
      stdout: () => {}, stderr: (text) => { stderr += text; }, env: env(), cwd: t.home,
    });
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(configFile(), 'utf8'))).toEqual({
      ...before, env: { ...before.env, RAROG_COMPANION_MODEL: 'gpt-realtime-2.1-mini' },
    });
  });

  it('dowiązanie w miejscu katalogu konfiguracji podstawione w trakcie pytania: bez zapisu config.json', async () => {
    const elsewhere = path.join(t.home, 'gdzie-indziej');
    mkdirSync(elsewhere, { mode: 0o700 });
    const run = await runSetup({
      answer: (q) => {
        if (q === 'continue') {
          mkdirSync(path.dirname(configDir()), { recursive: true });
          symlinkSync(elsewhere, configDir());
        }
        return YES(q);
      },
    });
    expect(run.asked).toContain('continue');
    expect(readdirSync(elsewhere).filter((name) => name.startsWith('config.json'))).toEqual([]);
    expect(summaryLine(run.stdout, 'not a symlink')).toMatch(/PROBLEM .*\/\.config\/rarog: expected a real directory/);
  });
});

// ---------------------------------------------------------------------------
// Stan istniejący, ale nie w porządku: diagnoza bez zapisu
// ---------------------------------------------------------------------------

describe.skipIf(!IS_MAC)(macOnly('rarog setup: stan istniejący, ale zepsuty — diagnoza i komenda, bez zapisu', 'launchd'), () => {
  it('zepsuty JSON w config.json: bez pytania, plik bez zmian', async () => {
    write(configFile(), '{"version": 1, "env": ', 0o600);
    const before = treeHash(home);
    const run = await runSetup({ answer: null });
    expect(run.stdout).not.toContain('config and server key');
    expect(summaryLine(run.stdout, 'config.json')).toMatch(/PROBLEM .*not valid JSON/);
    expect(treeHash(home)).toEqual(before);
    expect(run.code).toBe(1);
  });

  it('wiszące dowiązanie config.json: bez pytania, dowiązanie zostaje', async () => {
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    const target = path.join(t.home, 'nie-ma', 'config.json');
    symlinkSync(target, configFile());
    const run = await runSetup({ answer: null });
    expect(run.stdout).not.toContain('config and server key');
    expect(summaryLine(run.stdout, 'config.json')).toMatch(/PROBLEM .*points to a file that does not exist/);
    expect(readlinkSync(configFile())).toBe(target);
    expect(existsSync(target)).toBe(false);
  });

  it('config.json bez prawa odczytu: bez pytania, plik bez zmian', async () => {
    write(configFile(), '{"version": 1, "env": {}}', 0o600);
    chmodSync(configFile(), 0o000);
    try {
      const run = await runSetup({ answer: null });
      expect(run.stdout).not.toContain('config and server key');
      expect(summaryLine(run.stdout, 'config.json')).toMatch(/PROBLEM/);
    } finally {
      chmodSync(configFile(), 0o600);
    }
    expect(readFileSync(configFile(), 'utf8')).toBe('{"version": 1, "env": {}}');
  });
});
