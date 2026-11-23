/**
 * Guard of the dialog block (`docs/dialogs.md`, „Rules: what must not be relaxed”).
 *
 * Why: the dialog identity comes only from the BLOCK the CLI draws (`dialogBlock` in
 * `server/src/herdr/dialogs/screen/block.ts`; screens in the `server/test/fixtures/herdr/` fixtures). Patterns
 * applied to the WHOLE screen would let „Switch model” in the scrollback or `⏺ Read(` in a command change what Rarog
 * approves. This test keeps the patterns that can yield an identity from the whole screen inside the functions that
 * compute the block:
 *
 * - linia kodu z wzorcem z `SLEDZONE` stoi tylko w deklaracji z `DOZWOLONE` (najbliższa w górę linia z deklaracją
 *   w kolumnie 0) albo jest linią z `LINIE` (cała linia po `trim()`, np. reeksport w `index.ts`);
 * - wpis `DOZWOLONE` albo `LINIE`, który nic nie trafia, jest błędem (lista się nie starzeje);
 * - ciało `matchKnownDialog` nie wykonuje żadnego wzorca: oddaje pole policzone w bloku.
 *
 * Linie komentarzy (`*`, `//`, `/*` na początku) się nie liczą: dokumentacja opisuje też historię wzorców.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = 'server/src';
const BLOK = 'server/src/herdr/dialogs/screen/block.ts';
const ZNANE = 'server/src/herdr/dialogs/screen/known.ts';

/**
 * Patterns that can yield the tool name or a known dialog from the whole screen: the call line `⏺ Narzędzie(`,
 * the table of known dialogs and its signatures, the map of consent titles with its signatures and the rule line
 * (`Ask rule Name(`, and `Rule Name(` from CLI 2.1.328).
 */
