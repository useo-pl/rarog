/**
 * The start dialog gate in the real herdr driver over a fake herdr client: while a Claude Code start dialog herdr
 * reads as ready stands (the external imports dialog, or an unknown one the launcher found), no action from the phone
 * puts a key or text into the pane, and the transcript gets a sentence. The card says once what stands. The dialogs
 * Rarog already reads in the start phase (trust, a card with digits) and the bypass mode warning work as before.
 *
 * Captures: `kontrolny/importy-zewnetrzne-*-2.1.332.txt` (CLI 2.1.332), `kontrolny/zaufanie-*-2.1.319.txt`,
 * `kontrolny/tryb-bypass-2.1.319.txt` (CLI 2.1.319) and `dialog-resume-summary-2.1.258.txt` (CLI 2.1.258).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { StartDialogGate, readStartDialog } from '../src/drivers/herdr/start-dialog-gate.ts';
import type { HerdrDriverDeps } from '../src/drivers/herdr-driver.ts';
import type { HerdrStartPhase } from '../src/herdr/types.ts';
import type { OwnText } from '@rarog/shared/sentences';
import {
  EMPTY_FIELD, FIXTURES, FakeClient, cleared, commandOpts, makeDriver, questions, quiet, screenDialogs, systemCodes,
  useDriverSandbox, userLine, waitFor,
} from './helpers/herdr-driver-atrapy.ts';
import type { Fixture } from './helpers/herdr-driver-atrapy.ts';

useDriverSandbox();

const read = (file: string): string => readFileSync(join(FIXTURES, file), 'utf8');
const IMPORTS = read('kontrolny/importy-zewnetrzne-2.1.332.txt');
const IMPORTS_AFTER_TRUST = read('kontrolny/importy-zewnetrzne-po-zaufaniu-2.1.332.txt');
const TRUST = read('kontrolny/zaufanie-2.1.319.txt');
const TRUST_DOWN = read('kontrolny/zaufanie-po-down-2.1.319.txt');
const BYPASS = read('kontrolny/tryb-bypass-2.1.319.txt');
const RESUME = read('dialog-resume-summary-2.1.258.txt');
const TITLE = 'Allow external CLAUDE.md file imports?';
/** A start dialog no signature knows: the imports block under another title, with another footer. */
const UNKNOWN = IMPORTS.replace(TITLE, 'Continue with the new setup?').replace('Esc to disable', 'Esc to cancel');
/** A start dialog no signature knows, with digits: options parse, yet they make neither a known dialog nor a form. */
const UNKNOWN_DIGITS = [
  '$ claude', '', '─'.repeat(80), '  New workspace setup', '',
  '  Claude Code will prepare this folder for a new workspace.', '',
  '  ❯ 1. Continue', '    2. Stop', '', '  Enter to confirm · Esc to cancel',
].join('\n');
/** The folder of the trust captures; the trust step proves it equals the session's `cwd`. */
const TRUST_CWD = '/Users/u/projekt';

const IMPORTS_CODE = 'dialogs.start-dialog.imports';
const UNKNOWN_CODE = 'dialogs.start-dialog.unknown';
const REFUSED_CODE = 'dialogs.start-dialog.refused';
const START_CODES = [IMPORTS_CODE, UNKNOWN_CODE, REFUSED_CODE];

const IMPORTS_PHASE: HerdrStartPhase = { startDialog: { id: 'external-imports', title: TITLE } };
/** herdr reported `blocked` itself (trust, bypass mode, resume summary), so the launcher read no start dialog. */
const HERDR_BLOCKED_PHASE: HerdrStartPhase = { startDialog: null };
const TERMINAL_ONLY = { kind: 'refused', reason: 'terminal-only' };

interface GateFx {
  readonly fx: Fixture;
  /** What the supervisor says now; `null` = herdr knows the engine session, the start phase is over. */
  readonly phase: { now: HerdrStartPhase | null };
}

/** A pane Rarog launched, in its start phase, on `screen`; with `blocked` the driver's first card has come. */
async function startPane(opts: {
  screen?: string; phase?: HerdrStartPhase | null; status?: 'blocked' | 'idle'; transcript?: string;
  deps?: Partial<HerdrDriverDeps>;
} = {}): Promise<GateFx> {
  const phase = { now: opts.phase === undefined ? IMPORTS_PHASE : opts.phase };
  const status = opts.status ?? 'blocked';
  const fx = await makeDriver({
    ...(opts.transcript === undefined ? { noTranscript: true } : { transcript: opts.transcript }),
    agent: { status, cwd: TRUST_CWD, launchedByRarog: true, interactiveReady: false },
    screen: opts.screen ?? IMPORTS,
    deps: { startPhase: () => phase.now, formSubmitConfirmDelayMs: 0, ...opts.deps },
  });
  if (status === 'blocked') {
    await waitFor(() => screenDialogs(fx.events).length + questions(fx.events).length > 0, 'the first card');
  }
  return { fx, phase };
}

