/**
 * `rarog setup` and the project directories: no command asks about them. A new
 * `config.json` gets home as the root of both keys, and the plan screen says in one line how to narrow it; an
 * existing `config.json` stays byte for byte, whatever its roots. Runs on the shared harness.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { configFileText } from '../src/cli/serve.ts';
import { workAreaSentence } from '../src/cli/setup-plan.ts';
import { HOOK_INSTALL_FILES, STATUSLINE_INSTALL_FILES, statuslineCommand } from '../src/herdr/hook-config.ts';
import { REPO } from './private-guard.ts';
import {
  bin, configDir, configFile, copyHooks, home, listenHerdr, markLoaded, plist, port, runSetup, useSetupHarness, write,
  writeSecrets, writeSettings,
} from './helpers/setup-harness.ts';
import { IS_MAC, macOnly } from './platform.ts';

useSetupHarness();

/** The step screen of a 60-column terminal without colour. */
const SCREEN = { verbose: false, terminal: { tty: true, columns: 60, color: false } } as const;

describe('no command asks about the work area', () => {
  it('the source has neither the work area question nor a prompt for project directories', () => {
    const src = path.join(REPO, 'server/src');
    const hits = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts'))
      .filter((file) => /work area\?|Project directories, comma-separated|offerWorkArea/u
        .test(readFileSync(path.join(src, file), 'utf8')));
    expect(hits).toEqual([]);
    expect(existsSync(path.join(src, 'cli', 'setup-roots.ts'))).toBe(false);
  });

  it('the plan line names home, the key that narrows it and the file, in one line at 60 columns', () => {
    const sentence = workAreaSentence();
    expect(sentence).toBe('Work area: home (RAROG_PROJECT_ROOTS in config.json).');
    expect(sentence.length).toBeLessThanOrEqual(60);
  });
});

describe.skipIf(!IS_MAC)(macOnly('rarog setup: an existing config.json keeps its roots', 'launchd'), () => {
  const narrow = (): Record<string, string> => ({
    RAROG_ORIGINS: 'https://rarog.example.net', RAROG_PORT: String(port),
    RAROG_PROJECT_ROOTS: `${path.join(home, 'Projects')},/srv/work`, RAROG_HERDR_ROOTS: path.join(home, 'Projects'),
  });
  const backups = (): string[] => readdirSync(configDir()).filter((name) => name.startsWith('config.json.backup-'));

  beforeEach(async () => {
    mkdirSync(path.join(home, 'Projects'));
    await listenHerdr(path.join(home, '.config', 'herdr', 'herdr.sock'));
    writeSecrets();
    writeSettings(statuslineCommand(home), home, { denyRead: true });
    write(plist(), '<plist/>\n');
    markLoaded();
  });

  it('the step screen (no --verbose): narrow roots, no question, no work area sentence, the file byte for byte', async () => {
    const text = configFileText({ version: 1, env: narrow() });
    write(configFile(), text, 0o600);
    copyHooks([...HOOK_INSTALL_FILES, ...STATUSLINE_INSTALL_FILES]);
    const run = await runSetup(SCREEN);
    expect(run.asked).toEqual([]);
    expect(run.stdout).not.toContain('Work area:');
    expect(readFileSync(configFile(), 'utf8')).toBe(text);
    expect(backups()).toEqual([]);
    expect(run.code).toBe(0);
  });

  it('a hook copy older than the install (the service target hides the copy): no question, the file byte for byte', async () => {
    const text = configFileText({ version: 1, env: narrow() });
    write(configFile(), text, 0o600);
    // The copy from before the work area: no `work-area.mjs`, so its hooks read only `roots` from roots.json.
    copyHooks([...HOOK_INSTALL_FILES, ...STATUSLINE_INSTALL_FILES].filter((name) => name !== 'work-area.mjs'));
    const run = await runSetup({ ...SCREEN, answer: () => 'n' });
    expect(run.asked).toEqual([]);
    expect(readFileSync(configFile(), 'utf8')).toBe(text);
    expect(backups()).toEqual([]);
  });
});

describe.skipIf(!IS_MAC)(macOnly('rarog setup: a new config.json gets home', 'launchd'), () => {
  const roots = (): Record<string, string | undefined> => {
    const config = JSON.parse(readFileSync(configFile(), 'utf8')) as { env: Record<string, string> };
    return { project: config.env['RAROG_PROJECT_ROOTS'], herdr: config.env['RAROG_HERDR_ROOTS'] };
  };

  beforeEach(async () => {
    mkdirSync(path.join(home, 'Projects'));
    await listenHerdr(path.join(home, '.config', 'herdr', 'herdr.sock'));
  });

  it('no hook copy (a fresh machine): the plan shows the work area sentence, home in both keys', async () => {
    const run = await runSetup({ ...SCREEN, answer: (question) => (question === 'continue' ? 'y' : 'n') });
    expect(run.asked.slice(0, 2)).toEqual(['tailscale-only', 'continue']);
    expect(run.stdout).toContain(`\n${workAreaSentence()}\n`);
    expect(roots()).toEqual({ project: home, herdr: home });
  });

  it('a hook copy older than the install: home all the same, then the question about the copy', async () => {
    rmSync(path.join(bin, 'tailscale'));
    copyHooks(HOOK_INSTALL_FILES.filter((name) => name !== 'work-area.mjs'));
    const run = await runSetup({ ...SCREEN, answer: (question) => (question === 'continue' ? 'y' : 'n') });
    expect(run.asked).toEqual(['continue', 'dictation', 'hook', 'settings']);
    expect(roots()).toEqual({ project: home, herdr: home });
  });
});
