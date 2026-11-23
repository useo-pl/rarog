/*
 * Reguły „co jest pracą w tle" (`herdr/background/work.ts`) w jednej tabeli: każdy kształt listy
 * zadań i odpowiedź każdej reguły. Lustro `BackgroundTaskRulesTests.swift` z rdzenia apki.
 *
 * Wywołujący mają własne testy (push: `notify-policy`, `notify-harmonogram`, `manager-herdr`;
 * restart: `restart-sesji`; kafel: `notify-live-activity`). Tu widać RÓŻNICE między regułami, bo
 * zmiana definicji pracy zaczyna się od tej tabeli. Ostatnia taka zmiana: subagent w postoju
 * (`waitingSince`) przestał być pracą wszędzie poza blokadą restartu.
 */
import { describe, expect, it } from 'vitest';
import type { BackgroundTask } from '@rarog/shared';
import {
  hasBackgroundWork, hasOpenWorkflow, holdsOwedDone, onlyWaitingAgents, tasksBlockRestart, tasksHoldingDonePush,
  waitingOnOwnCommand, workflowsWithRun,
} from '../src/herdr/background/work.ts';

const AT = '2026-10-10T06:00:00.000Z';
const command: BackgroundTask = { id: 'c1', kind: 'command', command: 'pnpm test' };
const monitor: BackgroundTask = { id: 'm1', kind: 'monitor', description: 'until grep -q OK log', startedAt: AT };
/** Monitor z pliku sprzed CLI 2.1.296: rodzaj ten sam, reguły pracy też. */
const oldMonitor: BackgroundTask = { id: 'bmonold01', kind: 'monitor', description: 'serwer wstał' };
const workingAgent: BackgroundTask = { id: 'a1', kind: 'agent', description: 'przegląd logu', startedAt: AT };
const waitingAgent: BackgroundTask = {
  id: 'a2', kind: 'agent', description: 'Shared views', startedAt: AT, waitingSince: AT,
  ownTasks: [{ id: 'bjvzo6rnl', command: 'until grep -q TEST log.txt; do sleep 5; done' }],
};
const otherWaitingAgent: BackgroundTask = { id: 'a3', kind: 'agent', waitingSince: AT };
/** Pracuje, a jego własna komenda dalej leci (wstał po meldunku innej komendy albo sam). */
const workingAgentWithCommand: BackgroundTask = {
  id: 'a4', kind: 'agent', description: 'etap 4', startedAt: AT, ownTasks: [{ id: 'b0000004', command: 'pnpm test' }],
};
const workflowNoRun: BackgroundTask = { id: 'w1', kind: 'workflow', runId: 'wf_a' };
const workflowStarting: BackgroundTask = { id: 'w2', kind: 'workflow', run: { phases: [], agents: [] } };
const workflowFlying: BackgroundTask = {
  id: 'w3', kind: 'workflow', run: { phases: [], agents: [{ id: 'x', done: true }, { id: 'y', done: false }] },
};
const workflowClosed: BackgroundTask = {
  id: 'w4', kind: 'workflow', run: { phases: [], agents: [{ id: 'x', done: true }] },
};

interface Case {
  readonly name: string;
  readonly tasks: readonly BackgroundTask[] | undefined;
  /** Push „gotowe": ile zadań wstrzymuje. */
  readonly holdsPush: number;
  /** Restart sesji: czy lista blokuje. */
  readonly blocksRestart: boolean;
  /** Restart sesji: czy odmowa ma mówić o czekającym subagencie. */
  readonly onlyWaiting: boolean;
  /** Kafel: licznik „pracuje". */
  readonly work: boolean;
  /** Kafel: zegar ciszy. */
  readonly openWorkflow: boolean;
  /** Zaległe „gotowe" po turze z samym postojem: subagent w postoju z żywą własną komendą. */
  readonly ownCommand: boolean;
}

