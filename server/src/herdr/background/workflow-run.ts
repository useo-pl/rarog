/**
 * Rozkład przebiegu workflow: fazy ze skryptu, agenci z journala, tag `[faza · etykieta]`
 * z pierwszej linii transkryptu agenta.
 *
 * Moduł katalogu zadań w tle (mapa modułów: `index.ts`, opis całości: `docs/background-tasks.md`). Adres katalogu
 * sesji i jego relokację trzyma `satellite.ts`, strażniki identyfikatorów `ids.ts`.
 *
 * Pomiar, na którym stoi moduł (żywy przebieg `audyt-wdrozenie`, 17 agentów):
 *
 * - `workflows/scripts/<nazwa>-wf_<id>.js` powstaje NA STARCIE i ma `meta.phases[].title`
 *   w nagłówku — jedyne miejsce, gdzie stoi LISTA faz. Skrypt jest niezmienny, czytamy go raz.
 * - `subagents/workflows/wf_<id>/journal.jsonl` ma WYŁĄCZNIE wpisy `started`/`result`
 *   z `agentId` i hashem `key`. Bez czasu; do CLI 2.1.277 także bez etykiety i fazy — od 2.1.278
 *   wpis `started` niesie `label` i `phase` wprost. Wpis `result` niesie CAŁY
 *   wynik agenta (63 kB na 16 wyników), więc plik czytamy PRZYROSTOWO od zapamiętanego offsetu —
 *   journal jest append-only, a tick co kilka sekund nie ma prawa przewijać go od zera.
 * - `agent-<id>.meta.json` to `{"agentType":"workflow-subagent","spawnDepth":1}` — treści zero,
 *   ale jego `mtime` to chwila startu agenta (pisany raz, przed transkryptem).
 * - `agent-<id>.jsonl`, pierwsza linia: wpis `user` z promptem jako gołym stringiem. Konwencja
 *   skryptów każe kłaść `[Faza B · impl:auth]` na początku promptu — to ZAPAS dla journala bez
 *   `label`/`phase` (starsze CLI). Ten moduł czyta TYLKO ten tag (pierwsze bajty pierwszej linii), nie
 *   treść promptu: rozkład ma wiedzieć KTO, nie CO. Od 2.1.278 przed tagiem stoi rama harnessu
 *   (`[Workflow harness — computed task] …`), którą `parseAgentTag` zdejmuje. Wyjątek od tej granicy ma
 *   lista PR-ów sesji (`pull-request-files.ts`): czyta treść pliku agenta z prefiltrem i wydaje z niej
 *   tylko adres PR, repo, numer, czas i dosłowny `--title`.
 * - plik wyjściowy zadania workflow w `tasks/` jest pusty (0 B). Bieżącej fazy przebiegu NIE MA
 *   na dysku — UI wnioskuje ją wyłącznie z agentów, którzy w danej fazie pracują.
 *
 * - Wznowienie (`resumeFromRunId`, zmierzone na `wf_c2c2b063-970`) pisze do TEGO
 *   SAMEGO journala bez żadnego znacznika: ani drugiego `launched`, ani wpisu dla agentów
 *   przerwanych `TaskStop`-em. Przerwani zostają ze `started` bez `result`, a ponowione wywołanie
 *   dostaje nowe `started` z nowym `agentId` i tą samą `phase` i `label` (`key` bywa inny, gdy
 *   skrypt zmieniono przed wznowieniem). Ostatni wpis transkryptu przerwanego agenta to czasem
 *   `[Request interrupted by user]`, a czasem nic szczególnego (2 z 5 padły na `ENOSPC`), więc
 *   nie on o tym decyduje. Ślad wznowienia jest w transkrypcie RODZICA: wynik narzędzia
 *   `Workflow` z tym samym `runId` i nowym `taskId`. Tracker zadań (`reducer.ts`) ma z niego
 *   `startedAt` otwartego zadania, czyli chwilę OSTATNIEGO uruchomienia; agenci wznowienia
 *   startowali 0,26–1,02 s po niej, przerwani 2 h wcześniej.
 *
 * Czego moduł NIE robi: nie zgaduje, ile agentów zostało (skrypt decyduje w locie), nie
 * rozróżnia sukcesu od porażki agenta (journal tego nie niesie) i nigdy nie rzuca — brak pliku
 * to normalny stan między startem workflow a pierwszym agentem.
 */
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkflowAgent, WorkflowRun } from '@rarog/shared';
import { phaseCounts } from '@rarog/shared/workflow-phases';
import { defaultStoreRoot } from '../../cli-store.ts';
import { isAgentId, isRunId } from './ids.ts';
import { createSatelliteDir } from './satellite.ts';
import type { SatelliteDir } from './satellite.ts';

