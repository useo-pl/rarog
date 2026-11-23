/**
 * Terminal PTY — rejestr terminali w RAM.
 *
 * Terminal to para `(katalog projektu, slot)` — do `TERM_SLOTS_MAX` tabów na projekt, slot
 * liczony od 1. Tożsamość liczy `termIdFor(realpath(cwd), slot)`, przy czym slot 1 daje TEN
 * SAM hash co przed wprowadzeniem slotów (powód przy `termIdFor`). `realpath` jest NATYWNY
 * (pisownia katalogu z DYSKU): na macOS system plików nie rozróżnia
 * wielkości liter, a `realpathSync` w JS zachowuje pisownię WEJŚCIA, więc `…/RAROG` i `…/rarog`
 * dawałyby dwie tożsamości jednego katalogu, a etykieta panelu nie pasowałaby do klucza projektu. Rejestr
 * trzyma stan, `lifecycle.ts` podejmuje decyzje, a BACKEND (`backend.ts`, dziś jedyny:
 * `herdr-backend.ts`) wykonuje wywołania. Ten podział jest wiążący: żadnej reguły cyklu
 * życia nie wolno tu zapisać drugi raz, a o tym, czym jest trwałość powłoki, rejestr nie
 * wie nic ponad kontrakt `TermBackend`.
 *
 * Rejestr żyje wyłącznie w pamięci procesu — po restarcie Raroga klient najpierw woła
 * `POST /api/term` (idempotentny), potem otwiera WS. Trwałe powłoki przeżywają restart same.
 *
 * **Zero logowania treści.** Do `server.log` idzie WYŁĄCZNIE cykl życia (id, cwd, spawn,
 * kill, exit, liczba gniazd). Ani jeden bajt wejścia ani wyjścia powłoki.
 */
import { realpathSync } from 'node:fs';
import { isPopupRole, TERM_SLOTS_MAX } from '@rarog/shared';
import type { TermRole } from '@rarog/shared';
import type { RarogConfig } from '../config.ts';
import { redact } from '../auth/index.ts';
import type { Logger } from '../router.ts';
import { serverSystem } from '../version.ts';
import { type OwnText, say } from '@rarog/shared/sentences';
import type { ServerSystem } from '@rarog/shared/rest';
import { TermBackendRetryError, TermHandleStaleError, errFrame } from './backend.ts';
import type {
  TermBackend, TermBackendRefusalCode, TermEventFrame, TermReleaseOptions, TermSessionHandle, TermStream,
  TermStreamExit,
} from './backend.ts';
import {
  TERM_GRACE_MS, isBreakerTripped, recordCrash, shouldPausePty, shouldTerminateSocket, termIdFor,
} from './lifecycle.ts';

/** Rozmiar okna, z którym startuje PTY, zanim klient przyśle pierwszą ramkę `rs`. */
export const TERM_DEFAULT_COLS = 80;
export const TERM_DEFAULT_ROWS = 24;

/**
 * Co Rarog wpisuje do ŚWIEŻEGO panelu roli `lazygit`.
 *
 * Trzy szczegóły, każdy z powodem:
 * - **spacja na początku** — zsh z `HIST_IGNORE_SPACE` (i bash z `HISTCONTROL=ignorespace`)
 *   nie zapisze tej linii w historii powłoki człowieka; to nie jest jego komenda;
 * - **`exec`** — lazygit ZASTĘPUJE powłokę, więc po `q` nie zostaje pusty prompt, tylko ginie
 *   cały panel; to na tym stoi „zamknij lazygit = zamknij popup" (punkt 8 kontraktu);
 * - **`\r`** — to jest wejście PTY, a nie zapis do pliku: powłoka czyta Enter jako CR.
 *
 * Komenda leci przez zwykłe wejście strumienia, bo `tab.create` w herdr 0.8.2 nie przyjmuje
 * komendy (schemat API zna tylko `cwd`, `env`, `label`, `focus`, `workspace_id`).
 */
export const TERM_LAZYGIT_START_INPUT = ' exec lazygit\r';

/**
 * Zapasowy termin wpisania startu lazygita, liczony od podpięcia strumienia.
 *
 * Normalnie wpis idzie po PIERWSZEJ porcji wyjścia (prompt już stoi, powłoka czyta). Timer jest
 * dla panelu, który milczy — np. powłoka z promptem rysowanym dopiero po `precmd` albo
 * kontroler, którego pełna ramka nic nie zawiera. 1,5 s to kompromis: dłużej wygląda jak
 * zawieszony popup, krócej trafiałoby w zsh jeszcze przed jego pierwszym `read`.
 */
export const TERM_LAZYGIT_START_FALLBACK_MS = 1_500;

/**
 * Frazy linii cyklu życia terminala w `server.log` (`docs/security-model.md`: log niesie wyłącznie cykl życia,
 * nigdy treści). Otwarcie: `term: open <id> …`, zamknięcie: `term: close <id> …`, start strumienia:
 * `term: spawn PTY <id>` (i `… failed (<błąd>)`).
 */
export const TERM_OPEN_LOG = 'term: open';
/** Fraza linii zamknięcia wpisu terminala (wzór przy {@link TERM_OPEN_LOG}). */
export const TERM_CLOSE_LOG = 'term: close';
/** Fraza linii startu strumienia PTY (wzór przy {@link TERM_OPEN_LOG}). */
export const TERM_SPAWN_LOG = 'term: spawn PTY';

/**
 * Gniazdo klienta widziane przez rejestr — minimalny kontrakt, żeby rejestr nie wiedział
 * nic o WebSocketach (testy podstawiają atrapę bez otwierania portu).
 */
export interface TermClient {
  /** Surowe bajty PTY (ramka BINARNA). */
  sendData(chunk: Buffer): void;
  /** Zdarzenie protokołu (ramka TEKSTOWA): `exit` albo `err`. */
  sendEvent(frame: TermEventFrame): void;
  /** Ile bajtów czeka w buforze gniazda — wejście polityki backpressure. */
  bufferedAmount(): number;
  /** Twarde zerwanie gniazda (backpressure, błąd protokołu, zamknięcie terminala). */
  terminate(): void;
}

/**
 * Powód odmowy `POST /api/term`; router mapuje go na status HTTP.
 *
 * Dwa pierwsze są rejestru („za dużo PTY", „nie umiem odczytać katalogu"), reszta przychodzi
 * z backendu ({@link TermBackendRefusalCode}) i mówi o WYŁĄCZONYM killswitchu herdr — dlatego
 * jedzie do klienta pod własną nazwą, a nie jako `internal`.
 */
export type TermOpenError = 'limit' | 'spawn' | TermBackendRefusalCode;

/**
 * Wynik `attach` — TRZY stany, nie boolean.
 *
 * Odmowa ma dwa różne powody i dwie różne instrukcje dla człowieka: `failed` znaczy „ten
 * terminal nie wstaje" (otwórz go od nowa), `limit` znaczy „za dużo żywych PTY" (zamknij
 * inny). Jedno zdanie na oba było mylące — patrz copy w `ws.ts`.
 */
export type TermAttachResult = 'ok' | 'failed' | 'limit';

/**
 * Werdykt dla gniazda BEZ poprzedzającego `POST /api/term` (`?direct=1`) — `'ok'` albo powód
 * odmowy: `unknown` (id spoza rejestru), `failed` (wpis w stanie `failed`), `stale` (uchwyt do
 * przeliczenia), `lazygit` (rola, której zastany panel sprawdza wyłącznie `POST`).
 */
export type TermDirectVerdict = 'ok' | 'unknown' | 'failed' | 'stale' | 'lazygit';

/**
 * Czego chce `POST /api/term`: KONKRETNEGO slotu (1…{@link TERM_SLOTS_MAX}) albo „kolejnego".
 *
 * `'next'` istnieje, bo numeru nie ma prawa wybierać klient: jedyne miejsce, które wie, co już
 * stoi w rejestrze tego projektu, to rejestr. Klient wybierający sam wchodziłby w wyścig
 * z własnym pollingiem listy (5 s) i z drugim urządzeniem.
 */
export type TermSlotRequest = number | 'next';

/** Skąd przychodzi `open()` — patrz {@link TermRegistry.open}. */
export interface TermOpenOptions {
  /**
   * Wpis z ADOPCJI po restarcie Raroga (albo z taktu odzyskiwania), a nie z `POST /api/term`.
   *
   * Adopcja nie jest prośbą człowieka, więc nie uruchamia niczego, co prośby wymaga — dziś:
   * sprawdzenia i zastąpienia zastanego panelu lazygita z gołą powłoką. Odzyskiwanie
   * paneli niczego nie zamyka; zamyka wyłącznie jawne `Cmd+G`.
   */
  readonly adopt?: boolean;
}

