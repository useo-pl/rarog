/**
 * Granica modułów drivera herdr (`server/src/drivers/herdr/`) — kierunek zależności.
 *
 * W katalogu zostały moduły samej wysyłki i transkryptu panelu: `commands.ts` (komendy sterujące,
 * stall-guard, przerwanie) i `transcript.ts` (follower jsonl i puls katalogu). Reguły dialogów mieszkają
 * w `server/src/herdr/dialogs/` i mają własnego strażnika granic (`herdr-dialogs-boundary.test.ts`:
 * bez importu fasady drivera, managera i nadzorcy, mapa modułów w `index.ts` i `docs/dialogs.md`).
 *
 * Podział fasady ma sens tylko wtedy, gdy strzałka idzie W JEDNĄ STRONĘ: fasada woła moduły,
 * moduły nie wiedzą o fasadzie. Import w drugą stronę zamieniłby podział w cykl — moduł znowu
 * sięgałby po stan drivera, a „funkcje nad jawnym stanem" stałyby się fikcją utrzymywaną
 * wyłącznie dobrą wolą.
 *
 * Test jest GREPOWY z tego samego powodu co `sdk-boundary.test.ts`: łamiąca zmiana ma się
 * pokazać jako czerwony test, a nie jako narastający import „na chwilę".
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = new URL('../src/drivers/herdr/', import.meta.url).pathname;

const modules = readdirSync(DIR).filter((name) => name.endsWith('.ts'));

describe('moduły drivera herdr', () => {
  it('istnieją (bez nich ten test nie broni niczego)', () => {
    expect(modules.length).toBeGreaterThan(0);
  });

  it.each(modules)('%s nie importuje fasady `herdr-driver.ts`', (name) => {
    const source = readFileSync(join(DIR, name), 'utf8');
    expect(source).not.toMatch(/from '\.\.?\/[^']*herdr-driver/);
  });
});
