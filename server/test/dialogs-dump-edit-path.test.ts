/**
 * An `Edit` consent from the hook dump alone (CLI 2.1.317).
 *
 * When an agent sends several edits of a protected settings file in one message, the CLI appends the message to the
 * conversation file only after the decision: there is no jsonl entry, only the `PermissionRequest` dump. The screen
 * shows an “Edit file” dialog with a path RELATIVE to the session directory and a diff longer than the cap of
 * a screen-only card (2000 characters), while the dump carries an ABSOLUTE `file_path`.
 *
 * The `Edit` dump matches when the path from the dialog header, resolved against the dump's `cwd`, gives `file_path`,
 * and the diff in the frame is exactly this edit (the old side with `old_string` replaced by `new_string` gives the
 * new one). Screens are synthetic, in the shape of a real dump: line number, space, marker, content; a long line
 * breaks hard at the content width W (rule width − 3 − digits of the largest number, CLI 2.1.330), and the
 * continuation has an empty number field and the same marker. The diff is compared literally. A line broken by the
 * frame joins back only when the frame proves W with a row exactly W wide (`frameFileLines`); most cases here use
 * lines narrower than the frame.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideCard } from '../src/herdr/dialogs/decide/decide.ts';
import { decideReqId } from '../src/herdr/dialogs/decide/sources.ts';
import type { DecideInput } from '../src/herdr/dialogs/decide/input.ts';
import { hookMatchesScreen, hookPendingFrom } from '../src/herdr/dialogs/cross-check.ts';
import { editContradictsOperation, editDiffSides, editMatchesOperation } from '../src/herdr/dialogs/screen/edit-frame.ts';
import { parseOptions } from '../src/herdr/dialogs/screen/parse.ts';
import { queueOnScreen } from '../src/herdr/dialogs/screen/queue.ts';
import { resolveOptions } from '../src/herdr/dialogs/screen/resolve.ts';
import type { PendingTool } from '../src/herdr/jsonl-pending.ts';
import type { PendingHookTool } from '../src/herdr/dialogs/hook/dump.ts';

const CWD = '/home/u/projekt';
const FILE = `${CWD}/konfig/ustawienia.json`;
const HOME = '/home/u';
/** Width of the frame rules: a pane of 128 columns. */
const WIDTH = 128;

type Mark = ' ' | '+' | '-';

/**
 * Diff rows as the CLI draws them: ` 652 -content`, a continuation `     -more` (a hard break). The content width is
 * W = `width` − 3 − the digits of the largest number, the geometry of `FILE_FRAME_GEOMETRY` (CLI 2.1.330).
 */
function diffLines(rows: ReadonlyArray<readonly [number, Mark, string]>, width = WIDTH): string[] {
  const numWidth = Math.max(...rows.map(([n]) => String(n).length));
  const chunk = width - 3 - numWidth;
  const out: string[] = [];
  for (const [n, mark, text] of rows) {
    const pieces = text === '' ? [''] : (text.match(new RegExp(`.{1,${chunk}}`, 'gsu')) ?? ['']);
    pieces.forEach((piece, i) => {
      const gutter = i === 0 ? String(n).padStart(numWidth) : ' '.repeat(numWidth);
      out.push(` ${gutter} ${mark}${piece}`.replace(/\s+$/u, ''));
    });
  }
  return out;
}

/** Długa reguła ustawień w liniach węższych od ramki (każda linia pliku to jeden wiersz diffu). */
const rule = (name: string, phrase: string): string =>
  [`      "${name}:`, ...Array<string>(8).fill(`        ${phrase}`), '        koniec"'].join('\n');
const LONG_A = rule('Pierwsza reguła', 'agent może czytać pliki projektu i uruchamiać testy jednostkowe,');
const LONG_B = rule('Druga reguła', 'agent może komentować zadania po zgodzie użytkownika na dokładny tekst,');
const LONG_C = rule('Trzecia reguła', 'wypychanie z dzierżawą tylko na gałąź zadania, nigdy na gałąź główną,');

/** Edycja z incydentu w syntetycznej postaci: dopisanie przecinka i dwóch długich reguł po istniejącej. */
const OLD_STRING = `${LONG_A}\n    ],`;
const NEW_STRING = `${LONG_A},\n${LONG_B},\n${LONG_C}\n    ],`;

/** Wiersze diffu z linii tekstu: kolejne numery od `from`, ten sam znacznik. */
const numbered = (from: number, mark: Mark, text: string): (readonly [number, Mark, string])[] =>
  text.split('\n').map((line, i) => [from + i, mark, line] as const);
const ADDED = `${LONG_A},\n${LONG_B},\n${LONG_C}`;
const ADDED_LINES = ADDED.split('\n').length;

const DIFF_ROWS: ReadonlyArray<readonly [number, Mark, string]> = [
  [649, ' ', '    "allow": ['],
  [650, ' ', '      "$defaults",'],
  ...numbered(651, '-', LONG_A),
  ...numbered(651, '+', ADDED),
  [651 + ADDED_LINES, ' ', '    ],'],
  [652 + ADDED_LINES, ' ', '    "soft_deny": ['],
];

