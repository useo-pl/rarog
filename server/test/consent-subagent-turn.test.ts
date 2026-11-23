/**
 * The run of a subagent request in its own file (`consent-subagent.ts`): the request is bound to the agent's
 * run (from its last opening entry to the end of the file), not to the hook's `promptId`.
 *
 * Sentences this file guards:
 *
 * - a new main-thread message while a background agent works gives every later `user` entry of the agent file and
 *   the agent's next hooks the new `promptId` (CLI 2.1.322), with no opening entry of it in the agent file; such
 *   a request has its run known to the end and gets the approve button at effective `all`, also when the hook's
 *   `promptId` is on no entry of the agent file;
 * - a resume through `SendMessage` (an `isMeta` entry with `origin.kind: coordinator`, CLI 2.1.322) opens a new run:
 *   a request of that run gets the button, the calls of the run before are not in the run's facts, and a hook of the
 *   run before gets none (its call's result, or the end of its run in the main file, takes the proof);
 * - a compaction (`system/compact_boundary` and an `isCompactSummary` entry with a new `promptId`) does not open a run;
 * - the call's result takes the button whatever `promptId` it carries; an unfinished last line takes it too;
 * - the background start (`screen` rule) is read from the line of the `Agent` call named by the agent's
 *   `agent-<id>.meta.json` (`toolUseId`), so a hook `promptId` of another main turn and a resume keep it; without the
 *   meta file it is read from the main turn of the hook's `promptId`;
 * - the evidence review binds the call from the agent file, also of a run before a resume, so a desk key settles
 *   its effect.
 *
 * All session files are synthetic lines in the shape of the recorded consent fixtures (CLI 2.1.319) and of the 2.1.322
 * agent files:
 * `user` entries carry `promptId`, `assistant` entries do not. Dumps lie on disk in the test data dir, `ps` is a stub;
 * the cycle, registry, subagent file reader and observation are real, with the test clock.
 */
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createConsentEvidenceReview, nodeConsentEvidenceIo } from '../src/herdr/consent-evidence.ts';
import { createSubagentObservation } from '../src/herdr/consent-subagent.ts';
import type { SubagentObservation } from '../src/herdr/consent-subagent.ts';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import { HOOK_PENDING_DIRNAME } from '../src/herdr/dialogs/hook/contract.ts';
import type { HookCallDump } from '../src/herdr/dialogs/hook/contract.ts';
import { CONSENT_EVIDENCE_SCAN_MAX_BYTES, CONSENT_SECRET_BYTES } from '../src/herdr/dialogs/layer1/contract.ts';
import { bindAgentTurn } from '../src/herdr/dialogs/layer1/bind.ts';
import type { ConsentTurnFacts } from '../src/herdr/dialogs/layer1/bind.ts';
import { createConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import type { ConsentCycle, ConsentObservedSignal } from '../src/herdr/dialogs/layer1/cycle.ts';
import { createConsentTopLoss, observeConsentSession } from '../src/herdr/dialogs/layer1/observe.ts';
import type { ConsentTopLoss } from '../src/herdr/dialogs/layer1/observe.ts';
import type { ConsentProofRule } from '../src/herdr/dialogs/layer1/proof.ts';
import { readConsentRecords } from '../src/herdr/dialogs/layer1/records.ts';
import { createConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import type { ConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import { consentCardSha256 } from '../src/herdr/dialogs/layer1/sign.ts';
import type { RegistryEvidence } from '../src/herdr/dialogs/shadow/evidence.ts';
import type { ProcessLiveness } from '../src/herdr/dialogs/shadow/liveness.ts';

const SESSION = '00000000-0000-4000-9000-00000000a001';
const AGENT = 'a0c0ffee0ddba11ad';
/** Main turn that started the agent (the agent's task carries it). */
const A = '00000000-0000-4000-9000-00000000a00a';
/** New main-thread message written while the agent works. */
const B = '00000000-0000-4000-9000-00000000a00b';
/** Main turn that resumed the agent with `SendMessage`. */
const C = '00000000-0000-4000-9000-00000000a00c';
/** Second main-thread message while the agent works: no `user` entry of the agent file carries it yet. */
const E = '00000000-0000-4000-9000-00000000a00e';
const BOOT = 'boot-subagent-turn';
const CWD = '/work/project';
/** Id of the main-thread `Agent` call that started the agent (the meta file's `toolUseId`). */
const START_CALL = 'toolu_main_agent';

/** Input of the request the hook waits on. */
const ASKED = { command: 'git status --short', description: 'Show the working tree state' };
/** Input of an earlier call, already decided. */
const EARLIER = { command: 'ls -la', description: 'List the files' };
/** Input of the call after the resume. */
const RESUMED = { command: 'git log -1', description: 'Show the last commit' };

/** Time base of the scene (ms since epoch); the hook of the asked call starts at {@link HOOK_AT}. */
const T0 = Date.parse('2026-11-11T10:00:00.000Z');
const USE_AT = T0 + 60_000;
const HOOK_AT = USE_AT + 70;

const iso = (when: number): string => new Date(when).toISOString();
let uuid = 0;
const nextUuid = (): string => `00000000-0000-4000-9000-${String(++uuid).padStart(12, '0')}`;

/** Main-thread `user` entry with `promptId`; `content` is a string or blocks. */
function mainUser(when: number, promptId: string, content: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'user', uuid: nextUuid(), timestamp: iso(when), sessionId: SESSION, promptId, isSidechain: false,
    version: '2.1.322', message: { role: 'user', content }, ...extra,
  });
}

function mainAssistant(when: number, content: unknown[]): string {
  return JSON.stringify({
    type: 'assistant', uuid: nextUuid(), timestamp: iso(when), sessionId: SESSION, isSidechain: false,
    version: '2.1.322', message: { role: 'assistant', content },
  });
}

const turnEnd = (when: number): string => JSON.stringify({
  type: 'system', subtype: 'turn_duration', uuid: nextUuid(), timestamp: iso(when), sessionId: SESSION,
  isSidechain: false, durationMs: 1000, version: '2.1.322',
});

/** Main turn `A`: the human prompt, the `Agent` call and its background start. */
function mainStart(): string[] {
  return [
    mainUser(T0, A, 'Start one background agent.', { origin: { kind: 'human' } }),
    mainAssistant(T0 + 1_000, [{
      type: 'tool_use', id: START_CALL, name: 'Agent',
      input: { description: 'Probe task', prompt: 'Run the probe.', run_in_background: true },
    }]),
    mainUser(T0 + 1_100, A, [{ type: 'tool_result', tool_use_id: START_CALL, content: 'launched' }], {
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: AGENT },
    }),
    turnEnd(T0 + 2_000),
  ];
}

