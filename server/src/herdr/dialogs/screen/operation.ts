/**
 * OPERACJA dialogu zgody z ekranu — treść, którą człowiek zatwierdza.
 *
 * Od CLI 2.1.286 dialog zgody rysuje komendę `Bash`, diff `Edit` albo treść `Write` w ramce
 * z przerywanych kresek (`╌╌╌`) pod nagłówkiem („Bash command (unsandboxed)" + opis), a nad
 * pytaniem i opcjami. Operacja wieloliniowa dostaje lewy pasek `│`. Ten moduł wyjmuje ją z ekranu
 * ({@link operationAbove}) i odpowiada na pytanie, na którym stoi tożsamość dialogu `Bash`:
 * czy ramka pokazuje TĘ komendę, którą zna jsonl albo zrzut hooka ({@link commandMatches}).
 *
 * Dlaczego treść, a nie sama nazwa narzędzia: nazwa nie odróżnia dwóch różnych komend `Bash`,
 * a długa komenda w wąskim panelu wypycha nagłówek z nazwą nad krawędź ekranu (zrzut
 * `measured/zgoda-bash-wysoka-2.1.295.txt`; CLI komendy NIE przycina, widać jej koniec).
 *
 * Moduł jest CZYSTY: dostaje linie ekranu po `clean` (bez ANSI, prawostronnie obcięte).
 * Wygląd CLI bierze wyłącznie z rejestru sygnatur. Opis całości: `docs/dialogs.md`.
 */
import { SCREEN_SIGNATURES } from './signatures.ts';

const OPERATION_RULE = SCREEN_SIGNATURES.operationRule.pattern;
const OPERATION_BAR = SCREEN_SIGNATURES.operationBar.pattern;
const DIALOG_TOP_RULE = SCREEN_SIGNATURES.dialogTopRule.pattern;
const OPERATION_MARGIN = SCREEN_SIGNATURES.operationMargin.pattern;

/**
 * Ile linii nad ramką operacji może stać nagłówek dialogu (tytuł, opis, podpowiedź CLI). Tę samą
 * liczbę zna strażnik wysokości w hooku (`scripts/hooks/tall-dialog.mjs`, równość pilnuje test).
 */
export const HEADER_MAX_LINES = 12;

/**
 * Najkrótszy widoczny KONIEC komendy (znaki bez białych), który wolno uznać za dowód tożsamości,
 * gdy początek ramki jest nad krawędzią ekranu. Krótki ogon (`done'`) pasowałby do wielu komend.
 */
export const OPERATION_MIN_SUFFIX_CHARS = 40;

export interface ScreenOperation {
  /** Linie operacji bez paska `│` i bez jednej spacji ramki, prawostronnie obcięte. */
  readonly lines: readonly string[];
  /**
   * The frame rows as the screen read gives them: with the left margin (or bar) and without the right-edge trim of
   * {@link lines}; the read itself already drops trailing spaces and tabs (`trimmedLines`), so a trailing no-break
   * space stays. The file frame proof (`screen/edit-frame.ts`) reads a wrapped file line from them by column.
   */
  readonly rows: readonly string[];
  /**
   * Szerokość treści ramki w kolumnach — ile znaków komendy mieści się w jednej linii. Z niej
   * wynika, czy łamanie linii mogło być zawinięciem, czy musiało być końcem linii komendy.
   */
  readonly width: number;
  /** Width of the frame's bottom rule in columns, which is the width of the pane the CLI drew the dialog for. */
  readonly ruleWidth: number;
  /** Cała ramka widoczna: nad nią stoi górna kreska `╌╌╌`. `false` = początek nad krawędzią ekranu. */
  readonly complete: boolean;
  /** Widać też górną, ciągłą kreskę dialogu (`────`) — nagłówek i opis są na ekranie w całości. */
  readonly headerVisible: boolean;
  /**
   * Linie NAGŁÓWKA dialogu między górną kreską dialogu a górną kreską ramki (tytuł, ścieżka pliku, opis): surowe,
   * z lewym marginesem CLI, bez pustych. Nie przycinamy ich, bo spacja na początku nazwy pliku to inna ścieżka.
   * Pusta lista, gdy nagłówka nie widać w całości (`!complete || !headerVisible`): linie
   * nad uciętym dialogiem to scrollback, nie nagłówek.
   */
  readonly header: readonly string[];
}

