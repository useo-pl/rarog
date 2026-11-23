/**
 * Dialogi CLI bez obsługi z telefonu (CLI 2.1.309) — strażnik wyniku parsera i decyzji karty.
 *
 * Trzy ekrany, przy których karta na telefonie nie ma przycisków; wyniki niżej przechodzą przez prawdziwy
 * `resolveOptions` i `decideCard`:
 *
 * - zgoda `Bash` subagenta w panelu 62×29: nagłówek „Bash command" i początek komendy nad krawędzią, nazwa
 *   tylko ze stopki `Ask rule`. Bez podwójnego dowodu (wpis jsonl + zrzut hooka z tą samą komendą) `mismatch`
 *   z podpowodem `operation`; z nim karta z przyciskami;
 * - pauza „Session paused" po fladze zabezpieczeń modelu i dialog wyjścia „Background work is running":
 *   dialogi z zamkniętej listy `TERMINAL_DIALOGS` — karta `confirm` z tytułem, treścią i dosłownymi
 *   opcjami, z których KAŻDA ma `terminalOnly`, bez przycisków na ścieżce wysyłki i z wpisem `degrade`
 *   (`dialogTitle`).
 *
 * Driver (odmowa cyfry, `allow`, Esc na pauzie i na wyjściu, dziennik): `herdr-driver.test.ts`, sekcja
 * „dialogi z listy terminalowej ”.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideCard } from '../src/herdr/dialogs/decide/decide.ts';
import { decideReqId } from '../src/herdr/dialogs/decide/sources.ts';
import type { DecideAction, DecideInput } from '../src/herdr/dialogs/decide/input.ts';
import { screenFallbackReqId } from '../src/herdr/dialogs/cards/ids.ts';
import { commandDialogMatches } from '../src/drivers/herdr/commands.ts';
import type { ActiveReq } from '../src/herdr/dialogs/cards/build.ts';
import { SCREEN_SIGNATURES } from '../src/herdr/dialogs/screen/signatures.ts';
import { TERMINAL_DIALOGS, matchTerminalDialog } from '../src/herdr/dialogs/policy/terminal.ts';
import { parseOptions } from '../src/herdr/dialogs/screen/parse.ts';
import { resolveOptions } from '../src/herdr/dialogs/screen/resolve.ts';
import { sessionPausedDialog } from '../src/herdr/dialogs/policy/pause.ts';
import type { ScreenDialog } from '../src/herdr/dialogs/screen/parse.ts';

const DIR = join(import.meta.dirname, 'fixtures', 'herdr');
const screen = (name: string): string => readFileSync(join(DIR, name), 'utf8');

const UCIETY = screen('dialog-bash-subagent-uciety-62x29-2.1.309.txt');
const UCIETY_INPUT = JSON.parse(
  screen('dialog-bash-subagent-uciety-62x29-2.1.309.command.json'),
) as { toolName: string; command: string };
const PAUZA = screen('dialog-session-paused-2.1.309.txt');
const WYJSCIE = screen('dialog-background-work-exit-2.1.309.txt');

const PAUZA_OPCJE = [
  '  ❯ 1. Switch to Opus 4.8',
  '    2. Edit prompt and retry with Opus 5.5 (1M context)',
].join('\n');
/** Pauza o tym samym tytule z innym kompletem opcji (opcje wymyślone, jedna wspólna z listą). */
const PAUZA_INNA = PAUZA.replace(PAUZA_OPCJE, [
  '  ❯ 1. Keep waiting',
  '    2. Switch to Opus 4.8',
].join('\n'));
/** Pauza z tytułem i kreską nad krawędzią panelu — region bez kreski, ekran od treści w dół. */
const PAUZA_BEZ_TYTULU = PAUZA.slice(PAUZA.indexOf('  Opus 5.5 (1M context)\'s safeguards'));
/** Te same opcje i treść pod innym tytułem — dialog spoza listy. */
const INNY_TYTUL = PAUZA.replace(' Session paused\n', ' Session on hold\n');

function dialogOf(text: string): ScreenDialog {
  const dialog = parseOptions(text);
  if (dialog === null) throw new Error('ekran bez dialogu');
  return dialog;
}

