/**
 * `rarog doctor`: the consent-without-a-hook lines (`server/src/cli/doctor-no-hook.ts`). Input is synthetic
 * `server.log` text in the format of the `consent: no hook — …` line; neutral session ids.
 */
import { Console } from 'node:console';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NO_HOOK_WINDOW_MS, noHookLines, noHookLinesOf, parseNoHookLog,
} from '../src/cli/doctor-no-hook.ts';
import { HERDR_ROOTS_ENV } from '../src/config-env.ts';
import { noHookLine } from '../src/herdr/dialogs/no-hook.ts';
import { rarogCli } from '../src/install/repair.ts';
import { timestampWrites } from '../src/log-timestamps.ts';

const NOW = Date.parse('2030-01-10T12:00:00.000Z');
const FILE = '/data/server.log';
const DAY = 24 * 60 * 60 * 1000;

const iso = (ms: number): string => new Date(ms).toISOString();

interface Fields {
  readonly session?: string;
  readonly cause: string;
  readonly tool?: string;
  readonly cli?: string;
  readonly thread?: string;
}

/** One `consent: no hook` line as the detector writes it, with the server's time prefix `ago` ms before `NOW`. */
function noHook(ago: number, fields: Fields): string {
  return `${iso(NOW - ago)} consent: no hook — session ${fields.session ?? 'sess-a'}, cause ${fields.cause},`
    + ` tool ${fields.tool ?? 'Bash'}, cli ${fields.cli ?? '2.1.330'}, mode default,`
    + ` thread ${fields.thread ?? 'main'}, after 3012 ms, hooks ok, statusline fresh, screen-button yes`;
}

const log = (...lines: string[]): { file: string; text: string; truncated: boolean } =>
  ({ file: FILE, text: `${lines.join('\n')}\n`, truncated: false });

describe('parseNoHookLog: the line format', () => {
  it('reads the fields of a no hook line; other consent lines and lines without a time do not count', () => {
    const text = [
      noHook(1000, { cause: 'hooks-disabled', session: 'sess-a', tool: 'Edit', cli: '2.1.331' }),
      `${iso(NOW - 900)} consent: screen fallback key — session sess-a, tool Bash, cause hooks-disabled,`
        + ' card r1, tool_use ?',
      `${iso(NOW - 800)} consent: no approve button — session sess-a, reason ambiguous, tool Bash, channel ?,`
        + ' rule ?, cli ?',
      noHook(700, { cause: 'unexplained' }).replace(/^\S+ /u, ''),
      'garbage',
    ].join('\n');
    expect(parseNoHookLog(text)).toEqual([
      { at: NOW - 1000, session: 'sess-a', cause: 'hooks-disabled', tool: 'Edit', cli: '2.1.331', thread: 'main' },
    ]);
  });

  it('a value with characters outside the closed class reaches the screen as ?', () => {
    const line = noHook(1000, { cause: 'unexplained', tool: 'Ba\u001b[31msh', cli: '2.1.330' });
    expect(parseNoHookLog(line)).toEqual([
      { at: NOW - 1000, session: 'sess-a', cause: 'unexplained', tool: '?', cli: '2.1.330', thread: 'main' },
    ]);
  });
});

describe('the detector line through the server log', () => {
  it('a line the detector builds, logged with the time prefix, reads back with its cause, tool, cli and thread', () => {
    const parts: string[] = [];
    const stream = { write: (chunk: unknown): boolean => { parts.push(String(chunk)); return true; } };
    timestampWrites(stream as unknown as NodeJS.WritableStream, () => new Date(NOW - DAY));
    // The server logs with `console.log` on the wrapped stdout.
    const out = new Console({ stdout: stream as unknown as NodeJS.WritableStream, ignoreErrors: false });
    const session = '7d2dd80f-012c-5c17-b97d-cf436a305158';
    out.log(noHookLine({
      sessionId: session, cause: 'hooks-disabled', tool: 'mcp__atlas__query', cli: '2.1.330', mode: 'manual',
      thread: 'subagent', afterMs: 3012.4, hooks: { ok: true }, statusline: 'stale', screenButton: false,
    }));
    const text = parts.join('');
    expect(parseNoHookLog(text)).toEqual([{
      at: NOW - DAY, session, cause: 'hooks-disabled', tool: 'mcp__atlas__query', cli: '2.1.330', thread: 'subagent',
    }]);
    expect(noHookLinesOf(log(text.trimEnd()), NOW).map((line) => line.verdict)).toEqual(['warn']);
  });
});

