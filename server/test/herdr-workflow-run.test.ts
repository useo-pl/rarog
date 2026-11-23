/**
 * Rozkład przebiegu workflow (`herdr/background/workflow-run.ts`).
 *
 * Testy pracują na PRAWDZIWYCH plikach w katalogu tymczasowym, odtwarzając układ zmierzony
 * na żywym przebiegu `audyt-wdrozenie` (17 agentów): skrypt z `meta.phases`,
 * `journal.jsonl` z samymi `started`/`result`, `agent-<id>.meta.json` bez treści i transkrypt
 * agenta z promptem jako gołym stringiem w pierwszej linii. Kształty wpisów są DOSŁOWNE.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFile, mkdir, mkdtemp, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { projectSlug } from '../src/cli-store.ts';
import {
  createWorkflowRunReader, parseAgentTag, parseJournalLine, parseScriptPhases, phaseCounts, promptHeadOf,
  withoutInterrupted,
} from '../src/herdr/background/workflow-run.ts';
import type { BackgroundTask, WorkflowRun } from '@rarog/shared';
import { createTasksState, forgetSession, noteTasks, openRuns } from '../src/herdr/background/merge.ts';
import type { TasksDeps } from '../src/herdr/background/merge.ts';

const CWD = '/Users/u/Projects/atlas';
const SESSION = '7d2dd80f-012c-5c17-b97d-cf436a305158';
const RUN = 'wf_d6b24986-923';

const SCRIPT = `export const meta = {
  name: 'audyt-wdrozenie',
  description: 'Wdrożenie planu docs/plans/audyt-2026-08.md: paczki commitów A–D',
  phases: [
    { title: 'Faza A', detail: 'bramki, lint, ts, deps, fonty, nagłówki, bump' },
    { title: 'Faza B', detail: 'rejestr, szkielet, kontrakty, kreator, katalog' },
    { title: "Faza C", detail: 'Tailwind, jeden potok CSS, ikony, rarog' },
  ],
}

const PLAN = 'docs/plans/audyt-2026-08.md'
const r = await agent(\`[Faza A · impl:A1] title: 'nie faza'\`, { phase: 'Faza A', label: 'impl:A1' })
`;

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rarog-wfrun-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const sessionDir = (): string => join(root, projectSlug(CWD), SESSION);
const runDir = (): string => join(sessionDir(), 'subagents', 'workflows', RUN);

async function seedTranscript(): Promise<void> {
  const dir = join(root, projectSlug(CWD));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${SESSION}.jsonl`), '{}\n');
  await mkdir(sessionDir(), { recursive: true });
}

async function seedScript(source = SCRIPT): Promise<void> {
  const path = join(sessionDir(), 'workflows', 'scripts', `audyt-wdrozenie-${RUN}.js`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source);
}

/** Wpis journala w zmierzonym kształcie (`key` to hash promptu i opcji). */
const started = (id: string): string =>
  `${JSON.stringify({ type: 'started', key: `v2:${'0'.repeat(64)}`, agentId: id })}\n`;
const result = (id: string, summary = 'ok'): string =>
  `${JSON.stringify({ type: 'result', key: `v2:${'0'.repeat(64)}`, agentId: id, result: { summary } })}\n`;

async function journal(text: string): Promise<void> {
  await mkdir(runDir(), { recursive: true });
  await appendFile(join(runDir(), 'journal.jsonl'), text);
}

/** Agent w katalogu przebiegu: meta (pusta treść) i transkrypt z promptem w pierwszej linii. */
async function seedAgent(id: string, prompt: string, startedAt?: Date): Promise<void> {
  await mkdir(runDir(), { recursive: true });
  const meta = join(runDir(), `agent-${id}.meta.json`);
  await writeFile(meta, '{"agentType":"workflow-subagent","spawnDepth":1}');
  if (startedAt !== undefined) await utimes(meta, startedAt, startedAt);
  const line = JSON.stringify({
    parentUuid: null, isSidechain: true, agentId: id, type: 'user',
    message: { role: 'user', content: prompt }, timestamp: '2026-08-28T06:25:00.000Z',
  });
  await writeFile(join(runDir(), `agent-${id}.jsonl`), `${line}\n`);
}

