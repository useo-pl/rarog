/**
 * A SUBAGENT `Bash` consent while the main agent is working.
 *
 * A subagent call has no entry in the main conversation file, so Rarog knows it from the screen and from the
 * `PermissionRequest` hook dump. The main agent can run its own command meanwhile: its entry is YOUNGER than the
 * dump. If such a dump stayed out of the evaluation, the main agent's entry would be the card source, the frame on
 * the screen would not show it and the card would go without buttons (`mismatch` / `operation`).
 *
 * Rule: a `Bash` dump older than the entry wins ONLY with the whole operation frame under a visible `Bash` title
 * and the dump command equal to the whole frame. Everything else — a clipped frame, another command, another tool,
 * a `PreToolUse` dump — goes through the ordinary evaluation. Screens go through the REAL `resolveOptions`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideCard } from '../src/herdr/dialogs/decide/decide.ts';
import { evaluationReqId, hookPendingFor } from '../src/herdr/dialogs/decide/sources.ts';
import type { DecideAction, DecideInput, DecidedShield } from '../src/herdr/dialogs/decide/input.ts';
import { degradedReqId } from '../src/herdr/dialogs/cards/ids.ts';
import { callPrint, competingHook, hookPendingFrom, olderBashHook } from '../src/herdr/dialogs/cross-check.ts';
import type { ActiveReq } from '../src/herdr/dialogs/cards/build.ts';
import { parseOptions } from '../src/herdr/dialogs/screen/parse.ts';
import { resolveOptions } from '../src/herdr/dialogs/screen/resolve.ts';
import type { PendingTool } from '../src/herdr/jsonl-pending.ts';
import type { PendingHookTool } from '../src/herdr/dialogs/hook/dump.ts';

const DIR = join(import.meta.dirname, 'fixtures', 'herdr');
const screen = (name: string): string => readFileSync(join(DIR, name), 'utf8');
const command = (name: string): string => (
  JSON.parse(readFileSync(join(DIR, name), 'utf8')) as { command: string }).command;

/** Dialog subagenta: cała ramka, tytuł „Bash command · from the general-purpose agent". */
const SUB = screen('dialog-bash-subagent-naglowek-2.1.302.txt');
const X = command('dialog-bash-subagent-naglowek-2.1.302.command.json');
/** Komenda agenta głównego, której początek widać w scrollbacku nad dialogiem. */
const M = 'R=/Users/u/Projects/core; bash -n $R/scripts/baseline.sh && shellcheck $R/scripts/baseline.sh '
  + '$R/tests/baseline-test.sh && echo "shellcheck ok"; bash $R/tests/baseline-test.sh 2>&1 | tail -3';
/** Cały dialog `Bash` innej komendy (128 kolumn) — „trzecia komenda" albo komenda agenta głównego. */
const WIDE = screen('dialog-bash-stechly-read-szeroki-2.1.295.txt');
const WIDE_CMD = command('dialog-bash-stechly-read-szeroki-2.1.295.command.json');
/** Ekran tuż po cyfrze: dialog zniknął, komenda subagenta biegnie, dialogu do odczytania nie ma. */
const CLOSING = '  ⎿  Running…\n\n❯ \n';

/** Zrzut dialogu subagenta; wpis agenta głównego 13 s później (jak w zmierzonej odmowie). */
const HOOK_AT = Date.parse('2026-10-15T11:22:28.142Z');
const MAIN_AT = HOOK_AT + 13_000;

function jsonl(cmd: string, id = 'toolu_main', at = MAIN_AT, toolName = 'Bash'): PendingTool {
  return { id, toolName, input: { command: cmd }, at: new Date(at).toISOString() };
}

function hook(toolInput: unknown, at = HOOK_AT, toolName = 'Bash'): PendingHookTool {
  return { toolName, toolInput, at, hookEventName: 'PermissionRequest' };
}

