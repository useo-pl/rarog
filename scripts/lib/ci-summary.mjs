/**
 * Podsumowanie raportu testów dla zadania CI (`.github/workflows/check.yml`): liczby testów i pominięcia według
 * powodu z tytułu, czyli to, czego dane zadanie NIE sprawdziło.
 *
 *     node scripts/lib/ci-summary.mjs <raport vitest JSON> <nazwa zadania>
 *
 * Wypisuje Markdown na stdout; zadanie dopisuje go do `$GITHUB_STEP_SUMMARY`. Powód pominięcia stoi w nawiasie
 * w tytule testu albo jego `describe` (`… (macOS only: launchd)`, `… (requires gitleaks)`) i zaczyna się jednym
 * ze znaczników {@link REASON_MARKERS}. Pominięty test bez takiego nawiasu to ciche pominięcie: skrypt wypisuje
 * go z nazwą pliku i kończy się kodem 1. Kod 1 także przy raporcie nieczytelnym, kod 2 przy złych argumentach.
 * Opis: `docs/publishing.md`, „CI”.
 *
 * Czysty ESM, wyłącznie `node:*`. Typy: `ci-summary.d.mts`.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isMainModule } from './is-main.mjs';
import { SKIP_REASON } from './private-literals.mjs';

/**
 * Początki powodu pominięcia w nawiasie tytułu: testy tylko-macOS (`server/test/platform.ts`), testy włączane
 * zmienną środowiska, brak narzędzia, pliku albo commitu, warunek systemu i brak pliku prywatnych literałów.
 */
export const REASON_MARKERS = Object.freeze(['macOS only', 'only with ', 'requires ', 'skipped', SKIP_REASON]);

/**
 * Powód testów pominiętych w pliku z błędem (vitest oznacza tak testy po padniętym `beforeAll` albo imporcie). To nie
 * ciche pominięcie: plik jest czerwony, więc krok testów i tak pada.
 */
export const FAILED_FILE_REASON = 'file failed before its tests (hook or import)';

/** Ile cichych pominięć wypisać z nazwy (reszta jako liczba). */
const SILENT_SHOWN = 20;

/**
 * Powód pominięcia z pełnej nazwy testu (tytuły `describe` i testu): treść każdego nawiasu bez zagnieżdżeń,
 * w którym stoi znacznik, od znacznika do końca nawiasu; kilka powodów (np. `describe` tylko-macOS i test
 * wymagający checkoutu) łączy „ + ”, bo raport nie mówi, który warunek zadziałał. `null`, gdy takiego nawiasu nie ma.
 *
 * @param {string} fullName
 * @returns {string | null}
 */
export function skipReason(fullName) {
  const reasons = [];
  for (const match of fullName.matchAll(/\(([^()]*)\)/g)) {
    const inner = match[1] ?? '';
    const starts = REASON_MARKERS.map((marker) => inner.indexOf(marker)).filter((index) => index !== -1);
    if (starts.length > 0) reasons.push(inner.slice(Math.min(...starts)).trim());
  }
  return reasons.length > 0 ? reasons.join(' + ') : null;
}

/**
 * Liczby z raportu vitest (`--reporter=json`). Pominięty to każdy test o stanie innym niż `passed` i `failed`
 * (`skipped`, `pending`, `todo`, `disabled`). Plik z błędem to plik o stanie `failed` (także taki, który nie
 * załadował się wcale i nie ma żadnego testu). Gdy w takim pliku żaden test nie padł, padł hook (`beforeAll` pliku
 * albo jednego `describe`) albo import: vitest oznacza testy za tym hookiem jako pominięte, a raport nie mówi, który
 * hook padł. Pominięte testy bez powodu w tytule liczą się wtedy pod {@link FAILED_FILE_REASON}, nie jako ciche
 * pominięcie. Zielonego przebiegu to nie dotyczy: tam żaden plik nie ma stanu `failed`.
 *
 * @param {unknown} report
 */
