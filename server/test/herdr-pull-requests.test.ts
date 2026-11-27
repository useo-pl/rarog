/**
 * Pull requests linked to the conversation (`herdr/background/pull-requests.ts` and `pull-request-files.ts`): the
 * link entry of the main conversation file, the linked set, the conversation window and the driver's read signal.
 *
 * The core are the NEGATIVE cases: a `gh pr create` call with the URL in its result, a URL outside GitHub, an entry
 * whose number or repository disagrees with its URL, an entry without a valid time and a link entry in a subagent file
 * give nothing. The link entry here is a synthetic sample of the shape seen on CLI 2.1.296–2.1.3xx:
 * `{type: "pr-link", sessionId, prNumber, prUrl, prRepository, timestamp}`.
 */
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectSlug } from '../src/cli-store.ts';
import { createHerdrDriver } from '../src/drivers/herdr-driver.ts';
import type { DriverEvent, SessionDriver } from '../src/drivers/types.ts';
import { createAgentFileReader } from '../src/herdr/background/agent-file.ts';
import { createJsonlFollower } from '../src/herdr/jsonl-follow.ts';
import type { HerdrAgent, HerdrClient, HerdrPaneEvent, HerdrScreen } from '../src/herdr/types.ts';
import {
  LINKED_PULL_REQUESTS_MAX, parsePullRequestUrl, pullRequestLinks, pullRequestLinksSignature,
} from '../src/herdr/background/pull-requests.ts';
import { createPullRequestFilesReader } from '../src/herdr/background/pull-request-files.ts';

const CWD = '/Users/u/Projects/atlas';
const SESSION = '7d2dd80f-012c-5c17-b97d-cf436a305158';
const SESSION_B = '0b9f1a52-6c1e-4b0e-9d59-3a7c2f4e8d11';
const AGENT = 'a52b91f105b002e8d';
const PR = 'https://github.com/example/atlas/pull/42';
const PR_B = 'https://github.com/example/atlas/pull/43';
const at = (minute: number): string => new Date(Date.UTC(2026, 10, 10, 10, minute, 0)).toISOString();

/** A link entry (synthetic sample of the CLI shape). */
const link = (
  url: string, minute: number, extra: Record<string, unknown> = {},
): Record<string, unknown> => {
  const hit = /^https:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/([0-9]+)/.exec(url);
  return {
    type: 'pr-link', sessionId: SESSION, prNumber: Number(hit?.[2]), prUrl: url, prRepository: hit?.[1],
    timestamp: at(minute), ...extra,
  };
};

/** A user prompt entry (the conversation's ordinary first line). */
const prompt = (minute: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'user', timestamp: at(minute), message: { role: 'user', content: 'open a PR' }, ...extra,
});

/** A `gh pr create` call and its result with the PR URL: not a link entry. */
const createCall = (minute: number): Record<string, unknown>[] => [
  {
    type: 'assistant', timestamp: at(minute),
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'gh pr create --fill' } }],
    },
  },
  {
    type: 'user', timestamp: at(minute + 1),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: PR }] },
    toolUseResult: { stdout: PR, stderr: '', interrupted: false, isImage: false },
  },
];

const lines = (...entries: Record<string, unknown>[]): string[] => entries.map((entry) => JSON.stringify(entry));
const jsonl = (...entries: Record<string, unknown>[]): string => `${lines(...entries).join('\n')}\n`;
const urls = (links: { linked: readonly { url: string }[] } | null | undefined): string[] =>
  (links?.linked ?? []).map((pr) => pr.url);

describe('PR URL', () => {
  it('splits the URL into repository and number', () => {
    expect(parsePullRequestUrl(PR)).toEqual({ url: PR, repo: 'example/atlas', number: 42 });
  });

  it.each([
    'https://github.com/example/atlas/pull/new/feature-x',
    'https://github.com/example/atlas/pull/42/files',
    'https://github.com/example/atlas/pull/42?x=1',
    'http://github.com/example/atlas/pull/42',
    'https://github.com.evil.io/example/atlas/pull/42',
    'https://github.com/example/../pull/42',
    'https://github.com/example/atlas/pull/0',
    ` ${PR}`,
  ])('%s → nothing', (text) => {
    expect(parsePullRequestUrl(text)).toBeNull();
  });
});

