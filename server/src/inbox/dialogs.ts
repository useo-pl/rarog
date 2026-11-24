/**
 * The dialog requests each session waits on, folded from the session manager's events (`permission-pending`,
 * `permission-settled`, `permission-resolved`, `question-pending`, `question-resolved`): which request a decision card
 * stands for. The manager keeps its queue of requests to itself and its transcript read marks consent cards as shown
 * on a device, so the Inbox folds the events every device gets. It keeps request ids, states, buttons and a digest of
 * what the session summary's `waitingFor` would say of each request, never their text.
 */
import { createHash } from 'node:crypto';
import { EXIT_PLAN_MODE_TOOL, WAITING_TEXT_MAX } from '@rarog/shared';
import type { ConsentCardState, PermissionRequest, PermissionSubject, ServerEvent, WaitingFor } from '@rarog/shared';
import { summarizeToolInput } from '../drivers/tool-summary.ts';
import type { DialogRequest } from './card.ts';

/** What the session summary's `waitingFor` would say of a permission request. */
interface Said {
  readonly tool: string;
  readonly subject: PermissionSubject;
  /** {@link digestOf} the summary's text line of the request while it may be allowed. */
  readonly text: string;
}

interface PermissionEntry {
  /** A consent channel card. */
  readonly hook: boolean;
  /** It waits for a person. */
  open: boolean;
  /**
   * `undefined`: a consent card known only from `permission-settled`, which carries neither its tool nor its text: a
   * card the server recovered at start and a snapshot showed before its first change. It never gives its id.
   */
  readonly said: Said | undefined;
  /** `false`: no allow button, and the summary carries no text for the request. */
  canAllow: boolean;
  /** A consent card's state and why it has no allow button, as the last event of the card said. */
  state: ConsentCardState | undefined;
  unavailable: PermissionRequest['unavailable'];
}

interface QuestionEntry {
  /** {@link digestOf} the summary's text line: the first question. */
  readonly text: string;
  readonly count: number;
}

interface Requests {
  /** Permission requests in the order they came. */
  readonly permissions: Map<string, PermissionEntry>;
  readonly questions: Map<string, QuestionEntry>;
}

export class PendingDialogs {
  readonly #sessions = new Map<string, Requests>();

