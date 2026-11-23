/**
 * Log przekaźnika: biała lista pól i szpieg loggera na wszystkich ścieżkach. W żadnej
 * linii nie ma tokenu (żadnej wielkości liter), skrótu tokenu, przepustki, ładunku, JWT, nagłówka `authorization`
 * ani komunikatu błędu sieci. `console.*` woła wyłącznie adapter `worker.ts`.
 */
import { describe, expect, it } from 'vitest';
import { ALERT_PLACEHOLDER } from '../src/alert-policy.ts';
import { sha256Hex } from '../src/bytes.ts';
import type { RelayEnv } from '../src/config.ts';
import { filterLogFields, formatLogLine } from '../src/log.ts';
import { tokenHashOf } from '../src/pass.ts';
import {
  LEAKY_ERROR, NOW_MS, T1, T2, T3, baseEnv, get, harness, issueDevicePass, post, testKey,
} from './helpers.ts';
import type { ApnsReply, LimitScript } from './helpers.ts';

interface FixtureCase {
  readonly env?: Record<string, string>;
  readonly limits?: LimitScript;
  readonly request: { readonly method: string; readonly path: string; readonly headers: Record<string, string>; readonly body?: unknown };
  readonly apns?: { readonly status: number; readonly body: string } | { readonly error: 'network' | 'timeout' };
}

const fixtures = import.meta.glob<unknown>('../../shared/fixtures/relay/*.json', { eager: true, import: 'default' });
const manifest = Object.entries(fixtures).find(([file]) => file.endsWith('/manifest.json'))?.[1] as
  { now: string; env: Record<string, string> };
const fixtureCases = Object.entries(fixtures)
  .filter(([file]) => !file.endsWith('/manifest.json') && !file.endsWith('/alert-policy.json'))
  .map(([, content]) => content as FixtureCase);

const ALLOWED_KEYS = new Set([
  'event', 'route', 'status', 'code', 'env', 'type', 'apns_status', 'reason', 'rule', 'cause', 'problem', 'ms', 'kid',
  'renewed', 'client',
]);

/** Wszystkie linie logu ze wszystkich ścieżek oraz napisy, których w nich być nie może. */
async function everyPath(): Promise<{ lines: string[]; secrets: string[] }> {
  const { pem } = await testKey();
  const lines: string[] = [];
  const secrets: string[] = [pem.split('\n')[1] ?? 'PEM', 'PRIVATE KEY', 'bearer', 'authorization', LEAKY_ERROR, 'LEAK'];
  for (const token of [T1, T2, T3]) {
    secrets.push(token, token.toUpperCase(), await tokenHashOf(token), await sha256Hex(token));
  }

  const run = async (env: RelayEnv, request: Request, options: { apns?: ApnsReply[]; limits?: LimitScript; nowMs?: number } = {}) => {
    const h = harness({ env, ...options });
    const response = await h.relay.handle(request, h.context());
    const text = await response.text();
    lines.push(...h.lines);
    for (const { headers, body } of h.calls) {
      secrets.push(headers['authorization'] ?? 'bearer', (headers['authorization'] ?? '').replace('bearer ', ''), body);
    }
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed['pass'] === 'string') secrets.push(parsed['pass']);
    const renewed = parsed['renewedPass'] as { pass?: string } | undefined;
    if (renewed?.pass !== undefined) secrets.push(renewed.pass);
  };

  // 1. Każdy przypadek kontraktu.
  for (const fixture of fixtureCases) {
    const body = fixture.request.body as Record<string, unknown> | undefined;
    for (const key of ['pass', 'devicePass', 'payload']) if (typeof body?.[key] === 'string') secrets.push(body[key] as string);
    const apns: ApnsReply[] | undefined = fixture.apns === undefined ? undefined
      : 'error' in fixture.apns ? [fixture.apns.error] : [{ status: fixture.apns.status, body: fixture.apns.body }];
    await run({ ...manifest.env, ...fixture.env, APNS_KEY: pem }, new Request(`https://relay.test${fixture.request.path}`, {
      method: fixture.request.method,
      headers: { ...fixture.request.headers, authorization: 'bearer LEAK-SENTINEL-AUTH' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), {
      nowMs: Date.parse(manifest.now),
      ...(apns === undefined ? {} : { apns }),
      ...(fixture.limits === undefined ? {} : { limits: fixture.limits }),
    });
  }

  // 2. Ścieżki spoza fixture'ów: wydanie i odnowienie, aktywność, awaria limitu, zła konfiguracja, wyjątek.
  const env = baseEnv(pem);
  const device = await issueDevicePass(env);
  const expiring = await issueDevicePass(env, T1, 'development', NOW_MS - 85 * 24 * 3600 * 1000);
  // Baner formatu 3 przechodzi do Apple (szyfrogram w bloku `rarog`); jawny tekst w `aps.alert` odpada na polityce.
  const payload = JSON.stringify({
    aps: { alert: { ...ALERT_PLACEHOLDER }, 'mutable-content': 1 },
    rarog: { v: 3, kid: '0a1b2c3d', n: 'AAAAAAAAAAAAAAAA', c: 'Sekretny-szyfrogram-klienta' },
  });
  const plain = JSON.stringify({ aps: { alert: { title: 'Sekretny projekt klienta', body: 'rm -rf tajne' } } });
  secrets.push(device, expiring, payload, plain, 'Sekretny projekt', 'Sekretny-szyfrogram', 'tajne');
  const headers = { 'apns-push-type': 'alert', 'apns-topic': 'ai.rarog.app' };
  const passReq = (extra: Record<string, unknown> = {}) =>
    post('/v1/pass', { v: 1, token: T1.toUpperCase(), environment: 'development', type: 'alert', topic: 'ai.rarog.app', ...extra });
  const pushReq = (pass: string, extra: Record<string, unknown> = {}) =>
    post('/v1/push', { v: 1, pass, token: T1, environment: 'development', headers, payload, ...extra });

  await run(env, passReq(), { apns: [{ status: 200 }] });
  await run(env, passReq({ token: T2, type: 'liveactivity', devicePass: device }));
  await run(env, passReq(), { apns: [{ status: 200 }], limits: { pass: 'throw' } });
  await run(env, passReq(), { apns: ['network'] });
  await run(env, pushReq(expiring), { apns: [{ status: 200 }] });
  await run(env, pushReq(device), { apns: ['timeout'] });
  await run(env, pushReq(device), { apns: [{ status: 400, body: '{"reason":"BadDeviceToken"}' }] });
  await run(env, pushReq(device), { limits: { push: 'throw' }, apns: [{ status: 200 }] });
  await run(env, pushReq(device, { payload: plain }));
  await run(env, pushReq(device, { token: T3 }));
  await run(baseEnv(pem, { APNS_KEY: undefined, PASS_KEYS: 'zepsute' }), pushReq(device));
  await run(env, get('/v1/health'));
  await run(env, post('/v1/pass', 'x'.repeat(9000)));
  return { lines, secrets: secrets.filter((secret) => secret.length >= 6) };
}

describe('log: szpieg na wszystkich ścieżkach', () => {
  it('żadna linia nie niesie tokenu, skrótu, przepustki, ładunku, JWT ani authorization', async () => {
    const { lines, secrets } = await everyPath();
    expect(lines.length).toBeGreaterThan(40);
    for (const line of lines) {
      for (const secret of secrets) expect(line.includes(secret), `linia „${line}” niesie „${secret.slice(0, 24)}…”`).toBe(false);
    }
  });

  it('każda linia to JSON z polami wyłącznie z białej listy; żądanie ma trasę, status i czas', async () => {
    const { lines } = await everyPath();
    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const fields of parsed) {
      for (const key of Object.keys(fields)) expect(ALLOWED_KEYS.has(key), key).toBe(true);
    }
    const requests = parsed.filter((fields) => fields['event'] === 'request');
    expect(requests.length).toBeGreaterThan(30);
    for (const fields of requests) {
      expect(typeof fields['route']).toBe('string');
      expect(typeof fields['status']).toBe('number');
      expect(typeof fields['ms']).toBe('number');
    }
    expect(requests.some((fields) => fields['client'] === 'rarog-server/0.1.0')).toBe(true);
    expect(requests.some((fields) => fields['apns_status'] === 400 && fields['reason'] === 'BadDeviceToken')).toBe(true);
  });
});