function screenWith(opts: {
  path?: string; rows?: ReadonlyArray<readonly [number, Mark, string]>; headerVisible?: boolean; title?: string;
  width?: number;
} = {}): string {
  const width = opts.width ?? WIDTH;
  const rule = '─'.repeat(width);
  const dashed = '╌'.repeat(width);
  const header = [
    ...(opts.headerVisible === false ? [] : [rule]),
    ` ${opts.title ?? 'Edit file'}`,
    ` ${opts.path ?? 'konfig/ustawienia.json'}`,
  ];
  return [
    '⏺ Agenci pracują. Zaczynam od opisu środowiska w ustawieniach.',
    '',
    '⏺ Update(konfig/ustawienia.json)',
    '',
    '⏺ Update(konfig/ustawienia.json)',
    '',
    ...header,
    dashed,
    ...diffLines(opts.rows ?? DIFF_ROWS, width),
    dashed,
    ' Do you want to make this edit to ustawienia.json?',
    ' ❯ 1. Yes',
    '   2. No',
    '',
    ' Esc to cancel · Tab to amend',
    '',
  ].join('\n');
}

const SCREEN = screenWith();

function zrzut(over: Partial<PendingHookTool> = {}, input: Record<string, unknown> = {}): PendingHookTool {
  return {
    toolName: 'Edit', hookEventName: 'PermissionRequest', at: 1_793_779_475_521, cwd: CWD,
    toolInput: { file_path: FILE, old_string: OLD_STRING, new_string: NEW_STRING, replace_all: false, ...input },
    ...over,
  };
}

function wejscie(raw: PendingHookTool, text: string, over: Partial<DecideInput> = {}): DecideInput {
  const hookPending = hookPendingFrom(raw);
  return {
    pending: null, hookPending, text, reqId: decideReqId(hookPending, 7), active: null, blockedSeq: 7,
    answeredSeq: -1, hookAnswersEnabled: true, deadAnswerKey: null, canRetry: false, answeredHookCall: null,
    decided: null, resolve: resolveOptions, excerpt: (t: string) => t.trim() || null, hookRaw: raw, ...over,
  };
}

/**
 * Czy kartę z przyciskami zbudował ZRZUT (treść = `toolInput` zrzutu). Karta z samego ekranu też bywa z przyciskami
 * (krótki diff, wejście `{ screen: … }`), ale wtedy treść i cyfra pochodzą z tego samego ekranu.
 */
function kartaZeZrzutu(raw: PendingHookTool, text: string): boolean {
  const action = decideCard(wejscie(raw, text));
  if (action.kind !== 'card' && action.kind !== 'screen-dialog') throw new Error(`nieoczekiwana akcja ${action.kind}`);
  if (action.kind !== 'card' || action.card.event.type !== 'permission-request') return false;
  const fromHook = JSON.stringify(action.card.event.input) === JSON.stringify(raw.toolInput);
  if (fromHook) expect(action.card.active.options.length).toBeGreaterThan(0);
  return fromHook;
}

/** Ekran incydentu nie daje karty z samego ekranu z przyciskami (treść ponad sufit), więc „bez zrzutu” = bez przycisków. */
function maPrzyciski(raw: PendingHookTool, text: string): boolean {
  const action = decideCard(wejscie(raw, text));
  if (action.kind !== 'card' && action.kind !== 'screen-dialog') throw new Error(`nieoczekiwana akcja ${action.kind}`);
  return action.kind === 'card' && action.card.event.type === 'permission-request' && action.card.event.input !== null;
}

