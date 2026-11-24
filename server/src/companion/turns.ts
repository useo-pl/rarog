/**
 * The last turns of one session for the voice agent's mode across sessions, the work behind
 * `GET /api/sessions/:id/companion/turns`. It reads the tail of the file of the engine conversation the session writes
 * now, puts it through the steps of the session's history on the way to the phone (`herdr/history-steps.ts`, then the
 * wire shape of `sessions/session.ts`) and cuts the result to the last 1–3 turns. It writes nothing and keeps nothing
 * between reads. The route checks the flags, the session and its scope; this module does not.
 */
import type { TranscriptMessage } from '@rarog/shared';
import type { CompanionTurns } from '@rarog/shared/rest';
import { defaultStoreRoot } from '../cli-store.ts';
import { HERDR_HISTORY_MESSAGES } from '../config.ts';
import type { RarogConfig } from '../config.ts';
import { historyWithoutEcho, readHistoryTail, readRange, sizeOf } from '../herdr/history-steps.ts';
import { HISTORY_MAX_BYTES } from '../herdr/jsonl-follow.ts';
import { locateTranscript } from '../herdr/transcript-path.ts';
import { RING_MAX_BYTES, jsonBytes } from '../sessions/ring-buffer.ts';
import { MESSAGE_TRIMMED_MARK, transcriptMessage } from '../sessions/session.ts';
import type { ImportedMessage } from '../transcript-import.ts';
import { conversationToken } from './conversation.ts';

/** First window of the tail read: enough for three turns of most sessions; it doubles up to the history ceiling. */
export const TURNS_FIRST_WINDOW = 256 * 1024;

/**
 * `readMark` of an answer that did not read the session's result: an answer with no messages (a failed read, i.e. no
 * file, a lookup that throws, a size or a first read that fails, and a conversation with nothing to read alike) and an
 * answer with a message trimmed to the per-message ceiling ({@link hasTrimmedMessage}). The mark names no read: it has
 * no dot, while `Session.readMark` always has three dot-separated parts, so the voice agent's pick-up built from it
 * never meets the session's mark and gets the 409. Inside the 1–64 character bound of the turns answer and of the
 * pick-up body.
 */
export const NO_READ_MARK = 'no-read';

/**
 * The session as the route took it before the read: directory, current engine conversation, `stateSince` and the read
 * mark of its memory, read together.
 */
export interface CompanionTurnsTarget {
  readonly cwd: string;
  /** `undefined` before the session's first engine conversation: no file, no turns. */
  readonly agentSessionId: string | undefined;
  readonly stateSince: string;
  /**
   * `Session.readMark`: a message that reaches the session's memory during or after the read gives another one, and so
   * does a new `stateSince`. The answer carries it only when it has messages and none of them is trimmed, else
   * {@link NO_READ_MARK}.
   */
  readonly readMark: string;
}

export interface CompanionTurnsOptions {
  /** Conversation file of `agentSessionId`; `null` = none yet. */
  readonly locate: (cwd: string, agentSessionId: string) => Promise<string | null>;
  /** `false` = a prompt blocked by a hook is not recognised, as in the follower (`RAROG_PROMPT_BLOCK=0`). */
  readonly promptBlock: boolean;
  /** Token of an engine conversation; default the server process's {@link conversationToken}. */
  readonly token?: (agentSessionId: string | undefined) => string;
  /** Time for an entry without `timestamp`, as the session manager gives it; default now. */
  readonly now?: () => string;
  /** Read window for tests; defaults {@link TURNS_FIRST_WINDOW} and the history ceiling. */
  readonly firstWindow?: number;
  readonly maxBytes?: number;
}

export interface CompanionTurnsReader {
  read(target: CompanionTurnsTarget, count: number): Promise<CompanionTurns>;
}

/**
 * Whether a message opens a turn, by the rule of the app's projection: a human message, not a harness notice and not
 * a blocked prompt, with text outside the server's own sentences, an image block or an attachment. A command output,
 * a blocked prompt (a `system` note) and a task notification never open one.
 */
export function isTurnStart(message: TranscriptMessage): boolean {
  if (message.role !== 'user' || message.notice !== undefined || message.promptBlocked !== undefined) return false;
  const text = message.blocks.flatMap((b) => (b.type === 'text' && b.ref === undefined ? [b.text] : [])).join('\n');
  return text.trim() !== '' || message.blocks.some((b) => b.type === 'image') || (message.attachments?.length ?? 0) > 0;
}

/**
 * The last `count` turns of the window's messages.
 *
 * @param wholeFile the window holds the file from its first entry: messages before the first turn (the notes of
 *        `/clear`, a command) belong to no turn and drop out, except an agent message (a turn without a human prompt).
 * @returns the messages and `complete: false` when the window starts inside the oldest returned turn.
 */
