/**
 * Zdania pushu z kodem: tytuł i treść banera powstają z `say()`, a `titleRef` i `bodyRef` jadą obok tekstu
 * przez harmonogram do tekstu jawnego formatu 3. Tabela przypadków: po jednym przypadku na kod, budżety
 * (120 znaków treści, 2048 B tekstu jawnego) i kolejka harmonogramu. Tłumaczenie po stronie apki sprawdzają testy
 * Swift (`PushServiceTests`, `ApnsFramesTests`, `PushV3RoutingTests`), pełną drogę od zdarzenia managera
 * `manager.test.ts` („strażnik treści banera”).
 */
import { hkdfSync, createDecipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SessionState } from '@rarog/shared';
import { foreign, say } from '@rarog/shared/sentences';
import type { SentenceRef } from '@rarog/shared/sentences';
import { apnsAlertRequestE2e } from '../src/notify/apns-payload.ts';
import {
  MESSAGE_MAX_CHARS, buildContent, buildDevicePairedContent, buildTestContent, buildWeeklyLimitContent,
} from '../src/notify/content.ts';
import type { ContentInput, PushContent } from '../src/notify/content.ts';
import { Notifier } from '../src/notify/index.ts';
import type { NoteInput, SessionLook } from '../src/notify/index.ts';
import { FIRST_CHECK_MS } from '../src/notify/policy.ts';
import type { NotifyKind } from '../src/notify/policy.ts';
import { Presence } from '../src/notify/presence.ts';
import { PUSH_KEY_INFO_V3, PUSH_AAD_PREFIX_V3, PUSH_PLAINTEXT_MAX_BYTES, createPushSealer } from '../src/notify/push-crypto.ts';
import { isFallbackLabel } from '../src/sessions/manager.ts';

const SESSION = 'a1b2c3d4-0000-4000-8000-000000000001';
const RESET = '2026-11-12T10:00:00.000Z';

/** Napis bez samotnej połówki pary surogatów (w trybie `u` para to jeden punkt kodowy spoza zakresu). */
const wellFormed = (text: string): boolean => !/[\ud800-\udfff]/u.test(text);

const build = (extra: Partial<ContentInput> = {}): PushContent => buildContent({
  cls: 'blocking', kind: 'permission', project: 'rarog', sessionId: SESSION, ...extra,
});

/** Angielski tekst zdania z `ref`, tak jak go wyrenderowałby serwer (kontrola „ref nie odtwarza więcej niż tekst”). */
const rendered = (ref: SentenceRef): string =>
  (say as unknown as (code: string, args: Record<string, string>) => { text: string })(ref.code, argsOf(ref)).text;

/** Argumenty `ref` jako obiekt nazwa → wartość dla kodów pushu z tej tabeli. */
function argsOf(ref: SentenceRef): Record<string, string> {
  const names: Record<string, readonly string[]> = {
    'push.body.detail': ['detail'], 'push.body.label': ['label'], 'push.body.detail-and-label': ['detail', 'label'],
    'push.body.detail-and-session-number': ['detail', 'n'], 'session.fallback-label': ['n'],
  };
  const list = names[ref.code] ?? [];
  return Object.fromEntries(list.map((name, i) => [name, ref.args?.[i] ?? '']));
}

describe('tytuł: `push.title.<rodzaj>` z projektem', () => {
  const cases: ReadonlyArray<[NotifyKind, string, string]> = [
    ['permission', 'push.title.permission', '⏳ Waiting for permission · rarog'],
    ['question', 'push.title.question', '❓ Question · rarog'],
    ['blocked', 'push.title.blocked', '⛔ Waiting in the terminal · rarog'],
    ['done', 'push.title.done', '✅ Done · rarog'],
    ['error', 'push.title.error', '❌ Error · rarog'],
    ['limit', 'push.title.limit', '✋ Plan limit · rarog'],
  ];
  for (const [kind, code, text] of cases) {
    it(`${kind} → ${code}`, () => {
      const content = build({ kind });
      expect(content.title).toBe(text);
      expect(content.titleRef).toEqual({ code, args: ['rarog'] });
    });
  }

  it('projekt z polskimi znakami zostaje dosłownie w argumencie', () => {
    expect(build({ project: 'zażółć' }).titleRef).toEqual({ code: 'push.title.permission', args: ['zażółć'] });
  });
});

