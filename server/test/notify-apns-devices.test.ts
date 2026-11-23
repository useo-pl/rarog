/**
 * Rejestr urządzeń APNs (`notify/apns-devices.ts`) — plik `apns-devices.json` w `dataDir`.
 *
 * Do udowodnienia: prawa `0600`, LRU 20 po `lastOkAt` bez wyrzucania wpisu, który właśnie wchodzi,
 * uszkodzony plik = pusty stan, etykieta po sanityzacji, `alerts` przechowany, licznik porażek
 * i degradacja per token, token klucząco małymi literami, blok Live Activity przeżywa zapis
 * i odczyt, a nieznany klucz z pliku jest ignorowany i znika przy zapisie; `deviceId` i temat APNs
 * wpisu są wymagane: zadeklarowane przez apkę przeżywają zapis i odczyt, a wpis w pliku bez któregoś z nich
 * znika przy odczycie i z pliku przy pierwszym zapisie; przepustki przekaźnika z zapisem
 * warunkowym. Deklaracja formatów `pushFormats`: zapis z TEJ rejestracji, rejestracja bez pola ją kasuje,
 * odczyt bierze tylko tablicę liczb całkowitych do 8. Deklaracja kluczy `locKeys`: tak samo z TEJ rejestracji,
 * w pliku wyłącznie `true`, a plik z tym polem czyta się bez utraty wpisów także kodem, który pola nie zna.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  APNS_DEVICES_FILENAME, APNS_DEVICES_MAX, LABEL_FALLBACK, LABEL_MAX_CODEPOINTS, apnsTopicOf,
  createApnsDeviceStore, sanitizeLabel,
} from '../src/notify/apns-devices.ts';
import type { ApnsDeviceStore, RelayPass } from '../src/notify/apns-devices.ts';
import { DEGRADED_AFTER_FAILURES } from '../src/notify/index.ts';

const token = (n: number): string => n.toString(16).padStart(64, '0');
/** Każdy token z innego urządzenia: jeden wpis na urządzenie i temat nie zlewa wpisów testu. */
const deviceOf = (n: number): string => n.toString(16).padStart(32, '0');
const TOPIC = 'ai.rarog.app';
const START = Date.parse('2026-10-07T10:00:00.000Z');

let dataDir = '';
let clock = START;
let stores: ApnsDeviceStore[] = [];

const open = (): ApnsDeviceStore => {
  const store = createApnsDeviceStore({ dataDir, now: () => clock });
  stores.push(store);
  return store;
};

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'rarog-apns-devices-'));
  clock = START;
  stores = [];
});

afterEach(async () => {
  await Promise.all(stores.map((s) => s.flush()));
  await rm(dataDir, { recursive: true, force: true });
});

const register = (store: ApnsDeviceStore, n: number, extra: { label?: string; alerts?: boolean } = {}): void => {
  store.upsert({
    token: token(n), environment: 'development', label: extra.label ?? 'iPad·Rarog', alerts: extra.alerts ?? true,
    deviceId: deviceOf(n), topic: TOPIC,
  });
};

