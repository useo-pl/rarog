/**
 * The layer 2 card module of the driver (`drivers/herdr/layer2-card.ts`, `docs/dialog-card.md`) on a fake port:
 * the pair of equal reads, the occurrence id, the cases without a card and the `layer2-episode` audit line.
 *
 * Screens come from the corpus; today's action is the real decision (`decideCard` with the layer 2 flag), as the
 * driver computes it. The clock is fake: `sleep` moves it, `readFresh` returns the next queued screen.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CliDialogClass } from '../../shared/src/protocol.ts';
import { Layer2Cards, todayHasButtons } from '../src/drivers/herdr/layer2-card.ts';
import type { Layer2CardConfig, Layer2EpisodeFields } from '../src/drivers/herdr/layer2-card.ts';
import { decideCard } from '../src/herdr/dialogs/decide/decide.ts';
import type { ActiveReq } from '../src/herdr/dialogs/cards/build.ts';
import type { DecideAction, DecideInput } from '../src/herdr/dialogs/decide/input.ts';
import { evaluationReqId } from '../src/herdr/dialogs/decide/sources.ts';
import { blockTitleSha } from '../src/herdr/dialogs/layer2/card.ts';
import { readBlock } from '../src/herdr/dialogs/layer2/read-block.ts';
import { STABILITY_GAP_MS } from '../src/herdr/dialogs/layer2/stability.ts';
import { DECIDED_SHIELD_MS } from '../src/herdr/dialogs/timing.ts';
import { resolveOptions } from '../src/herdr/dialogs/screen/resolve.ts';
import { snippet } from '../src/herdr/dialogs/screen/snippet.ts';

const DIR = join(import.meta.dirname, 'fixtures', 'herdr');
const MARK = '\n--- ekran ---\n';

function screenOf(name: string): string {
  const raw = readFileSync(join(DIR, name), 'utf8');
  const at = raw.indexOf(MARK);
  return at < 0 ? raw : raw.slice(at + MARK.length);
}

const manifest = (JSON.parse(readFileSync(join(DIR, 'warstwa2-prawda.json'), 'utf8')) as {
  screens: Record<string, { category: string; class: CliDialogClass | null }>;
}).screens;

/** Effort picker: today a card without buttons, layer 2 reads four choices. */
const PICKER = screenOf('kontrolny/picker-effort-2.1.322.txt');
/** The same picker with the focus moved: another block print. */
const PICKER_MOVED = screenOf('kontrolny/picker-effort-po-prawo-2.1.322.txt');
/** A `TERMINAL_DIALOGS` dialog with the key confirmation (background work on exit, under the status rule). */
const EXIT_BACKGROUND = screenOf('kontrolny/wyjscie-tlo-2.1.322.txt');
/** Session paused: today's card with options for the terminal only, keys confirmed. */
const PAUSED = screenOf('dialog-session-paused-2.1.309.txt');
/** A pause with the same title and another option set (options made up): no layer 2 choices. */
const PAUSED_OTHER = PAUSED.replace(
  '  ❯ 1. Switch to Opus 4.8\n    2. Edit prompt and retry with Opus 5.5 (1M context)',
  '  ❯ 1. Keep waiting\n    2. Switch to Opus 4.8',
);
/** Resume summary: today's card has buttons. */
const RESUME = screenOf('dialog-resume-summary-2.1.258.txt');
/** An empty prompt: no dialog block (a read in mid-repaint). */
const NO_BLOCK = screenOf('composer-empty-2.1.258.ansi.txt');

function input(text: string | null, active: ActiveReq | null = null): DecideInput {
  return {
    pending: null,
    hookPending: null,
    text,
    reqId: evaluationReqId(null, null, null, 1),
    active,
    blockedSeq: 1,
    answeredSeq: -1,
    hookAnswersEnabled: true,
    deadAnswerKey: null,
    canRetry: false,
    answeredHookCall: null,
    decided: null,
    resolve: resolveOptions,
    excerpt: (value: string) => snippet(value)?.text ?? null,
    hookRaw: null,
    layer2: true,
  };
}

interface Harness {
  readonly cards: Layer2Cards;
  readonly lines: Layer2EpisodeFields[];
  readonly sleeps: number[];
  /** Screens `readFresh` returns, in order; the last one repeats. */
  queue: string[];
  /** Forced reads so far. */
  fresh: number;
  cliClass: CliDialogClass | null;
  episode: number;
  cliHold: boolean;
  engineSession: string;
  activeReqId: string | null;
  blockedSeq: number;
  /** Whether the evaluation's own read is a copy from the screen cache. */
  cached: boolean;
  /** The evaluation over `text`; `duringRead` runs between the scope taken before the read and the check. */
  settle(text: string | null, duringRead?: () => void): Promise<DecideAction>;
  /** Moves the clock without a read. */
  advance(ms: number): void;
}

