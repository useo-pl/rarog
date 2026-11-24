/**
 * Jedyne miejsce w kodzie Raroga, które zna unix socket herdr i format NDJSON.
 *
 * Reszta integracji rozmawia z `HerdrClient` (typowana fasada) albo z `HerdrSupervisor` —
 * żaden inny moduł nie ma prawa wiedzieć, że po drugiej stronie jest gniazdo. Dzięki temu
 * cały ruch do herdr przechodzi przez DWIE bramki, które da się sprawdzić w jednym pliku:
 * allow-listę metod i bramkę protokołu (the minimum of the tested set {@link KNOWN_PROTOCOLS},
 * today `{22}`). Dotyczy to OBU ścieżek piszących do gniazda:
 * `request()` i `subscribe()` — ta druga wysyła nazwę metody literałem, więc przepuszcza go
 * przez `assertMethodAllowed`, żeby gwarancja była sprawdzalna testem, a nie opisowa.
 *
 * Kształt protokołu (zweryfikowany na żywym serwerze 0.9.0 / protokół 22 i schemacie
 * `herdr api schema --json`; changelog 0.9.0 wymaga subskrypcji PRZED pierwszym `agent.list`,
 * i supervisor tak robi):
 * - żądanie: jedna linia `{"id":"…","method":"…","params":{…}}` — WSZYSTKIE TRZY pola wymagane
 *   (`{"method":"ping"}` bez `id` dostaje `invalid_request: missing field id`),
 * - odpowiedź: `{"id":"…","result":{…}}` albo `{"id":"…","error":{"code":"…","message":"…"}}`,
 * - jedno żądanie na połączenie: serwer odpowiada i zamyka; pipelining gubi drugie żądanie,
 * - wyjątek: `events.subscribe` trzyma połączenie — pierwsza ramka to zwykła odpowiedź
 *   (`result.type === 'subscription_started'`), a potem lecą ramki `{"event":…,"data":{…}}`.
 */
import { createConnection } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { AsyncEventQueue, systemScheduler } from '../drivers/runtime.ts';
import type { Scheduler, TimerHandle } from '../drivers/runtime.ts';
import { type AnyText, foreign, say, textOf } from '@rarog/shared/sentences';
import { HerdrError, HerdrReadOnlyError, sentenceOfError } from './types.ts';

// ---------------------------------------------------------------------------
// Stałe bezpieczeństwa i wydajności
// ---------------------------------------------------------------------------

/**
 * Metody CZYTAJĄCE stan herdr. Wolno im jechać także przy `readOnly`, bo „widzę stan" jest
 * wartością Raroga także wtedy, gdy nie wolno mu pisać.
 *
 * Odczyt `pane.list` — jedyna odpowiedź herdr, która niesie `cwd` panelu,
 * czyli mapowanie „katalog → workspace".
 */
export const READ_METHODS: ReadonlySet<string> = new Set([
  // odczyty
  'ping', 'agent.list', 'agent.get', 'agent.read', 'events.subscribe',
  // NOWY odczyt: katalog → workspace. Czyta go też driver przy karcie bez decyzji
  // (`degrade`): `scroll.viewport_rows` własnego panelu do dziennika odmów (`HerdrClient.readPaneRows`).
  'pane.list',
  /*
   * `pane.read` — WYŁĄCZNIE historia terminala Raroga do zaznaczenia.
   *
   * Metoda była świadomie nieobecna od de-releasu lustra i powód tamtego wykluczenia
   * dotyczył POMPY: Rarog nie ma podglądać cudzego panelu 5 razy na sekundę. Tu jest inaczej —
   * JEDEN odczyt na TAPNIĘCIE człowieka, na panelu, który w świeżym `pane.list` nosi token
   * `rarog-term` TEGO terminala (bramka po stronie `term/herdr-backend.ts`, ta sama co przy
   * `pane.close`). Wraca do READ, a nie do MUTATING, bo NICZEGO nie zmienia: historia ma być
   * do wyjęcia także przy `RAROG_HERDR_SEND=0` — „widzę, nie ruszam" to dokładnie ten tryb,
   * w którym czytanie własnej powłoki jest wartością.
   */
  'pane.read',
  /*
   * `pane.process_info` — WYŁĄCZNIE nazwa procesu na etykietę taba terminala.
   *
   * Oddaje `foreground_processes` panelu: pid, `name`, `argv0`, `argv`, `cmdline`, `cwd`. Rarog
   * bierze z tego JEDNO SŁOWO (`argv0` gdy niepusty, inaczej `name`; lowercase, ≤12 znaków)
   * i nic poza nim nie
   * opuszcza serwera — `argv`/`cmdline` bywają linią polecenia z sekretem w argumencie, więc
   * ich nie czytamy w ogóle. Bramka jak przy `pane.read`: odczyt idzie wyłącznie na panel,
   * który w ŚWIEŻYM `pane.list` nosi token `rarog-term` TEGO terminala
   * (`term/herdr-backend.ts`), i wyłącznie z cache'em TTL 5 s — nie pompa, jedna prośba na
   * poll listy. ODCZYT, a nie mutacja: przy `RAROG_HERDR_SEND=0` etykieta ma dalej działać.
   */
  'pane.process_info',
  /*
   * `pane.layout` — WYŁĄCZNIE rozmiar panelu terminala Raroga przed zwolnieniem kontrolera.
   *
   * Kontroler terminala ustawia pty panelu na rozmiar telefonu, a herdr po `terminal.release`
   * niczego nie przelicza: pty zostaje małe, dopóki tabu nie obejrzy klient herdr, i dialog CLI
   * wyższy niż panel traci nagłówek (zmierzone na herdr 0.9.5). Backend terminala czyta
   * więc układ taba i przez WŁASNY kontroler oddaje panelowi rozmiar z układu, zanim go zwolni.
   * Odpowiedź to geometria (prostokąty paneli, podziały, fokus) — nic z treści panelu; fasada
   * wpuszcza z niej wyłącznie id panelu i wymiary. ODCZYT: niczego w herdr nie zmienia, a rozmiar
   * idzie strumieniem kontrolera, tą samą drogą co ramka `rs` z apki.
   */
  'pane.layout',
  /*
   * `tab.get` — etykieta i liczba paneli JEDNEGO taba, tuż przed decyzją
   * o `tab.rename`: synchronizacja etykiety taba z kartą (nadzorca) i migracja etykiet tabów
   * terminala (`reconcile`). Oddaje `TabInfo` (etykieta, numer, fokus, liczba paneli, status
   * agenta) — nic z treści panelu. ODCZYT: przy `RAROG_HERDR_SEND=0` przechodzi, ale nic po nim
   * nie idzie, bo `tab.rename` jest zapisem.
   */
  'tab.get',
  /*
   * `workspace.list` — etykiety workspace'ów i ścieżki checkoutu, tuż przed
   * wyborem workspace'u dla nowej sesji albo terminala (`herdr/workspace-resolver.ts`). Nie
   * `pane.cwd`: bieżący katalog powłoki dryfuje z każdym `cd`, więc obcy workspace wygrałby,
   * bo ktoś zrobił w nim `cd` do projektu. Oddaje
   * `WorkspaceInfo` (etykieta, numer, fokus, liczniki, `worktree`) — nic z treści paneli.
   * ODCZYT: przy `RAROG_HERDR_SEND=0` przechodzi, a zakładanie, które po nim idzie, i tak
   * odbija bramka zapisu.
   */
  'workspace.list',
]);

