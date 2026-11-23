/**
 * Strażnik wysokości dialogu liczy na geometrii PANELU.
 *
 * Incydent: zgoda `Bash` subagenta, szacunek 37 wierszy przy budżecie telefonu 44,
 * a panel miał pty 62×29 — nagłówek nad krawędzią, karta bez przycisków. Pomiar (CLI 2.1.309,
 * prawdziwy hook z `--settings`): środowisko hooka ma `COLUMNS`/`LINES` równe BIEŻĄCEMU pty panelu.
 * Reguła: zawijanie na `min(62, kolumny)`, budżet `min(44, wiersze − 4)`; brak albo śmieci w zmiennych =
 * telefon (`phone`); panel poniżej progu = telefon (`floor`).
 *
 * Trzy części: (1) reguła budżetu w czystym module (`scripts/hooks/tall-dialog.mjs`) z własnościami
 * monotoniczności; (2) hook jako PROCES z `COLUMNS`/`LINES` w `env` (wzór z testu
 * strażnika): dziennik odmowy i zrzut przepuszczonej prośby z geometrią, zgodność formatu z czytnikiem
 * serwera; (3) suma `guard.jsonl` z rozkładem źródła budżetu.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { spawn } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { displayWidth as screenWidth } from '../src/herdr/dialogs/screen/operation.ts';
import {
  HOOK_BUDGET_SOURCES, HOOK_GUARD_LOG_FILENAME, summarizeGuard, writeHookRoots,
} from '../src/herdr/hook-config.ts';
import { readPendingHook } from '../src/herdr/dialogs/hook/dump.ts';

const REPO = join(import.meta.dirname, '..', '..');
const HOOK = join(REPO, 'scripts', 'hooks', 'rarog-pending.mjs');
const MODULE = join(REPO, 'scripts', 'hooks', 'tall-dialog.mjs');
const FIXTURES = join(import.meta.dirname, 'fixtures', 'herdr');
const SESSION = '550e8400-e29b-41d4-a716-446655440000';

type Source = 'pane' | 'phone' | 'floor';

interface Budget {
  readonly source: Source;
  readonly budget: number;
  readonly frameColumns: number;
  readonly commandRowsHint: number;
  readonly paneRows?: number;
  readonly paneCols?: number;
}

interface Verdict {
  readonly reason: 'rows' | 'header';
  readonly rows: number;
  readonly budget: number;
  readonly budgetSource: Source;
  readonly paneRows?: number;
  readonly paneCols?: number;
  readonly frameColumns: number;
  readonly descriptionRows: number;
  readonly message: string;
}

interface Pane { readonly columns: number; readonly rows: number }

/** Kształt modułu `.mjs` — import dynamiczny, bo moduł jest poza projektem TS serwera. */
interface TallDialog {
  readonly PHONE_COLUMNS: number;
  readonly PHONE_ROWS: number;
  readonly FRAME_COLUMNS: number;
  readonly FRAME_ROWS: number;
  readonly FRAME_RESERVE_ROWS: number;
  readonly BUDGET_ROWS: number;
  readonly COMMAND_ROWS_HINT: number;
  readonly PANE_ROWS_MARGIN: number;
  readonly MIN_BUDGET_ROWS: number;
  readonly MIN_PANE_COLUMNS: number;
  readonly PANE_MAX: number;
  readonly BUDGET_SOURCES: readonly string[];
  wrapText(text: string, columns: number, mode?: 'upper' | 'cli'): string[];
  wrappedRows(text: string, columns: number, mode?: 'upper' | 'cli'): number;
  estimateDialogRows(command: string, description?: string, frameColumns?: number): {
    rows: number; commandRows: number; descriptionRows: number;
  };
  paneFromEnv(columns: unknown, lines: unknown): Pane | null;
  dialogBudget(pane: Pane | null | undefined): Budget;
  tallDialogVerdict(toolInput: unknown, pane?: Pane | null): Verdict | null;
}

const guard = (await import(pathToFileURL(MODULE).href)) as TallDialog;

/** Failure message of a guard check: what broke, why the rule exists, what to do. */
const explain = (broken: string, why: string, fix: string): string => `${broken}\nWhy: ${why}\nFix: ${fix}`;
const WHY_PANE = 'a permission dialog taller than the pane where the session runs pushes its header off screen, '
  + 'and the phone card then has no buttons; the budget is never larger than what the pane or the phone holds.';
