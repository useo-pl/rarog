/**
 * Subagent requests under the `channel` proof rule at effective `all`.
 *
 * Sentences this file guards:
 *
 * - under `channel` a subagent request gets the approve button from the hidden proof with a live hook, an accepted
 *   registration, the full card content and its subagent file known to the end without a closure of the call; the
 *   background start, the top of the screen, the CLI registry state and the session hook list do
 *   not count: a workflow agent, a nested agent, a background subagent while a main-thread dialog stands and a
 *   foreground subagent (the `Ask rule` dialog with Yes/No only) all get the button, and an `allow` carries
 *   `proofKind: 'hidden'` (a hook's `allow` runs such requests: 7 of 7, CLI 2.1.322);
 * - a workflow agent's transcript (`subagents/workflows/wf_<id>/agent-<id>.jsonl`) is read like a subagent file,
 *   by the observation and by the review that settles the effect: a desk key there = `settled-at-desk`, a hook result
 *   after a phone `allow` = `unknown` (`no-receipt`); the same agent file under two runs gives no facts;
 * - a subagent file with the call's result or an interrupted result takes the button; an unfinished last line too;
 * - the `screen` rule (CLI newer than measured), MCP tools and the `main` mode keep the behaviour before the rule.
 *
 * Session files are lines of the subagent fixtures (CLI 2.1.319): `nested-workflow-1` (workflow agent), `nested-1` (nested agent,
 * `spawnDepth` 2), `background-hidden-1` (background subagent), and `subagent-fg` (foreground subagent, CLI 2.1.314) with the
 * `Bash` input swapped for the device case. Dumps lie on disk in the test data dir, `ps` is a stub; the cycle,
 * registry, subagent file reader and observation are real, with the test clock.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createConsentEvidenceReview, nodeConsentEvidenceIo } from '../src/herdr/consent-evidence.ts';
import { createSubagentObservation } from '../src/herdr/consent-subagent.ts';
import type { SubagentObservation } from '../src/herdr/consent-subagent.ts';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import { HOOK_PENDING_DIRNAME } from '../src/herdr/dialogs/hook/contract.ts';
import type { HookCallDump } from '../src/herdr/dialogs/hook/contract.ts';
import {
  CONSENT_DIRNAME, CONSENT_EVIDENCE_SCAN_MAX_BYTES, CONSENT_SECRET_BYTES, CONSENT_SUBAGENT_GRACE_MS,
} from '../src/herdr/dialogs/layer1/contract.ts';
import { createConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import type { ConsentCycle, ConsentObservedSignal } from '../src/herdr/dialogs/layer1/cycle.ts';
import type { ConsentEffectiveMode } from '../src/herdr/dialogs/layer1/mode.ts';
import { createConsentTopLoss, observeConsentSession } from '../src/herdr/dialogs/layer1/observe.ts';
import type { ConsentTopLoss } from '../src/herdr/dialogs/layer1/observe.ts';
import type { ConsentProofRule } from '../src/herdr/dialogs/layer1/proof.ts';
import { readConsentRecords } from '../src/herdr/dialogs/layer1/records.ts';
import { createConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import type { ConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import { consentCardSha256 } from '../src/herdr/dialogs/layer1/sign.ts';
import { matchTop } from '../src/herdr/dialogs/layer1/top.ts';
import type { ConsentScreenRead } from '../src/herdr/dialogs/layer1/top.ts';
import type { RegistryEvidence } from '../src/herdr/dialogs/shadow/evidence.ts';
import type { ProcessLiveness } from '../src/herdr/dialogs/shadow/liveness.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DOWOD = join(REPO, 'server', 'test', 'fixtures', 'consent-dowod');
const fixture = (name: string): string => readFileSync(join(DOWOD, name), 'utf8');
const linesOf = (name: string): string[] => fixture(name).split('\n').filter((line) => line !== '');
const BOOT = 'boot-subagent-all';

interface HookInput {
  readonly session_id: string;
  readonly prompt_id: string;
  readonly agent_id: string;
  readonly cwd: string;
  readonly tool_input: Record<string, unknown>;
}

/** One request scene: session files, where the subagent file lies, the hook input and the time of its `tool_use`. */
interface Scene {
  readonly hook: HookInput;
  readonly main: readonly string[];
  readonly sub: readonly string[];
  /** Subagent file path relative to the session directory. */
  readonly subPath: string;
  readonly useAt: number;
}

