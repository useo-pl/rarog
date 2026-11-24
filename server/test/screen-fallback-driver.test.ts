/**
 * The facts of the emergency approve button in the herdr driver (`drivers/herdr/screen-fallback.ts`): the mark of a
 * card, the card that waits through the grace, the change of the button on a judgement, and the checks right before
 * the key with their key and refused lines. The rule itself is `screen-fallback.test.ts`; the path from the card to
 * the key in the driver is `screen-fallback-key.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import type { CliDialogClass } from '@rarog/shared';
import { ScreenFallback } from '../src/drivers/herdr/screen-fallback.ts';
import type { ConsentNoHookSources, NoHookStanding } from '../src/drivers/herdr/consent-no-hook.ts';
import type { ActiveReq, DecisionCard } from '../src/herdr/dialogs/cards/build.ts';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import type { ConsentScreenKey } from '../src/herdr/dialogs/layer1/screen-key.ts';
import type { ConsentEffectiveMode } from '../src/herdr/dialogs/layer1/mode.ts';

const SESSION = 'session-1';
const INPUT = { command: 'npm test', description: 'Runs the tests' };
const MAIN_SCREEN = [
  '─'.repeat(40), ' Bash command', '', '   npm test', '   Runs the tests', '', ' Do you want to proceed?',
  ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel',
].join('\n');
const SUBAGENT_SCREEN = MAIN_SCREEN.replace(' Bash command', ' Bash command · from the Explore agent');

const JUDGED: NoHookStanding = {
  id: 'no-hook:1', sessionId: SESSION, pending: false, t0: 1_000, since: 500, graceEnd: 4_000,
  judgement: { cause: 'hooks-disabled', hookRunning: false, foreignHook: false },
};

interface World {
  mode: ConsentEffectiveMode | null;
  cliDialog: CliDialogClass | null;
  screen: string | null;
  standing: NoHookStanding | null;
  trace: boolean | null;
  hookWaits: boolean;
  restarting: boolean;
  /** `tool_use.id` of the transcript entry the driver holds for the waiting call; `null` = none. */
  pending: string | null;
  readonly lines: string[];
  readonly keys: { sessionId: string; key: ConsentScreenKey }[];
}

function setup(overrides: Partial<World> = {}, sources: Partial<ConsentNoHookSources> = {}): {
  world: World; module: ScreenFallback;
} {
  const world: World = {
    mode: 'all', cliDialog: 'permission', screen: MAIN_SCREEN, standing: JUDGED, trace: false, hookWaits: false,
    restarting: false, pending: 'toolu_1', lines: [], keys: [], ...overrides,
  };
  const consentNoHook: ConsentNoHookSources = {
    hookTrace: () => world.trace,
    facts: async () => null,
    hookRunning: async () => false,
    outsideWorkArea: () => false,
    statusline: async () => 'fresh',
    proofRules: () => null,
    restarting: () => world.restarting,
    screenKey: (sessionId, key) => { world.keys.push({ sessionId, key }); },
    ...sources,
  };
  const module = new ScreenFallback({
    deps: {
      // Mode unknown: the mode source fails.
      consentMode: () => {
        if (world.mode === null) throw new Error('mode');
        return world.mode;
      },
      consentNoHook, logger: (line) => { world.lines.push(line); }, now: () => 9_000,
    },
    inScope: true,
  }, {
    agentSessionId: () => SESSION,
    cliWaiting: () => world.cliDialog,
    screenText: () => world.screen,
    standing: () => world.standing,
    keyHookWaits: () => world.hookWaits,
    pendingCallId: () => world.pending,
  });
  return { world, module };
}

function card(active: Partial<ActiveReq> = {}): DecisionCard {
  return {
    active: { reqId: 'toolu_1', toolName: 'Bash', options: [], callId: 'toolu_1', ...active },
    event: {
      type: 'permission-request', reqId: 'toolu_1', toolName: 'Bash', input: INPUT, displayText: 'npm test',
      alwaysLabel: "Yes, and don't ask again",
    },
  };
}