describe('zgoda Edit z samego zrzutu hooka', () => {
  it('kształt jak w incydencie: tytuł Edit, dwie opcje, treść ponad sufit karty z samego ekranu', () => {
    const dialog = parseOptions(SCREEN);
    expect(dialog).toMatchObject({ kind: 'tool', toolName: 'Edit', question: null });
    expect(dialog?.options.map((o) => o.label)).toEqual(['Yes', 'No']);
    expect(dialog?.operation).toMatchObject({ complete: true, headerVisible: true });
    expect(resolveOptions(SCREEN, null)).toMatchObject({ status: 'no-jsonl', questionForm: null });
  });

  it('zrzut z cwd i tą samą edycją → karta z przyciskami, treść ze zrzutu, bez odmowy', () => {
    const action = decideCard(wejscie(zrzut(), SCREEN));
    expect(action).toMatchObject({ kind: 'card', audit: null });
    if (action.kind !== 'card') throw new Error('spodziewano karty');
    const event = action.card.event;
    if (event.type !== 'permission-request') throw new Error('spodziewano zgody');
    expect(event.toolName).toBe('Edit');
    expect(event.input).toMatchObject({ file_path: FILE, new_string: NEW_STRING });
    expect(action.card.active.options.map((o) => o.label)).toEqual(['Yes', 'No']);
    // Generacja zrzutu jedzie z kartą do kontroli przed cyfrą (`#digitStillHolds`).
    expect(action.card.active.proofHookAt).toBe(zrzut().at);
  });

  it('the same edit with a line longer than the frame (wrapped) → a card from the dump: a row exactly W wide proves'
    + ' the break; a call one space off at the break → no card', () => {
    const long = `      "${'a rule with a very long description, '.repeat(6)}end"`;
    const rows: ReadonlyArray<readonly [number, Mark, string]> = [
      [649, ' ', '    "allow": ['], [650, '-', '      "$defaults",'], [650, '+', long],
    ];
    const W = WIDTH - 3 - 3;
    expect(long.length).toBeGreaterThan(W);
    // The first row of the wrapped line is the witness: W characters, none of them a space at its end.
    expect(long[W - 1]).not.toBe(' ');
    const screen = screenWith({ rows });
    expect(kartaZeZrzutu(zrzut({}, { old_string: '      "$defaults",', new_string: long }), screen)).toBe(true);
    const spaced = `${long.slice(0, W)} ${long.slice(W)}`;
    expect(kartaZeZrzutu(zrzut({}, { old_string: '      "$defaults",', new_string: spaced }), screen)).toBe(false);
  });

  it('ta sama edycja ze spacją na końcu linii w `new_string` → zrzut nie daje karty: ekran rysuje ją pustą komórką', () => {
    const spacja = zrzut({}, { new_string: NEW_STRING.replace(`${LONG_C}\n`, `${LONG_C} \n`) });
    expect(JSON.stringify(spacja.toolInput)).not.toBe(JSON.stringify(zrzut().toolInput));
    expect(kartaZeZrzutu(spacja, SCREEN)).toBe(false);
  });

  it('inna edycja tego samego pliku (np. zrzut następnej prośby z kolejki) → bez przycisków', () => {
    const inna = zrzut({}, { new_string: `${LONG_A},\n${LONG_C}\n    ],` });
    expect(maPrzyciski(inna, SCREEN)).toBe(false);
  });

  it('ta sama edycja z replace_all na ekranie z jednym wystąpieniem → przyciski', () => {
    expect(maPrzyciski(zrzut({}, { replace_all: true }), SCREEN)).toBe(true);
  });

  it('plik o tej samej ścieżce względnej w innym katalogu sesji → bez przycisków', () => {
    expect(maPrzyciski(zrzut({ cwd: '/home/u/inny-projekt' }), SCREEN)).toBe(false);
  });

  it('zrzut bez cwd → bez przycisków (ścieżki względnej nie ma względem czego rozwiązać)', () => {
    const { cwd: _cwd, ...bez } = zrzut();
    expect(maPrzyciski(bez, SCREEN)).toBe(false);
  });

  it('ścieżka bezwzględna i z tyldą w nagłówku → przyciski, gdy wskazują ten sam plik', () => {
    const op = (path: string) => parseOptions(screenWith({ path }))?.operation ?? null;
    const input = zrzut().toolInput;
    expect(editMatchesOperation(input, op(FILE), CWD, HOME)).toBe(true);
    expect(editMatchesOperation(input, op('~/projekt/konfig/ustawienia.json'), CWD, HOME)).toBe(true);
    expect(editMatchesOperation(input, op('~/projekt/konfig/ustawienia.json'), null, HOME)).toBe(true);
    expect(editMatchesOperation(input, op('konfig/ustawienia.json'), null, HOME)).toBe(false);
    expect(editMatchesOperation(input, op('ustawienia.json'), CWD, HOME)).toBe(false);
  });

  it('nagłówek innego kształtu (ścieżka zawinięta, trzecia linia, spacja na brzegu nazwy) → bez przycisków', () => {
    // Ścieżka z jednej linii, bez sklejania i bez przycinania poza marginesem CLI.
    const zawinieta = SCREEN.replace(' konfig/ustawienia.json\n', ' konfig/\n ustawienia.json\n');
    const opis = SCREEN.replace(' konfig/ustawienia.json\n', ' konfig/ustawienia.json\n Opis edycji\n');
    expect(zawinieta).not.toBe(SCREEN);
    expect(opis).not.toBe(SCREEN);
    const op = (text: string) => parseOptions(text)?.operation ?? null;
    const input = zrzut().toolInput;
    expect(editMatchesOperation(input, op(SCREEN), CWD, HOME)).toBe(true);
    expect(editMatchesOperation(input, op(zawinieta), CWD, HOME)).toBe(false);
    expect(editMatchesOperation(input, op(opis), CWD, HOME)).toBe(false);
    expect(editMatchesOperation(input, op(screenWith({ path: ' konfig/ustawienia.json' })), CWD, HOME)).toBe(false);
    expect(maPrzyciski(zrzut(), zawinieta)).toBe(false);
  });

  it('kolejka dialogów („1 of 2”) → bez przycisków: zrzut bywa zrzutem prośby spod spodu', () => {
    // Licznik stoi na końcu linii tytułu, wyrównany do prawej (pomiar kolejki, CLI 2.1.302).
    const zLicznikiem = (counter: string) => SCREEN.replace(' Edit file\n', ` Edit file${' '.repeat(60)}${counter}\n`);
    const kolejka = zLicznikiem('1 of 2');
    expect(kolejka).not.toBe(SCREEN);
    /*
     * Dziś tytuł z licznikiem nie trafia w mapę tytułów bloku, więc dialog nie ma tożsamości `Edit` i odpada już na
     * niej. Reguła kolejki w `hookMatchesScreen` zostaje na dzień, w którym mapa zacznie licznik zdejmować.
     */
    expect(parseOptions(kolejka)?.identity).not.toEqual({ kind: 'title', tool: 'Edit' });
    expect(queueOnScreen(kolejka)).toMatchObject({ kind: 'counter', total: 2 });
    expect(maPrzyciski(zrzut(), kolejka)).toBe(false);
    expect(maPrzyciski(zrzut(), zLicznikiem('2 of 2'))).toBe(false);
  });

  it('`file_path` z białym znakiem na końcu → bez przycisków (ekran obcina go na końcu linii)', () => {
    expect(maPrzyciski(zrzut({}, { file_path: `${FILE} ` }), SCREEN)).toBe(false);
    const op = parseOptions(SCREEN)?.operation ?? null;
    expect(editMatchesOperation({ ...(zrzut().toolInput as Record<string, unknown>), file_path: `${FILE}\t` }, op, CWD, HOME)).toBe(false);
  });

  it('karta ze zrzutu niesie odcisk ramki do kontroli przed cyfrą', () => {
    const action = decideCard(wejscie(zrzut(), SCREEN));
    if (action.kind !== 'card') throw new Error('spodziewano karty');
    expect(action.card.active.bodyPrint).toBe(parseOptions(SCREEN)?.bodyPrint);
    expect(action.card.active.bodyPrint).toMatch(/^[0-9a-f]{16}$/u);
  });

  it('górna kreska dialogu nad krawędzią ekranu → bez przycisków', () => {
    expect(maPrzyciski(zrzut(), screenWith({ headerVisible: false }))).toBe(false);
  });

  it('ekran zaczyna się w środku diffu → zrzut nie daje karty', () => {
    /*
     * Ramka `Edit` nie ma paska `│`, więc ucięta u góry nie jest dla parsera ramką (`operation: null`). Karta z samego
     * ekranu powstaje wtedy jak dla dialogu bez ramki — to znana luka („Known gaps” w `docs/dialogs.md`), nie skutek
     * zrzutu. Tu liczy się wyłącznie to, że zrzut nie przykleja do takiego ekranu swojej treści.
     */
    const lines = SCREEN.split('\n');
    const cut = lines.slice(lines.findIndex((line) => /^ 652 \+/u.test(line))).join('\n');
    expect(parseOptions(cut)?.operation).toBeNull();
    expect(kartaZeZrzutu(zrzut(), cut)).toBe(false);
  });

  it('dawny dowód nie działa: ścieżka bezwzględna w scrollbacku nad dialogiem innej edycji', () => {
    const inna = zrzut({}, { new_string: `${LONG_A},\n${LONG_B}\n    ],` });
    const zeSciezka = `  ⎿  ${FILE}\n${SCREEN}`;
    expect(hookMatchesScreen(hookPendingFrom(inna) as PendingTool, zeSciezka)).toBe(false);
  });
});