/** Ile bajtów nagłówka skryptu wystarczy na `meta` — `phases` stoi w pierwszych liniach. */
const SCRIPT_HEAD_BYTES = 16 * 1024;
/** Ile bajtów pierwszej linii transkryptu agenta czytamy w poszukiwaniu tagu. */
const AGENT_HEAD_BYTES = 4 * 1024;
/** Ile znaków promptu odkodowujemy: rama harnessu (~480 znaków) + tag (do 160). */
const PROMPT_HEAD_CHARS = 1024;
/** Sufit JEDNEGO przyrostowego odczytu journala — wynik agenta bywa długi, ale nie bez końca. */
const JOURNAL_CHUNK_BYTES = 4 * 1024 * 1024;
/** Tyle znaków z początku wpisu journala wystarcza na `type` i `agentId` (stoją przed `result`). */
const JOURNAL_LINE_HEAD = 512;
/**
 * Sufit liczby agentów w jednym przebiegu — powyżej tego rozkład i tak nie mieści się na ekranie.
 * Znany koszt: przerwani przed wznowieniem też zajmują miejsca, więc
 * przebieg z 200 przerwanymi pokaże po wznowieniu pusty rozkład zamiast nowych agentów.
 */
export const WORKFLOW_RUN_MAX_AGENTS = 200;
/**
 * Zapas na kolejność zapisów przy uruchomieniu. Czas uruchomienia to znacznik wpisu z WYNIKIEM
 * narzędzia `Workflow`, a skrypt rusza w tle, gdy wynik jest jeszcze w drodze, więc pierwszy agent
 * może mieć `meta.json` o ułamek sekundy starszy. Przerwanego od wznowienia dzieli `TaskStop`
 * i nowe wywołanie — od sekund do godzin.
 */
const LAUNCH_SLACK_MS = 5_000;

// ---------------------------------------------------------------------------
// Czyste parsery (eksportowane dla testów — każdy stoi na jednym zmierzonym kształcie)
// ---------------------------------------------------------------------------

/**
 * Tytuły faz z nagłówka skryptu workflow.
 *
 * Skrypt to JavaScript, ale `meta` MUSI być czystym literałem (wymóg narzędzia `Workflow`),
 * więc regex na `title:` wewnątrz tablicy `phases` wystarcza — bez wykonywania cudzego kodu.
 * Szukamy tylko w bloku `export const meta = {…}` (do pierwszej linii `}` w kolumnie zerowej),
 * żeby `title` z dalszej części skryptu (np. w promptach) nie udawał fazy.
 */
