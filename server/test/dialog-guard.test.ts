/**
 * Strażnik wysokości dialogu zgody `Bash`.
 *
 * Dialog zgody wyższy niż panel na telefonie chowa tytuł i początek komendy nad krawędzią. U subagenta
 * Rarog nie ma wtedy podwójnego dowodu i karta idzie bez przycisków — 10 z 24 zrzutów odmów
 * w 48 h pomiaru. Hook odmawia FORMY takiego dialogu (`deny` z komunikatem „podziel, jedno po
 * drugim”), zanim dialog stanie.
 *
 * Trzy części: (1) szacunek wierszy w czystym module `scripts/hooks/tall-dialog.mjs` — zawijanie
 * sprawdzone na PRAWDZIWYCH zrzutach z telefonu, stałe przeliczone z fixture'u; (2) hook jako PROCES
 * (payload na stdin, stdout, pliki w `dataDir`) — wzór z `pending-hook.test.ts`; (3) strona serwera:
 * pole `tallDialogGuard` w `roots.json` i suma `guard.jsonl` (`summarizeGuard`).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { spawn } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  HEADER_MAX_LINES, commandMatches, displayWidth as screenWidth, operationAbove,
} from '../src/herdr/dialogs/screen/operation.ts';
import {
  HOOK_GUARD_LOG_FILENAME, HOOK_GUARD_LOG_MAX_BYTES, HOOK_ROOTS_FILENAME, HOOK_SEEN_FILENAME, readHookRoots,
  rotateGuardLog, summarizeGuard, writeHookRoots,
} from '../src/herdr/hook-config.ts';
import { readPendingHook } from '../src/herdr/dialogs/hook/dump.ts';

const REPO = join(import.meta.dirname, '..', '..');
const HOOK = join(REPO, 'scripts', 'hooks', 'rarog-pending.mjs');
const MODULE = join(REPO, 'scripts', 'hooks', 'tall-dialog.mjs');
const FIXTURES = join(import.meta.dirname, 'fixtures', 'herdr');
const SESSION = '550e8400-e29b-41d4-a716-446655440000';

interface Verdict {
  readonly reason: 'rows' | 'header';
  readonly rows: number;
  readonly budget: number;
  readonly descriptionRows: number;
  readonly maxDescriptionRows: number;
  readonly message: string;
}

/** Kształt modułu `.mjs` — import dynamiczny, bo moduł jest poza projektem TS serwera. */
interface TallDialog {
  readonly PHONE_FIXTURE: string;
  readonly MEASURED_FIXTURE: string;
  readonly PHONE_COLUMNS: number;
  readonly PHONE_ROWS: number;
  readonly FRAME_COLUMNS: number;
  readonly DESCRIPTION_COLUMNS: number;
  readonly FRAME_ROWS: number;
  readonly FRAME_RESERVE_ROWS: number;
  readonly BUDGET_ROWS: number;
  readonly HEADER_MAX_LINES: number;
  readonly MAX_DESCRIPTION_ROWS: number;
  readonly COMMAND_ROWS_HINT: number;
  displayWidth(text: string): number;
  codePointWidth(char: string): number;
  wrapText(text: string, columns: number, mode?: 'upper' | 'cli'): string[];
  wrappedRows(text: string, columns: number, mode?: 'upper' | 'cli'): number;
  estimateDialogRows(command: string, description?: string): {
    rows: number; commandRows: number; descriptionRows: number;
  };
  tallDialogVerdict(toolInput: unknown): Verdict | null;
}

const guard = (await import(pathToFileURL(MODULE).href)) as TallDialog;

const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');
const fixtureCommand = (name: string): { command: string; description?: string } => (
  JSON.parse(fixture(name)) as { command: string; description?: string });

const PHONE = 'dialog-bash-subagent-telefon-2.1.302';
const MEASURED = 'dialog-bash-opis-telefon-2.1.302';
/** Obudowa, zapas i jednowierszowy opis — stała część szacunku w testach. */
const FIXED = (): number => guard.FRAME_ROWS + guard.FRAME_RESERVE_ROWS + 1;
/** Wiersze komendy z fixture'u telefonu w szacunku (tryb `upper`; tryb `cli` też 43). */
const GUARD_TALL_ROWS = 43;

/** Linie ekranu bez pustego ogona i indeks dolnej kreski `╌` ramki operacji. */
function screenOf(name: string): { lines: string[]; lower: number; upper: number } {
  const lines = fixture(name).replace(/\n+$/u, '').split('\n');
  const rules = lines.flatMap((line, index) => (/^╌+$/u.test(line.trim()) ? [index] : []));
  const lower = rules.at(-1) ?? -1;
  const upper = rules.length > 1 ? rules.at(-2) ?? -1 : -1;
  return { lines, lower, upper };
}

/** Komenda `rm -r --` z 40 nazwami po 30 znaków — kontrprzykład do szacunku „znaki / szerokość”. */
const RM_40 = `rm -r -- ${Array.from({ length: 40 }, (_, i) => `wynik-${String(i).padStart(2, '0')}-${'x'.repeat(21)}`).join(' ')}`;

