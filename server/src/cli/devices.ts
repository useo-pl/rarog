/**
 * `rarog pair` i `rarog devices`: parowanie pierwszego urządzenia i odpinanie.
 *
 *   rarog pair [--url <https adres>] [--data-dir <katalog>]
 *   rarog devices [list] [--data-dir <katalog>]
 *   rarog devices revoke <deviceId> | --all [--data-dir <katalog>]
 *
 * Rozmawia WYŁĄCZNIE z gniazdem administracyjnym serwera `<dataDir>/run/admin.sock` (trasy `/api/admin/*`,
 * `server/src/auth/admin.ts`) — nie z portem serwera, nie z plikami w `dataDir`. Gniazdo ma prawa `0o600`
 * w katalogu `0o700`, więc działa z powłoki właściciela, a nie z sandboksa agenta Claude Code. `dataDir` liczy
 * reguła `shared/src/data-dir.mjs` (ta sama co w serwerze i hooku; `--data-dir` jako flaga), a konflikt katalogów to
 * odmowa z kodem 1. Link parowania składa ta sama funkcja co serwer (`pairingLink`), więc schemat ma jedno źródło:
 * adres `u=` z `--url` albo z odpowiedzi serwera, pola `k=`/`r=` z `iroh` w odpowiedzi; odmowa tylko bez
 * adresu i bez serwera iroh.
 * A signal while `rarog pair` waits (Ctrl-C, SIGTERM, a closed terminal) cancels the shown code on the server before
 * the command exits ({@link cancelOnSignal}).
 * Kod QR rysuje `qrcode` (MIT, zależność korzenia repo) — tylko tutaj; moduły serwera go nie importują
 * (`server/test/docs-zgodnosc.test.ts`). Opis dla człowieka: `docs/distribution.md`.
 */
import http from 'node:http';
import path from 'node:path';
import QRCode from 'qrcode';
import { dataDirConflictMessage, resolveDataDir } from '@rarog/shared/data-dir';
import { IROH_ENDPOINT_ID_RE, irohRelayUrl } from '@rarog/shared/pairing-link';
import type { PairingLinkIroh } from '@rarog/shared/pairing-link';
import { ADMIN_SOCKET_PATH_MAX, DEVICE_ACTIVE_ERROR, PAIRING_REDEEMED_ERROR, pairingLink } from '../auth/admin.ts';
import { sanitizeBuild, sanitizeLabel } from '../text.ts';
import { deferInterruptExit } from './child-output.ts';
import { EXIT_OK, EXIT_REFUSED, EXIT_UNREACHABLE, Usage, err, homeOf, out } from './io.ts';
import type { CliIo } from './io.ts';
import { usageFor } from './screen/prose.ts';

export const DEVICES_USAGE = `  rarog pair [--url <https url>] [--data-dir <dir>]
      Pairing code (QR and link) for the FIRST device; waits for its first connection. The link carries the https
      address (RAROG_ORIGINS or --url) and the iroh server when the server listens on it (RAROG_IROH=1).
      Ctrl-C while it waits cancels the code on the server.
      With a device already paired the server refuses: pair new devices with a code from the app.
  rarog devices [list] [--data-dir <dir>]
      Active devices and the most recently revoked ones.
  rarog devices revoke <deviceId> | --all [--data-dir <dir>]
      Revokes one device or all of them (closes their connections at once). Revoking one also revokes the devices
      paired through it, and the ones paired through those; the list shows what went.`;

/**
 * What to do after a change of `RAROG_IROH_RELAY` with a paired device (the `device-active` refusal). The server
 * refuses while ANY device is active, so a revocation that leaves one active is not enough: either pair from an app
 * that still reaches the server (its link carries the current relay), or revoke them all and run `rarog pair` again.
 */
const RELAY_CHANGE_PROCEDURE = 'After a change of RAROG_IROH_RELAY an app that still reaches this server takes the'
  + ' new relay from it; a device that reaches it only over iroh and lost the way gets the new relay only from a new'
  + ' pairing link. If an app still reaches this server, pair the other devices'
  + ' from it: Settings → Pairing → Pair New Device. If none does, revoke them all (rarog devices revoke --all), run'
  + ' rarog pair for the first device and pair the rest from its app.';

/** Odstęp pytań o stan parowania. */
const POLL_MS = 1_000;

interface Flags {
  all?: boolean;
  help?: boolean;
  url?: string;
  'data-dir'?: string;
}

