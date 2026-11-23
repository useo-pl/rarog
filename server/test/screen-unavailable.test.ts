/**
 * The reason of a consent card without `channel` and without the approve button (`screen-unavailable.ts`,
 * `PermissionRequest.unavailable`), in the order of `docs/dialogs.md`, "What stays in the terminal in `all`".
 *
 * Sentences this file guards:
 * - a degraded card (`input: null`) has no reason, also in channel mode `main` and `all`;
 * - a card the channel mode blocks takes the reason of its call's desk release, found ONLY by the call key of the hook
 *   dump the card came from: `settings-changed` (the hook list saw a settings file changed after the start),
 *   `other-hook` (another `PermissionRequest` hook), `unverified-hooks` (any other list verdict, or a changed file
 *   under the request's own directory that is not the session's), `terminal-only` (any other failed check);
 * - without such a release: `terminal-only` for a subagent request in `main`, `no-channel` for the rest;
 * - any other card that does not show its whole text: `truncated` or `hidden-chars`;
 * - two identical requests with different call keys each get the reason of their own release;
 * - the whole run: the hook list says `changed:`, the subagent request goes back to the desk with `other-hooks` at its
 *   first observation, the card built from that request's dump says `settings-changed`; the end of the engine session
 *   forgets it.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DriverEvent } from '../src/drivers/types.ts';
import type { ActiveReq } from '../src/herdr/dialogs/cards/build.ts';
import { consentOnlyEvent } from '../src/herdr/dialogs/consent-gate.ts';
import type { ConsentGateSource } from '../src/herdr/dialogs/consent-gate.ts';
import { decideCard } from '../src/herdr/dialogs/decide/decide.ts';
import type { DecideAction, DecideInput } from '../src/herdr/dialogs/decide/input.ts';
import { evaluationReqId, hookPendingFor } from '../src/herdr/dialogs/decide/sources.ts';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import { HOOK_PENDING_DIRNAME } from '../src/herdr/dialogs/hook/contract.ts';
import type { HookCallDump } from '../src/herdr/dialogs/hook/contract.ts';
import type { PendingHookTool } from '../src/herdr/dialogs/hook/dump.ts';
import { CONSENT_SECRET_BYTES, CONSENT_SUBAGENT_GRACE_MS } from '../src/herdr/dialogs/layer1/contract.ts';
import { createConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import type { ConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import { consentHookWhyOf } from '../src/herdr/dialogs/layer1/desk-reason.ts';
import type { ConsentDeskReason, ConsentDeskRelease } from '../src/herdr/dialogs/layer1/desk-reason.ts';
import type { ConsentEffectiveMode } from '../src/herdr/dialogs/layer1/mode.ts';
import { observeConsentSession } from '../src/herdr/dialogs/layer1/observe.ts';
import type { ConsentSessionHooks } from '../src/herdr/dialogs/layer1/observe.ts';
import type { ConsentSubagentFile } from '../src/herdr/dialogs/layer1/proof.ts';
import { createConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import type { ConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import { consentCardSha256 } from '../src/herdr/dialogs/layer1/sign.ts';
import { screenCardUnavailable } from '../src/herdr/dialogs/screen-unavailable.ts';
import type { ScreenCardFacts } from '../src/herdr/dialogs/screen-unavailable.ts';
import { resolveOptions } from '../src/herdr/dialogs/screen/resolve.ts';

const SESSION = '00000000-0000-4000-9000-0000000000e1';
const PROMPT = '00000000-0000-4000-9000-0000000000e2';
const AGENT = 'a0123456789abcdef';
const SESSION_CWD = '/Users/demo/Projects/birch';
const USER_SETTINGS = '/Users/demo/.claude/settings.json';
const keyOf = (seed: string): string => `${PROMPT}-${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`;
const KEY = keyOf('one');
const COMMAND = 'pnpm test server/test/screen-unavailable.test.ts';

const release = (
  reason: ConsentDeskReason, why: string | null, cwd: string | null = SESSION_CWD,
): ConsentDeskRelease => ({ reason, hooks: why === null ? null : consentHookWhyOf(why), cwd });

/** A card from a subagent's hook dump that the channel mode `all` blocks, released to the desk with `release`. */
function facts(over: Partial<ScreenCardFacts> = {}): ScreenCardFacts {
  return {
    input: { command: COMMAND }, displayText: COMMAND, blocked: true, mode: 'all',
    origin: { callKey: KEY, agentId: AGENT }, release: release('other-hooks', `changed:${USER_SETTINGS}`),
    sessionCwd: SESSION_CWD, ...over,
  };
}

