/**
 * The call identity of a consent record against the hook's registration. A record binds its transcript call
 * (`layer1/bind.ts`) by what it took from its first dump: the tool name, the input digest, the turn's `promptId`, the
 * agent and the hook process start, which drops the results written before it. A dump is not authenticated; the
 * registration on the socket is. A first dump that differs from the registration and a correct dump after it leave
 * the record with fields the phone's answer is not signed under, so the bound call can be another one.
 *
 * The real registry, cycle and transcript review over a jsonl file in `$TMPDIR`. The hook's take of the answer file is
 * a `rename` to `.claimed`, and its receipt of an `allow` is the cycle's `confirmReceipt`, as the registration socket
 * calls it (the socket and the hook module end to end: `layer1-receipt.test.ts`).
 */
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createConsentEvidenceReview } from '../src/herdr/consent-evidence.ts';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import type { HookCallDump } from '../src/herdr/dialogs/hook/contract.ts';
import { consentDumpCardSha256 } from '../src/herdr/dialogs/layer1/card.ts';
import {
  CONSENT_CALL_FIELDS, CONSENT_DIRNAME, CONSENT_RECORDS_DIRNAME, CONSENT_SECRET_BYTES,
} from '../src/herdr/dialogs/layer1/contract.ts';
import { createConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import type { ConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import { consentAnswerProven } from '../src/herdr/dialogs/layer1/proof.ts';
import { readConsentRecords } from '../src/herdr/dialogs/layer1/records.ts';
import type { ConsentCall, ConsentSigned } from '../src/herdr/dialogs/layer1/records.ts';
import { createConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import type { ConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import { consentCardSha256 } from '../src/herdr/dialogs/layer1/sign.ts';
import { standingWithRead } from './helpers/dowod-z-odczytem.ts';

const ENGINE = '77777777-7777-4777-8777-777777777777';
/** Another session. */
const OTHER = '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a';
/** The turn of the registration (the key's prefix). */
const PROMPT = '88888888-8888-4888-8888-888888888888';
/** A later turn of the main thread. */
const LATER = '99999999-9999-4999-8999-999999999999';
const INPUT = { command: 'npm test' };
/** The call the phone answered. */
const CALL = 'toolu_000000000000000000000ca1';
/** An identical call before it, without a channel record. */
const CALL_EARLY = 'toolu_000000000000000000000ca0';
/** An identical call after it, without a channel record. */
const CALL_LATER = 'toolu_000000000000000000000ca2';

type Decision = 'allow' | 'deny';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const iso = (at: number): string => new Date(at).toISOString();
let lineNo = 0;
const uuid = (): string => `00000000-0000-4000-9000-${String((lineNo += 1)).padStart(12, '0')}`;

async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise<void>((resolve) => { setImmediate(resolve); });
}

/** The hook's dump as it registers it; the hook process started `startedAt`. */
function dumpOf(seed: string, startedAt: number): HookCallDump {
  return {
    key: `${PROMPT}-${sha(seed).slice(0, 32)}`, sessionId: ENGINE, promptId: PROMPT, pid: process.pid, startedAt,
    toolName: 'Bash', toolInput: INPUT, cwd: '/Users/u/Projects/atlas', at: startedAt + 100,
    inputSha256: canonicalSha256(INPUT), permissionMode: 'default',
  };
}

/** Registration as the hook sends it, over the dump the hook writes. */
function register(reg: ConsentRegistry, dump: HookCallDump): void {
  const cardSha256 = consentCardSha256({
    sessionId: dump.sessionId, toolName: dump.toolName, toolInput: dump.toolInput, cwd: dump.cwd, agentId: null,
    permissionMode: dump.permissionMode ?? null,
  });
  const outcome = reg.register({
    key: dump.key, sessionId: dump.sessionId, promptId: dump.promptId,
    secret: randomBytes(CONSENT_SECRET_BYTES).toString('hex'), inputSha256: dump.inputSha256, cardSha256,
    pid: dump.pid, startedAt: dump.startedAt,
  });
  expect(outcome.status).toBe(200);
}

function human(promptId: string, at: number): string {
  return JSON.stringify({
    type: 'user', uuid: uuid(), timestamp: iso(at), sessionId: ENGINE, promptId, isSidechain: false,
    origin: { kind: 'human' }, message: { role: 'user', content: 'run the tests' },
  });
}

function toolUse(id: string, at: number): string {
  return JSON.stringify({
    type: 'assistant', uuid: uuid(), timestamp: iso(at), sessionId: ENGINE, isSidechain: false,
    message: { id: `msg_${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: INPUT }] },
  });
}

/** The result of a call with its permission decision (`hook`, or a desk key `user_reject`). */
function result(id: string, promptId: string, source: string, decision: 'accept' | 'reject', at: number): string {
  return JSON.stringify({
    type: 'user', uuid: uuid(), timestamp: iso(at), sessionId: ENGINE, promptId, isSidechain: false,
    permissionDecision: { decision, source, reasonType: source, reasonCode: 'unknown' },
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, is_error: decision === 'reject', content: 'ok' }],
    },
  });
}

function turnEnd(at: number): string {
  return JSON.stringify({
    type: 'system', subtype: 'turn_duration', uuid: uuid(), timestamp: iso(at), sessionId: ENGINE,
    isSidechain: false, isMeta: false, durationMs: 4_000,
  });
}

const hookResult = (decision: Decision): 'accept' | 'reject' => (decision === 'allow' ? 'accept' : 'reject');

/**
 * A first dump that differs from the registration in one field, a transcript, and the call the record then binds.
 * The hook process started `start`; `before` is written before the phone's answer, `after` once the hook took it.
 */
interface Scenario {
  readonly what: string;
  readonly decisions: readonly Decision[];
  readonly first: (start: number) => Partial<HookCallDump>;
  /** Signal of the observations: `unknown` = the dialog is gone (answered at the desk), the hook still waits. */
  readonly signal: 'standing' | 'unknown';
  readonly before: (start: number, decision: Decision) => string[];
  readonly after: (start: number, decision: Decision) => string[];
  /** The call a record with the first dump binds. */
  readonly foreign: string;
  /** Outcome of a record whose first dump is the registered one, on the same lines. */
  readonly own: { readonly state: 'applied' | 'settled-at-desk'; readonly toolUseId: string };
}

const SCENARIOS: readonly Scenario[] = [
  {
    // The review finds the earlier result after the decision (a pass that had not reached it, or a race).
    what: 'an earlier hook start: an identical call whose result came before the hook started',
    decisions: ['deny', 'allow'],
    first: (start) => ({ startedAt: start - 60_000 }),
    signal: 'standing',
    before: (start, decision) => [
      human(PROMPT, start - 90_000), toolUse(CALL_EARLY, start - 40_000),
      result(CALL_EARLY, PROMPT, 'hook', hookResult(decision), start - 30_000), toolUse(CALL, start - 1_000),
    ],
    after: (start, decision) => [result(CALL, PROMPT, 'hook', hookResult(decision), start + 2_000)],
    foreign: CALL_EARLY,
    own: { state: 'applied', toolUseId: CALL },
  },
  {
    // The answered call's result is older than the forged start, so a later identical call takes its place.
    what: 'a later hook start: an identical call after the answered one',
    decisions: ['deny', 'allow'],
    first: (start) => ({ startedAt: start + 20_000 }),
    signal: 'standing',
    before: (start) => [human(PROMPT, start - 5_000), toolUse(CALL, start - 1_000)],
    after: (start, decision) => [
      result(CALL, PROMPT, 'hook', hookResult(decision), start + 10_000), toolUse(CALL_LATER, start + 25_000),
      result(CALL_LATER, PROMPT, 'hook', hookResult(decision), start + 30_000),
    ],
    foreign: CALL_LATER,
    own: { state: 'applied', toolUseId: CALL },
  },
  {
    // The dialog was answered at the desk and its hook still waits; the turn of the first dump started after it.
    what: 'the `promptId` of a later turn: an identical call in that turn',
    decisions: ['deny'],
    first: () => ({ promptId: LATER }),
    signal: 'unknown',
    before: (start) => [
      human(PROMPT, start - 5_000), toolUse(CALL, start - 1_000),
      result(CALL, PROMPT, 'user_reject', 'reject', start + 5_000), turnEnd(start + 6_000),
      human(LATER, start + 10_000), toolUse(CALL_LATER, start + 12_000),
    ],
    after: (start) => [result(CALL_LATER, LATER, 'hook', 'reject', start + 15_000)],
    foreign: CALL_LATER,
    own: { state: 'settled-at-desk', toolUseId: CALL },
  },
];

const CASES = SCENARIOS.flatMap((scenario) => scenario.decisions.flatMap((decision) => [false, true]
  .map((restart) => ({ ...scenario, decision, restart, label: `${decision}${restart ? ', after a restart' : ''}` }))));

interface Harness {
  readonly reg: ConsentRegistry;
  readonly cycle: ConsentCycle;
  /** One transcript review tick (the server's 1 s tick). */
  review(): Promise<void>;
}

describe('the call identity of a consent record against its registration', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rarog-wiazanie-rejestracja-'));
    file = join(dir, `${ENGINE}.jsonl`);
    writeFileSync(file, '');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function start(bootId: string, recover = false): Promise<Harness> {
    const reg = createConsentRegistry({ bootId, send: () => true, sessions: () => [ENGINE], log: () => {} });
    reg.setScope('main');
    const cycle = standingWithRead(createConsentCycle({ dataDir: dir, bootId, registry: reg, mode: () => 'main' }));
    if (recover) await cycle.recover();
    const review = createConsentEvidenceReview({ cycle, locate: async () => file });
    return {
      reg, cycle,
      review: async () => {
        await review.tick();
        await flush();
      },
    };
  }

  /**
   * The phone answers the registered dump `real` whose record came from the first dump `first` under the same key:
   * the answer file is signed under the registration, the hook takes it and confirms an `allow`. The record is
   * `claimed` and keeps the first dump's fields.
   */
  async function answered(
    h: Harness, real: HookCallDump, first: HookCallDump, decision: Decision, signal: Scenario['signal'],
  ): Promise<void> {
    register(h.reg, real);
    await h.cycle.observe(ENGINE, real.key, signal, first);
    expect(await h.cycle.observe(ENGINE, real.key, signal, real))
      .toMatchObject(decision === 'allow' ? { canAllow: true } : { canDeny: true });
    expect(await h.cycle.decide(ENGINE, real.key, decision)).toEqual({ ok: true, state: 'sent' });
    const record = h.cycle.record(ENGINE, real.key);
    expect(record).toMatchObject({ promptId: first.promptId, hookStartedAt: first.startedAt });
    const base = join(dir, CONSENT_DIRNAME, ENGINE, real.key);
    renameSync(`${base}.json`, `${base}.claimed`);
    if (decision === 'allow') {
      expect(await h.cycle.confirmReceipt(ENGINE, real.key, record?.decisionAt ?? 0, real.inputSha256)).toBe(true);
    } else {
      await h.cycle.tick();
    }
    expect(h.cycle.record(ENGINE, real.key)?.state).toBe('claimed');
  }

  /** The case run end to end: the answer, an optional restart, the lines after it and one review. */
  async function run(
    scenario: Scenario, decision: Decision, restart: boolean, forged: boolean,
  ): Promise<{ readonly h: Harness; readonly key: string }> {
    const hookStart = Date.now() - 120_000;
    const real = dumpOf(`${scenario.what}-${decision}-${String(restart)}-${String(forged)}`, hookStart);
    const first = forged ? { ...real, ...scenario.first(hookStart) } : real;
    appendFileSync(file, `${scenario.before(hookStart, decision).join('\n')}\n`);
    let h = await start('boot-wiazanie-1');
    await answered(h, real, first, decision, scenario.signal);
    if (restart) {
      h = await start('boot-wiazanie-2', true);
      expect(h.cycle.record(ENGINE, real.key)?.state).toBe('claimed');
    }
    appendFileSync(file, `${scenario.after(hookStart, decision).join('\n')}\n`);
    await h.review();
    return { h, key: real.key };
  }

  it.each(CASES)('first dump with $what ($label): the record binds that call, but its answer is signed under the'
    + ' registration, so the hook result never settles `applied`', async (c) => {
    const { h, key } = await run(c, c.decision, c.restart, true);
    expect(h.cycle.record(ENGINE, key)).toMatchObject({
      state: 'unknown', cause: 'no-receipt', decision: c.decision, correlation: 'bound', toolUseId: c.foreign,
    });
    expect(readConsentRecords(dir).find((r) => r.key === key)).toMatchObject({ state: 'unknown', cause: 'no-receipt' });
  });

  it.each(CASES)('the same lines with a first dump equal to the registration ($what, $label): the record binds its'
    + ' own call and settles as the transcript says', async (c) => {
    const { h, key } = await run(c, c.decision, c.restart, false);
    expect(h.cycle.record(ENGINE, key)).toMatchObject({
      state: c.own.state, decision: c.decision, correlation: 'bound', toolUseId: c.own.toolUseId,
    });
  });

  it.each(['deny', 'allow'] as const)('a record from before the call identity (%s): its `signed` with the digests'
    + ' only reads as no answer, so after a restart the hook result of its own call leaves it `unknown`',
  async (decision) => {
    const hookStart = Date.now() - 120_000;
    const real = dumpOf(`before-the-call-identity-${decision}`, hookStart);
    appendFileSync(file, `${[human(PROMPT, hookStart - 5_000), toolUse(CALL, hookStart - 1_000)].join('\n')}\n`);
    await answered(await start('boot-wiazanie-1'), real, real, decision, 'standing');
    const path = join(dir, CONSENT_RECORDS_DIRNAME, ENGINE, `${real.key}.json`);
    const written = JSON.parse(readFileSync(path, 'utf8')) as { readonly signed: ConsentSigned };
    const { decisionAt, inputSha256, cardSha256 } = written.signed;
    writeFileSync(path, `${JSON.stringify({ ...written, signed: { decisionAt, inputSha256, cardSha256 } })}\n`);
    const read = readConsentRecords(dir).find((r) => r.key === real.key);
    expect(read).toMatchObject({ state: 'claimed', decision, promptId: PROMPT, hookStartedAt: hookStart });
    expect(read?.signed).toBeUndefined();

    const h = await start('boot-wiazanie-2', true);
    appendFileSync(file, `${result(CALL, PROMPT, 'hook', hookResult(decision), hookStart + 2_000)}\n`);
    await h.review();
    expect(h.cycle.record(ENGINE, real.key)).toMatchObject({
      state: 'unknown', cause: 'no-receipt', decision, correlation: 'bound', toolUseId: CALL,
    });
  });
});

describe('consentAnswerProven: the answer signed under the registration of the record\'s own call', () => {
  const card = 'c'.repeat(64);
  const own: ConsentCall = {
    promptId: PROMPT, agentId: null, pid: 4242, hookStartedAt: 1_000, inputSha256: 'a'.repeat(64),
  };
  /** Another value of each field of the call identity: a field added to it needs one here. */
  const other: ConsentCall = {
    promptId: LATER, agentId: 'a0b1c2d3e4f5a6b7c', pid: 4243, hookStartedAt: 1_001, inputSha256: 'b'.repeat(64),
  };
  const signed: ConsentSigned = { decisionAt: 5, cardSha256: card, ...own };
  const deny = { ...own, decision: 'deny', decisionAt: 5, dumpCardSha256: card, signed } as const;
  const allow = { ...deny, decision: 'allow', receipt: { decisionAt: 5, inputSha256: own.inputSha256 } } as const;

  it('the registration of the record\'s own call proves a `deny`, and an `allow` with the hook\'s receipt', () => {
    expect(consentAnswerProven(deny)).toBe(true);
    expect(consentAnswerProven(allow)).toBe(true);
    expect(consentAnswerProven({ ...allow, receipt: undefined })).toBe(false);
  });

  it.each(CONSENT_CALL_FIELDS)('`%s` of the record other than in `signed`, or missing from `signed`: no decision is'
    + ' proven', (field) => {
    const without = Object.fromEntries(Object.entries(signed).filter(([name]) => name !== field));
    for (const record of [deny, allow]) {
      expect(consentAnswerProven({ ...record, [field]: other[field] })).toBe(false);
      expect(consentAnswerProven({ ...record, signed: { ...signed, [field]: other[field] } })).toBe(false);
      expect(consentAnswerProven({ ...record, signed: without as unknown as ConsentSigned })).toBe(false);
    }
  });
});

describe('the record fields a first dump fills', () => {
  /** Fields a dump fills outside the call identity, each checked against the registration otherwise. */
  const SLOT_AND_CARD = [
    // The registry slot: the answer file is signed with this slot's secret, the decision under its registration.
    'key', 'sessionId',
    // The tool name is in the card digest, and `applied` needs the first dump's digest equal to the registration's.
    'toolName', 'dumpCardSha256',
  ];

  it('a new record takes from its dump the call identity, the slot and the card, nothing else: a dump field the'
    + ' binding reads is in `CONSENT_CALL_FIELDS`, so the decision keeps the registration\'s value of it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rarog-wiazanie-pola-'));
    try {
      const bootId = 'boot-wiazanie-pola';
      const reg = createConsentRegistry({ bootId, send: () => true, sessions: () => [ENGINE, OTHER], log: () => {} });
      reg.setScope('all');
      const cycle = createConsentCycle({ dataDir: dir, bootId, registry: reg, mode: () => 'all', now: () => 5_000 });
      const input = { file_path: '/Users/u/Projects/birch/a.ts', old_string: 'a', new_string: 'b' };
      // Two subagent requests (the channel open to them) that differ in every field of the dump. The MCP marker is in
      // neither: it sends a record to the desk at once, another path rather than another value.
      const dumps: readonly HookCallDump[] = [
        {
          ...dumpOf('pola-a', 1_000), agentId: 'a0a0a0a0a0a0a0a0a',
          permissionSuggestions: [{
            type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow',
            destination: 'localSettings',
          }],
        },
        {
          key: `${LATER}-${sha('pola-b').slice(0, 32)}`, sessionId: OTHER, promptId: LATER, pid: process.pid + 1,
          startedAt: 2_000, agentId: 'b1b1b1b1b1b1b1b1b', permissionMode: 'acceptEdits', toolName: 'Edit',
          toolInput: input, cwd: '/Users/u/Projects/birch', at: 2_100, inputSha256: canonicalSha256(input),
          permissionSuggestions: [{
            type: 'addDirectories', directories: ['/Users/u/Projects/birch'], destination: 'session',
          }],
        },
      ];
      for (const dump of dumps) expect(await cycle.observe(dump.sessionId, dump.key, 'standing', dump)).not.toBeNull();
      const [a = {}, b = {}] = dumps
        .map((dump): Record<string, unknown> => ({ ...cycle.record(dump.sessionId, dump.key) }));
      const filled = [...new Set([...Object.keys(a), ...Object.keys(b)])]
        .filter((field) => !isDeepStrictEqual(a[field], b[field])).sort();
      expect(filled, 'a record field filled from a dump, which is not authenticated: add it to `CONSENT_CALL_FIELDS`'
        + ' (`layer1/contract.ts`), so the decision keeps the registration\'s value and `applied` needs it equal')
        .toEqual([...CONSENT_CALL_FIELDS, ...SLOT_AND_CARD].sort());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('the card digest of a dump covers its tool name', () => {
    const dump = dumpOf('pola-c', 1_000);
    expect(consentDumpCardSha256({ ...dump, toolName: 'Write' })).not.toBe(consentDumpCardSha256(dump));
  });
});

describe('the allow button after a re-attach of the herdr socket: the hook start of the registration', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rarog-wiazanie-powrot-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function cycleOf(lines: string[] = []): { readonly reg: ConsentRegistry; readonly cycle: ConsentCycle } {
    const bootId = 'boot-wiazanie-powrot';
    const reg = createConsentRegistry({ bootId, send: () => true, sessions: () => [ENGINE], log: () => {} });
    reg.setScope('main');
    const cycle = standingWithRead(createConsentCycle({
      dataDir: dir, bootId, registry: reg, mode: () => 'main', log: (line) => { lines.push(line); },
    }));
    return { reg, cycle };
  }

  /** The card of a registered hook whose record came from `first`, observed with the dump equal to the registration. */
  async function card(
    h: { readonly reg: ConsentRegistry; readonly cycle: ConsentCycle }, real: HookCallDump, first: HookCallDump,
  ): Promise<void> {
    register(h.reg, real);
    await h.cycle.observe(ENGINE, real.key, 'standing', first);
    expect(await h.cycle.observe(ENGINE, real.key, 'standing', real)).toMatchObject({ canAllow: true });
  }

  /** A re-attach of the socket and the observation that ends its period: the boundary is that observation's time. */
  async function reattach(cycle: ConsentCycle): Promise<void> {
    await cycle.markReattached(ENGINE);
    cycle.noteTranscript(ENGINE, Date.now());
  }

  it.each([
    { what: 'the first dump equal to the registration', first: (real: HookCallDump): HookCallDump => real },
    {
      what: 'a start after the boundary in the first dump',
      first: (real: HookCallDump): HookCallDump => ({ ...real, startedAt: Date.now() + 3_600_000 }),
    },
  ])('a hook started before the boundary ($what): no allow button (`lost=before-reattach`), a phone `allow` is'
    + ' refused', async ({ what, first }) => {
    const lines: string[] = [];
    const h = cycleOf(lines);
    const real = dumpOf(`powrot-przed-${what}`, Date.now() - 120_000);
    await card(h, real, first(real));
    await reattach(h.cycle);
    expect(h.cycle.card(ENGINE, real.key)).toMatchObject({ canAllow: false, unavailable: 'no-proof' });
    // The next observation brings a verdict with the button again: the view takes it at once.
    expect(await h.cycle.observe(ENGINE, real.key, 'standing', real))
      .toMatchObject({ canAllow: false, unavailable: 'no-proof' });
    expect(lines.filter((line) => line.startsWith(`consent: proof of key ${real.key} `)).at(-1))
      .toBe(`consent: proof of key ${real.key} missing: lost=before-reattach`);
    expect(await h.cycle.decide(ENGINE, real.key, 'allow')).toMatchObject({ ok: false, error: 'card-changed' });
  });

  it.each([
    { what: 'the first dump equal to the registration', first: (real: HookCallDump): HookCallDump => real },
    {
      what: 'a start before the boundary in the first dump',
      first: (real: HookCallDump): HookCallDump => ({ ...real, startedAt: real.startedAt - 600_000 }),
    },
  ])('a hook registered after the boundary ($what) keeps the allow button', async ({ what, first }) => {
    const h = cycleOf();
    await reattach(h.cycle);
    const real = dumpOf(`powrot-po-${what}`, Date.now() + 1_000);
    await card(h, real, first(real));
    expect(h.cycle.card(ENGINE, real.key)).toMatchObject({ canAllow: true });
  });

  it('a card whose registration entry is gone has no allow button', async () => {
    const h = cycleOf();
    const real = dumpOf('powrot-bez-wpisu', Date.now() - 120_000);
    await card(h, real, real);
    expect(h.reg.forget(ENGINE, real.key)).toBe(true);
    expect(h.cycle.card(ENGINE, real.key)).toMatchObject({ canAllow: false });
  });
});
