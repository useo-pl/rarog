/**
 * herdr pane lifecycle in the session manager: the only consumer of the supervisor's lifecycle stream, the dispatch of
 * its events, a card for a new pane, the terminal token of a card, the one-time quiet after a herdr server restart
 * and the `herdr-status` banner with the "can a session be launched" answer. The manager owns one
 * {@link HerdrLifecycle} and gives it a narrow {@link HerdrLifecyclePort}. Paths that touch consent cards, dialog cards
 * and session restarts (a known pane re-attached, a pane gone, the attach queue) stay in the manager and are called
 * through the port. This module does not import `manager.ts`.
 */
import { basename } from 'node:path';
import type { HerdrStatus, ServerEvent, SessionState } from '@rarog/shared';
import { type AnyText, type OwnText, isServerSentence, textOf } from '@rarog/shared/sentences';
import { labelFromPrompt } from '../session-label.ts';
import { sentenceOfError } from '../herdr/types.ts';
import type { HerdrAgent, HerdrAgentStatus, HerdrLifecycleEvent, HerdrSupervisor } from '../herdr/types.ts';
import * as seenMarks from './seen-marks.ts';
import type { SeenMarkStore } from './seen-marks.ts';
import type { SessionGit } from './session-git.ts';
import type { SessionPrStatus } from './pr-status-link.ts';
import { Session } from './session.ts';
import {
  HERDR_RECOVERY_GONE_MS, HERDR_RESTORE_MATCH_MS, HERDR_RESTORE_QUIET_MAX_MS, HERDR_UNKNOWN_DETAIL,
} from './state-sentences.ts';

/** Fields of the manager configuration the lifecycle reads (`ManagerConfig`, described there). */
export interface HerdrLifecycleConfig {
  readonly herdrSupervisor?: HerdrSupervisor;
  /** Card identity and seen marks of `HerdrManagerDeps`; missing = preview mode, panes are skipped. */
  readonly herdrDeps?: {
    sessionIdFor(key: string): string;
    aliasFor(engineSessionId: string): string | undefined;
    readonly seen?: SeenMarkStore;
  };
  readonly herdrSend?: boolean;
  readonly termEnabled?: boolean;
}

/** What the lifecycle reaches in the manager: shared maps, the git row and the calls listed below. */
export interface HerdrLifecyclePort {
  readonly sessions: Map<string, Session>;
  /** `HerdrAgent.key` → Rarog session id; the manager owns it and reads it on many paths. */
  readonly herdrByKey: Map<string, string>;
  readonly git: Pick<SessionGit, 'watch' | 'unwatch' | 'requestGitStatus'>;
  /** PR status tracker side: a card added or replaced under the same id tells the tracker its (new) PR list. */
  readonly prStatus: Pick<SessionPrStatus, 'sync'>;
  readonly disposed: () => boolean;
  readonly now: () => number;
  readonly setLabel: (session: Session, raw: string) => void;
  readonly indexEngineSession: (session: Session) => void;
  readonly emitState: (session: Session) => void;
  readonly emitSessionChanged: (session: Session) => void;
  readonly markStale: (session: Session) => void;
  readonly notify: (scope: 'global' | string, seq: number | null, event: ServerEvent) => void;
  /** A pane closed: the card ends, consent and dialog cards go, restarts keep the card (manager `#herdrGone`). */
  readonly herdrGone: (key: string) => void;
  /** A known pane came back after a socket failure (manager `#herdrReattached`). */
  readonly herdrReattached: (supervisor: HerdrSupervisor, agent: HerdrAgent) => void;
  /** Attach queue of drivers (manager `#attachHerdrDriver`, attach slots). */
  readonly attachHerdrDriver: (supervisor: HerdrSupervisor, session: Session, key: string) => Promise<void>;
}

