/**
 * The channel of `rarog update` (`server/src/cli/update-registry.ts`, `server/src/cli/update-channel.ts`): without a
 * flag the newest release from `latest` and npm's install range, never a pre-release; with `--beta` the higher of the
 * dist-tags `beta` and `latest`, downloaded as that exact version. The rows of the channel table, the shape of a beta
 * version from the release version cases, and the age gate date of an exact target.
 *
 * npm is the fake registry of `helpers/update-harness.ts` with its versions, dist-tags and the versions its age gate
 * holds back. A row that has nothing to install finishes in this process; only its Download line counts here.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { channelTarget, gateExcludes, isBetaVersion } from '../src/cli/update-channel.ts';
import { REPO, bin, env, home, useSetupHarness } from './helpers/setup-harness.ts';
import {
  configured, fakeRegistryNpm, flat, identityOf, lines, lockFile, npmArgs, npmCalls, npmInstallation, prefix, runUpdate,
  started, stepLines, timesView, updateLogs, workDir,
} from './helpers/update-harness.ts';
import type { RegistryState, RegistryVersion } from './helpers/update-harness.ts';

useSetupHarness();

/** A build from a repository clone: its version is the beta with a local suffix. */
const LOCAL = '1.1.0-beta.1.local.202611231200.abc1234';

/** The registry of a row: the installed version (a clone build is never published), `latest` and `beta`. */
function registry(
  installed: string, latest: string, beta: string | null, fields: Readonly<Record<string, RegistryVersion>> = {},
): RegistryState {
  const versions: Record<string, RegistryVersion> = {};
  for (const version of [installed, latest, beta]) {
    if (version !== null && !version.includes('.local.')) versions[version] = fields[version] ?? {};
  }
  for (const [version, value] of Object.entries(fields)) versions[version] = value;
  return { versions, distTags: beta === null ? { latest } : { latest, beta } };
}

/** `rarog update` with `argv` on installation `installed` against `state`. */
async function update(installed: string, state: RegistryState, argv: readonly string[] = [], gate?: NodeJS.ProcessEnv) {
  const root = npmInstallation(installed);
  configured();
  const run = await runUpdate({
    root, argv, npmCli: fakeRegistryNpm(state),
    ...(gate === undefined ? {} : { env: env(home, { PATH: `${bin}:${path.join(prefix(), 'bin')}:/usr/bin:/bin`, ...gate }) }),
  });
  return run;
}

/** The version the run installed and handed to its own `--finish` (`null` = nothing installed). */
function installedVersion(): string | null {
  const child = started();
  if (child === null) return null;
  expect(child.argv.slice(1)).toEqual(['update', '--finish']);
  return /^installed\.version=(.+)$/mu.exec(child.lock ?? '')?.[1] ?? null;
}

const packSpec = (): string | undefined => npmCalls().find((call) => call.args[0] === 'pack')?.args[1];

