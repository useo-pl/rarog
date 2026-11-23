/**
 * NOTATKI do odpowiedzi na pytanie z podglądem.
 *
 * W terminalu przy pytaniu z podglądem można wcisnąć `n` i dopisać uwagę do wybranej opcji
 * („n to add notes” w `measured/pytanie-preview-2.1.293.txt`, CLI 2.1.293). Pomiar na CLI 2.1.288
 * i 2.1.293: hook `PermissionRequest` oddaje to samo w polu `annotations`, CLI je przyjmuje,
 * a `tool_result` niesie `selected preview` i `notes`; starszych wydań nie mierzono, więc 2.1.288 to próg
 * Raroga. Telefon dostaje to samo pole — pod trzema warunkami, które liczy SERWER: kanał hooka,
 * jednokrotny wybór z podglądem, CLI ≥ 2.1.288.
 *
 * Co tu jest do udowodnienia (logika; proces hooka i driver mają własne testy):
 * - próg wersji i reguła „które pytanie przyjmuje notatkę" (pole `notes` na karcie);
 * - reguły ciała w managerze: notatka tylko przy jednej opcji z listy, sufity Raroga (w CLI niezmierzone);
 * - adres notatki w driverze: ORYGINAŁ podglądu wybranej opcji z payloadu, nie kopia z karty;
 * - plik odpowiedzi niesie `annotations` tylko wtedy, gdy są; dziennik — samą liczbę notatek.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HerdrStatus, Question, QuestionRequest } from '@rarog/shared';
import { MAX_ANSWER_NOTE_CHARS, MAX_ANSWERS_TOTAL_CHARS } from '@rarog/shared/rest';
import {
  CLI_NOTES_MIN_VERSION, checkAnswerNotes, cliAcceptsNotes, notesEligible, withQuestionNotes,
} from '../src/sessions/question-card.ts';
import { createManager } from '../src/sessions/manager.ts';
import type { HerdrManagerDeps, Manager } from '../src/sessions/manager.ts';
import { hookQuestionFrom } from '../src/herdr/dialogs/cross-check.ts';
import { hookAnnotations, hookAnswerTargetFor } from '../src/herdr/dialogs/hook/target.ts';
import { writeHookAnswer } from '../src/herdr/dialogs/hook/answers.ts';
import { createHerdrAuditLog, herdrAuditPath } from '../src/herdr/audit.ts';
import { ASK_USER_QUESTION_TOOL } from '../src/herdr/dialogs/screen/resolve.ts';
import type { PendingTool } from '../src/herdr/jsonl-pending.ts';
import type { PendingHookTool } from '../src/herdr/dialogs/hook/dump.ts';
import type { CliRegistry } from '../src/cli-version.ts';
import type { DecisionOutcome } from '../src/drivers/types.ts';
import { APPLIED } from '../src/drivers/types.ts';
import { AtrapaDrivera, AtrapaNadzorcy } from './helpers/atrapa-sesji.ts';

const PODGLAD = '+--------+\n| lista  |\n+--------+';

/** Pytanie z podglądem — jednokrotne, jak w pomiarze `pytanie-preview-2.1.293`. */
const Z_PODGLADEM: Question = {
  question: 'Jaki układ listy?', header: 'Układ', multiSelect: false,
  options: [
    { label: 'Jedna kolumna', preview: PODGLAD, role: 'answer' },
    { label: 'Bez listy', role: 'answer' },
    { label: 'Zawsze pozwalaj', terminalOnly: true, role: 'answer' },
  ],
};
const BEZ_PODGLADU: Question = {
  question: 'Jaki kubek?', header: 'Kubek', multiSelect: false,
  options: [{ label: 'Mały', role: 'answer' }, { label: 'Duży', role: 'answer' }],
};

function card(questions: Question[]): QuestionRequest {
  return {
    qId: 'hook:1:abc', sessionId: 's1', createdAt: '2026-10-08T10:00:00.000Z', channel: 'hook',
    customAnswer: true, questions: withQuestionNotes(questions, true),
  };
}

