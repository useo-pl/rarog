/**
 * Diff sesji per plik: lista zmienionych plików i patch JEDNEGO pliku — kolektory tras
 * `GET /api/sessions/:id/diff/files` i `GET /api/sessions/:id/diff/file?path=…`.
 *
 * Granica (`docs/security-model.md`, „Git reads"): katalog wybiera serwer, a ścieżka z żądania
 * jest używana wyłącznie wtedy, gdy co do znaku stoi na liście, którą git wypisał dla tego katalogu
 * W TYM SAMYM żądaniu. Stanu między żądaniami nie ma: lista dozwolona powstaje od nowa przy każdym
 * pliku (dwa procesy gita są tańsze niż pamięć podręczna z wygasaniem).
 *
 * Wynik procesu gita ma tu trzy znaczenia i żadne nie udaje innego:
 * - git odpowiedział (kod 0) — są dane;
 * - git ODMÓWIŁ (kod ≠ 0) i sonda `HEAD` potwierdza, że nie ma do czego się odnieść (katalog spoza
 *   repo, repo bez commita) — z tego źródła nie ma listy, bo sesja może żyć w katalogu, który nie
 *   jest repozytorium. Odmowa przy istniejącym `HEAD` to awaria;
 * - git NIE ODPOWIEDZIAŁ (limit czasu, nieudany start, sygnał) — `DiffError` z kodem `git-failed`.
 *   Awaria nigdy nie wygląda jak pusta lista ani jak „nie ma takiego pliku".
 */
import {
  DIFF_BAD_PATH_ERROR, DIFF_FILE_NOT_FOUND_ERROR, DIFF_GIT_FAILED_ERROR,
} from '@rarog/shared';
import type { DiffFileList, DiffFilePatch, DiffFileStatus, DiffListEntry } from '@rarog/shared';
import {
  NO_EXT_DIFF, RELATIVE, clampPatch, numstatArgs, parseNumstatZ, probeUntracked, symlinkPatch,
} from './git-status.ts';
import type {
  GitArgsResult, GitArgsRunner, GitCommand, NumstatCounts, UntrackedEntry,
} from './git-status.ts';

/**
 * Sufit listy zmian. Powyżej lista wraca ucięta z `truncated: true`, ale plik spoza niej dalej da
 * się pobrać: walidacja ścieżki idzie po PEŁNYCH listach gita, nie po uciętej.
 */
export const MAX_DIFF_LIST_FILES = 500;

/**
 * Sufit patcha JEDNEGO pliku. Ta sama liczba co `MAX_DIFF_PATCH_BYTES` starej trasy, ale osobna
 * stała: tamta dzieli 512 kB na wszystkie pliki naraz, ta daje je każdemu z osobna.
 */
export const MAX_DIFF_FILE_PATCH_BYTES = 512 * 1024;

/** Najdłuższa ścieżka z żądania w bajtach UTF-8 (`PATH_MAX` na macOS to 1024). */
export const MAX_DIFF_PATH_BYTES = 4096;

/** Kody odmów kolektorów — te same łańcuchy, które router oddaje w polu `error`. */
export type DiffFailure =
  | typeof DIFF_BAD_PATH_ERROR | typeof DIFF_FILE_NOT_FOUND_ERROR | typeof DIFF_GIT_FAILED_ERROR;

/**
 * Odmowa trasy diffa per plik. Niesie sam KOD z kontraktu: status HTTP i zdanie dla człowieka
 * dobiera router (`diffErrorStatus`, `errorBodyOf`), a ścieżka z żądania nie wchodzi do komunikatu,
 * więc nie trafi do logu razem z wyjątkiem.
 */
export class DiffError extends Error {
  override readonly name = 'DiffError';
  readonly code: DiffFailure;

