/**
 * Replay of a session that tempts the scheduler into three false "done" banners (CLI 2.1.301).
 *
 * The session: a turn with a stage report ends by starting the next stage's subagent (silence,
 * because the subagent works; the result is owed). The subagent stops at its own background
 * command (final tests), the CLI (2.1.301) reports the standby, the main agent writes "the stage is still
 * running" and ends the turn. Without waiting for the subagent's own command, the turn after
 * a standby alone releases the owed "done", because a subagent in standby is not work: three
 * banners with the chime, and a fourth (#21) armed and cleared within the 15 s window.
 *
 * Fixture `fixtures/herdr/tasks/incydent-gotowe-po-postoju-2.1.301/` to okrojony wyciąg z CAŁEJ
 * sesji: plik główny i pliki szesnastu subagentów, same pola struktury, z prawdziwymi czasami
 * (pochodzenie i reguły okrojenia: `fixtures/herdr/README.md`).
 *
 * Co jest prawdziwe w łańcuchu: reduktor zadań pliku głównego (`reducer.ts`), czytnik plików
 * subagentów (`agent-file.ts`; plik rośnie w rytmie swoich czasów), sklejanie listy i jej zegar
 * 5 s (`merge.ts`), rozpoznanie wejścia tury (`parseImportLine`, `isHiddenTurnInput`), reguły
 * pracy (`work.ts`), harmonogram (`Notifier`, `sessionLook`) i polityka. Odtworzone są tylko trzy
 * rzeczy, z dokładnością podaną przy nich: follower pliku głównego (lista po każdej linii, jak
 * `#syncTasks`), rachunek tury managera (`#noteTurnInput`, `#noteToolCalls`, `nextTurnInput`) i granica tury (koniec
 * z wpisu `turn_duration`, start z pierwszego wejścia, bez karencji herdr 1,5 s).
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BackgroundTask, SessionState, SessionSummary } from '@rarog/shared';
import { projectSlug } from '../src/cli-store.ts';
import { createAgentFileReader } from '../src/herdr/background/agent-file.ts';
import type { OpenedFile } from '../src/herdr/background/agent-file.ts';
import { createTasksState, noteTasks } from '../src/herdr/background/merge.ts';
import type { TasksDeps } from '../src/herdr/background/merge.ts';
import { createBackgroundTasksTracker } from '../src/herdr/background/reducer.ts';
import { holdsOwedDone, tasksHoldingDonePush, waitingOnOwnCommand } from '../src/herdr/background/work.ts';
import { Notifier, PUSH_QUIET_LOG, sessionLook } from '../src/notify/index.ts';
import type { TurnInput } from '../src/notify/policy.ts';
import { Presence } from '../src/notify/presence.ts';
import { isHiddenTurnInput, parseImportLine } from '../src/transcript-import.ts';

const FIXTURE = join(import.meta.dirname, 'fixtures/herdr/tasks/incydent-gotowe-po-postoju-2.1.301');
const SESSION = '00000000-0000-4000-8000-000000000000';
const CWD = '/Users/u/projekt';

/** Linia pliku z chwilą zapisu: najpóźniejszy czas dotąd (załącznik niesie czas pierwszej kopii meldunku). */
interface Line { readonly raw: string; readonly entry: Record<string, unknown>; readonly at: number }

function load(file: string): Line[] {
  let at = -Infinity;
  return readFileSync(file, 'utf8').split('\n').filter((raw) => raw !== '').map((raw) => {
    const entry = JSON.parse(raw) as Record<string, unknown>;
    const time = Date.parse(String(entry['timestamp']));
    if (Number.isFinite(time)) at = Math.max(at, time);
    return { raw, entry, at };
  });
}

const MAIN = load(join(FIXTURE, 'glowny.jsonl'));
/** Plik subagenta jako bajty i granice linii z chwilą zapisu: czytnik widzi tyle, ile było w pliku „teraz". */
const AGENT_FILES = new Map(readdirSync(join(FIXTURE, 'subagents')).map((name) => {
  const lines = load(join(FIXTURE, 'subagents', name));
  let size = 0;
  const ends = lines.map((line) => ({ at: line.at, end: (size += Buffer.byteLength(`${line.raw}\n`)) }));
  return [name, { bytes: Buffer.from(lines.map((line) => `${line.raw}\n`).join('')), ends }] as const;
}));

