/**
 * Kształt karty bez decyzji z `decideCard`.
 *
 * A subagent `Bash` consent with its frame clipped at the top must not leave a bare `mismatch` in the log: with the
 * hook dump alone the recognition is computed again with `expected = null`, which would lose the `operation` reason.
 * Tu sprawdzamy, że ocena oddaje kształt z PIERWSZEGO rozpoznania (`diagnosis`) i pochodzenie karty
 * (`origin`), a karta z przyciskami kształtu nie dostaje. Końcowy wpis dziennika sprawdza
 * `herdr-driver.test.ts` („kształt odmowy w dzienniku”). Ekrany przechodzą przez PRAWDZIWY `resolveOptions`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decideCard } from '../src/herdr/dialogs/decide/decide.ts';
import { evaluationReqId, hookPendingFor } from '../src/herdr/dialogs/decide/sources.ts';
import type { DecideAction, DecideInput } from '../src/herdr/dialogs/decide/input.ts';
import { resolveOptions } from '../src/herdr/dialogs/screen/resolve.ts';
import type { PendingTool } from '../src/herdr/jsonl-pending.ts';
import type { PendingHookTool } from '../src/herdr/dialogs/hook/dump.ts';

const DIR = join(import.meta.dirname, 'fixtures', 'herdr');
const screen = (name: string): string => readFileSync(join(DIR, name), 'utf8');
const command = (name: string): string => (
  JSON.parse(readFileSync(join(DIR, name), 'utf8')) as { command: string }).command;

/** Dialog subagenta z całą ramką pod widocznym tytułem `Bash`. */
const SUB = screen('dialog-bash-subagent-naglowek-2.1.302.txt');
const X = command('dialog-bash-subagent-naglowek-2.1.302.command.json');
/** Ten sam dialog od linii z końcem komendy — nagłówek i początek ramki nad krawędzią panelu. */
const CLIPPED = ((): string => {
  const lines = SUB.split('\n');
  return lines.slice(lines.findIndex((line) => line.includes('git -C "$E/repo" log --oneline -1'))).join('\n');
})();
/** Zgoda `Bash` z nagłówkiem nad krawędzią panelu. */
const UCIETY = screen('dialog-bash-uciety-naglowek-2.1.294.txt');
const UCIETY_CMD = command('dialog-bash-uciety-naglowek-2.1.294.command.json');

const HOOK_AT = Date.parse('2026-10-23T10:17:07.234Z');
const PROMPT_ID = '7c1d9e2a-0b3f-4e5d-8a6b-1c2d3e4f5a6b';
const AGENT_ID = 'a7e5ec6c821818fae';

function hook(cmd: string, over: Partial<PendingHookTool> = {}): PendingHookTool {
  return {
    toolName: 'Bash', toolInput: { command: cmd }, at: HOOK_AT, hookEventName: 'PermissionRequest',
    promptId: PROMPT_ID, ...over,
  };
}

function jsonl(toolName: string, input: unknown, id = 'toolu_main'): PendingTool {
  return { id, toolName, input, at: new Date(HOOK_AT - 100).toISOString() };
}

