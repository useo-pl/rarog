/**
 * Tekst inputu narzędzia: wersja PEŁNA (dla klasyfikatora ryzyka) i wersja DO POKAZANIA
 * (dla karty zgody).
 *
 * Rozdzielenie tych dwóch rzeczy jest wymogiem bezpieczeństwa, a nie kosmetyką. Wcześniej
 * driver obcinał opis inputu do 2 kB i dopiero ten skrót trafiał do `classifyRisk()` — czerwona
 * fraza schowana za progiem (np. `rm -rf` na końcu długiego heredoca) była dla klasyfikatora
 * niewidzialna, więc karta zgody wyglądała jak zwykła. Teraz:
 *
 * 1. `toolInputText()` daje CAŁY tekst inputu — to on jest wejściem `risk.ts`,
 * 2. `clipForDisplay()` przycina dopiero prezentację (limit 20 kB) i ZAWSZE mówi, że przyciął.
 *
 * Moduł jest celowo wolny od zależności (żadnego SDK), żeby manager mógł go używać bez
 * wciągania `@anthropic-ai/claude-agent-sdk` do grafu importów.
 */
import { isDelegatingTool } from '@rarog/shared';
import type { Delegation, ToolInputKind } from '@rarog/shared';
import { say } from '@rarog/shared/sentences';
import type { ServerSentence } from '@rarog/shared/sentences';
import type { Truncation } from './types.ts';
import { hasCardHiddenChar } from '../hidden-chars.ts';

/**
 * Ile znaków inputu narzędzia pokazujemy w karcie zgody.
 *
 * 20 kB to kompromis: mieści realny diff / heredoc, a jednocześnie nie wysyła do telefonu
 * megabajtowego załącznika w evencie SSE. Poniżej tej granicy tekst nie jest ruszany.
 */
export const MAX_DISPLAY_TEXT = 20_000;

/**
 * Limit dla `detail` zwiniętego tool-calla w transkrypcie.
 *
 * Karta zgody to powierzchnia DECYZJI (jedna, tu i teraz) — historia to 500 wiadomości
 * w ring bufferze na sesję. Gdyby transkrypt dziedziczył limit karty, jedna sesja mogłaby
 * trzymać w RAM kilka MB opisów inputu i wysyłać je w replayu po powrocie z tła.
 */
export const MAX_TOOL_DETAIL = 2_000;

/** Stopka doklejana do uciętego tekstu: użytkownik ma WIEDZIEĆ, że nie widzi całości. */
export function truncationFooter(cutChars: number): ServerSentence {
  return say('transcript.truncation-footer', { cut: cutChars });
}

/** Tekst do pokazania i, gdy go ucięto, ile znaków wypadło i ile zajmuje stopka (`Truncation`). */
export interface ClippedText {
  readonly text: string;
  readonly truncation?: Truncation;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
}

/**
 * Delegacja w wywołaniu narzędzia: `Workflow` → przebieg workflow, `Agent`/`Task` →
 * subagenci, reszta → `undefined`. Nazwy narzędzi CLI zna serwer; klient czyta sam fakt.
 */
export function toolDelegation(toolName: string): Delegation | undefined {
  if (!isDelegatingTool(toolName)) return undefined;
  return toolName === 'Workflow' ? 'workflow' : 'agents';
}

/**
 * Pola semantyczne bloku `tool-call` — JEDNA reguła dla importu jsonl, demo i mocka.
 *
 * `inputKind: 'shell'`, gdy input niesie łańcuch `command` — ten sam warunek, który w
 * {@link toolInputText} wybiera dosłowną komendę zamiast JSON-a, więc `detail` bloku jest wtedy
 * komendą powłoki. Każdy inny input (także `null` i nie-obiekt) to `'json'`. Klient podświetla
 * po tym polu, a nie po nazwie `Bash`.
 */
