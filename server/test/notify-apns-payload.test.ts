/**
 * Ładunek i nagłówki banera APNs (`notify/apns-payload.ts`) — czyste składanie, zero sieci.
 *
 * Do udowodnienia: baner ma jeden format, 3 — `aps` dosłownie w kształcie polityki `v2` przekaźnika, JEDEN blok
 * `rarog` `{v: 3, kid, n, c}` ze stałymi szyfru Raroga; tytuł i treść z `buildContent` przechodzą bez zmian
 * do tekstu jawnego razem z celem tapnięcia i `exp`; `apns-expiration` jest czasem ABSOLUTNYM, priorytet zależy
 * od pilności; tekst jawny przycięty po skalarach do 2048 B, ładunek ≤ 4096 B na najdłuższej treści, a ponad
 * sufit — brak żądania.
 * Ramka kafla z dźwiękiem „skończył”: stały alert, priorytet 10, krótkie
 * wygaśnięcie; bez dźwięku ramka bez `alert`, a plik dźwięku leży w paczce apki.
 * Wpis z deklaracją `locKeys`: tekst zastępczy i dzwonek kluczami katalogu apki, reszta ramki bez zmian.
 */
import { createDecipheriv, hkdfSync } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RELAY_ALERT_PLACEHOLDER } from '@rarog/shared/relay';
import type { LiveActivityContentState } from '@rarog/shared/rest';
import {
  APNS_PAYLOAD_MAX_BYTES, APNS_RAROG_BLOCK, APNS_RAROG_BLOCK_VERSION, LIVE_ACTIVITY_CHIME,
  apnsAlertRequestE2e,
  apnsLiveActivityRequest, apnsSkips,
} from '../src/notify/apns-payload.ts';
import type { ApnsRequest } from '../src/notify/apns-payload.ts';
import type { PushContent } from '../src/notify/content.ts';
import {
  buildContent, buildDevicePairedContent, buildTestContent, buildWeeklyLimitContent, topicFor,
} from '../src/notify/content.ts';
import { PUSH_PLAINTEXT_MAX_BYTES, createPushSealer } from '../src/notify/push-crypto.ts';
import { SENTENCES, foreign } from '@rarog/shared/sentences';

const SESSION = 'a1b2c3d4-0000-4000-8000-000000000001';
const NOW = Date.parse('2026-10-07T10:00:00.000Z');
const pushKey = Buffer.alloc(32, 5).toString('base64url');
const key = { pushKey, kid: 'f849d673' };
const sealer = createPushSealer();
const OPTS = { topic: 'ai.rarog.app', nowMs: NOW, key, sealer } as const;
/** Stałe szyfru formatu 3 dosłownie — lustro bez kodu produkcyjnego. */
const V3 = { info: 'rarog-push-banner-v1', aadPrefix: 'rarog-push/3|' } as const;

/** Żądanie banera — w tych testach zawsze mieści się w sufitcie. */
function request(content: PushContent): ApnsRequest {
  const built = apnsAlertRequestE2e(content, OPTS);
  if (built === undefined) throw new Error('baner ponad 4096 B');
  return built;
}

type Payload = { aps: Record<string, unknown> } & Record<typeof APNS_RAROG_BLOCK, Block>;

interface Block {
  v: number;
  kid: string;
  n: string;
  c: string;
}

const parse = (body: string): Payload => JSON.parse(body) as Payload;

/** Odszyfrowanie lustrem `node:crypto`: tekst jawny z dopełnieniem. */
function openRaw(body: string): string {
  const block = parse(body)[APNS_RAROG_BLOCK];
  const sealed = Buffer.from(block.c, 'base64url');
  const decipher = createDecipheriv('chacha20-poly1305',
    Buffer.from(hkdfSync('sha256', Buffer.from(pushKey, 'base64url'), Buffer.alloc(0), Buffer.from(V3.info), 32)),
    Buffer.from(block.n, 'base64url'), { authTagLength: 16 });
  const cipherText = sealed.subarray(0, sealed.length - 16);
  decipher.setAAD(Buffer.from(`${V3.aadPrefix}${block.kid}`), { plaintextLength: cipherText.length });
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([decipher.update(cipherText), decipher.final()]).toString('utf8');
}

