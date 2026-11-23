/**
 * Mock-driver: deterministyczny silnik trybu demo (`RAROG_DEMO=1`).
 *
 * Cele:
 * - pokazać CAŁE UI bez jednego tokenu z limitu planu (zero ruchu do Anthropic),
 * - dać testom sterowalny driver: wszystkie opóźnienia idą przez wstrzykiwany `Scheduler`,
 *   więc `vi.advanceTimersByTimeAsync()` przewija scenariusz bez realnego czekania,
 * - być POWTARZALNYM: żadnego `Math.random()` ani `Date.now()` w treści — losowość opóźnień
 *   w scenariuszu „streaming" pochodzi z własnego generatora z ustalonym ziarnem.
 *
 * Scenariusze i triggery — wg speca, sekcja „Demo mode"; słowa wyzwalaczy i teksty odpowiedzi daje zestaw
 * treści demo (`demo/content/`), driver trzyma tylko mechanikę:
 * - `send(text)` → po 400 ms delty odpowiedzi (~60 słów, markdown z fence), tool-call,
 *   `git-status`, `result` → sesja wraca do `waiting-input`,
 * - prompt z wyzwalaczem pytania (PL „pytanie", EN „question") → `question-request` (2 pytania, drugie multiSelect),
 * - prompt z wyzwalaczem czerwonym (PL „czerwone", EN „dangerous") → `permission-request` z komendą klasyfikowaną jako red,
 * - prompt z wyzwalaczem limitu (PL i EN „limit") → `limit-reached` z `resetAt` za 2 h,
 * - prompt z wyzwalaczem błędu (PL „błąd”, „blad”, EN „crash”) → `exit { ok: false }`.
 */
import type {
  DiffFile, DiffFileStatus, GitFileDetail, GitFileKinds,
} from '@rarog/shared';
import { foreign, say } from '@rarog/shared/sentences';
import type { DecisionOutcome, DriverEvent, InternalBlock, RefuseReason, SessionDriver } from './types.ts';
import { APPLIED, STALE, refused } from './types.ts';
import { AsyncEventQueue, systemScheduler } from './runtime.ts';
import { toolCallSemantics } from './tool-text.ts';
import type { Scheduler, TimerHandle } from './runtime.ts';
import { demoContentPl } from '../demo/content/pl.ts';
import type { DemoContent, DemoProjectKey } from '../demo/content/types.ts';

// ---------------------------------------------------------------------------
// Stałe czasowe (spec)
// ---------------------------------------------------------------------------

/** Ile mock „myśli", zanim zacznie odpowiadać. */
export const REPLY_DELAY_MS = 400;
/** Odstęp między deltami w turze interaktywnej. */
export const DELTA_INTERVAL_MS = 120;
/** Odstęp: domknięta wiadomość → tool-call → git-status → result. */
export const STEP_MS = 200;
/** Zakres odstępów między deltami w scenariuszu „streaming" (spec: 300–800 ms). */
export const STREAM_MIN_MS = 300;
export const STREAM_MAX_MS = 800;
/** Co ile mock domyka wiadomość w scenariuszu „streaming" (spec: ~15 s). */
export const STREAM_MESSAGE_MS = 15_000;
/** Limit planu w demo resetuje się za 2 h. */
export const LIMIT_RESET_MS = 2 * 60 * 60 * 1000;

/** Maksymalny licznik brudnych plików w demo (spec: rośnie 1 → 3). */
export const MAX_DIRTY = 3;

/** Limit okna kontekstu raportowany w demo. */
export const DEMO_CONTEXT_LIMIT = 200_000;

/** O ile rośnie zużycie kontekstu po każdej turze demo. */
export const DEMO_CONTEXT_STEP = 12_800;

/**
 * Ostatni commit w demo — stały, żeby wiersz „ostatni commit" był widoczny bez prawdziwego repo. Temat daje
 * zestaw treści (`lastCommitSubject`).
 */
export const DEMO_LAST_COMMIT = {
  hash: '3f9a2c1',
  at: '2026-09-03T08:12:00.000Z',
} as const;