describe('editDiffSides — strony diffu z ramki', () => {
  /** The sides of a frame drawn for a pane `width` columns wide, read through the parser. */
  const sides = (rows: ReadonlyArray<readonly [number, Mark, string]>, width = WIDTH) => {
    const op = parseOptions(screenWith({ rows, width }))?.operation ?? null;
    if (op === null) throw new Error('brak ramki');
    return editDiffSides(op);
  };
  /**
   * The measured frame with its rows replaced (margin added) and the rule width that gives content width `w`; the
   * rows have a one-column number field, so a numbered row starts with its digits.
   */
  const framed = (lines: readonly string[], w: number) => {
    const op = parseOptions(SCREEN)?.operation;
    if (op === undefined || op === null) throw new Error('brak ramki');
    const digits = Math.max(...lines.map((line) => /^(\d+)/u.exec(line)?.[1]?.length ?? 0));
    return editDiffSides({ ...op, rows: lines.map((line) => ` ${line}`), ruleWidth: w + 3 + digits });
  };

  it('rozdziela strony po znaczniku, linia po linii, z wcięciami i spacjami dosłownie', () => {
    const s = sides(DIFF_ROWS);
    expect(s?.old).toBe(['    "allow": [', '      "$defaults",', LONG_A, '    ],', '    "soft_deny": ['].join('\n'));
    expect(s?.new).toBe(['    "allow": [', '      "$defaults",', ADDED, '    ],', '    "soft_deny": ['].join('\n'));
  });

  it('a line the frame wraps joins back when a row is exactly W wide; a space at the break stays where it stood', () => {
    // A pane of 24 columns and one-digit numbers: W = 20.
    const spaced = `${'a'.repeat(20)} ${'b'.repeat(20)}`;
    expect(sides([[1, '-', 'x'], [1, '+', spaced]], 24)).toEqual({ old: 'x', new: spaced });
    expect(sides([[1, '-', 'x'], [1, '+', 'a'.repeat(40)]], 24)).toEqual({ old: 'x', new: 'a'.repeat(40) });
    // A space at W is an empty cell at the row end: the row short of W is padded with one space.
    const atW = `${'a'.repeat(19)} ${'b'.repeat(20)}`;
    expect(sides([[1, ' ', 'c'.repeat(20)], [2, '-', 'x'], [2, '+', atW]], 24)?.new).toBe(`${'c'.repeat(20)}\n${atW}`);
  });

  it('a wrapped line without a row exactly W wide → null: the frame does not prove its width', () => {
    // The only row that could be the witness ends with a space at W, so the read shows it one column short.
    const atW = `${'a'.repeat(19)} ${'b'.repeat(5)}`;
    expect(sides([[1, '-', 'x'], [1, '+', atW]], 24)).toBeNull();
    // The same line next to a row exactly W wide reads.
    expect(sides([[1, ' ', 'c'.repeat(20)], [2, '-', 'x'], [2, '+', atW]], 24)).not.toBeNull();
  });

  it('pusta linia pliku (sam numer albo numer ze znacznikiem) i numery różnej szerokości', () => {
    const s = sides([[99, ' ', 'a'], [100, ' ', ''], [101, '+', ''], [102, '-', 'b']]);
    expect(s).toEqual({ old: 'a\n\nb', new: 'a\n\n' });
  });

  it('linia spoza kształtu diffu (np. separator hunków) → null', () => {
    const op = parseOptions(SCREEN)?.operation;
    if (op === undefined || op === null) throw new Error('brak ramki');
    expect(editDiffSides(op)).not.toBeNull();
    expect(editDiffSides({ ...op, rows: [...op.rows.slice(0, 2), ' ...', ...op.rows.slice(2)] })).toBeNull();
  });

  it('kontynuacja ze znacznikiem innym niż jej linia, pusty wiersz w ramce → null', () => {
    // W = 1: the row `1 -x` is the witness, so only the marker decides.
    expect(framed(['1 -x', '  -y', '1 +z'], 1)).toEqual({ old: 'xy', new: 'z' });
    expect(framed(['1 -x', '  +y', '1 +z'], 1)).toBeNull();
    expect(framed(['1 -x', '', '1 +z'], 1)).toBeNull();
    expect(framed(['1 -x', '1 +z'], 1)).toEqual({ old: 'x', new: 'z' });
  });

  it('linia czytelna na dwa sposoby (kontynuacja albo linia z numerem) → null', () => {
    // A context continuation holding `42 -y` also has the shape of line 42 with a removal (W = 10, the first row is
    // the witness).
    expect(sides([[5, ' ', `${'x'.repeat(10)}abcde`]], 14)).toEqual({ old: `${'x'.repeat(10)}abcde`, new: `${'x'.repeat(10)}abcde` });
    expect(sides([[5, ' ', `${'x'.repeat(10)}42 -y`]], 14)).toBeNull();
    // W = 5: both the first row and the continuation are W wide.
    expect(framed(['1  Paaaa', '   99 x', '2 -a', '2 +b'], 5)).toEqual({ old: 'Paaaa99 x\na', new: 'Paaaa99 x\nb' });
    expect(framed(['1  Paaaa', '   99 -x', '2 -a', '2 +b'], 5)).toBeNull();
  });
});

