/**
 * Polityka ładunku i nagłówków. Złote ramki APNs, które produkuje serwer (Live Activity
 * z `shared/fixtures/apns/`, banery formatu 3 z `shared/fixtures/apns-v3/`), to dzisiejsze ładunki: KAŻDA przechodzi
 * politykę `v2`, a zmieniony `aps.alert` w każdej odpada. The policy rejects a banner with the old block next to `aps`
 * on rule `top-level`. Polityka przyjmuje samą plakietkę, tekst
 * zastępczy i dzwonek, odrzuca `loc-args`, jawne v1 (tytuł i treść w `aps.alert`) i obce klucze `aps`.
 */
import { describe, expect, it } from 'vitest';
import {
  ALERT_PLACEHOLDER, ALERT_PLACEHOLDER_KEYS, LIVE_ACTIVITY_CHIME, LIVE_ACTIVITY_CHIME_KEYS,
} from '../src/alert-policy.ts';
import type { PushType } from '../src/identity.ts';
import { APNS_PAYLOAD_MAX_BYTES, checkHeaders, checkPayload } from '../src/policy.ts';

interface Frame {
  readonly headers: Record<string, string>;
  readonly payload: { aps: Record<string, unknown> } & Record<string, unknown>;
}

/** Ramki jednego katalogu z jego manifestem. */
function framesOf(loaded: Record<string, unknown>): { manifest: Record<string, { pushType: PushType }>;
  frames: { name: string; frame: Frame; type: PushType }[]; } {
  const named = new Map(Object.entries(loaded).map(([file, content]) => [file.split('/').pop() ?? file, content]));
  const manifest = named.get('manifest.json') as Record<string, { pushType: PushType }>;
  const frames = [...named].filter(([name]) => name !== 'manifest.json')
    .map(([name, content]) => ({ name, frame: content as Frame, type: manifest[name]?.pushType as PushType }));
  return { manifest, frames };
}

const current = framesOf(import.meta.glob<unknown>('../../shared/fixtures/apns/*.json', { eager: true, import: 'default' }));
/** Banery formatu 3: osobny katalog z własnym manifestem. */
const v3 = framesOf(import.meta.glob<unknown>('../../shared/fixtures/apns-v3/*.json', { eager: true, import: 'default' }));
const manifest = { ...current.manifest, ...v3.manifest };
const frames = [...current.frames, ...v3.frames].sort((a, b) => a.name.localeCompare(b.name));

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Ładunek ramki z podmienionym `aps` (kopia). */
function withAps(frame: Frame, change: (aps: Record<string, unknown>) => void): string {
  const payload = clone(frame.payload);
  change(payload.aps);
  return JSON.stringify(payload);
}

describe('złote ramki APNs serwera wobec polityki', () => {
  it('the frames exist (10: format 3 banners and Live Activity) and each has its manifest type', () => {
    expect(frames.length).toBe(Object.keys(manifest).length);
    expect(frames.length).toBeGreaterThanOrEqual(10);
    for (const { name, type } of frames) expect(['alert', 'liveactivity'], name).toContain(type);
    expect(frames.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'alert.blocking.v3.json', 'alert.device-paired.v3.json', 'alert.done.v3.json', 'alert.test.v3.json',
    ]));
  });

  it.each(frames)('$name: nagłówki i ładunek przechodzą politykę `v2`', ({ frame, type }) => {
    expect(checkHeaders(frame.headers, type)).toBeNull();
    expect(checkPayload(JSON.stringify(frame.payload), type)).toBeNull();
  });

  /** Zmiany `aps.alert`, które muszą odpaść w KAŻDEJ ramce. */
  const mutations: readonly [string, (aps: Record<string, unknown>, type: PushType) => void][] = [
    ['alert jako napis', (aps) => { aps['alert'] = 'Dowolny tekst na ekranie blokady'; }],
    ['dopisany subtitle', (aps, type) => {
      aps['alert'] = { ...(aps['alert'] as object ?? (type === 'alert' ? ALERT_PLACEHOLDER : LIVE_ACTIVITY_CHIME)),
        subtitle: 'dowolny' };
      if (type === 'alert') aps['mutable-content'] = 1;
    }],
    ['klucze z loc-args', (aps, type) => {
      aps['alert'] = type === 'alert'
        ? { ...ALERT_PLACEHOLDER_KEYS, 'loc-args': ['dowolny tekst'] }
        : { title: { 'loc-key': LIVE_ACTIVITY_CHIME_KEYS.title, 'loc-args': ['x'] },
          body: { 'loc-key': LIVE_ACTIVITY_CHIME_KEYS.body }, sound: LIVE_ACTIVITY_CHIME.sound };
      aps['mutable-content'] = type === 'alert' ? 1 : undefined;
    }],
    ['trzy pola z dźwiękiem obcym', (aps) => {
      aps['alert'] = { title: 'Agent skończył', body: 'Coś innego', sound: 'skonczyl.caf' };
    }],
    ['jawny tytuł i treść (baner v1)', (aps) => {
      aps['alert'] = { title: '⏳ Czeka na zgodę · willow', body: 'Edit — zapis' };
    }],
  ];

  for (const [what, mutate] of mutations) {
    it.each(frames)(`$name: ${what} → odrzucone`, ({ frame, type }) => {
      const payload = withAps(frame, (aps) => { mutate(aps, type); });
      expect(checkPayload(payload, type)).not.toBeNull();
    });
  }

  it('dzwonek z innym tekstem odpada, z tekstem kafla — przechodzi', () => {
    const chime = frames.find(({ name }) => name === 'live-activity.update.chime.json');
    if (chime === undefined) throw new Error('brak ramki z dzwonkiem');
    expect(checkPayload(JSON.stringify(chime.frame.payload), 'liveactivity')).toBeNull();
    const changed = withAps(chime.frame, (aps) => { (aps['alert'] as Record<string, string>)['body'] = 'Wynik czeka'; });
    expect(checkPayload(changed, 'liveactivity')).toBe('alert');
  });
});

