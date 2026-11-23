/**
 * Własności warstwy 2 (opis: `docs/dialogs.md`, „Dialog block”): mutacje ekranu 1–10 i sześć własności
 * nad `readBlock` i `shapeOf`, fast-check 4.9.0.
 *
 * Wejście: każdy commitowany ekran z kształtem z rejestru (pole `shape` w manifeście zestawu kontrolnego) oraz ekrany
 * zgód z korpusu. Mutacje z prostą przestrzenią (ucięcie, usunięcie linii, zawinięcie, kreska, licznik, zamiana cyfr)
 * idą WYCZERPUJĄCO po każdej pozycji bloku; losowe (linia z korpusu, SGR, nazwa modelu, dopisek, zgody) przez
 * fast-check.
 *
 * - Bez dowodu końca nie ma przycisku: mutacje 1, 2, 3c, 4, 5, 6, 9 i 10 dają `shapeOf` `null`.
 * - Odcisk łapie zmianę: model bramki kroku przed cyfrą (ten sam kształt, ten sam odcisk, ta sama para
 *   „zatwierdź”) przepuszcza wyłącznie blok o tej samej treści co blok karty.
 * - Szum i zawinięcie treści nie zmieniają werdyktu: SGR daje ten sam kształt i odcisk; treść zawinięta na
 *   granicy słowa ten sam kształt i tę samą wartość; treść przecięta w środku słowa kształt z tą samą wartością albo
 *   `null`.
 * - Zgoda nigdy do warstwy 2: żaden mutant ekranu zgody nie pasuje do kształtu.
 * - Polityka: żadna cyfra z przyciskiem nie ma etykiety eskalującej.
 * - Wartość spójna: różna nazwa w treści i w etykiecie daje `null`; ta sama nazwa spoza wzorca też.
 */
import fc from 'fast-check';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { matchShape, shapeOf } from '../src/herdr/dialogs/layer2/match.ts';
import type { ShapeMatch } from '../src/herdr/dialogs/layer2/match.ts';
import { readBlock } from '../src/herdr/dialogs/layer2/read-block.ts';
import type { Block } from '../src/herdr/dialogs/layer2/read-block.ts';
import { BLOCK_SHAPES } from '../src/herdr/dialogs/layer2/shapes.ts';
import { optionEscalates } from '../src/herdr/dialogs/policy/escalation.ts';
import { optionPolicy } from '../src/herdr/dialogs/policy/option-policy.ts';
import { trimmedLines } from '../src/herdr/dialogs/screen/text.ts';

const DIR = join(import.meta.dirname, 'fixtures', 'herdr');
const MARK = '\n--- ekran ---\n';
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

const MANIFEST = JSON.parse(readFileSync(join(DIR, 'kontrolny', 'manifest.json'), 'utf8')) as {
  readonly shapes: readonly { readonly file: string; readonly shape: string | null }[];
};
const GOLDEN = JSON.parse(readFileSync(join(DIR, 'karty-korpusu-pelne.json'), 'utf8')) as {
  readonly screens: Readonly<Record<string, { readonly dialogKind: string | null }>>;
};

/** Ekran z kształtem i geometria jego bloku (indeksy w liniach po `trimmedLines`). */
interface Shaped {
  readonly name: string;
  readonly lines: readonly string[];
  readonly block: Block;
  readonly match: ShapeMatch;
  /** Nazwa modelu z dopasowania. */
  readonly value: string;
  readonly top: number;
  readonly title: number;
  /** Niepuste linie treści między tytułem a pierwszą opcją. */
  readonly body: readonly number[];
  /** Linie opcji w kolejności ekranu. */
  readonly options: readonly number[];
  /** Ostatnia linia kształtu (ostatnia opcja; pod nią nic nie ma). */
  readonly last: number;
}

