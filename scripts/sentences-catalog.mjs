#!/usr/bin/env node
/**
 * Generator katalogu zdań serwera. Czyta rejestr `shared/src/sentences/` i buduje z niego deterministyczny
 * model: każdy kod (emitowany i wycofany) z argumentami i rodzajami, angielskim szablonem i polem `retired`.
 * Z modelu powstają dwa wyjścia w RarogContract: katalog `Copy/Localizable.xcstrings` (klucze `server.<kod>`
 * i `push.<nazwa>`, `en` z rejestru, `pl` żyje w katalogu) i deskryptory argumentów `Copy/SentenceDescriptors.swift`,
 * a osobno manifest opublikowanych kodów `shared/fixtures/sentences/published.json` (`--publish`).
 *
 * Wywołanie:
 *
 *     node scripts/sentences-catalog.mjs                     # model JSON na stdout
 *     node scripts/sentences-catalog.mjs --check             # rejestr, katalog i deskryptory zgodne (kod 1: nie)
 *     node scripts/sentences-catalog.mjs --write [--pl <plik>]  # katalog i deskryptory z rejestru
 *     node scripts/sentences-catalog.mjs --publish           # manifest opublikowanych kodów z rejestru
 *
 * `--write` pisze `en`, komentarz i `extractionState` z rejestru, a `pl` każdego klucza bierze z katalogu, który już
 * jest (ręczna poprawka przeżywa kolejne `--write`); brakujące `pl` uzupełnia z `--pl <plik>` (JSON
 * `{codes: [{code, pl}]}`, `pl` to napis albo `{one, few, many, other}` z `{nazwa}` argumentu). Wynik jest
 * deterministyczny i w stylu Xcode (klucze posortowane, `" : "`), a `--check` porównuje treść po parsowaniu JSON,
 * więc przeformatowanie katalogu przez Xcode go nie czerwieni.
 *
 * `--publish` zapisuje manifest `{format: 1, sentences}` z wpisami modelu (kod, argumenty, `en`, `retired`). Manifest
 * tylko rośnie: kod, który już w nim stoi, a nie ma go ani w `SENTENCES`, ani w `RETIRED`, kończy się kodem 1 bez
 * zapisu (kod się wycofuje przez `RETIRED`, nie znika). Zmieniona definicja kodu, który już stoi w manifeście,
 * przepisuje wpis (rejestr wygrywa), a wyjście wymienia takie kody do przeglądu diffu. Zgodność manifestu
 * z rejestrem pilnuje {@link publishedProblems} (strażnik `server/test/sentences-published.test.ts`); `--check` go
 * nie czyta.
 *
 * Specyfikatory katalogu są zawsze pozycyjne: `%N$@` dla `text`, `code`, `instant`, `%N$lld` dla `int`, `plural`
 * (`N` = pozycja w `ref.args` od 1). Liczba mnoga to podstawienie `%N$#@nazwa@` (`argNum = N`,
 * `formatSpecifier = lld`) z całym zdaniem w wariantach, w których sama liczba to `%arg`. `%` dosłowny to `%%`
 * w zdaniu z argumentami i `%` w zdaniu bez nich (bez argumentów apka nie formatuje).
 *
 * Rejestr jest w TypeScripcie, więc `main` rejestruje tsx (`tsx/esm/api`, zależność korzenia repo) z `tsconfig.json`
 * korzenia, jak `bin/rarog.mjs` w klonie repo. Funkcje modelu, katalogu i deskryptorów są czyste (test podaje własny
 * rejestr), a `main` przyjmuje korzeń i rejestr w opcjach. Kody wyjścia: 0 zrobione, 1 rejestr, katalog, `--pl`
 * albo manifest niespójne, 2 zły argument. Typy: `sentences-catalog.d.mts`.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './lib/is-main.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FLAGS = new Set(['--write', '--check', '--publish']);
const USAGE = 'sentences-catalog: usage: sentences-catalog.mjs [--write [--pl <file>] | --check | --publish]\n';

/** Katalog zdań serwera w RarogContract (względem korzenia repo). */
export const CATALOG_PATH = 'native/Rarog/Packages/RarogContract/Sources/RarogContract/Copy/Localizable.xcstrings';
/** Deskryptory argumentów w RarogContract (plik generowany). */
export const DESCRIPTORS_PATH = 'native/Rarog/Packages/RarogContract/Sources/RarogContract/Copy/SentenceDescriptors.swift';
/** Manifest opublikowanych kodów (względem korzenia repo). */
export const PUBLISHED_PATH = 'shared/fixtures/sentences/published.json';
/** Wersja formatu manifestu. */
export const PUBLISHED_FORMAT = 1;

