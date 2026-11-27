/**
 * Styk integracji herdr: supervisor ↔ manager ↔ driver ↔ klient socketu.
 *
 * Plik jest KONTRAKTEM i celowo nie zawiera implementacji ani żadnego I/O. Trzy powody, dla
 * których to jest osobny plik, a nie dopisek do `drivers/types.ts`:
 *
 * 1. `drivers/types.ts` jest kontraktem manager ↔ driver dla WSZYSTKICH driverów i nie może
 *    zależeć od typów jednej integracji.
 * 2. `HerdrClient` musi być importowalny przez agenta piszącego transkrypt (jsonl) BEZ
 *    wciągania modułu socketu — tylko dzięki temu obie połowy powstają równolegle, a testy
 *    drivera nie potrzebują żywego gniazda.
 * 3. Rozdzielenie dwóch strumieni zdarzeń (`HerdrLifecycleEvent` dla managera, `HerdrPaneEvent`
 *    dla drivera) jest tu widoczne w typach, więc nie da się przez pomyłkę czytać cudzego
 *    kanału.
 *
 * Zasada nadrzędna całej integracji: Rarog NIE jest właścicielem procesów po drugiej stronie.
 * Panel `claude` należy do użytkownika i żyje w jego terminalu — Rarog go OGLĄDA i, w wąskim
 * zakresie, do niego PISZE. Nigdy go nie zamyka, nie restartuje i nie przerywa przy sprzątaniu.
 */
import type { EffortLevel, HerdrMode, HerdrStatus } from '@rarog/shared';
import {
  type AnyText, type ArglessSentenceCode, arglessCodeOf, foreign, isServerSentence, say, textOf,
} from '@rarog/shared/sentences';
import type { SessionDriver } from '../drivers/types.ts';
import type { ScreenConsentDialogId, StartDialog } from './dialogs/index.ts';
import type { KeyRowKey } from './dialogs/send/key-row.ts';
import type { TakeBackKey } from './dialogs/send/take-back-keys.ts';
import type { TrustStepKey } from './dialogs/send/trust-step.ts';
import type { RestartReason } from './audit.ts';

// ---------------------------------------------------------------------------
// Agent i jego tożsamość
// ---------------------------------------------------------------------------

/**
 * Status agenta raportowany przez herdr (`agent_status`).
 *
 * `done` to NIE jest stan terminalny: znaczy „praca skończona i nikt jej jeszcze nie widział"
 * (znacznik kasuje dopiero `agent.focus`, a odczyty przez API go nie ruszają). To on daje
 * Rarogowi darmowy badge „nowy wynik". `unknown` znaczy dokładnie „nie wiem" — nie wolno go
 * mapować na żadne przejście stanu.
 */
export type HerdrAgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

/**
 * Silnik panelu — jedyne DWA rodzaje agenta, które istnieją dla Raroga.
 *
 * `claude` to pełna integracja (transkrypt, wysyłka, zgody). `codex` wchodzi jako wpis
 * SAMEGO STANU: wiersz w sidebarze, push, „Pokaż w herdr" — bez treści, bez wysyłki i bez
 * odczytu ekranu. Rozróżnienie musi być POLEM, a nie domysłem po innych polach, bo decyduje
 * o zakresie (`scopeOf`), o odczycie trybu i o tym, czy uuid sesji wolno indeksować jako
 * pisarza pliku jsonl.
 */
export type HerdrEngine = 'claude' | 'codex';

/**
 * Agent tak, jak opisuje go SAM HERDR (jeden wpis `agent.list` po filtrze i normalizacji).
 *
 * Świadomie nie ma tu `key`, `mode` ani `inScope`: żadnego z nich herdr nie zna. `key` nadaje
 * supervisor, `mode` czyta ze stopki ekranu (`agent.list` trybu NIE niesie — sprawdzone na 17
 * agentach), a `inScope` wynika z konfiguracji Raroga. Klient socketu zwraca wyłącznie to,
 * co naprawdę przyszło z drugiej strony.
 */
export interface HerdrAgentInfo {
  /** Aktualny adres w herdr (`w9:p72`) — cel wywołań API. Zmienia się przy `pane move`. */
  paneId: string;
  /**
   * `tab_id` — adres TABA, w którym siedzi panel. Jedyne, co Rarog wolno zamknąć (i tylko
   * dla własnych paneli). Żywy `agent.list` niesie to pole zawsze (zmierzone: 17/17);
   * brak w odpowiedzi = pusty string, czyli „nie ma czego zamykać" (fail-closed dla WŁADZY).
   */
  tabId: string;
  /**
   * `agent_session.value` — uuid sesji silnika. Dla Claude to NAZWA PLIKU jsonl (zmienia go
   * `/clear`); dla Codexa to identyfikator rollouta w `~/.codex/sessions`, którego Rarog
   * NIE czyta — służy mu wyłącznie za trwały znacznik „obejrzane".
   */
  agentSessionId: string;
  /**
   * Który silnik siedzi w panelu (`agent` z odpowiedzi herdr)
   *
   * Pole jest WYMAGANE, a nie opcjonalne z domyślnym `claude`: każdy wpis przechodzi przez
   * `normalizeAgentInfo`, więc „brak silnika" nie jest stanem, który mógłby powstać, a wartość
   * domyślna zamieniłaby przeoczenie w cichą pełną integrację obcego agenta.
   */
  engine: HerdrEngine;
  /**
   * Wartość tokenu `rarog-term` panelu — „ten agent chodzi W TERMINALU RAROGA".
   *
   * `null` dla agenta spoza terminala Raroga. Pole niesie też Claude
   * uruchomiony ręcznie w terminalu Raroga: klient pokazuje go wierszem na liście, a zamiast
   * transkryptu otwiera ten terminal. Wpuszczamy wyłącznie wartość pasującą do `TERM_ID_RE` —
   * token jest metadaną, którą do panelu wpisać może każdy, a stąd bierze się ADRES terminala
   * w kliencie.
   */
  termId: string | null;
  cwd: string;
  status: HerdrAgentStatus;
  /**
   * „Tego agenta uruchomił Rarog" — chip „Rarog" na karcie i sufit `RAROG_MAX_PANES`.
   *
   * Z odpowiedzi herdr: `agent === 'claude'` i `name` pasujące do `RAROG_AGENT_NAME_RE`
   * (`rarog-<6 hex>`, nazwa nadana w `agent.start`). Nazwa żyje tyle, co proces agenta, więc
   * ręczny `claude` w tej samej powłoce po `/exit` jej nie ma. Bywa jej brak także przy agencie
   * Raroga (rekord startu wygasł, herdr wykrył agenta sam) — prawdę daje dopiero UNIA z kluczami
   * założonymi przez TEN proces (`launchedKeys` w nadzorcy, tylko silnik `claude`, czyszczone
   * przy zniknięciu agenta i przy utracie nazwy `rarog-*` — zastąpienie procesu w panelu).
   */
  launchedByRarog: boolean;
  /**
   * `interactive_ready` — dopóki `false`, `agent.prompt` zwraca `agent_not_ready`.
   *
   * Brak pola w odpowiedzi = `true`: panel widziany w `agent.list` bez tej flagi to panel,
   * który już działa (Rarog pisze do takich), więc zachowawcze `false`
   * odcięłoby wysyłkę do wszystkich paneli założonych ręcznie.
   *
   * Dla `engine: 'codex'` zawsze `false`: wpis Codexa nie przyjmuje wysyłki żadnym
   * kanałem, a odpowiedź herdr i tak tego pola dla niego nie niesie.
   */
  interactiveReady: boolean;
  /**
   * `terminal_title_stripped` — auto-tytuł konwersacji („s3-back"). Pusty string, gdy brak.
   *
   * Dla Codexa tytuł jest tu już ZNORMALIZOWANY: bez wiodącej klatki spinnera braille
   * i bez sufiksu ` | <katalog>`, a tytuł równy samej nazwie katalogu (stan przed pierwszym
   * promptem) to pusty string. Normalizacja mieszka w kliencie, bo inaczej kolejne klatki
   * spinnera wyglądałyby w nadzorcy jak zmiana tytułu.
   */
  title: string;
  /**
   * `state_change_seq` — licznik zmian stanu panelu. Strażnik kolejności: aktualizacja
   * z wartością ≤ ostatnio zastosowanej jest odrzucana, bo resync co 30 s zwraca migawkę
   * sprzed odpowiedzi i potrafiłby cofnąć świeższy push (karta skacze między sekcjami).
   */
  stateChangeSeq: number;
}

