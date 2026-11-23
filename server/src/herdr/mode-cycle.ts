/**
 * Przełączanie trybu uprawnień panelu z Raroga (`plan` ↔ `auto`) — JEDYNE miejsce w Rarogu,
 * które zna klawisz `shift+tab`.
 *
 * Skąd ten moduł: tapnięcie w pigułkę „auto" obok modelu ma przestawić
 * panel w tryb planu, a tapnięcie w „plan" wrócić do auto. Docs Claude Code (permission-modes,
 * „Switch permission modes”) podają w terminalu jedną drogę zmiany trybu w trakcie sesji: `Shift+Tab`, który
 * CYKLUJE tryby CAŁEJ sesji; `--permission-mode` ustawia tryb tylko przy starcie. Zmierzone
 * na herdr 0.9.0: `agent.send_keys` przyjmuje nazwę `shift+tab` i oddaje panelowi `^[[Z` (backtab);
 * `S-Tab`/`backtab` odrzuca.
 *
 * Kolejność cyklu NIE jest kontraktem tego modułu i celowo nigdzie tu nie stoi: według docs zależy od trybu,
 * z którego panel startuje, i od trybów opcjonalnych, które wchodzą do cyklu po `plan` (`bypassPermissions`,
 * `auto`). Zamiast liczyć naciśnięcia, Rarog idzie krokami
 * „naciśnij → odczytaj stopkę → porównaj" i zatrzymuje się na PIERWSZYM odczycie z celem. Stąd
 * granice modułu (wszystkie świadome):
 *
 * - **`shift+tab` NIE wchodzi do `ALLOWED_KEYS`** (`dialogs/send/keys.ts`), dokładnie jak `enter`:
 *   wspólna lista dawałaby klawisz cyklu trybów każdej ścieżce naraz. Tu jest osobna,
 *   jednoelementowa asercja i osobna metoda klienta (`sendModeCycle`).
 * - **Bez odczytu nie ma następnego naciśnięcia.** Stopka niewidoczna (`unknown`) kończy pętlę
 *   i mówi człowiekowi, gdzie panel stanął — Rarog nie klika w ciemno w cudzy tryb.
 * - **Sufit naciśnięć** ({@link MODE_CYCLE_MAX_PRESSES}) jest większy niż liczba trybów w cyklu:
 *   pełny obrót bez trafienia znaczy, że stopki nie rozumiemy albo cel w tym panelu nie istnieje
 *   (np. `auto` wyłączone w ustawieniach) — wtedy zdanie do transkryptu, nigdy kolejna runda.
 * - **Cele są DWA**: `plan` i `auto`. `bypass` jako cel nie istnieje (Rarog nie zdejmuje pytań
 *   o zgodę), `manual` jako cel nie był potrzebny.
 *
 * Moduł jest CZYSTY (bez I/O): decyzje na wartościach, wysyła driver.
 */
import type { HerdrMode, ModeCycleTarget } from '@rarog/shared';
import { say } from '@rarog/shared/sentences';
import type { OwnText } from '@rarog/shared/sentences';
import { HerdrKeyNotAllowedError } from './dialogs/send/keys.ts';
import type { HerdrFooterMode } from './dialogs/screen/mode-footer.ts';

export type { ModeCycleTarget };

/** Jedyny klawisz cyklu trybów — i jedyne miejsce, które go zna. */
export const MODE_CYCLE_KEY = 'shift+tab';

/**
 * Sufit naciśnięć w jednej zmianie trybu. Docs (permission-modes, „Switch permission modes”) wymieniają w cyklu
 * najwyżej pięć trybów: `default` (stopka „manual”) → `acceptEdits` → `plan`, potem opcjonalne `bypassPermissions`
 * i `auto`, więc szósty krok jest już dowodem, że coś nie gra.
 */
export const MODE_CYCLE_MAX_PRESSES = 6;

/** Pauza klawisz → odczyt stopki: TUI potrzebuje chwili na przerysowanie linii statusu. */
export const MODE_CYCLE_SETTLE_MS = 250;

/**
 * Asercja ścieżki cyklu trybów: DOKŁADNIE `['shift+tab']`, nic innego, nic więcej.
 *
 * @throws {HerdrKeyNotAllowedError} gdy tablica nie jest dokładnie `['shift+tab']`
 */