describe('polityka v2', () => {
  const alertPayload = (aps: Record<string, unknown>): string => JSON.stringify({ aps, rarog: { v: 3, c: 'xyz' } });

  it('sama plakietka', () => {
    expect(checkPayload(alertPayload({ badge: 0 }), 'alert')).toBeNull();
  });

  it('tekst zastępczy: literał i klucze, tylko z mutable-content: 1', () => {
    expect(checkPayload(alertPayload({ alert: ALERT_PLACEHOLDER, 'mutable-content': 1, sound: 'default',
      'thread-id': '3f2a9c1b7e5d4a60', badge: 1 }), 'alert')).toBeNull();
    expect(checkPayload(alertPayload({ alert: ALERT_PLACEHOLDER_KEYS, 'mutable-content': 1 }), 'alert')).toBeNull();
    expect(checkPayload(alertPayload({ alert: ALERT_PLACEHOLDER }), 'alert')).toBe('alert');
    expect(checkPayload(alertPayload({ alert: { ...ALERT_PLACEHOLDER, body: 'Inna treść' }, 'mutable-content': 1 }),
      'alert')).toBe('alert');
  });

  it('odrzuca loc-args, title-loc-args i mieszankę literału z kluczem', () => {
    for (const alert of [
      { ...ALERT_PLACEHOLDER_KEYS, 'loc-args': ['x'] },
      { ...ALERT_PLACEHOLDER_KEYS, 'title-loc-args': ['x'] },
      { title: ALERT_PLACEHOLDER.title, 'loc-key': ALERT_PLACEHOLDER_KEYS['loc-key'] },
      { 'title-loc-key': 'push.other.title', 'loc-key': 'push.placeholder.body' },
    ]) expect(checkPayload(alertPayload({ alert, 'mutable-content': 1 }), 'alert')).toBe('alert');
  });

  it('odrzuca v1 (tytuł i treść jawne), także z `mutable-content: 1`', () => {
    const alert = { title: '⏳ Czeka na zgodę · willow', body: 'Edit — zapis' };
    expect(checkPayload(alertPayload({ alert, sound: 'default' }), 'alert')).toBe('alert');
    expect(checkPayload(alertPayload({ alert, 'mutable-content': 1 }), 'alert')).toBe('alert');
  });

  it('dzwonek kafla: literał i klucze w postaci kafla, wyłącznie przy update', () => {
    const la = (alert: unknown, event = 'update'): string => JSON.stringify({ aps: {
      timestamp: 1, event, 'content-state': { waiting: 0 }, ...(alert === undefined ? {} : { alert }),
    } });
    const keys = { title: { 'loc-key': LIVE_ACTIVITY_CHIME_KEYS.title }, body: { 'loc-key': LIVE_ACTIVITY_CHIME_KEYS.body },
      sound: LIVE_ACTIVITY_CHIME.sound };
    expect(checkPayload(la(undefined), 'liveactivity')).toBeNull();
    expect(checkPayload(la(LIVE_ACTIVITY_CHIME), 'liveactivity')).toBeNull();
    expect(checkPayload(la(keys), 'liveactivity')).toBeNull();
    expect(checkPayload(la({ title: keys.title, body: keys.body }), 'liveactivity')).toBe('alert');
    expect(checkPayload(la(LIVE_ACTIVITY_CHIME, 'end'), 'liveactivity')).toBe('alert');
    expect(checkPayload(la(ALERT_PLACEHOLDER), 'liveactivity')).toBe('alert');
  });

  it.each([
    ['content-available', { 'content-available': 1, badge: 1 }],
    ['category', { category: 'X', badge: 1 }],
    ['interruption-level', { 'interruption-level': 'critical', badge: 1 }],
  ])('obcy klucz aps (%s) → aps-key', (_key, aps) => {
    expect(checkPayload(alertPayload(aps), 'alert')).toBe('aps-key');
  });

  it('klucze najwyższego poziomu: alert {aps, rarog}, liveactivity {aps}', () => {
    expect(checkPayload(JSON.stringify({ aps: { badge: 1 }, extra: 1 }), 'alert')).toBe('top-level');
    expect(checkPayload(JSON.stringify({ rarog: {} }), 'alert')).toBe('top-level');
    expect(checkPayload(JSON.stringify({ aps: { badge: 1 }, rarog: { v: 3, c: 'xyz' } }), 'alert')).toBeNull();
    expect(checkPayload(JSON.stringify({ aps: { badge: 1 } }), 'alert')).toBeNull();
    expect(checkPayload(JSON.stringify({ aps: { timestamp: 1, event: 'update', 'content-state': {} }, rarog: {} }),
      'liveactivity')).toBe('top-level');
  });

  // Zmiana nazwy zamknięta: stary blok banera to obcy klucz najwyższego poziomu.
  it('stary blok banera odpada regułą `top-level` sam i obok nowego; kafel też go nie bierze', () => {
    const OLD_BLOCK = 'pilot'; // stara-nazwa
    expect(checkPayload(JSON.stringify({ aps: { badge: 1 }, [OLD_BLOCK]: { v: 2, c: 'xyz' } }), 'alert'))
      .toBe('top-level');
    expect(checkPayload(JSON.stringify({ aps: { badge: 1 }, [OLD_BLOCK]: { v: 2 }, rarog: { v: 3 } }), 'alert'))
      .toBe('top-level');
    expect(checkPayload(JSON.stringify({ aps: { badge: 1 }, rarog: { v: 3 }, [OLD_BLOCK]: null }), 'alert'))
      .toBe('top-level');
    expect(checkPayload(JSON.stringify({ aps: { timestamp: 1, event: 'update', 'content-state': {} },
      [OLD_BLOCK]: {} }), 'liveactivity')).toBe('top-level');
    // Kontrola: ten sam ładunek z samym blokiem `rarog` przechodzi.
    expect(checkPayload(JSON.stringify({ aps: { badge: 1 }, rarog: { v: 3, c: 'xyz' } }), 'alert')).toBeNull();
  });

  it.each([
    ['badge ujemny', { badge: -1 }],
    ['sound jako słownik (krytyczny)', { sound: { critical: 1, name: 'default' } }],
    ['mutable-content 2', { 'mutable-content': 2 }],
    ['pusty thread-id', { 'thread-id': '' }],
  ])('wartość aps (%s) → aps-value', (_what, aps) => {
    expect(checkPayload(alertPayload(aps), 'alert')).toBe('aps-value');
  });

  it('liveactivity wymaga event update|end, timestamp i content-state', () => {
    for (const aps of [
      { event: 'start', timestamp: 1, 'content-state': {} },
      { event: 'update', 'content-state': {} },
      { event: 'update', timestamp: 1 },
    ]) expect(checkPayload(JSON.stringify({ aps }), 'liveactivity')).toBe('aps-value');
  });
});

