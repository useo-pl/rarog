/**
 * Server start: the Inbox (`server/src/inbox/`). It joins the session manager's event stream and conversation
 * changes to the card tracker and reads every session's card once after the manager is ready. It works without push
 * notifications; `main()` in `server/src/index.ts` calls it after creating the manager and before `ready` settles.
 */
import { defaultStoreRoot } from '../cli-store.ts';
import { HERDR_HISTORY_MESSAGES } from '../config.ts';
import { HISTORY_MAX_BYTES } from '../herdr/jsonl-follow.ts';
import { locateTranscript } from '../herdr/transcript-path.ts';
import { Inbox, createSegmentReader } from '../inbox/index.ts';
import type { InboxPort } from '../inbox/index.ts';
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
  /** Tests: a shorter quiet time and the duration of every card read. */
  readonly debounceMs?: number;
  readonly timing?: (sessionId: string, ms: number) => void;
}

export function startInbox(deps: InboxDeps): Inbox {
  const { manager } = deps;
  const inbox = new Inbox({
    dataDir: deps.dataDir,
    readSegments: createSegmentReader({
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
