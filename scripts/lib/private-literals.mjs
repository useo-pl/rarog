/**
 * Plik prywatnych literałów — JEDYNE źródło nazw, których repo nie może nieść (klienci, projekty i infrastruktura
 * właściciela, konto), i mapy pseudonimów anonimizatora. Plik leży POZA repo; w repo są tylko mechanizm, wzorce
 * strukturalne (`server/test/private-patterns-guard.test.ts`) i liczby zapadki. Opis: `docs/publishing.md`.
 *
 * Ścieżka: niepuste `RAROG_PRIVATE_LITERALS`, inaczej `~/.config/rarog/private-literals.json` (`HOME` procesu).
 * Brak pliku to `null`: strażniki nazw się pomijają z komunikatem, a `RAROG_REQUIRE_PRIVATE_LITERALS=1`
 * (bramka publikacji, `check.sh --strict`) zamienia pominięcie w porażkę. Dowiązanie bez celu, nieczytelny plik
 * i każdy błąd schematu to wyjątek `PrivateLiteralsError`, nigdy `null`: zepsuty plik nie może wyglądać jak brak.
 *
 * Schemat (`version: 2`):
 *
 *     {
 *       "version": 2,
 *       "forbidden": ["nazwa", { "literal": "nazwa", "category": "klient" }],
 *       "patterns": [{ "name": "login-w-sciezce", "regex": "…" }],
 *       "pseudonyms": { "nazwa": "alfa" },
 *       "allow": [{ "path": "plik/w/repo", "literal": "nazwa", "reason": "…" }]
 *     }
 *
 * Dopasowanie `forbidden`: NFKC + małe litery, podłańcuch (łapie odmiany i wielkość liter). `patterns`: wyrażenie
 * z flagami `gimu` na tekście po NFKC (kontekst, np. login tylko w ścieżce). `allow`: trafienia literału w jednym
 * pliku repo nie liczą się (powód obowiązkowy). Błąd podaje NAZWĘ POLA (`forbidden[3]`), nigdy treści: komunikat
 * idzie do terminala, logu testów i raportu bramki.
 *
 * Czysty ESM, wyłącznie `node:*` i sąsiedni `is-main.mjs`: działa przed `pnpm install`. Typy:
 * `private-literals.d.mts`. Uruchomiony wprost (`node scripts/lib/private-literals.mjs`) mówi, czy plik jest:
 * kod 0 — jest i przechodzi schemat, 3 — brak pliku, 2 — plik zepsuty (krok „private literals” w `scripts/check.sh`).
 */
import { lstatSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMainModule } from './is-main.mjs';

export const PRIVATE_LITERALS_ENV = 'RAROG_PRIVATE_LITERALS';
export const REQUIRE_PRIVATE_LITERALS_ENV = 'RAROG_REQUIRE_PRIVATE_LITERALS';
export const PUBLISH_GATE_ENV = 'RAROG_PUBLISH_GATE';
export const SCHEMA_VERSION = 2;
/**
 * Dopisek w tytule `describe` strażnika nazw pominiętego bez pliku literałów (`server/test/private-guard.ts`). Po nim
 * bramka publikacji poznaje w raporcie testów pominięcie z tego jednego powodu.
 */
export const SKIP_REASON = 'no private literals file: test skipped';
/** Najkrótszy literał: krótszy trafiałby w zwykłe słowa i nazwy. */
export const MIN_LITERAL_LENGTH = 3;
const TOP_LEVEL = new Set(['$comment', 'version', 'forbidden', 'patterns', 'pseudonyms', 'allow']);

export class PrivateLiteralsError extends Error {
  /**
   * @param {string} file ścieżka pliku literałów
   * @param {string} field nazwa pola (`forbidden[3]`), nigdy treść
   * @param {string} problem co jest nie tak, bez treści pola
   */
  constructor(file, field, problem) {
    super(`private literals file ${file}: ${field}: ${problem}`);
    this.name = 'PrivateLiteralsError';
    this.file = file;
    this.field = field;
  }
}

