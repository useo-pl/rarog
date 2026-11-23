/**
 * The turn watchdog after a send and the send numbers, a module of the herdr driver.
 *
 * The module holds the watchdog timer, the local command whose end the driver announces itself, the send
 * numbers (accepted, executed, decided by a hook block) and the permission to clear a blocked prompt before a restart
 * . The send path, the stall guard and the field clearing stay in the facade `drivers/herdr-driver.ts`.
 */
import type { OwnText } from '@rarog/shared/sentences';
import type { Scheduler, TimerHandle } from '../runtime.ts';
import type { BlockedLeftoverClear, DriverEvent } from '../types.ts';
import type { HerdrAgentStatus, HerdrClient } from '../../herdr/types.ts';
import type { FollowEvent } from '../../herdr/jsonl-follow.ts';
import type { SlashCommand } from '../../herdr/commands/index.ts';
import { STALLED_PROMPT_MESSAGE, composerRegionState, quietCommandMessage } from './commands.ts';

/** Driver dependencies the turn guard reads; the same fields as in the driver's deps. */
export interface TurnGuardDeps {
  readonly client: Pick<HerdrClient, 'getAgent' | 'readScreen'>;
  readonly markSent?: (key: string) => void;
  readonly promptBlock?: boolean;
}

export interface TurnGuardConfig {
  readonly deps: TurnGuardDeps;
  readonly scheduler: Scheduler;
  readonly key: string;
  readonly turnWatchdogMs: number;
}

/** Driver state the turn guard reads and the steps that stay in the facade. */
export interface TurnGuardPort {
  disposed(): boolean;
  status(): HerdrAgentStatus;
  /** Effective block (herdr or the form fallback hold), not the raw status. */
  blockedNow(): boolean;
  /** When the conversation file last showed a sign of life. */
  lastFollowAt(): number;
  paneId(): string;
  emitState(status: HerdrAgentStatus): void;
  emit(event: DriverEvent): void;
  system(text: OwnText): void;
  /** The deferred echo did not reach the pane: echo back to the manager. */
  refuseEcho(echo: string | undefined): void;
  /** The facade's flag "Rarog left text in the field" (after `ctrl+c`, a hook block, a stall). */
  readonly leftover: { needsEscape: boolean };
  /** From now on the transcript file may appear. */
  expectTranscript(): void;
  /** A step in the driver's chain. */
  enqueue<T>(step: () => Promise<T>): Promise<T | undefined>;
  /** The Esc pair only on a confirmed full field, stopped when `stop()` says so. */
  clearComposer(echo?: string, stop?: () => boolean): Promise<boolean>;
}

export class TurnGuard {
  readonly #deps: TurnGuardDeps;
  readonly #scheduler: Scheduler;
  readonly #key: string;
  readonly #turnWatchdogMs: number;
  readonly #port: TurnGuardPort;

