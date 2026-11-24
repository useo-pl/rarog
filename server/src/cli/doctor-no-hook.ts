/**
 * `rarog doctor`: consents without a hook. Reads the `consent: no hook — …` lines (`docs/dialogs.md`, "Refusal
 * diagnostics") from the end of `<dataDir>/server.log`, keeps those of the last 7 days and prints one line per cause:
 * `hooks-disabled`, `outside-work-area` and `not-in-session-hooks` are `warn` with a fix, `hook-running`,
 * `unexplained` and a cause it does not know are `info`; none is one `info` line. No data directory or an unreadable
 * log is `unknown`. Reads only; values reach the screen only from a closed character class.
 */
import path from 'node:path';
import { HERDR_ROOTS_ENV } from '../config-env.ts';
import { rarogCli } from '../install/repair.ts';
import { LOG_TIME_PREFIX } from '../log-timestamps.ts';
import { openRegularFile } from '../safe-read.ts';

/** The doctor line (a subset of `Line` in `doctor.ts`, so this module does not import it). */
export interface NoHookDoctorLine {
  readonly verdict: 'warn' | 'unknown' | 'info';
  readonly text: string;
  readonly details?: readonly string[];
  readonly repair?: string;
}

/** One `consent: no hook` line with the fields doctor shows. */
export interface NoHookEntry {
  readonly at: number;
  readonly session: string;
  readonly cause: string;
  readonly tool: string;
  readonly cli: string;
  readonly thread: string;
}

/** What {@link noHookLinesOf} gets: the end of the log, a failure to read it, or `null` without a data directory. */
export type ServerLogRead =
  | { readonly file: string; readonly text: string; readonly truncated: boolean }
  | { readonly file: string; readonly failure: string }
  | null;

export const NO_HOOK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** The end of `server.log` that doctor reads; under the service the log only grows. */
export const NO_HOOK_READ_BYTES = 32 * 1024 * 1024;
const SERVER_LOG_FILENAME = 'server.log';
const TITLE = 'consent without a hook';
const LINE_HEAD = 'consent: no hook — ';
const LOG_TIME = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) /u;
/** A value doctor prints: anything else (terminal escapes, spaces) becomes `?`. */
const SAFE_VALUE = /^[A-Za-z0-9_.:@+-]{1,80}$/u;

const safe = (value: string | undefined): string => (value !== undefined && SAFE_VALUE.test(value) ? value : '?');

/**
 * The `no hook` lines of `text`; a line without the server's time prefix has no age, so it does not count, and
 * neither does a continuation line of another log call (time, then `LOG_CONTINUATION_MARK`).
 */
export function parseNoHookLog(text: string): NoHookEntry[] {
  const entries: NoHookEntry[] = [];
  for (const raw of text.split('\n')) {
    const time = LOG_TIME.exec(raw);
    if (time === null) continue;
    const rest = raw.replace(LOG_TIME_PREFIX, '').trimEnd();
    if (!rest.startsWith(LINE_HEAD)) continue;
    const fields = new Map<string, string>();
    for (const part of rest.slice(LINE_HEAD.length).split(', ')) {
      const space = part.indexOf(' ');
      if (space > 0 && !fields.has(part.slice(0, space))) fields.set(part.slice(0, space), part.slice(space + 1));
    }
    entries.push({
      at: Date.parse(time[1] ?? ''), session: safe(fields.get('session')), cause: safe(fields.get('cause')),
      tool: safe(fields.get('tool')), cli: safe(fields.get('cli')), thread: safe(fields.get('thread')),
    });
  }
  return entries;
}

interface CauseText {
  readonly verdict: 'warn' | 'info';
  readonly why: string;
  readonly repair?: () => string;
}

/** The causes in the order the detector checks them. */
const CAUSES: ReadonlyMap<string, CauseText> = new Map<string, CauseText>([
  ['hook-running', { verdict: 'info', why: 'the hook process ran without registering' }],
  ['outside-work-area', {
    verdict: 'warn', why: 'the session works in a directory outside Rarog\'s work area, where the hook does not write',
    repair: () => `start the session in a directory under a root of the work area, or add its root to`
      + ` ${HERDR_ROOTS_ENV} in config.json and run ${rarogCli('restart')}`,
  }],
  ['hooks-disabled', {
    verdict: 'warn', why: 'the session\'s Claude Code settings turn hooks off (disableAllHooks)',
    repair: () => 'remove "disableAllHooks": true from the settings the session reads (~/.claude/settings.json, the'
      + ' project\'s .claude/settings.json or .claude/settings.local.json), or allowManagedHooksOnly from the managed'
      + ' settings',
  }],
  ['not-in-session-hooks', {
    verdict: 'warn', why: 'the settings the session reads have no Rarog hook entry',
    repair: () => `${rarogCli('hooks doctor')} shows the entry in ~/.claude/settings.json and ${rarogCli('setup')}`
      + ' installs it; with the entry in place, restart the Claude Code session',
  }],
  ['unexplained', { verdict: 'info', why: 'the hook did not register and the server sees no reason' }],
]);

