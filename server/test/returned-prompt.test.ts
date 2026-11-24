/**
 * The prompt Claude Code hands back to its field after Rarog's Esc (`drivers/herdr/returned-prompt.ts`), through the
 * herdr driver with the shared fakes (`helpers/herdr-driver-atrapy.ts`) and a real follower over the conversation
 * file. The driver answers the prompt only when the field was empty before the key and the whole field after it
 * equals the interrupted turn's prompt, in the same conversation.
 */
import { readFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HerdrDriverDeps } from '../src/drivers/herdr-driver.ts';
import { createJsonlFollower } from '../src/herdr/jsonl-follow.ts';
import type { FollowEvent, JsonlFollower } from '../src/herdr/jsonl-follow.ts';
import {
  DIALOG_PERMISSION, EMPTY_FIELD, FIXTURES, TIMING, fieldScreen, inTurn, makeDriver, quiet, reads, root,
  useDriverSandbox, userLine, waitFor,
} from './helpers/herdr-driver-atrapy.ts';
import type { Fixture } from './helpers/herdr-driver-atrapy.ts';

useDriverSandbox();

const PROMPT = 'Refactor the parser and keep the tests green';
const OTHER_SESSION = '9f1c4b62-77aa-5d31-8bd0-2c0f6a1e4d55';
const SESSION_PAUSED = readFileSync(join(FIXTURES, 'dialog-session-paused-2.1.309.txt'), 'utf8');

/** A short read bound, so the answers without a prompt do not wait the production 1.2 s. */
const DEPS: Partial<HerdrDriverDeps> = { returnedPromptWaitMs: 150, promptFieldPollMs: 5, interruptProbeDelaysMs: [] };

/** A driver whose idle send of `prompt` went to the pane and whose turn runs. */
async function turnFrom(prompt: string, deps: Partial<HerdrDriverDeps> = {}): Promise<Fixture> {
  const fx = await makeDriver({ deps: { ...DEPS, ...deps } });
  fx.client.screenText = EMPTY_FIELD;
  fx.driver.send(prompt);
  await waitFor(() => fx.client.calls.some((c) => c.method === 'prompt'), 'prompt sent');
  await quiet();
  inTurn(fx);
  return fx;
}

/** The screen each read after the `escape` gets: the next entry, then the last one again. */
function afterEscape(fx: Fixture, screens: readonly string[]): void {
  const raw = fx.client.sendKeys;
  fx.client.sendKeys = (paneId, keys) => {
    if (keys.length === 1 && keys[0] === 'escape') {
      const rawRead = fx.client.readScreen.bind(fx.client);
      let index = 0;
      fx.client.readScreen = (pane, source, format) => {
        fx.client.screenText = screens[Math.min(index, screens.length - 1)] ?? EMPTY_FIELD;
        index += 1;
        return rawRead(pane, source, format);
      };
    }
    return raw(paneId, keys);
  };
}

async function interruptAnswer(fx: Fixture): Promise<string | null | undefined> {
  expect(await fx.driver.interrupt()).toBe(true);
  return fx.driver.returnedPrompt?.();
}

/**
 * A real follower whose first `history` reaches the driver only after `release()`: the read of the conversation file
 * began at attach and ends late. Methods are bound to the follower, whose private fields a proxy receiver would break.
 */