function shaped(name: string): Shaped {
  const lines = trimmedLines(screenOf(name));
  const block = readBlock(lines.join('\n'));
  const match = shapeOf(block);
  if (block === null || match === null || match.value === null) throw new Error(`${name}: brak kształtu`);
  const options: number[] = [];
  for (const raw of block.optionLines) options.push(lines.indexOf(raw, (options.at(-1) ?? block.titleLine) + 1));
  const first = options[0] ?? -1;
  const body = lines.flatMap((line, i) => (i > block.titleLine && i < first && line.trim() !== '' ? [i] : []));
  return {
    name, lines, block, match, value: match.value,
    top: block.top.line, title: block.titleLine, body, options, last: options.at(-1) ?? -1,
  };
}

const SHAPED = MANIFEST.shapes.filter((entry) => entry.shape !== null).map((entry) => shaped(entry.file));

/** Zgody: rodzaj `tool` w pełnym pliku złotym i zgody, których dzisiejszy parser nie czyta jako `tool`. */
const CONSENTS = CORPUS
  .filter((name) => GOLDEN.screens[name]?.dialogKind === 'tool' || [
    'dialog-bash-przewiniety-widok-2.1.295.txt',
    'measured/zgoda-notebookedit-waski-2.1.311.txt',
    'measured/zgoda-webfetch-2.1.311.txt',
    'measured/zgoda-webfetch-waski-2.1.311.txt',
  ].includes(name))
  .map((name) => ({ name, lines: trimmedLines(screenOf(name)) }));

/** Pula linii korpusu do mutacji 6: każda niepusta linia każdego ekranu, bez powtórzeń. */
const POOL = [...new Set(CORPUS.flatMap((name) => trimmedLines(screenOf(name))).filter((line) => line.trim() !== ''))];

const verdict = (lines: readonly string[]): ShapeMatch | null => shapeOf(readBlock(lines.join('\n')));
const inserted = (lines: readonly string[], at: number, ...added: string[]): string[] =>
  [...lines.slice(0, at), ...added, ...lines.slice(at)];
const replaced = (lines: readonly string[], at: number, ...added: string[]): string[] =>
  [...lines.slice(0, at), ...added, ...lines.slice(at + 1)];
const indentOf = (line: string): string => /^ */u.exec(line)?.[0] ?? '';

/** Linie bloku od góry do ostatniej linii kształtu. */
const blockLines = (s: Shaped): number[] => Array.from({ length: s.last - s.top + 1 }, (_, k) => s.top + k);

const shapedArb = fc.constantFrom(...SHAPED);
const RUNS = { numRuns: 400 };

describe('wejście', () => {
  it('ekrany z kształtem: blok bez linii pod opcjami, a ostatnia opcja jest ostatnią linią ekranu', () => {
    expect(SHAPED.length).toBeGreaterThan(0);
    for (const s of SHAPED) {
      expect(s.block.below, s.name).toEqual([]);
      expect(s.last, s.name).toBe(s.lines.length - 1);
      expect(s.options.length, s.name).toBe(s.match.shape.options.length);
      expect(s.body.length, s.name).toBeGreaterThan(0);
    }
    expect(CONSENTS.length).toBeGreaterThan(0);
  });
});

