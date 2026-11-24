/**
 * Session facts without a hook dump (`server/src/herdr/dialogs/layer1/hook-list/session-facts.ts`): one read of the
 * session process, its `cwd`, the call `cwd` from the transcript entry, the hook list verdict and the settings layers.
 *
 * Sentences this file guards:
 *
 * - the settings layers say whether Rarog's `PermissionRequest` entry stands in them, `disableAllHooks` after the
 *   settings precedence (managed, `--settings`, local, project, user) and `allowManagedHooksOnly` from the managed tier
 *   only: every layer that may be loaded counts down to the first tier where a surely loaded layer sets the key
 *   (`--settings`, user `settings.json`, the project and local file of the session `cwd`; none of the last three with
 *   `--setting-sources`; no managed source), the default `false` without one, and the values must agree;
 * - with `changed` the read goes on over the current content (no start check, also for a marketplace refresh) and
 *   says separately whether it holds a foreign hook, in the settings layers, plugins and definitions alike;
 * - the cache dies with a new process, a new registry `cwd` and a new episode; a negative read is read again in the
 *   same episode after its kind's retry time; a read whose process or registry `cwd` changed by its end gives no
 *   facts, and a registry `cwd` that moves during the read and back is still scanned;
 * - the call `cwd` is the transcript entry's `cwd` when absolute, never a guess, and follows each query;
 * - the subagent hook list reads as before: a facts read between two of its calls changes neither its answer nor its
 *   verdict log.
 */
import { describe, expect, it } from 'vitest';
import {
  HOOK_LIST_RETRY_MS, HOOK_LIST_TRANSIENT_RETRY_MS, createSessionHookList,
} from '../src/herdr/dialogs/layer1/hook-list/hook-list.ts';
import type { HookListVerdict } from '../src/herdr/dialogs/layer1/hook-list/hook-list.ts';
import { createSessionFacts } from '../src/herdr/dialogs/layer1/hook-list/session-facts.ts';
import type { SessionFacts, SessionFactsQuery } from '../src/herdr/dialogs/layer1/hook-list/session-facts.ts';
import type { HookCallDump } from '../src/herdr/dialogs/hook/contract.ts';
import {
  CLAUDE, CWD, HOME, MANAGED, NOW, PID, PROCESS_START, RAROG, REGISTRY_START, SESSION, UST, fake, foreignLayer, put,
  rarogLayer, sessionIo,
} from './helpers/hook-list-io.ts';
import type { Fake, SessionProcess } from './helpers/hook-list-io.ts';

const USER = `${CLAUDE}/settings.json`;
const PROJECT = `${CWD}/.claude/settings.json`;
const LOCAL = `${CWD}/.claude/settings.local.json`;
const ROOT_LOCAL = '/w/repo/.claude/settings.local.json';
const ABOVE_LOCAL = '/w/.claude/settings.local.json';
/** A linked git worktree outside its main checkout. */
const MAIN = '/w/main';
const TREE = '/w/trees/feature';

/**
 * The session facts read over the fake, with a clock and the session process; `reads` counts `ps` calls. `onEntry`
 * runs before each registry entry ask with its number (from 1): a scene change at a known point of the read.
 */
function factsOf(
  f: Fake, clock = { now: NOW }, proc: SessionProcess = { pid: PID, start: PROCESS_START },
  onEntry: (call: number) => void = () => {},
): {
  readonly read: ReturnType<typeof createSessionFacts>; readonly reads: { count: number };
} {
  const { io, reads } = sessionIo(f, clock, proc);
  let calls = 0;
  const read = createSessionFacts({
    home: HOME, accepted: [RAROG], io, now: () => clock.now, platform: 'darwin',
    entry: async () => {
      calls += 1;
      onEntry(calls);
      return { pid: proc.pid, startedAt: proc.start + 3_000 };
    },
  });
  return { read, reads };
}

const ask = (over: Partial<SessionFactsQuery> = {}): SessionFactsQuery => ({ sessionId: SESSION, episode: 'e1', ...over });

