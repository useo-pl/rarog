/**
 * Blok warstwy 2 na całym korpusie (opis: `docs/dialogs.md`, „Dialog block” i „Control set”):
 * `readBlock` i `shapeOf` nad każdym commitowanym ekranem.
 *
 * Korpus jest ten sam co w `dialogs-full-cards.test.ts`: `.txt` z korzenia `fixtures/herdr/`,
 * z `measured/`, `refusals/`, `queue/measured/` i `kontrolny/`. Test sprawdza cztery rzeczy:
 *
 * - kształt z rejestru mają dokładnie ekrany z polem `shape` w manifeście zestawu kontrolnego, każdy inny ekran
 *   korpusu go nie ma (zgody i formularze tym bardziej);
 * - odcisk `readBlock` jest dzisiejszym odciskiem bloku: równy `screenPrint` z pliku złotego
 *   `karty-korpusu-pelne.json` na każdym ekranie spoza rodzaju `tool`, gdzie oba istnieją;
 * - `readBlock` czyta górę, tytuł, cyfry i stopkę tak, jak zapisał je człowiek w manifeście;
 * - rejestr kształtów i manifest się zgadzają (test manifestu): każdy kształt rejestru ma plik
 *   w `kontrolny/` z werdyktem `buttons` i tymi samymi cyframi, a każdy wpis manifestu z werdyktem `buttons` poza
 *   formularzem ma kształt w rejestrze.
 *
 * Plik złoty tylko czytamy: ten test go nie produkuje.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readBlock } from '../src/herdr/dialogs/layer2/read-block.ts';
import { shapeOf } from '../src/herdr/dialogs/layer2/match.ts';
import { BLOCK_SHAPES } from '../src/herdr/dialogs/layer2/shapes.ts';
import { optionEscalates } from '../src/herdr/dialogs/policy/escalation.ts';
import { askFormOnScreen } from '../src/herdr/dialogs/presence.ts';
import { SCREEN_SIGNATURES } from '../src/herdr/dialogs/screen/signatures.ts';

const DIR = join(import.meta.dirname, 'fixtures', 'herdr');
const MARK = '\n--- ekran ---\n';

/** Katalogi korpusu względem `fixtures/herdr/` (te same co w pełnym pliku złotym). */
const DIRS = ['', 'measured/', 'refusals/', 'queue/measured/', 'kontrolny/'] as const;

const CORPUS = DIRS.flatMap((sub) => readdirSync(join(DIR, sub))
  .filter((name) => name.endsWith('.txt'))
  .map((name) => `${sub}${name}`))
  .sort();

/** Ekran fixture'u; zrzut odmowy (`refusals/`) ma nad ekranem nagłówek `klucz: wartość`. */
function screenOf(name: string): string {
  const raw = readFileSync(join(DIR, name), 'utf8');
  const at = raw.indexOf(MARK);
  return at < 0 ? raw : raw.slice(at + MARK.length);
}

interface GoldenScreen {
  readonly dialogKind: string | null;
  readonly screenPrint: string | null;
}
const GOLDEN = JSON.parse(readFileSync(join(DIR, 'karty-korpusu-pelne.json'), 'utf8')) as {
  readonly screens: Readonly<Record<string, GoldenScreen>>;
};

interface ManifestEntry {
  readonly id: string;
  readonly file: string;
  readonly cli: string;
  readonly waitingFor: { readonly status: string | null; readonly value: string | null } | null;
  readonly shape?: string | null;
  readonly block: {
    readonly top: 'bare-rule' | 'status-rule';
    readonly title: string;
    readonly options: readonly { readonly digit: string }[];
    readonly footer: string | null;
    readonly complete: boolean;
  };
  readonly policy: { readonly verdict: 'buttons' | 'no-buttons'; readonly buttons: readonly string[] };
}
const MANIFEST = JSON.parse(readFileSync(join(DIR, 'kontrolny', 'manifest.json'), 'utf8')) as {
  readonly shapes: readonly ManifestEntry[];
  readonly missing: readonly { readonly id: string; readonly title: string }[];
};

