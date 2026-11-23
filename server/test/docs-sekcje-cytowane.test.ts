/**
 * Strażnik cytowań sekcji: każde cytowanie sekcji dokumentu w widoku eksportu (kod, testy, `relay/`, `.github`
 * i same dokumenty, poza fixture'ami) trafia w istniejący nagłówek dokumentu z repo. Dokument przepisany bez poprawki
 * cytującego kodu albo cytującego dokumentu przewraca ten test, a nie urywa odsyłacza po cichu. Formy cytowania,
 * kotwice, rozwiązywanie ścieżki i reguła dopasowania: `docs-sekcje-cytowane.ts`.
 *
 * Dane syntetyczne: w pliku testu liczą się tylko linie komentarza, więc nieistniejące dokumenty w napisach tego
 * testu nie są cytowaniami. Cudzysłów po ścieżce, który nie cytuje sekcji (fraza z dokumentu), stoi na liście
 * {@link NIE_SEKCJE} z powodem.
 *
 * Porażka: popraw cytowanie (tytuł albo ścieżkę) tak, żeby wskazywało sekcję, która dziś opisuje to samo.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  anchors, citations, commentLines, hits, isTestFile, misses, resolveDoc, type Citation,
} from './docs-sekcje-cytowane.ts';
import { PRIVATE_LAYER, REPO, inExportView, isFixture } from './private-guard.ts';
import { repoFiles, repoTextFiles } from './source-scan.ts';

/**
 * Cudzysłów po ścieżce dokumentu, który nie jest tytułem sekcji: klucz `plik tytuł`, wartość to powód. Wpis bez
 * trafienia jest błędem, więc lista nie obrasta martwymi wyjątkami.
 */
const NIE_SEKCJE: ReadonlyMap<string, string> = new Map([
  ['server/test/docs-zgodnosc.test.ts terminal jest LUSTREM panelu herdr',
    'fraza zakazana w README (lista przeczeń strażnika), nie sekcja'],
]);

/**
 * Najmniejsza liczba strzeżonych cytowań do dokumentów widoku eksportu (bez stron Claude Code). Migracja nazw
 * i tłumaczenie dokumentów nie mogą zgubić cytowania po cichu: cytat, którego strażnik przestał rozpoznawać, obniża
 * liczbę. Nowe cytowania wolno dopisywać; bazę podnosi ten, kto chce ją zamknąć wyżej.
 */
const MIN_CYTOWAN = 376;

const files = new Set(repoFiles(REPO));
const exists = (target: string): boolean => files.has(target);
const read = (target: string): string | null => (exists(target) ? readFileSync(path.join(REPO, target), 'utf8') : null);
/** Plik strażnika: widok eksportu bez fixture'ów; dokument w katalogu fixture'ów (jego README) zostaje. */
const skip = (file: string): boolean => !inExportView(file) || (isFixture(file) && !file.endsWith('.md'));

const all: Citation[] = [...repoTextFiles(REPO, undefined, skip)]
  .flatMap(([file, text]) => citations(file, text))
  .map((cite) => ({ ...cite, target: resolveDoc(cite.file, cite.target, exists) }));
const found = all.filter((cite) => !NIE_SEKCJE.has(`${cite.file} ${cite.title}`));
/** Dokument spoza widoku eksportu ma osobny test niżej; tu go nie czytamy. */
const outside = found.filter((cite) => PRIVATE_LAYER.has(cite.target));
const inside = found.filter((cite) => !PRIVATE_LAYER.has(cite.target));
const guarded = inside.filter((cite) => cite.target.endsWith('.md') && exists(cite.target));