export function toolCallSemantics(
  toolName: string, input: unknown,
): { delegation?: Delegation; inputKind: ToolInputKind } {
  const inputKind: ToolInputKind = typeof asRecord(input)?.['command'] === 'string' ? 'shell' : 'json';
  const delegation = toolDelegation(toolName);
  return delegation === undefined ? { inputKind } : { delegation, inputKind };
}

/**
 * Pole semantyczne karty ZGODY — JEDNA reguła dla managera (karty z driverów i seedy demo).
 *
 * `inputKind: 'shell'` WYŁĄCZNIE wtedy, gdy input niesie łańcuch `command` i `displayText` jest mu
 * równy co do znaku: karta pokazuje wtedy dosłownie komendę powłoki, więc klient może ją pokolorować.
 * Każdy inny przypadek to BRAK pola (nie `'json'`): karta z ekranu (`{ screen }` — linie dialogu
 * z opisem), zdegradowana (`input: null`), plan (markdown), JSON innych narzędzi i komenda przycięta
 * stopką `clipForDisplay` — kolor na stopce albo na linii opisu udawałby składnię tam, gdzie jej nie ma.
 */
export function permissionSemantics(
  input: unknown, displayText: string,
): { inputKind?: ToolInputKind } {
  const command = asRecord(input)?.['command'];
  return typeof command === 'string' && command === displayText ? { inputKind: 'shell' } : {};
}

/**
 * Czy karta zgody spoza kanału zgód (z ekranu albo pliku rozmowy) pokazuje CAŁY tekst decyzji — warunek przycisku
 * „Zatwierdź” w managerze. Nie, gdy serwer uciął tekst stopką (`truncation`, {@link clipForDisplay}) albo tekst ma
 * znak ukryty na karcie (`CARD_HIDDEN_RANGES`: kierunek pisma, zerowa szerokość, sterujące poza tabulatorem i nową
 * linią). Telefon zgadza się na to, co widzi, jak na karcie kanału zgód (`hidden-chars`, `truncated`). Tekst
 * wielowierszowy i emoji złożone łącznikiem U+200D przechodzą.
 */
export function cardShowsAll(displayText: string, truncation: Truncation | undefined): boolean {
  return truncation === undefined && !hasCardHiddenChar(displayText);
}

/**
 * Twardy skrót jednolinijkowy (etykiety, nie karta zgody) — bez stopki, z wielokropkiem.
 *
 * Liczy PUNKTY KODOWE, nie jednostki UTF-16: `slice` na `length` potrafił
 * rozciąć emoji w ścieżce dokładnie na granicy i oddać samotny surogat, który `waitingText`
 * w managerze dostawał już gotowy — jej własne cięcie po punktach nic tu nie pomagało.
 */
export function shorten(value: string, max: number): string {
  const points = [...value];
  return points.length <= max ? value : `${points.slice(0, max - 1).join('')}…`;
}

/**
 * PEŁNY tekst inputu narzędzia — bez żadnego obcinania.
 *
 * To jest tekst, na którym liczymy ryzyko. Komenda Basha idzie dosłownie; inne narzędzia
 * dostają czytelny JSON (agent potrafi schować ścieżkę do sekretu w dowolnym polu, więc
 * klasyfikator musi widzieć cały obiekt, nie wybrane pole).
 */
export function toolInputText(toolName: string, input: unknown): string {
  const record = asRecord(input);
  if (record === null) return toolName;
  const command = record['command'];
  if (typeof command === 'string') return command;
  try {
    return JSON.stringify(record, null, 2) ?? toolName;
  } catch {
    // Cykl albo BigInt w inpucie — lepiej pokazać nazwę narzędzia niż wywrócić strumień.
    return toolName;
  }
}