/** Ścieżka pliku literałów według środowiska (bez sprawdzania, czy istnieje). */
export function privateLiteralsPath(env = process.env) {
  const explicit = env[PRIVATE_LITERALS_ENV];
  if (typeof explicit === 'string' && explicit !== '') return explicit;
  const home = typeof env.HOME === 'string' && env.HOME !== '' ? env.HOME : os.homedir();
  return path.join(home, '.config', 'rarog', 'private-literals.json');
}

/** `RAROG_REQUIRE_PRIVATE_LITERALS=1`: brak pliku to porażka, nie pominięcie. */
export function privateLiteralsRequired(env = process.env) {
  return env[REQUIRE_PRIVATE_LITERALS_ENV] === '1';
}

/** `RAROG_PUBLISH_GATE=1`: zapadki strażników wymagają zera zamiast liczb z bazy. */
export function publishGate(env = process.env) {
  return env[PUBLISH_GATE_ENV] === '1';
}

/** Postać porównywana: NFKC i małe litery. */
export function normalizeLiteral(text) {
  return text.normalize('NFKC').toLowerCase();
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmptyString = (value) => typeof value === 'string' && value.trim() !== '';

/** Waliduje sparsowany JSON; zwraca postać gotową do dopasowania. */
export function parsePrivateLiterals(data, file = '(file)') {
  const fail = (field, problem) => {
    throw new PrivateLiteralsError(file, field, problem);
  };
  if (!isObject(data)) fail('(root)', 'expected a JSON object');
  Object.keys(data).forEach((key, index) => {
    if (!TOP_LEVEL.has(key)) fail(`(top-level field no. ${String(index + 1)})`, 'unknown field');
  });
  if (data.version !== SCHEMA_VERSION) fail('version', `expected version ${String(SCHEMA_VERSION)}`);

  if (!Array.isArray(data.forbidden) || data.forbidden.length === 0) fail('forbidden', 'expected a non-empty list');
  const forbidden = data.forbidden.map((entry, index) => {
    const field = `forbidden[${String(index)}]`;
    const literal = typeof entry === 'string' ? entry : isObject(entry) ? entry.literal : undefined;
    const category = typeof entry === 'string' ? 'uncategorized' : isObject(entry) ? entry.category : undefined;
    if (isObject(entry) && Object.keys(entry).some((key) => key !== 'literal' && key !== 'category')) {
      fail(field, 'unknown entry field');
    }
    if (typeof literal !== 'string') fail(field, 'expected a string or an object { literal, category }');
    if (!nonEmptyString(category)) fail(`${field}.category`, 'expected a non-empty string');
    const needle = normalizeLiteral(literal);
    if (needle.trim().length < MIN_LITERAL_LENGTH) fail(field, `shorter than ${String(MIN_LITERAL_LENGTH)} characters`);
    return { index, needle, category };
  });
  for (const a of forbidden) {
    for (const b of forbidden) {
      if (a.index >= b.index) continue;
      if (a.needle === b.needle) fail(`forbidden[${String(b.index)}]`, `duplicate of forbidden[${String(a.index)}]`);
      if (a.needle.includes(b.needle) || b.needle.includes(a.needle)) {
        const [outer, inner] = a.needle.includes(b.needle) ? [a, b] : [b, a];
        fail(`forbidden[${String(outer.index)}]`, `contains forbidden[${String(inner.index)}] (a hit would count twice)`);
      }
    }
  }
  /** Czy tekst niesie którykolwiek literał (etykiety, pseudonimy: wypisywane, więc nie mogą zdradzać nazw). */
  const leaks = (text) => forbidden.some((entry) => normalizeLiteral(text).includes(entry.needle));
  for (const entry of forbidden) {
    if (leaks(entry.category)) fail(`forbidden[${String(entry.index)}].category`, 'category contains a forbidden literal');
  }

  const rawPatterns = data.patterns ?? [];
  if (!Array.isArray(rawPatterns)) fail('patterns', 'expected a list');
  const patterns = rawPatterns.map((entry, index) => {
    const field = `patterns[${String(index)}]`;
    if (!isObject(entry) || Object.keys(entry).some((key) => key !== 'name' && key !== 'regex')) {
      fail(field, 'expected an object { name, regex }');
    }
    if (!nonEmptyString(entry.name)) fail(`${field}.name`, 'expected a non-empty string');
    if (leaks(entry.name)) fail(`${field}.name`, 'name contains a forbidden literal');
    if (!nonEmptyString(entry.regex)) fail(`${field}.regex`, 'expected a non-empty string');
    let regex;
    try {
      regex = new RegExp(entry.regex, 'gimu');
    } catch {
      fail(`${field}.regex`, 'the expression does not compile');
    }
    if (new RegExp(entry.regex, 'imu').test('')) fail(`${field}.regex`, 'the expression matches empty text');
    return { index, name: entry.name, regex };
  });

  const rawPseudonyms = data.pseudonyms ?? {};
  if (!isObject(rawPseudonyms)) fail('pseudonyms', 'expected an object { name: placeholder }');
  const pseudonyms = Object.entries(rawPseudonyms).map(([from, to], index) => {
    const field = `pseudonyms[${String(index)}]`;
    const needle = normalizeLiteral(from);
    if (needle.trim().length < MIN_LITERAL_LENGTH) fail(field, `name shorter than ${String(MIN_LITERAL_LENGTH)} characters`);
    if (!nonEmptyString(to)) fail(field, 'expected a non-empty placeholder');
    return { index, from, needle, to };
  });
  for (const a of pseudonyms) {
    for (const b of pseudonyms) {
      if (a.index < b.index && a.needle === b.needle) fail(`pseudonyms[${String(b.index)}]`, `duplicate of pseudonyms[${String(a.index)}]`);
    }
  }
  for (const entry of pseudonyms) {
    const to = normalizeLiteral(entry.to);
    if (leaks(entry.to) || pseudonyms.some((other) => to.includes(other.needle))) {
      fail(`pseudonyms[${String(entry.index)}]`, 'placeholder contains a literal (forbidden or a name from the map)');
    }
  }

  const rawAllow = data.allow ?? [];
  if (!Array.isArray(rawAllow)) fail('allow', 'expected a list');
  const allow = rawAllow.map((entry, index) => {
    const field = `allow[${String(index)}]`;
    if (!isObject(entry) || Object.keys(entry).some((key) => !['path', 'literal', 'reason'].includes(key))) {
      fail(field, 'expected an object { path, literal, reason }');
    }
    if (!nonEmptyString(entry.path) || entry.path.startsWith('/') || entry.path.split('/').includes('..')) {
      fail(`${field}.path`, 'expected a path relative to the repo root');
    }
    if (typeof entry.literal !== 'string') fail(`${field}.literal`, 'expected a string');
    const target = forbidden.find((candidate) => candidate.needle === normalizeLiteral(entry.literal));
    if (target === undefined) fail(`${field}.literal`, 'literal not in forbidden');
    if (!nonEmptyString(entry.reason)) fail(`${field}.reason`, 'expected a reason');
    return { path: entry.path, forbiddenIndex: target.index };
  });

  // Dłuższe nazwy przed krótszymi: „nazwa-api” nie może stracić końcówki na rzecz „nazwa”.
  pseudonyms.sort((a, b) => b.needle.length - a.needle.length || a.index - b.index);
  return { file, version: SCHEMA_VERSION, forbidden, patterns, pseudonyms, allow };
}

/**
 * Plik literałów według środowiska albo jawnej ścieżki: `null`, gdy go nie ma; wyjątek, gdy jest, ale nie da się
 * go użyć (dowiązanie bez celu, brak prawa odczytu, zły JSON, zły schemat).
 */
export function loadPrivateLiterals({ env = process.env, file } = {}) {
  const target = file ?? privateLiteralsPath(env);
  try {
    lstatSync(target);
  } catch (err) {
    if (err !== null && typeof err === 'object' && err.code === 'ENOENT') return null;
    throw new PrivateLiteralsError(target, '(file)', `cannot read (${String(err?.code ?? err)})`);
  }
  try {
    statSync(target);
  } catch (err) {
    throw new PrivateLiteralsError(target, '(file)', `dangling symlink or unreadable target (${String(err?.code ?? err)})`);
  }
  let text;
  try {
    text = readFileSync(target, 'utf8');
  } catch (err) {
    throw new PrivateLiteralsError(target, '(file)', `cannot read (${String(err?.code ?? err)})`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new PrivateLiteralsError(target, '(JSON)', 'the file is not valid JSON');
  }
  return parsePrivateLiterals(data, target);
}

/** Początki linii w tekście (przesunięcia), do zamiany przesunięcia trafienia na numer linii. */
function lineStarts(text) {
  const starts = [0];
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) starts.push(at + 1);
  return starts;
}

function lineOf(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * Trafienia literałów i wzorców w tekście pliku `file` (ścieżka względem korzenia repo; decyduje o `allow`):
 * `{ line, ref, label }`, gdzie `ref` to `forbidden[i]` albo `patterns[i]`, a `label` kategoria albo nazwa wzorca.
 * Nigdy treść literału. Kilka trafień w linii = kilka wpisów.
 */
export function findPrivateHits(text, literals, file = '') {
  const hits = [];
  const allowed = new Set(literals.allow.filter((entry) => entry.path === file).map((entry) => entry.forbiddenIndex));
  const lower = normalizeLiteral(text);
  const lowerStarts = lineStarts(lower);
  for (const entry of literals.forbidden) {
    if (allowed.has(entry.index)) continue;
    for (let at = lower.indexOf(entry.needle); at !== -1; at = lower.indexOf(entry.needle, at + entry.needle.length)) {
      hits.push({ line: lineOf(lowerStarts, at), ref: `forbidden[${String(entry.index)}]`, label: entry.category });
    }
  }
  if (literals.patterns.length > 0) {
    const nfkc = text.normalize('NFKC');
    const nfkcStarts = lineStarts(nfkc);
    for (const entry of literals.patterns) {
      for (const match of nfkc.matchAll(entry.regex)) {
        hits.push({ line: lineOf(nfkcStarts, match.index ?? 0), ref: `patterns[${String(entry.index)}]`, label: entry.name });
      }
    }
  }
  return hits.sort((a, b) => a.line - b.line || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
}

/**
 * Ścieżka do wypisania: gdy niesie literał albo wzorzec, wraca po NFKC i małych literach z każdym trafieniem
 * zastąpionym `‹forbidden[i]›` / `‹patterns[i]›`; inaczej bez zmian. Komunikaty strażników i skanera wypisują
 * ścieżki wyłącznie przez tę funkcję.
 */
export function maskPath(file, literals) {
  let masked = normalizeLiteral(file);
  let changed = false;
  for (const entry of literals.forbidden) {
    if (!masked.includes(entry.needle)) continue;
    masked = masked.split(entry.needle).join(`‹forbidden[${String(entry.index)}]›`);
    changed = true;
  }
  for (const entry of literals.patterns) {
    const next = masked.replace(entry.regex, `‹patterns[${String(entry.index)}]›`);
    if (next !== masked) changed = true;
    masked = next;
  }
  return changed ? masked : file;
}

/** Zamiana nazw z mapy `pseudonyms` na zastępniki (bez wielkości liter, dłuższe nazwy najpierw). */
export function applyPseudonyms(text, pseudonyms) {
  let out = text;
  for (const entry of pseudonyms) {
    out = out.replace(new RegExp(entry.needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu'), entry.to);
  }
  return out;
}

function main() {
  let literals;
  try {
    literals = loadPrivateLiterals();
  } catch (err) {
    process.stderr.write(`private literals: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  if (literals === null) {
    process.stdout.write(`private literals: no file (${privateLiteralsPath()})\n`);
    return 3;
  }
  process.stdout.write(`private literals: ${literals.file} (forbidden ${String(literals.forbidden.length)}, `
    + `patterns ${String(literals.patterns.length)}, pseudonyms ${String(literals.pseudonyms.length)}, `
    + `allow ${String(literals.allow.length)})\n`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main();
}
