/**
 * The log line of a diff read: `git: diff list|file <ms> ms`, with the contract code of a refusal. One function over
 * the manager's clock and logger; it reads nothing and holds no state. The manager re-exports the phrases, so
 * importers keep their path. This module does not import `manager.ts`.
 */
import { DiffError } from '../git-diff.ts';

/** Fraza linii kosztu listy plików gita czytanej od nowa: `git: diff list <ms> ms`. */
export const GIT_DIFF_LIST_LOG = 'git: diff list';
/** Fraza linii kosztu patcha jednego pliku: `git: diff file <ms> ms`. */
export const GIT_DIFF_FILE_LOG = 'git: diff file';

/** What the line needs from the manager: its clock and its logger, read at the time of the line. */
export interface DiffMeasureClock {
  now(): number;
  log(line: string): void;
}

/**
 * Linia `git: diff list|file <ms>` w logu: koszt list gita czytanych od nowa przy każdym
 * żądaniu, czyli liczba, po której zapadnie decyzja o pamięci podręcznej. Niesie czas i — przy
 * odmowie — kod z kontraktu; NIGDY ścieżki ani nazwy pliku.
 */
export async function measureDiff<T>(
  phrase: typeof GIT_DIFF_LIST_LOG | typeof GIT_DIFF_FILE_LOG, clock: DiffMeasureClock, read: () => Promise<T>,
): Promise<T> {
  const startedAt = clock.now();
  const line = (suffix: string): void => {
    clock.log(`${phrase} ${String(clock.now() - startedAt)} ms${suffix}`);
  };
  try {
    const result = await read();
    line('');
    return result;
  } catch (error) {
    line(` (${error instanceof DiffError ? error.code : 'error'})`);
    throw error;
  }
}
