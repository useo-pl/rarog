/**
 * Server-side `currentPhase` (`notify/workflow-phase.ts`) — the rule for the live activity. The app
 * implements the same rule for cards (`ActivityText.currentPhase` in RarogUI); the vectors below pin the
 * server.
 */
import { describe, expect, it } from 'vitest';
import type { ActivityPhase } from '@rarog/shared';
import { currentPhase } from '../src/notify/workflow-phase.ts';

const PHASES: ActivityPhase[] = [
  { title: 'A1 Migracja', agents: 2, done: 2 },
  { title: 'A2 Serwer', agents: 2, done: 1 },
  { title: 'A3 Shared', agents: 0, done: 0 },
];

describe('currentPhase — phase vectors', () => {
  it('bieżąca = pierwsza w kolejności skryptu z pracującym agentem', () => {
    expect(currentPhase(PHASES)).toEqual({ index: 1, title: 'A2 Serwer' });
  });

  it('gdy wszyscy skończyli — ostatnia, w której ktoś ruszył', () => {
    const done = PHASES.map((p) => ({ ...p, done: p.agents }));
    expect(currentPhase(done)).toEqual({ index: 1, title: 'A2 Serwer' });
  });

  it('plan bez agentów nie ma bieżącej fazy', () => {
    expect(currentPhase(PHASES.map((p) => ({ ...p, agents: 0, done: 0 })))).toBeNull();
    expect(currentPhase([])).toBeNull();
  });

  it('pierwszy agent przebiegu: faza 1 w toku', () => {
    expect(currentPhase([{ title: 'A1', agents: 1, done: 0 }, { title: 'A2', agents: 0, done: 0 }]))
      .toEqual({ index: 0, title: 'A1' });
  });
});