describe('cytowania sekcji dokumentów w widoku eksportu', () => {
  it(`skan widzi co najmniej ${String(MIN_CYTOWAN)} cytowań do dokumentów (migracja nie gubi ich po cichu)`, () => {
    expect(guarded.length, `strzeżonych cytowań: ${String(guarded.length)}`).toBeGreaterThanOrEqual(MIN_CYTOWAN);
  });

  it('każde trafia w istniejący nagłówek', () => {
    expect(misses(inside, read), 'Popraw cytowanie: tytuł sekcji albo ścieżkę dokumentu').toEqual([]);
  });

  it('cytowany dokument jest w widoku eksportu (w repo publicznym innego nie ma)', () => {
    expect(outside.map((cite) => `${cite.file}:${String(cite.line)}: ${cite.target}`),
      'Plik widoku eksportu cytuje sekcję dokumentu spoza niego').toEqual([]);
  });

  it('każdy wyjątek NIE_SEKCJE ma trafienie', () => {
    const used = new Set(all.map((cite) => `${cite.file} ${cite.title}`));
    expect([...NIE_SEKCJE.keys()].filter((key) => !used.has(key)), 'Usuń wyjątek bez trafienia').toEqual([]);
  });
});

describe('rozpoznanie cytowania', () => {
  const titles = (text: string, file = 'x.ts'): string[] =>
    citations(file, text).map((cite) => `${cite.target} ${cite.title}`);

  it('ścieżka z backtickami i bez, przecinek, nawias, brak separatora, zamknięcie " albo ”', () => {
    expect(titles('// `docs/a.md`, „Jeden” i docs/b.md „Dwa" oraz `docs/c.md` („Trzy”)')).toEqual([
      'docs/a.md Jeden', 'docs/b.md Dwa', 'docs/c.md Trzy',
    ]);
  });

  it('słowo „sekcja” przed tytułem, także przez dwie linie; ścieżka z ./ rozwinięta od korzenia repo', () => {
    expect(titles(' * opisuje `docs/a.md`\n * (sekcja „Jeden").\n * `./docs/b.md`, sekcja „Dwa”')).toEqual([
      'docs/a.md Jeden', 'docs/b.md Dwa',
    ]);
  });

  it('kilka tytułów po przecinku i po „i” to kilka cytowań', () => {
    expect(titles(' * `docs/a.md`, „Jeden”, „Dwa” i „Trzy”.')).toEqual([
      'docs/a.md Jeden', 'docs/a.md Dwa', 'docs/a.md Trzy',
    ]);
  });

  it('forma odwrotna: tytuł, potem „w” albo „z” i ścieżka', () => {
    expect(titles('/// przepis „Jeden” z `native/README.md`; „Dwa” i „Trzy” w docs/a.md')).toEqual([
      'native/README.md Jeden', 'docs/a.md Dwa', 'docs/a.md Trzy',
    ]);
  });

  it('forma angielska: “…” i "…", spójniki „and”, „or”, „in”, „from”, słowo „section”', () => {
    expect(titles('// see `docs/a.md`, "One", "Two" and “Three”; docs/b.md, section "Four" or "Five"')).toEqual([
      'docs/a.md One', 'docs/a.md Two', 'docs/a.md Three', 'docs/b.md Four', 'docs/b.md Five',
    ]);
    expect(titles('// "Six" in `docs/a.md`; the recipe "Seven" from native/README.md; "Eight" section of docs/c.md'))
      .toEqual(['docs/a.md Six', 'native/README.md Seven', 'docs/c.md Eight']);
  });

  it('tytuł z ASCII " w środku polskiego cudzysłowu i polski cudzysłów w środku angielskiego', () => {
    expect(titles('// `docs/a.md`, „Echo "x" w kolejce” i „Dwa"'))
      .toEqual(['docs/a.md Echo "x" w kolejce', 'docs/a.md Dwa']);
    expect(titles('// `docs/a.md`, "Turn without „ready”"')).toEqual(['docs/a.md Turn without „ready”']);
  });

  it('sklejenie napisów w kodzie to nie cytat w "…"', () => {
    expect(titles('let rows = [("docs/a.md"), ("b"), "docs/c.md", "d"]\nconst x = "docs/e.md", " f"')).toEqual([]);
  });

  it('przez kilka linii komentarza (TS, Swift, powłoka): linia tytułu, białe znaki zwinięte', () => {
    const ts = '/**\n * Opis: `docs/a.md`,\n * „Tytuł przez\n * dwie linie”.\n */';
    expect(citations('x.ts', ts)).toEqual([
      { file: 'x.ts', line: 3, target: 'docs/a.md', title: 'Tytuł przez dwie linie' },
    ]);
    expect(titles('/// (`docs/a.md`, „Jeden\n///   dwa”)')).toEqual(['docs/a.md Jeden dwa']);
    expect(titles('# opis: docs/a.md, „Jeden\n# dwa”')).toEqual(['docs/a.md Jeden dwa']);
  });

  it('ścieżka w środku innej ścieżki albo adresu i cudzysłów bez ścieżki to nie cytowanie', () => {
    expect(titles('~/.claude/skills/a/SKILL.md, „X” https://example.com/docs/a.md, „Y” i „Z” obok')).toEqual([]);
  });

  it('w pliku testu liczą się tylko linie komentarza; `#` jest komentarzem tylko w powłoce i konfiguracji', () => {
    const swift = '// `docs/a.md`, „Jeden”\nlet x = "docs/b.md, „Dwa”"\n#expect(y == "docs/c.md (sekcja „Trzy”)")';
    expect(isTestFile('native/P/Tests/PTests/XTests.swift')).toBe(true);
    expect(titles(swift, 'native/P/Tests/PTests/XTests.swift')).toEqual(['docs/a.md Jeden']);
    expect(titles('const t = \'`docs/a.md`, „Jeden”\';\n// `docs/b.md`, „Dwa”', 'server/test/x.test.ts'))
      .toEqual(['docs/b.md Dwa']);
    expect(commentLines('relay/test/a.sh', 'x\n# y\n')).toBe('\n# y\n');
    expect(isTestFile('server/src/test-helpers.ts')).toBe(false);
  });

  it('dokument `.md` w katalogu testów (README fixture\'ów) liczy się w całości, nie w liniach komentarza', () => {
    expect(titles('Opis: `docs/a.md`, „Jeden”.\n- `docs/b.md`, „Dwa”', 'server/test/fixtures/herdr/README.md'))
      .toEqual(['docs/a.md Jeden', 'docs/b.md Dwa']);
  });
});

