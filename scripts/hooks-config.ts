/**
 * `pnpm run hooks:install` / `hooks:print` / `hooks:doctor` — podkładka do `rarog hooks install|print|doctor`.
 * Ten sam kod (`server/src/cli/hooks.ts`), to samo wyjście; różni się tylko
 * komunikat złego wywołania i jego kod (2). Skrypt jedzie przez `tsx` (jak serwer).
 *
 * Pytanie `[y/N]` (wpisy hooka w `~/.claude/settings.json` po `hooks:install`) tylko wtedy, gdy stdin i stdout
 * to terminal, jak w `bin/rarog.mjs`; EOF = `null` (nie), Ctrl-C = kod 130. Bez terminala komenda nie pyta i wpisów
 * nie zapisuje.
 */
import readline from 'node:readline';
import { hooksCommand } from '../server/src/cli/hooks.ts';

let prompts: readline.Interface | null = null;
let closed = false;
const ask = process.stdin.isTTY && process.stdout.isTTY
  ? (prompt: string): Promise<string | null> => new Promise((resolve) => {
    if (closed) {
      resolve(null);
      return;
    }
    if (prompts === null) {
      prompts = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      prompts.on('SIGINT', () => { process.exit(130); });
      prompts.on('close', () => { closed = true; });
    }
    const current = prompts;
    const onClose = (): void => { resolve(null); };
    current.once('close', onClose);
    current.question(prompt, (answer) => {
      current.off('close', onClose);
      resolve(answer);
    });
  })
  : undefined;

const code = await hooksCommand(process.argv.slice(2), {
  stdout: (text) => { process.stdout.write(text); },
  stderr: (text) => { process.stderr.write(text); },
  env: process.env,
  cwd: process.cwd(),
  ...(ask === undefined ? {} : { ask }),
}, 'Usage: hooks-config.ts [install|print|doctor] [--local]', 2);
(prompts as readline.Interface | null)?.close();
process.exit(code);