describe('rozmiar, JSON i postać kanoniczna', () => {
  /** Ładunek z samą plakietką, dopchany blokiem `rarog` do `bytes` bajtów UTF-8 (znaki dwubajtowe). */
  function sized(bytes: number): string {
    const base = JSON.stringify({ aps: { badge: 1 }, rarog: { c: '' } });
    const room = bytes - new TextEncoder().encode(base).byteLength;
    const fill = 'ż'.repeat(Math.floor(room / 2)) + 'x'.repeat(room % 2);
    return JSON.stringify({ aps: { badge: 1 }, rarog: { c: fill } });
  }

  it('4096 B UTF-8 przechodzi, 4097 B odpada (liczą się bajty, nie znaki)', () => {
    expect(new TextEncoder().encode(sized(APNS_PAYLOAD_MAX_BYTES)).byteLength).toBe(APNS_PAYLOAD_MAX_BYTES);
    expect(sized(APNS_PAYLOAD_MAX_BYTES).length).toBeLessThan(APNS_PAYLOAD_MAX_BYTES);
    expect(checkPayload(sized(APNS_PAYLOAD_MAX_BYTES), 'alert')).toBeNull();
    expect(checkPayload(sized(APNS_PAYLOAD_MAX_BYTES + 1), 'alert')).toBe('payload-size');
  });

  it('nie-JSON i nie-obiekt → payload-json', () => {
    for (const payload of ['', '{', '[]', '"aps"', 'null']) {
      expect(checkPayload(payload, 'alert'), payload).toBe('payload-json');
    }
  });

  it('zdublowany klucz, białe znaki, inna kolejność cyfr → payload-canonical', () => {
    // JSON.parse bierze OSTATNI `alert` (tekst zastępczy), parser Apple mógłby wziąć pierwszy (dowolny tekst).
    const smuggled = '{"aps":{"alert":"Dowolny tekst","alert":{"title":"Rarog","body":"Nowe powiadomienie"},'
      + '"mutable-content":1}}';
    expect(checkPayload(smuggled, 'alert')).toBe('payload-canonical');
    expect(checkPayload('{ "aps": { "badge": 1 } }', 'alert')).toBe('payload-canonical');
    expect(checkPayload('{"aps":{"badge":1.0}}', 'alert')).toBe('payload-canonical');
  });
});