/** Facts of one scene: `--settings` with Rarog's hook alone (as in measured sessions) plus `setup`. */
async function scene(setup: (f: Fake) => void = () => {}, args?: string): Promise<SessionFacts | null> {
  const f = fake(args === undefined ? {} : { args });
  put(f, UST, rarogLayer());
  setup(f);
  return factsOf(f).read(ask());
}

const no = (why: string): HookListVerdict => ({ ok: false, why });

describe('session facts: process, cwd, verdict and layers without a hook dump', () => {
  it('a clean session: the registry process and cwd, `ok`, Rarog entry, hooks on, no foreign hook', async () => {
    expect(await scene()).toEqual({
      episode: 'e1', process: { pid: PID, startedAt: PROCESS_START + 3_000 }, cwd: CWD, callCwd: undefined,
      verdict: { ok: true }, current: { ok: true }, foreignHook: false,
      layers: { rarogEntry: true, disableAllHooks: false, allowManagedHooksOnly: false },
    });
  });

  it('a session without Rarog entry in any layer: `ok` (no foreign hook) but no Rarog entry', async () => {
    const facts = await scene((f) => { put(f, USER, { permissions: { allow: ['Bash(ls:*)'] } }); }, 'claude');
    expect(facts?.verdict).toEqual({ ok: true });
    expect(facts?.layers?.rarogEntry).toBe(false);
  });

  it.each([
    ['user', USER], ['project', PROJECT], ['local', LOCAL],
  ])('Rarog entry in the %s layer counts', async (_tier, file) => {
    const facts = await scene((f) => { put(f, file, rarogLayer()); }, 'claude');
    expect(facts?.layers?.rarogEntry).toBe(true);
  });

  it('Rarog command with `args` or of another type is no Rarog entry', async () => {
    const facts = await scene((f) => {
      put(f, USER, rarogLayer(RAROG, { args: ['--x'] }));
      put(f, PROJECT, rarogLayer(RAROG, { type: 'http' }));
    }, 'claude');
    expect(facts?.layers?.rarogEntry).toBe(false);
  });

  it.each<[string, (f: Fake) => void, boolean | null, string?]>([
    ['project `true`', (f) => { put(f, PROJECT, { disableAllHooks: true }); }, true],
    ['project `true`, local `false`', (f) => {
      put(f, PROJECT, { disableAllHooks: true });
      put(f, LOCAL, { disableAllHooks: false });
    }, false],
    ['user `true`, project `false`', (f) => {
      put(f, USER, { disableAllHooks: true });
      put(f, PROJECT, { disableAllHooks: false });
    }, false],
    ['local `true`, user `false`', (f) => {
      put(f, LOCAL, { disableAllHooks: true });
      put(f, USER, { disableAllHooks: false });
    }, true],
    ['`--settings` `false`, local `true`', (f) => {
      put(f, UST, { ...rarogLayer(), disableAllHooks: false });
      put(f, LOCAL, { disableAllHooks: true });
    }, false],
    ['managed `true`, `--settings` `false` (the managed source may not be the one in force)', (f) => {
      put(f, `${MANAGED}/managed-settings.json`, { disableAllHooks: true });
      put(f, UST, { ...rarogLayer(), disableAllHooks: false });
    }, null],
    ['two local files of the read superset disagree', (f) => {
      put(f, LOCAL, { disableAllHooks: true });
      put(f, ROOT_LOCAL, { disableAllHooks: false });
    }, null],
    ['user `true`, a local file above the git root `false`', (f) => {
      f.dirs.add('/w/repo/.git');
      put(f, USER, { disableAllHooks: true });
      put(f, ABOVE_LOCAL, { disableAllHooks: false });
    }, null],
    ['user `false`, a local file above the git root `true`', (f) => {
      f.dirs.add('/w/repo/.git');
      put(f, USER, { disableAllHooks: false });
      put(f, ABOVE_LOCAL, { disableAllHooks: true });
    }, null],
    ['the key in no layer, with a layer in every tier', (f) => {
      for (const file of [`${MANAGED}/managed-settings.json`, ABOVE_LOCAL, ROOT_LOCAL, LOCAL, PROJECT, USER]) {
        put(f, file, { permissions: { allow: [] } });
      }
    }, false],
    ['a value that is not a boolean', (f) => { put(f, PROJECT, { disableAllHooks: 'true' }); }, null],
    ['inline `--settings` `false` (argument bounds are lost in `ps`, so it may be prompt text), project `true`', (f) => {
      put(f, PROJECT, { disableAllHooks: true });
    }, null, `claude --settings ${UST} --settings {"disableAllHooks":false}`],
    ['`--setting-sources` in the arguments, project `true`', (f) => {
      put(f, PROJECT, { disableAllHooks: true });
    }, null, `claude --setting-sources user --settings ${UST}`],
    ['`--setting-sources` in the arguments, project `false`', (f) => {
      put(f, PROJECT, { disableAllHooks: false });
    }, false, `claude --setting-sources user --settings ${UST}`],
    ['`--setting-sources` in the arguments, `--settings` `true` above project `false`', (f) => {
      put(f, UST, { ...rarogLayer(), disableAllHooks: true });
      put(f, PROJECT, { disableAllHooks: false });
    }, true, `claude --setting-sources user --settings ${UST}`],
  ])('`disableAllHooks` by precedence: %s', async (_case, setup, expected, args) => {
    expect((await scene(setup, args))?.layers?.disableAllHooks).toBe(expected);
  });

  it.each([
    ['the main checkout\'s project file alone: it may not be loaded', `${MAIN}/.claude/settings.json`, null],
    ['the worktree\'s own project file: the session `cwd`', `${TREE}/.claude/settings.json`, true],
  ])('`disableAllHooks` in a linked worktree, %s', async (_case, file, expected) => {
    const f = fake({ cwd: TREE });
    put(f, UST, rarogLayer());
    put(f, `${MAIN}/.git/HEAD`, 'ref: refs/heads/main\n');
    put(f, `${MAIN}/.git/worktrees/feature/commondir`, '../..\n');
    put(f, `${TREE}/.git`, `gitdir: ${MAIN}/.git/worktrees/feature\n`);
    put(f, file, { disableAllHooks: true });
    expect((await factsOf(f).read(ask()))?.layers?.disableAllHooks).toBe(expected);
  });

  it.each<[string, (f: Fake) => void, boolean | null]>([
    ['managed file `true`', (f) => { put(f, `${MANAGED}/managed-settings.json`, { allowManagedHooksOnly: true }); }, null],
    ['server-managed copy `true`', (f) => { put(f, `${CLAUDE}/remote-settings.json`, { allowManagedHooksOnly: true }); },
      null],
    ['every managed source `false`', (f) => {
      put(f, `${MANAGED}/managed-settings.json`, { allowManagedHooksOnly: false });
      put(f, `${CLAUDE}/remote-settings.json`, { allowManagedHooksOnly: false });
    }, false],
    ['user settings `true` (not a managed tier)', (f) => { put(f, USER, { allowManagedHooksOnly: true }); }, false],
    ['two managed sources disagree', (f) => {
      put(f, `${MANAGED}/managed-settings.json`, { allowManagedHooksOnly: true });
      put(f, `${MANAGED}/managed-settings.d/10-firma.json`, { allowManagedHooksOnly: false });
    }, null],
  ])('`allowManagedHooksOnly` (no managed source surely in force): %s', async (_case, setup, expected) => {
    expect((await scene(setup))?.layers?.allowManagedHooksOnly).toBe(expected);
  });

  it('a foreign hook without any change: the verdict and the current read both say so', async () => {
    const facts = await scene((f) => { put(f, LOCAL, foreignLayer()); });
    expect(facts).toMatchObject({ verdict: no('foreign:local'), current: no('foreign:local'), foreignHook: true });
  });
});

