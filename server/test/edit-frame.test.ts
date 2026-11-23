/**
 * Wrapped file lines in the `Edit` and `Write` "Create file" frames (`frameFileLines` in `screen/edit-frame.ts`).
 *
 * Every wrap capture of the control set (`kontrolny/zgoda-{edit,write}-wrap-*-2.1.330.txt`, Claude Code 2.1.330)
 * goes through the proof with the exact tool input recorded next to it (`<capture>.input.json`), and the table says
 * which captures the screen proves and why the others stay without buttons. The other cases change one thing in
 * a measured frame: the rule width, one row, the call text at the wrap boundary.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  editDiffSides, editMatchesOperation, frameFileLines, writeMatchesOperation,
} from '../src/herdr/dialogs/screen/edit-frame.ts';
import type { ScreenOperation } from '../src/herdr/dialogs/screen/operation.ts';
import { parseOptions } from '../src/herdr/dialogs/screen/parse.ts';
import { FILE_FRAME_GEOMETRY } from '../src/herdr/dialogs/screen/signatures.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'herdr');
const HOME = '/Users/u';
const screenOf = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

interface Measured {
  readonly toolName: 'Edit' | 'Write';
  readonly input: Record<string, unknown>;
  readonly cwd: string;
  /** The files the measurement wrote before the session: path and exact content. */
  readonly seeded: readonly { readonly file_path: string; readonly content: string }[];
}
const measuredOf = (name: string): Measured =>
  JSON.parse(screenOf(name.replace(/\.txt$/u, '.input.json'))) as Measured;

const operationOf = (screen: string): ScreenOperation => {
  const operation = parseOptions(screen)?.operation ?? null;
  if (operation === null) throw new Error('no frame on the screen');
  return operation;
};

/** The proof of the call on a screen, as the jsonl path and the consent channel run it. */
function proves(toolName: 'Edit' | 'Write', input: unknown, screen: string, cwd: string): boolean {
  const operation = parseOptions(screen)?.operation ?? null;
  return toolName === 'Edit'
    ? editMatchesOperation(input, operation, cwd, HOME)
    : writeMatchesOperation(input, operation, cwd, HOME);
}

/** A capture with one exact piece replaced; a missing piece is a test error, not a silent pass. */
const replaced = (screen: string, from: string, to: string): string => {
  if (!screen.includes(from)) throw new Error(`screen without "${from}"`);
  return screen.replace(from, to);
};

/** The same capture drawn for a pane `delta` columns wider: both frame rules change length, the rows stay. */
const ruleShifted = (screen: string, delta: number): string =>
  screen.replace(/^╌+$/gmu, (rule) => '╌'.repeat(rule.length + delta));

/**
 * Outcome of the proof per wrap variant: `proof` (buttons), `unread` (the frame gives no file lines), `mismatch`
 * (file lines read, the call does not explain them) and `header` (the frame rule is inside a wrapped line, so the
 * header over the cut frame has more than two lines).
 */
type Outcome = 'proof' | 'unread' | 'mismatch' | 'header';
interface Row { readonly outcome: Outcome; readonly why: string }
const PROOF: Row = { outcome: 'proof', why: 'joined lines equal the call' };
const OFF_LIST: Row = { outcome: 'unread', why: 'a character off the closed list in a wrapped line' };

const EDIT: Readonly<Record<string, Row>> = {
  change: PROOF,
  'claude-md': PROOF,
  geo: PROOF,
  line10: PROOF,
  line100: PROOF,
  polish: PROOF,
  'space-w': PROOF,
  'space-after': PROOF,
  'space-both': PROOF,
  nbsp: { outcome: 'proof', why: 'context line outside old_string; the no-break space at W reads as a space' },
  tab: { outcome: 'proof', why: 'context line outside old_string; the tab reads as the spaces it is drawn with' },
  digits: { outcome: 'unread', why: 'continuation readable as a numbered row (`42 -x`)' },
  'fake-frame': { outcome: 'header', why: 'the dashes in a context line end the frame' },
  hunks: { outcome: 'unread', why: 'the note about places not shown stands in the frame without the margin' },
  ideo: OFF_LIST,
  nfd: OFF_LIST,
  wide: OFF_LIST,
  zwsp: OFF_LIST,
};