describe('próg wersji i pytania z polem notatki', () => {
  it('notatki dopiero od 2.1.288 — wydanie nieznane to „nie" (fail-closed)', () => {
    expect(CLI_NOTES_MIN_VERSION).toBe('2.1.288');
    expect(cliAcceptsNotes(undefined)).toBe(false);
    expect(cliAcceptsNotes('2.1.286')).toBe(false);
    expect(cliAcceptsNotes('2.1.287')).toBe(false);
    expect(cliAcceptsNotes('2.1.288')).toBe(true);
    expect(cliAcceptsNotes('2.1.293')).toBe(true);
    expect(cliAcceptsNotes('2.2.0')).toBe(true);
  });

  it('notatkę przyjmuje wyłącznie pytanie JEDNOKROTNE z podglądem', () => {
    expect(notesEligible(Z_PODGLADEM)).toBe(true);
    expect(notesEligible(BEZ_PODGLADU)).toBe(false);
    expect(notesEligible({ ...Z_PODGLADEM, multiSelect: true })).toBe(false);
  });

  it('`withQuestionNotes` stawia pole tylko tam, gdzie wolno, i tylko przy `enabled`', () => {
    const on = withQuestionNotes([Z_PODGLADEM, BEZ_PODGLADU], true);
    expect(on.map((question) => question.notes)).toEqual([true, undefined]);
    const off = withQuestionNotes([Z_PODGLADEM, BEZ_PODGLADU], false);
    expect(off.map((question) => question.notes)).toEqual([undefined, undefined]);
  });
});

describe('reguły ciała odpowiedzi z notatkami (manager → 400)', () => {
  const request = card([Z_PODGLADEM, BEZ_PODGLADU]);

  it('brak notatek, puste i z samych spacji = odpowiedź bez notatek', () => {
    expect(checkAnswerNotes(request, [['Jedna kolumna'], ['Mały']], undefined)).toEqual({ notes: null });
    expect(checkAnswerNotes(request, [['Jedna kolumna'], ['Mały']], ['  ', null])).toEqual({ notes: null });
  });

  it('notatka do opcji z listy przechodzi, równolegle do odpowiedzi', () => {
    expect(checkAnswerNotes(request, [['Jedna kolumna'], ['Mały']], ['bez paska']))
      .toEqual({ notes: ['bez paska', null] });
    // Opcja bez własnego podglądu też — notatka dotyczy wyboru, nie podglądu.
    expect(checkAnswerNotes(request, [['Bez listy'], ['Mały']], ['na razie']))
      .toEqual({ notes: ['na razie', null] });
  });

  it('pytanie bez `notes`, wolny tekst, opcja tylko-w-terminalu i wielokrotny wybór → 400', () => {
    expect(checkAnswerNotes(request, [['Jedna kolumna'], ['Mały']], [null, 'x'])).toHaveProperty('error');
    expect(checkAnswerNotes(request, [['coś swojego'], ['Mały']], ['x'])).toHaveProperty('error');
    expect(checkAnswerNotes(request, [['Zawsze pozwalaj'], ['Mały']], ['x'])).toHaveProperty('error');
    expect(checkAnswerNotes(request, [['Jedna kolumna', 'Bez listy'], ['Mały']], ['x']))
      .toHaveProperty('error');
    expect(checkAnswerNotes(request, [['Jedna kolumna']], ['x', null])).toHaveProperty('error');
  });

  it('sufity Raroga (w CLI niezmierzone): notatka ≤ 8192, odpowiedzi razem z notatkami ≤ 32768', () => {
    const long = 'n'.repeat(MAX_ANSWER_NOTE_CHARS);
    expect(checkAnswerNotes(request, [['Jedna kolumna'], ['Mały']], [long])).toEqual({ notes: [long, null] });
    expect(checkAnswerNotes(request, [['Jedna kolumna'], ['Mały']], [`${long}n`])).toHaveProperty('error');
    const five = card([0, 1, 2, 3, 4].map((i) => ({ ...Z_PODGLADEM, question: `P${String(i)}?` })));
    const notes = [0, 1, 2, 3, 4].map(() => 'n'.repeat(7000));
    expect(5 * 7000).toBeGreaterThan(MAX_ANSWERS_TOTAL_CHARS);
    expect(checkAnswerNotes(five, five.questions.map(() => ['Jedna kolumna']), notes)).toHaveProperty('error');
  });

  it('bez karty (pytanie rozstrzygnięte) notatek nie ocenia — 409/410 da `resolveQuestion`', () => {
    expect(checkAnswerNotes(undefined, [['coś']], ['x'])).toEqual({ notes: ['x'] });
  });
});

