/**
 * The hook's receipt of a phone `allow` (W-a): `POST /claim` on the registration socket, `layer1/receipt.ts`,
 * the cycle's `confirmReceipt` and the outcome rule `consentReceiptOf` (`layer1/proof.ts`).
 *
 * The real registry, cycle, registration socket and transcript review (a jsonl file in `$TMPDIR`). The hook side is
 * the hook's own module `scripts/hooks/consent.mjs` in this process: the receipt signature, `/claim` and the take of
 * the answer file are the code the hook runs. The hook as a child process: `hook-receipt.test.ts`.
 *
 * The server confirms only the record's live `allow` (`sent`, or `claimed` from its own sight of the same take before
 * the receipt came) with the same `decisionAt` and a receipt signed with the live hook's secret. `applied` needs the
 * receipt and, on top of it, the record's input digest equal to the registration's (frame 2d of the plan). Both
 * decisions need the registration digests the answer was signed over (the record's `signed`: input and card digest,
 * which covers the tool name) equal to the record's first dump, also after a restart; a `deny` takes no receipt
 * (frame 2d with another input or tool name).
 */
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { consentSocketPath, createConsentHandler, startConsentSocket } from '../src/auth/consent-socket.ts';
import type { ConsentSocket } from '../src/auth/consent-socket.ts';
import { createConsentEvidenceReview } from '../src/herdr/consent-evidence.ts';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import type { HookCallDump } from '../src/herdr/dialogs/hook/contract.ts';
import {
  CONSENT_CLAIM_BODY_MAX_BYTES, CONSENT_CLAIM_DEADLINE_MS, CONSENT_CLAIM_ROUTE, CONSENT_DIRNAME, CONSENT_MAC_PREFIX,
  CONSENT_RECEIPT_MAC_FIELDS, CONSENT_RECEIPT_MAC_PREFIX, CONSENT_REGISTER_ROUTE, CONSENT_SECRET_BYTES,
  CONSENT_SOCKET_ROUTES,
} from '../src/herdr/dialogs/layer1/contract.ts';
import type { ConsentFile } from '../src/herdr/dialogs/layer1/contract.ts';
import { createConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import type { ConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import { consentReceiptOf } from '../src/herdr/dialogs/layer1/proof.ts';
import { CONSENT_CLAIM_REFUSALS, createConsentClaims } from '../src/herdr/dialogs/layer1/receipt.ts';
import { readConsentRecords } from '../src/herdr/dialogs/layer1/records.ts';
import { createConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import type { ConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import { consentCardSha256, consentReceiptMac } from '../src/herdr/dialogs/layer1/sign.ts';
import { standingWithRead } from './helpers/dowod-z-odczytem.ts';

const ENGINE = '55555555-5555-4555-8555-555555555555';
const PROMPT = '66666666-6666-4666-8666-666666666666';
const INPUT = { command: 'npm test' };
const CALL = 'toolu_0000000000000000000000c1';
const CALL_OTHER = 'toolu_0000000000000000000000c2';
const OTHER = { command: 'npm run other' };
const RUN_A = 'mcp__server__runA';
const RUN_B = 'mcp__server__runB';
const HOOK_CONSENT = join(import.meta.dirname, '..', '..', 'scripts', 'hooks', 'consent.mjs');

/** What this test uses from the hook's module (JS without types). */
interface HookConsent {
  readonly CLAIM_ROUTE: string;
  readonly CLAIM_DEADLINE_MS: number;
  readonly RECEIPT_MAC_PREFIX: string;
  readonly RECEIPT_MAC_FIELDS: readonly string[];
  readonly MAC_PREFIX: string;
  receiptMac(secret: string, fields: { sessionId: string; key: string; at: number }): string;
  confirmConsent(socketPath: string, body: unknown, deadlineMs?: number):
  Promise<{ readonly confirmed: boolean; readonly detail?: string }>;
  claimConsentFile(base: string): { readonly body: unknown } | null;
  consentOutput(file: unknown, context: { hookEventName: string; toolName: string; toolInput: unknown }): unknown;
}
const hookConsent = async (): Promise<HookConsent> => (await import(pathToFileURL(HOOK_CONSENT).href)) as HookConsent;

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const iso = (): string => new Date().toISOString();

async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise<void>((resolve) => { setImmediate(resolve); });
}

function dumpOf(seed: string, toolInput: unknown = INPUT): HookCallDump {
  const startedAt = Date.now() - 1_000;
  return {
    key: `${PROMPT}-${sha(seed).slice(0, 32)}`, sessionId: ENGINE, promptId: PROMPT, pid: process.pid, startedAt,
    toolName: 'Bash', toolInput, cwd: '/Users/u/Projects/atlas', at: startedAt + 100,
    inputSha256: canonicalSha256(toolInput), permissionMode: 'default',
  };
}

const cardShaOf = (dump: HookCallDump): string => consentCardSha256({
  sessionId: dump.sessionId, toolName: dump.toolName, toolInput: dump.toolInput, cwd: dump.cwd, agentId: null,
  permissionMode: dump.permissionMode ?? null,
});

/** Registration as the hook sends it; returns the hook's secret. */
function register(reg: ConsentRegistry, dump: HookCallDump): string {
  const secret = randomBytes(CONSENT_SECRET_BYTES).toString('hex');
  const outcome = reg.register({
    key: dump.key, sessionId: dump.sessionId, promptId: dump.promptId, secret, inputSha256: dump.inputSha256,
    cardSha256: cardShaOf(dump), pid: dump.pid, startedAt: dump.startedAt,
  });
  expect(outcome.status).toBe(200);
  return secret;
}

/** A further `tool_use` of the line: id, input and tool name (`Bash` without one). */
type MoreCall = readonly [string, unknown, string?];

function toolUseLine(input: unknown = INPUT, more: readonly MoreCall[] = [], name = 'Bash'): string {
  const calls: readonly MoreCall[] = [[CALL, input, name], ...more];
  return JSON.stringify({
    type: 'assistant', uuid: '00000000-0000-4000-9000-0000000000a2', timestamp: iso(), sessionId: ENGINE,
    isSidechain: false, message: {
      id: 'msg_0000000000000000000000a2', role: 'assistant',
      content: calls.map(([id, args, tool]) => ({ type: 'tool_use', id, name: tool ?? 'Bash', input: args })),
    },
  });
}

function humanLine(): string {
  return JSON.stringify({
    type: 'user', uuid: '00000000-0000-4000-9000-0000000000a1', timestamp: iso(), sessionId: ENGINE, promptId: PROMPT,
    isSidechain: false, origin: { kind: 'human' }, message: { role: 'user', content: 'run the tests' },
  });
}

function resultLine(source: string, decision: 'accept' | 'reject' = 'accept', id = CALL): string {
  return JSON.stringify({
    type: 'user', uuid: `00000000-0000-4000-9000-0000000000${id === CALL ? 'a3' : 'b3'}`, timestamp: iso(),
    sessionId: ENGINE, promptId: PROMPT, isSidechain: false,
    permissionDecision: { decision, source, reasonType: source, reasonCode: 'unknown' },
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, is_error: decision === 'reject', content: 'ok' }],
    },
  });
}

