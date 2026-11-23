/**
 * Layer 2 buttons on the `TERMINAL_DIALOGS` dialogs (`server/src/herdr/dialogs/policy/terminal.ts`, rule in
 * `docs/dialogs.md`, "CLI dialogs answered in the terminal"): an entry whose keys the control set measured gets
 * a layer 2 card with the literal labels and the layer 2 step; an entry without that measurement, or the flag `0`,
 * keeps today's "answer in the terminal" card with zero keys.
 *
 * Screens: the control set captures of CLI 2.1.322 (`kontrolny/wyjscie-tlo-2.1.322.txt`, the exit under the status
 * rule, and `kontrolny/pauza-2.1.322.txt`) and the CLI 2.1.309 captures from the root of the fixtures (the same dialogs
 * under a bare rule). The driver runs on a driven clock, as in `layer2-step-driver.test.ts`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CliWaitingSignal } from '../src/cli-version.ts';
import { judgeLayer2, todayHasButtons } from '../src/drivers/herdr/layer2-card.ts';
import type { DriverEvent } from '../src/drivers/types.ts';
import { decideCard } from '../src/herdr/dialogs/decide/decide.ts';
import type { DecideAction, DecideInput } from '../src/herdr/dialogs/decide/input.ts';
import { evaluationReqId } from '../src/herdr/dialogs/decide/sources.ts';
import { readBlock } from '../src/herdr/dialogs/layer2/read-block.ts';
import { STABILITY_GAP_MS } from '../src/herdr/dialogs/layer2/stability.ts';
import { layer2Verdict } from '../src/herdr/dialogs/layer2/verdict.ts';
import type { Layer2Verdict } from '../src/herdr/dialogs/layer2/verdict.ts';
import { TERMINAL_DIALOGS, confirmedKeys } from '../src/herdr/dialogs/policy/terminal.ts';
import type { KeyMeasurement, KeysMeasured, TerminalDialogId } from '../src/herdr/dialogs/policy/terminal.ts';
import { resolveOptions } from '../src/herdr/dialogs/screen/resolve.ts';
import { snippet } from '../src/herdr/dialogs/screen/snippet.ts';
import { trimmedLines } from '../src/herdr/dialogs/screen/text.ts';
import {
  FIXTURES, drivenClock, makeDriver, systemCodes, useDriverSandbox, userLine, waitFor,
} from './helpers/herdr-driver-atrapy.ts';
import type { Fixture } from './helpers/herdr-driver-atrapy.ts';

useDriverSandbox();

const MARK = '\n--- ekran ---\n';
const KONTROLNY = join(FIXTURES, 'kontrolny');

function screenOf(name: string): string {
  const raw = readFileSync(join(FIXTURES, name), 'utf8');
  const at = raw.indexOf(MARK);
  return at < 0 ? raw : raw.slice(at + MARK.length);
}

/** "Background work is running" under the status rule `▔▔▔ ◐ medium · /effort ▔` (CLI 2.1.322). */
const EXIT = screenOf('kontrolny/wyjscie-tlo-2.1.322.txt');
/** The same dialog under a bare rule (CLI 2.1.309). */
const EXIT_BARE = screenOf('dialog-background-work-exit-2.1.309.txt');
/** "Session paused" after a fake API refusal, no footer (CLI 2.1.322). */
const PAUSE = screenOf('kontrolny/pauza-2.1.322.txt');
/** The pause from the CLI 2.1.309 capture (model with "(1M context)"). */
const PAUSE_309 = screenOf('dialog-session-paused-2.1.309.txt');
/** A pause with the same title and another option set (options made up). */
const PAUSE_OTHER = PAUSE.replace(
  '  ❯ 1. Switch to Opus 4.8\n    2. Edit prompt and retry with Opus 5.5',
  '  ❯ 1. Keep waiting\n    2. Switch to Opus 4.8',
);

const EXIT_LABELS = ['Exit and stop tasks', 'Move to background and exit', 'Stay', 'Esc to cancel'];
const PAUSE_LABELS = ['Switch to Opus 4.8', 'Edit prompt and retry with Opus 5.5'];

const NONE_CONFIRMED: ReadonlySet<TerminalDialogId> = new Set();

const labelsOf = (verdict: Layer2Verdict): string[] => (
  verdict.kind === 'choices' ? verdict.choices.map((choice) => choice.label) : []);

// ---------------------------------------------------------------------------------------------------------------
// The driver on a driven clock (the harness of `layer2-step-driver.test.ts`)
// ---------------------------------------------------------------------------------------------------------------

