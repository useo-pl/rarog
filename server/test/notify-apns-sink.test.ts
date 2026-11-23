/**
 * Sink APNs (`notify/apns-sink.ts`) — nadajnik-atrapa, prawdziwy rejestr w katalogu tymczasowym.
 *
 * Do udowodnienia: banery idą tylko do wpisów z `alerts: true`; `gone` usuwa wpis; porażka PRÓBY
 * liczy się do degradacji tokenu (trzy z rzędu ją zapalają, 200 gasi), porażka bez próby
 * (środowisko wyłączone/wstrzymane, `pass-missing`, `pass-invalid`) — nie; kontekst wysyłki z tematem i przepustką
 * wpisu; trójstan całej wysyłki; push próbny podbija `lastOkAt`,
 * a jego porażka nie rusza licznika; w logu nie ma tokenu ani etykiety; `apns-topic` każdej wysyłki
 * (baner, push próbny, `device-paired`) to temat WPISU.
 *
 * Format (sekcja na końcu): jedyny format banera to 3 (blok `rarog`), tylko przy fladze, deklaracji 3
 * i AKTYWNYM urządzeniu; każdy inny wpis (także z deklaracją samego formatu 2) jest pomijany bez próby, z linią logu,
 * nigdy z jawnym tekstem w zamian; „skończył” to sama plakietka; każdy ładunek ma `aps` dosłownie w kształcie
 * polityki `v2` przekaźnika (strażnik 13b). Wpis z deklaracją `locKeys` dostaje tekst zastępczy kluczami, reszta
 * literałem, także po restarcie magazynu.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDecipheriv, hkdfSync } from 'node:crypto';
import { RELAY_ALERT_PLACEHOLDER } from '@rarog/shared/relay';
import type { ApnsEnvironment } from '@rarog/shared/rest';
import { pushKeyId } from '../src/auth/devices-store.ts';
import type { ApnsResult } from '../src/notify/apns.ts';
import type { ApnsRequest } from '../src/notify/apns-payload.ts';
import { createApnsDeviceStore } from '../src/notify/apns-devices.ts';
import type { ApnsDeviceStore } from '../src/notify/apns-devices.ts';
import { createApnsSink, declaresPushFormat } from '../src/notify/apns-sink.ts';
import type { ActivePushKeys, ApnsSink, ApnsSinkOptions } from '../src/notify/apns-sink.ts';
import { buildContent, buildDevicePairedContent, buildTestContent, topicFor } from '../src/notify/content.ts';
import type { PushContent } from '../src/notify/content.ts';
import { DEGRADED_AFTER_FAILURES } from '../src/notify/index.ts';
import type { PushSealer } from '../src/notify/push-crypto.ts';
import type { PushSender } from '../src/notify/sender.ts';
import { foreign } from '@rarog/shared/sentences';

const token = (n: number): string => n.toString(16).padStart(64, '0');
/** Urządzenie z parowania wpisu `n` (jeden wpis na urządzenie i temat). */
const deviceOf = (n: number): string => n.toString(16).padStart(32, '0');
const RAROG = 'ai.rarog.app';
const NOW = Date.parse('2026-10-07T10:00:00.000Z');
const content = buildContent({
  cls: 'blocking', kind: 'permission', project: 'rarog', sessionId: 's1', detail: foreign('Bash'), label: 'visuals',
});

interface Call {
  readonly environment: ApnsEnvironment;
  readonly token: string;
  readonly request: ApnsRequest;
}

let dataDir = '';
let devices: ApnsDeviceStore;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'rarog-apns-sink-'));
  devices = createApnsDeviceStore({ dataDir, now: () => NOW });
});

afterEach(async () => {
  await devices.flush();
  await rm(dataDir, { recursive: true, force: true });
});

function fakeSender(respond: (token: string) => ApnsResult): { sender: Pick<PushSender, 'send'>; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    sender: {
      send: (environment, t, request) => {
        calls.push({ environment, token: t, request });
        return Promise.resolve(respond(t));
      },
    },
  };
}

/** Klucz push urządzenia: 32 bajty `n`, `kid` z tej samej funkcji co magazyn kluczy. */
function keyOf(n: number): { pushKey: string; kid: string } {
  const pushKey = Buffer.alloc(32, n).toString('base64url');
  return { pushKey, kid: pushKeyId(pushKey) };
}

/** Aktywne urządzenia wpisów `register(1…9)`: urządzenie `deviceOf(n)` z kluczem `keyOf(n)`. */
const ACTIVE_REGISTERED: ActivePushKeys = new Map(
  Array.from({ length: 9 }, (_, i) => [deviceOf(i + 1), keyOf(i + 1)] as const),
);

/** Sink z domyślnymi zależnościami: flaga E2E włączona, aktywne urządzenia wpisów `register`. */
function makeSink(options: Partial<Omit<ApnsSinkOptions, 'sender'>> & { readonly sender: Pick<PushSender, 'send'> }): ApnsSink {
  return createApnsSink({ devices, activeDevices: () => ACTIVE_REGISTERED, e2e: true, ...options });
}

/** Stałe formatu 3 dosłownie — lustro bez kodu produkcyjnego. */
const V3 = { info: 'rarog-push-banner-v1', aadPrefix: 'rarog-push/3|' } as const;

