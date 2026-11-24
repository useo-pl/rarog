/**
 * The Inbox of the demo (`server/src/demo/inbox.ts` through `assembleInbox`): cards from the demo sessions' events
 * instead of conversation files, the request id of a seed's permission card, removals in `inbox.json` of the demo
 * data directory, and a demo restart, after which a removal from before matches no card. The demo manager is real
 * and runs on the mock supervisor, without push notifications.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assembleInbox } from '../src/bootstrap/inbox.ts';
import type { InboxAssembly } from '../src/bootstrap/inbox.ts';
import { demoContentEn } from '../src/demo/content/en.ts';
import { INBOX_FILENAME } from '../src/inbox/index.ts';
import type { InboxCard } from '../src/inbox/index.ts';
import { createManager } from '../src/sessions/manager.ts';
import type { Manager } from '../src/sessions/manager.ts';

let dataDir = '';
const closers: (() => Promise<void>)[] = [];

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'rarog-inbox-demo-'));
});

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  await rm(dataDir, { recursive: true, force: true });
});

async function waitFor(test: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!test()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 3));
  }
}

/** One demo start at `now`, sharing the data directory of the test. */
async function start(now: number): Promise<{ manager: Manager; parts: InboxAssembly }> {
  let clock = now;
  const manager = await createManager({ demo: true, demoContent: demoContentEn, dataDir, now: () => (clock += 1) });
  const parts = await assembleInbox({
    config: { inboxEnabled: true, demo: true, dataDir, promptBlock: true }, manager, ready: manager.ready,
    log: () => undefined, debounceMs: 5,
  });
  if (parts === null) throw new Error('the Inbox is off');
  closers.push(async () => {
    parts.inbox.dispose();
    await parts.inbox.flush();
    await manager.dispose();
  });
  await manager.ready;
  return { manager, parts };
}

const cardOf = (parts: InboxAssembly, id: string): InboxCard | null => parts.inbox.card(id);

/** The seeds of the English set with a card: two permission cards and a session that hit the limit. */
const WITH_CARDS = ['demo-fleet-ops', 'demo-map-view', 'demo-willow'];

describe('Inbox in the demo', () => {
  it('cards come from the demo content: decisions with the seed request id, a failure; closed and running none', async () => {
    const { manager, parts } = await start(Date.parse('2026-11-20T10:00:00.000Z'));
    await waitFor(() => WITH_CARDS.every((id) => cardOf(parts, id) !== null), 'demo cards');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(parts.inbox.visibleCards().map((card) => card.sessionId).sort()).toEqual(WITH_CARDS);

    const willow = cardOf(parts, 'demo-willow');
    expect(willow).toMatchObject({
      kind: 'decision', state: 'waiting-permission',
      dialog: { kind: 'permission', requestId: 'demo-perm-willow', waitingFor: { kind: 'permission', tool: 'Bash' } },
    });
    // The seed's turn ends with a tool call, so the card shows the last text before it.
    expect(willow?.text.startsWith('I am changing the order so the write finishes before the notification:')).toBe(true);
    expect(cardOf(parts, 'demo-map-view')).toMatchObject({ kind: 'failed', state: 'limit-reached' });
    for (const session of manager.list().filter((s) => !WITH_CARDS.includes(s.id))) {
      expect(cardOf(parts, session.id), `${session.id} (${session.state})`).toBeNull();
    }
    expect(parts.heads.heads().map((head) => head.sessionId).sort()).toEqual(WITH_CARDS);
  });

  it('a removal lands in `inbox.json` of the demo data directory and does not survive a demo restart', async () => {
    const first = await start(Date.parse('2026-11-20T10:00:00.000Z'));
    await waitFor(() => cardOf(first.parts, 'demo-map-view') !== null, 'failed card');
    const card = cardOf(first.parts, 'demo-map-view');
    if (card === null) throw new Error('no card');
    const result = await first.parts.inbox.remove('demo-map-view', { turnId: card.turnId, version: card.version });
    expect(result).toEqual({ kind: 'done', changed: true });
    expect(first.parts.inbox.removed('demo-map-view')).toBe(true);
    expect(existsSync(join(dataDir, INBOX_FILENAME))).toBe(true);
    await closers.splice(0)[0]?.();

    // The seeds get new times at the next start, so their turns get new ids and the old removal matches nothing.
    const second = await start(Date.parse('2026-11-20T11:00:00.000Z'));
    await waitFor(() => cardOf(second.parts, 'demo-map-view') !== null, 'failed card after the restart');
    expect(cardOf(second.parts, 'demo-map-view')?.turnId).not.toBe(card.turnId);
    expect(second.parts.inbox.removed('demo-map-view')).toBe(false);
  });
});
