/**
 * Reprodukcje zawieszeń na plikach specjalnych (FIFO w katalogu projektu) w procesie POTOMNYM, z limitem
 * czasu egzekwowanym przez rodzica.
 *
 * Synchroniczny odczyt FIFO bez pisarza (`openSync`, `readFileSync`) zatrzymuje pętlę zdarzeń: timer vitest
 * w tym samym procesie nigdy by nie wystrzelił, więc test na kodzie sprzed poprawki wisiałby zamiast paść.
 * Asynchroniczny odczyt (`fs.promises.open`, `readFile`) zajmuje wątek puli libuv bez końca, a pulę dzieli cały
 * worker testów. Proces potomny zabity `SIGKILL` po limicie zabiera zablokowany wątek ze sobą, a rodzic dostaje
 * kontrolowaną porażkę „proces nie skończył w N s”.
 *
 * Skrypt dziecka to ESM (`.mts`) uruchamiany przez `node --import tsx` z korzeniem repo jako `cwd`: tsx ładuje
 * się w tym samym procesie (CLI `tsx` startuje drugi proces, który po `SIGKILL` rodzica zostałby osierocony
 * na FIFO).
 */
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect } from 'vitest';

const REPO = join(import.meta.dirname, '..', '..');

/** Limit procesu potomnego: start tsx i import modułów to ok. 1 s, reszta to zapas na obciążony komputer. */
export const CHILD_LIMIT_MS = 10_000;

/** Limit testu vitest wokół jednego dziecka: limit dziecka plus zapas na start i sprzątanie. */
export const CHILD_TEST_TIMEOUT_MS = CHILD_LIMIT_MS + 10_000;

export interface ChildResult {
  /** `false`: rodzic zabił proces po limicie (zawieszenie). */
  readonly finished: boolean;
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Specyfikator importu modułu serwera (`server/src/<ścieżka>`) do wklejenia w źródło skryptu dziecka. */
export function serverModule(relative: string): string {
  return JSON.stringify(pathToFileURL(join(REPO, 'server', 'src', relative)).href);
}

let counter = 0;

/** Zapisuje `source` jako skrypt w `dir` i uruchamia go z limitem; nie rzuca. */
export async function runInChild(dir: string, source: string, limitMs = CHILD_LIMIT_MS): Promise<ChildResult> {
  counter += 1;
  const script = join(dir, `dziecko-${String(process.pid)}-${String(counter)}.mts`);
  await writeFile(script, source);
  return new Promise((resolve) => {
    execFile(
      process.execPath, ['--import', 'tsx', script],
      { cwd: REPO, timeout: limitMs, killSignal: 'SIGKILL', encoding: 'utf8' },
      (error, stdout, stderr) => {
        const killed = error !== null && error.killed === true;
        const code = error === null ? 0 : (typeof error.code === 'number' ? error.code : null);
        resolve({ finished: !killed, code, stdout, stderr });
      },
    );
  });
}

/** Dziecko skończyło samo i z kodem 0; zwraca sparsowaną ostatnią linię stdout (JSON). */
export function childJson<T>(result: ChildResult, limitMs = CHILD_LIMIT_MS): T {
  expect(result.finished, `proces nie skończył w ${String(limitMs / 1000)} s (zawieszenie)`).toBe(true);
  expect(result.code, `proces skończył się kodem ${String(result.code)}: ${result.stderr}`).toBe(0);
  const last = result.stdout.trim().split('\n').at(-1) ?? '';
  return JSON.parse(last) as T;
}