/** Wejście jak w driverze: `hookPending` przepuszczony przez tę samą regułę co driver (`hookPendingFor`). */
function input(
  text: string, pending: PendingTool | null, raw: PendingHookTool | null, over: Partial<DecideInput> = {},
): DecideInput {
  const hookPending = hookPendingFor(pending, raw);
  return {
    pending,
    hookPending,
    text,
    reqId: evaluationReqId(pending, hookPending, raw, 7),
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
    hookRaw: raw,
    ...over,
  };
}

function card(action: DecideAction): Extract<DecideAction, { kind: 'card' }> {
  expect(action.kind).toBe('card');
  if (action.kind !== 'card') throw new Error('brak karty');
  return action;
}

/** Karta zgody z przyciskami: treść ze źródła i cyfry z ekranu. */
function buttons(action: DecideAction): { input: unknown; active: ActiveReq } {
  const built = card(action);
  const event = built.card.event;
  if (event.type !== 'permission-request') throw new Error('nie zgoda');
  expect(built.card.active.options.map((o) => o.digit)).toEqual(['1', '2']);
  expect(built.audit).toBeNull();
  return { input: event.input, active: built.card.active };
}

/** Karta bez przycisków: `input: null`, pusta lista opcji. */
function degraded(action: DecideAction): Extract<DecideAction, { kind: 'card' }> {
  const built = card(action);
  expect(built.card.active.options).toEqual([]);
  expect(built.card.event.type === 'permission-request' ? built.card.event.input : 'x').toBeNull();
  return built;
}

/** Ekran od pierwszej linii, która zawiera `marker` — reszta powyżej jest „nad krawędzią panelu". */
function from(text: string, marker: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.includes(marker));
  if (start === -1) throw new Error(`brak linii z „${marker}"`);
  return lines.slice(start).join('\n');
}

const HOOK_ID = `hook:${String(HOOK_AT)}`;

describe('fixture `dialog-bash-subagent-naglowek-2.1.302` (kształt zmierzonej odmowy)', () => {
  it('cała ramka pod widocznym tytułem `Bash`, a ramka to cała komenda X', () => {
    const dialog = parseOptions(SUB);
    expect(dialog).toMatchObject({ kind: 'tool', toolName: 'Bash', identity: { kind: 'title', tool: 'Bash' } });
    expect(dialog?.operation).toMatchObject({ complete: true, headerVisible: true });
    expect(resolveOptions(SUB, { toolName: 'Bash', command: X }).status).toBe('ok');
    expect(resolveOptions(SUB, { toolName: 'Bash', command: M })).toMatchObject({
      status: 'mismatch', reason: 'operation',
    });
  });

  it('zrzut subagenta jest STARSZY niż wpis agenta głównego: konkuruje wyłącznie jako `olderBashHook`', () => {
    expect(competingHook(jsonl(M), hook({ command: X }))).toBe(false);
    expect(olderBashHook(jsonl(M), hook({ command: X }))).toBe(true);
  });
});

describe('starszy zrzut, młodszy wpis agenta głównego, cała ramka X (przypadek zmierzonej odmowy)', () => {
  it('karta z przyciskami: treść X, generacja zrzutu jako dowód, tożsamość z samego zrzutu', () => {
    const { input: cardInput, active } = buttons(decideCard(input(SUB, jsonl(M), hook({ command: X }))));
    expect(cardInput).toEqual({ command: X });
    expect(active.toolName).toBe('Bash');
    expect(active.proofHookAt).toBe(HOOK_AT);
    expect(active.bodyPrint).toBe(parseOptions(SUB)?.bodyPrint);
    expect(active.reqId).toBe(HOOK_ID);
    // Materiał osłony po decyzji: wpis obok jest MŁODSZY od zrzutu, a nie źródłem.
    expect(active.callId).toBeUndefined();
    expect(active.pendingId).toBe('toolu_main');
    expect(active.pendingYounger).toBe(true);
  });

  it('wpis agenta głównego innego narzędzia niż `Bash` — ta sama karta X', () => {
    const read: PendingTool = { id: 'toolu_read', toolName: 'Read', input: { file_path: '/a.png' },
      at: new Date(MAIN_AT).toISOString() };
    const { input: cardInput, active } = buttons(decideCard(input(SUB, read, hook({ command: X }))));
    expect(cardInput).toEqual({ command: X });
    expect(active.reqId).toBe(HOOK_ID);
  });

  it('starszy zrzut INNEJ komendy niż ramka (stęchły zrzut) → jak dotąd, bez przycisków', () => {
    degraded(decideCard(input(SUB, jsonl(M), hook({ command: `${X} # inna` }))));
  });
});