describe('editContradictsOperation — ekran przeczy wywołaniu (wykluczenie wpisu bez `cwd`)', () => {
  const op = parseOptions(SCREEN)?.operation ?? null;
  const input = (over: Record<string, unknown> = {}) => ({ ...(zrzut().toolInput as Record<string, unknown>), ...over });

  it('ta sama edycja tego samego pliku względnego w dowolnym katalogu → nie przeczy', () => {
    expect(editContradictsOperation(input(), op, HOME)).toBe(false);
    expect(editContradictsOperation(input({ file_path: '/inny/konfig/ustawienia.json' }), op, HOME)).toBe(false);
  });

  it('inny plik → przeczy', () => {
    expect(editContradictsOperation(input({ file_path: `${CWD}/ustawienia.json` }), op, HOME)).toBe(true);
    expect(editContradictsOperation(input({ file_path: `${CWD}/inny-konfig/ustawienia.json` }), op, HOME)).toBe(true);
    expect(editContradictsOperation({ file_path: '/old/file.txt' }, op, HOME)).toBe(true);
  });

  it('inny diff NIE przeczy: niewyjaśniony diff nie dowodzi sprzeczności', () => {
    expect(editContradictsOperation(input({ new_string: `${LONG_A},\n${LONG_C}\n    ],` }), op, HOME)).toBe(false);
    // A line the frame wraps without a row exactly W wide (the first row ends with a space at W): the same edit,
    // and a diff without proof.
    const long = `${'a'.repeat(123)} ${'b'.repeat(100)}`;
    const rows: ReadonlyArray<readonly [number, Mark, string]> = [[1, '-', 'x'], [1, '+', long]];
    const frame = parseOptions(screenWith({ rows }))?.operation ?? null;
    const wpis = { file_path: FILE, old_string: 'x', new_string: long };
    expect(editMatchesOperation(wpis, frame, CWD, HOME)).toBe(false);
    expect(editContradictsOperation(wpis, frame, HOME)).toBe(false);
  });

  it('`replace_all` na `a b ab`: diff `x ab` wyjaśnia zarówno zamiana wszystkich `a b`, jak i jedna zamiana `a b ab`', () => {
    // Dawne porównanie bez białych znaków widziało tu dwa wystąpienia `ab` i nie wyjaśniało prawdziwej zamiany.
    const rows: ReadonlyArray<readonly [number, Mark, string]> = [[1, '-', 'a b ab'], [1, '+', 'x ab']];
    const frame = parseOptions(screenWith({ rows }))?.operation ?? null;
    expect(editMatchesOperation({ file_path: FILE, old_string: 'a b', new_string: 'x', replace_all: true }, frame, CWD, HOME))
      .toBe(true);
    expect(editMatchesOperation({ file_path: FILE, old_string: 'a b ab', new_string: 'x ab' }, frame, CWD, HOME)).toBe(true);
    expect(editMatchesOperation({ file_path: FILE, old_string: 'ab', new_string: 'x', replace_all: true }, frame, CWD, HOME))
      .toBe(false);
  });

  it('niewiadoma nie przeczy: ramka ucięta, wejście bez `file_path`, ścieżka względna', () => {
    const cut = parseOptions(screenWith({ headerVisible: false }))?.operation ?? null;
    expect(editContradictsOperation({ file_path: '/old/file.txt' }, cut, HOME)).toBe(false);
    expect(editContradictsOperation({ old_string: 'x', new_string: 'y' }, op, HOME)).toBe(false);
    expect(editContradictsOperation({}, op, HOME)).toBe(false);
    expect(editContradictsOperation(input({ file_path: 'konfig/ustawienia.json' }), op, HOME)).toBe(false);
  });

  it('poprawny wpis `replace_all` i zrzut tego diffu w innym katalogu → karta bez przycisków', () => {
    // Review kodu: diff po zwinięciu białych znaków wykluczał poprawny wpis i przyciski dostawał zrzut innego pliku.
    const rows: ReadonlyArray<readonly [number, Mark, string]> = [[1, '-', 'a b ab'], [1, '+', 'x ab']];
    const ekran = screenWith({ rows, path: 'konfig/ustawienia.json' });
    const wpis: PendingTool = {
      id: 'toolu_edit', toolName: 'Edit', at: '2026-11-04T09:00:00Z',
      input: { file_path: FILE, old_string: 'a b', new_string: 'x', replace_all: true },
    };
    const raw = zrzut({ cwd: '/inny' }, {
      file_path: '/inny/konfig/ustawienia.json', old_string: 'a b ab', new_string: 'x ab', replace_all: false,
    });
    const hookPending = hookPendingFrom(raw);
    if (hookPending === null) throw new Error('zrzut bez narzędzia');
    expect(hookMatchesScreen(hookPending, ekran)).toBe(true);
    const action = decideCard(wejscie(raw, ekran, { pending: wpis, reqId: decideReqId(hookPending, 7, wpis) }));
    if (action.kind !== 'card' || action.card.event.type !== 'permission-request') throw new Error('spodziewano karty');
    expect(action.audit).toBe('mismatch');
    expect(action.card.event.input).toBeNull();
    expect(action.card.active.options).toEqual([]);
  });
});

