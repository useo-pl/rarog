/**
 * The consent-without-hook detector in the herdr driver (`drivers/herdr/consent-no-hook.ts`): one `no hook` line per
 * dialog episode past the grace, none when a hook trace comes within it, the episode start from the CLI registry
 * hold without a herdr block, one `no approve button` line per card identity, and no input content in any line.
 * The trace window of the registration itself (`consentHookTrace`, `bootstrap/consent.ts`) closes the file.
 */
import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { consentHookTrace } from '../src/bootstrap/consent.ts';
import type { ConsentLink } from '../src/bootstrap/consent.ts';
import { ConsentNoHook, NO_HOOK_EVALUATIONS, NO_HOOK_GRACE_MS } from '../src/drivers/herdr/consent-no-hook.ts';
import type { Scheduler } from '../src/drivers/runtime.ts';
import type { DecisionCard } from '../src/herdr/dialogs/cards/build.ts';
import { HOOK_MARKERS_DIRNAME, HOOK_PENDING_DIRNAME } from '../src/herdr/dialogs/hook/contract.ts';
import type { ConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import type { ConsentNoHookSources } from '../src/drivers/herdr/consent-no-hook.ts';
import type { SessionFacts } from '../src/herdr/dialogs/layer1/hook-list/session-facts.ts';
import type { ConsentEffectiveMode } from '../src/herdr/dialogs/layer1/mode.ts';
import {
  FIXTURES, SESSION, drivenClock, makeDriver, permissions, toolResultLine, toolUseLine, useDriverSandbox, userLine,
  waitFor,
} from './helpers/herdr-driver-atrapy.ts';
import type { Fixture } from './helpers/herdr-driver-atrapy.ts';

useDriverSandbox();

/** A marker that must never reach a log line: it stands in the command, the screen, the `cwd` and a settings path. */
const MARKER = 'ZQ7LEAK';
const WAITING_PERMISSION = { kind: 'waiting', dialog: 'permission', version: '2.1.330' } as const;
const BASH_MEASURED = readFileSync(join(FIXTURES, 'measured', 'zgoda-bash-2.1.293.txt'), 'utf8');

/** The measured `Bash` dialog (CLI 2.1.293, 61 columns) with `command` in the whole frame. */
function bashFrame(command: string): string {
  const lines = BASH_MEASURED.split('\n');
  const top = lines.findIndex((line) => line.startsWith('╌'));
  const bottom = lines.findIndex((line, index) => index > top && line.startsWith('╌'));
  return [...lines.slice(0, top + 1), ` ${command}`, ...lines.slice(bottom)].join('\n');
}

const input = (n: number): { command: string; description: string } => ({
  command: `echo ${MARKER}${String(n)}`, description: `Prints ${MARKER}`,
});

const FACTS: SessionFacts = {
  episode: 'e', process: { pid: 4100 }, cwd: `/srv/${MARKER}/other`, callCwd: undefined,
  verdict: { ok: false, why: `unreadable:/srv/${MARKER}/.claude/settings.json` },
  current: { ok: true }, foreignHook: false,
  layers: { rarogEntry: false, disableAllHooks: false, allowManagedHooksOnly: false },
};

interface Pane {
  readonly fx: Fixture;
  readonly advance: (ms: number) => Promise<void>;
  readonly now: () => number;
  /** Lines of the detector in the order logged. */
  readonly lines: () => string[];
  readonly sinces: number[];
  trace: boolean;
}

async function pane(opts: {
  mode?: ConsentEffectiveMode; sources?: Partial<ConsentNoHookSources>; status?: 'idle' | 'working';
  /** The logger throws on a line that starts with this text. */
  throwOn?: string;
} = {}): Promise<Pane> {
  const clock = drivenClock();
  const logged: string[] = [];
  const state = { trace: false, sinces: [] as number[] };
  const sources: ConsentNoHookSources = {
    hookTrace: (_id, since) => {
      state.sinces.push(since);
      return state.trace;
    },
    facts: async () => FACTS,
    hookRunning: async () => false,
    outsideWorkArea: () => false,
    statusline: async () => 'fresh',
    proofRules: () => ({ main: 'channel', subagents: 'screen' }),
    ...opts.sources,
  };
  const fx = await makeDriver({
    transcript: userLine('build'),
    screen: '',
    agent: { status: opts.status ?? 'idle', mode: 'manual' },
    deps: {
      scheduler: clock.scheduler, consentMode: () => opts.mode ?? 'all', consentNoHook: sources,
      logger: (line) => {
        if (opts.throwOn !== undefined && line.startsWith(opts.throwOn)) throw new Error('logger');
        logged.push(line);
      },
    },
  });
  await waitFor(() => fx.events.some((e) => e.type === 'history'), 'history');
  const result: Pane = {
    fx, advance: clock.advance, now: () => clock.scheduler.now(), sinces: state.sinces,
    lines: () => logged.filter((line) => line.startsWith('consent: no ')),
    get trace() { return state.trace; },
    set trace(value) { state.trace = value; },
  };
  return result;
}

/** A `Bash` dialog `n` on screen and in the transcript, with the registry `waiting: permission`. */
async function dialog(p: Pane, n: number, opts: { herdr?: boolean } = {}): Promise<void> {
  await appendFile(p.fx.transcript, toolUseLine(`toolu_${String(n)}`, 'Bash', input(n)));
  await settle(p);
  p.fx.client.screenText = bashFrame(input(n).command);
  p.fx.driver.noteCliWaiting?.(WAITING_PERMISSION);
  if (opts.herdr !== false) p.fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8 + n, title: '' });
  const before = permissions(p.fx.events).length;
  for (let i = 0; i < 100 && permissions(p.fx.events).length === before; i += 1) await p.advance(10);
  expect(permissions(p.fx.events).length, 'consent card').toBeGreaterThan(before);
}