describe('adres notatki w driverze: ORYGINAŁ podglądu z payloadu', () => {
  const SCREEN = readFileSync(
    join(import.meta.dirname, 'fixtures', 'herdr', 'measured', 'pytanie-preview-2.1.293.txt'), 'utf8',
  );
  const LONG = `${'| lista |\n'.repeat(800)}+-------+`;
  const INPUT = {
    questions: [{
      question: 'Jaki uklad listy?', header: 'Uklad listy', multiSelect: false,
      options: [
        { label: 'Dwie kolumny obok siebie z podgladem (Rekomendowane)', preview: LONG },
        { label: 'Jedna kolumna', preview: PODGLAD },
        { label: 'Bez listy' },
      ],
    }],
  };
  const hook: PendingHookTool = {
    toolName: ASK_USER_QUESTION_TOOL, toolInput: INPUT, at: 21,
    hookEventName: 'PermissionRequest', answerKey: 'klucz',
  } as unknown as PendingHookTool;
  const pending: PendingTool = { id: 'hook:21', toolName: ASK_USER_QUESTION_TOOL, input: INPUT, at: '' };

  function target() {
    const question = hookQuestionFrom(pending, SCREEN);
    if (question === null) throw new Error('zrzut nie pasuje do ekranu');
    const out = hookAnswerTargetFor(hook, question);
    if (out === null) throw new Error('brak adresu kanału');
    return out;
  }

  it('mapa etykieta → podgląd niesie podgląd w CAŁOŚCI (oryginał z payloadu, nie kopia z karty)', () => {
    const notable = target().notable[0];
    expect(notable?.get('Dwie kolumny obok siebie z podgladem (Rekomendowane)')).toBe(LONG);
    expect(notable?.get('Bez listy')).toBeNull();
  });

  it('`hookAnnotations`: notatka + oryginał podglądu; opcja bez podglądu — sama notatka', () => {
    expect(hookAnnotations(target(), [['Jedna kolumna']], ['bez paska'])).toEqual({
      'Jaki uklad listy?': { notes: 'bez paska', preview: PODGLAD },
    });
    expect(hookAnnotations(target(), [['Bez listy']], ['na razie'])).toEqual({
      'Jaki uklad listy?': { notes: 'na razie' },
    });
    expect(hookAnnotations(target(), [['Jedna kolumna']], ['  '])).toEqual({});
  });

  it('notatki nie da się przypiąć: wolny tekst, dwie wartości, pytanie bez podglądu → `null`', () => {
    expect(hookAnnotations(target(), [['coś swojego']], ['x'])).toBeNull();
    expect(hookAnnotations(target(), [['Jedna kolumna', 'Bez listy']], ['x'])).toBeNull();
    const plain = { ...target(), notable: [null] };
    expect(hookAnnotations(plain, [['Jedna kolumna']], ['x'])).toBeNull();
  });

  it('pytanie „__proto__" to zwykły klucz notatki, nie prototyp', () => {
    const proto = {
      ...target(), questions: ['__proto__'],
      notable: [new Map<string, string | null>([['A', 'podgląd A']])],
    };
    const out = hookAnnotations(proto, [['A']], ['uwaga']);
    expect(Object.keys(out ?? {})).toEqual(['__proto__']);
    expect(JSON.stringify(out)).toBe('{"__proto__":{"notes":"uwaga","preview":"podgląd A"}}');
  });

  it('wielokrotny wybór nie przyjmuje notatki nawet z podglądem', () => {
    const multi = { questions: [{ ...INPUT.questions[0], multiSelect: true }] };
    const question = hookQuestionFrom({ ...pending, input: multi }, SCREEN);
    if (question === null) throw new Error('zrzut nie pasuje do ekranu');
    expect(hookAnswerTargetFor({ ...hook, toolInput: multi } as PendingHookTool, question)?.notable)
      .toEqual([null]);
  });
});