describe('bez dowodu końca nie ma przycisku', () => {
  it('1. ucięcie: linie od k do końca ekranu usunięte, k od góry bloku do ostatniej linii kształtu', () => {
    for (const s of SHAPED) {
      for (let k = s.top; k <= s.last; k += 1) expect(verdict(s.lines.slice(0, k)), `${s.name} k=${k}`).toBeNull();
    }
  });

  it('2. usunięcie dowolnej niepustej linii bloku (kreska, tytuł, treść, opcja)', () => {
    for (const s of SHAPED) {
      for (const i of blockLines(s).filter((at) => (s.lines[at] ?? '').trim() !== '')) {
        expect(verdict(s.lines.filter((_, at) => at !== i)), `${s.name} bez linii ${i}`).toBeNull();
      }
    }
  });

  it('3c. linia opcji przełamana na dowolnej kolumnie ≥ 4', () => {
    for (const s of SHAPED) {
      for (const i of s.options) {
        const line = s.lines[i] ?? '';
        for (let column = 4; column < line.length; column += 1) {
          const head = line.slice(0, column);
          const tail = line.slice(column);
          if (head.trim() === '' || tail.trim() === '') continue;
          const wrapped = replaced(s.lines, i, head, `${indentOf(line)}   ${tail.trimStart()}`);
          expect(verdict(wrapped), `${s.name} linia ${i} kolumna ${column}`).toBeNull();
        }
      }
    }
  });

  it('4. kreska goła albo ze statusem wstawiona w dowolne miejsce bloku, także tuż nad jego górą', () => {
    const status = SHAPED.find((s) => s.block.top.kind === 'status');
    const rules = ['─'.repeat(60), '▔'.repeat(60), status?.lines[status.top] ?? ''];
    expect(rules.every((rule) => rule !== '')).toBe(true);
    for (const s of SHAPED) {
      for (let at = s.top; at <= s.last + 1; at += 1) {
        for (const rule of rules) expect(verdict(inserted(s.lines, at, rule)), `${s.name} ${at} ${rule}`).toBeNull();
      }
    }
  });

  it('5. „ k of N” dopisane do dowolnej linii bloku, także pustej', () => {
    for (const s of SHAPED) {
      for (const i of blockLines(s)) {
        for (const counter of [' 1 of 2', ' 3 of 12']) {
          const line = s.lines[i] ?? '';
          expect(verdict(replaced(s.lines, i, `${line}${counter}`)), `${s.name} linia ${i}${counter}`).toBeNull();
        }
      }
    }
  });

  it('6. dowolna niepusta linia z korpusu wstawiona w dowolne miejsce bloku pod jego górą', () => {
    expect(POOL.length).toBeGreaterThan(1000);
    const arb = shapedArb.chain((s) => fc.tuple(
      fc.constant(s),
      fc.integer({ min: s.top + 1, max: s.last + 1 }),
      fc.constantFrom(...POOL),
    ));
    fc.assert(fc.property(arb, ([s, at, line]) => verdict(inserted(s.lines, at, line)) === null), { numRuns: 1500 });
  });

  it('6. linia samej krawędzi ramki (pusta po `unbox`) wstawiona w każde miejsce bloku pod jego górą', () => {
    const frames = ['│', '   │', '│ │', '|', '┃      ┃'];
    for (const s of SHAPED) {
      for (let at = s.top + 1; at <= s.last + 1; at += 1) {
        for (const frame of frames) {
          expect(verdict(inserted(s.lines, at, frame)), `${s.name} ${at} ${frame}`).toBeNull();
        }
      }
    }
  });

  it('9. dopisek w linii opcji: ramka, checkbox, strzałka, dowolny ogon', () => {
    const tail = fc.oneof(
      fc.constantFrom(' │ always allow access', ' │', ' [ ]', ' ↓', ' ↑', ' (recommended)', '.', ' ✔'),
      fc.string({ minLength: 1, maxLength: 16 }).filter((text) => text.trim() !== ''),
    );
    const decorate = fc.oneof(
      tail.map((text) => (line: string) => `${line}${text}`),
      fc.constantFrom(
        (line: string) => line.replace(/^( *)/u, '$1│ '),
        (line: string) => line.replace(/(\d\. )/u, '↓ $1'),
        (line: string) => line.replace(/(\d\. )/u, '↑ $1'),
        (line: string) => line.replace(/(\d\. )/u, '$1[ ] '),
        (line: string) => line.replace(/(\d\. )/u, '$1☐ '),
      ),
    );
    const arb = shapedArb.chain((s) => fc.tuple(fc.constant(s), fc.constantFrom(...s.options), decorate));
    fc.assert(fc.property(arb, ([s, i, change]) => {
      const line = s.lines[i] ?? '';
      const changed = change(line);
      return changed === line || verdict(replaced(s.lines, i, changed)) === null;
    }), RUNS);
  });

  it('10. zamiana cyfr przy etykietach: cyfry zamienione w miejscu i etykiety zamienione miejscami', () => {
    for (const s of SHAPED) {
      const [one, two] = s.options;
      if (one === undefined || two === undefined) throw new Error(s.name);
      const first = s.lines[one] ?? '';
      const second = s.lines[two] ?? '';
      const digitsSwapped = replaced(
        replaced(s.lines, one, first.replace('1. ', '2. ')),
        two,
        second.replace('2. ', '1. '),
      );
      const labelsSwapped = replaced(
        replaced(s.lines, one, first.replace(/1\. .*$/u, second.trim().replace(/^❯ +/u, '').replace('2. ', '1. '))),
        two,
        second.replace(/2\. .*$/u, first.trim().replace(/^❯ +/u, '').replace('1. ', '2. ')),
      );
      expect(digitsSwapped).not.toEqual(s.lines);
      expect(labelsSwapped).not.toEqual(s.lines);
      expect(verdict(digitsSwapped), `${s.name} cyfry`).toBeNull();
      expect(verdict(labelsSwapped), `${s.name} etykiety`).toBeNull();
    }
  });

  it('góra spoza `tops` kształtu: ten sam blok bez kształtu', () => {
    for (const s of SHAPED) {
      const otherTops = { ...s.match.shape, tops: s.match.shape.tops.filter((kind) => kind !== s.block.top.kind) };
      expect(matchShape(s.match.shape, s.block), s.name).not.toBeNull();
      expect(matchShape(otherTops, s.block), s.name).toBeNull();
    }
  });
});

