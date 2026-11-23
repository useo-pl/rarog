/**
 * Całe zrzuty odmów: test przypina DZISIEJSZY wynik parsera i decyzji na siedmiu ekranach
 * z `fixtures/herdr/refusals/`. Zmiana parsera albo decyzji, która zmienia ten wynik, zmienia ten test w tym samym
 * commicie.
 *
 * Każdy plik to cały zrzut z `<dataDir>/refusals/`: nagłówek `klucz: wartość`, linia `--- ekran ---`, ekran.
 * Wejście decyzji odtwarzamy z nagłówka (źródła karty, numer blokady z `reqId`), a wynik porównujemy
 * z nagłówkiem tam, gdzie zrzut go zapisał (`reqId`, `optionCount`, `mismatchReason`): decyzja z dnia odmowy
 * i dzisiejsza mają być tą samą decyzją. Wyjątek: `reqId` widoków `/help` i `/status` niesie dziś tytuł bloku
 * widoku, którego w dniu odmowy w nim nie było (niżej). `tool_input` zrzut pomija świadomie (`refusals.ts`),
 * więc wejście narzędzia jest tu syntetyczne; decyzja na tych ekranach czyta z niego tylko nazwę narzędzia
 * (`Edit`) albo sprawdza, że formularza pytania na ekranie nie ma (`AskUserQuestion`). Pochodzenie i anonimizacja
 * plików: README fixture'ów, sekcja `refusals/`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CliDialogClass } from '@rarog/shared';
import { decideCard } from '../src/herdr/dialogs/decide/decide.ts';
import { evaluationReqId } from '../src/herdr/dialogs/decide/sources.ts';
import type { DecideAction, DecideInput } from '../src/herdr/dialogs/decide/input.ts';
import { screenDialogCard } from '../src/herdr/dialogs/cards/build.ts';
import {
  competingHook, hookMatchesPending, hookPendingFrom, hookQuestionFrom, olderBashHook,
} from '../src/herdr/dialogs/cross-check.ts';
import { dialogShapeOf } from '../src/herdr/dialogs/decide/reasons.ts';
import type { PendingHookTool } from '../src/herdr/dialogs/hook/dump.ts';
import type { PendingTool } from '../src/herdr/jsonl-pending.ts';
import { collapseFooterMode, parseModeFooter } from '../src/herdr/dialogs/screen/mode-footer.ts';
import { parseOptions } from '../src/herdr/dialogs/screen/parse.ts';
import { resolveOptions } from '../src/herdr/dialogs/screen/resolve.ts';
import { snippet } from '../src/herdr/dialogs/screen/snippet.ts';
import { screenFallbackReqId } from '../src/herdr/dialogs/cards/ids.ts';
import { standingConsentDialog } from '../src/herdr/dialogs/policy/consent.ts';

const DIR = join(import.meta.dirname, 'fixtures', 'herdr', 'refusals');
const MARK = '\n--- ekran ---\n';
/** Kształt ekranu bez dialogu (`dialogShapeOf`): bez ramki operacji, zero opcji z cyframi, dialog spoza listy. */
const NO_DIALOG_SHAPE = { headerVisible: null, optionCount: 0, dialogTitle: null } as const;

interface Dump {
  /** Nagłówek zrzutu (`renderDump` w `dialogs/refusals.ts`): `klucz → wartość`, `brak` = pole puste. */
  readonly head: Readonly<Record<string, string>>;
  /** Ekran dokładnie tak, jak dostała go decyzja. */
  readonly screen: string;
}

function dump(name: string): Dump {
  const raw = readFileSync(join(DIR, name), 'utf8');
  const at = raw.indexOf(MARK);
  if (at < 0 || !raw.endsWith('\n')) throw new Error(`${name}: to nie jest zrzut odmowy`);
  const head = Object.fromEntries(raw.slice(0, at).split('\n').map((line) => {
    const colon = line.indexOf(': ');
    return [line.slice(0, colon), line.slice(colon + 2)];
  }));
  // Ekran kończy się własnym `\n`; doklejkę `renderDump` (pusta ostatnia linia pliku) zdjął wyciąg (README).
  return { head, screen: raw.slice(at + MARK.length) };
}

function field(head: Readonly<Record<string, string>>, key: string): string {
  const value = head[key];
  if (value === undefined) throw new Error(`zrzut bez pola ${key}`);
  return value;
}