describe('the reason of a card without `channel`, row by row', () => {
  const rows: readonly (readonly [string, Partial<ScreenCardFacts>, string | undefined])[] = [
    ['degraded card in `all`', { input: null }, undefined],
    ['degraded card in `main`', { input: null, mode: 'main', release: null }, undefined],
    ['degraded card with `off`', { input: null, blocked: false, mode: 'off', release: null }, undefined],
    ['released after the hook list, `changed:` outside the request directory', {}, 'settings-changed'],
    ['released after the hook list, `foreign:`', { release: release('other-hooks', 'foreign:user') }, 'other-hook'],
    ['released after the hook list, `hook-in:`', {
      release: release('other-hooks', 'hook-in:/Users/demo/.claude/agents/review.md'),
    }, 'other-hook'],
    ['released after the hook list, `io:EACCES`', {
      release: release('other-hooks', 'io:EACCES'),
    }, 'unverified-hooks'],
    ['released after the hook list, `marketplace-changed:`', {
      release: release('other-hooks', 'marketplace-changed:demo'),
    }, 'unverified-hooks'],
    ['released after the hook list, `why` unknown', { release: release('other-hooks', null) }, 'unverified-hooks'],
    ['released after another check (`file-behind`) while the list said `changed:`', {
      release: release('file-behind', `changed:${USER_SETTINGS}`),
    }, 'terminal-only'],
    ['subagent request in `main` without a release', { mode: 'main', release: null }, 'terminal-only'],
    ['subagent request in `all` without a release', { release: null }, 'no-channel'],
    ['main-thread card without a call key', { origin: {}, release: null }, 'no-channel'],
    ['card from the screen alone (no origin)', { origin: undefined, release: null }, 'no-channel'],
    ['release found but the card has no call key', { origin: { agentId: AGENT } }, 'no-channel'],
    ['unknown mode', { mode: null, release: null }, 'no-channel'],
    ['text cut by a footer, not blocked', {
      blocked: false, mode: 'off', release: null, truncation: { cut: 92, footer: 26 },
    }, 'truncated'],
    ['hidden direction mark, not blocked', {
      blocked: false, mode: 'off', release: null, displayText: `echo ${String.fromCodePoint(0x202e)}gnp.exe`,
    }, 'hidden-chars'],
    ['blocked card with a cut text: the channel reason wins', {
      truncation: { cut: 3, footer: 20 },
    }, 'settings-changed'],
    ['whole text, not blocked', { blocked: false, mode: 'off', release: null }, undefined],
  ];
  for (const [name, over, expected] of rows) {
    it(`${name} → ${expected ?? 'no field'}`, () => {
      expect(screenCardUnavailable(facts(over))).toBe(expected);
    });
  }

  describe('a changed file and the request directory', () => {
    const worktree = `${SESSION_CWD}/.claude/worktrees/agent-1`;
    it('under the request directory that is not the session directory → `unverified-hooks`', () => {
      expect(screenCardUnavailable(facts({
        release: release('other-hooks', `changed:${worktree}/.claude/settings.local.json`, worktree),
      }))).toBe('unverified-hooks');
    });
    it('the session settings, request in a worktree → `settings-changed`', () => {
      expect(screenCardUnavailable(facts({
        release: release('other-hooks', `changed:${SESSION_CWD}/.claude/settings.local.json`, worktree),
      }))).toBe('settings-changed');
    });
    it('under the request directory that is the session directory → `settings-changed`', () => {
      expect(screenCardUnavailable(facts({
        release: release('other-hooks', `changed:${SESSION_CWD}/.claude/settings.json`),
      }))).toBe('settings-changed');
    });
    it('request directory unknown → `unverified-hooks`', () => {
      expect(screenCardUnavailable(facts({ release: release('other-hooks', `changed:${USER_SETTINGS}`, null) })))
        .toBe('unverified-hooks');
    });
  });
});

