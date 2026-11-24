/**
 * Adapter Workera (`default.fetch(request, env, ctx)`) z atrapą `env`: zmienne i sekrety → rdzeń, bindingi Rate
 * Limiting z kluczem adresu (`CF-Connecting-IPv6`, potem `CF-Connecting-IP`) / skrótem tokenu, globalny `fetch` →
 * Apple, `console.log` → linia logu.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RELAY_VERSION } from '../src/config.ts';
import worker from '../src/worker.ts';
import type { Env } from '../src/worker.ts';
import { tokenHashOf } from '../src/pass.ts';
import { POST_HEADERS, T1, TEST_PASS_KEYS, testKey } from './helpers.ts';

function rateLimit(verdict: boolean, keys: string[]): RateLimit {
  return { limit: async ({ key }) => { keys.push(key); return { success: verdict }; } };
}

type Keys = { pass: string[]; push: string[]; pushAddr?: string[] };

async function env(overrides: Partial<Env> = {}, keys: Keys = { pass: [], push: [] }): Promise<Env> {
  const { pem } = await testKey();
  return {
    APNS_TEAM_ID: 'TEAMID0001',
    APNS_ENVIRONMENTS: 'development,production',
    ALERT_POLICY: 'v2',
    PASS_KID: 'k1',
    DEPLOY_SHA: 'abc1234',
    APNS_KEY: pem,
    APNS_KEY_ID: 'KEYID00001',
    PASS_KEYS: TEST_PASS_KEYS,
    RL_PASS: rateLimit(true, keys.pass),
    RL_PUSH: rateLimit(true, keys.push),
    RL_PUSH_ADDR: rateLimit(true, keys.pushAddr ?? []),
    ...overrides,
  };
}

const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} } as unknown as ExecutionContext;

/** `default.fetch(request, env, ctx)`; żądanie z testu nie ma pól `cf` z sieci Cloudflare (stąd rzutowanie typu). */
const fetchWorker = (request: Request, e: Env): Promise<Response> =>
  worker.fetch(request as Parameters<typeof worker.fetch>[0], e, ctx);

