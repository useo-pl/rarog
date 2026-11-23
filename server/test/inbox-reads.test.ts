/**
 * Card reads of the Inbox tracker (`server/src/inbox/inbox.ts`) over the session manager fake (`fake-manager.ts`) and a
 * conversation file on disk: a read that cannot tell that the conversation has no result keeps the card's text while
 * its kind follows the state, a sessions snapshot without a session forgets its card at once, the card in `starting`
 * and `running` while the next turn is in progress, remove and restore that receive or take back the result only after
 * a read that confirmed the card's turn under an unmoved session, the dialog identity of a decision card next to a
 * consent card the fold never saw, and the log line of a slow read.
 */
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerEvent, SessionState, WaitingFor } from '@rarog/shared';
import { INBOX_FILENAME, INBOX_SLOW_READ_MS, Inbox, createSegmentReader } from '../src/inbox/index.ts';
import type { InboxCard, SegmentReader, SegmentReaderOptions } from '../src/inbox/index.ts';
import { FakeManager, makeSummary } from './fake-manager.ts';
import { agentLine, artifactWatchLine, toolLines, userLine } from './helpers/plik-rozmowy.ts';

/** Called with the path of every `writeFile`; a test sets it to act while `inbox.json` is being written. */
const writes = vi.hoisted(() => ({ hook: null as ((file: string) => void) | null }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const writeFile: typeof real.writeFile = (file, ...rest) => {
    writes.hook?.(String(file));
    return real.writeFile(file, ...rest);
  };
  return { ...real, writeFile };
});

const SESSION = 'sess-inbox';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';

/** One finished turn with a tool call: its card shows "answer 1". */
const FIRST_TURN = userLine('prompt 1', 1) + toolLines(2) + agentLine('answer 1', 3);
/** A turn that leaves no result: the end of an artifact watch and a short answer, two messages. */
const NO_RESULT = artifactWatchLine(8) + agentLine('nothing to do', 8);

let base = '';
let file = '';
const disposers: (() => void)[] = [];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'rarog-inbox-reads-'));
  file = join(base, `${CONVERSATION}.jsonl`);
});

afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose();
  writes.hook = null;
  await rm(base, { recursive: true, force: true });
});

interface Rig {
  readonly manager: FakeManager;
  readonly inbox: Inbox;
  /** Lines the tracker logged. */
  readonly lines: string[];
  /** Reads every listed session again and waits until that read has finished. */
  read(): Promise<void>;
  /** Waits until the session's card satisfies `test`; returns it. */
  cardWhere(test: (card: InboxCard | null) => boolean, label: string): Promise<InboxCard | null>;
  /** Moves the session to `state` the way the manager reports it (`session-changed`). */
  moveTo(state: SessionState): void;
}

async function waitFor(test: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!test()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
}

const locate = (_cwd: string, conversation: string): Promise<string | null> =>
  Promise.resolve(conversation === CONVERSATION ? file : null);

/** The real reader of {@link CONVERSATION} with switches; any other conversation is unreadable. */
interface ControlledReader {
  readonly reader: SegmentReader;
  /** Reads that start from now on take the file as it is at their start and return it only at `release()`. */
  hold(): void;
  release(): void;
  /** Reads waiting for `release()` with the file they took. */
  held(): number;
  /** Every read from now on finds the file unreadable. */
  unreadable(): void;
  /** Reads so far, by engine conversation. */
  readonly reads: Map<string, number>;
}

function controlled(): ControlledReader {
  const real = createSegmentReader({ locate, promptBlock: true, limit: 500, maxBytes: 1024 * 1024 });
  const reads = new Map<string, number>();
  let gate: Promise<void> | null = null;
  let open = (): void => undefined;
  let waiting = 0;
  let broken = false;
  return {
    reads,
    hold: () => { gate = new Promise((resolve) => { open = resolve; }); },
    release: () => { gate = null; open(); },
    held: () => waiting,
    unreadable: () => { broken = true; },
    reader: async (cwd, conversation) => {
      reads.set(conversation, (reads.get(conversation) ?? 0) + 1);
      if (broken || conversation !== CONVERSATION) return { kind: 'unreadable' };
      const read = await real(cwd, conversation);
      const held = gate;
      if (held !== null) {
        waiting += 1;
        await held;
        waiting -= 1;
      }
      return read;
    },
  };
}