describe('treść: zgoda i dialog niosą nazwę narzędzia i etykietę', () => {
  it('zwykła etykieta → `push.body.detail-and-label`', () => {
    const content = build({ detail: foreign('Bash'), label: 'visuals' });
    expect(content.body).toBe('Bash — visuals');
    expect(content.bodyRef).toEqual({ code: 'push.body.detail-and-label', args: ['Bash', 'visuals'] });
  });

  it('etykieta zapasowa w obu formach → `push.body.detail-and-session-number` z numerem', () => {
    for (const label of ['session 3', 'sesja 3']) {
      const content = build({ kind: 'blocked', detail: foreign('Bash'), label });
      expect(content.body).toBe('Bash — session 3');
      expect(content.bodyRef).toEqual({ code: 'push.body.detail-and-session-number', args: ['Bash', '3'] });
    }
  });

  it('reguła etykiety zapasowej jest ta sama co `isFallbackLabel` managera', () => {
    for (const label of ['session 3', 'sesja 12', 'session 0', 'Session 3', 'sesja', 'session x']) {
      const content = build({ detail: foreign('Bash'), label });
      expect(content.bodyRef?.code === 'push.body.detail-and-session-number', label).toBe(isFallbackLabel(label));
    }
  });

  it('`permission` i `blocked` niosą tylko nazwę narzędzia: w `ref.args` nie ma nic poza nią i etykietą', () => {
    const content = build({ kind: 'blocked', detail: foreign('Bash'), label: 'zapis' });
    expect(content.bodyRef?.args).toEqual(['Bash', 'zapis']);
  });
});

describe('treść: pytanie, wynik, błąd i limit', () => {
  it('pytanie (tekst agenta) → `push.body.detail`, polski argument dosłownie', () => {
    const content = build({ cls: 'blocking', kind: 'question', detail: foreign('Który plik w /tmp/zażółć?') });
    expect(content.body).toBe('Który plik w /tmp/zażółć?');
    expect(content.bodyRef).toEqual({ code: 'push.body.detail', args: ['Który plik w /tmp/zażółć?'] });
  });

  it('błąd ze zdaniem Raroga → `bodyRef` = `ref` zdania szczegółu', () => {
    const detail = say('state.driver-error');
    const content = build({ cls: 'failure', kind: 'error', detail });
    expect(content.body).toBe(detail.text);
    expect(content.bodyRef).toEqual({ code: 'state.driver-error' });
  });

  it('limit ze zdaniem `state.limit-reached` → `bodyRef` z chwilą resetu', () => {
    const detail = say('state.limit-reached', { reset: RESET });
    const content = build({ cls: 'failure', kind: 'limit', detail });
    expect(content.body).toBe(`Plan limit reached. Try again after ${RESET}.`);
    expect(content.bodyRef).toEqual({ code: 'state.limit-reached', args: [RESET] });
  });

  it('błąd z tekstem obcym (treść silnika) → `push.body.detail`, tekst dosłownie w argumencie', () => {
    const content = build({ cls: 'failure', kind: 'error', detail: foreign('silnik zakończył pracę błędem') });
    expect(content.body).toBe('silnik zakończył pracę błędem');
    expect(content.bodyRef).toEqual({ code: 'push.body.detail', args: ['silnik zakończył pracę błędem'] });
  });

  it('wynik bez etykiety pierwszeństwa: treść zdania wygrywa z etykietą', () => {
    const content = build({ cls: 'done', kind: 'done', label: 'visuals', detail: foreign('Testy zielone.') });
    expect(content.bodyRef).toEqual({ code: 'push.body.detail', args: ['Testy zielone.'] });
  });
});

describe('treść bez szczegółu', () => {
  it('zwykła etykieta → `push.body.label`', () => {
    const content = build({ label: 'visuals' });
    expect(content.body).toBe('visuals');
    expect(content.bodyRef).toEqual({ code: 'push.body.label', args: ['visuals'] });
  });

  it('etykieta zapasowa w obu formach → zdanie `session.fallback-label`', () => {
    for (const label of ['sesja 2', 'session 2']) {
      const content = build({ label });
      expect(content.body).toBe('session 2');
      expect(content.bodyRef).toEqual({ code: 'session.fallback-label', args: ['2'] });
    }
  });

  const fallbacks: ReadonlyArray<[NotifyKind, string, string]> = [
    ['permission', 'push.body.fallback.permission', 'Open to decide.'],
    ['question', 'push.body.fallback.question', 'The agent asked a question. Answer in Rarog.'],
    ['blocked', 'push.body.fallback.blocked', 'A dialog is open in the terminal. Open to see it.'],
    ['done', 'push.body.fallback.done', 'The result is waiting for you.'],
    ['error', 'push.body.fallback.error', 'The turn failed. Open to see why.'],
    ['limit', 'push.body.fallback.limit', 'Open to see when to try again.'],
  ];
  for (const [kind, code, text] of fallbacks) {
    it(`${kind} bez szczegółu i etykiety → ${code}`, () => {
      const content = build({ kind });
      expect(content.body).toBe(text);
      expect(content.bodyRef).toEqual({ code });
    });
  }
});