const FIX_RULE = 'change the rule in `scripts/hooks/tall-dialog.mjs` only together with the table and docs/dialogs.md; '
  + 'otherwise restore the rule: wrap at `min(62, columns)`, budget `min(44, rows - 4)`, phone below the floor.';

const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');
const fixtureCommand = (name: string): { command: string; description?: string } => (
  JSON.parse(fixture(name)) as { command: string; description?: string });

/** Incydent: dokładne `tool_input` i ekran panelu 62×29. */
const INCIDENT = 'dialog-bash-subagent-uciety-62x29-2.1.309';
const CUT = fixtureCommand(`${INCIDENT}.command.json`);
/** Komenda z fixture'u telefonu: ~60 wierszy, za wysoka także na telefonie. */
const TALL = fixtureCommand('dialog-bash-subagent-telefon-2.1.302.command.json');

describe('reguła budżetu: panel nigdy nie luzuje strażnika wobec telefonu', () => {
  it('zapas i próg wynikają ze stałych telefonu: 4 wiersze zapasu, próg 18 = obudowa, zapas, opis, 1 linia', () => {
    const derived = explain(
      'The pane margin or the floor no longer derives from the phone constants.',
      'the pane margin is the same reserve the phone keeps (phone rows minus budget), and the floor is the smallest '
        + 'dialog: frame, reserve, one description row and one command row.',
      'derive the constants from `PHONE_ROWS`, `BUDGET_ROWS` and `FRAME_*` in `tall-dialog.mjs`, not by hand.',
    );
    expect(guard.PANE_ROWS_MARGIN, derived).toBe(guard.PHONE_ROWS - guard.BUDGET_ROWS);
    expect(guard.PANE_ROWS_MARGIN, derived).toBe(4);
    expect(guard.MIN_BUDGET_ROWS, derived).toBe(guard.FRAME_ROWS + guard.FRAME_RESERVE_ROWS + 1 + 1);
    expect(guard.MIN_BUDGET_ROWS, derived).toBe(18);
    // Źródła budżetu: ta sama zamknięta lista w hooku i w serwerze (czytnik zrzutu, dziennik).
    expect([...guard.BUDGET_SOURCES], explain(
      'Budget sources differ between the hook (`BUDGET_SOURCES`) and the server (`HOOK_BUDGET_SOURCES`).',
      'the server reads `budgetSource` from the hook dump and the guard log; a value it does not know is lost there.',
      'add or remove the source in both lists in one commit.',
    )).toEqual([...HOOK_BUDGET_SOURCES]);
  });

  it.each([
    // [kolumny, wiersze, źródło, budżet, ramka, linie komendy w podpowiedzi]
    [62, 29, 'pane', 25, 58, 8],
    [62, 48, 'pane', 44, 58, 27],
    [128, 52, 'pane', 44, 58, 27],
    [40, 32, 'pane', 28, 36, 11],
    [40, 52, 'pane', 44, 36, 27],
    [62, 22, 'pane', 18, 58, 1],
    [62, 21, 'floor', 44, 58, 27],
    [19, 48, 'floor', 44, 58, 27],
    [20, 48, 'pane', 44, 16, 27],
  ] as const)('%i×%i → %s, budżet %i, ramka %i, podpowiedź %i linii', (cols, rows, source, budget, frame, hint) => {
    const result = guard.dialogBudget({ columns: cols, rows });
    expect(result, explain(`Budget for a ${String(cols)}×${String(rows)} pane differs from the table.`, WHY_PANE, FIX_RULE))
      .toEqual({ source, budget, frameColumns: frame, commandRowsHint: hint, paneRows: rows, paneCols: cols });
  });

  it('brak geometrii albo geometria w złym kształcie = stałe telefonu (`phone`), bez pól panelu', () => {
    const phone = {
      source: 'phone', budget: guard.BUDGET_ROWS, frameColumns: guard.FRAME_COLUMNS,
      commandRowsHint: guard.COMMAND_ROWS_HINT,
    };
    for (const pane of [
      null, undefined, { columns: 62 }, { columns: 0, rows: 29 }, { columns: 62, rows: 29.5 },
      { columns: 62, rows: guard.PANE_MAX + 1 }, { columns: '62', rows: '29' },
    ]) {
      expect(guard.dialogBudget(pane as Pane | null | undefined), explain(
        `Pane ${String(JSON.stringify(pane))}: no usable geometry, but the budget is not the phone budget.`,
        'without a trusted pane size the guard must fall back to the phone, the strictest screen it knows.',
        'return the phone constants (`source: phone`, no pane fields) for any missing or malformed geometry.',
      )).toEqual(phone);
    }
  });

  it('`COLUMNS`/`LINES`: same cyfry 1..1000, obie naraz — inaczej brak geometrii', () => {
    expect(guard.paneFromEnv('62', '29')).toEqual({ columns: 62, rows: 29 });
    expect(guard.paneFromEnv('1000', '1000')).toEqual({ columns: 1000, rows: 1000 });
    for (const [columns, lines] of [
      [undefined, undefined], ['62', undefined], [undefined, '29'], ['', ''], ['abc', '29'], ['62abc', '29'],
      ['-5', '29'], ['0', '29'], ['062', '29'], ['62.5', '29'], [' 62', '29'], ['62\n', '29'], ['1001', '29'],
      ['99999', '29'], ['1e3', '29'], ['0x3e', '29'], [62, 29],
    ] as const) {
      expect(guard.paneFromEnv(columns, lines), explain(
        `COLUMNS/LINES ${String(columns)}/${String(lines)} parsed as a pane.`,
        'only plain digits 1..1000 in both variables are a pane size; anything else could loosen the budget.',
        'keep `paneFromEnv` strict: both variables, digits only, no leading zero, 1..1000.',
      )).toBeNull();
    }
  });

  it('własność: powyżej progu niższy panel nigdy nie dostaje WIĘKSZEGO budżetu niż wyższy', () => {
    const threshold = guard.MIN_BUDGET_ROWS + guard.PANE_ROWS_MARGIN;
    const rows = fc.integer({ min: threshold, max: guard.PANE_MAX });
    const columns = fc.integer({ min: guard.MIN_PANE_COLUMNS, max: guard.PANE_MAX });
    fc.assert(fc.property(rows, rows, columns, (a, b, cols) => {
      const [low, high] = a <= b ? [a, b] : [b, a];
      const lower = guard.dialogBudget({ columns: cols, rows: low });
      const higher = guard.dialogBudget({ columns: cols, rows: high });
      expect(lower.source).toBe('pane');
      expect(higher.source).toBe('pane');
      expect(lower.budget, explain(
        `A ${String(low)}-row pane gets a larger budget than a ${String(high)}-row pane (${String(cols)} columns).`,
        WHY_PANE,
        FIX_RULE,
      )).toBeLessThanOrEqual(higher.budget);
    }), { numRuns: 2000 });
    // Tuż pod progiem — telefon (`floor`), od progu — panel.
    expect(guard.dialogBudget({ columns: 62, rows: threshold - 1 }).source).toBe('floor');
    expect(guard.dialogBudget({ columns: 62, rows: threshold }).budget).toBe(guard.MIN_BUDGET_ROWS);
  });

  it('własność: budżet i ramka z panelu nigdy nie przekraczają telefonu ani panelu minus zapas', () => {
    const dimension = fc.integer({ min: 1, max: guard.PANE_MAX });
    fc.assert(fc.property(dimension, dimension, (cols, rows) => {
      const result = guard.dialogBudget({ columns: cols, rows });
      const looser = explain(
        `Pane ${String(cols)}×${String(rows)}: budget ${String(result.budget)} or frame ${String(result.frameColumns)} `
          + 'exceeds the phone or the pane minus the margin.',
        WHY_PANE,
        FIX_RULE,
      );
      expect(result.budget, looser).toBeLessThanOrEqual(guard.BUDGET_ROWS);
      expect(result.frameColumns, looser).toBeLessThanOrEqual(guard.FRAME_COLUMNS);
      if (result.source === 'pane') {
        expect(result.budget, looser).toBeLessThanOrEqual(rows - guard.PANE_ROWS_MARGIN);
        expect(result.budget).toBeGreaterThanOrEqual(guard.MIN_BUDGET_ROWS);
        expect(result.frameColumns).toBe(Math.min(guard.PHONE_COLUMNS, cols) - 4);
        expect(result.commandRowsHint).toBeGreaterThanOrEqual(1);
      } else {
        expect(result.source).toBe('floor');
      }
    }), { numRuns: 2000 });
  });

  const alphabet = fc.constantFrom('x', 'x', 'x', 'ą', 'x́', '界', '🚀', '❤️', '1️⃣', '\t');
  const word = fc.array(alphabet, { minLength: 1, maxLength: 80 }).map((chars) => chars.join(''));
  const text = fc.array(word, { minLength: 1, maxLength: 12 });

  it('własność: węższa ramka nigdy nie zmniejsza szacunku (zawijanie na `min(62, kolumny)` tylko zaostrza)', () => {
    fc.assert(fc.property(text, fc.integer({ min: 16, max: 57 }), fc.boolean(), (words, columns, double) => {
      const joined = words.join(double ? '  ' : ' ');
      expect(guard.wrappedRows(joined, columns), explain(
        `Wrapping at ${String(columns)} columns gives fewer rows than at ${String(columns + 1)}.`,
        'a narrower frame must never lower the estimate, or a narrow pane would let a taller dialog through.',
        'fix `wrapText` in `tall-dialog.mjs` so the row count is monotonic in the width.',
      )).toBeGreaterThanOrEqual(guard.wrappedRows(joined, columns + 1));
    }), { numRuns: 2000 });
  });
});