describe('links from one main file', () => {
  it('116 link entries with one URL → one linked PR with the time of the first entry', () => {
    const entries = Array.from({ length: 116 }, (_, n) => link(PR, 2 + n));
    expect(pullRequestLinks(lines(prompt(0), ...entries)).linked).toEqual([
      { url: PR, repo: 'example/atlas', number: 42, createdAt: at(2) },
    ]);
  });

  it('a later entry with an earlier time moves the time back', () => {
    expect(pullRequestLinks(lines(link(PR, 9), link(PR, 4))).linked.map((pr) => pr.createdAt)).toEqual([at(4)]);
  });

  it('`gh pr create` with the URL in its result, without a link entry → nothing', () => {
    expect(pullRequestLinks(lines(prompt(0), ...createCall(1))).linked).toEqual([]);
  });

  it.each([
    ['GitLab', { prUrl: 'https://gitlab.com/example/atlas/-/merge_requests/42' }],
    ['GitHub Enterprise', { prUrl: 'https://github.example.com/example/atlas/pull/42' }],
    ['a further path', { prUrl: `${PR}/files` }],
    ['a query', { prUrl: `${PR}?w=1` }],
    ['a number other than the URL', { prNumber: 41 }],
    ['the number as a string', { prNumber: '42' }],
    ['a repository other than the URL', { prRepository: 'example/other' }],
    ['no timestamp', { timestamp: undefined }],
    ['an invalid timestamp', { timestamp: 'yesterday' }],
    ['a URL that is not a string', { prUrl: 42 }],
  ])('%s → nothing', (_name, extra) => {
    expect(pullRequestLinks(lines(prompt(0), link(PR, 1, extra))).linked).toEqual([]);
  });

  it('`sessionId` other than the file (a copy in a forked conversation) → still linked', () => {
    expect(urls(pullRequestLinks(lines(link(PR, 1, { sessionId: SESSION_B }))))).toEqual([PR]);
  });

  it(`${String(LINKED_PULL_REQUESTS_MAX + 1)} different URLs → the ${String(LINKED_PULL_REQUESTS_MAX)} newest`, () => {
    const entries = Array.from({ length: LINKED_PULL_REQUESTS_MAX + 1 }, (_, n) =>
      link(`https://github.com/example/atlas/pull/${String(n + 1)}`, n));
    const { linked } = pullRequestLinks(lines(...entries));
    expect(linked).toHaveLength(LINKED_PULL_REQUESTS_MAX);
    expect(linked[0]?.number).toBe(LINKED_PULL_REQUESTS_MAX + 1);
    expect(linked.at(-1)?.number).toBe(2);
  });

  it('window: the first line without `timestamp`, the second with it → the lower bound from the second', () => {
    const first = { type: 'custom-title', customTitle: 'atlas' };
    expect(pullRequestLinks(lines(first, prompt(3), link(PR, 7))).windowStart).toBe(at(3));
  });

  it('window: a line with only a nested `timestamp` is skipped', () => {
    const nested = { type: 'progress', data: { timestamp: at(1) } };
    expect(pullRequestLinks(lines(nested, prompt(5))).windowStart).toBe(at(5));
    expect(pullRequestLinks(lines(nested)).windowStart).toBeNull();
  });

  it('window: an invalid top-level `timestamp` does not count', () => {
    expect(pullRequestLinks(lines(prompt(0, { timestamp: 'soon' }), prompt(6))).windowStart).toBe(at(6));
  });

  it('signature: a change of the set alone or of the window alone is a new signature; an empty set is `[]`', () => {
    const one = { url: PR, repo: 'example/atlas', number: 42, createdAt: at(1) };
    const base = pullRequestLinksSignature({ linked: [one], windowStart: at(0) });
    expect(pullRequestLinksSignature({ linked: [one], windowStart: at(-5) })).not.toBe(base);
    expect(pullRequestLinksSignature({ linked: [{ ...one, createdAt: at(0) }], windowStart: at(0) })).not.toBe(base);
    expect(pullRequestLinksSignature({ linked: [], windowStart: at(0) })).toBe('[]');
    expect(pullRequestLinksSignature({ linked: [], windowStart: null })).toBe('[]');
  });
});