interface Plaintext {
  kind: string;
  title?: string;
  body?: string;
  sessionId?: string;
  termId?: string;
  exp: number;
}

const open = (body: string): Plaintext => JSON.parse(openRaw(body)) as Plaintext;

describe('baner APNs formatu 3 — treść z `buildContent` bez zmian', () => {
  const question = buildContent({
    cls: 'blocking', kind: 'question', project: 'willow', label: 'zapis', detail: foreign('Czy wdrożyć?'), sessionId: SESSION,
    termId: '0123456789abcdef', badge: 2,
  });

  it('`aps` DOKŁADNIE w kształcie polityki, JEDEN blok `rarog` `{v: 3, kid, n, c}`, tekst jawny z treścią, celem i `exp`', () => {
    const { body } = request(question);
    const payload = parse(body);
    expect(payload.aps).toEqual({
      alert: { ...RELAY_ALERT_PLACEHOLDER }, 'mutable-content': 1, sound: 'default', badge: 2,
      'thread-id': topicFor(SESSION),
    });
    expect(Object.keys(payload)).toEqual(['aps', APNS_RAROG_BLOCK]);
    expect(APNS_RAROG_BLOCK).toBe('rarog');
    const block = payload[APNS_RAROG_BLOCK];
    expect(Object.keys(block)).toEqual(['v', 'kid', 'n', 'c']);
    expect(block.v).toBe(APNS_RAROG_BLOCK_VERSION);
    expect(APNS_RAROG_BLOCK_VERSION).toBe(3);
    expect(block.kid).toBe('f849d673');
    expect(block.n).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(Buffer.byteLength(openRaw(body)) % 256).toBe(0);
    expect(open(body)).toEqual({
      kind: 'question', title: question.title, titleRef: question.titleRef, body: question.body, bodyRef: question.bodyRef,
      sessionId: SESSION, termId: '0123456789abcdef', exp: Math.floor(NOW / 1000) + question.ttl,
    });
    // Jawnie: ani tytułu, ani treści, ani projektu, ani surowego `sessionId`.
    for (const secret of [question.title, question.body, 'willow', SESSION, '0123456789abcdef']) {
      expect(body).not.toContain(secret);
    }
  });

  it('tytuł i treść przechodzą bez zmian (zgoda: narzędzie i etykieta)', () => {
    const content = buildContent({
      cls: 'blocking', kind: 'permission', project: 'rarog', label: 'visuals', detail: foreign('Bash'), sessionId: SESSION,
    });
    const plain = open(request(content).body);
    expect(plain).toMatchObject({ title: content.title, body: 'Bash — visuals', sessionId: SESSION });
  });

  it('`badge: 0` JEST wysyłane (czyści plakietkę); bez plakietki klucza nie ma', () => {
    const zero = buildContent({ cls: 'blocking', kind: 'question', project: 'p', sessionId: SESSION, badge: 0 });
    expect(parse(request(zero).body).aps['badge']).toBe(0);
    const none = buildContent({ cls: 'blocking', kind: 'question', project: 'p', sessionId: SESSION });
    expect(parse(request(none).body).aps).not.toHaveProperty('badge');
  });

  it('bez sesji (push próbny, `device-paired`): bez `thread-id`, tekst jawny bez `sessionId`', () => {
    for (const content of [buildTestContent(), buildDevicePairedContent('iPad·Rarog')]) {
      const { body } = request(content);
      expect(parse(body).aps).toEqual({ alert: { ...RELAY_ALERT_PLACEHOLDER }, 'mutable-content': 1, sound: 'default' });
      const plain = open(body);
      expect(Object.keys(plain)).toEqual(['kind', 'title', 'titleRef', 'body', 'bodyRef', 'exp']);
      expect(plain.kind).toBe(content.kind);
    }
  });
});