describe('szacunek wierszy: stałe telefonu z fixture\'u i zgodność z parserem ekranu', () => {
  it('fixture telefonu ma kształt odmowy z 10:02 na szerokości z pomiaru: 62 kolumny, 48 wierszy, ramka ucięta', () => {
    expect(guard.PHONE_FIXTURE).toBe(`server/test/fixtures/herdr/${PHONE}.txt`);
    const { lines, lower, upper } = screenOf(`${PHONE}.txt`);
    expect(lines).toHaveLength(guard.PHONE_ROWS);
    expect(screenWidth((lines[lower] ?? '').trim()), 'kreska `╌` = szerokość panelu').toBe(guard.PHONE_COLUMNS);
    expect(upper, 'górnej kreski ramki nie widać — dialog wyższy niż panel').toBe(-1);
    for (const line of lines.slice(0, lower)) expect(line.startsWith(' │ ')).toBe(true);
  });

  it('szerokość treści ramki liczy się tak samo jak w `operationAbove`, a ramka to koniec komendy', () => {
    const { lines, lower } = screenOf(`${PHONE}.txt`);
    const op = operationAbove(lines, lower + 1);
    expect(op).not.toBeNull();
    expect(op?.width).toBe(guard.FRAME_COLUMNS);
    expect(op?.complete).toBe(false);
    expect(op?.headerVisible).toBe(false);
    const { command } = fixtureCommand(`${PHONE}.command.json`);
    expect(op === null ? false : commandMatches(op, command), 'fixture zgodny z regułami zawijania parsera')
      .toBe(true);
    expect(guard.FRAME_COLUMNS, 'pomiar 2026-10-17: 58 kolumn przy panelu 62').toBe(58);
  });

  it('zrzut z pomiaru (62 kolumny): obudowa 13 wierszy, opis i komenda w ramkach `│` po 58 kolumn', () => {
    expect(guard.MEASURED_FIXTURE).toBe(`server/test/fixtures/herdr/${MEASURED}.txt`);
    const { lines, lower, upper } = screenOf(`${MEASURED}.txt`);
    const { command, description } = fixtureCommand(`${MEASURED}.command.json`);
    expect(screenWidth((lines[lower] ?? '').trim())).toBe(guard.PHONE_COLUMNS);
    // Opis wieloliniowy stoi w ramce `│` między tytułem a górną kreską `╌` — zawinięty jak komenda.
    const descriptionLines = lines.slice(2, upper).map((line) => line.replace(/^ │ /u, '').trim());
    expect(guard.wrapText(description ?? '', guard.DESCRIPTION_COLUMNS, 'cli').map((row) => row.trim()))
      .toEqual(descriptionLines);
    const op = operationAbove(lines, lower + 1);
    expect(op?.complete).toBe(true);
    expect(op?.headerVisible).toBe(true);
    expect(op?.width).toBe(guard.FRAME_COLUMNS);
    expect(op === null ? false : commandMatches(op, command)).toBe(true);
    // Cały dialog na ekranie = obudowa + opis + komenda w układzie CLI.
    const cliRows = guard.wrappedRows(command, guard.FRAME_COLUMNS, 'cli');
    expect(cliRows).toBe(3);
    expect(lines).toHaveLength(guard.FRAME_ROWS + 3 + cliRows);
    // Szacunek: zapas obudowy i słowo dłuższe od ramki od nowego wiersza (górne ograniczenie, +1).
    const estimate = guard.estimateDialogRows(command, description);
    expect(estimate.descriptionRows).toBe(3);
    expect(estimate.commandRows).toBe(cliRows + 1);
    expect(estimate.rows).toBeGreaterThanOrEqual(lines.length + guard.FRAME_RESERVE_ROWS);
  });

  it('limit nagłówka jest ten sam, co w parserze (`HEADER_MAX_LINES`)', () => {
    expect(guard.HEADER_MAX_LINES).toBe(HEADER_MAX_LINES);
    // Tytuł (1) + podpowiedź trybu default (2) + opis mieszczą się w 11 liniach nad ramką.
    expect(guard.MAX_DESCRIPTION_ROWS).toBe(HEADER_MAX_LINES - 1 - 3);
  });

  it('szerokość znaków jak w parserze: znaki szerokie i emoji liczą się podwójnie', () => {
    for (const text of ['abc', '界界', 'zażółć', '🚀 ok', '全角ＡＢ']) {
      expect(guard.displayWidth(text), text).toBe(screenWidth(text));
    }
    expect(guard.displayWidth('\t'), 'tabulator: 8 kolumn (szacunek w górę)').toBe(8);
  });
});

