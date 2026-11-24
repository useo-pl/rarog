/**
 * Rdzeń Workera (`src/core.ts`) nad rejestrem w procesie (prawdziwe maszyny na atrapie magazynu): przypadki
 * `shared/fixtures/relay-auth/manifest.json` co do bajtu (podpisy manifestu przechodzą weryfikację Workera, odpowiedzi
 * równe przypadkom), kolejność kontroli, poręczenia przy awarii i równolegle, hak `/v1/access` w kształcie żądania
 * adaptera na VPS, tryb cienia i diagnozy, biała lista logu.
 */
import { describe, expect, it, vi } from 'vitest';
import { RELAY_AUTH_PATHS } from '../../shared/src/relay-auth.ts';
import type { RelayAuthAppRoute, RelayAuthRoute } from '../../shared/src/relay-auth.ts';
import { BODY_MAX_BYTES, CLIENT_HEADER_MAX_CHARS, gateBucket } from '../src/core.ts';
import { ENTRY_TTL_SECONDS, SERVER_SPONSORS_MAX } from '../src/registry.ts';
import { renewEntries } from '../../scripts/relay-canary.mjs';
import { clientBucket } from '../src/wspolne.ts';
import {
  ADMIN_BEARER, APP, DAY, HOOK_BEARER, ORIGIN, SERVER_A, SERVER_B, T0, appKey, deviceCheckProof, harness,
  hookRequest, json, manifest, request,
} from './helpers.ts';
import type { Harness } from './helpers.ts';

type ResponseName = keyof typeof manifest.responses;
type RequestName = keyof typeof manifest.requests;

const server = (n: number): string => n.toString(16).padStart(2, '0').repeat(32);

async function expectFixture(response: Response, name: ResponseName): Promise<void> {
  const fixture = manifest.responses[name];
  expect(response.status, name).toBe(fixture.status);
  expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await json(response), name).toEqual(fixture.body);
}

/** Żądanie z manifestu, z jego ciałem i podpisem bez zmian. */
function fromManifest(name: RequestName): Request {
  const entry = manifest.requests[name];
  return request(entry.route as RelayAuthRoute, entry.body);
}

function adminRequest(route: 'deny' | 'allow', endpointId: string, bearer = ADMIN_BEARER): Request {
  return request(route, { v: 1, endpointId }, { ...manifest.headers.admin, authorization: `Bearer ${bearer}` });
}

/** Żądanie haka z przypadku manifestu: metoda, ścieżka i nagłówki dokładnie jak w pliku. */
function accessFromManifest(name: keyof typeof manifest.access): Request {
  const { request: entry } = manifest.access[name];
  return new Request(`${ORIGIN}${entry.path}`, { method: entry.method, headers: entry.headers });
}

async function expectAccess(response: Response, status: number, body: string): Promise<void> {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
  expect(await response.text()).toBe(body);
}

/** Apka z manifestu zarejestrowana i z poręczeniem serwera A. */
async function registeredWithSponsor(h: Harness): Promise<void> {
  await expectFixture(await h.call(fromManifest('register.devicecheck')), 'register.ok');
  await expectFixture(await h.call(fromManifest('sponsor')), 'sponsor.ok');
}

/** A second app (key 8) registered and sponsoring server A next to the manifest's app. */
async function otherAppSponsors(h: Harness): Promise<void> {
  const other = await appKey(8);
  expect((await h.call(request('register', await other.sign('register', { issuedAt: T0, proof: deviceCheckProof('Z') }))))
    .status).toBe(200);
  expect((await h.call(request('sponsor', await other.sign('sponsor', { issuedAt: T0, server: SERVER_A })))).status)
    .toBe(200);
}

const lastRequestLine = (h: Harness): Record<string, unknown> | undefined =>
  h.logged().filter((line) => line['event'] === 'request').at(-1);