let ids = 0;

function harness(config: Partial<Layer2CardConfig> = {}): Harness {
  let now = 1_000;
  const state: Harness = {
    cards: undefined as unknown as Layer2Cards,
    lines: [],
    sleeps: [],
    queue: [],
    fresh: 0,
    cliClass: 'dialog',
    episode: 1,
    cliHold: false,
    engineSession: 'engine-1',
    activeReqId: null,
    blockedSeq: 1,
    cached: false,
    async settle(text, duringRead) {
      const scope = state.cards.scopeBeforeRead(false);
      duringRead?.();
      const action = decideCard(input(text));
      const result = await state.cards.settle(action, text, {
        now: (screen) => decideCard(input(screen)),
        withoutCard: (screen) => decideCard(input(screen)),
      }, scope);
      if (result.kind === 'card') state.activeReqId = result.card.active.reqId;
      return result;
    },
    advance(ms) {
      now += ms;
    },
  };
  const cards = new Layer2Cards({
    enabled: true, engine: 'claude', nonce: 'n0', newId: () => `l2:${String(++ids).padStart(12, '0')}`, ...config,
  }, {
    cliClass: () => state.cliClass,
    cliEpisode: () => state.episode,
    cliHold: () => state.cliHold,
    engineSession: () => state.engineSession,
    activeReqId: () => state.activeReqId,
    blockedSeq: () => state.blockedSeq,
    readFresh: () => {
      state.fresh += 1;
      return Promise.resolve(state.queue.length > 1 ? state.queue.shift() ?? null : state.queue[0] ?? null);
    },
    screenCached: () => state.cached,
    sleep: (ms) => {
      state.sleeps.push(ms);
      now += ms;
      return Promise.resolve();
    },
    now: () => now,
    live: () => true,
    audit: (fields) => { state.lines.push(fields); },
  });
  (state as { cards: Layer2Cards }).cards = cards;
  return state;
}

const asCard = (action: DecideAction): Extract<DecideAction, { kind: 'card' }> => {
  if (action.kind !== 'card') throw new Error(`expected a card, got ${action.kind}`);
  return action;
};

describe('layer 2 card: two equal reads', () => {
  it('a block with choices stands in two reads: a question card with the literal labels and an l2 id', async () => {
    const h = harness();
    h.queue = [PICKER];
    const card = asCard(await h.settle(PICKER)).card;
    expect(h.sleeps).toEqual([STABILITY_GAP_MS]);
    expect(card.active.reqId).toMatch(/^l2:\d{12}$/);
    expect(card.active.options).toEqual([]);
    expect(card.event.type).toBe('question-request');
    if (card.event.type !== 'question-request') return;
    expect(card.event.channel).toBe('keys');
    const [question] = card.event.questions;
    const block = readBlock(PICKER);
    expect(question?.header).toBe(block?.title);
    expect(question?.question.split('\n')[0]?.trim()).toBe(block?.title);
    expect(question?.options.length).toBe(4);
    expect(h.cards.occurrence(card.active.reqId)?.choices.map((choice) => choice.label))
      .toEqual(question?.options.map((option) => option.label));
    expect(h.lines).toEqual([{
      episode: 'n0-1', layer2Verdict: 'choices', blockTitleSha: blockTitleSha(block?.title ?? ''),
      optionCount: block?.options.length,
    }]);
  });

  it('the block changed between reads: the card comes only after a pair of equal reads', async () => {
    const h = harness();
    h.queue = [PICKER_MOVED, PICKER_MOVED];
    const card = asCard(await h.settle(PICKER)).card;
    expect(h.sleeps).toEqual([STABILITY_GAP_MS, STABILITY_GAP_MS]);
    expect(card.active.layer2Card?.print).toBe(readBlock(PICKER_MOVED)?.print);
  });

  it('three attempts without a pair: today\'s card with the reason unstable, no layer 2 card', async () => {
    const h = harness();
    h.queue = [PICKER_MOVED, PICKER, PICKER_MOVED, PICKER];
    const result = await h.settle(PICKER);
    expect(h.sleeps).toHaveLength(3);
    expect(result.kind).toBe('screen-dialog');
    if (result.kind !== 'screen-dialog') return;
    expect(result.layer2?.why).toBe('unstable');
    expect(h.lines.at(-1)).toMatchObject({ layer2Verdict: 'none', layer2Why: 'unstable' });
    // The verdict lasts to the end of the lock: the next evaluation does not wait again.
    h.queue = [PICKER];
    expect((await h.settle(PICKER)).kind).toBe('screen-dialog');
    expect(h.sleeps).toHaveLength(3);
  });
});

