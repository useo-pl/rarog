/**
 * Treść powiadomienia (`notify/content.ts`) — co człowiek zobaczy na ekranie blokady. Ładunek APNs
 * z tej treści sprawdza `notify-apns-payload.test.ts`. Wszystko bez sieci.
 */
import { describe, expect, it } from 'vitest';
import { NOTIFY_KIND_TITLE } from '@rarog/shared/notify-copy';
import {
  MESSAGE_MAX_CHARS, TOPIC_MAX_CHARS, buildContent, buildStalledContent, buildTestContent, buildWeeklyLimitContent,
  flatten, isSessionless, stalledTopicFor, topicFor,
} from '../src/notify/content.ts';
import type { NotifyKind } from '../src/notify/policy.ts';
import { foreign } from '@rarog/shared/sentences';

const SESSION = 'a1b2c3d4-0000-4000-8000-000000000001';

describe('flatten — treść agenta na jednej linii banera', () => {
  it('zdejmuje markdown, który agent produkuje najczęściej', () => {
    expect(flatten('**Gotowe** — poprawiłem `render()` w #nagłówku')).toBe(
      'Gotowe — poprawiłem render() w nagłówku',
    );
  });

  it('wyrzuca bloki kodu w całości — na banerze i tak nie ma ich jak pokazać', () => {
    expect(flatten('przed\n```js\nconst x = 1;\n```\npo')).toBe('przed po');
  });

  it('skleja listę w jedną linię', () => {
    expect(flatten('- pierwsze\n- drugie')).toBe('pierwsze drugie');
  });

  it('tnie na granicy słowa i zaznacza ucięcie', () => {
    const out = flatten(`${'słowo '.repeat(60)}koniec`);
    expect(out.length).toBeLessThanOrEqual(MESSAGE_MAX_CHARS);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toContain('sło…');
  });

  it('krótkiej treści nie tyka', () => {
    expect(flatten('gotowe')).toBe('gotowe');
  });
});

describe('cel tapnięcia — treść niesie sesję albo terminal, nie adres', () => {
  /*
   * Treść NIE niesie adresu: apka czyta cel z klucza `rarog` ładunku APNs (`apns-payload.ts`).
   * Treść niesie za to CEL (sesja, terminal, rodzaj).
   */
  it('treść niesie cel tapnięcia (sesja, rodzaj), a nie adres', () => {
    const c = buildContent({ cls: 'done', kind: 'done', project: 'rarog', sessionId: SESSION });
    expect(c).toMatchObject({ kind: 'done', sessionId: SESSION });
    expect(c).not.toHaveProperty('navigate');
    expect(c).not.toHaveProperty('termId');
  });

  /**
   * TEST OBOWIĄZKOWY. Wpis Codexa stojącego w terminalu Raroga ma
   * wiersz prowadzący do terminala — baner MUSI lądować w tym samym miejscu, więc treść niesie
   * `termId`.
   */
  it('`termId` jedzie w treści; koalescencja zostaje na sesji', () => {
    const term = 'a1b2c3d4e5f60718';
    const c = buildContent({
      cls: 'done', kind: 'done', project: 'rarog', sessionId: SESSION, termId: term,
    });
    expect(c).toMatchObject({ termId: term });
    /*
     * `topic` zostaje NA SESJI: koalescencja ma wypierać starszy baner o tej samej SPRAWIE,
     * a sprawą jest sesja — nie ekran, na który tap prowadzi.
     */
    expect(c.topic).toBe(topicFor(SESSION));
  });
});

