/**
 * Segments of the current conversation file, one per turn input: every `user`-role entry in file order (a prompt,
 * a harness notice, a hidden turn input) closes the previous segment and opens the next. Each segment gets its result
 * class, the text of its card and an opaque `turnId` and `version`. This is not the turn of the voice agent's turns
 * route (`isTurnStart` in `companion/turns.ts`), which a human message alone opens.
 *
 * It reads the same messages as that route (`readHistoryTail`, then `historyWithoutEcho` in `history-steps.ts`), plus
 * the marks of the turns. Pure and stateless, so the same file gives the same segments live, after a server restart
 * and after a re-attach. It keeps no cards or removals.
 */
import { createHash } from 'node:crypto';
import type { TranscriptNotice } from '@rarog/shared';
import type { InternalBlock } from '../drivers/types.ts';
import { noResultTurn } from '../notify/policy.ts';
import type { TurnInput } from '../notify/policy.ts';
import { tallyTurnInput } from '../sessions/state-sentences.ts';
import type { ImportedMessage } from '../transcript-import.ts';
import { historyWithoutEcho, readHistoryTail } from './history-steps.ts';
import type { HistoryReadOptions, ManagerHistoryMessage, ReadRange } from './history-steps.ts';

/** Ceiling of the card text in Unicode scalars; a longer text loses its start, so its closing block stays. */
export const SEGMENT_TEXT_MAX_CHARS = 12_000;

/**
 * What opened a segment: `prompt` = a message a human wrote (also a prompt-type command and a prompt queued into
 * a running turn); `notice` = a harness notice (the end of a background task, of a subagent, of an artifact watch,
 * a subagent standby); `input` = a turn input the transcript does not show (a message from a subagent, a scheduled
 * wake-up).
 */
export type SegmentOpener = 'prompt' | 'notice' | 'input';

/** One message as the segmentation reads it: a history message, merged or one per file entry, or a mark. */
export interface SegmentEntry {
  readonly role: 'user' | 'assistant' | 'system';
  readonly blocks: readonly InternalBlock[];
  /** ISO timestamp of the entry; `''` = the entry had none. */
  readonly at: string;
  readonly notice?: TranscriptNotice;
  /**
   * `hidden` opens a segment like any `user` entry. `compaction` counts in the open segment and opens none: the
   * boundary carries no assistant entry, so it changes neither the text nor the version of the segment around it.
   */
  readonly turnMark?: 'hidden' | 'compaction';
  /** Time of the last entry merged into an assistant message; absent = the message is one entry. */
  readonly lastAt?: string;
  /**
   * Identity of the file entry of a `user`-role message (`ImportedMessage.entryId`), part of the `turnId` of the
   * segment it opens. A list read without the marks of the turns has none: such an opener is keyed by its timestamp
   * and text instead, which also stay the same in every read window.
   */
  readonly entryId?: string;
}

export interface InputSegment {
  /**
   * Opaque identity: a hash of the engine's conversation id and the identity of the opening entry
   * ({@link SegmentEntry.entryId}). Nothing in it depends on where the read window starts.
   */
  readonly turnId: string;
  /** Opaque version: a hash of `turnId`, {@link lastAssistantAt} and {@link text}; late text changes it. */
  readonly version: string;
  readonly opener: SegmentOpener;
  /** Timestamp of the opening entry. */
  readonly openedAt: string;
  /** Timestamp of the last assistant entry of the segment; absent = none yet. */
  readonly lastAssistantAt?: string;
  /** The segment's input in the shape of the notification rule (`notify/policy.ts`). */
  readonly input: TurnInput;
  /** The segment leaves a result: `noResultTurn` over {@link input} without its compaction boundaries. */
  readonly withResult: boolean;
  /**
   * Card text: the assistant text blocks after the last tool call of the segment; with none, the last text block of
   * the segment. A non-empty thinking block is a text block here, as in the transcript (`assistantBlocksFrom` in
   * `transcript-import.ts`). At most {@link SEGMENT_TEXT_MAX_CHARS} scalars.
   */
  readonly text: string;
  /** The text lost its start to the ceiling. */
  readonly truncated: boolean;
  /** The segment's messages are `entries.slice(start, end)` of the list given to {@link segmentByInput}. */
  readonly start: number;
  readonly end: number;
}

export interface InputSegments {
  /** Segments in file order, each with its opener in the list. */
  readonly segments: InputSegment[];
  /**
   * Assistant messages stand before the first opener: the list starts inside a segment whose opener it does not
   * have. Those messages make no segment.
   */
  readonly startsMidTurn: boolean;
}

const NO_INPUT: TurnInput = { standbyNotices: 0, artifactWatch: 0, other: 0, toolCalls: 0, compactions: 0 };

/** A segment being read: what {@link finish} turns into an {@link InputSegment}. */
interface OpenSegment {
  readonly opener: SegmentOpener;
  readonly openedAt: string;
  /** Identity of the opening entry, see {@link SegmentEntry.entryId}. */
  readonly key: string;
  readonly start: number;
  input: TurnInput;
  lastAssistantAt?: string;
  /** Text blocks after the last tool call. */
  afterTool: string[];
  /** The last text block of the segment. */
  lastText?: string;
}

/**
 * Segments of a list of messages; no clock draws a boundary. Merging consecutive assistant entries into one message
 * changes no segment, `turnId`, `version` or text, as long as a merged message carries `lastAt`.
 */
