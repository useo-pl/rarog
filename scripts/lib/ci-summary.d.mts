/**
 * Typy `ci-summary.mjs` (podsumowanie raportu testów dla zadania CI). Osobny plik, bo `tsconfig.base.json` nie ma
 * `allowJs`, a moduł musi zostać czystym ESM dla gołego `node`.
 */

/** Początki powodu pominięcia w nawiasie tytułu testu. */
export declare const REASON_MARKERS: readonly string[];

/** Powód testów pominiętych w pliku z błędem (padnięty `beforeAll` albo import). */
export declare const FAILED_FILE_REASON: string;

/** Powód pominięcia z pełnej nazwy testu; `null`, gdy tytuł go nie podaje. */
export declare function skipReason(fullName: string): string | null;

export interface CiSummary {
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly failedFiles: number;
  /** Powód → liczba pominiętych testów, od największej liczby. */
  readonly reasons: ReadonlyArray<readonly [string, number]>;
  /** `plik › pełna nazwa` pominiętych testów bez powodu w tytule. */
  readonly silent: readonly string[];
}

/** Liczby z raportu vitest `--reporter=json`; wyjątek, gdy to nie raport vitest. */
export declare function summarize(report: unknown, root?: string): CiSummary;

/** Markdown podsumowania dla `$GITHUB_STEP_SUMMARY`. */
export declare function renderSummary(summary: CiSummary, job: string): string;

interface Writable {
  write(chunk: string): unknown;
}

/** Komenda: kod 0, 1 (ciche pominięcie albo raport nieczytelny) albo 2 (złe argumenty). */
export declare function main(
  argv: readonly string[],
  io?: { out?: Writable; err?: Writable; root?: string },
): number;
