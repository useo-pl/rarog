/**
 * The form fallback of the herdr driver (`drivers/herdr/form-reserve.ts`): an `AskUserQuestion` form that herdr
 * reports as `idle`/`done`. The tests drive the module through the driver facade on the shared fakes
 * (`helpers/herdr-driver-atrapy.ts`): the fallback only means something next to the driver's evaluation and card.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HerdrDriverDeps } from '../src/drivers/herdr-driver.ts';
import { ANSWERED_HOOK_SHIELD_MS } from '../src/herdr/dialogs/timing.ts';
import type { HerdrClient } from '../src/herdr/types.ts';
import type { PendingHookTool } from '../src/herdr/dialogs/hook/dump.ts';
import {
  FIXTURES, NIE_DIALOG, cleared, drivenClock, makeDriver, questions, quiet, reads, screenDialogs, states, systemCodes,
  systemTexts, toolResultLine, toolUseLine, useDriverSandbox, userLine, waitFor,
} from './helpers/herdr-driver-atrapy.ts';
import type { Call, Fixture } from './helpers/herdr-driver-atrapy.ts';

useDriverSandbox();

const DIALOG_MULTIQ_REVIEW =
  readFileSync(join(FIXTURES, 'dialog-askuserquestion-multiq-review.txt'), 'utf8');

describe('formularz pytania bez blokady herdr (rezerwa)', () => {
  /*
   * CLI 2.1.281 po `/rename` rysuje pod stopką formularza linię z nazwą sesji, a herdr melduje
   * wtedy `done`/`idle` zamiast `blocked` (zmierzone na CLI 2.1.281). Rarog rozpoznaje formularz
   * sam: czekający `AskUserQuestion` (jsonl albo zrzut hooka) + formularz na ekranie.
   */
  const FORM = readFileSync(join(FIXTURES, 'dialog-askuserquestion-linia-nazwy-2.1.281.txt'), 'utf8');
  const INPUT = {
    questions: [
      {
        question: 'Jaki smak lodow?', header: 'Smak', multiSelect: false,
        options: [{ label: 'Wanilia' }, { label: 'Czekolada' }, { label: 'Truskawka' }],
      },
      {
        question: 'Jaki kubek?', header: 'Kubek', multiSelect: false,
        options: [{ label: 'Maly' }, { label: 'Duzy' }],
      },
    ],
  };
  const KEY = '04556810-fb47-4dd5-9cb5-90693e37bf04-0123456789abcdef-feedfacecafebeef';
  const dump = (): PendingHookTool => ({
    toolName: 'AskUserQuestion', toolInput: INPUT, at: 21,
    hookEventName: 'PermissionRequest', answerKey: KEY,
  } as unknown as PendingHookTool);

  class FakeAnswers {
    written: { key: string; answers: Record<string, string> }[] = [];
    write(_sessionId: string, key: string, answers: Record<string, string>): string | null {
      this.written.push({ key, answers });
      return `/nieistotna/${key}.json`;
    }
    pending(_path: string): boolean { return false; }
    clear(_path: string): void { /* atrapa */ }
  }

  const base: Partial<HerdrDriverDeps> = {
    formFallbackRetryDelaysMs: [], screenAnswerRearmDelaysMs: [],
    hookAnswerWaitMs: 20, hookAnswerPollMs: 1,
  };
  const prompts = (fx: Fixture): Call[] => fx.client.calls.filter((c) => c.method === 'prompt');

  /** Formularz stoi, herdr melduje `done` — przebieg z pomiaru na CLI 2.1.281. */
  async function standingForm(deps: Partial<HerdrDriverDeps> = {}): Promise<Fixture> {
    const fx = await makeDriver({ transcript: userLine('zapytaj mnie'), deps: { ...base, ...deps } });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.client.screenText = FORM;
    await appendFile(fx.transcript, toolUseLine('toolu_form', 'AskUserQuestion', INPUT));
    fx.emit({ type: 'status', status: 'done', stateChangeSeq: 8, title: '' });
    await waitFor(() => questions(fx.events).length > 0, 'karta pytania');
    return fx;
  }

  it('formularz przy `done` → karta pytania i stan `blocked`; odpowiedź jedzie PLIKIEM', async () => {
    const answers = new FakeAnswers();
    const fx = await standingForm({ readPendingHook: () => dump(), hookAnswers: answers });
    expect(states(fx.events).at(-1)?.state).toBe('blocked');

    const card = questions(fx.events)[0]!;
    const outcome = await fx.driver.answerQuestion(card.reqId, [['Czekolada'], ['Duzy']]);
    expect(outcome.kind).toBe('applied');
    expect(answers.written).toEqual([{
      key: KEY, answers: { 'Jaki smak lodow?': 'Czekolada', 'Jaki kubek?': 'Duzy' },
    }]);
    expect(fx.client.mutations, 'żadnego klawisza do panelu').toBe(0);

    // CLI domyka wywołanie i idzie dalej; koniec tury niesie `seen: false` jak zawsze.
    fx.client.screenText = '❯';
    await appendFile(fx.transcript, toolResultLine('toolu_form'));
    fx.emit({ type: 'status', status: 'working', stateChangeSeq: 9, title: '' });
    await waitFor(() => states(fx.events).at(-1)?.state === 'working', 'tura');
    fx.emit({ type: 'status', status: 'done', stateChangeSeq: 10, title: '' });
    await waitFor(() => states(fx.events).at(-1)?.state === 'idle', 'koniec tury');
    await quiet();
    expect(states(fx.events).at(-1)).toMatchObject({ state: 'idle', seen: false });
    expect(questions(fx.events)).toHaveLength(1);
  });

  it('bez zrzutu hooka karta jest cyfrowa, a cyfra przechodzi przez żywy ekran', async () => {
    const fx = await standingForm();
    const card = questions(fx.events)[0]!;

    await expect(fx.driver.answerQuestion(card.reqId, [['Czekolada']]))
      .resolves.toEqual({ kind: 'applied' });

    const approvals = fx.audit.filter((e) => e.method === 'approve');
    expect(approvals.map((e) => [e.keys, e.optionLabel])).toEqual([[['2'], 'Czekolada']]);
  });

  /*
   * Pusta grupa odpowiedzi przy formularzu bez żadnego checkboxa to nie `multi-select`
   * („Wielokrotny wybór zrób w terminalu"), tylko `no-digit` z własnym
   * zdaniem, a dziennik niesie KSZTAŁT odpowiedzi — same liczby, bez treści.
   */
  it('pusta grupa odpowiedzi to `no-digit` z kształtem w dzienniku, nie „multi-select"', async () => {
    const fx = await standingForm();
    const card = questions(fx.events)[0]!;

    await expect(fx.driver.answerQuestion(card.reqId, [[]]))
      .resolves.toEqual({ kind: 'refused', reason: 'no-digit' });
    expect(fx.client.mutations).toBe(0);
    expect(fx.audit.filter((e) => e.method === 'refuse').at(-1)).toMatchObject({
      reason: 'no-digit',
      shape: { channel: 'keys', hookTarget: false, answers: 1, target: 0, index: 0, groups: [0] },
    });
    expect(systemTexts(fx.events).at(-1)).toContain("There's no answer to the question");
  });

  it('ekran przeglądu odpowiedzi („Submit answers") nie gasi rezerwy', async () => {
    const fx = await standingForm({
      blockedPollMs: 5, screenCacheMs: 0, screenAnswerRearmDelaysMs: [5],
    });
    // Ostatnia zakładka odpowiedziana cyfrą — CLI pokazuje przegląd, herdr dalej `done`.
    const card = questions(fx.events)[0]!;
    await expect(fx.driver.answerQuestion(card.reqId, [['Wanilia']]))
      .resolves.toEqual({ kind: 'applied' });
    fx.client.screenText = DIALOG_MULTIQ_REVIEW;
    await waitFor(() => questions(fx.events).length > 1, 'karta przeglądu');
    await quiet();
    expect(states(fx.events).at(-1)?.state).toBe('blocked');
    expect(questions(fx.events).at(-1)?.questions[0]?.options.map((o) => o.label))
      .toEqual(['Submit answers', 'Cancel']);
  });

  it('herdr przejmuje blokadę → ta sama karta, zero gaszenia, zero pośredniego `idle`', async () => {
    const fx = await standingForm({ readPendingHook: () => dump(), hookAnswers: new FakeAnswers() });
    const statesBefore = states(fx.events).length;

    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 9, title: '' });
    await quiet();
    await quiet();

    expect(cleared(fx.events)).toEqual([]);
    expect(questions(fx.events)).toHaveLength(1);
    expect(states(fx.events).slice(statesBefore).map((s) => s.state)).not.toContain('idle');
    expect(states(fx.events).at(-1)?.state).toBe('blocked');
  });

  it('herdr `working` w trakcie rezerwy → jedno przejście do `working`, karta gaśnie', async () => {
    const fx = await standingForm();
    const statesBefore = states(fx.events).length;
    fx.client.screenText = '❯';

    fx.emit({ type: 'status', status: 'working', stateChangeSeq: 9, title: '' });
    await waitFor(() => cleared(fx.events).length > 0, 'zgaszenie');
    await quiet();

    expect(states(fx.events).slice(statesBefore).map((s) => s.state)).toEqual(['working']);
  });

  it('jedno pudło ekranu nie gasi karty; dwa KOLEJNE gaszą; błąd odczytu niczego nie liczy', async () => {
    const clock = drivenClock();
    const fx = await makeDriver({
      transcript: userLine('zapytaj mnie'),
      deps: { ...base, scheduler: clock.scheduler, blockedPollMs: 8, screenCacheMs: 1 },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.client.screenText = FORM;
    await appendFile(fx.transcript, toolUseLine('toolu_form', 'AskUserQuestion', INPUT));
    // Wpis czyta prawdziwy follower (`fs/promises`, poza sterowanym zegarem): pod obciążeniem wejścia-wyjścia pętla
    // obrotów zegara niżej kończyła się przed jego odczytem, a `history` stało już od podpięcia.
    await waitFor(() => fx.events.some((e) => e.type === 'message' && e.role === 'assistant'), 'wpis');
    fx.emit({ type: 'status', status: 'done', stateChangeSeq: 8, title: '' });
    for (let i = 0; i < 20 && questions(fx.events).length === 0; i += 1) await clock.advance(20);
    expect(questions(fx.events)).toHaveLength(1);

    // Odczyt rzuca (gniazdo) — to nie jest dowód zniknięcia formularza.
    const reader = fx.client.readScreen.bind(fx.client);
    (fx.client as { readScreen: HerdrClient['readScreen'] }).readScreen =
      () => Promise.reject(new Error('gniazdo'));
    await clock.advance(40);
    expect(cleared(fx.events)).toEqual([]);

    (fx.client as { readScreen: HerdrClient['readScreen'] }).readScreen = reader;
    fx.client.screenText = NIE_DIALOG;
    await clock.advance(8);
    expect(cleared(fx.events), 'jedno pudło').toEqual([]);
    await clock.advance(8);
    expect(cleared(fx.events)).toHaveLength(1);
    expect(states(fx.events).at(-1)?.state).toBe('idle');
  });

  it('osierocony `tool_use` bez formularza: odczyty w budżecie, resync go nie odnawia', async () => {
    const fx = await makeDriver({
      transcript: userLine('zapytaj mnie') + toolUseLine('toolu_sierota', 'AskUserQuestion', INPUT),
      deps: { ...base },
    });
    fx.client.screenText = NIE_DIALOG;
    await waitFor(() => reads(fx.client) > 0, 'pierwsza próba');
    await quiet();
    const afterEntry = reads(fx.client);

    // Resync powtarza ten sam status z tym samym numerem — budżet stoi.
    for (let i = 0; i < 5; i += 1) {
      fx.emit({ type: 'status', status: 'idle', stateChangeSeq: 7, title: 'refaktor' });
      await quiet();
    }
    expect(reads(fx.client)).toBe(afterEntry);

    // Prawdziwa zmiana statusu (nowy numer) = jedna nowa próba.
    fx.emit({ type: 'status', status: 'done', stateChangeSeq: 8, title: 'refaktor' });
    await quiet();
    await quiet();
    expect(reads(fx.client)).toBe(afterEntry + 1);
    expect(questions(fx.events)).toEqual([]);
    expect(states(fx.events).map((s) => s.state)).not.toContain('blocked');
  });

  it('zmiana statusu w trakcie odczytu ekranu → wynik odczytu odrzucony', async () => {
    const fx = await makeDriver({ transcript: userLine('zapytaj mnie'), deps: { ...base } });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    let release: (() => void) | null = null;
    const reader = fx.client.readScreen.bind(fx.client);
    (fx.client as { readScreen: HerdrClient['readScreen'] }).readScreen = (...args) =>
      new Promise((resolve) => {
        release = () => { void reader(...args).then(resolve); };
      });
    fx.client.screenText = FORM;
    await appendFile(fx.transcript, toolUseLine('toolu_form', 'AskUserQuestion', INPUT));
    fx.emit({ type: 'status', status: 'done', stateChangeSeq: 8, title: '' });
    await waitFor(() => release !== null, 'odczyt w toku');

    fx.emit({ type: 'status', status: 'working', stateChangeSeq: 9, title: '' });
    (release as unknown as () => void)();
    await quiet();
    await quiet();

    expect(questions(fx.events)).toEqual([]);
    expect(states(fx.events).at(-1)?.state).toBe('working');
  });

  it('sam zrzut hooka (wpisu w jsonl jeszcze nie ma) wystarcza, gdy ekran pokazuje formularz', async () => {
    const fx = await makeDriver({
      transcript: userLine('zapytaj mnie'),
      deps: { ...base, readPendingHook: () => dump(), hookAnswers: new FakeAnswers() },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.client.screenText = FORM;
    fx.emit({ type: 'status', status: 'done', stateChangeSeq: 8, title: '' });
    await waitFor(() => questions(fx.events).length > 0, 'karta z hooka');
    expect(states(fx.events).at(-1)?.state).toBe('blocked');
  });

  it('wysyłka i `setMode` przy stojącym formularzu nie wychodzą — także przed wejściem rezerwy', async () => {
    const fx = await standingForm();
    fx.driver.send('to nie jest odpowiedź');
    fx.driver.setMode?.('plan');
    await waitFor(() => systemCodes(fx.events).includes('commands.send-held.form'), 'zdanie');
    await quiet();
    expect(prompts(fx)).toEqual([]);
    expect(fx.client.calls.filter((c) => c.method === 'mode_cycle')).toEqual([]);

    // Przed wejściem: budżet próby zużyty na ekranie bez formularza, formularz dorysował się
    // później, a zdarzenia jeszcze nie było — bramka wysyłki czyta ekran sama.
    const early = await makeDriver({
      transcript: userLine('start') + toolUseLine('toolu_x', 'AskUserQuestion', INPUT),
      deps: { ...base },
    });
    early.client.screenText = NIE_DIALOG;
    await waitFor(() => reads(early.client) > 0, 'próba wejścia');
    await quiet();
    early.client.screenText = FORM;
    early.driver.send('za wcześnie');
    await waitFor(
      () => systemCodes(early.events).includes('commands.send-held.form'), 'zdanie',
    );
    expect(prompts(early)).toEqual([]);
  });

  it('herdr `working`, stojący dialog zgody, którego herdr nie widzi, i panel poza zasięgiem — rezerwa nie wchodzi', async () => {
    const working = await makeDriver({
      transcript: userLine('start') + toolUseLine('toolu_w', 'AskUserQuestion', INPUT),
      agent: { status: 'working' }, deps: { ...base },
    });
    working.client.screenText = FORM;
    await waitFor(() => working.events.some((e) => e.type === 'history'), 'historia');
    await quiet();
    await quiet();
    expect(questions(working.events)).toEqual([]);
    expect(reads(working.client)).toBe(0);

    const outside = await makeDriver({
      transcript: userLine('start') + toolUseLine('toolu_o', 'AskUserQuestion', INPUT),
      agent: { inScope: false }, deps: { ...base },
    });
    outside.client.screenText = FORM;
    outside.emit({ type: 'status', status: 'done', stateChangeSeq: 8, title: '' });
    await quiet();
    await quiet();
    expect(questions(outside.events)).toEqual([]);
    expect(reads(outside.client)).toBe(0);
  });

  /** Formularz z rezerwą na STEROWANYM zegarze — dla testów, które liczą obroty oceny. */
  async function drivenForm(
    clock: ReturnType<typeof drivenClock>, deps: Partial<HerdrDriverDeps> = {},
  ): Promise<Fixture> {
    const fx = await makeDriver({
      transcript: userLine('zapytaj mnie'),
      deps: { ...base, scheduler: clock.scheduler, blockedPollMs: 8, screenCacheMs: 1, ...deps },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    await appendFile(fx.transcript, toolUseLine('toolu_form', 'AskUserQuestion', INPUT));
    for (let i = 0; i < 50 && !fx.events.some((e) => e.type === 'agent-state'); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    return fx;
  }

  it('dialog zgody CLI przejmuje panel w trakcie rezerwy — jego karta zostaje', async () => {
    const consent = readFileSync(join(FIXTURES, 'dialog-automode-teach-2.1.258.txt'), 'utf8');
    const fx = await standingForm({ blockedPollMs: 5, screenCacheMs: 0 });

    fx.client.screenText = consent;
    fx.emit({ type: 'consent-dialog', dialog: 'auto-mode-teach' });
    await waitFor(
      () => screenDialogs(fx.events).some((d) => d.reason === 'consent-dialog'), 'karta zgody',
    );
    // Kilka obrotów zegara oceny: rezerwa ma zejść, ale NIE zabrać karty zgody.
    await quiet();
    await quiet();
    expect(cleared(fx.events).map((c) => c.reqId).filter((id) => id?.startsWith('consent:') === true))
      .toEqual([]);
    expect(states(fx.events).at(-1)?.state).toBe('blocked');
  });

  it('pudła tuż po WŁASNEJ cyfrze nie gaszą rezerwy; po terminie osłony już tak', async () => {
    const clock = drivenClock();
    const fx = await standingFormDriven(clock, { screenAnswerRearmDelaysMs: [5, 10] });
    const card = questions(fx.events)[0]!;

    const answered = fx.driver.answerQuestion(card.reqId, [['Czekolada']]);
    await clock.advance(1);
    await expect(answered).resolves.toEqual({ kind: 'applied' });

    // CLI przemalowuje formularz dłużej niż dwa obroty oceny — to nie jest jego koniec.
    fx.client.screenText = NIE_DIALOG;
    await clock.advance(40);
    expect(states(fx.events).at(-1)?.state).toBe('blocked');

    // Formularz wraca (następna zakładka) bez żadnej zmiany statusu herdr — karta też wraca. Zakładka
    // MUSI być inna: ta sama zakładka po cyfrze to cyfra zgubiona przez CLI i od osłony po własnej
    // decyzji wraca dopiero po `DECIDED_SHIELD_MS`.
    fx.client.screenText = FORM
      .replace('←  ☐ Smak  ☐ Kubek', '←  ☒ Smak  ☐ Kubek')
      // Sama linia pytania — to samo zdanie stoi też w treści promptu nad formularzem.
      .replace('\nJaki smak lodow?\n', '\nJaki kubek?\n')
      .replace(
        '❯ 1. Wanilia\n     Wanilia\n  2. Czekolada\n     Czekolada\n  3. Truskawka\n     Truskawka\n  4. Type something.',
        '❯ 1. Maly\n     Maly\n  2. Duzy\n     Duzy\n  3. Type something.',
      )
      .replace('  5. Chat about this', '  4. Chat about this');
    await clock.advance(20);
    expect(questions(fx.events)).toHaveLength(2);
    expect(questions(fx.events).at(-1)?.questions.some((q) => q.question === 'Jaki kubek?')).toBe(true);

    // Po terminie osłony (np. Esc przy biurku, bez `working`) pudła znów gaszą rezerwę.
    fx.client.screenText = NIE_DIALOG;
    await clock.advance(ANSWERED_HOOK_SHIELD_MS + 40);
    expect(states(fx.events).at(-1)?.state).toBe('idle');
  });

  it('ponowienie wejścia na timerach: pierwszy odczyt za wcześnie, drugi widzi formularz', async () => {
    const clock = drivenClock();
    const fx = await drivenForm(clock, { formFallbackRetryDelaysMs: [30, 90] });
    fx.client.screenText = NIE_DIALOG;
    fx.emit({ type: 'status', status: 'done', stateChangeSeq: 8, title: '' });
    await clock.advance(20);
    expect(questions(fx.events)).toEqual([]);

    fx.client.screenText = FORM;
    await clock.advance(20);
    expect(questions(fx.events)).toHaveLength(1);
    expect(states(fx.events).at(-1)?.state).toBe('blocked');
  });

  /** `standingForm` na sterowanym zegarze: formularz stoi, herdr `done`, karta już jest. */
  async function standingFormDriven(
    clock: ReturnType<typeof drivenClock>, deps: Partial<HerdrDriverDeps> = {},
  ): Promise<Fixture> {
    const fx = await drivenForm(clock, deps);
    fx.client.screenText = FORM;
    fx.emit({ type: 'status', status: 'done', stateChangeSeq: 8, title: '' });
    for (let i = 0; i < 20 && questions(fx.events).length === 0; i += 1) await clock.advance(20);
    expect(questions(fx.events)).toHaveLength(1);
    return fx;
  }

  it('driver podpięty nad STOJĄCYM formularzem (restart Raroga) stawia kartę', async () => {
    const fx = await makeDriver({
      transcript: userLine('zapytaj mnie') + toolUseLine('toolu_form', 'AskUserQuestion', INPUT),
      screen: FORM, deps: { ...base },
    });
    await waitFor(() => questions(fx.events).length > 0, 'karta po restarcie');
    expect(states(fx.events).at(-1)?.state).toBe('blocked');
  });
});
