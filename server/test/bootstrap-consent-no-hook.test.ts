/**
 * The sources of the consent-without-hook detector as the server start builds them (`consentNoHookSources` in
 * `bootstrap/consent.ts`): the emergency key reaches the consent cycle the link holds at the moment of the key (the
 * cycle is created after the sources), and the restart grace counts from the process start.
 */
import { describe, expect, it, vi } from 'vitest';
import { consentNoHookSources } from '../src/bootstrap/consent.ts';
import type { ConsentLink } from '../src/bootstrap/consent.ts';
import type { ConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import type { ConsentScreenKey } from '../src/herdr/dialogs/layer1/screen-key.ts';

const SESSION = '00000000-0000-4000-9000-000000000001';
const KEY: ConsentScreenKey = { toolName: 'Bash', inputSha256: 'a'.repeat(64), at: 2_000, since: 1_000 };

type Sources = ReturnType<typeof consentNoHookSources>;

function sources(link: ConsentLink, startedAt = Date.now(), restartGraceMs = 60_000): Sources {
  return consentNoHookSources({
    link, dataDir: '/nonexistent', home: '/nonexistent', roots: [], entry: async () => null,
    proofGate: { current: () => ({ main: 'screen', subagents: 'screen' }) }, restartGraceMs, startedAt,
  });
}

describe('consentNoHookSources', () => {
  it('the key goes to the cycle the link holds when the key is sent; without a cycle nothing happens', () => {
    const link: ConsentLink = { cycle: null, registry: null };
    const built = sources(link);
    expect(() => built.screenKey?.(SESSION, KEY)).not.toThrow();
    const screenKey = vi.fn();
    link.cycle = { screenKey } as unknown as ConsentCycle;
    built.screenKey?.(SESSION, KEY);
    expect(screenKey).toHaveBeenCalledExactlyOnceWith(SESSION, KEY);
  });

  it('restarting while the grace from the process start runs, not after it', () => {
    const link: ConsentLink = { cycle: null, registry: null };
    expect(sources(link, Date.now(), 60_000).restarting()).toBe(true);
    expect(sources(link, Date.now() - 60_001, 60_000).restarting()).toBe(false);
  });
});
