/**
 * The history path of a Claude Code conversation file, from the file tail to the messages the session manager
 * appends: the read of the tail (window doubling up to a message count or a byte ceiling), the follower's step per
 * imported entry (a blocked prompt as a note, an entry claimed by an echo of a send from Rarog) and the driver's step
 * (the command output mark stays with the driver). Shared by `jsonl-follow.ts`, `drivers/herdr-driver.ts` and the
 * voice agent's turns route, so all three see the same messages for the same file. It keeps no state: the echo
 * ledger and the command pairing stay in the follower and reach the loop through {@link HistoryLoopPort}.
 */
import { open, stat } from 'node:fs/promises';
import type { MessageAttachment, TranscriptNotice } from '@rarog/shared';
import type { InternalBlock } from '../drivers/types.ts';
import { parseTranscriptTail } from '../transcript-import.ts';
import type { ImportedMessage } from '../transcript-import.ts';
import { promptBlockedField } from './commands/index.ts';

export interface FollowMessage {
  role: 'user' | 'assistant' | 'system';
  blocks: InternalBlock[];
  at: string;
  /** Wizytówki zdjęć Raroga z importu historii — patrz `ImportedMessage.attachments`. */
  attachments?: MessageAttachment[];
  /** Notka harnessu — patrz `ImportedMessage.notice`. */
  notice?: TranscriptNotice;
  /** Wpis promptu wysłanego z Raroga z echem odroczonym — patrz wariant `message`. */
  echoToken?: string;
  /** Notka z wynikiem komendy lokalnej — patrz wariant `message`. */
  commandOutput?: string;
  /**
   * Notka o prompcie zablokowanym przez hook, który NIE trafił w echo wysyłki (historia: prompt spoza Raroga
   * albo sprzed restartu serwera). Kształt pola `TranscriptMessage.promptBlocked`; bloki niosą notkę z cytatem.
   */
  promptBlocked?: { reason: string; prompt?: string };
  /** A mark of the turns, only in a read with `turnMarks` — see `ImportedMessage.turnMark`. */
  turnMark?: 'hidden' | 'compaction';
  /** Time of the last entry of a merged assistant message, only with `turnMarks` — see `ImportedMessage.lastAt`. */
  lastAt?: string;
  /** Identity of the file entry of a `user`-role message, only with `turnMarks` — see `ImportedMessage.entryId`. */
  entryId?: string;
}

// ---------------------------------------------------------------------------
// Odczyt pliku (niskopoziomowy, nigdy nie rzuca)
// ---------------------------------------------------------------------------

