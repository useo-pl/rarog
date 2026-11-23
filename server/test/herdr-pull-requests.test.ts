/**
 * Pull requesty sesji (`herdr/background/pull-requests.ts` i `pull-request-files.ts`): rozpoznanie
 * `gh pr create` w plikach rozmowy i lista.
 *
 * Sedno to przypadki UJEMNE: PR-em nie jest adres z tekstu, z wyniku `Read`, z `echo`, odnośnik
 * `pull/new/<gałąź>` ani wynik, którego wywołania w tym samym pliku nie widzieliśmy. Kształt wyniku `Bash`
 * (blok `tool_result` z treścią jako napisem, `toolUseResult` obok) zmierzony na magazynie CLI tego konta:
 * 83 wyniki `gh pr create`, w każdym udanym adres stał w treści bloku jako osobna linia.
 */
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Runs once, just before the reader reads a background output file through `safe-read.ts`. */
const outputReadHook: { run: (() => void) | null } = { run: null };
vi.mock('../src/safe-read.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/safe-read.ts')>();
  return {
    ...real,
    readRegularFile: (...args: Parameters<typeof real.readRegularFile>) => {
      const run = outputReadHook.run;
      outputReadHook.run = null;
      run?.();
      return real.readRegularFile(...args);
    },
  };
});
import { projectSlug } from '../src/cli-store.ts';
import { createHerdrDriver } from '../src/drivers/herdr-driver.ts';
import type { DriverEvent, SessionDriver } from '../src/drivers/types.ts';
import { createAgentFileReader } from '../src/herdr/background/agent-file.ts';
import { createJsonlFollower } from '../src/herdr/jsonl-follow.ts';
import type { HerdrAgent, HerdrClient, HerdrPaneEvent, HerdrScreen } from '../src/herdr/types.ts';
import { parseTaskNotification } from '../src/herdr/background/notification.ts';
import {
  PULL_REQUESTS_MAX, PULL_REQUEST_TITLE_MAX, createPullRequestCalls, parsePullRequestUrl, pullRequestCommand,
  pullRequestsOf, pullRequestsSignature, sessionPullRequests,
} from '../src/herdr/background/pull-requests.ts';
import {
  PULL_REQUEST_OUTPUT_MAX_BYTES, createPullRequestFilesReader,
} from '../src/herdr/background/pull-request-files.ts';

const CWD = '/Users/u/Projects/atlas';
const SESSION = '7d2dd80f-012c-5c17-b97d-cf436a305158';
const SESSION_B = '0b9f1a52-6c1e-4b0e-9d59-3a7c2f4e8d11';
const AGENT = 'a52b91f105b002e8d';
const AGENT_WF = 'a0c4e21f9d8b7a6c5';
const RUN = 'wf_421c15f4-292';
const PR = 'https://github.com/acme/widget/pull/42';
const PR_B = 'https://github.com/acme/widget/pull/43';
const at = (minute: number): string => new Date(Date.UTC(2026, 10, 10, 10, minute, 0)).toISOString();

/** Wywołanie `Bash` we wpisie asystenta (kształt CLI: blok `tool_use` z `input.command`). */
const call = (id: string, command: string, minute = 0, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'assistant', timestamp: at(minute), ...extra,
  message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command, description: 'x' } }] },
});

/** Wynik narzędzia: blok `tool_result` z treścią i `toolUseResult` obok (kształt zmierzony). */
const result = (
  id: string, content: unknown, minute = 1, opts: { error?: boolean; extra?: Record<string, unknown> } = {},
): Record<string, unknown> => ({
  type: 'user', timestamp: at(minute), ...opts.extra,
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content, ...(opts.error === true ? { is_error: true } : {}) }],
  },
  toolUseResult: opts.error === true
    ? `Error: ${String(content)}`
    : { stdout: String(content), stderr: '', interrupted: false, isImage: false, noOutputExpected: false },
});

/** Result of a `Bash` call that runs in the background: no output yet, the task id in `toolUseResult`. */
const backgroundResult = (id: string, taskId: string, minute = 1): Record<string, unknown> => ({
  type: 'user', timestamp: at(minute),
  message: {
    role: 'user',
    content: [{
      type: 'tool_result', tool_use_id: id,
      content: `Command running in background with ID: ${taskId}. Output is being written to: /x/${taskId}.output`,
    }],
  },
  toolUseResult: {
    stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: taskId,
  },
});

/** The CLI's notification about the end of a background task (shape measured on CLI 2.1.316). */
const finished = (
  opts: { toolUseId: string; taskId: string; outputFile: string; status?: string | null; minute?: number },
): Record<string, unknown> => ({
  type: 'user', timestamp: at(opts.minute ?? 9), origin: { kind: 'task-notification' },
  message: {
    role: 'user',
    content: `<task-notification>\n<task-id>${opts.taskId}</task-id>\n<tool-use-id>${opts.toolUseId}</tool-use-id>\n`
      + `<output-file>${opts.outputFile}</output-file>\n`
      + (opts.status === null ? '' : `<status>${opts.status ?? 'completed'}</status>\n`)
      + '<summary>Background command "Open the draft PR" completed (exit code 0)</summary>\n</task-notification>',
  },
});

