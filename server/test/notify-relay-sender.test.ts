/**
 * Klient przekaźnika push (`notify/relay-sender.ts`) poza przypadkami z fixture'ów: sufit czasu, błędy sieci,
 * wstrzymanie drogi po `503` i po `5xx` Apple, odpowiedzi spoza kontraktu, transport (`redirect: 'error'`, nagłówek
 * wersji) i log — nigdy tokenu, przepustki ani ładunku. Bez sieci: `fetch` to atrapa.
 */
import { describe, expect, it } from 'vitest';
import { RAROG_VERSION } from '../src/version.ts';
import { RELAY_UNAVAILABLE_PAUSE_MS, createRelayClient } from '../src/notify/relay-sender.ts';
import type { RelayPushInput } from '../src/notify/relay-sender.ts';

const ORIGIN = 'https://push.rarog.ai';
const TOKEN = '4f8a6c0e'.repeat(8);
const PASS = 'v1.k1.development.alert.c2a0b37a262809b4.1800525600.TAJNY-podpis-przepustki';
const PAYLOAD = '{"aps":{"alert":{"title":"Tajny projekt","body":"Edit — zapis"}},"rarog":{"v":1,"kind":"permission"}}';
const INPUT: RelayPushInput = {
  pass: PASS, token: TOKEN, environment: 'development',
  request: { headers: { 'apns-push-type': 'alert', 'apns-topic': 'ai.rarog.app' }, body: PAYLOAD },
};

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status });

/** Atrapa `fetch` z kolejką odpowiedzi (funkcja = odpowiedź liczona z żądania). */
function scripted(replies: ((init: RequestInit) => Promise<Response>)[]): {
  fetch: typeof globalThis.fetch; calls: RequestInit[];
} {
  const calls: RequestInit[] = [];
  return {
    calls,
    fetch: (_url, init) => {
      calls.push(init ?? {});
      const next = replies.shift();
      return next === undefined ? Promise.reject(new Error('brak odpowiedzi w atrapie')) : next(init ?? {});
    },
  };
}

const expectClean = (lines: readonly string[]): void => {
  const text = lines.join('\n');
  expect(text).not.toContain(TOKEN.slice(0, 16));
  expect(text).not.toContain('TAJNY');
  expect(text).not.toContain('Tajny projekt');
};

describe('klient przekaźnika — transport', () => {
  it('POST na origin + ścieżka, JSON, nagłówek wersji serwera, bez wykonywania przekierowań', async () => {
    const fake = scripted([() => Promise.resolve(json(200, { v: 1, apnsStatus: 200 }))]);
    const client = createRelayClient({ origin: ORIGIN, fetch: fake.fetch });
    expect(await client.push(INPUT)).toEqual({ result: { kind: 'ok' } });
    const init = fake.calls[0];
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect(init?.headers).toEqual({ 'x-rarog-relay-client': `rarog-server/${RAROG_VERSION}`, 'content-type': 'application/json' });
    expect(JSON.parse(String(init?.body))).toMatchObject({ v: 1, pass: PASS, token: TOKEN, payload: PAYLOAD });
  });

  it('sufit czasu: żądanie przerwane, wynik `timeout` (porażka próby)', async () => {
    const log: string[] = [];
    const hanging: typeof globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')); });
    });
    const client = createRelayClient({ origin: ORIGIN, fetch: hanging, timeoutMs: 20, log: (l) => { log.push(l); } });
    expect(await client.push(INPUT)).toEqual({ result: { kind: 'failed', status: null, reason: 'timeout' } });
    expect(await client.requestPass({ token: TOKEN, environment: 'development', type: 'alert', topic: 'ai.rarog.app' }))
      .toEqual({ kind: 'failed', status: null, reason: 'timeout' });
    expectClean(log);
  });

  it('błąd sieci: kod z przyczyny (undici), NIGDY komunikat — komunikat może nieść adres i nagłówki', async () => {
    const log: string[] = [];
    const failing: typeof globalThis.fetch = () => Promise.reject(Object.assign(
      new TypeError(`fetch failed ${PASS} ${TOKEN}`), { cause: { code: 'ENOTFOUND', message: PAYLOAD } },
    ));
    const client = createRelayClient({ origin: ORIGIN, fetch: failing, log: (l) => { log.push(l); } });
    expect(await client.push(INPUT)).toEqual({ result: { kind: 'failed', status: null, reason: 'ENOTFOUND' } });
    expect(log).toEqual(['push: relay development failed (ENOTFOUND)']);
    expectClean(log);
  });

  it('odpowiedź spoza kontraktu (strona błędu proxy, 200 bez pól) = porażka z powodem `nieznany`', async () => {
    const fake = scripted([
      () => Promise.resolve(new Response('<html>Bad gateway</html>', { status: 502 })),
      () => Promise.resolve(json(200, { ok: true })),
      () => Promise.resolve(json(200, { v: 1, pass: 'x' })),
    ]);
    const client = createRelayClient({ origin: ORIGIN, fetch: fake.fetch });
    expect(await client.push(INPUT)).toEqual({ result: { kind: 'failed', status: 502, reason: 'unknown' } });
    expect(await client.push(INPUT)).toEqual({ result: { kind: 'failed', status: null, reason: 'unknown' } });
    expect(await client.requestPass({ token: TOKEN, environment: 'development', type: 'alert', topic: 'ai.rarog.app' }))
      .toEqual({ kind: 'failed', status: 200, reason: 'unknown' });
  });
});