export async function sizeOf(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

export async function readRange(
  path: string, start: number, length: number,
): Promise<{ text: string; bytesRead: number } | null> {
  if (length <= 0) return { text: '', bytesRead: 0 };
  let handle;
  try {
    handle = await open(path, 'r');
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return { text: buffer.subarray(0, bytesRead).toString('utf8'), bytesRead };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Ogon pliku przygotowany jako historia — wynik `#readHistory`. */
export interface HistoryTail {
  /** Linie zakończone `\n`: kompletne wpisy, gotowe do parsowania i do `#noteRaw`. */
  complete: string;
  /** Ogon bez `\n` — wpis w trakcie zapisu, zostaje w buforze followera. */
  partial: string;
  /** Pozycja ZA ostatnim przeczytanym bajtem (niezmiennik `#offset`). */
  offset: number;
  /**
   * Bajt, od którego okno zostało przeczytane; `0` = okno obejmuje plik od początku. Gdy jest
   * większy, pierwsza linia okna była ucięta i wypadła: wszystko do jej `\n` włącznie należy do
   * przeglądu zadań w tle (`#primeTasks`).
   */
  start: number;
  /** Wiadomości okna: sklejone tury asystenta, przycięte do sufitu. */
  messages: ImportedMessage[];
}

/** Read of one byte range of the file; `null` = the read failed (no file, no access). */
export type ReadRange = (path: string, start: number, length: number) => Promise<{
  text: string; bytesRead: number;
} | null>;

/** Window and stop of {@link readHistoryTail}. */
export interface HistoryReadOptions {
  /** First window in bytes, doubled each round. */
  readonly firstWindow: number;
  /** Byte ceiling of the window. */
  readonly maxBytes: number;
  /** Messages the parser keeps (from the end); reaching it stops the read. */
  readonly limit: number;
  /** `false` = a prompt blocked by a hook is not recognised (`RAROG_PROMPT_BLOCK=0`). */
  readonly promptBlock: boolean;
  /** One more stop: the messages gathered so far are enough for the caller. */
  readonly enough?: (messages: readonly ImportedMessage[]) => boolean;
  /** `true` = the read went stale; the read returns what it has. */
  readonly stale?: () => boolean;
  /** `true` = the messages carry the marks of the turns (`ParseTailOptions.turnMarks`); never for the transcript. */
  readonly turnMarks?: boolean;
}

/**
 * Ogon pliku jako historia — okno rośnie, aż uzbiera WIADOMOŚCI.
 *
 * Warunek stopu jest jeden i mierzony w tej samej walucie, w której obiecuje deklaracja:
 * `parseTranscriptTail` zebrał `#historyMessages` sztuk. Stałe okno bajtowe mierzyło coś
 * innego niż obiecywało, bo bajty jsonl to w większości `tool_result`, którego import nie
 * pokazuje (p. 2 nagłówka pliku).
 *
 * Porcja się PODWAJA, a nie dokłada po kawałku: przy stałym kroku plik dobijający do sufitu
 * kosztowałby kwadrat liczby obrotów, przy podwajaniu — najwyżej dwa sufity. Każdy obrót
 * czyta CAŁY zakres `[start, size)` od nowa (a nie doklejany kawałek): sklejanie fragmentów
 * po stronie tekstu rozcinałoby wielobajtowe znaki UTF-8 na granicy porcji.
 *
 * @returns ogon albo `null`, gdy NIE UDAŁ SIĘ pierwszy odczyt (pliku nie ma / brak dostępu);
 *          awaria dociągania oddaje to, co już zebrano — mniej historii jest lepsze niż alarm
 *          „brak transkryptu" o pliku, który właśnie przeczytaliśmy.
 */
export async function readHistoryTail(
  read: ReadRange, path: string, size: number, opts: HistoryReadOptions,
): Promise<HistoryTail | null> {
  let window = opts.firstWindow;
  let tail: HistoryTail | null = null;
  for (;;) {
    const start = Math.max(0, size - window);
    const chunk = await read(path, start, size - start);
    // Nieaktualny odczyt (`/clear` w szczelinie) — wołający sprawdza `#stale` po powrocie.
    if (opts.stale?.() === true || chunk === null) return tail;

    let text = chunk.text;
    // Ogon zaczyna się w środku wpisu — pierwsza linia jest ucięta i nie jest JSON-em.
    if (start > 0) {
      const first = text.indexOf('\n');
      text = first === -1 ? '' : text.slice(first + 1);
    }
    // Ostatnia linia może być właśnie zapisywana — zostawiamy ją w buforze zamiast zgubić.
    // Niezmiennik całego modułu: `#offset` stoi za WSZYSTKIMI przeczytanymi bajtami,
    // a `#partial` trzyma ogon bez `\n` w pamięci. Offset przed niedokończoną linią
    // oznaczałby, że następny odczyt doklei te same bajty drugi raz i rozbije JSON.
    const cut = text.lastIndexOf('\n');
    const complete = cut === -1 ? '' : text.slice(0, cut + 1);
    const parsed = parseTranscriptTail(complete, {
      dropFirstLine: false, limit: opts.limit, ...(opts.promptBlock ? {} : { promptBlock: false }),
      ...(opts.turnMarks === true ? { turnMarks: true } : {}),
    });
    tail = {
      complete,
      partial: cut === -1 ? text : text.slice(cut + 1),
      offset: start + chunk.bytesRead,
      start,
      messages: parsed.messages,
    };

    if (parsed.messages.length >= opts.limit || opts.enough?.(parsed.messages) === true) return tail;
    // Przeczytany cały plik albo sufit — więcej historii po prostu NIE MA skąd wziąć.
    if (start === 0 || window >= opts.maxBytes) return tail;
    window = Math.min(window * 2, opts.maxBytes);
  }
}

// ---------------------------------------------------------------------------
// Krok followera: wpis importu → wiadomość historii
// ---------------------------------------------------------------------------

/** What the loop reads of a blocked prompt's outcome (the follower's `prompt-blocked` event). */
export interface BlockedPromptOutcome {
  readonly reason: string;
  readonly prompt?: string;
  /** The entry matched the echo of a send from Rarog: the event goes out instead of a note. */
  readonly echoed: boolean;
}

/** The follower's state the loop needs: echo ledger, command pairing and the emitter of a mid-history event. */
export interface HistoryLoopPort<B extends BlockedPromptOutcome> {
  /** A blocked prompt entry → its outcome; `null` = the entry carries no blocked prompt field. */
  promptBlocked(message: ImportedMessage): B | null;
  /** An imported entry → a follower message (`command` turned into `commandOutput`). */
  follow(message: ImportedMessage): FollowMessage;
  /** The entry claimed by an echo of a send from Rarog; `null` = no echo. */
  takeEcho(message: ImportedMessage, command: boolean): { readonly token?: string } | null;
  /** History up to an echoed blocked prompt goes out first, then the prompt's own event. */
  flush(messages: FollowMessage[], blocked: B): void;
}

/**
 * Wiadomości historii z wpisów okna, w kolejności pliku; zwraca porcję, która jeszcze nie wyszła.
 *
 * Echo wycinamy TAKŻE z historii, nie tylko z tailu.
 *
 * Panel ze świeżą sesją silnika (nowy `claude` albo `/clear`) nie ma jeszcze pliku, więc
 * follower czeka. Plik tworzy dopiero PIERWSZY prompt — i jest to prompt wysłany z Raroga,
 * po którym manager ma już swoje lokalne echo. Bez tego filtra cała zawartość takiego pliku
 * wchodzi kanałem `history` i użytkownik widzi swoje zdanie dwa razy (zmierzone na żywo).
 */
export function historyMessages<B extends BlockedPromptOutcome>(
  entries: readonly ImportedMessage[], port: HistoryLoopPort<B>,
): FollowMessage[] {
  // Notka harnessu nie jest promptem: nie zjada wpisu echa i nie jest nim gaszona.
  // Wpis z tokenem echa odroczonego zostaje NA SWOJEJ POZYCJI historii z polem
  // `echoToken`: manager podstawi w to miejsce wstrzymaną wiadomość.
  // Wywołanie komendy to też echo: komenda wysłana z Raroga stoi w transkrypcie od wysyłki
  // dymkiem `user`, a jej wpis z pliku byłby drugą kopią (notką `system` albo drugim dymkiem).
  /*
   * Prompt zablokowany przez hook: wpis, który trafił w echo wysyłki z Raroga (pierwszy prompt świeżej
   * sesji zakłada plik, więc przychodzi właśnie tędy), działa jak blokada na żywo — historia do niego
   * wychodzi, potem zdarzenie `prompt-blocked`, potem reszta historii. Wpis bez trafienia zostaje notką
   * z cytatem na swojej pozycji.
   */
  let messages: FollowMessage[] = [];
  for (const m of entries) {
    if (m.command?.part === 'prompt-blocked') {
      const event = port.promptBlocked(m);
      if (event === null) continue;
      if (event.echoed) {
        port.flush(messages, event);
        messages = [];
      } else {
        // Pole na drut przycięte jak notka (sufit wiadomości); pełny cytat służył tylko dopasowaniu echa.
        messages.push({
          role: 'system', blocks: m.blocks, at: m.at, promptBlocked: promptBlockedField(event.reason, event.prompt),
        });
      }
      continue;
    }
    const follow = port.follow(m);
    const command = m.command !== undefined;
    const echoable = m.notice === undefined && (command ? m.command?.part === 'invocation' : m.role === 'user');
    const echo = echoable ? port.takeEcho(m, command) : null;
    if (echo === null) messages.push(follow);
    else if (echo.token !== undefined) messages.push({ ...follow, echoToken: echo.token });
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Krok drivera: wiadomości dla managera
// ---------------------------------------------------------------------------

/** A history message as the session manager gets it: the follower message without the command output mark. */
export type ManagerHistoryMessage = Omit<FollowMessage, 'commandOutput'>;

/**
 * Znacznik wyniku komendy jest dla drivera: manager dostaje wiadomości bez niego.
 *
 * @returns the messages for the manager and the name of the last command output in the batch, if any.
 */
export function withoutCommandOutput(messages: readonly FollowMessage[]): {
  messages: ManagerHistoryMessage[]; output: string | undefined;
} {
  let output: string | undefined;
  const stripped = messages.map(({ commandOutput, ...message }) => {
    if (commandOutput !== undefined) output = commandOutput;
    return message;
  });
  return { messages: stripped, output };
}

// ---------------------------------------------------------------------------
// Read on request: no send from Rarog in flight
// ---------------------------------------------------------------------------

/**
 * The follower's step for a read with no send from Rarog in flight: no entry is claimed by an echo, so a blocked
 * prompt stays a note. The command pairing is not needed: the driver's step drops its mark anyway.
 */
const NO_ECHO: HistoryLoopPort<BlockedPromptOutcome> = {
  promptBlocked: (m) => (m.promptBlocked === undefined ? null : {
    reason: m.promptBlocked.reason, echoed: false,
    ...(m.promptBlocked.prompt === undefined ? {} : { prompt: m.promptBlocked.prompt }),
  }),
  follow: ({ command: _command, ...message }) => message,
  takeEcho: () => null,
  flush: () => undefined,
};

/**
 * The history steps of a read that no follower owns (a route reading the file on request): the follower's step
 * without an echo, then the driver's step. The messages are the ones the session appends from history.
 */
export function historyWithoutEcho(entries: readonly ImportedMessage[]): ManagerHistoryMessage[] {
  return withoutCommandOutput(historyMessages(entries, NO_ECHO)).messages;
}
