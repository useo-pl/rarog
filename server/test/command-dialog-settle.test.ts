/**
 * The step queued behind a control command whose dialog the driver confirmed itself
 * (`server/src/drivers/herdr/command-dialog-settle.ts`; `docs/implementation-spec.md`, "Model, effort and permission
 * mode").
 *
 * After the digit for "Switch model?" the CLI needs a few seconds to take the dialog off the screen, and the registry
 * keeps saying `waiting` for a while. The next command of the batch (`/effort <level>`) waits, bounded, for the
 * prompt field instead of being refused over the dialog the driver has just answered. A dialog that stays past the
 * bound, or another dialog, still refuses a command and holds a message. The driver's digit shields only the block it
 * went to.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CliWaitingSignal } from '../src/cli-version.ts';
import type { HerdrDriverDeps } from '../src/drivers/herdr-driver.ts';
import { MODEL_CONFIRM_ATTEMPTS } from '../src/drivers/herdr/commands.ts';
import { systemScheduler } from '../src/drivers/runtime.ts';
import type { Scheduler } from '../src/drivers/runtime.ts';
import type { DriverEvent } from '../src/drivers/types.ts';
import { ANSWERED_HOOK_SHIELD_MS } from '../src/herdr/dialogs/index.ts';
import {
  DIALOG_PERMISSION, EMPTY_FIELD, FIELD_RULE, FIXTURES, PANE, makeDriver, pasteFlow, permissions, questions, quiet,
  screenDialogs, systemCodes, useDriverSandbox, userLine, waitFor,
} from './helpers/herdr-driver-atrapy.ts';
import type { Fixture } from './helpers/herdr-driver-atrapy.ts';

useDriverSandbox();

const CAPTURE = readFileSync(join(FIXTURES, 'kontrolny', 'potwierdzenie-model-haiku-2.1.322.txt'), 'utf8')
  .replaceAll('Haiku 5.5', 'Fable 5.2');
const LINES = CAPTURE.split('\n');
/** The conversation above the dialog (CLI 2.1.322 capture). */
const HISTORY = LINES.slice(0, LINES.findIndex((line) => line.startsWith('▔▔▔'))).join('\n').trimEnd();
const field = (screen: string): string => `${screen}\n\n${FIELD_RULE}\n❯ \n${FIELD_RULE}`;

/** "Switch model?" for `/model fable` under a bare rule: the known dialog `model`. */
const SWITCH = CAPTURE;
/** The pane before the batch: the history and an empty prompt field. */
const BEFORE = field(HISTORY);
/** The dialog has left: the echo with the result line, then the prompt field. */
const MODEL_SET = field(`${HISTORY}\n\n❯ /model fable\n  ⎿  Set model to Fable 5.2 and saved as your default for new sessions`);
/** After `/effort medium`: its result in place under a fresh echo. */
const EFFORT_SET = field(`${HISTORY}\n\n❯ /model fable\n  ⎿  Set model to Fable 5.2 and saved as your default for new sessions`
  + '\n\n❯ /effort medium\n  ⎿  Set effort level to medium (saved as your default for new sessions)');

const WAITING_DIALOG: CliWaitingSignal = { kind: 'waiting', dialog: 'dialog' };
const POLL_MS = 5;

interface Pane {
  fx: Fixture;
  /** Detection reads after the digit that still show "Switch model?"; `Infinity` = it never leaves. */
  stays: number;
  /** Detection reads since the digit. */
  readsAfterDigit: number;
  digitSent: boolean;
  /** `Date.now()` at the digit. */
  digitAt: number;
  /** The detection screen at each `prompt` call, by its text. */
  screenAtPrompt: Map<string, string>;
  /** `server.log` lines of the driver. */
  logs: string[];
}

interface PaneOptions {
  stays: number;
  /** What the detection read shows once the dialog has left. */
  afterDialog?: string;
  /** When herdr reports `blocked`: as the dialog is drawn (the measurement), only after the digit, or never. */
  herdr?: 'before-digit' | 'after-digit' | 'never';
  /** herdr goes back to `idle` as the dialog leaves, while the registry still says `waiting`. */
  lateIdle?: boolean;
  /** herdr goes back to `idle` at the first read after the digit, while the screen still shows the dialog. */
  idleUnderDialog?: boolean;
  /** The registry says `active` this many ms after the dialog left; without it the registry stays `waiting`. */
  registryActiveAfterMs?: number;
  /** The registry says `active` right at the digit, while the screen still shows the dialog. */
  registryActiveAtDigit?: boolean;
  /**
   * `afterDialog` is another dialog over the prompt field, also in the attribute read; `blocked` = herdr reports it as
   * it is drawn, `unreported` = herdr stays `idle`.
   */
  covers?: 'blocked' | 'unreported';
  /** Runs inside the digit's `sendKeys`, before it returns. */
  onDigit?: (fx: Fixture) => void;
  pollMs?: number;
  deps?: Partial<HerdrDriverDeps>;
}