describe('rarog update: the channel table', () => {
  it.each([
    [2, '1.0.0', '1.0.1', '1.1.0-beta.2', [], '1.0.1', '@rarog/server@>1.0.0 <=1.0.1'],
    [5, '1.1.0-beta.1', '1.0.1', '1.1.0-beta.2', ['--beta'], '1.1.0-beta.2', '@rarog/server@1.1.0-beta.2'],
    [7, '1.1.0', '1.1.0', '1.2.0-beta.1', ['--beta'], '1.2.0-beta.1', '@rarog/server@1.2.0-beta.1'],
    [8, '1.1.0-beta.2', '1.1.0', '1.1.0-beta.2', ['--beta'], '1.1.0', '@rarog/server@1.1.0'],
    [9, '1.1.0-beta.2', '1.1.0', '1.2.0-beta.1', ['--beta'], '1.2.0-beta.1', '@rarog/server@1.2.0-beta.1'],
    [15, '1.0.2', '1.0.2', '1.1.0-beta.3', ['--beta'], '1.1.0-beta.3', '@rarog/server@1.1.0-beta.3'],
  ])('row %i: installed %s, latest %s, beta %s, %j → %s', async (_nr, installed, latest, beta, argv, want, spec) => {
    const run = await update(installed, registry(installed, latest, beta), argv);
    expect(run.code, run.screen).toBe(0);
    expect(packSpec()).toBe(spec);
    expect(installedVersion()).toBe(want);
    expect(lines(run.screen)[0]).toBe(`Rarog update ${installed} → ${want}`);
    expect(stepLines(run.screen)).toEqual([expect.stringMatching(new RegExp(`^ ✓ Download {7}rarog ${want} from npm`, 'u'))]);
  });

  it.each([
    [1, '1.0.1', '1.0.1', '1.1.0-beta.2', [], 'rarog 1.0.1 is the latest'],
    [4, '1.1.0-beta.1', '1.0.1', '1.1.0-beta.2', [], 'rarog 1.1.0-beta.1 is newer than 1.0.1 on npm'],
    [12, '1.1.0-beta.10', '1.0.1', '1.1.0-beta.9', ['--beta'], 'rarog 1.1.0-beta.10 is newer than 1.1.0-beta.9 on npm'],
    [14, LOCAL, '1.0.1', '1.1.0-beta.2', [], `rarog ${LOCAL} is newer than 1.0.1 on npm`],
  ])('row %i: installed %s, latest %s, beta %s, %j → nothing installed, the finish here', async (
    _nr, installed, latest, beta, argv, line,
  ) => {
    const run = await update(installed, registry(installed, latest, beta), argv);
    expect(flat(run.screen)).toContain(`– Download ${line}`);
    expect(npmArgs().some((args) => args.startsWith('pack ') || args.startsWith('i '))).toBe(false);
    expect(started()).toBeNull();
  });

  it('row 10: --beta without a beta tag, latest below this version → nothing installed, a warning about the tag',
    async () => {
      const run = await update('1.1.0-beta.2', registry('1.1.0-beta.2', '1.0.1', null), ['--beta']);
      expect(flat(run.screen)).toContain('! Download rarog 1.1.0-beta.2 is newer than 1.0.1 on npm; npm has no beta tag');
      expect(npmArgs().some((args) => args.startsWith('pack '))).toBe(false);
      expect(started()).toBeNull();
    });

  it('row 11: --beta without a beta tag, latest above this version → latest installed with a warning', async () => {
    const run = await update('1.1.0-beta.2', registry('1.1.0-beta.2', '1.2.0', null), ['--beta']);
    expect(run.code, run.screen).toBe(0);
    expect(packSpec()).toBe('@rarog/server@1.2.0');
    expect(installedVersion()).toBe('1.2.0');
    expect(flat(run.screen)).toContain('! Download rarog 1.2.0 from npm; npm has no beta tag');
  });

  it('row 13: --beta with a deprecated beta as the target → nothing installed, a warning, code 0', async () => {
    const run = await update('1.1.0-beta.2', registry('1.1.0-beta.2', '1.0.1', '1.1.0-beta.3', {
      '1.1.0-beta.3': { deprecated: 'broken pairing' },
    }), ['--beta']);
    expect(run.code, run.screen).toBe(0);
    expect(flat(run.screen)).toContain('! Download rarog 1.1.0-beta.3 is deprecated on npm, so 1.1.0-beta.2 stays');
    expect(run.screen).not.toContain('broken pairing');
    expect(npmArgs().some((args) => args.startsWith('pack '))).toBe(false);
    expect(started()).toBeNull();
    expect(run.order).toEqual([]);
  });

  it('row 5 in full: the exact version is read, packed, checked against its provenance and installed', async () => {
    const run = await update('1.1.0-beta.1', registry('1.1.0-beta.1', '1.0.1', '1.1.0-beta.2'), ['--beta']);
    expect(run.code, run.screen).toBe(0);
    const work = workDir();
    expect(npmArgs()).toEqual(['prefix -g', 'view @rarog/server dist-tags --json',
      'view @rarog/server@1.1.0-beta.2 version engines deprecated --json',
      `pack @rarog/server@1.1.0-beta.2 --ignore-scripts --json --pack-destination ${work}/tarball`,
      'view @rarog/server@1.1.0-beta.2 dist --json', 'audit signatures --json --include-attestations',
      `i -g --ignore-scripts ${work}/tarball/rarog-server-1.1.0-beta.2.tgz`]);
    expect(started()?.lock).toContain('installed.version=1.1.0-beta.2\n');
    expect(updateLogs().join('\n')).toContain(`provenance verified: ${identityOf('1.1.0-beta.2')}`);
    expect(existsSync(lockFile())).toBe(false);
  });

  describe('the npm age gate', () => {
    const NOW = '2026-11-14T12:00:00.000Z';
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(NOW));
    });
    afterEach(() => { vi.useRealTimers(); });

    const OLD = '2026-10-01T08:00:00.000Z';
    const THREE_DAYS = '2026-11-11T09:30:00.000Z';
    const gate = (exclude = '', before = 'null'): string =>
      `min-release-age=7\nbefore=${before}\nmin-release-age-exclude=${exclude}\n`;

    it('row 3: without a flag, latest 1.2.0 too young → the older 1.1.0 of the range and a warning with the date',
      async () => {
        const state = registry('1.0.1', '1.2.0', null, { '1.1.0': {} });
        const run = await update('1.0.1', { ...state, held: ['1.2.0'], gateConfig: 'min-release-age=7\nbefore=null\n',
          times: timesView({ created: OLD, '1.0.1': OLD, '1.1.0': OLD, '1.2.0': THREE_DAYS }) });
        expect(run.code, run.screen).toBe(0);
        expect(packSpec()).toBe('@rarog/server@>1.0.1 <=1.2.0');
        expect(installedVersion()).toBe('1.1.0');
        expect(flat(run.screen))
          .toContain('! Download rarog 1.1.0 installed, 1.2.0 is 3 days old; npm installs it from 2026-11-18');
      });

    it('row 6: --beta, the beta too young → nothing installed, the day npm lets the target in, code 0', async () => {
      const state = registry('1.1.0-beta.1', '1.0.1', '1.1.0-beta.2');
      const run = await update('1.1.0-beta.1', { ...state, held: ['1.1.0-beta.2'], gateConfig: gate(),
        times: timesView({ created: OLD, '1.0.1': OLD, '1.1.0-beta.1': OLD, '1.1.0-beta.2': THREE_DAYS }) },
      ['--beta']);
      expect(run.code, run.screen).toBe(0);
      expect(flat(run.screen)).toContain('! Download rarog 1.1.0-beta.2 is 3 days old; npm installs it from 2026-11-18');
      expect(npmArgs().slice(-2))
        .toEqual(['config get min-release-age before min-release-age-exclude -g', 'view @rarog/server time versions --json']);
      expect(started()).toBeNull();
    });

    it('--beta: the date is the exact target\'s, not the earliest beta of the same version', async () => {
      const state = registry('1.0.2', '1.0.2', '1.1.0-beta.3', { '1.1.0-beta.2': {} });
      const run = await update('1.0.2', { ...state, held: ['1.1.0-beta.2', '1.1.0-beta.3'], gateConfig: gate(),
        times: timesView({ created: OLD, '1.0.2': OLD, '1.1.0-beta.2': '2026-11-09T20:00:00.000Z',
          '1.1.0-beta.3': THREE_DAYS }) }, ['--beta']);
      expect(run.code, run.screen).toBe(0);
      expect(flat(run.screen)).toContain('! Download rarog 1.1.0-beta.3 is 3 days old; npm installs it from 2026-11-18');
    });

    // npm lets a package of min-release-age-exclude through at once; an age gate stop is then a dependency's, so the
    // update has no date of its own to name.
    it.each(['@rarog/server', 'left-pad,@rarog/server', '@rarog/*'])('--beta, min-release-age-exclude %s: no own date'
      + ' for @rarog/server, the text of today', async (exclude) => {
      const state = registry('1.1.0-beta.1', '1.0.1', '1.1.0-beta.2');
      const run = await update('1.1.0-beta.1', { ...state, gateConfig: gate(exclude), installCode: 1,
        installStderr: 'npm error code ETARGET\n',
        times: timesView({ created: OLD, '1.0.1': OLD, '1.1.0-beta.1': OLD, '1.1.0-beta.2': THREE_DAYS }) },
      ['--beta']);
      expect(run.code, run.screen).toBe(0);
      expect(flat(run.screen)).toContain('! Download rarog 1.1.0-beta.2 not installed yet (npm age gate)');
      expect(started()).toBeNull();
    });

    it('--beta, an exclude list without the package keeps the date of the target', async () => {
      const state = registry('1.1.0-beta.1', '1.0.1', '1.1.0-beta.2');
      const run = await update('1.1.0-beta.1', { ...state, gateConfig: gate('left-pad,@rarog/serv'), installCode: 1,
        installStderr: 'npm error code ETARGET\n',
        times: timesView({ created: OLD, '1.0.1': OLD, '1.1.0-beta.1': OLD, '1.1.0-beta.2': THREE_DAYS }) },
      ['--beta']);
      expect(flat(run.screen)).toContain('! Download rarog 1.1.0-beta.2 is 3 days old; npm installs it from 2026-11-18');
    });

    it.each([
      ['before is set', { held: ['1.1.0-beta.2'], gateConfig: gate('', '2026-11-01') }],
      ['a dependency of the package is too young', { gateConfig: gate(), installCode: 1,
        installStderr: 'npm error code ETARGET\n' }],
    ])('--beta, %s → the text of today, without a date', async (_case, extra: RegistryState) => {
      const state = registry('1.1.0-beta.1', '1.0.1', '1.1.0-beta.2');
      const run = await update('1.1.0-beta.1', { ...state, ...extra,
        times: timesView({ created: OLD, '1.0.1': OLD, '1.1.0-beta.1': OLD, '1.1.0-beta.2': OLD }) }, ['--beta']);
      expect(run.code, run.screen).toBe(0);
      expect(flat(run.screen)).toContain('! Download rarog 1.1.0-beta.2 not installed yet (npm age gate)');
      expect(started()).toBeNull();
    });
  });
});

