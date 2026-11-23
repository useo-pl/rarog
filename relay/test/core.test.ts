/**
 * Rdzeń przekaźnika na atrapach: wydanie przepustki tylko po 200 cichego pushu, 422 tylko
 * dla błędów tokenu, 502 dla reszty Apple i dla braku odpowiedzi, przepustka aktywności za `devicePass`,
 * `/v1/push` z odpowiedzią lustrzaną i `renewedPass`, limity, sufit ciała, kolejność sprawdzeń, konfiguracja.
 */
import { describe, expect, it } from 'vitest';
import { ALERT_PLACEHOLDER } from '../src/alert-policy.ts';
import { BODY_MAX_BYTES, CLIENT_HEADER, PROBE_PAYLOAD } from '../src/core.ts';
import { tokenHashOf } from '../src/pass.ts';
import {
  DAY_S, NOW_MS, OTHER_PASS_KEYS, POST_HEADERS, T1, T2, T3, baseEnv, call, get, harness, issueDevicePass, post, testKey,
} from './helpers.ts';
import type { ApnsReply, Harness, LimitScript } from './helpers.ts';

const passBody = (extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ v: 1, token: T1, environment: 'development', type: 'alert', topic: 'ai.rarog.app', ...extra });

/** Baner: tekst zastępczy w `aps.alert`, treść w szyfrogramie bloku `rarog` (przekaźnik go nie czyta). */
const blocking = {
  headers: { 'apns-push-type': 'alert', 'apns-topic': 'ai.rarog.app', 'apns-priority': '10' },
  payload: JSON.stringify({
    aps: { alert: { ...ALERT_PLACEHOLDER }, 'mutable-content': 1, sound: 'default', 'thread-id': '3f2a9c1b7e5d4a60' },
    rarog: { v: 3, kid: '0a1b2c3d', n: 'AAAAAAAAAAAAAAAA', c: 'c3p5ZnJvZ3JhbQ' },
  }),
};
const pushBody = (pass: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ v: 1, pass, token: T1, environment: 'development', ...blocking, ...extra });

