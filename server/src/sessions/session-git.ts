/**
 * Git row of session cards: when the manager reads `git status` for a session, how one reading feeds every session
 * of the same directory, the `git-status` frame with its deduplication and replay, and the cost window in the log.
 * The manager owns one {@link SessionGit}, gives it a narrow {@link SessionGitPort} (sessions, clock, the environment
 * of git processes, emission) and calls it after a tool call, at the end of a turn, on opening a transcript and on
 * a `git-status` event of a driver. Git runs only through the runners of `git-status.ts`, and never in a protected
 * folder of home that no root opens: neither `git status` nor the `.git` watcher. This module does not
 * import `manager.ts`.
 */
import { homedir } from 'node:os';
import type { ServerEvent } from '@rarog/shared';
import { HERDR_GIT_MIN_INTERVAL_MS } from '../config.ts';
import { inExcludedOnDisk } from '../config/work-area.ts';
import type { InternalBlock } from '../drivers/types.ts';
import {
  GIT_NUMSTAT_BUDGET_MS, GIT_NUMSTAT_READ_CAP_BYTES, GitStatusWatcher, spawnGitArgs, spawnGitLog, spawnGitStatus,
} from '../git-status.ts';
import type { GitStatusLike } from '../git-status.ts';
import { GitReadStats } from '../git-stats.ts';
import { GitRepoWatcher } from '../git-watch.ts';
import type { Session } from './session.ts';

/** Fields of the manager configuration the git row reads (`ManagerConfig`, described there). */
export interface SessionGitConfig {
  readonly demo: boolean;
  readonly logger?: (line: string) => void;
  readonly gitStatus?: GitStatusWatcher | null;
  readonly gitFileDetails?: boolean;
  readonly gitWatcher?: ((onChange: (cwds: readonly string[]) => void) => GitRepoWatcher) | null;
  /** Roots of the panes (`RAROG_HERDR_ROOTS`): a root inside a protected folder of home opens it to git. */
  readonly herdrRoots?: readonly string[] | undefined;
  /** Home directory for the protected folders; default the account's home. */
  readonly home?: string | undefined;
}

/** What the git row reads from the manager besides configuration: sessions, clock, git environment, emission. */
export interface SessionGitPort {
  readonly sessions: ReadonlyMap<string, Session>;
  readonly now: () => number;
  /** Environment of git processes built once by the manager (`gitReadEnv`), the same one `diff()` uses. */
  readonly gitEnv: NodeJS.ProcessEnv;
  readonly emitSession: (session: Session, event: ServerEvent) => void;
  readonly emitSessionChanged: (session: Session) => void;
}

/** Git reader, `.git` watcher and cost window of the manager; one instance per manager. */
export class SessionGit {
  readonly #config: SessionGitConfig;
  readonly #port: SessionGitPort;
  readonly #git: GitStatusWatcher | null;
  /** Obserwator `.git` — odświeża wiersz gita po commicie/pullu/pushu spoza sesji Claude. */
  readonly #gitWatch: GitRepoWatcher | null;
  /** Koszt gita w oknach 5 min — jedna linia `git: okno …` w logu (pomiar przed/po `fileDetails`). */
  readonly #gitStats: GitReadStats;
  /** Sessions whose directory {@link watch} registered: {@link unwatch} releases exactly these. */
  readonly #watched = new WeakSet<Session>();