/**
 * A pane that answers `/model fable` with "Switch model?" the way the measurement saw it: the registry says `waiting`
 * with class `dialog` as soon as the dialog is drawn, and herdr reports `blocked`.
 */
async function batchPane(opts: PaneOptions): Promise<Pane> {
  const pane: Pane = { fx: undefined as unknown as Fixture, stays: opts.stays, readsAfterDigit: 0, digitSent: false,
    digitAt: 0, screenAtPrompt: new Map(), logs: [] };
  const herdr = opts.herdr ?? 'before-digit';
  let registry: CliWaitingSignal = WAITING_DIALOG;
  const fx = await makeDriver({
    transcript: userLine('start'),
    deps: {
      modelConfirmPollMs: opts.pollMs ?? POLL_MS,
      consentRegistryRead: () => Promise.resolve(registry),
      consentRegistrationWaits: () => false,
      logger: (line) => { pane.logs.push(line); },
      ...opts.deps,
    },
  });
  pane.fx = fx;
  const { client } = fx;
  const status = (value: 'blocked' | 'idle', seq: number): void => {
    fx.emit({ type: 'status', status: value, stateChangeSeq: seq, title: '' });
  };
  client.screenText = BEFORE;
  client.screenAnsi = EMPTY_FIELD;
  const prompt = client.prompt.bind(client);
  client.prompt = async (paneId, text, wait) => {
    pane.screenAtPrompt.set(text, client.screenText);
    await prompt(paneId, text, wait);
    if (text === '/model fable') {
      client.screenText = SWITCH;
      if (herdr === 'before-digit') status('blocked', 8);
      fx.driver.noteCliWaiting?.(WAITING_DIALOG);
    }
    if (text === '/effort medium') client.screenText = EFFORT_SET;
  };
  const sendKeys = client.sendKeys;
  client.sendKeys = async (paneId, keys) => {
    await sendKeys(paneId, keys);
    if (keys.length === 1 && keys[0] === '1' && client.screenText === SWITCH) {
      pane.digitSent = true;
      pane.digitAt = Date.now();
      if (herdr === 'after-digit') status('blocked', 8);
      if (opts.registryActiveAtDigit === true) {
        registry = { kind: 'active' };
        fx.driver.noteCliWaiting?.(registry);
      }
      opts.onDigit?.(fx);
    }
  };
  const read = client.readScreen.bind(client);
  client.readScreen = (paneId, source, format) => {
    if (pane.digitSent && source === 'detection' && client.screenText === SWITCH) {
      pane.readsAfterDigit += 1;
      if (opts.idleUnderDialog === true && pane.readsAfterDigit === 1) status('idle', 9);
      if (pane.readsAfterDigit > pane.stays) {
        client.screenText = opts.afterDialog ?? MODEL_SET;
        if (opts.covers !== undefined) client.screenAnsi = null;
        if (opts.covers === 'blocked') status('blocked', 10);
        if (opts.lateIdle === true) setTimeout(() => { status('idle', 9); }, 0);
        const activeAfter = opts.registryActiveAfterMs;
        if (activeAfter !== undefined) {
          setTimeout(() => {
            registry = { kind: 'active' };
            fx.driver.noteCliWaiting?.(registry);
          }, activeAfter);
        }
      }
    }
    return read(paneId, source, format);
  };
  return pane;
}

/** Sends the batch and waits for the outcome of `/effort medium` or a refusal. */
async function runBatch(fx: Fixture, alsoSend?: string): Promise<void> {
  fx.driver.sendCommands?.(['/model fable', '/effort medium']);
  if (alsoSend !== undefined) fx.driver.send(alsoSend);
  await waitFor(() => systemCodes(fx.events).some((code) => code === 'model.change-inline'
    || code.startsWith('commands.send-held')), 'outcome of /effort medium');
  await quiet();
}

const prompts = (fx: Fixture): (string | undefined)[] =>
  fx.client.calls.filter((c) => c.method === 'prompt').map((c) => c.text);

