/**
 * Esc pressed while a send is still in flight (`drivers/herdr-driver.ts`, `interrupt()`). Esc may hand the
 * interrupted prompt back to its field (CLI 2.1.329), so the next send has to clear the field first. The flag that
 * asks for it must survive the end of the send that was in flight when Esc came.
 */
import { describe, expect, it } from 'vitest';
import { EMPTY_FIELD, fieldScreen, makeDriver, quiet, useDriverSandbox, waitFor } from './helpers/herdr-driver-atrapy.ts';

useDriverSandbox();

describe('interrupt during a send in flight', () => {
  it('the next send clears the returned prompt with an Esc pair before writing', async () => {
    const fx = await makeDriver();
    fx.client.screenText = EMPTY_FIELD;
    const rawPrompt = fx.client.prompt.bind(fx.client);
    let release: (() => void) | null = null;
    let first = true;
    fx.client.prompt = (paneId, text, wait) => {
      const call = rawPrompt(paneId, text, wait);
      if (!first) return call;
      first = false;
      return call.then(() => new Promise<void>((resolve) => { release = resolve; }));
    };
    const rawKeys = fx.client.sendKeys;
    fx.client.sendKeys = (paneId, keys) => {
      if (keys.length === 2) fx.client.screenText = EMPTY_FIELD;
      return rawKeys(paneId, keys);
    };

    fx.driver.send('first prompt');
    await waitFor(() => release !== null, 'first prompt in flight');
    fx.driver.interrupt();
    // The CLI took the prompt, Esc stopped it before any answer and the CLI put the prompt back in its field.
    fx.client.screenText = fieldScreen('first prompt');
    (release as (() => void) | null)?.();
    await waitFor(() => fx.client.calls.some((c) => c.method === 'send_keys'), 'interrupt Esc');
    await quiet();

    fx.driver.send('second prompt');
    await waitFor(() => fx.client.calls.filter((c) => c.method === 'prompt').length === 2, 'second prompt');
    await quiet();

    expect(fx.client.calls.filter((c) => c.method === 'prompt' || c.method === 'send_keys')
      .map((c) => c.keys ?? c.text))
      .toEqual(['first prompt', ['escape'], ['escape', 'escape'], 'second prompt']);
  });
});