export function lastTurns(
  messages: readonly TranscriptMessage[], count: number, wholeFile: boolean,
): { messages: TranscriptMessage[]; complete: boolean } {
  const starts: number[] = [];
  messages.forEach((m, i) => { if (isTurnStart(m)) starts.push(i); });
  if (starts.length >= count) return { messages: messages.slice(starts[starts.length - count]), complete: true };
  if (wholeFile) {
    const from = messages.findIndex((m) => m.role === 'assistant' || isTurnStart(m));
    return { messages: from === -1 ? [] : messages.slice(from), complete: true };
  }
  const first = messages[0];
  return { messages: [...messages], complete: first !== undefined && isTurnStart(first) };
}

/** Imported entries → messages as the session appends them from history, numbered from 1 in this response. */
function wireHistory(entries: readonly ImportedMessage[], now: string): TranscriptMessage[] {
  return historyWithoutEcho(entries).map((m, index) => ({
    ...transcriptMessage(m.role, m.blocks, m.at !== '' ? m.at : now, m.attachments, {
      ...(m.notice !== undefined ? { notice: m.notice } : {}),
      ...(m.promptBlocked !== undefined ? { promptBlocked: m.promptBlocked } : {}),
    }),
    seq: index + 1,
  }));
}

/**
 * Whether a returned message lost its end: `transcriptMessage` keeps the start of a message over the per-message
 * ceiling and closes it with {@link MESSAGE_TRIMMED_MARK}, a server sentence known by its `ref` (a text from the file
 * never carries one). The history merges consecutive agent entries into one message, while the server's memory of a
 * live session got them one by one, so the newest result can be in the memory and lost in the answer. Any trimmed
 * message counts, also one of an older returned turn: the answer is what the agent relays as the session's last turns.
 * The other cuts of the read (the window, the message limit, the cut to turns and the byte ceiling) drop from the old
 * end and keep the newest message.
 */
function hasTrimmedMessage(messages: readonly TranscriptMessage[]): boolean {
  return messages.some((m) => {
    const last = m.blocks.at(-1);
    return last?.type === 'text' && last.ref?.code === MESSAGE_TRIMMED_MARK.ref.code;
  });
}

/** Byte ceiling of the session's transcript (`Session.appendMessage`): the oldest messages drop first. */
function capBytes(messages: TranscriptMessage[]): { messages: TranscriptMessage[]; dropped: boolean } {
  let bytes = messages.reduce((sum, m) => sum + jsonBytes(m), 0);
  let from = 0;
  while (bytes > RING_MAX_BYTES && messages.length - from > 1) {
    bytes -= jsonBytes(messages[from]!);
    from += 1;
  }
  return { messages: from === 0 ? messages : messages.slice(from), dropped: from > 0 };
}

export function createCompanionTurns(opts: CompanionTurnsOptions): CompanionTurnsReader {
  const token = opts.token ?? conversationToken;
  const now = opts.now ?? (() => new Date().toISOString());
  const firstWindow = opts.firstWindow ?? TURNS_FIRST_WINDOW;
  const maxBytes = Math.max(firstWindow, opts.maxBytes ?? HISTORY_MAX_BYTES);

  return {
    async read(target, count) {
      const conversation = token(target.agentSessionId);
      const nothing: CompanionTurns = {
        messages: [], conversation, stateSince: target.stateSince, readMark: NO_READ_MARK, complete: true,
      };
      const file = target.agentSessionId === undefined
        ? null
        : await opts.locate(target.cwd, target.agentSessionId).catch(() => null);
      const size = file === null ? null : await sizeOf(file);
      if (file === null || size === null) return nothing;
      const at = now();
      // One turn start more than asked: the oldest wanted turn then lies whole inside the window.
      const tail = await readHistoryTail(readRange, file, size, {
        firstWindow, maxBytes, limit: HERDR_HISTORY_MESSAGES, promptBlock: opts.promptBlock,
        enough: (entries) => wireHistory(entries, at).filter(isTurnStart).length > count,
      });
      if (tail === null) return nothing;
      const wholeFile = tail.start === 0 && tail.messages.length < HERDR_HISTORY_MESSAGES;
      const turns = lastTurns(wireHistory(tail.messages, at), count, wholeFile);
      const capped = capBytes(turns.messages);
      if (capped.messages.length === 0) return { ...nothing, complete: turns.complete };
      return {
        messages: capped.messages.map((m, index) => ({ ...m, seq: index + 1 })),
        conversation,
        stateSince: target.stateSince,
        readMark: hasTrimmedMessage(capped.messages) ? NO_READ_MARK : target.readMark,
        complete: turns.complete && !capped.dropped,
      };
    },
  };
}

/** The reader of the server process: conversation files from the Claude Code store, the server's blocked prompt flag. */
export function assembleCompanionTurns(config: Pick<RarogConfig, 'promptBlock'>): CompanionTurnsReader {
  return createCompanionTurns({
    locate: (cwd, agentSessionId) => locateTranscript(defaultStoreRoot(), cwd, agentSessionId),
    promptBlock: config.promptBlock,
  });
}