describe('session facts under `changed`: the current content', () => {
  /** User settings with Rarog's hook, changed after the session start: read before the project and local layers. */
  const changedUser = (f: Fake): void => {
    put(f, USER, rarogLayer());
    f.changed.set(USER, NOW - 60_000);
  };

  it('`changed` without a foreign hook: the current content is clean, the layers are read', async () => {
    const facts = await scene(changedUser);
    expect(facts).toMatchObject({
      verdict: no(`changed:${USER}`), current: { ok: true }, foreignHook: false,
      layers: { rarogEntry: true, disableAllHooks: false, allowManagedHooksOnly: false },
    });
  });

  it.each([
    ['a local layer read after the changed file', (f: Fake): void => { put(f, LOCAL, foreignLayer()); },
      'foreign:local'],
    ['an agent definition', (f: Fake): void => {
      put(f, `${CLAUDE}/agents/a.md`, '---\nhooks:\n  PermissionRequest: []\n---\n');
    }, `hook-in:${CLAUDE}/agents/a.md`],
  ])('`changed` with a foreign hook in %s: the read goes on and finds it', async (_where, setup, why) => {
    const facts = await scene((f) => {
      changedUser(f);
      setup(f);
    });
    expect(facts).toMatchObject({ verdict: no(`changed:${USER}`), current: no(why), foreignHook: true });
  });

  it.each([
    ['refreshed after the start', { lastUpdated: new Date(NOW - 1_000).toISOString() }],
    ['without a refresh time', {}],
    ['with a refresh time that does not parse', { lastUpdated: 'soon' }],
  ])('a marketplace read in place %s: `marketplace-changed`, the current read `ok`', async (_, updated) => {
    const market = '/w/rynek-lokalny';
    const root = `${CLAUDE}/plugins/cache/rynek/straznik/1.0.0`;
    const facts = await scene((f) => {
      put(f, `${CLAUDE}/plugins/installed_plugins.json`, { version: 2, plugins: { 'straznik@rynek': [{ installPath: root }] } });
      put(f, `${root}/.claude-plugin/plugin.json`, { name: 'straznik' });
      put(f, `${CLAUDE}/plugins/known_marketplaces.json`, { rynek: {
        source: { source: 'directory', path: market }, installLocation: market, ...updated,
      } });
      put(f, `${market}/.claude-plugin/marketplace.json`, {
        name: 'rynek', owner: { name: 'firma' }, plugins: [{ name: 'straznik', source: './plugins/straznik' }],
      });
      put(f, `${market}/plugins/straznik/.claude-plugin/plugin.json`, { name: 'straznik' });
    });
    expect(facts).toMatchObject({ verdict: no('marketplace-changed:rynek'), current: { ok: true }, foreignHook: false });
  });

  it('`changed` and a layer that does not parse: no layer facts, the foreign hook unknown', async () => {
    const facts = await scene((f) => {
      changedUser(f);
      put(f, PROJECT, 'hooks: {');
    });
    expect(facts).toMatchObject({ verdict: no(`changed:${USER}`), foreignHook: null, layers: null });
    expect(facts?.current.ok).toBe(false);
  });
});

