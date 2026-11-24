/**
 * Prawda o tym, jakie agenty `claude` żyją w herdr, w jakim są stanie i trybie.
 *
 * Supervisor NIE ZNA managera, a manager nie zna socketu. Styk to `HerdrSupervisor`
 * (kontrakt z `types.ts`) plus `SessionDriver` zwracany z `attach()`. Dwa strumienie są
 * rozłączne i to jest reguła, a nie szczegół: `events` niesie CYKL ŻYCIA dla managera
 * (kto się pojawił, zniknął, wrócił), a uchwyty niosą zdarzenia JEDNEGO panelu dla drivera.
 *
 * Model subskrypcji (zweryfikowany na żywym serwerze):
 * - `events.subscribe` przyjmuje listę wpisów: globalne (`pane.created`, `pane.closed`,
 *   `pane.exited`, `pane.moved`, `pane.agent_detected`) i per panel
 *   (`pane.agent_status_changed` z `pane_id` — GLOBALNEJ wersji nie ma),
 * - nie ma `events.unsubscribe` ani `events.update`, więc każda zmiana składu paneli to
 *   ZAMKNIĘCIE połączenia i ponowna subskrypcja pełną listą (debounce 500 ms — przy
 *   `herdr update --handoff` leci burza zdarzeń),
 * - ramki wracają z PODKREŚLENIAMI (`pane_exited`), choć subskrybuje się je z KROPKAMI;
 *   normalizacja siedzi w `socket.normalizeEventKind`.
 *
 * Push tylko WYPRZEDZA prawdę — źródłem prawdy jest pełny `agent.list` (start, każdy reconnect,
 * tick co 30 s). Wzorzec z collie: „a missed event costs one interval, never correctness".
 */
import { homedir } from 'node:os';
import { basename } from 'node:path';
import { KNOWN_CONTEXT_LIMITS } from '@rarog/shared';
import type { HerdrMode, HerdrStatus } from '@rarog/shared';
import {
  HERDR_IDLE_GRACE_MS, HERDR_MODE_FRESH_MS, HERDR_RESYNC_MS,
  HERDR_WORKING_GRACE_MS,
  HERDR_TRUST_REEXEC_GRACE_MS,
} from '../config.ts';
import { inWorkAreaOnDisk } from '../config/work-area.ts';
import { type AnyText, isServerSentence, say, textOf } from '@rarog/shared/sentences';
import { AsyncEventQueue, systemScheduler } from '../drivers/runtime.ts';
import type { Scheduler, TimerHandle } from '../drivers/runtime.ts';
import type { SessionDriver } from '../drivers/types.ts';
import { createAnswerRecheck } from './answer-recheck.ts';
import { createHerdrAuditLog } from './audit.ts';
import type { HerdrAuditLog, RestartReason } from './audit.ts';
import { createHerdrClient, createHerdrLaunchClient } from './client.ts';
import { createHiddenStore, sessionIdFor } from './identity.ts';
import type { HiddenStore } from './identity.ts';
import { createSendThrottle } from './commands/index.ts';
import type { SendSlotOptions, SendThrottle } from './commands/index.ts';
import {
  claudePaneLabel, labelTrace, parsePaneLabel, projectKey, realProjectPath, sanitizePaneTitle,
  sanitizeTabLabel,
} from './provenance.ts';
import type { PaneProvenance } from './provenance.ts';
import type { RefusalDumper } from './dialogs/refusals.ts';
import { standingConsentDialog } from './dialogs/index.ts';
import type { ScreenConsentDialogId } from './dialogs/index.ts';
import { collapseFooterMode, parseModeFooter } from './dialogs/screen/mode-footer.ts';
import type { HerdrFooterMode } from './dialogs/screen/mode-footer.ts';
import { HerdrUnavailableError, createHerdrSocket } from './socket.ts';
import type {
  HerdrSocket, HerdrSocketStatus, HerdrStreamEvent, HerdrSubscription, HerdrSubscriptionSpec,
} from './socket.ts';
import {
  HERDR_PANE_CAP_MESSAGE, sentenceOfError, HerdrGoneError, HerdrLaunchTimeoutError, HerdrNotOwnedError,
  HerdrReadOnlyError, isBareShellForeground,
} from './types.ts';
import type {
  HerdrAgent, HerdrAgentHandle, HerdrAgentInfo, HerdrAgentStatus, HerdrClient,
  HerdrLaunchClient,
  HerdrLaunchHandle, HerdrLaunchRegistration, HerdrLaunchRequest, HerdrLaunchResult,
  HerdrLauncher, HerdrLifecycleEvent, HerdrPaneEvent, HerdrPaneInfo,
  HerdrSupervisor, HerdrTabInfo,
} from './types.ts';

/**
 * Launcher nie został wstrzyknięty (np. `RAROG_HERDR_LAUNCH=0` albo wersja bez modułu).
 * Rzucamy zamiast udawać sukces: cicha odmowa zostawiłaby telefon ze spinnerem, a `false`
 * z `canLaunch` i tak nie powinien dopuścić tu żądania.
 */
const LAUNCH_NOT_WIRED = say('herdr.launch-off-panels');

/**
 * Odmowa `closeTab` na panelu Codexa — bliźniaczka `HERDR_CODEX_CLOSE_MESSAGE`
 * z managera: ten sam kod zdania z rejestru, bez importu z warstwy sesji (nadzorca importuje
 * z niej wyłącznie typy i ta zależność miałaby iść w drugą stronę).
 */
const CODEX_CLOSE_MESSAGE = say('session.codex-close');

/** Odmowa operacji na kluczu, którego nadzorca nie zna (panel zniknął z herdr). */
const agentGone = (key: string): HerdrGoneError => new HerdrGoneError(say('herdr.agent-gone', { key }));

/**
 * Ile czekamy na `attach()` po zarejestrowaniu świeżo założonego panelu.
 *
 * Po tym czasie panel wraca do normalnego cyklu życia jako `appeared` — bo skoro manager go
 * nie podpiął (awaria w trakcie startu), to nikt nim się nie opiekuje, a panel ŻYJE i musi
 * być widoczny na liście. Reguła 11.9: nic, co Rarog stworzył, nie zostaje po cichu.
 */
export const LAUNCH_ADOPT_TIMEOUT_MS = 30_000;

/*
 * Resync i karencja są zapisane w `config.ts` razem z resztą liczb-bezpieczników integracji
 * (jedno źródło); tutaj tylko re-eksport, żeby import `herdr/index.ts` dalej działał.
 */
export {
  HERDR_IDLE_GRACE_MS, HERDR_RESYNC_MS, HERDR_TRUST_REEXEC_GRACE_MS, HERDR_WORKING_GRACE_MS,
};

/** Debounce ponownej subskrypcji — burza zdarzeń ma dać JEDNO re-subscribe, nie N. */
export const RESUBSCRIBE_DEBOUNCE_MS = 500;

/** Najczęstszy odczyt stopki trybu dla jednego panelu przy zmianach statusu. */
export const MODE_READ_MIN_INTERVAL_MS = 10_000;

/**
 * Debounce synchronizacji etykiety taba z kartą, osobno dla każdego klucza.
 *
 * Etykieta karty zmienia się seriami: auto-tytuł konwersacji potrafi przeskoczyć kilka razy
 * w ciągu sekundy, a start Raroga ogłasza naraz wszystkie panele. Każda zmiana etykiety taba to
 * `tab.rename` i zapis snapshotu herdr — więc liczy się OSTATNIA etykieta z okna, nie każda.
 */
export const TAB_LABEL_DEBOUNCE_MS = 2_000;

/**
 * Odstęp ponowień niedokończonej synchronizacji etykiety taba: pierwsze
 * przy najbliższym udanym resyncu, drugie po tym minimum, każde kolejne dwa razy później — do
 * sufitu. Przeszkoda przejściowa (herdr chwilowo niedostępny, zgubiona odpowiedź) nie gubi zmiany
 * etykiety, a uporczywa nie robi z nadzorcy pompy odczytów.
 */
export const TAB_LABEL_RETRY_MIN_MS = 30_000;
export const TAB_LABEL_RETRY_MAX_MS = 30 * 60_000;

/** Globalne wpisy subskrypcji — wszystko, co zmienia SKŁAD paneli. */
const GLOBAL_SUBSCRIPTIONS: readonly HerdrSubscriptionSpec[] = [
  { type: 'pane.created' },
  { type: 'pane.closed' },
  { type: 'pane.exited' },
  { type: 'pane.moved' },
  { type: 'pane.agent_detected' },
];

/** Zdarzenia, po których pytamy o pełną listę (skład paneli mógł się zmienić). */
const COMPOSITION_EVENTS: ReadonlySet<string> = new Set([
  'pane_created', 'pane_closed', 'pane_exited', 'pane_moved', 'pane_agent_detected',
]);

/** `pane.updated` (firehose ~10 ramek/s) świadomie NIE jest subskrybowane. */
const STATUS_EVENT = 'pane_agent_status_changed';

// ---------------------------------------------------------------------------
// Konfiguracja i zależności
// ---------------------------------------------------------------------------

export interface HerdrSupervisorConfig {
  socketPath: string;
  /** `RAROG_HERDR_ROOTS` — panele spoza obszaru pracy tych korzeni dostają `inScope: false`. */
  roots: readonly string[];
  /** Home directory for the work area's protected folders; tests pass their own. */
  home?: string;
  /** `RAROG_YOLO_ROOTS` — wysyłka do panelu w trybie `bypass` tylko tutaj. */
  yoloRoots: readonly string[];
  /** `RAROG_HERDR_SEND` — `false` blokuje wszystkie mutacje na poziomie socketu. */
  sendEnabled: boolean;
  /** `RAROG_HERDR_LAUNCH` — `false` znaczy `canLaunch: false` i brak launchera. */
  launchEnabled?: boolean;
  /**
   * `RAROG_CODEX_STATUS` — czy panele Codexa wchodzą jako wpisy STANU.
   *
   * Nadzorca sam z tego pola nie korzysta: przekazuje je fasadzie gniazda, bo to tam stoi filtr
   * wejściowy. Stoi w JEGO konfiguracji, bo to nadzorca składa klienta, gdy wołający nie podał
   * własnego (testy podają atrapę i wtedy flaga nie ma czego filtrować).
   */
  codexStatusEnabled?: boolean;
  /** `RAROG_MAX_PANES` — sufit ŻYWYCH paneli Raroga; po jego osiągnięciu `canLaunch` gaśnie. */
  maxPanes?: number;
  /**
   * `RAROG_HERDR_TAB_LABELS` — czy `syncTabLabel` w ogóle cokolwiek robi. Nieobecne =
   * włączone (domyślne `config.ts`); `false` = etykiety tabów zostają takie, jakie dostały przy
   * zakładaniu, i nie ma migracji starych etykiet tabów Claude. PREFERENCJA, nie killswitch:
   * `RAROG_HERDR_SEND=0` gasi obie mutacje (`tab.rename`, `pane.rename`) niezależnie od niej.
   */
  tabLabels?: boolean;
  /** `config.dataDir` — audit log i lista ukrytych. */
  dataDir: string;
  now?: () => number;
  logger?: (message: string) => void;
}

/** Wszystko, czego driver przypięty do panelu potrzebuje od supervisora. */
export interface HerdrAttachContext {
  handle: HerdrAgentHandle;
  client: HerdrClient;
  audit: HerdrAuditLog;
  /**
   * Deterministyczny `sessionId` Raroga dla tego agenta (`sessionIdFor(key)`).
   *
   * Driver dostaje go tu, a nie od managera, bo jest wyliczalny z klucza i nie zależy od
   * kolejności składania zależności — dziennik wysyłek ma być kompletny od pierwszej wysyłki.
   */
  sessionId: string;
  /** Start karencji `idle` (patrz {@link HERDR_IDLE_GRACE_MS}) — driver woła po `prompt`. */
  markSent(): void;
  /**
   * WYMUSZONY odczyt stopki trybu — pętla `setMode` drivera po każdym `shift+tab`.
   * Wynik TEGO odczytu, dokładny (`acceptEdits` osobno): `unknown`, gdy stopki nie widać.
   * Wpis nadzorcy i chip idą zwykłą drogą (`readMode` → zdarzenie `mode` → driver).
   */
  refreshMode(): Promise<HerdrFooterMode>;
  /**
   * „W tym panelu stoi dialog ZAUFANIA KATALOGU" — driver woła przy jego rozpoznaniu
   * i przy decyzji.
   *
   * Uzbraja karencję ZNIKNIĘCIA ({@link HERDR_TRUST_REEXEC_GRACE_MS}): po zatwierdzeniu
   * zaufania `claude` re-eksekuuje się i na moment znika z `agent.list`. Bez tej wiedzy
   * nadzorca ogłaszał `gone`, a karta sesji zamykała się sekundę przed powrotem panelu.
   */
  markTrustDialog(): void;
  yoloRoots: readonly string[];
  sendEnabled: boolean;
  /**
   * Okno kontekstu potwierdzone flagą `--model`, którą podał sam RAROG.
   *
   * Nieobecne dla paneli z terminala i dla sesji bez flagi modelu — i to jest poprawne:
   * identyfikator modelu w jsonl okna nie rozstrzyga (dowód w `jsonl-usage.ts`), więc zgadywanie pokazywałoby
   * 92 % przy 185k, a po kompaktowaniu skok na 18 %. Zamiast tego: liczba bez procentu.
   */
  knownContextLimit?: number;
}

/**
 * Fabryka drivera przypiętego do panelu.
 *
 * Wstrzykiwana, a nie importowana wprost: `drivers/herdr-driver.ts` powstaje równolegle
 * w innym strumieniu pracy, a supervisor nie ma prawa od niego zależeć (i odwrotnie — driver
 * testuje się z fake'owym uchwytem, bez supervisora).
 */
export type HerdrDriverFactory = (ctx: HerdrAttachContext) => SessionDriver;

/**
 * Wszystko, co launcher dostaje OD supervisora — reszta zależności (zaufanie katalogu,
 * `envClear`) przychodzi z entry, bo to konfiguracja procesu, a nie stan integracji.
 *
 * Supervisor jest właścicielem tożsamości agentów, więc `key` nadaje wyłącznie on: launcher
 * dostaje go z `registerLaunch` i oddaje w `HerdrLaunchHandle`, zamiast wymyślać własny.
 */
export interface HerdrLauncherSeam {
  client: HerdrLaunchClient;
  registerLaunch(reg: HerdrLaunchRegistration): string;
  /**
   * Launcher skończył krok etykiety pochodzenia panelu — od tej chwili synchronizacja
   * etykiety taba z kartą tego klucza może ruszyć (patrz `syncTabLabel`).
   */
  paneLabelled(key: string): void;
  readScreen(paneId: string): Promise<string>;
  logger(message: string): void;
}

/** Transport zdarzeń — implementuje go `socket.ts`, a w testach fake. */
export interface HerdrTransport {
  subscribe(subs: readonly HerdrSubscriptionSpec[]): HerdrSubscription;
  status(): HerdrSocketStatus;
  dispose(): void;
}

