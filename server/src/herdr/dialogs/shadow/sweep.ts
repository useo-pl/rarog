/**
 * Sprzątanie plików trybu cienia przy starcie serwera, w obu trybach (`docs/dialogs.md`, „Server in shadow mode”):
 *
 * - rotacja `shadow.jsonl` (hook tylko dopisuje, rotuje serwer — jak `guard.jsonl`) i `alive.jsonl` (dziennik
 *   przejść `alive.json` z `alive-log.ts`; rotacja przed pierwszym zapisem pisarza);
 * - `shadow/<sesja>/`: pliki starsze niż {@link SHADOW_FILE_TTL_MS} (`.claimed`, `.revoked`, nieprzejęty `.json`,
 *   resztki zapisu `.tmp`) — kanał rozlicza plik w ciągu 61 s, więc starszy nikomu już nie służy;
 * - `pending/<sesja>/`: zrzuty per wywołanie po procesie hooka, którego już nie ma (pid i czas startu wobec `ps`),
 *   i każdy plik starszy niż {@link ORPHAN_DUMP_MAX_AGE_MS} (dłużej żaden hook nie czeka). Pliki w samym `pending/`
 *   zamiata `sweepPendingHooks` (`hook/dump.ts`);
 * - `decisions/<sesja>/`: rekordy starsze niż {@link DECISION_RETENTION_MS};
 * - puste katalogi sesji w tych trzech miejscach.
 *
 * Osobno {@link sweepMarkerFiles}: znaczniki prośby `markers/<sesja>/` (kanał zgód) starsze niż
 * {@link MARKER_RETENTION_MS} i puste katalogi sesji; wynik i dziennik sprzątania trybu cienia bez zmian.
 *
 * Opcja `dumpAge` włącza regułę wieku zrzutów kanału zgód: zrzut żywego procesu zostaje bez względu na wiek,
 * a po wieku znika tylko wtedy, gdy `ps` nie odpowiedziało o jego procesie. Bez opcji zostaje reguła trybu cienia.
 * {@link sweepAgedSessionFiles} to sama retencja po wieku dla katalogów sesji, z której biorą sprzątanie katalogi
 * kanału zgód (`layer1/records.ts`); ten moduł ich nie zna.
 *
 * Wiek z `mtime` (`lstat`), jak w pozostałych żniwiarzach; dowiązania symboliczne (także w miejscu samego
 * `shadow/`, `pending/`, `decisions/`) i katalogi wewnątrz katalogu sesji są pomijane. Każdy błąd połknięty per
 * plik: sprzątanie nie ma prawa wywrócić startu.
 */