describe('weekly limit banner (`weekly-limit`): no session, urgent, expiry capped by the reset', () => {
  const RESET = '2026-10-10T15:00:00.000Z';

  /** Content built at `NOW` for a window that resets at `resetsAt`. */
  const weekly = (resetsAt: string): PushContent => {
    const content = buildWeeklyLimitContent(97, resetsAt, NOW);
    if (content === undefined) throw new Error('no content');
    return content;
  };

  it('no `thread-id` and no badge; plaintext carries the kind and the texts, no session', () => {
    const { body } = request(weekly(RESET));
    expect(parse(body).aps).toEqual({ alert: { ...RELAY_ALERT_PLACEHOLDER }, 'mutable-content': 1, sound: 'default' });
    const plain = open(body);
    expect(Object.keys(plain)).toEqual(['kind', 'title', 'titleRef', 'body', 'bodyRef', 'exp']);
    expect(plain).toMatchObject({ kind: 'weekly-limit', title: '⚠️ Weekly limit at 97%', body: `Resets ${RESET}.` });
    expect(body).not.toContain(RESET);
  });

  it('headers: priority 10, collapse key from the reset instant, expiry one day ahead when the reset is further', () => {
    expect(request(weekly(RESET)).headers).toEqual({
      'apns-push-type': 'alert',
      'apns-topic': 'ai.rarog.app',
      'apns-priority': '10',
      'apns-collapse-id': topicFor(`rarog:weekly-limit:${RESET}`),
      'apns-expiration': String(NOW / 1000 + 86400),
    });
    expect(open(request(weekly(RESET)).body).exp).toBe(NOW / 1000 + 86400);
  });

  it('reset in two hours: the banner expires at the reset', () => {
    const soon = new Date(NOW + 2 * 60 * 60 * 1000).toISOString();
    const { headers, body } = request(weekly(soon));
    expect(headers['apns-expiration']).toBe(String(NOW / 1000 + 7200));
    expect(open(body).exp).toBe(NOW / 1000 + 7200);
    expect(headers['apns-collapse-id']).toBe(topicFor(`rarog:weekly-limit:${soon}`));
  });
});

describe('„skończył” = sama plakietka', () => {
  it('`done`: `aps: {badge}` bez alertu, dźwięku, wątku i `mutable-content`; tekst jawny bez tytułu i treści; priorytet 5', () => {
    const done = buildContent({
      cls: 'done', kind: 'done', project: 'rarog', sessionId: SESSION, termId: 'a1b2c3d4e5f60718',
      detail: foreign('Testy zielone.'), badge: 3,
    });
    const built = request(done);
    expect(parse(built.body).aps).toEqual({ badge: 3 });
    expect(open(built.body)).toEqual({
      kind: 'done', sessionId: SESSION, termId: 'a1b2c3d4e5f60718', exp: Math.floor(NOW / 1000) + done.ttl,
    });
    expect(built.headers).toMatchObject({ 'apns-push-type': 'alert', 'apns-priority': '5' });
    expect(built.body).not.toContain('Testy zielone.');
  });

  it('pozostałe rodzaje — baner z dźwiękiem i wątkiem', () => {
    const cases = [
      ['blocking', 'permission'], ['blocking', 'question'], ['blocking', 'blocked'],
      ['failure', 'error'], ['failure', 'limit'],
    ] as const;
    for (const [cls, kind] of cases) {
      const { aps } = parse(request(buildContent({ cls, kind, project: 'p', sessionId: SESSION, badge: 1 })).body);
      expect(Object.keys(aps).sort()).toEqual(['alert', 'badge', 'mutable-content', 'sound', 'thread-id']);
    }
  });

  it('`apnsSkips`: tylko `done` bez liczby na plakietkę', () => {
    const done = (badge?: number): ReturnType<typeof buildContent> => buildContent({
      cls: 'done', kind: 'done', project: 'p', sessionId: SESSION, ...(badge === undefined ? {} : { badge }),
    });
    expect(apnsSkips(done())).toBe(true);
    expect(apnsSkips(done(0))).toBe(false);
    expect(apnsSkips(buildContent({ cls: 'blocking', kind: 'permission', project: 'p', sessionId: SESSION }))).toBe(false);
    expect(apnsSkips(buildTestContent())).toBe(false);
  });
});