describe('editMatchesOperation — zamiana old_string na new_string', () => {
  const op = (rows: ReadonlyArray<readonly [number, Mark, string]>) => parseOptions(screenWith({ rows }))?.operation ?? null;
  const edycja = (oldString: string, newString: string, replaceAll?: boolean) => ({
    file_path: FILE, old_string: oldString, new_string: newString, ...(replaceAll === undefined ? {} : { replace_all: replaceAll }),
  });

  it('replace_all: wszystkie wystąpienia w diffie; bez niego jedno wystąpienie nie wyjaśnia diffu', () => {
    const rows: ReadonlyArray<readonly [number, Mark, string]> = [
      [1, '-', 'a = 1'], [1, '+', 'a = 2'], [2, ' ', 'b'], [3, '-', 'a = 1'], [3, '+', 'a = 2'],
    ];
    expect(editMatchesOperation(edycja('a = 1', 'a = 2', true), op(rows), CWD, HOME)).toBe(true);
    expect(editMatchesOperation(edycja('a = 1', 'a = 2', false), op(rows), CWD, HOME)).toBe(false);
    expect(editMatchesOperation(edycja('a = 1', 'a = 2'), op(rows), CWD, HOME)).toBe(false);
  });

  it('usunięcie (pusty new_string) i pusty old_string', () => {
    const rows: ReadonlyArray<readonly [number, Mark, string]> = [[1, ' ', 'x'], [2, '-', 'usun'], [2, ' ', 'y']];
    expect(editMatchesOperation(edycja('usun\n', ''), op(rows), CWD, HOME)).toBe(true);
    expect(editMatchesOperation(edycja('', 'usun'), op(rows), CWD, HOME)).toBe(false);
    // Bez nowej linii usunięcie zostawia pustą linię 2, której ten diff nie ma (porównanie dosłowne, karta 0d).
    expect(editMatchesOperation(edycja('usun', ''), op(rows), CWD, HOME)).toBe(false);
    const pusta: ReadonlyArray<readonly [number, Mark, string]> = [[1, ' ', 'x'], [2, '-', 'usun'], [2, '+', ''], [3, ' ', 'y']];
    expect(editMatchesOperation(edycja('usun', ''), op(pusta), CWD, HOME)).toBe(true);
  });

  it('wzorce zamiany `String.replace` (`$&`) są zwykłym tekstem', () => {
    const rows: ReadonlyArray<readonly [number, Mark, string]> = [[1, '-', 'a X'], [1, '+', 'a $&$&']];
    expect(editMatchesOperation(edycja('X', '$&$&'), op(rows), CWD, HOME)).toBe(true);
    expect(editMatchesOperation(edycja('X', '$&$&', true), op(rows), CWD, HOME)).toBe(true);
    expect(editMatchesOperation(edycja('X', 'XX'), op(rows), CWD, HOME)).toBe(false);
  });

  it('treść dosłownie: spacja w wierszu, granica linii i wcięcie to inna edycja', () => {
    const spacja: ReadonlyArray<readonly [number, Mark, string]> = [[1, '-', 'rm -rf /tmp/x'], [1, '+', 'rm -rf / safe']];
    expect(editMatchesOperation(edycja('/tmp/x', '/ safe'), op(spacja), CWD, HOME)).toBe(true);
    expect(editMatchesOperation(edycja('/tmp/x', '/safe'), op(spacja), CWD, HOME)).toBe(false);
    const granica: ReadonlyArray<readonly [number, Mark, string]> = [[1, '-', 'a'], [1, '+', 'b'], [2, '+', 'c']];
    expect(editMatchesOperation(edycja('a', 'b\nc'), op(granica), CWD, HOME)).toBe(true);
    expect(editMatchesOperation(edycja('a', 'b c'), op(granica), CWD, HOME)).toBe(false);
    expect(editMatchesOperation(edycja('a', 'bc'), op(granica), CWD, HOME)).toBe(false);
    const wciecie: ReadonlyArray<readonly [number, Mark, string]> = [[1, '-', 'x'], [1, '+', '  y']];
    expect(editMatchesOperation(edycja('x', '  y'), op(wciecie), CWD, HOME)).toBe(true);
    expect(editMatchesOperation(edycja('x', 'y'), op(wciecie), CWD, HOME)).toBe(false);
    // Tabulator CLI rysuje spacjami w nieznanej liczbie (szerokość niezmierzona): brak dowodu, nie zgadywanie.
    expect(editMatchesOperation(edycja('x', '\ty'), op(wciecie), CWD, HOME)).toBe(false);
  });

  it('biały znak na końcu linii w `old_string`, `new_string` albo w wyniku zamiany → false: ekran go nie pokazuje', () => {
    // Usunięcie ostatniego słowa bez spacji przed nim zostawia spację na końcu linii, której ramka nie ma.
    const usun: ReadonlyArray<readonly [number, Mark, string]> = [[1, '-', 'foo bar'], [1, '+', 'foo']];
    expect(editMatchesOperation(edycja('bar', ''), op(usun), CWD, HOME)).toBe(false);
    expect(editMatchesOperation(edycja(' bar', ''), op(usun), CWD, HOME)).toBe(true);
    const kontekst: ReadonlyArray<readonly [number, Mark, string]> = [[1, ' ', 'foo bar'], [2, '-', 'x'], [2, '+', 'y']];
    expect(editMatchesOperation(edycja('bar\nx', 'bar\ny'), op(kontekst), CWD, HOME)).toBe(true);
    expect(editMatchesOperation(edycja('bar  \nx', 'bar  \ny'), op(kontekst), CWD, HOME)).toBe(false);
    expect(editMatchesOperation(edycja('bar\t\nx', 'bar\t\ny'), op(kontekst), CWD, HOME)).toBe(false);
    expect(editMatchesOperation(edycja('bar\nx', 'bar\ny '), op(kontekst), CWD, HOME)).toBe(false);
    // Sam `\r` tuż przed `\n` (CRLF) kończy linię; `\r` bez `\n` za nim albo spacja przed nim to biały znak na końcu.
    expect(editMatchesOperation(edycja('bar\r\nx', 'bar\r\ny'), op(kontekst), CWD, HOME)).toBe(true);
    expect(editMatchesOperation(edycja('bar \r\nx', 'bar \r\ny'), op(kontekst), CWD, HOME)).toBe(false);
    expect(editMatchesOperation(edycja('bar\r\r\nx', 'bar\r\r\ny'), op(kontekst), CWD, HOME)).toBe(false);
    const zmiana: ReadonlyArray<readonly [number, Mark, string]> = [[1, '-', 'x'], [1, '+', 'y']];
    expect(editMatchesOperation(edycja('x', 'y'), op(zmiana), CWD, HOME)).toBe(true);
    expect(editMatchesOperation(edycja('x', 'y\t'), op(zmiana), CWD, HOME)).toBe(false);
    expect(editMatchesOperation(edycja('x', 'y '), op(zmiana), CWD, HOME)).toBe(false);
    expect(editMatchesOperation(edycja('x', 'y\r'), op(zmiana), CWD, HOME)).toBe(false);
  });

  it('spacja po końcowym backslashu: `\\ ` to inny skrypt niż kontynuacja linii, więc bez dowodu', () => {
    const skrypt: ReadonlyArray<readonly [number, Mark, string]> = [
      [1, '-', 'x'], [1, '+', "printf '%s\\n' safe \\"], [2, '+', 'exit 7'],
    ];
    expect(editMatchesOperation(edycja('x', "printf '%s\\n' safe \\\nexit 7"), op(skrypt), CWD, HOME)).toBe(true);
    expect(editMatchesOperation(edycja('x', "printf '%s\\n' safe \\ \nexit 7"), op(skrypt), CWD, HOME)).toBe(false);
    expect(editMatchesOperation(edycja('x', "printf '%s\\n' safe \\\t\nexit 7"), op(skrypt), CWD, HOME)).toBe(false);
  });

  it('koniec `old_string` i `new_string` bywa środkiem linii: biały znak tam widać, więc rozstrzyga porównanie', () => {
    // Ostatni fragment (po ostatnim `\n`) kończy się tam, gdzie kończy się tekst wywołania, nie linia pliku.
    const slowo: ReadonlyArray<readonly [number, Mark, string]> = [[1, '-', 'foo bar'], [1, '+', 'bar']];
    expect(editMatchesOperation(edycja('foo ', ''), op(slowo), CWD, HOME)).toBe(true);
    const dwie: ReadonlyArray<readonly [number, Mark, string]> = [[1, ' ', 'x'], [2, '-', 'foo bar'], [2, '+', 'bar']];
    expect(editMatchesOperation(edycja('x\nfoo ', 'x\n'), op(dwie), CWD, HOME)).toBe(true);
    const wstaw: ReadonlyArray<readonly [number, Mark, string]> = [[1, '-', 'xay'], [1, '+', 'xb y']];
    expect(editMatchesOperation(edycja('a', 'b '), op(wstaw), CWD, HOME)).toBe(true);
    // Ten sam koniec przy końcu linii pliku: ekran pokazałby pustą komórkę.
    const koniec: ReadonlyArray<readonly [number, Mark, string]> = [[1, '-', 'foo'], [1, '+', 'bar']];
    expect(editMatchesOperation(edycja('foo', 'bar '), op(koniec), CWD, HOME)).toBe(false);
    expect(editMatchesOperation(edycja('foo ', 'bar'), op(koniec), CWD, HOME)).toBe(false);
  });

  it('a line the frame wraps proves this edit under the measured geometry; without the space, or with no row exactly'
    + ' W wide, no proof', () => {
    const long = `${'a'.repeat(100)} ${'b'.repeat(100)}`;
    const rows: ReadonlyArray<readonly [number, Mark, string]> = [[1, '-', 'x'], [1, '+', long]];
    expect(editMatchesOperation(edycja('x', long), op(rows), CWD, HOME)).toBe(true);
    expect(editMatchesOperation(edycja('x', long.replace(' ', '')), op(rows), CWD, HOME)).toBe(false);
    // W = 128 − 3 − 1 = 124; a space at W leaves the first row one column short, and no other row reaches W.
    const atW = `${'a'.repeat(123)} ${'b'.repeat(100)}`;
    expect(editMatchesOperation(edycja('x', atW), op([[1, '-', 'x'], [1, '+', atW]]), CWD, HOME)).toBe(false);
  });

  it('replace_all innego typu niż boolean → false', () => {
    expect(editMatchesOperation({ ...edycja('X', '$&$&'), replace_all: 'true' }, op([[1, '-', 'a X'], [1, '+', 'a $&$&']]), CWD, HOME))
      .toBe(false);
  });
});