// ---------------------------------------------------------------------------
// Czyste parsery
// ---------------------------------------------------------------------------

describe('parseScriptPhases', () => {
  /** TEST OBOWIĄZKOWY: fazy tylko z bloku `meta` — `title:` w promptach niżej to nie faza. */
  it('tytuły z `meta.phases`, w kolejności skryptu, oba rodzaje cudzysłowu', () => {
    expect(parseScriptPhases(SCRIPT)).toEqual(['Faza A', 'Faza B', 'Faza C']);
  });

  it('skrypt bez faz i skrypt bez `meta` dają pustą listę', () => {
    expect(parseScriptPhases("export const meta = {\n  name: 'x',\n}\n")).toEqual([]);
    expect(parseScriptPhases('const x = 1')).toEqual([]);
  });
});

describe('parseAgentTag', () => {
  it('`[faza · etykieta]` na początku promptu', () => {
    expect(parseAgentTag('[Faza B · impl:B5] Jesteś…')).toEqual({ phase: 'Faza B', label: 'impl:B5' });
    expect(parseAgentTag('  \n[Review · review:bugs]x')).toEqual({ phase: 'Review', label: 'review:bugs' });
  });

  it('rama harnessu (CLI 2.1.278) nie jest tagiem — tag stoi w wciętej linii po niej', () => {
    const frame = '[Workflow harness — computed task] The task text below… follows:\n';
    expect(parseAgentTag(`${frame}  [Implementacja · feat:wyciszenie] Pracujesz…`))
      .toEqual({ phase: 'Implementacja', label: 'feat:wyciszenie' });
    expect(parseAgentTag(`${frame}  Zrób coś bez tagu`)).toBeNull();
    expect(parseAgentTag('[Workflow harness — computed task] ucięte')).toBeNull();
  });

  it('bez separatora cała treść jest etykietą; `[· label]` to etykieta bez fazy', () => {
    expect(parseAgentTag('[verify:B2#1] …')).toEqual({ label: 'verify:B2#1' });
    expect(parseAgentTag('[· verify:B2#1] …')).toEqual({ label: 'verify:B2#1' });
  });

  it('prompt sprzed konwencji (bez nawiasu na starcie) to `null`, nie zmyślona etykieta', () => {
    expect(parseAgentTag('Jesteś niezależnym weryfikatorem paczki W7 [B2, B3]')).toBeNull();
    expect(parseAgentTag('[]')).toBeNull();
    expect(parseAgentTag('[ · ]')).toBeNull();
  });
});

describe('promptHeadOf', () => {
  it('prompt jako goły string w `content` — z odkodowaniem escape\'ów JSON', () => {
    const line = JSON.stringify({ type: 'user', message: { role: 'user', content: '[Faza "A" · x]\nreszta' } });
    expect(promptHeadOf(line)).toBe('[Faza "A" · x]\nreszta');
  });

  it('prompt w bloku tekstowym tablicy `content`', () => {
    const line = JSON.stringify({ message: { content: [{ type: 'text', text: '[F · l] treść' }] } });
    expect(promptHeadOf(line)).toBe('[F · l] treść');
  });

  it('linia bez promptu daje pusty napis', () => {
    expect(promptHeadOf('{"type":"progress"}')).toBe('');
  });
});