/** Kategorie liczby mnogiej `pl` w katalogu (CLDR; `other` to ułamki). */
export const PL_PLURAL = ['one', 'few', 'many', 'other'];
const EN_PLURAL = ['one', 'other'];

/** Porównanie po punktach kodowych, niezależne od locale procesu. */
const byCodePoint = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byCode = (a, b) => byCodePoint(a.code, b.code);

/** Jedna pozycja modelu; kolejność kluczy stała, żeby wyjście JSON było deterministyczne. */
function entry(code, def, retired) {
  const args = (def.args ?? []).map((spec) => {
    const at = spec.indexOf(':');
    return { name: spec.slice(0, at), kind: spec.slice(at + 1) };
  });
  const en = typeof def.en === 'string' ? def.en : { one: def.en.one, other: def.en.other };
  return { code, args, en, retired };
}

/**
 * Model rejestru: pozycje `SENTENCES` (`retired: null`) i `RETIRED` (`retired: <since>`), posortowane po kodzie.
 * @param {{ SENTENCES: Readonly<Record<string, object>>, RETIRED: Readonly<Record<string, object>> }} registry
 */
export function buildModel({ SENTENCES, RETIRED }) {
  const sentences = [
    ...Object.entries(SENTENCES).map(([code, def]) => entry(code, def, null)),
    ...Object.entries(RETIRED).map(([code, def]) => entry(code, def, def.since)),
  ].sort(byCode);
  return { sentences };
}

/** Model (albo manifest `--publish`) jako tekst pliku: JSON z wcięciem 2 i końcowym znakiem nowej linii. */
export function formatModel(model) {
  return `${JSON.stringify(model, null, 2)}\n`;
}

// ── Katalog ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Klucz katalogu kodu: obszar `push` to sam kod (klucze `loc-key` pusha), każdy inny `server.<kod>`. */
export function catalogKey(code) {
  return code.startsWith('push.') ? code : `server.${code}`;
}

/** Specyfikator rodzaju argumentu: liczby `lld`, reszta `@`. */
const specifierOf = (kind) => (kind === 'int' || kind === 'plural' ? 'lld' : '@');

const PLACEHOLDER = /\{([a-z][a-zA-Z0-9]*)\}/gu;

/**
 * Szablon z `{nazwa}` jako wartość katalogu. `pluralName`: argument, który w wariancie podstawienia jest `%arg`.
 * Zwraca `{ value, unknown }`; `unknown` to nazwy spoza `args` (zostają w wartości dosłownie).
 */
function templateValue(template, args, pluralName) {
  const unknown = [];
  const escaped = args.length > 0 ? template.replaceAll('%', '%%') : template;
  const value = escaped.replace(PLACEHOLDER, (match, name) => {
    if (name === pluralName) return '%arg';
    const at = args.findIndex((arg) => arg.name === name);
    if (at < 0) {
      unknown.push(name);
      return match;
    }
    return `%${String(at + 1)}$${specifierOf(args[at].kind)}`;
  });
  return { value, unknown };
}

const unit = (value) => ({ stringUnit: { state: 'translated', value } });

/**
 * Lokalizacja jednego języka: zdanie (`template` napis) albo podstawienie liczby mnogiej (`template` z wariantami).
 * Zwraca `{ localization, problems }`; problemy to nieznane `{nazwa}` i niezgodność kształtu z argumentami.
 */
