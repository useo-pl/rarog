/**
 * Zadania w tle po wymianie drivera: droga follower → driver (`merge.ts`) → manager → karta, na PRAWDZIWYCH
 * modułach. Wzór: `herdr-artifacts-integracja.test.ts` (lista artefaktów, ta sama klasa błędu).
 *
 * Wymiana drivera (`re-attached`, powrót gniazda herdr) zachowuje obiekt sesji razem z `backgroundTasks`.
 * Nowy follower i nowy stan `merge.ts` ze startowym pustym podpisem listy nie wysłałyby pustej listy
 * nigdy: karta zostałaby z zadaniami poprzedniej rozmowy (pigułka „w tle”, odmowa restartu,
 * wstrzymany push „gotowe”). Zdania, których pilnuje plik:
 *
 * - inna rozmowa (bez zadań, bez pliku, z plikiem nieczytelnym) i panel poza zasięgiem: lista poprzedniej
 *   rozmowy znika już w karcie rozesłanej przy wymianie;
 * - ta sama rozmowa: lista zostaje do pierwszej wypłaty nowego followera (bez karty bez listy), a ta
 *   wypłata jest autorytatywna, także pusta: zadanie skończone tuż przed wymianą i plik, który zniknął.
 *
 * Atrapą jest wyłącznie gniazdo herdr (`HerdrClient`) i nadzorca.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { foreign } from '@rarog/shared/sentences';
import { appendFile, mkdir, mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HerdrStatus, ServerEvent, SessionSummary } from '@rarog/shared';
import { projectSlug } from '../src/cli-store.ts';
import { createHerdrDriver } from '../src/drivers/herdr-driver.ts';
import { AsyncEventQueue } from '../src/drivers/runtime.ts';
import type { SessionDriver } from '../src/drivers/types.ts';
import { createJsonlFollower } from '../src/herdr/jsonl-follow.ts';
import { assertSendable } from '../src/herdr/commands/guard.ts';
import { sessionIdFor } from '../src/herdr/identity.ts';
import type {
  HerdrAgent, HerdrAgentHandle, HerdrClient, HerdrLifecycleEvent, HerdrPaneEvent, HerdrScreen,
  HerdrSupervisor,
} from '../src/herdr/types.ts';
import type { NoteInput, NotifierLike } from '../src/notify/index.ts';
import { createManager } from '../src/sessions/manager.ts';
import type { HerdrManagerDeps, Manager } from '../src/sessions/manager.ts';

const PANE = 'w9:p74';
const SESSION = '5a1c7e20-3b4d-4f60-9c8e-1d2f3a4b5c6d';
const SESSION_B = '8e2d6f41-9a0b-4c1d-8e2f-3a4b5c6d7e8f';
const SESSION_C = '1f3e5d70-2c4b-4a69-b8d7-6e5f4a3b2c1d';
const TIMING = { batchMs: 10, statTickMs: 8, missingFastMs: 8, missingWindowMs: 200, missingSlowMs: 16 };

/** Gniazdo herdr bez skutków: ten plik nie wysyła do panelu nic i nic z niego nie czyta. */
class QuietClient implements HerdrClient {
  listAgents(): Promise<never> { return Promise.reject(new Error('nieużywane')); }
  getAgent(): Promise<never> { return Promise.reject(new Error('nieużywane')); }
  readScreen(): Promise<HerdrScreen> { return Promise.resolve({ text: '' }); }
  readPaneHistory(): Promise<{ text: string; truncated: boolean }> {
    return Promise.resolve({ text: '', truncated: false });
  }
  prompt(): Promise<void> { return Promise.resolve(); }
  sendFormSubmit(): Promise<void> { return Promise.resolve(); }
  sendModeCycle(): Promise<void> { return Promise.resolve(); }
  pasteText(): Promise<void> { return Promise.resolve(); }
  sendPromptSubmit(): Promise<void> { return Promise.resolve(); }
  sendTrustStep(): Promise<void> { return Promise.resolve(); }
  sendDialogKey(): Promise<void> { return Promise.resolve(); }
  sendTakeBackKey(): Promise<void> { return Promise.resolve(); }
  sendKeys(): Promise<void> { return Promise.resolve(); }
  focus(): Promise<void> { return Promise.resolve(); }
  ping(): Promise<{ version: string; protocol: number }> { return Promise.resolve({ version: '0.8.2', protocol: 20 }); }
}

const at = (minute: number): string => new Date(Date.UTC(2026, 9, 16, 10, minute, 0)).toISOString();

const line = (session: string, entry: Record<string, unknown>): string =>
  `${JSON.stringify({ isSidechain: false, sessionId: session, ...entry })}\n`;

const userText = (session: string, text: string, minute = 0): string =>
  line(session, { type: 'user', timestamp: at(minute), message: { role: 'user', content: text } });