export interface HerdrSupervisorDeps {
  createDriver: HerdrDriverFactory;
  client?: HerdrClient;
  transport?: HerdrTransport;
  scheduler?: Scheduler;
  audit?: HerdrAuditLog;
  hidden?: HiddenStore;
  throttle?: SendThrottle;
  /**
   * Zrzut diagnostyczny odmowy „nie znam trybu". Bramka wysyłki odmawia, gdy odczyt
   * NA ŻĄDANIE nie znalazł stopki — a co ją zasłaniało, wie tylko ekran z tamtej sekundy (tego
   * dnia: nieznany Rarogowi dialog CLI przy `--resume`). Zwykłe odczyty (resync, push) NIE
   * zrzucają: nakładka na ekranie to stan normalny, odmowa człowiekowi już nie.
   */
  dumpRefusal?: RefusalDumper;
  /**
   * Wersja programu herdr z walidowanego `ping` (`client.ping`, schemat odpowiedzi), po pierwszym resyncu i na każdym
   * ticku resyncu ({@link HERDR_RESYNC_MS}). Bramka protokołu gniazda czyta `ping` tylko przy (re)connectcie, a `herdr
   * update --handoff` zmienia program pod tym samym gniazdem — stąd osobny odczyt. Odbiorca: obserwator wersji
   * (`version-watch.ts`). Brak pola = żadnego dodatkowego `ping`. Błąd `ping` = brak odczytu, tik idzie dalej.
   */
  onVersion?: (version: string) => void;
  /**
   * An agent joined or left the supervisor's set, or a pane changed its engine session id (`/clear`, `/resume`) or its
   * scope, so {@link HerdrSupervisor.observedEngineSessions} may have changed. Called synchronously inside the resync;
   * the receiver must not throw and defers its own work. Receiver: the `alive.json` writer
   * (`bootstrap/alive-sessions.ts`), which publishes a new session at once.
   */
  onAgentsChanged?: () => void;
  /**
   * Procedura zakładania panelu (`herdr/launcher.ts`).
   *
   * Wstrzykiwana, a nie importowana wprost, z tego samego powodu co `createDriver`: launcher
   * powstaje w innym strumieniu pracy, a supervisor nie ma prawa od niego zależeć. Brak
   * launchera znaczy „kanał tworzenia zamknięty" — `canLaunch` jest wtedy `false`, a `launch()`
   * rzuca zamiast udawać.
   */
  launcher?: HerdrLauncher;
  /**
   * Fabryka launchera dostająca gotową fasadę kanału tworzenia.
   *
   * Wygodniejsza od `launcher` wszędzie tam, gdzie launcher potrzebuje `HerdrLaunchClient`:
   * supervisor buduje go NA SWOIM gnieździe, więc nie powstaje drugie połączenie z własną
   * bramką protokołu (a przy dwóch bramkach `readOnly` mogłoby znaczyć co innego po każdej
   * ze stron). Wołana raz, przy składaniu supervisora.
   */
  createLauncher?: (deps: HerdrLauncherSeam) => HerdrLauncher;
  /**
   * Fasada metod tworzących (`tab.close`, `pane.list`, `pane.process_info`, `tab.get`,
   * `tab.rename`, `pane.rename`).
   *
   * Supervisor używa jej WYŁĄCZNIE do rzeczy, których launcher nie zrobi za niego: zamknięcia
   * taba („×" i stary tab po restarcie sesji), inwentarza paneli przy sprzątaniu sierot
   * oraz etykiety taba idącej za etykietą karty (`syncTabLabel` — ze śladem
   * w etykiecie panelu i migracją starych paneli Claude). Tokenów nie stempluje.
   */
  launchClient?: HerdrLaunchClient;
}

/**
 * Supervisor + rzeczy, które manager musi dostać razem z nim.
 *
 * `ready` jest tu, bo `createHerdrSupervisor` jest synchroniczne, a pierwszy pełny resync nie —
 * bez tego test (i start Raroga) nie mają czego się uchwycić. Reszta pól to współdzielony stan,
 * którego nie ma sensu tworzyć drugi raz po stronie managera.
 */
export interface HerdrSupervisorHandle extends HerdrSupervisor {
  /** Spełnia się po pierwszym pełnym resyncu (albo po jego nieudanej próbie). */
  readonly ready: Promise<void>;
  /** Lista ukrytych paneli — `close()` sesji herdr dopisuje tu klucz. */
  readonly hidden: HiddenStore;
  /** Throttle wysyłek: manager woła PRZED `turn-start`, `false` → 429. */
  takeSendSlot(key: string, opts?: SendSlotOptions): boolean;
  /**
   * Żywy `ping` gniazda herdr — sonda `/health`. Nigdy nie rzuca: awaria transportu
   * znaczy `false`, a udany ping przy okazji kasuje flagę niedostępności socketu (gated).
   */
  ping(): Promise<boolean>;
  /** Dziennik wysyłek — do domknięcia przy `dispose()` procesu. */
  readonly audit: HerdrAuditLog;
}

// ---------------------------------------------------------------------------
// Stan wewnętrzny
// ---------------------------------------------------------------------------

interface AgentEntry {
  /** Migawka aktualizowana W MIEJSCU — driver trzyma referencję i czyta z niej `paneId`. */
  readonly agent: HerdrAgent;
  readonly listeners: Set<(ev: HerdrPaneEvent) => void>;
  /** Ostatni ZASTOSOWANY `state_change_seq` — strażnik kolejności. */
  appliedSeq: number;
  lastModeReadAt: number;
  /** Czas ostatniego `markSent` — początek karencji `idle`. */
  sentAt: number;
  /**
   * Kiedy driver ostatnio widział w tym panelu dialog ZAUFANIA KATALOGU; `0` = nigdy.
   *
   * Jedyne zastosowanie: karencja zniknięcia. Zaufanie zatwierdzone gdziekolwiek (telefon albo
   * terminal) re-eksekuuje `claude`, a re-eksekucja wygląda z zewnątrz dokładnie jak zamknięcie
   * panelu — z tą różnicą, że kończy się powrotem tego samego `pane_id` i `agent_session`.
   */
  trustSeenAt: number;
  /** Dialog zgody CLI widziany przy ostatnim odczyte ekranu; zdarzenie leci na ZMIANĘ. */
  consentDialog: ScreenConsentDialogId | null;
  /** Czy manager ma podpięty driver (tylko wtedy `re-attached` ma sens). */
  attached: boolean;
  needsReattach: boolean;
  /**
   * Panel dopiero co założony przez Raroga i jeszcze nie podpięty.
   *
   * Dopóki to trwa, resync i push NIE emitują dla niego `appeared`: manager już wie o tej
   * sesji (dostał `key` z `launch()`), a drugie zdarzenie zrobiłoby DRUGĄ kartę na ten sam
   * panel. Rejestracja gaśnie przy `attach()` albo po {@link LAUNCH_ADOPT_TIMEOUT_MS}.
   */
  launching: boolean;
  /**
   * Panel jest nasz, ale agenta jeszcze NIE MA w `agent.list`.
   *
   * Osobna flaga od `launching`, bo obie gasną w innym momencie: `launching` znika przy
   * `attach()` (manager ma już sesję, więc `appeared` byłby drugą kartą), a ta — dopiero gdy
   * agent naprawdę pojawi się na liście. Rozdzielenie jest konieczne: manager robi `attach()`
   * SYNCHRONICZNIE w `create()`, czyli ~2 s zanim herdr w ogóle zobaczy agenta.
   */
  awaitingAgent: boolean;
  /**
   * Czy ten agent BYŁ KIEDYKOLWIEK widziany w `agent.list`.
   *
   * Panel stojący na dialogu ZAUFANIA nie ma `agent_session` — proces `claude` jeszcze nie
   * wystartował — a `normalizeAgentInfo` odrzuca w całości każdy wpis bez tego pola. Taki panel
   * jest więc dla resyncu STRUKTURALNIE NIEWIDZIALNY: nie „zniknął", tylko nigdy nie mógł się
   * pokazać. Bez tego rozróżnienia `forget('missing')` ogłaszał `gone` panelowi, który stoi
   * żywy z dialogiem na ekranie — sesja szła w `done` + `stale`, a zatwierdzenie z telefonu
   * trafiało już w odpięty driver i ginęło (zmierzone na żywo w `rarog-spike`).
   *
   * Flaga zapala się raz i na zawsze: od pierwszego wpisu w `agent.list` obowiązują normalne
   * reguły znikania, bo od tej chwili brak na liście naprawdę znaczy „nie ma".
   */
  seenInList: boolean;
  /**
   * Czy OSTATNIA informacja z herdr o tym wpisie niosła nazwę agenta Raroga (`rarog-<6 hex>`,
   * czyli `info.launchedByRarog` PRZED unią z `launchedKeys`)
   *
   * Przejście „z nazwą → bez nazwy" jest sygnałem ZASTĄPIENIA procesu w panelu: herdr zdejmuje
   * nazwę razem z agentem, a `/clear` i `/resume` w tym samym procesie ją zachowują. Bez tego
   * ręczny `claude` wpisany po `/exit` bez pustej migawki pomiędzy trafiał w gałąź „znany panel,
   * nowy uuid" i dziedziczył klucz z `launchedKeys`. Wpis launchera
   * startuje z `false`: agent, który pierwszy raz pokaże się BEZ nazwy (wygasły rekord startu),
   * nie ma czego tracić.
   */
  namedByRarog: boolean;
  /**
   * Okno kontekstu POTWIERDZONE flagą `--model`, którą podał sam Rarog.
   *
   * Tylko dla paneli założonych stąd i tylko dla modeli z `KNOWN_CONTEXT_LIMITS`: dla panelu
   * z terminala identyfikator modelu w jsonl okna nie rozstrzyga (`jsonl-usage.ts`), więc limit zostaje
   * NIEZNANY, a widget kontekstu pokazuje liczbę bez procentu (zamiast alarmu bez powodu).
   */
  knownContextLimit?: number;
  /**
   * Pierwsza aktualizacja po powrocie gniazda ma PRZEBIĆ strażnika kolejności.
   *
   * Restart serwera herdr zeruje `state_change_seq` (zmierzone), więc zapamiętany
   * licznik sprzed awarii blokowałby wszystko, dopóki panel nie „dorobi" starego numeru.
   */
  resyncWins: boolean;
  /**
   * Odłożone „panel ruszył" — czeka {@link HERDR_WORKING_GRACE_MS} na potwierdzenie.
   *
   * Trzyma migawkę, którą trzeba będzie zastosować, i uchwyt zegara. Każdy status inny niż
   * `working` natychmiast rozbraja jedno i drugie: agent wrócił do ciszy, więc nie ma czego
   * potwierdzać (patrz `applyInfo`).
   */
  workingInfo: HerdrAgentInfo | null;
  workingTimer: TimerHandle | null;
}

/**
 * Stan synchronizacji etykiety taba z kartą JEDNEGO klucza — wyłącznie RAM.
 *
 * Trwałym śladem „tę etykietę taba nadał Rarog" jest skrót w etykiecie PANELU
 * (`rarog-claude <klucz> <ślad>`), nie ten obiekt: on tylko skleja serię zmian w jedną
 * i pamięta, co ten proces zrobił, żeby zgubiona odpowiedź nie robiła z własnej etykiety ręcznej.
 */
interface TabLabelState {
  /** Ostatnia etykieta karty od managera (surowa — czyści ją `sanitizeTabLabel` przy przebiegu). */
  label: string;
  timer: TimerHandle | null;
  /** Przebieg w locie — kolejny czeka, zamiast iść równolegle na tym samym tabie. */
  running: boolean;
  /** W trakcie przebiegu przyszła nowa etykieta — po nim kolejne odliczenie. */
  again: boolean;
  /**
   * Etykieta, którą TEN proces ostatnio zostawił na tabie jako swoją (`tab.rename` przeszło albo
   * świeży odczyt po zgubionej odpowiedzi ją pokazał). Drugi dowód „to nasze" obok śladu w etykiecie
   * panelu — na wypadek, gdy `pane.rename` z nowym śladem nie przeszło.
   */
  written: string | null;
  /** Etykieta potwierdzona na tabie RAZEM ze śladem — ta sama etykieta drugi raz nie kosztuje RPC. */
  settled: string | null;
  /** Ostatni przebieg skończył się przeszkodą przejściową — ponowienie po udanym resyncu. */
  pending: boolean;
  /** Ile przebiegów z rzędu skończyło się przeszkodą — z tego rośnie odstęp ponowień. */
  failures: number;
  /** `now()`, przed którym ponowienia jeszcze nie ma. */
  retryAt: number;
}

/** Wejście {@link launchDetail} — trzy fakty, z których powstaje zdanie dla człowieka. */
export interface LaunchDetailInput {
  /** What the transport says about itself (missing or too old protocol, lost socket); its sentence wins. */
  transportDetail?: AnyText;
  /** `rarogPanes() >= RAROG_MAX_PANES`. */
  paneCapReached: boolean;
  /** Czy poza sufitem WSZYSTKO pozwala zakładać (launcher, dostępność, kanał zapisu). */
  otherwiseCanLaunch: boolean;
}

/**
 * POWÓD, DLA KTÓREGO RAROG NIE ZAŁOŻY TERAZ SESJI — jako zdanie, nie jako flaga.
 *
 * Klient wygasza „+" i „Nową sesję" na podstawie samego `canLaunch`, a zdanie bierze z `detail`.
 * Gdyby `detail` niósł wyłącznie głos transportu, przy PEŁNYM SUFICIE paneli
 * użytkownik dostawałby zapasowe copy klienta: „zakładanie jest wyłączone" —
 * nieprawdę (killswitcha nie ma) prowadzącą donikąd (nie mówi, że wystarczy zamknąć panel).
 *
 * Dwie zasady, obie wynikają z tego jednego zdarzenia:
 *
 * 1. **The transport wins.** When herdr is silent or its protocol is missing or too old, that is
 *    a bigger truth than the cap, and with herdr unavailable the cap means nothing anyway.
 * 2. **Sufit pokazujemy TYLKO wtedy, gdy jest jedynym powodem.** Przy `RAROG_HERDR_LAUNCH=0`
 *    zdanie „zamknij którąś sesję" byłoby radą, która niczego nie odblokuje: zamknięcie
 *    panelu nie włączy killswitcha. Wtedy `undefined` jest uczciwsze — klient powie własne,
 *    ogólne zdanie o wyłączonym zakładaniu i tym razem będzie to prawda.
 */
export function launchDetail(input: LaunchDetailInput): AnyText | undefined {
  if (input.transportDetail !== undefined) return input.transportDetail;
  if (input.otherwiseCanLaunch && input.paneCapReached) return HERDR_PANE_CAP_MESSAGE;
  return undefined;
}

/** Własne gniazdo jest tworzone tylko wtedy, gdy wołający nie podał obu zależności. */
function requireSocket(socket: HerdrSocket | null): HerdrSocket {
  if (socket === null) {
    throw new Error('herdr: brak transportu — podaj `transport` i `client` albo żaden z nich.');
  }
  return socket;
}

