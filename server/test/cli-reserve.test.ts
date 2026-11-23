/**
 * The CLI registry fallback of the herdr driver (`drivers/herdr/cli-reserve.ts`): a dialog the CLI session
 * registry reports as `waiting` while herdr does not see a block. The tests drive the module through the driver
 * facade on the shared fakes (`helpers/herdr-driver-atrapy.ts`): the registry only nudges the driver's evaluation.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DriverEvent, SessionDriver } from '../src/drivers/types.ts';
import type { HerdrDriverDeps } from '../src/drivers/herdr-driver.ts';
import { ANSWERED_HOOK_SHIELD_MS } from '../src/herdr/dialogs/timing.ts';
import type { HerdrAgentInfo, HerdrClient } from '../src/herdr/types.ts';
import type { PendingHookTool } from '../src/herdr/dialogs/hook/dump.ts';
import {
  FIXTURES, PANE, SESSION, cleared, composerPane, makeDriver, pasteFlow, permissions, questions, quiet, reads,
  screenDialogs, states, systemCodes, toolUseLine, useDriverSandbox, userLine, waitFor,
} from './helpers/herdr-driver-atrapy.ts';
import type { Call, Fixture } from './helpers/herdr-driver-atrapy.ts';

useDriverSandbox();

describe('dialog zgłoszony przez rejestr sesji CLI', () => {
  /*
   * herdr 0.9.3 melduje `working` nad formularzem z podglądem i nad „Exit plan mode?” (pomiar
   * na CLI 2.1.293: po dwie minuty), a rejestr `~/.claude/sessions/<pid>.json` mówi
   * wtedy `waiting`.
   * Rejestr jest SZTURCHNIĘCIEM: budzi ocenę ekranu, a kartę i cyfry daje dalej ekran.
   */
  const measured = (name: string): string =>
    readFileSync(join(FIXTURES, 'measured', name), 'utf8');
  const PREVIEW = measured('pytanie-preview-2.1.293.txt');
  const EXIT_PLAN = measured('exitplanmode-bez-planu-2.1.293.txt');
  const LOGIN = readFileSync(join(FIXTURES, 'ekran-login-2.1.293.txt'), 'utf8');
  /** Panel w turze albo bezczynny: pole promptu w ramce — jedyny dowód „dialogu NIE MA". */
  const COMPOSER = [
    '⏺ Gotowe.', '', '─'.repeat(40), '❯ ', '─'.repeat(40), '  ⏵⏵ auto mode on (shift+tab to cycle)',
  ].join('\n');
  const PREVIEW_INPUT = {
    questions: [{
      question: 'Jaki uklad listy?', header: 'Uklad listy', multiSelect: false,
      options: [
        { label: 'Dwie kolumny obok siebie z podgladem (Rekomendowane)', preview: '+--------+' },
        { label: 'Jedna kolumna', preview: '+--------+' },
        { label: 'Bez listy', preview: '(pusto)' },
      ],
    }],
  };
  const KEY = '0f0e0d0c-0b0a-4908-8706-050403020100-0123456789abcdef-feedfacecafebeef';
  const WAITING_INPUT = { kind: 'waiting', dialog: 'input' } as const;
  const WAITING_PERMISSION = { kind: 'waiting', dialog: 'permission' } as const;
  const ACTIVE = { kind: 'active' } as const;

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
    blockedPollMs: 5, screenCacheMs: 0, formFallbackRetryDelaysMs: [],
    screenAnswerRearmDelaysMs: [5], hookAnswerWaitMs: 20, hookAnswerPollMs: 1,
  };
  const prompts = (fx: Fixture): Call[] => fx.client.calls.filter((c) => c.method === 'prompt');
  const note = (fx: Fixture, signal: Parameters<NonNullable<SessionDriver['noteCliWaiting']>>[0]) => {
    fx.driver.noteCliWaiting?.(signal);
  };

  /** Formularz z podglądem stoi, herdr melduje `working`, hook czeka na plik (jak w pomiarze na CLI 2.1.293). */
  async function standingPreview(deps: Partial<HerdrDriverDeps> = {}): Promise<{
    fx: Fixture; answers: FakeAnswers;
  }> {
    const answers = new FakeAnswers();
    let hook: PendingHookTool | null = {
      toolName: 'AskUserQuestion', toolInput: PREVIEW_INPUT, at: 31,
      hookEventName: 'PermissionRequest', answerKey: KEY,
    } as unknown as PendingHookTool;
    const fx = await makeDriver({
      transcript: userLine('zapytaj mnie'),
      agent: { status: 'working' },
      deps: {
        ...base, hookAnswers: answers,
        readPendingHook: () => hook,
        clearPendingHook: () => { hook = null; },
        ...deps,
      },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    // Od CLI 2.1.267 `tool_use` formularza stoi w jsonl, zanim dialog stanie.
    await appendFile(fx.transcript, toolUseLine('toolu_preview', 'AskUserQuestion', PREVIEW_INPUT));
    fx.client.screenText = PREVIEW;
    note(fx, WAITING_INPUT);
    await waitFor(() => questions(fx.events).length > 0, 'karta pytania z rejestru');
    return { fx, answers };
  }

  it('(a) herdr `working` + rejestr `waiting` + formularz z podglądem → karta pytania (kanał hooka)',
    async () => {
      const { fx } = await standingPreview();
      const card = questions(fx.events)[0]!;
      expect(card.channel).toBe('hook');
      expect(card.questions[0]?.options.map((o) => o.label)).toContain(
        'Dwie kolumny obok siebie z podgladem (Rekomendowane)',
      );
      expect(states(fx.events).at(-1)?.state).toBe('blocked');
      expect(fx.client.mutations, 'rejestr nie wysyła ani jednego klawisza').toBe(0);
    });

  it('(b) „Exit plan mode?” przy herdr `working` → karta zgody `ExitPlanMode`', async () => {
    const fx = await makeDriver({
      transcript: userLine('wyjdź z planu'), agent: { status: 'working' }, deps: { ...base },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.client.screenText = EXIT_PLAN;
    note(fx, WAITING_PERMISSION);
    await waitFor(() => permissions(fx.events).length > 0, 'karta zgody');
    const card = permissions(fx.events)[0]!;
    expect(card.toolName).toBe('ExitPlanMode');
    expect(card.input).not.toBeNull();
    expect(states(fx.events).at(-1)?.state).toBe('blocked');
  });

  it('(c) po WŁASNEJ odpowiedzi rejestr jeszcze stoi na `waiting` → bez karty-ducha i bez nowego `blocked`',
    async () => {
      const { fx, answers } = await standingPreview();
      const card = questions(fx.events)[0]!;
      await expect(fx.driver.answerQuestion(card.reqId, [['Jedna kolumna']]))
        .resolves.toEqual({ kind: 'applied' });
      expect(answers.written).toHaveLength(1);
      const after = fx.events.length;

      // Formularz jeszcze chwilę wisi na ekranie, rejestr dalej mówi `waiting` (hook i lag tiku).
      for (let i = 0; i < 4; i += 1) {
        note(fx, WAITING_INPUT);
        await quiet();
      }
      fx.client.screenText = COMPOSER;
      for (let i = 0; i < 4; i += 1) {
        note(fx, WAITING_INPUT);
        await quiet();
      }
      const tail = fx.events.slice(after);
      expect(questions(tail), 'karta-duch').toEqual([]);
      expect(permissions(tail)).toEqual([]);
      expect(screenDialogs(tail)).toEqual([]);
      // Manager po odpowiedzi stoi w `waiting-permission`; `working` → `blocked` dałoby drugi push.
      expect(states(tail).map((s) => s.state)).not.toContain('working');

      // Rejestr wraca do `busy` — tura rusza, jedno przejście.
      note(fx, ACTIVE);
      await waitFor(() => states(fx.events).at(-1)?.state === 'working', 'tura po odpowiedzi');
      await quiet();
      expect(states(fx.events.slice(after)).map((s) => s.state)).toEqual(['working']);
      expect(questions(fx.events)).toHaveLength(1);
    });

  it('(c) cyfra z telefonu przy blokadzie herdr: `working` po niej nie wraca do `blocked` mimo `waiting`',
    async () => {
      const fx = await makeDriver({ transcript: userLine('wyjdź z planu'), deps: { ...base } });
      await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
      fx.client.screenText = EXIT_PLAN;
      fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
      await waitFor(() => permissions(fx.events).length > 0, 'karta z blokady herdr');
      note(fx, WAITING_PERMISSION);
      const card = permissions(fx.events)[0]!;
      await expect(fx.driver.respondPermission(card.reqId, 'allow'))
        .resolves.toEqual({ kind: 'applied' });
      const after = fx.events.length;

      // CLI rusza dalej, herdr melduje `working`, a rejestr jeszcze nie zdążył zejść z `waiting`.
      fx.client.screenText = COMPOSER;
      fx.emit({ type: 'status', status: 'working', stateChangeSeq: 9, title: '' });
      for (let i = 0; i < 4; i += 1) {
        note(fx, WAITING_PERMISSION);
        await quiet();
      }
      const tail = fx.events.slice(after);
      expect(states(tail).map((s) => s.state)).toEqual(['working']);
      expect(permissions(tail)).toEqual([]);
      expect(screenDialogs(tail)).toEqual([]);
    });

  it('(d) rejestr `waiting` + ekran nieczytelny (`/login`) → karta bez decyzji z klasą', async () => {
    const fx = await makeDriver({ transcript: userLine('start'), deps: { ...base } });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.client.screenText = LOGIN;
    note(fx, { kind: 'waiting', dialog: 'dialog' });
    await waitFor(() => screenDialogs(fx.events).length > 0, 'karta bez decyzji');
    const card = screenDialogs(fx.events)[0]!;
    expect(card.knownDialog).toBeUndefined();
    expect(card.reason).toBe('unreadable');
    expect(card.cliDialog).toBe('dialog');
    expect(states(fx.events).at(-1)?.state).toBe('blocked');
    expect(fx.audit.filter((e) => e.method === 'degrade').at(-1))
      .toMatchObject({ reason: 'unreadable', cliDialog: 'dialog' });
    expect(fx.client.mutations).toBe(0);
  });

  it('(e, f) „nie wiem" (dwóch pisarzy) i brak sygnału (`RAROG_CLI_WAITING=0`) = jak przed etapem C',
    async () => {
      const fx = await makeDriver({
        transcript: userLine('start') + toolUseLine('toolu_p', 'AskUserQuestion', PREVIEW_INPUT),
        agent: { status: 'working' }, deps: { ...base },
      });
      fx.client.screenText = PREVIEW;
      await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
      await quiet();
      note(fx, { kind: 'unknown' });
      await quiet();
      await quiet();
      expect(questions(fx.events)).toEqual([]);
      expect(reads(fx.client), 'bez sygnału ekranu się nie czyta').toBe(0);
      expect(states(fx.events).map((s) => s.state)).not.toContain('blocked');
    });

  /*
   * Tik rejestru co 1,5 s bywa wolniejszy niż ocena po herdr
   * `blocked`, więc karta bez decyzji staje często PRZED pierwszym `waiting`, a ten sam ekran
   * przy kolejnych ocenach to `KEEP`. Klasa dochodzi wtedy osobnym zdarzeniem `cli-dialog` —
   * bez nowej karty, bez wpisu `degrade` i bez klawisza.
   */
  const cliDialogs = (events: readonly DriverEvent[]): Extract<DriverEvent, { type: 'cli-dialog' }>[] =>
    events.filter((e): e is Extract<DriverEvent, { type: 'cli-dialog' }> => e.type === 'cli-dialog');

  it('(i) karta bez decyzji sprzed pierwszego `waiting` dostaje klasę z późniejszego tiku; „nie wiem" ją zdejmuje',
    async () => {
      const fx = await makeDriver({ transcript: userLine('start'), deps: { ...base } });
      await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
      fx.client.screenText = LOGIN;
      fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
      await waitFor(() => screenDialogs(fx.events).length > 0, 'karta z blokady herdr');
      expect(screenDialogs(fx.events)[0]!.cliDialog).toBeUndefined();
      const degrades = fx.audit.filter((e) => e.method === 'degrade').length;
      const after = fx.events.length;

      note(fx, { kind: 'waiting', dialog: 'dialog' });
      // Powtórzony tik z tą samą klasą nie dokłada niczego.
      note(fx, { kind: 'waiting', dialog: 'dialog' });
      await quiet();
      await quiet();
      expect(cliDialogs(fx.events.slice(after))).toEqual([{ type: 'cli-dialog', cliDialog: 'dialog' }]);
      expect(screenDialogs(fx.events.slice(after)), 'ta sama karta, nie nowa').toEqual([]);
      expect(cleared(fx.events.slice(after))).toEqual([]);
      expect(fx.audit.filter((e) => e.method === 'degrade')).toHaveLength(degrades);

      // „Nie wiem" (dwóch pisarzy, brak wpisu): klasy nie wolno dalej twierdzić — karta zostaje.
      note(fx, { kind: 'unknown' });
      await quiet();
      expect(cliDialogs(fx.events.slice(after))).toEqual([
        { type: 'cli-dialog', cliDialog: 'dialog' }, { type: 'cli-dialog' },
      ]);
      expect(cleared(fx.events.slice(after))).toEqual([]);
      expect(fx.client.mutations).toBe(0);
    });

  it('(i) karta Z decyzją nie dostaje klasy z rejestru — ani przy wystawieniu, ani później', async () => {
    const fx = await makeDriver({ transcript: userLine('wyjdź z planu'), deps: { ...base } });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.client.screenText = EXIT_PLAN;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'karta z blokady herdr');
    note(fx, WAITING_PERMISSION);
    note(fx, { kind: 'waiting', dialog: 'input' });
    await quiet();
    expect(permissions(fx.events)[0]!.input).not.toBeNull();
    expect(cliDialogs(fx.events)).toEqual([]);
  });

  it('(g) rejestr `busy` po `waiting` zdejmuje kartę i oddaje stan z herdr', async () => {
    const fx = await makeDriver({
      transcript: userLine('wyjdź z planu'), agent: { status: 'working' }, deps: { ...base },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.client.screenText = EXIT_PLAN;
    note(fx, WAITING_PERMISSION);
    await waitFor(() => permissions(fx.events).length > 0, 'karta zgody');

    note(fx, ACTIVE);
    await waitFor(() => cleared(fx.events).length > 0, 'zgaszenie');
    expect(states(fx.events).at(-1)?.state).toBe('working');
  });

  it('(h) spóźniony herdr `working` nie zdejmuje karty, dopóki rejestr mówi `waiting`', async () => {
    const fx = await makeDriver({ transcript: userLine('wyjdź z planu'), deps: { ...base } });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.client.screenText = EXIT_PLAN;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'karta z blokady herdr');
    note(fx, WAITING_PERMISSION);
    const statesBefore = states(fx.events).length;

    fx.emit({ type: 'status', status: 'working', stateChangeSeq: 9, title: '' });
    await quiet();
    await quiet();
    expect(cleared(fx.events)).toEqual([]);
    expect(states(fx.events).slice(statesBefore).map((s) => s.state)).not.toContain('working');
    expect(states(fx.events).at(-1)?.state).toBe('blocked');
    expect(permissions(fx.events)).toHaveLength(1);

    note(fx, ACTIVE);
    await waitFor(() => cleared(fx.events).length > 0, 'zgaszenie przez rejestr');
    expect(states(fx.events).at(-1)?.state).toBe('working');
  });

  it('rejestr zacięty na `waiting`: dwa odczyty z polem promptu gaszą kartę, kolejne tiki nie czytają',
    async () => {
      const fx = await makeDriver({
        transcript: userLine('wyjdź z planu'), agent: { status: 'working' }, deps: { ...base },
      });
      await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
      fx.client.screenText = EXIT_PLAN;
      note(fx, WAITING_PERMISSION);
      await waitFor(() => permissions(fx.events).length > 0, 'karta zgody');

      fx.client.screenText = COMPOSER;
      await waitFor(() => cleared(fx.events).length > 0, 'zgaszenie po dwóch pudłach');
      expect(states(fx.events).at(-1)?.state).toBe('working');
      await quiet();
      const readsAfter = reads(fx.client);
      for (let i = 0; i < 6; i += 1) note(fx, WAITING_PERMISSION);
      await quiet();
      expect(reads(fx.client), 'budżet epizodu wyczerpany').toBe(readsAfter);
    });

  /**
   * Zatrzymuje N-ty kolejny odczyt ekranu (liczony od wywołania) — oddaje ekran z chwili wywołania
   * dopiero po `release()`. Pozostałe odczyty idą normalnie.
   */
  const gateRead = (fx: Fixture, nth: number): { hit: () => boolean; release: () => void } => {
    const reader = fx.client.readScreen.bind(fx.client);
    let count = 0;
    let hit = false;
    let release: () => void = () => undefined;
    (fx.client as { readScreen: HerdrClient['readScreen'] }).readScreen = (...args) => {
      count += 1;
      if (count !== nth) return reader(...args);
      hit = true;
      const captured = reader(...args);
      return new Promise((resolve) => { release = () => { void captured.then(resolve); }; });
    };
    return { hit: () => hit, release: () => { release(); } };
  };

  it('wysyłka poza turą czekająca na odczyt ekranu nie wychodzi, gdy w tym czasie weszła rezerwa',
    async () => {
      // Bramki odmowy zostają na ścieżce `agent.prompt`, czyli poza turą (panel `idle`).
      const fx = await makeDriver({
        transcript: userLine('start'), agent: { status: 'idle' },
        deps: { ...base, pendingDebounceMs: 10_000, blockedPollMs: 10_000 },
      });
      await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
      fx.client.screenText = COMPOSER;
      note(fx, WAITING_PERMISSION);
      await quiet();
      // Odczyt nr 2 wysyłki to bramka rejestru (nr 1 — bramka zgody CLI).
      const gate = gateRead(fx, 2);
      fx.driver.send('1');
      await waitFor(gate.hit, 'bramka czeka na ekran');
      fx.client.screenText = EXIT_PLAN;
      note(fx, WAITING_PERMISSION);
      await waitFor(() => states(fx.events).at(-1)?.state === 'blocked', 'rezerwa weszła');
      gate.release();
      await waitFor(() => systemCodes(fx.events).includes('commands.send-held.cli-dialog'),
        'zdanie bramki');
      expect(prompts(fx)).toEqual([]);
    });

  it('wysyłka w trakcie tury przy `waiting` z rejestru czeka, także gdy w tym czasie weszła rezerwa',
    async () => {
      /*
       * Wiadomość w trakcie tury nie jest odrzucana: `waiting` z rejestru wstrzymuje ją bez wklejenia, a rezerwa,
       * która wejdzie później, też jej nie przepuszcza.
       */
      const fx = await makeDriver({
        transcript: userLine('start'), agent: { status: 'working' },
        deps: { ...base, pendingDebounceMs: 10_000, blockedPollMs: 10_000, promptRetryMs: 5 },
      });
      await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
      const pane = composerPane(fx);
      note(fx, WAITING_PERMISSION);
      await quiet();
      fx.driver.send('1');
      await quiet();
      pane.dialog = EXIT_PLAN;
      pane.draw();
      note(fx, WAITING_PERMISSION);
      await waitFor(() => states(fx.events).at(-1)?.state === 'blocked', 'rezerwa weszła');
      await quiet();
      expect(pasteFlow(fx)).toEqual([]);
      expect(systemCodes(fx.events)).not.toContain('commands.send-held.cli-dialog');
    });

  it('koniec `waiting` w trakcie odczytu oceny — spóźniony ekran z dialogiem nie stawia karty',
    async () => {
      const fx = await makeDriver({
        transcript: userLine('start'), agent: { status: 'working' },
        deps: { ...base, screenCacheMs: 1_000, blockedPollMs: 10_000 },
      });
      await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
      fx.client.screenText = LOGIN;
      note(fx, { kind: 'waiting', dialog: 'dialog' });
      await waitFor(() => states(fx.events).at(-1)?.state === 'blocked', 'rezerwa weszła');
      // Ekran nieczytelny = ponowienie z `force`: to jedyny NOWY odczyt w tej ocenie (reszta z cache'u).
      const gate = gateRead(fx, 1);
      fx.client.screenText = EXIT_PLAN;
      await waitFor(gate.hit, 'ponowienie czeka na ekran');
      note(fx, ACTIVE);
      await waitFor(() => states(fx.events).at(-1)?.state === 'working', 'rezerwa zeszła');
      const after = fx.events.length;
      gate.release();
      await quiet();
      await quiet();
      const tail = fx.events.slice(after);
      expect(permissions(tail)).toEqual([]);
      expect(screenDialogs(tail)).toEqual([]);
      expect(states(tail).map((s) => s.state)).not.toContain('blocked');
    });

  it('po własnej odpowiedzi i potwierdzonym `active` nowy dialog dostaje kartę od razu',
    async () => {
      const fx = await makeDriver({ transcript: userLine('wyjdź z planu'), deps: { ...base } });
      await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
      fx.client.screenText = EXIT_PLAN;
      fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
      await waitFor(() => permissions(fx.events).length > 0, 'karta z blokady herdr');
      const card = permissions(fx.events)[0]!;
      await expect(fx.driver.respondPermission(card.reqId, 'allow'))
        .resolves.toEqual({ kind: 'applied' });
      fx.client.screenText = COMPOSER;
      fx.emit({ type: 'status', status: 'working', stateChangeSeq: 9, title: '' });
      // Tik rejestru przychodzi PO odpowiedzi (ta sama milisekunda nie jest dowodem — `cliShieldUp`).
      await quiet();
      note(fx, ACTIVE);
      await quiet();

      // Następny dialog, znów niewidoczny dla herdr — osłona poprzedniej odpowiedzi (8 s) nie gra.
      fx.client.screenText = PREVIEW;
      const startedAt = Date.now();
      note(fx, WAITING_INPUT);
      await waitFor(() => questions(fx.events).length > 0, 'karta nowego dialogu');
      expect(Date.now() - startedAt).toBeLessThan(ANSWERED_HOOK_SHIELD_MS);
      expect(states(fx.events).at(-1)?.state).toBe('blocked');
    });

  it('wysyłka i `setMode` przy dialogu z rejestru nie wychodzą — także zanim rezerwa weszła',
    async () => {
      // Wiadomość w trakcie tury przy dialogu czeka bez wklejenia, bez zdania „dialog stoi”;
      // `setMode` przy pracującym panelu się zatrzymuje. Ścieżkę odmowy poza turą pilnuje test niżej.
      const { fx } = await standingPreview({ promptRetryMs: 5 });
      fx.client.getAgent = (): Promise<HerdrAgentInfo> => Promise.resolve({
        paneId: PANE, agentSessionId: SESSION, engine: 'claude', status: 'working',
      } as HerdrAgentInfo);
      fx.driver.send('to nie jest odpowiedź');
      fx.driver.setMode?.('plan');
      await quiet();
      await quiet();
      expect(prompts(fx)).toEqual([]);
      expect(pasteFlow(fx)).toEqual([]);
      expect(fx.client.calls.filter((c) => c.method === 'mode_cycle')).toEqual([]);

      // Bez rezerwy (budżet zjedzony na ekranie z polem promptu), a dialog dorysował się
      // później: `waiting` rejestru wstrzymuje wiadomość, zanim cokolwiek pójdzie do pola.
      const early = await makeDriver({
        transcript: userLine('start'), agent: { status: 'working' }, deps: { ...base, promptRetryMs: 5 },
      });
      await waitFor(() => early.events.some((e) => e.type === 'history'), 'historia');
      const pane = composerPane(early);
      for (let i = 0; i < 6; i += 1) {
        note(early, WAITING_PERMISSION);
        await quiet();
      }
      pane.dialog = EXIT_PLAN;
      pane.draw();
      early.driver.send('za wcześnie');
      await quiet();
      await quiet();
      expect(pasteFlow(early)).toEqual([]);
      expect(systemCodes(early.events)).not.toContain('commands.send-held.cli-dialog');
    });

  it('wysyłka poza turą przy dialogu z rejestru, zanim rezerwa weszła: bramka czyta ekran i odmawia', async () => {
    // Bez rezerwy (budżet zjedzony na ekranie z polem promptu), a dialog dorysował się później.
    const early = await makeDriver({
      transcript: userLine('start'), agent: { status: 'idle' }, deps: { ...base },
    });
    await waitFor(() => early.events.some((e) => e.type === 'history'), 'historia');
    early.client.screenText = COMPOSER;
    for (let i = 0; i < 6; i += 1) {
      note(early, WAITING_PERMISSION);
      await quiet();
    }
    early.client.screenText = EXIT_PLAN;
    early.driver.send('za wcześnie');
    await waitFor(() => systemCodes(early.events).includes('commands.send-held.cli-dialog'),
      'zdanie bramki');
    expect(prompts(early)).toEqual([]);
  });
});
