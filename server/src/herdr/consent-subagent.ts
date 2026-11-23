/**
 * Plik subagenta dla kanału zgód (warstwa 1): fakty biegu agenta z pliku
 * `<katalog sesji>/subagents/agent-<agentId>.jsonl` (wywołania i wyniki z rozstrzygnięciem dialogu), z których
 * `dialogs/layer1/proof.ts` składa dowód prośby subagenta, a `dialogs/layer1/bind.ts` wiąże klucze hooka subagenta.
 * Koniec biegu agenta czyta z pliku głównego `consent-evidence.ts`; ten moduł składa tylko część z pliku subagenta.
 * Opis: `docs/dialogs.md`, „Channel cycle”.
 *
 * - {@link subagentFileOf}: ścieżka pliku subagenta obok pliku wątku głównego (ten sam układ co
 *   `background/agent-file.ts`); `agentId` spoza gramatyki `isAgentId` = brak pliku.
 * - {@link createSubagentTurnScanner}: przebiegi przyrostowe od początku pliku z sufitem bajtów, jak przegląd wątku
 *   głównego: każdy czyta dalej od miejsca, w którym skończył poprzedni, a niedokończona linia czeka w pamięci na
 *   resztę. Inny `inode` albo plik krótszy niż przeczytana pozycja = przegląd od początku pliku.
 * - {@link createSubagentObservation}: fakty plików subagentów dla obserwacji kanału zgód przy trybie `all`
 *   (`subagentTurns` w `dialogs/layer1/observe.ts`, dowód z wierzchu prośby subagenta, 5.4): jeden przebieg
 *   na agenta i obserwację, odczyty jednej sesji po kolei. Do faktów pliku subagenta dochodzą fakty pliku głównego
 *   o agencie (`agent`, dowód ukryty, 5.3): przebieg celu z `agentId` przeglądu
 *   `consent-evidence.ts` od linii wywołania `Agent`, które agenta uruchomiło (`toolUseId` z pliku
 *   `agent-<agentId>.meta.json` obok pliku agenta, szukane wstecz od końca pliku głównego, raz na prośbę); bez pliku
 *   meta albo bez tej linii w oknach szukania od tury głównej `promptId` hooka. Rozmiar pliku głównego jest
 *   sprawdzony przed przebiegiem i po nim, razem z ostatnim bajtem: inny rozmiar, plik bez końca linii na końcu
 *   albo pełna linia od checkpointu, której nie dało się sparsować (`unparsedLine` przeglądu) = odczyt nieznany do
 *   końca (`settled: false`). Plik agenta workflow (`subagents/workflows/wf_<id>/agent-<id>.jsonl`, zmierzone)
 *   czyta się tak samo, gdy pod ścieżką {@link subagentFileOf} pliku nie ma, a agent ma plik w dokładnie jednym
 *   przebiegu ({@link agentFileOf}).
 *
 * Wpisy pliku subagenta niosą `isSidechain: true` i `agentId` (CLI 2.1.314, fixture'y `subagent-*` w
 * `server/test/fixtures/consent-dowod/`). Liczą się tylko wpisy z `agentId` tego agenta; czytane są tymi samymi
 * funkcjami co wątek główny (`jsonl-pending.ts`). The agent's run starts at its last opening entry and lasts to the
 * end of the file. An opening entry is the agent's task (a human entry: not a result, not an interruption, not
 * a compaction summary) or the resume message the main thread sends with `SendMessage` (an `isMeta` entry with
 * `origin.kind: coordinator`, CLI 2.1.322). A compaction (`isCompactSummary` and `system/compact_boundary`, CLI
 * 2.1.322) does not open a run. The `promptId` of the entries and of the hook does not bind a request to a run:
 * a new main-thread message while the agent runs moves it on every later `user` entry of the agent file and on the
 * agent's next hooks, with no opening entry carrying it (CLI 2.1.322).
 *
 * Scope of the facts ({@link SubagentScanScope}): `run` (the request's proof in the observation) holds the calls of
 * the current run and the results of the whole file, so a result of an earlier run is a closure without a known call
 * (`lostAt` of `subagentClosures`): one written after the hook started (a stale hook) still takes the proof. `file`
 * (key binding in the review) holds every call and result, so a resume does not take a key's call of an earlier run.
 * Both scopes mark each call with its run (`run`, the index of its opening entry) and give the opening entries'
 * times (`runStarts`): a key binds only a call of its own run (rule 6 of `bind.ts`). A pass that has read no
 * opening entry gives `partial`.
 *
 * Dowód „bieg znany do końca” ({@link SubagentTurnPass.settled}): przegląd doszedł do rozmiaru pliku, bez
 * niedokończonej linii i bez pełnej linii, której nie dało się sparsować (w całym pliku, bo taka linia mogła być
 * wpisem otwarcia). Bez niego brak wyniku w faktach znaczy tylko „nie widzieliśmy” (jak `settled`
 * w `background/agent-file.ts`).
 */
import { readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isAgentId, isRunId } from './background/ids.ts';
import { canonicalSha256 } from './dialogs/hook/canon.ts';
import type { TurnToolResult, TurnToolUse } from './dialogs/layer1/bind.ts';
import type { ConsentCheckpoint } from './dialogs/layer1/contract.ts';
import type { ConsentSubagentLaunch } from './dialogs/layer1/proof.ts';
import { createConsentEvidenceScanner, locateConsentCall, locateConsentCheckpoint } from './consent-evidence.ts';
import type { ConsentEvidenceIo } from './consent-evidence.ts';
import { parseJsonlEntry, toolResultDecisions, turnPromptOf, turnToolUses } from './jsonl-pending.ts';
import { TRANSCRIPT_EXT } from './transcript-path.ts';

/** Kawałek jednego odczytu przebiegu. */
const READ_CHUNK = 1024 * 1024;

/** Katalog plików subagentów w katalogu sesji (`<sesja>/subagents/`). */
const SUBAGENTS_DIRNAME = 'subagents';

/**
 * Plik subagenta `agentId` obok pliku wątku głównego `mainFile` (`<projekt>/<sesja>.jsonl` →
 * `<projekt>/<sesja>/subagents/agent-<agentId>.jsonl`); `null` = id spoza gramatyki albo ścieżka bez rozszerzenia.
 */
export function subagentFileOf(mainFile: string, agentId: string): string | null {
  if (!isAgentId(agentId) || !mainFile.endsWith(TRANSCRIPT_EXT)) return null;
  const sessionDir = mainFile.slice(0, -TRANSCRIPT_EXT.length);
  return join(sessionDir, SUBAGENTS_DIRNAME, `agent-${agentId}${TRANSCRIPT_EXT}`);
}

/** Katalog przebiegów workflow w katalogu sesji (`<sesja>/subagents/workflows/`). */
const WORKFLOWS_DIRNAME = 'workflows';

/** Nazwy wpisów katalogu albo `null` (brak katalogu, błąd odczytu). */
async function listDir(dir: string): Promise<readonly string[] | null> {
  try {
    return await readdir(dir);
  } catch {
    return null;
  }
}

/**
 * Plik rozmowy agenta `agentId`: `subagents/agent-<agentId>.jsonl` ({@link subagentFileOf}), a gdy go nie ma, plik
 * agenta workflow `subagents/workflows/wf_<id>/agent-<agentId>.jsonl` z jedynego przebiegu, który go ma (nazwa
 * przebiegu przez `isRunId`). Ten sam plik w dwóch przebiegach = `null` (nie wiadomo, który jest prośby); żaden =
 * ścieżka płaska, której przebieg nie znajdzie.
 */
export async function agentFileOf(mainFile: string, agentId: string, io: ConsentEvidenceIo): Promise<string | null> {
  const plain = subagentFileOf(mainFile, agentId);
  if (plain === null || await io.stat(plain) !== null) return plain;
  const runsDir = join(dirname(plain), WORKFLOWS_DIRNAME);
  const found: string[] = [];
  for (const run of await listDir(runsDir) ?? []) {
    if (!isRunId(run)) continue;
    const file = join(runsDir, run, basename(plain));
    if (await io.stat(file) !== null) found.push(file);
  }
  if (found.length > 1) return null;
  return found[0] ?? plain;
}

/** Suffix of the agent's meta file next to its transcript (`agent-<id>.meta.json`, CLI 2.1.322). */
const META_SUFFIX = '.meta.json';

/** Largest meta file read; the measured ones hold a few short fields (CLI 2.1.322). */
const META_MAX_BYTES = 64 * 1024;

