/**
 * The kind of a file dialog (`Edit` "Edit file", `Write` "Create file") when the key footer is cut or wrapped
 * (`server/src/herdr/dialogs/screen/file-dialog.ts`; `docs/dialogs.md`, "Permission dialog operation").
 *
 * A file dialog asks about its file ("Do you want to make this edit to <name>?", "Do you want to create <name>?"), not
 * "Do you want to proceed?", so "Tab to amend" in the key footer is its only kind marker. A narrow pane cuts the
 * footer with an ellipsis (the `replace_all` note "One-time Yes only: places not shown" in front of it at 57 columns)
 * or wraps it, and the dialog was read as a generic confirmation: a question card whose "Yes" sends digit 1 with the
 * consent channel off. The block title, the whole frame under the dialog's own header and the file question under the
 * frame name the dialog instead. When the title names a file dialog but the other parts do not prove its shape, the
 * dialog is no confirmation and gets no form.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseOptions } from '../src/herdr/dialogs/screen/parse.ts';
import { resolveOptions } from '../src/herdr/dialogs/screen/resolve.ts';
import type { ExpectedDecision } from '../src/herdr/dialogs/screen/resolve.ts';

const DIR = join(import.meta.dirname, 'fixtures', 'herdr');
const read = (name: string): string => readFileSync(join(DIR, name), 'utf8');

const HUNKS_57 = read('kontrolny/zgoda-edit-wrap-hunks-57-2.1.330.txt');
const HUNKS_99 = read('kontrolny/zgoda-edit-wrap-hunks-99-2.1.330.txt');
const GEO_57 = read('kontrolny/zgoda-write-wrap-geo-57-2.1.330.txt');
const EDIT = read('measured/zgoda-edit-2.1.293.txt');
const CREATE = read('measured/zgoda-write-2.1.322.txt');

const CUT_NOTE_FOOTER = ' One-time Yes only: places not shown · Esc to cancel · …';
const NOTE_FOOTER = ' One-time Yes only: places not shown · Esc to cancel · Tab to amend';
const FOOTER = ' Esc to cancel · Tab to amend';
const CUT_FOOTER = ' Esc to cancel · …';

/** The screen with `from` replaced by `to`; a missing `from` is a test error, not a silent pass. */
function replaced(screen: string, from: string, to: string): string {
  if (!screen.includes(from)) throw new Error(`screen without "${from.trim()}"`);
  return screen.replace(from, to);
}

const kindOf = (screen: string): { kind: string | undefined; identity: unknown } => {
  const dialog = parseOptions(screen);
  return { kind: dialog?.kind, identity: dialog?.identity };
};

const EDIT_TOOL = { kind: 'tool', identity: { kind: 'title', tool: 'Edit' } };
const WRITE_TOOL = { kind: 'tool', identity: { kind: 'title', tool: 'Write' } };

/** No confirmation and no form: the screen-only card has no option to approve. */
function expectNoForm(screen: string): void {
  expect(parseOptions(screen)).toMatchObject({ kind: 'other', question: null, knownDialog: null });
  expect(resolveOptions(screen, null)).toMatchObject({
    status: 'no-jsonl', knownDialog: null, questionForm: null, options: [],
  });
}

describe('file dialog with a cut or wrapped key footer', () => {
  it('the measured `replace_all` dialog at 57 columns is an `Edit` consent, as at 99 columns', () => {
    expect(kindOf(HUNKS_99)).toEqual(EDIT_TOOL);
    expect(kindOf(HUNKS_57)).toEqual(EDIT_TOOL);
  });

  it('the note wrapped inside the frame does not decide the kind: with the footer whole it is a consent', () => {
    expect(kindOf(replaced(HUNKS_57, CUT_NOTE_FOOTER, NOTE_FOOTER))).toEqual(EDIT_TOOL);
  });

  it('the cut footer does: the 99-column frame, note on one row, footer cut as at 57 columns', () => {
    expect(kindOf(replaced(HUNKS_99, NOTE_FOOTER, CUT_NOTE_FOOTER))).toEqual(EDIT_TOOL);
  });

  it.each([
    ['cut with an ellipsis', CUT_FOOTER],
    ['wrapped on two rows', ' Esc to cancel · Tab to\n amend'],
  ])('`Edit` and `Write` with the footer %s stay consents with the title identity', (_name, footer) => {
    expect(kindOf(replaced(EDIT, FOOTER, footer))).toEqual(EDIT_TOOL);
    expect(kindOf(replaced(CREATE, FOOTER, footer))).toEqual(WRITE_TOOL);
  });

  it('without the file question of the header file under the frame: no consent, no confirmation, no form', () => {
    const cut = (screen: string): string => replaced(screen, FOOTER, CUT_FOOTER);
    const otherFile = replaced(cut(EDIT), 'make this edit to pomiar-dialogow.txt?', 'make this edit to inny.txt?');
    const writeQuestion = replaced(cut(EDIT), 'make this edit to pomiar-dialogow.txt?', 'create pomiar-dialogow.txt?');
    const editQuestion = replaced(cut(CREATE), 'create pomiar-dialogow-nowy.txt?', 'make this edit to pomiar-dialogow-nowy.txt?');
    const extraLine = replaced(cut(EDIT), ' Do you want', ' Note: one more line\n Do you want');
    for (const screen of [otherFile, writeQuestion, editQuestion, extraLine]) {
      expect(parseOptions(screen)?.kind).not.toBe('tool');
      expectNoForm(screen);
    }
  });

  it('a `WebFetch` consent without a permission footer keeps its confirmation kind (outside file dialogs)', () => {
    expect(parseOptions(read('measured/zgoda-webfetch-2.1.322.txt'))?.kind).toBe('confirm');
  });
});

