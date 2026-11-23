/**
 * Segments of a conversation file, one per turn input (`herdr/input-segments.ts`): boundaries, result class, card
 * text, `turnId` and `version`.
 *
 * Every case writes a synthetic `.jsonl` file in the shape Claude Code writes and reads it the way the server
 * does: the tail through `readHistoryTail` with the marks of the turns, then the history steps of a read on request.
 * The same file read again (a restart, a re-attach) gives the same segments, because the reading keeps no state.
 */
import { readFileSync } from 'node:fs';
import { appendFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { readRange, sizeOf } from '../src/herdr/history-steps.ts';
import type { ReadRange } from '../src/herdr/history-steps.ts';
import { SEGMENT_TEXT_MAX_CHARS, readInputSegments, segmentByInput } from '../src/herdr/input-segments.ts';
import type { InputSegment, InputSegmentReadOptions, InputSegments } from '../src/herdr/input-segments.ts';
import { parseImportLine, parseTranscriptTail } from '../src/transcript-import.ts';
import type { ImportedMessage } from '../src/transcript-import.ts';

const CONVERSATION = '11111111-1111-4111-8111-111111111111';
const OTHER_CONVERSATION = '22222222-2222-4222-8222-222222222222';

const BASE_MS = Date.UTC(2026, 0, 1, 10, 0, 0);
/** Timestamp `seconds` after a fixed start; the files carry ISO times like Claude Code. */
const at = (seconds: number): string => new Date(BASE_MS + seconds * 1000).toISOString();

let entrySeq = 0;
/** A fresh entry uuid, as Claude Code writes on its `user` entries. */
function entryUuid(): string {
  entrySeq += 1;
  return `00000000-0000-4000-8000-${String(entrySeq).padStart(12, '0')}`;
}

/** A `user` entry; `extra` overrides any field, and a field set to `undefined` drops out of the line. */
function user(content: unknown, seconds: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'user', uuid: entryUuid(), timestamp: at(seconds), message: { role: 'user', content }, ...extra,
  });
}

function assistant(content: unknown[], seconds: number): string {
  return JSON.stringify({
    type: 'assistant', uuid: entryUuid(), timestamp: at(seconds),
    message: { role: 'assistant', model: 'claude-opus-5-5', content },
  });
}

const prompt = (text: string, seconds: number): string => user(text, seconds);
const reply = (text: string, seconds: number): string => assistant([{ type: 'text', text }], seconds);
const thought = (text: string, seconds: number): string =>
  assistant([{ type: 'thinking', thinking: text, signature: 'sig' }], seconds);

let toolSeq = 0;
/** A main-agent tool call and its result: two lines, as Claude Code writes them. */
function tool(seconds: number, input: Record<string, unknown> = { file_path: '/repo/src/a.ts' }): string[] {
  toolSeq += 1;
  const id = `toolu_${String(toolSeq).padStart(4, '0')}`;
  return [
    assistant([{ type: 'tool_use', id, name: 'Read', input }], seconds),
    user([{ type: 'tool_result', tool_use_id: id, content: 'ok' }], seconds),
  ];
}

/** A harness notice: a `user` entry with the task-notification origin (`herdr/background/notice.ts`). */
const harness = (text: string, seconds: number): string =>
  user(text, seconds, { origin: { kind: 'task-notification', producer: 'session-task' } });

/** Note of a subagent that stopped with work of its own still running (CLI 2.1.296 wording). */
const STANDBY_NOTE = 'This agent stopped with background work of its own still running. It may resume on its '
  + 'own when that work completes or reports, and the same task-id notifies again if it does; the result '
  + 'below may be interim.';
/** Note of a subagent that ended (same CLI version). */
const ENDED_NOTE = 'A task-notification fires each time this agent stops with no live background children of '
  + 'its own. The user can send it another message and resume it, so the same task-id may notify more than once.';

function agentNotice(note: string): string {
  return [
    '<task-notification>', '<task-id>a52b91f105b002e8d</task-id>', '<status>completed</status>',
    '<summary>Agent "Review" finished</summary>', `<note>${note}</note>`,
    '<result>agent report</result>', '</task-notification>',
  ].join('\n');
}

