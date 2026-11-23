/**
 * The session's scheduled tasks: the path conversation file → reader → herdr driver → manager → card, on REAL
 * modules. A real follower and the real reader over a file in a temporary store, the real driver and manager; only
 * the herdr socket (`HerdrClient`) and the supervisor are fakes. What the file holds:
 *
 * - a cron created in the file shows on the card, deleting the last one clears the field;
 * - the list of a file that already holds crons comes whole at the attach (server restart);
 * - a deletion during a herdr contact gap is gone after the driver swap of the same conversation;
 * - `/clear` gives the list of the new file, also when its carry repeats the tasks;
 * - a driver swap to another conversation whose file holds a cron keeps that cron after the conversation's `init`;
 * - a known file truncated to zero clears the field;
 * - a pane gone ends the card without the field (the tasks die with the process); a lost socket keeps it.
 */
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HerdrStatus, ServerEvent, SessionSummary } from '@rarog/shared';
import { foreign } from '@rarog/shared/sentences';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectSlug } from '../src/cli-store.ts';
import { createHerdrDriver } from '../src/drivers/herdr-driver.ts';
import { AsyncEventQueue } from '../src/drivers/runtime.ts';
import type { SessionDriver } from '../src/drivers/types.ts';
import { assertSendable } from '../src/herdr/commands/guard.ts';
import { sessionIdFor } from '../src/herdr/identity.ts';
import { createJsonlFollower } from '../src/herdr/jsonl-follow.ts';
import type {
  HerdrAgent, HerdrAgentHandle, HerdrClient, HerdrLifecycleEvent, HerdrPaneEvent, HerdrScreen, HerdrSupervisor,
} from '../src/herdr/types.ts';
import { createManager } from '../src/sessions/manager.ts';
import type { HerdrManagerDeps, Manager } from '../src/sessions/manager.ts';
import { cronCarry, cronCreate, cronDelete, cronUserText, withoutModel } from './helpers/cron-lines.ts';

const PANE = 'w9:p74';
const SESSION = '5b1f0c2e-8d3a-4e71-9a62-1c4d7e0f2b93';
const SESSION_B = 'c7e2a914-3f60-4b8d-a1d5-6e9f0b2c4a17';
const TIMING = { batchMs: 10, statTickMs: 8, missingFastMs: 8, missingWindowMs: 200, missingSlowMs: 16 };
/** Signal window of the scheduled task reads in this file (production: 5 s). */
const POLL_MS = 5;
/** A window no test waits for: the driver of the gap never reads again after its first read. */
const NEVER_MS = 3_600_000;

/** A herdr socket without effects: nothing goes to the pane and nothing is read from it. */
class QuietClient implements HerdrClient {
  listAgents(): Promise<never> { return Promise.reject(new Error('unused')); }
  getAgent(): Promise<never> { return Promise.reject(new Error('unused')); }
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

/** Silence longer than several `stat` ticks and read windows: proof that something does NOT come. */
const quiet = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 150));

const ids = (summary: SessionSummary | undefined): string | undefined =>
  summary?.scheduledTasks?.map((task) => task.id).join();

