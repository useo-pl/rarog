/**
 * Which jobs `.github/workflows/check.yml` starts on which event (`docs/publishing.md`, "CI"). GitHub cannot run here,
 * so the test reads the workflow text and evaluates the job conditions, the matrices and the job fields with a small
 * evaluator of the expression subset the workflow uses; an unknown context or function fails the test instead of
 * guessing. The contract: in a private repository a push to `main` and a pull request run the checks without the full
 * server tests (no `pnpm test`, no macOS); a manual run, a `v*` tag and every event in a public repository add the
 * full server tests on Node 22, split into parts (`vitest --shard`) with a time limit per part, plus `swift-contract`
 * and `package` on macOS. The full server tests on macOS run only in a public repository.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO } from './private-guard.ts';

const WORKFLOW = path.join(REPO, '.github', 'workflows', 'check.yml');

type Value = string | number | boolean | null | readonly Value[] | { readonly [key: string]: Value };

/** The event a run starts from: the repository visibility, the event name and the ref. */
interface Event {
  readonly private: boolean;
  readonly name: 'push' | 'pull_request' | 'workflow_dispatch';
  readonly ref: string;
}

interface Scope {
  readonly event: Event;
  readonly matrix: Readonly<Record<string, Value>>;
  readonly jobTotal: number;
}

const TOKEN = /\s*(?:('(?:[^']|'')*')|(\d+(?:\.\d+)?)|([A-Za-z_][\w.-]*)|(==|!=|&&|\|\||!|\(|\)|,))/uy;

/** Tokens of one `${{ … }}` expression. */
function tokenize(source: string): string[] {
  const tokens: string[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < source.length) {
    if (/^\s*$/u.test(source.slice(TOKEN.lastIndex))) break;
    const start = TOKEN.lastIndex;
    const match = TOKEN.exec(source);
    if (match === null) throw new Error(`expression: cannot read at ${String(start)}: ${source}`);
    tokens.push(match[1] ?? match[2] ?? match[3] ?? match[4] ?? '');
  }
  return tokens;
}

function truthy(value: Value): boolean {
  return value !== false && value !== null && value !== 0 && value !== '';
}

/** Evaluates the subset of GitHub expressions the workflow uses: literals, contexts, `!`, `==`, `!=`, `&&`, `||`. */
function evaluate(source: string, scope: Scope): Value {
  const tokens = tokenize(source);
  let at = 0;
  const peek = (): string | undefined => tokens[at];
  const take = (expected?: string): string => {
    const token = tokens[at];
    if (token === undefined || (expected !== undefined && token !== expected)) {
      throw new Error(`expression: expected ${expected ?? 'a token'} at ${String(at)}: ${source}`);
    }
    at += 1;
    return token;
  };
  const context = (name: string): Value => {
    if (name === 'github.event.repository.private') return scope.event.private;
    if (name === 'github.event_name') return scope.event.name;
    if (name === 'github.ref') return scope.event.ref;
    if (name === 'strategy.job-total') return scope.jobTotal;
    if (name.startsWith('matrix.')) {
      const value = scope.matrix[name.slice('matrix.'.length)];
      if (value === undefined) throw new Error(`expression: no ${name} in the matrix`);
      return value;
    }
    throw new Error(`expression: context ${name} is not modelled by this test`);
  };
  const call = (name: string, args: Value[]): Value => {
    if (name === 'startsWith') return String(args[0]).toLowerCase().startsWith(String(args[1]).toLowerCase());
    if (name === 'fromJSON') return JSON.parse(String(args[0])) as Value;
    throw new Error(`expression: function ${name} is not modelled by this test`);
  };
  const primary = (): Value => {
    const token = take();
    if (token === '(') {
      const value = or();
      take(')');
      return value;
    }
    if (token.startsWith("'")) return token.slice(1, -1).replaceAll("''", "'");
    if (/^\d/u.test(token)) return Number(token);
    if (token === 'true' || token === 'false') return token === 'true';
    if (token === 'null') return null;
    if (peek() === '(') {
      take('(');
      const args: Value[] = [];
      while (peek() !== ')') {
        args.push(or());
        if (peek() === ',') take(',');
      }
      take(')');
      return call(token, args);
    }
    return context(token);
  };
  const unary = (): Value => {
    if (peek() === '!') {
      take('!');
      return !truthy(unary());
    }
    return primary();
  };
  const equality = (): Value => {
    let left = unary();
    while (peek() === '==' || peek() === '!=') {
      const op = take();
      const right = unary();
      left = op === '==' ? left === right : left !== right;
    }
    return left;
  };
  const and = (): Value => {
    let left = equality();
    while (peek() === '&&') {
      take('&&');
      const right = equality();
      left = truthy(left) ? right : left;
    }
    return left;
  };
  function or(): Value {
    let left = and();
    while (peek() === '||') {
      take('||');
      const right = and();
      left = truthy(left) ? left : right;
    }
    return left;
  }
  const value = or();
  if (at !== tokens.length) throw new Error(`expression: unread tokens after ${String(at)}: ${source}`);
  return value;
}

