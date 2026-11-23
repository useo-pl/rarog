/**
 * Zatwierdzenie dialogu zaufania folderu bez cyfr (wyjątek od zakazu wyboru po pozycji, na wzór formularza z preview) — JEDYNE miejsce w Rarogu, które
 * zna klawisz `down`, i jedyna ścieżka poza formularzem z preview, która wysyła `enter`.
 *
 * Sekwencja: świeży odczyt z `❯` na „No” → `down` → drugi świeży odczyt z `❯` na „Yes” → `enter`. Przed każdym
 * klawiszem ten sam dowód: dialog zaufania w pełnym renderze, odcisk bloku i folder jak na karcie, folder równy `cwd`
 * sesji. Odczyt z `❯` już na „Yes” (ponowne tapnięcie po samym `down`) daje sam `enter`.
 *
 * Granice modułu (wszystkie świadome):
 *
 * - **`down` i `enter` NIE wchodzą do `ALLOWED_KEYS`** (`keys.ts`): wybór po pozycji dla każdej ścieżki naraz to
 *   dokładnie to, czego Rarog nie robi nigdy. Tu jest osobna lista dwóch klawiszy, osobna asercja jednego klawisza na
 *   wywołanie i osobna metoda klienta (`sendTrustStep`).
 * - **Nigdy `escape`**: Esc w tym dialogu kończy proces `claude`, więc ścieżka zatwierdzenia go nie zna.
 * - **Bez ponowień**: każda odmowa dowodu i każdy błąd wysyłki kończą ścieżkę bez dalszego klawisza.
 *
 * Moduł jest CZYSTY (bez I/O): decyzję podejmuje na tekście ekranu, wysyła driver.
 */
import { say } from '@rarog/shared/sentences';
import { parseTrustArrowDialog, trustFolderIs } from '../screen/trust-arrow.ts';
import type { TrustArrowDialog } from '../screen/trust-arrow.ts';
import { HerdrKeyNotAllowedError } from './keys.ts';

/** Klawisz kroku 2: przenosi `❯` z „No” na „Yes”. */
export const TRUST_DOWN_KEY = 'down';
/** Klawisz kroku 4: zatwierdza „Yes” (ta sama nazwa herdr co w `form-submit.ts`). */
export const TRUST_ENTER_KEY = 'enter';

/** Klawisze tej ścieżki — zamknięta lista dwóch elementów. */
export const TRUST_STEP_KEYS: readonly string[] = [TRUST_DOWN_KEY, TRUST_ENTER_KEY];

export type TrustStepKey = typeof TRUST_DOWN_KEY | typeof TRUST_ENTER_KEY;

/**
 * Asercja ścieżki zaufania: DOKŁADNIE jeden klawisz z {@link TRUST_STEP_KEYS} na wywołanie.
 *
 * @throws {HerdrKeyNotAllowedError} gdy tablica ma inną długość niż 1 albo klawisz spoza listy
 */
export function assertTrustStepKeys(keys: readonly string[]): void {
  const key = keys[0];
  if (keys.length !== 1 || key === undefined || !TRUST_STEP_KEYS.includes(key)) {
    throw new HerdrKeyNotAllowedError(
      say('dialogs.key-not-allowed', { key: keys.join(', '), allowed: TRUST_STEP_KEYS.join(', ') }),
    );
  }
}

/** Czego dowodzimy przed klawiszem: ten sam dialog, ten sam folder, folder sesji. */
export interface TrustStepExpectation {
  /** Odcisk bloku z karty ({@link TrustArrowDialog.bodyPrint}). */
  readonly bodyPrint: string;
  /** Folder z karty. */
  readonly folder: string;
  /** `cwd` sesji. */
  readonly cwd: string;
  /** Katalog domowy serwera (rozwinięcie `~`). */
  readonly home: string;
  /** `false` po wysłanym `down`: wtedy wolno już tylko `enter`, drugiego `down` nie ma. */
  readonly allowDown: boolean;
}

export type TrustStepVerdict =
  | { ok: true; key: TrustStepKey; dialog: TrustArrowDialog }
  | {
    ok: false;
    reason:
      /** Ekran nie pokazuje dialogu zaufania w pełnym renderze (zniknął, trzy opcje, ucięty render). */
      | 'not-trust'
      /** Inny odcisk bloku: treść dialogu zmieniła się od karty. */
      | 'print'
      /** Folder inny niż na karcie albo inny niż `cwd` sesji. */
      | 'folder'
      /** `❯` dalej na „No” po wysłanym `down`. */
      | 'cursor';
  };

/** Następny klawisz ścieżki zaufania albo odmowa — dowód ze świeżego ekranu. */
export function nextTrustStep(screenText: string | null, expected: TrustStepExpectation): TrustStepVerdict {
  const dialog = screenText === null ? null : parseTrustArrowDialog(screenText);
  if (dialog === null) return { ok: false, reason: 'not-trust' };
  if (dialog.bodyPrint !== expected.bodyPrint) return { ok: false, reason: 'print' };
  if (dialog.folder !== expected.folder || !trustFolderIs(dialog.folder, expected.cwd, expected.home)) {
    return { ok: false, reason: 'folder' };
  }
  if (dialog.cursor === 'yes') return { ok: true, key: TRUST_ENTER_KEY, dialog };
  return expected.allowDown ? { ok: true, key: TRUST_DOWN_KEY, dialog } : { ok: false, reason: 'cursor' };
}