/** The dialog is answered at the desk: the registry goes busy, herdr leaves `blocked`, the call ends. */
async function answered(p: Pane, n: number): Promise<void> {
  p.fx.driver.noteCliWaiting?.({ kind: 'active', version: '2.1.330' });
  p.fx.emit({ type: 'status', status: 'working', stateChangeSeq: 30 + n, title: '' });
  p.fx.client.screenText = '';
  await appendFile(p.fx.transcript, toolResultLine(`toolu_${String(n)}`));
  await settle(p);
  await p.advance(1_000);
}

/**
 * The follower ticks on the driven clock but reads the transcript with real file I/O: small steps of the clock with
 * real pauses between them let a line just appended reach the driver.
 */
async function settle(p: Pane): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await p.advance(10);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const noHook = (p: Pane): string[] => p.lines().filter((line) => line.startsWith('consent: no hook'));
const noButton = (p: Pane): string[] => p.lines().filter((line) => line.startsWith('consent: no approve button'));

describe('consent without a hook in the driver', { timeout: 20_000 }, () => {
  it('one `no hook` line per episode across evaluations, and a new line for a new dialog', async () => {
    const p = await pane();
    await dialog(p, 1);
    await p.advance(NO_HOOK_GRACE_MS - 200);
    expect(noHook(p), 'nothing within the grace').toEqual([]);
    await p.advance(400);
    expect(noHook(p)).toEqual([
      'consent: no hook — session ' + SESSION + ', cause not-in-session-hooks, tool Bash, cli 2.1.330, mode manual,'
        + ' thread main, after 3000 ms, hooks unreadable, statusline fresh, screen-button yes',
    ]);
    // Further evaluations of the same dialog: screen ticks, registry signals, a repeated herdr `blocked`.
    for (let i = 0; i < 3; i += 1) {
      p.fx.driver.noteCliWaiting?.(WAITING_PERMISSION);
      p.fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 20 + i, title: '' });
      await p.advance(2_000);
    }
    expect(noHook(p)).toHaveLength(1);

    await answered(p, 1);
    await dialog(p, 2);
    await p.advance(NO_HOOK_GRACE_MS + 500);
    expect(noHook(p)).toHaveLength(2);
    // The registration window of the second episode starts where the first one ended.
    expect(p.sinces.at(-1)).toBeGreaterThan(p.sinces[0] ?? 0);
  });

  it('a hook trace within the grace (the registration) gives no line', async () => {
    const p = await pane();
    await dialog(p, 1);
    await p.advance(1_000);
    p.trace = true;
    await p.advance(NO_HOOK_GRACE_MS * 3);
    expect(noHook(p)).toEqual([]);
  });

  it('a trace that comes while the facts are read wins over the line', async () => {
    let release = (): void => {};
    const p = await pane({
      sources: { facts: () => new Promise((resolve) => { release = () => { resolve(FACTS); }; }) },
    });
    await dialog(p, 1);
    await p.advance(NO_HOOK_GRACE_MS + 100);
    p.trace = true;
    release();
    await p.advance(100);
    expect(noHook(p)).toEqual([]);
  });

  it('a registry `active` while the facts are read, herdr still blocked, ends the episode without a line', async () => {
    let release = (): void => {};
    const p = await pane({
      sources: { facts: () => new Promise((resolve) => { release = () => { resolve(FACTS); }; }) },
    });
    await dialog(p, 1);
    await p.advance(NO_HOOK_GRACE_MS + 100);
    // A desk decision, then the registry waiting again before herdr reports anything.
    p.fx.driver.noteCliWaiting?.({ kind: 'active', version: '2.1.330' });
    p.fx.driver.noteCliWaiting?.(WAITING_PERMISSION);
    release();
    await p.advance(100);
    expect(noHook(p)).toEqual([]);
  });

  it('episode start from the CLI registry hold without a herdr block', async () => {
    const p = await pane({ status: 'working' });
    await p.advance(5_000);
    const start = p.now();
    await dialog(p, 1, { herdr: false });
    await p.advance(start + NO_HOOK_GRACE_MS - 100 - p.now());
    expect(noHook(p)).toEqual([]);
    await p.advance(200);
    expect(noHook(p)).toHaveLength(1);
    expect(noHook(p)[0]).toContain(', after 3000 ms,');
  });

  it('herdr taking over the block from the CLI registry hold keeps the episode, its start and its grace', async () => {
    const p = await pane({ status: 'working' });
    await p.advance(5_000);
    const start = p.now();
    await dialog(p, 1, { herdr: false });
    const cards = permissions(p.fx.events).length;
    await p.advance(1_000);
    p.fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 40, title: '' });
    await p.advance(start + NO_HOOK_GRACE_MS - 100 - p.now());
    expect(noHook(p)).toEqual([]);
    await p.advance(NO_HOOK_GRACE_MS * 2);
    expect(permissions(p.fx.events), 'the same card stays').toHaveLength(cards);
    expect(noHook(p)).toHaveLength(1);
    expect(noHook(p)[0]).toContain(', after 3000 ms,');
  });

  it('no `no hook` line with the channel closed (`off`)', async () => {
    const p = await pane({ mode: 'off' });
    await dialog(p, 1);
    await p.advance(NO_HOOK_GRACE_MS * 3);
    expect(p.lines()).toEqual([]);
  });

  it('one `no approve button` line per card identity', async () => {
    const p = await pane({ mode: 'main' });
    await dialog(p, 1);
    expect(permissions(p.fx.events).at(-1)?.canAllow).toBe(false);
    for (let i = 0; i < 3; i += 1) {
      p.fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 20 + i, title: '' });
      await p.advance(2_000);
    }
    expect(noButton(p)).toEqual([
      `consent: no approve button — session ${SESSION}, reason no-channel, tool Bash, channel main, rule channel,`
        + ' cli 2.1.330',
    ]);
    await answered(p, 1);
    await dialog(p, 2);
    expect(noButton(p)).toHaveLength(2);
  });

  it('an exception inside the detector does not stop the card, the poll or the next dialog', async () => {
    const p = await pane({ mode: 'main', throwOn: 'consent: no ' });
    await dialog(p, 1);
    expect(permissions(p.fx.events).at(-1)?.canAllow).toBe(false);
    await p.advance(NO_HOOK_GRACE_MS * 2);
    await answered(p, 1);
    await dialog(p, 2);
    expect(permissions(p.fx.events).at(-1)?.reqId).not.toBe(permissions(p.fx.events).at(-2)?.reqId);
  });

  it('no line carries the command, a path or the screen', async () => {
    const p = await pane({ sources: { hookRunning: async () => null, outsideWorkArea: (cwd) => cwd.includes(MARKER) } });
    await dialog(p, 1);
    await p.advance(NO_HOOK_GRACE_MS * 2);
    expect(noHook(p)).toHaveLength(1);
    expect(noHook(p)[0]).toContain('cause outside-work-area');
    for (const line of p.lines()) expect(line).not.toContain(MARKER);
  });
});