const WRITE: Readonly<Record<string, Row>> = {
  geo: PROOF,
  line10: PROOF,
  polish: PROOF,
  'space-w': PROOF,
  'space-after': PROOF,
  'space-both': PROOF,
  nbsp: { outcome: 'mismatch', why: 'the no-break space at W reads as a space, the content has U+00A0' },
  tab: { outcome: 'mismatch', why: 'the tab reads as spaces, the content has U+0009' },
  digits: { outcome: 'unread', why: 'continuation readable as a numbered row (`42 x`)' },
  'fake-frame': { outcome: 'header', why: 'the dashes in a line end the frame' },
  ideo: OFF_LIST,
  nfd: OFF_LIST,
  wide: OFF_LIST,
  zwsp: OFF_LIST,
};

const CAPTURE = /^zgoda-(edit|write)-wrap-(.+)-(57|99|119)-2\.1\.330\.txt$/u;
const CAPTURES = readdirSync(join(FIXTURES, 'kontrolny')).filter((name) => CAPTURE.test(name)).sort()
  .map((file) => {
    const [, tool = '', variant = '', width = ''] = CAPTURE.exec(file) ?? [];
    const row = (tool === 'edit' ? EDIT : WRITE)[variant];
    return { name: `kontrolny/${file}`, tool, variant, width, row };
  });

describe('wrap captures on CLI 2.1.330: the proof with the exact tool input', () => {
  it('94 captures, each variant in the table', () => {
    expect(CAPTURES).toHaveLength(94);
    for (const capture of CAPTURES) expect(capture.row, capture.name).toBeDefined();
    expect(CAPTURES.filter(({ row }) => row?.outcome === 'proof')).toHaveLength(49);
  });

  it.each(CAPTURES)('$name: $row.outcome ($row.why)', ({ name, row }) => {
    const screen = screenOf(name);
    const { toolName, input, cwd } = measuredOf(name);
    const operation = operationOf(screen);
    const lines = frameFileLines(operation, toolName === 'Edit' ? 'diff' : 'content');
    expect(proves(toolName, input, screen, cwd)).toBe(row?.outcome === 'proof');
    expect(lines === null).toBe(row?.outcome === 'unread');
    if (row?.outcome === 'header') expect(operation.header.length).toBeGreaterThan(2);
  });
});

describe('the geometry from the registry against the captures it names', () => {
  it.each(FILE_FRAME_GEOMETRY.fixtures)('%s: the widest row is exactly W = C − reserve − d', (name) => {
    const operation = operationOf(screenOf(name));
    const frame = name.includes('zgoda-edit-') ? FILE_FRAME_GEOMETRY.diff : FILE_FRAME_GEOMETRY.content;
    const numbers = operation.rows.map((row) => /^ *(\d+)/u.exec(row)?.[1]).filter((n) => n !== undefined);
    const digits = String(Math.max(...numbers.map(Number))).length;
    const start = digits + FILE_FRAME_GEOMETRY.contentAfterDigits;
    const widest = Math.max(...operation.rows.map((row) => row.slice(start).length));
    expect(widest).toBe(operation.ruleWidth - frame.reserve - digits);
    // Every numbered row has the number right-aligned in its field.
    for (const row of operation.rows.filter((r) => /^ *\d/u.test(r))) {
      expect(/^ +\d+$/u.test(row.slice(0, 1 + digits + frame.fieldExtra)), row).toBe(true);
    }
  });
});

