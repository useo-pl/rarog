/**
 * Obciążenie Maca w trybie demo: stałe liczby zamiast prawdziwego próbnika.
 *
 * Serwer demo stawiają testy apki natywnej (XCUITest przez `scripts/ios-check.sh`) na maszynie, która
 * akurat buduje — prawdziwy próbnik pokazywałby obciążenie tej maszyny, różne w każdym przebiegu, a demo
 * ma być fikcją w całości, jak seedy sesji i limity planu (`demo/usage.ts`). Stałe liczby dają testom
 * i zrzutom przewidywalną stopkę: procesor poniżej progu, pamięć na progu uwagi, dysk na progu czerwieni
 * (progi w `RarogContract`, `MacMetric`). Bez timerów — nie ma czego zamykać.
 */
import type { ServerSystem } from '@rarog/shared/rest';
import type { MacStats, MacStatsSampler } from '../mac-stats.ts';

/** Liczby demo: CPU spokojnie, RAM — uwaga (≥ 75), dysk — czerwień (≥ 95). */
export const DEMO_MAC_STATS: Readonly<MacStats> = Object.freeze({ cpu: 35, ram: 80, disk: 95 });

export function demoMacStats(): MacStatsSampler {
  return {
    current: () => ({ ...DEMO_MAC_STATS }),
    close: () => {},
  };
}

/**
 * System maszyny w `GET /api/version` trybu demo: zawsze `macos`. Demo to fikcyjny Mac (stopka obciążenia wyżej,
 * kod parowania „z Maca”), więc apka w testach i na zrzutach mówi „Mac” niezależnie od maszyny, która je puszcza.
 */
export const DEMO_SERVER_SYSTEM: ServerSystem = 'macos';

/**
 * Server name in the pairing answer of the plain demo (`PairResponse.server.name`) instead of `hostname()`: a demo
 * shown, recorded or captured must not reveal the name of the machine that runs it. The app shows it only in Settings,
 * Server section, as the value of the row named after the machine word. The review mode takes its own name from the
 * content set.
 */
export const DEMO_SERVER_NAME = 'Mac';