describe('manifest: przebieg apki co do bajtu', () => {
  it('register → sponsor → hak wpuszcza serwer → renew → hak odmawia obcemu → forget', async () => {
    const h = await harness();
    await expectFixture(await h.call(fromManifest('register.devicecheck')), 'register.ok');
    expect(h.apple.calls).toEqual([
      { call: 'query', environment: 'production', token: manifest.requests['register.devicecheck'].body.proof.token },
      { call: 'update', environment: 'production', token: manifest.requests['register.devicecheck'].body.proof.token },
    ]);
    // Nieznane pole odpada przed podpisem; powtórna rejestracja żywego wpisu nie woła Apple.
    await expectFixture(await h.call(fromManifest('register.unknown-field')), 'register.ok');
    expect(h.apple.calls).toHaveLength(2);

    await expectFixture(await h.call(fromManifest('sponsor')), 'sponsor.ok');
    const allow = manifest.access.allow.response;
    await expectAccess(await h.call(accessFromManifest('allow')), allow.status, allow.body);

    await expectFixture(await h.call(fromManifest('renew.servers')), 'renew.ok');
    const empty = await h.call(fromManifest('renew.empty'));
    expect(await json(empty)).toEqual({ v: 1, expiresAt: T0 + ENTRY_TTL_SECONDS, unsponsored: [] });

    const deny = manifest.access.deny.response;
    await expectAccess(await h.call(accessFromManifest('deny')), deny.status, deny.body);

    await expectFixture(await h.call(fromManifest('forget')), 'forget.ok');
    await expectAccess(await h.call(accessFromManifest('allow')), 403, 'false');
    await expectFixture(await h.call(fromManifest('renew.servers')), 'renew.not-registered');
    expect(h.registry.entry(APP)).toBeUndefined();
    expect(h.registry.entry(SERVER_A)).toBeUndefined();
  });

  it('klucz testowy manifestu: ziarno 0x07 daje endpointId z pliku (pomocnik podpisu = podpis manifestu)', async () => {
    const key = await appKey(7);
    expect(key.endpointId).toBe(manifest.key.endpointId);
    const signed = await key.sign('forget', { issuedAt: T0 });
    expect(signed['sig']).toBe(manifest.requests.forget.body.sig);
  });

  it('każde złe żądanie manifestu: 400 `bad-request`, w logu pole odrzucenia', async () => {
    const h = await harness();
    const broken = Object.entries(manifest.requests).filter(([, entry]) => 'error' in entry);
    expect(broken.length).toBeGreaterThan(30);
    for (const [name, entry] of broken) {
      await expectFixture(await h.call(fromManifest(name as RequestName)), 'register.bad-request');
      // Każde ciało manifestu mieści się w sufcie, więc odpada w parserze kontraktu, z polem.
      expect(new TextEncoder().encode(JSON.stringify(entry.body)).byteLength).toBeLessThanOrEqual(BODY_MAX_BYTES);
      expect(lastRequestLine(h), name).toMatchObject({ status: 400, code: 'bad-request', field: (entry as { field: string }).field });
    }
  });

  it('GET /v1/health = przypadek `health.devicecheck`; bez bramki = `health.skeleton`', async () => {
    await expectFixture(await (await harness()).call(request('health')), 'health.devicecheck');
    await expectFixture(await (await harness({ GATE_KIND: '', ENFORCE: '0' })).call(request('health')),
      'health.skeleton');
  });

  it('404, 405 z nagłówkiem allow', async () => {
    const h = await harness();
    await expectFixture(await h.call(new Request(`${ORIGIN}/v1/app`, { method: 'POST' })), 'unknown.not-found');
    const wrong = await h.call(new Request(`${ORIGIN}/v1/health`, { method: 'POST' }));
    expect(wrong.headers.get('allow')).toBe('GET');
    await expectFixture(wrong, 'health.method-not-allowed');
    const get = await h.call(new Request(`${ORIGIN}${RELAY_AUTH_PATHS.access}`));
    expect(get.headers.get('allow')).toBe('POST');
  });
});