export function localizationOf(sentence, template, categories) {
  const { args } = sentence;
  const plural = args.findIndex((arg) => arg.kind === 'plural');
  const problems = [];
  const values = (text, pluralName) => {
    const { value, unknown } = templateValue(text, args, pluralName);
    for (const name of unknown) problems.push(`unknown placeholder {${name}}`);
    return value;
  };
  if (plural < 0) {
    if (typeof template !== 'string') problems.push('plural variants for a sentence without a plural argument');
    return { localization: unit(values(typeof template === 'string' ? template : String(template?.other ?? ''))), problems };
  }
  if (typeof template !== 'object' || template === null) {
    problems.push(`a plural sentence needs variants ${categories.join(', ')}`);
    return { localization: unit(String(template)), problems };
  }
  const missing = categories.filter((category) => typeof template[category] !== 'string');
  const extra = Object.keys(template).filter((category) => !categories.includes(category));
  if (missing.length > 0) problems.push(`plural is missing variants ${missing.join(', ')}`);
  if (extra.length > 0) problems.push(`plural has unknown variants ${extra.join(', ')}`);
  const { name } = args[plural];
  const variants = Object.fromEntries(categories.filter((category) => typeof template[category] === 'string')
    .map((category) => [category, unit(values(template[category], name))]));
  return {
    localization: {
      ...unit(`%${String(plural + 1)}$#@${name}@`),
      substitutions: { [name]: { argNum: plural + 1, formatSpecifier: 'lld', variations: { plural: variants } } },
    },
    problems,
  };
}

/**
 * Komentarz tłumacza (po angielsku, jak każdy tekst skryptu): obszar, kod, argumenty z rodzajami w kolejności
 * `ref.args`, wycofanie.
 */
export function commentOf(sentence) {
  const area = sentence.code.slice(0, sentence.code.indexOf('.'));
  const args = sentence.args.length === 0
    ? 'No arguments.'
    : `Arguments: ${sentence.args.map((arg, i) => `${String(i + 1)}. ${arg.name} (${arg.kind})`).join(', ')}.`;
  const retired = sentence.retired === null ? '' : ` Retired since ${sentence.retired}.`;
  return `Server sentence, area ${area}, code ${sentence.code}. ${args}${retired}`;
}

/**
 * `pl` z pliku `--pl` (kształt `l3/kody.json`: `{codes: [{code, pl}]}`) jako mapa kod → `pl`.
 * @param {unknown} json
 */
export function plSource(json) {
  const codes = typeof json === 'object' && json !== null && Array.isArray(json.codes) ? json.codes : null;
  if (codes === null) throw new Error('--pl: expected {codes: [{code, pl}]}');
  const out = new Map();
  for (const item of codes) {
    if (typeof item?.code === 'string' && item.pl !== undefined && item.pl !== null) out.set(item.code, item.pl);
  }
  return out;
}

/**
 * Katalog z modelu. `previous`: katalog, który już jest (z niego zostaje `pl` każdego klucza); `pl`: mapa kod →
 * `pl` z {@link plSource} dla kluczy bez `pl`. Zwraca `{ catalog, problems }`; problemy to błędy wsadu `pl`
 * (nieznane `{nazwa}`, zły kształt liczby mnogiej) i klucze bez `pl`.
 */
export function buildCatalog(model, { previous = null, pl = new Map() } = {}) {
  const problems = [];
  const strings = {};
  for (const sentence of model.sentences) {
    const key = catalogKey(sentence.code);
    const en = localizationOf(sentence, sentence.en, EN_PLURAL);
    for (const problem of en.problems) problems.push(`${sentence.code} [en]: ${problem}`);
    const localizations = { en: en.localization };
    const kept = previous?.strings?.[key]?.localizations?.pl;
    if (kept !== undefined) localizations.pl = kept;
    else if (pl.has(sentence.code)) {
      const made = localizationOf(sentence, pl.get(sentence.code), PL_PLURAL);
      for (const problem of made.problems) problems.push(`${sentence.code} [pl from --pl]: ${problem}`);
      localizations.pl = made.localization;
    } else problems.push(`${sentence.code}: no pl (add it in the catalog or pass --pl)`);
    strings[key] = { comment: commentOf(sentence), extractionState: 'manual', localizations };
  }
  return { catalog: { sourceLanguage: 'en', strings, version: '1.0' }, problems };
}

