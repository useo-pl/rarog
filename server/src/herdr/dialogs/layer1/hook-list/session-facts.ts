/**
 * Session facts for a consent dialog that has no hook dump: one read of the session process, its `cwd` from the
 * session registry file, the call `cwd` from the transcript entry, the hook list verdict and the settings layers.
 * Everything comes from the hook list read (`hook-list.ts`) scoped to the registry `cwd` read at the start of the
 * query; this module adds the layer precedence and the cache. It only reads and writes no log line: the subagent hook
 * list keeps its own cache and verdict log.
 *
 * The facts of one read hold while the session process, its registry `cwd` and the episode (the caller's identity of
 * the dialog) stay the same; a negative read is read again in the same episode after its kind's retry time
 * (`hookListRetryMs`), so a transient doubt can mend on the same card.
 */
import path from 'node:path';
import { DISK_LAYOUT } from '../../../commands/registry.ts';
import {
  currentSessionHooks, hookListRetryMs, hookListWhyCode, nodeHookListIo, rarogHookIn, sessionHookVerdict,
  sessionProcessKey, sessionRegistryCwd,
} from './hook-list.ts';
import type {
  HookListInput, HookListLayer, HookListLayerTier, HookListSessionEntry, HookListVerdict, SessionHookListOptions,
} from './hook-list.ts';

/** One ask for the facts of a session. */
export interface SessionFactsQuery {
  readonly sessionId: string;
  /** Identity of the consent dialog episode, opaque: a new value reads again. */
  readonly episode: string;
  /** `cwd` of the transcript entry that carries the pending `tool_use` (`PendingTool.entryCwd`), when there is one. */
  readonly entryCwd?: string | undefined;
}

/** What the current content of the settings layers says, read past `changed` (no start check). */
export interface SessionLayerFacts {
  /** Rarog's `PermissionRequest` entry (an accepted command, `type: "command"`, no `args`) stands in some layer. */
  readonly rarogEntry: boolean;
  /**
   * `disableAllHooks` after the settings precedence ({@link settingOf}); `null` when the layers that may decide do not
   * all give the same boolean.
   */
  readonly disableAllHooks: boolean | null;
  /** `allowManagedHooksOnly` from the managed tier by the same rule; no managed source is surely the one in force. */
  readonly allowManagedHooksOnly: boolean | null;
}

/** The facts of one session for one episode. */
export interface SessionFacts {
  readonly episode: string;
  /** The one live CLI registry entry of the session (pid and start), `null` without one. */
  readonly process: HookListSessionEntry | null;
  /** The session `cwd` from the CLI registry file, `null` when it could not be read. */
  readonly cwd: string | null;
  /**
   * The call `cwd`: {@link SessionFactsQuery.entryCwd} when absolute, else `undefined`. Never the session `cwd`: after
   * a Bash `cd` the registry stays on the start directory while the call runs elsewhere.
   */
  readonly callCwd: string | undefined;
  /** The hook list verdict for the registry `cwd`, as the subagent hook list reads it. */
  readonly verdict: HookListVerdict;
  /** The same read over the current content: no start check, so `changed` never stops it. */
  readonly current: HookListVerdict;
  /**
   * Whether the current content holds a foreign `PermissionRequest` hook (settings layers, plugins, definitions):
   * `false` with {@link current} `ok`, `true` when it found one, `null` when it stopped on another doubt.
   */
  readonly foreignHook: boolean | null;
  /** The settings layers of the current read, `null` when it stopped before the last of them. */
  readonly layers: SessionLayerFacts | null;
}

export type SessionFactsOptions = Omit<SessionHookListOptions, 'onVerdict'>;

/** The facts read: `null` when the registry names another process or another `cwd` by the end of the read. */
export type SessionFactsRead = (query: SessionFactsQuery) => Promise<SessionFacts | null>;

/** Settings precedence, highest first (Claude Code documentation, "Settings files and precedence"). */
const PRECEDENCE: readonly HookListLayerTier[] = ['managed', 'flag', 'local', 'project', 'user'];