describe('szacunek wierszy: zawijanie odtwarza PRAWDZIWE ramki CLI', () => {
  /*
   * Zrzuty z żywych paneli (telefon 62–63 kolumny i Mac 128) z komendą z jsonl obok. Zawijanie musi
   * łamać w tych samych miejscach co CLI — porównanie bez spacji na brzegach, bo spacja po pełnym
   * wierszu zajmuje kolumnę nowego wiersza, ale ekran jej nie pokazuje.
   */
  it.each([
    ['dialog-bash-stechly-read-2.1.295.txt', 'dialog-bash-stechly-read-2.1.295.command.json'],
    ['dialog-bash-uciety-naglowek-2.1.294.txt', 'dialog-bash-uciety-naglowek-2.1.294.command.json'],
    ['measured/zgoda-bash-wysoka-2.1.295.txt', 'zgoda-bash-wysoka-2.1.295.command.json'],
    ['dialog-bash-stechly-read-szeroki-2.1.295.txt', 'dialog-bash-stechly-read-szeroki-2.1.295.command.json'],
    [`${MEASURED}.txt`, `${MEASURED}.command.json`],
    [`${PHONE}.txt`, `${PHONE}.command.json`],
  ])('%s', (screenName, commandName) => {
    const { lines, lower, upper } = screenOf(screenName);
    const frame = lines.slice(upper + 1, lower).map((line) => line.replace(/^ │ /u, '').trim());
    const columns = screenWidth((lines[lower] ?? '').trim()) - 4;
    const rows = guard.wrapText(fixtureCommand(commandName).command, columns, 'cli').map((row) => row.trim());
    expect(rows.length).toBeGreaterThanOrEqual(frame.length);
    expect(rows.slice(rows.length - frame.length)).toEqual(frame);
    if (upper !== -1) expect(rows).toHaveLength(frame.length);
    // Szacunek (tryb `upper`) nigdy nie daje mniej wierszy niż układ CLI.
    expect(guard.wrappedRows(fixtureCommand(commandName).command, columns)).toBeGreaterThanOrEqual(rows.length);
  });
});

