/**
 * Heurystyka świeżości limitów (`scanFreshestRateLimits` w `server/src/herdr/statusline.ts`): podmiana zrzutu
 * MIĘDZY `stat` a odczytem. Odcisk pochodzi wtedy z nowej treści, a `mtime` ze starego `stat`; zapis takiej pary
 * utrwaliłby za wczesny `changeAt` i świeży zrzut przegrywałby w kolejnych skanach. Osobny plik, bo test podmienia
 * `stat` z `node:fs/promises` atrapą z punktem zaczepienia.
 */
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Wywoływany raz, po pierwszym `stat` pliku o tej nazwie, zanim skan go przeczyta. */
const hook: { name: string | null; run: (() => Promise<void>) | null } = { name: null, run: null };

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    stat: async (...args: Parameters<typeof real.stat>) => {
      const info = await real.stat(...args);
      if (hook.run !== null && String(args[0]).endsWith(`/${String(hook.name)}`)) {
        const run = hook.run;
        hook.run = null;
        await run();
      }
      return info;
    },
  };
});

const { scanFreshestRateLimits } = await import('../src/herdr/statusline.ts');

const NOW = Date.parse('2026-10-04T20:40:00Z');
const T0 = 1791000000;

function dumpText(five: number, apiMs: number): string {
  return JSON.stringify({
    cost: { total_api_duration_ms: apiMs },
    rate_limits: { five_hour: { used_percentage: five, resets_at: 1791163800 } },
  });
}

describe('scanFreshestRateLimits — podmiana zrzutu między `stat` a odczytem', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'rarog-statusline-podmiana-')); });
  afterEach(async () => {
    hook.run = null;
    await rm(root, { recursive: true, force: true });
  });

  async function dump(name: string, text: string, mtimeSec: number): Promise<void> {
    const path = join(root, name);
    await writeFile(path, text);
    await utimes(path, mtimeSec, mtimeSec);
  }

  async function winner(): Promise<{ five: number | undefined; at: number } | null> {
    const limits = await scanFreshestRateLimits(root, NOW);
    return limits === null ? null : { five: limits.fiveHour?.percent, at: limits.at };
  }

  it('`changeAt` pochodzi z tej samej wersji pliku co odcisk: świeży zrzut wygrywa w następnym skanie', async () => {
    await dump('a.json', dumpText(10, 100), T0 + 100);
    await dump('b.json', dumpText(20, 200), T0 + 200);
    expect(await winner()).toEqual({ five: 20, at: (T0 + 200) * 1000 });

    // A przerysowany bez zmiany liczb, a zaraz po `stat` skanu podmieniony na nowe liczby z późniejszym `mtime`.
    await dump('a.json', dumpText(10, 100), T0 + 150);
    hook.name = 'a.json';
    hook.run = () => dump('a.json', dumpText(11, 110), T0 + 300);
    expect(await winner(), 'skan z podmianą nie zapisuje pary nowy odcisk + stary `mtime`')
      .toEqual({ five: 20, at: (T0 + 200) * 1000 });

    expect(await winner(), 'następny skan: `changeAt` = `mtime` nowej treści')
      .toEqual({ five: 11, at: (T0 + 300) * 1000 });
  });
});
