/**
 * The last turns of a session for the voice agent across sessions (`server/src/companion/turns.ts`): the turn
 * boundary, the cut to 1–3 turns, `complete`, the read's bounds (stop, messages, bytes, response ceiling), a missing
 * or empty conversation file and the conversation token. The files are synthetic, in a temporary directory; the
 * history path of a live session is compared in `herdr-integration.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { type TranscriptMessage, transcriptMessageSchema } from '@rarog/shared';
import { companionTurnsSchema } from '@rarog/shared/rest';
import { conversationToken, conversationTokens } from '../src/companion/conversation.ts';
import { type CompanionTurnsOptions, createCompanionTurns, isTurnStart } from '../src/companion/turns.ts';
import { HERDR_HISTORY_MESSAGES } from '../src/config.ts';
import { HISTORY_MAX_BYTES } from '../src/herdr/jsonl-follow.ts';
import { RING_MAX_BYTES, jsonBytes } from '../src/sessions/ring-buffer.ts';
import {
  agentLine, blockedLine, lineTime, localCommandLines, noticeLine, pastedImageLine, photoLines, turnLines, userLine,
} from './helpers/plik-rozmowy.ts';

/** Byte ranges the reader asked of the file, in order: the real read, recorded. */
const ranges = vi.hoisted(() => ({ list: [] as { start: number; length: number }[] }));
vi.mock('../src/herdr/history-steps.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/herdr/history-steps.ts')>();
  return {
    ...real,
    readRange: (path: string, start: number, length: number) => {
      ranges.list.push({ start, length });
      return real.readRange(path, start, length);
    },
  };
});

const CONV = '44444444-4444-4444-8444-444444444444';

async function fileWith(text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rarog-turns-'));
  const file = join(dir, `${CONV}.jsonl`);
  await writeFile(file, text);
  return file;
}

async function turnsOf(text: string, count: number, opts: Partial<CompanionTurnsOptions> = {}) {
  const file = await fileWith(text);
  const reader = createCompanionTurns({ locate: () => Promise.resolve(file), promptBlock: true, ...opts });
  const result = await reader.read({ cwd: '/p', agentSessionId: CONV, stateSince: '2026-11-20T11:00:00.000Z' }, count);
  expect(companionTurnsSchema.safeParse(result).success).toBe(true);
  return result;
}

const textOf = (m: TranscriptMessage): string => m.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('');
const userTexts = (ms: readonly TranscriptMessage[]): string[] => ms.filter((m) => m.role === 'user').map(textOf);

