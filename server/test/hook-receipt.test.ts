/**
 * The `PermissionRequest` hook gives `allow` only after the server confirms receipt (W-a):
 * `scripts/hooks/rarog-pending.mjs` with `scripts/hooks/consent.mjs` as a child process, against the real registry,
 * cycle and registration socket with `POST /claim` (`auth/consent-socket.ts`, `layer1/receipt.ts`).
 *
 * The hook takes a signed `allow` file, sends `/claim` with the key, the file's `at` and a receipt signature made with
 * its own secret, and prints `allow` only for a confirmed receipt. No receipt (a refusal, no route, no socket) = exit
 * without a decision, so the dialog stays in the terminal. `deny` and `release` need no receipt.
 *
 * Revocation cases stop the hook process (`SIGSTOP`) so the test can change the answer files before the hook polls.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createConsentHandler, startConsentSocket } from '../src/auth/consent-socket.ts';
import type { ConsentSocket } from '../src/auth/consent-socket.ts';
import { HOOK_ALIVE_FILENAME, HOOK_SHADOW_LOG_FILENAME } from '../src/herdr/dialogs/hook/contract.ts';
import type { HookShadowLogEntry } from '../src/herdr/dialogs/hook/contract.ts';
import { CONSENT_DENY_MESSAGE, CONSENT_DIRNAME } from '../src/herdr/dialogs/layer1/contract.ts';
import { createConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import type { ConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import { createConsentClaims } from '../src/herdr/dialogs/layer1/receipt.ts';
import { createConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import type { ConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import { signConsentFile } from '../src/herdr/dialogs/layer1/sign.ts';
import { readCallDumps } from '../src/herdr/dialogs/shadow/files.ts';
import { standingWithRead } from './helpers/dowod-z-odczytem.ts';

const HOOK = join(import.meta.dirname, '..', '..', 'scripts', 'hooks', 'rarog-pending.mjs');
const SESSION = '550e8400-e29b-41d4-a716-446655440000';
const PROMPT = 'fb908934-26eb-4419-9e30-8adcd4ed356b';
const BOOT = 'boot-receipt';
const TIMEOUT = 15_000;
const INPUT = { command: 'rm -rf "$TMPDIR/receipt"', description: 'Remove temp dir' };
const ALLOW = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };

const dirs: string[] = [];
const children = new Set<ChildProcess>();
const sockets: ConsentSocket[] = [];

afterEach(async () => {
  for (const child of children) {
    child.kill('SIGCONT');
    child.kill('SIGKILL');
  }
  for (const socket of sockets.splice(0)) await socket.close();
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface Scene {
  readonly dir: string;
  readonly project: string;
  readonly registry: ConsentRegistry;
  readonly cycle: ConsentCycle;
}

/**
 * A data directory with roots, `alive.json` in mode `main` and the registration socket. `claims: false` = a socket
 * without `/claim`, as a server from before the receipt.
 */
async function scene(options: { claims?: boolean } = {}): Promise<Scene> {
  const dir = mkdtempSync(join(tmpdir(), 'rarog-hook-receipt-'));
  dirs.push(dir);
  const project = join(dir, 'roots', 'Projects', 'demo');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(dir, 'roots.json'), JSON.stringify({ roots: [join(dir, 'roots', 'Projects')] }));
  const registry = createConsentRegistry({ bootId: BOOT, send: () => true, sessions: () => [SESSION], log: () => {} });
  registry.setScope('main');
  const cycle = standingWithRead(createConsentCycle({ dataDir: dir, bootId: BOOT, registry, mode: () => 'main' }));
  const claims = createConsentClaims({
    registry, confirm: (sessionId, key, at, inputSha256) => cycle.confirmReceipt(sessionId, key, at, inputSha256),
  });
  const handler = options.claims === false ? createConsentHandler(registry) : createConsentHandler(registry, claims);
  const socket = await startConsentSocket(dir, handler, () => {});
  if (socket === null) throw new Error('registration socket did not start');
  sockets.push(socket);
  writeFileSync(join(dir, HOOK_ALIVE_FILENAME), JSON.stringify({
    ts: Date.now(), bootId: BOOT, mode: 'main', send: true, sessions: [SESSION],
  }));
  return { dir, project, registry, cycle };
}

