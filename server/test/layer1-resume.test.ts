/**
 * Resumption of the channel records a server restart interrupted (restart grace G; `layer1/resume.ts` with its
 * wiring in `layer1/cycle.ts` and `layer1/registry.ts`). Each row of the server-side resume table:
 *
 * - `pending` with a live hook (pid and start from `ps`) waits G, its card without the allow button (`server-restart`);
 * - a second registration equal in the call fields and the card digest = `resumed`, the record stays `pending`;
 * - a registration that differs in any field = `revoked`, the key blocked;
 * - no registration within G, or a hook dead at recovery = `revoked` (`restart`), as without the grace;
 * - `sent` with its file and a live hook = resumed: the hook takes the file and the new server confirms `/claim`;
 *   a hook that takes the file before its second registration still has to match it (the record waits on as
 *   `claimed`), and the claim deadline counted from the second registration survives another restart (kept in the
 *   record);
 * - `deciding` = `revoked`, as without the grace;
 *
 * and the allow button of a resumed `pending` record: none for good. Its transcript history from the hook start cannot
 * be shown continuous (no process read the file during the restart), so neither a known transcript nor a fresh proof
 * gives it back, whatever the file says after a "Yes" at the desk or a truncation; deny and release stay.
 *
 * Two server processes on one data directory: the earlier one writes the records, the later one recovers them with
 * a fresh registry, as `dispose → start` does. The proof is the channel proof (`channelReadAt`) of a main-thread
 * `Bash` request; `ps` is a stub.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import type { HookCallDump } from '../src/herdr/dialogs/hook/contract.ts';
import { CONSENT_CLAIM_TIMEOUT_MS, CONSENT_DIRNAME, CONSENT_SECRET_BYTES } from '../src/herdr/dialogs/layer1/contract.ts';
import type { ConsentRegistration } from '../src/herdr/dialogs/layer1/contract.ts';
import { createConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import type { ConsentCycle, ConsentCycleIo } from '../src/herdr/dialogs/layer1/cycle.ts';
import { createConsentClaims } from '../src/herdr/dialogs/layer1/receipt.ts';
import type { ConsentClaimOutcome } from '../src/herdr/dialogs/layer1/receipt.ts';
import { readConsentRecords, writeConsentRecord } from '../src/herdr/dialogs/layer1/records.ts';
import type { ConsentRecord } from '../src/herdr/dialogs/layer1/records.ts';
import { createConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import type { ConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import { consentCardSha256, consentReceiptMac, verifyConsentFile } from '../src/herdr/dialogs/layer1/sign.ts';
import type { ProcessLiveness } from '../src/herdr/dialogs/shadow/liveness.ts';
import { channelReadAt } from './helpers/dowod-z-odczytem.ts';

const SESSION = '00000000-0000-4000-9000-00000000a001';
const PROMPT = '00000000-0000-4000-9000-00000000a0aa';
const BOOT = 'boot-before';
const NEXT_BOOT = 'boot-after';
const GRACE_MS = 45_000;

let clock = Date.parse('2026-11-15T10:00:00.000Z');
const now = (): number => clock;
beforeEach(() => { clock = Date.parse('2026-11-15T10:00:00.000Z'); });

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rarog-wznow-'));
  dirs.push(dir);
  return dir;
}

/** A main-thread `Bash` request whose hook started a second ago; the key's nonce from `seed`. */
function dumpOf(seed: string): HookCallDump {
  const toolInput = { command: `echo ${seed}` };
  return {
    key: `${PROMPT}-${createHash('sha256').update(seed).digest('hex').slice(0, 32)}`, sessionId: SESSION,
    promptId: PROMPT, pid: process.pid, startedAt: clock - 1_000, toolName: 'Bash', toolInput, cwd: '/tmp/projekt',
    at: clock - 900, inputSha256: canonicalSha256(toolInput), permissionMode: 'default',
  };
}

