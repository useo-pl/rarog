/**
 * The ONLY place that loads the iroh library: `require()` at the moment `loadIroh()` is called, so the native module
 * enters the process only when someone asks for it. The rest of the directory sees the shape from `endpoint.ts`;
 * `server/test/iroh-granice.test.ts` guards the boundary.
 *
 * Register of facts about the `@number0/iroh` 1.2.0 binding (N-API from iroh-ffi; checked on Apple silicon,
 * Node 22, by the test `server/test/iroh-zywa-biblioteka.test.ts` or in the package source):
 *
 * 1. Bytes travel as `Array<number>` both ways: `RecvStream.read(sizeLimit)` allocates `sizeLimit` bytes
 *    per call and returns an array of numbers, `SendStream.writeAll` accepts only an array. The conversion costs
 *    CPU on every chunk, so the chunk is a fixed 64 KiB.
 * 2. An empty array from `read` = the sender's FIN (in the source: `res.unwrap_or(0)`).
 * 3. One mutex (tokio) per stream half: `read` holds the receive mutex for the whole wait, `writeAll` holds
 *    the send mutex until flow control accepts the bytes. So `stop` waits for a hanging `read`, and `reset`
 *    for a hanging `writeAll`, with no upper bound (measured: both hang over 1 s).
 * 4. `Connection.close()` ends a hanging `read` and `writeAll` with the error `ConnectionLost(LocallyClosed)`, after
 *    which waiting `reset` and `stop` finish in about 1 ms (measured). The escalation in `listener.ts` rests on this.
 * 5. After `Connection.close()` `acceptBi` and `acceptUni` end with the error `LocallyClosed`; after `Endpoint.close()`
 *    `acceptNext` returns `null`.
 * 6. `EndpointId.toString()` gives 64 lowercase hex characters, although the type declaration says "base32"
 *    (measured; the same form as `k=` in the pairing link).
 * 7. Watchers (`watchHomeRelay` and related) call the callback in the Node convention `(error, value)`, although
 *    the type declaration gives one argument (measured: `[null, []]`). A watcher without `stop()` keeps the process
 *    alive after `Endpoint.close()`. `watchHomeRelay` returns only the addresses from `home_relay_status()` (package
 *    source, `src/watch.rs`): the connection state is lost, although the declaration says "connected relays".
 *    Measured with a reachable relay: `[]` at start, then two events with the same address (about 3.0 s and 3.1 s),
 *    `online()` at the second; with a relay unreachable for 8 s only `[]`.
 * 8. `online()` without a reachable relay never finishes, also after `Endpoint.close()`, has no cancellation
 *    and keeps the process alive (measured with the relay off and with an address where nothing listens).
 * 9. Missing from the API: idle and keep-alive configuration, a connection limit per endpoint, a portmapper switch
 *    (with `presetMinimal` SSDP `M-SEARCH` every 22–26 s). `listener.ts` enforces the limits.
 * 10. `presetMinimal` is the crypto provider alone: no address publishing and no discovery (DNS only for the
 *     relay). `bindAddr` once per address family; without it the system gives a port for `0.0.0.0` and `[::]`
 *     separately.
 * 11. Busy port: `bind()` ends with the error `Failed to bind sockets` caused by `Address already in use`.
 *     Without network permissions (sandbox) `bind()` fails with `Failed to create netmon monitor`.
 * 12. The package's JS loader reads `NAPI_RS_NATIVE_LIBRARY_PATH` (loads the native module from that path)
 *     and `NAPI_RS_FORCE_WASI`; a missing platform package gives the error `Cannot find native binding`. The
 *     platform packages are `optionalDependencies` without install scripts; darwin-x64 has none.
 * 13. Paths (measured on loopback without a relay, Node 22, Apple silicon; the event shape from the package
 *     source, `src/path.rs`): `watchPathEvents` calls back `(null, event)` like fact 7 and does not replay the path
 *     selected during the handshake; at accept `paths()` already lists it with `isSelected`. Seen on loopback:
 *     `Opened`/`Closed` of a second path over `::1` without a `Selected`, and `Closed` of the selected path on close.
 *     A `Selected` event carries `id`, `remoteAddr` (`ip:port`, or the relay URL for a relay path) and `localAddr`,
 *     but no relay flag and no stats, so relay vs direct and the RTT come from `paths()` by `id`. `paths()`,
 *     `stats()` and `rtt()` still answer after the connection closed. A `Lagged` event (the broadcast channel of
 *     path events overflowed; from the source) carries only `missed`. A switch relay → direct was not measured
 *     here (no relay on loopback).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { IROH_ALPN } from '@rarog/shared/iroh';
import type {
  IrohAccepting, IrohBiStream, IrohConnection, IrohEndpoint, IrohIncoming, IrohPathUpdate, IrohRecvStream, IrohWatch,
} from './endpoint.ts';

/** The library module once loaded (types from the package declaration; nothing from here enters at run time). */
export type IrohModule = typeof import('@number0/iroh');
type Lib = IrohModule;
type LibEndpoint = InstanceType<Lib['Endpoint']>;
type LibConnection = InstanceType<Lib['Connection']>;
type LibBiStream = InstanceType<Lib['BiStream']>;
type LibRecvStream = InstanceType<Lib['RecvStream']>;
type LibIncoming = InstanceType<Lib['Incoming']>;

