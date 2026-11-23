/**
 * Session restart on a newer Claude Code or to resend a prompt blocked by a hook: the life of one restart
 * record from the reservation to the note after the new process starts, and the block of every other card action
 * meanwhile (`assertNotRestarting`, the in-flight counter `track`). The manager keeps the synchronous checks of
 * `restart()` and the launch slot, the end of the start (`#finishLaunch`) and `#herdrGone`, which call this module.
 * The pane is driver interface (restart probe, `requestExit`, `clearBlockedLeftover`). Does not import `manager.ts`.
 */
import type { ServerSystem } from '@rarog/shared/rest';
import { type ServerSentence, say } from '@rarog/shared/sentences';
import type { Session, RecentSend } from './session.ts';
import { BadRequestError, BadStateError } from './errors.ts';
import {
  HERDR_LAUNCH_OFF_MESSAGE, RESTART_BUSY_MESSAGE, RESTART_COMPOSER_UNKNOWN_MESSAGE, RESTART_DONE_NOTE,
  RESTART_EXIT_DIALOG_READ_MS, RESTART_EXIT_POLL_MS, RESTART_EXIT_TIMEOUT_MS, RESTART_IN_PROGRESS_MESSAGE,
  RESTART_MODE_UNKNOWN_MESSAGE,
  RESTART_NO_PANEL_MESSAGE, RESTART_PANEL_CHANGED_MESSAGE, RESTART_RESEND_STALE_MESSAGE, RESTART_TASKS_MESSAGE,
  RESTART_UNVERIFIED_MESSAGE, RESTART_WAITING_AGENT_MESSAGE, RESTART_WRITERS_MESSAGE, RESUME_FOREIGN_CWD_MESSAGE,
  RESUME_NOT_FOUND_MESSAGE, RESUME_UNVERIFIABLE_MESSAGE, restartComposerMessage, restartExitingDetail,
  restartExitTasksNotice, restartFailedDetail, restartLeftoverRefusal, restartPermissionMode, transcriptCwdBelongs,
} from './state-sentences.ts';
import type { RestartExitCode } from './state-sentences.ts';
import type { CliRegistryState } from './cli-registry.ts';
import type { LaunchGate, LaunchOptions } from './launch-gate.ts';
import { serverSystem } from '../version.ts';
import { runningCliVersion } from '../cli-version.ts';
import type { CliVersionReader } from '../cli-version.ts';
import { defaultStoreRoot } from '../cli-store.ts';
import type { LiveSessionsReader } from '../live-sessions.ts';
import type { InternalBlock, SessionDriver } from '../drivers/types.ts';
import { HERDR_PANE_CAP_MESSAGE } from '../herdr/types.ts';
import type { HerdrAgent, HerdrSupervisor } from '../herdr/types.ts';
import type { RestartReason } from '../herdr/audit.ts';
import { onlyWaitingAgents, tasksBlockRestart } from '../herdr/background/work.ts';

/** Restart w toku — rezerwacja karty od bramek do rozstrzygnięcia startu. */
export interface RestartOp {
  /** Klucz STAREGO panelu — `#herdrGone` rozpoznaje po nim zniknięcie z restartu. */
  readonly key: string;
  /** Tab starego panelu — do sprzątnięcia po udanym starcie (`closeShellTab`). */
  readonly tabId: string;
  /** Para wydań przy aktualizacji; `undefined` = restart po blokadzie promptu bez aktualizacji. */
  readonly update: { running: string; installed: string } | undefined;
  /** Który gest uruchomił restart — pole `reason` wpisu `restart` w dzienniku. */
  readonly reason: RestartReason;
  /** Znacznik zajętego slotu throttle'a startów — zwracany przy odmowie przed `/exit`. */
  readonly slotAt: number;
  stage: 'checking' | 'exiting' | 'launching';
  /** Opcje startu nowego procesu; przy ponownej wysyłce z `prompt` i `promptDisplay`. */
  options?: LaunchOptions;
}