/** The detector alone over a port the test sets: scheduler time `t` is epoch `EPOCH + t`. */
interface Unit {
  readonly detector: ConsentNoHook;
  readonly port: { blockedNow: boolean; blockedSeq: number; blockedAt: number; answeredAt: number;
    cliWaiting: 'permission' | null; mode: ConsentEffectiveMode };
  /** Registrations of the session by their acceptance time in the scheduler clock. */
  readonly registrations: number[];
  readonly at: (t: number) => Promise<void>;
  readonly lines: () => string[];
}

const EPOCH = 1_800_000_000_000;

/** `throws`: the logger throws a `TypeError` for a line for which it holds, without logging it. */
function unit(sources: Partial<ConsentNoHookSources> = {}, throws: (line: string) => boolean = () => false): Unit {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const scheduler: Scheduler = {
    setTimeout: (fn, ms) => {
      seq += 1;
      timers.set(seq, { at: now + ms, fn });
      return seq;
    },
    clearTimeout: (handle) => { timers.delete(handle as number); },
    now: () => now,
  };
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
  };
  const port: Unit['port'] = {
    blockedNow: true, blockedSeq: 1, blockedAt: 0, answeredAt: 0, cliWaiting: 'permission', mode: 'all',
  };
  const registrations: number[] = [];
  const logged: string[] = [];
  const detector = new ConsentNoHook({
    deps: {
      consentMode: () => port.mode, now: () => EPOCH + now,
      logger: (line) => {
        if (throws(line)) throw new TypeError('logger');
        logged.push(line);
      },
      consentNoHook: {
        hookTrace: (_id, since) => registrations.some((acceptedAt) => EPOCH + acceptedAt >= since),
        facts: async () => FACTS, hookRunning: async () => false, outsideWorkArea: () => false,
        statusline: async () => 'fresh', proofRules: () => ({ main: 'channel', subagents: 'screen' }), ...sources,
      },
    },
    scheduler, inScope: true, cwd: '/srv/project',
  }, {
    disposed: () => false, agentSessionId: () => SESSION, blockedNow: () => port.blockedNow,
    blockedSeq: () => port.blockedSeq, blockedAt: () => port.blockedAt, answeredAt: () => port.answeredAt,
    cliWaiting: () => port.cliWaiting, cliVersion: () => '2.1.330', permissionMode: () => 'manual',
    screenText: () => null,
  });
  return {
    detector, port, registrations, lines: () => logged,
    at: async (target) => {
      for (;;) {
        await flush();
        const due = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = target;
      await flush();
    },
  };
}

