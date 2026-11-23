/**
 * The layer 2 card through the real driver (`docs/dialog-card.md`): a pane blocked on a CLI dialog of class `dialog`
 * whose card has no buttons today. With the flag on, the driver shows a question card under an `l2:` id after two
 * equal reads, writes the `layer2-episode` and `block-card` lines, and sends no key from the card without the proof of
 * the layer 2 step (`layer2-step-driver.test.ts`): here the pane has no registry read, so the send shield refuses every
 * tap and Esc (`class-unknown`), and `allow` is refused outright. With the flag off nothing changes: today's card and
 * no episode line.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DriverEvent } from '../src/drivers/types.ts';
import { STABILITY_GAP_MS } from '../src/herdr/dialogs/layer2/stability.ts';
import { CLI_WAITING_PROBES } from '../src/herdr/dialogs/timing.ts';
import type { HerdrClient } from '../src/herdr/types.ts';
import { FIXTURES, makeDriver, quiet, useDriverSandbox, userLine, waitFor } from './helpers/herdr-driver-atrapy.ts';
import type { Fixture } from './helpers/herdr-driver-atrapy.ts';

useDriverSandbox();

const MARK = '\n--- ekran ---\n';

function screenOf(name: string): string {
  const raw = readFileSync(join(FIXTURES, name), 'utf8');
  const at = raw.indexOf(MARK);
  return at < 0 ? raw : raw.slice(at + MARK.length);
}

/** Effort picker: today a card without buttons, layer 2 reads four choices. */
const PICKER = screenOf('kontrolny/picker-effort-2.1.322.txt');

const CARD_TYPES = new Set<DriverEvent['type']>(['screen-dialog', 'question-request', 'permission-request']);
const cardsOf = (events: readonly DriverEvent[]): DriverEvent[] => events.filter((e) => CARD_TYPES.has(e.type));

async function blockedOnPicker(dialogLayer2: boolean): Promise<Fixture> {
  const fx = await makeDriver({
    transcript: userLine('work'), screen: PICKER, deps: { dialogLayer2, screenCacheMs: 0, sessionId: 'session-test' },
  });
  await waitFor(() => fx.events.some((e) => e.type === 'history'), 'history');
  fx.driver.noteCliWaiting?.({ kind: 'waiting', dialog: 'dialog' });
  fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
  await waitFor(() => cardsOf(fx.events).length > 0, 'card');
  await quiet();
  return fx;
}

describe('layer 2 card in the driver', () => {
  it('flag 1: a question card under an l2 id, the episode line and the block-card line', async () => {
    const fx = await blockedOnPicker(true);
    const cards = cardsOf(fx.events);
    expect(cards.map((card) => card.type)).toEqual(['question-request']);
    const card = cards[0];
    if (card?.type !== 'question-request') throw new Error('no question card');
    expect(card.reqId).toMatch(/^l2:[0-9a-f]{12}$/);
    expect(card.channel).toBe('keys');
    expect(card.questions[0]?.options).toHaveLength(4);
    const episode = fx.audit.filter((entry) => entry.method === 'layer2-episode');
    expect(episode).toEqual([expect.objectContaining({
      sessionId: 'session-test', layer2Verdict: 'choices', optionCount: 0, // digit options of the block: keys only
      episode: expect.stringMatching(/^[0-9a-f]{8}-1$/) as unknown,
      blockTitleSha: expect.stringMatching(/^[0-9a-f]{12}$/) as unknown,
    })]);
    expect(fx.audit.filter((entry) => entry.method === 'block-card')).toEqual([expect.objectContaining({
      reqId: card.reqId, verdict: 'buttons', layer2: true, toolName: 'dialog:layer2',
    })]);
  });

  it('flag 1: a tap on the card without a registry read is refused by the send shield, no key, the card stays', async () => {
    const fx = await blockedOnPicker(true);
    const card = cardsOf(fx.events)[0];
    if (card?.type !== 'question-request') throw new Error('no question card');
    const label = card.questions[0]?.options[0]?.label ?? '';
    expect(await fx.driver.answerQuestion(card.reqId, [[label]])).toEqual(SCREEN_CHANGED);
    await quiet();
    expect(fx.client.mutations).toBe(0);
    expect(fx.audit.filter((entry) => entry.method === 'refuse').map((entry) => [entry.reason, entry.layer2Why]))
      .toEqual([['screen-changed', 'class-unknown']]);
    expect(fx.events.filter((e) => e.type === 'permission-cleared')).toEqual([]);
    // The consent button path has no digit on this card either.
    expect((await fx.driver.respondPermission(card.reqId, 'allow')).kind).toBe('refused');
    await quiet();
    expect(fx.client.mutations).toBe(0);
  });

  it('flag 0: today\'s card without buttons, no layer 2 card and no episode line', async () => {
    const fx = await blockedOnPicker(false);
    expect(cardsOf(fx.events).map((card) => card.type)).toEqual(['screen-dialog']);
    expect(fx.audit.filter((entry) => entry.method === 'layer2-episode')).toEqual([]);
    expect(fx.audit.some((entry) => entry.reqId?.startsWith('l2:') === true)).toBe(false);
  });
});

