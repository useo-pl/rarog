/**
 * Import historii sesji z magazynu CLI — READ-ONLY, wyłącznie OGON pliku.
 *
 * Po co: „Wznów" podnosi silnik na istniejącej sesji CLI, ale transkrypt Raroga po restarcie
 * backendu jest PUSTY (żył w RAM). Użytkownik dostawał sesję bez ani jednej wiadomości i nie
 * wiedział, do czego wraca. Ten moduł czyta to, co CLI już zapisało na dysku, i oddaje
 * managerowi gotowe wiadomości do transkryptu.
 *
 * Reguły odporności (magazyn należy do CLI — jego format może się zmienić bez uprzedzenia):
 * - czytamy najwyżej `MAX_IMPORT_BYTES` z KOŃCA pliku (realne transkrypty mają 20+ MB, więc
 *   `readFile` całości byłby awarią pamięci, a nie odczytem),
 * - pierwsza linia ogona jest prawie na pewno ucięta w połowie — pomijamy ją,
 * - uszkodzona linia jest pomijana, plik leci dalej; brak pliku = pusta lista, NIGDY wyjątek,
 * - `engineSessionId` wchodzi do ŚCIEŻKI pliku, więc przechodzi przez wzorzec identyfikatora:
 *   przy `resume-external` ten identyfikator pochodzi wprost z requestu klienta.
 *
 * Czego tu NIE ma: obrazków z dysku. Blok `image` z magazynu zamieniamy na tekst „[obraz]" —
 * transkrypt Raroga leci przez SSE na telefon, a wczytywanie megabajtowych data URL-i z cudzego
 * pliku byłoby i kosztem, i powierzchnią ataku (dane spoza kontroli Raroga w `img[src]`).
 */
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { EFFORT_LEVELS, MODEL_ID_PATTERN, UPLOAD_IMAGE_FILE_PATTERN } from '@rarog/shared';
import type { EffortLevel, MessageAttachment, TranscriptNotice } from '@rarog/shared';
import { foreign, say } from '@rarog/shared/sentences';
import type { InternalBlock } from './drivers/types.ts';
import { defaultStoreRoot, projectSlug } from './cli-store.ts';
import { isTaskNotificationOrigin, noticeFromText } from './herdr/background/notice.ts';
import { CLI_PLUMBING_TAGS } from './herdr/commands/registry.ts';
import { INTERRUPTION_TEXT, parseJsonlEntry } from './herdr/jsonl-pending.ts';
import { isMainCompactBoundary } from './herdr/jsonl-usage.ts';
import { FileEchoPairing, plainFileEchoOf, systemEntryNote, userEntryNote } from './herdr/commands/transcript.ts';
import type { CommandEntryResult, CommandNotePart, FileEchoMark, PromptBlock } from './herdr/commands/transcript.ts';
import { queuedHumanPrompt } from './herdr/background/queued-prompt.ts';
import { MAX_TRANSCRIPT_MESSAGES } from './sessions/session.ts';
import {
  MAX_TOOL_DETAIL, clipForDisplay, toolCallSemantics, toolDiffText, toolInputText,
} from './drivers/tool-text.ts';
import { summarizeToolInput } from './drivers/tool-summary.ts';
import { UPLOAD_DIR_NAME } from './herdr/uploads.ts';

/**
 * Ile bajtów ogona czytamy. 2 MB to ~kilkaset ostatnich wiadomości nawet przy dużych
 * tool-callach, a jednocześnie odczyt, który mieści się w pamięci bez mrugnięcia.
 */
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

/** Rozszerzenie plików transkryptu w magazynie CLI. */
const TRANSCRIPT_EXT = '.jsonl';

/**
 * Dozwolony kształt `engineSessionId` — uuid CLI. To jest granica bezpieczeństwa, nie kosmetyka:
 * identyfikator trafia do `join()`, więc `../../…` czytałby dowolny plik konta użytkownika.
 */
export const ENGINE_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Tekst, którym zastępujemy obrazek z magazynu CLI (nie wciągamy data URL-i z dysku). */
export const IMAGE_PLACEHOLDER = say('transcript.image-placeholder');

/**
 * Znaczniki własnej instalacji CLI, które lądują w rolach `user`, choć NIKT ich nie napisał:
 * wyjście lokalnej komendy (z sekwencjami ANSI!), rozwinięcie slasha, przypomnienia systemowe.
 *
 * Do transkryptu Raroga nie wchodzą — na telefonie byłyby nieczytelnym szumem, a użytkownik
 * i tak nie ma jak na nie zareagować. Słowa znaczników stoją w rejestrze komend
 * (`herdr/commands/registry.ts`); tu jest tylko gramatyka: znacznik na początku tekstu.
 */
const CLI_PLUMBING_TAG = new RegExp(`^\\s*<(?:${CLI_PLUMBING_TAGS.join('|')})>`);