/** JSON w stylu Xcode: klucze posortowane, wcięcie 2, `" : "`, końcowy znak nowej linii. */
export function formatCatalog(catalog) {
  const write = (value, indent) => {
    if (Array.isArray(value)) {
      if (value.length === 0) return '[]';
      const inner = value.map((item) => `${indent}  ${write(item, `${indent}  `)}`);
      return `[\n${inner.join(',\n')}\n${indent}]`;
    }
    if (typeof value === 'object' && value !== null) {
      const keys = Object.keys(value).sort(byCodePoint);
      if (keys.length === 0) return '{\n\n}';
      const inner = keys.map((key) => `${indent}  ${JSON.stringify(key)} : ${write(value[key], `${indent}  `)}`);
      return `{\n${inner.join(',\n')}\n${indent}}`;
    }
    return JSON.stringify(value);
  };
  return `${write(catalog, '')}\n`;
}

// ── Deskryptory ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Tekst `SentenceDescriptors.swift`: rodzaje argumentów i `retired` każdego kodu, posortowane po kodzie. */
export function buildDescriptors(model) {
  const rows = model.sentences.map((sentence) => {
    const args = sentence.args.map((arg) => `.${arg.kind}`).join(', ');
    return `    ${JSON.stringify(sentence.code)}: SentenceDescriptor(args: [${args}], retired: ${String(sentence.retired !== null)}),`;
  });
  return [
    '// Generated by scripts/sentences-catalog.mjs --write. Do not edit by hand.',
    'public enum SentenceArgKind: String, Sendable, CaseIterable { case int, text, code, instant, plural }',
    'public struct SentenceDescriptor: Sendable, Equatable {',
    '  public let args: [SentenceArgKind]',
    '  public let retired: Bool',
    '}',
    'public enum SentenceDescriptors {',
    ...(rows.length === 0
      ? ['  public static let table: [String: SentenceDescriptor] = [:]']
      : ['  public static let table: [String: SentenceDescriptor] = [', ...rows, '  ]']),
    '}',
    '',
  ].join('\n');
}

// ── Sprawdzenie ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Ten sam JSON bez względu na kolejność kluczy obiektów. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.keys(value).sort(byCodePoint).map((key) => [key, canonical(value[key])]));
  }
  return value;
}
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** Specyfikatory i `%` w wartości katalogu: `%%`, `%arg`, `%N$#@nazwa@`, `%N$@`, `%N$lld`; reszta to `bare`. */
const TOKEN = /%%|%arg|%(\d+)\$#@([A-Za-z0-9_]+)@|%(\d+)\$(@|lld)|%/gu;

function tokens(value) {
  const out = { percent: 0, ownArg: 0, substitutions: [], params: [], bare: 0 };
  for (const m of value.matchAll(TOKEN)) {
    if (m[0] === '%%') out.percent++;
    else if (m[0] === '%arg') out.ownArg++;
    else if (m[1] !== undefined) out.substitutions.push({ position: Number(m[1]), name: m[2] });
    else if (m[3] !== undefined) out.params.push({ position: Number(m[3]), type: m[4] });
    else out.bare++;
  }
  return out;
}

/**
 * Problemy `pl` jednego klucza wobec argumentów zdania: obecność i stan, kształt liczby mnogiej (podstawienie
 * z `argNum` i kategoriami `pl`), specyfikator każdej pozycji zgodny z rodzajem, każdy argument poza liczbą mnogą
 * użyty, `%` według reguły, brak `{nazwa}` z wsadu.
 */