/** Start komendy w tle: wywołanie `Bash` i wynik z `backgroundTaskId` (kształt zmierzony). */
const started = (session: string, id: string, minute: number): string => line(session, {
  type: 'assistant', timestamp: at(minute),
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id: `toolu_${id}`, name: 'Bash', input: { command: 'pnpm test', description: 'Testy', run_in_background: true } }],
  },
}) + line(session, {
  type: 'user', timestamp: at(minute),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${id}`, content: '' }] },
  toolUseResult: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: id },
});

/** Meldunek o końcu komendy: wpis `user` z pochodzeniem, treść gołym napisem (osobna tura). */
const finished = (session: string, id: string, minute: number): string => line(session, {
  type: 'user', timestamp: at(minute), origin: { kind: 'task-notification' },
  message: {
    role: 'user',
    content: `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n`
      + '<summary>Background command "Testy" completed (exit code 0)</summary>\n</task-notification>',
  },
});

const flush = async (rounds = 4): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) await new Promise<void>((resolve) => { setImmediate(resolve); });
};

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
};

/** Cisza dłuższa niż kilka ticków `stat` i okien batchowania — dowód, że czegoś NIE ma. */
const quiet = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 120));

const ids = (summary: SessionSummary | undefined): string[] | undefined =>
  summary?.backgroundTasks?.map((task) => task.id);

describe('zadania w tle po wymianie drivera: follower → driver → manager', () => {
  let base = '';
  let dataDir = '';
  let storeDir = '';
  let cwd = '';
  let manager: Manager | null = null;
  let lifecycle: AsyncEventQueue<HerdrLifecycleEvent>;
  let listeners: Set<(ev: HerdrPaneEvent) => void>;
  /** Bieżąca migawka panelu: `attach` po wymianie drivera bierze ją stąd, jak prawdziwy nadzorca. */
  let current: HerdrAgent;
  let notes: NoteInput[];
  let events: ServerEvent[];
  /** Rozmowy, których pliku follower nie przeczyta (`readRange` oddaje `null`, jak przy odmowie dostępu). */
  let unreadable: Set<string>;
  /** Ile followerów powstało; numer followera to kolejność `attach`. */
  let followers: number;
  /** Followery, które przestały widzieć plik (`readRange` → `null`): stary driver tuż przed wymianą. */
  let frozen: Set<number>;

  const transcript = (session: string): string => join(storeDir, `${session}.jsonl`);

  /** Zapis atomowy (obok + `rename`): follower widzi albo brak pliku, albo całą treść. */
  const createTranscript = async (session: string, content: string): Promise<void> => {
    await writeFile(`${transcript(session)}.partial`, content);
    await rename(`${transcript(session)}.partial`, transcript(session));
  };

  function makeAgent(patch: Partial<HerdrAgent> = {}): HerdrAgent {
    return {
      key: PANE, paneId: PANE, agentSessionId: SESSION, cwd, status: 'idle',
      title: 'testy', stateChangeSeq: 1, mode: 'auto', modeReadAt: 0, inScope: true,
      engine: 'claude', termId: null, tabId: 'w9:t4', launchedByRarog: false, interactiveReady: true,
      ...patch,
    };
  }

  function makeSupervisor(): HerdrSupervisor {
    return {
      events: lifecycle,
      status: (): HerdrStatus => ({ available: true, agentCount: 1, readOnly: false, canLaunch: false }),
      attach: (): SessionDriver => {
        const handle: HerdrAgentHandle = {
          agent: current,
          subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        };
        return createHerdrDriver(handle, {
          client: new QuietClient(),
          audit: { log: () => undefined },
          guard: assertSendable,
          yoloRoots: [],
          now: () => Date.now(),
          sessionId: sessionIdFor(current.key),
          follow: (o) => {
            followers += 1;
            const index = followers;
            return createJsonlFollower({
              ...o, root: join(base, 'store'), watch: false, timing: TIMING,
              io: {
                readRange: async (path, start, length) => {
                  if (frozen.has(index)) return null;
                  if ([...unreadable].some((session) => path.endsWith(`${session}.jsonl`))) return null;
                  const file = await open(path, 'r');
                  try {
                    const buffer = Buffer.alloc(length);
                    const { bytesRead } = await file.read(buffer, 0, length, start);
                    return { text: buffer.subarray(0, bytesRead).toString('utf8'), bytesRead };
                  } finally {
                    await file.close();
                  }
                },
              },
            });
          },
          readAgentFiles: false,
        });
      },
      markSent: () => undefined,
      ensureFreshMode: () => Promise.resolve(current.mode),
      focus: () => Promise.resolve(),
      launch: () => Promise.reject(new Error('launch: nieużywane')),
      closeTab: () => Promise.reject(new Error('closeTab: nieużywane')),
      rarogPaneCount: () => 0,
      liveEngineSessions: () => Promise.resolve(new Set([current.agentSessionId])),
      dispose: () => { lifecycle.close(); },
    };
  }

  const notifier: NotifierLike = {
    note: (input) => { notes.push(input); },
    seen: () => undefined,
    forget: () => undefined, quiet: () => undefined,
  };

  const herdrDeps: HerdrManagerDeps = {
    sessionIdFor, aliasFor: () => undefined, rememberAlias: () => undefined,
    assertSendable: (text) => ({ text, slash: null }), takeSendSlot: () => true,
    writeUploads: () => Promise.resolve([]), writeUploadFiles: () => Promise.resolve([]),
    sweepUploads: () => Promise.resolve(),
  };

  /** Manager z jednym panelem w zasięgu; zwraca id karty. */
  async function build(): Promise<{ mgr: Manager; id: string }> {
    const built = await createManager({
      demo: false, dataDir, projects: [{ path: cwd, name: 'testy' }], projectRoots: [], gitStatus: null,
      gitWatcher: null, liveSessionsReader: () => Promise.resolve(null),
      herdrSupervisor: makeSupervisor(), herdrRoots: [cwd], herdrSend: false, herdrDeps, notifier,
    });
    manager = built;
    await built.ready;
    built.onEvent((_scope, _seq, event) => { events.push(event); });
    lifecycle.push({ type: 'appeared', agent: current });
    await flush();
    const id = built.list().find((s) => s.paneId === PANE)?.id ?? '';
    expect(id).not.toBe('');
    return { mgr: built, id };
  }

  /** Karty `session-changed` tej sesji od indeksu `from` strumienia zdarzeń managera. */
  const cards = (id: string, from = 0): SessionSummary[] => events.slice(from).flatMap((event) => (
    event.type === 'session-changed' && event.session.id === id ? [event.session] : []
  ));

  const reattach = async (agent: HerdrAgent): Promise<void> => {
    current = agent;
    lifecycle.push({ type: 're-attached', agent });
    await flush();
  };

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'rarog-tasks-int-'));
    dataDir = join(base, 'data');
    cwd = join(base, 'projekt');
    storeDir = join(base, 'store', projectSlug(cwd));
    await mkdir(dataDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await mkdir(storeDir, { recursive: true });
    lifecycle = new AsyncEventQueue<HerdrLifecycleEvent>();
    listeners = new Set();
    current = makeAgent();
    notes = [];
    events = [];
    unreadable = new Set();
    followers = 0;
    frozen = new Set();
  });

  afterEach(async () => {
    if (manager !== null) await manager.dispose();
    manager = null;
    await rm(base, { recursive: true, force: true });
  });

  /** Panel z rozmową, w której chodzi komenda `bdluga`; czeka, aż lista dojdzie do karty. */
  async function withTask(): Promise<{ mgr: Manager; id: string }> {
    await createTranscript(SESSION, userText(SESSION, 'puść testy w tle') + started(SESSION, 'bdluga', 1));
    const built = await build();
    await waitFor(() => ids(built.mgr.get(built.id))?.join() === 'bdluga', 'lista po podpięciu');
    return built;
  }

  it('wymiana drivera na inną rozmowę bez zadań: lista poprzedniej znika już w karcie rozesłanej przy wymianie', async () => {
    const { mgr, id } = await withTask();
    await createTranscript(SESSION_B, userText(SESSION_B, 'rozmowa bez zadań', 5));
    const from = events.length;
    // `/clear` w czasie przerwy gniazda herdr: stary driver nie zobaczył `session-changed`.
    await reattach(makeAgent({ agentSessionId: SESSION_B }));
    expect(cards(id, from)[0]?.backgroundTasks).toBeUndefined();
    await waitFor(() => events.slice(from).some((event) => event.type === 'message'), 'historia nowej rozmowy');
    await quiet();
    expect(mgr.get(id)?.backgroundTasks).toBeUndefined();
    expect(cards(id, from).filter((card) => card.backgroundTasks !== undefined)).toEqual([]);
  });

  it('wymiana drivera na inną rozmowę z własnym zadaniem: przychodzi lista nowej rozmowy', async () => {
    const { mgr, id } = await withTask();
    await createTranscript(SESSION_B, userText(SESSION_B, 'inna rozmowa', 5) + started(SESSION_B, 'bnowa', 6));
    const from = events.length;
    await reattach(makeAgent({ agentSessionId: SESSION_B }));
    await waitFor(() => ids(mgr.get(id))?.join() === 'bnowa', 'lista nowej rozmowy');
    await quiet();
    expect(cards(id, from).map((card) => ids(card)?.join() ?? '')).not.toContain('bdluga');
  });

  it('wymiana drivera na inną rozmowę bez pliku (czeka na pierwszy prompt): lista zdjęta', async () => {
    const { mgr, id } = await withTask();
    await reattach(makeAgent({ agentSessionId: SESSION_C }));
    await quiet();
    expect(mgr.get(id)?.backgroundTasks).toBeUndefined();
    // Plik, który powstanie, daje listę nowej rozmowy jak każda zmiana.
    await createTranscript(SESSION_C, userText(SESSION_C, 'pierwszy prompt', 7) + started(SESSION_C, 'bpierwsza', 8));
    await waitFor(() => ids(mgr.get(id))?.join() === 'bpierwsza', 'lista z pliku, który powstał');
  });

  it('wymiana drivera na inną rozmowę, której pliku nie da się przeczytać: lista poprzedniej nie zostaje', async () => {
    const { mgr, id } = await withTask();
    await createTranscript(SESSION_B, userText(SESSION_B, 'plik bez prawa odczytu', 5) + started(SESSION_B, 'bobca', 6));
    unreadable.add(SESSION_B);
    await reattach(makeAgent({ agentSessionId: SESSION_B }));
    // Follower nie wypłaci nic, dopóki nie przeczyta pliku; karta i tak nie niesie listy rozmowy A.
    await quiet();
    expect(mgr.get(id)?.backgroundTasks).toBeUndefined();
  });

  it('wymiana drivera poza zasięg: pole znika już w karcie rozesłanej przy wymianie', async () => {
    const { mgr, id } = await withTask();
    const from = events.length;
    await reattach(makeAgent({ inScope: false }));
    const first = cards(id, from)[0];
    expect(first?.outOfScope).toBe(true);
    expect(first?.backgroundTasks).toBeUndefined();
    await quiet();
    expect(mgr.get(id)?.backgroundTasks).toBeUndefined();
    expect(cards(id, from).filter((card) => card.backgroundTasks !== undefined)).toEqual([]);
  });

  it('wymiana drivera w tej samej rozmowie: lista zostaje i żadna karta nie wychodzi bez niej', async () => {
    const { mgr, id } = await withTask();
    const from = events.length;
    await reattach(makeAgent());
    await waitFor(() => events.slice(from).some((event) => event.type === 'message'), 'historia nowego drivera');
    await quiet();
    expect(ids(mgr.get(id))).toEqual(['bdluga']);
    const sent = cards(id, from);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.filter((card) => card.backgroundTasks === undefined)).toEqual([]);
  });

  /*
   * Zadanie skończone w przerwie gniazda herdr. Stary follower czyta plik także w czasie
   * przerwy (driver zostaje podpięty do `re-attached`), więc koniec zwykle widzi i wysyła sam.
   */
  it('koniec zadania w przerwie gniazda: stary follower zdejmuje listę jeszcze przed wymianą', async () => {
    const { mgr, id } = await withTask();
    lifecycle.push({ type: 'unavailable', reason: foreign('test: gniazdo herdr zamknięte') });
    await flush();
    await appendFile(transcript(SESSION), finished(SESSION, 'bdluga', 3));
    await waitFor(() => mgr.get(id)?.backgroundTasks === undefined, 'lista zdjęta przez stary driver');
    await reattach(makeAgent());
    await quiet();
    expect(mgr.get(id)?.backgroundTasks).toBeUndefined();
  });

  /*
   * Zostaje wyścig: koniec dopisany tuż przed wymianą, którego stary follower nie zdążył wysłać (okno partii,
   * tik `stat`; zdarzenia w buforze przepadają przy `close`). Test zamraża stary follower, a nowy przelicza
   * listę z pliku: wychodzi pusta i musi dojść do karty.
   */
  it('wymiana drivera w tej samej rozmowie po końcu zadania, którego stary follower nie wysłał: lista zdjęta', async () => {
    const { mgr, id } = await withTask();
    frozen.add(followers);
    await appendFile(transcript(SESSION), finished(SESSION, 'bdluga', 3));
    await quiet();
    expect(ids(mgr.get(id))).toEqual(['bdluga']);
    const from = events.length;
    await reattach(makeAgent());
    await waitFor(() => mgr.get(id)?.backgroundTasks === undefined, 'lista zdjęta przez pierwszą wypłatę');
    // Karta wymiany trzyma jeszcze listę (ta sama rozmowa), dopiero wypłata nowego followera ją zdejmuje.
    expect(ids(cards(id, from)[0])).toEqual(['bdluga']);
  });

  it('wymiana drivera w tej samej rozmowie, której plik zniknął w przerwie: pusta wypłata bez pliku zdejmuje listę', async () => {
    const { mgr, id } = await withTask();
    await rm(transcript(SESSION));
    await reattach(makeAgent());
    await waitFor(() => mgr.get(id)?.backgroundTasks === undefined, 'lista zdjęta przez follower bez pliku');
  });
});
