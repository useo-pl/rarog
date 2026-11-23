/**
 * Reason of a desk release (`layer1/desk-reason.ts`): a subagent request released to the desk without proof
 * logs `consent: key <key> (subagent) released to the desk after <ms> ms without proof (reason: <code>)`, where the
 * code names the check that failed at the key's last observation.
 *
 * Sentences this file guards: every code of {@link CONSENT_DESK_REASONS} comes from an observation whose facts fail
 * exactly that check (subagent file facts, the hidden proof, the top proof under a fresh `waiting:
 * permission`, an incomplete read), and the release line carries it; a key without observation facts logs `unknown`.
 *
 * When the release comes (the hook-list condition): under the `screen` hidden rule a durable verdict of the session
 * hook list (`changed:`, `foreign:`) sends a request without the approve button back at its first check, with the
 * reason `other-hooks`, also while the registry says `waiting: permission` and when an earlier check failed too
 * (`file-behind`); a transient verdict (`io:`, `no-process`) waits the 10 s, and one mended after 3 s is read again
 * within 2 s, so the button comes and nothing is released; under the `channel` rule the list changes nothing. A verdict
 * of another process of the session (a restart under the same id, also one in the middle of a read) or of another `cwd`
 * scope (an observation of the same session that asks for other requests at the same time) releases nothing early.
 *
 * The observation, cycle and registry are real with the test clock; the subagent file reader, `ps`, the top-loss memory
 * and the session hook list are stubs, so each case changes one fact. The release timing cases use the real session
 * hook list over an in-memory disk instead of the stub.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import { HOOK_PENDING_DIRNAME } from '../src/herdr/dialogs/hook/contract.ts';
import type { HookCallDump } from '../src/herdr/dialogs/hook/contract.ts';
import {
  CONSENT_PROOF_TTL_MS, CONSENT_SECRET_BYTES, CONSENT_SUBAGENT_GRACE_MS,
} from '../src/herdr/dialogs/layer1/contract.ts';
import { createConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import type { ConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import { CONSENT_DESK_REASONS } from '../src/herdr/dialogs/layer1/desk-reason.ts';
import type { ConsentDeskReason } from '../src/herdr/dialogs/layer1/desk-reason.ts';
import { createSessionHookList } from '../src/herdr/dialogs/layer1/hook-list/hook-list.ts';
import type { HookListIo } from '../src/herdr/dialogs/layer1/hook-list/hook-list.ts';
import { observeConsentSession } from '../src/herdr/dialogs/layer1/observe.ts';
import type { ConsentSessionHooks } from '../src/herdr/dialogs/layer1/observe.ts';
import type { ConsentProofRule, ConsentSubagentFile } from '../src/herdr/dialogs/layer1/proof.ts';
import { createConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import type { ConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import { consentCardSha256 } from '../src/herdr/dialogs/layer1/sign.ts';
import type { ConsentScreenRead, MatchTop } from '../src/herdr/dialogs/layer1/top.ts';
import { REGISTRY_MAX_AGE_MS } from '../src/herdr/dialogs/shadow/evidence.ts';
import type { RegistryEvidence } from '../src/herdr/dialogs/shadow/evidence.ts';
import { hookCommand } from '../src/herdr/hook-commands.ts';

const SESSION = '00000000-0000-4000-9000-0000000000d1';
const PROMPT = '00000000-0000-4000-9000-0000000000d2';
const BOOT = 'boot-desk-reason';
const AGENT = 'a0123456789abcdef';
const T0 = Date.parse('2026-11-11T12:00:00.000Z');

let clock = T0;
const now = (): number => clock;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Harness {
  readonly dir: string;
  readonly reg: ConsentRegistry;
  readonly cycle: ConsentCycle;
  readonly logs: string[];
}

function harness(): Harness {
  clock = T0;
  const dir = mkdtempSync(join(tmpdir(), 'rarog-desk-reason-'));
  dirs.push(dir);
  const reg = createConsentRegistry({ bootId: BOOT, send: () => true, sessions: () => [SESSION], log: () => {}, now });
  reg.setScope('all');
  const logs: string[] = [];
  // The cycle starts well before the requests, so a busy registry read unlocks the session pool.
  clock = T0 - 10_000;
  const cycle = createConsentCycle({
    dataDir: dir, bootId: BOOT, registry: reg, now, mode: () => 'all', log: (line) => { logs.push(line); },
  });
  clock = T0;
  return { dir, reg, cycle, logs };
}

function dumpOf(seed: string, over: Partial<HookCallDump> = {}): HookCallDump {
  const input = over.toolInput ?? { command: `echo ${seed}` };
  const nonce = createHash('sha256').update(seed).digest('hex').slice(0, 32);
  return {
    key: `${PROMPT}-${nonce}`, sessionId: SESSION, promptId: PROMPT, agentId: AGENT, pid: process.pid,
    startedAt: clock - 1_000, toolName: 'Bash', toolInput: input, cwd: '/tmp/project', at: clock - 900,
    inputSha256: canonicalSha256(input), permissionMode: 'default', ...over,
  };
}

const dumpPath = (h: Harness, key: string): string => join(h.dir, HOOK_PENDING_DIRNAME, SESSION, `${key}.json`);

/** The hook writes its dump and registers with a fresh secret. */
function hookStarts(h: Harness, dump: HookCallDump): void {
  const path = dumpPath(h, dump.key);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(dump), { mode: 0o600 });
  const result = h.reg.register({
    key: dump.key, sessionId: SESSION, promptId: PROMPT, secret: randomBytes(CONSENT_SECRET_BYTES).toString('hex'),
    inputSha256: dump.inputSha256,
    cardSha256: consentCardSha256({
      sessionId: SESSION, toolName: dump.toolName, toolInput: dump.toolInput, cwd: dump.cwd,
      agentId: dump.agentId ?? AGENT, permissionMode: dump.permissionMode ?? null,
    }),
    pid: dump.pid, startedAt: dump.startedAt, agentId: dump.agentId ?? AGENT,
  });
  expect(result.status).toBe(200);
}