/** Package name: messages and manifest reading. The import has a literal (boundary in the guard). */
export const IROH_PACKAGE = '@number0/iroh';

/** Read and write chunk (fact 1). */
export const IROH_CHUNK = 64 * 1024;

const LOAD_HINT = 'set RAROG_IROH=0 or run on Apple silicon or Linux';

/** Start of the stderr line in which the module probe (`module-probe.ts`) gives the CLI process the failure reason. */
export const IROH_PROBE_PREFIX = 'iroh-probe: ';

/** The native module does not load: no package, no platform package, or its error. Message for a human. */
export class IrohLoadError extends Error {
  override readonly name = 'IrohLoadError';
}

/** The process platform in package notation (`darwin-arm64`, `linux-x64`). */
export function irohPlatform(): string {
  return `${process.platform}-${process.arch}`;
}

/** Library error message on one line: `Caused by:` lines joined with a colon. */
function oneLine(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.split('\n').map((line) => line.trim()).filter((line) => line !== '' && line !== 'Caused by:').join(': ');
}

function isMissingPackage(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND';
}

/**
 * Package loader: `require()`, not `import()`. The package is CommonJS and reassigns `module.exports`; in the server
 * process started through tsx (clone install, Node 22.22.3 on Apple silicon) `import()` of it returned the original,
 * empty `exports` object, while `require()` returns the final one.
 */
const requireIroh = async (): Promise<unknown> => createRequire(import.meta.url)('@number0/iroh') as unknown;

/**
 * Loads the library. Tests swap `importModule` (no package, platform package error); by default the real
 * `require()` of the package. Failure = {@link IrohLoadError} with a sentence on what to do and the cause in `cause`.
 */
export async function loadIroh(importModule: () => Promise<unknown> = requireIroh): Promise<IrohModule> {
  let mod: unknown;
  try {
    mod = await importModule();
  } catch (err: unknown) {
    const reason = isMissingPackage(err)
      ? `package ${IROH_PACKAGE} is not installed`
      : `the native module does not load: ${oneLine(err).split('. ')[0] ?? ''}`;
    throw new IrohLoadError(`no native iroh module for ${irohPlatform()} (${reason}); ${LOAD_HINT}`, { cause: err });
  }
  // `require()` gives `module.exports` itself; a module namespace (test doubles, `import()`) has it in `default`.
  const candidates = [mod, (mod as { default?: unknown } | null)?.default];
  const lib = candidates.find((candidate): candidate is IrohModule =>
    typeof (candidate as Partial<IrohModule> | null | undefined)?.Endpoint?.builder === 'function');
  if (lib === undefined) {
    throw new IrohLoadError(`no native iroh module for ${irohPlatform()} (unknown package shape); ${LOAD_HINT}`);
  }
  return lib;
}

/** The package and platform package from disk, without loading native code. `null` = absent. */
export interface IrohModuleInfo {
  readonly version: string | null;
  /** Platform package for this process; `null` when the platform has no package (e.g. darwin-x64). */
  readonly platformPackage: string | null;
  readonly platformVersion: string | null;
}