/** A main turn with a new human message and the model's answer, while the agent works. */
function mainMessage(promptId = B, at = T0 + 20_000): string[] {
  return [
    mainUser(at, promptId, 'One more question.', { origin: { kind: 'human' } }),
    mainAssistant(at + 1_000, [{ type: 'text', text: 'Answer.' }]),
    turnEnd(at + 1_100),
  ];
}

/** Main turn `C`: a human message and the `SendMessage` that resumes the agent. */
function mainResume(): string[] {
  return [
    mainUser(T0 + 100_000, C, 'Ask the agent for one more step.', { origin: { kind: 'human' } }),
    mainAssistant(T0 + 101_000, [{
      type: 'tool_use', id: 'toolu_main_send', name: 'SendMessage', input: { to: AGENT, message: 'One more step.' },
    }]),
    mainUser(T0 + 101_100, C, [{ type: 'tool_result', tool_use_id: 'toolu_main_send', content: 'resumed' }], {
      toolUseResult: { success: true, resumedAgentId: AGENT },
    }),
  ];
}

/** End of the agent's run in the main file (background: the completion notification). */
const mainEnd = (when: number): string => mainUser(when, '00000000-0000-4000-9000-00000000a00d', [
  '<task-notification>', `<task-id>${AGENT}</task-id>`, '<status>completed</status>',
  '<summary>Agent "Probe task" finished</summary>', '</task-notification>',
].join('\n'), { origin: { kind: 'task-notification' } });