const UNKNOWN_CAUSE: CauseText = { verdict: 'info', why: 'a cause this doctor does not know' };

/** `a (2), b (1)`: values by count, then by name. */
function counted(values: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([value, count]) => `${value} (${String(count)})`).join(', ');
}

/** The doctor lines for a read of the log at `now`. */
export function noHookLinesOf(read: ServerLogRead, now: number): NoHookDoctorLine[] {
  if (read === null) {
    return [{ verdict: 'unknown', text: `${TITLE}: data directory in conflict — server.log location unknown` }];
  }
  if ('failure' in read) return [{ verdict: 'unknown', text: `${TITLE}: ${read.file} unreadable (${read.failure})` }];
  const from = now - NO_HOOK_WINDOW_MS;
  const entries = parseNoHookLog(read.text).filter((entry) => entry.at >= from);
  const firstTime = LOG_TIME.exec(read.text.split('\n').find((raw) => LOG_TIME.test(raw)) ?? '')?.[1];
  const shortened = read.truncated && firstTime !== undefined && Date.parse(firstTime) > from
    ? [`only the end of ${read.file} was read, from ${firstTime}`] : [];
  if (entries.length === 0) {
    return [{
      verdict: 'info', text: `${TITLE}: none in the last 7 days (${read.file})`,
      ...(shortened.length > 0 ? { details: shortened } : {}),
    }];
  }
  const causes = [...new Set(entries.map((entry) => entry.cause))].sort((a, b) => {
    const order = [...CAUSES.keys()];
    const rank = (cause: string): number => (order.includes(cause) ? order.indexOf(cause) : order.length);
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  return causes.map((cause) => {
    const mine = entries.filter((entry) => entry.cause === cause);
    const text = CAUSES.get(cause) ?? UNKNOWN_CAUSE;
    const versions = [...new Set(mine.map((entry) => entry.cli))].sort().join(', ');
    const sessions = new Set(mine.map((entry) => entry.session)).size;
    return {
      verdict: text.verdict,
      text: `${TITLE}: ${String(mine.length)} in the last 7 days, cause ${cause} — ${text.why}`,
      details: [
        `Claude Code ${versions}; tools ${counted(mine.map((entry) => entry.tool))}; sessions ${String(sessions)}`,
        ...shortened,
      ],
      ...(text.repair !== undefined ? { repair: text.repair() } : {}),
    };
  });
}

const errnoCode = (failure: unknown): string => {
  const code = failure !== null && typeof failure === 'object' ? (failure as { code?: unknown }).code : undefined;
  return typeof code === 'string' && code !== '' ? code : String(failure);
};

/**
 * The end of `<dataDir>/server.log`, at most `maxBytes`, starting at a whole line. The byte before the cut is read
 * too, so a cut that falls on a line start keeps that line.
 */
async function readLogEnd(file: string, maxBytes: number): Promise<ServerLogRead> {
  try {
    const opened = await openRegularFile(file, { followSymlink: true });
    if (opened === null) return { file, failure: 'not a regular file' };
    try {
      const size = Number(opened.stats.size);
      const start = Math.max(0, size - maxBytes - 1);
      const buffer = Buffer.alloc(size - start);
      let filled = 0;
      while (filled < buffer.length) {
        const { bytesRead } = await opened.handle.read(buffer, filled, buffer.length - filled, start + filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      let text = buffer.subarray(0, filled).toString('utf8');
      if (start > 0) {
        const cut = text.indexOf('\n');
        text = cut === -1 ? '' : text.slice(cut + 1);
      }
      return { file, text, truncated: start > 0 };
    } finally {
      await opened.handle.close();
    }
  } catch (failure) {
    return { file, failure: errnoCode(failure) };
  }
}

/** The lines for the data directory `doctor` resolved (`null` = directories in conflict). */
export async function noHookLines(
  dataDir: string | null, now: number, opts: { readonly maxBytes?: number } = {},
): Promise<NoHookDoctorLine[]> {
  const read = dataDir === null
    ? null : await readLogEnd(path.join(dataDir, SERVER_LOG_FILENAME), opts.maxBytes ?? NO_HOOK_READ_BYTES);
  return noHookLinesOf(read, now);
}