describe('the mark of a card', () => {
  it('a card for a transcript entry in a judged episode without a trace gets the mark of that call', () => {
    const { module } = setup();
    const mark = module.stamp(card()).active.screenFallback;
    expect(mark).toMatchObject({
      cause: 'hooks-disabled', toolUseId: 'toolu_1', inputSha256: canonicalSha256(INPUT), since: JUDGED.t0,
    });
  });

  it.each<[string, Partial<World>, Partial<ActiveReq>]>([
    ['a card from the screen alone (no transcript entry)', {}, { callId: undefined }],
    ['a card with a measured consent mark', {}, { measuredConsent: { cliDialog: 'permission' } as never }],
    ['a hook trace now, after the judgement', { trace: true }, {}],
    ['a trace that cannot be read', { trace: null }, {}],
    ['a hook request in the way', { hookWaits: true }, {}],
    ['the restart grace', { restarting: true }, {}],
    ['an episode within its grace', { standing: { ...JUDGED, judgement: null, pending: true } }, {}],
    ['no standing episode', { standing: null }, {}],
    ['a subagent dialog in `main`', { mode: 'main', screen: SUBAGENT_SCREEN }, {}],
    ['no title line on screen', { screen: ' ❯ 1. Yes\n   2. No' }, {}],
    ['mode `off`', { mode: 'off' }, {}],
    ['mode unknown', { mode: null }, {}],
    ['a `sandbox` dialog', { cliDialog: 'sandbox' }, {}],
  ])('no mark: %s', (_name, world, active) => {
    const { module } = setup(world);
    expect(module.stamp(card(active)).active.screenFallback).toBeUndefined();
  });

  it('a subagent dialog in `all` gets the mark', () => {
    const { module } = setup({ screen: SUBAGENT_SCREEN });
    expect(module.stamp(card()).active.screenFallback).toBeDefined();
  });

  it('a card the rule does not concern comes back as it was, and a stale mark is taken off', () => {
    const { module, world } = setup();
    const plain = card({ callId: undefined });
    expect(module.stamp(plain)).toBe(plain);
    const marked = module.stamp(card());
    world.trace = true;
    expect(module.stamp(marked).active.screenFallback).toBeUndefined();
  });
});

describe('a card that waits through the grace', () => {
  const grace: NoHookStanding = { ...JUDGED, judgement: null, pending: true };

  it.each<[string, Partial<World>, boolean]>([
    ['within the grace, class `permission`', {}, true],
    ['within the grace, the class still on its way', { cliDialog: null }, true],
    ['a subagent dialog in `all`', { screen: SUBAGENT_SCREEN }, true],
    ['past the grace', { standing: JUDGED }, false],
    ['a `sandbox` dialog', { cliDialog: 'sandbox' }, false],
    ['mode `off`', { mode: 'off' }, false],
    ['mode `shadow`', { mode: 'shadow' }, false],
    ['a subagent dialog in `main`', { mode: 'main', screen: SUBAGENT_SCREEN }, false],
    ['a hook trace', { trace: true }, false],
    ['the restart grace', { restarting: true }, false],
  ])('%s → waits %s', (_name, world, waits) => {
    const { module } = setup({ standing: grace, ...world });
    const shown = module.stamp(card());
    expect(module.waits(shown)).toBe(waits);
  });

  it('a card from the screen alone never waits', () => {
    const { module } = setup({ standing: grace });
    expect(module.waits(module.stamp(card({ callId: undefined })))).toBe(false);
  });

  it('a card the `off` path gives no button (text cut by the footer) neither waits nor gets the mark', () => {
    const cut = (): DecisionCard => {
      const base = card();
      return { ...base, event: { ...base.event, truncation: { totalLines: 400, totalChars: 9_000 } } as never };
    };
    expect(setup({ standing: grace }).module.waits(cut())).toBe(false);
    expect(setup().module.stamp(cut()).active.screenFallback).toBeUndefined();
  });
});

describe('a judgement of the standing episode', () => {
  it('a card that waits is evaluated again', () => {
    const { module } = setup({ standing: { ...JUDGED, judgement: null, pending: true } });
    const shown = module.stamp(card());
    expect(module.waits(shown)).toBe(true);
    expect(module.judged(null)).toBe(true);
  });

  it('the button that comes or goes on the standing card drops it; the same button keeps it', () => {
    const { module, world } = setup({ standing: { ...JUDGED, judgement: { ...JUDGED.judgement!, hookRunning: true } } });
    const without = module.stamp(card());
    expect(without.active.screenFallback).toBeUndefined();
    expect(module.judged(without.active)).toBe(false);
    world.standing = JUDGED;
    expect(module.judged(without.active), 'the hook process left').toBe(true);
    const marked = module.stamp(card());
    expect(module.judged(marked.active)).toBe(false);
    world.trace = true;
    expect(module.judged(marked.active), 'a trace came').toBe(true);
    expect(module.judged({ ...marked.active }), 'another card').toBe(false);
  });
});

