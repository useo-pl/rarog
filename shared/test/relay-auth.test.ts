/**
 * Kontrakt rejestru relaya iroh: przypadki `shared/fixtures/relay-auth/manifest.json` → `parseRelayAuthRequest`
 * i `relayAuthSigningText`. Te same przypadki czyta `RelayAuthWireTests` w `RarogContract` (lustro Swift), więc
 * manifest jest kontraktem obu stron: ciało → żądanie albo pole odrzucenia, żądanie → tekst do podpisu co do bajtu.
 *
 * Tekst do podpisu i podpisy w manifeście wpisał generator poza repo, który składa tekst niezależnie od modułu;
 * test sprawdza podpis `node:crypto` kluczem publicznym z `endpointId`, a Ed25519 jest deterministyczny, więc
 * podpis kluczem testowym daje te same bajty co w manifeście.
 */
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { IROH_ENDPOINT_ID_RE, irohRelayUrl } from '../src/pairing-link.ts';
import { RELAY_CLIENT_HEADER } from '../src/relay.ts';
import {
  RELAY_AUTH_ACCESS_ALLOW, RELAY_AUTH_ACCESS_DENY, RELAY_AUTH_APNS_TOKEN_RE, RELAY_AUTH_APP_ROUTES,
  RELAY_AUTH_CLIENT_HEADER, RELAY_AUTH_ENDPOINT_HEADER, RELAY_AUTH_ERROR_STATUS, RELAY_AUTH_ERRORS, RELAY_AUTH_GATES,
  RELAY_AUTH_METHODS, RELAY_AUTH_PATHS, RELAY_AUTH_REGISTRIES, RELAY_AUTH_SERVERS_MAX, RELAY_AUTH_SIGNING_DOMAIN,
  isRelayAuthEndpointId, parseRelayAuthRequest, relayAuthSigningBytes, relayAuthSigningText,
} from '../src/relay-auth.ts';
import type { RelayAuthAppRoute, RelayAuthRoute } from '../src/relay-auth.ts';
import { APNS_TOKEN_RE } from '../src/rest.ts';

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/relay-auth/manifest.json');

const appRoute = z.enum(RELAY_AUTH_APP_ROUTES);
const route = z.enum(Object.keys(RELAY_AUTH_PATHS) as [RelayAuthRoute, ...RelayAuthRoute[]]);
const requestCase = z.union([
  z.strictObject({
    description: z.string().min(1), route: appRoute, body: z.unknown(), signingText: z.string(),
    signingBytes: z.string().regex(/^(?:[0-9a-f]{2})+$/),
  }),
  z.strictObject({
    description: z.string().min(1), route: appRoute, body: z.unknown(), error: z.literal('bad-request'),
    field: z.string(),
  }),
]);
const manifest = z.strictObject({
  _comment: z.array(z.string()),
  key: z.strictObject({ source: z.string(), secretKey: z.string().regex(/^[0-9a-f]{64}$/), endpointId: z.string() }),
  registries: z.record(z.string(), z.string()),
  paths: z.record(z.string(), z.string()),
  errorStatus: z.record(z.string(), z.number().int()),
  headers: z.strictObject({ app: z.record(z.string(), z.string()), admin: z.record(z.string(), z.string()) }),
  requests: z.record(z.string(), requestCase),
  admin: z.record(z.string(), z.strictObject({ route: z.enum(['deny', 'allow']), body: z.unknown() })),
  responses: z.record(z.string(), z.strictObject({ route: route.nullable(), status: z.number().int(), body: z.unknown() })),
  access: z.record(z.string(), z.strictObject({
    description: z.string().min(1),
    request: z.strictObject({ method: z.literal('POST'), path: z.literal('/v1/access'), headers: z.record(z.string(), z.string()) }),
    response: z.strictObject({ status: z.number().int(), body: z.string() }),
  })),
}).parse(JSON.parse(readFileSync(FILE, 'utf8')));

const cases = Object.entries(manifest.requests).sort(([a], [b]) => a.localeCompare(b));
const okCases = cases.flatMap(([name, entry]) => ('signingText' in entry ? [[name, entry] as const] : []));
const rejected = cases.flatMap(([name, entry]) => ('field' in entry ? [[name, entry] as const] : []));
const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/** Klucz publiczny Ed25519 z surowych 32 bajtów (EndpointId) i prywatny z 32 bajtów ziarna (PKCS#8). */
const publicKeyOf = (endpointId: string) => createPublicKey({
  key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(endpointId, 'hex').toString('base64url') }, format: 'jwk',
});
const privateKey = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(manifest.key.secretKey, 'hex')]),
  format: 'der', type: 'pkcs8',
});

