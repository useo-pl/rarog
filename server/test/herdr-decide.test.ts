/**
 * TABELA DECYZJI „jaka karta" — `decideCard` z `herdr/dialogs/decide/decide.ts`.
 *
 * Bez tej tabeli każda z tych gałęzi dawałaby się sprawdzić WYŁĄCZNIE przez harness drivera:
 * zegar, atrapa herdr, follower jsonl i czekanie na zdarzenie. Kosztem byłby czas, ale przede
 * wszystkim widoczność — kolejność bramek (audyt → wycinek → gaszenie → karta) i ich
 * PIERWSZEŃSTWO ginęłyby w scenariuszu. Tutaj jeden przypadek to jedno wejście i jedno wyjście.
 *
 * Ekrany są z pomiaru na żywym panelu (Claude Code 2.1.257, `fixtures/herdr/`), nie z ręki,
 * i przechodzą przez PRAWDZIWY `resolveOptions` — atrapa rozpoznania zamieniłaby ten plik
 * w test własnych założeń.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideCard as decideCardRaw } from '../src/herdr/dialogs/decide/decide.ts';
import { decideReqId } from '../src/herdr/dialogs/decide/sources.ts';
import type { DecideAction, DecideInput, DecidedShield } from '../src/herdr/dialogs/decide/input.ts';
import { hookQuestionReqId } from '../src/herdr/dialogs/cards/ids.ts';
import {
  callPrint, editContradictsScreen, hookMatchesScreen, hookPendingFrom, hookQuestionFrom, screenConfirmsInput,
} from '../src/herdr/dialogs/cross-check.ts';
import type { ActiveReq, DecisionCard } from '../src/herdr/dialogs/cards/build.ts';
import { parseOptions } from '../src/herdr/dialogs/screen/parse.ts';
import { resolveOptions } from '../src/herdr/dialogs/screen/resolve.ts';
import type { PendingTool } from '../src/herdr/jsonl-pending.ts';
import type { PendingHookTool } from '../src/herdr/dialogs/hook/dump.ts';

/**
 * NIEZMIENNIK sprawdzany na KAŻDYM przypadku tego pliku: karta
 * bez przycisków (`input: null`) nigdy nie nosi gołej bazy z wejścia. Z nią bramka „ta sama karta"
 * w driverze kończy każdą ocenę przed odczytem ekranu i karta zamarza do końca blokady. Ten sam błąd
 * naprawiano już trzy razy — następne wyjście `degradedCard`
 * z gołą bazą ma paść tutaj, nie na telefonie. Jedyny świadomy wyjątek: konkurujące źródła pasujące
 * oba naraz — tę kartę zamrażamy celowo, a jej testy wołają `decideCardRaw` wprost.
 * Tę samą kartę dostaje wpis i zrzut tego samego narzędzia bez treści wpisu na ekranie.
 */
function decideCard(i: DecideInput): DecideAction {
  const action = decideCardRaw(i);
  if (action.kind === 'card' && action.card.event.type === 'permission-request' && action.card.event.input === null) {
    expect(action.card.active.reqId, 'karta bez przycisków z gołą bazą zamarza').not.toBe(i.reqId);
  }
  return action;
}

const DIR = join(import.meta.dirname, 'fixtures', 'herdr');
const fixture = (name: string): string => readFileSync(join(DIR, `${name}.txt`), 'utf8');

/** Formularz `AskUserQuestion`, zakładka 1 — trzy pytania, każde jednokrotne. */
const TAB1 = fixture('dialog-askuserquestion-multiq-tab1-jednokrotne');
/** Ta sama tura, zakładka z `multiSelect` — checkboxy `[ ]` i „Next" pod ostatnią opcją. */
const TAB2 = fixture('dialog-askuserquestion-multiq-tab2-multiselect-next');
/** Zgoda na narzędzie — dialog, którego jsonl nie zna do chwili decyzji. */
const PERMISSION = fixture('dialog-permission');
/** Dialog zaufania katalogu — sygnatura z zamkniętej listy, stoi ZANIM powstanie transkrypt. */
const TRUST = fixture('dialog-trust');
/** Ekran bez żadnego dialogu — `parseOptions` nie ma czego rozpoznać. */
const NIC = 'jakiś zwykły ogon transkryptu\nbez dialogu\n';

/** Payload hooka: dwa pytania jednokrotne, oba z zakładki 1 fixture'u. */
function zrzutDwaPytania(overrides: Partial<PendingHookTool> = {}): PendingHookTool {
  const screen = hookQuestionsFromScreen(TAB1);
  return {
    toolName: 'AskUserQuestion',
    hookEventName: 'PermissionRequest',
    answerKey: 'klucz-1',
    at: 11,
    toolInput: { questions: screen },
    ...overrides,
  };
}

/**
 * Pytania odczytane Z EKRANU i podane hookowi jako payload.
 *
 * Cross-check `hookQuestionFrom` wymaga zgodności treści i KOMPLETU etykiet, więc payload
 * musi mówić to samo co ekran — inaczej testowalibyśmy wyłącznie rozjazd.
 */
function hookQuestionsFromScreen(text: string): Record<string, unknown>[] {
  const dialog = parseOptions(text);
  if (dialog === null || dialog.question === null) throw new Error('fixture bez pytania');
  return [{
    question: dialog.question.question,
    header: dialog.question.header,
    multiSelect: dialog.multiSelect === true,
    options: dialog.options.map((o) => ({ label: o.label, description: 'z hooka' })),
  }];
}

const JSONL_BASH: PendingTool = {
  id: 'toolu_01',
  toolName: 'Bash',
  input: { command: 'npm run build 2>&1 | tail -20' },
  at: '2026-09-02T00:00:00Z',
};

/** Wejście z samymi wartościami neutralnymi — każdy przypadek nadpisuje tylko swoje pola. */
function input(over: Partial<DecideInput> = {}): DecideInput {
  const pending = over.pending ?? null;
  const hookPending = over.hookPending ?? null;
  return {
    pending,
    hookPending,
    text: null,
    // Bazę liczymy TAK SAMO jak driver: zrzut hooka przed wpisem z jsonl, żeby
    // tożsamość karty kanału hooka nie zależała od tego, czy `tool_use` zdążył wejść do pliku.
    reqId: decideReqId(hookPending ?? pending, 7),
    active: null,
    blockedSeq: 7,
    answeredSeq: -1,
    hookAnswersEnabled: true,
    deadAnswerKey: null,
    canRetry: false,
    answeredHookCall: null,
    decided: null,
    resolve: resolveOptions,
    // Wycinek na kartę — atrapa oddaje ogon ekranu bez ANSI, tak jak `snippet()`
    // z `herdr/dialogs/screen/`; test pyta wyłącznie o to, CZY karta go niesie.
    excerpt: (text: string) => (text.trim() === '' ? null : text.trim()),
    hookRaw: null,
    ...over,
  };
}

/** Karta stojąca na telefonie — minimum, którego wymagają bramki „ta sama karta". */
function karta(reqId: string, over: Partial<ActiveReq> = {}): ActiveReq {
  return { reqId, toolName: 'dialog', options: [], ...over };
}

describe('decideCard — ponowienie odczytu (DOKŁADNIE raz)', () => {
  it('ekran nie do odczytania prosi o ponowienie', () => {
    expect(decideCard(input({ text: null, canRetry: true }))).toEqual({ kind: 'retry' });
  });

  it('pusty `no-jsonl` (ekran bez dialogu) też prosi — TUI bywa w pół przemalowania', () => {
    expect(decideCard(input({ text: NIC, canRetry: true }))).toEqual({ kind: 'retry' });
  });

  it('rozpoznany dialog NIE prosi, choćby ponowienie było dostępne', () => {
    const action = decideCard(input({ text: PERMISSION, canRetry: true }));
    expect(action.kind).not.toBe('retry');
  });

  it('po zużytym ponowieniu nieczytelny ekran spada na fallback z powodem `unreadable`', () => {
    const action = decideCard(input({ text: null, canRetry: false }));
    expect(action).toMatchObject({
      kind: 'screen-dialog', reason: 'unreadable', audit: 'unreadable',
      // Ekranu nie dało się przeczytać, więc karta nie ma czego pokazać.
      screen: null,
    });
  });
});