const codes = (fx: Fixture): string[] => systemCodes(fx.events);
const countOf = (fx: Fixture, code: string): number => codes(fx).filter((c) => c === code).length;
const keysSent = (fx: Fixture): (readonly string[] | undefined)[] => fx.client.calls
  .filter((c) => c.method === 'send_keys' || c.method === 'trust_step' || c.method === 'dialog_key')
  .map((c) => c.keys);
const prompts = (fx: Fixture): (string | undefined)[] => fx.client.calls
  .filter((c) => c.method === 'prompt' || c.method === 'paste').map((c) => c.text);

/** Nothing reached the pane and the transcript got the refusal sentence. */
async function refusedWithoutKey(fx: Fixture): Promise<void> {
  await waitFor(() => codes(fx).includes(REFUSED_CODE), 'the refusal sentence');
  await quiet();
  expect(fx.client.mutations).toBe(0);
}

/** The trust step as measured: `down` moves the cursor, `enter` answers and the next screen stands. */
function liveTrust(fx: Fixture, afterEnter: string): void {
  fx.client.sendTrustStep = (paneId, key) => {
    fx.client.calls.push({ method: 'trust_step', paneId, keys: [key] });
    fx.client.screenText = key === 'down' ? TRUST_DOWN : afterEnter;
    return Promise.resolve();
  };
}