/** Subagent file facts known to the end, a background start and no run end: the hidden proof holds with them. */
function fileOf(over: Partial<ConsentSubagentFile> = {}): ConsentSubagentFile {
  return {
    partial: false, toolUses: [], results: [], settled: true, caughtUp: true,
    agent: { launch: { at: T0 - 5_000 }, ends: [], settled: true }, ...over,
  };
}

interface Facts {
  file?: (dump: HookCallDump) => ConsentSubagentFile | null;
  alive?: boolean | null;
  registry?: RegistryEvidence;
  rule?: ConsentProofRule;
  screen?: ConsentScreenRead | null;
  matchTop?: MatchTop;
  topLost?: boolean;
  onlyRarog?: boolean;
  /** The session hook list in place of the `onlyRarog` stub. */
  hooks?: ConsentSessionHooks;
}

const busy = (): RegistryEvidence => ({ kind: 'active', at: clock });
const waitingPermission = (): RegistryEvidence => ({ kind: 'waiting', dialog: 'permission', at: clock });

/** One observation step with the server's sources at `all`; each fact defaults to one that keeps the hidden proof. */
async function step(h: Harness, facts: Facts = {}): Promise<void> {
  const file = facts.file ?? ((): ConsentSubagentFile => fileOf());
  await observeConsentSession(h.cycle, {
    dataDir: h.dir, sessionId: SESSION, registry: facts.registry ?? busy(), transcript: null,
    screen: facts.screen ?? null, now, proofRule: facts.rule ?? 'screen',
    liveness: async (processes) => new Map(processes.map((proc) => [proc.pid, facts.alive === undefined ? true
      : facts.alive])),
    ...(facts.matchTop === undefined ? {} : { matchTop: facts.matchTop }),
    subagentTurns: async (requests) => requests.map((request) => {
      const dump = dumpsByAgent.get(request.agentId);
      return dump === undefined ? null : file(dump);
    }),
    hidden: {
      topLoss: { note: () => {}, lostAt: () => (facts.topLost === true ? T0 - 100 : null) },
      sessionHooks: facts.hooks
        ?? (async (_sid, dumps) => new Set(facts.onlyRarog === false ? [] : dumps.map((dump) => dump.key))),
    },
  });
}