/**
 * Szerokość w kolumnach terminala: znaki szerokie (CJK, pełnej szerokości, emoji w prezentacji
 * emoji) zajmują dwie kolumny. Przybliżenie `wcwidth` — wystarczy do rozstrzygania, czy linia
 * ramki jest pełna; pomyłka kończy się odmową, nie złą cyfrą.
 *
 * It counts every other code point as one column, combining marks and format characters too, so it is not a proof
 * of the column where a wrapped line broke. The file frame proof joins a wrapped file line only when each of its
 * characters is on a closed list of characters measured at one column (`FILE_FRAME_GEOMETRY` in
 * `screen/signatures.ts`, CLI 2.1.330).
 */
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{20000}-\u{3FFFD}]|\p{Emoji_Presentation}/u;

export function displayWidth(text: string): number {
  let columns = 0;
  for (const char of text) columns += WIDE.test(char) ? 2 : 1;
  return columns;
}

/**
 * Operacja nad regionem opcji; `null`, gdy dialog nie ma ramki operacji (MCP, pytanie, plan bez
 * ramki) albo kształt nad regionem nie jest ramką.
 *
 * @param lines linie ekranu po `clean`, bez pustych na brzegach (jak w `parseOptions`)
 * @param regionStart indeks pierwszej linii regionu opcji; linia nad nim to dolna kreska ramki
 */
export function operationAbove(lines: readonly string[], regionStart: number): ScreenOperation | null {
  const lower = regionStart - 1;
  const lowerLine = lines[lower];
  if (lowerLine === undefined || !OPERATION_RULE.test(lowerLine.trim())) return null;

  let upper = -1;
  const raw: string[] = [];
  for (let i = lower - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? '';
    if (OPERATION_RULE.test(line.trim())) {
      upper = i;
      break;
    }
    raw.unshift(line);
  }
  if (raw.length === 0) return null;
  const complete = upper !== -1;
  // Ramka ucięta u góry jest zawsze wieloliniowa, więc KAŻDA jej linia ma pasek. Linia bez paska
  // znaczy, że to nie ramka (inny kształt ekranu) — nie zgadujemy, co to jest.
  const barred = raw.every((line) => line.trim() === '' || OPERATION_BAR.test(line));
  if (!complete && !barred) return null;

  const content = raw.map((line) => (barred
    ? line.replace(OPERATION_BAR, '')
    : line.replace(OPERATION_MARGIN, '')).replace(/\s+$/u, ''));
  // Kreska ma szerokość panelu; treść ramki to szerokość minus lewy margines (` │ ` albo ` `)
  // i jedna kolumna z prawej (zmierzone: panel 63 → najdłuższa linia treści 59).
  const ruleWidth = displayWidth(lowerLine.trim());
  const width = Math.max(
    ruleWidth - (barred ? 3 : 1) - 1,
    ...content.map((line) => displayWidth(line)),
  );
  let headerVisible = false;
  let header: string[] = [];
  if (complete) {
    for (let i = upper - 1; i >= 0 && upper - i <= HEADER_MAX_LINES; i -= 1) {
      if (DIALOG_TOP_RULE.test((lines[i] ?? '').trim())) {
        headerVisible = true;
        header = lines.slice(i + 1, upper).filter((line) => line.trim() !== '');
        break;
      }
    }
  }
  return { lines: content, rows: raw, width, ruleWidth, complete, headerVisible, header };
}

/**
 * Czy NAGŁÓWEK dialogu z ramką operacji jest nad krawędzią ekranu: tuż nad regionem opcji stoi dolna kreska ramki
 * `╌╌╌`, a górnej, ciągłej kreski dialogu (`────`) z tytułem nad ramką nie widać. Dwa kształty: ramka czytana przez
 * {@link operationAbove} bez widocznego nagłówka (`headerVisible: false`) i ramka bez paska `│` (treść `Write`,
 * diff `Edit`) ucięta u góry, której {@link operationAbove} nie czyta: nad jej dolną kreską do góry ekranu nie ma
 * drugiej kreski `╌╌╌`. `false` bez kreski ramki nad regionem i przy pustej ramce (dwie kreski jedna pod drugą),
 * nad którą nie wiadomo, co stoi.
 *
 * @param lines linie ekranu po `clean`, jak w {@link operationAbove}
 * @param regionStart indeks pierwszej linii regionu opcji
 * @param operation wynik {@link operationAbove} dla tych samych linii
 */
