/**
 * The Inbox card of one session, in two pure parts: the turn whose text the card shows, from the segments of the
 * conversation file the session writes now (`herdr/input-segments.ts`), and the card composed from that turn and the
 * session summary: the kind by the session state, the dialog, the version and the key a removal is stored under. It
 * reads no file and keeps no state; the tracker in `inbox.ts` keeps the shown turn between reads.
 */
import { createHash } from 'node:crypto';
import type { KnownDialogId, RefuseReason, SessionState, SessionSummary, WaitingFor } from '@rarog/shared';
import type { InputSegment } from '../herdr/input-segments.ts';
import { DECISION_STATES, WORKING_STATES } from '../sessions/state-sentences.ts';

/** `result`: the turn ended with a result; `decision`: the turn waits for a person; `failed`: the turn stopped. */
export type InboxCardKind = 'result' | 'decision' | 'failed';

/**
 * The decision a `decision` card waits for, as the session summary carries it: a permission or question card
 * (`waitingFor`, and `requestId`, the `permId` or `qId` of that card in the session stream), or a dialog in the pane
 * without a card (`herdrDialog` when Rarog recognises it, `herdrDialogReason` why it has no buttons). The card does
 * not carry the full pending card of the session stream: reading it (`ManagerApi.transcript`) marks the consent cards
 * it returns as shown on a device, which is true only when the card is delivered to one.
 */
export type InboxDialog =
  | { readonly kind: 'permission' | 'question'; readonly waitingFor?: WaitingFor; readonly requestId?: string }
  | { readonly kind: 'panel'; readonly herdrDialog?: KnownDialogId; readonly herdrDialogReason?: RefuseReason };

/**
 * The request id of the card a session's `waitingFor` of `kind` describes (`PendingDialogs.current`); `undefined` when
 * the card is not known for sure to be the one `waitingFor` describes.
 */
export type RequestOf = (kind: 'permission' | 'question', waitingFor: WaitingFor | undefined) => string | undefined;

export interface InboxCard {
  readonly sessionId: string;
  /** Opaque identity of the turn whose text the card shows ({@link InputSegment.turnId}). */
  readonly turnId: string;
  /**
   * Opaque version of the card: the segment's version (late text of the same turn changes it), the kind, the
   * identity of a decision's dialog and the moment the session entered a failure state. A request built from an
   * older card does not match.
   */
  readonly version: string;
  readonly kind: InboxCardKind;
  /** State of the session when the card was computed; in `starting` and `running` the app hides the card. */
  readonly state: SessionState;
  /** `result`: the last assistant entry of the turn; `decision` and `failed`: when the session entered the state. */
  readonly at: string;
  readonly text: string;
  /** The text lost its start to the segment ceiling. */
  readonly truncated: boolean;
  /** Present on a `decision` card only. */
  readonly dialog?: InboxDialog;
}

/**
 * What a removal of a card is stored under: the turn for a result; the turn, the dialog kind and the dialog's identity
 * for a decision; the turn and the moment of the failure for a failed card. A removed result therefore hides neither a
 * later decision nor a later failure that shows the same turn's text, and a removed decision does not hide the next
 * dialog of the same turn.
 */
export interface RemovalKey {
  readonly turnId: string;
  readonly card: InboxCardKind;
  /** `decision` only. */
  readonly dialog?: InboxDialog['kind'];
  /** `decision` only: opaque digest of the dialog's identity ({@link dialogIdOf}). */
  readonly dialogId?: string;
  /** `failed` only: {@link InboxCard.at}. */
  readonly since?: string;
}

const FAILED_STATES: readonly SessionState[] = ['error', 'limit-reached', 'interrupted'];

/** Card kind of a session state; `null` for a closed session (`done`, `resumable`). */
export function cardKindOf(state: SessionState): InboxCardKind | null {
  if (state === 'waiting-input' || WORKING_STATES.includes(state)) return 'result';
  if (DECISION_STATES.includes(state)) return 'decision';
  if (FAILED_STATES.includes(state)) return 'failed';
  return null;
}

/** A segment whose text can stand on a card: it leaves a result and has text. */
export function showsResult(segment: InputSegment): boolean {
  return segment.withResult && segment.text !== '';
}

/** The turn whose text a card shows: what the card takes from the conversation file. */
export interface ShownTurn {
  readonly turnId: string;
  /** {@link InputSegment.version}: late text of the turn changes it. */
  readonly version: string;
  readonly text: string;
  readonly truncated: boolean;
  /** The last assistant entry of the turn, or its opening when it has none. */
  readonly at: string;
}

