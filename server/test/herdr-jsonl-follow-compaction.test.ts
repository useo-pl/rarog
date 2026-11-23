/**
 * A context compaction as a turn input: `herdr/jsonl-follow.ts`, event `turn-input` with `kind: 'compaction'`.
 *
 * Claude Code compacts an idle conversation before the prompt cache expires and the pane goes `working → idle`
 * with no prompt and no reply. The manager counts the compaction boundary of the main thread as an input of its
 * own kind, so the turn after it alone is a turn without a result. The entries below follow the shape measured on
 * CLI 2.1.325 (boundary, compact summary, attachments, an informational system line), with synthetic content.
 * The last block reads the `/compact` call around a compaction, in the shapes of CLI 2.1.299 and CLI 2.1.328.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectSlug } from '../src/cli-store.ts';
import { createJsonlFollower } from '../src/herdr/jsonl-follow.ts';
import type { FollowEvent, JsonlFollower } from '../src/herdr/jsonl-follow.ts';

vi.setConfig({ testTimeout: 20_000 });

const CWD = '/Users/u/Projects/atlas';
const SESSION = '7d2dd80f-012c-5c17-b97d-cf436a305158';
const TIMING = { batchMs: 15, statTickMs: 8, missingFastMs: 8, missingWindowMs: 200, missingSlowMs: 16 };

let root = '';
let dir = '';
const followers: JsonlFollower[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rarog-follow-compact-'));
  dir = join(root, projectSlug(CWD));
  await mkdir(dir, { recursive: true });
});

afterEach(async () => {
  for (const follower of followers.splice(0)) follower.close();
  await rm(root, { recursive: true, force: true });
});

const filePath = (): string => join(dir, `${SESSION}.jsonl`);

/** Atomic write (next to the file, then `rename`): the follower sees no file or the whole content. */
const createTranscript = async (content: string): Promise<void> => {
  await writeFile(`${filePath()}.partial`, content);
  await rename(`${filePath()}.partial`, filePath());
};

const line = (entry: Record<string, unknown>): string =>
  `${JSON.stringify({ isSidechain: false, sessionId: SESSION, timestamp: '2026-11-15T12:17:43.004Z', ...entry })}\n`;
const userText = (text: string): string => line({ type: 'user', message: { role: 'user', content: text } });

const boundary = (extra: Record<string, unknown> = {}): string => line({
  type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted',
  compactMetadata: { trigger: 'auto', preTokens: 230_000, postTokens: 30_000, durationMs: 45_000 }, ...extra,
});
/** The rest of a compaction in the file: summary, attachments, the informational line. None is a turn input. */
const afterBoundary = (): string => [
  line({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'Summary of the conversation.' } }),
  line({ type: 'attachment', attachment: { type: 'compact_file_reference', filename: '/x/a.ts' } }),
  line({ type: 'attachment', attachment: { type: 'hook_success', hookName: 'SessionStart:compact' } }),
  line({ type: 'system', subtype: 'informational', content: 'Compacted while idle.' }),
].join('');

const start = (): { follower: JsonlFollower; events: FollowEvent[] } => {
  const follower = createJsonlFollower({ cwd: CWD, agentSessionId: SESSION, root, watch: false, timing: TIMING });
  followers.push(follower);
  const events: FollowEvent[] = [];
  void (async () => {
    for await (const event of follower.events) events.push(event);
  })();
  return { follower, events };
};

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
};

const inputs = (events: readonly FollowEvent[]): FollowEvent[] => events.filter((e) => e.type === 'turn-input');
const hasText = (events: readonly FollowEvent[], text: string): boolean => events.some((e) => e.type === 'message'
  && e.blocks.some((block) => block.type === 'text' && block.text.text === text));

/** The follower after its first full payout: history, then the first state batch with the artifact list. */
async function primed(): Promise<{ follower: JsonlFollower; events: FollowEvent[] }> {
  await createTranscript(userText('do it'));
  const started = start();
  const { events } = started;
  await waitFor(() => events.some((e) => e.type === 'history'), 'history');
  await waitFor(() => events.some((e) => e.type === 'artifacts'), 'first artifact list');
  return started;
}

describe('compaction boundary as a turn input', () => {
  it('main thread: one `turn-input` of kind compaction, nothing for the summary, attachments and the info line',
    async () => {
      const { events } = await primed();
      const before = events.length;
      await appendFile(filePath(), boundary() + afterBoundary() + userText('end of batch'));
      await waitFor(() => hasText(events, 'end of batch'), 'end of batch');

      expect(inputs(events.slice(before))).toEqual([{ type: 'turn-input', kind: 'compaction' }]);
      expect(hasText(events, 'Summary of the conversation.')).toBe(false);
    });

  it('sidechain boundary: no turn input', async () => {
    const { events } = await primed();
    const before = events.length;
    await appendFile(filePath(), boundary({ isSidechain: true }) + userText('end of batch'));
    await waitFor(() => hasText(events, 'end of batch'), 'end of batch');

    expect(inputs(events.slice(before))).toEqual([]);
  });

  it('a boundary in the history read at attach: no turn input (live only)', async () => {
    await createTranscript(userText('do it') + boundary() + afterBoundary() + userText('after the compaction'));
    const { events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'history');
    await waitFor(() => events.some((e) => e.type === 'artifacts'), 'first artifact list');

    expect(inputs(events)).toEqual([]);
  });
});