/** A card of the `Bash` call `n` from the transcript, without the approve button of the `off` path. */
const callCard = (n: number): DecisionCard => ({
  active: { reqId: `req-${String(n)}`, toolName: 'Bash', origin: { source: 'jsonl', toolUseId: `toolu_${String(n)}` } },
  event: { type: 'permission-request', input: null },
}) as unknown as DecisionCard;

describe('consent-without-hook episodes', () => {
  it('a dialog replaced in place ends the previous episode at the replacement', async () => {
    const u = unit();
    await u.at(1_000);
    u.port.blockedAt = 1_000;
    u.detector.noteCard(callCard(1));
    // The registration of the first dialog, then the second dialog in the same block, without a key.
    u.registrations.push(1_500);
    await u.at(2_000);
    u.detector.noteCard(callCard(2));
    await u.at(2_000 + NO_HOOK_GRACE_MS + 100);
    expect(u.lines().filter((line) => line.startsWith('consent: no hook'))).toHaveLength(1);
  });

  it('a key of Rarog before the replacement ends the previous episode at the key', async () => {
    const u = unit();
    await u.at(1_000);
    u.port.blockedAt = 1_000;
    u.detector.noteCard(callCard(1));
    u.registrations.push(1_500);
    await u.at(1_800);
    u.port.answeredAt = 1_800;
    // The second dialog's own registration comes before its card: it is the trace of the second episode.
    u.registrations.push(1_900);
    await u.at(2_000);
    u.detector.noteCard(callCard(2));
    await u.at(2_000 + NO_HOOK_GRACE_MS + 100);
    expect(u.lines()).toEqual([]);
  });

  it('a failure after the facts are read is logged, and the next dialog still gets its line', async () => {
    let failures = 1;
    const u = unit({}, (line) => line.startsWith('consent: no hook —') && failures-- > 0);
    u.detector.noteCard(callCard(1));
    await u.at(NO_HOOK_GRACE_MS + 100);
    expect(u.lines()).toEqual(['consent: no hook detector failed (TypeError)']);
    u.port.blockedSeq = 2;
    u.port.blockedAt = NO_HOOK_GRACE_MS + 200;
    await u.at(NO_HOOK_GRACE_MS + 200);
    u.detector.noteCard(callCard(2));
    await u.at(NO_HOOK_GRACE_MS * 2 + 300);
    expect(noHookOf(u).filter((line) => line.startsWith('consent: no hook —'))).toHaveLength(1);
  });
});

