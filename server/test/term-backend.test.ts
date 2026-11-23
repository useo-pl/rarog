/**
 * Terminal PTY — złożenie backendu trwałej powłoki.
 *
 * Rejestr nie wie, czym jest transport powłoki: woła `TermBackend`
 * (`src/term/backend.ts`). Ten plik pilnuje JEDNEGO styku tej granicy — funkcji
 * `createTermBackend`, czyli miejsca, w którym zależności serwera zamieniają się w backend.
 *
 * Backend jest jeden (panel herdr), więc nie ma tu żadnego wyboru
 * do sprawdzenia — jest za to warunek, bez którego backend nie ma prawa powstać: przewód do
 * gniazda herdr. Zachowanie samego backendu sprawdza `term-herdr-backend.test.ts`, a żywy
 * panel — `term-integration.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import type { RarogConfig } from '../src/config.ts';
import type { Logger } from '../src/router.ts';
import { createTermBackend } from '../src/term/index.ts';

const silentLogger: Logger = { info: () => {}, error: () => {} };

function makeConfig(): RarogConfig {
  return loadConfig({
    RAROG_DEMO: '1',
    RAROG_TERM: '1',
    RAROG_PROJECT_ROOTS: '/Users/testowy/Projects',
    PATH: '/usr/bin:/bin',
  });
}

describe('createTermBackend — powłoka mieszka w panelu herdr i bez gniazda nie powstaje', () => {
  /*
   * Backend panelowy BEZ przewodu do gniazda herdr nie umiałby nawet odnaleźć panelu. Złożenie
   * ma wtedy PADAĆ z czytelnym zdaniem (entry gasi ficzer i pisze o tym w logu), a nie oddawać
   * backendu, który zrywa każdy upgrade WS bez słowa.
   */
  it('bez klienta gniazda herdr rzuca z czytelnym powodem', () => {
    expect(() => createTermBackend(makeConfig(), { logger: silentLogger }))
      .toThrow(/herdr socket client/);
  });

  it('z przewodem do gniazda składa się i żąda respawnu przy każdym nowym gnieździe', () => {
    const backend = createTermBackend(makeConfig(), {
      logger: silentLogger,
      herdrLaunchClient: () => null,
    });
    // Każde nowe gniazdo dostaje własnego kontrolera — pełna ramka leci tylko przy starcie.
    expect(backend.respawnOnAttach).toBe(true);
  });
});