/** Lifecycle events of herdr panes and their state; one instance per manager. */
export class HerdrLifecycle {
  readonly #config: HerdrLifecycleConfig;
  readonly #port: HerdrLifecyclePort;
  /**
   * Ostatnio ROZGŁOSZONA odpowiedź „czy wolno założyć sesję" plus jej powód — do porównania
   * w `#syncLaunchability`, żeby resync (kilkanaście `appeared` naraz) nie zamienił jednej
   * informacji w burzę identycznych ramek. `null` = jeszcze nic nie wysłaliśmy.
   */
  #lastLaunchable: { canLaunch: boolean; detail?: string } | null = null;
  /**
   * Uuid silnika → chwila, w której BEZCZYNNA karta (`waiting-input`) dostała `gone`.
   * Kluczem jest uuid, nie id karty: karta adoptowana bez aliasu dostaje id z klucza panelu,
   * a ten po restarcie herdr bywa inny — `--resume` zachowuje tylko uuid.
   */
  readonly #herdrGoneIdle = new Map<string, number>();
  /** Id karty odtworzonej po restarcie herdr → termin jednorazowego znacznika ciszy. */
  readonly herdrRestoreQuiet = new Map<string, number>();
  /** Chwila ostatniego `available` PO `unavailable` (`null` = gniazdo nie wracało). */
  #herdrRecoveredAt: number | null = null;
  /** Czy od ostatniego `available` gniazdo herdr było niedostępne (powrót jest do odnotowania). */
  #herdrWasUnavailable = false;

  constructor(config: HerdrLifecycleConfig, port: HerdrLifecyclePort) {
    this.#config = config;
    this.#port = port;
  }

  /**
   * Jedyny konsument strumienia cyklu życia nadzorcy.
   *
   * Strumień jest jednokonsumencki i celowo ROZŁĄCZNY ze strumieniem zdarzeń panelu:
   * manager dowiaduje się wyłącznie „kto się pojawił, zniknął, wrócił", a co się dzieje
   * w środku panelu, wie tylko przypięty do niego driver.
   */
  async pumpHerdr(supervisor: HerdrSupervisor): Promise<void> {
    try {
      for await (const event of supervisor.events) {
        if (this.#port.disposed()) return;
        this.#handleHerdrEvent(supervisor, event);
      }
    } catch (error: unknown) {
      // Awaria samego strumienia nadzorcy NIE rusza stanów sesji (reguła 11.4): karty
      // bledną i czekają na powrót, a nie lądują w `error`.
      console.warn(`rarog: herdr supervisor stream interrupted: ${describeError(error)}`);
      this.#staleAllHerdr();
      // Zdanie własne nadzorcy jedzie z kodem; treść błędu obcego jako tekst obcy.
      this.#broadcastHerdrStatus({ available: false, detail: sentenceOfError(error) });
    }
  }

  /**
   * Obsługa jest SYNCHRONICZNA, a samo podpięcie leci osobno (`void`).
   *
   * Gdyby pętla cyklu życia czekała na podpięcie, limit „4 naraz" nie miałby czego
   * ograniczać: 17 zdarzeń `appeared` przetwarzałoby się jedno po drugim, a karta
   * siedemnastego panelu pojawiłaby się na liście po odczytaniu szesnastu historii.
   * Sesja i jej miejsce na liście powstają natychmiast; treść dochodzi, gdy zwolni się slot.
   */
  #handleHerdrEvent(supervisor: HerdrSupervisor, event: HerdrLifecycleEvent): void {
    switch (event.type) {
      /*
       * Każde z tych trzech zdarzeń ZMIENIA SKŁAD paneli, a więc może zmienić odpowiedź na
       * pytanie „czy wolno założyć sesję" (sufit `RAROG_MAX_PANES`). Dlatego każde
       * z nich wysyła to, co tę odpowiedź niesie — patrz `#syncLaunchability`.
       */
      case 'appeared':
        this.herdrAppeared(supervisor, event.agent);
        this.#syncLaunchability();
        return;
      case 're-attached':
        this.#port.herdrReattached(supervisor, event.agent);
        this.#syncLaunchability();
        return;
      case 'term-changed':
        this.#herdrTermChanged(event.agent);
        return;
      case 'gone': {
        /*
         * The pane's Claude Code process ended (also a restart's `/exit`), and its scheduled tasks live in it: the
         * field goes before `herdrGone` broadcasts the card. A lost socket (`unavailable`) keeps it, the process may
         * still run; a new process of the conversation gets its list from its own driver.
         */
        const sessionId = this.#port.herdrByKey.get(event.key);
        const session = sessionId === undefined ? undefined : this.#port.sessions.get(sessionId);
        if (session !== undefined) session.scheduledTasks = undefined;
        this.#port.herdrGone(event.key);
        this.#syncLaunchability();
        return;
      }
      case 'unavailable':
        this.#herdrWasUnavailable = true;
        // ŻADNYCH przejść stanu: padł socket, nie 17 paneli.
        this.#staleAllHerdr();
        this.#broadcastHerdrStatus({ available: false, detail: event.reason });
        return;
      case 'available':
        // Od tej chwili `gone` z resyncu po powrocie znaczy „herdr wstał bez tych paneli".
        if (this.#herdrWasUnavailable) {
          this.#herdrWasUnavailable = false;
          this.#herdrRecoveredAt = this.#port.now();
        }
        // Resync przyniesie `re-attached`/`appeared` — tu tylko gasimy baner.
        this.#broadcastHerdrStatus();
        return;
    }
  }