describe('reader of the conversation file', () => {
  let root = '';
  let logs: string[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rarog-pr-'));
    logs = [];
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const mainPath = (session = SESSION): string => join(root, projectSlug(CWD), `${session}.jsonl`);
  const subagentPath = (): string => join(root, projectSlug(CWD), SESSION, 'subagents', `agent-${AGENT}.jsonl`);

  async function seed(path: string, content: string): Promise<void> {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content);
  }

  const reader = (opts: { budgetBytes?: number } = {}) => createPullRequestFilesReader({
    root, cwd: CWD, agentSessionId: SESSION,
    ...(opts.budgetBytes === undefined ? {} : { budgetBytes: opts.budgetBytes, chunkBytes: 64 }),
    logger: (message) => { logs.push(message); },
  });

  it('main file → the linked set and the window', async () => {
    await seed(mainPath(), jsonl(prompt(0), ...createCall(1), link(PR, 3)));
    const read = await reader().read();
    expect(read?.links).toEqual({
      linked: [{ url: PR, repo: 'example/atlas', number: 42, createdAt: at(3) }], windowStart: at(0),
    });
    expect(read?.backlog).toBe(false);
  });

  it('a link entry only in a subagent file → nothing', async () => {
    await seed(mainPath(), jsonl(prompt(0)));
    await seed(subagentPath(), jsonl(link(PR, 2, { isSidechain: true, agentId: AGENT })));
    expect((await reader().read())?.links.linked).toEqual([]);
  });

  it('an append is read incrementally; the window stays from the first read', async () => {
    await seed(mainPath(), jsonl(prompt(0)));
    const pane = reader();
    expect((await pane.read())?.links).toEqual({ linked: [], windowStart: at(0) });
    await appendFile(mainPath(), jsonl(link(PR, 4)));
    expect((await pane.read())?.links).toEqual({
      linked: [{ url: PR, repo: 'example/atlas', number: 42, createdAt: at(4) }], windowStart: at(0),
    });
  });

  it('read budget: the backlog comes back in the next read, no line lost', async () => {
    const filler = jsonl(...Array.from({ length: 30 }, (_, n) => prompt(1, { uuid: `u${String(n)}` })));
    await seed(mainPath(), jsonl(prompt(0)) + filler + jsonl(link(PR, 2), link(PR_B, 3)));
    const pane = reader({ budgetBytes: 1024 });
    let read = await pane.read();
    expect(read?.backlog).toBe(true);
    for (let n = 0; n < 100 && read?.backlog === true; n += 1) read = await pane.read();
    expect(read?.backlog).toBe(false);
    expect(urls(read?.links)).toEqual([PR_B, PR]);
    expect(read?.links.windowStart).toBe(at(0));
  });

  it('a file replaced under the same name → the window is found again from its first lines', async () => {
    await seed(mainPath(), jsonl(prompt(0), link(PR, 2)));
    const pane = reader();
    expect((await pane.read())?.links.windowStart).toBe(at(0));
    await rm(mainPath());
    await seed(mainPath(), jsonl(prompt(1)));
    expect((await pane.read())?.links.windowStart).toBe(at(1));
  });

  it('`/clear` (a new conversation) → the set and the window from zero; `/resume` of the old one → its links again', async () => {
    await seed(mainPath(), jsonl(prompt(0), link(PR, 2)));
    await seed(mainPath(SESSION_B), jsonl(prompt(9)));
    const pane = reader();
    expect(urls((await pane.read())?.links)).toEqual([PR]);
    pane.repoint(SESSION_B);
    expect((await pane.read())?.links).toEqual({ linked: [], windowStart: at(9) });
    pane.repoint(SESSION);
    expect((await pane.read())?.links).toEqual({
      linked: [{ url: PR, repo: 'example/atlas', number: 42, createdAt: at(2) }], windowStart: at(0),
    });
  });

  it('no conversation file → an empty set without a window, no error', async () => {
    expect((await reader().read())?.links).toEqual({ linked: [], windowStart: null });
  });

  it('a read interrupted by `repoint` gives nothing', async () => {
    await seed(mainPath(), jsonl(prompt(0), link(PR, 2)));
    const pane = reader();
    const pending = pane.read();
    pane.repoint(SESSION_B);
    expect(await pending).toBeNull();
  });
});

/** A herdr client the driver does not use in this test (pattern: `herdr-artifacts-integracja.test.ts`). */
class QuietClient implements HerdrClient {
  listAgents(): Promise<never> { return Promise.reject(new Error('unused')); }
  getAgent(): Promise<never> { return Promise.reject(new Error('unused')); }
  readScreen(): Promise<HerdrScreen> { return Promise.resolve({ text: '' }); }
  readPaneHistory(): Promise<{ text: string; truncated: boolean }> {
    return Promise.resolve({ text: '', truncated: false });
  }
  prompt(): Promise<void> { return Promise.resolve(); }
  sendFormSubmit(): Promise<void> { return Promise.resolve(); }
  sendModeCycle(): Promise<void> { return Promise.resolve(); }
  pasteText(): Promise<void> { return Promise.resolve(); }
  sendPromptSubmit(): Promise<void> { return Promise.resolve(); }
  sendTrustStep(): Promise<void> { return Promise.resolve(); }
  sendDialogKey(): Promise<void> { return Promise.resolve(); }
  sendTakeBackKey(): Promise<void> { return Promise.resolve(); }
  sendKeys(): Promise<void> { return Promise.resolve(); }
  focus(): Promise<void> { return Promise.resolve(); }
  ping(): Promise<{ version: string; protocol: number }> { return Promise.resolve({ version: '0.8.2', protocol: 20 }); }
}