/**
 * Metody MUTUJĄCE stan po stronie herdr. Tylko one podlegają bramce trybu tylko-do-odczytu.
 *
 * Każdy zapis MUSI być tutaj, a nie w {@link READ_METHODS}: `readOnly` (that is,
 * `RAROG_HERDR_SEND=0`) is checked ONLY against this list.
 * Bez tych linii runbook „kradzież telefonu" byłby fikcją — `agent.start` i `tab.close`
 * przechodziłyby przy wyłączonym kanale zapisu.
 */
export const MUTATING_METHODS: ReadonlySet<string> = new Set([
  // zapisy do ISTNIEJĄCEGO panelu
  'agent.prompt', 'agent.send_keys', 'agent.focus',
  // zapisy: tworzenie, oznaczanie, zamykanie WŁASNEGO taba
  'workspace.create', 'tab.create', 'agent.start', 'pane.report_metadata', 'tab.close',
  /*
   * `pane.close` — WYŁĄCZNIE dla terminala, który ZAWSZE stoi na panelu
   * herdr; flagi wyboru backendu nie ma, bo wyboru nie ma. Do tej pory metoda była jawnie
   * wykluczona i powód tamtego
   * wykluczenia nie zniknął: adresuje POJEDYNCZY panel, więc pomyłka zamyka cudzą pracę
   * w cudzym tabie. Dlatego wchodzi z bramką po stronie jedynego wołającego
   * (`term/herdr-backend.ts`): zamknąć wolno panel, który w ŚWIEŻYM `pane.list` nosi token
   * `rarog-term`. Terminal panelowy musi umieć posprzątać po sobie (`DELETE /api/term/:id`
   * i żniwa bezczynności), a `tab.close` nie jest zamiennikiem — Rarog zakłada tab w CUDZYM
   * workspace i nie ma prawa zamykać całego taba, gdy panel jest w nim jednym z wielu.
   */
  'pane.close',
  /*
   * `pane.rename` i `tab.rename` — ETYKIETY nadawane przez Raroga.
   *
   * `pane.rename` stawia na panelu, który Rarog SAM przed chwilą założył, etykietę pochodzenia
   * (`herdr/provenance.ts`): to jedyna rzecz Raroga, którą herdr trzyma w snapshotcie, więc
   * przeżywa restart serwera herdr — tokeny `pane.report_metadata` giną razem z nim. Drugi
   * przypadek to migracja terminala: panel, który już NOSI token `rarog-term`, dostaje etykietę
   * z tą samą tożsamością (`term/herdr-backend.ts`, `reconcile`). Trzeci to nadzorca: nowy ślad
   * etykiety taba po udanym `tab.rename` i migracja starego panelu Claude (agent `rarog-*`).
   * `tab.rename` daje tabowi z `workspace.create` etykietę Raroga zamiast „1", trzyma etykietę
   * taba z Claude równą etykiecie karty (`syncTabLabel`) i migruje stare etykiety tabów terminala
   * — zawsze tylko w tabie jednopanelowym z panelem oznaczonym przez Raroga. Obie są
   * ZAPISAMI: zmieniają to, co człowiek widzi w herdr, i to, co Rarog uzna za swoje, więc
   * `RAROG_HERDR_SEND=0` turns them off together with the other mutations.
   */
  'pane.rename', 'tab.rename',
  /*
   * `pane.send_input` — WYŁĄCZNIE samo wklejenie wiadomości do panelu agenta w trakcie tury.
   * `agent.prompt` wkleja i naciska Enter po stałych 300 ms, więc dialog zgody, który stanie w tym oknie,
   * dostaje Enter. Wysyłka w trakcie tury wkleja więc sam tekst tą metodą, sprawdza, że nic nie stanęło, i dopiero
   * wtedy wysyła osobny Enter (`agent.send_keys`). Jedyny wołający to `HerdrClient.pasteText`: ciało ma wyłącznie
   * `pane_id` i `text`, nigdy `keys`. Adres panelu jest pozycyjny i metoda pisze też do panelu bez agenta, dlatego
   * driver woła ją tylko po świeżym `agent.get`, że pod tym adresem stoi agent tej samej sesji. ZAPIS: gaśnie razem
   * z resztą przy `RAROG_HERDR_SEND=0`.
   */
  'pane.send_input',
]);

/**
 * Metody, które Rarog ma prawo wywołać. Lista jest ZAMKNIĘTA i sprawdzana PRZED zapisem
 * jakiegokolwiek bajtu do gniazda.
 *
 * WYLICZANA z dwóch list powyżej, a nie pisana trzeci raz z ręki — inaczej nowa metoda zapisu
 * mogłaby wejść tu z pominięciem {@link MUTATING_METHODS} i po cichu wypaść spod killswitcha
 * `RAROG_HERDR_SEND=0`. Dopisanie
 * metody wymaga jawnej decyzji „odczyt czy zapis": trzeciego miejsca nie ma.
 *
 * Czego tu świadomie nie ma i co jest częścią kontraktu: `server.stop` (ubiłby terminal
 * użytkownika), `server.live_handoff`, `server.reload_config`, `agent.rename`, `agent.wait`
 * (trzyma gniazdo przez ~5 s, a `agent.get` kosztuje 0,2 ms), `pane.split`,
 * `pane.move`, `pane.input.set`, `pane.send_text`, `pane.send_keys`
 * (pisanie do panelu BEZ agenta z pominięciem bramki promptów; `pane.send_input` jest tu wyłącznie jako
 * wklejenie bez klawiszy, opis przy {@link MUTATING_METHODS}), `workspace.close` (sprzątanie po nieudanym starcie robi
 * `tab.close` na NASZYM tabie — jedna metoda mniej jest warta jednego pustego workspace'a),
 * `session.snapshot`, `integration.*`, `plugin.*`, `worktree.*`, `layout.*`, `popup.*`,
 * `notification.show`.
 */
export const ALLOWED_METHODS: ReadonlySet<string> = new Set([
  ...READ_METHODS, ...MUTATING_METHODS,
]);

/** Metoda strumienia zdarzeń — jedyna, która trzyma połączenie otwarte (patrz nagłówek pliku). */
export const SUBSCRIBE_METHOD = 'events.subscribe';