/**
 * Brudne pliki demo — JEDNO źródło dla diffu sesji (`demoDiff` w `demo/seeds.ts`) i dla każdego
 * `git-status` mocka (`files`, `fileKinds`, `fileDetails`). Liczniki zgadzają się z patchem
 * `demoDiff`, więc lista w panelu i „Pokaż diff" nie przeczą sobie.
 *
 * Kolejność ma znaczenie: `#dirty` rośnie 1 → 3, więc trójka nagłówka pokazuje kolejno
 * „1 zmieniony", „+1 ~1", „+1 ~1 −1" — demo ćwiczy wszystkie trzy segmenty i wszystkie trzy
 * litery listy plików, a nie jeden stały układ.
 */
export const DEMO_DIFF_FILES: readonly DiffFile[] = [
  { path: 'src/notes.ts', status: 'M', linesAdded: 2, linesDeleted: 2 },
  { path: 'src/notes.test.ts', status: 'A', linesAdded: 9, linesDeleted: 0 },
  { path: 'src/notes-legacy.ts', status: 'D', linesAdded: 0, linesDeleted: 4 },
];

const DEMO_KIND: Record<DiffFileStatus, GitFileDetail['kind']> = {
  A: 'added', M: 'modified', D: 'deleted',
};

/** Pierwsze `dirty` plików demo jako szczegóły ramki `git-status` (rodzaj + liczniki). */
export function demoFileDetails(dirty: number): GitFileDetail[] {
  return DEMO_DIFF_FILES.slice(0, dirty).map((file) => ({
    path: file.path,
    kind: DEMO_KIND[file.status],
    linesAdded: file.linesAdded,
    linesDeleted: file.linesDeleted,
  }));
}

/** Rozkład brudnych plików na rodzaje w demo — z tej samej tabeli, suma ZAWSZE = `dirtyCount`. */
export function demoFileKinds(dirty: number): GitFileKinds {
  const kinds: GitFileKinds = { added: 0, modified: 0, deleted: 0 };
  for (const detail of demoFileDetails(dirty)) kinds[detail.kind] += 1;
  return kinds;
}

/**
 * Pełny `git-status` demo dla `dirty` brudnych plików (mock po tool-callu, scenariusz testów UI).
 * Ahead/behind tylko dla projektów z {@link DEMO_AHEAD_BEHIND} — inne udają gałąź bez upstreamu.
 *
 * Temat ostatniego commitu z zestawu treści. Bez niego (wywołanie scenariuszy testów UI, `scenarios.ts`) zestaw
 * polski: treść scenariuszy zostaje poza zestawami, bo scenariusze działają tylko w testach UI.
 */
export function demoGitStatus(
  cwd: string, dirty: number, content: DemoContent = demoContentPl,
): Extract<DriverEvent, { type: 'git-status' }> {
  const event: Extract<DriverEvent, { type: 'git-status' }> = {
    type: 'git-status',
    branch: 'main',
    dirtyCount: dirty,
    files: DEMO_DIFF_FILES.slice(0, dirty).map((file) => file.path),
    fileKinds: demoFileKinds(dirty),
    lastCommit: { hash: DEMO_LAST_COMMIT.hash, subject: content.lastCommitSubject, at: DEMO_LAST_COMMIT.at },
    fileDetails: demoFileDetails(dirty),
  };
  const sync = demoAheadBehind(cwd, content);
  if (sync !== undefined) {
    event.ahead = sync.ahead;
    event.behind = sync.behind;
  }
  return event;
}

/**
 * Ahead/behind emitowane w demo, per rola projektu (spec: projekt `main` 2/0, `stream` 0/1).
 *
 * Trzymamy to TUTAJ, a nie w seedach, bo ta sama tabela zasila i stan startowy sesji
 * (`demo/seeds.ts` ją importuje), i każdy kolejny `git-status` z mocka — jedno źródło prawdy.
 * Projekt spoza tabeli udaje gałąź bez upstreamu: `git-status` leci bez ahead/behind.
 */
