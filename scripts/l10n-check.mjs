#!/usr/bin/env node
// Strażnik katalogów copy apki natywnej (`docs/localization.md`, „Guards”): `pnpm run check` i
// `node scripts/l10n-check.mjs`. Bez zależności — czyta JSON katalogów (`*.xcstrings`) i źródła Swift.
//
// Sprawdza:
// 1. każdy klucz ma wartość w każdym WYMAGANYM języku, w stanie `translated` i niepustą (także każdy wariant
//    liczby mnogiej i każde podstawienie);
// 2. liczba mnoga ma komplet kategorii języka (polski: one, few, many, other; angielski: one, other; inny język —
//    co najmniej other);
// 3. parametry zdania zgadzają się między językami: liczba, typy, pozycje (`%1$@`), liczba znaków `%%`;
//    w zdaniu bez parametrów `%%` byłoby widać dosłownie (bez parametrów `L` nie formatuje);
// 4. klucz użyty w kodzie (`L("…")`) istnieje w katalogu pakietu, a klucz jest literałem;
// 5. każdy klucz katalogu pakietu ma choć jedno `L("…")` w źródłach pakietu (brak = martwy tekst);
// 6. katalog `Info.plist` apki (`InfoPlist.xcstrings`, teksty zgód): reguły 1–3, każdy klucz
//    `NS…UsageDescription` z `Info.plist` apki jest w katalogu i odwrotnie, a wartość `en` katalogu = tekst w `Info.plist`
//    (angielskie źródło stoi w obu miejscach);
// 7. `CFBundleLocalizations` w `Info.plist` apki, widżetu i NSE = wymagane języki: tym kluczem każdy z trzech procesów
//    deklaruje języki, które ma (bez niego iOS wybiera `CFBundleDevelopmentRegion`, `docs/localization.md`);
// 8. katalog zdań serwera w RarogContract (`Copy/Localizable.xcstrings`): reguły 1–3 i każdy klucz z prefiksem
//    `server.` albo `push.`, bez reguł 4 i 5 — katalog powstaje z rejestru serwera (`scripts/sentences-catalog.mjs`),
//    a jego klucze czyta tłumacz zdań po kodzie, nie `L("…")`; zgodność z rejestrem pilnuje lustro
//    `shared/test/sentences-catalog-lustro.test.ts`;
// 9. katalogi `loc-key` pusha w głównym celu apki i w widżecie (`Rarog/Localizable.xcstrings`,
//    `RarogWidgets/Localizable.xcstrings`): reguły 1–3, dokładnie klucze z {@link LOC_KEYS} i wartości każdego
//    wymaganego języka równe katalogowi zdań serwera. iOS szuka tekstu `loc-key` z ładunku APNs (tekst zastępczy
//    banera, dzwonek kafla) w głównym katalogu celu, nie w zasobach pakietu RarogContract.
//
// Czego NIE sprawdza: czy tłumaczenie jest dobre, czy mieści się na ekranie, ani czy tekst złożony w modelu ze
// zmiennych w ogóle trafił do katalogu (to strażnik literałów `server/test/native-copy-guard.test.ts` i przebieg
// z `-NSShowNonLocalizedStrings YES`).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './lib/is-main.mjs';

/** Języki, które KAŻDY klucz musi mieć: angielski (źródło i zapas) i polski. */
export const REQUIRED_LANGUAGES = ['en', 'pl'];
/** Język źródłowy katalogów (`sourceLanguage`), ten sam co `defaultLocalization` pakietów i `developmentRegion`. */
export const SOURCE_LANGUAGE = 'en';
/** Kategorie liczby mnogiej (CLDR) dla języków, które znamy; inny język musi mieć co najmniej `other`. */
export const PLURAL_CATEGORIES = { pl: ['one', 'few', 'many', 'other'], en: ['one', 'other'] };

// ── Lekser literałów Swift ──────────────────────────────────────────────────────────────────────────────────────