/**
 * Bramka allow-listy: JEDYNE miejsce, w którym nazwa metody dostaje prawo dotknięcia gniazda.
 *
 * Wołają ją OBIE ścieżki zapisu do gniazda — `request()` i `subscribe()`. Subskrypcja wysyła
 * nazwę literałem, więc nie może dziś nie przejść; chodzi o to, żeby deklaracja z nagłówka
 * pliku („cały ruch przez dwie bramki") była sprawdzalna testem, a nie opisowa — i żeby
 * przyszła ramka dołożona obok `request()` nie wypadła spod niej po cichu.
 */
export function assertMethodAllowed(method: string): void {
  if (!ALLOWED_METHODS.has(method)) {
    throw new HerdrMethodNotAllowedError(say('herdr.method-not-allowed', { method }));
  }
}

/**
 * The SET of herdr protocol numbers the integration was tested on. Today one: 22 (herdr 0.9.0;
 * 0.9.3, 0.9.4 and 0.9.5 carry the same number).
 *
 * On 22 every method in {@link ALLOWED_METHODS} takes the parameters and emits the event names
 * Rarog uses; `agent.prompt` with `wait` waits for an OBSERVED `working`/`blocked` (matching
 * `#promptWithStallGuard`), and subscriptions do not replay history — Rarog subscribes before the
 * first `agent.list`, so it loses nothing. 20 and 21 are NOT in the set: on 20 `agent.prompt` has
 * different semantics (#3506), no herdr release carries 21, and the dialog parser is measured on 22.
 *
 * INVARIANT that is easy to trip over when tidying up: at runtime only the MINIMUM of this set gates.
 * A number below it turns integration off (the shapes the whole parser stands on are unknown); every
 * number at or above it, also one above the tested maximum, gets full integration. Adding a number
 * changes nothing at runtime, it records a measurement (the after-update measurement scripts read the
 * set). Dropping or replacing the oldest number turns that protocol off: a change of behaviour, not
 * tidying.
 */
export const KNOWN_PROTOCOLS: ReadonlySet<number> = new Set([22]);

/**
 * The highest tested number, for messages and tests. The export stays because the gate is one, and
 * not every line that talks about it needs the whole set.
 */
export const TESTED_PROTOCOL = Math.max(...KNOWN_PROTOCOLS);

/** The oldest tested number and the only runtime gate: below it integration is OFF. */
const OLDEST_KNOWN_PROTOCOL = Math.min(...KNOWN_PROTOCOLS);

export const CONNECT_TIMEOUT_MS = 2_000;
export const REQUEST_TIMEOUT_MS = 5_000;

/**
 * Sufit czasu na PIERWSZĄ ramkę strumienia (`result.type === 'subscription_started'`).
 *
 * Bez niego `events.subscribe` był JEDYNĄ ścieżką bez jakiegokolwiek timeoutu po `connect`:
 * herdr w połowie `--handoff` przyjmuje połączenie (gniazdo jest już przejęte przez nowy
 * proces), po czym nie odpowiada nic — half-open. Rarog zostawał wtedy w `available: true`
 * bez ani jednego zdarzenia i bez rozłączenia, czyli w stanie „wszystko gra", który był
 * nieprawdą aż do restartu.
 *
 * Ten strażnik pilnuje WYŁĄCZNIE potwierdzenia subskrypcji. Dalszej ciszy w strumieniu NIE
 * pilnuje nic i to jest decyzja, a nie przeoczenie: protokół herdr 20 nie ma ani ping-a
 * w kanale zdarzeń, ani heartbeatu (`ping` jest metodą RPC na osobnym połączeniu), więc
 * „cisza, bo nic się nie dzieje" jest po naszej stronie NIEODRÓŻNIALNA od „cisza, bo strumień
 * umarł". Wymyślony na tę okazję strażnik ciszy zrywałby zdrowe strumienie w spokojne noce.
 * Domyka to pełny resync supervisora co 30 s — „a missed event costs one interval, never
 * correctness".
 */
export const SUBSCRIBE_START_TIMEOUT_MS = 5_000;

/**
 * Sufit długości JEDNEJ linii NDJSON (4 MB).
 *
 * Bufor sklejający bez sufitu rośnie tak długo, jak długo druga strona wysyła bajty bez `\n` —
 * czyli awaria po stronie herdr (albo cudzy proces na tym gnieździe) zjadałaby pamięć Raroga
 * bez żadnego ograniczenia. 4 MB to zapas rzędu wielkości nad największą realną ramką:
 * `agent.read` długiego panelu ma dziesiątki kB.
 */
export const LINE_MAX_CHARS = 4 * 1024 * 1024;

/**
 * Sufit równoległych połączeń do herdr.
 *
 * Nie wiemy, czy herdr limituje połączenia (patrz „Czego nie wiemy" w researchu), więc limit
 * jest po naszej stronie: 17 paneli × odczyt trybu przy resyncu to inaczej 17 gniazd naraz.
 */
export const MAX_INFLIGHT = 8;

export const BACKOFF_START_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;
/** Rozrzut backoffu ±20 % — bez niego wszystkie klienty herdr wracają w tej samej milisekundzie. */
export const BACKOFF_JITTER = 0.2;

/** Powód trybu tylko do odczytu przy `RAROG_HERDR_SEND=0` (detail statusu gniazda). */
const SEND_DISABLED_DETAIL = say('herdr.send-off');

/** Tekst zdania statusu albo `undefined` — do porównania „czy status się zmienił”. */
const detailText = (value: AnyText | undefined): string | undefined => (value === undefined ? undefined : textOf(value));

// ---------------------------------------------------------------------------
// Błędy transportu
// ---------------------------------------------------------------------------

/** Metoda spoza allow-listy — zawsze błąd programisty, nigdy awaria herdr. */
export class HerdrMethodNotAllowedError extends HerdrError {
  override readonly code = 'herdr-method-not-allowed';
  override readonly name = 'HerdrMethodNotAllowedError';
}

/** Gniazdo nieosiągalne, timeout, uszkodzona ramka, protokół starszy niż testowany. */
export class HerdrUnavailableError extends HerdrError {
  override readonly code = 'herdr-unavailable';
  override readonly name = 'HerdrUnavailableError';
}

/** Serwer herdr odpowiedział `error` — `remoteCode` mapuje `client.ts` na klasy dziedzinowe. */
export class HerdrRemoteError extends HerdrError {
  override readonly code = 'herdr-remote';
  override readonly name = 'HerdrRemoteError';
  readonly remoteCode: string;

  /** `sentence` to treść ramki `error` herdr, czyli tekst obcy (`foreign`). */
  constructor(remoteCode: string, sentence: AnyText) {
    super(sentence);
    this.remoteCode = remoteCode;
  }
}

// ---------------------------------------------------------------------------
// Wstrzykiwalne połączenie
// ---------------------------------------------------------------------------