describe('buildContent — co widać na ekranie blokady', () => {
  const build = (extra: Partial<Parameters<typeof buildContent>[0]> = {}) => buildContent({
    cls: 'blocking', kind: 'permission', project: 'rarog', sessionId: SESSION, ...extra,
  });

  it('tytuł mówi CO się stało i kto to przysłał', () => {
    // Tytuł = RODZAJ zdarzenia + projekt. Bez `· rarog`: iOS pokazuje nazwę apki sam.
    // Brzmienie i kod każdego rodzaju: tabela `sentences-push.test.ts`.
    expect(build({ kind: 'permission' }).title).toBe('⏳ Waiting for permission · rarog');
    expect(build({ kind: 'question' }).title).toBe('❓ Question · rarog');
    expect(build({ cls: 'failure', kind: 'limit' }).title).toBe('✋ Plan limit · rarog');
    expect(build().title).not.toContain('· rarog ·');
  });

  /*
   * Emoji jest NAMIASTKĄ ikony, nie ozdobnikiem: iOS rysuje na każdym banerze tę samą ikonę
   * apki, więc dwa rodzaje z tym samym znakiem byłyby na ekranie blokady nie do odróżnienia,
   * dopóki nie przeczyta się tytułu. Stąd trzy warunki: komplet rodzajów, znaki różne, znak
   * pierwszy (tytuł iOS ucina od końca).
   */
  it('każdy rodzaj ma WŁASNE emoji i stoi ono na początku tytułu', () => {
    const kinds = Object.keys(NOTIFY_KIND_TITLE) as NotifyKind[];
    // Pierwszy znak tytułu (emoji) przed spacją: komplet rodzajów, znaki różne.
    const emoji = kinds.map((kind) => build({ cls: 'done', kind }).title.split(' ')[0] ?? '');
    expect(emoji.every((e) => e !== '' && !/\p{L}/u.test(e))).toBe(true);
    expect(new Set(emoji).size).toBe(kinds.length);
  });

  it('kontekst i treść idą w `body` — bez subtitle', () => {
    // Zgoda: narzędzie + etykieta sesji (w projekcie bywa kilka sesji). Projektu nie powtarzamy.
    expect(build({ label: 'visuals', detail: foreign('Bash') }).body).toBe('Bash — visuals');
  });

  it('bez treści zostaje sam kontekst (degradacja z hooków: `Stop` bywa bez wiadomości)', () => {
    expect(build({ label: 'visuals' }).body).toBe('visuals');
    expect(build().body).toBe('Open to decide.');
    // Wynik / pytanie: sama treść — etykieta ustępuje zdaniu.
    expect(build({ kind: 'done', label: 'visuals', detail: foreign('Testy zielone.') }).body).toBe('Testy zielone.');
    expect(build({ kind: 'question', detail: foreign('Który plik?') }).body).toBe('Który plik?');
    expect(build({ kind: 'done' }).body).toBe('The result is waiting for you.');
  });

  it('treść z markdownu jest spłaszczana, a całość nie przekracza sufitu banera', () => {
    expect(build({ detail: foreign('**gotowe**\n- raz\n- dwa') }).body).toBe('gotowe raz dwa');
    const long = build({ label: 'x'.repeat(50), detail: foreign('y '.repeat(100)) });
    expect(long.body.length).toBeLessThanOrEqual(MESSAGE_MAX_CHARS);
  });

  it('podkreślenia w nazwie projektu NIE są zdejmowane jak markdown', () => {
    expect(build({ project: 'my_repo', detail: foreign('ok') }).title).toBe('⏳ Waiting for permission · my_repo');
    expect(build({ project: 'my_repo', detail: foreign('ok') }).body).toBe('ok');
  });

  it('sprawy blokujące i awarie są pilne i krótko żyją; „gotowe" może poczekać', () => {
    expect(build({ cls: 'blocking', kind: 'permission' })).toMatchObject({ urgency: 'high', ttl: 600 });
    expect(build({ cls: 'failure', kind: 'error' })).toMatchObject({ urgency: 'high', ttl: 600 });
    expect(build({ cls: 'done', kind: 'done' })).toMatchObject({ urgency: 'normal', ttl: 3600 });
  });

  it('plakietka przechodzi, gdy jest — także zero', () => {
    expect(build({ badge: 0 }).badge).toBe(0);
    expect(build({ badge: 3 }).badge).toBe(3);
    expect(build()).not.toHaveProperty('badge');
  });
});