interface Outcome {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}
interface Run {
  readonly child: ChildProcess;
  readonly done: Promise<Outcome>;
}

function startHook(s: Scene): Run {
  const env = { PATH: process.env['PATH'] ?? '', HOME: s.dir, RAROG_DATA_DIR: s.dir };
  const child = spawn(process.execPath, [HOOK], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  const done = new Promise<Outcome>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      children.delete(child);
      resolve({ code, stdout, stderr });
    });
  });
  child.stdin?.end(JSON.stringify({
    session_id: SESSION, cwd: s.project, prompt_id: PROMPT, permission_mode: 'default',
    hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: INPUT,
  }));
  return { child, done };
}

async function until<T>(probe: () => T | null | undefined, what: string, ms = 5_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function readLog(s: Scene): HookShadowLogEntry[] {
  const file = join(s.dir, HOOK_SHADOW_LOG_FILENAME);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((line) => line !== '')
    .map((line) => JSON.parse(line) as HookShadowLogEntry);
}

const exitOf = (s: Scene): HookShadowLogEntry | undefined => readLog(s).find((line) => line.ev === 'wyjscie');

/** The hook waits for its answer: the card from its own dump has the approve button. Returns the key. */
async function cardUp(s: Scene): Promise<string> {
  await until(() => readLog(s).find((line) => line.ev === 'czekam'), 'the hook waiting');
  const dump = await until(() => readCallDumps(s.dir, SESSION)[0], 'the per-call dump');
  expect(await s.cycle.observe(SESSION, dump.key, 'standing', dump)).toMatchObject({ canAllow: true });
  return dump.key;
}

const answer = (s: Scene, key: string, suffix = '.json'): string => join(s.dir, CONSENT_DIRNAME, SESSION, `${key}${suffix}`);

describe('hook: `allow` only after the server confirms receipt (W-a)', () => {
  it('allow from the phone: the hook takes the file, the receipt is confirmed, stdout `allow`; the record is'
    + ' `claimed` with the receipt', async () => {
    const s = await scene();
    const run = startHook(s);
    const key = await cardUp(s);
    expect(await s.cycle.decide(SESSION, key, 'allow')).toEqual({ ok: true, state: 'sent' });
    const outcome = await run.done;
    expect(outcome).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(outcome.stdout)).toEqual(ALLOW);
    expect(exitOf(s)).toMatchObject({ powod: 'odbior' });
    const record = s.cycle.record(SESSION, key);
    expect(record).toMatchObject({ state: 'claimed', receipt: { decisionAt: record?.decisionAt } });
  }, TIMEOUT);

  it.each([
    ['a copy of the `allow` file from before the revocation, written back after it', 'copy'],
    ['the `.revoked` file renamed back to `.json`', 'restore'],
  ] as const)('%s: the hook takes the signed `allow`, the server refuses the receipt, no `allow`', async (_name, how) => {
    const s = await scene();
    const run = startHook(s);
    const key = await cardUp(s);
    run.child.kill('SIGSTOP');
    expect(await s.cycle.decide(SESSION, key, 'allow')).toEqual({ ok: true, state: 'sent' });
    const copy = join(s.dir, 'allow-copy.json');
    copyFileSync(answer(s, key), copy);
    await s.cycle.off();
    expect(s.cycle.record(SESSION, key)).toMatchObject({ state: 'revoked', cause: 'off', decision: 'allow' });
    expect(existsSync(answer(s, key))).toBe(false);
    if (how === 'copy') renameSync(copy, answer(s, key));
    else renameSync(answer(s, key, '.revoked'), answer(s, key));
    run.child.kill('SIGCONT');

    const outcome = await run.done;
    expect(outcome).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(readLog(s).find((line) => line.ev === 'odbior')).toMatchObject({ decyzja: 'allow' });
    expect(exitOf(s)).toMatchObject({ powod: 'potwierdzenie', szczegol: '409' });
    expect(existsSync(answer(s, key, '.claimed'))).toBe(true);
    expect(s.cycle.record(SESSION, key)).toMatchObject({ state: 'revoked' });
    expect(s.cycle.record(SESSION, key)).not.toHaveProperty('receipt');
  }, TIMEOUT);

  it('race with `release` won by `release`: the allow file is revoked before the hook polls, the hook takes'
    + ' `release` and stays silent', async () => {
    const s = await scene();
    const run = startHook(s);
    const key = await cardUp(s);
    run.child.kill('SIGSTOP');
    expect(await s.cycle.decide(SESSION, key, 'allow')).toEqual({ ok: true, state: 'sent' });
    expect(await s.cycle.release(SESSION, key)).toEqual({ ok: true, state: 'sent' });
    run.child.kill('SIGCONT');
    const outcome = await run.done;
    expect(outcome).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(exitOf(s)).toMatchObject({ powod: 'release' });
    await s.cycle.tick();
    expect(s.cycle.record(SESSION, key)).toMatchObject({ state: 'released', decision: 'release' });
  }, TIMEOUT);

  it('`deny` from the phone needs no receipt: plain `deny` with the text from the list', async () => {
    const s = await scene();
    const run = startHook(s);
    const key = await cardUp(s);
    expect(await s.cycle.decide(SESSION, key, 'deny')).toEqual({ ok: true, state: 'sent' });
    const outcome = await run.done;
    expect(JSON.parse(outcome.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: CONSENT_DENY_MESSAGE },
      },
    });
    expect(s.cycle.record(SESSION, key)).not.toHaveProperty('receipt');
  }, TIMEOUT);
});