/** Grammar of a call id taken from the meta file (`toolu_…` on CLI 2.1.322); anything else is not looked for. */
const CALL_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * `toolUseId` of the agent's meta file (the main-thread `Agent` call that started the agent, CLI 2.1.322) or `null`:
 * no file, a file too large or not JSON, or no id in the grammar.
 */
async function startCallOf(agentFile: string, io: ConsentEvidenceIo): Promise<string | null> {
  if (!agentFile.endsWith(TRANSCRIPT_EXT)) return null;
  const metaFile = `${agentFile.slice(0, -TRANSCRIPT_EXT.length)}${META_SUFFIX}`;
  const info = await io.stat(metaFile);
  if (info === null || info.size === 0 || info.size > META_MAX_BYTES) return null;
  const buffer = await io.read(metaFile, 0, info.size);
  if (buffer === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(buffer.toString('utf8'));
  } catch {
    return null;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>)['toolUseId'];
  return typeof id === 'string' && CALL_ID.test(id) ? id : null;
}

/** Fakty biegu subagenta z jednego przebiegu. */
export interface SubagentTurnPass {
  /** The pass has read no opening entry (module description). */
  readonly partial: boolean;
  readonly toolUses: readonly TurnToolUse[];
  readonly results: readonly TurnToolResult[];
  /**
   * `timestamp` (ms since epoch, `null` = unreadable) of every opening entry read, in line order; a call's `run` is
   * its index here (module description).
   */
  readonly runStarts: readonly (number | null)[];
  /** Bieg znany do końca (opis modułu). */
  readonly settled: boolean;
  /** Przebieg doczytał plik do końca. */
  readonly caughtUp: boolean;
  /** Bajty przeczytane w tym przebiegu. */
  readonly bytes: number;
}

/**
 * Which calls the facts hold: `run` = the agent's current run, `file` = every run of the file; results always come
 * from the whole file (module description).
 */
export type SubagentScanScope = 'run' | 'file';

export interface SubagentTurnScanner {
  /** Jeden przebieg pliku `file` agenta `agentId`; `null` = pliku nie ma. */
  pass(file: string, agentId: string, maxBytes: number): Promise<SubagentTurnPass | null>;
  /** Zapomina stan przeglądu pliku agenta. */
  forget(file: string, agentId: string): void;
}

interface SubagentScan {
  inode: number;
  /** Bajt, do którego przegląd przeczytał plik; niedokończona linia za ostatnią pełną leży w `carry`. */
  readAt: number;
  carry: Buffer;
  /** An opening entry has been read. */
  opened: boolean;
  /** Times of the opening entries read, in line order ({@link SubagentTurnPass.runStarts}). */
  runStarts: (number | null)[];
  /** Pełna linia, której nie dało się sparsować. */
  broken: boolean;
  line: number;
  /** Calls and results of the scope, in line order, with their ids for the duplicate check. */
  toolUses: TurnToolUse[];
  results: TurnToolResult[];
  useIds: Set<string>;
  resultIds: Set<string>;
}

function freshScan(inode: number): SubagentScan {
  return {
    inode, readAt: 0, carry: Buffer.alloc(0), opened: false, runStarts: [], broken: false, line: 0, toolUses: [],
    results: [],
    useIds: new Set(), resultIds: new Set(),
  };
}

function digestOf(input: unknown): string | null {
  try {
    return canonicalSha256(input);
  } catch {
    return null;
  }
}

/** Wpis agenta `agentId` jako wpis wątku głównego (czytniki `jsonl-pending.ts` pomijają `isSidechain`) albo `null`. */
function ownEntry(value: unknown, agentId: string): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (entry['agentId'] !== agentId) return null;
  return { ...entry, isSidechain: false };
}

/** `origin.kind` of the resume message `SendMessage` writes to the agent file (CLI 2.1.322). */
const RESUME_ORIGIN_KIND = 'coordinator';

/**
 * `promptId` handed to the turn classifier of `jsonl-pending.ts`, which needs one: the run rule does not read the
 * entry's own `promptId` (module description).
 */
const ANY_PROMPT = 'run';