describe('błędy tras apki (przypadki manifestu)', () => {
  it('gate-mismatch: dowód innego rodzaju niż bramka Workera, odpowiedź nazywa bramkę', async () => {
    const h = await harness({ GATE_KIND: 'apns' });
    await expectFixture(await h.call(fromManifest('register.devicecheck')), 'register.gate-mismatch');
    expect(h.apple.calls).toEqual([]);
  });

  it('bad-signature: jeden bajt podpisu albo pola zmieniony', async () => {
    const h = await harness();
    const body = manifest.requests['register.devicecheck'].body;
    const flipped = `${body.sig.slice(0, -1)}${body.sig.endsWith('0') ? '1' : '0'}`;
    await expectFixture(await h.call(request('register', { ...body, sig: flipped })), 'register.bad-signature');
    await expectFixture(await h.call(request('register', { ...body, issuedAt: T0 + 1 })), 'register.bad-signature');
    const other = { ...body, proof: { ...body.proof, environment: 'development' } };
    await expectFixture(await h.call(request('register', other)), 'register.bad-signature');
    expect(h.apple.calls).toEqual([]);
  });

  it('clock-skew: issuedAt dalej niż 300 s od zegara Workera (w obie strony)', async () => {
    await expectFixture(await (await harness({}, T0 + 301)).call(fromManifest('renew.servers')), 'renew.clock-skew');
    await expectFixture(await (await harness({}, T0 - 301)).call(fromManifest('renew.servers')), 'renew.clock-skew');
    await expectFixture(await (await harness({}, T0 + 300)).call(fromManifest('renew.servers')), 'renew.not-registered');
  });

  it('denied: odmowa administratora blokuje register i trwa dłużej niż TTL wpisu', async () => {
    const h = await harness();
    await expectFixture(await h.call(fromManifest('register.devicecheck')), 'register.ok');
    await h.call(adminRequest('deny', APP));
    await expectFixture(await h.call(fromManifest('register.devicecheck')), 'register.denied');
    await expectFixture(await h.call(fromManifest('renew.servers')), 'register.denied');
    h.clock.advance(ENTRY_TTL_SECONDS + DAY);
    await h.registry.fireAlarms();
    expect(h.registry.entry(APP)).toBeUndefined();
    const key = await appKey(7);
    const late = await key.sign('register', { issuedAt: h.clock.sec, proof: deviceCheckProof('Q') });
    await expectFixture(await h.call(request('register', late)), 'register.denied');
    await expectAccess(await h.call(hookRequest(APP)), 403, 'false');
  });

  it('sponsor serwera z odmową = 403; apka z odmową nie poręcza', async () => {
    const h = await harness();
    await expectFixture(await h.call(fromManifest('register.devicecheck')), 'register.ok');
    await h.call(adminRequest('deny', SERVER_A));
    await expectFixture(await h.call(fromManifest('sponsor')), 'register.denied');
    expect(h.registry.entry(SERVER_A)).toBeUndefined();
  });

  it('an admin denial of an app drops the servers it sponsored, so the hook stops admitting them', async () => {
    const h = await harness();
    await registeredWithSponsor(h);
    await expectAccess(await h.call(hookRequest(SERVER_A)), 200, 'true');
    expect((await h.call(adminRequest('deny', APP))).status).toBe(200);
    expect(h.registry.entry(APP)).toBeUndefined();
    expect(h.registry.entry(SERVER_A)).toBeUndefined();
    await expectAccess(await h.call(hookRequest(SERVER_A)), 403, 'false');
  });

  it('the hook denies a server whose every sponsor is denied, even when its sponsorship outlived the drop', async () => {
    const h = await harness();
    await registeredWithSponsor(h);
    // The denial stored without the route's drop: what a register or sponsor racing the denial leaves behind.
    await h.registry.admin().deny(APP);
    expect(h.registry.entry(SERVER_A)).toBeDefined();
    await expectAccess(await h.call(hookRequest(SERVER_A)), 403, 'false');
    await h.registry.admin().allow(APP);
    await expectAccess(await h.call(hookRequest(SERVER_A)), 200, 'true');
  });

  it('a failed drop during an admin denial: 500, the denial holds, a repeated deny finishes the drop', async () => {
    const h = await harness();
    await registeredWithSponsor(h);
    // With a second sponsor the drop rewrites the server entry instead of deleting it, so a failed write hits it.
    await otherAppSponsors(h);
    const serverStore = h.registry.storeOf(SERVER_A);
    serverStore.failPut = () => true;
    await expectFixture(await h.call(adminRequest('deny', APP)), 'register.internal');
    expect(h.registry.mirror.has(APP)).toBe(true);
    expect(h.registry.entry(SERVER_A)).toMatchObject({ sponsors: [{ app: APP }, {}] });
    serverStore.failPut = undefined;
    expect((await h.call(adminRequest('deny', APP))).status).toBe(200);
    expect(h.registry.entry(SERVER_A)).toMatchObject({ sponsors: [{ app: expect.not.stringMatching(APP) }] });
  });

  it('a server sponsored by a denied app and a live one stays admitted', async () => {
    const h = await harness();
    await registeredWithSponsor(h);
    await otherAppSponsors(h);
    expect((await h.call(adminRequest('deny', APP))).status).toBe(200);
    await expectAccess(await h.call(hookRequest(SERVER_A)), 200, 'true');
  });

  it('an admin denial of a server answers 200 and leaves the server entry to the denial', async () => {
    const h = await harness();
    await registeredWithSponsor(h);
    expect((await h.call(adminRequest('deny', SERVER_A))).status).toBe(200);
    expect(h.registry.entry(SERVER_A)).toBeDefined();
    await expectAccess(await h.call(hookRequest(SERVER_A)), 403, 'false');
  });

  it('kind-conflict: poręczenie za EndpointId, który jest apką; jednostka kwoty wraca', async () => {
    const h = await harness();
    await expectFixture(await h.call(fromManifest('register.devicecheck')), 'register.ok');
    const other = await appKey(8);
    const otherRegister = await other.sign('register', { issuedAt: T0, proof: deviceCheckProof('Z') });
    expect((await h.call(request('register', otherRegister))).status).toBe(200);
    const app = await appKey(7);
    await expectFixture(await h.call(request('sponsor', await app.sign('sponsor', { issuedAt: T0, server: other.endpointId }))),
      'sponsor.kind-conflict');
    expect(h.registry.entry(APP)).toMatchObject({ reservations: [], starts: [] });
  });

  it('proof-rejected i gate-unreachable: odpowiedź Apple w logu (status, bez tokenu)', async () => {
    const h = await harness();
    h.apple.failNext.set('query', { kind: 'rejected', status: 400 });
    await expectFixture(await h.call(fromManifest('register.devicecheck')), 'register.proof-rejected');
    expect(lastRequestLine(h)).toMatchObject({ gate: 'devicecheck', apple_status: 400, code: 'proof-rejected' });
    h.apple.failNext.set('query', { kind: 'unreachable', cause: 'timeout' });
    await expectFixture(await h.call(fromManifest('register.devicecheck')), 'register.gate-unreachable');
    expect(lastRequestLine(h)).toMatchObject({ cause: 'timeout' });
    h.apple.failNext.set('update', { kind: 'refused', status: 403, reason: 'InvalidProviderToken' });
    await expectFixture(await h.call(fromManifest('register.devicecheck')), 'register.unavailable');
    expect(lastRequestLine(h)).toMatchObject({ apple_status: 403, reason: 'InvalidProviderToken' });
  });

  it('quota-exceeded: czwarty nowy serwer w 30 dniach', async () => {
    const h = await harness();
    await expectFixture(await h.call(fromManifest('register.devicecheck')), 'register.ok');
    const app = await appKey(7);
    for (const n of [1, 2, 3]) {
      expect((await h.call(request('sponsor', await app.sign('sponsor', { issuedAt: T0, server: server(n) })))).status)
        .toBe(200);
    }
    await expectFixture(await h.call(request('sponsor', await app.sign('sponsor', { issuedAt: T0, server: server(4) }))),
      'sponsor.quota-exceeded');
    // Poręczenie już żywe nie kosztuje kwoty.
    expect((await h.call(request('sponsor', await app.sign('sponsor', { issuedAt: T0, server: server(2) })))).status)
      .toBe(200);
  });

  it('unavailable: bez bramki albo z wadą konfiguracji; internal: wyjątek Durable Object bez treści w logu', async () => {
    await expectFixture(await (await harness({ GATE_KIND: '' })).call(fromManifest('register.devicecheck')),
      'register.unavailable');
    await expectFixture(await (await harness({ DEVICECHECK_KEY: 'nie-pem' })).call(fromManifest('register.devicecheck')),
      'register.unavailable');
    const broken = await harness({ SPONSOR_QUOTA: 'trzy' });
    await expectFixture(await broken.call(fromManifest('renew.servers')), 'register.unavailable');
    expect((await broken.call(request('health')))).toBeDefined();

    const h = await harness();
    vi.spyOn(h.registry.desk, 'register').mockRejectedValue(new Error(`wyciek ${HOOK_BEARER}`));
    await expectFixture(await h.call(fromManifest('register.devicecheck')), 'register.internal');
    expect(h.lines.join('\n')).not.toContain('wyciek');
  });
});