/** Ten sam ekran z SGR wstrzykniętym w wybrane miejsca. */
const SGR = ['\u001b[0m', '\u001b[1m', '\u001b[2;3m', '\u001b[38;5;214m', '\u001b[39;49m', '\u001b[7m'];
const sgrArb = shapedArb.chain((s) => fc.tuple(
  fc.constant(s),
  fc.array(fc.tuple(fc.nat({ max: s.lines.length - 1 }), fc.nat({ max: 200 }), fc.constantFrom(...SGR)), {
    minLength: 1,
    maxLength: 6,
  }),
));
function withSgr(lines: readonly string[], injections: readonly (readonly [number, number, string])[]): string[] {
  const out = [...lines];
  // Pozycje liczą się w linii sprzed wstrzyknięcia; od końca, żeby sekwencja nie wpadła w środek poprzedniej.
  const ordered = [...injections].sort((a, b) => b[1] - a[1]);
  for (const [i, position, sgr] of ordered) {
    const line = out[i] ?? '';
    const at = Math.min(position, (lines[i] ?? '').length);
    out[i] = `${line.slice(0, at)}${sgr}${line.slice(at)}`;
  }
  return out;
}

describe('szum i zawinięcie treści nie zmieniają werdyktu', () => {
  it('7. SGR w dowolnej linii: ten sam kształt, ta sama wartość i ten sam odcisk', () => {
    fc.assert(fc.property(sgrArb, ([s, injections]) => {
      const text = withSgr(s.lines, injections).join('\n');
      const block = readBlock(text);
      const match = shapeOf(block);
      return match?.shape.id === s.match.shape.id && match.value === s.value && block?.print === s.block.print;
    }), RUNS);
  });

  it('3a. linia treści zawinięta na granicy słowa na dowolnej kolumnie ≥ 20: ten sam kształt i wartość', () => {
    let cases = 0;
    for (const s of SHAPED) {
      for (const i of s.body) {
        const line = s.lines[i] ?? '';
        for (let column = 20; column < line.length - 1; column += 1) {
          if (line[column] !== ' ' || line[column - 1] === ' ') continue;
          const wrapped = replaced(s.lines, i, line.slice(0, column), `${indentOf(line)}${line.slice(column + 1)}`);
          const match = verdict(wrapped);
          expect(match?.shape.id, `${s.name} linia ${i} kolumna ${column}`).toBe(s.match.shape.id);
          expect(match?.value).toBe(s.value);
          cases += 1;
        }
      }
    }
    expect(cases).toBeGreaterThan(0);
  });

  it('3b. linia treści przecięta w środku słowa: kształt z tą samą wartością albo brak kształtu', () => {
    let cases = 0;
    for (const s of SHAPED) {
      for (const i of s.body) {
        const line = s.lines[i] ?? '';
        for (let column = indentOf(line).length + 1; column < line.length; column += 1) {
          if (line[column] === ' ' || line[column - 1] === ' ') continue;
          const cut = replaced(s.lines, i, line.slice(0, column), `${indentOf(line)}${line.slice(column)}`);
          const match = verdict(cut);
          if (match !== null) expect(match.value, `${s.name} linia ${i} kolumna ${column}`).toBe(s.value);
          cases += 1;
        }
      }
    }
    expect(cases).toBeGreaterThan(0);
  });
});