describe('zgoda Bash subagenta ucięta u góry (panel 62×29)', () => {
  it('ekran: ramka operacji bez nagłówka, nazwa tylko ze stopki, dwie opcje z cyframi', () => {
    const dialog = parseOptions(UCIETY);
    expect(dialog?.kind).toBe('tool');
    expect(dialog?.toolName).toBe('Bash');
    expect(dialog?.identity).toEqual({ kind: 'ask-rule', tool: 'Bash' });
    expect(dialog?.operation).toMatchObject({ complete: false, headerVisible: false });
    expect(dialog?.options).toEqual([{ digit: '1', label: 'Yes' }, { digit: '2', label: 'No' }]);
    expect(dialog?.terminalDialog).toBeNull();
  });

  it('bez podwójnego dowodu: mismatch z podpowodem operation', () => {
    const expected = { toolName: 'Bash', command: UCIETY_INPUT.command };
    expect(resolveOptions(UCIETY, expected)).toEqual({
      status: 'mismatch', retryable: false, reason: 'operation', screenKind: 'tool', screenToolName: 'Bash',
    });
  });

  it('z podwójnym dowodem: ok, cyfry z ekranu', () => {
    const expected = { toolName: 'Bash', command: UCIETY_INPUT.command, doubleProof: true };
    const result = resolveOptions(UCIETY, expected);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.toolName).toBe('Bash');
    expect([...result.digitByLabel]).toEqual([['Yes', '1'], ['No', '2']]);
    expect(result.question).toBeNull();
  });
});

describe.each([
  {
    nazwa: 'pauza „Session paused" (flaga zabezpieczeń)',
    tekst: PAUZA,
    id: 'session-paused-safeguards',
    tytul: 'Session paused',
    tresc: /^Opus 5\.5 \(1M context\)'s safeguards flagged this session\.[\s\S]*\nDetails: `\[cyber\]`$/,
    opcje: [
      { digit: '1', label: 'Switch to Opus 4.8' },
      { digit: '2', label: 'Edit prompt and retry with Opus 5.5 (1M context)' },
    ],
  },
  {
    nazwa: 'wyjście „Background work is running"',
    tekst: WYJSCIE,
    id: 'background-work-exit',
    tytul: 'Background work is running',
    tresc: /^The following will stop when you exit:\nshell · /,
    opcje: [
      { digit: '1', label: 'Exit and stop tasks' },
      { digit: '2', label: 'Move to background and exit' },
      { digit: '3', label: 'Stay' },
    ],
  },
] as const)('$nazwa spoza jsonl', ({ tekst, id, tytul, tresc, opcje }) => {
  it('parser: potwierdzenie z listy terminalowej, tytuł w nagłówku, reszta w treści', () => {
    const dialog = dialogOf(tekst);
    expect(dialog.kind).toBe('confirm');
    expect(dialog.terminalDialog).toBe(id);
    expect(dialog.title).toBe(tytul);
    expect(dialog.question?.header).toBe(tytul);
    expect(dialog.question?.question).toMatch(tresc);
    expect(dialog.options).toEqual(opcje);
  });

  it('no-jsonl: karta confirm, KAŻDA opcja terminalOnly, zero opcji na ścieżce wysyłki', () => {
    const result = resolveOptions(tekst, null);
    if (result.status !== 'no-jsonl') throw new Error(`spodziewano no-jsonl, jest ${result.status}`);
    // Żadna sygnatura z przyciskiem (`KNOWN_DIALOGS`) i żadna opcja na przyciski karty dialogu.
    expect(result.knownDialog).toBeNull();
    expect(result.options).toEqual([]);
    expect(result.questionForm).toMatchObject({ kind: 'confirm', header: tytul, terminalDialog: id });
    expect(result.questionForm?.options).toEqual(opcje.map((opcja) => ({ ...opcja, terminalOnly: true })));
  });

  it('wpis jsonl obok dialogu nie daje karty z cyframi — rozjazd rodzaju', () => {
    expect(resolveOptions(tekst, { toolName: 'Bash', command: 'ls' }))
      .toMatchObject({ status: 'mismatch', reason: 'kind', screenKind: 'confirm' });
  });

  it('nie jest potwierdzeniem komendy `/model` ani `/effort` — auto-potwierdzenie nie wybierze opcji', () => {
    // Pauza niesie nazwy modeli w opcjach; bez listy terminalowej `/model opus` trafiłoby w „Switch to Opus 4.8".
    for (const command of ['/model opus', '/effort high', '/model']) {
      expect(commandDialogMatches(command, tekst, dialogOf(tekst)), command).toBe(false);
    }
  });
});