describe('scheduled tasks: file → driver → manager', () => {
  let base = '';
  let storeDir = '';
  let cwd = '';
  let manager: Manager | null = null;
  let lifecycle: AsyncEventQueue<HerdrLifecycleEvent>;
  let listeners: Set<(ev: HerdrPaneEvent) => void>;
  let current: HerdrAgent;
  let events: ServerEvent[];
  /** Signal window of the next attached driver. */
  let pollMs = POLL_MS;

  const transcript = (session: string): string => join(storeDir, `${session}.jsonl`);

  /** Atomic write (beside + `rename`): the follower sees no file or the whole content. */
  const createTranscript = async (session: string, content: string): Promise<void> => {
    await writeFile(`${transcript(session)}.partial`, content);
    await rename(`${transcript(session)}.partial`, transcript(session));
  };

  function makeAgent(patch: Partial<HerdrAgent> = {}): HerdrAgent {
    return {
      key: PANE, paneId: PANE, agentSessionId: SESSION, cwd, status: 'idle', title: 'crons', stateChangeSeq: 1,
      mode: 'auto', modeReadAt: 0, inScope: true, engine: 'claude', termId: null, tabId: 'w9:t4',
      launchedByRarog: false, interactiveReady: true, ...patch,
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
          client: new QuietClient(), audit: { log: () => undefined }, guard: assertSendable, yoloRoots: [],
          now: () => Date.now(), sessionId: sessionIdFor(current.key),
          follow: (o) => createJsonlFollower({ ...o, root: join(base, 'store'), watch: false, timing: TIMING }),
          readAgentFiles: false, scheduledTasksPollMs: pollMs,
        });
      },
      markSent: () => undefined,
      ensureFreshMode: () => Promise.resolve(current.mode),
      focus: () => Promise.resolve(),
      launch: () => Promise.reject(new Error('launch: unused')),
      closeTab: () => Promise.reject(new Error('closeTab: unused')),
      rarogPaneCount: () => 0,
      liveEngineSessions: () => Promise.resolve(new Set([current.agentSessionId])),
      dispose: () => { lifecycle.close(); },
    };
  }

  const herdrDeps: HerdrManagerDeps = {
    sessionIdFor, aliasFor: () => undefined, rememberAlias: () => undefined,
    assertSendable: (text) => ({ text, slash: null }), takeSendSlot: () => true,
    writeUploads: () => Promise.resolve([]), writeUploadFiles: () => Promise.resolve([]),
    sweepUploads: () => Promise.resolve(),
  };

  /** A manager with one pane in scope; returns the card id. */
  async function build(): Promise<{ mgr: Manager; id: string }> {
    const built = await createManager({
      demo: false, dataDir: join(base, 'data'), projects: [{ path: cwd, name: 'crons' }], projectRoots: [],
      gitStatus: null, gitWatcher: null, liveSessionsReader: () => Promise.resolve(null),
      herdrSupervisor: makeSupervisor(), herdrRoots: [cwd], herdrSend: false, herdrDeps,
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

  const reattach = async (agent: HerdrAgent): Promise<void> => {
    current = agent;
    lifecycle.push({ type: 're-attached', agent });
    await flush();
  };

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'rarog-crons-int-'));
    cwd = join(base, 'project');
    storeDir = join(base, 'store', projectSlug(cwd));
    await mkdir(join(base, 'data'), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await mkdir(storeDir, { recursive: true });
    lifecycle = new AsyncEventQueue<HerdrLifecycleEvent>();
    listeners = new Set();
    current = makeAgent();
    events = [];
    pollMs = POLL_MS;
  });

  afterEach(async () => {
    if (manager !== null) await manager.dispose();
    manager = null;
    await rm(base, { recursive: true, force: true });
  });

  it('a cron created in the file shows on the card; deleting the last one clears the field', async () => {
    await createTranscript(SESSION, cronUserText(SESSION, 'remind me later'));
    const { mgr, id } = await build();
    await waitFor(() => events.some((event) => event.type === 'message'), 'history');
    await quiet();
    expect(mgr.get(id)?.scheduledTasks).toBeUndefined();

    await appendFile(transcript(SESSION), cronCreate(SESSION, 'a1b2c3d4', { seconds: 5 }));
    await waitFor(() => ids(mgr.get(id)) === 'a1b2c3d4', 'cron on the card');
    expect(mgr.get(id)?.scheduledTasks?.[0]).toMatchObject({ cron: '13 22 19 11 *', recurring: false });
    await appendFile(transcript(SESSION), cronDelete(SESSION, 'a1b2c3d4', 9));
    await waitFor(() => mgr.get(id)?.scheduledTasks === undefined, 'field gone after CronDelete');
    const last = events.filter((event) => event.type === 'session-changed').at(-1);
    expect(last?.type === 'session-changed' && last.session.scheduledTasks).toBe(undefined);
  });

  it('deleted during a herdr contact gap, then a driver swap of the same conversation → field gone', async () => {
    // The file already holds two crons when the server starts: the list comes whole. Without a model in the file no
    // `init` comes, so only the first payout of the new driver can clear the field.
    await createTranscript(SESSION, withoutModel(
      cronCreate(SESSION, 'a1b2c3d4') + cronCreate(SESSION, 'e5f6a7b8', { seconds: 1 }),
    ));
    pollMs = NEVER_MS;
    const { mgr, id } = await build();
    await waitFor(() => ids(mgr.get(id)) === 'e5f6a7b8,a1b2c3d4', 'list after the attach');
    // Its reads at once (the attach, the follower's first payout, the re-send after `init`) are over.
    await quiet();

    // The old driver does not read any more; the deletions land in the file meanwhile.
    await appendFile(transcript(SESSION), withoutModel(
      cronDelete(SESSION, 'a1b2c3d4', 3) + cronDelete(SESSION, 'e5f6a7b8', 4),
    ));
    await quiet();
    expect(ids(mgr.get(id))).toBe('e5f6a7b8,a1b2c3d4');
    pollMs = POLL_MS;
    await reattach(makeAgent());
    await waitFor(() => mgr.get(id)?.scheduledTasks === undefined, 'field gone after the swap');
  });

  it('`/clear`: the list of the new file, also when its carry repeats the task', async () => {
    await createTranscript(SESSION, cronCreate(SESSION, 'a1b2c3d4', { recurring: true, cron: '*/5 * * * *' }));
    const { mgr, id } = await build();
    await waitFor(() => ids(mgr.get(id)) === 'a1b2c3d4', 'list after the attach');
    await createTranscript(SESSION_B, cronCarry(SESSION_B, [{ id: 'a1b2c3d4' }], 30) + cronUserText(SESSION_B, 'next', 31));
    const from = events.length;
    for (const listener of listeners) listener({ type: 'session-changed', agentSessionId: SESSION_B });
    await waitFor(() => events.slice(from).some((event) => event.type === 'session-changed'
      && event.session.id === id && event.session.scheduledTasks === undefined), 'old list dropped');
    await waitFor(() => ids(mgr.get(id)) === 'a1b2c3d4', 'list of the new file');
    expect(mgr.get(id)?.scheduledTasks?.[0]).toMatchObject({ recurring: true, prompt: 'prompt a1b2c3d4' });
  });

  it('`/clear` into a file without crons: the field is gone and stays gone', async () => {
    await createTranscript(SESSION, cronCreate(SESSION, 'a1b2c3d4'));
    const { mgr, id } = await build();
    await waitFor(() => ids(mgr.get(id)) === 'a1b2c3d4', 'list after the attach');
    await createTranscript(SESSION_B, cronUserText(SESSION_B, 'fresh start', 30));
    for (const listener of listeners) listener({ type: 'session-changed', agentSessionId: SESSION_B });
    await waitFor(() => mgr.get(id)?.scheduledTasks === undefined, 'field gone');
    await quiet();
    expect(mgr.get(id)?.scheduledTasks).toBeUndefined();
  });

  it('driver swap to another conversation whose file holds a cron: the cron stays after that conversation\'s `init`', async () => {
    await createTranscript(SESSION, cronCreate(SESSION, 'a1b2c3d4'));
    const { mgr, id } = await build();
    await waitFor(() => ids(mgr.get(id)) === 'a1b2c3d4', 'list after the attach');
    await createTranscript(SESSION_B, cronCreate(SESSION_B, 'b0b0b0b0', { seconds: 40 }));
    // `/clear` during the gap: the old driver did not see `session-changed`.
    await reattach(makeAgent({ agentSessionId: SESSION_B }));
    await waitFor(() => ids(mgr.get(id)) === 'b0b0b0b0', 'cron of the new conversation');
    // The follower's `init` of conversation B comes after its file is read and drops the list on the card once.
    await quiet();
    expect(ids(mgr.get(id))).toBe('b0b0b0b0');
  });

  it('a known file truncated to zero → the field is gone', async () => {
    await createTranscript(SESSION, cronCreate(SESSION, 'a1b2c3d4'));
    const { mgr, id } = await build();
    await waitFor(() => ids(mgr.get(id)) === 'a1b2c3d4', 'list after the attach');
    // Lets the attach reads end, so the truncation also goes through the follower's file, not only a read under way.
    await quiet();
    await writeFile(transcript(SESSION), '');
    await waitFor(() => mgr.get(id)?.scheduledTasks === undefined, 'field gone after the truncation');
  });

  it('a pane gone ends the card without the field; a lost herdr socket keeps it', async () => {
    await createTranscript(SESSION, cronCreate(SESSION, 'a1b2c3d4', { recurring: true, cron: '*/5 * * * *' }));
    const { mgr, id } = await build();
    await waitFor(() => ids(mgr.get(id)) === 'a1b2c3d4', 'list after the attach');

    lifecycle.push({ type: 'unavailable', reason: foreign('socket closed') });
    await flush();
    expect(ids(mgr.get(id))).toBe('a1b2c3d4');

    const from = events.length;
    lifecycle.push({ type: 'gone', key: PANE });
    await waitFor(() => mgr.get(id)?.state === 'done', 'card done');
    expect(mgr.get(id)?.scheduledTasks).toBeUndefined();
    const cards = events.slice(from).flatMap((event) => event.type === 'session-changed' && event.session.id === id
      ? [event.session] : []);
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.filter((card) => card.scheduledTasks !== undefined)).toEqual([]);
  });
});
