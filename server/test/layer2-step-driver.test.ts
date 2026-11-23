/**
 * The layer 2 step through the real driver (`server/src/drivers/herdr/layer2-step.ts`, `docs/dialog-card.md`,
 * "Answer"): a tap on a choice of a layer 2 card sends exactly one key, only after the checks of the step, and Esc
 * over the card (`deny`) goes the same way; a verify read after the key goes to the audit. The driver runs on a
 * driven clock, the registry and the hook registration are switches of the test. The manager side (parallel taps,
 * an id from before a restart, `allow` over the card) is in `herdr-integration.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { foreign } from '@rarog/shared/sentences';
import type { CliWaitingSignal } from '../src/cli-version.ts';
import { VERIFY_AFTER_MS } from '../src/drivers/herdr/layer2-step.ts';
import type { DriverEvent } from '../src/drivers/types.ts';
import { STABILITY_GAP_MS } from '../src/herdr/dialogs/layer2/stability.ts';
import { DECIDED_SHIELD_MS } from '../src/herdr/dialogs/timing.ts';
import { HerdrOutOfScopeError, HerdrReadOnlyError } from '../src/herdr/types.ts';
import type { HerdrClient } from '../src/herdr/types.ts';
import {
  FIXTURES, drivenClock, makeDriver, systemCodes, useDriverSandbox, userLine, waitFor,
} from './helpers/herdr-driver-atrapy.ts';
import type { Fixture } from './helpers/herdr-driver-atrapy.ts';

useDriverSandbox();

const MARK = '\n--- ekran ---\n';

function screenOf(name: string): string {
  const raw = readFileSync(join(FIXTURES, name), 'utf8');
  const at = raw.indexOf(MARK);
  return at < 0 ? raw : raw.slice(at + MARK.length);
}

/** "Switch model?" under the status rule: two numbered options, a layer 2 card (CLI 2.1.319). */
const MODEL = screenOf('kontrolny/potwierdzenie-model-haiku-2.1.319.txt');
/** The effort slider at `medium`: "← to adjust", "→ to adjust", "Enter to confirm", "Esc to cancel". */
const PICKER = screenOf('kontrolny/picker-effort-2.1.322.txt');
/** The same slider one step to the right. */
const PICKER_RIGHT = screenOf('kontrolny/picker-effort-po-prawo-2.1.322.txt');
const SLIDER_RIGHT = '────────────────────▲─────────────────────';
/** The same slider two steps to the right: the test moves the marker the way the CLI 2.1.322 fixture shows one step. */
const PICKER_RIGHT_2 = PICKER_RIGHT.replace(SLIDER_RIGHT, '──────────────────────────────▲───────────');
/** `/help`: a view with "Esc to cancel" alone. */
const HELP = screenOf('kontrolny/widok-help-2.1.322.txt');
/** The prompt field after the dialog closed. */
const PROMPT = `${'─'.repeat(40)}\n❯ \n${'─'.repeat(40)}\n`;

const WAITING_DIALOG: CliWaitingSignal = { kind: 'waiting', dialog: 'dialog' };
const SCREEN_CHANGED = { kind: 'refused', reason: 'screen-changed' } as const;

/** Clock time a layer 2 card needs: the evaluation, the pair gap and the forced read. */
const ISSUE_MS = STABILITY_GAP_MS * 2;

interface Pane {
  fx: Fixture;
  advance: (ms: number) => Promise<void>;
  /** What the registry read returns; a function is called on each read. */
  registry: CliWaitingSignal | (() => Promise<CliWaitingSignal>);
  /** Whether a hook consent registration of the session waits (`consentRegistrationWaits`). */
  hookWaits: boolean;
  /** Registry reads so far. */
  registryReads: number;
  logs: string[];
}

const CARD_TYPES = new Set<DriverEvent['type']>(['screen-dialog', 'question-request', 'permission-request']);
const cardsOf = (events: readonly DriverEvent[]): DriverEvent[] => events.filter((e) => CARD_TYPES.has(e.type));

type QuestionCard = Extract<DriverEvent, { type: 'question-request' }>;

/** The last layer 2 card the driver showed. */
function lastCard(fx: Fixture): QuestionCard {
  const card = cardsOf(fx.events).at(-1);
  if (card?.type !== 'question-request' || !card.reqId.startsWith('l2:')) throw new Error('no layer 2 card');
  return card;
}