const timeOf = (line: string): number =>
  Date.parse(String((JSON.parse(line) as { timestamp?: string }).timestamp));

/** Entry with every `tool_use` input replaced by `input`. */
function withInput(line: string, input: unknown): string {
  const entry = JSON.parse(line) as { message?: { content?: { type?: string; input?: unknown }[] } };
  for (const block of entry.message?.content ?? []) if (block.type === 'tool_use') block.input = input;
  return JSON.stringify(entry);
}

/** Entry stamped `when` (ms since epoch). */
function at(line: string, when: number): string {
  return JSON.stringify({ ...(JSON.parse(line) as Record<string, unknown>), timestamp: new Date(when).toISOString() });
}

/** Lines up to (without) the first one containing `marker`. */
function before(lines: readonly string[], marker: string): string[] {
  const index = lines.findIndex((line) => line.includes(marker));
  return index === -1 ? [...lines] : lines.slice(0, index);
}

/** Lines up to and including the first `tool_use` entry (the hook waits on it). */
function upToToolUse(lines: readonly string[]): string[] {
  const index = lines.findIndex((line) => line.includes('"type":"tool_use"'));
  return lines.slice(0, index + 1);
}

function sceneOf(name: string, subPath: (agentId: string) => string): Scene {
  const hook = JSON.parse(fixture(`${name}.hook.json`)) as HookInput;
  const sub = upToToolUse(linesOf(`${name}.subagent.jsonl`));
  return {
    hook, main: before(linesOf(`${name}.glowny.jsonl`), '"type":"queue-operation"'), sub, subPath: subPath(hook.agent_id),
    useAt: timeOf(sub.at(-1) ?? ''),
  };
}

const flat = (agentId: string): string => join('subagents', `agent-${agentId}.jsonl`);
const RUN = 'wf_m8pomiar-001';
const inRun = (run: string) => (agentId: string): string => join('subagents', 'workflows', run, `agent-${agentId}.jsonl`);

/** Workflow agent: dialog at the desk, registry `waiting: permission`, file under a workflow run. */
const WORKFLOW = sceneOf('nested-workflow-1', inRun(RUN));
/** Nested agent (`spawnDepth` 2): no dialog on screen, the main file has only the parent's background start. */
const NESTED = sceneOf('nested-1', flat);
/** Background subagent; the main file is the turn before the end notification. */
const BACKGROUND = ((): Scene => {
  const hook = JSON.parse(fixture('background-hidden-1.hook.json')) as HookInput;
  const sub = upToToolUse(linesOf('background-hidden-1.subagent.jsonl'));
  return {
    hook, main: before(linesOf('background-hidden-1.glowny.jsonl'), '<task-notification>'), sub, subPath: flat(hook.agent_id),
    useAt: timeOf(sub.at(-1) ?? ''),
  };
})();
/** The device case: foreground subagent, `git branch -D`, `Ask rule` dialog with Yes/No only. */
const DEVICE_INPUT = { command: 'git branch -D feature/old-work', description: 'Delete the merged local branch' };
const FOREGROUND = ((): Scene => {
  const hook = JSON.parse(fixture('subagent-fg.hook.json')) as HookInput;
  const sub = upToToolUse(linesOf('subagent-fg.jsonl')).map((line) => withInput(line, DEVICE_INPUT));
  return {
    hook: { ...hook, tool_input: DEVICE_INPUT },
    // The main turn up to the open `Agent` call: a foreground subagent's result comes only at its end.
    main: upToToolUse(linesOf('subagent-fg.glowny.jsonl')), sub, subPath: flat(hook.agent_id),
    useAt: timeOf(sub.at(-1) ?? ''),
  };
})();
/** Synthetic screen of the device case: the `Ask rule` line and Yes/No only. */
const DEVICE_SCREEN = [
  '─'.repeat(100),
  ' Bash command · from the general-purpose agent',
  '',
  `   ${DEVICE_INPUT.command}`,
  `   ${DEVICE_INPUT.description}`,
  '',
  ' Ask rule Bash(git branch -D *) overrides auto mode for this command.',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. No',
  '',
  ' Esc to cancel · Tab to amend',
].join('\n');