const modelSets = (fx: Fixture): Extract<DriverEvent, { type: 'model-set' }>[] => fx.events
  .filter((e): e is Extract<DriverEvent, { type: 'model-set' }> => e.type === 'model-set');

const REFUSED = 'commands.send-held.cli-dialog';

describe('the next command of the batch after the driver confirmed "Switch model?"', () => {
  it.each([2, 3])('the dialog stays for %i reads after the digit and the registry says `waiting` → `/effort medium` '
    + 'is sent, no refusal', async (stays) => {
    const { fx } = await batchPane({ stays });
    await runBatch(fx);

    expect(fx.audit[1]).toMatchObject({ keys: ['1'], toolName: 'dialog:model', optionLabel: 'Yes, switch to Fable 5.2' });
    expect(prompts(fx)).toEqual(['/model fable', '/effort medium']);
    expect(systemCodes(fx.events)).not.toContain(REFUSED);
    expect(systemCodes(fx.events)).toEqual(expect.arrayContaining(['model.change-confirmed', 'model.change-inline']));
    expect(modelSets(fx).length).toBe(2);
  });

  it('herdr goes `idle` as the dialog leaves while the registry still says `waiting`, a message queued behind the '
    + 'batch → both go, no refusal', async () => {
    const { fx } = await batchPane({ stays: 2, lateIdle: true, registryActiveAfterMs: 0 });
    await runBatch(fx, 'next message');
    await waitFor(() => prompts(fx).includes('next message'), 'the message behind the batch');
    await quiet();
    expect(prompts(fx)).toEqual(['/model fable', '/effort medium', 'next message']);
    expect(systemCodes(fx.events)).not.toContain(REFUSED);
  });

  it('herdr leaves `blocked` while the answered dialog is still drawn and the registry says `waiting` → no registry '
    + 'hold over the answered dialog, `/effort medium` is sent', async () => {
    const { fx } = await batchPane({ stays: 2, idleUnderDialog: true });
    await runBatch(fx);
    expect(prompts(fx)).toEqual(['/model fable', '/effort medium']);
    expect(systemCodes(fx.events)).not.toContain(REFUSED);
  });

  it('herdr reports `blocked` only after the digit → `/effort medium` is sent', async () => {
    const { fx } = await batchPane({ stays: 2, herdr: 'after-digit', lateIdle: true });
    await runBatch(fx);
    expect(prompts(fx)).toEqual(['/model fable', '/effort medium']);
    expect(systemCodes(fx.events)).not.toContain(REFUSED);
  });

  it('a registry hold without a herdr block that the registry ends after the dialog left → `/effort medium` is '
    + 'sent', async () => {
    const { fx } = await batchPane({ stays: 2, herdr: 'never', registryActiveAfterMs: 15 });
    await runBatch(fx);
    expect(systemCodes(fx.events)).toContain('model.change-confirmed');
    expect(prompts(fx)).toEqual(['/model fable', '/effort medium']);
    expect(systemCodes(fx.events)).not.toContain(REFUSED);
  });

  it('the dialog never leaves within the bound → refused as before, `/effort medium` not sent', async () => {
    const pane = await batchPane({ stays: Number.POSITIVE_INFINITY });
    const { fx } = pane;
    await runBatch(fx);
    const refusedAt = Date.now();
    expect(prompts(fx)).toEqual(['/model fable']);
    expect(systemCodes(fx.events)).toContain(REFUSED);
    // The wait read through its whole bound: one poll between reads.
    expect(refusedAt - pane.digitAt).toBeGreaterThanOrEqual((MODEL_CONFIRM_ATTEMPTS - 1) * POLL_MS);
  });

  it('another dialog stands after the confirmation → refused as before, without waiting out the bound', async () => {
    const pollMs = 100;
    const pane = await batchPane({ stays: 0, afterDialog: DIALOG_PERMISSION, pollMs });
    const { fx } = pane;
    fx.driver.sendCommands?.(['/model fable', '/effort medium']);
    await waitFor(() => systemCodes(fx.events).some((code) => code.startsWith('commands.send-held')), 'refusal');
    const refusedAt = Date.now();
    await quiet();
    expect(prompts(fx)).toEqual(['/model fable']);
    expect(systemCodes(fx.events)).toContain('model.change-confirmed');
    expect(refusedAt - pane.digitAt).toBeLessThan((MODEL_CONFIRM_ATTEMPTS - 1) * pollMs / 2);
  });
});