const subagentEnded = (seconds: number): string => harness(agentNotice(ENDED_NOTE), seconds);
const subagentStandby = (seconds: number): string => harness(agentNotice(STANDBY_NOTE), seconds);
const artifactWatchEnded = (seconds: number): string => harness([
  '<task-notification>', '<task-type>artifact-watch-lifecycle</task-type>',
  '<summary>Stopped watching Artifact: "Report" (artifact not found)</summary>', '</task-notification>',
].join('\n'), seconds);

/** A scheduled wake-up: a meta `user` entry with `turnOrigin`, never shown as a message. */
const wakeUp = (seconds: number): string => JSON.stringify({
  type: 'user', uuid: entryUuid(), timestamp: at(seconds), isMeta: true, turnOrigin: 'scheduled',
  message: { role: 'user', content: 'Reply with one word.' },
});

/** A compaction boundary of the main thread. */
const compaction = (seconds: number): string => JSON.stringify({
  type: 'system', subtype: 'compact_boundary', timestamp: at(seconds),
  compactMetadata: { trigger: 'auto', preTokens: 150_000 },
});

/** The entries `/clear` leaves at the top of the new conversation file. */
const clearCommand = (seconds: number): string[] => [
  user('<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>',
    seconds),
  JSON.stringify({
    type: 'system', subtype: 'local_command', timestamp: at(seconds),
    content: '<local-command-stdout></local-command-stdout>',
  }),
];

let dir = '';
let fileSeq = 0;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'turns-'));
});

async function writeLines(lines: readonly string[]): Promise<string> {
  fileSeq += 1;
  const path = join(dir, `${String(fileSeq)}.jsonl`);
  await writeFile(path, lines.map((line) => `${line}\n`).join(''));
  return path;
}

const READ = {
  firstWindow: 64 * 1024, maxBytes: 4 * 1024 * 1024, limit: 10_000, promptBlock: true,
} as const;

async function read(
  path: string, options: Partial<InputSegmentReadOptions> = {}, reader: ReadRange = readRange,
): Promise<InputSegments> {
  const size = await sizeOf(path);
  if (size === null) throw new Error('no file');
  const result = await readInputSegments(reader, path, size, { conversation: CONVERSATION, ...READ, ...options });
  if (result === null) throw new Error('read failed');
  return result;
}

async function turnsOf(lines: readonly string[], conversation = CONVERSATION): Promise<InputSegment[]> {
  return (await read(await writeLines(lines), { conversation })).segments;
}

const lastResult = (turns: readonly InputSegment[]): InputSegment | undefined =>
  turns.findLast((turn) => turn.withResult);

describe('card text of a turn', () => {
  it('prompt, narration, tool, answer → the answer alone', async () => {
    const turns = await turnsOf([
      prompt('What does the config say?', 0), reply('Reading the file.', 1), ...tool(2), reply('The port is 8930.', 3),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ text: 'The port is 8930.', truncated: false, withResult: true, opener: 'prompt' });
  });

  it('a turn without tools and one text → that text', async () => {
    const turns = await turnsOf([prompt('Hello', 0), reply('Hello there.', 1)]);
    expect(turns.map((turn) => turn.text)).toEqual(['Hello there.']);
  });

  it('a non-empty thinking block counts as text, as the transcript shows it', async () => {
    const turns = await turnsOf([
      prompt('Which option?', 0), thought('Let me weigh the options.', 1), reply('Pick B.', 2),
    ]);
    expect(turns[0]?.text).toBe('Let me weigh the options.\n\nPick B.');
  });

  it('non-empty thinking after the last tool call → in the card text', async () => {
    const turns = await turnsOf([
      prompt('Check it', 0), reply('Checking the logs.', 1), ...tool(2), thought('The logs look clean.', 3),
    ]);
    expect(turns[0]?.text).toBe('The logs look clean.');
  });

  it('20 000 characters ending with a question block → the last 12 000, truncated, block kept', async () => {
    const ending = '\n\n**To you:** merge the branch now or wait for the review?';
    const answer = 'w'.repeat(20_000 - ending.length) + ending;
    const turns = await turnsOf([prompt('Report', 0), reply(answer, 1)]);
    const card = turns[0];
    expect(card?.truncated).toBe(true);
    expect([...(card?.text ?? '')]).toHaveLength(SEGMENT_TEXT_MAX_CHARS);
    expect(card?.text.endsWith(ending)).toBe(true);
  });

  it('the cut never splits a character outside the basic plane', async () => {
    const answer = '\u{1D538}'.repeat(SEGMENT_TEXT_MAX_CHARS + 5);
    const turns = await turnsOf([prompt('Report', 0), reply(answer, 1)]);
    expect(turns[0]?.text).toBe('\u{1D538}'.repeat(SEGMENT_TEXT_MAX_CHARS));
  });
});

