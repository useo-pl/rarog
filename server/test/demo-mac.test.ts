/**
 * Obciążenie Maca w trybie demo: stała fikcja zamiast próbnika maszyny, na której biegną testy.
 *
 * Serwer demo stawiają XCUITesty apki natywnej — prawdziwy próbnik pokazywałby obciążenie Maca, który
 * akurat buduje, czyli inną stopkę w każdym przebiegu. Demo ma być przewidywalne jak limity planu.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { liveActivityMacSchema } from '@rarog/shared/rest';
import { DEMO_MAC_STATS, demoMacStats } from '../src/demo/mac.ts';

describe('obciążenie Maca w demo', () => {
  it('odpowiedź przechodzi schemat i jest stała; kopia nie przecieka do atrapy', () => {
    const sampler = demoMacStats();
    const first = sampler.current();
    expect(liveActivityMacSchema.parse(first)).toEqual(first);
    first.cpu = 1;
    expect(sampler.current()).toEqual({ cpu: 35, ram: 80, disk: 95 });
    expect(DEMO_MAC_STATS).toEqual({ cpu: 35, ram: 80, disk: 95 });
    sampler.close();
  });

  it('serwer w demo nie próbkuje maszyny; jeden próbnik idzie do routera, Live Activity i zamknięcia', () => {
    // Składanie: `index.ts` zakłada próbnik i zamyka go w `shutdown`, `bootstrap/` podaje go kanałowi APNs i routerowi.
    const index = ['../src/index.ts', '../src/bootstrap/push.ts', '../src/bootstrap/http.ts'].map((file) => readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), file), 'utf8',
    )).join('\n');
    expect(index).toContain(
      "const macStats = config.demo ? (await import('./demo/mac.ts')).demoMacStats() : createMacStats();",
    );
    // Ten sam próbnik dla kanału APNs i dla trasy; zamyka go `shutdown`, nie kanał.
    expect(index.match(/mac: \(\) => macStats\.current\(\)/g)).toHaveLength(2);
    expect(index).toContain('macStats.close();');
    expect(index.match(/createMacStats\(/g)).toHaveLength(1);
  });
});