describe('ramka ucięta albo nagłówek nad krawędzią → zwykła ocena (`mismatch`)', () => {
  it('ramka ucięta u góry, nazwa tylko ze stopki `Ask rule` (ten sam dialog X)', () => {
    const clipped = from(SUB, 'git -C "$E/repo" log --oneline -1');
    expect(parseOptions(clipped)).toMatchObject({ toolName: 'Bash', identity: { kind: 'ask-rule', tool: 'Bash' } });
    expect(parseOptions(clipped)?.operation?.complete).toBe(false);
    const built = degraded(decideCard(input(clipped, jsonl(M), hook({ command: X }))));
    expect(built.audit).toBe('mismatch');
    expect(built.card.active.reqId).toBe(degradedReqId('toolu_main', null));
  });

  it('ramka cała, ale bez górnej kreski dialogu (tytuł w pierwszej linii ekranu)', () => {
    const noRule = from(SUB, 'Bash command · from the general-purpose agent');
    expect(parseOptions(noRule)?.operation).toMatchObject({ complete: true, headerVisible: false });
    expect(degraded(decideCard(input(noRule, jsonl(M), hook({ command: X })))).audit).toBe('mismatch');
  });

  it('nagłówek nad krawędzią panelu (`dialog-bash-uciety-naglowek-2.1.294`)', () => {
    const clipped = screen('dialog-bash-uciety-naglowek-2.1.294.txt');
    const cmd = command('dialog-bash-uciety-naglowek-2.1.294.command.json');
    expect(degraded(decideCard(input(clipped, jsonl(M), hook({ command: cmd })))).audit).toBe('mismatch');
  });

  it('tytuł spoza mapy nagłówków nad całą ramką (stopka `Ask rule` daje nazwę) — zrzut nie wygrywa', () => {
    const renamed = SUB.replace(' Bash command · from the general-purpose agent', ' Shell command · from the agent');
    expect(parseOptions(renamed)).toMatchObject({ toolName: 'Bash', identity: { kind: 'ask-rule', tool: 'Bash' } });
    degraded(decideCard(input(renamed, jsonl(M), hook({ command: X }))));
  });
});

describe('pozostałe przypadki bez zmian', () => {
  it('na ekranie cała ramka TRZECIEJ komendy Z → karta bez przycisków z tożsamością ze zwykłej oceny', () => {
    const built = degraded(decideCard(input(WIDE, jsonl(M), hook({ command: X }))));
    expect(built.audit).toBe('mismatch');
    expect(built.card.active.reqId).toBe(degradedReqId('toolu_main', null));
  });

  it('na ekranie cała ramka M (dialog agenta głównego) → źródłem wpis M, tożsamość ze zwykłej oceny', () => {
    const { input: cardInput, active } = buttons(decideCard(input(WIDE, jsonl(WIDE_CMD), hook({ command: X }))));
    expect(cardInput).toEqual({ command: WIDE_CMD });
    expect(active.reqId).toBe('toolu_main');
    expect(active.callId).toBe('toolu_main');
    expect(active.proofHookAt).toBeUndefined();
    expect(active.pendingYounger).toBeUndefined();
  });

  it('ta sama komenda w zrzucie i we wpisie, inny opis → wpis ze zwykłej oceny (bez karty „pasują oba")', () => {
    const pending: PendingTool = { ...jsonl(X), input: { command: X, description: 'agent główny' } };
    const raw = hook({ command: X, description: 'subagent' });
    expect(olderBashHook(pending, raw)).toBe(true);
    const { input: cardInput, active } = buttons(decideCard(input(SUB, pending, raw)));
    expect(cardInput).toEqual(pending.input);
    expect(active.reqId).toBe('toolu_main');
  });

  it('starszy zrzut narzędzia innego niż `Bash` (`Read` subagenta) nie konkuruje', () => {
    const readDialog = screen('dialog-permission-read-2.1.278.txt')
      .replace(' Read file\n', ' Read file · from the Explore agent\n');
    const raw = hook({ file_path: '/etc/hosts' }, HOOK_AT, 'Read');
    expect(olderBashHook(jsonl(M), raw)).toBe(false);
    const built = degraded(decideCard(input(readDialog, jsonl(M), raw)));
    expect(built.audit).toBe('mismatch');
    expect(built.card.event.type === 'permission-request' ? built.card.event.toolName : '').toBe('Read');
  });

  it('starszy zrzut `PreToolUse` nie konkuruje', () => {
    const raw = { ...hook({ command: X }), hookEventName: 'PreToolUse' };
    expect(olderBashHook(jsonl(M), raw)).toBe(false);
    degraded(decideCard(input(SUB, jsonl(M), raw)));
  });

  it('wpis bez czytelnego znacznika czasu → zrzut nie konkuruje', () => {
    expect(olderBashHook({ ...jsonl(M), at: '' }, hook({ command: X }))).toBe(false);
  });
});

