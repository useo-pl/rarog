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
import type { BackgroundTask, SessionState } from '@rarog/shared';
import {
  WAIT_LONG_MS, WAIT_STUCK_MS, hasBackgroundWork, hasOpenWorkflow, holdsOwedDone, onlyWaitingAgents, ownCommandWaitOf,
  stuckWait, stuckWaits, tasksBlockRestart, tasksHoldingDonePush, waitKey, waitingOnOwnCommand, workflowsWithRun,
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

/*
 * The wait stage of a subagent in standby on its own command (`ownCommandWait`): the age counts from `waitingSince`
 * on the server clock, and the field exists exactly when the agent waits on a known own command. The own command and
 * the agent started long before the standby, so a rule that took the age from either start would show `long` at once.
 */
describe('wait stage of a subagent on its own command (`ownCommandWaitOf`, `waitKey`)', () => {
  const STANDBY = '2026-11-20T10:00:00.000Z';
  const at = (ms: number): number => Date.parse(STANDBY) + ms;
  const HOURS = 3_600_000;
  const standing: BackgroundTask = {
    id: 'a7', kind: 'agent', description: 'Final tests', startedAt: '2026-11-20T07:00:00.000Z', waitingSince: STANDBY,
    ownTasks: [{ id: 'b0000007', command: "until ! pgrep -f 'vitest run'; do sleep 30; done",
      startedAt: '2026-11-20T08:00:00.000Z' }],
  };
  const { ownTasks: _own, ...noCommand } = standing;
  void _own;
  const { waitingSince: _since, ...woken } = standing;
  void _since;

  it.each([
    { name: 'right at the standby', task: standing, age: 0, stage: 'short' },
    { name: 'one second before the long threshold', task: standing, age: WAIT_LONG_MS - 1_000, stage: 'short' },
    { name: 'at the long threshold', task: standing, age: WAIT_LONG_MS, stage: 'long' },
    { name: 'one second before the stuck threshold', task: standing, age: WAIT_STUCK_MS - 1_000, stage: 'long' },
    { name: 'at the stuck threshold', task: standing, age: WAIT_STUCK_MS, stage: 'stuck' },
    { name: 'hours after the stuck threshold', task: standing, age: 9 * HOURS, stage: 'stuck' },
    { name: 'standby without a known own command, 2 h', task: noCommand, age: 2 * HOURS, stage: undefined },
    { name: 'own command finished (empty list), 2 h', task: { ...standing, ownTasks: [] }, age: 2 * HOURS,
      stage: undefined },
    { name: 'agent woke, its command still runs, 2 h', task: woken, age: 2 * HOURS, stage: undefined },
    { name: 'the fields on a task of another kind', task: { ...standing, kind: 'command' as const }, age: 2 * HOURS,
      stage: undefined },
    // No proof of a long wait: an unreadable start or a clock behind the standby never escalates.
    { name: 'unreadable `waitingSince`', task: { ...standing, waitingSince: 'soon' }, age: 2 * HOURS, stage: 'short' },
    { name: 'clock behind the standby', task: standing, age: -2 * HOURS, stage: 'short' },
  ])('$name → $stage', ({ task, age, stage }) => {
    expect(ownCommandWaitOf(task, at(age))).toBe(stage);
  });

  it('the stages keep their order: the long threshold comes before the stuck one', () => {
    expect(WAIT_LONG_MS).toBeGreaterThan(0);
    expect(WAIT_STUCK_MS).toBeGreaterThan(WAIT_LONG_MS);
  });

  it('`waitKey`: one wait keeps its key across emissions, a new standby gets another, no field gives none', () => {
    const emitted = (task: BackgroundTask, age: number): BackgroundTask => {
      const stage = ownCommandWaitOf(task, at(age));
      return stage === undefined ? task : { ...task, ownCommandWait: stage };
    };
    const first = waitKey(emitted(standing, 0));
    expect(first).toBeDefined();
    const later = { ...standing, ownTasks: [...standing.ownTasks ?? [], { id: 'b0000008' }] };
    expect(waitKey(emitted(later, WAIT_STUCK_MS))).toBe(first);
    const again = { ...standing, waitingSince: new Date(at(2 * HOURS)).toISOString() };
    expect(waitKey(emitted(again, 2 * HOURS))).not.toBe(first);
    expect(waitKey(emitted(noCommand, 2 * HOURS))).toBeUndefined();
    expect(waitKey(standing), 'a list without the field carries no wait').toBeUndefined();
    expect(waitKey({ ...standing, id: 'a8', ownCommandWait: 'short' })).not.toBe(first);
  });
});

/*
 * The edge of the stalled wait alarm (`stuckWaits`): the same wait (key) was below `stuck` on the previous list of the
 * session and is `stuck` on the new one. A missing field before (first list after a Rarog restart or a driver swap,
 * an agent before its file was read) is no edge, so a restart never repeats the alarm. A session in `done` or
 * `resumable` (phantom agent) gives no edge and nothing at `stuck`, while its waits keep their keys.
 */
describe('edge of the stalled wait alarm (`stuckWaits`)', () => {
  const STANDBY = '2026-11-20T10:00:00.000Z';
  const base: BackgroundTask = {
    id: 'a7', kind: 'agent', description: 'Final tests', waitingSince: STANDBY,
    ownTasks: [{ id: 'b0000007', command: 'until false; do sleep 30; done' }],
  };
  const other: BackgroundTask = { ...base, id: 'a8', description: 'Lint' };
  const at = (task: BackgroundTask, stage: BackgroundTask['ownCommandWait']): BackgroundTask =>
    (stage === undefined ? task : { ...task, ownCommandWait: stage });
  const { ownTasks: _own, ...bare } = base;
  void _own;
  const key = waitKey(at(base, 'short'));
  const otherKey = waitKey(at(other, 'short'));
  const newly = (state: SessionState, before: readonly BackgroundTask[] | undefined,
    after: readonly BackgroundTask[] | undefined): (string | undefined)[] =>
    stuckWaits(state, before, after).newly.map((wait) => wait.key);

  it.each([
    { name: '`long` → `stuck`', before: [at(base, 'long')], edge: true },
    { name: '`short` → `stuck` (a sleeping Mac skips `long`)', before: [at(base, 'short')], edge: true },
    { name: '`stuck` → `stuck`', before: [at(base, 'stuck')], edge: false },
    { name: 'no list before (first list)', before: undefined, edge: false },
    { name: 'agent before its file was read', before: [bare], edge: false },
    { name: 'another standby of the same agent',
      before: [{ ...at(base, 'long'), waitingSince: '2026-11-20T09:00:00.000Z' }], edge: false },
  ])('$name: edge $edge', ({ before, edge }) => {
    expect(newly('waiting-input', before, [at(base, 'stuck')])).toEqual(edge ? [key] : []);
  });

  it.each(['waiting-input', 'running', 'starting', 'waiting-permission', 'waiting-question', 'error', 'limit-reached',
    'interrupted'] as const)('state %s gives the edge', (state) => {
    expect(newly(state, [at(base, 'long')], [at(base, 'stuck')])).toEqual([key]);
  });

  it.each(['done', 'resumable'] as const)('state %s (phantom agent): no edge, nothing at `stuck`, keys stay', (state) => {
    const waits = stuckWaits(state, [at(base, 'long')], [at(base, 'stuck')]);
    expect(waits.newly).toEqual([]);
    expect(waits.stuckKeys).toEqual([]);
    expect(waits.waitKeys).toEqual([key]);
  });

  it('two agents on the edge in one list: both, in list order, with their descriptions', () => {
    const waits = stuckWaits('waiting-input', [at(base, 'long'), at(other, 'short')],
      [at(other, 'stuck'), at(base, 'stuck')]);
    expect(waits.newly).toEqual([
      { key: otherKey, agentId: 'a8', description: 'Lint' },
      { key, agentId: 'a7', description: 'Final tests' },
    ]);
  });

  it('`stuckKeys` and `waitKeys` name the waits of the new list by stage', () => {
    const waits = stuckWaits('waiting-input', [at(base, 'stuck')], [at(base, 'stuck'), at(other, 'long'), bare]);
    expect(waits.newly).toEqual([]);
    expect(waits.stuckKeys).toEqual([key]);
    expect(waits.waitKeys).toEqual([key, otherKey]);
    expect(stuckWaits('running', [at(base, 'stuck')], undefined)).toEqual({ newly: [], stuckKeys: [], waitKeys: [] });
  });
});

/*
 * The Live Activity counter "waiting" for a session with a stuck wait (`stuckWait`): only a session after a turn
 * (`waiting-input`) counts, because a session at a decision already waits, one in a turn works, and a session in `done`
 * or `resumable` has a phantom agent. The stage is read from the field only.
 */
describe('Live Activity counter of a stuck wait (`stuckWait`)', () => {
  const agent: BackgroundTask = {
    id: 'a7', kind: 'agent', waitingSince: '2026-11-20T10:00:00.000Z',
    ownTasks: [{ id: 'b0000007', command: 'until false; do sleep 30; done' }],
  };
  const at = (stage: BackgroundTask['ownCommandWait']): BackgroundTask => ({ ...agent, ownCommandWait: stage });

  it.each([
    { name: '`stuck`', tasks: [at('stuck')], waits: true },
    { name: '`stuck` next to a command and a monitor', tasks: [command, monitor, at('stuck')], waits: true },
    { name: '`long`', tasks: [at('long')], waits: false },
    { name: '`short`', tasks: [at('short')], waits: false },
    { name: 'standby without the field', tasks: [agent], waits: false },
    { name: 'no list', tasks: undefined, waits: false },
  ])('after a turn, $name: $waits', ({ tasks, waits }) => {
    expect(stuckWait('waiting-input', tasks)).toBe(waits);
  });

  it.each(['running', 'starting', 'waiting-permission', 'waiting-question', 'error', 'limit-reached', 'interrupted',
    'done', 'resumable'] as const)('state %s: false', (state) => {
    expect(stuckWait(state, [at('stuck')])).toBe(false);
  });
});