export function createHerdrSupervisor(
  config: HerdrSupervisorConfig,
  deps: HerdrSupervisorDeps,
): HerdrSupervisorHandle {
  const scheduler = deps.scheduler ?? systemScheduler;
  const now = config.now ?? ((): number => Date.now());
  const home = config.home ?? homedir();
  const log = config.logger ?? ((): void => {});

  const socket = deps.transport === undefined || deps.client === undefined
    ? createHerdrSocket({ socketPath: config.socketPath, sendEnabled: config.sendEnabled })
    : null;
  const transport: HerdrTransport = deps.transport ?? requireSocket(socket);
  const client: HerdrClient = deps.client
    ?? createHerdrClient(requireSocket(socket), {
      codexStatus: config.codexStatusEnabled === true,
    });
  /*
   * Kanał TWORZENIA powstaje tylko wtedy, gdy jest z czego: bez własnego gniazda i bez jawnie
   * podanej fasady supervisor nie ma jak (i nie ma prawa) niczego tworzyć — `closeTab`
   * odmawia wtedy zamiast zgadywać.
   */
  const launchClient: HerdrLaunchClient | null = deps.launchClient
    ?? (socket !== null ? createHerdrLaunchClient(socket) : null);
  const maxPanes = config.maxPanes ?? Number.POSITIVE_INFINITY;
  /*
   * Launcher powstaje TYLKO przy jawnym opt-inie (`RAROG_HERDR_LAUNCH=1`). Jego brak to nie
   * jest awaria: to jest domyślny stan Raroga, w którym kanał tworzenia po prostu nie istnieje
   * — `canLaunch` jest wtedy `false`, a `launch()` rzuca zamiast udawać.
   */
  const launcher: HerdrLauncher | undefined = deps.launcher
    ?? (config.launchEnabled === true && deps.createLauncher !== undefined && launchClient !== null
      ? deps.createLauncher({
        client: launchClient,
        /*
         * Rezerwacja panelu i nadanie klucza. Musi być SYNCHRONICZNA i musi nastąpić przed
         * `agent.start` — dopóki żyje, resync i push nie emitują `appeared` dla tego panelu,
         * więc nie powstaje DRUGA sesja Raroga na tym samym adresie.
         *
         * Funkcje zamykają się nad `registerLaunched` i `agents`, które powstają NIŻEJ w tej
         * samej funkcji. To jest bezpieczne, bo fabryka ich tu nie woła — woła je dopiero
         * launcher, w trakcie `launch()`.
         */
        registerLaunch: (reg: HerdrLaunchRegistration): string => {
          const key = registerLaunched(reg, reg.label);
          // Do `paneLabelled` (albo rozstrzygnięcia `ready`) panel nie ma jeszcze etykiety
          // pochodzenia — synchronizacja etykiety taba z kartą czeka.
          provenancePending.add(key);
          return key;
        },
        paneLabelled: (key: string): void => { releaseProvenance(key); },
        /*
         * `detection`, nie `visible`, i to nie jest kosmetyka. Ogon ekranu z launchera wchodzi
         * do treści błędu, a stamtąd do `stateDetail` sesji i po SSE na kartę — czyli jest
         * ZAPISYWANY. `docs/security-model.md` punkt 11 pozwala na to wyłącznie wycinkowi
         * `--source detection`; z `visible` wolno wyprowadzić tylko rozpoznany TRYB ze stopki
         * (tak robi `readMode` niżej), nigdy tekstu. Nic na tym nie tracimy: zmierzone
         * na żywym panelu — oba źródła oddały ten sam ekran co do bajta.
         */
        readScreen: async (paneId: string): Promise<string> => (
          (await client.readScreen(paneId, 'detection')).text
        ),
        logger: log,
      })
      : undefined);
  const audit = deps.audit ?? createHerdrAuditLog({ dataDir: config.dataDir });
  const hidden = deps.hidden ?? createHiddenStore({ dataDir: config.dataDir });
  const throttle = deps.throttle ?? createSendThrottle({ now });

  const lifecycle = new AsyncEventQueue<HerdrLifecycleEvent>();
  const agents = new Map<string, AgentEntry>();
  const byPane = new Map<string, string>();
  const bySession = new Map<string, string>();
  /**
   * Klucze agentów `claude` uruchomionych przez TEN proces Raroga.
   *
   * Drugie źródło własności obok nazwy agenta `rarog-<6 hex>` z odpowiedzi herdr — i jedyne,
   * gdy nazwy brak (rekord startu wygasł, herdr wykrył agenta sam). Wpis żyje TYLE, CO AGENT:
   * `forget` go kasuje, bo `freshKey` oddaje kolejnemu agentowi w tym samym panelu ten sam
   * klucz, a ręczny `claude` po `/exit` nie ma prawa dziedziczyć chipa ani miejsca w suficie.
   * Gdy następca wstaje bez pustej migawki pomiędzy (ten sam wpis, nowy uuid), kasuje go
   * `applyInfo` po utracie nazwy `rarog-*` — patrz `AgentEntry.namedByRarog`.
   * Unia dotyczy wyłącznie silnika `claude` — Rarog nie uruchamia Codexa.
   */
  const launchedKeys = new Set<string>();
  /** `RAROG_HERDR_TAB_LABELS` — brak pola = włączone, jak domyślne w `config.ts`. */
  const tabLabelsEnabled = config.tabLabels !== false;
  /** Synchronizacje etykiet tabów z kartami, po kluczu agenta. */
  const tabLabels = new Map<string, TabLabelState>();
  /**
   * Klucze świeżo założone przez launchera, którym etykieta pochodzenia panelu jeszcze nie
   * powstała (`pane.rename` idzie po `agent.start`). Sync przed nią nie ma dowodu pochodzenia,
   * a migracja starych etykiet nadałaby panelowi etykietę równolegle z launcherem — więc czeka.
   */
  const provenancePending = new Set<string>();
  /** Linie logu synchronizacji etykiet, które już padły — linia raz na proces, nie lawina. */
  const tabLabelLogged = new Set<string>();
  /** `pane.list` w locie — przebiegi kilku kluczy naraz (start Raroga) dzielą jeden odczyt. */
  let panesInFlight: Promise<HerdrPaneInfo[]> | null = null;
  let subscription: HerdrSubscription | null = null;
  let subscribedPanes: string[] = [];
  let resyncTimer: TimerHandle | null = null;
  let refreshTimer: TimerHandle | null = null;
  let disposed = false;
  let unavailable = false;
  /** Status recheck after a dialog answer, so a lost `idle` push does not leave the card standing until the resync. */
  const answerRecheck = createAnswerRecheck({ scheduler, refresh: (paneId) => refreshPane(paneId), log });
  /** The client every driver gets: the same as `client`, with the recheck after each accepted dialog answer. */
  const answerClient = answerRecheck.wrap(client);
  /**
   * Pokolenie rejestru AGENTÓW — bezpiecznik przeciw spóźnionym migawkom: resynce nakładają się (tick, debounce po zdarzeniach, reconnect), a `agent.list`
   * idzie po osobnych gniazdach BEZ gwarancji kolejności odpowiedzi (socket: „zero
   * pipeliningu"). Spóźniona STARSZA migawka bez świeżo odkrytego panelu ogłaszałaby mu
   * `gone` (karta żywej sesji w `closed` na do 30 s), a migawka sprzed `closeTab`
   * wskrzeszałaby zamknięty wpis jako drugą kartę. Rośnie przy każdej zmianie SKŁADU map
   * (`newEntry`, `forget`); `resync` porównuje wartość sprzed i zza awaita `agent.list`
   * i przy rozjeździe odpuszcza CAŁY przebieg — następny obrót pracuje na świeżej parze.
   */
  let agentsEpoch = 0;

  const emitPane = (entry: AgentEntry, ev: HerdrPaneEvent): void => {
    for (const listener of [...entry.listeners]) {
      try {
        listener(ev);
      } catch (err) {
        // Wyjątek jednego drivera nie ma prawa zatrzymać aktualizacji pozostałych 16 paneli.
        log(`herdr: pane listener threw an error: ${(err as Error).message}`);
      }
    }
  };

  const markUnavailable = (reason: AnyText): void => {
    if (unavailable) return;
    unavailable = true;
    // Jedna linia na awarię (strażnik wyżej): bez niej restart herdr nie zostawiał w logu Raroga
    // żadnego śladu, a powód (`events_lost`, EOF, timeout) szedł wyłącznie na baner w PWA.
    log(`herdr: unavailable — ${textOf(reason)}`);
    for (const entry of agents.values()) {
      if (entry.attached) entry.needsReattach = true;
      // Dotyczy WSZYSTKICH wpisów, także nieprzypiętych: licznik zeruje serwer, nie manager.
      entry.resyncWins = true;
    }
    lifecycle.push({ type: 'unavailable', reason });
  };

  /** Ile ŻYWYCH paneli należy do Raroga — sufit `RAROG_MAX_PANES`. */
  const rarogPanes = (): number => [...agents.values()]
    .filter((entry) => entry.agent.launchedByRarog).length;

  /** Własność wpisu: nazwa agenta z herdr ALBO klucz tego procesu — ten drugi tylko dla `claude`. */
  const ownedByRarog = (info: HerdrAgentInfo, key: string): boolean => info.launchedByRarog
    || (info.engine === 'claude' && launchedKeys.has(key));

  const markAvailable = (): void => {
    if (!unavailable) return;
    unavailable = false;
    log('herdr: available again');
    lifecycle.push({ type: 'available' });
  };

  /**
   * Klucz tożsamości = `pane_id` z chwili PIERWSZEGO zobaczenia agenta.
   *
   * Kolizja jest realna, choć rzadka: agent A wyjeżdża z `w9:p72` (`pane move`), a chwilę
   * później herdr tworzy nowy panel pod tym samym adresem. Bez sufiksu nowy agent przejąłby
   * tożsamość — i deep-link — starego.
   */
  const freshKey = (paneId: string): string => {
    if (!agents.has(paneId)) return paneId;
    let n = 1;
    while (agents.has(`${paneId}#${n}`)) n += 1;
    return `${paneId}#${n}`;
  };

  /**
   * Panel zniknął — chyba że go właśnie ZAKŁADAMY.
   *
   * Świeżo zarejestrowanego panelu NIE MA w `agent.list` przez pierwsze ~2 s: `agent.start`
   * leci dopiero jeden obrót pętli po `tab.create`, a `agent_session` herdr wypełnia jeszcze
   * później — do tego czasu `normalizeAgentInfo` odrzuca wpis w całości (filtr „claude z sesją
   * po id"). Pierwszy resync w tym oknie zobaczyłby więc klucz bez odpowiednika na liście
   * i ogłosił `gone` PANELOWI, KTÓRY DOPIERO WSTAJE.
   *
   * Skutek był widoczny na żywo: sesja szła `starting → done → starting → waiting-input`,
   * a `#finishLaunch` w managerze trafiał na odpięty driver i po cichu GUBIŁ PROMPT STARTOWY
   * — czyli pierwsze zdanie z telefonu nigdy nie docierało do panelu. `launching` chroniło
   * dotąd tylko przed `appeared`; ta sama rejestracja musi chronić przed `gone`.
   *
   * Sierota po awarii managera nie jest tym chroniona: `launching` gaśnie po
   * {@link LAUNCH_ADOPT_TIMEOUT_MS} i panel wraca do normalnego cyklu (reguła 11.9).
   */
  /**
   * Panel zniknął TUŻ PO dialogu zaufania — to re-eksekucja, nie zamknięcie.
   *
   * Zamiast ogłaszać `gone`, wracamy do stanu „czekam na agenta": wpis zostaje w mapach (więc
   * `applyInfo` rozpozna wracający `agent_session` jako TĘ SAMĄ sesję), a po karencji, jeśli
   * nikt nie wrócił, znika normalną drogą. Sesja przypięta dostaje wtedy `re-attached` —
   * po re-eksekucji plik transkryptu bywa NOWY, więc świeże podpięcie jest tu dodatkową
   * wartością, a nie kosztem.
   */
  const holdForTrustReexec = (key: string, entry: AgentEntry): void => {
    entry.awaitingAgent = true;
    if (entry.attached) entry.needsReattach = true;
    log(`herdr: ${entry.agent.paneId} disappeared after the trust dialog — waiting for it to return`);
    scheduler.setTimeout(() => {
      const current = agents.get(key);
      if (current === undefined || !current.awaitingAgent) return;
      // Nie wrócił w oknie karencji: od tej chwili brak agenta znaczy brak agenta.
      current.awaitingAgent = false;
      current.trustSeenAt = 0;
      forget(key);
    }, HERDR_TRUST_REEXEC_GRACE_MS);
  };

  // -------------------------------------------------------------------------
  // Etykieta taba = etykieta karty
  // -------------------------------------------------------------------------

  const logTabLabelOnce = (tag: string, message: string): void => {
    if (tabLabelLogged.has(tag)) return;
    tabLabelLogged.add(tag);
    log(message);
  };

  /** Klucz zniknął — jego synchronizacja i czekanie na etykietę pochodzenia też. */
  const dropTabLabel = (key: string): void => {
    provenancePending.delete(key);
    const state = tabLabels.get(key);
    if (state === undefined) return;
    if (state.timer !== null) scheduler.clearTimeout(state.timer);
    tabLabels.delete(key);
  };

  /** Jeden `pane.list` na wiele przebiegów naraz — tylko sklejenie żądań w locie, bez cache'u. */
  const freshPanes = (client: HerdrLaunchClient): Promise<HerdrPaneInfo[]> => {
    if (panesInFlight !== null) return panesInFlight;
    const pending = client.listPanes();
    panesInFlight = pending;
    const clear = (): void => {
      if (panesInFlight === pending) panesInFlight = null;
    };
    pending.then(clear, clear);
    return pending;
  };

  /**
   * Stara etykieta taba, którą wolno przejąć MIGRACJĄ: to, co nadawał stary launcher
   * (`sanitizePaneTitle(basename(cwd))` — katalog agenta albo panelu, `cd` w powłoce bywa), albo
   * „1" z `workspace.create`. Heurystyka, nie dowód autorstwa: pomyłka to zmiana nazwy taba,
   * w którym stoi agent Raroga (`rarog-*`). Każda inna etykieta zostaje nietknięta.
   */
  const isLegacyClaudeTabLabel = (label: string, cwds: readonly string[]): boolean => {
    if (label === '1') return true;
    return cwds.some((cwd) => {
      const dir = basename(cwd);
      return dir !== '' && label === sanitizePaneTitle(dir, dir);
    });
  };

  /**
   * Jak skończył się przebieg synchronizacji: `done` — stan ostateczny dla tej etykiety (nazwane,
   * ręczne, bez prawa, trwała odmowa bramki); `retry` — przeszkoda przejściowa (herdr niedostępny,
   * błąd odczytu albo zapisu, świeży odczyt przed zapisem nie potwierdził stanu) — ponowienie po
   * udanym resyncu z odstępem; `moved` — wpis zmienił adres w trakcie (`pane move`) — nowy
   * przebieg pod nowym adresem.
   */
  type TabLabelOutcome = 'done' | 'retry' | 'moved';

  /**
   * Odstęp kolejnego ponowienia po przeszkodzie przejściowej: pierwsze przy najbliższym udanym
   * resyncu, potem {@link TAB_LABEL_RETRY_MIN_MS} podwajane do {@link TAB_LABEL_RETRY_MAX_MS}.
   * Trwała odmowa (bramka zapisu) kończy się `done`, więc nie ma pętli.
   */
  const tabLabelRetryDelay = (failures: number): number => (
    failures <= 1 ? 0 : Math.min(TAB_LABEL_RETRY_MIN_MS * 2 ** (failures - 2), TAB_LABEL_RETRY_MAX_MS)
  );

  /**
   * ŚWIEŻY `pane.list` tuż przed zapisem: pod tym adresem nadal stoi panel
   * z oczekiwaną etykietą (`null` = bez etykiety, przy migracji), w tym tabie, i jest w nim SAM.
   * Adresy herdr są pozycyjne, a od odczytu, na którym stoi decyzja, minęły co najmniej `tab.get`
   * i ewentualne zapisy. Bez sklejania z `freshPanes`: odczyt w locie mógł wyjść przed zapisem.
   */
  const confirmPane = async (
    client: HerdrLaunchClient, paneId: string, tabId: string, label: string | null,
  ): Promise<boolean> => {
    let panes: HerdrPaneInfo[];
    try {
      panes = await client.listPanes();
    } catch {
      return false;
    }
    const here = panes.find((candidate) => candidate.paneId === paneId);
    if (here === undefined || here.tabId !== tabId || here.label !== label) return false;
    return panes.filter((candidate) => candidate.tabId === tabId).length === 1;
  };

  /** Odmowa bramki zapisu jest trwała (`done`, jedna linia na proces), każdy inny błąd — `retry`. */
  const writeFailed = (err: unknown, what: string): TabLabelOutcome => {
    if (err instanceof HerdrReadOnlyError) {
      logTabLabelOnce('read-only', `herdr: tab labels without write access — ${err.message}`);
      return 'done';
    }
    log(`herdr: ${what} (${(err as Error).message})`);
    return 'retry';
  };

  /**
   * JEDEN przebieg synchronizacji etykiety taba z kartą.
   *
   * Rarog nazywa tab WYŁĄCZNIE gdy: lokator to agent `claude` (Codex nigdy), tab jest
   * jednopanelowy (`tab.get`, za każdym razem — panel mógł zostać przeniesiony albo tab
   * podzielony), a panel nosi etykietę pochodzenia `rarog-claude <klucz> <ślad>`. Bieżąca etykieta
   * taba jest „Raroga", gdy jej skrót równa się śladowi z etykiety panelu (trwałe — przeżywa
   * restart Raroga i herdr) albo gdy ten proces sam ją tam zostawił (`written`, RAM). Każda inna
   * = nadana ręcznie i NIETKNIĘTA — liczone przy każdym przebiegu od nowa, bez „ręcznej na zawsze".
   *
   * The pane label leads with the tab label (`<tab label> · rarog-claude <key> <trace>`): with
   * Rarog's tab label it carries that label's trace, with a name given by hand it carries that
   * name and the old trace. The pane label it already has = no write.
   *
   * Migracja starych etykiet: panel BEZ ŻADNEJ etykiety (niepusta etykieta spoza wzorców Raroga
   * to nazwa człowieka — blokuje), agent z nazwą `rarog-*` (`namedByRarog`), tab jednopanelowy
   * z etykietą katalogu albo „1" → najpierw etykieta panelu ze śladem BIEŻĄCEJ etykiety taba,
   * potem zwykła ścieżka.
   *
   * ADRES przebiegu (panel i tab wpisu) jest zapamiętany na starcie i sprawdzany po KAŻDYM
   * `await`: `applyInfo` przestawia żywy wpis przy `pane move`, a pod starym adresem staje wtedy
   * cudzy panel. Zmiana adresu = koniec przebiegu i nowy pod nowym adresem. Każdy zapis poprzedza
   * świeży odczyt ({@link confirmPane}).
   */
  const syncTabLabelOnce = async (
    key: string, state: TabLabelState,
  ): Promise<TabLabelOutcome> => {
    const entry = agents.get(key);
    if (entry === undefined) {
      dropTabLabel(key);
      return 'done';
    }
    if (entry.agent.engine !== 'claude' || launchClient === null) return 'done';
    // herdr chwilowo niedostępny — przebieg wraca po udanym resyncu (`retryPendingTabLabels`).
    if (unavailable) return 'retry';
    const client = launchClient;
    /*
     * Kanał zapisu zamknięty (`RAROG_HERDR_SEND=0`): bramka gniazda i tak
     * odbiłaby `tab.rename`, ale bez tego warunku każdy klucz płaciłby odczyty i linię logu.
     * Jedna linia na proces mówi, czemu taby nie idą za kartami.
     */
    if (!config.sendEnabled || transport.status().readOnly) {
      logTabLabelOnce('read-only', 'herdr: tab labels on hold — write channel closed '
        + '(RAROG_HERDR_SEND=0)');
      return 'done';
    }
    // Manager podaje etykietę już po `normalizeSessionLabel`; tu ta sama funkcja (idempotentna)
    // i ten sam fallback co karta panelu zastanego: nazwa katalogu.
    const target = sanitizeTabLabel(state.label, basename(entry.agent.cwd));
    if (state.settled === target) return 'done';

    const paneId = entry.agent.paneId;
    const entryTabId = entry.agent.tabId;
    const interrupted = (): TabLabelOutcome | null => {
      if (disposed || agents.get(key) !== entry) return 'done';
      return entry.agent.paneId !== paneId || entry.agent.tabId !== entryTabId ? 'moved' : null;
    };

    const panes = await freshPanes(client);
    const afterList = interrupted();
    if (afterList !== null) return afterList;
    const pane = panes.find((candidate) => candidate.paneId === paneId);
    // Panel odsiany z listy (zubożony wiersz) albo właśnie znikający — rozstrzygnie resync.
    if (pane === undefined) return 'retry';
    let provenance: PaneProvenance | null = parsePaneLabel(pane.label);
    // Panel terminala Raroga (ktoś odpalił `claude` w powłoce z Raroga): jego tab nazywa terminal.
    if (provenance?.kind === 'term') return 'done';
    if (provenance === null) {
      // Etykieta człowieka (niepusta, spoza wzorców Raroga) — panel cudzy, migracja też nie.
      if (pane.label !== null && pane.label.trim() !== '') return 'done';
      // Bez etykiety jedyną drogą jest migracja — a ta wymaga agenta z nazwą Raroga.
      if (!entry.namedByRarog) return 'done';
    }

    const tab: HerdrTabInfo = await client.getTab(pane.tabId);
    const afterTab = interrupted();
    if (afterTab !== null) return afterTab;

    if (tab.paneCount !== 1) return 'done';

    /*
     * The label every write gate must find on the pane: the one read from `pane.list` in this
     * pass, verbatim (it may carry a leading description), or the one this pass wrote itself.
     * Rebuilding it from key and trace would miss a described label and skip every write.
     */
    let expectedLabel = pane.label;
    if (provenance === null) {
      if (!isLegacyClaudeTabLabel(tab.label, [entry.agent.cwd, pane.cwd])) return 'done';
      const project = projectKey(await realProjectPath(entry.agent.cwd));
      if (!(await confirmPane(client, paneId, tab.tabId, pane.label))) {
        log(`herdr: pane ${paneId} changed before the label migration — skipping`);
        return interrupted() ?? 'retry';
      }
      const beforeMigration = interrupted();
      if (beforeMigration !== null) return beforeMigration;
      const migrated = claudePaneLabel(project, labelTrace(tab.label), tab.label);
      try {
        await client.renamePane(paneId, migrated);
      } catch (err) {
        return writeFailed(err, `label migration of pane ${paneId} failed`);
      }
      log(`herdr: migration — pane ${paneId} got a provenance label (tab ${tab.tabId})`);
      provenance = { kind: 'claude', value: project, trace: labelTrace(tab.label) };
      expectedLabel = migrated;
    }
    const owned = provenance;
    /** Etykieta panelu, którą zapis zastać MUSI — inaczej panel zmienił się pod tym adresem. */
    const ownLabel = expectedLabel;

    /**
     * One `pane.rename` behind a fresh confirmation of the label read in this pass; `null` =
     * written. A timeout is an unknown result: `retry`, and the next pass reads the label anew.
     */
    const writePane = async (label: string, what: string): Promise<TabLabelOutcome | null> => {
      if (!(await confirmPane(client, paneId, tab.tabId, ownLabel))) {
        log(`herdr: pane ${paneId} changed before writing ${what} — skipping`);
        return interrupted() ?? 'retry';
      }
      const beforeWrite = interrupted();
      if (beforeWrite !== null) return beforeWrite;
      try {
        await client.renamePane(paneId, label);
      } catch (err) {
        return writeFailed(err, `failed to write ${what} on pane ${paneId}`);
      }
      return null;
    };

    /** The pane label Rarog's own tab label calls for: the card label first, its trace last. */
    const targetLabel = claudePaneLabel(owned.value, labelTrace(target), target);
    /** Nowy ślad po etykiecie, którą Rarog zostawił na tabie; `settled` tylko po udanym zapisie. */
    const writeTrace = async (): Promise<TabLabelOutcome> => {
      const failed = await writePane(targetLabel, 'the tab label trace');
      if (failed !== null) return failed;
      state.settled = target;
      return 'done';
    };

    if (tab.label === target) {
      // Tab już ma etykietę karty. Rozjechany ślad (zgubione `pane.rename` po udanym
      // `tab.rename`) dopisujemy — inaczej następna zmiana karty wzięłaby własną etykietę
      // za ręczną. A bare label (or another description) gets the card label the same way.
      state.written = target;
      if (ownLabel === targetLabel) {
        state.settled = target;
        return 'done';
      }
      return await writeTrace();
    }
    const ours = labelTrace(tab.label) === owned.trace || tab.label === state.written;
    if (!ours) {
      logTabLabelOnce(`manual|${key}|${tab.tabId}|${labelTrace(tab.label)}`,
        `herdr: tab ${tab.tabId} named by hand — the card label does not overwrite it`);
      /*
       * The tab stays the human's, but the pane label leads with that name, so herdr's Go-to
       * shows it instead of hashes. The trace stays the old one: it proves Rarog's own tab
       * label, and the name given by hand must not pass for Rarog's on the next card change.
       */
      const manual = claudePaneLabel(owned.value, owned.trace, tab.label);
      if (ownLabel === manual) return 'done';
      return await writePane(manual, 'the hand-given tab name') ?? 'done';
    }
    if (!(await confirmPane(client, paneId, tab.tabId, ownLabel))) {
      log(`herdr: pane ${paneId} changed before the label change of tab ${tab.tabId} — skipping`);
      return interrupted() ?? 'retry';
    }
    const beforeRename = interrupted();
    if (beforeRename !== null) return beforeRename;
    try {
      await client.renameTab(tab.tabId, target);
    } catch (err) {
      if (err instanceof HerdrReadOnlyError) return writeFailed(err, '');
      /*
       * Timeout nie mówi, czy `tab.rename` się wykonał (socket.ts). Świeży `tab.get` rozstrzyga:
       * nowa etykieta stoi = sukces z zagubioną odpowiedzią (dopisujemy ślad), inaczej ponowienie.
       * Bez tego własna etykieta po zgubionej odpowiedzi wyglądałaby jak ręczna.
       */
      let after: HerdrTabInfo | null = null;
      try {
        after = await client.getTab(tab.tabId);
      } catch {
        after = null;
      }
      const afterCheck = interrupted();
      if (afterCheck !== null) return afterCheck;
      if (after?.label !== target) {
        log(`herdr: failed to set the card label on tab ${tab.tabId} (${(err as Error).message})`);
        return 'retry';
      }
    }
    state.written = target;
    log(`herdr: tab ${tab.tabId} got the card label (${key})`);
    return await writeTrace();
  };

  const runTabLabel = async (key: string, state: TabLabelState): Promise<void> => {
    if (disposed || tabLabels.get(key) !== state) return;
    // Launcher jeszcze nie nadał etykiety pochodzenia — `paneLabelled` odliczy od nowa.
    if (provenancePending.has(key)) return;
    if (state.running) {
      state.again = true;
      return;
    }
    state.running = true;
    let outcome: TabLabelOutcome;
    try {
      outcome = await syncTabLabelOnce(key, state);
    } catch (err) {
      log(`herdr: tab label sync failed for ${key} (${(err as Error).message})`);
      outcome = 'retry';
    } finally {
      state.running = false;
    }
    if (disposed || tabLabels.get(key) !== state) return;
    if (outcome === 'retry') {
      // Niedokończony sync NIE ginie: wraca po udanym resyncu, z rosnącym odstępem.
      state.pending = true;
      state.failures += 1;
      state.retryAt = now() + tabLabelRetryDelay(state.failures);
    } else {
      state.pending = false;
      state.failures = 0;
    }
    if (outcome === 'moved' || state.again) {
      state.again = false;
      armTabLabel(key, state);
    }
  };

  const armTabLabel = (key: string, state: TabLabelState): void => {
    if (state.timer !== null) scheduler.clearTimeout(state.timer);
    state.timer = scheduler.setTimeout(() => {
      state.timer = null;
      void runTabLabel(key, state);
    }, TAB_LABEL_DEBOUNCE_MS);
  };

  /**
   * Niedokończone synchronizacje po udanym resyncu: przebieg pominięty
   * przy niedostępnym herdr albo zakończony przeszkodą przejściową NIE ginie, choć manager nie
   * zawoła drugi raz z tym samym tytułem. Każdy wraca, gdy minie jego odstęp.
   */
  const retryPendingTabLabels = (): void => {
    if (disposed) return;
    const at = now();
    for (const [key, state] of tabLabels) {
      if (!state.pending || state.running || state.timer !== null || at < state.retryAt) continue;
      if (provenancePending.has(key)) continue;
      armTabLabel(key, state);
    }
  };


  /** Etykieta pochodzenia gotowa (albo start się rozstrzygnął) — odłożona synchronizacja rusza. */
  const releaseProvenance = (key: string): void => {
    if (!provenancePending.delete(key)) return;
    const state = tabLabels.get(key);
    if (state !== undefined && !disposed) armTabLabel(key, state);
  };

  /**
   * @param reason `'missing'` — brak na `agent.list` (podlega WSZYSTKIM karencjom);
   *   `'closed'` — to MY zamknęliśmy tab (żadna karencja nie ma czego chronić);
   *   `'pane-gone'` — świeży `pane.list` nie zna PANELU tego wpisu, czyli tab naprawdę
   *   zniknął: bramki `blocked && !seenInList` i karencja re-eksekucji ustępują (chronią
   *   przed słabością dowodu z `agent.list`, a tu dowód jest o panel, nie o agenta),
   *   ale okno zakładania zostaje — migawka sprzed `tab.create` nie zna świeżego taba.
   *   `'engine-changed'` — w tym panelu stoi już INNY silnik: wpis nie ma czego opisywać,
   *   a jego następca powstaje w tej samej chwili, więc żadna karencja nie ma tu zastosowania.
   */
  const forget = (
    key: string, reason: 'missing' | 'closed' | 'pane-gone' | 'engine-changed' = 'missing',
  ): void => {
    const entry = agents.get(key);
    if (entry === undefined) return;
    // `'closed'` znaczy „to MY właśnie zamknęliśmy ten tab", `'engine-changed'` — „ten panel
    // jest już czyimś innym". W obu okno zakładania jest zamknięte z definicji i ochrona przed
    // przedwczesnym `gone` nie ma czego chronić.
    if (reason !== 'closed' && reason !== 'engine-changed' && entry.awaitingAgent) return;
    /*
     * Panel STOJĄCY NA DIALOGU, którego agenta `agent.list` nigdy nie pokazał.
     *
     * Dialog zaufania blokuje `claude` ZANIM powstanie `agent_session`, więc filtr wejściowy
     * odrzuca ten panel przy każdym resyncu — a brak na liście nie jest tu dowodem zniknięcia,
     * tylko skutkiem tego, że nie miał jak się na niej znaleźć. Dialog potrafi stać minutami
     * (człowiek decyduje z telefonu), czyli znacznie dłużej niż karencja re-eksekucji.
     *
     * Bez tego warunku sesja szła w `done` + `stale`, driver się odpinał, a „Zatwierdź"
     * z telefonu odpowiadało `ok` i nie robiło NIC — zmierzone na żywo w `rarog-spike`.
     * `'closed'` przechodzi dalej: tab zamknięty przez Raroga znika normalną drogą.
     */
    if (reason === 'missing' && !entry.seenInList && entry.agent.status === 'blocked') return;
    if (
      reason === 'missing'
      && entry.trustSeenAt > 0 && now() - entry.trustSeenAt <= HERDR_TRUST_REEXEC_GRACE_MS
    ) {
      holdForTrustReexec(key, entry);
      return;
    }
    // Odłożone „ruszył" umiera razem z wpisem — zegar bez wpisu nie ma czego zastosować.
    if (entry.workingTimer !== null) {
      scheduler.clearTimeout(entry.workingTimer);
      entry.workingTimer = null;
      entry.workingInfo = null;
    }
    agents.delete(key);
    answerRecheck.cancel(entry.agent.paneId);
    // Własność odchodzi RAZEM z agentem: następca w tym panelu dostanie od `freshKey`
    // ten sam klucz, a jego własność ma wynikać z jego nazwy, nie z RAM po poprzedniku.
    launchedKeys.delete(key);
    // Synchronizacja etykiety taba żyje tyle, co agent: następca pod tym kluczem zaczyna od zera.
    dropTabLabel(key);
    agentsEpoch += 1;
    deps.onAgentsChanged?.();
    if (byPane.get(entry.agent.paneId) === key) byPane.delete(entry.agent.paneId);
    if (bySession.get(entry.agent.agentSessionId) === key) {
      bySession.delete(entry.agent.agentSessionId);
    }
    emitPane(entry, { type: 'gone' });
    entry.listeners.clear();
    lifecycle.push({ type: 'gone', key });
  };

  /**
   * Odczyt stopki trybu. Błąd odczytu ZOSTAWIA poprzedni tryb — zgadywanie byłoby gorsze.
   *
   * @returns wynik TEGO odczytu, dokładny (`acceptEdits` osobno): `unknown` przy błędzie,
   *   panelu Codexa i stopce niewidocznej. Wpis nadzorcy dostaje wartość ZLANĄ (`HerdrMode`).
   *   Zwracana jest wartość własna, a nie stan wpisu, bo dwa odczyty potrafią mieć ten sam
   *   znacznik `now()` — porównanie znaczników nie dowodzi niczego.
   */
  const readMode = async (
    entry: AgentEntry, onUnknown?: (screen: string | null) => void,
  ): Promise<HerdrFooterMode> => {
    /*
     * PANEL CODEXA NIE JEST CZYTANY — bramka stoi TUTAJ, a nie u wołających.
     *
     * `readMode` ma trzy wyzwalacze (nowy agent, tik resyncu, push `pane_agent_status_changed`
     * → `refreshPane`) plus `ensureFreshMode`; bramka w wołających zamknęłaby część z nich
     * i pierwszy nowy wołający otworzyłby dziurę z powrotem. Powody są dwa i oba są twarde:
     * `parseMode` nie zna stopki Codexa, a `standingConsentDialog` na obcym ekranie potrafi
     * rozpoznać fałszywy dialog zgody — czyli sztuczny `blocked` i push o czymś, czego nie ma.
     * A przede wszystkim: to jest ODCZYT TREŚCI cudzego panelu, którego wpis Codexa nie
     * obiecuje. Tryb zostaje `unknown`, więc bramka wysyłki jest fail-closed z definicji.
     */
    if (entry.agent.engine === 'codex') return 'unknown';
    entry.lastModeReadAt = now();
    let exact: HerdrFooterMode;
    let consent: ScreenConsentDialogId | null;
    let screenText: string;
    try {
      const screen = await client.readScreen(entry.agent.paneId, 'visible');
      screenText = screen.text;
      exact = parseModeFooter(screen.text);
      consent = standingConsentDialog(screen.text);
    } catch (err) {
      if (err instanceof HerdrGoneError) return 'unknown';
      log(`herdr: failed to read the mode of ${entry.agent.paneId}: ${(err as Error).message}`);
      onUnknown?.(null);
      return 'unknown';
    }
    const mode = collapseFooterMode(exact);
    /*
     * Dialog zgody CLI sprawdzamy PRZED bramką `unknown`: to on zasłania stopkę trybu,
     * więc za nią nigdy byśmy go nie zobaczyli. Zapamiętany jest sam identyfikator z zamkniętej
     * listy, nigdy tekst ekranu.
     */
    if (consent !== entry.consentDialog) {
      entry.consentDialog = consent;
      emitPane(entry, { type: 'consent-dialog', dialog: consent });
    }
    /*
     * `unknown` znaczy „stopki nie widać" (nakładka `/status`, pełnoekranowy dialog), a nie
     * „tryb się zmienił". Nadpisanie nim znanego trybu kasowałoby chip `bypass` RAZEM
     * z blokadą `RAROG_YOLO_ROOTS` — czyli akurat w chwili, gdy panel coś pokazuje, Rarog
     * przestawałby wiedzieć, komu pisze. Reguła 11.3: nieznane → zostaw poprzednie.
     *
     * `modeReadAt` przesuwamy WYŁĄCZNIE przy odczycie, który tryb POTWIERDZIŁ: to pole jest
     * bramką wysyłki, a „widziałem ekran, ale nie widziałem stopki" nie jest wiedzą
     * o trybie. Nieprzesunięcie znacznika zostawia panel jako nieświeży, czyli fail-closed.
     */
    if (mode === 'unknown') {
      onUnknown?.(screenText);
      return 'unknown';
    }
    entry.agent.modeReadAt = entry.lastModeReadAt;
    if (mode !== entry.agent.mode) {
      entry.agent.mode = mode;
      emitPane(entry, { type: 'mode', mode });
    }
    return exact;
  };

  /** Czy tryb tego panelu był potwierdzony odczytem nie starszym niż `HERDR_MODE_FRESH_MS`? */
  const modeIsFresh = (entry: AgentEntry): boolean => entry.agent.mode !== 'unknown'
    && entry.agent.modeReadAt > 0
    && now() - entry.agent.modeReadAt < HERDR_MODE_FRESH_MS;

  /**
   * ZAKRES wpisu — jedna funkcja dla obu miejsc, w których się go liczy.
   *
   * Codex ma `false` NA SZTYWNO, niezależnie od `RAROG_HERDR_ROOTS`: ścieżka `!inScope`
   * w driverze robi dokładnie „stan bez treści" (bez followera jsonl, bez pulsu, bez odczytu
   * ekranu przy `blocked`), a pliku transkryptu dla Codexa nie ma. Wspólna funkcja jest tu
   * warunkiem poprawności, a nie estetyką: gałąź zmiany `cwd` liczyła zakres wyłącznie
   * z korzeni, więc `cd` pod korzeń włączyłby Codexowi followera pliku, którego nie ma.
   * The roots count as the work area: no hidden entry of a root, no macOS-protected folder of home, as written
   * and on disk, so a link into such a folder or a root that is a symlink to home does not open it. Scope ignores
   * the folder gate: a pane in a guarded folder a root opens stays in scope while the folder is closed.
   */
  const scopeOf = (info: HerdrAgentInfo): boolean => (
    info.engine === 'codex' ? false : inWorkAreaOnDisk(info.cwd, config.roots, home, undefined, { gate: 'ignore' })
  );

  /**
   * Nowy wpis agenta w mapach supervisora.
   *
   * Wspólne dla dwóch dróg, którymi agent trafia do Raroga: odkrycia w `agent.list`
   * i rejestracji świeżo założonego panelu. Jedno miejsce, w którym powstaje `HerdrAgent`,
   * jest warunkiem tego, żeby te dwie drogi nie rozjechały się o jedno pole.
   */
  const newEntry = (key: string, info: HerdrAgentInfo): AgentEntry => {
    const agent: HerdrAgent = {
      key,
      paneId: info.paneId,
      tabId: info.tabId,
      agentSessionId: info.agentSessionId,
      engine: info.engine,
      termId: info.termId,
      cwd: info.cwd,
      status: info.status,
      title: info.title,
      stateChangeSeq: info.stateChangeSeq,
      mode: 'unknown',
      modeReadAt: 0,
      inScope: scopeOf(info),
      launchedByRarog: ownedByRarog(info, key),
      interactiveReady: info.interactiveReady,
    };
    const entry: AgentEntry = {
      agent,
      listeners: new Set(),
      appliedSeq: info.stateChangeSeq,
      lastModeReadAt: 0,
      sentAt: 0,
      trustSeenAt: 0,
      consentDialog: null,
      // Wpis z `agent.list` zapala flagę od razu; rejestracja launchera zostaje na `false`,
      // dopóki agent naprawdę nie pokaże się na liście.
      seenInList: false,
      // Rejestracja launchera NIE jest dowodem nazwy — zapala ją dopiero informacja z herdr.
      namedByRarog: false,
      attached: false,
      needsReattach: false,
      resyncWins: false,
      launching: false,
      awaitingAgent: false,
      workingInfo: null,
      workingTimer: null,
    };
    agents.set(key, entry);
    byPane.set(info.paneId, key);
    bySession.set(info.agentSessionId, key);
    agentsEpoch += 1;
    deps.onAgentsChanged?.();
    return entry;
  };

  /**
   * Rejestruje świeżo założony panel, ZANIM zobaczy go `agent.list`.
   *
   * Bez tego kroku pierwszy resync po `tab.create` zobaczyłby nowy panel jako nieznany
   * i wypchnął `appeared` — czyli DRUGĄ kartę Raroga na ten sam panel (manager ma już sesję,
   * bo dostał `key` z `launch()`). Rejestracja gaśnie przy `attach()`; jeśli nikt nie
   * podepnie się w {@link LAUNCH_ADOPT_TIMEOUT_MS}, panel wraca do normalnego cyklu jako
   * `appeared` — sierota po awarii managera ma być WIDOCZNA, nie ukryta (reguła 11.9).
   */
  const registerLaunched = (reg: HerdrLaunchRegistration, label: string): string => {
    const key = freshKey(reg.paneId);
    launchedKeys.add(key);
    const entry = newEntry(key, {
      paneId: reg.paneId,
      tabId: reg.tabId,
      agentSessionId: reg.agentSessionId,
      // Launcher zakłada WYŁĄCZNIE panele Claude (`agent.start(kind: 'claude')`) — Codex
      // z klienta jest poza zakresem. Panel launchera nie jest terminalem Raroga (własny tab
      // z etykietą `rarog-claude`), więc tokenu terminala nie ma.
      engine: 'claude',
      termId: null,
      cwd: reg.cwd,
      // `unknown`, a nie `idle`: panel istnieje, ale agent w nim jeszcze nie wstał, więc
      // każdy inny status byłby zgadywaniem (reguła 11.3).
      status: 'unknown',
      title: label,
      stateChangeSeq: 0,
      launchedByRarog: true,
      // Do `interactive_ready` wysyłka zwróciłaby `agent_not_ready` — manager i tak czeka
      // z promptem startowym na `handle.ready`.
      interactiveReady: false,
    });
    entry.launching = true;
    entry.awaitingAgent = true;
    // The new pane joins the event subscription now: otherwise its pushes (the `idle` after the trust dialog answer)
    // would be lost until a composition event or the resync tick renews the subscription.
    resubscribeIfNeeded();
    scheduler.setTimeout(() => {
      const current = agents.get(key);
      if (current === undefined) return;
      /*
       * Koniec okna „zakładam". Od tej chwili brak agenta na liście znaczy brak agenta —
       * inaczej panel, w którym `claude` nigdy nie wstał, wisiałby w Rarogu bez końca jako
       * sesja, której nie da się ani ruszyć, ani zamknąć.
       */
      current.awaitingAgent = false;
      if (!current.launching) return;
      current.launching = false;
      lifecycle.push({ type: 'appeared', agent: current.agent });
    }, LAUNCH_ADOPT_TIMEOUT_MS);
    return key;
  };

  interface ApplyOutcome {
    key: string;
    /** Odczyt trybu do domknięcia przez wołającego (równolegle dla wszystkich paneli). */
    modeRead?: Promise<HerdrFooterMode>;
  }

  /**
   * Jedna aktualizacja stanu panelu — WSPÓLNA ścieżka dla resyncu i dla pushu.
   *
   * Push (`pane.agent_status_changed`) nie niesie ani `agent_session`, ani `state_change_seq`,
   * więc driver i tak musi zapytać `agent.get` (0,2 ms). Dzięki temu istnieje dokładnie jedno
   * miejsce, w którym rozstrzyga się tożsamość, kolejność i karencja — a nie dwa, które muszą
   * się zgadzać.
   */
  /** Czy ten status znaczy „panel stoi"? Tylko z takiego wejście w pracę podlega karencji. */
  const quietNow = (status: HerdrAgentStatus): boolean => status === 'idle' || status === 'done';

  /**
   * @param opts.reconcile wywołanie z PEŁNEGO resyncu — status jedzie do drivera także wtedy,
   *   gdy nadzorca nie widzi u siebie zmiany (patrz komentarz przy emisji niżej)
   */
  const applyInfo = (
    info: HerdrAgentInfo,
    opts: { forceModeRead: boolean; reconcile?: boolean; confirmWorking?: boolean },
  ): ApplyOutcome => {
    const at = now();
    /*
     * ZMIANA SILNIKA W PANELU = koniec jednej sesji i początek drugiej, nigdy mutacja
     * wpisu.
     *
     * Człowiek wychodzi z `claude` i odpala w tym samym panelu `codex` (albo odwrotnie).
     * Przepięcie uuid w miejscu zostawiłoby kartę z prawami POPRZEDNIKA: wpis Codexa
     * z `inScope` po korzeniach, podpiętym followerem jsonl i composerem, albo sesję Claude
     * bez transkryptu. Zdejmujemy więc oba wpisy wskazywane przez indeksy (uuid i panel mogą
     * pokazywać na różne) i pozwalamy gałęzi „3. Nowy agent" zbudować wpis od zera — manager
     * dostaje `gone` + `appeared`, czyli jedyną parę zdarzeń, którą umie obsłużyć bez domysłów.
     */
    const staleEngines: [string, AgentEntry][] = [];
    for (const stale of [bySession.get(info.agentSessionId), byPane.get(info.paneId)]) {
      if (stale === undefined || staleEngines.some(([key]) => key === stale)) continue;
      const prior = agents.get(stale);
      if (prior === undefined || prior.agent.engine === info.engine) continue;
      staleEngines.push([stale, prior]);
    }
    /*
     * STRAŻNIK KOLEJNOŚCI MUSI ZADZIAŁAĆ PRZED `forget`.
     *
     * `refreshPane` waits on `agent.get`, and meanwhile a resync can find a SECOND engine in
     * the same pane and rebuild the entry. A late answer about the previous engine would then
     * hit the "engine changed" branch, delete the FRESH entry and build a new one, and the guard
     * below (`info.stateChangeSeq < entry.appliedSeq`) would have nothing left to defend, because
     * the entry was replaced. Result: a Claude entry with `inScope: true` on a pane where Codex
     * actually sits, and `readMode` → `readScreen` over its screen — exactly the boundary that
     * Codex panes must never cross.
     *
     * The condition is CHARACTER FOR CHARACTER the one in the guard below, including the
     * `resyncWins` exception (a herdr server restart resets `state_change_seq`, so a full resync
     * is then the source of truth). Outside that exception an older snapshot loses on every
     * channel, resync included: this branch deletes and creates entries, so a mistake costs more
     * than at the `status` field guard, and a late list comes back on the next turn anyway.
     */
    for (const [stale, prior] of staleEngines) {
      if (info.stateChangeSeq < prior.appliedSeq && !prior.resyncWins) {
        log(`herdr: dropped a late update for ${info.paneId} (seq ${info.stateChangeSeq}, `
          + `engine ${info.engine} vs ${prior.agent.engine})`);
        return { key: stale };
      }
    }
    for (const [stale] of staleEngines) {
      log(`herdr: ${info.paneId} changed engine to ${info.engine} — the entry starts over`);
      forget(stale, 'engine-changed');
    }
    let key = bySession.get(info.agentSessionId);
    let entry = key === undefined ? undefined : agents.get(key);
    /*
     * Panel jest FIZYCZNĄ kotwicą tożsamości: jeden panel = jeden agent. Gdy oba indeksy
     * wskazują RÓŻNE wpisy (uuid znany pod innym panelem, a ten panel ma własny wpis),
     * wierzymy panelowi — to `/resume` wpisane w terminalu: panel przełączył się na sesję,
     * którą nadzorca zna skądinąd. Ślepa gałąź „pane move" przepinałaby CUDZY wpis na ten
     * panel, a jego własny wpis zostawałby bez zdarzenia — karta w Rarogu milczałaby mimo
     * zmiany rozmowy w panelu.
     */
    const paneKey = byPane.get(info.paneId);

    if (entry !== undefined && key !== undefined && (paneKey === undefined || paneKey === key)) {
      // 1. Znany `agent_session` → ten sam agent. Zmiana `pane_id` = `pane move`.
      if (entry.agent.paneId !== info.paneId) {
        if (byPane.get(entry.agent.paneId) === key) byPane.delete(entry.agent.paneId);
        entry.agent.paneId = info.paneId;
        byPane.set(info.paneId, key);
        emitPane(entry, { type: 'pane-changed', paneId: info.paneId });
      }
    } else {
      key = paneKey;
      entry = key === undefined ? undefined : agents.get(key);
      if (entry !== undefined && key !== undefined) {
        // 2. Znany `pane_id`, nowy uuid sesji → `/clear` albo `/resume` w tym samym panelu.
        if (entry.agent.agentSessionId !== info.agentSessionId) {
          bySession.delete(entry.agent.agentSessionId);
          entry.agent.agentSessionId = info.agentSessionId;
          // `set` nadpisuje też ewentualny wpis cudzego panelu pod tym uuid (kolizja wyżej):
          // od teraz sesję silnika ma TEN panel; tamten wpis zniknie z listy swoim trybem.
          bySession.set(info.agentSessionId, key);
          deps.onAgentsChanged?.();
          emitPane(entry, { type: 'session-changed', agentSessionId: info.agentSessionId });
        }
      } else {
        // 3. Nowy agent. Flaga „widziany w rejestrze" zapala się TUTAJ, nie w `newEntry`:
        // wpis odkryty przez `applyInfo` z definicji przyszedł z `agent.list`/`agent.get`,
        // a wpis launchera ma zostać na `false` do pierwszego potwierdzenia listą. Bez tej
        // linii wczesny `return` omijał zapalenie niżej i świeżo odkryty panel w `blocked`
        // wpadał pod bramkę `!seenInList` w `forget` — wpis nie do zdjęcia do restartu.
        key = freshKey(info.paneId);
        entry = newEntry(key, info);
        entry.seenInList = true;
        entry.namedByRarog = info.launchedByRarog;
        lifecycle.push({ type: 'appeared', agent: entry.agent });
        return { key, modeRead: readMode(entry) };
      }
    }

    // Agent JEST już na liście — okno „zakładam, jeszcze mnie nie widać" się zamknęło
    // i od tej chwili zniknięcie z `agent.list` znaczy zniknięcie naprawdę.
    entry.awaitingAgent = false;
    entry.seenInList = true;

    // Pola z odpowiedzi herdr, które NIE podlegają strażnikowi kolejności, bo nie są stanem:
    // adres taba (zmienia się przy przenoszeniu panelu), gotowość na wysyłkę i własność.
    entry.agent.tabId = info.tabId;
    entry.agent.interactiveReady = info.interactiveReady;
    // `termId` podąża za migawką z tego samego powodu co `tabId`: token `rarog-term` jest
    // metadaną panelu i pojawia się (albo znika) niezależnie od stanu agenta. Zmiana idzie do
    // managera osobnym zdarzeniem: od `termId` zależy, czy klient pokazuje agenta w terminalu,
    // a restart serwera herdr odtwarza Claude w panelu, ZANIM terminal odzyska token z etykiety.
    // Odłożone potwierdzenie pracy (`confirmWorking`) niesie migawkę sprzed karencji: potwierdza
    // STATUS, a nowszy resync mógł już przynieść token, którego ta migawka nie zna.
    if (opts.confirmWorking !== true && entry.agent.termId !== info.termId) {
      entry.agent.termId = info.termId;
      lifecycle.push({ type: 'term-changed', agent: entry.agent });
    }
    // UNIA dwóch źródeł własności: nazwa agenta z herdr ALBO klucz tego procesu. Nazwy
    // bywa brak (wygasły rekord startu), a `launchedKeys` ginie przy restarcie Raroga — żadne
    // z nich samo nie wystarcza, a fałszywe `false` znaczy tylko brak chipa i miejsca w suficie.
    /*
     * Agent z nazwą Raroga zniknął z tego panelu, a w jego miejscu stoi proces bez nazwy
     * (`/exit` + ręczny `claude` w jednej przerwie między migawkami): klucz z RAM odchodzi
     * tak, jak odszedłby w `forget`. Granica znana i przyjęta: agent Raroga, który nazwy nie
     * miał NIGDY (wygasły rekord startu), po `/clear` wygląda dokładnie jak zastąpiony — nowy
     * uuid, brak nazwy — i bez PID procesu nie da się tych dwóch przypadków rozróżnić. Wtedy
     * własność z RAM zostaje: pomyłka kosztuje chip i miejsce w suficie, zero władzy.
     */
    if (entry.namedByRarog && !info.launchedByRarog) launchedKeys.delete(entry.agent.key);
    entry.namedByRarog = info.launchedByRarog;
    entry.agent.launchedByRarog = ownedByRarog(info, entry.agent.key);

    // `cwd` panelu potrafi się zmienić (`cd` w powłoce pod agentem) — zakres liczymy na nowo.
    if (entry.agent.cwd !== info.cwd) {
      entry.agent.cwd = info.cwd;
      // TA SAMA funkcja co w `newEntry`: bez niej `cd` Codexa pod `RAROG_HERDR_ROOTS`
      // zlecałby reattach z followerem pliku jsonl, którego dla Codexa nie ma.
      const inScope = scopeOf(info);
      /*
       * Zmiana ZAKRESU to zmiana praw karty (transkrypt, wysyłka), a driver kopiuje
       * `inScope` przy podpięciu i decyduje nim o followerze — samo nadpisanie pola
       * w RAM nie zmieniało więc NICZEGO do najbliższego przypadkowego reattachu:
       * panel po `cd` poza `RAROG_HERDR_ROOTS` dalej oddawał transkrypt i przyjmował
       * wysyłkę (reguła 6 `docs/security-model.md`). Reattach jest tą
       * drogą, która przebudowuje driver od zera — z followerem albo bez.
       */
      if (inScope !== entry.agent.inScope) {
        entry.agent.inScope = inScope;
        deps.onAgentsChanged?.();
        if (entry.attached) entry.needsReattach = true;
        log(`herdr: ${entry.agent.paneId} changed scope (inScope=${String(inScope)}) after cd to ${info.cwd}`);
      }
    }

    // Tytuł NIE podlega strażnikowi kolejności: auto-tytuł konwersacji zmienia się w trakcie
    // pracy, bez zmiany stanu, więc `state_change_seq` nie ma o nim nic do powiedzenia.
    let titleChanged = false;
    if (entry.agent.title !== info.title) {
      entry.agent.title = info.title;
      titleChanged = true;
    }

    const inGrace = at - entry.sentAt < HERDR_IDLE_GRACE_MS;
    const quiet = info.status === 'idle' || info.status === 'done';
    /*
     * KARENCJA NA WEJŚCIE W PRACĘ.
     *
     * Agent główny w trakcie workflow drga: rozstawia subagentów, przez moment jest `working`,
     * po czym wraca do czekania. Bez karencji Rarog łapałby te błyski i malował kartę na zielono
     * razem z wyzerowaniem timera — panel wyglądałby na „ciągle pracujący", a herdr obejrzany
     * sekundę później pokazywałby „skończony".
     *
     * Odkładamy WYŁĄCZNIE przejście cisza → `working` i wyłącznie o {@link
     * HERDR_WORKING_GRACE_MS}. Kierunek jest tu wszystkim: opóźnienie sygnału „gotowe"
     * kosztowałoby przy każdej turze, bo to na niego czeka człowiek z telefonem. Powrót do
     * ciszy rozbraja zegar, a jeśli praca się utrzyma, zegar woła `applyInfo` z tą samą
     * migawką i `confirmWorking` — dalej normalną ścieżką, z tym samym strażnikiem kolejności.
     *
     * Karencja obejmuje WYŁĄCZNIE kanał pushowy. Pełny resync jest źródłem prawdy (nagłówek
     * pliku: „push tylko wyprzedza prawdę") — skoro `agent.list` mówi `working`, to panel pracuje
     * teraz, a nie błysnął. Dzięki temu odsiewamy szum, nie opóźniając niczego, co pewne.
     *
     * `blocked` NIE podlega karencji nigdzie: dialog musi być widoczny natychmiast.
     */
    const holdWorking = info.status === 'working' && quietNow(entry.agent.status)
      && opts.confirmWorking !== true && opts.reconcile !== true;
    if (info.status !== 'working' && entry.workingTimer !== null) {
      // Wrócił do ciszy — nie ma czego potwierdzać.
      scheduler.clearTimeout(entry.workingTimer);
      entry.workingTimer = null;
      entry.workingInfo = null;
    }
    let statusChanged = false;
    if (holdWorking) {
      // Zegar zbrojony RAZ: kolejne migawki tej samej pracy tylko odświeżają, co zastosujemy.
      entry.workingInfo = info;
      if (entry.workingTimer === null) {
        entry.workingTimer = scheduler.setTimeout(() => {
          entry.workingTimer = null;
          const pending = entry.workingInfo;
          entry.workingInfo = null;
          if (disposed || pending === null || !agents.has(key)) return;
          void applyInfo(pending, { forceModeRead: false, confirmWorking: true });
        }, HERDR_WORKING_GRACE_MS);
      }
    } else if (inGrace && quiet) {
      // Karencja: NIE zapisujemy `appliedSeq`, żeby ta sama migawka po karencji weszła
      // normalnie (inaczej strażnik kolejności odrzuciłby ją jako „starą").
      log(`herdr: post-send grace period skips ${info.status} for ${info.paneId}`);
    } else if (info.stateChangeSeq < entry.appliedSeq && !entry.resyncWins) {
      // Strażnik kolejności: `agent.list` zwraca migawkę sprzed odpowiedzi, więc resync
      // potrafiłby cofnąć świeższy push i przestawić kartę w inną sekcję listy.
      //
      // Wyjątek `needsReattach`: pierwsza aktualizacja po POWROCIE gniazda pochodzi z pełnego
      // resynca, a restart serwera herdr ZERUJE `state_change_seq` (zmierzone:
      // po `session stop` + `session attach` licznik wraca do 0). Bez tego wyjątku strażnik
      // odrzucałby wszystko, dopóki panel nie „dorobi" starego numeru, czyli Rarog pokazywałby
      // zamrożone stany kart po każdym restarcie herdr. Resync jest źródłem prawdy,
      // więc to on wygrywa — nie zapamiętany licznik sprzed awarii.
      log(`herdr: dropped a late update for ${info.paneId} (seq ${info.stateChangeSeq})`);
    } else {
      entry.resyncWins = false;
      entry.appliedSeq = info.stateChangeSeq;
      entry.agent.stateChangeSeq = info.stateChangeSeq;
      if (entry.agent.status !== info.status) {
        entry.agent.status = info.status;
        statusChanged = true;
      }
    }

    // `unknown` znaczy dokładnie „nie wiem" i NIE MA prawa wywołać przejścia stanu sesji
    // (reguła domyślna 11.3: nigdy nie zgaduj „skończył"). Migawka agenta zostaje prawdziwa,
    // ale driver nie dostaje o tym zdarzenia — sesja trzyma ostatni znany stan.
    const known = entry.agent.status !== 'unknown';
    const meaningful = statusChanged && known;
    /*
     * RESYNC POWTARZA STATUS, nawet gdy nadzorca nie widzi u siebie zmiany.
     *
     * Do tej pory zdarzenie leciało WYŁĄCZNIE przy zmianie `entry.agent.status` — czyli
     * nadzorca milczał zawsze, gdy jego własna migawka się zgadzała. Problem w tym, że stan
     * SESJI potrafi się rozjechać z migawką bez udziału herdr: Rarog ustawia `running`
     * optymistycznie zaraz po wysyłce, a karencja `HERDR_IDLE_GRACE_MS` celowo połyka
     * `idle`/`done` z pierwszych 3 s. Jeśli agent skończył w tym oknie, a nadzorca pamiętał
     * `idle` już wcześniej, to KAŻDY kolejny odczyt jest „bez zmiany" — i manager zostaje
     * z `running` do restartu Raroga.
     *
     * Resync jest źródłem prawdy, więc niech ją POWTARZA. Zdarzenie jest idempotentne:
     * przejście na ten sam stan to tożsamość, a manager rozgłasza `session-changed` tylko
     * wtedy, gdy naprawdę coś się zmieniło — więc powtórka nic nie kosztuje.
     */
    if (meaningful || titleChanged || (opts.reconcile === true && known)) {
      emitPane(entry, {
        type: 'status',
        status: entry.agent.status,
        stateChangeSeq: entry.agent.stateChangeSeq,
        title: entry.agent.title,
      });
    }

    if (entry.needsReattach) {
      entry.needsReattach = false;
      lifecycle.push({ type: 're-attached', agent: entry.agent });
    }

    /*
     * `MODE_READ_MIN_INTERVAL_MS` obowiązuje KAŻDĄ drogę odczytu, także `forceModeRead`.
     *
     * Bez tego resync (jedyny wołający z `forceModeRead`) czytałby ekran KAŻDEGO panelu
     * bezwarunkowo — a resync leci nie tylko z tikiem `HERDR_RESYNC_MS`, ale i z debounce
     * 500 ms po `COMPOSITION_EVENTS`. Burza `pane_created`/`pane_moved` (zakładanie panelu,
     * przenoszenie taba na Macu) dawałaby więc serię pełnych odczytów × liczba paneli w oknie,
     * w którym stopka trybu nie ma prawa się zmienić.
     *
     * Świeżości NIE psuje: przy tiku 30 s odstęp 10 s niczego nie odcina, nowy panel idzie
     * ścieżką „3. Nowy agent" (czyta bezwarunkowo), a bramka wysyłki ma własne `ensureFreshMode`
     * (fail-closed) — więc nawet zaległy odczyt nie przepuści promptu w nieznanym trybie.
     */
    const staleMode = at - entry.lastModeReadAt >= MODE_READ_MIN_INTERVAL_MS;
    /*
     * Panel BEZCZYNNY z podpiętym driverem czytamy też BEZ zmiany statusu: dialog zgody
     * CLI staje po turze i nie zmienia statusu herdr, więc bez tego odczytu telefon dowiadywałby
     * się o nim dopiero przy próbie wysyłki. Koszt: jeden `agent.read` (0,2 ms) na panel
     * na tik resyncu, ograniczony tym samym odstępem co odczyt trybu.
     */
    const idleWatch = entry.attached && entry.agent.status === 'idle';
    if (staleMode && (opts.forceModeRead || statusChanged || idleWatch)) {
      return { key, modeRead: readMode(entry) };
    }
    return { key };
  };

  /**
   * Zdjęcie wpisów, których bramka `blocked && !seenInList` broni przed `agent.list`,
   * gdy świeży `pane.list` dowodzi, że PANELU już nie ma.
   *
   * Bramka w `forget` jest świadomie ślepa na czas (dialog zaufania potrafi stać
   * godzinami), więc panel zamknięty ręcznie W TRAKCIE dialogu zostawał w mapach na
   * zawsze: liczył się do sufitu `RAROG_MAX_PANES` („Nowa sesja" gasła na stałe),
   * a jego martwy `pane_id` jechał w każdej kolejnej subskrypcji. Zegar byłby tu złym
   * lekarstwem (ubijałby też legalny, długo stojący dialog) — dowód istnienia panelu
   * jest precyzyjny: pobieramy luźny inwentarz `pane_id` tylko przy kandydatach.
   */
  const sweepBlockedOrphans = (alive: ReadonlySet<string>): void => {
    for (const [key, entry] of [...agents]) {
      if (entry.seenInList || entry.agent.status !== 'blocked') continue;
      if (alive.has(entry.agent.paneId)) continue;
      forget(key, 'pane-gone');
    }
  };

  /** Czy w mapach siedzi kandydat na sierotę? Bez kandydata nie ma po co pobierać inwentarza. */
  const hasBlockedOrphanCandidates = (): boolean => [...agents.values()]
    .some((entry) => !entry.seenInList && entry.agent.status === 'blocked');

  /** Pełny `agent.list` — źródło prawdy. Push tylko go wyprzedza. */
  const resync = async (): Promise<void> => {
    if (disposed) return;
    const epoch = agentsEpoch;
    let infos: HerdrAgentInfo[];
    try {
      infos = await client.listAgents();
    } catch (err) {
      markUnavailable(sentenceOfError(err));
      return;
    }
    markAvailable();
    /*
     * Skład map zmienił się W TRAKCIE odczytu (równoległy resync coś odkrył, `closeTab`
     * coś zdjął): ta migawka `agent.list` jest starsza od rejestru, więc pętla `forget`
     * ogłosiłaby `gone` wpisowi, którego w migawce jeszcze nie ma, a pętla `applyInfo`
     * wskrzesiła wpis, którego już nie ma. Odpuszczamy CAŁY przebieg (patrz
     * {@link agentsEpoch}) — i zbroimy debounce, żeby świeża para rejestr+lista poszła
     * za ~pół sekundy, a nie dopiero z tickiem za 30 s.
     */
    if (epoch !== agentsEpoch) {
      scheduleRefresh();
      return;
    }

    const seen = new Set<string>();
    const modeReads: Promise<HerdrFooterMode>[] = [];
    for (const info of infos) {
      const outcome = applyInfo(info, { forceModeRead: true, reconcile: true });
      seen.add(outcome.key);
      if (outcome.modeRead !== undefined) modeReads.push(outcome.modeRead);
    }
    for (const key of [...agents.keys()]) {
      if (!seen.has(key)) forget(key);
    }
    // herdr odpowiada, wpisy są świeże — niedokończone synchronizacje etykiet tabów wracają.
    retryPendingTabLabels();
    const epochAfterApply = agentsEpoch;
    /*
     * Sprzątanie sierot na PEŁNYM inwentarzu `pane_id` (`listPaneIds`), nie na liście po
     * filtrze przydatności (`parsePaneList` odsiewa wiersze bez
     * `cwd`/`tab_id`, a wiersz zubożony przez minor herdr to wciąż ISTNIEJĄCY panel —
     * sweep po liście filtrowanej ogłosiłby mu `pane-gone` mimo bramek). Inwentarz pobieramy
     * TYLKO przy kandydatach (zwykle zero — zero dodatkowych RPC) i tylko na stabilnym
     * składzie: wpis dodany w trakcie odczytu mógłby nie zdążyć do migawki. Błąd odczytu
     * = nie sprzątamy wcale (fail-closed w stronę widoczności).
     */
    if (launchClient !== null && epochAfterApply === agentsEpoch && hasBlockedOrphanCandidates()) {
      try {
        const alive = await launchClient.listPaneIds();
        if (epochAfterApply === agentsEpoch) sweepBlockedOrphans(alive);
      } catch (err) {
        log(`herdr: orphan cleanup skipped, \`pane.list\` failed: ${(err as Error).message}`);
      }
    }
    // Odczyty trybu jadą RÓWNOLEGLE (sufit równoległości pilnuje socket), bo szeregowo
    // 17 paneli × timeout to minuty, a nie milisekundy.
    await Promise.allSettled(modeReads);
    resubscribeIfNeeded();
  };

  const desiredSubscriptions = (): HerdrSubscriptionSpec[] => [
    ...GLOBAL_SUBSCRIPTIONS.map((s) => ({ ...s })),
    ...[...agents.values()].map((entry) => ({
      type: 'pane.agent_status_changed',
      pane_id: entry.agent.paneId,
    })),
  ];

  /**
   * @param catchUp a stream renewed on purpose (`resubscribeIfNeeded`) runs one resync at its `connected`: events of
   *   the panes it already covered are lost between closing the old stream and the start of the new one. Bounded:
   *   that resync renews the stream again only when the set of panes changed. The first stream does not need it,
   *   because `ready` runs the first resync right after it opens.
   */
  const openSubscription = (catchUp = false): void => {
    if (disposed) return;
    const subs = desiredSubscriptions();
    subscribedPanes = subs
      .map((s) => s.pane_id)
      .filter((pane): pane is string => pane !== undefined)
      .sort();
    const opened = transport.subscribe(subs);
    subscription = opened;
    void pump(opened, catchUp).catch((err: unknown) => {
      log(`herdr: subscription stream ended with an error: ${(err as Error).message}`);
    });
  };

  /**
   * Ponowna subskrypcja pełną listą — jedyny sposób na zmianę zestawu paneli, bo w API herdr
   * NIE MA `events.unsubscribe` ani `events.update` (sprawdzone w schemacie).
   */
  const resubscribeIfNeeded = (): void => {
    if (disposed) return;
    const panes = [...agents.values()].map((entry) => entry.agent.paneId).sort();
    const same = panes.length === subscribedPanes.length
      && panes.every((p, i) => p === subscribedPanes[i]);
    if (same && subscription !== null) return;
    subscription?.close();
    subscription = null;
    openSubscription(true);
  };

  const scheduleRefresh = (): void => {
    if (disposed || refreshTimer !== null) return;
    refreshTimer = scheduler.setTimeout(() => {
      refreshTimer = null;
      void resync();
    }, RESUBSCRIBE_DEBOUNCE_MS);
  };

  /** Push o zmianie statusu → `agent.get`, bo ramka nie niesie ani sesji, ani `seq`. */
  const refreshPane = async (paneId: string): Promise<void> => {
    const key = byPane.get(paneId);
    if (key === undefined) {
      // Nieznany panel: mógł właśnie dostać agenta. Niech rozstrzygnie pełna lista.
      scheduleRefresh();
      return;
    }
    const entry = agents.get(key);
    // An answer is applied only to the entry it was asked for: after `closeTab`, `forget` or `dispose` during the
    // `agent.get` it would take the "new agent" branch and bring the closed pane back as a second card.
    const stale = (): boolean => disposed || byPane.get(paneId) !== key || agents.get(key) !== entry;
    let info: HerdrAgentInfo;
    try {
      info = await client.getAgent(paneId);
    } catch (err) {
      if (stale()) return;
      if (err instanceof HerdrGoneError) {
        forget(key);
        return;
      }
      if (err instanceof HerdrUnavailableError) {
        markUnavailable(err.sentence);
        return;
      }
      log(`herdr: status refresh for ${paneId} failed: ${(err as Error).message}`);
      return;
    }
    if (stale()) return;
    const outcome = applyInfo(info, { forceModeRead: false });
    if (outcome.modeRead !== undefined) await outcome.modeRead;
  };

  const handleStream = (ev: HerdrStreamEvent): void => {
    if (ev.type === 'connected') {
      if (unavailable) {
        markAvailable();
        void resync();
      }
      return;
    }
    if (ev.type === 'disconnected') {
      markUnavailable(ev.reason);
      return;
    }
    if (ev.kind === STATUS_EVENT) {
      const paneId = ev.data['pane_id'];
      if (typeof paneId === 'string') void refreshPane(paneId);
      return;
    }
    if (COMPOSITION_EVENTS.has(ev.kind)) {
      scheduleRefresh();
    }
  };

  const pump = async (source: HerdrSubscription, catchUp: boolean): Promise<void> => {
    let pending = catchUp;
    for await (const ev of source.events) {
      if (disposed) return;
      // `connected` after unavailability resyncs in `handleStream` already; one resync is enough.
      const resyncNow = pending && ev.type === 'connected' && !unavailable && subscription === source;
      if (ev.type === 'connected') pending = false;
      handleStream(ev);
      if (resyncNow) {
        void resync().catch((err: unknown) => {
          log(`herdr: catch-up resync threw an error — ${(err as Error).message}`);
        });
      }
    }
  };

  /** Wersja programu herdr dla `deps.onVersion` — nigdy nie rzuca; bez odbiorcy nie pyta wcale. */
  const reportVersion = async (): Promise<void> => {
    const onVersion = deps.onVersion;
    if (onVersion === undefined || disposed) return;
    let version: string;
    try {
      ({ version } = await client.ping());
    } catch {
      return;
    }
    if (disposed) return;
    try {
      onVersion(version);
    } catch (err) {
      log(`herdr: version observer threw an error — ${(err as Error).message}`);
    }
  };

  const armResync = (): void => {
    if (disposed) return;
    resyncTimer = scheduler.setTimeout(() => {
      resyncTimer = null;
      // `catch` po `finally`: rzut spoza własnych `catch`ów resyncu (np. `subscribe`
      // z `resubscribeIfNeeded`) przeszedłby przez `finally` do NIEOBSŁUŻONEJ obietnicy,
      // a ta w Node domyślnie wywraca cały proces. Tick i tak jest już uzbrojony. `ping` wersji
      // idzie po uzbrojeniu, więc wolna odpowiedź herdr nie opóźnia następnego ticku.
      void resync().finally(() => {
        armResync();
        void reportVersion();
      }).catch((err: unknown) => {
        log(`herdr: tick resync threw an error — ${(err as Error).message}`);
      });
    }, HERDR_RESYNC_MS);
  };

  openSubscription();
  // `ready` spełnia się TAKŻE po nieudanym pierwszym resyncu: brak herdr to stan „baner
  // niedostępności", a nie awaria startu Raroga (fail-closed, ale bez wywracania procesu).
  // Wersja herdr idzie obok, bez czekania: `ready` nie zależy od `ping`.
  const ready = resync().then(() => {
    void reportVersion();
    armResync();
  }, (err: unknown) => {
    log(`herdr: first resync failed — ${(err as Error).message}`);
    armResync();
  });

  return {
    events: lifecycle,
    ready,
    hidden,
    audit,

    async ping(): Promise<boolean> {
      // Po dispose gniazdo jest zamknięte — pytanie o nie byłoby pytaniem o zwłoki.
      if (disposed) return false;
      try {
        await client.ping();
        return true;
      } catch {
        return false;
      }
    },

    status(): HerdrStatus {
      const raw = transport.status();
      const readOnly = raw.readOnly || !config.sendEnabled;
      /*
       * `canLaunch` goes off for FOUR independent reasons, each a separate power: no opt-in
       * (`RAROG_HERDR_LAUNCH=0`, no launcher), read-only mode (`RAROG_HERDR_SEND=0`, because
       * `agent.start` is in `MUTATING_METHODS`), an unavailable herdr (also a protocol below the
       * tested minimum) and the reached cap of Rarog panes.
       *
       * Rozbite na dwie liczby, bo sufit jako JEDYNY ma dla człowieka wyjście („zamknij
       * którąś sesję") i tylko wtedy wolno je pokazać — patrz `launchDetail`.
       */
      const paneCapReached = rarogPanes() >= maxPanes;
      const otherwiseCanLaunch = launcher !== undefined
        && raw.available
        && !readOnly
        && !disposed;
      const out: HerdrStatus = {
        available: raw.available && !disposed,
        agentCount: agents.size,
        readOnly,
        canLaunch: otherwiseCanLaunch && !paneCapReached,
      };
      if (raw.version !== undefined) out.version = raw.version;
      if (raw.protocol !== undefined) out.protocol = raw.protocol;
      const detail = launchDetail({
        transportDetail: raw.detail,
        paneCapReached,
        otherwiseCanLaunch,
      });
      // Tu zdanie schodzi na drut (`HerdrStatus.detail`): tekst, a zdanie z `say()` także kod obok (`detailRef`).
      if (detail !== undefined) out.detail = textOf(detail);
      if (detail !== undefined && isServerSentence(detail)) out.detailRef = detail.ref;
      return out;
    },

    launchAvailable(): boolean {
      // `canLaunch` BEZ sufitu paneli — restart zastępuje panel, więc sufit liczy sam,
      // a wyłączony launcher schowany za pełnym sufitem odmawiałby dopiero po `/exit`.
      const raw = transport.status();
      return launcher !== undefined && raw.available && !raw.readOnly && config.sendEnabled
        && !disposed;
    },

    async launch(req: HerdrLaunchRequest): Promise<HerdrLaunchHandle> {
      if (launcher === undefined) throw new HerdrLaunchTimeoutError(LAUNCH_NOT_WIRED);
      const handle = await launcher.launch(req);
      /*
       * Klucz nadaje WYŁĄCZNIE supervisor — to on jest właścicielem tożsamości agentów
       * i tylko on wie, czy pod tym adresem panelu żył już kiedyś inny agent (`freshKey`).
       *
       * Prawdziwy launcher robi to przez `registerLaunch` PRZED `agent.start`,
       * więc wpis już tu jest i klucz jest jego. Atrapa w testach oddaje klucz z powietrza —
       * wtedy rejestrujemy tutaj. Jedno i drugie kończy się wpisem w `agents`, nigdy dwoma.
       */
      const key = agents.has(handle.key)
        ? handle.key
        : registerLaunched({ ...handle, cwd: req.cwd, label: req.label ?? '' }, req.label ?? '');
      const limit = req.model === undefined ? undefined : KNOWN_CONTEXT_LIMITS[req.model];
      const launched = agents.get(key);
      if (launched !== undefined && limit !== undefined) launched.knownContextLimit = limit;
      const ready: Promise<HerdrLaunchResult> = handle.ready.then((result) => {
        /*
         * Wpis `launch` jest jedyną odpowiedzią na pytanie „co Rarog uruchomił na tym Macu"
         * (`docs/security-model.md`, „Starting sessions from the phone: three powers”).
         * Zapisujemy go PO gotowości, bo dopiero wtedy znamy `argv` z odpowiedzi
         * herdr — czyli dokładną linię, którą wpisano do powłoki panelu. Promptu tam nie ma.
         */
        audit.log({
          sessionId: sessionIdFor(key),
          key,
          paneId: result.paneId,
          cwd: req.cwd,
          method: 'launch',
          mode: 'unknown',
          tabId: result.tabId,
          argv: result.argv,
        });
        const entry = agents.get(key);
        if (entry !== undefined) {
          // `agent.start` mógł dostać INNY uuid, niż Rarog podał w `--session-id` (launcher
          // to sprawdza i wtedy rzuca) — tu tylko domykamy indeks tym, co naprawdę wyszło.
          if (entry.agent.agentSessionId !== result.agentSessionId) {
            bySession.delete(entry.agent.agentSessionId);
            entry.agent.agentSessionId = result.agentSessionId;
            bySession.set(result.agentSessionId, key);
          }
          entry.agent.interactiveReady = result.interactiveReady;
          /*
           * Status ZAOBSERWOWANY przez launcher — jedyna droga, którą `blocked` dialogu
           * zaufania w ogóle dociera do drivera.
           *
           * Panel stojący na tym dialogu nie ma `agent_session`, więc `normalizeAgentInfo`
           * odrzuca go i ani resync, ani push nie powiedzą o nim nic — wpis z `registerLaunched`
           * zostawał na `unknown` bez końca, a driver nie miał z czego zrobić karty. Emitujemy
           * przez `emitPane` z tym samym kształtem co zwykła zmiana statusu, żeby driver miał
           * JEDNĄ ścieżkę wejścia w blokadę, niezależnie od tego, kto ją zauważył.
           *
           * `unknown` świadomie pomijamy (reguła 11.3: nie zgadujemy stanu sesji).
           */
          if (result.status !== 'unknown' && entry.agent.status !== result.status) {
            entry.agent.status = result.status;
            emitPane(entry, {
              type: 'status',
              status: entry.agent.status,
              stateChangeSeq: entry.agent.stateChangeSeq,
              title: entry.agent.title,
            });
          }
        }
        return { ...result, key };
      });
      // Odrzucenie `ready` obsługuje manager (przestawia sesję w `error`); tutaj tylko
      // pilnujemy, żeby nieobsłużona obietnica nie wywróciła procesu, gdy manager już zniknął.
      ready.catch(() => undefined);
      /*
       * Siatka pod `paneLabelled`: start rozstrzygnięty w KAŻDĄ stronę (także porażką przed
       * krokiem etykiety — nieudany `agent.start`) zwalnia czekającą synchronizację etykiety taba.
       * Bez tego klucz, któremu launcher nie doszedł do `pane.rename`, czekałby do `forget`.
       */
      const release = (): void => { releaseProvenance(key); };
      handle.ready.then(release, release);
      return {
        key,
        paneId: handle.paneId,
        tabId: handle.tabId,
        agentSessionId: handle.agentSessionId,
        // Ostrzeżenie o dialogu zaufania jedzie NIETKNIĘTE do managera: to launcher
        // czytał `~/.claude.json`, a supervisor nie ma tej wiedzy skąd odtworzyć.
        ...(handle.trustPrompt === true ? { trustPrompt: true } : {}),
        ready,
      };
    },

    async closeTab(key: string): Promise<void> {
      const entry = agents.get(key);
      if (entry === undefined) throw agentGone(key);
      /*
       * "×" closes EVERY pane, including one Rarog did not create: Rarog and herdr are one
       * person's tools, so there is no multi-user caution to honour. Two technical conditions
       * remain: a known tab address and an attached write channel.
       */
      /*
       * Wpis Codexa daje STAN i nic poza stanem — także wtedy, gdy klucz przyszedł
       * z karty, która w managerze wygląda na kartę Claude. Po zmianie silnika w panelu
       * następca dostaje TEN SAM `key` (`freshKey(paneId)`), więc historyczna karta Claude
       * przenosiłaby swoją władzę na cudzy panel. Manager ma własną
       * bramkę na ten scenariusz; ta jest drugą warstwą i stoi na prawdzie nadzorcy — bo to
       * on, a nie karta, wie, jaki silnik naprawdę siedzi w panelu.
       */
      if (entry.agent.engine === 'codex') throw new HerdrNotOwnedError(CODEX_CLOSE_MESSAGE);
      if (entry.agent.tabId === '') {
        throw new HerdrNotOwnedError(say('herdr.tab-unknown'));
      }
      if (launchClient === null) throw new HerdrNotOwnedError(LAUNCH_NOT_WIRED);
      await launchClient.closeTab(entry.agent.tabId);
      audit.log({
        sessionId: sessionIdFor(key),
        key,
        paneId: entry.agent.paneId,
        cwd: entry.agent.cwd,
        method: 'close_tab',
        mode: entry.agent.mode,
        tabId: entry.agent.tabId,
      });
      // Nie czekamy na `pane.closed` z subskrypcji: karta ma zniknąć w tej samej chwili,
      // w której użytkownik potwierdził zamknięcie. Spóźnione zdarzenie trafi w pustkę.
      forget(key, 'closed');
    },

    async closeShellTab(tabId: string, cwd: string): Promise<boolean> {
      /*
       * Stary tab po restarcie sesji: `claude` wyszedł `/exit`em, w panelu została goła
       * powłoka, a rozmowa stoi już w NOWYM tabie. Zamykamy go wyłącznie wtedy, gdy świeży
       * `pane.list` pokazuje w tym tabie DOKŁADNIE jeden panel, `tab.get` potwierdza, że innego
       * tam nie ma, i nie siedzi w nim żaden agent — split z panelem użytkownika albo `claude`
       * odpalony ręcznie w tej powłoce zostają.
       * Każda niepewność (brak klienta, błąd odczytu) = tab zostaje; to jest sprzątanie, nie
       * bramka bezpieczeństwa, więc pomyłka w stronę „zostaw" kosztuje jeden tab.
       */
      if (launchClient === null || tabId === '') return false;
      const inTab = (await launchClient.listPanes()).filter((pane) => pane.tabId === tabId);
      const pane = inTab[0];
      if (inTab.length !== 1 || pane === undefined || byPane.has(pane.paneId)) return false;
      /*
       * Liczba paneli z `tab.get`, nie z samego `pane.list`: `listPanes` odsiewa panel, którego
       * herdr nie odtworzył (`restore_error`), a ten wciąż stoi w tabie — `tab.close` zamknąłby
       * go razem z powłoką, czyli split z cudzym panelem.
       */
      try {
        if ((await launchClient.getTab(tabId)).paneCount !== 1) return false;
      } catch {
        return false;
      }
      try {
        await client.getAgent(pane.paneId);
        return false;
      } catch (error: unknown) {
        if (!(error instanceof HerdrGoneError)) return false;
      }
      /*
       * Brak agenta to jeszcze nie „goła powłoka": po `claude; nvim plik` na pierwszym planie
       * stoi edytor. Zamykamy wyłącznie wtedy, gdy JEDYNYM procesem
       * pierwszego planu jest sama powłoka — zmierzone: goła powłoka daje dokładnie
       * `[zsh]`, program na pierwszym planie daje swoją nazwę. Nazwa procesu nie trafia nigdzie
       * poza to porównanie (ta sama reguła co przy etykiecie taba terminala).
       */
      let foreground: readonly { name: string }[];
      try {
        foreground = (await launchClient.readPaneProcess(pane.paneId)).processes;
      } catch {
        return false;
      }
      if (!isBareShellForeground(foreground)) return false;
      await launchClient.closeTab(tabId);
      audit.log({
        key: pane.paneId, paneId: pane.paneId, cwd, method: 'close_tab', mode: 'unknown', tabId,
      });
      return true;
    },

    logRestart(key: string, reason: RestartReason, versions?: string): void {
      const entry = agents.get(key);
      if (entry === undefined) return;
      audit.log({
        sessionId: sessionIdFor(key),
        key,
        paneId: entry.agent.paneId,
        cwd: entry.agent.cwd,
        method: 'restart',
        mode: entry.agent.mode,
        tabId: entry.agent.tabId,
        reason,
        ...(versions === undefined ? {} : { text: versions }),
      });
    },

    logCommandRefusal(key: string | null, cwd: string, command: string): void {
      const entry = key === null ? undefined : agents.get(key);
      audit.log({
        ...(key === null ? {} : { sessionId: sessionIdFor(key) }),
        key: key ?? '',
        paneId: entry?.agent.paneId ?? '',
        cwd: entry?.agent.cwd ?? cwd,
        method: 'refuse',
        reason: 'command-not-allowed',
        mode: entry?.agent.mode ?? 'unknown',
        command,
      });
    },

    rarogPaneCount: () => rarogPanes(),

    syncTabLabel(key: string, label: string): void {
      /*
       * Wejście JEDYNE i nieblokujące: manager woła z `#setLabel` przy każdym powstaniu
       * i zmianie etykiety karty. Praca idzie po {@link TAB_LABEL_DEBOUNCE_MS} od OSTATNIEJ
       * zmiany; reguły prawa do `tab.rename` są w `syncTabLabelOnce`.
       */
      if (!tabLabelsEnabled || disposed) return;
      let state = tabLabels.get(key);
      if (state === undefined) {
        state = {
          label, timer: null, running: false, again: false, written: null, settled: null,
          pending: false, failures: 0, retryAt: 0,
        };
        tabLabels.set(key, state);
      }
      state.label = label;
      armTabLabel(key, state);
    },

    agentFor: (key: string) => agents.get(key)?.agent,

    observedEngineSessions(): readonly string[] {
      const out: string[] = [];
      for (const entry of agents.values()) {
        const agent = entry.agent;
        // Wyłącznie Claude w zakresie: hook czeka tylko w sesji, której karty Rarog pokazuje.
        if (agent.engine === 'claude' && agent.inScope && agent.agentSessionId !== '') out.push(agent.agentSessionId);
      }
      return out;
    },

    async liveEngineSessions(): Promise<ReadonlySet<string>> {
      /*
       * ŚWIEŻY odczyt, nie migawka w RAM. Indeks pisarzy w managerze gubi panele
       * UKRYTE — a ukryty panel dalej żyje i dalej pisze do swojego pliku jsonl. Sprawdzenie
       * po RAM przepuściłoby więc wznowienie sesji, którą właśnie ktoś pisze.
       */
      /*
       * WYŁĄCZNIE `claude`. Ta bramka odpowiada na pytanie „czy tę sesję ktoś TERAZ
       * pisze", a pisarzem jest plik `~/.claude/projects/<slug>/<uuid>.jsonl`. Uuid Codexa
       * adresuje rollout w `~/.codex/sessions`, więc wpuszczony tutaj blokowałby wznowienie
       * sesji Claude, która przypadkiem ma ten sam identyfikator — i nie chroniłby niczego.
       */
      const infos = await client.listAgents();
      return new Set(infos
        .filter((info) => info.engine === 'claude')
        .map((info) => info.agentSessionId));
    },

    async ensureFreshMode(key: string): Promise<HerdrMode> {
      const entry = agents.get(key);
      if (entry === undefined) throw agentGone(key);
      if (modeIsFresh(entry)) return entry.agent.mode;
      // Odczyt NA ŻĄDANIE, płacony tylko wtedy, gdy naprawdę o coś pytamy (0,2 ms).
      await readMode(entry, (screen) => {
        deps.dumpRefusal?.({
          reason: 'mode-unknown', sessionId: sessionIdFor(key), screen, hook: null, jsonl: null,
        });
      });
      return modeIsFresh(entry) ? entry.agent.mode : 'unknown';
    },

    attach(key: string): SessionDriver {
      const entry = agents.get(key);
      if (entry === undefined) {
        throw agentGone(key);
      }
      entry.attached = true;
      entry.needsReattach = false;
      // Manager zaopiekował się panelem — rejestracja „w trakcie zakładania" nie jest już
      // do niczego potrzebna i nie ma prawa wygasnąć w `appeared`.
      entry.launching = false;
      const handle: HerdrAgentHandle = {
        agent: entry.agent,
        subscribe(listener): () => void {
          entry.listeners.add(listener);
          return (): void => {
            entry.listeners.delete(listener);
          };
        },
      };
      return deps.createDriver({
        handle,
        client: answerClient,
        audit,
        sessionId: sessionIdFor(key),
        markSent: () => {
          entry.sentAt = now();
        },
        /*
         * WYMUSZONY odczyt stopki dla pętli zmiany trybu: `ensureFreshMode` oddałby
         * tryb sprzed `shift+tab` przez całe `HERDR_MODE_FRESH_MS`. Odczyt idzie przez
         * `readMode`, więc nowy tryb trafia tam, gdzie zawsze (wpis nadzorcy + zdarzenie
         * `mode` → driver → chip). Wynik TEGO odczytu, dokładny: `acceptEdits` osobno od
         * `auto`, `unknown`, gdy stopki nie widać.
         */
        refreshMode: () => readMode(entry),
        markTrustDialog: () => {
          entry.trustSeenAt = now();
        },
        yoloRoots: config.yoloRoots,
        sendEnabled: config.sendEnabled,
        ...(entry.knownContextLimit === undefined
          ? {}
          : { knownContextLimit: entry.knownContextLimit }),
      });
    },

    markSent(key: string): void {
      const entry = agents.get(key);
      if (entry !== undefined) entry.sentAt = now();
    },

    takeSendSlot: (key: string, opts?: SendSlotOptions) => throttle.takeSendSlot(key, opts),

    async focus(key: string): Promise<void> {
      const entry = agents.get(key);
      if (entry === undefined) {
        throw agentGone(key);
      }
      await client.focus(entry.agent.paneId);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (resyncTimer !== null) scheduler.clearTimeout(resyncTimer);
      if (refreshTimer !== null) scheduler.clearTimeout(refreshTimer);
      answerRecheck.dispose();
      for (const key of [...tabLabels.keys()]) dropTabLabel(key);
      subscription?.close();
      subscription = null;
      lifecycle.close();
      // Panel należy do użytkownika: sprzątanie supervisora NIE wysyła do herdr niczego.
      socket?.dispose();
    },
  };
}