export type TermOpenResult =
  | { ok: true; id: string; slot: number; role: TermRole }
  | { ok: false; error: TermOpenError; sentence: OwnText };

/**
 * Wynik `GET /api/term/:id/history`.
 *
 * `not-found` znaczy DWIE rzeczy naraz i to jest celowe: „nie ma takiego terminala"
 * i „panel spod uchwytu nie jest już nasz" (bramka własności backendu). Z zewnątrz to jedna
 * i ta sama odpowiedź — Rarog nie ma prawa zdradzać, że pod tym adresem stoi CUDZY panel.
 * `unavailable` to gniazdo herdr, które nie odpowiedziało: stan przejściowy, po którym
 * człowiekowi wolno spróbować jeszcze raz.
 */
export type TermHistoryResult =
  | { ok: true; text: string; truncated: boolean }
  | { ok: false; error: 'not-found' | 'unavailable'; sentence: OwnText };

interface TermEntry {
  readonly id: string;
  /** Katalog w pisowni, z której policzono `id` (dyskowej; u wpisu adoptowanego — z pliku stanu). */
  readonly cwd: string;
  /**
   * Ten sam katalog w pisowni z DYSKU (natywny `realpath`) — po nim rejestr pozna, że dwa
   * otwarcia to ten sam katalog, także gdy wpis zaadoptowano z pisownią sprzed poprawki.
   */
  readonly canonical: string;
  /**
   * Numer taba w PROJEKCIE (1…{@link TERM_SLOTS_MAX}) — pole, a nie rzecz do odtworzenia
   * z `id`.
   *
   * Hash jest jednokierunkowy, więc bez tego pola jedyną drogą do numeru byłoby zgadywanie
   * (`termIdFor(cwd, s)` dla kolejnych `s`) przy KAŻDYM `list()`. Adopcja po restarcie robi
   * dokładnie to zgadywanie, ale raz na panel i na starcie — nie 12 razy na poll.
   *
   * `0` należy WYŁĄCZNIE do ról popupowych ({@link isPopupRole}) i znaczy „poza slotami
   * projektu": taki panel nie zajmuje żadnej z pigułek paska, więc nie ma prawa
   * wejść w numerację.
   */
  readonly slot: number;
  /**
   * Czym jest ten wpis: pełna powłoka projektu (`shell`), panel lazygita (`lazygit`) czy goła
   * powłoka w popupie (`popup`).
   */
  readonly role: TermRole;
  /**
   * Start lazygita CZEKA na moment wpisania — pole żyje od podpięcia strumienia do wpisu.
   *
   * Uzbrajamy je wyłącznie dla ŚWIEŻO założonego panelu roli `lazygit` (uchwyt z `fresh`),
   * a rozbraja pierwsza porcja wyjścia albo zapasowy timer. Osobne od `startupSent`, bo to są
   * dwa różne pytania: „czy czekamy" i „czy kiedykolwiek wpisaliśmy".
   */
  startupArmed: boolean;
  /**
   * Start lazygita był już wpisany w ŻYCIU TEGO WPISU — bezpiecznik przed drugim wpisem.
   *
   * Respawn kontrolera (drugie urządzenie, powrót po karencji) zakłada NOWY strumień do TEGO
   * SAMEGO panelu, w którym lazygit już chodzi; wpisanie komendy poszłoby wtedy prosto w jego
   * klawiaturę (`e`, `x`, `e`, `c`… to w lazygicie żywe skróty). Dlatego wpis jest DOKŁADNIE
   * raz na życie wpisu rejestru, a nie raz na spawn.
   */
  startupSent: boolean;
  /** Zapasowy timer wpisu startu ({@link TERM_LAZYGIT_START_FALLBACK_MS}) albo `null`. */
  startupTimer: NodeJS.Timeout | null;
  /**
   * Uchwyt trwałej powłoki. OBIETNICA, bo `ensureSession` wolno backendowi rozstrzygać
   * asynchronicznie (panel herdr wymaga zapytania gniazda), a `open()` jest synchroniczne —
   * HTTP nie ma na co czekać, skoro powłoka i tak wstaje dopiero przy pierwszym WS. Stoi we
   * wpisie od jego powstania, więc `close()` ma czym zabić także powłokę adoptowaną, do której
   * nikt się nigdy nie podłączył.
   */
  handle: Promise<TermSessionHandle>;
  /**
   * ROZWIĄZANY uchwyt albo `null` — kopia dla drogi SYNCHRONICZNEJ, nie druga prawda.
   *
   * Istnieje wyłącznie dla `list()`: `GET /api/term` jest synchroniczny i musi umieć zapytać
   * backend o nazwę procesu, a `handle` jest obietnicą. Zapisuje je ten sam strażnik, który
   * łapie odmowę (`guardHandle`), więc pole nigdy nie przeżyje uchwytu, do którego należy.
   */
  resolvedHandle: TermSessionHandle | null;
  /**
   * Uchwyt jest DO PRZELICZENIA — nie flaga „coś się zepsuło", tylko jedyna droga wyjścia.
   *
   * Ustawiamy ją w dwóch sytuacjach: odrzucona obietnica `ensureSession` (chwilowo martwe
   * gniazdo herdr) i uchwyt, który przestał wskazywać naszą powłokę ({@link TermHandleStaleError}).
   * Obietnica powstaje RAZ na wpis, więc bez tego pola zatruta zatruwałaby terminal do `DELETE`
   * albo restartu Raroga — mimo że udokumentowaną drogą wyjścia jest „Spróbuj od nowa", czyli
   * `POST`. `POST` liczy uchwyt od nowa dokładnie wtedy, gdy to pole stoi na `true`.
   */
  handleStale: boolean;
  /**
   * Żywy strumień do powłoki albo `null`.
   *
   * **Niezmiennik:** obietnica ląduje w rejestrze SYNCHRONICZNIE, PRZED
   * pierwszym `await` w spawnie. Gdyby pole trzymało `TermStream | null` ustawiane po
   * zakończeniu spawnu, dwa równoczesne upgrade'y zdążyłyby oba zobaczyć `null` i założyć
   * DWA strumienie do jednej powłoki. Każdy, kto tu grzebie, ma ten niezmiennik utrzymać.
   */
  stream: Promise<TermStream> | null;
  readonly sockets: Set<TermClient>;
  graceTimer: NodeJS.Timeout | null;
  /** Znaczniki padów w oknie bezpiecznika respawnu. */
  crashes: number[];
  /** Bezpiecznik zadziałał: kolejne WS odrzucamy do ręcznego `POST` albo restartu Raroga. */
  failed: boolean;
  /**
   * KONKRETNY strumień, który zwolniliśmy planowo (karencja/zamknięcie) — nie flaga.
   *
   * `killStream` zeruje `entry.stream` NATYCHMIAST, ale samo
   * `release()` dzieje się dopiero po rozwiązaniu obietnicy spawnu (dwa `execFile` na
   * `set-option`), więc `onExit` starego strumienia potrafi przyjść, gdy w rejestrze siedzi
   * już NOWA obietnica. Flaga boolean nie umie tego rozróżnić: zerowałaby referencję do
   * żywego strumienia (martwa klawiatura) i konsumowała się, wyciszając potem PRAWDZIWY
   * pad. Referencja umie — `onExit` porównuje swoją obietnicę i z tym polem, i ze `stream`,
   * zanim cokolwiek zmieni.
   */
  plannedKill: Promise<TermStream> | null;
  /** Ostatni znany rozmiar okna; nowy spawn startuje od niego, a nie od 80×24. */
  cols: number;
  rows: number;
  /** Czytanie z powłoki jest wstrzymane przez backpressure (nie wołamy `resume()` w kółko). */
  paused: boolean;
}

/**
 * Najniższy wolny numer slotu albo `null`, gdy projekt ma komplet.
 *
 * NAJNIŻSZY, a nie „następny po największym": po zamknięciu taba 2 z czterech kolejne „+"
 * ma wejść w dziurę, żeby numery nie uciekały w górę przy stałym suficie czterech.
 */
function firstFreeSlot(taken: ReadonlySet<number>): number | null {
  for (let slot = 1; slot <= TERM_SLOTS_MAX; slot += 1) if (!taken.has(slot)) return slot;
  return null;
}