  constructor(config: SessionGitConfig, port: SessionGitPort) {
    this.#config = config;
    this.#port = port;
    this.#gitStats = new GitReadStats(() => this.#port.now());
    this.#git = config.gitStatus !== undefined
      ? config.gitStatus
      // W demo git jest nieużywany (mock emituje `git-status` sam).
      : (config.demo
        ? null
        : new GitStatusWatcher({
          run: spawnGitStatus(port.gitEnv),
          runLog: spawnGitLog(port.gitEnv),
          // Liczniki linii mają WŁASNY budżet: odczyt idzie po `status`, więc to jego czas
          // jest najdłuższym opóźnieniem ramki przez szczegóły plików.
          runNumstat: config.gitFileDetails === false
            ? null
            : spawnGitArgs(port.gitEnv, GIT_NUMSTAT_BUDGET_MS, GIT_NUMSTAT_READ_CAP_BYTES),
          onCollect: (sample) => { this.#logGitStats(this.#gitStats.noteRead(sample.ms, sample.numstat)); },
        }));
    const onGitChange = (cwds: readonly string[]): void => { this.#gitChanged(cwds); };
    this.#gitWatch = config.gitWatcher !== undefined
      ? (config.gitWatcher === null ? null : config.gitWatcher(onGitChange))
      // Bez odczytu gita watcher nie miałby komu mówić (demo, testy z `gitStatus: null`).
      : (this.#git === null
        ? null
        : new GitRepoWatcher({
          onChange: onGitChange,
          onUnavailable: (gitDir, error) => {
            console.warn(`rarog: git-watch without a watcher for ${gitDir}: ${describeError(error)}`);
          },
        }));
  }

  /**
   * Registers the session's directory in the `.git` watcher, unless git may not run there ({@link #gitAllowed}). The
   * session is remembered, so {@link unwatch} releases what this registered even if the verdict changed meanwhile.
   */
  watch(session: Session): void {
    const watcher = this.#gitWatch;
    if (watcher === null || this.#watched.has(session) || !this.#gitAllowed(session.cwd)) return;
    this.#watched.add(session);
    watcher.watch(session.cwd);
  }

  /** Releases the session's directory in the `.git` watcher, when {@link watch} registered it. */
  unwatch(session: Session): void {
    if (this.#watched.delete(session)) this.#gitWatch?.unwatch(session.cwd);
  }

  /** Stops the `.git` watcher (manager `dispose`). */
  close(): void {
    this.#gitWatch?.close();
  }

  /**
   * Whether git may run in `cwd`: not in a macOS-protected folder of home that no root opens, as written or
   * through a symlink. A read there waits for a privacy prompt nobody sees and hangs the server. A pane outside the
   * roots elsewhere keeps its git row. The check resolves the roots and walks `cwd` without a disk call in the folder.
   */
  #gitAllowed(cwd: string): boolean {
    return !inExcludedOnDisk(cwd, this.#config.herdrRoots ?? [], this.#config.home ?? homedir());
  }

  /** Po domkniętym tool-callu pytamy gita (throttle w `GitStatusWatcher`). */
  maybeGitStatus(session: Session, blocks: readonly InternalBlock[]): void {
    if (!blocks.some((block) => block.type === 'tool-call')) return;
    this.requestGitStatus(session);
  }

  /**
   * Odświeżenie gita niezależne od tool-calli — dziś wołane przy otwarciu transkryptu.
   *
   * Powód: lista plików istnieje WYŁĄCZNIE w evencie `git-status`, a ten bez tego odświeżenia
   * leci tylko po tool-callach. Telefon wchodzący w sesję, w której od dawna nic się
   * nie działo, widziałby w nagłówku `+1` (licznik z rejestru), a w rozwinięciu „Brak
   * zmienionych plików" — dwa zdania o tym samym repo, które sobie przeczą.
   *
   * @param replay gdy `true` (otwarcie transkryptu), odczyt pominięty przez throttle albo bez
   *   wyniku kończy się ponowną emisją OSTATNIEGO znanego statusu (`#replayGitStatus`).
   */
  requestGitStatus(session: Session, force = false, replay = false): void {
    const git = this.#git;
    if (git === null) {
      /*
       * Demo nie czyta gita (ramki `git-status` składa mock-driver), więc klient wchodzący w transkrypt
       * dostaje ostatnią rozgłoszoną ramkę. Snapshot zastępuje także powtórkę z kilkoma
       * wiadomościami, a w niej mogła stać nowsza ramka gita niż ta, którą apka trzyma.
       * Tylko demo: `gitStatus: null` poza nim to testy, których ring i złote ramki mają zostać bez zmian.
       */
      if (replay && this.#config.demo) this.#replayGitStatus(session);
      return;
    }
    const skipped = (): void => {
      if (replay) this.#replayGitStatus(session);
    };
    /*
     * Drugi throttle, liczony PER SESJA.
     *
     * `GitStatusWatcher` throttluje per KATALOG, a przy 17 panelach kilka z nich siedzi
     * w tym samym repo i każdy tail jsonl wyrzuca własne tool-calle — bez tego limitu
     * jeden aktywny wieczór to setki wywołań `git status` na minutę.
     *
     * `force` omija OBA throttle (koniec tury, zmiana w `.git` z zewnątrz): każde z tych
     * zdarzeń znaczy „repo właśnie się zmieniło", więc stary odczyt kłamie. Cena za częstość
     * jest brana z drugiej strony: wymuszony odczyt ROZGŁASZA tylko wtedy, gdy treść wiersza
     * naprawdę się zmieniła (podpis w `applyGitStatus`) — `git gc` czy `git status` z nvima
     * budzą watcher, ale nie mają prawa budzić telefonu.
     */
    const now = this.#port.now();
    const last = session.lastGitStatusAt;
    if (!force && last !== undefined && now - last < HERDR_GIT_MIN_INTERVAL_MS) {
      skipped();
      return;
    }
    session.lastGitStatusAt = now;
    if (!this.#gitAllowed(session.cwd)) {
      skipped();
      return;
    }
    void git.status(session.cwd, force)
      .then((status) => {
        if (this.#port.sessions.get(session.id) !== session) return;
        // Throttle watchera per katalog albo porażka gita: wyniku nie ma, ale klient, który
        // właśnie wszedł, i tak ma dostać to, co Rarog o tym katalogu wie.
        if (status === null) {
          skipped();
          return;
        }
        /*
         * Świeży odczyt zasila WSZYSTKIE sesje tego katalogu, żeby dwa taby w jednym repo nie
         * pokazywały różnych liczników i list plików. Git jest prawdą o KATALOGU, nie o sesji —
         * odświeżany per sesja zostawiłby bezczynny tab ze stanem sprzed godziny. Znacznik
         * throttle'a też idzie na wszystkie:
         * po jednym odczycie katalog ma spokój, niezależnie od tego, która sesja go zleciła.
         */
        for (const sibling of this.#port.sessions.values()) {
          if (sibling.cwd !== session.cwd) continue;
          sibling.lastGitStatusAt = this.#port.now();
          /*
           * Rozgłoszenie pomijamy TYLKO przy odczycie wymuszonym (watcher `.git`, koniec tury)
           * i tylko wtedy, gdy treść jest co do znaku ta sama — patrz `applyGitStatus`.
           * Odczyt zwykły (otwarcie transkryptu, zasiew karty) leci ZAWSZE: tam po drugiej
           * stronie stoi klient, który tej treści jeszcze nie widział.
           */
          this.applyGitStatus(sibling, status, force);
        }
      })
      .catch(() => undefined);
  }

  /**
   * Ponowna emisja OSTATNIEJ ramki `git-status` tej sesji — dla klienta, który właśnie wszedł
   * w transkrypt, a odczytu nie dostanie (throttle 30 s per sesja albo per katalog).
   *
   * Lista plików i ich szczegóły istnieją WYŁĄCZNIE w tej ramce, a `transcript-snapshot` ich nie
   * niesie — bez tego świeży subskrybent zostawał bez listy do następnego wyzwalacza (tool-call
   * po throttle'u, koniec tury, zmiana w `.git`). Ramka idzie strumieniem sesji, więc dostaje ją
   * też każdy inny otwarty klient tej sesji — z tą samą treścią, którą już ma.
   *
   * W mikrozadaniu, bo hub woła `transcript()` PRZED wysłaniem `transcript-snapshot`: ramka ma
   * dojechać za snapshotem, nie przed nim. Podpis dedupu zostaje — klient widzi dokładnie tę
   * treść. Bez zapamiętanej ramki (pierwsze wejście po restarcie, sesja bez odczytu) podpis
   * jest kasowany: wtedy najbliższy odczyt wymuszony rozgłosi raz, zamiast uznać treść za widzianą.
   *
   * W mikrozadaniu ramka odpada TYLKO wtedy, gdy w międzyczasie wyszła INNA (`lastGitEvent` to
   * ostatnia ROZGŁOSZONA ramka — odczyt pominięty przez dedup jej nie podmienia): klient ma wtedy
   * nowszą treść, a stara cofnęłaby mu stan.
   */
  #replayGitStatus(session: Session): void {
    const event = session.lastGitEvent;
    if (event === undefined) {
      session.lastGitSignature = undefined;
      return;
    }
    queueMicrotask(() => {
      if (this.#port.sessions.get(session.id) !== session || session.lastGitEvent !== event) return;
      this.#port.emitSession(session, event);
      this.#logGitStats(this.#gitStats.noteFrame());
    });
  }

  /** Linia okna kosztu gita (`git-stats.ts`), gdy okno właśnie się zamknęło. */
  #logGitStats(line: string | null): void {
    if (line !== null) this.#config.logger?.(line);
  }

  /**
   * `.git` zmieniło się poza sesją Claude (commit w terminalu, lazygit, pull na Macu).
   *
   * Jeden odczyt na katalog: pierwsza sesja z tym `cwd` zleca, `requestGitStatus` zasila
   * resztę rodzeństwa. Sesja mogła zniknąć w oknie debounce'u — wtedy nie ma o co pytać.
   */
  #gitChanged(cwds: readonly string[]): void {
    for (const cwd of cwds) {
      for (const session of this.#port.sessions.values()) {
        if (session.cwd !== cwd) continue;
        this.requestGitStatus(session, true);
        break;
      }
    }
  }

  /**
   * Zapisuje status gita na sesji i rozgłasza ramkę `git-status`.
   *
   * Podpis do dedupu liczymy z tej samej ramki, którą wysyłamy (patrz niżej) — lista plików
   * jest więc w podpisie z definicji, a musi być, bo istnieje WYŁĄCZNIE w tym evencie
   * (`SessionSummary` jej nie ma).
   *
   * @param dedup gdy `true`, identyczna treść NIE jest rozgłaszana (odczyt wymuszony: watcher
   *   `.git`, koniec tury). Dla odczytów zwykłych zostaje `false` — otwarcie transkryptu
   *   i zasiew karty są jedyną drogą, którą lista plików dociera do klienta, który dopiero
   *   co wszedł, więc muszą emitować także wtedy, gdy w repo nic się nie zmieniło
   *   (inaczej: „+1" w nagłówku i „Brak zmienionych plików" w rozwinięciu).
   */
  applyGitStatus(session: Session, status: GitStatusLike, dedup = false): void {
    session.branch = status.branch;
    session.dirtyCount = status.dirtyCount;
    // Brak upstreamu w świeżym odczycie musi WYCZYŚCIĆ poprzednie ahead/behind — inaczej UI
    // pokazywałoby licznik gałęzi, która już nie ma z czym się porównywać.
    session.ahead = status.ahead;
    session.behind = status.behind;
    // Ta sama reguła dla trójki rodzajów: odczyt, który jej nie zna (driver bez `fileKinds`),
    // kasuje poprzednią, zamiast zostawiać na karcie liczby sprzed kilku tur.
    session.fileKinds = status.fileKinds;
    // I dla commita: repo bez HEAD (świeże `git init`) ma zgasić wiersz, a nie trzymać stary.
    session.lastCommit = status.lastCommit;
    const event: Extract<ServerEvent, { type: 'git-status' }> = {
      type: 'git-status',
      sessionId: session.id,
      branch: status.branch,
      dirtyCount: status.dirtyCount,
      files: status.files,
    };
    if (status.ahead !== undefined) event.ahead = status.ahead;
    if (status.behind !== undefined) event.behind = status.behind;
    if (status.fileKinds !== undefined) event.fileKinds = status.fileKinds;
    if (status.lastCommit !== undefined) event.lastCommit = status.lastCommit;
    // Szczegóły plików żyją WYŁĄCZNIE w ramce (jak `files`): odczyt bez pola daje ramkę bez pola,
    // a ta u klienta gasi szczegóły poprzedniej. `RAROG_GIT_FILE_DETAILS=0` zdejmuje pole z KAŻDEGO
    // źródła (odczyt gita, mock, driver) — ramka wygląda wtedy dokładnie jak przed polem.
    if (status.fileDetails !== undefined && this.#config.gitFileDetails !== false) {
      event.fileDetails = status.fileDetails;
    }
    /*
     * Podpis liczymy z GOTOWEJ ramki, nie z osobnej listy pól: dopisanie kiedyś nowego pola
     * do eventu wchodzi do podpisu samo, więc nie ma jak zjeść prawdziwej zmiany. `sessionId`
     * i `type` są stałe dla sesji, więc na porównanie nie wpływają.
     *
     * Podpis liczymy ZAWSZE (także przy `dedup: false`), bo inaczej pierwszy wymuszony odczyt
     * po zwykłym rozgłosiłby tę samą treść drugi raz. Pola sesji są już ustawione — pominięte
     * jest wyłącznie rozgłoszenie, więc stan w RAM i tak zgadza się z dyskiem.
     */
    const signature = JSON.stringify(event);
    const same = session.lastGitSignature === signature;
    session.lastGitSignature = signature;
    // Odczyt pominięty przez dedup NIE podmienia ostatniej ramki: treść jest ta sama, a podmiana
    // obiektu skasowałaby zaplanowaną ponowną emisję dla klienta, który właśnie wszedł
    // (`#replayGitStatus` porównuje obiekt, żeby nie cofnąć klientowi nowszej treści).
    if (dedup && same) return;
    // Ostatnia ROZGŁOSZONA ramka zostaje do ponownej emisji przy wejściu w transkrypt.
    session.lastGitEvent = event;
    this.#port.emitSession(session, event);
    this.#port.emitSessionChanged(session);
    this.#logGitStats(this.#gitStats.noteFrame());
    // Wiersz gita jest częścią wpisu rejestru — bez zapisu karta gubiłaby go po restarcie.
    // Zapisy są i tak throttlowane po stronie `GitStatusWatcher` (a w demo mock emituje
    // git-status tylko po tool-callu).
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