describe('nagłówki', () => {
  it('typ, topic, koalescencja per sesja i czas ABSOLUTNY wygaśnięcia', () => {
    const content = buildContent({ cls: 'blocking', kind: 'question', project: 'p', sessionId: SESSION });
    const { headers } = request(content);
    expect(headers).toEqual({
      'apns-push-type': 'alert',
      'apns-topic': 'ai.rarog.app',
      'apns-priority': '10',
      'apns-collapse-id': topicFor(SESSION),
      // `apns-expiration` to sekundy epoki, NIE TTL: teraz + 600 s dla spraw blokujących.
      'apns-expiration': String(NOW / 1000 + 600),
    });
    expect(Buffer.byteLength(headers['apns-collapse-id'] ?? '')).toBeLessThanOrEqual(64);
  });

  it('„gotowe" idzie priorytetem 5 i żyje godzinę; awaria — 10 i 10 min', () => {
    const done = buildContent({ cls: 'done', kind: 'done', project: 'p', sessionId: SESSION, badge: 0 });
    expect(request(done).headers).toMatchObject({
      'apns-priority': '5', 'apns-expiration': String(NOW / 1000 + 3600),
    });
    const failure = buildContent({ cls: 'failure', kind: 'error', project: 'p', sessionId: SESSION });
    expect(request(failure).headers).toMatchObject({
      'apns-priority': '10', 'apns-expiration': String(NOW / 1000 + 600),
    });
  });
});

describe('sufit 4096 B', () => {
  it('najdłuższa treść (projekt 255 B z cudzysłowami i `\\n`, treść 121 znaków po 4 B): ≤ 4096 B bez przycinania', () => {
    const project = `"${'ą\n"'.repeat(63)}xy`;
    expect(Buffer.byteLength(project)).toBe(255);
    const longest: PushContent = {
      ...buildContent({ cls: 'blocking', kind: 'permission', project, sessionId: SESSION, termId: '0123456789abcdef', badge: 99 }),
      body: '😀'.repeat(121),
    };
    const { body } = request(longest);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(APNS_PAYLOAD_MAX_BYTES);
    const plain = open(body);
    expect(plain.title).toBe(longest.title);
    expect(plain.body).toBe(longest.body);
  });

  /*
   * Treść jest krótka (`body` ≤ 120 znaków), ale tytuł niesie nazwę projektu, której nikt nie
   * ogranicza. Przycinanie idzie po SKALARACH: emoji spoza BMP to para surogatów i przecięcie jej
   * w połowie dałoby niepoprawny UTF-8.
   */
  it('tekst jawny ponad 2048 B: przycięty po skalarach (najpierw treść, potem tytuł), dopełniony do sufitu', () => {
    const base = buildContent({ cls: 'blocking', kind: 'question', project: 'p', sessionId: SESSION, termId: '0123456789abcdef' });
    const huge: PushContent = { ...base, title: `⏳ ${'😀'.repeat(1000)}`, body: 'ż'.repeat(500) };
    const { body } = request(huge);
    expect(Buffer.byteLength(openRaw(body))).toBe(PUSH_PLAINTEXT_MAX_BYTES);
    const plain = open(body);
    expect(plain.body).toBe('');
    expect(plain.title?.endsWith('…')).toBe(true);
    // Żadnej osieroconej połówki pary surogatów.
    expect(plain.title).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(plain.title).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    // Cel tapnięcia przeżywa przycinanie.
    expect(plain.sessionId).toBe(SESSION);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(APNS_PAYLOAD_MAX_BYTES);
  });

  it('treść ucina się pierwsza — tytuł zostaje, gdy to wystarczy', () => {
    const content = buildContent({ cls: 'failure', kind: 'error', project: 'p', sessionId: SESSION });
    const plain = open(request({ ...content, body: 'ż'.repeat(3000) }).body);
    expect(plain.title).toBe(content.title);
    expect(plain.body?.endsWith('…')).toBe(true);
  });

  it('patologiczne `sessionId` (ładunek po szyfrowaniu ponad 4096 B): brak żądania — wpis do pominięcia', () => {
    const fat = buildContent({ cls: 'blocking', kind: 'permission', project: 'p', sessionId: 's'.repeat(3200), detail: foreign('x') });
    expect(apnsAlertRequestE2e(fat, OPTS)).toBeUndefined();
  });

  it('zły klucz albo `kid`: szyfrowanie rzuca (sink łapie to jak pominięcie)', () => {
    const question = buildContent({ cls: 'blocking', kind: 'question', project: 'p', sessionId: SESSION });
    expect(() => apnsAlertRequestE2e(question, { ...OPTS, key: { pushKey: 'krótki', kid: 'f849d673' } })).toThrow();
    expect(() => apnsAlertRequestE2e(question, { ...OPTS, key: { pushKey, kid: 'F849D673' } })).toThrow();
  });
});