let clock = 0;
const now = (): number => clock;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const busy = (): RegistryEvidence => ({ kind: 'active', at: clock });
const waitingPermission = (): RegistryEvidence => ({ kind: 'waiting', dialog: 'permission', at: clock });

type Tryb = Extract<ConsentEffectiveMode, 'main' | 'all'>;

interface Harness {
  readonly scene: Scene;
  readonly dir: string;
  readonly main: string;
  readonly sub: string;
  readonly reg: ConsentRegistry;
  readonly cycle: ConsentCycle;
  readonly subagents: SubagentObservation;
  readonly topLoss: ConsentTopLoss;
  /** The hook-list condition from the session hook list (a stub source). */
  readonly h8: { ok: boolean };
  readonly signals: Map<string, ConsentObservedSignal>;
}

function harness(scene: Scene, tryb: Tryb = 'all'): Harness {
  clock = scene.useAt + 70 + 1_000;
  const dir = mkdtempSync(join(tmpdir(), 'rarog-subagent-all-'));
  dirs.push(dir);
  const session = scene.hook.session_id;
  const main = join(dir, 'projekt', `${session}.jsonl`);
  const sub = join(dir, 'projekt', session, scene.subPath);
  mkdirSync(dirname(sub), { recursive: true });
  writeFileSync(main, `${scene.main.join('\n')}\n`);
  writeFileSync(sub, `${scene.sub.join('\n')}\n`);
  const reg = createConsentRegistry({ bootId: BOOT, send: () => true, sessions: () => [session], log: () => {}, now });
  reg.setScope(tryb);
  const started = clock;
  clock = started - 10_000;
  const cycle = createConsentCycle({ dataDir: dir, bootId: BOOT, registry: reg, now, mode: () => tryb, log: () => {} });
  clock = started;
  const subagents = createSubagentObservation({
    io: nodeConsentEvidenceIo, locate: async () => main, agentFiles: true, maxBytes: CONSENT_EVIDENCE_SCAN_MAX_BYTES,
  });
  return {
    scene, dir, main, sub, reg, cycle, subagents, topLoss: createConsentTopLoss(), h8: { ok: true },
    signals: new Map(),
  };
}

