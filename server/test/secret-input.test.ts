/**
 * The secret question of `bin/rarog.mjs` between two readline questions, in a real pseudo-terminal
 * (`/usr/bin/script`). Fake streams cannot show this: an open readline interface echoes what the secret question
 * reads, takes it as a line, and swallows Ctrl-C and Ctrl-D meant for the secret question.
 *
 * The test runs a copy of `bin/rarog.mjs` in a temporary checkout whose `server/src/cli/main.ts` asks a question,
 * a secret and a question again; `secret-input.ts`, `io.ts` and `child-output.ts` are the real modules. The typed
 * secret is synthetic and must not appear in the raw terminal output. Nothing is read or written under `HOME`.
 */
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IS_MAC, macOnly } from './platform.ts';

const REPO = path.join(import.meta.dirname, '..', '..');
const CLI_DIR = path.join(REPO, 'server', 'src', 'cli');
/** Synthetic secret typed at the secret prompt. */
const MARKER = 'rarog-pty-marker-7Qx2';
const CTRL_C = '\u0003';
const CTRL_D = '\u0004';

const FIRST = 'First question? [y/N] ';
const SECRET = 'Secret (hidden): ';
const THIRD = 'Third question? [y/N] ';

/**
 * `main` of the temporary checkout: a question, the secret, a question. It prints the answers and only whether the
 * secret matched; on Ctrl-C at the secret prompt it prints the terminal mode from `stty -a` and returns 130.
 */
const STUB_MAIN = [
  "import { spawnSync } from 'node:child_process';",
  `import { SecretInputInterrupted } from ${JSON.stringify(path.join(CLI_DIR, 'secret-input.ts'))};`,
  `export { secretInput } from ${JSON.stringify(path.join(CLI_DIR, 'secret-input.ts'))};`,
  '',
  'export async function main(_argv, io) {',
  "  const say = (line) => { io.stdout(line + '\\n'); };",
  `  say('answer 1: ' + JSON.stringify(await io.ask(${JSON.stringify(FIRST)})));`,
  '  let secret;',
  '  try {',
  `    secret = await io.askSecret(${JSON.stringify(SECRET)});`,
  '  } catch (failure) {',
  '    if (!(failure instanceof SecretInputInterrupted)) throw failure;',
  "    const flags = spawnSync('stty', ['-a'], { stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8' }).stdout;",
  "    const on = (flag) => new RegExp('(^|\\\\s)' + flag + '(\\\\s|$)', 'm').test(flags);",
  "    say('interrupted; terminal: ' + (on('icanon') && on('echo') && on('isig') ? 'line mode' : 'raw'));",
  '    return 130;',
  '  }',
  "  say('secret: ' + (secret === null ? 'none' : secret === process.env.RAROG_TEST_SECRET ? 'as typed' : 'other'));",
  `  say('answer 3: ' + JSON.stringify(await io.ask(${JSON.stringify(THIRD)})));`,
  '  return 0;',
  '}',
  '',
].join('\n');

let root = '';
let bin = '';

/**
 * Checkout layout as `bin/rarog.mjs` expects it in a clone: ES modules (`package.json`), tsx from `node_modules`,
 * `tsconfig.json`, `server/src/cli/main.ts`.
 */
beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'rsi-'));
  bin = path.join(root, 'bin', 'rarog.mjs');
  mkdirSync(path.dirname(bin));
  copyFileSync(path.join(REPO, 'bin', 'rarog.mjs'), bin);
  writeFileSync(path.join(root, 'package.json'), '{ "type": "module" }\n');
  symlinkSync(path.join(REPO, 'node_modules'), path.join(root, 'node_modules'));
  copyFileSync(path.join(REPO, 'tsconfig.json'), path.join(root, 'tsconfig.json'));
  const cli = path.join(root, 'server', 'src', 'cli');
  mkdirSync(cli, { recursive: true });
  writeFileSync(path.join(cli, 'main.ts'), STUB_MAIN);
  for (const name of ['io.ts', 'child-output.ts']) {
    writeFileSync(path.join(cli, name), `export * from ${JSON.stringify(path.join(CLI_DIR, name))};\n`);
  }
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

/** Keys typed once `after` shows up in the output (searched after the previous step's text). */
interface Step {
  readonly after: string;
  readonly keys: string;
}

/**
 * The copied `bin/rarog.mjs` in a pseudo-terminal (`script` from macOS; `cat |` because `script` refuses a socket as
 * stdin). Each step's keys go only after its prompt is on screen; the last step closes the input.
 */
async function ttyRun(steps: readonly Step[]): Promise<{ readonly code: number | null; readonly output: string }> {
  const child = spawn('/bin/sh', ['-c', 'cat | /usr/bin/script -q /dev/null "$@"', 'sh', process.execPath, bin], {
    cwd: root,
    env: { ...process.env, HOME: root, RAROG_TEST_SECRET: MARKER },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  let output = '';
  let next = 0;
  let from = 0;
  const onOutput = (chunk: Buffer): void => {
    output += chunk.toString();
    for (let step = steps[next]; step !== undefined; step = steps[next]) {
      const at = output.indexOf(step.after, from);
      if (at < 0) return;
      from = at + step.after.length;
      next += 1;
      if (next === steps.length) child.stdin.end(step.keys);
      else child.stdin.write(step.keys);
    }
  };
  child.stdout.on('data', onOutput);
  child.stderr.on('data', onOutput);
  const timer = setTimeout(() => {
    if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
  }, 20_000);
  const code = await new Promise<number | null>((resolve) => { child.on('close', resolve); });
  clearTimeout(timer);
  return { code, output };
}

describe.skipIf(!IS_MAC)(macOnly('bin/rarog.mjs: a secret between two questions', 'the script command'), () => {
  it('the typed secret is not on screen, the secret is read as typed, the third question gets its answer', async () => {
    const run = await ttyRun([
      { after: FIRST, keys: 'y\r' }, { after: SECRET, keys: `${MARKER}\r` }, { after: THIRD, keys: 'n\r' },
    ]);
    expect(run.output).not.toContain(MARKER);
    expect(run.output).not.toContain(MARKER.slice(0, 8));
    expect(run.output).toContain('answer 1: "y"');
    expect(run.output).toContain('secret: as typed');
    expect(run.output).toContain('answer 3: "n"');
    expect(run.code).toBe(0);
  }, 30_000);

  it('Ctrl-C at the secret prompt: the command gets it, the terminal is in line mode, exit 130', async () => {
    const run = await ttyRun([{ after: FIRST, keys: 'y\r' }, { after: SECRET, keys: `abc${CTRL_C}` }]);
    expect(run.output).toContain('interrupted; terminal: line mode');
    expect(run.output).not.toContain('answer 3');
    expect(run.output).not.toContain('abc');
    expect(run.code).toBe(130);
  }, 30_000);

  it('Ctrl-D at the secret prompt: no secret, and the next question still gets its answer', async () => {
    const run = await ttyRun([
      { after: FIRST, keys: 'y\r' }, { after: SECRET, keys: CTRL_D }, { after: THIRD, keys: 'y\r' },
    ]);
    expect(run.output).toContain('secret: none');
    expect(run.output).toContain('answer 3: "y"');
    expect(run.code).toBe(0);
  }, 30_000);
});