describe('wrapped context and change lines in a 57-column pane (`claude-md-57`)', () => {
  const NAME = 'kontrolny/zgoda-edit-wrap-claude-md-57-2.1.330.txt';
  const SCREEN = screenOf(NAME);
  const CALL = measuredOf(NAME);
  const LINE_111 = '- The quick brown fox jumps over the lazy dog while the patient gardener waters every plant along'
    + ' the narrow stone path, and the evening light slowly fades behind the old wooden barn near the quiet river bank.';

  it('line 111 on five rows reads as one file line: rows short of W end with a space at W', () => {
    const sides = editDiffSides(operationOf(SCREEN));
    expect(sides?.old.split('\n')).toContain(LINE_111);
    expect(sides?.new.split('\n')).toContain('- Use one name for one thing across the whole session.');
  });

  it('the call proves; a call that differs by one space at a wrap boundary does not', () => {
    expect(proves('Edit', CALL.input, SCREEN, CALL.cwd)).toBe(true);
    const spaced = { ...CALL.input, new_string: '- Use one name for one thing across the whole sessi on.' };
    expect(proves('Edit', spaced, SCREEN, CALL.cwd)).toBe(false);
  });

  it('a call whose old_string reaches over line 111 proves only with the space each short row ends with', () => {
    const over = (line: string): Record<string, unknown> => ({
      ...CALL.input,
      old_string: `- Use one name for one thing.\n- Write in full sentences.\n\n${line}`,
      new_string: `- Use one name for one thing across the whole session.\n- Write in full sentences.\n\n${line}`,
    });
    expect(proves('Edit', over(LINE_111), SCREEN, CALL.cwd)).toBe(true);
    expect(proves('Edit', over(LINE_111.replace('along the narrow', 'along thenarrow')), SCREEN, CALL.cwd)).toBe(false);
    expect(proves('Edit', over(LINE_111.replace('river bank', 'riverbank')), SCREEN, CALL.cwd)).toBe(false);
  });

  it('no witness row of W: the same frame for a wider pane, and the formula ahead of the rows, gives no proof', () => {
    expect(proves('Edit', CALL.input, ruleShifted(SCREEN, 2), CALL.cwd)).toBe(false);
    expect(frameFileLines(operationOf(ruleShifted(SCREEN, 2)), 'diff')).toBeNull();
  });

  it('a row wider than W (the same frame for a narrower pane) gives no proof', () => {
    expect(frameFileLines(operationOf(ruleShifted(SCREEN, -1)), 'diff')).toBeNull();
  });
});

describe('the frame shape around a wrapped line', () => {
  const CHANGE = 'kontrolny/zgoda-edit-wrap-change-57-2.1.330.txt';
  const LINE100 = 'kontrolny/zgoda-edit-wrap-line100-57-2.1.330.txt';
  const SPACE_W = 'kontrolny/zgoda-edit-wrap-space-w-57-2.1.330.txt';
  const read = (screen: string): unknown => frameFileLines(operationOf(screen), 'diff');

  it('the measured frame reads (otherwise the cases below would measure an early `null`)', () => {
    expect(read(screenOf(CHANGE))).not.toBeNull();
    expect(read(screenOf(LINE100))).not.toBeNull();
  });

  it('a continuation with a marker other than its line → null', () => {
    expect(read(replaced(screenOf(CHANGE), '   -bcdefghijk draft', '   +bcdefghijk draft'))).toBeNull();
  });

  it('a continuation as the first row of the frame → null', () => {
    expect(read(replaced(screenOf(CHANGE), ' 1  # Sample notes\n 2 -abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyza\n',
      ''))).toBeNull();
  });

  it('a number field narrower than the largest number needs → null', () => {
    expect(read(replaced(screenOf(LINE100), '  97  ninety-seven', ' 97  ninety-seven'))).toBeNull();
  });

  it('a row short of W that ends with another white space than U+0020 → null', () => {
    const shortRow = '  abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz\n';
    expect(read(replaced(screenOf(SPACE_W), ` 3${shortRow}`, ` 3${shortRow.trimEnd()}\u00a0\n`))).toBeNull();
    expect(read(screenOf(SPACE_W))).not.toBeNull();
  });

  it('the no-break space in a line the call covers: the screen reads it as a space, so no proof', () => {
    const name = 'kontrolny/zgoda-edit-wrap-nbsp-57-2.1.330.txt';
    const { input, cwd } = measuredOf(name);
    const line = 'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz\u00a0bcdefghijklmnopqrstu';
    expect(proves('Edit', { ...input, old_string: `${line}\nStatus: draft`, new_string: `${line}\nStatus: final` },
      screenOf(name), cwd)).toBe(false);
  });

  it('the tab in a line the call covers: the screen draws it with spaces, so no proof', () => {
    const name = 'kontrolny/zgoda-edit-wrap-tab-57-2.1.330.txt';
    const { input, cwd } = measuredOf(name);
    const line = 'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwx\tzabcdefghijklmnopqrstu';
    expect(proves('Edit', { ...input, old_string: `${line}\nStatus: draft`, new_string: `${line}\nStatus: final` },
      screenOf(name), cwd)).toBe(false);
  });
});

