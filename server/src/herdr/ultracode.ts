/**
 * Słowa Claude Code o ultracode i czytnik jego śladu w pliku rozmowy — obok form komendy
 * (`ULTRACODE_COMMANDS` w `herdr/commands/registry.ts`) JEDYNE miejsce w `server/src/**`, w którym stoją: wartość
 * flagi startu, wersja minimalna CLI, nazwy załączników pliku rozmowy, początki wyniku komendy i jej odmowy.
 *
 * Ultracode to ustawienie sesji CLI, nie poziom effortu: Claude planuje workflow przy każdym większym zadaniu,
 * na poziomie, na którym sesja chodzi. Dowody (`docs/distribution.md`, „What the repo knows about Claude Code”; plik
 * dowodu `EVIDENCE.ultracode` rejestru komend):
 *
 * - klasa (a), docs `model-config`, „Adjust effort level”: `--effort ultracode` włącza ultracode i ustawia poziom
 *   `xhigh` (od 2.1.203); `/effort ultracode` i `/effort ultracode off` przełączają je bez zmiany poziomu, a forma
 *   `off`, przełącznik w suwaku i ultracode na poziomie innym niż `xhigh` wymagają 2.1.284;
 * - klasa (b), pomiar na żywym CLI 2.1.317 w izolacji (wycinki `server/test/fixtures/herdr/ultracode/`):
 *   PIERWSZA tura człowieka po włączeniu zaczyna się załącznikiem `ultra_effort_enter`, po wyłączeniu
 *   `ultra_effort_exit`, oba z `timestamp`; kolejne tury nie mają żadnego. Komenda w bezczynności zapisuje wpis
 *   `user` z wynikiem w `<local-command-stdout>` („Ultracode on (this session only): …”, „Ultracode off. …”);
 *   komenda w trakcie tury nie zapisuje nic, ślad daje dopiero załącznik następnej tury.
 *
 * Tu stoją SŁOWA, jednowpisowy czytnik ({@link ultracodeMarkerOf}) i czytnik tekstu wyniku komendy
 * ({@link ultracodeResultOf}, ten sam dla pliku rozmowy i ekranu panelu). Reguły stanu karty (które znaczniki się
 * liczą, od kiedy, co znaczy ich brak) należą do czytelnika pliku rozmowy. Strażnik granicy:
 * `server/test/ultracode-boundary.test.ts`.
 */
import { asRecord } from '../drivers/tool-text.ts';
import { TRANSCRIPT_TAGS } from './commands/registry.ts';
import { stripTerminalControl } from './dialogs/screen/text.ts';

/** Wartość flagi `--effort`, która startuje sesję z ultracode (i poziomem `xhigh`). Docs, od 2.1.203. */
export const ULTRACODE_FLAG_VALUE = 'ultracode';

/**
 * Najniższa wersja CLI, na której Rarog przełącza ultracode: forma `off` i ultracode na poziomie innym niż `xhigh`
 * istnieją od niej (docs). Starsze CLI przy wyborze poziomu wyłączało ultracode.
 */
export const ULTRACODE_MIN_CLI = '2.1.284';

/** Typy załączników (`type: "attachment"`, pole `attachment.type`) na początku pierwszej tury po geście. */
export const ULTRACODE_ATTACHMENTS = {
  enter: 'ultra_effort_enter',
  exit: 'ultra_effort_exit',
} as const;

/**
 * Początki wyniku komendy w `<local-command-stdout>`: dalszą część zdania (poziom effortu, dopisek o sesji) CLI
 * wolno przeredagować. Odmowa przy niedostępnym ultracode („Ultracode needs dynamic workflows …”) ani wynik
 * `/effort status` żadnym z nich się nie zaczynają.
 */
export const ULTRACODE_RESULT = {
  on: 'Ultracode on',
  off: 'Ultracode off',
} as const;

/**
 * Początek odmowy komendy, gdy ultracode jest niedostępne (pomiar 2.1.317 z wyłączonymi workflow dynamicznymi):
 * „Ultracode needs dynamic workflows enabled (see /config). …”. CLI pisze ją w miejscu wyniku komendy, w pliku
 * rozmowy w `<local-command-stdout>`. Stanu ultracode nie zmienia, więc nie jest znacznikiem.
 */
export const ULTRACODE_REFUSAL = 'Ultracode needs dynamic workflows';