/**
 * Zgody: rodzaj `tool` w pełnym pliku złotym oraz zgody, których dzisiejszy parser nie czyta jako `tool` (wąski
 * panel, zgoda `WebFetch` czytana jako potwierdzenie, przewinięty widok zgody `Bash`).
 */
const CONSENTS_OUTSIDE_TOOL = [
  'dialog-bash-przewiniety-widok-2.1.295.txt',
  'measured/zgoda-notebookedit-waski-2.1.311.txt',
  'measured/zgoda-webfetch-2.1.311.txt',
  'measured/zgoda-webfetch-waski-2.1.311.txt',
];
const CONSENTS = CORPUS.filter((name) => GOLDEN.screens[name]?.dialogKind === 'tool'
  || CONSENTS_OUTSIDE_TOOL.includes(name));
const FORMS = CORPUS.filter((name) => askFormOnScreen(screenOf(name)) === 'form');

const shapeIdOf = (name: string): string | null => shapeOf(readBlock(screenOf(name)))?.shape.id ?? null;
const isForm = (entry: ManifestEntry): boolean => askFormOnScreen(screenOf(entry.file)) === 'form';

describe('readBlock i shapeOf na całym korpusie', () => {
  it('korpus jest ten sam co w pełnym pliku złotym, a odczyt przechodzi przez każdy ekran', () => {
    expect(CORPUS).toEqual(Object.keys(GOLDEN.screens).sort());
    for (const name of CORPUS) expect(() => shapeOf(readBlock(screenOf(name))), name).not.toThrow();
  });

  it('kształt mają dokładnie ekrany z polem `shape` w manifeście, z tym samym identyfikatorem', () => {
    const expected = new Map(MANIFEST.shapes.map((entry) => [entry.file, entry.shape ?? null]));
    const differences = CORPUS
      .map((name) => ({ name, expected: expected.get(name) ?? null, actual: shapeIdOf(name) }))
      .filter((row) => row.expected !== row.actual);
    expect(differences).toEqual([]);
    expect(CORPUS.filter((name) => shapeIdOf(name) !== null).length).toBeGreaterThan(0);
  });

  it('każdy wpis manifestu ma pole `shape`: identyfikator z rejestru albo `null`', () => {
    const ids = BLOCK_SHAPES.map((shape) => shape.id);
    for (const entry of MANIFEST.shapes) {
      expect(Object.hasOwn(entry, 'shape'), entry.id).toBe(true);
      if (entry.shape !== null) expect(ids, entry.id).toContain(entry.shape);
    }
  });

  it('zgody i formularze nie mają kształtu', () => {
    expect(CONSENTS.length).toBeGreaterThan(0);
    expect(FORMS.length).toBeGreaterThan(0);
    expect(CONSENTS.filter((name) => shapeIdOf(name) !== null)).toEqual([]);
    expect(FORMS.filter((name) => shapeIdOf(name) !== null)).toEqual([]);
  });

  it('treść z CLI 2.1.241 („…re-read on your next message.”) do kształtu nie pasuje', () => {
    const block = readBlock(screenOf('dialog-model-switch.txt'));
    expect(block?.title).toBe('Switch model?');
    expect(shapeOf(block)).toBeNull();
  });
});

describe('odcisk readBlock to dzisiejszy odcisk bloku', () => {
  it('równy `screenPrint` pliku złotego na każdym ekranie spoza `tool`, gdzie oba istnieją', () => {
    let compared = 0;
    const differences: string[] = [];
    const withoutBlock: string[] = [];
    for (const name of CORPUS) {
      const golden = GOLDEN.screens[name];
      if (golden === undefined || golden.dialogKind === 'tool' || golden.screenPrint === null) continue;
      const block = readBlock(screenOf(name));
      if (block === null) {
        withoutBlock.push(name);
        continue;
      }
      compared += 1;
      if (block.print !== golden.screenPrint) differences.push(name);
    }
    expect(differences).toEqual([]);
    // Parser ma odcisk bloku, więc warstwa 2 też widzi tam blok.
    expect(withoutBlock).toEqual([]);
    expect(compared).toBeGreaterThan(0);
  });
});