/** Agent file `user` entry: a string opens a run (the task), blocks are results. */
function agentUser(when: number, promptId: string, content: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'user', uuid: nextUuid(), timestamp: iso(when), sessionId: SESSION, promptId, isSidechain: true,
    agentId: AGENT, version: '2.1.322', message: { role: 'user', content }, ...extra,
  });
}

/** Resume message of `SendMessage` in the agent file (CLI 2.1.322): `isMeta` with `origin.kind: coordinator`. */
const agentResume = (when: number, promptId: string): string =>
  agentUser(when, promptId, 'One more step.', { isMeta: true, origin: { kind: 'coordinator' } });

/** Compaction in the agent file (CLI 2.1.322): the boundary and the summary entry with the main turn's `promptId`. */
const agentCompaction = (when: number, promptId: string): string[] => [
  JSON.stringify({
    type: 'system', subtype: 'compact_boundary', uuid: nextUuid(), timestamp: iso(when), sessionId: SESSION,
    isSidechain: true, agentId: AGENT, version: '2.1.322', content: 'Conversation compacted',
  }),
  agentUser(when + 10, promptId, 'Summary of the work so far.', {
    isCompactSummary: true, isVisibleInTranscriptOnly: true,
  }),
];

/** Agent file `assistant` entry with one `tool_use`, without `promptId` (agent files of CLI 2.1.322). */
const agentUse = (when: number, id: string, input: unknown): string => JSON.stringify({
  type: 'assistant', uuid: nextUuid(), timestamp: iso(when), sessionId: SESSION, isSidechain: true, agentId: AGENT,
  version: '2.1.322', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input }] },
});

const agentText = (when: number, text: string): string => JSON.stringify({
  type: 'assistant', uuid: nextUuid(), timestamp: iso(when), sessionId: SESSION, isSidechain: true, agentId: AGENT,
  version: '2.1.322', message: { role: 'assistant', content: [{ type: 'text', text }] },
});

/** Result of call `id` decided by `source`. */
const agentResult = (when: number, promptId: string, id: string, source = 'config'): string =>
  agentUser(when, promptId, [{ type: 'tool_result', tool_use_id: id, is_error: false, content: 'done' }], {
    permissionDecision: { decision: 'accept', source },
  });

/**
 * Case 1: the task opens the run with `A`; the owner writes `B` while an earlier call runs, so its result carries
 * `B`; the next call waits on the hook.
 */
const CASE_1 = (): string[] => [
  agentUser(T0 + 1_200, A, 'Run the probe.'),
  agentUse(T0 + 10_000, 'toolu_a1', EARLIER),
  agentResult(T0 + 25_000, B, 'toolu_a1'),
  agentUse(USE_AT, 'toolu_a2', ASKED),
];

/** Case 2: the same run without a main-thread message: every entry carries `A`. */
const CASE_2 = (): string[] => [
  agentUser(T0 + 1_200, A, 'Run the probe.'),
  agentUse(T0 + 10_000, 'toolu_a1', EARLIER),
  agentResult(T0 + 25_000, A, 'toolu_a1'),
  agentUse(USE_AT, 'toolu_a2', ASKED),
];

/**
 * Case 3: run 1 (opened with `A`, later entries with `B`) left the asked call without a result; the `SendMessage`
 * resume opens run 2 with `C`. The main file has the end of run 1 only where a test says so.
 */
const RESUME_AT = T0 + 101_200;
const RESUMED_USE_AT = RESUME_AT + 5_000;
const CASE_3 = (run1: readonly string[] = CASE_1()): string[] => [
  ...run1,
  agentResume(RESUME_AT, C),
  agentUse(RESUMED_USE_AT, 'toolu_c1', RESUMED),
];

let clock = 0;
const now = (): number => clock;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const busy = (): RegistryEvidence => ({ kind: 'active', at: clock });

interface Harness {
  readonly dir: string;
  readonly main: string;
  readonly sub: string;
  readonly reg: ConsentRegistry;
  readonly cycle: ConsentCycle;
  readonly subagents: SubagentObservation;
  readonly topLoss: ConsentTopLoss;
  readonly signals: Map<string, ConsentObservedSignal>;
}