/** Numer blokady z `reqId` karty ekranowej (`screen:<numer>:f:<odcisk>`). */
function blockedSeqOf(reqId: string): number {
  const seq = /^screen:(\d+):f:/.exec(reqId)?.[1];
  if (seq === undefined) throw new Error(`reqId spoza ścieżki ekranowej: ${reqId}`);
  return Number(seq);
}

/** Generacja zrzutu hooka z linii `hook: <zdarzenie> <narzędzie> at=<ISO>`. */
function hookAtOf(head: Readonly<Record<string, string>>): number {
  const iso = /\bat=(\S+)$/.exec(field(head, 'hook'))?.[1];
  if (iso === undefined) throw new Error('zrzut bez znacznika czasu hooka');
  return Date.parse(iso);
}

/** Wejście decyzji jak w driverze (`#evaluateOnce`) po ponowionym odczycie; `over` nadpisuje źródła. */
function input(text: string, over: Partial<DecideInput>): DecideInput {
  return {
    pending: null,
    hookPending: null,
    text,
    reqId: 'screen:1',
    active: null,
    blockedSeq: 1,
    answeredSeq: -1,
    hookAnswersEnabled: true,
    deadAnswerKey: null,
    canRetry: false,
    answeredHookCall: null,
    decided: null,
    resolve: resolveOptions,
    excerpt: (value: string) => (value.trim() === '' ? null : value.trim()),
    hookRaw: null,
    ...over,
  };
}

function screenDialogOf(action: DecideAction): Extract<DecideAction, { kind: 'screen-dialog' }> {
  if (action.kind !== 'screen-dialog') throw new Error(`oczekiwana karta ekranowa, jest ${action.kind}`);
  return action;
}

/** Karta, którą driver stawia z akcji `screen-dialog` (`#showScreenDialog`), z klasą rejestru z nagłówka. */
function cardOf(action: Extract<DecideAction, { kind: 'screen-dialog' }>, head: Readonly<Record<string, string>>) {
  return screenDialogCard(action.reqId, action.resolved, action.reason, action.screen,
    field(head, 'cliDialog') as CliDialogClass, action.origin);
}

/** Kształt karty bez decyzji w nagłówku zrzutu i z dzisiejszego parsera. */
function shapeOfHead(head: Readonly<Record<string, string>>) {
  return {
    headerVisible: null,
    optionCount: Number(field(head, 'optionCount')),
    dialogTitle: field(head, 'dialogTitle') === 'brak' ? null : field(head, 'dialogTitle'),
  };
}

/*
 * Widoki slash-komend przy blokadzie (`cliDialog: dialog`), bez wpisu jsonl i bez zrzutu hooka. Rejestr CLI mówi
 * `waiting`, herdr `blocked`, a na ekranie jest widok z kreską `▔` i tytułem, bez opcji z cyframi. Dziś: parser
 * nie widzi dialogu, pierwsza ocena prosi o ponowny odczyt, druga daje kartę bez przycisków z powodem `unreadable`.
 * Na karcie `/help` i `/status` stoi blok widoku spod kreski, a tytuł bloku wchodzi do `reqId`; `/skills` ma blok
 * ponad sufit wycinka, więc zostaje przy ogonie ekranu i `reqId` z dnia odmowy.
 */