export function plProblems(sentence, pl) {
  const where = `${catalogKey(sentence.code)} [pl]`;
  if (pl === undefined) return [`${where}: no value`];
  const problems = [];
  const { args } = sentence;
  const plural = args.findIndex((arg) => arg.kind === 'plural');
  // Pozycje użyte w części wspólnej wzorca (albo w całym zdaniu bez liczby mnogiej) i osobno w każdym wariancie:
  // argument poza liczbą mnogą ma stać we wspólnej części albo w KAŻDYM wariancie, jak w regule rejestru.
  const used = new Set();
  const usedInVariant = new Map();
  const scan = (unitNode, place, inVariant, into = used) => {
    const value = unitNode?.stringUnit?.value;
    if (unitNode?.stringUnit?.state !== 'translated' || typeof value !== 'string' || value === '') {
      problems.push(`${place}: no translated value`);
      return;
    }
    const found = tokens(value);
    for (const leftover of value.matchAll(PLACEHOLDER)) problems.push(`${place}: placeholder {${leftover[1]}} left in`);
    if (args.length > 0 && found.bare > 0) problems.push(`${place}: bare "%" in a sentence with arguments (write "%%")`);
    if (args.length === 0 && found.percent > 0) problems.push(`${place}: "%%" in a sentence without arguments (write "%")`);
    if (!inVariant && found.ownArg > 0) problems.push(`${place}: %arg outside a plural variant`);
    for (const param of found.params) {
      const arg = args[param.position - 1];
      if (arg === undefined) problems.push(`${place}: %${String(param.position)}$ has no argument`);
      else if (arg.kind === 'plural') problems.push(`${place}: the plural argument stands as %arg or a substitution`);
      else if (param.type !== specifierOf(arg.kind)) {
        problems.push(`${place}: %${String(param.position)}$${param.type} for ${arg.name} (${arg.kind}) — expected `
          + `%${String(param.position)}$${specifierOf(arg.kind)}`);
      } else into.add(param.position);
    }
    return found;
  };
  if (plural < 0) {
    if (pl.substitutions !== undefined) problems.push(`${where}: substitution in a sentence without a plural argument`);
    const found = scan(pl, where, false);
    if (found !== undefined && found.substitutions.length > 0) problems.push(`${where}: substitution without a plural argument`);
  } else {
    const { name } = args[plural];
    const found = scan(pl, where, false);
    const head = found?.substitutions ?? [];
    if (head.length !== 1 || head[0].name !== name || head[0].position !== plural + 1) {
      problems.push(`${where}: the sentence must be %${String(plural + 1)}$#@${name}@`);
    }
    const substitution = pl.substitutions?.[name];
    if (substitution?.argNum !== plural + 1 || substitution?.formatSpecifier !== 'lld') {
      problems.push(`${where}: substitution ${name} needs argNum ${String(plural + 1)} and formatSpecifier lld`);
    }
    const variants = substitution?.variations?.plural ?? {};
    const missing = PL_PLURAL.filter((category) => variants[category] === undefined);
    if (missing.length > 0) problems.push(`${where}: plural is missing variants ${missing.join(', ')}`);
    for (const [category, variant] of Object.entries(variants)) {
      const into = new Set();
      usedInVariant.set(category, into);
      scan(variant, `${where} plural.${category}`, true, into);
    }
  }
  args.forEach((arg, i) => {
    const position = i + 1;
    if (arg.kind === 'plural' || used.has(position)) return;
    const without = [...usedInVariant].filter(([, into]) => !into.has(position)).map(([category]) => category);
    if (usedInVariant.size > 0 && without.length === 0) return;
    if (usedInVariant.size === 0 || without.length === usedInVariant.size) {
      problems.push(`${where}: argument ${String(position)} (${arg.name}) is not used`);
    } else {
      problems.push(`${where}: argument ${String(position)} (${arg.name}) is missing from plural variants `
        + without.join(', '));
    }
  });
  return problems;
}