const SLEDZONE = [
  /\bTOOL_CALL_PATTERN\b/u,
  /\bSCREEN_SIGNATURES\.toolCall\b/u,
  /\bKNOWN_DIALOGS\b/u,
  /\bSCREEN_SIGNATURES\.knownDialog\w*/u,
  /\bTOOL_DIALOG_HEADERS\b/u,
  /\bdialogTitleTool\(/u,
  /\bASK_RULE_PATTERN\b/u,
  /\bRULE_PATTERN\b/u,
  /\bSKILL_DIALOG_TITLE\b/u,
  /\bSCREEN_SIGNATURES\.toolDialogHeader\w*/u,
] as const;

interface Dozwolone {
  readonly plik: string;
  /** Nazwa deklaracji w kolumnie 0 (`function X(`, `const X`, `type X`), w której trafienie jest dozwolone. */
  readonly w: string;
  readonly powod: string;
}

const DOZWOLONE: readonly Dozwolone[] = [
  { plik: BLOK, w: 'TOOL_CALL_PATTERN', powod: 'definicja stałej' },
  { plik: BLOK, w: 'TOOL_DIALOG_HEADERS', powod: 'definicja mapy tytułów' },
  { plik: BLOK, w: 'ASK_RULE_PATTERN', powod: 'definicja stałej' },
  { plik: BLOK, w: 'RULE_PATTERN', powod: 'constant definition (the rule line as CLI 2.1.328 words it)' },
  { plik: BLOK, w: 'SKILL_DIALOG_TITLE', powod: 'definicja wzorca tytułu zgody `Skill`' },
  { plik: ZNANE, w: 'KNOWN_DIALOGS', powod: 'definicja tabeli znanych dialogów z jej sygnaturami' },
  { plik: ZNANE, w: 'KnownDialogId', powod: 'typ identyfikatora z tabeli' },
  { plik: BLOK, w: 'regionCallTrace', powod: 'ślad wywołania w regionie: wyłącznie sygnał negatywny' },
  { plik: BLOK, w: 'dialogTitleTool', powod: 'mapa tytułu na nazwę, wołana z tytułu bloku' },
  { plik: BLOK, w: 'blockTitleOf', powod: 'tytuł pod kreską bloku' },
  { plik: BLOK, w: 'queuedTitleTool', powod: 'tytuł bloku z licznikiem kolejki: wyłącznie dowód całej ramki `Bash`' },
  { plik: BLOK, w: 'toolNaming', powod: 'nazwa z bloku: tytuł albo `Ask rule` w strefie operacji' },
  { plik: ZNANE, w: 'blockKnownDialog', powod: 'znany dialog z tytułu albo treści bloku' },
  {
    plik: 'server/src/herdr/dialogs/screen/trust-arrow.ts', w: 'parseTrustArrowDialog',
    powod: 'zdanie zaufania w treści bloku nad dwiema opcjami strzałki, pod tytułem `trust`',
  },
  {
    plik: 'server/src/herdr/dialogs/screen/edit-frame.ts', w: 'writeFrameKind',
    powod: 'rodzaj ramki `Write` (treść nowego pliku albo diff nadpisania) z tytułu całego dialogu, którego nazwę '
      + 'już potwierdził blok: tylko odczyt treści do dowodu pliku, nie tożsamość',
  },
];

/** Linie spoza deklaracji: cała linia po `trim()`. */
const LINIE: readonly { readonly plik: string; readonly linia: string; readonly powod: string }[] = [
  {
    plik: 'server/src/herdr/index.ts',
    linia: "export { KNOWN_DIALOGS, matchKnownDialog } from './dialogs/screen/known.ts';",
    powod: 'reeksport modułu',
  },
  {
    plik: BLOK,
    linia: "import { KNOWN_DIALOGS } from './known.ts';",
    powod: 'import tabeli dla `blockTitleOf` (tytuł bloku z listy znanych dialogów)',
  },
];

const DEKLARACJA = /^(?:export\s+)?(?:async\s+)?(?:function\*?\s+|const\s+|let\s+|type\s+|interface\s+|class\s+)(\w+)/u;

const komentarz = (linia: string): boolean => {
  const t = linia.trim();
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*');
};

function plikiSrc(): string[] {
  return readdirSync(path.join(REPO, SRC), { recursive: true, encoding: 'utf8' })
    .filter((p) => p.endsWith('.ts'))
    .map((p) => path.posix.join(SRC, p.split(path.sep).join('/')))
    .sort();
}

const czytaj = (plik: string): string[] => readFileSync(path.join(REPO, plik), 'utf8').split('\n');

/** Najbliższa w górę deklaracja w kolumnie 0 (albo `null`, gdy linia stoi przed pierwszą). */
function deklaracjaNad(linie: readonly string[], i: number): string | null {
  for (let j = i; j >= 0; j -= 1) {
    const m = DEKLARACJA.exec(linie[j] ?? '');
    if (m !== null) return m[1] ?? null;
  }
  return null;
}

describe('blok dialogu: tożsamość wyłącznie z bloku', () => {
  it('wzorce dawnej tożsamości z całego ekranu stoją tylko w funkcjach liczących blok', () => {
    const uzyteD = new Set<Dozwolone>();
    const uzyteL = new Set<(typeof LINIE)[number]>();
    const obce: string[] = [];
    for (const plik of plikiSrc()) {
      const linie = czytaj(plik);
      linie.forEach((linia, i) => {
        if (komentarz(linia) || !SLEDZONE.some((w) => w.test(linia))) return;
        const l = LINIE.find((e) => e.plik === plik && e.linia === linia.trim());
        if (l !== undefined) {
          uzyteL.add(l);
          return;
        }
        const w = deklaracjaNad(linie, i);
        const d = DOZWOLONE.find((e) => e.plik === plik && e.w === w);
        if (d !== undefined) {
          uzyteD.add(d);
          return;
        }
        obce.push(`${plik}:${i + 1} (w ${w ?? '—'}): ${linia.trim()}`);
      });
    }
    expect(obce).toEqual([]);
    expect(DOZWOLONE.filter((d) => !uzyteD.has(d)).map((d) => `${d.plik} ${d.w}`)).toEqual([]);
    expect(LINIE.filter((l) => !uzyteL.has(l)).map((l) => `${l.plik}: ${l.linia}`)).toEqual([]);
  });

  it('`matchKnownDialog` nie wykonuje wzorca: oddaje znany dialog policzony w bloku', () => {
    const linie = czytaj(ZNANE);
    const start = linie.findIndex((l) => l.startsWith('export function matchKnownDialog('));
    expect(start).toBeGreaterThan(-1);
    const koniec = linie.findIndex((l, i) => i > start && l === '}');
    expect(koniec).toBeGreaterThan(start);
    const cialo = linie.slice(start, koniec + 1).filter((l) => !komentarz(l)).join('\n');
    expect(cialo).not.toMatch(/\.test\(|\.exec\(|\.match\(|\.search\(|\.includes\(|stripTerminalControl/u);
    expect(cialo).toMatch(/return dialog\.knownDialog;/u);
  });
});