/**
 * Measured blocks that `readBlock` reads with other digits than the manifest records; empty today. An entry pins the
 * digits read today, so a reader fix fails here: then the entry goes. A numbered list in the dialog body (the phases of
 * the workflow approval dialog) is no such case: the options are the numbered run directly above the key footer, and
 * numbered lines above a digitless choice are body (`screen/option-run.ts`).
 */
const KNOWN_MISREADS: Readonly<Record<string, readonly string[]>> = {};

/** Measured blocks whose rule and title stand above the pane edge (`complete: false`): there is no block to read. */
const TOP_ABOVE_EDGE: readonly string[] = ['kontrolny/importy-zewnetrzne-dluga-lista-2.1.332.txt'];

/** Manifest captures read as a tool consent without an operation frame above the options: layer 2 reads the block. */
const TOOL_WITHOUT_FRAME: readonly string[] = [
  'kontrolny/zatwierdzenie-workflow-2.1.322.txt',
  'kontrolny/zatwierdzenie-workflow-waski-2.1.322.txt',
];

describe('readBlock a manifest zestawu kontrolnego', () => {
  const FOOTER = SCREEN_SIGNATURES.dialogKeyFooter.pattern;

  it('known misreads name manifest files whose recorded digits differ from the pinned ones', () => {
    for (const [file, digits] of Object.entries(KNOWN_MISREADS)) {
      const entry = MANIFEST.shapes.find((candidate) => candidate.file === file);
      expect(entry, file).toBeDefined();
      expect(entry?.block.options.map((option) => option.digit), file).not.toEqual(digits);
    }
  });

  it.each(MANIFEST.shapes.map((entry) => [entry.id, entry] as const))('%s: góra, tytuł, cyfry i stopka', (_, entry) => {
    const block = readBlock(screenOf(entry.file));
    if (TOP_ABOVE_EDGE.includes(entry.file)) {
      expect(entry.block.complete).toBe(false);
      expect(block).toBeNull();
      return;
    }
    const misread = KNOWN_MISREADS[entry.file];
    if (misread !== undefined) {
      expect(block).not.toBeNull();
      expect(`${block?.top.kind}-rule`).toBe(entry.block.top);
      expect(block?.title).toBe(entry.block.title);
      expect(block?.options.map((option) => option.digit), 'pinned misread').toEqual(misread);
      if (entry.block.footer !== null) expect(block?.footer).toBe(entry.block.footer);
      return;
    }
    // Zgoda narzędzia (rodzaj `tool`) ma nad opcjami ramkę operacji `╌╌╌`, bliższą niż kreska bloku: warstwa 2 nie
    // czyta tam bloku (`layer2/read-block.ts`), więc blok z manifestu sprawdza tylko test zestawu kontrolnego.
    // A tool consent without that frame (the workflow approval summary) has its block read like any other.
    if (GOLDEN.screens[entry.file]?.dialogKind === 'tool' && !TOOL_WITHOUT_FRAME.includes(entry.file)) {
      expect(block).toBeNull();
      return;
    }
    expect(block).not.toBeNull();
    expect(`${block?.top.kind}-rule`).toBe(entry.block.top);
    expect(block?.options.map((option) => option.digit)).toEqual(entry.block.options.map((option) => option.digit));
    // Formularz pytania ma nad pytaniem pasek zakładek, a manifest zapisuje jako tytuł samo pytanie.
    if (!isForm(entry)) expect(block?.title).toBe(entry.block.title);
    // The manifest records one footer line; the block footer runs from the first key line to the bottom (a wrapped
    // footer, a second key line), so the recorded line is part of it.
    if (entry.block.footer !== null && FOOTER.test(entry.block.footer)) {
      expect(block?.footer).toContain(entry.block.footer);
    }
  });
});

