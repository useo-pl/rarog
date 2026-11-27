/**
 * Server start: the PR status (`docs/pull-requests.md`). The tracker with its state source and the port the session
 * manager gets (`sessions/pr-status-link.ts`); `main()` closes it at shutdown and feeds it the SSE client count.
 *
 * Real mode asks GitHub through `gh` with the server environment cut to the closed list, only while a client is
 * connected; the demo and its review mode answer from a fixed map and never create the `gh` source (no process, no
 * program lookup). `RAROG_PR_STATUS=0` gives no tracker at all.
 */
import type { RarogConfig } from '../config.ts';
import type { DemoContent } from '../demo/content/types.ts';
import { createFixedPrStateSource, createGhSource, createPrStatusTracker } from '../pr-status/index.ts';
import type {
  GhSourceOptions, PrStateSource, PrStatusChange, PrStatusTracker, PrStatusTrackerOptions,
} from '../pr-status/index.ts';
import type { Logger } from '../router.ts';
import type { PrStatusPort } from '../sessions/pr-status-link.ts';

export interface PrStatusLink {
  readonly tracker: PrStatusTracker;
  /** The manager's port: the tracker's reads and writes plus the one listener of state changes. */
  readonly port: PrStatusPort;
}

/** Tracker and port over a source; the change callback goes to the listener the manager registers. */
export function createPrStatusLink(
  opts: Pick<PrStatusTrackerOptions, 'source' | 'scheduler' | 'log' | 'newUrlDelayMs'>,
): PrStatusLink {
  let listener: ((change: PrStatusChange) => void) | null = null;
  const tracker = createPrStatusTracker({ ...opts, onChange: (change) => { listener?.(change); } });
  return {
    tracker,
    port: {
      stateOf: (url) => tracker.stateOf(url),
      factsOf: (url) => tracker.factsOf(url),
      viewerLogin: () => tracker.viewerLogin(),
      setSessionUrls: (sessionId, urls) => { tracker.setSessionUrls(sessionId, urls); },
      setSessionLinks: (sessionId, urls) => { tracker.setSessionLinks(sessionId, urls); },
      dropSession: (sessionId) => { tracker.dropSession(sessionId); },
      listen: (onChange) => { listener = onChange; },
    },
  };
}

export interface PrStatusDeps {
  /** The `gh` source factory; a test seam. Default {@link createGhSource}. */
  readonly ghSource?: (opts: GhSourceOptions) => PrStateSource;
}

/**
 * The PR status of this process, or `null` when `RAROG_PR_STATUS=0`. The demo source is the fixed GitHub of the
 * active content set (`demoContent`, `null` outside the demo; states, titles, authors, the demo login) read without
 * delay and without a connected client, so a demo list gets its facts and state at once; it is loaded lazily, like
 * the rest of the demo content.
 */
export async function createPrStatus(
  config: Pick<RarogConfig, 'demo' | 'prStatusEnabled' | 'prStatusEnvBase'>, log: Logger,
  demoContent: DemoContent | null, deps: PrStatusDeps = {},
): Promise<PrStatusLink | null> {
  if (!config.prStatusEnabled) return null;
  const logLine = (line: string): void => { log.info(line); };
  if (config.demo) {
    if (demoContent === null) throw new Error('createPrStatus: demo mode requires demoContent');
    const { demoGitHub } = await import('../demo/seeds.ts');
    const link = createPrStatusLink({
      source: createFixedPrStateSource(demoGitHub(demoContent)), log: logLine, newUrlDelayMs: 0,
    });
    // The fixed map starts no process: it is read whatever the client count, so a scenario created before the app
    // connects has its list at once.
    link.tracker.setClientConnected(true);
    return { ...link, tracker: { ...link.tracker, setClientConnected: () => undefined } };
  }
  const ghSource = deps.ghSource ?? createGhSource;
  return createPrStatusLink({ source: ghSource({ env: { ...config.prStatusEnvBase } }), log: logLine });
}