describe('widoki /skills, /help, /status bez źródeł: karta bez przycisków, powód `unreadable`', () => {
  /** Plik, widok i tytuł bloku na karcie; `null` = wycinka bloku nie ma (ponad sufit), karta bez tytułu. */
  const views = [
    ['widok-skills-2.1.310.txt', '/skills', null],
    ['widok-help-2.1.310.txt', '/help', 'Help  General   Commands   Custom commands'],
    ['widok-status-2.1.310.txt', '/status', 'Settings  Status   Config   Usage   Stats'],
  ] as const;

  for (const [file, view, title] of views) {
    const { head, screen } = dump(file);

    it(`${view}: zrzut z dnia odmowy to ścieżka ekranowa (${file})`, () => {
      expect(head).toMatchObject({ reason: 'unreadable', toolName: 'brak', hook: 'brak', jsonl: 'brak',
        cliDialog: 'dialog', source: 'screen', paneRows: '52' });
    });

    it(`${view}: parser nie widzi dialogu ani stopki trybu`, () => {
      expect(parseOptions(screen)).toBeNull();
      expect(resolveOptions(screen, null)).toMatchObject({
        status: 'no-jsonl', knownDialog: null, questionForm: null, options: [],
      });
      expect(dialogShapeOf(screen)).toEqual(shapeOfHead(head));
      expect(dialogShapeOf(screen)).toEqual(NO_DIALOG_SHAPE);
      expect(standingConsentDialog(screen)).toBeNull();
      expect(parseModeFooter(screen)).toBe('unknown');
    });

    it(`${view}: pierwsza ocena ponawia odczyt, druga daje kartę bez przycisków`, () => {
      const reqId = field(head, 'reqId');
      const blockedSeq = blockedSeqOf(reqId);
      // Wycinek ogona ekranu jak w driverze (`#snippet`): karta bez wycinka bloku dostaje dokładnie jego.
      const base = {
        reqId: evaluationReqId(null, null, null, blockedSeq), blockedSeq,
        excerpt: (value: string) => snippet(value)?.text ?? null,
      };
      expect(decideCard(input(screen, { ...base, canRetry: true }))).toEqual({ kind: 'retry' });

      const action = screenDialogOf(decideCard(input(screen, base)));
      const expectedReqId = title === null ? reqId : screenFallbackReqId(base.reqId, {
        knownDialog: null, reason: 'unreadable', question: null, options: [], title,
      });
      expect(action).toMatchObject({
        reqId: expectedReqId, reason: 'unreadable', audit: 'unreadable', origin: { source: 'screen' },
      });
      expect(action.resolved).toMatchObject({ knownDialog: null, options: [] });
      expect(action.diagnosis).toEqual({ mismatchReason: null, ...NO_DIALOG_SHAPE });
      if (title === null) {
        expect(action.screen).toBe(snippet(screen)?.text ?? null);
      } else {
        expect(action.reqId).not.toBe(reqId);
        expect(action.screen?.split('\n')[0]?.trim()).toBe(title);
      }

      const card = cardOf(action, head);
      expect(card.knownDialog).toBeNull();
      expect(card.active.options).toEqual([]);
      expect(card.event).toMatchObject({ type: 'screen-dialog', reason: 'unreadable', cliDialog: 'dialog' });
      expect(card.event).not.toHaveProperty('knownDialog');
    });
  }

  it('odcisk karty bez opcji nie zależy od widoku: trzy widoki, ten sam sufiks `:f:`', () => {
    const suffixes = views.map(([file]) => field(dump(file).head, 'reqId').split(':f:')[1]);
    expect(new Set(suffixes).size).toBe(1);
  });
});

/*
 * `/status` przy STĘCHŁYM zrzucie hooka: `PermissionRequest AskUserQuestion` 22,6 s przed odczytem, a na ekranie
 * już widok `/status`. Driver podaje zrzut jako `hookPending` (wpisu jsonl brak). Dziś: kanał odpowiedzi hooka się
 * nie otwiera, bo formularza pytania na ekranie nie ma, a karta jest ta sama co bez zrzutu, tylko z bazą
 * tożsamości i pochodzeniem ze zrzutu.
 */