/**
 * Zgodność katalogu i deskryptorów z modelem (`--check`): każdy kod ma klucz, klucz bez kodu to sierota, `en`,
 * komentarz i `extractionState` równe wyjściu generatora, `pl` obecne i zgodne z rodzajami ({@link plProblems}),
 * deskryptory równe {@link buildDescriptors}. `catalog`/`descriptors` `null` = pliku nie ma.
 */
export function outputProblems(model, { catalog, descriptors }) {
  const problems = [];
  if (catalog === null) problems.push(`${CATALOG_PATH}: missing (run --write)`);
  else {
    if (catalog.sourceLanguage !== 'en') problems.push(`${CATALOG_PATH}: sourceLanguage must be en`);
    const expected = buildCatalog(model).catalog.strings;
    const strings = catalog.strings ?? {};
    for (const key of Object.keys(strings).sort(byCodePoint)) {
      if (!Object.hasOwn(expected, key)) problems.push(`${key}: key without a code in the registry`);
    }
    for (const sentence of model.sentences) {
      const key = catalogKey(sentence.code);
      const have = strings[key];
      if (have === undefined) {
        problems.push(`${key}: missing from the catalog (run --write)`);
        continue;
      }
      const want = expected[key];
      if (!same(have.localizations?.en, want.localizations.en)) problems.push(`${key} [en]: differs from the registry`);
      if (have.comment !== want.comment || have.extractionState !== want.extractionState) {
        problems.push(`${key}: comment or extractionState differs from the generator`);
      }
      const others = Object.keys(have.localizations ?? {}).filter((language) => language !== 'en' && language !== 'pl');
      if (others.length > 0) problems.push(`${key}: languages beyond en and pl: ${others.join(', ')}`);
      problems.push(...plProblems(sentence, have.localizations?.pl));
    }
  }
  if (descriptors === null) problems.push(`${DESCRIPTORS_PATH}: missing (run --write)`);
  else if (descriptors !== buildDescriptors(model)) problems.push(`${DESCRIPTORS_PATH}: differs from the registry (run --write)`);
  return problems;
}

// ── Manifest publikacji ─────────────────────────────────────────────────────────────────────────────────────────

const isArgs = (args) => Array.isArray(args)
  && args.every((arg) => typeof arg?.name === 'string' && typeof arg?.kind === 'string');
const isEn = (en) => typeof en === 'string'
  || (typeof en === 'object' && en !== null && typeof en.one === 'string' && typeof en.other === 'string');
const isEntry = (one) => typeof one?.code === 'string' && isArgs(one.args) && isEn(one.en)
  && (one.retired === null || typeof one.retired === 'string');
const argsText = (args) => args.map((arg) => `${arg.name}:${arg.kind}`).join(', ') || 'none';

/** Kształt manifestu: format, tablica wpisów modelu, porządek kodów bez powtórzeń. */
function manifestShapeProblems(published) {
  if (typeof published !== 'object' || published === null || !Array.isArray(published.sentences)) {
    return ['expected {format, sentences: [...]}'];
  }
  const problems = [];
  if (published.format !== PUBLISHED_FORMAT) problems.push(`format must be ${String(PUBLISHED_FORMAT)}`);
  published.sentences.forEach((one, i) => {
    if (!isEntry(one)) {
      const code = typeof one?.code === 'string' ? ` (${one.code})` : '';
      problems.push(`sentences[${String(i)}]${code}: not a model entry {code, args: [{name, kind}], en, retired}`);
    }
  });
  const codes = published.sentences.map((one) => String(one?.code));
  if (codes.some((code, i) => i > 0 && byCodePoint(codes[i - 1], code) >= 0)) {
    problems.push('sentences are not sorted by code or repeat a code');
  }
  return problems;
}

