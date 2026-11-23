/**
 * Wejście CLI `rarog`: rozdziela komendy na moduły `server/src/cli/`. Uruchamia go
 * `bin/rarog.mjs` (sprawdza wersję Node i rejestruje tsx), testy wołają `main` z własnym `CliIo`.
 *
 * Moduły serwera poza `server/src/cli/` nie importują niczego stąd (`server/test/rarog-cli.test.ts`):
 * CLI zależy od serwera, nigdy odwrotnie.
 */
import { DEVICES_USAGE, devicesCommand } from './devices.ts';
import { DIALOGS_USAGE, dialogsCommand } from './dialogs.ts';
import { DICTATION_USAGE, dictationCommand } from './dictation.ts';
import { DOCTOR_USAGE, doctorCommand } from './doctor.ts';
import { hooksCommand } from './hooks.ts';
import { EXIT_OK, EXIT_USAGE, Usage, err, out, terminalOf } from './io.ts';
import { usageFor } from './screen/prose.ts';
import { layoutOf, wrapWords } from './screen/style.ts';
import type { CliIo } from './io.ts';
import { RESTART_USAGE, restartCommand } from './restart.ts';
import { SERVE_USAGE, serveCommand } from './serve.ts';
import { SERVICE_USAGE, serviceCommand } from './service.ts';
import { SETUP_USAGE, setupCommand } from './setup.ts';
import { UPDATE_USAGE, updateCommand } from './update.ts';
import { VOICE_AGENT_USAGE, voiceAgentCommand } from './voice-agent.ts';
import { readPackageVersion } from '../version.ts';

/**
 * Drogi wejścia sekretu (`CliIo.askSecret`, `CliIo.readStdin`) dla strumieni procesu; `bin/rarog.mjs` bierze je stąd,
 * razem z {@link main}, w klonie i w paczce tym samym importem.
 */
export { secretInput } from './secret-input.ts';

const HOOKS_USAGE = `  rarog hooks [print|install|doctor] [--local]
  rarog hooks statusline [--chain <command>]
      Claude Code permission hook: the settings block (print), a copy of the hook code and the statusLine script
      in ~/.claude/hooks/rarog, then the hook entries in ~/.claude/settings.json after a [y/N/d] question
      (d shows the diff), only in a terminal (install), the state of the entry and the copy (doctor), a
      statusLine block pointing at the script copy (statusline; --chain: after the dump, run your own status line
      command).`;

export const USAGE = `Usage:
  rarog --version
      The version of this installation.
${DEVICES_USAGE}
${HOOKS_USAGE}
${SERVE_USAGE}
${RESTART_USAGE}
${SERVICE_USAGE}
${DOCTOR_USAGE}
${DIALOGS_USAGE}
${SETUP_USAGE}
${UPDATE_USAGE}
${DICTATION_USAGE}
${VOICE_AGENT_USAGE}`;

/** Jedna komenda: argumenty od nazwy komendy włącznie, kod wyjścia. */
type Command = (argv: readonly string[], io: CliIo) => Promise<number>;

const COMMANDS: Readonly<Record<string, Command>> = {
  pair: devicesCommand,
  devices: devicesCommand,
  hooks: async (argv, io) => {
    const args = argv.slice(1);
    if (args.includes('--help') || args.includes('-h')) {
      out(io, usageFor(io, `Usage:\n${HOOKS_USAGE}`));
      return EXIT_OK;
    }
    return hooksCommand(args, io, 'rarog hooks: unknown subcommand or option.\nRun rarog hooks --help.', EXIT_USAGE);
  },
  serve: serveCommand,
  restart: restartCommand,
  service: serviceCommand,
  doctor: doctorCommand,
  dialogs: dialogsCommand,
  setup: (argv, io) => setupCommand(argv, io),
  update: (argv, io) => updateCommand(argv, io),
  dictation: (argv, io) => dictationCommand(argv, io),
  'voice-agent': (argv, io) => voiceAgentCommand(argv, io),
};

/**
 * Opcje z wartością, które mogą stać PRZED nazwą komendy (`rarog --data-dir X devices`): ich wartość nie jest nazwą
 * komendy.
 */
const VALUE_OPTIONS: ReadonlySet<string> = new Set(['--url', '--data-dir', '--port', '--env', '--iroh-relay']);

/** Pozycja nazwy komendy: pierwszy argument, który nie jest opcją ani wartością opcji; `-1` = brak. */
function commandIndex(argv: readonly string[]): number {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (VALUE_OPTIONS.has(arg)) {
      i += 1;
    } else if (!arg.startsWith('-')) {
      return i;
    }
  }
  return -1;
}

/** Wejście CLI — `argv` bez `node` i ścieżki skryptu; oddaje kod wyjścia. */
export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  // The absolute command `rarog setup` prints for a new terminal is checked with it.
  if (argv.length === 1 && argv[0] === '--version') {
    out(io, readPackageVersion());
    return EXIT_OK;
  }
  const at = commandIndex(argv);
  const name = at === -1 ? undefined : argv[at];
  if (name === undefined || name === 'help') {
    const help = name === 'help' || argv.includes('--help') || argv.includes('-h');
    if (help) out(io, usageFor(io, USAGE));
    else err(io, usageFor(io, USAGE));
    return help ? EXIT_OK : EXIT_USAGE;
  }
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (command === undefined) {
    usageError(io, `Unknown command: ${name}.`, 'rarog --help');
    return EXIT_USAGE;
  }
  try {
    // Komenda dostaje swoją nazwę na początku i resztę argumentów w dawnej kolejności.
    return await command([name, ...argv.slice(0, at), ...argv.slice(at + 1)], io);
  } catch (failure) {
    if (failure instanceof Usage) {
      usageError(io, failure.message, `rarog ${name} --help`);
      return EXIT_USAGE;
    }
    throw failure;
  }
}

/**
 * A bad argument: its one sentence on stderr, wrapped at the screen width, and `Run <help>.` on a line of
 * its own, instead of the usage of every command.
 */
function usageError(io: CliIo, sentence: string, help: string): void {
  const { width } = layoutOf(terminalOf(io).columns);
  err(io, [...wrapWords(sentence, width, width), `Run ${help}.`].join('\n'));
}