/**
 * Minimalny kontrakt gniazda, jakiego potrzebuje ten moduł.
 *
 * Istnieje po to, żeby testy framingu, allow-listy i backoffu działały BEZ prawdziwego gniazda:
 * `net.createServer()` na ścieżce w `$TMPDIR` dostaje w tym środowisku `listen EPERM`
 * (sandbox), więc testowanie „przez prawdziwy socket" nie jest opcją, a nie chcemy, żeby
 * najbardziej newralgiczny moduł integracji był jedynym nieprzetestowanym.
 */
export interface HerdrConnection {
  on(event: 'connect' | 'data' | 'error' | 'close', listener: (arg?: unknown) => void): void;
  write(chunk: string): void;
  end(): void;
  destroy(): void;
}

export type HerdrConnectFn = (socketPath: string) => HerdrConnection;

/** Domyślne połączenie: `net.createConnection` opakowane w {@link HerdrConnection}. */
export function nodeConnect(socketPath: string): HerdrConnection {
  const socket = createConnection({ path: socketPath });
  socket.setNoDelay(true);
  return {
    on(event, listener): void {
      socket.on(event, listener as (...args: unknown[]) => void);
    },
    write(chunk): void {
      socket.write(chunk);
    },
    end(): void {
      socket.end();
    },
    destroy(): void {
      socket.destroy();
    },
  };
}

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

/**
 * Sklejanie linii NDJSON z fragmentów TCP.
 *
 * `StringDecoder`, a nie `chunk.toString()`, bo znak wielobajtowy (polskie „ł", emoji w tytule
 * panelu) potrafi wpaść na granicę pakietu — `toString()` zamieniłby go wtedy na `�` i JSON
 * przestałby się parsować.
 */
export class LineSplitter {
  readonly #decoder = new StringDecoder('utf8');
  readonly #maxChars: number;
  #buffer = '';

  constructor(maxChars: number = LINE_MAX_CHARS) {
    this.#maxChars = maxChars;
  }

