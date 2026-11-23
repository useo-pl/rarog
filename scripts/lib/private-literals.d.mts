/**
 * Typy `private-literals.mjs` (loader pliku prywatnych literałów, schemat `version: 2`, dopasowanie). Osobny plik,
 * bo `tsconfig.base.json` nie ma `allowJs`, a moduł musi zostać czystym ESM dla gołego `node`.
 */

export declare const PRIVATE_LITERALS_ENV: 'RAROG_PRIVATE_LITERALS';
export declare const REQUIRE_PRIVATE_LITERALS_ENV: 'RAROG_REQUIRE_PRIVATE_LITERALS';
export declare const PUBLISH_GATE_ENV: 'RAROG_PUBLISH_GATE';
export declare const SCHEMA_VERSION: 2;
export declare const SKIP_REASON: 'brak pliku prywatnych literałów: test pominięty';
export declare const MIN_LITERAL_LENGTH: 3;

type Env = Readonly<Record<string, string | undefined>>;

export declare class PrivateLiteralsError extends Error {
  constructor(file: string, field: string, problem: string);
  readonly file: string;
  /** Nazwa pola (`forbidden[3]`, `(JSON)`, `(plik)`), nigdy treść. */
  readonly field: string;
}

export interface ForbiddenLiteral {
  readonly index: number;
  /** Literał po NFKC i małych literach. */
  readonly needle: string;
  readonly category: string;
}

export interface PrivatePattern {
  readonly index: number;
  readonly name: string;
  /** Flagi `gimu`. */
  readonly regex: RegExp;
}

export interface Pseudonym {
  readonly index: number;
  readonly from: string;
  readonly needle: string;
  readonly to: string;
}

export interface AllowEntry {
  readonly path: string;
  readonly forbiddenIndex: number;
}

export interface PrivateLiterals {
  readonly file: string;
  readonly version: 2;
  readonly forbidden: readonly ForbiddenLiteral[];
  readonly patterns: readonly PrivatePattern[];
  /** Dłuższe nazwy najpierw. */
  readonly pseudonyms: readonly Pseudonym[];
  readonly allow: readonly AllowEntry[];
}

export interface PrivateHit {
  readonly line: number;
  /** `forbidden[i]` albo `patterns[i]`. */
  readonly ref: string;
  /** Kategoria literału albo nazwa wzorca. */
  readonly label: string;
}

export declare function privateLiteralsPath(env?: Env): string;
export declare function privateLiteralsRequired(env?: Env): boolean;
export declare function publishGate(env?: Env): boolean;
export declare function normalizeLiteral(text: string): string;
export declare function parsePrivateLiterals(data: unknown, file?: string): PrivateLiterals;
export declare function loadPrivateLiterals(options?: { env?: Env; file?: string }): PrivateLiterals | null;
export declare function findPrivateHits(text: string, literals: PrivateLiterals, file?: string): PrivateHit[];
export declare function maskPath(file: string, literals: PrivateLiterals): string;
export declare function applyPseudonyms(text: string, pseudonyms: readonly Pick<Pseudonym, 'needle' | 'to'>[]): string;
