/**
 * Kontrakt `/v1/*` = fixture'y `shared/fixtures/relay/`. Każdy przypadek przechodzi
 * przez rdzeń z atrapą Apple: status, ciało odpowiedzi i żądanie do Apple (bez `authorization`) muszą się zgadzać
 * co do bajtu. Manifest musi znać każdy plik, a każdy kod błędu każdej trasy ma choć jeden przypadek. Każde
 * żądanie POST niesie nagłówki wymagane przez przekaźnik, poza przypadkiem ze znacznikiem `header` (zły z założenia).
 * Te same pliki czytają testy nadajnika serwera (ramki żądań).
 */
import { describe, expect, it } from 'vitest';
import { PASS_ERRORS, PUSH_ERRORS, ROUTING_ERRORS } from '../src/core.ts';
import type { RelayEnv } from '../src/config.ts';
import { harness, testKey } from './helpers.ts';
import type { ApnsReply } from './helpers.ts';

interface FixtureCase {
  readonly description: string;
  readonly env?: Record<string, string>;
  readonly limits?: { readonly pass?: boolean; readonly push?: boolean };
  readonly request: {
    readonly method: string;
    readonly path: string;
    readonly headers: Record<string, string>;
    readonly body?: unknown;
  };
  readonly apns?: { readonly status: number; readonly body: string } | { readonly error: 'network' | 'timeout' };
  readonly apnsRequest?: { readonly url: string; readonly headers: Record<string, string>; readonly body: string };
  readonly response: { readonly status: number; readonly headers?: Record<string, string>; readonly body: unknown };
}

interface Manifest {
  readonly now: string;
  readonly env: Record<string, string>;
  readonly cases: Record<string, {
    readonly route: string; readonly status: number; readonly error?: string;
    /** Wymagany nagłówek POST, który ten przypadek ma zły z założenia. */
    readonly header?: string;
  }>;
}

const files = import.meta.glob<unknown>('../../shared/fixtures/relay/*.json', { eager: true, import: 'default' });
const byName = new Map(Object.entries(files).map(([file, content]) => [file.split('/').pop() ?? file, content]));
const manifest = byName.get('manifest.json') as Manifest;
const cases = [...byName].filter(([name]) => name !== 'manifest.json' && name !== 'alert-policy.json')
  .map(([name, content]) => [name, content as FixtureCase] as const)
  .sort(([a], [b]) => a.localeCompare(b));

/**
 * Który wymagany nagłówek trasy POST żądanie ma zły: `content-type` inny niż `application/json`
 * (parametry i wielkość liter bez znaczenia) albo brak `x-rarog-relay-client`. Kontrakt pokazuje wymóg: każde
 * żądanie POST bez znacznika `header` w manifeście niesie oba nagłówki.
 */
function badHeader(request: FixtureCase['request']): string | undefined {
  if (request.method !== 'POST') return undefined;
  const contentType = (request.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') return 'content-type';
  return (request.headers['x-rarog-relay-client'] ?? '') === '' ? 'x-rarog-relay-client' : undefined;
}

const toReply = (apns: FixtureCase['apns']): ApnsReply[] | undefined => {
  if (apns === undefined) return undefined;
  return 'error' in apns ? [apns.error] : [{ status: apns.status, body: apns.body }];
};

describe('fixture’y kontraktu /v1/*', () => {
  it('manifest zna dokładnie pliki katalogu, a trasa, status i kod zgadzają się z plikiem', () => {
    expect(Object.keys(manifest.cases).sort()).toEqual(cases.map(([name]) => name));
    for (const [name, fixture] of cases) {
      const entry = manifest.cases[name];
      const body = fixture.response.body as { error?: string };
      const header = badHeader(fixture.request);
      expect(entry, name).toEqual({
        route: fixture.request.path.replace('/v1/', ''),
        status: fixture.response.status,
        ...(body.error === undefined ? {} : { error: body.error }),
        ...(header === undefined ? {} : { header }),
      });
    }
  });

  it('każdy kod błędu każdej trasy ma przykład', () => {
    const routing: readonly string[] = ROUTING_ERRORS;
    const errors = Object.values(manifest.cases).flatMap((entry) => (entry.error === undefined ? [] : [entry]));
    const codes = (route: string): Set<string> => new Set(errors
      .filter((entry) => entry.route === route && !routing.includes(entry.error ?? '')).map((entry) => entry.error ?? ''));
    expect(codes('pass')).toEqual(new Set(PASS_ERRORS));
    expect(codes('push')).toEqual(new Set(PUSH_ERRORS));
    // `internal` to wyjątek w rdzeniu — przykładu nie ma z założenia.
    expect(new Set(errors.map((entry) => entry.error).filter((code) => routing.includes(code ?? ''))))
      .toEqual(new Set(['not-found', 'method-not-allowed']));
    expect(Object.values(manifest.cases).some((entry) => entry.route === 'health' && entry.status === 200)).toBe(true);
  });

  it.each(cases)('%s', async (_name, fixture) => {
    const { pem } = await testKey();
    const env: RelayEnv = { ...manifest.env, ...fixture.env, APNS_KEY: pem };
    const h = harness({
      env,
      nowMs: Date.parse(manifest.now),
      ...(fixture.limits === undefined ? {} : { limits: fixture.limits }),
      ...(toReply(fixture.apns) === undefined ? {} : { apns: toReply(fixture.apns) }),
    });
    const { request } = fixture;
    const response = await h.relay.handle(new Request(`https://push.rarog.ai${request.path}`, {
      method: request.method,
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    }), h.context());

    expect(response.status).toBe(fixture.response.status);
    expect(await response.json()).toEqual(fixture.response.body);
    for (const [name, value] of Object.entries(fixture.response.headers ?? {})) {
      expect(response.headers.get(name)).toBe(value);
    }
    if (fixture.apnsRequest === undefined) {
      expect(h.calls, 'przypadek bez apns nie woła Apple').toEqual([]);
    } else {
      expect(h.calls).toHaveLength(1);
      const sent = h.calls[0];
      const { authorization, ...headers } = sent?.headers ?? {};
      expect(authorization).toMatch(/^bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      expect({ url: sent?.url, headers, body: sent?.body }).toEqual(fixture.apnsRequest);
    }
  });
});