  /**
   * Dokłada fragment i zwraca KOMPLETNE linie; ogon bez `\n` zostaje w buforze.
   *
   * Rzuca, gdy ogon przekroczy {@link LINE_MAX_CHARS} — to jest błąd protokołu, a nie stan
   * przejściowy: druga strona albo zgubiła separator, albo w ogóle nie mówi NDJSON-em.
   * Wołający zrywa wtedy połączenie (roundtrip odrzuca obietnicę, strumień idzie w reconnect).
   */
  push(chunk: Buffer | string): string[] {
    this.#buffer += typeof chunk === 'string' ? chunk : this.#decoder.write(chunk);
    const lines: string[] = [];
    let index = this.#buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.trim() !== '') lines.push(line);
      index = this.#buffer.indexOf('\n');
    }
    // Sprawdzamy DOPIERO ogon: pakiet z wieloma kompletnymi liniami może być większy niż
    // sufit i jest zupełnie poprawny — sufit dotyczy pojedynczej, niedokończonej ramki.
    if (this.#buffer.length > this.#maxChars) {
      // Bufor idzie do kosza razem z połączeniem: trzymanie megabajtów po błędzie protokołu
      // byłoby dokładnie tym, czemu ten sufit ma zapobiec.
      this.#buffer = '';
      throw new HerdrUnavailableError(say('herdr.frame-too-long', { max: this.#maxChars }));
    }
    return lines;
  }

  /** Niedokończona linia (diagnostyka i testy urwanego strumienia). */
  get pending(): string {
    return this.#buffer;
  }
}

// ---------------------------------------------------------------------------
// Subskrypcja
// ---------------------------------------------------------------------------

/** Wpis listy `events.subscribe` — globalny (`{type}`) albo per panel (`{type, pane_id}`). */
export interface HerdrSubscriptionSpec {
  type: string;
  pane_id?: string;
}

/**
 * Zdarzenie strumienia subskrypcji widziane przez supervisora.
 *
 * `connected`/`disconnected` są tu celowo obok ramek herdr: supervisor MUSI wiedzieć, kiedy
 * strumień wrócił, bo dopiero wtedy robi pełny resync (wzorzec „a missed event costs one
 * interval, never correctness").
 */
export type HerdrStreamEvent =
  | { type: 'connected' }
  | { type: 'disconnected'; reason: AnyText }
  | { type: 'event'; kind: string; data: Record<string, unknown> };

export interface HerdrSubscription {
  readonly events: AsyncIterable<HerdrStreamEvent>;
  close(): void;
}

export interface HerdrSocketStatus {
  available: boolean;
  readOnly: boolean;
  version?: string;
  protocol?: number;
  /**
   * `capabilities.endpoint_protocol_generation` z ponga — pole WEWNĘTRZNE, wyłącznie diagnostyka.
   *
   * Nie jest bramką i nie ma jej w `HerdrStatus` (`shared/protocol.ts`), więc do klienta nie jedzie:
   * `supervisor.status()` przepisuje pola po jednym. Docs 0.9.0 opisują generację jako
   * „client-owned endpoint generation" klienta TUI, czyli rzecz o attach/handoff, a nie
   * o kształtach JSON API — bramka na niezmierzonym polu byłaby ścieżką runbooka, której nikt
   * nie odpalił. Brak pola w pongu (albo `null`) jest normalnym stanem, nie awarią.
   */
  generation?: number;
  /** Zdanie banera (powód niedostępności albo trybu tylko do odczytu); supervisor wysyła jego tekst. */
  detail?: AnyText;
}

export interface HerdrSocketOptions {
  socketPath: string;
  /** `false` = `RAROG_HERDR_SEND=0`: mutacje rzucają, odczyty działają. */
  sendEnabled?: boolean;
  connect?: HerdrConnectFn;
  scheduler?: Scheduler;
  /** Źródło jitteru — test podaje deterministyczne. */
  random?: () => number;
  /** Wołane przy KAŻDEJ zmianie dostępności / trybu tylko-do-odczytu. */
  onStatus?: (status: HerdrSocketStatus) => void;
}

/**
 * Ustawienia POJEDYNCZEGO wywołania.
 *
 * Istnieje wyłącznie dla `agent.start`: globalny {@link REQUEST_TIMEOUT_MS} (5 s) jest dobrany
 * pod metody, które odpowiadają w ułamku milisekundy, a start agenta bywa dłuższy o rząd
 * wielkości. Timeout gniazda krótszy niż odpowiedź herdr znaczył „nie wiem, co się stało"
 * przy PROCESIE, który właśnie ruszył — a launcher zamykał wtedy tab z żywym agentem.
 */
export interface HerdrRequestOptions {
  /** Sufit czasu na odpowiedź PO nawiązaniu połączenia; domyślnie {@link REQUEST_TIMEOUT_MS}. */
  timeoutMs?: number;
}

export interface HerdrSocket {
  request(
    method: string, params: Record<string, unknown>, opts?: HerdrRequestOptions,
  ): Promise<unknown>;
  subscribe(subs: readonly HerdrSubscriptionSpec[]): HerdrSubscription;
  status(): HerdrSocketStatus;
  available(): boolean;
  dispose(): void;
}

/**
 * Normalizuje nazwę zdarzenia z ramki subskrypcji.
 *
 * herdr ma DWIE przestrzenie nazw dla tego samego zdarzenia: subskrybuje się `pane.moved`
 * (z kropkami), a ramki przychodzą jako `pane_moved` (z podkreśleniami; zweryfikowane na żywo:
 * `{"data":{…,"type":"pane_exited"},"event":"pane_exited"}`). Bierzemy `data.type`, gdy jest,
 * i sprowadzamy wszystko do wariantu z podkreśleniami — inaczej `switch` w supervisorze musiałby
 * znać obie pisownie i przy pierwszej zmianie po stronie herdr cicho przestałby łapać zdarzenia.
 */
export function normalizeEventKind(frame: Record<string, unknown>): string {
  const data = frame['data'];
  const fromData = typeof data === 'object' && data !== null
    ? (data as Record<string, unknown>)['type']
    : undefined;
  const raw = typeof fromData === 'string'
    ? fromData
    : typeof frame['event'] === 'string' ? (frame['event'] as string) : '';
  return raw.replace(/\./g, '_');
}

/** Ciało `data` ramki (albo pusty obiekt — brak `data` nie ma prawa wywrócić supervisora). */
function frameData(frame: Record<string, unknown>): Record<string, unknown> {
  const data = frame['data'];
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
}

/**
 * Odpowiedź serwera → wartość albo wyjątek.
 *
 * `expectedId` jest KONTROLĄ KORELACJI, nie ozdobą: `id` w ramce herdr jest jedynym
 * potwierdzeniem, że czytamy odpowiedź na NASZE żądanie. Bez tego porównania spóźniona ramka
 * poprzedniego żądania (albo cudzy ruch na tym samym gnieździe) wracała jako wynik bieżącego
 * wywołania — czyli np. `result` z `agent.get` innego panelu jako odpowiedź na `agent.start`.
 * Niezgodne `id` to błąd protokołu i zerwanie, nigdy cicha akceptacja.
 */
function unwrapResponse(line: string, expectedId: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new HerdrUnavailableError(say('herdr.response-not-json'));
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new HerdrUnavailableError(say('herdr.response-not-object'));
  }
  const frame = parsed as Record<string, unknown>;
  const id = frame['id'];
  if (id !== expectedId) {
    throw new HerdrUnavailableError(say('herdr.response-foreign-id', { expected: expectedId }));
  }
  const error = frame['error'];
  if (typeof error === 'object' && error !== null) {
    const body = error as Record<string, unknown>;
    const code = typeof body['code'] === 'string' ? body['code'] : 'internal_error';
    const message = typeof body['message'] === 'string' ? body['message'] : code;
    throw new HerdrRemoteError(code, foreign(message));
  }
  if (!('result' in frame)) {
    throw new HerdrUnavailableError(say('herdr.response-no-result'));
  }
  return frame['result'];
}

export function createHerdrSocket(opts: HerdrSocketOptions): HerdrSocket {
  const connect = opts.connect ?? nodeConnect;
  const scheduler = opts.scheduler ?? systemScheduler;
  const random = opts.random ?? Math.random;
  const sendEnabled = opts.sendEnabled ?? true;

  let disposed = false;
  let inflight = 0;
  /**
   * Kolejka czekających na slot — z `reject`, a nie samym `resolve`.
   *
   * `dispose()` MUSI mieć czym rozwiązać te obietnice: wcześniej były tu same `resolve`,
   * więc po zamknięciu klienta wołający czekający w kolejce nie dostawał już nigdy niczego
   * (obietnica wisiała do końca procesu razem z całym łańcuchem `await`).
   */
  const waiting: { resolve: () => void; reject: (err: unknown) => void }[] = [];
  /**
   * Żywe cykle życia gniazd (roundtrip + subskrypcja) jako funkcje ZRYWAJĄCE.
   *
   * Nie sam `HerdrConnection`, bo `destroy()` niszczy deskryptor, ale nie rozstrzyga
   * obietnicy, która na tym gnieździe czeka: przy atrapie (i przy gnieździe, które nie zdąży
   * wyemitować `close`) wołający zostawałby zawieszony mimo zamkniętego klienta. Każdy wpis
   * niszczy gniazdo I domyka swój cykl uczciwym powodem.
   */
  const live = new Set<() => void>();
  /** Trwające `sleep()` (backoff reconnectu) — `dispose()` musi mieć co skasować. */
  const sleepers = new Set<{ handle: TimerHandle; wake: () => void }>();
  let requestSeq = 0;

  let version: string | undefined;
  let protocol: number | undefined;
  /** Ostatnia generacja z ponga (diagnostyka). Brak pola w pongu ZERUJE ją, żeby nie kłamała. */
  let generation: number | undefined;
  let available = false;
  let readOnly = !sendEnabled;
  let detail: AnyText | undefined = sendEnabled
    ? undefined
    : SEND_DISABLED_DETAIL;
  /**
   * Memoizowana bramka protokołu; `null` = trzeba ją wykonać (start, utrata gniazda, reconnect).
   *
   * Memo jest ważne dokładnie tak długo, jak długo gniazdo jest dostępne — patrz `setStatus`.
   */
  let probe: Promise<void> | null = null;

  const status = (): HerdrSocketStatus => {
    const out: HerdrSocketStatus = { available, readOnly };
    if (version !== undefined) out.version = version;
    if (protocol !== undefined) out.protocol = protocol;
    if (generation !== undefined) out.generation = generation;
    if (detail !== undefined) out.detail = detail;
    return out;
  };

  const setStatus = (next: {
    available: boolean; readOnly: boolean; detail?: AnyText;
  }): void => {
    // Porównanie po TEKŚCIE: każde zdanie to nowy obiekt, a zmiana stanu to zmiana zdania, nie tożsamości.
    const changed = available !== next.available
      || readOnly !== next.readOnly
      || detailText(detail) !== detailText(next.detail);
    if (!next.available) {
      // Utrata gniazda unieważnia bramkę protokołu: po `herdr update --handoff` po drugiej
      // stronie może już stać INNA wersja, a memo kazałoby nam przez cały backoff (1–30 s)
      // uważać jej protokół za przetestowany i przepuszczać mutacje. Reconnect subskrypcji
      // kasował memo za późno i tylko wtedy, gdy strumień w ogóle istniał — samo `request()`
      // nie kasowało go nigdy. Koszt: jeden ping po odzyskaniu gniazda, nie pętla — ping
      // idzie tylko przy pierwszym żądaniu po awarii.
      probe = null;
    }
    available = next.available;
    readOnly = next.readOnly;
    detail = next.detail;
    if (changed) opts.onStatus?.(status());
  };

  /**
   * Uśpienie z UCHWYTEM — timer jest kasowalny, a obietnica budzona przy `dispose()`.
   *
   * Bez tego `dispose()` w trakcie backoffu (1–30 s) zostawiał wiszący timer procesu i pętlę
   * reconnectu, która budziła się długo po zamknięciu klienta.
   */
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
    const entry = {
      handle: scheduler.setTimeout(() => {
        sleepers.delete(entry);
        resolve();
      }, ms),
      wake: resolve,
    };
    sleepers.add(entry);
  });

  /** Jedno żądanie = jedno połączenie. Zero pipeliningu, zero współdzielenia gniazda. */
  const roundtrip = (
    method: string, params: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<unknown> => {
    requestSeq += 1;
    const requestId = `rarog-${requestSeq}`;
    const payload = `${JSON.stringify({ id: requestId, method, params })}\n`;

    return new Promise<unknown>((resolve, reject) => {
      const splitter = new LineSplitter();
      let settled = false;
      let connectTimer: TimerHandle | null = null;
      let requestTimer: TimerHandle | null = null;
      let connection: HerdrConnection | null = null;
      const kill = (): void => {
        finish(new HerdrUnavailableError(say('herdr.client-closed')));
      };

      const finish = (error: unknown, value?: unknown): void => {
        if (settled) return;
        settled = true;
        if (connectTimer !== null) scheduler.clearTimeout(connectTimer);
        if (requestTimer !== null) scheduler.clearTimeout(requestTimer);
        live.delete(kill);
        try {
          connection?.destroy();
        } catch {
          // Gniazdo mogło już zniknąć — sprzątanie nie ma prawa przesłonić wyniku.
        }
        if (error !== null) reject(error);
        else resolve(value);
      };

      try {
        connection = connect(opts.socketPath);
        live.add(kill);
      } catch (err) {
        const reason = foreign(String((err as Error).message));
        finish(new HerdrUnavailableError(say('herdr.socket-open-failed', { reason })));
        return;
      }

      connectTimer = scheduler.setTimeout(() => {
        finish(new HerdrUnavailableError(say('herdr.connect-timeout')));
      }, CONNECT_TIMEOUT_MS);

      connection.on('connect', () => {
        if (connectTimer !== null) {
          scheduler.clearTimeout(connectTimer);
          connectTimer = null;
        }
        requestTimer = scheduler.setTimeout(() => {
          finish(new HerdrUnavailableError(say('herdr.response-timeout', { method })));
        }, timeoutMs);
        connection?.write(payload);
      });

      connection.on('data', (chunk) => {
        let lines: string[];
        try {
          lines = splitter.push(chunk as Buffer);
        } catch (err) {
          // Sufit długości linii — patrz `LineSplitter.push`. Zrywamy połączenie.
          finish(err);
          return;
        }
        const first = lines[0];
        if (first === undefined) return;
        try {
          finish(null, unwrapResponse(first, requestId));
        } catch (err) {
          finish(err);
        }
      });

      connection.on('error', (err) => {
        const reason = (err as Error | undefined)?.message;
        finish(new HerdrUnavailableError(reason == null
          ? say('herdr.socket-error.unknown')
          : say('herdr.socket-error', { reason: foreign(reason) })));
      });

      connection.on('close', () => {
        /*
         * OGON BUFORA jest odpowiedzią tak samo dobrą jak linia zakończona `\n`.
         *
         * herdr odpowiada i zamyka gniazdo (jedno żądanie na połączenie), a kolejność „ostatni
         * bajt bez `\n`, potem FIN" jest po stronie TCP normalna. Wyrzucanie ogona zamieniało
         * KOMPLETNĄ odpowiedź w fałszywe „herdr zamknął połączenie bez odpowiedzi" — czyli
         * w błąd transportu, który gasił dostępność integracji mimo poprawnej odpowiedzi.
         */
        const tail = splitter.pending.trim();
        if (tail !== '') {
          try {
            JSON.parse(tail);
          } catch {
            // Urwany ogon (nie cała ramka) nie jest odpowiedzią — powodem zostaje zamknięcie.
            finish(new HerdrUnavailableError(say('herdr.closed-without-response')));
            return;
          }
          try {
            finish(null, unwrapResponse(tail, requestId));
          } catch (err) {
            finish(err);
          }
          return;
        }
        finish(new HerdrUnavailableError(say('herdr.closed-without-response')));
      });
    });
  };

  /**
   * Zajęcie slotu. Slot jest PRZEKAZYWANY, a nie zwalniany i zajmowany na nowo.
   *
   * Wcześniej obudzony z kolejki inkrementował `inflight` dopiero w swoim mikrozadaniu, więc
   * między `waiting.shift()()` a tą inkrementacją licznik pokazywał wolne miejsce — nowy,
   * równoległy wołający wchodził w nie natychmiast i sufit {@link MAX_INFLIGHT} był
   * przekraczany (przy resyncu 17 paneli to kilkanaście gniazd naraz zamiast ośmiu).
   * Teraz `release()` albo oddaje slot następnemu W MIEJSCU (licznik nie schodzi ani na
   * chwilę), albo dopiero wtedy zmniejsza `inflight`.
   */
  const acquire = async (): Promise<void> => {
    if (inflight < MAX_INFLIGHT) {
      inflight += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      waiting.push({ resolve, reject });
    });
  };

  const release = (): void => {
    const next = waiting.shift();
    if (next !== undefined) {
      next.resolve();
      return;
    }
    inflight -= 1;
  };

  /** Sufit równoległości z kolejką FIFO — kolejność żądań jest zachowana. */
  const gated = async (
    method: string, params: Record<string, unknown>, timeoutMs?: number,
  ): Promise<unknown> => {
    await acquire();
    // Klient mógł zostać zamknięty, gdy staliśmy w kolejce — wtedy `acquire()` już odrzuciło,
    // ale sprawdzamy jeszcze raz: nie ma prawa powstać ani jeden bajt po `dispose()`.
    if (disposed) {
      release();
      throw new HerdrUnavailableError(say('herdr.client-closed'));
    }
    try {
      const result = await roundtrip(method, params, timeoutMs);
      if (!available) {
        // A successful request clears the REASON for unavailability, not the reason for read-only
        // mode: that one (`RAROG_HERDR_SEND=0`) still holds and has to stay visible.
        setStatus(readOnly && detail !== undefined
          ? { available: true, readOnly, detail }
          : { available: true, readOnly });
      }
      return result;
    } catch (err) {
      if (err instanceof HerdrUnavailableError) {
        setStatus({ available: false, readOnly, detail: err.sentence });
      }
      throw err;
    } finally {
      release();
    }
  };

  /**
   * Bramka protokołu wykonywana przy starcie i przy KAŻDYM (re)connectcie subskrypcji.
   *
   * The gate is a MINIMUM. No number in the pong, or a number below the minimum of
   * {@link KNOWN_PROTOCOLS}, turns integration off (the shapes the whole parser stands on are
   * unknown). Every number at or above the minimum, also one above the tested maximum, gets full
   * integration, and `sendEnabled` decides about writes exactly as on a tested number: a newer herdr
   * must not stop Rarog. The number never guarded the meaning of a method anyway: in herdr 0.8.2 the
   * semantics of `agent prompt` changed without a new protocol number. On an untested number writes
   * stay behind the method allow-list and the response checks; `RAROG_HERDR_SEND=0` is the manual way
   * back to read-only.
   *
   * Z ponga czytamy przy okazji `capabilities.endpoint_protocol_generation` — do
   * {@link HerdrSocketStatus.generation}, czyli WYŁĄCZNIE do diagnostyki, NIGDY do `readOnly`
   * ani do `detail`. `detail` jest tekstem banera w kliencie, a generacja nie jest powodem odmowy;
   * osobnego kanału logowania ten moduł nie ma (i nie dostaje go dla jednej liczby) — kto chce
   * ją zobaczyć, czyta status gniazda.
   */
  const checkProtocol = async (): Promise<void> => {
    const result = await gated('ping', {});
    const body = (typeof result === 'object' && result !== null ? result : {}) as
      Record<string, unknown>;
    version = typeof body['version'] === 'string' ? body['version'] : undefined;
    protocol = typeof body['protocol'] === 'number' ? body['protocol'] : undefined;
    /*
     * `capabilities` to `ServerCapabilities | null` z `default: null` (schemat 0.9.0), a samo
     * `endpoint_protocol_generation` ma typ `["integer", "null"]`. Brak pola, `null` obiektu
     * i `null` liczby to trzy NORMALNE stany — żaden nie jest awarią i żaden nie rusza bramki.
     */
    const capabilities = body['capabilities'];
    const generationRaw = typeof capabilities === 'object' && capabilities !== null
      ? (capabilities as Record<string, unknown>)['endpoint_protocol_generation']
      : undefined;
    generation = typeof generationRaw === 'number' ? generationRaw : undefined;

    if (protocol === undefined) {
      const missing = say('herdr.protocol-missing');
      setStatus({ available: false, readOnly: true, detail: missing });
      throw new HerdrUnavailableError(missing);
    }
    if (protocol < OLDEST_KNOWN_PROTOCOL) {
      const versions = { protocol: String(protocol), oldest: String(OLDEST_KNOWN_PROTOCOL) };
      setStatus({ available: false, readOnly: true, detail: say('herdr.protocol-too-old', versions) });
      throw new HerdrUnavailableError(say('herdr.protocol-too-old.disabled', versions));
    }
    setStatus(sendEnabled
      ? { available: true, readOnly: false }
      : { available: true, readOnly: true, detail: SEND_DISABLED_DETAIL });
  };

  const ensureProtocol = (): Promise<void> => {
    if (probe === null) {
      probe = checkProtocol().catch((err: unknown) => {
        // Nieudanej bramki NIE zapamiętujemy: kolejne żądanie ma prawo spróbować jeszcze raz
        // (herdr wstaje po `herdr update --handoff` w sekundy).
        probe = null;
        throw err;
      });
    }
    return probe;
  };

  const request = async (
    method: string, params: Record<string, unknown>, callOpts?: HerdrRequestOptions,
  ): Promise<unknown> => {
    // Allow-lista PRZED czymkolwiek innym: metoda spoza listy nie ma prawa wygenerować
    // ani jednego bajtu w gnieździe, nawet w formie pingu bramki protokołu.
    assertMethodAllowed(method);
    if (disposed) throw new HerdrUnavailableError(say('herdr.client-closed'));

    if (method !== 'ping') await ensureProtocol();
    if (MUTATING_METHODS.has(method) && readOnly) {
      throw new HerdrReadOnlyError(
        detail ?? say('session.herdr-read-only'),
      );
    }
    return gated(method, params, callOpts?.timeoutMs);
  };

  const backoffFor = (attempt: number): number => {
    const base = Math.min(BACKOFF_START_MS * 2 ** attempt, BACKOFF_MAX_MS);
    const spread = 1 - BACKOFF_JITTER + random() * BACKOFF_JITTER * 2;
    return Math.round(base * spread);
  };

  const subscribe = (subs: readonly HerdrSubscriptionSpec[]): HerdrSubscription => {
    // Ta sama bramka co w `request()`, choć nazwa jest tu literałem: strumień to DRUGA ścieżka
    // pisząca do gniazda i bez tej linii allow-lista nie stała na niej wcale. Rzucamy PRZED
    // utworzeniem kolejki — nieotwarta subskrypcja nie ma prawa oddać zamkniętego strumienia
    // udającego rozłączenie.
    assertMethodAllowed(SUBSCRIBE_METHOD);

    const queue = new AsyncEventQueue<HerdrStreamEvent>();
    let closed = false;
    let current: HerdrConnection | null = null;

    /**
     * Jeden cykl życia połączenia subskrypcyjnego; kończy się przy rozłączeniu.
     *
     * `started` mówi, czy subskrypcja w ogóle ruszyła — tylko wtedy wolno wyzerować backoff.
     * Bez tego rozróżnienia herdr, który przyjmuje połączenie i natychmiast je zrywa, dostawałby
     * od nas pętlę reconnectów co sekundę.
     */
    const runOnce = (): Promise<{ reason: AnyText; started: boolean }> => new Promise((resolve) => {
      const splitter = new LineSplitter();
      let started = false;
      let done = false;
      let connectTimer: TimerHandle | null = null;
      let startTimer: TimerHandle | null = null;
      let subscribeId = '';
      const kill = (): void => {
        end(say('herdr.client-closed'));
      };
      const end = (reason: AnyText): void => {
        if (done) return;
        done = true;
        if (connectTimer !== null) scheduler.clearTimeout(connectTimer);
        if (startTimer !== null) scheduler.clearTimeout(startTimer);
        live.delete(kill);
        try {
          current?.destroy();
        } catch {
          // jw. — sprzątanie nie przesłania powodu rozłączenia
        }
        current = null;
        resolve({ reason, started });
      };

      try {
        current = connect(opts.socketPath);
        live.add(kill);
      } catch (err) {
        end(say('herdr.stream-open-failed', { reason: foreign(String((err as Error).message)) }));
        return;
      }

      connectTimer = scheduler.setTimeout(() => {
        end(say('herdr.stream-connect-timeout'));
      }, CONNECT_TIMEOUT_MS);

      current.on('connect', () => {
        if (connectTimer !== null) {
          scheduler.clearTimeout(connectTimer);
          connectTimer = null;
        }
        requestSeq += 1;
        subscribeId = `rarog-sub-${requestSeq}`;
        // Strażnik PIERWSZEJ ramki — patrz `SUBSCRIBE_START_TIMEOUT_MS`. Bez niego half-open
        // po `--handoff` zostawiał Raroga w `available: true` na zawsze.
        startTimer = scheduler.setTimeout(() => {
          end(say('herdr.subscribe-timeout'));
        }, SUBSCRIBE_START_TIMEOUT_MS);
        current?.write(`${JSON.stringify({
          id: subscribeId,
          method: SUBSCRIBE_METHOD,
          params: { subscriptions: subs.map((s) => ({ ...s })) },
        })}\n`);
      });

      current.on('data', (chunk) => {
        // Po `end()` (timeout startu, `dispose()`) gniazdo bywa jeszcze chwilę żywe —
        // ramki z tego cyklu nie mają już prawa wejść do kolejki.
        if (done) return;
        let lines: string[];
        try {
          lines = splitter.push(chunk as Buffer);
        } catch (err) {
          // Sufit długości linii: strumień bez separatorów to błąd protokołu, a nie ramka
          // do pominięcia — zrywamy i idziemy w backoff.
          end(sentenceOfError(err));
          return;
        }
        for (const line of lines) {
          let frame: Record<string, unknown>;
          try {
            const parsed: unknown = JSON.parse(line);
            if (typeof parsed !== 'object' || parsed === null) continue;
            frame = parsed as Record<string, unknown>;
          } catch {
            // Uszkodzona ramka w środku strumienia: pomijamy JĄ, nie cały strumień —
            // pełny resync i tak przyjdzie za ≤ 30 s.
            continue;
          }
          if (!started) {
            /*
             * KOTWICA `subscription_started` — fail-closed. Wcześniej sprawdzane było
             * WYŁĄCZNIE pole `error`,
             * więc pierwsza dowolna ramka („nie odpowiedź", spóźniona ramka poprzedniej
             * subskrypcji, odpowiedź na inną metodę) uchodziła za potwierdzenie: Rarog
             * ogłaszał `connected`, robił pełny resync i czekał na zdarzenia, których ten
             * strumień nie miał prawa mu przysłać.
             */
            const error = frame['error'];
            if (typeof error === 'object' && error !== null) {
              started = true;
              const body = error as Record<string, unknown>;
              end(say('herdr.subscribe-refused', { code: foreign(String(body['code'] ?? 'unknown')) }));
              return;
            }
            const result = frame['result'];
            const kind = typeof result === 'object' && result !== null
              ? (result as Record<string, unknown>)['type']
              : undefined;
            if (frame['id'] !== subscribeId || kind !== 'subscription_started') {
              end(say('herdr.subscribe-foreign-frame'));
              return;
            }
            started = true;
            queue.push({ type: 'connected' });
            if (startTimer !== null) {
              scheduler.clearTimeout(startTimer);
              startTimer = null;
            }
            continue;
          }
          /*
           * Błąd PO potwierdzeniu = herdr zrywa tę subskrypcję (od 0.9.2 `events_lost`: czytelnik
           * został za daleko w tyle i herdr zamyka połączenie zaraz po tej ramce). Zrywamy
           * sami, żeby powód rozłączenia niósł KOD — bez tego ramka przepadała jako „nie
           * zdarzenie", a do logu trafiało ogólne „herdr zamknął strumień".
           */
          const streamError = frame['error'];
          if (typeof streamError === 'object' && streamError !== null) {
            const body = streamError as Record<string, unknown>;
            end(say('herdr.subscription-broken', { code: foreign(String(body['code'] ?? 'unknown')) }));
            return;
          }
          const kind = normalizeEventKind(frame);
          if (kind === '') continue;
          queue.push({ type: 'event', kind, data: frameData(frame) });
        }
      });

      current.on('error', (err) => {
        const reason = (err as Error | undefined)?.message;
        end(reason == null
          ? say('herdr.stream-socket-error.unknown')
          : say('herdr.stream-socket-error', { reason: foreign(reason) }));
      });
      current.on('close', () => {
        end(say('herdr.stream-closed'));
      });
    });

    const loop = async (): Promise<void> => {
      let attempt = 0;
      while (!closed && !disposed) {
        try {
          // Bramka protokołu przy KAŻDYM (re)connectcie: herdr mógł się w międzyczasie
          // zaktualizować (`herdr update --handoff` zrywa właśnie te strumienie).
          probe = null;
          await ensureProtocol();
        } catch (err) {
          if (closed || disposed) return;
          queue.push({ type: 'disconnected', reason: sentenceOfError(err) });
          await sleep(backoffFor(attempt));
          attempt = Math.min(attempt + 1, 10);
          continue;
        }
        const outcome = await runOnce();
        if (closed || disposed) return;
        queue.push({ type: 'disconnected', reason: outcome.reason });
        setStatus({ available: false, readOnly, detail: outcome.reason });
        if (outcome.started) attempt = 0;
        await sleep(backoffFor(attempt));
        attempt = Math.min(attempt + 1, 10);
      }
    };

    void loop().catch(() => {
      // Pętla nie ma prawa wywalić procesu — rozłączenie jest tu normalnym stanem.
      queue.close();
    });

    return {
      events: queue,
      close(): void {
        if (closed) return;
        closed = true;
        try {
          current?.destroy();
        } catch {
          // jw.
        }
        current = null;
        queue.close();
      },
    };
  };

  return {
    request,
    subscribe,
    status,
    available: () => available,
    /**
     * Zamknięcie klienta MUSI oddać zasoby, a nie tylko postawić flagę.
     *
     * Sama flaga zostawiała po sobie trzy rzeczy, które przeżywały zamknięcie: (1) otwarte
     * gniazda — roundtripu i subskrypcji — trzymające deskryptor i czekające na odpowiedź,
     * (2) wołających stojących w kolejce sufitu równoległości, których obietnice nie
     * rozwiązywały się NIGDY, (3) trwający timer backoffu, budzący pętlę reconnectu długo po
     * zamknięciu. Kolejność jest bez znaczenia, komplet nie jest.
     */
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const kill of [...live]) {
        try {
          kill();
        } catch {
          // Sprzątanie nie ma prawa rzucić — gniazdo mogło już zniknąć.
        }
      }
      live.clear();
      // Kolejka dostaje UCZCIWĄ odmowę: „klient zamknięty" jest odpowiedzią, wieczne
      // czekanie nie jest.
      const queued = waiting.splice(0, waiting.length);
      for (const entry of queued) {
        entry.reject(new HerdrUnavailableError(say('herdr.client-closed')));
      }
      inflight = 0;
      for (const entry of [...sleepers]) {
        scheduler.clearTimeout(entry.handle);
        // Budzimy pętlę reconnectu, żeby zobaczyła `disposed` i wyszła — sam `clearTimeout`
        // zostawiłby ją zawieszoną na `await sleep(...)` do końca procesu.
        entry.wake();
      }
      sleepers.clear();
    },
  };
}
