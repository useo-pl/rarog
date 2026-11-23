/**
 * Minimum native app build (`server/src/config/clients.ts`): the default threshold carried by the package and
 * its source. A fresh package install has no `RAROG_MIN_CLIENT_BUILD` in `config.json`, so without the default the
 * consent channel (`all`, `main`) would fall back to `shadow` with the reason `min-client-build`. An explicit value
 * wins, an empty one counts as unset; clone mode and demo get no default.
 */
import { describe, expect, it } from 'vitest';
import { consentLineOf, thresholdOf } from '../src/cli/doctor.ts';
import { loadConfig } from '../src/config.ts';
import { DEFAULT_MIN_CLIENT_BUILD, minClientBuildOf } from '../src/config/clients.ts';
import { ConfigError, MIN_CLIENT_BUILD_ENV } from '../src/config-env.ts';
import { effectiveConsentMode } from '../src/herdr/dialogs/layer1/mode.ts';

const allConditions = { hook: () => 'ok' as const, consentSocket: true, adminSocket: true };

describe('minimum app build: package default and source', () => {
  it('the package default is the app build released with this server', () => {
    expect(DEFAULT_MIN_CLIENT_BUILD).toBe(5614);
  });

  it('package without env → the default; the consent channel `all` runs with the other conditions', () => {
    const resolved = minClientBuildOf(undefined, { mode: 'package', demo: false });
    expect(resolved).toEqual({ value: 5614, source: 'default' });
    expect(effectiveConsentMode('all', { ...allConditions, minClientBuild: resolved?.value }))
      .toEqual({ effective: 'all', reason: 'configured' });
  });

  it('explicit env wins: 3377 → 3377 from env', () => {
    expect(minClientBuildOf('3377', { mode: 'package', demo: false })).toEqual({ value: 3377, source: 'env' });
    expect(minClientBuildOf(' 3377 ', { mode: 'clone', demo: false })).toEqual({ value: 3377, source: 'env' });
  });

  it('empty env counts as unset', () => {
    for (const raw of ['', '  ']) {
      expect(minClientBuildOf(raw, { mode: 'package', demo: false }), raw).toEqual({ value: 5614, source: 'default' });
      expect(minClientBuildOf(raw, { mode: 'clone', demo: false }), raw).toBeUndefined();
    }
  });

  it('clone mode and demo get no default; a wrong value still stops the start', () => {
    expect(minClientBuildOf(undefined, { mode: 'clone', demo: false })).toBeUndefined();
    expect(minClientBuildOf(undefined, { mode: 'package', demo: true })).toBeUndefined();
    expect(minClientBuildOf('42', { mode: 'package', demo: true })).toEqual({ value: 42, source: 'env' });
    expect(() => minClientBuildOf('0', { mode: 'package', demo: false })).toThrow(ConfigError);
  });

  it('loadConfig: package mode takes the default, clone mode and demo stay without a threshold', () => {
    const base: NodeJS.ProcessEnv = {
      RAROG_DATA_DIR: '/nonexistent/rarog-clients-test', RAROG_ORIGINS: 'https://rarog.example',
    };
    expect(loadConfig(base, 'package').minClientBuild).toBe(5614);
    expect(loadConfig({ ...base, [MIN_CLIENT_BUILD_ENV]: '' }, 'package').minClientBuild).toBe(5614);
    expect(loadConfig({ ...base, [MIN_CLIENT_BUILD_ENV]: '3377' }, 'package').minClientBuild).toBe(3377);
    expect(loadConfig(base, 'clone')).not.toHaveProperty('minClientBuild');
    expect(loadConfig({ RAROG_DEMO: '1' }, 'package')).not.toHaveProperty('minClientBuild');
  });
});

describe('`rarog doctor`: consent channel line with the threshold', () => {
  const health = { body: { ok: true, consent: { configured: 'all', effective: 'all', reason: 'configured' } } };

  it('package default: line `ok` names the threshold and its source', () => {
    const line = consentLineOf(health, { value: 5614, source: 'default' });
    expect(line.verdict).toBe('ok');
    expect(line.text).toBe('consent channel: all (configured all, reason configured);'
      + ' minimum app build 5614 (package default)');
  });

  it('explicit env and no threshold', () => {
    expect(consentLineOf(health, { value: 3377, source: 'env' }).text)
      .toContain(`minimum app build 3377 (${MIN_CLIENT_BUILD_ENV} in config.json)`);
    expect(consentLineOf(health, null).text).toContain('minimum app build: none');
  });

  it('threshold from the server environment follows the server rule (this test runs as a clone)', () => {
    expect(thresholdOf(null)).toBeUndefined();
    expect(thresholdOf({})).toBeNull();
    expect(thresholdOf({ [MIN_CLIENT_BUILD_ENV]: '3377' })).toEqual({ value: 3377, source: 'env' });
    expect(thresholdOf({ [MIN_CLIENT_BUILD_ENV]: 'abc' })).toBeUndefined();
  });
});