/** The entry opens a run: the agent's task or a `SendMessage` resume (module description). */
function opensRun(entry: Record<string, unknown>): boolean {
  if (entry['isCompactSummary'] === true) return false;
  const turn = turnPromptOf({ ...entry, promptId: ANY_PROMPT });
  if (turn === null || turn.result || turn.interruption) return false;
  if (turn.human) return true;
  const origin = entry['origin'];
  return origin !== null && typeof origin === 'object' && !Array.isArray(origin)
    && (origin as Record<string, unknown>)['kind'] === RESUME_ORIGIN_KIND;
}

/** `timestamp` of an entry as ms since epoch; `null` = missing or unreadable. */
function entryAt(entry: Record<string, unknown>): number | null {
  const raw = entry['timestamp'];
  const at = typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(at) ? at : null;
}

/** Jedna pełna linia w stanie przeglądu pliku agenta (opis modułu). */
function noteLine(scan: SubagentScan, agentId: string, scope: SubagentScanScope, text: string): void {
  if (text.trim() === '') return;
  const parsed = parseJsonlEntry(text);
  if (parsed === null) {
    // The line could hold a call, a result or an opening entry: without it no run is known to its end.
    scan.broken = true;
    return;
  }
  const entry = ownEntry(parsed, agentId);
  if (entry === null) return;
  scan.line += 1;
  if (opensRun(entry)) {
    scan.opened = true;
    scan.runStarts.push(entryAt(entry));
    // Results stay: one of an earlier run is then a closure without a known call (`lostAt` of `subagentClosures`).
    if (scope === 'run') {
      scan.toolUses = [];
      scan.useIds.clear();
    }
    return;
  }
  for (const use of turnToolUses(entry)) {
    if (scan.useIds.has(use.id)) continue;
    scan.useIds.add(use.id);
    scan.toolUses.push({
      id: use.id, name: use.toolName, inputSha256: digestOf(use.input), line: scan.line,
      run: scan.runStarts.length - 1,
    });
  }
  for (const result of toolResultDecisions(entry)) {
    if (scan.resultIds.has(result.toolUseId)) continue;
    scan.resultIds.add(result.toolUseId);
    scan.results.push({
      toolUseId: result.toolUseId, line: scan.line, at: result.at, decision: result.decision, source: result.source,
      interrupted: result.interrupted,
    });
  }
}

export function createSubagentTurnScanner(io: ConsentEvidenceIo, scope: SubagentScanScope): SubagentTurnScanner {
  const scans = new Map<string, SubagentScan>();
  const slot = (file: string, agentId: string): string => `${file}\n${agentId}`;

  async function pass(file: string, agentId: string, maxBytes: number): Promise<SubagentTurnPass | null> {
    const info = await io.stat(file);
    if (info === null) return null;
    const id = slot(file, agentId);
    let scan = scans.get(id);
    if (scan === undefined || scan.inode !== info.ino || scan.readAt > info.size) {
      // Pierwszy przebieg albo plik podmieniony lub skrócony: pozycje sprzed zmiany nic nie znaczą.
      scan = freshScan(info.ino);
    }
    scans.set(id, scan);

    let bytes = 0;
    let carry: Buffer = scan.carry;
    let readAt = scan.readAt;
    const ceiling = Math.max(1, maxBytes);
    // Sufit przebiegu liczy bajty odczytu: linia dłuższa niż sufit dochodzi przez kilka przebiegów, w `carry`.
    while (readAt < info.size && bytes < ceiling) {
      const chunk = await io.read(file, readAt, Math.min(READ_CHUNK, info.size - readAt, ceiling - bytes));
      if (chunk === null || chunk.length === 0) break;
      readAt += chunk.length;
      bytes += chunk.length;
      const buffer = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
      let from = 0;
      for (;;) {
        const cut = buffer.indexOf(0x0a, from);
        if (cut === -1) break;
        noteLine(scan, agentId, scope, buffer.subarray(from, cut).toString('utf8'));
        from = cut + 1;
      }
      carry = buffer.subarray(from);
    }
    // Kopia, żeby niedokończona linia nie trzymała całego bufora odczytu do następnego przebiegu.
    scan.carry = Buffer.from(carry);
    scan.readAt = readAt;

    const atEnd = readAt >= info.size;
    return {
      partial: !scan.opened,
      toolUses: scan.opened ? [...scan.toolUses] : [],
      results: scan.opened ? [...scan.results] : [],
      runStarts: [...scan.runStarts],
      settled: !scan.broken && atEnd && scan.carry.length === 0,
      caughtUp: atEnd,
      bytes,
    };
  }

  return {
    pass,
    forget(file, agentId) {
      scans.delete(slot(file, agentId));
    },
  };
}