/**
 * Jeden agent (`claude` albo `codex`) w postaci, w jakiej widzi go reszta Raroga:
 * dane z herdr + tożsamość i kontekst nadane przez supervisora.
 *
 * Ani `paneId`, ani `agentSessionId` nie są stabilne SAME: `/clear` zmienia uuid sesji
 * zachowując panel, a `pane move` zmienia panel zachowując uuid. Dlatego tożsamością jest
 * `key` nadany przy pierwszym zobaczeniu, a nie żadne z pól pochodzących z herdr.
 */
export interface HerdrAgent extends HerdrAgentInfo {
  /**
   * Tożsamość nadana przez supervisora przy PIERWSZYM zobaczeniu agenta (wartość `pane_id`
   * z tej chwili). Nie zmienia się przez całe życie uchwytu — także po `pane move` i `/clear`.
   * To ona jest ziarnem deterministycznego `sessionId` Raroga i kluczem listy ukrytych: bez
   * niej deep-link `/sessions/<uuid>` otwarty na telefonie umierałby przy każdym restarcie.
   */
  readonly key: string;
  /** Tryb uprawnień odczytany ze stopki ekranu — użytkownik ma wiedzieć, co się stanie. */
  mode: HerdrMode;
  /** Kiedy `mode` był ostatnio POTWIERDZONY odczytem stopki (ms) — bramka wysyłki. */
  modeReadAt: number;
  /**
   * `false` = `cwd` spoza `RAROG_HERDR_ROOTS`: karta pokazuje stan i projekt, ale nie oddaje
   * transkryptu i nie przyjmuje wysyłki. Transkrypt realnej pracy jest gęstszy sekretami niż
   * sesja założona z telefonu — to nie jest ta sama klasa danych.
   *
   * Dla `engine: 'codex'` jest `false` NA SZTYWNO, niezależnie od korzeni: ścieżka
   * `!inScope` już dziś robi dokładnie „stan bez treści" (brak followera jsonl, brak pulsu,
   * brak odczytu ekranu przy `blocked`), a pliku `~/.claude/projects/<slug>/<uuid>.jsonl`
   * dla Codexa nie ma. Używamy istniejącej ścieżki zamiast kopiować jej logikę.
   */
  inScope: boolean;
}

// ---------------------------------------------------------------------------
// Dwa rozłączne strumienie zdarzeń
// ---------------------------------------------------------------------------

/**
 * Zdarzenia JEDNEGO panelu — czyta je wyłącznie driver przypięty do tego agenta.
 * Manager tego kanału nie widzi i nie ma po co: dla niego liczy się `DriverEvent`.
 */
export type HerdrPaneEvent =
  | { type: 'status'; status: HerdrAgentStatus; stateChangeSeq: number; title: string }
  | { type: 'mode'; mode: HerdrMode }
  /** `/clear`: ten sam panel, nowy uuid sesji → driver przepina plik transkryptu. */
  | { type: 'session-changed'; agentSessionId: string }
  /** `pane move`: ten sam agent, nowy adres → driver zmienia cel kolejnych wywołań. */
  | { type: 'pane-changed'; paneId: string }
  /**
   * Dialog ZGODY CLI pojawił się (`dialog`) albo zniknął (`null`) z ekranu panelu,
   * który herdr widzi jako `idle`. Nadzorca rozpoznaje go przy odczycie trybu — bez treści
   * ekranu, sam identyfikator z zamkniętej listy.
   */
  | { type: 'consent-dialog'; dialog: ScreenConsentDialogId | null }
  /** Panel zniknął z herdr (zamknięty przez użytkownika). Driver kończy strumień. */
  | { type: 'gone' };

/** Uchwyt do jednego agenta: migawka + subskrypcja jego zdarzeń. */
export interface HerdrAgentHandle {
  /** Migawka aktualizowana W MIEJSCU przez supervisora — driver czyta z niej `paneId`/`cwd`. */
  readonly agent: HerdrAgent;
  subscribe(listener: (ev: HerdrPaneEvent) => void): () => void;
}

/**
 * Zdarzenia CYKLU ŻYCIA — czyta je wyłącznie manager (kto się pojawił, zniknął, wrócił).
 *
 * `unavailable` jest JEDNYM zdarzeniem na całą awarię, a nie N × `gone`: padnięcie socketu
 * nie znaczy, że 17 paneli przestało istnieć, tylko że Rarog przestał je widzieć.
 */
export type HerdrLifecycleEvent =
  | { type: 'appeared'; agent: HerdrAgent }
  /**
   * Znany agent, którego driver umarł (powrót po awarii socketu). Manager podpina NOWY driver
   * do ISTNIEJĄCEJ sesji. Osobno od `appeared`, bo `appeared` na znanym kluczu utworzyłby
   * drugą sesję Raroga na tym samym panelu (albo, przy pominięciu po mapie, żadnej).
   */
  | { type: 're-attached'; agent: HerdrAgent }
  /**
   * Znany agent zyskał albo stracił token terminala Raroga (`agent.termId`). Manager przepisuje
   * pole na kartę i rozgłasza zmianę; drivera to nie dotyczy.
   */
  | { type: 'term-changed'; agent: HerdrAgent }
  | { type: 'gone'; key: string }
  /** `reason` to zdanie banera (tekst własny albo obcy z gniazda); manager rozgłasza jego tekst w `herdr-status`. */
  | { type: 'unavailable'; reason: AnyText }
  | { type: 'available' };
// ---------------------------------------------------------------------------
// Zakładanie panelu — jedyne wejście do metod tworzących cokolwiek w herdr
// ---------------------------------------------------------------------------

/**
 * Zlecenie założenia panelu.
 *
 * **Nie ma pola `prompt`** i nie będzie: prompt użytkownika nigdy nie wchodzi do argv
 * (`docs/security-model.md`, „Starting sessions from the phone: three powers”)
 * — `agent.start` wpisuje linię do POWŁOKI panelu, a `assertSendable` czyści znaki
 * sterujące terminala, nie metaznaki powłoki. Prompt startowy wysyła manager przez
 * `driver.send()` po `interactive_ready`, czyli tym samym kanałem co każdą inną wysyłkę.
 */
export interface HerdrLaunchRequest {
  cwd: string;
  label?: string;
  model?: string;
  effort?: EffortLevel;
  /**
   * Start z ultracode: `--effort ultracode` zamiast `--effort xhigh` (CLI ustawia wtedy poziom `xhigh`).
   * Wymaga `effort` nieobecnego albo `'xhigh'`; inny poziom = błąd budowy argv.
   */
  ultracode?: boolean;
  permissionMode?: string;
  /** `--resume <uuid>`; z `fork: true` dokłada `--fork-session` i NOWY `--session-id`. */
  resumeFrom?: string;
  fork?: boolean;
}