describe('rejestr relaya iroh: żądania apki z manifestu', () => {
  it.each(okCases)('%s: kształt przyjęty, tekst do podpisu co do bajtu, podpis kluczem testowym', (name, entry) => {
    const parsed = parseRelayAuthRequest(entry.route, entry.body);
    expect(parsed.ok, name).toBe(true);
    if (!parsed.ok) return;
    // Wynik to ciało bez nieznanych pól.
    const known = Object.fromEntries(Object.entries(entry.body as Record<string, unknown>).filter(([key]) => key !== 'label'));
    expect(parsed.request, name).toEqual(known);
    const text = relayAuthSigningText(entry.route, parsed.request);
    expect(text, name).toBe(entry.signingText);
    const bytes = relayAuthSigningBytes(entry.route, parsed.request);
    expect(toHex(bytes), name).toBe(entry.signingBytes);
    const sig = Buffer.from(parsed.request.sig, 'hex');
    expect(verify(null, bytes, publicKeyOf(parsed.request.endpointId), sig), name).toBe(true);
    expect(sign(null, bytes, privateKey).toString('hex'), name).toBe(parsed.request.sig);
    // Tekst bez `sig`: apka liczy go przed podpisem.
    const { sig: _sig, ...unsigned } = parsed.request;
    expect(relayAuthSigningText(entry.route, unsigned), name).toBe(entry.signingText);
  });

  it.each(rejected)('%s: odrzucony na polu z manifestu', (name, entry) => {
    expect(parseRelayAuthRequest(entry.route, entry.body), name)
      .toEqual({ ok: false, error: 'bad-request', field: entry.field });
  });

  it('podpis nie przechodzi dla innej trasy, innego `issuedAt` ani innego klucza (tekst wiąże wszystkie trzy)', () => {
    const [, entry] = okCases.find(([name]) => name === 'sponsor') ?? [];
    expect(entry).toBeDefined();
    if (entry === undefined) return;
    const parsed = parseRelayAuthRequest('sponsor', entry.body);
    if (!parsed.ok) throw new Error('sponsor z manifestu odrzucony');
    const sig = Buffer.from(parsed.request.sig, 'hex');
    const key = publicKeyOf(parsed.request.endpointId);
    const other = relayAuthSigningBytes('forget', parsed.request);
    expect(verify(null, other, key, sig)).toBe(false);
    expect(verify(null, relayAuthSigningBytes('sponsor', { ...parsed.request, issuedAt: parsed.request.issuedAt + 1 }), key,
      sig)).toBe(false);
    expect(verify(null, relayAuthSigningBytes('sponsor', parsed.request), publicKeyOf(parsed.request.server), sig))
      .toBe(false);
  });

  it('pokrycie: każda trasa apki ma przypadek przyjęty, każde pole walidacji — odrzucony', () => {
    expect([...new Set(okCases.map(([, entry]) => entry.route))].sort()).toEqual([...RELAY_AUTH_APP_ROUTES].sort());
    expect([...new Set(rejected.map(([, entry]) => entry.field))].sort()).toEqual([
      'body', 'endpointId', 'issuedAt', 'proof', 'proof.environment', 'proof.kind', 'proof.token', 'server', 'servers',
      'sig', 'v',
    ]);
    const kinds = okCases.flatMap(([, entry]) => {
      const proof = (entry.body as { proof?: { kind?: string } }).proof;
      return proof?.kind === undefined ? [] : [proof.kind];
    });
    expect([...new Set(kinds)].sort()).toEqual([...RELAY_AUTH_GATES].sort());
    expect(okCases.some(([, entry]) => entry.signingText.endsWith('\n')), 'pusta ostatnia linia (renew bez serwerów)')
      .toBe(true);
  });

  it('klucz testowy z manifestu: syntetyczne ziarno (jeden bajt × 32), EndpointId to jego klucz publiczny', () => {
    expect(manifest.key.secretKey).toBe(manifest.key.secretKey.slice(0, 2).repeat(32));
    const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
    expect(Buffer.from(String(jwk.x), 'base64url').toString('hex')).toBe(manifest.key.endpointId);
    expect(manifest.key.endpointId).toMatch(IROH_ENDPOINT_ID_RE);
  });
});