export const DEMO_AHEAD_BEHIND: Readonly<Partial<Record<DemoProjectKey, { ahead: number; behind: number }>>> = {
  main: { ahead: 2, behind: 0 },
  stream: { ahead: 0, behind: 1 },
};

/**
 * Ahead/behind dla katalogu sesji: ostatni segment ścieżki to nazwa projektu zestawu, a z niej rola. Katalog spoza
 * projektów zestawu nie ma ahead/behind.
 */
export function demoAheadBehind(cwd: string, content: DemoContent): { ahead: number; behind: number } | undefined {
  const name = cwd.replace(/\/+$/, '').split('/').at(-1) ?? '';
  const key = (Object.keys(content.projects) as DemoProjectKey[]).find((role) => content.projects[role] === name);
  return key === undefined ? undefined : DEMO_AHEAD_BEHIND[key];
}

// ---------------------------------------------------------------------------
// Scenariusze
// ---------------------------------------------------------------------------

/**
 * A driver event of a scene: the state of a session that a seed cannot carry (permission mode, background tasks,
 * artifacts, pull requests, a git row with its own files, an approval card with the fields of a live dialog such as
 * `alwaysLabel`, a question card of the hook channel). The driver emits the scene right after `init`, so the manager
 * takes it through the same pump as a live session; a `permission-request` or `question-request` of the scene is
 * a pending decision of the driver, so the answer on its card goes on with the turn like any other.
 */
export type MockSceneEvent = Extract<
  DriverEvent,
  { type: 'agent-state' | 'background-tasks' | 'artifacts' | 'pull-requests' | 'git-status' | 'permission-request'
    | 'question-request' }
>;

export type MockScenario = MockScenarioKind & {
  /** Scene events emitted in order right after `init`, as copies (seeds of a named set, `RAROG_DEMO_CONTENT`). */
  scene?: readonly MockSceneEvent[];
};

type MockScenarioKind =
  /** Zwykła sesja: pierwsza tura rusza z `prompt`, potem reaguje na `send()`. */
  | { kind: 'interactive'; prompt: string }
  /** Seed „rarog": delty bez końca, co ~15 s domknięta wiadomość. */
  | { kind: 'streaming' }
  /**
   * Seed z kartą zgody: pending zarejestrował manager (z danych seeda), driver zna tylko
   * `reqId`, żeby decyzja użytkownika poprowadziła turę dalej.
   */
  | {
      kind: 'awaiting-permission';
      reqId: string;
      /**
       * Przełącznik demo: zamiast wysłać decyzję, driver ją ODRZUCA z tym powodem (422).
       *
       * Bez niego ścieżki `refused` nie da się w demo zobaczyć w ogóle — a to ona decyduje
       * o tym, czy karta zostaje na ekranie z powodem, czy znika jak po 409. Nieobecne =
       * `applied`, czyli zachowanie sprzed kontraktu `DecisionOutcome`.
       */
      refuse?: RefuseReason;
    }
  /**
   * Driver żyje, ale nic sam nie robi (czeka na `send()`).
   *
   * Tym scenariuszem startuje też PUSTA sesja (`POST /api/sessions` bez promptu):
   * silnik się podnosi, emituje `init` i oddaje sterowanie użytkownikowi.
   */
  | { kind: 'idle' };

/** Model raportowany przez mock w evencie `init`, gdy wołający żadnego nie podał. */
export const DEFAULT_MOCK_MODEL = 'claude-fable-5-1';

export interface MockDriverOptions {
  cwd: string;
  scenario: MockScenario;
  /** Zestaw treści demo: odpowiedzi, wyzwalacze, pytania i temat ostatniego commitu. */
  content: DemoContent;
  scheduler?: Scheduler;
  /** Identyfikator sesji silnika — w demo czysto kosmetyczny. */
  engineSessionId?: string;
  /**
   * Model w evencie `init`. Mock go NIE interpretuje (odpowiedzi są stałe) — chodzi wyłącznie
   * o to, żeby pigułka modelu w demo pokazywała to, co użytkownik wybrał w formularzu.
   */
  model?: string;
  /** Ziarno generatora opóźnień scenariusza „streaming". */
  seed?: number;
}

