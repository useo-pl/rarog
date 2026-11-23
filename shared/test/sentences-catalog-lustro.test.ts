/**
 * Lustro katalogu zdań serwera: katalog RarogContract `Copy/Localizable.xcstrings` i deskryptory
 * `Copy/SentenceDescriptors.swift` zgadzają się z rejestrem `shared/src/sentences/`. Apka tłumaczy kod kluczem
 * katalogu i liczbą argumentów z deskryptora, więc rozjazd z rejestrem to zdanie w apce inne niż to, które serwer
 * miał na myśli, albo wzorzec, który Foundation sformatuje źle.
 *
 * Sprawdzenia idą niezależnie od generatora (`scripts/sentences-catalog.mjs`): klucze liczone tu wprost, `en` katalogu
 * zamieniane z powrotem na szablon `{nazwa}` i porównane z rejestrem, specyfikatory czytane z wartości, deskryptory
 * parsowane z pliku Swift. Na końcu porównanie z wyjściem generatora (`--check` w procesie).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RETIRED, SENTENCES, SENTENCE_AREAS, type SentenceDefinition } from '../src/sentences/index.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONTRACT_COPY = 'native/Rarog/Packages/RarogContract/Sources/RarogContract/Copy';
const CATALOG = `${CONTRACT_COPY}/Localizable.xcstrings`;
const DESCRIPTORS = `${CONTRACT_COPY}/SentenceDescriptors.swift`;
const UI_CATALOG = 'native/Rarog/Packages/RarogUI/Sources/RarogUI/Copy/Localizable.xcstrings';

interface Node {
  stringUnit?: { state?: string; value?: string };
  substitutions?: Record<string, { argNum?: number; formatSpecifier?: string; variations?: { plural?: Record<string, Node> } }>;
}
interface Catalog {
  sourceLanguage: string;
  strings: Record<string, { comment?: string; extractionState?: string; localizations?: Record<string, Node> }>;
}
interface Generator {
  buildModel: (registry: { SENTENCES: object; RETIRED: object }) => unknown;
  buildDescriptors: (model: unknown) => string;
  catalogKey: (code: string) => string;
  outputProblems: (model: unknown, outputs: { catalog: Catalog | null; descriptors: string | null }) => string[];
}

const read = (rel: string): string => readFileSync(path.join(REPO, rel), 'utf8');
const catalog = JSON.parse(read(CATALOG)) as Catalog;
const descriptorsText = read(DESCRIPTORS);
const generator = await import(pathToFileURL(path.join(REPO, 'scripts/sentences-catalog.mjs')).href) as Generator;

/** Wszystkie kody rejestru (emitowane i wycofane) z definicją i `retired`. */
const ALL: Array<{ code: string; def: SentenceDefinition; retired: boolean }> = [
  ...Object.entries(SENTENCES as Readonly<Record<string, SentenceDefinition>>).map(([code, def]) => ({ code, def, retired: false })),
  ...Object.entries(RETIRED as Readonly<Record<string, SentenceDefinition>>).map(([code, def]) => ({ code, def, retired: true })),
];
const argsOf = (def: SentenceDefinition) => (def.args ?? []).map((spec) => {
  const [name = '', kind = ''] = spec.split(':');
  return { name, kind };
});
/** Klucz liczony tu wprost (nie z generatora): `push.*` bez zmian, reszta `server.<kod>`. */
const keyOf = (code: string): string => (code.startsWith('push.') ? code : `server.${code}`);
const specifier = (kind: string): string => (kind === 'int' || kind === 'plural' ? 'lld' : '@');
const PL_CATEGORIES = ['few', 'many', 'one', 'other'];

/** Wartość katalogu z powrotem jako szablon rejestru: `%N$…` → `{nazwa}`, `%arg` → `{liczba}`, `%%` → `%`. */
function template(value: string, args: Array<{ name: string }>, pluralName?: string): string {
  const back = value.replace(/%(\d+)\$(?:@|lld)|%arg/gu, (_match, position?: string) =>
    position === undefined ? `{${pluralName ?? '?'}}` : `{${args[Number(position) - 1]?.name ?? '?'}}`);
  return args.length > 0 ? back.replaceAll('%%', '%') : back;
}