/** Scene files; `meta: false` = no `agent-<id>.meta.json` next to the agent file. */
function harness(main: readonly string[], sub: readonly string[], at: number, meta = true): Harness {
  clock = at;
  const dir = mkdtempSync(join(tmpdir(), 'rarog-subagent-turn-'));
  dirs.push(dir);
  const mainFile = join(dir, 'projekt', `${SESSION}.jsonl`);
  const subFile = join(dir, 'projekt', SESSION, 'subagents', `agent-${AGENT}.jsonl`);
  mkdirSync(dirname(subFile), { recursive: true });
  writeFileSync(mainFile, `${main.join('\n')}\n`);
  writeFileSync(subFile, `${sub.join('\n')}\n`);
  if (meta) {
    writeFileSync(join(dirname(subFile), `agent-${AGENT}.meta.json`), JSON.stringify({
      agentType: 'general-purpose', description: 'Probe task', toolUseId: START_CALL, spawnDepth: 1,
    }));
  }
  const reg = createConsentRegistry({ bootId: BOOT, send: () => true, sessions: () => [SESSION], log: () => {}, now });
  reg.setScope('all');
  const started = clock;
  clock = started - 10_000;
  const cycle = createConsentCycle({ dataDir: dir, bootId: BOOT, registry: reg, now, mode: () => 'all', log: () => {} });
  clock = started;
  const subagents = createSubagentObservation({
    io: nodeConsentEvidenceIo, locate: async () => mainFile, agentFiles: true,
    maxBytes: CONSENT_EVIDENCE_SCAN_MAX_BYTES,
  });
  return {
    dir, main: mainFile, sub: subFile, reg, cycle, subagents, topLoss: createConsentTopLoss(), signals: new Map(),
  };
}

/** Dump of the hook with `promptId` waiting on a `Bash` call with `input`, started at `startedAt`. */
function dumpOf(promptId: string, input: Record<string, unknown>, startedAt: number): HookCallDump {
  const nonce = createHash('sha256').update(JSON.stringify([promptId, input])).digest('hex').slice(0, 32);
  return {
    key: `${promptId}-${nonce}`, sessionId: SESSION, promptId, agentId: AGENT, pid: process.pid, startedAt,
    toolName: 'Bash', toolInput: input, cwd: CWD, at: startedAt + 100, inputSha256: canonicalSha256(input),
    permissionMode: 'auto',
  };
}

function hookStarts(h: Harness, dump: HookCallDump): void {
  const path = join(h.dir, HOOK_PENDING_DIRNAME, dump.sessionId, `${dump.key}.json`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(dump), { mode: 0o600 });
  const result = h.reg.register({
    key: dump.key, sessionId: dump.sessionId, promptId: dump.promptId,
    secret: randomBytes(CONSENT_SECRET_BYTES).toString('hex'), inputSha256: dump.inputSha256,
    cardSha256: consentCardSha256({
      sessionId: dump.sessionId, toolName: dump.toolName, toolInput: dump.toolInput, cwd: dump.cwd,
      agentId: dump.agentId ?? null, permissionMode: dump.permissionMode ?? null,
    }),
    pid: dump.pid, startedAt: dump.startedAt, ...(dump.agentId === undefined ? {} : { agentId: dump.agentId }),
  });
  expect(result.status).toBe(200);
}

function hookExits(h: Harness, dump: HookCallDump): void {
  rmSync(join(h.dir, HOOK_PENDING_DIRNAME, dump.sessionId, `${dump.key}.json`), { force: true });
}

/** One observation step with the server's sources at `all`; the registry says `busy` (a hidden request). */
async function step(h: Harness, rule: ConsentProofRule = 'channel'): Promise<void> {
  const liveness: ProcessLiveness = async (processes) => new Map(processes.map((proc) => [proc.pid, true]));
  const cycle: Parameters<typeof observeConsentSession>[0] = {
    ...h.cycle,
    observe: async (sessionId, key, signal, ...rest) => {
      h.signals.set(key, signal);
      return h.cycle.observe(sessionId, key, signal, ...rest);
    },
  };
  await observeConsentSession(cycle, {
    dataDir: h.dir, sessionId: SESSION, liveness, registry: busy(), transcript: null, screen: null, now,
    proofRule: rule,
    subagentTurns: (requests) => h.subagents.read(SESSION, requests),
    hidden: { topLoss: h.topLoss, sessionHooks: async (_sid, dumps) => new Set(dumps.map((dump) => dump.key)) },
  });
}

