/**
 * Fake `gh` for `server/test/pr-status.test.ts`: a real process the PR status module starts like the real program.
 *
 * The test puts a tiny `gh` shell script into a temporary directory (`exec <node> atrapa-gh.mjs <dir> "$@"`), so the
 * module finds it through its directory list. The directory `<dir>` holds:
 * - `scenario.json`: an array of call scenarios; call N uses entry N (the last one when the array is shorter);
 * - `started.jsonl`: one line per call, written when the call starts (`pid`, `start`), so a killed call is on record;
 * - `calls.jsonl`: one line per finished call: `argv`, `stdin`, `env`, `pid`, `start`, `end`.
 *
 * A scenario: `states` (`"owner/repo#n"` → `"OPEN"`, `"MERGED"`, `"CLOSED"`, `null`, or a whole `pullRequest`
 * object such as `{ state: "OPEN", isDraft: true }`; missing = `"OPEN"`; a string answers with `isDraft: false`),
 * `rateLimit` (`{ remaining, resetAt }`), `extraErrors` (added to `errors`), `notFoundMessage` (text of the
 * `NOT_FOUND` error), `stdout` (raw text instead of the built answer), `stderr`, `exit`, `sleepMs`, `stdoutBytes`
 * (that many bytes of `x` on stdout). Like the measured `gh`, a `null` alias adds a `NOT_FOUND` error and exit 1, and
 * stdout still carries the whole answer.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, ...argv] = process.argv.slice(2);
const start = Date.now();
const callsFile = join(dir, 'calls.jsonl');
const startedFile = join(dir, 'started.jsonl');
let index = 0;
try {
  index = readFileSync(startedFile, 'utf8').split('\n').filter((line) => line !== '').length;
} catch {
  index = 0;
}
appendFileSync(startedFile, `${JSON.stringify({ pid: process.pid, start })}\n`);
const scenarios = JSON.parse(readFileSync(join(dir, 'scenario.json'), 'utf8'));
const scenario = scenarios[Math.min(index, scenarios.length - 1)] ?? {};

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const stdin = Buffer.concat(chunks).toString('utf8');

const record = { argv, stdin, env: { ...process.env }, pid: process.pid, start, end: null };

function finish(code) {
  appendFileSync(callsFile, `${JSON.stringify({ ...record, end: Date.now() })}\n`);
  process.exitCode = code;
}

if (typeof scenario.sleepMs === 'number') {
  await new Promise((resolve) => { setTimeout(resolve, scenario.sleepMs); });
}

if (typeof scenario.stdoutBytes === 'number') {
  process.stdout.write('x'.repeat(scenario.stdoutBytes));
  finish(0);
} else if (typeof scenario.stdout === 'string') {
  process.stdout.write(scenario.stdout);
  if (typeof scenario.stderr === 'string') process.stderr.write(scenario.stderr);
  finish(scenario.exit ?? 0);
} else {
  const body = JSON.parse(stdin);
  const variables = body.variables ?? {};
  const data = {};
  const errors = [];
  for (let i = 0; `o${i}` in variables; i += 1) {
    const key = `${variables[`o${i}`]}/${variables[`r${i}`]}#${variables[`n${i}`]}`;
    const states = scenario.states ?? {};
    const state = key in states ? states[key] : 'OPEN';
    if (state === null) {
      data[`p${i}`] = { pullRequest: null };
      errors.push({
        type: 'NOT_FOUND',
        path: [`p${i}`, 'pullRequest'],
        message: scenario.notFoundMessage ?? `Could not resolve to a PullRequest with the number of ${variables[`n${i}`]}.`,
      });
    } else {
      data[`p${i}`] = { pullRequest: typeof state === 'string' ? { state, isDraft: false } : state };
    }
  }
  data.rateLimit = scenario.rateLimit ?? { remaining: 4999, resetAt: '2026-11-12T20:00:00Z' };
  errors.push(...(scenario.extraErrors ?? []));
  const answer = errors.length > 0 ? { data, errors } : { data };
  process.stdout.write(JSON.stringify(answer));
  if (errors.length > 0) process.stderr.write(scenario.stderr ?? `gh: ${errors[0].message}\n`);
  else if (typeof scenario.stderr === 'string') process.stderr.write(scenario.stderr);
  finish(scenario.exit ?? (errors.length > 0 ? 1 : 0));
}