describe('ramka kafla z dźwiękiem „skończył”', () => {
  const NOW_S = NOW / 1000;
  const state: LiveActivityContentState = { waiting: 0, working: 1, finished: 1, updatedEpoch: NOW_S };
  const base = { topic: 'ai.rarog.app', event: 'update', timestamp: NOW_S, priority: 'low' } as const;

  it('stałe teksty bez treści sesji i plik dźwięku z paczki apki', () => {
    expect(LIVE_ACTIVITY_CHIME).toEqual({ title: 'Agent skończył', body: 'Wynik czeka w Rarogu', sound: 'skonczyl.caf' });
  });

  it('without `chime` the frame has no `alert`: priority from the caller, expiry = `stale-date`', () => {
    const request = apnsLiveActivityRequest(state, base);
    expect(request.headers).toEqual({
      'apns-push-type': 'liveactivity',
      'apns-topic': 'ai.rarog.app.push-type.liveactivity',
      'apns-priority': '5',
      'apns-expiration': String(NOW_S + 900),
    });
    expect(request.body).toBe(
      `{"aps":{"timestamp":${String(NOW_S)},"event":"update","content-state":${JSON.stringify(state)},`
      + `"stale-date":${String(NOW_S + 900)}}}`,
    );
  });

  it('z `chime`: `aps.alert` = stała (po `content-state`, przed `stale-date`), priorytet 10, wygaśnięcie z zegara wołającego', () => {
    // `timestamp` bywa PRZED zegarem (seria pilnych wysyłek) — wygaśnięcie dźwięku go nie dotyczy.
    const request = apnsLiveActivityRequest(state, { ...base, timestamp: NOW_S + 3, chime: { expiresAtSec: NOW_S + 30 } });
    expect(request.headers).toEqual({
      'apns-push-type': 'liveactivity',
      'apns-topic': 'ai.rarog.app.push-type.liveactivity',
      'apns-priority': '10',
      'apns-expiration': String(NOW_S + 30),
    });
    expect(request.body).toBe(
      `{"aps":{"timestamp":${String(NOW_S + 3)},"event":"update","content-state":${JSON.stringify(state)},`
      + '"alert":{"title":"Agent skończył","body":"Wynik czeka w Rarogu","sound":"skonczyl.caf"},'
      + `"stale-date":${String(NOW_S + 3 + 900)}}}`,
    );
  });

  it('`end` nigdy nie niesie alertu — typ nie przyjmuje `chime` przy `end`', () => {
    const end = apnsLiveActivityRequest(state, { ...base, event: 'end' });
    expect(end.body).not.toContain('"alert"');
    // @ts-expect-error — dźwięk jedzie wyłącznie z `update`.
    const forced = apnsLiveActivityRequest(state, { ...base, event: 'end', chime: { expiresAtSec: NOW_S + 30 } });
    expect(forced.body).not.toContain('"alert"');
  });

  it('plik `LIVE_ACTIVITY_CHIME.sound` leży w korzeniu paczki apki (inaczej iOS gra dźwięk domyślny)', () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    expect(existsSync(path.join(repoRoot, 'native/Rarog/Rarog', LIVE_ACTIVITY_CHIME.sound))).toBe(true);
  });
});

/*
 * Klucze lokalizacji zamiast literałów: wpis z deklaracją `locKeys` dostaje tekst zastępczy banera i dzwonek kafla
 * jako klucze katalogu apki. Kształt to polityka przekaźnika (`shared/fixtures/relay/alert-policy.json`), a klucze to
 * kody obszaru `push` rejestru zdań.
 */