let root = '';
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'rarog-incydent-gotowe-'));
  mkdirSync(join(root, projectSlug(CWD), SESSION, 'subagents'), { recursive: true });
  writeFileSync(join(root, projectSlug(CWD), `${SESSION}.jsonl`), '{}\n');
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const iso = (ms: number): string => new Date(ms).toISOString();

/** Koniec tury tak, jak zobaczył go harmonogram. */
interface TurnEnd {
  readonly at: string;
  readonly turnInput: TurnInput | undefined;
  readonly tasks: readonly BackgroundTask[];
}

interface Replay {
  readonly turns: TurnEnd[];
  /** Chwile startu tury (pierwsze wejście albo koniec bez widzianego wejścia). */
  readonly starts: string[];
  /** Wysłane banery: chwila i rodzaj. */
  readonly sent: string[];
  /** Każdy werdykt harmonogramu (linia logu) z chwilą i listą zadań z tej chwili. */
  readonly verdicts: { at: string; line: string; tasks: readonly BackgroundTask[] }[];
  /** Każda lista zadań wysłana w górę przez `merge.ts`, z chwilą. */
  readonly lists: { at: string; tasks: readonly BackgroundTask[] }[];
}

/**
 * Cała sesja przez łańcuch serwera. `rule: 'stara'` to harmonogram bez faktu
 * `waitingOnOwnCommand` (ani przy końcu tury, ani przy sprawdzeniu) i bez ciszy w tle (`quiet`).
 * `rule: 'nowa'` to dzisiejsza produkcja: oba fakty, a manager woła `quiet`, gdy lista przestaje
 * wstrzymywać zaległe „gotowe" (`holdsOwedDone`).
 */