/** Codes of a current read that found a foreign hook or a hook entry of another shape. */
const FOREIGN_CODES: ReadonlySet<string> = new Set(['foreign', 'hooks-shape', 'hook-in', 'hook-escape']);

const DISABLE_ALL_HOOKS = 'disableAllHooks';
const ALLOW_MANAGED_HOOKS_ONLY = 'allowManagedHooksOnly';

/** The one value of `values`, `null` when they are not all the same boolean. */
function sameBoolean(values: readonly unknown[]): boolean | null {
  const first = values[0];
  return typeof first === 'boolean' && values.every((one) => one === first) ? first : null;
}

/**
 * Whether a layer surely takes part in the session's settings, as opposed to a layer the read superset adds that may
 * not. Surely: a layer the hook list marks `certain` (a `--settings` file, and the user `settings.json` without
 * `--setting-sources`), and, without `--setting-sources` (Claude Code CLI reference: the sources to load), the project
 * and local file of the session `cwd`. Claude Code documentation, "Where Claude Code keeps the local file in a git
 * repository": the shared `.claude/settings.json` is read from the session's primary working directory, and the local
 * file in the starting directory is read too (beside the one at the repository root, or as the only one outside a
 * repository); local files above `cwd` and the main checkout's files may not be. No managed layer is sure: by default
 * Claude Code applies only the highest-ranked managed source that delivers a policy key and ignores the rest even
 * where the selected one leaves a key unset, and fetches remote settings only with an eligible credential (managed
 * settings documentation, "How Claude Code combines managed sources").
 */
function sureLayer(cwd: string | null, settingSources: boolean): (layer: HookListLayer) => boolean {
  const own = cwd === null || settingSources ? null : path.join(path.resolve(cwd), DISK_LAYOUT.configDir);
  // Inline `--settings` JSON is not sure: `ps` loses argument bounds, so the same text may stand inside a prompt.
  return (layer) => (layer.certain && !(layer.name === 'flag' && layer.file === null)) || (own !== null && (
    (layer.name === 'project' && layer.file === path.join(own, DISK_LAYOUT.settings))
    || (layer.name === 'local' && layer.file === path.join(own, DISK_LAYOUT.localSettings))));
}

/**
 * A boolean key after precedence over the read superset, fail-closed: tier by tier from the highest of `tiers`, the
 * values of every layer that may be loaded count, down to and including the first tier where a surely loaded layer
 * ({@link sureLayer}) sets the key; without such a tier the default `false` counts too. The key is the one boolean
 * they all give, else `null`.
 */
function settingOf(
  layers: readonly HookListLayer[], key: string, tiers: readonly HookListLayerTier[],
  sure: (layer: HookListLayer) => boolean,
): boolean | null {
  const values: unknown[] = [];
  for (const tier of tiers) {
    const setting = layers.filter((layer) => layer.name === tier && Object.hasOwn(layer.value, key));
    values.push(...setting.map((layer) => layer.value[key]));
    if (setting.some(sure)) return sameBoolean(values);
  }
  return sameBoolean([...values, false]);
}

function layerFactsOf(
  layers: readonly HookListLayer[], sure: (layer: HookListLayer) => boolean, accepted: readonly string[],
): SessionLayerFacts {
  return {
    rarogEntry: layers.some((layer) => rarogHookIn(layer.value, accepted)),
    disableAllHooks: settingOf(layers, DISABLE_ALL_HOOKS, PRECEDENCE, sure),
    allowManagedHooksOnly: settingOf(layers, ALLOW_MANAGED_HOOKS_ONLY, ['managed'], sure),
  };
}

function foreignHookOf(current: HookListVerdict): boolean | null {
  if (current.ok) return false;
  return FOREIGN_CODES.has(hookListWhyCode(current.why)) ? true : null;
}