const NO_BUTTON = { state: 'pending', canAllow: false, unavailable: 'no-proof' };

async function expectButton(h: Harness, dump: HookCallDump): Promise<void> {
  expect(h.signals.get(dump.key)).toBe('hidden');
  expect(h.cycle.card(SESSION, dump.key)).toMatchObject({ state: 'pending', canAllow: true });
}

async function expectNoButton(h: Harness, dump: HookCallDump): Promise<void> {
  expect(h.signals.get(dump.key)).not.toBe('hidden');
  expect(h.cycle.card(SESSION, dump.key)).toMatchObject(NO_BUTTON);
}

/** One request scene: main and agent file, the hook dump and the clock of the first observation. */
async function scene(
  main: readonly string[], sub: readonly string[], dump: HookCallDump, rule: ConsentProofRule = 'channel',
  meta = true,
): Promise<Harness> {
  const h = harness(main, sub, dump.startedAt + 1_000, meta);
  hookStarts(h, dump);
  await step(h, rule);
  return h;
}

describe('a request whose `promptId` came from a main-thread message after the agent started', () => {
  it('case 1: opening with A, later entries with B, hook with B, call without a result: button', async () => {
    const dump = dumpOf(B, ASKED, HOOK_AT);
    const h = await scene([...mainStart(), ...mainMessage()], CASE_1(), dump);
    await expectButton(h, dump);
    expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toMatchObject({ ok: true, state: 'sent' });
    expect(readConsentRecords(h.dir).find((record) => record.key === dump.key))
      .toMatchObject({ state: 'sent', decision: 'allow', proofKind: 'hidden' });
  });

  it('case 1, file reader: the run is known to the end, with both calls of the run', async () => {
    const h = harness([...mainStart(), ...mainMessage()], CASE_1(), HOOK_AT + 1_000);
    const [facts] = await h.subagents.read(SESSION, [{ agentId: AGENT, promptId: B }]);
    expect(facts).toMatchObject({ partial: false, settled: true, caughtUp: true });
    expect(facts?.toolUses.map((use) => use.id)).toEqual(['toolu_a1', 'toolu_a2']);
    expect(facts?.results.map((result) => result.toolUseId)).toEqual(['toolu_a1']);
  });

  it('a hook `promptId` on no entry of the agent file (newer than all of them): button', async () => {
    const dump = dumpOf(E, ASKED, HOOK_AT);
    const h = await scene([...mainStart(), ...mainMessage(), ...mainMessage(E, T0 + 50_000)], CASE_1(), dump);
    await expectButton(h, dump);
  });

  it('case 2: every entry with A, no main-thread message, hook with A: button as before', async () => {
    const dump = dumpOf(A, ASKED, HOOK_AT);
    const h = await scene(mainStart(), CASE_2(), dump);
    await expectButton(h, dump);
  });

  it('case 2: the case 1 file with a hook with A (the opening entry): button as before', async () => {
    const dump = dumpOf(A, ASKED, HOOK_AT);
    const h = await scene([...mainStart(), ...mainMessage()], CASE_1(), dump);
    await expectButton(h, dump);
  });

  it('a compaction with a new `promptId` in the middle of the run keeps the run: button', async () => {
    const sub = [
      ...CASE_1().slice(0, 3), ...agentCompaction(T0 + 52_000, E), agentUse(USE_AT, 'toolu_a2', ASKED),
    ];
    const dump = dumpOf(E, ASKED, HOOK_AT);
    const h = await scene([...mainStart(), ...mainMessage(), ...mainMessage(E, T0 + 50_000)], sub, dump);
    await expectButton(h, dump);
    const [facts] = await h.subagents.read(SESSION, [{ agentId: AGENT, promptId: E }]);
    expect(facts?.toolUses.map((use) => use.id)).toEqual(['toolu_a1', 'toolu_a2']);
  });

  it('case 4: case 1 with an unfinished last line: no button', async () => {
    const dump = dumpOf(B, ASKED, HOOK_AT);
    const h = harness([...mainStart(), ...mainMessage()], CASE_1(), HOOK_AT + 1_000);
    appendFileSync(h.sub, `{"type":"user","isSidechain":true,"agentId":"${AGENT}","promptId":"${B}"`);
    hookStarts(h, dump);
    await step(h);
    expect(h.cycle.card(SESSION, dump.key)).toMatchObject(NO_BUTTON);
  });

  it('case 5: the call already has its result, with a `promptId` other than the hook\'s: no button', async () => {
    const dump = dumpOf(B, ASKED, HOOK_AT);
    const sub = [...CASE_1(), agentResult(HOOK_AT + 500, E, 'toolu_a2', 'user_temporary')];
    const h = await scene([...mainStart(), ...mainMessage(), ...mainMessage(E, HOOK_AT + 200)], sub, dump);
    expect(h.signals.get(dump.key)).not.toBe('hidden');
    expect(h.cycle.card(SESSION, dump.key)).toMatchObject({ state: 'pending', canAllow: false });
  });

  it('case 5: the result written after the button takes it, whatever its `promptId`', async () => {
    const dump = dumpOf(B, ASKED, HOOK_AT);
    const h = await scene([...mainStart(), ...mainMessage()], CASE_1(), dump);
    await expectButton(h, dump);
    clock += 300;
    appendFileSync(h.sub, `${agentResult(clock - 100, E, 'toolu_a2', 'user_temporary')}\n`);
    await step(h);
    expect(h.cycle.card(SESSION, dump.key)).toMatchObject({ state: 'pending', canAllow: false });
    expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toMatchObject({ ok: false });
  });
});

