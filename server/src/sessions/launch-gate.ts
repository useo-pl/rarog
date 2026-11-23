/**
 * Launch gate of the session manager: every check that can refuse a new herdr session before anything exists on the
 * other side (directory, permission mode, model, pane cap, launch switch, resume checks, ultracode, start prompt), in
 * that order, the launch slots (one per 5 s and an hourly cap, "Starting sessions from the phone: three powers" in
 * `docs/security-model.md`) and the start options of a resume.
 * The manager owns one {@link LaunchGate} and gives it a narrow {@link LaunchGatePort}. The pane, the card and the
 * second half of the start (`#finishLaunch`: readiness, the start prompt waiting for a start dialog, session restarts)
 * stay in the manager. This module does not import `manager.ts`.
 */
import { resolve } from 'node:path';
import type { EffortLevel, MessageAttachment } from '@rarog/shared';
import type { ServerSystem } from '@rarog/shared/rest';
import type { ServerSentence } from '@rarog/shared/sentences';
import type { CreateSessionOptions } from './manager-api.ts';
import type { CliRegistryState } from './cli-registry.ts';
import { BadRequestError, BadStateError, TooManyRequestsError, UltracodeRefusedError } from './errors.ts';
import {
  HERDR_DOUBLE_WRITER_MESSAGE, HERDR_LAUNCH_OFF_MESSAGE, RESUME_FOREIGN_CWD_MESSAGE, RESUME_NOT_FOUND_MESSAGE,
  RESUME_UNVERIFIABLE_MESSAGE, ULTRACODE_CLI_UNKNOWN_MESSAGE, ULTRACODE_EFFORT_MESSAGE, launchThrottledMessage,
  transcriptCwdBelongs, ultracodeCliTooOldMessage,
} from './state-sentences.ts';
import { HERDR_LAUNCH_HOURLY_CAP, HERDR_LAUNCH_MIN_INTERVAL_MS } from '../config.ts';
import { compareCliVersions } from '../cli-version.ts';
import { defaultStoreRoot } from '../cli-store.ts';
import type { LiveSessionsReader } from '../live-sessions.ts';
import type { InternalBlock } from '../drivers/types.ts';
import { HERDR_PANE_CAP_MESSAGE } from '../herdr/types.ts';
import type { HerdrSupervisor } from '../herdr/types.ts';
import { ULTRACODE_MIN_CLI } from '../herdr/ultracode.ts';
import type { CommandCatalog, SendableOptions, SendableText } from '../herdr/commands/index.ts';
import type { ResumeSettings } from '../herdr/jsonl-pending.ts';

/** Fields of the manager configuration the launch gate reads (`ManagerConfig`, described there). */
export interface LaunchGateConfig {
  readonly demo: boolean;
  readonly maxPanes?: number;
  readonly transcriptRoot?: string;
  readonly launchThrottle?: { minIntervalMs?: number; hourlyCap?: number };
  readonly yoloRoots?: readonly string[];
  readonly realPath?: (candidate: string) => string;
  /** The transcript reader of `HerdrManagerDeps` (`resumeSource`); missing = every resume is refused. */
  readonly herdrDeps?: {
    readonly resumeSource?: {
      locate(root: string, cwd: string, engineSessionId: string): Promise<string | null>;
      cwdOf(file: string): Promise<string | null>;
      settingsOf?(file: string): Promise<ResumeSettings>;
    };
  };
}

/** What the launch gate reaches in the manager: checks shared with other actions and the readings listed below. */
export interface LaunchGatePort {
  readonly now: () => number;
  /** The installed Claude Code release (CLI registry): the ultracode gate and the command catalog of a new pane. */
  readonly cli: Pick<CliRegistryState, 'cliVersion'>;
  /** Server machine for the machine word in sentences (manager `#system`). */
  readonly system: () => ServerSystem;
  /** `claude agents --json` reader of the manager (second side of the double-writer check). */
  readonly liveSessions: LiveSessionsReader;
  readonly requireSupervisor: () => HerdrSupervisor;
  /** Directory allow-list (manager `#assertAllowedCwd`, also used by resume lists and restarts). */
  readonly assertAllowedCwd: (cwd: string) => void;
  /** `bypassPermissions` only under `RAROG_YOLO_ROOTS` (manager `#assertPermissionMode`). */
  readonly assertPermissionMode: (cwd: string, mode: string | undefined) => void;
  /** Model allow-list (manager `#assertKnownModel`, also used by the model change). */
  readonly assertKnownModel: (model: string | undefined) => void;
  /** Command catalog of a directory for a CLI release (manager `#commandCatalog`). */
  readonly commandCatalog: (cwd: string, cliVersion: string | null) => CommandCatalog;
  /** Text guard before anything goes to a pane (manager `#checkSendable`, the send path). */
  readonly checkSendable: (text: string, key: string | null, cwd: string, opts: SendableOptions) => SendableText;
}

