/**
 * Operacja dialogu zgody z ekranu (`herdr/dialogs/screen/operation.ts`).
 *
 * Fixture'y to ekrany z incydentów (zrzuty odmów, anonimizacja z zachowaniem długości, bo
 * zawijanie zależy od szerokości) i z pomiaru skryptem (`zgoda-bash-wysoka`), a obok
 * nich komendy z jsonl (`*.command.json`). Sprawdzamy, że ramka pokazuje TĘ komendę — z ekranu
 * 63-kolumnowego, 128-kolumnowego i z nagłówkiem uciętym nad krawędzią — i że nie pokazuje innej.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseOptions } from '../src/herdr/dialogs/screen/parse.ts';
import { resolveOptions } from '../src/herdr/dialogs/screen/resolve.ts';
import {
  OPERATION_MIN_SUFFIX_CHARS, commandMatches, operationText,
} from '../src/herdr/dialogs/screen/operation.ts';
import type { ScreenOperation } from '../src/herdr/dialogs/screen/operation.ts';
import { withoutAutoDeny } from '../src/herdr/dialogs/screen/auto-deny.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures/herdr');
const screen = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');
const command = (name: string): string => (
  JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as { command: string }).command;

function operationOf(text: string): ScreenOperation {
  const dialog = parseOptions(text);
  expect(dialog?.kind).toBe('tool');
  const operation = dialog?.operation ?? null;
  expect(operation).not.toBeNull();
  return operation as ScreenOperation;
}

const CASES = [
  {
    name: 'incydent 2026-10-08: nagłówek nad krawędzią, panel 63 kolumny',
    screen: 'dialog-bash-uciety-naglowek-2.1.294.txt',
    command: 'dialog-bash-uciety-naglowek-2.1.294.command.json',
    complete: false,
  },
  {
    name: 'pomiar 2.1.295: komenda 92-liniowa, widać tylko jej koniec',
    screen: 'measured/zgoda-bash-wysoka-2.1.295.txt',
    command: 'zgoda-bash-wysoka-2.1.295.command.json',
    complete: false,
  },
  {
    name: 'incydent 2026-10-09 18:57: cały dialog, panel 63 kolumny',
    screen: 'dialog-bash-stechly-read-2.1.295.txt',
    command: 'dialog-bash-stechly-read-2.1.295.command.json',
    complete: true,
  },
  {
    name: 'incydent 2026-10-09 18:50: cały dialog, panel 128 kolumn',
    screen: 'dialog-bash-stechly-read-szeroki-2.1.295.txt',
    command: 'dialog-bash-stechly-read-szeroki-2.1.295.command.json',
    complete: true,
  },
] as const;

describe('ramka operacji z ekranu', () => {
  it.each(CASES)('$name: ramka pokazuje komendę z jsonl', (c) => {
    const operation = operationOf(screen(c.screen));
    expect(operation.complete).toBe(c.complete);
    expect(operation.headerVisible).toBe(c.complete);
    expect(commandMatches(operation, command(c.command))).toBe(true);
  });

  it('jednoliniowa komenda bez paska `│` (zgoda-bash 2.1.293) też jest operacją', () => {
    const operation = operationOf(screen('measured/zgoda-bash-2.1.293.txt'));
    expect(operation).toMatchObject({ complete: true, headerVisible: true });
    expect(operationText(operation)).toBe('touch ~/Library/Caches/pomiar-dialogow.txt');
    expect(commandMatches(operation, 'touch ~/Library/Caches/pomiar-dialogow.txt')).toBe(true);
    expect(commandMatches(operation, 'touch ~/Library/Caches/pomiar-dialogow.txt && rm -r ~')).toBe(false);
  });

  it('dialog bez ramki `╌╌╌` (MCP) nie ma operacji', () => {
    expect(parseOptions(screen('measured/zgoda-mcp.txt'))?.operation).toBeNull();
  });

  it('pytanie AskUserQuestion nie ma operacji', () => {
    expect(parseOptions(screen('measured/pytanie-jednokrotne.txt'))?.operation).toBeNull();
  });
});

describe('commandMatches odrzuca inną komendę', () => {
  const tall = (): ScreenOperation => operationOf(screen('measured/zgoda-bash-wysoka-2.1.295.txt'));
  const tallCommand = command('zgoda-bash-wysoka-2.1.295.command.json');
  /** Ramka z ręki: szerokość treści jak w panelu 63-kolumnowym (zmierzone: 59). */
  const ramka = (lines: string[], complete = true): ScreenOperation => ({
    lines, rows: lines.map((line) => ` ${line}`), width: 59, ruleWidth: 63, complete, headerVisible: complete,
    header: [],
  });

  it('ten sam koniec, ale inna linia w widocznej części', () => {
    expect(commandMatches(tall(), tallCommand.replace('pomiar-linia-80', 'pomiar-linia-8O'))).toBe(false);
  });

  it('ucięta ramka musi być KOŃCEM komendy, nie dowolnym jej kawałkiem', () => {
    expect(commandMatches(tall(), `${tallCommand}\nrm -rf ~/Library`)).toBe(false);
  });

  it('spacje wewnątrz linii ramki porównujemy dosłownie', () => {
    const operation = ramka(['rm -rf /Users/u /tmp-cache/review-build-output']);
    expect(commandMatches(operation, 'rm -rf /Users/u /tmp-cache/review-build-output')).toBe(true);
    expect(commandMatches(operation, 'rm -rf /Users/u/tmp-cache/review-build-output')).toBe(false);
    const quoted = ramka(["rm -- '/tmp/a  b'"]);
    expect(commandMatches(quoted, "rm -- '/tmp/a  b'")).toBe(true);
    expect(commandMatches(quoted, "rm -- '/tmp/a b'")).toBe(false);
  });

  it('nowa linia komendy to nie spacja: łamanie, które nie mogło być zawinięciem, wymaga `\\n`', () => {
    // `rm` zmieściłoby się w pierwszej linii — więc CLI złamało ją, bo komenda ma tam nową linię.
    const twoLines = ramka(['printf safe', 'rm -rf /tmp/review-output']);
    expect(commandMatches(twoLines, 'printf safe\nrm -rf /tmp/review-output')).toBe(true);
    expect(commandMatches(twoLines, 'printf safe rm -rf /tmp/review-output')).toBe(false);
    const oneLine = ramka(['printf safe rm -rf /tmp/review-output']);
    expect(commandMatches(oneLine, 'printf safe rm -rf /tmp/review-output')).toBe(true);
    expect(commandMatches(oneLine, 'printf safe\nrm -rf /tmp/review-output')).toBe(false);
  });

  it('zawinięcie na spacji: następne słowo nie zmieściłoby się w linii', () => {
    const wrapped = ramka([
      'DEVELOPER_DIR="$(rarog_xcode_developer_dir)"; export',
      'DEVELOPER_DIR',
    ]);
    expect(commandMatches(wrapped, 'DEVELOPER_DIR="$(rarog_xcode_developer_dir)"; export DEVELOPER_DIR')).toBe(true);
    // Przy granicy zawinięcia nie wiemy, czy była spacja, czy nowa linia — obie są dozwolone.
    expect(commandMatches(wrapped, 'DEVELOPER_DIR="$(rarog_xcode_developer_dir)"; export\nDEVELOPER_DIR')).toBe(true);
    expect(commandMatches(wrapped, 'DEVELOPER_DIR="$(rarog_xcode_developer_dir)"; exportDEVELOPER_DIR')).toBe(false);
  });

  it('po linii PEŁNEJ szerokości CLI mogło przeciąć słowo', () => {
    const cut = ramka(['"PendingMediaTests|PendingRowsTests|MediaRowsTests|SendCopy', 'Tests|TranscriptRowsTests"']);
    expect(commandMatches(cut, '"PendingMediaTests|PendingRowsTests|MediaRowsTests|SendCopyTests|TranscriptRowsTests"'))
      .toBe(true);
  });

  it(`ucięty koniec krótszy niż ${String(OPERATION_MIN_SUFFIX_CHARS)} znaków nie jest dowodem`, () => {
    expect(commandMatches(ramka(['done', "echo ok'"], false), "bash -c 'for f in *; do rm $f\ndone\necho ok'"))
      .toBe(false);
  });

  it('pusta komenda nigdy nie pasuje', () => {
    expect(commandMatches(tall(), '   ')).toBe(false);
  });
});

