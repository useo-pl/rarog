/**
 * The stall guard of an idle pane's prompt keeps the message's engine conversation: when the pane moves to another
 * conversation (`/clear`, `/resume`) between the stalled first `prompt` and the retry, neither the Esc pair that
 * clears the field nor the second `prompt` goes, and the message ends as any message whose pane switched
 * conversations (`commands.send-session-changed`, its echo back). The conversation is checked after every composer
 * read, right before each Esc pair. The driver runs on the fake client and a real follower
 * (`helpers/herdr-driver-atrapy.ts`).
 */
import { describe, expect, it } from 'vitest';
import { foreign } from '@rarog/shared/sentences';
import { HerdrStalledError } from '../src/herdr/types.ts';
import { makeDriver, quiet, systemCodes, useDriverSandbox, waitFor } from './helpers/herdr-driver-atrapy.ts';
import type { Fixture } from './helpers/herdr-driver-atrapy.ts';

useDriverSandbox();

const OTHER = '0b6c1f5e-4d1a-4c55-9a3e-2f1e9d7c8b6a';
const TEXT = 'run the tests';
const stalled = (): HerdrStalledError => new HerdrStalledError(foreign('agent_prompt_stalled'));
const prompts = (fx: Fixture): (string | undefined)[] => fx.client.calls
  .filter((call) => call.method === 'prompt').map((call) => call.text);
const escapes = (fx: Fixture): number => fx.client.calls
  .filter((call) => call.method === 'send_keys' && call.keys?.[0] === 'escape').length;

describe('herdr driver: the stall retry stays in the message\'s conversation', () => {
  it('the pane moves to another conversation during the screen read that confirms the stall: no Esc pair, no second '
    + 'prompt', async () => {
    const fx = await makeDriver({ deps: { stallSettleMs: 5 } });
    fx.client.screenText = `❯ ${TEXT}`;
    const read = fx.client.readScreen.bind(fx.client);
    fx.client.readScreen = (paneId, ...rest) => {
      if (prompts(fx).length === 1) fx.emit({ type: 'session-changed', agentSessionId: OTHER });
      return read(paneId, ...rest);
    };
    fx.client.promptErrors.push(stalled());
    fx.driver.send(TEXT, undefined, undefined, { echo: 'e1', source: 'voice-agent' });
    await waitFor(() => systemCodes(fx.events).includes('commands.send-session-changed'), 'refusal note');
    await quiet();
    expect(prompts(fx)).toEqual([TEXT]);
    expect(escapes(fx)).toBe(0);
    expect(fx.events).toContainEqual({ type: 'echo-refused', token: 'e1' });
  });

  it('the pane moves to another conversation during the composer read before the Esc pair: no Esc pair, no second '
    + 'prompt', async () => {
    const fx = await makeDriver({ deps: { stallSettleMs: 5 } });
    fx.client.screenText = `❯ ${TEXT}`;
    const read = fx.client.readScreen.bind(fx.client);
    fx.client.readScreen = (paneId, source, format) => {
      // The stall itself is confirmed on the `detection` read; the composer is read `visible` right before each pair.
      if (prompts(fx).length === 1 && source === 'visible') fx.emit({ type: 'session-changed', agentSessionId: OTHER });
      return read(paneId, source, format);
    };
    fx.client.promptErrors.push(stalled());
    fx.driver.send(TEXT, undefined, undefined, { echo: 'e1', source: 'voice-agent' });
    await waitFor(() => systemCodes(fx.events).includes('commands.send-session-changed'), 'refusal note');
    await quiet();
    expect(escapes(fx)).toBe(0);
    expect(prompts(fx)).toEqual([TEXT]);
    expect(fx.events).toContainEqual({ type: 'echo-refused', token: 'e1' });
  });

  it('the pane moves to another conversation during the composer read after a pair that left the field full: no '
    + 'further pair', async () => {
    const fx = await makeDriver({ deps: { stallSettleMs: 5 } });
    fx.client.screenText = `❯ ${TEXT}`;
    const read = fx.client.readScreen.bind(fx.client);
    fx.client.readScreen = (paneId, source, format) => {
      if (escapes(fx) === 1 && source === 'visible') fx.emit({ type: 'session-changed', agentSessionId: OTHER });
      return read(paneId, source, format);
    };
    fx.client.promptErrors.push(stalled());
    fx.driver.send(TEXT, undefined, undefined, { echo: 'e1', source: 'voice-agent' });
    await waitFor(() => systemCodes(fx.events).includes('commands.send-session-changed'), 'refusal note');
    await quiet();
    expect(escapes(fx)).toBe(1);
    expect(prompts(fx)).toEqual([TEXT]);
  });

  it('the pane moves to another conversation during the Esc pair: no second prompt', async () => {
    const fx = await makeDriver({ deps: { stallSettleMs: 5 } });
    fx.client.screenText = `❯ ${TEXT}`;
    const keys = fx.client.sendKeys;
    fx.client.sendKeys = (paneId, sent) => {
      if (sent.length === 2) {
        fx.client.screenText = '❯';
        fx.emit({ type: 'session-changed', agentSessionId: OTHER });
      }
      return keys(paneId, sent);
    };
    fx.client.promptErrors.push(stalled());
    fx.driver.send(TEXT, undefined, undefined, { echo: 'e1', source: 'voice-agent' });
    await waitFor(() => systemCodes(fx.events).includes('commands.send-session-changed'), 'refusal note');
    await quiet();
    expect(prompts(fx)).toEqual([TEXT]);
    expect(fx.events).toContainEqual({ type: 'echo-refused', token: 'e1' });
  });
});