const lines = (...entries: Record<string, unknown>[]): string[] => entries.map((entry) => JSON.stringify(entry));
const jsonl = (...entries: Record<string, unknown>[]): string => `${lines(...entries).join('\n')}\n`;

describe('rozpoznanie polecenia `gh pr create`', () => {
  it.each([
    ['gh pr create --fill', {}],
    ['gh pr create --fill && false', {}],
    ['cd /repo && GH_PAGER=cat gh pr create --title "Poprawka kolejki" --body x', { title: 'Poprawka kolejki' }],
    ["git push -u origin x; /opt/homebrew/bin/gh pr create -t 'Tytuł' -b ''", { title: 'Tytuł' }],
    ['gh pr create --title=Krótki --fill', { title: 'Krótki' }],
    ['env GH_PAGER=cat gh pr create --fill | tee out.txt', {}],
    ['gh pr create --title "$T" --fill', {}],
    [`gh pr create --title "Etap 2" --body "$(cat <<'EOF'\n## Podsumowanie\n- "a"; b && echo ) x\nEOF\n)"`, { title: 'Etap 2' }],
    ['gh pr  create --fill', {}],
    ['gh pr\tcreate --fill', {}],
    ['gh pr create --fill && echo "PR gotowy"', {}],
    ['gh pr create --fill 2>&1 | tail -5', {}],
    // Shapes measured in the CLI store: the body written to a file in the same call, then created from it.
    [
      `B=$(mktemp -d "$TMPDIR/pr.XXXXXX") && cat > "$B/body.md" <<'EOF'\n## Why\n`
        + 'https://github.com/acme/widget/pull/41\nEOF\n'
        + 'cd /repo && GH_PAGER=cat gh pr create --title "Etap 4a" --body-file "$B/body.md"',
      { title: 'Etap 4a' },
    ],
    ['cat >>$B/body.md <<EOF\nx\nEOF\ngh pr create --fill 2>&1 | tail -2', {}],
    ['cat 1>body.md <<EOF\nx\nEOF\ngh pr create --fill', {}],
    [`printf '%s\\n' "$BODY" > "$B/body.md"; gh pr create --fill`, {}],
    ['echo "$BODY" &> body.md; gh pr create --fill', {}],
    [`awk 'length > 120 {print NR": "length}' "$B/body.md"; gh pr create --fill`, {}],
    [`awk 'length > 140 {print FNR": "length}' body.md; gh pr create --fill`, {}],
    [`sed -i '' 's/RESULT_LINE/1709 examples/' "$B/body.md" && gh pr create --fill`, {}],
    ['gh pr create --fill; rm -r "$B"', {}],
    ['mkdir -p x && cp a b && mv c d && touch e && chmod 600 f && ln -s g h && gh pr create --fill', {}],
    // Several creates in one call: every created PR counts, but a title cannot be tied to its URL.
    ['gh pr create --title A --fill; gh pr create --title B --fill', {}],
    // `timeout` (GNU coreutils, also `gtimeout` from Homebrew) in front of the program.
    ['timeout 180 gh pr create --draft --title "T" --body-file b.md', { title: 'T' }],
    ['timeout -s KILL 5m gh pr create --fill', {}],
    ['timeout -sKILL 1.5h gh pr create --fill', {}],
    ['timeout --signal=TERM --preserve-status 30s gh pr create --fill', {}],
    ['timeout --signal TERM -v 30 gh pr create --fill', {}],
    ['timeout --kill-after=10 30 gh pr create --fill', {}],
    ['timeout -k 10 30 gh pr create --fill', {}],
    ['timeout --foreground 2d gh pr create --fill', {}],
    ['gtimeout 60 gh pr create --fill', {}],
    ['GH_PAGER=cat timeout 60 env X=1 gh pr create --fill', {}],
    ['timeout 5 git push && gh pr create --fill', {}],
    ['timeout -- 180 gh pr create --fill', {}],
    ['gtimeout --foreground -- 30 gh pr create --fill', {}],
  ])('%s → PR', (command, expected) => {
    expect(pullRequestCommand(command)).toEqual(expected);
  });

  it.each([
    'echo "gh pr create"',
    'echo gh pr create && echo https://github.com/acme/widget/pull/42',
    "grep -rn 'gh pr create' docs",
    'gh pr view 42',
    'gh pr list',
    '# gh pr create',
    'git commit -m "gh pr create; x"',
    'cat <<EOF\ngh pr create\nEOF',
    // Wynik niejednoznaczny: adres PR mógł przyjść od innego segmentu niż `create`.
    'gh pr view --json url --jq .url || gh pr create --fill',
    "false && gh pr create --fill; printf '%s\\n' 'https://github.com/acme/widget/pull/42'",
    'gh pr create --fill; echo https://github.com/acme/widget/pull/41',
    'gh pr create --fill && cat pr-url.txt',
    'gh pr create --fill && echo "$URL"',
    // Output that reaches the result: no redirect, a redirect to the result's own streams, or a verbose file tool.
    'cat pr.txt >&2; gh pr create --fill',
    'cat pr.txt 1>&2; gh pr create --fill',
    'cat > /dev/stdout <<EOF\nhttps://github.com/acme/widget/pull/41\nEOF\ngh pr create --fill',
    `printf '%s\\n' "$URL" > /dev/stderr; gh pr create --fill`,
    "awk '{print}' body.md; gh pr create --fill",
    `awk 'length > 120 {print NR": "length}' -f x.awk body.md; gh pr create --fill`,
    "sed 's/a/b/' body.md; gh pr create --fill",
    "sed -i '' 'w /dev/stdout' body.md; gh pr create --fill",
    'cp -v https://github.com/acme/widget/pull/41 x; gh pr create --fill',
    'rm -rv "$B"; gh pr create --fill',
    'gh pr create --fill; ls',
    // A quoted or escaped `>` is an argument, not a redirect.
    `printf "%s\\n" "$URL" ">body"; false && gh pr create --fill`,
    'printf "%s\\n" "$URL" \\>body; false && gh pr create --fill',
    // A command substitution in an argument can print to stderr, which lands in the result.
    `printf "%s\\n" "$(printf "%s\\n" "$URL" >&2)" > /dev/null; false && gh pr create --fill`,
    'rm `echo "$URL" >&2`; false && gh pr create --fill',
    // An awk variable assignment after the script changes what it prints.
    `awk 'length > 0 {print NR": "length}' ORS="$SEPARATOR" /dev/stdin; false && gh pr create --fill`,
    // `timeout` without a duration, with an option it does not have, or in front of a loud program.
    'timeout gh pr create --fill',
    'timeout 90 gh pr list',
    'timeout 5 gh pr list; gh pr create --fill',
    'timeout --kill-after 30 gh pr create --fill',
    'timeout -x 30 gh pr create --fill',
    'timeout 30x gh pr create --fill',
    'timeout "$T" gh pr create --fill',
    'timeout -s "$SIG" 30 gh pr create --fill',
  ])('%s → nic', (command) => {
    expect(pullRequestCommand(command)).toBeNull();
  });

  it('tytuł bez znaków sterujących i przycięty', () => {
    const long = 'x'.repeat(PULL_REQUEST_TITLE_MAX + 50);
    expect(pullRequestCommand(`gh pr create --title "${long}"`)?.title).toHaveLength(PULL_REQUEST_TITLE_MAX);
    expect(pullRequestCommand("gh pr create --title $'a\\tb'")).toEqual({});
  });
});