type PermissionEvent = Extract<DriverEvent, { type: 'permission-request' }>;

function cardEvent(over: Partial<PermissionEvent> = {}): PermissionEvent {
  return {
    type: 'permission-request', reqId: 'hook:1', toolName: 'Bash', input: { command: COMMAND }, displayText: COMMAND,
    alwaysLabel: "Yes, and don't ask again for pnpm test commands", ...over,
  };
}

function active(origin: ActiveReq['origin']): ActiveReq {
  return { reqId: 'hook:1', toolName: 'Bash', options: [], ...(origin === undefined ? {} : { origin }) };
}

function gate(
  mode: ConsentEffectiveMode, releases: ReadonlyMap<string, ConsentDeskRelease> = new Map(),
): ConsentGateSource {
  return {
    consentMode: () => mode,
    consentDeskRelease: (sid, key) => (sid === SESSION ? releases.get(key) ?? null : null),
  };
}

const SESSION_OF = { engineSessionId: SESSION, cwd: SESSION_CWD };

describe('the consent gate puts the reason on the driver event', () => {
  for (const mode of ['main', 'all'] as const) {
    it(`degraded card in \`${mode}\`: no button, no reason`, () => {
      const event = consentOnlyEvent(
        cardEvent({ input: null }), active({ source: 'screen' }), gate(mode), 'permission', SESSION_OF,
      );
      expect(event).toMatchObject({ type: 'permission-request', canAllow: false });
      expect(event).not.toHaveProperty('unavailable');
    });
  }

  it('blocked card from the dump of a released call: no button, no "always", the reason of that call', () => {
    const event = consentOnlyEvent(
      cardEvent(), active({ source: 'hook', callKey: KEY, agentId: AGENT }),
      gate('all', new Map([[KEY, release('other-hooks', `changed:${USER_SETTINGS}`)]])), 'permission', SESSION_OF,
    );
    expect(event).toMatchObject({ canAllow: false, unavailable: 'settings-changed' });
    expect(event).not.toHaveProperty('alwaysLabel');
  });

  it('two identical requests with different call keys: each card gets the reason of its own release', () => {
    const second = keyOf('two');
    const releases = new Map([
      [KEY, release('other-hooks', `changed:${USER_SETTINGS}`)], [second, release('other-hooks', 'foreign:project')],
    ]);
    const reasonOf = (callKey: string): unknown => (consentOnlyEvent(
      cardEvent(), active({ source: 'hook', callKey, agentId: AGENT }), gate('all', releases), 'permission',
      SESSION_OF,
    ) as PermissionEvent).unavailable;
    expect(reasonOf(KEY)).toBe('settings-changed');
    expect(reasonOf(second)).toBe('other-hook');
  });

  it('the lookup throws: `no-channel`', () => {
    const throwing: ConsentGateSource = {
      consentMode: () => 'all', consentDeskRelease: () => { throw new Error('lookup failed'); },
    };
    const event = consentOnlyEvent(
      cardEvent(), active({ source: 'hook', callKey: KEY, agentId: AGENT }), throwing, 'permission', SESSION_OF,
    );
    expect(event).toMatchObject({ canAllow: false, unavailable: 'no-channel' });
  });

  it('mode `off` with a cut text: the button stays the manager\'s, the reason rides along', () => {
    const event = consentOnlyEvent(
      cardEvent({ truncation: { cut: 92, footer: 26 } }), active({ source: 'jsonl' }), gate('off'), 'permission',
      SESSION_OF,
    );
    expect(event).toMatchObject({ unavailable: 'truncated', alwaysLabel: expect.any(String) as unknown });
    expect(event).not.toHaveProperty('canAllow');
  });

  it('mode `off` with the whole text: the event stays as it was', () => {
    const event = cardEvent();
    expect(consentOnlyEvent(event, active({ source: 'jsonl' }), gate('off'), 'permission', SESSION_OF)).toEqual(event);
  });
});

