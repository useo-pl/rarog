/**
 * Czytnik pliku rozmowy SUBAGENTA: `<katalog sesji>/subagents/agent-<id>.jsonl`.
 *
 * Plik główny rozmowy mówi, że subagent stanął (meldunek o postoju), ale nie mówi, kiedy sam
 * ruszył ani na co czeka: wybudzenie po końcu jego własnej komendy i start tej komendy zostawiają
 * ślad wyłącznie w JEGO pliku. Ten moduł czyta ten plik przyrostowo i oddaje FAKTY, nie werdykt:
 *
 * - czas ostatniego wpisu. Czy agent czeka, rozstrzyga `merge.ts`, zestawiając go z bieżącym
 *   `waitingSince` z followera;
 * - otwarte własne komendy agenta WEDŁUG TEGO PLIKU: start to wynik narzędzia z identyfikatorem
 *   zadania, treść komendy stoi w sparowanym wywołaniu, koniec to meldunek we własnym pliku albo
 *   wynik `TaskStop`. Liczy je ta sama maszyna co w pliku głównym (`reducer.ts`, opcja
 *   `sidechain`), osobna instancja na plik. Końca, który przeszedł tylko przez kolejkę pliku
 *   głównego, ten moduł sam nie zobaczy: `merge.ts` podaje takie id przy odczycie (`ended`),
 *   a czytnik zamyka nimi komendy w swoim reduktorze;
 * - dowód, że plik jest ZNANY DO OSTATNIEJ LINII (`settled`), razem z terminem innych własnych
 *   zadań agenta (monitor, zagnieżdżony subagent, workflow). Z niego `merge.ts` wnioskuje, że
 *   agent w postoju już nie wróci; sam czytnik niczego takiego nie orzeka.
 *
 * Pomiar, na którym stoi moduł (magazyn CLI tego konta, 30 dni):
 *
 * - pierwszy wpis po postoju to zawsze wybudzenie albo wznowienie, z `timestamp` PÓŹNIEJSZYM niż
 *   meldunek o postoju (najmniej 18 ms; 82 z 82), a ostatni wpis PRZED postojem ma `timestamp`
 *   wcześniejszy niż meldunek (256 z 256). Wystarczy więc czas ostatniego wpisu;
 * - `mtime` pliku do tego nie wystarcza: uśpiony plik ma `mtime` do 0,61 s po meldunku, a krótkie
 *   wybudzenie z długą ciszą po nim zmieściłoby się w każdym marginesie;
 * - pliki bywają duże: 373 z 736 ponad 1 MB, największy 95 MB. Stąd odczyt porcjami, sufit
 *   przyrostu i prefiltr przed `JSON.parse`: parsujemy tylko linie, które mogą nieść start albo
 *   koniec komendy ({@link mayCarryOwnCommand}), i ogon porcji dla czasu ostatniego wpisu;
 * - zmierzony agent wystartował 32 własne komendy. Koniec 24 widać w kolejce pliku głównego
 *   (13 także tutaj), 5 wyłącznie tutaj jako wynik `TaskStop`, 3 były otwarte.
 *
 * Odporność odczytu jest ta sama co w followerze pliku głównego (`herdr/jsonl-follow.ts`); cięcie
 * bajtów na linie i sufit długości linii stoją w `jsonl-lines.ts`, wspólnie z przeglądem pliku
 * głównego (`main-scan.ts`):
 *
 * - niedokończona ostatnia linia czeka w buforze na resztę. Bufor trzyma BAJTY, nie tekst: porcja
 *   potrafi skończyć się w środku znaku UTF-8, a `\n` nigdy nie jest częścią znaku wielobajtowego,
 *   więc cięcie po bajcie nowej linii jest bezpieczne, a dekodowanie całej linii naraz też;
 * - jeden odczyt bierze najwyżej porcję (`chunkBytes`), a linia dłuższa niż sufit (`lineMaxBytes`)
 *   jest pomijana w całości, bez składania jej w pamięci;
 * - przyrost większy niż sufit (`maxReadBytes`) to PRZESKOK: czytamy sam ogon tej długości,
 *   bez pierwszej, uciętej linii;
 * - plik krótszy niż poprzednio albo podmieniony (inny i-węzeł) to inna zawartość: czytanie
 *   rusza od jego końca. Przeniesienie (`rename(2)`) i-węzła nie zmienia, więc offset zostaje.
 *
 * Przeskok, skrócenie i podmiana ZERUJĄ reduktor tego agenta: pominięty kawałek mógł nieść koniec
 * komendy, więc o komendach sprzed niego nic już nie wiadomo i nie są pokazywane („los nieznany").
 * Czas ostatniego wpisu po zerowaniu NIE cofa się: wpis, który widzieliśmy, był.
 *
 * Moduł nigdy nie rzuca. Brak katalogu sesji albo pliku to normalny stan (agent dopiero rusza).
 * Adres katalogu, relokację i bramkę zasięgu ma wspólne z czytnikiem przebiegów (`satellite.ts`;
 * panel poza zasięgiem nie dostaje czytnika wcale), a id agenta przechodzi przez `isAgentId`,
 * zanim trafi do ścieżki.
 */
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentOwnTask } from '@rarog/shared';
import { asRecord } from '../../drivers/tool-text.ts';
import { defaultStoreRoot } from '../../cli-store.ts';
import { parseJsonlEntry } from '../jsonl-pending.ts';
import { CLI_SHAPES } from './cli-shapes.ts';
import { isAgentId } from './ids.ts';
import { resetCarry, takeLines } from './jsonl-lines.ts';
import type { LineCarry } from './jsonl-lines.ts';
import { createBackgroundTasksTracker, MONITOR_MAX_MS } from './reducer.ts';
import type { BackgroundTasksTracker } from './reducer.ts';
import { createSatelliteDir } from './satellite.ts';
import type { SatelliteDir } from './satellite.ts';

