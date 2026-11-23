/**
 * Read window of the consent channel observation (W-c): one observation reads at most 64 per-call dumps of a
 * session (`scanCallDumps` in `shadow/files.ts`). A card whose dump is still on disk but outside this window keeps its
 * registration, so `deny` and `release` from the device reach the live hook. Only a card whose dump is gone gets
 * `dead`, which forgets the secret.
 *
 * The window follows the `readdir` order, so the test reads that order first and puts the live hooks' keys at its end
 * (an existing file rewritten under the same name keeps its place).
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import { HOOK_PENDING_DIRNAME } from '../src/herdr/dialogs/hook/contract.ts';
import type { HookCallDump } from '../src/herdr/dialogs/hook/contract.ts';
import { CONSENT_DIRNAME, CONSENT_PROOF_TTL_MS, CONSENT_SECRET_BYTES } from '../src/herdr/dialogs/layer1/contract.ts';
import { createConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import type { ConsentCycle, ConsentObserved } from '../src/herdr/dialogs/layer1/cycle.ts';
import { observeConsentSession } from '../src/herdr/dialogs/layer1/observe.ts';
import type { ConsentSessionObservation } from '../src/herdr/dialogs/layer1/observe.ts';
import { createConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import type { ConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import { CONSENT_NOT_BEFORE_MARGIN_MS, consentCardSha256, verifyConsentFile } from '../src/herdr/dialogs/layer1/sign.ts';
import type { RegistryEvidence } from '../src/herdr/dialogs/shadow/evidence.ts';

const SESSION = '00000000-0000-4000-9000-000000000c3a';
const PROMPT = '00000000-0000-4000-9000-0000000000c3';
const CWD = '/tmp/projekt';
/** The scan cap per observation (`CALL_DUMPS_MAX` in `shadow/files.ts`). */
const WINDOW = 64;

let clock = Date.parse('2026-11-11T09:00:00.000Z');
const now = (): number => clock;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const waiting = (at = clock): RegistryEvidence => ({ kind: 'waiting', dialog: 'permission', at });
const active = (at = clock): RegistryEvidence => ({ kind: 'active', at });

let nextPid = 81_000;

/** A synthetic main-thread `Bash` dump; `key` overrides the drawn key. */
function bash(seed: string, key?: string): HookCallDump {
  const nonce = createHash('sha256').update(`${seed}-${String(nextPid)}`).digest('hex').slice(0, 32);
  nextPid += 1;
  const toolInput = { command: `echo ${seed} > /dev/null`, description: 'Read window' };
  return {
    key: key ?? `${PROMPT}-${nonce}`, sessionId: SESSION, promptId: PROMPT, pid: nextPid, startedAt: clock - 1_000,
    toolName: 'Bash', toolInput, cwd: CWD, at: clock - 900, inputSha256: canonicalSha256(toolInput),
    permissionMode: 'default',
  };
}

interface Registered {
  readonly secret: string;
  readonly cardSha256: string;
  readonly at: number;
}

interface Harness {
  readonly dir: string;
  readonly reg: ConsentRegistry;
  readonly cycle: ConsentCycle;
  readonly life: Map<number, boolean | null>;
  readonly registered: Map<string, Registered>;
  observation: ConsentSessionObservation | null;
  step(registry: RegistryEvidence): Promise<void>;
}

/** The cycle as in the server; the process started 10 s ago and the start block ended 5 s after start. */
async function harness(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'rarog-okno-'));
  dirs.push(dir);
  const reg = createConsentRegistry({ bootId: 'boot-c3a', send: () => true, sessions: () => [SESSION], log: () => {}, now });
  reg.setScope('main');
  const started = clock;
  clock = started - 10_000;
  const cycle = createConsentCycle({ dataDir: dir, bootId: 'boot-c3a', registry: reg, now });
  clock = started;
  const life = new Map<number, boolean | null>();
  const h: Harness = {
    dir, reg, cycle, life, registered: new Map(), observation: null,
    step: async (registry) => {
      await observeConsentSession(cycle, {
        dataDir: dir, sessionId: SESSION, registry, transcript: null, screen: null, now,
        liveness: async (processes) => new Map(processes.map((p) => [p.pid, life.get(p.pid) ?? null])),
      }, (observation) => { h.observation = observation; });
    },
  };
  await observeConsentSession(cycle, {
    dataDir: dir, sessionId: SESSION, registry: active(started - 5_000), transcript: null, screen: null,
    now: () => started - 5_000, liveness: async () => new Map(),
  });
  return h;
}