async function setup(options: { apns?: ApnsReply[]; limits?: LimitScript; env?: Record<string, string | undefined> } = {}):
  Promise<Harness> {
  const { pem } = await testKey();
  return harness({
    env: baseEnv(pem, options.env),
    ...(options.apns === undefined ? {} : { apns: options.apns }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
}

describe('/v1/pass typu alert: próbny cichy push', () => {
  it('200 Apple → przepustka na 90 dni; próbny push: background, priorytet 5, temat z żądania, content-available', async () => {
    const h = await setup({ apns: [{ status: 200 }] });
    const { status, body } = await call(h, post('/v1/pass', passBody()));
    expect(status).toBe(200);
    expect(body['pass']).toMatch(/^v1\.k1\.development\.alert\./);
    expect(body['expiresAt']).toBe(new Date(NOW_MS + 90 * DAY_S * 1000).toISOString());
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.headers).toMatchObject({
      'apns-push-type': 'background', 'apns-priority': '5', 'apns-topic': 'ai.rarog.app', 'apns-expiration': '0',
    });
    expect(h.calls[0]?.body).toBe(PROBE_PAYLOAD);
    expect(JSON.parse(PROBE_PAYLOAD)).toEqual({ aps: { 'content-available': 1 } });
  });

  it.each<[string, ApnsReply, number, Record<string, unknown>]>([
    ['400 BadDeviceToken', { status: 400, body: '{"reason":"BadDeviceToken"}' }, 422,
      { error: 'token-rejected', apnsStatus: 400, reason: 'BadDeviceToken' }],
    ['400 DeviceTokenNotForTopic', { status: 400, body: '{"reason":"DeviceTokenNotForTopic"}' }, 422,
      { error: 'token-rejected', apnsStatus: 400, reason: 'DeviceTokenNotForTopic' }],
    ['410', { status: 410, body: '{"reason":"Unregistered","timestamp":1793600000000}' }, 422,
      { error: 'token-rejected', apnsStatus: 410, reason: 'Unregistered', timestamp: 1793600000000 }],
    ['410 bez powodu', { status: 410 }, 422, { error: 'token-rejected', apnsStatus: 410, reason: 'unknown' }],
    // `apns-error` bez pól Apple: anonimowy wołający nie poznaje stanu klucza; status i powód zostają w logu.
    ['403 klucza', { status: 403, body: '{"reason":"InvalidProviderToken"}' }, 502, { error: 'apns-error' }],
    ['403 środowiska klucza', { status: 403, body: '{"reason":"BadEnvironmentKeyIdInToken"}' }, 502,
      { error: 'apns-error' }],
    ['400 TopicDisallowed', { status: 400, body: '{"reason":"TopicDisallowed"}' }, 502, { error: 'apns-error' }],
    ['429 Apple', { status: 429, body: '{"reason":"TooManyRequests"}' }, 502, { error: 'apns-error' }],
    ['500', { status: 500, body: '{"reason":"InternalServerError"}' }, 502, { error: 'apns-error' }],
    ['sieć', 'network', 502, { error: 'apns-unreachable' }],
    ['czas', 'timeout', 502, { error: 'apns-unreachable' }],
  ])('Apple: %s → %i bez przepustki', async (_what, reply, status, body) => {
    const h = await setup({ apns: [reply] });
    const response = await call(h, post('/v1/pass', passBody()));
    expect(response).toEqual({ status, body: { v: 1, ...body } });
  });

  it('apns-error: status i powód Apple tylko w logu', async () => {
    const h = await setup({ apns: [{ status: 403, body: '{"reason":"InvalidProviderToken"}' }] });
    expect((await call(h, post('/v1/pass', passBody()))).body).toEqual({ v: 1, error: 'apns-error' });
    expect(h.lines.map((line) => JSON.parse(line) as Record<string, unknown>)).toContainEqual(expect.objectContaining({
      event: 'request', route: 'pass', status: 502, code: 'apns-error', apns_status: 403, reason: 'InvalidProviderToken',
    }));
  });

  it('token wielkimi literami: adres APNs i przepustka liczone na małych', async () => {
    const h = await setup({ apns: [{ status: 200 }] });
    const upper = await call(h, post('/v1/pass', passBody({ token: T1.toUpperCase() })));
    const lower = await call(h, post('/v1/pass', passBody()));
    expect(h.calls.map((c) => c.url)).toEqual([
      `https://api.sandbox.push.apple.com/3/device/${T1}`, `https://api.sandbox.push.apple.com/3/device/${T1}`,
    ]);
    expect(upper.body['pass']).toBe(lower.body['pass']);
    expect(String(upper.body['pass']).split('.')[4]).toBe(await tokenHashOf(T1));
  });

  it.each([
    ['v ≠ 1', passBody({ v: 2 })],
    ['brak tokenu', passBody({ token: undefined })],
    ['token za krótki', passBody({ token: 'ab'.repeat(15) })],
    ['nieznane środowisko', passBody({ environment: 'staging' })],
    ['typ background', passBody({ type: 'background' })],
    ['temat nie napisem', passBody({ topic: 1 })],
    ['devicePass przy alert', passBody({ devicePass: 'v1.x' })],
    ['liveactivity bez devicePass', passBody({ type: 'liveactivity' })],
  ])('400 bad-request: %s (bez Apple)', async (_what, body) => {
    const h = await setup();
    expect(await call(h, post('/v1/pass', body))).toEqual({ status: 400, body: { v: 1, error: 'bad-request' } });
    expect(h.calls).toEqual([]);
  });

  it('ciało nie-JSON i tablica → 400', async () => {
    const h = await setup();
    expect((await call(h, post('/v1/pass', '{"v":1,'))).status).toBe(400);
    expect((await call(h, post('/v1/pass', '[1]'))).status).toBe(400);
  });

  it('temat legacy i obcy → 400 topic-not-allowed (bez Apple)', async () => {
    const h = await setup();
    for (const topic of ['pl.useo.rarog', 'ai.rarog.app.push-type.liveactivity', 'com.example.app']) {
      expect(await call(h, post('/v1/pass', passBody({ topic }))))
        .toEqual({ status: 400, body: { v: 1, error: 'topic-not-allowed' } });
    }
    expect(h.calls).toEqual([]);
  });

  it('nieznane pole w ciele nie przeszkadza (zgodność z nowszym serwerem)', async () => {
    const h = await setup({ apns: [{ status: 200 }] });
    expect((await call(h, post('/v1/pass', passBody({ future: true })))).status).toBe(200);
  });
});

describe('/v1/pass typu liveactivity', () => {
  const laBody = (devicePass: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
    passBody({ token: T2, type: 'liveactivity', devicePass, ...extra });

  it('ważna devicePass (alert, to samo środowisko) → przepustka aktywności v2 ze skrótem rodzica, bez Apple', async () => {
    const { pem } = await testKey();
    const device = await issueDevicePass(baseEnv(pem));
    const h = await setup();
    const { status, body } = await call(h, post('/v1/pass', laBody(device)));
    expect(status).toBe(200);
    expect(body['pass']).toMatch(new RegExp(
      `^v2\\.k1\\.development\\.liveactivity\\.${await tokenHashOf(T2)}\\.${await tokenHashOf(T1)}\\.[0-9]+\\.[A-Za-z0-9_-]{43}$`));
    expect(h.calls).toEqual([]);
  });

  it('termin kafla = min(teraz + 90 dni, termin rodzica): kafel nie przeżyje przepustki urządzenia', async () => {
    const { pem } = await testKey();
    const env = baseEnv(pem);
    const older = await issueDevicePass(env, T1, 'development', NOW_MS - 30 * DAY_S * 1000);
    const younger = await issueDevicePass(env, T1, 'development', NOW_MS + 10 * DAY_S * 1000);
    const h = await setup();
    const fromOlder = (await call(h, post('/v1/pass', laBody(older)))).body;
    expect(fromOlder['expiresAt']).toBe(new Date(NOW_MS + 60 * DAY_S * 1000).toISOString());
    expect(String(fromOlder['pass']).split('.')[6]).toBe(older.split('.')[5]);
    const fromYounger = (await call(h, post('/v1/pass', laBody(younger)))).body;
    expect(fromYounger['expiresAt']).toBe(new Date(NOW_MS + 90 * DAY_S * 1000).toISOString());
  });

  it('devicePass z innego środowiska, typu liveactivity, przeterminowana, obca albo śmieci → 401', async () => {
    const { pem } = await testKey();
    const env = baseEnv(pem);
    const production = await issueDevicePass(env, T1, 'production');
    const old = await issueDevicePass(env, T1, 'development', NOW_MS - 91 * DAY_S * 1000);
    const foreign = await issueDevicePass(baseEnv(pem, { PASS_KEYS: OTHER_PASS_KEYS }));
    const h = await setup();
    const activity = String((await call(h, post('/v1/pass', laBody(await issueDevicePass(env))))).body['pass']);
    for (const devicePass of [production, old, foreign, activity, 'v1.k1.nonsense']) {
      expect(await call(h, post('/v1/pass', laBody(devicePass))), devicePass.slice(0, 30))
        .toEqual({ status: 401, body: { v: 1, error: 'pass-invalid' } });
    }
  });
});

describe('/v1/push', () => {
  it('200 Apple → 200 {apnsStatus: 200}; ładunek bajt w bajt, token małymi literami', async () => {
    const { pem } = await testKey();
    const pass = await issueDevicePass(baseEnv(pem));
    const h = await setup({ apns: [{ status: 200 }] });
    const result = await call(h, post('/v1/push', pushBody(pass, { token: T1.toUpperCase() })));
    expect(result).toEqual({ status: 200, body: { v: 1, apnsStatus: 200 } });
    expect(h.calls[0]?.url).toBe(`https://api.sandbox.push.apple.com/3/device/${T1}`);
    expect(h.calls[0]?.body).toBe(blocking.payload);
  });

  it.each<[string, ApnsReply, Record<string, unknown>]>([
    ['410', { status: 410, body: '{"reason":"Unregistered","timestamp":1793600000000}' },
      { apnsStatus: 410, reason: 'Unregistered', timestamp: 1793600000000 }],
    ['400 BadDeviceToken', { status: 400, body: '{"reason":"BadDeviceToken"}' }, { apnsStatus: 400, reason: 'BadDeviceToken' }],
    ['403', { status: 403, body: '{"reason":"ExpiredProviderToken"}' }, { apnsStatus: 403, reason: 'ExpiredProviderToken' }],
    ['429', { status: 429, body: '{"reason":"TooManyRequests"}' }, { apnsStatus: 429, reason: 'TooManyRequests' }],
    ['503 bez ciała', { status: 503 }, { apnsStatus: 503 }],
  ])('Apple %s → dalej 200 przekaźnika z lustrem', async (_what, reply, mirror) => {
    const { pem } = await testKey();
    const pass = await issueDevicePass(baseEnv(pem));
    const h = await setup({ apns: [reply] });
    expect(await call(h, post('/v1/push', pushBody(pass)))).toEqual({ status: 200, body: { v: 1, ...mirror } });
  });

  it('brak odpowiedzi Apple → 502 apns-unreachable (sukces dopiero po odpowiedzi Apple)', async () => {
    const { pem } = await testKey();
    const pass = await issueDevicePass(baseEnv(pem));
    for (const reply of ['network', 'timeout'] as const) {
      const h = await setup({ apns: [reply] });
      expect(await call(h, post('/v1/push', pushBody(pass)))).toEqual({ status: 502, body: { v: 1, error: 'apns-unreachable' } });
    }
  });

  it('przepustka: inny token, inne środowisko, przeterminowana, z innego przekaźnika → 401, bez Apple i bez limitu', async () => {
    const { pem } = await testKey();
    const env = baseEnv(pem);
    const cases = [
      { pass: await issueDevicePass(env, T3), body: {} },
      { pass: await issueDevicePass(env, T1, 'production'), body: {} },
      { pass: await issueDevicePass(env, T1, 'development', NOW_MS - 91 * DAY_S * 1000), body: {} },
      { pass: await issueDevicePass(baseEnv(pem, { PASS_KEYS: OTHER_PASS_KEYS })), body: {} },
      { pass: await issueDevicePass(env), body: { environment: 'production' } },
    ];
    const h = await setup();
    for (const { pass, body } of cases) {
      expect(await call(h, post('/v1/push', pushBody(pass, body)))).toEqual({ status: 401, body: { v: 1, error: 'pass-invalid' } });
    }
    expect(h.calls).toEqual([]);
    expect(h.limitKeys.push).toEqual([]);
    expect(h.limitKeys.pushAddr).toEqual([]);
  });

  it('apns-push-type różny od typu przepustki → 400 payload-rejected {rule: push-type}', async () => {
    const { pem } = await testKey();
    const pass = await issueDevicePass(baseEnv(pem));
    const h = await setup();
    const headers = { 'apns-push-type': 'liveactivity', 'apns-topic': 'ai.rarog.app.push-type.liveactivity' };
    expect(await call(h, post('/v1/push', pushBody(pass, { headers }))))
      .toEqual({ status: 400, body: { v: 1, error: 'payload-rejected', rule: 'push-type' } });
    expect(h.calls).toEqual([]);
  });

  it('jawny baner v1 (tytuł i treść w `aps.alert`) → 400 payload-rejected {rule: alert}, bez Apple', async () => {
    const { pem } = await testKey();
    const pass = await issueDevicePass(baseEnv(pem));
    const h = await setup({ apns: [{ status: 200 }] });
    const v1 = JSON.stringify({ aps: { alert: { title: '⏳ Czeka na zgodę · willow', body: 'Edit' }, sound: 'default' },
      rarog: { v: 1, kind: 'permission', sessionId: 's' } });
    expect(await call(h, post('/v1/push', pushBody(pass, { payload: v1 }))))
      .toEqual({ status: 400, body: { v: 1, error: 'payload-rejected', rule: 'alert' } });
    expect(h.calls).toEqual([]);
  });

  it.each([
    ['payload jako obiekt', { payload: { aps: {} } }],
    ['headers jako tablica', { headers: [] }],
    ['wartość nagłówka liczbą', { headers: { 'apns-priority': 10 } }],
    ['17 nagłówków', { headers: Object.fromEntries(Array.from({ length: 17 }, (_x, i) => [`h${String(i)}`, 'x'])) }],
    ['brak przepustki', { pass: undefined }],
    ['v ≠ 1', { v: 2 }],
  ])('400 bad-request: %s', async (_what, extra) => {
    const h = await setup();
    expect(await call(h, post('/v1/push', pushBody('v1.x', extra)))).toEqual({ status: 400, body: { v: 1, error: 'bad-request' } });
  });
});

describe('/v1/push: renewedPass', () => {
  async function pushWith(passEnv: Record<string, string>, issuedAtMs: number, reply: ApnsReply): Promise<Record<string, unknown>> {
    const { pem } = await testKey();
    const pass = await issueDevicePass(baseEnv(pem, passEnv), T1, 'development', issuedAtMs);
    const h = await setup({ apns: [reply] });
    return (await call(h, post('/v1/push', pushBody(pass)))).body;
  }

  it('świeża przepustka bieżącego kid → bez renewedPass', async () => {
    expect(await pushWith({}, NOW_MS, { status: 200 })).toEqual({ v: 1, apnsStatus: 200 });
  });

  it('mniej niż 7 dni do exp → renewedPass na 90 dni bieżącym kid', async () => {
    const body = await pushWith({}, NOW_MS - 84 * DAY_S * 1000, { status: 200 });
    const renewed = body['renewedPass'] as { pass: string; expiresAt: string };
    expect(renewed.pass).toMatch(/^v1\.k1\.development\.alert\./);
    expect(renewed.expiresAt).toBe(new Date(NOW_MS + 90 * DAY_S * 1000).toISOString());
  });

  it('7 dni i więcej do exp → bez odnowienia', async () => {
    expect(await pushWith({}, NOW_MS - 83 * DAY_S * 1000, { status: 200 })).toEqual({ v: 1, apnsStatus: 200 });
  });

  it('stary kid (zakładka rotacji) → renewedPass z bieżącym kid', async () => {
    const body = await pushWith({ PASS_KID: 'k0' }, NOW_MS, { status: 200 });
    expect((body['renewedPass'] as { pass: string }).pass).toMatch(/^v1\.k1\./);
  });

  it('odnowienie tylko po 200 Apple (410 nie przedłuża martwego tokenu)', async () => {
    expect(await pushWith({ PASS_KID: 'k0' }, NOW_MS, { status: 410 })).toEqual({ v: 1, apnsStatus: 410 });
  });

  it.each<[string, Record<string, string>, number]>([
    ['mniej niż 7 dni do exp', {}, NOW_MS - 85 * DAY_S * 1000],
    ['stary kid', { PASS_KID: 'k0' }, NOW_MS],
  ])('kafel bez renewedPass (%s): push nie zna terminu rodzica, kafel odnawia przegląd serwera (Z4, N4-T1)',
    async (_what, issuerEnv, issuedAtMs) => {
      const { pem } = await testKey();
      const device = await issueDevicePass(baseEnv(pem));
      const issuer = await setup({ env: issuerEnv });
      issuer.clock.ms = issuedAtMs;
      const la = String((await call(issuer, post('/v1/pass', passBody({ token: T2, type: 'liveactivity', devicePass: device }))))
        .body['pass']);
      expect(la).toMatch(/^v2\./);
      const h = await setup({ apns: [{ status: 200 }] });
      const headers = { 'apns-push-type': 'liveactivity', 'apns-topic': 'ai.rarog.app.push-type.liveactivity' };
      const payload = JSON.stringify({ aps: { timestamp: 1, event: 'update', 'content-state': { waiting: 0 } } });
      expect(await call(h, post('/v1/push', { v: 1, pass: la, token: T2, environment: 'development', headers, payload })))
        .toEqual({ status: 200, body: { v: 1, apnsStatus: 200 } });
      expect(h.lines.map((line) => JSON.parse(line) as Record<string, unknown>))
        .toContainEqual(expect.objectContaining({ route: 'push', type: 'liveactivity', renewed: false }));
    });
});

describe('limity (Rate Limiting)', () => {
  it('/v1/pass: klucz = adres klienta IPv4 bez zmian; przekroczony → 429 bez Apple', async () => {
    const h = await setup({ limits: { pass: false } });
    expect(await call(h, post('/v1/pass', passBody()))).toEqual({ status: 429, body: { v: 1, error: 'relay-limited' } });
    expect(h.limitKeys.pass).toEqual(['203.0.113.7']);
    expect(h.calls).toEqual([]);
  });

  it('/v1/pass bez adresu klienta → wspólny klucz „unknown”', async () => {
    const h = await setup({ apns: [{ status: 200 }] });
    await h.relay.handle(post('/v1/pass', passBody()), h.context(null));
    expect(h.limitKeys.pass).toEqual(['unknown']);
  });

  it('/v1/pass: adresy IPv6 jednej /64 → jeden klucz, inna /64 → inny', async () => {
    const h = await setup({ apns: [{ status: 200 }] });
    for (const address of ['2001:db8:0:1::5', '2001:DB8:0:1:ffff:ffff:ffff:9', '2001:0db8:0000:0001:0:0:0:7', '2001:db8:0:2::5']) {
      await h.relay.handle(post('/v1/pass', passBody()), h.context(address));
    }
    const [a, b, c, other] = h.limitKeys.pass;
    expect(a).toBe('2001:0db8:0000:0001::/64');
    expect([b, c]).toEqual([a, a]);
    expect(other).toBe('2001:0db8:0000:0002::/64');
  });

  it('/v1/push: klucz banera = a:<skrót tokenu> (nie token); przekroczony → 429 bez Apple', async () => {
    const { pem } = await testKey();
    const pass = await issueDevicePass(baseEnv(pem));
    const h = await setup({ limits: { push: false } });
    expect(await call(h, post('/v1/push', pushBody(pass, { token: T1.toUpperCase() }))))
      .toEqual({ status: 429, body: { v: 1, error: 'relay-limited' } });
    expect(h.limitKeys.push).toEqual([`a:${await tokenHashOf(T1)}`]);
    expect(h.calls).toEqual([]);
  });

  it('/v1/pass: awaria licznika → 429 relay-limited i linia limit-error, bez Apple', async () => {
    const h = await setup({ apns: [{ status: 200 }], limits: { pass: 'throw' } });
    expect(await call(h, post('/v1/pass', passBody()))).toEqual({ status: 429, body: { v: 1, error: 'relay-limited' } });
    expect(h.calls).toEqual([]);
    expect(h.lines.map((line) => JSON.parse(line) as Record<string, unknown>))
      .toContainEqual({ event: 'limit-error', route: 'pass' });
  });

  it('/v1/push: awaria licznika → przepuszcza (przepustka już sprawdzona) i zostawia linię limit-error', async () => {
    const { pem } = await testKey();
    const pass = await issueDevicePass(baseEnv(pem));
    const h = await setup({ apns: [{ status: 200 }], limits: { push: 'throw' } });
    expect(await call(h, post('/v1/push', pushBody(pass)))).toEqual({ status: 200, body: { v: 1, apnsStatus: 200 } });
    expect(h.lines.map((line) => JSON.parse(line) as Record<string, unknown>))
      .toContainEqual({ event: 'limit-error', route: 'push' });
  });
});

describe('przepustka kafla v2: rodzic, liczniki i migracja', () => {
  const LA_HEADERS = { 'apns-push-type': 'liveactivity', 'apns-topic': 'ai.rarog.app.push-type.liveactivity' };
  const LA_PAYLOAD = JSON.stringify({ aps: { timestamp: 1, event: 'update', 'content-state': { waiting: 0 } } });
  const laPush = (pass: string, token: string): Record<string, unknown> =>
    ({ v: 1, pass, token, environment: 'development', headers: LA_HEADERS, payload: LA_PAYLOAD });
  const laPass = (devicePass: string, token: string): Record<string, unknown> =>
    passBody({ token, type: 'liveactivity', devicePass });
  const tokenOf = (seed: number): string => seed.toString(16).padStart(2, '0').repeat(40);

  it('trzy kafle jednego urządzenia niosą skrót rodzica, a ich wysyłki liczą się pod JEDNYM kluczem la:<rodzic>', async () => {
    const { pem } = await testKey();
    const device = await issueDevicePass(baseEnv(pem));
    const parent = await tokenHashOf(T1);
    const h = await setup({ apns: [{ status: 200 }] });
    const tokens = [tokenOf(0xb1), tokenOf(0xb2), tokenOf(0xb3)];
    for (const token of tokens) {
      const pass = String((await call(h, post('/v1/pass', laPass(device, token)))).body['pass']);
      expect(pass.split('.')).toHaveLength(8);
      expect(pass.split('.').slice(0, 6))
        .toEqual(['v2', 'k1', 'development', 'liveactivity', await tokenHashOf(token), parent]);
      expect((await call(h, post('/v1/push', laPush(pass, token)))).status).toBe(200);
    }
    expect(h.limitKeys.push).toEqual([`la:${parent}`, `la:${parent}`, `la:${parent}`]);
    const banner = await setup({ apns: [{ status: 200 }] });
    await call(banner, post('/v1/push', pushBody(device)));
    expect(banner.limitKeys.push).toEqual([`a:${parent}`]);
  });

  it('50 kafli z jednej przepustki urządzenia (różne adresy): od 11. żądania 429 bez przepustki', async () => {
    const { pem } = await testKey();
    const device = await issueDevicePass(baseEnv(pem));
    const counts = new Map<string, number>();
    const window = (key: string): boolean => {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return (counts.get(key) ?? 0) <= 10;
    };
    const h = await setup({ limits: { pass: window } });
    const statuses: number[] = [];
    for (let i = 0; i < 50; i += 1) {
      const response = await h.relay.handle(post('/v1/pass', laPass(device, tokenOf(i))), h.context(`198.51.100.${String(i)}`));
      const body = await response.json() as Record<string, unknown>;
      statuses.push(response.status);
      if (response.status === 429) expect(body).toEqual({ v: 1, error: 'relay-limited' });
    }
    expect(statuses.slice(0, 10)).toEqual(Array<number>(10).fill(200));
    expect(statuses.slice(10)).toEqual(Array<number>(40).fill(429));
    expect(h.limitKeys.pass.filter((key) => key.startsWith('la:'))).toHaveLength(50);
  });

  it('licznik rodzica tylko za WAŻNĄ devicePass: zła przepustka urządzenia → 401 bez licznika la:', async () => {
    const h = await setup();
    expect((await call(h, post('/v1/pass', laPass('v1.k1.nonsense', T2)))).status).toBe(401);
    expect(h.limitKeys.pass).toEqual(['203.0.113.7']);
  });

  it('kafel v1 w starym formacie (napis z ramki sprzed formatu v2) → 401 w /v1/push, bez Apple i bez limitu', async () => {
    const h = await setup({ apns: [{ status: 200 }] });
    const legacy = 'v1.k1.development.liveactivity.be11da276dbba8d6.1800525600.ZDsdjlMtc1TCoavbXgk8jjmPrgzpKqy8TrN8Yxf7Vos';
    expect(await call(h, post('/v1/push', laPush(legacy, T2)))).toEqual({ status: 401, body: { v: 1, error: 'pass-invalid' } });
    expect(h.calls).toEqual([]);
    expect(h.limitKeys.push).toEqual([]);
    expect(h.limitKeys.pushAddr).toEqual([]);
  });

  it('RL_PUSH_ADDR: klucz z adresu klienta (IPv6 po /64); przekroczony → 429 bez Apple; zła przepustka go nie zużywa', async () => {
    const { pem } = await testKey();
    const pass = await issueDevicePass(baseEnv(pem));
    const h = await setup({ limits: { pushAddr: false } });
    const response = await h.relay.handle(post('/v1/push', pushBody(pass)), h.context('2001:db8:0:1::abcd'));
    expect({ status: response.status, body: await response.json() }).toEqual({ status: 429, body: { v: 1, error: 'relay-limited' } });
    expect(h.limitKeys.pushAddr).toEqual(['2001:0db8:0000:0001::/64']);
    expect(h.calls).toEqual([]);
    await h.relay.handle(post('/v1/push', pushBody('v1.k1.zla')), h.context('2001:db8:0:1::abcd'));
    expect(h.limitKeys.pushAddr).toHaveLength(1);
  });

  it('RL_PUSH_ADDR: awaria licznika przepuszcza jak reszta /v1/push (fail-open, linia limit-error)', async () => {
    const { pem } = await testKey();
    const pass = await issueDevicePass(baseEnv(pem));
    const h = await setup({ apns: [{ status: 200 }], limits: { pushAddr: 'throw' } });
    expect((await call(h, post('/v1/push', pushBody(pass)))).status).toBe(200);
    expect(h.lines.map((line) => JSON.parse(line) as Record<string, unknown>))
      .toContainEqual({ event: 'limit-error', route: 'push' });
  });
});

describe('nagłówki tras POST: Content-Type i X-Rarog-Relay-Client przed ciałem', () => {
  const raw = (path: string, headers: Record<string, string>, body: unknown = passBody()): Request =>
    new Request(`https://relay.test${path}`, { method: 'POST', headers, body: JSON.stringify(body) });

  it('text/plain (prosty POST z przeglądarki) → 400 bez limitu i bez Apple', async () => {
    const h = await setup({ apns: [{ status: 200 }] });
    const request = raw('/v1/pass', { 'content-type': 'text/plain;charset=UTF-8', [CLIENT_HEADER]: 'x/1' });
    expect(await call(h, request)).toEqual({ status: 400, body: { v: 1, error: 'bad-request' } });
    expect(h.limitKeys.pass).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  it.each([
    ['brak Content-Type (ciało napisem: text/plain)', { [CLIENT_HEADER]: 'x/1' }],
    ['form-urlencoded', { 'content-type': 'application/x-www-form-urlencoded', [CLIENT_HEADER]: 'x/1' }],
    ['application/jsonp', { 'content-type': 'application/jsonp', [CLIENT_HEADER]: 'x/1' }],
    ['brak X-Rarog-Relay-Client', { 'content-type': 'application/json' }],
    ['pusty X-Rarog-Relay-Client', { 'content-type': 'application/json', [CLIENT_HEADER]: '' }],
    ['X-Rarog-Relay-Client ponad 128 znaków', { 'content-type': 'application/json', [CLIENT_HEADER]: 'x'.repeat(129) }],
  ])('/v1/pass i /v1/push: %s → 400 bez limitu i bez Apple', async (_what, headers) => {
    const { pem } = await testKey();
    const pass = await issueDevicePass(baseEnv(pem));
    const h = await setup({ apns: [{ status: 200 }] });
    const passRequest = raw('/v1/pass', headers);
    const pushRequest = raw('/v1/push', headers, pushBody(pass));
    expect(await call(h, passRequest)).toEqual({ status: 400, body: { v: 1, error: 'bad-request' } });
    expect(await call(h, pushRequest)).toEqual({ status: 400, body: { v: 1, error: 'bad-request' } });
    expect(h.limitKeys).toEqual({ pass: [], push: [], pushAddr: [] });
    expect(h.calls).toEqual([]);
    // Odmowa PRZED czytaniem ciała: strumień zostaje nietknięty.
    expect([passRequest.bodyUsed, pushRequest.bodyUsed]).toEqual([false, false]);
  });

  it('zły nagłówek przy ciele strumieniem bez Content-Length → 400, a strumień nieczytany', async () => {
    const h = await setup();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(passBody())));
        controller.close();
      },
    });
    const request = new Request('https://relay.test/v1/pass', {
      method: 'POST', headers: { 'content-type': 'text/plain', [CLIENT_HEADER]: 'x/1' }, body: stream,
      duplex: 'half',
    } as RequestInit);
    expect(await call(h, request)).toEqual({ status: 400, body: { v: 1, error: 'bad-request' } });
    expect(request.bodyUsed).toBe(false);
  });

  it('application/json z parametrem i dowolną wielkością liter przechodzi; klient 128 znaków przechodzi', async () => {
    const h = await setup({ apns: [{ status: 200 }] });
    for (const contentType of ['application/json; charset=utf-8', 'Application/JSON', 'application/json;charset=UTF-8']) {
      const request = raw('/v1/pass', { 'content-type': contentType, [CLIENT_HEADER]: 'x'.repeat(128) });
      expect((await call(h, request)).status, contentType).toBe(200);
    }
  });

  it('GET /v1/health bez żadnych nagłówków przechodzi (gołe curl); OPTIONS → 405 bez CORS (preflight pada)', async () => {
    const h = await setup();
    expect((await call(h, new Request('https://relay.test/v1/health'))).status).toBe(200);
    const preflight = await h.relay.handle(new Request('https://relay.test/v1/pass', {
      method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    }), h.context());
    expect(preflight.status).toBe(405);
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
    expect(preflight.headers.get('access-control-allow-headers')).toBeNull();
  });
});