export interface ImportedMessage {
  /**
   * `system` niesie WYŁĄCZNIE wpisy komendy: komendę lokalną, jej wynik i ostrzeżenie o komendzie
   * nieznanej (`herdr/commands/transcript.ts`), oraz notkę o prompcie zablokowanym przez hook. Komenda typu
   * prompt jest wiadomością `user`.
   */
  role: 'user' | 'assistant' | 'system';
  /** Bloki wewnętrzne: treść z pliku rozmowy to `foreign`, zastępnik obrazka i notki Raroga — tekst własny. */
  blocks: InternalBlock[];
  /** ISO z pola `timestamp` wpisu; pusty string = wpis go nie miał (wołający podstawia swój). */
  at: string;
  /**
   * Wizytówki ZDJĘĆ wysłanych przez Raroga — z wpisu-towarzysza `[Image: source: …]`,
   * który CLI dopisuje ZA wiadomością człowieka. Nieobecne = wiadomość bez naszych zdjęć.
   */
  attachments?: MessageAttachment[];
  /**
   * Notka harnessu: wpis `user` z `origin.kind === 'task-notification'`. Bloki zostają
   * surowym tekstem (stary klient rozpoznaje notkę po swojemu), a fakty jadą tym polem.
   */
  notice?: TranscriptNotice;
  /**
   * Wiadomość z wpisu komendy CLI: która część komendy i jej nazwa, gdy wpis ją niesie. Pole dla
   * followera (echo wywołania wysłanego z Raroga, koniec komendy lokalnej w driverze) — nie jedzie dalej.
   * Część `prompt-blocked` to prompt zablokowany przez hook `UserPromptSubmit` (fakty w `promptBlocked`).
   */
  command?: ImportedCommand;
  /**
   * Prompt zablokowany przez hook (część `prompt-blocked`): powód, `promptKept` i cytat promptu po
   * `humanTextOf`. Blokami jest notka z cytatem (`promptBlockedText`); follower decyduje, czy wpis trafił
   * w echo wysyłki z Raroga (wtedy zdarzenie zamiast wiadomości). Pole nie jedzie na drut w tym kształcie.
   */
  promptBlocked?: PromptBlock;
  /**
   * Only with `ParseTailOptions.turnMarks`: an entry that is no message but marks the turns, with no blocks.
   * `hidden` = a `user` entry that opens a turn without being shown ({@link isHiddenTurnInput}); `compaction` =
   * a compaction boundary of the main thread (`isMainCompactBoundary`).
   */
  turnMark?: 'hidden' | 'compaction';
  /**
   * Only with `ParseTailOptions.turnMarks`: timestamp of the last entry merged into this assistant message (`at` is
   * the first one's). Absent = the message is one entry.
   */
  lastAt?: string;
  /**
   * Only with `ParseTailOptions.turnMarks`, on every `user`-role message: the identity of its file entry, the
   * entry's `uuid`; an entry without one gets a hash of its line (which holds its timestamp, if any). It depends on
   * the line alone, so the same entry has the same identity in every read window.
   */
  entryId?: string;
}

/** Ślad wpisu komendy na wiadomości importu (`ImportedMessage.command`). */
export interface ImportedCommand {
  readonly part: CommandNotePart;
  /** Nazwa komendy małymi literami, bez ukośnika; nieobecna przy wyniku zapisanym wpisem `user`. */
  readonly name?: string;
}

/**
 * Wpis-towarzysz zdjęcia: CLI (fixture `transcript-sample.jsonl`) zapisuje ZA wiadomością z obrazkiem
 * osobny wpis `user` z `isMeta: true` i tekstem `[Image: source: <ścieżka>]` — jedyne miejsce w jsonl, w którym
 * stoi ŚCIEŻKA pliku, a nie base64. Dla zdjęcia z Raroga ścieżka prowadzi do katalogu załączników
 * (`<cwd>/.rarog-uploads/`, `UPLOAD_DIR_NAME` w `herdr/uploads.ts`) i to z niej import odzyskuje NAZWĘ pliku
 * (samą nazwę): po niej klient prosi o miniaturę. Zdjęcie wklejone w terminalu ma ścieżkę spoza tego
 * katalogu i zostaje `[obraz]`.
 */
const IMAGE_SOURCE_TAG = /^\s*\[Image: source: (.+)\]\s*$/;
const UPLOAD_DIR_SEGMENT = `/${UPLOAD_DIR_NAME}/`;

/** Nazwy plików zdjęć Raroga z wpisu-towarzysza (w kolejności bloków); pusta = to nie towarzysz. */
function uploadFilesFrom(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const files: string[] = [];
  for (const item of content) {
    if (typeof item !== 'object' || item === null) continue;
    const block = item as { type?: unknown; text?: unknown };
    if (block.type !== 'text') continue;
    const match = IMAGE_SOURCE_TAG.exec(asString(block.text));
    if (match === null) continue;
    const source = match[1] ?? '';
    const cut = source.lastIndexOf(UPLOAD_DIR_SEGMENT);
    if (cut < 0) continue;
    const name = source.slice(cut + UPLOAD_DIR_SEGMENT.length);
    if (UPLOAD_IMAGE_FILE_PATTERN.test(name)) files.push(name);
  }
  return files;
}