describe('start dialog gate in the driver: the contract rows', () => {
  it('the imports card says once what stands; a refusal that shows the card again says nothing new', async () => {
    const { fx } = await startPane();
    await waitFor(() => countOf(fx, IMPORTS_CODE) === 1, 'the card sentence');
    expect(screenDialogs(fx.events)[0]?.knownDialog).toBeUndefined();

    await fx.driver.respondPermission('any', 'deny');
    await waitFor(() => screenDialogs(fx.events).length > 1, 'the card shown again');
    await quiet();
    expect(countOf(fx, IMPORTS_CODE)).toBe(1);
    expect(fx.client.mutations).toBe(0);
  });

  it('the card sentence goes once while the blocked poll judges the same dialog again', async () => {
    const { fx } = await startPane({ deps: { blockedPollMs: 5 } });
    const before = fx.client.calls.filter((c) => c.method === 'read').length;
    await waitFor(() => fx.client.calls.filter((c) => c.method === 'read').length > before + 3, 'poll reads');
    expect(countOf(fx, IMPORTS_CODE)).toBe(1);
  });

  it('deny ("Odrzuć"): refused in the driver, no Esc', async () => {
    const { fx } = await startPane();
    expect(await fx.driver.respondPermission('any', 'deny')).toEqual(TERMINAL_ONLY);
    await refusedWithoutKey(fx);
  });

  it('allow on the imports card: refused, no key', async () => {
    const { fx } = await startPane();
    expect(await fx.driver.respondPermission('any', 'allow')).toEqual(TERMINAL_ONLY);
    await refusedWithoutKey(fx);
  });

  it('allow on a trust card that the imports dialog replaced on screen: no trust step', async () => {
    const { fx } = await startPane({ screen: TRUST, phase: HERDR_BLOCKED_PHASE });
    expect(screenDialogs(fx.events)[0]?.knownDialog).toBe('trust');
    fx.client.screenText = IMPORTS_AFTER_TRUST;
    expect(await fx.driver.respondPermission('sess-1', 'allow')).toEqual(TERMINAL_ONLY);
    await refusedWithoutKey(fx);
  });

  it('interrupt (Esc from the app keyboard): refused in the driver, no Esc', async () => {
    const { fx } = await startPane();
    expect(await fx.driver.interrupt()).toBe(false);
    await refusedWithoutKey(fx);
  });

  it.each([
    ['a message', 'hello', undefined],
    ['a slash command', '/compact', commandOpts('/compact')],
  ])('%s while the pane is blocked on the dialog: no paste, no prompt', async (_name, text, opts) => {
    const { fx } = await startPane();
    fx.driver.send(text, undefined, undefined, opts);
    await refusedWithoutKey(fx);
    expect(prompts(fx)).toEqual([]);
  });

  it('a message to a pane in its start phase the driver never judged blocked: a fresh read refuses it', async () => {
    const { fx } = await startPane({ status: 'idle' });
    fx.driver.send('hello');
    await refusedWithoutKey(fx);
    expect(prompts(fx)).toEqual([]);
  });

  it('take-back of the queues: refused as a dialog, no key', async () => {
    const { fx } = await startPane();
    expect(await fx.driver.takeBackQueue?.()).toEqual({ refused: 'dialog' });
    await quiet();
    expect(fx.client.mutations).toBe(0);
  });

  it('a command whose gate read shows trust and the next pre-send read the imports dialog: no prompt', async () => {
    const { fx } = await startPane({ screen: TRUST, phase: HERDR_BLOCKED_PHASE });
    // The gate's fresh read still shows trust; the imports dialog replaces it before the consent dialog check reads.
    let reads = 0;
    fx.client.readScreen = (paneId, source) => {
      fx.client.calls.push({ method: 'read', paneId, source });
      reads += 1;
      return Promise.resolve({ text: reads === 1 ? TRUST : IMPORTS_AFTER_TRUST });
    };
    fx.driver.send('/compact', undefined, undefined, commandOpts('/compact'));
    await waitFor(() => prompts(fx).length > 0 || codes(fx).includes(REFUSED_CODE), 'the prompt or the refusal');
    expect(prompts(fx)).toEqual([]);
    expect(reads).toBeGreaterThan(1);
    await refusedWithoutKey(fx);
  });

  it('a command whose field clearing reads the imports dialog behind trust detection reads: no prompt', async () => {
    const { fx } = await startPane({ screen: TRUST, phase: HERDR_BLOCKED_PHASE });
    // Detection reads keep showing trust; the field read with attributes, the last before the client call, shows the
    // imports dialog. The interrupt sets the field clearing for the send it waits behind.
    // With attributes, as herdr gives it: the rule, the highlighted option and the footer carry SGR sequences.
    fx.client.screenAnsi = IMPORTS_AFTER_TRUST.split('\n').map((line) => (/─|❯|Enter to confirm/u.test(line)
      ? `\u001b[0m\u001b[38;2;255;193;7m${line}\u001b[39m` : line)).join('\n');
    fx.driver.send('/compact', undefined, undefined, commandOpts('/compact'));
    void fx.driver.interrupt();
    await waitFor(() => prompts(fx).length > 0 || codes(fx).includes(REFUSED_CODE), 'the prompt or the refusal');
    await quiet();
    expect(prompts(fx)).toEqual([]);
    expect(codes(fx)).toContain(REFUSED_CODE);
  });

  it('take-back after a failed screen read on a pane never judged blocked: the remembered dialog refuses it',
    async () => {
      const { fx } = await startPane({ status: 'idle' });
      // A refused message is the read that shows the dialog; the take-back's own read fails.
      fx.driver.send('hello');
      await refusedWithoutKey(fx);
      fx.client.readScreen = () => Promise.reject(new Error('socket refused'));
      expect(await fx.driver.takeBackQueue?.()).toEqual({ refused: 'dialog' });
      await quiet();
      expect(fx.client.mutations).toBe(0);
    });

  it.each([
    ['deny', (fx: Fixture) => fx.driver.respondPermission('any', 'deny')],
    ['interrupt', (fx: Fixture) => fx.driver.interrupt()],
  ])('%s after a failed screen read: the remembered dialog still refuses', async (_name, act) => {
    const { fx } = await startPane();
    await waitFor(() => countOf(fx, IMPORTS_CODE) === 1, 'the card sentence');
    fx.client.readScreen = () => Promise.reject(new Error('socket refused'));
    await act(fx);
    await refusedWithoutKey(fx);
  });

  it.each([
    ['the imports dialog', IMPORTS_PHASE],
    ['an unknown start dialog', { startDialog: { id: null, title: 'Continue with the new setup?' } }],
  ])('the launcher found %s and no screen read succeeds: deny and interrupt send no Esc', async (_name, phase) => {
    const client = new FakeClient();
    client.readScreen = (paneId, source) => {
      client.calls.push({ method: 'read', paneId, source });
      return Promise.reject(new Error('socket refused'));
    };
    const fx = await makeDriver({
      noTranscript: true,
      agent: { status: 'blocked', cwd: TRUST_CWD, launchedByRarog: true, interactiveReady: false },
      deps: { client, startPhase: () => phase },
    });
    expect(await fx.driver.respondPermission('any', 'deny')).toEqual(TERMINAL_ONLY);
    expect(await fx.driver.interrupt()).toBe(false);
    await quiet();
    expect(client.calls.some((c) => c.method === 'read')).toBe(true);
    expect(client.mutations).toBe(0);
  });

  it.each([
    ['without digits', UNKNOWN, 'Continue with the new setup?'],
    ['with digits', UNKNOWN_DIGITS, 'New workspace setup'],
  ])('an unknown start dialog the launcher found, %s: its own card sentence, and deny sends no key', async (
    _name, screen, title,
  ) => {
    const phase = { startDialog: { id: null, title } };
    const { fx } = await startPane({ screen, phase });
    await waitFor(() => countOf(fx, UNKNOWN_CODE) === 1, 'the card sentence');
    expect(await fx.driver.respondPermission('any', 'deny')).toEqual(TERMINAL_ONLY);
    await refusedWithoutKey(fx);
  });
});

