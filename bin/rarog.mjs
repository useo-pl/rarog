#!/usr/bin/env node
/**
 * `rarog`: the CLI of the Rarog server. This file does three things and nothing more:
 *
 * 1. checks the Node version (22.15 or newer, on the 23 line 23.11 or newer: the same bound as `engines` in
 *    `package.json`); an older version = one sentence instead of a stack from inside the modules, an odd-numbered
 *    line (no long-term support) = a warning, then on;
 * 2. imports the commands' `main`: in the npm package (`server/src/cli/main.js` lies next to it, JavaScript from
 *    `pnpm run package`) directly, without tsx; in a repository clone it registers tsx (`tsx/esm/api`, a dependency
 *    of the repository root) with the root `tsconfig.json`, the same as the server started with
 *    `tsx server/src/index.ts` from the repository directory, whatever the calling directory, and imports
 *    `server/src/cli/main.ts`;
 * 3. returns the exit code of `main`.
 *
 * The command code lives in `server/src/cli/` (TypeScript, typechecked and tested with the server). Exit codes: 0 =
 * done, 1 = refusal or failure (a sentence on stderr), 2 = the server does not answer on its socket, 64 = bad
 * invocation, 130 = interrupted (Ctrl-C), 143 and 129 = ended by SIGTERM or SIGHUP.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

/**
 * The oldest Node: 22.15 (`process.execve` in `rarog serve`); the 23 line has `execve` only from 23.11. Newer lines
 * have no upper bound.
 */
const MIN_MAJOR = 22;
const MIN_MINOR = 15;
const MIN_MINOR_23 = 11;
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
if (major < MIN_MAJOR || (major === MIN_MAJOR && minor < MIN_MINOR) || (major === 23 && minor < MIN_MINOR_23)) {
  process.stderr.write(`rarog: requires Node ${String(MIN_MAJOR)}.${String(MIN_MINOR)} or newer (on the 23 line:`
    + ` 23.${String(MIN_MINOR_23)} or newer), and this process is v${process.versions.node} (${process.execPath}).`
    + ' Install an LTS line of Node, e.g. with nvm: nvm install --lts.\n');
  process.exit(1);
}
if (major % 2 === 1) {
  process.stderr.write(`rarog: warning: Node v${process.versions.node} is an odd-numbered line without long-term`
    + ' support; rarog is tested on even-numbered LTS lines.\n');
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fromPackage = existsSync(path.join(root, 'server', 'src', 'cli', 'main.js'));
const { main, secretInput, describeTerminal, interruptOrExit, HANDLED_SIGNALS } = fromPackage
  ? {
    ...await import('../server/src/cli/main.js'), ...await import('../server/src/cli/io.js'),
    ...await import('../server/src/cli/child-output.js'),
  }
  : await importFromClone();

/** A repository clone: TypeScript through tsx. The npm package has no tsx and never gets here. */
async function importFromClone() {
  const { register } = await import('tsx/esm/api');
  register({ tsconfig: path.join(root, 'tsconfig.json') });
  return {
    ...await import('../server/src/cli/main.ts'), ...await import('../server/src/cli/io.ts'),
    ...await import('../server/src/cli/child-output.ts'),
  };
}

/**
 * Ctrl-C, SIGTERM and SIGHUP, from the process signal and (Ctrl-C) from the question prompt alike: the decision lives
 * in `interruptOrExit` (`server/src/cli/child-output.ts`). On Ctrl-C while a child process runs (`restart.sh`), it gets
 * SIGTERM (SIGKILL after a grace period or at a second Ctrl-C) and the command waits for its end, releases its lock
 * and exits 130; otherwise the process exits with 128 + the signal number, after the work a command deferred the exit
 * for (`rarog pair` cancels its code).
 */
const onSignal = (signal) => { interruptOrExit((code) => { process.exit(code); }, signal); };
const onInterrupt = () => { onSignal('SIGINT'); };

/**
 * The questions of `rarog setup`: only when stdin and stdout are a terminal; without a TTY the command asks nothing
 * and writes nothing. EOF (Ctrl-D) = `null` for this and every following question; Ctrl-C = `onInterrupt`, as outside
 * a question.
 * The interface opens at the first question and stays open until a secret question ({@link releasePrompts}) or the
 * end of the command.
 */
let prompts = null;
let promptsClosed = false;
const ask = process.stdin.isTTY === true && process.stdout.isTTY === true
  ? (prompt) => new Promise((resolve) => {
    if (promptsClosed) {
      resolve(null);
      return;
    }
    if (prompts === null) {
      const opened = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      opened.on('SIGINT', onInterrupt);
      // An EOF closes the current interface; one closed by `releasePrompts` is no longer current, so it is not one.
      opened.on('close', () => { if (prompts === opened) promptsClosed = true; });
      prompts = opened;
    }
    const onClose = () => { resolve(null); };
    prompts.once('close', onClose);
    prompts.question(prompt, (answer) => {
      prompts.off('close', onClose);
      resolve(answer);
    });
  })
  : undefined;

/**
 * The secret question takes the terminal from readline: an open interface would echo the typed secret, take it as
 * a line, and catch Ctrl-C and Ctrl-D meant for the secret question. Closing it is not an EOF: the next question
 * opens a new interface.
 */
const releasePrompts = () => {
  const open = prompts;
  prompts = null;
  open?.close();
};

// A secret (`rarog dictation set-key`, `rarog voice-agent set-key`): a question without echo on the terminal, or the
// whole stdin from a pipe; the code and the choice between them in `server/src/cli/secret-input.ts`. It reads
// nothing until a command calls it.
const secret = secretInput(process.stdin, process.stdout);
const askSecret = secret.askSecret;

for (const signal of HANDLED_SIGNALS) process.on(signal, onSignal);
try {
  process.exitCode = await main(process.argv.slice(2), {
    stdout: (text) => { process.stdout.write(text); },
    stderr: (text) => { process.stderr.write(text); },
    env: process.env,
    cwd: process.cwd(),
    // What stdout is (terminal, width, colour) for the step screen; the rule lives in `describeTerminal`.
    terminal: describeTerminal(process.stdout, process.env),
    // Live columns: the step screen compares them at a question and at its answer before it takes the question off
    // the screen.
    ...(process.stdout.isTTY === true ? { columnsNow: () => process.stdout.columns ?? 0 } : {}),
    ...(ask === undefined ? {} : { ask }),
    ...secret,
    ...(askSecret === undefined ? {} : {
      askSecret: (prompt) => {
        releasePrompts();
        return askSecret(prompt);
      },
    }),
  });
} catch (failure) {
  process.stderr.write(`rarog: ${failure instanceof Error ? failure.message : String(failure)}\n`);
  process.exitCode = 1;
} finally {
  prompts?.close();
}
