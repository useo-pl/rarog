/**
 * Wspólne dla strażników publikacji (`docs/publishing.md`, „Ratchet versus gate”): plik prywatnych literałów
 * w testach i zapadka liczb per plik.
 *
 * Plik literałów (`scripts/lib/private-literals.mjs`) leży poza repo. Strażnik nazw bez pliku POMIJA się
 * z komunikatem {@link SKIP_REASON}; `RAROG_REQUIRE_PRIVATE_LITERALS=1` (bramka publikacji, `check.sh --strict`)
 * zamienia pominięcie w czerwony test, a zepsuty plik jest czerwony zawsze. Zapadka: liczba trafień per plik nie
 * rośnie wobec bazy w teście (ścieżki i liczby nie są prywatne), a baza, która jest za wysoka, też jest czerwona,
 * więc każde sprzątnięcie ją obniża. `RAROG_PUBLISH_GATE=1` ignoruje bazę i wymaga zera.
 *
 * Używają: `herdr-fixtures.test.ts` (fixture'y), `distribution-guard.test.ts` (reszta repo),
 * `private-patterns-guard.test.ts` (wzorce strukturalne, zapadka bez pliku literałów).
 *
 * Strażniki liczą tylko widok eksportu ({@link inExportView}), więc ich bazy są te same w repo źródłowym
 * i w eksporcie.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PrivateLiteralsError, SKIP_REASON, loadPrivateLiterals, privateLiteralsPath, privateLiteralsRequired, publishGate,
  type PrivateLiterals,
} from '../../scripts/lib/private-literals.mjs';
import { scanRepo } from '../../scripts/lib/private-scan.mjs';
import { repoFiles } from '../../scripts/lib/repo-files.mjs';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** Dopisek pominięcia (definicja w loaderze, bo po nim bramka publikacji czyta raport testów). */
export { SKIP_REASON };

/** Konfiguracja eksportu i jej klasyfikator: są tylko w repo źródłowym, eksport ich nie niesie. */
const EXPORT_CONFIG = 'publish.config.json';
const EXPORT_CLASSIFIER = 'scripts/lib/export-tree.mjs';

interface ExportClassifier {
  loadExportConfig(file: string): unknown;
  classify(files: readonly string[], config: unknown): { classes: ReadonlyMap<string, 'public' | 'private'> };
}

/**
 * Pliki repo `root`, które nie wychodzą w eksporcie (ścieżki względem korzenia).
 *
 * Repo źródłowe niesie `publish.config.json`: zbiór to pliki, które klasyfikacja z tego pliku daje jako
 * `private`, liczone tą samą funkcją `classify`, co drzewo eksportu. Eksport nie niesie ani konfiguracji, ani
 * plików prywatnych, więc zbiór jest pusty i strażnik liczy wszystko. Klasyfikator ładuje się warunkowo, bo
 * w eksporcie go nie ma; konfiguracja bez klasyfikatora kończy się wyjątkiem, nie pustym zbiorem. Plik bez klasy
 * albo w dwóch klasach liczy się jak publiczny: strażnik woli policzyć za dużo, a pełność klasyfikacji pilnuje
 * osobny strażnik repo źródłowego.
 */
export async function privateLayer(root: string = REPO): Promise<ReadonlySet<string>> {
  if (!existsSync(path.join(root, EXPORT_CONFIG))) return new Set();
  const classifier = await import(pathToFileURL(path.join(root, EXPORT_CLASSIFIER)).href) as ExportClassifier;
  const { classes } = classifier.classify(repoFiles(root), classifier.loadExportConfig(path.join(root, EXPORT_CONFIG)));
  return new Set([...classes].filter(([, klass]) => klass === 'private').map(([file]) => file));
}

/** Pliki tego repo spoza widoku eksportu; w eksporcie zbiór pusty. */
export const PRIVATE_LAYER: ReadonlySet<string> = await privateLayer();

/** Plik (ścieżka względem korzenia repo) należy do widoku eksportu: strażnik publiczny go liczy. */
export const inExportView = (file: string): boolean => !PRIVATE_LAYER.has(file);

type Env = Readonly<Record<string, string | undefined>>;

export interface PrivateContext {
  readonly literals: PrivateLiterals | null;
  /** Błąd pliku literałów (nazwa pola, bez treści); `null`, gdy plik jest poprawny albo go nie ma. */
  readonly error: string | null;
  readonly required: boolean;
  readonly gate: boolean;
  readonly file: string;
}

export function privateContext(env: Env = process.env): PrivateContext {
  const base = { required: privateLiteralsRequired(env), gate: publishGate(env), file: privateLiteralsPath(env) };
  try {
    return { ...base, literals: loadPrivateLiterals({ env }), error: null };
  } catch (error) {
    if (!(error instanceof PrivateLiteralsError)) throw error;
    return { ...base, literals: null, error: error.message };
  }
}

/** Plik leży w katalogu fixture'ów (`fixtures/` albo `Fixtures/` na dowolnej głębokości). */
export function isFixture(file: string): boolean {
  return /(?:^|\/)(?:fixtures|Fixtures)\//.test(file);
}