/** A launch that passed every check: options merged with the conversation file and the guarded start prompt. */
export interface LaunchAdmission {
  readonly opts: LaunchOptions;
  /** Model of the resumed conversation, which seeds the card. */
  readonly resumeModelSeed: string | undefined;
  /** The conversation had ultracode and the new process starts without it: a system line on the new card. */
  readonly ultracodeDropped: boolean;
  readonly prompt: (SendableText & { catalog: CommandCatalog }) | null;
}

/** Checks and launch slots of new herdr sessions; one instance per manager. */
export class LaunchGate {
  readonly #config: LaunchGateConfig;
  readonly #port: LaunchGatePort;
  /** Czasy udanych `launch()` w oknie godzinnym — throttle zakładania paneli
   * („Starting sessions from the phone: three powers” w `docs/security-model.md`). */
  #launches: number[] = [];

  constructor(config: LaunchGateConfig, port: LaunchGatePort) {
    this.#config = config;
    this.#port = port;
  }

  /**
   * Every check of the manager's `#launch` that can refuse, in order, then the launch slot (unless a restart took it
   * already) and the start prompt guard. Nothing exists on the herdr side yet when this throws.
   */
  async admitLaunch(
    supervisor: HerdrSupervisor, opts: LaunchOptions, slotTaken: boolean,
  ): Promise<LaunchAdmission> {
    this.#port.assertAllowedCwd(opts.cwd);
    this.#port.assertPermissionMode(opts.cwd, opts.permissionMode);
    this.#port.assertKnownModel(opts.model);
    /*
     * Sufit paneli sprawdzamy PRZED `canLaunch`, choć logicznie jest węższy.
     *
     * Powód jest czysto ludzki: nadzorca gasi `canLaunch` z TRZECH różnych powodów (killswitch,
     * nieznany protokół, osiągnięty sufit), a komunikat może być tylko jeden. Przy odwrotnej
     * kolejności siódmy panel dostawał odpowiedź „zakładanie wyłączone” z nazwą killswitcha zakładania
     * — zdanie nieprawdziwe i prowadzące donikąd, zamiast „zamknij któryś panel".
     */
    if (supervisor.rarogPaneCount() >= (this.#config.maxPanes ?? Infinity)) {
      throw new BadStateError(HERDR_PANE_CAP_MESSAGE);
    }
    if (!supervisor.status().canLaunch) throw new BadStateError(HERDR_LAUNCH_OFF_MESSAGE);
    /*
     * `#assertResumable` PRZED `#takeLaunchSlot` — inaczej odbita walidacja paliła slot.
     *
     * Slot jest zasobem („jedno uruchomienie na 5 s"), a odrzucone żądanie NICZEGO nie
     * uruchomiło: po 400 („to sesja z innego katalogu") drugi, poprawny klik dostawał 429
     * i użytkownik czekał 5 s za cudzy błąd. Kolejność jest tu więc ta sama co dla reszty
     * sprawdzeń: najpierw wszystko, co może odmówić, potem dopiero zajmowanie czegokolwiek.
     */
    /*
     * Wznowienie domyka luki CLI (docs `sessions.md`, tabela trybu po wznowieniu): `--resume`
     * przywraca model sam, ale tryb Manual zamienia na `defaultMode` z ustawień, a rozwidlenie gubi tryb
     * plan. Brakujący tryb i effort bierzemy więc z pliku rozmowy — tego samego, który `#assertResumable` sprawdził
     * pod kątem katalogu — i PO scaleniu bramka trybu idzie jeszcze raz, na tym, co naprawdę trafi do argv.
     */
    let resumeModelSeed: string | undefined;
    // Ultracode z pliku rozmowy: `resumeStartOptions` daje je tylko przy ostatnim poziomie `xhigh`.
    let ultracodeFromFile = false;
    // Rozmowa miała ultracode, a wznowienie wstanie bez niego: zdanie systemowe na nowej karcie (pytanie 3 planu).
    let ultracodeDropped = false;
    if (opts.resumeFrom !== undefined) {
      const fromFile = await this.#assertResumable(opts);
      if (fromFile !== null) {
        const requested = opts;
        opts = { ...resumeStartOptions(fromFile, requested), ...definedOptions(requested) };
        ultracodeFromFile = requested.ultracode === undefined && opts.ultracode === true;
        if (ultracodeFromFile) opts = { ...opts, ultracodeInherited: true };
        // Plik mówi „on”, a rozmowa skończyła na innym poziomie: ultracode nie wraca (żądanie bez modelu).
        ultracodeDropped = fromFile.ultracode === true && requested.ultracode === undefined
          && requested.model === undefined && opts.ultracode !== true;
        resumeModelSeed = fromFile.model;
      }
      // Tryb karty jest ZAPASEM: wygrywa z nim plik, bo mówi o ostatniej turze, a nie o starcie karty.
      if (opts.permissionMode === undefined && opts.permissionModeFallback !== undefined) {
        opts = { ...opts, permissionMode: opts.permissionModeFallback };
      }
      this.#port.assertPermissionMode(opts.cwd, opts.permissionMode);
    }
    /*
     * Ultracode PO scaleniu z plikiem rozmowy: bramka ma widzieć poziom, który naprawdę trafi do argv.
     * Ultracode odziedziczone (plik rozmowy, karta przy „Wznów” i restarcie) przy odmowie znika ze zdaniem
     * systemowym, a start idzie dalej na poziomie rozmowy (pytanie 3 planu); żądane wprost dostaje 400.
     */
    if (opts.ultracode === true && opts.ultracodeInherited === true) {
      // Poziom rozmowy musi być `xhigh`: z karty albo żądania, a przy dziedziczeniu z pliku — z pliku.
      const levelKept = opts.effort === 'xhigh' || (opts.effort === undefined && ultracodeFromFile);
      if (!levelKept || this.#ultracodeLaunchRefusal(opts) !== null) {
        // Poziom `xhigh` z pliku jechał flagą ultracode; bez niej wraca jako zwykły `--effort xhigh`.
        const effort = opts.effort ?? (ultracodeFromFile ? 'xhigh' : undefined);
        opts = {
          ...opts, ultracode: undefined, ultracodeInherited: undefined, ...(effort !== undefined ? { effort } : {}),
        };
        ultracodeDropped = true;
      }
    }
    this.#assertUltracodeLaunch(opts);
    if (!slotTaken && !this.#takeLaunchSlot()) {
      throw new TooManyRequestsError(launchThrottledMessage(this.#port.system()));
    }

    /*
     * Prompt przechodzi przez guard PRZED `launch()`, żeby 400 wróciło na POST-a, a nie
     * zostawiło po sobie panelu z odrzuconym zdaniem. Tryb `'unknown'` jest tu celowy
     * i NIE jest tym samym co przy wysyłce do istniejącego panelu: panelu jeszcze nie ma,
     * więc nie ma czego czytać ze stopki — a tryb, w którym wstanie, wybiera właśnie
     * `#assertPermissionMode` dwie linie wyżej.
     */
    const rawPrompt = opts.prompt !== undefined && opts.prompt !== '' ? opts.prompt : null;
    // Nowy panel wstaje na wydaniu zainstalowanym, więc katalog komend liczymy dla niego.
    const catalog = rawPrompt === null ? null : this.#port.commandCatalog(opts.cwd, this.#port.cli.cliVersion.installed);
    const prompt = rawPrompt === null || catalog === null ? null : {
      ...this.#port.checkSendable(rawPrompt, null, opts.cwd, {
        mode: 'unknown', cwd: opts.cwd, yoloRoots: this.#config.yoloRoots ?? [], catalog,
        ...(this.#config.realPath !== undefined ? { realPath: this.#config.realPath } : {}),
      }),
      catalog,
    };
    return { opts, resumeModelSeed, ultracodeDropped, prompt };
  }

  /**
   * Throttle zakładania paneli: jeden na 5 s i 40 na godzinę
   * („Starting sessions from the phone: three powers” w `docs/security-model.md`).
   *
   * Osobny od throttle'a wysyłki, bo chroni przed czym innym: tam pty żywego panelu, tu prawo
   * URUCHOMIENIA PROCESU na Macu. Łapie pętlę w kodzie (retry, który sam siebie wywołuje).
   *
   * Chroni razem z sufitem paneli (domyślnie 30), a nie zamiast niego — i podział jest
   * wiążący: throttle liczy TEMPO, sufit liczy SUMĘ. Proces pełzający w tempie poniżej progu
   * (40/h) przechodzi tędy bez zatrzymania i zatrzyma go dopiero sufit.
   */
  #takeLaunchSlot(): boolean {
    return this.takeLaunchSlotAt() !== null;
  }

  /** Jak {@link #takeLaunchSlot}, ale oddaje znacznik slotu — do zwrotu przez restart. */
  takeLaunchSlotAt(): number | null {
    const at = this.#port.now();
    const minInterval = this.#config.launchThrottle?.minIntervalMs ?? HERDR_LAUNCH_MIN_INTERVAL_MS;
    const hourlyCap = this.#config.launchThrottle?.hourlyCap ?? HERDR_LAUNCH_HOURLY_CAP;
    const last = this.#launches[this.#launches.length - 1];
    if (last !== undefined && at - last < minInterval) return null;
    this.#launches = this.#launches.filter((ts) => at - ts < 3_600_000);
    if (this.#launches.length >= hourlyCap) return null;
    this.#launches.push(at);
    return at;
  }

  /**
   * Zwrot slotu zajętego przez restart, który odmówił PRZED `/exit`. Odmowa niczego
   * nie uruchomiła — ta sama reguła co „`#assertResumable` przed slotem" w `create()`.
   */
  releaseLaunchSlot(at: number): void {
    const index = this.#launches.lastIndexOf(at);
    if (index >= 0) this.#launches.splice(index, 1);
  }

  /**
   * Walidacja `resumeFrom` („Starting sessions from the phone: three powers” w `docs/security-model.md`) — DWIE rzeczy,
   * których sam regex uuida nie sprawdza.
   *
   * 1. Do jakiego katalogu należy ta sesja. `--resume <uuid z innego katalogu>` DZIAŁA, a jsonl
   *    dopisuje się do oryginalnego sluga — jedno pole w POST ładowałoby więc na telefon całą
   *    historię sesji spoza korzeni (cudzy klient, sekrety) i dopisywało do niej dalej.
   * 2. Czy ktoś już do tego pliku pisze. Źródłem prawdy jest `agent.list`, a NIE indeks w RAM:
   *    `#forgetHerdrSession` zdejmuje sesję z indeksu przy UKRYCIU, a ukryty panel żyje i pisze.
   */
  async #assertResumable(opts: CreateSessionOptions): Promise<ResumeSettings | null> {
    const engineSessionId = opts.resumeFrom;
    if (engineSessionId === undefined) return null;
    const source = this.#config.herdrDeps?.resumeSource;
    // Fail-closed: bez czym sprawdzić katalog nie wznawiamy niczego. To jest ta sama reguła,
    // co przy `#assertAllowedCwd` — granica bezpieczeństwa nie ma trybu „pewnie się uda".
    if (source === undefined) throw new BadRequestError(RESUME_UNVERIFIABLE_MESSAGE);

    const root = this.#config.transcriptRoot ?? defaultStoreRoot();
    const file = await source.locate(root, opts.cwd, engineSessionId);
    if (file === null) throw new BadRequestError(RESUME_NOT_FOUND_MESSAGE);
    const cwd = await source.cwdOf(file);
    if (cwd === null || !transcriptCwdBelongs(cwd, opts.cwd)) {
      throw new BadRequestError(RESUME_FOREIGN_CWD_MESSAGE);
    }
    // Druga linia: katalog startu panelu po `resolve` też musi leżeć w korzeniach. `cwd` z pliku
    // leży w nim (bramka wyżej), więc i w korzeniach. Jego samego nie sprawdzamy osobno, bo
    // `validateProjectCwd` wymaga istnienia, a worktree agenta bywa już skasowany.
    this.#port.assertAllowedCwd(resolve(opts.cwd));
    // Ustawienia czytamy dopiero z pliku, który przeszedł obie bramki katalogu. Błąd odczytu
    // odbija wznowienie (400 z `settingsOf`), jak błąd odczytu `cwd`: bez odczytu nie wiadomo, czy
    // potrzebna jest flaga trybu — a jej brak oddaje tryb ustawieniom CLI.
    const settings = source.settingsOf === undefined ? null : await source.settingsOf(file);
    // Rozwidlenie dostaje NOWY uuid, więc problemu podwójnego pisarza nie ma z definicji.
    if (opts.fork === true) return settings;
    const live = await this.#port.requireSupervisor().liveEngineSessions();
    if (live.has(engineSessionId)) throw new BadStateError(HERDR_DOUBLE_WRITER_MESSAGE);
    /*
     * Druga strona tej samej bramki: `agent.list` widzi WYŁĄCZNIE
     * panele herdr, a `claude` uruchomiony ręcznie w gołym tmuxie pisze do tego samego pliku
     * jsonl i przeszedłby tędy bez zatrzymania. `claude agents --json` widzi jedno i drugie.
     *
     * `null` znaczy „nie udało się ustalić" i NIE blokuje: bramką pozostaje wtedy to, co wie
     * herdr (`agent.list`). Cisza czytnika nie może
     * zabraniać wznawiania czegokolwiek.
     */
    // `fresh` — bramka nie może czytać z pamięci podręcznej listy: pięć sekund wystarczy,
    // żeby ktoś w tym czasie odpalił `claude --resume` w terminalu, a wtedy przepuszczamy
    // dokładnie to, przed czym ta bramka stoi.
    const cliLive = await this.#port.liveSessions({ fresh: true });
    if (cliLive?.has(engineSessionId) === true) {
      throw new BadStateError(HERDR_DOUBLE_WRITER_MESSAGE);
    }
    return settings;
  }

  /**
   * Bramka startu z ultracode, przed slotem i przed czymkolwiek po stronie herdr.
   *
   * Poziom: flaga `--effort ultracode` sama ustawia `xhigh`, więc inny poziom w tym samym żądaniu to sprzeczność
   * (kontrakt odrzuca ją już w ciele startu; to druga linia dla wznowienia i restartu). Wersja: panel wstaje na
   * wydaniu ZAINSTALOWANYM, więc liczy się ono, nie wydanie innych paneli; nieznane = 400, bez zgadywania. Demo
   * nie ma czytnika wersji i jawnie bramkę pomija (serwer demo App Review i XCUITest).
   *
   * @throws {UltracodeRefusedError} 400 `ultracode-refused` ze zdaniem odmowy
   */
  #assertUltracodeLaunch(opts: { ultracode?: boolean; effort?: EffortLevel }): void {
    const refusal = this.#ultracodeLaunchRefusal(opts);
    if (refusal !== null) throw new UltracodeRefusedError(refusal);
  }