describe('tożsamość karty ze starszego zrzutu', () => {
  it('ocena = sam wpis (jak bez zrzutu), karta = sam zrzut — taka sama jak z samego zrzutu', () => {
    const raw = hook({ command: X });
    const hookPending = hookPendingFrom(raw);
    expect(evaluationReqId(jsonl(M), hookPending, raw, 7)).toBe('toolu_main');
    expect(evaluationReqId(jsonl(M), null, null, 7)).toBe('toolu_main');
    // Zrzut młodszy od wpisu (nowy dialog) — dzisiejsza konkurencja, oba identyfikatory.
    const fresh = hook({ command: X }, MAIN_AT + 1_000);
    expect(evaluationReqId(jsonl(M), hookPendingFrom(fresh), fresh, 7))
      .toBe(`hook:${String(MAIN_AT + 1_000)}~toolu_main`);
    const alone = buttons(decideCard(input(SUB, null, raw)));
    expect(alone.active.reqId).toBe(HOOK_ID);
    expect(alone.active.proofHookAt).toBe(HOOK_AT);
  });

  it('karta z wpisu przy starszym zrzucie innej komendy ma tożsamość oceny (bramka „ta sama karta")', () => {
    const raw = hook({ command: X });
    const pending = jsonl(WIDE_CMD);
    const built = input(WIDE, pending, raw);
    expect(buttons(decideCard(built)).active.reqId).toBe(built.reqId);
  });

  it('karta stoi, wpis agenta głównego się zmienia → `KEEP`, bez nowej karty', () => {
    const raw = hook({ command: X });
    const first = buttons(decideCard(input(SUB, jsonl(M), raw)));
    for (const next of [jsonl(M, 'toolu_main2', MAIN_AT + 5_000), jsonl('ls -la', 'toolu_main3', MAIN_AT + 9_000)]) {
      expect(decideCard(input(SUB, next, raw, { active: first.active }))).toEqual({ kind: 'keep', touchSeq: false });
    }
  });

  it('karta zbudowana z samego zrzutu, potem dochodzi wpis agenta głównego → `KEEP`', () => {
    const raw = hook({ command: X });
    const alone = buttons(decideCard(input(SUB, null, raw)));
    expect(decideCard(input(SUB, jsonl(M), raw, { active: alone.active }))).toEqual({ kind: 'keep', touchSeq: false });
  });

  it('nowy dialog (nowa generacja zrzutu) → nowa karta', () => {
    const first = buttons(decideCard(input(SUB, jsonl(M), hook({ command: X }))));
    const fresh = hook({ command: X }, HOOK_AT + 1_000);
    const next = buttons(decideCard(input(SUB, jsonl(M), fresh, { active: first.active })));
    expect(next.active.reqId).toBe(`hook:${String(HOOK_AT + 1_000)}`);
  });
});

