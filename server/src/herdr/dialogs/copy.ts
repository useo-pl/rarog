/**
 * Zdania dla człowieka o dialogach: odmowy i notki do transkryptu, treść kart bez przycisków.
 *
 * Kiedy które zdanie pada, rozstrzygają fasada drivera i budowniczowie kart; tu stoi wyłącznie jego
 * brzmienie, żeby jedno zdanie nie miało dwóch wersji w dwóch plikach.
 */
import { say } from '@rarog/shared/sentences';
import type { SentenceCode, ServerSentence } from '@rarog/shared/sentences';
import { foldWhitespace } from './cross-check.ts';

/** Karta bez cyfr: Rarog nie wie, którą opcję zatwierdza, więc nie zatwierdza żadnej. */
export const NO_DIGIT_MESSAGE = say('dialogs.no-digit');
/** Wielokrotny wybór: router odrzuca to wcześniej (409), tutaj druga, cichsza bramka. */
export const MULTI_SELECT_MESSAGE = say('dialogs.multi-select');
/** Karta bez odpowiedzi na pytanie, które stoi na ekranie — nie wielokrotny wybór. */
export const NO_ANSWER_ON_SCREEN_MESSAGE = say('dialogs.no-answer-on-screen');
/** Opcja eskalująca uprawnienia — widoczna na karcie, ale wybieralna tylko przy biurku (`docs/dialogs.md`, „Rules: what must not be relaxed”). */
export const TERMINAL_ONLY_MESSAGE = say('dialogs.terminal-only');
/**
 * Karta dialogu z listy `TERMINAL_DIALOGS`: pokazuje cały dialog, ale żadnej jego opcji
 * nie wybiera — także wtedy, gdy stary klient narysuje przycisk mimo `terminalOnly`.
 */
export const TERMINAL_DIALOG_MESSAGE = say('dialogs.terminal-dialog');
/**
 * Esc na pauzie „Session paused": skutek klawisza nie jest zmierzony, a pauzy nie wolno wywołać
 * celowo, żeby go zmierzyć (mechanizm bezpieczeństwa modelu) — driver go więc nie wysyła.
 */
export const PAUSE_ESCAPE_MESSAGE = say('dialogs.pause-escape');
/** Odpowiedź z nieświeżej karty: dialog na ekranie jest już inny niż ten, w który tapnięto. */
export const STALE_DECISION_MESSAGE = say('dialogs.stale-decision');
/**
 * Ekran rozjechał się z kartą MIĘDZY jej powstaniem a tapnięciem.
 *
 * Osobna wiadomość od `STALE_DECISION_MESSAGE`: tamta mówi o decyzji adresującej inny dialog
 * (rozjazd `reqId`), ta o karcie, która adresowała właściwy dialog, ale panel zdążył go
 * przemalować, zanim cyfra wyszła z kolejki.
 */
export const SCREEN_CHANGED_MESSAGE = say('dialogs.screen-changed');
/**
 * Notatka a karta bez kanału hooka: notatkę dowozi WYŁĄCZNIE plik odpowiedzi
 * (`annotations`), a cyfra by ją zgubiła — więc nic nie wychodzi.
 */
export const NOTE_NO_CHANNEL_MESSAGE = say('dialogs.note-no-channel');
/** Notatki nie da się przypiąć do wyboru (pytanie jej nie przyjmuje albo wybór spoza listy). */
export const NOTE_NOT_ALLOWED_MESSAGE = say('dialogs.note-not-allowed');
/** Plik odpowiedzi z notatką nie powstał (killswitch, dysk) — nic nie wyszło. */
export const NOTE_WRITE_FAILED_MESSAGE = say('dialogs.note-write-failed');

/**
 * Hook nie odebrał pliku z notatką (timeout hooka albo decyzja przy biurku)
 *
 * Cyfra dowiozłaby sam wybór, więc nie idzie. Treść notatki CYTUJEMY W CAŁOŚCI: karta odbuduje
 * się zaraz na torze cyfry (kanał tego zrzutu jest martwy) już bez pola notatki, a razem ze starą
 * kartą znika szkic w kliencie — transkrypt jest jedynym miejscem, z którego człowiek przepisze
 * notatkę do terminala. Bez przycinania (ucięta końcówka by przepadła);
 * długość ogranicza manager (≤ 8192 na notatkę, ≤ 32768 razem z odpowiedziami).
 */
export function noteNotDeliveredMessage(notes: readonly string[]): ServerSentence {
  return say('dialogs.note-not-delivered', { notes: notes.join('\n') });
}

/** Treść karty, której Rarog nie rozumie na tyle, żeby cokolwiek zatwierdzić. */
export const DEGRADED_DISPLAY_TEXT = say('dialogs.degraded-display');

/**
 * Treść karty bez przycisków, gdy na ekranie nie dało się przeczytać opcji dialogu.
 * Najczęstsza przyczyna to widok Claude Code (`tui: fullscreen`) przewinięty w górę
 * w terminalu — dialog stoi wtedy pod krawędzią ekranu. Zdanie mówi „jeśli", bo `unreadable` ma też
 * inne źródła (przemalowanie TUI, nowy wygląd CLI); karta odżywa sama, gdy dialog wróci na ekran.
 */
export const DEGRADED_UNREADABLE_TEXT = say('dialogs.degraded-unreadable');

/**
 * Dialog zniknął (albo kartę podmieniono) MIĘDZY cyfrą a enterem — najpewniej rozstrzygnęła
 * go własna cyfra albo ktoś przy biurku. Cyfra POSZŁA, więc „nic nie wysłałem" byłoby
 * kłamstwem — mówimy dokładnie tyle, ile wiemy.
 */
export const FORM_SUBMIT_GONE_MESSAGE = say('dialogs.form-submit-gone');

/**
 * Kanał hooka nie odebrał pliku, a karta niosła KILKA pytań.
 *
 * Cyfra dowozi wyłącznie pytanie stojące na ekranie, więc milczenie byłoby kłamstwem przez
 * przemilczenie: człowiek zaznaczył komplet odpowiedzi i ma prawo wiedzieć, że pojechała
 * jedna, a reszta wróci osobnymi kartami. Pytanie NAZYWAMY, bo tą jedną nie musi być
 * pierwsze z karty — cyfra zamyka zakładkę stojącą na ekranie.
 */
export function hookAnswerPartialMessage(question: string): ServerSentence {
  const folded = foldWhitespace(question);
  const short = folded.length > 80 ? `${folded.slice(0, 79)}…` : folded;
  return say('dialogs.hook-answer-partial', { question: short });
}

/** Powód odmowy weryfikacji → podzdanie z rejestru (argument `reason:code` zdania wspólnego). */
const FORM_SUBMIT_ABORT_REASONS = {
  'notes-editing': 'dialogs.submit-abort.notes-editing',
  'question-changed': 'dialogs.submit-abort.question-changed',
  'not-a-form': 'dialogs.submit-abort.not-a-form',
  'no-single-highlight': 'dialogs.submit-abort.option-unconfirmed',
  'wrong-option': 'dialogs.submit-abort.option-unconfirmed',
} as const satisfies Record<string, SentenceCode>;

/** Powód odmowy weryfikacji → zdanie dla człowieka. Wspólny trzon, konkret z powodu. */
export function formSubmitAbortMessage(reason: keyof typeof FORM_SUBMIT_ABORT_REASONS): ServerSentence {
  return say('dialogs.form-submit-abort', { reason: FORM_SUBMIT_ABORT_REASONS[reason] });
}
