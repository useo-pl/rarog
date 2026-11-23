/**
 * Typy `private-scan.mjs` (skaner prywatnych literałów). Osobny plik, bo `tsconfig.base.json` nie ma `allowJs`,
 * a moduł musi zostać czystym ESM dla gołego `node`.
 */
import type { PrivateLiterals } from './private-literals.mjs';

export declare const BASELINE_VERSION: 1;

export interface ScanFinding {
  /** Ścieżka względem korzenia, NIEzamaskowana: do wypisania tylko przez `maskPath`. */
  readonly file: string;
  /** Numer linii albo `nazwa`, `dowiązanie`, `napisy`, `lista binaries`. */
  readonly where: string;
  readonly ref: string;
  readonly label: string;
}

export interface ScanResult {
  readonly findings: readonly ScanFinding[];
  /** Pliki, których nie dało się przeczytać (ścieżki zamaskowane). */
  readonly errors: readonly string[];
  /** Zamaskowana ścieżka → liczba znalezisk. */
  readonly counts: ReadonlyMap<string, number>;
  readonly files: number;
}

export declare function isBinary(bytes: Uint8Array): boolean;
export declare function printableRuns(bytes: Uint8Array, min?: number): string[];
/** Lista `binaries` z pliku `config` (brak = wyjątek) albo z `publish.config.json` korzenia (brak = `null`). */
export declare function loadBinariesList(root: string, config?: string): Set<string> | null;
export declare function scanRepo(
  root: string,
  literals: PrivateLiterals,
  options?: { binaries?: ReadonlySet<string> | null; only?: (file: string) => boolean; files?: readonly string[] },
): ScanResult;

interface Writable {
  write(text: string): unknown;
}

export declare function main(
  argv: readonly string[],
  io?: { env?: Readonly<Record<string, string | undefined>>; out?: Writable; err?: Writable },
): number;