/** Keys and text that reached the pane, in order. */
const sent = (fx: Fixture): string[] => fx.client.calls
  .filter((call) => call.method !== 'read' && call.method !== 'history')
  .map((call) => `${call.method}:${(call.keys ?? [call.text ?? '']).join(',')}`);

/** A pane blocked on `screen` under flag `1`, with its layer 2 card standing (`card: false`: not issued yet). */
async function blockedOn(
  screen: string, opts: { agent?: NonNullable<Parameters<typeof makeDriver>[0]>['agent']; card?: boolean } = {},
): Promise<Pane> {
  const clock = drivenClock();
  const pane = { registry: WAITING_DIALOG, hookWaits: false, registryReads: 0, logs: [] } as unknown as Pane;
  const fx = await makeDriver({
    transcript: userLine('work'), screen, ...(opts.agent === undefined ? {} : { agent: opts.agent }),
    deps: {
      dialogLayer2: true, screenCacheMs: 0, sessionId: 'session-test', scheduler: clock.scheduler,
      consentRegistryRead: () => {
        pane.registryReads += 1;
        return typeof pane.registry === 'function' ? pane.registry() : Promise.resolve(pane.registry);
      },
      consentRegistrationWaits: () => pane.hookWaits,
      logger: (line) => { pane.logs.push(line); },
    },
  });
  Object.assign(pane, { fx, advance: clock.advance });
  await waitFor(() => fx.events.some((e) => e.type === 'history'), 'history');
  fx.driver.noteCliWaiting?.({ kind: 'waiting', dialog: 'dialog' });
  fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
  if (opts.card === false) return pane;
  await clock.advance(ISSUE_MS);
  lastCard(fx);
  return pane;
}

/** Runs a decision on the driven clock to its end. */
async function settle<T>(pane: Pane, decision: Promise<T>): Promise<T> {
  let done = false;
  const result = decision.finally(() => { done = true; });
  for (let i = 0; i < 20 && !done; i += 1) await pane.advance(0);
  return result;
}

/** The pane closes the dialog: the prompt on the screen, the registry no longer `waiting`. */
function dialogCloses(pane: Pane, next = PROMPT, registry: CliWaitingSignal = { kind: 'active' }): void {
  pane.fx.client.screenText = next;
  pane.registry = registry;
}

const verifyLines = (fx: Fixture) => fx.audit.filter((entry) => entry.method === 'layer2-verify');
const approveLines = (fx: Fixture) => fx.audit.filter((entry) => entry.method === 'approve');
const refuseLines = (fx: Fixture) => fx.audit.filter((entry) => entry.method === 'refuse');

describe('layer 2 step: one key after the proof', () => {
  it('"Switch model?", tap "No, go back", the fresh screen equal: one key `2`, applied, verify `gone`', async () => {
    const pane = await blockedOn(MODEL);
    const { fx } = pane;
    const card = lastCard(fx);
    expect(card.questions[0]?.options.map((option) => option.label)).toEqual(['Yes, switch to Haiku 5.5', 'No, go back']);
    const reads = pane.registryReads;
    expect(await settle(pane, fx.driver.answerQuestion(card.reqId, [['No, go back']]))).toEqual({ kind: 'applied' });
    expect(sent(fx)).toEqual(['send_keys:2']);
    expect(pane.registryReads).toBe(reads + 1);
    expect(approveLines(fx)).toEqual([expect.objectContaining({
      keys: ['2'], toolName: 'dialog:layer2', optionLabel: 'No, go back', reqId: card.reqId, layer2: true,
      layer2Key: 'digit',
    })]);
    dialogCloses(pane);
    await pane.advance(VERIFY_AFTER_MS);
    expect(verifyLines(fx)).toEqual([expect.objectContaining({
      reqId: card.reqId, layer2: true, layer2Key: 'digit', layer2Outcome: 'gone', toolName: 'dialog:layer2',
    })]);
    expect(sent(fx)).toEqual(['send_keys:2']);
  });
});