export function assertModeCycleKeys(keys: readonly string[]): void {
  if (keys.length !== 1 || keys[0] !== MODE_CYCLE_KEY) {
    // Zdanie ma klawisz w szablonie: `MODE_CYCLE_KEY` to stała, która się nie zmienia.
    throw new HerdrKeyNotAllowedError(say('commands.mode-cycle-keys'));
  }
}

/**
 * Tryby, z których wolno RUSZYĆ cyklem. `bypass` odpada: cykl z niego przechodzi przez
 * wszystkie pozostałe tryby, a panel w `bypass` to decyzja człowieka przy biurku, której Rarog
 * nie odkręca. `unknown` odpada z definicji — nie wiadomo, gdzie panel stoi.
 */
export function modeCycleStartAllowed(mode: HerdrMode): boolean {
  return mode === 'plan' || mode === 'auto' || mode === 'manual';
}

export type ModeCycleStep =
  /** Stopka pokazuje cel — koniec, bez klawisza. */
  | { kind: 'done' }
  /** Naciśnij `shift+tab` i odczytaj stopkę ponownie. */
  | { kind: 'press' }
  /** Stop bez klawisza: stopki nie widać albo wyczerpany sufit naciśnięć. */
  | { kind: 'stop'; reason: 'unknown' | 'exhausted' };

/** Powody zatrzymania, o których mówi zdanie w transkrypcie (`modeCycleStoppedMessage`). */
export type ModeCycleStopReason = 'unknown' | 'exhausted' | 'send-failed' | 'busy';

/**
 * Następny krok pętli po ŚWIEŻYM odczycie stopki.
 *
 * `current` jest DOKŁADNY (`HerdrFooterMode`): `acceptEdits` NIE jest celem `auto`, choć chip
 * pokazuje go jako `auto` — panel bez prawa do `auto` kończyłby inaczej cykl fałszywym sukcesem.
 *
 * @param current tryb z ostatniego odczytu
 * @param target  tryb docelowy
 * @param presses ile naciśnięć już poszło
 */
export function nextModeCycleStep(
  current: HerdrFooterMode, target: ModeCycleTarget, presses: number,
): ModeCycleStep {
  if (current === target) return { kind: 'done' };
  if (current === 'unknown') return { kind: 'stop', reason: 'unknown' };
  if (presses >= MODE_CYCLE_MAX_PRESSES) return { kind: 'stop', reason: 'exhausted' };
  return { kind: 'press' };
}

/** Nazwa trybu ze stopki do zdań w transkrypcie (tryb nieznany ma własny wariant zdania). */
function modeName(mode: Exclude<HerdrFooterMode, 'unknown'>): string {
  return mode === 'acceptEdits' ? 'accept edits' : mode;
}

/** Tryb ustawiony — trwały ślad w transkrypcie, pisany przez serwer (jak przy `/model`). */
export const modeCycleDoneMessage = (target: ModeCycleTarget, presses: number): OwnText =>
  say('commands.mode-cycle-done', { target, presses });

/** Pętla stanęła bez celu — zdanie mówi, GDZIE panel stoi, żeby człowiek nie zgadywał. */
export function modeCycleStoppedMessage(
  target: ModeCycleTarget, reason: ModeCycleStopReason, current: HerdrFooterMode, presses: number,
): OwnText {
  // Miejsce, w którym panel stanął („po N× shift+tab panel stoi w trybie X”), jest spłaszczone do argumentów:
  // `presses` i `mode`, a tryb nieznany ma osobny kod bez `mode`.
  if (current === 'unknown') {
    if (reason === 'busy') return say('commands.mode-cycle-busy.mode-unknown', { presses, target });
    if (reason === 'unknown') return say('commands.mode-cycle-no-footer.mode-unknown', { presses, target });
    if (reason === 'send-failed') return say('commands.mode-cycle-key-lost.mode-unknown', { presses, target });
    return say('commands.mode-cycle-exhausted.mode-unknown', { target, presses });
  }
  const mode = modeName(current);
  if (reason === 'busy') return say('commands.mode-cycle-busy', { presses, mode, target });
  if (reason === 'unknown') return say('commands.mode-cycle-no-footer', { presses, mode, target });
  if (reason === 'send-failed') return say('commands.mode-cycle-key-lost', { presses, mode, target });
  return say('commands.mode-cycle-exhausted', { target, presses, mode });
}