/**
 * Prośba subagenta, której fakty pliku czyta obserwacja: agent i `promptId` zrzutu hooka (tylko do zapasowego
 * checkpointu pliku głównego, opis modułu).
 */
export interface SubagentObservationRequest {
  readonly agentId: string;
  readonly promptId: string;
}

export interface SubagentObservationOptions {
  readonly io: ConsentEvidenceIo;
  /** Plik wątku głównego sesji (`consentTranscriptOf` w serwerze) z ostatnią znaną ścieżką albo `null`. */
  readonly locate: (sessionId: string, known: string | null) => Promise<string | null>;
  /** `RAROG_AGENT_FILES`: `false` = pliki subagentów nieczytane, każda prośba bez faktów. */
  readonly agentFiles: boolean;
  /** Sufit bajtów jednego przebiegu. */
  readonly maxBytes: number;
}

/** Fakty biegu prośby z pliku subagenta i fakty pliku głównego o agencie (`null` = nieznane). */
export type SubagentObservationFile = SubagentTurnPass & { readonly agent: ConsentSubagentLaunch | null };

export interface SubagentObservation {
  /**
   * Fakty biegu agenta każdej prośby sesji, w kolejności próśb; `null` = brak pliku (także plik agenta workflow
   * w dwóch przebiegach), pliki wyłączone albo błąd odczytu. Stan przeglądów próśb sesji, których w `requests` już
   * nie ma, idzie do kosza; puste `requests` zapomina sesję.
   */
  read(sessionId: string, requests: readonly SubagentObservationRequest[]): Promise<(SubagentObservationFile | null)[]>;
}

/** Przegląd jednej prośby: plik subagenta, agent i `promptId` hooka. */
interface Slot {
  readonly file: string;
  readonly agentId: string;
  readonly promptId: string;
}