describe('nagłówki', () => {
  const alertHeaders = { 'apns-push-type': 'alert', 'apns-topic': 'ai.rarog.app' };
  const laHeaders = { 'apns-push-type': 'liveactivity', 'apns-topic': 'ai.rarog.app.push-type.liveactivity' };

  it('minimum: typ i temat zgodne z typem przepustki', () => {
    expect(checkHeaders(alertHeaders, 'alert')).toBeNull();
    expect(checkHeaders(laHeaders, 'liveactivity')).toBeNull();
  });

  it('typ pusha inny niż typ przepustki → push-type', () => {
    expect(checkHeaders(laHeaders, 'alert')).toBe('push-type');
    expect(checkHeaders({ ...alertHeaders, 'apns-push-type': 'background' }, 'alert')).toBe('push-type');
    expect(checkHeaders({ 'apns-topic': 'ai.rarog.app' }, 'alert')).toBe('push-type');
  });

  it('temat spoza allow-listy albo bez sufiksu typu → topic', () => {
    expect(checkHeaders({ ...alertHeaders, 'apns-topic': 'pl.useo.rarog' }, 'alert')).toBe('topic');
    expect(checkHeaders({ ...laHeaders, 'apns-topic': 'ai.rarog.app' }, 'liveactivity')).toBe('topic');
    expect(checkHeaders({ ...alertHeaders, 'apns-topic': 'ai.rarog.app.push-type.liveactivity' }, 'alert')).toBe('topic');
    expect(checkHeaders({ 'apns-push-type': 'alert' }, 'alert')).toBe('topic');
  });

  it.each([
    ['authorization', { authorization: 'bearer x' }],
    ['apns-id', { 'apns-id': '123e4567-e89b-12d3-a456-426614174000' }],
    ['Apns-Topic wielkimi', { 'Apns-Topic': 'ai.rarog.app' }],
    ['priorytet 7', { 'apns-priority': '7' }],
    ['collapse-id 65 znaków', { 'apns-collapse-id': 'x'.repeat(65) }],
    ['expiration nie liczba', { 'apns-expiration': 'jutro' }],
  ])('%s → headers', (_what, extra) => {
    expect(checkHeaders({ ...alertHeaders, ...extra }, 'alert')).toBe('headers');
  });

  it('priorytet 1 tylko dla alert', () => {
    expect(checkHeaders({ ...alertHeaders, 'apns-priority': '1' }, 'alert')).toBeNull();
    expect(checkHeaders({ ...laHeaders, 'apns-priority': '1' }, 'liveactivity')).toBe('headers');
  });
});