describe('the call key travels from the per-session dump to the card origin', () => {
  const DIR = join(import.meta.dirname, 'fixtures', 'herdr');
  const SUB = readFileSync(join(DIR, 'dialog-bash-subagent-naglowek-2.1.302.txt'), 'utf8');
  const X = (JSON.parse(readFileSync(join(DIR, 'dialog-bash-subagent-naglowek-2.1.302.command.json'), 'utf8')) as {
    command: string;
  }).command;
  const raw = (over: Partial<PendingHookTool> = {}): PendingHookTool => ({
    toolName: 'Bash', toolInput: { command: X }, at: Date.parse('2026-11-13T23:27:00.000Z'),
    hookEventName: 'PermissionRequest', promptId: PROMPT, agentId: AGENT, ...over,
  });
  function input(text: string, hook: PendingHookTool | null): DecideInput {
    const hookPending = hookPendingFor(null, hook);
    return {
      pending: null, hookPending, text, reqId: evaluationReqId(null, hookPending, hook, 7), active: null, blockedSeq: 7,
      answeredSeq: -1, hookAnswersEnabled: true, deadAnswerKey: null, canRetry: false, answeredHookCall: null,
      decided: null, resolve: resolveOptions, excerpt: (screenText: string) => screenText.trim(), hookRaw: hook,
    };
  }
  const cardOf = (action: DecideAction): Extract<DecideAction, { kind: 'card' }> => {
    if (action.kind !== 'card') throw new Error(`expected a card, got ${action.kind}`);
    return action;
  };

  it('card built from the dump: `origin.callKey` is the dump\'s key', () => {
    const card = cardOf(decideCard(input(SUB, raw({ callKey: KEY }))));
    expect(card.card.active.origin).toMatchObject({ source: 'hook', callKey: KEY, agentId: AGENT });
  });

  it('dump of an older hook without the key: no `callKey`', () => {
    const card = cardOf(decideCard(input(SUB, raw())));
    expect(card.card.active.origin).not.toHaveProperty('callKey');
  });

  it('card built from a jsonl entry with the same Bash command: no `callKey` from the dump', () => {
    // The double proof matches by command and time only, so a dump of another call with the same command would
    // lend the card its desk release; the key binds the reason only to a card built from that dump.
    const at = '2026-11-13T23:26:59.900Z';
    const pending = { id: 'toolu_main_B', toolName: 'Bash', input: { command: X }, at };
    const base = input(SUB, raw({ callKey: KEY }));
    const card = cardOf(decideCard({ ...base, pending }));
    expect(card.card.active.origin).toMatchObject({ source: 'jsonl', toolUseId: 'toolu_main_B' });
    expect(card.card.active.origin).not.toHaveProperty('callKey');
  });
});