const passRequest = (headers: Record<string, string> = {}): Request =>
  new Request('https://push.rarog.ai/v1/pass', {
    method: 'POST',
    headers: { 'cf-connecting-ip': '198.51.100.23', ...POST_HEADERS, ...headers },
    body: JSON.stringify({ v: 1, token: T1, environment: 'development', type: 'alert', topic: 'ai.rarog.app' }),
  });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('worker.ts', () => {
  it('health przez default.fetch: wersja z DEPLOY_SHA, polityka ze zmiennej', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const response = await fetchWorker(new Request('https://push.rarog.ai/v1/health'), await env());
    expect(await response.json()).toEqual({
      v: 1, ok: true, version: `${RELAY_VERSION}+abc1234`, environments: ['development', 'production'], alertPolicy: 'v2',
    });
  });

  it('/v1/pass: globalny fetch do Apple, limit kluczem CF-Connecting-IP, jedna linia logu', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
    const apple = vi.fn(async (_url: string, _init?: RequestInit) => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', apple);
    const keys = { pass: [] as string[], push: [] as string[] };
    const response = await fetchWorker(passRequest({ 'x-rarog-relay-client': 'rarog-server/0.1.0' }),
      await env({}, keys));
    expect(response.status).toBe(200);
    expect(keys.pass).toEqual(['198.51.100.23']);
    expect(apple).toHaveBeenCalledTimes(1);
    expect(apple.mock.calls[0]?.[0]).toBe(`https://api.sandbox.push.apple.com/3/device/${T1}`);
    expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>)).toEqual([expect.objectContaining({
      event: 'request', route: 'pass', status: 200, env: 'development', type: 'alert', apns_status: 200,
      client: 'rarog-server/0.1.0',
    })]);
  });

  const pushRequest = (pass: string, headers: Record<string, string> = {}): Request =>
    new Request('https://push.rarog.ai/v1/push', {
      method: 'POST',
      headers: { ...POST_HEADERS, ...headers },
      body: JSON.stringify({
        v: 1, pass, token: T1, environment: 'development',
        headers: { 'apns-push-type': 'alert', 'apns-topic': 'ai.rarog.app' }, payload: '{"aps":{"badge":1}}',
      }),
    });

  it('/v1/push: binding RL_PUSH dostaje a:<skrót tokenu>; odmowa bindingu = 429', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));
    const pass = String((await (await fetchWorker(passRequest(), await env())).json() as { pass: string }).pass);
    const keys: Keys = { pass: [], push: [], pushAddr: [] };
    const limited = await env({ RL_PUSH: rateLimit(false, keys.push) }, keys);
    const response = await fetchWorker(pushRequest(pass), limited);
    expect(response.status).toBe(429);
    expect(keys.push).toEqual([`a:${await tokenHashOf(T1)}`]);
  });

  it('/v1/push: binding RL_PUSH_ADDR dostaje klucz adresu (IPv6 po /64); odmowa bindingu = 429', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const apple = vi.fn(async () => new Response('', { status: 200 }));
    vi.stubGlobal('fetch', apple);
    const pass = String((await (await fetchWorker(passRequest(), await env())).json() as { pass: string }).pass);
    apple.mockClear();
    const keys: Keys = { pass: [], push: [], pushAddr: [] };
    const limited = await env({ RL_PUSH_ADDR: rateLimit(false, keys.pushAddr ?? []) }, keys);
    const response = await fetchWorker(pushRequest(pass, { 'cf-connecting-ip': '2001:db8:85a3:12::7' }), limited);
    expect(response.status).toBe(429);
    expect(keys.pushAddr).toEqual(['2001:0db8:85a3:0012::/64']);
    expect(apple).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, string>, string]>([
    ['Pseudo IPv4 „Overwrite”: CF-Connecting-IPv6 wygrywa z pseudo-adresem', {
      'cf-connecting-ip': '240.16.0.9', 'cf-connecting-ipv6': '2001:db8:85a3:12::7',
    }, '2001:0db8:85a3:0012::/64'],
    ['Pseudo IPv4 wyłączone: IPv6 w CF-Connecting-IP', { 'cf-connecting-ip': '2001:db8:85a3:12::7' },
      '2001:0db8:85a3:0012::/64'],
    ['pusty CF-Connecting-IPv6 nie zasłania CF-Connecting-IP', { 'cf-connecting-ipv6': '' }, '198.51.100.23'],
    // Przy Pseudo IPv4 „Off” i „Add Header” Cloudflare nie zapowiada, że usuwa ten nagłówek od
    // klienta, więc przy zwykłym IPv4 w CF-Connecting-IP byłby wyborem klucza limitu przez wołającego.
    ['CF-Connecting-IPv6 od klienta przy zwykłym IPv4 → klucz z CF-Connecting-IP', {
      'cf-connecting-ip': '198.51.100.23', 'cf-connecting-ipv6': '2001:db8:dead:beef::1',
    }, '198.51.100.23'],
    ['CF-Connecting-IPv6 obok IPv6 w CF-Connecting-IP (Pseudo IPv4 „Off”) → klucz z CF-Connecting-IP', {
      'cf-connecting-ip': '2001:db8:85a3:12::7', 'cf-connecting-ipv6': '2001:db8:dead:beef::1',
    }, '2001:0db8:85a3:0012::/64'],
    ['pseudo-adres bez CF-Connecting-IPv6 → sam pseudo-adres', { 'cf-connecting-ip': '240.16.0.9' }, '240.16.0.9'],
    ['bez nagłówków adresu', { 'cf-connecting-ip': '' }, 'unknown'],
  ])('/v1/pass, klucz limitu: %s', async (_what, headers, key) => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));
    const keys = { pass: [] as string[], push: [] as string[] };
    expect((await fetchWorker(passRequest(headers), await env({}, keys))).status).toBe(200);
    expect(keys.pass).toEqual([key]);
  });

  it('brak sekretów w env → 503 i ok: false (bez wyjątku)', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
    const bare = await env({ APNS_KEY: undefined, APNS_KEY_ID: undefined, PASS_KEYS: undefined });
    expect((await fetchWorker(passRequest(), bare)).status).toBe(503);
    const health = await (await fetchWorker(new Request('https://x/v1/health'), bare)).json() as { ok: boolean };
    expect(health.ok).toBe(false);
    expect(lines.some((line) => line.includes('"problem":"apns-key-missing"'))).toBe(true);
  });

  it('ta sama konfiguracja = ten sam rdzeń (problemy konfiguracji zalogowane raz), nowa — nowy', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
    const bare = await env({ APNS_KEY: undefined, PASS_KID: 'k7' });
    for (let i = 0; i < 3; i += 1) await fetchWorker(new Request('https://x/v1/health'), bare);
    expect(lines.filter((line) => line.includes('"problem":"apns-key-missing"'))).toHaveLength(1);
    await fetchWorker(new Request('https://x/v1/health'), { ...bare, PASS_KID: 'k8' });
    expect(lines.filter((line) => line.includes('"problem":"apns-key-missing"'))).toHaveLength(2);
  });
});
