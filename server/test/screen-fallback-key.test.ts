/**
 * The emergency approve button in the herdr driver, from the card to the key on the fake herdr: a consent dialog in
 * channel mode that Rarog's hook left without a trace waits through the grace and then goes out with the "Yes" button
 * when the rule (`herdr/dialogs/screen-fallback.ts`) allows it; the button comes later on the same card when a refusing
 * fact mends, and the tap checks the rule again on a fresh screen right before the key. `off` and `shadow` keep the
 * card as it was. The facts module alone is `screen-fallback-driver.test.ts`.
 */
import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CliWaitingSignal } from '../src/cli-version.ts';
import { NO_HOOK_GRACE_MS, NO_HOOK_JUDGE_WAIT_MS } from '../src/drivers/herdr/consent-no-hook.ts';
import type { ConsentNoHookSources } from '../src/drivers/herdr/consent-no-hook.ts';
import { APPLIED, STALE, refused } from '../src/drivers/types.ts';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import type { SessionFacts } from '../src/herdr/dialogs/layer1/hook-list/session-facts.ts';
import type { ConsentEffectiveMode } from '../src/herdr/dialogs/layer1/mode.ts';
import type { ConsentScreenKey } from '../src/herdr/dialogs/layer1/screen-key.ts';
import type { ShadowConsentChannel, ShadowOutcome, ShadowRequest } from '../src/herdr/dialogs/shadow/channel.ts';
import {
  FIXTURES, SESSION, cleared, drivenClock, makeDriver, permissions, quiet, toolResultLine, toolUseLine,
  useDriverSandbox, userLine, waitFor,
} from './helpers/herdr-driver-atrapy.ts';
import type { Fixture } from './helpers/herdr-driver-atrapy.ts';

useDriverSandbox();

const WAITING: CliWaitingSignal = { kind: 'waiting', dialog: 'permission', version: '2.1.330' };
const MEASURED = await readFile(join(FIXTURES, 'measured', 'zgoda-bash-2.1.293.txt'), 'utf8');
const SUFFIX = ' · from the Explore agent';

/** The measured `Bash` dialog (CLI 2.1.293) with `command` in the whole frame; `subagent` adds the title suffix. */
function frame(command: string, subagent = false): string {
  const lines = MEASURED.split('\n');
  const top = lines.findIndex((line) => line.startsWith('╌'));
  const bottom = lines.findIndex((line, index) => index > top && line.startsWith('╌'));
  const body = [...lines.slice(0, top + 1), ` ${command}`, ...lines.slice(bottom)];
  return body.map((line) => (subagent && line === ' Bash command (unsandboxed)' ? `${line}${SUFFIX}` : line)).join('\n');
}

const input = (n: number): { command: string; description: string } => ({
  command: `echo step${String(n)}`, description: `Prints step ${String(n)}`,
});

/** `disableAllHooks` in a session layer: the hook was never called. */
const FACTS: SessionFacts = {
  episode: 'e', process: { pid: 4100 }, cwd: null, callCwd: undefined, verdict: { ok: true }, current: { ok: true },
  foreignHook: false, layers: { rarogEntry: true, disableAllHooks: true, allowManagedHooksOnly: false },
};

/** The pattern the consent audit reads the key line with, copied: the line format is shared with it. */
const LOG_VALUE = '[A-Za-z0-9_.:+-]+';
const SCREEN_KEY_LINE = new RegExp(`^consent: screen fallback key — session (${LOG_VALUE}), tool \\S+,`
  + ` cause \\S+, card \\S+, tool_use (${LOG_VALUE}|\\?)$`, 'u');

interface State {
  mode: ConsentEffectiveMode;
  /** Registrations of the session by their acceptance time, epoch ms. */
  registrations: number[];
  /** Any other hook trace (a dump, a request marker); `null` = cannot be read. */
  trace: boolean | null;
  hookRunning: boolean | null;
  restarting: boolean;
  facts: SessionFacts;
  /** A live registration without a channel card. */
  registration: boolean;
  /** A channel card holds the dialog. */
  channelCard: boolean;
  registry: CliWaitingSignal;
  /** The session facts read waits on it. */
  factsGate: Promise<void>;
  /**
   * Runs at the next screen read after a registry read of the send shield (the fresh read before the key); a promise
   * holds the read until it settles.
   */
  afterShield: (() => void | Promise<void>) | null;
  readonly keys: ConsentScreenKey[];
}