/** Platform package name: Apple silicon and Linux (glibc or musl) on x64 and arm64. */
function platformPackageName(): string | null {
  const { platform, arch } = process;
  if (platform === 'darwin') return arch === 'arm64' ? `${IROH_PACKAGE}-darwin-arm64` : null;
  if (platform !== 'linux' || (arch !== 'x64' && arch !== 'arm64')) return null;
  const report = process.report.getReport() as { header?: { glibcVersionRuntime?: unknown } };
  const libc = report.header?.glibcVersionRuntime === undefined ? 'musl' : 'gnu';
  return `${IROH_PACKAGE}-linux-${arch}-${libc}`;
}

function versionAt(manifest: string): string | null {
  const version = (JSON.parse(readFileSync(manifest, 'utf8')) as { version?: unknown }).version;
  return typeof version === 'string' ? version : null;
}

/**
 * Versions from the manifests (`package.json`) for `rarog doctor` and the listener snapshot; native code stays out of
 * the process.
 */
export function irohModuleInfo(): IrohModuleInfo {
  const platformPackage = platformPackageName();
  let main: string;
  try {
    main = createRequire(import.meta.url).resolve(`${IROH_PACKAGE}/package.json`);
  } catch {
    return { version: null, platformPackage, platformVersion: null };
  }
  let platformVersion: string | null = null;
  if (platformPackage !== null) {
    try {
      // pnpm keeps the platform package next to the main package, not in the server's `node_modules`: we search from
      // it.
      platformVersion = versionAt(createRequire(main).resolve(`${platformPackage}/package.json`));
    } catch {
      platformVersion = null;
    }
  }
  return { version: versionAt(main), platformPackage, platformVersion };
}

/** `bind` parameters. */
export interface IrohEndpointOptions {
  /** The server's secret key, 32 bytes: the identity (EndpointId) across restarts. */
  readonly secretKey: Uint8Array;
  /** Relay in canonical form (`irohRelayUrl`); `null` = no relay, direct addresses only. */
  readonly relay: string | null;
  /** Fixed UDP port on `0.0.0.0` and `[::]` (firewall rule); `null` = port from the system. */
  readonly port: number | null;
}

/**
 * Opens the server endpoint: `presetMinimal` (fact 10), the key, one ALPN ({@link IROH_ALPN}), relay and port.
 * The live test passes `lib`; by default {@link loadIroh}.
 */
export async function openEndpoint(options: IrohEndpointOptions, lib?: IrohModule): Promise<IrohEndpoint> {
  if (options.secretKey.length !== 32) throw new Error('iroh: the server key must be 32 bytes');
  const iroh = lib ?? await loadIroh();
  const builder = iroh.Endpoint.builder();
  iroh.presetMinimal(builder);
  builder.secretKey(Array.from(options.secretKey));
  builder.alpns([Array.from(Buffer.from(IROH_ALPN))]);
  builder.relayMode(options.relay === null ? iroh.RelayMode.disabled() : iroh.RelayMode.customFromUrls([options.relay]));
  if (options.port !== null) {
    builder.bindAddr(`0.0.0.0:${String(options.port)}`);
    builder.bindAddr(`[::]:${String(options.port)}`);
  }
  let endpoint: LibEndpoint;
  try {
    endpoint = await builder.bind();
  } catch (err: unknown) {
    const port = options.port === null ? 'from the system' : String(options.port);
    throw new Error(`iroh: endpoint did not start (UDP port ${port}): ${oneLine(err)}`, { cause: err });
  }
  return wrapEndpoint(endpoint);
}

function wrapEndpoint(endpoint: LibEndpoint): IrohEndpoint {
  return {
    endpointId: endpoint.id().toString(),
    boundSockets: () => endpoint.boundSockets(),
    acceptNext: async () => {
      const incoming = await endpoint.acceptNext();
      return incoming === null ? null : wrapIncoming(incoming);
    },
    online: () => endpoint.online(),
    watchHomeRelay(callback): IrohWatch {
      const handle = endpoint.watchHomeRelay((...args: unknown[]) => {
        const value = watchValue(args);
        if (Array.isArray(value)) callback(value.filter((url): url is string => typeof url === 'string'));
      });
      return { stop: () => handle.stop() };
    },
    close: () => endpoint.close(),
  };
}

function wrapIncoming(incoming: LibIncoming): IrohIncoming {
  return {
    accept: async (): Promise<IrohAccepting> => {
      const accepting = await incoming.accept();
      return {
        alpn: async () => Buffer.from(await accepting.alpn()).toString('utf8'),
        connect: async () => wrapConnection(await accepting.connect()),
      };
    },
    refuse: () => incoming.refuse(),
  };
}