describe('decideCard — kanał odpowiedzi hooka', () => {
  const zrzut = zrzutDwaPytania();
  const hookPending = hookPendingFrom(zrzut);

  it('zrzut z `answerKey` nad stojącym formularzem daje kartę z adresem kanału', () => {
    const action = decideCard(input({
      hookPending, text: TAB1, hookRaw: zrzut,
    }));
    if (action.kind !== 'card') throw new Error(`spodziewano karty, jest ${action.kind}`);
    expect(action.card.active.hookAnswer?.key).toBe('klucz-1');
    // Kanał plikowy nie wysyła cyfry, więc nie ma czego audytować.
    expect(action.audit).toBeNull();
  });

  it('ta sama karta stoi dalej → zdarzenie zerowe, bez przestawiania numeru blokady', () => {
    const question = hookQuestionFrom(hookPending!, TAB1);
    const reqId = hookQuestionReqId(hookPending!.id, question!.all);
    const action = decideCard(input({
      hookPending, text: TAB1, hookRaw: zrzut, active: karta(reqId),
    }));
    expect(action).toEqual({ kind: 'keep', touchSeq: false });
  });

  it('martwy klucz zamyka kanał — karta wraca na ścieżkę CYFROWĄ (bez `hookAnswer`)', () => {
    const action = decideCard(input({
      hookPending, text: TAB1, hookRaw: zrzut, deadAnswerKey: 'klucz-1',
    }));
    if (action.kind !== 'card') throw new Error(`spodziewano karty, jest ${action.kind}`);
    expect(action.card.active.hookAnswer).toBeUndefined();
  });

  it('kanał wyłączony w instalacji — ta sama karta cyfrowa, bez adresu odpowiedzi', () => {
    const action = decideCard(input({
      hookPending, text: TAB1, hookAnswersEnabled: false, hookRaw: zrzut,
    }));
    if (action.kind !== 'card') throw new Error(`spodziewano karty, jest ${action.kind}`);
    expect(action.card.active.hookAnswer).toBeUndefined();
  });

  it('zrzut bez `answerKey` (`PreToolUse`) nie otwiera kanału', () => {
    const bezKlucza = zrzutDwaPytania({ answerKey: undefined, hookEventName: 'PreToolUse' });
    const action = decideCard(input({
      hookPending: hookPendingFrom(bezKlucza), text: TAB1, hookRaw: bezKlucza,
    }));
    if (action.kind !== 'card') throw new Error(`spodziewano karty, jest ${action.kind}`);
    expect(action.card.active.hookAnswer).toBeUndefined();
  });
});

/**
 * Marker eskalacji za 200. znakiem etykiety: etykieta z ekranu jest ucięta do `OPTION_LABEL_MAX_CHARS`, a flaga
 * `terminalOnly` liczy się na pełnej etykiecie z payloadu. Karta kanału hooka (lista `blocked`) i karta cyfrowa
 * tego samego zrzutu po martwym kluczu (`terminalOnlyLabels` dla bramki cyfry) mają blokować ten sam klucz.
 */
describe('decideCard — `terminalOnly` z pełnej etykiety payloadu, spójny w obu kanałach', () => {
  const DLUGA = `Zapis w katalogu ${'x'.repeat(190)}, for this session`;
  const KLUCZ = DLUGA.slice(0, 200);
  const EKRAN = fixture('dialog-askuserquestion-multi')
    .replace(/\[[ ✔]\] /g, '')
    .replace('← ☒ Dodatki ✔ Submit →', '← ☐ Dodatki →')
    .replace('3. Bita śmietana', `3. ${DLUGA}`);
  const zrzut: PendingHookTool = {
    toolName: 'AskUserQuestion',
    hookEventName: 'PermissionRequest',
    answerKey: 'klucz-dluga',
    at: 12,
    toolInput: {
      questions: [{
        question: 'Które dodatki do lodów?', header: 'Dodatki', multiSelect: false,
        options: [{ label: 'Posypka' }, { label: 'Polewa' }, { label: DLUGA }],
      }],
    },
  };
  const hookPending = hookPendingFrom(zrzut);

  it('kanał hooka i karta cyfrowa po martwym kluczu blokują ten sam klucz kanoniczny', () => {
    const hook = decideCard(input({ hookPending, text: EKRAN, hookRaw: zrzut }));
    const keys = decideCard(input({ hookPending, text: EKRAN, hookRaw: zrzut, deadAnswerKey: 'klucz-dluga' }));
    if (hook.kind !== 'card' || keys.kind !== 'card') throw new Error('spodziewano dwóch kart');

    expect(hook.card.active.hookAnswer?.blocked).toEqual([KLUCZ]);
    expect(hook.card.active.terminalOnlyLabels).toEqual([KLUCZ]);
    expect(keys.card.active.hookAnswer).toBeUndefined();
    expect(keys.card.active.terminalOnlyLabels).toEqual([KLUCZ]);
    const event = keys.card.event;
    if (event.type !== 'question-request') throw new Error(`spodziewano karty pytania, jest ${event.type}`);
    expect(event.channel).toBe('keys');
    expect(event.questions[0]?.options.find((o) => o.label === KLUCZ)?.terminalOnly).toBe(true);
  });
});

/**
 * WPIS `tool_use` NAD STOJĄCYM DIALOGIEM (CLI 2.1.267).
 *
 * Do 2.1.266 `tool_use` formularza pytania wchodził do jsonl dopiero po decyzji, więc jego
 * obecność zamykała kanał odpowiedzi („dialog już rozstrzygnięty"). Od 2.1.267 wpis ląduje
 * ~0,1 s PRZED zrzutem hooka, nad stojącym dialogiem — i ta przesłanka jest nieprawdą.
 * Wpis zostaje KONTROLĄ zgodności, nie bramką.
 */
