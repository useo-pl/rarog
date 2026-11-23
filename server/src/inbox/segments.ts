/**
 * Segments of the conversation a session writes now, read for its Inbox card: the conversation file of the engine
 * conversation (`locate`) and its tail through `readInputSegments`, widened until the last segment with a result and
 * text or the window ceiling. The outcome says whether the segments begin at the first entry of the file, because only
 * then does "no such segment" mean that there is none. It keeps nothing between reads.
 */
import { readRange, sizeOf } from '../herdr/history-steps.ts';
import type { ReadRange } from '../herdr/history-steps.ts';
import { readInputSegments } from '../herdr/input-segments.ts';
import type { InputSegment } from '../herdr/input-segments.ts';
import { showsResult } from './card.ts';

/** First window of the tail read: one turn with its tool results fits most of the time; it doubles from there. */
export const INBOX_FIRST_WINDOW = 256 * 1024;

/**
 * `read`: the segments of the window and whether they start at the first entry of the file (the window holds the file
 * from its first byte and the message ceiling dropped nothing, `InputSegmentRead.fromStart`); `no-file`: the
 * conversation has no file yet; `unreadable`: the file exists but could not be read now.
 */
export type SegmentsRead =
  | { readonly kind: 'read'; readonly segments: readonly InputSegment[]; readonly wholeFile: boolean }
  | { readonly kind: 'no-file' }
  | { readonly kind: 'unreadable' };

export interface SegmentReaderOptions {
  /** Conversation file of an engine conversation; `null` = none yet. */
  readonly locate: (cwd: string, agentSessionId: string) => Promise<string | null>;
  /** `false` = a prompt blocked by a hook is not recognised (`RAROG_PROMPT_BLOCK=0`), as in the follower. */
  readonly promptBlock: boolean;
  /** Messages the parser keeps from the end, as for the session history. */
  readonly limit: number;
  /** Byte ceiling of the window, as for the session history. */
  readonly maxBytes: number;
  /** Tests: a smaller first window and another file reader. */
  readonly firstWindow?: number;
  readonly read?: ReadRange;
}

export type SegmentReader = (cwd: string, agentSessionId: string) => Promise<SegmentsRead>;

export function createSegmentReader(opts: SegmentReaderOptions): SegmentReader {
  const read = opts.read ?? readRange;
  const firstWindow = opts.firstWindow ?? INBOX_FIRST_WINDOW;
  const maxBytes = Math.max(firstWindow, opts.maxBytes);
  return async (cwd, agentSessionId) => {
    let file: string | null;
    try {
      file = await opts.locate(cwd, agentSessionId);
    } catch {
      return { kind: 'unreadable' };
    }
    if (file === null) return { kind: 'no-file' };
    const size = await sizeOf(file);
    if (size === null) return { kind: 'unreadable' };
    const tail = await readInputSegments(read, file, size, {
      conversation: agentSessionId, firstWindow, maxBytes, limit: opts.limit, promptBlock: opts.promptBlock,
      enough: (got) => got.segments.some(showsResult),
    });
    if (tail === null) return { kind: 'unreadable' };
    return { kind: 'read', segments: tail.segments, wholeFile: tail.fromStart };
  };
}
