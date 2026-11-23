/**
 * Start of the PR status (`server/src/bootstrap/pr-status.ts`) and its flag: which source each mode gets.
 *
 * - `RAROG_PR_STATUS=0` → no tracker, the `gh` source is never created;
 * - demo and its review mode → the fixed map (the titled demo PR merged, the bare one without a state, plus the PR
 *   states of the active content set), read at once, the `gh` source never created;
 * - real mode → the `gh` source with the server environment cut to the closed list;
 * - the flag: missing, empty or `1` = on, `0` = off, anything else stops the start.
 */
import { describe, expect, it, vi } from 'vitest';
import { createPrStatus } from '../src/bootstrap/pr-status.ts';
import { ConfigError, loadConfig } from '../src/config.ts';
import type { RarogConfig } from '../src/config.ts';
import { PR_STATUS_ENV_PASSTHROUGH } from '../src/config-env.ts';
import { demoContentEn } from '../src/demo/content/en.ts';
import type { DemoContent } from '../src/demo/content/types.ts';
import { DEMO_PULL_REQUESTS, demoPullRequestStates } from '../src/demo/seeds.ts';
import type { GhSourceOptions, PrStateSource } from '../src/pr-status/index.ts';
import type { Logger } from '../src/router.ts';

const log: Logger = { info: () => undefined, error: () => undefined };

/** A `gh` source factory that records its options and answers nothing. */
function ghSpy(): { factory: (opts: GhSourceOptions) => PrStateSource; calls: GhSourceOptions[] } {
  const calls: GhSourceOptions[] = [];
  return {
    calls,
    factory: (opts) => {
      calls.push(opts);
      return { read: () => Promise.resolve({ ok: false, failure: 'error' }) };
    },
  };
}

type PrConfig = Pick<RarogConfig, 'demo' | 'prStatusEnabled' | 'prStatusEnvBase'>;
const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 20); });

describe('createPrStatus: the source of each mode', () => {
  it('`RAROG_PR_STATUS=0`: no tracker, no gh source, in real mode and in the demo', async () => {
    for (const demo of [false, true]) {
      const gh = ghSpy();
      const config: PrConfig = { demo, prStatusEnabled: false, prStatusEnvBase: { HOME: '/h' } };
      expect(await createPrStatus(config, log, demo ? demoContentEn : null, { ghSource: gh.factory })).toBeNull();
      expect(gh.calls).toEqual([]);
    }
  });

  it.each([
    ['demo', { RAROG_DEMO: '1' }],
    ['review mode', { RAROG_DEMO: '1', RAROG_DEMO_REVIEW_CODE: 'a'.repeat(43), RAROG_ORIGINS: 'https://review.example',
      RAROG_DATA_DIR: '/nonexistent/rarog-review' }],
  ])('%s: the fixed map, read without delay, the gh source never created', async (_name, env) => {
    const config = loadConfig({ ...env, HOME: '/h', PATH: '/usr/bin' });
    expect(config.demo).toBe(true);
    const gh = ghSpy();
    const link = await createPrStatus(config, log, demoContentEn, { ghSource: gh.factory });
    if (link === null) throw new Error('the demo has a PR status');
    const changed = vi.fn();
    link.port.listen(changed);
    link.tracker.setClientConnected(true);
    link.port.setSessionUrls('demo', [DEMO_PULL_REQUESTS.titled, DEMO_PULL_REQUESTS.bare, DEMO_PULL_REQUESTS.draft]);
    await settle();
    expect(link.port.stateOf(DEMO_PULL_REQUESTS.titled)).toBe('merged');
    expect(link.port.stateOf(DEMO_PULL_REQUESTS.bare)).toBeUndefined();
    expect(link.port.stateOf(DEMO_PULL_REQUESTS.draft)).toBe('draft');
    expect(changed).toHaveBeenCalledTimes(1);
    expect(gh.calls).toEqual([]);
    link.tracker.close();
  });

  it('the demo map carries the PR states of the active content set; the language sets add none', async () => {
    const own = 'https://github.com/acme/sample/pull/3';
    const content: DemoContent = { ...demoContentEn, pullRequestStates: [[own, 'open']] };
    const link = await createPrStatus(loadConfig({ RAROG_DEMO: '1', HOME: '/h', PATH: '/usr/bin' }), log, content);
    if (link === null) throw new Error('the demo has a PR status');
    link.tracker.setClientConnected(true);
    link.port.setSessionUrls('demo', [own, DEMO_PULL_REQUESTS.titled]);
    await settle();
    expect(link.port.stateOf(own)).toBe('open');
    expect(link.port.stateOf(DEMO_PULL_REQUESTS.titled)).toBe('merged');
    expect(demoPullRequestStates(demoContentEn).has(own)).toBe(false);
    link.tracker.close();
  });

  it('real mode: the gh source with the server environment cut to the closed list', async () => {
    const config = loadConfig({
      RAROG_ORIGINS: 'https://rarog.example', HOME: '/Users/u', USER: 'u', LOGNAME: 'u', LANG: 'pl_PL.UTF-8',
      TMPDIR: '/tmp/u', PATH: '/usr/bin', SHELL: '/bin/zsh', SONIOX_API_KEY: 'soniox-sample',
      RAROG_HERDR_SOCKET: '/nonexistent/herdr.sock', RAROG_DATA_DIR: '/nonexistent/rarog',
    });
    const gh = ghSpy();
    const link = await createPrStatus(config, log, null, { ghSource: gh.factory });
    expect(link).not.toBeNull();
    expect(gh.calls).toEqual([{
      env: { HOME: '/Users/u', USER: 'u', LOGNAME: 'u', LANG: 'pl_PL.UTF-8', TMPDIR: '/tmp/u', PATH: '/usr/bin' },
    }]);
    expect(Object.keys(gh.calls[0]?.env ?? {}).sort()).toEqual([...PR_STATUS_ENV_PASSTHROUGH].sort());
    link?.tracker.close();
  });
});

describe('`RAROG_PR_STATUS`', () => {
  it('missing, empty or `1` = on, `0` = off, anything else stops the start', () => {
    const flag = (value?: string): boolean => loadConfig({
      RAROG_DEMO: '1', ...(value === undefined ? {} : { RAROG_PR_STATUS: value }),
    }).prStatusEnabled;
    expect(flag()).toBe(true);
    expect(flag('')).toBe(true);
    expect(flag('1')).toBe(true);
    expect(flag('0')).toBe(false);
    expect(() => flag('off')).toThrow(ConfigError);
    expect(() => flag('off')).toThrow('RAROG_PR_STATUS takes 1 or 0 (got: off).');
  });
});
