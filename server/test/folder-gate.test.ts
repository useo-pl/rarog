/**
 * The folder gate on a fake client and a fake clock: which folder a path lies in, every state transition, the
 * kill-and-retry policy on a timeout, generations, rechecks, joined checks, `blocked()` and the one gate per process.
 */
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gatedFolderOf } from '../src/folder-gate/folders.ts';
import { FOLDER_RECHECK_MS, FOLDER_RECHECK_SLOW_MS, MacFolderGate } from '../src/folder-gate/gate.ts';
import { DISABLED_FOLDER_GATE, folderGate, installFolderGate } from '../src/folder-gate/install.ts';
import type {
  DiskArgs, DiskOp, DiskValue, FolderClient, FolderGate, FolderState, HelperAnswer,
} from '../src/folder-gate/types.ts';

const H = '/home/tester';
const DESKTOP = path.join(H, 'Desktop');
const DOCUMENTS = path.join(H, 'Documents');
const DOWNLOADS = path.join(H, 'Downloads');
const BOUND_MS = 1000;

interface PendingCall {
  readonly folder: string;
  readonly op: DiskOp;
  readonly args: unknown;
  readonly answer: (answer: HelperAnswer<unknown>) => void;
}

/** A client whose calls stay pending until the test answers them; generations count per folder from 0. */
class FakeClient implements FolderClient {
  readonly calls: PendingCall[] = [];
  readonly restarts: string[] = [];
  disposed = false;
  readonly #gen = new Map<string, number>();
  readonly #late = new Set<(folder: string, gen: number, answer: HelperAnswer<unknown>) => void>();

