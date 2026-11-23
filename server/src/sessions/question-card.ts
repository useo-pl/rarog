/**
 * Karta pytania w drodze do klientów — reguły, które manager przykłada do pytań drivera
 * przy budowie ramki `question-pending` (etap B). Czyste funkcje, zero I/O.
 *
 * Driver oddaje pytania z PEŁNYM podglądem opcji (`preview` z payloadu autora — hook albo
 * jsonl), bo oryginał jest mu potrzebny przy odpowiedzi: CLI oddaje `annotations.preview` modelowi
 * jako `selected preview`. Klient dostaje kopię PRZYCIĘTĄ:
 * podgląd bywa całym plikiem kodu, a ramka niesie komplet pytań formularza naraz (i jedzie
 * jeszcze raz w `transcript-snapshot` przy każdym wejściu w sesję).
 */
import type { Question, QuestionOption, QuestionRequest } from '@rarog/shared';
import { MAX_ANSWER_NOTE_CHARS, MAX_ANSWERS_TOTAL_CHARS } from '@rarog/shared/rest';
import { type ServerSentence, say } from '@rarog/shared/sentences';
import { compareCliVersions } from '../cli-version.ts';

/** Sufit podglądu JEDNEJ opcji w ramce, w jednostkach UTF-16 (`string.length`). */
export const QUESTION_PREVIEW_MAX_CHARS = 4_000;

/**
 * Sufit SUMY podglądów jednej ramki. Formularz ma do czterech pytań po kilka opcji — bez
 * drugiego sufitu karta z kompletem podglądów ważyłaby kilkadziesiąt kB przy każdej ramce.
 */
export const QUESTION_PREVIEWS_FRAME_MAX_CHARS = 12_000;

/**
 * Ostatnia linia uciętego podglądu. Bez słów: polszczyzna mieszka w kliencie, a znak
 * nożyczek rysuje tak samo CLI w swojej ramce podglądu („✂ ─── 1 lines hidden", fixture
 * `measured/pytanie-preview-2.1.293.txt`).
 */
export const PREVIEW_CLIP_MARKER = '✂ …';

/**
 * Podgląd przycięty do `max` jednostek RAZEM ze znacznikiem. Cięcie na granicy linii, gdy
 * ta zostawia co najmniej połowę miejsca (blok kodu urwany w pół linii czyta się gorzej),
 * i nigdy w środku pary surogatów (emoji rozcięte na pół to znak zastępczy w kliencie).
 */
export function clipPreview(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = max - PREVIEW_CLIP_MARKER.length - 1;
  if (room <= 0) return PREVIEW_CLIP_MARKER;
  let head = text.slice(0, room);
  const lastBreak = head.lastIndexOf('\n');
  if (lastBreak > room / 2) {
    head = head.slice(0, lastBreak);
  } else {
    const code = head.charCodeAt(head.length - 1);
    if (code >= 0xd800 && code <= 0xdbff) head = head.slice(0, -1);
  }
  return `${head.replace(/\s+$/, '')}\n${PREVIEW_CLIP_MARKER}`;
}

/**
 * Kopia pytań z podglądami przyciętymi do sufitu opcji i ramki — w kolejności pytań i opcji,
 * więc budżet ramki wyczerpują najpierw późniejsze opcje. Opcja, dla której budżetu zabrakło,
 * dostaje sam znacznik: klient pokazuje wtedy, że podgląd jest, ale nie przyjechał, zamiast
 * udawać opcję bez podglądu.
 */
export function clipQuestionPreviews(questions: readonly Question[]): Question[] {
  let budget = QUESTION_PREVIEWS_FRAME_MAX_CHARS;
  return questions.map((question) => ({
    ...question,
    options: question.options.map((option): QuestionOption => {
      if (option.preview === undefined) return option;
      const preview = clipPreview(option.preview, Math.min(QUESTION_PREVIEW_MAX_CHARS, budget));
      budget = Math.max(0, budget - preview.length);
      return { ...option, preview };
    }),
  }));
}