describe('a message queued behind a single command with a confirmed dialog', () => {
  it('the registry already says `active`, the screen still shows the dialog for 2 reads → the message is typed only '
    + 'after the dialog left', async () => {
    const pane = await batchPane({ stays: 2, herdr: 'never', registryActiveAtDigit: true });
    const { fx } = pane;
    fx.driver.sendCommands?.(['/model fable']);
    fx.driver.send('next message');
    await waitFor(() => prompts(fx).includes('next message'), 'the message');
    await quiet();
    expect(prompts(fx)).toEqual(['/model fable', 'next message']);
    expect(pane.screenAtPrompt.get('next message')).toBe(MODEL_SET);
  });
});

describe('a single command with a confirmed dialog', () => {
  it('the outcome comes right after the digit: no read of the wait before it', async () => {
    const pane = await batchPane({ stays: Number.POSITIVE_INFINITY, herdr: 'never' });
    const { fx } = pane;
    let readsAtOutcome = -1;
    const push = fx.events.push.bind(fx.events);
    fx.events.push = (...items: DriverEvent[]): number => {
      if (systemCodes(items).includes('model.change-confirmed')) readsAtOutcome = pane.readsAfterDigit;
      return push(...items);
    };
    fx.driver.sendCommands?.(['/model fable']);
    await waitFor(() => readsAtOutcome >= 0, 'model.change-confirmed');
    expect(readsAtOutcome).toBe(0);
    expect(modelSets(fx)).toEqual([{ type: 'model-set', model: 'fable' }]);
  });

  it('a registry hold that ends right as the dialog leaves → the next command goes', async () => {
    const pane = await batchPane({ stays: 0, herdr: 'never', registryActiveAfterMs: 0 });
    const { fx } = pane;
    await runBatch(fx);
    expect(prompts(fx)).toEqual(['/model fable', '/effort medium']);
  });
});

const keysSent = (fx: Fixture): (readonly string[] | undefined)[] =>
  fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys);

const HELD = `send: message for pane ${PANE} waits`;

describe('another dialog replaces the confirmed one while the next step waits', () => {
  /*
   * The message goes right behind `/model fable` while herdr sees no block and the registry says `active`, so before
   * the wait nothing marks the pane busy. During the wait "Switch model?" leaves and a Bash consent takes its place. A
   * text like `1` sent past it would approve that consent.
   */
  it.each([
    ['herdr reports `blocked` for it', 'blocked'],
    ['herdr does not report it', 'unreported'],
  ] as const)('%s → the message is held in the paste queue, no key reaches the consent', async (_, covers) => {
    const pane = await batchPane({
      stays: 1, herdr: 'never', registryActiveAtDigit: true, afterDialog: DIALOG_PERMISSION, covers,
    });
    const { fx } = pane;
    fx.driver.sendCommands?.(['/model fable']);
    fx.driver.send('1');
    await waitFor(() => pane.logs.some((line) => line.startsWith(HELD)) || prompts(fx).includes('1'),
      'the message held or sent');
    await quiet();
    expect(pasteFlow(fx)).toEqual(['prompt:/model fable']);
    expect(keysSent(fx)).toEqual([['1']]);
    expect(pane.logs.filter((line) => line.startsWith(HELD))).toHaveLength(1);
    expect(systemCodes(fx.events).filter((code) => code.startsWith('commands.send-held'))).toEqual([]);
  });

  it('the answered dialog is still drawn when the wait ends, herdr and the registry see no block → the message is '
    + 'held', async () => {
    const pane = await batchPane({
      stays: Number.POSITIVE_INFINITY, herdr: 'never', registryActiveAtDigit: true,
      onDigit: (fx) => { fx.client.screenAnsi = null; },
    });
    const { fx } = pane;
    fx.driver.sendCommands?.(['/model fable']);
    fx.driver.send('next message');
    await waitFor(() => pane.logs.some((line) => line.startsWith(HELD)) || prompts(fx).includes('next message'),
      'the message held or sent');
    await quiet();
    expect(pasteFlow(fx)).toEqual(['prompt:/model fable']);
    expect(pane.readsAfterDigit).toBeGreaterThanOrEqual(MODEL_CONFIRM_ATTEMPTS);
  });

  it('the next command of the batch → refused, not sent past the consent', async () => {
    const pane = await batchPane({
      stays: 1, herdr: 'never', registryActiveAtDigit: true, afterDialog: DIALOG_PERMISSION, covers: 'unreported',
    });
    const { fx } = pane;
    fx.driver.sendCommands?.(['/model fable', '/effort medium']);
    await waitFor(() => systemCodes(fx.events).some((code) => code.startsWith('commands.send-held')
      || code.startsWith('model.change-composer') || code.startsWith('model.change-unsent'))
      || prompts(fx).includes('/effort medium'), 'outcome of /effort medium');
    await quiet();
    expect(prompts(fx)).toEqual(['/model fable']);
    expect(keysSent(fx)).toEqual([['1']]);
    expect(systemCodes(fx.events)).toContain(REFUSED);
  });
});