  /** Nowy panel w zasięgu Raroga → nowa karta na liście. */
  herdrAppeared(supervisor: HerdrSupervisor, agent: HerdrAgent): void {
    const deps = this.#config.herdrDeps;
    // Nadzorca bez zależności to tryb PODGLĄDU (brak tożsamości, guardu i throttle'a).
    // Wyjątek w tym miejscu zerwałby pompę cyklu życia i wygasił wszystkie karty naraz.
    if (deps === undefined) {
      console.warn('rarog: herdr supervisor without dependencies — pane skipped.');
      return;
    }
    // Każdy żywy panel w zasięgu dostaje kartę.
    if (this.#port.herdrByKey.has(agent.key)) return;

    const at = this.#iso();
    const initial = herdrInitialState(agent.status);
    /*
     * Znacznik „widziane z telefonu" przeżywa restart Raroga, więc rozstrzyga się TUTAJ,
     * przy powstawaniu karty: panel, którego `done` obejrzano przed deployem, nie ma prawa
     * wrócić do sekcji uwagi tylko dlatego, że Rarog zapomniał o tym w RAM.
     */
    let seen = initial.seen;
    if (initial.seen === false && seenMarks.wasSeen(agent, this.#config.herdrDeps?.seen)) seen = true;
    // Panel `idle` przy adopcji uchodzi za odebrany — chyba że człowiek oznaczył ten wynik jako
    // nieprzeczytany: wtedy wynik czeka, bez badge'a w herdr (`undefined`, nie `false`).
    // The entry is the same for a pane still on `done` (seen without focus): there `seen` stays `false`, the badge
    // still stands in herdr, and only the in-memory mark comes back.
    const markedUnseen = initial.seen !== undefined && seenMarks.wasMarkedUnseen(agent, this.#config.herdrDeps?.seen);
    if (markedUnseen && initial.seen === true) seen = undefined;
    const codex = agent.engine === 'codex';
    const session = new Session({
      /*
       * Tożsamość karty: najpierw ALIAS po uuidzie silnika (ta sama sesja wznowiona w nowym
       * panelu ma zostać tą samą kartą), potem deterministyczny `sessionIdFor(key)`. Jedno
       * i drugie musi przeżyć restart Raroga — inaczej 17 zakładek na telefonie to 17 stron
       * 404 po każdym deployu.
       *
       * Codex ma tożsamość PANELU i tylko panelu: aliasy zapisuje wyłącznie `create()`
       * dla paneli zakładanych przez Raroga, a `/new` w Codexie zmienia uuid w tym samym
       * panelu — karta ma wtedy zostać jedna, ta sama.
       */
      id: codex
        ? deps.sessionIdFor(agent.key)
        : deps.aliasFor(agent.agentSessionId) ?? deps.sessionIdFor(agent.key),
      cwd: agent.cwd,
      title: basename(agent.cwd),
      state: initial.state,
      stateDetail: initial.detail,
      stateSince: at,
      createdAt: at,
      lastActivityAt: at,
      /*
       * Uuid Codexa NIE jest `engineSessionId` i to jest cała ostrożność tej gałęzi.
       * `engineSessionId` znaczy w managerze „ta karta pisze do pliku jsonl o tej nazwie":
       * stąd indeks pisarzy, `resume` i bramka dwóch pisarzy. Codex żadnego takiego pliku nie
       * ma, więc jego uuid dostaje własne pole i jedno zastosowanie — znacznik „obejrzane".
       */
      ...(codex
        ? { engine: 'codex' as const, observedSessionId: agent.agentSessionId }
        : { engineSessionId: agent.agentSessionId }),
      /*
       * Adres wpisu w kliencie, gdy agent stoi w terminalu Raroga — ale tylko wtedy, gdy terminal
       * w ogóle istnieje: przy `RAROG_TERM=0` nie ma czego pokazać. To pole adresuje CAŁĄ
       * kartę — wiersz listy i cel pusha — i niesie je także Claude uruchomiony ręcznie
       * w terminalu Raroga (jego ekranem jest ten terminal).
       */
      ...this.termIdField(agent),
      // Adres panelu do deep-linku „Pokaż w herdr" i do diagnostyki. NIGDY nie jest
      // kluczem — zmienia go `pane move`.
      paneId: agent.paneId,
      herdrMode: agent.mode,
      outOfScope: !agent.inScope,
      herdrKey: agent.key,
      // Jedyne, co włącza przycisk „Zamknij panel"; brak znacznika zostawia „Ukryj".
      launchedByRarog: agent.launchedByRarog,
      seen,
      herdrSeq: agent.stateChangeSeq,
    });
    // Surowy status herdr z chwili adopcji — bez niego panel zastany na `done` i sfokusowany
    // na Macu po turze nie dostałby `seen: true` (reguła `done → idle` w `agent-state`).
    session.herdrSeen = initial.seen;
    // The durable "unread" entry restores the in-memory mark too: without it the card would lose
    // `markedUnseen` after a Rarog restart, and a late `idle` would no longer move the entry to its new number.
    if (markedUnseen) session.unseenByHuman = true;
    // The voice agent's pick-up survives a restart too, at exactly the state number of its entry.
    if (seen === true) session.seenBy = seenMarks.seenByOf(agent, this.#config.herdrDeps?.seen);
    /*
     * Etykieta z auto-tytułu konwersacji („s3-back"); pusty tytuł → nazwa katalogu. Tytuł
     * Codexa jest znormalizowany już w kliencie herdr (bez spinnera i bez sufiksu katalogu),
     * więc ta sama reguła daje tu sensowny wynik dla obu silników. Przez `#setLabel`, bo
     * etykieta taba w herdr ma pójść za kartą — także po restarcie Raroga, który ogłasza
     * każdy panel na nowo; tu też biegnie migracja tabów Claude w starym formacie (nadzorca odmawia
     * Codexowi sam).
     */
    this.#port.setLabel(session, labelFromPrompt(agent.title) ?? basename(agent.cwd));
    /*
     * Ten sam identyfikator może już stać na liście jako karta `done` (panel `gone`, potem
     * ten sam klucz wrócił resyncem albo `--resume` w nowym panelu). Nadpisanie bez
     * sprzątnięcia zostawiłoby jej rejestrację w obserwatorze `.git` — licznik per katalog
     * rósłby o jeden przy każdym powrocie, a zwalniał tylko raz.
     */
    const previous = this.#port.sessions.get(session.id);
    if (previous !== undefined) this.#port.git.unwatch(previous);
    this.#port.sessions.set(session.id, session);
    // A card replaced under the same id (a gone Claude card, then a Codex pane on the same key) must not leave the
    // previous card's PR URLs in the tracker: the new card's list replaces them.
    this.#port.prStatus.sync(session);
    this.#port.herdrByKey.set(agent.key, session.id);
    // Indeks PISARZY pliku jsonl — karta Codexa nie wchodzi do niego nigdy: nie ma
    // pliku, do którego mogłaby pisać, a zajęty uuid blokowałby wznowienie cudzej sesji.
    if (!codex) this.#port.indexEngineSession(session);
    this.#armRestoreQuiet(session, agent.agentSessionId);

    // Karta ma być na liście NATYCHMIAST — historia dojdzie, gdy zwolni się slot podpięcia.
    this.#port.emitState(session);
    this.#port.emitSessionChanged(session);
    /*
     * PIERWSZY odczyt gita dla katalogu, żeby projekty pokazywały gałąź i commity.
     *
     * Poza nim git odzywa się WYŁĄCZNIE po domkniętym tool-callu i przy otwarciu
     * transkryptu — czyli po restarcie Raroga gałąź znałaby dokładnie ta jedna sesja, w którą
     * ktoś właśnie wszedł. Wiersz projektu w sidebarze pyta o to samo o KAŻDY projekt naraz
     * i nie ma jak na tamte zdarzenia poczekać: projekt bezczynny od tygodnia nie wywoła
     * żadnego z nich, a mimo to stoi na liście i ma gałąź.
     *
     * Kosztu to nie dokłada w praktyce: `GitStatusWatcher` throttluje per KATALOG, a jeden
     * udany odczyt zasila wszystkie sesje tego katalogu (patrz `requestGitStatus`). Dwadzieścia
     * paneli w dwunastu repo to dwanaście lokalnych `git status` raz, przy starcie — bez ani
     * jednego `git fetch` (Rarog nie robi go w tle).
     */
    this.#port.git.requestGitStatus(session);
    this.#port.git.watch(session);
    void this.#port.attachHerdrDriver(supervisor, session, agent.key);
  }

  /** Pole `termId` karty z migawki agenta: tylko przy włączonym terminalu (`RAROG_TERM`). */
  termIdField(agent: HerdrAgent): { termId?: string } {
    return agent.termId !== null && this.#config.termEnabled === true ? { termId: agent.termId } : {};
  }

  /**
   * Panel zyskał albo stracił token terminala Raroga: karta dostaje
   * nowy adres i klient przestaje (albo zaczyna) pokazywać jej własną zakładkę. Driver zostaje.
   */
  #herdrTermChanged(agent: HerdrAgent): void {
    const sessionId = this.#port.herdrByKey.get(agent.key);
    const session = sessionId !== undefined ? this.#port.sessions.get(sessionId) : undefined;
    if (session === undefined) return;
    const termId = this.termIdField(agent).termId;
    if (session.termId === termId) return;
    session.termId = termId;
    this.#port.emitSessionChanged(session);
  }

  /**
   * Odtworzenie po restarcie herdr, połowa pierwsza: bezczynna karta zniknęła z herdr — zapamiętaj jej uuid silnika.
   *
   * Pełny restart serwera herdr (aktualizacja) zabija procesy wszystkich paneli, a Rarog wraca
   * szybciej, niż herdr odtworzy agentów (`claude --resume`). Pełny resync widzi wtedy pustą
   * listę i każda karta dostaje `gone`, a chwilę później ten sam uuid wraca jako NOWA karta
   * (`herdrAppeared`) w stanie `running` — i jej pierwsze `idle` wyglądałoby jak koniec tury:
   * po jednym banerze „Skończył · … / claude --resume" na kartę. Wyłącznie `waiting-input`:
   * karta w turze straciła ją naprawdę, a trasa `gone` przy `--handoff` nie jest zmierzona —
   * fałszywy baner jest tańszy niż zgubiony prawdziwy.
   */
  rememberGoneIdle(session: Session): void {
    if (session.state !== 'waiting-input') return;
    // Tylko `gone` z obrotu po powrocie gniazda: zamknięcie panelu przy żywym herdr i wznowienie
    // tego uuid z nowym zadaniem na Macu to prawdziwa tura, której koniec ma być słyszalny.
    const recoveredAt = this.#herdrRecoveredAt;
    if (recoveredAt === null || this.#port.now() - recoveredAt > HERDR_RECOVERY_GONE_MS) return;
    const uuid = session.engineSessionId ?? session.observedSessionId;
    if (uuid === undefined) return;
    this.#pruneGoneIdle();
    this.#herdrGoneIdle.set(uuid, this.#port.now());
  }

  /** Wpisy `#herdrGoneIdle` starsze niż {@link HERDR_RESTORE_MATCH_MS} nie opisują odtworzenia. */
  #pruneGoneIdle(): void {
    const cutoff = this.#port.now() - HERDR_RESTORE_MATCH_MS;
    for (const [uuid, at] of this.#herdrGoneIdle) {
      if (at < cutoff) this.#herdrGoneIdle.delete(uuid);
    }
  }

  /**
   * Odtworzenie po restarcie herdr, połowa druga: nowa karta z uuid, który przed chwilą zniknął jako bezczynny, i stanem
   * `running`/`starting` to ODTWORZENIE — jej pierwsze `agent-idle` nie jest końcem tury.
   * Znacznik jest jednorazowy: gasi go pierwszy `idle`/`blocked` (obsługa `agent-state`),
   * wysyłka z Raroga i zapomnienie karty; termin to tylko bezpiecznik.
   */
  #armRestoreQuiet(session: Session, agentSessionId: string): void {
    // Defensywnie: nowa karta nie dziedziczy znacznika poprzedniej o tym samym id.
    this.herdrRestoreQuiet.delete(session.id);
    this.#pruneGoneIdle();
    if (!this.#herdrGoneIdle.delete(agentSessionId)) return;
    if (session.state !== 'running' && session.state !== 'starting') return;
    this.herdrRestoreQuiet.set(session.id, this.#port.now() + HERDR_RESTORE_QUIET_MAX_MS);
  }

  /** Czy karta ma ŻYWY znacznik ciszy po odtworzeniu; przeterminowany sprząta. */
  restoreQuietLive(sessionId: string): boolean {
    const deadline = this.herdrRestoreQuiet.get(sessionId);
    if (deadline === undefined) return false;
    if (this.#port.now() <= deadline) return true;
    this.herdrRestoreQuiet.delete(sessionId);
    return false;
  }

  /** Padł socket: wszystkie ŻYWE karty bledną, żadna nie zmienia stanu ani sekcji. */
  #staleAllHerdr(): void {
    for (const session of this.#port.sessions.values()) {
      // Sesja domknięta (ukryta, zamknięty panel) nie ma czego stracić kontaktu — jej stan
      // jest ostateczny, a wygaszona karta sugerowałaby, że wróci.
      if (session.state === 'done') continue;
      this.#port.markStale(session);
    }
  }

  /**
   * Rozgłasza `herdr-status` do strumienia GLOBALNEGO.
   *
   * Event jest ulotny (`seq: null`, poza ring bufferem którejkolwiek sesji): stan startowy klient
   * bierze z ramki `sessions-snapshot`, a nie z replayu.
   */
  #broadcastHerdrStatus(override: { available?: false; detail?: AnyText } = {}): void {
    const status = this.#config.herdrSupervisor?.status();
    if (status === undefined) return;
    // Zdanie z nadpisania (powód awarii strumienia) zastępuje tekst i kod zdania nadzorcy; tekst obcy idzie bez kodu.
    const { detailRef: statusRef, ...base } = status;
    const overrideRef = override.detail !== undefined && isServerSentence(override.detail) ? override.detail.ref : undefined;
    const detailRef = override.detail === undefined ? statusRef : overrideRef;
    const merged: HerdrStatus = {
      ...base,
      ...(override.available === undefined ? {} : { available: override.available }),
      ...(override.detail === undefined ? {} : { detail: textOf(override.detail) }),
      ...(detailRef === undefined ? {} : { detailRef }),
    };
    /*
     * `available && canLaunch`, a nie samo `canLaunch`: override potrafi zgasić dostępność
     * (ścieżka `unavailable`) zanim nadzorca to zauważy, a przycisk „+" ma wtedy zgasnąć
     * razem z banerem. Fail-closed przy każdym wyścigu.
     */
    const canLaunch = merged.available && merged.canLaunch;
    const event: ServerEvent = {
      type: 'herdr-status',
      available: merged.available,
      agentCount: merged.agentCount,
      readOnly: merged.readOnly || this.#config.herdrSend === false,
      canLaunch,
    };
    if (merged.detail !== undefined) event.detail = merged.detail;
    if (merged.detailRef !== undefined) event.detailRef = merged.detailRef;
    this.#lastLaunchable = { canLaunch, detail: merged.detail };
    this.#port.notify('global', null, event);
  }

  /**
   * ODPOWIEDŹ „CZY WOLNO ZAŁOŻYĆ SESJĘ" MA DOJEŻDŻAĆ NA CZAS.
   *
   * Do tego dnia `canLaunch` jechało WYŁĄCZNIE w ramce `sessions-snapshot`, a ta powstaje przy
   * podłączeniu strumienia i po zamknięciu sesji Z RAROGA. Panel zamknięty ręcznie przy Macu
   * zwalniał więc miejsce po stronie serwera, a telefon dalej pokazywał wygaszony „+"
   * i zdanie o limicie — aż do reconnectu (zgaszenie ekranu, przeładowanie). Symetrycznie:
   * panel założony z innego urządzenia nie odświeżał licznika u pozostałych.
   *
   * WYSYŁAMY TYLKO PRZY ZMIANIE odpowiedzi, a nie przy każdym zdarzeniu. To nie jest
   * oszczędzanie bajtów: resync po powrocie herdr sypie kilkunastoma `appeared`/`re-attached`
   * naraz (zmierzone: 17), więc bezwarunkowy broadcast zamieniłby jedną informację w burzę
   * identycznych ramek. Porównujemy parę (odpowiedź, powód) — powód też jest treścią, bo to
   * on stoi na przycisku.
   */
  #syncLaunchability(): void {
    const status = this.#config.herdrSupervisor?.status();
    if (status === undefined) return;
    const canLaunch = status.available && status.canLaunch;
    const last = this.#lastLaunchable;
    if (last !== null && last.canLaunch === canLaunch && last.detail === status.detail) return;
    this.#broadcastHerdrStatus();
  }

  #iso(): string {
    return new Date(this.#port.now()).toISOString();
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Stan sesji Raroga dla panelu zobaczonego PIERWSZY raz.
 *
 * To jedyne miejsce, w którym status herdr staje się stanem bez udziału `transition()` —
 * bo dla nowej sesji nie ma z czego przechodzić. Dalej stan liczy wyłącznie maszyna.
 *
 * `unknown` NIE jest tu mapowany na `waiting-input`: „nie wiem, co robi ten panel" i „panel
 * skończył i czeka" to dwie różne rzeczy, a druga wypycha kartę do sekcji uwagi. `starting`
 * jest przejściowe i pierwsze zdarzenie z nadzorcy je poprawi (reguła 11.3).
 */
export function herdrInitialState(status: HerdrAgentStatus): {
  state: SessionState; seen?: boolean; detail?: OwnText;
} {
  switch (status) {
    case 'working':
      return { state: 'running' };
    /*
     * `idle` = panel BEZ badge'a `done` → karta schodzi z pasa uwagi do grup projektów.
     * Przy ADOPCJI (i tylko tu) Rarog świadomie ufa herdr, choć herdrowe `idle` nie
     * jest dowodem odbioru: panel zastany przy starcie Raroga nie ma żadnej historii,
     * z której dałoby się odczytać, czy ktoś ten wynik czytał, a inaczej każdy restart
     * wrzucałby wszystkie bezczynne panele naraz do sekcji uwagi. Odbiorem CZŁOWIEKA to nie
     * jest — stąd `Session.seenByHuman` zostaje puste (tabela „adopcja panelu").
     */
    case 'idle':
      return { state: 'waiting-input', seen: true };
    // `done` = badge stoi w herdr, czyli jest co odebrać → informację niesie samo `seen: false`
    // (błękitne „gotowe"), bez słownego dopisku.
    case 'done':
      return { state: 'waiting-input', seen: false };
    case 'blocked':
      return { state: 'waiting-permission' };
    case 'unknown':
      return { state: 'starting', detail: HERDR_UNKNOWN_DETAIL };
  }
}