const WAITING_DIALOG: CliWaitingSignal = { kind: 'waiting', dialog: 'dialog' };
/** Clock time a layer 2 card needs: the evaluation, the pair gap and the forced read. */
const ISSUE_MS = STABILITY_GAP_MS * 2;

interface Pane {
  fx: Fixture;
  advance: (ms: number) => Promise<void>;
}

const CARD_TYPES = new Set<DriverEvent['type']>(['screen-dialog', 'question-request', 'permission-request']);
const cardsOf = (events: readonly DriverEvent[]): DriverEvent[] => events.filter((e) => CARD_TYPES.has(e.type));
type QuestionCard = Extract<DriverEvent, { type: 'question-request' }>;

/** The last card the driver showed. */
function lastCard(fx: Fixture): DriverEvent | undefined {
  return cardsOf(fx.events).at(-1);
}

/** The last card, which must be a layer 2 card. */
function layer2Card(fx: Fixture): QuestionCard {
  const card = lastCard(fx);
  if (card?.type !== 'question-request' || !card.reqId.startsWith('l2:')) throw new Error('no layer 2 card');
  return card;
}

/** Keys and text that reached the pane, in order. */
const sent = (fx: Fixture): string[] => fx.client.calls
  .filter((call) => call.method !== 'read' && call.method !== 'history')
  .map((call) => `${call.method}:${(call.keys ?? [call.text ?? '']).join(',')}`);

const approveLines = (fx: Fixture) => fx.audit.filter((entry) => entry.method === 'approve');
const refuseLines = (fx: Fixture) => fx.audit.filter((entry) => entry.method === 'refuse');

/** A pane blocked on `screen` with the registry at `waiting`, class `dialog`; waits the time a layer 2 card needs. */
async function blockedOn(screen: string, layer2: boolean): Promise<Pane> {
  const clock = drivenClock();
  const fx = await makeDriver({
    transcript: userLine('work'), screen,
    deps: {
      dialogLayer2: layer2, screenCacheMs: 0, sessionId: 'session-test', scheduler: clock.scheduler,
      consentRegistryRead: () => Promise.resolve(WAITING_DIALOG),
      consentRegistrationWaits: () => false,
      logger: () => undefined,
    },
  });
  await waitFor(() => fx.events.some((e) => e.type === 'history'), 'history');
  fx.driver.noteCliWaiting?.(WAITING_DIALOG);
  fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
  await clock.advance(ISSUE_MS);
  return { fx, advance: clock.advance };
}

/** Runs a decision on the driven clock to its end. */
async function settle<T>(pane: Pane, decision: Promise<T>): Promise<T> {
  let done = false;
  const result = decision.finally(() => { done = true; });
  for (let i = 0; i < 20 && !done; i += 1) await pane.advance(0);
  return result;
}

