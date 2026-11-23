/**
 * Condensing a Claude Code conversation file into the text of turns that the ask route's model reads.
 *
 * Output: one block per turn, separated by a blank line.
 *
 *     ### Turn 3 · 2026-11-09T10:00:00.000Z
 *     USER: the human prompt
 *     AGENT: the agent's text
 *     [tool Bash: the command, at most 160 characters]
 *
 * A turn starts at a prompt a human wrote. Left out: tool results, thinking, side conversations of subagents
 * (`isSidechain`), CLI notes (`isMeta`), the compaction summary, CLI plumbing in `user` entries (the command tags of
 * `herdr/commands/registry.ts`), harness notifications about background tasks (by origin, in either form) and
 * interruption entries. Broken lines are skipped.
 *
 * Two ceilings, and the text never pretends to be the whole history:
 * - bytes: a file longer than `maxBytes` is read as a stream from `size - maxBytes`; the first, cut line is dropped
 *   and the text starts with a note that the start of the session was omitted;
 * - characters: when the turns exceed `maxChars`, the oldest whole turns go, with a note "turns 1–N omitted"; when
 *   the newest turn alone exceeds the budget, its middle is cut with a marker.
 *
 * Never throws for file content; an unreadable path gives `null`.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { TRANSCRIPT_TAGS } from '../herdr/commands/registry.ts';
import { isTaskNotificationOrigin } from '../herdr/background/notice.ts';
import { queuedHumanPrompt } from '../herdr/background/queued-prompt.ts';
import { humanTextOf } from '../transcript-import.ts';
import { TRANSCRIPT } from './cli-literals.ts';

/** Bytes read from the end of a conversation file. Conversation files reach tens of MB. */
export const MAX_CONDENSE_BYTES = 64 * 1024 * 1024;

/**
 * Characters of condensed text, counted on the finished text with headers and notes. Sonnet 5 and later run with
 * a 1M-token context in Claude Code by default (https://code.claude.com/docs/en/model-config); the conversations
 * measured gave about 2.9 characters per token, so 1M characters leave room for the instruction, the question and
 * the answer.
 */
export const MAX_CONDENSE_CHARS = 1_000_000;

/** Characters of a tool call's argument. */
export const TOOL_ARGUMENT_CHARS = 160;

export interface CondenseOptions {
  /** Byte ceiling of the read, default {@link MAX_CONDENSE_BYTES}. */
  readonly maxBytes?: number;
  /** Character budget of the text, default {@link MAX_CONDENSE_CHARS}. */
  readonly maxChars?: number;
}

export interface CondensedTranscript {
  /** The condensed text, at most `maxChars` long. */
  readonly text: string;
  /** Turns read (turns omitted by the budget included). */
  readonly turns: number;
  /** Oldest turns left out by the character budget. */
  readonly omittedTurns: number;
  /** Bytes at the start of the file that were not read (0 when the whole file was read). */
  readonly skippedBytes: number;
  /** The newest turn alone exceeded the budget and has its middle cut. */
  readonly cutTurn: boolean;
}

/** Text in `user` entries that nobody wrote: the command tags and system reminders of the CLI. */
const PLUMBING = new RegExp(`^<(?:${Object.values(TRANSCRIPT_TAGS).join('|')})>`, 'u');

/** Tool input fields that name what a call works on, in order of preference. */
const TOOL_ARGUMENT_FIELDS = ['file_path', 'path', 'command', 'pattern', 'description', 'prompt', 'url'] as const;

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text);

interface Turn {
  /** 0 for the part before the first prompt read (its prompt is not in the read part). */
  readonly number: number;
  readonly lines: string[];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function toolLine(block: Record<string, unknown>): string {
  const input = record(block['input']) ?? {};
  const field = TOOL_ARGUMENT_FIELDS.find((name) => input[name] !== undefined && input[name] !== null);
  const argument = field === undefined ? '' : String(input[field]);
  const name = typeof block['name'] === 'string' ? block['name'] : '?';
  return `[tool ${name}: ${clip(argument.replace(/\s+/gu, ' ').trim(), TOOL_ARGUMENT_CHARS)}]`;
}

/** Texts a human wrote in a `user` entry: a bare string or the `text` blocks. */
function humanTexts(content: unknown): string[] {
  const texts = typeof content === 'string'
    ? [content]
    : Array.isArray(content)
      ? content.flatMap((block) => {
        const item = record(block);
        return item?.['type'] === 'text' && typeof item['text'] === 'string' ? [item['text']] : [];
      })
      : [];
  return texts.filter((text) => !PLUMBING.test(text.trim()) && !text.startsWith(TRANSCRIPT.interruptedPrefix))
    .map((text) => humanTextOf(text).trim())
    .filter((text) => text !== '');
}

/** Collects turns line by line; memory stays bounded by dropping turns far beyond the budget. */
class TurnCollector {
  readonly turns: Turn[] = [];
  /** Turns dropped while reading because the kept ones already exceed twice the budget. */
  dropped = 0;
  /** Number of the first turn read: 0 when the read starts inside a turn, else 1. */
  firstNumber = 1;
  private count = 0;
  private keptChars = 0;