describe('lista terminalowa jest zamknięta', () => {
  it('every pattern of the list comes from the signature registry with the CLI version of its measurement', () => {
    const wzorce = new Set<RegExp>(TERMINAL_DIALOGS.flatMap((dialog) => [dialog.title, ...dialog.options]));
    const zRejestru = Object.values(SCREEN_SIGNATURES).filter((s) => wzorce.has(s.pattern as RegExp));
    expect(zRejestru).toHaveLength(wzorce.size);
    for (const sygnatura of zRejestru) expect(sygnatura.cli).toBe('2.1.309');
  });

  it('pauza z innym kompletem opcji NIE trafia w sygnaturę — karta `other` z wycinkiem', () => {
    const dialog = dialogOf(PAUZA_INNA);
    expect(dialog.terminalDialog).toBeNull();
    expect(dialog.kind).toBe('other');
    expect(resolveOptions(PAUZA_INNA, null)).toMatchObject({ status: 'no-jsonl', questionForm: null, options: [] });
  });

  it('komplet opcji: brak, nadmiar albo dwie opcje „Switch to …" nie trafiają', () => {
    const opcja = (digit: string, label: string): { digit: string; label: string } => ({ digit, label });
    expect(matchTerminalDialog('Session paused', [opcja('1', 'Switch to Opus 4.8')])).toBeNull();
    expect(matchTerminalDialog('Session paused', [
      opcja('1', 'Switch to Opus 4.8'), opcja('2', 'Edit prompt and retry with Opus 5.5'), opcja('3', 'Stay'),
    ])).toBeNull();
    expect(matchTerminalDialog('Session paused', [
      opcja('1', 'Switch to Opus 4.8'), opcja('2', 'Switch to Sonnet 4.5'),
    ])).toBeNull();
    expect(matchTerminalDialog('Background work is running', [
      opcja('1', 'Exit and stop tasks'), opcja('2', 'Move to background and exit'), opcja('3', 'Stay on Opus'),
    ])).toBeNull();
  });

  it('te same opcje pod innym tytułem albo bez tytułu na ekranie NIE trafiają', () => {
    expect(dialogOf(INNY_TYTUL).terminalDialog).toBeNull();
    const bezTytulu = dialogOf(PAUZA_BEZ_TYTULU);
    expect(bezTytulu.terminalDialog).toBeNull();
    // Region bez kreski nad nim: pierwsza linia mogłaby być scrollbackiem, więc tytułu nie ma.
    expect(bezTytulu.title).toBeNull();
  });
});

describe('pauza dla odmowy Esc (`sessionPausedDialog`)', () => {
  it('pauza zabezpieczeń, pauza z innymi opcjami i pauza z tytułem nad krawędzią — każda to pauza', () => {
    for (const tekst of [PAUZA, PAUZA_INNA, PAUZA_BEZ_TYTULU]) expect(sessionPausedDialog(dialogOf(tekst))).toBe(true);
    // Szerzej niż karta, celowo: opcja „Edit prompt and retry with …" wystarcza i pod innym tytułem.
    expect(sessionPausedDialog(dialogOf(INNY_TYTUL))).toBe(true);
  });

  it('wyjście z zadaniami w tle i zwykły dialog zgody to nie pauza', () => {
    expect(sessionPausedDialog(dialogOf(WYJSCIE))).toBe(false);
    expect(sessionPausedDialog(dialogOf(UCIETY))).toBe(false);
    expect(sessionPausedDialog(dialogOf(screen('dialog-resume-summary-2.1.258.txt')))).toBe(false);
  });
});

/** Wejście decyzji dla dialogu spoza jsonl — bez źródeł, ekran z odczytu tej oceny. */
function input(text: string, over: Partial<DecideInput> = {}): DecideInput {
  return {
    pending: null,
    hookPending: null,
    text,
    reqId: decideReqId(null, 7),
    active: null,
    blockedSeq: 7,
    answeredSeq: -1,
    hookAnswersEnabled: true,
    deadAnswerKey: null,
    canRetry: false,
    answeredHookCall: null,
    decided: null,
    resolve: resolveOptions,
    excerpt: (screenText: string) => screenText.trim(),
    hookRaw: null,
    ...over,
  };
}

function cardOf(action: DecideAction): Extract<DecideAction, { kind: 'card' }> {
  if (action.kind !== 'card') throw new Error(`spodziewano karty, jest ${action.kind}`);
  return action;
}

function reqIdOf(action: DecideAction): string {
  if (action.kind === 'card') return action.card.active.reqId;
  if (action.kind === 'screen-dialog') return action.reqId;
  throw new Error(`spodziewano karty, jest ${action.kind}`);
}

/** Karta stojąca na telefonie po tej akcji — tak, jak zapamiętuje ją driver. */
function activeOf(action: DecideAction): ActiveReq {
  if (action.kind === 'card') return action.card.active;
  if (action.kind === 'screen-dialog') return { reqId: action.reqId, toolName: 'dialog', options: [], screen: true };
  throw new Error(`spodziewano karty, jest ${action.kind}`);
}

