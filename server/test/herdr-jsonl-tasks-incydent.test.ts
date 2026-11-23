/**
 * Odtworzenie żywej sesji na reduktorze zadań w tle (`herdr/background/reducer.ts`).
 *
 * Subagent (`a52b91f105b002e8d`, CLI 2.1.295) pracował z przerwami 8,5 godziny: 29 razy stawał,
 * czekając na własną komendę w tle, raz skończył i 6 razy został wznowiony. Reduktor nie może
 * zamknąć jego wpisu przy pierwszym postoju.
 *
 * Fixture `fixtures/herdr/tasks/incydent-postoj-agenta-2.1.295.jsonl` to okrojony wyciąg z pliku
 * głównego tamtej sesji: same wpisy o zadaniach, w kolejności zapisu, z prawdziwymi czasami
 * (pochodzenie i reguły okrojenia: `fixtures/herdr/README.md`). Test podaje go reduktorowi linia
 * po linii i po KAŻDEJ linii porównuje stan agenta z tym, co pokazywało CLI:
 * po starcie i po każdym wznowieniu „pracuje", po każdym postoju „czeka", po końcu wpisu nie ma.
 *
 * Wzorzec (`cliState`) jest napisany osobno od reduktora i celowo naiwnie: kopię poznaje po
 * dokładnie tym samym napisie, a dopisek po zdaniu wpisanym tu z ręki. Żeby sam nie mógł się
 * pomylić po cichu, jego wynik przypinają liczby z pomiaru i pięć kotwic czasowych.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BackgroundTask } from '@rarog/shared';
import { createBackgroundTasksTracker } from '../src/herdr/background/reducer.ts';

type Json = Record<string, unknown>;

const AGENT = 'a52b91f105b002e8d';
const LINES: Json[] = readFileSync(
  join(import.meta.dirname, 'fixtures/herdr/tasks/incydent-postoj-agenta-2.1.295.jsonl'), 'utf8',
).split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as Json);

const record = (value: unknown): Json | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : null;
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const tag = (source: string, name: string): string =>
  new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(source)?.[1]?.trim() ?? '';

/** Meldunek niesiony przez linię: kolejka, załącznik albo wpis `user` z napisem; `''` = brak. */
function carried(line: Json): string {
  const candidates = [
    text(line['content']), text(record(line['attachment'])?.['prompt']), text(record(line['message'])?.['content']),
  ];
  return candidates.find((candidate) => candidate.includes('<task-notification>')) ?? '';
}

/** Stan agenta: nie ma go na liście, pracuje albo czeka od podanego czasu. */
type State = 'brak' | 'pracuje' | `czeka od ${string}`;

function stateOf(tasks: readonly BackgroundTask[], id: string): State {
  const task = tasks.find((item) => item.id === id);
  if (task === undefined) return 'brak';
  return task.waitingSince === undefined ? 'pracuje' : `czeka od ${task.waitingSince}`;
}

/** Zdarzenie agenta w jednej linii, tak jak pokazywało je CLI. */
type Happened = 'start' | 'wznowienie' | 'postój' | 'koniec' | 'kopia' | null;

/**
 * Wzorzec: co linia znaczy dla agenta `id` i w jakim stanie go zostawia. Kopia to linia, której
 * meldunek (cały napis) już stał w pliku wcześniej.
 */
function cliOracle(id: string): (line: Json, before: State) => { happened: Happened; state: State } {
  const seen = new Set<string>();
  return (line, before) => {
    const result = record(line['toolUseResult']);
    if (result?.['agentId'] === id) return { happened: 'start', state: 'pracuje' };
    if (result?.['resumedAgentId'] === id && result['success'] === true) return { happened: 'wznowienie', state: 'pracuje' };
    const notification = carried(line);
    if (notification === '' || tag(notification, 'task-id') !== id) return { happened: null, state: before };
    if (seen.has(notification)) return { happened: 'kopia', state: before };
    seen.add(notification);
    if (tag(notification, 'note').startsWith('This agent stopped with background work of its own still running.')) {
      return { happened: 'postój', state: `czeka od ${text(line['timestamp'])}` };
    }
    return { happened: 'koniec', state: 'brak' };
  };
}

interface Step { at: string; happened: Happened; expected: State; actual: State }

/** Cały wyciąg przez reduktor, ze stanem agenta `id` po każdej linii. */
function replay(id: string): { steps: Step[]; tasks: readonly BackgroundTask[] } {
  const tracker = createBackgroundTasksTracker();
  const oracle = cliOracle(id);
  const steps: Step[] = [];
  let expected: State = 'brak';
  for (const line of LINES) {
    const next = oracle(line, expected);
    expected = next.state;
    tracker.note(line);
    steps.push({ at: text(line['timestamp']), happened: next.happened, expected, actual: stateOf(tracker.tasks, id) });
  }
  return { steps, tasks: tracker.tasks };
}