/**
 * Zgodność manifestu z modelem rejestru (strażnik publikacji): kształt manifestu, a każdy wpis stoi w `SENTENCES`
 * albo `RETIRED` z tymi samymi argumentami (nazwa, rodzaj, kolejność) i tym samym `en`. `retired` wpisu może się
 * różnić (kod wycofany po publikacji zostaje tym samym zdaniem); kod rejestru spoza manifestu to kod jeszcze
 * nieopublikowany, nie błąd.
 */
export function publishedProblems(model, published) {
  const problems = manifestShapeProblems(published);
  if (problems.length > 0) return problems;
  const byCodeOf = new Map(model.sentences.map((one) => [one.code, one]));
  for (const one of published.sentences) {
    const have = byCodeOf.get(one.code);
    if (have === undefined) {
      problems.push(`${one.code}: published, but neither in SENTENCES nor in RETIRED`);
      continue;
    }
    if (!same(one.args, have.args)) {
      problems.push(`${one.code}: arguments differ from the registry (published ${argsText(one.args)}; `
        + `registry ${argsText(have.args)})`);
    }
    if (!same(one.en, have.en)) problems.push(`${one.code}: en differs from the registry`);
  }
  return problems;
}

/**
 * Manifest `--publish`: wszystkie wpisy modelu. `previous` (manifest, który już jest, albo `null`) musi mieć dobry
 * kształt i każdy jego kod w modelu; inaczej `problems` i brak manifestu. `added`/`changed`: kody nowe i kody, których
 * wpis się zmienił (w tym `retired`).
 */
export function publishManifest(model, previous) {
  if (previous !== null) {
    const shape = manifestShapeProblems(previous);
    if (shape.length > 0) return { manifest: null, problems: shape, added: [], changed: [] };
  }
  const before = new Map((previous?.sentences ?? []).map((one) => [one.code, one]));
  const codes = new Set(model.sentences.map((one) => one.code));
  const problems = [...before.keys()].filter((code) => !codes.has(code))
    .map((code) => `${code}: published, but neither in SENTENCES nor in RETIRED`);
  if (problems.length > 0) return { manifest: null, problems, added: [], changed: [] };
  const added = model.sentences.filter((one) => !before.has(one.code)).map((one) => one.code);
  const changed = model.sentences.filter((one) => before.has(one.code) && !same(before.get(one.code), one))
    .map((one) => one.code);
  return { manifest: { format: PUBLISHED_FORMAT, sentences: model.sentences }, problems: [], added, changed };
}

// ── Komenda ─────────────────────────────────────────────────────────────────────────────────────────────────────

async function loadRegistry() {
  const { register } = await import('tsx/esm/api');
  register({ tsconfig: path.join(ROOT, 'tsconfig.json') });
  return import('../shared/src/sentences/index.ts');
}

/** Argumenty: jedna flaga i `--pl <plik>` tylko przy `--write`; `null` = zły argument. */
function parseArgv(argv) {
  const flags = [];
  let pl = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (FLAGS.has(arg)) flags.push(arg);
    else if (arg === '--pl' && pl === null && i + 1 < argv.length) pl = argv[++i];
    else return null;
  }
  if (flags.length > 1 || (pl !== null && flags[0] !== '--write')) return null;
  return { flag: flags[0], pl };
}

const readText = (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null);

/**
 * @param {string[]} argv
 * @param {{ root?: string, registry?: object, out?: NodeJS.WritableStream, err?: NodeJS.WritableStream }} [options]
 */