describe('rozwiązanie ścieżki dokumentu', () => {
  const repo = new Set(['docs/a.md', 'docs/b.md', 'native/README.md']);
  const has = (file: string): boolean => repo.has(file);

  it('w dokumencie .md najpierw od jego katalogu, potem od korzenia repo; w kodzie od korzenia', () => {
    expect(resolveDoc('docs/a.md', 'b.md', has)).toBe('docs/b.md');
    expect(resolveDoc('docs/a.md', 'docs/b.md', has)).toBe('docs/b.md');
    expect(resolveDoc('native/README.md', '../docs/a.md', has)).toBe('docs/a.md');
    expect(resolveDoc('server/src/x.ts', 'b.md', has)).toBe('b.md');
    expect(resolveDoc('server/src/x.ts', './docs/b.md', has)).toBe('docs/b.md');
  });
});

describe('kotwice dokumentu i dopasowanie tytułu', () => {
  it('nagłówki # … ###### i pogrubiony początek akapitu albo punktu, bez bloków kodu', () => {
    const md = [
      '# Jeden', '###### Sześć `kod` ##', '**Przykład**', '- **Próbka.** Prefiks…', '4. **Krok:** treść',
      'tekst **w środku** linii', '```bash', '# komentarz w bloku', '```',
      '   ~~~', '## w bloku', '   ~~~', '## Po bloku',
    ].join('\n');
    expect(anchors(md)).toEqual(['Jeden', 'Sześć kod', 'Przykład', 'Próbka', 'Krok', 'Po bloku']);
  });

  it('nagłówek numerowany to kotwica z numerem i bez niego', () => {
    expect(anchors('### 2. Przykładowa sekcja (raz)\n## 1.2 Krok\n## 2026 rok')).toEqual([
      '2. Przykładowa sekcja (raz)', 'Przykładowa sekcja (raz)', '1.2 Krok', 'Krok', '2026 rok',
    ]);
    expect(hits('Przykładowa sekcja', 'Przykładowa sekcja (raz)')).toBe(true);
  });

  it('blok kodu zamyka ogrodzenie tego samego znaku, nie krótsze i bez dopisku', () => {
    const md = ['````markdown', '```ts', '## W bloku', '```', '````', '## Po bloku'].join('\n');
    expect(anchors(md)).toEqual(['Po bloku']);
    expect(anchors(['```', '```ts', '## W bloku', '```', '## Po bloku'].join('\n'))).toEqual(['Po bloku']);
  });

  it('tytuł równy kotwicy albo jej początek przed dopiskiem; wielokropek to skrót', () => {
    expect(hits('Allow-lista v1', 'Allow-lista v1 (CLI 2.1.302)')).toBe(true);
    expect(hits('Dowód', 'Dowód: polski bez zmian')).toBe(true);
    expect(hits('Sesje herdr', 'Sesje herdr — Rarog pisze do cudzego terminala')).toBe(true);
    expect(hits('Pasek zakładek…', 'Pasek zakładek i stan sesji')).toBe(true);
    expect(hits('Zakładanie sesji', 'Zakładanie sesji z telefonu')).toBe(false);
    expect(hits('Klucz', 'Klucze')).toBe(false);
  });

  it('porażka: plik:linia, dokument i brakujący tytuł; strony dokumentacji Claude Code z listy nie czyta', () => {
    const list = citations('a.ts', '// `docs/a.md`, „Brak”\n// `skills.md`, „X”\n// `docs/nie-ma.md`, „Y”');
    const docs: Record<string, string> = { 'docs/a.md': '## Jest\n' };
    expect(misses(list, (target) => docs[target] ?? null)).toEqual([
      'a.ts:1: docs/a.md nie ma nagłówka „Brak”',
      'a.ts:3: docs/nie-ma.md, „Y” — nie ma takiego dokumentu (ścieżka od korzenia repo, w dokumencie .md także od '
        + 'jego katalogu; strona dokumentacji Claude Code idzie na listę CLAUDE_CODE_DOCS)',
    ]);
  });
});