describe('szacunek wierszy: przypadki brzegowe', () => {
  it('kontrprzykład: 40 nazw po 30 znaków to 40 wierszy, nie „znaki / szerokość”', () => {
    const naive = Math.ceil(RM_40.length / guard.FRAME_COLUMNS);
    const { commandRows, rows } = guard.estimateDialogRows(RM_40, 'Remove results');
    expect(naive).toBe(22);
    // `rm -r -- ` + nazwa (39 kolumn) w pierwszym wierszu, potem nazwa na wiersz: dwie nie mieszczą się w 58.
    expect(commandRows).toBe(40);
    expect(rows).toBe(FIXED() + 40);
    expect(guard.tallDialogVerdict({ command: RM_40, description: 'Remove results' })?.reason).toBe('rows');
  });

  it('granica budżetu ±1: dialog równy budżetowi przechodzi, o wiersz wyższy — odmowa', () => {
    const lines = (n: number): string => Array.from({ length: n }, (_, i) => `echo krok-${String(i)}`).join('\n');
    const fits = guard.COMMAND_ROWS_HINT;
    expect(guard.estimateDialogRows(lines(fits), 'Run steps').rows).toBe(guard.BUDGET_ROWS);
    expect(guard.tallDialogVerdict({ command: lines(fits), description: 'Run steps' })).toBeNull();
    const verdict = guard.tallDialogVerdict({ command: lines(fits + 1), description: 'Run steps' });
    expect(verdict?.reason).toBe('rows');
    expect(verdict?.rows).toBe(guard.BUDGET_ROWS + 1);
    expect(verdict?.budget).toBe(guard.BUDGET_ROWS);
  });

  it('słowo dłuższe od ramki tnie się twardo i zaczyna w bieżącym wierszu, gdy to nie kosztuje cięcia', () => {
    const w = guard.FRAME_COLUMNS;
    expect(guard.wrappedRows('x'.repeat(w), w)).toBe(1);
    expect(guard.wrappedRows('x'.repeat(w + 1), w)).toBe(2);
    expect(guard.wrappedRows('x'.repeat(2 * w), w)).toBe(2);
    expect(guard.wrappedRows('x'.repeat(2 * w + 1), w)).toBe(3);
    // Mieści się na pełnej szerokości → nowy wiersz zamiast cięcia (oba tryby).
    expect(guard.wrapText(`a ${'x'.repeat(w)}`, w, 'cli')).toEqual(['a ', 'x'.repeat(w)]);
    expect(guard.wrapText(`a ${'x'.repeat(w)}`, w)).toEqual(['a ', 'x'.repeat(w)]);
    // Za długie i tak tnie raz → CLI zaczyna w bieżącym wierszu (jak `-only-testing:…` w zrzucie
    // z 10:02), szacunek zawsze od nowego — o wiersz więcej, nigdy mniej.
    expect(guard.wrapText(`a ${'x'.repeat(w + 1)}`, w, 'cli')).toEqual([`a ${'x'.repeat(w - 2)}`, 'xxx']);
    expect(guard.wrapText(`a ${'x'.repeat(w + 1)}`, w)).toEqual(['a ', 'x'.repeat(w), 'x']);
    // Start w bieżącym wierszu kosztowałby DRUGIE cięcie → nowy wiersz także w trybie `cli`.
    expect(guard.wrappedRows(`a ${'x'.repeat(2 * w - 1)}`, w, 'cli')).toBe(3);
    expect(guard.wrappedRows(`a ${'x'.repeat(2 * w - 1)}`, w)).toBe(3);
    // Znaki szerokie: 29 × 2 = 58 kolumn mieści się, 30 × 2 = 60 już nie.
    expect(guard.wrappedRows('界'.repeat(29), w)).toBe(1);
    expect(guard.wrappedRows('界'.repeat(30), w)).toBe(2);
    // Tabulator liczony w górę: 8 tabulatorów = 64 kolumny.
    expect(guard.wrappedRows('\t'.repeat(8), w)).toBe(2);
  });

  it('puste linie i końce linii: każda linia komendy to co najmniej jeden wiersz', () => {
    expect(guard.wrappedRows('a\n\nb', 58)).toBe(3);
    expect(guard.wrappedRows('a\r\n\r\nb', 58)).toBe(3);
    expect(guard.wrappedRows('', 58)).toBe(1);
    expect(guard.wrappedRows('ls\n', 58), 'końcowy znak nowej linii liczy się w górę').toBe(2);
    // Wcięcie zostaje w wierszu (Python w heredocu), nie znika przy zawijaniu.
    expect(guard.wrapText('    if ok:', 58)).toEqual(['    if ok:']);
  });

  it('długi opis wypycha tytuł poza zasięg parsera: odmowa `header`, choć dialog się mieści', () => {
    const words = (n: number): string => Array.from({ length: n }, () => 'abcdefghi').join(' ');
    // 5 słów po 9 znaków + spacje = 49 kolumn na wiersz opisu; szóste już się nie mieści (59 > 58).
    const desc = (rows: number): string => words(5 * rows);
    expect(guard.wrappedRows(desc(guard.MAX_DESCRIPTION_ROWS), guard.DESCRIPTION_COLUMNS))
      .toBe(guard.MAX_DESCRIPTION_ROWS);
    expect(guard.tallDialogVerdict({ command: 'ls', description: desc(guard.MAX_DESCRIPTION_ROWS) })).toBeNull();
    const verdict = guard.tallDialogVerdict({ command: 'ls', description: desc(guard.MAX_DESCRIPTION_ROWS + 1) });
    expect(verdict?.reason).toBe('header');
    expect(verdict?.rows).toBeLessThanOrEqual(guard.BUDGET_ROWS);
    expect(verdict?.descriptionRows).toBe(guard.MAX_DESCRIPTION_ROWS + 1);
    expect(verdict?.message).toContain('Shorten the description to one sentence');
  });

  it('wejście bez kształtu zgody `Bash` = brak werdyktu (hook zachowuje się jak przed strażnikiem)', () => {
    for (const input of [null, 'ls', 42, {}, { command: 42 }, { command: RM_40, description: 42 }]) {
      expect(guard.tallDialogVerdict(input), JSON.stringify(input)).toBeNull();
    }
    expect(guard.estimateDialogRows('ls').descriptionRows, 'bez opisu: zero wierszy opisu').toBe(0);
  });

  it('komunikat odmowy: nie blokada, liczby N i M, wywołania PO KOLEI, Edit/Write', () => {
    const verdict = guard.tallDialogVerdict({ command: RM_40, description: 'Remove results' });
    const message = verdict?.message ?? '';
    expect(message).toContain('This is NOT a block on this operation. The Rarog hook rejected only the FORM: ');
    expect(message).toContain(`~${String(FIXED() + 40)} rows`);
    expect(message).toContain(`holds ${String(guard.BUDGET_ROWS)}`);
    expect(message).toContain('ONE AFTER ANOTHER');
    expect(message).toContain('do not send them in parallel');
    expect(message).toContain('Edit/Write');
    expect(message).toContain(`~${String(guard.COMMAND_ROWS_HINT)} lines`);
    expect(message).toContain('is not circumventing a block');
  });

  it('fixture telefonu: szacunek komendy w kształcie incydentu przekracza budżet', () => {
    const { command, description } = fixtureCommand(`${PHONE}.command.json`);
    const estimate = guard.estimateDialogRows(command, description);
    expect(guard.wrappedRows(command, guard.FRAME_COLUMNS, 'cli')).toBe(43);
    expect(estimate.commandRows).toBe(GUARD_TALL_ROWS);
    expect(estimate.rows).toBe(FIXED() + GUARD_TALL_ROWS);
    expect(estimate.rows).toBeGreaterThan(guard.BUDGET_ROWS);
  });
});