describe('decideCard — kanał hooka przy obecnym wpisie z jsonl', () => {
  const PYTANIA = hookQuestionsFromScreen(TAB1);
  const zrzut = zrzutDwaPytania();
  const hookPending = hookPendingFrom(zrzut);
  /** Wpis z jsonl o TYCH SAMYCH pytaniach, co zrzut — tak wygląda dziś stojący formularz. */
  const JSONL_PYTANIE: PendingTool = {
    id: 'toolu_q1',
    toolName: 'AskUserQuestion',
    input: { questions: PYTANIA },
    at: '2026-09-12T00:00:00Z',
  };
  /** Treść pytania, które stoi na EKRANIE — cross-check `hookQuestionFrom` wymaga zgodności z nim. */
  const EKRANOWE = String(PYTANIA[0]?.['question'] ?? '');
  /**
   * Formularz TRZYPYTANIOWY: zakładka 1 z ekranu, dwie następne wyłącznie z payloadu.
   *
   * Oba źródła (zrzut i wpis w jsonl) niosą ten sam komplet — tak wygląda formularz
   * wielopytaniowy od CLI 2.1.267.
   */
  const WIELO_PYTANIA = [
    ...PYTANIA,
    {
      question: 'A jaki kubek?',
      header: 'Kubek',
      multiSelect: false,
      options: [{ label: 'Mały' }, { label: 'Duży' }],
    },
    {
      question: 'Co dosypać na wierzch?',
      header: 'Wierzch',
      multiSelect: true,
      options: [{ label: 'Orzechy' }, { label: 'Wiórki' }, { label: 'Nic' }],
    },
  ];
  const zrzutWielo = zrzutDwaPytania({ toolInput: { questions: WIELO_PYTANIA } });
  const JSONL_WIELO: PendingTool = { ...JSONL_PYTANIE, input: { questions: WIELO_PYTANIA } };

  it('(a) wpis zgodny ze zrzutem → kanał `hook`, komplet pytań, tożsamość z generacji zrzutu', () => {
    /*
     * Payload jest WIELOPYTANIOWY z rozmysłem: ekran pokazuje jedną zakładkę, a `allow` domyka
     * całe wywołanie, więc karta ma nieść pytania 2..n, których na ekranie nie ma ANI JEDNEJ
     * linii. Na payloadzie jednopytaniowym ta asercja nie odróżniała kanału `hook` (komplet)
     * od `keys` (jedna zakładka): obie listy miały wtedy długość 1.
     */
    const action = decideCard(input({
      pending: JSONL_WIELO, hookPending: hookPendingFrom(zrzutWielo), text: TAB1,
      hookRaw: zrzutWielo,
    }));
    if (action.kind !== 'card') throw new Error(`spodziewano karty, jest ${action.kind}`);
    if (action.card.event.type !== 'question-request') throw new Error('spodziewano pytania');
    expect(action.card.event.channel).toBe('hook');
    expect(action.card.active.hookAnswer?.key).toBe('klucz-1');
    expect(action.card.event.questions.map((q) => q.question))
      .toEqual([EKRANOWE, 'A jaki kubek?', 'Co dosypać na wierzch?']);
    // Adres odpowiedzi też niesie KOMPLET — plik z dziurą oddaje modelowi pustkę na pytanie,
    // którego człowiek nie zobaczy drugi raz.
    expect(action.card.active.hookAnswer?.questions)
      .toEqual([EKRANOWE, 'A jaki kubek?', 'Co dosypać na wierzch?']);
    // Baza z GENERACJI zrzutu (`hook:<at>`), nie z `tool_use.id`: wpis dochodzi do pliku
    // w środku życia karty, a zmiana `qId` skasowałaby w PWA wpisany tekst.
    expect(action.card.active.reqId.startsWith(`${hookPending?.id ?? ''}:`)).toBe(true);
  });

  it('(b) wpis o INNYCH pytaniach niż zrzut → kanał zamknięty, karta `keys` JEDNEJ zakładki', () => {
    const dwaPytania: PendingTool = {
      ...JSONL_PYTANIE,
      input: {
        questions: [
          ...PYTANIA,
          { question: 'A jaki kubek?', header: 'Kubek', multiSelect: false, options: [{ label: 'Mały' }] },
        ],
      },
    };
    const action = decideCard(input({
      pending: dwaPytania,
      // Zrzut zostawiamy w wejściu z rozmysłem: kanał ma zamknąć TA funkcja, a nie driver,
      // który przy rozjeździe w ogóle go nie poda (`hookPendingFor`). Baza identyfikatora jest
      // wtedy z `tool_use.id` — tak samo, jak policzyłby ją driver.
      hookPending,
      reqId: decideReqId(dwaPytania, 7),
      text: TAB1,
      hookRaw: zrzut,
    }));
    if (action.kind !== 'card') throw new Error(`spodziewano karty, jest ${action.kind}`);
    if (action.card.event.type !== 'question-request') throw new Error('spodziewano pytania');
    expect(action.card.event.channel).toBe('keys');
    expect(action.card.active.hookAnswer).toBeUndefined();
    // Karta cyfrowa niesie zakładkę Z EKRANU, nie komplet z `tool_input`: cyfra zamyka jedno
    // pytanie, a etykiety sąsiednich zakładek kolidują.
    expect(action.card.event.questions).toHaveLength(1);
    expect(action.card.event.questions[0]?.question).toBe(PYTANIA[0]?.['question']);
    expect(action.card.active.reqId.startsWith('toolu_q1:')).toBe(true);
  });

  it('(b) rozjazd na DRUGIM pytaniu (pierwsze zgodne) też zamyka kanał', () => {
    /*
     * Kontrola zgodności (`hookMatchesPending`) porównuje KAŻDE pytanie, a nie pierwsze z brzegu:
     * stęchły zrzut potrafi zgadzać się na zakładce z ekranu i rozjeżdżać na tej, której człowiek
     * nie widzi — a `allow` odpowiedziałby wtedy na formularz, którego nikt nie oglądał.
     * Przypadki z JEDNYM pytaniem przepuściłyby porównanie „tylko pierwsze" bez ani jednej
     * czerwieni, stąd warianty na każdym pytaniu.
     */
    const warianty: [string, Record<string, unknown>][] = [
      ['inna treść pytania 2', { ...WIELO_PYTANIA[1], question: 'A jaki rożek?' }],
      ['inny nagłówek pytania 2', { ...WIELO_PYTANIA[1], header: 'Rożek' }],
      ['inna etykieta w pytaniu 2', {
        ...WIELO_PYTANIA[1], options: [{ label: 'Mały' }, { label: 'Ogromny' }],
      }],
      ['inny `multiSelect` w pytaniu 2', { ...WIELO_PYTANIA[1], multiSelect: true }],
    ];
    for (const [nazwa, drugie] of warianty) {
      const rozjazd: PendingTool = {
        ...JSONL_WIELO,
        input: { questions: [WIELO_PYTANIA[0], drugie, WIELO_PYTANIA[2]] },
      };
      const action = decideCard(input({
        pending: rozjazd,
        hookPending: hookPendingFrom(zrzutWielo),
        reqId: decideReqId(rozjazd, 7),
        text: TAB1,
        hookRaw: zrzutWielo,
      }));
      if (action.kind !== 'card') throw new Error(`${nazwa}: spodziewano karty`);
      if (action.card.event.type !== 'question-request') throw new Error(`${nazwa}: nie pytanie`);
      expect(action.card.event.channel, nazwa).toBe('keys');
      expect(action.card.active.hookAnswer, nazwa).toBeUndefined();
      expect(action.card.event.questions, nazwa).toHaveLength(1);
    }
  });

  it('(b) wpis WIELOPYTANIOWY, którego zakładki nie widać na ekranie → karta bez przycisków', () => {
    /*
     * Karta z kompletem pytań ma tylko jeden adres cyfry — ekran. Skoro nie umiemy powiedzieć,
     * które pytanie na nim stoi, cyfra trafiłaby w zakładkę, której człowiek nie widzi.
     * Formularz JEDNOPYTANIOWY kartę dostaje dalej: tam nie ma czego mylić.
     */
    const obce = {
      question: 'Zupełnie inne pytanie?',
      header: 'Inne',
      multiSelect: false,
      options: [{ label: 'Tak' }, { label: 'Nie' }],
    };
    const wejscie = input({
      pending: { ...JSONL_PYTANIE, input: { questions: [obce, { ...obce, header: 'Drugie' }] } },
      reqId: 'toolu_q1',
      text: TAB1,
    });
    const dwa = decideCard(wejscie);
    expect(dwa).toMatchObject({ kind: 'card', audit: 'no-digit' });
    if (dwa.kind !== 'card') throw new Error('spodziewano karty');
    /*
     * Tożsamość z TREŚCI EKRANU, nie z `tool_use.id`: bramka „ta sama karta" w driverze kończy
     * ocenę przed odczytem ekranu, więc karta o gołym `reqId` z pliku zamroziłaby formularz do
     * końca blokady — a niedopasowanie bywa chwilowe.
     */
    expect(dwa.card.active.reqId.startsWith('toolu_q1:')).toBe(true);
    // Ten sam ekran w następnym obrocie: zdarzenie zerowe, bez drugiego wpisu odmowy.
    expect(decideCard({ ...wejscie, active: karta(dwa.card.active.reqId) }))
      .toEqual({ kind: 'keep', touchSeq: false });

    const jedno = decideCard(input({
      pending: { ...JSONL_PYTANIE, input: { questions: [obce] } },
      reqId: 'toolu_q1',
      text: TAB1,
    }));
    expect(jedno).toMatchObject({ kind: 'card', audit: null });
  });

  it('(b) sam zrzut WIELOPYTANIOWY bez dopasowania zakładki → karta z ekranu, jedna zakładka', () => {
    /*
     * Bliźniak przypadku wyżej bez wpisu w jsonl. Blokada wielopytaniowa stoi tylko przy wpisie, bo bez niego
     * karty z payloadu nie ma: zrzut daje kartę cyfrową wyłącznie po dopasowaniu zakładki do ekranu
     * (`hookMatchesScreen` to dla `AskUserQuestion` ten sam `hookQuestionFrom`), a bez dopasowania ocena idzie
     * ścieżką ekranową. Pytanie 1 ma etykietę z pytania na ekranie: karta z kompletem pytań wysłałaby jego
     * odpowiedź cyfrą w pytanie 2.
     */
    const pierwsze = {
      question: 'Jaki odstęp nad stopką?', header: 'Stopka', multiSelect: false,
      options: [{ label: '40 px — wartość `default`' }, { label: '24 px' }],
    };
    const opcjeEkranu = (PYTANIA[0]?.['options'] ?? []) as Record<string, unknown>[];
    const drugie = { ...PYTANIA[0], options: [...opcjeEkranu.slice(0, 2), { label: 'Zupełnie inna wartość' }] };
    const zrzutBezZakladki = zrzutDwaPytania({ toolInput: { questions: [pierwsze, drugie] } });
    const warianty: [string, Partial<DecideInput>][] = [
      ['kanał hooka otwarty', {}],
      ['martwy klucz', { deadAnswerKey: 'klucz-1' }],
      ['kanał wyłączony w instalacji', { hookAnswersEnabled: false }],
      ['zrzut z `PreToolUse`', { hookRaw: { ...zrzutBezZakladki, answerKey: undefined, hookEventName: 'PreToolUse' } }],
    ];
    for (const [nazwa, over] of warianty) {
      const action = decideCard(input({
        hookPending: hookPendingFrom(zrzutBezZakladki), text: TAB1, hookRaw: zrzutBezZakladki, ...over,
      }));
      if (action.kind !== 'card') throw new Error(`${nazwa}: spodziewano karty, jest ${action.kind}`);
      if (action.card.event.type !== 'question-request') throw new Error(`${nazwa}: nie pytanie`);
      expect(action.card.event.channel, nazwa).toBe('keys');
      expect(action.card.active.hookAnswer, nazwa).toBeUndefined();
      expect(action.card.event.questions.map((q) => q.question), nazwa).toEqual([EKRANOWE]);
      expect(action.card.active.origin, nazwa).toEqual({ source: 'screen' });
    }
  });

  it('(c) wpis INNEGO narzędzia obok zrzutu pytania → jak dotąd: fail-closed, bez kanału', () => {
    const action = decideCard(input({
      pending: JSONL_BASH, hookPending, text: TAB1, hookRaw: zrzut,
    }));
    if (action.kind !== 'card') throw new Error(`spodziewano karty, jest ${action.kind}`);
    expect(action.card.active.hookAnswer).toBeUndefined();
    expect(action.audit).toBe('mismatch');
  });

  it('(d) kanał niedostępny przy obecnym wpisie → karta `keys` JEDNEJ zakładki, nie komplet', () => {
    const warianty: [string, Partial<DecideInput>][] = [
      ['brak `answerKey`', { hookRaw: zrzutDwaPytania({ answerKey: undefined }) }],
      ['zrzut z `PreToolUse`', { hookRaw: zrzutDwaPytania({ hookEventName: 'PreToolUse' }) }],
      ['martwy klucz', { deadAnswerKey: 'klucz-1' }],
      ['kanał wyłączony w instalacji', { hookAnswersEnabled: false }],
    ];
    for (const [nazwa, over] of warianty) {
      const action = decideCard(input({
        pending: JSONL_PYTANIE, hookPending, text: TAB1, hookRaw: zrzut, ...over,
      }));
      if (action.kind !== 'card') throw new Error(`${nazwa}: spodziewano karty`);
      if (action.card.event.type !== 'question-request') throw new Error(`${nazwa}: nie pytanie`);
      expect(action.card.event.channel, nazwa).toBe('keys');
      expect(action.card.active.hookAnswer, nazwa).toBeUndefined();
      expect(action.card.event.questions, nazwa).toHaveLength(1);
    }
  });

  it('(d) `multiSelect` od autora przy martwym kanale → karta BEZ przycisków, nie cyfra', () => {
    const wielokrotny = {
      questions: [{
        question: 'Które dodatki włączyć?',
        header: 'Dodatki',
        multiSelect: true,
        options: [
          { label: 'Posypka' }, { label: 'Polewa' }, { label: 'Bita śmietana' },
        ],
      }],
    };
    const zrzutWielo = zrzutDwaPytania({ toolInput: wielokrotny });
    const action = decideCard(input({
      pending: { ...JSONL_PYTANIE, input: wielokrotny },
      hookPending: hookPendingFrom(zrzutWielo),
      text: TAB2,
      hookRaw: zrzutWielo,
      deadAnswerKey: 'klucz-1',
    }));
    expect(action).toMatchObject({
      kind: 'screen-dialog', reason: 'multi-select', audit: 'multi-select',
    });
  });

  it('osłona po odpowiedzi plikiem: TE SAME pytania w tej samej blokadzie = `keep`', () => {
    /*
     * `allow` domyka całe wywołanie, ale `tool_result` dochodzi do jsonl z opóźnieniem — bez
     * tej osłony ocena budowała z tego samego wpisu kartę z pytaniami, na które człowiek
     * właśnie odpowiedział.
     */
    const tresc = PYTANIA.map((q) => String(q['question']));
    const rozliczone = { questions: tresc, seq: 7, key: 'klucz-1' };
    const po = input({
      pending: JSONL_PYTANIE, text: TAB1, answeredHookCall: rozliczone,
      answeredSeq: 7, blockedSeq: 7,
    });
    expect(decideCard(po)).toEqual({ kind: 'keep', touchSeq: false });
    // Nowa blokada znaczy nowy dialog — osłona się rozpada.
    expect(decideCard({ ...po, blockedSeq: 8, reqId: decideReqId(JSONL_PYTANIE, 8) }).kind)
      .toBe('card');
    // INNE pytanie w pliku = nowe wywołanie: karta musi powstać, choć blokada ta sama.
    expect(decideCard({ ...po, answeredHookCall: { ...rozliczone, questions: ['Co innego?'] } }).kind)
      .toBe('card');
    // Osłona liczy WŁASNY numer blokady, nie `answeredSeq`: ten przestawia też zwykła cyfra,
    // więc odpowiedź plikiem z poprzedniej blokady nie ma prawa zabierać kart następnej.
    expect(decideCard({ ...po, answeredHookCall: { ...rozliczone, seq: 6 } }).kind)
      .toBe('card');
  });

  it('osłona kończy się na ŚWIEŻYM zrzucie: DRUGIE identyczne wywołanie dostaje kartę', () => {
    /*
     * Dwa `AskUserQuestion` o identycznej treści w jednej turze (dokładnie przypadek, dla
     * którego `answerKey` ma nonce) mają tę samą blokadę: dialogi idą pod
     * rząd bez mignięcia `agent_status`. Treść i numer blokady nie odróżniają ich więc
     * od wywołania JUŻ ROZLICZONEGO, a gdyby tylko one kończyły osłonę, drugie
     * pytanie nie dostałoby karty do końca blokady, bez fallbacku i bez wpisu odmowy
     * w dzienniku. Odróżnia je GENERACJA zrzutu.
     */
    const rozliczone = { questions: PYTANIA.map((q) => String(q['question'])), seq: 7, key: 'klucz-1' };
    const drugie: PendingTool = { ...JSONL_PYTANIE, id: 'toolu_DRUGIE' };
    const wejscie = (over: Partial<DecideInput> = {}): DecideInput => input({
      pending: drugie, text: TAB1, answeredHookCall: rozliczone, answeredSeq: 7, blockedSeq: 7,
      ...over,
    });

    // Zrzut pytania B (nowy nonce w kluczu) stoi w `pending/` — hook czeka na odpowiedź.
    const zrzutB = zrzutDwaPytania({ answerKey: 'klucz-2' });
    const action = decideCard(wejscie({ hookPending: hookPendingFrom(zrzutB), hookRaw: zrzutB }));
    if (action.kind !== 'card') throw new Error(`spodziewano karty, jest ${action.kind}`);
    if (action.card.event.type !== 'question-request') throw new Error('spodziewano pytania');
    expect(action.card.event.channel).toBe('hook');
    expect(action.card.active.hookAnswer?.key).toBe('klucz-2');

    // Bez zrzutu (plik B jeszcze nie powstał) osłona trzyma — to jest jej właściwe okno.
    expect(decideCard(wejscie()).kind).toBe('keep');
    // Zrzut o TYM SAMYM kluczu to zrzut wywołania rozliczonego (np. kasowanie się nie udało),
    // a nie nowe wywołanie.
    expect(decideCard(wejscie({ hookPending, hookRaw: zrzut })).kind).toBe('keep');
  });
});