  /** Zdanie odmowy startu z ultracode albo `null`, gdy start przejdzie (reguły: {@link #assertUltracodeLaunch}). */
  #ultracodeLaunchRefusal(opts: { ultracode?: boolean; effort?: EffortLevel }): ServerSentence | null {
    if (opts.ultracode !== true) return null;
    if (opts.effort !== undefined && opts.effort !== 'xhigh') return ULTRACODE_EFFORT_MESSAGE;
    if (this.#config.demo) return null;
    const installed = this.#port.cli.cliVersion.installed;
    if (installed === null) return ULTRACODE_CLI_UNKNOWN_MESSAGE;
    return compareCliVersions(installed, ULTRACODE_MIN_CLI) < 0 ? ultracodeCliTooOldMessage(installed) : null;
  }
}

/**
 * Opcje startu wewnątrz managera: `CreateSessionOptions` i tryb ZAPASOWY wznowienia karty — używany tylko
 * wtedy, gdy ani żądanie, ani plik rozmowy trybu nie mają. Do argv nie idzie wprost: `#launch` przepisuje pola.
 *
 * `promptDisplay`: dymek promptu startowego, gdy ten jest ponowną wysyłką promptu zablokowanego przez
 * hook — `prompt` niesie wtedy tekst dla CLI (z blokiem ścieżek załączników), a dymek pokazuje to, co pokazało
 * echo pierwszej wysyłki: zdanie bez ścieżek i wizytówki załączników. Klient tego pola nie ma.
 */