/** The tracker over the fake; `reader` narrows the read window, `readSegments` replaces the reader. */
function build(
  reader: Partial<SegmentReaderOptions> = {}, readSegments?: SegmentReader, opts: { debounceMs?: number } = {},
): Rig {
  const manager = new FakeManager([makeSummary({ id: SESSION, cwd: base, state: 'waiting-input' })]);
  manager.conversations.set(SESSION, CONVERSATION);
  const lines: string[] = [];
  let reads = 0;
  const inbox = new Inbox({
    dataDir: join(base, 'data'),
    readSegments: readSegments ?? createSegmentReader({
      locate, promptBlock: true, limit: 500, maxBytes: 1024 * 1024, ...reader,
    }),
    log: (line) => { lines.push(line); },
    debounceMs: opts.debounceMs ?? 5,
    timing: () => { reads += 1; },
  }, manager);
  manager.onEvent((scope, _seq, event) => { inbox.noteEvent(scope, event); });
  manager.onConversationChange((sessionId) => { inbox.noteConversation(sessionId); });
  disposers.push(() => { inbox.dispose(); });
  return {
    manager, inbox, lines,
    async read() {
      const from = reads;
      inbox.refreshAll();
      await waitFor(() => reads > from, 'a card read');
    },
    async cardWhere(test, label) {
      await waitFor(() => test(inbox.card(SESSION)), label);
      return inbox.card(SESSION);
    },
    moveTo(state) {
      const session = manager.sessions.get(SESSION);
      if (session === undefined) throw new Error('no session');
      const moved = { ...session, state, stateSince: new Date().toISOString() };
      manager.sessions.set(SESSION, moved);
      manager.emit('global', null, { type: 'session-changed', session: moved });
    },
  };
}

describe('inbox reads: a read that cannot tell there is no result keeps the card', () => {
  it.each([
    // The window stops at its byte ceiling inside the no-result turns.
    ['the byte ceiling', { firstWindow: 1024, maxBytes: 2048 }, 10],
    // The window holds the file from its first byte, but the message ceiling drops the turn with the result.
    ['the message ceiling', { limit: 6 }, 4],
  ] as const)('a window cut by %s without a result keeps the card as it was', async (_name, reader, turns) => {
    await writeFile(file, FIRST_TURN);
    const rig = build(reader);
    rig.inbox.refreshAll();
    const before = await rig.cardWhere((c) => c?.text === 'answer 1', 'card of the first turn');
    await appendFile(file, NO_RESULT.repeat(turns));
    await rig.read();
    expect(rig.inbox.card(SESSION)).toEqual(before);
  });
});

describe('inbox reads: a read that proves nothing keeps the text, and the kind follows the state', () => {
  it.each([
    ['waiting-permission', 'decision'],
    ['waiting-question', 'decision'],
    ['error', 'failed'],
    ['limit-reached', 'failed'],
    ['interrupted', 'failed'],
  ] as const)('an unreadable file in %s gives a %s card with the text of the last result', async (state, kind) => {
    await writeFile(file, FIRST_TURN);
    const { reader, unreadable } = controlled();
    const rig = build({}, reader);
    rig.inbox.refreshAll();
    const before = await rig.cardWhere((c) => c?.text === 'answer 1', 'result card');
    unreadable();
    rig.moveTo(state);
    const card = await rig.cardWhere((c) => c?.state === state, `card in ${state}`);
    expect(card).toMatchObject({
      kind, turnId: before?.turnId, text: 'answer 1', at: rig.manager.get(SESSION)?.stateSince,
    });
    expect(card?.version).not.toBe(before?.version);
  });

  it('a window cut without a result in waiting-permission gives a decision card with the text of the last result', async () => {
    await writeFile(file, FIRST_TURN);
    const rig = build({ firstWindow: 1024, maxBytes: 2048 });
    rig.inbox.refreshAll();
    const before = await rig.cardWhere((c) => c?.text === 'answer 1', 'result card');
    await appendFile(file, NO_RESULT.repeat(10));
    rig.moveTo('waiting-permission');
    const card = await rig.cardWhere((c) => c?.state === 'waiting-permission', 'decision card');
    expect(card).toMatchObject({ kind: 'decision', turnId: before?.turnId, text: 'answer 1' });
  });
});