/** The reader is asked per agent; each agent has one request in a test, so the agent's dump stands for it. */
const dumpsByAgent = new Map<string, HookCallDump>();

function startOne(h: Harness, dump: HookCallDump = dumpOf('one')): HookCallDump {
  dumpsByAgent.set(dump.agentId ?? AGENT, dump);
  hookStarts(h, dump);
  return dump;
}

const releaseLine = (key: string, reason: ConsentDeskReason): RegExp => new RegExp(
  `^consent: key ${key} \\(subagent\\) released to the desk after \\d+ ms without proof \\(reason: ${reason}\\)$`,
  'u',
);

async function expectReleased(h: Harness, key: string, reason: ConsentDeskReason, at: number): Promise<void> {
  clock = at;
  await h.cycle.tick();
  expect(h.cycle.record(SESSION, key)?.state).not.toBe('pending');
  const lines = h.logs.filter((line) => line.includes(`key ${key} (subagent) released`));
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(releaseLine(key, reason));
}

interface Case {
  readonly reason: ConsentDeskReason;
  readonly facts: (dump: HookCallDump) => Facts;
  readonly dump?: () => HookCallDump;
  readonly before?: (h: Harness) => Promise<void>;
}

/** One fact changed against the hidden proof under `screen` with a busy registry. */
const CASES: readonly Case[] = [
  { reason: 'file-unknown', facts: () => ({ file: () => null }) },
  { reason: 'reader-partial', facts: () => ({ file: () => fileOf({ partial: true }) }) },
  { reason: 'file-behind', facts: () => ({ file: () => fileOf({ caughtUp: false, settled: false }) }) },
  { reason: 'file-unsettled', facts: () => ({ file: () => fileOf({ settled: false }) }) },
  { reason: 'hook-not-alive', facts: () => ({ alive: null }) },
  { reason: 'digest', facts: () => ({}), dump: () => dumpOf('digest', { inputSha256: 'a'.repeat(64) }) },
  {
    reason: 'passed',
    facts: (dump) => ({
      file: () => fileOf({
        toolUses: [{ id: 'toolu_1', name: 'Bash', inputSha256: dump.inputSha256, line: 1 }],
        results: [{
          toolUseId: 'toolu_1', line: 2, at: dump.startedAt + 10, decision: null, source: null, interrupted: false,
        }],
      }),
    }),
  },
  { reason: 'lost', facts: () => ({}), before: async (h) => { await h.cycle.markReattached(SESSION); } },
  { reason: 'registry-unknown', facts: () => ({ registry: { kind: 'unknown', why: 'unread' } }) },
  {
    reason: 'interrupted',
    facts: (dump) => ({
      file: () => fileOf({
        toolUses: [{ id: 'toolu_2', name: 'Read', inputSha256: null, line: 1 }],
        results: [{
          toolUseId: 'toolu_2', line: 2, at: dump.startedAt + 10, decision: null, source: null, interrupted: true,
        }],
      }),
    }),
  },
  { reason: 'main-file-unknown', facts: () => ({ file: () => fileOf({ agent: null }) }) },
  {
    reason: 'not-background',
    facts: () => ({ file: () => fileOf({ agent: { launch: null, ends: [], settled: true } }) }),
  },
  {
    reason: 'run-ended',
    facts: (dump) => ({
      file: () => fileOf({
        agent: {
          launch: { at: T0 - 5_000 }, settled: true,
          ends: [{ at: dump.startedAt + 10, status: 'completed', via: 'notification', standby: false }],
        },
      }),
    }),
  },
  { reason: 'top-seen', facts: () => ({ topLost: true }) },
  { reason: 'other-hooks', facts: () => ({ onlyRarog: false }) },
];