/*
 * The `/compact` call in the file (fixtures `queue/measured/compact-2.1.299.jsonl`, `compact-2.1.328.jsonl`): CLI
 * 2.1.299 writes a plain `user` entry "/compact", and after the compaction summary the caveat, the entry with
 * `<command-name>` and the output; CLI 2.1.328 writes the same without the plain entry. One carrier per call reaches
 * the transcript, and a send from Rarog clears its echo on whichever is there.
 */
const plainCompact = (): string => userText('/compact');
const COMPACTED = 'Compacted (ctrl+o to see full summary)';
const compactCall = (): string => [
  line({
    type: 'user', isMeta: true, message: { role: 'user', content: '<local-command-caveat>Caveat.</local-command-caveat>' },
  }),
  userText('<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>'
    + '</command-args>'),
  userText(`<local-command-stdout>${COMPACTED}</local-command-stdout>`),
].join('');

const textOf = (blocks: readonly { type: string; text?: { text: string } }[]): string => blocks
  .map((block) => block.text?.text ?? block.type).join(' ');
type Shown = [string, string, string | null];
/** Messages as `[role, text, commandOutput]`. */
const shown = (events: readonly FollowEvent[]): Shown[] => events.flatMap((e): Shown[] => (
  e.type === 'message' ? [[e.role, textOf(e.blocks), e.commandOutput ?? null]] : []));

describe('`/compact` call per CLI version', () => {
  it('CLI 2.1.328, typed in the terminal: a "/compact" notice, then the output named after it', async () => {
    const { events } = await primed();
    const before = events.length;
    await appendFile(filePath(), boundary() + afterBoundary() + compactCall());
    await waitFor(() => hasText(events, COMPACTED), 'output');

    expect(shown(events.slice(before))).toEqual([['system', '/compact', null], ['system', COMPACTED, 'compact']]);
    expect(inputs(events.slice(before))).toEqual([{ type: 'turn-input', kind: 'compaction' }]);
  });

  it('CLI 2.1.328, sent from Rarog: the call clears the echo without a turn input, the output is named', async () => {
    const { follower, events } = await primed();
    const before = events.length;
    follower.dropEcho('/compact');
    await appendFile(filePath(), boundary() + afterBoundary() + compactCall());
    await waitFor(() => hasText(events, COMPACTED), 'output');

    expect(shown(events.slice(before))).toEqual([['system', COMPACTED, 'compact']]);
    expect(inputs(events.slice(before))).toEqual([{ type: 'turn-input', kind: 'compaction' }]);
  });

  it('CLI 2.1.299, sent from Rarog: the plain entry clears the echo, its tagged repeat gives nothing', async () => {
    const { follower, events } = await primed();
    const before = events.length;
    follower.dropEcho('/compact');
    await appendFile(filePath(), plainCompact() + boundary() + afterBoundary() + compactCall());
    await waitFor(() => hasText(events, COMPACTED), 'output');

    expect(shown(events.slice(before))).toEqual([['system', COMPACTED, null]]);
    expect(inputs(events.slice(before))).toEqual([{ type: 'turn-input' }, { type: 'turn-input', kind: 'compaction' }]);
  });

  it('a plain entry before a file truncation does not pair with a call written after it', async () => {
    const { follower, events } = await primed();
    const start = events.length;
    await appendFile(filePath(), plainCompact());
    await waitFor(() => hasText(events.slice(start), '/compact'), 'plain entry read');
    await writeFile(filePath(), userText('a'));
    await waitFor(() => events.some((e) => e.type === 'turn-input' && e.lost === true), 'truncation');
    const before = events.length;
    follower.dropEcho('/compact');
    await appendFile(filePath(), boundary() + afterBoundary() + compactCall());
    await waitFor(() => hasText(events, COMPACTED), 'output');
    // The call from Rarog clears its echo, so the next call typed in the terminal shows its notice.
    await appendFile(filePath(), compactCall());
    await waitFor(() => events.slice(before).filter((e) => e.type === 'message' && hasText([e], COMPACTED)).length
      === 2, 'second output');

    expect(shown(events.slice(before))).toEqual([
      ['system', COMPACTED, 'compact'], ['system', '/compact', null], ['system', COMPACTED, 'compact'],
    ]);
  });

  it.each([[false], [true]])('history read at attach, plain entry %s: one carrier of the call', async (plain) => {
    await createTranscript(userText('do it') + (plain ? plainCompact() : '') + boundary() + afterBoundary()
      + compactCall());
    const { events } = start();
    await waitFor(() => events.some((e) => e.type === 'history'), 'history');

    const got = events.flatMap((e) => (e.type === 'history' ? e.messages : [])).map((m) => [m.role, textOf(m.blocks)]);
    expect(got).toEqual([
      ['user', 'do it'], plain ? ['user', '/compact'] : ['system', '/compact'], ['system', COMPACTED],
    ]);
  });
});