/**
 * Wersja do pokazania w karcie zgody: przycięta do `max` znaków z jawną stopką.
 *
 * Stopka jest częścią umowy z użytkownikiem — decyzję „pozwól" podejmuje się na podstawie tego,
 * co widać, więc niewidoczna reszta musi być zadeklarowana.
 *
 * Próg, cięcie i liczba w stopce idą w jednostkach UTF-16 (`length`, `slice`), więc tekst na drucie
 * się nie zmienia. `truncation` liczy już SKALARY Unicode gotowych tekstów (`[...text]`), bo tak policzy je apka
 * (`unicodeScalars.count`). Tekst nieucięty wraca bez `truncation`.
 */
export function clipForDisplay(text: string, max: number = MAX_DISPLAY_TEXT): ClippedText {
  if (text.length <= max) return { text };
  const head = text.slice(0, max);
  const footer = truncationFooter(text.length - max).text;
  const truncation = { cut: [...text].length - [...head].length, footer: [...footer].length };
  return { text: `${head}${footer}`, truncation };
}

// ---------------------------------------------------------------------------
// Mini-diff dla kart `Edit`/`Write` w transkrypcie
// ---------------------------------------------------------------------------

/** Ile linii wspólnego kontekstu stoi nad i pod zmianą. */
const DIFF_CONTEXT_LINES = 2;

/**
 * Mini-diff z pary `old_string`/`new_string` narzędzia `Edit`.
 *
 * To nie jest `git diff` — to dokładnie ta zamiana, którą agent zlecił: wspólny początek
 * i koniec obu tekstów odpada (zostają po `DIFF_CONTEXT_LINES` linie kontekstu), środek
 * wychodzi jako `-`/`+`. Jeden hunk, zero zależności; wystarcza, bo `old_string` Edita
 * z definicji jest ciągłym fragmentem pliku. Prefiksy (`-`, `+`, dwie spacje) są częścią
 * kontraktu `detailKind: 'diff'` — klient koloruje PO NICH, więc linia kodu zaczynająca się
 * od minusa nie ma jak udawać usunięcia.
 */
export function editDiffText(oldStr: string, newStr: string): string {
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  let start = 0;
  while (start < oldLines.length && start < newLines.length
    && oldLines[start] === newLines[start]) {
    start += 1;
  }
  let endOld = oldLines.length;
  let endNew = newLines.length;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld -= 1;
    endNew -= 1;
  }
  const out: string[] = [];
  for (let i = Math.max(0, start - DIFF_CONTEXT_LINES); i < start; i += 1) {
    out.push(`  ${oldLines[i] ?? ''}`);
  }
  for (let i = start; i < endOld; i += 1) out.push(`- ${oldLines[i] ?? ''}`);
  for (let i = start; i < endNew; i += 1) out.push(`+ ${newLines[i] ?? ''}`);
  const tail = Math.min(oldLines.length, endOld + DIFF_CONTEXT_LINES);
  for (let i = endOld; i < tail; i += 1) out.push(`  ${oldLines[i] ?? ''}`);
  return out.join('\n');
}

/** `Write` to same plusy: cały zapisywany plik jest „dodany". */
export function writeDiffText(content: string): string {
  return content.split('\n').map((line) => `+ ${line}`).join('\n');
}

/**
 * Mini-diff dla bloku tool-call w transkrypcie albo `null`, gdy narzędzie nie jest edycją
 * (wtedy detail zostaje surowym tekstem inputu, jak dotąd). `Edit` bez kompletu pól
 * (np. ucięty wpis) też dostaje `null` — lepszy surowy JSON niż zmyślony diff.
 */
export function toolDiffText(toolName: string, input: unknown): string | null {
  const record = asRecord(input);
  if (record === null) return null;
  if (toolName === 'Edit') {
    const oldStr = record['old_string'];
    const newStr = record['new_string'];
    if (typeof oldStr !== 'string' || typeof newStr !== 'string') return null;
    return editDiffText(oldStr, newStr);
  }
  if (toolName === 'Write') {
    const content = record['content'];
    if (typeof content !== 'string') return null;
    return writeDiffText(content);
  }
  return null;
}