describe('adres PR', () => {
  it('rozkłada adres na repo i numer', () => {
    expect(parsePullRequestUrl(PR)).toEqual({ url: PR, repo: 'acme/widget', number: 42 });
  });

  it.each([
    'https://github.com/acme/widget/pull/new/feature-x',
    'https://github.com/acme/widget/pull/42/files',
    'https://github.com/acme/widget/pull/42?x=1',
    'http://github.com/acme/widget/pull/42',
    'https://github.com.evil.io/acme/widget/pull/42',
    'https://github.com/useo/../pull/42',
    'https://github.com/acme/widget/pull/0',
    ` ${PR}`,
  ])('%s → nic', (text) => {
    expect(parsePullRequestUrl(text)).toBeNull();
  });
});

describe('lista z jednego pliku', () => {
  it('`gh pr create` i adres z numerem w wyniku → PR', () => {
    const list = sessionPullRequests(lines(
      call('toolu_1', 'gh pr create --title "Kolejka" --fill'),
      result('toolu_1', `Warning: 1 uncommitted change\n${PR}\n`, 3),
    ));
    expect(list).toEqual([{ url: PR, repo: 'acme/widget', number: 42, createdAt: at(3), title: 'Kolejka' }]);
  });

  it('body written by `cat` heredoc in the same call (measured shape) → PR with title', () => {
    const command = `B=$(mktemp -d "$TMPDIR/pr4a.XXXXXX") && cat > $B/body.md <<'EOF'\n### Overview\nx\nEOF\n`
      + 'cd /repo && GH_PAGER=cat gh pr create --draft --title "Etap 4a" --body-file $B/body.md';
    const list = sessionPullRequests(lines(
      call('toolu_1', command),
      result('toolu_1', `${PR}\nShell cwd was reset to /repo`, 3),
    ));
    expect(list).toEqual([{ url: PR, repo: 'acme/widget', number: 42, createdAt: at(3), title: 'Etap 4a' }]);
  });

  it('two creates in one call → both PRs, without titles', () => {
    const list = sessionPullRequests(lines(
      call('toolu_1', 'gh pr create --title A --fill; gh pr create --title B --fill'),
      result('toolu_1', `${PR}\n${PR_B}`, 3),
    ));
    expect(list).toEqual([
      { url: PR_B, repo: 'acme/widget', number: 43, createdAt: at(3) },
      { url: PR, repo: 'acme/widget', number: 42, createdAt: at(3) },
    ]);
  });

  it('`gh pr create --fill && false` → PR mimo kodu wyjścia', () => {
    const list = sessionPullRequests(lines(
      call('toolu_1', 'gh pr create --fill && false'),
      result('toolu_1', `Exit code 1\n${PR}`, 2, { error: true }),
    ));
    expect(list.map((pr) => pr.url)).toEqual([PR]);
  });

  it('treść wyniku jako tablica bloków tekstu też się liczy', () => {
    const list = sessionPullRequests(lines(
      call('toolu_1', 'gh pr create --fill'),
      result('toolu_1', [{ type: 'text', text: `${PR}\n` }]),
    ));
    expect(list.map((pr) => pr.url)).toEqual([PR]);
  });

  it('`echo "gh pr create" && echo <url>` → nic', () => {
    expect(sessionPullRequests(lines(
      call('toolu_1', `echo "gh pr create" && echo ${PR}`),
      result('toolu_1', `gh pr create\n${PR}`),
    ))).toEqual([]);
  });

  it('`pull/new/<branch>` → nic', () => {
    expect(sessionPullRequests(lines(
      call('toolu_1', 'git push -u origin feature && gh pr create --web'),
      result('toolu_1', 'remote: Create a pull request for \'feature\' on GitHub by visiting:\n'
        + 'https://github.com/acme/widget/pull/new/feature\n'),
    ))).toEqual([]);
  });

  it('PR, który już istniał (komunikat `gh` na stderr), → nic', () => {
    expect(sessionPullRequests(lines(
      call('toolu_1', 'gh pr create --fill'),
      result('toolu_1', `Exit code 1\na pull request for branch "x" into branch "main" already exists:\n${PR}`, 1,
        { error: true }),
    ))).toEqual([]);
  });

  it('adres w wyniku `Read` albo w tekście → nic', () => {
    const read = {
      type: 'assistant', timestamp: at(0),
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_r', name: 'Read', input: { file_path: '/x' } }] },
    };
    const text = {
      type: 'assistant', timestamp: at(2),
      message: { role: 'assistant', content: [{ type: 'text', text: `Utworzyłem PR:\n${PR}` }] },
    };
    const prompt = { type: 'user', timestamp: at(3), message: { role: 'user', content: `${PR}` } };
    expect(sessionPullRequests(lines(read, result('toolu_r', `1\t${PR}\n${PR}`), text, prompt))).toEqual([]);
  });

  it('wynik za granicą okna historii bez wywołania → nic', () => {
    // Wywołanie stało przed miejscem, od którego plik znamy: sam wynik niczego nie dowodzi.
    expect(sessionPullRequests(lines(result('toolu_1', PR)))).toEqual([]);
  });

  it('dwa razy ten sam URL → jeden, z czasem pierwszego utworzenia', () => {
    const list = sessionPullRequests(lines(
      call('toolu_1', 'gh pr create --fill', 0),
      result('toolu_1', PR, 1),
      call('toolu_2', 'gh pr create --title "Druga próba"', 5),
      result('toolu_2', PR, 6),
    ));
    expect(list).toEqual([{ url: PR, repo: 'acme/widget', number: 42, createdAt: at(1), title: 'Druga próba' }]);
  });

  it('najnowszy pierwszy, najwyżej sufit listy', () => {
    const entries: Record<string, unknown>[] = [];
    for (let n = 1; n <= PULL_REQUESTS_MAX + 3; n += 1) {
      entries.push(call(`toolu_${String(n)}`, 'gh pr create --fill', n));
      entries.push(result(`toolu_${String(n)}`, `https://github.com/acme/widget/pull/${String(n)}`, n));
    }
    const list = sessionPullRequests(lines(...entries));
    expect(list).toHaveLength(PULL_REQUESTS_MAX);
    expect(list[0]?.number).toBe(PULL_REQUESTS_MAX + 3);
    expect(list.at(-1)?.number).toBe(4);
  });

  it('podpis listy obejmuje adres, czas i tytuł', () => {
    const one = { url: PR, repo: 'acme/widget', number: 42, createdAt: at(1) };
    expect(pullRequestsSignature([one])).not.toBe(pullRequestsSignature([{ ...one, title: 't' }]));
    expect(pullRequestsSignature([])).toBe('[]');
  });
});

