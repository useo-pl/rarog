/**
 * Wejście i wyjście komend CLI `rarog` (`server/src/cli/`): środowisko i strumienie
 * wstrzykiwane przez `bin/rarog.mjs`, żeby moduły komend nie sięgały po globalny proces (testy podają własne).
 *
 * Kody wyjścia wspólne dla wszystkich komend: 0 = zrobione, 1 = odmowa albo porażka (zdanie na stderr), 2 = serwer
 * nie odpowiada (gniazdo administracyjne), 64 = złe wywołanie, 130 = przerwane (Ctrl-C).
 */
import os from 'node:os';

export interface CliIo {
  /** Surowy zapis na stdout (bez dopisywania końca linii). */
  readonly stdout: (text: string) => void;
  /** Surowy zapis na stderr. */
  readonly stderr: (text: string) => void;
  /** Środowisko procesu CLI. */
  readonly env: NodeJS.ProcessEnv;
  /** Katalog roboczy wywołania. */
  readonly cwd: string;
  /**
   * Platforma komend ({@link platformOf}; domyślnie `process.platform`). `bin/rarog.mjs` jej nie podaje; testy podają
   * `linux`, żeby gałęzie `systemd --user` biegły na macOS na atrapach z `PATH`.
   */
  readonly platform?: NodeJS.Platform;
  /** Katalog procfs dla `rarog doctor` na Linuksie (`<procRoot>/<pid>/environ`); domyślnie `/proc`. */
  readonly procRoot?: string;
  /**
   * Pytanie do człowieka na terminalu (`rarog setup`): odpowiedź albo `null` przy EOF. Brak = wywołanie bez terminala
   * (stdin albo stdout nie jest TTY): komenda nie pyta i niczego nie zapisuje. `bin/rarog.mjs` podaje je tylko przy
   * TTY; testy podają własne odpowiedzi.
   */
  readonly ask?: (prompt: string) => Promise<string | null>;
  /**
   * Pytanie o sekret BEZ ECHA (`rarog dictation set-key`): wpisane znaki nie trafiają na ekran, Enter kończy,
   * Backspace kasuje znak; Ctrl-D = `null`, Ctrl-C = odrzucenie `SecretInputInterrupted` (kod 130), dłuższe niż
   * `SECRET_MAX_BYTES` = odrzucenie `SecretInputTooLong`. `bin/rarog.mjs` podaje je tylko, gdy stdin
   * i stdout to terminal (`secretInput`); kod mieszka w `secret-input.ts`.
   */
  readonly askSecret?: (prompt: string) => Promise<string | null>;
  /**
   * Cały stdin do EOF, gdy stdin nie jest terminalem (klucz z potoku): najwyżej `maxBytes` bajtów, dłuższe wejście =
   * odrzucenie `SecretInputTooLong`, błąd strumienia = odrzucenie z tym błędem.
   */
  readonly readStdin?: (maxBytes: number) => Promise<string>;
  /**
   * What stdout is: a terminal with its width and colour, or not a terminal. `bin/rarog.mjs` passes
   * {@link describeTerminal} of `process.stdout`; without it a command treats stdout as no terminal
   * ({@link NO_TERMINAL}). The step screen (`screen/`) draws from it.
   */
  readonly terminal?: CliTerminal;
  /**
   * Columns of the terminal at this moment (`process.stdout.columns`, which follows a resize; `0` = unknown).
   * `bin/rarog.mjs` passes it only when stdout is a terminal. The step screen reads it when a question is asked and
   * when it is answered, and takes an answered question off the screen only when both readings are the same and
   * known; without it nothing is taken off.
   */
  readonly columnsNow?: () => number;
}

/** Description of stdout for the step screen. */
export interface CliTerminal {
  /** stdout is a terminal and `TERM` is not `dumb`: the live line may be redrawn. */
  readonly tty: boolean;
  /** Columns the terminal reports; `0` when unknown (not a terminal, or a pseudo-terminal without a size). */
  readonly columns: number;
  /** Colour is allowed: a terminal, no `NO_COLOR`, and the stream reports colours. */
  readonly color: boolean;
}

/** stdout that is not a terminal: plain lines, no colour. */
export const NO_TERMINAL: CliTerminal = { tty: false, columns: 0, color: false };

/** The part of a write stream `describeTerminal` looks at (`process.stdout`, a `tty.WriteStream`). */
export interface TerminalStream {
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly hasColors?: (env?: object) => boolean;
}

/** Terminal description of `stream` under the environment `env`. */
export function describeTerminal(stream: TerminalStream, env: NodeJS.ProcessEnv): CliTerminal {
  const tty = stream.isTTY === true && env['TERM'] !== 'dumb';
  if (!tty) return NO_TERMINAL;
  const columns = typeof stream.columns === 'number' && Number.isFinite(stream.columns) && stream.columns > 0
    ? Math.floor(stream.columns)
    : 0;
  const noColor = env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '';
  return { tty, columns, color: !noColor && stream.hasColors?.(env) === true };
}

/** Terminal description of a call: the injected one or {@link NO_TERMINAL}. */
export function terminalOf(io: CliIo): CliTerminal {
  return io.terminal ?? NO_TERMINAL;
}

/** Odpowiedź „tak” na pytanie `[y/N]`: „y”, „yes”, „t” albo „tak” (bez względu na wielkość liter); EOF i reszta = nie. */
export function isYes(answer: string | null): boolean {
  return answer !== null && ['t', 'tak', 'y', 'yes'].includes(answer.trim().toLowerCase());
}

/** Platforma wywołania: wstrzyknięta w `CliIo` albo platforma tego procesu. */
export function platformOf(io: CliIo): NodeJS.Platform {
  return io.platform ?? process.platform;
}

/** Złe wywołanie: komunikat i użycie, kod 64. */
export class Usage extends Error {}

/** Odmowa z jednym zdaniem dla człowieka, kod 1. */
export class Refusal extends Error {}

export const EXIT_OK = 0;
export const EXIT_REFUSED = 1;
export const EXIT_UNREACHABLE = 2;
export const EXIT_USAGE = 64;
export const EXIT_INTERRUPTED = 130;

/** Linia na stdout. */
export function out(io: CliIo, line: string): void {
  io.stdout(`${line}\n`);
}

/** Linia na stderr. */
export function err(io: CliIo, line: string): void {
  io.stderr(`${line}\n`);
}

/**
 * Katalog domowy wywołania: niepuste `HOME` z wstrzykniętego środowiska, inaczej katalog domowy użytkownika procesu.
 * Komendy liczą od niego wszystko (kopia hooka, ustawienia Claude Code, katalog danych, `~/.config/rarog`), więc
 * test z własnym `HOME` w `CliIo` nie dotyka domu właściciela.
 */
export function homeOf(env: NodeJS.ProcessEnv): string {
  const home = env['HOME'];
  return home !== undefined && home !== '' ? home : os.homedir();
}