describe('mutacja: podłożone naruszenie przewraca strażnika', () => {
  /** Prawdziwy dokument widoku eksportu z cytowaniem drugiego prawdziwego dokumentu. */
  const doc = guarded.find((cite) => cite.file.endsWith('.md') && cite.target !== cite.file);

  it('cytat po angielsku do nagłówka, którego nie ma, w kodzie i w dokumencie', () => {
    expect(doc, 'brak cytowania między dokumentami do mutacji').toBeDefined();
    if (doc === undefined) return;
    const planted = [
      ...citations('server/src/x.ts', `// see \`${doc.target}\`, "No such section"`),
      ...citations(doc.file, `See "No such section" in \`${doc.target}\`.`),
    ].map((cite) => ({ ...cite, target: resolveDoc(cite.file, cite.target, exists) }));
    expect(misses(planted, read)).toEqual([
      `server/src/x.ts:1: ${doc.target} nie ma nagłówka „No such section”`,
      `${doc.file}:1: ${doc.target} nie ma nagłówka „No such section”`,
    ]);
  });

  it('dokument po zmianie nazwy bez poprawki cytatu', () => {
    if (doc === undefined) return;
    const renamed = (target: string): string | null => (target === doc.target ? null : read(target));
    expect(misses([doc], renamed)[0]).toContain(`${doc.target}, „${doc.title}” — nie ma takiego dokumentu`);
  });
});