/** Jedna porcja odczytu. Między porcjami pętla zdarzeń dostaje oddech. */
export const AGENT_FILE_CHUNK_BYTES = 1024 * 1024;
/**
 * Sufit przyrostu JEDNEGO odczytu; większy przyrost to przeskok do ogona tej długości. Pierwsze
 * podpięcie liczy się od zera, więc to zarazem największy plik czytany w całości.
 *
 * 256 MiB, bo odczyt jest tani (pomiar na plikach tego konta, pamięć podręczna systemu
 * ciepła: 52 MiB w 60 ms, najdłuższa pauza pętli zdarzeń 2 ms), a największy plik subagenta
 * w magazynie ma 91 MiB. Plik 15 MB idzie w 19 ms. Sufit jest od plików, których
 * nikt nie przewidział, nie od zwykłej pracy.
 */
export const AGENT_FILE_MAX_READ_BYTES = 256 * 1024 * 1024;
/**
 * Sufit długości JEDNEJ linii, zarazem sufit bufora niedokończonej linii. Dłuższa linia jest
 * pomijana w całości (wynik `Read` z obrazem ma kilka MB; start i koniec komendy to setki bajtów).
 */
export const AGENT_FILE_LINE_MAX_BYTES = 8 * 1024 * 1024;
/** Od tego rozmiaru pierwsze podpięcie do pliku zostawia w logu linię z kosztem odczytu. */
export const AGENT_FILE_COST_LOG_BYTES = 1024 * 1024;

/** Fraza linii logu z kosztem pierwszego podpięcia (jedna na agenta). */
export const AGENT_FILE_COST_LOG = 'subagent file: first attach';

const ATTACHMENT = CLI_SHAPES.notificationCarriers.literals.attachmentType;
const ATTACHMENT_FIELD = CLI_SHAPES.notificationCarriers.literals.attachmentField;
const STOP_HOOK = CLI_SHAPES.subagentStopHook.literals;
const REQUEST_BLOB = CLI_SHAPES.requestBlob.literals.type;
const EMPTY = Buffer.alloc(0);
const MONITOR = CLI_SHAPES.monitorTool.literals;
/** Narzędzia, po których subagent może mieć własne zadanie o losie, którego z pliku nie znamy. */
const NESTED_TOOLS: readonly string[] = [
  CLI_SHAPES.taskTools.literals.agent, CLI_SHAPES.taskTools.literals.task, CLI_SHAPES.taskTools.literals.workflow,
];
/** Najdłuższy termin monitora (ms); stoi w reduktorze, bo liczy z niego też lista zadań pliku głównego. */
export { MONITOR_MAX_MS };

