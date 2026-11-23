/**
 * Dół odczytu dialogu zgody: czy odczyt ekranu kończy się stopką dialogu zgody narysowaną przez CLI. Odczyt
 * służy WYŁĄCZNIE dowodowi wierzchu kanału zgód (`layer1/top.ts`). Prawdziwy dialog stoi na dole panelu, więc jego
 * stopka kończy odczyt: tak kończy się każdy fixture korpusu wierzchu z dialogiem z ramką operacji, poza listą
 * wyjątków z powodem (`server/test/layer1-top-corpus.test.ts`). Pełna podróbka dialogu w transkrypcie
 * widoku przewiniętego ma pod sobą dalszy tekst transkryptu, więc dół jej nie przepuszcza; podróbka, na której stopce
 * kończy się widok, to znana luka (`docs/dialogs.md`, „Known gaps”).
 *
 * Dół przechodzi wyłącznie wtedy, gdy ostatnia niepusta linia odczytu albo, nad krawędzią z nazwą sesji
 * (`sessionNameEdge`, jedna, puste linie między nimi się nie liczą), ostatnia niepusta linia nad nią to:
 *
 * - stopka z zamkniętej listy znak w znak (`permissionFooter`, `permissionFooterAgents`);
 * - stopka z podpowiedzią subagentów ucięta wielokropkiem na szerokości panelu: ścisły początek
 *   `permissionFooterAgents` dłuższy niż sama `permissionFooter` i wielokropek (`footerTruncation`);
 * - `permissionFooter` zawinięta na dwie kolejne linie ekranu, sklejone spacją (wąski panel, CLI 2.1.311).
 *
 * Każdy inny dół (tekst pod stopką, dopisek, druga krawędź, krawędź bez nazwy, stopka innego dialogu, zawinięcie na
 * trzy linie albo z pustą linią w środku) daje `false`.
 */
import { SCREEN_SIGNATURES } from './signatures.ts';

const FOOTER = SCREEN_SIGNATURES.permissionFooter.pattern;
const FOOTER_AGENTS = SCREEN_SIGNATURES.permissionFooterAgents.pattern;
const TRUNCATION = SCREEN_SIGNATURES.footerTruncation.pattern;
const SESSION_EDGE = SCREEN_SIGNATURES.sessionNameEdge.pattern;

/** Indeks ostatniej niepustej linii przed `end`; `-1` = brak. */
function lastFilled(lines: readonly string[], end: number): number {
  for (let i = end - 1; i >= 0; i -= 1) if ((lines[i] ?? '').trim() !== '') return i;
  return -1;
}

/** Stopka z listy w jednej linii: znak w znak albo stopka z podpowiedzią ucięta wielokropkiem. */
function footerLine(line: string): boolean {
  if (line === FOOTER || line === FOOTER_AGENTS) return true;
  const cut = TRUNCATION.exec(line);
  if (cut === null) return false;
  const kept = line.slice(0, cut.index);
  return kept.length > FOOTER.length && kept.length < FOOTER_AGENTS.length && FOOTER_AGENTS.startsWith(kept);
}

/** Czy odczyt (linie ekranu po `trimmedLines`) kończy się stopką dialogu zgody z listy. */
export function dialogBottomAnchored(lines: readonly string[]): boolean {
  let last = lastFilled(lines, lines.length);
  if (last !== -1 && SESSION_EDGE.test((lines[last] ?? '').trim())) last = lastFilled(lines, last);
  if (last === -1) return false;
  const line = (lines[last] ?? '').trim();
  if (footerLine(line)) return true;
  const above = (lines[last - 1] ?? '').trim();
  return above !== '' && `${above} ${line}` === FOOTER;
}