describe('layer 2 step: the key row and Esc', () => {
  it('slider, "→ to adjust": one `right` through `sendDialogKey`, then a new card with a new id', async () => {
    const pane = await blockedOn(PICKER);
    const { fx } = pane;
    const first = lastCard(fx);
    expect(await settle(pane, fx.driver.answerQuestion(first.reqId, [['→ to adjust']]))).toEqual({ kind: 'applied' });
    expect(sent(fx)).toEqual(['dialog_key:right']);
    expect(approveLines(fx)).toEqual([expect.objectContaining({
      keys: ['right'], layer2Key: 'key', reqId: first.reqId,
    })]);
    fx.client.screenText = PICKER_RIGHT;
    await pane.advance(ISSUE_MS);
    const next = lastCard(fx);
    expect(next.reqId).toMatch(/^l2:[0-9a-f]{12}$/);
    expect(next.reqId).not.toBe(first.reqId);
    expect(verifyLines(fx)).toEqual([expect.objectContaining({ reqId: first.reqId, layer2Outcome: 'changed' })]);
    expect(sent(fx)).toEqual(['dialog_key:right']);
  });

  it('the series "→", "→", "Enter to confirm" on three occurrences: three keys, no wait for the shield', async () => {
    const pane = await blockedOn(PICKER);
    const { fx } = pane;
    const screens = [PICKER_RIGHT, PICKER_RIGHT_2];
    const labels = ['→ to adjust', '→ to adjust', 'Enter to confirm'];
    const ids: string[] = [];
    let elapsed = 0;
    for (const [index, label] of labels.entries()) {
      const card = lastCard(fx);
      ids.push(card.reqId);
      expect(await settle(pane, fx.driver.answerQuestion(card.reqId, [[label]]))).toEqual({ kind: 'applied' });
      const screen = screens[index];
      if (screen === undefined) dialogCloses(pane);
      else fx.client.screenText = screen;
      await pane.advance(ISSUE_MS);
      elapsed += ISSUE_MS;
    }
    expect(sent(fx)).toEqual(['dialog_key:right', 'dialog_key:right', 'dialog_key:enter']);
    expect(new Set(ids).size).toBe(3);
    expect(elapsed).toBeLessThan(DECIDED_SHIELD_MS);
  });

  it('a key the dialog ignored (verify `same`): no card for the same block until the shield ends, no key again', async () => {
    const pane = await blockedOn(PICKER);
    const { fx } = pane;
    const first = lastCard(fx);
    expect(await settle(pane, fx.driver.answerQuestion(first.reqId, [['← to adjust']]))).toEqual({ kind: 'applied' });
    await pane.advance(ISSUE_MS);
    expect(verifyLines(fx)).toEqual([expect.objectContaining({ reqId: first.reqId, layer2Outcome: 'same' })]);
    expect(lastCard(fx).reqId).toBe(first.reqId);
    await pane.advance(DECIDED_SHIELD_MS);
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 9, title: '' });
    await pane.advance(ISSUE_MS);
    expect(lastCard(fx).reqId).not.toBe(first.reqId);
    expect(sent(fx)).toEqual(['dialog_key:left']);
  });

  it('"Esc to cancel" on the `/help` card, by the label and by `deny`: one `escape` after the step', async () => {
    for (const how of ['label', 'deny'] as const) {
      const pane = await blockedOn(HELP);
      const { fx } = pane;
      const card = lastCard(fx);
      expect(card.questions[0]?.options.map((option) => option.label)).toEqual(['Esc to cancel']);
      const reads = pane.registryReads;
      const decision = how === 'label'
        ? fx.driver.answerQuestion(card.reqId, [['Esc to cancel']])
        : fx.driver.respondPermission('session-test', 'deny');
      expect(await settle(pane, decision), how).toEqual({ kind: 'applied' });
      expect(sent(fx), how).toEqual(['send_keys:escape']);
      expect(pane.registryReads, how).toBe(reads + 1);
      expect(approveLines(fx), how).toEqual([expect.objectContaining({ keys: ['escape'], layer2Key: 'escape' })]);
    }
  });

  it('a late Esc after the block changed: no key, by the label and by `deny`', async () => {
    for (const how of ['label', 'deny'] as const) {
      const pane = await blockedOn(PICKER);
      const { fx } = pane;
      const card = lastCard(fx);
      fx.client.screenText = PICKER_RIGHT;
      const decision = how === 'label'
        ? fx.driver.answerQuestion(card.reqId, [['Esc to cancel']])
        : fx.driver.respondPermission('session-test', 'deny');
      expect(await settle(pane, decision), how).toEqual(SCREEN_CHANGED);
      expect(sent(fx), how).toEqual([]);
      expect(refuseLines(fx).at(-1), how).toEqual(expect.objectContaining({
        reason: 'screen-changed', layer2Why: 'screen-changed', reqId: card.reqId, layer2: true,
      }));
    }
  });

  it('`deny` over a card without Esc: refused, no key', async () => {
    const pane = await blockedOn(MODEL);
    const { fx } = pane;
    expect(await settle(pane, fx.driver.respondPermission('session-test', 'deny')))
      .toEqual({ kind: 'refused', reason: 'terminal-only' });
    expect(sent(fx)).toEqual([]);
  });
});