describe('/status przy stęchłym zrzucie `AskUserQuestion`: karta bez przycisków ze źródłem `hook`', () => {
  const { head, screen } = dump('widok-status-stechly-zrzut-2.1.310.txt');
  const hookRaw: PendingHookTool = {
    toolName: 'AskUserQuestion',
    hookEventName: 'PermissionRequest',
    at: hookAtOf(head),
    promptId: field(head, 'promptId'),
    answerKey: 'klucz-syntetyczny',
    // Pytanie syntetyczne (zrzut nie niesie `tool_input`): decyzja sprawdza tylko, że formularza nie ma na ekranie.
    toolInput: {
      questions: [{
        question: 'Który wariant wybrać?', header: 'Wariant', multiSelect: false,
        options: [{ label: 'Pierwszy', description: '' }, { label: 'Drugi', description: '' }],
      }],
    },
  };
  const hookPending = hookPendingFrom(hookRaw);
  if (hookPending === null) throw new Error('zrzut hooka bez kształtu PendingTool');
  const reqId = evaluationReqId(null, hookPending, hookRaw, 1);

  it('zrzut z dnia odmowy: źródło `hook`, zrzut starszy od odczytu o ponad 20 s', () => {
    expect(head).toMatchObject({ reason: 'unreadable', toolName: 'AskUserQuestion', jsonl: 'brak',
      cliDialog: 'dialog', source: 'hook', optionCount: '0', dialogTitle: 'brak', paneRows: '52' });
    expect(Date.parse(field(head, 'at')) - hookAtOf(head)).toBeGreaterThan(20_000);
    expect(reqId).toBe(`hook:${String(hookAtOf(head))}`);
    expect(field(head, 'reqId').startsWith(`${reqId}:f:`)).toBe(true);
  });

  it('ekran nie potwierdza zrzutu: brak formularza, rozpoznanie z zrzutem `unreadable`', () => {
    expect(parseOptions(screen)).toBeNull();
    expect(hookQuestionFrom(hookPending, screen)).toBeNull();
    expect(resolveOptions(screen, { toolName: 'AskUserQuestion' }))
      .toEqual({ status: 'unreadable', retryable: true, reason: 'no-options' });
    expect(dialogShapeOf(screen)).toEqual(shapeOfHead(head));
  });

  it('decyzja: ponowienie, potem karta bez przycisków z pochodzeniem ze zrzutu, bez kanału hooka', () => {
    const base = { reqId, hookPending, hookRaw };
    expect(decideCard(input(screen, { ...base, canRetry: true }))).toEqual({ kind: 'retry' });

    const action = screenDialogOf(decideCard(input(screen, base)));
    expect(action).toMatchObject({ reqId: field(head, 'reqId'), reason: 'unreadable', audit: 'unreadable' });
    expect(action.origin).toEqual({ source: 'hook', promptId: field(head, 'promptId') });
    expect(action.diagnosis).toEqual({ mismatchReason: null, ...NO_DIALOG_SHAPE });

    const card = cardOf(action, head);
    expect(card.active.options).toEqual([]);
    expect(card.event).toMatchObject({ type: 'screen-dialog', reason: 'unreadable', cliDialog: 'dialog' });
    expect(card.event).not.toHaveProperty('hookAnswer');
  });
});

/*
 * Zgoda `Edit` w panelu 63×28: tytuł bloku i nagłówek pliku są nad krawędzią ekranu, widać koniec diffu, kreskę
 * `╌`, pytanie, trzy opcje i stopkę. W dniu odmowy był wpis jsonl i zrzut `PermissionRequest` tego samego
 * wywołania (driver nie podaje go wtedy jako `hookPending`). Dziś: parser widzi zgodę bez nazwy narzędzia,
 * cross-check z wpisem `Edit` daje `mismatch/tool-name`, a karta nie ma przycisków.
 */