describe('noHookLinesOf: the card cases', () => {
  it('no no hook line: one info line without cases', () => {
    expect(noHookLinesOf(log('consent: session hooks sess-a ok'), NOW)).toEqual([
      { verdict: 'info', text: `consent without a hook: none in the last 7 days (${FILE})` },
    ]);
  });

  it('hooks-disabled: warn naming the setting', () => {
    const lines = noHookLinesOf(log(noHook(DAY, { cause: 'hooks-disabled' })), NOW);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      verdict: 'warn',
      text: 'consent without a hook: 1 in the last 7 days, cause hooks-disabled — the session\'s Claude Code'
        + ' settings turn hooks off (disableAllHooks)',
      details: ['Claude Code 2.1.330; tools Bash (1); sessions 1'],
      repair: 'remove "disableAllHooks": true from the settings the session reads (~/.claude/settings.json, the'
        + ' project\'s .claude/settings.json or .claude/settings.local.json), or allowManagedHooksOnly from the'
        + ' managed settings',
    });
  });

  it('outside-work-area: warn with the work area root as the fix', () => {
    const [line] = noHookLinesOf(log(noHook(DAY, { cause: 'outside-work-area' })), NOW);
    expect(line?.verdict).toBe('warn');
    expect(line?.text).toContain('cause outside-work-area');
    expect(line?.repair).toBe(`start the session in a directory under a root of the work area, or add its root to`
      + ` ${HERDR_ROOTS_ENV} in config.json and run ${rarogCli('restart')}`);
  });

  it('not-in-session-hooks: warn with the hook entry and a session restart as the fix', () => {
    const [line] = noHookLinesOf(log(noHook(DAY, { cause: 'not-in-session-hooks' })), NOW);
    expect(line?.verdict).toBe('warn');
    expect(line?.text).toContain('cause not-in-session-hooks');
    expect(line?.repair).toBe(`${rarogCli('hooks doctor')} shows the entry in ~/.claude/settings.json and`
      + ` ${rarogCli('setup')} installs it; with the entry in place, restart the Claude Code session`);
  });

  it('only unexplained: info with the count, Claude Code versions and tools', () => {
    const lines = noHookLinesOf(log(
      noHook(3 * DAY, { cause: 'unexplained', cli: '2.1.330', tool: 'Bash', session: 'sess-a' }),
      noHook(2 * DAY, { cause: 'unexplained', cli: '2.1.331', tool: 'Edit', session: 'sess-b' }),
      noHook(DAY, { cause: 'unexplained', cli: '2.1.331', tool: 'Bash', session: 'sess-b' }),
    ), NOW);
    expect(lines).toEqual([{
      verdict: 'info',
      text: 'consent without a hook: 3 in the last 7 days, cause unexplained — the hook did not register and the'
        + ' server sees no reason',
      details: ['Claude Code 2.1.330, 2.1.331; tools Bash (2), Edit (1); sessions 2'],
    }]);
  });

  it('several causes: one line per cause in the order of the contract', () => {
    const lines = noHookLinesOf(log(
      noHook(DAY, { cause: 'unexplained' }),
      noHook(DAY, { cause: 'not-in-session-hooks' }),
      noHook(DAY, { cause: 'hook-running' }),
      noHook(DAY, { cause: 'hooks-disabled' }),
    ), NOW);
    expect(lines.map((line) => [line.verdict, /cause (\S+)/u.exec(line.text)?.[1]])).toEqual([
      ['info', 'hook-running'], ['warn', 'hooks-disabled'], ['warn', 'not-in-session-hooks'], ['info', 'unexplained'],
    ]);
  });

  it('a cause the contract does not know: info under its name, not dropped', () => {
    const [line] = noHookLinesOf(log(noHook(DAY, { cause: 'other-hook' })), NOW);
    expect(line).toMatchObject({ verdict: 'info' });
    expect(line?.text).toContain('1 in the last 7 days, cause other-hook');
  });

  it('lines older than 7 days do not count; the boundary counts', () => {
    expect(noHookLinesOf(log(noHook(NO_HOOK_WINDOW_MS + 1, { cause: 'hooks-disabled' })), NOW)).toEqual([
      { verdict: 'info', text: `consent without a hook: none in the last 7 days (${FILE})` },
    ]);
    expect(noHookLinesOf(log(noHook(NO_HOOK_WINDOW_MS, { cause: 'hooks-disabled' })), NOW)[0]?.verdict)
      .toBe('warn');
  });

  it('a no hook line smuggled inside another log call (a value with a newline) does not count', () => {
    const parts: string[] = [];
    const stream = { write: (chunk: unknown): boolean => { parts.push(String(chunk)); return true; } };
    timestampWrites(stream as unknown as NodeJS.WritableStream, () => new Date(NOW - DAY));
    const forged = noHook(DAY, { cause: 'hooks-disabled' }).replace(/^\S+ /u, '');
    stream.write(`watch: pane cwd /outside/\n${forged}\n`);
    expect(noHookLinesOf(log(parts.join('')), NOW)).toEqual([
      { verdict: 'info', text: `consent without a hook: none in the last 7 days (${FILE})` },
    ]);
  });

  it('log unreadable or no data directory: unknown', () => {
    expect(noHookLinesOf(null, NOW)).toEqual([
      { verdict: 'unknown', text: 'consent without a hook: data directory in conflict — server.log location unknown' },
    ]);
    expect(noHookLinesOf({ file: FILE, failure: 'EACCES' }, NOW)).toEqual([
      { verdict: 'unknown', text: `consent without a hook: ${FILE} unreadable (EACCES)` },
    ]);
  });

  it('only the end of a long log was read and it starts inside the window: every line says from when', () => {
    const start = NOW - 2 * DAY;
    const read = { file: FILE, truncated: true, text: [
      `${iso(start)} consent: session hooks sess-a ok`, noHook(DAY, { cause: 'unexplained' }),
    ].join('\n') };
    expect(noHookLinesOf(read, NOW)[0]?.details).toContain(
      `only the end of ${FILE} was read, from ${iso(start)}`);
    const quiet = { ...read, text: `${iso(start)} consent: session hooks sess-a ok` };
    expect(noHookLinesOf(quiet, NOW)[0]?.details).toEqual([`only the end of ${FILE} was read, from ${iso(start)}`]);
  });
});