/** The facts read held open until the test releases it: the evaluation past the grace is in flight meanwhile. */
function heldFacts(): { readonly sources: Partial<ConsentNoHookSources>; readonly release: () => void } {
  const waiting: (() => void)[] = [];
  return {
    sources: { facts: () => new Promise((resolve) => { waiting.push(() => { resolve(FACTS); }); }) },
    release: () => { for (const one of waiting.splice(0)) one(); },
  };
}

const noHookOf = (u: Unit): string[] => u.lines().filter((line) => line.startsWith('consent: no hook'));

describe('consent-without-hook evaluation in flight', () => {
  /** A dialog noted at 0 with the registry waiting; at the end the evaluation past the grace waits on the facts. */
  async function inFlight(): Promise<{ u: Unit; release: () => void }> {
    const held = heldFacts();
    const u = unit(held.sources);
    u.detector.noteCard(callCard(1));
    await u.at(NO_HOOK_GRACE_MS + 100);
    return { u, release: held.release };
  }

  it('a desk decision while the facts are read (the registry active, herdr still blocked) gives no line', async () => {
    const { u, release } = await inFlight();
    u.port.cliWaiting = null;
    u.detector.registrySignal(true);
    release();
    await u.at(NO_HOOK_GRACE_MS + 200);
    expect(noHookOf(u)).toEqual([]);
  });

  it('a desk decision and the next dialog waiting while the facts are read give no line for the first', async () => {
    const { u, release } = await inFlight();
    u.port.cliWaiting = null;
    u.detector.registrySignal(true);
    u.port.cliWaiting = 'permission';
    u.detector.registrySignal(false);
    release();
    await u.at(NO_HOOK_GRACE_MS + 200);
    expect(noHookOf(u)).toEqual([]);
  });

  it('the channel closed while the facts are read gives no line', async () => {
    const { u, release } = await inFlight();
    u.port.mode = 'off';
    release();
    await u.at(NO_HOOK_GRACE_MS + 200);
    expect(noHookOf(u)).toEqual([]);
  });

  it('a registry read without an answer while the facts are read postpones the line to the next waiting', async () => {
    const { u, release } = await inFlight();
    u.port.cliWaiting = null;
    u.detector.registrySignal(false);
    release();
    await u.at(NO_HOOK_GRACE_MS + 200);
    expect(noHookOf(u)).toEqual([]);
    u.port.cliWaiting = 'permission';
    u.detector.registrySignal(false);
    await u.at(NO_HOOK_GRACE_MS + 300);
    release();
    await u.at(NO_HOOK_GRACE_MS + 400);
    expect(noHookOf(u)).toHaveLength(1);
  });

  /**
   * The evaluation past the grace in flight, as in `inFlight`, with the facts and `ps` reads counted; `flap` lets the
   * registry lose the answer while the facts are read and then say `waiting: permission` again, `n` times.
   */
  async function counted(): Promise<{
    u: Unit; calls: { facts: number; hookRunning: number }; release: () => void; flap: (n: number) => Promise<void>;
  }> {
    const held = heldFacts();
    const calls = { facts: 0, hookRunning: 0 };
    const u = unit({
      facts: async (query) => {
        calls.facts += 1;
        return held.sources.facts?.(query) ?? null;
      },
      hookRunning: async () => {
        calls.hookRunning += 1;
        return false;
      },
    });
    u.detector.noteCard(callCard(1));
    let t = NO_HOOK_GRACE_MS + 100;
    await u.at(t);
    const flap = async (n: number): Promise<void> => {
      for (let i = 0; i < n; i += 1) {
        u.port.cliWaiting = null;
        u.detector.registrySignal(false);
        held.release();
        await u.at(t += 100);
        u.port.cliWaiting = 'permission';
        u.detector.registrySignal(false);
        await u.at(t += 100);
      }
    };
    return { u, calls, release: held.release, flap };
  }

  it('a registry flapping while the facts are read costs at most the evaluation budget per episode', async () => {
    const { u, calls, release, flap } = await counted();
    await flap(12);
    release();
    await u.at(NO_HOOK_GRACE_MS * 3);
    expect(calls).toEqual({ facts: NO_HOOK_EVALUATIONS, hookRunning: NO_HOOK_EVALUATIONS });
    expect(noHookOf(u)).toEqual([]);
  });

  it('flaps within the evaluation budget still give one line once the registry holds', async () => {
    const { u, calls, release, flap } = await counted();
    await flap(NO_HOOK_EVALUATIONS - 1);
    expect(calls.facts).toBe(NO_HOOK_EVALUATIONS);
    release();
    await u.at(NO_HOOK_GRACE_MS * 3);
    u.detector.registrySignal(false);
    await u.at(NO_HOOK_GRACE_MS * 4);
    expect(noHookOf(u)).toHaveLength(1);
  });

  it('an active registry read from before the dialog keeps the episode', async () => {
    const u = unit();
    u.port.cliWaiting = null;
    u.detector.noteCard(callCard(1));
    u.detector.registrySignal(true);
    await u.at(500);
    u.port.cliWaiting = 'permission';
    u.detector.registrySignal(false);
    await u.at(NO_HOOK_GRACE_MS + 100);
    expect(noHookOf(u)).toHaveLength(1);
  });
});