export function segmentByInput(conversation: string, entries: readonly SegmentEntry[]): InputSegments {
  const segments: InputSegment[] = [];
  let startsMidTurn = false;
  let open: OpenSegment | null = null;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined) continue;
    const opener = openerOf(entry);
    if (opener !== null) {
      if (open !== null) segments.push(finish(conversation, open, index));
      open = {
        opener, openedAt: entry.at, key: keyOf(entry), start: index, input: tallyTurnInput(NO_INPUT, entry.notice),
        afterTool: [],
      };
      continue;
    }
    if (open === null) {
      if (entry.role === 'assistant') startsMidTurn = true;
      continue;
    }
    if (entry.turnMark === 'compaction') open.input = tallyTurnInput(open.input, undefined, true);
    if (entry.role === 'assistant') readAssistant(open, entry);
  }
  if (open !== null) segments.push(finish(conversation, open, entries.length));
  return { segments, startsMidTurn };
}

function openerOf(entry: SegmentEntry): SegmentOpener | null {
  if (entry.role !== 'user') return null;
  if (entry.turnMark === 'hidden') return 'input';
  return entry.notice === undefined ? 'prompt' : 'notice';
}

function keyOf(entry: SegmentEntry): string {
  if (entry.entryId !== undefined) return entry.entryId;
  const text = entry.blocks.map((block) => (block.type === 'text' ? block.text.text : block.type));
  return JSON.stringify(['content', entry.at, ...text]);
}

function readAssistant(open: OpenSegment, entry: SegmentEntry): void {
  open.lastAssistantAt = entry.lastAt ?? entry.at;
  for (const block of entry.blocks) {
    if (block.type === 'tool-call') {
      open.input = { ...open.input, toolCalls: open.input.toolCalls + 1 };
      open.afterTool = [];
      continue;
    }
    if (block.type !== 'text' || block.text.text.trim() === '') continue;
    open.afterTool.push(block.text.text);
    open.lastText = block.text.text;
  }
}

function finish(conversation: string, open: OpenSegment, end: number): InputSegment {
  const full = open.afterTool.length > 0 ? open.afterTool.join('\n\n') : open.lastText ?? '';
  const { text, truncated } = keepEnd(full, SEGMENT_TEXT_MAX_CHARS);
  const turnId = digest([conversation, open.key]);
  return {
    turnId,
    version: digest([turnId, open.lastAssistantAt ?? '', text]),
    opener: open.opener,
    openedAt: open.openedAt,
    ...(open.lastAssistantAt === undefined ? {} : { lastAssistantAt: open.lastAssistantAt }),
    input: open.input,
    // A compaction boundary is not an input of the segment: it lands in whichever segment is open, so counting it
    // would let a later compaction turn a standby segment with a tool call into a result.
    withResult: !noResultTurn({ ...open.input, compactions: 0 }),
    text,
    truncated,
    start: open.start,
    end,
  };
}

/** The last `max` Unicode scalars of a text, so no character is split at the cut. */
function keepEnd(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const scalars = [...text];
  if (scalars.length <= max) return { text, truncated: false };
  return { text: scalars.slice(-max).join(''), truncated: true };
}

/** Opaque hash of the parts; the JSON array keeps the parts apart. */
function digest(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('base64url').slice(0, 22);
}

/** Window, stop and conversation of {@link readInputSegments}. */
export interface InputSegmentReadOptions extends Omit<HistoryReadOptions, 'enough' | 'turnMarks'> {
  /**
   * The engine's conversation id of the file (its uuid), part of every `turnId`. Not the voice route's conversation
   * token: that one changes at every server restart, and a `turnId` must not.
   */
  readonly conversation: string;
  /**
   * One more stop of the widening window: the segments read so far are enough (the last N, one with a result).
   * It can only stop the read earlier than `limit` and `maxBytes`.
   */
  readonly enough?: (read: InputSegments) => boolean;
}

/** Segments of the window and the messages their `start` and `end` point into (marks included, with no blocks). */
export interface InputSegmentRead extends InputSegments {
  readonly messages: readonly ManagerHistoryMessage[];
  /**
   * The segments start at the first entry of the file: the window starts at its first byte and the message ceiling
   * (`limit`) dropped nothing. Only then does a missing segment mean that the file has none.
   */
  readonly fromStart: boolean;
}

/**
 * Segments of the tail of a conversation file: the window of `readHistoryTail` with the marks of the turns, the
 * history steps of a read on request (`historyWithoutEcho`), then {@link segmentByInput}.
 *
 * @returns the segments, or `null` when the first read failed (no file, no access).
 */
export async function readInputSegments(
  read: ReadRange, path: string, size: number, opts: InputSegmentReadOptions,
): Promise<InputSegmentRead | null> {
  const { conversation, enough, ...history } = opts;
  const segmentsOf = (entries: readonly ImportedMessage[]): Omit<InputSegmentRead, 'fromStart'> => {
    const messages = historyWithoutEcho(entries);
    return { ...segmentByInput(conversation, messages), messages };
  };
  const tail = await readHistoryTail(read, path, size, {
    ...history,
    turnMarks: true,
    ...(enough === undefined ? {} : { enough: (entries) => enough(segmentsOf(entries)) }),
  });
  if (tail === null) return null;
  // The parser keeps the last `limit` messages of the window, so a full count may hide dropped older ones.
  return { ...segmentsOf(tail.messages), fromStart: tail.start === 0 && tail.messages.length < history.limit };
}