export function summarize(report, root = process.cwd()) {
  const files = /** @type {{ testResults?: unknown }} */ (report)?.testResults;
  if (!Array.isArray(files)) throw new Error('report without `testResults`: not a vitest JSON report');
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let failedFiles = 0;
  /** @type {Map<string, number>} */
  const reasons = new Map();
  /** @type {string[]} */
  const silent = [];
  for (const file of files) {
    const name = path.relative(root, String(file?.name ?? '')) || String(file?.name ?? '');
    const tests = Array.isArray(file?.assertionResults) ? file.assertionResults : [];
    if (file?.status === 'failed') failedFiles += 1;
    const hookFailed = file?.status === 'failed' && !tests.some((test) => test?.status === 'failed');
    for (const test of tests) {
      if (test?.status === 'passed') passed += 1;
      else if (test?.status === 'failed') failed += 1;
      else {
        skipped += 1;
        const fullName = String(test?.fullName ?? test?.title ?? '');
        const reason = skipReason(fullName) ?? (hookFailed ? FAILED_FILE_REASON : null);
        if (reason === null) silent.push(`${name} › ${fullName}`);
        else reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      }
    }
  }
  const byCount = [...reasons].sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
  return { passed, failed, skipped, failedFiles, reasons: byCount, silent };
}

/** Komórka tabeli Markdown: bez pionowej kreski i nowej linii. */
const cell = (text) => text.replaceAll('|', '\\|').replaceAll('\n', ' ');

/**
 * Markdown podsumowania dla `$GITHUB_STEP_SUMMARY`.
 *
 * @param {ReturnType<typeof summarize>} summary
 * @param {string} job
 */
export function renderSummary(summary, job) {
  const lines = [
    `### Tests: ${job}`,
    '',
    `Passed ${String(summary.passed)}, failed ${String(summary.failed)}, skipped ${String(summary.skipped)}`
      + (summary.failedFiles > 0 ? `, files with errors ${String(summary.failedFiles)}.` : '.'),
  ];
  if (summary.reasons.length > 0) {
    lines.push('', '| Skip reason | Tests |', '| --- | ---: |');
    for (const [reason, count] of summary.reasons) lines.push(`| ${cell(reason)} | ${String(count)} |`);
  }
  if (summary.silent.length > 0) {
    lines.push('', `**Skipped without a reason in the title: ${String(summary.silent.length)}.** The reason goes in parentheses`
      + ` in the test or \`describe\` title and starts with: ${REASON_MARKERS.map((m) => `"${m.trim()}"`).join(', ')}.`, '');
    for (const entry of summary.silent.slice(0, SILENT_SHOWN)) lines.push(`- \`${entry.replaceAll('`', "'")}\``);
    if (summary.silent.length > SILENT_SHOWN) lines.push(`- … and ${String(summary.silent.length - SILENT_SHOWN)} more`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * @param {readonly string[]} argv
 * @returns {number} kod wyjścia
 */
export function main(argv, { out = process.stdout, err = process.stderr, root = process.cwd() } = {}) {
  const [file, job, ...rest] = argv;
  if (file === undefined || job === undefined || job === '' || rest.length > 0) {
    err.write('usage: node scripts/lib/ci-summary.mjs <vitest JSON report> <job name>\n');
    return 2;
  }
  let summary;
  try {
    summary = summarize(JSON.parse(readFileSync(file, 'utf8')), root);
  } catch (error) {
    out.write(`### Tests: ${job}\n\nNo readable test report (${file}).\n`);
    err.write(`ci-summary: ${file}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  out.write(renderSummary(summary, job));
  if (summary.silent.length > 0) {
    err.write(`ci-summary: skipped without a reason in the title: ${String(summary.silent.length)}\n`);
    return 1;
  }
  return 0;
}

if (isMainModule(import.meta.url)) process.exitCode = main(process.argv.slice(2));