  /** One event of a session's stream; events of other types change nothing. */
  note(sessionId: string, event: ServerEvent): void {
    switch (event.type) {
      case 'permission-pending': {
        const { request } = event;
        const hook = request.channel !== undefined;
        this.#of(sessionId).permissions.set(request.permId, {
          hook, open: !hook || request.state === 'pending',
          said: {
            tool: request.toolName,
            subject: request.subject ?? (request.toolName === EXIT_PLAN_MODE_TOOL ? 'plan' : 'tool'),
            text: digestOf(permissionLine(request)),
          },
          canAllow: request.canAllow !== false, state: request.state, unavailable: request.unavailable,
        });
        return;
      }
      case 'permission-settled': {
        const permissions = this.#of(sessionId).permissions;
        const entry = permissions.get(event.permId);
        if (entry === undefined) {
          // Only a consent card changes in place; one the fold never saw pending still holds its place.
          permissions.set(event.permId, {
            hook: true, open: event.state === 'pending', said: undefined, canAllow: event.canAllow, state: event.state,
            unavailable: event.unavailable,
          });
          return;
        }
        entry.open = !entry.hook || event.state === 'pending';
        entry.canAllow = event.canAllow;
        entry.state = event.state;
        entry.unavailable = event.unavailable;
        return;
      }
      case 'permission-resolved':
        this.#sessions.get(sessionId)?.permissions.delete(event.permId);
        return;
      case 'question-pending': {
        const { questions } = event.request;
        this.#of(sessionId).questions.set(event.request.qId, {
          text: digestOf(oneLine(questions[0]?.question ?? '')), count: questions.length,
        });
        return;
      }
      case 'question-resolved':
        this.#sessions.get(sessionId)?.questions.delete(event.qId);
        return;
      default:
        return;
    }
  }

  /**
   * The request the session summary's `waitingFor` of `kind` describes, by the manager's own pick: the first card from
   * the screen or the transcript, else the first consent card that waits for a person; the first question. It is
   * given only when `waitingFor` says of it what the summary says (tool, subject, text line, question count): the
   * fold lacks a consent card the server recovered at start, before anyone listened, and would otherwise give the id
   * of the card behind it. A consent card known only from a change cannot be compared, so it gives no id either.
   * `undefined` = the fold has none, or another card than the one `waitingFor` describes.
   */
  current(sessionId: string, kind: 'permission' | 'question', waitingFor: WaitingFor | undefined): string | undefined {
    const requests = this.#sessions.get(sessionId);
    if (requests === undefined || waitingFor?.kind !== kind) return undefined;
    const text = digestOf(waitingFor.text ?? '');
    if (kind === 'question') {
      const [id, question] = requests.questions.entries().next().value ?? [];
      const count = question === undefined ? undefined : question.count > 1 ? question.count : undefined;
      return question !== undefined && question.text === text && count === waitingFor.count ? id : undefined;
    }
    const permissions = [...requests.permissions];
    const [id, permission] = permissions.find(([, p]) => !p.hook) ?? permissions.find(([, p]) => p.hook && p.open) ?? [];
    const said = permission?.said;
    if (said === undefined || waitingFor.count !== undefined) return undefined;
    const line = permission?.canAllow === true ? said.text : digestOf('');
    return said.tool === waitingFor.tool && said.subject === waitingFor.subject && line === text ? id : undefined;
  }

  /**
   * The {@link current} request with the revision of its state and buttons: for a consent card an opaque digest of
   * `state`, `canAllow` and `unavailable`, which `permission-settled` changes in place; none for a card from the
   * screen or the transcript and for a question, which do not change in place.
   */
  request(sessionId: string, kind: 'permission' | 'question', waitingFor: WaitingFor | undefined): DialogRequest | undefined {
    const id = this.current(sessionId, kind, waitingFor);
    if (id === undefined) return undefined;
    const entry = kind === 'permission' ? this.#sessions.get(sessionId)?.permissions.get(id) : undefined;
    if (entry === undefined || !entry.hook) return { id };
    return { id, revision: digestOf(JSON.stringify([entry.state ?? '', entry.canAllow, entry.unavailable ?? ''])) };
  }

  forget(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  #of(sessionId: string): Requests {
    let requests = this.#sessions.get(sessionId);
    if (requests === undefined) {
      requests = { permissions: new Map(), questions: new Map() };
      this.#sessions.set(sessionId, requests);
    }
    return requests;
  }
}

/**
 * The text line the session summary gives a permission request that may be allowed: a plan has none; a description
 * that is a JSON input gives the input's summary (path, pattern, URL, query) or nothing; anything else its first line.
 * It mirrors the session manager's derivation of `waitingFor.text`, which this module cannot import; a drift gives no
 * request id, so the card falls back to the identity the summary gives it.
 */
function permissionLine(request: PermissionRequest): string {
  if (request.toolName === EXIT_PLAN_MODE_TOOL) return '';
  const display = request.displayText;
  const first = display.split('\n', 1)[0]?.trim() ?? '';
  if (first !== '{' && first !== '{}' && first !== '[') return oneLine(display);
  let parsed: unknown;
  try {
    parsed = JSON.parse(display);
  } catch {
    // A description clipped with a footer is no longer JSON.
    return '';
  }
  const summary = summarizeToolInput(request.toolName, parsed);
  return summary === request.toolName ? '' : oneLine(summary);
}

/** The first line, trimmed and cut to {@link WAITING_TEXT_MAX} code points with `…`, as the summary carries it. */
function oneLine(raw: string): string {
  const first = raw.split('\n', 1)[0]?.trim() ?? '';
  const points = [...first];
  if (points.length <= WAITING_TEXT_MAX) return first;
  return `${points.slice(0, WAITING_TEXT_MAX).join('').trimEnd()}…`;
}

function digestOf(text: string): string {
  return createHash('sha256').update(text).digest('base64url');
}
