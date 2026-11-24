/**
 * The session hook list's disk and `ps` as an in-memory fake (`HookListIo`) with one session scene: the CLI registry
 * file, the process from `ps`, files changed before the session start. The hook list only reads, so the fake has no
 * write. Shared by the hook list tests and the session facts tests.
 */
import path from 'node:path';
import type {
  HookListInput, HookListIo, HookListProcess, HookListStat,
} from '../../src/herdr/dialogs/layer1/hook-list/hook-list.ts';
import { hookCommand } from '../../src/herdr/hook-commands.ts';

export const HOME = '/Users/u';
export const CLAUDE = `${HOME}/.claude`;
export const SESSION = '00000000-0000-4000-9000-0000000000e1';
export const PID = 4242;
export const CWD = '/w/repo/app';
export const NOW = Date.parse('2026-11-10T10:00:00.000Z');
export const ELAPSED_S = 3_600;
/** Start procesu z `etime` i chwila zapisu rejestru (3 s po starcie). */
export const PROCESS_START = NOW - ELAPSED_S * 1_000;
export const REGISTRY_START = PROCESS_START + 3_000;
/** Chwila zmiany plików sprzed startu sesji. */
export const OLD = PROCESS_START - 86_400_000;
export const RAROG = hookCommand(HOME);
export const MANAGED = '/Library/Application Support/ClaudeCode';
export const UST = '/etc/rarog-test/prod.json';

export const rarogLayer = (command = RAROG, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  hooks: { PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command, timeout: 86_400, ...extra }] }] },
});
export const foreignLayer = (): Record<string, unknown> => rarogLayer('/usr/local/bin/inny-hook');

export interface Fake {
  /** Pliki: ścieżka → treść. Katalogi wynikają ze ścieżek plików i z `dirs`. */
  readonly files: Map<string, string>;
  readonly dirs: Set<string>;
  /** Dowiązania symboliczne: ścieżka → cel jak z `readlink` (bezwzględny albo względny wobec katalogu dowiązania). */
  readonly links: Map<string, string>;
  /** Chwila zmiany ścieżki (domyślnie {@link OLD}); dla dowiązania: zmiana samego dowiązania. */
  readonly changed: Map<string, number>;
  /** Błąd odczytu ścieżki (kod). */
  readonly errors: Map<string, string>;
  proc: HookListProcess | null;
}

export function fake(over: { args?: string; cwd?: string } = {}): Fake {
  const files = new Map<string, string>([
    [`${CLAUDE}/sessions/${PID}.json`, JSON.stringify({
      pid: PID, sessionId: SESSION, cwd: over.cwd ?? CWD, startedAt: REGISTRY_START,
    })],
  ]);
  return {
    files, dirs: new Set(), links: new Map(), changed: new Map(), errors: new Map(),
    proc: { elapsedS: ELAPSED_S, args: over.args ?? `claude --settings ${UST}` },
  };
}

export function put(f: Fake, file: string, value: unknown): void {
  f.files.set(file, typeof value === 'string' ? value : JSON.stringify(value));
}

export function ioOf(f: Fake): HookListIo {
  const fail = (p: string): void => {
    const code = f.errors.get(p);
    if (code !== undefined) throw Object.assign(new Error(code), { code });
  };
  const isDir = (p: string): boolean => f.dirs.has(p)
    || [...f.files.keys(), ...f.dirs, ...f.links.keys()].some((one) => one.startsWith(`${p}/`));
  /** Ścieżka po rozwiązaniu dowiązań atrapy (odczyt i lista katalogu idą za dowiązaniem jak system plików). */
  const real = (p: string): string => {
    let out = '/';
    const queue = p.split('/').filter((one) => one !== '');
    for (let hops = 0; queue.length > 0;) {
      const here = path.join(out, queue.shift() ?? '');
      const target = f.links.get(here);
      if (target === undefined) {
        out = here;
        continue;
      }
      hops += 1;
      if (hops > 40) return here;
      if (path.isAbsolute(target)) out = '/';
      queue.unshift(...target.split('/').filter((one) => one !== ''));
    }
    return out;
  };
  /** Wpis bez podążania za dowiązaniem. */
  const entry = (p: string): HookListStat | null => {
    const changedAt = f.changed.get(p) ?? OLD;
    if (f.links.has(p)) return { kind: 'link', size: 0, changedAt };
    const text = f.files.get(p);
    if (text !== undefined) return { kind: 'file', size: Buffer.byteLength(text), changedAt };
    return isDir(p) ? { kind: 'dir', size: 0, changedAt } : null;
  };
  return {
    async lstat(p): Promise<HookListStat | null> {
      fail(p);
      return entry(p);
    },
    async readlink(p) {
      fail(p);
      const target = f.links.get(p);
      if (target === undefined) throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' });
      return target;
    },
    async readFile(p) {
      fail(p);
      return f.files.get(real(p)) ?? null;
    },
    async readdir(p) {
      fail(p);
      const dir = real(p);
      if (!isDir(dir)) return null;
      const names = new Set<string>();
      for (const one of [...f.files.keys(), ...f.dirs, ...f.links.keys()]) {
        if (one.startsWith(`${dir}/`)) names.add(one.slice(dir.length + 1).split('/')[0] ?? '');
      }
      return [...names];
    },
    async ps(pid) {
      return pid === PID ? f.proc : null;
    },
  };
}

/** The session process: the registry entry gives `pid` and a start 3 s after `start`, `ps` the same process. */
export interface SessionProcess {
  pid: number;
  start: number;
  /** Runs once after the next `ps` answer is taken: a session restart in the middle of a read. */
  afterPs?: () => void;
}

/**
 * The fake's disk with a session process that ages with the test clock (`etime` in whole seconds); `reads` counts the
 * `ps` calls, one per hook list read.
 */
export function sessionIo(f: Fake, clock: { now: number }, proc: SessionProcess): {
  readonly io: HookListIo; readonly reads: { count: number };
} {
  const reads = { count: 0 };
  const io: HookListIo = {
    ...ioOf(f),
    ps: async (pid) => {
      reads.count += 1;
      const answer = pid === proc.pid && f.proc !== null
        ? { ...f.proc, elapsedS: Math.floor((clock.now - proc.start) / 1_000) } : null;
      const after = proc.afterPs;
      proc.afterPs = undefined;
      after?.();
      return answer;
    },
  };
  return { io, reads };
}

export function input(over: Partial<HookListInput> = {}): HookListInput {
  return {
    sessionId: SESSION, home: HOME, accepted: [RAROG], entry: { pid: PID, startedAt: REGISTRY_START }, cwds: [CWD],
    platform: 'darwin', now: NOW, ...over,
  };
}
