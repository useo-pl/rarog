/**
 * A `Bash` + `PermissionRequest` dump lives 60 minutes, after the tenth only with proof from the screen.
 *
 * A subagent consent can wait in the CLI queue (“2 of 2”) behind a main-thread dialog for more than 10 minutes, and
 * the `PermissionRequest` hook fires once, when the CLI decides to ask. A reader that dropped such a dump after
 * 10 minutes would give a card without buttons next to the open main-thread tool (`mismatch` / `operation`, route
 * `permission-no-dump`). Rule: after 10 minutes the dump enters the evaluation only when the block title is `Bash`,
 * the whole operation frame stands under a visible header and equals the WHOLE command of the dump
 * (`bashFrameProven`, the same rule as for a dump older than the jsonl entry). A clipped frame, another command,
 * another tool and `PreToolUse` keep the 10-minute limit. Dumps go through the REAL reader and reaper, screens
 * through the real `resolveOptions`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decideCard } from '../src/herdr/dialogs/decide/decide.ts';
import {
  admittedHook, evaluationReqId, hookPendingFor, staleDumpProvesOther,
} from '../src/herdr/dialogs/decide/sources.ts';
import type { DecideAction, DecideInput } from '../src/herdr/dialogs/decide/input.ts';
import type { ActiveReq } from '../src/herdr/dialogs/cards/build.ts';
import { readPendingHook, sweepPendingHooks } from '../src/herdr/dialogs/hook/dump.ts';
import type { PendingHookTool } from '../src/herdr/dialogs/hook/dump.ts';
import { parseOptions } from '../src/herdr/dialogs/screen/parse.ts';
import { queuedTitleToolOnScreen } from '../src/herdr/dialogs/screen/queue.ts';
import { resolveOptions } from '../src/herdr/dialogs/screen/resolve.ts';
import type { PendingTool } from '../src/herdr/jsonl-pending.ts';

const DIR = join(import.meta.dirname, 'fixtures', 'herdr');
const screen = (name: string): string => readFileSync(join(DIR, name), 'utf8');
const command = (name: string): string => (
  JSON.parse(readFileSync(join(DIR, name), 'utf8')) as { command: string }).command;

/** Dialog subagenta: cała ramka pod tytułem „Bash command · from the general-purpose agent”. */
const SUB = screen('dialog-bash-subagent-naglowek-2.1.302.txt');
const X = command('dialog-bash-subagent-naglowek-2.1.302.command.json');
const TITLE = 'Bash command · from the general-purpose agent';
/** Ten sam dialog z licznikiem kolejki na końcu linii tytułu (kształt licznika: `SCREEN_SIGNATURES.queueCounter`). */
const QUEUED = SUB.replace(TITLE, `${TITLE}${' '.repeat(30)}2 of 2`);
/** Cały dialog `Bash` innej komendy — ramka pełna, komenda nie ta. */
const WIDE = screen('dialog-bash-stechly-read-szeroki-2.1.295.txt');

const SESSION = '550e8400-e29b-41d4-a716-446655440000';
const MIN = 60_000;
/** Zrzut dialogu subagenta; otwarte narzędzie wątku głównego 5 s wcześniej (konkurent) albo 13 s później (starszy). */
const HOOK_AT = Date.parse('2026-10-15T11:22:28.142Z');
const HOOK_ID = `hook:${String(HOOK_AT)}`;
const MAIN_CMD = 'pnpm test';

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'rarog-zrzut-bash-60-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