describe('consentHookTrace', () => {
  const link = (acceptedAt: number): ConsentLink => ({
    cycle: null,
    registry: { entries: () => [{ sessionId: SESSION, agentId: undefined, key: 'k', acceptedAt }] },
  } as unknown as ConsentLink);

  it.each([
    ['a registration accepted after the previous episode ended', 2_000, true],
    ['a registration accepted at the end of the previous episode', 1_000, true],
    ['a registration of the previous episode', 999, false],
  ] as const)('%s', async (_name, acceptedAt, trace) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'rarog-no-hook-'));
    expect(consentHookTrace(link(acceptedAt), dataDir, SESSION, 1_000)).toBe(trace);
  });

  it.each([
    ['a per-call dump on disk without a record', null, true],
    ['a per-call dump on disk whose record waits', 'sent', true],
    ['a per-call dump on disk whose record is settled', 'applied', false],
    ['a per-call dump on disk whose record is revoked', 'revoked', false],
  ] as const)('%s', async (_name, state, trace) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'rarog-no-hook-'));
    const key = callKey(1);
    await writeDump(dataDir, key);
    const cycle = fakeCycle({ records: state === null ? {} : { [key]: state } });
    expect(consentHookTrace({ cycle, registry: null }, dataDir, SESSION, 1_000)).toBe(trace);
  });

  // Request markers the pool has not taken yet: a marker written after the last channel observation.
  it.each([
    ['a request marker on disk without a record', callKey(2), {}, [], true],
    ['a request marker on disk whose record waits', callKey(2), { [callKey(2)]: 'pending' }, [], true],
    ['a request marker on disk whose record is settled', callKey(2), { [callKey(2)]: 'released' }, [], false],
    ['a request marker without a call key', 'anon-4100-1000', {}, [], true],
    ['a request marker of a request that left the pool', callKey(2), {}, [callKey(2)], false],
  ] as const)('%s', async (_name, name, records, exited, trace) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'rarog-no-hook-'));
    await writeMarker(dataDir, name);
    const cycle = fakeCycle({ records, exited });
    expect(consentHookTrace({ cycle, registry: null }, dataDir, SESSION, 1_000)).toBe(trace);
  });

  it('a request marker that cannot be read counts as a trace', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'rarog-no-hook-'));
    const dir = join(dataDir, HOOK_MARKERS_DIRNAME, SESSION);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${callKey(3)}.json`), '{');
    expect(consentHookTrace({ cycle: fakeCycle({}), registry: null }, dataDir, SESSION, 1_000)).toBe(true);
  });

  it.each([
    ['a pool candidate without a record', { candidates: [{ key: callKey(4), exitAt: null }] }, true],
    ['a pool candidate whose record waits', {
      candidates: [{ key: callKey(4), exitAt: null }], records: { [callKey(4)]: 'deciding' } }, true],
    ['a pool candidate whose record is settled', {
      candidates: [{ key: callKey(4), exitAt: null }], records: { [callKey(4)]: 'settled-at-desk' } }, false],
    ['a pool candidate that exited', { candidates: [{ key: callKey(4), exitAt: 1_200 }] }, false],
    ['a pool past its cap', { overflow: true }, true],
    ['a channel card holding the dialog', { cards: ['sent'] }, true],
    ['a channel card that no longer holds it', { cards: ['applied', 'unknown'] }, false],
    ['nothing at all', {}, false],
  ] as const)('%s', async (_name, cycle, trace) => {
    const dataDir = await mkdtemp(join(tmpdir(), 'rarog-no-hook-'));
    expect(consentHookTrace({ cycle: fakeCycle(cycle), registry: null }, dataDir, SESSION, 1_000)).toBe(trace);
  });

  it('a per-call dump that cannot be read leaves the scan incomplete, which counts as a trace', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'rarog-no-hook-'));
    const dir = join(dataDir, HOOK_PENDING_DIRNAME, SESSION);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${callKey(5)}.json`), JSON.stringify({ key: callKey(6), ...BASH_CALL }));
    const cycle = fakeCycle({ records: { [callKey(5)]: 'applied', [callKey(6)]: 'applied' } });
    expect(consentHookTrace({ cycle, registry: null }, dataDir, SESSION, 1_000)).toBe(true);
  });

  it('without the consent cycle every request on disk counts', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'rarog-no-hook-'));
    await writeDump(dataDir, callKey(7));
    expect(consentHookTrace({ cycle: null, registry: null }, dataDir, SESSION, 1_000)).toBe(true);
  });
});