describe('zapis na dysku', () => {
  it('plik ma prawa 0600 i wraca po restarcie z kompletem pól', async () => {
    const store = open();
    register(store, 1, { label: 'iPhone·Rarog', alerts: false });
    await store.flush();
    const file = join(dataDir, APNS_DEVICES_FILENAME);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const again = open().get(token(1));
    expect(again).toEqual({
      token: token(1), environment: 'development', label: 'iPhone·Rarog', alerts: false,
      createdAt: new Date(START).toISOString(), updatedAt: new Date(START).toISOString(),
      lastOkAt: null, failures: 0, degradedSince: null, deviceId: deviceOf(1), topic: TOPIC,
    });
  });

  it('uszkodzony plik = pusty stan, nigdy wyjątek; zły wpis wypada, reszta zostaje', async () => {
    await writeFile(join(dataDir, APNS_DEVICES_FILENAME), '{ to nie jest json');
    expect(open().size).toBe(0);
    await writeFile(join(dataDir, APNS_DEVICES_FILENAME), JSON.stringify({
      devices: [
        { token: 'nie-hex', environment: 'development', createdAt: 'x' },
        { token: token(2), environment: 'sandbox', createdAt: 'x' },
        {
          token: token(3), environment: 'production', createdAt: '2026-10-01T00:00:00.000Z', alerts: true, label: 'iPad·Rarog',
          deviceId: deviceOf(3), topic: TOPIC,
        },
      ],
    }));
    const store = open();
    expect(store.list().map((r) => r.token)).toEqual([token(3)]);
    expect(store.get(token(3))).toMatchObject({ environment: 'production', alerts: true, label: 'iPad·Rarog' });
  });

  it('nieznany klucz w pliku (`deviceClass`): wpis wczytany bez niego, zapis go już nie pisze', async () => {
    await writeFile(join(dataDir, APNS_DEVICES_FILENAME), JSON.stringify({
      devices: [{
        token: token(4), environment: 'development', deviceClass: 'iPad', label: 'iPad·Rarog', alerts: true,
        createdAt: '2026-10-01T00:00:00.000Z', deviceId: deviceOf(4), topic: TOPIC,
      }],
    }));
    const store = open();
    expect(store.get(token(4))).toBeDefined();
    expect(store.get(token(4))).not.toHaveProperty('deviceClass');
    register(store, 4);
    await store.flush();
    const written = JSON.parse(await readFile(join(dataDir, APNS_DEVICES_FILENAME), 'utf8')).devices[0];
    expect(written).not.toHaveProperty('deviceClass');
    expect(written).toMatchObject({ token: token(4), createdAt: '2026-10-01T00:00:00.000Z' });
  });

  it('blok Live Activity przeżywa zapis i odczyt; upsert go nie gubi', async () => {
    const liveActivity = { activityId: 'akt-1', updateToken: 'ab'.repeat(40), startedAt: '2026-10-07T09:00:00.000Z' };
    await writeFile(join(dataDir, APNS_DEVICES_FILENAME), JSON.stringify({
      devices: [{
        token: token(1), environment: 'development', createdAt: 'x', label: 'iPad·Rarog', liveActivity,
        deviceId: deviceOf(1), topic: TOPIC,
      }],
    }));
    const store = open();
    register(store, 1);
    await store.flush();
    expect(JSON.parse(await readFile(join(dataDir, APNS_DEVICES_FILENAME), 'utf8')).devices[0].liveActivity)
      .toEqual(liveActivity);
  });
});

describe('`deviceId` i temat APNs wpisu', () => {
  const file = (): string => join(dataDir, APNS_DEVICES_FILENAME);
  const written = async (): Promise<Record<string, unknown>[]> =>
    (JSON.parse(await readFile(file(), 'utf8')) as { devices: Record<string, unknown>[] }).devices;

  it('wpis w pliku bez `topic` albo `deviceId` (albo z wartością spoza reguły) znika; pierwszy zapis zdejmuje go z pliku', async () => {
    const entry = (n: number, over: Record<string, unknown>): Record<string, unknown> => ({
      token: token(n), environment: 'development', label: 'iPhone·Rarog', alerts: true,
      createdAt: '2026-10-01T00:00:00.000Z', deviceId: deviceOf(n), topic: TOPIC, ...over,
    });
    await writeFile(file(), JSON.stringify({
      devices: [
        entry(1, {}), entry(2, { topic: undefined }), entry(3, { deviceId: undefined }),
        entry(4, { topic: 'bez kropki' }), entry(5, { deviceId: 'nie-hex' }),
      ],
    }));
    const store = open();
    expect(store.list().map((r) => r.token)).toEqual([token(1)]);
    // Zapis z innego powodu (dostawa) zapisuje tylko wpisy, które przeszły odczyt.
    store.noteDelivered(token(1));
    await store.flush();
    expect((await written()).map((e) => e['token'])).toEqual([token(1)]);
  });

  it('temat zadeklarowany przez apkę przeżywa zapis i odczyt i jest tematem wysyłek tego wpisu', async () => {
    const store = open();
    store.upsert({
      token: token(2), environment: 'development', label: 'iPad·Rarog', alerts: true, deviceId: deviceOf(2),
      topic: 'ai.example.app',
    });
    register(store, 3);
    await store.flush();
    expect((await written()).map((entry) => entry['topic'])).toEqual(['ai.example.app', TOPIC]);
    const again = open();
    expect(again.get(token(2))).toMatchObject({ topic: 'ai.example.app', deviceId: deviceOf(2) });
    expect(apnsTopicOf(again.get(token(2)) ?? { topic: '' })).toBe('ai.example.app');
    expect(apnsTopicOf(again.get(token(3)) ?? { topic: '' })).toBe(TOPIC);
  });
});