/** Argumenty: pozycyjne, flagi `--klucz wartość` i `--flaga`. */
function parseArgs(argv: readonly string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg === '--all') {
      flags.all = true;
    } else if (arg === '--help' || arg === '-h') {
      flags.help = true;
    } else if (arg === '--url' || arg === '--data-dir') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Usage(`${arg} needs a value.`);
      flags[arg === '--url' ? 'url' : 'data-dir'] = value;
      i += 1;
    } else if (arg.startsWith('-')) {
      throw new Usage(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

/** Brak żywego serwera na gnieździe (nie ma pliku, nikt nie słucha, brak praw). */
class Unreachable extends Error {
  constructor(readonly socketPath: string, readonly code: string) {
    super(code);
  }
}

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown> | null;
}

/** Kod {@link Unreachable} dla ścieżki dłuższej niż gniazdo, które zakłada serwer: pod nią gniazda nie ma. */
const SOCKET_PATH_TOO_LONG = 'path too long';

/**
 * Jedno żądanie JSON przez gniazdo Unix. `deadlineMs` bounds the whole request, the answer included (the cancel after a
 * signal); without it only an idle socket times out.
 */
function request(socketPath: string, method: string, route: string, body?: unknown, deadlineMs?: number): Promise<Reply> {
  // Bez `connect`: na Node 24.11.1 za długa ścieżka gniazda rzuca EINVAL jako wyjątek procesu, obok `error` żądania.
  if (Buffer.byteLength(socketPath, 'utf8') > ADMIN_SOCKET_PATH_MAX) {
    return Promise.reject(new Unreachable(socketPath, SOCKET_PATH_TOO_LONG));
  }
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const timedOut = (): void => { req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })); };
    // The deadline settles the promise itself: a socket destroyed mid-answer errors on the response, not the request.
    const deadline = deadlineMs === undefined ? undefined : setTimeout(() => {
      timedOut();
      reject(new Unreachable(socketPath, 'ETIMEDOUT'));
    }, deadlineMs);
    const req = http.request({
      socketPath, path: route, method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) },
      timeout: 10_000,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      res.on('end', () => {
        clearTimeout(deadline);
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown = null;
        try {
          parsed = text === '' ? null : JSON.parse(text);
        } catch {
          parsed = null;
        }
        const record = parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
        resolve({ status: res.statusCode ?? 0, body: record });
      });
    });
    req.on('timeout', timedOut);
    req.on('error', (failure: NodeJS.ErrnoException) => {
      clearTimeout(deadline);
      reject(new Unreachable(socketPath, failure.code ?? 'no code'));
    });
    req.end(payload);
  });
}

function unreachableMessage(failure: Unreachable): string {
  if (failure.code === SOCKET_PATH_TOO_LONG) {
    return `Socket ${failure.socketPath} does not exist: the path has ${String(Buffer.byteLength(failure.socketPath, 'utf8'))} B,`
      + ` and the server creates a socket of at most ${String(ADMIN_SOCKET_PATH_MAX)} B. Check the data directory (--data-dir).`;
  }
  if (failure.code === 'EACCES' || failure.code === 'EPERM') {
    return `No access to the socket ${failure.socketPath} (${failure.code}). Run the command as the server owner,`
      + ' in a regular shell: the socket is deliberately out of reach from the agent sandbox.';
  }
  return `The Rarog server does not answer on the socket ${failure.socketPath} (${failure.code}). Is it running? `
    + 'Check `curl -s localhost:8930/health` and the data directory (--data-dir).';
}

/** Zdanie serwera z ciała błędu albo zapasowe. */
const serverSays = (reply: Reply, fallback: string): string =>
  (typeof reply.body?.['message'] === 'string' ? reply.body['message'] : fallback);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

const clock = (iso: string): string =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const text = (value: unknown): string => (typeof value === 'string' ? value : String(value));

/**
 * A device label as the terminal prints it: the pairing rule again, because a tombstone or a record written
 * under an older rule can still carry a character that moves or hides text in the terminal.
 */
const shownLabel = (value: unknown): string => sanitizeLabel(text(value));

/**
 * Serwer iroh z odpowiedzi `POST /api/admin/pairings`: `null` = serwer bez nasłuchu iroh, `'bad'` = kształt spoza
 * kontraktu linku parowania. `buildPairingLink` pól nie sprawdza, więc tutaj: EndpointId w jedynej postaci linku,
 * relay sprowadzony do postaci kanonicznej (`irohRelayUrl`), czyli dokładnie to, co apka odczyta z `r=`.
 */
