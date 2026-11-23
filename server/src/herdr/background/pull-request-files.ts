/**
 * Czytnik plików rozmowy pod kątem pull requestów: plik główny `<uuid>.jsonl`, pliki subagentów
 * `subagents/agent-<id>.jsonl` i agentów workflow `subagents/workflows/wf_<id>/agent-<id>.jsonl`.
 * Rozpoznanie i lista: `pull-requests.ts`; opis całości: `docs/pull-requests.md`.
 *
 * Dlaczego osobny czytnik, a nie follower pliku głównego i czytnik pliku subagenta (`agent-file.ts`):
 * tamte patrzą na wybrane pliki (okno ogona, otwarci agenci), a PR powstaje w dowolnym agencie, także takim,
 * który dawno skończył, i ma być widoczny po restarcie serwera. Ten moduł czyta więc WSZYSTKIE pliki rozmowy
 * sesji, przyrostowo, z prefiltrem przed `JSON.parse` ({@link mayCarryPullRequest}). Plik główny czyta drugi
 * raz (follower czyta go po swojemu): to cena jednego mechanizmu dla trzech źródeł.
 *
 * Granica odczytu: z pliku agenta workflow ten moduł czyta TREŚĆ (wywołania `Bash` i ich wyniki), nie tylko
 * tag z pierwszej linii jak `workflow-run.ts`. Dalej wychodzi wyłącznie adres PR, numer, repo, czas i tytuł
 * z `--title`. Pliki subagentów i agentów workflow czyta tylko za zgodą `RAROG_AGENT_FILES` (opcja `subagents`).
 *
 * Koszt (pomiar na magazynie plików rozmów CLI 2.1.216–2.1.319, 313 sesji z katalogiem `subagents/`): pliki
 * agentów jednej sesji mają w medianie 1,1 MiB, p90 63 MiB, p99 418 MiB, najwięcej 976 MiB w 356 plikach. Dlatego
 * jeden odczyt bierze najwyżej {@link PULL_REQUEST_SCAN_BUDGET_BYTES}, a reszta czeka na następny (`backlog`);
 * nic nie jest pomijane, offset każdego pliku idzie dalej. Odczyt od {@link PULL_REQUEST_SCAN_LOG_BYTES}
 * zostawia w logu linię z kosztem.
 *
 * One file's read (byte chunks, lines through `jsonl-lines.ts` with an over-ceiling line skipped whole, a file
 * shorter than the offset or with another inode read from the start) is `incremental-read.ts`. Pliki trzymane są
 * pod nazwą względną wobec katalogu sesji, więc przeniesienie katalogu (`EnterWorktree`) zachowuje
 * offsety. Moduł nigdy nie rzuca; brak pliku albo katalogu to normalny stan.
 *
 * Output files: a recognized `gh pr create` that ran in the background ends with a CLI notification naming its
 * output file (`<tmp>/claude-<uid>/<slug>/<session uuid>/tasks/<task id>.output`). The reader reads that one file,
 * after a shape check of the path ({@link isTaskOutputPath}), through `safe-read.ts` without following a symlink and
 * up to {@link PULL_REQUEST_OUTPUT_MAX_BYTES}; a longer file gives nothing. The agent in the sandbox can write that
 * directory, so a FIFO or a symlink there is expected and gives nothing. Only the PR URL leaves the file.
 */
import { readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import type { SessionPullRequest } from '@rarog/shared';
import { defaultStoreRoot } from '../../cli-store.ts';
import { readRegularFile } from '../../safe-read.ts';
import { TRANSCRIPT_EXT, locateTranscript } from '../transcript-path.ts';
import { parseJsonlEntry } from '../jsonl-pending.ts';
import { CLI_SHAPES } from './cli-shapes.ts';
import { isAgentId, isBackgroundTaskId, isRunId } from './ids.ts';
import { cursorAt, readIncrement } from './incremental-read.ts';
import type { FileCursor } from './incremental-read.ts';
import {
  createPullRequestCalls, createPullRequestList, mayCarryPullRequest, pullRequestsFromOutput, pullRequestsOf,
} from './pull-requests.ts';
import type { PullRequestCalls, PullRequestList, PullRequestOutput } from './pull-requests.ts';

/**
 * Co ile driver czyta pliki rozmowy po sygnale (przyrost pliku głównego, zmiana listy zadań w tle). Sygnały
 * w tym oknie składają się w jeden odczyt.
 */
export const PULL_REQUESTS_POLL_MS = 5_000;
/** Przerwa między odczytami, gdy poprzedni zostawił zaległość (budżet się skończył). */
export const PULL_REQUESTS_BACKLOG_MS = 1_000;
/** Ile bajtów najwyżej czyta jeden odczyt, łącznie ze wszystkich plików. */
export const PULL_REQUEST_SCAN_BUDGET_BYTES = 256 * 1024 * 1024;
/** Jedna porcja odczytu. */
export const PULL_REQUEST_CHUNK_BYTES = 1024 * 1024;
/** Sufit długości jednej linii; dłuższa (wynik `Read` z obrazem) jest pomijana w całości. */
export const PULL_REQUEST_LINE_MAX_BYTES = 8 * 1024 * 1024;
/** Od tylu przeczytanych bajtów odczyt zostawia w logu linię z kosztem. */
export const PULL_REQUEST_SCAN_LOG_BYTES = 8 * 1024 * 1024;
/** Fraza linii logu z kosztem odczytu. */
export const PULL_REQUEST_SCAN_LOG = 'pull request scan';
/** Ceiling of one background output file; `gh pr create` prints a few lines. A longer file gives no PR. */
export const PULL_REQUEST_OUTPUT_MAX_BYTES = 64 * 1024;

const NOTIFICATION = CLI_SHAPES.notification.literals;
/** The session directory that holds `tasks/`: a conversation uuid. */
const SESSION_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether `path` from a notification has the shape of the task's output file: absolute and already normal (no `..`,
 * `.`, `//` or trailing `/`), named `<taskId>.output`, in a `tasks` directory whose parent is a session uuid.
 */
export function isTaskOutputPath(path: string, taskId: string): boolean {
  if (!isBackgroundTaskId(taskId) || !isAbsolute(path) || normalize(path) !== path || path.endsWith('/')) return false;
  if (basename(path) !== `${taskId}${NOTIFICATION.outputExtension}`) return false;
  const tasks = dirname(path);
  return basename(tasks) === NOTIFICATION.outputDir && SESSION_DIR.test(basename(dirname(tasks)));
}

/** PRs from a background call's output file; nothing on a refused path, a missing or odd file, or an error. */
async function outputPullRequests(output: PullRequestOutput): Promise<SessionPullRequest[]> {
  if (!isTaskOutputPath(output.path, output.taskId)) return [];
  try {
    const read = await readRegularFile(output.path, { maxBytes: PULL_REQUEST_OUTPUT_MAX_BYTES, followSymlink: false });
    if (read === null || read.truncated) return [];
    return pullRequestsFromOutput(read.bytes.toString('utf8'), output);
  } catch {
    return [];
  }
}

/** Wynik jednego odczytu. */
export interface PullRequestRead {
  /** Lista PR-ów rozmowy (najnowszy pierwszy). */
  readonly pullRequests: SessionPullRequest[];
  /** Budżet odczytu się skończył i część plików czeka na następny odczyt. */
  readonly backlog: boolean;
}

export interface PullRequestFilesReader {
  /**
   * Doczytuje pliki rozmowy od zapamiętanych miejsc i oddaje listę; `null` = odczyt nieaktualny (`repoint`,
   * `close` w trakcie). Wołający czyta po kolei: równoległe odczyty nie są obsługiwane.
   */
  read(): Promise<PullRequestRead | null>;
  /** `/clear`, `/resume`: inna rozmowa, inne pliki — lista i offsety od zera. */
  repoint(agentSessionId: string): void;
  /** Te same pliki pod nowym adresem (`EnterWorktree`): kasujemy sam adres, offsety zostają. */
  relocated(): void;
  close(): void;
}