describe('inbox reads: another engine conversation', () => {
  /** The engine conversation after `/clear` or `/resume`; its file cannot be read. */
  const OTHER = '44444444-4444-4444-8444-444444444444';

  it('an unreadable file of the new conversation keeps no card of the previous one', async () => {
    await writeFile(file, FIRST_TURN);
    const { reader, reads } = controlled();
    const rig = build({}, reader);
    rig.inbox.refreshAll();
    await rig.cardWhere((c) => c?.text === 'answer 1', 'card of the first conversation');
    rig.manager.changeConversation(SESSION, OTHER);
    await waitFor(() => (reads.get(OTHER) ?? 0) > 0, 'a read of the new conversation');
    await rig.read();
    expect(rig.inbox.card(SESSION)).toBeNull();
    expect(rig.inbox.visibleCards()).toEqual([]);
  });

  it('a read of the previous conversation that ends after the change publishes nothing', async () => {
    await writeFile(file, FIRST_TURN);
    const { reader, hold, release, reads } = controlled();
    const rig = build({}, reader);
    rig.inbox.refreshAll();
    await rig.cardWhere((c) => c?.text === 'answer 1', 'card of the first conversation');
    hold();
    const before = reads.get(CONVERSATION) ?? 0;
    rig.inbox.refreshAll();
    await waitFor(() => (reads.get(CONVERSATION) ?? 0) > before, 'a held read of the first conversation');
    rig.manager.changeConversation(SESSION, OTHER);
    release();
    await waitFor(() => (reads.get(OTHER) ?? 0) > 0, 'a read of the new conversation');
    await rig.read();
    expect(rig.inbox.card(SESSION)).toBeNull();
  });
});

describe('inbox reads: sessions snapshot', () => {
  it('a session absent from a fresh sessions snapshot loses its card at once, without a read', async () => {
    await writeFile(file, FIRST_TURN);
    const rig = build();
    rig.inbox.refreshAll();
    await rig.cardWhere((c) => c !== null, 'card');
    rig.manager.sessions.delete(SESSION);
    rig.manager.emit('global', null, { type: 'sessions-snapshot', sessions: rig.manager.list() });
    expect(rig.inbox.card(SESSION)).toBeNull();
    expect(rig.inbox.visibleCards()).toEqual([]);
  });
});

describe('inbox reads: working states', () => {
  it.each(['starting', 'running'] as const)('in %s the card of the last result stays with that state', async (state) => {
    await writeFile(file, FIRST_TURN);
    const rig = build();
    rig.inbox.refreshAll();
    const before = await rig.cardWhere((c) => c?.text === 'answer 1', 'result card');
    // The next turn has its prompt and nothing else yet.
    await appendFile(file, userLine('prompt 2', 9));
    rig.moveTo(state);
    const working = await rig.cardWhere((c) => c?.state === state, `card in ${state}`);
    expect(working).toEqual({ ...before, state });
    expect(rig.inbox.visibleCards()).toEqual([working]);
  });
});

describe('inbox reads: the turn in progress', () => {
  /** The next turn has its prompt, a tool call and the first half of its reply: a segment with a result and text. */
  const HALF_TURN = userLine('prompt 2', 9) + toolLines(10) + agentLine('half of answer 2', 11);

  it.each(['starting', 'running'] as const)('in %s the unfinished reply of the next turn does not replace the card', async (state) => {
    await writeFile(file, FIRST_TURN);
    const rig = build();
    rig.inbox.refreshAll();
    const before = await rig.cardWhere((c) => c?.text === 'answer 1', 'result card');
    await appendFile(file, HALF_TURN);
    rig.moveTo(state);
    const working = await rig.cardWhere((c) => c?.state === state, `card in ${state}`);
    expect(working).toEqual({ ...before, state });
  });

  it('a removed result stays removed while the next turn runs, and the end of that turn shows it', async () => {
    await writeFile(file, FIRST_TURN);
    const rig = build();
    rig.inbox.refreshAll();
    const before = await rig.cardWhere((c) => c?.text === 'answer 1', 'result card');
    expect(await rig.inbox.remove(SESSION, { turnId: before!.turnId, version: before!.version }))
      .toEqual({ kind: 'done', changed: true });
    await appendFile(file, HALF_TURN);
    rig.moveTo('running');
    await rig.cardWhere((c) => c?.state === 'running', 'card while the turn runs');
    await rig.read();
    expect(rig.inbox.card(SESSION)?.turnId).toBe(before?.turnId);
    expect(rig.inbox.removed(SESSION)).toBe(true);

    await appendFile(file, agentLine('answer 2', 12));
    rig.moveTo('waiting-input');
    const next = await rig.cardWhere((c) => c?.state === 'waiting-input', 'card of the next turn');
    expect(next?.turnId).not.toBe(before?.turnId);
    expect(next?.text).toContain('answer 2');
    expect(rig.inbox.removed(SESSION)).toBe(false);
  });
});