export type LaunchOptions = CreateSessionOptions & {
  permissionModeFallback?: string;
  promptDisplay?: PromptDisplay;
  /**
   * Ultracode pochodzi z wznowienia (plik rozmowy albo karta), nie z żądania: bramka startu przy odmowie
   * go zdejmuje ze zdaniem {@link RESUME_WITHOUT_ULTRACODE_MESSAGE}, zamiast odbić start 400.
   */
  ultracodeInherited?: boolean;
};

/** Dymek promptu startowego — bloki i wizytówki jak w echu wysyłki z Raroga. */
export interface PromptDisplay {
  readonly blocks: InternalBlock[];
  readonly attachments: readonly MessageAttachment[];
}

/** Opcje bez pól `undefined` — żeby rozsmarowanie na ustawieniach z pliku nie kasowało ich pustką. */
function definedOptions(opts: LaunchOptions): LaunchOptions {
  return Object.fromEntries(
    Object.entries(opts).filter(([, value]) => value !== undefined),
  ) as unknown as LaunchOptions;
}

/**
 * Surowe tryby CLI z pliku rozmowy, które przechodzą do `--permission-mode`. `Map`, nie obiekt: wartość
 * z pliku w rodzaju `constructor` trafiałaby w prototyp i kończyła wznowienie na 400 zamiast na `manual`.
 */