/** A field value with `${{ … }}`: one whole expression keeps its type, otherwise the parts join into a string. */
function resolve(text: string, scope: Scope): Value {
  const whole = /^\$\{\{([\s\S]*)\}\}$/u.exec(text.trim());
  if (whole !== null && !whole[1]?.includes('}}')) return evaluate(whole[1] ?? '', scope);
  return text.replace(/\$\{\{([\s\S]*?)\}\}/gu, (_, source: string) => String(evaluate(source, scope)));
}

/** Jobs: the header `  <id>:` under `jobs:` up to the next header. */
function jobs(text: string): Map<string, string> {
  const body = text.slice(text.indexOf('\njobs:\n') + '\njobs:\n'.length);
  const out = new Map<string, string>();
  const headers = [...body.matchAll(/^ {2}([a-z][\w-]*):$/gmu)];
  headers.forEach((match, index) => {
    out.set(match[1] ?? '', body.slice(match.index, headers[index + 1]?.index ?? body.length));
  });
  return out;
}

/** A scalar at the given indent: inline, or a folded `>-` block (lines joined with a space). `null` when absent. */
function field(block: string, indent: number, key: string): string | null {
  const lines = block.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`${' '.repeat(indent)}${key}:`)
    && !line.startsWith(`${' '.repeat(indent + 1)}`));
  if (start === -1) return null;
  const rest = (lines[start] ?? '').slice(indent + key.length + 1).trim();
  if (rest !== '>-') return rest;
  const folded: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || line.length - line.trimStart().length <= indent) break;
    folded.push(line.trim());
  }
  return folded.join(' ');
}

/** Matrix dimensions of a job (`strategy.matrix`): flow lists or one expression per key. */
function matrix(job: string, event: Event): Array<[string, readonly Value[]]> {
  const block = /^ {6}matrix:\n((?: {8,}\S.*\n)+)/mu.exec(job)?.[1];
  if (block === undefined) return [];
  const keys = [...block.matchAll(/^ {8}([\w-]+):/gmu)].map((match) => match[1] ?? '');
  return keys.map((key) => {
    const raw = field(block, 8, key) ?? '';
    const scope: Scope = { event, matrix: {}, jobTotal: 0 };
    const value = raw.startsWith('[') ? JSON.parse(raw) as Value : resolve(raw, scope);
    if (!Array.isArray(value)) throw new Error(`matrix ${key}: not a list: ${raw}`);
    return [key, value as readonly Value[]];
  });
}

function product(dimensions: Array<[string, readonly Value[]]>): Array<Record<string, Value>> {
  let combos: Array<Record<string, Value>> = [{}];
  for (const [key, values] of dimensions) {
    combos = combos.flatMap((combo) => values.map((value) => ({ ...combo, [key]: value })));
  }
  return combos;
}