export interface TermRegistryOptions {
  readonly config: RarogConfig;
  readonly logger: Logger;
  /**
   * Backend trwałej powłoki — WYMAGANY.
   *
   * Rejestr nie składa backendu sam z
   * `config`: jedyny backend (panel herdr) potrzebuje
   * klienta gniazda herdr, którego rejestr nie ma i mieć nie powinien. Produkcja dostaje
   * backend z `createTermBackend` (`index.ts`), testy — własną atrapę.
   */
  readonly backend: TermBackend;
  /**
   * Rozwiązywanie dowiązań z pisownią z DYSKU — z niej liczy się tożsamość NOWEGO terminala.
   * Wstrzykiwane w testach; produkcja używa `realpathSync.native`.
   */
  readonly realPath?: (candidate: string) => string;
  /**
   * Rozwiązywanie dowiązań z pisownią WEJŚCIA (`realpathSync` w JS) — tak liczyła się tożsamość
   * przed poprawką i tak liczy ją dalej ADOPCJA, która przynosi pisownię z pliku stanu (tożsamość
   * panelu policzono z niej). Domyślnie `realPath`, gdy test go podał, inaczej `realpathSync`.
   */
  readonly legacyRealPath?: (candidate: string) => string;
  /** Timer karencji — testy podstawiają własny, żeby nie czekać 10 s. */
  readonly setTimer?: (cb: () => void, ms: number) => NodeJS.Timeout;
  readonly clearTimer?: (timer: NodeJS.Timeout) => void;
  /** System maszyny serwera: słowo maszyny w zdaniach („Mac” albo „VPS”). Domyślnie `serverSystem()`. */
  readonly system?: ServerSystem;
}