describe('the checks right before the key', () => {
  it('the same episode on fresh facts: the key of the call and the line fields, taken now', () => {
    const { module, world } = setup();
    const marked = module.stamp(card()).active;
    const verdict = module.keyGuard(marked, MAIN_SCREEN);
    expect(verdict).toEqual({
      ok: true,
      key: { toolName: 'Bash', inputSha256: canonicalSha256(INPUT), at: 9_000, since: JUDGED.t0 },
      line: { sessionId: SESSION, tool: 'Bash', cause: 'hooks-disabled', card: 'toolu_1', toolUseId: 'toolu_1' },
    });
    if (!verdict.ok) throw new Error('verdict');
    module.keyNoted(verdict);
    expect(world.keys, 'the note before the key, without a line').toEqual([{ sessionId: SESSION, key: verdict.key }]);
    expect(world.lines).toEqual([]);
    module.keySent(verdict);
    expect(world.lines).toEqual([
      `consent: screen fallback key — session ${SESSION}, tool Bash, cause hooks-disabled, card toolu_1,`
        + ' tool_use toolu_1',
    ]);
    expect(world.keys).toHaveLength(1);
  });

  it.each<[string, Partial<World>, string | null, string]>([
    ['another episode stands', { standing: { ...JUDGED, id: 'no-hook:2' } }, MAIN_SCREEN, 'judgement'],
    ['no episode stands', { standing: null }, MAIN_SCREEN, 'judgement'],
    ['a hook registration waits', { hookWaits: true }, MAIN_SCREEN, 'hook'],
    ['a hook trace now', { trace: true }, MAIN_SCREEN, 'trace'],
    ['the hook process now in `ps`', {
      standing: { ...JUDGED, judgement: { ...JUDGED.judgement!, hookRunning: true } },
    }, MAIN_SCREEN, 'hook-running'],
    ['a subagent title on the fresh screen in `main`', { mode: 'main' }, SUBAGENT_SCREEN, 'thread'],
    ['no fresh screen', {}, null, 'thread'],
    ['mode switched to `off`', { mode: 'off' }, MAIN_SCREEN, 'mode'],
    ['the registry no longer says `permission`', { cliDialog: null }, MAIN_SCREEN, 'class'],
    ['the restart grace', { restarting: true }, MAIN_SCREEN, 'restart'],
    ['the transcript holds another call as the waiting one', { pending: 'toolu_2' }, MAIN_SCREEN, 'card'],
    ['the transcript holds no waiting call', { pending: null }, MAIN_SCREEN, 'card'],
  ])('refused: %s', (_name, later, text, guard) => {
    const { module, world } = setup();
    const marked = module.stamp(card()).active;
    Object.assign(world, later);
    expect(module.keyGuard(marked, text)).toEqual({ ok: false, guard });
  });

  it('a card without the mark is refused, and the refused line names the guard and the card', () => {
    const { module, world } = setup();
    const plain = card().active;
    const verdict = module.keyGuard(plain, MAIN_SCREEN);
    expect(verdict).toEqual({ ok: false, guard: 'card' });
    module.refused(plain, 'card');
    expect(world.lines).toEqual([`consent: screen fallback refused — session ${SESSION}, tool Bash, guard card, card toolu_1`]);
  });

  it('a source or a logger that throws refuses or stays inside the module', () => {
    const { module } = setup({}, { hookTrace: () => { throw new Error('disk'); } });
    expect(module.stamp(card()).active.screenFallback).toBeUndefined();
    const logging = setup({}, { screenKey: () => { throw new Error('cycle'); } });
    const marked = logging.module.stamp(card()).active;
    const verdict = logging.module.keyGuard(marked, MAIN_SCREEN);
    if (!verdict.ok) throw new Error('verdict');
    expect(() => { logging.module.keyNoted(verdict); }).not.toThrow();
  });
});
