/**
 * The rule of a consent without a hook (`herdr/dialogs/no-hook.ts`): the cause from the session facts, in the
 * contract's order, the two log lines with values that never carry a path, a command or free text, and the thread of
 * a dialog read from its title.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { subagentDialogOnScreen } from '../src/herdr/dialogs/index.ts';
import {
  hooksToken, logToken, noApproveButtonLine, noHookCause, noHookLine,
} from '../src/herdr/dialogs/no-hook.ts';
import type { NoHookCause, NoHookFacts } from '../src/herdr/dialogs/no-hook.ts';

const NONE: NoHookFacts = {
  hookRunning: false, outsideWorkArea: false, disableAllHooks: false, allowManagedHooksOnly: false, rarogEntry: true,
};

const CASES: readonly { name: string; facts: Partial<NoHookFacts>; cause: NoHookCause }[] = [
  { name: 'hook process in ps wins over every other fact', cause: 'hook-running',
    facts: { hookRunning: true, outsideWorkArea: true, disableAllHooks: true, rarogEntry: false } },
  { name: 'session cwd outside the work area', cause: 'outside-work-area',
    facts: { outsideWorkArea: true, disableAllHooks: true, rarogEntry: false } },
  { name: 'without ps: the next certain fact names the dialog', cause: 'outside-work-area',
    facts: { hookRunning: null, outsideWorkArea: true } },
  { name: 'disableAllHooks true', cause: 'hooks-disabled', facts: { disableAllHooks: true, rarogEntry: false } },
  { name: 'allowManagedHooksOnly true', cause: 'hooks-disabled', facts: { allowManagedHooksOnly: true } },
  { name: 'no Rarog entry in any settings layer', cause: 'not-in-session-hooks', facts: { rarogEntry: false } },
  { name: 'without ps, hooks unknown, no Rarog entry', cause: 'not-in-session-hooks',
    facts: { hookRunning: null, disableAllHooks: null, allowManagedHooksOnly: null, rarogEntry: false } },
  { name: 'everything in order', cause: 'unexplained', facts: {} },
  { name: 'unknown hooks switch does not turn hooks off', cause: 'unexplained',
    facts: { disableAllHooks: null, allowManagedHooksOnly: null } },
  { name: 'unknown entry (superset read) is not a missing entry', cause: 'unexplained', facts: { rarogEntry: null } },
  { name: 'without ps and with nothing known', cause: 'unexplained', facts: {
    hookRunning: null, outsideWorkArea: null, disableAllHooks: null, allowManagedHooksOnly: null, rarogEntry: null,
  } },
];

describe('noHookCause', () => {
  it.each(CASES)('$name → $cause', ({ facts, cause }) => {
    expect(noHookCause({ ...NONE, ...facts })).toBe(cause);
  });
});

describe('log lines', () => {
  it('`no hook` line in the contract format', () => {
    expect(noHookLine({
      sessionId: 's-1', cause: 'not-in-session-hooks', tool: 'Bash', cli: '2.1.330', mode: 'default',
      thread: 'subagent', afterMs: 3000.4, hooks: { ok: true }, statusline: 'stale', screenButton: true,
    })).toBe('consent: no hook — session s-1, cause not-in-session-hooks, tool Bash, cli 2.1.330, mode default,'
      + ' thread subagent, after 3000 ms, hooks ok, statusline stale, screen-button yes');
  });

  it('`no hook` line with unknown values', () => {
    expect(noHookLine({
      sessionId: 's-1', cause: 'unexplained', tool: null, cli: null, mode: null, thread: 'main', afterMs: -5,
      hooks: null, statusline: 'none', screenButton: false,
    })).toBe('consent: no hook — session s-1, cause unexplained, tool ?, cli ?, mode ?, thread main, after 0 ms,'
      + ' hooks ?, statusline none, screen-button no');
  });

  it('`no approve button` line in the contract format', () => {
    expect(noApproveButtonLine({
      sessionId: 's-1', reason: 'no-channel', tool: 'mcp__srv__tool', channel: 'main', rule: 'screen', cli: null,
    })).toBe('consent: no approve button — session s-1, reason no-channel, tool mcp__srv__tool, channel main,'
      + ' rule screen, cli ?');
  });

  it('a negative hook list verdict gives its code, never the file it names', () => {
    const marker = 'ZQ7LEAK';
    expect(hooksToken({ ok: false, why: `unreadable:/home/${marker}/.claude/settings.json` })).toBe('unreadable');
    expect(hooksToken({ ok: false, why: `/home/${marker}/settings.json` })).toBe('?');
    const line = noHookLine({
      sessionId: 's-1', cause: 'unexplained', tool: `Bash ${marker}`, cli: `/opt/${marker}`, mode: 'default',
      thread: 'main', afterMs: 1, hooks: { ok: false, why: `changed:/srv/${marker}/settings.local.json` },
      statusline: 'fresh', screenButton: false,
    });
    expect(line).not.toContain(marker);
    expect(line).toContain('hooks changed,');
  });

  it.each([
    ['Bash', 'Bash'], ['mcp__srv__tool', 'mcp__srv__tool'], ['2.1.330', '2.1.330'], ['', '?'], [null, '?'],
    ['/Users/x/project', '?'], ['rm -rf build', '?'], ['a,b', '?'], ['x'.repeat(81), '?'],
  ] as const)('logToken(%j) → %s', (value, token) => {
    expect(logToken(value)).toBe(token);
  });
});

describe('subagentDialogOnScreen', () => {
  const fixture = (name: string): string => readFileSync(join(import.meta.dirname, 'fixtures', 'herdr', name), 'utf8');

  it.each([
    ['dialog-permission-subagent.txt', true],
    ['dialog-bash-subagent-naglowek-2.1.302.txt', true],
    ['dialog-permission-cd-advisory-2.1.265.txt', true],
    ['dialog-permission.txt', false],
    ['measured/zgoda-bash-2.1.293.txt', false],
  ] as const)('%s → %s', (name, subagent) => {
    expect(subagentDialogOnScreen(fixture(name))).toBe(subagent);
  });

  it('a screen without a dialog is no subagent dialog', () => {
    expect(subagentDialogOnScreen('Bash command · from the general-purpose agent\n')).toBe(false);
  });
});