describe('a `SendMessage` resume opens a new run', () => {
  it('a request of the resumed run (hook with C) gets the button', async () => {
    const dump = dumpOf(C, RESUMED, RESUMED_USE_AT + 70);
    const h = await scene([...mainStart(), ...mainMessage(), ...mainResume()], CASE_3(), dump);
    await expectButton(h, dump);
  });

  it('file reader: the calls of the run before the resume are not in the run\'s facts, its results are', async () => {
    const h = harness([...mainStart(), ...mainMessage(), ...mainResume()], CASE_3(), RESUMED_USE_AT + 1_000);
    const [facts] = await h.subagents.read(SESSION, [{ agentId: AGENT, promptId: C }]);
    expect(facts).toMatchObject({ partial: false, settled: true, caughtUp: true });
    expect(facts?.toolUses.map((use) => use.id)).toEqual(['toolu_c1']);
    expect(facts?.results.map((result) => result.toolUseId)).toEqual(['toolu_a1']);
  });

  it('a hook of the run before, whose run ended before the resume: no button', async () => {
    const dump = dumpOf(B, ASKED, HOOK_AT);
    const main = [...mainStart(), ...mainMessage(), mainEnd(HOOK_AT + 2_000), ...mainResume()];
    const h = harness(main, CASE_3(), RESUMED_USE_AT + 1_000);
    hookStarts(h, dump);
    await step(h);
    await expectNoButton(h, dump);
  });

  it('a hook of the run before, whose call got its result after the hook started: no button', async () => {
    const dump = dumpOf(B, ASKED, HOOK_AT);
    const run1 = [...CASE_1(), agentResult(HOOK_AT + 500, B, 'toolu_a2', 'user_temporary')];
    const h = harness([...mainStart(), ...mainMessage(), ...mainResume()], CASE_3(run1), RESUMED_USE_AT + 1_000);
    hookStarts(h, dump);
    await step(h);
    await expectNoButton(h, dump);
  });
});