/**
 * Igły prefiltra jako bajty: linia bez żadnej z nich nie zmienia listy własnych komend, więc
 * nie jest parsowana.
 *
 * - `"tool_use"` w cudzysłowie to blok wywołania narzędzia (treść komendy stoi w wywołaniu).
 *   Wynik narzędzia niesie `tool_use_id`, którego ten napis nie łapie, a cytat w treści wyniku
 *   ma cudzysłowy poprzedzone ukośnikiem;
 * - identyfikator zadania w wyniku to start komendy;
 * - znacznik meldunku, zdanie `TaskStop` i pole `TaskOutput` to trzy drogi końca.
 *
 * Start zagnieżdżonego subagenta ani przebiegu workflow igły nie ma, celowo: własne zadania
 * agenta inne niż komendy są poza zakresem (pole z id agenta stoi zresztą w KAŻDEJ linii pliku).
 */
const NEEDLES: readonly Buffer[] = [
  '"tool_use"',
  CLI_SHAPES.taskStart.literals.backgroundTaskId,
  CLI_SHAPES.notification.literals.open,
  CLI_SHAPES.taskStop.literals.messagePrefix,
  CLI_SHAPES.taskOutput.literals.retrievalStatus,
].map((needle) => Buffer.from(needle, 'utf8'));

/**
 * Czy linia MOŻE nieść wywołanie narzędzia, start albo koniec własnej komendy subagenta. Tani
 * prefiltr przed `JSON.parse`: fałszywe „tak" kosztuje jedno parsowanie, fałszywego „nie" być nie
 * może (pilnuje tego test na zmierzonych plikach subagentów).
 */
export function mayCarryOwnCommand(line: Buffer): boolean {
  return NEEDLES.some((needle) => line.includes(needle));
}

/** Co czytnik wie o pliku jednego subagenta po ostatnim odczycie. */
export interface AgentFileFacts {
  /**
   * `timestamp` ostatniego wpisu pliku: największy z dotąd przeczytanych, ISO. Nieobecny = nie
   * przeczytaliśmy jeszcze żadnego wpisu z czasem.
   */
  readonly lastEntryAt?: string;
  /**
   * Otwarte własne komendy agenta w kolejności startu: start widziany w jego pliku, a końca nie
   * było ani tam (meldunek, `TaskStop`), ani wśród id podanych przy odczycie (`ended`). Koniec
   * z pliku głównego, który przyszedł PO tym odczycie, odsiewa do następnego odczytu `merge.ts`.
   */
  readonly commands: readonly AgentOwnTask[];
  /**
   * Dowód, że plik jest znany DO OSTATNIEJ LINII: obecny tylko wtedy, gdy czytnik przeczytał go
   * od początku bez dziur (bez przeskoku, skrócenia, podmiany, linii pominiętej jako za długa
   * i linii, której nie dało się sparsować), ostatni odczyt doszedł do rozmiaru pliku, nie została
   * niedokończona linia, a ostatnia kompletna linia dała własny czas. Bez niego „plik nie ma
   * późniejszego wpisu" i „nie ma otwartej komendy" znaczą tylko „nie widzieliśmy": wpis
   * wybudzenia albo start zadania mógł stać w linii uciętej, pominiętej albo nieczytelnej.
   */
  readonly settled?: AgentFileSettled;
}

/** Co wiadomo o pliku znanym do ostatniej linii, a czego nie niosą `lastEntryAt` i `commands`. */
export interface AgentFileSettled {
  /**
   * Chwila (ms epoki), do której agent może mieć żywe własne zadanie INNE niż komenda. Monitor
   * żyje najwyżej do swojego terminu (czas wywołania + `timeout_ms`, bez pola sufit narzędzia);
   * jego wygaśnięcia z pliku nie widać (zdarzenie bez `<status>` w kolejce pliku głównego), więc
   * liczy się sam termin. Wywołanie `Agent`, `Task` albo `Workflow` daje `Infinity`: losu takiego
   * zadania czytnik nie zna. Nieobecne = agent żadnego takiego narzędzia nie wołał.
   */
  readonly otherWorkUntil?: number;
}