export interface PullRequestFilesReaderOptions {
  cwd: string;
  agentSessionId: string;
  /** Czy czytać pliki subagentów i agentów workflow (`RAROG_AGENT_FILES`). `false` = sam plik główny. */
  subagents: boolean;
  /**
   * Ścieżka pliku głównego, który czyta follower; `null` = jeszcze go nie zna. Driver podaje ją z followera, więc
   * czytnik patrzy w ten sam plik (także po przeniesieniu i w testach z magazynem tymczasowym) i nie szuka go sam.
   * Bez niej czytnik szuka pliku globem po uuid w `root`.
   */
  locate?: () => string | null;
  /** Korzeń magazynu CLI dla szukania bez `locate`. Domyślnie `~/.claude/projects`. */
  root?: string;
  /** Sufity odczytu; testy zmniejszają je do bajtów. */
  budgetBytes?: number;
  chunkBytes?: number;
  lineMaxBytes?: number;
  now?: () => number;
  logger?: (message: string) => void;
}

/** Stan jednego pliku między odczytami. */
interface FileState extends FileCursor {
  calls: PullRequestCalls;
}

/** Nazwa względna pliku głównego w mapie stanów (pliki agentów mają ścieżkę względną wobec katalogu sesji). */
const MAIN = '';

class Reader implements PullRequestFilesReader {
  readonly #root: string;
  readonly #cwd: string;
  readonly #subagents: boolean;
  readonly #budgetBytes: number;
  readonly #chunkBytes: number;
  readonly #lineMaxBytes: number;
  readonly #now: () => number;
  readonly #log: (message: string) => void;
  readonly #locate: (() => string | null) | undefined;
  #uuid: string;
  /** Ścieżka pliku głównego; `null` = trzeba jej szukać (pierwszy odczyt, `repoint`, `relocated`). */
  #mainPath: string | null = null;
  #files = new Map<string, FileState>();
  #list: PullRequestList = createPullRequestList();
  /** Rośnie przy `repoint()` i `relocated()`; odczyt rozpoczęty wcześniej niczego nie oddaje. */
  #generation = 0;
  #closed = false;

  constructor(opts: PullRequestFilesReaderOptions) {
    this.#root = opts.root ?? defaultStoreRoot();
    this.#cwd = opts.cwd;
    this.#uuid = opts.agentSessionId;
    this.#locate = opts.locate;
    this.#subagents = opts.subagents;
    this.#chunkBytes = Math.max(1, opts.chunkBytes ?? PULL_REQUEST_CHUNK_BYTES);
    this.#budgetBytes = Math.max(this.#chunkBytes, opts.budgetBytes ?? PULL_REQUEST_SCAN_BUDGET_BYTES);
    this.#lineMaxBytes = Math.max(1, opts.lineMaxBytes ?? PULL_REQUEST_LINE_MAX_BYTES);
    this.#now = opts.now ?? Date.now;
    this.#log = opts.logger ?? ((message) => { console.warn(message); });
  }