/** Wartości lokalizacji: zdanie i każdy wariant podstawienia, z miejscem. */
function values(node: Node | undefined, where: string): Array<{ where: string; value: string | undefined }> {
  const out = [{ where, value: node?.stringUnit?.value }];
  for (const [name, sub] of Object.entries(node?.substitutions ?? {})) {
    for (const [category, variant] of Object.entries(sub.variations?.plural ?? {})) {
      out.push({ where: `${where} ${name}.${category}`, value: variant.stringUnit?.value });
    }
  }
  return out;
}

describe('lustro katalogu zdań serwera: klucze', () => {
  it('kod ↔ klucz: każdy kod SENTENCES i RETIRED ma klucz, każdy klucz ma kod (bez sierot)', () => {
    expect(catalog.sourceLanguage).toBe('en');
    const expected = ALL.map(({ code }) => keyOf(code)).sort();
    expect(Object.keys(catalog.strings).sort()).toEqual(expected);
    for (const { code } of ALL) expect(generator.catalogKey(code), code).toBe(keyOf(code));
  });

  it('push.* wobec push.ts: klucze bez prefiksu to dokładnie obszar push, reszta ma prefiks server.', () => {
    const push = Object.keys(catalog.strings).filter((key) => key.startsWith('push.')).sort();
    expect(push).toEqual(Object.keys(SENTENCE_AREAS.push).sort());
    expect(push.length).toBeGreaterThan(0);
    const rest = Object.keys(catalog.strings).filter((key) => !key.startsWith('push.'));
    expect(rest.filter((key) => !key.startsWith('server.'))).toEqual([]);
  });

  it('każdy klucz: extractionState manual i komentarz z kodem i argumentami', () => {
    for (const { code, def } of ALL) {
      const entry = catalog.strings[keyOf(code)];
      expect(entry?.extractionState, code).toBe('manual');
      expect(entry?.comment, code).toContain(`code ${code}.`);
      for (const { name, kind } of argsOf(def)) expect(entry?.comment, code).toContain(`${name} (${kind})`);
    }
  });
});

