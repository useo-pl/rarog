/**
 * `rarog dialogs off|release` — sterowanie kanałem zgód hooka `PermissionRequest` (warstwa 1) z powłoki
 * właściciela:
 *
 *   rarog dialogs off [--data-dir <katalog>]
 *   rarog dialogs release <sessionId> [--key <klucz>] [--data-dir <katalog>]
 *
 * Rozmawia WYŁĄCZNIE z gniazdem administracyjnym `<dataDir>/run/admin.sock` (trasy `dialogs/off`
 * i `dialogs/release`, `server/src/auth/admin.ts`), jak `rarog devices`: gniazdo `0o600` w katalogu `0o700`, poza
 * zasięgiem sandboksa agenta. `off` przestawia tryb efektywny kanału na `off` DO RESTARTU serwera
 * (`herdr/dialogs/layer1/mode.ts`) i niczego nie zapisuje w konfiguracji, więc wypisuje krok, który trzyma `off`
 * po restarcie: wpis `RAROG_CONSENT_CHANNEL` = `off` w `~/.config/rarog/config.json`. Opis i sekwencja powrotu:
 * `docs/server-config.md`, „Preferences and feature flags”.
 *
 * `rarog dialogs last-approval --since <time> [--data-dir <dir>]` is read-only and needs no server: it reads the
 * consent channel records (`latestDeviceApprovalAt` in `layer1/records.ts`) and prints the ISO time of the newest
 * device approval decided at or after `--since` (exit 0), or exits 1. Its caller proves a server version with it.
 */
import http from 'node:http';
import path from 'node:path';
import { dataDirConflictMessage, resolveDataDir } from '@rarog/shared/data-dir';
import { ADMIN_SOCKET_PATH_MAX, adminSocketPath } from '../auth/admin.ts';
import { CONSENT_CHANNEL_ENV } from '../config-env.ts';
import { CONSENT_ADMIN_OFF_ROUTE, CONSENT_ADMIN_RELEASE_ROUTE } from '../herdr/dialogs/layer1/contract.ts';
import { latestDeviceApprovalAt } from '../herdr/dialogs/layer1/records.ts';
import { EXIT_OK, EXIT_REFUSED, EXIT_UNREACHABLE, Usage, err, homeOf, out } from './io.ts';
import type { CliIo } from './io.ts';
import { CONFIG_FILENAME, rarogConfigDir } from './serve.ts';
import { usageFor } from './screen/prose.ts';

export const DIALOGS_USAGE = `  rarog dialogs off [--data-dir <dir>]
      Turns the consent channel off until the server restarts: waiting permission hooks exit and the dialogs stay
      in the terminal. The configuration does not change.
  rarog dialogs release <sessionId> [--key <key>] [--data-dir <dir>]
      Releases the consent channel cards of a session (or the one with --key) to the terminal.
  rarog dialogs last-approval --since <time> [--data-dir <dir>]
      Prints the time of the newest approval from a device, decided at or after <time> (ISO 8601) and applied by
      Claude Code; exits with code 1 when there is none. Read-only, no server needed.`;

const REQUEST_TIMEOUT_MS = 10_000;
const REPLY_MAX_BYTES = 64 * 1024;

interface Flags {
  help?: boolean;
  key?: string;
  since?: string;
  'data-dir'?: string;
}

const VALUE_FLAGS = { '--key': 'key', '--since': 'since', '--data-dir': 'data-dir' } as const;

function parseArgs(argv: readonly string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
    } else if (Object.hasOwn(VALUE_FLAGS, arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Usage(`${arg} needs a value.`);
      flags[VALUE_FLAGS[arg as keyof typeof VALUE_FLAGS]] = value;
      i += 1;
    } else if (arg.startsWith('-')) {
      throw new Usage(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown> | null;
}

/**
 * Brak odpowiedzi na gnieździe; `code` = kod błędu połączenia. Wynik, nie wyjątek: klasa błędu bez pola `sentence`
 * wymaga wpisu w strażniku pochodzenia zdań, a ten tekst idzie tylko do terminala.
 */
interface Unreachable {
  readonly unreachable: string;
}

/** Jedno żądanie `POST` z ciałem JSON przez gniazdo Unix; nigdy nie odrzuca. */
function post(socketPath: string, route: string, body: unknown): Promise<Reply | Unreachable> {
  if (Buffer.byteLength(socketPath, 'utf8') > ADMIN_SOCKET_PATH_MAX) {
    return Promise.resolve({ unreachable: 'path too long' });
  }
  return new Promise((resolve) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      socketPath, path: route, method: 'POST', timeout: REQUEST_TIMEOUT_MS,
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) },
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size <= REPLY_MAX_BYTES) chunks.push(chunk);
      });
      res.on('end', () => {
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          parsed = null;
        }
        const record = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? parsed as Record<string, unknown> : null;
        resolve({ status: res.statusCode ?? 0, body: record });
      });
      // Połączenie zerwane po nagłówkach nie daje ani `end`, ani `error` żądania (Node 22: samo `aborted` i `close`),
      // a obietnica bez rozstrzygnięcia kończy CLI kodem 13 bez komunikatu. Drugie `resolve` po pierwszym nic nie robi.
      res.on('error', (failure: NodeJS.ErrnoException) => { resolve({ unreachable: failure.code ?? 'no code' }); });
      res.on('close', () => {
        if (!res.complete) resolve({ unreachable: 'ECONNRESET' });
      });
    });
    req.on('timeout', () => { req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })); });
    req.on('error', (failure: NodeJS.ErrnoException) => { resolve({ unreachable: failure.code ?? 'no code' }); });
    req.end(payload);
  });
}