/** Własna kopia wzorca nazwy modelu z rejestru: zmiana wzorca w rejestrze ma czerwienić ten test. */
const MODEL_NAME = /^[A-Z][a-z]{1,15} \d{1,2}(?:\.\d{1,2}){0,2}(?: \(1M context\))?$/u;

const validName = fc.tuple(
  fc.constantFrom('Opus', 'Sonnet', 'Haiku', 'Fable', 'Mythos', 'Always', 'Trust', 'Ab'),
  fc.array(fc.integer({ min: 0, max: 99 }), { minLength: 1, maxLength: 3 }),
  fc.boolean(),
).map(([family, version, wide]) => `${family} ${version.join('.')}${wide ? ' (1M context)' : ''}`);
const nameChar = fc.constantFrom(
  'O', 'p', 'u', 's', 'a', 'Z', ' ', '5', '9', '.', '(', ')', '1M', 'context',
  '▔', '❯', '│', 'N.', '1. ', '[', ']', '\t',
);
const anyName = fc.oneof(
  validName,
  fc.array(nameChar, { minLength: 1, maxLength: 12 }).map((parts) => parts.join('')),
  fc.string({ minLength: 1, maxLength: 24 }),
  fc.constantFrom('▔', '❯', 'N.', '2. No, go back', 'Opus 5.5.5.5', 'opus 5.5', 'Opus5.5', 'Opus 5.5 (1M)', 'Ópus 5.5'),
).filter((name) => /^\S(?:.*\S)?$/u.test(name));

/** Ekran z nazwą modelu podmienioną w treści, w etykiecie opcji 1 albo w obu. */
function renamed(s: Shaped, where: 'body' | 'label' | 'both', name: string): string[] {
  let lines = [...s.lines];
  if (where !== 'label') {
    const i = s.body.find((at) => (lines[at] ?? '').includes(`Switching to ${s.value} means`));
    if (i === undefined) throw new Error(s.name);
    const line = (lines[i] ?? '').replace(`Switching to ${s.value} means`, () => `Switching to ${name} means`);
    lines = replaced(lines, i, line);
  }
  if (where !== 'body') {
    const i = s.options[0] ?? -1;
    const line = lines[i] ?? '';
    if (!line.endsWith(`switch to ${s.value}`)) throw new Error(s.name);
    lines = replaced(lines, i, `${line.slice(0, line.length - s.value.length)}${name}`);
  }
  return lines;
}

describe('wartość spójna (mutacja 8)', () => {
  it('nazwa podmieniona tylko w treści albo tylko w etykiecie: brak kształtu', () => {
    const arb = fc.tuple(shapedArb, fc.constantFrom('body' as const, 'label' as const), anyName);
    fc.assert(fc.property(arb, ([s, where, name]) => {
      fc.pre(name !== s.value);
      return verdict(renamed(s, where, name)) === null;
    }), RUNS);
  });

  it('ta sama nazwa w obu: kształt z tą nazwą, gdy pasuje do wzorca, inaczej brak kształtu', () => {
    fc.assert(fc.property(shapedArb, anyName, (s, name) => {
      const match = verdict(renamed(s, 'both', name));
      return MODEL_NAME.test(name) ? match?.value === name : match === null;
    }), { numRuns: 800 });
  });
});