// ---------------------------------------------------------------------------
// Treść demo: z zestawu (`demo/content/`), tu tylko struktura tur
// ---------------------------------------------------------------------------

/** Pliki tool-calli kolejnych tur — te same co w `git-status` ({@link DEMO_DIFF_FILES}). */
const DEMO_FILES: readonly string[] = DEMO_DIFF_FILES.map((file) => file.path);

/** Komenda klasyfikowana jako red (trigger „czerwone"). */
export const RED_COMMAND = 'rm -rf ./dist && git push --force origin main';

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

/** Deterministyczny generator (xorshift32) — używany TYLKO do opóźnień w „streaming". */
function makeRng(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0xffffffff;
  };
}

/** Dzieli tekst na fragmenty „po kilka słów" — imituje strumień tokenów. */
export function chunkText(text: string, wordsPerChunk = 5): string[] {
  const words = text.split(' ');
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += wordsPerChunk) {
    const chunk = words.slice(i, i + wordsPerChunk).join(' ');
    chunks.push(i + wordsPerChunk >= words.length ? chunk : `${chunk} `);
  }
  return chunks;
}

export class MockDriver implements SessionDriver {
  /** Demo prowadzi własną, symulowaną sesję — odpięcie drivera wolno domknąć `interrupt()`. */
  readonly ownsProcess = true;

  readonly #queue = new AsyncEventQueue<DriverEvent>();
  readonly #scheduler: Scheduler;
  readonly #cwd: string;
  readonly #engineSessionId: string;
  readonly #model: string;
  readonly #timers = new Set<TimerHandle>();
  readonly #pendingPermissions = new Map<string, (decision: 'allow' | 'deny') => void>();
  /** Przełącznik demo ze scenariusza: każda decyzja o zgodzie kończy się tym powodem odmowy. */
  readonly #refuseDecisions: RefuseReason | undefined;
  readonly #pendingQuestions = new Map<string, (answers: string[][]) => void>();
  readonly #rng: () => number;
  readonly #content: DemoContent;

  #stopped = false;
  #turn = 0;
  #dirty = 0;
  #reqCounter = 0;
  /** Rosnące zużycie kontekstu — demo ma pokazać widget w ruchu, nie stałą liczbę. */
  #contextTokens = 0;
  /** Bufor otwartej wiadomości w scenariuszu „streaming". */
  #streamOpen = '';
  #streamElapsed = 0;
  #streamCursor = 0;

