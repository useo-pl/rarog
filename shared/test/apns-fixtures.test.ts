/**
 * Złote ramki APNs, strona KLIENTA: pliki `shared/fixtures/apns/` (Live Activity) i `shared/fixtures/apns-v3/`
 * (banery) → kontrakt.
 *
 * Każdy plik to PEŁNA ramka wysyłana do APNs: `headers` (nagłówki HTTP/2 bez `:path` z tokenem)
 * i `payload` (ciało JSON). Pliki produkuje kod serwera (`server/test/apns-fixtures-producenci
 * .test.ts`, odświeżenie `RAROG_FIXTURES_WRITE=1`); ten plik NIE importuje niczego z `server/` —
 * to lustro dla klienta w innym języku (Swift: `ApnsFramesTests` w `RarogContract`).
 *
 * Kształt ramki opisują schematy w TYM pliku, a nie w `@rarog/shared/rest`: kontrakt treści
 * (`liveActivityContentStateSchema`) mieszka tam, a reszta ramki to format Apple (`aps.timestamp`,
 * `event`, `stale-date`, `dismissal-date`, `alert`), który apka czyta przez ActivityKit
 * i `UNUserNotificationCenter`, nie własnym dekoderem. Jedyny `alert` w ramce kafla to dźwięk
 * „skończył”: stałe teksty, dosłownie zdublowane niżej, tylko przy `update`.
 *
 * Banery: baner ma jeden format, 3, i ŚCISŁY schemat — blok `rarog`
 * dokładnie `{v: 3, kid, n, c}`, `aps` z tekstem zastępczym i `mutable-content: 1` albo sama plakietka — a lustro
 * `node:crypto` (klucz TESTOWY 32×`0x05`) odszyfrowuje treść: alert ⇔ rodzaj inny niż `done`, `thread-id` =
 * `topicFor(sessionId)` z tekstu jawnego, `exp` = `apns-expiration`. The `apns/` directory holds Live Activity frames
 * only. No code produces a format 2 banner (block under the old key `LEGACY_BLOCK`, `v: 2`): the test builds one from
 * the format 3 frame and checks that the format 3 contract rejects it.
 *
 * Klucze lokalizacji: wpis z deklaracją `locKeys` dostaje tekst zastępczy banera i dzwonek kafla jako klucze
 * katalogu apki. Ramki takich wpisów mają w manifeście `"locKeys": true` (`alert.blocking.loc-keys.v3.json`,
 * `live-activity.update.chime.loc-keys.json`); klucze są dosłownie te z polityki przekaźnika
 * (`shared/fixtures/relay/alert-policy.json`), a reszta ramki jest jak w ramce z literałem.
 */
import { createDecipheriv, createHash, hkdfSync } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RELAY_ALERT_PLACEHOLDER } from '../src/relay.ts';
import { liveActivityContentStateSchema } from '../src/rest.ts';
import { sentenceRefSchema } from '../src/sentences/index.ts';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/apns');
/** Format 3 banners in their own directory with their own manifest (`apns/` holds Live Activity frames only). */
const DIR_V3 = path.resolve(DIR, '../apns-v3');
/** Wektory szyfrowania banera formatu 3 (`notify-push-crypto.test.ts`): ich teksty jawne to ten sam kontrakt. */
const PUSH_VECTORS_V3 = path.resolve(DIR, '../push-crypto/vectors.v3.json');
/** Polityka ładunku przekaźnika: klucze tekstu zastępczego i dzwonka (`placeholderKeys`, `chimeKeys`). */
const RELAY_POLICY = path.resolve(DIR, '../relay/alert-policy.json');
const MANIFEST = 'manifest.json';
const BUNDLE = 'ai.rarog.app';
const MAX_PAYLOAD_BYTES = 4096;

const manifestSchema = z.record(z.string(), z.strictObject({
  pushType: z.enum(['alert', 'liveactivity']),
  event: z.enum(['update', 'end']).optional(),
  /** Ramka wpisu z deklaracją `locKeys`: tekst zastępczy i dzwonek kluczami katalogu apki. */
  locKeys: z.literal(true).optional(),
}));

const intString = z.string().regex(/^\d+$/);

/**
 * Dźwięk „skończył” z kafla — DOSŁOWNA kopia `LIVE_ACTIVITY_CHIME`
 * z `server/src/notify/apns-payload.ts` (ten plik nie importuje z `server/`). Kafel nie niesie treści:
 * inny tekst niż ten to błąd kontraktu, nie wariant.
 */