function serverIroh(value: unknown): PairingLinkIroh | null | 'bad' {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return 'bad';
  const { endpointId, relay } = value as Record<string, unknown>;
  if (typeof endpointId !== 'string' || !IROH_ENDPOINT_ID_RE.test(endpointId)) return 'bad';
  if (typeof relay !== 'string') return 'bad';
  const canonical = irohRelayUrl(relay);
  return canonical === null ? 'bad' : { endpointId, relay: canonical };
}

async function pair(socketPath: string, flags: Flags, io: CliIo): Promise<number> {
  const issued = await request(socketPath, 'POST', '/api/admin/pairings');
  if (issued.status !== 200 || issued.body === null) {
    err(io, serverSays(issued, `The server refused a pairing code (${String(issued.status)}).`));
    // A device without an HTTPS address has no route to the server that could tell it the new relay, so after a
    // relay change only a new link helps: from an app that still connects, or from `rarog pair` after revoking all;
    // the same server key gives the same `k` in the link.
    if (issued.body?.['error'] === DEVICE_ACTIVE_ERROR) err(io, RELAY_CHANGE_PROCEDURE);
    return EXIT_REFUSED;
  }
  const { pairingId, code, expiresAt } = issued.body;
  const given = typeof flags.url === 'string' ? flags.url : issued.body['url'];
  const url = typeof given === 'string' && given !== '' ? given : null;
  const served = serverIroh(issued.body['iroh']);
  // Pole `k` albo `r` w złym kształcie psuje apce cały link (`bad-endpoint-id`, `bad-relay`), więc link idzie bez
  // nich: z adresem nadal paruje, a bez adresu nie ma go wcale (odmowa niżej).
  if (served === 'bad') {
    err(io, 'Warning: the server returned an iroh server in the wrong shape (an EndpointId or relay in a form the'
      + ' pairing link does not accept); the link goes without the k and r fields. Check RAROG_IROH_RELAY and rarog doctor.');
  }
  const iroh = served === 'bad' ? null : served;
  // Bez adresu i bez serwera iroh linku nie ma (`pairingLink` oddaje `null`): apka nie miałaby dokąd się połączyć.
  const link = pairingLink(url, iroh, text(code));
  if (link === null) {
    err(io, `The server does not know its address (RAROG_ORIGINS) and ${served === 'bad' ? 'returned no valid iroh'
      + ' server' : 'does not listen on iroh'}; give the address: rarog pair --url https://…`);
    return EXIT_REFUSED;
  }
  if (url !== null && !url.startsWith('https://')) {
    err(io, `Warning: the address ${url} is not https; the app refuses this link.`);
  }
  const qr = await QRCode.toString(link, { type: 'terminal', small: true });
  // Registered before the code shows, with no `await` in between: a signal after this cancels the code it shows.
  const cancel = cancelOnSignal(socketPath, text(pairingId), text(expiresAt), io);
  try {
    out(io, qr);
    out(io, `Link (app → "I have a link"):\n${link}\n`);
    out(io, `Code valid until ${clock(text(expiresAt))}, single use. Waiting for the device's first connection…`);
    return await waitForDevice(socketPath, text(pairingId), cancel, io);
  } finally {
    cancel.stop();
  }
}

/** Longest wait for the server to cancel the code after a signal; then the command exits anyway. */
const CANCEL_TIMEOUT_MS = 2_000;

interface CancelOnSignal {
  /** A signal came and the cancel runs: the command exits when it ends, so the wait reports nothing more. */
  readonly cancelling: () => boolean;
  /** No cancel any more: the code was used or the command ends. */
  readonly stop: () => void;
}

/**
 * While `rarog pair` waits, SIGINT, SIGTERM or SIGHUP (a closed terminal) cancels the shown code on the server before
 * the command exits: a code its owner gave up on does not stay usable for 5 minutes. The exit and its code
 * (128 + the signal number) belong to `interruptOrExit`, which waits for this request at most
 * {@link CANCEL_TIMEOUT_MS}; then one line on stderr says what came of it.
 */
function cancelOnSignal(socketPath: string, pairingId: string, expiresAt: string, io: CliIo): CancelOnSignal {
  let cancelling = false;
  const stop = deferInterruptExit(async () => {
    cancelling = true;
    err(io, await cancelPairing(socketPath, pairingId, expiresAt));
  });
  return { cancelling: () => cancelling, stop };
}

