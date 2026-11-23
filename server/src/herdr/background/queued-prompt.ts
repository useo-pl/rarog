/**
 * Prompt CZŁOWIEKA wchłonięty w trwającą turę — rozpoznanie nośnika. CZYSTE.
 *
 * Prompt, który przychodzi, gdy agent pracuje, Claude Code wchłania w tę turę. W pliku rozmowy
 * zostaje po nim kolejka (`enqueue`, potem `remove` z powodem „wchłonięty w trakcie tury") i JEDEN
 * wpis z treścią: załącznik kolejki, ten sam nośnik, którym jadą meldunki o zadaniach w tle.
 * Zwykłego wpisu `user` nie ma. Zmierzone na plikach sesji tego projektu (CLI
 * 2.1.267–2.1.296): 112 takich promptów w 32 plikach; jedyny, obok którego stał wpis `user`
 * o tym samym tekście, był drugą, osobną wysyłką tego samego słowa 7 s później.
 *
 * To nie jest zadanie w tle. Moduł stoi w tym katalogu, bo nośnik i jego słowa należą do rejestru
 * `cli-shapes.ts` (`notificationCarriers`, `queuedPrompt`), a parser transkryptu
 * (`transcript-import.ts`) nie ma prawa powtarzać tych literałów.
 *
 * Tym samym nośnikiem jadą trzy różne rzeczy i tylko jedna jest wypowiedzią człowieka:
 *
 * - meldunek o zadaniu: tryb meldunku, pochodzenie `task-notification` albo brak pochodzenia;
 * - wiadomość od subagenta: tryb promptu, ale pochodzenie `peer` (i `isMeta: true`);
 * - prompt człowieka: tryb promptu i pochodzenie `human`. Tylko ten przechodzi.
 *
 * Warunek wymaga DOKŁADNIE tych dwóch wartości: załącznik o pochodzeniu, którego nie zmierzyliśmy,
 * zostaje poza transkryptem. Wpis meta (`isMeta` na wpisie albo w załączniku) też odpada, jak
 * w regule dla wpisu `user`: wśród 112 zmierzonych promptów człowieka nie miał go żaden, a każda
 * z 40 wiadomości od subagentów go niesie. Kierunek awarii jest ten sam co przed tym modułem (wiadomości nie
 * widać), nigdy odwrotny (cudzy tekst jako wypowiedź użytkownika).
 */
import { CLI_SHAPES } from './cli-shapes.ts';

const CARRIERS = CLI_SHAPES.notificationCarriers.literals;
const QUEUED = CLI_SHAPES.queuedPrompt.literals;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Prompt człowieka z załącznika kolejki: surowa treść (napis albo lista bloków) i czas wpisu. */
export interface QueuedHumanPrompt {
  /** Pole `prompt` załącznika tak, jak stoi w pliku: napis albo lista bloków (tekst, obraz). */
  readonly prompt: unknown;
  /** `timestamp` wpisu: chwila wstawienia promptu do kolejki, nie chwila wchłonięcia; `''` = brak. */
  readonly at: string;
}

/**
 * Czy wpis pliku GŁÓWNEGO to prompt człowieka wchłonięty w trwającą turę; `null` = nie.
 * Wpis subagenta (`isSidechain`) odpada: jego plik to nie rozmowa człowieka z agentem.
 */
export function queuedHumanPrompt(value: unknown): QueuedHumanPrompt | null {
  const entry = asRecord(value);
  if (entry === null || entry['type'] !== CARRIERS.attachmentType || entry['isSidechain'] === true) return null;
  const attachment = asRecord(entry[CARRIERS.attachmentField]);
  if (attachment === null || attachment['type'] !== CARRIERS.queuedCommand) return null;
  if (entry['isMeta'] === true || attachment['isMeta'] === true) return null;
  if (attachment[QUEUED.mode] !== QUEUED.prompt) return null;
  if (asRecord(attachment[QUEUED.origin])?.[QUEUED.kind] !== QUEUED.human) return null;
  const at = entry['timestamp'];
  return { prompt: attachment[CARRIERS.queuedText], at: typeof at === 'string' ? at : '' };
}