  constructor(private readonly maxChars: number) {}

  push(line: string): void {
    if (line.trim() === '') return;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      return;
    }
    const entry = record(value);
    if (entry === null) return;
    if (entry['isMeta'] === true || entry['isSidechain'] === true || entry['isCompactSummary'] === true) return;
    // A harness notification about a background task: a `user` entry nobody wrote, recognized by its origin like
    // the transcript notice (`notice.ts`); its text does not always carry a tag. Its queue-attachment form opens no
    // turn either (`queuedHumanPrompt` lets only a human origin through).
    if (entry['type'] === 'user' && isTaskNotificationOrigin(entry['origin'])) return;
    // A prompt the human sent while the agent was working: the CLI absorbs it into the running turn and leaves only
    // a queue attachment, no `user` entry (`queued-prompt.ts`). It still opens a turn, like a `user` entry.
    const queued = queuedHumanPrompt(entry);
    const content = queued?.prompt ?? record(entry['message'])?.['content'];
    if (entry['type'] === 'user' || queued !== null) {
      const at = queued?.at ?? entry['timestamp'];
      const timestamp = typeof at === 'string' ? at : '';
      for (const text of humanTexts(content)) {
        this.count += 1;
        this.open(this.count, `### Turn ${String(this.count)} · ${timestamp}`);
        this.add(`USER: ${text}`);
      }
    } else if (entry['type'] === 'assistant' && Array.isArray(content)) {
      for (const raw of content) {
        const block = record(raw);
        if (block === null) continue;
        if (block['type'] === 'text' && typeof block['text'] === 'string' && block['text'].trim() !== '') {
          this.add(`AGENT: ${block['text'].trim()}`);
        } else if (block['type'] === 'tool_use') {
          this.add(toolLine(block));
        }
      }
    }
  }

  private open(number: number, header: string): void {
    this.turns.push({ number, lines: [header] });
    this.keptChars += header.length + 1;
    // Turns older than twice the budget can never be kept: drop them now, so a huge file does not fill memory.
    while (this.turns.length > 1 && this.keptChars - turnLength(this.turns[0]) > 2 * this.maxChars) {
      const old = this.turns.shift();
      if (old !== undefined) {
        this.keptChars -= turnLength(old);
        this.dropped += 1;
      }
    }
  }

  private add(line: string): void {
    if (this.turns.length === 0) {
      const header = '### Turn 0 (its prompt was not read)';
      this.firstNumber = 0;
      this.turns.push({ number: 0, lines: [header] });
      this.keptChars += header.length + 1;
    }
    this.turns[this.turns.length - 1]?.lines.push(line);
    this.keptChars += line.length + 1;
  }
}

function turnLength(turn: Turn | undefined): number {
  return turn === undefined ? 0 : turn.lines.reduce((sum, line) => sum + line.length + 1, 0);
}

const renderTurn = (turn: Turn): string => turn.lines.join('\n');

function bytesNote(skippedBytes: number): string {
  return `[Omitted: the start of the session (the first ${String(skippedBytes)} bytes of the conversation file `
    + 'were not read). Turn numbers count from the first turn read.]';
}

function turnsNote(first: number, last: number): string {
  return `[Omitted: turns ${String(first)}–${String(last)} (the older part of the session is over the size budget).]`;
}

/** Cuts the middle of one turn so the whole text fits `room` characters. */
function cutTurn(text: string, room: number): string {
  const markerFor = (omitted: number): string => `\n[… ${String(omitted)} characters of this turn omitted …]\n`;
  const marker = markerFor(text.length);
  const keep = Math.max(0, room - marker.length);
  const head = Math.floor(keep * 0.4);
  const tail = keep - head;
  return `${text.slice(0, head)}${markerFor(text.length - keep)}${text.slice(text.length - tail)}`;
}