/** Lines of a job without comments, for the question "does this job run the server tests". */
function code(job: string): string {
  return job.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');
}

interface Instance {
  readonly id: string;
  readonly name: string;
  readonly runsOn: string;
  readonly node: string;
  readonly timeout: number;
  readonly env: Readonly<Record<string, string>>;
  readonly serverTests: boolean;
  readonly swiftContract: boolean;
  readonly matrix: Readonly<Record<string, Value>>;
  readonly jobTotal: number;
}

/** Job instances GitHub starts for the event: the job `if`, then one instance per matrix combination. */
function run(text: string, event: Event): Instance[] {
  const out: Instance[] = [];
  for (const [id, job] of jobs(text)) {
    // A job that waits for another one is skipped when that one fails; this test does not model it.
    if (field(job, 4, 'needs') !== null) throw new Error(`job ${id}: \`needs\` is not modelled by this test`);
    const condition = field(job, 4, 'if');
    if (condition !== null && !truthy(resolve(condition, { event, matrix: {}, jobTotal: 0 }))) continue;
    const combos = product(matrix(job, event));
    for (const combo of combos) {
      const scope: Scope = { event, matrix: combo, jobTotal: combos.length };
      const envBlock = /^ {4}env:\n((?: {6}\S.*\n)+)/mu.exec(job)?.[1] ?? '';
      const env = Object.fromEntries([...envBlock.matchAll(/^ {6}([A-Z_]+): (.*)$/gmu)]
        .map((match) => [match[1] ?? '', String(resolve(match[2] ?? '', scope))]));
      out.push({
        id,
        name: String(resolve(field(job, 4, 'name') ?? id, scope)),
        runsOn: String(resolve(field(job, 4, 'runs-on') ?? '', scope)),
        node: String(resolve(field(job, 10, 'node-version') ?? '', scope)),
        timeout: Number(resolve(field(job, 4, 'timeout-minutes') ?? 'NaN', scope)),
        env,
        serverTests: /\bpnpm test\b|\bvitest\b/u.test(code(job)),
        swiftContract: /\bswift test\b/u.test(code(job)),
        matrix: combo,
        jobTotal: combos.length,
      });
    }
  }
  return out;
}

/**
 * One line per started job: id, runner, Node line (when the job sets one), the test part, `server tests` when it runs
 * `pnpm test` and `swift-contract` when it runs `swift test`.
 */
function layout(instances: Instance[]): string[] {
  return instances.map((job) => [
    job.id, job.runsOn,
    ...(job.node === '' ? [] : [`node ${job.node}`]),
    ...(job.matrix.part === undefined ? [] : [`part ${String(job.matrix.part)}/${String(job.jobTotal)}`]),
    ...(job.serverTests ? ['server tests'] : []),
    ...(job.swiftContract ? ['swift-contract'] : []),
  ].join(' · ')).sort();
}

const PUSH_MAIN = { name: 'push', ref: 'refs/heads/main' } as const;
const PULL_REQUEST = { name: 'pull_request', ref: 'refs/pull/7/merge' } as const;
const MANUAL = { name: 'workflow_dispatch', ref: 'refs/heads/main' } as const;
const TAG = { name: 'push', ref: 'refs/tags/v1.4.0' } as const;

const LEAN = [
  'checks · ubuntu-latest · node 22',
  'package · ubuntu-latest · node 22',
  'package · ubuntu-latest · node 24',
  'package · ubuntu-latest · node 26',
];
/** The layout of a `v*` tag in a private repository, with the server tests split into `parts` jobs. */
const release = (parts: number): string[] => [
  ...LEAN,
  'swift-contract · xcode-27 · swift-contract',
  'package · macos-latest · node 22',
  'package · macos-latest · node 24',
  'package · macos-latest · node 26',
  ...Array.from({ length: parts }, (_, index) =>
    `tests · ubuntu-latest · node 22 · part ${String(index + 1)}/${String(parts)} · server tests`),
].sort();
/** The layout of a public repository and of a manual run: the tag layout plus the full server tests on macOS. */
const full = (parts: number): string[] => [...release(parts), 'macos-tests · xcode-27 · node 22 · server tests'].sort();