describe('decideCard — `multiSelect` od autora pytania (cyfra nie zaznacza)', () => {
  /*
   * Payload przepisany z fixture'u RĘCZNIE, bo `parseOptions` oddaje dla zakładki
   * wielokrotnej `question: null` — nie ma z czego go wygenerować. Treść i komplet
   * etykiet muszą trafić co do znaku: na tym stoi cross-check `hookQuestionFrom`.
   */
  const zrzut = zrzutDwaPytania({
    answerKey: undefined,
    hookEventName: 'PreToolUse',
    toolInput: {
      questions: [{
        question: 'Które dodatki włączyć?',
        header: 'Dodatki',
        multiSelect: true,
        options: [
          { label: 'Posypka', description: 'Kolorowa' },
          { label: 'Polewa', description: 'Czekoladowa' },
          { label: 'Bita śmietana', description: 'Domowa' },
        ],
      }],
    },
  });
  const hookPending = hookPendingFrom(zrzut);

  it('karta bez przycisków, z powodem `multi-select` w dzienniku i na karcie', () => {
    const action = decideCard(input({ hookPending, text: TAB2 }));
    expect(action).toMatchObject({
      kind: 'screen-dialog', reason: 'multi-select', audit: 'multi-select',
      resolved: null,
    });
    // Wycinek ekranu NA karcie: formularza wielokrotnego Rarog nie umie obsłużyć, więc
    // jedyną treścią, jaką człowiek dostanie na telefonie, jest to, co widać w panelu.
    if (action.kind !== 'screen-dialog') throw new Error('spodziewano fallbacku');
    expect(action.screen).toContain('Które dodatki');
  });

  it('ta sama zakładka stoi dalej → `keep`, ale numer blokady się przestawia', () => {
    const pierwsza = decideCard(input({ hookPending, text: TAB2 }));
    if (pierwsza.kind !== 'screen-dialog') throw new Error('spodziewano fallbacku');
    const action = decideCard(input({
      hookPending, text: TAB2, active: karta(pierwsza.reqId),
    }));
    expect(action).toEqual({ kind: 'keep', touchSeq: true });
  });
});

describe('decideCard — ścieżka jsonl', () => {
  it('wpis i ekran mówią o tym samym → karta z przyciskami, bez odmowy', () => {
    const action = decideCard(input({ pending: JSONL_BASH, text: PERMISSION }));
    expect(action).toMatchObject({ kind: 'card', audit: null });
  });

  it('rozjazd nazwy narzędzia → karta zdegradowana, odmowa `mismatch` w dzienniku', () => {
    const action = decideCard(input({
      pending: { ...JSONL_BASH, toolName: 'Edit' }, text: PERMISSION,
    }));
    expect(action).toMatchObject({ kind: 'card', audit: 'mismatch' });
  });

  /*
   * Wycinek jest POLEM KARTY, nie wiadomością dopisywaną do transkryptu (flaga `snippet`),
   * więc na pytanie „kto niesie treść ekranu" odpowiedzi szukamy w zdarzeniu, nie w skutku ubocznym.
   */
  it('wycinek ekranu jedzie NA karcie zdegradowanej, a karta z przyciskami go nie ma', () => {
    const ok = decideCard(input({ pending: JSONL_BASH, text: PERMISSION }));
    const zly = decideCard(input({ pending: { ...JSONL_BASH, toolName: 'Edit' }, text: PERMISSION }));
    if (ok.kind !== 'card' || zly.kind !== 'card') throw new Error('spodziewano kart');
    if (ok.card.event.type !== 'permission-request') throw new Error('spodziewano zgody');
    if (zly.card.event.type !== 'permission-request') throw new Error('spodziewano zgody');
    expect(ok.card.event.screen).toBeUndefined();
    expect(zly.card.event.screen).toContain('Do you want to proceed?');
  });
});

/*
 * Karta bez przycisków z wpisem jsonl nie może mieć `reqId` równego bazie z pliku: bramka „ta sama karta"
 * w driverze kończyłaby każdą ocenę PRZED odczytem ekranu i karta stałaby do końca blokady, choć dialog dawno
 * jest czytelny. Widok fullscreen przewinięty w górę (palec w kliencie SSH na telefonie) daje ekran bez dialogu.
 * Fixture'y z żywego panelu, oczyszczone z treści sesji.
 */
