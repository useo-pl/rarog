/**
 * Komenda w pliku rozmowy Claude Code → wiadomość transkryptu Raroga.
 *
 * CLI zapisuje slash-komendę i jej wynik wpisami, których NIKT nie napisał: nazwa i argumenty
 * w znacznikach (`<command-name>`, `<command-args>`), wynik w `<local-command-stdout>` (z SGR), komendę
 * nieznaną jako ostrzeżenie „Unknown command” (zmierzone na CLI 2.1.302, fixture'y `commands/measured/`).
 * Bez tego komenda
 * wykonana z telefonu albo z terminala nie zostawiłaby w apce śladu. Tu zapada, CO z takiego wpisu widać:
 *
 * - komenda LOKALNA (wpis `system` z podtypem komendy lokalnej albo wpis `user` z nazwą, która w rejestrze
 *   ma `kind: local|panel`) → notka `system` „/nazwa args”; nie jest wejściem tury;
 * - wynik komendy lokalnej → osobna notka `system` bez sekwencji terminala, najwyżej
 *   {@link COMMAND_OUTPUT_MAX_BYTES} (reszta za {@link COMMAND_OUTPUT_CLIP}); pusty wynik → nic;
 * - komenda PROMPT (skill z dysku, wbudowany skill, `/init`) → wiadomość `user` „/nazwa args”: to
 *   prawdziwe wejście tury, a tekst jest ten sam, który Rarog wysłał (aliasy nie przechodzą),
 *   więc echo serwera dopasowuje go bez zmian;
 * - ostrzeżenie „Unknown command:” / „Args from unknown skill:” → notka `system`;
 * - the registry rule `fileEcho` (`/compact`): the call is marked, and so is the plain `user` entry with the same
 *   call that CLI 2.1.299 writes before it; the reader keeps one of the two ({@link FileEchoPairing}).
 *
 * The send path asks {@link silentInTurn} whether the CLI writes the command's call and output at all when it is
 * sent while a turn runs (the registry's `inTurn` rule, measured on CLI 2.1.325).
 *
 * Nazwa spoza rejestru (skill z dysku, komenda pluginu, komenda nowszego CLI): wpis jest promptem tylko
 * wtedy, gdy CLI oznaczył go jako wejście tury (`origin.kind` albo `turnOrigin` — tak zapisuje się
 * wywołanie skilla, zmierzone na 2.1.294, fixture `skill-doctor-2.1.294.jsonl`; komendy lokalne tych pól
 * nie mają, pomiar 2.1.302). Bez znacznika zostaje notką `system`: komenda lokalna wzięta za prompt
 * udawałaby wejście tury, prompt wzięty za notkę traci najwyżej dymek (`docs/slash-commands.md`).
 *
 * Mapowanie jest BEZSTANOWE: jeden wpis → najwyżej jedna wiadomość, bez patrzenia na sąsiednie wpisy
 * (follower czyta plik partiami, a historia od dowolnego miejsca). Wołający (`transcript-import.ts`)
 * stosuje je PO filtrach `isSidechain`, `isCompactSummary` i `isMeta` (zastrzeżenie, Markdown `/context`
 * i treść skilla zostają niewidoczne). Słowa CLI stoją w rejestrze (`registry.ts`); tu jest gramatyka.
 * The one state across entries is {@link FileEchoPairing}, which each reader runs over the parsed entries in file
 * order.
 *
 * Tu mieszka też rozpoznanie promptu ZABLOKOWANEGO przez hook `UserPromptSubmit` (część `prompt-blocked`):
 * ten sam wpis `informational` z poziomem `warning`, który CLI pisze zamiast wpisu `user`. Rozpoznanie idzie
 * po STRUKTURZE (`promptSubmitEnding.ending.kind`), nie po treści komunikatu konkretnego hooka
 * (`docs/dialogs.md`, „Prompt blocked by a hook”).
 */
import { foreign, say } from '@rarog/shared/sentences';
import type { AnyText, ServerSentence } from '@rarog/shared/sentences';
import { stripTerminalControl } from '../dialogs/screen/text.ts';
import { BUILTIN_COMMANDS, BUNDLED_SKILLS, TRANSCRIPT_ENTRY, TRANSCRIPT_TAGS } from './registry.ts';
import type { SlashCommand } from './shape.ts';

