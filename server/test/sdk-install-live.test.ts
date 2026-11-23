/**
 * Pobranie SDK Claude na prawdziwym rejestrze npm: `installSdk` z `sdk-lock.json` do katalogu danych w katalogu
 * tymczasowym, potem start w trybie paczki (`loadListSessions`) i lista na pustym i niepustym magazynie.
 *
 * Test sieciowy: biegnie tylko z `RAROG_TEST_NETWORK=1` i siecią do `registry.npmjs.org`, bez zmiennej jest pominięty
 * z powodem w tytule. npm to `npm-cli.js` obok węzła testów, cache npm w katalogu tymczasowym.
 *
 * `RAROG_TEST_PACKAGE_ROOT=<katalog zainstalowanej paczki>` (zadanie `package` w CI, `scripts/package-smoke.sh`)
 * bierze `server/src/install/sdk.js` z tej paczki zamiast źródeł repo: przypięcie, `npm ci`, sonda i start w trybie
 * paczki idą kodem z tarballa. Ta zmienna bez `RAROG_TEST_NETWORK=1` to błąd pliku, nie pominięcie.
 */
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { STORE_SESSION_ID, listInChild, writeSessionStore } from './helpers/sdk-magazyn.ts';
import { tempHome } from './rarog-home.ts';
import type { TempHome } from './rarog-home.ts';

const NETWORK = process.env['RAROG_TEST_NETWORK'] === '1';
const PACKAGE_ROOT = process.env['RAROG_TEST_PACKAGE_ROOT'];
if (PACKAGE_ROOT !== undefined && !NETWORK) {
  throw new Error('RAROG_TEST_PACKAGE_ROOT bez RAROG_TEST_NETWORK=1: test paczki by się pominął');
}

/** Moduł z zainstalowanej paczki (`server/src/install/<nazwa>.js`) albo ze źródeł repo. */
async function installModule<T>(name: string, fromRepo: () => Promise<T>): Promise<T> {
  if (PACKAGE_ROOT === undefined) return fromRepo();
  return await import(pathToFileURL(path.join(PACKAGE_ROOT, 'server', 'src', 'install', `${name}.js`)).href) as T;
}

const {
  SDK_PACKAGE, installSdk, installedPackages, loadListSessions, probeSdkDir, readSdkPin, sdkVersionDir,
} = await installModule('sdk', () => import('../src/install/sdk.ts'));
const mode = await installModule('mode', () => import('../src/install/mode.ts'));

let t: TempHome;
beforeEach(() => { t = tempHome('sdk-live-'); });
afterEach(() => { t.cleanup(); });

const LIVE = { timeout: 360_000 };

describe.skipIf(!NETWORK)('SDK z rejestru npm (only with RAROG_TEST_NETWORK=1)', LIVE, () => {
  it('kod pod testem: paczka z RAROG_TEST_PACKAGE_ROOT w trybie paczki, inaczej źródła repo w trybie klonu', () => {
    if (PACKAGE_ROOT === undefined) {
      expect(mode.INSTALL_MODE).toBe('clone');
    } else {
      expect(mode.INSTALL_MODE).toBe('package');
      expect(realpathSync(mode.INSTALL_ROOT)).toBe(realpathSync(PACKAGE_ROOT));
    }
  });

  it('npm ci z przypięcia: jedna paczka z integrity z lockfile’a, start paczki ok, lista na pustym i pełnym', async () => {
    const pin = readSdkPin();
    const dataDir = path.join(t.home, 'dane');
    const env = {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: t.home, npm_config_cache: path.join(t.home, 'npm-cache'),
      ...(process.env['TMPDIR'] === undefined ? {} : { TMPDIR: process.env['TMPDIR'] }),
    };
    const result = await installSdk({ dataDir, env, probe: (dir, version) => probeSdkDir(dir, version, env) });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, raced: false });
    const dir = sdkVersionDir(dataDir, pin.version);
    expect(installedPackages(dir)).toEqual([SDK_PACKAGE]);
    const hidden = JSON.parse(readFileSync(path.join(dir, 'node_modules', '.package-lock.json'), 'utf8')) as {
      packages: Record<string, { integrity?: string; version?: string }>;
    };
    const locked = (JSON.parse(pin.lockJson) as typeof hidden).packages[`node_modules/${SDK_PACKAGE}`];
    expect(hidden.packages[`node_modules/${SDK_PACKAGE}`]).toMatchObject({
      version: pin.version, integrity: locked?.integrity,
    });

    const loaded = await loadListSessions({ dataDir, mode: 'package' });
    expect(loaded.status).toMatchObject({ state: 'ok', version: pin.version, source: dir });
    expect(typeof loaded.listSessions).toBe('function');

    const config = path.join(t.home, 'config');
    const project = path.join(t.home, 'projekt');
    const empty = path.join(t.home, 'pusty');
    for (const each of [config, project, empty]) mkdirSync(each);
    const real = writeSessionStore(config, project);
    const source = { versionDir: dir, version: pin.version };
    expect(listInChild(source, config, t.home, empty)).toEqual({ ok: true, sessions: [] });
    const full = listInChild(source, config, t.home, real);
    expect(full.ok, full.ok ? '' : full.reason).toBe(true);
    expect(full.ok ? full.sessions : []).toEqual([expect.objectContaining({ sessionId: STORE_SESSION_ID })]);
  });
});