describe('żywa sesja: subagent z postojami i wznowieniami', () => {
  const { steps, tasks } = replay(AGENT);
  const count = (happened: Happened): number => steps.filter((step) => step.happened === happened).length;
  /**
   * Stan tuż przed pierwszą linią o czasie `at` i tuż po niej. Po KOLEJNOŚCI ZAPISU, nie po
   * czasie: załącznik niesie czas pierwszej kopii meldunku, więc czasy w pliku nie rosną.
   */
  const around = (at: string): { before: State | undefined; after: State | undefined } => {
    const index = steps.findIndex((step) => step.at === at);
    return { before: steps[index - 1]?.actual, after: steps[index]?.actual };
  };

  it('wyciąg jest tym, co zmierzono: 29 postojów, 6 wznowień, 1 koniec, 33 kopie', () => {
    expect(LINES).toHaveLength(244);
    expect({
      start: count('start'), postoj: count('postój'), wznowienie: count('wznowienie'), koniec: count('koniec'),
      kopia: count('kopia'),
    }).toEqual({ start: 1, postoj: 29, wznowienie: 6, koniec: 1, kopia: 33 });
  });

  /** TEST OBOWIĄZKOWY — kryterium 1 planu, sprawdzane po każdej z 244 linii. */
  it('po każdej linii stan agenta zgadza się z CLI: pracuje, czeka albo go nie ma', () => {
    const wrong = steps.flatMap((step, index) => (step.actual === step.expected ? []
      : [`linia ${String(index + 1)} (${step.at}, ${step.happened ?? 'cudza'}): jest „${step.actual}", ma być „${step.expected}"`]));
    expect(wrong).toEqual([]);
  });

  it('kopia meldunku nigdy nie zmienia stanu agenta', () => {
    const moved = steps.filter((step, index) => step.happened === 'kopia' && step.actual !== steps[index - 1]?.actual);
    expect(moved).toEqual([]);
  });

  it('kotwice z pomiaru: start, pierwszy postój, koniec, wznowienie po końcu, stan na końcu wyciągu', () => {
    // Start: wynik narzędzia `Agent`.
    expect(around('2026-10-09T21:39:58.108Z')).toEqual({ before: 'brak', after: 'pracuje' });
    // Pierwszy postój, 11 minut po starcie — tu Rarog zgubił agenta.
    expect(around('2026-10-09T21:51:18.194Z')).toEqual({ before: 'pracuje', after: 'czeka od 2026-10-09T21:51:18.194Z' });
    // Koniec: agent czekał od ostatniego z trzynastu postojów, wpis znika.
    expect(around('2026-10-09T21:59:27.507Z')).toEqual({ before: 'czeka od 2026-10-09T21:57:44.368Z', after: 'brak' });
    // Wznowienie po końcu: jedyny ślad to wynik `SendMessage`.
    expect(around('2026-10-09T22:05:30.546Z')).toEqual({ before: 'brak', after: 'pracuje' });
    // Ostatnia linia wyciągu to kopia ostatniego postoju.
    expect(steps.at(-1)).toMatchObject({
      at: '2026-10-10T06:26:20.285Z', happened: 'kopia', actual: 'czeka od 2026-10-10T06:26:20.267Z',
    });
  });

  it('agent jest widoczny przez cały incydent poza sześcioma minutami między końcem a wznowieniem', () => {
    const index = (happened: Happened): number => steps.findIndex((step) => step.happened === happened);
    const [started, ended] = [index('start'), index('koniec')];
    const back = steps.findIndex((step, at) => at > ended && step.happened === 'wznowienie');
    expect([started, ended < back]).toEqual([1, true]);
    const absent = steps.flatMap((step, at) => (at >= started && step.actual === 'brak' ? [at] : []));
    expect(absent).toEqual(Array.from({ length: back - ended }, (_unused, offset) => ended + offset));
    expect([steps[ended]?.at, steps[back]?.at]).toEqual(['2026-10-09T21:59:27.507Z', '2026-10-09T22:05:30.546Z']);
  });

  it('wznowiony po końcu wraca z danymi startu, a na końcu wyciągu stoi z nimi w postoju', () => {
    expect(tasks.find((task) => task.id === AGENT)).toEqual({
      id: AGENT, kind: 'agent', description: 'Shared views of panel sections', agentType: 'general-purpose',
      model: 'claude-opus-5-5[1m]', startedAt: '2026-10-09T21:39:58.108Z', waitingSince: '2026-10-10T06:26:20.267Z',
    });
  });
});

