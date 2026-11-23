/**
 * Testy tylko-macOS: sprawdzają kod, który na innym systemie idzie inną gałęzią (launchd zamiast systemd) albo woła
 * narzędzia macOS (`plutil`, `ditto`, `stat -f`, `launchctl`). Poza macOS pomijają się JAWNIE: powód stoi w tytule
 * (`… (macOS only: launchd)`), więc raport testów i podsumowanie CI pokazują, czego zadanie nie sprawdziło.
 *
 * Zamknięta lista plików z pominięciami i z testami tylko-macOS: `scripts-check.test.ts`, „Inwentarz pominięć”;
 * lista tylko-macOS dla czytelnika: `docs/publishing.md`, „macOS-only tests”.
 */
import { REASON_MARKERS } from '../../scripts/lib/ci-summary.mjs';

export const IS_MAC = process.platform === 'darwin';

/** Znacznik w tytule pominiętego testu (po nim liczy pominięcia podsumowanie CI). */
export const MAC_ONLY = 'macOS only';

/**
 * Tytuł testu tylko-macOS: `why` to narzędzie albo mechanizm, którego test potrzebuje. Bez nawiasów, bo
 * podsumowanie CI (`scripts/lib/ci-summary.mjs`) czyta powód z nawiasu w tytule.
 */
export function macOnly(title: string, why: string): string {
  if (/[()]/.test(why)) throw new Error(`macOnly: powód bez nawiasów („${why}”)`);
  return `${title} (${MAC_ONLY}: ${why})`;
}

/** Miejsce pominięcia w kodzie testu: `describe`, `it` albo `test` z `.skipIf`, `.runIf`, `.skip`, `.todo`; `ctx.skip(`. */
const SKIP_SITE = /\b(?:describe|it|test)\.(?:skipIf|runIf|skip|todo)\b|\bctx\.skip\(/g;

/** Powód pominięcia w linii: znacznik podsumowania CI albo pomocnik, który go dokleja do tytułu. */
const REASON_IN_LINE = [...REASON_MARKERS, 'macOnly(', 'checkoutOnly(', 'historyOnly(', 'SKIP_REASON'];

export interface SkipSites {
  /** Liczba miejsc pominięcia w pliku. */
  readonly count: number;
  /** Plik ma pominięcie tylko-macOS (`skipIf(!IS_MAC)`). */
  readonly macOnly: boolean;
  /**
   * Numery linii pominięcia tylko-macOS bez {@link macOnly} w tytule, z warunkiem na `process.platform` albo jako
   * `runIf(IS_MAC)`: każde idzie przez `skipIf(!IS_MAC)(macOnly(…))`, żeby powód stał w tytule.
   */
  readonly bare: readonly number[];
  /**
   * Numery linii `skipIf`, `runIf`, `.skip` albo `.todo` bez powodu w tej samej linii (tytuł z nawiasem
   * `(requires …)` albo pomocnik tytułu). `ctx.skip()` się nie liczy: powód stoi w tytule testu wyżej, a sprawdza go
   * podsumowanie CI na raporcie.
   */
  readonly unexplained: readonly number[];
}

/** Pominięcia w treści pliku testu (skan tekstu, bez uruchamiania). */
export function skipSites(text: string): SkipSites {
  let count = 0;
  let mac = false;
  const bare: number[] = [];
  const unexplained: number[] = [];
  text.split('\n').forEach((line, index) => {
    const sites = line.match(SKIP_SITE)?.length ?? 0;
    count += sites;
    if (sites === 0) return;
    if (!/\bctx\.skip\(/.test(line) && !REASON_IN_LINE.some((reason) => line.includes(reason))) unexplained.push(index + 1);
    if (line.includes('process.platform') || /\.runIf\(IS_MAC\b/.test(line)) bare.push(index + 1);
    if (/\.skipIf\(!IS_MAC\b/.test(line)) {
      mac = true;
      if (!line.includes('macOnly(')) bare.push(index + 1);
    }
  });
  return { count, macOnly: mac, bare, unexplained };
}
