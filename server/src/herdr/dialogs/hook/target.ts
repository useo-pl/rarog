/**
 * Adres odpowiedzi w kanale hooka: czy kartę wolno rozstrzygnąć plikiem odpowiedzi, pod
 * jakimi kluczami mapy `answers`, z jakimi notatkami i które pytanie karty stoi teraz na ekranie.
 */
import { ASK_USER_QUESTION_TOOL } from '../../../drivers/tool-summary.ts';
import { canonicalLabel } from '../screen/options.ts';
import type { PendingHookTool } from './dump.ts';
import type { HookAnswerAnnotation } from './answers.ts';
import { HOOK_PERMISSION_REQUEST_EVENT } from './contract.ts';
import { foldWhitespace } from '../cross-check.ts';
import type { HookQuestion } from '../cards/build.ts';

/**
 * Adres odpowiedzi w kanale hooka: gdzie zapisać i pod jakimi kluczami MAPY.
 *
 * Wszystko pochodzi z payloadu hooka, nie z ekranu, i wszystko musi trafić CO DO ZNAKU:
 * `key` jest nazwą pliku, na który czeka śpiący proces hooka (wyznacza go hook — Rarog nie
 * zgaduje), a `questions` to klucze mapy `answers` w `updatedInput` — CLI dopasowuje je do
 * treści pytań z `tool_input`, więc ich KOLEJNOŚĆ jest kolejnością pytań na karcie.
 */
export interface HookAnswerTarget {
  readonly key: string;
  readonly questions: readonly string[];
  /**
   * Etykiety, których Rarog nie wyśle ŻADNYM kanałem (`docs/dialogs.md`, „Rules: what must not be relaxed”) — z całej karty, nie z jednej
   * zakładki. Opcje z EKRANU (`ActiveReq.options`) niosą jedno pytanie naraz; karta z kanału
   * hooka niesie komplet i musi mieć własną listę. Ten sam zbiór z karty dostaje bramka cyfry
   * (`ActiveReq.terminalOnlyLabels`) dla odpowiedzi, która z tej karty trafia na tor cyfry.
   * Etykiety są KANONICZNE (`canonicalLabel`), bo bramka kanału hooka porównuje z nimi
   * kanoniczną postać odpowiedzi: surowa „Always allow ” (spacja na końcu) na liście nie
   * blokowała odpowiedzi, którą bramka sprowadza do „Always allow”. O tym, CZY etykieta trafia na
   * listę, decyduje flaga karty (`payloadCard`: polityka na pełnej etykiecie, bez ucinania), a nie
   * klucz. Do pliku odpowiedzi jedzie odpowiedź z telefonu, nie ta lista.
   */
  readonly blocked: readonly string[];
  /**
   * Adres NOTATEK, per pytanie w kolejności `questions`: etykieta opcji (kanoniczna)
   * → ORYGINAŁ jej podglądu z payloadu albo `null` (opcja bez podglądu). `null` zamiast mapy =
   * pytanie, które notatki nie przyjmuje (wielokrotny wybór albo bez żadnego podglądu).
   *
   * Oryginał, a nie kopia z karty: klient dostaje podgląd przycięty, a CLI oddaje
   * `annotations.preview` modelowi jako `selected preview`.
   */
  readonly notable: readonly (ReadonlyMap<string, string | null> | null)[];
}

/**
 * Adres kanału hooka dla karty pytania — albo `null`, czyli „odpowiadaj cyfrą jak dotąd".
 *
 * Warunki są trzy i każdy jest bramką, nie preferencją:
 *
 * 1. zrzut pochodzi z `PermissionRequest` (a nie z `PreToolUse`) — tylko przy tym zdarzeniu
 *    proces hooka ŻYJE i czeka na plik; `PreToolUse` kończy natychmiast;
 * 2. zrzut dotyczy `AskUserQuestion` — hook nie zwraca `allow` dla żadnego innego narzędzia
 *    (zgody na narzędzia idą tą ścieżką klawiszem);
 * 3. zrzut niesie `answerKey` — czyli pochodzi z hooka, który UMIE czekać (starsza instalacja
 *    pola nie ma i wtedy plik nie miałby czytelnika).
 *
 * Liczba pytań warunkiem nie jest: `allow` domyka CAŁE wywołanie, a karta niesie komplet pytań
 * ze zrzutu, więc i plik odpowiedzi go niesie — domknięcie jest pełne.
 *
 * Klucze mapy i lista zablokowanych etykiet biorą się z TEJ SAMEJ struktury, z której powstała
 * karta ({@link HookQuestion.all}), a nie z drugiego parsowania payloadu: dwa parsowania mogłyby
 * dać dwie różne listy pytań, a wtedy `answers` adresowałoby coś innego, niż widzi człowiek.
 */