const CHIME_ALERT = { title: 'Agent skończył', body: 'Wynik czeka w Rarogu', sound: 'skonczyl.caf' } as const;
/** Sekundy od chwili zlecenia do `apns-expiration` ramki z dźwiękiem (`LIVE_ACTIVITY_CHIME_TTL_MS` / 1000). */
const CHIME_TTL_SECONDS = 30;
const chimeAlertSchema = z.strictObject({
  title: z.literal(CHIME_ALERT.title),
  body: z.literal(CHIME_ALERT.body),
  sound: z.literal(CHIME_ALERT.sound),
});
/** Ten sam dzwonek kluczami katalogu apki (wpis z `locKeys`) w postaci zagnieżdżonej kafla, ten sam dźwięk. */
const CHIME_KEYS_ALERT = {
  title: { 'loc-key': 'push.chime.title' }, body: { 'loc-key': 'push.chime.body' }, sound: CHIME_ALERT.sound,
} as const;
const chimeKeysAlertSchema = z.strictObject({
  title: z.strictObject({ 'loc-key': z.literal(CHIME_KEYS_ALERT.title['loc-key']) }),
  body: z.strictObject({ 'loc-key': z.literal(CHIME_KEYS_ALERT.body['loc-key']) }),
  sound: z.literal(CHIME_ALERT.sound),
});

const liveActivityFrameSchema = z.strictObject({
  headers: z.strictObject({
    'apns-expiration': intString,
    'apns-priority': z.enum(['5', '10']),
    'apns-push-type': z.literal('liveactivity'),
    'apns-topic': z.literal(`${BUNDLE}.push-type.liveactivity`),
  }),
  payload: z.strictObject({
    aps: z.union([
      z.strictObject({
        timestamp: z.number().int(), event: z.literal('update'),
        'content-state': liveActivityContentStateSchema,
        // Wyłącznie dźwięk „skończył” (literał albo klucze); przy `end` klucza nie ma (ścisły schemat niżej).
        alert: z.union([chimeAlertSchema, chimeKeysAlertSchema]).optional(),
        'stale-date': z.number().int(),
      }),
      z.strictObject({
        timestamp: z.number().int(), event: z.literal('end'),
        'content-state': liveActivityContentStateSchema, 'dismissal-date': z.number().int(),
      }),
    ]),
  }),
});

const alertHeadersSchema = z.strictObject({
  'apns-collapse-id': z.string().min(1).max(64),
  'apns-expiration': intString,
  'apns-priority': z.enum(['5', '10']),
  'apns-push-type': z.literal('alert'),
  'apns-topic': z.literal(BUNDLE),
});

/** Tekst zastępczy — `aps.alert` banera; inny tekst polityka `v2` przekaźnika odrzuca. */
const placeholderAlertSchema = z.strictObject({
  title: z.literal(RELAY_ALERT_PLACEHOLDER.title), body: z.literal(RELAY_ALERT_PLACEHOLDER.body),
});
/** Tekst zastępczy kluczami katalogu apki (wpis z `locKeys`), bez `loc-args` — jak w polityce przekaźnika. */
const PLACEHOLDER_KEYS = { 'title-loc-key': 'push.placeholder.title', 'loc-key': 'push.placeholder.body' } as const;
const placeholderKeysAlertSchema = z.strictObject({
  'title-loc-key': z.literal(PLACEHOLDER_KEYS['title-loc-key']), 'loc-key': z.literal(PLACEHOLDER_KEYS['loc-key']),
});
/** „Skończył": sama plakietka — bez treści, dźwięku, wątku i `mutable-content`. */
const badgeOnlyApsSchema = z.strictObject({ badge: z.number().int().nonnegative() });

/** Pola `aps` banera obok tekstu zastępczego (literał albo klucze). */
const alertApsShape = {
  'mutable-content': z.literal(1),
  sound: z.literal('default'),
  badge: z.number().int().nonnegative().optional(),
  'thread-id': z.string().min(1).optional(),
};

/**
 * `aps` banera: dosłownie w kształcie polityki `v2` przekaźnika — tekst zastępczy literałem albo (wpis
 * z `locKeys`) kluczami — albo sama plakietka.
 */
const bannerApsSchema = z.union([
  z.strictObject({ alert: placeholderAlertSchema, ...alertApsShape }),
  z.strictObject({ alert: placeholderKeysAlertSchema, ...alertApsShape }),
  badgeOnlyApsSchema,
]);