describe('companion turns: the cut to the last turns', () => {
  const five = [1, 2, 3, 4, 5].map((n) => turnLines(n)).join('');

  it('a session with 5 turns and count=3 gives the last three, complete', async () => {
    const result = await turnsOf(five, 3);
    expect(result.messages.map(textOf)).toEqual(['prompt 3', 'answer 3', 'prompt 4', 'answer 4', 'prompt 5', 'answer 5']);
    expect(result.complete).toBe(true);
    expect(result.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.stateSince).toBe('2026-11-20T11:00:00.000Z');
  });

  it('count=1 and count=2 cut at their own turn', async () => {
    expect(userTexts((await turnsOf(five, 1)).messages)).toEqual(['prompt 5']);
    expect(userTexts((await turnsOf(five, 2)).messages)).toEqual(['prompt 4', 'prompt 5']);
  });

  it('a session shorter than count gives all its turns', async () => {
    const result = await turnsOf(turnLines(1) + turnLines(2), 3);
    expect(userTexts(result.messages)).toEqual(['prompt 1', 'prompt 2']);
    expect(result.complete).toBe(true);
  });

  it('a task notification between turns does not open a turn', async () => {
    const result = await turnsOf(turnLines(1) + turnLines(2) + noticeLine('Background command finished', 3)
      + agentLine('notified', 3) + turnLines(4), 2);
    expect(result.messages[0] && textOf(result.messages[0])).toBe('prompt 2');
    const notice = result.messages.find((m) => m.notice !== undefined);
    expect(notice?.role).toBe('user');
    expect(result.messages.filter((m) => m.role === 'user' && m.notice === undefined).map(textOf))
      .toEqual(['prompt 2', 'prompt 4']);
  });

  it('a human message without text (an image pasted in the terminal) does not open a turn', async () => {
    const result = await turnsOf(turnLines(1) + turnLines(2) + pastedImageLine(3) + agentLine('saw it', 3), 1);
    expect(result.messages.map(textOf)[0]).toBe('prompt 2');
    expect(result.messages).toHaveLength(4);
  });

  it('a human message with only a photo attached opens a turn, as the app shows it', async () => {
    const result = await turnsOf(turnLines(1) + turnLines(2) + photoLines(3) + agentLine('saw the photo', 3), 1);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]?.attachments?.map((a) => a.kind)).toEqual(['image']);
    expect(result.messages[0] && textOf(result.messages[0])).toBe('');
    expect(result.complete).toBe(true);
  });

  it('a blocked prompt and a command output open no turn and stay as history has them', async () => {
    const result = await turnsOf(turnLines(1) + turnLines(2) + blockedLine('delete everything', 3)
      + localCommandLines('cost', 'Total cost: 0.01', 4) + agentLine('after the command', 4), 1);
    expect(result.messages[0] && textOf(result.messages[0])).toBe('prompt 2');
    // The blocked prompt is a system note with its field, never a human message.
    const blocked = result.messages.filter((m) => m.promptBlocked !== undefined);
    expect(blocked.map((m) => m.role)).toEqual(['system']);
    expect(userTexts(result.messages).some((t) => t.includes('delete everything'))).toBe(false);
    // The driver's command output mark never reaches the wire.
    expect(result.messages.some((m) => 'commandOutput' in m)).toBe(false);
    expect(result.messages.filter((m) => m.role === 'user').map(textOf)).toEqual(['prompt 2']);
  });

  it('a window that starts inside the oldest turn gives complete: false', async () => {
    const long = Array.from({ length: 40 }, (_, i) => agentLine(`step ${String(i)} ${'x'.repeat(200)}`, 2)).join('');
    const result = await turnsOf(turnLines(1) + userLine('long prompt', 2) + long, 1, { firstWindow: 1024, maxBytes: 4096 });
    expect(result.complete).toBe(false);
    expect(result.messages[0]?.role).toBe('assistant');
    expect(userTexts(result.messages)).toEqual([]);
  });

  it('the notes of /clear without a new prompt give an empty list', async () => {
    const result = await turnsOf(localCommandLines('clear', ''), 3);
    expect(result.messages).toEqual([]);
    expect(result.complete).toBe(true);
  });

  it('no conversation yet, or no file, gives an empty list', async () => {
    const missing = createCompanionTurns({ locate: () => Promise.resolve(null), promptBlock: true });
    expect((await missing.read({ cwd: '/p', agentSessionId: CONV, stateSince: 's' }, 3)).messages).toEqual([]);
    const none = createCompanionTurns({ locate: () => Promise.reject(new Error('unused')), promptBlock: true });
    const result = await none.read({ cwd: '/p', agentSessionId: undefined, stateSince: 's' }, 3);
    expect(result.messages).toEqual([]);
    expect(result.conversation).toBe(conversationToken(undefined));
  });
});

