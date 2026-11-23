/**
 * Kontrakt przekaźnika push, strona PRODUCENTA: żądania klienta przekaźnika (`notify/relay-sender.ts`) przy
 * stałych wejściach są RÓWNE ciałom z `shared/fixtures/relay/` (`pass.*`, `push.*`), a odpowiedzi z fixture'ów
 * mapują się na oczekiwane `ApnsResult` i wyniki zamówienia przepustki.
 *
 * Fixture'y pisze strona przekaźnika (`relay/test/fixtures.test.ts` porównuje z nimi kod przekaźnika), więc ten plik
 * NIE nadpisuje plików — porównuje. Ładunki banera i kafla biorą się z kodu serwera: baner „czeka na zgodę” formatu 3
 * z `buildContent` + `apnsAlertRequestE2e` (te same wejścia, klucz testowy i nonce co złota ramka
 * `apns-v3/alert.blocking.v3.json`) — kontrakt serwera to polityka `v2`. Kafel z dźwiękiem ze złotej ramki
 * `live-activity.update.chime.json` (jej równość z kodem pilnuje `apns-fixtures-producenci.test.ts`). Ładunki, których
 * serwer nie składa (jawny baner w odrzuceniu `push.payload-rejected.v1.json`, tekst zastępczy z `loc-args`, przepustka
 * ze starym `kid`), idą do opakowania z pliku — sprawdzamy wtedy samo opakowanie. Klient woła atrapę `fetch`: test widzi DOKŁADNIE to, co poszłoby siecią.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ApnsEnvironment } from '@rarog/shared/rest';
import { relayPushRequestSchema } from '@rarog/shared/relay';
import type { ApnsResult } from '../src/notify/apns.ts';
import type { ApnsRequest } from '../src/notify/apns-payload.ts';
import { apnsAlertRequestE2e } from '../src/notify/apns-payload.ts';
import { buildContent } from '../src/notify/content.ts';
import { createPushSealer } from '../src/notify/push-crypto.ts';
import { createRelayClient, relayPassRequest, relayPushRequest } from '../src/notify/relay-sender.ts';
import type { RelayHttpRequest, RelayPassOutcome, RelayPushOutcome } from '../src/notify/relay-sender.ts';
import { foreign } from '@rarog/shared/sentences';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RELAY_DIR = path.join(REPO, 'shared/fixtures/relay');
const APNS_DIR = path.join(REPO, 'shared/fixtures/apns');
const APNS_V3_DIR = path.join(REPO, 'shared/fixtures/apns-v3');
/** Wersja klienta w fixture'ach (`x-rarog-relay-client: rarog-server/0.1.0`). */
const CLIENT_VERSION = '0.1.0';
const ORIGIN = 'https://push.rarog.ai';
const NOW = Date.parse('2026-10-07T10:00:00.000Z');

interface Fixture {
  readonly request: {
    readonly method: string; readonly path: string; readonly headers: Record<string, string>;
    readonly body: Record<string, unknown>;
  };
  readonly response: { readonly status: number; readonly body: unknown };
}

const read = (name: string): Fixture => JSON.parse(readFileSync(path.join(RELAY_DIR, name), 'utf8')) as Fixture;
const manifest = JSON.parse(readFileSync(path.join(RELAY_DIR, 'manifest.json'), 'utf8')) as {
  readonly cases: Readonly<Record<string, { readonly route: string; readonly error?: string; readonly header?: string }>>;
};
/** Nagłówek, który przypadek ma zły z założenia: serwer takiego żądania nie składa. */
const badHeaderOf = (name: string): string | undefined => manifest.cases[name]?.header;
const names = (route: 'pass' | 'push'): string[] =>
  Object.entries(manifest.cases).filter(([, entry]) => entry.route === route).map(([name]) => name).sort()
    .filter((name) => read(name).request.method === 'POST');

