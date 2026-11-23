/**
 * Nadajnik APNs (`notify/apns.ts`) przeciw ATRAPIE HTTP/2: `http2.createServer()` (h2c, bez TLS)
 * na loopbacku i klucz EC P-256 generowany w teście — zero sieci, zero prawdziwego klucza.
 *
 * Do udowodnienia: podpis ES256 sprawdzalny kluczem publicznym, `kid`/`iss`/`iat`; odnowienie
 * JWT po 50 min (zegar testowy); nowe połączenie po GOAWAY i po timeoucie; PING po godzinie
 * ciszy; mapa odpowiedzi (410/400 → `gone`, 429, 5xx → pauza 15 min, `403 ExpiredProviderToken`
 * → nowy JWT i JEDNA ponowna próba, trwałe 403 → środowisko wyłączone z jedną linią logu);
 * nagłówki żądania; log bez JWT, tokenu urządzenia i komunikatów błędów.
 *
 * Testy wołają `listen()` — poza sandboksem, jak reszta testów serwera.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { generateKeyPairSync, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import http2 from 'node:http2';
import type { ClientHttp2Session, Http2Server, Http2Session, IncomingHttpHeaders } from 'node:http2';
import type { AddressInfo } from 'node:net';
import {
  APNS_IDLE_PING_MS, APNS_JWT_TTL_MS, APNS_SERVER_ERROR_PAUSE_MS, createApnsSender,
} from '../src/notify/apns.ts';
import type { ApnsSender, ApnsSenderOptions } from '../src/notify/apns.ts';
import { apnsAlertRequestE2e } from '../src/notify/apns-payload.ts';
import type { ApnsRequest } from '../src/notify/apns-payload.ts';
import { buildContent } from '../src/notify/content.ts';
import { createPushSealer } from '../src/notify/push-crypto.ts';
import { foreign } from '@rarog/shared/sentences';

const KEY_ID = 'ABC123DEFG';
const TEAM_ID = '97TDXJ84WH';
const TOKEN = 'a1b2c3d4'.repeat(8);
const START = Date.parse('2026-10-07T10:00:00.000Z');

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });

/** Baner formatu 3 z kluczem TESTOWYM i stałym nonce — nadajnik nie zagląda do ładunku, przesyła go bajt w bajt. */
const REQUEST: ApnsRequest = ((): ApnsRequest => {
  const request = apnsAlertRequestE2e(
    buildContent({ cls: 'blocking', kind: 'permission', project: 'rarog', sessionId: 's1', detail: foreign('Bash') }),
    {
      topic: 'ai.rarog.app', nowMs: START, key: { pushKey: Buffer.alloc(32, 5).toString('base64url'), kid: 'f849d673' },
      sealer: createPushSealer({ nonce: () => Buffer.alloc(12, 1) }),
    },
  );
  if (request === undefined) throw new Error('baner ponad 4096 B');
  return request;
})();

