/**
 * Artefakty sesji: droga follower → driver → manager → karta, na PRAWDZIWYCH modułach.
 *
 * Producent złotych ramek wstrzykuje managerowi gotowe zdarzenie drivera `artifacts` i tej drogi nie
 * sprawdza. Tu składamy ją jak `server/src/index.ts`: prawdziwy follower nad plikiem w katalogu
 * tymczasowym, prawdziwy driver herdr i manager; atrapą jest wyłącznie gniazdo herdr (`HerdrClient`)
 * i nadzorca. Zdania, których pilnuje plik:
 *
 * - publikacja i wygaszenie w pliku rozmowy zmieniają pole karty `artifacts`, a stanu sesji, `seen`
 *   ani pushy nie ruszają;
 * - `/clear` (nowa rozmowa w panelu) zdejmuje listę, lista nowej rozmowy przychodzi z jej pliku;
 * - wymiana drivera (powrót gniazda herdr) w tej samej rozmowie zostawia listę bez migotania, a w innej
 *   rozmowie, przy panelu bez pliku i przy panelu poza zasięgiem — nie zostawia listy poprzedniej.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

const PANE = 'w9:p73';
const SESSION = '7d2dd80f-012c-5c17-b97d-cf436a305158';
const SESSION_B = '9f1c4b62-77aa-5d31-8bd0-2c0f6a1e4d55';
const SESSION_C = '3c8e1f07-5b2a-4d96-a1e4-7f0c2b9d6e13';
const TIMING = { batchMs: 10, statTickMs: 8, missingFastMs: 8, missingWindowMs: 200, missingSlowMs: 16 };

const URL_A = 'https://claude.ai/artifact/ArtefaktTestowyH000001';
const URL_B = 'https://claude.ai/artifact/ArtefaktTestowyB000002';

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

/** Wynik publikacji artefaktu (kształt zmierzony): `toolUseResult` obok bloku `tool_result`. */
const published = (session: string, url: string, title: string, minute: number): string => line(session, {
  type: 'user', timestamp: at(minute),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${String(minute)}`, content: 'ok' }] },
  toolUseResult: { url, title, updated: false, artifact_id: url.slice(-22), path: '/private/tmp/x/raport.html' },
});

/** Notka harnessu o usunięciu artefaktu (osobna tura, wpis `user` z pochodzeniem). */
const gone = (session: string, url: string, title: string, minute: number): string => line(session, {
  type: 'user', timestamp: at(minute), origin: { kind: 'task-notification' },
  message: {
    role: 'user',
    content: '<task-notification>\n<task-type>artifact-watch-lifecycle</task-type>\n'
      + `<summary>Stopped watching Artifact: "${title}" (artifact not found)</summary>\n`
      + `<event>Watch on ${url} ended — no such artifact for this account.</event>\n</task-notification>`,
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

const urls = (summary: SessionSummary | undefined): string[] | undefined =>
  summary?.artifacts?.map((item) => (item.gone === true ? `${item.url} (usunięty)` : item.url));

describe('artefakty sesji: follower → driver → manager', () => {
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

  const transcript = (session: string): string => join(storeDir, `${session}.jsonl`);

  /** Zapis atomowy (obok + `rename`): follower widzi albo brak pliku, albo całą treść. */
  const createTranscript = async (session: string, content: string): Promise<void> => {
    await writeFile(`${transcript(session)}.partial`, content);
    await rename(`${transcript(session)}.partial`, transcript(session));
  };

  function makeAgent(patch: Partial<HerdrAgent> = {}): HerdrAgent {
    return {
      key: PANE, paneId: PANE, agentSessionId: SESSION, cwd, status: 'idle',
      title: 'raporty', stateChangeSeq: 1, mode: 'auto', modeReadAt: 0, inScope: true,
      engine: 'claude', termId: null, tabId: 'w9:t3', launchedByRarog: false, interactiveReady: true,
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
          follow: (o) => createJsonlFollower({
            ...o, root: join(base, 'store'), watch: false, timing: TIMING,
            io: {
              readRange: async (path, start, length) => {
                if ([...unreadable].some((session) => path.endsWith(`${session}.jsonl`))) return null;
                const handle = await open(path, 'r');
                try {
                  const buffer = Buffer.alloc(length);
                  const { bytesRead } = await handle.read(buffer, 0, length, start);
                  return { text: buffer.subarray(0, bytesRead).toString('utf8'), bytesRead };
                } finally {
                  await handle.close();
                }
              },
            },
          }),
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
      demo: false, dataDir, projects: [{ path: cwd, name: 'raporty' }], projectRoots: [], gitStatus: null,
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
    base = await mkdtemp(join(tmpdir(), 'rarog-artifacts-int-'));
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
  });

  afterEach(async () => {
    if (manager !== null) await manager.dispose();
    manager = null;
    await rm(base, { recursive: true, force: true });
  });

  /** Panel z rozmową, w której stoi już publikacja `URL_A`; czeka, aż lista dojdzie do karty. */
  async function withArtifact(): Promise<{ mgr: Manager; id: string }> {
    await createTranscript(SESSION, userText(SESSION, 'zrób raport') + published(SESSION, URL_A, 'Raport', 1));
    const built = await build();
    await waitFor(() => urls(built.mgr.get(built.id))?.join() === URL_A, 'lista po podpięciu');
    return built;
  }

  it('publikacja i wygaszenie dochodzą do karty; stan, `seen` i pushe bez zmian', async () => {
    await createTranscript(SESSION, userText(SESSION, 'zrób raport'));
    const { mgr, id } = await build();
    await waitFor(() => events.some((event) => event.type === 'message'), 'historia');
    await quiet();
    expect(mgr.get(id)?.artifacts).toBeUndefined();
    const before = mgr.get(id);
    const notesBefore = notes.length;
    const from = events.length;

    await appendFile(transcript(SESSION), published(SESSION, URL_A, 'Raport', 1));
    await waitFor(() => urls(mgr.get(id))?.join() === URL_A, 'publikacja');
    expect(mgr.get(id)?.artifacts).toEqual([{ url: URL_A, title: 'Raport', publishedAt: at(1) }]);
    await appendFile(transcript(SESSION), published(SESSION, URL_B, 'Deck', 2));
    await waitFor(() => urls(mgr.get(id))?.join() === `${URL_B},${URL_A}`, 'druga publikacja');
    await appendFile(transcript(SESSION), gone(SESSION, URL_A, 'Raport', 3));
    await waitFor(() => urls(mgr.get(id))?.join() === `${URL_B},${URL_A} (usunięty)`, 'wygaszenie');
    await quiet();

    // Karta jedzie ramką `session-changed` z listą; żadna ramka stanu, żaden push.
    expect(cards(id, from).at(-1)?.artifacts?.[1]).toEqual({ url: URL_A, title: 'Raport', publishedAt: at(1), gone: true });
    const after = mgr.get(id);
    expect([after?.state, after?.stateSince, after?.seen]).toEqual([before?.state, before?.stateSince, before?.seen]);
    expect(events.slice(from).filter((event) => event.type === 'state')).toEqual([]);
    expect(notes.length).toBe(notesBefore);
  });

  it('`/clear`: lista znika od razu; lista nowej rozmowy przychodzi z jej pliku', async () => {
    const { mgr, id } = await withArtifact();
    for (const listener of listeners) listener({ type: 'session-changed', agentSessionId: SESSION_B });
    await waitFor(() => mgr.get(id)?.artifacts === undefined, 'pusta lista po /clear');

    await createTranscript(SESSION_B, userText(SESSION_B, 'nowa rozmowa', 5) + published(SESSION_B, URL_B, 'Deck', 6));
    await waitFor(() => urls(mgr.get(id))?.join() === URL_B, 'lista nowej rozmowy');
    await quiet();
    expect(urls(mgr.get(id))).toEqual([URL_B]);
  });

  it('wymiana drivera w tej samej rozmowie: lista zostaje i żadna karta nie wychodzi bez niej', async () => {
    const { mgr, id } = await withArtifact();
    const from = events.length;
    await reattach(makeAgent());
    await waitFor(() => events.slice(from).some((event) => event.type === 'message'), 'historia nowego drivera');
    await quiet();
    expect(urls(mgr.get(id))).toEqual([URL_A]);
    const sent = cards(id, from);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.filter((card) => card.artifacts === undefined)).toEqual([]);
  });

  it('wymiana drivera na inną rozmowę: lista poprzedniej znika już w karcie rozesłanej przy wymianie', async () => {
    const { mgr, id } = await withArtifact();
    await createTranscript(SESSION_B, userText(SESSION_B, 'rozmowa bez artefaktów', 5));
    const from = events.length;
    // `/clear` w czasie przerwy gniazda herdr: stary driver nie zobaczył `session-changed`.
    await reattach(makeAgent({ agentSessionId: SESSION_B }));
    expect(cards(id, from)[0]?.artifacts).toBeUndefined();
    await waitFor(() => events.slice(from).some((event) => event.type === 'message'), 'historia nowej rozmowy');
    await quiet();
    expect(mgr.get(id)?.artifacts).toBeUndefined();
    expect(cards(id, from).filter((card) => card.artifacts !== undefined)).toEqual([]);
  });

  it('wymiana drivera na inną rozmowę, której pliku nie da się przeczytać: lista poprzedniej nie zostaje', async () => {
    const { mgr, id } = await withArtifact();
    await createTranscript(SESSION_B, userText(SESSION_B, 'plik bez prawa odczytu', 5));
    unreadable.add(SESSION_B);
    await reattach(makeAgent({ agentSessionId: SESSION_B }));
    // Follower nie wypłaci nic, dopóki nie przeczyta pliku; karta i tak nie niesie listy rozmowy A.
    await quiet();
    expect(mgr.get(id)?.artifacts).toBeUndefined();
  });

  it('wymiana drivera w tej samej rozmowie, której plik zniknął w przerwie: pusta wypłata bez pliku zdejmuje listę', async () => {
    const { mgr, id } = await withArtifact();
    await rm(transcript(SESSION));
    await reattach(makeAgent());
    await waitFor(() => mgr.get(id)?.artifacts === undefined, 'lista zdjęta przez follower bez pliku');
  });

  it('wymiana drivera przy panelu bez pliku rozmowy (czeka na pierwszy prompt): lista zdjęta od razu', async () => {
    const { mgr, id } = await withArtifact();
    await reattach(makeAgent({ agentSessionId: SESSION_C }));
    await waitFor(() => mgr.get(id)?.artifacts === undefined, 'lista zdjęta bez pliku');
    // Plik, który powstanie, daje listę nowej rozmowy jak każda zmiana.
    await createTranscript(SESSION_C, userText(SESSION_C, 'pierwszy prompt', 7) + published(SESSION_C, URL_B, 'Deck', 8));
    await waitFor(() => urls(mgr.get(id))?.join() === URL_B, 'lista z pliku, który powstał');
  });

  it('wymiana drivera poza zasięg: pole znika już w karcie rozesłanej przy wymianie', async () => {
    const { mgr, id } = await withArtifact();
    const from = events.length;
    await reattach(makeAgent({ inScope: false }));
    const first = cards(id, from)[0];
    expect(first?.outOfScope).toBe(true);
    expect(first?.artifacts).toBeUndefined();
    await quiet();
    expect(mgr.get(id)?.artifacts).toBeUndefined();
    expect(cards(id, from).filter((card) => card.artifacts !== undefined)).toEqual([]);
  });
});