describe('`timeout` in front of `gh pr create`', () => {
  it('`timeout 180 gh pr create` with the URL in the result → PR with title', () => {
    const list = sessionPullRequests(lines(
      call('toolu_1', 'timeout 180 gh pr create --draft --title "T" --body-file b.md'),
      result('toolu_1', 'https://github.com/o/r/pull/5\n', 3),
    ));
    expect(list).toEqual([{ url: 'https://github.com/o/r/pull/5', repo: 'o/r', number: 5, createdAt: at(3), title: 'T' }]);
  });
});

describe('command in the background: the pure module asks for the output file', () => {
  const OUTPUT = `/private/tmp/claude-501/-Users-u-atlas/${SESSION}/tasks/abc123.output`;

  /** Runs entries through one file's memory; returns the PRs and the output reads asked for. */
  const run = (...entries: Record<string, unknown>[]): { pullRequests: unknown[]; outputs: unknown[] } => {
    const calls = createPullRequestCalls();
    const found = entries.map((entry) => pullRequestsOf(JSON.parse(JSON.stringify(entry)), calls));
    return { pullRequests: found.flatMap((item) => item.pullRequests), outputs: found.flatMap((item) => item.outputs) };
  };

  it('parser reads the tool use id and the output file of the notification', () => {
    const message = finished({ toolUseId: 'toolu_9', taskId: 'abc123', outputFile: OUTPUT })['message'];
    const parsed = parseTaskNotification((message as { content: string }).content);
    expect([parsed.id, parsed.toolUseId, parsed.outputFile, parsed.status])
      .toEqual(['abc123', 'toolu_9', OUTPUT, 'completed']);
    expect(parseTaskNotification('<task-notification>\n<task-id>x</task-id>\n</task-notification>'))
      .toMatchObject({ toolUseId: '', outputFile: '' });
  });

  it('recognized call moved to the background, then its notification → one read of the output file', () => {
    const { pullRequests, outputs } = run(
      call('toolu_1', 'timeout 180 gh pr create --title "T" --fill'),
      backgroundResult('toolu_1', 'abc123', 3),
      finished({ toolUseId: 'toolu_1', taskId: 'abc123', outputFile: OUTPUT, minute: 7 }),
    );
    expect(pullRequests).toEqual([]);
    expect(outputs).toEqual([{ path: OUTPUT, taskId: 'abc123', createdAt: at(7), title: 'T' }]);
  });

  it('a second copy of the notification asks nothing more', () => {
    const note = finished({ toolUseId: 'toolu_1', taskId: 'abc123', outputFile: OUTPUT, status: 'failed' });
    expect(run(call('toolu_1', 'gh pr create --fill'), backgroundResult('toolu_1', 'abc123'), note, note).outputs)
      .toEqual([{ path: OUTPUT, taskId: 'abc123', createdAt: at(9) }]);
  });

  it('result that already carries the URL → PR at once, no wait', () => {
    const entry = backgroundResult('toolu_1', 'abc123', 3);
    const [block] = (entry['message'] as { content: { content: string }[] }).content;
    if (block !== undefined) block.content = PR;
    const { pullRequests, outputs } = run(
      call('toolu_1', 'gh pr create --fill'), entry,
      finished({ toolUseId: 'toolu_1', taskId: 'abc123', outputFile: OUTPUT }),
    );
    expect(pullRequests).toEqual([{ url: PR, repo: 'acme/widget', number: 42, createdAt: at(3) }]);
    expect(outputs).toEqual([]);
  });

  it.each([
    ['call that is not `gh pr create`', 'npm test', 'toolu_1', 'abc123'],
    ['task id that does not match', 'gh pr create --fill', 'toolu_1', 'zzz999'],
    ['tool use id of another call', 'gh pr create --fill', 'toolu_2', 'abc123'],
  ])('%s → no read', (_name, command, toolUseId, taskId) => {
    expect(run(
      call('toolu_1', command), backgroundResult('toolu_1', 'abc123'),
      finished({ toolUseId, taskId, outputFile: OUTPUT }),
    ).outputs).toEqual([]);
  });

  it.each(['abc/123', '../x', 'ABC123', 'a'.repeat(33), ''])('background task id %j → no wait, no read', (taskId) => {
    expect(run(
      call('toolu_1', 'gh pr create --fill'), backgroundResult('toolu_1', taskId),
      finished({ toolUseId: 'toolu_1', taskId, outputFile: OUTPUT }),
    ).outputs).toEqual([]);
  });

  it('notification without `<status>` → nothing, the call keeps waiting', () => {
    expect(run(
      call('toolu_1', 'gh pr create --fill'), backgroundResult('toolu_1', 'abc123'),
      finished({ toolUseId: 'toolu_1', taskId: 'abc123', outputFile: OUTPUT, status: null }),
      finished({ toolUseId: 'toolu_1', taskId: 'abc123', outputFile: OUTPUT, minute: 12 }),
    ).outputs).toEqual([{ path: OUTPUT, taskId: 'abc123', createdAt: at(12) }]);
  });

  it('notification text without the harness origin (a pasted prompt) → nothing', () => {
    const pasted = finished({ toolUseId: 'toolu_1', taskId: 'abc123', outputFile: OUTPUT });
    delete pasted['origin'];
    expect(run(call('toolu_1', 'gh pr create --fill'), backgroundResult('toolu_1', 'abc123'), pasted).outputs)
      .toEqual([]);
  });
});