/** Złota ramka APNs → żądanie (`headers` + ciało jako łańcuch, w kolejności kluczy z pliku). */
function frameRequest(name: string): ApnsRequest {
  const frame = JSON.parse(readFileSync(path.join(APNS_DIR, name), 'utf8')) as {
    headers: Record<string, string>; payload: unknown;
  };
  return { headers: frame.headers, body: JSON.stringify(frame.payload) };
}

const blockingContent = buildContent({
  cls: 'blocking', kind: 'permission', project: 'willow', label: 'zapis notatek', sessionId: 'demo-willow',
  detail: foreign('Edit'), badge: 2,
});

/** Baner „czeka na zgodę” formatu 3 — klucz testowy i nonce złotej ramki `alert.blocking.v3.json`. */
function blocking(): ApnsRequest {
  const request = apnsAlertRequestE2e(blockingContent, {
    topic: 'ai.rarog.app', nowMs: NOW, key: { pushKey: Buffer.alloc(32, 5).toString('base64url'), kid: 'f849d673' },
    sealer: createPushSealer({ nonce: () => Buffer.alloc(12, 0x11) }),
  });
  if (request === undefined) throw new Error('baner ponad 4096 B');
  return request;
}

/** Żądanie APNs, z którym serwer wysłałby przypadek `push.*`: z kodu, gdy go składa, inaczej z pliku. */
function apnsRequestFor(fixture: Fixture): ApnsRequest {
  const body = fixture.request.body;
  const headers = body['headers'] as Record<string, string>;
  const payload = body['payload'];
  const fromCode = [blocking(), frameRequest('live-activity.update.chime.json')]
    .find((candidate) => candidate.body === payload);
  return fromCode ?? { headers, body: typeof payload === 'string' ? payload : '' };
}

/** Atrapa `fetch` z jedną odpowiedzią fixture'u; zapisuje, co poszło. */
function fakeFetch(fixture: Fixture): { fetch: typeof globalThis.fetch; sent: { url: string; init: RequestInit }[] } {
  const sent: { url: string; init: RequestInit }[] = [];
  return {
    sent,
    fetch: (url, init) => {
      sent.push({ url: String(url), init: init ?? {} });
      return Promise.resolve(new Response(JSON.stringify(fixture.response.body), { status: fixture.response.status }));
    },
  };
}

const wire = (request: RelayHttpRequest): unknown => ({
  method: request.method, path: request.path, headers: request.headers, body: request.body,
});

describe('przekaźnik push: żądania serwera = pliki', () => {
  it('ładunek banera z kodu = ładunek plików `push.*` pod polityką `v2`; jawny baner tylko w odrzuceniu', () => {
    expect(blocking().body).toBe(read('push.ok.json').request.body['payload']);
    expect(blocking().headers).toEqual(read('push.ok.json').request.body['headers']);
    expect(blocking().body).toBe(JSON.stringify(
      (JSON.parse(readFileSync(path.join(APNS_V3_DIR, 'alert.blocking.v3.json'), 'utf8')) as { payload: unknown }).payload,
    ));
    for (const name of ['push.apns-gone.json', 'push.apns-unreachable.json', 'push.environment-unavailable.json',
      'push.pass-invalid.json', 'push.relay-limited.json']) {
      expect(read(name).request.body['payload'], name).toBe(blocking().body);
    }
    expect(frameRequest('live-activity.update.chime.json').body).toBe(read('push.liveactivity.ok.json').request.body['payload']);
  });

  it.each(names('pass'))('%s: `relayPassRequest` z wejść pliku daje jego żądanie', (name) => {
    const fixture = read(name);
    const body = fixture.request.body;
    const request = relayPassRequest({
      token: body['token'] as string, environment: body['environment'] as ApnsEnvironment,
      type: body['type'] as 'alert' | 'liveactivity', topic: body['topic'] as string,
      ...(typeof body['devicePass'] === 'string' ? { devicePass: body['devicePass'] } : {}),
    }, CLIENT_VERSION);
    const header = badHeaderOf(name);
    if (header !== undefined) {
      // Nagłówek zły z założenia (tu: `content-type` prostego POST-a z przeglądarki): żądanie serwera różni się od
      // pliku WYŁĄCZNIE tym nagłówkiem, a wartość serwera jest tą, której przekaźnik wymaga.
      expect(request.headers[header]).not.toBe(fixture.request.headers[header]);
      expect(wire(request)).toEqual({
        ...fixture.request, headers: { ...fixture.request.headers, [header]: request.headers[header] },
      });
      return;
    }
    expect(wire(request)).toEqual(fixture.request);
  });

  it.each(names('push'))('%s: `relayPushRequest` z gotowego żądania APNs daje żądanie pliku', (name) => {
    const fixture = read(name);
    const body = fixture.request.body;
    const request = relayPushRequest({
      pass: body['pass'] as string, token: body['token'] as string, environment: body['environment'] as ApnsEnvironment,
      request: apnsRequestFor(fixture),
    }, CLIENT_VERSION);
    if (manifest.cases[name]?.error === 'bad-request') {
      // Ciało złe z założenia (brak `payload`): serwer takiego nie złoży — jego żądanie przechodzi schemat.
      expect(relayPushRequestSchema.safeParse(request.body).success).toBe(true);
      expect(relayPushRequestSchema.safeParse(fixture.request.body).success).toBe(false);
      return;
    }
    expect(wire(request)).toEqual(fixture.request);
  });
});