/** Ślad ultracode w jednym wpisie pliku rozmowy. */
export interface UltracodeMarker {
  /** Stan, który wpis potwierdza. */
  readonly value: boolean;
  /** `timestamp` wpisu w milisekundach; `null`, gdy wpis go nie ma albo nie da się go odczytać. */
  readonly at: number | null;
}

const STDOUT = new RegExp(`^\\s*<${TRANSCRIPT_TAGS.stdout}>([\\s\\S]*?)</${TRANSCRIPT_TAGS.stdout}>\\s*$`);

/** Tekst zaczyna się słowami `prefix`, po których nie stoi litera ani cyfra („Ultracode one” nie jest „on”). */
function startsWithWords(text: string, prefix: string): boolean {
  return text.startsWith(prefix) && !/^[\p{L}\p{N}]/u.test(text.slice(prefix.length));
}

/**
 * Wynik komendy ultracode z jego tekstu: treść `<local-command-stdout>` albo wiersz wyniku na ekranie bez znaku
 * `⎿`. `true` i `false` to stan, który komenda ustawiła ({@link ULTRACODE_RESULT}), `'refused'` to odmowa przy
 * niedostępnym ultracode ({@link ULTRACODE_REFUSAL}), `null` każdy inny tekst (np. wynik `/effort status`).
 */
export function ultracodeResultOf(text: string): boolean | 'refused' | null {
  const result = stripTerminalControl(text).trim();
  if (startsWithWords(result, ULTRACODE_RESULT.on)) return true;
  if (startsWithWords(result, ULTRACODE_RESULT.off)) return false;
  if (startsWithWords(result, ULTRACODE_REFUSAL)) return 'refused';
  return null;
}

function timeOf(entry: Record<string, unknown>): number | null {
  const raw = entry['timestamp'];
  if (typeof raw !== 'string') return null;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : at;
}

/** Tekst wpisu `user`: napis albo bloki tekstu (`message.content`); inna treść = brak tekstu. */
function userTextOf(entry: Record<string, unknown>): string | null {
  const message = asRecord(entry['message']);
  const content = message === null ? null : message['content'];
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const item of content) {
    const block = asRecord(item);
    if (block === null || block['type'] !== 'text' || typeof block['text'] !== 'string') return null;
    parts.push(block['text']);
  }
  return parts.join('');
}

/**
 * Ślad ultracode w JEDNYM sparsowanym wpisie pliku rozmowy albo `null`.
 *
 * - załącznik `ultra_effort_enter` (każdy `reminderType`) → `true`, `ultra_effort_exit` → `false`;
 * - wpis `user`, którego cała treść to `<local-command-stdout>` zaczynający się od {@link ULTRACODE_RESULT} →
 *   ta wartość. Liczy się WYNIK, nie argumenty komendy (`<command-args>ultracode off</command-args>` stoi też
 *   przy komendzie anulowanej albo odrzuconej);
 * - wpis subagenta (`isSidechain`), wpis `isMeta` i prompt człowieka (pole `origin`; wpisy wyniku komendy go nie
 *   mają) → `null`: prompt przepisujący słowa wyniku nie jest dowodem.
 *
 * Czas: `timestamp` wpisu (pomiar: każdy załącznik `ultra_effort_*` go ma), żeby wołający mógł odciąć historię
 * sprzed startu procesu CLI.
 */
export function ultracodeMarkerOf(value: unknown): UltracodeMarker | null {
  const entry = asRecord(value);
  if (entry === null || entry['isSidechain'] === true) return null;

  if (entry['type'] === 'attachment') {
    const attachment = asRecord(entry['attachment']);
    const kind = attachment === null ? null : attachment['type'];
    if (kind === ULTRACODE_ATTACHMENTS.enter) return { value: true, at: timeOf(entry) };
    if (kind === ULTRACODE_ATTACHMENTS.exit) return { value: false, at: timeOf(entry) };
    return null;
  }

  if (entry['type'] !== 'user' || entry['isMeta'] === true || entry['origin'] !== undefined) return null;
  const text = userTextOf(entry);
  const stdout = text === null ? null : STDOUT.exec(text)?.[1];
  if (stdout === undefined || stdout === null) return null;
  const result = ultracodeResultOf(stdout);
  return typeof result === 'boolean' ? { value: result, at: timeOf(entry) } : null;
}