function shownTurnOf(segment: InputSegment): ShownTurn {
  return {
    turnId: segment.turnId, version: segment.version, text: segment.text, truncated: segment.truncated,
    at: segment.lastAssistantAt ?? segment.openedAt,
  };
}

/**
 * The turn a card of `kind` shows, or `undefined` when there is none.
 *
 * The text is the last segment that leaves a result and has text, so a turn without a result (an artifact notice, a
 * subagent standby) and a result turn without text (a manual `/compact`) keep the previous card. A decision or a
 * failure with no such segment yet shows the last segment (its text may be empty); a result with none has no card,
 * as a conversation right after `/clear` or `/resume`.
 *
 * @param segments segments of the conversation file in file order (`readInputSegments`)
 */
export function shownTurnFor(kind: InboxCardKind, segments: readonly InputSegment[]): ShownTurn | undefined {
  const segment = segments.findLast(showsResult) ?? (kind === 'result' ? undefined : segments.at(-1));
  return segment === undefined ? undefined : shownTurnOf(segment);
}

/** Whether a session can have a card at all: an open Claude session in scope. */
function carded(session: SessionSummary): InboxCardKind | null {
  if (session.engine === 'codex' || session.outOfScope === true) return null;
  return cardKindOf(session.state);
}

/**
 * The card of a session over the turn it shows, or `null` when it has none.
 *
 * @param requestOf the card id behind the summary's `waitingFor`; none = the dialog is known by its summary only
 */
export function composeCard(
  session: SessionSummary, shown: ShownTurn | undefined, requestOf: RequestOf = () => undefined,
): InboxCard | null {
  const kind = carded(session);
  if (kind === null || shown === undefined) return null;
  const at = kind === 'result' ? shown.at : session.stateSince;
  const dialog = kind === 'decision' ? dialogOf(session, requestOf) : undefined;
  const key: RemovalKey = keyOf(shown.turnId, kind, dialog, at);
  return {
    sessionId: session.id,
    turnId: shown.turnId,
    version: digest([shown.version, kind, key.dialog ?? '', key.dialogId ?? '', key.since ?? '']),
    kind,
    state: session.state,
    at,
    text: shown.text,
    truncated: shown.truncated,
    ...(dialog === undefined ? {} : { dialog }),
  };
}

/** The removal key of a card. */
export function removalKeyOf(card: InboxCard): RemovalKey {
  return keyOf(card.turnId, card.kind, card.dialog, card.at);
}

function keyOf(turnId: string, kind: InboxCardKind, dialog: InboxDialog | undefined, at: string): RemovalKey {
  if (kind === 'result') return { turnId, card: kind };
  if (kind === 'failed') return { turnId, card: kind, since: at };
  if (dialog === undefined) return { turnId, card: kind };
  return { turnId, card: kind, dialog: dialog.kind, dialogId: dialogIdOf(dialog) };
}

/**
 * Opaque identity of a decision's dialog, the same live and after a server restart, never the moment the session
 * entered its state (a restart moves that): the id of the permission or question card; without one, what the summary
 * says of the card (`waitingFor`); for a dialog without a card, the recognised dialog and why it has no buttons, set
 * and cleared with the card (not the screen snippet, which a refresh replaces under the same card). It is a digest
 * because it is stored in `inbox.json`, which holds no content.
 */
function dialogIdOf(dialog: InboxDialog): string {
  if (dialog.kind === 'panel') return digest(['panel', dialog.herdrDialog ?? '', dialog.herdrDialogReason ?? '']);
  if (dialog.requestId !== undefined) return digest([dialog.kind, 'request', dialog.requestId]);
  return digest([dialog.kind, 'summary', JSON.stringify(dialog.waitingFor ?? null)]);
}

function dialogOf(session: SessionSummary, requestOf: RequestOf): InboxDialog {
  const waiting = session.waitingFor;
  const kind = waiting?.kind ?? (session.state === 'waiting-question' ? 'question' : undefined);
  if (kind === undefined) {
    return {
      kind: 'panel',
      ...(session.herdrDialog === undefined ? {} : { herdrDialog: session.herdrDialog }),
      ...(session.herdrDialogReason === undefined ? {} : { herdrDialogReason: session.herdrDialogReason }),
    };
  }
  const requestId = requestOf(kind, waiting);
  return {
    kind,
    ...(waiting === undefined ? {} : { waitingFor: waiting }),
    ...(requestId === undefined ? {} : { requestId }),
  };
}

/** Opaque hash of the parts; the JSON array keeps the parts apart. */
function digest(parts: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('base64url').slice(0, 22);
}