export function headerAboveEdge(
  lines: readonly string[], regionStart: number, operation: ScreenOperation | null,
): boolean {
  const lower = regionStart - 1;
  if (!OPERATION_RULE.test((lines[lower] ?? '').trim())) return false;
  if (operation !== null) return !operation.headerVisible;
  return !lines.slice(0, lower).some((line) => OPERATION_RULE.test(line.trim()));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** Pierwsze słowo linii (do rozstrzygania, czy zmieściłoby się w linii poprzedniej). */
function firstWord(line: string): string {
  return line.trimStart().split(/\s/u)[0] ?? '';
}

/**
 * Wzorzec granicy między linią `prev` a `next` ramki — czym w komendzie MUSIAŁO być łamanie.
 *
 * CLI łamie komendę po słowach: koniec linii komendy zaczyna nową linię ramki, a zawinięcie
 * wypada na spacji. Słowo dłuższe od ramki tnie twardo na pełnej szerokości. Stąd trzy przypadki:
 * - następne słowo ZMIEŚCIŁOBY SIĘ w linii `prev` → łamanie nie było zawinięciem, tylko końcem
 *   linii komendy: nowa linia (z dowolnym wcięciem);
 * - `prev` jest pełna → mogło to być cięcie słowa, spacja albo koniec linii: dowolny biały ciąg,
 *   także pusty;
 * - inaczej → zawinięcie na spacji albo koniec linii: niepusty biały ciąg.
 * Margines jednej kolumny po obu stronach rozstrzygnięcia: przy wątpliwości wzorzec jest LUŹNIEJSZY
 * (spacja albo nowa linia), a nigdy ściślejszy, niż pozwala render.
 */
function boundary(prev: string, next: string, width: number): string {
  const used = displayWidth(prev);
  if (used >= width - 1) return '\\s*';
  if (used + 1 + displayWidth(firstWord(next)) <= width - 1) return '[ \\t]*\\n\\s*';
  return '\\s+';
}

/**
 * Czy ramka pokazuje dokładnie tę komendę — z uwzględnieniem zawijania przez panel.
 *
 * Wewnątrz linii ramki znaki, także spacje, porównujemy DOSŁOWNIE (`'/tmp/a  b'` ≠ `'/tmp/a b'`,
 * `a /b` ≠ `a/b`); wcięcie na początku linii jest dowolne. Granice linii rozstrzyga
 * {@link boundary}: tam, gdzie łamanie nie mogło być zawinięciem, komenda musi mieć nową linię
 * (`printf safe` + `rm -rf x` w dwóch liniach ≠ `printf safe rm -rf x`).
 *
 * Ramka cała → równość z całą komendą (z dokładnością do białych znaków na brzegach); ramka ucięta
 * u góry → widoczna część musi być KOŃCEM komendy i mieć co najmniej
 * {@link OPERATION_MIN_SUFFIX_CHARS} znaków bez białych. Inny render (tabulator narysowany
 * spacjami, znaki sterujące) daje `false` — czyli odmowę, nigdy złą cyfrę.
 */
export function commandMatches(operation: ScreenOperation, command: string): boolean {
  if (command.trim() === '') return false;
  const visibleLines = operation.lines.filter((line) => line.trim() !== '');
  if (visibleLines.length === 0) return false;
  let pattern = '';
  let visible = 0;
  operation.lines.forEach((line, index) => {
    if (line.trim() === '') return;
    if (pattern !== '') {
      // Pusta linia ramki między dwiema niepustymi = pusta linia komendy, czyli nowa linia.
      const previous = operation.lines.slice(0, index).reverse().find((l) => l.trim() !== '') ?? '';
      const emptyBetween = operation.lines[index - 1]?.trim() === '';
      pattern += emptyBetween ? '[ \\t]*\\n\\s*' : boundary(previous, line, operation.width);
    }
    pattern += `[ \\t]*${escapeRegExp(line.trim())}`;
    visible += line.replace(/\s/gu, '').length;
  });
  if (operation.complete) return new RegExp(`^\\s*${pattern}\\s*$`, 'u').test(command);
  return visible >= OPERATION_MIN_SUFFIX_CHARS && new RegExp(`${pattern}\\s*$`, 'u').test(command);
}

/** Nazwa narzędzia powłoki w payloadzie jsonl i hooka (nie wygląd ekranu, więc poza rejestrem). */
export const BASH_TOOL = 'Bash';

/** Komenda `Bash` z inputu narzędzia (jsonl albo zrzut hooka); `null` dla innego narzędzia. */
export function bashCommand(toolName: string, input: unknown): string | null {
  if (toolName !== BASH_TOOL || typeof input !== 'object' || input === null) return null;
  const command = (input as Record<string, unknown>)['command'];
  return typeof command === 'string' && command.trim() !== '' ? command : null;
}

/** Tekst operacji do pokazania na karcie: linie ramki bez pustych brzegów. */
export function operationText(operation: ScreenOperation): string {
  return operation.lines.join('\n').trim();
}