/** MIME z rozszerzenia nazwy zdjęcia Raroga (zapisuje wyłącznie png i jpg). */
function uploadMime(name: string): string {
  return name.endsWith('.png') ? 'image/png' : 'image/jpeg';
}

/**
 * Przypina zdjęcia z wpisu-towarzysza do POPRZEDZAJĄCEJ wiadomości człowieka.
 *
 * Każde przypięte zdjęcie zdejmuje z niej jeden zastępnik `[obraz]` (blok `image` tej samej
 * wiadomości): miniatura i napis mówiłyby o tym samym pliku dwa razy. Zastępniki ponad liczbę
 * towarzyszy zostają — to obrazki, których Rarog nie zna. `bytes: 0` = waga nieznana (jsonl
 * nie niesie rozmiaru pliku, a `stat` w parserze synchronicznym nie ma czego szukać).
 */
function attachUploadFiles(message: ImportedMessage, files: readonly string[]): void {
  if (files.length === 0) return;
  const attachments = files.map((file): MessageAttachment => (
    { kind: 'image', name: '', bytes: 0, mime: uploadMime(file), file }
  ));
  message.attachments = [...(message.attachments ?? []), ...attachments];
  let toDrop = files.length;
  message.blocks = message.blocks.filter((block) => {
    // Ten sam obiekt zdania, a nie równy tekst: wiadomość użytkownika z dosłownym „[image]” zostaje.
    if (toDrop === 0 || block.type !== 'text' || block.text !== IMAGE_PLACEHOLDER) return true;
    toDrop -= 1;
    return false;
  });
}

export interface ImportedTranscript {
  messages: ImportedMessage[];
  /** Model z OSTATNIEGO czytelnego wpisu asystenta (`message.model`). */
  model?: string;
  /** Effort z ostatniego czytelnego wpisu asystenta (pole `effort` wpisu, nie wiadomości). */
  effort?: EffortLevel;
}

export interface TranscriptImportOptions {
  /** Korzeń magazynu CLI. Domyślnie `~/.claude/projects`. */
  root?: string;
  /** Ile bajtów ogona czytamy (testy podkręcają w dół). */
  maxBytes?: number;
  /** Ile wiadomości zostawiamy (od końca). */
  limit?: number;
}

// ---------------------------------------------------------------------------
// Parser (czysty — testowalny bez dysku)
// ---------------------------------------------------------------------------

/** Kształt wpisu JSONL, na którym nam zależy; reszta pól CLI nas nie interesuje. */
interface RawEntry {
  type?: unknown;
  turnOrigin?: unknown;
  isMeta?: unknown;
  isSidechain?: unknown;
  /** Podsumowanie kompakcji zapisane przez CLI w roli `user` — patrz `parseImportLine`. */
  isCompactSummary?: unknown;
  timestamp?: unknown;
  effort?: unknown;
  /** Pochodzenie wpisu (`{kind: 'human' | 'task-notification' | …}`) — bramka notek. */
  origin?: unknown;
  message?: { role?: unknown; content?: unknown; model?: unknown };
}