describe('żadna cyfra z przyciskiem nie ma etykiety eskalującej', () => {
  const buttonsSafe = (match: ShapeMatch): boolean => match.pairs.every((pair) => !pair.button || (
    !optionEscalates(pair.label)
    && !optionPolicy({ label: pair.label, terminalDialog: null, multiSelect: false, notesEditing: false }, 'digit')
      .digitBlocked
  ));

  it('zrzuty z kształtem i nazwy podmienione w obu miejscach', () => {
    for (const s of SHAPED) expect(buttonsSafe(s.match), s.name).toBe(true);
    fc.assert(fc.property(shapedArb, validName, (s, name) => {
      const match = verdict(renamed(s, 'both', name));
      return match !== null && buttonsSafe(match);
    }), RUNS);
  });

  it('etykieta ze słownika eskalacji: kształt pasuje, ale jej cyfra nie ma przycisku ani roli „zatwierdź”', () => {
    for (const s of SHAPED) {
      for (const name of ['Always 5.5', 'Trust 5.5']) {
        const match = verdict(renamed(s, 'both', name));
        expect(match?.value, `${s.name} ${name}`).toBe(name);
        expect(match?.buttons).toEqual(['2']);
        expect(match?.allow).toBeNull();
        expect(match?.pairs[0]?.why).toBe('escalation');
      }
    }
  });
});

/** Treść bloku pod górą: linie opcji bez wcięcia i znacznika fokusu, reszta dosłownie. */
function content(text: string): string | null {
  const block = readBlock(text);
  if (block === null) return null;
  return trimmedLines(text)
    .slice(block.top.line + 1)
    .map((line) => line.replace(/^ *(?:❯ +)?(\d\. )/u, '$1'))
    .join('\n');
}

/** Model bramki kroku przed cyfrą: ten sam kształt, ten sam odcisk i ta sama para roli „zatwierdź” co na karcie. */
function gate(card: Shaped, text: string): boolean {
  const block = readBlock(text);
  const match = shapeOf(block);
  return block !== null && match !== null && match.shape.id === card.match.shape.id && block.print === card.block.print
    && match.allow?.digit === card.match.allow?.digit && match.allow?.label === card.match.allow?.label;
}

describe('odcisk łapie zmianę', () => {
  /** Mutanty z kształtem: fokus na innej opcji, inny status sesji, SGR (ta sama treść), zawinięcie, inny model. */
  const focusMoved = (s: Shaped): string[] => {
    const [one, two] = s.options;
    return replaced(
      replaced(s.lines, one ?? -1, (s.lines[one ?? -1] ?? '').replace('❯ ', '  ')),
      two ?? -1,
      (s.lines[two ?? -1] ?? '').replace(/^( *) {2}(\d\. )/u, '$1❯ $2'),
    );
  };
  const statusChanged = (s: Shaped): string[] => replaced(
    s.lines,
    s.top,
    (s.lines[s.top] ?? '').replace('◐ medium', '◑ high'),
  );
  const rewrapped = (s: Shaped): string[] => {
    const i = s.body.at(-1) ?? -1;
    const line = s.lines[i] ?? '';
    const column = line.lastIndexOf(' ', 60);
    return replaced(s.lines, i, line.slice(0, column), `${indentOf(line)}${line.slice(column + 1)}`);
  };

  it('ta sama treść przechodzi bramkę: fokus na innej opcji, inny status sesji, SGR', () => {
    for (const s of SHAPED) {
      const moved = focusMoved(s);
      expect(moved).not.toEqual(s.lines);
      expect(gate(s, moved.join('\n')), `${s.name} fokus`).toBe(true);
      expect(gate(s, statusChanged(s).join('\n')), `${s.name} status`).toBe(true);
    }
    fc.assert(fc.property(sgrArb, ([s, injections]) => gate(s, withSgr(s.lines, injections).join('\n'))), RUNS);
  });

  it('inna treść z tym samym kształtem nie przechodzi bramki: zawinięta treść, inny model', () => {
    for (const s of SHAPED) {
      const wrapped = rewrapped(s);
      expect(verdict(wrapped)?.shape.id, s.name).toBe(s.match.shape.id);
      expect(gate(s, wrapped.join('\n')), `${s.name} zawinięcie`).toBe(false);
    }
    fc.assert(fc.property(shapedArb, validName, (s, name) => {
      fc.pre(name !== s.value);
      const lines = renamed(s, 'both', name);
      return verdict(lines) !== null && !gate(s, lines.join('\n'));
    }), RUNS);
  });

  it('bramka przepuszcza wyłącznie blok o treści bloku karty (mutacje 1–10 i ich złożenia)', () => {
    const mutant = shapedArb.chain((s) => fc.oneof(
      fc.tuple(fc.integer({ min: s.top, max: s.last }), fc.constantFrom(...POOL))
        .map(([at, line]) => inserted(s.lines, at, line)),
      fc.integer({ min: s.top, max: s.last }).map((at) => s.lines.filter((_, i) => i !== at)),
      fc.integer({ min: s.top, max: s.last }).map((at) => s.lines.slice(0, at)),
      fc.tuple(fc.integer({ min: s.top, max: s.last }), fc.string({ minLength: 1, maxLength: 8 }))
        .map(([at, tail]) => replaced(s.lines, at, `${s.lines[at] ?? ''}${tail}`)),
      validName.map((name) => renamed(s, 'both', name)),
      fc.constant(focusMoved(s)),
      fc.constant(rewrapped(s)),
    ).map((lines) => [s, lines] as const));
    fc.assert(fc.property(mutant, ([s, lines]) => {
      const text = lines.join('\n');
      return !gate(s, text) || content(text) === content(s.lines.join('\n'));
    }), { numRuns: 1000 });
  });
});