describe('the whole run: hook list `changed:` → desk release → card `settings-changed`', () => {
  const T0 = Date.parse('2026-11-14T00:27:00.000Z');
  let clock = T0;
  const now = (): number => clock;
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  interface Harness { readonly dir: string; readonly reg: ConsentRegistry; readonly cycle: ConsentCycle }

  function harness(): Harness {
    clock = T0;
    const dir = mkdtempSync(join(tmpdir(), 'rarog-screen-why-'));
    dirs.push(dir);
    const reg = createConsentRegistry({
      bootId: 'boot', send: () => true, sessions: () => [SESSION], log: () => {}, now,
    });
    reg.setScope('all');
    clock = T0 - 10_000;
    const cycle = createConsentCycle({
      dataDir: dir, bootId: 'boot', registry: reg, now, mode: () => 'all', log: () => {},
    });
    clock = T0;
    return { dir, reg, cycle };
  }

  function dumpOf(seed: string): HookCallDump {
    const toolInput = { command: COMMAND };
    return {
      key: keyOf(seed), sessionId: SESSION, promptId: PROMPT, agentId: AGENT, pid: process.pid,
      startedAt: clock - 1_000, toolName: 'Bash', toolInput, cwd: SESSION_CWD, at: clock - 900,
      inputSha256: canonicalSha256(toolInput), permissionMode: 'default',
    };
  }

  function hookStarts(h: Harness, dump: HookCallDump): void {
    const path = join(h.dir, HOOK_PENDING_DIRNAME, SESSION, `${dump.key}.json`);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(dump), { mode: 0o600 });
    const result = h.reg.register({
      key: dump.key, sessionId: SESSION, promptId: PROMPT, secret: randomBytes(CONSENT_SECRET_BYTES).toString('hex'),
      inputSha256: dump.inputSha256,
      cardSha256: consentCardSha256({
        sessionId: SESSION, toolName: dump.toolName, toolInput: dump.toolInput, cwd: dump.cwd, agentId: AGENT,
        permissionMode: dump.permissionMode ?? null,
      }),
      pid: dump.pid, startedAt: dump.startedAt, agentId: AGENT,
    });
    expect(result.status).toBe(200);
  }

  const file: ConsentSubagentFile = {
    partial: false, toolUses: [], results: [], settled: true, caughtUp: true,
    agent: { launch: { at: T0 - 5_000 }, ends: [], settled: true },
  };

  /** One observation in `all` where only the hook list fails, with `why` as the list's verdict. */
  async function step(h: Harness, why: string | null): Promise<void> {
    const sessionHooks: ConsentSessionHooks = Object.assign(
      async (): Promise<ReadonlySet<string>> => new Set<string>(),
      { answer: async () => ({ keys: new Set<string>(), why }) },
    );
    await observeConsentSession(h.cycle, {
      dataDir: h.dir, sessionId: SESSION, registry: { kind: 'active', at: clock }, transcript: null, screen: null, now,
      proofRule: 'screen', liveness: async (processes) => new Map(processes.map((proc) => [proc.pid, true])),
      subagentTurns: async (requests) => requests.map(() => file),
      hidden: { topLoss: { note: () => {}, lostAt: () => null }, sessionHooks },
    });
  }

  it('the request goes back at its first observation, the card from its dump says `settings-changed`; the session'
    + ' end forgets it', async () => {
    const h = harness();
    const dump = dumpOf('run');
    hookStarts(h, dump);
    // `changed:` is a durable verdict of the list: no 10 s wait.
    await step(h, `changed:${USER_SETTINGS}`);
    expect(h.cycle.record(SESSION, dump.key)).toMatchObject({ releaseCause: 'desk-fallback' });
    expect(h.cycle.deskRelease(SESSION, dump.key)).toEqual({
      reason: 'other-hooks', hooks: { code: 'changed', detail: USER_SETTINGS }, cwd: SESSION_CWD,
    });

    const deps: ConsentGateSource = {
      consentMode: () => 'all', consentDeskRelease: (sid, key) => h.cycle.deskRelease(sid, key),
    };
    const card = (): DriverEvent => consentOnlyEvent(
      cardEvent(), active({ source: 'hook', callKey: dump.key, agentId: AGENT }), deps, 'permission', SESSION_OF,
    );
    expect(card()).toMatchObject({ canAllow: false, unavailable: 'settings-changed' });

    h.cycle.endPool(SESSION);
    expect(h.cycle.deskRelease(SESSION, dump.key)).toBeNull();
    expect(card()).toMatchObject({ canAllow: false, unavailable: 'no-channel' });
  });

  it('the list could not read a file (`io:EACCES`): `unverified-hooks`', async () => {
    const h = harness();
    const dump = dumpOf('io');
    hookStarts(h, dump);
    await step(h, 'io:EACCES');
    clock = T0 + CONSENT_SUBAGENT_GRACE_MS;
    await h.cycle.tick();
    const reason = screenCardUnavailable(facts({ release: h.cycle.deskRelease(SESSION, dump.key) }));
    expect(reason).toBe('unverified-hooks');
  });

  it('a record that is still `pending` has no desk release', async () => {
    const h = harness();
    const dump = dumpOf('pending');
    hookStarts(h, dump);
    // A transient verdict waits the 10 s, so the record is still `pending` after the first observation.
    await step(h, 'io:EACCES');
    expect(h.cycle.card(SESSION, dump.key)).toMatchObject({ state: 'pending', canAllow: false });
    expect(h.cycle.deskRelease(SESSION, dump.key)).toBeNull();
  });
});