describe('zgoda `Edit` z uciętym nagłówkiem: `mismatch` z powodem `tool-name`, karta bez przycisków', () => {
  const { head, screen } = dump('zgoda-edit-uciety-naglowek-63x28.txt');
  // Wejście narzędzia syntetyczne: cross-check `Edit` porównuje rodzaj i nazwę, nie treść.
  const editInput = {
    file_path: '/Users/u/Projects/atlas/config/claude-settings/settings.json', old_string: 'a', new_string: 'b',
  };
  const hookAt = hookAtOf(head);
  const pending: PendingTool = {
    id: field(head, 'toolUseId'), toolName: 'Edit', input: editInput, at: new Date(hookAt - 100).toISOString(),
  };
  const hookRaw: PendingHookTool = {
    toolName: 'Edit', toolInput: editInput, at: hookAt, hookEventName: 'PermissionRequest',
  };
  const question = 'Do you want to make this edit to settings.json?';
  const always = 'Yes, and always allow access to /Users/u/Projects/atlas/config/claude-settings '
    + 'for this session (shift+tab)';

  it('zrzut z dnia odmowy: wpis jsonl, panel 28 wierszy', () => {
    expect(head).toMatchObject({ reason: 'mismatch', toolName: 'Edit', cliDialog: 'permission', source: 'jsonl',
      mismatchReason: 'tool-name', paneRows: '28' });
    expect(screen.split('\n')).toHaveLength(Number(field(head, 'paneRows')) + 1);
  });

  it('parser: zgoda bez nazwy narzędzia, trzy opcje, bez ramki operacji', () => {
    const dialog = parseOptions(screen);
    expect(dialog).toMatchObject({
      kind: 'tool', toolName: null, identity: { kind: 'form' }, multiSelect: false, operation: null, title: question,
    });
    expect(dialog?.options).toEqual([
      { digit: '1', label: 'Yes' }, { digit: '2', label: always }, { digit: '3', label: 'No' },
    ]);
    expect(dialogShapeOf(screen)).toEqual(shapeOfHead(head));
    expect(standingConsentDialog(screen)).toBeNull();
  });

  it('zrzut tego samego wywołania nie konkuruje z wpisem: tożsamość oceny = `tool_use.id`', () => {
    expect(competingHook(pending, hookRaw)).toBe(false);
    expect(olderBashHook(pending, hookRaw)).toBe(false);
    expect(hookMatchesPending(pending, hookRaw)).toBe(false);
    expect(evaluationReqId(pending, null, hookRaw, 1)).toBe(pending.id);
  });

  it('cross-check z wpisem `Edit`: `mismatch/tool-name`, ekran bez nazwy', () => {
    expect(resolveOptions(screen, { toolName: 'Edit' })).toEqual({
      status: 'mismatch', retryable: false, reason: 'tool-name', screenKind: 'tool', screenToolName: null,
    });
  });

  it('decyzja: od razu (bez ponowienia) karta bez przycisków z powodem `mismatch`', () => {
    for (const canRetry of [true, false]) {
      const action = decideCard(input(screen, { pending, hookRaw, reqId: pending.id, canRetry }));
      if (action.kind !== 'card') return expect.unreachable(`oczekiwana karta, jest ${action.kind}`);
      expect(action.audit).toBe('mismatch');
      expect(action.diagnosis).toEqual({
        mismatchReason: 'tool-name', headerVisible: null, optionCount: 3, dialogTitle: null,
      });
      expect(action.card.active).toMatchObject({
        reqId: field(head, 'reqId'), toolName: 'Edit', options: [], origin: { source: 'jsonl', toolUseId: pending.id },
      });
      expect(action.card.event).toMatchObject({
        type: 'permission-request', toolName: 'Edit', input: null, reason: 'mismatch',
      });
    }
  });

  /*
   * Wariant spoza dnia odmowy („bez zrzutu”): ten sam ekran bez wpisu jsonl i bez zrzutu hooka. Ramka diffu bez paska
   * `│` ucięta u góry (nad dolną kreską `╌╌╌` nie ma drugiej): formularza zgody z ekranu nie ma (karta 0d planu zgód
   * z telefonu, `docs/dialogs.md`, „Known gaps”), więc karta ekranowa bez przycisków z wycinkiem.
   */
  it('ten sam ekran bez wpisu i bez zrzutu: ramka ucięta u góry, karta ekranowa bez przycisków', () => {
    expect(parseOptions(screen)?.question).toBeNull();
    const action = screenDialogOf(decideCard(input(screen, {})));
    expect(action.reason).toBe('no-jsonl');
    expect(action.resolved).toMatchObject({ status: 'no-jsonl', knownDialog: null, questionForm: null, options: [] });
    expect(cardOf(action, head).event).not.toHaveProperty('knownDialog');
  });
});

/*
 * `mode-unknown`: bramka wysyłki promptu (`ensureFreshMode`) przeczytała panel, w którym zamiast TUI stoi powłoka
 * z wpisanym `claude --session-id …` (CLI jeszcze nie wystartowało). Dziś: tryb `unknown`, bez dialogu, bez karty
 * zgody CLI — prompt nie wychodzi.
 */
describe('`mode-unknown`: powłoka przed startem CLI, tryb nieznany, bez dialogu', () => {
  for (const file of ['powloka-zawiniete-polecenie.txt', 'powloka-komunikat-przed-promptem.txt']) {
    const { head, screen } = dump(file);

    it(file, () => {
      expect(head).toMatchObject({ reason: 'mode-unknown', toolName: 'brak', hook: 'brak', jsonl: 'brak' });
      expect(head).not.toHaveProperty('cliDialog');
      expect(screen).toContain('claude --session-id');
      expect(parseModeFooter(screen)).toBe('unknown');
      expect(collapseFooterMode(parseModeFooter(screen))).toBe('unknown');
      expect(standingConsentDialog(screen)).toBeNull();
      expect(parseOptions(screen)).toBeNull();
      expect(dialogShapeOf(screen)).toEqual(NO_DIALOG_SHAPE);
    });
  }
});
