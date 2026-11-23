/**
 * Path log of one authenticated iroh connection (`docs/server-config.md`, "iroh listener"): a `server.log` line for
 * the path in use when it starts and for every switch between the relay and a direct address, with its RTT, and one
 * summary line at close with the time spent on each. At most {@link PATH_LINES_PER_CONNECTION} path lines per
 * connection, the rest only counted. No traffic content; it only reads what the library reports about paths.
 */
import type { IrohClock, IrohConnection, IrohPathUpdate, IrohSelectedPath, IrohWatch } from './endpoint.ts';

/** Path lines per connection: a connection that flaps between paths cannot flood `server.log`. */
export const PATH_LINES_PER_CONNECTION = 32;

/** Prefix of every path line (greppable in `server.log`). */
export const PATH_LOG_PREFIX = 'iroh: path';

export interface PathLog {
  /** Stops the watcher and writes the summary; later calls return the same promise. */
  close(): Promise<void>;
}

type Path = Omit<IrohSelectedPath, 'kind'>;

const seconds = (ms: number): string => String(Math.round(ms / 1000));

/** Path line: `direct <ip:port> rtt <n> ms` or `relay rtt <n> ms`. */
function describePath(path: Path): string {
  const rtt = path.rttMs === null ? 'rtt n/a' : `rtt ${String(path.rttMs)} ms`;
  return path.relay ? `relay ${rtt}` : `direct ${path.remoteAddr} ${rtt}`;
}

/**
 * Starts the path log of `conn`; the listener calls it when the connection first authenticates. `short` is the
 * 12-character EndpointId of the client. A switch is a `selected` change reported by the library, or a `lagged`
 * update whose selected path differs from the current one; the path in use at the start (`initial`) is not one.
 * After a `lagged` update the summary ends with `lagged <missed>` (`?` when the library did not say how many).
 */
export function startPathLog(
  conn: Pick<IrohConnection, 'watchSelectedPath' | 'lostPackets'>, short: string, log: (line: string) => void,
  clock: IrohClock,
): PathLog {
  const startedAt = clock.now();
  let current: { relay: boolean; remoteAddr: string; since: number } | null = null;
  let directMs = 0;
  let relayMs = 0;
  let switches = 0;
  let lines = 0;
  let suppressed = 0;
  /** Sum of `missed` over `lagged` updates; `null` = none; `NaN` = a count was unknown. */
  let lagged: number | null = null;
  let done: Promise<void> | null = null;

  const settle = (at: number): void => {
    if (current === null) return;
    if (current.relay) relayMs += at - current.since;
    else directMs += at - current.since;
  };

  const enter = (path: Path, isSwitch: boolean): void => {
    const at = clock.now();
    settle(at);
    current = { relay: path.relay, remoteAddr: path.remoteAddr, since: at };
    if (isSwitch) switches += 1;
    if (lines < PATH_LINES_PER_CONNECTION) {
      lines += 1;
      log(`${PATH_LOG_PREFIX} ${short} ${describePath(path)}`);
    } else {
      suppressed += 1;
    }
  };

  const onUpdate = (update: IrohPathUpdate): void => {
    if (done !== null) return;
    if (update.kind !== 'lagged') {
      enter(update, update.kind === 'selected');
      return;
    }
    // Dropped events may hide a switch: the path selected now decides, compared with the one we hold.
    lagged = (lagged ?? 0) + (update.missed ?? Number.NaN);
    const now = update.path;
    if (now !== null && (current === null || now.relay !== current.relay || now.remoteAddr !== current.remoteAddr)) {
      enter(now, current !== null);
    }
  };
  let watch: IrohWatch;
  try {
    watch = conn.watchSelectedPath(onUpdate);
  } catch {
    // A connection closed before the watcher started: the summary still comes, without paths.
    watch = { stop: async () => {} };
  }

  return {
    close(): Promise<void> {
      if (done !== null) return done;
      const at = clock.now();
      settle(at);
      current = null;
      let stopping: Promise<void>;
      try {
        stopping = watch.stop();
      } catch {
        stopping = Promise.resolve();
      }
      done = stopping.catch(() => {});
      const lost = conn.lostPackets();
      log(`${PATH_LOG_PREFIX} ${short} summary ${seconds(at - startedAt)} s: direct ${seconds(directMs)} s,`
        + ` relay ${seconds(relayMs)} s, switches ${String(switches)},`
        + ` lost packets ${lost === null ? 'n/a' : String(lost)}`
        + (suppressed > 0 ? `, suppressed ${String(suppressed)}` : '')
        + (lagged === null ? '' : `, lagged ${Number.isNaN(lagged) ? '?' : String(lagged)}`));
      return done;
    },
  };
}
