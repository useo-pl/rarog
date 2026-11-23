/**
 * Blokada komend CLI, które zmieniają stan serwera (`rarog restart`, `rarog service`): plik
 * `<katalog konfiguracji>/lock` zakładany z `wx` (O_CREAT|O_EXCL) z PID-em właściciela. Drugi `rarog restart`
 * w tym czasie dostaje odmowę z PID-em pierwszego, zamiast zatrzymywać serwer, który pierwszy właśnie startuje.
 *
 * Blokada martwego procesu (PID nie żyje albo plik bez PID-u starszy niż {@link EMPTY_LOCK_GRACE_MS}) jest
 * przeterminowana i przejmuje ją jeden proces naraz: pod plikiem przejęcia (`wx`) czyta blokadę OD NOWA, dopiero
 * wtedy ją kasuje i zakłada swoją. Dwa procesy, które w tej samej chwili uznały blokadę za martwą, nie skasują więc
 * sobie nawzajem żywej blokady. Zostaje okno wymagające DWÓCH awarii: proces padnięty w środku
 * przejęcia zostawia plik przejęcia, który po {@link TAKEOVER_STALE_MS} uznajemy za martwy tą samą drogą.
 *
 * The update lock (`update-lock.ts`) has the same shape under another file name ({@link LockOptions}): the PID on the
 * first line decides who holds it, the lines after it are its body.
 */