describe('the background start (`screen` rule) from the agent\'s start call', () => {
  it('meta file: the start is read from the `Agent` call line, not from the hook\'s main turn (B)', async () => {
    const dump = dumpOf(B, ASKED, HOOK_AT);
    const h = await scene([...mainStart(), ...mainMessage()], CASE_1(), dump, 'screen');
    await expectButton(h, dump);
    const [facts] = await h.subagents.read(SESSION, [{ agentId: AGENT, promptId: B }]);
    expect(facts?.agent).toMatchObject({ launch: { at: T0 + 1_100 }, settled: true });
  });

  it('meta file: a resumed agent keeps its background start', async () => {
    const dump = dumpOf(C, RESUMED, RESUMED_USE_AT + 70);
    const h = await scene([...mainStart(), ...mainMessage(), ...mainResume()], CASE_3(), dump, 'screen');
    await expectButton(h, dump);
  });

  it('no meta file: the start is looked for from the hook\'s main turn (B), where it is not', async () => {
    const dump = dumpOf(B, ASKED, HOOK_AT);
    const h = await scene([...mainStart(), ...mainMessage()], CASE_1(), dump, 'screen', false);
    await expectNoButton(h, dump);
    const [facts] = await h.subagents.read(SESSION, [{ agentId: AGENT, promptId: B }]);
    expect(facts?.agent).toMatchObject({ launch: null, settled: true });
  });

  it('no meta file: a hook from the start turn (A) finds the start as before', async () => {
    const dump = dumpOf(A, ASKED, HOOK_AT);
    const h = await scene(mainStart(), CASE_2(), dump, 'screen', false);
    await expectButton(h, dump);
  });
});

describe('the evidence review binds the call from the agent file', () => {
  it('a desk key in the agent file = `settled-at-desk`', async () => {
    const dump = dumpOf(B, ASKED, HOOK_AT);
    const h = await scene([...mainStart(), ...mainMessage()], CASE_1(), dump);
    await expectButton(h, dump);
    clock += 300;
    appendFileSync(h.sub, `${[
      agentResult(clock - 100, B, 'toolu_a2', 'user_temporary'), agentText(clock - 50, 'Done.'),
    ].join('\n')}\n`);
    appendFileSync(h.main, `${mainEnd(clock)}\n`);
    hookExits(h, dump);
    await step(h);
    await createConsentEvidenceReview({
      cycle: h.cycle, locate: async () => h.main, now, intervalMs: 0, log: () => {},
    }).tick();
    expect(h.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'settled-at-desk' });
  });

  it('a desk key of the run before a resume read after the resume = `settled-at-desk`', async () => {
    const dump = dumpOf(B, ASKED, HOOK_AT);
    const h = await scene([...mainStart(), ...mainMessage()], CASE_1(), dump);
    await expectButton(h, dump);
    clock += 300;
    appendFileSync(h.sub, `${[
      agentResult(clock - 100, B, 'toolu_a2', 'user_temporary'), agentText(clock - 50, 'Done.'),
    ].join('\n')}\n`);
    appendFileSync(h.main, `${mainEnd(clock)}\n`);
    hookExits(h, dump);
    await step(h);
    clock = RESUMED_USE_AT + 1_000;
    appendFileSync(h.main, `${mainResume().join('\n')}\n`);
    appendFileSync(h.sub, `${[agentResume(RESUME_AT, C), agentUse(RESUMED_USE_AT, 'toolu_c1', RESUMED)].join('\n')}\n`);
    await createConsentEvidenceReview({
      cycle: h.cycle, locate: async () => h.main, now, intervalMs: 0, log: () => {},
    }).tick();
    expect(h.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'settled-at-desk' });
  });
});

