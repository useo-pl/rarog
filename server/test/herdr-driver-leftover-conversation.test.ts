/**
 * The leftover clearing before a send keeps the message's engine conversation (`drivers/herdr-driver.ts`, the send
 * path): after Esc the field holds the interrupted prompt and the next send clears it with Esc pairs first. When the
 * pane moves to another conversation (`/clear`, `/resume`) during the composer read before a pair, the pair does not
 * go (it would erase a draft in the new conversation), no `prompt` goes either, and the message ends as any message
 * whose pane switched conversations (`commands.send-session-changed`, its echo back).
 */
import { describe, expect, it } from 'vitest';
import {
  fieldScreen, makeDriver, quiet, systemCodes, useDriverSandbox, waitFor,
} from './helpers/herdr-driver-atrapy.ts';
import type { Fixture } from './helpers/herdr-driver-atrapy.ts';

useDriverSandbox();

const OTHER = '0b6c1f5e-4d1a-4c55-9a3e-2f1e9d7c8b6a';
const pairs = (fx: Fixture): number => fx.client.calls
  .filter((call) => call.method === 'send_keys' && call.keys?.length === 2).length;
const prompts = (fx: Fixture): number => fx.client.calls.filter((call) => call.method === 'prompt').length;

describe('herdr driver: the leftover clearing before a send stays in the message\'s conversation', () => {
  it('the pane moves to another conversation during the composer read before the Esc pair: no pair, no prompt',
    async () => {
      const fx = await makeDriver();
      fx.client.screenText = fieldScreen('interrupted prompt');
      await fx.driver.interrupt();
      await quiet();
      let armed = false;
      const read = fx.client.readScreen.bind(fx.client);
      fx.client.readScreen = (paneId, source, format) => {
        if (armed && source === 'visible' && format === 'ansi') {
          fx.emit({ type: 'session-changed', agentSessionId: OTHER });
        }
        return read(paneId, source, format);
      };
      armed = true;
      fx.driver.send('next message', undefined, undefined, { echo: 'e2', source: 'voice-agent' });
      await waitFor(() => systemCodes(fx.events).includes('commands.send-session-changed'), 'refusal note');
      await quiet();
      expect(pairs(fx)).toBe(0);
      expect(prompts(fx)).toBe(0);
      expect(fx.events).toContainEqual({ type: 'echo-refused', token: 'e2' });
    });
});
