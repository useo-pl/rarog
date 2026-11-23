/**
 * The follower's `meta` event against the session card (`herdr/jsonl-follow.ts`, `#noteMeta` and `#drainState`).
 *
 * The events go through the real path to the card: `metaInitEvent` (`drivers/herdr/transcript.ts`) builds the
 * driver's `init` and `applyInitEvent` (`sessions/driver-events.ts`) applies it. A live model change sets the card
 * first (`model-set`, which the manager copies field by field), and only a model or effort the follower newly read
 * from the file may override it afterwards: a flush caused by ultracode or by the mode alone must not put back the
 * values of the last assistant entry.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectSlug } from '../src/cli-store.ts';
import { metaInitEvent } from '../src/drivers/herdr/transcript.ts';
import type { DriverEvent } from '../src/drivers/types.ts';
import { createJsonlFollower } from '../src/herdr/jsonl-follow.ts';
import type { FollowEvent, JsonlFollower } from '../src/herdr/jsonl-follow.ts';
import { ULTRACODE_RESULT } from '../src/herdr/ultracode.ts';
import { applyInitEvent } from '../src/sessions/driver-events.ts';
import type { InitPort } from '../src/sessions/driver-events.ts';
import type { Session } from '../src/sessions/session.ts';

const CWD = '/Users/u/Projects/atlas';
const SESSION = '7d2dd80f-012c-5c17-b97d-cf436a305158';
const TIMING = {
  batchMs: 15, statTickMs: 8, missingFastMs: 8, missingWindowMs: 200, missingSlowMs: 16,
};
/** Process start given to the follower: earlier than every entry below, so the ultracode marker counts. */
const PROCESS_START = Date.parse('2026-08-22T09:59:00.000Z');

let root = '';
let dir = '';
const followers: JsonlFollower[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rarog-follow-meta-'));
  dir = join(root, projectSlug(CWD));
  await mkdir(dir, { recursive: true });
});

afterEach(async () => {
  for (const follower of followers.splice(0)) follower.close();
  await rm(root, { recursive: true, force: true });
});

const filePath = (): string => join(dir, `${SESSION}.jsonl`);

/** Write next to it and `rename`: the follower sees either no file or the whole content. */
const createTranscript = async (content: string): Promise<void> => {
  await writeFile(`${filePath()}.partial`, content);
  await rename(`${filePath()}.partial`, filePath());
};

const line = (entry: Record<string, unknown>): string => `${JSON.stringify({
  isSidechain: false, sessionId: SESSION, ...entry,
})}\n`;

const userLine = (text: string, timestamp = '2026-08-22T10:00:00.000Z'): string => line({
  type: 'user', timestamp, message: { role: 'user', content: text },
});

const assistantLine = (model: string, effort: string, timestamp: string): string => line({
  type: 'assistant', timestamp, effort,
  message: { role: 'assistant', model, content: [{ type: 'text', text: 'ok' }] },
});

/** The command result `/effort ultracode` leaves in the file. */
const ultracodeOnLine = (timestamp: string): string => userLine(
  `<local-command-stdout>${ULTRACODE_RESULT.on}. Effort stays xhigh.</local-command-stdout>`, timestamp,
);

const metas = (events: readonly FollowEvent[]): Extract<FollowEvent, { type: 'meta' }>[] =>
  events.filter((e): e is Extract<FollowEvent, { type: 'meta' }> => e.type === 'meta');

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
};

const port: InitPort = {
  config: {},
  customTitled: new WeakSet(),
  conversationChanged: () => undefined,
  indexEngineSession: () => undefined,
  applyTransition: () => false,
  emitSessionChanged: () => undefined,
  claimWindows: { holdBlocked: () => false, herdrMoved: () => undefined, conversationChanged: () => undefined },
} as unknown as InitPort;