describe('rarog update: what the Download step refuses on each channel', () => {
  it('without a flag, the age gate leaves a pre-release of the range (1.1.0 too young) → refused, nothing installed',
    async () => {
      const state = registry('1.1.0-beta.1', '1.1.0', null, { '1.0.1': {}, '1.1.0-beta.2': {} });
      const run = await update('1.1.0-beta.1', { ...state, held: ['1.1.0'] });
      expect(run.code, run.screen).toBe(1);
      expect(packSpec()).toBe('@rarog/server@>1.1.0-beta.1 <=1.1.0');
      expect(npmArgs().some((args) => args.startsWith('i '))).toBe(false);
      const screen = flat(run.screen);
      expect(screen).toContain('✗ Download npm gave the pre-release 1.1.0-beta.2; rarog update without --beta installs'
        + ' only releases');
      expect(screen).toContain('Fix: rarog update --beta, or rarog update again later');
      expect(started()).toBeNull();
      expect(existsSync(workDir())).toBe(false);
    });

  it('--beta: a tarball of another version than the target → refused before any check or install', async () => {
    const state = registry('1.1.0-beta.1', '1.0.1', '1.1.0-beta.2');
    const run = await update('1.1.0-beta.1', { ...state, pack: { version: '1.1.0-beta.1' } }, ['--beta']);
    expect(run.code, run.screen).toBe(1);
    expect(npmArgs().at(-1)).toMatch(/^pack @rarog\/server@1\.1\.0-beta\.2 /u);
    expect(flat(run.screen)).toContain('✗ Download npm gave 1.1.0-beta.1, not 1.1.0-beta.2');
    expect(started()).toBeNull();
  });

  it('--beta: the engines of the target, not of latest, decide', async () => {
    const state = registry('1.1.0-beta.1', '1.0.1', '1.1.0-beta.2', { '1.1.0-beta.2': { engines: { node: '>=99' } } });
    const run = await update('1.1.0-beta.1', state, ['--beta']);
    expect(run.code, run.screen).toBe(1);
    expect(flat(run.screen)).toContain(`✗ Download rarog 1.1.0-beta.2 needs Node >=99; this is ${process.versions.node}`);
    expect(npmArgs().some((args) => args.startsWith('pack '))).toBe(false);
  });

  it('--beta: a beta tag of another shape counts as none → latest, with a warning', async () => {
    const run = await update('1.0.1', { ...registry('1.0.1', '1.0.2', '1.1.0-rc.1') }, ['--beta']);
    expect(run.code, run.screen).toBe(0);
    expect(installedVersion()).toBe('1.0.2');
    expect(flat(run.screen)).toContain('! Download rarog 1.0.2 from npm; npm\'s beta tag is not a beta version');
  });

  it('--beta: a latest tag that is not a release → refused, nothing downloaded', async () => {
    const run = await update('1.0.1', { versions: {}, distTags: { latest: 'next' } }, ['--beta']);
    expect(run.code, run.screen).toBe(1);
    expect(flat(run.screen)).toContain('✗ Download npm gave no version of @rarog/server');
    expect(run.screen).toMatch(/Fix: rarog update --beta again later/u);
    expect(npmArgs()).toEqual(['prefix -g', 'view @rarog/server dist-tags --json']);
  });

  it('--finish with --beta is a usage error: the finish downloads nothing', async () => {
    await expect(update('1.0.1', {}, ['--finish', '--beta'])).rejects.toThrow(/--finish downloads nothing/u);
  });
});