  constructor(opts: MockDriverOptions) {
    this.#scheduler = opts.scheduler ?? systemScheduler;
    this.#cwd = opts.cwd;
    this.#engineSessionId = opts.engineSessionId ?? 'mock-engine-session';
    this.#model = opts.model ?? DEFAULT_MOCK_MODEL;
    this.#rng = makeRng(opts.seed ?? 0x5eed);
    this.#content = opts.content;

    // Scenariusz seeda z kartą zgody musi być gotowy NATYCHMIAST: użytkownik (albo test) może
    // kliknąć „Zezwól", zanim wystrzeli jakikolwiek timer.
    if (opts.scenario.kind === 'awaiting-permission') {
      const { reqId } = opts.scenario;
      this.#refuseDecisions = opts.scenario.refuse;
      this.#pendingPermissions.set(reqId, (decision) => { this.#afterPermission(decision, 0); });
    }

    this.#at(0, () => {
      this.#emit({ type: 'init', engineSessionId: this.#engineSessionId, model: this.#model });
      // Copies: the manager keeps the lists it gets, and one seed scenario may serve more than one driver.
      for (const event of opts.scenario.scene ?? []) {
        // The card of the scene exists from this event on: the decision on it has to find a pending approval here.
        if (event.type === 'permission-request') {
          this.#pendingPermissions.set(event.reqId, (decision) => { this.#afterPermission(decision, 0); });
        }
        if (event.type === 'question-request') {
          this.#pendingQuestions.set(event.reqId, () => { this.#reply(0); });
        }
        this.#emit(structuredClone(event));
      }
      this.#begin(opts.scenario);
    });
  }

  get events(): AsyncIterable<DriverEvent> {
    return this.#queue;
  }

  /** Katalog sesji — mock go nie dotyka, ale nazwy plików w demo z niego wyglądają sensownie. */
  get cwd(): string {
    return this.#cwd;
  }

  // -------------------------------------------------------------------------
  // SessionDriver
  // -------------------------------------------------------------------------

  send(text: string, images?: readonly string[]): void {
    if (this.#stopped) return;
    // Echo załączników: demo ma pokazać, że obrazek doszedł do silnika i wrócił do transkryptu.
    // Leci przed odpowiedzią (STEP_MS < REPLY_DELAY_MS), więc kolejność w transkrypcie jest stała.
    if (images !== undefined && images.length > 0) this.#echoImages(images);
    this.#runTurn(text);
  }

  respondPermission(
    reqId: string, decision: 'allow' | 'allow-always' | 'deny', message?: string,
  ): Promise<DecisionOutcome> {
    void message;
    const resume = this.#pendingPermissions.get(reqId);
    // Nieznany `reqId` = decyzja po wygaśnięciu pending — `stale`, nie odmowa: nie ma czego
    // odrzucać, a manager ma wygasić kartę tak jak dotąd (410).
    if (resume === undefined) return Promise.resolve(STALE);
    /*
     * Odmowa demo (`scenario.refuse`) NIE zużywa pendingu: karta ma zostać na ekranie razem
     * z powodem, dokładnie jak w driverze panelowym. Dlatego wychodzimy PRZED `delete`.
     * `deny` przechodzi ZAWSZE — inaczej karty demo nie dałoby się zdjąć z ekranu, a to samo
     * jest prawdą w produkcji: Esc zamyka każdy dialog i nigdy nie jest niebezpieczne.
     */
    if (this.#refuseDecisions !== undefined && decision !== 'deny') {
      return Promise.resolve(refused(this.#refuseDecisions));
    }
    this.#pendingPermissions.delete(reqId);
    if (this.#stopped) return Promise.resolve(STALE);
    resume(decision === 'deny' ? 'deny' : 'allow');
    return Promise.resolve(APPLIED);
  }

  answerQuestion(reqId: string, answers: string[][]): Promise<DecisionOutcome> {
    const resume = this.#pendingQuestions.get(reqId);
    if (resume === undefined) return Promise.resolve(STALE);
    this.#pendingQuestions.delete(reqId);
    if (this.#stopped) return Promise.resolve(STALE);
    resume(answers);
    return Promise.resolve(APPLIED);
  }

  /**
   * Komendy sterujące — w demo NIE ma panelu, więc nie ma czego wysyłać.
   *
   * Metoda istnieje mimo to, żeby arkusz „Model i effort" dało się w demo przeklikać do
   * końca zamiast dostać 400 „Model ustawiasz przy zakładaniu sesji". Efektem jest jedno
   * zdanie w transkrypcie — dokładnie tam, gdzie prawdziwy driver melduje wynik.
   */
  sendCommands(commands: readonly string[]): void {
    if (this.#stopped) return;
    for (const command of commands) {
      this.#emit({
        type: 'message',
        role: 'system',
        blocks: [{ type: 'text', text: say('demo.would-send', { command }) }],
      });
    }
  }

  /**
   * Przerwanie tury — driver ŻYJE dalej i przyjmuje kolejne `send()`, dokładnie jak silnik
   * po Esc: skasowana jest bieżąca tura (timery, pending), a nie cała sesja. Sesję na dobre
   * zatrzymuje wyłącznie `dispose()`.
   *
   * Wynik jest bezwarunkowo `true`: demo nie ma panelu, więc nie ma czego dostarczać — cała
   * praca dzieje się tu, na miejscu, i albo się wykonała, albo poleciałby wyjątek.
   */
  interrupt(): Promise<boolean> {
    this.#clearTimers();
    this.#pendingPermissions.clear();
    this.#pendingQuestions.clear();
    return Promise.resolve(true);
  }

  dispose(): void {
    this.#stopped = true;
    // `void`: sprzątanie nie ma na co czekać, a wynik przerwania jest tu z góry znany.
    void this.interrupt();
    this.#queue.close();
  }

  // -------------------------------------------------------------------------
  // Scenariusze
  // -------------------------------------------------------------------------

  #begin(scenario: MockScenario): void {
    switch (scenario.kind) {
      case 'interactive':
        this.#runTurn(scenario.prompt);
        return;
      case 'streaming':
        this.#scheduleStreamChunk();
        return;
      case 'awaiting-permission':
        // Pending zarejestrował manager (seed), a kontynuacja tury jest już zapięta
        // w konstruktorze — tutaj nie ma nic do zrobienia.
        return;
      case 'idle':
        return;
    }
  }

  /** Tura interaktywna: triggery ze speca, inaczej zwykła odpowiedź. */
  #runTurn(text: string): void {
    const lowered = text.toLowerCase();
    const { triggers } = this.#content.driver;
    const has = (words: readonly string[]): boolean => words.some((word) => lowered.includes(word));

    if (has(triggers.question)) {
      const reqId = this.#nextReqId('q');
      this.#at(REPLY_DELAY_MS, () => {
        this.#pendingQuestions.set(reqId, () => this.#reply(0));
        const questions = this.#content.driver.questions.map((question) => structuredClone(question));
        this.#emit({ type: 'question-request', reqId, questions });
      });
      return;
    }

    if (has(triggers.red)) {
      const reqId = this.#nextReqId('p');
      this.#at(REPLY_DELAY_MS, () => {
        this.#pendingPermissions.set(reqId, (decision) => this.#afterPermission(decision, 0));
        this.#emit({
          type: 'permission-request',
          reqId,
          toolName: 'Bash',
          input: { command: RED_COMMAND },
          displayText: RED_COMMAND,
        });
      });
      return;
    }

    if (has(triggers.limit)) {
      this.#at(REPLY_DELAY_MS, () => {
        const resetAt = new Date(this.#scheduler.now() + LIMIT_RESET_MS).toISOString();
        this.#emit({ type: 'limit-reached', resetAt });
      });
      return;
    }

    if (has(triggers.error)) {
      this.#at(REPLY_DELAY_MS, () => {
        this.#emit({ type: 'exit', ok: false, reason: say('state.driver-error') });
      });
      return;
    }

    this.#reply(REPLY_DELAY_MS);
  }

  /**
   * Echo obrazków: wiadomość asystenta z blokiem tekstu i blokami `image` (po jednym na załącznik).
   *
   * Mock niczego nie „widzi" — odbija dokładnie te data URL-e, które dostał, żeby demo pokazało
   * pełną ścieżkę: input → transkrypt użytkownika → silnik → transkrypt asystenta.
   */
  #echoImages(images: readonly string[]): void {
    const { driver } = this.#content;
    // Wypowiedź udawanego agenta: treść obca jak u prawdziwego silnika (demo).
    const blocks: InternalBlock[] = [{ type: 'text', text: foreign(driver.imagesEcho(images.length)) }];
    for (const [index, dataUrl] of images.entries()) {
      blocks.push({ type: 'image', dataUrl, alt: driver.imageAlt(index + 1) });
    }
    this.#at(STEP_MS, () => { this.#emit({ type: 'message', role: 'assistant', blocks }); });
  }

  /** Po decyzji o zgodzie: allow → tool-call i odpowiedź, deny → krótka notka i koniec tury. */
  #afterPermission(decision: 'allow' | 'deny', startAt: number): void {
    if (decision === 'deny') {
      this.#at(startAt + STEP_MS, () => {
        this.#emit({
          type: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: foreign(this.#content.driver.deniedReply) }],
        });
      });
      this.#at(startAt + 2 * STEP_MS, () => {
        this.#finishTurn(this.#content.driver.deniedSummary);
      });
      return;
    }
    this.#toolCall(startAt + STEP_MS);
    this.#reply(startAt + 2 * STEP_MS);
  }

  /**
   * Odpowiedź agenta: delty → domknięta wiadomość → tool-call → git-status → result.
   *
   * @param startAt offset (ms) od „teraz", od którego lecą delty
   */
  #reply(startAt: number): void {
    const { replies } = this.#content.driver;
    const text = replies[this.#turn % replies.length] as string;
    this.#turn += 1;

    // Demo MUSI ćwiczyć ten kanał: na realnym silniku myślenie potrafi
    // trwać kilkadziesiąt sekund i to jedyna rzecz, która wtedy dociera do telefonu.
    // Tu trwa ułamek tego, ale przechodzi tę samą drogę: driver → manager → SSE → wiersz.
    this.#at(Math.max(0, startAt - STEP_MS), () => {
      this.#emit({ type: 'activity', kind: 'thinking' });
    });

    const chunks = chunkText(text);
    chunks.forEach((chunk, index) => {
      this.#at(startAt + index * DELTA_INTERVAL_MS, () => {
        this.#emit({ type: 'delta', text: chunk });
      });
    });

    const afterDeltas = startAt + chunks.length * DELTA_INTERVAL_MS;
    this.#at(afterDeltas, () => {
      this.#emit({ type: 'message', role: 'assistant', blocks: [{ type: 'text', text: foreign(text) }] });
    });
    this.#toolCall(afterDeltas + STEP_MS);
    this.#at(afterDeltas + 3 * STEP_MS, () => {
      this.#finishTurn(this.#content.driver.turnSummary);
    });
  }

  /**
   * Domknięcie tury: `result`, a zaraz po nim `usage`.
   *
   * Kolejność jest ta sama co w realnym silniku (usage wyliczane z wiadomości `result`),
   * więc manager widzi dokładnie ten sam ciąg zdarzeń w demo i na produkcji.
   */
  #finishTurn(summary: string): void {
    // Wskaźnik gaśnie PRZED `result` — ta sama kolejność co w `sdk-driver.ts`.
    this.#emit({ type: 'activity', kind: 'idle' });
    this.#emit({ type: 'result', subtype: 'success', summary });
    this.#contextTokens = Math.min(
      this.#contextTokens + DEMO_CONTEXT_STEP,
      DEMO_CONTEXT_LIMIT,
    );
    // Demo jest jedynym miejscem, w którym limit okna jest ZNANY z definicji: mock sam go
    // wymyślił, więc `kind: 'known'` nie jest tu zgadywaniem, tylko faktem scenariusza.
    this.#emit({
      type: 'usage',
      context: {
        kind: 'known',
        tokens: this.#contextTokens,
        limit: DEMO_CONTEXT_LIMIT,
        source: 'model',
      },
    });
  }

  /** Tool-call + wymagany po nim `git-status` (spec: dirtyCount rośnie 1 → 3). */
  #toolCall(startAt: number): void {
    const file = DEMO_FILES[this.#dirty % DEMO_FILES.length] as string;
    // Nazwa narzędzia jest znana ZANIM wiadomość się domknie — dokładnie jak
    // `content_block_start` w realnym SDK (sdk-driver.ts, `case 'stream_event'`).
    this.#at(Math.max(0, startAt - STEP_MS), () => {
      this.#emit({ type: 'activity', kind: 'tool', toolName: 'Edit' });
    });
    this.#at(startAt, () => {
      const blocks: InternalBlock[] = [{
        type: 'tool-call',
        toolName: 'Edit',
        summary: file,
        detail: `--- ${file}\n+++ ${file}\n@@\n-  return input;\n+  return input.trim();`,
        ...toolCallSemantics('Edit', { file_path: file }),
      }];
      this.#emit({ type: 'message', role: 'assistant', blocks });
    });
    this.#at(startAt + STEP_MS, () => {
      this.#dirty = Math.min(this.#dirty + 1, MAX_DIRTY);
      // Trójka rodzajów i szczegóły rosną razem z liczbą brudnych plików — demo ma pokazać
      // `+1 ~1 −1` w ruchu, a nie stały układ segmentów.
      this.#emit(demoGitStatus(this.#cwd, this.#dirty, this.#content));
    });
  }

  /** Scenariusz „streaming": kolejny fragment, potem sam się przeplanowuje. */
  #scheduleStreamChunk(): void {
    const delay = STREAM_MIN_MS + Math.floor(this.#rng() * (STREAM_MAX_MS - STREAM_MIN_MS));
    this.#at(delay, () => {
      const { streamFragments } = this.#content.driver;
      const fragment = streamFragments[this.#streamCursor % streamFragments.length] as string;
      this.#streamCursor += 1;
      this.#streamOpen += fragment;
      this.#streamElapsed += delay;
      this.#emit({ type: 'delta', text: fragment });

      if (this.#streamElapsed >= STREAM_MESSAGE_MS) {
        this.#emit({
          type: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: foreign(this.#streamOpen) }],
        });
        this.#streamOpen = '';
        this.#streamElapsed = 0;
      }
      this.#scheduleStreamChunk();
    });
  }

  // -------------------------------------------------------------------------
  // Wewnętrzne
  // -------------------------------------------------------------------------

  #nextReqId(prefix: string): string {
    this.#reqCounter += 1;
    return `${prefix}-${this.#engineSessionId}-${this.#reqCounter}`;
  }

  #emit(event: DriverEvent): void {
    if (this.#stopped) return;
    this.#queue.push(event);
  }

  /** Planuje krok scenariusza; po `interrupt()`/`dispose()` nic już nie wystrzeli. */
  #at(ms: number, fn: () => void): void {
    if (this.#stopped) return;
    const handle = this.#scheduler.setTimeout(() => {
      this.#timers.delete(handle);
      if (this.#stopped) return;
      fn();
    }, ms);
    this.#timers.add(handle);
  }

  #clearTimers(): void {
    for (const handle of this.#timers) this.#scheduler.clearTimeout(handle);
    this.#timers.clear();
  }
}