function cardShaOf(dump: HookCallDump): string {
  return consentCardSha256({
    sessionId: dump.sessionId, toolName: dump.toolName, toolInput: dump.toolInput, cwd: dump.cwd,
    agentId: dump.agentId ?? null, permissionMode: dump.permissionMode ?? null,
  });
}

/** The registration body the hook sends for `dump`, the second time with the same `secret`. */
function bodyOf(dump: HookCallDump, secret: string, over: Partial<ConsentRegistration> = {}): ConsentRegistration {
  return {
    key: dump.key, sessionId: dump.sessionId, promptId: dump.promptId, secret, inputSha256: dump.inputSha256,
    cardSha256: cardShaOf(dump), pid: dump.pid, startedAt: dump.startedAt,
    ...(dump.agentId === undefined ? {} : { agentId: dump.agentId }), ...over,
  };
}

const newSecret = (): string => randomBytes(CONSENT_SECRET_BYTES).toString('hex');

interface Server {
  readonly reg: ConsentRegistry;
  readonly cycle: ConsentCycle;
  readonly logs: string[];
}

/**
 * One server process on `dir`: registry and cycle with the grace `graceMs` (none by default), `ps` saying `alive`
 * for every hook (no `ps` without the field) and the cycle's file writes from `io` where given.
 */
function server(
  dir: string, bootId: string, options: { graceMs?: number; alive?: boolean | null; io?: Partial<ConsentCycleIo> } = {},
): Server {
  const logs: string[] = [];
  const log = (line: string): void => { logs.push(line); };
  const grace = options.graceMs === undefined ? {} : { restartGraceMs: options.graceMs };
  const alive = options.alive;
  const liveness: ProcessLiveness | undefined = alive === undefined ? undefined
    : (processes) => Promise.resolve(new Map(processes.map((proc) => [proc.pid, alive])));
  const reg = createConsentRegistry({ bootId, send: () => true, sessions: () => [SESSION], log, now, ...grace });
  reg.setScope('all');
  const cycle = createConsentCycle({
    dataDir: dir, bootId, registry: reg, now, log, mode: () => 'all', ...grace,
    ...(liveness === undefined ? {} : { liveness }), ...(options.io === undefined ? {} : { io: options.io }),
  });
  return { reg, cycle, logs };
}

/** Channel proof of the key from a registry read at `at`. */
async function observeStanding(cycle: ConsentCycle, dump: HookCallDump, at = clock): Promise<void> {
  await cycle.observe(SESSION, dump.key, 'channel', dump, undefined, channelReadAt(at));
}

/** The earlier process: the request registered and observed, its card with the allow button. */
async function pendingBefore(dir: string, dump: HookCallDump, secret: string): Promise<Server> {
  const before = server(dir, BOOT);
  expect(before.reg.register(bodyOf(dump, secret)).status).toBe(200);
  await observeStanding(before.cycle, dump);
  expect(before.cycle.card(SESSION, dump.key)?.canAllow).toBe(true);
  return before;
}

/** The earlier process: `allow` from the phone written and signed, the record `sent`. */
async function sentBefore(dir: string, dump: HookCallDump, secret: string): Promise<Server> {
  const before = await pendingBefore(dir, dump, secret);
  expect(await before.cycle.decide(SESSION, dump.key, 'allow')).toEqual({ ok: true, state: 'sent' });
  return before;
}

const answerPath = (dir: string, key: string, suffix: string): string => join(dir, CONSENT_DIRNAME, SESSION, `${key}${suffix}`);

const RESUMED = { status: 200, body: { accepted: true, bootId: NEXT_BOOT, resumed: true } };

/** `POST /claim` of the hook that holds `secret`, for the answer file of `dump` it took (`.claimed`). */
async function claimTaken(
  { reg, cycle }: Server, dir: string, dump: HookCallDump, secret: string,
): Promise<ConsentClaimOutcome> {
  const file = JSON.parse(readFileSync(answerPath(dir, dump.key, '.claimed'), 'utf8')) as { at: number };
  const claims = createConsentClaims({
    registry: reg, confirm: (sessionId, key, at, input) => cycle.confirmReceipt(sessionId, key, at, input),
  });
  const mac = consentReceiptMac(secret, { sessionId: SESSION, key: dump.key, at: file.at });
  return claims.claim({ key: dump.key, at: file.at, mac });
}