describe('zmierzony dialog Edit (CLI 2.1.293)', () => {
  const EDIT = readFileSync(join(import.meta.dirname, 'fixtures', 'herdr', 'measured', 'zgoda-edit-2.1.293.txt'), 'utf8');
  const measured = (input: Record<string, unknown>, cwd: string | null = '/pomiar'): PendingHookTool => ({
    toolName: 'Edit', hookEventName: 'PermissionRequest', at: 5, toolInput: input,
    ...(cwd === null ? {} : { cwd }),
  });

  it('zrzut tej edycji z cwd pomiaru → karta ze zrzutu', () => {
    const raw = measured({ file_path: '/pomiar/pomiar-dialogow.txt', old_string: 'stara wartosc', new_string: 'nowa wartosc' });
    expect(kartaZeZrzutu(raw, EDIT)).toBe(true);
  });

  it('inna wartość, inny plik albo brak cwd → zrzut odrzucony (zostaje karta z samego ekranu)', () => {
    expect(kartaZeZrzutu(measured({
      file_path: '/pomiar/pomiar-dialogow.txt', old_string: 'stara wartosc', new_string: 'inna wartosc',
    }), EDIT)).toBe(false);
    expect(kartaZeZrzutu(measured({
      file_path: '/pomiar/inny.txt', old_string: 'stara wartosc', new_string: 'nowa wartosc',
    }), EDIT)).toBe(false);
    expect(kartaZeZrzutu(measured({
      file_path: '/pomiar/pomiar-dialogow.txt', old_string: 'stara wartosc', new_string: 'nowa wartosc',
    }, null), EDIT)).toBe(false);
  });
});