describe('rejestr relaya iroh: stałe kontraktu i odpowiedzi', () => {
  it('ścieżki i kody błędów z manifestu = stałe modułu (Swift sprawdza swoje stałe z tym samym manifestem)', () => {
    expect(manifest.paths).toEqual(RELAY_AUTH_PATHS);
    expect(manifest.errorStatus).toEqual(RELAY_AUTH_ERROR_STATUS);
    expect(Object.entries(RELAY_AUTH_METHODS).filter(([, method]) => method === 'GET').map(([name]) => name))
      .toEqual(['health']);
  });

  it('mapa relay → rejestr z manifestu = stała modułu; klucz w postaci kanonicznej `r=`, wartość to sam origin', () => {
    expect(manifest.registries).toEqual(RELAY_AUTH_REGISTRIES);
    expect(Object.keys(RELAY_AUTH_REGISTRIES).length).toBeGreaterThan(0);
    for (const [relay, registry] of Object.entries(RELAY_AUTH_REGISTRIES)) {
      expect(irohRelayUrl(relay), relay).toBe(relay);
      expect(new URL(registry).origin, registry).toBe(registry);
      expect(registry.startsWith('https://'), registry).toBe(true);
    }
  });

  it('odpowiedzi: błąd ma status ze swojego kodu, każdy kod ma przypadek, `gate` tylko przy `gate-mismatch`', () => {
    const errors = Object.values(manifest.responses).filter((entry) => entry.status !== 200);
    for (const entry of errors) {
      const body = entry.body as { v: unknown; error: keyof typeof RELAY_AUTH_ERROR_STATUS; gate?: unknown };
      expect(body.v).toBe(1);
      expect(RELAY_AUTH_ERROR_STATUS[body.error], body.error).toBe(entry.status);
      expect(body.gate === undefined, body.error).toBe(body.error !== 'gate-mismatch');
    }
    expect([...new Set(errors.map((entry) => (entry.body as { error: string }).error))].sort())
      .toEqual([...RELAY_AUTH_ERRORS].sort());
  });

  it('odpowiedzi 200: każda trasa poza `access` ma przypadek z `v: 1`; EndpointId i terminy w kształcie kontraktu', () => {
    const ok = Object.values(manifest.responses).filter((entry) => entry.status === 200);
    expect([...new Set(ok.map((entry) => entry.route))].sort())
      .toEqual(Object.keys(RELAY_AUTH_PATHS).filter((name) => name !== 'access').sort());
    for (const entry of ok) {
      const body = entry.body as Record<string, unknown>;
      expect(body['v'], String(entry.route)).toBe(1);
      for (const key of ['endpointId', 'server']) {
        if (key in body) expect(isRelayAuthEndpointId(body[key]), key).toBe(true);
      }
      if ('expiresAt' in body) expect(Number.isSafeInteger(body['expiresAt'])).toBe(true);
      if ('unsponsored' in body) expect((body['unsponsored'] as unknown[]).every(isRelayAuthEndpointId)).toBe(true);
    }
  });

  it('hak `POST /v1/access`: decyzja to 200 `true` albo 403 `false`; reszta to błąd JSON, nie decyzja', () => {
    const { allow, deny, unauthorized } = manifest.access;
    expect(allow?.response).toEqual({ status: 200, body: RELAY_AUTH_ACCESS_ALLOW });
    expect(deny?.response).toEqual({ status: 403, body: RELAY_AUTH_ACCESS_DENY });
    expect(JSON.parse(unauthorized?.response.body ?? '')).toEqual({ v: 1, error: 'unauthorized' });
    expect(unauthorized?.response.status).toBe(RELAY_AUTH_ERROR_STATUS.unauthorized);
    for (const entry of Object.values(manifest.access)) {
      expect(Object.keys(entry.request.headers).sort()).toEqual(['authorization', RELAY_AUTH_ENDPOINT_HEADER]);
      expect(entry.request.headers['authorization']).toMatch(/^Bearer \S+$/);
      expect(isRelayAuthEndpointId(entry.request.headers[RELAY_AUTH_ENDPOINT_HEADER])).toBe(true);
    }
  });

  it('nagłówki tras JSON: `Content-Type` i ten sam nagłówek klienta co przekaźnik push; admin dokłada bearer', () => {
    expect(RELAY_AUTH_CLIENT_HEADER).toBe(RELAY_CLIENT_HEADER);
    expect(Object.keys(manifest.headers.app).sort()).toEqual(['content-type', RELAY_AUTH_CLIENT_HEADER]);
    expect(Object.keys(manifest.headers.admin).sort()).toEqual(['authorization', 'content-type', RELAY_AUTH_CLIENT_HEADER]);
    for (const { route: name, body } of Object.values(manifest.admin)) {
      expect(body, name).toEqual({ v: 1, endpointId: expect.stringMatching(IROH_ENDPOINT_ID_RE) as unknown });
    }
  });

  it('wzorce wspólne z resztą kontraktów: token APNs jak `rest.ts`, EndpointId jak link parowania', () => {
    expect(RELAY_AUTH_APNS_TOKEN_RE.source).toBe(APNS_TOKEN_RE.source);
    expect(isRelayAuthEndpointId('a'.repeat(64))).toBe(true);
    for (const bad of ['A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64), 7]) expect(isRelayAuthEndpointId(bad)).toBe(false);
    expect(RELAY_AUTH_SIGNING_DOMAIN).toBe('rarog-relay-auth/v1');
    expect(RELAY_AUTH_SERVERS_MAX).toBe(32);
  });

  it('każda trasa apki składa tekst z własną ścieżką w drugiej linii', () => {
    const base = { v: 1 as const, endpointId: manifest.key.endpointId, issuedAt: 1 };
    const unsigned: { [R in RelayAuthAppRoute]: Parameters<typeof relayAuthSigningText<R>>[1] } = {
      register: { ...base, proof: { kind: 'apns', environment: 'production', token: 'ab'.repeat(16) } },
      renew: { ...base, servers: [] },
      sponsor: { ...base, server: 'b'.repeat(64) },
      forget: base,
    };
    for (const name of RELAY_AUTH_APP_ROUTES) {
      expect(relayAuthSigningText(name, unsigned[name]).split('\n')[1], name).toBe(RELAY_AUTH_PATHS[name]);
    }
  });
});
