/**
 * Outcome of a consent card from the transcript during the turn (`layer1/turns.ts`).
 *
 * The real transcript review (`createConsentEvidenceReview` over a jsonl file in `$TMPDIR`), the real cycle and
 * registry, and the real manager whose events go to the devices (fake herdr supervisor and driver, as
 * `consent-card-after-consent.test.ts`). No hand-made turn facts: every outcome comes from lines appended to
 * the file and one review tick.
 *
 * Without the hook's receipt (`POST /claim`) a hook `allow` never makes `applied`: the cards here get none, so
 * the record stays `unknown` (`no-receipt`). A hook `deny` needs no receipt and settles `applied` when its answer is
 * signed under the registration of the record's own call (tool name, input, turn, hook start). The rules are checked
 * on `consentReceiptOf`, `consentAnswerProven` and `consentSettlement` themselves; the receipt path and answers signed
 * over another call end to end: `layer1-receipt.test.ts`; a first dump other than the registration:
 * `layer1-binding-registration.test.ts`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HerdrStatus, PermissionRequest, ServerEvent } from '@rarog/shared';
import { consentManagerCards } from '../src/bootstrap/consent.ts';
import { createConsentEvidenceReview, createConsentEvidenceScanner } from '../src/herdr/consent-evidence.ts';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import type { HookCallDump } from '../src/herdr/dialogs/hook/contract.ts';
import {
  CONSENT_DIRNAME, CONSENT_EVIDENCE_SCAN_INTERVAL_MS, CONSENT_RECORDS_DIRNAME, CONSENT_SECRET_BYTES,
} from '../src/herdr/dialogs/layer1/contract.ts';
import { consentDumpCardSha256 } from '../src/herdr/dialogs/layer1/card.ts';
import { createConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import type { ConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import { retireRunningAfterRecover } from '../src/herdr/dialogs/layer1/frames.ts';
import { consentAnswerProven, consentReceiptOf, consentSettlement } from '../src/herdr/dialogs/layer1/proof.ts';
import { readConsentRecords } from '../src/herdr/dialogs/layer1/records.ts';
import { createConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import type { ConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import { consentCardSha256 } from '../src/herdr/dialogs/layer1/sign.ts';
import type { HerdrAgent } from '../src/herdr/types.ts';
import { createManager } from '../src/sessions/manager.ts';
import type { ConsentManagerChannel, HerdrManagerDeps, Manager } from '../src/sessions/manager.ts';
import { AtrapaDrivera, AtrapaNadzorcy } from './helpers/atrapa-sesji.ts';
import { standingWithRead } from './helpers/dowod-z-odczytem.ts';

const PROJECT = '/Users/u/Projects/atlas';
const ENGINE = '55555555-5555-4555-8555-555555555555';
const PROMPT = '66666666-6666-4666-8666-666666666666';
const KEY = 'w9:p72';
const INPUT = { command: 'npm test' };

class FakeSupervisor extends AtrapaNadzorcy {
  readonly live = new Map<string, HerdrAgent>();

  override status(): HerdrStatus {
    return { available: true, agentCount: 0, readOnly: false, canLaunch: true };
  }

  protected nowyDriver(key: string): AtrapaDrivera {
    const driver = new AtrapaDrivera(key);
    driver.queue.push({ type: 'agent-state', state: 'idle', seen: true });
    return driver;
  }

  agentFor(key: string): HerdrAgent | undefined {
    return this.live.get(key);
  }

  appear(agent: HerdrAgent): void {
    this.live.set(agent.key, agent);
    this.lifecycle.push({ type: 'appeared', agent });
  }
}

function makeDeps(): HerdrManagerDeps {
  const aliases = new Map<string, string>();
  return {
    sessionIdFor: (key: string) => `herdr-${key.replace(/[^a-z0-9]/gi, '-')}`,
    aliasFor: (engine) => aliases.get(engine),
    rememberAlias: (engine, id) => { aliases.set(engine, id); },
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
    title: 'turns', stateChangeSeq: 1, mode: 'auto', modeReadAt: 0, inScope: true, tabId: 'w9:t3',
    launchedByRarog: false, interactiveReady: true,
  };
}

async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}

function dumpOf(seed: string): HookCallDump {
  const nonce = createHash('sha256').update(seed).digest('hex').slice(0, 32);
  const startedAt = Date.now() - 1_000;
  return {
    key: `${PROMPT}-${nonce}`, sessionId: ENGINE, promptId: PROMPT, pid: process.pid, startedAt, toolName: 'Bash',
    toolInput: INPUT, cwd: PROJECT, at: startedAt + 100, inputSha256: canonicalSha256(INPUT), permissionMode: 'default',
  };
}

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

// ---------------------------------------------------------------------------
// Transcript lines in the shapes of `fixtures/consent-dowod/bash-krotki.jsonl` (CLI 2.1.314)
// ---------------------------------------------------------------------------

const iso = (): string => new Date().toISOString();

function humanLine(): string {
  return JSON.stringify({
    type: 'user', uuid: '00000000-0000-4000-9000-0000000000a1', timestamp: iso(), sessionId: ENGINE, promptId: PROMPT,
    isSidechain: false, origin: { kind: 'human' }, message: { role: 'user', content: 'run the tests' },
  });
}

function toolUseLine(ids: readonly string[], n = 'a2'): string {
  return JSON.stringify({
    type: 'assistant', uuid: `00000000-0000-4000-9000-0000000000${n}`, timestamp: iso(), sessionId: ENGINE,
    isSidechain: false, message: {
      id: `msg_0000000000000000000000${n}`, role: 'assistant',
      content: ids.map((id) => ({ type: 'tool_use', id, name: 'Bash', input: INPUT })),
    },
  });
}

function resultLine(id: string, decision: 'accept' | 'reject', source: string): string {
  return JSON.stringify({
    type: 'user', uuid: '00000000-0000-4000-9000-0000000000a3', timestamp: iso(), sessionId: ENGINE, promptId: PROMPT,
    isSidechain: false, permissionDecision: { decision, source, reasonType: source, reasonCode: 'unknown' },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: false, content: 'ok' }] },
  });
}

/** The hook's `deny` in the file, in the shape of `fixtures/consent-dowod/bash-odrzuc.jsonl` (CLI 2.1.314). */
function hookRejectLine(id: string): string {
  return JSON.stringify({
    type: 'user', uuid: '00000000-0000-4000-9000-0000000000a5', timestamp: iso(), sessionId: ENGINE, promptId: PROMPT,
    isSidechain: false,
    permissionDecision: { decision: 'reject', source: 'hook', reasonType: 'hook', reasonCode: 'hook:PermissionRequest' },
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: 'The user denied this from the phone.' }],
    },
  });
}