describe('the desk release line names the failed check of the last observation', () => {
  for (const one of CASES) {
    it(`reason: ${one.reason}`, async () => {
      const h = harness();
      await one.before?.(h);
      const dump = startOne(h, one.dump?.());
      await step(h, one.facts(dump));
      expect(h.cycle.card(SESSION, dump.key)).toMatchObject({ state: 'pending', canAllow: false });
      await expectReleased(h, dump.key, one.reason, T0 + CONSENT_SUBAGENT_GRACE_MS);
    });
  }

  it('reason: unknown (a step without observation facts)', async () => {
    const h = harness();
    const dump = startOne(h);
    await h.cycle.observe(SESSION, dump.key, 'unknown', dump);
    await expectReleased(h, dump.key, 'unknown', T0 + CONSENT_SUBAGENT_GRACE_MS);
  });

  it('reason: scan-incomplete (another dump file does not parse)', async () => {
    const h = harness();
    const dump = startOne(h);
    writeFileSync(dumpPath(h, `${PROMPT}-${'f'.repeat(32)}`), '{', { mode: 0o600 });
    await step(h);
    await expectReleased(h, dump.key, 'scan-incomplete', T0 + CONSENT_SUBAGENT_GRACE_MS);
  });

  it('reason: dump-unread (the key\'s own dump does not parse at the last observation)', async () => {
    const h = harness();
    const dump = startOne(h);
    await step(h, { file: () => null });
    writeFileSync(dumpPath(h, dump.key), '{', { mode: 0o600 });
    clock = T0 + 1_000;
    await step(h);
    await expectReleased(h, dump.key, 'dump-unread', T0 + CONSENT_SUBAGENT_GRACE_MS);
  });

  it('reason: unexplained (the hidden proof held at the last observation and expired after it)', async () => {
    const h = harness();
    const dump = startOne(h);
    await step(h, { rule: 'channel' });
    expect(h.cycle.card(SESSION, dump.key)).toMatchObject({ state: 'pending', canAllow: true });
    clock = T0 + CONSENT_PROOF_TTL_MS;
    await h.cycle.tick();
    expect(h.cycle.card(SESSION, dump.key)).toMatchObject({ state: 'pending', canAllow: false });
    await expectReleased(h, dump.key, 'unexplained', T0 + CONSENT_PROOF_TTL_MS + CONSENT_SUBAGENT_GRACE_MS);
  });

  describe('top proof: the registry says a fresh `waiting: permission`', () => {
    /** A busy read after the cycle start unlocks the pool; the observation with the dialog comes later. */
    async function unlock(h: Harness): Promise<void> {
      clock = T0 - 1_000;
      await step(h);
      clock = T0;
    }
    // The fresh `waiting: permission` read holds the desk clock for its own freshness.
    const after = T0 + CONSENT_SUBAGENT_GRACE_MS + REGISTRY_MAX_AGE_MS + 1;
    const screen = (): ConsentScreenRead => ({ text: 'dialog', readStartedAt: clock });

    it('reason: top-twins (two subagent dumps match the top)', async () => {
      const h = harness();
      await unlock(h);
      const first = startOne(h, dumpOf('twin-1'));
      const second = dumpOf('twin-2');
      hookStarts(h, second);
      await step(h, { registry: waitingPermission(), screen: screen(), matchTop: () => 'match' });
      expect(h.cycle.card(SESSION, first.key)).toMatchObject({ state: 'pending', canAllow: false });
      await expectReleased(h, first.key, 'top-twins', after);
    });

    it('reason: top-miss (the dump does not match the top)', async () => {
      const h = harness();
      await unlock(h);
      const dump = startOne(h);
      await step(h, { registry: waitingPermission(), screen: screen(), matchTop: () => 'no' });
      await expectReleased(h, dump.key, 'top-miss', after);
    });

    it('reason: unexplained under `channel` (top proof held, hidden proof failed before `registry`)', async () => {
      const h = harness();
      await unlock(h);
      const dump = startOne(h);
      await step(h, {
        rule: 'channel', file: () => fileOf({ agent: null }), registry: waitingPermission(), screen: screen(),
        matchTop: () => 'match',
      });
      expect(h.cycle.card(SESSION, dump.key)).toMatchObject({ state: 'pending', canAllow: true });
      clock = T0 + CONSENT_PROOF_TTL_MS;
      await h.cycle.tick();
      expect(h.cycle.card(SESSION, dump.key)).toMatchObject({ state: 'pending', canAllow: false });
      await expectReleased(h, dump.key, 'unexplained', after + CONSENT_PROOF_TTL_MS);
    });
  });

  it('every code of the closed list has a case above', () => {
    const covered = new Set<string>([
      ...CASES.map((one) => one.reason), 'unknown', 'scan-incomplete', 'dump-unread', 'unexplained', 'top-twins',
      'top-miss',
    ]);
    expect([...CONSENT_DESK_REASONS].filter((code) => !covered.has(code))).toEqual([]);
  });
});

