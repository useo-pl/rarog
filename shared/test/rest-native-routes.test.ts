/**
 * Kontrakt tras apki natywnej w `@rarog/shared/rest`: ciała tras APNs i Live Activity,
 * odpowiedź statusu tokenu, stan treści Live Activity, nowe pola `GET /api/version` i re-eksport
 * schematów REST terminala.
 *
 * Złote odpowiedzi (`shared/fixtures/rest/`) pokrywają tylko to, co serwer już produkuje. Ten plik
 * trzyma granice ciał wysyłanych PRZEZ KLIENTA (serwer waliduje je tym samym schematem) i stanu
 * Live Activity (v2) — jego granice (zakresy, sufity łańcuchów, relacje pól) trzyma ten
 * plik, a złote ramki producenta mieszkają w `shared/fixtures/apns/`.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as protocol from '../src/protocol.ts';
import {
  APNS_ENVIRONMENTS, APNS_TOKEN_RE, APNS_TOPIC_MISMATCH_ERROR, BUNDLE_ID_RE, LIVE_ACTIVITY_TEXT_MAX, SERVER_SYSTEMS,
  apnsRegisterBodySchema, apnsStatusBodySchema, apnsStatusResponseSchema, apnsUnregisterBodySchema,
  liveActivityContentStateSchema, liveActivityEndBodySchema, liveActivityRegisterBodySchema,
  termHistoryResponseSchema, termListResponseSchema, termOpenBodySchema, termOpenResponseSchema,
  versionResponseSchema,
} from '../src/rest.ts';

/** Token urządzenia z apki: 32 bajty jako hex (tak oddaje `Data` → hex). */
const TOKEN = 'a1b2c3d4'.repeat(8);
const UPDATE_TOKEN = '0f1e2d3c'.repeat(10);
const ACTIVITY_ID = '6F9619FF-8B86-D011-B42D-00C04FC964FF';
const EPOCH = 1_791_331_200;

const ok = (schema: z.ZodType, value: unknown): boolean => schema.safeParse(value).success;

describe('kontrakt tras apki natywnej: re-eksport schematów REST terminala', () => {
  it('`@rarog/shared/rest` oddaje TE SAME obiekty co `protocol.ts` — zero kopii, zero dryfu', () => {
    expect(termOpenBodySchema).toBe(protocol.termOpenBodySchema);
    expect(termOpenResponseSchema).toBe(protocol.termOpenResponseSchema);
    expect(termListResponseSchema).toBe(protocol.termListResponseSchema);
    expect(termHistoryResponseSchema).toBe(protocol.termHistoryResponseSchema);
  });
});