/** Wejście jak w driverze: `hookPending` przepuszczony przez tę samą regułę co driver (`hookPendingFor`). */
function input(text: string | null, pending: PendingTool | null, raw: PendingHookTool | null): DecideInput {
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

function cardOf(action: DecideAction): Extract<DecideAction, { kind: 'card' }> {
  if (action.kind !== 'card') throw new Error(`spodziewano karty, jest ${action.kind}`);
  return action;
}

describe('kształt karty bez decyzji (`diagnosis`)', () => {
  it('sam zrzut hooka subagenta, ramka ucięta → `operation` i `headerVisible: false`, źródłem zrzut', () => {
    const action = decideCard(input(CLIPPED, null, hook(X, { agentId: AGENT_ID })));
    if (action.kind !== 'screen-dialog') throw new Error(`spodziewano karty z ekranu, jest ${action.kind}`);
    expect(action.audit).toBe('mismatch');
    expect(action.diagnosis).toEqual({
      mismatchReason: 'operation', headerVisible: false, optionCount: 2, dialogTitle: null,
    });
    // `PermissionRequest` nie niesie `tool_use_id` — pochodzenie ma turę i subagenta, bez zmyślonego id.
    expect(action.origin).toEqual({ source: 'hook', promptId: PROMPT_ID, agentId: AGENT_ID });
  });

  it('wpis jsonl innego narzędzia niż ekran → `tool-name`, źródłem wpis z jego `tool_use.id`', () => {
    const action = cardOf(decideCard(input(SUB, jsonl('Read', { file_path: '/x/plik.txt' }, 'toolu_read'), null)));
    expect(action.audit).toBe('mismatch');
    expect(action.diagnosis).toEqual({
      mismatchReason: 'tool-name', headerVisible: true, optionCount: 2, dialogTitle: null,
    });
    expect(action.card.active.origin).toEqual({ source: 'jsonl', toolUseId: 'toolu_read' });
  });

  it('ekran bez dialogu i bez źródeł → bez podpowodu, `optionCount: 0`, źródłem ekran', () => {
    const action = decideCard(input('zwykły ogon transkryptu\n', null, null));
    if (action.kind !== 'screen-dialog') throw new Error(`spodziewano karty z ekranu, jest ${action.kind}`);
    expect(action.audit).toBe('unreadable');
    expect(action.diagnosis).toEqual({ mismatchReason: null, headerVisible: null, optionCount: 0, dialogTitle: null });
    expect(action.origin).toEqual({ source: 'screen' });
  });

  it('ekranu nie udało się przeczytać → `optionCount: null` (nie „zero opcji”)', () => {
    const action = decideCard(input(null, null, null));
    if (action.kind !== 'screen-dialog') throw new Error(`spodziewano karty z ekranu, jest ${action.kind}`);
    expect(action.diagnosis).toMatchObject({ optionCount: null, headerVisible: null });
  });
});

describe('pochodzenie karty z przyciskami (`origin`), bez kształtu', () => {
  it('karta z samego zrzutu przy całej ramce → źródłem zrzut, tura i subagent', () => {
    const action = cardOf(decideCard(input(SUB, null, hook(X, { agentId: AGENT_ID }))));
    expect(action.audit).toBeNull();
    expect(action.diagnosis).toBeUndefined();
    expect(action.card.active.origin).toEqual({ source: 'hook', promptId: PROMPT_ID, agentId: AGENT_ID });
  });

  it('wpis jsonl z podwójnym dowodem `Bash` → źródłem wpis, tura ze zrzutu tego samego wywołania', () => {
    const action = cardOf(decideCard(input(UCIETY, jsonl('Bash', { command: UCIETY_CMD }, 'toolu_bash'), hook(UCIETY_CMD))));
    expect(action.audit).toBeNull();
    expect(action.card.active.origin).toEqual({ source: 'jsonl', toolUseId: 'toolu_bash', promptId: PROMPT_ID });
  });

  it('dialog z zamkniętej listy (`model`, `trust`) przy stęchłym zrzucie `Bash` → źródłem ekran', () => {
    for (const name of ['dialog-model-switch.txt', 'dialog-trust.txt']) {
      const action = decideCard(input(screen(name), null, hook(X, { agentId: AGENT_ID })));
      if (action.kind !== 'screen-dialog') throw new Error(`${name}: spodziewano karty z ekranu, jest ${action.kind}`);
      expect(action.resolved?.knownDialog, name).not.toBeNull();
      expect(action.audit, name).toBeNull();
      expect(action.diagnosis, name).toBeUndefined();
      // Zatwierdzenie tego dialogu nie może dostać tury ani subagenta stęchłego zrzutu.
      expect(action.origin, name).toEqual({ source: 'screen' });
    }
  });

  it('wpis jsonl bez podwójnego dowodu (zrzut innej komendy) → tura zrzutu NIE trafia do wpisu', () => {
    const action = cardOf(decideCard(input(UCIETY, jsonl('Bash', { command: UCIETY_CMD }, 'toolu_bash'), hook('ls -la'))));
    expect(action.card.active.origin).toEqual({ source: 'jsonl', toolUseId: 'toolu_bash' });
  });
});