  gen(folder: string): number { return this.#gen.get(folder) ?? 0; }
  generationOf(folder: string): number { return this.gen(folder); }

  callSync(): never { throw new Error('the gate never calls a helper synchronously'); }

  call<K extends DiskOp>(folder: string, op: K, args: DiskArgs[K]): Promise<HelperAnswer<DiskValue[K]>> {
    return new Promise((resolve) => {
      this.calls.push({ folder, op, args, answer: resolve as (answer: HelperAnswer<unknown>) => void });
    });
  }

  restart(folder: string): number {
    const next = this.gen(folder) + 1;
    this.#gen.set(folder, next);
    this.restarts.push(folder);
    return next;
  }

  onLate(listener: (folder: string, gen: number, answer: HelperAnswer<unknown>) => void): () => void {
    this.#late.add(listener);
    return () => { this.#late.delete(listener); };
  }

  late(folder: string, gen: number, answer: HelperAnswer<unknown>): void {
    for (const listener of this.#late) listener(folder, gen, answer);
  }

  dispose(): void { this.disposed = true; }

  /** Answers the oldest pending call and lets the gate react. */
  async answer(answer: HelperAnswer<unknown>): Promise<PendingCall> {
    const call = this.calls.shift();
    if (call === undefined) throw new Error('no pending call');
    call.answer(answer);
    await vi.advanceTimersByTimeAsync(0);
    return call;
  }

  get lateListeners(): number { return this.#late.size; }
}

const ok: HelperAnswer<unknown> = { kind: 'ok', value: undefined };
const gone: HelperAnswer<unknown> = { kind: 'gone' };
const timeout: HelperAnswer<unknown> = { kind: 'timeout' };
function fsError(code: string): HelperAnswer<unknown> {
  return { kind: 'fs-error', error: Object.assign(new Error(code), { code, syscall: 'opendir' }) };
}

let client: FakeClient;
let gate: MacFolderGate;
let lines: string[];
let changes: Array<[string, FolderState]>;

function makeGate(): void {
  client = new FakeClient();
  lines = [];
  changes = [];
  gate = new MacFolderGate({ home: H, client, boundMs: BOUND_MS, log: (line) => lines.push(line) });
  gate.onChange((folder, state) => changes.push([folder, state]));
}

function stateOf(folder: string): FolderState | undefined {
  return gate.stateOf(path.join(folder, 'p'))?.state;
}

/** Puts a folder into `waiting` by a timeout report and leaves the immediate check pending. */
function toWaiting(folder: string): void {
  gate.report(folder, client.gen(folder), 'timeout');
}

/** Brings a folder to a closed state through a check from `unknown`. */
async function toCheckedState(folder: string, answer: HelperAnswer<unknown>): Promise<void> {
  void gate.check(folder, 5 * BOUND_MS);
  await client.answer(answer);
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date('2030-01-02T03:04:05.000Z') });
  makeGate();
});

afterEach(() => {
  gate.dispose();
  vi.useRealTimers();
});

describe('gatedFolderOf', () => {
  it.each([
    [`${H}/DESKTOP/p`, DESKTOP],
    [`${H}/Documents`, DOCUMENTS],
    [`${H}/downloads/a/b`, DOWNLOADS],
    [`${H}/Library/x`, path.join(H, 'Library')],
    [`${H}/Projects/p`, null],
    [H, null],
    [`${H}/`, null],
    ['/elsewhere/Desktop/p', null],
    ['/home/tester2/Desktop', null],
    ['Desktop/p', null],
    [`${H}/Desktop/../Projects`, null],
  ])('%s → %s', (candidate, folder) => {
    expect(gatedFolderOf(candidate, H)).toBe(folder);
  });

  it('a relative home gives null', () => {
    expect(gatedFolderOf(`${H}/Desktop`, 'home/tester')).toBeNull();
  });
});

describe('MacFolderGate: states and transitions', () => {
  it('a gated path starts unknown with no disk call; a path outside the folders has no state', () => {
    expect(gate.enabled).toBe(true);
    expect(gate.stateOf(`${H}/Documents/p`)).toEqual({ folder: DOCUMENTS, state: 'unknown' });
    expect(gate.stateOf(`${H}/Projects/p`)).toBeNull();
    expect(gate.blocked()).toEqual([]);
    expect(client.calls).toEqual([]);
    expect(client.restarts).toEqual([]);
  });

  it.each<[string, HelperAnswer<unknown>, FolderState]>([
    ['OK', ok, 'open'],
    ['EPERM', fsError('EPERM'), 'denied'],
    ['EACCES', fsError('EACCES'), 'denied'],
    ['ENOENT', fsError('ENOENT'), 'absent'],
    ['ENOTDIR', fsError('ENOTDIR'), 'absent'],
    ['gone', gone, 'unchecked'],
    ['another code', fsError('EIO'), 'unchecked'],
  ])('check from unknown: %s → %s', async (_name, answer, state) => {
    const result = gate.check(DESKTOP, 5 * BOUND_MS);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({ folder: DESKTOP, op: 'check', args: { path: DESKTOP } });
    await client.answer(answer);
    await expect(result).resolves.toBe(state);
    expect(stateOf(DESKTOP)).toBe(state);
    expect(changes).toEqual([[DESKTOP, state]]);
    expect(lines.some((line) => line.startsWith('folder gate: Desktop '))).toBe(true);
  });

  it('a check from unknown that times out leaves the folder waiting', async () => {
    void gate.check(DESKTOP, 5 * BOUND_MS);
    await client.answer(timeout);
    expect(stateOf(DESKTOP)).toBe('waiting');
    expect(lines).toContain(`folder gate: Desktop waiting (no answer in ${BOUND_MS} ms)`);
  });

  it.each<FolderState>(['unknown', 'open'])('a timeout in %s → waiting, the helper killed and checked again', async (from) => {
    if (from === 'open') await toCheckedState(DESKTOP, ok);
    changes.length = 0;
    toWaiting(DESKTOP);
    expect(stateOf(DESKTOP)).toBe('waiting');
    expect(changes).toEqual([[DESKTOP, 'waiting']]);
    expect(lines).toContain(`folder gate: Desktop waiting (no answer in ${BOUND_MS} ms)`);
    expect(client.restarts).toEqual([DESKTOP]);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({ folder: DESKTOP, op: 'check' });
  });

  it('a slow read: the immediate check answers OK → open again with a slow read line', async () => {
    toWaiting(DESKTOP);
    await vi.advanceTimersByTimeAsync(BOUND_MS / 2);
    await client.answer(ok);
    expect(stateOf(DESKTOP)).toBe('open');
    expect(changes).toEqual([[DESKTOP, 'waiting'], [DESKTOP, 'open']]);
    expect(lines.some((line) => line.includes('Desktop') && line.includes('slow read'))).toBe(true);
  });

  it('a timeout while waiting kills nothing and changes nothing', async () => {
    toWaiting(DESKTOP);
    const since = gate.blocked()[0]?.since;
    await vi.advanceTimersByTimeAsync(10_000);
    gate.report(DESKTOP, client.gen(DESKTOP), 'timeout');
    expect(client.restarts).toEqual([DESKTOP]);
    expect(client.calls).toHaveLength(1);
    expect(changes).toEqual([[DESKTOP, 'waiting']]);
    expect(gate.blocked()[0]?.since).toBe(since);
  });

  it('waiting, the check times out, then its late OK (current generation) opens the folder', async () => {
    toWaiting(DESKTOP);
    await client.answer(timeout);
    expect(stateOf(DESKTOP)).toBe('waiting');
    client.late(DESKTOP, client.gen(DESKTOP), ok);
    expect(stateOf(DESKTOP)).toBe('open');
    expect(changes).toEqual([[DESKTOP, 'waiting'], [DESKTOP, 'open']]);
    expect(gate.blocked()).toEqual([]);
  });

  it('a late-ok report of the current generation opens a waiting folder; a second one changes nothing', async () => {
    toWaiting(DESKTOP);
    await client.answer(timeout);
    gate.report(DESKTOP, client.gen(DESKTOP), 'late-ok');
    gate.report(DESKTOP, client.gen(DESKTOP), 'late-ok');
    client.late(DESKTOP, client.gen(DESKTOP), ok);
    expect(changes).toEqual([[DESKTOP, 'waiting'], [DESKTOP, 'open']]);
  });

  it('a late EPERM while waiting checks again; the check gives denied', async () => {
    toWaiting(DESKTOP);
    await client.answer(timeout);
    client.late(DESKTOP, client.gen(DESKTOP), fsError('EPERM'));
    expect(client.restarts).toEqual([DESKTOP, DESKTOP]);
    await client.answer(fsError('EPERM'));
    expect(stateOf(DESKTOP)).toBe('denied');
  });

  it('a late answer that is not OK or EPERM changes nothing', async () => {
    toWaiting(DESKTOP);
    await client.answer(timeout);
    client.late(DESKTOP, client.gen(DESKTOP), fsError('ENOENT'));
    client.late(DESKTOP, client.gen(DESKTOP), gone);
    expect(stateOf(DESKTOP)).toBe('waiting');
    expect(client.restarts).toEqual([DESKTOP]);
    expect(client.calls).toEqual([]);
  });

  it('waiting rechecks with a new helper every FOLDER_RECHECK_MS and keeps its since', async () => {
    toWaiting(DESKTOP);
    const since = gate.blocked()[0]?.since;
    await client.answer(timeout);
    await vi.advanceTimersByTimeAsync(FOLDER_RECHECK_MS - 1);
    expect(client.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(client.restarts).toEqual([DESKTOP, DESKTOP]);
    expect(client.calls).toHaveLength(1);
    await client.answer(timeout);
    await vi.advanceTimersByTimeAsync(FOLDER_RECHECK_MS);
    expect(client.restarts).toHaveLength(3);
    expect(gate.blocked()[0]?.since).toBe(since);
    await client.answer(ok);
    expect(stateOf(DESKTOP)).toBe('open');
    expect(lines.filter((line) => line.includes('slow read'))).toEqual([]);
    await vi.advanceTimersByTimeAsync(10 * FOLDER_RECHECK_SLOW_MS);
    expect(client.calls).toEqual([]);
  });

  it.each<[FolderState, HelperAnswer<unknown>]>([
    ['denied', fsError('EPERM')],
    ['absent', fsError('ENOENT')],
    ['unchecked', gone],
  ])('%s rechecks every FOLDER_RECHECK_SLOW_MS, without a change event when the state holds', async (state, answer) => {
    await toCheckedState(DESKTOP, answer);
    expect(stateOf(DESKTOP)).toBe(state);
    const since = gate.blocked().find((one) => one.path === DESKTOP)?.since;
    changes.length = 0;
    lines.length = 0;
    await vi.advanceTimersByTimeAsync(FOLDER_RECHECK_MS);
    expect(client.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(FOLDER_RECHECK_SLOW_MS - FOLDER_RECHECK_MS);
    expect(client.calls).toHaveLength(1);
    await client.answer(answer);
    expect(stateOf(DESKTOP)).toBe(state);
    expect(changes).toEqual([]);
    expect(lines).toEqual([]);
    expect(gate.blocked().find((one) => one.path === DESKTOP)?.since).toBe(since);
    await vi.advanceTimersByTimeAsync(FOLDER_RECHECK_SLOW_MS);
    expect(client.calls).toHaveLength(1);
    await client.answer(ok);
    expect(stateOf(DESKTOP)).toBe('open');
    expect(changes).toEqual([[DESKTOP, 'open']]);
  });

  it('a helper that does not start: unchecked, and the recheck every 5 minutes runs on a new helper', async () => {
    await toCheckedState(DESKTOP, gone);
    expect(stateOf(DESKTOP)).toBe('unchecked');
    for (let round = 1; round <= 3; round += 1) {
      await vi.advanceTimersByTimeAsync(FOLDER_RECHECK_SLOW_MS);
      expect(client.restarts).toHaveLength(round);
      await client.answer(gone);
      expect(stateOf(DESKTOP)).toBe('unchecked');
    }
  });

  it.each<[string, HelperAnswer<unknown>]>([
    ['denied', fsError('EPERM')],
    ['absent', fsError('ENOENT')],
    ['unchecked', gone],
  ])('a recheck from %s that times out → waiting', async (_name, answer) => {
    await toCheckedState(DESKTOP, answer);
    await vi.advanceTimersByTimeAsync(FOLDER_RECHECK_SLOW_MS);
    await client.answer(timeout);
    expect(stateOf(DESKTOP)).toBe('waiting');
  });

  it.each<['eperm' | 'gone', FolderState]>([
    ['eperm', 'open'], ['eperm', 'unknown'], ['gone', 'open'], ['gone', 'unknown'],
  ])('%s in %s → a check on a new helper, the state unchanged until its result', async (event, from) => {
    if (from === 'open') await toCheckedState(DESKTOP, ok);
    changes.length = 0;
    gate.report(DESKTOP, client.gen(DESKTOP), event);
    expect(stateOf(DESKTOP)).toBe(from);
    expect(client.restarts).toEqual([DESKTOP]);
    expect(client.calls).toHaveLength(1);
    await client.answer(event === 'eperm' ? fsError('EPERM') : ok);
    expect(stateOf(DESKTOP)).toBe(event === 'eperm' ? 'denied' : 'open');
  });

  it('gone and timeout reports in a closed state change nothing', async () => {
    await toCheckedState(DESKTOP, fsError('EPERM'));
    gate.report(DESKTOP, client.gen(DESKTOP), 'gone');
    gate.report(DESKTOP, client.gen(DESKTOP), 'timeout');
    expect(stateOf(DESKTOP)).toBe('denied');
    expect(client.restarts).toEqual([]);
    expect(client.calls).toEqual([]);
  });

  it('two checks of one folder at once share one helper call and one result', async () => {
    const first = gate.check(DOCUMENTS, 5 * BOUND_MS);
    const second = gate.check(DOCUMENTS, 5 * BOUND_MS);
    expect(client.calls).toHaveLength(1);
    expect(client.restarts).toEqual([]);
    await client.answer(fsError('EPERM'));
    await expect(first).resolves.toBe('denied');
    await expect(second).resolves.toBe('denied');
  });

  it('an eperm report during a running check joins it', async () => {
    void gate.check(DOCUMENTS, 5 * BOUND_MS);
    gate.report(DOCUMENTS, client.gen(DOCUMENTS), 'eperm');
    expect(client.calls).toHaveLength(1);
    expect(client.restarts).toEqual([]);
  });

  it('a check in waiting starts on a new helper, the hung one killed', async () => {
    toWaiting(DESKTOP);
    await client.answer(timeout);
    void gate.check(DESKTOP, 5 * BOUND_MS);
    expect(client.restarts).toEqual([DESKTOP, DESKTOP]);
    expect(client.calls).toHaveLength(1);
  });

  it('check gives the state at waitMs when no answer comes', async () => {
    const result = gate.check(DESKTOP, 3 * BOUND_MS);
    await client.answer(timeout);
    let settled: FolderState | undefined;
    void result.then((state) => { settled = state; });
    await vi.advanceTimersByTimeAsync(3 * BOUND_MS - 1);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe('waiting');
  });

  it('check waits past the client bound for the late answer of the click at the Mac', async () => {
    const result = gate.check(DESKTOP, 60_000);
    await client.answer(timeout);
    await vi.advanceTimersByTimeAsync(20_000);
    client.late(DESKTOP, client.gen(DESKTOP), ok);
    await expect(result).resolves.toBe('open');
  });

  it('check of an unknown folder with no answer before waitMs gives unknown', async () => {
    const result = gate.check(DESKTOP, BOUND_MS / 2);
    await vi.advanceTimersByTimeAsync(BOUND_MS / 2);
    await expect(result).resolves.toBe('unknown');
  });
});

describe('MacFolderGate: generations', () => {
  it('before any restart, a report of any generation counts', () => {
    gate.report(DESKTOP, 7, 'timeout');
    expect(stateOf(DESKTOP)).toBe('waiting');
  });

  it('an answer of an older generation after a newer state changes nothing and logs a line', async () => {
    toWaiting(DESKTOP);
    const old = client.gen(DESKTOP) - 1;
    await client.answer(ok);
    expect(stateOf(DESKTOP)).toBe('open');
    changes.length = 0;
    lines.length = 0;
    gate.report(DESKTOP, old, 'timeout');
    gate.report(DESKTOP, old, 'eperm');
    gate.report(DESKTOP, old, 'gone');
    client.late(DESKTOP, old, ok);
    expect(stateOf(DESKTOP)).toBe('open');
    expect(changes).toEqual([]);
    expect(client.restarts).toEqual([DESKTOP]);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.startsWith('folder gate: Desktop '))).toBe(true);
  });

  it('abandoned helpers make no open → waiting → open cycle', async () => {
    await toCheckedState(DESKTOP, ok);
    gate.report(DESKTOP, client.gen(DESKTOP), 'timeout');
    const abandoned = client.gen(DESKTOP) - 1;
    await client.answer(ok);
    changes.length = 0;
    gate.report(DESKTOP, abandoned, 'timeout');
    client.late(DESKTOP, abandoned, ok);
    expect(changes).toEqual([]);
    expect(stateOf(DESKTOP)).toBe('open');
  });

  it('the answer of a check superseded by a kill-and-retry is dropped', async () => {
    void gate.check(DESKTOP, 5 * BOUND_MS);
    gate.report(DESKTOP, client.gen(DESKTOP), 'timeout');
    expect(client.calls).toHaveLength(2);
    await client.answer(fsError('EPERM'));
    expect(stateOf(DESKTOP)).toBe('waiting');
    await client.answer(ok);
    expect(stateOf(DESKTOP)).toBe('open');
  });
});

describe('MacFolderGate: an ordinary call that answers', () => {
  it('an ok report opens an unknown folder without a check; the blocked list stays empty', () => {
    gate.report(DOCUMENTS, client.gen(DOCUMENTS), 'ok');
    expect(stateOf(DOCUMENTS)).toBe('open');
    expect(changes).toEqual([[DOCUMENTS, 'open']]);
    expect(lines.some((line) => line.startsWith('folder gate: Documents open'))).toBe(true);
    expect(gate.blocked()).toEqual([]);
    expect(client.calls).toEqual([]);
    expect(client.restarts).toEqual([]);
    gate.report(DOCUMENTS, client.gen(DOCUMENTS), 'ok');
    expect(changes).toEqual([[DOCUMENTS, 'open']]);
  });

  it('an ok report of an older generation leaves the folder unknown; one of the current generation opens it', () => {
    gate.report(DOCUMENTS, client.gen(DOCUMENTS), 'eperm');
    expect(client.restarts).toEqual([DOCUMENTS]);
    expect(stateOf(DOCUMENTS)).toBe('unknown');
    gate.report(DOCUMENTS, client.gen(DOCUMENTS) - 1, 'ok');
    expect(stateOf(DOCUMENTS)).toBe('unknown');
    expect(changes).toEqual([]);
    gate.report(DOCUMENTS, client.gen(DOCUMENTS), 'ok');
    expect(stateOf(DOCUMENTS)).toBe('open');
  });

  it.each<[string, HelperAnswer<unknown> | null, FolderState]>([
    ['waiting', null, 'waiting'],
    ['denied', fsError('EPERM'), 'denied'],
    ['absent', fsError('ENOENT'), 'absent'],
    ['unchecked', gone, 'unchecked'],
  ])('an ok report leaves a %s folder as it is: only a check or a late answer opens it', async (_n, answer, state) => {
    if (answer === null) toWaiting(DOCUMENTS);
    else await toCheckedState(DOCUMENTS, answer);
    expect(stateOf(DOCUMENTS)).toBe(state);
    changes.length = 0;
    gate.report(DOCUMENTS, client.gen(DOCUMENTS), 'ok');
    expect(stateOf(DOCUMENTS)).toBe(state);
    expect(changes).toEqual([]);
  });
});

describe('MacFolderGate: blocked, onChange, dispose', () => {
  it('blocked lists waiting, denied and unchecked only, sorted by name', async () => {
    await toCheckedState(DOWNLOADS, fsError('ENOENT'));
    await toCheckedState(DOCUMENTS, fsError('EPERM'));
    await toCheckedState(path.join(H, 'Pictures'), gone);
    await toCheckedState(path.join(H, 'Movies'), ok);
    toWaiting(DESKTOP);
    expect(gate.blocked()).toEqual([
      { name: 'Desktop', path: DESKTOP, state: 'waiting', since: '2030-01-02T03:04:05.000Z' },
      { name: 'Documents', path: DOCUMENTS, state: 'denied', since: '2030-01-02T03:04:05.000Z' },
      { name: 'Pictures', path: path.join(H, 'Pictures'), state: 'unchecked', since: '2030-01-02T03:04:05.000Z' },
    ]);
  });

  it('since is the moment the folder entered its state', async () => {
    await vi.advanceTimersByTimeAsync(90_000);
    toWaiting(DESKTOP);
    expect(gate.blocked()[0]?.since).toBe('2030-01-02T03:05:35.000Z');
  });

  it('an unsubscribed listener hears nothing', () => {
    const heard: string[] = [];
    const off = gate.onChange((folder) => heard.push(folder));
    off();
    toWaiting(DESKTOP);
    expect(heard).toEqual([]);
  });

  it('dispose clears the timers and the late listener, ignores reports and leaves the client alone', async () => {
    await toCheckedState(DESKTOP, fsError('EPERM'));
    toWaiting(DOCUMENTS);
    const pending = gate.check(DOWNLOADS, 60_000);
    gate.dispose();
    await expect(pending).resolves.toBe('unknown');
    expect(vi.getTimerCount()).toBe(0);
    expect(client.lateListeners).toBe(0);
    expect(client.disposed).toBe(false);
    const restarts = client.restarts.length;
    gate.report(path.join(H, 'Movies'), 0, 'timeout');
    await client.answer(ok);
    expect(client.restarts).toHaveLength(restarts);
    expect(stateOf(path.join(H, 'Movies'))).toBe('unknown');
    await expect(gate.check(DESKTOP, 1000)).resolves.toBe('denied');
  });
});

describe('install: one gate per process', () => {
  it('the default gate is disabled and inert', async () => {
    const gateNow: FolderGate = folderGate();
    expect(gateNow).toBe(DISABLED_FOLDER_GATE);
    expect(gateNow.enabled).toBe(false);
    expect(gateNow.stateOf(`${H}/Desktop/p`)).toBeNull();
    expect(gateNow.blocked()).toEqual([]);
    gateNow.report(DESKTOP, 1, 'timeout');
    await expect(gateNow.check(DESKTOP, 1000)).resolves.toBe('unknown');
    expect(gateNow.onChange(() => undefined)).toBeTypeOf('function');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('installs one gate, refuses a second and gives the default back on uninstall', () => {
    const uninstall = installFolderGate(gate);
    expect(folderGate()).toBe(gate);
    expect(() => installFolderGate(gate)).toThrow(/already/);
    uninstall();
    expect(folderGate()).toBe(DISABLED_FOLDER_GATE);
    uninstall();
    expect(folderGate()).toBe(DISABLED_FOLDER_GATE);
  });
});