interface Rig {
  readonly fx: Fixture;
  readonly state: State;
  readonly advance: (ms: number) => Promise<void>;
  /** Server log lines of the consent channel. */
  readonly lines: (prefix: string) => string[];
}

const EPOCH = Date.UTC(2026, 7, 22, 12, 0, 0);

async function rig(opts: {
  mode?: ConsentEffectiveMode; state?: Partial<State>; agent?: 'idle' | 'blocked'; screen?: string; transcript?: string;
  shadow?: ShadowConsentChannel;
} = {}): Promise<Rig> {
  const clock = drivenClock();
  const logged: string[] = [];
  const state: State = {
    mode: opts.mode ?? 'main', registrations: [], trace: false, hookRunning: false, restarting: false, facts: FACTS,
    registration: false, channelCard: false, registry: WAITING, factsGate: Promise.resolve(), afterShield: null,
    keys: [], ...opts.state,
  };
  let shielded = false;
  const sources: ConsentNoHookSources = {
    hookTrace: (_id, since) => (state.registrations.some((at) => at >= since) ? true : state.trace),
    facts: async () => {
      await state.factsGate;
      return state.facts;
    },
    hookRunning: async () => state.hookRunning,
    outsideWorkArea: () => false,
    statusline: async () => 'fresh',
    proofRules: () => ({ main: 'channel', subagents: 'screen' }),
    restarting: () => state.restarting,
    screenKey: (_id, key) => { state.keys.push(key); },
  };
  const fx = await makeDriver({
    transcript: opts.transcript ?? userLine('build'),
    screen: opts.screen ?? '',
    agent: { status: opts.agent ?? 'idle', mode: 'manual' },
    deps: {
      scheduler: clock.scheduler, now: () => EPOCH + clock.scheduler.now(),
      consentMode: () => state.mode, consentNoHook: sources,
      consentRegistryRead: async () => {
        shielded = true;
        return state.registry;
      },
      consentCardLive: () => state.channelCard,
      consentRegistrationWaits: () => state.registration,
      logger: (line) => { logged.push(line); },
      ...(opts.shadow === undefined ? {} : { shadow: opts.shadow }),
    },
  });
  await waitFor(() => fx.events.some((e) => e.type === 'history'), 'history');
  const read = fx.client.readScreen.bind(fx.client);
  fx.client.readScreen = (...args) => {
    const step = shielded ? state.afterShield : null;
    if (step !== null) {
      state.afterShield = null;
      const held = step();
      if (held !== undefined) return held.then(() => read(...args));
    }
    return read(...args);
  };
  return {
    fx, state, advance: clock.advance,
    lines: (prefix) => logged.filter((line) => line.startsWith(`consent: ${prefix}`)),
  };
}

/**
 * The follower ticks on the driven clock but reads the transcript with real file I/O: small steps of the clock with
 * real pauses between them let a line just appended reach the driver.
 */
async function settle(r: Rig): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await r.advance(10);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * The `Bash` dialog `n` on screen and in the transcript. `order`: the registry class before herdr's `blocked` or after
 * it; `same-block`: no status change (the next dialog after a key). No card is awaited: it may wait through the grace.
 */
async function dialog(
  r: Rig, n: number, opts: { order?: 'registry-first' | 'blocked-first' | 'same-block'; subagent?: boolean } = {},
): Promise<void> {
  await appendFile(r.fx.transcript, toolUseLine(`toolu_${String(n)}`, 'Bash', input(n)));
  await settle(r);
  r.fx.client.screenText = frame(input(n).command, opts.subagent);
  const order = opts.order ?? 'registry-first';
  if (order !== 'blocked-first') r.fx.driver.noteCliWaiting?.(WAITING);
  if (order !== 'same-block') r.fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8 + n, title: '' });
  if (order === 'blocked-first') {
    await r.advance(500);
    r.fx.driver.noteCliWaiting?.(WAITING);
  }
}

/** The dialog is answered at the desk: the registry goes busy, herdr leaves `blocked`, the call ends. */
async function answeredAtDesk(r: Rig, n: number): Promise<void> {
  r.fx.driver.noteCliWaiting?.({ kind: 'active', version: '2.1.330' });
  r.fx.emit({ type: 'status', status: 'working', stateChangeSeq: 30 + n, title: '' });
  r.fx.client.screenText = '';
  await appendFile(r.fx.transcript, toolResultLine(`toolu_${String(n)}`));
  await settle(r);
  await r.advance(1_000);
}