/** A Claude card waiting for input, fed with the follower's `meta` events the way the driver and manager do it. */
const card = (events: FollowEvent[]): {
  session: Session; sync: () => void; modelSet: (model: string, effort: string) => void;
} => {
  const session = {
    id: 'card-1', state: 'waiting-input', engineSessionId: SESSION, emptyStart: false,
  } as unknown as Session;
  let applied = 0;
  const sync = (): void => {
    for (const meta of metas(events.slice(applied))) {
      const event = metaInitEvent(meta, SESSION);
      if (event !== null) applyInitEvent(session, event as Extract<DriverEvent, { type: 'init' }>, port);
    }
    applied = events.length;
  };
  // `model-set` as the manager applies it: the card takes the commanded values at once.
  const modelSet = (model: string, effort: string): void => {
    sync();
    session.model = model;
    session.effort = effort as Session['effort'];
  };
  return { session, sync, modelSet };
};

const start = async (content: string): Promise<{
  follower: JsonlFollower; events: FollowEvent[]; session: Session; sync: () => void;
  modelSet: (model: string, effort: string) => void;
}> => {
  await createTranscript(content);
  const follower = createJsonlFollower({ cwd: CWD, agentSessionId: SESSION, root, watch: false, timing: TIMING });
  followers.push(follower);
  follower.noteProcessStart(PROCESS_START);
  const events: FollowEvent[] = [];
  void (async () => {
    for await (const event of follower.events) events.push(event);
  })();
  await waitFor(() => metas(events).some((meta) => meta.model !== undefined), 'meta of the last answer');
  return { follower, events, ...card(events) };
};

describe('meta flush after a live model change', () => {
  it('an ultracode-only flush keeps the commanded model and effort on the card', async () => {
    const t = await start(userLine('start') + assistantLine('claude-fable-5', 'low', '2026-08-22T10:00:05.000Z'));
    t.sync();
    expect(t.session).toMatchObject({ model: 'claude-fable-5', effort: 'low' });

    t.modelSet('opus[1m]', 'high');
    const before = t.events.length;
    await appendFile(filePath(), ultracodeOnLine('2026-08-22T10:00:10.000Z'));
    await waitFor(() => metas(t.events.slice(before)).some((meta) => meta.ultracode === true), 'ultracode meta');
    t.sync();

    expect(t.session).toMatchObject({ model: 'opus[1m]', effort: 'high', ultracode: true });
  });

  it('a mode-only flush keeps the commanded model and effort on the card', async () => {
    const t = await start(userLine('start') + assistantLine('claude-fable-5', 'low', '2026-08-22T10:00:05.000Z'));
    t.modelSet('opus[1m]', 'high');
    const before = t.events.length;
    await appendFile(filePath(), line({ type: 'permission-mode', permissionMode: 'bypassPermissions' }));
    await waitFor(() => metas(t.events.slice(before)).some((meta) => meta.mode === 'bypass'), 'mode meta');
    t.sync();

    expect(t.session).toMatchObject({ model: 'opus[1m]', effort: 'high' });
  });

  it('a new assistant entry with another model overrides the alias with the resolved id', async () => {
    const t = await start(userLine('start') + assistantLine('claude-fable-5', 'low', '2026-08-22T10:00:05.000Z'));
    t.modelSet('opus[1m]', 'high');
    const before = t.events.length;
    await appendFile(filePath(), assistantLine('claude-opus-5-5', 'high', '2026-08-22T10:00:20.000Z'));
    await waitFor(() => metas(t.events.slice(before)).length > 0, 'meta of the new answer');
    t.sync();

    expect(t.session).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' });
  });

  it('a new entry that changes only the effort still carries its model, so the alias resolves', async () => {
    const t = await start(userLine('start') + assistantLine('claude-opus-5-5', 'low', '2026-08-22T10:00:05.000Z'));
    t.modelSet('opus[1m]', 'high');
    const before = t.events.length;
    await appendFile(filePath(), assistantLine('claude-opus-5-5', 'high', '2026-08-22T10:00:20.000Z'));
    await waitFor(() => metas(t.events.slice(before)).length > 0, 'meta of the new answer');
    t.sync();

    expect(t.session).toMatchObject({ model: 'claude-opus-5-5', effort: 'high' });
  });
});