describe('czytnik plików rozmowy', () => {
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
  const satellite = (session = SESSION): string => join(root, projectSlug(CWD), session);
  const subagentPath = (session = SESSION): string => join(satellite(session), 'subagents', `agent-${AGENT}.jsonl`);
  const workflowAgentPath = (): string =>
    join(satellite(), 'subagents', 'workflows', RUN, `agent-${AGENT_WF}.jsonl`);

  async function seed(path: string, content: string): Promise<void> {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content);
  }

  const reader = (opts: { subagents?: boolean; budgetBytes?: number } = {}) => createPullRequestFilesReader({
    root, cwd: CWD, agentSessionId: SESSION, subagents: opts.subagents ?? true,
    ...(opts.budgetBytes === undefined ? {} : { budgetBytes: opts.budgetBytes, chunkBytes: 64 }),
    logger: (message) => { logs.push(message); },
  });

  it.each(['gh pr  create --fill', 'gh pr\tcreate --fill'])('%j przez czytnik (prefiltr) → PR', async (command) => {
    await seed(mainPath(), jsonl(call('toolu_1', command), result('toolu_1', PR)));
    expect((await reader().read())?.pullRequests.map((pr) => pr.url)).toEqual([PR]);
  });

  it('plik główny → PR', async () => {
    await seed(mainPath(), jsonl(call('toolu_1', 'gh pr create --fill'), result('toolu_1', PR)));
    const read = await reader().read();
    expect(read?.pullRequests.map((pr) => pr.url)).toEqual([PR]);
    expect(read?.backlog).toBe(false);
  });

  it('subagent → PR', async () => {
    await seed(mainPath(), jsonl(call('toolu_m', 'ls')));
    await seed(subagentPath(), jsonl(
      call('toolu_1', 'gh pr create --fill', 0, { isSidechain: true, agentId: AGENT }),
      result('toolu_1', PR, 2, { extra: { isSidechain: true, agentId: AGENT } }),
    ));
    expect((await reader().read())?.pullRequests.map((pr) => pr.url)).toEqual([PR]);
  });

  it('agent workflow → PR', async () => {
    await seed(mainPath(), jsonl(call('toolu_m', 'ls')));
    await seed(workflowAgentPath(), jsonl(
      call('toolu_1', 'gh pr create --title "Z10a"', 0, { isSidechain: true, agentId: AGENT_WF }),
      result('toolu_1', PR, 2, { extra: { isSidechain: true, agentId: AGENT_WF } }),
    ));
    expect((await reader().read())?.pullRequests).toEqual([
      { url: PR, repo: 'acme/widget', number: 42, createdAt: at(2), title: 'Z10a' },
    ]);
  });

  it('bez zgody na pliki subagentów (`RAROG_AGENT_FILES=0`) czyta tylko plik główny', async () => {
    await seed(mainPath(), jsonl(call('toolu_m', 'ls')));
    await seed(subagentPath(), jsonl(call('toolu_1', 'gh pr create --fill'), result('toolu_1', PR)));
    expect((await reader({ subagents: false }).read())?.pullRequests).toEqual([]);
  });

  it('agent kończy pracę, serwer startuje od nowa → PR dalej na liście', async () => {
    await seed(mainPath(), jsonl(call('toolu_m', 'ls')));
    await seed(subagentPath(), jsonl(call('toolu_1', 'gh pr create --fill'), result('toolu_1', PR)));
    const first = reader();
    expect((await first.read())?.pullRequests.map((pr) => pr.url)).toEqual([PR]);
    // Koniec agenta: plik główny dostaje jego wynik, plik subagenta już nie rośnie.
    await appendFile(mainPath(), jsonl(result('toolu_m', 'agent done', 9)));
    expect((await first.read())?.pullRequests.map((pr) => pr.url)).toEqual([PR]);
    first.close();
    // Restart serwera: nowy czytnik, te same pliki.
    expect((await reader().read())?.pullRequests.map((pr) => pr.url)).toEqual([PR]);
  });

  it('dopisek do pliku czyta przyrostowo, wywołanie i wynik w różnych odczytach', async () => {
    await seed(mainPath(), jsonl(call('toolu_1', 'gh pr create --fill')));
    const pane = reader();
    expect((await pane.read())?.pullRequests).toEqual([]);
    await appendFile(mainPath(), jsonl(result('toolu_1', PR, 4)));
    expect((await pane.read())?.pullRequests.map((pr) => pr.createdAt)).toEqual([at(4)]);
  });

  it('wywołanie w pliku głównym, wynik o tym samym id w pliku subagenta → nic (para w jednym pliku)', async () => {
    await seed(mainPath(), jsonl(call('toolu_1', 'gh pr create --fill')));
    await seed(subagentPath(), jsonl(result('toolu_1', PR)));
    expect((await reader().read())?.pullRequests).toEqual([]);
  });

  it('dwa razy ten sam URL w dwóch plikach → jeden', async () => {
    await seed(mainPath(), jsonl(call('toolu_1', 'gh pr create --fill', 0), result('toolu_1', PR, 5)));
    await seed(subagentPath(), jsonl(call('toolu_9', 'gh pr create --fill', 0), result('toolu_9', PR, 2)));
    const list = (await reader().read())?.pullRequests ?? [];
    expect(list.map((pr) => [pr.url, pr.createdAt])).toEqual([[PR, at(2)]]);
  });

  it('budżet odczytu: zaległość wraca w następnym odczycie, bez zgubionych linii', async () => {
    const filler = jsonl(...Array.from({ length: 30 }, (_, n) => call(`toolu_f${String(n)}`, 'ls', 0)));
    await seed(mainPath(), filler + jsonl(call('toolu_1', 'gh pr create --fill'), result('toolu_1', PR)));
    await seed(subagentPath(), jsonl(call('toolu_2', 'gh pr create --fill'), result('toolu_2', PR_B, 3)));
    const pane = reader({ budgetBytes: 1024 });
    let read = await pane.read();
    expect(read?.backlog).toBe(true);
    for (let n = 0; n < 100 && read?.backlog === true; n += 1) read = await pane.read();
    expect(read?.backlog).toBe(false);
    expect(read?.pullRequests.map((pr) => pr.url)).toEqual([PR_B, PR]);
  });

  it('`/clear` (nowa rozmowa) → lista od zera, `/resume` starej → jej PR-y wracają', async () => {
    await seed(mainPath(), jsonl(call('toolu_1', 'gh pr create --fill'), result('toolu_1', PR)));
    await seed(mainPath(SESSION_B), jsonl(call('toolu_m', 'ls')));
    const pane = reader();
    expect((await pane.read())?.pullRequests).toHaveLength(1);
    pane.repoint(SESSION_B);
    expect((await pane.read())?.pullRequests).toEqual([]);
    pane.repoint(SESSION);
    expect((await pane.read())?.pullRequests.map((pr) => pr.url)).toEqual([PR]);
  });

  describe('command in the background: output file', () => {
    const TASK = 'abc123';
    const PR_7 = 'https://github.com/o/r/pull/7';
    const tasksDir = (): string => join(root, 'tmp', projectSlug(CWD), SESSION, 'tasks');
    const outputPath = (name = `${TASK}.output`): string => join(tasksDir(), name);

    /** Main file: a recognized call moved to the background and its notification naming `outputFile`. */
    async function seedBackground(outputFile: string, command = 'timeout 180 gh pr create --title "T" --fill'): Promise<void> {
      await seed(mainPath(), jsonl(
        call('toolu_1', command),
        backgroundResult('toolu_1', TASK, 2),
        finished({ toolUseId: 'toolu_1', taskId: TASK, outputFile, minute: 7 }),
      ));
    }

    it('output file with the URL line → PR with the notification time and the call title', async () => {
      await seed(outputPath(), `${PR_7}\n\n[exited with code 0]\n`);
      await seedBackground(outputPath());
      expect((await reader().read())?.pullRequests).toEqual([
        { url: PR_7, repo: 'o/r', number: 7, createdAt: at(7), title: 'T' },
      ]);
    });

    it('call, result and notification in separate reads → PR', async () => {
      await seed(outputPath(), `${PR_7}\n`);
      await seed(mainPath(), jsonl(call('toolu_1', 'gh pr create --fill'), backgroundResult('toolu_1', TASK, 2)));
      const pane = reader();
      expect((await pane.read())?.pullRequests).toEqual([]);
      await appendFile(mainPath(), jsonl(finished({ toolUseId: 'toolu_1', taskId: TASK, outputFile: outputPath() })));
      expect((await pane.read())?.pullRequests.map((pr) => pr.url)).toEqual([PR_7]);
    });

    it('`relocated()` during the output read → the next read still has the PR', async () => {
      await seed(outputPath(), `${PR_7}\n`);
      await seedBackground(outputPath());
      const pane = reader();
      outputReadHook.run = () => { pane.relocated(); };
      expect(await pane.read()).toBeNull();
      expect((await pane.read())?.pullRequests.map((pr) => pr.url)).toEqual([PR_7]);
    });

    it('server restart: the output file is read again from zero', async () => {
      await seed(outputPath(), `${PR_7}\n`);
      await seedBackground(outputPath());
      const first = reader();
      expect((await first.read())?.pullRequests).toHaveLength(1);
      first.close();
      expect((await reader().read())?.pullRequests).toHaveLength(1);
    });

    it.each([
      ['a prefixed URL line', `create 1: ${PR_7}\n`],
      ['a URL after "already exists:"', `a pull request for branch "x" into branch "main" already exists:\n${PR_7}\n`],
    ])('%s → no PR', async (_name, content) => {
      await seed(outputPath(), content);
      await seedBackground(outputPath());
      expect((await reader().read())?.pullRequests).toEqual([]);
    });

    it('output file over the ceiling → no PR, not a prefix', async () => {
      await seed(outputPath(), `${PR_7}\n${'x'.repeat(PULL_REQUEST_OUTPUT_MAX_BYTES)}`);
      await seedBackground(outputPath());
      expect((await reader().read())?.pullRequests).toEqual([]);
    });

    it('missing output file → no PR, no error', async () => {
      await seedBackground(outputPath());
      expect((await reader().read())?.pullRequests).toEqual([]);
    });

    it('FIFO under the output name → no PR, the read ends', async () => {
      await mkdir(tasksDir(), { recursive: true });
      execFileSync('mkfifo', [outputPath()]);
      await seedBackground(outputPath());
      expect((await reader().read())?.pullRequests).toEqual([]);
    });

    it('symlink under the output name → no PR', async () => {
      const target = join(root, 'elsewhere.txt');
      await writeFile(target, `${PR_7}\n`);
      await mkdir(tasksDir(), { recursive: true });
      await symlink(target, outputPath());
      await seedBackground(outputPath());
      expect((await reader().read())?.pullRequests).toEqual([]);
    });

    // Each case: the path the notification names, and the file with a PR line that a read would reach.
    it.each([
      ['a relative path', () => [relative(process.cwd(), outputPath()), outputPath()]],
      ['a path with `..`', () => [outputPath().replace(`/${SESSION}/`, `/${SESSION}/../${SESSION}/`), outputPath()]],
      ['a path with `//`', () => [outputPath().replace('/tasks/', '//tasks/'), outputPath()]],
      ['another task id in the name', () => [outputPath('zzz999.output'), outputPath('zzz999.output')]],
      ['no `tasks` directory', () => [join(tasksDir(), '..', 'other', `${TASK}.output`),
        join(tasksDir(), '..', 'other', `${TASK}.output`)]],
      ['a parent that is not a session uuid', () => [join(root, 'tmp', 'session', 'tasks', `${TASK}.output`),
        join(root, 'tmp', 'session', 'tasks', `${TASK}.output`)]],
    ])('%s → no read', async (_name, paths) => {
      const [named = '', existing = ''] = paths();
      await seed(existing, `${PR_7}\n`);
      await seedBackground(named);
      expect((await reader().read())?.pullRequests).toEqual([]);
    });

    it('notification for a call that is not `gh pr create` → the output file is not read', async () => {
      await seed(outputPath(), `${PR_7}\n`);
      await seedBackground(outputPath(), 'npm test');
      expect((await reader().read())?.pullRequests).toEqual([]);
    });
  });

  it('brak pliku rozmowy → pusta lista, bez błędu', async () => {
    expect((await reader().read())?.pullRequests).toEqual([]);
  });

  it('odczyt przerwany przez `repoint` niczego nie oddaje', async () => {
    await seed(mainPath(), jsonl(call('toolu_1', 'gh pr create --fill'), result('toolu_1', PR)));
    const pane = reader();
    const pending = pane.read();
    pane.repoint(SESSION_B);
    expect(await pending).toBeNull();
  });
});