/** Sufit tekstu jednej notki z wynikiem komendy (bajty UTF-8, razem ze stopką ucięcia). */
export const COMMAND_OUTPUT_MAX_BYTES = 8 * 1024;
/** Stopka notki uciętej na suficie — ten sam znak nożyczek co podgląd w karcie pytania. */
export const COMMAND_OUTPUT_CLIP = '✂ …';

/**
 * Który wpis niesie wiadomość: wywołanie komendy, jej wynik, ostrzeżenie o komendzie nieznanej albo prompt
 * zablokowany przez hook `UserPromptSubmit` (`prompt-blocked`).
 */
export type CommandNotePart = 'invocation' | 'output' | 'notice' | 'prompt-blocked';

/**
 * Prompt zablokowany przez hook — fakty ze STRUKTURY wpisu `promptSubmitEnding` (`ending.kind ===
 * blocked_by_hook`). `reason` to powód od hooka bez sekwencji terminala; `prompt` to cytat promptu z treści
 * wpisu po normalizacji wołającego (import: `humanTextOf`), nieobecny, gdy wpis go nie niesie.
 */
export interface PromptBlock {
  readonly reason: string;
  readonly promptKept: boolean;
  readonly prompt?: string;
}

/** Wiadomość z wpisu komendy. */
export interface CommandNote {
  /** `user` wyłącznie dla wywołania komendy typu prompt; reszta to notki `system`. */
  readonly role: 'user' | 'system';
  /** Wywołanie, wynik i ostrzeżenie CLI to treść obca (`foreign`); notka o blokadzie promptu — tekst Raroga. */
  readonly text: AnyText;
  readonly part: CommandNotePart;
  /**
   * Nazwa komendy małymi literami, bez ukośnika: z wpisu wywołania, a z wyniku tylko wtedy, gdy wpis ją
   * niesie (`commandRun` wpisu `system`). Wynik wpisem `user` jej nie ma — dopisuje ją follower.
   */
  readonly name?: string;
  /** Wyłącznie przy części `prompt-blocked`. */
  readonly blocked?: PromptBlock;
  /** The call of a command with the registry rule `fileEcho`: {@link FileEchoPairing} decides whether it stays. */
  readonly fileEcho?: true;
}

/**
 * One carrier of a command with the registry rule `fileEcho` (`/compact`): `plain` — the plain `user` entry with the
 * call's text, `call` — the entry with `<command-name>`. CLI 2.1.299 writes both, the plain one first; CLI 2.1.328
 * writes only the call (fixtures `queue/measured/compact-2.1.299.jsonl`, `compact-2.1.328.jsonl`).
 */
export interface FileEchoMark {
  readonly carrier: 'plain' | 'call';
  /** Command name in lower case, without the slash. */
  readonly name: string;
}

/**
 * Keeps one carrier per call of a `fileEcho` command, read in file order: a call entry right after the plain entry of
 * the same command repeats it and is dropped; a call entry without that plain entry stays. Entries without a message
 * (queue operations, the compaction boundary and summary, the caveat) stand between the two carriers and keep the
 * pair; any message ends it, so a plain entry never swallows a later call. One instance per reader of one file.
 */
export class FileEchoPairing {
  #plain = '';

  /** `true` = drop this entry. `mark` — the entry's carrier mark, `message` — the entry gives a message. */
  repeats(mark: FileEchoMark | undefined, message: boolean): boolean {
    if (mark?.carrier === 'call') {
      const repeated = this.#plain === mark.name;
      this.#plain = '';
      return repeated;
    }
    this.#plain = mark?.carrier === 'plain' ? mark.name : message ? '' : this.#plain;
    return false;
  }

  /** A new file: a plain entry of the old one pairs with nothing. */
  reset(): void {
    this.#plain = '';
  }
}

/** Opcje {@link systemEntryNote}. */
export interface SystemEntryOptions {
  /**
   * Rozpoznanie promptu zablokowanego przez hook (`RAROG_PROMPT_BLOCK` ≠ `0`, domyślnie włączone). `false`
   * = zachowanie sprzed rozpoznania: taki wpis to `undefined`, jak każdy nieznany wpis `informational`.
   */
  readonly promptBlock?: boolean;
  /**
   * Normalizacja cytatu promptu (import: `humanTextOf` — `[Image #N]` i obwódka wklejki). Ten sam
   * znormalizowany tekst idzie do dopasowania echa i do cytatu w notce. Brak = cytat dosłowny.
   */
  readonly normalizePrompt?: (raw: string) => string;
}