interface Reply {
  readonly status: number;
  readonly text: string;
}

/** A raw request through the registration socket; `raw` = a body sent as is. */
function socketCall(socketPath: string, method: string, route: string, body?: unknown, raw?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const req = http.request({
      socketPath, path: route, method,
      headers: payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }); });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/**
 * Status line of a raw request: the socket answers 413 and closes before the client has written the whole body, so
 * an `http.request` would fail with EPIPE instead of reading the answer.
 */
function rawStatus(socketPath: string, route: string, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const conn = net.connect(socketPath);
    let text = '';
    conn.on('data', (chunk: Buffer) => { text += chunk.toString('utf8'); });
    conn.on('close', () => {
      const status = /^HTTP\/1\.1 (\d{3})/.exec(text);
      if (status === null) reject(new Error(`no answer: ${text}`));
      else resolve(Number(status[1]));
    });
    conn.on('error', () => {});
    conn.write(`POST ${route} HTTP/1.1\r\nHost: rarog\r\nContent-Length: ${String(Buffer.byteLength(body))}\r\n`
      + `Connection: close\r\n\r\n${body}`);
  });
}

interface Harness {
  readonly dir: string;
  readonly reg: ConsentRegistry;
  readonly cycle: ConsentCycle;
  readonly socketPath: string;
  readonly lines: string[];
  /** One transcript review tick (the server's 1 s tick). */
  review(): Promise<void>;
}