function dumpOf(h: Harness, over: Partial<HookCallDump> = {}): HookCallDump {
  const { hook } = h.scene;
  const input = over.toolInput ?? hook.tool_input;
  const nonce = createHash('sha256').update(JSON.stringify([hook.agent_id, over.toolName ?? 'Bash'])).digest('hex')
    .slice(0, 32);
  return {
    key: `${hook.prompt_id}-${nonce}`, sessionId: hook.session_id, promptId: hook.prompt_id, agentId: hook.agent_id,
    pid: process.pid, startedAt: h.scene.useAt + 70, toolName: 'Bash', toolInput: input, cwd: hook.cwd,
    at: h.scene.useAt + 170, inputSha256: canonicalSha256(input), permissionMode: 'default', ...over,
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

/**
 * One observation step with the server's sources at `all` (subagent files, top loss memory, hook list) and the proof
 * rule `rule`; at `main` the server gives no subagent sources.
 */
async function step(h: Harness, opts: {
  registry?: RegistryEvidence; screen?: ConsentScreenRead | null; rule?: ConsentProofRule; tryb?: Tryb;
} = {}): Promise<void> {
  const liveness: ProcessLiveness = async (processes) => new Map(processes.map((proc) => [proc.pid, true]));
  const cycle: Parameters<typeof observeConsentSession>[0] = {
    ...h.cycle,
    observe: async (sessionId, key, signal, ...rest) => {
      h.signals.set(key, signal);
      return h.cycle.observe(sessionId, key, signal, ...rest);
    },
  };
  const all = (opts.tryb ?? 'all') === 'all';
  const session = h.scene.hook.session_id;
  await observeConsentSession(cycle, {
    dataDir: h.dir, sessionId: session, liveness, registry: opts.registry ?? busy(), transcript: null,
    screen: opts.screen ?? null, now, proofRule: opts.rule ?? 'channel',
    ...(all ? {
      subagentTurns: (requests) => h.subagents.read(session, requests),
      hidden: {
        topLoss: h.topLoss,
        sessionHooks: async (_sid, dumps) => new Set(h.h8.ok ? dumps.map((dump) => dump.key) : []),
      },
    } : {}),
  });
}

const answerPath = (h: Harness, dump: HookCallDump): string =>
  join(h.dir, CONSENT_DIRNAME, dump.sessionId, `${dump.key}.json`);
const NO_BUTTON = { state: 'pending', canAllow: false, unavailable: 'no-proof' };

/** The card has the button, and `allow` is signed with `proofKind: 'hidden'`. */
async function expectButtonAndAllow(h: Harness, dump: HookCallDump): Promise<void> {
  expect(h.signals.get(dump.key)).toBe('hidden');
  expect(h.cycle.card(dump.sessionId, dump.key)).toMatchObject({ state: 'pending', canAllow: true });
  expect(await h.cycle.decide(dump.sessionId, dump.key, 'allow')).toMatchObject({ ok: true, state: 'sent' });
  expect(existsSync(answerPath(h, dump))).toBe(true);
  expect(readConsentRecords(h.dir).find((record) => record.key === dump.key))
    .toMatchObject({ state: 'sent', decision: 'allow', proofKind: 'hidden' });
}

describe('subagent requests under the `channel` rule at `all`', () => {
  it('workflow agent (file under `subagents/workflows/wf_<id>/`), dialog at the desk: button', async () => {
    const h = harness(WORKFLOW);
    const dump = dumpOf(h);
    hookStarts(h, dump);
    const screen = fixture('workflow.ekran.txt');
    await step(h, { registry: waitingPermission(), screen: { text: screen, readStartedAt: clock - 300 } });
    await expectButtonAndAllow(h, dump);
  });

  it('nested agent (`spawnDepth` 2, no start of its own in the main file): button', async () => {
    const h = harness(NESTED);
    const dump = dumpOf(h);
    hookStarts(h, dump);
    await step(h);
    await expectButtonAndAllow(h, dump);
  });

  it('background subagent while a main-thread dialog stands (registry `waiting: permission`): button', async () => {
    const h = harness(BACKGROUND);
    const dump = dumpOf(h);
    hookStarts(h, dump);
    const screen = fixture('main-beside-hidden.ekran.txt');
    await step(h, { registry: waitingPermission(), screen: { text: screen, readStartedAt: clock - 300 } });
    await expectButtonAndAllow(h, dump);
  });

  it('device case: foreground subagent, `git branch -D` under an `Ask rule` dialog with Yes/No only: button,'
    + ' and no desk fallback after 10 s', async () => {
    const h = harness(FOREGROUND);
    const dump = dumpOf(h);
    hookStarts(h, dump);
    const session = dump.sessionId;
    for (let elapsed = 0; elapsed <= CONSENT_SUBAGENT_GRACE_MS + 400; elapsed += 1_000) {
      await step(h, { registry: waitingPermission(), screen: { text: DEVICE_SCREEN, readStartedAt: clock - 200 } });
      expect(h.cycle.card(session, dump.key)).toMatchObject({ state: 'pending', canAllow: true });
      clock += 1_000;
      await h.cycle.tick();
    }
    expect(h.cycle.record(session, dump.key)).toMatchObject({ state: 'pending', decision: null });
    await step(h, { registry: waitingPermission(), screen: { text: DEVICE_SCREEN, readStartedAt: clock - 200 } });
    await expectButtonAndAllow(h, dump);
  });

  it('a screen read where the dump is on top does not take the button (the top does not count)', async () => {
    const h = harness(BACKGROUND);
    const input = { command: 'echo fg-1 >> fg-1.txt', description: 'fg-1' };
    writeFileSync(h.sub, `${h.scene.sub.map((line) => withInput(line, input)).join('\n')}\n`);
    const dump = dumpOf(h, { toolInput: input, inputSha256: canonicalSha256(input) });
    hookStarts(h, dump);
    const screen = fixture('foreground-subagent.ekran.txt');
    expect(matchTop(screen, dump)).toBe('match');
    await step(h, { screen: { text: screen, readStartedAt: clock - 300 } });
    clock += 500;
    await step(h);
    await expectButtonAndAllow(h, dump);
  });

  it('a session hook list with another hook does not take the button (a foreign decision is a result)', async () => {
    const h = harness(NESTED);
    h.h8.ok = false;
    const dump = dumpOf(h);
    hookStarts(h, dump);
    await step(h);
    await expectButtonAndAllow(h, dump);
  });

  it.each([
    ['the call\'s result', (): string[] => {
      const result = linesOf('nested-1.subagent.jsonl').filter((line) => line.includes('"tool_result"'));
      return result.map((line) => at(line, clock - 100));
    }],
    ['an interrupted result (Esc at the desk)', (h: Harness): string[] => {
      const s = linesOf('background-stop-1.subagent.jsonl');
      const other = JSON.parse(fixture('background-stop-1.hook.json')) as HookInput;
      const useId = /"id":"(toolu_\d+)"/.exec(s[2] ?? '')?.[1] ?? '';
      const ownId = /"id":"(toolu_\d+)"/.exec(h.scene.sub.at(-1) ?? '')?.[1] ?? '';
      return s.slice(3).map((line) => at(line.replaceAll(other.agent_id, h.scene.hook.agent_id)
        .replaceAll(other.session_id, h.scene.hook.session_id).replaceAll(useId, ownId)
        .replaceAll(other.prompt_id, h.scene.hook.prompt_id), clock - 100));
    }],
  ])('subagent file with %s: no button', async (_what, closure) => {
    const h = harness(NESTED);
    const dump = dumpOf(h);
    hookStarts(h, dump);
    await step(h);
    expect(h.cycle.card(dump.sessionId, dump.key)?.canAllow).toBe(true);
    clock += 300;
    appendFileSync(h.sub, `${closure(h).join('\n')}\n`);
    await step(h);
    expect(h.cycle.card(dump.sessionId, dump.key)).toMatchObject({ state: 'pending', canAllow: false });
    expect(await h.cycle.decide(dump.sessionId, dump.key, 'allow')).toMatchObject({ ok: false });
    expect(existsSync(answerPath(h, dump))).toBe(false);
  });

  it('subagent file with an unfinished last line: no button', async () => {
    const h = harness(WORKFLOW);
    appendFileSync(h.sub, '{"type":"user","isSidechain":true');
    const dump = dumpOf(h);
    hookStarts(h, dump);
    await step(h, { registry: waitingPermission() });
    expect(h.cycle.card(dump.sessionId, dump.key)).toMatchObject(NO_BUTTON);
  });

  it('`screen` rule (CLI newer than measured): nested and workflow agents keep no button', async () => {
    for (const scene of [NESTED, WORKFLOW]) {
      const h = harness(scene);
      const dump = dumpOf(h);
      hookStarts(h, dump);
      await step(h, { rule: 'screen' });
      expect(h.signals.get(dump.key)).toBe('unknown');
      expect(h.cycle.card(dump.sessionId, dump.key)).toMatchObject(NO_BUTTON);
    }
  });

  it('MCP tool of a nested agent under `channel`: no button (the hidden proof needs its background start)',
    async () => {
      const h = harness(NESTED);
      const input = { query: 'x' };
      writeFileSync(h.sub, `${h.scene.sub.map((line) => withInput(line, input)
        .replace('"name":"Bash"', '"name":"mcp__probe__lookup"')).join('\n')}\n`);
      const dump = dumpOf(h, { toolName: 'mcp__probe__lookup', toolInput: input, inputSha256: canonicalSha256(input) });
      hookStarts(h, dump);
      await step(h);
      expect(h.cycle.card(dump.sessionId, dump.key)).toMatchObject(NO_BUTTON);
    });

  it('`main` mode: the subagent request stays in the terminal', async () => {
    const h = harness(NESTED, 'main');
    const dump = dumpOf(h);
    const path = join(h.dir, HOOK_PENDING_DIRNAME, dump.sessionId, `${dump.key}.json`);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(dump), { mode: 0o600 });
    await step(h, { tryb: 'main' });
    expect(h.signals.get(dump.key)).not.toBe('hidden');
    expect(h.cycle.card(dump.sessionId, dump.key)).toMatchObject({ canAllow: false, unavailable: 'terminal-only' });
  });
});

/** The hook left: its dump is gone. */
function hookExits(h: Harness, dump: HookCallDump): void {
  rmSync(join(h.dir, HOOK_PENDING_DIRNAME, dump.sessionId, `${dump.key}.json`), { force: true });
}

/** The server's evidence review over the scene files. */
const reviewOf = (h: Harness): { tick: () => Promise<void> } => createConsentEvidenceReview({
  cycle: h.cycle, locate: async () => h.main, now, intervalMs: 0, log: () => {},
});

/** The workflow agent file after its `tool_use`: the decision attachment, the result and the answer, stamped `when`. */
const workflowResult = (when: number): string[] =>
  linesOf('nested-workflow-1.subagent.jsonl').slice(WORKFLOW.sub.length).map((line) => at(line, when));

describe('effect of a workflow agent request from its file', () => {
  it('desk key (`user_temporary`) in the workflow agent file: `settled-at-desk`', async () => {
    const h = harness(WORKFLOW);
    const dump = dumpOf(h);
    hookStarts(h, dump);
    await step(h, { registry: waitingPermission() });
    expect(h.cycle.card(dump.sessionId, dump.key)?.canAllow).toBe(true);
    clock += 300;
    const desk = workflowResult(clock - 100).filter((line) => !line.includes('"hook_permission_decision"'))
      .map((line) => line.replace('"source":"hook","reasonType":"hook","reasonCode":"unknown"',
        '"source":"user_temporary"'));
    expect(desk.some((line) => line.includes('"source":"user_temporary"'))).toBe(true);
    appendFileSync(h.sub, `${desk.join('\n')}\n`);
    hookExits(h, dump);
    await step(h);
    await reviewOf(h).tick();
    expect(h.cycle.record(dump.sessionId, dump.key)).toMatchObject({ state: 'settled-at-desk' });
  });

  it('hook result after a phone `allow` in the workflow agent file: `unknown` (`no-receipt`)', async () => {
    const h = harness(WORKFLOW);
    const dump = dumpOf(h);
    hookStarts(h, dump);
    await step(h, { registry: waitingPermission() });
    expect(await h.cycle.decide(dump.sessionId, dump.key, 'allow')).toMatchObject({ ok: true, state: 'sent' });
    renameSync(answerPath(h, dump), answerPath(h, dump).replace(/\.json$/u, '.claimed'));
    clock += 300;
    appendFileSync(h.sub, `${workflowResult(clock - 100).join('\n')}\n`);
    hookExits(h, dump);
    await step(h);
    await reviewOf(h).tick();
    expect(h.cycle.record(dump.sessionId, dump.key)).toMatchObject({
      state: 'unknown', cause: 'no-receipt', decision: 'allow', proofKind: 'hidden',
    });
  });
});

describe('workflow agent file reader', () => {
  const request = { agentId: WORKFLOW.hook.agent_id, promptId: WORKFLOW.hook.prompt_id };

  it('file under one workflow run: the turn facts, known to the end', async () => {
    const h = harness(WORKFLOW);
    const [facts] = await h.subagents.read(WORKFLOW.hook.session_id, [request]);
    expect(facts).toMatchObject({ partial: false, settled: true, caughtUp: true, results: [] });
    expect(facts?.toolUses.map((one) => one.name)).toEqual(['Bash']);
  });

  it('the same agent file under two runs: no facts', async () => {
    const h = harness(WORKFLOW);
    const second = join(h.dir, 'projekt', WORKFLOW.hook.session_id, inRun('wf_m8pomiar-002')(request.agentId));
    mkdirSync(dirname(second), { recursive: true });
    writeFileSync(second, readFileSync(h.sub));
    expect(await h.subagents.read(WORKFLOW.hook.session_id, [request])).toEqual([null]);
  });

  it('a run directory outside the `wf_<id>` shape is not read', async () => {
    const h = harness(WORKFLOW);
    const odd = join(h.dir, 'projekt', WORKFLOW.hook.session_id, inRun('not-a-run')(request.agentId));
    mkdirSync(dirname(odd), { recursive: true });
    writeFileSync(odd, readFileSync(h.sub));
    rmSync(h.sub);
    expect(await h.subagents.read(WORKFLOW.hook.session_id, [request])).toEqual([null]);
  });
});
