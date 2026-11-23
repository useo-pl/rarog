/**
 * Strażnik epoki uwierzytelnienia i nazwy w `rarog serve`: epoka domyślna przy urządzeniach z jawnej innej
 * epoki = odmowa startu; `--check` mówi, skąd epoka i jakie nazwy dostaje serwer.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../src/config-env.ts';
import { DEFAULT_AUTH_EPOCH, loadConfig } from '../src/config.ts';
import { DEVICES_FILENAME, activeDeviceEpochs } from '../src/auth/devices-store.ts';
import { main } from '../src/cli/main.ts';
import type { CliIo } from '../src/cli/io.ts';
import { realRarogDirsCreated, tempHome } from './rarog-home.ts';
import type { TempHome } from './rarog-home.ts';

const ORIGIN = 'https://rarog.example.net';

let home: TempHome;
beforeEach(() => { home = tempHome('straznik-epoki-'); });
afterEach(() => { home.cleanup(); });
afterAll(() => { expect(realRarogDirsCreated()).toEqual([]); });

const configDir = (): string => path.join(home.home, '.config', 'rarog');
const dataDir = (): string => path.join(home.home, 'xdg', 'rarog');

function writeConfig(env: Record<string, string>): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(path.join(configDir(), 'config.json'), JSON.stringify({ version: 1, env }));
}

function parentEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: home.env['PATH'], HOME: home.home, XDG_DATA_HOME: path.join(home.home, 'xdg'),
    TMPDIR: path.join(home.home, 'tmp'), ...extra,
  };
}

async function serve(argv: readonly string[], env: NodeJS.ProcessEnv = parentEnv()):
  Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; }, env, cwd: home.home,
  };
  const code = await main(['serve', ...argv], io);
  return { code, stdout, stderr };
}

/** Rekord urządzenia w kształcie `devices.json` (wartości syntetyczne, aktywny teraz). */
function deviceRecord(epoch: string, id = 'a'.repeat(32)): Record<string, unknown> {
  return {
    id, secretHash: 'b'.repeat(64), pushKey: 'c'.repeat(43), kid: 'deadbeef', label: 'iPad', build: null,
    createdAt: new Date(Date.now() - 60_000).toISOString(), lastSeenAt: new Date().toISOString(), epoch,
    creator: 'admin',
  };
}

function writeDevices(file: string, records: readonly Record<string, unknown>[]): string {
  mkdirSync(path.dirname(file), { recursive: true });
  const text = `${JSON.stringify({ version: 1, serverId: 'f'.repeat(32), devices: records, revoked: [] }, null, 2)}\n`;
  writeFileSync(file, text);
  return text;
}

describe('rarog serve: nazwy rejestru', () => {
  it('--port i --env z portem naraz = złe wywołanie', async () => {
    writeConfig({ RAROG_ORIGINS: ORIGIN });
    const both = await serve(['--print-env', '--port', '18999', '--env', 'RAROG_PORT=18998']);
    expect(both.code).toBe(64);
    expect(both.stderr).toContain('--port and --env RAROG_PORT cannot be used together');
  });

  it('--check: źródło epoki i nazwy środowiska wynikowego', async () => {
    writeConfig({ RAROG_ORIGINS: ORIGIN, RAROG_AUTH_EPOCH: '3' });
    const result = await serve(['--check']);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('epoch: from RAROG_AUTH_EPOCH');
    const names = result.stdout.split('\n').find((line) => line.startsWith('environment names: '));
    expect(names).toContain('RAROG_ORIGINS');
    writeConfig({ RAROG_ORIGINS: ORIGIN });
    const defaults = await serve(['--check']);
    expect(defaults.stdout).toContain(`epoch: default (${DEFAULT_AUTH_EPOCH})`);
  });
});

