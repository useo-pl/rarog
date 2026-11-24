/**
 * Server start: the Inbox (`server/src/inbox/`). It joins the session manager's event stream and conversation
 * changes to the card tracker, reads every session's card once after the manager is ready, and puts the heads
 * publisher for the stream on the tracker. In demo mode the segments come from the demo sessions' events
 * (`demo/inbox.ts`) and the removals go to `inbox.json` of the demo data directory. It works without push
 * notifications; `main()` in `server/src/index.ts` calls {@link assembleInbox} after creating the manager and before
 * `ready` settles.
 */
import { defaultStoreRoot } from '../cli-store.ts';
import { HERDR_HISTORY_MESSAGES } from '../config.ts';
import type { RarogConfig } from '../config.ts';
import { HISTORY_MAX_BYTES } from '../herdr/jsonl-follow.ts';
import { locateTranscript } from '../herdr/transcript-path.ts';
import { Inbox, InboxHeads, createSegmentReader } from '../inbox/index.ts';
import type { InboxPort, SegmentReader } from '../inbox/index.ts';
import type { ManagerApi } from '../sessions/manager-api.ts';

export interface InboxDeps {
  readonly manager: InboxPort & Pick<ManagerApi, 'onEvent' | 'onConversationChange'>;
  /** Settles when the manager has adopted the panes it found at the start. */
  readonly ready: Promise<void>;
  readonly dataDir: string;
  /** `RAROG_PROMPT_BLOCK`, as for the session history. */
  readonly promptBlock: boolean;
  readonly log: (line: string) => void;
  /** Conversation file of an engine conversation; default the Claude Code store. */
  readonly locate?: (cwd: string, agentSessionId: string) => Promise<string | null>;
  /** Segments of a conversation; default the conversation file through {@link locate}. */
  readonly readSegments?: SegmentReader;
  /** Tests: a shorter quiet time and the duration of every card read. */
  readonly debounceMs?: number;
  readonly timing?: (sessionId: string, ms: number) => void;
}

export function startInbox(deps: InboxDeps): Inbox {
  const { manager } = deps;
  const inbox = new Inbox({
    dataDir: deps.dataDir,
    readSegments: deps.readSegments ?? createSegmentReader({
      locate: deps.locate ?? ((cwd, agentSessionId) => locateTranscript(defaultStoreRoot(), cwd, agentSessionId)),
      promptBlock: deps.promptBlock,
      limit: HERDR_HISTORY_MESSAGES,
      maxBytes: HISTORY_MAX_BYTES,
    }),
    log: deps.log,
    ...(deps.debounceMs === undefined ? {} : { debounceMs: deps.debounceMs }),
    ...(deps.timing === undefined ? {} : { timing: deps.timing }),
  }, manager);
  manager.onEvent((scope, _seq, event) => { inbox.noteEvent(scope, event); });
  manager.onConversationChange((sessionId) => { inbox.noteConversation(sessionId); });
  void deps.ready.then(() => { inbox.refreshAll(); }, () => undefined);
  return inbox;
}

/** The tracker and the heads publisher the stream and the routes get. */
export interface InboxAssembly {
  readonly inbox: Inbox;
  readonly heads: InboxHeads;
}

export interface InboxAssemblyDeps extends Pick<InboxDeps, 'ready' | 'log' | 'locate' | 'debounceMs'> {
  readonly config: Pick<RarogConfig, 'inboxEnabled' | 'demo' | 'dataDir' | 'promptBlock'>;
  readonly manager: InboxDeps['manager'] & Pick<ManagerApi, 'eventsSince'>;
}

/**
 * The Inbox of this start: `null` with `RAROG_INBOX=0` (no tracker, no heads, the routes answer 503, `inbox.json`
 * untouched). The heads publisher subscribes to the tracker at once, before the first card read, so it holds every
 * visible card when the first stream opens.
 */
export async function assembleInbox(deps: InboxAssemblyDeps): Promise<InboxAssembly | null> {
  const { config, manager } = deps;
  if (!config.inboxEnabled) return null;
  const demo = config.demo ? await import('../demo/inbox.ts') : null;
  const port = demo === null ? manager : demo.demoInboxManager(manager);
  const inbox = startInbox({
    manager: port, ready: deps.ready, dataDir: config.dataDir, promptBlock: config.promptBlock, log: deps.log,
    ...(demo === null ? {} : { readSegments: demo.createDemoSegmentReader(port) }),
    ...(deps.locate === undefined ? {} : { locate: deps.locate }),
    ...(deps.debounceMs === undefined ? {} : { debounceMs: deps.debounceMs }),
  });
  const heads = new InboxHeads(inbox);
  if (demo !== null) void deps.ready.then(() => { demo.replayDemoDialogs(port, inbox); }, () => undefined);
  return { inbox, heads };
}