describe('kolejność kontroli i limity per adres', () => {
  it('bez Content-Type JSON albo nagłówka klienta: 400 przed ciałem i przed licznikiem', async () => {
    const h = await harness();
    const body = manifest.requests['register.devicecheck'].body;
    const variants: Readonly<Record<string, string>>[] = [
      { 'content-type': 'text/plain', 'x-rarog-relay-client': 'rarog-app/0.1.0' },
      { 'content-type': 'application/json' },
      { 'content-type': 'application/json', 'x-rarog-relay-client': 'x'.repeat(CLIENT_HEADER_MAX_CHARS + 1) },
    ];
    for (const headers of variants) {
      await expectFixture(await h.call(request('register', body, headers)), 'register.bad-request');
    }
    expect(h.limits.keys).toEqual([]);
    const ok = await h.call(request('register', body, {
      'content-type': 'Application/JSON; charset=utf-8', 'x-rarog-relay-client': 'x'.repeat(CLIENT_HEADER_MAX_CHARS),
    }));
    expect(ok.status).toBe(200);
  });

  it('ciało ponad 16 KiB (deklarowane albo faktyczne) i zły UTF-8: 400 przed licznikiem', async () => {
    const h = await harness();
    const big = JSON.stringify({ ...manifest.requests['register.devicecheck'].body, pad: 'x'.repeat(BODY_MAX_BYTES) });
    await expectFixture(await h.call(request('register', big)), 'register.bad-request');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(big));
        controller.close();
      },
    });
    const lying = new Request(`${ORIGIN}${RELAY_AUTH_PATHS.register}`, {
      method: 'POST', headers: manifest.headers.app, body: stream, duplex: 'half',
    } as RequestInit);
    await expectFixture(await h.call(lying), 'register.bad-request');
    const badUtf8 = new Request(`${ORIGIN}${RELAY_AUTH_PATHS.register}`, {
      method: 'POST', headers: manifest.headers.app, body: new Uint8Array([0x7b, 0xff, 0x7d]),
    });
    await expectFixture(await h.call(badUtf8), 'register.bad-request');
    expect(h.limits.keys).toEqual([]);
  });

  it('limited: RL_APP na każdej trasie apki, RL_REGISTER na register; klucz = kubełek adresu (IPv6 po /64)', async () => {
    const h = await harness();
    h.limits.registerMax = 1;
    expect((await h.call(fromManifest('register.devicecheck'), '2001:db8:1:2::5')).status).toBe(200);
    await expectFixture(await h.call(fromManifest('register.devicecheck'), '2001:db8:1:2:ffff::9'), 'register.limited');
    expect(h.limits.keys.map((item) => item.key)).toEqual(Array(4).fill(clientBucket('2001:db8:1:2::1')));
    expect((await h.call(fromManifest('register.devicecheck'), '198.51.100.8')).status).toBe(200);

    const app = await harness();
    app.limits.appMax = 0;
    await expectFixture(await app.call(fromManifest('renew.servers')), 'register.limited');
    expect(app.limits.keys).toEqual([{ limiter: 'app', key: '198.51.100.7' }]);
  });

  it('licznik nie odpowiada: register odmawia (429), pozostałe trasy przepuszcza; linia limit-error', async () => {
    const h = await harness();
    h.limits.throwOn = 'register';
    await expectFixture(await h.call(fromManifest('register.devicecheck')), 'register.limited');
    h.limits.throwOn = 'app';
    await expectFixture(await h.call(fromManifest('renew.servers')), 'renew.not-registered');
    expect(h.logged().filter((line) => line['event'] === 'limit-error')).toEqual([
      { event: 'limit-error', route: 'register' }, { event: 'limit-error', route: 'renew' },
    ]);
  });
});