describe('session facts cache', () => {
  /** A clean session scene and its facts read. */
  function cached(): { f: Fake; clock: { now: number }; proc: SessionProcess } & ReturnType<typeof factsOf> {
    const f = fake();
    put(f, UST, rarogLayer());
    const clock = { now: NOW };
    const proc: SessionProcess = { pid: PID, start: PROCESS_START };
    return { f, clock, proc, ...factsOf(f, clock, proc) };
  }

  it('the same process, cwd and episode: no new read, even long after', async () => {
    const { read, reads, clock } = cached();
    await read(ask());
    const after = reads.count;
    expect(after).toBeGreaterThan(0);
    clock.now += 10 * HOOK_LIST_RETRY_MS;
    expect(await read(ask())).toMatchObject({ verdict: { ok: true } });
    expect(reads.count).toBe(after);
  });

  it('a new episode reads again', async () => {
    const { read, reads, f } = cached();
    await read(ask());
    const after = reads.count;
    put(f, LOCAL, foreignLayer());
    f.changed.set(LOCAL, NOW - 60_000);
    expect(await read(ask({ episode: 'e2' }))).toMatchObject({ episode: 'e2', verdict: no(`changed:${LOCAL}`) });
    expect(reads.count).toBeGreaterThan(after);
  });

  it('a new process of the session reads again', async () => {
    const { read, reads, f, clock, proc } = cached();
    await read(ask());
    const after = reads.count;
    put(f, `${CLAUDE}/sessions/${String(PID + 1)}.json`, { pid: PID + 1, sessionId: SESSION, cwd: CWD });
    Object.assign(proc, { pid: PID + 1, start: NOW - 60_000 });
    clock.now += 1_000;
    const facts = await read(ask());
    expect(facts?.process).toEqual({ pid: PID + 1, startedAt: NOW - 57_000 });
    expect(reads.count).toBeGreaterThan(after);
  });

  it('a new registry `cwd` reads again', async () => {
    const { read, reads, f } = cached();
    await read(ask());
    const after = reads.count;
    put(f, `${CLAUDE}/sessions/${String(PID)}.json`, { pid: PID, sessionId: SESSION, cwd: '/w/inny' });
    put(f, '/w/inny/.claude/settings.json', foreignLayer());
    expect(await read(ask())).toMatchObject({ cwd: '/w/inny', verdict: no('foreign:project') });
    expect(reads.count).toBeGreaterThan(after);
  });

  it('a transient negative read is read again in the same episode after its retry time', async () => {
    const { read, reads, f, clock } = cached();
    const proc = f.proc;
    f.proc = null;
    expect(await read(ask())).toMatchObject({ verdict: no('no-process'), layers: null, foreignHook: null });
    f.proc = proc;
    const after = reads.count;
    clock.now += HOOK_LIST_TRANSIENT_RETRY_MS - 1;
    expect(await read(ask())).toMatchObject({ verdict: no('no-process') });
    expect(reads.count).toBe(after);
    clock.now += 1;
    expect(await read(ask())).toMatchObject({ verdict: { ok: true }, foreignHook: false });
  });

  it('a durable negative read is read again in the same episode after the durable retry time', async () => {
    const { read, f, clock } = cached();
    put(f, LOCAL, foreignLayer());
    expect(await read(ask())).toMatchObject({ foreignHook: true });
    f.files.delete(LOCAL);
    clock.now += HOOK_LIST_RETRY_MS - 1;
    expect(await read(ask())).toMatchObject({ foreignHook: true });
    clock.now += 1;
    expect(await read(ask())).toMatchObject({ foreignHook: false });
  });

  it('a session restarted during the read: no facts; the next call reads the new process', async () => {
    const { read, f, proc } = cached();
    put(f, `${CLAUDE}/sessions/${String(PID + 1)}.json`, { pid: PID + 1, sessionId: SESSION, cwd: CWD });
    proc.afterPs = (): void => { Object.assign(proc, { pid: PID + 1, start: NOW - 2_000 }); };
    expect(await read(ask())).toBeNull();
    expect(await read(ask())).toMatchObject({ process: { pid: PID + 1 }, verdict: { ok: true } });
  });
});