/** `DELETE /api/admin/pairings/:id` and the line about its outcome. */
async function cancelPairing(socketPath: string, pairingId: string, expiresAt: string): Promise<string> {
  try {
    const reply = await request(socketPath, 'DELETE', `/api/admin/pairings/${pairingId}`, undefined, CANCEL_TIMEOUT_MS);
    if (reply.status === 204) return 'pairing code cancelled';
    if (reply.status === 409 && reply.body?.['error'] === PAIRING_REDEEMED_ERROR) {
      // The signal met the redemption: the device is paired, so there is no expiry to name.
      return 'the pairing code was already used and the device is paired; see rarog devices';
    }
  } catch {
    // No answer within the limit: the code may still be valid, so the line names its expiry.
  }
  const until = new Date(expiresAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `could not cancel the pairing code; it expires at ${until}`;
}

/** The command exits from `interruptOrExit` after the cancel; until then the wait stays silent. */
const halted = (): Promise<never> => new Promise<never>(() => {});

/** Polls the pairing until the new device's first request, a refusal or a signal. */
async function waitForDevice(socketPath: string, pairingId: string, cancel: CancelOnSignal, io: CliIo): Promise<number> {
  let announced = false;
  for (;;) {
    await sleep(POLL_MS);
    if (cancel.cancelling()) return halted();
    let reply: Reply;
    try {
      reply = await request(socketPath, 'GET', `/api/admin/pairings/${pairingId}`);
    } catch (failure) {
      if (!(failure instanceof Unreachable)) throw failure;
      if (cancel.cancelling()) return halted();
      err(io, 'The server stopped responding (restart?); a pending pairing is lost on restart. '
        + 'Run rarog pair again once the server is back up.');
      return EXIT_REFUSED;
    }
    if (cancel.cancelling()) return halted();
    if (reply.status === 404) {
      err(io, 'The server no longer knows this pairing; did it restart in the meantime? Run rarog pair again.');
      return EXIT_REFUSED;
    }
    const state = reply.body?.['state'];
    if (state === 'expired') {
      err(io, 'The code expired or a newer one took its place (rarog pair in another window). Run rarog pair again.');
      return EXIT_REFUSED;
    }
    if (state === 'lost') {
      err(io, `Device ${text(reply.body?.['deviceId'])} did not connect within 10 min of pairing (the reply `
        + 'got lost on the way), or it was revoked. Pair again: rarog pair.');
      return EXIT_REFUSED;
    }
    if (state === 'redeemed' && reply.body?.['confirmed'] === true) {
      out(io, `Paired: ${shownLabel(reply.body['label'])} (${text(reply.body['deviceId'])})`);
      return EXIT_OK;
    }
    if (state === 'redeemed' && !announced) {
      announced = true;
      // A used code has nothing left to cancel: from here a signal just ends the command.
      cancel.stop();
      out(io, `Code used by "${shownLabel(reply.body?.['label'])}"; waiting for the first connection`
        + ' (up to 10 min)…');
    }
  }
}

function describeTime(iso: unknown): string {
  return typeof iso !== 'string' ? 'no connection yet' : new Date(iso).toLocaleString('en-GB');
}

interface DeviceRow {
  readonly id: string;
  readonly label: string;
  readonly createdAt: string;
  readonly creator: string;
  readonly lastSeenAt: string | null;
  readonly build: string | number | null;
}

interface TombstoneRow {
  readonly id: string;
  readonly label: string;
  /** Pairing date; absent from older servers. */
  readonly createdAt?: string;
  readonly revokedAt: string;
  readonly revokedBy: string;
}

async function devicesList(socketPath: string, io: CliIo): Promise<number> {
  const reply = await request(socketPath, 'GET', '/api/admin/devices');
  if (reply.status !== 200 || reply.body === null) throw new Error(`device list: ${String(reply.status)}`);
  const devices = reply.body['devices'] as readonly DeviceRow[];
  const revoked = reply.body['revoked'] as readonly TombstoneRow[];
  if (reply.body['authStore'] === 'broken') {
    out(io, 'WARNING: devices.json and its backup were unreadable at start; the store is empty (authStore: broken).');
  }
  if (devices.length === 0) {
    out(io, 'No active devices. Pair the first one: rarog pair');
  } else {
    out(io, `Active devices (${String(devices.length)}):`);
    for (const d of devices) {
      const build = sanitizeBuild(d.build === null ? null : String(d.build));
      out(io, `  ${d.id}  ${shownLabel(d.label)}`);
      out(io, `      paired ${describeTime(d.createdAt)} with a code from ${d.creator === 'admin' ? 'the Mac' : d.creator}`
        + `, last seen: ${describeTime(d.lastSeenAt)}${build === null ? '' : `, build ${build}`}`);
    }
  }
  const recent = revoked.slice(-10);
  if (recent.length > 0) {
    out(io, `Recently revoked (${String(recent.length)} of ${String(revoked.length)}):`);
    for (const t of recent) {
      out(io, `  ${t.id}  ${shownLabel(t.label)} — ${describeTime(t.revokedAt)} (${t.revokedBy})`);
    }
  }
  return EXIT_OK;
}

async function devicesRevoke(socketPath: string, positional: readonly string[], flags: Flags, io: CliIo): Promise<number> {
  const id = positional[0];
  if (flags.all !== true && id === undefined) throw new Usage('Give a device id or --all.');
  if (flags.all === true && id !== undefined) throw new Usage('Give a device id OR --all, not both.');
  const reply = await request(socketPath, 'POST', '/api/admin/devices/revoke', flags.all === true ? { all: true } : { id });
  if (reply.status !== 200 || reply.body === null) {
    err(io, serverSays(reply, `Revoke failed (${String(reply.status)}).`));
    return EXIT_REFUSED;
  }
  const done = reply.body['revoked'] as readonly TombstoneRow[];
  if (flags.all === true) {
    if (done.length === 0) out(io, 'There were no active devices to revoke.');
    for (const t of done) out(io, `Revoked: ${shownLabel(t.label)} (${t.id})`);
    if (done.length > 0) out(io, 'Pair a new first device: rarog pair');
    return EXIT_OK;
  }
  if (reply.body['alreadyRevoked'] === true) {
    out(io, `Device ${String(id)} was already revoked; the revocation is now saved to disk.`);
    return EXIT_OK;
  }
  // The server lists the device first when it was still active, then the devices paired through it.
  const device = done.find((t) => t.id === id);
  const descendants = done.filter((t) => t.id !== id);
  out(io, device === undefined
    ? `Device ${String(id)} was no longer active.`
    : `Revoked: ${shownLabel(device.label)} (${device.id})`);
  if (descendants.length > 0) {
    out(io, `Revoked with it, paired through it (${String(descendants.length)}):`);
    for (const t of descendants) {
      const paired = typeof t.createdAt === 'string' ? ` — paired ${describeTime(t.createdAt)}` : '';
      out(io, `  ${t.id}  ${shownLabel(t.label)}${paired}`);
    }
  }
  return EXIT_OK;
}

/**
 * `rarog pair …` i `rarog devices …` — `argv` zaczyna się od nazwy komendy. Oddaje kod wyjścia; `Usage` leci wyżej
 * (komunikat i użycie wypisuje `main`).
 */
export async function devicesCommand(argv: readonly string[], io: CliIo): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const [command, sub, ...rest] = positional;
  if (flags.help === true) {
    out(io, usageFor(io, `Usage:\n${DEVICES_USAGE}`));
    return EXIT_OK;
  }
  const isPair = command === 'pair' && sub === undefined;
  const isList = command === 'devices' && (sub === undefined || sub === 'list') && rest.length === 0;
  const isRevoke = command === 'devices' && sub === 'revoke';
  if (!isPair && !isList && !isRevoke) throw new Usage(`Unknown command: ${positional.join(' ')}`);
  // Konflikt katalogów = odmowa: CLI nie zgaduje, w którym katalogu leży gniazdo serwera.
  const resolved = resolveDataDir({ flag: flags['data-dir'], env: io.env, home: homeOf(io.env) });
  if (!resolved.ok) {
    err(io, dataDirConflictMessage(resolved));
    return EXIT_REFUSED;
  }
  const socketPath = path.join(resolved.dir, 'run', 'admin.sock');
  try {
    if (isPair) return await pair(socketPath, flags, io);
    if (isList) return await devicesList(socketPath, io);
    return await devicesRevoke(socketPath, rest, flags, io);
  } catch (failure) {
    if (failure instanceof Unreachable) {
      err(io, unreachableMessage(failure));
      return EXIT_UNREACHABLE;
    }
    throw failure;
  }
}
