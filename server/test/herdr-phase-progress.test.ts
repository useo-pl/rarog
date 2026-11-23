/**
 * Pasek postępu workflow z PRAWDZIWEGO planu faz: serwer dokleja do eventu
 * `activity` fakty o fazach (`phaseCounts` z rozkładu przebiegu), a journal liczy `failed` jako
 * zakończenie agenta.
 *
 * Wszystko poniżej jest czyste (bez dysku): parser journala, złożenie faz z rozkładu, event
 * pulsu z fazami i jego dedup. Wpięcie w driver (cache rozkładu, zero nowych odczytów na ścieżce
 * pulsu) sprawdza skan źródła.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { WorkflowRun } from '@rarog/shared';
import { activitySchema } from '@rarog/shared';
import { parseJournalLine, parseScriptPhases, phaseCounts } from '../src/herdr/background/workflow-run.ts';
import { createTasksState, runName } from '../src/herdr/background/merge.ts';
import { createPulseEcho, pulseActivity } from '../src/drivers/herdr/transcript.ts';

const DRIVER_SRC = readFileSync(new URL('../src/drivers/herdr-driver.ts', import.meta.url), 'utf8');

describe('parseJournalLine — `failed` to zakończenie', () => {
  it('`failed` wraca jako `result`: ten agent już nie pracuje', () => {
    expect(parseJournalLine('{"type":"failed","key":"v2:abc","agentId":"a46692072e5da2e72"}'))
      .toEqual({ type: 'result', agentId: 'a46692072e5da2e72' });
  });
});

const RUN: WorkflowRun = {
  phases: ['A1 Migracja', 'A2 Serwer', 'A3 Shared'],
  agents: [
    { id: 'a1', phase: 'A1 Migracja', label: 'impl', done: true },
    { id: 'a2', phase: 'A1 Migracja', label: 'verify', done: true },
    { id: 'a3', phase: 'A2 Serwer', label: 'impl', done: false },
    { id: 'a4', phase: 'A2 Serwer', label: 'verify', done: true },
    { id: 'a5', phase: 'Faza spoza skryptu', done: false },
    { id: 'a6', done: false },
  ],
};

describe('phaseCounts — fakty o fazach z rozkładu', () => {
  it('każda faza skryptu w kolejności, także bez agentów; agent bez fazy z listy pomijany', () => {
    expect(phaseCounts(RUN)).toEqual([
      { title: 'A1 Migracja', agents: 2, done: 2 },
      { title: 'A2 Serwer', agents: 2, done: 1 },
      { title: 'A3 Shared', agents: 0, done: 0 },
    ]);
  });

  it('bez ani jednego otagowanego agenta = `null` (klient liczy po staremu)', () => {
    expect(phaseCounts({ phases: ['A'], agents: [{ id: 'x', done: false }] })).toBeNull();
    expect(phaseCounts({ phases: ['A'], agents: [] })).toBeNull();
    expect(phaseCounts({ phases: [], agents: [{ id: 'x', done: false }] })).toBeNull();
    expect(phaseCounts({ phases: [], agents: [] })).toBeNull();
  });

  /*
   * Przebieg z `scriptPath`: Claude Code nie kopiuje skryptu do `workflows/scripts/`,
   * więc planu nie ma, ale agenci mają tagi faz. Fazy składają się wtedy z tagów w kolejności
   * pierwszego pojawienia się — tak samo, jak widok sesji rysuje je z `workflowRows`.
   */
  it('bez planu fazy idą z TAGÓW w kolejności pierwszego agenta', () => {
    expect(phaseCounts({ phases: [], agents: RUN.agents })).toEqual([
      { title: 'A1 Migracja', agents: 2, done: 2 },
      { title: 'A2 Serwer', agents: 2, done: 1 },
      { title: 'Faza spoza skryptu', agents: 1, done: 0 },
    ]);
    // Przy ZNANYM planie faza spoza listy nadal jest pomijana — plan mówi, gdzie co stoi.
    expect(phaseCounts(RUN)?.map((phase) => phase.title)).toEqual(RUN.phases);
  });

  it('znane ograniczenie: dwie fazy o tym samym tytule to jeden koszyk (tytuł JEST fazą)', () => {
    expect(parseScriptPhases(
      "export const meta = { name: 'x', phases: [{ title: 'A' }, { title: 'A' }, { title: 'B' }] }\n",
    )).toEqual(['A', 'B']);
    expect(phaseCounts({
      phases: ['A', 'B'],
      agents: [{ id: '1', phase: 'A', done: true }, { id: '2', phase: 'A', done: false }],
    })).toEqual([{ title: 'A', agents: 2, done: 1 }, { title: 'B', agents: 0, done: 0 }]);
  });

  it('wynik przechodzi przez schemat protokołu', () => {
    const phases = phaseCounts(RUN) ?? [];
    expect(activitySchema.safeParse({ kind: 'tool', toolName: 'Workflow', phases }).success).toBe(true);
  });
});