describe('decideCard — karta bez przycisków z jsonl odżywa', () => {
  const PRZEWINIETY = fixture('dialog-bash-przewiniety-widok-2.1.295');
  const WIDOCZNY = fixture('dialog-bash-ask-rule-2.1.295');
  const komenda = (JSON.parse(readFileSync(
    join(DIR, 'dialog-bash-ask-rule-2.1.295.command.json'), 'utf8',
  )) as { command: string }).command;
  const WPIS: PendingTool = { id: 'toolu_rm', toolName: 'Bash', input: { command: komenda }, at: '2026-10-13T11:27:18Z' };

  const zdegradowana = (action: ReturnType<typeof decideCard>) => {
    if (action.kind !== 'card' || action.card.event.type !== 'permission-request') {
      throw new Error(`spodziewano karty zgody, jest ${action.kind}`);
    }
    return action.card;
  };

  it('widok przewinięty → karta bez przycisków z tożsamością INNĄ niż baza z pliku', () => {
    const card = zdegradowana(decideCard(input({ pending: WPIS, text: PRZEWINIETY })));
    expect(card.event).toMatchObject({ input: null, reason: 'unreadable' });
    expect(card.active.options).toEqual([]);
    expect(card.active.reqId).not.toBe('toolu_rm');
    expect(card.active.reqId.startsWith('toolu_rm:')).toBe(true);
  });

  it('tekst karty `unreadable` mówi, że Rarog nie widzi opcji, i podpowiada przewinięcie', () => {
    const card = zdegradowana(decideCard(input({ pending: WPIS, text: PRZEWINIETY })));
    if (card.event.type !== 'permission-request') throw new Error('spodziewano zgody');
    expect(card.event.displayText).toContain("can't see this dialog's options");
    expect(card.event.displayText).toContain('scroll it to the bottom');
  });

  it('ten sam widok przewinięty nad tą kartą → zdarzenie zerowe', () => {
    const card = zdegradowana(decideCard(input({ pending: WPIS, text: PRZEWINIETY })));
    const again = decideCard(input({ pending: WPIS, text: PRZEWINIETY, active: karta(card.active.reqId) }));
    expect(again).toEqual({ kind: 'keep', touchSeq: false });
  });

  it('INNY widok bez dialogu (przewijanie dalej) nad tą kartą → też zdarzenie zerowe', () => {
    const card = zdegradowana(decideCard(input({ pending: WPIS, text: PRZEWINIETY })));
    const inny = PRZEWINIETY.split('\n').slice(0, -6).join('\n');
    const again = decideCard(input({ pending: WPIS, text: inny, active: karta(card.active.reqId) }));
    expect(again).toEqual({ kind: 'keep', touchSeq: false });
  });

  it('dialog wrócił na ekran → karta Z PRZYCISKAMI o tożsamości bazy, bez odmowy', () => {
    const stara = zdegradowana(decideCard(input({ pending: WPIS, text: PRZEWINIETY })));
    const action = decideCard(input({ pending: WPIS, text: WIDOCZNY, active: karta(stara.active.reqId) }));
    expect(action).toMatchObject({ kind: 'card', audit: null });
    if (action.kind !== 'card') throw new Error('spodziewano karty');
    expect(action.card.active.reqId).toBe('toolu_rm');
    expect(action.card.active.options.map((o) => o.label)).toEqual(['Yes', 'No']);
  });

  it('przewijanie dialogu bez podwójnego dowodu: `unreadable` ↔ `mismatch` to ta sama karta', () => {
    // Ramka pokazuje INNĄ komendę niż wpis (bez zrzutu hooka) → `mismatch` z powodem `operation`.
    const innyWpis: PendingTool = { ...WPIS, input: { command: 'rm -rf -- "$B"/inne' } };
    const przewiniety = zdegradowana(decideCard(input({ pending: innyWpis, text: PRZEWINIETY })));
    expect(przewiniety.event).toMatchObject({ reason: 'unreadable' });
    const naDole = decideCard(input({ pending: innyWpis, text: WIDOCZNY, active: karta(przewiniety.active.reqId) }));
    expect(naDole).toEqual({ kind: 'keep', touchSeq: false });
    const odwrotnie = zdegradowana(decideCard(input({ pending: innyWpis, text: WIDOCZNY })));
    expect(odwrotnie.event).toMatchObject({ reason: 'mismatch' });
    expect(decideCard(input({ pending: innyWpis, text: PRZEWINIETY, active: karta(odwrotnie.active.reqId) })))
      .toEqual({ kind: 'keep', touchSeq: false });
  });

  it('rozjazd nazwy narzędzia ma inną tożsamość niż ekran nieczytelny', () => {
    const nieczytelny = zdegradowana(decideCard(input({ pending: WPIS, text: PRZEWINIETY })));
    const rozjazd = zdegradowana(decideCard(input({
      pending: { ...WPIS, toolName: 'Edit', input: { file_path: '/x' } }, text: WIDOCZNY,
    })));
    expect(rozjazd.event).toMatchObject({ reason: 'mismatch' });
    expect(rozjazd.active.reqId).not.toBe(nieczytelny.active.reqId);
  });

  it('wpis stęchły (`Read`), dialog `Bash` bez zrzutu: przewijanie nie przełącza karty', () => {
    const stary: PendingTool = { id: 'toolu_read', toolName: 'Read', input: { file_path: '/a.png' }, at: WPIS.at };
    const przewiniety = zdegradowana(decideCard(input({ pending: stary, text: PRZEWINIETY })));
    expect(przewiniety.event).toMatchObject({ toolName: 'Read', reason: 'unreadable' });
    // Dialog wraca na ekran: nazwa z ekranu przeczy wpisowi — JEDNA nowa karta, z nazwą z ekranu.
    const naDole = zdegradowana(decideCard(input({
      pending: stary, text: WIDOCZNY, active: karta(przewiniety.active.reqId),
    })));
    expect(naDole.event).toMatchObject({ toolName: 'Bash', reason: 'mismatch' });
    // Kolejne przewinięcia w obie strony nad kartą `Bash` niczego już nie wysyłają.
    for (const text of [PRZEWINIETY, WIDOCZNY, PRZEWINIETY]) {
      expect(decideCard(input({ pending: stary, text, active: karta(naDole.active.reqId) })))
        .toEqual({ kind: 'keep', touchSeq: false });
    }
  });

  it('NOWE wywołanie nad stojącą kartą bez przycisków, ekran dalej przewinięty → nowa karta', () => {
    const stara = zdegradowana(decideCard(input({ pending: WPIS, text: PRZEWINIETY })));
    const nowe: PendingTool = { ...WPIS, id: 'toolu_rm2' };
    const action = zdegradowana(decideCard(input({ pending: nowe, text: PRZEWINIETY, active: karta(stara.active.reqId) })));
    expect(action.active.reqId.startsWith('toolu_rm2:d:')).toBe(true);
  });

  it('konkurujące źródła BEZ wyniku „oba pasują": przewinięty → sufiks, dialog wraca → przyciski zrzutu', () => {
    const stary: PendingTool = { id: 'toolu_read', toolName: 'Read', input: { file_path: '/a.png' }, at: WPIS.at };
    const hookRaw: PendingHookTool = {
      toolName: 'Bash', hookEventName: 'PermissionRequest', toolInput: { command: komenda }, at: Date.parse(WPIS.at) + 900,
    };
    const hookPending = hookPendingFrom(hookRaw);
    if (hookPending === null) throw new Error('zrzut bez narzędzia');
    const base = decideReqId(hookPending, 7, stary);
    const przewiniety = zdegradowana(decideCard(input({ pending: stary, hookPending, hookRaw, text: PRZEWINIETY, reqId: base })));
    expect(przewiniety.active.reqId.startsWith(`${base}:d:`)).toBe(true);
    const action = decideCard(input({
      pending: stary, hookPending, hookRaw, text: WIDOCZNY, reqId: base, active: karta(przewiniety.active.reqId),
    }));
    expect(action).toMatchObject({ kind: 'card', audit: null });
    if (action.kind !== 'card' || action.card.event.type !== 'permission-request') throw new Error('spodziewano zgody');
    expect(action.card.event.input).toEqual({ command: komenda });
    expect(action.card.active.options.map((o) => o.label)).toEqual(['Yes', 'No']);
  });
});

/*
 * Osłona po WŁASNEJ decyzji: po cyfrze albo `escape` ta sama karta nie wraca w tej samej blokadzie,
 * choć ekran jeszcze pokazuje dialog albo już nic. Zgłoszenie: „karta znika, wraca na ułamek sekundy i po ~2 s
 * znika znowu".
 */