/*
 * A header path longer than the pane continues on a second row, so the header has three lines and does not prove
 * the dialog's file (`editShownName`). How the CLI breaks a header path is unmeasured; these screens break it hard at
 * the content width of a 57-column pane (56 columns after the one-column margin).
 */
const LONG_DIR = `atlas-${'d'.repeat(54)}`;
const PANE_CONTENT = 56;

function wrappedPath(screen: string, name: string): string {
  const path = `${LONG_DIR}/${name}`;
  return replaced(screen, `\n ${name}\n╌`, `\n ${path.slice(0, PANE_CONTENT)}\n ${path.slice(PANE_CONTENT)}\n╌`);
}

/** The measured call of a capture with the file moved into {@link LONG_DIR} when `wrapped`. */
function callOf(name: string, wrapped: boolean): ExpectedDecision {
  const measured = JSON.parse(read(`kontrolny/${name}.input.json`)) as {
    toolName: string; input: Record<string, unknown>; cwd: string;
  };
  const file = String(measured.input['file_path']).split('/').pop() ?? '';
  const filePath = wrapped ? `${measured.cwd}/${LONG_DIR}/${file}` : measured.input['file_path'];
  return {
    toolName: measured.toolName,
    fileCall: {
      change: measured.toolName === 'Edit' ? 'edit' : 'write', input: { ...measured.input, file_path: filePath },
      cwd: measured.cwd,
    },
  };
}

const WRAPPED_HEADER: readonly { label: string; screen: string; whole: string; tool: unknown; call: ExpectedDecision }[] = [
  {
    label: '`Edit` with the measured cut footer',
    screen: wrappedPath(HUNKS_57, 'notes-hunki-57.md'),
    whole: replaced(wrappedPath(HUNKS_57, 'notes-hunki-57.md'), CUT_NOTE_FOOTER, NOTE_FOOTER),
    tool: EDIT_TOOL,
    call: callOf('zgoda-edit-wrap-hunks-57-2.1.330', true),
  },
  {
    label: '`Write` "Create file" with the footer cut',
    screen: replaced(wrappedPath(GEO_57, 'new-geo-57.md'), FOOTER, CUT_FOOTER),
    whole: wrappedPath(GEO_57, 'new-geo-57.md'),
    tool: WRITE_TOOL,
    call: callOf('zgoda-write-wrap-geo-57-2.1.330', true),
  },
];

describe('file dialog title with the header path over two rows and the footer marker gone', () => {
  it.each(WRAPPED_HEADER)('$label: with the footer whole the same screen is a consent under three header lines',
    ({ whole, tool }) => {
      const dialog = parseOptions(whole);
      expect({ kind: dialog?.kind, identity: dialog?.identity }).toEqual(tool);
      expect(dialog?.operation).toMatchObject({ complete: true, headerVisible: true });
      expect(dialog?.operation?.header).toHaveLength(3);
    });

  it.each(WRAPPED_HEADER)('$label: no confirmation and no form, so no option to approve', ({ screen }) => {
    expectNoForm(screen);
  });

  it.each(WRAPPED_HEADER)('$label: the pending call of the dialog does not match the screen', ({ screen, call }) => {
    expect(resolveOptions(screen, call)).toMatchObject({ status: 'mismatch' });
  });

  it('the same `Write` with one header path row and the footer cut proves its own call', () => {
    const screen = replaced(GEO_57, FOOTER, CUT_FOOTER);
    expect(kindOf(screen)).toEqual(WRITE_TOOL);
    expect(resolveOptions(screen, callOf('zgoda-write-wrap-geo-57-2.1.330', false))).toMatchObject({ status: 'ok' });
  });
});