describe('turn boundaries and the result class', () => {
  it('artifact notice and "nothing to do" after a result turn → the earlier turn stays the last result, unchanged',
    async () => {
      const work = [prompt('Publish the report', 0), ...tool(1), reply('Report is ready.', 3)];
      const before = await turnsOf(work);
      const after = await turnsOf([...work, artifactWatchEnded(10), reply('Nothing to do.', 12)]);
      expect(after).toHaveLength(2);
      expect(after[1]).toMatchObject({ opener: 'notice', withResult: false });
      expect(lastResult(after)).toEqual(before[0]);
    });

  it('a subagent end notice and a reply with a tool → a new turn with a result', async () => {
    const turns = await turnsOf([
      prompt('Start a review agent', 0), reply('Started a review agent.', 1),
      subagentEnded(10), ...tool(11), reply('Review merged.', 13),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({ opener: 'notice', withResult: true, text: 'Review merged.' });
  });

  it('a subagent standby stays without a result even when the agent used a tool', async () => {
    const turns = await turnsOf([
      prompt('Run the suite', 0), ...tool(1), reply('Suite started.', 2),
      subagentStandby(10), ...tool(11), reply('Still waiting.', 12),
    ]);
    expect(turns.map((turn) => turn.withResult)).toEqual([true, false]);
    expect(lastResult(turns)?.text).toBe('Suite started.');
  });

  it('a compaction after a standby turn with a tool does not turn the standby into a result', async () => {
    const turns = await turnsOf([
      prompt('Run the suite', 0), ...tool(1), reply('Suite started.', 2),
      subagentStandby(10), ...tool(11), reply('Still waiting.', 12), compaction(20),
    ]);
    expect(turns.map((turn) => turn.withResult)).toEqual([true, false]);
    expect(lastResult(turns)?.text).toBe('Suite started.');
  });

  it('a scheduled wake-up opens a turn although the transcript does not show it', async () => {
    const turns = await turnsOf([prompt('Arm the cron', 0), reply('Armed.', 1), wakeUp(60), reply('PING', 61)]);
    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({ opener: 'input', openedAt: at(60), withResult: true, text: 'PING' });
  });

  it('a compaction inside a turn does not split it', async () => {
    const turns = await turnsOf([
      prompt('Refactor the module', 0), ...tool(1), compaction(5), ...tool(6), reply('Refactor done.', 8),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ withResult: true, text: 'Refactor done.' });
    expect(turns[0]?.input).toMatchObject({ other: 1, compactions: 1, toolCalls: 2 });
  });

  it('`/clear` and a new turn → only the new turn, with a new turnId', async () => {
    const second = prompt('Second', 10);
    const old = await turnsOf([prompt('First', 0), reply('Done.', 1), second, reply('Done.', 11)]);
    expect(old.map((turn) => turn.text)).toEqual(['Done.', 'Done.']);
    expect(old[0]?.turnId).not.toBe(old[1]?.turnId);

    // The very entry of the old second turn: only the conversation tells the two turns apart.
    const fresh = await turnsOf([...clearCommand(9), second, reply('Done.', 11)], OTHER_CONVERSATION);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.text).toBe('Done.');
    expect(old.map((turn) => turn.turnId)).not.toContain(fresh[0]?.turnId);
  });

  it('two openers written in the same millisecond get different turnIds', async () => {
    const turns = await turnsOf([
      prompt('Start two agents', 0), reply('Started.', 1),
      subagentEnded(10), reply('First one is back.', 11), subagentEnded(10), reply('Second one is back.', 12),
    ]);
    expect(turns).toHaveLength(3);
    expect(new Set(turns.map((turn) => turn.turnId)).size).toBe(3);
  });
});

/**
 * The lines a standalone `/compact` leaves after a finished turn, cut from a measured file: the turn's own lines go
 * (their assistant entries carry no message there), and so do the prompt sent during the compaction and its queue
 * entries.
 */
function measuredCompact(version: string): string[] {
  const path = join(import.meta.dirname, 'fixtures', 'herdr', 'queue', 'measured', `compact-${version}.jsonl`);
  const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line !== '');
  const from = lines.findIndex((line) => line.includes('"turn_duration"')) + 1;
  const to = lines.findIndex((line) => line.includes('<local-command-stdout>'));
  return lines.slice(from, to + 1).filter((line) => !line.includes('"queue-operation"') && !line.includes('"_pomiar"'));
}