describe('licznik auto-odmowy (CLI 2.1.294) nie jest treścią dialogu', () => {
  // Pełny dialog (63 kolumny) z licznikiem dopisanym tak, jak rysuje go 2.1.294.
  const withCountdown = (left: string): string => screen('dialog-bash-stechly-read-2.1.295.txt').replace(
    ' /permissions to let auto mode decide\n',
    ` /permissions to let auto mode decide\n ⚠ Claude Code will automatically deny this request in ${left},\n`
      + ' to avoid blocking progress on an unattended session\n',
  );

  it('tekst pytania nie niesie licznika', () => {
    const question = parseOptions(withCountdown('1:58'))?.question?.question ?? '';
    expect(question).toContain('Contains brace with quote character');
    expect(question).not.toMatch(/automatically deny|unattended session|\d+:\d{2}/u);
  });

  it('treść i odcisk dialogu nie zależą od wartości licznika', () => {
    const early = parseOptions(withCountdown('1:58'));
    const late = parseOptions(withCountdown('0:11'));
    expect(late?.question).toEqual(early?.question);
    expect(late?.bodyPrint).toBe(early?.bodyPrint);
    expect(early?.bodyPrint).not.toBeNull();
  });

  it('to samo zdanie ZACYTOWANE w pytaniu autora zostaje', () => {
    const cytat = 'Co oznacza komunikat: ⚠ Claude Code will automatically deny this request in 1:58, '
      + 'to avoid blocking progress on an unattended session?';
    expect(withoutAutoDeny([cytat])).toEqual([cytat]);
    expect(withoutAutoDeny(['Opis', '⚠ Claude Code will automatically deny this request in 1:58,',
      'to avoid blocking progress on an unattended session', 'Do you want to proceed?']))
      .toEqual(['Opis', '', '', 'Do you want to proceed?']);
  });
});