/** A file write that fails as on a full disk. */
const diskFull = (): never => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); };

describe('`pending` with a live hook after a restart', () => {
  it('waits for the second registration without the allow button and resumes it without the button; a deny from the'
    + ' phone is signed with the same secret', async () => {
    const dir = dataDir();
    const dump = dumpOf('a');
    const secret = newSecret();
    await pendingBefore(dir, dump, secret);

    clock += 10_000;
    const after = server(dir, NEXT_BOOT, { graceMs: GRACE_MS, alive: true });
    expect(await after.cycle.recover()).toEqual({ records: 1, changed: 0 });
    expect(after.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'pending', cause: null });
    expect(after.cycle.card(SESSION, dump.key)).toMatchObject({
      state: 'pending', canAllow: false, unavailable: 'server-restart',
    });
    // An observation before the second registration: the dialog stands, the card still waits.
    clock += 1;
    await observeStanding(after.cycle, dump);
    expect(after.cycle.card(SESSION, dump.key)).toMatchObject({ canAllow: false, unavailable: 'server-restart' });

    clock += 5_000;
    expect(after.reg.register(bodyOf(dump, secret))).toEqual(RESUMED);
    expect(after.cycle.record(SESSION, dump.key)?.state).toBe('pending');
    clock += 1;
    await observeStanding(after.cycle, dump);
    await after.cycle.tick();
    expect(after.cycle.card(SESSION, dump.key)).toMatchObject({
      canAllow: false, canDeny: true, canRelease: true, unavailable: 'server-restart',
    });

    expect(await after.cycle.decide(SESSION, dump.key, 'deny')).toEqual({ ok: true, state: 'sent' });
    const file = JSON.parse(readFileSync(answerPath(dir, dump.key, '.json'), 'utf8')) as unknown;
    expect(verifyConsentFile(file, {
      secret, sessionId: SESSION, key: dump.key, inputSha256: dump.inputSha256, cardSha256: cardShaOf(dump),
      notBefore: dump.startedAt - 60_000,
    })).toMatchObject({ ok: true, file: { decision: 'deny' } });
    expect(after.cycle.record(SESSION, dump.key)).toMatchObject({ bootId: NEXT_BOOT, decision: 'deny' });
  });

  /** What happens to a resumed card: in the earlier process before the restart, in the later one after the resume. */
  interface HeldScene {
    readonly before?: (cycle: ConsentCycle, dump: HookCallDump) => void;
    readonly after: (cycle: ConsentCycle, dump: HookCallDump) => Promise<void> | void;
    readonly io?: Partial<ConsentCycleIo>;
  }

  /** A known transcript in which the call of the key is still open, read after the second registration. */
  const openInTranscript = (cycle: ConsentCycle): void => {
    cycle.notePassed(SESSION, []);
    cycle.noteTranscript(SESSION, clock);
  };

  it.each<[string, HeldScene]>([
    // A "Yes" at the desk during the restart followed by a truncation of the transcript reads the same.
    ['a known transcript shows the call open', { after: openInTranscript }],
    ['"Yes" at the desk before the restart, then the transcript cut back to the open call', {
      before: (cycle, dump) => { cycle.notePassed(SESSION, [dump.key]); },
      after: openInTranscript,
    }],
    ['the transcript went past the key', {
      after: (cycle, dump) => { cycle.notePassed(SESSION, [dump.key]); cycle.noteTranscript(SESSION, clock); },
    }],
    ['the transcript is unknown', { after: () => undefined }],
    ['a deny from the phone failed to write and the record went back to `pending`', {
      io: { writeFile: diskFull },
      after: async (cycle, dump) => {
        openInTranscript(cycle);
        clock += 1;
        await observeStanding(cycle, dump);
        expect(await cycle.decide(SESSION, dump.key, 'deny')).toMatchObject({ ok: false, error: 'write-failed' });
      },
    }],
  ])('a resumed `pending` card never gets the allow button back: %s', async (_name, scene) => {
    const dir = dataDir();
    const dump = dumpOf('held');
    const secret = newSecret();
    const before = await pendingBefore(dir, dump, secret);
    scene.before?.(before.cycle, dump);
    clock += 10_000;
    const after = server(dir, NEXT_BOOT, {
      graceMs: GRACE_MS, alive: true, ...(scene.io === undefined ? {} : { io: scene.io }),
    });
    await after.cycle.recover();
    expect(after.reg.register(bodyOf(dump, secret))).toEqual(RESUMED);
    clock += 1;
    await scene.after(after.cycle, dump);
    for (let step = 0; step < 3; step += 1) {
      clock += 1;
      await observeStanding(after.cycle, dump);
      await after.cycle.tick();
      expect(after.cycle.card(SESSION, dump.key)).toMatchObject({ canAllow: false, unavailable: 'server-restart' });
    }
    expect(await after.cycle.decide(SESSION, dump.key, 'allow')).toMatchObject({ ok: false, error: 'card-changed' });
    expect(after.cycle.record(SESSION, dump.key)?.state).toBe('pending');
  });

  it.each([
    ['pid', { pid: process.pid + 1 }],
    ['startedAt', { startedAt: 1 }],
    ['agentId', { agentId: 'agent-x' }],
    ['inputSha256', { inputSha256: 'a'.repeat(64) }],
    ['cardSha256', { cardSha256: 'b'.repeat(64) }],
  ] as const)('a second registration with another `%s`: 409, the key blocked, the record `revoked` (`restart`)',
    async (_field, over) => {
      const dir = dataDir();
      const dump = dumpOf('e');
      const secret = newSecret();
      await pendingBefore(dir, dump, secret);
      clock += 10_000;
      const after = server(dir, NEXT_BOOT, { graceMs: GRACE_MS, alive: true });
      await after.cycle.recover();
      expect(after.reg.register(bodyOf(dump, secret, over)))
        .toEqual({ status: 409, body: { accepted: false, error: 'key-blocked' } });
      expect(after.reg.register(bodyOf(dump, secret)).status).toBe(409);
      await after.cycle.tick();
      expect(after.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'revoked', cause: 'restart' });
      expect(after.reg.secretOf(SESSION, dump.key)).toBeNull();
      expect(after.logs.some((line) => line.includes(`key ${dump.key} not resumed after the restart (refused)`)))
        .toBe(true);
    });

  it('no second registration within G: `revoked` (`restart`) at G; a late registration is a first one', async () => {
    const dir = dataDir();
    const dump = dumpOf('f');
    const secret = newSecret();
    await pendingBefore(dir, dump, secret);
    clock += 10_000;
    const after = server(dir, NEXT_BOOT, { graceMs: GRACE_MS, alive: true });
    await after.cycle.recover();
    clock += GRACE_MS - 1;
    await after.cycle.tick();
    expect(after.cycle.record(SESSION, dump.key)?.state).toBe('pending');
    clock += 1;
    await after.cycle.tick();
    expect(after.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'revoked', cause: 'restart' });
    expect(after.reg.register(bodyOf(dump, secret))).toEqual({ status: 200, body: { accepted: true, bootId: NEXT_BOOT } });
  });

  it.each([[false], [null]] as const)('`ps` says %s at recovery: `revoked` (`restart`) at once, nothing expected',
    async (alive) => {
      const dir = dataDir();
      const dump = dumpOf(`g-${String(alive)}`);
      const secret = newSecret();
      await pendingBefore(dir, dump, secret);
      clock += 10_000;
      const after = server(dir, NEXT_BOOT, { graceMs: GRACE_MS, alive });
      expect(await after.cycle.recover()).toEqual({ records: 1, changed: 1 });
      expect(after.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'revoked', cause: 'restart' });
      expect(after.reg.register(bodyOf(dump, secret)).body).not.toHaveProperty('resumed');
    });

  it('G = 0, no `ps`, or a record without the card digest of its first dump: `revoked` (`restart`) as before',
    async () => {
      for (const variant of ['grace-0', 'no-ps', 'no-dump-digest'] as const) {
        const dir = dataDir();
        const dump = dumpOf(`h-${variant}`);
        const secret = newSecret();
        const before = await pendingBefore(dir, dump, secret);
        if (variant === 'no-dump-digest') {
          const { dumpCardSha256: _dropped, ...rest } = before.cycle.record(SESSION, dump.key) ?? {};
          writeConsentRecord(dir, rest as Parameters<typeof writeConsentRecord>[1], { fsync: false });
        }
        clock += 10_000;
        const after = variant === 'grace-0' ? server(dir, NEXT_BOOT, { graceMs: 0, alive: true })
          : variant === 'no-ps' ? server(dir, NEXT_BOOT, { graceMs: GRACE_MS })
            : server(dir, NEXT_BOOT, { graceMs: GRACE_MS, alive: true });
        await after.cycle.recover();
        expect(after.cycle.record(SESSION, dump.key), variant).toMatchObject({ state: 'revoked', cause: 'restart' });
      }
    });

  it('a waiting card revoked by a signal no longer expects its hook: the registration is a first one', async () => {
    const dir = dataDir();
    const dump = dumpOf('i');
    const secret = newSecret();
    await pendingBefore(dir, dump, secret);
    clock += 10_000;
    const after = server(dir, NEXT_BOOT, { graceMs: GRACE_MS, alive: true });
    await after.cycle.recover();
    await after.cycle.observe(SESSION, dump.key, 'gone', dump);
    expect(after.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'revoked', cause: 'dialog-gone' });
    expect(after.reg.register(bodyOf(dump, secret))).toEqual({ status: 200, body: { accepted: true, bootId: NEXT_BOOT } });
  });
});