const PASS_EXPECTED: Readonly<Record<string, RelayPassOutcome>> = {
  'pass.alert.ok.json': {
    kind: 'issued',
    pass: {
      pass: 'v1.k1.development.alert.c2a0b37a262809b4.1801389600.Tt0O1VzUDynDL0Rq6BpH-GB8GIVqEWL_5JgFOUGTkDk',
      expiresAt: '2027-01-31T10:00:00.000Z',
    },
  },
  'pass.liveactivity.ok.json': {
    kind: 'issued',
    pass: {
      // Format v2 kafla: skrót tokenu urządzenia-rodzica po skrócie kafla; dla serwera napis nieprzezroczysty.
      // Termin = termin przepustki urządzenia z żądania (`expiresAt` niżej), bo jest bliżej niż teraz + 90 dni.
      pass: 'v2.k1.development.liveactivity.be11da276dbba8d6.c2a0b37a262809b4.1800525600.GcPw2X5PVocqL_2k6OHWtguXsKzCqsCPuWKqmObj9ms',
      expiresAt: '2027-01-21T10:00:00.000Z',
    },
  },
  'pass.bad-request.json': { kind: 'failed', status: 400, reason: 'bad-request' },
  'pass.bad-request.content-type.json': { kind: 'failed', status: 400, reason: 'bad-request' },
  'pass.topic-not-allowed.json': { kind: 'failed', status: 400, reason: 'topic-not-allowed' },
  'pass.pass-invalid.json': { kind: 'pass-invalid' },
  'pass.token-rejected.json': { kind: 'token-rejected', apnsStatus: 400, reason: 'BadDeviceToken' },
  'pass.token-rejected.unregistered.json': {
    kind: 'token-rejected', apnsStatus: 410, reason: 'Unregistered', timestamp: 1793600000000,
  },
  'pass.relay-limited.json': { kind: 'failed', status: 429, reason: 'relay-limited' },
  'pass.apns-error.json': { kind: 'failed', status: 502, reason: 'apns-error' },
  'pass.apns-unreachable.json': { kind: 'failed', status: 502, reason: 'apns-unreachable' },
  'pass.environment-unavailable.json': { kind: 'failed', status: 503, reason: 'environment-unavailable' },
};

const renewed = (name: string): { pass: string; expiresAt: string } =>
  (read(name).response.body as { renewedPass: { pass: string; expiresAt: string } }).renewedPass;

