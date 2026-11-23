/**
 * Licznik auto-odmowy w brzmieniu CLI 2.1.316 nie jest treścią dialogu (`herdr/dialogs/screen/auto-deny.ts`).
 *
 * CLI 2.1.316 writes “⚠ Claude Code will automatically block this request in 1:38, to avoid holding up an unattended
 * session”; CLI 2.1.294 writes “deny … blocking progress on”. A counter left in the question text and in the card
 * print would give a different print on every read, and the check before the digit would refuse with
 * `screen-changed` on every tap. The fixture is a reconstruction with the frame of a real refusal (128 columns) and
 * a neutral command (`server/test/fixtures/herdr/README.md`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseOptions } from '../src/herdr/dialogs/screen/parse.ts';
import { commandMatches } from '../src/herdr/dialogs/screen/operation.ts';
import { withoutAutoDeny } from '../src/herdr/dialogs/screen/auto-deny.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures/herdr');
const EKRAN = readFileSync(join(FIXTURES, 'dialog-bash-licznik-block-2.1.316.txt'), 'utf8');
const KOMENDA = (JSON.parse(readFileSync(
  join(FIXTURES, 'dialog-bash-licznik-block-2.1.316.command.json'), 'utf8',
)) as { command: string }).command;
const za = (czas: string): string => EKRAN.replace('block this request in 1:38,', `block this request in ${czas},`);

describe('licznik auto-odmowy CLI 2.1.316', () => {
  it('fixture niesie licznik w nowym brzmieniu', () => {
    expect(EKRAN).toContain('⚠ Claude Code will automatically block this request in 1:38, to avoid holding up');
    expect(za('0:07')).not.toBe(EKRAN);
  });

  it('cały dialog z treścią: ramka pokazuje komendę z jsonl, pytanie bez licznika', () => {
    const dialog = parseOptions(EKRAN);
    expect(dialog?.kind).toBe('tool');
    const operation = dialog?.operation ?? null;
    expect(operation?.complete).toBe(true);
    expect(operation?.headerVisible).toBe(true);
    expect(operation !== null && commandMatches(operation, KOMENDA)).toBe(true);
    const question = dialog?.question?.question ?? '';
    expect(question).not.toBe('');
    expect(question).not.toMatch(/automatically block|unattended session|\d+:\d{2}/u);
  });

  it('odcisk i treść nie zależą od wartości licznika', () => {
    const early = parseOptions(za('1:38'));
    const late = parseOptions(za('0:07'));
    expect(early?.bodyPrint).toMatch(/^[0-9a-f]{16}$/u);
    expect(late?.bodyPrint).toBe(early?.bodyPrint);
    expect(late?.question).toEqual(early?.question);
  });

  it('zdanie zawinięte przez wąski panel na dwie linie też wypada', () => {
    expect(withoutAutoDeny(['Opis', '⚠ Claude Code will automatically block this request in 1:58, to avoid',
      'holding up an unattended session', 'Do you want to proceed?']))
      .toEqual(['Opis', '', '', 'Do you want to proceed?']);
  });

  it('to samo zdanie ZACYTOWANE w środku pytania autora zostaje', () => {
    const cytat = 'Co znaczy: ⚠ Claude Code will automatically block this request in 1:58, '
      + 'to avoid holding up an unattended session?';
    expect(withoutAutoDeny([cytat])).toEqual([cytat]);
  });
});