/** Odszyfrowanie bloku `rarog` lustrem `node:crypto` (bez kodu produkcyjnego). */
function decrypt(block: Record<string, unknown>, pushKey: string): Record<string, unknown> {
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(pushKey, 'base64url'), Buffer.alloc(0),
    Buffer.from(V3.info), 32));
  const sealed = Buffer.from(String(block['c']), 'base64url');
  const decipher = createDecipheriv('chacha20-poly1305', key, Buffer.from(String(block['n']), 'base64url'), {
    authTagLength: 16,
  });
  const body = sealed.subarray(0, sealed.length - 16);
  decipher.setAAD(Buffer.from(`${V3.aadPrefix}${String(block['kid'])}`), { plaintextLength: body.length });
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([decipher.update(body), decipher.final()]);
  expect(plain.length % 256).toBe(0);
  return JSON.parse(plain.toString('utf8')) as Record<string, unknown>;
}

/** Ładunek wysyłki do tokenu `n`: `aps` i blok formatu 3 (`rarog`; brak = pusty obiekt). */
const payloadOf = (calls: readonly Call[], n: number): { aps: Record<string, unknown>; block: Record<string, unknown> } => {
  const parsed = JSON.parse(calls.find((c) => c.token === token(n))?.request.body ?? '{}') as
    Record<string, Record<string, unknown> | undefined>;
  return { aps: parsed['aps'] ?? {}, block: parsed['rarog'] ?? {} };
};

const OK: ApnsResult = { kind: 'ok' };
const FAIL: ApnsResult = { kind: 'failed', status: 429, reason: 'TooManyRequests' };

/** Wpis apki z parowania: temat Raroga, urządzenie `deviceOf(n)` (aktywne w `makeSink`), deklaracja formatu 3. */
const register = (n: number, label: string, alerts = true, environment: ApnsEnvironment = 'development'): void => {
  devices.upsert({ token: token(n), environment, label, alerts, deviceId: deviceOf(n), topic: RAROG, pushFormats: [3] });
};