export interface HerdrLaunchResult {
  key: string;
  paneId: string;
  tabId: string;
  /** UUID, który RAROG wylosował i podał przez `--session-id` — ścieżka jsonl znana od tej chwili. */
  agentSessionId: string;
  createdWorkspace: boolean;
  argv: readonly string[];
  /**
   * Status panelu w chwili, gdy launcher przestał na niego czekać.
   *
   * Jest tu, bo dla panelu STOJĄCEGO NA DIALOGU ZAUFANIA to jedyne źródło tej wiedzy w całym
   * Rarogu: taki panel nie ma jeszcze `agent_session` (proces `claude` już działa — jego ekran to fixture
   * `dialog-trust-2.1.293.txt` — ale herdr sesji jeszcze nie zgłasza), więc
   * `normalizeAgentInfo` odrzuca go w całości i ani resync, ani push nigdy nie donoszą o nim
   * ani słowa. Bez tego pola wpis rejestracyjny zostawał na `unknown` już na zawsze, driver
   * nie dostawał przejścia w `blocked` i karta zaufania NIE POWSTAWAŁA (panel wisiał, a telefon
   * pokazywał „czeka na polecenie”).
   *
   * `interactiveReady` mówi o czym innym — czy wolno wysłać prompt. Panel na dialogu jest
   * `blocked` i NIE jest gotowy; te dwa pola rozjeżdżają się dokładnie w tym przypadku.
   */
  status: HerdrAgentStatus;
  /** `false`, dopóki panel stoi na dialogu — `agent.prompt` oddałby wtedy `agent_not_ready`. */
  interactiveReady: boolean;
  /**
   * A Claude Code start dialog herdr reads as ready (`idle`, `interactive_ready`, no session id) that ended the wait
   * with `status: 'blocked'`. Absent when herdr reported `blocked` itself or when no dialog stood.
   */
  startDialog?: StartDialog;
}

/**
 * A pane Rarog launched whose engine session herdr does not know yet (the supervisor has not seen the agent on a
 * list): a start dialog may stand in it. `startDialog` is what the launcher read ({@link HerdrLaunchResult}); `null`
 * when herdr reported `blocked` itself or the launch has not settled.
 */
export interface HerdrStartPhase {
  readonly startDialog: StartDialog | null;
}

/**
 * To, co wraca ZANIM agent jest gotowy — pozwala odpowiedzieć 202 z prawdziwym `sessionId`.
 *
 * `agent.start` kończy się sukcesem w 1,4 ms, ale `interactive_ready` przychodzi po ~5 s
 * (zmierzone). Trzymanie połączenia HTTP przez te 5 s gubi telefon przy zgaszeniu
 * ekranu, więc rozdzielamy: uchwyt teraz, wynik po SSE.
 */
export interface HerdrLaunchHandle {
  key: string;
  paneId: string;
  tabId: string;
  agentSessionId: string;
  /**
   * Katalog nie miał `hasTrustDialogAccepted` — panel wstanie na dialogu zaufania.
   *
   * Dialog zaufania jest na zamkniętej liście sygnatur (`KNOWN_DIALOGS`), więc panel powstaje,
   * a flaga jest OSTRZEŻENIEM dla odpowiedzi `202`: „za chwilę potwierdzisz to z telefonu".
   */
  trustPrompt?: boolean;
  /** Rozstrzyga się na `interactive_ready` albo rzuca; manager wiąże to z SSE, nie z HTTP. */
  ready: Promise<HerdrLaunchResult>;
}

/**
 * Dane, którymi launcher rezerwuje panel w supervisorze i dostaje za nie `key`.
 *
 * Kontrakt mieszka TU, a nie w `launcher.ts`, bo potrzebują go obie strony, a supervisor nie
 * ma prawa zależeć od modułu launchera (ani odwrotnie) — inaczej „jeden moduł tworzy" i „jeden
 * moduł zna tożsamość" przestałyby być rozdzielne.
 */
export interface HerdrLaunchRegistration {
  paneId: string;
  tabId: string;
  /** UUID podany przez `--session-id` — supervisor zna go ZANIM agent go zgłosi. */
  agentSessionId: string;
  cwd: string;
  /**
   * Tytuł panelu PO sanityzacji — ten sam, który idzie do `pane.report_metadata`.
   *
   * Jedzie w rejestracji, a nie osobnym kanałem, bo dwa równoległe `launch()` w tym samym
   * procesie są dozwolone — wspólna zmienna gubiłaby tytuł jednego z nich.
   */
  label: string;
}

/** Implementują: supervisor (realny) i mock herdr (demo). */
export interface HerdrLauncher {
  /** Rezerwuje `key` i `sessionId` SYNCHRONICZNIE po `tab.create`, resztę robi w tle. */
  launch(req: HerdrLaunchRequest): Promise<HerdrLaunchHandle>;
}

/**
 * Prawda o tym, jakie agenty żyją, w jakim są stanie i trybie.
 *
 * Supervisor NIE zna managera, a manager nie zna socketu — cały styk to ten interfejs
 * plus `SessionDriver` zwracany z `attach()`.
 */