describe('szacunek wierszy: górne ograniczenie', () => {
  /*
   * Tryb `cli` nie jest monotoniczny: słowo o szerokości dokładnie ramki po pełnym wierszu zajmuje dwa
   * wiersze (spacja dostaje własny), a o kolumnę dłuższe — jeden. Szacunek, który zawyża szerokość
   * znaku, mógłby więc ZANIŻYĆ wynik. Dlatego znaki łączące liczą się jako zero, a słowo dłuższe od
   * ramki zawsze startuje od nowego wiersza (tryb `upper`, monotoniczny; testy własności niżej).
   */
  const w = 58;
  const laczace = `rm -r -- ${Array(18).fill(`x\u0301${'x'.repeat(57)}`).join(' ')}`;

  it('słowa po 58 kolumn ze znakiem łączącym — 36 wierszy w trybie `cli` i odmowa', () => {
    expect(guard.displayWidth(`x\u0301${'x'.repeat(57)}`)).toBe(58);
    // Po każdym pełnym wierszu spacja dostaje własny wiersz: 1 + 2 × 18 − 1 = 36.
    expect(guard.wrappedRows(laczace, w, 'cli')).toBe(36);
    expect(guard.wrappedRows(laczace, w)).toBe(36);
    const verdict = guard.tallDialogVerdict({ command: laczace });
    expect(verdict?.reason).toBe('rows');
    expect(verdict?.rows).toBe(guard.FRAME_ROWS + guard.FRAME_RESERVE_ROWS + 36);
  });

  it('szerokość znaku: łączące, ZWJ i selektory zero; emoji i CJK dwa; prezentacja emoji w górę', () => {
    expect(guard.codePointWidth('\u0301'), 'znak łączący (Mn)').toBe(0);
    expect(guard.codePointWidth('\u20DD'), 'znak otaczający (Me)').toBe(0);
    expect(guard.codePointWidth('\u200D'), 'ZWJ (Cf)').toBe(0);
    expect(guard.codePointWidth('\uFE0E'), 'selektor tekstowy').toBe(0);
    expect(guard.codePointWidth('\uFE0F'), 'selektor emoji liczy się w górę').toBe(1);
    expect(guard.displayWidth('\u2764\uFE0F'), '„❤️” (prezentacja emoji)').toBeGreaterThanOrEqual(2);
    expect(guard.displayWidth('1\uFE0F\u20E3'), 'klawisz „1️⃣”').toBeGreaterThanOrEqual(2);
    expect(guard.displayWidth('界'), 'CJK').toBe(2);
    expect(guard.displayWidth('🚀')).toBe(2);
    expect(guard.displayWidth('zażółć'), 'polskie litery wąskie').toBe(6);
    expect(guard.displayWidth('\t')).toBe(8);
  });

  it('słowo dokładnie 58 kolumn ze znakami łączącymi mieści się w wierszu; 59 już nie', () => {
    const word = `${'e\u0301'.repeat(29)}${'x'.repeat(29)}`;
    expect(guard.displayWidth(word)).toBe(w);
    expect(guard.wrappedRows(word, w)).toBe(1);
    expect(guard.wrappedRows(`${word}x`, w)).toBe(2);
    // Po pełnym wierszu: spacja dostaje własny wiersz, słowo następny — w obu trybach.
    expect(guard.wrappedRows(`${'y'.repeat(w)} ${word}`, w, 'cli')).toBe(3);
    expect(guard.wrappedRows(`${'y'.repeat(w)} ${word}`, w)).toBe(3);
  });

  it('emoji i CJK na granicy ramki: znak szeroki, który się nie mieści, idzie do nowego wiersza', () => {
    expect(guard.wrapText(`${'x'.repeat(57)}界`, w)).toEqual(['x'.repeat(57), '界']);
    expect(guard.wrapText(`${'x'.repeat(56)}🚀`, w)).toEqual([`${'x'.repeat(56)}🚀`]);
    expect(guard.wrappedRows(`a ${'界'.repeat(29)}`, w), '58 kolumn po słowie „a”: nowy wiersz').toBe(2);
  });

  it('tabulator liczy się jako 8 kolumn — szacunek tylko rośnie', () => {
    const line = `${'x'.repeat(50)}\tx`;
    expect(guard.wrappedRows(line, w, 'cli')).toBe(2);
    expect(guard.wrappedRows(line.replace('\t', ''), w)).toBe(1);
  });

  const alphabet = fc.constantFrom('x', 'x', 'x', 'ą', 'x\u0301', '界', '🚀', '\u2764\uFE0F', '1\uFE0F\u20E3', '\t');
  const word = fc.array(alphabet, { minLength: 1, maxLength: 80 }).map((chars) => chars.join(''));
  const text = fc.array(word, { minLength: 1, maxLength: 12 });

  it('własność: szacunek (`upper`) nigdy nie daje mniej wierszy niż tryb `cli`', () => {
    fc.assert(fc.property(text, fc.integer({ min: 8, max: 70 }), fc.boolean(), (words, columns, double) => {
      const joined = words.join(double ? '  ' : ' ');
      expect(guard.wrappedRows(joined, columns)).toBeGreaterThanOrEqual(guard.wrappedRows(joined, columns, 'cli'));
    }), { numRuns: 2000 });
  });

  it('własność: szacunek jest monotoniczny — dłuższe słowo nigdy nie zmniejsza liczby wierszy', () => {
    fc.assert(fc.property(text, fc.nat(), alphabet, fc.integer({ min: 8, max: 70 }), (words, at, extra, columns) => {
      const index = at % words.length;
      const longer = words.map((one, i) => (i === index ? one + extra : one));
      expect(guard.wrappedRows(longer.join(' '), columns)).toBeGreaterThanOrEqual(guard.wrappedRows(words.join(' '), columns));
    }), { numRuns: 2000 });
  });
});