/**
 * `describe` strażnika nazw: z plikiem — `body(literals)`; bez pliku — pominięcie z {@link SKIP_REASON} w tytule,
 * a przy wymogu albo zepsutym pliku — jeden czerwony test z powodem.
 */
export function describePrivate(title: string, ctx: PrivateContext, body: (literals: PrivateLiterals) => void): void {
  if (ctx.error !== null) {
    const error = ctx.error;
    describe(title, () => {
      it('plik prywatnych literałów przechodzi schemat', () => {
        expect.fail(error);
      });
    });
    return;
  }
  const literals = ctx.literals;
  if (literals === null) {
    if (ctx.required) {
      describe(title, () => {
        it('plik prywatnych literałów jest wymagany (RAROG_REQUIRE_PRIVATE_LITERALS=1)', () => {
          expect.fail(`brak pliku prywatnych literałów (${ctx.file}); docs/publishing.md, „Private literals file”`);
        });
      });
      return;
    }
    describe.skip(`${title} (${SKIP_REASON})`, () => {
      it('pominięty', () => undefined);
    });
    return;
  }
  describe(title, () => {
    body(literals);
  });
}

export interface PrivateCounts {
  /** Zamaskowana ścieżka → liczba trafień (treść, nazwa, cel dowiązania, napisy pliku binarnego). */
  readonly counts: ReadonlyMap<string, number>;
  /** Pliki nieczytelne (ścieżki zamaskowane). */
  readonly errors: readonly string[];
  readonly files: number;
}

/**
 * Trafienia prywatnych literałów w plikach widoku eksportu tego repo, dla których `only` daje `true`; ten sam
 * skan, co bramka na drzewie eksportu.
 */
export function privateCounts(literals: PrivateLiterals, only: (file: string) => boolean): PrivateCounts {
  const result = scanRepo(REPO, literals, { only: (file) => inExportView(file) && only(file) });
  return { counts: result.counts, errors: result.errors, files: result.files };
}

export interface RatchetReport {
  /** Wzrost wobec bazy (w bramce: każda liczba > 0). */
  readonly grown: string[];
  /** Baza wyższa niż stan: do obniżenia. */
  readonly stale: string[];
}

/** Zapadka: `current` wobec `baseline` (klucz → liczba); w bramce każda niezerowa liczba to wzrost. */
export function ratchet(
  current: ReadonlyMap<string, number>, baseline: Readonly<Record<string, number>>, gate: boolean,
): RatchetReport {
  const grown: string[] = [];
  const stale: string[] = [];
  const keys = [...new Set([...current.keys(), ...Object.keys(baseline)])].sort();
  for (const key of keys) {
    const now = current.get(key) ?? 0;
    // Tylko własne pola bazy: plik nazwany `constructor` albo `toString` nie może dziedziczyć „bazy” z prototypu.
    const allowed = gate || !Object.hasOwn(baseline, key) ? 0 : baseline[key] ?? 0;
    if (now > allowed) {
      grown.push(gate ? `${key}: ${String(now)} — bramka publikacji wymaga zera` : `${key}: ${String(now)}, baza ${String(allowed)}`);
    } else if (!gate && now < allowed) {
      stale.push(`${key}: baza ${String(allowed)}, jest ${String(now)} — obniż`);
    }
  }
  return { grown, stale };
}

/** Ban: every key above zero as `key: count`, sorted. No baseline and no gate switch: zero holds in every run. */
export function overZero(current: ReadonlyMap<string, number>): string[] {
  return [...current].filter(([, count]) => count > 0).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, count]) => `${key}: ${String(count)}`);
}

/** Baza do wklejenia w test (`'ścieżka': liczba,`), posortowana. */
export function renderBaseline(current: ReadonlyMap<string, number>): string {
  return [...current].filter(([, count]) => count > 0).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, count]) => `  ${JSON.stringify(key).replace(/^"|"$/g, "'")}: ${String(count)},`).join('\n');
}

/** Co zrobić przy czerwonej zapadce literałów i wzorców (domyślna rada {@link ratchetMessage}). */
const LITERALS_HINT = [
  'Wzrost: podmień wartość na syntetyczną (nie podnoś bazy). Spadek: obniż bazę. Zmieniony plik literałów:',
  'przelicz bazę (tabela niżej, ścieżki z literałem są zamaskowane).',
] as const;

/**
 * Komunikat czerwonej zapadki: co zrobić (`hint`, domyślnie rada dla literałów), potem dowody, potem cała baza
 * do wklejenia (bez literałów).
 */
export function ratchetMessage(
  kind: string, report: RatchetReport, current: ReadonlyMap<string, number>, hint: readonly string[] = LITERALS_HINT,
): string {
  return [
    `${kind}: liczby trafień per plik wobec bazy w teście.`,
    ...hint,
    ...report.grown.map((line) => `WZROST ${line}`),
    ...report.stale.map((line) => `SPADEK ${line}`),
    'aktualna baza:',
    renderBaseline(current),
  ].join('\n');
}