export interface AgentFileReader {
  /**
   * Doczytuje plik agenta od zapamiętanego miejsca i oddaje fakty; `null` = nic o nim nie wiemy
   * (zły kształt id, brak katalogu sesji albo pliku, czytnik zamknięty albo przestawiony w trakcie).
   * Wołający czyta po kolei: dwa równoległe odczyty tego samego agenta nie są obsługiwane.
   *
   * `ended` to id zamknięte POZA tym plikiem (końce bez startu z kolejki pliku głównego). Czytnik
   * zamyka nimi otwarte komendy tego agenta na stałe: bez tego komenda, której koniec stoi tylko
   * w pliku głównym, zostawałaby w jego liście do końca życia agenta, a lista rosłaby bez końca.
   */
  read(agentId: string, ended?: ReadonlySet<string>): Promise<AgentFileFacts | null>;
  /** `/clear`, `/resume`: inna sesja silnika, inny katalog — cała pamięć plików w kosz. */
  repoint(agentSessionId: string): void;
  /** Te same pliki pod nowym adresem (`EnterWorktree`): kasujemy sam adres, offsety zostają. */
  relocated(): void;
  close(): void;
}

export interface AgentFileReaderOptions {
  cwd: string;
  agentSessionId: string;
  /** Korzeń magazynu CLI. Domyślnie `~/.claude/projects` (testy dają katalog tymczasowy). */
  root?: string;
  /** Sufity odczytu; testy zmniejszają je do bajtów. */
  chunkBytes?: number;
  maxReadBytes?: number;
  lineMaxBytes?: number;
  costLogBytes?: number;
  now?: () => number;
  logger?: (message: string) => void;
  /** Otwarcie pliku do odczytu. Podmienialne, bo test musi umieć wejść w ŚRODEK odczytu. */
  open?: OpenFile;
}