describe('when the release comes: the session hook list verdict', () => {
  const HOME = '/Users/demo';
  const PID = 4242;
  const PROCESS_START = T0 - 3_600_000;
  const BEFORE = PROCESS_START - 86_400_000;
  const USER_SETTINGS = `${HOME}/.claude/settings.json`;

  /** The session's disk, `ps` and CLI registry entry as the hook list reads them. */
  interface Disk {
    readonly files: Map<string, { readonly text: string; readonly changedAt: number }>;
    readonly errors: Map<string, string>;
    /** Live processes for `ps`: pid → start. */
    readonly procs: Map<number, number>;
    /** The session's single live registry entry (the server's `entry`). */
    entry: { readonly pid: number; readonly startedAt: number };
    /** Runs once inside the next `ps` read, before its answer: a session restart or a gate in the middle of a read. */
    duringPs?: () => Promise<void> | void;
  }

  /** The session process `pid` started at `start`: its registry file, `ps` and the registry entry name it. */
  function startProcess(disk: Disk, pid: number, start: number): void {
    disk.files.set(`${HOME}/.claude/sessions/${String(pid)}.json`, {
      text: JSON.stringify({ pid, sessionId: SESSION, cwd: '/tmp/project' }), changedAt: BEFORE,
    });
    disk.procs.set(pid, start);
    disk.entry = { pid, startedAt: start + 3_000 };
  }

  /** The CLI registry file of the session process, nothing else: the list says `ok`. */
  function diskOf(): Disk {
    const disk: Disk = {
      files: new Map(), errors: new Map(), procs: new Map(), entry: { pid: PID, startedAt: PROCESS_START + 3_000 },
    };
    startProcess(disk, PID, PROCESS_START);
    return disk;
  }

  /** The real session hook list over `disk`, on the test clock. */
  function listOf(disk: Disk): ConsentSessionHooks {
    const fail = (file: string): void => {
      const code = disk.errors.get(file);
      if (code !== undefined) throw Object.assign(new Error(code), { code });
    };
    const io: HookListIo = {
      lstat: async (file) => {
        fail(file);
        const found = disk.files.get(file);
        if (found !== undefined) return { kind: 'file', size: found.text.length, changedAt: found.changedAt };
        return [...disk.files.keys()].some((one) => one.startsWith(`${file}/`))
          ? { kind: 'dir', size: 0, changedAt: BEFORE } : null;
      },
      readlink: async () => { throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' }); },
      readFile: async (file) => {
        fail(file);
        return disk.files.get(file)?.text ?? null;
      },
      readdir: async () => null,
      ps: async (pid) => {
        const during = disk.duringPs;
        disk.duringPs = undefined;
        const start = disk.procs.get(pid);
        await during?.();
        return start === undefined ? null : { elapsedS: Math.floor((clock - start) / 1_000), args: 'claude' };
      },
    };
    return createSessionHookList({
      home: HOME, accepted: [hookCommand(HOME)], io, now, platform: 'darwin', entry: async () => disk.entry,
    });
  }

  /** `changed:`: the user settings changed after the session process started. */
  const changed = (disk: Disk): void => {
    disk.files.set(USER_SETTINGS, { text: '{}', changedAt: T0 - 60_000 });
  };
  /** `foreign:user`: another `PermissionRequest` hook in the user settings, written before the start. */
  const foreign = (disk: Disk): void => {
    const other = { matcher: '*', hooks: [{ type: 'command', command: '/usr/local/bin/other-hook' }] };
    disk.files.set(USER_SETTINGS, { text: JSON.stringify({ hooks: { PermissionRequest: [other] } }), changedAt: BEFORE });
  };

  /** The record already went back to the desk, with one release line naming `reason`. */
  function expectReleasedNow(h: Harness, key: string, reason: ConsentDeskReason): void {
    expect(h.cycle.record(SESSION, key)?.state).not.toBe('pending');
    expect(h.cycle.record(SESSION, key)).toMatchObject({ releaseCause: 'desk-fallback' });
    const lines = h.logs.filter((line) => line.includes(`key ${key} (subagent) released`));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(releaseLine(key, reason));
  }

  it.each([
    ['changed:', changed, 'changed'],
    ['foreign:', foreign, 'foreign'],
  ] as const)('`screen` and a durable `%s` verdict: released at the first check, reason `other-hooks`',
    async (_why, setup, code) => {
      const h = harness();
      const disk = diskOf();
      setup(disk);
      const dump = startOne(h);
      await step(h, { hooks: listOf(disk) });
      expectReleasedNow(h, dump.key, 'other-hooks');
      expect(h.cycle.deskRelease(SESSION, dump.key)).toMatchObject({ reason: 'other-hooks', hooks: { code } });
    });

  it.each([
    ['io:EACCES', (disk: Disk): void => { disk.errors.set(USER_SETTINGS, 'EACCES'); }, 'io'],
    ['no-process', (disk: Disk): void => { disk.procs.delete(PID); }, 'no-process'],
  ] as const)('a transient `%s` verdict: the request waits the 10 s, then reason `other-hooks`',
    async (_why, setup, code) => {
      const h = harness();
      const disk = diskOf();
      setup(disk);
      const hooks = listOf(disk);
      const dump = startOne(h);
      for (; clock < T0 + CONSENT_SUBAGENT_GRACE_MS; clock += 1_000) {
        await step(h, { hooks });
        expect(h.cycle.card(SESSION, dump.key)).toMatchObject({ state: 'pending', canAllow: false });
      }
      await expectReleased(h, dump.key, 'other-hooks', T0 + CONSENT_SUBAGENT_GRACE_MS);
      expect(h.cycle.deskRelease(SESSION, dump.key)).toMatchObject({ hooks: { code } });
    });

  it('a transient verdict mended after 3 s: read again within 2 s, the button comes and nothing is released',
    async () => {
      const h = harness();
      const disk = diskOf();
      disk.procs.delete(PID);
      const hooks = listOf(disk);
      const dump = startOne(h);
      for (; clock <= T0 + CONSENT_SUBAGENT_GRACE_MS + 2_000; clock += 1_000) {
        if (clock >= T0 + 3_000) disk.procs.set(PID, PROCESS_START);
        await step(h, { hooks });
        await h.cycle.tick();
        expect(h.cycle.record(SESSION, dump.key)?.state).toBe('pending');
      }
      expect(h.cycle.card(SESSION, dump.key)).toMatchObject({ state: 'pending', canAllow: true });
      expect(h.logs.filter((line) => line.includes('released to the desk'))).toEqual([]);
    });

  it('the `channel` rule with a durable verdict: no earlier release (the hook list does not count there)', async () => {
    const h = harness();
    const disk = diskOf();
    changed(disk);
    const dump = startOne(h);
    await step(h, { rule: 'channel', file: () => fileOf({ caughtUp: false, settled: false }), hooks: listOf(disk) });
    expect(h.cycle.card(SESSION, dump.key)).toMatchObject({ state: 'pending', canAllow: false });
    await expectReleased(h, dump.key, 'file-behind', T0 + CONSENT_SUBAGENT_GRACE_MS);
  });

  it('a durable verdict while the registry says `waiting: permission`: released at once', async () => {
    const h = harness();
    // A busy read after the cycle start unlocks the pool; the observation with the dialog comes later.
    clock = T0 - 1_000;
    await step(h);
    clock = T0;
    const disk = diskOf();
    changed(disk);
    const dump = startOne(h);
    await step(h, {
      registry: waitingPermission(), screen: { text: 'dialog', readStartedAt: clock }, matchTop: () => 'no',
      hooks: listOf(disk),
    });
    expectReleasedNow(h, dump.key, 'other-hooks');
  });

  it('a durable verdict and an earlier failed check (`file-behind`): released at once, reason `other-hooks`',
    async () => {
      const h = harness();
      const disk = diskOf();
      changed(disk);
      const dump = startOne(h);
      await step(h, { file: () => fileOf({ caughtUp: false, settled: false }), hooks: listOf(disk) });
      expectReleasedNow(h, dump.key, 'other-hooks');
    });

  it('the session restarted under the same id after a durable verdict: the new process\'s request is not released',
    async () => {
      const h = harness();
      const disk = diskOf();
      changed(disk);
      const hooks = listOf(disk);
      const first = startOne(h);
      await step(h, { hooks });
      expectReleasedNow(h, first.key, 'other-hooks');
      // A new process started after the change, within the 30 s of the old process's verdict.
      startProcess(disk, PID + 1, T0 + 1_000);
      clock = T0 + 5_000;
      const second = startOne(h, dumpOf('two'));
      await step(h, { hooks });
      expect(h.cycle.card(SESSION, second.key)).toMatchObject({ state: 'pending', canAllow: true });
      expect(h.logs.filter((line) => line.includes(`key ${second.key} (subagent) released`))).toEqual([]);
    });

  it('the session restarted in the middle of a read: no earlier release, the next read gives the button', async () => {
    const h = harness();
    const disk = diskOf();
    changed(disk);
    // `ps` answers for the old process (its verdict is `changed:`) while the registry already names the new one.
    disk.duringPs = () => { startProcess(disk, PID + 1, T0 - 2_000); };
    const hooks = listOf(disk);
    const dump = startOne(h);
    await step(h, { hooks });
    expect(h.cycle.card(SESSION, dump.key)).toMatchObject({ state: 'pending', canAllow: false });
    clock = T0 + 1_000;
    await h.cycle.tick();
    await step(h, { hooks });
    expect(h.cycle.card(SESSION, dump.key)).toMatchObject({ state: 'pending', canAllow: true });
    expect(h.logs.filter((line) => line.includes('released to the desk'))).toEqual([]);
  });

  it('an observation asking for another `cwd` while a read runs: its request is not released early',
    async () => {
      const h = harness();
      const disk = diskOf();
      disk.files.set('/w/bad/.claude/settings.json', { text: '{}', changedAt: T0 - 60_000 });
      let open = (): void => {};
      disk.duringPs = () => new Promise<void>((resolve) => { open = resolve; });
      const hooks = listOf(disk);
      const bad = startOne(h, dumpOf('bad', { agentId: 'a00000000000000bad', cwd: '/w/bad' }));
      const good = startOne(h, dumpOf('good', { cwd: '/w/good' }));
      // Each observation knows the subagent file of one request only, so it asks the list for that one; the first
      // waits in its `ps` read while the second asks.
      const first = step(h, { hooks, file: (dump) => (dump.key === bad.key ? fileOf() : null) });
      const second = step(h, { hooks, file: (dump) => (dump.key === good.key ? fileOf() : null) });
      await new Promise((resolve) => { setTimeout(resolve, 0); });
      open();
      await Promise.all([first, second]);
      expectReleasedNow(h, bad.key, 'other-hooks');
      clock = T0 + 1_000;
      await h.cycle.tick();
      expect(h.cycle.record(SESSION, good.key)?.state).toBe('pending');
      expect(h.logs.filter((line) => line.includes(`key ${good.key} (subagent) released`))).toEqual([]);
    });
});