describe('zgoda nigdy do warstwy 2', () => {
  const MODEL_OPTIONS = ['   ❯ 1. Yes, switch to Opus 5.5', '     2. No, go back'];

  /** Przeszczep z potwierdzenia modelu: tytuł, opcje albo oba na miejsce bloku zgody. */
  function grafted(lines: readonly string[], what: 'title' | 'options' | 'both'): string[] {
    const block = readBlock(lines.join('\n'));
    if (block === null) return [...lines];
    let out = [...lines];
    if (what !== 'title' && block.optionLines.length > 0) {
      const first = out.indexOf(block.optionLines[0] ?? '', block.titleLine + 1);
      const last = out.lastIndexOf(block.optionLines.at(-1) ?? '');
      out = [...out.slice(0, first), ...MODEL_OPTIONS, ...out.slice(last + 1)];
    }
    if (what !== 'options') out = replaced(out, block.titleLine, '   Switch model?');
    return out;
  }

  it('zrzuty zgód bez zmian i z przeszczepionym tytułem albo opcjami potwierdzenia modelu', () => {
    for (const consent of CONSENTS) {
      expect(verdict(consent.lines), consent.name).toBeNull();
      for (const what of ['title', 'options', 'both'] as const) {
        expect(verdict(grafted(consent.lines, what)), `${consent.name} ${what}`).toBeNull();
      }
    }
  });

  it('mutanty zgód: usunięta, wstawiona albo dopisana linia, SGR', () => {
    const arb = fc.constantFrom(...CONSENTS).chain(({ lines }) => fc.oneof(
      fc.nat({ max: lines.length - 1 }).map((at) => lines.filter((_, i) => i !== at)),
      fc.tuple(fc.nat({ max: lines.length }), fc.constantFrom(...POOL)).map(([at, line]) => inserted(lines, at, line)),
      fc.tuple(fc.nat({ max: lines.length - 1 }), fc.constantFrom(' 1 of 2', ' │', ' ↓', ' [ ]'))
        .map(([at, tail]) => replaced(lines, at, `${lines[at] ?? ''}${tail}`)),
      fc.array(fc.tuple(fc.nat({ max: lines.length - 1 }), fc.nat({ max: 200 }), fc.constantFrom(...SGR)), {
        minLength: 1,
        maxLength: 4,
      }).map((injections) => withSgr(lines, injections)),
      fc.constantFrom('title' as const, 'options' as const, 'both' as const).map((what) => grafted(lines, what)),
    ));
    fc.assert(fc.property(arb, (lines) => verdict(lines) === null), { numRuns: 1000 });
  });
});

describe('rejestr', () => {
  it('ma wyłącznie kształty z cyfrą jako trybem zatwierdzania i bez narzędzi', () => {
    for (const shape of BLOCK_SHAPES) {
      expect(shape.submit).toBe('digit');
      expect(['model', 'effort']).toContain(shape.command);
    }
  });
});
