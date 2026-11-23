/**
 * Źródło karty zgody i tożsamość dialogu z treści operacji — `decideCard` na zrzutach incydentów.
 *
 * - Nagłówek „Bash command" nad krawędzią ekranu. Karta z przyciskami TYLKO, gdy komendę
 *   potwierdzają dwa źródła (wpis jsonl i zrzut `PermissionRequest`) i ramka na ekranie ją pokazuje.
 * - Wpis jsonl `Read`, którego wyniku follower nie przeczytał, nie zasłania świeżego zrzutu `Bash`.
 *   O źródle rozstrzyga ekran: najpierw wpis, potem zrzut — zgodny z ekranem także treścią.
 * - Ta sama nazwa, inna komenda: karta komendy X nad dialogiem komendy Y nie ma prawa dostać przycisku.
 *
 * Ekrany przechodzą przez PRAWDZIWY `resolveOptions`, komendy pochodzą z jsonl incydentów
 * (`fixtures/herdr/*.command.json`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideCard } from '../src/herdr/dialogs/decide/decide.ts';
import { competingSources, decideReqId, evaluationReqId, hookPendingFor } from '../src/herdr/dialogs/decide/sources.ts';
import type { DecideAction, DecideInput } from '../src/herdr/dialogs/decide/input.ts';
import { competingHook, hookMatchesScreen, hookPendingFrom } from '../src/herdr/dialogs/cross-check.ts';
import { resolveOptions } from '../src/herdr/dialogs/screen/resolve.ts';
import type { PendingTool } from '../src/herdr/jsonl-pending.ts';
import type { PendingHookTool } from '../src/herdr/dialogs/hook/dump.ts';

const DIR = join(import.meta.dirname, 'fixtures', 'herdr');
const screen = (name: string): string => readFileSync(join(DIR, name), 'utf8');
const command = (name: string): string => (
  JSON.parse(readFileSync(join(DIR, name), 'utf8')) as { command: string }).command;

const CLIPPED = screen('dialog-bash-uciety-naglowek-2.1.294.txt');
const CLIPPED_CMD = command('dialog-bash-uciety-naglowek-2.1.294.command.json');
const STALE_READ = screen('dialog-bash-stechly-read-2.1.295.txt');
const STALE_READ_CMD = command('dialog-bash-stechly-read-2.1.295.command.json');

const T0 = Date.parse('2026-10-09T16:57:30.000Z');

function jsonl(toolName: string, input: unknown, id = 'toolu_jsonl', at = T0): PendingTool {
  return { id, toolName, input, at: new Date(at).toISOString() };
}

function hook(toolName: string, toolInput: unknown, at = T0 + 1_000): PendingHookTool {
  return { toolName, toolInput, at, hookEventName: 'PermissionRequest' };
}

/** Wejście jak w driverze: `hookPending` to zrzut przepuszczony przez `hookPendingFor`. */
function input(text: string, pending: PendingTool | null, raw: PendingHookTool | null): DecideInput {
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
  };
}

/** Karta zgody z przyciskami: `input` z treścią i opcje z cyframi z ekranu. */
function permissionCard(action: DecideAction): { toolName: string; input: unknown; digits: string[] } {
  expect(action.kind).toBe('card');
  if (action.kind !== 'card') throw new Error('brak karty');
  const event = action.card.event;
  expect(event.type).toBe('permission-request');
  if (event.type !== 'permission-request') throw new Error('nie zgoda');
  return { toolName: event.toolName, input: event.input, digits: action.card.active.options.map((o) => o.digit) };
}

function degraded(action: DecideAction): void {
  expect(action.kind).toBe('card');
  if (action.kind !== 'card') return;
  expect(action.card.active.options).toEqual([]);
  expect(action.card.event.type === 'permission-request' ? action.card.event.input : 'x').toBeNull();
}

