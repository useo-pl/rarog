/**
 * The demo's Inbox sources: the session manager as the card tracker sees it, with an engine conversation for every
 * demo session; the segments of a demo session read from the session's events in the server's memory (the ring of
 * its stream) instead of a conversation file; and the dialog events the seeds put into those rings before the
 * tracker listened. The tracker, its removals and the routes stay those of the real server. Loaded only in demo mode;
 * it writes nothing and keeps nothing between reads.
 */
import type { ServerEvent, TranscriptMessage } from '@rarog/shared';
import { segmentByInput } from '../herdr/input-segments.ts';
import type { SegmentEntry } from '../herdr/input-segments.ts';
import type { Inbox, InboxPort, SegmentReader, SegmentsRead } from '../inbox/index.ts';
import type { ManagerApi } from '../sessions/manager-api.ts';
import { demoBlocks } from './seeds.ts';

/** What the demo sources read from the session manager; none of it marks anything as shown. */
export type DemoInboxPort = Pick<ManagerApi, 'list' | 'companionTarget' | 'eventsSince'>;

/** The session manager the tracker and the demo sources get in the demo. */
export type DemoInboxManager = InboxPort & Pick<ManagerApi, 'onEvent' | 'onConversationChange' | 'eventsSince'>;

/**
 * The session manager with an engine conversation for every demo session in scope: a seed without a live driver
 * (a session that hit its limit, say) has none, and the tracker gives a session without one no card. The made-up
 * conversation is the session id behind a prefix; nothing outside the demo Inbox sees it.
 */
export function demoInboxManager(manager: DemoInboxManager): DemoInboxManager {
  return {
    get: manager.get.bind(manager),
    list: manager.list.bind(manager),
    companionTarget: (id) => {
      const target = manager.companionTarget(id);
      return target === null || target.agentSessionId !== undefined
        ? target : { ...target, agentSessionId: `demo-conversation-${id}` };
    },
    markSeen: manager.markSeen.bind(manager),
    markUnseen: manager.markUnseen.bind(manager),
    onEvent: manager.onEvent.bind(manager),
    onConversationChange: manager.onConversationChange.bind(manager),
    eventsSince: manager.eventsSince.bind(manager),
  };
}

/** The dialog events of a session stream the tracker folds for the identity of a decision card's dialog. */
const DIALOG_EVENTS: ReadonlySet<ServerEvent['type']> = new Set([
  'permission-pending', 'permission-settled', 'permission-resolved', 'question-pending', 'question-resolved',
]);

/**
 * Segments of the demo session that writes the engine conversation `agentSessionId`, from the `message` events of
 * its ring. The opening entry of a turn has no file entry id, so a turn is keyed by its time and text: the seeds get
 * new times at every start, so a removal made before a demo restart matches no card after it. A ring that already
 * dropped its first events reads as `unreadable`, and the card keeps the turn it showed.
 */
export function createDemoSegmentReader(manager: DemoInboxPort): SegmentReader {
  return (_cwd, agentSessionId) => Promise.resolve(readDemoSegments(manager, agentSessionId));
}

function readDemoSegments(manager: DemoInboxPort, agentSessionId: string): SegmentsRead {
  const sessionId = manager.list().find((session) => conversationOf(manager, session.id) === agentSessionId)?.id;
  if (sessionId === undefined) return { kind: 'no-file' };
  const replay = manager.eventsSince(sessionId, 0);
  if (replay.tooOld) return { kind: 'unreadable' };
  const entries = replay.events.flatMap(({ event }) => (event.type === 'message' ? [entryOf(event.message)] : []));
  return { kind: 'read', segments: segmentByInput(agentSessionId, entries).segments, wholeFile: true };
}

function conversationOf(manager: DemoInboxPort, sessionId: string): string | undefined {
  try {
    return manager.companionTarget(sessionId)?.agentSessionId;
  } catch {
    return undefined;
  }
}

function entryOf(message: TranscriptMessage): SegmentEntry {
  return {
    role: message.role, blocks: demoBlocks(message.blocks), at: message.at,
    ...(message.notice === undefined ? {} : { notice: message.notice }),
  };
}

/**
 * Hands the tracker the dialog events already in the rings of the demo sessions: the seeds register their permission
 * cards while the manager is built, before the tracker listens, so without them a demo decision card would have no
 * request id. The ring holds every dialog event in order, so a repeated event folds to the same state.
 */
export function replayDemoDialogs(manager: Pick<ManagerApi, 'list' | 'eventsSince'>, inbox: Pick<Inbox, 'noteEvent'>): void {
  for (const session of manager.list()) {
    for (const { event } of manager.eventsSince(session.id, 0).events) {
      if (DIALOG_EVENTS.has(event.type)) inbox.noteEvent(session.id, event);
    }
  }
}
