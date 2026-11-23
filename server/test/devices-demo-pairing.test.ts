/**
 * Kod parowania dla testów UI apki w trybie demo.
 *
 * XCUITest nie ma gniazda administracyjnego (`rarog pair`), więc demo wydaje kod „jak z Maca” trasą
 * `POST /api/demo/pairing`: odpina wszystkie urządzenia demo (każdy test paruje od zera) i oddaje kod z linkiem pod
 * adres demo. Poza demo trasy nie ma — nie da się nią ominąć zasady „kod przy aktywnym urządzeniu wydaje wyłącznie
 * sparowane urządzenie”. Prawdziwy router, magazyn i parowanie; magazyn składa `createDeviceAuth`, jak przy starcie
 * serwera, więc test widzi plik, który wybiera tryb.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@rarog/shared';
import { createDeviceStore, createLoginLimiter, deviceAuthorization } from '../src/auth/index.ts';
import type { DeviceStore, Pairing } from '../src/auth/index.ts';
import { createDeviceAuth } from '../src/bootstrap/devices.ts';
import { loadConfig } from '../src/config.ts';
import { DEMO_PAIRING_PATH, type Logger, createRouter } from '../src/router.ts';
import { SseHub } from '../src/sse.ts';
import { FakeManager, makeSummary } from './fake-manager.ts';
import { addTestDevice } from './helpers/urzadzenie.ts';

interface Harness { base: string; origin: string; store: DeviceStore; pairing: Pairing; close(): Promise<void> }

const open: Harness[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const harness of open.splice(0)) await harness.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dataDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'p3-demo-par-'));
  dirs.push(dir);
  return dir;
}

async function start(demo: boolean, dir: string = dataDir()): Promise<Harness> {
  const logger: Logger = { info: () => {}, error: () => {} };
  const origin = 'https://rarog.example';
  const config = loadConfig({
    ...(demo ? { RAROG_DEMO: '1' } : {}), RAROG_DATA_DIR: dir, RAROG_ORIGINS: origin,
  });
  const { devices: store, pairing } = createDeviceAuth(config, logger);
  const manager = new FakeManager([makeSummary({ id: 's1' })]);
  const hub = new SseHub({ manager, serverStartId: 'start-1', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0 });
  hub.start();
  const server = http.createServer(createRouter({
    config, manager, hub, serverStartId: 'start-1', startedAtMs: Date.now(), logger,
    loginLimiter: createLoginLimiter(), devices: { store, pairing, serverName: 'mac-demo' },
  }));
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  let closed = false;
  const harness: Harness = {
    base: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    origin,
    store,
    pairing,
    close: async () => {
      if (closed) return;
      closed = true;
      hub.closeAll();
      server.closeAllConnections();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
      await store.flush();
    },
  };
  open.push(harness);
  return harness;
}

/** Status `GET /api/devices/me` z kluczem i kod błędu przy 401. */
async function me(h: Harness, auth: string): Promise<{ status: number; error: string | undefined }> {
  const res = await fetch(`${h.base}/api/devices/me`, { headers: { Authorization: auth } });
  const body = await res.json() as { error?: string };
  return { status: res.status, error: body.error };
}

/** Kod z `POST /api/demo/pairing` zamieniony w klucz urządzenia (`/api/pair`). */
async function pairThroughDemo(h: Harness): Promise<{ deviceId: string; auth: string }> {
  const issued = await post(h, DEMO_PAIRING_PATH, {});
  expect(issued.status).toBe(200);
  const paired = await post(h, '/api/pair', { v: 1, code: issued.body?.['code'] as string, label: 'iPhone·UITest' });
  expect(paired.status).toBe(200);
  const deviceId = paired.body?.['deviceId'] as string;
  return { deviceId, auth: deviceAuthorization(deviceId, paired.body?.['secret'] as string) };
}

/** Klucz z kodu `admin` (jak `rarog pair` przy pustym magazynie). */
async function pairAsOwner(h: Harness): Promise<string> {
  const paired = await post(h, '/api/pair', { v: 1, code: h.pairing.issue('admin').code, label: 'iPhone·Owner' });
  expect(paired.status).toBe(200);
  return deviceAuthorization(paired.body?.['deviceId'] as string, paired.body?.['secret'] as string);
}

const bytesOrNull = (file: string): string | null => (existsSync(file) ? readFileSync(file, 'utf8') : null);

