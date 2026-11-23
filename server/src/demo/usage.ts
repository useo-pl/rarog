/**
 * Limity planu w trybie demo: stałe liczby zamiast prawdziwego dostawcy.
 *
 * Prawdziwy `createUsageProvider` czyta zrzuty paska statusu Claude Code z `~/.claude/statusline/`
 * i e-mail konta z `~/.claude.json`. Serwer demo stawiają testy (XCUITest apki natywnej przez
 * `scripts/ios-check.sh`, która pyta o limity zaraz po zalogowaniu), więc demo z prawdziwym dostawcą
 * pokazywałoby liczby i konto człowieka, i to inne przy każdym przebiegu — a demo ma być fikcją
 * w całości, jak seedy sesji. Stałe liczby dają też testom przewidywalny obraz stopki; okno per
 * model (np. Fable) zostaje w demo, choć serwer go już nie wysyła, bo apka dalej umie je narysować.
 *
 * Procenty leżą w trzech progach koloru (spokojnie, uwaga, gorąco), a momenty resetu liczy się
 * od „teraz", żeby panel mówił „reset … · za 2 h 44", a nie „lada chwila".
 *
 * Szczegóły (`GET /api/usage/details`, arkusz „Limity” komendy apki `/usage`) to te
 * same liczby z chwilą odczytu sprzed {@link DEMO_DETAILS_AGE_MS}, jak odczyt, który Claude Code
 * odświeża sam i rzadko: arkusz pokazuje wtedy dwie godziny — „Stan z …, tydzień Fable z …”.
 */
import type { PlanUsage, UsageProvider } from '../usage.ts';

const MIN = 60_000;

/** Ile zostało do resetu okna 5 h i tygodnia w demo. */
const DEMO_FIVE_HOUR_LEFT_MS = 164 * MIN;
const DEMO_WEEK_LEFT_MS = 3 * 24 * 60 * MIN + 5 * 60 * MIN;

/** Wiek odczytu limitów Claude Code w szczegółach demo (starszy niż próg `stale`, 15 min). */
export const DEMO_DETAILS_AGE_MS = 47 * MIN;

export function demoPlanUsage(now: number): PlanUsage {
  const week = new Date(now + DEMO_WEEK_LEFT_MS).toISOString();
  return {
    fiveHour: { percent: 27, resetsAt: new Date(now + DEMO_FIVE_HOUR_LEFT_MS).toISOString() },
    weekly: { percent: 64, resetsAt: week },
    weeklyModel: { percent: 91, resetsAt: week, model: 'Fable' },
    account: 'demo@example.com',
  };
}

/** `GET /api/usage/details` w demo: liczby stopki z własną, starszą chwilą odczytu. */
export function demoPlanUsageDetails(now: number): PlanUsage {
  return {
    stale: true,
    fetchedAt: new Date(now - DEMO_DETAILS_AGE_MS).toISOString(),
    ...demoPlanUsage(now),
  };
}

export function demoUsageProvider(now: () => number = Date.now): UsageProvider {
  return {
    get: () => Promise.resolve(demoPlanUsage(now())),
    details: () => Promise.resolve(demoPlanUsageDetails(now())),
  };
}