/**
 * Najstarsze wydanie Claude Code, które w pomiarze przyjęło notatki z hooka.
 *
 * 2.1.288 (najstarsze wydanie na dysku w dniu pomiaru) i 2.1.293 przyjęły pole `annotations`
 * w `updatedInput` i oddały notatkę w `tool_result`. Starszych wydań nie dało się zmierzyć, a skutku
 * nieznanego pola na nich nie znamy — poniżej progu pola „Notatka" nie ma wcale (ostrożniej).
 */
export const CLI_NOTES_MIN_VERSION = '2.1.288';

/** Czy proces CLI tej sesji przyjmie notatki — wydanie z rejestru; nieznane = nie (fail-closed). */
export function cliAcceptsNotes(running: string | undefined): boolean {
  return running !== undefined && compareCliVersions(running, CLI_NOTES_MIN_VERSION) >= 0;
}

/**
 * Czy pytanie przyjmuje notatkę: jednokrotny wybór z podglądem — dokładnie tam, gdzie terminal
 * pokazuje „n to add notes". Kanał (plik hooka) i wydanie CLI sprawdza wołający.
 */
export function notesEligible(question: Question): boolean {
  return !question.multiSelect && question.options.some((option) => option.preview !== undefined);
}

/** Pytania karty z polem `notes: true` tam, gdzie wolno; `enabled` = kanał hooka i CLI ≥ progu. */
export function withQuestionNotes(questions: readonly Question[], enabled: boolean): Question[] {
  return questions.map((question) => (
    enabled && notesEligible(question) ? { ...question, notes: true } : question
  ));
}

/** Notatki po sprawdzeniu: `null` = odpowiedź bez notatek; tablica = równoległa do odpowiedzi. */
export type CheckedNotes = { notes: (string | null)[] | null } | { error: ServerSentence };

/**
 * Reguły notatek do odpowiedzi — jedno miejsce, z którego manager oddaje 400.
 *
 * Notatka pusta albo z samych białych znaków to brak notatki (pole zostaje w kliencie). Niepusta
 * wolno WYŁĄCZNIE przy pytaniu z `notes: true` i odpowiedzi będącej JEDNĄ opcją z listy autora
 * (nie wolnym tekstem i nie opcją „tylko w terminalu") — tak samo jak w terminalu, gdzie notatkę
 * dopisuje się klawiszem `n` do podświetlonej opcji. Sufity Raroga (w CLI niezmierzone): notatka
 * ≤ {@link MAX_ANSWER_NOTE_CHARS}, odpowiedzi (sklejone jak w pliku) razem z notatkami
 * ≤ {@link MAX_ANSWERS_TOTAL_CHARS}.
 *
 * Bez karty (`request` brak — pytanie już rozstrzygnięte albo wygasłe) notatek nie oceniamy:
 * `resolveQuestion` odda wtedy uczciwe 409/410 i nic nie pojedzie.
 */
export function checkAnswerNotes(
  request: QuestionRequest | undefined,
  answers: readonly (readonly string[])[],
  notes: readonly (string | null)[] | undefined,
): CheckedNotes {
  if (notes === undefined) return { notes: null };
  if (notes.length > answers.length) return { error: say('session.answer-notes-mismatch') };
  const normalized = answers.map((_group, index) => {
    const note = notes[index] ?? null;
    return note === null || note.trim() === '' ? null : note;
  });
  if (normalized.every((note) => note === null)) return { notes: null };
  if (request === undefined) return { notes: normalized };
  let total = answers.reduce((sum, group) => sum + group.join(', ').length, 0);
  for (const [index, note] of normalized.entries()) {
    if (note === null) continue;
    const question = request.questions[index];
    if (question?.notes !== true) {
      return { error: say('session.answer-note-not-allowed') };
    }
    const group = answers[index] ?? [];
    const option = group.length === 1
      ? question.options.find((candidate) => candidate.label === group[0])
      : undefined;
    if (option === undefined || option.role === 'custom' || option.role === 'exit'
      || option.terminalOnly === true) {
      return {
        error: say('session.answer-note-needs-option'),
      };
    }
    if (note.length > MAX_ANSWER_NOTE_CHARS) {
      return {
        error: say('session.answer-note-too-long', { max: MAX_ANSWER_NOTE_CHARS }),
      };
    }
    total += note.length;
  }
  if (total > MAX_ANSWERS_TOTAL_CHARS) {
    return { error: say('session.answer-notes-too-long') };
  }
  return { notes: normalized };
}