/** Odpala hook (albo jego kopię) z podanym stdin; zwraca kod wyjścia i strumienie. */
function runHook(
  stdin: string, env: Record<string, string>, script: string = HOOK,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, '--answer-wait=1'], {
      // Czyste środowisko: test nie może zależeć od tego, czy sam biegnie w panelu herdr.
      env: { PATH: process.env['PATH'] ?? '', HOME: dataDir, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => { resolve({ code, stdout, stderr }); });
    child.stdin.end(stdin);
  });
}

let dataDir: string;
let project: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'rarog-straznik-'));
  project = join(dataDir, 'roots', 'Projects', 'demo');
  mkdirSync(project, { recursive: true });
  writeHookRoots(dataDir, [join(dataDir, 'roots', 'Projects')], { tallDialogGuard: true });
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

const HERDR = { HERDR_ENV: '1' };
const env = (over: Record<string, string> = HERDR): Record<string, string> => ({
  RAROG_DATA_DIR: dataDir, ...over,
});

const TALL = fixtureCommand(`${PHONE}.command.json`);

/** Payload `PermissionRequest` subagenta — kształt z pomiaru na CLI 2.1.302. */
const subagentRequest = (over: Record<string, unknown> = {}): string => JSON.stringify({
  session_id: SESSION,
  transcript_path: `/Users/x/.claude/projects/-demo/${SESSION}.jsonl`,
  cwd: project,
  prompt_id: '99926dae-f611-484e-b34d-ca9352af0c01',
  permission_mode: 'auto',
  agent_id: 'a0caa98eefec36726',
  agent_type: 'general-purpose',
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: { command: TALL.command, description: TALL.description },
  ...over,
});

const pendingFile = (): string => join(dataDir, 'pending', `${SESSION}.json`);
const guardLines = (): Record<string, unknown>[] => readFileSync(join(dataDir, HOOK_GUARD_LOG_FILENAME), 'utf8')
  .trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);

/** „Jak dziś”: stdout pusty, zrzut w `pending/`, dziennika strażnika brak. */
async function expectToday(result: { code: number | null; stdout: string }, toolName = 'Bash'): Promise<void> {
  expect(result.code).toBe(0);
  expect(result.stdout, 'stdout pusty — bez decyzji').toBe('');
  expect(readPendingHook(dataDir, SESSION, () => Date.now())?.toolName).toBe(toolName);
  expect(existsSync(join(dataDir, HOOK_GUARD_LOG_FILENAME))).toBe(false);
}