/** Fields of the manager configuration the restart reads (`ManagerConfig`, described there). */
export interface SessionRestartConfig {
  readonly maxPanes?: number;
  readonly transcriptRoot?: string;
  readonly cliVersionReader?: CliVersionReader;
  readonly restartTiming?: { exitTimeoutMs?: number; pollMs?: number; dialogReadMs?: number };
  readonly herdrSupervisor?: HerdrSupervisor;
  readonly logger?: (line: string) => void;
  readonly system?: ServerSystem;
  /** The transcript reader of `HerdrManagerDeps` (`resumeSource`); missing = every restart is refused. */
  readonly herdrDeps?: {
    readonly resumeSource?: {
      locate(root: string, cwd: string, engineSessionId: string): Promise<string | null>;
      cwdOf(file: string): Promise<string | null>;
    };
  };
}

/** Modules of the manager the restart calls: they are not manager state, so they stay out of the port. */
export interface SessionRestartModules {
  /** CLI registry: the release reading of the note after a restart. */
  readonly cli: Pick<CliRegistryState, 'cliVersion' | 'cliTick'>;
  /** Launch slots: a refusal before `/exit` gives the slot back. */
  readonly launchGate: Pick<LaunchGate, 'releaseLaunchSlot'>;
  /** `claude agents --json` reader of the manager. */
  readonly liveSessions: LiveSessionsReader;
}

/** What the restart reaches in the manager. */
export interface SessionRestartPort {
  readonly sessions: ReadonlyMap<string, Session>;
  readonly disposed: () => boolean;
  readonly now: () => number;
  readonly emitSessionChanged: (session: Session) => void;
  /** Transcript line of the card (manager `#appendMessage`); the restart writes only `system` notes. */
  readonly appendMessage: (session: Session, role: 'system', blocks: readonly InternalBlock[]) => void;
  /** Card closing after the pane is gone (manager `#herdrGone`). */
  readonly herdrGone: (key: string) => void;
  /** New pane for the card under the same id (manager `#recreate`, shared with `resume()`). */
  readonly recreate: (session: Session, opts: LaunchOptions, slotTaken: boolean) => Promise<void>;
  /** `bypassPermissions` only under `RAROG_YOLO_ROOTS` (manager `#assertPermissionMode`). */
  readonly assertPermissionMode: (cwd: string, mode: string | undefined) => void;
}

/** What the manager's `restart()` has read and reserved before the restart record exists. */
export interface RestartStart {
  readonly driver: SessionDriver;
  readonly supervisor: HerdrSupervisor;
  /** Key of the old pane. */
  readonly key: string;
  readonly agent: HerdrAgent | undefined;
  readonly update: { running: string; installed: string } | undefined;
  readonly engineSessionId: string;
  /** Resend of the prompt blocked by a hook; `undefined` = restart for a CLI update. */
  readonly send: RecentSend | undefined;
  /** Launch slot taken by the manager. */
  readonly slotAt: number;
}

/** Restart records of the cards and the in-flight counter of card mutations; one instance per manager. */
export class SessionRestart {
  readonly #config: SessionRestartConfig;
  readonly #modules: SessionRestartModules;
  readonly #port: SessionRestartPort;

  /**
   * Restarty w toku: `sessionId` → rezerwacja. Wpis żyje od bramek do rozstrzygnięcia
   * startu nowego procesu i przez ten czas każda inna akcja na karcie dostaje 409.
   */
  readonly restarts = new Map<string, RestartOp>();

  constructor(config: SessionRestartConfig, modules: SessionRestartModules, port: SessionRestartPort) {
    this.#config = config;
    this.#modules = modules;
    this.#port = port;
  }