/** Tyle uchwytu pliku, ile czytnik używa: rozmiar i tożsamość, odczyt zakresu, zamknięcie. */
export interface OpenedFile {
  stat(): Promise<{ size: number; ino: number; dev: number }>;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export type OpenFile = (path: string) => Promise<OpenedFile>;

/**
 * Stan jednego pliku między odczytami. Niedokończoną linię i znacznik pomijania (`partial`,
 * `dropping`) niesie `LineCarry` z `jsonl-lines.ts`.
 */
interface FileState extends LineCarry {
  /** Ile bajtów pliku już przerobiliśmy. */
  offset: number;
  /** Tożsamość pliku z ostatniego odczytu: inny i-węzeł pod tą samą nazwą to inny plik. */
  ino: number;
  dev: number;
  /**
   * Najpóźniejszy `timestamp` wpisu, jaki przeczytaliśmy: napis z pliku i ta sama chwila w ms.
   * `''` i `-Infinity` = żadnego. Przeżywa zerowania: wpis, który widzieliśmy, był.
   */
  lastAt: string;
  lastMs: number;
  /** Reduktor zadań TEGO pliku; nowy po przeskoku, skróceniu i podmianie. */
  tracker: BackgroundTasksTracker;
  /**
   * Znamy plik od pierwszego bajtu, bez dziur. `false` NA STAŁE (do `repoint()`) po przeskoku,
   * skróceniu i podmianie (reduktor zerowany: komend sprzed zerowania w liście nie ma i już nie
   * będzie) oraz po linii pominiętej jako za długa albo nieczytelnej: mogła nieść start zadania,
   * a późniejsza zwykła linia tej dziury nie zasypuje.
   */
  intact: boolean;
  /** Ostatni odczyt doszedł do rozmiaru pliku. Gaśnie na początku każdego odczytu. */
  atEnd: boolean;
  /** Ostatnia kompletna linia pliku dała własny czas (sparsowana, z czasem, nie załącznik). */
  tailTimed: boolean;
  /** Patrz `AgentFileSettled.otherWorkUntil`; `-Infinity` = brak takich wywołań. */
  otherWorkUntil: number;
}

/** Reduktor pliku subagenta: ta sama maszyna co dla pliku głównego, bez bramki `isSidechain`. */
function agentTracker(): BackgroundTasksTracker {
  return createBackgroundTasksTracker({ sidechain: true });
}

/** Otwarte KOMENDY z reduktora w kształcie kontraktu; inne rodzaje własnych zadań odpadają. */
function ownCommands(tracker: BackgroundTasksTracker): AgentOwnTask[] {
  return tracker.tasks.flatMap((task): AgentOwnTask[] => {
    if (task.kind !== 'command') return [];
    const own: AgentOwnTask = { id: task.id };
    if (task.command !== undefined) own.command = task.command;
    if (task.startedAt !== undefined) own.startedAt = task.startedAt;
    return [own];
  });
}

/**
 * `timestamp` wpisu: napis z pliku i chwila w ms; `null` = wpis go nie ma albo nie jest datą.
 * Porównujemy chwile, nie napisy: napis spoza ISO nie ma prawa zostać „najpóźniejszym” na zawsze.
 */
function timeOf(entry: unknown): { at: string; ms: number } | null {
  const at = asRecord(entry)?.['timestamp'];
  if (typeof at !== 'string') return null;
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? null : { at, ms };
}

/**
 * Do kiedy wywołania narzędzi z tego wpisu mogą trzymać własne zadanie agenta inne niż komenda
 * (`AgentFileSettled.otherWorkUntil`); `-Infinity` = wpis takich wywołań nie niesie.
 */
function otherWorkOf(entry: unknown): number {
  // A request copy repeats calls already counted from their own entries, and without a time a `Monitor` in it would
  // hold the agent for good.
  if (asRecord(entry)?.['type'] === REQUEST_BLOB) return -Infinity;
  const content = asRecord(asRecord(entry)?.['message'])?.['content'];
  if (!Array.isArray(content)) return -Infinity;
  let until = -Infinity;
  for (const item of content) {
    const block = asRecord(item);
    if (block?.['type'] !== 'tool_use') continue;
    const name = block['name'];
    if (name === MONITOR.tool) {
      const called = timeOf(entry);
      const timeout = asRecord(block['input'])?.[MONITOR.timeout];
      const span = typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0
        ? Math.min(timeout, MONITOR_MAX_MS) : MONITOR_MAX_MS;
      until = Math.max(until, called === null ? Infinity : called.ms + span);
    } else if (typeof name === 'string' && NESTED_TOOLS.includes(name)) {
      until = Infinity;
    }
  }
  return until;
}

/**
 * Czy czas wpisu jest JEGO czasem. Załącznik (`attachment`) niesie czas pierwszej kopii meldunku,
 * czyli wcześniejszy niż chwila zapisu, więc „ostatnim wpisem z czasem” nie jest.
 *
 * The one exception is the record of the `SubagentStop` hook: the CLI writes it when the agent stops, after its last
 * entry and at its own time (CLI 2.1.330). With such a hook configured it ends the file at every stop, so without it
 * no stopped agent's file would ever be known to its last line.
 */
function hasOwnTime(entry: unknown): boolean {
  if (timeOf(entry) === null) return false;
  const record = asRecord(entry);
  if (record?.['type'] !== ATTACHMENT) return true;
  const attachment = asRecord(record[ATTACHMENT_FIELD]);
  return attachment?.['type'] === STOP_HOOK.type && attachment[STOP_HOOK.event] === STOP_HOOK.stop;
}

class Reader implements AgentFileReader {
  readonly #satellite: SatelliteDir;
  readonly #files = new Map<string, FileState>();
  readonly #chunkBytes: number;
  readonly #maxReadBytes: number;
  readonly #lineMaxBytes: number;
  readonly #costLogBytes: number;
  readonly #now: () => number;
  readonly #log: (message: string) => void;
  readonly #open: OpenFile;
  /** Rośnie przy `repoint()`; odczyt rozpoczęty wcześniej niczego już nie oddaje. */
  #generation = 0;
  #closed = false;

