/**
 * Limity planu w trybie demo: stała fikcja zamiast zrzutów paska statusu.
 *
 * Serwer demo stawiają testy apki natywnej, która pyta o limity zaraz po zalogowaniu. Prawdziwy
 * dostawca czytałby wtedy zrzuty i `~/.claude.json` człowieka — demo ma ich nie dotykać.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { planUsageSchema } from '@rarog/shared/rest';
import { DEMO_DETAILS_AGE_MS, demoPlanUsage, demoUsageProvider } from '../src/demo/usage.ts';

const NOW = Date.parse('2026-10-05T10:00:00.000Z');

describe('limity planu w demo', () => {
  it('odpowiedź przechodzi schemat REST i jest świeża (bez stale i źródła CLI)', async () => {
    const usage = await demoUsageProvider(() => NOW).get();
    expect(planUsageSchema.parse(usage)).toEqual(usage);
    expect(usage?.stale).toBeUndefined();
    expect(usage?.source).toBeUndefined();
  });

  it('trzy okna w trzech progach koloru, reset w przyszłości liczony od „teraz"', () => {
    const usage = demoPlanUsage(NOW);
    const percents = [usage.fiveHour?.percent, usage.weekly?.percent, usage.weeklyModel?.percent];
    expect(percents).toEqual([27, 64, 91]);
    expect(Date.parse(usage.fiveHour?.resetsAt ?? '') - NOW).toBe(164 * 60_000);
    expect(Date.parse(usage.weekly?.resetsAt ?? '')).toBeGreaterThan(NOW);
    expect(usage.weeklyModel?.model).toBe('Fable');
  });

  it('szczegóły (`GET /api/usage/details`): te same liczby ze starszą chwilą odczytu, bez źródła', async () => {
    const details = await demoUsageProvider(() => NOW).details();
    expect(planUsageSchema.parse(details)).toEqual(details);
    expect(details).toEqual({
      stale: true, fetchedAt: new Date(NOW - DEMO_DETAILS_AGE_MS).toISOString(), ...demoPlanUsage(NOW),
    });
    expect(details.source).toBeUndefined();
    expect(details.weeklyModel?.model).toBe('Fable');
  });

  it('serwer podaje atrapę routerowi wyłącznie w trybie demo', () => {
    // Składanie: `index.ts` zakłada atrapę, `bootstrap/http.ts` podaje ją routerowi.
    const index = ['../src/index.ts', '../src/bootstrap/http.ts'].map((file) => readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), file), 'utf8',
    )).join('\n');
    expect(index).toMatch(/config\.demo \? \(await import\('\.\/demo\/usage\.ts'\)\)\.demoUsageProvider\(\)/);
    expect(index).toContain('...(demoUsage === undefined ? {} : { usage: demoUsage })');
  });
});