/** Kładzie zrzut tak, jak pisze go hook (`<dataDir>/pending/<sesja>.json`). */
function put(body: Record<string, unknown>): string {
  const dir = join(dataDir, 'pending');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${SESSION}.json`);
  writeFileSync(path, JSON.stringify({ sessionId: SESSION, at: HOOK_AT, ...body }));
  return path;
}

/** Zrzut `PermissionRequest` subagenta z komendą `cmd`, przeczytany prawdziwym czytnikiem `age` ms po zapisie. */
function dumpAfter(
  age: number, cmd = X, toolName = 'Bash', hookEventName = 'PermissionRequest',
): PendingHookTool | null {
  put({ toolName, toolInput: { command: cmd }, hookEventName, agentId: 'a0b1c2d3e4f5a6b7c' });
  return readPendingHook(dataDir, SESSION, () => HOOK_AT + age);
}

function jsonl(cmd: string, at: number, id = 'toolu_main', toolName = 'Bash'): PendingTool {
  return { id, toolName, input: { command: cmd }, at: new Date(at).toISOString() };
}

/** Wejście jak w driverze: `hookPending` i tożsamość z tego samego odczytu zrzutu. */
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

function card(action: DecideAction): Extract<DecideAction, { kind: 'card' }> {
  expect(action.kind).toBe('card');
  if (action.kind !== 'card') throw new Error('brak karty');
  return action;
}

/** Karta zgody z przyciskami: treść ze źródła, cyfry z ekranu. */
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

/** Ekran od pierwszej linii z `marker` — reszta powyżej jest „nad krawędzią panelu”. */
function from(text: string, marker: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.includes(marker));
  if (start === -1) throw new Error(`brak linii z „${marker}”`);
  return lines.slice(start).join('\n');
}

/** Ramka ucięta u góry: widać koniec komendy X, tytułu i górnej kreski ramki nie widać. */
const CLIPPED = from(SUB, 'git -C "$E/repo" log --oneline -1');

describe('czytnik: zrzut `Bash` + `PermissionRequest` do 60 minut, po dziesiątej ze znacznikiem `stale`', () => {
  it('po 16 min wraca jako `stale`; po 9 min bez znacznika; po 61 min i z przyszłości nie wraca', () => {
    expect(dumpAfter(16 * MIN)).toMatchObject({
      toolName: 'Bash', toolInput: { command: X }, at: HOOK_AT, stale: true,
    });
    expect(dumpAfter(9 * MIN)).not.toHaveProperty('stale');
    expect(dumpAfter(61 * MIN)).toBeNull();
    expect(dumpAfter(-1)).toBeNull();
  });

  it('`Edit`, `Write` i `PreToolUse` po 16 min nie wracają — zostają przy 10 minutach', () => {
    put({ toolName: 'Edit', toolInput: { file_path: '/repo/a.ts' }, hookEventName: 'PermissionRequest' });
    expect(readPendingHook(dataDir, SESSION, () => HOOK_AT + 16 * MIN)).toBeNull();
    put({ toolName: 'Write', toolInput: { file_path: '/repo/a.ts' }, hookEventName: 'PermissionRequest' });
    expect(readPendingHook(dataDir, SESSION, () => HOOK_AT + 16 * MIN)).toBeNull();
    expect(dumpAfter(16 * MIN, X, 'Bash', 'PreToolUse')).toBeNull();
    // Zrzut sprzed pola `hookEventName` nie dowodzi, że CLI postanowiło zapytać.
    put({ toolName: 'Bash', toolInput: { command: X } });
    expect(readPendingHook(dataDir, SESSION, () => HOOK_AT + 16 * MIN)).toBeNull();
  });

  it('`stale` stawia czytnik z wieku zrzutu, nie plik', () => {
    put({ toolName: 'Bash', toolInput: { command: X }, hookEventName: 'PermissionRequest', stale: true });
    expect(readPendingHook(dataDir, SESSION, () => HOOK_AT + MIN)).not.toHaveProperty('stale');
  });
});

describe('żniwiarz: zrzut `Bash` + `PermissionRequest` zostaje do 60 minut', () => {
  const postarz = (path: string, age: number): string => {
    const when = new Date(Date.now() - age);
    utimesSync(path, when, when);
    return path;
  };

  it('zostawia go po 16 min, kasuje po 61 min; `Write` kasuje po 11 min', () => {
    const bash = postarz(put({
      toolName: 'Bash', toolInput: { command: X }, hookEventName: 'PermissionRequest',
    }), 16 * MIN);
    expect(sweepPendingHooks(dataDir)).toBe(0);
    expect(existsSync(bash)).toBe(true);

    postarz(bash, 61 * MIN);
    expect(sweepPendingHooks(dataDir)).toBe(1);
    expect(existsSync(bash)).toBe(false);

    const write = postarz(put({
      toolName: 'Write', toolInput: { file_path: '/repo/a.ts' }, hookEventName: 'PermissionRequest',
    }), 11 * MIN);
    expect(sweepPendingHooks(dataDir)).toBe(1);
    expect(existsSync(write)).toBe(false);
  });
});

describe('zgoda subagenta po 16 min w kolejce, obok otwartego narzędzia wątku głównego', () => {
  it('(a) wpis wątku głównego starszy od zrzutu: karta z przyciskami, treść i dowód ze zrzutu', () => {
    const pending = jsonl(MAIN_CMD, HOOK_AT - 5_000);
    const { input: cardInput, active } = buttons(decideCard(input(SUB, pending, dumpAfter(16 * MIN))));
    expect(cardInput).toEqual({ command: X });
    // Tożsamość samego zrzutu, który wygrał z wpisem na ekranie, jak przy wpisie młodszym niżej.
    expect(active.reqId).toBe(HOOK_ID);
    expect(active.proofHookAt).toBe(HOOK_AT);
    expect(active.bodyPrint).toBe(parseOptions(SUB)?.bodyPrint);
  });

  it('(a) wpis wątku głównego młodszy od zrzutu: karta z przyciskami z samego zrzutu', () => {
    const pending = jsonl(MAIN_CMD, HOOK_AT + 13_000);
    const { input: cardInput, active } = buttons(decideCard(input(SUB, pending, dumpAfter(16 * MIN))));
    expect(cardInput).toEqual({ command: X });
    expect(active.reqId).toBe(HOOK_ID);
    expect(active.proofHookAt).toBe(HOOK_AT);
  });

  it('(b) to samo z licznikiem „2 of 2” w linii tytułu: karta z przyciskami', () => {
    // Licznik psuje dopasowanie tytułu, więc blok ma tożsamość z `Ask rule`; tytuł spod licznika to `Bash`.
    expect(parseOptions(QUEUED)).toMatchObject({ identity: { kind: 'ask-rule', tool: 'Bash' } });
    for (const at of [HOOK_AT - 5_000, HOOK_AT + 13_000]) {
      const { input: cardInput } = buttons(decideCard(input(QUEUED, jsonl(MAIN_CMD, at), dumpAfter(16 * MIN))));
      expect(cardInput).toEqual({ command: X });
    }
  });

  it('(c) ramka ucięta u góry po 16 min: bez przycisków', () => {
    for (const at of [HOOK_AT - 5_000, HOOK_AT + 13_000]) {
      degraded(decideCard(input(CLIPPED, jsonl(MAIN_CMD, at), dumpAfter(16 * MIN))));
    }
  });

  it('(c) ramka ucięta i podwójny dowód wątku głównego: po 10 min zrzut `stale` nie wystarcza', () => {
    // Wpis i zrzut z tą samą komendą X — przed dziesiątą minutą ramkę uciętą dowodzą dwa źródła naraz.
    const pending = jsonl(X, HOOK_AT - 100);
    buttons(decideCard(input(CLIPPED, pending, dumpAfter(9 * MIN))));
    // Surowy zrzut `stale` podany wprost do oceny (bez czytnika): dowodu z ekranu nie ma, więc karty też nie.
    const stale: PendingHookTool = {
      toolName: 'Bash', toolInput: { command: X }, at: HOOK_AT, hookEventName: 'PermissionRequest', stale: true,
    };
    degraded(decideCard(input(CLIPPED, pending, stale)));
  });

  it('(c) licznik kolejki przy tytule spoza mapy nie zastępuje tytułu `Bash`', () => {
    const renamed = QUEUED.replace(TITLE, 'Shell command · from the general-purpose agent');
    expect(parseOptions(renamed)).toMatchObject({ identity: { kind: 'ask-rule', tool: 'Bash' } });
    degraded(decideCard(input(renamed, jsonl(MAIN_CMD, HOOK_AT - 5_000), dumpAfter(16 * MIN))));
  });

  /*
   * Strażnik reguły 60 minut: tytuł `Bash` z licznikiem kolejki liczy się WYŁĄCZNIE w linii tytułu ocenianego bloku.
   * Ten sam napis w opisie dialogu albo w sąsiednim bloku nad nim nie zastępuje tytułu spoza mapy.
   */
  it('(c) tytuł `Bash` z licznikiem w opisie albo w sąsiednim bloku: zrzut sprzed 16 min odrzucony', () => {
    const shell = SUB.replace(TITLE, 'Shell command · from the general-purpose agent');
    const counted = `${TITLE}${' '.repeat(20)}2 of 2`;
    const inDescription = shell.replace('Build an e2e fixture clone with a dry-run release:run', counted);
    const lines = shell.split('\n');
    const rule = lines.findIndex((line) => line.startsWith('───'));
    const neighbour = [
      ...lines.slice(0, rule + 1), ` ${counted}`, ' Do you want to proceed?', '', ...lines.slice(rule),
    ].join('\n');
    for (const text of [inDescription, neighbour]) {
      expect(text).toContain(counted);
      expect(parseOptions(text)).toMatchObject({ identity: { kind: 'ask-rule', tool: 'Bash' } });
      expect(queuedTitleToolOnScreen(text)).toBeNull();
      const stale = dumpAfter(16 * MIN);
      expect(admittedHook(stale, text, resolveOptions)).toBeNull();
      degraded(decideCard(input(text, jsonl(MAIN_CMD, HOOK_AT - 5_000), stale)));
    }
  });

  it('(d) cała ramka, ale komenda zrzutu inna niż ramka: bez przycisków', () => {
    degraded(decideCard(input(SUB, jsonl(MAIN_CMD, HOOK_AT - 5_000), dumpAfter(16 * MIN, `${X} --inna`))));
    degraded(decideCard(input(WIDE, jsonl(MAIN_CMD, HOOK_AT - 5_000), dumpAfter(16 * MIN))));
  });

  it('(e) zrzut sprzed 9 min: limit 10 minut — cała ramka z przyciskami, ramka ucięta bez', () => {
    buttons(decideCard(input(SUB, jsonl(MAIN_CMD, HOOK_AT + 13_000), dumpAfter(9 * MIN))));
    degraded(decideCard(input(CLIPPED, jsonl(MAIN_CMD, HOOK_AT + 13_000), dumpAfter(9 * MIN))));
  });
});

/*
 * Decyzja przy biurku na dialogu przed zgodą subagenta w kolejce: blokada, wpis i zrzut stoją, więc tożsamość oceny
 * się nie zmienia. Zrzut `stale` z dowodem z ekranu innej komendy niż komenda stojącej karty przepuszcza ocenę
 * przez bramkę „ta sama karta” (`staleDumpProvesOther`); świeży zrzut i zrzut bez dowodu jej nie przepuszczają.
 */
describe('zrzut `stale` z dowodem innej komendy niż stojąca karta przechodzi bramkę „ta sama karta”', () => {
  /** Stojąca karta: źródło z komendą `cmd` (`undefined` = karta bez źródła `Bash`). */
  function standing(cmd: string | undefined): ActiveReq {
    const { active } = buttons(decideCard(input(SUB, jsonl(MAIN_CMD, HOOK_AT - 5_000), dumpAfter(16 * MIN))));
    const { command: _command, ...rest } = active;
    return cmd === undefined ? rest : { ...rest, command: cmd };
  }

  it('zrzut sprzed 16 min z dowodem całej ramki, karta innej komendy albo bez źródła `Bash` → przechodzi', () => {
    const admitted = admittedHook(dumpAfter(16 * MIN), QUEUED, resolveOptions);
    expect(admitted?.stale).toBe(true);
    expect(staleDumpProvesOther(admitted, standing(MAIN_CMD))).toBe(true);
    expect(staleDumpProvesOther(admitted, standing(undefined))).toBe(true);
  });

  it('karta tej samej komendy, brak karty, zrzut świeży i zrzut bez dowodu → bramka zostaje', () => {
    expect(staleDumpProvesOther(admittedHook(dumpAfter(16 * MIN), SUB, resolveOptions), standing(X))).toBe(false);
    expect(staleDumpProvesOther(admittedHook(dumpAfter(16 * MIN), SUB, resolveOptions), null)).toBe(false);
    expect(staleDumpProvesOther(admittedHook(dumpAfter(9 * MIN), SUB, resolveOptions), standing(MAIN_CMD)))
      .toBe(false);
    expect(admittedHook(dumpAfter(16 * MIN), CLIPPED, resolveOptions)).toBeNull();
    expect(staleDumpProvesOther(admittedHook(dumpAfter(16 * MIN), CLIPPED, resolveOptions), standing(MAIN_CMD)))
      .toBe(false);
  });
});