  /** System maszyny serwera do słowa maszyny w zdaniach `.mac`/`.vps` ({@link SessionRestartConfig.system}). */
  get #system(): ServerSystem {
    return this.#config.system ?? serverSystem();
  }

  /** Nadzorca albo twardy błąd — bez niego Rarog nie ma z czego zrobić sesji. */
  #requireSupervisor(): HerdrSupervisor {
    const supervisor = this.#config.herdrSupervisor;
    if (supervisor === undefined) throw new BadStateError(HERDR_LAUNCH_OFF_MESSAGE);
    return supervisor;
  }

  /** 409 dla każdej akcji na karcie, która właśnie uruchamia się ponownie. */
  assertNotRestarting(id: string): void {
    if (this.restarts.has(id)) throw new BadStateError(RESTART_IN_PROGRESS_MESSAGE);
  }

  /**
   * Czy nowy panel zmieści się pod sufitem i czy wolno zakładać (`RAROG_HERDR_LAUNCH`).
   *
   * Restart ZASTĘPUJE panel: nowy tab dokłada panel Raroga, a stary znika z licznika tylko
   * wtedy, gdy był rarogowy. Liczone TERAZ, przed `/exit` — `create()` odmówiłby dopiero po
   * zabiciu procesu. `canLaunch` gaśnie też przy suficie, więc prawo zakładania czytamy
   * z `launchAvailable()` (bez sufitu): pełny sufit nie może maskować `RAROG_HERDR_LAUNCH=0`.
   * Nadzorca bez tej metody (atrapy) — zwykłe `canLaunch`.
   */
  assertCanRelaunch(supervisor: HerdrSupervisor, oldIsRarog: boolean): void {
    const available = supervisor.launchAvailable?.() ?? supervisor.status().canLaunch;
    if (!available) throw new BadStateError(HERDR_LAUNCH_OFF_MESSAGE);
    const max = this.#config.maxPanes ?? Infinity;
    const count = supervisor.rarogPaneCount();
    if (count - (oldIsRarog ? 1 : 0) + 1 > max) throw new BadStateError(HERDR_PANE_CAP_MESSAGE);
  }

  /**
   * Mutacje karty w toku: `sessionId` → ile. Restart odmawia, dopóki którakolwiek się
   * nie rozstrzygnie — wysyłka czy zmiana trybu rozpoczęta tuż przed nim czeka na odczyt
   * stopki albo zapis załączników i dokończyłaby się w środku restartu (tryb przestawiony PO odczycie
   * restartu dawał nowemu procesowi stary tryb).
   * Kierunek odwrotny pilnuje `assertNotRestarting` na wejściu każdej z tych metod.
   */
  readonly inFlight = new Map<string, number>();

  /** Owija mutację karty licznikiem `inFlight`. Rzut synchroniczny zostaje synchroniczny. */
  track<T>(id: string, run: () => Promise<T>): Promise<T> {
    this.inFlight.set(id, (this.inFlight.get(id) ?? 0) + 1);
    const done = (): void => {
      const left = (this.inFlight.get(id) ?? 1) - 1;
      if (left <= 0) this.inFlight.delete(id);
      else this.inFlight.set(id, left);
    };
    let pending: Promise<T>;
    try {
      pending = run();
    } catch (error: unknown) {
      done();
      throw error;
    }
    return pending.finally(done);
  }

  /**
   * The manager's `restart()` from the reservation on, called after its synchronous checks and the launch slot and
   * before its first `await`, so the record exists before anything is read.
   */
  async restart(session: Session, start: RestartStart): Promise<{ sessionId: string }> {
    const id = session.id;
    const { driver, supervisor, key, agent, update, engineSessionId, send, slotAt } = start;
    const op: RestartOp = {
      key, tabId: agent?.tabId ?? '', update, reason: send === undefined ? 'cli-update' : 'prompt-blocked',
      slotAt, stage: 'checking',
    };
    this.restarts.set(id, op);
    const refuse = (error: unknown): never => {
      this.restarts.delete(id);
      this.#modules.launchGate.releaseLaunchSlot(slotAt);
      throw error;
    };

    // B. Bramki asynchroniczne — wciąż przed mutacją; każda odmowa zwraca rezerwację i slot.
    let options: LaunchOptions;
    try {
      options = await this.#restartPreflight(session, driver, engineSessionId, update);
    } catch (error: unknown) {
      return refuse(error);
    }

    // Lista zadań drugi raz, tuż przed punktem bez powrotu: bramki wyżej czekały na odczyty,
    // a w tym czasie zadanie mogło ruszyć albo uśpiony subagent wrócić na listę.
    // `/exit` zabiłby jego proces bez odmowy.
    if (tasksBlockRestart(session.backgroundTasks)) {
      return refuse(new BadStateError(
        onlyWaitingAgents(session.backgroundTasks) ? RESTART_WAITING_AGENT_MESSAGE : RESTART_TASKS_MESSAGE,
      ));
    }
    // Blokada mogła zgasnąć w trakcie odczytów (wpis `user` z pliku: ktoś wysłał prompt przy Macu) —
    // wtedy ponowna wysyłka byłaby już cudzym promptem.
    if (send !== undefined && session.promptBlocked?.send !== send) {
      return refuse(new BadStateError(RESTART_RESEND_STALE_MESSAGE));
    }
    /*
     * Ponowna wysyłka drogą promptu startowego: tekst dla CLI i dymek z pierścienia wysyłek. Bramka,
     * tryb i ścieżka porażki („panel wstał, prompt nie poszedł") są gotowe w `#launch`/`#finishLaunch`,
     * a rezerwacja schodzi dopiero po wysyłce — zwykła wysyłka nie wejdzie przed ten prompt.
     */
    op.options = send === undefined ? options : {
      ...options, prompt: send.raw, promptDisplay: { blocks: send.blocks, attachments: send.attachments },
    };

    // C. Punkt bez powrotu. Opcje startu zapisane na karcie PRZED `/exit`: każda droga
    //    odzyskania („Wznów" po porażce) wstaje z tym samym trybem zgód, a nie z domyślnym.
    session.permissionMode = op.options.permissionMode;
    op.stage = 'exiting';
    // Ładunek przeszedł do `RestartOp`: przycisk znika z karty dopiero teraz (każda odmowa wyżej go zostawia).
    session.promptBlocked = undefined;
    supervisor.logRestart?.(
      key, op.reason, update === undefined ? undefined : `${update.running} → ${update.installed}`,
    );
    session.stateDetail = restartExitingDetail(update?.running);
    this.#port.emitSessionChanged(session);
    /*
     * Wynik `false` NIE znaczy „nie doszło": zerwane połączenie po wykonaniu `agent.prompt`
     * wygląda tak samo jak odmowa. Los procesu ustala więc zawsze
     * `#completeRestart` z trzech źródeł — proces zniknął → start, został → restart przerwany
     * z notką. Ponownego `/exit` nie ma nigdy.
     */
    await driver.requestExit?.();
    void this.#completeRestart(session, op).catch((error: unknown) => {
      this.#config.logger?.(`rarog: session restart ${id} failed: ${describeError(error)}`);
    });
    return { sessionId: id };
  }

  /**
   * Bramki restartu, które wymagają odczytu (pkt B planu). Nic nie wysyła.
   *
   * @returns opcje startu nowego procesu — `--resume` tej rozmowy, effort ostatniej tury,
   *   DOKŁADNY tryb ze stopki. Bez `--model`: CLI przywraca model rozmowy sam (zmierzone),
   *   a alias rodziny zwinąłby starszy model do bieżącego.
   */
  async #restartPreflight(
    session: Session, driver: SessionDriver, engineSessionId: string,
    update: { running: string; installed: string } | undefined,
  ): Promise<LaunchOptions> {
    const stillOurs = (): boolean => (
      this.#port.sessions.get(session.id) === session && session.driver === driver
    );
    // Plik rozmowy MUSI istnieć i należeć do tego katalogu: `--resume` sesji bez jsonl kończy
    // się „No conversation found" — już PO zabiciu procesu (zmierzone).
    await this.#assertTranscriptOwned(session.cwd, engineSessionId);

    const probe = await driver.restartProbe?.();
    if (probe === undefined || !stillOurs()) throw new BadStateError(RESTART_NO_PANEL_MESSAGE);
    if (probe.agent === null || probe.agent.agentSessionId !== engineSessionId) {
      throw new BadStateError(RESTART_PANEL_CHANGED_MESSAGE);
    }
    // Świeży status z gniazda, bez karencji 1,5 s nadzorcy: tura odpalona przed chwilą przy
    // biurku odmawia tutaj, zamiast dostać `/exit` w środek.
    if (probe.agent.status !== 'idle' && probe.agent.status !== 'done') {
      throw new BadStateError(RESTART_BUSY_MESSAGE);
    }
    /*
     * Pole pełne, bo CLI włożył do niego NASZ prompt zablokowany przez hook: driver ma na to zgodę
     * (`blockedLeftover`), więc pole wyczyści — ale dopiero na końcu, po WSZYSTKICH odczytach niżej. Każda
     * odmowa z odczytu (tryb, rejestr CLI, `claude agents`) zapada wtedy bez jednego klawisza. Bez zgody
     * pełne pole odmawia jak dotąd: to szkic człowieka przy Macu.
     */
    const leftover = probe.composer === 'filled' && driver.blockedLeftover === true
      && driver.clearBlockedLeftover !== undefined;
    if (probe.composer === 'filled' && !leftover) throw new BadStateError(restartComposerMessage(this.#system));
    if (probe.composer !== 'empty' && probe.composer !== 'filled') {
      throw new BadStateError(RESTART_COMPOSER_UNKNOWN_MESSAGE);
    }
    const permissionMode = restartPermissionMode(probe.mode);
    if (permissionMode === null || permissionMode === undefined) {
      throw new BadStateError(RESTART_MODE_UNKNOWN_MESSAGE);
    }
    this.#port.assertPermissionMode(session.cwd, permissionMode);

    // Rejestr procesów CLI: dokładnie jeden żywy proces tej rozmowy, bezczynny, na tym
    // wydaniu, które pokazuje pigułka. `shell` = powłoka w tle, którą `/exit` by ubił.
    const snapshot = await this.#config.cliVersionReader?.().catch(() => null);
    const entries = snapshot?.registry?.get(engineSessionId);
    if (entries === undefined || entries.length === 0) {
      throw new BadStateError(RESTART_UNVERIFIED_MESSAGE);
    }
    const [entry] = entries;
    if (entries.length > 1 || entry === undefined) throw new BadStateError(RESTART_WRITERS_MESSAGE);
    if (entry.status === 'shell') throw new BadStateError(RESTART_TASKS_MESSAGE);
    if (entry.status !== 'idle') throw new BadStateError(RESTART_BUSY_MESSAGE);
    // Wydanie z pigułki porównujemy tylko przy aktualizacji; restart po blokadzie bywa na tym samym.
    if (update !== undefined && entry.version !== update.running) {
      throw new BadStateError(RESTART_UNVERIFIED_MESSAGE);
    }

    // `claude agents --json` MUSI odpowiedzieć: cisza czytnika przy zwykłym wznowieniu
    // nie blokuje, ale restart sam zabija proces — bez drugiego źródła nie wie, czy po `/exit`
    // nie zostanie drugi pisarz spoza herdr.
    const cliLive = await this.#modules.liveSessions({ fresh: true });
    if (cliLive === null || !cliLive.has(engineSessionId)) {
      // Ślad w logu: „spróbuj za chwilę" nie pomoże, gdy sonda milczy zawsze (np. `claude`
      // spoza `PATH` launchd) — bez tej linii jedynym objawem byłaby odmowa w apce.
      this.#config.logger?.(`rarog: restart ${session.id} refused — claude agents --json: `
        + (cliLive === null ? 'no response' : 'conversation not on the list'));
      throw new BadStateError(RESTART_UNVERIFIED_MESSAGE);
    }
    if (!stillOurs()) throw new BadStateError(RESTART_NO_PANEL_MESSAGE);
    if (leftover) {
      // Driver sam czyta jeszcze raz status i rozmowę (Esc w turze by ją przerwał) i zgodę na pole.
      const cleared = await driver.clearBlockedLeftover?.(engineSessionId) ?? 'stale';
      if (!stillOurs()) throw new BadStateError(RESTART_NO_PANEL_MESSAGE);
      const refusal = restartLeftoverRefusal(cleared, this.#system);
      if (refusal !== null) throw new BadStateError(refusal);
    }
    return {
      cwd: session.cwd,
      resumeFrom: engineSessionId,
      sessionId: session.id,
      permissionMode,
      ...(session.effort !== undefined ? { effort: session.effort } : {}),
      ...resumeUltracodeOf(session),
    };
  }

  /** Plik rozmowy istnieje i leży w katalogu karty — `#assertResumable` z `launch-gate.ts` bez żywotności. */
  async #assertTranscriptOwned(cwd: string, engineSessionId: string): Promise<void> {
    const source = this.#config.herdrDeps?.resumeSource;
    if (source === undefined) throw new BadRequestError(RESUME_UNVERIFIABLE_MESSAGE);
    const root = this.#config.transcriptRoot ?? defaultStoreRoot();
    const file = await source.locate(root, cwd, engineSessionId);
    if (file === null) throw new BadRequestError(RESUME_NOT_FOUND_MESSAGE);
    const fileCwd = await source.cwdOf(file);
    if (fileCwd === null || !transcriptCwdBelongs(fileCwd, cwd)) {
      throw new BadRequestError(RESUME_FOREIGN_CWD_MESSAGE);
    }
  }

  /**
   * Czy proces rozmowy zniknął ze WSZYSTKICH trzech źródeł: herdr (`agent.list`), rejestr
   * procesów CLI i `claude agents --json`. Każde „nie wiem" = „jeszcze nie".
   */
  async #restartProcessGone(engineSessionId: string): Promise<boolean> {
    const live = await this.#requireSupervisor().liveEngineSessions().catch(() => null);
    if (live === null || live.has(engineSessionId)) return false;
    const snapshot = await this.#config.cliVersionReader?.().catch(() => null);
    if (snapshot?.registry === null || snapshot?.registry === undefined) return false;
    if (snapshot.registry.has(engineSessionId)) return false;
    const cliLive = await this.#modules.liveSessions({ fresh: true });
    return cliLive !== null && !cliLive.has(engineSessionId);
  }

  /** Czekanie po `/exit` i start nowego procesu — po odpowiedzi HTTP, wynik po SSE. */
  async #completeRestart(session: Session, op: RestartOp): Promise<void> {
    const options = op.options;
    const engineSessionId = options?.resumeFrom;
    if (options === undefined || engineSessionId === undefined) return;
    const timeoutMs = this.#config.restartTiming?.exitTimeoutMs ?? RESTART_EXIT_TIMEOUT_MS;
    const pollMs = this.#config.restartTiming?.pollMs ?? RESTART_EXIT_POLL_MS;
    const deadline = this.#port.now() + timeoutMs;
    let gone = false;
    while (!gone && this.#port.now() < deadline) {
      await new Promise<void>((resolveSleep) => { setTimeout(resolveSleep, pollMs); });
      if (this.#port.disposed() || this.restarts.get(session.id) !== op) return;
      /*
       * CLI zapytał przy wyjściu (zmierzone: „Background work is running … Esc to
       * cancel" przy powłoce w tle) — Esc to „Stay": proces zostaje i nic nie ginie. Esc na
       * nieznanym dialogu też niczego nie zatwierdza, więc jeden klawisz jest bezpieczny.
       * The task lines of that dialog are read BEFORE the Esc. Esc goes whatever the read gives, and the read has its
       * own time limit, so a stuck read does not hold the restart.
       */
      const driver = session.driver;
      if (driver !== null && (session.state === 'waiting-permission' || session.herdrDialog !== undefined)) {
        const tasks = await this.#readExitTasks(driver);
        await driver.interrupt().catch(() => false);
        const count = tasks === null ? 'task list not read'
          : `${String(tasks.length)} background ${tasks.length === 1 ? 'task' : 'tasks'}`;
        this.#config.logger?.(`rarog: restart ${session.id} canceled — Claude Code asked on exit (${count})`);
        this.#abortRestart(session, op, 'restart.exit-asked', restartExitTasksNotice(tasks));
        return;
      }
      gone = await this.#restartProcessGone(engineSessionId);
    }
    if (this.#port.disposed() || this.restarts.get(session.id) !== op) return;
    if (!gone) {
      // Karta bez drivera = herdr już pokazał koniec; brak potwierdzenia z rejestru to
      // „nie wiem", więc NIE startujemy — „Wznów" za chwilę przejdzie zwykłe bramki wznowienia.
      this.#abortRestart(
        session, op,
        session.driver === null ? 'restart.exit-unconfirmed' : 'restart.exit-timeout',
      );
      return;
    }
    // Push `gone` z nadzorcy zwykle zdążył; jeśli nie — domykamy kartę tą samą drogą.
    if (session.driver !== null) this.#port.herdrGone(op.key);
    op.stage = 'launching';
    try {
      await this.#port.recreate(session, options, true);
    } catch (error: unknown) {
      // `#recreate` przywrócił kartę (`resumable` z `#herdrGone`) — dopisujemy powód.
      this.restarts.delete(session.id);
      if (this.#port.sessions.get(session.id) === session) {
        session.stateDetail = restartFailedDetail(error);
        this.#port.emitSessionChanged(session);
      }
    }
    // Dalej prowadzi `#finishLaunch` nowej karty — rezerwacja zostaje do jego rozstrzygnięcia.
  }

  /**
   * Task lines of the exit dialog from the driver (`readExitTasks`), or `null` when the driver has no such read, the
   * read fails, or it does not answer within the limit.
   */
  async #readExitTasks(driver: SessionDriver): Promise<readonly string[] | null> {
    if (driver.readExitTasks === undefined) return null;
    const limitMs = this.#config.restartTiming?.dialogReadMs ?? RESTART_EXIT_DIALOG_READ_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolveLate) => { timer = setTimeout(() => { resolveLate(null); }, limitMs); });
    try {
      return await Promise.race([driver.readExitTasks().catch(() => null), late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Restart przerwany PRZED startem nowego procesu: rezerwacja zdjęta, detail mówi dlaczego.
   * Slot throttle'a NIE wraca — `/exit` już poszedł, czyli gest coś w panelu zrobił.
   * `notice` replaces the detail and the note of `reason` (the exit dialog with its task lines).
   */
  #abortRestart(
    session: Session, op: RestartOp, reason: RestartExitCode,
    notice: { detail: ServerSentence; note: ServerSentence } | null = null,
  ): void {
    if (this.restarts.get(session.id) === op) this.restarts.delete(session.id);
    if (this.#port.sessions.get(session.id) !== session) return;
    // Detail gaśnie przy najbliższym przejściu stanu, więc powód idzie też do transkryptu —
    // tam zobaczy go każde urządzenie i po powrocie do sesji.
    session.stateDetail = notice?.detail ?? say(reason);
    const note = notice?.note ?? say('restart.exit-note', { reason });
    this.#port.appendMessage(session, 'system', [{ type: 'text', text: note }]);
    this.#port.emitSessionChanged(session);
  }

  /**
   * Nowy proces gotowy, sesja bez promptu startowego: rezerwacja zdjęta, notka w transkrypcie
   * i sprzątnięcie starego taba z gołą powłoką. Porażka sprzątania nie jest porażką restartu — tab zostaje.
   */
  async finishRestart(session: Session, op: RestartOp): Promise<void> {
    if (this.restarts.get(session.id) === op) this.restarts.delete(session.id);
    await this.noteRestart(session, op);
    await this.closeRestartTab(session, op);
  }

  /**
   * Notka po restarcie. Przy aktualizacji z wydaniem procesu z rejestru — świeży odczyt, bo pigułka
   * ma zgasnąć, a notka powiedzieć, czy nowy proces naprawdę wstał na nowym wydaniu. Bez aktualizacji
   * (restart po blokadzie promptu) wydania nie ma czego porównywać.
   */
  async noteRestart(session: Session, op: RestartOp): Promise<void> {
    let note = RESTART_DONE_NOTE;
    const update = op.update;
    if (update !== undefined) {
      await this.#modules.cli.cliTick();
      const running = runningCliVersion(this.#modules.cli.cliVersion.registry, session.engineSessionId);
      if (running === undefined) note = say('restart.update-version-unverified', { version: update.running });
      else if (running === update.running) note = say('restart.update-not-applied', { version: update.running });
      else note = say('restart.done.version', { version: running });
    }
    if (this.#port.sessions.get(session.id) === session) {
      this.#port.appendMessage(session, 'system', [{ type: 'text', text: note }]);
      this.#port.emitSessionChanged(session);
    }
  }

  /** Stary tab z gołą powłoką po udanym restarcie — porażka sprzątania nie jest porażką restartu. */
  async closeRestartTab(session: Session, op: RestartOp): Promise<void> {
    try {
      await this.#config.herdrSupervisor?.closeShellTab?.(op.tabId, session.cwd);
    } catch (error: unknown) {
      this.#config.logger?.(`rarog: old tab stays after restart: ${describeError(error)}`);
    }
  }
}

/**
 * Ultracode wznowienia i restartu karty: karta wie lepiej niż plik, bo jej stan liczy znaczniki
 * bieżącego procesu CLI, a nowy proces ultracode po pliku nie dziedziczy (wznowienie bez flagi na CLI 2.1.318:
 * fixture `ultracode/wznowienie-bez-flagi.jsonl`). `true` dziedziczymy, o ile poziom rozmowy to `xhigh` (inaczej,
 * albo przy odmowie bramki wersji, start bez ultracode i zdanie systemowe, `#launch`); `false` blokuje
 * dziedziczenie z pliku, brak wiedzy zostawia decyzję plikowi rozmowy (`resumeStartOptions` w `launch-gate.ts`).
 */
export function resumeUltracodeOf(session: Session): { ultracode?: boolean; ultracodeInherited?: boolean } {
  if (session.ultracode === true) return { ultracode: true, ultracodeInherited: true };
  return session.ultracode === false ? { ultracode: false } : {};
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