describe('log: biała lista', () => {
  it('pole spoza listy i wartość o złym kształcie odpadają', () => {
    expect(filterLogFields({
      event: 'request', token: T1, pass: 'v1.k1.x', payload: '{}', authorization: 'bearer x',
      reason: 'Bad Device <token>', client: `rarog-server/${'x'.repeat(40)}`, env: 'staging', kid: 'k.1', status: '200',
      ms: 1.5, rule: 'Alert!', renewed: 'tak', route: '/v1/pass',
    })).toEqual({ event: 'request' });
  });

  it('dobre kształty przechodzą', () => {
    expect(JSON.parse(formatLogLine({
      event: 'request', route: 'push', status: 200, code: 'payload-rejected', env: 'production', type: 'liveactivity',
      apns_status: 410, reason: 'Unregistered', rule: 'payload-canonical', cause: 'timeout', problem: 'apns-key-missing',
      ms: 12, kid: 'k1', renewed: true, client: 'rarog-server/0.1.0',
    }))).toEqual({
      event: 'request', route: 'push', status: 200, code: 'payload-rejected', env: 'production', type: 'liveactivity',
      apns_status: 410, reason: 'Unregistered', rule: 'payload-canonical', cause: 'timeout', problem: 'apns-key-missing',
      ms: 12, kid: 'k1', renewed: true, client: 'rarog-server/0.1.0',
    });
  });
});

describe('log: jedyne miejsce zapisu', () => {
  const sources = import.meta.glob<string>('../src/*.ts', { eager: true, query: '?raw', import: 'default' });

  it('`console.*` tylko w worker.ts (i tam jedna linia z console.log)', () => {
    const offenders = Object.entries(sources)
      .filter(([file, text]) => !file.endsWith('/worker.ts') && /\bconsole\./.test(text)).map(([file]) => file);
    expect(Object.keys(sources).length).toBeGreaterThan(8);
    expect(offenders).toEqual([]);
    const worker = Object.entries(sources).find(([file]) => file.endsWith('/worker.ts'))?.[1] ?? '';
    expect(worker.match(/\bconsole\.\w+/g)).toEqual(['console.log']);
  });

  it('rdzeń nie przepisuje komunikatów wyjątków (`String(err)`, `.message`)', () => {
    for (const [file, text] of Object.entries(sources)) {
      expect(/String\((err|error|e)\)|\.message\b|\.stack\b/.test(text), file).toBe(false);
    }
  });
});