/**
 * Treść notki o prompcie zablokowanym przez hook: tytuł, pod nim powód od hooka, a przy `prompt` jeszcze
 * cytat (linia `Prompt: …`). Cytat dostaje tylko notka bez dymka promptu (prompt spoza Raroga albo z historii
 * bez echa), bo prompt wysłany z Raroga stoi w transkrypcie od wysyłki. Powód i cytat przycięte jak wynik komendy.
 */
export function promptBlockedText(reason: string, prompt?: string): ServerSentence {
  // Powód i cytat przycięte PRZED `say()`: argumenty są już po cięciu, więc tłumaczenie w apce nie odtworzy
  // treści, której tekst nie pokazuje, a znacznik ucięcia stoi w argumencie tak samo jak w tekście.
  const quoted = prompt !== undefined && prompt !== '' ? clipCommandOutput(prompt) : null;
  if (reason === '') {
    return quoted === null ? say('commands.prompt-blocked') : say('commands.prompt-blocked.prompt', { prompt: quoted });
  }
  const clipped = clipCommandOutput(reason);
  return quoted === null
    ? say('commands.prompt-blocked.reason', { reason: clipped })
    : say('commands.prompt-blocked.reason-and-prompt', { reason: clipped, prompt: quoted });
}

/**
 * Wynik mapowania: `undefined` — wpis nie jest wpisem komendy (wołający stosuje swoje reguły), `null` —
 * wpis komendy bez niczego do pokazania (pusty wynik, znacznik bez nazwy).
 */
export type CommandEntryResult = CommandNote | null | undefined;

type EntryKind = 'local' | 'prompt';

/** Rodzaj wbudowanej komendy i skilla po nazwie i aliasie (małymi literami). */
const REGISTRY_KINDS: ReadonlyMap<string, EntryKind> = (() => {
  const kinds = new Map<string, EntryKind>();
  for (const entry of BUILTIN_COMMANDS) {
    const kind: EntryKind = entry.kind === 'prompt' ? 'prompt' : 'local';
    for (const word of [entry.name, ...entry.aliases]) kinds.set(word.toLowerCase(), kind);
  }
  for (const entry of BUNDLED_SKILLS) {
    for (const word of [entry.name, ...entry.aliases]) kinds.set(word.toLowerCase(), 'prompt');
  }
  return kinds;
})();

/** Names (and aliases) of commands with the registry rule `fileEcho`: two carriers of one call ({@link FileEchoMark}). */
const FILE_ECHO_NAMES: ReadonlySet<string> = new Set(BUILTIN_COMMANDS
  .filter((entry) => entry.fileEcho === 'plain-user-entry')
  .flatMap((entry) => [entry.name, ...entry.aliases].map((word) => word.toLowerCase())));

/** Names (and aliases) of local commands that the CLI runs inside a turn without a call or output entry. */
const SILENT_IN_TURN_NAMES: ReadonlySet<string> = new Set(BUILTIN_COMMANDS
  .filter((entry) => entry.inTurn?.rule === 'silent')
  .flatMap((entry) => [entry.name, ...entry.aliases].map((word) => word.toLowerCase())));

/**
 * Whether this local command, sent while a turn runs, leaves no call and no output in the transcript: nothing there
 * clears its echo or ends it, and the turn ends with herdr's own state change.
 */
export function silentInTurn(slash: SlashCommand): boolean {
  return slash.kind === 'local' && SILENT_IN_TURN_NAMES.has(slash.name.toLowerCase());
}