describe('decideCard — osłona po własnej decyzji', () => {
  const PRZEWINIETY = fixture('dialog-bash-przewiniety-widok-2.1.295');
  const WIDOCZNY = fixture('dialog-bash-ask-rule-2.1.295');
  const komenda = (JSON.parse(readFileSync(
    join(DIR, 'dialog-bash-ask-rule-2.1.295.command.json'), 'utf8',
  )) as { command: string }).command;
  const WPIS: PendingTool = { id: 'toolu_rm', toolName: 'Bash', input: { command: komenda }, at: '2026-10-13T11:27:18Z' };
  const decided = (over: Partial<DecidedShield> = {}): DecidedShield => ({
    reqId: 'toolu_rm~hook:1', callPrint: callPrint('Bash', { command: komenda }), callId: 'toolu_rm',
    pendingId: 'toolu_rm', pendingYounger: false, bodyPrint: null, screenReqId: null, hookAt: 1, seq: 7, ...over,
  });

  it('dialog jeszcze na ekranie, `reqId` inny (zrzut skasowany po cyfrze) → zdarzenie zerowe', () => {
    expect(decideCard(input({ pending: WPIS, text: WIDOCZNY, decided: decided() }))).toEqual({ kind: 'keep', touchSeq: false });
  });

  it('dialogu już nie widać → zdarzenie zerowe, bez ponowienia i bez karty bez przycisków', () => {
    expect(decideCard(input({ pending: WPIS, text: PRZEWINIETY, decided: decided(), canRetry: true })))
      .toEqual({ kind: 'keep', touchSeq: false });
  });

  it('nowa blokada → karta wychodzi', () => {
    expect(decideCard(input({ pending: WPIS, text: WIDOCZNY, decided: decided({ seq: 6 }) })))
      .toMatchObject({ kind: 'card', audit: null });
  });

  it('nowy wpis jsonl o tej samej treści → karta wychodzi od razu', () => {
    expect(decideCard(input({ pending: { ...WPIS, id: 'toolu_rm2' }, text: WIDOCZNY, decided: decided() })))
      .toMatchObject({ kind: 'card', audit: null });
  });

  it('nowa generacja zrzutu `PermissionRequest` → karta wychodzi (to nowy dialog)', () => {
    const hookRaw: PendingHookTool = {
      toolName: 'Bash', hookEventName: 'PermissionRequest', toolInput: { command: komenda }, at: 99,
    };
    expect(decideCard(input({ pending: WPIS, text: WIDOCZNY, hookRaw, decided: decided() })))
      .toMatchObject({ kind: 'card', audit: null });
  });

  it('inna komenda na ekranie (`mismatch`) dla tego samego wpisu → bez osłony, karta bez przycisków', () => {
    const inny: PendingTool = { ...WPIS, input: { command: 'rm -rf -- "$B"/inne' } };
    const action = decideCard(input({
      pending: inny, text: WIDOCZNY, decided: decided({ callPrint: callPrint('Bash', inny.input) }),
    }));
    expect(action).toMatchObject({ kind: 'card', audit: 'mismatch' });
  });

  it('odcisk wywołania: kolejność kluczy bez znaczenia, kolejność tablic i nazwa narzędzia — tak', () => {
    expect(callPrint('Bash', { a: 1, b: { c: 2, d: 3 } })).toBe(callPrint('Bash', { b: { d: 3, c: 2 }, a: 1 }));
    expect(callPrint('Bash', { a: [1, 2] })).not.toBe(callPrint('Bash', { a: [2, 1] }));
    expect(callPrint('Bash', { command: 'ls' })).not.toBe(callPrint('Edit', { command: 'ls' }));
  });

  it('karta zgody niesie materiał osłony: odcisk wywołania, źródło i wpis obok', () => {
    const action = decideCard(input({ pending: WPIS, text: WIDOCZNY }));
    if (action.kind !== 'card') throw new Error('spodziewano karty');
    expect(action.card.active).toMatchObject({
      callPrint: callPrint('Bash', { command: komenda }), callId: 'toolu_rm', pendingId: 'toolu_rm',
    });
  });
});

/*
 * Wyjątek od tej reguły: karta „ekran pasuje do OBU wywołań" zostaje przy
 * gołej bazie, czyli zamrożona do zmiany źródeł. Rozstrzygnięcie konkurencji sprawdza treść tylko dla
 * zrzutu, a dla narzędzi innych niż `Bash` sprowadza się do fragmentu ścieżki na ekranie — po przewinięciu,
 * które zabierze tę linię, kolejna ocena oddałaby przyciski stęchłemu wpisowi jsonl.
 */
describe('decideCard — konkurujące źródła pasujące oba zostają zamrożone', () => {
  const EDIT = readFileSync(join(DIR, 'measured', 'zgoda-edit-2.1.293.txt'), 'utf8');
  const stary: PendingTool = { id: 'toolu_old', toolName: 'Edit', input: { file_path: '/old/file.txt' }, at: '2026-10-13T11:00:00Z' };
  const hookRaw: PendingHookTool = {
    toolName: 'Edit', hookEventName: 'PermissionRequest', toolInput: { file_path: '/current/pomiar-dialogow.txt' },
    at: Date.parse('2026-10-13T11:00:05Z'),
  };
  const fromHook = hookPendingFrom(hookRaw);
  if (fromHook === null) throw new Error('zrzut bez narzędzia');
  const hookPending: PendingTool = fromHook;
  const base = decideReqId(hookPending, 7, stary);

  it('ekran pasuje do obu → karta bez przycisków o GOŁEJ bazie (bramka w driverze ją trzyma)', () => {
    /*
     * Ekran potwierdza `Edit` ścieżką z nagłówka i diffem porównanym dosłownie, bez białych znaków na końcu
     * linii. Do obu pasują więc wyłącznie różne
     * edycje, które dają ten sam diff: tu zamiana całej linii i zamiana samego pierwszego słowa.
     */
    const plik = { file_path: '/pomiar/pomiar-dialogow.txt' };
    const wpis: PendingTool = { ...stary, input: { ...plik, old_string: 'stara wartosc', new_string: 'nowa wartosc' } };
    const raw: PendingHookTool = { ...hookRaw, cwd: '/pomiar', toolInput: { ...plik, old_string: 'stara', new_string: 'nowa' } };
    const zrzutObok = hookPendingFrom(raw);
    if (zrzutObok === null) throw new Error('zrzut bez narzędzia');
    const baza = decideReqId(zrzutObok, 7, wpis);
    expect(hookMatchesScreen(zrzutObok, EDIT)).toBe(true);
    // Wpis jsonl nie niesie `cwd`: ekran go nie potwierdza, ale też mu nie przeczy, więc nie odpada.
    expect(screenConfirmsInput(wpis, EDIT)).toBe(false);
    expect(editContradictsScreen(wpis, EDIT)).toBe(false);
    // `decideCardRaw`: to JEDYNE wyjście, które niezmiennik z góry pliku świadomie przepuszcza.
    const action = decideCardRaw(input({ pending: wpis, hookPending: zrzutObok, hookRaw: raw, text: EDIT, reqId: baza }));
    expect(action).toMatchObject({ kind: 'card', audit: 'mismatch' });
    if (action.kind !== 'card') throw new Error('spodziewano karty');
    expect(action.card.active.reqId).toBe(baza);
  });

  it('ścieżka zrzutu zniknęła z ekranu → stęchły wpis NIE dostaje przycisków nad tą kartą', () => {
    /*
     * Wynik to nie `keep` (wpis wygrywający samą nazwą, z kartą o tej samej bazie). Ekran bez treści wpisu daje znowu kartę bez przycisków o tej samej bazie. W driverze tej
     * oceny nie ma: bramka „ta sama karta" kończy ją przed odczytem ekranu.
     */
    const action = decideCardRaw(input({
      pending: stary, hookPending, hookRaw, text: EDIT, reqId: base, active: karta(base),
    }));
    expect(action).toMatchObject({ kind: 'card', audit: 'mismatch' });
    if (action.kind !== 'card' || action.card.event.type !== 'permission-request') throw new Error('spodziewano zgody');
    expect(action.card.event.input).toBeNull();
    expect(action.card.active.reqId).toBe(base);
  });
});

/*
 * Wpis jsonl i zrzut hooka tego samego narzędzia innego niż `Bash`, a ekran nie potwierdza treści żadnego
 * z nich. Dialog `Edit` pokazuje samą nazwę pliku, więc ani ścieżka wpisu, ani ścieżka zrzutu nie stoi na
 * ekranie. Wpis wygrywający samą nazwą narzędzia dałby karcie przyciski z treścią pliku A, a cyfra
 * zatwierdzałaby dialog pliku B.
 */
