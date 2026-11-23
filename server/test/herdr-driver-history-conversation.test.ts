/**
 * The history batch of an attaching driver names the engine conversation it was read from (`drivers/herdr-driver.ts`):
 * the follower hands over the history before the meta line that becomes `init`, so the session manager can count a
 * history of the conversation the next `init` names as that conversation's (the voice agent's `asksOwner`). The
 * driver runs on the fake client and a real follower over a conversation file (`helpers/herdr-driver-atrapy.ts`).
 */
import { describe, expect, it } from 'vitest';
import { SESSION, makeDriver, useDriverSandbox, userLine, waitFor } from './helpers/herdr-driver-atrapy.ts';

useDriverSandbox();

const assistantLine = (text: string): string => `${JSON.stringify({
  type: 'assistant', isSidechain: false, sessionId: SESSION, timestamp: '2026-08-22T10:00:01.000Z',
  message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text }] },
})}\n`;

describe('herdr driver: the conversation of a history batch', () => {
  it('the history at attach carries the engine conversation it was read from and comes before the first init',
    async () => {
      const fx = await makeDriver({ transcript: userLine('start') + assistantLine('Done. Merge now?') });
      await waitFor(() => fx.events.some((e) => e.type === 'init'), 'init');
      const history = fx.events.findIndex((e) => e.type === 'history');
      const init = fx.events.findIndex((e) => e.type === 'init');
      expect(history).toBeGreaterThanOrEqual(0);
      expect(history).toBeLessThan(init);
      expect(fx.events[history]).toMatchObject({ type: 'history', engineSessionId: SESSION });
      expect(fx.events[init]).toMatchObject({ type: 'init', engineSessionId: SESSION });
    });
});