describe('kontrakt tras apki natywnej: ciała tras APNs', () => {
  const register = { token: TOKEN, environment: 'development', label: 'iPad·Rarog', alerts: true };

  it('rejestracja: komplet pól, `test` opcjonalny, oba środowiska APNs', () => {
    expect(apnsRegisterBodySchema.parse(register)).toEqual(register);
    expect(ok(apnsRegisterBodySchema, { ...register, test: true })).toBe(true);
    expect(ok(apnsRegisterBodySchema, { ...register, alerts: false })).toBe(true);
    for (const environment of APNS_ENVIRONMENTS) {
      expect(ok(apnsRegisterBodySchema, { ...register, environment }), environment).toBe(true);
    }
    expect(APNS_ENVIRONMENTS).toEqual(['development', 'production']);
  });

  it('rejestracja: zły token, nieznane środowisko, brak zgody i za długa etykieta to 400', () => {
    for (const bad of [
      { ...register, token: TOKEN.slice(0, 31) },
      { ...register, token: `${TOKEN}zz` },
      { ...register, token: 'a'.repeat(513) },
      { ...register, environment: 'sandbox' },
      { token: TOKEN, environment: 'development', label: 'iPad·Rarog' },
      { ...register, label: 'x'.repeat(protocol.PUSH_LABEL_MAX_CHARS + 1) },
      { ...register, alerts: 'tak' },
    ]) {
      expect(ok(apnsRegisterBodySchema, bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('rejestracja: `topic` (bundle id apki) opcjonalny; spoza reguły bundle id to 400', () => {
    const withTopic = { ...register, topic: 'ai.rarog.app' };
    expect(apnsRegisterBodySchema.parse(withTopic)).toEqual(withTopic);
    expect(apnsRegisterBodySchema.parse({ ...register, topic: 'pl.useo.rarog' }).topic).toBe('pl.useo.rarog');
    for (const topic of ['', 'rarog', 'ai..rarog', '.ai.rarog', 'ai.rarog.', 'ai.rarog app', 'ai/rarog.app', 7]) {
      expect(ok(apnsRegisterBodySchema, { ...register, topic }), String(topic)).toBe(false);
    }
    // Jedna reguła dla `RAROG_APNS_TOPIC` i pola z apki (config.ts importuje ją stąd).
    expect(BUNDLE_ID_RE.test('ai.rarog.app.widgets')).toBe(true);
    expect(APNS_TOPIC_MISMATCH_ERROR).toBe('topic-mismatch');
  });

  it('rejestracja: `pushFormats` opcjonalne, lista liczb całkowitych do 8 pozycji; inne to 400', () => {
    for (const pushFormats of [[1, 2], [], [1, 2, 3, 4, 5, 6, 7, 8]]) {
      const body = { ...register, pushFormats };
      expect(apnsRegisterBodySchema.parse(body), JSON.stringify(pushFormats)).toEqual(body);
    }
    expect(apnsRegisterBodySchema.parse(register)).not.toHaveProperty('pushFormats');
    for (const pushFormats of [[2.5, 2], ['2'], 2, null, [1, 2, 3, 4, 5, 6, 7, 8, 9]]) {
      expect(ok(apnsRegisterBodySchema, { ...register, pushFormats }), JSON.stringify(pushFormats)).toBe(false);
    }
  });

  it('macierz wersji: nowa apka × serwer sprzed `topic` albo `pushFormats` — nieznane pole pominięte, nie 400', () => {
    // Serwer sprzed pola widział ten sam schemat bez `topic`; `z.object` pomija obce klucze bez błędu,
    // więc rejestracja nowej apki przechodzi i zapisuje się bez tematu (powrót do starszego serwera).
    const before = apnsRegisterBodySchema.omit({ topic: true, pushFormats: true });
    expect(before.parse({ ...register, topic: 'ai.rarog.app', pushFormats: [1, 2] })).toEqual(register);
    // Serwer z `topic`, ale bez `pushFormats`: deklaracja formatów przepada, wpis zostaje bez niej (v1, nie 400).
    const beforeE2e = apnsRegisterBodySchema.omit({ pushFormats: true });
    expect(beforeE2e.parse({ ...register, topic: 'ai.rarog.app', pushFormats: [1, 2] }))
      .toEqual({ ...register, topic: 'ai.rarog.app' });
    // Ten sam mechanizm w schemacie dzisiejszym: przyszłe pole od apki też nie przewraca rejestracji.
    expect(apnsRegisterBodySchema.parse({ ...register, topic: 'ai.rarog.app', przyszlePole: 1 }))
      .toEqual({ ...register, topic: 'ai.rarog.app' });
  });

  it('token: hex 32…512 znaków, wielkość liter dowolna (apka może oddać oba zapisy)', () => {
    expect(APNS_TOKEN_RE.test('A'.repeat(32))).toBe(true);
    expect(APNS_TOKEN_RE.test('f'.repeat(512))).toBe(true);
    expect(APNS_TOKEN_RE.test('g'.repeat(64))).toBe(false);
  });

  it('wyrejestrowanie i status: sam token; status odpowiada czterema polami', () => {
    expect(apnsUnregisterBodySchema.parse({ token: TOKEN })).toEqual({ token: TOKEN });
    expect(apnsStatusBodySchema.parse({ token: TOKEN })).toEqual({ token: TOKEN });
    expect(ok(apnsStatusBodySchema, {})).toBe(false);
    const healthy = { enabled: true, registered: true, alerts: true, degradedSince: null };
    expect(apnsStatusResponseSchema.parse(healthy)).toEqual(healthy);
    const degraded = { ...healthy, degradedSince: '2026-10-07T10:00:00.000Z' };
    expect(apnsStatusResponseSchema.parse(degraded)).toEqual(degraded);
    // `degradedSince` jest WARTOŚCIĄ (`null` = zdrowy), nie brakiem pola.
    expect(ok(apnsStatusResponseSchema, { enabled: true, registered: true, alerts: true })).toBe(false);
  });
});

describe('kontrakt tras apki natywnej: ciała tras Live Activity', () => {
  const live = { deviceToken: TOKEN, activityId: ACTIVITY_ID, updateToken: UPDATE_TOKEN };

  it('rejestracja tokenu aktywności: urządzenie, id aktywności i token aktualizacji', () => {
    expect(liveActivityRegisterBodySchema.parse(live)).toEqual(live);
    expect(ok(liveActivityRegisterBodySchema, { ...live, updateToken: 'nie-hex' })).toBe(false);
    expect(ok(liveActivityRegisterBodySchema, { ...live, activityId: '' })).toBe(false);
  });

  it('koniec WYMAGA `activityId` — spóźnione „end" starej aktywności nie zamknie nowej', () => {
    expect(liveActivityEndBodySchema.parse({ deviceToken: TOKEN, activityId: ACTIVITY_ID }))
      .toEqual({ deviceToken: TOKEN, activityId: ACTIVITY_ID });
    expect(ok(liveActivityEndBodySchema, { deviceToken: TOKEN })).toBe(false);
  });
});

describe('kontrakt tras apki natywnej: stan treści Live Activity (`content-state`, v2)', () => {
  const full = {
    waiting: 2,
    working: 1,
    finished: 3,
    top: { sessionId: 'demo-willow', termId: '0123456789abcdef' },
    workflows: [
      {
        sessionId: 'demo-rarog', project: 'rarog', name: 'audyt-ux', agents: 7, done: 3,
        phase: { index: 2, count: 4, title: 'Weryfikacja' }, segments: [100, 60, 0, 0],
      },
      { sessionId: 'demo-atlas', project: 'atlas-web', name: 'review-changes', agents: 3, done: 1, segments: [33] },
    ],
    moreWorkflows: 1,
    limits: { fiveHour: 42, weekly: 81 },
    mac: { cpu: 35, ram: 70, disk: 60 },
    updatedEpoch: EPOCH,
  };
  const [planned, unplanned] = full.workflows;

  it('pełny stan i stan minimalny (same liczniki) przechodzą bez strat', () => {
    expect(liveActivityContentStateSchema.parse(full)).toEqual(full);
    const idle = { waiting: 0, working: 0, finished: 0, updatedEpoch: EPOCH };
    expect(liveActivityContentStateSchema.parse(idle)).toEqual(idle);
    expect(ok(liveActivityContentStateSchema, { waiting: 0, working: 0, updatedEpoch: EPOCH })).toBe(false);
  });

  it('czasy to całkowite sekundy epoki — data ISO i ułamek odpadają (ActivityKit nie zna naszych dat)', () => {
    expect(ok(liveActivityContentStateSchema, { ...full, updatedEpoch: '2026-10-07T10:00:00Z' })).toBe(false);
    expect(ok(liveActivityContentStateSchema, { ...full, updatedEpoch: EPOCH + 0.5 })).toBe(false);
  });

  it('`top` to sam cel tapnięcia: `sessionId` zawsze, `termId` tylko w kształcie id terminala', () => {
    expect(ok(liveActivityContentStateSchema, { ...full, top: { termId: '0123456789abcdef' } })).toBe(false);
    expect(ok(liveActivityContentStateSchema, { ...full, top: { sessionId: 's' } })).toBe(true);
    expect(ok(liveActivityContentStateSchema, { ...full, top: { sessionId: 's', termId: '../x' } })).toBe(false);
  });

  it('przebiegi: 1–2 na kaflu, segment na fazę planu, `done ≤ agents`, faza w zakresie, łańcuchy do 60 znaków', () => {
    const at = (workflows: unknown[]): boolean => ok(liveActivityContentStateSchema, { ...full, workflows });
    expect(at([])).toBe(false);
    expect(at([planned, unplanned, unplanned])).toBe(false);
    expect(at([{ ...planned, segments: [100, 60, 0] }])).toBe(false);
    expect(at([{ ...unplanned, done: 4 }])).toBe(false);
    expect(at([{ ...planned, phase: { index: 5, count: 4, title: 'x' } }])).toBe(false);
    expect(at([{ ...unplanned, segments: [101] }])).toBe(false);
    expect(at([{ ...unplanned, segments: Array.from({ length: 13 }, () => 0) }])).toBe(false);
    expect(at([{ ...unplanned, name: 'x'.repeat(LIVE_ACTIVITY_TEXT_MAX) }])).toBe(true);
    expect(at([{ ...unplanned, name: 'x'.repeat(LIVE_ACTIVITY_TEXT_MAX + 1) }])).toBe(false);
    expect(at([{ ...unplanned, project: '' }])).toBe(false);
    expect(ok(liveActivityContentStateSchema, { ...full, moreWorkflows: 0 })).toBe(false);
  });

  it('`states`: tylko przy `phase`, tyle co `segments`, wartości `pending` | `running` | `done`', () => {
    const at = (workflows: unknown[]): boolean => ok(liveActivityContentStateSchema, { ...full, workflows });
    const states = ['done', 'running', 'pending', 'pending'];
    expect(at([{ ...planned, states }])).toBe(true);
    expect(liveActivityContentStateSchema.parse({ ...full, workflows: [{ ...planned, states }] }).workflows?.[0])
      .toEqual({ ...planned, states });
    expect(at([{ ...unplanned, states: ['running'] }])).toBe(false);
    expect(at([{ ...planned, states: ['done', 'running', 'pending'] }])).toBe(false);
    expect(at([{ ...planned, states: [...states, 'pending'] }])).toBe(false);
    expect(at([{ ...planned, states: ['done', 'failed', 'pending', 'pending'] }])).toBe(false);
    expect(at([{ ...planned, states: null }])).toBe(false);
  });

  it('procenty limitów i Maca to całości 0–100', () => {
    expect(ok(liveActivityContentStateSchema, { ...full, limits: { fiveHour: 101 } })).toBe(false);
    expect(ok(liveActivityContentStateSchema, { ...full, limits: { weekly: 12.5 } })).toBe(false);
    expect(ok(liveActivityContentStateSchema, { ...full, mac: { cpu: -5 } })).toBe(false);
    expect(ok(liveActivityContentStateSchema, { ...full, limits: {}, mac: {} })).toBe(true);
  });

  it('prywatność ekranu blokady: w kształcie nie ma ŻADNEGO pola na treść, komendę, narzędzie ani etykietę', () => {
    const keys = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node === null || typeof node !== 'object') return;
      const { properties } = node as { properties?: Record<string, unknown> };
      if (properties !== undefined) Object.keys(properties).forEach((key) => keys.add(key));
      Object.values(node).forEach(walk);
    };
    walk(z.toJSONSchema(liveActivityContentStateSchema));
    expect(keys.has('sessionId') && keys.has('updatedEpoch')).toBe(true);
    const forbidden = [
      'text', 'summary', 'lastSummary', 'displayText', 'command', 'question', 'tool', 'label', 'description', 'subject',
    ];
    for (const key of forbidden) expect(keys.has(key), key).toBe(false);
  });
});

describe('kontrakt tras apki natywnej: nowe flagi `GET /api/version`', () => {
  const base = {
    version: '0.1.0', protocolVersion: 3, serverStartId: 's', voiceEnabled: true, termEnabled: true,
    tailnet: null, hookSeenAgo: null, notesEnabled: true, companionEnabled: false, companionSpeech: false,
    capabilities: [], system: 'linux', iroh: null,
  };

  it('`apnsEnabled` jest zawsze obecne', () => {
    const version = { ...base, apnsEnabled: true };
    expect(versionResponseSchema.parse(version)).toEqual(version);
    expect(versionResponseSchema.parse({ ...base, apnsEnabled: false })).toEqual({ ...base, apnsEnabled: false });
    expect(ok(versionResponseSchema, base)).toBe(false);
  });

  it('`capabilities` jest zawsze obecne: lista łańcuchów, także pusta', () => {
    const version = { ...base, apnsEnabled: false, capabilities: ['przyklad-a', 'przyklad-b'] };
    expect(versionResponseSchema.parse(version)).toEqual(version);
    const { capabilities: _pominiete, ...bezPola } = { ...base, apnsEnabled: false };
    expect(ok(versionResponseSchema, bezPola)).toBe(false);
    expect(ok(versionResponseSchema, { ...bezPola, capabilities: null })).toBe(false);
    expect(ok(versionResponseSchema, { ...bezPola, capabilities: [1] })).toBe(false);
  });

  it('`iroh` jest zawsze obecne: `null` (serwer bez nasłuchu iroh) albo EndpointId z relayem', () => {
    const iroh = { endpointId: 'a'.repeat(64), relay: 'https://relay.example.com/' };
    const withIroh = { ...base, apnsEnabled: false, iroh };
    expect(versionResponseSchema.parse(withIroh)).toEqual(withIroh);
    const { iroh: _pominiete, ...bezPola } = { ...base, apnsEnabled: false };
    expect(ok(versionResponseSchema, bezPola)).toBe(false);
    expect(ok(versionResponseSchema, { ...bezPola, iroh: { endpointId: iroh.endpointId } })).toBe(false);
  });

  it('`system` jest zawsze obecne i tylko z listy `SERVER_SYSTEMS`', () => {
    for (const system of SERVER_SYSTEMS) {
      const version = { ...base, apnsEnabled: false, system };
      expect(versionResponseSchema.parse(version)).toEqual(version);
    }
    const { system: _pominiete, ...bezPola } = { ...base, apnsEnabled: false };
    expect(ok(versionResponseSchema, bezPola)).toBe(false);
    for (const bad of [null, 'darwin', 'freebsd', 'unsupported', 1]) {
      expect(ok(versionResponseSchema, { ...bezPola, system: bad }), String(bad)).toBe(false);
    }
  });
});