describe('upsert', () => {
  it('ten sam token w innej wielkości liter to TEN SAM wpis (klucz małymi literami)', () => {
    const store = open();
    const owner = { deviceId: deviceOf(10), topic: TOPIC };
    store.upsert({ token: token(10).toUpperCase(), environment: 'development', label: 'iPad·Rarog', alerts: true, ...owner });
    store.upsert({ token: token(10), environment: 'development', label: 'iPad·Rarog', alerts: false, ...owner });
    expect(store.size).toBe(1);
    expect(store.get(token(10).toUpperCase())?.alerts).toBe(false);
  });

  it('odświeżenie zachowuje `createdAt`, `lastOkAt` i licznik; podbija `updatedAt`', () => {
    const store = open();
    register(store, 1);
    store.noteDelivered(token(1));
    store.noteFailed(token(1));
    clock += 60_000;
    register(store, 1, { alerts: false });
    expect(store.get(token(1))).toMatchObject({
      createdAt: new Date(START).toISOString(), updatedAt: new Date(START + 60_000).toISOString(),
      lastOkAt: new Date(START).toISOString(), failures: 1, alerts: false,
    });
  });

  it('`alerts: false` NIE usuwa wpisu — token jest potrzebny Live Activity', () => {
    const store = open();
    register(store, 1, { alerts: false });
    expect(store.get(token(1))?.alerts).toBe(false);
    expect(store.size).toBe(1);
  });

  it('etykieta przechodzi sanityzację (znaki sterujące wypadają)', () => {
    const store = open();
    register(store, 1, { label: 'iPad·Rarog\n\u0007' });
    expect(store.get(token(1))?.label).toBe('iPad·Rarog');
  });
});

describe('sanitizeLabel — etykieta jest wejściem z telefonu', () => {
  it('wycina znaki kontrolne i zwija białe znaki', () => {
    expect(sanitizeLabel('iPhone\nJana\r\t x')).toBe('iPhoneJana x');
    expect(sanitizeLabel('  a   b  ')).toBe('a b');
  });

  it('liczy PUNKTY KODOWE, więc emoji w nazwie nie jest cięte w pół', () => {
    const label = sanitizeLabel('📱'.repeat(LABEL_MAX_CODEPOINTS + 5));
    expect([...label]).toHaveLength(LABEL_MAX_CODEPOINTS);
    expect(label.endsWith('📱')).toBe(true);
  });

  it('pusta albo złożona z samych śmieci → nazwa zastępcza', () => {
    expect(sanitizeLabel(undefined)).toBe(LABEL_FALLBACK);
    expect(sanitizeLabel('\u0000\u0007')).toBe(LABEL_FALLBACK);
  });
});

describe('LRU — sufit 20', () => {
  it('ponad sufit wypada najdłużej niepotwierdzony, NIGDY wpis, który właśnie wchodzi', () => {
    const store = open();
    for (let n = 1; n <= APNS_DEVICES_MAX; n += 1) {
      register(store, n);
      clock += 1_000;
      store.noteDelivered(token(n));
    }
    // Wszystkie dwadzieścia potwierdzone — świeży bez `lastOkAt` byłby „najstarszy", a nie wypada.
    register(store, 99);
    expect(store.size).toBe(APNS_DEVICES_MAX);
    expect(store.get(token(99))).toBeDefined();
    expect(store.get(token(1))).toBeUndefined();
    expect(store.get(token(2))).toBeDefined();
  });
});

describe('porażki i degradacja per token', () => {
  it(`${String(DEGRADED_AFTER_FAILURES)} porażki z rzędu zapalają \`degradedSince\`; 200 gasi wszystko`, () => {
    const store = open();
    register(store, 1);
    for (let i = 1; i < DEGRADED_AFTER_FAILURES; i += 1) store.noteFailed(token(1));
    expect(store.get(token(1))?.degradedSince).toBeNull();
    clock += 5_000;
    store.noteFailed(token(1));
    expect(store.get(token(1))).toMatchObject({
      failures: DEGRADED_AFTER_FAILURES, degradedSince: new Date(START + 5_000).toISOString(),
    });
    // Dalsze porażki nie przesuwają „od kiedy".
    clock += 5_000;
    store.noteFailed(token(1));
    expect(store.get(token(1))?.degradedSince).toBe(new Date(START + 5_000).toISOString());
    store.noteDelivered(token(1));
    expect(store.get(token(1))).toMatchObject({
      failures: 0, degradedSince: null, lastOkAt: new Date(START + 10_000).toISOString(),
    });
  });

  it('nieznany token: noteDelivered/noteFailed/remove to nie błąd', () => {
    const store = open();
    store.noteDelivered(token(5));
    store.noteFailed(token(5));
    expect(store.remove(token(5))).toBe(false);
    expect(store.size).toBe(0);
  });
});

