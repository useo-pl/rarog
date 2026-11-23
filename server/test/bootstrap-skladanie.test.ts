/**
 * Składanie startu serwera w `server/src/bootstrap/` na atrapach: moduły importują się bez startu serwera
 * (import `server/src/index.ts` startuje `main()`), więc to, co wcześniej sprawdzał tylko proces potomny albo skan
 * źródła, da się wywołać wprost.
 */
import http from 'node:http';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeviceAuth, DEVICE_SWEEP_MS, startDeviceSweep } from '../src/bootstrap/devices.ts';
import { HOOK_HEALTH_TTL_MS, healthProbes, hookHealthProbe } from '../src/bootstrap/health.ts';
import { startServerIroh } from '../src/bootstrap/iroh.ts';
import { createPush, PUSH_RELAY_DISABLED_LOG } from '../src/bootstrap/push.ts';
import { ConfigError, loadConfig } from '../src/config.ts';
import type { RarogConfig } from '../src/config.ts';
import { IROH_KEY_ENV } from '../src/config-env.ts';
import { demoMacStats } from '../src/demo/mac.ts';
import type { Logger } from '../src/router.ts';
import { TEST_DEVICE_ID, addTestDevice } from './helpers/urzadzenie.ts';

/** Logger zbierający linie: `info` i `error` osobno. */
function zbieraczLogu(): Logger & { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
  return { info: vi.fn(), error: vi.fn() } as never;
}

