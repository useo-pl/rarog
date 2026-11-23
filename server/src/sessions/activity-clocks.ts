/**
 * Clocks of the activity row: the start of the current turn (`SessionSummary.turnSince`) and the age of the activity
 * the session holds (`elapsedSeconds` in summaries and transcript snapshots). Functions over one session: the manager
 * calls them at a state change and when it sets or reads the held activity, the history import when it moves
 * `stateSince` back. This module decides no transition and sends nothing; live `activity` frames go out unchanged.
 */
import type { Activity, SessionState } from '@rarog/shared';
import type { Session } from './session.ts';
import { inTurn } from './state-sentences.ts';

/**
 * Stamps a state change that already happened (`from` → `session.state`) at `at` (ISO): `stateSince`,
 * `lastActivityAt` and the turn start. Entering a turn from outside starts it at `at`, a move inside the turn
 * (permission, question, back to work) keeps it, leaving the turn clears it. A session first seen inside a turn has
 * no known start: its first move inside the turn takes the start of the state it leaves, the earliest moment the
 * server saw that turn. Until then the field is absent and the app counts from `stateSince`, the same moment.
 */
export function stampState(session: Session, from: SessionState, at: string): void {
  if (!inTurn(session.state)) session.turnSince = undefined;
  else if (!inTurn(from)) session.turnSince = at;
  else session.turnSince ??= session.stateSince;
  session.stateSince = at;
  session.lastActivityAt = at;
}

/**
 * The history import moved `stateSince` back to `at` (ISO), the last sign of life in the file: the turn began no
 * later than the state the session is in, so a later turn start follows it.
 */
export function backdateState(session: Session, at: string): void {
  session.stateSince = at;
  if (session.turnSince !== undefined && Date.parse(session.turnSince) > Date.parse(at)) session.turnSince = at;
}

/** Holds the activity the manager sends (`null` clears it) and the moment it set it (ms, manager clock). */
export function holdActivity(session: Session, activity: Activity | null, atMs: number): void {
  session.activity = activity;
  session.activityAtMs = atMs;
}

/**
 * The held activity for a summary or a snapshot built at `nowMs`, or `undefined` without one. `elapsedSeconds` grows
 * by the whole seconds since the server set it, on top of the silence the session pulse already measured, so the
 * "still running" and quiet clocks survive a reconnect. Under a second (or with a clock behind the activity) it goes
 * as it was sent, so a summary built right after the activity has no `elapsedSeconds: 0`.
 */
export function heldActivity(session: Session, nowMs: number): Activity | undefined {
  const { activity, activityAtMs } = session;
  if (activity === null) return undefined;
  const age = activityAtMs === undefined ? 0 : Math.floor((nowMs - activityAtMs) / 1000);
  if (age <= 0) return activity;
  return { ...activity, elapsedSeconds: (activity.elapsedSeconds ?? 0) + age };
}