  /** Watchdog tury po wysyłce — jeden, nadpisywany kolejną wysyłką. */
  #watchdogTimer: TimerHandle | null = null;
  /**
   * Komenda LOKALNA wysłana z Raroga, której koniec driver ogłasza sam: `/context`
   * nie startuje tury, więc herdr nie zgłosi `idle → idle` i sesja stałaby w „pracuje” do resyncu. Wynik
   * komendy w pliku albo watchdog kończą ją stanem z herdr (`#finishLocalCommand`). Zakładana PRZED
   * wysyłką (`followAt` = chwila sprzed `prompt`, bo wynik potrafi przyjść, zanim gniazdo odpowie),
   * `armed` po uzbrojeniu watchdoga tej wysyłki; nadpisuje ją każda następna wysyłka. `generation` to numer
   * wysyłki z `send()`: gdy w kolejce czeka już nowsza ({@link sendGeneration}), koniec tej komendy stanu
   * nie ogłasza — manager trzyma `running` nowszej wysyłki.
   */
  localCommand: {
    name: string; followAt: number; output: boolean; armed: boolean; generation: number;
  } | null = null;
  /** Numer ostatniej wysyłki przyjętej przez `send()` (rośnie synchronicznie, przed kolejką). */
  sendGeneration = 0;
  /*
   * Prompt zablokowany przez hook `UserPromptSubmit` (`docs/dialogs.md`, „Prompt blocked by a hook”).
   *
   * Numer wysyłki rośnie przy PRZYJĘCIU (`send()`), a zadanie wykonuje się później w kolejce, więc o tym,
   * której wysyłki dotyczy blokada z pliku, mówi para klucz echa → numer: zadanie zapisuje numer we wpisie
   * okna echa (`dropEcho(…, generation)`), a follower oddaje go z trafionego wpisu. Wpis znika razem z echem
   * (zwykły wpis `user`, przycięcie okna, TTL), więc numer nie wskaże wysyłki, która doszła.
   * Liczy się wyłącznie blokada wysyłki OSTATNIO WYKONANEJ ({@link executedGeneration}).
   */
  /** Numer wysyłki, której zadanie ostatnio doszło do `prompt` (zapis echa); `0` = żadnej. */
  executedGeneration = 0;
  /**
   * Wysyłka, którą rozstrzygnęła blokada hooka (`0` = żadna): jej zadanie kończy się bez zerowania
   * `#needsEscape`, bez watchdoga i bez „prompt utknął”, a stall-guard bez pary Esc i drugiego `prompt`.
   */
  #blockedSend = 0;
  /**
   * Pole promptu trzyma NASZ zablokowany prompt (CLI włożył go z powrotem): numer wysyłki albo `null`. To
   * zgoda na wyczyszczenie pola przed restartem sesji (`clearBlockedLeftover`). Gasi ją zadanie
   * następnej wysyłki, przerwanie, nowa rozmowa w panelu (`session-changed`), wpis `user` albo wejście tury
   * z pliku (ktoś wysłał prompt przy Macu) i próba czyszczenia. Status `working` jej NIE gasi: herdr potrafi
   * mignąć `working` zaraz po blokadzie.
   */
  blockedLeftover: number | null = null;
  /** Numer wysyłki, której watchdog tury stoi ({@link #watchdogTimer}); `0` = żadnej. */
  #watchdogGeneration = 0;
  /**
   * Ile razy herdr zgłosił panel w turze (`working`/`blocked`). Czyszczenie pola przed restartem
   * przerywa się, gdy licznik ruszy po jego świeżym `agent.get`: człowiek przy Macu wysłał prompt z pola,
   * a plik jeszcze tego nie pokazał — para Esc przerwałaby jego turę.
   */
  turnEntries = 0;

  constructor(config: TurnGuardConfig, port: TurnGuardPort) {
    this.#deps = config.deps;
    this.#scheduler = config.scheduler;
    this.#key = config.key;
    this.#turnWatchdogMs = config.turnWatchdogMs;
    this.#port = port;
  }

  /** Clears the turn watchdog timer (`interrupt()`, `dispose()`). */
  clearWatchdog(): void {
    if (this.#watchdogTimer !== null) {
      this.#scheduler.clearTimeout(this.#watchdogTimer);
      this.#watchdogTimer = null;
    }
  }

  /**
   * Prompt doszedł do panelu (`agent.prompt` albo Enter wklejonej wiadomości): księgowość po wysyłce.
   *
   * @param blocked wysyłkę rozstrzygnęła już blokada hooka (stall-guard)
   * @param silentInTurn a command the CLI ran inside the running turn without a transcript entry: no watchdog of its
   *   own, the turn's watchdog stays and herdr's state change ends the turn
   */
  afterSubmit(
    blocked: boolean, slash: SlashCommand | null, echo: string | undefined, generation: number,
    silentInTurn = false,
  ): void {
    // Od tej chwili plik transkryptu MA prawo powstać — dopiero teraz jego brak jest
    // informacją dla człowieka. Przed pierwszą wysyłką cisza w magazynie CLI jest
    // normalnym stanem panelu, który stoi i czeka.
    this.#port.expectTranscript();
    /*
     * Blokada hooka przyszła przed końcem zadania (stall-guard albo `wait` zakończony `ok`, a herdr mignął
     * `working` ~30 ms po wpisie): CLI włożył prompt z powrotem do pola, więc `#needsEscape` ZOSTAJE (ustawiła
     * je blokada), tury nie ma, więc bez watchdoga i bez karencji `idle` w nadzorcy.
     */
    if (blocked || this.#blockedSend === generation) {
      this.localCommand = null;
      return;
    }
    this.#port.leftover.needsEscape = false;
    this.#deps.markSent?.(this.#key);
    if (silentInTurn) return;
    // Watchdog dopiero PO udanej wysyłce: „wysłane, a panel nie ruszył" jest faktem tylko
    // wtedy, gdy naprawdę było wysłane. Slash-komenda idzie z własną nazwą, bo dla NIEJ
    // cisza jest normalnym końcem, a nie awarią (`quietCommandMessage`).
    this.armTurnWatchdog(slash, echo, generation);
  }