/** Ramka banera formatu 3: `aps` banera i JEDEN blok `rarog` dokładnie `{v: 3, kid, n, c}`. */
const alertV3FrameSchema = z.strictObject({
  headers: alertHeadersSchema,
  payload: z.strictObject({
    aps: bannerApsSchema,
    rarog: z.strictObject({
      v: z.literal(3),
      kid: z.string().regex(/^[0-9a-f]{8}$/),
      n: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
      c: z.string().regex(/^[A-Za-z0-9_-]{22,}$/),
    }),
  }),
});

/**
 * Tekst jawny banera po odszyfrowaniu (`kind` to napis; nieznany rodzaj apka czyta jako brak). `titleRef` i `bodyRef`
 * to kod zdania obok `title` i `body`; uszkodzony `ref` odrzuca tekst jawny jak w każdym innym kanale.
 */
const plaintextSchema = z.strictObject({
  kind: z.string().min(1),
  title: z.string().optional(),
  titleRef: sentenceRefSchema.optional(),
  body: z.string().optional(),
  bodyRef: sentenceRefSchema.optional(),
  sessionId: z.string().min(1).optional(),
  termId: z.string().regex(/^[0-9a-f]{16}$/).optional(),
  exp: z.number().int(),
});

/** Klucz push TESTOWY ramek banerów (producent: `server/test/apns-fixtures-producenci.test.ts`). */
const TEST_PUSH_KEY = Buffer.alloc(32, 5);

/**
 * Lustro odbiorcy formatu 3: HKDF-SHA256 (sól pusta, `info` `rarog-push-banner-v1`) + ChaCha20-Poly1305 z AAD
 * `rarog-push/3|<kid>`.
 */
function openV3(rarog: { kid: string; n: string; c: string }): string {
  const key = Buffer.from(hkdfSync('sha256', TEST_PUSH_KEY, Buffer.alloc(0), Buffer.from('rarog-push-banner-v1'), 32));
  const sealed = Buffer.from(rarog.c, 'base64url');
  const body = sealed.subarray(0, sealed.length - 16);
  const decipher = createDecipheriv('chacha20-poly1305', key, Buffer.from(rarog.n, 'base64url'), { authTagLength: 16 });
  decipher.setAAD(Buffer.from(`rarog-push/3|${rarog.kid}`), { plaintextLength: body.length });
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

/** `topicFor` serwera (`content.ts`) — lustro: 32 znaki base64url `sha256(sessionId)`. */
const topicFor = (sessionId: string): string =>
  createHash('sha256').update(sessionId).digest('base64url').slice(0, 32);

const manifest = manifestSchema.parse(JSON.parse(readFileSync(path.join(DIR, MANIFEST), 'utf8')));
const read = (name: string): unknown => JSON.parse(readFileSync(path.join(DIR, name), 'utf8'));

/** Block key of the format 2 banner, which no code produces any more: a rejection case. */
const LEGACY_BLOCK = 'pilot'; // stara-nazwa
/** Format 3 banners without the localization-key variant: one per kind. */
const BANNERS_V3 = [
  'alert.blocking.v3.json', 'alert.device-paired.v3.json', 'alert.done.v3.json', 'alert.stalled.v3.json',
  'alert.test.v3.json', 'alert.version-changed.v3.json', 'alert.weekly-limit.v3.json',
];
/** Rodzaje bez sesji: tekst jawny bez `sessionId` i ramka bez `thread-id`. */
const SESSIONLESS_KINDS = ['test', 'device-paired', 'version-changed', 'weekly-limit'];
const liveNames = Object.keys(manifest).filter((n) => manifest[n]?.pushType === 'liveactivity').sort();

/** Wszystkie klucze obiektu w głąb — do strażnika prywatności. */
function keysDeep(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const item of value) keysDeep(item, into);
  else if (typeof value === 'object' && value !== null) {
    for (const [key, inner] of Object.entries(value)) {
      into.add(key);
      keysDeep(inner, into);
    }
  }
  return into;
}