describe('rejestr kształtów a manifest (test manifestu)', () => {
  it('każdy kształt rejestru ma zrzut w `kontrolny/` z werdyktem `buttons`, tymi samymi cyframi i wersją', () => {
    for (const shape of BLOCK_SHAPES) {
      const entry = MANIFEST.shapes.find((candidate) => candidate.file === shape.fixture);
      expect(entry, shape.id).toBeDefined();
      expect(shape.fixture.startsWith('kontrolny/'), shape.id).toBe(true);
      expect(entry?.shape).toBe(shape.id);
      expect(entry?.cli).toBe(shape.cli);
      expect(entry?.policy.verdict).toBe('buttons');
      expect(entry?.policy.buttons).toEqual(shape.buttons);
      const match = shapeOf(readBlock(screenOf(shape.fixture)));
      expect(match?.shape.id).toBe(shape.id);
      expect(match?.buttons).toEqual(shape.buttons);
      expect(match?.allow?.digit).toBe(shape.allow);
    }
  });

  it('każdy wpis z werdyktem `buttons` poza formularzem ma kształt w rejestrze z tymi samymi cyframi', () => {
    for (const entry of MANIFEST.shapes.filter((candidate) => candidate.policy.verdict === 'buttons')) {
      if (isForm(entry)) continue;
      const shape = BLOCK_SHAPES.find((candidate) => candidate.id === entry.shape);
      expect(shape, entry.id).toBeDefined();
      expect(entry.policy.buttons, entry.id).toEqual(shape?.buttons);
    }
  });

  it('wpis z kształtem ma werdykt `buttons`, cyfry kształtu i zmierzoną klasę rejestru CLI kształtu', () => {
    for (const entry of MANIFEST.shapes.filter((candidate) => candidate.shape !== null)) {
      const shape = BLOCK_SHAPES.find((candidate) => candidate.id === entry.shape);
      expect(entry.policy.verdict, entry.id).toBe('buttons');
      expect(entry.policy.buttons, entry.id).toEqual(shape?.buttons);
      if (entry.waitingFor?.value != null) expect(entry.waitingFor.value, entry.id).toBe(shape?.waitingFor);
    }
  });

  it('każdy rodzaj góry z `tops` ma zrzut w manifeście', () => {
    for (const shape of BLOCK_SHAPES) {
      const seen = MANIFEST.shapes
        .filter((entry) => entry.shape === shape.id)
        .map((entry) => readBlock(screenOf(entry.file))?.top.kind);
      for (const kind of shape.tops) expect(seen, `${shape.id}: ${kind}`).toContain(kind);
    }
  });

  it('przyciski to cyfry opcji kształtu, `allow` ma przycisk, a etykiety przycisków nie eskalują', () => {
    for (const shape of BLOCK_SHAPES) {
      const digits = shape.options.map((option) => option.digit);
      for (const digit of shape.buttons) expect(digits, shape.id).toContain(digit);
      expect(shape.buttons, shape.id).toContain(shape.allow);
      for (const entry of MANIFEST.shapes.filter((candidate) => candidate.shape === shape.id)) {
        const match = shapeOf(readBlock(screenOf(entry.file)));
        for (const pair of match?.pairs ?? []) {
          if (pair.button) expect(optionEscalates(pair.label), `${entry.id}: ${pair.label}`).toBe(false);
        }
      }
    }
  });

  it('dialog bez zrzutu (`missing`) nie ma kształtu: „Change effort level?” czeka na pomiar', () => {
    const titles = BLOCK_SHAPES.map((shape) => shape.title);
    for (const missing of MANIFEST.missing) expect(titles, missing.id).not.toContain(missing.title);
    expect(BLOCK_SHAPES.map((shape) => shape.command)).not.toContain('effort');
  });
});