  constructor(opts: AgentFileReaderOptions) {
    this.#satellite = createSatelliteDir({
      root: opts.root ?? defaultStoreRoot(), cwd: opts.cwd, agentSessionId: opts.agentSessionId,
    });
    this.#chunkBytes = Math.max(1, opts.chunkBytes ?? AGENT_FILE_CHUNK_BYTES);
    // Ogon po przeskoku musi zmieścić choć jedną porcję — inaczej każdy odczyt byłby przeskokiem.
    this.#maxReadBytes = Math.max(this.#chunkBytes, opts.maxReadBytes ?? AGENT_FILE_MAX_READ_BYTES);
    this.#lineMaxBytes = Math.max(1, opts.lineMaxBytes ?? AGENT_FILE_LINE_MAX_BYTES);
    this.#costLogBytes = opts.costLogBytes ?? AGENT_FILE_COST_LOG_BYTES;
    this.#now = opts.now ?? Date.now;
    this.#log = opts.logger ?? ((message) => { console.warn(message); });
    this.#open = opts.open ?? ((path) => open(path, 'r'));
  }

  async read(agentId: string, ended?: ReadonlySet<string>): Promise<AgentFileFacts | null> {
    if (this.#closed || !isAgentId(agentId)) return null;
    const generation = this.#generation;
    const dir = await this.#satellite.resolve();
    if (dir === null || this.#stale(generation)) return null;
    const state = await this.#advance(join(dir, 'subagents', `agent-${agentId}.jsonl`), agentId, generation);
    if (state === null || this.#stale(generation)) return null;
    if (ended !== undefined && ended.size > 0) {
      // Kopia listy: `end()` wyjmuje zadanie z tablicy, po której idziemy.
      for (const task of [...state.tracker.tasks]) if (ended.has(task.id)) state.tracker.end(task.id);
    }
    const commands = ownCommands(state.tracker);
    const settled = state.intact && state.atEnd && state.partial.length === 0 && !state.dropping
      && state.tailTimed;
    return {
      ...(state.lastAt === '' ? {} : { lastEntryAt: state.lastAt }),
      commands,
      ...(settled ? { settled: state.otherWorkUntil === -Infinity ? {} : { otherWorkUntil: state.otherWorkUntil } } : {}),
    };
  }

  repoint(agentSessionId: string): void {
    this.#generation += 1;
    this.#satellite.repoint(agentSessionId);
    this.#files.clear();
  }

  relocated(): void {
    this.#satellite.relocated();
  }

  close(): void {
    this.#closed = true;
    this.#files.clear();
  }

  /** Czy odczyt rozpoczęty w pokoleniu `generation` jest już nieaktualny. */
  #stale(generation: number): boolean {
    return this.#closed || generation !== this.#generation;
  }

  /**
   * Doczytuje plik do rozmiaru z chwili otwarcia. `null` = pliku nie ma albo odczyt się
   * zdezaktualizował; inaczej stan pliku, także gdy odczyt padł w połowie (wiemy to, co doszło).
   */
  async #advance(path: string, agentId: string, generation: number): Promise<FileState | null> {
    // Do końca dochodzi dopiero odczyt, który się uda: błąd w połowie oddaje stary stan bez tego znacznika.
    const before = this.#files.get(agentId);
    if (before !== undefined) before.atEnd = false;
    let handle: OpenedFile;
    try {
      handle = await this.#open(path);
    } catch {
      return null;
    }
    try {
      const info = await handle.stat();
      if (this.#stale(generation)) return null;
      const known = this.#files.get(agentId);
      const state: FileState = known
        ?? {
          offset: 0, ino: info.ino, dev: info.dev, partial: EMPTY, dropping: false, dropped: 0,
          lastAt: '', lastMs: -Infinity, tracker: agentTracker(),
          intact: true, atEnd: false, tailTimed: false, otherWorkUntil: -Infinity,
        };
      if (known === undefined) this.#files.set(agentId, state);

      // Inna zawartość pod tą samą nazwą: bufor i lista komend należały do tamtej.
      if (info.ino !== state.ino || info.dev !== state.dev || info.size < state.offset) {
        state.ino = info.ino;
        state.dev = info.dev;
        resetCarry(state);
        state.tracker = agentTracker();
        state.intact = false;
        state.offset = info.size;
        return state;
      }
      if (info.size === state.offset) {
        state.atEnd = true;
        return state;
      }

      const startedAt = this.#now();
      let from = state.offset;
      if (info.size - from > this.#maxReadBytes) {
        // Przeskok: zostaje ogon, a jego pierwsza linia jest ucięta w nieznanym miejscu. Pominięty
        // kawałek mógł nieść koniec komendy, więc lista komend rusza od zera.
        from = info.size - this.#maxReadBytes;
        resetCarry(state, true);
        state.tracker = agentTracker();
        state.intact = false;
      }
      const buffer = Buffer.allocUnsafe(Math.min(this.#chunkBytes, info.size - from));
      while (from < info.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, info.size - from), from);
        if (this.#stale(generation)) return null;
        if (bytesRead === 0) break;
        from += bytesRead;
        state.offset = from;
        this.#consume(state, buffer.subarray(0, bytesRead));
      }
      state.atEnd = state.offset >= info.size;
      if (known === undefined && info.size > this.#costLogBytes) {
        this.#log(
          `rarog: ${AGENT_FILE_COST_LOG} to agent-${agentId}.jsonl: ${String(info.size)} B `
          + `in ${String(Math.round(this.#now() - startedAt))} ms`,
        );
      }
      return state;
    } catch {
      // Odczyt padł w połowie: offset stoi za ostatnią przerobioną porcją, reszta przy następnym.
      return this.#files.get(agentId) ?? null;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /**
   * Porcja bajtów → kompletne linie (z buforem niedokończonej) → fakty. Cięcie na linie
   * i sufit długości linii są wspólne z przeglądem pliku głównego (`jsonl-lines.ts`).
   */
  #consume(state: FileState, bytes: Buffer): void {
    const dropped = state.dropped;
    const lines = takeLines(state, bytes, this.#lineMaxBytes);
    // Pominięta linia to dziura w historii pliku, na stałe.
    if (state.dropped !== dropped) state.intact = false;
    this.#note(state, lines);
  }

  /**
   * Partia kompletnych linii → fakty, w dwóch przejściach nad tymi samymi liniami.
   *
   * 1. CZAS, od końca: parsujemy linie od ostatniej i stajemy na pierwszym wpisie z WŁASNYM
   *    czasem. Wpisy powstają po kolei, więc starsze linie partii mają czas nie późniejszy.
   *    Załącznik po drodze też się liczy (do maksimum), ale na nim nie stajemy.
   * 2. KOMENDY, od początku: reduktor dostaje w kolejności zapisu wyłącznie linie, które przeszły
   *    prefiltr. Kolejność jest tu treścią: wywołanie musi stać przed swoim wynikiem.
   *
   * Linia sparsowana w pierwszym przejściu nie jest parsowana drugi raz.
   */
  #note(state: FileState, lines: readonly Buffer[]): void {
    const parsed = new Map<number, unknown>();
    const parse = (at: number): unknown => {
      if (!parsed.has(at)) parsed.set(at, parseJsonlEntry((lines[at] ?? EMPTY).toString('utf8')));
      return parsed.get(at);
    };
    const noteTime = (entry: unknown): void => {
      const time = timeOf(entry);
      if (time === null || time.ms <= state.lastMs) return;
      state.lastMs = time.ms;
      state.lastAt = time.at;
    };

    for (let at = lines.length - 1; at >= 0; at -= 1) {
      const entry = parse(at);
      noteTime(entry);
      if (hasOwnTime(entry)) break;
    }
    // Koniec pliku jest znany tylko wtedy, gdy jego ostatnia kompletna linia dała własny czas.
    if (lines.length > 0) state.tailTimed = hasOwnTime(parse(lines.length - 1));
    for (let at = 0; at < lines.length; at += 1) {
      if (!mayCarryOwnCommand(lines[at] ?? EMPTY)) continue;
      const entry = parse(at);
      // Linia, która mogła nieść start albo koniec zadania, a nie dała się sparsować: dziura.
      if (entry === null) state.intact = false;
      noteTime(entry);
      state.tracker.note(entry);
      // Wywołanie narzędzia przechodzi prefiltr (`"tool_use"`), więc monitor i zagnieżdżone zadania widać tu.
      state.otherWorkUntil = Math.max(state.otherWorkUntil, otherWorkOf(entry));
    }
  }
}

export function createAgentFileReader(opts: AgentFileReaderOptions): AgentFileReader {
  return new Reader(opts);
}