const CASES: readonly Case[] = [
  {
    name: 'brak pola', tasks: undefined,
    holdsPush: 0, blocksRestart: false, onlyWaiting: false, work: false, openWorkflow: false, ownCommand: false,
  },
  {
    name: 'pusta lista', tasks: [],
    holdsPush: 0, blocksRestart: false, onlyWaiting: false, work: false, openWorkflow: false, ownCommand: false,
  },
  {
    name: 'komenda', tasks: [command],
    holdsPush: 1, blocksRestart: true, onlyWaiting: false, work: true, openWorkflow: false, ownCommand: false,
  },
  // Monitor patrzy, nie pracuje. Nie wstrzymuje pusha, kafla ani restartu.
  {
    name: 'monitor', tasks: [monitor],
    holdsPush: 0, blocksRestart: false, onlyWaiting: false, work: false, openWorkflow: false, ownCommand: false,
  },
  {
    name: 'monitor ze starszego pliku (start z `backgroundTaskId`)', tasks: [oldMonitor],
    holdsPush: 0, blocksRestart: false, onlyWaiting: false, work: false, openWorkflow: false, ownCommand: false,
  },
  {
    name: 'monitor i komenda', tasks: [monitor, command],
    holdsPush: 1, blocksRestart: true, onlyWaiting: false, work: true, openWorkflow: false, ownCommand: false,
  },
  {
    name: 'monitor i otwarty workflow', tasks: [monitor, workflowFlying],
    holdsPush: 1, blocksRestart: true, onlyWaiting: false, work: true, openWorkflow: true, ownCommand: false,
  },
  {
    name: 'subagent pracujący', tasks: [workingAgent],
    holdsPush: 1, blocksRestart: true, onlyWaiting: false, work: true, openWorkflow: false, ownCommand: false,
  },
  // Subagent w postoju nie jest pracą nigdzie poza blokadą restartu.
  {
    name: 'sam subagent w postoju', tasks: [waitingAgent],
    holdsPush: 0, blocksRestart: true, onlyWaiting: true, work: false, openWorkflow: false, ownCommand: true,
  },
  {
    name: 'dwóch subagentów w postoju', tasks: [waitingAgent, otherWaitingAgent],
    holdsPush: 0, blocksRestart: true, onlyWaiting: true, work: false, openWorkflow: false, ownCommand: true,
  },
  {
    name: 'subagent w postoju i subagent pracujący', tasks: [waitingAgent, workingAgent],
    holdsPush: 1, blocksRestart: true, onlyWaiting: false, work: true, openWorkflow: false, ownCommand: true,
  },
  {
    name: 'subagent w postoju i komenda', tasks: [waitingAgent, command],
    holdsPush: 1, blocksRestart: true, onlyWaiting: false, work: true, openWorkflow: false, ownCommand: true,
  },
  {
    name: 'subagent w postoju i monitor', tasks: [waitingAgent, monitor],
    holdsPush: 0, blocksRestart: true, onlyWaiting: false, work: false, openWorkflow: false, ownCommand: true,
  },
  {
    name: 'subagent w postoju i otwarty workflow', tasks: [waitingAgent, workflowFlying],
    holdsPush: 1, blocksRestart: true, onlyWaiting: false, work: true, openWorkflow: true, ownCommand: true,
  },
  // Tu push i kafel się rozchodzą: zamknięty przebieg dalej wstrzymuje push.
  {
    name: 'subagent w postoju i zamknięty workflow', tasks: [waitingAgent, workflowClosed],
    holdsPush: 1, blocksRestart: true, onlyWaiting: false, work: false, openWorkflow: false, ownCommand: true,
  },
  {
    name: 'workflow bez rozkładu', tasks: [workflowNoRun],
    holdsPush: 1, blocksRestart: true, onlyWaiting: false, work: true, openWorkflow: true, ownCommand: false,
  },
  {
    name: 'workflow bez agentów', tasks: [workflowStarting],
    holdsPush: 1, blocksRestart: true, onlyWaiting: false, work: true, openWorkflow: true, ownCommand: false,
  },
  {
    name: 'workflow, wszyscy agenci skończyli', tasks: [workflowClosed],
    holdsPush: 1, blocksRestart: true, onlyWaiting: false, work: false, openWorkflow: false, ownCommand: false,
  },
  {
    name: 'komenda, subagent i otwarty workflow', tasks: [command, workingAgent, workflowFlying],
    holdsPush: 3, blocksRestart: true, onlyWaiting: false, work: true, openWorkflow: true, ownCommand: false,
  },
  // Zaległe „gotowe" czeka tylko na agenta w postoju Z WŁASNĄ komendą.
  {
    name: 'sam subagent w postoju bez własnej komendy', tasks: [otherWaitingAgent],
    holdsPush: 0, blocksRestart: true, onlyWaiting: true, work: false, openWorkflow: false, ownCommand: false,
  },
  {
    name: 'subagent pracujący z własną komendą', tasks: [workingAgentWithCommand],
    holdsPush: 1, blocksRestart: true, onlyWaiting: false, work: true, openWorkflow: false, ownCommand: false,
  },
  {
    name: 'subagent w postoju bez komendy i subagent pracujący z komendą', tasks: [otherWaitingAgent, workingAgentWithCommand],
    holdsPush: 1, blocksRestart: true, onlyWaiting: false, work: true, openWorkflow: false, ownCommand: false,
  },
];