describe('osłona po decyzji na karcie ze starszego zrzutu', () => {
  /** Migawka po cyfrze na karcie X: zrzut skasowany po cyfrze, wpis obok młodszy od zrzutu. */
  const decided = (over: Partial<DecidedShield> = {}): DecidedShield => ({
    reqId: HOOK_ID,
    callPrint: callPrint('Bash', { command: X }),
    callId: null,
    pendingId: 'toolu_main',
    pendingYounger: true,
    bodyPrint: parseOptions(SUB)?.bodyPrint ?? null,
    screenReqId: null,
    hookAt: HOOK_AT,
    seq: 7,
    ...over,
  });

  it('zmiana wpisu agenta głównego nie zdejmuje osłony: dialog X jeszcze na ekranie → zdarzenie zerowe', () => {
    expect(decideCard(input(SUB, jsonl(M, 'toolu_main2'), null, { decided: decided() })))
      .toEqual({ kind: 'keep', touchSeq: false });
  });

  it('dialog się zamyka (ekran bez dialogu) przy nowym wpisie agenta głównego → zdarzenie zerowe', () => {
    expect(decideCard(input(CLOSING, jsonl(M, 'toolu_main2'), null, { decided: decided() })))
      .toEqual({ kind: 'keep', touchSeq: false });
  });

  it('karta z SAMEGO zrzutu (wpis doszedł po karcie): zamykanie przy młodszym wpisie → zdarzenie zerowe', () => {
    // Typowy przebieg: karta powstała przed wpisem agenta głównego, więc nie ma `pendingId`.
    const shield = decided({ pendingId: null, pendingYounger: false });
    expect(decideCard(input(CLOSING, jsonl(M), null, { decided: shield, canRetry: false })))
      .toEqual({ kind: 'keep', touchSeq: false });
    expect(decideCard(input(SUB, jsonl(M, 'toolu_main2'), null, { decided: shield })))
      .toEqual({ kind: 'keep', touchSeq: false });
  });

  it('…ale wpis STARSZY od zrzutu (nie żywe wywołanie obok) nie dostaje tej osłony', () => {
    const shield = decided({ pendingId: null, pendingYounger: false });
    const stale = jsonl(M, 'toolu_old', HOOK_AT - 60_000);
    expect(degraded(decideCard(input(CLOSING, stale, null, { decided: shield }))).audit).toBe('unreadable');
  });

  it('…a inny CZYTELNY dialog przy młodszym wpisie dostaje kartę od razu', () => {
    const shield = decided({ pendingId: null, pendingYounger: false });
    expect(degraded(decideCard(input(WIDE, jsonl(M), null, { decided: shield }))).audit).toBe('mismatch');
    const own = buttons(decideCard(input(WIDE, jsonl(WIDE_CMD), null, { decided: shield })));
    expect(own.input).toEqual({ command: WIDE_CMD });
  });

  it('karta z ekranu (bez odcisku wywołania) nie dostaje osłony „wpis obok"', () => {
    const shield = decided({ callPrint: null, pendingId: null, pendingYounger: false });
    expect(degraded(decideCard(input(CLOSING, jsonl(M), null, { decided: shield }))).audit).toBe('unreadable');
  });

  it('wpis obok STĘCHŁY (zrzut młodszy niż wpis) — zmiana wpisu dalej zdejmuje osłonę', () => {
    const action = decideCard(input(SUB, jsonl(M, 'toolu_main2'), null, {
      decided: decided({ pendingYounger: false }),
    }));
    expect(degraded(action).audit).toBe('mismatch');
  });

  it('nowa generacja zrzutu (nowy dialog) zdejmuje osłonę także tutaj', () => {
    const action = decideCard(input(SUB, jsonl(M, 'toolu_main2'), hook({ command: X }, HOOK_AT + 1_000), {
      decided: decided(),
    }));
    expect(buttons(action).active.reqId).toBe(`hook:${String(HOOK_AT + 1_000)}`);
  });
});