describe('a standalone `/compact` after a result turn, on measured files', () => {
  const work = [prompt('Fix the build', 0), ...tool(1), reply('Build fixed.', 3)];

  it('CLI 2.1.299: the plain "/compact" entry opens a segment with a result and no text; the turn before stays',
    async () => {
      const before = await turnsOf(work);
      const after = await turnsOf([...work, ...measuredCompact('2.1.299')]);
      expect(after).toHaveLength(2);
      expect(after[0]).toEqual(before[0]);
      expect(after[1]).toMatchObject({ opener: 'prompt', withResult: true, text: '', truncated: false });
      expect(after[1]?.input).toMatchObject({ toolCalls: 0, compactions: 1 });
    });

  it('CLI 2.1.328: the "/compact" call is a command notice and opens no segment; the turn before keeps its card',
    async () => {
      const before = await turnsOf(work);
      const after = await turnsOf([...work, ...measuredCompact('2.1.328')]);
      expect(after).toHaveLength(1);
      // The compaction boundary counts in the turn before; its id, version, text and class stay.
      const card = (turn: InputSegment | undefined) => [turn?.turnId, turn?.version, turn?.text, turn?.withResult];
      expect(card(after[0])).toEqual(card(before[0]));
      expect(after[0]?.input).toMatchObject({ compactions: 1 });
    });
});

describe('identity and version', () => {
  it('the same file read as history (merged) and entry by entry → the same turnId, version and text', async () => {
    const lines = [
      prompt('Fix the test', 0), reply('Looking.', 1), ...tool(2), reply('Found it.', 3), ...tool(4),
      reply('Fixed.', 5), subagentEnded(20), reply('Checked the agent report.', 21), wakeUp(60), reply('PING', 61),
    ];
    const merged = (await read(await writeLines(lines))).segments;
    // Each line parsed on its own: no assistant entry is merged into another.
    const perEntry = lines.flatMap((line) => parseTranscriptTail(line, { dropFirstLine: false, turnMarks: true })
      .messages);
    const entries = segmentByInput(CONVERSATION, perEntry).segments;
    const identity = (segment: InputSegment) => [segment.turnId, segment.version, segment.text];
    expect(merged.map(identity)).toEqual(entries.map(identity));
    expect(entries.map((segment) => segment.text)).toEqual(['Fixed.', 'Checked the agent report.', 'PING']);
  });

  it('late text of the same turn appended to the file → same turnId, another version', async () => {
    const path = await writeLines([prompt('Fix it', 0), ...tool(1), reply('Fixed.', 3)]);
    const first = (await read(path)).segments;
    expect((await read(path)).segments).toEqual(first);

    await appendFile(path, `${reply('Also updated the docs.', 5)}\n`);
    const second = (await read(path)).segments;
    expect(second).toHaveLength(1);
    expect(second[0]?.turnId).toBe(first[0]?.turnId);
    expect(second[0]?.version).not.toBe(first[0]?.version);
    expect(second[0]?.text).toBe('Fixed.\n\nAlso updated the docs.');
  });
});