describe('topic — klucz koalescencji (`apns-collapse-id`)', () => {
  it('mieści się w sufitcie APNs i używa alfabetu base64url', () => {
    const topic = topicFor(SESSION);
    expect(topic.length).toBeLessThanOrEqual(TOPIC_MAX_CHARS);
    expect(topic).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('jest stabilny per sesja i różny między sesjami — inaczej nic by nie koalescowało', () => {
    expect(topicFor(SESSION)).toBe(topicFor(SESSION));
    expect(topicFor(SESSION)).not.toBe(topicFor('inna'));
    expect(buildContent({ cls: 'done', kind: 'done', project: 'p', sessionId: SESSION }).topic)
      .toBe(topicFor(SESSION));
  });
});

describe('push próbny', () => {
  it('prowadzi na listę sesji i przedstawia się tak samo jak reszta', () => {
    const c = buildTestContent();
    expect(c.kind).toBe('test');
    expect(c.title).toBe('🔔 Notifications are working');
    expect(c.title).not.toContain('· rarog');
    expect(c).not.toHaveProperty('sessionId');
    expect(c).not.toHaveProperty('badge');
  });
});

describe('weekly limit push (`weekly-limit`): account window, no session', () => {
  const RESET = '2026-11-18T15:00:00.000Z';
  const RESET_MS = Date.parse(RESET);
  const DAY_S = 24 * 60 * 60;

  it('reset more than a day away: English title and body with sentence codes, urgent, TTL one day, no session', () => {
    const c = buildWeeklyLimitContent(97, RESET, RESET_MS - 3 * DAY_S * 1000);
    expect(c).toEqual({
      kind: 'weekly-limit',
      title: '⚠️ Weekly limit at 97%',
      titleRef: { code: 'push.weekly-limit-title', args: ['97'] },
      body: `Resets ${RESET}.`,
      bodyRef: { code: 'push.weekly-limit-body', args: [RESET] },
      topic: topicFor(`rarog:weekly-limit:${RESET}`),
      urgency: 'high',
      ttl: DAY_S,
    });
    if (c === undefined) throw new Error('no content');
    expect(isSessionless(c)).toBe(true);
    expect(c).not.toHaveProperty('sessionId');
    expect(c).not.toHaveProperty('termId');
    expect(c).not.toHaveProperty('badge');
    expect(c.title.length).toBeLessThanOrEqual(MESSAGE_MAX_CHARS);
    expect(c.body.length).toBeLessThanOrEqual(MESSAGE_MAX_CHARS);
  });

  it('TTL makes `apns-expiration` (whole epoch seconds of now + TTL) land on the reset second when under a day', () => {
    expect(buildWeeklyLimitContent(98, RESET, RESET_MS - 2 * 60 * 60 * 1000)?.ttl).toBe(7200);
    // Now at x.5 s: floor(now) + 7201 is the reset second.
    expect(buildWeeklyLimitContent(98, RESET, RESET_MS - 7_200_500)?.ttl).toBe(7201);
    expect(buildWeeklyLimitContent(98, RESET, RESET_MS - DAY_S * 1000)?.ttl).toBe(DAY_S);
    expect(buildWeeklyLimitContent(98, RESET, RESET_MS - 1000)?.ttl).toBe(1);
  });

  it('reset less than a second away: the expiration is the reset second, never already in the past', () => {
    for (const leftMs of [1, 500, 999]) {
      const now = RESET_MS - leftMs;
      const content = buildWeeklyLimitContent(98, RESET, now);
      expect(content?.ttl, `${leftMs} ms`).toBe(1);
      expect(Math.floor(now / 1000) + (content?.ttl ?? 0), `${leftMs} ms`).toBe(RESET_MS / 1000);
    }
  });

  it('reset now or in the past: no content (a banner about a finished window has nothing to say)', () => {
    expect(buildWeeklyLimitContent(99, RESET, RESET_MS)).toBeUndefined();
    expect(buildWeeklyLimitContent(99, RESET, RESET_MS + 1)).toBeUndefined();
  });

  it('the collapse key follows the reset instant: two windows give two banners, one window always the same key', () => {
    const now = RESET_MS - 3 * DAY_S * 1000;
    const other = '2026-11-19T01:00:00.000Z';
    expect(buildWeeklyLimitContent(97, RESET, now)?.topic).toBe(buildWeeklyLimitContent(100, RESET, now + 1000)?.topic);
    expect(buildWeeklyLimitContent(97, RESET, now)?.topic).not.toBe(buildWeeklyLimitContent(97, other, now)?.topic);
    expect(buildWeeklyLimitContent(97, RESET, now)?.topic.length).toBeLessThanOrEqual(TOPIC_MAX_CHARS);
  });
});

describe('stalled wait push (`stalled`): a subagent waits over an hour on its own command', () => {
  const ATLAS = 'demo-atlas';
  const build = (extra: Partial<Parameters<typeof buildStalledContent>[0]> = {}) => buildStalledContent({
    project: 'atlas', label: 'login flow', sessionId: ATLAS, agent: 'Fix the flaky login test', ...extra,
  });

  it('title and body carry sentence codes; the body names the subagent, never a command', () => {
    const c = build({ termId: '0123456789abcdef', badge: 1 });
    expect(c).toMatchObject({ kind: 'stalled', sessionId: ATLAS, termId: '0123456789abcdef', badge: 1 });
    expect(c.titleRef).toEqual({ code: 'push.title.stalled', args: ['atlas'] });
    expect(c.bodyRef).toEqual({ code: 'push.detail.stalled', args: ['Fix the flaky login test'] });
    expect(c.body).toContain('Fix the flaky login test');
    expect(isSessionless(c)).toBe(false);
  });

  it('its own collapse key: not the session topic (it would replace a decision banner), stable per session', () => {
    const c = build();
    expect(c.topic).not.toBe(topicFor(ATLAS));
    expect(c.topic).toBe(stalledTopicFor(ATLAS));
    expect(build({ agent: 'Another subagent', label: 'other' }).topic).toBe(c.topic);
    expect(stalledTopicFor('demo-willow')).not.toBe(c.topic);
    expect(c.topic.length).toBeLessThanOrEqual(TOPIC_MAX_CHARS);
    expect(c.topic).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('urgent and one hour in APNs: the state lasts, so a late alarm is still true', () => {
    expect(build()).toMatchObject({ urgency: 'high', ttl: 3600 });
  });

  it('a long description is flattened and clipped before the sentence, so the body keeps its code', () => {
    const c = build({ agent: `**Refactor** ${'the session list '.repeat(20)}` });
    expect(c.body.length).toBeLessThanOrEqual(MESSAGE_MAX_CHARS);
    expect(c.bodyRef?.code).toBe('push.detail.stalled');
    expect(c.body).not.toContain('**');
  });

  it('no description: the session label, then the kind fallback', () => {
    expect(build({ agent: undefined }).bodyRef).toEqual({ code: 'push.body.label', args: ['login flow'] });
    expect(build({ agent: '  ', label: undefined }).bodyRef).toEqual({ code: 'push.body.fallback.stalled' });
  });
});