/** Klient herdr, którego driver w tym teście nie używa (wzór: `herdr-artifacts-integracja.test.ts`). */
class QuietClient implements HerdrClient {
  listAgents(): Promise<never> { return Promise.reject(new Error('nieużywane')); }
  getAgent(): Promise<never> { return Promise.reject(new Error('nieużywane')); }
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

describe('driver: lista PR-ów do managera (zdarzenie `pull-requests`)', () => {
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

  const lists = (events: readonly DriverEvent[]): string[][] => events.flatMap((event) =>
    (event.type === 'pull-requests' ? [event.pullRequests.map((pr) => pr.url)] : []));

  async function waitFor(check: () => boolean, what: string): Promise<void> {
    for (let n = 0; n < 400; n += 1) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`nie doczekano: ${what}`);
  }

  it('plik główny i subagent → lista; pusta lista po podpięciu nie wychodzi; `/clear` → pusta', async () => {
    await mkdir(join(store(), SESSION, 'subagents'), { recursive: true });
    await writeFile(join(store(), `${SESSION}.jsonl`), jsonl(call('toolu_m', 'ls')));
    await writeFile(join(store(), `${SESSION_B}.jsonl`), jsonl(call('toolu_x', 'ls')));
    const pane = await attach();
    // Bez PR-ów driver nic nie wypłaca: pusta lista po podpięciu nie jest zmianą.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(lists(pane.events)).toEqual([]);

    await appendFile(join(store(), `${SESSION}.jsonl`), jsonl(call('toolu_1', 'gh pr create --fill', 1), result('toolu_1', PR, 2)));
    await waitFor(() => lists(pane.events).length === 1, 'PR z pliku głównego');
    expect(lists(pane.events)).toEqual([[PR]]);

    // Subagent tworzy PR we własnym pliku; plik główny rośnie o jego wynik.
    await writeFile(join(store(), SESSION, 'subagents', `agent-${AGENT}.jsonl`),
      jsonl(call('toolu_2', 'gh pr create --fill', 3), result('toolu_2', PR_B, 4)));
    await appendFile(join(store(), `${SESSION}.jsonl`), jsonl(result('toolu_m', 'agent done', 5)));
    await waitFor(() => lists(pane.events).length === 2, 'PR subagenta');
    expect(lists(pane.events).at(-1)).toEqual([PR_B, PR]);

    pane.emit({ type: 'session-changed', agentSessionId: SESSION_B });
    await waitFor(() => lists(pane.events).length === 3, 'pusta lista po `/clear`');
    expect(lists(pane.events).at(-1)).toEqual([]);
  });
});