describe('budżet 120 znaków: argumenty przycięte PRZED `say()`', () => {
  it('szczegół 300 znaków → `body` ≤ 120, a `ref` renderuje dokładnie ten sam tekst', () => {
    const content = build({ kind: 'question', detail: foreign(`${'słowo '.repeat(50)}koniec`) });
    expect(content.body.length).toBeLessThanOrEqual(MESSAGE_MAX_CHARS);
    expect(content.body.endsWith('…')).toBe(true);
    expect(content.bodyRef?.code).toBe('push.body.detail');
    expect(rendered(content.bodyRef!)).toBe(content.body);
    expect(content.bodyRef?.args?.[0]).not.toContain('koniec');
  });

  it('zgoda z długą nazwą i długą etykietą → całość ≤ 120 i `ref` bez uciętej reszty', () => {
    const content = build({ detail: foreign('y '.repeat(100)), label: 'x'.repeat(80) });
    expect(content.body.length).toBeLessThanOrEqual(MESSAGE_MAX_CHARS);
    expect(content.bodyRef?.code).toBe('push.body.detail-and-label');
    expect(rendered(content.bodyRef!)).toBe(content.body);
  });

  it('markdown i nowa linia w krótkim szczególe: spłaszczone, `ref` bez pierwotnej treści', () => {
    const content = build({ kind: 'question', detail: foreign('**gotowe**\n- raz\n- dwa') });
    expect(content.body).toBe('gotowe raz dwa');
    expect(content.bodyRef).toEqual({ code: 'push.body.detail', args: ['gotowe raz dwa'] });
  });

  it('zdanie Raroga, którego tekst trzeba spłaszczyć albo przyciąć → sam tekst, bez `bodyRef`', () => {
    const multi = build({ cls: 'failure', kind: 'error', detail: say('state.herdr-launch-failed.reason', { reason: 'a\nb' }) });
    expect(multi.body).toBe("couldn't create the pane: a b");
    expect(multi).not.toHaveProperty('bodyRef');
    const long = build({
      cls: 'failure', kind: 'error', detail: say('state.herdr-launch-failed.reason', { reason: 'z'.repeat(300) }),
    });
    expect(long.body.length).toBeLessThanOrEqual(MESSAGE_MAX_CHARS);
    expect(long).not.toHaveProperty('bodyRef');
  });
});

describe('push próbny i sparowanie', () => {
  it('push próbny → `push.test-title` i `push.test-body`', () => {
    const content = buildTestContent();
    expect(content).toMatchObject({
      title: '🔔 Notifications are working', titleRef: { code: 'push.test-title' },
      body: 'Tapping this opens Rarog. Notifications from sessions take you straight to the session.',
      bodyRef: { code: 'push.test-body' },
    });
  });

  it('sparowanie na Macu → `push.paired-title` i `push.paired-body.mac`', () => {
    const content = buildDevicePairedContent('iPad·Rarog', 'macos');
    expect(content).toMatchObject({
      title: '🔐 New device paired', titleRef: { code: 'push.paired-title' },
      body: "iPad·Rarog. If this wasn't you, revoke it on the Mac: rarog devices",
      bodyRef: { code: 'push.paired-body.mac', args: ['iPad·Rarog'] },
    });
  });

  it('emoji na granicy cięcia nie zostawia samotnej połówki pary surogatów (body i bodyRef)', () => {
    const content = build({ cls: 'blocking', kind: 'question', detail: foreign(`${'x'.repeat(118)}😀more`) });
    expect(wellFormed(content.body)).toBe(true);
    for (const arg of content.bodyRef?.args ?? []) expect(wellFormed(arg)).toBe(true);
    const paired = buildDevicePairedContent(`x${'😀'.repeat(63)}`, 'macos');
    expect(wellFormed(paired.body)).toBe(true);
    for (const arg of paired.bodyRef?.args ?? []) expect(wellFormed(arg)).toBe(true);
  });

  it('sparowanie na VPS (Linux) → `push.paired-body.vps`', () => {
    const content = buildDevicePairedContent('iPhone', 'linux');
    expect(content.body).toBe("iPhone. If this wasn't you, revoke it on the VPS: rarog devices");
    expect(content.bodyRef).toEqual({ code: 'push.paired-body.vps', args: ['iPhone'] });
  });

  it('weekly limit → `push.weekly-limit-title` with the percent (int) and `push.weekly-limit-body` with the reset (instant)', () => {
    const reset = '2026-11-18T15:00:00.000Z';
    const content = buildWeeklyLimitContent(97, reset, Date.parse(reset) - 3 * 24 * 60 * 60 * 1000);
    expect(content).toMatchObject({
      title: '⚠️ Weekly limit at 97%', titleRef: { code: 'push.weekly-limit-title', args: ['97'] },
      body: `Resets ${reset}.`, bodyRef: { code: 'push.weekly-limit-body', args: [reset] },
    });
    expect(say('push.weekly-limit-title', { percent: 100 }).text).toBe('⚠️ Weekly limit at 100%');
    expect(say('push.weekly-limit-body', { reset: new Date(reset) }).ref)
      .toEqual({ code: 'push.weekly-limit-body', args: [reset] });
  });
});