const RESUMABLE_PERMISSION_MODES: ReadonlyMap<string, CreateSessionOptions['permissionMode']> = new Map([
  ['default', 'manual'],
  ['manual', 'manual'],
  ['acceptEdits', 'acceptEdits'],
  ['auto', 'auto'],
  ['plan', 'plan'],
]);

/**
 * Flagi startu wznowienia z ustawień, na których rozmowa skończyła: effort i tryb, BEZ modelu.
 *
 * Modelu nie podajemy, bo `--resume` przywraca go sam (dokumentacja CLI),
 * a `resumeModel` zwinąłby starszy model rodziny do bieżącego. Tryb podajemy, bo CLI przywraca go
 * z wyjątkami: Manual wstaje w `defaultMode` z ustawień (u użytkownika `auto`), rozwidlenie gubi
 * plan. `bypassPermissions`, `dontAsk` i tryby nieznane dają JAWNE `manual`: pusta flaga oddałaby
 * tryb ustawieniom CLI, a tam `defaultMode` bywa `bypassPermissions` także poza `RAROG_YOLO_ROOTS`.
 * Effort z pliku nie idzie, gdy żądanie podaje własny model — inny model może go nie znać.
 *
 * Ultracode: `--resume` startuje proces bez ultracode, a wraca ono tylko flagą `--effort ultracode`,
 * która ustawia `xhigh`. Dziedziczymy je więc, BEZ effortu, wyłącznie wtedy, gdy ostatni znacznik rozmowy mówi
 * „on”, rozmowa skończyła na `xhigh`, a żądanie nie podaje własnego modelu; inaczej effort z pliku zostaje
 * i ultracode nie wraca (poziom z rozmowy wygrywa, Rarog go po cichu nie zmienia). Żądanie z własnym ultracode
 * nie bierze effortu z pliku: flaga i tak ustawi `xhigh`.
 */
export function resumeStartOptions(
  settings: ResumeSettings, request: { model?: string; ultracode?: boolean; ultracodeInherited?: boolean } = {},
): Pick<CreateSessionOptions, 'effort' | 'permissionMode'> & { ultracode?: boolean } {
  const permissionMode = settings.permissionMode === undefined
    ? undefined
    : RESUMABLE_PERMISSION_MODES.get(settings.permissionMode) ?? 'manual';
  const ownModel = request.model !== undefined;
  const inherit = !ownModel && request.ultracode === undefined && settings.ultracode === true;
  const ultracode = inherit && settings.effort === 'xhigh';
  // Ultracode żądane wprost ustawia poziom samo; odziedziczone z karty (`ultracodeInherited`) pyta o poziom rozmowy.
  const requestedUltracode = request.ultracode === true && request.ultracodeInherited !== true;
  const effort = ownModel || ultracode || requestedUltracode ? undefined : settings.effort;
  return {
    ...(effort !== undefined ? { effort } : {}),
    ...(ultracode ? { ultracode: true } : {}),
    ...(permissionMode !== undefined ? { permissionMode } : {}),
  };
}