export function hookAnswerTargetFor(
  hook: PendingHookTool | null, question: HookQuestion,
): HookAnswerTarget | null {
  if (hook === null) return null;
  // Tylko przy tym zdarzeniu proces hooka ŻYJE i może przyjąć odpowiedź.
  if (hook.hookEventName !== HOOK_PERMISSION_REQUEST_EVENT) return null;
  if (hook.toolName !== ASK_USER_QUESTION_TOOL) return null;
  const key = hook.answerKey;
  if (key === undefined || key === '') return null;
  return {
    key,
    questions: question.all.map((card) => card.question),
    blocked: question.all.flatMap(
      (card) => card.options.filter((o) => o.terminalOnly === true).map((o) => canonicalLabel(o.label)),
    ),
    // Ta sama reguła co `notesEligible` managera: jednokrotny wybór z choć jednym podglądem.
    notable: question.all.map((card) => (
      card.multiSelect || !card.options.some((o) => o.preview !== undefined)
        ? null
        : new Map(card.options.map((o) => [canonicalLabel(o.label), o.preview ?? null]))
    )),
  };
}

/**
 * Notatki do pliku odpowiedzi: DOSŁOWNA treść pytania → `{ notes, preview }`.
 *
 * `preview` to ORYGINAŁ podglądu WYBRANEJ opcji z payloadu ({@link HookAnswerTarget.notable});
 * opcja bez podglądu jedzie samą notatką. `null` = notatki nie da się przypiąć (pytanie jej nie
 * przyjmuje, wybór nie jest jedną opcją z listy, brak treści pytania) — wołający ODMAWIA, bo
 * odpowiedź bez notatki, którą człowiek napisał, byłaby inną odpowiedzią (fail-closed).
 * Brak niepustych notatek = pusty obiekt (plik bez `annotations`).
 */
export function hookAnnotations(
  target: HookAnswerTarget,
  answers: readonly (readonly string[])[],
  notes: readonly (string | null)[],
): Record<string, HookAnswerAnnotation> | null {
  // Słownik BEZ prototypu: kluczem jest treść pytania od autora, a `out['__proto__'] = …` na
  // zwykłym obiekcie przestawiłoby prototyp zamiast dodać notatkę.
  const out = Object.create(null) as Record<string, HookAnswerAnnotation>;
  for (const [index, note] of notes.entries()) {
    if (note === null || note.trim() === '') continue;
    const previews = target.notable[index];
    const question = target.questions[index];
    const group = answers[index] ?? [];
    if (previews === null || previews === undefined || question === undefined) return null;
    if (group.length !== 1) return null;
    const label = canonicalLabel(group[0] ?? '');
    if (!previews.has(label)) return null;
    const preview = previews.get(label) ?? null;
    out[question] = preview === null ? { notes: note } : { notes: note, preview };
  }
  return out;
}

/**
 * Które pytanie karty stoi TERAZ na ekranie?
 *
 * Karta kanału hooka niesie komplet pytań w kolejności PAYLOADU, a `answers` przychodzi
 * w tej samej kolejności — ale ekran pokazuje jedną zakładkę i wcale nie musi to być
 * zakładka pierwsza (człowiek potrafi przełączyć ją przy biurku, bez mignięcia
 * `agent_status`). Fallback cyfrą zamyka WYŁĄCZNIE zakładkę z ekranu, więc bez tego
 * przeliczenia odpowiedź na pytanie 1 zostałaby zapisana jako odpowiedź na pytanie 2:
 * `#digitStillHolds` porównuje samą etykietę i cyfrę, a etykiety sąsiednich pytań kolidują
 * („Tak"/„Polewa").
 *
 * `-1` = pytania z ekranu nie ma na liście karty, czyli nie wiadomo, co wysłać — wołający
 * ma wtedy odmówić, a nie strzelać w indeks 0.
 */
export function screenAnswerIndex(
  target: HookAnswerTarget, screenQuestion: string | undefined,
): number {
  const folded = foldWhitespace(screenQuestion ?? '');
  if (folded === '') return -1;
  return target.questions.findIndex((question) => foldWhitespace(question) === folded);
}