const PUSH_EXPECTED: Readonly<Record<string, RelayPushOutcome>> = {
  'push.ok.json': { result: { kind: 'ok' } },
  'push.liveactivity.ok.json': { result: { kind: 'ok' } },
  'push.apns-gone.json': {
    result: { kind: 'gone', status: 410, reason: 'Unregistered', invalidSince: 1793600000000 } satisfies ApnsResult,
  },
  'push.renewed.old-kid.json': { result: { kind: 'ok' }, renewedPass: renewed('push.renewed.old-kid.json') },
  'push.renewed.expiring.json': { result: { kind: 'ok' }, renewedPass: renewed('push.renewed.expiring.json') },
  'push.bad-request.json': { result: { kind: 'failed', status: 400, reason: 'bad-request' } },
  'push.payload-rejected.json': { result: { kind: 'failed', status: 400, reason: 'payload-rejected' } },
  'push.payload-rejected.v1.json': { result: { kind: 'failed', status: 400, reason: 'payload-rejected' } },
  'push.pass-invalid.json': { result: { kind: 'failed', status: null, reason: 'pass-invalid' }, passInvalid: true },
  'push.relay-limited.json': { result: { kind: 'failed', status: 429, reason: 'relay-limited' } },
  'push.apns-unreachable.json': { result: { kind: 'failed', status: 502, reason: 'apns-unreachable' } },
  'push.environment-unavailable.json': { result: { kind: 'failed', status: 503, reason: 'environment-unavailable' } },
};

describe('przekaźnik push: odpowiedzi plików → wyniki serwera', () => {
  it('każdy przypadek `pass.*` i `push.*` ma oczekiwany wynik', () => {
    expect(Object.keys(PASS_EXPECTED).sort()).toEqual(names('pass'));
    expect(Object.keys(PUSH_EXPECTED).sort()).toEqual(names('push'));
  });

  it.each(names('pass'))('%s: `requestPass` → wynik, żądanie siecią = żądanie pliku', async (name) => {
    const fixture = read(name);
    const fake = fakeFetch(fixture);
    const client = createRelayClient({ origin: ORIGIN, fetch: fake.fetch, clientVersion: CLIENT_VERSION, now: () => NOW });
    const body = fixture.request.body;
    const outcome = await client.requestPass({
      token: body['token'] as string, environment: body['environment'] as ApnsEnvironment,
      type: body['type'] as 'alert' | 'liveactivity', topic: body['topic'] as string,
      ...(typeof body['devicePass'] === 'string' ? { devicePass: body['devicePass'] } : {}),
    });
    expect(outcome).toEqual(PASS_EXPECTED[name]);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.url).toBe(`${ORIGIN}${fixture.request.path}`);
    expect(JSON.parse(String(fake.sent[0]?.init.body))).toEqual(fixture.request.body);
    const header = badHeaderOf(name);
    const expectedHeaders = header === undefined ? fixture.request.headers
      : Object.fromEntries(Object.entries(fixture.request.headers).filter(([key]) => key !== header));
    expect(fake.sent[0]?.init.headers).toMatchObject(expectedHeaders);
    // Na drucie zawsze oba nagłówki wymagane przez przekaźnik.
    expect(fake.sent[0]?.init.headers).toMatchObject({
      'content-type': 'application/json', 'x-rarog-relay-client': `rarog-server/${CLIENT_VERSION}`,
    });
  });

  it.each(names('push'))('%s: `push` → wynik (lustro Apple jak dziś, błędy przekaźnika według macierzy)', async (name) => {
    const fixture = read(name);
    const fake = fakeFetch(fixture);
    const client = createRelayClient({ origin: ORIGIN, fetch: fake.fetch, clientVersion: CLIENT_VERSION, now: () => NOW });
    const body = fixture.request.body;
    const outcome = await client.push({
      pass: body['pass'] as string, token: body['token'] as string, environment: body['environment'] as ApnsEnvironment,
      request: apnsRequestFor(fixture),
    });
    expect(outcome).toEqual(PUSH_EXPECTED[name]);
    if (manifest.cases[name]?.error !== 'bad-request') {
      expect(JSON.parse(String(fake.sent[0]?.init.body))).toEqual(fixture.request.body);
    }
  });
});
