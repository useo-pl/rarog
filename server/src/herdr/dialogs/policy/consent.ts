/**
 * Dialogi ZGODY CLI, które stają poza blokadą herdr: Rarog ich nigdy nie zatwierdza, a wysyłka do panelu
 * czeka, dopóki dialog stoi.
 */
import { SCREEN_SIGNATURES } from '../screen/signatures.ts';
import { stripTerminalControl } from '../screen/text.ts';

/**
 * Dialogi ZGODY CLI, których herdr nie klasyfikuje jako blokady.
 *
 * „Teach auto mode about your environment?" staje po zakończonej turze, panel jest dla herdr
 * `idle`, a wszystko, co Rarog wtedy wpisze, CLI kolejkuje za dialogiem i wypuszcza po jego
 * zamknięciu (zmierzone: dwie sesje, cztery wysyłki, wszystkie „utknęły" i wszystkie
 * wyszły po zgodzie przy biurku). Skutkiem tego dialogu jest zgoda na skanowanie sesji,
 * historii powłoki i innych repozytoriów — klasa eskalacji, więc Rarog go NIGDY nie
 * zatwierdza: karta bez „Zatwierdź", z „Odrzuć (Esc)", a wysyłka jest wstrzymana, dopóki
 * dialog stoi. Lista jest ZAMKNIĘTA, dopasowanie po nagłówku z rejestru sygnatur — ogólny
 * detektor „coś stoi na ekranie" blokowałby wysyłki na echach i listach ze scrollbacku.
 */
export const SCREEN_CONSENT_DIALOGS = [
  { id: 'auto-mode-teach', match: SCREEN_SIGNATURES.consentDialogAutoMode.pattern },
] as const;

export type ScreenConsentDialogId = (typeof SCREEN_CONSENT_DIALOGS)[number]['id'];

/** Który dialog zgody z {@link SCREEN_CONSENT_DIALOGS} stoi na ekranie — albo `null`. */
export function standingConsentDialog(text: string): ScreenConsentDialogId | null {
  for (const dialog of SCREEN_CONSENT_DIALOGS) {
    if (dialog.match.test(stripTerminalControl(text))) return dialog.id;
  }
  return null;
}