export function createSubagentObservation(options: SubagentObservationOptions): SubagentObservation {
  const scanner = createSubagentTurnScanner(options.io, 'run');
  /** Przegląd pliku głównego o agencie (start w tle, końce biegów) per prośba. */
  const launches = createConsentEvidenceScanner({ io: options.io, maxBytes: options.maxBytes, agentFiles: true });
  /** Checkpoint pliku głównego prośby (`sesja\nagent\npromptId`): the agent's start call, or the hook's main turn. */
  const checkpoints = new Map<string, ConsentCheckpoint>();
  const launchSlot = (sessionId: string, slot: Slot): string => `${sessionId}\n${slot.agentId}\n${slot.promptId}`;
  /** Ostatnia znana ścieżka pliku wątku głównego sesji. */
  const mainFiles = new Map<string, string>();
  /** Przeglądy sesji: plik, agent i `promptId` każdej prośby z ostatniego odczytu. */
  const slots = new Map<string, Slot[]>();
  /** Odczyty jednej sesji po kolei: przebiegi tego samego przeglądu nie mogą się przeplatać. */
  const queues = new Map<string, Promise<unknown>>();

  function forgetUnasked(sessionId: string, kept: readonly Slot[]): void {
    for (const old of slots.get(sessionId) ?? []) {
      const still = kept.some((slot) => slot.file === old.file && slot.agentId === old.agentId
        && slot.promptId === old.promptId);
      if (still) continue;
      // The agent's file scan is shared by its requests: it goes when no kept request reads that file.
      if (!kept.some((slot) => slot.file === old.file && slot.agentId === old.agentId)) {
        scanner.forget(old.file, old.agentId);
      }
      launches.forget(sessionId, old.promptId, old.agentId);
      checkpoints.delete(launchSlot(sessionId, old));
    }
    if (kept.length === 0) {
      slots.delete(sessionId);
      mainFiles.delete(sessionId);
    } else {
      slots.set(sessionId, [...kept]);
    }
  }

  /**
   * Checkpoint of the request in the main file (module description): the line of the agent's start call from its
   * meta file, else the main turn of the hook's `promptId`; `null` = no main file.
   */
  async function checkpointOf(
    mainFile: string, sessionId: string, slot: Slot, size: number,
  ): Promise<ConsentCheckpoint | null> {
    const call = await startCallOf(slot.file, options.io);
    const found = call === null ? null : await locateConsentCall(mainFile, sessionId, call, options.io);
    return found ?? locateConsentCheckpoint(mainFile, sessionId, slot.promptId, size, options.io);
  }

  /** Fakty pliku głównego o agencie prośby od checkpointu prośby (opis modułu); `null` = nieznane. */
  async function launchOf(mainFile: string, sessionId: string, slot: Slot): Promise<ConsentSubagentLaunch | null> {
    const id = launchSlot(sessionId, slot);
    try {
      const before = await options.io.stat(mainFile);
      if (before === null) return null;
      let point = checkpoints.get(id);
      if (point === undefined || point.file !== mainFile || point.inode !== before.ino) {
        // A scan from another file or inode would restart at the top of the file, not at the new checkpoint.
        if (point !== undefined) launches.forget(sessionId, slot.promptId, slot.agentId);
        const found = await checkpointOf(mainFile, sessionId, slot, before.size);
        if (found === null) return null;
        point = found;
        checkpoints.set(id, point);
      }
      const result = await launches.pass({
        sessionId, agentId: slot.agentId, promptId: slot.promptId, file: mainFile, checkpoint: point,
      });
      const agent = result.status === 'ok' ? result.facts.agent : undefined;
      if (result.status !== 'ok' || agent === undefined) return null;
      const after = await options.io.stat(mainFile);
      const tail = after === null || after.size === 0 ? null : await options.io.read(mainFile, after.size - 1, 1);
      // Pole `unparsedLine` nieobecne = nie ustalone, więc tylko jawne `false` przepuszcza.
      const settled = result.caughtUp && result.unparsedLine === false && after !== null
        && after.ino === before.ino && after.size === before.size
        && (after.size === 0 || (tail !== null && tail.length === 1 && tail[0] === 0x0a));
      return { launch: agent.launch, ends: agent.ends, settled };
    } catch {
      // Przegląd mógł zostać w połowie linii: następny zaczyna od nowa.
      launches.forget(sessionId, slot.promptId, slot.agentId);
      checkpoints.delete(id);
      return null;
    }
  }

  async function readNow(
    sessionId: string, requests: readonly SubagentObservationRequest[],
  ): Promise<(SubagentObservationFile | null)[]> {
    if (!options.agentFiles || requests.length === 0) {
      forgetUnasked(sessionId, []);
      return requests.map(() => null);
    }
    const mainFile = await options.locate(sessionId, mainFiles.get(sessionId) ?? null);
    if (mainFile === null) {
      forgetUnasked(sessionId, []);
      return requests.map(() => null);
    }
    mainFiles.set(sessionId, mainFile);
    const kept: Slot[] = [];
    const out: (SubagentObservationFile | null)[] = [];
    /** One pass per agent file in this read: requests of one agent get the same run facts. */
    const runs = new Map<string, SubagentTurnPass | null>();
    for (const request of requests) {
      const file = await agentFileOf(mainFile, request.agentId, options.io);
      if (file === null) {
        out.push(null);
        continue;
      }
      const slot: Slot = { file, agentId: request.agentId, promptId: request.promptId };
      kept.push(slot);
      const runSlot = `${file}\n${request.agentId}`;
      try {
        let run = runs.get(runSlot);
        if (run === undefined) {
          run = await scanner.pass(file, request.agentId, options.maxBytes);
          runs.set(runSlot, run);
        }
        out.push(run === null ? null : { ...run, agent: await launchOf(mainFile, sessionId, slot) });
      } catch {
        // Przegląd mógł zostać w połowie linii: następny zaczyna od nowa.
        scanner.forget(file, request.agentId);
        runs.set(runSlot, null);
        out.push(null);
      }
    }
    forgetUnasked(sessionId, kept);
    return out;
  }

  return {
    read(sessionId, requests) {
      const previous = queues.get(sessionId) ?? Promise.resolve();
      const next = previous.then(() => readNow(sessionId, requests));
      const done = next.then(() => undefined, () => undefined);
      queues.set(sessionId, done);
      void done.then(() => {
        if (queues.get(sessionId) === done) queues.delete(sessionId);
      });
      return next;
    },
  };
}