/*
 * Blok Live Activity: token aktualizacji zbiorczej aktywności przypięty do urządzenia.
 * Nowy `activityId` zastępuje poprzednią aktywność, ten sam id z nowym tokenem to rotacja,
 * a kasowanie bloku wymaga zgodnego id (i tokenu, gdy wołający go zna) — spóźnione „zakończ"
 * albo `410` starej aktywności nie zamyka nowej.
 */
describe('blok Live Activity', () => {
  const update = (n: number): string => `${'ab'.repeat(30)}${n.toString(16).padStart(4, '0')}`;

  it('nieznane urządzenie → `unknown-device`, nic nie powstaje', () => {
    const store = open();
    expect(store.setLiveActivity(token(1), { activityId: 'akt-1', updateToken: update(1) })).toBe('unknown-device');
    expect(store.size).toBe(0);
  });

  it('nowa aktywność, rotacja tokenu, powtórka bez zmian i zastąpienie nową aktywnością', async () => {
    const store = open();
    register(store, 1);
    expect(store.setLiveActivity(token(1), { activityId: 'akt-1', updateToken: update(1).toUpperCase() }))
      .toBe('started');
    expect(store.get(token(1))?.liveActivity).toEqual({
      activityId: 'akt-1', updateToken: update(1), startedAt: new Date(START).toISOString(),
    });
    clock += 60_000;
    expect(store.setLiveActivity(token(1), { activityId: 'akt-1', updateToken: update(2) })).toBe('rotated');
    // Rotacja trzyma chwilę startu aktywności — to ta sama aktywność.
    expect(store.get(token(1))?.liveActivity).toEqual({
      activityId: 'akt-1', updateToken: update(2), startedAt: new Date(START).toISOString(),
    });
    expect(store.setLiveActivity(token(1), { activityId: 'akt-1', updateToken: update(2) })).toBe('unchanged');
    expect(store.setLiveActivity(token(1), { activityId: 'akt-2', updateToken: update(3) })).toBe('started');
    expect(store.get(token(1))?.liveActivity).toMatchObject({
      activityId: 'akt-2', startedAt: new Date(START + 60_000).toISOString(),
    });
    await store.flush();
    expect(open().get(token(1))?.liveActivity?.activityId).toBe('akt-2');
  });

  it('kasowanie tylko przy zgodnym id i — gdy podany — zgodnym tokenie', () => {
    const store = open();
    register(store, 1);
    store.setLiveActivity(token(1), { activityId: 'akt-1', updateToken: update(1) });
    expect(store.clearLiveActivity(token(1), { activityId: 'akt-0' })).toBe(false);
    expect(store.clearLiveActivity(token(1), { activityId: 'akt-1', updateToken: update(9) })).toBe(false);
    expect(store.get(token(1))?.liveActivity).toBeDefined();
    expect(store.clearLiveActivity(token(1), { activityId: 'akt-1', updateToken: update(1).toUpperCase() })).toBe(true);
    expect(store.get(token(1))?.liveActivity).toBeUndefined();
    // Wpis urządzenia zostaje — znika tylko aktywność.
    expect(store.get(token(1))).toBeDefined();
    expect(store.clearLiveActivity(token(1), { activityId: 'akt-1' })).toBe(false);
    expect(store.clearLiveActivity(token(7), { activityId: 'akt-1' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Przepustki przekaźnika push
// ---------------------------------------------------------------------------

const RELAY = 'https://push.rarog.ai';
const relayPass = (n: number, over: Partial<RelayPass> = {}): RelayPass => ({
  pass: `v1.k1.development.alert.${String(n)}.sig`, expiresAt: '2027-01-31T10:00:00.000Z', origin: RELAY,
  environment: 'development', topic: 'ai.rarog.app', token: token(n), ...over,
});
const registerRarog = (store: ApnsDeviceStore, n: number, environment: 'development' | 'production' = 'development'): void => {
  store.upsert({ token: token(n), environment, label: 'iPhone·Rarog', alerts: true, deviceId: deviceOf(n), topic: TOPIC });
};

describe('przepustki przekaźnika w rejestrze', () => {
  it('przepustka urządzenia i aktywności oraz odmowa `env-mismatch` przeżywają zapis i odczyt', async () => {
    const store = open();
    registerRarog(store, 1);
    expect(store.setRelayPass(relayPass(1))).toBe(true);
    store.setLiveActivity(token(1), { activityId: 'akt-1', updateToken: 'ab'.repeat(40) });
    expect(store.setActivityRelayPass(token(1), 'akt-1', relayPass(1, { token: 'AB'.repeat(40) }))).toBe(true);
    registerRarog(store, 2);
    expect(store.noteRelayMismatch(token(2), 'ai.rarog.app',
      { since: '2026-10-07T10:00:00.000Z', origin: RELAY, environment: 'development' })).toBe(true);
    await store.flush();
    const again = open();
    expect(again.get(token(1))?.relayPass).toEqual(relayPass(1));
    expect(again.get(token(1))?.liveActivity?.relayPass).toEqual(relayPass(1, { token: 'ab'.repeat(40) }));
    expect(again.get(token(2))?.relayMismatch).toEqual({ since: '2026-10-07T10:00:00.000Z', origin: RELAY, environment: 'development' });
  });

  it('zła przepustka w pliku = brak przepustki; wpis zostaje', async () => {
    const good = { token: token(1), environment: 'development', label: 'x', alerts: true, createdAt: 't', topic: TOPIC };
    await writeFile(join(dataDir, APNS_DEVICES_FILENAME), JSON.stringify({ devices: [
      { ...good, deviceId: deviceOf(1), relayPass: { ...relayPass(1), pass: 'ze spacją' } },
      { ...good, deviceId: deviceOf(2), token: token(2), relayPass: { ...relayPass(2), expiresAt: 'jutro' } },
      {
        ...good, deviceId: deviceOf(3), token: token(3), relayPass: { ...relayPass(3), environment: 'staging' },
        relayMismatch: { since: 'x' },
      },
    ] }));
    const store = open();
    expect(store.size).toBe(3);
    for (const n of [1, 2, 3]) {
      expect(store.get(token(n))).not.toHaveProperty('relayPass');
      expect(store.get(token(n))).not.toHaveProperty('relayMismatch');
    }
  });

  it('zapis warunkowy: brak wpisu, inne środowisko albo temat — nic; starsza przepustka nie nadpisuje nowszej', () => {
    const store = open();
    expect(store.setRelayPass(relayPass(1))).toBe(false);
    expect(store.size).toBe(0);
    registerRarog(store, 1, 'production');
    expect(store.setRelayPass(relayPass(1))).toBe(false);
    registerRarog(store, 1);
    expect(store.setRelayPass(relayPass(1, { topic: 'pl.useo.rarog' }))).toBe(false);
    expect(store.setRelayPass(relayPass(1))).toBe(true);
    expect(store.setRelayPass(relayPass(1, { pass: 'v1.k1.starsza', expiresAt: '2027-01-30T10:00:00.000Z' }))).toBe(false);
    expect(store.get(token(1))?.relayPass?.pass).toBe(relayPass(1).pass);
    // Inny przekaźnik: stara przepustka nie jest już przepustką tego wpisu — nowa ją zastępuje mimo terminu.
    expect(store.setRelayPass(relayPass(1, { origin: 'https://relay.example.net', expiresAt: '2027-01-01T00:00:00.000Z' })))
      .toBe(true);
  });

  it('rejestracja: przepustka zostaje przy tym samym środowisku i temacie; inne środowisko albo temat ją zdejmuje', () => {
    const store = open();
    registerRarog(store, 1);
    store.setRelayPass(relayPass(1));
    store.noteRelayMismatch(token(1), 'ai.rarog.app', { since: 't0', origin: RELAY, environment: 'development' });
    registerRarog(store, 1);
    expect(store.get(token(1))?.relayPass).toEqual(relayPass(1));
    expect(store.get(token(1))?.relayMismatch).toBeDefined();
    registerRarog(store, 1, 'production');
    expect(store.get(token(1))).not.toHaveProperty('relayPass');
    expect(store.get(token(1))).not.toHaveProperty('relayMismatch');
    // Rejestracja tego tokenu z innym tematem też zdejmuje przepustkę: wydano ją na stary temat.
    registerRarog(store, 2);
    store.setRelayPass(relayPass(2));
    store.upsert({
      token: token(2), environment: 'development', label: 'iPhone·Rarog', alerts: true, deviceId: deviceOf(2),
      topic: 'ai.example.app',
    });
    expect(store.get(token(2))).not.toHaveProperty('relayPass');
  });

  it('pierwsze 200 zdejmuje odmowę `env-mismatch`; przepustka tego przekaźnika też', () => {
    const store = open();
    registerRarog(store, 1);
    store.noteRelayMismatch(token(1), 'ai.rarog.app', { since: 't0', origin: RELAY, environment: 'development' });
    store.noteDelivered(token(1));
    expect(store.get(token(1))).not.toHaveProperty('relayMismatch');
    store.noteRelayMismatch(token(1), 'ai.rarog.app', { since: 't1', origin: RELAY, environment: 'development' });
    // Powtórka odmowy nie przesuwa `since`.
    store.noteRelayMismatch(token(1), 'ai.rarog.app', { since: 't2', origin: RELAY, environment: 'development' });
    expect(store.get(token(1))?.relayMismatch?.since).toBe('t1');
    store.setRelayPass(relayPass(1));
    expect(store.get(token(1))).not.toHaveProperty('relayMismatch');
  });

  it('zdjęcie po `401`: tylko TA przepustka; rotacja tokenu aktywności zdejmuje przepustkę aktywności', () => {
    const store = open();
    registerRarog(store, 1);
    store.setRelayPass(relayPass(1));
    expect(store.dropRelayPass(token(1), 'v1.k1.inna')).toBe(false);
    expect(store.dropRelayPass(token(1), relayPass(1).pass)).toBe(true);
    expect(store.get(token(1))).not.toHaveProperty('relayPass');
    store.setLiveActivity(token(1), { activityId: 'akt-1', updateToken: 'ab'.repeat(40) });
    store.setActivityRelayPass(token(1), 'akt-1', relayPass(1, { token: 'ab'.repeat(40) }));
    expect(store.setLiveActivity(token(1), { activityId: 'akt-1', updateToken: 'cd'.repeat(40) })).toBe('rotated');
    expect(store.get(token(1))?.liveActivity).not.toHaveProperty('relayPass');
    expect(store.setActivityRelayPass(token(1), 'akt-1', relayPass(1, { token: 'ab'.repeat(40) }))).toBe(false);
    expect(store.setActivityRelayPass(token(1), 'akt-2', relayPass(1, { token: 'cd'.repeat(40) }))).toBe(false);
    expect(store.setActivityRelayPass(token(1), 'akt-1', relayPass(1, { token: 'cd'.repeat(40) }))).toBe(true);
    expect(store.dropActivityRelayPass(token(1), 'akt-1', relayPass(1).pass)).toBe(true);
  });
});

describe('deklaracja formatów `pushFormats`', () => {
  const registerFormats = (store: ApnsDeviceStore, n: number, pushFormats?: readonly number[]): void => {
    store.upsert({
      token: token(n), environment: 'development', label: 'iPhone·Rarog', alerts: true, topic: 'ai.rarog.app',
      deviceId: 'a'.repeat(32), ...(pushFormats === undefined ? {} : { pushFormats }),
    });
  };

  it('zapis z rejestracji przeżywa restart; ponowna rejestracja BEZ pola kasuje deklarację', async () => {
    const store = open();
    registerFormats(store, 1, [1, 2]);
    await store.flush();
    expect(open().get(token(1))?.pushFormats).toEqual([1, 2]);
    registerFormats(store, 1);
    expect(store.get(token(1))).not.toHaveProperty('pushFormats');
    await store.flush();
    expect(open().get(token(1))).not.toHaveProperty('pushFormats');
  });

  it('zła deklaracja w pliku (nie tablica, ułamek, napis, ponad 8) = brak deklaracji; wpis zostaje', async () => {
    const entry = (n: number, pushFormats: unknown): Record<string, unknown> => ({
      token: token(n), environment: 'development', label: 'x', alerts: true, createdAt: '2026-10-07T10:00:00.000Z',
      deviceId: deviceOf(n), topic: TOPIC, pushFormats,
    });
    await writeFile(join(dataDir, APNS_DEVICES_FILENAME), JSON.stringify({
      devices: [
        entry(1, [1, 2]), entry(2, 2), entry(3, [1, 2.5]), entry(4, ['2']), entry(5, [1, 2, 3, 4, 5, 6, 7, 8, 9]),
        entry(6, [1, 2, 3, 4, 5, 6, 7, 8]), entry(7, null),
      ],
    }));
    const store = open();
    expect(store.size).toBe(7);
    expect(store.get(token(1))?.pushFormats).toEqual([1, 2]);
    for (const n of [2, 3, 4, 5, 7]) expect(store.get(token(n)), String(n)).not.toHaveProperty('pushFormats');
    expect(store.get(token(6))?.pushFormats).toHaveLength(8);
  });
});

describe('deklaracja kluczy lokalizacji `locKeys`', () => {
  const entry = (n: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    token: token(n), environment: 'development', label: 'iPhone·Rarog', alerts: true,
    createdAt: '2026-10-07T10:00:00.000Z', deviceId: deviceOf(n), topic: TOPIC, pushFormats: [3], ...extra,
  });

  /*
   * Droga powrotu: serwer po wycofaniu czyta plik zapisany z deklaracją. Odczyt bierze pola po nazwie, więc `locKeys`
   * (każda wartość) nie zabiera wpisu ani żadnego innego pola.
   */
  it('plik z polem `locKeys` (każda wartość) czyta się bez utraty wpisów i pozostałych pól', async () => {
    await writeFile(join(dataDir, APNS_DEVICES_FILENAME), JSON.stringify({
      devices: [entry(1, { locKeys: true }), entry(2, { locKeys: false }), entry(3, { locKeys: 'yes' }), entry(4)],
    }));
    const store = open();
    expect(store.size).toBe(4);
    for (const n of [1, 2, 3, 4]) {
      expect(store.get(token(n)), String(n)).toMatchObject({
        token: token(n), deviceId: deviceOf(n), topic: TOPIC, alerts: true, pushFormats: [3],
        createdAt: '2026-10-07T10:00:00.000Z',
      });
    }
  });

  it('odczyt: deklaracja tylko przy `true`; `false`, napis albo brak pola = brak deklaracji', async () => {
    await writeFile(join(dataDir, APNS_DEVICES_FILENAME), JSON.stringify({
      devices: [entry(1, { locKeys: true }), entry(2, { locKeys: false }), entry(3, { locKeys: 'yes' }), entry(4),
        entry(5, { locKeys: 1 }), entry(6, { locKeys: null })],
    }));
    const store = open();
    expect(store.get(token(1))?.locKeys).toBe(true);
    for (const n of [2, 3, 4, 5, 6]) expect(store.get(token(n)), String(n)).not.toHaveProperty('locKeys');
  });

  const registerKeys = (store: ApnsDeviceStore, locKeys?: boolean): void => {
    store.upsert({
      token: token(1), environment: 'development', label: 'iPhone·Rarog', alerts: true, deviceId: deviceOf(1),
      topic: TOPIC, pushFormats: [3], ...(locKeys === undefined ? {} : { locKeys }),
    });
  };

  it('rejestracja z `true` zapisuje deklarację, która przeżywa restart magazynu', async () => {
    const store = open();
    registerKeys(store, true);
    expect(store.get(token(1))?.locKeys).toBe(true);
    await store.flush();
    const written = JSON.parse(await readFile(join(dataDir, APNS_DEVICES_FILENAME), 'utf8')).devices[0];
    expect(written).toMatchObject({ token: token(1), locKeys: true });
    expect(open().get(token(1))?.locKeys).toBe(true);
  });

  it.each([['bez pola', undefined], ['z `false`', false]] as const)(
    'ponowna rejestracja %s zdejmuje deklarację, także w pliku po restarcie',
    async (_what, locKeys) => {
      const store = open();
      registerKeys(store, true);
      registerKeys(store, locKeys);
      expect(store.get(token(1))).not.toHaveProperty('locKeys');
      await store.flush();
      const written = JSON.parse(await readFile(join(dataDir, APNS_DEVICES_FILENAME), 'utf8')).devices[0];
      expect(written).not.toHaveProperty('locKeys');
      expect(open().get(token(1))).not.toHaveProperty('locKeys');
    },
  );
});

describe('jeden wpis na urządzenie i temat', () => {
  const PHONE = 'a'.repeat(32);
  const PAD = 'b'.repeat(32);
  const RAROG = 'ai.rarog.app';
  const LA = 'cd'.repeat(40);

  const openLogged = (): { store: ApnsDeviceStore; logs: string[] } => {
    const logs: string[] = [];
    const store = createApnsDeviceStore({ dataDir, now: () => clock, logger: (line) => { logs.push(line); } });
    stores.push(store);
    return { store, logs };
  };

  const owned = (
    store: ApnsDeviceStore, n: number, over: { deviceId?: string; topic?: string; environment?: 'development' | 'production' } = {},
  ): void => {
    store.upsert({
      token: token(n), environment: over.environment ?? 'development', label: 'iPhone·Rarog', alerts: true,
      deviceId: over.deviceId ?? PHONE, topic: over.topic ?? RAROG,
    });
  };

  const noTokens = (logs: readonly string[]): void => {
    for (const line of logs) for (const n of [1, 2, 3]) expect(line).not.toContain(token(n).slice(-16));
    for (const line of logs) expect(line).not.toContain(LA.slice(0, 16));
  };

  it('dwa tokeny tego samego `deviceId` i tematu → jeden wpis, linia logu ze środowiskami, bez tokenów', () => {
    const { store, logs } = openLogged();
    owned(store, 1);
    store.setRelayPass(relayPass(1));
    owned(store, 2, { environment: 'production' });
    expect(store.list().map((r) => r.token)).toEqual([token(2)]);
    expect(store.get(token(1))).toBeUndefined();
    expect(store.get(token(2))).not.toHaveProperty('relayPass');
    expect(logs).toEqual(['push: APNs device entry overwritten (development → production)']);
    noTokens(logs);
  });

  it('ponowna rejestracja TEGO SAMEGO tokenu zachowuje przepustkę i blok `liveActivity`, bez linii logu', () => {
    const { store, logs } = openLogged();
    owned(store, 1);
    store.setRelayPass(relayPass(1));
    store.setLiveActivity(token(1), { activityId: 'akt-1', updateToken: LA });
    store.setActivityRelayPass(token(1), 'akt-1', relayPass(1, { token: LA }));
    owned(store, 1);
    expect(store.size).toBe(1);
    expect(store.get(token(1))?.relayPass).toEqual(relayPass(1));
    expect(store.get(token(1))?.liveActivity).toMatchObject({ activityId: 'akt-1', updateToken: LA, relayPass: relayPass(1, { token: LA }) });
    expect(logs).toEqual([]);
  });

  it('inny `deviceId` przy tym samym temacie albo inny temat → wpisy zostają', () => {
    const { store, logs } = openLogged();
    owned(store, 1);
    owned(store, 2, { deviceId: PAD });
    owned(store, 3, { topic: 'pl.useo.rarog' });
    expect(store.size).toBe(3);
    expect(logs).toEqual([]);
  });

  it('zastąpienie przeżywa zapis i ponowny odczyt pliku', async () => {
    const { store } = openLogged();
    owned(store, 1);
    owned(store, 2, { deviceId: PAD });
    owned(store, 3, { environment: 'production' });
    await store.flush();
    const again = open();
    expect(again.list().map((r) => r.token).sort()).toEqual([token(2), token(3)]);
    expect(again.get(token(3))).toMatchObject({ deviceId: PHONE, topic: RAROG, environment: 'production' });
    expect(await readFile(join(dataDir, APNS_DEVICES_FILENAME), 'utf8')).not.toContain(token(1));
  });

  it('rotacja tokenu w tym samym środowisku: blok `liveActivity` z przepustką przechodzi na nowy wpis', async () => {
    const { store, logs } = openLogged();
    owned(store, 1);
    store.setRelayPass(relayPass(1));
    store.setLiveActivity(token(1), { activityId: 'akt-1', updateToken: LA });
    store.setActivityRelayPass(token(1), 'akt-1', relayPass(1, { token: LA }));
    const block = store.get(token(1))?.liveActivity;
    owned(store, 2);
    expect(store.size).toBe(1);
    expect(store.get(token(2))?.liveActivity).toEqual(block);
    // Przepustka URZĄDZENIA była wydana na stary token — nie przechodzi (zamówi się nowa).
    expect(store.get(token(2))).not.toHaveProperty('relayPass');
    expect(logs).toEqual(['push: APNs device entry overwritten (development → development), Live Activity moved']);
    noTokens(logs);
    await store.flush();
    expect(open().get(token(2))?.liveActivity).toEqual(block);
  });

  it('zmiana środowiska: blok `liveActivity` starej instalacji znika razem z wpisem', () => {
    const { store, logs } = openLogged();
    owned(store, 1);
    store.setLiveActivity(token(1), { activityId: 'akt-1', updateToken: LA });
    owned(store, 2, { environment: 'production' });
    expect(store.get(token(2))).not.toHaveProperty('liveActivity');
    expect(store.list().filter((r) => r.liveActivity !== undefined)).toEqual([]);
    expect(logs).toEqual(['push: APNs device entry overwritten (development → production)']);
  });

  it('nowy token z WŁASNYM blokiem aktywności go zachowuje; stary blok nie nadpisuje nowszego', () => {
    const { store } = openLogged();
    owned(store, 2, { deviceId: PAD });
    store.setLiveActivity(token(2), { activityId: 'akt-nowa', updateToken: 'ef'.repeat(40) });
    owned(store, 1);
    store.setLiveActivity(token(1), { activityId: 'akt-stara', updateToken: LA });
    owned(store, 2);
    expect(store.size).toBe(1);
    expect(store.get(token(2))?.liveActivity?.activityId).toBe('akt-nowa');
  });
});
