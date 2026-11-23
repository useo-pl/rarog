/**
 * Typy `data-dir.mjs` (reguła katalogu danych). Osobny plik, bo `tsconfig.base.json` nie ma `allowJs`,
 * a moduł musi zostać czystym ESM dla gołego `node`. Bez typów Node: plik czyta też projekt przekaźnika (`relay/`),
 * który ma tylko typy Workera.
 */

export declare const DATA_DIR_ENV: 'RAROG_DATA_DIR';
export declare const XDG_DATA_HOME_ENV: 'XDG_DATA_HOME';
export declare const DATA_DIR_NAME: 'rarog';

/** Skąd wziął się katalog: `flag` — `--data-dir`; `env` — `RAROG_DATA_DIR`; `default` — `<baza>/rarog`. */
export type DataDirSource = 'flag' | 'env' | 'default';

export interface DataDirResolved {
  readonly ok: true;
  readonly dir: string;
  readonly source: DataDirSource;
}

/**
 * Powód konfliktu: `default-not-dir` — `<baza>/rarog` to plik, dowiązanie bez celu albo do pliku; `unreadable` —
 * `lstat` albo `stat` skończył się innym błędem niż ENOENT (także pętla dowiązań, ELOOP).
 */
export type DataDirConflictReason = 'default-not-dir' | 'unreadable';

export interface DataDirConflict {
  readonly ok: false;
  /** `<baza>/rarog`. */
  readonly defaultDir: string;
  readonly reason: DataDirConflictReason;
  /** Szczegół do komunikatu: rodzaj wpisu albo kod błędu ze ścieżką. */
  readonly detail: string;
}

export type DataDirResult = DataDirResolved | DataDirConflict;

export interface ResolveDataDirOptions {
  /** Wartość `--data-dir`; pusty napis = brak flagi. */
  readonly flag?: string | undefined;
  /** Środowisko; czytane są wyłącznie `RAROG_DATA_DIR` i `XDG_DATA_HOME`. Domyślnie `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Katalog domowy; domyślnie `os.homedir()`. */
  readonly home?: string | undefined;
}

export declare function resolveDataDir(options?: ResolveDataDirOptions): DataDirResult;

/** Komunikat konfliktu: ścieżka, powód i komenda naprawy. */
export declare function dataDirConflictMessage(conflict: DataDirConflict): string;