// ---------------------------------------------------------------------------
// Fabryka
// ---------------------------------------------------------------------------

/**
 * Fabryka driverów demo.
 *
 * Nie dziedziczy po niczym: `DriverFactory` nie istnieje (sesje zakłada `HerdrLauncher`),
 * a demo potrzebuje dokładnie jednej rzeczy — drivera dla ZIARNA o danym scenariuszu.
 */
export interface MockDriverFactory {
  /** `engineSessionId` — rozmowa ziarna demo, gdy lista „Wznów istniejącą” ma ją pokazać jako otwartą. */
  startScenario(scenario: MockScenario, opts: { cwd: string; model?: string; engineSessionId?: string }): MockDriver;
}

export interface MockDriverFactoryOptions {
  /** Zestaw treści demo dla każdego drivera fabryki (obowiązkowy: bez niego nie ma treści tur). */
  content: DemoContent;
  scheduler?: Scheduler;
}

/**
 * Fabryka mock-driverów; `engineSessionId` rośnie deterministycznie (demo bywa porównywane 1:1).
 */
export function createMockDriverFactory(opts: MockDriverFactoryOptions): MockDriverFactory {
  let counter = 0;
  const nextId = (): string => {
    counter += 1;
    return `mock-engine-${counter}`;
  };
  const build = (cwd: string, scenario: MockScenario, model?: string, fixedId?: string): MockDriver => {
    // Licznik rośnie zawsze, także przy stałym id: ziarno losowości kolejnych driverów się nie przesuwa.
    const counted = nextId();
    const engineSessionId = fixedId ?? counted;
    const driverOpts: MockDriverOptions = {
      cwd, scenario, content: opts.content, engineSessionId, seed: counter * 7919,
    };
    if (opts.scheduler !== undefined) driverOpts.scheduler = opts.scheduler;
    if (model !== undefined) driverOpts.model = model;
    return new MockDriver(driverOpts);
  };

  return {
    startScenario: (scenario, { cwd, model, engineSessionId }) => build(cwd, scenario, model, engineSessionId),
  };
}