interface Seen {
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

type Reply = { readonly status: number; readonly reason?: string; readonly timestamp?: number } | 'hang';

interface Stub {
  readonly origin: string;
  readonly seen: Seen[];
  readonly sessions: Http2Session[];
  pings: number;
  /** Odpowiedź na KOLEJNE żądanie (indeks od 0). */
  reply: (index: number, seen: Seen) => Reply;
  /** Po odpowiedzi na to żądanie serwer wysyła GOAWAY na tym połączeniu. */
  goawayAfter?: number;
  close(): Promise<void>;
}

const stubs: Stub[] = [];
const senders: ApnsSender[] = [];

afterEach(async () => {
  for (const sender of senders.splice(0)) sender.close();
  await Promise.all(stubs.splice(0).map((stub) => stub.close()));
});

async function startStub(reply: Stub['reply'] = () => ({ status: 200 })): Promise<Stub> {
  const server: Http2Server = http2.createServer();
  const stub: Stub = {
    origin: '',
    seen: [],
    sessions: [],
    pings: 0,
    reply,
    close: () => new Promise<void>((resolve) => {
      for (const session of stub.sessions) session.destroy();
      server.close(() => { resolve(); });
    }),
  };
  server.on('session', (session) => {
    stub.sessions.push(session);
    session.on('ping', () => { stub.pings += 1; });
  });
  server.on('stream', (stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    stream.on('end', () => {
      const index = stub.seen.length;
      const seen: Seen = { headers, body: Buffer.concat(chunks).toString('utf8') };
      stub.seen.push(seen);
      const answer = stub.reply(index, seen);
      if (answer === 'hang') return;
      stream.respond({ ':status': answer.status });
      stream.end(answer.reason === undefined
        ? undefined
        : JSON.stringify({ reason: answer.reason, ...(answer.timestamp === undefined ? {} : { timestamp: answer.timestamp }) }));
      if (stub.goawayAfter === index) stream.session?.goaway();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  (stub as { origin: string }).origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  stubs.push(stub);
  return stub;
}

interface Built {
  readonly sender: ApnsSender;
  readonly logs: string[];
  readonly clock: { now: number };
}

function build(stub: Stub, extra: Partial<ApnsSenderOptions> = {}): Built {
  const logs: string[] = [];
  const clock = { now: START };
  const sender = createApnsSender({
    privateKey, keyId: KEY_ID, teamId: TEAM_ID,
    origins: { development: stub.origin, production: stub.origin },
    now: () => clock.now,
    log: (line) => { logs.push(line); },
    ...extra,
  });
  senders.push(sender);
  return { sender, logs, clock };
}

/** JWT z nagłówka `authorization: bearer …` — rozebrany i sprawdzony kluczem publicznym. */
function decodeJwt(headers: IncomingHttpHeaders, key: KeyObject = publicKey): {
  header: Record<string, unknown>; claims: Record<string, unknown>; valid: boolean; raw: string;
} {
  const raw = String(headers['authorization'] ?? '').replace(/^bearer /, '');
  const [h = '', c = '', s = ''] = raw.split('.');
  const valid = verify(
    'sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'),
  );
  const json = (part: string): Record<string, unknown> =>
    JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
  return { header: json(h), claims: json(c), valid, raw };
}

describe('żądanie i token dostawcy', () => {
  it('200 → `ok`; JWT ES256 z `kid`, `iss` i `iat` przechodzi weryfikację kluczem publicznym', async () => {
    const stub = await startStub();
    const { sender } = build(stub);
    expect(await sender.send('development', TOKEN, REQUEST)).toEqual({ kind: 'ok' });
    const jwt = decodeJwt(stub.seen[0]?.headers ?? {});
    expect(jwt.valid).toBe(true);
    expect(jwt.header).toEqual({ alg: 'ES256', kid: KEY_ID });
    expect(jwt.claims).toEqual({ iss: TEAM_ID, iat: START / 1000 });
    // Obcy klucz podpisu nie przechodzi — weryfikacja nie jest na niby.
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey;
    expect(decodeJwt(stub.seen[0]?.headers ?? {}, other).valid).toBe(false);
  });

  it('POST na `/3/device/<token>` z nagłówkami APNs i ciałem ładunku', async () => {
    const stub = await startStub();
    const { sender } = build(stub);
    await sender.send('development', TOKEN, REQUEST);
    const seen = stub.seen[0];
    expect(seen?.headers[':method']).toBe('POST');
    expect(seen?.headers[':path']).toBe(`/3/device/${TOKEN}`);
    expect(seen?.headers).toMatchObject({
      'apns-push-type': 'alert', 'apns-topic': 'ai.rarog.app', 'apns-priority': '10',
      'apns-expiration': String(START / 1000 + 600), 'content-type': 'application/json',
    });
    expect(seen?.body).toBe(REQUEST.body);
  });

  it('JWT jest trzymany w pamięci i odnawiany dopiero po 50 min', async () => {
    const stub = await startStub();
    const { sender, clock } = build(stub);
    await sender.send('development', TOKEN, REQUEST);
    clock.now += APNS_JWT_TTL_MS - 1;
    await sender.send('development', TOKEN, REQUEST);
    clock.now += 1;
    await sender.send('development', TOKEN, REQUEST);
    const jwts = stub.seen.map((s) => decodeJwt(s.headers));
    expect(jwts[0]?.raw).toBe(jwts[1]?.raw);
    expect(jwts[2]?.raw).not.toBe(jwts[1]?.raw);
    expect(jwts[2]?.claims['iat']).toBe((START + APNS_JWT_TTL_MS) / 1000);
    expect(jwts.every((j) => j.valid)).toBe(true);
  });

  it('`403 ExpiredProviderToken` → nowy JWT i JEDNA ponowna próba, która przechodzi', async () => {
    const stub = await startStub((i) => (i === 0 ? { status: 403, reason: 'ExpiredProviderToken' } : { status: 200 }));
    const { sender, clock } = build(stub);
    // Zegar Maca stał (uśpienie): APNs uznał token za stary, choć nasz zegar mówi, że jest świeży.
    clock.now += 1_000;
    expect(await sender.send('development', TOKEN, REQUEST)).toEqual({ kind: 'ok' });
    expect(stub.seen).toHaveLength(2);
    const [first, second] = stub.seen.map((s) => decodeJwt(s.headers));
    expect(second?.raw).not.toBe(first?.raw);
    expect(sender.disabledSince('development')).toBeNull();
  });

  /*
   * Dwie RÓWNOLEGŁE wysyłki z tym samym starym JWT dostają po 403. Druga
   * odpowiedź nie może skasować tokenu, który pierwsza już odnowiła — każde zbędne odnowienie
   * zbliża do `429 TooManyProviderTokenUpdates`. Obie ponowne próby jadą JEDNYM nowym JWT.
   */
  it('dwa równoległe `ExpiredProviderToken` na tym samym JWT → JEDNO odnowienie, obie próby nim', async () => {
    const stub = await startStub((i) => (i < 2 ? { status: 403, reason: 'ExpiredProviderToken' } : { status: 200 }));
    const { sender } = build(stub);
    const results = await Promise.all([
      sender.send('development', TOKEN, REQUEST), sender.send('development', `${TOKEN}ff`, REQUEST),
    ]);
    expect(results).toEqual([{ kind: 'ok' }, { kind: 'ok' }]);
    const jwts = stub.seen.map((s) => String(s.headers['authorization']));
    expect(jwts).toHaveLength(4);
    // Pierwsze dwie próby: stary token; dwie ponowne: ten sam, jeden nowy.
    expect(new Set(jwts.slice(0, 2)).size).toBe(1);
    expect(new Set(jwts.slice(2)).size).toBe(1);
    expect(jwts[2]).not.toBe(jwts[0]);
  });

  it('drugie `ExpiredProviderToken` z rzędu to porażka, nie pętla', async () => {
    const stub = await startStub(() => ({ status: 403, reason: 'ExpiredProviderToken' }));
    const { sender } = build(stub);
    expect(await sender.send('development', TOKEN, REQUEST))
      .toEqual({ kind: 'failed', status: 403, reason: 'ExpiredProviderToken' });
    expect(stub.seen).toHaveLength(2);
  });
});

describe('odpowiedzi APNs', () => {
  it.each([
    [410, 'Unregistered'], [410, 'ExpiredToken'], [400, 'BadDeviceToken'], [400, 'DeviceTokenNotForTopic'],
  ])('%i %s → token martwy (`gone`)', async (status, reason) => {
    const stub = await startStub(() => ({ status, reason }));
    const { sender } = build(stub);
    expect(await sender.send('development', TOKEN, REQUEST)).toEqual({ kind: 'gone', status, reason });
  });

  it('`410` przenosi `timestamp` APNs (chwila unieważnienia tokenu) — sink porówna go z rejestracją', async () => {
    const stub = await startStub((i) => (i === 0
      ? { status: 410, reason: 'Unregistered', timestamp: 1_791_000_000_000 }
      : { status: 410, reason: 'Unregistered' }));
    const { sender } = build(stub);
    expect(await sender.send('development', TOKEN, REQUEST)).toEqual({
      kind: 'gone', status: 410, reason: 'Unregistered', invalidSince: 1_791_000_000_000,
    });
    expect(await sender.send('development', TOKEN, REQUEST)).toEqual({ kind: 'gone', status: 410, reason: 'Unregistered' });
  });

  it('429 i 413 to porażka tej próby bez ponawiania; kolejna wysyłka idzie normalnie', async () => {
    const stub = await startStub((i) => (i === 0
      ? { status: 429, reason: 'TooManyRequests' }
      : i === 1 ? { status: 413, reason: 'PayloadTooLarge' } : { status: 200 }));
    const { sender, logs } = build(stub);
    expect(await sender.send('development', TOKEN, REQUEST))
      .toEqual({ kind: 'failed', status: 429, reason: 'TooManyRequests' });
    expect(await sender.send('development', TOKEN, REQUEST))
      .toEqual({ kind: 'failed', status: 413, reason: 'PayloadTooLarge' });
    expect(await sender.send('development', TOKEN, REQUEST)).toEqual({ kind: 'ok' });
    expect(stub.seen).toHaveLength(3);
    expect(logs).toContain('push: APNs development failed (429 TooManyRequests)');
    expect(logs).toContain('push: APNs development failed (413 PayloadTooLarge)');
  });

  it('5xx → środowisko wstrzymane na 15 min bez żadnej próby; drugie środowisko działa', async () => {
    const stub = await startStub((i) => (i === 0 ? { status: 503, reason: 'ServiceUnavailable' } : { status: 200 }));
    const { sender, clock, logs } = build(stub);
    expect(await sender.send('development', TOKEN, REQUEST))
      .toEqual({ kind: 'failed', status: 503, reason: 'ServiceUnavailable' });
    clock.now += APNS_SERVER_ERROR_PAUSE_MS - 1;
    expect(await sender.send('development', TOKEN, REQUEST))
      .toEqual({ kind: 'failed', status: null, reason: 'paused' });
    expect(stub.seen).toHaveLength(1);
    expect(await sender.send('production', TOKEN, REQUEST)).toEqual({ kind: 'ok' });
    clock.now += 1;
    expect(await sender.send('development', TOKEN, REQUEST)).toEqual({ kind: 'ok' });
    expect(logs).toContain('push: APNs development paused for 15 min (503 ServiceUnavailable)');
  });

  it.each(['InvalidProviderToken', 'BadEnvironmentKeyIdInToken'])(
    'trwałe `403 %s` wyłącza środowisko do restartu — JEDNA linia logu, potem zero prób',
    async (reason) => {
      const stub = await startStub(() => ({ status: 403, reason }));
      const { sender, logs, clock } = build(stub);
      expect(await sender.send('development', TOKEN, REQUEST)).toEqual({ kind: 'failed', status: 403, reason });
      expect(sender.disabledSince('development')).toBe(new Date(START).toISOString());
      clock.now += 24 * 60 * 60_000;
      expect(await sender.send('development', TOKEN, REQUEST))
        .toEqual({ kind: 'failed', status: null, reason: 'disabled' });
      expect(stub.seen).toHaveLength(1);
      expect(logs.filter((l) => l.includes('disabled'))).toEqual([
        `push: APNs development disabled (${reason}) — until the server restarts`,
      ]);
      // Drugie środowisko to inny host i — przy kluczu na oba — inna odpowiedź.
      expect(sender.disabledSince('production')).toBeNull();
    },
  );

  it('ciało bez poprawnego `reason` daje `nieznany` — do logu nie wchodzi nic spoza wzorca słowa', async () => {
    const stub = await startStub(() => ({ status: 400, reason: 'Zły powód <script>' }));
    const { sender, logs } = build(stub);
    expect(await sender.send('development', TOKEN, REQUEST))
      .toEqual({ kind: 'failed', status: 400, reason: 'unknown' });
    expect(logs.join('\n')).not.toContain('script');
  });
});

describe('połączenie', () => {
  it('kolejne wysyłki idą JEDNYM połączeniem HTTP/2', async () => {
    const stub = await startStub();
    const { sender } = build(stub);
    for (let i = 0; i < 3; i += 1) await sender.send('development', TOKEN, REQUEST);
    expect(stub.sessions).toHaveLength(1);
  });

  it('po GOAWAY następna wysyłka otwiera NOWE połączenie', async () => {
    const stub = await startStub();
    stub.goawayAfter = 0;
    const { sender } = build(stub);
    expect(await sender.send('development', TOKEN, REQUEST)).toEqual({ kind: 'ok' });
    // GOAWAY dochodzi tuż po odpowiedzi — dajemy mu chwilę, jak w życiu między dwoma pushami.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await sender.send('development', TOKEN, REQUEST)).toEqual({ kind: 'ok' });
    expect(stub.sessions).toHaveLength(2);
  });

  it('brak odpowiedzi w terminie → `timeout`, a następna wysyłka idzie NOWYM połączeniem', async () => {
    const stub = await startStub((i) => (i === 0 ? 'hang' : { status: 200 }));
    const { sender, logs } = build(stub, { timeoutMs: 150 });
    expect(await sender.send('development', TOKEN, REQUEST))
      .toEqual({ kind: 'failed', status: null, reason: 'timeout' });
    expect(await sender.send('development', TOKEN, REQUEST)).toEqual({ kind: 'ok' });
    expect(stub.sessions).toHaveLength(2);
    expect(logs).toContain('push: APNs development failed (timeout)');
  });

  it('po godzinie ciszy przed wysyłką idzie PING; żywe połączenie zostaje', async () => {
    const stub = await startStub();
    const { sender, clock } = build(stub);
    await sender.send('development', TOKEN, REQUEST);
    clock.now += APNS_IDLE_PING_MS - 1;
    await sender.send('development', TOKEN, REQUEST);
    expect(stub.pings).toBe(0);
    clock.now += APNS_IDLE_PING_MS;
    await sender.send('development', TOKEN, REQUEST);
    expect(stub.pings).toBe(1);
    expect(stub.sessions).toHaveLength(1);
  });

  /*
   * Wysyłka A czeka na PING połączenia X, w tym czasie X dostaje GOAWAY, a
   * wysyłka B otwiera Y. PING X pada — A ma użyć Y, a nie otworzyć Z i nadpisać nim Y w rejestrze
   * (Y zostałoby otwarte na zawsze, poza `close()`). Atrapa sesji, bo kolejności zdarzeń HTTP/2
   * na prawdziwym gnieździe nie da się wyreżyserować.
   */
  it('GOAWAY w trakcie PING i równoległe nowe połączenie: żadna sesja nie wypada z rejestru', async () => {
    interface FakeSession extends EventEmitter {
      closed: boolean; destroyed: boolean; pingCallback?: (err: Error | null) => void;
    }
    const sessions: FakeSession[] = [];
    const connect = (): ClientHttp2Session => {
      const session = new EventEmitter() as FakeSession;
      const shut = (): void => {
        if (session.destroyed) return;
        session.closed = true;
        session.destroyed = true;
        session.emit('close');
      };
      Object.assign(session, {
        closed: false, destroyed: false,
        unref: () => {}, close: shut, destroy: shut,
        ping: (cb: (err: Error | null) => void) => { session.pingCallback = cb; return true; },
        request: () => {
          const stream = new EventEmitter() as EventEmitter & { end: () => void };
          stream.end = () => {
            setImmediate(() => { stream.emit('response', { ':status': 200 }); stream.emit('close'); });
          };
          return stream;
        },
      });
      sessions.push(session);
      return session as unknown as ClientHttp2Session;
    };
    const clock = { now: START };
    const sender = createApnsSender({
      privateKey, keyId: KEY_ID, teamId: TEAM_ID, connect, now: () => clock.now,
    });
    senders.push(sender);
    expect(await sender.send('development', TOKEN, REQUEST)).toEqual({ kind: 'ok' });
    const x = sessions[0];
    clock.now += APNS_IDLE_PING_MS;
    const sendA = sender.send('development', TOKEN, REQUEST);
    await new Promise((resolve) => setImmediate(resolve));
    expect(x?.pingCallback).toBeDefined();
    x?.emit('goaway');
    expect(await sender.send('development', TOKEN, REQUEST)).toEqual({ kind: 'ok' });
    expect(sessions).toHaveLength(2);
    x?.pingCallback?.(new Error('ping po GOAWAY'));
    expect(await sendA).toEqual({ kind: 'ok' });
    // A użyło połączenia Y — trzeciego nie ma, a `close()` zamyka wszystko, co otwarte.
    expect(sessions).toHaveLength(2);
    sender.close();
    expect(sessions.every((s) => s.closed)).toBe(true);
  });

  it('host nieosiągalny → porażka z KODEM błędu, nigdy wyjątek', async () => {
    const stub = await startStub();
    const origin = stub.origin;
    await stub.close();
    stubs.splice(stubs.indexOf(stub), 1);
    const logs: string[] = [];
    const sender = createApnsSender({
      privateKey, keyId: KEY_ID, teamId: TEAM_ID, origins: { development: origin },
      log: (line) => { logs.push(line); },
    });
    senders.push(sender);
    const result = await sender.send('development', TOKEN, REQUEST);
    expect(result.kind).toBe('failed');
    expect(logs.join('\n')).toMatch(/push: APNs development /);
  });
});

describe('logi', () => {
  /*
   * `redact()` routera ma STATYCZNĄ listę sekretów, a JWT zmienia się co 50 min — więc obroną
   * jest to, czego moduł nie pisze: kod i powód, nigdy `String(err)`. Atrapa połączenia rzuca
   * błąd, którego komunikat niesie cały nagłówek `authorization` i token urządzenia.
   */
  it('błąd z JWT i tokenem w komunikacie nie wypisuje ani jednego, ani drugiego', async () => {
    let jwt = '';
    const connect = (): ClientHttp2Session => {
      const session = new EventEmitter() as unknown as ClientHttp2Session & { request: unknown };
      Object.assign(session, {
        closed: false, destroyed: false,
        unref: () => {}, close: () => {}, destroy: () => {},
        request: (headers: Record<string, string>) => {
          jwt = headers['authorization'] ?? '';
          const stream = new EventEmitter() as EventEmitter & { end: (body: string) => void };
          stream.end = () => {
            const err = Object.assign(
              new Error(`request failed: authorization: ${jwt} :path /3/device/${TOKEN}`),
              { code: undefined },
            );
            setImmediate(() => { stream.emit('error', err); stream.emit('close'); });
          };
          return stream;
        },
      });
      return session;
    };
    const logs: string[] = [];
    const sender = createApnsSender({
      privateKey, keyId: KEY_ID, teamId: TEAM_ID, connect, log: (line) => { logs.push(line); },
    });
    senders.push(sender);
    expect(await sender.send('development', TOKEN, REQUEST))
      .toEqual({ kind: 'failed', status: null, reason: 'no-code' });
    const all = logs.join('\n');
    expect(jwt).toMatch(/^bearer ey/);
    expect(all).not.toContain(jwt.replace(/^bearer /, ''));
    expect(all).not.toContain(TOKEN);
    expect(all).not.toContain('request failed');
    expect(logs).toEqual(['push: APNs development failed (no-code)']);
  });

  it('żadna linia nigdy nie niesie tokenu urządzenia', async () => {
    const stub = await startStub((i) => (i === 0 ? { status: 429, reason: 'TooManyRequests' } : { status: 503 }));
    const { sender, logs } = build(stub);
    await sender.send('development', TOKEN, REQUEST);
    await sender.send('development', TOKEN, REQUEST);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join('\n')).not.toContain(TOKEN);
  });
});