export class TermRegistry {
  private readonly entries = new Map<string, TermEntry>();
  private readonly config: RarogConfig;
  private readonly log: Logger;
  private readonly backend: TermBackend;
  private readonly realPath: (candidate: string) => string;
  private readonly legacyRealPath: (candidate: string) => string;
  private readonly setTimer: (cb: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearTimer: (timer: NodeJS.Timeout) => void;
  private readonly system: ServerSystem;
  /** Po `dispose()` rejestr jest ZAMKNIĘTY — spóźniona adopcja nie ma prawa dopisać wpisu. */
  private disposed = false;

  constructor(options: TermRegistryOptions) {
    this.config = options.config;
    this.log = options.logger;
    this.realPath = options.realPath ?? realpathSync.native;
    this.legacyRealPath = options.legacyRealPath ?? options.realPath ?? realpathSync;
    this.setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = options.clearTimer ?? ((timer) => { clearTimeout(timer); });
    this.backend = options.backend;
    this.system = options.system ?? serverSystem();
  }

  /**
   * Czy id jest znane rejestrowi. Upgrade WS zna WYŁĄCZNIE id — nieznane = `socket.destroy()`.
   * Gniazdo bez `POST` (`?direct=1`) ma bramkę ostrzejszą: {@link attachableDirect}.
   */
  has(id: string): boolean {
    return this.entries.has(id);
  }

  /**
   * Czy gniazdo BEZ `POST` (`?direct=1`) może wejść do wpisu — bramka wyłącznie dla takiego
   * gniazda; gniazdo bez znacznika zna tylko {@link has}.
   *
   * Apka, która zna id terminala, łączy się od razu i oszczędza jeden obieg sieci. Odmawiamy
   * DOKŁADNIE tam, gdzie naprawić coś umie tylko `open()`: stan `failed` zdejmuje wyłącznie
   * `POST`, uchwyt do przeliczenia liczy od nowa wyłącznie `POST`, zastany panel lazygita
   * sprawdza wyłącznie `POST`, a wpis spoza rejestru (restart Raroga, okno skasowane
   * po `exit`) `POST` odnajdzie albo założy. Klient po odmowie robi `POST` i zwykłe gniazdo,
   * z dzisiejszą obsługą ramek `err`/`exit`.
   *
   * Dlaczego NIE dla każdego gniazda: strażnik uchwytu ustawia `handleStale` asynchronicznie,
   * już po odpowiedzi `POST` (`guardHandle`). Gniazdo idące za takim `POST` trafiałoby na
   * odmowę, robiło kolejny `POST`, ten znowu przeliczał uchwyt, który znowu padał — pętla bez
   * ramki, która zatrzymałaby klienta. Bez znacznika gniazdo wchodzi i dostaje `exit`/`err`.
   *
   * Sam odczyt stanu wpisu: niczego nie zmienia, niczego nie spawnuje.
   */
  attachableDirect(id: string): TermDirectVerdict {
    const entry = this.entries.get(id);
    if (entry === undefined) return 'unknown';
    if (entry.failed) return 'failed';
    if (entry.handleStale) return 'stale';
    if (entry.role === 'lazygit') return 'lazygit';
    return 'ok';
  }

  /**
   * `GET /api/term` — lista terminali dla sidebaru, żeby żywa sesja była widoczna także po
   * wyjściu z widoku. `live` = strumień chodzi w tej chwili;
   * wpis bez strumienia to powłoka czekająca na wejście (np. adoptowana po restarcie).
   */
  list(): { id: string; cwd: string; live: boolean; slot: number; proc: string; role: TermRole }[] {
    /*
     * SYNCHRONICZNIE, także przy `proc` — i to jest decyzja, nie skrót. `processName` oddaje
     * ostatnio znaną nazwę z cache'u backendu i dopiero PO tej odpowiedzi (mikrozadanie)
     * dosyła odczyt do herdr, gdy wpis się przeterminował. Wersja `async` kosztowałaby
     * ~110 ms razy liczba paneli na KAŻDYM pollingu listy (co 5 s), a jedyne, co byśmy za to
     * dostali, to etykieta pigułki świeższa o jeden cykl.
     */
    return [...this.entries.values()].map((entry) => ({
      id: entry.id,
      cwd: entry.cwd,
      live: entry.stream !== null,
      slot: entry.slot,
      proc: this.procFor(entry),
      role: entry.role,
    }));
  }

  /**
   * Nazwa procesu wpisu — z cache'u backendu, bez ani jednego `await`.
   *
   * Wpis, którego uchwyt jeszcze nie powstał (obietnica `ensureSession` w locie) albo się nie
   * udał, nie ma czego pokazać: `''` znaczy „jeszcze nie wiem" i klient rysuje samo `>_`.
   */
  private procFor(entry: TermEntry): string {
    if (entry.resolvedHandle === null) return '';
    return this.backend.processName(entry.resolvedHandle);
  }

  /** Ile terminali ma ŻYWY strumień — wejście sufitu `RAROG_TERM_MAX`. */
  get livePtyCount(): number {
    let live = 0;
    for (const entry of this.entries.values()) if (entry.stream !== null) live += 1;
    return live;
  }

  /**
   * Numery slotów zajętych przez WPISY tego katalogu (nie przez żywe strumienie).
   *
   * Wpisy ról popupowych są tu POMIJANE: mają `slot: 0`, czyli stoją poza
   * numeracją, i nie wolno im zabierać pigułki z paska projektu.
   */
  private slotsTaken(canonical: string): Set<number> {
    const taken = new Set<number>();
    for (const entry of this.entries.values()) {
      if (entry.canonical === canonical && !isPopupRole(entry.role)) taken.add(entry.slot);
    }
    return taken;
  }

  /**
   * Istniejący wpis katalogu (pisownia z dysku) w tym slocie albo roli popupowej, albo `undefined`.
   *
   * Po katalogu, nie po `termIdFor`: wpis zaadoptowany z pisownią sprzed poprawki ma
   * tożsamość z tamtej pisowni, a otwarcie z pisownią z dysku musi trafić w niego, a nie założyć
   * drugi panel tego samego slotu. Dla wpisów z jednej pisowni to ta sama odpowiedź co lookup po id.
   */
  private findEntry(canonical: string, slot: TermSlotRequest, role: TermRole): TermEntry | undefined {
    if (!isPopupRole(role) && slot === 'next') return undefined;
    for (const entry of this.entries.values()) {
      if (entry.canonical !== canonical || entry.role !== role) continue;
      if (isPopupRole(role) || entry.slot === slot) return entry;
    }
    return undefined;
  }

  /**
   * `POST /api/term` — rejestruje (albo odnajduje) terminal `(katalog, slot)`.
   *
   * Idempotentne po `realpath` I po slocie: ta sama para, także osiągnięta inną drogą, daje to
   * samo id. Strumień tu jeszcze NIE powstaje — powstaje przy pierwszym upgrade WS. Sufity
   * sprawdzamy mimo to właśnie tutaj, bo to jedyne miejsce, w którym da się odpowiedzieć
   * człowiekowi 409 z powodem, zamiast zrywać mu gniazdo.
   *
   * **Kolejność pytań jest wiążąca**: odmowa backendu → `realpath` → ISTNIEJĄCY WPIS →
   * dopiero sufity. Powrót do już otwartego terminala nie ma prawa dostać 409 tylko dlatego, że
   * projekt ma komplet tabów albo że gdzieś indziej chodzi za dużo żywych PTY — to jest
   * wejście do czegoś, co już istnieje, a nie prośba o coś nowego.
   *
   * **Role popupowe (`lazygit`, `popup`) IGNORUJĄ `slot` i dostają `slot: 0`.**
   * Taki wpis nie liczy się do sufitu slotów projektu (pigułek w pasku dalej jest najwyżej
   * `TERM_SLOTS_MAX`), ale liczy się do sufitu `RAROG_TERM_MAX` — bo tam mierzy się to samo co
   * dla powłok: ile procesów kontrolera ciągnie serwer naraz. Idempotencja jest ta sama co przy
   * slotach: drugi `open` tego samego katalogu w TEJ SAMEJ roli oddaje ten sam wpis, a dwie
   * różne role popupowe tego samego katalogu to dwa osobne wpisy (różne id).
   */
  open(
    cwd: string, slot: TermSlotRequest = 1, role: TermRole = 'shell', opts: TermOpenOptions = {},
  ): TermOpenResult {
    const explicit = opts.adopt !== true;
    if (this.disposed) {
      // Adopcja startowa jest asynchroniczna i potrafi wrócić po zamknięciu serwera —
      // wpis dopisany do zamkniętego rejestru nikt by już nie posprzątał.
      return { ok: false, error: 'spawn', sentence: say('term.shutting-down') };
    }
    /*
     * Odmowa backendu PRZED czymkolwiek innym — także przed odnalezieniem istniejącego wpisu.
     * Backend panelowy przy wyłączonym `RAROG_HERDR_LAUNCH`/`RAROG_HERDR_SEND` nie umie ani
     * założyć panelu, ani odświeżyć jego tokenu, ani go zamknąć; wpuszczenie takiego wpisu do
     * rejestru dałoby wiersz w kliencie, który przy każdym wejściu zrywa gniazdo bez powodu.
     */
    const refusal = this.backend.refusal();
    if (refusal !== null) return { ok: false, error: refusal.code, sentence: refusal.sentence };
    /*
     * Dwie pisownie jednego katalogu: `canonical` — z dysku, do porównań „ten sam
     * katalog"; `real` — ta, z której liczy się tożsamość NOWEGO wpisu. Dla `POST` to ta sama
     * pisownia z dysku; adopcja przynosi pisownię z pliku stanu, z której policzono tożsamość
     * zastanego panelu, i ta zostaje (inaczej wpis dostałby inne id niż token panelu).
     */
    let real: string;
    let canonical: string;
    try {
      canonical = this.realPath(cwd);
      real = explicit ? canonical : this.legacyRealPath(cwd);
    } catch {
      return { ok: false, error: 'spawn', sentence: say('term.dir-unreadable') };
    }
    /*
     * Zakres slotu sprawdzamy PRZED wyliczeniem tożsamości, bo `termIdFor` traktuje wszystko
     * ≤ 1 jak slot 1 (tak ma być: to warunek zgodności wstecz identyfikatorów). Bez tej bramki
     * `slot: 0` po cichu WCHODZIŁBY w cudzy, istniejący terminal slotu 1 zamiast odpaść.
     * W produkcji broni tego schemat ciała, ale rejestr wołają też adopcja i testy.
     */
    if (
      role === 'shell'
      && slot !== 'next' && (!Number.isInteger(slot) || slot < 1 || slot > TERM_SLOTS_MAX)
    ) {
      return {
        ok: false,
        error: 'limit',
        sentence: say('term.slot-out-of-range', { max: TERM_SLOTS_MAX }),
      };
    }
    /*
     * Konkretny slot rozstrzygamy PRZED sufitami, żeby powrót do istniejącego wpisu przeszedł
     * zawsze. `'next'` nie ma czego odnajdywać — z definicji prosi o NOWY. Rola popupowa ma
     * na katalog dokładnie JEDEN możliwy wpis, więc odnajduje się zawsze i bez pytania o slot.
     */
    const existing = this.findEntry(canonical, slot, role);
    if (existing !== undefined) {
      const id = existing.id;
      /*
       * POST jest jedyną (poza restartem Raroga) drogą wyjścia ze stanu `failed` — patrz
       * `isBreakerTripped`. Nie udajemy, że to „decyzja człowieka": klient (apka, gdy
       * zna katalog) woła ten endpoint przed KAŻDYM reconnectem, więc bezpiecznik kasuje się
       * też automatycznie.
       *
       * Mimo to jest OK, bo pętli spawnów to nie otwiera: po `failed` klient dostaje ramkę
       * `err`, która ZATRZYMUJE jego reconnect (`ws.ts`), a kolejny POST przychodzi dopiero
       * z ręcznego „Spróbuj od nowa". Odwrotność — bezpiecznik zdejmowany wyłącznie
       * restartem serwera — zostawiałaby terminal martwy po JEDNEJ chwilowej awarii herdr.
       */
      existing.failed = false;
      existing.crashes = [];
      if (existing.handleStale) {
        // Zdejmowanie bezpiecznika bez przeliczenia uchwytu było naprawą pozorną: kolejne WS
        // znowu czekałoby na tę samą odrzuconą (albo nieaktualną) obietnicę i znowu doszłoby
        // do `failed`.
        this.renewHandle(existing, explicit);
        this.log.info(`${TERM_OPEN_LOG} ${id} — handle recomputed`);
      } else if (explicit && this.lazygitMayBeGone(existing)) {
        /*
         * `Cmd+G` na wpisie lazygita, którego panel ZASTALIŚMY (adopcja, takt
         * odzyskiwania) albo w którym lazygit chodził i mógł zginąć z restartem herdr — backend
         * sprawdzi, co stoi na pierwszym planie, i gołą powłokę zastąpi świeżym panelem. Żywy
         * lazygit wraca tym samym uchwytem (`fresh: false`), więc start nie idzie drugi raz.
         */
        this.renewHandle(existing, true);
        this.log.info(`${TERM_OPEN_LOG} ${id} — checking the existing lazygit pane`);
      }
      this.log.info(
        `${TERM_OPEN_LOG} ${id} (existing entry, cwd=${real}, role ${existing.role},`
        + ` slot ${String(existing.slot)})`,
      );
      return { ok: true, id, slot: existing.slot, role: existing.role };
    }
    /*
     * SUFIT SLOTÓW jest PER PROJEKT i liczy WPISY, nie żywe strumienie: pigułek w pasku ma być
     * najwyżej `TERM_SLOTS_MAX`, niezależnie od tego, do ilu z nich ktoś jest akurat podpięty.
     * Drugi sufit (`RAROG_TERM_MAX`, niżej) liczy ŻYWE PTY w CAŁYM Rarogu i odpowiada na inne
     * pytanie: ile procesów kontrolera ciągnie serwer naraz.
     */
    // Panel popupowy stoi POZA slotami (`0`), więc sufit slotów go nie dotyczy — a on jego.
    const taken = this.slotsTaken(canonical);
    const chosen = isPopupRole(role) ? 0 : (slot === 'next' ? firstFreeSlot(taken) : slot);
    if (chosen === null) {
      return {
        ok: false,
        error: 'limit',
        sentence: say('term.project-limit', { max: TERM_SLOTS_MAX }),
      };
    }
    if (this.livePtyCount >= this.config.termMax) {
      return {
        ok: false,
        error: 'limit',
        sentence: say('term.open-limit', { max: this.config.termMax }),
      };
    }
    const id = termIdFor(real, chosen, role);
    const handle = this.backend.ensureSession(id, real, role, { explicit });
    const entry: TermEntry = {
      id,
      cwd: real,
      canonical,
      slot: chosen,
      role,
      startupArmed: false,
      startupSent: false,
      startupTimer: null,
      handle,
      resolvedHandle: null,
      handleStale: false,
      stream: null,
      sockets: new Set<TermClient>(),
      graceTimer: null,
      crashes: [],
      failed: false,
      plannedKill: null,
      cols: TERM_DEFAULT_COLS,
      rows: TERM_DEFAULT_ROWS,
      paused: false,
    };
    this.entries.set(id, entry);
    this.guardHandle(entry, handle);
    this.log.info(
      `${TERM_OPEN_LOG} ${id} (new entry, cwd=${real}, role ${role}, slot ${String(chosen)})`,
    );
    return { ok: true, id, slot: chosen, role };
  }

  /**
   * Liczy uchwyt OD NOWA — jedyna droga wyjścia z uchwytu zatrutego (patrz `handleStale`).
   *
   * Wołane wyłącznie z `open()`, czyli z ręcznego „Spróbuj od nowa" albo z `POST`
   * poprzedzającego reconnect. Nigdy z drogi spawnu: samoczynne ponawianie `ensureSession`
   * zakładałoby w herdr kolejne panele w pętli, dokładnie tam, gdzie coś jest zepsute.
   */
  private renewHandle(entry: TermEntry, explicit: boolean): void {
    const pending = this.backend.ensureSession(entry.id, entry.cwd, entry.role, { explicit });
    entry.handle = pending;
    // Stary uchwyt przestał wskazywać naszą powłokę — nazwa procesu spod niego jest od tej
    // chwili nieprawdą, a nie „ostatnią znaną wartością".
    entry.resolvedHandle = null;
    entry.handleStale = false;
    this.guardHandle(entry, pending);
  }

  /**
   * Czy jawne otwarcie wpisu lazygita ma zapytać backend o stan zastanego panelu.
   *
   * Tak, gdy: rola `lazygit`, ŻADEN strumień nie chodzi (przy żywym ktoś właśnie patrzy na ten
   * panel i nie zabieramy mu go spod rąk), uchwyt jest rozwiązany, a panel NIE jest świeżym
   * panelem czekającym na swój start (`fresh` bez `startupSent` — tam lazygita jeszcze nie ma
   * z definicji i backend zamknąłby panel, który właśnie założył).
   */
  private lazygitMayBeGone(entry: TermEntry): boolean {
    if (entry.role !== 'lazygit' || entry.stream !== null) return false;
    const handle = entry.resolvedHandle;
    if (handle === null) return false;
    return !(handle.fresh === true && !entry.startupSent);
  }

  /**
   * Strażnik uchwytu: notuje odmowę backendu i ZAPAMIĘTUJE, że trzeba go przeliczyć.
   *
   * Bez `catch` odrzucona obietnica wisiałaby jako `unhandledRejection` — uchwyt jest
   * konsumowany dopiero przy spawnie albo zamknięciu, a tu nie ma jeszcze komu pokazać powodu.
   */
  private guardHandle(entry: TermEntry, pending: Promise<TermSessionHandle>): void {
    pending.then((handle) => {
      // Kopia dla drogi SYNCHRONICZNEJ (`list()` → `processName`). Ten sam warunek co niżej:
      // wpis mógł już przeliczyć uchwyt, a wtedy spóźniona obietnica nie jest jego prawdą.
      if (entry.handle !== pending) return;
      entry.resolvedHandle = handle;
      /*
       * ŚWIEŻY panel pod istniejącym wpisem (zastana goła powłoka zastąpiona nowym panelem)
       * nie ma w sobie lazygita, więc start jest mu należny, choć wpis wpisał go już kiedyś
       * do POPRZEDNIEGO panelu. Bezpiecznik „raz na życie wpisu" chroni przed wpisem w żywego
       * lazygita — a świeżego panelu nikt jeszcze nie dotknął. Ten `then` rusza przed `await`
       * w spawnie (kolejność rejestracji reakcji), więc uzbrojenie startu widzi już `false`.
       */
      if (handle.fresh === true) entry.startupSent = false;
    }, () => { /* odmowę obsługuje `catch` niżej — tu nie ma czego zapisać */ });
    pending.catch((err: unknown) => {
      // Wpis może już trzymać NOWSZY uchwyt (kolejny POST zdążył go przeliczyć) — wtedy
      // odmowa sprzed chwili nie ma prawa niczego oznaczać.
      if (entry.handle !== pending) return;
      entry.handleStale = true;
      this.log.info(`term: handle ${entry.id} failed (${redact(err)}) — the next POST recomputes it`);
    });
  }

  /**
   * Cykliczne odświeżenie znaku własności KAŻDEGO wpisu z rozwiązanym uchwytem
   * (`TERM_TOKEN_REFRESH_MS`, timer w `index.ts`).
   *
   * Wpisy bez uchwytu (obietnica w locie, uchwyt do przeliczenia) pomijamy: nie ma czego
   * stemplować, a `open()` i tak policzy je od nowa. Odmowa backendu dla jednego wpisu nie
   * przerywa reszty i NICZEGO we wpisie nie zmienia — o tym, że panel przestał być nasz,
   * rozstrzyga `attach` przy najbliższym gnieździe (`TermHandleStaleError`), bo tylko tam jest
   * komu to pokazać. Tu wolno najwyżej zapisać linię w logu.
   */
  async refreshTokens(): Promise<{ refreshed: number; lost: number }> {
    let refreshed = 0;
    let lost = 0;
    for (const entry of this.entries.values()) {
      if (this.disposed) break;
      const handle = entry.resolvedHandle;
      if (handle === null || entry.handleStale) continue;
      try {
        if (await this.backend.refreshSession(handle)) refreshed += 1;
        else {
          lost += 1;
          this.log.info(`term: pane ${handle.ref} no longer carries token ${entry.id} — not refreshed`);
        }
      } catch (err: unknown) {
        this.log.info(`term: token refresh ${entry.id} failed (${redact(err)})`);
      }
    }
    return { refreshed, lost };
  }

  /**
   * `DELETE /api/term/:id` — jawne „zamknij terminal".
   *
   * Normalna droga końca życia powłoki, symetryczna do otwarcia: zwalnia strumień **oraz**
   * zabija trwałą powłokę (w herdr `pane.close` TEGO panelu) i kasuje wpis.
   */
  close(id: string): boolean {
    const entry = this.entries.get(id);
    if (entry === undefined) return false;
    this.entries.delete(id);
    this.clearGrace(entry);
    this.clearStartupTimer(entry);
    this.killStream(entry);
    for (const socket of entry.sockets) socket.terminate();
    entry.sockets.clear();
    void entry.handle
      .then(async (handle) => {
        this.log.info(`${TERM_CLOSE_LOG} ${id} — kill session ${handle.ref}`);
        await this.backend.killSession(handle);
      })
      .catch((err: unknown) => {
        // Sesji mogło już nie być (padła sama, zabił ją `kill-server`) — to nie jest awaria.
        this.log.info(`term: kill session ${id} had no effect (${redact(err)})`);
      });
    return true;
  }

  /**
   * `GET /api/term/:id/history` — historia powłoki jako zwykły tekst.
   *
   * Rejestr NIE trzyma z tego ani znaku: bierze uchwyt, oddaje pytanie backendowi i przekazuje
   * odpowiedź dalej. Powód istnienia trasy (xterm.js nie zaznacza dotykiem, scrollback żyje
   * w panelu herdr) stoi przy `termHistoryResponseSchema` w `shared`.
   *
   * Odczyt NIE ma nic wspólnego z cyklem życia strumienia: historii wolno zażądać także dla
   * terminala BEZ podłączonego gniazda (powłoka adoptowana po restarcie Raroga) — to często
   * dokładnie ten przypadek, w którym człowiek chce wyjąć, co tam wyszło.
   */
  async history(id: string, lines: number): Promise<TermHistoryResult> {
    const entry = this.entries.get(id);
    if (entry === undefined) {
      return { ok: false, error: 'not-found', sentence: say('term.not-found') };
    }
    try {
      const history = await this.backend.readHistory(await entry.handle, lines);
      return { ok: true, text: history.text, truncated: history.truncated };
    } catch (err: unknown) {
      if (err instanceof TermHandleStaleError) {
        /*
         * Uchwyt wskazuje dziś coś, co nie jest naszą powłoką — ta sama reakcja co przy
         * `attach`: zatruwamy go, żeby najbliższy `POST /api/term` policzył adres OD NOWA,
         * i mówimy „nie ma", a nie „awaria".
         */
        entry.handleStale = true;
        return { ok: false, error: 'not-found', sentence: say('term.not-found') };
      }
      // `redact` i tak nie wpuściłby treści, ale do logu idzie wyłącznie POWÓD — historia
      // nigdy (reguła zero logów terminala).
      this.log.info(`term: history ${id} failed (${redact(err)})`);
      return {
        ok: false,
        error: 'unavailable',
        sentence: say('term.history-unreadable'),
      };
    }
  }

  /**
   * Dołącza gniazdo do terminala: spawn strumienia albo dołączenie do żywego.
   *
   * @returns `'failed'`, gdy terminal jest w stanie `failed` (albo nie ma go w rejestrze),
   *   `'limit'`, gdy nowy strumień nie mieści się w suficie. Wołający wysyła wtedy ramkę
   *   `err` z WŁAŚCIWYM zdaniem i zamyka gniazdo, zamiast wchodzić w pętlę spawnów.
   */
  /**
   * Podpina gniazdo. `fresh` = po drugiej stronie stoi ŚWIEŻY xterm (bez żadnego stanu),
   * nie xterm, który przeżył zerwanie gniazda.
   *
   * Różnica rozstrzyga, co robimy z ŻYWYM strumieniem (powrót w oknie karencji albo drugie
   * urządzenie) — dziś jednak wyłącznie w teorii: jedyny backend (panel herdr) ma
   * `respawnOnAttach = true`, więc KAŻDE nowe gniazdo dostaje świeży strumień i pełną ramkę.
   * Rozróżnienie zostaje w kontrakcie, bo to backend, a nie rejestr, wie, czy dołożenie
   * gniazda do żywego strumienia w ogóle coś rysuje.
   *
   * Respawn jest planowy (bez ramki `exit`) i nie liczy się do bezpiecznika.
   */
  attach(
    id: string, client: TermClient, fresh = false,
    size: { cols: number; rows: number } | null = null,
  ): TermAttachResult {
    const entry = this.entries.get(id);
    if (entry === undefined) return 'failed';
    if (entry.failed) return 'failed';
    this.clearGrace(entry);
    /*
     * Rozmiar zmierzony przez klienta PRZED upgrade'em wchodzi do wpisu ZANIM padnie decyzja
     * o spawnie: kontroler ma wstać OD RAZU we właściwych wymiarach. Bez tego spawn brałby
     * ostatnie zapamiętane (świeży wpis: 80×24), a pierwszy `rs` po ficie robiłby drugą
     * szerokość — parę SIGWINCH-ów i „schodek" promptu przy każdym wejściu.
     * Ramka `rs` dalej obowiązuje dla późniejszych zmian.
     */
    if (size !== null) {
      entry.cols = size.cols;
      entry.rows = size.rows;
    }
    entry.sockets.add(client);

    if (entry.stream === null) {
      if (this.livePtyCount >= this.config.termMax) {
        entry.sockets.delete(client);
        return 'limit';
      }
      this.spawn(entry);
    } else if (fresh || this.backend.respawnOnAttach) {
      // Backend panelowy wysyła pełną ramkę WYŁĄCZNIE przy starcie kontrolera, więc bez
      // respawnu drugie urządzenie patrzyłoby w pusty ekran do pierwszego bajtu wyjścia.
      this.log.info(`term: new socket on live stream ${id} — respawning the stream`);
      this.killStream(entry);
      this.spawn(entry);
    } else {
      /*
       * Backend, który nie wymaga respawnu przy dołączeniu (dziś: żaden — to gałąź kontraktu,
       * nie produkcji), musi przynajmniej odmalować ekran; inaczej xterm po drugiej stronie
       * zostałby pusty aż do pierwszego bajtu wyjścia.
       */
      void entry.stream
        .then((stream) => { stream.refresh(); })
        .catch(() => { /* pad obsłuży onExit */ });
    }
    this.log.info(`term: socket opened ${id} (sockets: ${String(entry.sockets.size)})`);
    this.applyBackpressure(entry);
    return 'ok';
  }

  /** Odpina gniazdo; ostatnie uruchamia karencję. */
  detach(id: string, client: TermClient): void {
    const entry = this.entries.get(id);
    if (entry === undefined) return;
    if (!entry.sockets.delete(client)) return;
    this.log.info(`term: socket closed ${id} (sockets: ${String(entry.sockets.size)})`);
    this.applyBackpressure(entry);
    if (entry.sockets.size > 0) return;
    this.clearGrace(entry);
    entry.graceTimer = this.setTimer(() => {
      entry.graceTimer = null;
      if (entry.sockets.size > 0) return;
      this.log.info(`term: grace period over ${id} — releasing the stream (the shell stays alive)`);
      // JEDYNE zwolnienie z przywróceniem rozmiaru: po karencji następca nie wstaje
      // od razu, więc panel ma wrócić do rozmiaru bez klienta Raroga (`TermReleaseOptions`).
      this.killStream(entry, { restoreSize: true });
    }, TERM_GRACE_MS);
    entry.graceTimer.unref();
  }

  /** Wejście z klienta. Treść NIGDY nie trafia do logu. */
  write(id: string, data: string): void {
    const entry = this.entries.get(id);
    if (entry === undefined || entry.stream === null) return;
    void entry.stream
      .then((stream) => { stream.write(data); })
      .catch(() => { /* pad obsłuży onExit */ });
  }

  /** Zmiana rozmiaru okna z klienta (`{"t":"rs"}`). */
  resize(id: string, cols: number, rows: number): void {
    const entry = this.entries.get(id);
    if (entry === undefined) return;
    entry.cols = cols;
    entry.rows = rows;
    if (entry.stream === null) return;
    void entry.stream
      .then((stream) => { stream.resize(cols, rows); })
      .catch(() => { /* jw. */ });
  }

  /**
   * Przewinięcie historii powłoki z klienta (`{"t":"sc"}`), dodatnie = w dół.
   *
   * Rejestr nie wie, czy backend to potrafi, i nie ma prawa wiedzieć: w tmuksie przewijaniem
   * rządzą raporty kółka i `scroll()` jest tam świadomym no-opem, w herdr historia żyje
   * w panelu i tylko ta droga do niej prowadzi.
   */
  scroll(id: string, lines: number, cell: { col: number; row: number } | null = null): void {
    const entry = this.entries.get(id);
    if (entry === undefined || entry.stream === null) return;
    void entry.stream
      .then((stream) => { stream.scroll(lines, cell); })
      .catch(() => { /* pad obsłuży onExit */ });
  }

  /** Ponowna ocena backpressure — woła ją transport po każdym zejściu bufora gniazda. */
  reviewBackpressure(id: string): void {
    const entry = this.entries.get(id);
    if (entry !== undefined) this.applyBackpressure(entry);
  }

  /**
   * Zamknięcie serwera: zwalniamy WSZYSTKIE strumienie. Trwałe powłoki zostają — o to
   * w nich chodzi.
   */
  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) {
      this.clearGrace(entry);
      this.clearStartupTimer(entry);
      this.killStream(entry);
      for (const socket of entry.sockets) socket.terminate();
      entry.sockets.clear();
    }
    this.entries.clear();
  }

  // -------------------------------------------------------------------------
  // Wnętrze
  // -------------------------------------------------------------------------

  private spawn(entry: TermEntry): void {
    const started = Date.now();
    /*
     * Obietnica idzie do rejestru w TEJ SAMEJ turze pętli zdarzeń, w której powstaje —
     * patrz niezmiennik przy polu `stream`. Ciało async zaczyna się wykonywać synchronicznie,
     * ale pierwszy `await` w środku oddaje sterowanie, a przypisanie niżej już się odbyło.
     */
    /*
     * Uzbrojenie startu lazygita w OSOBNEJ funkcji, a nie wprost w ciele niżej: `pending` jest
     * tam jeszcze niezainicjalizowaną stałą (TS liczy to za użycie przed przypisaniem), choć
     * w czasie wykonania to miejsce jest już po pierwszym `await`. Domknięcie rozstrzyga jedno
     * i drugie — ten sam wzorzec, co `onExit` niżej.
     */
    const armStart = (fresh: boolean): void => { this.armLazygitStart(entry, fresh, pending); };
    const pending = (async (): Promise<TermStream> => {
      const handle = await entry.handle;
      /*
       * Start lazygita uzbrajamy TU, a nie w backendzie: backend zna panele, rejestr zna cykl
       * życia strumienia — a to on rozstrzyga, że wpis idzie dokładnie raz i tylko do panelu,
       * który powstał przed chwilą (`handle.fresh`). Warunek jest potrójny z premedytacją:
       * rola, „jeszcze nie wpisaliśmy" i „panel świeży". Wypada przez niego respawn kontrolera
       * (drugie urządzenie), powrót po karencji i KAŻDY wpis adoptowany po restarcie Raroga.
       */
      armStart(handle.fresh === true);
      return await this.backend.attach(handle, {
        cwd: entry.cwd,
        cols: entry.cols,
        rows: entry.rows,
        onData: (chunk: Buffer) => { this.fanout(entry, chunk); },
        // `pending` (nie strumień) jest tożsamością TEGO spawnu w rejestrze — `handleExit`
        // porównuje ją z bieżącym stanem wpisu, żeby spóźniony `onExit` nie zdmuchnął
        // NASTĘPNEGO strumienia. `pending` jest tu w domknięciu, bo `const` niżej już się
        // wykonał, zanim backend zdąży cokolwiek zgłosić.
        onExit: (exit) => { this.handleExit(entry, pending, started, exit); },
      });
    })();
    entry.stream = pending;
    entry.paused = false;
    this.log.info(`${TERM_SPAWN_LOG} ${entry.id}`);
    pending.catch((err: unknown) => {
      this.log.error(`${TERM_SPAWN_LOG} ${entry.id} failed (${redact(err)})`);
      if (err instanceof TermHandleStaleError) {
        /*
         * „Adres z uchwytu nie jest już naszą powłoką" (panel zamknięty w herdr, panele
         * przenumerowane po jego restarcie, wygasły token). Ponawianie pod TYM adresem nie ma
         * sensu i jest niebezpieczne — kolejny `--takeover` wchodziłby w cudzy panel — więc
         * jedyne, co robimy, to zapamiętanie, że uchwyt trzeba policzyć od nowa. Zrobi to
         * najbliższy `POST`, czyli reconnect klienta albo „Spróbuj od nowa".
         */
        entry.handleStale = true;
      }
      const retry = err instanceof TermBackendRetryError;
      // Odmowa „nie teraz": uchwyt też do przeliczenia — zrobi to `POST` z „Spróbuj od nowa".
      if (retry) entry.handleStale = true;
      if (entry.plannedKill === pending) {
        // Zdążyliśmy zaplanować zwolnienie nieudanego spawnu — nie ma czego zwalniać,
        // a rezerwacja musi zniknąć, żeby nie wyciszyła NASTĘPNEGO, prawdziwego padu.
        entry.plannedKill = null;
      } else if (entry.stream !== pending) {
        return; // Wpis trzyma już nowszą obietnicę — ten spawn nikogo nie obchodzi.
      } else {
        entry.stream = null;
      }
      if (retry) {
        this.refuseForNow(entry, err.sentence);
        return;
      }
      // Nieudany spawn liczy się do bezpiecznika ZAWSZE: trwała awaria backendu wygląda
      // dokładnie tak i ma po trzech próbach położyć terminal, a nie kręcić się w kółko.
      this.registerCrash(entry, Date.now());
    });
  }

  /**
   * Uzbraja wpisanie `exec lazygit` do świeżego panelu roli `lazygit`.
   *
   * Wpis idzie po PIERWSZEJ porcji wyjścia strumienia (prompt stoi, powłoka czyta z PTY),
   * a gdyby panel milczał — po {@link TERM_LAZYGIT_START_FALLBACK_MS} od podpięcia. Timer
   * jest zapasowy, nie główny: wpis przed gotowością powłoki wylądowałby w buforze `zsh`
   * sprzed jego pierwszego `read` i mógłby zginąć razem z czyszczeniem ekranu przez p10k.
   *
   * Bramka jest na KONKRETNEJ roli, a nie na {@link isPopupRole}, i to jest cała różnica między
   * `lazygit` a `popup`: do panelu roli `popup` Rarog nie wpisuje ani
   * jednego bajtu — człowiek prosił o gołą powłokę, a nie o powłokę z cudzą komendą w historii.
   */
  private armLazygitStart(
    entry: TermEntry, fresh: boolean, pending: Promise<TermStream>,
  ): void {
    if (entry.role !== 'lazygit' || entry.startupSent || !fresh) return;
    entry.startupArmed = true;
    const timer = this.setTimer(() => {
      entry.startupTimer = null;
      this.sendLazygitStart(entry, pending);
    }, TERM_LAZYGIT_START_FALLBACK_MS);
    entry.startupTimer = timer;
    timer.unref?.();
  }

  /**
   * Wpisuje start lazygita — DOKŁADNIE raz na życie wpisu (bramka `startupArmed`).
   *
   * Do logu idzie sam FAKT wpisu, bez treści: reguła „ani jeden bajt wejścia" obowiązuje także
   * wtedy, gdy to Rarog jest autorem bajtów.
   */
  private sendLazygitStart(entry: TermEntry, pending: Promise<TermStream>): void {
    if (!entry.startupArmed) return;
    entry.startupArmed = false;
    entry.startupSent = true;
    this.clearStartupTimer(entry);
    void pending
      .then((stream) => { stream.write(TERM_LAZYGIT_START_INPUT); })
      .catch(() => { /* pad obsłuży onExit */ });
    this.log.info(`term: ${entry.id} — lazygit start typed into the fresh pane`);
  }

  private clearStartupTimer(entry: TermEntry): void {
    if (entry.startupTimer === null) return;
    this.clearTimer(entry.startupTimer);
    entry.startupTimer = null;
  }

  /**
   * Koniec ŻYCIA WPISU roli popupowej — po `q` w lazygicie (albo po `exit` w powłoce popupu)
   * panel ginie razem z powłoką, więc kontroler kończy się nieplanowo i nie ma czego wskrzeszać.
   *
   * Wpis znika z rejestru zamiast lądować w `failed`, i to jest cała różnica wobec powłoki
   * w slocie: „Spróbuj od nowa" w martwym panelu popupu nie ma sensu (nie ma czego ponawiać —
   * panelu nie ma), a wpis-widmo blokowałby następny `POST`, bo `open()` odnajdywałby go jako
   * istniejący i nigdy nie założyłby świeżego panelu (przy lazygicie — także ze startem
   * `exec lazygit`). Bezpiecznik respawnu jest tu bezprzedmiotowy z tego samego powodu.
   */
  private dropPopupEntry(entry: TermEntry, detail: string, spawnFailed: boolean): void {
    this.entries.delete(entry.id);
    this.clearGrace(entry);
    this.clearStartupTimer(entry);
    this.log.info(`term: ${entry.role} pane ${entry.id} ended (${detail}) — entry deleted`);
    this.dropOrphanPopupPane(entry, spawnFailed);
    // Klient dostaje `exit` (front zamyka popup) — i to jest jedyne, co mu jesteśmy winni.
    this.broadcastEvent(entry, { t: 'exit' });
  }

  /**
   * ŚWIEŻY panel popupowy, którego wpis właśnie skasowaliśmy, ginie razem z nim.
   *
   * Scenariusz: `ensureSession` założył panel (`fresh: true`), ale pierwszy `attach`
   * padł, zanim rejestr wpisał `exec lazygit`. Sam skasowany wpis zostawiłby w herdr panel z GOŁĄ
   * POWŁOKĄ, a następny `open` odnalazłby go z `fresh: false` — czyli już nigdy nie wpisałby
   * startu — i popup pokazywałby powłokę zamiast lazygita. Kryterium jest dokładnie „NASZ świeży
   * panel, do którego nie zdążyliśmy nic wpisać": panel adoptowany (`fresh: false`) nie jest
   * nasz do zabijania, a po `q` w chodzącym lazygicie (`startupSent`) panel ginie sam.
   *
   * Dla roli `popup` kryterium jest INNE i węższe: „strumień nigdy nie wstał" (`spawnFailed`).
   * `startupSent` jest tam z definicji `false`, a w panelu od pierwszej chwili chodzi PRAWDZIWA
   * powłoka z pracą człowieka — pad transportu po udanym `attach` (kontroler herdr padł, panel
   * żyje) nie może jej zabić. Świeży panel, do którego kontroler nigdy się nie podpiął, nie
   * zdążył dostać ani jednego klawisza, więc nie ma w nim czego chronić. Panel adoptowany
   * (`fresh: false`) nie jest nasz do zabijania w żadnej roli. `killSession` ma bramkę
   * własności, więc nieistniejący już panel to no-op.
   */
  private dropOrphanPopupPane(entry: TermEntry, spawnFailed: boolean): void {
    const orphan = entry.role === 'lazygit' ? !entry.startupSent : spawnFailed;
    if (!orphan) return;
    void entry.handle
      .then(async (handle) => {
        if (handle.fresh !== true) return;
        this.log.info(`term: fresh ${entry.role} pane ${entry.id} without input — kill ${handle.ref}`);
        await this.backend.killSession(handle);
      })
      .catch((err: unknown) => {
        this.log.info(`term: kill ${entry.role} pane ${entry.id} had no effect (${redact(err)})`);
      });
  }

  /**
   * Koniec życia JEDNEGO strumienia. `pending` identyfikuje, KTÓREGO — patrz `plannedKill`.
   *
   * Kolejność pytań jest wiążąca: najpierw „czy to nasze planowe zwolnienie" (bo
   * `killStream` zeruje `entry.stream` PRZED zwolnieniem, więc porównanie ze `stream` samo
   * by tego nie rozstrzygnęło), potem „czy wpis nadal trzyma tę obietnicę" (spóźniony
   * `onExit` NIE rusza cudzego strumienia).
   */
  private handleExit(
    entry: TermEntry, pending: Promise<TermStream>, spawnedAtMs: number, exit: TermStreamExit,
  ): void {
    if (entry.plannedKill === pending) {
      /*
       * Rarog posprzątał sam (karencja, zamknięcie, respawn pod nowe gniazdo) — to nie jest
       * śmierć powłoki i klient nie ma prawa zobaczyć z tego powodu ramki `exit`.
       *
       * Ten warunek jest PIERWSZY także dlatego, że w backendzie panelowym własny respawn
       * kończy się dokładnie tym samym powodem co obce przejęcie (`taken over`): to my
       * wyrzucamy własnego kontrolera przez `--takeover`. Gdyby `fatal` sprawdzać wcześniej,
       * każde drugie urządzenie kładłoby terminal w `failed`.
       */
      entry.plannedKill = null;
      this.log.info(`term: PTY ${entry.id} closed intentionally (${exit.detail})`);
      return;
    }
    if (entry.stream !== pending) {
      // Stary strumień dogorywa, a w rejestrze siedzi już nowy — zerowanie referencji
      // zabiłoby klawiaturę żywej sesji.
      this.log.info(`term: late onExit ${entry.id} — the entry holds a newer PTY`);
      return;
    }
    entry.stream = null;
    entry.paused = false;
    if (isPopupRole(entry.role)) {
      // Także przy `fatal`: dla panelu w popupie każdy nieplanowy koniec strumienia znaczy
      // „popup do zamknięcia", a nie „terminal do wskrzeszenia".
      this.dropPopupEntry(entry, exit.detail, false);
      return;
    }
    if (exit.fatal === true) {
      /*
       * Powłoka stracona bez sensu ponawiania (panel przejął inny kontroler herdr). Bezpiecznik
       * respawnu jest tu bez znaczenia: ponawianie nie odzyska panelu, tylko zacznie wojnę
       * dwóch kontrolerów. Wyjście prowadzi przez POST (ręczne „Spróbuj od nowa"), jak z każdego
       * `failed`.
       */
      entry.failed = true;
      this.log.error(`term: ${entry.id} in failed state — ${exit.detail}`);
      this.broadcastEvent(entry, errFrame(exit.sentence ?? say('term.taken-over')));
      return;
    }
    this.log.info(
      `term: PTY ${entry.id} failed after ${String(Date.now() - spawnedAtMs)} ms`
      + ` (unexpected: ${exit.detail})`,
    );
    this.registerCrash(entry, Date.now());
  }

  /**
   * Backend odmówił „nie teraz" (`TermBackendRetryError`) — terminal się odzyskuje albo
   * zastany panel lazygita zmienił się w trakcie sprawdzania.
   *
   * To NIE jest pad: bezpiecznik respawnu go nie liczy, a wpis popupowy nie wypada z rejestru
   * (inaczej popup zniknąłby bez słowa). Wpis idzie w `failed`, bo ramka `err` zatrzymuje
   * reconnect klienta i pokazuje zdanie backendu z „Spróbuj od nowa" — a to jest `POST`, który
   * zdejmuje `failed` i liczy uchwyt od nowa. Drugi spawn tego samego uchwytu (respawn pod
   * nowe gniazdo) nie dosyła drugiej ramki.
   */
  private refuseForNow(entry: TermEntry, sentence: OwnText): void {
    if (entry.failed) return;
    entry.failed = true;
    this.log.info(`term: ${entry.id} backend refused for now — waiting to be reopened`);
    this.broadcastEvent(entry, errFrame(sentence));
  }

  /** Wspólna droga dla padu strumienia i nieudanego spawnu — jeden bezpiecznik, jedna decyzja. */
  private registerCrash(entry: TermEntry, nowMs: number): void {
    if (isPopupRole(entry.role)) {
      // Nieudany spawn kontrolera do panelu popupu kończy wpis tak samo jak `q` — patrz
      // `dropPopupEntry`. Bezpiecznik i stan `failed` są dla powłok, które warto wskrzeszać.
      this.dropPopupEntry(entry, 'stream failed to start', true);
      return;
    }
    entry.crashes = recordCrash(entry.crashes, nowMs);
    if (isBreakerTripped(entry.crashes)) {
      entry.failed = true;
      this.log.error(
        `term: ${entry.id} in failed state (${String(entry.crashes.length)} crashes`
        + ' in the breaker window) — further WS refused until a manual POST',
      );
      // Zdanie wskazuje miejsce, w które człowiek ma zajrzeć: powłoka mieszka w panelu herdr,
      // więc tam widać, co się z nią stało.
      this.broadcastEvent(entry, errFrame(this.system === 'macos'
        ? say('term.not-starting.mac') : say('term.not-starting.vps')));
      return;
    }
    this.broadcastEvent(entry, { t: 'exit' });
  }

  private broadcastEvent(entry: TermEntry, frame: TermEventFrame): void {
    for (const socket of entry.sockets) socket.sendEvent(frame);
  }

  /**
   * Rozsyła bajty powłoki. Gniazdo ponad sufitem bufora jest ZRYWANE (nie kolejkowane) —
   * klient wróci reconnectem i dostanie odmalowanie, a pamięć procesu nie rośnie.
   *
   * Zrywamy TĄ SAMĄ drogą co przy normalnym zamknięciu (`detach`), nie ręcznym `delete` na
   * zbiorze: pominięcie `detach` przy OSTATNIM gnieździe nie uzbroiłoby karencji, więc PTY
   * wisiałoby spauzowane bez końca, a żniwiarz nie tykałby sesji, bo miała klienta.
   * `detach` jest idempotentny, więc późniejsze `close`
   * z transportu nic nie psuje.
   */
  private fanout(entry: TermEntry, chunk: Buffer): void {
    /*
     * PIERWSZA porcja wyjścia jest sygnałem „prompt stoi, powłoka czyta" — jedynym, jaki mamy
     * (herdr nie mówi nic o gotowości powłoki). Rozsyłkę robimy mimo to normalnie: start
     * lazygita jest wpisem do PTY, a nie zamiast bajtów dla klienta.
     */
    if (entry.startupArmed && entry.stream !== null) {
      this.sendLazygitStart(entry, entry.stream);
    }
    for (const socket of entry.sockets) {
      if (shouldTerminateSocket(socket.bufferedAmount())) {
        this.log.info(`term: socket ${entry.id} terminated — buffer backlog`);
        socket.terminate();
        this.detach(entry.id, socket);
        continue;
      }
      socket.sendData(chunk);
    }
    this.applyBackpressure(entry);
  }

  private applyBackpressure(entry: TermEntry): void {
    if (entry.stream === null) return;
    const amounts = [...entry.sockets].map((socket) => socket.bufferedAmount());
    const pause = shouldPausePty(amounts);
    if (pause === entry.paused) return;
    entry.paused = pause;
    const stream = entry.stream;
    void stream.then((live) => {
      if (pause) live.pause();
      else live.resume();
    }).catch(() => { /* pad obsłuży onExit */ });
  }

  private clearGrace(entry: TermEntry): void {
    if (entry.graceTimer === null) return;
    this.clearTimer(entry.graceTimer);
    entry.graceTimer = null;
  }

  /**
   * Zwalnia STRUMIEŃ, nie powłokę. Rezerwacja planowa wycisza ramkę `exit`.
   *
   * `release` idzie do backendu bez opcji wszędzie poza karencją — respawn pod nowe gniazdo,
   * zamknięcie terminala i zamknięcie serwera nie przywracają rozmiaru (powód przy
   * `TermReleaseOptions.restoreSize`).
   */
  private killStream(entry: TermEntry, release: TermReleaseOptions = {}): void {
    const pending = entry.stream;
    if (pending === null) return;
    /*
     * Uzbrojony, a jeszcze niewpisany start lazygita ROZBRAJAMY razem ze strumieniem: wpis do
     * zwalnianego kontrolera przepadłby, a `startupSent` zostałoby na `true` — i panel z gołą
     * powłoką nie dostałby lazygita już nigdy. `startupSent` zostaje bez zmian, więc kolejny
     * spawn do wciąż ŚWIEŻEGO panelu uzbroi wpis od nowa.
     */
    entry.startupArmed = false;
    this.clearStartupTimer(entry);
    entry.plannedKill = pending;
    entry.stream = null;
    entry.paused = false;
    void pending.then((stream) => { stream.release(release); }).catch(() => {
      // Spawn i tak się nie udał — nie ma czego zwalniać, a rezerwację trzeba cofnąć,
      // żeby nie wyciszyła następnego, PRAWDZIWEGO padu.
      if (entry.plannedKill === pending) entry.plannedKill = null;
    });
  }
}
