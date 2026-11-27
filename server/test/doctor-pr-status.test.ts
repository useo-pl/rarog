/**
 * `rarog doctor`, the PR status line (`server/src/cli/doctor-pr-status.ts`): the four states against the fake `gh`
 * (`helpers/atrapa-gh.mjs`) found through a directory list of the test.
 *
 * - `RAROG_PR_STATUS=0` → info that session cards show no PRs, no lookup, no process;
 * - no `gh` in the directories → warn that session cards show no PRs, with a fix;
 * - `gh auth status` with exit ≠ 0 → warn "not logged in", session cards show no PRs;
 * - exit 0 → ok with the program path;
 * - a `gh` that refuses a flag of the check (older than the flags) → warn "update gh", never "not logged in";
 * - demo and its review mode → info about the fixed state source, no lookup and no process.
 *
 * The check runs `gh auth status --active --no-refresh --hostname github.com` with the closed environment: no server
 * secret, no `GH_TOKEN`.
 * The tests start processes: run them outside the sandbox.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { prStatusLine, prStatusLineOf } from '../src/cli/doctor-pr-status.ts';
import { GH_AUTH_ARGV, GH_DIRECTORIES, checkGhAuth } from '../src/pr-status/index.ts';
import type { GhAuthState } from '../src/pr-status/index.ts';

const ATRAPA = fileURLToPath(new URL('./helpers/atrapa-gh.mjs', import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A directory with the fake `gh` answering `auth status` with `exit`, and an empty directory before it. */
function stand(
  exit: number | null, stderr = 'gho_SAMPLE acme/widget',
): { dir: string; bin: string; directories: string[]; calls(): unknown[] } {
  const dir = mkdtempSync(join(tmpdir(), 'rarog-doctor-pr-'));
  dirs.push(dir);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  if (exit !== null) {
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\nexec '${process.execPath}' '${ATRAPA}' '${dir}' "$@"\n`, { mode: 0o755 });
    writeFileSync(join(dir, 'scenario.json'), JSON.stringify([{ stdout: '', stderr, exit }]));
  }
  const file = join(dir, 'calls.jsonl');
  return {
    dir, bin, directories: [join(dir, 'missing'), bin],
    calls: () => (existsSync(file)
      ? readFileSync(file, 'utf8').split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as unknown)
      : []),
  };
}

const env = (extra: Record<string, string> = {}): Record<string, string> => ({
  HOME: '/nonexistent/home', USER: 'u', LOGNAME: 'u', PATH: '/usr/bin:/bin', SONIOX_API_KEY: 'soniox-sample',
  GH_TOKEN: 'gho_mustnotpass', RAROG_PORT: '8930', ...extra,
});

describe('rarog doctor: PR status line', () => {
  it('`RAROG_PR_STATUS=0`: info, no lookup and no process', async () => {
    const s = stand(0);
    const line = await prStatusLine(env({ RAROG_PR_STATUS: '0' }), { directories: s.directories });
    expect(line).toEqual({ verdict: 'info', text: 'PR status: off (RAROG_PR_STATUS=0), so session cards show no PRs' });
    expect(s.calls()).toEqual([]);
  });

  it('no gh in the directories: warn with the list and a fix', async () => {
    const s = stand(null);
    const line = await prStatusLine(env(), { directories: s.directories });
    expect(line).toEqual({
      verdict: 'warn',
      text: `PR status: gh not found in ${s.directories.join(', ')}, so session cards show no PRs`,
      repair: 'install the GitHub CLI (gh) in one of these directories, run gh auth login --hostname github.com and'
        + ' restart the server, or set RAROG_PR_STATUS=0 in config.json',
    });
  });

  it('gh not logged in (exit ≠ 0): warn with `gh auth login`, nothing of its output on the line', async () => {
    const s = stand(1);
    const line = await prStatusLine(env(), { directories: s.directories });
    expect(line).toEqual({
      verdict: 'warn',
      text: `PR status: ${join(s.bin, 'gh')} is not logged in to github.com, so session cards show no PRs`,
      repair: 'gh auth login --hostname github.com as the user the service runs as; the server picks it up within'
        + ' 30 min, without a restart',
    });
    expect(JSON.stringify(line)).not.toContain('gho_');
  });

  it('gh logged in (exit 0): ok; argv checks the active account without refreshing, closed environment', async () => {
    const s = stand(0);
    const line = await prStatusLine(env(), { directories: s.directories });
    expect(line).toEqual({ verdict: 'ok', text: `PR status: ${join(s.bin, 'gh')} logged in to github.com` });
    const calls = s.calls() as { argv: string[]; env: Record<string, string> }[];
    expect(calls.map((call) => call.argv)).toEqual([[...GH_AUTH_ARGV]]);
    // `--active`: only the account the reads use; `--no-refresh`: the check never writes a refreshed token.
    expect(GH_AUTH_ARGV).toEqual(['auth', 'status', '--active', '--no-refresh', '--hostname', 'github.com']);
    const seen = calls[0]?.env ?? {};
    for (const name of ['SONIOX_API_KEY', 'GH_TOKEN', 'RAROG_PORT']) expect(seen[name], name).toBeUndefined();
    expect(seen['HOME']).toBe('/nonexistent/home');
  });

  it('the default directory list is the server one; a check that did not finish is a warn', () => {
    expect(prStatusLineOf({ flag: '', gh: null, auth: null }).text)
      .toBe(`PR status: gh not found in ${GH_DIRECTORIES.join(', ')}, so session cards show no PRs`);
    expect(prStatusLineOf({ flag: '', gh: '/x/gh', auth: 'failed' })).toEqual({
      verdict: 'warn',
      text: 'PR status: gh auth status --active --no-refresh --hostname github.com did not finish (/x/gh)',
      repair: 'run gh auth status --active --no-refresh --hostname github.com in a terminal',
    });
  });

  it('a gh that refuses a flag of the check: warn "update gh", never "not logged in", none of its output', async () => {
    const usage = 'unknown flag: --active\n\nUsage:  gh auth status [flags]\n  gho_SAMPLE acme/widget\n';
    const s = stand(1, usage);
    const line = await prStatusLine(env(), { directories: s.directories });
    expect(line).toEqual({
      verdict: 'warn',
      text: `PR status: ${join(s.bin, 'gh')} does not know gh auth status --active --no-refresh, so the login was`
        + ' not checked',
      repair: 'update the GitHub CLI (gh) and run rarog doctor again',
    });
    expect(JSON.stringify(line)).not.toContain('gho_');
    expect(s.calls()).toHaveLength(1);
    expect(await checkGhAuth(join(s.bin, 'gh'), env())).toBe('outdated-gh');
    expect(await checkGhAuth(join(stand(1, 'unknown flag: --no-refresh\n').bin, 'gh'), env())).toBe('outdated-gh');
  });
});

describe('rarog doctor: PR status in the demo and its review mode', () => {
  const REVIEW = { RAROG_DEMO_REVIEW_CODE: 'A'.repeat(43), RAROG_DATA_DIR: '/nonexistent/data' };
  const DEMO_LINE = { verdict: 'info', text: 'PR status: demo, fixed states (RAROG_DEMO=1), gh not used' };

  for (const [name, extra] of [
    ['demo', { RAROG_DEMO: '1' }],
    ['demo (`true`)', { RAROG_DEMO: 'true' }],
    ['review mode', { RAROG_DEMO: '1', ...REVIEW }],
  ] as const) {
    it(`${name}: info about the fixed source, no lookup and no process`, async () => {
      const s = stand(0);
      let checks = 0;
      const check = (): Promise<GhAuthState> => { checks += 1; return Promise.resolve('logged-in'); };
      expect(await prStatusLine(env(extra), { directories: s.directories, check })).toEqual(DEMO_LINE);
      expect(checks).toBe(0);
      expect(s.calls()).toEqual([]);
    });

    it(`${name} without gh: the same info line, no warn`, async () => {
      const s = stand(null);
      expect(await prStatusLine(env(extra), { directories: s.directories })).toEqual(DEMO_LINE);
    });
  }
});

describe('rarog doctor: PR status without a service environment', () => {
  it('no usable config.json: info, no lookup and no process', async () => {
    const s = stand(0);
    expect(await prStatusLine(null, { directories: s.directories })).toEqual({
      verdict: 'info', text: 'PR status: not checked (config.json gives no service environment)',
    });
    expect(s.calls()).toEqual([]);
  });
});