async function replay(rule: 'nowa' | 'stara'): Promise<Replay> {
  let now = MAIN[0]?.at ?? 0;
  const timers: { at: number; id: number; fn: () => void }[] = [];
  let nextTimer = 1;
  const schedule = (fn: () => void, ms: number): number => {
    timers.push({ at: now + ms, id: nextTimer, fn });
    return nextTimer++;
  };
  const unschedule = (handle: unknown): void => {
    const at = timers.findIndex((timer) => timer.id === handle);
    if (at !== -1) timers.splice(at, 1);
  };

  const visible = (name: string): number => {
    let size = 0;
    for (const end of AGENT_FILES.get(name)?.ends ?? []) {
      if (end.at > now) break;
      size = end.end;
    }
    return size;
  };
  const reader = createAgentFileReader({
    cwd: CWD, agentSessionId: SESSION, root, logger: () => undefined,
    open: (path): Promise<OpenedFile> => {
      const name = path.split('/').at(-1) ?? '';
      const file = AGENT_FILES.get(name);
      if (file === undefined) return Promise.reject(new Error(`ENOENT ${name}`));
      return Promise.resolve({
        stat: () => Promise.resolve({ size: visible(name), ino: 1, dev: 1 }),
        read: (buffer, offset, length, position) => {
          const bytesRead = Math.max(0, Math.min(length, file.bytes.length - position));
          file.bytes.copy(buffer, offset, position, position + bytesRead);
          return Promise.resolve({ bytesRead });
        },
        close: () => Promise.resolve(),
      });
    },
  });

  const out: Replay = { turns: [], starts: [], sent: [], verdicts: [], lists: [] };
  let tasks: readonly BackgroundTask[] = [];
  const state = createTasksState();
  const deps: TasksDeps = {
    reader: null, agentReader: reader,
    scheduler: { setTimeout: (fn, ms) => schedule(fn, ms), clearTimeout: unschedule, now: () => now },
    pollMs: 5_000, disposed: () => false,
    emit: (list) => {
      // Manager przy `background-tasks`: warunek przed i po podmianie listy, `quiet` przy spadku.
      const held = holdsOwedDone(tasks);
      tasks = [...list];
      out.lists.push({ at: iso(now), tasks });
      if (rule === 'nowa' && held && !holdsOwedDone(tasks)) notifier.quiet('s');
    },
  };
  /** Odczyt plików subagentów jest asynchroniczny: czekamy na jego koniec przed następnym zdarzeniem. */
  const settle = async (): Promise<void> => {
    for (let spins = 0; spins < 3 || state.polling; spins += 1) {
      if (spins > 10_000) throw new Error('odczyt plików subagentów nie kończy się');
      await new Promise((resolve) => { setImmediate(resolve); });
    }
  };

  let sessionState: SessionState = 'waiting-input';
  const look = (): SessionSummary => ({
    state: sessionState, seen: false, ...(tasks.length > 0 ? { backgroundTasks: [...tasks] } : {}),
  } as SessionSummary);
  const notifier = new Notifier({
    presence: new Presence({ now: () => now }),
    sink: {
      send: (content) => {
        out.sent.push(`${iso(now)} ${content.kind}`);
        return Promise.resolve({ channels: { apns: 'delivered' } });
      },
    },
    look: () => {
      const facts = sessionLook(look());
      return facts === undefined || rule === 'nowa' ? facts : { ...facts, waitingOnOwnCommand: false };
    },
    log: (line) => { out.verdicts.push({ at: iso(now), line, tasks }); },
    setTimeout: schedule,
    clearTimeout: unschedule,
  });

  const runTimers = async (until: number): Promise<void> => {
    for (;;) {
      timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const due = timers[0];
      if (due === undefined || due.at > until) break;
      timers.shift();
      now = due.at;
      due.fn();
      await settle();
    }
    now = Math.max(now, until);
  };

  // Follower pliku głównego: lista po każdej linii, gdy zmieniła się ona, końce bez startu albo początek okna.
  const tracker = createBackgroundTasksTracker();
  let sentKey = JSON.stringify(tracker.tasks);
  let endsSent = 0;
  let sinceSent = '';
  // Rachunek tury managera: niepełny po podpięciu, od zera po każdym końcu (pusty → znów niepełny).
  let turn: TurnInput | undefined;
  let inTurn = false;
  const startTurn = (): void => {
    inTurn = true;
    sessionState = 'running';
    out.starts.push(iso(now));
    notifier.note({
      sessionId: 's', event: { type: 'agent-working' }, backgroundTasks: tasksHoldingDonePush(tasks), project: 'p',
    });
  };

  for (const line of MAIN) {
    await runTimers(line.at);
    tracker.note(line.entry);
    const key = JSON.stringify(tracker.tasks);
    const ended = tracker.unstartedEnds.slice(endsSent);
    if (key !== sentKey || ended.length > 0 || (tracker.tasks.length > 0 && tracker.firstEntryAt !== sinceSent)) {
      sentKey = key;
      endsSent = tracker.unstartedEnds.length;
      sinceSent = tracker.firstEntryAt;
      noteTasks(state, deps, {
        tasks: [...tracker.tasks], ...(ended.length > 0 ? { ended } : {}), ...(sinceSent === '' ? {} : { since: sinceSent }),
      });
      await settle();
    }

    const parsed = parseImportLine(line.raw);
    const message = parsed?.role === 'user' ? parsed.message : null;
    if (message !== null || isHiddenTurnInput(line.entry)) {
      if (turn !== undefined) {
        if (message?.notice?.outcome === 'waiting') turn = { ...turn, standbyNotices: turn.standbyNotices + 1 };
        else if (message?.notice?.kind === 'artifact-watch') turn = { ...turn, artifactWatch: turn.artifactWatch + 1 };
        else turn = { ...turn, other: turn.other + 1 };
      }
      if (!inTurn) startTurn();
    }
    // Wywołania narzędzi głównego agenta, jak `#noteToolCalls` managera.
    if (turn !== undefined && parsed?.role === 'assistant' && parsed.message !== null) {
      const calls = parsed.message.blocks.filter((block) => block.type === 'tool-call').length;
      if (calls > 0) turn = { ...turn, toolCalls: turn.toolCalls + calls };
    }

    if (line.entry['type'] === 'system' && line.entry['subtype'] === 'turn_duration') {
      if (!inTurn) startTurn();
      inTurn = false;
      sessionState = 'waiting-input';
      out.turns.push({ at: iso(now), turnInput: turn, tasks });
      notifier.note({
        sessionId: 's', event: { type: 'agent-idle' }, backgroundTasks: tasksHoldingDonePush(tasks), project: 'p',
        ...(turn === undefined ? {} : { turnInput: turn }),
        ...(rule === 'nowa' && waitingOnOwnCommand(tasks) ? { waitingOnOwnCommand: true } : {}),
      });
      const empty = turn !== undefined && turn.standbyNotices === 0 && turn.artifactWatch === 0 && turn.other === 0;
      turn = empty ? undefined : { standbyNotices: 0, artifactWatch: 0, other: 0, toolCalls: 0, compactions: 0 };
    }
  }
  await runTimers(now + 60_000);
  reader.close();
  return out;
}

/** Subagent w postoju i jego własne komendy, tak jak stoją na liście. */
const standing = (tasks: readonly BackgroundTask[]): string[] => tasks.flatMap((task) => (
  task.kind === 'agent' && task.waitingSince !== undefined
    ? [`${task.id}: ${(task.ownTasks ?? []).map((own) => own.id).join(',')}`] : []));