const pendingDir = (h: Harness): string => join(h.dir, HOOK_PENDING_DIRNAME, SESSION);
const dumpPath = (h: Harness, dump: HookCallDump): string => join(pendingDir(h), `${dump.key}.json`);
const answerPath = (h: Harness, dump: HookCallDump): string => join(h.dir, CONSENT_DIRNAME, SESSION, `${dump.key}.json`);

/** A dump on disk with a live hook process, without a registration. */
function writeDump(h: Harness, dump: HookCallDump): void {
  mkdirSync(dirname(dumpPath(h, dump)), { recursive: true, mode: 0o700 });
  writeFileSync(dumpPath(h, dump), JSON.stringify(dump), { mode: 0o600 });
  h.life.set(dump.pid, true);
}

/** The hook starts: its dump on disk, its process alive and its secret registered. */
function hookStarts(h: Harness, dump: HookCallDump): void {
  writeDump(h, dump);
  const cardSha256 = consentCardSha256({
    sessionId: dump.sessionId, toolName: dump.toolName, toolInput: dump.toolInput, cwd: dump.cwd,
    agentId: null, permissionMode: dump.permissionMode ?? null,
  });
  const secret = randomBytes(CONSENT_SECRET_BYTES).toString('hex');
  expect(h.reg.register({
    key: dump.key, sessionId: dump.sessionId, promptId: dump.promptId, secret, inputSha256: dump.inputSha256, cardSha256,
    pid: dump.pid, startedAt: dump.startedAt,
  }).status).toBe(200);
  h.registered.set(dump.key, { secret, cardSha256, at: clock });
}

/** The answer file under the key as the live hook verifies it with its own secret. */
function answerOf(h: Harness, dump: HookCallDump): unknown {
  const registered = h.registered.get(dump.key);
  if (registered === undefined) throw new Error(`no registration for ${dump.key}`);
  return verifyConsentFile(JSON.parse(readFileSync(answerPath(h, dump), 'utf8')) as unknown, {
    secret: registered.secret, sessionId: SESSION, key: dump.key, inputSha256: dump.inputSha256,
    cardSha256: registered.cardSha256, notBefore: registered.at - CONSENT_NOT_BEFORE_MARGIN_MS,
  });
}

/**
 * 70 dumps in the session: `fillers` without a registration, then the `live` hooks rewritten over the last names of
 * the `readdir` order, so the scan never reads them. Each live hook already has a card from an observation of its own
 * dump.
 */
async function outsideWindow(h: Harness, live: number): Promise<HookCallDump[]> {
  for (let n = 0; n < 70; n += 1) writeDump(h, bash(`filler-${String(n)}`));
  const names = readdirSync(pendingDir(h)).filter((name) => name.endsWith('.json'));
  expect(names).toHaveLength(70);
  const tail = names.slice(70 - live).map((name) => name.slice(0, -'.json'.length));
  const hooks = tail.map((key, n) => bash(`live-${String(n)}`, key));
  for (const dump of hooks) {
    hookStarts(h, dump);
    expect(await h.cycle.observe(SESSION, dump.key, 'unknown', dump)).toMatchObject({ state: 'pending', canDeny: true });
  }
  expect(readdirSync(pendingDir(h)).filter((name) => name.endsWith('.json')).slice(70 - live)).toEqual(
    hooks.map((dump) => `${dump.key}.json`),
  );
  return hooks;
}