describe('`nbsp` and `tab` in an `Edit` context line: the proof approves the call, not the context', () => {
  const NAMES = ['nbsp', 'tab'].flatMap((variant) => ['57', '99', '119']
    .map((width) => `kontrolny/zgoda-edit-wrap-${variant}-${width}-2.1.330.txt`));

  it.each(NAMES)('%s: `-` rows are `old_string`, `+` rows `new_string`; one context line reads unlike the file', (name) => {
    const { input, cwd, seeded } = measuredOf(name);
    const screen = screenOf(name);
    const lines = frameFileLines(operationOf(screen), 'diff') ?? [];
    expect(lines.filter((line) => line.mark === '-').map((line) => line.text).join('\n')).toBe(input['old_string']);
    expect(lines.filter((line) => line.mark === '+').map((line) => line.text).join('\n')).toBe(input['new_string']);
    // The screen shows a space where the file has U+00A0 or a tab; the call does not cover that line.
    const file = (seeded[0]?.content ?? '').split('\n');
    const unlike = lines.filter((line) => line.mark === ' ' && file[line.number - 1] !== line.text);
    expect(unlike).toHaveLength(1);
    const real = file[(unlike[0]?.number ?? 0) - 1] ?? '';
    expect(/[\u00a0\t]/u.test(real)).toBe(true);
    expect(String(input['old_string'])).not.toContain(real);
    expect(proves('Edit', input, screen, cwd)).toBe(true);
  });
});

describe('a space at the wrap boundary: each screen proves only its own content', () => {
  const VARIANTS = ['space-w', 'space-after', 'space-both'] as const;
  const contentOf = (variant: string, width: string): string =>
    measuredOf(`kontrolny/zgoda-write-wrap-${variant}-${width}-2.1.330.txt`).input['content'] as string;
  const rows = ['57', '99', '119'].flatMap((width) => VARIANTS.map((screen) => ({ width, screen })));

  it.each(rows)('$width columns, screen $screen', ({ width, screen }) => {
    const name = `kontrolny/zgoda-write-wrap-${screen}-${width}-2.1.330.txt`;
    const { input, cwd } = measuredOf(name);
    for (const content of VARIANTS) {
      expect(proves('Write', { ...input, content: contentOf(content, width) }, screenOf(name), cwd), content)
        .toBe(content === screen);
    }
    // Without the space at the boundary the line is one character shorter: no proof on any of the three screens.
    const without = contentOf('space-w', width).split('\n')
      .map((line, index) => (index === 2 ? line.replace(' ', '') : line)).join('\n');
    expect(without).not.toBe(contentOf('space-w', width));
    expect(proves('Write', { ...input, content: without }, screenOf(name), cwd)).toBe(false);
  });
});

describe('frames from before the geometry', () => {
  it('`measured/zgoda-write-dluga-linia-2.1.322.txt`: rows two columns short of the formula, no witness → null', () => {
    expect(frameFileLines(operationOf(screenOf('measured/zgoda-write-dluga-linia-2.1.322.txt')), 'content')).toBeNull();
  });

  it('a frame without a wrapped line reads as before, without the geometry', () => {
    const operation = operationOf(screenOf('measured/zgoda-edit-2.1.293.txt'));
    expect(frameFileLines(operation, 'diff')).toEqual([
      { number: 1, mark: '-', text: 'stara wartosc' }, { number: 1, mark: '+', text: 'nowa wartosc' },
    ]);
  });
});