describe('hook rarog-pending.mjs ze strażnikiem (proces)', () => {
  it('wysoka komenda subagenta: `deny` z komunikatem, bez zrzutu, `hook-seen` odświeżony, linia w dzienniku', async () => {
    const before = Date.now();
    const result = await runHook(subagentRequest(), env());

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const output = JSON.parse(result.stdout) as {
      hookSpecificOutput: { hookEventName: string; decision: { behavior: string; message: string; interrupt?: boolean } };
    };
    expect(output.hookSpecificOutput.hookEventName).toBe('PermissionRequest');
    expect(output.hookSpecificOutput.decision.behavior).toBe('deny');
    // Kształt z pomiaru na CLI 2.1.302: bez `interrupt` (domyślnie tura jedzie dalej).
    expect(output.hookSpecificOutput.decision.interrupt).toBeUndefined();
    expect(output.hookSpecificOutput.decision.message).toContain('This is NOT a block on this operation');
    expect(output.hookSpecificOutput.decision.message).toContain('~60 rows');
    expect(output.hookSpecificOutput.decision.message).toContain('holds 44');

    expect(existsSync(pendingFile()), 'dialogu nie będzie, więc zrzutu też nie').toBe(false);
    const seen = JSON.parse(readFileSync(join(dataDir, HOOK_SEEN_FILENAME), 'utf8')) as {
      at: number; event: string; toolName: string;
    };
    expect(seen.at).toBeGreaterThanOrEqual(before);
    expect(seen.event).toBe('PermissionRequest');
    expect(seen.toolName).toBe('Bash');

    const [line, ...rest] = guardLines();
    expect(rest).toEqual([]);
    expect(line).toEqual({
      at: expect.any(Number) as number, sessionId: SESSION, subagent: true, reason: 'rows', rows: 60,
      // Bez `COLUMNS`/`LINES` w środowisku: budżet telefonu, bez pól panelu.
      budget: 44, descriptionRows: 1, budgetSource: 'phone', permissionMode: 'auto',
    });
    const raw = readFileSync(join(dataDir, HOOK_GUARD_LOG_FILENAME), 'utf8');
    expect(raw, 'dziennik bez treści komendy').not.toContain('xcodebuild');
    expect(raw, 'dziennik bez opisu').not.toContain(TALL.description ?? '?');
    expect(statSync(join(dataDir, HOOK_GUARD_LOG_FILENAME)).mode & 0o777).toBe(0o600);
  });

  it('krótka komenda: jak dziś (zrzut, stdout pusty, bez dziennika)', async () => {
    await expectToday(await runHook(subagentRequest({
      tool_input: { command: 'ls -la', description: 'List files' },
    }), env()));
  });

  it('wariant B: zgoda wątku głównego (bez `agent_id`) też dostaje odmowę formy', async () => {
    const result = await runHook(subagentRequest({ agent_id: undefined, agent_type: undefined }), env());
    expect(JSON.parse(result.stdout)).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } });
    expect(guardLines()[0]?.['subagent']).toBe(false);
  });

  it('poza sesją herdr (`HERDR_ENV` brak albo inny niż `1`): jak dziś', async () => {
    await expectToday(await runHook(subagentRequest(), env({})));
    rmSync(pendingFile());
    await expectToday(await runHook(subagentRequest(), env({ HERDR_ENV: '0' })));
  });

  it('brak pola `tallDialogGuard` w `roots.json` (flaga `0`, stary serwer) albo pole nie-`true`: jak dziś', async () => {
    writeHookRoots(dataDir, [join(dataDir, 'roots', 'Projects')]);
    await expectToday(await runHook(subagentRequest(), env()));
    rmSync(pendingFile());
    writeFileSync(join(dataDir, HOOK_ROOTS_FILENAME), JSON.stringify({
      roots: [join(dataDir, 'roots', 'Projects')], tallDialogGuard: 'true',
    }));
    await expectToday(await runHook(subagentRequest(), env()));
  });

  it('inne narzędzie z wysokim wejściem (`Write`, `ExitPlanMode`): jak dziś', async () => {
    await expectToday(await runHook(subagentRequest({
      tool_name: 'Write', tool_input: { file_path: join(project, 'a.txt'), content: RM_40.replaceAll(' ', '\n') },
    }), env()), 'Write');
    await expectToday(await runHook(subagentRequest({
      tool_name: 'ExitPlanMode', tool_input: { plan: RM_40.replaceAll(' ', '\n') },
    }), env()), 'ExitPlanMode');
  });

  it('`cwd` poza korzeniami Raroga: ani odmowy, ani śladu', async () => {
    const outside = join(dataDir, 'obce', 'klient');
    mkdirSync(outside, { recursive: true });
    const result = await runHook(subagentRequest({ cwd: outside }), env());
    expect(result.stdout).toBe('');
    expect(existsSync(pendingFile())).toBe(false);
    expect(existsSync(join(dataDir, HOOK_GUARD_LOG_FILENAME))).toBe(false);
  });

  it('istniejący zrzut stojącego `AskUserQuestion` zostaje nietknięty', async () => {
    mkdirSync(join(dataDir, 'pending'), { recursive: true });
    const question = `${JSON.stringify({
      sessionId: SESSION, toolName: 'AskUserQuestion', toolInput: { questions: [] }, at: Date.now(),
      hookEventName: 'PermissionRequest', answerKey: 'p-aaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb',
    })}\n`;
    writeFileSync(pendingFile(), question);
    const result = await runHook(subagentRequest(), env());
    expect(JSON.parse(result.stdout)).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } });
    expect(readFileSync(pendingFile(), 'utf8')).toBe(question);
  });

  it('błędny typ `command` albo `description`: jak dziś', async () => {
    await expectToday(await runHook(subagentRequest({ tool_input: { command: 42 } }), env()));
    rmSync(pendingFile());
    await expectToday(await runHook(subagentRequest({
      tool_input: { command: TALL.command, description: 42 },
    }), env()));
  });

  it('brak modułu, moduł rzucający przy imporcie albo przy szacunku: jak dziś', async () => {
    const variants: [string, string | null][] = [
      ['brak', null],
      ['import', "throw new Error('zepsuty moduł');\n"],
      ['szacunek', "export function tallDialogVerdict() { throw new Error('zepsuty szacunek'); }\n"],
      ['kształt', 'export function tallDialogVerdict() { return { reason: "rows" }; }\n'],
    ];
    for (const [name, body] of variants) {
      const copy = mkdtempSync(join(dataDir, `kopia-${name}-`));
      copyFileSync(HOOK, join(copy, 'rarog-pending.mjs'));
      copyFileSync(join(REPO, 'scripts', 'hooks', 'work-area.mjs'), join(copy, 'work-area.mjs'));
      if (body !== null) writeFileSync(join(copy, 'tall-dialog.mjs'), body);
      const result = await runHook(subagentRequest(), env(), join(copy, 'rarog-pending.mjs'));
      expect(result.stdout, name).toBe('');
      expect(result.code, name).toBe(0);
      expect(readPendingHook(dataDir, SESSION, () => Date.now())?.toolName, name).toBe('Bash');
      rmSync(pendingFile());
    }
    expect(existsSync(join(dataDir, HOOK_GUARD_LOG_FILENAME))).toBe(false);
  });

  it('równoległe hooki tylko dopisują: każda odmowa ma swoją linię, nikt nie rotuje', async () => {
    const file = join(dataDir, HOOK_GUARD_LOG_FILENAME);
    const big = `${JSON.stringify({ at: 1, rows: 1 })}\n${'#'.repeat(HOOK_GUARD_LOG_MAX_BYTES)}\n`;
    writeFileSync(file, big);
    const runs = Array.from({ length: 8 }, (_, i) => runHook(subagentRequest({ session_id: `${SESSION.slice(0, -1)}${String(i)}` }), env()));
    for (const result of await Promise.all(runs)) {
      expect(JSON.parse(result.stdout)).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } });
    }
    expect(existsSync(`${file}.1`), 'rotacja należy do serwera, nie do hooka').toBe(false);
    const lines = readFileSync(file, 'utf8').slice(big.length).trim().split('\n');
    expect(lines).toHaveLength(8);
    const sessions = lines.map((line) => (JSON.parse(line) as { sessionId: string }).sessionId);
    expect(new Set(sessions).size).toBe(8);
  });
});