describe('observation read window: a live hook outside the 64 read dumps keeps its secret (W-c)', () => {
  it('70 dumps: `deny` and `release` for live hooks outside the window are signed with their secrets', async () => {
    const h = await harness();
    const [denied, released] = await outsideWindow(h, 2);
    if (denied === undefined || released === undefined) throw new Error('two live hooks expected');
    clock += 1_500;
    await h.step(waiting());
    expect(h.observation?.complete).toBe(false);
    expect(h.observation?.dumps).toHaveLength(WINDOW);
    const read = new Set(h.observation?.dumps.map((dump) => dump.key));
    expect(read.has(denied.key) || read.has(released.key)).toBe(false);

    expect(h.reg.secretOf(SESSION, denied.key)).toBe(h.registered.get(denied.key)?.secret);
    expect(h.cycle.record(SESSION, denied.key)).toMatchObject({ state: 'pending' });
    expect(await h.cycle.decide(SESSION, denied.key, 'deny')).toEqual({ ok: true, state: 'sent' });
    expect(answerOf(h, denied)).toMatchObject({ ok: true, file: { decision: 'deny', reasonId: 'phone-deny' } });

    expect(await h.cycle.release(SESSION, released.key)).toEqual({ ok: true, state: 'sent' });
    expect(answerOf(h, released)).toMatchObject({ ok: true, file: { decision: 'release', reasonId: 'release' } });
  });

  it('a dump that is present but unreadable: the earlier `allow` is withdrawn, `deny` still reaches the hook', async () => {
    const h = await harness();
    const dump = bash('unreadable');
    hookStarts(h, dump);
    await h.step(waiting());
    expect(h.observation?.complete).toBe(true);
    const top: ConsentObserved = {
      at: clock, until: clock + CONSENT_PROOF_TTL_MS, screen: { text: 'Bash frame', readStartedAt: clock },
      matchTop: () => 'match', hidden: null,
    };
    expect(await h.cycle.observe(SESSION, dump.key, 'standing', dump, undefined, top)).toMatchObject({ canAllow: true });
    clock += 100;
    writeFileSync(dumpPath(h, dump), '{not json', { mode: 0o600 });
    await h.step(waiting());
    expect(h.observation?.complete).toBe(false);
    expect(h.observation?.dumps).toHaveLength(0);
    expect(h.cycle.card(SESSION, dump.key)).toMatchObject({ state: 'pending', canAllow: false, canDeny: true });
    expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toMatchObject({ ok: false });
    expect(h.reg.secretOf(SESSION, dump.key)).toBe(h.registered.get(dump.key)?.secret);
    expect(await h.cycle.decide(SESSION, dump.key, 'deny')).toEqual({ ok: true, state: 'sent' });
    expect(answerOf(h, dump)).toMatchObject({ ok: true, file: { decision: 'deny', reasonId: 'phone-deny' } });
  });

  it('70 dumps: a card whose dump is gone still gets `dead` and its registration is forgotten', async () => {
    const h = await harness();
    const [kept, gone] = await outsideWindow(h, 2);
    if (kept === undefined || gone === undefined) throw new Error('two live hooks expected');
    rmSync(dumpPath(h, gone));
    h.life.set(gone.pid, false);
    clock += 1_500;
    await h.step(waiting());
    expect(h.observation?.complete).toBe(false);
    expect(h.cycle.record(SESSION, gone.key)).toMatchObject({ state: 'revoked', cause: 'hook-dead' });
    expect(h.reg.entry(SESSION, gone.key)).toBeNull();
    expect(h.cycle.record(SESSION, kept.key)).toMatchObject({ state: 'pending' });
    expect(h.reg.secretOf(SESSION, kept.key)).not.toBeNull();
  });

  it('a complete read: a card without its dump gets `dead` as before', async () => {
    const h = await harness();
    const dump = bash('alone');
    hookStarts(h, dump);
    await h.step(waiting());
    expect(h.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'pending' });
    rmSync(dumpPath(h, dump));
    clock += 1_500;
    await h.step(waiting());
    expect(h.observation?.complete).toBe(true);
    expect(h.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'revoked', cause: 'hook-dead' });
    expect(h.reg.entry(SESSION, dump.key)).toBeNull();
  });
});