describe('session facts: the registry `cwd` moves during the read', () => {
  const CLEAN = '/w/clean';
  const registryAt = (f: Fake, cwd: string): void => {
    put(f, `${CLAUDE}/sessions/${String(PID)}.json`, { pid: PID, sessionId: SESSION, cwd, startedAt: REGISTRY_START });
  };

  /**
   * A session in `CWD` with a foreign hook in its local layer. From the first `ps` on, the registry names a clean
   * directory, so both scans read that one on their own; `back` names `CWD` again before the end of the read.
   */
  function moving(back: boolean): { f: Fake } & ReturnType<typeof factsOf> {
    const f = fake();
    put(f, UST, rarogLayer());
    put(f, LOCAL, foreignLayer());
    const proc: SessionProcess = { pid: PID, start: PROCESS_START, afterPs: () => { registryAt(f, CLEAN); } };
    return { f, ...factsOf(f, { now: NOW }, proc, (call) => { if (back && call === 2) registryAt(f, CWD); }) };
  }

  it('A → B → A: the scans still cover A, and the cache holds what they found there', async () => {
    const { read, reads } = moving(true);
    const first = await read(ask());
    expect(first).toMatchObject({
      cwd: CWD, verdict: no('foreign:local'), current: no('foreign:local'), foreignHook: true,
    });
    const after = reads.count;
    expect(await read(ask())).toEqual(first);
    expect(reads.count).toBe(after);
  });

  it('A → B: no facts and nothing cached for A; the next calls read B, then A', async () => {
    const { read, f } = moving(false);
    expect(await read(ask())).toBeNull();
    expect(await read(ask())).toMatchObject({ cwd: CLEAN, verdict: { ok: true }, foreignHook: false });
    registryAt(f, CWD);
    expect(await read(ask())).toMatchObject({ cwd: CWD, verdict: no('foreign:local'), foreignHook: true });
  });

  it('a registry file mid-write at the start and whole by the scans: no facts', async () => {
    const f = fake();
    put(f, UST, rarogLayer());
    put(f, `${CLAUDE}/sessions/${String(PID)}.json`, '{"pid":');
    const proc: SessionProcess = { pid: PID, start: PROCESS_START, afterPs: () => { registryAt(f, CWD); } };
    const { read } = factsOf(f, { now: NOW }, proc);
    expect(await read(ask())).toBeNull();
    expect(await read(ask())).toMatchObject({ cwd: CWD, verdict: { ok: true } });
  });
});