describe('nagłówek klienta tylko pod nową nazwą: stary nagłówek to brak nagłówka', () => {
  const OLD_CLIENT_HEADER = 'x-pilot-relay-client'; // stara-nazwa
  const raw = (path: string, body: unknown, headers: Record<string, string>): Request =>
    new Request(`https://relay.test${path}`,
      { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const loggedClient = (h: Harness): unknown =>
    h.lines.map((line) => JSON.parse(line) as Record<string, unknown>).find((line) => line['event'] === 'request')?.['client'];

  it.each([
    ['tylko nowy', { [CLIENT_HEADER]: 'rarog-server/0.2.0' }, 200, 'rarog-server/0.2.0'],
    ['tylko stary', { [OLD_CLIENT_HEADER]: 'old-server/0.1.0' }, 400, undefined],
    ['oba: liczy się nowy, stary pominięty', { [CLIENT_HEADER]: 'rarog-server/0.2.0', [OLD_CLIENT_HEADER]: 'x/1' }, 200,
      'rarog-server/0.2.0'],
    ['pusty nowy przy ustawionym starym', { [CLIENT_HEADER]: '', [OLD_CLIENT_HEADER]: 'x/1' }, 400, undefined],
    ['nowy ponad 128 znaków przy poprawnym starym', { [CLIENT_HEADER]: 'x'.repeat(129), [OLD_CLIENT_HEADER]: 'x/1' },
      400, undefined],
  ])('/v1/pass, %s', async (_what, headers, status, client) => {
    const h = await setup({ apns: [{ status: 200 }] });
    const response = await call(h, raw('/v1/pass', passBody(), headers));
    expect(response.status).toBe(status);
    if (status === 400) {
      expect(response.body).toEqual({ v: 1, error: 'bad-request' });
      expect(h.calls).toEqual([]);
    }
    if (client !== undefined) expect(loggedClient(h)).toBe(client);
  });

  it('/v1/push z samym starym nagłówkiem: 400 `bad-request`, Apple nie dostaje nic', async () => {
    const { pem } = await testKey();
    const pass = await issueDevicePass(baseEnv(pem));
    const h = await setup();
    const response = await call(h, raw('/v1/push', pushBody(pass), { [OLD_CLIENT_HEADER]: 'old-server/0.1.0' }));
    expect(response).toEqual({ status: 400, body: { v: 1, error: 'bad-request' } });
    expect(h.calls).toEqual([]);
  });

  it('nagłówki mają różne nazwy, a nowy to x-rarog-relay-client', () => {
    expect(CLIENT_HEADER).toBe('x-rarog-relay-client');
    expect(OLD_CLIENT_HEADER).not.toBe(CLIENT_HEADER);
  });
});

describe('sufit ciała 8 KiB (przed parsowaniem)', () => {
  const padded = (bytes: number): string => {
    const base = JSON.stringify(passBody({ pad: '' }));
    return JSON.stringify(passBody({ pad: 'x'.repeat(bytes - base.length) }));
  };

  it('dokładnie 8 KiB przechodzi, bajt więcej → 400 jeszcze przed limitem', async () => {
    const h = await setup({ apns: [{ status: 200 }] });
    expect(padded(BODY_MAX_BYTES)).toHaveLength(BODY_MAX_BYTES);
    expect((await call(h, post('/v1/pass', padded(BODY_MAX_BYTES)))).status).toBe(200);
    expect((await call(h, post('/v1/pass', padded(BODY_MAX_BYTES + 1)))).status).toBe(400);
    expect(h.limitKeys.pass).toHaveLength(1);
  });

  it('strumień bez Content-Length też ucięty na suficie', async () => {
    const h = await setup();
    const chunk = new TextEncoder().encode('x'.repeat(1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1;
        if (sent > 64) controller.close();
        else controller.enqueue(chunk);
      },
    });
    // Nagłówki POST są poprawne: 400 ma przyjść z sufitu ciała, nie z nagłówków.
    const request = new Request('https://relay.test/v1/pass',
      { method: 'POST', headers: POST_HEADERS, body: stream, duplex: 'half' } as RequestInit);
    expect(request.headers.get('content-length')).toBeNull();
    expect((await call(h, request)).status).toBe(400);
    expect(sent).toBeLessThan(64);
  });

  it('zadeklarowany Content-Length ponad sufit → 400 bez czytania', async () => {
    const h = await setup();
    const request = new Request('https://relay.test/v1/pass', {
      method: 'POST', headers: { ...POST_HEADERS, 'content-length': String(BODY_MAX_BYTES + 1) }, body: '{}',
    });
    expect((await call(h, request)).status).toBe(400);
  });

  it('niepoprawny UTF-8 → 400', async () => {
    const h = await setup();
    const request = new Request('https://relay.test/v1/pass',
      { method: 'POST', headers: POST_HEADERS, body: new Uint8Array([0x7b, 0xff, 0x7d]) });
    expect((await call(h, request)).status).toBe(400);
  });
});

describe('konfiguracja i /v1/health', () => {
  it('pełna konfiguracja: ok, wersja z DEPLOY_SHA, środowiska, polityka', async () => {
    const h = await setup();
    expect(await call(h, get('/v1/health'))).toEqual({ status: 200, body: {
      v: 1, ok: true, version: '1.0.0+test', environments: ['development', 'production'], alertPolicy: 'v2',
    } });
  });

  it.each([
    ['brak APNS_KEY', { APNS_KEY: undefined }, 'apns-key-missing'],
    ['zły APNS_KEY', { APNS_KEY: 'nie-klucz' }, 'apns-key-invalid'],
    ['brak APNS_KEY_ID', { APNS_KEY_ID: undefined }, 'apns-key-id-missing'],
    ['brak PASS_KEYS', { PASS_KEYS: undefined }, 'pass-keys-missing'],
    ['PASS_KID spoza PASS_KEYS', { PASS_KID: 'k9' }, 'pass-keys-invalid'],
    ['nieznana polityka', { ALERT_POLICY: 'v3' }, 'alert-policy-invalid'],
    ['polityka spoza listy (jawne banery v1)', { ALERT_POLICY: 'v1-transitional' }, 'alert-policy-invalid'],
    ['nieznane środowisko', { APNS_ENVIRONMENTS: 'development,staging' }, 'apns-environments-invalid'],
    ['zły Team ID', { APNS_TEAM_ID: 'team' }, 'apns-team-id-invalid'],
  ])('%s → 503 na obu trasach, health ok: false, linia config', async (_what, env, problem) => {
    const { pem } = await testKey();
    const pass = await issueDevicePass(baseEnv(pem));
    const h = await setup({ env });
    const unavailable = { status: 503, body: { v: 1, error: 'environment-unavailable' } };
    expect(await call(h, post('/v1/pass', passBody()))).toEqual(unavailable);
    expect(await call(h, post('/v1/push', pushBody(pass)))).toEqual(unavailable);
    const health = await call(h, get('/v1/health'));
    expect(health.body['ok']).toBe(false);
    expect(health.body['environments']).toEqual([]);
    const config = h.lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((l) => l['event'] === 'config');
    expect(config).toContainEqual({ event: 'config', problem });
    expect(h.calls).toEqual([]);
  });

  it('środowisko spoza APNS_ENVIRONMENTS → 503, drugie działa', async () => {
    const h = await setup({ env: { APNS_ENVIRONMENTS: 'development' }, apns: [{ status: 200 }] });
    expect((await call(h, post('/v1/pass', passBody({ environment: 'production' })))).status).toBe(503);
    expect((await call(h, post('/v1/pass', passBody()))).status).toBe(200);
    expect((await call(h, get('/v1/health'))).body['environments']).toEqual(['development']);
  });

  it('nieznana ścieżka → 404, zła metoda → 405 z Allow', async () => {
    const h = await setup();
    expect(await call(h, get('/'))).toEqual({ status: 404, body: { v: 1, error: 'not-found' } });
    const response = await h.relay.handle(post('/v1/health', {}), h.context());
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET');
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