describe('companion turns: the bounds of the read', () => {
  /** A tool result entry: bytes of the file the import does not show, so they count only for the read window. */
  const toolResultLines = (bytes: number): string => {
    const line = `${JSON.stringify({
      type: 'user', timestamp: lineTime(2),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'r'.repeat(64 * 1024) }] },
    })}\n`;
    return line.repeat(Math.ceil(bytes / line.length));
  };

  it('the reader stops once the window holds one turn start more than asked, before the start of the file', async () => {
    // Twenty turns of the same length; the first window holds the last turn whole and the end of the one before.
    const turnBytes = Buffer.byteLength(turnLines(10));
    const text = Array.from({ length: 20 }, (_, i) => turnLines(10 + i)).join('');
    expect(Buffer.byteLength(text)).toBe(20 * turnBytes);
    ranges.list = [];
    const result = await turnsOf(text, 1, { firstWindow: turnBytes + 1 });
    expect(userTexts(result.messages)).toEqual(['prompt 29']);
    expect(result.complete).toBe(true);
    // The first window has one turn start, the doubled one two: the read stops there, far from the start of the file.
    expect(ranges.list).toHaveLength(2);
    expect(ranges.list.every((range) => range.start > 0)).toBe(true);
  });

  it('the oldest wanted turn just inside the last 8 MiB of the file is whole; just outside it, the window misses it', async () => {
    const around = async (filler: number) => turnsOf(toolResultLines(1024 * 1024) + turnLines(1)
      + userLine('prompt 2', 2) + toolResultLines(filler) + agentLine('answer 2', 2), 1);
    ranges.list = [];
    const inside = await around(HISTORY_MAX_BYTES - 512 * 1024);
    expect(userTexts(inside.messages)).toEqual(['prompt 2']);
    expect(inside.complete).toBe(true);
    const outside = await around(HISTORY_MAX_BYTES + 512 * 1024);
    expect(outside.messages.map(textOf)).toEqual(['answer 2']);
    expect(outside.complete).toBe(false);
    // The answers alone cannot tell a ceiling a little above 8 MiB from the real one: the read ranges can.
    expect(Math.max(...ranges.list.map((range) => range.length))).toBe(HISTORY_MAX_BYTES);
  });

  it('a turn longer than the 500-message window gives the last 500 messages, complete: false', async () => {
    const steps = Array.from({ length: 300 }, (_, i) => agentLine(`step ${String(i)}`, 2)
      + noticeLine(`task ${String(i)} finished`, 2)).join('');
    const result = await turnsOf(turnLines(1) + userLine('long prompt', 2) + steps, 1);
    expect(result.messages).toHaveLength(HERDR_HISTORY_MESSAGES);
    expect(result.messages.at(-1)?.notice).toBeDefined();
    expect(userTexts(result.messages).filter((t) => t.includes('prompt'))).toEqual([]);
    expect(result.complete).toBe(false);
  });

  it('turns above the 4 MiB ceiling lose their oldest messages first, complete: false', async () => {
    // A notice between agent messages keeps each one a message of its own (consecutive agent entries merge).
    const big = Array.from({ length: 20 }, (_, i) => agentLine(`${String(i)} ${'x'.repeat(240 * 1024)}`, 2)
      + noticeLine(`task ${String(i)} finished`, 2)).join('');
    const result = await turnsOf(turnLines(1) + userLine('big prompt', 2) + big, 1);
    expect(result.messages.reduce((sum, m) => sum + jsonBytes(m), 0)).toBeLessThanOrEqual(RING_MAX_BYTES);
    expect(userTexts(result.messages).filter((t) => t.includes('prompt'))).toEqual([]);
    const agents = result.messages.filter((m) => m.role === 'assistant').map((m) => textOf(m).split(' ')[0]);
    expect(agents[0]).not.toBe('0');
    expect(agents.at(-1)).toBe('19');
    expect(result.messages.at(-1)?.notice).toBeDefined();
    expect(result.messages.map((m) => m.seq)).toEqual(result.messages.map((_, i) => i + 1));
    expect(result.complete).toBe(false);
  });
});

describe('companion turns: the conversation token', () => {
  it('the same conversation gives the same token, another conversation another one', () => {
    const other = '55555555-5555-4555-8555-555555555555';
    expect(conversationToken(CONV)).toBe(conversationToken(CONV));
    expect(conversationToken(other)).not.toBe(conversationToken(CONV));
    expect(conversationToken(undefined)).not.toBe(conversationToken(CONV));
  });

  it('the token does not carry the engine id and depends on the process key', () => {
    const token = conversationToken(CONV);
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    expect(token).not.toContain(CONV.slice(0, 8));
    // Another key (another server start) gives another token for the same conversation.
    expect(conversationTokens(new Uint8Array(32))(CONV)).not.toBe(token);
  });

  it('the route reader puts the token of the conversation it read', async () => {
    const result = await turnsOf(turnLines(1), 1);
    expect(result.conversation).toBe(conversationToken(CONV));
  });
});

/*
 * The turn boundary on the table shared with the app (`shared/fixtures/companion/turn-starts.json`): the app's
 * projection reads the same table (`RealtimeTurnStartTests` in RarogUI), so the route cuts where the app starts a turn.
 */
describe('companion turns: the turn boundary by the shared table', () => {
  interface Table {
    cases: { name: string; messages: unknown[]; turnStarts: number[] }[];
  }
  const table = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../shared/fixtures/companion/turn-starts.json'), 'utf8'),
  ) as Table;

  it('the table has a case without a turn and a case with two', () => {
    expect(table.cases.some((row) => row.turnStarts.length === 0)).toBe(true);
    expect(table.cases.some((row) => row.turnStarts.length > 1)).toBe(true);
  });

  it.each(table.cases.map((row) => [row.name, row.messages, row.turnStarts] as const))(
    '%s',
    (_name, raw, turnStarts) => {
      const messages = z.array(transcriptMessageSchema).parse(raw);
      expect(messages.flatMap((message, index) => (isTurnStart(message) ? [index] : []))).toEqual(turnStarts);
    },
  );
});
