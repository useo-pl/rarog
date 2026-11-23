/**
 * Rejestr w prawdziwym runtime: lokalny `workerd` z wranglera (`test/workerd.mjs`), Durable Objects z magazynem
 * SQLite, KV i liczniki Rate Limiting z `wrangler.toml`, zegar przesunięty `CLOCK_OFFSET` na `issuedAt` manifestu,
 * Apple jako atrapa za `outboundService`. Sprawdza RPC między obiektami, alarm w kodzie DO, serializację bramki
 * i poręczeń przy równoległych żądaniach, limit `RL_REGISTER` per adres i hak przez prawdziwy adapter z VPS.
 * Bez konta Cloudflare i bez sieci; serwer na 127.0.0.1, więc test biegnie poza sandboksem (`listen()`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ENTRY_TTL_SECONDS } from '../src/registry.ts';
import {
  ADMIN_BEARER, APP, HOOK_BEARER, KEY_ID, SERVER_A, T0, TEAM_ID, appKey, deviceCheckProof, generatedPem, manifest,
} from './helpers.ts';
import { createFakeApple, startAdapter, startRegistry } from './workerd.mjs';
import type { Adapter, FakeApple, LocalRegistry } from './workerd.mjs';

const server = (n: number): string => n.toString(16).padStart(2, '0').repeat(32);

let registry: LocalRegistry;
let apple: FakeApple;
let adapter: Adapter;

beforeAll(async () => {
  apple = createFakeApple('2026-11');
  registry = await startRegistry({
    apple,
    vars: {
      DEPLOY_SHA: 'fixture', GATE_KIND: 'devicecheck', ENFORCE: '1', APPLE_TEAM_ID: TEAM_ID,
      DEVICECHECK_KEY: await generatedPem(), DEVICECHECK_KEY_ID: KEY_ID, RELAY_HOOK_SECRET: HOOK_BEARER,
      ADMIN_SECRET: ADMIN_BEARER, CLOCK_OFFSET: String(T0 - Math.floor(Date.now() / 1000)),
      // Lokalny workerd nie zna jurysdykcji Durable Objects (`ENV_TEST_VARS` w `src/config.ts`).
      NO_JURISDICTION: '1',
    },
  });
  adapter = await startAdapter(new URL('/v1/access', registry.url).href);
}, 60_000);

afterAll(async () => {
  await adapter?.stop();
  await registry?.dispose();
});

const post = (path: string, body: unknown, address: string,
  headers: Readonly<Record<string, string>> = manifest.headers.app): Promise<Response> =>
  registry.fetch(path, {
    method: 'POST', headers: { ...headers, 'cf-connecting-ip': address }, body: JSON.stringify(body),
  });

/** Pytanie relaya iroh do adaptera: POST bez ciała z EndpointId i bearerem. */
async function relayAsks(endpointId: string, bearer = HOOK_BEARER): Promise<{ status: number; body: string }> {
  const response = await fetch(`http://127.0.0.1:${String(adapter.port)}/v1/access`, {
    method: 'POST', headers: { 'x-iroh-endpoint-id': endpointId, authorization: `Bearer ${bearer}` },
  });
  return { status: response.status, body: await response.text() };
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(condition()).toBe(true);
}

const withinSeconds = (value: unknown, expected: number): boolean =>
  typeof value === 'number' && value >= expected && value <= expected + 30;

describe('workerd: trasy kontraktu', () => {
  it('GET /v1/health = przypadek `health.devicecheck` (klucz Apple zaimportowany w runtime)', async () => {
    const response = await registry.fetch('/v1/health');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(manifest.responses['health.devicecheck'].body);
  });

  it('register i sponsor z manifestu: podpis Ed25519 WebCrypto workerd, DeviceCheck przez outbound', async () => {
    const registered = await post('/v1/app/register', manifest.requests['register.devicecheck'].body, '198.51.100.1');
    const body = await registered.json() as Record<string, unknown>;
    expect(registered.status).toBe(200);
    expect(body['endpointId']).toBe(APP);
    expect(withinSeconds(body['expiresAt'], T0 + ENTRY_TTL_SECONDS)).toBe(true);
    expect(apple.calls.map((call) => `${call.host}${call.path}`)).toEqual([
      'api.devicecheck.apple.com/v1/query_two_bits', 'api.devicecheck.apple.com/v1/update_two_bits',
    ]);
    expect(apple.calls[0]?.authorization).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);

    const sponsored = await post('/v1/app/sponsor', manifest.requests.sponsor.body, '198.51.100.1');
    expect(sponsored.status).toBe(200);
    expect(await sponsored.json()).toMatchObject({ v: 1, server: SERVER_A });
  });

  it('hak przez prawdziwy adapter: wpis wpuszcza, obcy dostaje odmowę, zły bearer = fail-open z alertem', async () => {
    expect(await relayAsks(SERVER_A)).toEqual({ status: 200, body: 'true' });
    expect(await relayAsks(APP)).toEqual({ status: 200, body: 'true' });
    expect(await relayAsks(server(0xee))).toEqual({ status: 403, body: 'false' });
    expect(await relayAsks(SERVER_A, 'TEST-ONLY-wrong-bearer')).toEqual({ status: 200, body: 'true' });
    expect(adapter.lines.some((line) => line.includes('src=worker') && line.includes('decision=deny'))).toBe(true);
    // Linię decyzji adapter pisze po odpowiedzi: chwila na stdout.
    await until(() => adapter.lines.some((line) => line.includes('why=status:401')));
  });

  it('odmowa administratora działa od razu w haku (KV), allow ją zdejmuje', async () => {
    const admin = (route: string) => post(`/v1/admin/${route}`, { v: 1, endpointId: SERVER_A }, '198.51.100.2',
      manifest.headers.admin);
    expect(await (await admin('deny')).json()).toEqual({ v: 1, endpointId: SERVER_A, denied: true });
    expect(await relayAsks(SERVER_A)).toEqual({ status: 403, body: 'false' });
    expect(await (await admin('allow')).json()).toEqual({ v: 1, endpointId: SERVER_A, denied: false });
  });

  it('forget zdejmuje poręczenie inkarnacji u serwera (RPC między obiektami, ślad zdjęć w magazynie SQLite)', async () => {
    const key = await appKey(95);
    const peer = server(0x95);
    const address = '198.51.100.3';
    expect((await post('/v1/app/register', await key.sign('register', { issuedAt: T0, proof: deviceCheckProof('F') }),
      address)).status).toBe(200);
    expect((await post('/v1/app/sponsor', await key.sign('sponsor', { issuedAt: T0, server: peer }), address)).status)
      .toBe(200);
    expect(await relayAsks(peer)).toEqual({ status: 200, body: 'true' });
    expect((await post('/v1/app/forget', await key.sign('forget', { issuedAt: T0 }), address)).status).toBe(200);
    expect(await relayAsks(peer)).toEqual({ status: 403, body: 'false' });
    expect(await relayAsks(key.endpointId)).toEqual({ status: 403, body: 'false' });
  });
});