describe('check.yml: jobs per event', () => {
  const text = readFileSync(WORKFLOW, 'utf8');
  // The part count and the time limit of a part are tuning (a manual run on GitHub may change them), so the
  // expected layout takes the count from the workflow and no test names either number.
  const partCount = run(text, { private: true, ...MANUAL }).filter((job) => job.id === 'tests').length;

  it.each([
    ['private, push to main', { private: true, ...PUSH_MAIN }, 'lean'],
    ['private, pull request', { private: true, ...PULL_REQUEST }, 'lean'],
    ['private, manual run', { private: true, ...MANUAL }, 'full'],
    ['private, v* tag', { private: true, ...TAG }, 'release'],
    ['public, push to main', { private: false, ...PUSH_MAIN }, 'full'],
    ['public, pull request', { private: false, ...PULL_REQUEST }, 'full'],
    ['public, manual run', { private: false, ...MANUAL }, 'full'],
    ['public, v* tag', { private: false, ...TAG }, 'full'],
  ] as const)('%s', (_, event, kind) => {
    const expected = { lean: [...LEAN].sort(), release: release(partCount), full: full(partCount) }[kind];
    expect(layout(run(text, event))).toEqual(expected);
  });

  it('the parts of the server tests cover the whole suite: `--shard` from the matrix, one summary per part', () => {
    const parts = run(text, { private: true, ...MANUAL }).filter((job) => job.id === 'tests');
    expect(parts.length, 'the whole suite does not fit one job').toBeGreaterThan(1);
    expect(parts.map((job) => job.matrix.part)).toEqual(Array.from({ length: parts.length }, (_, index) => index + 1));
    for (const job of parts) {
      expect(job.env, job.name).toEqual({ PART: String(job.matrix.part), PARTS: String(parts.length) });
      const part = `part ${String(job.matrix.part)}/${String(parts.length)}`;
      expect(job.name, 'the part shows in the job name').toContain(part);
      expect(job.timeout, 'every part has its own time limit').toBeGreaterThan(0);
    }
    const job = jobs(text).get('tests') ?? '';
    expect(job).toMatch(
      /^ +run: pnpm test --shard="\$PART\/\$PARTS" .*--outputFile\.json="\$RUNNER_TEMP\/vitest\.json"$/mu);
    expect(job, 'the summary names the part').toMatch(
      /^ +run: node scripts\/lib\/ci-summary\.mjs "\$RUNNER_TEMP\/vitest\.json" "[^"]*\$PART\/\$PARTS[^"]*"/mu);
  });

  // Tests that need the push relay or the `relay-auth` Worker skip themselves without their install, so a job that
  // lacks one reports green with fewer tests than the other jobs.
  it('every job that runs the server tests installs the repository, relay and relay-auth before `pnpm test`', () => {
    const installs = ['pnpm install --frozen-lockfile', 'pnpm -C relay install --frozen-lockfile',
      'pnpm -C relay-auth install --frozen-lockfile'];
    const testJobs = [...jobs(text)].filter(([, job]) => /\bpnpm test\b/u.test(code(job)));
    expect(testJobs.map(([id]) => id).sort()).toEqual(['macos-tests', 'tests']);
    for (const [id, job] of testJobs) {
      const body = code(job);
      const tests = body.search(/^ +run: pnpm test\b/mu);
      for (const install of installs) {
        const at = body.indexOf(`run: ${install}\n`);
        expect(at, `${id}: ${install}`).toBeGreaterThan(-1);
        expect(at, `${id}: ${install} before pnpm test`).toBeLessThan(tests);
      }
    }
  });
});