function wrapConnection(conn: LibConnection): IrohConnection {
  return {
    remoteId: conn.remoteId().toString(),
    acceptBi: async () => wrapBi(await conn.acceptBi()),
    acceptUni: async () => wrapRecv(await conn.acceptUni()),
    setMaxConcurrentBiStreams: (count) => { conn.setMaxConcurrentBiStreams(BigInt(count)); },
    setMaxConcurrentUniStreams: (count) => { conn.setMaxConcurrentUniStreams(BigInt(count)); },
    close: (code, reason) => { conn.close(BigInt(code), Array.from(Buffer.from(reason))); },
    closed: () => conn.closed(),
    watchSelectedPath: (callback) => watchSelectedPath(conn, callback),
    lostPackets: () => {
      try {
        return Number(conn.stats().lostPackets);
      } catch {
        return null;
      }
    },
  };
}

/** Fact 7: the callback gets `(error, value)`; a single argument is handled in case the binding changes. */
function watchValue(args: readonly unknown[]): unknown {
  return args.length >= 2 ? args[1] : args[0];
}

/** A relay path's address is the relay URL, a direct path's is `ip:port` (`transport_addr_to_string`, fact 13). */
const URL_ADDR = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Selected path of a connection (fact 13): the path selected now from `paths()`, then every `Selected` event of
 * `watchPathEvents`, with relay vs direct and the RTT read from `paths()`, because the event carries neither.
 * A `Lagged` event (the library dropped events, a switch may be among them) passes on with the path `paths()` shows
 * selected right after. Exported for the test of both callback shapes; the rest of the server goes through
 * `IrohConnection`.
 */
export function watchSelectedPath(
  conn: Pick<LibConnection, 'paths' | 'watchPathEvents'>, callback: (update: IrohPathUpdate) => void,
): IrohWatch {
  const listed = (): ReturnType<LibConnection['paths']> => {
    try {
      return conn.paths();
    } catch {
      return [];
    }
  };
  const handle = conn.watchPathEvents((...args: unknown[]) => {
    const event = watchValue(args) as
      | { kind?: unknown; id?: unknown; remoteAddr?: unknown; missed?: unknown } | null | undefined;
    if (event?.kind === 'Lagged') {
      const now = listed().find((candidate) => candidate.isSelected);
      callback({
        kind: 'lagged',
        missed: typeof event.missed === 'number' ? event.missed : null,
        path: now === undefined ? null : { relay: now.isRelay, remoteAddr: now.remoteAddr, rttMs: now.rttMs },
      });
      return;
    }
    if (event?.kind !== 'Selected') return;
    const path = listed().find((candidate) => candidate.id === event.id);
    const remoteAddr = path?.remoteAddr ?? (typeof event.remoteAddr === 'string' ? event.remoteAddr : 'unknown');
    const relay = path?.isRelay ?? URL_ADDR.test(remoteAddr);
    callback({ kind: 'selected', relay, remoteAddr, rttMs: path?.rttMs ?? null });
  });
  // The event stream does not replay the selection made during the handshake (fact 13): it comes from `paths()`.
  const current = listed().find((candidate) => candidate.isSelected);
  if (current !== undefined) {
    callback({ kind: 'initial', relay: current.isRelay, remoteAddr: current.remoteAddr, rttMs: current.rttMs });
  }
  return { stop: () => handle.stop() };
}

function wrapRecv(recv: LibRecvStream): IrohRecvStream {
  return { stop: (code) => recv.stop(BigInt(code)) };
}

function wrapBi(bi: LibBiStream): IrohBiStream {
  // The binding getter creates a new JS object on every read (the same stream underneath): we take it once.
  const send = bi.send;
  const recv = bi.recv;
  return {
    async read(max) {
      const bytes = await recv.read(max);
      return bytes.length === 0 ? null : Buffer.from(bytes); // fakt 2
    },
    async write(chunk) {
      for (let offset = 0; offset < chunk.length; offset += IROH_CHUNK) {
        await send.writeAll(Array.from(chunk.subarray(offset, offset + IROH_CHUNK))); // fakt 1
      }
    },
    finish: () => send.finish(),
    reset: (code) => send.reset(BigInt(code)),
    stop: (code) => recv.stop(BigInt(code)),
  };
}