describe('klucze lokalizacji zamiast literałów (`locKeys`)', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const policy = JSON.parse(readFileSync(path.join(repoRoot, 'shared/fixtures/relay/alert-policy.json'), 'utf8')) as {
    alert: { placeholderKeys: Record<string, string> };
    liveactivity: { chimeKeys: { title: string; body: string } };
  };
  const PLACEHOLDER_KEYS = { 'title-loc-key': 'push.placeholder.title', 'loc-key': 'push.placeholder.body' };
  const CHIME_KEYS = {
    title: { 'loc-key': 'push.chime.title' }, body: { 'loc-key': 'push.chime.body' }, sound: 'skonczyl.caf',
  };
  const question = buildContent({
    cls: 'blocking', kind: 'question', project: 'willow', label: 'zapis', detail: foreign('Czy wdrożyć?'), sessionId: SESSION,
    badge: 2,
  });
  const withKeys = (content: PushContent, locKeys?: boolean): ApnsRequest => {
    const built = apnsAlertRequestE2e(content, { ...OPTS, ...(locKeys === undefined ? {} : { locKeys }) });
    if (built === undefined) throw new Error('baner ponad 4096 B');
    return built;
  };

  it('klucze to kody obszaru `push` rejestru i dokładnie klucze polityki przekaźnika', () => {
    expect(PLACEHOLDER_KEYS).toEqual(policy.alert.placeholderKeys);
    expect({ title: CHIME_KEYS.title['loc-key'], body: CHIME_KEYS.body['loc-key'] }).toEqual(policy.liveactivity.chimeKeys);
    for (const code of ['push.placeholder.title', 'push.placeholder.body', 'push.chime.title', 'push.chime.body']) {
      expect(SENTENCES, code).toHaveProperty([code]);
    }
  });

  it('baner z `locKeys: true`: `aps.alert` = klucze; reszta `aps`, nagłówki i tekst jawny jak przy literale', () => {
    const keyed = withKeys(question, true);
    const literal = withKeys(question);
    expect(parse(keyed.body).aps).toEqual({
      alert: PLACEHOLDER_KEYS, 'mutable-content': 1, sound: 'default', badge: 2, 'thread-id': topicFor(SESSION),
    });
    expect(parse(literal.body).aps).toEqual({ ...parse(keyed.body).aps, alert: { ...RELAY_ALERT_PLACEHOLDER } });
    expect(keyed.headers).toEqual(literal.headers);
    expect(open(keyed.body)).toEqual(open(literal.body));
  });

  it('`locKeys: false` i brak opcji: literał tekstu zastępczego', () => {
    for (const locKeys of [false, undefined]) {
      expect(parse(withKeys(question, locKeys).body).aps['alert'], String(locKeys)).toEqual({ ...RELAY_ALERT_PLACEHOLDER });
    }
  });

  it('„skończył” z `locKeys: true`: dalej sama plakietka, bez alertu', () => {
    const done = buildContent({ cls: 'done', kind: 'done', project: 'willow', sessionId: SESSION, badge: 1 });
    expect(parse(withKeys(done, true).body).aps).toEqual({ badge: 1 });
  });

  it('push próbny i `device-paired` z `locKeys: true`: klucze, bez wątku', () => {
    for (const content of [buildTestContent(), buildDevicePairedContent('iPad·Rarog')]) {
      expect(parse(withKeys(content, true).body).aps, content.kind).toEqual({
        alert: PLACEHOLDER_KEYS, 'mutable-content': 1, sound: 'default',
      });
    }
  });

  it('dzwonek kafla z `locKeys: true`: `aps.alert` = klucze w postaci kafla z tym samym dźwiękiem; reszta ramki bez zmian', () => {
    const NOW_S = NOW / 1000;
    const state: LiveActivityContentState = { waiting: 0, working: 1, finished: 1, updatedEpoch: NOW_S };
    const base = { topic: 'ai.rarog.app', event: 'update', timestamp: NOW_S, priority: 'low' } as const;
    const keyed = apnsLiveActivityRequest(state, { ...base, chime: { expiresAtSec: NOW_S + 30, locKeys: true } });
    const literal = apnsLiveActivityRequest(state, { ...base, chime: { expiresAtSec: NOW_S + 30 } });
    expect(keyed.headers).toEqual(literal.headers);
    const keyedAps = (JSON.parse(keyed.body) as Payload).aps;
    expect(keyedAps['alert']).toEqual(CHIME_KEYS);
    expect({ ...keyedAps, alert: LIVE_ACTIVITY_CHIME }).toEqual((JSON.parse(literal.body) as Payload).aps);
    expect(Object.keys(keyedAps)).toEqual(['timestamp', 'event', 'content-state', 'alert', 'stale-date']);
    const off = apnsLiveActivityRequest(state, { ...base, chime: { expiresAtSec: NOW_S + 30, locKeys: false } });
    expect(off.body).toBe(literal.body);
  });
});