describe('hook receipt of a phone `allow` (W-a)', () => {
  const closers: (() => Promise<void>)[] = [];
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rarog-receipt-'));
    file = join(dir, `${ENGINE}.jsonl`);
    writeFileSync(file, '');
  });

  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
    await rm(dir, { recursive: true, force: true });
  });

  async function start(bootId = 'boot-receipt-1', options: { recover?: boolean; claims?: boolean } = {}):
  Promise<Harness> {
    const lines: string[] = [];
    const reg = createConsentRegistry({ bootId, send: () => true, sessions: () => [ENGINE], log: () => {} });
    reg.setScope('main');
    const cycle: ConsentCycle = standingWithRead(createConsentCycle({
      dataDir: dir, bootId, registry: reg, mode: () => 'main', log: (line) => { lines.push(line); },
    }));
    if (options.recover === true) await cycle.recover();
    const claims = createConsentClaims({
      registry: reg, confirm: (sessionId, key, at, inputSha256) => cycle.confirmReceipt(sessionId, key, at, inputSha256),
      log: (line) => { lines.push(line); },
    });
    const socket: ConsentSocket | null = await startConsentSocket(
      dir, options.claims === false ? createConsentHandler(reg) : createConsentHandler(reg, claims), () => {},
    );
    if (socket === null) throw new Error('registration socket did not start');
    closers.push(() => socket.close());
    const review = createConsentEvidenceReview({ cycle, locate: async () => file });
    return {
      dir, reg, cycle, socketPath: consentSocketPath(dir), lines,
      review: async () => {
        await review.tick();
        await flush();
      },
    };
  }

  /** A card with the approve button, allowed from the phone: the record is `sent`. */
  async function allowed(h: Harness, dump: HookCallDump): Promise<{ readonly secret: string; readonly at: number }> {
    const secret = register(h.reg, dump);
    expect(await h.cycle.observe(ENGINE, dump.key, 'standing', dump)).toMatchObject({ canAllow: true });
    expect(await h.cycle.decide(ENGINE, dump.key, 'allow')).toEqual({ ok: true, state: 'sent' });
    const at = h.cycle.record(ENGINE, dump.key)?.decisionAt;
    if (typeof at !== 'number') throw new Error('no decisionAt');
    return { secret, at };
  }

  const base = (key: string): string => join(dir, CONSENT_DIRNAME, ENGINE, key);

  /** The hook takes the answer file (`rename` to `.claimed`) and reads it, as `waitForConsent` does. */
  async function take(key: string): Promise<ConsentFile> {
    const taken = (await hookConsent()).claimConsentFile(base(key));
    if (taken === null) throw new Error('no answer file to take');
    return taken.body as ConsentFile;
  }

  /** The hook's `/claim` with its receipt signature for `at`. */
  async function claim(h: Harness, key: string, secret: string, at: number):
  Promise<{ readonly confirmed: boolean; readonly detail?: string }> {
    const consent = await hookConsent();
    return consent.confirmConsent(h.socketPath, {
      key, at, mac: consent.receiptMac(secret, { sessionId: ENGINE, key, at }),
    });
  }

  async function turnOpened(
    h: Harness, input: unknown = INPUT, more: readonly MoreCall[] = [], name = 'Bash',
  ): Promise<void> {
    appendFileSync(file, `${humanLine()}\n${toolUseLine(input, more, name)}\n`);
    await h.review();
    await h.review();
  }

  it('confirmed `allow`: the record is `claimed` with the receipt, and the hook result bound to the key settles'
    + ' `applied`', async () => {
    const h = await start();
    const dump = dumpOf('applied');
    const { secret, at } = await allowed(h, dump);
    const taken = await take(dump.key);
    expect(taken).toMatchObject({ decision: 'allow', at });
    expect(await claim(h, dump.key, secret, at)).toEqual({ confirmed: true });
    expect(h.cycle.record(ENGINE, dump.key)).toMatchObject({
      state: 'claimed', receipt: { decisionAt: at, inputSha256: dump.inputSha256 },
    });
    expect(consentReceiptOf(h.cycle.record(ENGINE, dump.key) ?? { decision: null, decisionAt: null, inputSha256: '' }))
      .toBe(true);

    await turnOpened(h);
    appendFileSync(file, `${resultLine('hook')}\n`);
    await h.review();
    expect(h.cycle.record(ENGINE, dump.key)).toMatchObject({
      state: 'applied', cause: null, correlation: 'bound', toolUseId: CALL,
    });
  });

  it('old hook copy (no `/claim`): the hook still gets `allow` from the file, the file review takes it as `claimed`'
    + ' without a receipt, and the hook result settles `unknown` (`no-receipt`)', async () => {
    const h = await start();
    const dump = dumpOf('old-hook');
    await allowed(h, dump);
    const taken = await take(dump.key);
    expect((await hookConsent()).consentOutput(taken, {
      hookEventName: 'PermissionRequest', toolName: 'Bash', toolInput: INPUT,
    })).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    await h.cycle.tick();
    const record = h.cycle.record(ENGINE, dump.key);
    expect(record?.state).toBe('claimed');
    expect(record).not.toHaveProperty('receipt');

    await turnOpened(h);
    appendFileSync(file, `${resultLine('hook')}\n`);
    await h.review();
    expect(h.cycle.record(ENGINE, dump.key)).toMatchObject({ state: 'unknown', cause: 'no-receipt', toolUseId: CALL });
  });

  it('the receipt survives a server restart: the record on disk carries it and the result after the restart settles'
    + ' `applied`', async () => {
    const before = await start('boot-receipt-1');
    const dump = dumpOf('restart');
    const { secret, at } = await allowed(before, dump);
    await take(dump.key);
    expect(await claim(before, dump.key, secret, at)).toEqual({ confirmed: true });
    await turnOpened(before);
    for (const close of closers.splice(0).reverse()) await close();
    expect(readConsentRecords(dir).find((r) => r.key === dump.key)).toMatchObject({
      state: 'claimed', receipt: { decisionAt: at, inputSha256: dump.inputSha256 },
    });

    const after = await start('boot-receipt-2', { recover: true });
    expect(after.cycle.record(ENGINE, dump.key)).toMatchObject({ state: 'claimed', receipt: { decisionAt: at } });
    appendFileSync(file, `${resultLine('hook')}\n`);
    await after.review();
    expect(after.cycle.record(ENGINE, dump.key)).toMatchObject({ state: 'applied', toolUseId: CALL });
  });

  it('a bad receipt signature and an unknown key get the same answer, and the record stays `sent`', async () => {
    const h = await start();
    const dump = dumpOf('bad-mac');
    const { at } = await allowed(h, dump);
    await take(dump.key);
    const other = randomBytes(CONSENT_SECRET_BYTES).toString('hex');
    const consent = await hookConsent();
    const badMac = await socketCall(h.socketPath, 'POST', CONSENT_CLAIM_ROUTE, {
      key: dump.key, at, mac: consent.receiptMac(other, { sessionId: ENGINE, key: dump.key, at }),
    });
    const unknownKey = `${PROMPT}-${sha('nobody').slice(0, 32)}`;
    const unknown = await socketCall(h.socketPath, 'POST', CONSENT_CLAIM_ROUTE, {
      key: unknownKey, at, mac: consent.receiptMac(other, { sessionId: ENGINE, key: unknownKey, at }),
    });
    expect(badMac).toEqual({ status: CONSENT_CLAIM_REFUSALS.refused, text: JSON.stringify({ confirmed: false, error: 'refused' }) });
    expect(unknown).toEqual(badMac);
    // The answer file's own `mac` is not a receipt: a copy of the file does not confirm anything.
    const fileMac = JSON.parse(readFileSync(`${base(dump.key)}.claimed`, 'utf8')) as ConsentFile;
    expect(await socketCall(h.socketPath, 'POST', CONSENT_CLAIM_ROUTE, { key: dump.key, at, mac: fileMac.mac }))
      .toEqual(badMac);
    expect(h.cycle.record(ENGINE, dump.key)).toMatchObject({ state: 'sent' });
    expect(h.cycle.record(ENGINE, dump.key)).not.toHaveProperty('receipt');
  });

  it('a receipt for another `at` and for a revoked record is refused (`stale`), and the record stays as it was',
    async () => {
      const h = await start();
      const sent = dumpOf('other-at');
      const first = await allowed(h, sent);
      await take(sent.key);
      expect(await claim(h, sent.key, first.secret, first.at - 1)).toEqual({ confirmed: false, detail: '409' });
      expect(h.cycle.record(ENGINE, sent.key)).toMatchObject({ state: 'sent' });

      const revoked = dumpOf('revoked');
      const second = await allowed(h, revoked);
      await h.cycle.off();
      expect(h.cycle.record(ENGINE, revoked.key)).toMatchObject({ state: 'revoked', cause: 'off' });
      expect(await claim(h, revoked.key, second.secret, second.at)).toEqual({ confirmed: false, detail: '409' });
      expect(h.cycle.record(ENGINE, revoked.key)).toMatchObject({ state: 'revoked' });
    });

  it('a `deny` answer and a card without a decision take no receipt', async () => {
    const h = await start();
    const denied = dumpOf('deny');
    const secret = register(h.reg, denied);
    await h.cycle.observe(ENGINE, denied.key, 'standing', denied);
    expect(await h.cycle.decide(ENGINE, denied.key, 'deny')).toEqual({ ok: true, state: 'sent' });
    const at = h.cycle.record(ENGINE, denied.key)?.decisionAt ?? 0;
    expect(await claim(h, denied.key, secret, at)).toEqual({ confirmed: false, detail: '409' });

    const open = dumpOf('pending');
    const openSecret = register(h.reg, open);
    await h.cycle.observe(ENGINE, open.key, 'standing', open);
    expect(await claim(h, open.key, openSecret, Date.now())).toEqual({ confirmed: false, detail: '409' });
    expect(h.cycle.record(ENGINE, open.key)).toMatchObject({ state: 'pending' });
  });

  it('after a restart the old hook cannot confirm: the new registry does not know its secret', async () => {
    const before = await start('boot-receipt-1');
    const dump = dumpOf('restart-unknown');
    const { secret, at } = await allowed(before, dump);
    await take(dump.key);
    for (const close of closers.splice(0).reverse()) await close();
    const after = await start('boot-receipt-2', { recover: true });
    expect(after.cycle.record(ENGINE, dump.key)?.state).toBe('claimed');
    expect(await claim(after, dump.key, secret, at)).toEqual({ confirmed: false, detail: '403' });
    expect(after.cycle.record(ENGINE, dump.key)).not.toHaveProperty('receipt');
  });

  it('race with the file review: the review saw the take first (`claimed`), the receipt still confirms the same'
    + ' answer', async () => {
    const h = await start();
    const dump = dumpOf('review-first');
    const { secret, at } = await allowed(h, dump);
    await take(dump.key);
    await h.cycle.tick();
    expect(h.cycle.record(ENGINE, dump.key)?.state).toBe('claimed');
    expect(await claim(h, dump.key, secret, at)).toEqual({ confirmed: true });
    expect(h.cycle.record(ENGINE, dump.key)).toMatchObject({ state: 'claimed', receipt: { decisionAt: at } });
    // A second receipt for the same answer is the same answer.
    expect(await claim(h, dump.key, secret, at)).toEqual({ confirmed: true });
  });

  it('race with `release`, the hook first: `release` is too late, and the receipt confirms the taken answer',
    async () => {
      const h = await start();
      const dump = dumpOf('release-late');
      const { secret, at } = await allowed(h, dump);
      await take(dump.key);
      expect(await h.cycle.release(ENGINE, dump.key)).toEqual({ ok: false, error: 'too-late', state: 'claimed' });
      expect(await claim(h, dump.key, secret, at)).toEqual({ confirmed: true });
    });

  it('race with `release`, `release` first: the allow answer is gone, and a copy of it put back is taken by the hook'
    + ' but its receipt is refused', async () => {
    const h = await start();
    const dump = dumpOf('release-first');
    const { secret, at } = await allowed(h, dump);
    const copy = join(dir, 'allow-copy.json');
    copyFileSync(`${base(dump.key)}.json`, copy);
    expect(await h.cycle.release(ENGINE, dump.key)).toEqual({ ok: true, state: 'sent' });
    expect(h.cycle.record(ENGINE, dump.key)).toMatchObject({ state: 'sent', decision: 'release' });
    expect(existsSync(`${base(dump.key)}.revoked`)).toBe(true);
    // The allow copy replaces the release answer: valid signature, live record, other decision.
    renameSync(copy, `${base(dump.key)}.json`);
    const taken = await take(dump.key);
    expect(taken).toMatchObject({ decision: 'allow', at });
    expect(await claim(h, dump.key, secret, at)).toEqual({ confirmed: false, detail: '409' });
    expect(h.cycle.record(ENGINE, dump.key)).toMatchObject({ state: 'sent', decision: 'release' });
  });

  it('frame 2d: a record whose dump digest differs from the registration gets the receipt but never `applied`',
    async () => {
      const h = await start();
      const real = dumpOf('digest');
      const secret = register(h.reg, real);
      // The record comes from a first dump under the same key with other input; the card has no button for it.
      const forged = { ...real, toolInput: { command: 'npm run other' }, inputSha256: canonicalSha256({ command: 'npm run other' }) };
      expect(await h.cycle.observe(ENGINE, real.key, 'standing', forged)).toMatchObject({ canAllow: false });
      expect(await h.cycle.observe(ENGINE, real.key, 'standing', real)).toMatchObject({ canAllow: true });
      expect(await h.cycle.decide(ENGINE, real.key, 'allow')).toEqual({ ok: true, state: 'sent' });
      const record = h.cycle.record(ENGINE, real.key);
      expect(record?.inputSha256).toBe(forged.inputSha256);
      const at = record?.decisionAt ?? 0;
      await take(real.key);
      expect(await claim(h, real.key, secret, at)).toEqual({ confirmed: true });
      expect(h.cycle.record(ENGINE, real.key)).toMatchObject({ receipt: { inputSha256: real.inputSha256 } });
      expect(consentReceiptOf(h.cycle.record(ENGINE, real.key) ?? { decision: null, decisionAt: null, inputSha256: '' }))
        .toBe(false);

      // The record binds by its own digest, so a hook result of a call with the forged input is bound to it.
      await turnOpened(h, forged.toolInput);
      appendFileSync(file, `${resultLine('hook')}\n`);
      await h.review();
      expect(h.cycle.record(ENGINE, real.key)).toMatchObject({ state: 'unknown', cause: 'no-receipt', toolUseId: CALL });
    });

  /** The fields a record's first dump has other than the registration it is answered under (frame 2d). */
  type FirstDump = Partial<Pick<HookCallDump, 'toolName' | 'toolInput'>>;

  /**
   * A phone answer to a registered dump whose record came from a first dump with the fields `first`: the hook takes
   * the answer file, signed over the registration, and confirms the receipt of an `allow`. The record is `claimed`.
   */
  async function answeredOver(
    h: Harness, real: HookCallDump, first: FirstDump, decision: 'allow' | 'deny' = 'deny',
  ): Promise<void> {
    const secret = register(h.reg, real);
    const dump = { ...real, ...first, inputSha256: canonicalSha256(first.toolInput ?? real.toolInput) };
    await h.cycle.observe(ENGINE, real.key, 'standing', dump);
    // An MCP card needs the top of the screen for the approve button (`consentKeyRule`); a `deny` needs none.
    expect(await h.cycle.observe(ENGINE, real.key, 'standing', real))
      .toMatchObject(decision === 'allow' ? { canAllow: true } : { canDeny: true });
    expect(await h.cycle.decide(ENGINE, real.key, decision)).toEqual({ ok: true, state: 'sent' });
    const record = h.cycle.record(ENGINE, real.key);
    expect(record).toMatchObject({ toolName: dump.toolName, inputSha256: dump.inputSha256 });
    // The phone answers the call it shows: the answer is signed over the registration.
    expect(await take(real.key)).toMatchObject({
      decision, inputSha256: real.inputSha256, cardSha256: cardShaOf(real),
    });
    if (decision === 'allow') expect(await claim(h, real.key, secret, record?.decisionAt ?? 0)).toEqual({ confirmed: true });
    else await h.cycle.tick();
    expect(h.cycle.record(ENGINE, real.key)?.state).toBe('claimed');
  }

  /** First dumps that differ from the registration in the input or in the tool name, for both decisions. */
  const DIVERGENT: readonly {
    readonly what: string; readonly decision: 'allow' | 'deny'; readonly real: { readonly toolName: string };
    readonly first: FirstDump;
  }[] = [
    { what: 'input, `deny`', decision: 'deny', real: { toolName: 'Bash' }, first: { toolInput: OTHER } },
    { what: 'tool name, `deny`', decision: 'deny', real: { toolName: RUN_A }, first: { toolName: RUN_B } },
    { what: 'tool name, `allow`', decision: 'allow', real: { toolName: 'Bash' }, first: { toolName: 'WebFetch' } },
  ];

  const resultOf = (decision: 'allow' | 'deny'): 'accept' | 'reject' => (decision === 'allow' ? 'accept' : 'reject');

  it.each(DIVERGENT)('frame 2d, first dump with another $what: the record binds by its first dump, the answer is'
    + ' signed over the registration, so the hook result of the call the record binds never settles `applied`',
  async ({ decision, real: fields, first }) => {
    const h = await start();
    const real = { ...dumpOf(`first-${decision}-${fields.toolName}`), ...fields };
    await answeredOver(h, real, first, decision);

    // A hook result for the call of the first dump, a desk `accept` of the call the phone answered.
    await turnOpened(h, first.toolInput ?? INPUT, [[CALL_OTHER, INPUT, real.toolName]], first.toolName ?? real.toolName);
    appendFileSync(file, `${resultLine('hook', resultOf(decision))}\n`
      + `${resultLine('user_temporary', 'accept', CALL_OTHER)}\n`);
    await h.review();
    expect(h.cycle.record(ENGINE, real.key)).toMatchObject({
      state: 'unknown', cause: 'no-receipt', decision, correlation: 'bound', toolUseId: CALL,
    });
  });

  it.each(DIVERGENT)('the registration an answer was signed over survives a restart: after it, a `deny` of the'
    + ' record\'s own call settles `applied`, an answer under a first dump with another $what stays `unknown`'
    + ' (`no-receipt`)', async ({ decision, real: fields, first }) => {
    const before = await start('boot-receipt-1');
    const own = dumpOf('own-deny');
    const real = { ...dumpOf(`restart-${decision}-${fields.toolName}`, { command: 'npm run lint' }), ...fields };
    await answeredOver(before, own, {});
    await answeredOver(before, real, first, decision);
    await turnOpened(before, INPUT, [[CALL_OTHER, first.toolInput ?? real.toolInput, first.toolName ?? real.toolName]]);
    for (const close of closers.splice(0).reverse()) await close();
    const onDisk = (key: string) => readConsentRecords(dir).find((r) => r.key === key);
    expect(onDisk(own.key)).toMatchObject({
      dumpCardSha256: cardShaOf(own),
      signed: { decisionAt: onDisk(own.key)?.decisionAt, inputSha256: own.inputSha256, cardSha256: cardShaOf(own) },
    });
    expect(onDisk(real.key)).toMatchObject({
      dumpCardSha256: cardShaOf({ ...real, ...first }),
      signed: { inputSha256: real.inputSha256, cardSha256: cardShaOf(real) },
    });

    const after = await start('boot-receipt-2', { recover: true });
    appendFileSync(file, `${resultLine('hook', 'reject')}\n${resultLine('hook', resultOf(decision), CALL_OTHER)}\n`);
    await after.review();
    expect(after.cycle.record(ENGINE, own.key)).toMatchObject({
      state: 'applied', cause: null, decision: 'deny', toolUseId: CALL,
    });
    expect(after.cycle.record(ENGINE, real.key)).toMatchObject({
      state: 'unknown', cause: 'no-receipt', decision, toolUseId: CALL_OTHER,
    });
  });

  it('the `/claim` route: the method, bad JSON, a body over the ceiling and a bad shape; no answer carries the secret',
    async () => {
      const h = await start();
      const dump = dumpOf('route');
      const { secret, at } = await allowed(h, dump);
      expect((await socketCall(h.socketPath, 'GET', CONSENT_CLAIM_ROUTE)).status).toBe(405);
      expect(await socketCall(h.socketPath, 'POST', CONSENT_CLAIM_ROUTE, undefined, '{not json'))
        .toEqual({ status: 400, text: JSON.stringify({ confirmed: false, error: 'bad-request' }) });
      const big = JSON.stringify({ key: dump.key, at, mac: 'a'.repeat(CONSENT_CLAIM_BODY_MAX_BYTES) });
      expect(Buffer.byteLength(big)).toBeGreaterThan(CONSENT_CLAIM_BODY_MAX_BYTES);
      expect(await rawStatus(h.socketPath, CONSENT_CLAIM_ROUTE, big)).toBe(413);
      for (const body of [
        { key: dump.key, at }, { key: dump.key, at: String(at), mac: 'a'.repeat(64) },
        { key: 'x', at, mac: 'a'.repeat(64) }, { key: dump.key, at, mac: 'A'.repeat(64) },
        { key: dump.key, at, mac: 'a'.repeat(64), secret },
      ]) {
        expect(await socketCall(h.socketPath, 'POST', CONSENT_CLAIM_ROUTE, body), JSON.stringify(body).slice(0, 80))
          .toEqual({ status: 400, text: JSON.stringify({ confirmed: false, error: 'bad-request' }) });
      }
      await take(dump.key);
      const consent = await hookConsent();
      const ok = await socketCall(h.socketPath, 'POST', CONSENT_CLAIM_ROUTE, {
        key: dump.key, at, mac: consent.receiptMac(secret, { sessionId: ENGINE, key: dump.key, at }),
      });
      expect(ok).toEqual({ status: 200, text: JSON.stringify({ confirmed: true }) });
      expect(h.lines.join('\n')).not.toContain(secret);
      expect(h.lines.some((line) => line.includes(dump.key) && line.includes('receipt'))).toBe(true);
    });

  it('a socket without `/claim` (a server from before the receipt) answers 404, and the hook module reads it as no'
    + ' receipt', async () => {
    const h = await start('boot-receipt-1', { claims: false });
    const dump = dumpOf('old-server');
    const { secret, at } = await allowed(h, dump);
    await take(dump.key);
    expect(await claim(h, dump.key, secret, at)).toEqual({ confirmed: false, detail: '404' });
  });
});