// ---------------------------------------------------------------------------
// Tekst jawny formatu 3
// ---------------------------------------------------------------------------

const KEY = { pushKey: Buffer.alloc(32, 5).toString('base64url'), kid: 'f849d673' };

/** Lustro odbiorcy na `node:crypto`: otwarcie bloku `rarog` kluczem testowym. */
function openPlaintext(body: string): Record<string, unknown> {
  const { rarog } = JSON.parse(body) as { rarog: { kid: string; n: string; c: string } };
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(KEY.pushKey, 'base64url'), Buffer.alloc(0), Buffer.from(PUSH_KEY_INFO_V3), 32));
  const sealed = Buffer.from(rarog.c, 'base64url');
  const data = sealed.subarray(0, sealed.length - 16);
  const decipher = createDecipheriv('chacha20-poly1305', key, Buffer.from(rarog.n, 'base64url'), { authTagLength: 16 });
  decipher.setAAD(Buffer.from(`${PUSH_AAD_PREFIX_V3}${rarog.kid}`, 'utf8'), { plaintextLength: data.length });
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  return JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8').trimEnd()) as Record<string, unknown>;
}

const plaintextOf = (content: PushContent): Record<string, unknown> => {
  const request = apnsAlertRequestE2e(content, { topic: 'ai.rarog.app', nowMs: 0, key: KEY, sealer: createPushSealer() });
  if (request === undefined) throw new Error('ramka ponad 4096 B');
  return openPlaintext(request.body);
};

describe('tekst jawny: `titleRef` i `bodyRef` obok tekstu', () => {
  it('zgoda: oba `*Ref` po odszyfrowaniu', () => {
    const plain = plaintextOf(build({ detail: foreign('Edit'), label: 'zapis' }));
    expect(plain).toMatchObject({
      kind: 'permission', title: '⏳ Waiting for permission · rarog', titleRef: { code: 'push.title.permission', args: ['rarog'] },
      body: 'Edit — zapis', bodyRef: { code: 'push.body.detail-and-label', args: ['Edit', 'zapis'] },
    });
  });

  it('`done` dalej sama plakietka: bez tekstów i bez `*Ref`', () => {
    const plain = plaintextOf(build({ cls: 'done', kind: 'done', detail: foreign('ok'), badge: 1 }));
    expect(plain).not.toHaveProperty('title');
    expect(plain).not.toHaveProperty('titleRef');
    expect(plain).not.toHaveProperty('bodyRef');
  });

  it('ponad 2048 B → bez `*Ref`, także gdy przycięty zostaje sam tytuł', () => {
    // Projekt 1500 B: tytuł z `titleRef` to ok. 3000 B; treść krótka.
    const huge = plaintextOf(build({ project: 'ę'.repeat(750), detail: foreign('Bash'), label: 'x' }));
    expect(huge).not.toHaveProperty('titleRef');
    expect(huge).not.toHaveProperty('bodyRef');
    expect(Buffer.byteLength(JSON.stringify(huge))).toBeLessThanOrEqual(PUSH_PLAINTEXT_MAX_BYTES);
    // Sam tytuł ponad sufit: treść pusta, a tytuł przycięty — bez `titleRef`.
    const titleOnly: PushContent = { ...build({ project: 'ę'.repeat(1100) }), body: '' };
    const plain = plaintextOf(titleOnly);
    expect(String(plain.title).endsWith('…')).toBe(true);
    expect(plain).not.toHaveProperty('titleRef');
    expect(plain).not.toHaveProperty('bodyRef');
  });
});