describe('exit with background work, confirmed: the layer 2 card and the step', () => {
  it('the card: three options and "Esc to cancel", literal labels, the whole block as the question', async () => {
    const { fx } = await blockedOn(EXIT, true);
    const card = layer2Card(fx);
    const [question] = card.questions;
    expect(question?.header).toBe('Background work is running');
    expect(question?.options.map((option) => option.label)).toEqual(EXIT_LABELS);
    expect(question?.options.some((option) => option.terminalOnly === true)).toBe(false);
    expect(question?.question.split('\n').at(-1)?.trim()).toBe('Enter to confirm · Esc to cancel');
  });

  it('tap "Stay", the fresh screen equal: one key `3`, applied', async () => {
    const pane = await blockedOn(EXIT, true);
    const card = layer2Card(pane.fx);
    expect(await settle(pane, pane.fx.driver.answerQuestion(card.reqId, [['Stay']]))).toEqual({ kind: 'applied' });
    expect(sent(pane.fx)).toEqual(['send_keys:3']);
    expect(approveLines(pane.fx)).toEqual([expect.objectContaining({
      keys: ['3'], toolName: 'dialog:layer2', optionLabel: 'Stay', reqId: card.reqId, layer2: true, layer2Key: 'digit',
    })]);
  });

  it('tap "Exit and stop tasks": one key `1`', async () => {
    const pane = await blockedOn(EXIT, true);
    const card = layer2Card(pane.fx);
    expect(await settle(pane, pane.fx.driver.answerQuestion(card.reqId, [['Exit and stop tasks']])))
      .toEqual({ kind: 'applied' });
    expect(sent(pane.fx)).toEqual(['send_keys:1']);
    expect(approveLines(pane.fx)).toEqual([expect.objectContaining({
      keys: ['1'], optionLabel: 'Exit and stop tasks', layer2Key: 'digit',
    })]);
  });

  it('tap "Exit and stop tasks" while another label stands under `1`: `screen-changed`, no key', async () => {
    const pane = await blockedOn(EXIT, true);
    const card = layer2Card(pane.fx);
    pane.fx.client.screenText = EXIT.replace('1. Exit and stop tasks', '1. Exit and keep tasks');
    expect(await settle(pane, pane.fx.driver.answerQuestion(card.reqId, [['Exit and stop tasks']])))
      .toEqual({ kind: 'refused', reason: 'screen-changed' });
    expect(sent(pane.fx)).toEqual([]);
    expect(refuseLines(pane.fx)).toEqual([expect.objectContaining({
      reason: 'screen-changed', layer2Why: 'screen-changed', reqId: card.reqId,
    })]);
    expect(systemCodes(pane.fx.events)).toContain('dialogs.screen-changed');
  });

  it('"Esc to cancel" by its label and by `deny`: one `escape` through the step', async () => {
    for (const how of ['label', 'deny'] as const) {
      const pane = await blockedOn(EXIT, true);
      const card = layer2Card(pane.fx);
      const decision = how === 'label'
        ? pane.fx.driver.answerQuestion(card.reqId, [['Esc to cancel']])
        : pane.fx.driver.respondPermission('session-test', 'deny');
      expect(await settle(pane, decision), how).toEqual({ kind: 'applied' });
      expect(sent(pane.fx), how).toEqual(['send_keys:escape']);
      expect(approveLines(pane.fx), how).toEqual([expect.objectContaining({
        keys: ['escape'], reqId: card.reqId, layer2: true, layer2Key: 'escape',
      })]);
    }
  });

  it('under the status rule the same card as under a bare rule: the same choices and question', () => {
    const cards = [EXIT, EXIT_BARE.replace(/shell · .*\n/u, 'shell · sleep 6007\n')].map((text) => {
      const action = decideOrThrow(text);
      const judged = judgeLayer2(action, readBlock(text), { enabled: true, engine: 'claude', cliClass: 'dialog' });
      if (judged.kind !== 'choices') throw new Error(judged.kind);
      return { choices: judged.verdict.choices, question: judged.verdict.block.split('\n').map((line) => line.trim()) };
    });
    expect(cards[0]?.choices.map((choice) => choice.label)).toEqual(EXIT_LABELS);
    expect(cards[1]).toEqual(cards[0]);
  });
});

describe('session paused, confirmed: two buttons without Esc', () => {
  it('the card: the two literal option labels, no Esc', async () => {
    const { fx } = await blockedOn(PAUSE, true);
    const card = layer2Card(fx);
    expect(card.questions[0]?.header).toBe('Session paused');
    expect(card.questions[0]?.options.map((option) => option.label)).toEqual(PAUSE_LABELS);
    expect(card.questions[0]?.options.some((option) => option.terminalOnly === true)).toBe(false);
  });

  it('the CLI 2.1.309 pause: the same two buttons with its own literal labels', () => {
    expect(labelsOf(layer2Verdict(readBlock(PAUSE_309), 'dialog')))
      .toEqual(['Switch to Opus 4.8', 'Edit prompt and retry with Opus 5.5 (1M context)']);
  });

  it('tap "Switch to Opus 4.8": one key `1`, applied', async () => {
    const pane = await blockedOn(PAUSE, true);
    const card = layer2Card(pane.fx);
    expect(await settle(pane, pane.fx.driver.answerQuestion(card.reqId, [['Switch to Opus 4.8']])))
      .toEqual({ kind: 'applied' });
    expect(sent(pane.fx)).toEqual(['send_keys:1']);
  });

  it('`deny` from `POST …/permission` over the pause card: the pause refusal, no key', async () => {
    const pane = await blockedOn(PAUSE, true);
    layer2Card(pane.fx);
    expect(await settle(pane, pane.fx.driver.respondPermission('session-test', 'deny')))
      .toEqual({ kind: 'refused', reason: 'terminal-only' });
    expect(sent(pane.fx)).toEqual([]);
    expect(systemCodes(pane.fx.events)).toContain('dialogs.pause-escape');
  });

  it('a pause with another option set: `terminal-dialog`, today\'s card stays', () => {
    const action = decideOrThrow(PAUSE_OTHER);
    const judged = judgeLayer2(action, readBlock(PAUSE_OTHER), { enabled: true, engine: 'claude', cliClass: 'dialog' });
    expect(judged).toEqual({ kind: 'none', why: 'terminal-dialog' });
    expect(todayHasButtons(action)).toBe(false);
  });
});