describe('session facts: the call `cwd` from the transcript entry', () => {
  it.each<[string, string | undefined, string | undefined]>([
    ['the entry after `cd sub`', `${CWD}/sub`, `${CWD}/sub`],
    ['no `cwd` in the entry', undefined, undefined],
    ['a relative `cwd`', 'sub', undefined],
    ['an empty `cwd`', '', undefined],
  ])('%s', async (_case, entryCwd, expected) => {
    const f = fake();
    put(f, UST, rarogLayer());
    const facts = await factsOf(f).read(ask(entryCwd === undefined ? {} : { entryCwd }));
    expect(facts?.callCwd).toBe(expected);
    // The session `cwd` stays the registry's: the call `cwd` never stands in for it, nor the other way round.
    expect(facts?.cwd).toBe(CWD);
  });

  it('follows each query within one cached episode', async () => {
    const f = fake();
    put(f, UST, rarogLayer());
    const { read, reads } = factsOf(f);
    expect((await read(ask()))?.callCwd).toBeUndefined();
    const after = reads.count;
    expect((await read(ask({ entryCwd: `${CWD}/sub` })))?.callCwd).toBe(`${CWD}/sub`);
    expect(reads.count).toBe(after);
  });
});

describe('the subagent hook list reads as before', () => {
  it('a facts read between two list calls changes neither the answer nor the verdict log', async () => {
    const f = fake();
    put(f, UST, rarogLayer());
    put(f, USER, rarogLayer());
    f.changed.set(USER, NOW - 60_000);
    const clock = { now: NOW };
    const proc: SessionProcess = { pid: PID, start: PROCESS_START };
    const listIo = sessionIo(f, clock, proc);
    const verdicts: HookListVerdict[] = [];
    const list = createSessionHookList({
      home: HOME, accepted: [RAROG], io: listIo.io, now: () => clock.now, platform: 'darwin',
      entry: async () => ({ pid: proc.pid, startedAt: proc.start + 3_000 }),
      onVerdict: (_sid, one) => { verdicts.push(one); },
    });
    const dump: HookCallDump = {
      key: 'p-a', sessionId: SESSION, promptId: 'p', agentId: 'a1', pid: 9, startedAt: NOW - 500, toolName: 'Bash',
      toolInput: {}, cwd: CWD, at: NOW - 500, inputSha256: '0',
    };
    const first = await list.answer(SESSION, [dump]);
    const listReads = listIo.reads.count;
    expect(first).toEqual({ keys: new Set(), why: `changed:${USER}` });
    expect(await factsOf(f, clock, proc).read(ask())).toMatchObject({ foreignHook: false });
    expect(await list.answer(SESSION, [dump])).toEqual(first);
    expect(listIo.reads.count).toBe(listReads);
    expect(verdicts).toEqual([no(`changed:${USER}`)]);
  });
});