export function parseScriptPhases(source: string): string[] {
  const start = source.indexOf('export const meta');
  if (start === -1) return [];
  const end = source.indexOf('\n}', start);
  const block = source.slice(start, end === -1 ? undefined : end);
  const phasesAt = block.indexOf('phases');
  if (phasesAt === -1) return [];
  const list = block.slice(phasesAt);
  const titles: string[] = [];
  for (const hit of list.matchAll(/title\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/g)) {
    const title = (hit[2] ?? '').replace(/\\(['"`])/g, '$1').trim();
    if (title !== '' && !titles.includes(title)) titles.push(title);
  }
  return titles;
}

/** Tag z początku promptu: `[Faza B · impl:auth]` → faza i etykieta; `[· label]` → sama etykieta. */
export interface AgentTag {
  phase?: string;
  label?: string;
}

/**
 * Tag `[faza · etykieta]` z tekstu promptu. `null` = prompt nie zaczyna się od `[…]` (skrypt bez tagu).
 *
 * Separator to ` · ` (U+00B7); bez niego cała treść nawiasu jest etykietą — lepsza etykieta
 * bez fazy niż faza zgadnięta z połowy napisu.
 */
export function parseAgentTag(prompt: string): AgentTag | null {
  const hit = /^\s*\[([^\]\n]{1,160})\]/.exec(stripHarnessFrame(prompt));
  if (hit === null) return null;
  const inner = hit[1] ?? '';
  const dot = inner.indexOf('·');
  const tag: AgentTag = {};
  if (dot === -1) {
    const label = inner.trim();
    if (label !== '') tag.label = label;
  } else {
    const phase = inner.slice(0, dot).trim();
    const label = inner.slice(dot + 1).trim();
    if (phase !== '') tag.phase = phase;
    if (label !== '') tag.label = label;
  }
  return tag.phase === undefined && tag.label === undefined ? null : tag;
}

/**
 * Rama harnessu (zmierzone na CLI 2.1.278): prompt agenta workflow zaczyna się od
 * `[Workflow harness — computed task] …The computed task text follows:\n  `, a dopiero po niej
 * stoi wcięty tekst ze skryptu. Bez zdjęcia ramy KAŻDY agent dostałby etykietę „Workflow harness —
 * computed task" i żadnej fazy, więc szyna faz nie podświetliłaby niczego. Rama bez końca w odczytanym
 * fragmencie daje pusty napis — brak tagu jest prawdą, etykieta z ramy nie.
 */
const HARNESS_FRAME = /^\s*\[Workflow harness\b/;

function stripHarnessFrame(prompt: string): string {
  if (!HARNESS_FRAME.test(prompt)) return prompt;
  const end = prompt.indexOf('\n');
  return end === -1 ? '' : prompt.slice(end + 1);
}

/**
 * Prompt z PIERWSZEJ linii transkryptu agenta — bez parsowania całej linii jako JSON.
 *
 * Linia niesie cały prompt (bywa kilkanaście kB), a nas interesuje tylko jego początek: szukamy
 * `"content":"` (prompt jako goły string — kształt zmierzony) albo `"text":"` w pierwszym bloku
 * tablicy `content` (kształt z załącznikami) i odkodowujemy kilkaset znaków po nim. Escape'y
 * JSON-a w tym fragmencie to `\"`, `\\` i `\n` — więcej tag nie potrzebuje.
 */
export function promptHeadOf(lineHead: string): string {
  const at = (() => {
    const direct = lineHead.indexOf('"content":"');
    if (direct !== -1) return direct + '"content":"'.length;
    const text = lineHead.indexOf('"text":"');
    return text === -1 ? -1 : text + '"text":"'.length;
  })();
  if (at === -1) return '';
  const raw = lineHead.slice(at, at + PROMPT_HEAD_CHARS);
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i] ?? '';
    if (ch === '"') break;
    if (ch === '\\') {
      const next = raw[i + 1] ?? '';
      i += 1;
      if (next === 'n') out += '\n';
      else if (next === 'u') {
        out += String.fromCharCode(Number.parseInt(raw.slice(i + 1, i + 5), 16) || 0);
        i += 4;
      } else out += next;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Wpis journala → `started` albo `result` z identyfikatorem; `null` = inny kształt (ignorujemy).
 *
 * `failed` (agent padł: błąd narzędzia, sufit tur) wraca jako `result` — dla rozkładu to ta sama
 * prawda: TEN agent już nie pracuje. Zmierzone na żywym przebiegu (2 z 5 agentów);
 * bez tego padły agent świeciłby kropką pracy do końca przebiegu, a licznik „skończyło" by go nie znał.
 * Journal nie rozróżnia sukcesu od porażki w kształcie, na którym stoi UI, więc i my nie.
 */
export interface JournalEntry extends AgentTag {
  type: 'started' | 'result';
  agentId: string;
}

export function parseJournalLine(line: string): JournalEntry | null {
  const head = line.slice(0, JOURNAL_LINE_HEAD);
  const type = /"type"\s*:\s*"(started|result|failed)"/.exec(head)?.[1];
  const agentId = /"agentId"\s*:\s*"([A-Za-z0-9_-]+)"/.exec(head)?.[1];
  if (type === undefined || agentId === undefined) return null;
  if (type !== 'started') return { type: 'result', agentId };
  return { type: 'started', agentId, ...startedTag(line) };
}

/**
 * `label` i `phase` z wpisu `started` — od CLI 2.1.278 journal niesie je
 * wprost, obok hasha `key`. Wpis `started` jest krótki (bez wyniku), więc cały idzie przez
 * `JSON.parse`; dłuższy niż nagłówek albo zepsuty = brak tagu, zostaje tag z promptu.
 */
function startedTag(line: string): AgentTag {
  if (line.length > JOURNAL_LINE_HEAD * 4) return {};
  let entry: unknown;
  try {
    entry = JSON.parse(line);
  } catch {
    return {};
  }
  if (typeof entry !== 'object' || entry === null) return {};
  const { phase, label } = entry as { phase?: unknown; label?: unknown };
  const tag: AgentTag = {};
  if (typeof phase === 'string' && phase.trim() !== '') tag.phase = phase.trim().slice(0, 160);
  if (typeof label === 'string' && label.trim() !== '') tag.label = label.trim().slice(0, 160);
  return tag;
}

/*
 * `phaseCounts` mieszka w `@rarog/shared/workflow-phases`: tej samej
 * reguły podziału na fazy potrzebuje KLIENT — pasek i licznik `n/m` nad szyną faz w bloku
 * „w tle" mają mówić to samo, co pasek na karcie tej samej sesji w sidebarze. Re-eksport zostaje,
 * bo driver i testy serwera wołają ją stąd i nie mają powodu wiedzieć o przeprowadzce.
 */
export { phaseCounts };

// ---------------------------------------------------------------------------
// Czytnik
// ---------------------------------------------------------------------------

export interface WorkflowRunReader {
  /**
   * Bieżący rozkład przebiegu; `null` = katalogu jeszcze nie ma (albo nic o nim nie wiemy).
   * `launchedAt` = chwila OSTATNIEGO uruchomienia przebiegu (`startedAt` otwartego zadania);
   * bez niej rozkład pokazuje wszystkich agentów journala, także przerwanych.
   */
  read(runId: string, launchedAt?: string): Promise<WorkflowRun | null>;
  /** `/clear`: inna sesja silnika, inny katalog satelity — cały cache w kosz. */
  repoint(agentSessionId: string): void;
  /**
   * Ten sam przebieg, ale jego pliki PRZENIOSŁY SIĘ (`EnterWorktree`).
   *
   * Kasujemy WYŁĄCZNIE adres katalogu: journal i transkrypty agentów pojechały razem z nim
   * `rename(2)`-em, więc offsety i opisani agenci dalej są prawdą. Wołane sygnałem `relocated`
   * followera; najbliższy odczyt zrobi glob po uuid od nowa.
   */
  relocated(): void;
  close(): void;
}

export interface WorkflowRunReaderOptions {
  cwd: string;
  agentSessionId: string;
  /** Korzeń magazynu CLI. Domyślnie `~/.claude/projects` (testy dają katalog tymczasowy). */
  root?: string;
}

/** Stan jednego przebiegu między odczytami — to, co journal dopisuje, i to, co jest niezmienne. */
interface RunState {
  /** Fazy ze skryptu; `null` = skryptu jeszcze nie znaleziono (spróbujemy znów). */
  phases: string[] | null;
  /** Ile bajtów journala już przerobiliśmy. */
  offset: number;
  /** Niedokończona ostatnia linia z poprzedniego odczytu. */
  partial: string;
  /** Agenci w kolejności startu. */
  agents: Map<string, WorkflowAgent>;
  /** Agenci, których tag i czas startu już mamy (niezmienne — nie czytamy drugi raz). */
  described: Set<string>;
}

class Reader implements WorkflowRunReader {
  /** Adres katalogu sesji obok transkryptu — ten sam, którego używa puls tury (`satellite.ts`). */
  readonly #satellite: SatelliteDir;
  #closed = false;
  readonly #runs = new Map<string, RunState>();

  constructor(opts: WorkflowRunReaderOptions) {
    this.#satellite = createSatelliteDir({
      root: opts.root ?? defaultStoreRoot(), cwd: opts.cwd, agentSessionId: opts.agentSessionId,
    });
  }

  async read(runId: string, launchedAt?: string): Promise<WorkflowRun | null> {
    if (this.#closed || !isRunId(runId)) return null;
    const dir = await this.#satellite.resolve();
    if (dir === null || this.#closed) return null;
    const state = this.#runs.get(runId) ?? {
      phases: null, offset: 0, partial: '', agents: new Map(), described: new Set(),
    };
    this.#runs.set(runId, state);

    if (state.phases === null) state.phases = await readScriptPhases(dir, runId);
    const runDir = join(dir, 'subagents', 'workflows', runId);
    await this.#advanceJournal(runDir, state);
    await this.#describeAgents(runDir, state);
    if (this.#closed) return null;
    if (state.phases === null && state.agents.size === 0) return null;
    return { phases: state.phases ?? [], agents: withoutInterrupted([...state.agents.values()], launchedAt) };
  }

  repoint(agentSessionId: string): void {
    this.#satellite.repoint(agentSessionId);
    this.#runs.clear();
  }

  relocated(): void {
    this.#satellite.relocated();
  }

  close(): void {
    this.#closed = true;
    this.#runs.clear();
  }

  /** Dopisane od ostatniego razu linie journala → nowi agenci i nowe zakończenia. */
  async #advanceJournal(runDir: string, state: RunState): Promise<void> {
    let handle;
    try {
      handle = await open(join(runDir, 'journal.jsonl'), 'r');
    } catch {
      return;
    }
    try {
      const size = (await handle.stat()).size;
      // Plik skrócony (przebieg wznowiony od zera) — zaczynamy od początku, bez duchów.
      if (size < state.offset) {
        state.offset = 0;
        state.partial = '';
        state.agents.clear();
        state.described.clear();
      }
      if (size === state.offset) return;
      const length = Math.min(size - state.offset, JOURNAL_CHUNK_BYTES);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, state.offset);
      state.offset += bytesRead;
      const text = state.partial + buffer.subarray(0, bytesRead).toString('utf8');
      const lines = text.split('\n');
      state.partial = lines.pop() ?? '';
      for (const line of lines) this.#noteJournal(line, state);
    } catch {
      // Odczyt padł w połowie — offset został na starym miejscu tylko, gdy nic nie przeczytaliśmy.
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  #noteJournal(line: string, state: RunState): void {
    const entry = parseJournalLine(line);
    if (entry === null) return;
    const known = state.agents.get(entry.agentId);
    if (entry.type === 'started') {
      if (known !== undefined || state.agents.size >= WORKFLOW_RUN_MAX_AGENTS) return;
      const agent: WorkflowAgent = { id: entry.agentId, done: false };
      if (entry.phase !== undefined) agent.phase = entry.phase;
      if (entry.label !== undefined) agent.label = entry.label;
      state.agents.set(entry.agentId, agent);
      return;
    }
    // `result`/`failed` bez `started` (start sprzed sufitu agentów) — nie zakładamy ducha.
    if (known !== undefined) known.done = true;
  }

  /** Tag i czas startu dla agentów, których jeszcze nie opisaliśmy — raz na agenta. */
  async #describeAgents(runDir: string, state: RunState): Promise<void> {
    for (const agent of state.agents.values()) {
      if (state.described.has(agent.id) || !isAgentId(agent.id)) continue;
      // Czas startu niezależnie od transkryptu: agent przerwany, zanim cokolwiek zapisał, też
      // musi dać się odróżnić od agentów ostatniego uruchomienia (`withoutInterrupted`).
      if (agent.startedAt === undefined) {
        const startedAt = await mtimeIso(join(runDir, `agent-${agent.id}.meta.json`));
        if (startedAt !== null) agent.startedAt = startedAt;
      }
      const head = await readHead(join(runDir, `agent-${agent.id}.jsonl`), AGENT_HEAD_BYTES);
      // Transkrypt jeszcze nie powstał (albo jest pusty) — agent dopiero rusza; tag spróbujemy
      // wziąć przy następnym odczycie.
      if (head === null || head === '') continue;
      state.described.add(agent.id);
      // Journal (CLI ≥ 2.1.278) ma pierwszeństwo: to wartości z wywołania `agent()`, nie konwencja.
      const tag = parseAgentTag(promptHeadOf(head.split('\n')[0] ?? ''));
      if (agent.phase === undefined && tag?.phase !== undefined) agent.phase = tag.phase;
      if (agent.label === undefined && tag?.label !== undefined) agent.label = tag.label;
    }
  }
}

/**
 * Rozkład bez agentów przerwanych przed OSTATNIM uruchomieniem przebiegu (pomiar w nagłówku).
 *
 * Wznowienie zaczyna się od zatrzymania poprzedniego uruchomienia, więc agent bez `result`,
 * który wystartował przed `launchedAt`, już nie pracuje i nie skończy; jego krok, jeśli skrypt
 * go zostawił, ponawia nowy agent. Bez tego przerwani wisieli jako „pracuje" obok następców,
 * a mianownik fazy liczył ich podwójnie (0/10 zamiast 0/5). Skończeni z wcześniejszych
 * uruchomień zostają: to kroki, które wznowienie oddało z pamięci podręcznej. Agent bez czasu
 * startu (brak `meta.json`) też zostaje, bo nie wiadomo, do którego uruchomienia należy.
 * W przebiegu bez wznowienia nikt nie startuje przed uruchomieniem, więc filtr nic nie zmienia.
 */
export function withoutInterrupted(
  agents: WorkflowAgent[], launchedAt: string | undefined,
): WorkflowAgent[] {
  const launch = launchedAt === undefined ? Number.NaN : Date.parse(launchedAt);
  if (Number.isNaN(launch)) return agents;
  const cutoff = launch - LAUNCH_SLACK_MS;
  return agents.filter((agent) =>
    agent.done || agent.startedAt === undefined || Date.parse(agent.startedAt) >= cutoff);
}

/** Fazy ze skryptu przebiegu; `null` = skryptu (jeszcze) nie ma w listingu. */
async function readScriptPhases(dir: string, runId: string): Promise<string[] | null> {
  let entries: string[];
  try {
    entries = await readdir(join(dir, 'workflows', 'scripts'));
  } catch {
    return null;
  }
  const suffix = `-${runId}.js`;
  const hit = entries.find((entry) => entry.endsWith(suffix));
  if (hit === undefined) return null;
  const head = await readHead(join(dir, 'workflows', 'scripts', hit), SCRIPT_HEAD_BYTES);
  return head === null ? null : parseScriptPhases(head);
}

async function readHead(path: string, bytes: number): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function mtimeIso(path: string): Promise<string | null> {
  try {
    return new Date((await stat(path)).mtimeMs).toISOString();
  } catch {
    return null;
  }
}

export function createWorkflowRunReader(opts: WorkflowRunReaderOptions): WorkflowRunReader {
  return new Reader(opts);
}