describe('driver: links to the manager (`pull-requests` event)', () => {
  let root = '';
  let driver: SessionDriver | null = null;
  const TIMING = { batchMs: 10, statTickMs: 8, missingFastMs: 8, missingWindowMs: 200, missingSlowMs: 16 };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'rarog-pr-driver-'));
  });

  afterEach(async () => {
    driver?.dispose();
    driver = null;
    await rm(root, { recursive: true, force: true });
  });

  const store = (): string => join(root, projectSlug(CWD));

  async function attach(): Promise<{ events: DriverEvent[]; emit: (event: HerdrPaneEvent) => void }> {
    const listeners = new Set<(event: HerdrPaneEvent) => void>();
    const agent: HerdrAgent = {
      key: 'w9:p73', paneId: 'w9:p73', agentSessionId: SESSION, cwd: CWD, status: 'idle', title: 'pr',
      stateChangeSeq: 1, mode: 'auto', modeReadAt: 0, inScope: true, engine: 'claude', termId: null,
      tabId: 'w9:t3', launchedByRarog: false, interactiveReady: true,
    };
    driver = createHerdrDriver({
      agent,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    }, {
      client: new QuietClient(), audit: { log: () => undefined }, yoloRoots: [], now: () => Date.now(),
      follow: (o) => createJsonlFollower({ ...o, root, watch: false, timing: TIMING }),
      agentFiles: (o) => createAgentFileReader({ ...o, root }),
      pullRequestsPollMs: 5,
    });
    const events: DriverEvent[] = [];
    void (async () => {
      for await (const event of driver?.events ?? []) events.push(event);
    })();
    return { events, emit: (event) => { for (const listener of listeners) listener(event); } };
  }

  const payouts = (events: readonly DriverEvent[]): { urls: string[]; windowStart?: string }[] => events.flatMap(
    (event) => (event.type === 'pull-requests'
      ? [{ urls: event.pullRequests.map((pr) => pr.url), ...(event.windowStart === undefined ? {} : {
        windowStart: event.windowStart,
      }) }]
      : []),
  );

  async function waitFor(check: () => boolean, what: string): Promise<void> {
    for (let n = 0; n < 400; n += 1) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`not reached: ${what}`);
  }

  it('main file → links with the window; the empty set after attach does not go out; `/clear` → empty', async () => {
    await mkdir(store(), { recursive: true });
    await writeFile(join(store(), `${SESSION}.jsonl`), jsonl(prompt(0)));
    await writeFile(join(store(), `${SESSION_B}.jsonl`), jsonl(prompt(30)));
    const pane = await attach();
    // Without links the driver pays nothing out: the empty set after attach is not a change.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(payouts(pane.events)).toEqual([]);

    await appendFile(join(store(), `${SESSION}.jsonl`), jsonl(prompt(1), link(PR, 2)));
    await waitFor(() => payouts(pane.events).length === 1, 'link from the main file');
    expect(payouts(pane.events)).toEqual([{ urls: [PR], windowStart: at(0) }]);

    pane.emit({ type: 'session-changed', agentSessionId: SESSION_B });
    await waitFor(() => payouts(pane.events).length === 2, 'empty set after `/clear`');
    // An empty set goes out without waiting for the new window (an empty set has one signature whatever the window).
    expect(payouts(pane.events).at(-1)?.urls).toEqual([]);
  });

  it('a link entry appended alone after the previous read timer expired → a new read and the link', async () => {
    await mkdir(store(), { recursive: true });
    await writeFile(join(store(), `${SESSION}.jsonl`), jsonl(prompt(0)));
    const pane = await attach();
    // The attach read and any read ordered by the history are long done (poll delay 5 ms).
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(payouts(pane.events)).toEqual([]);

    await appendFile(join(store(), `${SESSION}.jsonl`), jsonl(link(PR, 2)));
    await waitFor(() => payouts(pane.events).length === 1, 'link appended alone');
    expect(payouts(pane.events)).toEqual([{ urls: [PR], windowStart: at(0) }]);
    // Only the read signal: the entry gives the manager no other event.
    expect(pane.events.filter((event) => event.type === 'message' || event.type === 'turn-input')).toEqual([]);
  });

  it('a link entry only in a subagent file → no payout', async () => {
    await mkdir(join(store(), SESSION, 'subagents'), { recursive: true });
    await writeFile(join(store(), `${SESSION}.jsonl`), jsonl(prompt(0)));
    const pane = await attach();
    await writeFile(join(store(), SESSION, 'subagents', `agent-${AGENT}.jsonl`),
      jsonl(link(PR, 2, { isSidechain: true, agentId: AGENT })));
    await appendFile(join(store(), `${SESSION}.jsonl`), jsonl(prompt(3)));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(payouts(pane.events)).toEqual([]);
  });
});