describe('send — baner do apki', () => {
  it('pusty rejestr albo same wpisy bez zgody → `no-receiver` i zero prób', async () => {
    const { sender, calls } = fakeSender(() => OK);
    const sink = makeSink({ sender, now: () => NOW });
    expect(await sink.send(content)).toBe('no-receiver');
    register(1, 'iPad·Rarog', false);
    expect(await sink.send(content)).toBe('no-receiver');
    expect(calls).toHaveLength(0);
  });

  it('idzie do KAŻDEGO wpisu ze zgodą, swoim środowiskiem i tą samą treścią w szyfrogramie', async () => {
    register(1, 'iPad·Rarog');
    register(2, 'iPhone·Rarog', true, 'production');
    register(3, 'iPhone·Rarog', false);
    const { sender, calls } = fakeSender(() => OK);
    const sink = makeSink({ sender, now: () => NOW });
    expect(await sink.send(content)).toBe('delivered');
    expect(calls.map((c) => [c.token, c.environment]).sort()).toEqual([
      [token(1), 'development'], [token(2), 'production'],
    ]);
    expect(calls[0]?.request.headers['apns-topic']).toBe(RAROG);
    for (const n of [1, 2]) expect(decrypt(payloadOf(calls, n).block, keyOf(n).pushKey)['body']).toBe('Bash — visuals');
  });

  it('jedno urządzenie doręczyło, drugie padło → całość `delivered`; wszystkie padły → `failed`', async () => {
    register(1, 'iPad·Rarog');
    register(2, 'iPhone·Rarog');
    let respond = (t: string): ApnsResult => (t === token(1) ? OK : FAIL);
    const { sender } = fakeSender((t) => respond(t));
    const sink = makeSink({ sender });
    expect(await sink.send(content)).toBe('delivered');
    respond = () => FAIL;
    expect(await sink.send(content)).toBe('failed');
  });

  it(`${String(DEGRADED_AFTER_FAILURES)} porażki prób z rzędu zapalają degradację tokenu; 200 ją gasi`, async () => {
    let clock = NOW;
    devices = createApnsDeviceStore({ dataDir, now: () => clock });
    register(1, 'iPad·Rarog');
    let result: ApnsResult = FAIL;
    const { sender } = fakeSender(() => result);
    const sink = makeSink({ sender, now: () => clock });
    for (let i = 1; i < DEGRADED_AFTER_FAILURES; i += 1) await sink.send(content);
    expect(devices.get(token(1))?.degradedSince).toBeNull();
    clock += 5_000;
    expect(await sink.send(content)).toBe('failed');
    expect(devices.get(token(1))).toMatchObject({
      failures: DEGRADED_AFTER_FAILURES, degradedSince: new Date(NOW + 5_000).toISOString(),
    });
    result = OK;
    expect(await sink.send(content)).toBe('delivered');
    expect(devices.get(token(1))).toMatchObject({ failures: 0, degradedSince: null });
  });

  it('200 → `lastOkAt`; porażka próby → licznik tokenu; `gone` → wpis wypada z logiem bez tokenu', async () => {
    register(1, 'iPad·Rarog');
    register(2, 'iPhone·Rarog');
    register(3, 'iPhone·Rarog');
    const logs: string[] = [];
    const { sender } = fakeSender((t) => (t === token(1) ? OK
      : t === token(2) ? FAIL : { kind: 'gone', status: 410, reason: 'Unregistered' }));
    const sink = makeSink({ sender, now: () => NOW, log: (l) => { logs.push(l); } });
    await sink.send(content);
    expect(devices.get(token(1))?.lastOkAt).toBe(new Date(NOW).toISOString());
    expect(devices.get(token(2))?.failures).toBe(1);
    expect(devices.get(token(3))).toBeUndefined();
    expect(logs).toEqual([
      'push: APNs permission — v3: 3',
      'push: APNs token dead (410 Unregistered) — removed, 2 left',
    ]);
    expect(logs.join('\n')).not.toContain(token(3));
    expect(logs.join('\n')).not.toContain('iPhone·Rarog');
  });

  /*
   * Odpowiedź `410` dochodzi PO tym, jak apka zarejestrowała ten sam token od
   * nowa (start apki w trakcie wysyłki). Spóźniona odpowiedź o starym stanie nie ma prawa skasować
   * świeżej rejestracji — inaczej apka milknie do następnego otwarcia.
   */
  it('`gone` po ponownej rejestracji W TRAKCIE wysyłki NIE kasuje świeżego wpisu', async () => {
    let clock = NOW;
    devices = createApnsDeviceStore({ dataDir, now: () => clock });
    register(1, 'iPad·Rarog');
    const sender = {
      send: (): Promise<ApnsResult> => {
        clock += 1_000;
        register(1, 'iPad·Rarog');
        return Promise.resolve({ kind: 'gone', status: 410, reason: 'Unregistered' });
      },
    };
    const logs: string[] = [];
    const sink = makeSink({ sender, log: (l) => { logs.push(l); } });
    await sink.send(content);
    expect(devices.get(token(1))).toBeDefined();
    expect(logs.join('\n')).not.toContain('usunięty');
  });

  it('`410` z chwilą unieważnienia: rejestracja PÓŹNIEJSZA zostaje, wcześniejsza wypada (Apple)', async () => {
    register(1, 'iPad·Rarog');
    register(2, 'iPhone·Rarog');
    const registeredAt = NOW;
    const { sender } = fakeSender((t) => ({
      kind: 'gone', status: 410, reason: 'Unregistered',
      // Token 1 unieważniony PRZED rejestracją (zarejestrowany od nowa później), token 2 — po niej.
      invalidSince: t === token(1) ? registeredAt - 60_000 : registeredAt + 60_000,
    }));
    const sink = makeSink({ sender, now: () => NOW });
    await sink.send(content);
    expect(devices.get(token(1))).toBeDefined();
    expect(devices.get(token(2))).toBeUndefined();
  });

  it('środowisko wyłączone albo wstrzymane: porażka BEZ próby nie rusza licznika tokenu', async () => {
    register(1, 'iPad·Rarog');
    const { sender } = fakeSender(() => ({ kind: 'failed', status: null, reason: 'disabled' }));
    const sink = makeSink({ sender });
    for (let i = 0; i < 4; i += 1) {
      expect(await sink.send(content)).toBe('failed');
    }
    expect(devices.get(token(1))).toMatchObject({ failures: 0, degradedSince: null });
  });

  it.each(['pass-missing', 'pass-invalid'])('`%s`: brak drogi albo odrzucona przepustka — bez próby, licznik stoi', async (reason) => {
    register(1, 'iPad·Rarog');
    const { sender } = fakeSender(() => ({ kind: 'failed', status: null, reason }));
    const sink = makeSink({ sender });
    for (let i = 0; i < 4; i += 1) {
      expect(await sink.send(content)).toBe('failed');
    }
    expect(devices.get(token(1))).toMatchObject({ failures: 0, degradedSince: null });
  });

  it('kontekst wysyłki: temat i przepustka WPISU przechwycone z rekordem; wpis bez przepustki — sam temat', async () => {
    register(1, 'iPhone·Rarog');
    const pass = {
      pass: 'v1.k1.development.alert.x.1.sig', expiresAt: '2027-01-31T10:00:00.000Z', origin: 'https://push.rarog.ai',
      environment: 'development' as const, topic: RAROG, token: token(1),
    };
    devices.setRelayPass(pass);
    register(2, 'iPad·Rarog');
    const contexts = new Map<string, unknown>();
    const sink = makeSink({
      sender: { send: (_e, t, _r, context) => { contexts.set(t, context); return Promise.resolve(OK); } },
    });
    expect(await sink.send(content)).toBe('delivered');
    expect(contexts.get(token(1))).toEqual({ topic: RAROG, pass });
    expect(contexts.get(token(2))).toEqual({ topic: RAROG });
    await sink.sendTo(token(1), buildTestContent());
    expect(contexts.get(token(1))).toEqual({ topic: RAROG, pass });
  });

  it('wyjątek nadajnika to porażka, nigdy wyjątek sinka', async () => {
    register(1, 'iPad·Rarog');
    const sink = makeSink({
      sender: { send: () => Promise.reject(new Error('boom')) },
    });
    await expect(sink.send(content)).resolves.toBe('failed');
  });
});