/** How long the facts hold within their episode: for good when both reads are `ok`, else the shortest retry time. */
function holdMs(facts: Omit<SessionFacts, 'callCwd'>): number {
  const whys = [facts.verdict, facts.current].flatMap((one) => (one.ok ? [] : [one.why]));
  return whys.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...whys.map(hookListRetryMs));
}

/** Facts of one read, for one process, registry `cwd` and episode, read from `at`. */
interface CachedFacts {
  readonly at: number;
  readonly proc: string;
  readonly cwd: string | null;
  readonly episode: string;
  readonly facts: Omit<SessionFacts, 'callCwd'>;
}

/** The call `cwd` of the query: absolute only, never a guess. */
const callCwdOf = (entryCwd: string | undefined): string | undefined =>
  entryCwd !== undefined && path.isAbsolute(entryCwd) ? entryCwd : undefined;

/**
 * The session facts read over the same options as the session hook list (`createSessionHookList`), with a cache of
 * its own (module header). The registry `cwd` is read on every call (one small file) to see a `cwd` change, and again
 * at the end of a read: a read that ends on another `cwd` than it started with gives no facts.
 */
export function createSessionFacts(options: SessionFactsOptions): SessionFactsRead {
  const io = options.io ?? nodeHookListIo;
  const clock = options.now ?? Date.now;
  const cache = new Map<string, CachedFacts>();
  const running = new Map<string, Promise<CachedFacts | null>>();

  /** `cwd` of the registry file of the session process, `null` without an entry or a readable file. */
  const registryCwdOf = async (sessionId: string, entry: HookListSessionEntry | null): Promise<string | null> =>
    entry === null ? null : sessionRegistryCwd(io, options.home, entry.pid, sessionId).catch((): null => null);

  async function compute(
    sessionId: string, entry: HookListSessionEntry | null, cwd: string | null, episode: string,
  ): Promise<CachedFacts | null> {
    const at = clock();
    // Each scan reads the registry `cwd` again on its own; with the start `cwd` beside it, a `cwd` that moved during
    // the read and back still has its directories scanned (a superset of them), so the facts never stand for a
    // directory no scan read.
    const input = (now: number): HookListInput => ({
      sessionId, home: options.home, accepted: options.accepted, entry, cwds: cwd === null ? [] : [cwd],
      platform: options.platform ?? process.platform, now,
    });
    const verdict = await sessionHookVerdict(input(at), io);
    const current = await currentSessionHooks(input(clock()), io);
    const proc = sessionProcessKey(entry);
    const end = await options.entry(sessionId);
    if (sessionProcessKey(end) !== proc || await registryCwdOf(sessionId, end) !== cwd) return null;
    const facts: Omit<SessionFacts, 'callCwd'> = {
      episode, process: entry, cwd, verdict, current: current.verdict, foreignHook: foreignHookOf(current.verdict),
      layers: current.layers === null ? null
        : layerFactsOf(current.layers, sureLayer(cwd, current.settingSources), options.accepted),
    };
    const done: CachedFacts = { at, proc, cwd, episode, facts };
    cache.set(sessionId, done);
    return done;
  }

  return async (query) => {
    const { sessionId, episode } = query;
    const entry = await options.entry(sessionId);
    const proc = sessionProcessKey(entry);
    const cwd = await registryCwdOf(sessionId, entry);
    const cached = cache.get(sessionId);
    let found = cached !== undefined && cached.proc === proc && cached.cwd === cwd && cached.episode === episode
      && clock() - cached.at < holdMs(cached.facts) ? cached : null;
    if (found === null) {
      // One read per process, `cwd` and episode at a time.
      const key = JSON.stringify([sessionId, proc, cwd, episode]);
      let job = running.get(key);
      if (job === undefined) {
        job = compute(sessionId, entry, cwd, episode).finally(() => running.delete(key));
        running.set(key, job);
      }
      found = await job;
    }
    return found === null ? null : { ...found.facts, callCwd: callCwdOf(query.entryCwd) };
  };
}