const tag = (name: string): string => `<${name}>`;
const segment = (name: string): RegExp => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`);

/** Wpis wywołania: tekst zaczyna się znacznikiem nazwy albo opisu komendy (kolejność zależy od komendy). */
const INVOCATION_START = new RegExp(
  `^\\s*(?:${tag(TRANSCRIPT_TAGS.commandName)}|${tag(TRANSCRIPT_TAGS.commandMessage)})`,
);
const NAME_SEGMENT = segment(TRANSCRIPT_TAGS.commandName);
const ARGS_SEGMENT = segment(TRANSCRIPT_TAGS.commandArgs);
/** Nazwa zapisana przez CLI: ukośnik i znaki bez spacji i nawiasów ostrych (`/config`, `/pr-review-toolkit:review-pr`). */
const RECORDED_NAME = /^\/[^\s<>]+$/;

/** Wpis wyniku: tekst zaczyna się znacznikiem wyjścia komendy lokalnej. */
const OUTPUT_START = new RegExp(`^\\s*<(?:${TRANSCRIPT_TAGS.stdout}|${TRANSCRIPT_TAGS.stderr})>`);
const OUTPUT_SEGMENTS = new RegExp(
  `<(${TRANSCRIPT_TAGS.stdout}|${TRANSCRIPT_TAGS.stderr})>([\\s\\S]*?)</\\1>`, 'g',
);

/** Tekst dla człowieka: bez sekwencji terminala, bez spacji na końcach linii i pustych brzegów. */
function readable(text: string): string {
  return stripTerminalControl(text).split('\n').map((line) => line.trimEnd()).join('\n').trim();
}

/**
 * Pole `TranscriptMessage.promptBlocked` notki: powód i cytat przycięte jak w treści notki
 * ({@link COMMAND_OUTPUT_MAX_BYTES} każdy). Pełny cytat zostaje u wołającego do dopasowania echa — na drut
 * idzie tylko ta kopia, inaczej wklejka z terminala ominęłaby sufit wiadomości.
 */
export function promptBlockedField(reason: string, prompt?: string): { reason: string; prompt?: string } {
  return { reason: clipCommandOutput(reason), ...(prompt === undefined ? {} : { prompt: clipCommandOutput(prompt) }) };
}

/** Tekst ucięty na {@link COMMAND_OUTPUT_MAX_BYTES} bajtach UTF-8, ze stopką; znak nie pęka w środku. */
export function clipCommandOutput(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= COMMAND_OUTPUT_MAX_BYTES) return text;
  const footer = `\n${COMMAND_OUTPUT_CLIP}`;
  const budget = COMMAND_OUTPUT_MAX_BYTES - Buffer.byteLength(footer, 'utf8');
  // `encodeInto` pisze wyłącznie całe znaki, a `read` mówi, ile jednostek UTF-16 się zmieściło.
  const { read } = new TextEncoder().encodeInto(text, new Uint8Array(budget));
  return `${text.slice(0, read).trimEnd()}${footer}`;
}

/** Nazwa i tekst wywołania; `null` — znacznik komendy bez nazwy w znanym kształcie. */
function invocationOf(text: string): { name: string; text: string } | null {
  const recorded = NAME_SEGMENT.exec(text)?.[1]?.trim() ?? '';
  if (!RECORDED_NAME.test(recorded)) return null;
  const args = readable(ARGS_SEGMENT.exec(text)?.[1] ?? '');
  return { name: recorded.slice(1).toLowerCase(), text: args === '' ? recorded : `${recorded} ${args}` };
}

/** Tekst wyniku (pusty = nic do pokazania); `undefined` — tekst nie jest wpisem wyniku. */
function outputOf(text: string): string | undefined {
  if (!OUTPUT_START.test(text)) return undefined;
  const parts = [...text.matchAll(OUTPUT_SEGMENTS)].map((hit) => readable(hit[2] ?? '')).filter((part) => part !== '');
  return clipCommandOutput(parts.join('\n'));
}

function outputNote(text: string, name: string | undefined): CommandNote | null {
  if (text === '') return null;
  return { role: 'system', text: foreign(text), part: 'output', ...(name === undefined || name === '' ? {} : { name }) };
}

/** Nazwa komendy z pola `commandRun` wpisu wyniku (`{command, args}`), małymi literami. */
function commandRunName(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const command = (value as Record<string, unknown>)['command'];
  return typeof command === 'string' && command.trim() !== '' ? command.trim().toLowerCase() : undefined;
}

/** Obiekt JSON-a albo `undefined` — do schodzenia po polach wpisu bez rzutowań w każdej linii. */
function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : undefined;
}

/**
 * Prompt zablokowany przez hook (`ending.kind === blocked_by_hook`) albo `undefined` dla każdego innego wpisu,
 * także `stopped_by_hook` (prompt stoi wtedy w zwykłym wpisie `user`, poza zakresem) i rodzajów, których pomiar
 * nie wywołał. Cytat promptu: tekst za PIERWSZYM separatorem cytatu stojącym ZA końcem powodu w `content`
 * (powód bywa wielolinijkowy i sam może zawierać separator); brak separatora = cytatu nie ma.
 */
function promptBlockOf(
  entry: Readonly<Record<string, unknown>>, content: string, normalize: ((raw: string) => string) | undefined,
): PromptBlock | undefined {
  const ending = record(entry[TRANSCRIPT_ENTRY.promptSubmitEnding]);
  const kind = record(ending?.['ending']);
  if (ending === undefined || kind === undefined || kind['kind'] !== TRANSCRIPT_ENTRY.blockedByHook) return undefined;
  const rawReason = typeof kind['reason'] === 'string' ? kind['reason'] : '';
  const promptKept = ending[TRANSCRIPT_ENTRY.promptKept] === true;
  const reasonAt = rawReason === '' ? -1 : content.indexOf(rawReason);
  const separator = `\n\n${TRANSCRIPT_ENTRY.originalPrompt}`;
  const quoteAt = content.indexOf(separator, reasonAt < 0 ? 0 : reasonAt + rawReason.length);
  const reason = readable(rawReason);
  if (quoteAt < 0) return { reason, promptKept };
  const raw = content.slice(quoteAt + separator.length);
  return { reason, promptKept, prompt: normalize === undefined ? raw : normalize(raw) };
}

/**
 * Wpis `system` pliku rozmowy (bez `isMeta`, poza sidechainem). Rozpoznaje trzy kształty: wpis komendy
 * lokalnej (wywołanie albo wynik), ostrzeżenie o komendzie nieznanej i prompt zablokowany przez hook
 * (część `prompt-blocked` z faktami w `blocked`, treść notki z {@link promptBlockedText} z cytatem); reszta
 * wpisów `system` (koniec tury, granica kompakcji…) to `undefined`.
 */
export function systemEntryNote(
  entry: Readonly<Record<string, unknown>>, opts: SystemEntryOptions = {},
): CommandEntryResult {
  const content = typeof entry['content'] === 'string' ? entry['content'] : '';
  if (entry['subtype'] === TRANSCRIPT_ENTRY.localCommand) {
    if (INVOCATION_START.test(content)) {
      const invocation = invocationOf(content);
      return invocation === null
        ? null : { role: 'system', part: 'invocation', name: invocation.name, text: foreign(invocation.text) };
    }
    const output = outputOf(content);
    return output === undefined ? null : outputNote(output, commandRunName(entry[TRANSCRIPT_ENTRY.commandRun]));
  }
  if (entry['subtype'] === TRANSCRIPT_ENTRY.informational && entry['level'] === TRANSCRIPT_ENTRY.warning
    && opts.promptBlock !== false) {
    const blocked = promptBlockOf(entry, content, opts.normalizePrompt);
    if (blocked !== undefined) {
      const text = promptBlockedText(blocked.reason, blocked.prompt);
      return { role: 'system', part: 'prompt-blocked', text, blocked };
    }
  }
  if (entry['subtype'] === TRANSCRIPT_ENTRY.informational && entry['level'] === TRANSCRIPT_ENTRY.warning
    && (content.startsWith(TRANSCRIPT_ENTRY.unknownCommand) || content.startsWith(TRANSCRIPT_ENTRY.unknownSkillArgs))) {
    const text = clipCommandOutput(readable(content));
    return text === '' ? null : { role: 'system', text: foreign(text), part: 'notice' };
  }
  return undefined;
}

/**
 * Tekst wpisu `user` (bez `isMeta`, poza sidechainem). `turnInput` — CLI oznaczył wpis jako wejście tury
 * (`origin.kind` albo `turnOrigin`); rozstrzyga tylko o nazwie spoza rejestru.
 */
export function userEntryNote(text: string, turnInput: boolean): CommandEntryResult {
  if (INVOCATION_START.test(text)) {
    const invocation = invocationOf(text);
    if (invocation === null) return null;
    const kind = REGISTRY_KINDS.get(invocation.name) ?? (turnInput ? 'prompt' : 'local');
    return {
      role: kind === 'prompt' ? 'user' : 'system', part: 'invocation', name: invocation.name, text: foreign(invocation.text),
      ...(FILE_ECHO_NAMES.has(invocation.name) ? { fileEcho: true } : {}),
    };
  }
  const output = outputOf(text);
  return output === undefined ? undefined : outputNote(output, undefined);
}

/** A plain `user` entry text that is the call of a `fileEcho` command ("/compact", with or without arguments). */
const PLAIN_CALL = /^\s*\/(\S+)(?:\s[\s\S]*)?$/;

/** The `plain` carrier mark of a plain `user` entry text (without command tags), or `undefined`. */
export function plainFileEchoOf(text: string): FileEchoMark | undefined {
  const name = PLAIN_CALL.exec(text)?.[1]?.toLowerCase();
  return name !== undefined && FILE_ECHO_NAMES.has(name) ? { carrier: 'plain', name } : undefined;
}