const TERMINAL_ONLY = { kind: 'refused', reason: 'terminal-only' } as const;
/** A tap or Esc the send shield of the layer 2 step refused (no registry read in these panes). */
const SCREEN_CHANGED = { kind: 'refused', reason: 'screen-changed' } as const;

/** The standing layer 2 card of the fixture. */
function layer2Card(fx: Fixture): Extract<DriverEvent, { type: 'question-request' }> {
  const card = cardsOf(fx.events)[0];
  if (card?.type !== 'question-request') throw new Error('no question card');
  return card;
}

/** Nothing reached the pane: no key, no prompt, no paste, no form submit, no trust step. */
function noKeyNoText(fx: Fixture): void {
  expect(fx.client.calls.filter((call) => call.method !== 'read' && call.method !== 'history')).toEqual([]);
  expect(fx.client.mutations).toBe(0);
}

describe('layer 2 card in the driver: no decision path sends a key without the proof', () => {
  it('deny addressed by the card id: refused by the layer 2 step, no key, the card stays', async () => {
    const fx = await blockedOnPicker(true);
    const card = layer2Card(fx);
    expect(await fx.driver.respondPermission(card.reqId, 'deny')).toEqual(SCREEN_CHANGED);
    await quiet();
    noKeyNoText(fx);
    expect(fx.events.filter((e) => e.type === 'permission-cleared')).toEqual([]);
    expect(fx.audit.filter((entry) => entry.method === 'refuse')).toEqual([expect.objectContaining({
      reason: 'screen-changed', layer2Why: 'class-unknown', toolName: 'dialog:layer2', reqId: card.reqId,
    })]);
  });

  it('deny addressed by the session (the route of POST /api/sessions/:id/permission): refused, no key', async () => {
    const fx = await blockedOnPicker(true);
    // The manager passes the session id as `reqId` (`#decideHerdrDialog`).
    expect(await fx.driver.respondPermission('session-test', 'deny')).toEqual(SCREEN_CHANGED);
    await quiet();
    noKeyNoText(fx);
    expect(fx.events.filter((e) => e.type === 'permission-cleared')).toEqual([]);
  });

  it('allow by the card id and by the session, and an answer with every label: refused, no key, the card stays', async () => {
    const fx = await blockedOnPicker(true);
    const card = layer2Card(fx);
    for (const option of card.questions[0]?.options ?? []) {
      expect(await fx.driver.answerQuestion(card.reqId, [[option.label]])).toEqual(SCREEN_CHANGED);
    }
    expect(await fx.driver.respondPermission(card.reqId, 'allow')).toEqual(TERMINAL_ONLY);
    expect(await fx.driver.respondPermission('session-test', 'allow')).toEqual(TERMINAL_ONLY);
    expect(await fx.driver.respondPermission('session-test', 'allow-always')).toEqual(TERMINAL_ONLY);
    await quiet();
    noKeyNoText(fx);
    expect(fx.events.filter((e) => e.type === 'permission-cleared')).toEqual([]);
  });

  it('a layer 2 card issued while a deny waits in the queue for its read before Esc: no key, `stale-card`', async () => {
    const fx = await makeDriver({
      transcript: userLine('work'), screen: PICKER, deps: { dialogLayer2: true, screenCacheMs: 0, sessionId: 'session-test' },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'history');
    fx.driver.noteCliWaiting?.({ kind: 'waiting', dialog: 'dialog' });
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    // The next screen read is the fresh read of the deny step (before Esc): it waits until the card stands.
    const read = fx.client.readScreen.bind(fx.client);
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let holdNext = true;
    (fx.client as { readScreen: HerdrClient['readScreen'] }).readScreen = async (...args) => {
      if (holdNext) {
        holdNext = false;
        await gate;
      }
      return read(...args);
    };
    expect(cardsOf(fx.events)).toEqual([]);
    const deny = fx.driver.respondPermission('session-test', 'deny');
    await waitFor(() => cardsOf(fx.events).length > 0, 'layer 2 card');
    expect(layer2Card(fx).reqId).toMatch(/^l2:/);
    release();
    // The deny was accepted before the card was issued, so it is bound to no occurrence (`docs/dialog-card.md`).
    expect(await deny).toEqual({ kind: 'refused', reason: 'stale-card' });
    expect(fx.audit.filter((entry) => entry.method === 'refuse').at(-1)).toEqual(expect.objectContaining({
      reason: 'stale-card', layer2Why: 'stale-card', layer2: true,
    }));
    await quiet();
    noKeyNoText(fx);
  });
});

describe('layer 2 card in the driver: occurrence', () => {
  it('the registry reports the dialog closed and opened again under the same herdr lock: a new id', async () => {
    const fx = await makeDriver({
      transcript: userLine('work'), screen: PICKER,
      deps: { dialogLayer2: true, screenCacheMs: 0, sessionId: 'session-test', blockedPollMs: 40 },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'history');
    fx.driver.noteCliWaiting?.({ kind: 'waiting', dialog: 'dialog' });
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => cardsOf(fx.events).length > 0, 'card');
    const first = layer2Card(fx).reqId;
    // herdr reports no new lock and the card stands; only the registry episode tells the dialog was reopened.
    fx.driver.noteCliWaiting?.({ kind: 'active' });
    fx.driver.noteCliWaiting?.({ kind: 'waiting', dialog: 'dialog' });
    await waitFor(() => cardsOf(fx.events).length > 1, 'a card of the reopened dialog');
    const second = cardsOf(fx.events)[1];
    if (second?.type !== 'question-request') throw new Error('no second question card');
    expect(second.reqId).toMatch(/^l2:[0-9a-f]{12}$/);
    expect(second.reqId).not.toBe(first);
    expect(fx.audit.filter((entry) => entry.method === 'layer2-episode').map((entry) => entry.episode?.split('-')[1]))
      .toEqual(['1', '2']);
    noKeyNoText(fx);
  });
});

describe('layer 2 card in the driver: a read counts in the scope it started in', () => {
  interface ReadStart { readonly episode: number; readonly at: number }

  /**
   * The picker pane blocked under the flag, each screen read after the lock noted with the registry episode it
   * started in (the read of the lock itself comes before). Read 2 is the evaluation's retry read (the picker asks
   * for one), the screen that goes to the layer 2 check; `duringRead` runs while it waits and says whether it began
   * a new registry episode.
   */
  async function readsUntilCard(duringRead: (fx: Fixture) => boolean): Promise<ReadStart[]> {
    const fx = await makeDriver({
      transcript: userLine('work'), screen: PICKER,
      deps: { dialogLayer2: true, screenCacheMs: 0, sessionId: 'session-test' },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'history');
    fx.driver.noteCliWaiting?.({ kind: 'waiting', dialog: 'dialog' });
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    let episode = 1;
    const starts: ReadStart[] = [];
    const read = fx.client.readScreen.bind(fx.client);
    (fx.client as { readScreen: HerdrClient['readScreen'] }).readScreen = async (...args) => {
      starts.push({ episode, at: Date.now() });
      if (starts.length === 2) {
        await quiet();
        if (duringRead(fx)) episode += 1;
      }
      return read(...args);
    };
    await waitFor(() => cardsOf(fx.events).length > 0, 'card');
    const card = layer2Card(fx);
    expect(card.reqId).toMatch(/^l2:/);
    return starts;
  }

  it('no scope change: the card after the two reads of the evaluation, as before', async () => {
    const starts = await readsUntilCard(() => false);
    expect(starts.map((start) => start.episode)).toEqual([1, 1, 1]);
  });

  it('a new registry episode during the first read of the pair: the card after two reads of the new one', async () => {
    const starts = await readsUntilCard((fx) => {
      // herdr reports no new lock; the registry closes the dialog and opens it again.
      fx.driver.noteCliWaiting?.({ kind: 'active' });
      fx.driver.noteCliWaiting?.({ kind: 'waiting', dialog: 'dialog' });
      return true;
    });
    // Reads 1 and 2 come before the stability gap: read 2 is the one handed to the check, not a forced read.
    expect((starts[1]?.at ?? 0) - (starts[0]?.at ?? 0)).toBeLessThan(STABILITY_GAP_MS);
    expect(starts.map((start) => start.episode)).toEqual([1, 1, 2, 2]);
  });
});

describe('layer 2 card in the driver: an episode line without a card', () => {
  /** A pane at `idle` while the registry reports a dialog `CLI_WAITING_PROBES` times and every screen read fails. */
  async function idleUnreadable(dialogLayer2: boolean): Promise<{
    fx: Fixture; reads: () => number; readable: () => void;
  }> {
    const fx = await makeDriver({
      transcript: userLine('work'), screen: PICKER, agent: { status: 'idle' },
      deps: { dialogLayer2, screenCacheMs: 0, sessionId: 'session-test' },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'history');
    const read = fx.client.readScreen.bind(fx.client);
    let failing = true;
    let reads = 0;
    (fx.client as { readScreen: HerdrClient['readScreen'] }).readScreen = (...args) => {
      reads += 1;
      return failing ? Promise.reject(new Error('EIO')) : read(...args);
    };
    for (let i = 0; i < CLI_WAITING_PROBES; i += 1) {
      fx.driver.noteCliWaiting?.({ kind: 'waiting', dialog: 'dialog' });
      await quiet();
    }
    return { fx, reads: () => reads, readable: () => { failing = false; } };
  }

  const episodeLines = (fx: Fixture) => fx.audit.filter((entry) => entry.method === 'layer2-episode');

  it('flag 1: the registry fallback ends every evaluation before the card: one none line with no-block', async () => {
    const { fx, reads } = await idleUnreadable(true);
    expect(reads()).toBe(CLI_WAITING_PROBES);
    expect(cardsOf(fx.events)).toEqual([]);
    expect(episodeLines(fx)).toEqual([expect.objectContaining({
      sessionId: 'session-test', layer2Verdict: 'none', layer2Why: 'no-block',
      episode: expect.stringMatching(/^[0-9a-f]{8}-1$/) as unknown,
    })]);
    expect(episodeLines(fx)[0]).not.toHaveProperty('blockTitleSha');
    expect(episodeLines(fx)[0]).not.toHaveProperty('optionCount');
  });

  it('flag 1: a later good read refreshes the verdict of the same episode', async () => {
    const { fx, readable } = await idleUnreadable(true);
    readable();
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => cardsOf(fx.events).length > 0, 'card');
    await quiet();
    const lines = episodeLines(fx);
    expect(lines.map((line) => line.layer2Verdict)).toEqual(['none', 'choices']);
    expect(new Set(lines.map((line) => line.episode)).size).toBe(1);
  });

  it('flag 0: the same pane writes no episode line', async () => {
    const { fx, reads } = await idleUnreadable(false);
    expect(reads()).toBe(CLI_WAITING_PROBES);
    expect(episodeLines(fx)).toEqual([]);
  });
});