import { closeSync, mkdirSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { readRegularFileSync } from '../safe-read.ts';
import { Refusal } from './io.ts';

export const LOCK_FILENAME = 'lock';
/** Ceiling of a lock file read: the PID line and the body of {@link LockOptions} (the update lock carries a path). */
const LOCK_MAX_BYTES = 8192;
/** Plik bez PID-u młodszy niż to okno należy do procesu, który właśnie go założył i jeszcze nie zapisał PID-u. */
export const EMPTY_LOCK_GRACE_MS = 10_000;
/** Plik przejęcia martwej blokady: `<blokada>.przejecie`, zakładany z `wx` na czas przejęcia. */
export const TAKEOVER_SUFFIX = '.przejecie';
/** Przejęcie trwa milisekundy; starszy plik przejęcia zostawił proces, który padł w jego środku. */
export const TAKEOVER_STALE_MS = 10_000;

export interface Lock {
  readonly file: string;
  /** Zdejmuje blokadę, o ile nadal jest nasza (PID w pliku = nasz). */
  release(): void;
}

const errnoCode = (failure: unknown): string | undefined =>
  (failure !== null && typeof failure === 'object' && 'code' in failure && typeof failure.code === 'string'
    ? failure.code : undefined);

/** Czy proces żyje: sygnał 0 sprawdza istnienie; EPERM = żyje, tylko cudzy. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (failure) {
    return errnoCode(failure) === 'EPERM';
  }
}

function tryCreate(file: string, body = ''): boolean {
  let fd: number;
  try {
    fd = openSync(file, 'wx', 0o600);
  } catch (failure) {
    if (errnoCode(failure) === 'EEXIST') return false;
    throw new Refusal(`Cannot create lock ${file} (${errnoCode(failure) ?? 'error'}).`);
  }
  try {
    writeSync(fd, `${String(process.pid)}\n${body}`);
  } finally {
    closeSync(fd);
  }
  return true;
}

/** Treść blokady (PID i krótkie ciało; inny typ pliku niż zwykły = śmieć, czyli przeterminowana). */
function lockText(file: string): string {
  const read = readRegularFileSync(file, { maxBytes: LOCK_MAX_BYTES, followSymlink: false });
  return read === null || read.truncated ? 'x' : read.bytes.toString('utf8');
}

/** The owner's PID line of a lock text: its first line (the lines after it are the body of {@link LockOptions}). */
const pidLine = (text: string): string => (text.split('\n', 1)[0] ?? '').trim();

/** Stan istniejącej blokady: żywy właściciel (PID) albo `null` = przeterminowana. */
function holder(file: string, now: number): number | 'fresh-empty' | null {
  let text: string;
  let mtimeMs: number;
  try {
    text = lockText(file);
    mtimeMs = statSync(file).mtimeMs;
  } catch (failure) {
    if (errnoCode(failure) === 'ENOENT') return null;
    throw new Refusal(`Cannot read lock ${file} (${errnoCode(failure) ?? 'error'}).`);
  }
  if (text.trim() === '') return now - mtimeMs < EMPTY_LOCK_GRACE_MS ? 'fresh-empty' : null;
  const first = pidLine(text);
  if (!/^[0-9]+$/.test(first)) return null;
  const pid = Number(first);
  return pid > 0 && pid !== process.pid && pidAlive(pid) ? pid : null;
}

/** Zdejmuje plik; brak pliku to nie błąd. */
function unlinkQuiet(file: string): void {
  try {
    unlinkSync(file);
  } catch (failure) {
    if (errnoCode(failure) !== 'ENOENT') {
      throw new Refusal(`Cannot remove stale lock ${file} (${errnoCode(failure) ?? 'error'}).`);
    }
  }
}

/** Żywy właściciel albo blokada w trakcie zakładania = {@link Refusal}; wolna albo martwa = powrót. */
function refuseIfHeld(file: string, now: number, what: string, busy: LockOptions['busy']): void {
  const owner = holder(file, now);
  if (owner === 'fresh-empty') {
    throw new Refusal(`${what}: another process is creating lock ${file} right now; try again in a moment.`);
  }
  if (owner !== null) {
    throw new Refusal(busy?.(owner, file) ?? `${what}: another call is running (PID ${String(owner)}, lock ${file}).`
      + ' Wait until it finishes; the lock of a dead process clears itself.');
  }
}

/** Plik przejęcia martwego procesu albo starszy niż {@link TAKEOVER_STALE_MS} (przejęcie trwa milisekundy). */
function takeoverStale(guard: string, now: number): boolean {
  try {
    if (now - statSync(guard).mtimeMs >= TAKEOVER_STALE_MS) return true;
  } catch (failure) {
    if (errnoCode(failure) === 'ENOENT') return true;
    throw new Refusal(`Cannot read ${guard} (${errnoCode(failure) ?? 'error'}).`);
  }
  return holder(guard, now) === null;
}

/** Zdejmuje plik, o ile nadal należy do tego procesu (PID w treści). */
function releaseIfOurs(file: string): void {
  try {
    if (pidLine(lockText(file)) === String(process.pid)) unlinkSync(file);
  } catch {
    // Pliku już nie ma albo nie da się go odczytać — nie nasza sprawa przy wyjściu.
  }
}

/** Punkt zaczepienia testów: wołany po uznaniu blokady za martwą, przed jej przejęciem. */
export interface LockHooks {
  readonly afterStaleRead?: () => void;
}

/** Another lock file of the same shape in the same directory (the update lock, `update-lock.ts`). */
export interface LockOptions {
  /** File name in the directory; default {@link LOCK_FILENAME}. */
  readonly filename?: string;
  /** Lines after the PID line, each ending in `\n`. */
  readonly body?: string;
  /** The refusal sentence for a live owner; default: another call is running, with its PID and the lock file. */
  readonly busy?: (pid: number, file: string) => string;
}

/**
 * Zakłada blokadę w `dir` (katalog tworzony z prawami 0700, gdy go nie ma). Zajęta przez żywy proces = {@link Refusal}
 * z jego PID-em; `what` nazywa komendę w komunikacie.
 */
export function acquireLock(
  dir: string, what: string, now: () => number = Date.now, hooks: LockHooks = {}, options: LockOptions = {},
): Lock {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (failure) {
    // Np. EPERM w sandboksie sesji Claude Code: jedno zdanie zamiast stosu, nic jeszcze nie zatrzymane.
    throw new Refusal(`Cannot create the lock directory ${dir} (${errnoCode(failure) ?? 'error'}).`);
  }
  const file = path.join(dir, options.filename ?? LOCK_FILENAME);
  const ours: Lock = { file, release: () => { releaseIfOurs(file); } };
  if (tryCreate(file, options.body)) return ours;
  refuseIfHeld(file, now(), what, options.busy);
  hooks.afterStaleRead?.();
  // Martwa blokada: przejęcie pod plikiem przejęcia (też `wx`), a pod nim ODCZYT OD NOWA — proces, który uznał
  // blokadę za martwą wcześniej, nie skasuje blokady, którą w międzyczasie założył ktoś żywy.
  const guard = `${file}${TAKEOVER_SUFFIX}`;
  const busy = new Refusal(`${what}: another process is taking over the dead lock ${file} right now; try again.`);
  if (!tryCreate(guard)) {
    if (!takeoverStale(guard, now())) throw busy;
    unlinkQuiet(guard);
    if (!tryCreate(guard)) throw busy;
  }
  try {
    refuseIfHeld(file, now(), what, options.busy);
    unlinkQuiet(file);
    if (tryCreate(file, options.body)) return ours;
    throw busy;
  } finally {
    releaseIfOurs(guard);
  }
}