/** Registry signals once a second, as the manager's read rhythm gives them. */
async function signals(r: Rig, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await r.advance(1_000);
    r.fx.driver.noteCliWaiting?.(r.state.registry);
  }
  await r.advance(100);
}

const keys = (r: Rig): (readonly string[])[] => r.fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys ?? []);
const cards = (r: Rig): { reqId: string; canAllow: boolean; always: boolean }[] => permissions(r.fx.events)
  .map((p) => ({ reqId: p.reqId, canAllow: p.canAllow !== false, always: p.alwaysLabel !== undefined }));

/** A tap on the card, with the clock moving so that the driver's step can finish. */
async function tap(r: Rig, reqId: string, decision: 'allow' | 'allow-always' = 'allow'): Promise<unknown> {
  const outcome = r.fx.driver.respondPermission(reqId, decision);
  await r.advance(200);
  return outcome;
}

describe('the emergency approve button from the card to the key', { timeout: 30_000 }, () => {
  it('`disableAllHooks`, main thread call: no card through the grace, then one card with the button, one key', async () => {
    const r = await rig();
    await dialog(r, 1);
    await r.advance(NO_HOOK_GRACE_MS - 300);
    expect(cards(r), 'no card within the grace').toEqual([]);
    await r.advance(600);
    expect(cards(r)).toEqual([{ reqId: 'toolu_1', canAllow: true, always: false }]);
    await expect(tap(r, 'toolu_1')).resolves.toEqual(APPLIED);
    expect(keys(r)).toEqual([['1']]);
    expect(r.lines('no hook')).toHaveLength(1);
    expect(r.lines('no hook')[0]).toContain(', cause hooks-disabled, tool Bash,');
    const line = `consent: screen fallback key — session ${SESSION}, tool Bash, cause hooks-disabled, card toolu_1,`
      + ' tool_use toolu_1';
    expect(r.lines('screen fallback')).toEqual([line]);
    expect(SCREEN_KEY_LINE.exec(line)?.slice(1)).toEqual([SESSION, 'toolu_1']);
    expect(r.state.keys).toEqual([{
      toolName: 'Bash', inputSha256: canonicalSha256(input(1)), at: expect.any(Number) as number,
      since: expect.any(Number) as number,
    }]);
    const [key] = r.state.keys;
    expect(key !== undefined && key.since <= key.at && key.at - key.since >= NO_HOOK_GRACE_MS).toBe(true);
    expect(r.lines('no approve button')).toEqual([]);
  });

  it('the registry class after herdr\'s `blocked` within the grace still gives one card with the button', async () => {
    const r = await rig();
    await dialog(r, 1, { order: 'blocked-first' });
    await r.advance(NO_HOOK_GRACE_MS);
    expect(cards(r)).toEqual([{ reqId: 'toolu_1', canAllow: true, always: false }]);
  });

  it('a registration before the tap: no key, 410, the card cleared', async () => {
    const r = await rig();
    await dialog(r, 1);
    await r.advance(NO_HOOK_GRACE_MS + 300);
    expect(cards(r).at(-1)?.canAllow).toBe(true);
    r.state.registration = true;
    r.state.registrations.push(EPOCH + NO_HOOK_GRACE_MS + 400);
    await expect(tap(r, 'toolu_1')).resolves.toEqual(STALE);
    expect(keys(r)).toEqual([]);
    expect(r.lines('screen fallback')).toEqual([
      `consent: screen fallback refused — session ${SESSION}, tool Bash, guard hook, card toolu_1`,
    ]);
    expect(cleared(r.fx.events).map((c) => c.reqId)).toContain('toolu_1');
  });

  it('a channel card that holds the dialog: no card from the screen and never a second button', async () => {
    const r = await rig({ state: { channelCard: true } });
    await dialog(r, 1);
    await r.advance(NO_HOOK_GRACE_MS * 2);
    expect(cards(r)).toEqual([]);
    expect(r.lines('screen fallback')).toEqual([]);
  });

  it('the hook process in `ps` past the grace: no button; once it is gone the same card gets it', async () => {
    const r = await rig({ state: { hookRunning: true } });
    await dialog(r, 1);
    await r.advance(NO_HOOK_GRACE_MS + 300);
    expect(cards(r)).toEqual([{ reqId: 'toolu_1', canAllow: false, always: false }]);
    await signals(r, 2);
    expect(cards(r), 'the doubt stays').toHaveLength(1);
    r.state.hookRunning = false;
    await signals(r, 2);
    expect(cards(r)).toEqual([
      { reqId: 'toolu_1', canAllow: false, always: false }, { reqId: 'toolu_1', canAllow: true, always: false },
    ]);
    expect(cleared(r.fx.events).map((c) => c.reqId)).toEqual(['toolu_1']);
    await expect(tap(r, 'toolu_1')).resolves.toEqual(APPLIED);
    expect(keys(r)).toEqual([['1']]);
  });

  it('a transient hook list verdict: no button; the next read `ok` gives it on the same card', async () => {
    const r = await rig({
      state: { facts: { ...FACTS, verdict: { ok: false, why: 'no-process' }, foreignHook: null } },
    });
    await dialog(r, 1);
    await r.advance(NO_HOOK_GRACE_MS + 300);
    expect(cards(r)).toEqual([{ reqId: 'toolu_1', canAllow: false, always: false }]);
    r.state.facts = FACTS;
    await signals(r, 2);
    expect(cards(r).map((c) => c.canAllow)).toEqual([false, true]);
    expect(new Set(cards(r).map((c) => c.reqId))).toEqual(new Set(['toolu_1']));
  });

  it('a subagent dialog identical to the main thread entry: no button in `main`, at once', async () => {
    const r = await rig({ mode: 'main' });
    await dialog(r, 1, { subagent: true });
    await r.advance(200);
    expect(cards(r), 'out at once, without the button').toEqual([{ reqId: 'toolu_1', canAllow: false, always: false }]);
    await r.advance(NO_HOOK_GRACE_MS * 2);
    expect(cards(r)).toHaveLength(1);
  });

  it('the same subagent dialog in `all`: the button after the grace', async () => {
    const r = await rig({ mode: 'all' });
    await dialog(r, 1, { subagent: true });
    await r.advance(NO_HOOK_GRACE_MS - 300);
    expect(cards(r)).toEqual([]);
    await r.advance(600);
    expect(cards(r)).toEqual([{ reqId: 'toolu_1', canAllow: true, always: false }]);
    await expect(tap(r, 'toolu_1')).resolves.toEqual(APPLIED);
    expect(keys(r)).toEqual([['1']]);
  });

  it('the next identical dialog after the key, without a status change, has its own grace, line and key', async () => {
    const r = await rig();
    await dialog(r, 1);
    await r.advance(NO_HOOK_GRACE_MS + 300);
    await tap(r, 'toolu_1');
    await appendFile(r.fx.transcript, toolResultLine('toolu_1'));
    // The CLI shows the next call at once, with the same input.
    await appendFile(r.fx.transcript, toolUseLine('toolu_2', 'Bash', input(1)));
    await settle(r);
    r.fx.driver.noteCliWaiting?.(WAITING);
    await r.advance(NO_HOOK_GRACE_MS - 500);
    expect(cards(r).map((c) => c.reqId), 'the second card waits through its own grace').toEqual(['toolu_1']);
    await r.advance(800);
    expect(cards(r)).toEqual([
      { reqId: 'toolu_1', canAllow: true, always: false }, { reqId: 'toolu_2', canAllow: true, always: false },
    ]);
    expect(r.lines('no hook')).toHaveLength(2);
    await tap(r, 'toolu_2');
    expect(keys(r)).toEqual([['1'], ['1']]);
    expect(r.lines('screen fallback key').map((line) => SCREEN_KEY_LINE.exec(line)?.[2])).toEqual(['toolu_1', 'toolu_2']);
  });

  it('a hook trace of the previous dialog neither gives nor takes the button of the next one', async () => {
    const r = await rig();
    await dialog(r, 1);
    r.state.registrations.push(EPOCH + 1_000);
    await r.advance(NO_HOOK_GRACE_MS + 300);
    expect(cards(r)).toEqual([{ reqId: 'toolu_1', canAllow: false, always: false }]);
    await answeredAtDesk(r, 1);
    await dialog(r, 2);
    await r.advance(NO_HOOK_GRACE_MS + 300);
    expect(cards(r).at(-1)).toEqual({ reqId: 'toolu_2', canAllow: true, always: false });
    expect(r.lines('no hook')).toHaveLength(1);
  });

  it('a server start at a standing dialog: no button within the restart grace, the same card gets it after', async () => {
    const transcript = userLine('build') + toolUseLine('toolu_1', 'Bash', input(1));
    const r = await rig({
      agent: 'blocked', screen: frame(input(1).command), transcript, state: { restarting: true },
    });
    r.fx.driver.noteCliWaiting?.(WAITING);
    await r.advance(NO_HOOK_GRACE_MS + 500);
    // A pane attached in `blocked` may show a card from the screen alone before the follower read the entry; such a
    // card never gets the button, so only the card of the entry counts here.
    const entry = (): { canAllow: boolean; always: boolean }[] => cards(r)
      .filter((c) => c.reqId === 'toolu_1').map(({ canAllow, always }) => ({ canAllow, always }));
    expect(entry()).toEqual([{ canAllow: false, always: false }]);
    expect(cards(r).filter((c) => c.canAllow)).toEqual([]);
    await signals(r, 2);
    expect(entry()).toHaveLength(1);
    r.state.restarting = false;
    await signals(r, 1);
    expect(entry().map((c) => c.canAllow)).toEqual([false, true]);
  });

  it('`allow-always` on the emergency card: `terminal-only`, no key', async () => {
    const r = await rig();
    await dialog(r, 1);
    await r.advance(NO_HOOK_GRACE_MS + 300);
    await expect(tap(r, 'toolu_1', 'allow-always')).resolves.toEqual(refused('terminal-only'));
    expect(keys(r)).toEqual([]);
    expect(r.lines('screen fallback')).toEqual([
      `consent: screen fallback refused — session ${SESSION}, tool Bash, guard always, card toolu_1`,
    ]);
  });

  it('the dialog changed after the tap: refused without a key', async () => {
    const r = await rig();
    await dialog(r, 1);
    await r.advance(NO_HOOK_GRACE_MS + 300);
    r.fx.client.screenText = frame('echo other');
    await expect(tap(r, 'toolu_1')).resolves.toEqual(refused('screen-changed'));
    expect(keys(r)).toEqual([]);
    expect(r.lines('screen fallback')).toEqual([
      `consent: screen fallback refused — session ${SESSION}, tool Bash, guard screen, card toolu_1`,
    ]);
  });

  it('the button lost before the tap (a hook trace now): 410 without a key, the card again without it', async () => {
    const r = await rig();
    await dialog(r, 1);
    await r.advance(NO_HOOK_GRACE_MS + 300);
    r.state.trace = true;
    await expect(tap(r, 'toolu_1')).resolves.toEqual(STALE);
    expect(keys(r)).toEqual([]);
    expect(r.lines('screen fallback')).toEqual([
      `consent: screen fallback refused — session ${SESSION}, tool Bash, guard trace, card toolu_1`,
    ]);
    await r.advance(200);
    expect(cards(r).map((c) => c.canAllow)).toEqual([true, false]);
  });

  it('the registry class no longer `permission` at the tap: the card gate refuses, 410 without a key', async () => {
    const r = await rig();
    await dialog(r, 1);
    await r.advance(NO_HOOK_GRACE_MS + 300);
    r.fx.driver.noteCliWaiting?.({ kind: 'waiting', dialog: 'dialog', version: '2.1.330' });
    await expect(tap(r, 'toolu_1')).resolves.toEqual(STALE);
    expect(keys(r)).toEqual([]);
    expect(r.lines('screen fallback')).toEqual([
      `consent: screen fallback refused — session ${SESSION}, tool Bash, guard class, card toolu_1`,
    ]);
  });

  it.each<[string, (s: State) => void]>([
    ['a registration without a card', (s) => { s.registration = true; }],
    ['a channel card', (s) => { s.channelCard = true; }],
  ])('%s that comes during the fresh screen read, past the send shield: 410 without a key', async (_name, comes) => {
    const r = await rig();
    await dialog(r, 1);
    await r.advance(NO_HOOK_GRACE_MS + 300);
    r.state.afterShield = () => { comes(r.state); };
    await expect(tap(r, 'toolu_1')).resolves.toEqual(STALE);
    expect(r.state.afterShield, 'the fresh read ran past the shield').toBeNull();
    expect(keys(r)).toEqual([]);
    expect(r.state.keys, 'no key note').toEqual([]);
    expect(r.lines('screen fallback')).toEqual([
      `consent: screen fallback refused — session ${SESSION}, tool Bash, guard hook, card toolu_1`,
    ]);
  });

  it('the next identical call read during the fresh screen read: 410 without a key, then its own grace', async () => {
    const r = await rig();
    await dialog(r, 1);
    await r.advance(NO_HOOK_GRACE_MS + 300);
    expect(cards(r)).toEqual([{ reqId: 'toolu_1', canAllow: true, always: false }]);
    // The dialog is answered at the desk while the tap goes, and the CLI shows the next call with the same input at
    // once: the screen, herdr's status and the registry stay, only the transcript moves on. The follower reads it on
    // real timers and the driver's clock stands still, so no evaluation comes between the read and the key.
    let released = false;
    r.state.afterShield = async () => {
      const before = r.fx.events.length;
      await appendFile(r.fx.transcript, toolResultLine('toolu_1') + toolUseLine('toolu_2', 'Bash', input(1)));
      await waitFor(() => r.fx.events.slice(before).some((e) => e.type === 'message'), 'the next call read');
      await quiet();
      released = true;
    };
    const outcome = r.fx.driver.respondPermission('toolu_1', 'allow');
    await waitFor(() => released, 'the fresh read');
    await r.advance(200);
    await expect(outcome).resolves.toEqual(STALE);
    expect(keys(r)).toEqual([]);
    expect(r.state.keys, 'no key note').toEqual([]);
    expect(r.lines('screen fallback')).toEqual([
      `consent: screen fallback refused — session ${SESSION}, tool Bash, guard card, card toolu_1`,
    ]);
    expect(cleared(r.fx.events).map((c) => c.reqId)).toContain('toolu_1');
    await r.advance(NO_HOOK_GRACE_MS - 800);
    expect(cards(r).map((c) => c.reqId), 'the next call waits through its own grace').toEqual(['toolu_1']);
    await r.advance(1_000);
    expect(cards(r).at(-1)).toEqual({ reqId: 'toolu_2', canAllow: true, always: false });
    expect(r.lines('no hook')).toHaveLength(2);
    await expect(tap(r, 'toolu_2')).resolves.toEqual(APPLIED);
    expect(keys(r)).toEqual([['1']]);
    expect(r.lines('screen fallback key').map((line) => SCREEN_KEY_LINE.exec(line)?.[2])).toEqual(['toolu_2']);
  });

  it.each<ConsentEffectiveMode>(['off', 'shadow'])(
    'the mode falls to `%s` before the tap: 410 without a key, the card again as the `off` path gives it',
    async (mode) => {
      const r = await rig();
      await dialog(r, 1);
      await r.advance(NO_HOOK_GRACE_MS + 300);
      expect(cards(r)).toEqual([{ reqId: 'toolu_1', canAllow: true, always: false }]);
      r.state.mode = mode;
      await expect(tap(r, 'toolu_1')).resolves.toEqual(STALE);
      expect(keys(r)).toEqual([]);
      expect(r.state.keys, 'no key note').toEqual([]);
      expect(r.lines('screen fallback')).toEqual([
        `consent: screen fallback refused — session ${SESSION}, tool Bash, guard mode, card toolu_1`,
      ]);
      expect(cleared(r.fx.events).map((c) => c.reqId)).toContain('toolu_1');
      await r.advance(200);
      expect(cards(r).at(-1)).toEqual({ reqId: 'toolu_1', canAllow: true, always: true });
      await expect(tap(r, 'toolu_1')).resolves.toEqual(APPLIED);
      expect(keys(r)).toEqual([['1']]);
      expect(r.lines('screen fallback'), 'the plain card writes no emergency line').toHaveLength(1);
    },
  );

  it('the mode falls to `shadow` before the tap: the shadow file written for the tap is revoked, no key', async () => {
    const written: ShadowOutcome = { result: 'written', key: 'dump-1', sessionId: SESSION };
    const prepared: ShadowRequest[] = [];
    const sent: { outcome: ShadowOutcome; sent: boolean }[] = [];
    const shadow: ShadowConsentChannel = {
      prepare: (request) => {
        prepared.push(request);
        return Promise.resolve(written);
      },
      keySent: (outcome, ok) => { sent.push({ outcome, sent: ok }); },
      release: () => Promise.resolve(0),
    };
    const r = await rig({ shadow });
    await dialog(r, 1);
    await r.advance(NO_HOOK_GRACE_MS + 300);
    expect(cards(r)).toEqual([{ reqId: 'toolu_1', canAllow: true, always: false }]);
    expect(prepared, 'no shadow step in `main`').toEqual([]);
    r.state.mode = 'shadow';
    await expect(tap(r, 'toolu_1')).resolves.toEqual(STALE);
    expect(keys(r)).toEqual([]);
    expect(r.state.keys, 'no key note').toEqual([]);
    expect(r.lines('screen fallback')).toEqual([
      `consent: screen fallback refused — session ${SESSION}, tool Bash, guard mode, card toolu_1`,
    ]);
    expect(prepared).toHaveLength(1);
    expect(prepared[0]).toMatchObject({ decision: 'allow', card: { toolName: 'Bash' } });
    expect(sent, 'the file written before the refusal is revoked once').toHaveLength(1);
    expect(sent[0]?.outcome).toBe(written);
    expect(sent[0]?.sent).toBe(false);
  });

  it('the key note stands before herdr gets the key, and the key line follows the key', async () => {
    const r = await rig();
    await dialog(r, 1);
    await r.advance(NO_HOOK_GRACE_MS + 300);
    const seen: { notes: number; lines: number }[] = [];
    const send = r.fx.client.sendKeys;
    r.fx.client.sendKeys = (paneId, sent) => {
      seen.push({ notes: r.state.keys.length, lines: r.lines('screen fallback key').length });
      return send(paneId, sent);
    };
    await expect(tap(r, 'toolu_1')).resolves.toEqual(APPLIED);
    expect(seen).toEqual([{ notes: 1, lines: 0 }]);
    expect(r.lines('screen fallback key')).toHaveLength(1);
  });

  it('a key herdr refuses: no key line, the note stays', async () => {
    const r = await rig();
    await dialog(r, 1);
    await r.advance(NO_HOOK_GRACE_MS + 300);
    r.fx.client.sendKeys = () => Promise.reject(new Error('socket'));
    await expect(tap(r, 'toolu_1')).resolves.not.toEqual(APPLIED);
    expect(r.state.keys).toHaveLength(1);
    expect(r.lines('screen fallback key')).toEqual([]);
  });

  it('the button stands through registry signals and a repeated herdr `blocked`: one card, the tap goes', async () => {
    const r = await rig();
    await dialog(r, 1);
    await r.advance(NO_HOOK_GRACE_MS + 300);
    for (let i = 0; i < 3; i += 1) {
      await signals(r, 1);
      r.fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 40 + i, title: '' });
      await r.advance(500);
    }
    expect(cards(r)).toEqual([{ reqId: 'toolu_1', canAllow: true, always: false }]);
    expect(cleared(r.fx.events)).toEqual([]);
    await expect(tap(r, 'toolu_1')).resolves.toEqual(APPLIED);
    expect(keys(r)).toEqual([['1']]);
  });

  it('a facts read that hangs past the grace: the card goes out without the button, then gets it', async () => {
    let release = (): void => {};
    const r = await rig();
    r.state.factsGate = new Promise((resolve) => { release = resolve; });
    await dialog(r, 1);
    await r.advance(NO_HOOK_GRACE_MS + NO_HOOK_JUDGE_WAIT_MS - 300);
    expect(cards(r), 'still waiting for the judgement').toEqual([]);
    await r.advance(600);
    expect(cards(r)).toEqual([{ reqId: 'toolu_1', canAllow: false, always: false }]);
    release();
    await r.advance(200);
    expect(cards(r).map((c) => c.canAllow)).toEqual([false, true]);
  });

  it.each<ConsentEffectiveMode>(['off', 'shadow'])('mode `%s`: the card at once, as the `off` path gives it', async (mode) => {
    const r = await rig({ mode });
    await dialog(r, 1);
    await r.advance(200);
    expect(cards(r)).toEqual([{ reqId: 'toolu_1', canAllow: true, always: true }]);
    await r.advance(NO_HOOK_GRACE_MS * 2);
    expect(cards(r)).toHaveLength(1);
    expect(r.lines('screen fallback')).toEqual([]);
  });
});