function slowHistory(): { deps: Partial<HerdrDriverDeps>; release: () => void } {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const follow = (opts: Parameters<NonNullable<HerdrDriverDeps['follow']>>[0]): JsonlFollower => {
    const follower = createJsonlFollower({ ...opts, root, watch: false, timing: TIMING });
    async function* held(): AsyncGenerator<FollowEvent> {
      for await (const event of follower.events) {
        if (event.type === 'history') await gate;
        yield event;
      }
    }
    const events = held();
    return new Proxy(follower, {
      get: (target, key) => {
        if (key === 'events') return events;
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
  };
  return { deps: { follow }, release: () => { release(); } };
}

describe('the prompt handed back to the field after Esc', () => {
  it('the field shows the interrupted prompt after Esc: the answer carries it, and one log line without its text',
    async () => {
      const lines: string[] = [];
      const fx = await turnFrom(PROMPT, { logger: (line) => { lines.push(line); } });
      afterEscape(fx, [fieldScreen(PROMPT)]);
      expect(await interruptAnswer(fx)).toBe(PROMPT);
      const handed = lines.filter((line) => line.includes('handed'));
      expect(handed).toHaveLength(1);
      expect(handed[0]).not.toContain('parser');
    });

  it('the field stays empty after Esc: no prompt', async () => {
    const fx = await turnFrom(PROMPT);
    afterEscape(fx, [EMPTY_FIELD]);
    expect(await interruptAnswer(fx)).toBeNull();
  });

  it('the field shows another text, a draft: no prompt', async () => {
    const fx = await turnFrom(PROMPT);
    afterEscape(fx, [fieldScreen('a draft typed at the desk')]);
    expect(await interruptAnswer(fx)).toBeNull();
  });

  it('the field shows only the start of the prompt until the bound: no prompt', async () => {
    const fx = await turnFrom(PROMPT);
    afterEscape(fx, [fieldScreen('Refactor the parser')]);
    expect(await interruptAnswer(fx)).toBeNull();
  });

  it('a paste placeholder proves a line count, not the prompt: no prompt', async () => {
    const fx = await turnFrom('first line\nsecond line\nthird line');
    afterEscape(fx, [fieldScreen('[Pasted text #1 +2 lines]')]);
    expect(await interruptAnswer(fx)).toBeNull();
  });

  it('the prompt appears only after a few reads within the bound: the answer carries it', async () => {
    const fx = await turnFrom(PROMPT);
    afterEscape(fx, [EMPTY_FIELD, EMPTY_FIELD, fieldScreen('Refactor the'), fieldScreen(PROMPT)]);
    expect(await interruptAnswer(fx)).toBe(PROMPT);
  });

  it('the field wraps a multi-line prompt: the answer is the prompt as sent, with its line breaks', async () => {
    const prompt = 'first line of the prompt\nsecond line of the prompt';
    const fx = await turnFrom(prompt);
    afterEscape(fx, [fieldScreen('first line of the prompt\n  second line of the prompt')]);
    expect(await interruptAnswer(fx)).toBe(prompt);
  });

  it('a prompt typed at the desk is the turn\'s prompt from the conversation file', async () => {
    const fx = await turnFrom(PROMPT);
    await appendFile(fx.transcript, userLine('a prompt typed at the desk'));
    await waitFor(() => fx.events.some((e) => e.type === 'message' && e.role === 'user'), 'desk prompt in the file');
    afterEscape(fx, [fieldScreen('a prompt typed at the desk')]);
    expect(await interruptAnswer(fx)).toBe('a prompt typed at the desk');
  });

  it('the escape does not reach the pane: no prompt and no field read after the key', async () => {
    const fx = await turnFrom(PROMPT);
    let atKey = -1;
    fx.client.sendKeys = () => {
      atKey = reads(fx.client);
      return Promise.reject(new Error('socket closed'));
    };
    expect(await fx.driver.interrupt()).toBe(false);
    expect(await fx.driver.returnedPrompt?.()).toBeNull();
    await quiet();
    expect(reads(fx.client)).toBe(atKey);
  });

  it('a send after Esc ends the read: no prompt', async () => {
    const fx = await turnFrom(PROMPT, { returnedPromptWaitMs: 2_000 });
    afterEscape(fx, [EMPTY_FIELD]);
    expect(await fx.driver.interrupt()).toBe(true);
    const answer = fx.driver.returnedPrompt?.();
    fx.driver.send('the next prompt');
    expect(await answer).toBeNull();
  });

  it.each([
    ['a draft equal to the prompt, typed at the desk', (fx: Fixture) => {
      fx.client.screenText = fieldScreen('continue');
    }],
    ['an unreadable field', (fx: Fixture) => {
      const raw = fx.client.readScreen.bind(fx.client);
      fx.client.readScreen = () => {
        fx.client.readScreen = raw;
        return Promise.reject(new Error('socket closed'));
      };
    }],
  ])('before Esc the field shows %s: Esc leaves it, so a field equal to the prompt proves no hand-back',
    async (_label, before) => {
      const fx = await turnFrom('continue');
      before(fx);
      afterEscape(fx, [fieldScreen('continue')]);
      expect(await interruptAnswer(fx)).toBeNull();
    });

  it('a dialog stands, so a tool has shown: the key waits for no field read and the answer has no prompt', async () => {
    const fx = await turnFrom(PROMPT);
    fx.client.screenText = DIALOG_PERMISSION;
    inTurn(fx, 'blocked');
    await quiet();
    const fieldReads = (): number => fx.client.calls
      .filter((c) => c.method === 'read' && c.source === 'visible').length;
    const before = fieldReads();
    let atKey = -1;
    const raw = fx.client.sendKeys;
    fx.client.sendKeys = (paneId, keys) => {
      atKey = fieldReads();
      return raw(paneId, keys);
    };
    afterEscape(fx, [fieldScreen(PROMPT)]);
    expect(await interruptAnswer(fx)).toBeNull();
    expect(atKey).toBe(before);
  });

  it('a move to another conversation drops the answer and the prompt of the old one', async () => {
    const fx = await turnFrom('continue');
    afterEscape(fx, [fieldScreen('continue')]);
    expect(await interruptAnswer(fx)).toBe('continue');
    fx.emit({ type: 'session-changed', agentSessionId: OTHER_SESSION });
    // A repeat inside the manager's debounce window asks again without a new `escape`.
    expect(await fx.driver.returnedPrompt?.()).toBeNull();
    // A new Esc in the other conversation, its field empty before the key: the old prompt after it is no hand-back.
    Reflect.deleteProperty(fx.client, 'readScreen');
    fx.client.screenText = EMPTY_FIELD;
    expect(await interruptAnswer(fx)).toBeNull();
  });

  it('a history read that began before a send does not replace the sent prompt with an older one', async () => {
    const slow = slowHistory();
    const fx = await makeDriver({
      transcript: userLine('an older prompt from the desk'), deps: { ...DEPS, ...slow.deps },
    });
    fx.client.screenText = EMPTY_FIELD;
    fx.driver.send(PROMPT);
    await waitFor(() => fx.client.calls.some((c) => c.method === 'prompt'), 'prompt sent');
    await quiet();
    slow.release();
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'history delivered');
    inTurn(fx);
    afterEscape(fx, [fieldScreen(PROMPT)]);
    expect(await interruptAnswer(fx)).toBe(PROMPT);
  });

  it('the field read before Esc does not return: the key goes after its bound, and no prompt', async () => {
    const fx = await turnFrom(PROMPT, { fieldReadBeforeEscapeMs: 30 });
    fx.client.readScreen = () => new Promise(() => {});
    const hung = new Promise<'hung'>((resolve) => { setTimeout(() => { resolve('hung'); }, 1_000); });
    expect(await Promise.race([fx.driver.interrupt(), hung])).toBe(true);
    expect(fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys)).toEqual([['escape']]);
    expect(await fx.driver.returnedPrompt?.()).toBeNull();
  });

  it('a "Session paused" dialog comes up during the field read before Esc: no key, Esc on it refused', async () => {
    const fx = await turnFrom(PROMPT);
    const raw = fx.client.readScreen.bind(fx.client);
    fx.client.readScreen = (pane, source, format) => {
      if (source === 'visible') {
        fx.client.readScreen = raw;
        fx.client.screenText = SESSION_PAUSED;
        fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 9, title: '' });
      }
      return raw(pane, source, format);
    };
    expect(await fx.driver.interrupt()).toBe(false);
    expect(fx.client.calls.filter((c) => c.method === 'send_keys')).toEqual([]);
    expect(fx.audit.filter((e) => e.method === 'refuse')).toHaveLength(1);
  });

  it('a field read that never returns still answers within the bound', async () => {
    const fx = await turnFrom(PROMPT);
    const raw = fx.client.sendKeys;
    fx.client.sendKeys = (paneId, keys) => {
      fx.client.readScreen = () => new Promise(() => {});
      return raw(paneId, keys);
    };
    expect(await fx.driver.interrupt()).toBe(true);
    const started = Date.now();
    expect(await fx.driver.returnedPrompt?.()).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