describe('żywa sesja: agenci, których start leży przed wyciągiem', () => {
  /**
   * Dwaj inni subagenci tej sesji wystartowali PRZED pierwszą linią wyciągu — dokładnie tak
   * wygląda dla reduktora agent sprzed okna ogona po restarcie Raroga. Obaj są w wyciągu
   * wznawiani; ich stan też ma się zgadzać z CLI po każdej linii.
   */
  it.each(['adf9f89efc18a4bc4', 'a7725f999e73158bc'])('%s: stan zgodny z CLI po każdej linii, bez startu w wyciągu', (id) => {
    const { steps } = replay(id);
    expect(steps.filter((step) => step.happened === 'start')).toEqual([]);
    expect(steps.filter((step) => step.happened === 'wznowienie')).toHaveLength(2);
    expect(steps.filter((step) => step.actual !== step.expected)).toEqual([]);
  });

  it('wpis agenta sprzed wyciągu jest minimalny: opis z meldunku, bez czasu startu, podtypu i modelu', () => {
    const tracker = createBackgroundTasksTracker();
    const seenOpen: BackgroundTask[] = [];
    for (const line of LINES) {
      tracker.note(line);
      const task = tracker.tasks.find((item) => item.id === 'adf9f89efc18a4bc4');
      if (task !== undefined && !seenOpen.includes(task)) seenOpen.push(task);
    }
    expect(seenOpen.length).toBeGreaterThan(0);
    for (const task of seenOpen) {
      expect(Object.keys(task).filter((key) => key !== 'waitingSince').sort()).toEqual(['description', 'id', 'kind']);
      expect(task.kind).toBe('agent');
      expect(task.description).toBe('opis 2 (treść poza fixture)');
    }
  });
});

describe('żywa sesja: cała lista', () => {
  it('żaden oddany obiekt zadania nie zmienia się po fakcie', () => {
    const tracker = createBackgroundTasksTracker();
    const snapshots = new Map<BackgroundTask, string>();
    for (const line of LINES) {
      tracker.note(line);
      for (const task of tracker.tasks) if (!snapshots.has(task)) snapshots.set(task, JSON.stringify(task));
    }
    expect(snapshots.size).toBeGreaterThan(40);
    for (const [task, json] of snapshots) expect(JSON.stringify(task)).toBe(json);
  });

  it('dopiski agentów w wyciągu są wyłącznie znane (licznik nieznanych stoi na zerze)', () => {
    const tracker = createBackgroundTasksTracker();
    for (const line of LINES) tracker.note(line);
    expect(tracker.unknownAgentNotes).toBe(0);
  });

  /**
   * W wyciągu główny agent puścił 9 własnych komend (8 skończyło się meldunkiem, jedną ubił
   * `TaskStop`), a dwaj pozostali subagenci skończyli. Zostaje sam agent incydentu.
   */
  it('na końcu wyciągu jedynym otwartym zadaniem jest agent incydentu, w postoju', () => {
    const tracker = createBackgroundTasksTracker();
    const opened = new Set<string>();
    for (const line of LINES) {
      tracker.note(line);
      for (const task of tracker.tasks) opened.add(`${task.kind}:${task.id}`);
    }
    expect([...opened].filter((key) => key.startsWith('command:'))).toHaveLength(9);
    expect([...opened].filter((key) => key.startsWith('agent:')).sort()).toEqual(
      ['agent:a52b91f105b002e8d', 'agent:a7725f999e73158bc', 'agent:adf9f89efc18a4bc4'],
    );
    expect(tracker.tasks.map((task) => [task.id, task.waitingSince])).toEqual([[AGENT, '2026-10-10T06:26:20.267Z']]);
  });

  /**
   * Końce bez startu. W wyciągu stoją meldunki o 46 komendach; 8 z nich główny
   * agent wystartował sam, pozostałych 38 to własne komendy subagentów: ich start jest w pliku
   * subagenta, więc plik główny zna tylko koniec. Wzorzec niżej liczy to naiwnie, po znacznikach.
   */
  it('reduktor oddaje końce 38 własnych komend subagentów i dwóch agentów sprzed wyciągu, każdy raz', () => {
    const tracker = createBackgroundTasksTracker();
    const startedHere = new Set<string>();
    const commandEnds = new Set<string>();
    for (const line of LINES) {
      tracker.note(line);
      const started = text(record(line['toolUseResult'])?.['backgroundTaskId']);
      if (started !== '') startedHere.add(started);
      const notification = carried(line);
      if (tag(notification, 'summary').startsWith('Background command') && tag(notification, 'status') !== '') {
        commandEnds.add(tag(notification, 'task-id'));
      }
    }
    const ownCommands = [...commandEnds].filter((id) => !startedHere.has(id));
    expect([commandEnds.size, startedHere.size, ownCommands.length]).toEqual([46, 9, 38]);

    const ends = tracker.unstartedEnds;
    expect(new Set(ends).size, 'id oddane dwa razy').toBe(ends.length);
    expect(ends.filter((id) => !id.startsWith('a')).sort()).toEqual(ownCommands.sort());
    // Dwaj agenci sprzed wyciągu skończyli, zanim wyciąg pokazał ich wznowienie.
    expect(ends.filter((id) => id.startsWith('a')).sort()).toEqual(['a7725f999e73158bc', 'adf9f89efc18a4bc4']);
  });
});