describe('the prompt field was not read back after the confirmed dialog', () => {
  /*
   * A step that was held does not open the way for the step behind it: only a read that shows the prompt field does.
   * herdr sees no block and the registry says `active`, so past the wait no send gate would stop a message.
   */
  it('a consent replaced the dialog and the next command was refused → the message behind the batch is held, no key '
    + 'reaches the consent', async () => {
    const pane = await batchPane({
      stays: 1, herdr: 'never', registryActiveAtDigit: true, afterDialog: DIALOG_PERMISSION, covers: 'unreported',
    });
    const { fx } = pane;
    fx.driver.sendCommands?.(['/model fable', '/effort medium']);
    fx.driver.send('1');
    await waitFor(() => pane.logs.some((line) => line.startsWith(HELD)) || prompts(fx).includes('1'),
      'the message held or sent');
    await quiet();
    expect(systemCodes(fx.events)).toContain(REFUSED);
    expect(pasteFlow(fx)).toEqual(['prompt:/model fable']);
    expect(keysSent(fx)).toEqual([['1']]);
  });

  it('every read of the wait shows a screen without a dialog and without the prompt field → the message is held',
    async () => {
      const pane = await batchPane({
        stays: 0, herdr: 'never', registryActiveAtDigit: true, afterDialog: `${HISTORY}\n\nRendering…`,
        covers: 'unreported',
      });
      const { fx } = pane;
      fx.driver.sendCommands?.(['/model fable']);
      fx.driver.send('1');
      await waitFor(() => pane.logs.some((line) => line.startsWith(HELD)) || prompts(fx).includes('1'),
        'the message held or sent');
      await quiet();
      expect(pasteFlow(fx)).toEqual(['prompt:/model fable']);
      expect(keysSent(fx)).toEqual([['1']]);
    });
});

describe('steps that do not depend on the confirmation outcome', () => {
  const modeCycles = (fx: Fixture): unknown[] => fx.client.calls.filter((c) => c.method === 'mode_cycle');

  it('the digit is delivered but its send fails, a consent stands after it → the message behind the command is held',
    async () => {
      const pane = await batchPane({
        stays: 0, herdr: 'never', registryActiveAtDigit: true,
        onDigit: (fx) => {
          fx.client.screenText = DIALOG_PERMISSION;
          fx.client.screenAnsi = null;
          throw new Error('socket closed');
        },
      });
      const { fx } = pane;
      fx.driver.sendCommands?.(['/model fable']);
      fx.driver.send('1');
      await waitFor(() => pane.logs.some((line) => line.startsWith(HELD)) || prompts(fx).includes('1'),
        'the message held or sent');
      await quiet();
      expect(pasteFlow(fx)).toEqual(['prompt:/model fable']);
      expect(keysSent(fx)).toEqual([['1']]);
    });

  it('a mode change right behind the confirmed command while the dialog is still drawn → no mode key', async () => {
    const pane = await batchPane({
      stays: Number.POSITIVE_INFINITY, herdr: 'never', registryActiveAtDigit: true,
      onDigit: (fx) => { fx.client.screenAnsi = null; },
    });
    const { fx } = pane;
    fx.driver.sendCommands?.(['/model fable']);
    fx.driver.setMode?.('plan');
    await waitFor(() => modeCycles(fx).length > 0 || systemCodes(fx.events).includes(REFUSED),
      'the mode change sent or refused');
    await quiet();
    expect(modeCycles(fx)).toEqual([]);
    expect(systemCodes(fx.events)).toContain(REFUSED);
  });
});