describe('start dialog gate in the driver: dialogs Rarog reads work as before', () => {
  it('Esc on the trust card goes', async () => {
    const { fx } = await startPane({ screen: TRUST, phase: HERDR_BLOCKED_PHASE });
    expect((await fx.driver.respondPermission('sess-1', 'deny')).kind).toBe('applied');
    expect(keysSent(fx)).toEqual([['escape']]);
    expect(codes(fx).filter((c) => START_CODES.includes(c))).toEqual([]);
  });

  it('the trust step goes: `down`, then `enter`', async () => {
    const { fx } = await startPane({ screen: TRUST, phase: HERDR_BLOCKED_PHASE });
    liveTrust(fx, TRUST_DOWN);
    expect((await fx.driver.respondPermission('sess-1', 'allow')).kind).toBe('applied');
    expect(keysSent(fx)).toEqual([['down'], ['enter']]);
  });

  it('a digit on the resume summary card goes', async () => {
    const { fx } = await startPane({ screen: RESUME, phase: HERDR_BLOCKED_PHASE, transcript: userLine('work') });
    const card = questions(fx.events)[0];
    const outcome = await fx.driver.answerQuestion(card?.reqId ?? '', [['Resume from summary (recommended)']]);
    expect(outcome.kind).toBe('applied');
    expect(keysSent(fx)).toEqual([['1']]);
  });

  it('the bypass mode warning herdr reports blocked: its card and Esc as before, no start sentence', async () => {
    const { fx } = await startPane({ screen: BYPASS, phase: HERDR_BLOCKED_PHASE });
    expect(screenDialogs(fx.events)[0]?.knownDialog).toBeUndefined();
    expect((await fx.driver.respondPermission('any', 'deny')).kind).toBe('applied');
    expect(keysSent(fx)).toEqual([['escape']]);
    expect(codes(fx).filter((c) => START_CODES.includes(c))).toEqual([]);
  });
});

describe('start dialog gate in the driver: trust, then imports, then the answer in the terminal', () => {
  it('the imports card replaces the trust card, every action is refused, the message after the answer goes once',
    async () => {
      const { fx, phase } = await startPane({
        screen: TRUST, phase: HERDR_BLOCKED_PHASE, deps: { blockedPollMs: 20 },
      });
      liveTrust(fx, IMPORTS_AFTER_TRUST);
      expect((await fx.driver.respondPermission('sess-1', 'allow')).kind).toBe('applied');
      await waitFor(() => countOf(fx, IMPORTS_CODE) === 1, 'the imports card');
      expect(screenDialogs(fx.events).at(-1)?.knownDialog).toBeUndefined();

      expect(await fx.driver.respondPermission('any', 'deny')).toEqual(TERMINAL_ONLY);
      expect(await fx.driver.respondPermission('any', 'allow')).toEqual(TERMINAL_ONLY);
      expect(await fx.driver.interrupt()).toBe(false);
      await quiet();
      expect(keysSent(fx)).toEqual([['down'], ['enter']]);
      expect(countOf(fx, IMPORTS_CODE)).toBe(1);

      // The answer in the terminal: the prompt field, herdr knows the engine session, the pane is idle.
      fx.client.screenText = EMPTY_FIELD;
      phase.now = null;
      fx.emit({ type: 'status', status: 'idle', stateChangeSeq: 9, title: '' });
      await waitFor(() => cleared(fx.events).length > 0, 'the card gone');
      fx.driver.send('do X');
      await waitFor(() => prompts(fx).length > 0, 'the prompt');
      await quiet();
      expect(prompts(fx)).toEqual(['do X']);
      expect(keysSent(fx)).toEqual([['down'], ['enter']]);
    });
});

