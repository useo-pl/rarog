/**
 * The flag "Rarog left text in the prompt field" (`#needsEscape` in `drivers/herdr-driver.ts`: an interrupt, a
 * confirmed stall, a hook block) belongs to the conversation it was set in. When the pane moves to another
 * conversation (`/clear`, `/resume`), text in the new conversation's field is not known to be Rarog's: it counts as a
 * draft at the desk. No path presses an Esc pair on it: a send outside a turn and the paste queue send the message
 * after it (joined, as after any draft at the desk), and a control command refuses. Without a move the flag clears
 * Rarog's leftover with the Esc pair. The driver runs on the fake client with the prompt field modelled.
 */
import { appendFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { foreign } from '@rarog/shared/sentences';
import type { FollowerFactory } from '../src/drivers/herdr/transcript.ts';
import { createJsonlFollower } from '../src/herdr/jsonl-follow.ts';
import type { FollowEvent } from '../src/herdr/jsonl-follow.ts';
import { HerdrStalledError } from '../src/herdr/types.ts';
import type { HerdrAgentInfo } from '../src/herdr/types.ts';
import {
  PANE, SESSION, TIMING, blockedLine, composerPane, fieldScreen, inTurn, makeDriver, quiet, root, systemCodes,
  useDriverSandbox, userLine, waitFor,
} from './helpers/herdr-driver-atrapy.ts';
import type { Fixture } from './helpers/herdr-driver-atrapy.ts';

useDriverSandbox();

const OTHER = '0b6c1f5e-4d1a-4c55-9a3e-2f1e9d7c8b6a';
const LEFTOVER = 'interrupted prompt';
const DRAFT = 'draft in the new conversation';
const MESSAGE = 'message for the new conversation';
const COMMAND = '/effort high';

const pairs = (fx: Fixture): number => fx.client.calls
  .filter((call) => call.method === 'send_keys' && call.keys?.length === 2).length;
const stalled = (): HerdrStalledError => new HerdrStalledError(foreign('agent_prompt_stalled'));

/** The prompt field outside a turn: drawn in its frame, emptied by an Esc pair, and what `agent.prompt` submits. */
interface IdleField {
  text: string;
  /** What the CLI got at each `agent.prompt`: the field's text followed by the prompt. */
  readonly submitted: string[];
  draw(): void;
}

/**
 * Models the field for `agent.prompt`: herdr types the text into the field and presses Enter, so text already in the
 * field goes out with it (`docs/implementation-spec.md`, "Model, effort and permission mode"). A stalled `prompt`
 * leaves its text in the field.
 */
function idleField(fx: Fixture, text: string): IdleField {
  const field: IdleField = {
    text,
    submitted: [],
    draw: () => {
      fx.client.screenText = fieldScreen(field.text);
      fx.client.screenAnsi = null;
    },
  };
  field.draw();
  const prompt = fx.client.prompt.bind(fx.client);
  fx.client.prompt = (paneId, sent, wait) => {
    if (fx.client.promptErrors.length > 0) {
      field.text += sent;
    } else {
      field.submitted.push(field.text + sent);
      field.text = '';
    }
    field.draw();
    return prompt(paneId, sent, wait);
  };
  const keys = fx.client.sendKeys;
  fx.client.sendKeys = (paneId, sent) => {
    if (sent.length === 2 && sent.every((key) => key === 'escape')) field.text = '';
    field.draw();
    return keys(paneId, sent);
  };
  return field;
}

interface Run {
  /** Esc pairs pressed by the send or the command after the flag was set. */
  pairs: number;
  /** What the CLI got (prompts and Enters, in order). */
  submitted: string[];
  codes: string[];
}

interface PathCase {
  name: string;
  /** Interrupt in the first conversation (the CLI hands the prompt back to the field), then the step under test. */
  run(moved: boolean): Promise<Run>;
}

/** The pane moves to another conversation whose field holds the owner's draft. */
const move = (fx: Fixture, setField: (text: string) => void): void => {
  fx.emit({ type: 'session-changed', agentSessionId: OTHER });
  setField(DRAFT);
};

const PATHS: readonly PathCase[] = [
  {
    name: 'a send outside a turn (`agent.prompt`)',
    run: async (moved) => {
      const fx = await makeDriver();
      const field = idleField(fx, LEFTOVER);
      await fx.driver.interrupt();
      if (moved) move(fx, (text) => { field.text = text; field.draw(); });
      fx.driver.send(MESSAGE);
      await waitFor(() => field.submitted.length === 1, 'prompt');
      await quiet();
      return { pairs: pairs(fx), submitted: field.submitted, codes: systemCodes(fx.events) };
    },
  },
  {
    name: 'a send during a turn (the paste queue)',
    run: async (moved) => {
      const fx = await makeDriver();
      const pane = composerPane(fx);
      let session = SESSION;
      fx.client.getAgent = (): Promise<HerdrAgentInfo> => Promise.resolve({
        paneId: PANE, agentSessionId: session, engine: 'claude', status: 'working',
      } as HerdrAgentInfo);
      pane.field = LEFTOVER;
      pane.draw();
      await fx.driver.interrupt();
      if (moved) {
        session = OTHER;
        move(fx, (text) => { pane.field = text; pane.draw(); });
      }
      inTurn(fx);
      fx.driver.send(MESSAGE);
      await waitFor(() => pane.submitted.length === 1, 'Enter');
      await quiet();
      return { pairs: pairs(fx), submitted: pane.submitted, codes: systemCodes(fx.events) };
    },
  },
  {
    name: 'a control command',
    run: async (moved) => {
      const fx = await makeDriver({ transcript: userLine('start'), deps: { modelConfirmPollMs: 5 } });
      const field = idleField(fx, LEFTOVER);
      await fx.driver.interrupt();
      if (moved) move(fx, (text) => { field.text = text; field.draw(); });
      fx.driver.sendCommands?.([COMMAND]);
      await waitFor(() => field.submitted.length === 1
        || systemCodes(fx.events).includes('model.change-unsent-prompt.mac'), 'command or refusal');
      await quiet();
      return { pairs: pairs(fx), submitted: field.submitted, codes: systemCodes(fx.events) };
    },
  },
];

/** What each path does with the new conversation's draft once no Esc pair clears it. */
const AFTER_MOVE: Record<string, (run: Run) => void> = {
  'a send outside a turn (`agent.prompt`)': (run) => {
    expect(run.submitted).toEqual([`${DRAFT}${MESSAGE}`]);
  },
  'a send during a turn (the paste queue)': (run) => {
    expect(run.submitted).toEqual([`${DRAFT}${MESSAGE}`]);
  },
  'a control command': (run) => {
    expect(run.submitted).toEqual([]);
    expect(run.codes).toContain('model.change-unsent-prompt.mac');
  },
};

describe('herdr driver: the leftover flag set in one conversation never clears the field of another', () => {
  for (const path of PATHS) {
    it(`${path.name}: after a move the draft gets no Esc pair and counts as a draft at the desk`, async () => {
      const run = await path.run(true);
      expect(run.pairs).toBe(0);
      AFTER_MOVE[path.name]?.(run);
    });

    it(`${path.name}: without a move the Esc pair clears Rarog's leftover first`, async () => {
      const run = await path.run(false);
      expect(run.pairs).toBe(1);
      expect(run.submitted).toEqual([path.name === 'a control command' ? COMMAND : MESSAGE]);
    });
  }

  it('a control command whose clearing has begun: a move during the field read stops the Esc pair and the command',
    async () => {
      const fx = await makeDriver({ transcript: userLine('start'), deps: { modelConfirmPollMs: 5 } });
      const field = idleField(fx, LEFTOVER);
      await fx.driver.interrupt();
      await quiet();
      let armed = true;
      const read = fx.client.readScreen.bind(fx.client);
      fx.client.readScreen = (paneId, source, format) => {
        if (armed && source === 'visible' && format === 'ansi') {
          armed = false;
          move(fx, (text) => { field.text = text; field.draw(); });
        }
        return read(paneId, source, format);
      };
      fx.driver.sendCommands?.([COMMAND]);
      await waitFor(() => field.submitted.length === 1
        || systemCodes(fx.events).includes('model.change-unsent-prompt.mac'), 'command or refusal');
      await quiet();
      expect(pairs(fx)).toBe(0);
      expect(field.text).toBe(DRAFT);
      expect(field.submitted).toEqual([]);
      expect(systemCodes(fx.events)).toContain('model.change-unsent-prompt.mac');
    });

  it('a flag set by a confirmed stall: after a move the next send presses no Esc pair on the draft', async () => {
    const fx = await makeDriver({ deps: { stallSettleMs: 5 } });
    const field = idleField(fx, '');
    fx.client.promptErrors.push(stalled(), stalled());
    fx.driver.send('run the tests', undefined, undefined, { echo: 'e1' });
    await waitFor(() => systemCodes(fx.events).includes('commands.send-stalled'), 'stall note');
    await quiet();
    const before = pairs(fx);
    move(fx, (text) => { field.text = text; field.draw(); });
    fx.driver.send(MESSAGE);
    await waitFor(() => field.submitted.length === 1, 'prompt');
    await quiet();
    expect(pairs(fx) - before).toBe(0);
    expect(field.submitted).toEqual([`${DRAFT}${MESSAGE}`]);
  });

  it('an interrupt accepted before the move whose queued task runs after it does not set the flag again: the next '
    + 'send presses no Esc pair on the new conversation\'s draft', async () => {
    const fx = await makeDriver();
    const field = idleField(fx, '');
    const prompt = fx.client.prompt;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    let pending = false;
    fx.client.prompt = async (paneId, text, wait) => {
      pending = true;
      await held;
      return prompt(paneId, text, wait);
    };
    fx.driver.send('first message');
    await waitFor(() => pending, 'first prompt in flight');
    const interrupted = fx.driver.interrupt();
    fx.emit({ type: 'session-changed', agentSessionId: OTHER });
    const movedAt = fx.client.calls.length;
    release();
    await interrupted;
    const esc = fx.client.calls.findIndex((call) => call.method === 'send_keys' && call.keys?.length === 1);
    expect(esc).toBeGreaterThanOrEqual(movedAt);
    // The new conversation is idle, so the Esc hands nothing back: its field holds the owner's draft.
    field.text = DRAFT;
    field.draw();
    fx.driver.send(MESSAGE);
    await waitFor(() => field.submitted.length === 2, 'prompt');
    await quiet();
    expect(pairs(fx)).toBe(0);
    expect(field.submitted).toEqual(['first message', `${DRAFT}${MESSAGE}`]);
  });

  it('an interrupt accepted after the move sets the flag for the new conversation: the next send clears the prompt '
    + 'its Esc handed back', async () => {
    const fx = await makeDriver();
    const field = idleField(fx, '');
    fx.emit({ type: 'session-changed', agentSessionId: OTHER });
    await fx.driver.interrupt();
    field.text = LEFTOVER;
    field.draw();
    fx.driver.send(MESSAGE);
    await waitFor(() => field.submitted.length === 1, 'prompt');
    await quiet();
    expect(pairs(fx)).toBe(1);
    expect(field.submitted).toEqual([MESSAGE]);
  });

  it('a move during the stalled second prompt counts as a sign of life: no stall note and no flag, so the next send '
    + 'presses no Esc pair on the draft', async () => {
    const fx = await makeDriver({ deps: { stallSettleMs: 5 } });
    const field = idleField(fx, '');
    const prompt = fx.client.prompt;
    let calls = 0;
    fx.client.prompt = (paneId, text, wait) => {
      calls += 1;
      if (calls === 2) fx.emit({ type: 'session-changed', agentSessionId: OTHER });
      return prompt(paneId, text, wait);
    };
    fx.client.promptErrors.push(stalled(), stalled());
    fx.driver.send('run the tests', undefined, undefined, { echo: 'e1' });
    await waitFor(() => calls === 2, 'second prompt');
    await quiet();
    expect(systemCodes(fx.events)).not.toContain('commands.send-stalled');
    const before = pairs(fx);
    field.text = DRAFT;
    field.draw();
    fx.driver.send(MESSAGE);
    await waitFor(() => field.submitted.length === 1, 'prompt');
    await quiet();
    expect(pairs(fx) - before).toBe(0);
    expect(field.submitted).toEqual([`${DRAFT}${MESSAGE}`]);
  });
});

/**
 * A follower whose block entry reaches the driver only on `release()`. When the pane moves, the follower flushes the
 * entries it has read from the old file inside the `session-changed` handler, and the driver handles them after it.
 */
interface BlockGate {
  /** The block entry was read and waits. */
  held: boolean;
  release(): void;
  follow: FollowerFactory;
}

function holdBlocks(): BlockGate {
  let open: () => void = () => {};
  const released = new Promise<void>((resolve) => { open = resolve; });
  const gate: BlockGate = {
    held: false,
    release: () => { open(); },
    follow: (opts) => {
      const real = createJsonlFollower({ ...opts, root, watch: false, timing: TIMING });
      async function* events(): AsyncGenerator<FollowEvent> {
        for await (const event of real.events) {
          if (event.type === 'prompt-blocked') {
            gate.held = true;
            await released;
          }
          yield event;
        }
      }
      const iterable = events();
      return new Proxy(real, {
        get: (target, prop) => {
          if (prop === 'events') return iterable;
          const value: unknown = Reflect.get(target, prop, target);
          return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      });
    },
  };
  return gate;
}

const BLOCKED = 'deploy to production';

/** The last send of the first conversation, blocked by a hook: its entry is read and held. */
async function blockedSend(gate: BlockGate): Promise<Fixture> {
  const fx = await makeDriver({ transcript: userLine('start'), deps: { follow: gate.follow, modelConfirmPollMs: 5 } });
  fx.driver.send(BLOCKED);
  await waitFor(() => fx.client.calls.some((call) => call.method === 'prompt'), 'prompt');
  await quiet();
  await appendFile(fx.transcript, blockedLine(BLOCKED));
  await waitFor(() => gate.held, 'block entry read');
  return fx;
}

const delivered = (fx: Fixture): boolean => fx.events.some((event) => event.type === 'prompt-blocked');

/** The step in the new conversation, whose field holds the owner's draft. */
const LATE_STEPS: readonly { name: string; step(fx: Fixture): Promise<Run> }[] = [
  {
    name: 'a send outside a turn (`agent.prompt`)',
    step: async (fx) => {
      const field = idleField(fx, DRAFT);
      fx.driver.send(MESSAGE);
      await waitFor(() => field.submitted.length === 1, 'prompt');
      await quiet();
      return { pairs: pairs(fx), submitted: field.submitted, codes: systemCodes(fx.events) };
    },
  },
  {
    name: 'a send during a turn (the paste queue)',
    step: async (fx) => {
      const pane = composerPane(fx);
      fx.client.getAgent = (): Promise<HerdrAgentInfo> => Promise.resolve({
        paneId: PANE, agentSessionId: OTHER, engine: 'claude', status: 'working',
      } as HerdrAgentInfo);
      pane.field = DRAFT;
      pane.draw();
      inTurn(fx);
      fx.driver.send(MESSAGE);
      await waitFor(() => pane.submitted.length === 1, 'Enter');
      await quiet();
      return { pairs: pairs(fx), submitted: pane.submitted, codes: systemCodes(fx.events) };
    },
  },
  {
    name: 'a control command',
    step: async (fx) => {
      const field = idleField(fx, DRAFT);
      fx.driver.sendCommands?.([COMMAND]);
      await waitFor(() => field.submitted.length === 1
        || systemCodes(fx.events).includes('model.change-unsent-prompt.mac'), 'command or refusal');
      await quiet();
      return { pairs: pairs(fx), submitted: field.submitted, codes: systemCodes(fx.events) };
    },
  },
];

describe('herdr driver: a hook block entry of the conversation the pane left sets no leftover flag', () => {
  for (const { name, step } of LATE_STEPS) {
    it(`${name}: the entry arrives after the move, and the draft gets no Esc pair`, async () => {
      const gate = holdBlocks();
      const fx = await blockedSend(gate);
      fx.emit({ type: 'session-changed', agentSessionId: OTHER });
      gate.release();
      await waitFor(() => delivered(fx), 'block entry handled');
      const run = await step(fx);
      expect(run.pairs).toBe(0);
      AFTER_MOVE[name]?.(run);
    });
  }

  it('the entry of the conversation the pane still runs sets the flag: the next send clears the prompt the hook '
    + 'handed back', async () => {
    const gate = holdBlocks();
    const fx = await blockedSend(gate);
    gate.release();
    await waitFor(() => delivered(fx), 'block entry handled');
    const field = idleField(fx, BLOCKED);
    fx.driver.send(MESSAGE);
    await waitFor(() => field.submitted.length === 1, 'prompt');
    await quiet();
    expect(pairs(fx)).toBe(1);
    expect(field.submitted).toEqual([MESSAGE]);
  });

  it('the first send of the new conversation, blocked by a hook, is decided as before the move', async () => {
    const fx = await makeDriver({ transcript: userLine('start'), deps: { modelConfirmPollMs: 5 } });
    const other = join(dirname(fx.transcript), `${OTHER}.jsonl`);
    await writeFile(other, '');
    fx.emit({ type: 'session-changed', agentSessionId: OTHER });
    await quiet();
    fx.driver.send(BLOCKED);
    await waitFor(() => fx.client.calls.some((call) => call.method === 'prompt'), 'prompt');
    await quiet();
    await appendFile(other, blockedLine(BLOCKED));
    await waitFor(() => delivered(fx), 'block entry handled');
    expect(fx.events.find((event) => event.type === 'prompt-blocked')).toMatchObject({ decided: true });
    const field = idleField(fx, BLOCKED);
    fx.driver.send(MESSAGE);
    await waitFor(() => field.submitted.length === 1, 'prompt');
    await quiet();
    expect(pairs(fx)).toBe(1);
    expect(field.submitted).toEqual([MESSAGE]);
  });
});