  async read(): Promise<PullRequestRead | null> {
    if (this.#closed) return null;
    const generation = this.#generation;
    const stale = (): boolean => this.#closed || generation !== this.#generation;
    if (this.#locate !== undefined) this.#mainPath = this.#locate();
    else if (this.#mainPath === null) {
      const found = await locateTranscript(this.#root, this.#cwd, this.#uuid);
      if (stale()) return null;
      this.#mainPath = found;
    }
    const mainPath = this.#mainPath;
    if (mainPath === null) return { pullRequests: this.#list.pullRequests, backlog: false };
    const dir = mainPath.slice(0, mainPath.length - TRANSCRIPT_EXT.length);
    const names = [MAIN, ...(this.#subagents ? await agentFiles(dir) : [])];
    if (stale()) return null;

    const startedAt = this.#now();
    let budget = this.#budgetBytes;
    let read = 0;
    let backlog = false;
    for (const name of names) {
      if (budget <= 0) {
        backlog = true;
        break;
      }
      const outcome = await this.#advance(name === MAIN ? mainPath : join(dir, name), name, budget, stale);
      if (stale()) return null;
      budget -= outcome.bytes;
      read += outcome.bytes;
      if (outcome.more) backlog = true;
    }
    if (read >= PULL_REQUEST_SCAN_LOG_BYTES) {
      this.#log(
        `rarog: ${PULL_REQUEST_SCAN_LOG} ${this.#uuid}: ${String(read)} B from ${String(names.length)} files `
        + `in ${String(Math.round(this.#now() - startedAt))} ms${backlog ? ', more in the next read' : ''}`,
      );
    }
    return { pullRequests: this.#list.pullRequests, backlog };
  }

  repoint(agentSessionId: string): void {
    this.#generation += 1;
    this.#uuid = agentSessionId;
    this.#mainPath = null;
    this.#files = new Map();
    this.#list = createPullRequestList();
  }

  relocated(): void {
    this.#generation += 1;
    this.#mainPath = null;
  }

  close(): void {
    this.#closed = true;
    this.#files = new Map();
  }

  /**
   * Doczytuje jeden plik najwyżej o `budget` bajtów. `bytes` = ile przeczytano, `more` = plik ma jeszcze
   * nieprzeczytaną część. Błąd w połowie zostawia offset za ostatnią przerobioną porcją.
   */
  #advance(
    path: string, name: string, budget: number, stale: () => boolean,
  ): Promise<{ bytes: number; more: boolean }> {
    const list = this.#list;
    return readIncrement<FileState>(path, {
      cursor: this.#files.get(name),
      // Inna zawartość pod tą samą nazwą albo plik krótszy: czytamy od początku (lista PR-ów zostaje,
      // ten sam adres drugi raz niczego nie dodaje).
      restart: (identity) => {
        const state = { ...cursorAt(identity), calls: createPullRequestCalls() };
        this.#files.set(name, state);
        return state;
      },
      budgetBytes: budget,
      chunkBytes: this.#chunkBytes,
      lineMaxBytes: this.#lineMaxBytes,
      stale,
      onLines: (lines, state) => {
        const outputs: PullRequestOutput[] = [];
        for (const line of lines) {
          if (!mayCarryPullRequest(line)) continue;
          const found = pullRequestsOf(parseJsonlEntry(line.toString('utf8')), state.calls);
          for (const pr of found.pullRequests) list.add(pr);
          outputs.push(...found.outputs);
        }
        if (outputs.length === 0) return undefined;
        // The offset is already past these lines and the waiting calls left the memory, so every output read here
        // lands in the list it was asked for, even when the read went stale meanwhile: `relocated()` keeps that
        // list, `repoint()` and `close()` drop it.
        return (async () => {
          for (const output of outputs) for (const pr of await outputPullRequests(output)) list.add(pr);
        })();
      },
    });
  }
}

/**
 * Pliki agentów sesji jako ścieżki względne wobec katalogu sesji, posortowane: `subagents/agent-<id>.jsonl`
 * i `subagents/workflows/wf_<id>/agent-<id>.jsonl`. Nazwy przechodzą przez strażniki `ids.ts`, zanim staną
 * się ścieżką. Brak katalogu = pusta lista.
 */
async function agentFiles(dir: string): Promise<string[]> {
  const agents = async (sub: string): Promise<string[]> => {
    try {
      return (await readdir(join(dir, sub), { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.startsWith('agent-') && entry.name.endsWith(TRANSCRIPT_EXT)
          && isAgentId(entry.name.slice('agent-'.length, -TRANSCRIPT_EXT.length)))
        .map((entry) => join(sub, entry.name));
    } catch {
      return [];
    }
  };
  const found = await agents('subagents');
  let runs: string[] = [];
  try {
    runs = (await readdir(join(dir, 'subagents', 'workflows'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && isRunId(entry.name))
      .map((entry) => entry.name);
  } catch {
    runs = [];
  }
  for (const run of runs) found.push(...await agents(join('subagents', 'workflows', run)));
  return found.sort();
}

export function createPullRequestFilesReader(opts: PullRequestFilesReaderOptions): PullRequestFilesReader {
  return new Reader(opts);
}