/** Length of `parts` joined by a blank line, with the final newline (0 for no parts). */
const joinedLength = (lengths: readonly number[]): number => (lengths.length === 0
  ? 0
  : lengths.reduce((sum, length) => sum + length, 0) + 2 * (lengths.length - 1) + 1);
const join = (parts: readonly string[]): string => (parts.length === 0 ? '' : `${parts.join('\n\n')}\n`);

/** Fits the turns into the budget: newest turns whole, older ones replaced by a note. */
function fit(collector: TurnCollector, skippedBytes: number, maxChars: number): CondensedTranscript {
  const { turns, dropped, firstNumber } = collector;
  const rendered = turns.map(renderTurn);
  const total = turns.length + dropped;
  /** Notes in front of the turns kept from index `keptFrom` on. */
  const notes = (keptFrom: number): string[] => {
    const out: string[] = [];
    if (skippedBytes > 0) out.push(bytesNote(skippedBytes));
    if (keptFrom + dropped > 0) {
      const lastOmitted = keptFrom > 0 ? turns[keptFrom - 1]?.number ?? 0 : (turns[0]?.number ?? 1) - 1;
      out.push(turnsNote(firstNumber, lastOmitted));
    }
    return out;
  };

  // Everything kept while reading fits: no note about omitted turns, nothing cut. Checked first because the loop
  // below counts that note for every older turn, so it could stop short of the whole set by the note's length.
  const whole = join([...notes(0), ...rendered]);
  if (rendered.length > 0 && whole.length <= maxChars) {
    return { text: whole, turns: total, omittedTurns: dropped, skippedBytes, cutTurn: false };
  }
  // Newest first: keep as many whole turns as fit together with the notes.
  let keptFrom = rendered.length;
  /** Length of the kept turns joined by blank lines, each followed by its separator. */
  let keptLength = 0;
  while (keptFrom > 0) {
    const next = (rendered[keptFrom - 1]?.length ?? 0) + 2;
    if (joinedLength([...notes(keptFrom - 1).map((note) => note.length), keptLength + next - 2]) > maxChars) break;
    keptLength += next;
    keptFrom -= 1;
  }
  if (keptFrom < rendered.length || rendered.length === 0) {
    const text = join([...notes(keptFrom), ...rendered.slice(keptFrom)]);
    return { text, turns: total, omittedTurns: keptFrom + dropped, skippedBytes, cutTurn: false };
  }
  // Not even the newest turn fits: keep it with its middle cut, everything older goes.
  const last = rendered.length - 1;
  const head = notes(last);
  const room = maxChars - joinedLength([...head.map((note) => note.length), 0]);
  const text = join([...head, cutTurn(rendered[last] ?? '', Math.max(0, room))]);
  return { text: text.slice(0, maxChars), turns: total, omittedTurns: last + dropped, skippedBytes, cutTurn: true };
}

/** Condenses lines of a conversation file (already split). The pure core of {@link condenseFile}. */
export function condenseLines(lines: Iterable<string>, opts: CondenseOptions = {}): CondensedTranscript {
  const maxChars = opts.maxChars ?? MAX_CONDENSE_CHARS;
  const collector = new TurnCollector(maxChars);
  for (const line of lines) collector.push(line);
  return fit(collector, 0, maxChars);
}

/**
 * Condenses a conversation file, reading at most `maxBytes` from its end as a stream. `null` when the path is not a
 * readable file.
 */
export async function condenseFile(path: string, opts: CondenseOptions = {}): Promise<CondensedTranscript | null> {
  const maxBytes = opts.maxBytes ?? MAX_CONDENSE_BYTES;
  const maxChars = opts.maxChars ?? MAX_CONDENSE_CHARS;
  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    size = info.size;
  } catch {
    return null;
  }
  const skippedBytes = Math.max(0, size - maxBytes);
  const collector = new TurnCollector(maxChars);
  // A live session appends while we read: stop at the end measured by `stat`, so the cap holds.
  if (size === 0) return fit(collector, 0, maxChars);
  try {
    const stream = createReadStream(path, { start: skippedBytes, end: size - 1, encoding: 'utf8' });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let first = true;
    for await (const line of lines) {
      // The read starts in the middle of an entry: its rest is not a whole line.
      if (first && skippedBytes > 0) {
        first = false;
        continue;
      }
      first = false;
      collector.push(line);
    }
  } catch {
    return null;
  }
  return fit(collector, skippedBytes, maxChars);
}