describe('noHookLines: reading server.log', () => {
  const tmp = (): string => mkdtempSync(path.join(os.tmpdir(), 'nohook-'));

  it('no data directory: unknown', async () => {
    expect((await noHookLines(null, NOW))[0]?.verdict).toBe('unknown');
  });

  it('no server.log, a directory under its name, or no permission: unknown', async () => {
    const dir = tmp();
    expect(await noHookLines(dir, NOW)).toEqual([{
      verdict: 'unknown', text: `consent without a hook: ${path.join(dir, 'server.log')} unreadable (ENOENT)`,
    }]);
    mkdirSync(path.join(dir, 'server.log'));
    expect((await noHookLines(dir, NOW))[0]?.text).toBe(
      `consent without a hook: ${path.join(dir, 'server.log')} unreadable (not a regular file)`);
    const other = tmp();
    writeFileSync(path.join(other, 'server.log'), noHook(DAY, { cause: 'hooks-disabled' }));
    chmodSync(path.join(other, 'server.log'), 0o000);
    if (process.getuid?.() !== 0) {
      expect((await noHookLines(other, NOW))[0]?.text).toContain('unreadable (EACCES)');
    }
  });

  it('a cut that falls on a line start keeps that line', async () => {
    const dir = tmp();
    const before = noHook(DAY, { cause: 'hooks-disabled' });
    const after = noHook(DAY, { cause: 'unexplained' });
    writeFileSync(path.join(dir, 'server.log'), `${before}\n${after}\n`);
    const lines = await noHookLines(dir, NOW, { maxBytes: Buffer.byteLength(after) + 1 });
    expect(lines.map((line) => /cause (\S+)/u.exec(line.text)?.[1])).toEqual(['unexplained']);
  });

  it('reads the end of the file: a no hook line past the cap at the start does not count', async () => {
    const dir = tmp();
    const old = noHook(DAY, { cause: 'hooks-disabled' });
    const filler = `${iso(NOW - 2 * DAY)} ${'x'.repeat(200)}`;
    writeFileSync(path.join(dir, 'server.log'), `${old}\n${filler}\n${noHook(DAY, { cause: 'unexplained' })}\n`);
    const lines = await noHookLines(dir, NOW, { maxBytes: 300 });
    expect(lines.map((line) => line.verdict)).toEqual(['info']);
    expect(lines[0]?.text).toContain('cause unexplained');
  });
});