describe('złote ramki APNs: pliki → kontrakt', () => {
  it('manifest ↔ katalog w obie strony', () => {
    const files = readdirSync(DIR).filter((f) => f !== MANIFEST).sort();
    expect(files).toEqual(Object.keys(manifest).sort());
  });

  it.each(liveNames)('%s: ramka w kontrakcie, ładunek ≤ 4 kB', (name) => {
    const frame = read(name);
    const entry = manifest[name];
    // Ścisłe schematy: klucz spoza kontraktu to błąd, nie cicho odcięte pole.
    expect(liveActivityFrameSchema.parse(frame)).toEqual(frame);
    const payload = (frame as { payload: unknown }).payload;
    expect(Buffer.byteLength(JSON.stringify(payload), 'utf8')).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    if (entry?.event !== undefined) {
      expect((payload as { aps: { event: string } }).aps.event).toBe(entry.event);
    }
  });

  it('Live Activity: `stale-date` = +15 min, `dismissal-date` = teraz, `updatedEpoch` = `timestamp`', () => {
    for (const name of liveNames) {
      const { aps } = liveActivityFrameSchema.parse(read(name)).payload;
      expect(aps['content-state'].updatedEpoch).toBe(aps.timestamp);
      if (aps.event === 'update') expect(aps['stale-date']).toBe(aps.timestamp + 900);
      else expect(aps['dismissal-date']).toBe(aps.timestamp);
    }
  });

  it('warianty: Codex prowadzi do terminala, dwa przebiegi i „+1", komplet limitów i Maca, koniec to „nic nie czeka"', () => {
    const state = (name: string): z.infer<typeof liveActivityContentStateSchema> =>
      liveActivityFrameSchema.parse(read(name)).payload.aps['content-state'];
    expect(state('live-activity.update.codex.json').top?.termId).toMatch(/^[0-9a-f]{16}$/);
    const workflow = state('live-activity.update.workflow.json');
    expect(workflow.workflows?.[0]?.phase).toMatchObject({ index: 2, count: 3 });
    expect(workflow.workflows?.[1]?.phase).toBeUndefined();
    // Stan faz tylko przy planie: pierwsza faza 2/2, druga 1/2, trzecia bez agentów.
    expect(workflow.workflows?.[0]?.states).toEqual(['done', 'running', 'pending']);
    expect(workflow.workflows?.[1]?.name).toBe('review-changes');
    expect(Object.keys(workflow.workflows?.[1] ?? {})).not.toContain('states');
    expect(workflow.moreWorkflows).toBe(1);
    // Sesja po turze z przebiegiem w locie „pracuje w tle" — praca, nie wynik do odebrania.
    expect(workflow).toMatchObject({ working: 2, finished: 0 });
    // Ramka z kompletem pól spoza listy sesji — Swift musi je znać (strażnik w `ApnsFramesTests`).
    const full = state('live-activity.update.json');
    expect(Object.keys(full.limits ?? {}).sort()).toEqual(['fiveHour', 'weekly']);
    expect(Object.keys(full.mac ?? {}).sort()).toEqual(['cpu', 'disk', 'ram']);
    expect(state('live-activity.end.json')).toMatchObject({ waiting: 0, working: 0 });
    expect(state('live-activity.end.json').top).toBeUndefined();
  });

  /*
   * Subagent w postoju pracą nie jest. Cztery sesje po turze: sam czekający subagent z wynikiem
   * nieodebranym → „skończyły"; ten sam z wynikiem odebranym → nic; czekający obok komendy i subagent
   * pracujący → „pracuje". Sesja po turze nie jest celem tapnięcia.
   * Two sessions after a turn with a subagent stuck on its own command (one next to a live command) → waiting, each
   * once, and no tap target.
   */
  it('subagent w postoju nie liczy się do „pracuje"; z nieodebranym wynikiem liczy się do „skończyły"; `stuck` → waiting', () => {
    const { aps } = liveActivityFrameSchema.parse(read('live-activity.update.waiting-agent.json')).payload;
    expect(aps['content-state']).toEqual({ waiting: 2, working: 2, finished: 1, updatedEpoch: aps.timestamp });
  });

  it('prywatność ekranu blokady: ramka Live Activity nie ma kluczy na treść', () => {
    for (const name of liveNames) {
      const keys = keysDeep(read(name));
      for (const banned of ['text', 'summary', 'lastSummary', 'displayText', 'command', 'tool', 'label', 'description']) {
        expect(keys.has(banned), `${name}: ${banned}`).toBe(false);
      }
    }
  });

  /** Ramki z dźwiękiem: literał i wariant kluczy (`locKeys`) — z oczekiwanym alertem. */
  const CHIME_FRAMES = {
    'live-activity.update.chime.json': CHIME_ALERT,
    'live-activity.update.chime.loc-keys.json': CHIME_KEYS_ALERT,
  } as const;

  it('dźwięk „skończył”: alert = stała (literał albo klucze przy `locKeys`), priorytet 10, wygaśnięcie 30 s; reszta ramek kafla bez alertu', () => {
    for (const [name, expected] of Object.entries(CHIME_FRAMES)) {
      const chime = liveActivityFrameSchema.parse(read(name));
      const { aps } = chime.payload;
      expect(aps.event, name).toBe('update');
      expect(aps.event === 'update' ? aps.alert : undefined, name).toEqual(expected);
      expect(chime.headers['apns-priority'], name).toBe('10');
      expect(chime.headers['apns-expiration'], name).toBe(String(aps.timestamp + CHIME_TTL_SECONDS));
      expect(manifest[name]?.locKeys === true, name).toBe(expected === CHIME_KEYS_ALERT);
    }
    const others = Object.keys(manifest)
      .filter((n) => manifest[n]?.pushType === 'liveactivity' && !(n in CHIME_FRAMES));
    expect(others.length).toBeGreaterThan(0);
    for (const name of others) expect(keysDeep(read(name)).has('alert'), name).toBe(false);
  });

  it('dźwięk „skończył”: inny tekst, dodatkowy klucz alertu albo alert przy `end` — ramka odrzucona', () => {
    const chime = read('live-activity.update.chime.json') as {
      headers: Record<string, string>; payload: { aps: Record<string, unknown> };
    };
    const withAps = (aps: Record<string, unknown>): unknown => ({ ...chime, payload: { aps } });
    const { aps } = chime.payload;
    expect(liveActivityFrameSchema.safeParse(withAps(aps)).success).toBe(true);
    for (const alert of [
      { ...CHIME_ALERT, title: 'rarog · Testy zielone' },
      { ...CHIME_ALERT, body: 'Wdrożyłem klucz produkcyjny' },
      { ...CHIME_ALERT, sound: 'default' },
      { ...CHIME_ALERT, subtitle: 'rarog' },
      { title: CHIME_ALERT.title, body: CHIME_ALERT.body },
    ]) {
      expect(liveActivityFrameSchema.safeParse(withAps({ ...aps, alert })).success, JSON.stringify(alert)).toBe(false);
    }
    const end = read('live-activity.end.json') as { headers: Record<string, string>; payload: { aps: Record<string, unknown> } };
    expect(liveActivityFrameSchema.safeParse(
      { ...end, payload: { aps: { ...end.payload.aps, alert: { ...CHIME_ALERT } } } },
    ).success).toBe(false);
    expect(liveActivityFrameSchema.safeParse(
      { ...end, payload: { aps: { ...end.payload.aps, alert: CHIME_KEYS_ALERT } } },
    ).success).toBe(false);
  });

  it('dzwonek kluczami: `loc-args`, inny klucz, brak dźwięku albo mieszanka z literałem — ramka odrzucona', () => {
    const chime = read('live-activity.update.chime.loc-keys.json') as {
      headers: Record<string, string>; payload: { aps: Record<string, unknown> };
    };
    const withAlert = (alert: unknown): boolean =>
      liveActivityFrameSchema.safeParse({ ...chime, payload: { aps: { ...chime.payload.aps, alert } } }).success;
    expect(withAlert(CHIME_KEYS_ALERT)).toBe(true);
    for (const alert of [
      { ...CHIME_KEYS_ALERT, title: { ...CHIME_KEYS_ALERT.title, 'loc-args': ['rarog'] } },
      { ...CHIME_KEYS_ALERT, body: { 'loc-key': 'push.placeholder.body' } },
      { title: CHIME_KEYS_ALERT.title, body: CHIME_KEYS_ALERT.body },
      { ...CHIME_KEYS_ALERT, title: CHIME_ALERT.title },
      { ...CHIME_KEYS_ALERT, sound: 'default' },
    ]) {
      expect(withAlert(alert), JSON.stringify(alert)).toBe(false);
    }
  });

  it('klucze tekstu zastępczego i dzwonka = klucze polityki przekaźnika', () => {
    const policy = JSON.parse(readFileSync(RELAY_POLICY, 'utf8')) as {
      alert: { placeholderKeys: unknown }; liveactivity: { chime: unknown; chimeKeys: unknown };
    };
    expect(PLACEHOLDER_KEYS).toEqual(policy.alert.placeholderKeys);
    expect({ title: CHIME_KEYS_ALERT.title['loc-key'], body: CHIME_KEYS_ALERT.body['loc-key'] })
      .toEqual(policy.liveactivity.chimeKeys);
    expect(CHIME_ALERT).toEqual(policy.liveactivity.chime);
  });

  /*
   * Mirror of `rejectsFormat2` in `ApnsFramesTests`: a format 2 banner has the banner `aps` and one block next to it
   * under the old key, with `v: 2`, so the format 3 contract rejects it. The test builds the frame from the format 3
   * frame of the same kind; the refusal `koperta-formatu-2` of the `push-crypto` vectors rejects the format 2
   * ciphertext.
   */
  it('`apns/` holds Live Activity frames only', () => {
    expect(Object.keys(manifest).filter((n) => manifest[n]?.pushType !== 'liveactivity')).toEqual([]);
  });

  it.each(BANNERS_V3)('%s moved to format 2: the format 3 contract rejects the frame', (name) => {
    const frame = JSON.parse(readFileSync(path.join(DIR_V3, name), 'utf8')) as {
      headers: unknown; payload: { aps: unknown; rarog: Record<string, unknown> };
    };
    const legacy = { ...frame, payload: { aps: frame.payload.aps, [LEGACY_BLOCK]: { ...frame.payload.rarog, v: 2 } } };
    expect(alertHeadersSchema.parse(legacy.headers)).toEqual(legacy.headers);
    expect(bannerApsSchema.safeParse(legacy.payload.aps).success).toBe(true);
    expect(alertV3FrameSchema.safeParse(legacy).success).toBe(false);
    // Control: the same block under `rarog` with `v: 3` passes.
    expect(alertV3FrameSchema.safeParse(frame).success).toBe(true);
  });
});