describe('readStartDialog: one screen of a pane in its start phase', () => {
  it.each([
    ['cursor on "No"', IMPORTS],
    ['after `down`', read('kontrolny/importy-zewnetrzne-po-down-2.1.332.txt')],
    ['after the trust dialog', IMPORTS_AFTER_TRUST],
  ])('the imports dialog %s stands, whatever the launcher read', (_name, screen) => {
    for (const phase of [IMPORTS_PHASE, HERDR_BLOCKED_PHASE]) {
      expect(readStartDialog(screen, phase)).toEqual({ id: 'external-imports', title: TITLE });
    }
  });

  it('a long import list with its title above the pane edge stands', () => {
    expect(readStartDialog(read('kontrolny/importy-zewnetrzne-dluga-lista-2.1.332.txt'), HERDR_BLOCKED_PHASE))
      .toEqual({ id: 'external-imports', title: null });
  });

  it.each([
    ['the prompt field', EMPTY_FIELD],
    ['the trust dialog', TRUST],
    ['the resume summary with digits', RESUME],
  ])('%s proves the start dialog gone', (_name, screen) => {
    expect(readStartDialog(screen, IMPORTS_PHASE)).toBe('gone');
  });

  it('digits that make neither a known dialog nor a form do not prove an unknown start dialog gone', () => {
    expect(readStartDialog(UNKNOWN_DIGITS, { startDialog: { id: null, title: 'New workspace setup' } }))
      .toEqual({ id: null, title: 'New workspace setup' });
  });

  it('the bypass mode warning stands only when the launcher found an unknown start dialog', () => {
    expect(readStartDialog(BYPASS, HERDR_BLOCKED_PHASE)).toBe('unclear');
    expect(readStartDialog(BYPASS, { startDialog: { id: null, title: null } })).toMatchObject({ id: null });
  });

  it('a blank screen proves nothing', () => {
    expect(readStartDialog('\n  \n', IMPORTS_PHASE)).toBe('unclear');
  });
});

describe('StartDialogGate: memory and the card sentence', () => {
  function gate(screen: () => Promise<string | null>): {
    gate: StartDialogGate; phase: { now: HerdrStartPhase | null }; said: OwnText[];
  } {
    const phase: { now: HerdrStartPhase | null } = { now: HERDR_BLOCKED_PHASE };
    const said: OwnText[] = [];
    const port = { startPhase: () => phase.now, readScreen: screen, system: (text: OwnText) => { said.push(text); } };
    return { gate: new StartDialogGate(port), phase, said };
  }

  it('a failed or blank read keeps the dialog; the prompt field ends it', async () => {
    let next: string | null = IMPORTS;
    const g = gate(() => Promise.resolve(next));
    expect(await g.gate.refuses()).toBe(true);
    next = null;
    expect(await g.gate.refuses()).toBe(true);
    expect(await g.gate.refuses('\n')).toBe(true);
    expect(g.gate.holds()).toBe(true);
    expect(await g.gate.refuses(EMPTY_FIELD)).toBe(false);
    expect(g.gate.holds()).toBe(false);
  });

  it('the launcher\'s dialog holds before any read; a screen proving it gone ends it, and it does not come back',
    async () => {
      const g = gate(() => Promise.resolve(null));
      g.phase.now = IMPORTS_PHASE;
      expect(g.gate.holds()).toBe(true);
      expect(await g.gate.refuses()).toBe(true);
      expect(await g.gate.refuses(EMPTY_FIELD)).toBe(false);
      expect(await g.gate.refuses()).toBe(false);
      expect(g.gate.holds()).toBe(false);
    });

  it('outside the start phase it reads nothing and holds nothing', async () => {
    let reads = 0;
    const g = gate(() => { reads += 1; return Promise.resolve(IMPORTS); });
    g.gate.note(IMPORTS);
    g.phase.now = null;
    expect(g.gate.holds()).toBe(false);
    expect(await g.gate.refuses()).toBe(false);
    expect(reads).toBe(0);
  });

  it('the card sentence goes once per dialog', () => {
    const g = gate(() => Promise.resolve(null));
    g.gate.cardShown();
    g.gate.note(IMPORTS);
    g.gate.cardShown();
    g.gate.cardShown();
    expect(g.said.map((text) => text.ref.code)).toEqual([IMPORTS_CODE]);
  });
});