describe('register: one request in flight per client bucket at the gate', () => {
  const registerBody = async (seed: number, letter: string): Promise<Request> =>
    request('register', await (await appKey(seed)).sign('register', { issuedAt: T0, proof: deviceCheckProof(letter) }));
  /** The response, or `null` when it has not come shortly (the gate queue holds the request). */
  const answeredSoon = (response: Promise<Response>): Promise<Response | null> =>
    Promise.race([response, new Promise<null>((resolve) => { setTimeout(() => { resolve(null); }, 1000); })]);

  it('two /64s of one /48 at once: the second gets 429 limited without Apple; another /48 goes through', async () => {
    const h = await harness();
    const first = await appKey(31);
    const latch = h.registry.pause(first.endpointId, ['extendApp']);
    const held = h.call(await registerBody(31, 'F'), '2001:db8:1:1::1');
    await latch.reached;
    const refused = await answeredSoon(h.call(await registerBody(32, 'G'), '2001:db8:1:2::1'));
    expect(refused).not.toBeNull();
    await expectFixture(refused as Response, 'register.limited');
    expect(h.apple.calls).toEqual([]);
    const other = h.call(await registerBody(33, 'H'), '2001:db8:2:1::1');
    latch.release();
    expect((await held).status).toBe(200);
    expect((await other).status).toBe(200);
    expect(h.apple.count('update')).toBe(2);
  });

  it.each([
    ['198.51.100.7', '198.51.100.7'],
    ['::ffff:198.51.100.7', '198.51.100.7'],
    ['2001:db8:1:2::5', '2001:0db8:0001::/48'],
    ['2001:db8:1:ffff:1::9', '2001:0db8:0001::/48'],
    ['2001:db8:2::1', '2001:0db8:0002::/48'],
    [null, 'unknown'],
    ['not an address', 'unknown'],
  ])('gate bucket of %j = %j', (address, bucket) => {
    expect(gateBucket(address)).toBe(bucket);
  });
});

