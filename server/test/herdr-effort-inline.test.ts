/**
 * In-place result of `/effort <level>` (`commandResultInline` in `server/src/drivers/herdr/commands.ts`;
 * `docs/dialogs.md`, "Dialog block", the paragraph on the `/model` and `/effort` commands).
 *
 * CLI 2.1.319 prints the result under the echo (`kontrolny/potwierdzenie-model-opus-2.1.319.txt`) and shows no
 * dialog. The result counts only when the echo is fresh: the number of `❯ /effort <level>` echoes on the screen must be
 * larger than on the read taken before the send. Without that read, or without the result line, the driver waits the
 * whole window as before.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { commandResultInline, MODEL_CONFIRM_ATTEMPTS } from '../src/drivers/herdr/commands.ts';
import type { DriverEvent } from '../src/drivers/types.ts';
import { ULTRACODE_COMMANDS } from '../src/herdr/commands/registry.ts';
import {
  EMPTY_FIELD, FIXTURES, makeDriver, quiet, systemCodes, useDriverSandbox, userLine, waitFor,
} from './helpers/herdr-driver-atrapy.ts';
import type { Fixture } from './helpers/herdr-driver-atrapy.ts';

useDriverSandbox();

const CAPTURE = readFileSync(join(FIXTURES, 'kontrolny', 'potwierdzenie-model-opus-2.1.319.txt'), 'utf8').split('\n');
/** Lines `from`..`to` (1-based, inclusive) of the 2.1.319 capture, without the "Switch model?" block below them. */
const lines = (from: number, to: number): string => CAPTURE.slice(from - 1, to).join('\n');

/** The command history before `/effort low`: `/model`, and a bare `/effort` echo with "Set effort level to high". */
const BEFORE_LOW = lines(24, 30);
/** The same history after `/effort low` and two `/model` commands (the result line wraps on the 2.1.319 pane). */
const AFTER_LOW = lines(24, 40);

const RULE = '─'.repeat(40);
const withField = (screen: string): string => `${screen}\n${RULE}\n❯ \n${RULE}`;

