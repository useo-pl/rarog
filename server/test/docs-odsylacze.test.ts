/**
 * Strażnik odsyłaczy: każda goła ścieżka `*.md` i każdy odnośnik względny `[..](..)` w widoku eksportu (kod, testy,
 * konfiguracja i dokumenty, poza fixture'ami) prowadzi do istniejącego pliku widoku eksportu. Dokument przemianowany
 * albo usunięty bez poprawki odsyłaczy przewraca ten test. Formy odsyłacza, rozwiązywanie i to, czego strażnik nie
 * sprawdza: `docs-odsylacze.ts`. Strażnik czyta tylko pliki widoku eksportu; warstwę prywatną zna wyłącznie z listy
 * plików (`private-guard.ts`), bez ich treści.
 *
 * Porażka: popraw ścieżkę na istniejący plik (w kodzie od korzenia repo, w dokumencie od jego katalogu albo od
 * korzenia). Ścieżka, która jest daną, a nie odsyłaczem, idzie na listę {@link WYJATKI} z powodem.
 */
import { describe, expect, it } from 'vitest';
import {
  FOREIGN_NAMES, brokenReferences, references, resolvesTo, type Reference, type Tree,
} from './docs-odsylacze.ts';
import { PRIVATE_LAYER, REPO, inExportView, isFixture } from './private-guard.ts';
import { repoFiles, repoTextFiles } from './source-scan.ts';

/**
 * Odsyłacz, który zostaje mimo braku pliku: klucz `plik ścieżka`, wartość to powód. Wpis bez trafienia jest błędem,
 * więc lista nie obrasta martwymi wyjątkami.
 */
const WYJATKI: ReadonlyMap<string, string> = new Map([
  ['native/Rarog/Packages/RarogUI/Sources/RarogUI/Terminal/TerminalDemoSeam.swift docs/old-notes.md',
    'dane demo: udawany wynik `git status` z usuniętym plikiem (`D`), którego celowo nie ma'],
  ['server/src/demo/files.ts docs/guide.md',
    'demo data: a file of the demo project tree, held in memory, not in the repository'],
  ['native/Rarog/RarogUIKitTests/TranscriptFileOpenTests.swift docs/guide.md',
    'test data: a path in an agent reply and in the session file index of the test, not a reference'],
  ['native/Rarog/RarogUITests/InspectorUITests+Files.swift inspector.git.file.README.md',
    'the accessibility identifier of a demo project file row, not a reference'],
]);

/**
 * Najmniejsza liczba odsyłaczy, które strażnik sprawdził i które prowadzą do istniejącego pliku. Migracja nazw nie
 * może zgubić odsyłaczy po cichu (np. przez formę, której wzorzec nie widzi). Próg obniża tylko świadome cięcie:
 * skrót dokumentów po angielsku usunął odsyłacze między dokumentami i do warstwy prywatnej, zostało 727.
 */
const MIN_ODSYLACZY = 725;

const view = repoFiles(REPO).filter(inExportView);
const viewFiles = new Set(view);
const viewDirs = new Set(['']);
for (const file of view) {
  for (let at = file.lastIndexOf('/'); at > 0; at = file.lastIndexOf('/', at - 1)) viewDirs.add(file.slice(0, at));
}
const tree: Tree = {
  exists: (file) => viewFiles.has(file),
  isDir: (dir) => viewDirs.has(dir),
  isPrivate: (file) => PRIVATE_LAYER.has(file),
};
/** Plik strażnika: widok eksportu bez fixture'ów; dokument w katalogu fixture'ów (jego README) zostaje. */
const skip = (file: string): boolean => !inExportView(file) || (isFixture(file) && !file.endsWith('.md'));
const found: Reference[] = [...repoTextFiles(REPO, undefined, skip)].flatMap(([file, text]) => references(file, text));
const key = (ref: Reference): string => `${ref.file} ${ref.raw}`;
const checked = found.filter((ref) => !WYJATKI.has(key(ref)));

describe('odsyłacze w widoku eksportu', () => {
  it('każdy prowadzi do istniejącego pliku', () => {
    expect(brokenReferences(checked, tree), 'Popraw ścieżkę na istniejący plik').toEqual([]);
  });

  it(`co najmniej ${String(MIN_ODSYLACZY)} odsyłaczy prowadzi do pliku (migracja nie gubi ich po cichu)`, () => {
    const live = checked.filter((ref) => resolvesTo(ref, tree) !== null);
    expect(live.length, `odsyłaczy do istniejących plików: ${String(live.length)}`).toBeGreaterThanOrEqual(MIN_ODSYLACZY);
  });

  it('każdy wyjątek WYJATKI ma trafienie', () => {
    const used = new Set(found.map(key));
    expect([...WYJATKI.keys()].filter((entry) => !used.has(entry)), 'Usuń wyjątek bez trafienia').toEqual([]);
  });
});

