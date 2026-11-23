/**
 * Znaki ukryte (`server/src/hidden-chars.ts`): dwie nazwane listy zakresów w jednym module. Różnica plików przed
 * zapisem kopii hooka (`visibleLine` w `herdr/hook-config.ts`) pokazuje każdy znak z pierwszej jako `\u{…}`; karta
 * kanału zgód bez przycisku zgody przy znaku z drugiej (`hidden-chars`, `layer1/card.ts`). Druga lista to pierwsza bez
 * nowej linii (U+000A) i łącznika emoji (U+200D). Znaki w testach powstają z kodów, nie z literałów: escape w źródle
 * bywa rozwijany do surowego znaku przez narzędzia, które ten plik zapisują.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CARD_HIDDEN_RANGES, DIFF_HIDDEN_RANGES, hasCardHiddenChar, inRanges,
} from '../src/hidden-chars.ts';
import { scan } from './source-scan.ts';

const char = (code: number): string => String.fromCodePoint(code);

describe('znaki ukryte: dwie listy', () => {
  it('lista karty = lista różnicy bez U+000A i U+200D, punkt po punkcie w całym Unicode', () => {
    const differ: string[] = [];
    for (let code = 0; code <= 0x10ffff; code += 1) {
      const expected = inRanges(code, DIFF_HIDDEN_RANGES) && code !== 0x0a && code !== 0x200d;
      if (inRanges(code, CARD_HIDDEN_RANGES) !== expected) differ.push(code.toString(16));
    }
    expect(differ).toEqual([]);
    expect(inRanges(0x0a, DIFF_HIDDEN_RANGES) && inRanges(0x200d, DIFF_HIDDEN_RANGES)).toBe(true);
  });

  it('`hasCardHiddenChar` na jednym znaku = przynależność do listy karty, punkt po punkcie', () => {
    const differ: string[] = [];
    for (let code = 0; code <= 0x10ffff; code += 1) {
      if (hasCardHiddenChar(char(code)) !== inRanges(code, CARD_HIDDEN_RANGES)) differ.push(code.toString(16));
    }
    expect(differ).toEqual([]);
  });

  it('zakresy domknięte i rosnące, bez nakładania', () => {
    for (const ranges of [DIFF_HIDDEN_RANGES, CARD_HIDDEN_RANGES]) {
      ranges.forEach(([from, to], index) => {
        expect(from).toBeLessThanOrEqual(to);
        if (index > 0) expect(from).toBeGreaterThan(ranges[index - 1]?.[1] ?? -1);
      });
    }
  });

  it.each([
    ['U+202E (odwrócenie kierunku)', `echo ${char(0x202e)}gnp.exe`],
    ['U+200B (spacja zerowej szerokości)', `rm${char(0x200b)} -rf`],
    ['CR', `a${char(0x0d)}b`],
    ['ESC', `a${char(0x1b)}[2Kb`],
    ['C1 U+009B', `a${char(0x9b)}b`],
    ['U+2066 (izolacja kierunku)', `a${char(0x2066)}b`],
    ['U+2028 (separator linii)', `a${char(0x2028)}b`],
    ['BOM', `${char(0xfeff)}a`],
    ['miękki dywiz U+00AD', `a${char(0xad)}b`],
    // Tag characters render as nothing, so a command could carry text the phone never shows.
    ['tag character U+E0041 in a command', `rm -rf ~/Projects${char(0xe0041)}`],
    ['first tag U+E0000', `a${char(0xe0000)}b`],
    ['cancel tag U+E007F', `a${char(0xe007f)}b`],
    // Hangul fillers render as blank space without being a space: two file names look the same on the card.
    ['Hangul filler U+3164 in a file name', `cat notes${char(0x3164)}.txt`],
    ['Hangul choseong filler U+115F', `a${char(0x115f)}b`],
    ['Hangul jungseong filler U+1160', `a${char(0x1160)}b`],
    ['halfwidth Hangul filler U+FFA0', `a${char(0xffa0)}b`],
    // Variation selectors of the supplement render as nothing after a plain letter and can carry bytes.
    ['first supplement variation selector U+E0100', `a${char(0xe0100)}b`],
    ['last supplement variation selector U+E01EF', `a${char(0xe01ef)}b`],
  ])('%s: ukryty na karcie', (_name, text) => {
    expect(hasCardHiddenChar(text)).toBe(true);
  });

  it.each([
    ['emoji rodziny z U+200D', `${char(0x1f468)}${char(0x200d)}${char(0x1f469)}${char(0x200d)}${char(0x1f467)}`],
    ['nowa linia', 'linia 1\nlinia 2'],
    ['tabulator', 'a\tb'],
    ['emoji z selektorem wariantu U+FE0F', `${char(0x2764)}${char(0xfe0f)}`],
    ['polskie litery i spacja niełamiąca', `zażółć${char(0xa0)}gęślą`],
    ['Hangul syllable and the jamo next to the fillers', `${char(0xac00)}${char(0x115e)}${char(0x1161)}${char(0x3165)}`],
    ['halfwidth Hangul letter U+FFA1 right after the filler', `a${char(0xffa1)}b`],
    ['code points around the supplement variation selectors', `a${char(0xe0080)}${char(0xe00ff)}${char(0xe01f0)}b`],
    ['pusty tekst', ''],
  ])('%s: widoczny na karcie', (_name, text) => {
    expect(hasCardHiddenChar(text)).toBe(false);
  });
});

describe('znaki ukryte: jedna definicja', () => {
  it('`hook-config.ts` bierze zakresy z modułu i nie trzyma własnej kopii', () => {
    const source = readFileSync(join(import.meta.dirname, '../src/herdr/hook-config.ts'), 'utf8');
    const { code } = scan(source);
    expect(code).toMatch(/from '\.\.\/hidden-chars\.ts'/);
    expect(code).toContain('DIFF_HIDDEN_RANGES');
    expect(code).not.toMatch(/0x202e|0x200b|0xfeff/i);
  });
});