describe('`/effort <level>` result in place: the table', () => {
  it('the capture has the shapes this table relies on', () => {
    expect(BEFORE_LOW).toContain('❯ /effort\n');
    expect(BEFORE_LOW).not.toContain('❯ /effort low');
    expect(AFTER_LOW).toContain('❯ /effort low\n  ⎿  Set effort level to low (saved as your default for new sessions)');
  });

  it('new echo `/effort low` with "Set effort level to low (…)" under it → inline', () => {
    expect(commandResultInline('/effort low', AFTER_LOW, BEFORE_LOW)).toBe(true);
    expect(commandResultInline('/effort low', withField(AFTER_LOW), withField(BEFORE_LOW))).toBe(true);
  });

  it('the result line is matched by its prefix: another ending and a wrapped line still count', () => {
    const max = `${BEFORE_LOW}\n\n❯ /effort max\n  ⎿  Set effort level to max (this session only)`;
    expect(commandResultInline('/effort max', max, BEFORE_LOW)).toBe(true);
    const wrapped = `${BEFORE_LOW}\n\n❯ /effort medium\n  ⎿  Set effort level to medium (saved as your default for new\n     sessions)`;
    expect(commandResultInline('/effort medium', wrapped, BEFORE_LOW)).toBe(true);
  });

  it('last echo `/effort high` with "Set effort level to low" under it → wait', () => {
    const screen = `${BEFORE_LOW}\n\n❯ /effort high\n  ⎿  Set effort level to low (saved as your default for new sessions)`;
    expect(commandResultInline('/effort high', screen, BEFORE_LOW)).toBe(false);
    // `high` is not a prefix match for `xhigh` either way.
    const xhigh = `${BEFORE_LOW}\n\n❯ /effort xhigh\n  ⎿  Set effort level to high`;
    expect(commandResultInline('/effort xhigh', xhigh, BEFORE_LOW)).toBe(false);
  });

  it('older echo `/effort low` with its result, newer `/effort high` without one → wait', () => {
    const screen = withField(`${AFTER_LOW}\n\n❯ /effort high`);
    expect(commandResultInline('/effort high', screen, withField(AFTER_LOW))).toBe(false);
    expect(commandResultInline('/effort low', screen, withField(BEFORE_LOW))).toBe(false);
  });

  it('the same old echo `/effort low` as before the send, the new one not drawn yet → wait', () => {
    expect(commandResultInline('/effort low', AFTER_LOW, AFTER_LOW)).toBe(false);
    expect(commandResultInline('/effort low', withField(AFTER_LOW), withField(AFTER_LOW))).toBe(false);
  });

  it('"Set effort level to high" in the agent\'s text, without an echo → wait', () => {
    const agent = '⏺ I changed it for you:\n  ⎿  Set effort level to high (saved as your default for new sessions)';
    expect(commandResultInline('/effort high', withField(agent), withField(''))).toBe(false);
  });

  it('a bare `/effort` echo is not the echo of `/effort high`', () => {
    expect(commandResultInline('/effort high', BEFORE_LOW, lines(24, 26))).toBe(false);
  });

  it('without a read from before the send → wait, as before', () => {
    expect(commandResultInline('/effort low', AFTER_LOW)).toBe(false);
    expect(commandResultInline('/effort low', AFTER_LOW, null)).toBe(false);
  });

  it('`/effort ultracode` and `… off` keep their own rule, with or without the read before the send', () => {
    const on = readFileSync(join(FIXTURES, 'ultracode', 'wynik-effort-ultracode-2.1.317.txt'), 'utf8');
    const off = readFileSync(join(FIXTURES, 'ultracode', 'wynik-effort-ultracode-off-2.1.317.txt'), 'utf8');
    expect(commandResultInline(ULTRACODE_COMMANDS.on, on)).toBe(true);
    expect(commandResultInline(ULTRACODE_COMMANDS.on, on, on)).toBe(true);
    expect(commandResultInline(ULTRACODE_COMMANDS.off, off, off)).toBe(true);
    expect(commandResultInline(ULTRACODE_COMMANDS.off, on, '')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The driver: the read before the send and the end of the wait
// ---------------------------------------------------------------------------

interface Pane {
  fx: Fixture;
  log: string[];
}

/** A pane at rest showing `before`; the send of the command swaps the detection read to `after`. */
async function paneSwapping(before: string, after: string): Promise<Pane> {
  const log: string[] = [];
  const fx = await makeDriver({
    transcript: userLine('start'),
    deps: { modelConfirmPollMs: 5, logger: (line) => { log.push(line); } },
  });
  fx.client.screenText = before;
  fx.client.screenAnsi = EMPTY_FIELD;
  const prompt = fx.client.prompt.bind(fx.client);
  fx.client.prompt = (paneId, text, wait) => {
    fx.client.screenText = after;
    return prompt(paneId, text, wait);
  };
  return { fx, log };
}

/** Detection reads after the command went to the pane. */
const readsAfterSend = (fx: Fixture): number => {
  const sent = fx.client.calls.findIndex((c) => c.method === 'prompt');
  return fx.client.calls.slice(sent + 1).filter((c) => c.method === 'read' && c.source === 'detection').length;
};

const modelSets = (fx: Fixture): Extract<DriverEvent, { type: 'model-set' }>[] => fx.events
  .filter((e): e is Extract<DriverEvent, { type: 'model-set' }> => e.type === 'model-set');

async function run(pane: Pane, command: string, code: string): Promise<void> {
  pane.fx.driver.sendCommands?.([command]);
  await waitFor(() => systemCodes(pane.fx.events).includes(code), code);
  await quiet();
}

describe('`/effort <level>` in the driver', () => {
  it('a fresh result ends the wait on the first read that shows it, `model-set` and one log line', async () => {
    const pane = await paneSwapping(withField(BEFORE_LOW), withField(AFTER_LOW));
    await run(pane, '/effort low', 'model.change-inline');

    expect(readsAfterSend(pane.fx)).toBe(1);
    expect(pane.fx.client.calls.filter((c) => c.method === 'send_keys')).toEqual([]);
    expect(modelSets(pane.fx)).toEqual([{ type: 'model-set', effort: 'low' }]);
    expect(pane.log).toHaveLength(1);
    expect(pane.log[0]).toContain('/effort low');
    expect(pane.log[0]).toContain('inline');
    expect(pane.log[0]).toMatch(/\b\d+ ms\b/);
  });

  it('the old echo with its result on both reads waits the whole window: no fresh echo', async () => {
    const pane = await paneSwapping(withField(AFTER_LOW), withField(AFTER_LOW));
    await run(pane, '/effort low', 'model.change-no-dialog');

    expect(readsAfterSend(pane.fx)).toBe(MODEL_CONFIRM_ATTEMPTS);
    expect(modelSets(pane.fx)).toEqual([{ type: 'model-set', effort: 'low' }]);
    expect(pane.log).toHaveLength(1);
    expect(pane.log[0]).toContain('/effort low');
    expect(pane.log[0]).toContain('no-dialog');
  });

  it('a fresh echo without the result line waits the whole window, as before', async () => {
    const pane = await paneSwapping(withField(BEFORE_LOW), withField(`${BEFORE_LOW}\n\n❯ /effort low`));
    await run(pane, '/effort low', 'model.change-no-dialog');

    expect(readsAfterSend(pane.fx)).toBe(MODEL_CONFIRM_ATTEMPTS);
  });
});