describe('inbox reads: remove and restore act on the card as it is now', () => {
  /** The next turn, ended: its card shows "answer 2". */
  const SECOND_TURN = userLine('prompt 2', 9) + toolLines(10) + agentLine('answer 2', 11);
  const marks = (rig: Rig, method: 'markSeen' | 'markUnseen'): number =>
    rig.manager.calls.filter((call) => call.method === method).length;

  /** The next turn ends before the tracker's quiet time has passed: the card it holds still shows the first turn. */
  async function nextTurnEnds(rig: Rig): Promise<void> {
    await appendFile(file, SECOND_TURN);
    rig.moveTo('running');
    await new Promise((resolve) => setTimeout(resolve, 2));
    rig.moveTo('waiting-input');
  }

  it('removing the card of the previous turn after the next one ended is refused and receives nothing', async () => {
    await writeFile(file, FIRST_TURN);
    const rig = build({}, undefined, { debounceMs: 200 });
    rig.inbox.refreshAll();
    const first = await rig.cardWhere((c) => c?.text === 'answer 1', 'card of the first turn');
    await nextTurnEnds(rig);
    expect(await rig.inbox.remove(SESSION, { turnId: first!.turnId, version: first!.version })).toEqual({ kind: 'stale' });
    expect(marks(rig, 'markSeen')).toBe(0);
    expect(rig.inbox.card(SESSION)?.text).toBe('answer 2');
  });

  it('restoring the card of the previous turn after the next one ended is refused and takes back nothing', async () => {
    await writeFile(file, FIRST_TURN);
    const rig = build({}, undefined, { debounceMs: 200 });
    rig.inbox.refreshAll();
    const first = await rig.cardWhere((c) => c?.text === 'answer 1', 'card of the first turn');
    const ref = { turnId: first!.turnId, version: first!.version };
    expect(await rig.inbox.remove(SESSION, ref)).toEqual({ kind: 'done', changed: true });
    expect(marks(rig, 'markSeen')).toBe(1);
    await nextTurnEnds(rig);
    expect(await rig.inbox.restore(SESSION, ref)).toEqual({ kind: 'stale' });
    expect(marks(rig, 'markUnseen')).toBe(0);
  });

  /** The next turn runs and ends while a read is held with the file of the first turn. */
  async function nextTurnEndsDuring(rig: Rig, held: ControlledReader): Promise<void> {
    await waitFor(() => held.held() > 0, 'a held read');
    await appendFile(file, SECOND_TURN);
    rig.moveTo('running');
    await new Promise((resolve) => setTimeout(resolve, 2));
    rig.moveTo('waiting-input');
    held.release();
  }

  it('a removal whose read returns the first turn after the next one ended is refused and receives nothing', async () => {
    await writeFile(file, FIRST_TURN);
    const held = controlled();
    const rig = build({}, held.reader, { debounceMs: 200 });
    rig.inbox.refreshAll();
    const first = await rig.cardWhere((c) => c?.text === 'answer 1', 'card of the first turn');
    held.hold();
    const removal = rig.inbox.remove(SESSION, { turnId: first!.turnId, version: first!.version });
    await nextTurnEndsDuring(rig, held);
    expect(await removal).toEqual({ kind: 'stale' });
    expect(marks(rig, 'markSeen')).toBe(0);
    expect(rig.inbox.removed(SESSION)).toBe(false);
  });

  it('a restore whose read returns the first turn after the next one ended is refused and takes back nothing', async () => {
    await writeFile(file, FIRST_TURN);
    const held = controlled();
    const rig = build({}, held.reader, { debounceMs: 200 });
    rig.inbox.refreshAll();
    const first = await rig.cardWhere((c) => c?.text === 'answer 1', 'card of the first turn');
    const ref = { turnId: first!.turnId, version: first!.version };
    expect(await rig.inbox.remove(SESSION, ref)).toEqual({ kind: 'done', changed: true });
    held.hold();
    const restore = rig.inbox.restore(SESSION, ref);
    await nextTurnEndsDuring(rig, held);
    expect(await restore).toEqual({ kind: 'stale' });
    expect(marks(rig, 'markUnseen')).toBe(0);
    expect(rig.inbox.removed(SESSION)).toBe(true);
  });

  it('removing the kept card after an unreadable read hides it and receives nothing', async () => {
    await writeFile(file, FIRST_TURN);
    const { reader, unreadable } = controlled();
    const rig = build({}, reader, { debounceMs: 200 });
    rig.inbox.refreshAll();
    const first = await rig.cardWhere((c) => c?.text === 'answer 1', 'card of the first turn');
    unreadable();
    await nextTurnEnds(rig);
    expect(await rig.inbox.remove(SESSION, { turnId: first!.turnId, version: first!.version }))
      .toEqual({ kind: 'done', changed: true, receipt: 'skipped' });
    expect(marks(rig, 'markSeen')).toBe(0);
    expect(rig.inbox.removed(SESSION)).toBe(true);
    await rig.inbox.flush();
    const stored = JSON.parse(await readFile(join(base, 'data', INBOX_FILENAME), 'utf8')) as { removed: object[] };
    expect(stored.removed).toEqual([expect.not.objectContaining({ seen: true })]);
  });

  it('restoring after an unreadable read brings the card back and takes back nothing', async () => {
    await writeFile(file, FIRST_TURN);
    const { reader, unreadable } = controlled();
    const rig = build({}, reader, { debounceMs: 200 });
    rig.inbox.refreshAll();
    const first = await rig.cardWhere((c) => c?.text === 'answer 1', 'card of the first turn');
    const ref = { turnId: first!.turnId, version: first!.version };
    expect(await rig.inbox.remove(SESSION, ref)).toEqual({ kind: 'done', changed: true });
    expect(marks(rig, 'markSeen')).toBe(1);
    unreadable();
    expect(await rig.inbox.restore(SESSION, ref)).toEqual({ kind: 'done', changed: true, receipt: 'skipped' });
    expect(marks(rig, 'markUnseen')).toBe(0);
    expect(rig.inbox.removed(SESSION)).toBe(false);
  });

  it('restoring while the next turn runs brings the card back and takes back nothing', async () => {
    await writeFile(file, FIRST_TURN);
    const rig = build();
    rig.inbox.refreshAll();
    const first = await rig.cardWhere((c) => c?.text === 'answer 1', 'card of the first turn');
    const ref = { turnId: first!.turnId, version: first!.version };
    expect(await rig.inbox.remove(SESSION, ref)).toEqual({ kind: 'done', changed: true });
    await appendFile(file, userLine('prompt 2', 9));
    rig.moveTo('running');
    await rig.cardWhere((c) => c?.state === 'running', 'card while the next turn runs');
    expect(await rig.inbox.restore(SESSION, ref)).toEqual({ kind: 'done', changed: true, receipt: 'skipped' });
    expect(marks(rig, 'markUnseen')).toBe(0);
    expect(rig.inbox.removed(SESSION)).toBe(false);
  });

  it('a session that leaves waiting-input during the write is not marked, and its removal keeps no receipt', async () => {
    await writeFile(file, FIRST_TURN);
    const rig = build();
    rig.inbox.refreshAll();
    const card = await rig.cardWhere((c) => c?.text === 'answer 1', 'result card');
    writes.hook = (path) => {
      if (!path.endsWith(`${INBOX_FILENAME}.tmp`)) return;
      writes.hook = null;
      rig.moveTo('waiting-permission');
    };
    expect(await rig.inbox.remove(SESSION, { turnId: card!.turnId, version: card!.version }))
      .toEqual({ kind: 'done', changed: true, receipt: 'skipped' });
    expect(rig.manager.get(SESSION)?.state).toBe('waiting-permission');
    expect(marks(rig, 'markSeen')).toBe(0);
    await rig.inbox.flush();
    const stored = JSON.parse(await readFile(join(base, 'data', INBOX_FILENAME), 'utf8')) as { removed: object[] };
    expect(stored.removed).toEqual([expect.not.objectContaining({ seen: true })]);
  });
});