describe('złote ramki APNs formatu 3: pliki `apns-v3/` → kontrakt', () => {
  const manifestV3 = manifestSchema.parse(JSON.parse(readFileSync(path.join(DIR_V3, MANIFEST), 'utf8')));
  const readV3 = (name: string): unknown => JSON.parse(readFileSync(path.join(DIR_V3, name), 'utf8'));
  const names = Object.keys(manifestV3).sort();

  it('manifest ↔ directory both ways; `*.v3.json` banners only: one per kind and the `locKeys` variants', () => {
    expect(readdirSync(DIR_V3).filter((f) => f !== MANIFEST).sort()).toEqual(names);
    for (const name of names) {
      expect(manifestV3[name]?.pushType).toBe('alert');
      expect(name).toMatch(/\.v3\.json$/);
    }
    const keyed = names.filter((name) => manifestV3[name]?.locKeys === true);
    expect(names.filter((name) => !keyed.includes(name)))
      .toEqual(BANNERS_V3);
    // Wariant kluczy ma ramkę bazową tych samych wejść: tę samą nazwę bez `.loc-keys`.
    expect(keyed).toEqual(['alert.blocking.loc-keys.v3.json']);
    for (const name of keyed) expect(names, name).toContain(name.replace('.loc-keys', ''));
  });

  it('wariant `locKeys`: `aps.alert` = klucze, a reszta ramki i szyfrogram jak w ramce bazowej', () => {
    const keyed = alertV3FrameSchema.parse(readV3('alert.blocking.loc-keys.v3.json'));
    const base = alertV3FrameSchema.parse(readV3('alert.blocking.v3.json'));
    expect('alert' in keyed.payload.aps ? keyed.payload.aps.alert : undefined).toEqual(PLACEHOLDER_KEYS);
    expect({ ...keyed.payload, aps: { ...keyed.payload.aps, alert: RELAY_ALERT_PLACEHOLDER } }).toEqual(base.payload);
    expect(keyed.headers).toEqual(base.headers);
    expect(openV3(keyed.payload.rarog)).toBe(openV3(base.payload.rarog));
    const variant = (alert: unknown): boolean =>
      alertV3FrameSchema.safeParse({ ...keyed, payload: { ...keyed.payload, aps: { ...keyed.payload.aps, alert } } }).success;
    for (const alert of [
      { ...PLACEHOLDER_KEYS, 'loc-args': ['x'] },
      { ...PLACEHOLDER_KEYS, 'title-loc-args': ['x'] },
      { 'title-loc-key': 'push.chime.title', 'loc-key': PLACEHOLDER_KEYS['loc-key'] },
      { title: RELAY_ALERT_PLACEHOLDER.title, 'loc-key': PLACEHOLDER_KEYS['loc-key'] },
    ]) {
      expect(variant(alert), JSON.stringify(alert)).toBe(false);
    }
  });

  it.each(names)('%s: ramka w kontrakcie, ładunek ≤ 4 kB, odszyfrowany tekst zgodny z jawną częścią', (name) => {
    const raw = readV3(name);
    const frame = alertV3FrameSchema.parse(raw);
    expect(frame).toEqual(raw);
    expect(Buffer.byteLength(JSON.stringify(frame.payload), 'utf8')).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    const opened = openV3(frame.payload.rarog);
    expect(Buffer.byteLength(opened) % 256).toBe(0);
    const plain = plaintextSchema.parse(JSON.parse(opened));
    const { aps } = frame.payload;
    const hasAlert = 'alert' in aps;
    expect(hasAlert, name).toBe(plain.kind !== 'done');
    // Tekst zastępczy kluczami ⇔ ramka wpisu z deklaracją `locKeys`.
    if (hasAlert) {
      expect(aps.alert, name).toEqual(manifestV3[name]?.locKeys === true ? PLACEHOLDER_KEYS : RELAY_ALERT_PLACEHOLDER);
    }
    expect(plain.title !== undefined && plain.body !== undefined, name).toBe(hasAlert);
    expect(plain.exp).toBe(Number(frame.headers['apns-expiration']));
    const thread = hasAlert ? aps['thread-id'] : undefined;
    expect(thread).toBe(plain.sessionId === undefined || !hasAlert ? undefined : topicFor(plain.sessionId));
    expect(plain.sessionId === undefined, name).toBe(SESSIONLESS_KINDS.includes(plain.kind));
    // Jawna część nie niesie treści ani surowego `sessionId`.
    for (const secret of [plain.title, plain.body, plain.sessionId, plain.termId]) {
      if (secret !== undefined && secret !== '') expect(JSON.stringify(frame.payload), name).not.toContain(secret);
    }
  });

  it('„sparowano nowe urządzenie”: baner bez sesji i bez wątku, pilny, etykieta tylko w szyfrogramie', () => {
    const frame = alertV3FrameSchema.parse(readV3('alert.device-paired.v3.json'));
    const plain = plaintextSchema.parse(JSON.parse(openV3(frame.payload.rarog)));
    expect(plain.kind).toBe('device-paired');
    expect(plain.sessionId).toBeUndefined();
    expect(plain.body).toContain('iPad·Rarog');
    expect(JSON.stringify(frame.payload)).not.toContain('iPad·Rarog');
    expect('thread-id' in frame.payload.aps).toBe(false);
    expect(frame.headers['apns-priority']).toBe('10');
  });

  it('„zmiana wersji”: baner bez sesji i bez wątku, pilny, numery wersji z kodem zdania tylko w szyfrogramie', () => {
    const frame = alertV3FrameSchema.parse(readV3('alert.version-changed.v3.json'));
    const plain = plaintextSchema.parse(JSON.parse(openV3(frame.payload.rarog)));
    expect(plain.kind).toBe('version-changed');
    expect(plain.sessionId).toBeUndefined();
    expect(plain.body).toBe('Claude Code 2.1.321 → 2.1.322, herdr 0.9.5 → 0.9.6');
    expect(plain.bodyRef).toEqual({ code: 'push.version-body.both', args: ['2.1.321', '2.1.322', '0.9.5', '0.9.6'] });
    expect(plain.titleRef).toEqual({ code: 'push.version-title' });
    expect(JSON.stringify(frame.payload)).not.toContain('2.1.322');
    expect('thread-id' in frame.payload.aps).toBe(false);
    expect(frame.headers['apns-priority']).toBe('10');
  });

  it('weekly limit: no session and no thread, urgent, collapse key from the reset, percent and reset only in the ciphertext', () => {
    const frame = alertV3FrameSchema.parse(readV3('alert.weekly-limit.v3.json'));
    const plain = plaintextSchema.parse(JSON.parse(openV3(frame.payload.rarog)));
    const reset = '2026-10-10T15:00:00.000Z';
    expect(plain.kind).toBe('weekly-limit');
    expect(plain.sessionId).toBeUndefined();
    expect(plain.title).toBe('⚠️ Weekly limit at 97%');
    expect(plain.body).toBe(`Resets ${reset}.`);
    expect(plain.titleRef).toEqual({ code: 'push.weekly-limit-title', args: ['97'] });
    expect(plain.bodyRef).toEqual({ code: 'push.weekly-limit-body', args: [reset] });
    expect(frame.headers['apns-collapse-id']).toBe(topicFor(`rarog:weekly-limit:${reset}`));
    expect(JSON.stringify(frame.payload)).not.toContain(reset);
    expect('thread-id' in frame.payload.aps).toBe(false);
    expect('badge' in frame.payload.aps).toBe(false);
    expect(frame.headers['apns-priority']).toBe('10');
  });

  it('stalled wait: session kind, urgent, one hour, own collapse key, thread of the session, codes in the ciphertext', () => {
    const frame = alertV3FrameSchema.parse(readV3('alert.stalled.v3.json'));
    const plain = plaintextSchema.parse(JSON.parse(openV3(frame.payload.rarog)));
    expect(plain.kind).toBe('stalled');
    expect(plain.sessionId).toBe('demo-atlas');
    expect(plain.titleRef?.code).toBe('push.title.stalled');
    expect(plain.bodyRef?.code).toBe('push.detail.stalled');
    expect(frame.headers['apns-priority']).toBe('10');
    expect(frame.headers['apns-collapse-id']).not.toBe(topicFor('demo-atlas'));
    expect((frame.payload.aps as Record<string, unknown>)['thread-id']).toBe(topicFor('demo-atlas'));
    expect(JSON.stringify(frame.payload)).not.toContain('Fix the flaky login test');
  });

  it('ramka z obcym kluczem w bloku `rarog`, innym tekstem zastępczym albo bez `mutable-content` — odrzucona', () => {
    const frame = readV3('alert.blocking.v3.json') as {
      headers: unknown; payload: { aps: Record<string, unknown>; rarog: Record<string, unknown> };
    };
    const block = frame.payload.rarog;
    const variant = (payload: unknown): boolean => alertV3FrameSchema.safeParse({ ...frame, payload }).success;
    expect(variant(frame.payload)).toBe(true);
    expect(variant({ ...frame.payload, rarog: { ...block, kind: 'permission' } })).toBe(false);
    expect(variant({ ...frame.payload, aps: { ...frame.payload.aps, alert: { title: 'Rarog', body: 'Edit' } } })).toBe(false);
    const { 'mutable-content': _mc, ...noMutable } = frame.payload.aps;
    expect(variant({ ...frame.payload, aps: noMutable })).toBe(false);
    expect(variant({ ...frame.payload, rarog: { ...block, c: `${String(block['c'])}=` } })).toBe(false);
  });

  it('ramka v3 ze starym blokiem obok nowego albo z `v: 2` — odrzucona', () => {
    const frame = readV3('alert.blocking.v3.json') as { headers: unknown; payload: { aps: unknown; rarog: Record<string, unknown> } };
    const variant = (payload: unknown): boolean => alertV3FrameSchema.safeParse({ ...frame, payload }).success;
    expect(variant(frame.payload)).toBe(true);
    expect(variant({ ...frame.payload, rarog: { ...frame.payload.rarog, v: 2 } })).toBe(false);
    expect(variant({ ...frame.payload, [LEGACY_BLOCK]: {} })).toBe(false);
  });
});

