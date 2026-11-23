/**
 * The consent channel does not swallow exceptions silently: an unexpected exception in a step of the channel
 * that the caller does not stop on (a timer tick, a session end, a release) leaves one line in the server log with
 * the place and the error text, and control flow stays as it was.
 *
 * Sentences this file guards:
 *
 * - `consentStep` (`herdr/consent-step.ts`): a step that throws or rejects gives exactly one line
 *   `consent: <place> failed: <error text>`, settles with `undefined`, and the next call of the step runs; a step
 *   without a failure gives its result and no line; the line has no quoted input and only one line of the message;
 * - `index.ts`: the five steps of the channel there (observation, registry signal, tick, registry sweep, channel off)
 *   go through `consentStep` with their place, and none is swallowed by `.catch(() => undefined)` or a bare `catch`;
 * - `manager.ts`: each of the six steps (herdr re-attach, turn end, revoke, pool end, release, decision) with a port
 *   that throws `TypeError` (thrown and rejected) leaves one line with its place, the next call of the port runs,
 *   and what the manager does around the step does not change.
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HerdrStatus } from '@rarog/shared';
import type { ConsentCardView } from '../src/herdr/dialogs/layer1/cards.ts';
import { consentStep } from '../src/herdr/consent-step.ts';
import type { HerdrAgent } from '../src/herdr/types.ts';
import { createManager } from '../src/sessions/manager.ts';
import type { ConsentManagerChannel, HerdrManagerDeps, Manager } from '../src/sessions/manager.ts';
import { AtrapaDrivera, AtrapaNadzorcy } from './helpers/atrapa-sesji.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PROJECT = '/Users/u/Projects/atlas';
const ENGINE = '55555555-5555-4555-8555-555555555555';
const KEY = 'w9:p72';
const PERM = '66666666-6666-4666-8666-666666666666-00';
const SECRET_COMMAND = 'rm -rf /Users/u/tajne';

describe('consentStep: one log line, the next step runs', () => {
  it('`onCard` that throws `TypeError` inside a tick: one line with the place and the error text, `undefined`,'
    + ' the next tick runs', async () => {
    const lines: string[] = [];
    let ticks = 0;
    let broken = true;
    const onCard = (): void => {
      if (broken) throw new TypeError("Cannot read properties of undefined (reading 'state')");
    };
    const tick = async (): Promise<void> => {
      ticks += 1;
      await Promise.resolve();
      onCard();
    };
    expect(await consentStep('tick', (line) => { lines.push(line); }, tick)).toBeUndefined();
    expect(lines).toEqual(["consent: tick failed: TypeError: Cannot read properties of undefined (reading 'state')"]);
    broken = false;
    expect(await consentStep('tick', (line) => { lines.push(line); }, tick)).toBeUndefined();
    expect(ticks).toBe(2);
    expect(lines).toHaveLength(1);
  });

  it('a synchronous throw is caught the same way, and the step starts in the caller\'s synchronous step', async () => {
    const lines: string[] = [];
    const order: string[] = [];
    const settled = consentStep('channel off', (line) => { lines.push(line); }, () => {
      order.push('step');
      throw new TypeError('boom');
    });
    order.push('after call');
    expect(order).toEqual(['step', 'after call']);
    expect(await settled).toBeUndefined();
    expect(lines).toEqual(['consent: channel off failed: TypeError: boom']);
  });

  it('a step without a failure gives its result and no line', async () => {
    const lines: string[] = [];
    expect(await consentStep('decision', (line) => { lines.push(line); }, async () => 42)).toBe(42);
    expect(lines).toEqual([]);
  });

  it('the line carries neither the quoted input nor further lines of the message; a non-`Error` shows its type',
    async () => {
      const lines: string[] = [];
      const log = (line: string): void => { lines.push(line); };
      await consentStep('observe', log, () => JSON.parse(`${SECRET_COMMAND} {`) as unknown);
      await consentStep('observe', log, () => { throw new Error(`first line\n${SECRET_COMMAND}`); });
      await consentStep('observe', log, () => { throw { command: SECRET_COMMAND } as unknown; });
      expect(lines).toHaveLength(3);
      expect(lines[0]).toMatch(/^consent: observe failed: SyntaxError: /);
      expect(lines[1]).toBe('consent: observe failed: Error: first line');
      expect(lines[2]).toBe('consent: observe failed: non-error value (object)');
      expect(lines.some((line) => line.includes('tajne'))).toBe(false);
    });

  it('a parser message quoting input with inner quotes or a line break keeps none of it', async () => {
    const lines: string[] = [];
    const log = (line: string): void => { lines.push(line); };
    await consentStep('observe', log, () => JSON.parse('["TAJNE", nope]') as unknown);
    await consentStep('observe', log, () => JSON.parse('bad TAJNE\nrest') as unknown);
    await consentStep('observe', log, () => { throw new Error('quoted `TAJNE` value'); });
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.startsWith('consent: observe failed: '))).toBe(true);
    expect(lines.some((line) => line.includes('TAJNE'))).toBe(false);
  });

  it('without a logger, and with a logger that throws, the step still settles', async () => {
    await expect(consentStep('tick', undefined, () => { throw new TypeError('boom'); })).resolves.toBeUndefined();
    await expect(consentStep('tick', () => { throw new Error('log'); }, () => { throw new TypeError('boom'); }))
      .resolves.toBeUndefined();
  });
});

describe('index.ts: the steps of the consent channel go through consentStep', () => {
  // The start order lives in `index.ts`, the consent channel steps in `bootstrap/consent.ts`.
  const source = ['server/src/index.ts', 'server/src/bootstrap/consent.ts']
    .map((file) => readFileSync(join(REPO, file), 'utf8')).join('\n');

  it.each(['observe', 'registry not waiting', 'tick', 'registry sweep', 'channel off'])(
    'place `%s` is a consentStep call', (place) => {
      expect(source).toContain(`consentStep('${place}'`);
    },
  );

  it('no `.catch(() => undefined)` is left in index.ts', () => {
    expect(source).not.toContain('.catch(() => undefined)');
  });

  it('the CLI registry nudge in manager.ts runs through `consentStep`: a throw there is no unhandled rejection', () => {
    const manager = readFileSync(fileURLToPath(new URL('../src/sessions/manager.ts', import.meta.url)), 'utf8');
    expect(manager).toContain("consentStep('nudge', this.#config.logger, () => this.#runConsentNudges())");
    expect(manager).not.toMatch(/void this\.#runConsentNudges\(\)/);
  });

  it('`observeConsent` has no bare `catch`', () => {
    const start = source.indexOf('async function observeConsent(');
    const end = source.indexOf('\n}\n', start);
    expect(start).toBeGreaterThan(-1);
    expect(source.slice(start, end)).not.toMatch(/catch\s*\{/);
  });
});

// ---------------------------------------------------------------------------
// Manager: steps of the channel with a port that throws
// ---------------------------------------------------------------------------

class FakeSupervisor extends AtrapaNadzorcy {
  override status(): HerdrStatus {
    return { available: true, agentCount: 0, readOnly: false, canLaunch: false };
  }

  protected nowyDriver(key: string): AtrapaDrivera {
    const driver = new AtrapaDrivera(key);
    driver.queue.push({ type: 'agent-state', state: 'idle', seen: true });
    return driver;
  }

  appear(agent: HerdrAgent): void {
    this.lifecycle.push({ type: 'appeared', agent });
  }

  reattach(agent: HerdrAgent): void {
    this.lifecycle.push({ type: 're-attached', agent });
  }
}

function makeDeps(): HerdrManagerDeps {
  return {
    sessionIdFor: (key: string) => `herdr-${key.replace(/[^a-z0-9]/gi, '-')}`,
    aliasFor: () => undefined,
    rememberAlias: () => undefined,
    assertSendable: (text) => ({ text: text.trim(), slash: null }),
    takeSendSlot: () => true,
    writeUploads: async () => [],
    writeUploadFiles: async () => [],
    sweepUploads: async () => undefined,
  };
}

function makeAgent(): HerdrAgent {
  return {
    key: KEY, paneId: KEY, agentSessionId: ENGINE, engine: 'claude', termId: null, cwd: PROJECT, status: 'idle',
    title: 'atlas', stateChangeSeq: 1, mode: 'auto', modeReadAt: 0, inScope: true, tabId: 'w9:t3',
    launchedByRarog: false, interactiveReady: true,
  };
}

function pendingCard(): ConsentCardView {
  return {
    permId: PERM, sessionId: ENGINE, promptId: '66666666-6666-4666-8666-666666666666', toolName: 'Bash',
    agentId: null, presentation: null, state: 'pending', canAllow: true, canDeny: true, canRelease: true,
    unavailable: null, cause: null, late: false, createdAt: Date.now(),
  };
}

async function flush(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((done) => { setImmediate(done); });
  }
}

type PortStep = 'reattached' | 'turnEnded' | 'revoke' | 'ended' | 'release' | 'decide';
type FailMode = 'thrown' | 'rejected';

const OK_OUTCOME = { ok: true, state: 'sent' } as const;

describe('manager.ts: a port of the consent channel that throws leaves one line', () => {
  let dataDir: string;
  const closers: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'rarog-kanal-wyjatek-'));
  });

  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
    await rm(dataDir, { recursive: true, force: true });
  });

  interface Built {
    manager: Manager;
    supervisor: FakeSupervisor;
    driver: AtrapaDrivera;
    id: string;
    lines: string[];
    calls: Record<PortStep, number>;
  }

  /** Manager with a port whose `failing` method throws `TypeError` on its first call only. */
  async function build(failing: PortStep, mode: FailMode, withCard = false): Promise<Built> {
    const calls: Record<PortStep, number> = {
      reattached: 0, turnEnded: 0, revoke: 0, ended: 0, release: 0, decide: 0,
    };
    const run = <T>(step: PortStep, value: T): T | Promise<T> => {
      calls[step] += 1;
      if (step === failing && calls[step] === 1) {
        const err = new TypeError(`port ${step} broke`);
        if (mode === 'thrown' || step === 'ended') throw err;
        return Promise.reject(err);
      }
      return value;
    };
    const consent: ConsentManagerChannel = {
      cards: () => (withCard ? [pendingCard()] : []),
      decide: (() => run('decide', Promise.resolve(OK_OUTCOME))) as ConsentManagerChannel['decide'],
      release: (() => run('release', Promise.resolve(OK_OUTCOME))) as ConsentManagerChannel['release'],
      revoke: (() => run('revoke', Promise.resolve([]))) as ConsentManagerChannel['revoke'],
      retire: async () => undefined,
      turnEnded: (() => run('turnEnded', Promise.resolve())) as ConsentManagerChannel['turnEnded'],
      reattached: (() => run('reattached', Promise.resolve())) as ConsentManagerChannel['reattached'],
      ended: () => { run('ended', undefined); },
    };
    const supervisor = new FakeSupervisor();
    const lines: string[] = [];
    const manager = await createManager({
      demo: false, dataDir, projects: [{ path: PROJECT, name: 'atlas' }], projectRoots: [], gitStatus: null,
      maxPanes: 6, herdrSupervisor: supervisor, herdrDeps: makeDeps(), herdrRoots: [PROJECT], herdrSend: true,
      consent, logger: (line) => { lines.push(line); },
    });
    await manager.ready;
    closers.push(async () => {
      await manager.dispose();
      supervisor.dispose();
    });
    supervisor.appear(makeAgent());
    await flush();
    const id = manager.list().find((s) => s.paneId === KEY)?.id ?? '';
    expect(id).not.toBe('');
    return { manager, supervisor, driver: supervisor.driver(KEY), id, lines, calls };
  }

  const failures = (lines: readonly string[]): string[] => lines.filter((line) => line.startsWith('consent: '));
  const MODES: FailMode[] = ['thrown', 'rejected'];

  it.each(MODES)('herdr re-attach (%s): one line `reattached`, the new driver is attached, the next re-attach'
    + ' calls the port again', async (mode) => {
    const b = await build('reattached', mode);
    const old = b.driver;
    b.supervisor.reattach(makeAgent());
    await flush();
    expect(failures(b.lines)).toEqual(['consent: reattached failed: TypeError: port reattached broke']);
    expect(old.disposals).toBe(1);
    expect(b.supervisor.driver(KEY)).not.toBe(old);
    b.supervisor.reattach(makeAgent());
    await flush();
    expect(b.calls.reattached).toBe(2);
    expect(failures(b.lines)).toHaveLength(1);
  });

  it.each(MODES)('turn end (%s): one line `turn end`, the next turn end calls the port again', async (mode) => {
    const b = await build('turnEnded', mode);
    for (let turn = 0; turn < 2; turn += 1) {
      b.driver.queue.push({ type: 'agent-state', state: 'working' });
      await flush();
      b.driver.queue.push({ type: 'agent-state', state: 'idle' });
      await flush();
    }
    expect(b.calls.turnEnded).toBe(2);
    expect(failures(b.lines)).toEqual(['consent: turn end failed: TypeError: port turnEnded broke']);
  });

  it.each(MODES)('session end (%s): one line `revoke`, the turn end and the pool end still run', async (mode) => {
    const b = await build('revoke', mode);
    b.driver.queue.push({ type: 'exit', ok: true });
    await flush();
    expect(failures(b.lines)).toEqual(['consent: revoke failed: TypeError: port revoke broke']);
    expect(b.calls.revoke).toBe(1);
    expect(b.calls.turnEnded).toBe(1);
    expect(b.calls.ended).toBe(1);
    expect(b.manager.get(b.id)?.state).toBe('done');
  });

  it('session end: a throwing pool end gives one line `pool end`; revoke and turn end ran before it', async () => {
    const b = await build('ended', 'thrown');
    b.driver.queue.push({ type: 'exit', ok: true });
    await flush();
    expect(failures(b.lines)).toEqual(['consent: pool end failed: TypeError: port ended broke']);
    expect(b.calls.revoke).toBe(1);
    expect(b.calls.turnEnded).toBe(1);
    expect(b.manager.get(b.id)?.state).toBe('done');
  });

  it.each(MODES)('interrupt with a pending channel card (%s): one line `release`, the interrupt goes out, the next'
    + ' interrupt releases again', async (mode) => {
    const b = await build('release', mode, true);
    expect(await b.manager.interrupt(b.id)).toBe(true);
    await flush();
    expect(b.driver.interrupts).toBe(1);
    expect(failures(b.lines)).toEqual(['consent: release failed: TypeError: port release broke']);
    // Past the debounce window of a repeated interrupt: the second one sends again.
    await new Promise<void>((done) => { setTimeout(done, 1_100); });
    await b.manager.interrupt(b.id);
    await flush();
    expect(b.calls.release).toBe(2);
    expect(failures(b.lines)).toHaveLength(1);
  });

  it.each(MODES)('decision from a device (%s): one line `decision`, the device gets the same refusal 422 as'
    + ' before, the next decision goes through', async (mode) => {
    const b = await build('decide', mode, true);
    expect(await b.manager.resolvePermission(b.id, PERM, 'deny', 'iPad')).toEqual({
      outcome: 'consent', consent: { status: 422, code: 'send-failed', sentence: 'dialogs.refuse.send-failed' },
    });
    expect(failures(b.lines)).toEqual(['consent: decision failed: TypeError: port decide broke']);
    expect(await b.manager.resolvePermission(b.id, PERM, 'deny', 'iPad')).toEqual({ outcome: 'ok' });
    expect(b.calls.decide).toBe(2);
    expect(failures(b.lines)).toHaveLength(1);
  });
});
