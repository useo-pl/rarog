/**
 * Opis wywołania narzędzia dla CZŁOWIEKA: etykieta w transkrypcie, tekst karty zgody, pytania
 * `AskUserQuestion`. Czyste funkcje, zero I/O, zero zależności od jakiegokolwiek silnika.
 *
 * Dlaczego to jest osobny plik, a nie część `sdk-driver.ts`:
 * te cztery funkcje NIE są częścią integracji z SDK — są częścią warstwy TREŚCI, wspólnej dla
 * każdego źródła rozmowy. Dziś czytają je trzy różne miejsca (transkrypt z magazynu CLI,
 * podgląd panelu herdr na żywo, karta czekającego narzędzia z jsonl), a ścieżki SDK nie ma.
 *
 * Reguła, która jest tu ważniejsza niż kod: **ryzyka NIE liczy się na tych tekstach.** Wszystko
 * poniżej PRZYCINA wejście do prezentacji, a przycięcie mogłoby schować czerwoną frazę przed
 * klasyfikatorem. `classifyRisk` dostaje pełny input przez `toolInputText()` z `tool-text.ts`.
 */
import type { Question } from '@rarog/shared';
import { MAX_DISPLAY_TEXT, asRecord, clipForDisplay, shorten, toolInputText } from './tool-text.ts';
import type { ClippedText } from './tool-text.ts';

/** Narzędzie, którym agent zadaje pytanie z listą opcji (rozpoznajemy po nazwie — spec). */
export const ASK_USER_QUESTION_TOOL = 'AskUserQuestion';

/**
 * Klucze inputu, które niosą „o co właściwie chodzi", w kolejności trafności.
 *
 * Kolejność jest kontraktem, nie gustem: `command` przed `file_path` sprawia, że `Bash` pokazuje
 * komendę, a nie plik, który akurat mignął w argumentach.
 */
const SUMMARY_KEYS = ['command', 'file_path', 'path', 'pattern', 'url', 'query'] as const;

/** Ile znaków etykiety mieści się w jednej linii transkryptu na telefonie. */
export const SUMMARY_MAX_CHARS = 120;

/** Krótka etykieta narzędzia (linia w transkrypcie). */
export function summarizeToolInput(toolName: string, input: unknown): string {
  const record = asRecord(input);
  if (record === null) return toolName;
  for (const key of SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') return shorten(value, SUMMARY_MAX_CHARS);
  }
  return toolName;
}

/**
 * Opis inputu DO POKAZANIA — tekst karty zgody (monospace).
 *
 * Ryzyka NIE liczy się na tym tekście: przycięcie prezentacji nie może chować czerwonej frazy
 * przed klasyfikatorem. Manager sięga po `toolInputText()` (pełny input) — patrz `tool-text.ts`.
 */
export function describeToolInput(toolName: string, input: unknown): ClippedText {
  return clipForDisplay(toolInputText(toolName, input), MAX_DISPLAY_TEXT);
}

/**
 * Wyciąga pytania z inputu narzędzia `AskUserQuestion`.
 *
 * Kształt (`questions[].{question, header, multiSelect, options[].{label, description}}`) jest
 * ten sam w `canUseTool` SDK i w bloku `tool_use` pliku jsonl — potwierdzone na dwóch realnych
 * wywołaniach, więc jedna funkcja obsługuje oba źródła.
 *
 * `options[].preview` jedzie DOSŁOWNIE, bez przycinania: oryginał jest adresem
 * `annotations.preview` w odpowiedzi hookiem (CLI oddaje go modelowi),
 * a kopię dla klientów przycina manager przy budowie ramki (`clipQuestionPreviews`).
 *
 * @returns lista pytań albo `null`, gdy input nie ma spodziewanego kształtu (wtedy traktujemy
 *          wywołanie jak zwykłą prośbę o zgodę — lepiej pokazać kartę zgody niż zgubić turę).
 */
export function parseAskUserQuestionInput(input: unknown): Question[] | null {
  const record = asRecord(input);
  const raw = record?.['questions'];
  if (!Array.isArray(raw)) return null;
  const questions: Question[] = [];
  for (const item of raw) {
    const q = asRecord(item);
    if (q === null) continue;
    const question = typeof q['question'] === 'string' ? q['question'] : '';
    if (question === '') continue;
    const options = Array.isArray(q['options']) ? q['options'] : [];
    questions.push({
      question,
      header: typeof q['header'] === 'string' ? q['header'] : '',
      multiSelect: q['multiSelect'] === true,
      options: options.flatMap((optionRaw): Question['options'] => {
        const option = asRecord(optionRaw);
        const label = option === null ? null : option['label'];
        if (typeof label !== 'string' || label === '') return [];
        const description = option?.['description'];
        const preview = option?.['preview'];
        return [{
          label,
          ...(typeof description === 'string' ? { description } : {}),
          ...(typeof preview === 'string' && preview !== '' ? { preview } : {}),
        }];
      }),
    });
  }
  return questions.length === 0 ? null : questions;
}

/** Najdłuższe podsumowanie, jakie mieści się na karcie sesji `done`. */
const FIRST_SENTENCE_MAX_CHARS = 200;

/** Pierwsze zdanie resulta — na liście sesji `done` mieści się jedna linia. */
export function firstSentence(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed === '') return '';
  const end = trimmed.search(/[.!?](\s|$)/);
  const sentence = end === -1 ? trimmed : trimmed.slice(0, end + 1);
  return sentence.length > FIRST_SENTENCE_MAX_CHARS
    ? `${sentence.slice(0, FIRST_SENTENCE_MAX_CHARS - 1)}…`
    : sentence;
}
