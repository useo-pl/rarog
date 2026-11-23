/**
 * The write block line of `rarog doctor`: it reads `~/.claude/settings.json` and counts the two rules for the
 * data directory of the installed service, whatever this shell computes, not for the default rule.
 * A missing rule warns with its name, and a path that gives no rule never reads as "ok". The paste block of
 * `rarog hooks print` names the same directory.
 *
 * The service is a `systemd --user` unit file in a temporary HOME (`CliIo.platform` = linux), so nothing asks launchd.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeClaudeSettings } from '../src/cli/claude-settings.ts';
import { writeBlockLine } from '../src/cli/doctor-write-block.ts';
import { printHookBlock } from '../src/cli/hooks.ts';
import type { CliIo } from '../src/cli/io.ts';
import { runDataDir } from '../src/cli/setup.ts';
import { renderServiceUnit, unitFilePath } from '../src/cli/systemd-unit.ts';
import { userSettingsPath, writeBlockRules } from '../src/herdr/hook-config.ts';
import { realRarogDirsCreated, tempHome } from './rarog-home.ts';
import type { TempHome } from './rarog-home.ts';

const REPO = path.join(import.meta.dirname, '..', '..');

let t: TempHome;
let home = '';

beforeEach(() => {
  t = tempHome('rarog-dwb-');
  home = path.join(t.home, 'h');
  mkdirSync(path.join(home, '.claude'), { recursive: true });
});

afterEach(() => { t.cleanup(); });

afterAll(() => { expect(realRarogDirsCreated()).toEqual([]); });

/** The CLI of a Linux machine without a user bus; `extra` goes into its environment. */
function io(extra: NodeJS.ProcessEnv = {}): CliIo {
  const empty = path.join(t.home, 'no-tools');
  mkdirSync(empty, { recursive: true });
  return { stdout: () => {}, stderr: () => {}, env: { HOME: home, PATH: empty, ...extra }, cwd: home, platform: 'linux' };
}

/** The installed service: a unit whose log, and so whose data directory, is `dir`. */
function unitWithDataDir(dir: string): void {
  mkdirSync(path.dirname(unitFilePath(home)), { recursive: true });
  writeFileSync(unitFilePath(home), renderServiceUnit({
    execStart: [process.execPath, path.join(REPO, 'bin', 'rarog.mjs'), 'serve'], workingDirectory: home,
    log: path.join(dir, 'server.log'),
  }));
}

function rules(dir: string): readonly string[] {
  const built = writeBlockRules(dir, home);
  if (!built.ok) throw new Error(built.reason);
  return built.rules;
}

const defaultDir = (): string => path.join(home, '.local', 'share', 'rarog');

const putDeny = (deny: readonly string[]): void => {
  writeFileSync(userSettingsPath(home), JSON.stringify({ permissions: { deny } }));
};

describe('rarog doctor: the write block line', () => {
  it('both rules: ok; one missing: a warning naming that rule with rarog setup as the fix', () => {
    const [dataRule, configRule] = rules(defaultDir());
    putDeny([dataRule ?? '', configRule ?? '']);
    expect(writeBlockLine(io(), home, 'linux', null).verdict).toBe('ok');
    putDeny(['Read(~/.aws/**)', configRule ?? '']);
    const line = writeBlockLine(io(), home, 'linux', null);
    expect(line.verdict).toBe('warn');
    expect([line.text, ...line.details ?? []].join('\n')).toContain(dataRule);
    expect([line.text, ...line.details ?? []].join('\n')).not.toContain(configRule);
    expect(line.repair).toMatch(/setup$/u);
  });

  it('no settings file: a warning naming both rules', () => {
    const line = writeBlockLine(io(), home, 'linux', null);
    expect(line.verdict).toBe('warn');
    for (const rule of rules(defaultDir())) expect([line.text, ...line.details ?? []].join('\n')).toContain(rule);
  });

  it('a data directory with a pattern character: never ok, the line says why', () => {
    const odd = path.join(t.home, 'state[1]');
    unitWithDataDir(odd);
    // Even a rule spelled from that path, sitting in the settings, does not make the line green.
    putDeny([`Edit(/${odd}/**)`, ...rules(defaultDir())]);
    const line = writeBlockLine(io({ RAROG_DATA_DIR: odd }), home, 'linux', null);
    expect(line.verdict).toBe('warn');
    expect([line.text, ...line.details ?? []].join('\n')).toContain(JSON.stringify(odd));
  });

  it('a service with its own data directory: setup writes and doctor counts the rule of that directory', async () => {
    const custom = path.join(t.home, 'custom-data');
    unitWithDataDir(custom);
    const cli = io({ RAROG_DATA_DIR: custom });
    const { dataDir } = runDataDir(cli, 'linux', null);
    expect(dataDir).toEqual({ ok: true, dir: custom, source: 'service' });
    // Rules for the default directory alone are not the block of this installation.
    putDeny(rules(defaultDir()));
    expect(writeBlockLine(cli, home, 'linux', null).verdict).toBe('warn');
    const result = await writeClaudeSettings({
      home, root: REPO, operation: 'writeBlock', dataDir,
      lock: { dir: path.join(home, '.config', 'rarog'), what: 'rarog setup' }, confirm: async () => true,
      print: () => {}, again: 'rarog setup',
    });
    expect(result.kind).toBe('written');
    const line = writeBlockLine(cli, home, 'linux', null);
    expect(line.verdict).toBe('ok');
    expect(line.text).toContain(rules(custom)[0]);
  });

  it('a service with its own data directory, a shell without the variable: the line still counts that directory', () => {
    const custom = path.join(t.home, 'custom-data');
    unitWithDataDir(custom);
    putDeny(rules(custom));
    expect(writeBlockLine(io(), home, 'linux', null).verdict).toBe('ok');
    expect(writeBlockLine(io(), home, 'linux', null, custom).verdict).toBe('ok');
    // `--data-dir` of a trial instance does not move the line off the installed service.
    expect(writeBlockLine(io(), home, 'linux', null, path.join(t.home, 'trial')).verdict).toBe('ok');
  });

  it('no service installed: `--data-dir` names the directory of the rules', () => {
    const custom = path.join(t.home, 'custom-data');
    putDeny(rules(custom));
    expect(writeBlockLine(io(), home, 'linux', null, custom).verdict).toBe('ok');
    expect(writeBlockLine(io(), home, 'linux', null).verdict).toBe('warn');
  });
});

describe('rarog hooks print: the paste block names the directory of the installed service', () => {
  it('a service with its own data directory, a shell without the variable: its rules and its denyRead path', () => {
    const custom = path.join(t.home, 'custom-data');
    unitWithDataDir(custom);
    let printed = '';
    printHookBlock({ ...io(), stdout: (text: string) => { printed += text; } }, false, home);
    const block = JSON.parse(printed.slice(printed.indexOf('{'), printed.lastIndexOf('}\n\nNotes:') + 1)) as {
      permissions: { deny: string[] }; sandbox: { filesystem: { denyRead: string[] } };
    };
    expect(block.permissions.deny).toEqual(rules(custom));
    expect(block.sandbox.filesystem.denyRead).toContain(path.join(custom, 'run'));
  });
});