describe('poręczenia: awaria między zapisami i równoległość', () => {
  it('zapis u serwera pada: 500, powtórka trafia w tę samą rezerwację (jedna jednostka kwoty)', async () => {
    const h = await harness();
    await expectFixture(await h.call(fromManifest('register.devicecheck')), 'register.ok');
    const serverStore = h.registry.storeOf(SERVER_A);
    serverStore.failPut = () => true;
    await expectFixture(await h.call(fromManifest('sponsor')), 'register.internal');
    expect(h.registry.entry(APP)).toMatchObject({ reservations: [{ server: SERVER_A }], starts: [T0] });
    serverStore.failPut = undefined;
    await expectFixture(await h.call(fromManifest('sponsor')), 'sponsor.ok');
    expect(h.registry.entry(APP)).toMatchObject({ sponsored: [{ server: SERVER_A }], reservations: [], starts: [T0] });
  });

  it('dokończenie u apki pada: 500, powtórka kończy bez drugiej jednostki; serwer ma jedno poręczenie', async () => {
    const h = await harness();
    await expectFixture(await h.call(fromManifest('register.devicecheck')), 'register.ok');
    const appStore = h.registry.storeOf(APP);
    let puts = 0;
    // Pierwszy zapis po rejestracji to rezerwacja, drugi to dokończenie: pada drugi.
    appStore.failPut = () => (puts += 1) === 2;
    await expectFixture(await h.call(fromManifest('sponsor')), 'register.internal');
    expect(h.registry.entry(SERVER_A)).toMatchObject({ kind: 'server', sponsors: [{ app: APP }] });
    appStore.failPut = undefined;
    await expectFixture(await h.call(fromManifest('sponsor')), 'sponsor.ok');
    expect(h.registry.entry(APP)).toMatchObject({ starts: [T0] });
    expect(h.registry.entry(SERVER_A)).toMatchObject({ sponsors: [{ app: APP }] });
  });

  it('dwa równoległe poręczenia różnych serwerów przy kwocie 2/3: jedno 200, drugie 429', async () => {
    const h = await harness();
    await expectFixture(await h.call(fromManifest('register.devicecheck')), 'register.ok');
    const app = await appKey(7);
    for (const n of [1, 2]) await h.call(request('sponsor', await app.sign('sponsor', { issuedAt: T0, server: server(n) })));
    const [a, b] = await Promise.all([3, 4].map(async (n) =>
      h.call(request('sponsor', await app.sign('sponsor', { issuedAt: T0, server: server(n) })))));
    expect([a?.status, b?.status].sort()).toEqual([200, 429]);
    const live = [3, 4].filter((n) => h.registry.entry(server(n)) !== undefined);
    expect(live).toHaveLength(1);
  });

  it('renew równolegle z poręczeniem tego samego serwera: oba 200, poręczenie żywe u obu stron', async () => {
    const h = await harness();
    await expectFixture(await h.call(fromManifest('register.devicecheck')), 'register.ok');
    const [renewed, sponsored] = await Promise.all([
      h.call(fromManifest('renew.servers')), h.call(fromManifest('sponsor')),
    ]);
    expect([renewed.status, sponsored.status]).toEqual([200, 200]);
    expect(h.registry.entry(APP)).toMatchObject({ sponsored: [{ server: SERVER_A }] });
    await expectAccess(await h.call(hookRequest(SERVER_A)), 200, 'true');
  });

  it('forget równolegle z poręczeniem: po obu nie zostaje poręczenie bez apki', async () => {
    const h = await harness();
    await expectFixture(await h.call(fromManifest('register.devicecheck')), 'register.ok');
    await Promise.all([h.call(fromManifest('sponsor')), h.call(fromManifest('forget'))]);
    await h.call(fromManifest('forget'));
    expect(h.registry.entry(APP)).toBeUndefined();
    await expectAccess(await h.call(hookRequest(SERVER_A)), 403, 'false');
  });

  it('renew odtwarza poręczenie po stronie serwera, gdy wpis serwera zniknął', async () => {
    const h = await harness();
    await registeredWithSponsor(h);
    h.registry.storeOf(SERVER_A).data.clear();
    await expectAccess(await h.call(hookRequest(SERVER_A)), 403, 'false');
    await expectFixture(await h.call(fromManifest('renew.servers')), 'renew.ok');
    await expectAccess(await h.call(hookRequest(SERVER_A)), 200, 'true');
  });

  it('renew lists in unsponsored a server that refused the sponsorship write', async () => {
    const h = await harness();
    await registeredWithSponsor(h);
    // The server entry is gone and refilled by other apps up to its cap: the renewed sponsorship does not fit.
    h.registry.storeOf(SERVER_A).data.clear();
    const peer = h.registry.endpoint(SERVER_A);
    for (let n = 0; n < SERVER_SPONSORS_MAX; n += 1) {
      expect(await peer.addSponsor(server(0x40 + n), 'e1', 't1', T0 + DAY)).toEqual({ ok: true });
    }
    // The request lists A (sponsored, refused now) and B (never sponsored): both in request order.
    const renewed = await h.call(fromManifest('renew.servers'));
    expect(renewed.status).toBe(200);
    expect(await json(renewed)).toEqual({ v: 1, expiresAt: T0 + ENTRY_TTL_SECONDS, unsponsored: [SERVER_A, SERVER_B] });
  });
});

describe('relay canary (`scripts/relay-canary.mjs`) against the registry', () => {
  it('near the end of 90 days the canary renews both entries; it reports unsponsored only when the sponsorship fell',
    async () => {
    const h = await harness();
    // Key 0 is an app entry, key 1 a server entry that key 0 sponsors.
    const secrets = [Array<number>(32).fill(0x51), Array<number>(32).fill(0x52)];
    const app = await appKey(0x51);
    const serverId = (await appKey(0x52)).endpointId;
    expect((await h.call(request('register', await app.sign('register', { issuedAt: T0, proof: deviceCheckProof('K') }))))
      .status).toBe(200);
    expect((await h.call(request('sponsor', await app.sign('sponsor', { issuedAt: T0, server: serverId })))).status)
      .toBe(200);
    const canary = () => renewEntries(secrets, {
      registry: `${ORIGIN}/`, nowSec: () => h.clock.sec,
      fetch: (url: string | URL, init?: RequestInit) => h.call(new Request(url, init)),
    });

    h.clock.advance(ENTRY_TTL_SECONDS - DAY);
    expect(await canary()).toMatchObject({ ok: true });
    // Past the first 90 days both keys still get in: the canary's renewal reached both entries.
    h.clock.advance(2 * DAY);
    await h.registry.fireAlarms();
    await expectAccess(await h.call(hookRequest(app.endpointId)), 200, 'true');
    await expectAccess(await h.call(hookRequest(serverId)), 200, 'true');
    expect(await canary()).toMatchObject({ ok: true });

    // The server entry is gone and other apps fill it to its cap: the sponsorship by key 0 no longer fits.
    h.registry.storeOf(serverId).data.clear();
    const peer = h.registry.endpoint(serverId);
    for (let n = 0; n < SERVER_SPONSORS_MAX; n += 1) {
      await peer.addSponsor(server(0x60 + n), 'e1', 't1', h.clock.sec + DAY);
    }
    const fell = await canary();
    expect(fell.ok).toBe(false);
    expect(fell.text).toMatch(/key 1 is not sponsored by key 0/);
  });
});

