/**
 * Licznik kolejki dialogów zgody z ekranu: ile próśb stoi w kolejce CLI (`docs/dialogs.md`, „Server in shadow mode”).
 *
 * Przy kilku prośbach naraz CLI pokazuje pierwszą, a na końcu linii tytułu bloku stawia „k of N”. Po
 * rozstrzygnięciu prośby niewidocznej ta sama prośba na wierzchu ma „2 of 2”, więc stojących jest
 * `N − k + 1`.
 * Cały blok bez licznika (kreska, tytuł, komplet opcji, stopka w jednym odczycie) to jedna prośba. Wszystko inne —
 * brak ekranu, brak bloku, blok ucięty u góry albo niejednoznaczny — to „nie wiem”: licznik jest sygnałem
 * wyłącznie negatywnym dla dowodu „dialog stoi”, więc niepewny odczyt nie może niczego zabrać.
 */
import { dialogBlock, lineBelow, queuedTitleTool } from './block.ts';
import { blockVisible } from './block-visible.ts';
import { unbox } from './options.ts';
import { optionRegion } from './parse.ts';
import { SCREEN_SIGNATURES } from './signatures.ts';
import { trimmedLines } from './text.ts';

const QUEUE_COUNTER_PATTERN = SCREEN_SIGNATURES.queueCounter.pattern;

/** Odczyt kolejki z jednego ekranu. */
export type QueueOnScreen =
  /** Licznik „k of N” w linii tytułu bloku; `standing` = `N − k + 1`. */
  | { readonly kind: 'counter'; readonly index: number; readonly total: number; readonly standing: number }
  /** Cały blok dialogu bez licznika: stoi jedna prośba. */
  | { readonly kind: 'single' }
  /** Nie wiadomo: brak ekranu, brak całego bloku albo licznik bez sensu. */
  | { readonly kind: 'unknown' };

const UNKNOWN: QueueOnScreen = { kind: 'unknown' };
const SINGLE: QueueOnScreen = { kind: 'single' };

/** Linia tytułu bloku (pierwsza pod górną kreską); `null` bez bloku, przy bloku uciętym albo niejednoznacznym. */
function blockTitleLine(text: string): string | null {
  const lines = trimmedLines(text);
  const found = optionRegion(lines);
  if (found === null) return null;
  const block = dialogBlock(lines, found.firstOption);
  if (block.ambiguous || block.top === -1) return null;
  const titleLine = lineBelow(lines, block.top, found.firstOption);
  return titleLine === -1 ? null : lines[titleLine] ?? '';
}

export function queueOnScreen(text: string | null): QueueOnScreen {
  if (text === null) return UNKNOWN;
  const title = blockTitleLine(text);
  if (title === null) return UNKNOWN;
  const counter = QUEUE_COUNTER_PATTERN.exec(unbox(title));
  if (counter !== null) {
    const index = Number(counter[1]);
    const total = Number(counter[2]);
    if (!(index >= 1 && total >= 2 && index <= total)) return UNKNOWN;
    return { kind: 'counter', index, total, standing: total - index + 1 };
  }
  return blockVisible(text) ? SINGLE : UNKNOWN;
}

/**
 * Nazwa narzędzia z tytułu bloku, który niesie poprawny licznik kolejki („Bash command · from the
 * general-purpose agent    2 of 2”); `null` bez licznika albo przy tytule spoza mapy. Licznik stoi w tej samej
 * linii co tytuł, więc taki blok ma tożsamość wyłącznie z `Ask rule`; ten odczyt służy tylko dowodowi całej ramki
 * `Bash` (`bashFrameProven` w `decide/sources.ts` i dowód wierzchu kanału zgód w `layer1/top.ts`).
 */
export function queuedTitleToolOnScreen(text: string): string | null {
  if (queueOnScreen(text).kind !== 'counter') return null;
  const title = blockTitleLine(text);
  return title === null ? null : queuedTitleTool(title);
}