describe('layer 2 card: a pair of reads in one scope', () => {
  it('a new registry episode during the evaluation\'s read: the card after two forced reads of the new one', async () => {
    const h = harness();
    h.queue = [PICKER];
    const card = asCard(await h.settle(PICKER, () => { h.episode = 2; })).card;
    expect(h.fresh).toBe(2);
    expect(h.sleeps).toEqual([STABILITY_GAP_MS, STABILITY_GAP_MS]);
    expect(h.cards.occurrence(card.active.reqId)?.cliEpisode).toBe(2);
  });

  it('a new herdr lock or engine session during the read: the same, two forced reads', async () => {
    for (const change of [(h: Harness) => { h.blockedSeq = 2; }, (h: Harness) => { h.engineSession = 'engine-2'; }]) {
      const h = harness();
      h.queue = [PICKER];
      asCard(await h.settle(PICKER, () => { change(h); }));
      expect(h.fresh).toBe(2);
    }
  });

  it('the evaluation\'s read is a copy from the screen cache: it starts no pair, two forced reads', async () => {
    const h = harness();
    h.cached = true;
    h.queue = [PICKER];
    asCard(await h.settle(PICKER));
    expect(h.fresh).toBe(2);
  });
});

describe('layer 2 card: occurrence id', () => {
  it('a herdr flicker over the same block keeps the same id', async () => {
    const h = harness();
    h.queue = [PICKER];
    const id = asCard(await h.settle(PICKER)).card.active.reqId;
    expect(await h.settle(NO_BLOCK)).toEqual({ kind: 'keep', touchSeq: false });
    expect(await h.settle(PICKER)).toEqual({ kind: 'keep', touchSeq: true });
    expect(h.cards.occurrence(id)).not.toBeNull();
    expect(h.sleeps).toHaveLength(1);
  });

  it('a key the dialog ignored: after the shield the same block gets a card only after two new reads', async () => {
    const h = harness();
    h.queue = [PICKER];
    const first = asCard(await h.settle(PICKER)).card.active.reqId;
    const occurrence = h.cards.occurrence(first);
    if (occurrence === null) throw new Error('no occurrence');
    h.cards.keySent(occurrence);
    // The driver drops the answered card right after the key; the shield hides the same block until it ends.
    h.activeReqId = null;
    expect(await h.settle(PICKER)).toEqual({ kind: 'keep', touchSeq: false });
    h.advance(DECIDED_SHIELD_MS);
    const [sleeps, fresh] = [h.sleeps.length, h.fresh];
    const second = asCard(await h.settle(PICKER)).card.active.reqId;
    expect(second).not.toBe(first);
    // The evaluation's own read and one forced read at least the pair gap later.
    expect(h.sleeps.slice(sleeps)).toEqual([STABILITY_GAP_MS]);
    expect(h.fresh - fresh).toBe(1);
  });

  it('the dialog closed and opened again with the same content: a new id', async () => {
    const h = harness();
    h.queue = [PICKER];
    const first = asCard(await h.settle(PICKER)).card.active.reqId;
    h.activeReqId = null;
    h.blockedSeq += 1;
    h.episode += 1;
    const second = asCard(await h.settle(PICKER)).card.active.reqId;
    expect(second).not.toBe(first);
    expect(h.cards.occurrence(first)).toBeNull();
    expect(h.lines.map((line) => line.episode)).toEqual(['n0-1', 'n0-2']);
  });

  it('another engine session under the same block: a new id', async () => {
    const h = harness();
    h.queue = [PICKER];
    const first = asCard(await h.settle(PICKER)).card.active.reqId;
    h.engineSession = 'engine-2';
    const second = asCard(await h.settle(PICKER)).card.active.reqId;
    expect(second).not.toBe(first);
  });

  it('the registry reports the dialog reopened under the same lock: a new id after a new pair of reads', async () => {
    const h = harness();
    h.queue = [PICKER];
    const first = asCard(await h.settle(PICKER)).card.active.reqId;
    // The card still stands and herdr reported no new lock: only the registry episode tells the dialog was reopened.
    h.episode += 1;
    const second = asCard(await h.settle(PICKER)).card.active.reqId;
    expect(second).not.toBe(first);
    expect(h.cards.occurrence(first)).toBeNull();
    expect(h.cards.occurrence(second)).not.toBeNull();
    expect(h.sleeps).toEqual([STABILITY_GAP_MS, STABILITY_GAP_MS]);
    expect(h.fresh).toBe(2);
    expect(h.lines.map((line) => line.episode)).toEqual(['n0-1', 'n0-2']);
  });

  it('another engine session under the same lock and block: the new id needs a new pair of reads', async () => {
    // The driver clears the card of the previous engine session; the module must not rely on it.
    for (const cleared of [true, false]) {
      const h = harness();
      h.queue = [PICKER];
      const first = asCard(await h.settle(PICKER)).card.active.reqId;
      if (cleared) h.activeReqId = null;
      h.engineSession = 'engine-2';
      const second = asCard(await h.settle(PICKER)).card.active.reqId;
      expect(second, `cleared ${String(cleared)}`).not.toBe(first);
      expect(h.sleeps, `cleared ${String(cleared)}`).toEqual([STABILITY_GAP_MS, STABILITY_GAP_MS]);
      expect(h.fresh, `cleared ${String(cleared)}`).toBe(2);
    }
  });

  it('a herdr flicker alone (a new lock, the same registry episode and engine session) keeps the id', async () => {
    const h = harness();
    h.queue = [PICKER];
    const id = asCard(await h.settle(PICKER)).card.active.reqId;
    h.blockedSeq += 1;
    expect(await h.settle(NO_BLOCK)).toEqual({ kind: 'keep', touchSeq: false });
    h.blockedSeq += 1;
    expect(await h.settle(PICKER)).toEqual({ kind: 'keep', touchSeq: true });
    expect(h.cards.occurrence(id)).not.toBeNull();
    expect(h.sleeps).toEqual([STABILITY_GAP_MS]);
    expect(h.fresh).toBe(1);
  });

  it('the same dialog in two sessions: two different random ids, both cards stand', async () => {
    const one = harness({ newId: undefined, nonce: undefined });
    const two = harness({ newId: undefined, nonce: undefined });
    one.queue = [PICKER];
    two.queue = [PICKER];
    const a = asCard(await one.settle(PICKER)).card.active.reqId;
    const b = asCard(await two.settle(PICKER)).card.active.reqId;
    expect(a).toMatch(/^l2:[0-9a-f]{12}$/);
    expect(b).toMatch(/^l2:[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
    expect(one.cards.occurrence(a)).not.toBeNull();
    expect(two.cards.occurrence(b)).not.toBeNull();
    expect(one.lines[0]?.episode).not.toBe(two.lines[0]?.episode);
  });
});

describe('layer 2 card: no card', () => {
  it('flag 0: today\'s action unchanged, no read, no audit line', async () => {
    const h = harness({ enabled: false });
    const action = decideCard(input(PICKER));
    const decide = { now: () => action, withoutCard: () => action };
    expect(await h.cards.settle(action, PICKER, decide, h.cards.scopeBeforeRead(true))).toBe(action);
    expect(h.sleeps).toEqual([]);
    expect(h.lines).toEqual([]);
  });

  it('class null: no card (class-unknown) and no episode line', async () => {
    const h = harness();
    h.cliClass = null;
    expect((await h.settle(PICKER)).kind).toBe('screen-dialog');
    expect(h.sleeps).toEqual([]);
    expect(h.lines).toEqual([]);
  });

  it('a Codex session: no card, episode line engine-not-claude', async () => {
    const h = harness({ engine: 'codex' });
    expect((await h.settle(PICKER)).kind).toBe('screen-dialog');
    expect(h.lines).toEqual([expect.objectContaining({ layer2Verdict: 'none', layer2Why: 'engine-not-claude' })]);
  });

  it('a full permission or sandbox block: no layer 2 card', async () => {
    for (const cliClass of ['permission', 'sandbox'] as const) {
      const name = Object.keys(manifest).find((key) => manifest[key]?.category === 'consent'
        && manifest[key]?.class === cliClass);
      if (name === undefined) throw new Error(cliClass);
      const h = harness();
      h.cliClass = cliClass;
      const text = screenOf(name);
      const result = await h.settle(text);
      expect(result.kind === 'card' && result.card.active.layer2Card !== undefined, name).toBe(false);
      expect(h.lines, name).toEqual([]);
    }
  });

  it('a pause with another option set: today\'s card stays, reason terminal-dialog', async () => {
    const h = harness();
    const action = decideCard(input(PAUSED_OTHER));
    const result = await h.settle(PAUSED_OTHER);
    expect(result).toEqual(action);
    expect(h.lines).toEqual([expect.objectContaining({ layer2Verdict: 'none', layer2Why: 'terminal-dialog' })]);
  });

  it('TERMINAL_DIALOGS with the key confirmation: the layer 2 card replaces today\'s card', async () => {
    for (const [text, options] of [[PAUSED, 2], [EXIT_BACKGROUND, 4]] as const) {
      const h = harness();
      h.queue = [text];
      const card = asCard(await h.settle(text)).card;
      expect(card.active.reqId).toMatch(/^l2:\d{12}$/);
      expect(card.event.type === 'question-request' && card.event.questions[0]?.options.length).toBe(options);
      expect(h.lines).toEqual([expect.objectContaining({ layer2Verdict: 'choices' })]);
    }
  });

  it('today\'s card has buttons: layer 2 does not act, episode line existing', async () => {
    const h = harness();
    const action = decideCard(input(RESUME));
    expect(action.kind === 'card' || action.kind === 'screen-dialog').toBe(true);
    if (action.kind !== 'card' && action.kind !== 'screen-dialog') return;
    expect(todayHasButtons(action)).toBe(true);
    expect(await h.settle(RESUME)).toEqual(action);
    expect(h.lines).toEqual([expect.objectContaining({ layer2Verdict: 'existing' })]);
  });
});

describe('layer 2 card: episode line', () => {
  it('the same verdict again writes nothing; a new verdict in the episode writes a refresh', async () => {
    const h = harness();
    h.queue = [PICKER];
    await h.settle(PICKER);
    await h.settle(PICKER);
    expect(h.lines).toHaveLength(1);
    h.activeReqId = null;
    await h.settle(PAUSED_OTHER);
    expect(h.lines.map((line) => [line.episode, line.layer2Verdict])).toEqual([['n0-1', 'choices'], ['n0-1', 'none']]);
  });

  it('the registry fallback ends the evaluation (none): no-block once per episode, a read refreshes it', async () => {
    const h = harness();
    h.cards.noteFallback('none');
    h.cards.noteFallback('none');
    expect(h.lines).toEqual([{ episode: 'n0-1', layer2Verdict: 'none', layer2Why: 'no-block' }]);
    h.queue = [PICKER];
    await h.settle(PICKER);
    expect(h.lines.map((line) => [line.episode, line.layer2Verdict])).toEqual([['n0-1', 'none'], ['n0-1', 'choices']]);
    // A later evaluation without a screen does not take the verdict of the episode back.
    h.cards.noteFallback('none');
    expect(h.lines).toHaveLength(2);
    // The next episode without a screen gets its own line.
    h.episode += 1;
    h.cards.noteFallback('none');
    expect(h.lines.at(-1)).toEqual({ episode: 'n0-2', layer2Verdict: 'none', layer2Why: 'no-block' });
  });

  it('the registry fallback waits: a line only while it holds the dialog, none when it takes the dialog', () => {
    const h = harness();
    // `wait` outside a hold: the premises changed during the read, another evaluation follows.
    h.cards.noteFallback('wait');
    // `blocked`: the evaluation goes on to `settle`.
    h.cards.noteFallback('blocked');
    expect(h.lines).toEqual([]);
    h.cliHold = true;
    h.cards.noteFallback('blocked');
    expect(h.lines).toEqual([]);
    h.cards.noteFallback('wait');
    expect(h.lines).toEqual([{ episode: 'n0-1', layer2Verdict: 'none', layer2Why: 'no-block' }]);
  });

  it('the registry fallback ends the evaluation: nothing with flag 0 or without a waiting of class dialog', () => {
    const off = harness({ enabled: false });
    off.cards.noteFallback('none');
    expect(off.lines).toEqual([]);
    const other = harness();
    for (const cliClass of [null, 'permission', 'input'] as const) {
      other.cliClass = cliClass;
      other.cards.noteFallback('none');
    }
    expect(other.lines).toEqual([]);
  });

  it('the registry fallback ends the evaluation in a Codex session: the reason of the gate', () => {
    const h = harness({ engine: 'codex' });
    h.cards.noteFallback('none');
    expect(h.lines).toEqual([{ episode: 'n0-1', layer2Verdict: 'none', layer2Why: 'engine-not-claude' }]);
  });

  it('today\'s card already stands (the class came later): the hidden card is judged and replaced', async () => {
    const h = harness();
    h.queue = [PICKER];
    const keep: DecideAction = { kind: 'keep', touchSeq: true };
    const result = await h.cards.settle(keep, PICKER, {
      now: () => keep, withoutCard: (screen) => decideCard(input(screen)),
    }, h.cards.scopeBeforeRead(true));
    expect(asCard(result).card.active.reqId).toMatch(/^l2:/);
  });
});
