/**
 * Zrzuty z pomiaru ultracode na żywym CLI 2.1.317 (`fixtures/herdr/ultracode/*.txt`, sesja z `--effort ultracode`):
 * etykieta `ultracode` w kresce pola promptu i dialog zgody przy włączonym ultracode nie zmieniają tego, co serwer
 * czyta z ekranu.
 *
 * - Pole promptu: kreska nad polem niesie etykietę (`──── ultracode ─`), a po `/rename` nazwę sesji zamiast etykiety.
 *   Odczyt pola (`composerRegionState`, bramka restartu i wysyłki) widzi puste pole na każdym zrzucie bez dialogu.
 * - Dialog zgody na `Bash`: kreska nad dialogiem jest goła, więc decyzja bez jsonl i bez hooka wystawia tę samą
 *   kartę zgody co bez ultracode (`measured/zgoda-bash-2.1.293.txt`): to samo zdarzenie, narzędzie i cyfry przycisków.
 * - Suwak `/effort` otwarty, póki wskaźnik effortu stoi (`kontrolny/picker-effort-ultracode-status-2.1.318.txt`,
 *   CLI 2.1.318): kreska nad blokiem kończy się statusem ze słowem `ultracode`, a góra bloku to ta kreska.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { composerRegionState } from '../src/drivers/herdr/commands.ts';
import { decideCard } from '../src/herdr/dialogs/decide/decide.ts';
import type { DecideInput } from '../src/herdr/dialogs/decide/input.ts';
import { evaluationReqId } from '../src/herdr/dialogs/decide/sources.ts';
import { blockTopOf } from '../src/herdr/dialogs/screen/region.ts';
import { resolveOptions } from '../src/herdr/dialogs/screen/resolve.ts';
import { SCREEN_SIGNATURES } from '../src/herdr/dialogs/screen/signatures.ts';
import { snippet } from '../src/herdr/dialogs/screen/snippet.ts';

const DIR = join(import.meta.dirname, 'fixtures', 'herdr');
const screenOf = (name: string): string => readFileSync(join(DIR, name), 'utf8');
const lines = (name: string): string[] => screenOf(name).split('\n').map((line) => line.trimEnd());

/** Wejście decyzji bez jsonl i bez hooka, jak w pliku złotym kart korpusu. */
function input(text: string): DecideInput {
  return {
    pending: null, hookPending: null, text, reqId: evaluationReqId(null, null, null, 1), active: null, blockedSeq: 1,
    answeredSeq: -1, hookAnswersEnabled: true, deadAnswerKey: null, canRetry: false, answeredHookCall: null,
    decided: null, resolve: resolveOptions, excerpt: (value: string) => snippet(value)?.text ?? null, hookRaw: null,
  };
}

/** Karta z przyciskami, którą decyzja wystawia nad ekranem: zdarzenie, narzędzie i cyfry. */
function cardOf(name: string): { event: string; tool: string | null; digits: string[] } {
  const action = decideCard(input(screenOf(name)));
  if (action.kind !== 'card') throw new Error(`${name}: ocena bez karty z przyciskami (${action.kind})`);
  return {
    event: action.card.event.type,
    tool: action.card.active.toolName ?? null,
    digits: action.card.active.options.filter((option) => option.terminalOnly !== true).map((option) => option.digit),
  };
}

const IDLE = [
  'ultracode/start-ultracode-2.1.317.txt',
  'ultracode/wynik-effort-ultracode-2.1.317.txt',
  'ultracode/wynik-effort-ultracode-off-2.1.317.txt',
  'ultracode/rename-ultracode-2.1.317.txt',
  'ultracode/start-ultracode-niedostepny-2.1.317.txt',
];

describe('pole promptu przy ultracode', () => {
  it.each(IDLE)('%s: odczyt pola widzi puste pole', (name) => {
    expect(composerRegionState(screenOf(name))).toBe('empty');
  });

  it('etykieta `ultracode` stoi w kresce nad polem, a kreska pasuje do sygnatury ramki pola', () => {
    for (const name of IDLE.slice(0, 2)) {
      const rule = lines(name).findLast((line) => / ultracode ─$/.test(line));
      expect(rule, name).toMatch(/^─{4,} ultracode ─$/);
      expect(SCREEN_SIGNATURES.composerRule.pattern.test(rule ?? ''), name).toBe(true);
    }
  });

  it('po `/rename` kreska niesie nazwę sesji zamiast etykiety; przy niedostępnym ultracode etykiety nie ma', () => {
    expect(lines('ultracode/rename-ultracode-2.1.317.txt').some((line) => /^─{4,} pomiar-nazwy ─$/.test(line)))
      .toBe(true);
    const noLabel = ['ultracode/rename-ultracode-2.1.317.txt', 'ultracode/start-ultracode-niedostepny-2.1.317.txt'];
    for (const name of noLabel) {
      expect(lines(name).filter((line) => /^─{4,} ultracode ─$/.test(line)), name).toEqual([]);
    }
  });
});

describe('dialog zgody przy ultracode', () => {
  it('goła kreska nad dialogiem: ta sama karta zgody co bez ultracode', () => {
    const card = cardOf('ultracode/zgoda-bash-ultracode-2.1.317.txt');
    const reference = cardOf('measured/zgoda-bash-2.1.293.txt');
    expect(card).toEqual(reference);
    expect(card.digits.length).toBeGreaterThan(0);
  });
});

describe('kreska ze statusem ultracode nad blokiem', () => {
  const PICKER = 'kontrolny/picker-effort-ultracode-status-2.1.318.txt';

  it('status `◉ xhigh · ultracode · /effort` pasuje do `blockRuleWithStatus`, a góra bloku suwaka to ta kreska', () => {
    const screen = lines(PICKER);
    const rule = screen.findIndex((line) => / ultracode · \/effort ▔$/.test(line));
    expect(screen[rule]).toMatch(/^▔{8,} ◉ xhigh · ultracode · \/effort ▔$/);
    expect(SCREEN_SIGNATURES.blockRuleWithStatus.pattern.test(screen[rule] ?? '')).toBe(true);
    expect(blockTopOf(screen, screen.findLastIndex((line) => line.trim() === 'Effort')))
      .toEqual({ line: rule, kind: 'status' });
  });
});