describe('klient przekaźnika — wstrzymanie drogi', () => {
  it('`503`: droga w TYM środowisku milczy 15 min (bez sieci), status mówi „od pierwszego 503”, 200 zdejmuje', async () => {
    let clock = 1_000_000;
    const log: string[] = [];
    const fake = scripted([
      () => Promise.resolve(json(503, { v: 1, error: 'environment-unavailable' })),
      () => Promise.resolve(json(200, { v: 1, apnsStatus: 200 })),
      () => Promise.resolve(json(200, { v: 1, apnsStatus: 200 })),
    ]);
    const client = createRelayClient({ origin: ORIGIN, fetch: fake.fetch, now: () => clock, log: (l) => { log.push(l); } });
    expect(await client.push(INPUT)).toEqual({ result: { kind: 'failed', status: 503, reason: 'environment-unavailable' } });
    const since = new Date(1_000_000).toISOString();
    expect(client.unavailableSince('development')).toBe(since);
    expect(client.pausedUntil('development')).toBe(1_000_000 + RELAY_UNAVAILABLE_PAUSE_MS);
    // Inne środowisko działa dalej.
    expect(client.unavailableSince('production')).toBeNull();
    expect(await client.push({ ...INPUT, environment: 'production' })).toEqual({ result: { kind: 'ok' } });
    clock += 60_000;
    expect(await client.push(INPUT)).toEqual({ result: { kind: 'failed', status: null, reason: 'paused' } });
    expect(fake.calls).toHaveLength(2);
    clock += RELAY_UNAVAILABLE_PAUSE_MS;
    expect(client.pausedUntil('development')).toBe(0);
    // Po ciszy status dalej mówi o degradacji — aż do pierwszego 200 tego środowiska.
    expect(client.unavailableSince('development')).toBe(since);
    expect(await client.push(INPUT)).toEqual({ result: { kind: 'ok' } });
    expect(client.unavailableSince('development')).toBeNull();
    expect(log).toEqual(['push: relay development unavailable (503 environment-unavailable) — the route stays silent for 15 min']);
  });

  it('dwie wysyłki w locie: `503`, potem spóźnione 200 — status i następna wysyłka mówią to samo (droga działa)', async () => {
    const releases: ((r: Response) => void)[] = [];
    const held: typeof globalThis.fetch = () => new Promise<Response>((resolve) => { releases.push(resolve); });
    const client = createRelayClient({ origin: ORIGIN, fetch: held, now: () => 1_000 });
    const first = client.push(INPUT);
    const second = client.push(INPUT);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(releases).toHaveLength(2);
    releases[0]?.(json(503, { v: 1, error: 'environment-unavailable' }));
    expect(await first).toEqual({ result: { kind: 'failed', status: 503, reason: 'environment-unavailable' } });
    expect(client.unavailableSince('development')).not.toBeNull();
    releases[1]?.(json(200, { v: 1, apnsStatus: 200 }));
    expect(await second).toEqual({ result: { kind: 'ok' } });
    expect(client.unavailableSince('development')).toBeNull();
    expect(client.pausedUntil('development')).toBe(0);
    const next = client.push(INPUT);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(releases).toHaveLength(3);
    releases[2]?.(json(200, { v: 1, apnsStatus: 200 }));
    expect(await next).toEqual({ result: { kind: 'ok' } });
  });

  it('`503`, potem 200 `/v1/pass`: niedostępność i jej pauza znikają razem', async () => {
    const fake = scripted([
      () => Promise.resolve(json(503, { v: 1, error: 'environment-unavailable' })),
      () => Promise.resolve(json(200, { v: 1, pass: 'v1.k1.x', expiresAt: '2027-01-31T10:00:00.000Z' })),
      () => Promise.resolve(json(200, { v: 1, apnsStatus: 200 })),
    ]);
    const client = createRelayClient({ origin: ORIGIN, fetch: fake.fetch, now: () => 1_000 });
    await client.push(INPUT);
    expect(client.pausedUntil('development')).toBeGreaterThan(1_000);
    expect((await client.requestPass({ token: TOKEN, environment: 'development', type: 'alert', topic: 'ai.rarog.app' })).kind)
      .toBe('issued');
    expect(client.unavailableSince('development')).toBeNull();
    expect(client.pausedUntil('development')).toBe(0);
    expect(await client.push(INPUT)).toEqual({ result: { kind: 'ok' } });
  });

  it('`5xx` Apple lustrem: porażka próby i 15 min ciszy tej drogi (Apple każe nie ponawiać)', async () => {
    const log: string[] = [];
    const fake = scripted([() => Promise.resolve(json(200, { v: 1, apnsStatus: 503, reason: 'ServiceUnavailable' }))]);
    const client = createRelayClient({ origin: ORIGIN, fetch: fake.fetch, now: () => 5_000, log: (l) => { log.push(l); } });
    expect(await client.push(INPUT)).toEqual({ result: { kind: 'failed', status: 503, reason: 'ServiceUnavailable' } });
    expect(client.pausedUntil('development')).toBeGreaterThan(5_000);
    // Przekaźnik działa — nie jest „wyłączony”; to cisza po odpowiedzi Apple.
    expect(client.unavailableSince('development')).toBeNull();
    // Cisza po `5xx` Apple trzyma 15 min, choć sam przekaźnik odpowiedział 200 (jak `apns.ts`).
    expect(await client.push(INPUT)).toEqual({ result: { kind: 'failed', status: null, reason: 'paused' } });
    expect(fake.calls).toHaveLength(1);
    expect(log).toEqual(['push: relay development paused for 15 min (APNs 503 ServiceUnavailable)']);
  });

  it('log porażek: kod, status i reguła przekaźnika — bez tokenu, przepustki i ładunku', async () => {
    const log: string[] = [];
    const fake = scripted([
      () => Promise.resolve(json(400, { v: 1, error: 'payload-rejected', rule: 'alert' })),
      () => Promise.resolve(json(401, { v: 1, error: 'pass-invalid' })),
      () => Promise.resolve(json(200, { v: 1, apnsStatus: 403, reason: 'InvalidProviderToken' })),
    ]);
    const client = createRelayClient({ origin: ORIGIN, fetch: fake.fetch, log: (l) => { log.push(l); } });
    await client.push(INPUT);
    expect(await client.push(INPUT)).toEqual({
      result: { kind: 'failed', status: null, reason: 'pass-invalid' }, passInvalid: true,
    });
    await client.push(INPUT);
    expect(log).toEqual([
      'push: relay development failed (400 payload-rejected/alert)',
      'push: relay development refused the pass (401 pass-invalid)',
      'push: relay development — APNs failed (403 InvalidProviderToken)',
    ]);
    expectClean(log);
  });
});