describe('trasy administracyjne', () => {
  it('deny i allow = przypadki manifestu; hak odmawia, potem wpuszcza', async () => {
    const h = await harness();
    await h.call(fromManifest('register.devicecheck'));
    const app = await appKey(7);
    await h.call(request('sponsor', await app.sign('sponsor', { issuedAt: T0, server: SERVER_B })));
    await expectAccess(await h.call(hookRequest(SERVER_B)), 200, 'true');
    await expectFixture(await h.call(request('deny', manifest.admin.deny.body, manifest.headers.admin)), 'deny.ok');
    await expectAccess(await h.call(hookRequest(SERVER_B)), 403, 'false');
    await expectFixture(await h.call(request('allow', manifest.admin.allow.body, manifest.headers.admin)), 'allow.ok');
    await expectAccess(await h.call(hookRequest(SERVER_B)), 200, 'true');
  });

  it('zły albo brak bearera = 401; brak sekretu = 503; złe ciało = 400', async () => {
    const h = await harness();
    await expectFixture(await h.call(adminRequest('deny', SERVER_B, 'TEST-ONLY-wrong-bearer')), 'deny.unauthorized');
    const { authorization: _unused, ...noBearer } = manifest.headers.admin;
    await expectFixture(await h.call(request('deny', manifest.admin.deny.body, noBearer)), 'deny.unauthorized');
    await expectFixture(await h.call(request('deny', { v: 1, endpointId: SERVER_B.toUpperCase() },
      manifest.headers.admin)), 'register.bad-request');
    await expectFixture(await h.call(request('deny', { v: 2, endpointId: SERVER_B }, manifest.headers.admin)),
      'register.bad-request');
    expect(h.registry.mirror.size).toBe(0);
    await expectFixture(await (await harness({ ADMIN_SECRET: '' })).call(adminRequest('deny', SERVER_B)),
      'register.unavailable');
  });

  it('a secret under 32 characters counts as missing: admin and hook answer 503, app routes keep working', async () => {
    const short = 'x'.repeat(31);
    const h = await harness({ ADMIN_SECRET: short, RELAY_HOOK_SECRET: short });
    await expectFixture(await h.call(adminRequest('deny', SERVER_B, short)), 'register.unavailable');
    expect((await h.call(hookRequest(SERVER_B, short))).status).toBe(503);
    await expectFixture(await h.call(fromManifest('register.devicecheck')), 'register.ok');
    const enough = 'x'.repeat(32);
    const ok = await harness({ ADMIN_SECRET: enough });
    expect((await ok.call(adminRequest('deny', SERVER_B, enough))).status).toBe(200);
  });
});