describe('rarog update: the channel rules', () => {
  const cases = JSON.parse(readFileSync(path.join(REPO, 'shared', 'fixtures', 'release-version', 'cases.json'), 'utf8')) as {
    stable: string[]; beta: string[]; rejected: string[];
  };

  it('isBetaVersion: every beta of the release version cases, no stable and no rejected one', () => {
    for (const version of cases.beta) expect(isBetaVersion(version), version).toBe(true);
    for (const version of [...cases.stable, ...cases.rejected]) expect(isBetaVersion(version), version).toBe(false);
  });

  it('channelTarget: the higher of beta and latest; a beta of another shape or none is a note', () => {
    expect(channelTarget({ latest: '1.0.1', beta: '1.1.0-beta.2' }))
      .toEqual({ latest: '1.0.1', beta: '1.1.0-beta.2', target: '1.1.0-beta.2', note: null });
    expect(channelTarget({ latest: '1.1.0', beta: '1.1.0-beta.2' })?.target).toBe('1.1.0');
    expect(channelTarget({ latest: '1.1.0', beta: '1.1.0-beta.10', next: '2.0.0' })?.target).toBe('1.1.0');
    expect(channelTarget({ latest: '1.0.1' })).toMatchObject({ target: '1.0.1', note: 'npm has no beta tag' });
    for (const beta of [...cases.stable, ...cases.rejected, 7]) {
      expect(channelTarget({ latest: '1.0.1', beta }), String(beta))
        .toMatchObject({ target: '1.0.1', beta: null, note: 'npm\'s beta tag is not a beta version' });
    }
    for (const tags of [null, [], 'x', {}, { latest: '1.1.0-beta.1' }, { latest: 'latest' }, { latest: 1 }]) {
      expect(channelTarget(tags), JSON.stringify(tags)).toBeNull();
    }
  });

  it('gateExcludes: one name, a list, a pattern of npm config get; another name or pattern does not match', () => {
    const config = (exclude: string): string => `min-release-age=7\nbefore=null\nmin-release-age-exclude=${exclude}\n`;
    for (const exclude of ['@rarog/server', 'left-pad, @rarog/server', '@rarog/*', '@*/server', '**', '@rarog/**/server',
      '@rarog/[s]erver', '@rarog/{server,relay}']) {
      expect(gateExcludes(config(exclude), '@rarog/server'), exclude).toBe(true);
    }
    for (const exclude of ['', 'left-pad', '@rarog/serv', '*', '@rarog', 'rarog', '!@rarog/server', '@other/*']) {
      expect(gateExcludes(config(exclude), '@rarog/server'), exclude).toBe(false);
    }
    expect(gateExcludes('min-release-age=7\nbefore=null\n', '@rarog/server')).toBe(false);
  });
});