describe('decideCard — konkurencja tego samego narzędzia bez potwierdzenia treści', () => {
  const EDIT = readFileSync(join(DIR, 'measured', 'zgoda-edit-2.1.293.txt'), 'utf8');
  /**
   * Wejście `Edit`, które dialog z pomiaru POTWIERDZA: plik `pomiar-dialogow.txt` w katalogu
   * sesji `/pomiar` i diff `stara wartosc` → `nowa wartosc`. Do tej daty dowodem była pełna ścieżka doklejona do
   * scrollbacku nad dialogiem — ta sama, którą „Known gaps” opisywały jako lukę.
   */
  const POTWIERDZONY = {
    file_path: '/pomiar/pomiar-dialogow.txt', old_string: 'stara wartosc', new_string: 'nowa wartosc',
  };
  const stary: PendingTool = { id: 'toolu_old', toolName: 'Edit', input: { file_path: '/old/file.txt' }, at: '2026-10-13T11:00:00Z' };
  const zrzut = (toolName: string): { raw: PendingHookTool; pending: PendingTool } => {
    const raw: PendingHookTool = {
      toolName, hookEventName: 'PermissionRequest', toolInput: { file_path: '/current/pomiar-dialogow.txt' },
      at: Date.parse('2026-10-13T11:00:05Z'),
    };
    const pending = hookPendingFrom(raw);
    if (pending === null) throw new Error('zrzut bez narzędzia');
    return { raw, pending };
  };
  const zgoda = (action: DecideAction) => {
    if (action.kind !== 'card' || action.card.event.type !== 'permission-request') {
      throw new Error(`spodziewano karty zgody, jest ${action.kind}`);
    }
    return { card: action.card, event: action.card.event, audit: action.audit };
  };

  it('ekran bez ścieżki wpisu i zrzutu → karta BEZ przycisków o gołej bazie, nie przyciski stęchłego wpisu', () => {
    const { raw, pending: hookPending } = zrzut('Edit');
    const base = decideReqId(hookPending, 7, stary);
    // `decideCardRaw`: karta „nie wiadomo, które wywołanie zatwierdza cyfra" stoi przy gołej bazie (wyjątek).
    const { card, event, audit } = zgoda(decideCardRaw(input({
      pending: stary, hookPending, hookRaw: raw, text: EDIT, reqId: base,
    })));
    expect(audit).toBe('mismatch');
    expect(event.input).toBeNull();
    expect(card.active.options).toEqual([]);
    expect(card.active.reqId).toBe(base);
  });

  it('ekran zgodny z WPISEM, zrzut bez treści edycji → karta bez przycisków (wpis bez `cwd` nie ma dowodu)', () => {
    /*
     * Ścieżkę względną da się potwierdzić wyłącznie względem `cwd` wywołania, a wpis jsonl go nie niesie; `cwd`
     * konkurującego zrzutu to katalog INNEGO wywołania i nie wolno go pożyczać.
     */
    const { raw: zrzutInny, pending: hookPending } = zrzut('Edit');
    const raw: PendingHookTool = { ...zrzutInny, cwd: '/pomiar' };
    const wpis: PendingTool = { ...stary, input: POTWIERDZONY };
    const base = decideReqId(hookPending, 7, wpis);
    const { card, event, audit } = zgoda(decideCardRaw(input({
      pending: wpis, hookPending, hookRaw: raw, text: EDIT, reqId: base,
    })));
    expect(audit).toBe('mismatch');
    expect(event.input).toBeNull();
    expect(card.active.options).toEqual([]);
  });

  it('wpis tej edycji i zrzut TEJ SAMEJ edycji w innym katalogu → karta bez przycisków, `cwd` zrzutu nie wyklucza wpisu', () => {
    // Ekran nie pokazuje katalogu wywołania: ścieżka względna pasuje do obu plików, więc nie wiadomo, który zatwierdzi cyfra.
    const raw: PendingHookTool = {
      toolName: 'Edit', hookEventName: 'PermissionRequest', cwd: '/inny-projekt',
      toolInput: { ...POTWIERDZONY, file_path: '/inny-projekt/pomiar-dialogow.txt' }, at: Date.parse('2026-10-13T11:00:05Z'),
    };
    const hookPending = hookPendingFrom(raw);
    if (hookPending === null) throw new Error('zrzut bez narzędzia');
    const wpis: PendingTool = { ...stary, input: POTWIERDZONY };
    expect(hookMatchesScreen(hookPending, EDIT)).toBe(true);
    const base = decideReqId(hookPending, 7, wpis);
    const { card, event, audit } = zgoda(decideCardRaw(input({
      pending: wpis, hookPending, hookRaw: raw, text: EDIT, reqId: base,
    })));
    expect(audit).toBe('mismatch');
    expect(event.input).toBeNull();
    expect(card.active.options).toEqual([]);
    expect(card.active.reqId).toBe(base);
  });

  it('ekran potwierdza ZRZUT, a stęchły wpis `Edit` innego pliku pasuje samą nazwą → karta zrzutu z przyciskami', () => {
    // Wpis pasował do ekranu samą nazwą narzędzia, więc reguła „pasują oba” odbierała
    // przyciski karcie, której treść ekran potwierdził ścieżką i diffem.
    const raw: PendingHookTool = {
      toolName: 'Edit', hookEventName: 'PermissionRequest', toolInput: POTWIERDZONY, cwd: '/pomiar',
      at: Date.parse('2026-10-13T11:00:05Z'),
    };
    const hookPending = hookPendingFrom(raw);
    if (hookPending === null) throw new Error('zrzut bez narzędzia');
    const base = decideReqId(hookPending, 7, stary);
    const { card, event, audit } = zgoda(decideCard(input({
      pending: stary, hookPending, hookRaw: raw, text: EDIT, reqId: base,
    })));
    expect(audit).toBeNull();
    expect(event.input).toEqual(POTWIERDZONY);
    expect(card.active.options.map((o) => o.label)).toContain('Yes');
    // Odcisk ramki i generacja zrzutu jadą z kartą do kontroli tuż przed cyfrą (`#digitStillHolds`).
    expect(card.active.bodyPrint).toBe(parseOptions(EDIT)?.bodyPrint);
    expect(card.active.bodyPrint).toMatch(/^[0-9a-f]{16}$/u);
  });

  it('różne narzędzia: wpis `Edit` innego pliku, zrzut `Read`, dialog `Edit` → karta bez przycisków', () => {
    // Wpis `Edit` nie dostaje tu przycisków samą nazwą; ekran nie dowodzi jego pliku.
    const { raw, pending: hookPending } = zrzut('Read');
    const base = decideReqId(hookPending, 7, stary);
    const { card, event, audit } = zgoda(decideCardRaw(input({
      pending: stary, hookPending, hookRaw: raw, text: EDIT, reqId: base,
    })));
    expect(audit).toBe('mismatch');
    expect(event.input).toBeNull();
    expect(card.active.options).toEqual([]);
  });

  it('różne narzędzia: wpis `Read`, zrzut `Edit` bez ścieżki na ekranie → rozjazd nazwy, karta z sufiksem (bez zmian)', () => {
    const { raw, pending: hookPending } = zrzut('Edit');
    const staryRead: PendingTool = { ...stary, id: 'toolu_read', toolName: 'Read' };
    const base = decideReqId(hookPending, 7, staryRead);
    const { card, event, audit } = zgoda(decideCard(input({
      pending: staryRead, hookPending, hookRaw: raw, text: EDIT, reqId: base,
    })));
    expect(audit).toBe('mismatch');
    expect(event.input).toBeNull();
    expect(event.toolName).toBe('Edit');
    expect(card.active.reqId.startsWith(`${base}:d:`)).toBe(true);
  });

  it('różne narzędzia: wpis `Read`, zrzut `Edit` potwierdzony przez ekran → karta zrzutu z przyciskami', () => {
    const raw: PendingHookTool = {
      toolName: 'Edit', hookEventName: 'PermissionRequest', toolInput: POTWIERDZONY, cwd: '/pomiar',
      at: Date.parse('2026-10-13T11:00:05Z'),
    };
    const hookPending = hookPendingFrom(raw);
    if (hookPending === null) throw new Error('zrzut bez narzędzia');
    const staryRead: PendingTool = { ...stary, id: 'toolu_read', toolName: 'Read' };
    const base = decideReqId(hookPending, 7, staryRead);
    const { card, event, audit } = zgoda(decideCard(input({
      pending: staryRead, hookPending, hookRaw: raw, text: EDIT, reqId: base,
    })));
    expect(audit).toBeNull();
    expect(event.input).toEqual(POTWIERDZONY);
    expect(card.active.options.map((o) => o.label)).toContain('Yes');
  });

  it('to samo narzędzie MCP, wpis bez pola do porównania → karta BEZ przycisków', () => {
    // Brak fragmentu we wpisie nie jest potwierdzeniem treści: `hookMatchesScreen` przepuszcza takie wejście,
    // a ścisłe `screenConfirmsInput` już nie.
    const MCP = readFileSync(join(DIR, 'measured', 'zgoda-mcp-2.1.293.txt'), 'utf8');
    const tool = 'mcp__catalog__catalog_get_project_tree_layout';
    const wpis: PendingTool = { id: 'toolu_mcp', toolName: tool, input: {}, at: '2026-10-19T11:00:00Z' };
    const raw: PendingHookTool = {
      toolName: tool, hookEventName: 'PermissionRequest', toolInput: { pattern: 'current-pattern-not-on-screen' },
      at: Date.parse('2026-10-19T11:00:05Z'),
    };
    const hookPending = hookPendingFrom(raw);
    if (hookPending === null) throw new Error('zrzut bez narzędzia');
    const { card, event, audit } = zgoda(decideCardRaw(input({
      pending: wpis, hookPending, hookRaw: raw, text: MCP, reqId: decideReqId(hookPending, 7, wpis),
    })));
    expect(audit).toBe('mismatch');
    expect(event.input).toBeNull();
    expect(card.active.options).toEqual([]);
  });

  /** Osłona po Esc na karcie `card`, jak w driverze: migawka karty i odcisk ekranu `EDIT`, w który poszedł klawisz. */
  const poOdrzuceniu = (card: DecisionCard, base: string, hookAt: number): DecidedShield => ({
    reqId: base, callPrint: card.active.callPrint ?? null, callId: card.active.callId ?? null,
    pendingId: card.active.pendingId ?? null, pendingYounger: false, bodyPrint: parseOptions(EDIT)?.bodyPrint ?? null,
    screenReqId: null, hookAt, seq: 7,
  });

  it('karta niesie odcisk wpisu, a „Odrzuć” na niej nie oddaje potem przycisków stęchłemu wpisowi', () => {
    const { raw, pending: hookPending } = zrzut('Edit');
    const base = decideReqId(hookPending, 7, stary);
    const { card } = zgoda(decideCardRaw(input({ pending: stary, hookPending, hookRaw: raw, text: EDIT, reqId: base })));
    expect(card.active).toMatchObject({
      callPrint: callPrint('Edit', stary.input), callId: stary.id, pendingId: stary.id,
    });
    // Po Esc driver kasuje zrzut i zakłada osłonę z migawki karty i odcisku ekranu, w który poszedł `escape`;
    // ekran jeszcze się nie przemalował.
    const decided = poOdrzuceniu(card, base, raw.at);
    const po = decideCardRaw(input({ pending: stary, text: EDIT, reqId: decideReqId(stary, 7), decided }));
    // Sam stęchły wpis `Edit` nie ma dowodu pliku (karta bez przycisków), a ten sam
    // dialog na ekranie trzyma osłona po decyzji: ta sama prośba nie wraca jako nowa karta.
    expect(po).toEqual({ kind: 'keep', touchSeq: false });
  });

  describe('osłona po „Odrzuć” na karcie bez przycisków nie połyka następnej zgody (karta 0d)', () => {
    const odrzucona = (): DecidedShield => {
      const { raw, pending: hookPending } = zrzut('Edit');
      const base = decideReqId(hookPending, 7, stary);
      const { card } = zgoda(decideCardRaw(input({ pending: stary, hookPending, hookRaw: raw, text: EDIT, reqId: base })));
      expect(card.active.options).toEqual([]);
      return poOdrzuceniu(card, base, raw.at);
    };

    it('inne wywołanie (nowy wpis `Edit`, inny odcisk) po „Odrzuć” → nowa karta', () => {
      const decided = odrzucona();
      const nowy: PendingTool = {
        id: 'toolu_new', toolName: 'Edit', input: { file_path: '/other/file.txt' }, at: '2026-10-13T11:00:10Z',
      };
      expect(callPrint(nowy.toolName, nowy.input)).not.toBe(decided.callPrint);
      const po = decideCardRaw(input({ pending: nowy, text: EDIT, reqId: decideReqId(nowy, 7), decided }));
      if (po.kind !== 'card') return expect.unreachable(`spodziewano karty, jest ${po.kind}`);
      expect(po.card.active.callPrint).toBe(callPrint(nowy.toolName, nowy.input));
    });

    it('ten sam stęchły wpis, a na ekranie dialog innego narzędzia (`Bash`) → nowa karta', () => {
      const decided = odrzucona();
      const BASH = readFileSync(join(DIR, 'measured', 'zgoda-bash-2.1.293.txt'), 'utf8');
      const po = decideCardRaw(input({ pending: stary, text: BASH, reqId: decideReqId(stary, 7), decided }));
      if (po.kind !== 'card') return expect.unreachable(`spodziewano karty, jest ${po.kind}`);
      expect(po.audit).toBe('mismatch');
      expect(po.card.event.type === 'permission-request' ? po.card.event.toolName : 'inna karta').toBe('Bash');
    });
  });
});