export async function main(argv, { root = ROOT, registry: given, out = process.stdout, err = process.stderr } = {}) {
  const parsed = parseArgv(argv);
  if (parsed === null) {
    err.write(USAGE);
    return 2;
  }
  const registry = given ?? await loadRegistry();
  const problems = registry.registryProblems(registry.SENTENCES, registry.RETIRED);
  if (problems.length > 0) {
    err.write(`sentences-catalog: registry has ${String(problems.length)} problems:\n`);
    for (const problem of problems) err.write(`  ${problem}\n`);
    return 1;
  }
  const model = buildModel(registry);
  const report = (what, list) => {
    err.write(`sentences-catalog: ${what} (${String(list.length)}):\n`);
    for (const problem of list) err.write(`  ${problem}\n`);
  };
  const catalogFile = path.join(root, CATALOG_PATH);
  const descriptorsFile = path.join(root, DESCRIPTORS_PATH);
  const { flag } = parsed;
  if (flag === undefined) {
    out.write(formatModel(model));
    return 0;
  }
  if (flag === '--check') {
    const retired = model.sentences.filter((one) => one.retired !== null).length;
    const counts = `${String(model.sentences.length - retired)} sentences, ${String(retired)} retired`;
    const text = readText(catalogFile);
    let catalog = null;
    if (text !== null) {
      try {
        catalog = JSON.parse(text);
      } catch (error) {
        report('catalog is not JSON', [String(error)]);
        return 1;
      }
    }
    const found = outputProblems(model, { catalog, descriptors: readText(descriptorsFile) });
    if (found.length > 0) {
      report(`registry ok (${counts}); catalog or descriptors differ`, found);
      return 1;
    }
    out.write(`sentences-catalog: registry ok (${counts}); catalog and descriptors match\n`);
    return 0;
  }
  if (flag === '--write') {
    const previousText = readText(catalogFile);
    let pl = new Map();
    if (parsed.pl !== null) {
      try {
        pl = plSource(JSON.parse(readFileSync(path.resolve(parsed.pl), 'utf8')));
      } catch (error) {
        report('--pl is not readable', [String(error instanceof Error ? error.message : error)]);
        return 1;
      }
    }
    let previous = null;
    try {
      previous = previousText === null ? null : JSON.parse(previousText);
    } catch (error) {
      report('nothing written, the catalog is not JSON', [String(error)]);
      return 1;
    }
    const built = buildCatalog(model, { previous, pl });
    const input = built.problems.filter((problem) => problem.includes('[pl from --pl]') || problem.includes('[en]'));
    if (input.length > 0) {
      report('nothing written, the input has problems', input);
      return 1;
    }
    writeFileSync(catalogFile, formatCatalog(built.catalog));
    writeFileSync(descriptorsFile, buildDescriptors(model));
    const missing = outputProblems(model, { catalog: built.catalog, descriptors: buildDescriptors(model) });
    if (missing.length > 0) {
      report('written, but the catalog is not complete', missing);
      return 1;
    }
    out.write(`sentences-catalog: wrote ${String(model.sentences.length)} keys to ${CATALOG_PATH} and ${DESCRIPTORS_PATH}\n`);
    return 0;
  }
  const publishedFile = path.join(root, PUBLISHED_PATH);
  const previousText = readText(publishedFile);
  let previous = null;
  try {
    previous = previousText === null ? null : JSON.parse(previousText);
  } catch (error) {
    report(`nothing written, ${PUBLISHED_PATH} is not JSON`, [String(error)]);
    return 1;
  }
  const published = publishManifest(model, previous);
  if (published.manifest === null) {
    report(`nothing written, ${PUBLISHED_PATH} does not fit the registry`, published.problems);
    return 1;
  }
  // Zapis przez plik obok i `rename`: przerwany zapis (np. brak miejsca) zostawia poprzedni manifest nietknięty.
  mkdirSync(path.dirname(publishedFile), { recursive: true });
  const partial = `${publishedFile}.${String(process.pid)}.tmp`;
  try {
    writeFileSync(partial, formatModel(published.manifest));
    renameSync(partial, publishedFile);
  } catch (error) {
    rmSync(partial, { force: true });
    report(`nothing written, ${PUBLISHED_PATH} could not be replaced`, [String(error)]);
    return 1;
  }
  out.write(`sentences-catalog: published ${String(model.sentences.length)} codes to ${PUBLISHED_PATH} `
    + `(${String(published.added.length)} new, ${String(published.changed.length)} changed)\n`);
  for (const code of published.changed) out.write(`  changed: ${code}\n`);
  return 0;
}

if (isMainModule(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