/** Znaki, po których `=` nie jest przypisaniem (`==`, `!=`, `<=`, `>=`, `+=`, …) — złożone przypisanie też nie. */
const NOT_ASSIGNMENT_BEFORE = new Set(['=', '!', '<', '>', '+', '-', '*', '/', '%', '&', '|', '^', '~']);
/** Linia kończąca się tym ciągnie wyrażenie w następną linię; linia zaczynająca się tym — kontynuuje poprzednią. */
const CONTINUES_AFTER = /(?:=|\?|:|\?\?|\+|-|\(|,|&&|\|\|)\s*$/;
const CONTINUES_BEFORE = /^[?:+.&|]/;

/**
 * Literały łańcuchowe pliku Swift: `{ line, start, end, text, calls, label, assigned }`. `text` ma interpolację jako
 * `\u0000`, `calls` to stos otwartych wywołań (nazwy funkcji, od zewnętrznej; `\(` = interpolacja), `label` —
 * etykieta argumentu, w którym literał stoi (`title:` w `UIKeyCommand(title: x ? "a" : "b")`), `assigned` —
 * właściwość, do której idzie całe wyrażenie przypisania z literałem na tym samym poziomie nawiasów
 * (`view.text = flag ? "a" : "b"`, także przez kolejne linie). Komentarze (liniowe i blokowe, także zagnieżdżone)
 * są pomijane; łańcuchy surowe (`#"…"#`, ze znakami ucieczki `\#"`) i wieloliniowe (`"""`) są rozpoznawane;
 * literałów wyrażeń regularnych `/…/` lekser nie zna (cudzysłów w nich zmyliłby go). `masked` to źródło tej samej
 * długości z komentarzami jako spacje i treścią literałów jako `x` (kod interpolacji zostaje) — do wyszukiwania
 * wzorców w samym kodzie.
 */
export function swiftStringLiterals(source) {
  const literals = [];
  const stack = [];
  const masked = source.split('');
  const n = source.length;
  let i = 0;
  let line = 1;
  let lineCode = '';
  // Przypisania w toku, od zewnętrznego: `{ target, depth }` (głębokość nawiasów przy `=`). Wewnętrzne (w domknięciu,
  // w argumencie) zdejmuje się bez gubienia zewnętrznego.
  let assignments = [];
  const current = () => assignments.at(-1) ?? null;
  const peek = (k = 0) => source[i + k];
  const startsWith = (s) => source.startsWith(s, i);
  const mask = (from, to, ch) => {
    for (let k = from; k < to; k++) if (source[k] !== '\n') masked[k] = ch;
  };
  function advance() {
    const ch = source[i++];
    if (ch === '\n') {
      line += 1;
      lineCode = '';
    }
    return ch;
  }
  function skipLineComment() {
    const from = i;
    while (i < n && peek() !== '\n') i++;
    mask(from, i, ' ');
  }
  function skipBlockComment() {
    const from = i;
    let depth = 0;
    while (i < n) {
      if (startsWith('/*')) {
        depth++;
        i += 2;
        continue;
      }
      if (startsWith('*/')) {
        depth--;
        i += 2;
        if (depth === 0) break;
        continue;
      }
      advance();
    }
    mask(from, i, ' ');
  }
  function argumentLabel() {
    const frame = stack.at(-1);
    if (!frame) return null;
    return /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:(?!:)/.exec(frame.arg)?.[1] ?? null;
  }
  /** Koniec linii: przypisanie trwa w otwartym nawiasie i gdy wyrażenie ciągnie się w następną linię. */
  function endOfLine() {
    const top = current();
    if (!top || stack.length > top.depth) return;
    if (CONTINUES_AFTER.test(lineCode)) return;
    let k = i + 1;
    while (k < n && /\s/.test(source[k])) k++;
    if (CONTINUES_BEFORE.test(source.slice(k, k + 1))) return;
    assignments.pop();
  }
  /** Właściwość, do której idzie literał: przypisanie w toku, a między nim a literałem tylko nawiasy grupujące. */
  function assignedTarget() {
    const top = current();
    if (!top || stack.length < top.depth) return null;
    return stack.slice(top.depth).every((frame) => frame.callee === null) ? top.target : null;
  }
  function readString(hashes, start) {
    const record = {
      line,
      start,
      end: start,
      text: '',
      calls: stack.map((frame) => frame.callee),
      label: argumentLabel(),
      assigned: assignedTarget(),
    };
    literals.push(record);
    i += hashes;
    const multi = startsWith('"""');
    i += multi ? 3 : 1;
    const close = (multi ? '"""' : '"') + '#'.repeat(hashes);
    const escape = '\\' + '#'.repeat(hashes);
    const interpolation = `${escape}(`;
    let text = '';
    let from = i;
    while (i < n) {
      if (startsWith(close)) {
        mask(from, i, 'x');
        i += close.length;
        break;
      }
      if (!multi && peek() === '\n') {
        mask(from, i, 'x');
        break;
      }
      if (startsWith(interpolation)) {
        mask(from, i, 'x');
        i += interpolation.length;
        text += '\u0000';
        const saved = { lineCode, assignments };
        lineCode = '';
        assignments = [];
        stack.push({ callee: '\\(', arg: '' });
        readCode(true);
        ({ lineCode, assignments } = saved);
        from = i;
        continue;
      }
      // Znak ucieczki: w zwykłym łańcuchu `\x`, w surowym `\#x` (z tyloma `#`, ile ma ogranicznik).
      if (startsWith(escape)) {
        const width = escape.length + 1;
        text += source.slice(i, i + width);
        i += width;
        continue;
      }
      text += advance();
    }
    record.text = text;
    record.end = i;
  }
  function readCode(interpolation) {
    const floor = stack.length;
    while (i < n) {
      if (startsWith('//')) {
        skipLineComment();
        continue;
      }
      if (startsWith('/*')) {
        skipBlockComment();
        continue;
      }
      let hashes = 0;
      while (peek(hashes) === '#') hashes++;
      if (peek(hashes) === '"') {
        readString(hashes, i);
        lineCode += ' "…" ';
        if (stack.length) stack.at(-1).arg += ' "…" ';
        continue;
      }
      const ch = peek();
      const frame = stack.at(-1);
      if (ch === '(') {
        if (frame) frame.arg += ch;
        const callee = /([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(lineCode)?.[1] ?? null;
        stack.push({ callee, arg: '' });
        lineCode += ch;
        advance();
        continue;
      }
      if (ch === ')') {
        if (interpolation && stack.length === floor) {
          stack.pop();
          i++;
          return;
        }
        if (stack.length > (interpolation ? floor : 0)) stack.pop();
        while (current() && stack.length < current().depth) assignments.pop();
      } else if (ch === '=' && !NOT_ASSIGNMENT_BEFORE.has(lineCode.at(-1) ?? '') && peek(1) !== '='
        && !/\b(?:case|let|var)\b[^=]*$/.test(lineCode.split(/[,;{]/).at(-1) ?? '')) {
        // Wzorzec `if case .a = b`, wiązanie `if let x = …`: to nie przypisanie do właściwości.
        const target = /\.([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(lineCode)?.[1];
        if (target) {
          while (current() && current().depth >= stack.length) assignments.pop();
          assignments.push({ target, depth: stack.length });
        }
      } else if ((ch === ';' || ch === '{' || ch === '}') && current() && stack.length <= current().depth) {
        assignments.pop();
      } else if (ch === '\n') {
        endOfLine();
      }
      if (ch === ',' && frame) {
        frame.arg = '';
      } else if (frame && ch !== '\n' && ch !== ')') {
        frame.arg += ch;
      }
      if (ch !== '\n') lineCode += ch;
      advance();
    }
  }
  readCode(false);
  return { literals, masked: masked.join('') };
}

/**
 * Klucze `L("…")` w pliku Swift i wywołania `L(` z kluczem, który nie jest SAMYM literałem (zmienna, interpolacja,
 * `"a" + b`). Odstęp i komentarz między `L` a nawiasem nie ukrywają wywołania.
 */
export function copyKeysInSwift(source) {
  const { literals, masked } = swiftStringLiterals(source);
  const byStart = new Map(literals.map((literal) => [literal.start, literal]));
  const keys = [];
  const dynamic = [];
  for (const match of masked.matchAll(/(?<![A-Za-z0-9_.])L\s*\(\s*/g)) {
    // Deklaracja funkcji `func L(_ key: …)` nie jest wywołaniem.
    if (/\bfunc\s+$/.test(masked.slice(Math.max(0, match.index - 8), match.index))) continue;
    const at = match.index + match[0].length;
    const literal = byStart.get(at);
    const alone = literal && !literal.text.includes('\u0000') && /^\s*[,)]/.test(masked.slice(literal.end));
    if (alone) keys.push({ key: literal.text, line: literal.line });
    else dynamic.push({ line: masked.slice(0, match.index).split('\n').length });
  }
  return { keys, dynamic };
}

// ── Katalogi ────────────────────────────────────────────────────────────────────────────────────────────────

const SPECIFIER =
  /%#@([A-Za-z0-9_]+)@|%arg|%(?:(\d+)\$)?([-+#0']*)(\d+|\*(?:\d+\$)?)?(?:\.(\d+|\*(?:\d+\$)?))?(hh|h|ll|l|q|L|z|t|j)?([@dDiuUxXoOfFeEgGcCsSpaA%])/g;

/**
 * Parametry jednej wartości: `params` — `{ position, type }` (pozycja jawna `%2$@` albo kolejna; podstawienie
 * `%#@nazwa@` jako typ `@nazwa@`, bez pozycji — tę daje jego `argNum`), `percent` — liczba `%%`, `ownArg` — czy stoi
 * `%arg` (wartość wariantu podstawienia), `unsupported` — szerokość albo precyzja `*` (zjada osobny argument).
 * Flagi bez spacji: „100% done” to tekst, nie `% d`.
 */
export function formatSignature(value) {
  const params = [];
  let percent = 0;
  let next = 1;
  let ownArg = false;
  let unsupported = false;
  for (const match of value.matchAll(SPECIFIER)) {
    if (match[1]) {
      params.push({ position: null, type: `@${match[1]}@`, explicit: true });
      continue;
    }
    if (match[0] === '%arg') {
      ownArg = true;
      continue;
    }
    if (match[7] === '%') {
      percent++;
      continue;
    }
    if (match[4]?.startsWith('*') || match[5]?.startsWith('*')) unsupported = true;
    const position = match[2] ? Number(match[2]) : next++;
    params.push({ position, type: `${match[6] ?? ''}${match[7]}`, explicit: Boolean(match[2]) });
  }
  return { params, percent, ownArg, unsupported };
}

/** Wartości węzła: prosta albo warianty (liczba mnoga, urządzenie), z miejscem do komunikatu. */
function values(node, at) {
  if (!node || typeof node !== 'object') return [];
  const out = [];
  if (node.stringUnit) out.push({ unit: node.stringUnit, at });
  for (const [kind, variants] of Object.entries(node.variations ?? {})) {
    for (const [name, variant] of Object.entries(variants ?? {})) out.push(...values(variant, `${at} ${kind}.${name}`));
  }
  return out;
}

/** Pusty węzeł: ani wartości, ani choć jednego wariantu. */
const empty = (node) => !node?.stringUnit
  && !Object.values(node?.variations ?? {}).some((variants) => Object.keys(variants ?? {}).length > 0);

/**
 * Wartość, stan, komplet kategorii liczby mnogiej i puste węzły jednego węzła (lokalizacji albo podstawienia),
 * rekurencyjnie przez warianty (np. urządzenie → liczba mnoga).
 */
function nodeProblems(node, language, where) {
  const problems = [];
  const walk = (current, at) => {
    if (empty(current)) {
      problems.push(`${at}: no value`);
      return;
    }
    const plural = current.variations?.plural;
    if (plural) {
      const need = PLURAL_CATEGORIES[language] ?? ['other'];
      const missing = need.filter((category) => !plural[category]);
      if (missing.length) problems.push(`${at}: plural is missing categories ${missing.join(', ')}`);
    }
    for (const [kind, variants] of Object.entries(current.variations ?? {})) {
      for (const [name, variant] of Object.entries(variants ?? {})) walk(variant, `${at} ${kind}.${name}`);
    }
  };
  walk(node, where);
  for (const { unit, at } of values(node, where)) {
    if (unit.state !== 'translated') problems.push(`${at}: state "${String(unit.state)}", "translated" required`);
    if (typeof unit.value !== 'string' || unit.value === '') problems.push(`${at}: empty value`);
  }
  return problems;
}

/**
 * Podpis parametrów lokalizacji: `params` — „pozycja:typ” po pozycjach (podstawienie daje pozycję `argNum`
 * i typ `formatSpecifier`, a parametry wewnątrz jego wariantów — swoje), `percent` — liczba `%%` per miejsce
 * (zdanie i każde podstawienie, bez zer; `brak` = nigdzie), `problems` — sprzeczności wewnątrz tej lokalizacji: ta sama pozycja z różnymi
 * typami, warianty z różną liczbą `%%`, podstawienie bez definicji albo bez pozycji, parametr bez pozycji
 * w wariancie podstawienia, format z `*`.
 */
function localizationSignature(localization, where) {
  const types = new Map();
  const problems = [];
  const percents = [];
  const put = (position, type, at) => {
    const known = types.get(position);
    if (known !== undefined && known !== type) problems.push(`${at}: position ${position} is both ${known} and ${type}`);
    else types.set(position, type);
  };
  const scan = (node, at, substitution) => {
    const counts = new Set();
    for (const { unit, at: place } of values(node, at)) {
      const signature = formatSignature(typeof unit.value === 'string' ? unit.value : '');
      counts.add(signature.percent);
      if (signature.unsupported) problems.push(`${place}: width or precision "*" is not supported`);
      for (const param of signature.params) {
        const name = /^@(.+)@$/.exec(param.type)?.[1];
        if (name !== undefined) {
          const entry = localization.substitutions?.[name];
          if (!entry) problems.push(`${place}: substitution "${name}" has no definition`);
          else if (!Number.isInteger(entry.argNum)) problems.push(`${place}: substitution "${name}" has no argNum`);
          else put(entry.argNum, String(entry.formatSpecifier), place);
          continue;
        }
        if (substitution && !param.explicit) {
          problems.push(`${place}: parameter without a position in a substitution variant (write %N$…)`);
        }
        put(param.position, param.type, place);
      }
    }
    if (counts.size > 1) problems.push(`${at}: variants have different counts of "%%"`);
    const most = Math.max(0, ...counts);
    if (most > 0) percents.push(`${substitution ?? 'sentence'}=${most}`);
  };
  scan(localization, where, null);
  for (const [name, substitution] of Object.entries(localization.substitutions ?? {})) {
    scan(substitution, `${where} substitution ${name}`, name);
  }
  return {
    params: [...types].sort(([a], [b]) => a - b).map(([position, type]) => `${position}:${type}`),
    percent: percents.sort().join(' ') || 'none',
    anyPercent: percents.length > 0,
    problems,
  };
}

/** Problemy jednego katalogu; `file` tylko do komunikatów. */
export function catalogProblems(catalog, { file, required = REQUIRED_LANGUAGES, source = SOURCE_LANGUAGE } = {}) {
  const problems = [];
  if (catalog?.sourceLanguage !== source) {
    problems.push(`${file}: sourceLanguage "${String(catalog?.sourceLanguage)}", expected "${source}"`);
  }
  for (const [key, entry] of Object.entries(catalog?.strings ?? {})) {
    const localizations = entry.localizations ?? {};
    const reference = localizations[source] ? localizationSignature(localizations[source], '') : undefined;
    for (const language of required) {
      const where = `${file}: "${key}" [${language}]`;
      const localization = localizations[language];
      if (!localization) {
        problems.push(`${where}: no value`);
        continue;
      }
      problems.push(...nodeProblems(localization, language, where));
      for (const [name, substitution] of Object.entries(localization.substitutions ?? {})) {
        problems.push(...nodeProblems(substitution, language, `${where} substitution ${name}`));
      }
      const signature = localizationSignature(localization, where);
      problems.push(...signature.problems);
      if (signature.params.length === 0 && signature.anyPercent) {
        problems.push(`${where}: "%%" in a sentence without parameters — without parameters the text goes out verbatim, write "%"`);
      }
      if (reference && language !== source) {
        if (signature.params.join(' ') !== reference.params.join(' ')) {
          problems.push(`${where}: parameters ${signature.params.join(' ') || 'none'} ≠ ${source}: ${
            reference.params.join(' ') || 'none'}`);
        }
        if (signature.percent !== reference.percent) {
          problems.push(`${where}: "%%" ${signature.percent} ≠ ${source}: ${reference.percent}`);
        }
      }
    }
  }
  return problems;
}

// ── Katalog zdań serwera ───────────────────────────────────────────────────────────────────────────────

/** Pakiet z katalogiem zdań serwera: jego katalog idzie regułą 8 zamiast 4 i 5. */
export const SERVER_CATALOG_PACKAGE = 'RarogContract';
/** Klucz katalogu zdań serwera: `server.<kod>` albo `push.<nazwa>` (klucze `loc-key` pusha). */
export const SERVER_KEY = /^(?:server|push)\./;

/** Katalog zdań serwera w repo: źródło wartości kluczy `loc-key` (reguła 9). */
export const SERVER_CATALOG =
  `native/Rarog/Packages/${SERVER_CATALOG_PACKAGE}/Sources/${SERVER_CATALOG_PACKAGE}/Copy/Localizable.xcstrings`;

/** Problemy katalogu zdań serwera (reguła 8): wartości i parametry jak w katalogu pakietu oraz prefiks klucza. */
export function serverCatalogProblems(catalog, { file, required = REQUIRED_LANGUAGES, source = SOURCE_LANGUAGE } = {}) {
  const problems = catalogProblems(catalog, { file, required, source });
  for (const key of Object.keys(catalog?.strings ?? {})) {
    if (!SERVER_KEY.test(key)) problems.push(`${file}: "${key}" — a server sentence key starts with server. or push.`);
  }
  return problems;
}

// ── Klucze `loc-key` pusha w apce i widżecie ──────────────────────────────────────────────────────────────

/** Klucze `loc-key` ładunku APNs (tekst zastępczy banera i dzwonek kafla), posortowane. */
export const LOC_KEYS = ['push.chime.body', 'push.chime.title', 'push.placeholder.body', 'push.placeholder.title'];
/** Katalogi `loc-key` w folderach celów projektu Xcode: główny cel apki i widżet (Live Activity). */
export const LOC_KEY_CATALOGS = ['native/Rarog/Rarog/Localizable.xcstrings',
  'native/Rarog/RarogWidgets/Localizable.xcstrings'];

/** JSON z kluczami obiektów po kolei: równość treści bez względu na kolejność pól, którą zmienia Xcode. */
const canonical = (value) => JSON.stringify(value, (_, node) => (node && typeof node === 'object' && !Array.isArray(node)
  ? Object.fromEntries(Object.entries(node).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  : node));

/**
 * Problemy katalogu `loc-key` jednego celu (reguła 9): reguły 1–3, każdy klucz z {@link LOC_KEYS} i żaden inny,
 * lokalizacja każdego wymaganego języka równa tej z katalogu zdań serwera (`serverCatalog`).
 */
export function locKeyCatalogProblems(catalog, serverCatalog, {
  file, serverFile, required = REQUIRED_LANGUAGES, source = SOURCE_LANGUAGE,
} = {}) {
  const problems = catalogProblems(catalog, { file, required, source });
  const strings = catalog?.strings ?? {};
  const list = LOC_KEYS.join(', ');
  for (const key of LOC_KEYS) {
    if (!strings[key]) {
      problems.push(`${file}: no "${key}" (push loc-keys: ${list})`);
      continue;
    }
    const reference = serverCatalog?.strings?.[key]?.localizations;
    if (!reference) {
      problems.push(`${serverFile}: no "${key}" to compare ${file} with`);
      continue;
    }
    for (const language of required) {
      if (canonical(strings[key].localizations?.[language]) !== canonical(reference[language])) {
        problems.push(`${file}: "${key}" [${language}] differs from ${serverFile}`);
      }
    }
  }
  for (const key of Object.keys(strings)) {
    if (!LOC_KEYS.includes(key)) problems.push(`${file}: "${key}" — only the push loc-keys belong here (${list})`);
  }
  return problems;
}

// ── Info.plist apki, widżetu i NSE ─────────────────────────────────────────────────────────────────────

/** `Info.plist` apki: angielskie źródło tekstów zgód (`NS…UsageDescription`). */
export const APP_INFO_PLIST = 'native/Rarog/Info.plist';
/** Katalog `Info.plist` apki w celu apki (folder `Rarog/` projektu Xcode): teksty zgód w każdym języku. */
export const APP_INFO_CATALOG = 'native/Rarog/Rarog/InfoPlist.xcstrings';
/** `Info.plist` procesów z copy: apka, widżet (Live Activity) i NSE; każdy deklaruje języki w `CFBundleLocalizations`. */
export const INFO_PLISTS = [APP_INFO_PLIST, 'native/Rarog/RarogWidgets/Info.plist',
  'native/Rarog/RarogNotificationService/Info.plist'];
const USAGE_KEY = /^NS\w+UsageDescription$/;

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const xmlText = (raw) => raw.replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => XML_ENTITIES[name]);

/**
 * Wartości plist XML bez komentarzy: `strings` — pary `<key>K</key><string>V</string>`, `arrays` — napisy tablicy
 * `<array>` pod kluczem. Wystarcza dla płaskich plistów apki (klucze najwyższego poziomu); tablica z zagnieżdżoną
 * tablicą (`CFBundleURLTypes`) kończy się na pierwszym `</array>`, więc jej treść tu się nie liczy.
 */
export function plistValues(xml) {
  const text = xml.replace(/<!--[\s\S]*?-->/g, '');
  const strings = new Map();
  for (const match of text.matchAll(/<key>([^<]*)<\/key>\s*<string>([^<]*)<\/string>/g)) {
    strings.set(xmlText(match[1]), xmlText(match[2]));
  }
  const arrays = new Map();
  for (const match of text.matchAll(/<key>([^<]*)<\/key>\s*<array>([\s\S]*?)<\/array>/g)) {
    arrays.set(xmlText(match[1]), [...match[2].matchAll(/<string>([^<]*)<\/string>/g)].map((item) => xmlText(item[1])));
  }
  return { strings, arrays };
}

/**
 * Problemy katalogu `Info.plist` apki razem z samym `Info.plist` (reguła 6): wartości i parametry jak w katalogu
 * pakietu, klucze `NS…UsageDescription` w obie strony, wartość języka źródłowego równa tekstowi w `Info.plist`.
 */
export function infoPlistCatalogProblems(catalog, plistXml, {
  file, plistFile, required = REQUIRED_LANGUAGES, source = SOURCE_LANGUAGE,
} = {}) {
  const problems = catalogProblems(catalog, { file, required, source });
  const { strings } = plistValues(plistXml);
  const keys = Object.keys(catalog?.strings ?? {});
  for (const key of strings.keys()) {
    if (USAGE_KEY.test(key) && !keys.includes(key)) problems.push(`${plistFile}: "${key}" is missing from ${file}`);
  }
  for (const key of keys) {
    if (!strings.has(key)) {
      problems.push(`${file}: "${key}" — ${plistFile} has no such key`);
      continue;
    }
    const value = catalog.strings[key]?.localizations?.[source]?.stringUnit?.value;
    if (value !== undefined && value !== strings.get(key)) {
      problems.push(`${file}: "${key}" [${source}] differs from ${plistFile} (the ${source} text stands in both)`);
    }
  }
  return problems;
}

/**
 * `CFBundleLocalizations` jednego `Info.plist` = wymagane języki (reguła 7). Brak klucza: proces bez `.lproj` nie zna
 * żadnego języka poza `CFBundleDevelopmentRegion`; język ponad wymagane: proces wybrałby język bez tekstów.
 */
export function plistLanguageProblems(plistXml, { file, required = REQUIRED_LANGUAGES } = {}) {
  const declared = plistValues(plistXml).arrays.get('CFBundleLocalizations');
  if (!declared) return [`${file}: no CFBundleLocalizations (required: ${required.join(', ')})`];
  const problems = [];
  const missing = required.filter((language) => !declared.includes(language));
  const extra = declared.filter((language) => !required.includes(language));
  if (missing.length) problems.push(`${file}: CFBundleLocalizations is missing ${missing.join(', ')}`);
  if (extra.length) {
    problems.push(`${file}: CFBundleLocalizations has ${extra.join(', ')}, which the catalogs do not require`);
  }
  return problems;
}

// ── Repo ────────────────────────────────────────────────────────────────────────────────────────────────────

function swiftFiles(directory) {
  const out = [];
  if (!existsSync(directory)) return out;
  for (const name of readdirSync(directory)) {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) out.push(...swiftFiles(full));
    else if (name.endsWith('.swift')) out.push(full);
  }
  return out;
}

/**
 * Katalogi pakietów apki (`Packages/<Pakiet>/Sources/<Pakiet>/Copy/Localizable.xcstrings`) i katalogi-próbki
 * testów; każdy katalog pakietu z kluczami z `L("…")` w źródłach tego celu, a katalog zdań serwera
 * ({@link SERVER_CATALOG_PACKAGE}) regułą 8. Gdy repo ma `Info.plist` apki, także katalog `Info.plist` (wymagany)
 * i `CFBundleLocalizations` każdego `Info.plist` z {@link INFO_PLISTS}, który istnieje. Gdy repo ma katalog zdań
 * serwera, katalog `loc-key` z {@link LOC_KEY_CATALOGS} każdego celu, którego folder jest (reguła 9).
 */
export function repoProblems(root) {
  const problems = [];
  const packages = path.join(root, 'native/Rarog/Packages');
  let catalogs = 0;
  let serverCatalogs = 0;
  for (const name of readdirSync(packages)) {
    const sources = path.join(packages, name, 'Sources', name);
    const catalogPath = path.join(sources, 'Copy', 'Localizable.xcstrings');
    const relative = path.relative(root, catalogPath);
    if (name === SERVER_CATALOG_PACKAGE && existsSync(catalogPath)) {
      serverCatalogs++;
      problems.push(...serverCatalogProblems(JSON.parse(readFileSync(catalogPath, 'utf8')), { file: relative }));
      continue;
    }
    const swift = swiftFiles(sources);
    const used = swift.flatMap((file) => {
      const { keys, dynamic } = copyKeysInSwift(readFileSync(file, 'utf8'));
      const where = path.relative(root, file);
      for (const call of dynamic) problems.push(`${where}:${call.line}: L(…) with a key that is not a literal`);
      return keys.map((key) => ({ ...key, where }));
    });
    if (!existsSync(catalogPath)) {
      for (const key of used) problems.push(`${key.where}:${key.line}: "${key.key}" — package ${name} has no catalog`);
      continue;
    }
    catalogs++;
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
    problems.push(...catalogProblems(catalog, { file: relative }));
    for (const key of used) {
      if (!catalog.strings?.[key.key]) problems.push(`${key.where}:${key.line}: "${key.key}" is missing from ${relative}`);
    }
    // Każdy tekst idzie przez `L("…")`: klucz katalogu bez wywołania w kodzie to tekst po usuniętym kodzie.
    const usedKeys = new Set(used.map((key) => key.key));
    for (const key of Object.keys(catalog.strings ?? {})) {
      if (!usedKeys.has(key)) problems.push(`${relative}: "${key}" — no L("…") in package ${name} uses this key`);
    }
  }
  const fixture = path.join(packages, 'RarogContract/Tests/RarogContractTests/Resources/Localizable.xcstrings');
  if (existsSync(fixture)) {
    problems.push(...catalogProblems(JSON.parse(readFileSync(fixture, 'utf8')),
      { file: path.relative(root, fixture) }));
  }
  // Reguła 9: katalog `loc-key` każdego celu, którego folder jest w repo, gdy jest katalog zdań serwera
  // (źródło wartości).
  let locKeyCatalogs = 0;
  if (existsSync(path.join(root, SERVER_CATALOG))) {
    const server = JSON.parse(readFileSync(path.join(root, SERVER_CATALOG), 'utf8'));
    for (const file of LOC_KEY_CATALOGS.filter((name) => existsSync(path.join(root, path.dirname(name))))) {
      if (!existsSync(path.join(root, file))) {
        problems.push(`${file}: missing — iOS has no text for the push loc-keys in this target`);
        continue;
      }
      locKeyCatalogs++;
      problems.push(...locKeyCatalogProblems(JSON.parse(readFileSync(path.join(root, file), 'utf8')), server,
        { file, serverFile: SERVER_CATALOG }));
    }
  }
  let infoCatalogs = 0;
  let plists = 0;
  if (existsSync(path.join(root, APP_INFO_PLIST))) {
    const plist = readFileSync(path.join(root, APP_INFO_PLIST), 'utf8');
    if (existsSync(path.join(root, APP_INFO_CATALOG))) {
      infoCatalogs++;
      problems.push(...infoPlistCatalogProblems(JSON.parse(readFileSync(path.join(root, APP_INFO_CATALOG), 'utf8')),
        plist, { file: APP_INFO_CATALOG, plistFile: APP_INFO_PLIST }));
    } else {
      problems.push(`${APP_INFO_CATALOG}: missing — the usage descriptions of ${APP_INFO_PLIST} have no translations`);
    }
    for (const file of INFO_PLISTS.filter((name) => existsSync(path.join(root, name)))) {
      plists++;
      problems.push(...plistLanguageProblems(readFileSync(path.join(root, file), 'utf8'), { file }));
    }
  }
  return { problems, catalogs, serverCatalogs, infoCatalogs, plists, locKeyCatalogs };
}

const self = fileURLToPath(import.meta.url);
if (isMainModule(import.meta.url)) {
  const root = path.resolve(path.dirname(self), '..');
  const { problems, catalogs, serverCatalogs, infoCatalogs, plists, locKeyCatalogs } = repoProblems(root);
  if (problems.length) {
    console.error(`l10n-check: ${problems.length} problem(s):\n${problems.join('\n')}`);
    process.exit(1);
  }
  console.log(`l10n-check: green (${catalogs} package catalogs, ${serverCatalogs} server sentence catalog, `
    + `${infoCatalogs} Info.plist catalog, ${plists} Info.plist, ${locKeyCatalogs} push loc-key catalogs, `
    + `required languages: ${REQUIRED_LANGUAGES.join(', ')})`);
}