/** Resume summary: today's card has buttons, so layer 2 leaves it as it is. */
const RESUME = screenOf('dialog-resume-summary-2.1.258.txt');

/** Holds the next screen read of the pane until the returned function runs; later reads go through. */
function holdNextRead(pane: Pane): () => void {
  const read = pane.fx.client.readScreen.bind(pane.fx.client);
  let release = (): void => undefined;
  let held = false;
  (pane.fx.client as { readScreen: HerdrClient['readScreen'] }).readScreen = (...args) => {
    if (held) return read(...args);
    held = true;
    return new Promise((resolve, reject) => { release = () => { read(...args).then(resolve, reject); }; });
  };
  return () => { release(); };
}

describe('layer 2 step: a `deny` is bound to the card that stands when it is accepted', () => {
  it('two `deny` at once over the card: one `escape`, the second finds the occurrence answered', async () => {
    const pane = await blockedOn(PICKER);
    const { fx } = pane;
    const both = Promise.all([
      fx.driver.respondPermission('session-test', 'deny'), fx.driver.respondPermission('session-test', 'deny'),
    ]);
    expect(await settle(pane, both)).toEqual([{ kind: 'applied' }, { kind: 'stale' }]);
    expect(sent(fx)).toEqual(['send_keys:escape']);
  });

  it('`deny` and a tap on a label at once: one key in total, in either order', async () => {
    for (const order of ['tap first', 'deny first'] as const) {
      const pane = await blockedOn(PICKER);
      const { fx } = pane;
      const card = lastCard(fx);
      const tap = (): Promise<unknown> => fx.driver.answerQuestion(card.reqId, [['→ to adjust']]);
      const deny = (): Promise<unknown> => fx.driver.respondPermission('session-test', 'deny');
      const both = order === 'tap first' ? Promise.all([tap(), deny()]) : Promise.all([deny(), tap()]);
      expect(await settle(pane, both), order).toEqual([{ kind: 'applied' }, { kind: 'stale' }]);
      expect(sent(fx), order).toEqual([order === 'tap first' ? 'dialog_key:right' : 'send_keys:escape']);
    }
  });

  it('a layer 2 card issued while a `deny` waits in the queue: no key, `stale-card`', async () => {
    const pane = await blockedOn(PICKER, { card: false });
    const { fx } = pane;
    const release = holdNextRead(pane);
    let done = false;
    const deny = fx.driver.respondPermission('session-test', 'deny').finally(() => { done = true; });
    await pane.advance(ISSUE_MS);
    lastCard(fx);
    expect(done).toBe(false);
    release();
    expect(await settle(pane, deny)).toEqual({ kind: 'refused', reason: 'stale-card' });
    expect(sent(fx)).toEqual([]);
    expect(refuseLines(fx).at(-1)).toEqual(expect.objectContaining({
      reason: 'stale-card', layer2: true, layer2Why: 'stale-card',
    }));
    expect(systemCodes(fx.events)).toContain('dialogs.stale-decision');
  });

  it('a key from `deny` reports its card gone at once, a key from a label does not; a newer card stays', async () => {
    for (const how of ['deny', 'label'] as const) {
      const pane = await blockedOn(PICKER);
      const { fx } = pane;
      const card = lastCard(fx);
      const decision = how === 'deny'
        ? fx.driver.respondPermission('session-test', 'deny')
        : fx.driver.answerQuestion(card.reqId, [['Esc to cancel']]);
      expect(await settle(pane, decision), how).toEqual({ kind: 'applied' });
      const cleared = (): DriverEvent[] => fx.events.filter((e) => e.type === 'permission-cleared');
      // A tap on a label is settled by the manager's own answer call, so the driver reports nothing.
      expect(cleared(), how).toEqual(how === 'deny' ? [expect.objectContaining({ reqId: card.reqId })] : []);
      fx.client.screenText = PICKER_RIGHT;
      await pane.advance(ISSUE_MS);
      expect(lastCard(fx).reqId, how).not.toBe(card.reqId);
      expect(cleared(), how).toHaveLength(how === 'deny' ? 1 : 0);
    }
  });

  it('`deny` over a card that is not a layer 2 card: one `escape`, as without the flag', async () => {
    const pane = await blockedOn(RESUME, { card: false });
    const { fx } = pane;
    await pane.advance(ISSUE_MS);
    const cards = cardsOf(fx.events);
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.filter((e) => e.type === 'question-request' && e.reqId.startsWith('l2:'))).toEqual([]);
    expect(await settle(pane, fx.driver.respondPermission('session-test', 'deny'))).toEqual({ kind: 'applied' });
    expect(sent(fx)).toEqual(['send_keys:escape']);
  });
});