/** Końce tur po samym postoju subagenta, numerowane od zera jak w pomiarze. */
const STANDBY_ONLY = [2, 9, 12, 14, 21];
/** Fałszywe „gotowe" według starej reguły: koniec tury + 15 s. */
const FALSE_DONE = ['2026-10-16T13:56:00.225Z done', '2026-10-16T14:51:43.473Z done', '2026-10-16T15:48:59.553Z done'];
/** Jedyne prawdziwe „gotowe" sesji: po bramce testów, gdy w tle nic już nie ma (#27). */
const TRUE_DONE = '2026-10-17T14:35:58.155Z done';
const HELD = `${PUSH_QUIET_LOG} p (done, turn after a subagent standby alone, owed waits: the subagent waits for its own command)`;
/** Cisza w tle bez tury: uzbrojenie z zapamiętanej treści i jego zgaszenie przez wybudzonego agenta. */
const QUIET_ARMED = 'push: armed done for p (check in 15 s, owed after the background went quiet)';
const WOKE = `${PUSH_QUIET_LOG} p (done, state=waiting-input, working in the background: 1)`;
/** Końce komendy subagenta, po których Rarog widzi jego wybudzenie dopiero po ticku 5 s (świadomy koszt odczytu listy). */
const WAKE_WINDOWS = [
  '2026-10-16T14:00:26.115Z', '2026-10-16T14:57:32.008Z', '2026-10-16T15:53:24.260Z', '2026-10-17T10:19:44.898Z',
];
const plus15 = (at: string): string => iso(Date.parse(at) + 15_000);