  /** Czy blokada hooka rozstrzygnęła już tę wysyłkę ({@link #blockedSend}). */
  sendBlocked(generation: number): boolean {
    return this.#blockedSend === generation;
  }

  /**
   * Prompt utknął na dobre: composer wraca do życia, tekst zostaje w polu panelu.
   *
   * `idle` emitujemy WYŁĄCZNIE, gdy herdr faktycznie widzi panel bezczynny: `AGENT_IDLE_FROM`
   * maszyny stanów zawiera `waiting-permission`, więc bezwarunkowe `idle` przy panelu, który
   * w międzyczasie stanął na dialogu, zgasiłoby kartę zgody. Przy `unknown` zostaje sama
   * wiadomość — nie zgadujemy.
   */
  reportStalledPrompt(): false {
    this.#port.leftover.needsEscape = true;
    this.#port.system(STALLED_PROMPT_MESSAGE);
    const status = this.#port.status();
    if (status === 'idle' || status === 'done') this.#port.emitState(status);
    return false;
  }

  /**
   * Watchdog tury — siatka bezpieczeństwa pod stall-guardem.
   *
   * Manager po wysyłce przechodzi optymistycznie w `running`, a korekta może przyjść tylko ze
   * zdarzenia statusu herdr — którego przy `idle` → `idle` NIGDY nie będzie (supervisor emituje
   * wyłącznie zmiany). Fałszywy sukces `wait`, inna semantyka herdr albo zgubiony push
   * zostawiłyby więc sesję w wiecznym „pracuje" (zmierzone: 7 minut nad pustym
   * panelem). Po `turnWatchdogMs` ciszy — zero ruchu w plikach, panel nie `working`/`blocked` —
   * mówimy o tym głośno i oddajemy composer.
   *
   * @param slash slash-komenda, jeśli to ona była wysyłką. Composer wraca tak samo, ale zdanie jest
   *   INNE: dla komendy cisza jest normalnym końcem, nie awarią wysyłki
   *   (`quietCommandMessage`), więc zdanie zobaczą wyłącznie komendy, które nie ruszyły pliku.
   *
   * Komenda LOKALNA nie kończy się na pierwszym ruchu w pliku, bo właśnie ten ruch jest
   * jej wynikiem, a stanu herdr po nim nie zmieni (`idle → idle`): watchdog czeka pełny czas i przy
   * panelu bez tury i bez blokady ogłasza stan z herdr — wcześniej robi to wynik tej komendy
   * (`noteCommandOutput`). `/compact` wchodzi w `working` i kończy się zwykłym przejściem herdr.
   */
  armTurnWatchdog(slash: SlashCommand | null, echo: string | undefined, generation: number): void {
    if (this.#watchdogTimer !== null) this.#scheduler.clearTimeout(this.#watchdogTimer);
    this.#watchdogTimer = null;
    this.#watchdogGeneration = generation;
    const command = slash === null ? null : `/${slash.name}`;
    const local = slash?.kind === 'local' ? this.localCommand : null;
    if (local !== null) {
      local.armed = true;
      // Wynik przyszedł, zanim wróciła odpowiedź gniazda: koniec od razu, bez czekania na watchdog.
      if (local.output && this.#finishLocalCommand()) return;
    }
    const followAt = local?.followAt ?? this.#port.lastFollowAt();
    this.#watchdogTimer = this.#scheduler.setTimeout(() => {
      this.#watchdogTimer = null;
      if (this.#port.disposed()) return;
      if (local !== null && this.localCommand === local) this.localCommand = null;
      // `#blockedNow`, nie surowy status: formularz bez blokady herdr to agent czekający
      // na człowieka, a nie wysyłka, która utknęła.
      const status = this.#port.status();
      if (status === 'working' || this.#port.blockedNow()) return;
      if (this.#port.lastFollowAt() > followAt) {
        // Plik przyniósł coś po komendzie lokalnej, a panel stoi: to był jej koniec — o ile za nią
        // nie czeka już nowsza wysyłka.
        if (
          local !== null && local.generation === this.sendGeneration
          && (status === 'idle' || status === 'done')
        ) this.#port.emitState(status);
        return;
      }
      if (command !== null) {
        this.#reportQuietCommand(command);
        return;
      }
      // Prompt z echem odroczonym stoi w composerze, a nie w pliku — manager spłukuje go pod
      // ostrzeżeniem. Już podstawiony (token zużyty) manager pomija.
      this.#port.refuseEcho(echo);
      this.reportStalledPrompt();
    }, this.#turnWatchdogMs);
  }

  /**
   * Cichy koniec slash-komendy: composer wraca, `#needsEscape` NIE.
   *
   * Uzbrojenie Esc jest tu wprost szkodliwe — komenda mogła otworzyć w panelu dialog
   * (`/agents`, `/context`), a Esc przed następną wysyłką zamknąłby go bez pytania.
   * Stan emitujemy tą samą regułą co przy stallu: tylko `idle`/`done`, żeby nie zgasić karty
   * zgody, gdyby panel w międzyczasie na czymś stanął.
   */
  #reportQuietCommand(command: string): void {
    this.#port.system(quietCommandMessage(command));
    const status = this.#port.status();
    if (status === 'idle' || status === 'done') this.#port.emitState(status);
  }

  /**
   * Notka z wynikiem komendy lokalnej przyszła z pliku. Wynik TEJ komendy, którą Rarog właśnie
   * wysłał, kończy ją od razu — o ile jej watchdog już stoi; wcześniej wystarczy znacznik, który
   * przeczyta uzbrojenie. Wynik komendy wpisanej w terminalu (inna nazwa) niczego nie kończy.
   */
  noteCommandOutput(name: string): void {
    const local = this.localCommand;
    if (local === null || local.name !== name) return;
    local.output = true;
    if (local.armed) this.#finishLocalCommand();
  }

  /**
   * Koniec komendy lokalnej: stan z herdr, jak przy cichym końcu komendy — tylko `idle`/`done`
   * i bez blokady, żeby nie zgasić karty zgody ani formularza, który w międzyczasie stanął, i tylko
   * wtedy, gdy za komendą nie czeka nowsza wysyłka. Panel w turze (`/compact`) kończy się zwykłym
   * przejściem herdr, a watchdog zostaje siatką.
   *
   * @returns `true`, gdy komenda się skończyła (watchdog rozbrojony)
   */
  #finishLocalCommand(): boolean {
    const status = this.#port.status();
    if (status !== 'idle' && status !== 'done') return false;
    if (this.#port.blockedNow()) return false;
    // Nowsza wysyłka czeka w kolejce: jej `running` nie gaśnie od końca komendy sprzed niej.
    if (this.localCommand?.generation !== this.sendGeneration) return false;
    if (this.#watchdogTimer !== null) {
      this.#scheduler.clearTimeout(this.#watchdogTimer);
      this.#watchdogTimer = null;
    }
    this.localCommand = null;
    this.#port.emitState(status);
    return true;
  }

  /**
   * Czyszczenie pola z NASZYM zablokowanym promptem przed restartem — zadanie w kolejce wysyłek, więc
   * nie wyprzedzi wysyłki sprzed chwili, a `/exit` restartu stanie za nim.
   *
   * Kolejność jest całą treścią metody: para Esc na PUSTYM polu
   * otwiera w CLI rewind, a Esc w trakcie tury ją przerywa. Dlatego najpierw zgoda (`blockedLeftover`
   * ostatnio WYKONANEJ wysyłki), potem świeże `agent.get` (ta sama rozmowa, `idle`/`done`), dopiero potem
   * `#clearComposer` — para Esc tylko na potwierdzone `filled`, najwyżej trzy pary, przerwana, gdy zgoda
   * zgaśnie w trakcie (wpis `user` z pliku = ktoś wysłał prompt przy Macu). Na końcu odczyt CAŁEGO obszaru pola
   * (`composerRegionState`, ta sama reguła co bramka restartu). Zgoda gaśnie po każdej próbie czyszczenia,
   * także nieudanej: jeden gest użytkownika = najwyżej jedno czyszczenie.
   */
  clearBlockedLeftover(engineSessionId: string): Promise<BlockedLeftoverClear> {
    // Wyłącznik `RAROG_PROMPT_BLOCK=0`: zgody i tak nikt nie ustawia, ale czyszczenia nie ma także jawnie.
    if (this.#port.disposed() || this.#deps.promptBlock === false) return Promise.resolve('stale');
    return this.#port.enqueue(async (): Promise<BlockedLeftoverClear> => {
      const generation = this.blockedLeftover;
      if (this.#port.disposed() || generation === null || generation !== this.executedGeneration) return 'stale';
      let agent: { readonly agentSessionId: string; readonly status: HerdrAgentStatus };
      try {
        agent = await this.#deps.client.getAgent(this.#port.paneId());
      } catch {
        return 'changed';
      }
      if (this.#port.disposed() || this.blockedLeftover !== generation) return 'stale';
      if (agent.agentSessionId !== engineSessionId) return 'changed';
      if (agent.status !== 'idle' && agent.status !== 'done') return 'busy';
      // Od tej chwili zgoda jest zużyta — także gdy klawisze nie wyjdą albo pole się nie wyczyści.
      const stillAllowed = (): boolean => this.blockedLeftover === generation;
      // Panel wszedł w turę po świeżym `agent.get` (push herdr): ani jednej pary Esc więcej.
      const entries = this.turnEntries;
      const turnStarted = (): boolean => this.turnEntries !== entries;
      const cleared = await this.#port.clearComposer(undefined, () => !stillAllowed() || turnStarted());
      const allowed = stillAllowed();
      if (allowed) this.blockedLeftover = null;
      if (this.#port.disposed() || !allowed) return 'stale';
      if (turnStarted()) return 'busy';
      if (!cleared) return 'filled';
      let region: 'filled' | 'empty' | 'unknown';
      try {
        region = composerRegionState((await this.#deps.client.readScreen(this.#port.paneId(), 'visible', 'ansi')).text);
      } catch {
        region = 'unknown';
      }
      // Puste pole w turze to prompt wysłany przy Macu, nie wyczyszczone: `/exit` poszedłby w środek tury.
      return turnStarted() ? 'busy' : region;
    }).then((result) => result ?? 'unknown');
  }

  /**
   * Prompt zablokowany przez hook `UserPromptSubmit` (zdarzenie followera) → flagi wysyłki i zdarzenie dla
   * managera (`docs/dialogs.md`, „Prompt blocked by a hook”).
   *
   * Blokada z trafionym echem wskazuje wysyłkę, którą zablokowano (numer z trafionego wpisu okna echa,
   * `send`). Rozstrzyga ją tylko wtedy, gdy to
   * wysyłka OSTATNIO WYKONANA: `#blockedSend` kończy jej stall-guard i zadanie bez Esc, bez drugiego
   * `prompt` i bez „prompt utknął”, watchdog tej wysyłki gaśnie (watchdog nowszej zostaje), a pole — CLI
   * włożył prompt z powrotem — dostaje `#needsEscape` (następna wysyłka czyści je istniejącą drogą
   * `#clearComposer`: para Esc tylko na potwierdzone `filled`) i `blockedLeftover`. Blokada starszej
   * wysyłki, gdy nowsza już weszła do panelu, i blokada bez echa dają samą notkę (`decided: false`).
   */
  onPromptBlocked(event: Extract<FollowEvent, { type: 'prompt-blocked' }>): void {
    const generation = event.echoed ? event.send : undefined;
    const decided = generation !== undefined && generation === this.executedGeneration;
    // Blokada promptu spoza Raroga (człowiek wysłał go przy Macu): CLI włożył do pola JEGO tekst, więc zgoda
    // na czyszczenie pola z naszego promptu przepada.
    if (!event.echoed) this.blockedLeftover = null;
    if (decided && generation !== undefined) {
      this.#blockedSend = generation;
      this.#port.leftover.needsEscape = true;
      this.blockedLeftover = generation;
      if (this.#watchdogTimer !== null && this.#watchdogGeneration === generation) {
        this.#scheduler.clearTimeout(this.#watchdogTimer);
        this.#watchdogTimer = null;
      }
      if (this.localCommand?.generation === generation) this.localCommand = null;
    }
    this.#port.emit({
      type: 'prompt-blocked', reason: event.reason, promptKept: event.promptKept, echoed: event.echoed, decided,
      ...(event.prompt === undefined ? {} : { prompt: event.prompt }),
      ...(event.key === undefined ? {} : { key: event.key }),
      ...(event.token === undefined ? {} : { token: event.token }),
    });
  }
}