describe('zadania w tle: reguły pracy nad jedną listą (work.ts)', () => {
  it.each(CASES)('$name', (sample) => {
    expect(tasksHoldingDonePush(sample.tasks), 'push „gotowe"').toBe(sample.holdsPush);
    expect(tasksBlockRestart(sample.tasks), 'blokada restartu').toBe(sample.blocksRestart);
    expect(onlyWaitingAgents(sample.tasks), 'zdanie odmowy restartu').toBe(sample.onlyWaiting);
    expect(hasBackgroundWork(sample.tasks), 'licznik „pracuje" kafla').toBe(sample.work);
    expect(hasOpenWorkflow(sample.tasks), 'zegar ciszy kafla').toBe(sample.openWorkflow);
    expect(waitingOnOwnCommand(sample.tasks), 'zaległe „gotowe" po turze z samym postojem').toBe(sample.ownCommand);
    // Cisza w tle bez tury = spadek z „wstrzymuje" do „nie wstrzymuje".
    expect(holdsOwedDone(sample.tasks), 'zaległe „gotowe" przy ciszy w tle').toBe(sample.holdsPush > 0 || sample.ownCommand);
  });

  it('reguły są uporządkowane: otwarty workflow ⇒ praca kafla ⇒ wstrzymany push ⇒ blokada restartu', () => {
    for (const sample of CASES) {
      const open = hasOpenWorkflow(sample.tasks);
      const work = hasBackgroundWork(sample.tasks);
      const holds = tasksHoldingDonePush(sample.tasks) > 0;
      const blocks = tasksBlockRestart(sample.tasks);
      expect(!open || work, `${sample.name}: otwarty workflow bez pracy kafla`).toBe(true);
      expect(!work || holds, `${sample.name}: praca kafla bez wstrzymanego pusha`).toBe(true);
      expect(!holds || blocks, `${sample.name}: wstrzymany push bez blokady restartu`).toBe(true);
      // Zdanie o czekającym subagencie pada tylko przy blokadzie i nigdy obok czegoś, co pracuje.
      expect(!onlyWaitingAgents(sample.tasks) || (blocks && !holds), sample.name).toBe(true);
      // Agent czekający na własną komendę stoi na liście, więc restart jest zablokowany.
      expect(!waitingOnOwnCommand(sample.tasks) || blocks, `${sample.name}: komenda agenta bez blokady restartu`).toBe(true);
    }
  });

  /*
   * `waitingSince` nadaje wyłącznie reduktor i wyłącznie agentom (kontrakt: „tylko rodzaj `agent`").
   * Pole przy innym rodzaju nie ma znaczenia, więc takie zadanie zostaje pracą: pomyłka w tę stronę
   * wstrzymuje push, a w drugą wysłałaby „gotowe" przy pracującej komendzie.
   */
  it('`waitingSince` przy zadaniu innego rodzaju niczego nie zmienia', () => {
    const odd: BackgroundTask = { ...command, waitingSince: AT };
    expect(tasksHoldingDonePush([odd])).toBe(1);
    expect(hasBackgroundWork([odd])).toBe(true);
    expect(onlyWaitingAgents([odd])).toBe(false);
  });

  it('własne komendy subagenta (`ownTasks`) nie robią z czekającego pracy', () => {
    expect(waitingAgent.ownTasks).toHaveLength(1);
    expect(tasksHoldingDonePush([waitingAgent])).toBe(0);
    expect(hasBackgroundWork([waitingAgent])).toBe(false);
    // …ale mówią, że agent czeka na własną komendę — o to pyta wyłącznie zaległe „gotowe".
    expect(waitingOnOwnCommand([waitingAgent])).toBe(true);
    expect(holdsOwedDone([waitingAgent])).toBe(true);
  });

  /*
   * Przebieg, który zamyka cisza w tle: komenda subagenta w postoju
   * skończyła się, agent nie wstał. Lista przestaje wstrzymywać, choć agent dalej na niej stoi.
   */
  it('`holdsOwedDone`: koniec komendy agenta w postoju zdejmuje wstrzymanie, agent bez komendy nie wstrzymuje', () => {
    const { ownTasks: _own, ...bare } = waitingAgent;
    void _own;
    expect(holdsOwedDone([waitingAgent])).toBe(true);
    expect(holdsOwedDone([bare])).toBe(false);
    // Monitor nie jest pracą: agent w postoju bez komendy obok monitora niczego nie wstrzymuje.
    expect(holdsOwedDone([bare, monitor])).toBe(false);
    expect(holdsOwedDone([bare, command])).toBe(true);
    expect(holdsOwedDone(undefined)).toBe(false);
  });

  /*
   * `ownTasks` nadaje `merge.ts` wyłącznie agentom (kontrakt). Pusta lista znaczy to samo co brak
   * pola, a pole przy zadaniu innego rodzaju nic nie znaczy: komenda głównego agenta to praca
   * (`tasksHoldingDonePush`), nie agent czekający na własną komendę.
   */
  it('`waitingOnOwnCommand`: pusta lista komend i `ownTasks` przy innym rodzaju niczego nie zmieniają', () => {
    expect(waitingOnOwnCommand([{ ...otherWaitingAgent, ownTasks: [] }])).toBe(false);
    const odd: BackgroundTask = { ...command, waitingSince: AT, ownTasks: [{ id: 'b0000009' }] };
    expect(waitingOnOwnCommand([odd])).toBe(false);
    expect(tasksHoldingDonePush([odd])).toBe(1);
  });

  it('lista przebiegów na kaflu nie zależy od czekających subagentów', () => {
    expect(workflowsWithRun([waitingAgent, workflowFlying, workflowNoRun]).map(({ task }) => task.id)).toEqual(['w3']);
  });
});