describe('werdykt na geometrii panelu: incydent 62×29 i jego sąsiedzi', () => {
  it('fixture incydentu: ekran 63×29 (kreska `╌` ma 63 znaki), ramka zawinięta na 59 kolumn, nagłówka nie widać', () => {
    // Nazwa pliku mówi 62×29 (plan), ale kreska ma 63 znaki, a ramka łamie się na 59 kolumnach, nie na 58:
    // panel incydentu miał 63 kolumny. Strażnik i tak liczy na `min(62, kolumny)`, więc wynik ten sam.
    const lines = fixture(`${INCIDENT}.txt`).replace(/\n+$/u, '').split('\n');
    expect(lines.length).toBeLessThanOrEqual(29);
    const lower = lines.findIndex((line) => /^╌+$/u.test(line.trim()));
    expect(screenWidth((lines[lower] ?? '').trim()), 'kreska `╌` = szerokość panelu').toBe(63);
    expect(lines.some((line) => line.includes('Bash command')), 'nagłówek nad krawędzią').toBe(false);
    const frame = lines.slice(0, lower).map((line) => line.replace(/^ │ /u, '').trim());
    const rows = guard.wrapText(CUT.command, 63 - 4, 'cli').map((row) => row.trim());
    expect(rows.slice(rows.length - frame.length)).toEqual(frame);
    // Szacunek na ramce strażnika (58) nie jest niższy niż układ zrzutu na prawdziwej ramce (59).
    expect(guard.wrappedRows(CUT.command, 58)).toBeGreaterThanOrEqual(rows.length);
  });

  it('63×29 (ekran incydentu): ramka strażnika 58, szacunek 37 > budżet 25 → odmowa', () => {
    expect(guard.tallDialogVerdict(CUT, { columns: 63, rows: 29 })).toMatchObject({
      reason: 'rows', rows: 37, budget: 25, budgetSource: 'pane', paneRows: 29, paneCols: 63, frameColumns: 58,
    });
  });

  it('62×29: szacunek 37 > budżet 25 → odmowa formy z liczbami panelu w komunikacie', () => {
    const verdict = guard.tallDialogVerdict(CUT, { columns: 62, rows: 29 });
    expect(verdict, explain(
      'The recorded 62×29 dialog (header off screen, card without buttons) is no longer denied.',
      WHY_PANE,
      FIX_RULE,
    )).toMatchObject({
      reason: 'rows', rows: 37, budget: 25, budgetSource: 'pane', paneRows: 29, paneCols: 62, frameColumns: 58,
      descriptionRows: 1,
    });
    const message = verdict?.message ?? '';
    expect(message).toContain('This is NOT a block on this operation');
    expect(message).toContain('~37 rows');
    expect(message).toContain('the terminal pane where this session runs (62×29) holds 25');
    expect(message).toContain('~8 lines of at most ~58 characters');
    expect(message).toContain('ONE AFTER ANOTHER');
    // Ten sam dialog na telefonie (budżet 44) przechodził — to był incydent.
    expect(guard.tallDialogVerdict(CUT)).toBeNull();
  });

  it('128×52: budżet telefonu 44 i ramka 58 — bez odmowy', () => {
    expect(guard.tallDialogVerdict(CUT, { columns: 128, rows: 52 })).toBeNull();
  });

  it('40 kolumn: gęstsze zawijanie podnosi szacunek ponad budżet, choć wierszy jest dość', () => {
    expect(guard.estimateDialogRows(CUT.command, CUT.description, 36).rows).toBe(47);
    const verdict = guard.tallDialogVerdict(CUT, { columns: 40, rows: 52 });
    expect(verdict).toMatchObject({ reason: 'rows', rows: 47, budget: 44, budgetSource: 'pane', frameColumns: 36 });
    expect(verdict?.message).toContain('~27 lines of at most ~36 characters');
    // 40×32: ta sama ramka, budżet z wierszy.
    expect(guard.tallDialogVerdict(CUT, { columns: 40, rows: 32 })).toMatchObject({ rows: 47, budget: 28 });
  });

  it('opis w wąskim panelu: limit nagłówka liczy wiersze opisu na ramce panelu', () => {
    // 5 słów po 9 znaków + spacje = 49 kolumn: na 58 kolumnach 8 wierszy, na 36 — dwa razy tyle.
    const description = Array.from({ length: 40 }, () => 'abcdefghi').join(' ');
    expect(guard.tallDialogVerdict({ command: 'ls', description })).toBeNull();
    const verdict = guard.tallDialogVerdict({ command: 'ls', description }, { columns: 40, rows: 52 });
    expect(verdict?.reason).toBe('header');
    expect(verdict?.message).toContain('in the pane, the description (`description`) takes ~');
  });

  it('pod progiem (`floor`): zachowanie jak dziś — budżet i komunikat telefonu', () => {
    expect(guard.tallDialogVerdict(CUT, { columns: 62, rows: 21 })).toBeNull();
    const verdict = guard.tallDialogVerdict(TALL, { columns: 62, rows: 21 });
    expect(verdict).toMatchObject({ reason: 'rows', rows: 60, budget: 44, budgetSource: 'floor', paneRows: 21 });
    expect(verdict?.message).toContain('the phone screen from which the user approves permissions holds 44');
    expect(verdict?.message).toContain(`~${String(guard.COMMAND_ROWS_HINT)} lines of at most ~58 characters`);
  });

  it('bez geometrii: komunikat telefonu z budżetem 44', () => {
    const verdict = guard.tallDialogVerdict(TALL);
    expect(verdict).toMatchObject({ rows: 60, budget: 44, budgetSource: 'phone' });
    expect(verdict?.paneRows).toBeUndefined();
    expect(verdict?.message).toContain('and the phone screen from which the user approves permissions holds 44. ');
  });
});