describe('„skończył” — sama plakietka', () => {
  const done = (badge?: number): ReturnType<typeof buildContent> => buildContent({
    cls: 'done', kind: 'done', project: 'rarog', sessionId: 's1', ...(badge === undefined ? {} : { badge }),
  });

  it('doręczona plakietka odświeża `lastOkAt` — realne 200 jak każde inne', async () => {
    let clock = NOW - 60_000;
    devices = createApnsDeviceStore({ dataDir, now: () => clock });
    register(1, 'iPad·Rarog');
    devices.noteDelivered(token(1));
    clock = NOW;
    const { sender, calls } = fakeSender(() => OK);
    const sink = makeSink({ sender, now: () => clock });
    expect(await sink.send(done(1))).toBe('delivered');
    expect(payloadOf(calls, 1).aps).toEqual({ badge: 1 });
    expect(devices.get(token(1))?.lastOkAt).toBe(new Date(NOW).toISOString());
  });

  it('bez liczby na plakietkę — zero prób i `no-receiver`', async () => {
    register(1, 'iPad·Rarog');
    devices.noteDelivered(token(1));
    const { sender, calls } = fakeSender(() => OK);
    const sink = makeSink({ sender, now: () => NOW });
    expect(await sink.send(done())).toBe('no-receiver');
    expect(calls).toHaveLength(0);
  });
});

describe('sendTo — push próbny', () => {
  it('trafia wyłącznie do wskazanego tokenu (dowolna wielkość liter) i podbija `lastOkAt`', async () => {
    register(1, 'iPad·Rarog');
    register(2, 'iPhone·Rarog');
    const { sender, calls } = fakeSender(() => OK);
    const sink = makeSink({ sender, now: () => NOW });
    expect(await sink.sendTo(token(2).toUpperCase(), buildTestContent())).toBe('delivered');
    expect(calls.map((c) => c.token)).toEqual([token(2)]);
    expect(decrypt(payloadOf(calls, 2).block, keyOf(2).pushKey)).toMatchObject({ kind: 'test' });
    // To pierwsze REALNE 200 urządzenia — liczy się do `lastOkAt` jak każde inne.
    expect(devices.get(token(2))?.lastOkAt).toBe(new Date(NOW).toISOString());
  });

  it('nieznany token → `no-receiver`; porażka próbnego nie rusza licznika; `gone` usuwa', async () => {
    register(1, 'iPad·Rarog');
    let result: ApnsResult = FAIL;
    const { sender } = fakeSender(() => result);
    const sink = makeSink({ sender });
    expect(await sink.sendTo(token(9), buildTestContent())).toBe('no-receiver');
    expect(await sink.sendTo(token(1), buildTestContent())).toBe('failed');
    expect(devices.get(token(1))?.failures).toBe(0);
    result = { kind: 'gone', status: 400, reason: 'BadDeviceToken' };
    expect(await sink.sendTo(token(1), buildTestContent())).toBe('failed');
    expect(devices.get(token(1))).toBeUndefined();
  });
});

describe('temat APNs z wpisu', () => {
  /** Apka z innym bundle id niż Rarog, żeby było widać, skąd przyszedł temat. */
  const OTHER_TOPIC = 'ai.example.app';
  const registerWithTopic = (n: number, topic: string): void => {
    devices.upsert({
      token: token(n), environment: 'development', label: 'iPhone·Rarog', alerts: true, deviceId: deviceOf(n), topic,
      pushFormats: [3],
    });
  };
  const topicOf = (calls: readonly Call[], n: number): string | undefined =>
    calls.find((c) => c.token === token(n))?.request.headers['apns-topic'];

  it('baner: dwa wpisy z różnymi tematami w jednej wysyłce dostają różne `apns-topic`, reszta nagłówków ta sama', async () => {
    register(1, 'iPad·Rarog');
    registerWithTopic(2, OTHER_TOPIC);
    const { sender, calls } = fakeSender(() => OK);
    const sink = makeSink({ sender, now: () => NOW });
    expect(await sink.send(content)).toBe('delivered');
    expect(calls).toHaveLength(2);
    expect(topicOf(calls, 1)).toBe(RAROG);
    expect(topicOf(calls, 2)).toBe(OTHER_TOPIC);
    const [first, second] = calls.map((c) => c.request);
    expect(second?.headers['apns-expiration']).toBe(first?.headers['apns-expiration']);
    expect(second?.headers['apns-collapse-id']).toBe(first?.headers['apns-collapse-id']);
  });

  it('push próbny idzie pod tematem swojego wpisu', async () => {
    register(1, 'iPad·Rarog');
    registerWithTopic(2, OTHER_TOPIC);
    const { sender, calls } = fakeSender(() => OK);
    const sink = makeSink({ sender, now: () => NOW });
    expect(await sink.sendTo(token(2), buildTestContent())).toBe('delivered');
    expect(await sink.sendTo(token(1), buildTestContent())).toBe('delivered');
    expect(calls.map((c) => c.request.headers['apns-topic'])).toEqual([OTHER_TOPIC, RAROG]);
  });

  it('`device-paired` (sendWhere) idzie pod tematem wpisu każdego odbiorcy', async () => {
    register(1, 'iPad·Rarog');
    registerWithTopic(2, OTHER_TOPIC);
    registerWithTopic(3, OTHER_TOPIC);
    const { sender, calls } = fakeSender(() => OK);
    const sink = makeSink({ sender, now: () => NOW });
    const others = new Set([deviceOf(1), deviceOf(2)]);
    expect(await sink.sendWhere(buildDevicePairedContent('iPhone·Rarog'), (r) => others.has(r.deviceId)))
      .toBe('delivered');
    expect(calls.map((c) => c.token).sort()).toEqual([token(1), token(2)]);
    expect(topicOf(calls, 1)).toBe(RAROG);
    expect(topicOf(calls, 2)).toBe(OTHER_TOPIC);
  });
});