interface ParsedEntry {
  role: 'user' | 'assistant' | 'system';
  /** `null`, gdy wpis nie niesie NIC do pokazania (samo `thinking`, sam `tool_result`). */
  message: ImportedMessage | null;
  /**
   * Czy wpis jest WYPOWIEDZIĄ człowieka albo agenta (także wywołaniem komendy typu prompt). Notka `system`
   * komendy lokalnej, jej wynik i ostrzeżenie o komendzie nieznanej wypowiedzią nie są: po `/clear` nowy
   * plik niesie właśnie je, a `transcriptHasConversation` odróżnia po tym polu `/clear` od `/resume`.
   */
  conversational: boolean;
  model?: string;
  effort?: EffortLevel;
  /**
   * Wpis-towarzysz zdjęć Raroga: nazwy plików do przypięcia do POPRZEDNIEJ wiadomości
   * człowieka. Taki wpis sam nie jest wiadomością (`message: null`).
   */
  uploadFiles?: string[];
  /** A carrier of a `fileEcho` command call; the reader passes it to its `FileEchoPairing` in file order. */
  fileEcho?: FileEchoMark;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Czy ten tekst napisał człowiek (a nie CLI samo do siebie)?
 * The interruption marker is not a bubble: the driver's note already reports an Esc sent from Rarog.
 */
function isHumanText(text: string): boolean {
  return text.trim() !== '' && !CLI_PLUMBING_TAG.test(text) && !INTERRUPTION_TEXT.test(text.trimStart());
}

/**
 * Tekst użytkownika bez znaczników `[Image #N]`, które CLI DOKLEJA do promptu z załącznikami.
 *
 * To nie jest treść człowieka, tylko hydraulika CLI (numer odsyła do bloku obrazka obok) —
 * a gdy wiadomość wraca z jsonl zamiast z lokalnego echa, użytkownik
 * widziałby własne zdanie oszpecone: „[Image #36] [Image #37]Zarówno w jednym…".
 * Sam obrazek i tak stoi obok jako `[obraz]`.
 */
export function humanTextOf(text: string): string {
  return unwrapPasted(text.replace(/\[Image #\d+\]\s*/g, ''));
}

/**
 * Obwódka wklejki: od CLI 2.1.277 tekst WKLEJONY do pola promptu (a `agent.prompt` herdr wkleja
 * wszystko od ok. 20 znaków) ląduje w jsonl jako
 * `\n\n<pasted_content id="094f">\n…\n</pasted_content id="094f">`. To znów hydraulika CLI, nie
 * treść człowieka: bez zdjęcia użytkownik widzi tagi wokół własnego zdania, a `#takeEcho`
 * followera nie dopasowuje echa do tego, co Rarog wysłał. Zdejmujemy SAME tagi (z wymaganym
 * `id`, żeby nie ruszać tagu wpisanego ręcznie) — tekst obok wklejki i w jej środku zostaje.
 */
const PASTED_CONTENT_TAG = /\n?<\/?pasted_content id="[0-9a-z]{1,32}">\n?/g;

function unwrapPasted(text: string): string {
  if (!text.includes('<pasted_content id="')) return text;
  return text.replace(PASTED_CONTENT_TAG, '\n').trim();
}

/** Surowy tekst wpisu `user` (goły string albo bloki `text` sklejone) — wejście klasyfikacji notki. */
function rawUserText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => (typeof item === 'object' && item !== null && (item as { type?: unknown }).type === 'text'
      ? asString((item as { text?: unknown }).text)
      : ''))
    .join('\n');
}

/** Bloki wiadomości użytkownika: tekst i „[obraz]"; `tool_result` NIE jest wypowiedzią. */
function userBlocksFrom(content: unknown): InternalBlock[] {
  if (typeof content === 'string') {
    const text = humanTextOf(content);
    return isHumanText(text) ? [{ type: 'text', text: foreign(text) }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: InternalBlock[] = [];
  for (const item of content) {
    if (typeof item !== 'object' || item === null) continue;
    const block = item as { type?: unknown; text?: unknown };
    if (block.type === 'text') {
      const text = humanTextOf(asString(block.text));
      if (isHumanText(text)) blocks.push({ type: 'text', text: foreign(text) });
      continue;
    }
    if (block.type === 'image') blocks.push({ type: 'text', text: IMAGE_PLACEHOLDER });
  }
  return blocks;
}

/**
 * Bloki wiadomości asystenta: tekst i zwinięty tool-call.
 *
 * Kształt bloku `tool-call` liczymy DOKŁADNIE tak jak driver SDK (`summarizeToolInput` +
 * przycięty `toolInputText`), żeby wiadomość z magazynu wyglądała w transkrypcie identycznie
 * jak ta, która przyszła strumieniem.
 *
 * `thinking` z PUSTĄ treścią pomijamy — to zwykłe myślenie, którego CLI nie pokazuje. Blok
 * `thinking` z NIEPUSTĄ treścią idzie jak tekst: tak zapisują się wypowiedzi,
 * które terminal rysuje zwykłym `⏺ …` („Tag Vertex nadal jest aktywny…"), a Rarog gubił je
 * bez śladu. Zmierzone na sesji Opus 5.5 / CLI 2.1.281: pięć z pięciu takich bloków stało
 * na ekranie panelu jako tekst agenta, a myślenie tej samej sesji ma treść pustą.
 *
 * ZAŁOŻENIE: niepusta treść odróżnia wypowiedź od myślenia tylko przy
 * domyślnej konfiguracji, w której sesja interaktywna dostaje myślenie zredagowane (docs
 * `model-config.md`, „Extended thinking”; w zmierzonych jsonl
 * niepusty `thinking` mają wyłącznie modele piszące progress updates — Fable 5/5.1, Opus 5.5;
 * Opus 4.7 i Sonnet 5 mają myślenie zawsze puste). Przy `showThinkingSummaries: true` te same docs
 * obiecują pełne streszczenia myślenia: wtedy myślenie też ma treść, jsonl go nie odróżnia
 * i pojechałoby jako tekst.
 */
function assistantBlocksFrom(content: unknown): InternalBlock[] {
  if (!Array.isArray(content)) return [];
  const blocks: InternalBlock[] = [];
  for (const item of content) {
    if (typeof item !== 'object' || item === null) continue;
    const block = item as {
      type?: unknown; text?: unknown; thinking?: unknown; name?: unknown; input?: unknown;
    };
    if (block.type === 'text' && asString(block.text).trim() !== '') {
      blocks.push({ type: 'text', text: foreign(asString(block.text)) });
      continue;
    }
    if (block.type === 'thinking' && asString(block.thinking).trim() !== '') {
      blocks.push({ type: 'text', text: foreign(asString(block.thinking).trimEnd()) });
      continue;
    }
    if (block.type === 'tool_use') {
      const toolName = asString(block.name) !== '' ? asString(block.name) : 'tool';
      /*
       * `Edit`/`Write` niosą w detail MINI-DIFF zamiast surowego JSON-a inputu:
       * zamiana widziana jako `-`/`+` z dwiema liniami kontekstu, jak w herdr. Diff jest też
       * dużo mniejszy od pary old/new w JSON-ie, więc limit 2 kB tnie go znacznie rzadziej.
       */
      const diff = toolDiffText(toolName, block.input);
      const detail = clipForDisplay(diff ?? toolInputText(toolName, block.input), MAX_TOOL_DETAIL);
      blocks.push({
        type: 'tool-call',
        toolName,
        summary: summarizeToolInput(toolName, block.input),
        detail: detail.text,
        // Ucięcie zostaje wewnętrzne: `wireBlocks` w `session.ts` zdejmuje je przed drutem.
        ...(detail.truncation === undefined ? {} : { truncation: detail.truncation }),
        ...(diff === null ? {} : { detailKind: 'diff' as const }),
        // Delegacja i rodzaj inputu liczone tu, z inputu — klient nie zna nazw narzędzi.
        ...toolCallSemantics(toolName, block.input),
      });
    }
  }
  return blocks;
}

/**
 * Wpis roli `user`, którego Rarog NIE pokazuje w transkrypcie (`isMeta: true`), a który CLI
 * oznacza jako czyjeś WEJŚCIE do rozmowy: ma `origin.kind` albo `turnOrigin`.
 *
 * Zmierzone na magazynie CLI (649 plików sesji z 20 dni, CLI 2.1.273–2.1.296).
 * Takie wpisy są cztery i każdy zaczyna albo zasila turę głównego agenta:
 * - wiadomość od subagenta (raport końcowy albo wiadomość w trakcie pracy): `origin.kind: "peer"`,
 *   od CLI 2.1.277 także `turnOrigin: "peer"` — 515 wpisów;
 * - zaplanowane wybudzenie: bez `origin`, `turnOrigin: "scheduled"` — 10 wpisów;
 * - wiadomość systemowa między sesjami: bez `origin`, `turnOrigin: "system"` — 3 wpisy;
 * - wznowienie po odnowieniu limitu: `origin.kind: "auto-continuation"` — 1 wpis.
 *
 * Pozostałe wpisy meta (towarzysz zdjęcia, treść skilla, dopiski lokalnych komend — 700 wpisów)
 * nie mają żadnego z tych pól: to hydraulika tury, która już trwa, a nie jej przyczyna.
 *
 * Reguła patrzy na OBECNOŚĆ pól, nie na ich wartości: nowy rodzaj wejścia w przyszłym CLI liczy
 * się sam. Jedyne zastosowanie: manager liczy, czy turę wywołał sam meldunek o postoju subagenta
 * (`docs/background-tasks.md`). Transkryptu nie zmienia — wpis dalej nie jest wiadomością.
 */
export function isHiddenTurnInput(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as RawEntry;
  if (entry.type !== 'user' || entry.isSidechain === true || entry.isMeta !== true) return false;
  return marksTurnInput(entry);
}

/**
 * Czy CLI oznaczył wpis jako czyjeś WEJŚCIE do rozmowy (`origin.kind` albo `turnOrigin`). Reguła patrzy
 * na obecność pól, nie na wartości (patrz {@link isHiddenTurnInput}). Drugie zastosowanie: wywołanie
 * komendy o nazwie spoza rejestru jest promptem tylko z tym znacznikiem (`herdr/commands/transcript.ts`).
 */
function marksTurnInput(entry: RawEntry): boolean {
  const origin: unknown = entry.origin;
  const kind: unknown = typeof origin === 'object' && origin !== null
    ? (origin as { kind?: unknown }).kind : undefined;
  return (typeof kind === 'string' && kind !== '')
    || (typeof entry.turnOrigin === 'string' && entry.turnOrigin !== '');
}

/** Wiadomość z wpisu komendy; `null` z mapowania = wpis komendy bez niczego do pokazania. */
function commandEntry(note: Exclude<CommandEntryResult, undefined>, at: string): ParsedEntry {
  if (note === null) return { role: 'system', message: null, conversational: false };
  const command: ImportedCommand = { part: note.part, ...(note.name === undefined ? {} : { name: note.name }) };
  return {
    role: note.role,
    message: {
      role: note.role, blocks: [{ type: 'text', text: note.text }], at, command,
      ...(note.blocked === undefined ? {} : { promptBlocked: note.blocked }),
    },
    // Wywołanie komendy typu prompt jest wejściem tury człowieka; notka `system` (także o prompcie
    // zablokowanym przez hook — do żadnej tury nie wszedł) wypowiedzią nie jest.
    conversational: note.role === 'user',
    ...(note.fileEcho === true && note.name !== undefined ? { fileEcho: { carrier: 'call', name: note.name } } : {}),
  };
}

/** Opcje parsera linii pliku rozmowy. */
export interface ImportLineOptions {
  /**
   * Rozpoznanie promptu zablokowanego przez hook `UserPromptSubmit` (`RAROG_PROMPT_BLOCK` ≠ `0`, domyślnie
   * włączone). `false` = taki wpis pomijany jak każdy nieznany wpis `system`, jak przed rozpoznaniem.
   */
  readonly promptBlock?: boolean;
}

/**
 * Parsuje jedną linię JSONL magazynu CLI.
 *
 * @returns opis wpisu albo `null`, gdy linia nie jest wiadomością do pokazania (inny `type`,
 *          wpis `system` spoza komend, wpis meta, sidechain podagenta, uszkodzony JSON). Wpis komendy
 *          daje notkę `system` albo — komenda typu prompt — wiadomość `user`. Prompt
 *          zablokowany przez hook daje notkę `system` z częścią `prompt-blocked` i polem `promptBlocked`.
 */
export function parseImportLine(line: string, opts: ImportLineOptions = {}): ParsedEntry | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const entry = value as RawEntry;

  /*
   * Prompt człowieka wchłonięty w trwającą turę: CLI zapisuje go WYŁĄCZNIE jako załącznik kolejki,
   * bez wpisu `user` (zmierzone na 2.1.299, fixture `queue/measured/wchloniecie-2.1.299.jsonl`;
   * rozpoznanie: `herdr/background/queued-prompt.ts`). Bez tej gałęzi taki prompt znikałby
   * z transkryptu przy każdym odtworzeniu z pliku (restart serwera, powrót panelu), a wpisany
   * w terminalu nie trafiałby do Raroga wcale. Treść przechodzi przez to samo
   * sito co wpis `user`: `[Image #N]` i obwódka wklejki znikają, obraz staje się napisem `[obraz]`
   * (base64 nie wychodzi z Maca). Notki tu nie ma: pochodzenie takiego wpisu to człowiek.
   */
  const queued = queuedHumanPrompt(value);
  if (queued !== null) {
    const blocks = userBlocksFrom(queued.prompt);
    return blocks.length === 0
      ? { role: 'user', message: null, conversational: false }
      : { role: 'user', message: { role: 'user', blocks, at: queued.at }, conversational: true };
  }

  // Wpisy meta (podsumowania CLI) i sidechainy (podagenci) nie są rozmową człowieka z agentem.
  // Reguła dotyczy WSZYSTKICH ról: transkrypt podagenta w głównym wątku byłby szumem, a nie historią.
  //
  // `isCompactSummary` jest osobnym warunkiem, bo NIE MA `isMeta: true` — po `/compact` CLI
  // zapisuje wpis roli `user` bez `isMeta: true` i z `content` będącym gołym stringiem (fixture
  // `queue/measured/compact-2.1.299.jsonl`; bywa ~22 000 znaków). Bez tej gałęzi całe
  // podsumowanie kompakcji lądowałoby na telefonie jako WIADOMOŚĆ UŻYTKOWNIKA — tekst, którego nikt nie napisał.
  if (entry.isSidechain === true) return null;
  if (entry.isCompactSummary === true) return null;
  const at = asString(entry.timestamp);
  /*
   * Wpis `system` jest wiadomością tylko wtedy, gdy to wpis komendy: komenda lokalna, jej wynik
   * albo ostrzeżenie o komendzie nieznanej — albo prompt zablokowany przez hook `UserPromptSubmit`, którego
   * cytat przechodzi przez to samo sito co wpis `user` (`humanTextOf`). Reszta wpisów `system` (koniec tury,
   * granica kompakcji) nie.
   */
  if (entry.type === 'system') {
    if (entry.isMeta === true) return null;
    const note = systemEntryNote(value as Readonly<Record<string, unknown>>, {
      normalizePrompt: humanTextOf, ...(opts.promptBlock === false ? { promptBlock: false } : {}),
    });
    return note === undefined ? null : commandEntry(note, at);
  }
  const role = entry.type === 'user' || entry.type === 'assistant' ? entry.type : null;
  if (role === null) return null;
  const message = entry.message;
  if (typeof message !== 'object' || message === null) return null;
  if (message.role !== role) return null;
  /*
   * Jeden wyjątek od reguły meta: towarzysz zdjęcia (`[Image: source: …]` ZA wiadomością
   * człowieka) niesie nazwę pliku z `.rarog-uploads/`, czyli klucz miniatury. Oddajemy ją
   * osobnym polem i BEZ wiadomości — sam wpis nadal nie jest niczyją wypowiedzią.
   */
  if (entry.isMeta === true) {
    const uploadFiles = role === 'user' ? uploadFilesFrom(message.content) : [];
    return uploadFiles.length === 0 ? null : { role, message: null, conversational: false, uploadFiles };
  }

  /*
   * Komenda wpisana w terminalu albo wysłana z Raroga: wywołanie i wynik stoją we wpisach `user`
   * ze znacznikami CLI. Mapowanie mówi, czy to notka `system`, wiadomość `user` (komenda typu prompt), czy
   * nic; tekst bez znacznika komendy idzie dalej zwykłą drogą.
   */
  if (role === 'user') {
    const note = userEntryNote(rawUserText(message.content), marksTurnInput(entry));
    if (note !== undefined) return commandEntry(note, at);
  }

  const blocks = role === 'user'
    ? userBlocksFrom(message.content)
    : assistantBlocksFrom(message.content);
  const parsed: ParsedEntry = {
    role,
    message: blocks.length === 0 ? null : { role, blocks, at },
    conversational: blocks.length > 0,
  };
  if (role === 'user') {
    /*
     * Notkę rozpoznaje POCHODZENIE wpisu, nie jego tekst — prompt człowieka ze znacznikiem
     * w treści `origin.kind === 'task-notification'` nie ma. Ta sama funkcja obsługuje ścieżkę
     * na żywo (follower) i historię (`parseTranscriptTail`), więc obie dają ten sam wynik.
     */
    if (parsed.message !== null && isTaskNotificationOrigin(entry.origin)) {
      parsed.message.notice = noticeFromText(rawUserText(message.content));
    }
    // CLI 2.1.299 writes `/compact` also as this plain entry, before its call entry (`FileEchoPairing`).
    const plain = parsed.message === null ? undefined : plainFileEchoOf(rawUserText(message.content));
    if (plain !== undefined) parsed.fileEcho = plain;
    return parsed;
  }

  // Model i effort niesie WYŁĄCZNIE wpis asystenta. `<synthetic>` (błąd API zapisany jako
  // wiadomość) nie przechodzi wzorca identyfikatora i dlatego nie zatruwa pigułki modelu.
  const model = asString(message.model);
  if (MODEL_ID_PATTERN.test(model)) parsed.model = model;
  const effort = asString(entry.effort);
  const known = EFFORT_LEVELS.find((level) => level === effort);
  if (known !== undefined) parsed.effort = known;
  return parsed;
}

export interface ParseTailOptions {
  /** Pomiń pierwszą linię (ogon uciętego pliku zaczyna się w środku wpisu). */
  dropFirstLine: boolean;
  limit?: number;
  /** Rozpoznanie promptu zablokowanego przez hook — patrz {@link ImportLineOptions.promptBlock}. */
  promptBlock?: boolean;
  /**
   * `true` = the list also carries what the turn segmentation needs (`herdr/input-segments.ts`): hidden turn inputs
   * and main compaction boundaries as marks ({@link ImportedMessage.turnMark}), which also end a merged assistant
   * message, the time of the last entry of a merged assistant message ({@link ImportedMessage.lastAt}) and the
   * identity of the entry behind each `user`-role message ({@link ImportedMessage.entryId}). Off for the transcript:
   * its messages stay as they are.
   */
  turnMarks?: boolean;
}

/** A mark of the turns from a line that gives no message (`ParseTailOptions.turnMarks`); `null` = not one. */
function turnMarkOf(line: string): ImportedMessage | null {
  const raw = parseJsonlEntry(line);
  const mark = isHiddenTurnInput(raw) ? 'hidden' : isMainCompactBoundary(raw) ? 'compaction' : null;
  if (mark === null) return null;
  const at = asString((raw as RawEntry).timestamp);
  return mark === 'hidden'
    ? { role: 'user', blocks: [], at, turnMark: mark, entryId: entryIdOf(line, raw) }
    : { role: 'system', blocks: [], at, turnMark: mark };
}

/** {@link ImportedMessage.entryId} of a line: its `uuid`, else a hash of the line. */
function entryIdOf(line: string, raw: unknown = parseJsonlEntry(line)): string {
  const uuid = typeof raw === 'object' && raw !== null ? (raw as { uuid?: unknown }).uuid : undefined;
  if (typeof uuid === 'string' && uuid !== '') return uuid;
  return `line:${createHash('sha256').update(line.trim()).digest('base64url')}`;
}

/**
 * Buduje transkrypt z tekstu ogona pliku.
 *
 * Sklejanie: CLI zapisuje KAŻDY blok odpowiedzi jako osobną linię `assistant` (tekst, potem
 * `tool_use`, potem kolejny tekst), a między nimi wpisy `user` z samym `tool_result` (fixture
 * `tasks/incydent-gotowe-po-postoju-2.1.301/glowny.jsonl`). Bez
 * sklejania jedna tura agenta rozpadłaby się w UI na kilkanaście „wiadomości". Sklejamy więc
 * kolejne wpisy asystenta do jednej wiadomości, a przerywa je dopiero wpis użytkownika, który
 * FAKTYCZNIE coś niesie (czyli nie sam wynik narzędzia).
 */
export function parseTranscriptTail(text: string, opts: ParseTailOptions): ImportedTranscript {
  const lines = text.split('\n');
  if (opts.dropFirstLine) lines.shift();

  const messages: ImportedMessage[] = [];
  let openTurn: ImportedMessage | null = null;
  const result: ImportedTranscript = { messages };
  const fileEcho = new FileEchoPairing();

  for (const line of lines) {
    const entry = parseImportLine(line, opts.promptBlock === false ? { promptBlock: false } : {});
    if (entry === null) {
      // A mark stays out of the "/compact" pairing, as every entry without a parse result does.
      const mark = opts.turnMarks === true ? turnMarkOf(line) : null;
      if (mark !== null) {
        openTurn = null;
        messages.push(mark);
      }
      continue;
    }
    if (fileEcho.repeats(entry.fileEcho, entry.message !== null)) continue;
    if (entry.model !== undefined) result.model = entry.model;
    if (entry.effort !== undefined) result.effort = entry.effort;
    if (entry.uploadFiles !== undefined) {
      // Towarzysz stoi BEZPOŚREDNIO za wiadomością człowieka; bez niej nie ma do czego przypiąć.
      // Notka harnessu wypowiedzią człowieka nie jest i zdjęć Raroga nie dostaje.
      const last = messages[messages.length - 1];
      if (last !== undefined && last.role === 'user' && last.notice === undefined && last.turnMark === undefined) {
        attachUploadFiles(last, entry.uploadFiles);
      }
      continue;
    }
    if (entry.message === null) continue;

    // Wiadomość człowieka i notka komendy rozcinają sklejaną turę asystenta.
    if (entry.role !== 'assistant') {
      openTurn = null;
      if (opts.turnMarks === true && entry.message.role === 'user') entry.message.entryId = entryIdOf(line);
      messages.push(entry.message);
      continue;
    }
    if (openTurn === null) {
      openTurn = entry.message;
      messages.push(openTurn);
      continue;
    }
    openTurn.blocks.push(...entry.message.blocks);
    if (opts.turnMarks === true) openTurn.lastAt = entry.message.at;
  }

  const limit = opts.limit ?? MAX_TRANSCRIPT_MESSAGES;
  result.messages = messages.slice(-limit);
  return result;
}

// ---------------------------------------------------------------------------
// Odczyt ogona pliku
// ---------------------------------------------------------------------------

/**
 * Czyta ostatnie `maxBytes` bajtów pliku.
 *
 * Świadomie przez `open` + `read` z offsetu, a nie `readFile`: pliki magazynu mają dziesiątki
 * MB, a interesuje nas wyłącznie koniec.
 *
 * @returns tekst ogona i informacja, czy plik był dłuższy (czyli czy pierwsza linia jest ucięta),
 *          albo `null`, gdy pliku nie da się otworzyć / odczytać.
 */
async function readTail(
  path: string, maxBytes: number,
): Promise<{ text: string; truncated: boolean } | null> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return null;
    const size = info.size;
    const wanted = Math.min(size, maxBytes);
    if (wanted === 0) return { text: '', truncated: false };
    const buffer = Buffer.alloc(wanted);
    const { bytesRead } = await handle.read(buffer, 0, wanted, size - wanted);
    return {
      text: buffer.subarray(0, bytesRead).toString('utf8'),
      truncated: size > maxBytes,
    };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Czyta ogon transkryptu CLI dla pary (katalog, sesja silnika).
 *
 * Nigdy nie rzuca: brak pliku, brak uprawnień i uszkodzona treść dają pustą listę. Wołający
 * (manager) nie ma czym reagować na taki błąd — historia jest miłym dodatkiem do wznowienia,
 * a nie warunkiem jego powodzenia.
 */
export async function importTranscript(
  cwd: string, engineSessionId: string, opts: TranscriptImportOptions = {},
): Promise<ImportedTranscript> {
  if (!ENGINE_SESSION_ID_PATTERN.test(engineSessionId)) return { messages: [] };
  const root = opts.root ?? defaultStoreRoot();
  const path = join(root, projectSlug(cwd), `${engineSessionId}${TRANSCRIPT_EXT}`);
  const tail = await readTail(path, opts.maxBytes ?? MAX_IMPORT_BYTES);
  if (tail === null) return { messages: [] };
  const parseOpts: ParseTailOptions = { dropFirstLine: tail.truncated };
  if (opts.limit !== undefined) parseOpts.limit = opts.limit;
  return parseTranscriptTail(tail.text, parseOpts);
}