describe('without the confirmation or with the flag `0`: today\'s "answer in the terminal" card', () => {
  it('an entry without the confirmation: `terminal-dialog` for both dialogs, today\'s card without a button', () => {
    for (const text of [EXIT_BARE, PAUSE, PAUSE_309]) {
      expect(layer2Verdict(readBlock(text), 'dialog', { confirmedTerminal: NONE_CONFIRMED }))
        .toEqual({ kind: 'none', why: 'terminal-dialog' });
      const action = decideOrThrow(text);
      expect(action.kind).toBe('card');
      expect(action.kind === 'card' && action.card.active.options.every((option) => option.terminalOnly === true))
        .toBe(true);
    }
  });

  it('the flag `0`: today\'s card with every option for the terminal, a tap and `allow` send no key', async () => {
    for (const [text, label] of [[EXIT_BARE, 'Stay'], [PAUSE, 'Switch to Opus 4.8']] as const) {
      const pane = await blockedOn(text, false);
      const card = lastCard(pane.fx);
      if (card?.type !== 'question-request') throw new Error('no question card');
      expect(card.reqId.startsWith('l2:')).toBe(false);
      expect(card.questions[0]?.options.every((option) => option.terminalOnly === true)).toBe(true);
      expect(await settle(pane, pane.fx.driver.answerQuestion(card.reqId, [[label]])))
        .toEqual({ kind: 'refused', reason: 'terminal-only' });
      // A refusal clears the card and has it rebuilt: `allow` goes to the rebuilt card.
      await pane.advance(ISSUE_MS);
      expect(lastCard(pane.fx)).not.toBe(card);
      expect(await settle(pane, pane.fx.driver.respondPermission('session-test', 'allow')))
        .toEqual({ kind: 'refused', reason: 'terminal-only' });
      expect(sent(pane.fx)).toEqual([]);
    }
  });

  it('a stale `screen:` card labelled "Switch to Opus 4.8" while the pause stands: no key, as today', async () => {
    const question = [
      '────────────────────────────────────────',
      ' Change model?',
      '',
      '  ❯ 1. Switch to Opus 4.8',
      '    2. Keep current model',
    ].join('\n');
    const pane = await blockedOn(question, true);
    const card = lastCard(pane.fx);
    if (card?.type !== 'question-request') throw new Error('no question card');
    expect(card.reqId.startsWith('screen:')).toBe(true);
    pane.fx.client.screenText = PAUSE;
    expect(await settle(pane, pane.fx.driver.answerQuestion(card.reqId, [['Switch to Opus 4.8']])))
      .toEqual({ kind: 'refused', reason: 'screen-changed' });
    expect(sent(pane.fx)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The confirmation in the list: the measured keys, fail closed, and the guard of its captures
// ---------------------------------------------------------------------------------------------------------------

const M: KeyMeasurement = { cli: '2.1.322', capture: 'kontrolny/wyjscie-tlo-2.1.322.txt' };

describe('`confirmedKeys`: a measurement for every option and for Esc, else no confirmation', () => {
  it('every option and Esc measured: the measurements', () => {
    expect(confirmedKeys({ options: [M, M], escape: M }, 2)).toEqual({ options: [M, M], escape: M });
  });

  it.each([
    ['one option without a measurement', { options: [M, null], escape: M }],
    ['fewer measurements than options', { options: [M], escape: M }],
    ['more measurements than options', { options: [M, M, M], escape: M }],
    ['Esc without a measurement', { options: [M, M], escape: null }],
  ] as const)('%s: `null`', (_name, measured) => {
    expect(confirmedKeys(measured, 2)).toBeNull();
  });
});

interface ControlShape {
  readonly file: string;
  readonly cli: string;
  readonly waitingFor: { readonly status: string; readonly value: string };
}
const CONTROL = (JSON.parse(readFileSync(join(KONTROLNY, 'manifest.json'), 'utf8')) as {
  shapes: ControlShape[];
}).shapes;

/**
 * What is wrong with the measurement of a `TERMINAL_DIALOGS` entry; `[]` = nothing. Each measured key points to
 * a capture in the control set: the file exists in `kontrolny/`, its name ends with the CLI version of the
 * measurement, the control set manifest lists it with that version and with the registry `waiting`, `dialog open`,
 * and the capture shows this dialog (layer 2 gives choices with this entry confirmed, `terminal-dialog` without).
 */
function measurementProblems(id: TerminalDialogId, keys: KeysMeasured): string[] {
  const problems: string[] = [];
  const captures = new Map<string, string>();
  const named = [
    ...keys.options.map((key, i) => [`option ${String(i + 1)}`, key] as const),
    ['Esc', keys.escape] as const,
  ];
  for (const [what, key] of named) {
    if (!key.capture.startsWith('kontrolny/') || !existsSync(join(FIXTURES, key.capture))) {
      problems.push(`${id} ${what}: capture ${key.capture} is not in kontrolny/`);
      continue;
    }
    if (!key.capture.endsWith(`-${key.cli}.txt`)) problems.push(`${id} ${what}: capture without the CLI ${key.cli}`);
    const shape = CONTROL.find((entry) => entry.file === key.capture);
    if (shape?.cli !== key.cli) problems.push(`${id} ${what}: not in the control set manifest on ${key.cli}`);
    if (shape?.waitingFor.value !== 'dialog open') problems.push(`${id} ${what}: the capture is not of class dialog`);
    if (!captures.has(key.capture)) captures.set(key.capture, what);
  }
  for (const [capture, what] of captures) {
    const block = readBlock(screenOf(capture));
    const confirmed = layer2Verdict(block, 'dialog', { confirmedTerminal: new Set([id]) });
    const unconfirmed = layer2Verdict(block, 'dialog', { confirmedTerminal: NONE_CONFIRMED });
    if (confirmed.kind !== 'choices' || unconfirmed.kind !== 'none' || unconfirmed.why !== 'terminal-dialog') {
      problems.push(`${id} ${what}: ${capture} does not show this dialog`);
    }
  }
  return problems;
}

describe('the measurements of the list point to the control set', () => {
  const confirmed = TERMINAL_DIALOGS.filter((dialog) => dialog.keysMeasured !== null);

  it('both dialogs confirmed on CLI 2.1.322, a measurement for every option and for Esc', () => {
    expect(confirmed.map((dialog) => dialog.id)).toEqual(['session-paused-safeguards', 'background-work-exit']);
    for (const dialog of confirmed) {
      expect(dialog.keysMeasured?.options, dialog.id).toHaveLength(dialog.options.length);
      for (const key of [...(dialog.keysMeasured?.options ?? []), dialog.keysMeasured?.escape]) {
        expect(key?.cli, dialog.id).toBe('2.1.322');
      }
    }
  });

  it('every measurement points to a capture of its dialog in kontrolny/ (guard)', () => {
    const problems = confirmed.flatMap((dialog) => (dialog.keysMeasured === null ? []
      : measurementProblems(dialog.id, dialog.keysMeasured)));
    expect(problems).toEqual([]);
  });

  it('a measurement that points to a capture missing from kontrolny/: the guard fails', () => {
    const missing: KeyMeasurement = { cli: '2.1.322', capture: 'kontrolny/wyjscie-tlo-2.1.399.txt' };
    expect(measurementProblems('background-work-exit', { options: [M, missing, M], escape: M }))
      .toEqual(['background-work-exit option 2: capture kontrolny/wyjscie-tlo-2.1.399.txt is not in kontrolny/']);
  });

  it('a measurement that points to a capture of another dialog: the guard fails', () => {
    const pause: KeyMeasurement = { cli: '2.1.322', capture: 'kontrolny/pauza-2.1.322.txt' };
    expect(measurementProblems('background-work-exit', { options: [pause, pause, pause], escape: pause }))
      .toEqual(['background-work-exit option 1: kontrolny/pauza-2.1.322.txt does not show this dialog']);
  });

  it('the default rule follows the list: a confirmed entry gives choices over its capture, none other', () => {
    for (const dialog of TERMINAL_DIALOGS) {
      const capture = dialog.keysMeasured?.escape.capture;
      if (capture === undefined) continue;
      const verdict = layer2Verdict(readBlock(screenOf(capture)), 'dialog');
      expect(verdict.kind, dialog.id).toBe('choices');
    }
    expect(layer2Verdict(readBlock(PAUSE_OTHER), 'dialog')).toEqual({ kind: 'none', why: 'terminal-dialog' });
  });

  it('the pause measurement does not open Esc: the pause card never has it, even under a footer naming it', () => {
    const text = [...trimmedLines(PAUSE), '', '  Enter to confirm · Esc to cancel'].join('\n');
    expect(labelsOf(layer2Verdict(readBlock(text), 'dialog'))).toEqual(PAUSE_LABELS);
  });
});

// ---------------------------------------------------------------------------------------------------------------

function input(text: string): DecideInput {
  return {
    pending: null,
    hookPending: null,
    text,
    reqId: evaluationReqId(null, null, null, 1),
    active: null,
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

function decideOrThrow(text: string): Extract<DecideAction, { kind: 'card' | 'screen-dialog' }> {
  const action = decideCard(input(text));
  if (action.kind !== 'card' && action.kind !== 'screen-dialog') throw new Error(action.kind);
  return action;
}