describe('karta zgody z samego ekranu pokazuje operację', () => {
  const formOf = (text: string) => {
    const resolution = resolveOptions(text, null);
    return resolution.status === 'no-jsonl' ? resolution.questionForm : null;
  };

  it('zwykła zgoda `Bash` 2.1.293: nagłówek, komenda i pytanie na karcie', () => {
    const form = formOf(screen('measured/zgoda-bash-2.1.293.txt'));
    expect(form?.kind).toBe('tool');
    expect(form?.question).toContain('Bash command (unsandboxed)');
    expect(form?.question).toContain('touch ~/Library/Caches/pomiar-dialogow.txt');
    expect(form?.bodyPrint).toMatch(/^[0-9a-f]{16}$/u);
  });

  it('zgoda `Edit`: nazwa pliku i diff na karcie', () => {
    const form = formOf(screen('measured/zgoda-edit.txt'));
    expect(form?.question).toContain('pomiar-dialogow.txt');
    expect(form?.question).toContain('+nowa wartosc');
  });

  it('sieć sandboksa: host jak dotąd', () => {
    const form = formOf(screen('measured/zgoda-siec.txt'));
    expect(form?.question).toContain('Network request outside of sandbox');
    expect(form?.question).toContain('Host: example.org');
  });

  it('dialog ucięty u góry nie dostaje karty z przyciskami z samego ekranu', () => {
    expect(formOf(screen('measured/zgoda-bash-wysoka-2.1.295.txt'))).toBeNull();
    expect(formOf(screen('dialog-bash-uciety-naglowek-2.1.294.txt'))).toBeNull();
  });

  it('dialog bez ramki (MCP) zostaje przy dotychczasowej karcie', () => {
    const form = formOf(screen('measured/zgoda-mcp-2.1.293.txt'));
    expect(form?.question).toContain('catalog — Get Project Tree Layout Tool');
    expect(form?.bodyPrint ?? null).toBeNull();
  });
});

describe('odcisk treści dialogu', () => {
  const text = screen('dialog-bash-stechly-read-2.1.295.txt');
  /** Podmiana w liniach RAMKI (` │ …`) albo wyłącznie w scrollbacku nad dialogiem. */
  const edit = (inFrame: boolean): string => text.split('\n').map((line) => (
    line.startsWith(' │ ') === inFrame ? line.replace("'rarog-uikit.*'", "'rarog-uikiX.*'") : line
  )).join('\n');

  it('inna komenda pod tą samą etykietą i cyfrą daje inny odcisk', () => {
    const other = edit(true);
    expect(other).not.toBe(text);
    const a = parseOptions(text);
    const b = parseOptions(other);
    expect(a?.options).toEqual(b?.options);
    expect(a?.bodyPrint).not.toBe(b?.bodyPrint);
  });

  it('zmiana w scrollbacku nad dialogiem odcisku nie rusza', () => {
    const other = edit(false);
    expect(other).not.toBe(text);
    expect(parseOptions(other)?.bodyPrint).toBe(parseOptions(text)?.bodyPrint);
  });
});
