/**
 * Wspólne reguły tekstu w drodze na drut (`server/src/text.ts`): cięcie bez połowy znaku
 * i usuwanie znaków sterujących.
 */
import { describe, expect, it } from 'vitest';
import {
  LABEL_FALLBACK, clipUnits, sanitizeBuild, sanitizeLabel, sanitizeLogText, stripControlChars,
} from '../src/text.ts';

/** Characters come from code points, not literals: tools that write this file may expand an escape to a raw one. */
const char = (...codes: number[]): string => String.fromCodePoint(...codes);

describe('clipUnits: sufit w jednostkach UTF-16 bez połowy znaku', () => {
  it('tekst w limicie wraca bez zmian, dłuższy jest ucięty do limitu', () => {
    expect(clipUnits('krótki 🙂', 20)).toBe('krótki 🙂');
    expect(clipUnits('', 10)).toBe('');
    expect(clipUnits('abcdef', 4)).toBe('abcd');
  });

  it('para surogatów rozcięta granicą zostaje zastąpiona U+FFFD, długość równa limitowi', () => {
    const cut = clipUnits(`${'x'.repeat(9)}🙂`, 10);
    expect(cut).toBe(`${'x'.repeat(9)}\ufffd`);
    expect(cut).toHaveLength(10);
    // Ten napis przechodzi przez JSON bez samotnego surogatu, więc dekoder apki go przyjmie.
    expect(/[\ud800-\udfff]/.test(cut)).toBe(false);
  });

  it('emoji w całości przed granicą zostaje nietknięte', () => {
    expect(clipUnits(`${'x'.repeat(8)}🙂z`, 10)).toBe(`${'x'.repeat(8)}🙂`);
  });
});

describe('stripControlChars: znaki sterujące usunięte, reszta nietknięta', () => {
  it('usuwa U+0000–U+001F, DEL, U+0080–U+009F i separatory linii, bez wstawiania spacji', () => {
    expect(stripControlChars('Plan\nB')).toBe('PlanB');
    expect(stripControlChars('a\u0000b\u0007c\u001bd\u007fe\u0085f\u009fg')).toBe('abcdefg');
    expect(stripControlChars('linia\u2028druga\u2029trzecia\t')).toBe('liniadrugatrzecia');
  });

  it('nie rusza zwykłego tekstu, białych znaków ani emoji z łącznikiem zerowej szerokości', () => {
    const family = '👨\u200d👩\u200d👧';
    expect(stripControlChars(`  Zażółć gęślą jaźń ${family}  `)).toBe(`  Zażółć gęślą jaźń ${family}  `);
    expect(stripControlChars('')).toBe('');
  });
});

describe('sanitizeLabel: a device label shows nothing the screen hides', () => {
  const family = char(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
  const heart = char(0x2764, 0xfe0f);
  const scotland = char(0x1f3f4, 0xe0067, 0xe0062, 0xe0073, 0xe0063, 0xe0074, 0xe007f);
  it.each([
    ['text direction override U+202E', `iPhone${char(0x202e)}evil`, 'iPhoneevil'],
    ['zero width space U+200B', `a${char(0x200b)}b`, 'ab'],
    ['soft hyphen U+00AD', `co${char(0xad)}op`, 'coop'],
    ['tag character U+E0041', `x${char(0xe0041)}y`, 'xy'],
    ['family emoji with U+200D', family, family],
    ['heart with variation selector U+FE0F', heart, heart],
    ['flag of Scotland (tags removed, an accepted loss)', scotland, char(0x1f3f4)],
    ['only hidden characters', char(0x200b, 0x202e), LABEL_FALLBACK],
    ['tab and newline are removed, not turned into a space', 'a\tb\nc', 'abc'],
  ])('%s', (_name, raw, label) => {
    expect(sanitizeLabel(raw)).toBe(label);
  });
});

describe('sanitizeBuild: a build number is up to 10 ASCII digits or nothing', () => {
  it.each([
    ['1700', '1700'],
    [' 42 ', '42'],
    ['', null],
    ['1.2', null],
    ['12345678901', null],
    [`${char(0x1b)}[31m1`, null],
    [char(0x661, 0x662), null],
    [undefined, null],
    [null, null],
  ])('%j → %j', (raw, build) => {
    expect(sanitizeBuild(raw)).toBe(build);
  });
});

describe('sanitizeLogText: text from outside on a log line, no terminal control and a ceiling', () => {
  it.each([
    ['ESC sequence', `bad${char(0x1b)}[2Jcert`, 'bad?[2Jcert'],
    ['CR and LF', 'a\r\nb', 'a??b'],
    ['text direction override U+202E', `x${char(0x202e)}y`, 'x?y'],
    ['tag character U+E0041, one mark for the code point', `x${char(0xe0041)}y`, 'x?y'],
  ])('%s', (_name, raw, line) => {
    expect(sanitizeLogText(raw)).toBe(line);
  });

  it('cuts at 120 UTF-16 units without leaving half of a surrogate pair', () => {
    const smile = char(0x1f600);
    expect(sanitizeLogText(smile.repeat(70))).toBe(smile.repeat(60));
    expect(sanitizeLogText('a'.repeat(200), 10)).toBe('a'.repeat(10));
  });
});
