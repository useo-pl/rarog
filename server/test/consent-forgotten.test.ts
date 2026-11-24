/**
 * The manager's receiver of a forgotten conversation (`consentForgottenPort` in `bootstrap/consent.ts`) hands the
 * session to the consent cycle, and a failing cleanup leaves one log line instead of an unhandled rejection.
 */
import { describe, expect, it } from 'vitest';
import { consentForgottenPort } from '../src/bootstrap/consent.ts';
import type { ConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import type { Logger } from '../src/router.ts';

const ENGINE = '55555555-5555-4555-8555-555555555555';

function logger(lines: string[]): Logger {
  return { info: (line: string) => { lines.push(line); }, error: (line: string) => { lines.push(line); } };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise<void>((done) => { setImmediate(done); });
}

describe('consentForgottenPort', () => {
  it('passes the forgotten session to the cycle and logs nothing on success', async () => {
    const forgotten: string[] = [];
    const lines: string[] = [];
    const cycle = { forgetSession: async (id: string) => { forgotten.push(id); } } as unknown as ConsentCycle;
    consentForgottenPort(cycle, logger(lines))(ENGINE);
    await flush();
    expect(forgotten).toEqual([ENGINE]);
    expect(lines).toEqual([]);
  });

  it('a rejected cleanup is one log line with the place, and the next call still runs', async () => {
    const lines: string[] = [];
    let calls = 0;
    const cycle = {
      forgetSession: async () => {
        calls += 1;
        throw new TypeError('store closed');
      },
    } as unknown as ConsentCycle;
    const forget = consentForgottenPort(cycle, logger(lines));
    forget(ENGINE);
    forget(ENGINE);
    await flush();
    expect(calls).toBe(2);
    expect(lines).toEqual([
      'consent: forget session failed: TypeError: store closed',
      'consent: forget session failed: TypeError: store closed',
    ]);
  });
});