describe('receipt contract: the hook module = `layer1/contract.ts` and `layer1/sign.ts`', () => {
  it('route, deadline, signature prefix and fields; the prefix differs from the answer file signature', async () => {
    const consent = await hookConsent();
    expect(consent.CLAIM_ROUTE).toBe(CONSENT_CLAIM_ROUTE);
    expect(consent.CLAIM_DEADLINE_MS).toBe(CONSENT_CLAIM_DEADLINE_MS);
    expect(consent.RECEIPT_MAC_PREFIX).toBe(CONSENT_RECEIPT_MAC_PREFIX);
    expect(consent.RECEIPT_MAC_FIELDS).toEqual([...CONSENT_RECEIPT_MAC_FIELDS]);
    expect(CONSENT_RECEIPT_MAC_PREFIX).toMatch(/^[a-z]+-consent-receipt-v\d+\|$/);
    expect(CONSENT_RECEIPT_MAC_PREFIX).not.toBe(CONSENT_MAC_PREFIX);
    expect(consent.MAC_PREFIX).toBe(CONSENT_MAC_PREFIX);
    expect(CONSENT_SOCKET_ROUTES).toEqual([CONSENT_REGISTER_ROUTE, CONSENT_CLAIM_ROUTE]);
  });

  it('the hook and the server sign a receipt the same way, byte for byte', async () => {
    const consent = await hookConsent();
    const secret = sha('receipt-secret');
    const fields = { sessionId: ENGINE, key: `${PROMPT}-${sha('vector').slice(0, 32)}`, at: 1_762_840_000_123 };
    expect(consent.receiptMac(secret, fields)).toBe(consentReceiptMac(secret, fields));
    expect(consentReceiptMac(secret, fields)).toMatch(/^[0-9a-f]{64}$/);
    expect(consentReceiptMac(secret, { ...fields, at: fields.at + 1 })).not.toBe(consentReceiptMac(secret, fields));
  });
});