describe('ucięty nagłówek', () => {
  it('jsonl i zrzut hooka z tą samą komendą + ramka ją pokazuje → karta z przyciskami', () => {
    const card = permissionCard(decideCard(input(
      CLIPPED, jsonl('Bash', { command: CLIPPED_CMD }), hook('Bash', { command: CLIPPED_CMD }),
    )));
    expect(card.toolName).toBe('Bash');
    expect(card.input).toEqual({ command: CLIPPED_CMD });
    expect(card.digits).toEqual(['1', '2']);
  });

  it('bez zrzutu hooka sam wpis jsonl nie wystarcza — karta bez przycisków', () => {
    degraded(decideCard(input(CLIPPED, jsonl('Bash', { command: CLIPPED_CMD }), null)));
  });

  it('zrzut hooka z INNĄ komendą to brak drugiego dowodu', () => {
    degraded(decideCard(input(
      CLIPPED, jsonl('Bash', { command: CLIPPED_CMD }), hook('Bash', { command: `${CLIPPED_CMD} # inna` }),
    )));
  });

  it('zrzut starszy niż wpis jsonl nie jest drugim dowodem', () => {
    degraded(decideCard(input(
      CLIPPED, jsonl('Bash', { command: CLIPPED_CMD }), hook('Bash', { command: CLIPPED_CMD }, T0 - 60_000),
    )));
  });

  it('obie komendy zgodne, ale ramka pokazuje inny koniec — odmowa', () => {
    const other = CLIPPED_CMD.replace('PendingMediaRowTests', 'InnaKlasaTestow');
    degraded(decideCard(input(CLIPPED, jsonl('Bash', { command: other }), hook('Bash', { command: other }))));
  });
});

describe('stęchły wpis jsonl kontra świeży zrzut hooka', () => {
  const READ = jsonl('Read', { file_path: '/tmp/folders/xx/glass-after/model-dark.png' }, 'toolu_read', T0 - 600_000);

  it('martwy `Read` w jsonl + zrzut `Bash` zgodny z ekranem → karta `Bash` z przyciskami', () => {
    const action = decideCard(input(STALE_READ, READ, hook('Bash', { command: STALE_READ_CMD })));
    const card = permissionCard(action);
    expect(card.toolName).toBe('Bash');
    expect(card.input).toEqual({ command: STALE_READ_CMD });
    expect(card.digits).toEqual(['1', '2']);
  });

  it('bez zrzutu: karta bez przycisków nosi nazwę z EKRANU, nie tę z jsonl, której ekran przeczy', () => {
    const action = decideCard(input(STALE_READ, READ, null));
    degraded(action);
    if (action.kind !== 'card' || action.card.event.type !== 'permission-request') return;
    expect(action.card.event.toolName).toBe('Bash');
    expect(action.card.event.displayText).not.toContain('transkrypcie');
    expect(action.audit).toBe('mismatch');
  });

  it('zrzut z komendą, której ekran NIE pokazuje — zostaje dotychczasowa odmowa', () => {
    degraded(decideCard(input(STALE_READ, READ, hook('Bash', { command: 'rm -rf ~/Library/Caches/inne' }))));
  });

  it('tożsamość karty przy konkurujących źródłach niesie oba identyfikatory', () => {
    const raw = hook('Bash', { command: STALE_READ_CMD });
    const hookPending = hookPendingFrom(raw);
    expect(competingSources(READ, hookPending)).toBe(true);
    expect(decideReqId(hookPending, 7, READ)).toBe(`${hookPending?.id ?? ''}~toolu_read`);
  });
});

describe('ta sama nazwa, inna komenda (treść operacji)', () => {
  const STALE_BASH = jsonl('Bash', { command: 'ls -la ~/Library/Caches' }, 'toolu_old', T0 - 30_000);

  it('wpis jsonl `Bash` X nad dialogiem `Bash` Y, bez hooka → karta bez przycisków', () => {
    degraded(decideCard(input(STALE_READ, STALE_BASH, null)));
  });

  it('wpis jsonl `Bash` X + świeży zrzut `Bash` Y zgodny z ekranem → karta Y', () => {
    const card = permissionCard(decideCard(input(STALE_READ, STALE_BASH, hook('Bash', { command: STALE_READ_CMD }))));
    expect(card.input).toEqual({ command: STALE_READ_CMD });
  });

  it('wpis jsonl z komendą z ekranu → karta jak dotąd (zrzut zgodny nie konkuruje)', () => {
    const pending = jsonl('Bash', { command: STALE_READ_CMD });
    const raw = hook('Bash', { command: STALE_READ_CMD });
    expect(competingHook(pending, raw)).toBe(false);
    const card = permissionCard(decideCard(input(STALE_READ, pending, raw)));
    expect(card.input).toEqual({ command: STALE_READ_CMD });
  });
});

/*
 * Ramka ucięta u góry + nazwa ze stopki `Ask rule Bash(…)`: nazwę widać,
 * więc nie zadziała reguła uciętego nagłówka — ale ramka pokazuje tylko KONIEC komendy, a dwie różne
 * komendy potrafią mieć wspólny koniec.
 */
