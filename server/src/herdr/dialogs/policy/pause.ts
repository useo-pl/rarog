/**
 * Pauza „Session paused” po fladze zabezpieczeń modelu: jedyny dialog, na który driver nie wysyła `escape`.
 * Esc zmierzono tylko na pauzie wywołanej atrapą API (CLI 2.1.322, `kontrolny/pauza-2.1.322.txt`), a pauza nie ma
 * stopki, która by go nazywała, więc odmowa zostaje.
 */
import type { TerminalDialogId } from './terminal.ts';
import type { ScreenDialog } from '../screen/parse.ts';
import { SCREEN_SIGNATURES } from '../screen/signatures.ts';

/** Pauza po fladze zabezpieczeń — jedyny dialog listy, na który driver nie wysyła `escape`. */
export const SESSION_PAUSED_DIALOG: TerminalDialogId = 'session-paused-safeguards';

const SESSION_PAUSED_TITLE_PATTERN = SCREEN_SIGNATURES.sessionPausedTitle.pattern;
const SESSION_PAUSED_RETRY_PATTERN = SCREEN_SIGNATURES.sessionPausedRetryOption.pattern;

/**
 * Czy to pauza „Session paused" — dowolny wariant, także spoza listy terminalowej.
 *
 * Szersze niż {@link matchTerminalDialog}, bo służy odmowie `escape`, nie budowie karty: zmierzona pauza nie ma
 * stopki z Esc, a skutek Esc zmierzono tylko na pauzie z atrapy API, więc odmowa obejmuje KAŻDĄ pauzę o tym tytule,
 * także z innym kompletem opcji. Wystarcza tytuł regionu za kreską
 * albo opcja „Edit prompt and retry with …" (pauza z tytułem nad krawędzią panelu, region bez kreski).
 */
export function sessionPausedDialog(dialog: ScreenDialog): boolean {
  return dialog.terminalDialog === SESSION_PAUSED_DIALOG
    || (dialog.title !== null && SESSION_PAUSED_TITLE_PATTERN.test(dialog.title))
    || dialog.options.some((option) => SESSION_PAUSED_RETRY_PATTERN.test(option.label));
}