export interface HerdrSupervisor extends HerdrLauncher {
  /** Jednokonsumencki strumień cyklu życia. Pierwsze zdarzenia to `appeared` dla stanu bieżącego. */
  readonly events: AsyncIterable<HerdrLifecycleEvent>;
  status(): HerdrStatus;
  /** Driver przypięty do żywego panelu. Rzuca `HerdrGoneError`, gdy `key` już nie istnieje. */
  attach(key: string): SessionDriver;
  /** Start karencji `idle` po wysyłce — detekcja herdr jest ekranowa i przez chwilę kłamie. */
  markSent(key: string): void;
  /**
   * Tryb uprawnień panelu POTWIERDZONY odczytem stopki nie starszym niż
   * `HERDR_MODE_FRESH_MS` — bramka wysyłki.
   *
   * Wpisy `permission-mode` w jsonl powstają dopiero PO turze, więc `shift+tab` naciśnięty
   * przy biurku między turami zostawiłby Raroga w przekonaniu „manual". Nieudany odczyt
   * albo nieczytelna stopka → `'unknown'`, a manager traktuje `unknown` jak `bypass`
   * (reguła 11.7: wysyłka tylko w `RAROG_YOLO_ROOTS`).
   */
  ensureFreshMode(key: string): Promise<HerdrMode>;
  /** „Pokaż w herdr". Jedyna akcja, która celowo kasuje znacznik `done`. */
  focus(key: string): Promise<void>;
  /**
   * Zamknięcie taba — każdego panelu, nie tylko Raroga. Rzuca `HerdrNotOwnedError`
   * dla wpisu Codexa, bez adresu taba albo bez kanału tworzenia.
   */
  closeTab(key: string): Promise<void>;
  /**
   * Stary tab po restarcie sesji: zamyka go WYŁĄCZNIE, gdy świeży `pane.list` pokazuje
   * w nim jeden panel bez agenta. `true` = zamknięty; `false` = zostaje (split, agent, błąd).
   * Opcjonalna — atrapy nadzorcy w testach bez restartu jej nie mają.
   */
  closeShellTab?(tabId: string, cwd: string): Promise<boolean>;
  /**
   * `canLaunch` bez sufitu paneli: czy launcher w ogóle może zakładać. Restart zastępuje
   * panel i sufit liczy sam — pełny sufit nie ma prawa maskować `RAROG_HERDR_LAUNCH=0`.
   */
  launchAvailable?(): boolean;
  /**
   * Wpis `restart` w dzienniku: `reason` mówi, który gest, `versions` to `running → installed`
   * — tylko przy aktualizacji (restart po blokadzie promptu bywa na tym samym wydaniu).
   */
  logRestart?(key: string, reason: RestartReason, versions?: string): void;
  /**
   * Wpis `refuse` z powodem `command-not-allowed`: strażnik managera odrzucił slash-komendę.
   * `key` = panel, do którego szła wiadomość (`null` przy prompcie startowym, panelu jeszcze nie ma);
   * `command` = sam pierwszy token. Opcjonalna — atrapy nadzorcy w testach dziennika nie mają.
   */
  logCommandRefusal?(key: string | null, cwd: string, command: string): void;
  /** Ile paneli z `launchedByRarog` żyje TERAZ — sufit `RAROG_MAX_PANES`. */
  rarogPaneCount(): number;
  /**
   * Etykieta KARTY tej sesji powstała albo się zmieniła — etykieta taba w herdr ma za nią pójść
   * Woła ją manager z JEDNEGO miejsca (`#setLabel`); nadzorca odkłada pracę (debounce
   * na klucz) i nazywa tab wyłącznie wtedy, gdy ma do tego prawo (tab jednopanelowy, panel
   * z etykietą pochodzenia `rc:`, lokator `claude`, etykieta taba nie nadana ręcznie).
   * Nigdy nie rzuca i niczego nie zwraca — to jest best effort, nie warunek sesji.
   * Opcjonalna, bo atrapy nadzorcy w testach i mock demo tabów w herdr nie mają.
   */
  syncTabLabel?(key: string, label: string): void;
  /**
   * Migawka agenta o tym kluczu — `undefined`, gdy panel nie żyje.
   *
   * Metoda jest OPCJONALNA, bo atrapy nadzorcy w testach nie mają czego migawkować.
   */
  agentFor?(key: string): HerdrAgent | undefined;
  /**
   * `session_id` silnika sesji Claude w zakresie (`inScope`), które nadzorca dziś trzyma — lista `sessions`
   * w `alive.json` trybu cienia. Migawka z RAM, bez `agent.list`: plik pisany co 10 s nie czeka na herdr.
   *
   * Opcjonalna, bo atrapy nadzorcy w testach nie trzymają agentów.
   */
  observedEngineSessions?(): readonly string[];
  /**
   * Świeży `agent.list` do sprawdzenia pisarza tuż przed `agent.start`.
   *
   * Musi być ODCZYTEM Z HERDR, a nie z indeksu w RAM: `#forgetHerdrSession` zdejmuje sesję
   * z `#byEngineSession` przy UKRYCIU, a ukryty panel dalej żyje i dalej pisze do jsonl.
   */
  liveEngineSessions(): Promise<ReadonlySet<string>>;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Klient socketu — typowana fasada, jedyne wyjście na zewnątrz
// ---------------------------------------------------------------------------

/** Wynik `agent.read`: surowy tekst ekranu panelu. */
export interface HerdrScreen {
  text: string;
}

/**
 * Wynik `pane.read` ze źródłem `recent_unwrapped`: HISTORIA panelu, nie ekran.
 *
 * `truncated` mówi, czy scrollback był dłuższy niż zamówione `lines` — jedyna droga, żeby
 * klient powiedział „ucięte do N linii" zamiast udawać, że widać całość.
 */
export interface HerdrPaneHistory {
  text: string;
  truncated: boolean;
}


/**
 * Typowana fasada nad socketem herdr.
 *
 * Interfejs mieszka w kontrakcie, a nie przy implementacji, żeby driver transkryptu mógł go
 * zafake'ować bez dotykania gniazda — to jedyny czysty rozdział, który skraca ścieżkę
 * krytyczną projektu.
 *
 * Uwagi, które są częścią KONTRAKTU, a nie szczegółem implementacji:
 * - `readScreen` NIE przyjmuje liczby linii. Schemat herdr ma `lines` opcjonalne, serwer bez
 *   niego oddaje widoczny ekran (0,2 ms), a podanie stałej wpada w kosztowną ścieżkę (380 ms).
 *   Historii i tak stamtąd nie ma — ona jest w jsonl.
 * - `prompt` przekazuje `wait` WYŁĄCZNIE dla zwykłych promptów (trzeci argument): herdr czeka
 *   wtedy na wejście panelu w `working` i brak przejścia wraca jako `agent_prompt_stalled` —
 *   jedyny sygnał, że Enter nie zarejestrował się w TUI, a tekst wisi w composerze. Slash-komendy
 *   idą bez `wait`: typ `local` nie startuje tury (pomiar żywy `commands/measured/live-2.1.310.json`),
 *   więc z `wait` dałby fałszywy stall; typ `prompt` turę startuje, a jedzie bez `wait` z decyzji
 *   Raroga.
 * - `sendKeys` przepuszcza wyłącznie klawisze z zamkniętej allow-listy i rzuca, ZANIM dotknie
 *   gniazda (nie wysyłamy poprawnego prefiksu tablicy z jednym złym elementem).
 */
export interface HerdrClient {
  listAgents(): Promise<HerdrAgentInfo[]>;
  getAgent(paneId: string): Promise<HerdrAgentInfo>;
  /**
   * @param source `'detection'` = wycinek dialogu (do wiadomości systemowej przy `blocked`),
   *               `'visible'` = widoczny ekran (do odczytu trybu ze stopki). Poza rozpoznanym
   *               trybem i wycinkiem dialogu NIC z ekranu AGENTA nie jest zapisywane ani
   *               logowane — ekran potrafi zawierać treść `.env` albo klucz w komendzie.
   *
   */
  /**
   * @param format `'ansi'` zostawia sekwencje SGR w tekście — działa TYLKO ze źródłem
   *   `visible` (`detection` jest po stronie herdr zawsze odarte). Jedyny odbiorca: ocena
   *   composera przed parą `Esc Esc` (`composerStateFrom`), która odróżnia treść od
   *   przyciemnionej podpowiedzi CLI po atrybucie.
   */
  readScreen(
    paneId: string, source: 'detection' | 'visible', format?: 'text' | 'ansi',
  ): Promise<HerdrScreen>;
  /** @param wait `true` = `wait: { until: ['working'] }` — patrz uwaga o kontrakcie wyżej. */
  prompt(paneId: string, text: string, wait?: boolean): Promise<void>;
  sendKeys(paneId: string, keys: readonly string[]): Promise<void>;
  /**
   * Zatwierdzenie formularza z preview — wysyła DOKŁADNIE `['enter']` i nic innego.
   * Osobna metoda zamiast `enter` w allow-liście `sendKeys`: wspólna lista dawałaby klawisz
   * zatwierdzania po pozycji KAŻDEJ ścieżce naraz. Wolno ją wołać wyłącznie po dowodzie
   * z `form-submit.ts`, że `❯` stoi na wybranej etykiecie.
   */
  sendFormSubmit(paneId: string): Promise<void>;
  /**
   * Cykl trybu uprawnień panelu — wysyła DOKŁADNIE `['shift+tab']` i nic innego.
   * Osobna metoda z tego samego powodu co `sendFormSubmit`: klawisz cyklujący tryb CAŁEJ sesji
   * nie ma prawa stać na wspólnej allow-liście. Wolno ją wołać wyłącznie z pętli
   * „naciśnij → odczytaj stopkę" w driverze (`herdr/mode-cycle.ts`).
   */
  sendModeCycle(paneId: string): Promise<void>;
  /**
   * Krok zatwierdzenia dialogu zaufania bez cyfr — wysyła DOKŁADNIE `[key]`, `down` albo `enter`.
   * Osobna metoda z tego samego powodu co `sendFormSubmit`: `down` i `enter` na wspólnej allow-liście dawałyby
   * wybór po pozycji każdej ścieżce naraz. Wolno ją wołać wyłącznie po dowodzie z `send/trust-step.ts`.
   */
  sendTrustStep(paneId: string, key: TrustStepKey): Promise<void>;
  /**
   * One key of a layer 2 card's key row: an arrow, Tab or Enter, EXACTLY `[key]` (`send/key-row.ts`). A method
   * of its own for the reason `sendFormSubmit` has one: these keys on the shared allow-list would open choice by
   * position to every send path at once. Called only by the layer 2 step after its proof from a fresh read.
   */
  sendDialogKey(paneId: string, key: KeyRowKey): Promise<void>;
  /**
   * One key of the queue take-back: `up`, `down` or `ctrl+u`, EXACTLY `[key]` (`send/take-back-keys.ts`). A method of
   * its own for the reason `sendFormSubmit` has one: `up` and `down` on the shared allow-list would open choice by
   * position to every send path at once. Called only by the driver's queue take-back module, after its proof from a
   * fresh read that the prompt field takes the key; the caller audits each key as `send_keys`.
   */
  sendTakeBackKey(paneId: string, key: TakeBackKey): Promise<void>;
  /**
   * Samo wklejenie tekstu do panelu agenta: `pane.send_input` z `text`, bez klawiszy.
   * Wolno ją wołać wyłącznie ze ścieżki wysyłki w trakcie tury w driverze, po świeżym `agent.get`, że pod tym adresem
   * stoi ten sam agent, i po sprawdzeniu, że nie stoi dialog.
   */
  pasteText(paneId: string, text: string): Promise<void>;
  /**
   * Wysłanie wklejonej wiadomości — DOKŁADNIE `['enter']` i nic innego. Osobna metoda
   * z tego samego powodu co `sendFormSubmit`. Wolno ją wołać wyłącznie ze ścieżki wysyłki w trakcie tury, po dowodzie,
   * że pole trzyma wklejony tekst, a rejestr sesji CLI i kanał zgód nie zgłaszają dialogu.
   */
  sendPromptSubmit(paneId: string): Promise<void>;
  focus(paneId: string): Promise<void>;
  ping(): Promise<{ version: string; protocol: number }>;
  /**
   * `pane.read` with source `recent_unwrapped` — the history of ONE pane as text without ANSI
   * (the same method as in {@link HerdrLaunchClient}; described at that declaration).
   *
   * The driver does NOT call it: the turn text stands in the jsonl BEFORE the dialog, so the only
   * reader of `pane.read` is the terminal facade (`HerdrLaunchClient`, `term/herdr-backend.ts`),
   * which carries the pane ownership gate. The declaration stays on the driver interface without
   * a caller; a driver that reads its own pane may use ONLY `#paneId` from the agent handle.
   */
  readPaneHistory(paneId: string, lines: number): Promise<HerdrPaneHistory>;
  /**
   * Liczba wierszy terminala WŁASNEGO panelu: `scroll.viewport_rows` z wpisu panelu w `pane.list`.
   * Jedyny wołający: driver przy karcie bez decyzji (`degrade`), do dziennika odmów,
   * z własnym budżetem czekania (`HERDR_PANE_ROWS_WAIT_MS`). Błąd, brak panelu albo pola w odpowiedzi
   * = wpis bez wierszy.
   *
   * Nie `pane.layout`: tamten oddaje prostokąt układu TABA (pomiar: 128×52 przy pty
   * panelu 62×29, `viewport_rows` 28), więc nie mówi, ile wierszy widzi dialog. Kolumn API gniazda
   * herdr 0.9.5 nie podaje w ogóle.
   *
   * Opcjonalna, bo niczego nie rozstrzyga: atrapa klienta bez tej metody (testy drivera) daje wpis
   * `degrade` bez wierszy — tak samo jak błąd odczytu na produkcji.
   */
  readPaneRows?(paneId: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// Kanał TWORZENIA — osobny interfejs, świadomie
// ---------------------------------------------------------------------------

/**
 * Jeden panel z `pane.list` — jedyna odpowiedź herdr, która niesie `cwd`.
 *
 * `WorkspaceInfo` i `TabInfo` `cwd` NIE mają (zweryfikowane), więc mapowanie
 * „katalog → workspace" idzie wyłącznie tędy: `pane.list` to 2,01 ms / 15 kB, czyli najwęższa
 * wystarczająca odpowiedź (`session.snapshot` byłby 37 kB i jest poza allow-listą).
 */
export interface HerdrPaneInfo {
  paneId: string;
  tabId: string;
  workspaceId: string;
  cwd: string;
  /**
   * `tokens` z `pane.report_metadata` — dziś czyta je wyłącznie terminal (`rarog-term`).
   * Żyją w RAM serwera herdr: restart herdr je kasuje (terminal odzyskuje swój z etykiety).
   */
  tokens: Readonly<Record<string, string>>;
  /**
   * Etykieta PANELU (`pane.rename`) albo `null`, gdy jej nie ma. herdr trzyma ją
   * w snapshotcie, więc przeżywa restart serwera herdr; czyta ją `parsePaneLabel`
   * (`herdr/provenance.ts`) — wszystko spoza wzorców Raroga znaczy „panel cudzy".
   */
  label: string | null;
}

/**
 * Jeden workspace z `workspace.list` — dokładnie to, na czym stoi wybór workspace'u
 * projektu (`herdr/workspace-resolver.ts`): etykieta i, gdy herdr ją zna, ścieżka checkoutu.
 *
 * `worktree {checkout_path, repo_root, …}` herdr dokłada tylko workspace'om, które rozpoznał
 * jako checkout gita (zmierzone: 1 z 10). `checkoutPath` to katalog TEGO checkoutu,
 * `repoRoot` — repozytorium, z którego pochodzi (dla dowiązanego worktree to INNY katalog: repo
 * główne). Reszty `WorkspaceInfo` (`number`, `focused`, `tokens`, liczniki) Rarog nie czyta.
 */
export interface HerdrWorkspaceInfo {
  workspaceId: string;
  label: string;
  checkoutPath?: string;
  repoRoot?: string;
}

/**
 * Jeden tab z `tab.get` — dokładnie te pola, na których stoi prawo Raroga do `tab.rename`:
 * bieżąca etykieta (czy nadał ją Rarog) i liczba paneli (split = tab nie jest „Raroga").
 * Reszty `TabInfo` (`number`, `focused`, `agent_status`) Rarog nie czyta.
 */
export interface HerdrTabInfo {
  tabId: string;
  label: string;
  paneCount: number;
  workspaceId: string;
}

/**
 * Układ taba z `pane.layout` — prostokąty paneli w komórkach, po obramowaniach
 * i odstępach herdr, liczone na obszarze, który herdr dał panelom przy ostatnim widoku klienta.
 *
 * To NIE jest rozmiar pty panelu: przy podłączonym kontrolerze terminala pty ma rozmiar kontrolera,
 * a układ dalej mówi, ile miejsca panel dostałby w widoku (pomiar: 128×52 przy pty 62×29).
 * Dlatego czyta go wyłącznie backend terminala, żeby przed zwolnieniem kontrolera oddać panelowi
 * rozmiar z układu. Wąsko: id panelu i szerokość z wysokością — położenia, podziały i fokus
 * nie wchodzą do serwera.
 */
export interface HerdrPaneLayout {
  readonly panes: readonly { readonly paneId: string; readonly width: number; readonly height: number }[];
}

/**
 * Jeden proces pierwszego planu panelu (`pane.process_info` → `foreground_processes[]`).
 *
 * Kształt jest WĄSKI z premedytacją: herdr oddaje przy każdym procesie także `argv`, `cmdline`
 * i `cwd`, a to bywa CAŁA linia polecenia (`psql "postgres://user:hasło@host"`). Rarog potrzebuje
 * jednego słowa na etykietę taba, więc fasada wpuszcza do serwera wyłącznie `pid`, `name`
 * i `argv0` — reszta nie ma prawa istnieć poza gniazdem.
 */
export interface HerdrPaneProcess {
  readonly pid: number;
  /** Nazwa procesu wg jądra; herdr gwarantuje to pole. */
  readonly name: string;
  /** `argv[0]` procesu; pusty string, gdy herdr go nie zna (pole jest nullowalne). */
  readonly argv0: string;
}

/**
 * Wynik `pane.process_info` po odsianiu — patrz {@link HerdrPaneProcess}.
 *
 * `processes` w KOLEJNOŚCI od herdr. Element `[0]` jest najbardziej informatywny (zmierzone:
 * dla panelu z codeksem `[0]` to `codex`, a proces o pid równym
 * `foreground_process_group_id` to `node`), więc wołający bierze pierwszy, a nie „ten o pid
 * grupy". Pusta tablica jest normalnym stanem: powłoka bez procesu na pierwszym planie.
 */
export interface HerdrPaneProcessInfo {
  readonly processes: readonly HerdrPaneProcess[];
}

/**
 * Powłoki, po których panel uchodzi za „gołą powłokę". Nazwa procesu wg jądra — bez `-`
 * loginowego. Czytają ją dwa miejsca i oba ZAMYKAJĄ panel tylko po tym rozpoznaniu: sprzątanie
 * starego taba po restarcie sesji (`closeShellTab` w nadzorcy) i zastąpienie sieroty
 * lazygita po restarcie herdr (`term/herdr-backend.ts`).
 */
export const HERDR_SHELL_PROCESS_NAMES: ReadonlySet<string> = new Set([
  'zsh', 'bash', 'fish', 'sh', 'dash', 'ksh', 'tcsh', 'nu',
]);

/**
 * Czy na pierwszym planie panelu stoi SAMA powłoka — dokładnie jeden proces i to powłoka.
 *
 * Zmierzone: goła powłoka daje dokładnie `[zsh]`, program na pierwszym planie daje
 * swoją nazwę (po `claude; nvim plik` stoi edytor). Pusta lista to „nie wiem", nie „powłoka" —
 * oba miejsca wołające zamykają panel, więc wątpliwość ma wypaść w stronę „zostaw".
 */
export function isBareShellForeground(processes: readonly { readonly name: string }[]): boolean {
  return processes.length === 1 && HERDR_SHELL_PROCESS_NAMES.has(processes[0]?.name ?? '');
}

export interface HerdrCreateWorkspaceParams {
  cwd: string;
  label?: string;
  /**
   * Zmienne środowiska panelu. **Obowiązkowe w praktyce**: serwer herdr dziedziczy env po tym,
   * kto go uruchomił, a odziedziczony `CLAUDE_CODE_CHILD_SESSION` wyłącza zapis transkryptu
   * (docs `errors.md`, „Transcript saving is off because of an inherited CLAUDE_CODE_CHILD_SESSION
   * marker”) — wtedy warstwa treści Raroga znika PO CICHU.
   */
  env?: Readonly<Record<string, string>>;
  /**
   * Czy herdr ma PRZEŁĄCZYĆ aktywny tab na świeżo utworzony. Nieobecne = `false` — launch
   * sesji zostaje jak dotąd w tle, bo Rarog nie ma prawa wyrywać człowiekowi terminala spod
   * rąk przy każdej sesji z telefonu. `true` wysyła wyłącznie tab TERMINALOWY: jego
   * otwiera się właśnie po to, żeby zaraz przy nim usiąść.
   */
  focus?: boolean;
}

export interface HerdrCreateWorkspaceResult {
  workspaceId: string;
  tabId: string;
  paneId: string;
}

export interface HerdrCreateTabParams {
  workspaceId: string;
  cwd: string;
  label?: string;
  env?: Readonly<Record<string, string>>;
  /** Jak w {@link HerdrCreateWorkspaceParams.focus}: default `false`, `true` tylko terminal. */
  focus?: boolean;
}

export interface HerdrCreateTabResult {
  tabId: string;
  paneId: string;
}

export interface HerdrStartAgentParams {
  /** `^[a-z][a-z0-9_-]{0,31}$`, unikalna wśród żywych — Rarog używa `rarog-<6 hex>`. */
  name: string;
  /** Rodzaj agenta; Rarog zna wyłącznie `claude` (codex i reszta są poza zakresem). */
  kind: string;
  paneId: string;
  /**
   * Argumenty `claude` — WYŁĄCZNIE z allow-listy `argv.ts`, nigdy pozycyjne
   * (`docs/security-model.md`, „Starting sessions from the phone: three powers”).
   */
  args: readonly string[];
  timeoutMs?: number;
}

export interface HerdrStartAgentResult {
  /** `agent_started.argv` — dokładna linia, którą herdr wpisał do powłoki panelu (do audytu). */
  argv: readonly string[];
}

export interface HerdrPaneMetadataParams {
  paneId: string;
  source: string;
  /**
   * ≤ 16 kluczy `^[A-Za-z0-9_-]{1,32}$`. Nieobecne = pole w ogóle nie idzie do herdr (stempel
   * samego tytułu panelu Claude). Tokeny żyją w RAM serwera herdr i giną przy restarcie.
   */
  tokens?: Readonly<Record<string, string>>;
  title?: string;
  /** ≤ 24 h (limit herdr). Nieobecne = metadane do nadpisania, wyczyszczenia albo zamknięcia panelu. */
  ttlMs?: number;
}

/**
 * Metody, które coś TWORZĄ, NAZYWAJĄ albo ZAMYKAJĄ po stronie herdr.
 *
 * Świadomie osobny interfejs, a nie pola `HerdrClient`: implementuje go
 * `createHerdrLaunchClient`, a każdy zapis tej fasady stoi w `MUTATING_METHODS`, więc
 * `RAROG_HERDR_SEND=0` covers them. Rozdzielenie jest po to,
 * żeby bramka kontraktu nie wymusiła wystawienia kanału tworzenia PRZED allow-listą metod —
 * fasada, która umie zakładać panele, nie ma prawa powstać wcześniej niż jej ograniczenia.
 */
export interface HerdrLaunchClient {
  listPanes(): Promise<HerdrPaneInfo[]>;
  /**
   * `workspace.list` — etykiety workspace'ów i ścieżki checkoutu. Metoda CZYTAJĄCA
   * (`READ_METHODS`); czyta ją wyłącznie wybór workspace'u projektu (`herdr/project-workspace.ts`)
   * tuż przed `tab.create`/`workspace.create` — launcher agentów i backend terminala. Wpis
   * w nieznanym kształcie odpada (nie jest kandydatem — skutkiem jest co najwyżej nowy
   * workspace), odpowiedź bez listy rzuca.
   */
  listWorkspaces(): Promise<HerdrWorkspaceInfo[]>;
  /**
   * `pane.read` ze źródłem `recent_unwrapped` — historia JEDNEGO panelu jako tekst bez ANSI.
   *
   * Metoda CZYTAJĄCA (`READ_METHODS` w `socket.ts`), więc przechodzi także przy
   * `RAROG_HERDR_SEND=0`. Bramka „czy to nasz panel" (token `rarog-term` ze świeżego
   * `pane.list`) stoi po stronie wołającego — `term/herdr-backend.ts` — bo tylko on wie,
   * który panel jest terminalem Raroga. Bez tej bramki metoda oddawałaby treść CUDZEJ
   * powłoki na samo zgadnięcie pozycyjnego `pane_id`.
   *
   * `recent_unwrapped`, a nie `recent`: herdr zwija wtedy z powrotem wiersze złamane przez
   * szerokość panelu, czyli oddaje LINIE POLECEŃ, a nie kawałki wierszy terminala — o to
   * chodzi w „skopiuj mi to, co tam wyszło".
   */
  readPaneHistory(paneId: string, lines: number): Promise<HerdrPaneHistory>;
  /**
   * `pane.process_info` — procesy pierwszego planu JEDNEGO panelu, do etykiety taba terminala.
   *
   * Metoda CZYTAJĄCA (`READ_METHODS` w `socket.ts`), więc przechodzi także przy
   * `RAROG_HERDR_SEND=0`. Bramka „czy to nasz panel" (token `rarog-term` ze świeżego
   * `pane.list`) stoi po stronie wołającego — `term/herdr-backend.ts` — bo tylko on wie,
   * który panel jest terminalem Raroga. Bez niej metoda mówiłaby, co człowiek uruchomił
   * w CUDZYM panelu, na samo zgadnięcie pozycyjnego `pane_id`.
   *
   * Drugi wołający: `closeShellTab` nadzorcy pyta o panel, w którym Rarog SAM przed
   * chwilą zakończył `claude` `/exit`em — i porównuje nazwę z listą powłok, nic więcej.
   *
   * Trzeci wołający: launcher po porażce czekania na gotowość (rozjazd id sesji albo
   * timeout) pyta RAZ o panel, który sam przed chwilą założył, i wpisuje `pid name argv0` do
   * jednej linii `server.log` — nic więcej z tej odpowiedzi nie idzie dalej. Błąd odczytu daje
   * w linii `foreground: unknown`.
   */
  readPaneProcess(paneId: string): Promise<HerdrPaneProcessInfo>;
  /**
   * Same `pane_id` z `pane.list` — inwentarz OBECNOŚCI paneli, bez filtra przydatności.
   *
   * `listPanes` odsiewa wiersze bez `cwd`/`tab_id`/`workspace_id` (dla launchera bezużyteczne)
   * i panele z `restore_error` (herdr ich nie odtworzył, procesu nie ma),
   * ale „odfiltrowany" nie znaczy „nieistniejący": sprzątanie sierot w supervisorze
   * (`sweepBlockedOrphans`) pytające o ISTNIENIE panelu musi patrzeć na
   * pełny inwentarz — inaczej wiersz zubożony przez minor herdr uchodziłby za zamknięty tab
   * i żywa sesja na dialogu zaufania dostawałaby `gone`.
   */
  listPaneIds(): Promise<ReadonlySet<string>>;
  /**
   * `tab.get` — etykieta i liczba paneli JEDNEGO taba. Metoda CZYTAJĄCA (`READ_METHODS`),
   * więc przechodzi przy `RAROG_HERDR_SEND=0`; czytają ją dwa miejsca, oba tuż przed decyzją
   * o `tab.rename`: synchronizacja etykiety taba z kartą (nadzorca, `syncTabLabel`) i migracja
   * etykiet tabów terminala (`reconcile` w `term/herdr-backend.ts`). Odpowiedź w nieznanym
   * kształcie rzuca — wołający wtedy niczego nie nazywa.
   */
  getTab(tabId: string): Promise<HerdrTabInfo>;
  /**
   * `pane.layout` — prostokąty paneli taba, w którym stoi `paneId` ({@link HerdrPaneLayout}).
   * Metoda CZYTAJĄCA (`READ_METHODS`). Jedyny wołający, backend terminala,
   * czyta układ tuż przed `terminal.release` po karencji, żeby przywrócić rozmiar panelu
   * (`term/herdr-backend.ts`). Odpowiedź w nieznanym kształcie rzuca.
   *
   * Opcjonalna, bo niczego nie rozstrzyga: klient bez tej metody (atrapy launchera i nadzorcy)
   * daje zwolnienie kontrolera bez przywrócenia rozmiaru — tak samo jak błąd odczytu.
   */
  readPaneLayout?(paneId: string): Promise<HerdrPaneLayout>;
  createWorkspace(params: HerdrCreateWorkspaceParams): Promise<HerdrCreateWorkspaceResult>;
  createTab(params: HerdrCreateTabParams): Promise<HerdrCreateTabResult>;
  startAgent(params: HerdrStartAgentParams): Promise<HerdrStartAgentResult>;
  reportPaneMetadata(params: HerdrPaneMetadataParams): Promise<void>;
  /**
   * Etykieta PANELU (`pane.rename`); `null` ją zdejmuje. Wołający: launcher, na panelu,
   * który SAM przed chwilą założył (`rc:<klucz><ślad>`, `herdr/provenance.ts`), oraz
   * backend terminala — świeży panel terminala i migracja panelu, który już nosi token
   * `rarog-term` (`rt:<id>`, `term/herdr-backend.ts`). The label migration
   * (`herdr/label-migration.ts`) rewrites old-format labels through it too.
   *
   * herdr etykiet nie normalizuje (zmierzone: ESC, `\n`, pusty napis przyjęte), więc
   * fasada odrzuca pusty adres, pusty napis i znaki sterujące, ZANIM cokolwiek pójdzie do gniazda.
   */
  renamePane(paneId: string, label: string | null): Promise<void>;
  /**
   * Etykieta TABA (`tab.rename`). Wołający: launcher i backend terminala, każdy zaraz po
   * SWOIM `workspace.create`, które nadaje pierwszemu tabowi „1"; nadzorca, gdy etykieta karty
   * się zmieni (`syncTabLabel` — tylko tab jednopanelowy z panelem `rc:`, etykieta nie
   * nadana ręcznie); backend terminala przy migracji starych etykiet tabów (`reconcile`).
   * Te same bramki wejścia co {@link renamePane}; zdjęcia nie ma (herdr wymaga napisu).
   */
  renameTab(tabId: string, label: string): Promise<void>;
  closeTab(tabId: string): Promise<void>;
  /**
   * Zamyka JEDEN panel (`pane.close`) — wyłącznie dla terminala na backendzie herdr.
   *
   * Metoda weszła na allow-listę gniazda razem z tym backendem (`socket.ts`) i jest jedyną,
   * która zamyka coś adresowanego PANELEM, a nie tabem. Bramka „czy to nasz panel" (token
   * `rarog-term` ze świeżego `pane.list`) stoi po stronie wołającego — `term/herdr-backend.ts`
   * — bo tylko on wie, co jest terminalem Raroga.
   */
  closePane(paneId: string): Promise<void>;
  /** Sonda gotowości w trakcie startu — patrz {@link HerdrLaunchProbeInfo}. */
  probeAgent(paneId: string): Promise<HerdrLaunchProbeInfo>;
}

/**
 * Odczyt `agent.get` w trakcie STARTU — świadomie NIE `HerdrAgentInfo`.
 *
 * `getAgent()` rzuca `HerdrGoneError`, gdy `agent_session` nie jest jeszcze identyfikatorem —
 * a herdr wypełnia to pole dopiero ~2 s po `agent.start` (zmierzone). Sonda
 * zbudowana na `getAgent()` zgłaszałaby więc „agent zniknął" przy KAŻDYM starcie, w pierwszej
 * sekundzie. Tu pusty `agentSessionId` znaczy „herdr jeszcze nie wie", a nie „nie ma agenta";
 * prawdziwe zniknięcie (`agent_not_found`) dalej leci jako `HerdrGoneError`.
 */
export interface HerdrLaunchProbeInfo {
  /** `agent_session.value`; pusty string, dopóki herdr nie zna sesji. */
  agentSessionId: string;
  status: HerdrAgentStatus;
  /**
   * `interactive_ready`; `null` = pola NIE MA. Od herdr 0.9.0 brak pola
   * ma dwa znaczenia — rekord startu trwa (`launchPending`) albo wygasł i herdr wykrył agenta
   * sam (pole nie wróci nigdy) — więc rozstrzyga launcher, nie sonda. Nigdy nie znaczy `true`.
   */
  interactiveReady: boolean | null;
  /**
   * `launch_pending` (herdr ≥ 0.9.0): `true` od `agent.start` do gotowości; potem pole znika.
   * Opcjonalne, bo starszy herdr i atrapy testowe go nie znają — nieobecne = `false`.
   */
  launchPending?: boolean;
}

// ---------------------------------------------------------------------------
// Błędy
// ---------------------------------------------------------------------------

/**
 * Baza błędów integracji. Osobna hierarchia od błędów managera (`BadRequestError` itd.),
 * bo te opisują „co powiedział herdr", a nie „co Rarog odpowie na HTTP" — tłumaczenie jednego
 * na drugie należy do drivera i routera, i ma być widoczne w kodzie, a nie przypadkowe.
 */
export class HerdrError extends Error {
  readonly code: string = 'herdr-error';
  override readonly name: string = 'HerdrError';
  /**
   * Zdanie błędu: zdanie własne Raroga (`say`) albo tekst obcy (`foreign`: treść herdr, `err.message`
   * z Node, ogon ekranu panelu). Ciało REST (`errorBodyOf` w routerze) czyta wyłącznie to pole; `Error.message` to
   * jego tekst, więc logi i porównania w testach widzą to samo zdanie co dotąd.
   */
  readonly sentence: AnyText;

  constructor(sentence: AnyText, options?: ErrorOptions) {
    super(textOf(sentence), options);
    this.sentence = sentence;
  }
}

/**
 * Zdanie dowolnego wyjątku: `HerdrError` (i każda klasa z polem `sentence`) niesie własne, a reszta (błąd Node,
 * wartość, która nie jest `Error`) wchodzi jako tekst obcy, bo jej treści Rarog nie napisał.
 */
export function sentenceOfError(err: unknown): AnyText {
  if (err instanceof HerdrError) return err.sentence;
  return foreign(err instanceof Error ? err.message : String(err));
}

/**
 * Powód z wyjątku dla zdania zewnętrznego („nie wysłano: {reason}”), gdy powodem może być zdanie własne Raroga:
 * - `code`: wyjątek niesie zdanie z `say()` bez argumentów → podkod argumentu rodzaju `code` (apka go tłumaczy);
 * - `text`: zdanie z `say()` z argumentami albo wyjątek bez zdania własnego (Node, herdr, wartość) → angielski tekst
 *   jako argument `text`. Zdanie zewnętrzne zostaje, bo to ono mówi, co się nie udało (wysyłka, start, restart);
 *   środek po angielsku to świadoma degradacja (podkod z własnymi argumentami = tekst serwera).
 * Pole `sentence` czytamy z każdej klasy błędu (`HerdrError`, błędy managera, `UploadError`, …).
 */
export type ErrorReason =
  | { readonly code: ArglessSentenceCode }
  | { readonly text: string };

export function reasonOfError(err: unknown): ErrorReason {
  const sentence = (err as { sentence?: unknown } | null | undefined)?.sentence;
  if (isServerSentence(sentence)) {
    const code = arglessCodeOf(sentence);
    return code === undefined ? { text: sentence.text } : { code };
  }
  return { text: err instanceof Error ? err.message : String(err) };
}

/**
 * `agent_blocked` — agent stoi na dialogu, prompt NIE został wysłany (herdr 0.8.2).
 * To jest bezpieczne zachowanie i nie wolno go obchodzić ponawianiem: dopisujemy ostrzeżenie
 * pod wiadomością użytkownika i zostawiamy decyzję człowiekowi przy terminalu.
 */
export class HerdrBlockedError extends HerdrError {
  override readonly code = 'herdr-blocked';
  override readonly name = 'HerdrBlockedError';
}

/**
 * Skąd wzięło się rozpoznanie stalla — bo obie drogi znaczą co innego:
 *
 * - `remote-code` — herdr powiedział `agent_prompt_stalled` WPROST. Tylko to jest umową:
 *   „klawisz/prompt poszedł, nie doczekałem się echa z ekranu".
 * - `message` — kod był NIEZNANY, a rozpoznanie wyszło z TREŚCI komunikatu
 *   (`timed out waiting for agent`). Ta gałąź powstała dla `agent.prompt` z `wait` i tam ma
 *   sens; dla wywołań BEZ `wait` (np. `send_keys` przy Esc) jest zgadywaniem po tekście,
 *   więc wołający, który połyka stalla jako sukces, MUSI umieć ją odróżnić.
 */
export type HerdrStallSource = 'remote-code' | 'message';

/**
 * `agent_prompt_stalled` — znaczenie zależy od ŚCIEŻKI wysyłki:
 *
 * - **bez `wait`** (slash-komendy): fałszywy alarm — komenda się wykonała, tylko herdr nie
 *   doczekał się widocznej odpowiedzi. Driver ignoruje; pokazanie błędu zachęcałoby do
 *   wysłania komendy drugi raz.
 * - **z `wait`** (zwykłe prompty): sygnał REALNY — panel nie wszedł w `working`, czyli Enter
 *   najpewniej nie zarejestrował się w TUI i tekst wisi w composerze. Driver sprawdza znaki
 *   życia, potwierdza stall ekranem i ponawia raz (`#promptWithStallGuard`).
 *
 * `stallSource` mówi, KTÓRĄ drogą powstało rozpoznanie (patrz `HerdrStallSource`). Domyślnie
 * `remote-code`, bo tak stawia je kod zdalny; dopasowanie po treści musi to zaznaczyć jawnie.
 */
export class HerdrStalledError extends HerdrError {
  override readonly code = 'herdr-stalled';
  override readonly name = 'HerdrStalledError';
  readonly stallSource: HerdrStallSource;

  constructor(sentence: AnyText, stallSource: HerdrStallSource = 'remote-code') {
    super(sentence);
    this.stallSource = stallSource;
  }
}

/**
 * Panel/agent zniknął (`agent_not_running`, `pane_not_found`, `agent_not_ready`).
 * Dla managera znaczy „ta sesja się skończyła" — w przeciwieństwie do awarii socketu, która
 * znaczy tylko „chwilowo nie widzę".
 */
export class HerdrGoneError extends HerdrError {
  override readonly code = 'herdr-gone';
  override readonly name = 'HerdrGoneError';
}

/**
 * Kanał zapisu zamknięty: `feature_disabled`, `RAROG_HERDR_SEND=0` albo protokół herdr nowszy
 * niż przetestowany. Odczyty działają dalej — fail-open na odczytach utrzymuje wartość Raroga
 * („widzę stan") po każdej aktualizacji herdr, fail-closed na mutacjach nie każe nam zakładać
 * się o cudzy changelog (w 0.8.2 zmieniła się semantyka `agent prompt` bez zmiany protokołu).
 */
export class HerdrReadOnlyError extends HerdrError {
  override readonly code = 'herdr-read-only';
  override readonly name = 'HerdrReadOnlyError';
}

/**
 * Panel spoza `RAROG_HERDR_ROOTS`. Karta istnieje (stan + projekt), ale transkryptu nie ma
 * i wysyłka nie przechodzi — świadomie widoczny, a nie ukryty: panel, który działa i nie jest
 * pokazany, to kolejne UI, które kłamie.
 */
export class HerdrOutOfScopeError extends HerdrError {
  override readonly code = 'herdr-out-of-scope';
  override readonly name = 'HerdrOutOfScopeError';
}

/**
 * Trzy błędy ZAKŁADANIA panelu. Ich `code` to `bad-state` (a nie `herdr-*`), bo w odróżnieniu
 * od reszty tej hierarchii nie opisują „co powiedział herdr", tylko decyzję RAROGA podjętą
 * zanim (albo zamiast) cokolwiek poleciało do gniazda — router mapuje je wprost na 409.
 */

/** Panel nie należy do Raroga; Rarog nie zamyka cudzych paneli, nigdy. */
export class HerdrNotOwnedError extends HerdrError {
  override readonly code = 'bad-state';
  override readonly name = 'HerdrNotOwnedError';
}

/**
 * Katalog nie ma `hasTrustDialogAccepted`.
 *
 * The launcher creates the pane anyway and the warning rides in `trustPrompt`, because the trust
 * dialog is on the closed signature list and can be confirmed from the phone.
 *
 * NOTHING THROWS THIS CLASS TODAY, by design. It stays as a ready fail-closed refusal in case the
 * signature list stops covering the trust dialog. The router does NOT map it to a code
 * (`herdr-untrusted`), so restoring this refusal also means adding that mapping in
 * `createSession` and checking that the client recognises the code.
 */
export class HerdrUntrustedCwdError extends HerdrError {
  override readonly code = 'bad-state';
  override readonly name = 'HerdrUntrustedCwdError';
}

/** `agent.start` przeszedł, ale agent nie stał się gotowy w oknie czasu. */
export class HerdrLaunchTimeoutError extends HerdrError {
  override readonly code = 'bad-state';
  override readonly name = 'HerdrLaunchTimeoutError';
}

/**
 * SUFIT PANELI RAROGA — jedno zdanie na dwie drogi.
 *
 * Copy stoi w warstwie herdr, a nie przy reszcie komunikatów managera, bo mówią je DWA
 * miejsca i muszą mówić dokładnie to samo: `manager.create` (odmowa 409 na siódmy panel)
 * i `supervisor.status().detail` (powód, dla którego klient wygasza „+" i „Nową sesję", ZANIM
 * cokolwiek tapniesz). Manager re-eksportuje tę stałą, więc miejsce importu w testach
 * i routerze zostaje bez zmian.
 *
 * Przy samej pierwszej drodze i pełnym suficie PWA pokazywała własne,
 * ogólne zdanie „zakładanie jest wyłączone" — nieprawdziwe (killswitcha nie ma) i prowadzące
 * donikąd (nie mówi, że wystarczy zamknąć któryś panel). Dokładnie przed tym ostrzegał
 * komentarz przy kolejności sprawdzeń w `manager.create` — tyle że bronił wyłącznie POST-a.
 */
export const HERDR_PANE_CAP_MESSAGE = say('herdr.pane-cap');
