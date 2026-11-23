/**
 * Powód i kształt odmowy do dziennika (`docs/dialogs.md`, „Refusal diagnostics”): co ekran mówi o dialogu, którego Rarog nie zatwierdzi.
 * Powód z rozpoznania, liczby i flagi z parsera — bez treści i etykiet.
 */
import { parseOptions } from '../screen/parse.ts';
import type { DecisionResolution } from '../screen/resolve.ts';
import type { ScreenDialog } from '../screen/parse.ts';
import type { TerminalDialogId } from '../policy/terminal.ts';
import type { HerdrRefuseReason } from '../../audit.ts';

/**
 * Powód odmowy na ŚCIEŻCE EKRANOWEJ — liczony z tego, co widać, nie z worka (`docs/dialogs.md`, „Refusal diagnostics”).
 *
 * `refuseReasonFor` po przeliczeniu rozpoznania z `expected = null` zawsze oddaje `no-jsonl`,
 * więc ten jeden powód zbierałby trzy różne awarie naraz: ekran nieczytelny, formularz
 * wielokrotnego wyboru i realny dialog spoza transkryptu. Suma odmów nie mówiłaby nic
 * o ROZKŁADZIE, a to on rozstrzyga o etapie drugim bridge'a (warunki etapu drugiego).
 *
 * @param dialog wynik `parseOptions` z JUŻ przeczytanego ekranu; `null` = ekranu nie było
 *        albo się nie sparsował (drugi odczyt też nie pomógł — patrz ponowienie w driverze)
 */
export function screenRefuseReason(dialog: ScreenDialog | null): HerdrRefuseReason {
  if (dialog === null) return 'unreadable';
  // Blok niejednoznaczny to rozjazd ekranu z samym sobą, nie dialog spoza jsonl.
  if (dialog.identity.kind === 'ambiguous') return 'mismatch';
  if (dialog.multiSelect) return 'multi-select';
  return 'no-jsonl';
}

/**
 * KSZTAŁT dialogu na ekranie do dziennika odmów: ile opcji z cyframi i czy nad ramką
 * operacji widać nagłówek. Bez treści i bez etykiet — liczby i flaga z parsera.
 *
 * `headerVisible: null` = dialog bez ramki operacji (MCP, pytanie, plan) albo ekran bez dialogu;
 * `optionCount: 0` = ekran bez ani jednej opcji z cyframi (`parseOptions` → `null`, ta sama klasa,
 * którą ścieżka ekranowa nazywa `unreadable`); `optionCount: null` = ekranu nie było (błąd odczytu).
 * `dialogTitle` = identyfikator dialogu z listy `TERMINAL_DIALOGS`, `null` = dialog spoza niej.
 */
export function dialogShapeOf(
  text: string | null,
): { headerVisible: boolean | null; optionCount: number | null; dialogTitle: TerminalDialogId | null } {
  if (text === null) return { headerVisible: null, optionCount: null, dialogTitle: null };
  const dialog = parseOptions(text);
  return {
    headerVisible: dialog?.operation?.headerVisible ?? null,
    optionCount: dialog?.options.length ?? 0,
    dialogTitle: dialog?.terminalDialog ?? null,
  };
}

/**
 * Rozpoznanie ekranu → powód odmowy w dzienniku.
 *
 * `mismatch` z powodem `multi-select` liczy się jako `multi-select`, a nie jako rozjazd nazwy:
 * to dwie różne awarie i sumowanie ich razem zacierałoby jedyną liczbę, po której widać,
 * czy formularze wielokrotnego wyboru są realnym problemem, czy ciekawostką.
 */
export function refuseReasonFor(resolution: DecisionResolution): HerdrRefuseReason {
  if (resolution.status === 'unreadable') return 'unreadable';
  if (resolution.status === 'mismatch') {
    return resolution.reason === 'multi-select' ? 'multi-select' : 'mismatch';
  }
  return 'no-jsonl';
}