function unreachableMessage(socketPath: string, code: string): string {
  if (code === 'EACCES' || code === 'EPERM') {
    return `No access to the socket ${socketPath} (${code}). Run the command as the server owner,`
      + ' in a regular shell: the socket is deliberately out of reach from the agent sandbox.';
  }
  return `The Rarog server does not answer on the socket ${socketPath} (${code}). Is it running? `
    + 'Check `curl -s localhost:8930/health` and the data directory (--data-dir).';
}

/** Kod wyjścia 2 z komunikatem, gdy gniazdo nie odpowiedziało; inaczej odpowiedź. */
function reached(socketPath: string, reply: Reply | Unreachable, io: CliIo): Reply | number {
  if (!('unreachable' in reply)) return reply;
  err(io, unreachableMessage(socketPath, reply.unreachable));
  return EXIT_UNREACHABLE;
}

const serverSays = (reply: Reply, fallback: string): string =>
  (typeof reply.body?.['message'] === 'string' ? reply.body['message'] : fallback);

/** Zdanie po `dialogs off`: tryb do restartu i wpis, który trzyma `off` po restarcie. */
export function dialogsOffReminder(env: NodeJS.ProcessEnv): string {
  const file = path.join(rarogConfigDir(env), CONFIG_FILENAME);
  return 'Consent channel off until the server restarts; the configuration did not change. To keep it off after a'
    + ` restart, set ${CONSENT_CHANNEL_ENV} to "off" in env in ${file}, then run rarog restart.`;
}

async function dialogsOff(socketPath: string, io: CliIo): Promise<number> {
  const reply = reached(socketPath, await post(socketPath, CONSENT_ADMIN_OFF_ROUTE, {}), io);
  if (typeof reply === 'number') return reply;
  if (reply.status !== 200) {
    err(io, serverSays(reply, `The server refused to turn the consent channel off (${String(reply.status)}).`));
    return EXIT_REFUSED;
  }
  out(io, dialogsOffReminder(io.env));
  return EXIT_OK;
}

async function dialogsRelease(socketPath: string, sessionId: string, key: string | undefined, io: CliIo): Promise<number> {
  const body = key === undefined ? { sessionId } : { sessionId, key };
  const reply = reached(socketPath, await post(socketPath, CONSENT_ADMIN_RELEASE_ROUTE, body), io);
  if (typeof reply === 'number') return reply;
  const released = reply.body?.['released'];
  if (reply.status !== 200 || !Array.isArray(released)) {
    err(io, serverSays(reply, `The server refused to release the cards (${String(reply.status)}).`));
    return EXIT_REFUSED;
  }
  const keys = released.filter((one): one is string => typeof one === 'string');
  if (keys.length === 0) {
    out(io, 'No consent channel card to release in this session.');
  } else {
    out(io, `Released to the terminal (${String(keys.length)}):`);
    for (const one of keys) out(io, `  ${one}`);
  }
  return EXIT_OK;
}

/** Days of each month in a common year; February gets 29 in a leap year. */
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** `YYYY-MM-DD` names a day the calendar has: `Date.parse` would move 30 February to 2 March instead of refusing it. */
function calendarDay(year: number, month: number, day: number): boolean {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = month === 2 && leap ? 29 : MONTH_DAYS[month - 1];
  return days !== undefined && day >= 1 && day <= days;
}

/** `--since`: an ISO 8601 date and time; other formats parse differently per engine, so they are refused. */
function parseSince(value: string | undefined): number {
  const date = value === undefined ? null : /^(\d{4})-(\d{2})-(\d{2})T/.exec(value);
  const at = value !== undefined && date !== null && calendarDay(Number(date[1]), Number(date[2]), Number(date[3]))
    ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(at)) throw new Usage('last-approval needs --since <time> (an ISO 8601 date and time).');
  return at;
}

/** Newest device approval since `since` from the records of `dataDir`: ISO time on stdout, or exit 1. */
function lastApproval(dataDir: string, since: number, io: CliIo): number {
  const at = latestDeviceApprovalAt(dataDir, since);
  if (at === null) {
    err(io, `No phone approval since ${new Date(since).toISOString()}.`);
    return EXIT_REFUSED;
  }
  out(io, new Date(at).toISOString());
  return EXIT_OK;
}

/** `rarog dialogs …` — `argv` zaczyna się od `dialogs`. `Usage` leci wyżej (komunikat i użycie wypisuje `main`). */
export async function dialogsCommand(argv: readonly string[], io: CliIo): Promise<number> {
  const { positional, flags } = parseArgs(argv.slice(1));
  if (flags.help === true) {
    out(io, usageFor(io, `Usage:\n${DIALOGS_USAGE}`));
    return EXIT_OK;
  }
  const [sub, ...rest] = positional;
  const isOff = sub === 'off' && rest.length === 0 && flags.key === undefined && flags.since === undefined;
  const isRelease = sub === 'release' && rest.length === 1 && flags.since === undefined;
  const isLastApproval = sub === 'last-approval' && rest.length === 0 && flags.key === undefined;
  if (!isOff && !isRelease && !isLastApproval) {
    throw new Usage(`Unknown command: dialogs ${positional.join(' ')}`.trimEnd());
  }
  const since = isLastApproval ? parseSince(flags.since) : 0;
  const resolved = resolveDataDir({ flag: flags['data-dir'], env: io.env, home: homeOf(io.env) });
  if (!resolved.ok) {
    err(io, dataDirConflictMessage(resolved));
    return EXIT_REFUSED;
  }
  if (isLastApproval) return lastApproval(resolved.dir, since, io);
  const socketPath = adminSocketPath(resolved.dir);
  return isOff ? dialogsOff(socketPath, io) : dialogsRelease(socketPath, rest[0] ?? '', flags.key, io);
}