describe('pulseActivity z fazami', () => {
  const sample = { agents: 2, other: 0, at: 0, workflowName: 'r5b', agentsDone: 3, runId: 'wf_1' };
  const moment = { now: 10_000, silentFor: 5_000 };
  const phases = phaseCounts(RUN) ?? [];

  it('fazy wchodzą do eventu; bez nich pola nie ma', () => {
    const withPhases = pulseActivity(createPulseEcho(), sample, moment, phases);
    expect(withPhases?.type).toBe('activity');
    expect(withPhases !== null && withPhases.type === 'activity' ? withPhases.phases : null)
      .toEqual(phases);
    const plain = pulseActivity(createPulseEcho(), sample, moment);
    expect(plain !== null && plain.type === 'activity' && 'phases' in plain).toBe(false);
  });

  it('agent kończący fazę zmienia klucz dedup, choć liczby agentów stoją', () => {
    const echo = createPulseEcho();
    expect(pulseActivity(echo, sample, moment, phases)).not.toBeNull();
    // Ten sam meldunek zaraz potem — echo.
    expect(pulseActivity(echo, sample, { ...moment, now: 11_000 }, phases)).toBeNull();
    const advanced = phases.map((phase, i) => (i === 1 ? { ...phase, done: 2 } : phase));
    expect(pulseActivity(echo, sample, { ...moment, now: 12_000 }, advanced)).not.toBeNull();
  });
});

describe('wpięcie w driver (skan źródła)', () => {
  const at = DRIVER_SRC.indexOf('#onPulse(sample: PulseSample): void {');
  const fn = DRIVER_SRC.slice(at, DRIVER_SRC.indexOf('\n  }\n', at));

  it('nazwa przebiegu bez skryptu w `workflows/scripts/` idzie z listy zadań (`runName`)', () => {
    expect(fn).toContain('runName(this.#tasks, sample.runId)');
    // Nazwa z listingu skryptów ma pierwszeństwo — lista zadań tylko łata brak.
    expect(fn).toContain('sample.workflowName !== undefined');
  });

  it('fazy idą z CACHE\'U rozkładu pod `sample.runId` — bez nowego odczytu dysku na ścieżce pulsu', () => {
    expect(fn).toContain('this.#tasks.runs.get(sample.runId)?.run');
    expect(fn).toContain('phaseCounts(run)');
    expect(fn).not.toContain('runReader');
    expect(fn).not.toContain('await ');
  });
});

describe('runName — nazwa przebiegu z listy zadań followera', () => {
  it('opis otwartego zadania `workflow` o tym `runId`; inne rodzaje i inne id nie liczą się', () => {
    const state = createTasksState();
    state.raw = [
      { id: 'b', kind: 'agent', description: 'Explore', runId: 'wf_1' } as never,
      { id: 'w', kind: 'workflow', description: 'poprawki-r5b-r6a', runId: 'wf_1' },
      { id: 'x', kind: 'workflow', runId: 'wf_2' },
    ];
    expect(runName(state, 'wf_1')).toBe('poprawki-r5b-r6a');
    expect(runName(state, 'wf_2')).toBeUndefined();
    expect(runName(state, 'wf_3')).toBeUndefined();
  });
});