describe('the answer shield window passes before the prompt field is read back', () => {
  /*
   * The clock jumps past the window at the first read after the digit. Time alone proves nothing about the screen:
   * with herdr `idle` and the registry `active`, a message let go here would reach whatever covers the prompt field.
   */
  it.each([
    ['a screen without a dialog and without the prompt field', `${HISTORY}\n\nRendering…`, 0],
    ['the answered dialog still drawn', undefined, Number.POSITIVE_INFINITY],
  ] as const)('%s → the next command is refused and the message behind it is held', async (_, afterDialog, stays) => {
    let offset = 0;
    const scheduler: Scheduler = { ...systemScheduler, now: () => Date.now() + offset };
    const pane = await batchPane({
      stays, herdr: 'never', registryActiveAtDigit: true, afterDialog, deps: { scheduler },
      onDigit: (fx) => { fx.client.screenAnsi = null; },
    });
    const { fx } = pane;
    const read = fx.client.readScreen.bind(fx.client);
    fx.client.readScreen = (paneId, source, format) => {
      if (pane.digitSent && source === 'detection') offset = ANSWERED_HOOK_SHIELD_MS + 1000;
      return read(paneId, source, format);
    };
    fx.driver.sendCommands?.(['/model fable', '/effort medium']);
    fx.driver.send('1');
    await waitFor(() => pane.logs.some((line) => line.startsWith(HELD)) || prompts(fx).includes('1'),
      'the message held or sent');
    await quiet();
    expect(pasteFlow(fx)).toEqual(['prompt:/model fable']);
    expect(keysSent(fx)).toEqual([['1']]);
    expect(systemCodes(fx.events)).toContain(REFUSED);
  });
});

describe('the prompt field comes back after a step was held', () => {
  it('the dialog outstays the bound and `/effort medium` is refused, then the field is back → the command sent again '
    + 'goes', async () => {
    const pane = await batchPane({
      stays: Number.POSITIVE_INFINITY, herdr: 'never', registryActiveAtDigit: true,
      onDigit: (fx) => { fx.client.screenAnsi = null; },
    });
    const { fx } = pane;
    await runBatch(fx);
    expect(prompts(fx)).toEqual(['/model fable']);
    expect(systemCodes(fx.events)).toContain(REFUSED);
    fx.client.screenText = MODEL_SET;
    fx.client.screenAnsi = EMPTY_FIELD;
    fx.driver.sendCommands?.(['/effort medium']);
    await waitFor(() => prompts(fx).includes('/effort medium'), '/effort medium sent');
    await quiet();
    expect(systemCodes(fx.events)).toContain('model.change-inline');
  });
});

describe('a block that begins while the digit for "Switch model?" is being sent', () => {
  const LOGIN = readFileSync(join(FIXTURES, 'ekran-login-2.1.293.txt'), 'utf8');
  const cards = (fx: Fixture): number => permissions(fx.events).length + questions(fx.events).length
    + screenDialogs(fx.events).length;

  it('the dialog of the new block gets its card: the answer covers only the block it went to', async () => {
    let cardsAtDigit = -1;
    // The registry says `active` at the digit: the `idle` closes the model block instead of handing it to a registry hold.
    const pane = await batchPane({
      stays: Number.POSITIVE_INFINITY, registryActiveAtDigit: true,
      deps: { screenCacheMs: 1, blockedPollMs: 8 },
      onDigit: (fx) => {
        cardsAtDigit = cards(fx);
        fx.client.screenText = LOGIN;
        fx.emit({ type: 'status', status: 'idle', stateChangeSeq: 9, title: '' });
        fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 10, title: '' });
      },
    });
    const { fx } = pane;
    fx.driver.sendCommands?.(['/model fable']);
    await waitFor(() => systemCodes(fx.events).includes('model.change-confirmed'), 'model.change-confirmed');
    await waitFor(() => cards(fx) > cardsAtDigit, 'the card of the new block');
    expect(screenDialogs(fx.events).at(-1)?.screen).toContain('Login successful');
  });

  it('a dialog without digits takes the place of "Switch model?" inside the same block while the registry keeps '
    + 'saying `waiting` → the message behind the command is held', async () => {
    const pane = await batchPane({
      stays: 0,
      onDigit: (fx) => {
        fx.client.screenText = LOGIN;
        fx.client.screenAnsi = null;
      },
    });
    const { fx } = pane;
    fx.driver.sendCommands?.(['/model fable']);
    fx.driver.send('1');
    await waitFor(() => pane.logs.some((line) => line.startsWith(HELD)) || prompts(fx).includes('1'),
      'the message held or sent');
    await quiet();
    expect(pasteFlow(fx)).toEqual(['prompt:/model fable']);
    expect(keysSent(fx)).toEqual([['1']]);
  });
});