/** Odpala hook (albo jego kopię) z podanym stdin; zwraca kod wyjścia i strumienie. */
function runHook(
  stdin: string, env: Record<string, string>, script: string = HOOK,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, '--answer-wait=1'], {
      // Czyste środowisko: test nie może zależeć od tego, czy sam biegnie w panelu herdr (ani od
      // `COLUMNS`/`LINES` terminala, w którym ktoś puścił testy).
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
  dataDir = mkdtempSync(join(tmpdir(), 'rarog-straznik-panelu-'));
  project = join(dataDir, 'roots', 'Projects', 'demo');
  mkdirSync(project, { recursive: true });
  writeHookRoots(dataDir, [join(dataDir, 'roots', 'Projects')], { tallDialogGuard: true });
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

/** Środowisko hooka w panelu herdr; `pane` = `COLUMNS`/`LINES` jak w pomiarze CLI 2.1.309. */
const env = (pane: Record<string, string> = {}): Record<string, string> => ({
  RAROG_DATA_DIR: dataDir, HERDR_ENV: '1', ...pane,
});
const pty = (columns: string, lines: string): Record<string, string> => ({ COLUMNS: columns, LINES: lines });

/** Payload `PermissionRequest` subagenta z komendą incydentu (kształt z pomiaru). */
const request = (over: Record<string, unknown> = {}): string => JSON.stringify({
  session_id: SESSION,
  transcript_path: `/Users/x/.claude/projects/-demo/${SESSION}.jsonl`,
  cwd: project,
  prompt_id: '99926dae-f611-484e-b34d-ca9352af0c01',
  permission_mode: 'auto',
  agent_id: 'a7e5ec6c821818fae',
  agent_type: 'general-purpose',
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: { command: CUT.command, description: CUT.description },
  ...over,
});

const pendingFile = (): string => join(dataDir, 'pending', `${SESSION}.json`);
const rawPending = (): Record<string, unknown> => JSON.parse(readFileSync(pendingFile(), 'utf8')) as Record<string, unknown>;
const guardLines = (): Record<string, unknown>[] => readFileSync(join(dataDir, HOOK_GUARD_LOG_FILENAME), 'utf8')
  .trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
const denied = (stdout: string): { behavior: string; message: string } => (JSON.parse(stdout) as {
  hookSpecificOutput: { decision: { behavior: string; message: string } };
}).hookSpecificOutput.decision;

describe('hook rarog-pending.mjs z geometrią panelu (proces)', () => {
  it('62×29 (incydent): `deny`, linia dziennika z geometrią i `budgetSource: pane`, bez zrzutu', async () => {
    const result = await runHook(request(), env(pty('62', '29')));
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const decision = denied(result.stdout);
    expect(decision.behavior, explain(
      'The hook process lets the recorded 62×29 dialog through with `COLUMNS=62 LINES=29`.',
      `the hook reads the pane size from \`COLUMNS\`/\`LINES\`; ${WHY_PANE}`,
      'check that `tallDialogGuard` in `rarog-pending.mjs` passes the raw `COLUMNS`/`LINES` to `paneFromEnv` and the '
        + 'pane to `dialogBudget` and `tallDialogVerdict`.',
    )).toBe('deny');
    expect(decision.message).toContain('(62×29) holds 25');
    expect(decision.message).toContain('~8 lines of at most ~58 characters');
    expect(existsSync(pendingFile())).toBe(false);
    expect(guardLines()).toEqual([{
      at: expect.any(Number) as number, sessionId: SESSION, subagent: true, reason: 'rows', rows: 37, budget: 25,
      descriptionRows: 1, budgetSource: 'pane', paneRows: 29, paneCols: 62, permissionMode: 'auto',
    }]);
  });

  it('128×52: przepuszcza, a zrzut niesie geometrię, którą czyta serwer (zgodność formatu)', async () => {
    const result = await runHook(request(), env(pty('128', '52')));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(existsSync(join(dataDir, HOOK_GUARD_LOG_FILENAME))).toBe(false);
    expect(rawPending()).toMatchObject({ budgetSource: 'pane', paneRows: 52, paneCols: 128 });
    expect(readPendingHook(dataDir, SESSION, () => Date.now()), explain(
      'The server reader drops the guard fields that the hook wrote into the dump.',
      'the hook (`scripts/hooks/`) and the server reader (`dialogs/hook/dump.ts`) share one dump format.',
      'change the field names and shapes in both in one commit.',
    )).toMatchObject({
      toolName: 'Bash', agentId: 'a7e5ec6c821818fae', budgetSource: 'pane', paneRows: 52, paneCols: 128,
    });
  });

  it('40×52: wąski panel — odmowa z szacunku na ramce 36 kolumn, przy budżecie telefonu', async () => {
    const result = await runHook(request(), env(pty('40', '52')));
    expect(denied(result.stdout).message).toContain('~47 rows');
    expect(guardLines()[0]).toMatchObject({ rows: 47, budget: 44, budgetSource: 'pane', paneRows: 52, paneCols: 40 });
  });

  it('brak `COLUMNS`/`LINES` i śmieci w nich: budżet telefonu (`phone`), dialog incydentu przechodzi jak na telefonie', async () => {
    for (const pane of [
      {}, pty('', ''), pty('abc', '29'), pty('62', '0'), pty('62', 'x29'), pty('62.0', '29'), pty('1e3', '29'),
      pty('99999', '29'), { COLUMNS: '62' }, { LINES: '29' },
    ]) {
      const label = JSON.stringify(pane);
      const result = await runHook(request(), env(pane));
      expect(result.stdout, label).toBe('');
      const raw = rawPending();
      expect(raw['budgetSource'], label).toBe('phone');
      expect(raw['paneRows'], label).toBeUndefined();
      expect(raw['paneCols'], label).toBeUndefined();
      rmSync(pendingFile());
    }
    // Komenda za wysoka i na telefonie dostaje dawny komunikat i `budgetSource: phone`.
    const tall = await runHook(request({ tool_input: TALL }), env());
    expect(denied(tall.stdout).message).toContain('the phone screen from which the user approves permissions holds 44');
    expect(guardLines()[0]).toMatchObject({ rows: 60, budget: 44, budgetSource: 'phone' });
    expect(guardLines()[0]?.['paneRows']).toBeUndefined();
  });

  it('próg (`floor`): panel 62×21 nie mieści nawet minimalnego dialogu — zachowanie telefonu, geometria w śladzie', async () => {
    const pass = await runHook(request(), env(pty('62', '21')));
    expect(pass.stdout).toBe('');
    expect(rawPending()).toMatchObject({ budgetSource: 'floor', paneRows: 21, paneCols: 62 });
    const deny = await runHook(request({ tool_input: TALL }), env(pty('62', '21')));
    expect(denied(deny.stdout).message).toContain('holds 44');
    expect(guardLines()[0]).toMatchObject({ rows: 60, budget: 44, budgetSource: 'floor', paneRows: 21, paneCols: 62 });
  });

  it('poza strażnikiem (inne narzędzie, brak flagi, poza herdr) zrzut nie dostaje pól strażnika', async () => {
    await runHook(request({ tool_name: 'Write', tool_input: { file_path: join(project, 'a'), content: 'x' } }),
      env(pty('62', '29')));
    expect(rawPending()['budgetSource']).toBeUndefined();
    expect(rawPending()['paneRows']).toBeUndefined();
    rmSync(pendingFile());
    await runHook(request(), { RAROG_DATA_DIR: dataDir, ...pty('62', '29') });
    expect(rawPending()['budgetSource'], 'bez `HERDR_ENV`').toBeUndefined();
    rmSync(pendingFile());
    writeHookRoots(dataDir, [join(dataDir, 'roots', 'Projects')]);
    await runHook(request(), env(pty('62', '29')));
    expect(rawPending()['budgetSource'], 'strażnik wyłączony').toBeUndefined();
  });

  it('moduł bez API geometrii, budżet w obcym kształcie albo wyjątek w nowym API: jak bez strażnika panelu', async () => {
    // Pełne nowe API z jedną funkcją podmienioną — wyjątek w KAŻDYM kroku daje zrzut bez pól strażnika
    // (atrapa bez `paneFromEnv` nie dochodzi do wyjątku w szacunku).
    const api = (over: Record<string, string>): string => Object.entries({
      paneFromEnv: '() => ({ columns: 62, rows: 29 })',
      dialogBudget: "() => ({ source: 'pane', paneRows: 29, paneCols: 62 })",
      tallDialogVerdict: "() => ({ reason: 'rows', message: 'x' })",
      ...over,
    }).map(([name, body]) => `export const ${name} = ${body};`).join('\n');
    const boom = "() => { throw new Error('zepsuty'); }";
    const variants: [string, string][] = [
      ['stary', "export function tallDialogVerdict() { return { reason: 'rows', message: 'x' }; }\n"],
      ['źródło', api({ paneFromEnv: '() => null', dialogBudget: "() => ({ source: 'telefon' })" })],
      ['wyjątek-geometrii', api({ paneFromEnv: boom })],
      ['wyjątek-budżetu', api({ dialogBudget: boom })],
      ['wyjątek-szacunku', api({ tallDialogVerdict: boom })],
      ['werdykt-bez-komunikatu', api({ tallDialogVerdict: "() => ({ reason: 'rows' })" })],
    ];
    for (const [name, body] of variants) {
      const copy = mkdtempSync(join(dataDir, `kopia-${name}-`));
      copyFileSync(HOOK, join(copy, 'rarog-pending.mjs'));
      copyFileSync(join(REPO, 'scripts', 'hooks', 'work-area.mjs'), join(copy, 'work-area.mjs'));
      writeFileSync(join(copy, 'tall-dialog.mjs'), body);
      const result = await runHook(request(), env(pty('62', '29')), join(copy, 'rarog-pending.mjs'));
      const fallback = explain(
        `Hook with module variant „${name}”: the dump or the decision differs from the hook without the guard.`,
        'an old or broken `tall-dialog.mjs` next to the hook must not block or deny permissions.',
        'keep the dynamic import, the try/catch and the shape checks in `tallDialogGuard` (`rarog-pending.mjs`).',
      );
      expect(result.stdout, fallback).toBe('');
      expect(rawPending()['budgetSource'], fallback).toBeUndefined();
      rmSync(pendingFile());
    }
    expect(existsSync(join(dataDir, HOOK_GUARD_LOG_FILENAME))).toBe(false);
  });
});

describe('czytnik zrzutu: pola strażnika są diagnostyką, nie warunkiem zrzutu', () => {
  const put = (fields: Record<string, unknown>): void => {
    mkdirSync(join(dataDir, 'pending'), { recursive: true });
    writeFileSync(pendingFile(), JSON.stringify({
      sessionId: SESSION, toolName: 'Bash', toolInput: { command: 'ls' }, at: Date.now(),
      hookEventName: 'PermissionRequest', ...fields,
    }));
  };

  it('zły kształt gubi samo pole, a zrzut zostaje; wymiary tylko parą', () => {
    put({ budgetSource: 'telefon', paneRows: '29', paneCols: 62 });
    const entry = readPendingHook(dataDir, SESSION, () => Date.now());
    expect(entry?.toolName).toBe('Bash');
    expect(entry?.budgetSource).toBeUndefined();
    expect(entry?.paneRows).toBeUndefined();
    expect(entry?.paneCols).toBeUndefined();
    put({ budgetSource: 'floor', paneRows: 21.5, paneCols: 62 });
    expect(readPendingHook(dataDir, SESSION, () => Date.now())).toMatchObject({ budgetSource: 'floor' });
    expect(readPendingHook(dataDir, SESSION, () => Date.now())?.paneRows).toBeUndefined();
    put({ budgetSource: 'pane', paneRows: 29, paneCols: 62 });
    expect(readPendingHook(dataDir, SESSION, () => Date.now())).toMatchObject({
      budgetSource: 'pane', paneRows: 29, paneCols: 62,
    });
  });
});

describe('`summarizeGuard`: rozkład źródła budżetu i najniższy panel', () => {
  it('liczy `pane`/`phone`/`floor`, linie bez `budgetSource` jako `brak`, obce jako `inne`; najmniejsze `paneRows`', () => {
    const lines = [
      JSON.stringify({ at: 1_000, subagent: true, reason: 'rows', rows: 105 }),
      JSON.stringify({ at: 2_000, subagent: true, reason: 'rows', rows: 37, budgetSource: 'pane', paneRows: 29, paneCols: 62 }),
      JSON.stringify({ at: 3_000, subagent: false, reason: 'rows', rows: 47, budgetSource: 'pane', paneRows: 52, paneCols: 40 }),
      JSON.stringify({ at: 4_000, subagent: true, reason: 'rows', rows: 60, budgetSource: 'floor', paneRows: 21, paneCols: 62 }),
      JSON.stringify({ at: 5_000, subagent: false, reason: 'rows', rows: 60, budgetSource: 'phone' }),
      JSON.stringify({ at: 6_000, subagent: false, reason: 'rows', rows: 60, budgetSource: 'ekran', paneRows: -3 }),
    ];
    expect(summarizeGuard(lines, 0)).toMatchObject({
      total: 6, byBudgetSource: { missing: 1, pane: 2, floor: 1, phone: 1, other: 1 }, minPaneRows: 21,
    });
    expect(summarizeGuard(lines.slice(0, 1), 0)).toMatchObject({ byBudgetSource: { missing: 1 }, minPaneRows: null });
  });
});