describe('inbox reads: the dialog of a decision card', () => {
  /** A consent channel card of the session stream that waits for a person. */
  const consent = (permId: string, command: string): ServerEvent => ({
    type: 'permission-pending',
    request: {
      permId, sessionId: SESSION, toolName: 'Bash', displayText: command, risk: 'normal', cwd: base,
      createdAt: '2026-11-20T10:00:00.000Z', channel: 'hook', state: 'pending',
    },
  });
  const bash = (command: string): WaitingFor => ({ kind: 'permission', tool: 'Bash', text: command, subject: 'tool' });

  /** The session waits for a permission, and its summary describes the card `waitingFor`, as the manager does. */
  function describes(rig: Rig, waitingFor: WaitingFor): void {
    const session = rig.manager.sessions.get(SESSION);
    if (session === undefined) throw new Error('no session');
    const stateSince = session.state === 'waiting-permission' ? session.stateSince : new Date().toISOString();
    const next = { ...session, state: 'waiting-permission' as const, stateSince, waitingFor };
    rig.manager.sessions.set(SESSION, next);
    rig.manager.emit('global', null, { type: 'session-changed', session: next });
  }

  it('a card the summary describes but the fold never saw keeps the summary identity; its removal hides no later card', async () => {
    await writeFile(file, FIRST_TURN);
    const rig = build();
    rig.inbox.refreshAll();
    await rig.cardWhere((c) => c?.text === 'answer 1', 'result card');
    // h1 came back from the consent records at start, before anyone listened: only the summary describes it. h2
    // arrives behind it.
    describes(rig, bash('pnpm build'));
    rig.manager.emit(SESSION, 1, consent('h2', 'pnpm test'));
    const first = await rig.cardWhere((c) => c?.kind === 'decision', 'decision card of h1');
    expect(first?.dialog).toEqual({ kind: 'permission', waitingFor: bash('pnpm build') });
    expect(await rig.inbox.remove(SESSION, { turnId: first!.turnId, version: first!.version }))
      .toEqual({ kind: 'done', changed: true });

    rig.manager.emit(SESSION, 2, { type: 'permission-resolved', sessionId: SESSION, permId: 'h1', decision: 'allow', by: 'Mac' });
    describes(rig, bash('pnpm test'));
    const second = await rig.cardWhere(
      (c) => c?.dialog?.kind === 'permission' && c.dialog.waitingFor?.text === 'pnpm test', 'decision card of h2',
    );
    expect(second?.dialog).toEqual({ kind: 'permission', waitingFor: bash('pnpm test'), requestId: 'h2' });
    expect(rig.inbox.removed(SESSION)).toBe(false);
    expect(rig.inbox.visibleCards()).toEqual([second]);
  });
});

describe('inbox reads: slow read', () => {
  /** The real reader, `delayMs` late. */
  const late = (delayMs: number): SegmentReader => {
    const real = createSegmentReader({ locate, promptBlock: true, limit: 500, maxBytes: 1024 * 1024 });
    return async (cwd, conversation) => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return real(cwd, conversation);
    };
  };

  it('a read over the threshold logs one line with the session and no text of the card', async () => {
    await writeFile(file, FIRST_TURN);
    const rig = build({}, late(INBOX_SLOW_READ_MS + 50));
    await rig.read();
    expect(rig.lines).toHaveLength(1);
    expect(rig.lines[0]).toContain(SESSION);
    expect(rig.lines[0]).not.toContain('answer 1');
  });

  it('a fast read logs nothing', async () => {
    await writeFile(file, FIRST_TURN);
    const rig = build({}, late(0));
    await rig.read();
    expect(rig.inbox.card(SESSION)?.text).toBe('answer 1');
    expect(rig.lines).toEqual([]);
  });
});