describe('parseJournalLine', () => {
  it('`started` i `result` po `type` i `agentId`, bez parsowania całego wyniku', () => {
    expect(parseJournalLine(started('a1').trim())).toEqual({ type: 'started', agentId: 'a1' });
    expect(parseJournalLine(result('a1', 'x'.repeat(100_000)).trim()))
      .toEqual({ type: 'result', agentId: 'a1' });
  });

  it('`started` od CLI 2.1.278 niesie `label` i `phase` wprost', () => {
    const line = '{"type":"started","key":"v2:18","agentId":"a46239cf707b0d329",'
      + '"label":"feat:wyciszenie","phase":"Implementacja"}';
    expect(parseJournalLine(line)).toEqual({
      type: 'started', agentId: 'a46239cf707b0d329', label: 'feat:wyciszenie', phase: 'Implementacja',
    });
  });

  it('inny kształt to `null`', () => {
    expect(parseJournalLine('{"type":"launched"}')).toBeNull();
    expect(parseJournalLine('{"type":"meta","name":"x"}')).toBeNull();
    expect(parseJournalLine('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Czytnik na prawdziwych plikach
// ---------------------------------------------------------------------------

describe('createWorkflowRunReader', () => {
  it('bez katalogu satelity i bez śladu przebiegu odpowiada `null`', async () => {
    const reader = createWorkflowRunReader({ cwd: CWD, agentSessionId: SESSION, root });
    expect(await reader.read(RUN)).toBeNull();
    await seedTranscript();
    expect(await reader.read(RUN)).toBeNull();
    reader.close();
  });

  /**
   * TEST OBOWIĄZKOWY. Cały rozkład: fazy ze skryptu, agenci z journala w kolejności startu,
   * tag i czas startu z plików agenta, `done` z wpisu `result`.
   */
  it('składa fazy, agentów, tagi i stan z czterech różnych plików', async () => {
    await seedTranscript();
    await seedScript();
    const t0 = new Date('2026-08-28T06:25:00.000Z');
    await seedAgent('a1', '[Faza A · impl:A1] Jesteś…', t0);
    await seedAgent('a2', '[Faza A · verify:A1#1] Jesteś…');
    await journal(started('a1') + result('a1') + started('a2'));

    const reader = createWorkflowRunReader({ cwd: CWD, agentSessionId: SESSION, root });
    const run = await reader.read(RUN);
    expect(run?.phases).toEqual(['Faza A', 'Faza B', 'Faza C']);
    expect(run?.agents).toEqual([
      { id: 'a1', phase: 'Faza A', label: 'impl:A1', done: true, startedAt: t0.toISOString() },
      { id: 'a2', phase: 'Faza A', label: 'verify:A1#1', done: false, startedAt: expect.any(String) },
    ]);
    reader.close();
  });

  it('journal czyta przyrostowo: dopisany `result` zmienia `done`, nowy `started` dokłada agenta', async () => {
    await seedTranscript();
    await seedScript();
    await seedAgent('a1', '[Faza A · impl:A1] x');
    await journal(started('a1'));
    const reader = createWorkflowRunReader({ cwd: CWD, agentSessionId: SESSION, root });
    expect((await reader.read(RUN))?.agents.map((a) => a.done)).toEqual([false]);

    await seedAgent('a2', '[Faza B · impl:B1] x');
    await journal(result('a1') + started('a2'));
    const run = await reader.read(RUN);
    expect(run?.agents.map((a) => [a.label, a.done])).toEqual([['impl:A1', true], ['impl:B1', false]]);
    reader.close();
  });

  it('skrypt bez konwencji tagów faz: agenci bez fazy i etykiety, ale z `done`', async () => {
    await seedTranscript();
    await seedScript();
    await seedAgent('a1', 'Jesteś niezależnym weryfikatorem paczki W7…');
    await journal(started('a1') + result('a1'));
    const reader = createWorkflowRunReader({ cwd: CWD, agentSessionId: SESSION, root });
    expect((await reader.read(RUN))?.agents).toEqual([{ id: 'a1', done: true, startedAt: expect.any(String) }]);
    reader.close();
  });

  it('agent ze `started`, ale bez transkryptu, zostaje bez tagu i dostaje go przy następnym odczycie', async () => {
    await seedTranscript();
    await seedScript();
    await journal(started('a1'));
    const reader = createWorkflowRunReader({ cwd: CWD, agentSessionId: SESSION, root });
    expect((await reader.read(RUN))?.agents).toEqual([{ id: 'a1', done: false }]);
    await seedAgent('a1', '[Faza A · impl:A1] x');
    expect((await reader.read(RUN))?.agents[0]?.label).toBe('impl:A1');
    reader.close();
  });

  it('journal bez skryptu daje rozkład z pustą listą faz, a skrypt dochodzi później', async () => {
    await seedTranscript();
    await journal(started('a1'));
    const reader = createWorkflowRunReader({ cwd: CWD, agentSessionId: SESSION, root });
    expect((await reader.read(RUN))?.phases).toEqual([]);
    await seedScript();
    expect((await reader.read(RUN))?.phases).toEqual(['Faza A', 'Faza B', 'Faza C']);
    reader.close();
  });

  it('`result` bez `started` nie zakłada ducha; `repoint` czyści cache', async () => {
    await seedTranscript();
    await journal(result('zombie') + started('a1'));
    const reader = createWorkflowRunReader({ cwd: CWD, agentSessionId: SESSION, root });
    expect((await reader.read(RUN))?.agents.map((a) => a.id)).toEqual(['a1']);
    reader.repoint('9f1c4b62-77aa-5d31-8bd0-2c0f6a1e4d55');
    expect(await reader.read(RUN)).toBeNull();
    reader.close();
  });

  /**
   * `EnterWorktree`: journal i transkrypty agentów jadą `rename(2)`-em razem z katalogiem
   * sesji, więc offsety zostają prawdą — do kosza idzie WYŁĄCZNIE zapamiętany adres katalogu.
   */
  it('relocated() zrzuca sam adres katalogu: journal czyta się dalej z nowego miejsca', async () => {
    const worktree = '/Users/u/Projects/atlas/.claude/worktrees/dialogi';
    await seedTranscript();
    await journal(started('a1'));
    await seedAgent('a1', '[Faza A · impl:A1] rób');
    const reader = createWorkflowRunReader({ cwd: CWD, agentSessionId: SESSION, root });
    expect((await reader.read(RUN))?.agents.map((a) => ({ id: a.id, done: a.done }))).toEqual([
      { id: 'a1', done: false },
    ]);

    const dst = join(root, projectSlug(worktree));
    await mkdir(dst, { recursive: true });
    await rename(join(root, projectSlug(CWD), `${SESSION}.jsonl`), join(dst, `${SESSION}.jsonl`));
    await rename(sessionDir(), join(dst, SESSION));
    const movedJournal = join(dst, SESSION, 'subagents', 'workflows', RUN, 'journal.jsonl');
    await appendFile(movedJournal, result('a1'));

    // Cache pokazuje katalog, którego nie ma — dopisany `result` jest niewidoczny.
    expect((await reader.read(RUN))?.agents[0]?.done).toBe(false);
    reader.relocated();
    expect((await reader.read(RUN))?.agents[0]?.done).toBe(true);
    reader.close();
  });

  describe('wznowienie przebiegu (`resumeFromRunId`)', () => {
    /** `started` w kształcie CLI ≥ 2.1.278 (z `phase` i `label`), z unikalnym `key`. */
    const startedTagged = (id: string, phase: string, label: string): string =>
      `${JSON.stringify({ type: 'started', key: `v2:${id}`, agentId: id, label, phase })}\n`;
    const STREAMS = ['b4-os', 'b3-szczegoly', 'b2-biblioteka', 'b1-nagrywanie', 'b5-live-activity'];
    const PHASE = 'B Strumienie';
    /** Chwila wpisu z wynikiem `Workflow` przy wznowieniu — `startedAt` otwartego zadania. */
    const RESUMED = '2026-10-07T15:47:42.368Z';

    /**
     * TEST OBOWIĄZKOWY. `TaskStop` o 15:55, wznowienie o 17:47 dopisuje do tego samego journala
     * pięć `started` z tymi samymi etykietami, a przerwani zostają bez `result`. Licznik nie może
     * pokazać „10 pracuje" i fazy 0/10. Czasy z żywego przebiegu.
     */
    it('agenci bez `result` sprzed ostatniego uruchomienia znikają; faza liczy 0/5', async () => {
      await seedTranscript();
      const first = new Date('2026-10-07T11:46:30.000Z');
      const old = new Date('2026-10-07T13:54:47.000Z');
      await seedAgent('a0', '[x] a0', first);
      let text = startedTagged('a0', 'A Fundament', 'a-scalenie') + result('a0');
      for (const label of STREAMS) {
        await seedAgent(`old-${label}`, '[x]', old);
        text += startedTagged(`old-${label}`, PHASE, label);
      }
      for (const [index, label] of STREAMS.entries()) {
        await seedAgent(`new-${label}`, '[x]', new Date(Date.parse(RESUMED) + 257 + index * 190));
        text += startedTagged(`new-${label}`, PHASE, label);
      }
      await journal(text);

      const reader = createWorkflowRunReader({ cwd: CWD, agentSessionId: SESSION, root });
      const run = await reader.read(RUN, RESUMED);
      expect(run?.agents.map((a) => a.id)).toEqual(['a0', ...STREAMS.map((label) => `new-${label}`)]);
      expect(phaseCounts(run ?? { phases: [], agents: [] })).toEqual([
        { title: 'A Fundament', agents: 1, done: 1 },
        { title: PHASE, agents: 5, done: 0 },
      ]);
      // Bez chwili uruchomienia (zadanie sprzed okna ogona) rozkład zostaje pełny, jak dotąd.
      expect((await reader.read(RUN))?.agents).toHaveLength(11);
      reader.close();
    });

    /** Powtórzona etykieta w zwykłym przebiegu nie jest wznowieniem. */
    it('bez wznowienia nikt nie znika, także przy powtórzonej etykiecie i ciszy transkryptu', async () => {
      await seedTranscript();
      const launch = '2026-10-07T15:00:00.000Z';
      await seedAgent('a', '[x]', new Date('2026-10-07T15:00:00.300Z'));
      await seedAgent('b', '[x]', new Date('2026-10-07T15:00:30.000Z'));
      await journal(startedTagged('a', 'B', 'impl') + startedTagged('b', 'B', 'impl') + result('b'));
      const reader = createWorkflowRunReader({ cwd: CWD, agentSessionId: SESSION, root });
      const run = await reader.read(RUN, launch);
      expect(run?.agents.map((a) => a.id)).toEqual(['a', 'b']);
      expect(phaseCounts(run ?? { phases: [], agents: [] })).toEqual([{ title: 'B', agents: 2, done: 1 }]);
      reader.close();
    });

    it('przerwany bez transkryptu też znika: czas startu bierzemy z samego `meta.json`', async () => {
      await seedTranscript();
      await mkdir(runDir(), { recursive: true });
      const meta = join(runDir(), 'agent-ghost.meta.json');
      await writeFile(meta, '{"agentType":"workflow-subagent","spawnDepth":1}');
      const old = new Date('2026-10-07T13:54:47.000Z');
      await utimes(meta, old, old);
      await seedAgent('fresh', '[x]', new Date(Date.parse(RESUMED) + 300));
      await journal(startedTagged('ghost', PHASE, 'b1') + startedTagged('fresh', PHASE, 'b1'));
      const reader = createWorkflowRunReader({ cwd: CWD, agentSessionId: SESSION, root });
      expect((await reader.read(RUN, RESUMED))?.agents.map((a) => a.id)).toEqual(['fresh']);
      reader.close();
    });
  });

  describe('withoutInterrupted', () => {
    const LAUNCH = '2026-10-07T15:47:42.368Z';
    it('zapas 5 s: agent o ułamek sekundy starszy niż wpis uruchomienia zostaje', () => {
      const early = { id: 'e', done: false, startedAt: '2026-10-07T15:47:41.900Z' };
      const stale = { id: 's', done: false, startedAt: '2026-10-07T15:47:30.000Z' };
      expect(withoutInterrupted([early, stale], LAUNCH)).toEqual([early]);
    });
    it('skończeni, agenci bez czasu startu i zła chwila uruchomienia nie tracą nikogo', () => {
      const done = { id: 'd', done: true, startedAt: '2026-10-07T10:00:00.000Z' };
      const unknown = { id: 'u', done: false };
      expect(withoutInterrupted([done, unknown], LAUNCH)).toEqual([done, unknown]);
      const stale = { id: 's', done: false, startedAt: '2026-10-07T10:00:00.000Z' };
      expect(withoutInterrupted([stale], 'nie-data')).toEqual([stale]);
    });
  });

  describe('openRuns (driver)', () => {
    it('wznowienie z niezamkniętym starym zadaniem: liczy się PÓŹNIEJSZE uruchomienie', () => {
      const state = createTasksState();
      state.raw = [
        { id: 'w9djfqfga', kind: 'workflow', runId: RUN, startedAt: '2026-10-07T11:46:23.342Z' },
        { id: 'wok14c0zm', kind: 'workflow', runId: RUN, startedAt: '2026-10-07T15:47:42.368Z' },
        { id: 'bash1', kind: 'command', startedAt: '2026-10-07T16:00:00.000Z' },
        { id: 'w-bez-czasu', kind: 'workflow', runId: 'wf_inny-1' },
      ];
      expect(openRuns(state)).toEqual([
        { runId: RUN, launchedAt: '2026-10-07T15:47:42.368Z' },
        { runId: 'wf_inny-1' },
      ]);
    });
  });

  /*
   * Follower woła `noteTasks` także wtedy, gdy lista się nie zmieniła (koniec bez startu). Manager
   * po każdej liście rozsyła `session-changed`, więc w górę ma iść tylko lista INNA niż poprzednia.
   */
  describe('noteTasks: w górę jedzie tylko lista, która się zmieniła', () => {
    const WORKFLOW: BackgroundTask = {
      id: 'wl4g4ha1y', kind: 'workflow', runId: RUN, startedAt: '2026-08-28T06:00:00.000Z',
    };
    const BREAKDOWN: WorkflowRun = { phases: ['Faza A'], agents: [{ id: 'a1', done: false }] };

    it('lista z tym samym rozkładem nie wychodzi drugi raz, a po `forgetSession` wychodzi bez rozkładu', async () => {
      const state = createTasksState();
      const lists: BackgroundTask[][] = [];
      let run: WorkflowRun | null = BREAKDOWN;
      const deps: TasksDeps = {
        reader: {
          read: async () => run, repoint: () => undefined, relocated: () => undefined, close: () => undefined,
        },
        agentReader: null,
        // Zegar stoi: każdy odczyt w tym teście rusza od `noteTasks`, nie z ticka.
        scheduler: { setTimeout: () => 0, clearTimeout: () => undefined, now: () => 0 },
        pollMs: 5_000,
        disposed: () => false,
        emit: (tasks) => { lists.push([...tasks]); },
      };
      const settled = async (): Promise<void> => {
        while (state.polling) await new Promise((resolve) => { setTimeout(resolve, 1); });
      };

      noteTasks(state, deps, { tasks: [WORKFLOW] });
      await settled();
      expect(lists).toEqual([[WORKFLOW], [{ ...WORKFLOW, run: BREAKDOWN }]]);

      // Follower powtarza listę: rozkład ten sam, więc w górę nie idzie nic.
      noteTasks(state, deps, { tasks: [WORKFLOW] });
      await settled();
      expect(lists).toHaveLength(2);

      // Nowa sesja silnika: rozkład w kosz. Ta sama lista followera jest teraz INNĄ listą w górę.
      forgetSession(state);
      run = null;
      noteTasks(state, deps, { tasks: [WORKFLOW] });
      await settled();
      expect(lists).toHaveLength(3);
      expect(lists[2]).toEqual([WORKFLOW]);
    });
  });

  it('id spoza wzorca `wf_…` nie prowadzi do żadnego odczytu', async () => {
    await seedTranscript();
    const reader = createWorkflowRunReader({ cwd: CWD, agentSessionId: SESSION, root });
    expect(await reader.read('../../etc')).toBeNull();
    reader.close();
  });
});
