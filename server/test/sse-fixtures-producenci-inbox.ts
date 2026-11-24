/**
 * Golden SSE frames, producers of the Inbox heads: `sse-fixtures-producenci.test.ts` runs them next to its other
 * producers and checks each frame against `shared/fixtures/sse/`. The cards come from `composeCard` over fixed session
 * summaries, the heads from the real `InboxHeads`, and the frames from an `SseHub` stream opened with `inbox=1`, read
 * back from the `data:` field as a client gets them.
 */
import { PROTOCOL_VERSION } from '@rarog/shared';
import type { SessionSummary } from '@rarog/shared';
import { composeCard } from '../src/inbox/card.ts';
import type { InboxCard, ShownTurn } from '../src/inbox/card.ts';
import { InboxHeads } from '../src/inbox/heads.ts';
import { createManager } from '../src/sessions/manager.ts';
import { SseHub, type SseResponse } from '../src/sse.ts';

/** Produced frames: file name in `shared/fixtures/sse/` → frame as the client gets it. */
type Produced = Map<string, unknown>;

/** Collects what the hub writes to one stream and reads the data frames back. */
class InboxSink implements SseResponse {
  readonly chunks: string[] = [];
  writeHead(): unknown { return this; }
  write(chunk: string): boolean { this.chunks.push(chunk); return true; }
  end(): unknown { return this; }
  on(): unknown { return this; }

  frames(): Record<string, unknown>[] {
    return this.chunks.join('').split('\n\n')
      .map((raw) => raw.split('\n').find((line) => line.startsWith('data: '))?.slice(6))
      .filter((data): data is string => data !== undefined)
      .map((data) => JSON.parse(data) as Record<string, unknown>);
  }

  /** The last frame of the type, or a hard error (the scenario went astray). */
  last(type: string): Record<string, unknown> {
    const found = this.frames().filter((frame) => frame.type === type).at(-1);
    if (found === undefined) throw new Error(`no ${type} frame on the stream`);
    return found;
  }
}

/** The card source `InboxHeads` follows: the tracker's `card`, `removed` and `onChange`, driven by the test. */
class CardSource {
  readonly #cards = new Map<string, InboxCard>();
  readonly #removed = new Set<string>();
  readonly #listeners = new Set<(sessionId: string) => void>();

  card(sessionId: string): InboxCard | null { return this.#cards.get(sessionId) ?? null; }
  removed(sessionId: string): boolean { return this.#removed.has(sessionId); }
  onChange(listener: (sessionId: string) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  set(card: InboxCard | null, sessionId: string): void {
    if (card === null) this.#cards.delete(sessionId);
    else this.#cards.set(sessionId, card);
    this.#notify(sessionId);
  }

  remove(sessionId: string): void {
    this.#removed.add(sessionId);
    this.#notify(sessionId);
  }

  #notify(sessionId: string): void {
    for (const listener of this.#listeners) listener(sessionId);
  }
}

const ROOT = '/Users/demo/Projects';

function summary(id: string, state: SessionSummary['state'], stateSince: string, extra: Partial<SessionSummary> = {}):
  SessionSummary {
  return {
    id, cwd: `${ROOT}/${id.replace(/^herdr-/u, '')}`, title: id, state, stateSince,
    createdAt: '2026-10-03T07:30:00.000Z', lastActivityAt: stateSince, ...extra,
  };
}

/** The turn a card shows, as the segment reader gives it (opaque ids, the last assistant entry). */
function turn(turnId: string, text: string, at: string): ShownTurn {
  return { turnId, version: `${turnId}-v1`, text, truncated: false, at };
}

function cardOf(session: SessionSummary, shown: ShownTurn, requestId?: string): InboxCard {
  const card = composeCard(session, shown, () => (requestId === undefined ? undefined : { id: requestId }));
  if (card === null) throw new Error(`${session.id}: no card`);
  return card;
}

/**
 * Inbox heads on a stream opened with `inbox=1`: `inbox-heads` with a result, a permission decision and a failure,
 * then `inbox-head` for a question decision and for a result whose turn moved on, and `inbox-removed` for a card
 * removed on a device. A second stream on a server with no published card gives the empty `inbox-heads`.
 */
export async function produceInbox(out: Produced, dataDir: string): Promise<void> {
  const manager = await createManager({ demo: false, dataDir, gitStatus: null, gitWatcher: null });
  const source = new CardSource();
  const heads = new InboxHeads(source);
  const hub = new SseHub({
    manager, serverStartId: '6a2d9f14-3c7b-4e85-a0d1-9b4e7c2f8a63', protocolVersion: PROTOCOL_VERSION,
    heartbeatMs: 0, inbox: heads,
  });
  const empty = new SseHub({
    manager, serverStartId: '6a2d9f14-3c7b-4e85-a0d1-9b4e7c2f8a63', protocolVersion: PROTOCOL_VERSION,
    heartbeatMs: 0, inbox: new InboxHeads(new CardSource()),
  });
  try {
    await manager.ready;
    hub.start();
    empty.start();

    const atlas = summary('herdr-w1-p1', 'waiting-input', '2026-10-03T08:10:00.000Z');
    source.set(cardOf(atlas, turn('kT3q9sVb1xRm0aLp2wEc7d', 'Tests pass: 1446 of 1446.', '2026-10-03T08:09:58.000Z')),
      atlas.id);
    const birch = summary('herdr-w1-p2', 'waiting-permission', '2026-10-03T08:12:00.000Z', {
      waitingFor: { kind: 'permission', tool: 'Bash', text: 'pnpm test', subject: 'tool' },
    });
    source.set(cardOf(birch, turn('pX8n2cHq5zKe4uTy9bWa1f', 'Running the tests now.', '2026-10-03T08:11:40.000Z'),
      'perm-7f3a91'), birch.id);
    const cedar = summary('herdr-w2-p3', 'error', '2026-10-03T08:05:00.000Z');
    source.set(cardOf(cedar, turn('rB6m1dLs3vQo8iGh0nZx4k', 'Build failed in step two.', '2026-10-03T08:04:30.000Z')),
      cedar.id);

    const stream = new InboxSink();
    hub.openGlobal(stream, undefined, undefined, true);
    out.set('inbox-heads.max.json', stream.last('inbox-heads'));

    const dunes = summary('herdr-w2-p4', 'waiting-question', '2026-10-03T08:14:00.000Z', {
      waitingFor: { kind: 'question', text: 'Which database?', count: 2 },
    });
    source.set(cardOf(dunes, turn('sC9w4fNt7yRj2oEb5mKv8g', 'Two options fit.', '2026-10-03T08:13:50.000Z'),
      'q-2c41'), dunes.id);
    out.set('inbox-head.max.json', stream.last('inbox-head'));

    const later = summary('herdr-w1-p1', 'waiting-input', '2026-10-03T08:20:00.000Z');
    source.set(cardOf(later, turn('tD0x5gPu8zSk3pFc6nLw9h', 'Pushed to main.', '2026-10-03T08:19:57.000Z')),
      later.id);
    out.set('inbox-head.result.json', stream.last('inbox-head'));

    source.remove(birch.id);
    out.set('inbox-removed.max.json', stream.last('inbox-removed'));

    const bare = new InboxSink();
    empty.openGlobal(bare, undefined, undefined, true);
    out.set('inbox-heads.empty.json', bare.last('inbox-heads'));
  } finally {
    hub.closeAll();
    empty.closeAll();
    await manager.dispose();
  }
}