/** A tap on "No, go back" of the standing model card. */
const tapNo = (pane: Pane): Promise<unknown> => settle(
  pane, pane.fx.driver.answerQuestion(lastCard(pane.fx).reqId, [['No, go back']]),
);

/** Replaces the screen read of the pane; `during` runs while the read is in flight. */
function duringRead(pane: Pane, during: () => void): void {
  const read = pane.fx.client.readScreen.bind(pane.fx.client);
  (pane.fx.client as { readScreen: HerdrClient['readScreen'] }).readScreen = (...args) => {
    during();
    return read(...args);
  };
}

describe('layer 2 step: each check refuses without a key', () => {
  it('another label under `2` now: `screen-changed`, no key', async () => {
    const pane = await blockedOn(MODEL);
    pane.fx.client.screenText = MODEL.replace('No, go back', 'No, keep Opus');
    expect(await tapNo(pane)).toEqual(SCREEN_CHANGED);
    expect(sent(pane.fx)).toEqual([]);
    expect(systemCodes(pane.fx.events)).toContain('dialogs.screen-changed');
  });

  it('the registry says `waiting` with class `permission`: `class-unknown`, no key', async () => {
    const pane = await blockedOn(MODEL);
    pane.registry = { kind: 'waiting', dialog: 'permission' };
    expect(await tapNo(pane)).toEqual(SCREEN_CHANGED);
    expect(sent(pane.fx)).toEqual([]);
    expect(refuseLines(pane.fx).at(-1)).toEqual(expect.objectContaining({ layer2Why: 'class-unknown' }));
  });

  it('a hook registers during the fresh read: `hook`, no key', async () => {
    const pane = await blockedOn(MODEL);
    duringRead(pane, () => { pane.hookWaits = true; });
    expect(await tapNo(pane)).toEqual(SCREEN_CHANGED);
    expect(sent(pane.fx)).toEqual([]);
    expect(refuseLines(pane.fx).at(-1)).toEqual(expect.objectContaining({ layer2Why: 'hook' }));
  });

  it('`/clear` during the fresh read: `session-moved`, no key', async () => {
    const pane = await blockedOn(MODEL);
    duringRead(pane, () => {
      pane.fx.emit({ type: 'session-changed', agentSessionId: 'f0f0f0f0-0000-4000-8000-000000000001' });
    });
    expect(await tapNo(pane)).toEqual(SCREEN_CHANGED);
    expect(sent(pane.fx)).toEqual([]);
    expect(refuseLines(pane.fx).at(-1)).toEqual(expect.objectContaining({ layer2Why: 'session-moved' }));
  });

  it('two taps on the same card in a row: one key, the second finds the card answered', async () => {
    const pane = await blockedOn(MODEL);
    const { fx } = pane;
    const card = lastCard(fx);
    const one = fx.driver.answerQuestion(card.reqId, [['No, go back']]);
    const two = fx.driver.answerQuestion(card.reqId, [['No, go back']]);
    expect(await settle(pane, one)).toEqual({ kind: 'applied' });
    expect(await settle(pane, two)).toEqual({ kind: 'stale' });
    expect(sent(fx)).toEqual(['send_keys:2']);
  });

  it('an id the driver never issued (from before a restart): stale, no key', async () => {
    const pane = await blockedOn(MODEL);
    const { fx } = pane;
    expect(await settle(pane, fx.driver.answerQuestion('l2:0123456789ab', [['No, go back']])))
      .toEqual({ kind: 'stale' });
    expect(sent(fx)).toEqual([]);
    expect(refuseLines(fx).at(-1)).toEqual(expect.objectContaining({
      reason: 'stale-card', reqId: 'l2:0123456789ab',
    }));
  });

  it('a label the card does not have, or more than one: refused, no key', async () => {
    const pane = await blockedOn(MODEL);
    const { fx } = pane;
    const card = lastCard(fx);
    for (const answers of [[['Maybe']], [['No, go back', 'Yes, switch to Haiku 5.5']], [['No, go back'], ['x']]]) {
      expect(await settle(pane, fx.driver.answerQuestion(card.reqId, answers)))
        .toEqual({ kind: 'refused', reason: 'no-digit' });
    }
    expect(sent(fx)).toEqual([]);
  });

  it('a pane out of scope: the call throws, no key', async () => {
    const pane = await blockedOn(MODEL);
    const outside = await makeDriver({ agent: { inScope: false } });
    expect(() => outside.driver.answerQuestion(lastCard(pane.fx).reqId, [['No, go back']]))
      .toThrow(HerdrOutOfScopeError);
    expect(sent(outside)).toEqual([]);
  });

  it('herdr send off or a read-only supervisor (the socket refuses the call): `send-failed`, no key', async () => {
    const pane = await blockedOn(MODEL);
    const { fx } = pane;
    fx.client.sendKeys = () => Promise.reject(new HerdrReadOnlyError(foreign('read-only')));
    expect(await tapNo(pane)).toEqual({ kind: 'refused', reason: 'send-failed' });
    expect(sent(fx)).toEqual([]);
    expect(refuseLines(fx).at(-1)).toEqual(expect.objectContaining({ reason: 'send-failed', layer2: true }));
  });

  it('`allow` over the card, by its id and by the session: refused, no key', async () => {
    const pane = await blockedOn(MODEL);
    const { fx } = pane;
    for (const reqId of [lastCard(fx).reqId, 'session-test']) {
      expect(await settle(pane, fx.driver.respondPermission(reqId, 'allow')))
        .toEqual({ kind: 'refused', reason: 'terminal-only' });
    }
    expect(sent(fx)).toEqual([]);
  });
});