describe('hook: a new hook with an old server (a socket without `/claim`)', () => {
  /** The registration of the waiting hook and its secret (the old server signs with it as it does today). */
  async function registered(s: Scene): Promise<{ readonly key: string; readonly secret: string }> {
    await until(() => readLog(s).find((line) => line.ev === 'czekam'), 'the hook waiting');
    const entry = await until(() => s.registry.entries()[0], 'the registration');
    const secret = s.registry.secretOf(SESSION, entry.key);
    if (secret === null) throw new Error('no secret');
    return { key: entry.key, secret };
  }

  function signed(s: Scene, key: string, secret: string, reasonId: 'allow' | 'phone-deny'): void {
    const entry = s.registry.entry(SESSION, key);
    if (entry === null) throw new Error('no registration');
    const file = signConsentFile(secret, {
      sessionId: SESSION, key, decision: reasonId === 'allow' ? 'allow' : 'deny', reasonId,
      inputSha256: entry.inputSha256, cardSha256: entry.cardSha256, at: Date.now(),
    });
    writeFileSync(answer(s, key), JSON.stringify(file));
  }

  it('signed `allow`: `/claim` answers 404, the hook exits without a decision (the dialog stays in the terminal)',
    async () => {
      const s = await scene({ claims: false });
      const run = startHook(s);
      const { key, secret } = await registered(s);
      mkdirSync(join(s.dir, CONSENT_DIRNAME, SESSION), { recursive: true });
      signed(s, key, secret, 'allow');
      const outcome = await run.done;
      expect(outcome).toEqual({ code: 0, stdout: '', stderr: '' });
      expect(exitOf(s)).toMatchObject({ powod: 'potwierdzenie', szczegol: '404' });
    }, TIMEOUT);

  it('signed `deny`: plain `deny` as today, without `/claim`', async () => {
    const s = await scene({ claims: false });
    const run = startHook(s);
    const { key, secret } = await registered(s);
    mkdirSync(join(s.dir, CONSENT_DIRNAME, SESSION), { recursive: true });
    signed(s, key, secret, 'phone-deny');
    const outcome = await run.done;
    expect(JSON.parse(outcome.stdout)).toMatchObject({ hookSpecificOutput: { decision: { behavior: 'deny' } } });
    expect(exitOf(s)).toMatchObject({ powod: 'odbior' });
  }, TIMEOUT);
});