describe('format banera: tylko format 3, wpis bez deklaracji 3 pominięty', () => {
  const [DEV_A, DEV_B, DEV_GONE] = ['a', 'b', 'c'].map((c) => c.repeat(32)) as [string, string, string];
  const ACTIVE: ActivePushKeys = new Map([[DEV_A, keyOf(1)], [DEV_B, keyOf(2)]]);

  /** Wpis apki: temat Raroga, właściciel z parowania i (opcjonalnie) deklaracja formatów. */
  const rarog = (n: number, deviceId: string, pushFormats?: readonly number[]): void => {
    devices.upsert({
      token: token(n), environment: 'development', label: 'iPhone·Rarog', alerts: true, deviceId, topic: RAROG,
      ...(pushFormats === undefined ? {} : { pushFormats }),
    });
  };

  /**
   * Polityka `v2` przekaźnika (`relay/src/policy.ts`, `equalsExactly`): `aps` banera DOKŁADNIE z tych kluczy
   * i wartości, `alert` = tekst zastępczy, `mutable-content: 1` — albo sama plakietka. Porównanie obiektów, nie
   * „brak albo stała”.
   */
  function expectRelayShape(aps: Record<string, unknown>, extras: { badge?: number; thread?: string }): void {
    if (!('alert' in aps)) {
      expect(aps).toEqual(extras.badge === undefined ? {} : { badge: extras.badge });
      return;
    }
    expect(aps).toEqual({
      alert: { ...RELAY_ALERT_PLACEHOLDER }, 'mutable-content': 1, sound: 'default',
      ...(extras.badge === undefined ? {} : { badge: extras.badge }),
      ...(extras.thread === undefined ? {} : { 'thread-id': extras.thread }),
    });
  }

  const banner = buildContent({
    cls: 'blocking', kind: 'question', project: 'tajny-projekt', label: 'etykieta-sesji', sessionId: 'sesja-1',
    detail: foreign('Czy wdrożyć klucz produkcyjny?'), badge: 3,
  });

  it('dwa urządzenia z deklaracją: baner per wpis — własny `kid`, różne `n` i `c`, treść tylko w szyfrogramie', async () => {
    rarog(1, DEV_A, [1, 3]);
    rarog(2, DEV_B, [3]);
    const { sender, calls } = fakeSender(() => OK);
    const logs: string[] = [];
    const sink = makeSink({ sender, now: () => NOW, activeDevices: () => ACTIVE, log: (l) => { logs.push(l); } });
    expect(await sink.send(banner)).toBe('delivered');
    const [a, b] = [payloadOf(calls, 1), payloadOf(calls, 2)];
    expect(a.block['kid']).toBe(keyOf(1).kid);
    expect(b.block['kid']).toBe(keyOf(2).kid);
    expect(a.block['n']).not.toBe(b.block['n']);
    expect(a.block['c']).not.toBe(b.block['c']);
    expect(a.block['v']).toBe(3);
    expect(Object.keys(a.block).sort()).toEqual(['c', 'kid', 'n', 'v']);
    expect(Object.keys(JSON.parse(calls[0]?.request.body ?? '{}') as object).sort()).toEqual(['aps', 'rarog']);
    expectRelayShape(a.aps, { badge: 3, thread: topicFor('sesja-1') });
    expect(decrypt(a.block, keyOf(1).pushKey)).toEqual({
      kind: 'question', title: banner.title, titleRef: banner.titleRef, body: banner.body, bodyRef: banner.bodyRef,
      sessionId: 'sesja-1',
      exp: Math.floor(NOW / 1000) + banner.ttl,
    });
    // Klucz innego urządzenia szyfrogramu nie otworzy.
    expect(() => decrypt(a.block, keyOf(2).pushKey)).toThrow();
    // Jawna część nie niesie tytułu, treści, projektu, etykiety ani surowego `sessionId`.
    for (const call of calls) {
      for (const secret of ['tajny-projekt', 'etykieta-sesji', 'sesja-1', 'Czy wdrożyć', banner.title]) {
        expect(call.request.body).not.toContain(secret);
      }
    }
    expect(logs).toEqual(['push: APNs question — v3: 2']);
  });

  it('declaresPushFormat: tylko deklaracja z 3', () => {
    expect(declaresPushFormat([1, 2, 3])).toBe(true);
    expect(declaresPushFormat([3])).toBe(true);
    expect(declaresPushFormat([1, 2])).toBe(false);
    expect(declaresPushFormat([2])).toBe(false);
    expect(declaresPushFormat([1])).toBe(false);
    expect(declaresPushFormat([])).toBe(false);
    expect(declaresPushFormat(undefined)).toBe(false);
  });

  it('wpis bez deklaracji 3 (brak pola, sam format 1 albo sam 2): pominięty bez próby, z linią logu — także push próbny', async () => {
    const DEV_C = 'e'.repeat(32);
    const active: ActivePushKeys = new Map([...ACTIVE, [DEV_C, keyOf(3)]]);
    rarog(1, DEV_A, [1]);
    rarog(2, DEV_B);
    // Deklaracja z formatem 2 (apka sprzed zmiany nazwy): wpis zostaje w rejestrze, banerów nie dostaje.
    rarog(3, DEV_C, [1, 2]);
    const { sender, calls } = fakeSender(() => OK);
    const logs: string[] = [];
    const sink = makeSink({ sender, now: () => NOW, activeDevices: () => active, log: (l) => { logs.push(l); } });
    expect(await sink.send(banner)).toBe('no-receiver');
    expect(await sink.sendTo(token(3), buildTestContent())).toBe('no-receiver');
    expect(calls).toEqual([]);
    for (const n of [1, 2, 3]) expect(devices.get(token(n))).toMatchObject({ failures: 0, degradedSince: null });
    expect(devices.get(token(3))?.pushFormats).toEqual([1, 2]);
    const reason = 'push: APNs the app did not declare format 3 — entry skipped';
    expect(logs).toEqual([
      reason, reason, reason, 'push: APNs question — v3: 0, skipped: 3',
      reason, 'push: APNs test — v3: 0, skipped: 1',
    ]);
  });

  it('nieaktywny `deviceId` (odpięte urządzenie): pominięty bez próby i bez licznika porażek', async () => {
    // Drugie odpięte urządzenie: jedno urządzenie ma jeden wpis na temat.
    const DEV_GONE_2 = 'd'.repeat(32);
    rarog(1, DEV_GONE, [3]);
    rarog(2, DEV_GONE_2);
    rarog(4, DEV_A, [3]);
    const { sender, calls } = fakeSender(() => FAIL);
    const logs: string[] = [];
    const sink = makeSink({ sender, now: () => NOW, activeDevices: () => ACTIVE, log: (l) => { logs.push(l); } });
    expect(await sink.send(banner)).toBe('failed');
    expect(calls.map((c) => c.token)).toEqual([token(4)]);
    for (const n of [1, 2]) expect(devices.get(token(n))).toMatchObject({ failures: 0, degradedSince: null });
    expect(logs).toEqual(['push: APNs question — v3: 1, skipped: 2']);
    // Push próbny do odpiętego: zero prób.
    expect(await sink.sendTo(token(1), buildTestContent())).toBe('no-receiver');
    expect(calls).toHaveLength(1);
  });

  it('migawka aktywnych urządzeń RAZ na wysyłkę i PRZED listą rejestru (wygasanie kasuje tokeny odpiętych)', async () => {
    rarog(1, DEV_A, [3]);
    rarog(2, DEV_GONE, [3]);
    const { sender, calls } = fakeSender(() => OK);
    let snapshots = 0;
    // Jak `DeviceStore.active()`: przebieg wygasania woła słuchacza odpięcia, który kasuje tokeny urządzenia.
    const activeDevices = (): ActivePushKeys => {
      snapshots += 1;
      devices.removeOwnedBy(DEV_GONE);
      return ACTIVE;
    };
    const logs: string[] = [];
    const sink = makeSink({ sender, now: () => NOW, activeDevices, log: (l) => { logs.push(l); } });
    await sink.send(banner);
    expect(snapshots).toBe(1);
    expect(calls.map((c) => c.token)).toEqual([token(1)]);
    // Kolejność widać tylko tu: lista wzięta PRZED migawką zawiera token odpiętego i liczy go jako „skipped: 1”.
    expect(logs).toEqual(['push: APNs question — v3: 1']);
    await sink.sendTo(token(1), buildTestContent());
    expect(snapshots).toBe(2);
  });

  /** Wpis bez banera formatu 3 jest pomijany — zero prób i porażek, log bez treści, nigdy jawny zamiennik. */
  async function expectBannerSkipped(content: PushContent, sealer?: PushSealer): Promise<void> {
    rarog(1, DEV_A, [3]);
    const { sender, calls } = fakeSender(() => OK);
    const logs: string[] = [];
    const sink = makeSink({
      sender, now: () => NOW, activeDevices: () => ACTIVE, log: (l) => { logs.push(l); },
      ...(sealer === undefined ? {} : { sealer }),
    });
    expect(await sink.send(content)).toBe('no-receiver');
    expect(await sink.sendTo(token(1), content)).toBe('no-receiver');
    expect(calls).toEqual([]);
    expect(devices.get(token(1))).toMatchObject({ failures: 0, degradedSince: null });
    const skipped = [
      'push: APNs v3 payload over 4096 B or encryption failed — entry skipped',
      `push: APNs ${content.kind} — v3: 0, skipped: 1`,
    ];
    expect(logs).toEqual([...skipped, ...skipped]);
    for (const line of logs) expect(line).not.toContain('tajny-projekt');
  }

  it('ładunek ponad 4096 B (patologiczne `sessionId`): wpis pominięty bez próby i bez jawnego zamiennika', async () => {
    await expectBannerSkipped(buildContent({
      cls: 'blocking', kind: 'permission', project: 'tajny-projekt', sessionId: 's'.repeat(3200), detail: foreign('x'),
    }));
  });

  it('nieudane szyfrowanie (wyjątek `seal`): wpis pominięty bez próby i bez jawnego zamiennika', async () => {
    await expectBannerSkipped(banner, { seal: () => { throw new Error('seal'); } });
  });

  it('wyjątek magazynu kluczy przy migawce: wszystkie wpisy pominięte, zero prób', async () => {
    rarog(1, DEV_A, [3]);
    rarog(2, DEV_B, [3]);
    const { sender, calls } = fakeSender(() => OK);
    const logs: string[] = [];
    const sink = makeSink({
      sender, now: () => NOW, log: (l) => { logs.push(l); },
      activeDevices: () => { throw new Error('magazyn'); },
    });
    await expect(sink.send(banner)).resolves.toBe('no-receiver');
    expect(calls).toEqual([]);
    expect(logs).toEqual([
      'push: APNs active device snapshot failed — all entries skipped',
      'push: APNs question — v3: 0, skipped: 2',
    ]);
  });

  it('flaga E2E wyłączona: banerów nie ma — zero prób także przy deklaracji, z linią logu na wpis', async () => {
    rarog(1, DEV_A, [3]);
    rarog(2, DEV_B, [3]);
    const { sender, calls } = fakeSender(() => OK);
    const logs: string[] = [];
    const sink = makeSink({ sender, now: () => NOW, activeDevices: () => ACTIVE, e2e: false, log: (l) => { logs.push(l); } });
    expect(await sink.send(banner)).toBe('no-receiver');
    expect(await sink.sendTo(token(1), buildTestContent())).toBe('no-receiver');
    expect(calls).toEqual([]);
    const reason = 'push: APNs RAROG_PUSH_E2E=0, no banner without encryption — entry skipped';
    expect(logs).toEqual([
      reason, reason, 'push: APNs question — v3: 0, skipped: 2',
      reason, 'push: APNs test — v3: 0, skipped: 1',
    ]);
  });

  it('„skończył”: sama plakietka — bez alertu, dźwięku i mutable-content; wpis bez deklaracji pominięty', async () => {
    rarog(1, DEV_A, [3]);
    rarog(2, DEV_B);
    const { sender, calls } = fakeSender(() => OK);
    const done = buildContent({
      cls: 'done', kind: 'done', project: 'tajny-projekt', sessionId: 'sesja-1', termId: '0123456789abcdef',
      detail: foreign('Wynik'), badge: 0,
    });
    await makeSink({ sender, now: () => NOW, activeDevices: () => ACTIVE }).send(done);
    expect(calls.map((c) => c.token)).toEqual([token(1)]);
    const payload = payloadOf(calls, 1);
    expect(payload.aps).toEqual({ badge: 0 });
    expect(payload.block['v']).toBe(3);
    // Tekst jawny bez tytułu i treści: szyfrogram ukrywa tu tylko sesję i terminal.
    expect(decrypt(payload.block, keyOf(1).pushKey)).toEqual({
      kind: 'done', sessionId: 'sesja-1', termId: '0123456789abcdef', exp: Math.floor(NOW / 1000) + done.ttl,
    });
  });

  it('`device-paired` (sendWhere): każdy adresat z deklaracją dostaje własny szyfrogram', async () => {
    rarog(1, DEV_A, [3]);
    rarog(2, DEV_B, [3]);
    const { sender, calls } = fakeSender(() => OK);
    const sink = makeSink({ sender, now: () => NOW, activeDevices: () => ACTIVE });
    expect(await sink.sendWhere(buildDevicePairedContent('iPad·Rarog'), () => true)).toBe('delivered');
    const [a, b] = [payloadOf(calls, 1), payloadOf(calls, 2)];
    expectRelayShape(a.aps, {});
    expect(a.block['c']).not.toBe(b.block['c']);
    expect(decrypt(b.block, keyOf(2).pushKey)).toMatchObject({ kind: 'device-paired', title: '🔐 New device paired' });
    expect(calls.map((c) => c.request.body).join('\n')).not.toContain('iPad·Rarog');
  });

  it('push próbny (sendTo): wpis z deklaracją dostaje baner formatu 3, linia wysyłki bez treści', async () => {
    rarog(1, DEV_A, [3]);
    const { sender, calls } = fakeSender(() => OK);
    const logs: string[] = [];
    const sink = makeSink({ sender, now: () => NOW, activeDevices: () => ACTIVE, log: (l) => { logs.push(l); } });
    expect(await sink.sendTo(token(1), buildTestContent())).toBe('delivered');
    const payload = payloadOf(calls, 1);
    expectRelayShape(payload.aps, {});
    expect(decrypt(payload.block, keyOf(1).pushKey)).toMatchObject({ kind: 'test' });
    expect(logs).toEqual(['push: APNs test — v3: 1']);
  });

  /** Klucze tekstu zastępczego — polityka przekaźnika `alert.placeholderKeys`. */
  const PLACEHOLDER_KEYS = { 'title-loc-key': 'push.placeholder.title', 'loc-key': 'push.placeholder.body' };
  const declare = (store: ApnsDeviceStore, n: number, deviceId: string, locKeys?: boolean): void => {
    store.upsert({
      token: token(n), environment: 'development', label: 'iPhone·Rarog', alerts: true, deviceId, topic: RAROG,
      pushFormats: [3], ...(locKeys === undefined ? {} : { locKeys }),
    });
  };

  it('`locKeys`: dwa urządzenia, jedno z deklaracją — każde dostaje swój tekst zastępczy, reszta `aps` ta sama', async () => {
    declare(devices, 1, DEV_A, true);
    declare(devices, 2, DEV_B);
    const { sender, calls } = fakeSender(() => OK);
    const sink = makeSink({ sender, now: () => NOW, activeDevices: () => ACTIVE });
    expect(await sink.send(banner)).toBe('delivered');
    const keyed = payloadOf(calls, 1).aps;
    const literal = payloadOf(calls, 2).aps;
    expect(keyed['alert']).toEqual(PLACEHOLDER_KEYS);
    expect(literal['alert']).toEqual({ ...RELAY_ALERT_PLACEHOLDER });
    expect({ ...keyed, alert: literal['alert'] }).toEqual(literal);
    expect(decrypt(payloadOf(calls, 1).block, keyOf(1).pushKey)).toEqual(decrypt(payloadOf(calls, 2).block, keyOf(2).pushKey));
  });

  it('`locKeys`: deklaracja z rejestracji przeżywa restart magazynu; rejestracja bez pola wraca do literału', async () => {
    declare(devices, 1, DEV_A, true);
    await devices.flush();
    const reopened = createApnsDeviceStore({ dataDir, now: () => NOW });
    const { sender, calls } = fakeSender(() => OK);
    const sink = createApnsSink({ devices: reopened, activeDevices: () => ACTIVE, e2e: true, sender, now: () => NOW });
    expect(await sink.send(banner)).toBe('delivered');
    expect(payloadOf(calls, 1).aps['alert']).toEqual(PLACEHOLDER_KEYS);
    // Push próbny i `device-paired` idą tą samą regułą.
    calls.length = 0;
    expect(await sink.sendTo(token(1), buildTestContent())).toBe('delivered');
    expect(payloadOf(calls, 1).aps['alert']).toEqual(PLACEHOLDER_KEYS);
    calls.length = 0;
    expect(await sink.sendWhere(buildDevicePairedContent('iPad·Rarog'), () => true)).toBe('delivered');
    expect(payloadOf(calls, 1).aps['alert']).toEqual(PLACEHOLDER_KEYS);
    declare(reopened, 1, DEV_A);
    calls.length = 0;
    expect(await sink.send(banner)).toBe('delivered');
    expect(payloadOf(calls, 1).aps['alert']).toEqual({ ...RELAY_ALERT_PLACEHOLDER });
    await reopened.flush();
  });

  it('strażnik 13b: KAŻDY ładunek banera ma `aps` w kształcie polityki `v2` i nie niesie jawnej treści', async () => {
    rarog(1, DEV_A, [3]);
    rarog(2, DEV_B, [2]);
    const { sender, calls } = fakeSender(() => OK);
    const variants = [
      banner, buildTestContent(), buildDevicePairedContent('iPad·Rarog'),
      buildContent({ cls: 'done', kind: 'done', project: 'tajny-projekt', sessionId: 'sesja-1', badge: 1 }),
      buildContent({ cls: 'failure', kind: 'error', project: 'tajny-projekt', sessionId: 'sesja-1', detail: foreign('Padło') }),
    ];
    for (const e2e of [true, false]) {
      const sink = makeSink({ sender, now: () => NOW, activeDevices: () => ACTIVE, e2e });
      for (const content of variants) await sink.send(content);
    }
    // Wysyła tylko wpis z deklaracją i tylko przy włączonej fladze.
    expect(calls.map((c) => c.token)).toEqual(variants.map(() => token(1)));
    for (const call of calls) {
      const parsed = JSON.parse(call.request.body) as Record<string, Record<string, unknown> | undefined>;
      const aps = parsed['aps'] ?? {};
      const block = parsed['rarog'] ?? {};
      const thread = aps['thread-id'];
      expectRelayShape(aps, {
        ...(typeof aps['badge'] === 'number' ? { badge: aps['badge'] } : {}),
        ...(typeof thread === 'string' ? { thread } : {}),
      });
      // Wątek to skrót sesji (klucz koalescencji), nigdy surowe id.
      expect(Object.keys(parsed).sort()).toEqual(['aps', 'rarog']);
      expect(block['v']).toBe(3);
      expect([undefined, topicFor('sesja-1')]).toContain(thread);
      for (const secret of ['tajny-projekt', 'etykieta-sesji', 'Czy wdrożyć', 'Padło', 'iPad·Rarog', 'Notifications are working']) {
        expect(call.request.body, call.token).not.toContain(secret);
      }
    }
  });
});