describe('„gotowe" po turze z samym postojem przy subagencie z własną komendą', () => {
  let fresh: Replay;
  let old: Replay;
  /**
   * Limit hooka: dwa odtworzenia sesji czekają obrotami pętli zdarzeń (`settle`), więc czas rośnie
   * z obciążeniem maszyny. Zmierzone: CI Ubuntu 0,45–0,66 s, CI macOS 4,6 s, Mac bez obciążenia 1,9 s,
   * Mac z symulatorami iOS innej sesji (load average ~40) do 9,7 s, czyli tuż pod domyślnymi 10 s vitest;
   * w pełnym zestawie hook ten limit przekroczył.
   */
  beforeAll(async () => {
    fresh = await replay('nowa');
    old = await replay('stara');
  }, 60_000);

  it('fixture odtwarza sesję: 28 końców tur, pięć po samym postoju', () => {
    expect(fresh.turns).toHaveLength(28);
    const standbyOnly = fresh.turns.flatMap((turn, at) =>
      (turn.turnInput?.standbyNotices === 1 && turn.turnInput.other === 0 ? [at] : []));
    expect(standbyOnly).toEqual(STANDBY_ONLY);
    // Ta sama lista zadań na końcach tur w obu przebiegach: reguła niczego w niej nie zmienia.
    expect(old.turns.map((turn) => turn.tasks)).toEqual(fresh.turns.map((turn) => turn.tasks));
  });

  it('na czterech z tych końców subagent stoi przy własnej komendzie, a w tle nic nie pracuje', () => {
    const at = (index: number): TurnEnd => fresh.turns[index] as TurnEnd;
    expect([9, 12, 14, 21].map((index) => standing(at(index).tasks))).toEqual([
      ['a5f45d11579ce36ef: b2hygygqc'],
      ['a500cf95a336b701b: bk818ysug'],
      ['adaf921a9e8b1cd47: b01ewz9oo'],
      ['aa4d4afc57a1178d3: bojcq0sgz,bigmtbo0w'],
    ]);
    for (const index of [9, 12, 14, 21]) {
      expect(tasksHoldingDonePush(at(index).tasks), `#${String(index)}`).toBe(0);
      expect(waitingOnOwnCommand(at(index).tasks), `#${String(index)}`).toBe(true);
    }
    // #02: postój obok PRACUJĄCEGO subagenta — cisza z dawnego powodu (praca w tle), bez tej reguły.
    expect(tasksHoldingDonePush(at(2).tasks)).toBe(1);
  });

  it('stara reguła: trzy fałszywe „gotowe" (#09, #12, #14), #21 uzbrojone i zdjęte w oknie 15 s', () => {
    expect(old.sent).toEqual([...FALSE_DONE, TRUE_DONE]);
    const armed = old.verdicts.filter((verdict) => verdict.line.startsWith('push: armed done'));
    expect(armed.map((verdict) => verdict.at)).toEqual([
      '2026-10-16T13:55:45.225Z', '2026-10-16T14:51:28.473Z', '2026-10-16T15:48:44.553Z',
      '2026-10-17T10:19:30.929Z', '2026-10-17T14:35:43.155Z',
    ]);
    expect(old.verdicts.find((verdict) => verdict.at === '2026-10-17T10:19:45.929Z')?.line)
      .toBe(`${PUSH_QUIET_LOG} p (done, state=waiting-input, working in the background: 1)`);
  });

  it('nowa reguła: zero „gotowe" do raportu etapu, jedno po #27', () => {
    expect(fresh.sent).toEqual([TRUE_DONE]);
    // Werdykty końców tur; linie ciszy w tle sprawdza test niżej.
    expect(fresh.verdicts.filter(({ line }) => line !== QUIET_ARMED && line !== WOKE)
      .map((verdict) => `${verdict.at} ${verdict.line}`)).toEqual([
      `2026-10-16T13:55:45.225Z ${HELD}`,
      `2026-10-16T14:51:28.473Z ${HELD}`,
      `2026-10-16T15:48:44.553Z ${HELD}`,
      `2026-10-17T10:19:30.929Z ${HELD}`,
      '2026-10-17T14:35:43.155Z push: armed done for p (check in 15 s)',
      '2026-10-17T14:35:58.155Z push: done for p — APNs: SENT',
    ]);
  });

  /*
   * Każda lista z `merge.ts` i każdy werdykt. Okno, w którym agent stoi z `waitingSince` i pustym
   * `ownTasks` (komenda skończona w kolejce pliku głównego, wybudzenie jeszcze nieodczytane z jego
   * pliku), w tej sesji istnieje. Koniec tury w nie nie trafia; trafia cisza w tle — i to jest
   * świadomy koszt: uzbrojenie, które kontrola po 15 s gasi, bo agent już pracuje.
   */
  it('żadne „gotowe" nie wychodzi, gdy na liście stoi subagent w postoju; uzbraja tylko cisza w oknie wybudzenia', () => {
    const quietWindows = fresh.lists.filter(({ tasks }) => standing(tasks).some((agent) => agent.endsWith(': ')));
    expect(quietWindows.length, 'okna „czeka bez komendy” w sesji').toBeGreaterThan(0);
    // Żaden koniec tury w takie okno nie trafia: na każdym agent w postoju ma jeszcze swoją komendę.
    expect(fresh.turns.flatMap((turn) => standing(turn.tasks)).filter((agent) => agent.endsWith(': '))).toEqual([]);
    const loud = (replayed: Replay, what: RegExp): string[] => replayed.verdicts
      .filter(({ line, tasks }) => what.test(line) && standing(tasks).length > 0)
      .map(({ at }) => at);
    expect(loud(fresh, /^push: done for/)).toEqual([]);
    expect(loud(fresh, /^push: armed done/)).toEqual(WAKE_WINDOWS);
    // Stara reguła łamie to na każdym fałszywym „gotowe".
    expect(loud(old, /^push: (armed done|done for)/)).toHaveLength(7);
  });

  /*
   * Manager woła `quiet`, gdy lista przestaje wstrzymywać
   * zaległe „gotowe". W tej sesji dzieje się to przy każdym końcu subagenta (raport budzi głównego
   * agenta, start tury zdejmuje uzbrojenie) i przy każdym końcu komendy subagenta w postoju (agent
   * wstaje, kontrola po 15 s go widzi). Żadne z tych uzbrojeń nie kończy się banerem.
   */
  it('cisza w tle: każde uzbrojenie gaśnie startem tury albo przy sprawdzeniu, zero dodatkowych „gotowe"', () => {
    const armed = fresh.verdicts.filter(({ line }) => line === QUIET_ARMED).map(({ at }) => at);
    expect(armed).toHaveLength(18);
    expect(fresh.verdicts.filter(({ line }) => line === WOKE).map(({ at }) => at)).toEqual(WAKE_WINDOWS.map(plus15));
    for (const at of armed) {
      const startedInWindow = fresh.starts.some((start) => start >= at && start < plus15(at));
      expect(startedInWindow || WAKE_WINDOWS.includes(at), `uzbrojenie ${at}`).toBe(true);
    }
    // Stara reguła ciszy w tle nie zna.
    expect(old.verdicts.filter(({ line }) => line === QUIET_ARMED)).toEqual([]);
  });
});