describe('hak POST /v1/access', () => {
  it('żądanie w kształcie adaptera (bez ciała, bez nagłówka klienta) i przypadki manifestu', async () => {
    const h = await harness();
    await registeredWithSponsor(h);
    const counted = h.limits.keys.length;
    await expectAccess(await h.call(hookRequest(SERVER_A)), 200, 'true');
    // Apka też łączy się przez relay: wpis apki wpuszcza.
    await expectAccess(await h.call(hookRequest(APP)), 200, 'true');
    const unauthorized = manifest.access.unauthorized.response;
    const response = await h.call(accessFromManifest('unauthorized'));
    expect(response.status).toBe(unauthorized.status);
    expect(await response.text()).toBe(unauthorized.body);
    // Hak nie przechodzi przez liczniki per adres (adapter woła go z jednego adresu VPS).
    expect(h.limits.keys).toHaveLength(counted);
  });

  it('nie-decyzje: brak bearera 401, zły EndpointId 400, brak sekretu 503', async () => {
    const h = await harness();
    const bare = new Request(`${ORIGIN}${RELAY_AUTH_PATHS.access}`, {
      method: 'POST', headers: { 'x-iroh-endpoint-id': SERVER_A },
    });
    expect((await h.call(bare)).status).toBe(401);
    expect((await h.call(hookRequest(SERVER_A.toUpperCase()))).status).toBe(400);
    expect((await h.call(hookRequest(SERVER_A.slice(2)))).status).toBe(400);
    expect((await (await harness({ RELAY_HOOK_SECRET: '' })).call(hookRequest(SERVER_A))).status).toBe(503);
  });

  it('wpis wygasa po TTL: hak odmawia po terminie także przed alarmem', async () => {
    const h = await harness();
    await registeredWithSponsor(h);
    h.clock.advance(ENTRY_TTL_SECONDS);
    await expectAccess(await h.call(hookRequest(SERVER_A)), 403, 'false');
    await expectAccess(await h.call(hookRequest(APP)), 403, 'false');
  });

  it('tryb cienia: zawsze 200 `true`, w logu decyzja i pełny EndpointId', async () => {
    const h = await harness({ ENFORCE: '0' });
    await expectAccess(await h.call(hookRequest(SERVER_B)), 200, 'true');
    expect(lastRequestLine(h)).toMatchObject({
      route: 'access', status: 200, decision: 'deny', enforce: false, endpoint: SERVER_B,
    });
    h.registry.failStatus = true;
    await expectAccess(await h.call(hookRequest(SERVER_B)), 200, 'true');
    expect(lastRequestLine(h)).toMatchObject({ decision: 'error', enforce: false });
  });

  it('egzekwowanie: EndpointId w logu tylko w oknie DIAG_UNTIL; awaria magazynu = 500 (adapter wpuszcza)', async () => {
    const plain = await harness();
    await plain.call(hookRequest(SERVER_B));
    expect(lastRequestLine(plain)).toMatchObject({ decision: 'deny', enforce: true });
    expect(lastRequestLine(plain)).not.toHaveProperty('endpoint');

    const diag = await harness({ DIAG_UNTIL: String(T0 + 60) });
    await diag.call(hookRequest(SERVER_B));
    expect(lastRequestLine(diag)).toMatchObject({ endpoint: SERVER_B });
    diag.clock.advance(60);
    await diag.call(hookRequest(SERVER_B));
    expect(lastRequestLine(diag)).not.toHaveProperty('endpoint');

    plain.registry.failStatus = true;
    await expectFixture(await plain.call(hookRequest(SERVER_A)), 'register.internal');
    expect(lastRequestLine(plain)).toMatchObject({ decision: 'error', status: 500 });
  });

  it('wada konfiguracji tras apki nie wyłącza haka ani tras administracyjnych', async () => {
    const h = await harness({ GATE_KIND: 'devicecheck', DEVICECHECK_KEY: '' });
    await expectAccess(await h.call(hookRequest(SERVER_A)), 403, 'false');
    await expectFixture(await h.call(adminRequest('deny', SERVER_B)), 'deny.ok');
  });
});

describe('log: biała lista na wszystkich ścieżkach', () => {
  it('jedna linia na żądanie; bez tokenu, podpisu, bearera, adresu, listy serwerów i EndpointId przy egzekwowaniu',
    async () => {
      const h = await harness();
      const token = manifest.requests['register.devicecheck'].body.proof.token;
      const calls: Request[] = [
        fromManifest('register.devicecheck'), fromManifest('sponsor'), fromManifest('renew.servers'),
        fromManifest('register.proof-token-too-long'), adminRequest('deny', SERVER_B),
        adminRequest('allow', SERVER_B, 'TEST-ONLY-wrong-bearer'), hookRequest(SERVER_A), hookRequest(SERVER_B),
        accessFromManifest('unauthorized'), fromManifest('forget'), request('health'),
      ];
      for (const call of calls) await h.call(call, '203.0.113.77');
      h.apple.failNext.set('query', { kind: 'rejected', status: 400 });
      const key = await appKey(9);
      await h.call(request('register', await key.sign('register', { issuedAt: T0, proof: deviceCheckProof('K') })),
        '203.0.113.77');
      expect(h.lines.filter((line) => line.includes('"event":"request"'))).toHaveLength(calls.length + 1);
      const text = h.lines.join('\n');
      const sigs = Object.values(manifest.requests).map((entry) => (entry.body as { sig?: unknown } | null)?.sig)
        .filter((sig): sig is string => typeof sig === 'string');
      for (const secret of [token, deviceCheckProof('K').token, HOOK_BEARER, ADMIN_BEARER, 'TEST-ONLY-wrong-bearer',
        '203.0.113.77', ...sigs]) {
        expect(text, secret).not.toContain(secret);
      }
      expect(text).not.toMatch(/[0-9a-f]{64}/i);
      for (const line of h.logged()) {
        expect(Object.keys(line).every((field) => /^[a-z_]+$/.test(field)), JSON.stringify(line)).toBe(true);
      }
      expect(h.logged().find((line) => line['route'] === 'register')).toMatchObject({
        client: 'rarog-app/0.1.0', status: 200, gate: 'devicecheck', fresh: true,
      });
    });
});

describe('trasy apki w typach kontraktu', () => {
  it.each(['register', 'renew', 'sponsor', 'forget'] as RelayAuthAppRoute[])('%s ma przypadek w manifeście', (route) => {
    expect(Object.values(manifest.requests).some((entry) => entry.route === route)).toBe(true);
  });
});