describe('the evidence review binds a key only to a call of the key\'s run', () => {
  const review = (h: Harness) => createConsentEvidenceReview({
    cycle: h.cycle, locate: async () => h.main, now, intervalMs: 0, log: () => {},
  }).tick();

  it('a hook whose run ended without its call is not settled by an identical call after the resume', async () => {
    // Run 1: the hook (with B, newer than the opening entry's A) starts, but its call is never written.
    const old = dumpOf(B, ASKED, HOOK_AT);
    const run1 = CASE_1().slice(0, 3);
    const h = harness([...mainStart(), ...mainMessage()], run1, HOOK_AT + 1_000);
    hookStarts(h, old);
    await step(h);
    clock = HOOK_AT + 2_000;
    appendFileSync(h.main, `${mainEnd(clock)}\n`);
    hookExits(h, old);
    await step(h);
    // Resume: the agent makes the identical call, a desk key decides it.
    const fresh = dumpOf(C, ASKED, RESUMED_USE_AT + 70);
    clock = RESUMED_USE_AT + 1_000;
    appendFileSync(h.main, `${mainResume().join('\n')}\n`);
    appendFileSync(h.sub, `${[agentResume(RESUME_AT, C), agentUse(RESUMED_USE_AT, 'toolu_c1', ASKED)].join('\n')}\n`);
    hookStarts(h, fresh);
    await step(h);
    clock += 300;
    appendFileSync(h.sub, `${[
      agentResult(clock - 100, C, 'toolu_c1', 'user_temporary'), agentText(clock - 50, 'Done.'),
    ].join('\n')}\n`);
    hookExits(h, fresh);
    await step(h);
    await review(h);
    expect(h.cycle.record(SESSION, old.key)).not.toMatchObject({ state: 'settled-at-desk' });
    expect(h.cycle.record(SESSION, old.key)).not.toMatchObject({ toolUseId: 'toolu_c1' });
    appendFileSync(h.main, `${mainEnd(clock)}\n`);
    await review(h);
    expect(h.cycle.record(SESSION, old.key)).not.toMatchObject({ state: 'settled-at-desk' });
    expect(h.cycle.record(SESSION, fresh.key)).toMatchObject({ state: 'settled-at-desk', toolUseId: 'toolu_c1' });
  });

  it('a call of a finished run without a result does not block binding the same input after the resume', async () => {
    // Run 1 leaves the asked call without a result and ends; the resumed run repeats the input.
    const fresh = dumpOf(C, ASKED, RESUMED_USE_AT + 70);
    const main = [...mainStart(), ...mainMessage(), mainEnd(HOOK_AT + 2_000), ...mainResume()];
    const sub = [...CASE_1(), agentResume(RESUME_AT, C), agentUse(RESUMED_USE_AT, 'toolu_c2', ASKED)];
    const h = harness(main, sub, RESUMED_USE_AT + 1_000);
    hookStarts(h, fresh);
    await step(h);
    clock += 300;
    appendFileSync(h.sub, `${[
      agentResult(clock - 100, C, 'toolu_c2', 'user_temporary'), agentText(clock - 50, 'Done.'),
    ].join('\n')}\n`);
    appendFileSync(h.main, `${mainEnd(clock)}\n`);
    hookExits(h, fresh);
    await step(h);
    await review(h);
    expect(h.cycle.record(SESSION, fresh.key)).toMatchObject({ state: 'settled-at-desk', toolUseId: 'toolu_c2' });
  });

  it('pure binding: a key without a known run (an opening entry without a time, a hook older than all) is ambiguous',
    () => {
      const sha = canonicalSha256(ASKED);
      const facts = (runStarts: (number | null)[]): ConsentTurnFacts => ({
        promptId: B, ended: true, partial: false,
        toolUses: [{ id: 'toolu_x', name: 'Bash', inputSha256: sha, line: 2, run: 0 }],
        results: [{
          toolUseId: 'toolu_x', line: 3, at: HOOK_AT + 500, decision: 'accept', source: 'user_temporary',
          interrupted: false,
        }],
        agent: { agentId: AGENT, launch: null, ends: [{ at: HOOK_AT + 1_000, status: 'completed', via: 'notification',
          standby: false }], runStarts, settled: true },
      });
      const key = { key: 'k', toolName: 'Bash', inputSha256: sha, hookStartedAt: HOOK_AT };
      expect(bindAgentTurn([key], facts([T0]))).toMatchObject([{ correlation: 'bound', toolUseId: 'toolu_x' }]);
      // The call is of run 0; the hook started in run 1, so the call is not its candidate.
      expect(bindAgentTurn([key], facts([T0, HOOK_AT - 10])))
        .toMatchObject([{ correlation: 'open', cause: 'no-tool-use' }]);
      expect(bindAgentTurn([key], facts([null]))).toMatchObject([{ correlation: 'ambiguous-tool-use' }]);
      expect(bindAgentTurn([key], facts([HOOK_AT + 1]))).toMatchObject([{ correlation: 'ambiguous-tool-use' }]);
    });
});