/** The hook's request marker `<name>.json`: under the call key with the prompt, or `anon-<pid>-<start>` without. */
async function writeMarker(dataDir: string, name: string): Promise<void> {
  const dir = join(dataDir, HOOK_MARKERS_DIRNAME, SESSION);
  await mkdir(dir, { recursive: true });
  const anon = name.startsWith('anon-');
  const marker = {
    ...BASH_CALL, key: anon ? null : name, promptId: anon ? null : 'p1', pid: 4100, startedAt: 1_000,
  };
  await writeFile(join(dir, `${name}.json`), JSON.stringify(marker));
}

/** A per-call key of the hook: a prompt prefix and 32 hex digits. */
const callKey = (n: number): string => `p1-${String(n).padStart(32, '0')}`;

const BASH_CALL = {
  sessionId: SESSION, promptId: 'p1', pid: 61_000, startedAt: 1_000, toolName: 'Bash',
  toolInput: { command: 'true' }, cwd: '/srv/project', at: 1_100, inputSha256: 'a'.repeat(64),
};

/** The hook's per-call dump `<key>.json` of a `Bash` call, as the hook writes it while it waits. */
async function writeDump(dataDir: string, key: string): Promise<void> {
  const dir = join(dataDir, HOOK_PENDING_DIRNAME, SESSION);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${key}.json`), JSON.stringify({ key, ...BASH_CALL }));
}

/** The consent cycle as `consentHookTrace` reads it: cards, the session pool and record states by key. */
function fakeCycle(opts: {
  records?: Readonly<Record<string, string>>;
  cards?: readonly string[];
  candidates?: readonly { readonly key: string; readonly exitAt: number | null }[];
  exited?: readonly string[];
  overflow?: boolean;
}): ConsentCycle {
  const candidates = opts.candidates ?? [];
  return {
    cards: () => (opts.cards ?? []).map((state, n) => ({ permId: callKey(100 + n), state })),
    pool: () => ({
      candidates: candidates.map(({ key, exitAt }) => ({ dump: { key }, exitAt })),
      exited: (opts.exited ?? []).map((key) => ({ key, exitAt: 1_200 })), exitedAt: null, unlockedAt: null,
      overflow: opts.overflow === true,
    }),
    record: (_sessionId: string, key: string) => {
      const state = opts.records?.[key];
      return state === undefined ? null : { key, state };
    },
    poolKnows: (_sessionId: string, name: string) =>
      candidates.some((candidate) => candidate.key === name) || (opts.exited ?? []).includes(name),
  } as unknown as ConsentCycle;
}
