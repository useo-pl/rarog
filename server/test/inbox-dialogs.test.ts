/**
 * The dialog requests a session waits on (`server/src/inbox/dialogs.ts`), folded from session stream events: the
 * request a decision card stands for follows the manager's pick of `waitingFor`, a card from the screen or the
 * transcript before a consent channel card, and a consent card only while it waits for a person; and it is given only
 * when the summary's `waitingFor` describes the folded card.
 */
import { describe, expect, it } from 'vitest';
import type { PermissionRequest, ServerEvent, WaitingFor } from '@rarog/shared';
import { PendingDialogs } from '../src/inbox/dialogs.ts';

const SESSION = 's1';

/** What the session summary says of a `Bash` card with the command `command`. */
const bash = (command: string): WaitingFor => ({ kind: 'permission', tool: 'Bash', text: command, subject: 'tool' });
const PNPM_TEST = bash('pnpm test');

function permission(permId: string, consent?: PermissionRequest['state'], command = 'pnpm test'): ServerEvent {
  return {
    type: 'permission-pending',
    request: {
      permId, sessionId: SESSION, toolName: 'Bash', displayText: command, risk: 'normal', cwd: '/w',
      createdAt: '2026-11-20T10:00:00.000Z', ...(consent === undefined ? {} : { channel: 'hook' as const, state: consent }),
    },
  };
}

const resolved = (permId: string): ServerEvent => ({
  type: 'permission-resolved', sessionId: SESSION, permId, decision: 'allow', by: 'iPhone',
});

const settled = (permId: string, state: 'pending' | 'sent', canAllow = true): ServerEvent => ({
  type: 'permission-settled', sessionId: SESSION, permId, state, canAllow, at: '2026-11-20T10:00:01.000Z',
});

function fold(...events: ServerEvent[]): PendingDialogs {
  const dialogs = new PendingDialogs();
  for (const event of events) dialogs.note(SESSION, event);
  return dialogs;
}

describe('inbox dialogs: the request a decision card stands for', () => {
  it.each([
    ['the first of two screen cards', [permission('p1'), permission('p2')], 'p1'],
    ['the next screen card once the first is resolved', [permission('p1'), permission('p2'), resolved('p1')], 'p2'],
    ['a screen card before an earlier consent card', [permission('h1', 'pending'), permission('p1')], 'p1'],
    ['a consent card that waits for a person', [permission('h1', 'sent'), permission('h2', 'pending')], 'h2'],
    ['a consent card that went back to waiting', [permission('h1', 'sent'), settled('h1', 'pending')], 'h1'],
    ['no consent card that stopped waiting', [permission('h1', 'pending'), settled('h1', 'sent')], undefined],
    ['none once every card is resolved', [permission('p1'), resolved('p1')], undefined],
  ] as const)('a permission: %s', (_name, events, expected) => {
    expect(fold(...events).current(SESSION, 'permission', PNPM_TEST)).toBe(expected);
  });

  it('a question: the first one standing; another session and a forgotten session have none', () => {
    const question = (qId: string): ServerEvent => ({
      type: 'question-pending', request: { qId, sessionId: SESSION, questions: [], createdAt: '2026-11-20T10:00:00.000Z' },
    });
    const described: WaitingFor = { kind: 'question' };
    const dialogs = fold(question('q1'), question('q2'), { type: 'question-resolved', sessionId: SESSION, qId: 'q1' });
    expect(dialogs.current(SESSION, 'question', described)).toBe('q2');
    expect(dialogs.current('other', 'question', described)).toBeUndefined();
    dialogs.forget(SESSION);
    expect(dialogs.current(SESSION, 'question', described)).toBeUndefined();
  });
});

describe('inbox dialogs: the request only for the card the summary describes', () => {
  it('a summary that describes another card, or none, gives no request', () => {
    // The summary describes a consent card the fold never saw, one the server recovered at start.
    const dialogs = fold(permission('h2', 'pending', 'pnpm build'));
    expect(dialogs.current(SESSION, 'permission', bash('pnpm lint'))).toBeUndefined();
    expect(dialogs.current(SESSION, 'permission', { kind: 'permission', tool: 'Edit', text: 'pnpm build', subject: 'tool' }))
      .toBeUndefined();
    expect(dialogs.current(SESSION, 'permission', undefined)).toBeUndefined();
    expect(dialogs.current(SESSION, 'permission', bash('pnpm build'))).toBe('h2');
  });

  it('a consent card without its allow button has no text in the summary, and gets it back with the button', () => {
    const dialogs = fold(permission('h1', 'pending'), settled('h1', 'pending', false));
    expect(dialogs.current(SESSION, 'permission', { kind: 'permission', tool: 'Bash', subject: 'tool' })).toBe('h1');
    expect(dialogs.current(SESSION, 'permission', PNPM_TEST)).toBeUndefined();
    dialogs.note(SESSION, settled('h1', 'pending'));
    expect(dialogs.current(SESSION, 'permission', PNPM_TEST)).toBe('h1');
  });
});