import { lstatSync, renameSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { HOOK_ANSWER_TIMEOUT_S } from '../../hook-commands.ts';
import {
  HOOK_MARKERS_DIRNAME, HOOK_PENDING_DIRNAME, HOOK_SHADOW_DIRNAME, HOOK_SHADOW_LOG_FILENAME,
} from '../hook/contract.ts';
import { ALIVE_LOG_FILENAME } from './alive-log.ts';
import { SHADOW_DECISIONS_DIRNAME, listDir, readCallDumps } from './files.ts';
import { psLiveness } from './liveness.ts';
import type { ProcessLiveness } from './liveness.ts';

/** Próg rotacji `shadow.jsonl` do `.1` (~1 KB na prośbę o zgodę w każdej sesji pod korzeniami). */
export const SHADOW_LOG_MAX_BYTES = 8 * 1024 * 1024;

/** Wiek, po którym plik w `shadow/<sesja>/` jest resztką. */
export const SHADOW_FILE_TTL_MS = 10 * 60_000;

/**
 * Wiek, po którym zrzut per wywołanie jest sierotą bez pytania `ps`: hook czeka najwyżej `timeout` rejestracji
 * (`HOOK_ANSWER_TIMEOUT_S`, doba), plus godzina zapasu. Zrzut żywego hooka z trybu cienia przeżywa więc restart
 * serwera przez cały czas czekania; zrzut martwego procesu znika od razu, bez względu na wiek.
 */
export const ORPHAN_DUMP_MAX_AGE_MS = HOOK_ANSWER_TIMEOUT_S * 1000 + 60 * 60_000;

/** Retencja rekordów cyklu `decisions/`. */
export const DECISION_RETENTION_MS = 30 * 24 * 60 * 60_000;

/**
 * Wiek, po którym znacznik prośby `markers/<sesja>/` znika przy starcie. Znaczniki kasuje kanał zgód (wyjście kandydata
 * z puli, koniec sesji); ten próg zbiera resztę (nieudane usunięcie, sesja zamknięta z telefonu, serwer bez kanału).
 */
export const MARKER_RETENTION_MS = 7 * 24 * 60 * 60_000;

/** Sufit czasu `ps` przy starcie — tu nic nie czeka na wynik, więc luźniej niż przed klawiszem. */
const SWEEP_PS_TIMEOUT_MS = 2_000;

/**
 * Próg rotacji `alive.jsonl` do `.1`. Linia (~100 B plus ~40 B na sesję) idzie tylko przy przejściu, więc przy
 * kilkudziesięciu przejściach dziennie próg starcza na miesiące.
 */
export const ALIVE_LOG_MAX_BYTES = 8 * 1024 * 1024;

/** Plik większy niż próg przechodzi do `<plik>.1` (poprzednie `.1` znika). Każdy błąd = `false`. */
function rotateLog(file: string, maxBytes: number): boolean {
  try {
    if (statSync(file).size <= maxBytes) return false;
    renameSync(file, `${file}.1`);
    return true;
  } catch {
    return false;
  }
}

/** Rotacja `shadow.jsonl`: plik większy niż próg przechodzi do `shadow.jsonl.1`. Każdy błąd = `false`. */
export function rotateShadowLog(dataDir: string, maxBytes: number = SHADOW_LOG_MAX_BYTES): boolean {
  return rotateLog(join(dataDir, HOOK_SHADOW_LOG_FILENAME), maxBytes);
}

/** Rotacja `alive.jsonl`: plik większy niż próg przechodzi do `alive.jsonl.1`. Każdy błąd = `false`. */
export function rotateAliveLog(dataDir: string, maxBytes: number = ALIVE_LOG_MAX_BYTES): boolean {
  return rotateLog(join(dataDir, ALIVE_LOG_FILENAME), maxBytes);
}

export interface ShadowSweepResult {
  readonly shadowFiles: number;
  readonly callDumps: number;
  readonly decisions: number;
}

/** Reguła wieku zrzutów per wywołanie kanału zgód. */
export interface DumpAgeRule {
  /** Wiek, po którym zrzut bez odpowiedzi `ps` o procesie znika (kanał zgód: `timeout` hooka plus zapas). */
  readonly maxAgeMs: number;
}

export interface ShadowSweepOptions {
  readonly now?: () => number;
  readonly liveness?: ProcessLiveness;
  /**
   * Reguła kanału zgód: żywy proces trzyma zrzut bez względu na wiek, martwy zabiera go od razu, po `maxAgeMs`
   * znika tylko zrzut bez odpowiedzi `ps` (także nieczytelny). Bez opcji: każdy plik starszy niż
   * {@link ORPHAN_DUMP_MAX_AGE_MS}.
   */
  readonly dumpAge?: DumpAgeRule;
}

/** Wiek zwykłego pliku (ms) albo `null`: brak, dowiązanie, katalog, błąd. */
function fileAge(path: string, at: number): number | null {
  try {
    const stat = lstatSync(path);
    return stat.isFile() ? at - stat.mtimeMs : null;
  } catch {
    return null;
  }
}

function isPlainDir(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function unlinkQuietly(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

function rmdirQuietly(path: string): void {
  try {
    rmdirSync(path);
  } catch {
    // Katalog niepusty (żywa sesja) albo brak praw — zostaje do następnego startu.
  }
}

/**
 * Katalogi sesji pod `root` (bez dowiązań). Sam `root` też musi być zwykłym katalogiem: dowiązane `shadow/`,
 * `pending/` albo `decisions/` prowadzi poza katalog danych, a sprzątanie kasowałoby pliki w jego celu.
 */
function sessionDirs(root: string): string[] {
  if (!isPlainDir(root)) return [];
  let names: string[];
  try {
    names = listDir(root);
  } catch {
    return [];
  }
  return names.filter((name) => isPlainDir(join(root, name)));
}

/**
 * Pliki starsze niż `maxAge` w katalogach sesji pod `root`, potem puste katalogi. Zwraca liczbę plików. Te same
 * zasady co całe sprzątanie: dowiązania (także w miejscu `root`) i podkatalogi pomijane, błędy połknięte per plik.
 */
export function sweepAgedSessionFiles(root: string, at: number, maxAge: number): number {
  let removed = 0;
  for (const session of sessionDirs(root)) {
    const dir = join(root, session);
    let names: string[];
    try {
      names = listDir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(dir, name);
      const age = fileAge(path, at);
      if (age !== null && age > maxAge && unlinkQuietly(path)) removed += 1;
    }
    rmdirQuietly(dir);
  }
  return removed;
}

/**
 * Zrzuty per wywołanie po martwych procesach hooka i pliki ponad sufit wieku: bez reguły kanału każdy starszy niż
 * {@link ORPHAN_DUMP_MAX_AGE_MS}, z regułą ({@link DumpAgeRule}) tylko te bez żywego procesu.
 */
async function sweepCallDumps(
  dataDir: string, at: number, liveness: ProcessLiveness, rule: DumpAgeRule | undefined,
): Promise<number> {
  const root = join(dataDir, HOOK_PENDING_DIRNAME);
  const maxAge = rule?.maxAgeMs ?? ORPHAN_DUMP_MAX_AGE_MS;
  let removed = 0;
  for (const session of sessionDirs(root)) {
    const dir = join(root, session);
    const dead = new Set<string>();
    const live = new Set<string>();
    try {
      const dumps = readCallDumps(dataDir, session);
      const alive = dumps.length === 0 ? new Map<number, boolean | null>() : await liveness(dumps, at);
      for (const dump of dumps) {
        const answer = alive.get(dump.pid);
        if (answer === false) dead.add(`${dump.key}.json`);
        else if (answer === true) live.add(`${dump.key}.json`);
      }
    } catch {
      // Bez odpowiedzi `ps` albo odczytu zostaje sam sufit wieku.
    }
    let names: string[];
    try {
      names = listDir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(dir, name);
      const age = fileAge(path, at);
      if (age === null) continue;
      const aged = age > maxAge && (rule === undefined || !live.has(name));
      if ((dead.has(name) || aged) && unlinkQuietly(path)) removed += 1;
    }
    rmdirQuietly(dir);
  }
  return removed;
}

/**
 * Sprzątanie startu znaczników prośby: pliki `markers/<sesja>/` starsze niż {@link MARKER_RETENTION_MS} (także resztki
 * zapisu `.tmp`), potem puste katalogi sesji. Wynik = liczba usuniętych plików. Nie rzuca.
 */
export function sweepMarkerFiles(dataDir: string, at: number = Date.now()): number {
  return sweepAgedSessionFiles(join(dataDir, HOOK_MARKERS_DIRNAME), at, MARKER_RETENTION_MS);
}

/** Sprzątanie startu: `shadow/`, sieroty `pending/<sesja>/`, retencja `decisions/`. Nie rzuca. */
export async function sweepShadowFiles(dataDir: string, options: ShadowSweepOptions = {}): Promise<ShadowSweepResult> {
  const at = (options.now ?? Date.now)();
  const liveness = options.liveness ?? psLiveness(SWEEP_PS_TIMEOUT_MS);
  const shadowFiles = sweepAgedSessionFiles(join(dataDir, HOOK_SHADOW_DIRNAME), at, SHADOW_FILE_TTL_MS);
  let callDumps = 0;
  try {
    callDumps = await sweepCallDumps(dataDir, at, liveness, options.dumpAge);
  } catch {
    // Jak wyżej: następny start spróbuje jeszcze raz.
  }
  const decisions = sweepAgedSessionFiles(join(dataDir, SHADOW_DECISIONS_DIRNAME), at, DECISION_RETENTION_MS);
  return { shadowFiles, callDumps, decisions };
}