describe('serwer: `roots.json` z polem strażnika i suma `guard.jsonl`', () => {
  it('pole `tallDialogGuard` stoi WYŁĄCZNIE przy włączonym strażniku', () => {
    const roots = [join(dataDir, 'roots', 'Projects')];
    const read = (): Record<string, unknown> => JSON.parse(
      readFileSync(join(dataDir, HOOK_ROOTS_FILENAME), 'utf8'),
    ) as Record<string, unknown>;
    writeHookRoots(dataDir, roots, { tallDialogGuard: true });
    expect(read()).toEqual({ roots, tallDialogGuard: true });
    writeHookRoots(dataDir, roots, { tallDialogGuard: false });
    expect(read()).toEqual({ roots });
    writeHookRoots(dataDir, roots);
    expect(read()).toEqual({ roots });
    expect(readHookRoots(dataDir)).toEqual(roots);
  });

  it('HOOK odmawia na podstawie pliku, który zapisał SERWER (obie strony pola razem)', async () => {
    const result = await runHook(subagentRequest(), env());
    expect(JSON.parse(result.stdout)).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } });
    expect(existsSync(join(dataDir, HOOK_GUARD_LOG_FILENAME)), 'nazwa dziennika ze stałej serwera').toBe(true);
  });

  it('`rotateGuardLog` (start serwera): ponad próg plik przechodzi do `.1`, poniżej i bez pliku — nic', () => {
    const file = join(dataDir, HOOK_GUARD_LOG_FILENAME);
    expect(rotateGuardLog(dataDir), 'brak pliku').toBe(false);
    writeFileSync(file, 'a\n');
    expect(rotateGuardLog(dataDir, 10)).toBe(false);
    expect(existsSync(`${file}.1`)).toBe(false);
    writeFileSync(`${file}.1`, 'stara generacja\n');
    writeFileSync(file, `${'x'.repeat(11)}\n`);
    expect(rotateGuardLog(dataDir, 10)).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(`${file}.1`, 'utf8')).toBe(`${'x'.repeat(11)}\n`);
    expect(HOOK_GUARD_LOG_MAX_BYTES).toBe(1024 * 1024);
  });

  it('`summarizeGuard` liczy okno, subagentów, powody i najwyższy szacunek; śmieci osobno', () => {
    const since = 1_000;
    const lines = [
      JSON.stringify({ at: 500, subagent: true, reason: 'rows', rows: 99 }),
      JSON.stringify({ at: 1_000, subagent: true, reason: 'rows', rows: 58 }),
      JSON.stringify({ at: 2_000, subagent: false, reason: 'header', rows: 30 }),
      JSON.stringify({ at: 3_000, subagent: true, reason: 'rows', rows: 61 }),
      '{ urwana linia',
      JSON.stringify({ rows: 1 }),
      '',
    ];
    // Linie w starszym formacie logu nie mają źródła budżetu: `missing`, bez wierszy panelu.
    expect(summarizeGuard(lines, since)).toEqual({
      total: 3, subagent: 2, byReason: { rows: 2, header: 1 }, maxRows: 61, byBudgetSource: { missing: 3 },
      minPaneRows: null, skipped: 2,
    });
    expect(summarizeGuard([], since)).toEqual({
      total: 0, subagent: 0, byReason: {}, maxRows: null, byBudgetSource: {}, minPaneRows: null, skipped: 0,
    });
  });
});