describe('karta dialogu z listy terminalowej w `decideCard`', () => {
  it('pauza: karta pytania z tytułem i opcjami bez przycisków, wpis `degrade` z `dialogTitle`', () => {
    const action = cardOf(decideCard(input(PAUZA)));
    expect(action.card.event).toMatchObject({ type: 'question-request', channel: 'keys' });
    if (action.card.event.type !== 'question-request') return;
    const [pytanie] = action.card.event.questions;
    expect(pytanie?.header).toBe('Session paused');
    expect(pytanie?.question).toMatch(/^Opus 5\.5 \(1M context\)'s safeguards flagged this session\./);
    expect(pytanie?.options.map((o) => [o.label, o.terminalOnly])).toEqual([
      ['Switch to Opus 4.8', true], ['Edit prompt and retry with Opus 5.5 (1M context)', true],
    ]);
    expect(action.card.active).toMatchObject({
      toolName: 'dialog:confirm', terminalDialog: 'session-paused-safeguards', screen: true,
    });
    expect(action.card.active.options.every((o) => o.terminalOnly === true)).toBe(true);
    expect(action.audit).toBe('no-jsonl');
    expect(action.diagnosis).toEqual({
      mismatchReason: null, headerVisible: null, optionCount: 2, dialogTitle: 'session-paused-safeguards',
    });
    expect(action.card.active.origin).toEqual({ source: 'screen' });
  });

  it('wyjście: ta sama karta, `dialogTitle: background-work-exit`', () => {
    const action = cardOf(decideCard(input(WYJSCIE)));
    expect(action.card.active.terminalDialog).toBe('background-work-exit');
    expect(action.audit).toBe('no-jsonl');
    expect(action.diagnosis?.dialogTitle).toBe('background-work-exit');
  });

  it('zwykłe potwierdzenie CLI dalej bez wpisu w dzienniku i bez `terminalDialog`', () => {
    const action = cardOf(decideCard(input(screen('dialog-resume-summary-2.1.258.txt'))));
    expect(action.audit).toBeNull();
    expect(action.card.active.terminalDialog).toBeUndefined();
  });

  it('ten sam dialog nad stojącą kartą → bez nowej karty i bez drugiego wpisu', () => {
    const first = cardOf(decideCard(input(PAUZA)));
    expect(decideCard(input(PAUZA, { active: first.card.active }))).toEqual({ kind: 'keep', touchSeq: true });
  });

  it('odsłonięcie tytułu nad tymi samymi opcjami → nowa karta (wycinek → karta z treścią)', () => {
    const uciety = decideCard(input(PAUZA_BEZ_TYTULU));
    expect(uciety.kind).toBe('screen-dialog');
    const pelny = decideCard(input(PAUZA, { active: activeOf(uciety) }));
    expect(pelny.kind).toBe('card');
    expect(reqIdOf(pelny)).not.toBe(reqIdOf(uciety));
  });

  it('inna pauza przy tych samych opcjach → nowa karta (treść w odcisku)', () => {
    const cyber = cardOf(decideCard(input(PAUZA)));
    const inna = decideCard(input(PAUZA.replace('`[cyber]`', '`[bio]`'), { active: cyber.card.active }));
    expect(inna.kind).toBe('card');
    expect(reqIdOf(inna)).not.toBe(cyber.card.active.reqId);
  });

  it('dialog spoza listy: inny tytuł nad tymi samymi etykietami → nowa karta z wycinkiem (tytuł w odcisku)', () => {
    const inna = decideCard(input(PAUZA_INNA));
    expect(inna.kind).toBe('screen-dialog');
    const innyTytul = PAUZA_INNA.replace(' Session paused\n', ' Session on hold\n');
    const inny = decideCard(input(innyTytul, { active: activeOf(inna) }));
    expect(inny.kind).toBe('screen-dialog');
    expect(reqIdOf(inny)).not.toBe(reqIdOf(inna));
    // Bez tytułu (region bez kreski) odcisk liczy się bez niego — tytuł dochodzi tylko, gdy jest.
    const parts = { knownDialog: null, reason: 'no-jsonl' as const, question: null, options: [] };
    expect(screenFallbackReqId('screen:7', { ...parts, title: null })).toBe(screenFallbackReqId('screen:7', parts));
    expect(screenFallbackReqId('screen:7', { ...parts, title: 'Session paused' }))
      .not.toBe(screenFallbackReqId('screen:7', parts));
  });
});
