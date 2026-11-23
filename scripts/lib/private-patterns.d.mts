/**
 * Typy `private-patterns.mjs` (wzorce strukturalne danych prywatnych). Osobny plik, bo `tsconfig.base.json` nie ma
 * `allowJs`, a moduł musi zostać czystym ESM dla gołego `node`.
 */

export declare const PATTERN_SAMPLES_FILE: 'server/test/private-patterns-guard.test.ts';
export declare const ALLOWED_EMAIL_DOMAINS: RegExp;
export declare const ALLOWED_TAILNETS: ReadonlySet<string>;
export declare const SYNTHETIC_LOGINS: ReadonlySet<string>;
export declare const PUBLIC_TICKET_PREFIXES: RegExp;

export declare const EMAIL: RegExp;
export declare const TAILNET: RegExp;
export declare const HOME_PATH: RegExp;
export declare const HOME_SLUG: RegExp;
export declare const TEMP_DIR: RegExp;
export declare const API_ID: RegExp;
export declare const ACCOUNT_PLAN: RegExp;
export declare const LIMIT_COUNTER: RegExp;
export declare const TICKET: RegExp;
export declare const GIT_SHOW: RegExp;

type Match = RegExpMatchArray | readonly string[];
export declare function privateEmail(match: Match): boolean;
export declare function privateTailnet(match: Match): boolean;
export declare function privateLogin(match: Match): boolean;
export declare function privateTicket(match: Match): boolean;

export interface StructuralPattern {
  /** Klucz zapadki strażnika (`plik [nazwa]`). */
  readonly name: string;
  /** Numery linii trafień w tekście pliku `file` (ścieżka względem korzenia repo). */
  readonly lines: (text: string, file: string) => number[];
}

export interface StructuralHit {
  readonly line: number;
  readonly name: string;
}

/** Wyjątek wzorca: linie pliku (albo plików pod katalogiem z `/` na końcu) z `fragment` nie liczą się dla `wzorzec`. */
export interface StructuralException {
  readonly plik: string;
  /** Nazwa wzorca z {@link STRUCTURAL_PATTERNS}. */
  readonly wzorzec: string;
  readonly fragment: string;
  readonly powod: string;
}

export interface StructuralHitsOptions {
  /** Domyślnie {@link STRUCTURAL_EXCEPTIONS}. */
  readonly exceptions?: readonly StructuralException[];
  /** Zbiera wyjątki, które zdjęły choć jedno trafienie. */
  readonly used?: Set<StructuralException>;
}

export declare const STRUCTURAL_PATTERNS: readonly StructuralPattern[];
export declare const STRUCTURAL_EXCEPTIONS: readonly StructuralException[];
export declare function structuralHits(text: string, file?: string, options?: StructuralHitsOptions): StructuralHit[];