// ---------------------------------------------------------------------------
// Harmonogram: `*Ref` właściwego zdarzenia przez kolejkę
// ---------------------------------------------------------------------------

/** Minimalny zegar harmonogramu (wstrzykiwane timery; wzór z `notify-harmonogram.test.ts`). */
class Clock {
  now = 1_700_000_000_000;
  #next = 1;
  readonly #jobs = new Map<number, { at: number; cb: () => void }>();
  readonly set = (cb: () => void, ms: number): unknown => {
    const id = this.#next++;
    this.#jobs.set(id, { at: this.now + ms, cb });
    return id;
  };
  readonly clear = (handle: unknown): void => { this.#jobs.delete(handle as number); };
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.#jobs].filter(([, job]) => job.at <= target).sort(([, a], [, b]) => a.at - b.at)[0];
      if (due === undefined) break;
      this.#jobs.delete(due[0]);
      this.now = due[1].at;
      due[1].cb();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    this.now = target;
  }
}

function harness(): {
  notifier: Notifier; clock: Clock; sent: PushContent[];
  setLook: (patch: Partial<SessionLook>) => void; note: (input: Omit<NoteInput, 'sessionId' | 'project'>) => void;
} {
  const clock = new Clock();
  const sent: PushContent[] = [];
  let look: SessionLook = { state: 'waiting-input', seen: false, backgroundTasks: 0, waitingOnOwnCommand: false };
  const notifier = new Notifier({
    presence: new Presence({ now: () => clock.now }),
    sink: { send: (content) => { sent.push(content); return Promise.resolve({ channels: { apns: 'delivered' } }); } },
    look: () => look,
    setTimeout: clock.set,
    clearTimeout: clock.clear,
  });
  return {
    notifier, clock, sent,
    setLook: (patch) => { look = { ...look, ...patch }; },
    note: (input) => { notifier.note({ sessionId: SESSION, project: 'rarog', ...input }); },
  };
}

describe('harmonogram niesie `*Ref` właściwego zdarzenia', () => {
  it('błąd sesji ze zdaniem Raroga → wysłana treść z `bodyRef` szczegółu', async () => {
    const h = harness();
    h.setLook({ state: 'error' as SessionState });
    h.note({ event: { type: 'result', subtype: 'error' }, backgroundTasks: 0, detail: say('state.driver-error') });
    await h.clock.advance(FIRST_CHECK_MS.failure + 1);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ kind: 'error', bodyRef: { code: 'state.driver-error' } });
  });

  it('nowsze zdarzenie zastępuje czekające: wychodzi `bodyRef` nowszego', async () => {
    const h = harness();
    h.setLook({ state: 'error' as SessionState });
    h.note({ event: { type: 'result', subtype: 'error' }, backgroundTasks: 0, detail: say('state.driver-error') });
    await h.clock.advance(1_000);
    h.setLook({ state: 'limit-reached' });
    h.note({ event: { type: 'limit-reached' }, backgroundTasks: 0, detail: say('state.limit-reached', { reset: RESET }) });
    await h.clock.advance(FIRST_CHECK_MS.failure + 1);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.bodyRef).toEqual({ code: 'state.limit-reached', args: [RESET] });
  });

  it('zaległe „gotowe” wysłane później z kolejki (cisza w tle) zachowuje `bodyRef` swojej tury', async () => {
    const h = harness();
    const HUMAN = { standbyNotices: 0, artifactWatch: 0, other: 1, toolCalls: 0, compactions: 0 };
    // Tura z wynikiem przy pracującym tle: cisza, wynik zostaje zaległy.
    h.setLook({ backgroundTasks: 1 });
    h.note({ event: { type: 'agent-idle' }, backgroundTasks: 1, turnInput: HUMAN, detail: foreign('Wynik A') });
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(h.sent).toHaveLength(0);
    // Tło ucichło bez nowej tury: wychodzi zaległy wynik z treścią tamtej tury.
    h.setLook({ backgroundTasks: 0 });
    h.notifier.quiet(SESSION);
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.bodyRef).toEqual({ code: 'push.body.detail', args: ['Wynik A'] });
  });
});