describe('`sent` and `claimed` with a live hook after a restart', () => {
  it('`sent` with its file: resumed only with the secret that signed the file; the claim deadline counts from the'
    + ' second registration; the hook takes the file and the new server confirms `/claim`', async () => {
    const dir = dataDir();
    const dump = dumpOf('j');
    const secret = newSecret();
    await sentBefore(dir, dump, secret);
    const sentAt = clock;
    clock += 30_000;
    const after = server(dir, NEXT_BOOT, { graceMs: GRACE_MS, alive: true });
    await after.cycle.recover();
    expect(after.cycle.record(SESSION, dump.key)?.state).toBe('sent');
    // Past the claim deadline from the write, inside G: the record keeps waiting for its hook.
    clock = sentAt + CONSENT_CLAIM_TIMEOUT_MS + 1;
    await after.cycle.tick();
    expect(after.cycle.record(SESSION, dump.key)?.state).toBe('sent');

    expect(after.reg.register(bodyOf(dump, secret))).toEqual(RESUMED);
    const resumedAt = clock;
    clock = resumedAt + CONSENT_CLAIM_TIMEOUT_MS - 1;
    await after.cycle.tick();
    expect(after.cycle.record(SESSION, dump.key)?.state).toBe('sent');

    renameSync(answerPath(dir, dump.key, '.json'), answerPath(dir, dump.key, '.claimed'));
    const decisionAt = after.cycle.record(SESSION, dump.key)?.decisionAt;
    expect(await claimTaken(after, dir, dump, secret)).toEqual({ status: 200, body: { confirmed: true } });
    expect(after.cycle.record(SESSION, dump.key)).toMatchObject({
      state: 'claimed', receipt: { decisionAt, inputSha256: dump.inputSha256 },
    });
  });

  /** The later process after the hook of a waiting `sent` record took its file before the second registration. */
  async function takenBeforeRegistration(dir: string, dump: HookCallDump, secret: string): Promise<Server> {
    await sentBefore(dir, dump, secret);
    clock += 10_000;
    const after = server(dir, NEXT_BOOT, { graceMs: GRACE_MS, alive: true });
    await after.cycle.recover();
    renameSync(answerPath(dir, dump.key, '.json'), answerPath(dir, dump.key, '.claimed'));
    clock += 1_000;
    await after.cycle.tick();
    expect(after.cycle.record(SESSION, dump.key)?.state).toBe('claimed');
    return after;
  }

  it('`sent` whose hook takes the file before its second registration waits on as `claimed`: the secret that signed'
    + ' the file resumes it and the new server confirms `/claim`', async () => {
    const dir = dataDir();
    const dump = dumpOf('o');
    const secret = newSecret();
    const after = await takenBeforeRegistration(dir, dump, secret);
    expect(after.reg.register(bodyOf(dump, secret))).toEqual(RESUMED);
    expect(await claimTaken(after, dir, dump, secret)).toEqual({ status: 200, body: { confirmed: true } });
  });

  it('`sent` whose hook takes the file before its second registration: another secret still blocks the key and no'
    + ' receipt is confirmed', async () => {
    const dir = dataDir();
    const dump = dumpOf('p');
    const secret = newSecret();
    const after = await takenBeforeRegistration(dir, dump, secret);
    expect(after.reg.register(bodyOf(dump, newSecret())))
      .toEqual({ status: 409, body: { accepted: false, error: 'key-blocked' } });
    expect(after.reg.register(bodyOf(dump, secret)).status).toBe(409);
    expect(await claimTaken(after, dir, dump, secret))
      .toEqual({ status: 403, body: { confirmed: false, error: 'refused' } });
  });

  it('a resumed `sent` keeps the start of its claim deadline in its record: after another restart the deadline still'
    + ' counts from the second registration, the signed decision time stays', async () => {
    const dir = dataDir();
    const dump = dumpOf('q');
    const secret = newSecret();
    const before = await sentBefore(dir, dump, secret);
    const decided = before.cycle.record(SESSION, dump.key);
    const sentAt = decided?.times.sent;
    if (decided === null || sentAt === undefined) throw new Error('no `sent` record');
    clock = sentAt + 30_000;
    const after = server(dir, NEXT_BOOT, { graceMs: GRACE_MS, alive: true });
    await after.cycle.recover();
    clock = sentAt + CONSENT_CLAIM_TIMEOUT_MS + 1;
    expect(after.reg.register(bodyOf(dump, secret))).toEqual(RESUMED);
    const resumedAt = clock;
    // No tick: the start is on disk once the registration's own task has run.
    await new Promise((resolve) => { setImmediate(resolve); });

    // Another restart a second later; this time `ps` does not find the hook, so nothing waits.
    clock = resumedAt + 1_000;
    const third = server(dir, 'boot-third', { graceMs: GRACE_MS, alive: false });
    await third.cycle.recover();
    expect(third.cycle.record(SESSION, dump.key)).toMatchObject({
      state: 'sent', decisionAt: decided.decisionAt, times: { sent: sentAt },
      claimFrom: { decisionAt: decided.decisionAt, at: resumedAt },
    });
    clock = resumedAt + CONSENT_CLAIM_TIMEOUT_MS - 1;
    await third.cycle.tick();
    expect(third.cycle.record(SESSION, dump.key)?.state).toBe('sent');
    clock += 1;
    await third.cycle.tick();
    expect(third.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'revoked', cause: 'claim-timeout' });
  });

  it.each([
    ['of another decision', (decisionAt: number, at: number): unknown => ({ decisionAt: decisionAt - 1, at })],
    ['in a bad shape', (decisionAt: number, at: number): unknown => ({ decisionAt: String(decisionAt), at })],
  ] as const)('a kept claim deadline start %s does not count: recovery counts from the `sent` time',
    async (_name, kept) => {
      const dir = dataDir();
      const dump = dumpOf('r');
      const secret = newSecret();
      const before = await sentBefore(dir, dump, secret);
      const record = before.cycle.record(SESSION, dump.key);
      const sentAt = record?.times.sent;
      if (record === null || record.decisionAt === null || sentAt === undefined) throw new Error('no `sent` record');
      clock = sentAt + CONSENT_CLAIM_TIMEOUT_MS + 1;
      // The start, if it counted, would leave the record inside its claim deadline.
      const claimFrom = kept(record.decisionAt, clock - 1);
      writeConsentRecord(dir, { ...record, claimFrom } as ConsentRecord, { fsync: false });
      const after = server(dir, NEXT_BOOT, { graceMs: GRACE_MS, alive: true });
      expect(await after.cycle.recover()).toEqual({ records: 1, changed: 1 });
      expect(after.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'revoked', cause: 'restart' });
    });

  it('`sent`: the same call fields with another secret block the key and revoke the file', async () => {
    const dir = dataDir();
    const dump = dumpOf('k');
    const secret = newSecret();
    await sentBefore(dir, dump, secret);
    clock += 10_000;
    const after = server(dir, NEXT_BOOT, { graceMs: GRACE_MS, alive: true });
    await after.cycle.recover();
    expect(after.reg.register(bodyOf(dump, newSecret()))).toMatchObject({ status: 409, body: { error: 'key-blocked' } });
    await after.cycle.tick();
    expect(after.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'revoked', cause: 'restart' });
    expect(existsSync(answerPath(dir, dump.key, '.revoked'))).toBe(true);
  });

  it('`sent` without a second registration within G: the file revoked (`restart`)', async () => {
    const dir = dataDir();
    const dump = dumpOf('l');
    const secret = newSecret();
    await sentBefore(dir, dump, secret);
    clock += 5_000;
    const after = server(dir, NEXT_BOOT, { graceMs: GRACE_MS, alive: true });
    await after.cycle.recover();
    clock += GRACE_MS;
    await after.cycle.tick();
    expect(after.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'revoked', cause: 'restart' });
    expect(existsSync(answerPath(dir, dump.key, '.revoked'))).toBe(true);
  });

  it('`claimed` `allow` without a receipt (the hook took the file before the restart): resumed, `/claim` confirmed',
    async () => {
      const dir = dataDir();
      const dump = dumpOf('m');
      const secret = newSecret();
      await sentBefore(dir, dump, secret);
      renameSync(answerPath(dir, dump.key, '.json'), answerPath(dir, dump.key, '.claimed'));
      clock += 10_000;
      const after = server(dir, NEXT_BOOT, { graceMs: GRACE_MS, alive: true });
      await after.cycle.recover();
      expect(after.cycle.record(SESSION, dump.key)?.state).toBe('claimed');
      expect(after.reg.register(bodyOf(dump, secret))).toEqual(RESUMED);
      const file = JSON.parse(readFileSync(answerPath(dir, dump.key, '.claimed'), 'utf8')) as { at: number };
      expect(await after.cycle.confirmReceipt(SESSION, dump.key, file.at, dump.inputSha256)).toBe(true);
    });

  it('`deciding` without a file: `revoked` (`restart`) with a live hook too; nothing expected', async () => {
    const dir = dataDir();
    const dump = dumpOf('n');
    const secret = newSecret();
    const before = await sentBefore(dir, dump, secret);
    const record = before.cycle.record(SESSION, dump.key);
    if (record === null) throw new Error('no record');
    writeConsentRecord(dir, { ...record, state: 'deciding' }, { fsync: false });
    unlinkSync(answerPath(dir, dump.key, '.json'));
    clock += 10_000;
    const after = server(dir, NEXT_BOOT, { graceMs: GRACE_MS, alive: true });
    await after.cycle.recover();
    expect(after.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'revoked', cause: 'restart' });
    expect(after.reg.register(bodyOf(dump, secret)).body).not.toHaveProperty('resumed');
    expect(readConsentRecords(dir)).toEqual([expect.objectContaining({ key: dump.key, state: 'revoked' })]);
  });
});
