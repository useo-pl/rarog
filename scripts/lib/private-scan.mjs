/**
 * Skaner prywatnych literałów — całe repo (albo eksport bez `.git`) wobec pliku literałów (`private-literals.mjs`).
 * Opis, tryby i miejsce w bramce publikacji: `docs/publishing.md`.
 *
 *   node scripts/lib/private-scan.mjs [--literals <plik>] [<korzeń>]                  raport, kod 1 przy trafieniu
 *   node scripts/lib/private-scan.mjs --gate [--literals <plik>] [<korzeń>]           bramka: zero trafień
 *   node scripts/lib/private-scan.mjs --gate --config <publish.config.json> <korzeń>  bramka na eksporcie bez pliku
 *   node scripts/lib/private-scan.mjs --baseline [--baseline-file <plik>] [<korzeń>]  zapadka wobec bazy poza repo
 *   node scripts/lib/private-scan.mjs --update-baseline [--baseline-file <plik>] [<korzeń>]
 *
 * Co skanuje (pliki z `repo-files.mjs`: z gitem albo spacerem z regułami `.gitignore`): treść plików tekstowych
 * linia po linii, nazwy plików i katalogów, cele dowiązań (bez wchodzenia za nie) i napisy w plikach binarnych
 * (ciągi drukowalnych znaków ASCII oraz UTF-16 obu kolejności bajtów, od 3 znaków, jak `strings -a -n 3`; bez
 * zewnętrznego narzędzia, więc wynik nie zależy od systemu). Plik binarny to plik z bajtem zerowym w pierwszych
 * 8000 bajtach (heurystyka gita). Lista dozwolonych plików binarnych to `binaries` w `publish.config.json` korzenia
 * albo w pliku z `--config` (`[{ path, reason }]`; eksport tego pliku nie niesie, więc bramka podaje go z checkoutu
 * źródłowego); plik binarny spoza niej jest znaleziskiem. Bez pliku w korzeniu i bez `--config` lista nie jest
 * sprawdzana, a `--gate` kończy się błędem; `--config` na plik, którego nie ma, to błąd, nie brak listy.
 *
 * Wynik: `plik:linia: forbidden[i] (kategoria)` i podsumowanie per kategoria; nigdy treść literału, a ścieżka
 * z literałem wychodzi zamaskowana (`maskPath`). Baza zapadki: `{ version: 1, files: { ścieżka: liczba } }`,
 * domyślnie `private-literals.baseline.json` obok pliku literałów.
 *
 * Kod wyjścia: 0 — czysto (albo zapisano bazę), 1 — trafienia, wzrost wobec bazy albo plik binarny spoza listy,
 * 2 — błąd: brak albo zły plik literałów, nieczytelny plik repo (nigdy pominięcie), zła baza, zły argument.
 */
import { lstatSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-main.mjs';
import {
  MIN_LITERAL_LENGTH, PrivateLiteralsError, findPrivateHits, loadPrivateLiterals, maskPath, privateLiteralsPath,
} from './private-literals.mjs';
import { repoFiles } from './repo-files.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BASELINE_VERSION = 1;
const BINARY_SNIFF = 8000;

/** Czy bajty to plik binarny (bajt zerowy w pierwszych 8000, jak w gicie). */
export function isBinary(bytes) {
  return bytes.subarray(0, BINARY_SNIFF).includes(0);
}

const printable = (byte) => byte === 0x09 || (byte >= 0x20 && byte <= 0x7e);

/**
 * Napisy z pliku binarnego: ciągi drukowalnych znaków ASCII oraz UTF-16LE i UTF-16BE o długości co najmniej `min`.
 * UTF-16 w obu kolejnościach bajtów i od OBU parytetów początku: napis zaczęty na bajcie nieparzystym nie może
 * stracić pierwszego znaku przez bajt sąsiada spoza napisu.
 */
export function printableRuns(bytes, min = MIN_LITERAL_LENGTH) {
  const runs = [];
  let current = '';
  const flush = () => {
    if (current.length >= min) runs.push(current);
    current = '';
  };
  for (const byte of bytes) {
    if (printable(byte)) current += String.fromCharCode(byte);
    else flush();
  }
  flush();
  for (const start of [0, 1]) {
    for (const littleEndian of [true, false]) {
      // Para bajtów od `at`: znak drukowalny i zero (LE) albo zero i znak (BE).
      for (let at = start; at + 1 < bytes.length; at += 2) {
        const ch = littleEndian ? bytes[at] : bytes[at + 1];
        const zero = littleEndian ? bytes[at + 1] : bytes[at];
        if (ch !== undefined && zero === 0 && printable(ch)) current += String.fromCharCode(ch);
        else flush();
      }
      flush();
    }
  }
  return runs;
}

/**
 * Lista `binaries`: z pliku `config` (jawnie podany; brak pliku to wyjątek) albo z `publish.config.json` korzenia
 * (`null` bez pliku). Zbiór ścieżek; wyjątek przy złym pliku.
 */
export function loadBinariesList(root, config) {
  const file = config ?? path.join(root, 'publish.config.json');
  const label = config ?? 'publish.config.json';
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (config === undefined && err !== null && typeof err === 'object' && err.code === 'ENOENT') return null;
    throw new Error(`${label}: cannot read (${String(err?.code ?? err)})`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${label}: the file is not valid JSON`);
  }
  const list = data?.binaries;
  if (!Array.isArray(list)) throw new Error(`${label}: binaries: expected a list { path, reason }`);
  return new Set(list.map((entry, index) => {
    if (typeof entry?.path !== 'string' || entry.path === '' || typeof entry?.reason !== 'string' || entry.reason.trim() === '') {
      throw new Error(`${label}: binaries[${String(index)}]: expected an object { path, reason }`);
    }
    return entry.path;
  }));
}

/**
 * Skan korzenia `root` (opcjonalnie tylko plików, dla których `only(ścieżka)` daje `true`). `files` zastępuje listę
 * z `repo-files.mjs` jawną listą ścieżek: bramka publikacji skanuje eksport według manifestu, bo spacer po regułach
 * `.gitignore` nie widzi pliku śledzonego mimo `.gitignore` (`git add -f`). Wynik: `findings`
 * (`{ file, where, ref, label }`; `where` to numer linii, `name`, `symlink`, `strings` albo `allowlist`),
 * `errors` (nieczytelne pliki), `counts` (zamaskowana ścieżka → liczba znalezisk) i `files` (liczba plików).
 */
export function scanRepo(root, literals, { binaries = null, only, files: list } = {}) {
  const findings = [];
  const errors = [];
  const files = (list ?? repoFiles(root)).filter((file) => only === undefined || only(file));
  const add = (file, where, hits) => {
    for (const hit of hits) findings.push({ file, where: where ?? String(hit.line), ref: hit.ref, label: hit.label });
  };
  for (const file of files) {
    add(file, 'name', findPrivateHits(file, literals, file));
    const full = path.join(root, file);
    try {
      const stats = lstatSync(full);
      if (stats.isSymbolicLink()) {
        add(file, 'symlink', findPrivateHits(readlinkSync(full), literals, file));
        continue;
      }
      if (!stats.isFile()) {
        errors.push(`${maskPath(file, literals)}: neither a file nor a symlink`);
        continue;
      }
      const bytes = readFileSync(full);
      if (isBinary(bytes)) {
        if (binaries !== null && !binaries.has(file)) {
          findings.push({ file, where: 'allowlist', ref: 'binaries', label: 'non-text file not listed in publish.config.json' });
        }
        add(file, 'strings', findPrivateHits(printableRuns(bytes).join('\n'), literals, file));
      } else {
        add(file, undefined, findPrivateHits(bytes.toString('utf8'), literals, file));
      }
    } catch (err) {
      errors.push(`${maskPath(file, literals)}: unreadable (${String(err?.code ?? err)})`);
    }
  }
  // Klucz zapadki to ścieżka zamaskowana (po NFKC i małych literach). Dwa RÓŻNE pliki pod jednym kluczem
  // sumowałyby liczniki, więc trafienie dałoby się przenieść między nimi bez reakcji zapadki: to błąd skanu.
  const counts = new Map();
  const owners = new Map();
  for (const finding of findings) {
    const key = maskPath(finding.file, literals);
    const owner = owners.get(key);
    if (owner === undefined) owners.set(key, finding.file);
    else if (owner !== finding.file && !errors.includes(`${key}: two different files under the same masked key`)) {
      errors.push(`${key}: two different files under the same masked key`);
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return { findings, errors, counts, files: files.length };
}

function readBaseline(file) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    const missing = err !== null && typeof err === 'object' && err.code === 'ENOENT';
    throw new Error(missing ? `no ratchet baseline ${file} (first run: --update-baseline)` : `ratchet baseline ${file}: bad JSON`);
  }
  if (data?.version !== BASELINE_VERSION || data.files === null || typeof data.files !== 'object') {
    throw new Error(`ratchet baseline ${file}: expected { version: ${String(BASELINE_VERSION)}, files: { path: count } }`);
  }
  for (const [key, value] of Object.entries(data.files)) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`ratchet baseline ${file}: files: bad count for entry ${key}`);
  }
  return new Map(Object.entries(data.files));
}

const USAGE = 'usage: private-scan.mjs [--gate | --baseline | --update-baseline] [--baseline-file <file>] '
  + '[--literals <file>] [--config <publish.config.json>] [<root>]';

function parseArgs(argv) {
  const opts = { mode: 'report', root: REPO, literals: undefined, baselineFile: undefined, config: undefined };
  const modes = new Set();
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at];
    if (arg === '--gate') modes.add('gate');
    else if (arg === '--baseline') modes.add('baseline');
    else if (arg === '--update-baseline') modes.add('update');
    else if (arg === '--literals' || arg === '--baseline-file' || arg === '--config') {
      const value = argv[at + 1];
      if (value === undefined) return null;
      if (arg === '--literals') opts.literals = value;
      else if (arg === '--config') opts.config = path.resolve(value);
      else opts.baselineFile = value;
      at += 1;
    } else if (arg.startsWith('--')) return null;
    else if (opts.root !== REPO) return null;
    else opts.root = path.resolve(arg);
  }
  if (modes.size > 1) return null;
  if (opts.baselineFile !== undefined && !modes.has('baseline') && !modes.has('update')) return null;
  opts.mode = [...modes][0] ?? 'report';
  return opts;
}

/** Warstwa CLI; zwraca kod wyjścia. */
export function main(argv, { env = process.env, out = process.stdout, err = process.stderr } = {}) {
  const opts = parseArgs(argv);
  if (opts === null) {
    err.write(`${USAGE}\n`);
    return 2;
  }
  let literals;
  try {
    literals = loadPrivateLiterals({ env, file: opts.literals });
  } catch (error) {
    err.write(`private-scan: ${error instanceof PrivateLiteralsError ? error.message : String(error)}\n`);
    return 2;
  }
  if (literals === null) {
    err.write(`private-scan: no private literals file (${opts.literals ?? privateLiteralsPath(env)}): nothing to scan `
      + 'with, docs/publishing.md\n');
    return 2;
  }
  let binaries;
  try {
    binaries = loadBinariesList(opts.root, opts.config);
  } catch (error) {
    err.write(`private-scan: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (binaries === null && opts.mode === 'gate') {
    err.write('private-scan: --gate needs publish.config.json with a `binaries` field (in the root or --config <file>)\n');
    return 2;
  }
  let result;
  try {
    result = scanRepo(opts.root, literals, { binaries });
  } catch (error) {
    err.write(`private-scan: file list: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  const { findings, errors, counts } = result;
  out.write(`private-scan: ${String(result.files)} files, literals ${String(literals.forbidden.length)}, `
    + `patterns ${String(literals.patterns.length)}${binaries === null ? ', `binaries` not checked (no publish.config.json)' : ''}\n`);
  const line = (finding) => `${maskPath(finding.file, literals)}:${finding.where}: ${finding.ref} (${finding.label})`;
  const summary = () => {
    const byLabel = new Map();
    for (const finding of findings) byLabel.set(finding.label, (byLabel.get(finding.label) ?? 0) + 1);
    for (const [label, count] of [...byLabel].sort(([a], [b]) => (a < b ? -1 : 1))) {
      out.write(`  ${label}: ${String(count)}\n`);
    }
    out.write(`total: ${String(findings.length)} hits in ${String(counts.size)} files\n`);
  };
  for (const error of errors) err.write(`private-scan: ${error}\n`);

  if (opts.mode === 'update' || opts.mode === 'baseline') {
    const file = opts.baselineFile ?? path.join(path.dirname(opts.literals ?? privateLiteralsPath(env)), 'private-literals.baseline.json');
    if (opts.mode === 'update') {
      if (errors.length > 0) return 2;
      const sorted = Object.fromEntries([...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
      writeFileSync(file, `${JSON.stringify({ version: BASELINE_VERSION, files: sorted }, null, 2)}\n`, { mode: 0o600 });
      summary();
      out.write(`baseline written: ${file}\n`);
      return 0;
    }
    let baseline;
    try {
      baseline = readBaseline(file);
    } catch (error) {
      err.write(`private-scan: ${error instanceof Error ? error.message : String(error)}\n`);
      return 2;
    }
    const grown = [...counts].filter(([key, count]) => count > (baseline.get(key) ?? 0));
    const lower = [...baseline].filter(([key, count]) => (counts.get(key) ?? 0) < count);
    for (const [key, count] of grown) {
      out.write(`GROWTH ${key}: ${String(count)} > baseline ${String(baseline.get(key) ?? 0)}\n`);
      for (const finding of findings.filter((candidate) => maskPath(candidate.file, literals) === key)) out.write(`  ${line(finding)}\n`);
    }
    if (lower.length > 0) out.write(`drop in ${String(lower.length)} files: lower the baseline (--update-baseline)\n`);
    summary();
    if (errors.length > 0) return 2;
    return grown.length > 0 ? 1 : 0;
  }

  for (const finding of findings) out.write(`${line(finding)}\n`);
  summary();
  if (errors.length > 0) return 2;
  return findings.length > 0 ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