describe('plik odpowiedzi i dziennik', () => {
  let dataDir: string;
  beforeEach(async () => { dataDir = await mkdtemp(join(tmpdir(), 'rarog-notatki-')); });
  afterEach(async () => { await rm(dataDir, { recursive: true, force: true }); });

  it('plik niesie `annotations` tylko wtedy, gdy są (bez nich — dawny kształt)', async () => {
    const SESSION = '4b7f0d2e-9c61-4a3b-8e15-2d9f6c0a7b31';
    const noted = writeHookAnswer(dataDir, SESSION, 'k1', { 'Q?': 'A' }, () => 5, {
      'Q?': { notes: 'uwaga', preview: PODGLAD },
    });
    expect(JSON.parse(await readFile(noted as string, 'utf8'))).toEqual({
      sessionId: SESSION, key: 'k1', at: 5, answers: { 'Q?': 'A' },
      annotations: { 'Q?': { notes: 'uwaga', preview: PODGLAD } },
    });
    const plain = writeHookAnswer(dataDir, SESSION, 'k2', { 'Q?': 'A' }, () => 5, {});
    expect(Object.keys(JSON.parse(await readFile(plain as string, 'utf8')) as object).sort())
      .toEqual(['answers', 'at', 'key', 'sessionId']);
  });

  it('dziennik `answer-hook` niesie LICZBĘ notatek, nigdy ich treść', async () => {
    const log = createHerdrAuditLog({ dataDir });
    log.log({
      key: 'w1:p1', paneId: 'w1:p1', cwd: '/x', method: 'answer-hook', mode: 'auto',
      optionLabel: 'Jedna kolumna', notes: 1,
    });
    await log.flush();
    const line = JSON.parse((await readFile(herdrAuditPath(dataDir), 'utf8')).trim()) as Record<string, unknown>;
    expect(line['notes']).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Manager: pole na karcie i bramka ciała
// ---------------------------------------------------------------------------

const UUID = '8d5c7e65-abb8-4841-b17f-e98b1588b918';
const PROJECT = '/Users/u/Projects/atlas';
const KEY = 'w9:p72';

class NoteDriver extends AtrapaDrivera {
  readonly answered: { answers: string[][]; notes?: readonly (string | null)[] }[] = [];

  override answerQuestion(
    _reqId?: string, answers: string[][] = [], notes?: readonly (string | null)[],
  ): Promise<DecisionOutcome> {
    this.answered.push({ answers, ...(notes === undefined ? {} : { notes }) });
    return Promise.resolve<DecisionOutcome>(APPLIED);
  }
}

class FakeSupervisor extends AtrapaNadzorcy<NoteDriver> {
  override status(): HerdrStatus {
    return { available: true, agentCount: 0, readOnly: false, canLaunch: false };
  }

  protected nowyDriver(key: string): NoteDriver {
    const driver = new NoteDriver(key);
    driver.queue.push({ type: 'agent-state', state: 'idle', seen: true });
    return driver;
  }
}

function deps(): HerdrManagerDeps {
  return {
    sessionIdFor: (key: string) => `herdr-${key.replace(/[^a-z0-9]/gi, '-')}`,
    aliasFor: () => undefined,
    rememberAlias: () => undefined,
    assertSendable: (text) => ({ text: text.trim(), slash: null }),
    takeSendSlot: () => true,
    writeUploads: async () => [],
    writeUploadFiles: async () => [],
    sweepUploads: async () => undefined,
  };
}

async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}

describe('manager: pole `notes` na karcie i bramka ciała', () => {
  let dataDir: string;
  const managers: Manager[] = [];
  const supervisors: FakeSupervisor[] = [];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'rarog-notatki-m-'));
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const manager of managers.splice(0)) await manager.dispose();
    for (const supervisor of supervisors.splice(0)) supervisor.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function build(version: string | null, channel: 'hook' | 'keys' = 'hook') {
    const supervisor = new FakeSupervisor();
    supervisors.push(supervisor);
    const registry: CliRegistry = version === null
      ? new Map()
      : new Map([[UUID, [{ pid: 4242, version, status: 'waiting', waitingFor: 'input' }]]]);
    const manager = await createManager({
      demo: false, dataDir, projects: [{ path: PROJECT, name: 'atlas' }], projectRoots: [],
      gitStatus: null, herdrSupervisor: supervisor, herdrDeps: deps(), herdrRoots: [PROJECT],
      herdrSend: true,
      cliVersionReader: async () => ({ installed: null, registry }),
    });
    managers.push(manager);
    await manager.ready;
    await flush();
    supervisor.lifecycle.push({
      type: 'appeared',
      agent: {
        key: KEY, paneId: KEY, agentSessionId: UUID, engine: 'claude', termId: null, cwd: PROJECT,
        status: 'blocked', title: 'atlas', stateChangeSeq: 1, mode: 'auto', modeReadAt: 0, inScope: true,
        tabId: 'w9:t3', launchedByRarog: false, interactiveReady: true,
      },
    });
    await flush();
    const driver = supervisor.drivers.get(KEY);
    if (driver === undefined) throw new Error('brak drivera');
    const id = manager.list().find((s) => s.paneId !== undefined)?.id ?? '';
    driver.queue.push({
      type: 'question-request', reqId: 'hook:21:abc', channel,
      questions: [
        { ...Z_PODGLADEM, options: Z_PODGLADEM.options.map(({ role: _role, ...rest }) => rest) },
        { ...BEZ_PODGLADU, options: BEZ_PODGLADU.options.map(({ role: _role, ...rest }) => rest) },
      ],
    });
    await flush();
    const request = manager.transcript(id)?.pendingQuestions[0];
    if (request === undefined) throw new Error('brak karty pytania');
    return { manager, driver, id, request };
  }

  it('kanał hooka + CLI ≥ 2.1.288 → `notes: true` przy pytaniu z podglądem, nie przy reszcie', async () => {
    const { request } = await build('2.1.293');
    expect(request.questions.map((question) => question.notes)).toEqual([true, undefined]);
  });

  it('CLI poniżej progu, nieznane wydanie albo kanał cyfry → pola nie ma', async () => {
    expect((await build('2.1.287')).request.questions[0]?.notes).toBeUndefined();
    expect((await build(null)).request.questions[0]?.notes).toBeUndefined();
    expect((await build('2.1.293', 'keys')).request.questions[0]?.notes).toBeUndefined();
  });

  it('notatka jedzie do drivera równolegle do odpowiedzi', async () => {
    const { manager, driver, id, request } = await build('2.1.293');
    const result = await manager.answerQuestion(id, request.qId, [['Jedna kolumna'], ['Mały']], ['bez paska']);
    expect(result).toEqual({ outcome: 'ok' });
    expect(driver.answered).toEqual([{ answers: [['Jedna kolumna'], ['Mały']], notes: ['bez paska', null] }]);
  });

  it('bez notatek driver dostaje odpowiedź bez parametru notatek', async () => {
    const { manager, driver, id, request } = await build('2.1.293');
    await manager.answerQuestion(id, request.qId, [['Jedna kolumna'], ['Mały']], [' ', null]);
    expect(driver.answered).toEqual([{ answers: [['Jedna kolumna'], ['Mały']] }]);
  });

  it('notatka na karcie BEZ pola (CLI poniżej progu) albo do wolnego tekstu → 400, nic nie wychodzi', async () => {
    const old = await build('2.1.287');
    await expect(old.manager.answerQuestion(old.id, old.request.qId, [['Jedna kolumna'], ['Mały']], ['x']))
      .rejects.toThrow(/doesn't accept a note/);
    expect(old.driver.answered).toEqual([]);
    const fresh = await build('2.1.293');
    await expect(fresh.manager.answerQuestion(fresh.id, fresh.request.qId, [['coś swojego'], ['Mały']], ['x']))
      .rejects.toThrow(/Choose one option from the list/);
    expect(fresh.driver.answered).toEqual([]);
  });
});