describe('rozpoznanie odsyłacza', () => {
  const raws = (file: string, text: string): string[] => references(file, text).map((ref) => `${ref.kind} ${ref.raw}`);

  it('goła ścieżka z backtickami i bez; odnośnik i obrazek w dokumencie, cel odnośnika liczony raz', () => {
    expect(raws('docs/x.md', 'Zob. `docs/a.md` i b.md, [tekst](c.md#kotwica), ![obraz](img/d.png "tytuł").')).toEqual([
      'odnosnik c.md#kotwica', 'odnosnik img/d.png', 'sciezka docs/a.md', 'sciezka b.md',
    ]);
  });

  it('odnośnik w `…` i w bloku kodu to nie odnośnik; w kodzie odnośników nie ma', () => {
    expect(raws('docs/x.md', '`[a](b.md)`\n```md\n[c](d/)\n```\n[e](f/)')).toEqual(['sciezka b.md', 'odnosnik f/']);
    expect(raws('server/src/x.ts', 'handlers[name](arg); // [a](b/)')).toEqual([]);
  });

  it('w pliku testu tylko linie komentarza: ścieżka w napisie to dana', () => {
    expect(raws('server/test/x.test.ts', "const p = 'docs/a.md';\n// opis: `docs/b.md`")).toEqual(['sciezka docs/b.md']);
  });

  it('ścieżka w środku innej ścieżki albo adresu to nie odsyłacz', () => {
    expect(raws('server/src/x.ts', '~/.claude/skills/x/SKILL.md https://example.com/docs/a.md')).toEqual([]);
  });

  it('dokument `.md` w katalogu testów (README fixture\'ów) liczy się w całości', () => {
    expect(raws('server/test/fixtures/herdr/README.md', 'Zob. `docs/a.md` i [opis](../b.md).')).toEqual([
      'odnosnik ../b.md', 'sciezka docs/a.md',
    ]);
  });
});

describe('rozwiązanie odsyłacza', () => {
  const files = new Set(['README.md', 'docs/a.md', 'docs/b.md', 'native/README.md', 'scripts/x.sh']);
  const dirs = new Set(['', 'docs', 'native', 'scripts', 'server', 'server/src']);
  const fake: Tree = { exists: (f) => files.has(f), isDir: (d) => dirs.has(d), isPrivate: (f) => f === 'docs/prywatny.md' };
  const broken = (file: string, text: string): string[] => brokenReferences(references(file, text), fake);

  it('w dokumencie od jego katalogu, potem od korzenia; odnośnik tylko od katalogu, `/` od korzenia, katalog', () => {
    expect(broken('docs/a.md', '`b.md`, `docs/b.md`, [x](b.md), [y](../scripts/), [z](/README.md), [r](../)'))
      .toEqual([]);
    expect(broken('docs/a.md', '[x](docs/b.md)')).toEqual([
      'docs/a.md:1: odnośnik (docs/b.md) prowadzi do docs/docs/b.md, a takiego pliku ani katalogu nie ma',
    ]);
  });

  it('w kodzie od korzenia: goła nazwa dokumentu z docs/ to martwy odsyłacz', () => {
    expect(broken('server/src/x.ts', '// `docs/a.md` i `a.md`')).toEqual([
      'server/src/x.ts:1: a.md — nie ma takiego pliku (ścieżka od korzenia repo, w dokumencie .md także od jego katalogu)',
    ]);
  });

  it('bez sprawdzenia: strona Claude Code, nazwa spoza repo, plik prywatny, katalog spoza widoku eksportu', () => {
    expect(FOREIGN_NAMES.has('SKILL.md')).toBe(true);
    expect(broken('server/src/x.ts', '// skills.md SKILL.md docs/prywatny.md .claude/skills/x/SKILL.md apps/w/a.md'))
      .toEqual([]);
    expect(broken('docs/a.md', 'code.claude.com/docs/en/commands.md [x](https://example.com/y.md) [s](#sekcja)'))
      .toEqual([]);
  });
});

describe('mutacja: podłożone naruszenie przewraca strażnika', () => {
  it('martwa ścieżka i martwy odnośnik w dokumencie, martwa ścieżka w kodzie', () => {
    const planted = [
      ...references('docs/README.md', 'Zob. `docs/nie-ma-takiego.md` i [opis](nie-ma-takiego.md).'),
      ...references('server/src/x.ts', '// opis: `docs/nie-ma-takiego.md`'),
      ...references('docs/README.md', 'Zob. `docs/nie-ma-katalogu/brak.md`.'),
    ];
    expect(brokenReferences(planted, tree)).toHaveLength(4);
  });

  it('dokument przemianowany bez poprawki odsyłaczy', () => {
    const toDesign = checked.filter((ref) => resolvesTo(ref, tree) === 'docs/design.md');
    expect(toDesign.length, 'odsyłacze do docs/design.md w widoku eksportu').toBeGreaterThan(0);
    const renamed: Tree = { ...tree, exists: (file) => file !== 'docs/design.md' && tree.exists(file) };
    expect(brokenReferences(toDesign, renamed)).toHaveLength(toDesign.length);
  });
});
