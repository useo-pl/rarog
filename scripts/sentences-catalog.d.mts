/**
 * Typy `sentences-catalog.mjs` (model katalogu zdań serwera z rejestru, katalog RarogContract, deskryptory Swift
 * i manifest opublikowanych kodów).
 * Osobny plik, bo `tsconfig.base.json` nie ma `allowJs`, a skrypt musi zostać czystym ESM dla gołego `node`.
 */
/** Rodzaj argumentu (lustro `SENTENCE_ARG_KINDS` z `shared/src/sentences/index.ts`; plik bez importu TS). */
export type SentenceArgKind = 'int' | 'text' | 'code' | 'instant' | 'plural';

/** Definicja zdania w rejestrze, tak jak ją czyta model. */
export interface RegistryDefinition {
  readonly en: string | { readonly one: string; readonly other: string };
  readonly args?: readonly string[];
}

export interface SentenceModelEntry {
  readonly code: string;
  readonly args: ReadonlyArray<{ readonly name: string; readonly kind: SentenceArgKind }>;
  readonly en: string | { readonly one: string; readonly other: string };
  /** `since` wpisu wycofanego, `null` dla kodu emitowanego. */
  readonly retired: string | null;
}

export interface SentenceModel {
  readonly sentences: readonly SentenceModelEntry[];
}

/** Manifest `shared/fixtures/sentences/published.json`: wpisy modelu w porządku kodów. */
export interface PublishedManifest {
  readonly format: number;
  readonly sentences: readonly SentenceModelEntry[];
}

/** Rejestr, który czyta generator (produkcyjny moduł albo rejestr testowy). */
export interface Registry {
  readonly SENTENCES: Readonly<Record<string, RegistryDefinition>>;
  readonly RETIRED: Readonly<Record<string, RegistryDefinition & { readonly since: string }>>;
  /** Spójność rejestru (`registryProblems` z `shared/src/sentences/index.ts`); metoda, więc parametry biwariantne. */
  registryProblems(
    sentences: Readonly<Record<string, RegistryDefinition>>,
    retired: Readonly<Record<string, RegistryDefinition & { readonly since: string }>>,
  ): string[];
}

/** Węzeł katalogu `.xcstrings` (lokalizacja, wariant, podstawienie); kształt luźny jak JSON z Xcode. */
export interface CatalogNode {
  stringUnit?: { state: string; value: string };
  substitutions?: Record<string, { argNum: number; formatSpecifier: string; variations: { plural: Record<string, CatalogNode> } }>;
  variations?: Record<string, Record<string, CatalogNode>>;
}

export interface Catalog {
  sourceLanguage: string;
  strings: Record<string, { comment?: string; extractionState?: string; localizations?: Record<string, CatalogNode> }>;
  version: string;
}

/** `pl` z wsadu: napis albo warianty `{one, few, many, other}`, z `{nazwa}` argumentu. */
export type PlTemplate = string | Readonly<Record<string, string>>;

export declare const CATALOG_PATH: string;
export declare const DESCRIPTORS_PATH: string;
export declare const PUBLISHED_PATH: string;
export declare const PUBLISHED_FORMAT: number;
export declare const PL_PLURAL: readonly string[];

/** Model rejestru: kody emitowane i wycofane, posortowane po kodzie, ze stałą kolejnością kluczy. */
export declare function buildModel(registry: Pick<Registry, 'SENTENCES' | 'RETIRED'>): SentenceModel;

/** Model jako tekst pliku: JSON z wcięciem 2 i końcowym znakiem nowej linii. */
export declare function formatModel(model: SentenceModel): string;

/** Klucz katalogu: `push.*` bez zmian, każdy inny kod `server.<kod>`. */
export declare function catalogKey(code: string): string;

/** Lokalizacja jednego języka z szablonu `{nazwa}` (zdanie albo podstawienie liczby mnogiej). */
export declare function localizationOf(sentence: SentenceModelEntry, template: unknown, categories: readonly string[]):
  { localization: CatalogNode; problems: string[] };

/** Komentarz tłumacza klucza. */
export declare function commentOf(sentence: SentenceModelEntry): string;

/** Mapa kod → `pl` z JSON w kształcie `{codes: [{code, pl}]}`; inny kształt rzuca. */
export declare function plSource(json: unknown): Map<string, PlTemplate>;

/** Katalog z modelu; `pl` z `previous`, brakujące z `pl`. */
export declare function buildCatalog(model: SentenceModel, options?: {
  readonly previous?: Catalog | null;
  readonly pl?: ReadonlyMap<string, PlTemplate>;
}): { catalog: Catalog; problems: string[] };

/** Katalog jako tekst w stylu Xcode. */
export declare function formatCatalog(catalog: Catalog): string;

/** Tekst `SentenceDescriptors.swift`. */
export declare function buildDescriptors(model: SentenceModel): string;

/** Problemy `pl` jednego klucza wobec argumentów zdania. */
export declare function plProblems(sentence: SentenceModelEntry, pl: CatalogNode | undefined): string[];

/** Zgodność katalogu i deskryptorów z modelem (`null` = pliku nie ma). */
export declare function outputProblems(model: SentenceModel, outputs: {
  readonly catalog: Catalog | null;
  readonly descriptors: string | null;
}): string[];

/** Zgodność manifestu z modelem: kształt, a każdy wpis w modelu z tymi samymi argumentami i `en`. */
export declare function publishedProblems(model: SentenceModel, published: PublishedManifest): string[];

/** Manifest `--publish` z modelu; `previous` z kodem spoza modelu albo złym kształtem daje `manifest: null`. */
export declare function publishManifest(model: SentenceModel, previous: unknown): {
  manifest: PublishedManifest | null;
  problems: string[];
  added: string[];
  changed: string[];
};

/** Komenda: 0 zrobione, 1 rejestr, katalog, `--pl` albo manifest niespójne, 2 zły argument. */
export declare function main(argv: string[], options?: {
  readonly root?: string;
  readonly registry?: Registry;
  readonly out?: { write(text: string): unknown };
  readonly err?: { write(text: string): unknown };
}): Promise<number>;