describe('layer 2 step: the verify read', () => {
  it('a hook or a new card during the verify read: the audit line, the newer card untouched', async () => {
    const pane = await blockedOn(PICKER);
    const { fx } = pane;
    const first = lastCard(fx);
    expect(await settle(pane, fx.driver.answerQuestion(first.reqId, [['→ to adjust']]))).toEqual({ kind: 'applied' });
    fx.client.screenText = PICKER_RIGHT;
    // The verify read holds on its registry read; a card cannot stand earlier than one pair gap after the key.
    await pane.advance(VERIFY_AFTER_MS - 1);
    let release: (signal: CliWaitingSignal) => void = () => undefined;
    const reads = pane.registryReads;
    pane.registry = () => (pane.registryReads === reads + 1
      ? new Promise<CliWaitingSignal>((resolve) => { release = resolve; })
      : Promise.resolve(WAITING_DIALOG));
    await pane.advance(1);
    expect(pane.registryReads).toBe(reads + 1);
    await pane.advance(ISSUE_MS);
    const newer = lastCard(fx);
    expect(newer.reqId).not.toBe(first.reqId);
    expect(verifyLines(fx)).toEqual([]);
    const events = fx.events.length;
    pane.hookWaits = true;
    release(WAITING_DIALOG);
    await pane.advance(0);
    expect(verifyLines(fx)).toEqual([expect.objectContaining({ reqId: first.reqId, layer2Outcome: 'changed' })]);
    expect(fx.events.slice(events).filter((e) => e.type === 'permission-cleared' || CARD_TYPES.has(e.type)))
      .toEqual([]);
    expect(lastCard(fx).reqId).toBe(newer.reqId);
    expect(sent(fx)).toEqual(['dialog_key:right']);
  });

  it('the verify read fails: `unknown`', async () => {
    const pane = await blockedOn(MODEL);
    const { fx } = pane;
    expect(await tapNo(pane)).toEqual({ kind: 'applied' });
    (fx.client as { readScreen: HerdrClient['readScreen'] }).readScreen = () => Promise.reject(new Error('EIO'));
    await pane.advance(VERIFY_AFTER_MS);
    expect(verifyLines(fx)).toEqual([expect.objectContaining({ layer2Outcome: 'unknown' })]);
  });

  it('a dialog of another class after the key: `other-dialog` and a log line', async () => {
    const pane = await blockedOn(MODEL);
    const { fx } = pane;
    const card = lastCard(fx);
    expect(await tapNo(pane)).toEqual({ kind: 'applied' });
    pane.registry = { kind: 'waiting', dialog: 'permission' };
    await pane.advance(VERIFY_AFTER_MS);
    expect(verifyLines(fx)).toEqual([expect.objectContaining({ layer2Outcome: 'other-dialog' })]);
    expect(pane.logs.filter((line) => line.includes(card.reqId))).toHaveLength(1);
  });
});