describe('strażnik epoki: epoka domyślna a urządzenia z jawnej innej epoki', () => {
  const production = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    HOME: home.home, XDG_DATA_HOME: path.join(home.home, 'xdg'), RAROG_ORIGINS: ORIGIN, ...extra,
  });
  const devicesFile = (): string => path.join(dataDir(), DEVICES_FILENAME);

  it('brak epoki, aktywne urządzenie z epoką 2: ConfigError z komendą naprawy, plik bez zmian', () => {
    const before = writeDevices(devicesFile(), [deviceRecord('2')]);
    const attempt = (): unknown => loadConfig(production());
    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow(/with epoch 2/);
    expect(attempt).toThrow('"RAROG_AUTH_EPOCH": "2"');
    expect(readFileSync(devicesFile(), 'utf8')).toBe(before);
    expect(existsSync(`${devicesFile()}.bak`)).toBe(false);
  });

  it('epoka jawnie ustawiona: start przechodzi (celowa zmiana epoki też)', () => {
    writeDevices(devicesFile(), [deviceRecord('2')]);
    expect(loadConfig(production({ RAROG_AUTH_EPOCH: '2' })).epoch).toBe('2');
    expect(loadConfig(production({ RAROG_AUTH_EPOCH: '3' })).epoch).toBe('3');
  });

  it('urządzenia z epoką domyślną, wygasłe z inną epoką albo brak pliku: strażnik milczy', () => {
    expect(loadConfig(production()).epoch).toBe(DEFAULT_AUTH_EPOCH);
    writeDevices(devicesFile(), [deviceRecord(DEFAULT_AUTH_EPOCH)]);
    expect(loadConfig(production()).epoch).toBe(DEFAULT_AUTH_EPOCH);
    const stale = { ...deviceRecord('2'), lastSeenAt: new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString() };
    writeDevices(devicesFile(), [stale]);
    expect(activeDeviceEpochs(dataDir())).toEqual([]);
    expect(loadConfig(production()).epoch).toBe(DEFAULT_AUTH_EPOCH);
  });

  it('nieczytelny devices.json i poprawny .bak z inną epoką: odmowa jak przy starcie magazynu, bez zapisu', () => {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(devicesFile(), '{zepsuty');
    const bak = writeDevices(`${devicesFile()}.bak`, [deviceRecord('2')]);
    expect(activeDeviceEpochs(dataDir())).toEqual(['2']);
    expect(() => loadConfig(production())).toThrow(ConfigError);
    expect(readFileSync(devicesFile(), 'utf8')).toBe('{zepsuty');
    expect(readFileSync(`${devicesFile()}.bak`, 'utf8')).toBe(bak);
  });

  it('serve --check odmawia tym samym zdaniem; demo strażnika nie budzi', async () => {
    writeDevices(devicesFile(), [deviceRecord('2')]);
    writeConfig({ RAROG_ORIGINS: ORIGIN });
    const result = await serve(['--check']);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(`epoch: default (${DEFAULT_AUTH_EPOCH})`);
    expect(result.stderr).toContain('the start would revoke them all');
    expect(loadConfig({ ...production(), RAROG_DEMO: '1' }).demo).toBe(true);
  });

  it('zwykłe demo na katalogu z devices.json z inną epoką: strażnik nie czyta pliku serwera', () => {
    writeDevices(devicesFile(), [deviceRecord('2')]);
    expect(loadConfig({ ...production(), RAROG_DEMO: '1', RAROG_DATA_DIR: dataDir() }).epoch)
      .toBe(DEFAULT_AUTH_EPOCH);
  });
});

describe('zwykłe demo: sprawdzenie przed startem czyta plik demo, jak serwer', () => {
  /** Plik magazynu w formacie nowszym niż znany: `--check` odmawia, gdy serwer by go czytał. */
  function writeNewer(file: string): void {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 2, serverId: 'f'.repeat(32), devices: [], revoked: [] }));
  }

  it('serve --check w zwykłym demo patrzy na devices.demo.json, a bez demo na devices.json', async () => {
    writeConfig({ RAROG_ORIGINS: ORIGIN });
    const demo = ['--check', '--data-dir', dataDir(), '--env', 'RAROG_DEMO=1'];
    writeNewer(path.join(dataDir(), DEVICES_FILENAME));
    expect((await serve(demo)).code).toBe(0);

    rmSync(path.join(dataDir(), DEVICES_FILENAME));
    const demoFile = path.join(dataDir(), 'devices.demo.json');
    writeNewer(demoFile);
    const refused = await serve(demo);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(`${demoFile}: format version 2`);
    expect((await serve(['--check', '--data-dir', dataDir()])).code).toBe(0);
  });
});