let dir: string;
let config: RarogConfig;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rarog-bootstrap-'));
  config = loadConfig({ RAROG_DEMO: '1', RAROG_DATA_DIR: dir });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('startServerIroh', () => {
  it('bez `RAROG_IROH` nie otwiera endpointu i nie dotyka serwera', async () => {
    const server = http.createServer();
    const log = zbieraczLogu();
    const przed = server.listenerCount('connection');
    await expect(startServerIroh({ ...config, iroh: null }, server, log)).resolves.toBeNull();
    expect(server.listenerCount('connection')).toBe(przed);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('flaga bez klucza to błąd konfiguracji z nazwą zmiennej, zanim cokolwiek się załaduje', async () => {
    const iroh = { key: null, relay: 'https://relay.example', port: 0 } as unknown as RarogConfig['iroh'];
    const err = await startServerIroh({ ...config, iroh }, http.createServer(), zbieraczLogu()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toContain(IROH_KEY_ENV);
  });
});

describe('createPush', () => {
  it('bez kanału APNs: obecność jest, harmonogramu nie ma, log mówi „off”, managera nikt nie pyta', () => {
    const log = zbieraczLogu();
    const { devices } = createDeviceAuth(config, log);
    const managerRef = vi.fn(() => null);
    const push = createPush(config, { managerRef, devices, macStats: demoMacStats(), log });
    expect(push.apns).toBeUndefined();
    expect(push.notifier).toBeNull();
    expect(typeof push.presence.note).toBe('function');
    expect(log.info).toHaveBeenCalledWith(
      'push: notifications off (no complete RAROG_APNS_* set and no RAROG_PUSH_RELAY_URL, or RAROG_PUSH=0)',
    );
    expect(managerRef).not.toHaveBeenCalled();
  });

  it('zła wartość przekaźnika: linia logu startu z powodem', () => {
    const log = zbieraczLogu();
    const { devices } = createDeviceAuth(config, log);
    createPush({ ...config, pushRelayIssue: 'not https' }, {
      managerRef: () => null, devices, macStats: demoMacStats(), log,
    });
    expect(log.info).toHaveBeenCalledWith(`${PUSH_RELAY_DISABLED_LOG} — not https`);
  });
});

describe('healthProbes', () => {
  it('bez herdr sonda mówi `false`; tryb recenzji bez sondy hooka; bez SDK bez pola `sdk`', async () => {
    const { devices } = createDeviceAuth(config, zbieraczLogu());
    const review = { serverName: 'x', model: 'm', effort: 'e' } as never;
    const probes = healthProbes({ config, herdr: null, term: null, reviewConstants: review, devices, sdk: null, home: dir });
    await expect(probes.herdr()).resolves.toBe(false);
    expect(probes.term).toBe(false);
    expect('hook' in probes).toBe(false);
    expect('sdk' in probes).toBe(false);
    expect('consent' in probes).toBe(false);
    expect(probes.authStore?.()).toBe(devices.status);
  });

  it('poza trybem recenzji sonda hooka jest i pyta o żywy ping herdr', async () => {
    const { devices } = createDeviceAuth(config, zbieraczLogu());
    const probe = vi.fn(() => Promise.resolve(true));
    const probes = healthProbes({ config, herdr: { probe }, term: null, reviewConstants: null, devices, sdk: null, home: dir });
    await expect(probes.herdr()).resolves.toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(typeof probes.hook).toBe('function');
  });
});

describe('hookHealthProbe', () => {
  it('odczyt żyje przez termin ważności, potem jest liczony od nowa', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const probe = hookHealthProbe(dir, dir);
    const first = probe();
    vi.advanceTimersByTime(HOOK_HEALTH_TTL_MS - 1);
    expect(probe()).toBe(first);
    vi.advanceTimersByTime(1);
    expect(probe()).not.toBe(first);
  });
});

describe('createDeviceAuth: plik magazynu urządzeń według trybu', () => {
  const ORIGIN = 'https://rarog.example';
  const on = (name: string): boolean => existsSync(join(dir, name));

  it('serwer bez demo i tryb recenzji: devices.json, pliku demo nie ma', async () => {
    const server = createDeviceAuth(loadConfig({ RAROG_DATA_DIR: dir, RAROG_ORIGINS: ORIGIN }), zbieraczLogu());
    await server.devices.flush();
    expect([on('devices.json'), on('devices.demo.json')]).toEqual([true, false]);
    rmSync(join(dir, 'devices.json'));
    const review = loadConfig({
      RAROG_DEMO: '1', RAROG_DEMO_REVIEW_CODE: randomBytes(32).toString('base64url'), RAROG_DATA_DIR: dir,
      RAROG_ORIGINS: ORIGIN,
    });
    await createDeviceAuth(review, zbieraczLogu()).devices.flush();
    expect([on('devices.json'), on('devices.demo.json')]).toEqual([true, false]);
  });

  it('zwykłe demo bez RAROG_DATA_DIR: <tmp>/rarog-demo/devices.demo.json', async () => {
    vi.stubEnv('TMPDIR', dir);
    const demo = loadConfig({ RAROG_DEMO: '1' });
    expect(demo.dataDir).toBe(join(dir, 'rarog-demo'));
    await createDeviceAuth(demo, zbieraczLogu()).devices.flush();
    expect([on('rarog-demo/devices.demo.json'), on('rarog-demo/devices.json')]).toEqual([true, false]);
  });

  it('zwykłe demo: kopia to devices.demo.json.bak, a start po uszkodzeniu pliku demo czyta tę kopię', async () => {
    const first = createDeviceAuth(config, zbieraczLogu()).devices;
    addTestDevice(first);
    // Drugi zapis robi z pliku z urządzeniem kopię `.bak`.
    await first.persist();
    await first.persist();
    expect([on('devices.demo.json.bak'), on('devices.json.bak')]).toEqual([true, false]);
    writeFileSync(join(dir, 'devices.demo.json'), '{zepsuty');
    const restored = createDeviceAuth(config, zbieraczLogu()).devices;
    expect(restored.status).toBe('ok');
    expect(restored.get(TEST_DEVICE_ID)?.id).toBe(TEST_DEVICE_ID);
  });
});

describe('startDeviceSweep', () => {
  it('podpina skutki odpięcia, robi pierwszy przebieg od razu i następne co minutę', () => {
    vi.useFakeTimers();
    const sweep = vi.fn();
    const onDeactivate = vi.fn(() => () => undefined);
    const devices = { sweep, onDeactivate } as never;
    const timer = startDeviceSweep(devices, {
      pairing: {} as never, hub: { closeOwner: () => 0 }, log: () => undefined,
    });
    expect(onDeactivate).toHaveBeenCalledTimes(1);
    expect(sweep).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(DEVICE_SWEEP_MS);
    expect(sweep).toHaveBeenCalledTimes(2);
    clearInterval(timer);
  });
});