  constructor(code: DiffFailure) {
    super(code);
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Walidacja wstępna ścieżki
// ---------------------------------------------------------------------------

/**
 * Walidacja wstępna ścieżki z żądania — zanim ruszy jakikolwiek git.
 *
 * To NIE jest granica bezpieczeństwa (tą jest lista gita z tego samego żądania), tylko tanie
 * odcięcie kształtów, które na liście stać nie mogą: git wypisuje ścieżki względem katalogu sesji,
 * bez `..`, bez wiodącego `/`, a katalog nieśledzony jako pliki w środku, nigdy `docs/`.
 *
 * @returns tę samą ścieżkę albo `null`, gdy żądanie ma dostać 400 `bad-path`.
 */
export function validateDiffPath(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw === '' || raw.includes('\0')) return null;
  if (Buffer.byteLength(raw, 'utf8') > MAX_DIFF_PATH_BYTES) return null;
  if (raw.startsWith('/') || raw.endsWith('/')) return null;
  for (const segment of raw.split('/')) {
    if (segment === '..' || segment === '.') return null;
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Listy gita: śledzone (`diff --name-status -z`) i nieśledzone (`ls-files --others -z`)
// ---------------------------------------------------------------------------

/** Pozycja `--name-status`: litera z kontraktu i źródło rename'u albo kopii, gdy git je podał. */
export interface NameStatusEntry {
  status: DiffFileStatus;
  origin?: string;
}

/**
 * Polecenie listy plików śledzonych. `-z` daje ścieżki dosłownie (bez cytowania `core.quotePath`,
 * z tabulatorem i znakami spoza ASCII), więc ścieżka z apki pasuje do listy co do znaku;
 * `--relative` ucina wpisy spoza katalogu sesji i podaje ścieżki względem niego. Osłony konfiguracji
 * (`core.fsmonitor`, `--no-textconv`) dokłada runner (`gitArgv`).
 */
export function nameStatusArgs(): GitCommand {
  return { global: ['--literal-pathspecs'], sub: 'diff', rest: [NO_EXT_DIFF, RELATIVE, '--name-status', '-z', 'HEAD'] };
}

/** Polecenie listy plików nieśledzonych (bez ignorowanych), też z `-z`. */
export function untrackedArgs(): GitCommand {
  return { sub: 'ls-files', rest: ['--others', '--exclude-standard', '-z'] };
}

/**
 * Sonda `HEAD`: kod 0 = repozytorium ma commit, do którego `diff HEAD` się odnosi. Kod ≠ 0 daje
 * katalog spoza repo (128) i repo bez commita (1) — jedyne dwa układy, w których odmowa
 * `diff HEAD` jest niewinna.
 */
export function headProbeArgs(): GitCommand {
  return { sub: 'rev-parse', rest: ['--verify', '--quiet', 'HEAD^{commit}'] };
}

/**
 * Polecenie patcha pliku śledzonego. `--literal-pathspecs` jest opcją GLOBALNĄ (przed `diff`):
 * bez niej `docs/*.md` w pathspecu działa jak wzorzec. `origin` to źródło rename'u — z nim git
 * oddaje `rename from/to` i realną różnicę, bez niego „nowy plik w całości".
 */
export function trackedPatchArgs(path: string, origin?: string): GitCommand {
  return {
    global: ['--literal-pathspecs'], sub: 'diff',
    rest: [NO_EXT_DIFF, RELATIVE, 'HEAD', '--', path, ...(origin === undefined ? [] : [origin])],
  };
}

/** Polecenie patcha pliku nieśledzonego: „nowy plik w całości" względem `/dev/null`. */
export function untrackedPatchArgs(path: string): GitCommand {
  return { global: ['--literal-pathspecs'], sub: 'diff', rest: [NO_EXT_DIFF, '--no-index', '--', '/dev/null', path] };
}

/** Litery `--name-status`: po `R` i `C` stoi wynik podobieństwa (`R096`). */
const NAME_STATUS_CODE = /^[ACDMRTUXB]\d*$/;

/**
 * `git diff --name-status -z` → mapa ścieżka PO zmianie → status i źródło, w kolejności gita.
 *
 * Rekord to `<litera>\0<ścieżka>\0`, a dla rename'u i kopii `<litera><wynik>\0<stara>\0<nowa>\0`.
 * Bierzemy WYŁĄCZNIE rekordy domknięte bajtem NUL: kawałek po ostatnim NUL to rekord ucięty
 * (sufit odczytu), a jego ścieżka byłaby połówką nazwy. Litery mapujemy jak `parseNameStatus`
 * starej trasy: `A` i `C` to nowy plik, `D` — usunięty, reszta (`M`, `R`, `T`, `U`) — zmieniony.
 */
export function parseNameStatusZ(stdout: string): Map<string, NameStatusEntry> {
  const out = new Map<string, NameStatusEntry>();
  const fields = stdout.split('\0');
  fields.pop();
  let index = 0;
  while (index < fields.length) {
    const code = fields[index] ?? '';
    // Pole, które nie jest literą statusu, znaczy rozjechane rekordy — dalej nie ma czego zgadywać.
    if (!NAME_STATUS_CODE.test(code)) break;
    const letter = code[0];
    const paired = letter === 'R' || letter === 'C';
    const origin = paired ? fields[index + 1] : undefined;
    const path = fields[index + (paired ? 2 : 1)];
    if (path === undefined) break;
    index += paired ? 3 : 2;
    if (path === '') continue;
    const status: DiffFileStatus = letter === 'A' || letter === 'C' ? 'A' : (letter === 'D' ? 'D' : 'M');
    out.set(path, origin === undefined || origin === '' ? { status } : { status, origin });
  }
  return out;
}

/**
 * `git ls-files --others -z` → ścieżki w kolejności gita; ucięty ogon odpada jak wyżej.
 *
 * Wpis zakończony `/` to nieśledzone ZAGNIEŻDŻONE repozytorium (albo worktree): git nie schodzi
 * w cudze repo i wypisuje sam katalog. Patcha taki wpis mieć nie może (`bad-path`), więc nie
 * wchodzi na listę — pozycja, której nie da się rozwinąć, byłaby martwym nagłówkiem w oknie.
 */
function parseUntrackedZ(stdout: string): Set<string> {
  const fields = stdout.split('\0');
  fields.pop();
  return new Set(fields.filter((path) => path !== '' && !path.endsWith('/')));
}

/** Co proces gita powiedział: dane, odmowa (kod ≠ 0) albo brak odpowiedzi. */
type GitAnswer = 'ok' | 'refused' | 'failed';

function answerOf(result: GitArgsResult): GitAnswer {
  if (result.ok) return 'ok';
  if (result.timedOut === true || result.spawnFailed !== undefined) return 'failed';
  // Odmowa to kod wyjścia, który git SAM oddał. Bez kodu proces nie skończył się sam (sygnał).
  return typeof result.exitCode === 'number' ? 'refused' : 'failed';
}

/** Runner, który nie rzuca: wyjątek (także synchroniczny) to „procesu nie udało się uruchomić". */
async function runGit(run: GitArgsRunner, command: GitCommand, cwd: string): Promise<GitArgsResult> {
  try {
    return await run(command, cwd);
  } catch {
    return { ok: false, stdout: '', spawnFailed: 'UNKNOWN' };
  }
}

/** Obie listy gita z JEDNEGO żądania — lista okna i lista dozwolonych ścieżek to ten sam odczyt. */
interface ChangeLists {
  tracked: Map<string, NameStatusEntry>;
  untracked: Set<string>;
  /** Któraś lista to prefiks wyjścia (sufit odczytu): brak ścieżki nie dowodzi, że jej nie ma. */
  partial: boolean;
}

async function readChangeLists(cwd: string, run: GitArgsRunner): Promise<ChangeLists> {
  const [trackedResult, untrackedResult] = await Promise.all([
    runGit(run, nameStatusArgs(), cwd), runGit(run, untrackedArgs(), cwd),
  ]);
  const tracked = answerOf(trackedResult);
  const untracked = answerOf(untrackedResult);
  if (tracked === 'failed' || untracked === 'failed') throw new DiffError(DIFF_GIT_FAILED_ERROR);
  /*
   * Odmowy mają dwa znane układy: katalog spoza repo (odmawiają OBA procesy) i repo bez `HEAD`
   * (odmawia `diff HEAD`, `ls-files` odpowiada). `diff HEAD` z odpowiedzią i `ls-files` z odmową
   * nie jest żadnym z nich — to awaria, a nie „brak plików nieśledzonych".
   */
  if (tracked === 'ok' && untracked === 'refused') throw new DiffError(DIFF_GIT_FAILED_ERROR);
  if (tracked === 'refused') {
    /*
     * Sam kod ≠ 0 nie dowodzi, że nie ma repo albo `HEAD`: zła konfiguracja gita (np.
     * `diff.orderFile` na nieistniejący plik) też kończy `diff HEAD` kodem 128, przy poprawnym
     * repo i odpowiadającym `ls-files`. Pusta lista śledzonych udawałaby wtedy „brak zmian",
     * a plik dostawał fałszywe 404. Odmowa jest niewinna tylko wtedy,
     * gdy sonda potwierdzi, że `HEAD` nie ma.
     */
    if (answerOf(await runGit(run, headProbeArgs(), cwd)) !== 'refused') {
      throw new DiffError(DIFF_GIT_FAILED_ERROR);
    }
  }
  return {
    tracked: tracked === 'ok' ? parseNameStatusZ(trackedResult.stdout) : new Map(),
    untracked: untracked === 'ok' ? parseUntrackedZ(untrackedResult.stdout) : new Set(),
    partial: trackedResult.capped === true || untrackedResult.capped === true,
  };
}

// ---------------------------------------------------------------------------
// Lista zmian (`GET …/diff/files`)
// ---------------------------------------------------------------------------

export interface CollectDiffListOptions {
  /** Runner gita — WYMAGANY, bo niesie środowisko procesu (jak w `CollectDiffOptions`). */
  run: GitArgsRunner;
  /**
   * Runner liczników linii (`git diff --numstat -z`) z WŁASNYM budżetem czasu
   * (`GIT_NUMSTAT_BUDGET_MS`): lista czeka na niego najwyżej tyle, ile trwa ten budżet. Brak albo
   * `null` = lista bez liczników.
   */
  runNumstat?: GitArgsRunner | null;
  /** Sufit listy (domyślnie {@link MAX_DIFF_LIST_FILES}) — podmieniany w testach. */
  maxFiles?: number;
}

/**
 * Liczniki linii plików śledzonych albo pusta mapa. Dodatek, nie warunek listy: po budżecie,
 * po odmowie (repo bez `HEAD`) i po awarii liczników nie ma, a lista jedzie bez nich. Globalny
 * `numstat` liczy różnice także w ogromnych plikach, których nikt nie rozwinie — stąd budżet.
 */
async function readCounts(
  cwd: string, run: GitArgsRunner | null,
): Promise<Map<string, NumstatCounts>> {
  if (run === null) return new Map();
  const result = await runGit(run, numstatArgs([]), cwd);
  // Sufit odczytu zostawia rekordy domknięte NUL-em, a te liczby są pełne (`parseNumstatZ`).
  return result.ok ? parseNumstatZ(result.stdout) : new Map();
}

/**
 * Lista zmienionych plików katalogu sesji: śledzone w kolejności gita, potem nieśledzone.
 *
 * Bez patcha — `git diff HEAD` z treścią, najcięższy proces starej trasy, tu nie startuje wcale,
 * a plik nieśledzony nic nie kosztuje (spawn jest dopiero przy rozwinięciu). Ścieżka, która stoi
 * na obu listach (`git rm --cached`: usunięta z indeksu, obecna na dysku), ma JEDEN wpis ze
 * statusem gita: tożsamością sekcji w oknie jest ścieżka.
 *
 * @throws DiffError `git-failed`, gdy git nie odpowiedział. Katalog spoza repo to pusta lista.
 */
export async function collectDiffList(
  cwd: string, opts: CollectDiffListOptions,
): Promise<DiffFileList> {
  // Liczniki startują RAZEM z listami: ich budżet biegnie równolegle, a nie po odczycie list.
  const [lists, counts] = await Promise.all([
    readChangeLists(cwd, opts.run), readCounts(cwd, opts.runNumstat ?? null),
  ]);
  const max = opts.maxFiles ?? MAX_DIFF_LIST_FILES;
  const files: DiffListEntry[] = [];
  let truncated = lists.partial;
  for (const [path, entry] of lists.tracked) {
    if (files.length >= max) { truncated = true; break; }
    files.push({ path, status: entry.status, ...counts.get(path) });
  }
  for (const path of lists.untracked) {
    if (lists.tracked.has(path)) continue;
    if (files.length >= max) { truncated = true; break; }
    files.push({ path, status: 'A' });
  }
  return { files, truncated };
}

// ---------------------------------------------------------------------------
// Patch jednego pliku (`GET …/diff/file?path=…`)
// ---------------------------------------------------------------------------

export interface CollectDiffFileOptions {
  /** Runner gita — WYMAGANY, bo niesie środowisko procesu. */
  run: GitArgsRunner;
  /** Sufit patcha pliku (domyślnie {@link MAX_DIFF_FILE_PATCH_BYTES}) — podmieniany w testach. */
  maxPatchBytes?: number;
  /**
   * Czym na dysku jest wpis nieśledzony (domyślnie `probeUntracked`). Wstrzykiwalne, bo testy
   * z atrapą runnera nie mają plików na dysku.
   */
  probe?: (cwd: string, path: string) => Promise<UntrackedEntry>;
}

/** Kawałek odpowiedzi: patch i znak, że git doszedł do sufitu odczytu. */
interface PatchPart {
  patch: string;
  capped: boolean;
}

function patchPart(result: GitArgsResult): PatchPart {
  if (result.capped !== true) return { patch: result.stdout, capped: false };
  // Prefiks urwany sufitem odczytu kończy się połówką linii — odpada, jak przy `clampPatch`.
  const cut = result.stdout.lastIndexOf('\n');
  return { patch: cut === -1 ? result.stdout : result.stdout.slice(0, cut + 1), capped: true };
}

/**
 * Źródło rename'u do pathspecu albo `undefined`.
 *
 * Źródło dokłada SERWER z `--name-status` (klient go nie wysyła), ale tylko wtedy, gdy żadna inna
 * pozycja list nie jest tą ścieżką ani nie leży pod nią. Pathspec dopasowuje też potomków
 * katalogu: po `git mv old new` i dodaniu `old/extra` zapytanie o `new old` oddaje DWA bloki
 * (`old → new` i `old/extra`), a przy `diff.renames=copies` źródło kopii jest osobną pozycją `M`.
 * Bez źródła plik pokazuje się jako nowy w całości — mniej dokładnie, ale bez cudzych bloków.
 */
function originToInclude(path: string, entry: NameStatusEntry, lists: ChangeLists): string | undefined {
  const origin = entry.origin;
  // Przy liście uciętej sufitem odczytu nie da się wykluczyć pozycji pod źródłem.
  if (origin === undefined || lists.partial) return undefined;
  const under = `${origin}/`;
  const clashes = (other: string): boolean =>
    other !== path && (other === origin || other.startsWith(under));
  for (const other of lists.tracked.keys()) if (clashes(other)) return undefined;
  for (const other of lists.untracked) if (clashes(other)) return undefined;
  return origin;
}

async function trackedPatch(
  cwd: string, path: string, origin: string | undefined, run: GitArgsRunner,
): Promise<PatchPart> {
  const result = await runGit(run, trackedPatchArgs(path, origin), cwd);
  // Lista z tego samego żądania mówiła „zmieniony względem HEAD": odmowa TERAZ to błąd gita.
  if (!result.ok) throw new DiffError(DIFF_GIT_FAILED_ERROR);
  return patchPart(result);
}

/**
 * Patch pliku nieśledzonego albo `null`, gdy wpisu nie ma czym pokazać (katalog, gniazdo, kolejka,
 * plik, który zdążył zniknąć). Do `--no-index` idzie wyłącznie ZWYKŁY plik: dla dowiązania do
 * katalogu git czyta `<dowiązanie>/null`, czyli plik spoza repo (`probeUntracked`). Dowiązanie
 * dostaje blok złożony przez serwer z celu `readlink`; celu nikt nie otwiera.
 */
async function untrackedPatch(
  cwd: string, path: string, opts: CollectDiffFileOptions,
): Promise<PatchPart | null> {
  const probe = opts.probe ?? probeUntracked;
  const entry = await probe(cwd, path).catch((): UntrackedEntry => ({ kind: 'other' }));
  if (entry.kind === 'other') return null;
  if (entry.kind === 'symlink') return { patch: symlinkPatch(path, entry.target).patch, capped: false };
  const result = await runGit(opts.run, untrackedPatchArgs(path), cwd);
  if (result.capped === true) return patchPart(result);
  /*
   * `--no-index` kończy się kodem 1, gdy pliki się różnią — czyli tutaj zawsze — więc `ok: false`
   * nie znaczy błędu. Błędem jest brak kodu (limit czasu, sygnał, nieudany start) i kod inny niż
   * 0/1. Kod 1 z PUSTYM wyjściem to plik, który zniknął między listą a odczytem („Could not access").
   */
  const code = result.ok ? 0 : result.exitCode;
  if (code !== 0 && code !== 1) throw new DiffError(DIFF_GIT_FAILED_ERROR);
  return result.stdout === '' ? null : patchPart(result);
}

/**
 * Patch jednego pliku katalogu sesji.
 *
 * Kolejność jest wiążąca: walidacja wstępna (`bad-path`), potem lista dozwolona z TEGO żądania
 * (równość napisów z wyjściem gita), dopiero potem patch. Odpowiedź bywa dłuższa niż jeden blok
 * `diff --git`: zmiana typu pliku to dwa bloki, a ścieżka z obu list (`git rm --cached`) dostaje
 * blok usunięcia i blok nowego pliku.
 *
 * @throws DiffError `bad-path` — ścieżka nie przeszła walidacji wstępnej;
 *         `diff-file-not-found` — nie ma jej na liście zmian (plik ignorowany, bez zmian, spoza
 *         katalogu sesji) albo zmiana zniknęła między listą a patchem;
 *         `git-failed` — git nie odpowiedział albo lista urwana sufitem odczytu nie pozwala
 *         stwierdzić, że pliku na niej nie ma.
 */
export async function collectDiffFile(
  cwd: string, rawPath: string, opts: CollectDiffFileOptions,
): Promise<DiffFilePatch> {
  const path = validateDiffPath(rawPath);
  if (path === null) throw new DiffError(DIFF_BAD_PATH_ERROR);
  const lists = await readChangeLists(cwd, opts.run);
  const tracked = lists.tracked.get(path);
  const untracked = lists.untracked.has(path);
  if (tracked === undefined && !untracked) {
    throw new DiffError(lists.partial ? DIFF_GIT_FAILED_ERROR : DIFF_FILE_NOT_FOUND_ERROR);
  }

  const parts: PatchPart[] = [];
  if (tracked !== undefined) {
    parts.push(await trackedPatch(cwd, path, originToInclude(path, tracked, lists), opts.run));
  }
  if (untracked) {
    const part = await untrackedPatch(cwd, path, opts);
    if (part !== null) parts.push(part);
  }
  const capped = parts.some((part) => part.capped);
  const patch = parts
    .map((part) => (part.patch === '' || part.patch.endsWith('\n') ? part.patch : `${part.patch}\n`))
    .join('');
  // Pusty patch przy pozycji z listy: `HEAD` się przesunął albo plik zniknął po wypisaniu listy.
  if (patch === '' && !capped) throw new DiffError(DIFF_FILE_NOT_FOUND_ERROR);
  const clamped = clampPatch(patch, opts.maxPatchBytes ?? MAX_DIFF_FILE_PATCH_BYTES);
  return { path, patch: clamped.patch, truncated: clamped.truncated || capped };
}