async function post(h: Harness, route: string, body: unknown, headers: Record<string, string> = {}): Promise<{
  status: number; body: Record<string, unknown> | null;
}> {
  const res = await fetch(`${h.base}${route}`, {
    method: 'POST', headers: { Origin: h.origin, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text === '' ? null : JSON.parse(text) as Record<string, unknown> };
}

describe('demo: kod parowania dla testów UI apki', () => {
  it('demo wydaje kod z linkiem pod adres demo; kod paruje; następny kod odpina poprzednie urządzenie', async () => {
    const h = await start(true);
    const first = await post(h, DEMO_PAIRING_PATH, {});
    expect(first.status).toBe(200);
    const code = first.body?.['code'] as string;
    expect(first.body?.['link']).toBe(`https://rarog.ai/pair#v=1&u=${encodeURIComponent(h.origin)}&c=${code}`);
    const paired = await post(h, '/api/pair', { v: 1, code, label: 'iPhone·Rarog', build: '7' });
    expect(paired.status).toBe(200);
    const auth = deviceAuthorization(paired.body?.['deviceId'] as string, paired.body?.['secret'] as string);
    expect(h.store.active()).toHaveLength(1);

    // Drugi test w tym samym przebiegu bramki paruje od zera: poprzednie urządzenie demo jest odpięte.
    const second = await post(h, DEMO_PAIRING_PATH, {});
    expect(second.status).toBe(200);
    expect(h.store.active()).toHaveLength(0);
    const res = await fetch(`${h.base}/api/devices/me`, { headers: { Authorization: auth } });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('device-revoked');
  });

  it('poza demo trasy nie ma: bez poświadczeń 401, z kluczem urządzenia 404 — kodu nie wydaje', async () => {
    const h = await start(false);
    const anonymous = await post(h, DEMO_PAIRING_PATH, {});
    expect(anonymous.status).toBe(401);
    expect(anonymous.body?.['code']).toBeUndefined();
    // Klucz urządzenia z kodu `admin` (jak `rarog pair` przy pustym magazynie): z nim trasa też nie istnieje.
    const paired = await post(h, '/api/pair', { v: 1, code: h.pairing.issue('admin').code, label: 'iPhone·Rarog' });
    expect(paired.status).toBe(200);
    const auth = deviceAuthorization(paired.body?.['deviceId'] as string, paired.body?.['secret'] as string);
    const withKey = await post(h, DEMO_PAIRING_PATH, {}, { Authorization: auth });
    expect(withKey.status).toBe(404);
    expect(h.store.active()).toHaveLength(1);
  });

  it('demo: trasa wymaga POST i Origin z allow-listy, jak każda mutacja', async () => {
    const h = await start(true);
    const get = await fetch(`${h.base}${DEMO_PAIRING_PATH}`);
    expect(get.status).toBe(405);
    const foreign = await post(h, DEMO_PAIRING_PATH, {}, { Origin: 'https://obcy.example' });
    expect(foreign.status).toBe(403);
  });
});

describe('demo: urządzenia zwykłego demo w osobnym pliku', () => {
  it('kod z trasy demo paruje do devices.demo.json, a devices.json zostaje nietknięty', async () => {
    const dir = dataDir();
    const h = await start(true, dir);
    const { deviceId } = await pairThroughDemo(h);
    await h.close();
    const demoFile = JSON.parse(readFileSync(path.join(dir, 'devices.demo.json'), 'utf8')) as {
      devices: Array<{ id: string }>;
    };
    expect(demoFile.devices.map((record) => record.id)).toEqual([deviceId]);
    expect(existsSync(path.join(dir, 'devices.json'))).toBe(false);
  });

  it('klucz z demo nie działa na serwerze bez demo na tym samym katalogu', async () => {
    const dir = dataDir();
    const demo = await start(true, dir);
    const { auth } = await pairThroughDemo(demo);
    expect((await me(demo, auth)).status).toBe(200);
    await demo.close();
    const server = await start(false, dir);
    expect(await me(server, auth)).toEqual({ status: 401, error: 'device-unknown' });
  });

  it('demo na katalogu prawdziwego serwera nie odpina jego urządzeń i nie zmienia devices.json', async () => {
    const dir = dataDir();
    const devicesJson = path.join(dir, 'devices.json');
    const server = await start(false, dir);
    const owner = await pairAsOwner(server);
    await server.close();
    const before = bytesOrNull(devicesJson);
    expect(before).not.toBeNull();

    const demo = await start(true, dir);
    await pairThroughDemo(demo);
    expect(await me(demo, owner)).toEqual({ status: 401, error: 'device-unknown' });
    await demo.close();
    expect(bytesOrNull(devicesJson)).toBe(before);

    const again = await start(false, dir);
    expect((await me(again, owner)).status).toBe(200);
  });

  it('rekord w devices.json zapisany przez zwykłe demo starszej wersji dalej działa po starcie bez demo', async () => {
    /*
     * Granica przypięta świadomie: rekord z demo i rekord prawdziwy wyglądają w devices.json tak samo, więc serwer
     * go nie odróżni i nie skasuje. Przed takim kluczem chroni tylko przegląd katalogu danych (`rarog devices`,
     * odpięcie obcych wpisów albo nowa epoka): `docs/security-model.md`, "Review demo server".
     */
    const dir = dataDir();
    const legacy = createDeviceStore({ dataDir: dir, epoch: '1', log: () => {} });
    const { authorization } = addTestDevice(legacy);
    await legacy.persist();
    const server = await start(false, dir);
    expect((await me(server, authorization)).status).toBe(200);
  });
});
