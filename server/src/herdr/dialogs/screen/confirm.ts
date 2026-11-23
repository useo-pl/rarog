/**
 * Dialog POTWIERDZENIA ustawień CLI rozpoznany po kształcie (klasa `confirm`): sufit treści, zamknięta lista zdań
 * bez pytajnika i `confirmFrom` z warunkami fail-closed.
 */
import { contentEscalates } from '../policy/escalation.ts';
import { TERMINAL_DIALOG_MAX_CHARS, matchTerminalDialog } from '../policy/terminal.ts';
import type { TerminalDialogId } from '../policy/terminal.ts';
import { regionCallTrace } from './block.ts';
import { questionFrom } from './form.ts';
import { optionsCloseRegion } from './options.ts';
import type { ScreenOption } from './options.ts';
import { SCREEN_SIGNATURES } from './signatures.ts';

/**
 * Twardy sufit treści dialogu potwierdzenia.
 *
 * Zmierzony dialog („Switch model?" + dwa zdania o cache'u) ma ~250 znaków. Region dłuższy niż
 * ten sufit to niemal na pewno scrollback, który wjechał w kandydata — a karta potwierdzenia
 * z cudzą rozmową w treści łamałaby regułę „The screen does not leak beyond SSE” (`docs/security-model.md`, „herdr sessions: Rarog writes to a terminal it does not own”, pkt 11). Fail-closed: za długi = to nie jest `confirm`.
 */
export const CONFIRM_QUESTION_MAX_CHARS = 600;

/** Potwierdzenia CLI bez pytajnika w nagłówku — zamknięta lista, patrz punkt 4 w `confirmFrom`. */
const CONFIRM_STATEMENT_PATTERN = SCREEN_SIGNATURES.confirmStatement.pattern;

/**
 * Dialog POTWIERDZENIA ustawień CLI rozpoznany po kształcie — trzon uniwersalnego silnika
 * dialogów (zgłoszenie: nieobsłużony „Change effort level?" po `/effort`).
 *
 * Zamiast zamkniętej listy sygnatur per dialog („Switch model?", „Change effort level?", …)
 * rozpoznajemy KSZTAŁT wspólny całej klasy potwierdzeń Claude Code, każdy warunek fail-closed:
 *
 * 1. region jest ODGRODZONY kreską (`bounded` — pilnuje wołający): treść nad opcjami należy
 *    do dialogu, nie do scrollbacku;
 * 2. zero śladów wywołania narzędzia w regionie (`regionCallTrace`: linia `⏺ Narzędzie(…)`, tytuł
 *    zgody, `Ask rule`) — wywołanie znaczy „to zgoda na narzędzie albo scrollback", nigdy
 *    potwierdzenie ustawień;
 * 3. opcje stoją na SAMYM DOLE regionu — tekst pod ostatnią opcją znaczy, że lista cyfr
 *    pochodzi ze scrollbacku, a prawdziwy dialog (może nieczytelny) stoi niżej. Wyjątkiem
 *    jest STOPKA klawiszowa CLI (`FORM_CHROME_PATTERN`, np. „Enter to confirm · Esc
 *    to cancel"): to chrome dialogu, nie treść — dialog wznowienia starej sesji rysuje ją pod
 *    opcjami i bez wyjątku kończyłby jako `other`;
 * 4. treść zawiera pytajnik i mieści się w sufit — nagłówki potwierdzeń CLI to pytania.
 *    Pytajnika nie ma dialog „This session is … old and … tokens." (`--resume` sesji sprzed
 *    dni, CLI 2.1.258, fixture `dialog-resume-summary-2.1.258.txt`): wpuszcza go ZAMKNIĘTA
 *    sygnatura `confirmStatement`, nie poluzowanie reguły — zdanie bez pytajnika nad listą
 *    cyfr to w scrollbacku codzienność. Drugą zamkniętą furtką jest lista {@link TERMINAL_DIALOGS}:
 *    tytuł w PIERWSZEJ linii regionu i komplet opcji; taki dialog ma własny,
 *    wyższy sufit treści ({@link TERMINAL_DIALOG_MAX_CHARS}), tytuł idzie do `header`, a każda
 *    jego opcja dostaje w `resolveOptions` flagę `terminalOnly`;
 * 5. zero markerów eskalacji uprawnień (patrz `ESCALATION_MARKER_PATTERN`).
 *
 * Wynik jedzie na kartę DOSŁOWNIE: treść + etykiety opcji bez żadnej interpretacji, a wybór
 * wraca po tekście etykiety. To jest granica między tym silnikiem a regułą z `docs/security-model.md`, „Starting sessions from the phone: three powers”, pkt 14: Rarog niczego
 * nie dopowiada i nie wybiera — pokazuje dokładnie to, co widzi terminal.
 *
 * @param options opcje regionu z etykietami sklejonymi jak w potwierdzeniu — dla listy terminalowej
 * @param optionsAt index of the first option line in `region` (`questionFrom`): a numbered list in the body above the
 *   options stays in the text, and the length limit counts it
 */
export function confirmFrom(
  region: readonly string[], options: readonly ScreenOption[], optionsAt: number,
): { header: string; question: string; terminalDialog: TerminalDialogId | null } | null {
  if (regionCallTrace(region)) return null;
  if (!optionsCloseRegion(region)) return null;
  const form = questionFrom(region, optionsAt);
  if (form === null) return null;
  const [title = '', ...body] = form.question.split('\n');
  const terminalDialog = matchTerminalDialog(title, options);
  if (terminalDialog === null) {
    if (!form.question.includes('?') && !CONFIRM_STATEMENT_PATTERN.test(form.question)) return null;
    if (form.question.length > CONFIRM_QUESTION_MAX_CHARS) return null;
  } else if (form.question.length > TERMINAL_DIALOG_MAX_CHARS) {
    return null;
  }
  // TREŚĆ z markerem eskalacji = potwierdzenie, którego skutkiem jest rozszerzenie uprawnień
  // — bez karty. Etykiety opcji są z tego testu WYŁĄCZONE (patrz `contentEscalates`): opcję
  // eskalującą flaguje per-opcja `optionEscalates`, nie ubija cała karta.
  if (contentEscalates(region)) return null;
  return terminalDialog === null
    ? { ...form, terminalDialog: null }
    : { header: title, question: body.join('\n').trim(), terminalDialog };
}