describe('lustro katalogu zdań serwera: wartości', () => {
  it('en = szablon rejestru (zdanie i warianty liczby mnogiej)', () => {
    for (const { code, def } of ALL) {
      const args = argsOf(def);
      const en = catalog.strings[keyOf(code)]?.localizations?.en;
      if (typeof def.en === 'string') {
        expect(en?.substitutions, code).toBeUndefined();
        expect(template(en?.stringUnit?.value ?? '', args), code).toBe(def.en);
        continue;
      }
      const at = args.findIndex((arg) => arg.kind === 'plural');
      const name = args[at]?.name ?? '';
      expect(en?.stringUnit?.value, code).toBe(`%${String(at + 1)}$#@${name}@`);
      const variants = en?.substitutions?.[name]?.variations?.plural ?? {};
      const back = Object.fromEntries(Object.entries(variants)
        .map(([category, node]) => [category, template(node.stringUnit?.value ?? '', args, name)]));
      expect(back, code).toEqual({ one: def.en.one, other: def.en.other });
    }
  });

  it('pl obecne: każdy klucz i każdy wariant przetłumaczony i niepusty', () => {
    for (const { code } of ALL) {
      const pl = catalog.strings[keyOf(code)]?.localizations?.pl;
      expect(pl, `${code}: brak pl`).toBeDefined();
      for (const { where, value } of values(pl, code)) {
        expect(typeof value === 'string' && value.length > 0, `${where}: pusta wartość`).toBe(true);
      }
      expect(pl?.stringUnit?.state, code).toBe('translated');
    }
  });

  it('rodzaje = specyfikatory: w en i pl pozycje istnieją, typ według rodzaju, każdy argument poza liczbą mnogą użyty', () => {
    for (const { code, def } of ALL) {
      const args = argsOf(def);
      for (const language of ['en', 'pl']) {
        const node = catalog.strings[keyOf(code)]?.localizations?.[language];
        const used = new Set<number>();
        for (const { where, value = '' } of values(node, `${code} [${language}]`)) {
          for (const m of value.matchAll(/%(\d+)\$(@|lld)(?!@)/gu)) {
            const position = Number(m[1]);
            const arg = args[position - 1];
            expect(arg, `${where}: %${String(position)}$ bez argumentu`).toBeDefined();
            expect(arg?.kind, `${where}: argument liczby mnogiej tylko jako %arg`).not.toBe('plural');
            expect(m[2], `${where}: ${arg?.name ?? '?'} (${arg?.kind ?? '?'})`).toBe(specifier(arg?.kind ?? ''));
            used.add(position);
          }
          // Specyfikator bez pozycji zjada argumenty po kolei; katalog serwera pisze zawsze `%N$`.
          const unpositioned = value.replace(/%%|%arg|%\d+\$#@[A-Za-z0-9_]+@|%\d+\$(?:@|lld)/gu, '');
          if (args.length > 0) expect(unpositioned.includes('%'), `${where}: „%” bez pozycji albo bez ucieczki`).toBe(false);
          else expect(value.includes('%%'), `${where}: „%%” w zdaniu bez argumentów`).toBe(false);
        }
        const required = args.map((arg, i) => ({ arg, position: i + 1 })).filter(({ arg }) => arg.kind !== 'plural');
        for (const { arg, position } of required) expect(used.has(position), `${code} [${language}]: ${arg.name}`).toBe(true);
      }
    }
  });

  it('liczba mnoga w obu językach: podstawienie z argNum i lld, kategorie en one/other, pl one/few/many/other', () => {
    const plurals = ALL.filter(({ def }) => argsOf(def).some((arg) => arg.kind === 'plural'));
    expect(plurals.length).toBeGreaterThan(0);
    for (const { code, def } of plurals) {
      const args = argsOf(def);
      const at = args.findIndex((arg) => arg.kind === 'plural');
      const name = args[at]?.name ?? '';
      for (const [language, categories] of [['en', ['one', 'other']], ['pl', PL_CATEGORIES]] as const) {
        const node = catalog.strings[keyOf(code)]?.localizations?.[language];
        expect(node?.stringUnit?.value, `${code} [${language}]`).toBe(`%${String(at + 1)}$#@${name}@`);
        const sub = node?.substitutions?.[name];
        expect([sub?.argNum, sub?.formatSpecifier], `${code} [${language}]`).toEqual([at + 1, 'lld']);
        expect(Object.keys(sub?.variations?.plural ?? {}).sort(), `${code} [${language}]`).toEqual([...categories]);
      }
    }
  });

  it('RarogUI nie ma `cards.refuseMessage.*`: zdanie odmowy składa fasada z `server.dialogs.refuse.<powód>`', () => {
    const ui = JSON.parse(read(UI_CATALOG)) as Catalog;
    expect(Object.keys(ui.strings).filter((key) => key.startsWith('cards.refuseMessage.'))).toEqual([]);
  });
});

describe('lustro katalogu zdań serwera: deskryptory', () => {
  it('deskryptory z pliku Swift = rejestr: kod, rodzaje argumentów w kolejności, retired', () => {
    const rows = [...descriptorsText.matchAll(/^ {4}"([^"]+)": SentenceDescriptor\(args: \[([^\]]*)\], retired: (true|false)\),$/gmu)]
      .map((m) => ({ code: m[1], args: (m[2] ?? '').split(',').map((kind) => kind.trim().replace(/^\./u, '')).filter(Boolean),
        retired: m[3] === 'true' }));
    const expected = ALL.map(({ code, def, retired }) => ({ code, args: argsOf(def).map((arg) => arg.kind), retired }))
      .sort((a, b) => (a.code < b.code ? -1 : 1));
    expect(rows).toEqual(expected);
  });

  it('deskryptory i katalog = wyjście generatora (--check w procesie)', () => {
    const model = generator.buildModel({ SENTENCES, RETIRED });
    expect(descriptorsText).toBe(generator.buildDescriptors(model));
    expect(generator.outputProblems(model, { catalog, descriptors: descriptorsText })).toEqual([]);
  });
});