describe('teksty jawne wektorów `push-crypto/vectors.v3.json` → kontrakt tekstu jawnego', () => {
  const vectors = (JSON.parse(readFileSync(PUSH_VECTORS_V3, 'utf8')) as { vectors: { name: string; plaintext: string }[] })
    .vectors;

  it.each(vectors.map((v) => [v.name, v] as const))('%s: tekst jawny w ścisłym schemacie', (_name, v) => {
    const plain: unknown = JSON.parse(v.plaintext);
    expect(plaintextSchema.parse(plain)).toEqual(plain);
  });

  it('wektor z `titleRef` i `bodyRef`: kod obok tytułu i treści, uszkodzony `ref` odrzucony', () => {
    const withRefs = vectors.map((v) => plaintextSchema.parse(JSON.parse(v.plaintext)))
      .filter((plain) => plain.titleRef !== undefined && plain.bodyRef !== undefined);
    expect(withRefs.length).toBeGreaterThan(0);
    for (const plain of withRefs) {
      expect(plain.title !== undefined && plain.body !== undefined).toBe(true);
      for (const broken of [null, { code: '' }, { code: 'push.placeholder.title', args: [1] }]) {
        expect(plaintextSchema.safeParse({ ...plain, titleRef: broken }).success, JSON.stringify(broken)).toBe(false);
        expect(plaintextSchema.safeParse({ ...plain, bodyRef: broken }).success, JSON.stringify(broken)).toBe(false);
      }
    }
  });
});
