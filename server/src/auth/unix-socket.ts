/**
 * Server Unix socket in `<dataDir>/run/`: shared start, body reading and the JSON response for the admin
 * socket (`admin.ts`) and the consent channel registration socket (`consent-socket.ts`).
 *
 * The boundary of both is the file system: the `run/` directory `0o700`, the socket `0o600`, owner = the server user.
 * The socket does NOT check the peer (Node has no `SO_PEERCRED`): every process that connects has all the socket's
 * routes. So routes with less power stand on a separate socket, not next to routes with more.
 *
 * The socket is created AFTER a successful `listen` of the HTTP port (`index.ts`): on EADDRINUSE the new process
 * exits before it touches the live predecessor's socket. A live socket of another process (answers `connect`) stays
 * untouched; a dead one (after a crash) is deleted and created again; a file that is not a socket stays untouched.
 */
import { lstatSync } from 'node:fs';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

/** Length cap of a Unix socket path on macOS (`sun_path` has 104 bytes with the trailing zero). */
export const UNIX_SOCKET_PATH_MAX = 103;

/** A running Unix socket. */
export interface UnixSocket {
  readonly path: string;
  /** Closes the server and deletes the socket file. */
  close(): Promise<void>;
}

export interface UnixSocketOptions {
  readonly path: string;
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void;
  readonly log: (line: string) => void;
  /** Log line prefix (`admin`, `consent`). */
  readonly label: string;
  /** Socket name in log lines, e.g. "admin socket". */
  readonly name: string;
  /** Suffix of the too-long-path line: what to shorten. */
  readonly pathHint: string;
  /** `requestTimeout` of the socket's HTTP server. */
  readonly requestTimeoutMs: number;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(payload, 'utf8')),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

export interface JsonBodyLimits {
  readonly maxBytes: number;
  readonly timeoutMs: number;
  /**
   * Response to an unacceptable body: 413 over {@link maxBytes}, 400 after the deadline, on a stream error
   * and on bad JSON. Called synchronously, before the request is dropped.
   */
  readonly refuse: (status: 400 | 413) => void;
}

/**
 * JSON body within limits; `undefined` = unacceptable body (the refusal already went through `refuse`). Empty = `{}`.
 */
export function readJsonBody(req: IncomingMessage, limits: JsonBodyLimits): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (value: unknown, status?: 400 | 413): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (status !== undefined) limits.refuse(status);
      resolve(value);
    };
    const timer = setTimeout(() => { finish(undefined, 400); req.destroy(); }, limits.timeoutMs);
    timer.unref();
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limits.maxBytes) {
        finish(undefined, 413);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        finish(text === '' ? {} : JSON.parse(text) as unknown);
      } catch {
        finish(undefined, 400);
      }
    });
    req.on('error', () => { finish(undefined, 400); });
  });
}

/** Whether a live process answers at the path: `connect` with a short deadline. */
function socketAnswers(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.connect(socketPath);
    const done = (alive: boolean): void => {
      probe.removeAllListeners();
      probe.destroy();
      resolve(alive);
    };
    probe.setTimeout(500, () => { done(false); });
    probe.once('connect', () => { done(true); });
    probe.once('error', () => { done(false); });
  });
}

/**
 * Creates a Unix socket at `options.path` (directory `0o700`, socket `0o600`) with the given HTTP handler.
 *
 * `null` = no socket (path too long, the directory is not a directory, the file is not a socket, a live socket
 * of another process, a `listen` error): a log line, and the server keeps running. Never throws.
 */
export async function startUnixSocket(options: UnixSocketOptions): Promise<UnixSocket | null> {
  const { path: socketPath, log, label, name } = options;
  if (Buffer.byteLength(socketPath, 'utf8') > UNIX_SOCKET_PATH_MAX) {
    log(`${label}: socket path longer than ${String(UNIX_SOCKET_PATH_MAX)} B — no socket${options.pathHint}`);
    return null;
  }
  const dir = path.dirname(socketPath);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const info = await lstat(dir);
    if (!info.isDirectory()) {
      log(`${label}: ${dir} is not a directory — no socket`);
      return null;
    }
    await chmod(dir, 0o700);
    let existing: ReturnType<typeof lstatSync> | null = null;
    try {
      existing = lstatSync(socketPath);
    } catch {
      existing = null;
    }
    if (existing !== null) {
      if (!existing.isSocket()) {
        log(`${label}: ${socketPath} exists and is not a socket — left untouched, no socket`);
        return null;
      }
      if (await socketAnswers(socketPath)) {
        log(`${label}: the ${name} belongs to another live process — not taking it over`);
        return null;
      }
      await unlink(socketPath);
    }
  } catch (err: unknown) {
    const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
    log(`${label}: socket setup failed (${typeof code === 'string' ? code : 'no code'}) — no socket`);
    return null;
  }
  const server = http.createServer(options.handler);
  // Bodies are small and short; the socket does not hold long connections.
  server.requestTimeout = options.requestTimeoutMs;
  const listening = await new Promise<boolean>((resolve) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      log(`${label}: listen on the socket failed (${err.code ?? 'no code'}) — no socket`);
      resolve(false);
    });
    server.listen(socketPath, () => { resolve(true); });
  });
  if (!listening) return null;
  try {
    await chmod(socketPath, 0o600);
  } catch {
    // The `0o700` directory cuts off other users anyway; a missing chmod does not open the socket.
  }
  log(`${label}: ${name} ${socketPath}`);
  return {
    path: socketPath,
    close: () => new Promise<void>((resolve) => {
      server.close(() => {
        void unlink(socketPath).catch(() => {}).finally(() => { resolve(); });
      });
      server.closeAllConnections();
    }),
  };
}