describe('`Edit` from a transcript entry without a dump: the call `cwd` of the entry', () => {
  const EDIT = readFileSync(join(import.meta.dirname, 'fixtures', 'herdr', 'measured', 'zgoda-edit-2.1.293.txt'), 'utf8');
  const entry = (entryCwd?: string): PendingTool => ({
    id: 'toolu_edit', toolName: 'Edit', at: '2026-08-22T10:00:06.000Z',
    input: { file_path: '/pomiar/pomiar-dialogow.txt', old_string: 'stara wartosc', new_string: 'nowa wartosc' },
    ...(entryCwd === undefined ? {} : { entryCwd }),
  });
  const buttons = (pending: PendingTool, cwd: string): boolean => {
    const action = decideCard({
      pending, hookPending: null, text: EDIT, reqId: 'toolu_edit', active: null, blockedSeq: 7, answeredSeq: -1,
      hookAnswersEnabled: true, deadAnswerKey: null, canRetry: false, answeredHookCall: null, decided: null,
      resolve: resolveOptions, excerpt: (t: string) => t.trim() || null, hookRaw: null, cwd,
    });
    return action.kind === 'card' && action.card.event.type === 'permission-request' && action.card.event.input !== null
      && action.card.active.options.length > 0;
  };

  it('after a `cd` the pane stays on the start directory: the entry `cwd` proves the relative path', () => {
    expect(buttons(entry('/pomiar'), '/start')).toBe(true);
  });

  it('without the entry `cwd` the pane directory decides: another directory gives no buttons', () => {
    expect(buttons(entry(), '/start')).toBe(false);
    expect(buttons(entry(), '/pomiar')).toBe(true);
  });
});