function endLine(): string {
  return JSON.stringify({
    type: 'system', subtype: 'turn_duration', uuid: '00000000-0000-4000-9000-0000000000a4', timestamp: iso(),
    sessionId: ENGINE, isSidechain: false, isMeta: false, durationMs: 4_000,
  });
}

const CALL = 'toolu_0000000000000000000000c1';
const CALL_TWIN = 'toolu_0000000000000000000000c2';

// ---------------------------------------------------------------------------

interface Harness {
  readonly manager: Manager;
  readonly cycle: ConsentCycle;
  readonly reg: ConsentRegistry;
  readonly driver: AtrapaDrivera;
  readonly id: string;
  readonly events: ServerEvent[];
  /** One review tick, as the server's 1 s tick (default pace of 30 s for a caught-up turn). */
  tick(): Promise<void>;
  /** One review tick after the review pace (`CONSENT_EVIDENCE_SCAN_INTERVAL_MS`) has passed. */
  later(): Promise<void>;
}

describe('consent outcome from the transcript during the turn', () => {
  const closers: (() => Promise<void>)[] = [];
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rarog-turns-'));
    file = join(dir, `${ENGINE}.jsonl`);
    writeFileSync(file, '');
  });

  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
    await rm(dir, { recursive: true, force: true });
  });

  async function start(bootId = 'boot-turns-1', recover = false): Promise<Harness> {
    const reg = createConsentRegistry({ bootId, send: () => true, sessions: () => [ENGINE], log: () => {} });
    reg.setScope('main');
    let managerRef: Manager | null = null;
    const cycle: ConsentCycle = standingWithRead(createConsentCycle({
      dataDir: dir, bootId, registry: reg, mode: () => 'main',
      onCard: (view) => {
        managerRef?.applyConsentCard?.(view, cycle.record(view.sessionId, view.permId)?.decision ?? null);
      },
    }));
    if (recover) {
      await cycle.recover();
      await retireRunningAfterRecover(cycle, () => {});
    }
    const consent: ConsentManagerChannel = {
      cards: (engine) => consentManagerCards(cycle, engine),
      decide: (engine, permId, decision) => cycle.decide(engine, permId, decision),
      release: (engine, permId) => cycle.release(engine, permId),
      revoke: (engine, cause) => cycle.revokeSession(engine, cause),
      retire: async (engine, permId) => { await cycle.retire(engine, permId); },
      turnEnded: async () => {},
      reattached: async () => {},
      ended: (engine) => { cycle.endPool(engine); },
    };
    const supervisor = new FakeSupervisor();
    const manager = await createManager({
      demo: false, dataDir: dir, projects: [{ path: PROJECT, name: 'atlas' }], projectRoots: [], gitStatus: null,
      maxPanes: 6, herdrSupervisor: supervisor, herdrDeps: makeDeps(), herdrRoots: [PROJECT],
      herdrSend: true, consent, logger: () => {},
    });
    await manager.ready;
    managerRef = manager;
    const events: ServerEvent[] = [];
    manager.onEvent((_scope, _seq, event) => { events.push(event); });
    supervisor.appear(makeAgent());
    await flush();
    const id = manager.list().find((s) => s.paneId === KEY)?.id ?? '';
    expect(id).not.toBe('');
    closers.push(async () => {
      await manager.dispose();
      supervisor.dispose();
    });
    let skew = 0;
    const review = createConsentEvidenceReview({ cycle, locate: async () => file, now: () => Date.now() + skew });
    const tick = async (): Promise<void> => {
      await review.tick();
      await flush();
    };
    return {
      manager, cycle, reg, driver: supervisor.driver(KEY), id, events, tick,
      later: async () => {
        skew += CONSENT_EVIDENCE_SCAN_INTERVAL_MS;
        await tick();
      },
    };
  }

  async function card(h: Harness, seed: string): Promise<HookCallDump> {
    h.driver.queue.push({ type: 'agent-state', state: 'blocked' });
    await flush();
    const dump = dumpOf(seed);
    register(h.reg, dump);
    await h.cycle.observe(ENGINE, dump.key, 'standing', dump);
    await flush();
    expect(channelCards(h).find((p) => p.permId === dump.key)).toMatchObject({ canAllow: true });
    return dump;
  }

  /** Allow (or deny) from the phone and the hook takes the file (`.claimed`): the record is `claimed`. */
  async function allowAndClaim(h: Harness, dump: HookCallDump, decision: 'allow' | 'deny' = 'allow'): Promise<void> {
    expect(await h.manager.resolvePermission(h.id, dump.key, decision, 'iPad')).toMatchObject({ outcome: 'ok' });
    await flush();
    const base = join(dir, CONSENT_DIRNAME, ENGINE, dump.key);
    renameSync(`${base}.json`, `${base}.claimed`);
    await h.cycle.tick();
    await flush();
    expect(h.cycle.record(ENGINE, dump.key)?.state).toBe('claimed');
  }

  /** The turn's first lines are in the file and the review has read them (checkpoint, caught-up pace). */
  async function turnOpened(h: Harness, ids: readonly string[] = [CALL]): Promise<void> {
    appendFileSync(file, `${humanLine()}\n${toolUseLine(ids)}\n`);
    await h.tick();
    await h.tick();
  }

  /**
   * Forced end of the turn (session idle, as the manager's `turnEnded` port): facts to the current end of the file
   * go to `applyTurn` with `forcedEnd`.
   */
  async function forcedEnd(h: Harness, dump: HookCallDump): Promise<void> {
    const target = h.cycle.evidenceTargets().find((t) => t.keys.includes(dump.key));
    if (target === undefined) throw new Error('no evidence target');
    const pass = await createConsentEvidenceScanner().pass({ ...target, file });
    if (pass.status !== 'ok') throw new Error('no pass');
    await h.cycle.applyTurn(ENGINE, PROMPT, pass.facts, true);
    await flush();
  }

  function channelCards(h: Harness): PermissionRequest[] {
    return h.manager.transcript(h.id).pendingPermissions.filter((p) => p.channel === 'hook');
  }

  function eventsOf(h: Harness, permId: string): ServerEvent[] {
    return h.events.filter((e) => (e.type === 'permission-pending' ? e.request.permId === permId
      : (e.type === 'permission-settled' || e.type === 'permission-resolved') && e.permId === permId));
  }

  function releaseFileOf(dump: HookCallDump): unknown {
    const text = readFileSync(join(dir, CONSENT_DIRNAME, ENGINE, `${dump.key}.json`), 'utf8');
    return (JSON.parse(text) as { decision?: unknown }).decision;
  }

  it.each([
    { source: 'user_temporary', decision: 'accept' as const, desk: 'allow' },
    { source: 'user_permanent', decision: 'accept' as const, desk: 'allow-always' },
    { source: 'user_reject', decision: 'reject' as const, desk: 'deny' },
  ])('desk key ($source) in the file: one tick takes the card off the devices as `settled-at-desk` with the desk'
    + ' decision, the hook released', async ({ source, decision, desk }) => {
    const h = await start();
    const dump = await card(h, `desk-${source}`);
    await turnOpened(h);
    expect(h.cycle.record(ENGINE, dump.key)?.state).toBe('pending');

    appendFileSync(file, `${resultLine(CALL, decision, source)}\n`);
    await h.tick();
    expect(h.cycle.record(ENGINE, dump.key)).toMatchObject({
      state: 'settled-at-desk', correlation: 'bound', toolUseId: CALL, deskDecision: desk,
    });
    expect(channelCards(h)).toEqual([]);
    expect(h.events.filter((e) => e.type === 'permission-resolved' && e.permId === dump.key)).toEqual([{
      type: 'permission-resolved', sessionId: h.id, permId: dump.key, decision: desk, by: 'terminal',
    }]);
    expect(releaseFileOf(dump)).toBe('release');
  });

  it('the call is decided by the settings (`config`) while the card is `pending`: one tick takes the card off the devices'
    + ' as `expired` from the hook, the record stays `unknown` (`desk-unknown`) with `retired`, the hook released',
  async () => {
    const h = await start();
    const dump = await card(h, 'desk-config');
    await turnOpened(h);
    expect(h.cycle.record(ENGINE, dump.key)?.state).toBe('pending');

    appendFileSync(file, `${resultLine(CALL, 'reject', 'config')}\n`);
    await h.tick();
    expect(h.cycle.record(ENGINE, dump.key)).toMatchObject({
      state: 'unknown', cause: 'desk-unknown', decision: null, correlation: 'bound', toolUseId: CALL,
    });
    expect(channelCards(h)).toEqual([]);
    expect(h.events.filter((e) => e.type === 'permission-resolved' && e.permId === dump.key)).toEqual([{
      type: 'permission-resolved', sessionId: h.id, permId: dump.key, decision: 'expired', by: 'hook',
    }]);
    expect(releaseFileOf(dump)).toBe('release');
    expect(readConsentRecords(dir).find((r) => r.key === dump.key)).toMatchObject({
      state: 'unknown', retired: { at: expect.any(Number) as number },
    });
  });

  it('an `unknown` card no device answered, recovered from a record without `retired`: the snapshot does not carry'
    + ' it, no frame goes for it, and the record gets `retired`', async () => {
    const before = await start('boot-turns-1');
    const dump = await card(before, 'old-desk-unknown');
    await turnOpened(before);
    for (const close of closers.splice(0).reverse()) await close();
    // The card's record settled `unknown` (`desk-unknown`) without our answer and without `retired`.
    const path = join(dir, CONSENT_RECORDS_DIRNAME, ENGINE, `${dump.key}.json`);
    const old = JSON.parse(readFileSync(path, 'utf8')) as { times: Record<string, number>; retired?: unknown };
    expect(old).toMatchObject({ state: 'pending', decision: null });
    const { retired: _retired, ...rest } = old;
    writeFileSync(path, `${JSON.stringify({
      ...rest, state: 'unknown', cause: 'desk-unknown', correlation: 'bound', toolUseId: CALL, late: false,
      bindingConfirmed: true, times: { ...old.times, settled: Date.now() },
    })}\n`);

    const after = await start('boot-turns-2', true);
    expect(after.cycle.record(ENGINE, dump.key)).toMatchObject({ state: 'unknown', cause: 'desk-unknown' });
    expect(after.cycle.record(ENGINE, dump.key)).not.toHaveProperty('retired');
    expect(channelCards(after)).toEqual([]);
    await flush();
    expect(eventsOf(after, dump.key)).toEqual([]);
    expect(readConsentRecords(dir).find((r) => r.key === dump.key)).toMatchObject({
      state: 'unknown', cause: 'desk-unknown', retired: { at: expect.any(Number) as number },
    });
  });

  it('hook result of a claimed answer in the file: one tick takes the card off through `running`, the record stays'
    + ' `unknown` (`no-receipt`), also after the turn end', async () => {
    const h = await start();
    const dump = await card(h, 'hook-claimed');
    await allowAndClaim(h, dump);
    await turnOpened(h);

    appendFileSync(file, `${resultLine(CALL, 'accept', 'hook')}\n`);
    await h.tick();
    expect(h.cycle.record(ENGINE, dump.key)).toMatchObject({
      state: 'unknown', cause: 'no-receipt', correlation: 'bound', toolUseId: CALL,
      times: { running: expect.any(Number) as number },
    });
    expect(channelCards(h)).toEqual([]);
    expect(h.events.filter((e) => e.type === 'permission-resolved' && e.permId === dump.key)).toEqual([{
      type: 'permission-resolved', sessionId: h.id, permId: dump.key, decision: 'allow', by: 'hook',
    }]);

    appendFileSync(file, `${endLine()}\n`);
    await h.later();
    expect(h.cycle.record(ENGINE, dump.key)).toMatchObject({ state: 'unknown', cause: 'no-receipt' });
    expect(h.cycle.evidenceTargets()).toEqual([]);
  });

  it('a phone `deny` the hook took, with the hook\'s `reject` of the call in the file: one tick settles `applied`'
    + ' without a receipt (a `deny` needs none), the card leaves the devices with the deny', async () => {
    const h = await start();
    const dump = await card(h, 'hook-deny');
    await allowAndClaim(h, dump, 'deny');
    await turnOpened(h);

    appendFileSync(file, `${hookRejectLine(CALL)}\n`);
    await h.tick();
    expect(h.cycle.record(ENGINE, dump.key)).toMatchObject({
      state: 'applied', cause: null, decision: 'deny', correlation: 'bound', toolUseId: CALL, late: false,
    });
    expect(channelCards(h)).toEqual([]);
    expect(h.events.filter((e) => e.type === 'permission-resolved' && e.permId === dump.key)).toEqual([{
      type: 'permission-resolved', sessionId: h.id, permId: dump.key, decision: 'deny', by: 'hook',
    }]);

    appendFileSync(file, `${endLine()}\n`);
    await h.later();
    expect(h.cycle.record(ENGINE, dump.key)).toMatchObject({ state: 'applied', decision: 'deny' });
    expect(h.cycle.evidenceTargets()).toEqual([]);
  });

  it.each([
    { signed: true, outcome: { state: 'applied', cause: null, late: true } },
    // A record from before the signed digest proves no identity of the denied call: it stays (fail-closed).
    { signed: false, outcome: { state: 'unknown', cause: 'no-receipt', late: false } },
  ] as const)('an `unknown` (`no-receipt`) phone `deny` goes back to the review after a restart: its bound hook'
    + ' `reject` settles it by the digest its answer was signed over (record with it: $signed), the card stays off'
    + ' the devices', async ({ signed, outcome }) => {
    const before = await start('boot-turns-1');
    const dump = await card(before, 'old-deny');
    await allowAndClaim(before, dump, 'deny');
    await turnOpened(before);
    for (const close of closers.splice(0).reverse()) await close();
    // The record as a server that required a receipt for every decision left it.
    const path = join(dir, CONSENT_RECORDS_DIRNAME, ENGINE, `${dump.key}.json`);
    const old = JSON.parse(readFileSync(path, 'utf8')) as { times: Record<string, number>; signed?: unknown };
    const { signed: digest, ...rest } = old;
    expect(digest).toEqual({
      decisionAt: expect.any(Number), cardSha256: consentDumpCardSha256(dump), promptId: dump.promptId, agentId: null,
      pid: dump.pid, hookStartedAt: dump.startedAt, inputSha256: dump.inputSha256,
    });
    const at = Date.now();
    writeFileSync(path, `${JSON.stringify({
      ...rest, ...(signed ? { signed: digest } : {}), state: 'unknown', cause: 'no-receipt', correlation: 'bound',
      toolUseId: CALL, late: false, bindingConfirmed: true, retired: { at },
      times: { ...old.times, running: at, settled: at },
    })}\n`);

    const after = await start('boot-turns-2', true);
    expect(after.cycle.record(ENGINE, dump.key)).toMatchObject({ state: 'unknown', cause: 'no-receipt' });
    appendFileSync(file, `${hookRejectLine(CALL)}\n${endLine()}\n`);
    await after.tick();
    expect(after.cycle.record(ENGINE, dump.key)).toMatchObject({ ...outcome, decision: 'deny', toolUseId: CALL });
    expect(readConsentRecords(dir).find((r) => r.key === dump.key))
      .toMatchObject({ state: outcome.state, late: outcome.late });
    expect(channelCards(after)).toEqual([]);
  });

  it('two identical `Bash` calls, one decided by the hook and one with a desk key: both records `unknown`'
    + ' (`ambiguous-tool-use`), both cards off the devices (the unanswered one as `expired`)', async () => {
    const h = await start();
    const phone = await card(h, 'twin-phone');
    const desk = await card(h, 'twin-desk');
    await allowAndClaim(h, phone);
    await turnOpened(h, [CALL, CALL_TWIN]);

    appendFileSync(file, `${resultLine(CALL, 'accept', 'hook')}\n${resultLine(CALL_TWIN, 'accept', 'user_temporary')}\n`);
    await h.tick();
    for (const dump of [phone, desk]) {
      expect(h.cycle.record(ENGINE, dump.key)).toMatchObject({ state: 'unknown', cause: 'ambiguous-tool-use' });
    }
    expect(channelCards(h)).toEqual([]);
    expect(eventsOf(h, desk.key).at(-1)).toMatchObject({ type: 'permission-resolved', decision: 'expired', by: 'hook' });
    expect(eventsOf(h, phone.key).at(-1)).toMatchObject({ type: 'permission-resolved', decision: 'allow', by: 'hook' });
  });

  it('a revoked `allow` whose hook result is appended after a restart goes back to the review: `unknown`'
    + ' (`no-receipt`) with the revocation kept, the card does not come back to the devices', async () => {
    const before = await start('boot-turns-1');
    const dump = await card(before, 'revoked-allow');
    expect(await before.manager.resolvePermission(before.id, dump.key, 'allow', 'iPad')).toMatchObject({ outcome: 'ok' });
    await flush();
    await turnOpened(before);
    expect(await before.cycle.revokeSession(ENGINE, 'dialog-gone')).toEqual([dump.key]);
    expect(before.cycle.record(ENGINE, dump.key)).toMatchObject({ state: 'revoked', decision: 'allow' });
    const revokedAt = before.cycle.record(ENGINE, dump.key)?.times.settled;
    for (const close of closers.splice(0).reverse()) await close();

    const after = await start('boot-turns-2', true);
    expect(after.cycle.record(ENGINE, dump.key)).toMatchObject({ state: 'revoked', bootId: 'boot-turns-1' });
    appendFileSync(file, `${resultLine(CALL, 'accept', 'hook')}\n${endLine()}\n`);
    await after.tick();
    expect(after.cycle.record(ENGINE, dump.key)).toMatchObject({
      state: 'unknown', cause: 'no-receipt', toolUseId: CALL, revocation: { cause: 'dialog-gone', at: revokedAt },
    });
    expect(readConsentRecords(dir).find((r) => r.key === dump.key)).toMatchObject({
      state: 'unknown', revocation: { cause: 'dialog-gone' }, retired: { at: revokedAt },
    });
    expect(eventsOf(after, dump.key)).toEqual([]);
    expect(channelCards(after)).toEqual([]);
  });

  it('desk key in the file for a `sent` answer the hook has not taken: the file revoked and the hook released, the'
    + ' devices get one `permission-resolved` with the desk decision and no expiry before it', async () => {
    const h = await start();
    const dump = await card(h, 'sent-desk');
    expect(await h.manager.resolvePermission(h.id, dump.key, 'allow', 'iPad')).toMatchObject({ outcome: 'ok' });
    await flush();
    expect(h.cycle.record(ENGINE, dump.key)?.state).toBe('sent');
    await turnOpened(h);

    appendFileSync(file, `${resultLine(CALL, 'reject', 'user_reject')}\n`);
    await h.tick();
    expect(h.cycle.record(ENGINE, dump.key)).toMatchObject({
      state: 'settled-at-desk', correlation: 'bound', toolUseId: CALL, deskDecision: 'deny',
    });
    expect(h.events.filter((e) => e.type === 'permission-resolved' && e.permId === dump.key)).toEqual([{
      type: 'permission-resolved', sessionId: h.id, permId: dump.key, decision: 'deny', by: 'terminal',
    }]);
    expect(channelCards(h)).toEqual([]);
    expect(readFileSync(join(dir, CONSENT_DIRNAME, ENGINE, `${dump.key}.revoked`), 'utf8')).toContain('"allow"');
    expect(releaseFileOf(dump)).toBe('release');
  });

  it('binding written at a forced turn end without a result is not kept: two overlapping identical calls in the'
    + ' later lines make the taken answer `unknown` (`ambiguous-tool-use`), not `settled-at-desk`', async () => {
    const h = await start();
    const dump = await card(h, 'forced-provisional');
    expect(await h.manager.resolvePermission(h.id, dump.key, 'allow', 'iPad')).toMatchObject({ outcome: 'ok' });
    await flush();
    await turnOpened(h);

    await forcedEnd(h, dump);
    expect(h.cycle.record(ENGINE, dump.key)).toMatchObject({ state: 'sent', correlation: 'bound', toolUseId: CALL });

    const base = join(dir, CONSENT_DIRNAME, ENGINE, dump.key);
    renameSync(`${base}.json`, `${base}.claimed`);
    await h.cycle.tick();
    await flush();
    expect(h.cycle.record(ENGINE, dump.key)?.state).toBe('claimed');

    appendFileSync(file, `${toolUseLine([CALL_TWIN], 'a5')}\n${resultLine(CALL, 'accept', 'user_temporary')}\n`
      + `${resultLine(CALL_TWIN, 'accept', 'hook')}\n`);
    await h.tick();
    const record = h.cycle.record(ENGINE, dump.key);
    expect(record).toMatchObject({ state: 'unknown', cause: 'ambiguous-tool-use', correlation: 'ambiguous-tool-use' });
    expect(record).not.toHaveProperty('deskDecision');
    expect(h.events.filter((e) => e.type === 'permission-resolved' && e.permId === dump.key)).toEqual([{
      type: 'permission-resolved', sessionId: h.id, permId: dump.key, decision: 'allow', by: 'hook',
    }]);
  });

  it.each([
    { state: 'pending' as const, source: 'user_temporary', decision: 'accept' as const, desk: 'allow' },
    { state: 'sent' as const, source: 'user_reject', decision: 'reject' as const, desk: 'deny' },
  ])('a `$state` card bound at a forced end without a result stays in the review: the result in the file settles it'
    + ' `settled-at-desk` ($desk), as an `open` one', async ({ state, source, decision, desk }) => {
    const h = await start();
    const dump = await card(h, `forced-${state}`);
    if (state === 'sent') {
      expect(await h.manager.resolvePermission(h.id, dump.key, 'allow', 'iPad')).toMatchObject({ outcome: 'ok' });
      await flush();
    }
    await turnOpened(h);
    await forcedEnd(h, dump);
    expect(h.cycle.record(ENGINE, dump.key)).toMatchObject({ state, correlation: 'bound', toolUseId: CALL });
    expect(h.cycle.evidenceTargets().flatMap((t) => t.keys)).toContain(dump.key);

    appendFileSync(file, `${resultLine(CALL, decision, source)}\n`);
    await h.tick();
    expect(h.cycle.record(ENGINE, dump.key)).toMatchObject({ state: 'settled-at-desk', deskDecision: desk });
    expect(h.events.filter((e) => e.type === 'permission-resolved' && e.permId === dump.key)).toEqual([{
      type: 'permission-resolved', sessionId: h.id, permId: dump.key, decision: desk, by: 'terminal',
    }]);
    expect(channelCards(h)).toEqual([]);
  });

  it('a `pending` card left `ambiguous-tool-use` by a forced end stays in the review: when both identical calls have'
    + ' a result it is `unknown` (`ambiguous-tool-use`) without the approve button', async () => {
    const h = await start();
    const dump = await card(h, 'forced-ambiguous');
    await turnOpened(h, [CALL, CALL_TWIN]);
    await forcedEnd(h, dump);
    expect(h.cycle.record(ENGINE, dump.key)).toMatchObject({ state: 'pending', correlation: 'ambiguous-tool-use' });

    appendFileSync(file, `${resultLine(CALL, 'accept', 'user_temporary')}\n${resultLine(CALL_TWIN, 'accept', 'hook')}\n`);
    await h.tick();
    expect(h.cycle.record(ENGINE, dump.key)).toMatchObject({ state: 'unknown', cause: 'ambiguous-tool-use' });
    expect(channelCards(h).filter((p) => p.canAllow)).toEqual([]);
  });

  it('`applied` only with the hook receipt: a receipt of this `decisionAt` over the record\'s own input digest,'
    + ' and the rule with it settles `applied`', () => {
    const hook = { kind: 'hook', decision: 'allow' } as const;
    const digest = 'a'.repeat(64);
    const record = { decision: 'allow', decisionAt: 1, inputSha256: digest } as const;
    expect(consentReceiptOf(record)).toBe(false);
    expect(consentReceiptOf({ ...record, receipt: { decisionAt: 1, inputSha256: digest } })).toBe(true);
    expect(consentReceiptOf({ ...record, receipt: { decisionAt: 2, inputSha256: digest } })).toBe(false);
    expect(consentReceiptOf({ ...record, receipt: { decisionAt: 1, inputSha256: 'b'.repeat(64) } })).toBe(false);
    expect(consentReceiptOf({ ...record, decision: 'deny', receipt: { decisionAt: 1, inputSha256: digest } })).toBe(false);
    for (const state of ['claimed', 'running', 'revoked'] as const) {
      expect(consentSettlement(state, 'allow', hook, false)).toEqual({ state: 'unknown', cause: 'no-receipt', late: false });
      expect(consentSettlement(state, 'allow', hook, true)).toEqual({ state: 'applied', cause: null, late: false });
      expect(consentSettlement(state, 'deny', hook, true)).toMatchObject({ state: 'unknown', cause: 'foreign-decision' });
    }
    expect(consentSettlement('unknown', 'allow', hook, false)).toBeNull();
    expect(consentSettlement('unknown', 'allow', hook, true)).toEqual({ state: 'applied', cause: null, late: true });
    expect(consentSettlement('pending', null, hook, true)).toMatchObject({ state: 'unknown', cause: 'foreign-decision' });
  });

  it('one identity rule for both decisions: the answer signed over the record\'s own input and card digest (tool'
    + ' name) for this `decisionAt`, and for an `allow` the receipt; then the hook\'s `reject` of the bound call settles'
    + ' a phone `deny` `applied`, late from `unknown`; without it `no-receipt`; a hook `accept` on a `deny` stays'
    + ' `foreign-decision`', () => {
    const digest = 'a'.repeat(64);
    const card = 'c'.repeat(64);
    const other = 'b'.repeat(64);
    // The record's call identity equals its registration's; each field on its own:
    // `layer1-binding-registration.test.ts`.
    const call = { promptId: PROMPT, agentId: null, pid: 1, hookStartedAt: 1, inputSha256: digest } as const;
    const signed = { decisionAt: 1, cardSha256: card, ...call };
    const record = { decision: 'deny', decisionAt: 1, dumpCardSha256: card, ...call } as const;
    expect(consentAnswerProven({ ...record, signed })).toBe(true);
    expect(consentAnswerProven(record)).toBe(false);
    expect(consentAnswerProven({ ...record, signed: { ...signed, decisionAt: 2 } })).toBe(false);
    expect(consentAnswerProven({ ...record, signed: { ...signed, inputSha256: other } })).toBe(false);
    // Another tool name with the same input: the first dump's card digest is not the registration's.
    expect(consentAnswerProven({ ...record, signed: { ...signed, cardSha256: other } })).toBe(false);
    // A truncated first dump or a record from before the field has no card digest of its own.
    expect(consentAnswerProven({ ...record, dumpCardSha256: undefined, signed })).toBe(false);
    // An `allow` needs the same identity and the receipt; a `release` is never proven.
    const receipt = { decisionAt: 1, inputSha256: digest };
    expect(consentAnswerProven({ ...record, decision: 'allow', signed, receipt })).toBe(true);
    expect(consentAnswerProven({ ...record, decision: 'allow', signed })).toBe(false);
    expect(consentAnswerProven({ ...record, decision: 'allow', receipt })).toBe(false);
    expect(consentAnswerProven({ ...record, decision: 'allow', signed: { ...signed, cardSha256: other }, receipt }))
      .toBe(false);
    expect(consentAnswerProven({ ...record, decision: 'release', signed, receipt })).toBe(false);
    const reject = { kind: 'hook', decision: 'deny' } as const;
    const accept = { kind: 'hook', decision: 'allow' } as const;
    for (const state of ['claimed', 'running', 'revoked'] as const) {
      expect(consentSettlement(state, 'deny', reject, true)).toEqual({ state: 'applied', cause: null, late: false });
      expect(consentSettlement(state, 'deny', reject, false)).toEqual({ state: 'unknown', cause: 'no-receipt', late: false });
      expect(consentSettlement(state, 'deny', accept, true)).toMatchObject({ state: 'unknown', cause: 'foreign-decision' });
      expect(consentSettlement(state, 'allow', reject, true)).toMatchObject({ state: 'unknown', cause: 'foreign-decision' });
    }
    expect(consentSettlement('unknown', 'deny', reject, true)).toEqual({ state: 'applied', cause: null, late: true });
    expect(consentSettlement('unknown', 'deny', reject, false)).toBeNull();
    expect(consentSettlement('unknown', 'deny', accept, true)).toBeNull();
    expect(consentSettlement('pending', null, reject, true)).toMatchObject({ state: 'unknown', cause: 'foreign-decision' });
  });
});