describe('turnId and the read window', () => {
  /*
   * Two inputs share a timestamp or have none; the later one opens the last turn. A window that starts between them
   * leaves that turn's id as it is.
   */
  const cases: { name: string; extra: Record<string, unknown> }[] = [
    { name: 'the same timestamp', extra: {} },
    { name: 'no timestamp', extra: { timestamp: undefined } },
    { name: 'the same timestamp and no uuid', extra: { uuid: undefined } },
    { name: 'no timestamp and no uuid', extra: { timestamp: undefined, uuid: undefined } },
  ];

  it.each(cases)('two inputs with $name: the earlier one out of the window → the later turn keeps its id',
    async ({ extra }) => {
      const later = [user('Check the second agent.', 10, extra), reply('Second one is back.', 12)];
      const lines = [
        prompt('Start two agents', 0), reply('Started.', 1),
        user('Check the first agent.', 10, extra), reply('First one is back.', 11), ...later,
      ];
      const path = await writeLines(lines);
      // One byte more than the later turn: the window starts on the newline before it.
      const window = Buffer.byteLength(later.map((line) => `${line}\n`).join('')) + 1;
      const whole = (await read(path)).segments;
      const short = (await read(path, { firstWindow: window, maxBytes: window })).segments;

      expect(whole).toHaveLength(3);
      expect(new Set(whole.map((turn) => turn.turnId)).size).toBe(3);
      expect(short).toHaveLength(1);
      const identity = (turn: InputSegment | undefined) => [turn?.turnId, turn?.version, turn?.text];
      expect(identity(short[0])).toEqual(identity(whole[2]));
    });

  it('a list without entry identities keys an opener by its own timestamp and text, not by its place', () => {
    const lines = [
      prompt('Start two agents', 0), reply('Started.', 1),
      user('Check the first agent.', 10), reply('First one is back.', 11),
      user('Check the second agent.', 10), reply('Second one is back.', 12),
    ];
    const messages = lines.flatMap((line): ImportedMessage[] => {
      const message = parseImportLine(line)?.message;
      return message === null || message === undefined ? [] : [message];
    });
    const whole = segmentByInput(CONVERSATION, messages).segments;
    const short = segmentByInput(CONVERSATION, messages.slice(4)).segments;
    expect(new Set(whole.map((turn) => turn.turnId)).size).toBe(3);
    expect(short[0]?.turnId).toBe(whole[2]?.turnId);
  });
});

describe('reading the tail', () => {
  it('a window that starts inside a turn → no turn without its opener, and the list says so', async () => {
    const padding = { file_path: '/repo/src/a.ts', note: 'p'.repeat(400) };
    const lines = [
      prompt('Old', 0), reply('Old answer.', 1), prompt('Long job', 2),
      ...Array.from({ length: 30 }, (_, i) => tool(3 + i, padding)).flat(), reply('End.', 40),
    ];
    const result = await read(await writeLines(lines), { firstWindow: 2048, maxBytes: 2048 });
    expect(result.segments).toEqual([]);
    expect(result.startsMidTurn).toBe(true);
  });

  it('the read stops once the caller has enough segments, hidden inputs counted', async () => {
    const lines = [
      prompt('Arm the cron', 0), reply('Armed.', 1),
      ...Array.from({ length: 40 }, (_, i) => [wakeUp(60 * (i + 1)), reply(`PING ${String(i)}`, 60 * (i + 1) + 1)])
        .flat(),
    ];
    const path = await writeLines(lines);
    let reads = 0;
    const counting: ReadRange = async (...args) => {
      reads += 1;
      return readRange(...args);
    };
    const whole = await read(path, { firstWindow: 512 }, counting);
    const wholeReads = reads;
    reads = 0;
    // The transcript does not show the wake-ups: only their marks open these segments.
    const result = await read(path, { firstWindow: 512, enough: (r) => r.segments.length >= 3 }, counting);
    expect(whole.segments).toHaveLength(41);
    expect(result.segments.length).toBeGreaterThanOrEqual(3);
    expect(result.segments.length).toBeLessThan(41);
    const identity = (turn: InputSegment | undefined) => [turn?.turnId, turn?.version, turn?.text];
    expect(identity(result.segments.at(-1))).toEqual(identity(whole.segments.at(-1)));
    expect(reads).toBeLessThan(wholeReads);
  });
});