describe('workerd: równoległe żądania', () => {
  it('ten sam EndpointId rejestrowany 6 razy naraz: wszystkie 200, Apple raz (kolejka bramki)', async () => {
    const key = await appKey(21);
    const body = await key.sign('register', { issuedAt: T0, proof: deviceCheckProof('M') });
    const before = apple.calls.length;
    const results = await Promise.all(Array.from({ length: 6 }, (_unused, n) =>
      post('/v1/app/register', body, `198.51.100.${String(30 + n)}`)));
    expect(results.map((response) => response.status)).toEqual(Array(6).fill(200));
    expect(apple.calls.slice(before).map((call) => call.path)).toEqual(['/v1/query_two_bits', '/v1/update_two_bits']);
  });

  it('osiem różnych apek naraz z jednego urządzenia: kwota bitów 3, reszta 429 quota-exceeded', async () => {
    const keys = await Promise.all(Array.from({ length: 8 }, (_unused, n) => appKey(40 + n)));
    const bodies = await Promise.all(keys.map((key) =>
      key.sign('register', { issuedAt: T0, proof: deviceCheckProof('D') })));
    const results = await Promise.all(bodies.map((body, n) => post('/v1/app/register', body, `198.51.100.${String(50 + n)}`)));
    const statuses = results.map((response) => response.status).sort();
    expect(statuses).toEqual([200, 200, 200, 429, 429, 429, 429, 429]);
    expect(apple.bits.get(deviceCheckProof('D').token)).toEqual({ bit0: true, bit1: true });
  });

  it('cztery poręczenia naraz przy kwocie 2/3: dokładnie jedno 200, trzy 429; hak widzi tylko ten serwer', async () => {
    const key = await appKey(60);
    await post('/v1/app/register', await key.sign('register', { issuedAt: T0, proof: deviceCheckProof('S') }),
      '198.51.100.70');
    for (const n of [1, 2]) {
      const response = await post('/v1/app/sponsor', await key.sign('sponsor', { issuedAt: T0, server: server(0x60 + n) }),
        '198.51.100.70');
      expect(response.status).toBe(200);
    }
    const candidates = [3, 4, 5, 6].map((n) => server(0x60 + n));
    const results = await Promise.all(candidates.map(async (candidate, n) =>
      post('/v1/app/sponsor', await key.sign('sponsor', { issuedAt: T0, server: candidate }), `198.51.100.${String(71 + n)}`)));
    expect(results.map((response) => response.status).sort()).toEqual([200, 429, 429, 429]);
    const allowed = await Promise.all(candidates.map(async (candidate) => (await relayAsks(candidate)).status));
    expect(allowed.sort()).toEqual([200, 403, 403, 403]);
  });

  it('dwadzieścia pytań haka naraz: każde z decyzją Workera', async () => {
    const ids = Array.from({ length: 20 }, (_unused, n) => (n % 2 === 0 ? APP : server(0xc0 + n)));
    const answers = await Promise.all(ids.map((id) => relayAsks(id)));
    expect(answers.map((answer) => answer.body)).toEqual(ids.map((id) => (id === APP ? 'true' : 'false')));
  });
});

describe('workerd: limity per adres', () => {
  it('RL_REGISTER 10 na 60 s per adres: jedenasta rejestracja z tego adresu 429 limited, inny adres przechodzi', async () => {
    const body = manifest.requests['register.devicecheck'].body;
    const results = [];
    for (let n = 0; n < 11; n += 1) results.push((await post('/v1/app/register', body, '203.0.113.9')).status);
    expect(results.slice(0, 10)).toEqual(Array(10).fill(200));
    const limited = await post('/v1/app/register', body, '203.0.113.9');
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual(manifest.responses['register.limited'].body);
    expect((await post('/v1/app/register', body, '203.0.113.10')).status).toBe(200);
  });
});