describe('decideCard — ekran przeglądu formularza przy wpisie w jsonl', () => {
  /** Ostatni krok formularza wielopytaniowego: „Review your answers" + Submit answers/Cancel. */
  const REVIEW = fixture('dialog-askuserquestion-multiq-review');
  const JSONL_PYTANIE: PendingTool = {
    id: 'toolu_q1',
    toolName: 'AskUserQuestion',
    input: { questions: hookQuestionsFromScreen(TAB1) },
    at: '2026-09-21T00:00:00Z',
  };

  it('wpis `AskUserQuestion` + ekran przeglądu → karta EKRANOWA z „Submit answers", bez odmowy', () => {
    // Zmierzone na CLI 2.1.273: ten ekran nie może kończyć się `mismatch/kind` i kartą
    // „odpowiedz w terminalu", skoro ten sam ekran BEZ wpisu w jsonl kartę ma.
    const zWpisem = decideCard(input({ pending: JSONL_PYTANIE, text: REVIEW }));
    const bezWpisu = decideCard(input({ text: REVIEW }));
    expect(zWpisem).toMatchObject({ kind: 'card', audit: null });
    if (zWpisem.kind !== 'card' || bezWpisu.kind !== 'card') throw new Error('spodziewano kart');
    expect(JSON.stringify(zWpisem.card.event)).toContain('Submit answers');
    // Tożsamość i treść liczą się z EKRANU — dokładnie ta karta, którą daje ścieżka bez jsonl.
    expect(zWpisem.card.event).toEqual(bezWpisu.card.event);
  });

  it('ten sam przegląd stoi dalej → zdarzenie zerowe', () => {
    const first = decideCard(input({ pending: JSONL_PYTANIE, text: REVIEW }));
    if (first.kind !== 'card') throw new Error('spodziewano karty');
    const again = decideCard(input({
      pending: JSONL_PYTANIE, text: REVIEW, active: karta(first.card.active.reqId),
    }));
    expect(again).toMatchObject({ kind: 'keep' });
  });

  it('wpis INNEGO narzędzia nad ekranem przeglądu zostaje rozjazdem (fail-closed)', () => {
    const action = decideCard(input({ pending: JSONL_BASH, text: REVIEW }));
    expect(action).toMatchObject({ kind: 'card', audit: 'mismatch' });
  });

  it('wpis pytania nad CUDZYM potwierdzeniem (nie przegląd) zostaje rozjazdem', () => {
    const action = decideCard(input({ pending: JSONL_PYTANIE, text: TRUST }));
    expect(action).toMatchObject({ kind: 'card', audit: 'mismatch' });
  });
});

describe('decideCard — ścieżka ekranowa (dialog spoza jsonl)', () => {
  /*
   * Obie te karty niosą DOSŁOWNĄ treść dialogu (opcje z cyframi, pytanie), więc wycinka
   * ekranu nie dostają: wycinek jest polem karty, a nie osobną wiadomością do
   * transkryptu, niezależną od tego, co karta już pokazuje.
   */
  it('zgoda na narzędzie z ekranu → karta zgody, bez wycinka', () => {
    const action = decideCard(input({ text: PERMISSION }));
    expect(action).toMatchObject({ kind: 'card', audit: null });
  });

  it('formularz pytania z ekranu → karta pytania, bez wycinka', () => {
    const action = decideCard(input({ text: TAB1 }));
    expect(action).toMatchObject({ kind: 'card', audit: null });
  });

  it('ten sam formularz stoi dalej → `keep` z przestawieniem numeru blokady', () => {
    const pierwsza = decideCard(input({ text: PERMISSION }));
    if (pierwsza.kind !== 'card') throw new Error('spodziewano karty');
    const action = decideCard(input({
      text: PERMISSION, active: karta(pierwsza.card.active.reqId),
    }));
    expect(action).toEqual({ kind: 'keep', touchSeq: true });
  });

  it('dialog z zamkniętej listy sygnatur (zaufanie) NIE jest odmową', () => {
    const action = decideCard(input({ text: TRUST }));
    expect(action).toMatchObject({ kind: 'screen-dialog', reason: null, audit: null });
  });

  it('ten sam fallback stoi dalej → `keep` z przestawieniem numeru blokady', () => {
    const pierwsza = decideCard(input({ text: TRUST }));
    if (pierwsza.kind !== 'screen-dialog') throw new Error('spodziewano fallbacku');
    const action = decideCard(input({ text: TRUST, active: karta(pierwsza.reqId) }));
    expect(action).toEqual({ kind: 'keep', touchSeq: true });
  });
});

describe('decideCard — okna ochronne', () => {
  it('pusta ocena w blokadzie, na którą poszła NASZA cyfra, nie stawia fallbacku', () => {
    const action = decideCard(input({ text: NIC, answeredSeq: 7, blockedSeq: 7 }));
    expect(action).toEqual({ kind: 'keep', touchSeq: false });
  });

  it('nowa blokada zdejmuje to okno — fallback wraca do łask', () => {
    const action = decideCard(input({ text: NIC, answeredSeq: 6, blockedSeq: 7 }));
    expect(action).toMatchObject({ kind: 'screen-dialog', audit: 'unreadable' });
  });

  it('nieczytelny ekran nad kartą Z OPCJAMI zostawia ją stać (ekranowa: z numerem)', () => {
    const active = karta('screen:q:abc', { options: [{ label: 'Tak', digit: '1' }], screen: true });
    expect(decideCard(input({ text: null, active }))).toEqual({ kind: 'keep', touchSeq: true });
  });

  it('…a karcie z JSONL numeru blokady nie przestawia (jej tożsamość niesie plik)', () => {
    const active = karta('toolu_01', { options: [{ label: 'Tak', digit: '1' }] });
    expect(decideCard(input({ text: null, active }))).toEqual({ kind: 'keep', touchSeq: false });
  });

  it('karta BEZ opcji nie chroni — nad nią pusta ocena buduje fallback', () => {
    const action = decideCard(input({ text: null, active: karta('screen:7:f:abc') }));
    expect(action).toMatchObject({ kind: 'screen-dialog', audit: 'unreadable' });
  });
});

describe('decideCard — rozjazd zrzutu hooka NIE degraduje karty (hook jest wzbogaceniem)', () => {
  /** Zrzut mówi o `Edit`, na ekranie stoi zgoda na `Bash` — czyli stęchły plik. */
  const zrzut: PendingHookTool = {
    toolName: 'Edit', hookEventName: 'PermissionRequest', toolInput: { file_path: '/x' }, at: 3,
  };

  it('karta jest DOKŁADNIE ta, którą ścieżka ekranowa zbudowałaby bez zrzutu', () => {
    const zHookiem = decideCard(input({ hookPending: hookPendingFrom(zrzut), text: PERMISSION }));
    const bezHooka = decideCard(input({ text: PERMISSION }));
    if (zHookiem.kind !== 'card' || bezHooka.kind !== 'card') throw new Error('spodziewano kart');
    expect(zHookiem.card.active.reqId).toBe(bezHooka.card.active.reqId);
    // Rozjazd zrzutu nie jest odmową: karta ma przyciski, więc nie ma czego liczyć w statystyce odmów.
    expect(zHookiem.audit).toBeNull();
  });
});
