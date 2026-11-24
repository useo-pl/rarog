/**
 * The one line of a pending decision on the list card (`SessionSummary.waitingFor.text`): the text of a permission
 * request or a question, cut to its first line and to `WAITING_TEXT_MAX` code points. Pure functions; the manager
 * calls them when it builds `waitingFor`.
 */
import { EXIT_PLAN_MODE_TOOL, WAITING_TEXT_MAX } from '@rarog/shared';
import type { PermissionRequest } from '@rarog/shared';
// Ta sama etykieta, którą dostaje wiersz tool-calla w transkrypcie — patrz `decisionText`.
import { summarizeToolInput } from '../drivers/tool-summary.ts';

/**
 * Treść decyzji do JEDNEJ linii karty listy: pierwsza linia, przycięta do `WAITING_TEXT_MAX`.
 *
 * Pierwsza linia, a nie „pierwsze 120 znaków całości": heredoc, wypisana treść `.env` i plan
 * z trzema akapitami mają się tu nie zmieścić Z DEFINICJI. Cięcie po znakach jest wtedy tylko
 * sufitem na długi jednolinijkowiec, a nie jedyną obroną przed wklejeniem pół pliku w sidebar.
 * Wielokropek dokładamy WYŁĄCZNIE tam, gdzie faktycznie uciął — inaczej linia obiecuje ciąg
 * dalszy, którego nie ma.
 */
export function waitingText(raw: string): string {
  const first = raw.split('\n', 1)[0]?.trim() ?? '';
  /*
   * Cięcie po PUNKTACH KODOWYCH, nie po jednostkach UTF-16: `slice(0, 120)` na linii
   * z emoji na 120. znaku rozcina parę surogatów, `trimEnd()` samotnego surogata nie usuwa
   * (to nie biały znak) i na karcie staje „�…". Grafem z modyfikatorem (flaga, odcień skóry)
   * może się tu jeszcze rozpaść na dwa znaki, ale każdy z nich jest wtedy PEŁNY — żaden
   * nie jest połówką kodu, więc przeglądarka rysuje litery, a nie znak zastępczy.
   */
  const points = [...first];
  if (points.length <= WAITING_TEXT_MAX) return first;
  return `${points.slice(0, WAITING_TEXT_MAX).join('').trimEnd()}…`;
}

/**
 * Treść ZGODY do jednej linii karty listy — z `displayText`, ale nie zawsze dosłownie.
 *
 * `displayText` jest jednolinijkowy tylko dla narzędzi z polem `command`. Dla całej reszty
 * (`Edit`, `Write`, `Read`, `Task`, `WebFetch`…) `toolInputText` oddaje pretty-printowany JSON,
 * więc PIERWSZĄ linią jest sama klamra — i karta mówiła „zgoda: Edit · {". Z takiego opisu
 * bierzemy dokładnie to, co bierze etykieta tool-calla w transkrypcie (`summarizeToolInput`:
 * `file_path`, `path`, `pattern`, `url`, `query`), a gdy nie ma czego wziąć — nic: „zgoda: Edit"
 * jest uczciwe, klamra nie. Rozpoznanie idzie po PIERWSZEJ LINII, a nie po `startsWith('{')`,
 * bo komenda Basha też umie zacząć się klamrą (`{ echo a; }` — grupa powłoki).
 *
 * Dwa `displayText` nie są treścią decyzji i tu nie wchodzą wcale:
 *
 * - PLAN (`ExitPlanMode`): treścią jest CAŁY plan, a jego nagłówek („# Plan") nie mówi nic
 *   ponad samo słowo „plan", które karta i tak stawia. Kanał globalny nie ma powodu wozić
 *   danych, których nikt nie rysuje (kontrakt `WaitingFor.text`),
 * - karta ZDEGRADOWANA (`canAllow === false`, `DEGRADED_DISPLAY_TEXT`): tam stoi zdanie
 *   O RAROGU („nie potwierdziłem, czego dotyczy ten dialog"), a nie o decyzji. Powód
 *   degradacji niesie karta sesji (`herdrDialogReason`), nie wiersz listy.
 */
export function decisionText(permission: PermissionRequest): string {
  if (permission.toolName === EXIT_PLAN_MODE_TOOL) return '';
  if (permission.canAllow === false) return '';
  const display = permission.displayText;
  const first = display.split('\n', 1)[0]?.trim() ?? '';
  if (first !== '{' && first !== '{}' && first !== '[') return display;
  let parsed: unknown;
  try {
    parsed = JSON.parse(display);
  } catch {
    // Opis przycięty do 20 kB ma na końcu stopkę, więc nie jest już poprawnym JSON-em.
    return '';
  }
  const summary = summarizeToolInput(permission.toolName, parsed);
  // Bez trafionego klucza `summarizeToolInput` oddaje NAZWĘ narzędzia — a ta stoi już obok.
  return summary === permission.toolName ? '' : summary;
}