describe('ucięta ramka z nazwą ze stopki `Ask rule`', () => {
  const tall = screen('measured/zgoda-bash-wysoka-2.1.295.txt').replace(
    ' Shell expansion syntax in paths requires manual approval\n',
    ' Shell expansion syntax in paths requires manual approval\n'
      + ' Ask rule Bash(rm -rf *) overrides auto mode for this command.\n',
  );
  const tail = command('zgoda-bash-wysoka-2.1.295.command.json');
  const safe = `echo safe\n${tail}`;
  const danger = `rm -rf ~/Pictures\n${tail}`;

  it('fixture ma nazwę ze stopki i ramkę uciętą u góry', () => {
    const resolution = resolveOptions(tall, { toolName: 'Bash' });
    expect(resolution.status).toBe('ok');
  });

  it('wpis jsonl X i świeży zrzut Y o wspólnym końcu → karta bez przycisków', () => {
    degraded(decideCard(input(tall, jsonl('Bash', { command: safe }), hook('Bash', { command: danger }))));
  });

  it('sam wpis jsonl bez zrzutu nie wystarcza przy uciętej ramce', () => {
    degraded(decideCard(input(tall, jsonl('Bash', { command: safe }), null)));
  });

  it('wpis jsonl i zrzut z tą samą komendą → karta z przyciskami', () => {
    const card = permissionCard(decideCard(input(
      tall, jsonl('Bash', { command: danger }), hook('Bash', { command: danger }),
    )));
    expect(card.input).toEqual({ command: danger });
  });
});

describe('tożsamość oceny (`evaluationReqId`)', () => {
  it('`Bash` z podwójnym dowodem niesie generację zrzutu — dojście hooka daje nową ocenę', () => {
    const pending = jsonl('Bash', { command: CLIPPED_CMD }, 'toolu_bash');
    const raw = hook('Bash', { command: CLIPPED_CMD });
    expect(evaluationReqId(pending, null, null, 7)).toBe('toolu_bash');
    expect(evaluationReqId(pending, null, raw, 7)).toBe(`toolu_bash~hook:${String(raw.at)}`);
  });

  it('bez źródeł — numer blokady; sam zrzut — jego identyfikator', () => {
    expect(evaluationReqId(null, null, null, 7)).toBe('screen:7');
    const raw = hook('Bash', { command: 'ls' });
    expect(evaluationReqId(null, hookPendingFrom(raw), raw, 7)).toBe(`hook:${String(raw.at)}`);
  });
});

describe('competingHook i hookMatchesScreen', () => {
  const pending = jsonl('Read', { file_path: '/a.png' });

  it('ta sama komenda z inną kolejnością kluczy inputu to TO SAMO wywołanie', () => {
    const bash = jsonl('Bash', { command: STALE_READ_CMD, description: 'Usuń pliki' });
    const raw = hook('Bash', { description: 'Usuń pliki', command: STALE_READ_CMD });
    expect(competingHook(bash, raw)).toBe(false);
    const card = permissionCard(decideCard(input(STALE_READ, bash, raw)));
    expect(card.digits).toEqual(['1', '2']);
  });

  it('konkuruje wyłącznie świeży zrzut `PermissionRequest` innego wywołania', () => {
    expect(competingHook(pending, hook('Bash', { command: 'ls' }))).toBe(true);
    expect(competingHook(pending, hook('Bash', { command: 'ls' }, T0 - 10_000))).toBe(false);
    expect(competingHook(pending, { ...hook('Bash', { command: 'ls' }), hookEventName: 'PreToolUse' })).toBe(false);
    expect(competingHook(pending, hook('AskUserQuestion', { questions: [] }))).toBe(false);
    expect(competingHook({ ...pending, at: '' }, hook('Bash', { command: 'ls' }))).toBe(false);
  });

  it('komenda musi stać W RAMCE dialogu, nie w scrollbacku nad nim', () => {
    // Pierwsza linia komendy z ekranu stoi też w scrollbacku (`⎿ $ T=…`); reszta jest inna.
    const firstLine = STALE_READ_CMD.split(';')[0] ?? '';
    const lookalike = { id: 'hook:1', toolName: 'Bash', input: { command: `${firstLine}; rm -rf ~/x` }, at: '' };
    expect(STALE_READ.includes(firstLine.slice(0, 40))).toBe(true);
    expect(hookMatchesScreen(lookalike, STALE_READ)).toBe(false);
    const real = { ...lookalike, input: { command: STALE_READ_CMD } };
    expect(hookMatchesScreen(real, STALE_READ)).toBe(true);
  });
});
