/**
 * A hook that starts during a server restart waits for the consent channel (restart grace): the
 * `PermissionRequest` hook `scripts/hooks/rarog-pending.mjs` with `scripts/hooks/consent.mjs` as a child process
 * against a real registry and registration socket (`layer1/registry.ts`, `auth/consent-socket.ts`).
 *
 * The old server's stop leaves `alive.json` with `mode: "off"` and `stop: {ts, graceMs}`; the new server writes
 * `phase: "starting"` until its mode is resolved and a session is listed. A hook that starts on either does not take
 * the shadow path: it waits until `stop.ts + graceMs` (or the file's `ts` plus the default grace), then registers and
 * dumps once the new server opens the channel, and exits without a decision when no successor comes in time. `off`
 * without both fields (a kill switch, a server without the channel) keeps today's path. The break rules themselves
 * (`restartBreak`, `breakState`, `waitThroughRestart` on injected clocks) run through `consent.mjs` in this process.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createConsentHandler, startConsentSocket } from '../src/auth/consent-socket.ts';
import type { ConsentSocket } from '../src/auth/consent-socket.ts';
import { watchConsentMode } from '../src/bootstrap/consent.ts';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import {
  HOOK_ALIVE_PHASE_STARTING, HOOK_MARKERS_DIRNAME, HOOK_PENDING_DIRNAME, HOOK_POLL_MS, HOOK_RESTART_GRACE_DEFAULT_MS,
  HOOK_RESTART_GRACE_MAX_MS, HOOK_SHADOW_LOG_EVENTS, HOOK_SHADOW_REASONS,
} from '../src/herdr/dialogs/hook/contract.ts';
import type { HookShadowLogEntry } from '../src/herdr/dialogs/hook/contract.ts';
import { CONSENT_DIRNAME } from '../src/herdr/dialogs/layer1/contract.ts';
import { createConsentMode } from '../src/herdr/dialogs/layer1/mode.ts';
import { createConsentClaims } from '../src/herdr/dialogs/layer1/receipt.ts';
import { createConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import type {
  ConsentRegistry, ConsentRegistryEntry, ConsentRegistryScope, ConsentResumeExpect,
} from '../src/herdr/dialogs/layer1/registry.ts';
import { consentCardSha256, signConsentFile } from '../src/herdr/dialogs/layer1/sign.ts';
import { createAliveWriter } from '../src/herdr/dialogs/shadow/alive.ts';
import type { AliveWriter } from '../src/herdr/dialogs/shadow/alive.ts';
import {
  HOOK_SESSION, hookDataDir, hookExit, readHookLog, removeHookDirs, startHook, stopHookRuns, until, writeHookAlive,
} from './helpers/hook-kanal.ts';

const CONSENT = join(import.meta.dirname, '..', '..', 'scripts', 'hooks', 'consent.mjs');
const BOOT_OLD = 'boot-old';
const BOOT_NEW = 'boot-new';
const TIMEOUT = 15_000;
const INPUT = { command: 'ls "$TMPDIR/restart"', description: 'List temp dir' };
/** An exit after the break's end: one poll and room for the read and the log write. */
const BREAK_EXIT_MAX_MS = HOOK_POLL_MS + 250;

const sockets = new Set<ConsentSocket>();
const writers = new Set<AliveWriter>();

afterEach(async () => {
  await stopHookRuns();
  for (const writer of writers) writer.stop();
  writers.clear();
  for (const socket of sockets) await socket.close();
  sockets.clear();
});
afterAll(() => { removeHookDirs(); });

interface Server {
  readonly registry: ConsentRegistry;
  /** The sessions the server observes; the registry and `alive.json` take them from here. */
  readonly listed: string[];
  readonly stop: () => Promise<void>;
}

/**
 * A server process: its registry with `scope` and its registration socket on `dir` (`/claim` confirms receipts).
 * `restartGraceMs`: how long a key it expects ({@link expectFrom}) waits for the hook's second registration.
 */
async function startServer(dir: string, bootId: string, scope: ConsentRegistryScope, restartGraceMs = 0):
  Promise<Server> {
  const listed: string[] = [];
  const registry = createConsentRegistry({
    bootId, send: () => true, sessions: () => listed, log: () => {}, restartGraceMs,
  });
  registry.setScope(scope);
  const claims = createConsentClaims({ registry, confirm: () => Promise.resolve(true) });
  const socket = await startConsentSocket(dir, createConsentHandler(registry, claims), () => {});
  if (socket === null) throw new Error('registration socket did not start');
  sockets.add(socket);
  return {
    registry, listed,
    stop: async () => {
      sockets.delete(socket);
      await socket.close();
    },
  };
}

const callDumps = (dir: string): string[] => {
  const where = join(dir, HOOK_PENDING_DIRNAME, HOOK_SESSION);
  return existsSync(where) ? readdirSync(where).sort() : [];
};

const events = (dir: string): string[] => readHookLog(dir).map((line) => line.ev);

/** Request markers of the session (`markers/<session>/`), sorted. */
const markers = (dir: string): string[] => {
  const where = join(dir, HOOK_MARKERS_DIRNAME, HOOK_SESSION);
  return existsSync(where) ? readdirSync(where).sort() : [];
};

/** Lets the hook poll `alive.json` a few times. */
const polls = (n: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, n * HOOK_POLL_MS); });

/** A signed `allow` for the hook's request, as the server writes it after a tap on the phone. */
function writeAllow(dir: string, project: string, key: string, secret: string): void {
  const where = join(dir, CONSENT_DIRNAME, HOOK_SESSION);
  mkdirSync(where, { recursive: true });
  const file = join(where, `${key}.json`);
  const body = signConsentFile(secret, {
    sessionId: HOOK_SESSION, key, decision: 'allow', reasonId: 'allow', inputSha256: canonicalSha256(INPUT),
    cardSha256: consentCardSha256({
      sessionId: HOOK_SESSION, toolName: 'Bash', toolInput: INPUT, cwd: project, agentId: null,
      permissionMode: 'default',
    }),
    at: Date.now(),
  });
  writeFileSync(`${file}.tmp`, JSON.stringify(body));
  renameSync(`${file}.tmp`, file);
}

describe('hook started in a restart break: waits for the channel', () => {
  it.each([
    ['`off` + `stop` of the old server', 'stop'],
    ['`phase: "starting"` of the new server', 'phase'],
  ] as const)('starts at %s → new registry on the same socket path, `phase: starting`, then `all` with the session'
    + ' → registration, dump, `allow` on stdout', async (_name, start) => {
    const { dir, project } = hookDataDir();
    const old = await startServer(dir, BOOT_OLD, 'all');
    old.listed.push(HOOK_SESSION);
    await old.stop();
    writeHookAlive(dir, {
      bootId: BOOT_OLD, mode: 'off', sessions: [], stop: { ts: Date.now(), graceMs: 10_000 },
    });

    let server: Server | null = null;
    if (start === 'phase') {
      server = await startServer(dir, BOOT_NEW, 'closed');
      writeHookAlive(dir, { bootId: BOOT_NEW, mode: 'off', sessions: [], phase: HOOK_ALIVE_PHASE_STARTING });
    }
    const run = startHook(dir, project, { toolName: 'Bash', toolInput: INPUT });
    await until(() => readHookLog(dir).find((line) => line.ev === 'pauza'), 'the pause line');
    // The new process on the same path: first `off` while it starts, then its effective mode, still no sessions.
    server ??= await startServer(dir, BOOT_NEW, 'closed');
    writeHookAlive(dir, { bootId: BOOT_NEW, mode: 'off', sessions: [], phase: HOOK_ALIVE_PHASE_STARTING });
    await polls(3);
    server.registry.setScope('all');
    writeHookAlive(dir, { bootId: BOOT_NEW, mode: 'all', sessions: [], phase: HOOK_ALIVE_PHASE_STARTING });
    await polls(3);
    expect(server.registry.entries()).toEqual([]);
    expect(events(dir)).toEqual(['start', 'pauza']);
    expect(callDumps(dir)).toEqual([]);

    server.listed.push(HOOK_SESSION);
    writeHookAlive(dir, { bootId: BOOT_NEW, mode: 'all', sessions: [HOOK_SESSION], markers: true });
    const entry = await until(() => server.registry.entries()[0], 'the registration');
    await until(() => readHookLog(dir).find((line) => line.ev === 'czekam'), 'the czekam line');
    expect(callDumps(dir)).toEqual([`${entry.key}.json`]);
    // The request marker comes after the break, by the new server's `alive.json`.
    expect(markers(dir)).toEqual([`${entry.key}.json`]);
    expect(old.registry.entries()).toEqual([]);
    const secret = server.registry.secretOf(HOOK_SESSION, entry.key);
    if (secret === null) throw new Error('registry without the secret');

    writeAllow(dir, project, entry.key, secret);
    const outcome = await run.done;
    expect(outcome).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(outcome.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
    expect(events(dir)).toEqual(['start', 'pauza', 'czekam', 'odbior', 'wyjscie']);
    expect(readHookLog(dir).find((line) => line.ev === 'pauza'))
      .toMatchObject({ szczegol: start === 'stop' ? 'stop' : 'starting' });
    expect(readHookLog(dir).find((line) => line.ev === 'czekam')).toMatchObject({ bootId: BOOT_NEW, tryb: 'all' });
    expect(hookExit(dir)).toMatchObject({ powod: 'odbior', czekal: true });
  }, TIMEOUT);

  it('the new server lists the session before its channel mode is resolved → the hook stays paused, then registers'
    + ' once the mode opens the channel', async () => {
    const { dir, project } = hookDataDir();
    writeHookAlive(dir, { bootId: BOOT_OLD, mode: 'off', sessions: [], stop: { ts: Date.now(), graceMs: 10_000 } });
    const run = startHook(dir, project, { toolName: 'Bash', toolInput: INPUT });
    await until(() => readHookLog(dir).find((line) => line.ev === 'pauza'), 'the pause line');

    // The new process wired as `main()` in `server/src/index.ts` does: effective mode, `alive.json` writer, listener.
    const server = await startServer(dir, BOOT_NEW, 'closed');
    const consentMode = createConsentMode({ configured: 'all' });
    const writer = createAliveWriter({
      dataDir: dir, mode: () => consentMode.current().effective, send: () => true, bootId: BOOT_NEW,
      sessions: () => server.listed, markers: true, graceMs: 10_000,
      killswitch: () => consentMode.current().reason === 'killswitch',
      channelStarting: () => consentMode.current().reason === 'starting',
    });
    writers.add(writer);
    writer.start();
    const log = { info: () => {}, error: () => {} };
    watchConsentMode(consentMode, { consentRegistry: server.registry, consentCycle: null, aliveWriter: writer, log });
    server.listed.push(HOOK_SESSION);
    expect(writer.sessionsChanged()).toBe(true);
    await polls(3);
    expect(events(dir)).toEqual(['start', 'pauza']);
    expect(server.registry.entries()).toEqual([]);

    consentMode.resolve({ hook: () => 'ok', consentSocket: true, adminSocket: true, minClientBuild: 1 });
    const entry = await until(() => server.registry.entries()[0], 'the registration');
    await until(() => readHookLog(dir).find((line) => line.ev === 'czekam'), 'the czekam line');
    expect(callDumps(dir)).toEqual([`${entry.key}.json`]);
    expect(readHookLog(dir).find((line) => line.ev === 'czekam')).toMatchObject({ bootId: BOOT_NEW, tryb: 'all' });
    const secret = server.registry.secretOf(HOOK_SESSION, entry.key);
    if (secret === null) throw new Error('registry without the secret');
    writeAllow(dir, project, entry.key, secret);
    expect(JSON.parse((await run.done).stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
  }, TIMEOUT);

  it('`off` without `stop` and without `phase` → the shadow path as today: no pause, no registration', async () => {
    const { dir, project } = hookDataDir();
    const server = await startServer(dir, BOOT_NEW, 'all');
    server.listed.push(HOOK_SESSION);
    writeHookAlive(dir, { bootId: BOOT_NEW, mode: 'off', sessions: [HOOK_SESSION] });
    const run = startHook(dir, project, { toolName: 'Bash', toolInput: INPUT });
    const outcome = await run.done;
    expect(outcome).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(events(dir)).toEqual(['start', 'bez-czekania', 'wyjscie']);
    expect(hookExit(dir)).toMatchObject({ powod: 'tryb-off', czekal: false });
    expect(server.registry.entries()).toEqual([]);
  }, TIMEOUT);

  it('no successor until `stop.ts` + G → exit without a decision right after G, the per-session dump stays',
    async () => {
      const { dir, project } = hookDataDir();
      const graceMs = 1_500;
      const stopTs = Date.now();
      writeHookAlive(dir, { bootId: BOOT_OLD, mode: 'off', sessions: [], stop: { ts: stopTs, graceMs } });
      const run = startHook(dir, project, { toolName: 'Bash', toolInput: INPUT });
      const outcome = await run.done;
      expect(outcome).toMatchObject({ code: 0, stdout: '', stderr: '' });
      expect(events(dir)).toEqual(['start', 'pauza', 'bez-czekania', 'wyjscie']);
      const exit = hookExit(dir);
      expect(exit).toMatchObject({ powod: 'przerwa', czekal: false });
      expect(exit?.at ?? 0).toBeGreaterThanOrEqual(stopTs + graceMs);
      expect(exit?.at ?? Infinity).toBeLessThanOrEqual(stopTs + graceMs + BREAK_EXIT_MAX_MS);
      expect(existsSync(join(dir, HOOK_PENDING_DIRNAME, `${HOOK_SESSION}.json`))).toBe(true);
      expect(callDumps(dir)).toEqual([]);
      expect(markers(dir)).toEqual([]);
    }, TIMEOUT);

  it('a server that settles without the channel during the break (`rarog dialogs off`) → today\'s path at once',
    async () => {
      const { dir, project } = hookDataDir();
      writeHookAlive(dir, {
        bootId: BOOT_OLD, mode: 'off', sessions: [], stop: { ts: Date.now(), graceMs: 10_000 },
      });
      const run = startHook(dir, project, { toolName: 'Bash', toolInput: INPUT });
      await until(() => readHookLog(dir).find((line) => line.ev === 'pauza'), 'the pause line');
      const ts = writeHookAlive(dir, { bootId: BOOT_NEW, mode: 'off', sessions: [HOOK_SESSION] });
      const outcome = await run.done;
      expect(outcome).toMatchObject({ code: 0, stdout: '', stderr: '' });
      expect(events(dir)).toEqual(['start', 'pauza', 'bez-czekania', 'wyjscie']);
      const exit = hookExit(dir);
      expect(exit).toMatchObject({ powod: 'tryb-off' });
      expect((exit?.at ?? Infinity) - ts).toBeLessThanOrEqual(BREAK_EXIT_MAX_MS);
    }, TIMEOUT);

  it('the pause line and the reason of its end belong to the contract', () => {
    expect(HOOK_SHADOW_LOG_EVENTS).toContain('pauza');
    expect(HOOK_SHADOW_REASONS).toContain('przerwa');
  });
});

/**
 * What the next server's recovery expects of the hook's second registration: the old server's entry of the key
 * (`resume.ts` takes the same fields from the record); `over` makes the record expect another call.
 */
function expectFrom(server: Server, from: ConsentRegistryEntry, over: Partial<ConsentResumeExpect> = {}): void {
  server.registry.expectResume({
    key: from.key, sessionId: from.sessionId, promptId: from.promptId, agentId: from.agentId ?? null, pid: from.pid,
    startedAt: from.startedAt, inputSha256: from.inputSha256, cardSha256: from.cardSha256, ...over,
  });
}

/** The hook registered with the old server in mode `main` and waits: its registry entry and the old server. */
async function hookWaiting(dir: string, project: string): Promise<{
  readonly old: Server; readonly entry: ConsentRegistryEntry; readonly run: ReturnType<typeof startHook>;
}> {
  const old = await startServer(dir, BOOT_OLD, 'main');
  old.listed.push(HOOK_SESSION);
  writeHookAlive(dir, { bootId: BOOT_OLD, mode: 'main', sessions: [HOOK_SESSION] });
  const run = startHook(dir, project, { toolName: 'Bash', toolInput: INPUT });
  const entry = await until(() => old.registry.entries()[0], 'the registration');
  await until(() => readHookLog(dir).find((line) => line.ev === 'czekam'), 'the czekam line');
  return { old, entry, run };
}

/** The stop write of a server with the grace `graceMs` (mode `off`, no sessions, `stop`); returns `stop.ts`. */
function writeStop(dir: string, bootId: string, graceMs: number): number {
  const ts = Date.now();
  writeHookAlive(dir, { bootId, mode: 'off', sessions: [], stop: { ts, graceMs } });
  return ts;
}

/** The `n`-th line `ev` of `shadow.jsonl` (from 1), once it is there. */
const nthLine = (dir: string, ev: string, n: number): Promise<HookShadowLogEntry> =>
  until(() => readHookLog(dir).filter((line) => line.ev === ev)[n - 1], `${ev} line ${String(n)}`);

const ALLOW_OUT = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };

describe('hook waiting when the server stops: pauses, registers again, waits on only after `resumed`', () => {
  const G = 10_000;

  it('registry A → `off` + `stop` → `phase: starting` → 503 `channel-closed` → 503 `session-unknown` → registry B'
    + ' with the session → `resumed` → waits under the new `bootId` → `allow` on stdout; no file taken in the pause',
  async () => {
    const { dir, project } = hookDataDir();
    const { old, entry, run } = await hookWaiting(dir, project);
    const secret = old.registry.secretOf(HOOK_SESSION, entry.key);
    if (secret === null) throw new Error('registry without the secret');
    await old.stop();
    writeStop(dir, BOOT_OLD, G);
    await nthLine(dir, 'pauza', 1);
    // A decision the old server wrote before its stop: the hook takes nothing until it is resumed.
    writeAllow(dir, project, entry.key, secret);

    const next = await startServer(dir, BOOT_NEW, 'closed', G);
    expectFrom(next, entry);
    writeHookAlive(dir, { bootId: BOOT_NEW, mode: 'off', sessions: [], phase: HOOK_ALIVE_PHASE_STARTING });
    await polls(2);
    // `alive.json` already opens the channel, the registry does not yet: each refusal is tried again.
    writeHookAlive(dir, { bootId: BOOT_NEW, mode: 'main', sessions: [HOOK_SESSION] });
    await until(() => next.registry.stats().refused['channel-closed'] > 0 || null, '503 channel-closed');
    next.registry.setScope('main');
    await until(() => next.registry.stats().refused['session-unknown'] > 0 || null, '503 session-unknown');
    expect(existsSync(join(dir, CONSENT_DIRNAME, HOOK_SESSION, `${entry.key}.json`))).toBe(true);
    expect(events(dir)).toEqual(['start', 'czekam', 'pauza']);

    next.listed.push(HOOK_SESSION);
    const outcome = await run.done;
    expect(outcome).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(outcome.stdout)).toEqual(ALLOW_OUT);
    expect(next.registry.entry(HOOK_SESSION, entry.key)).toMatchObject({ resumed: true, blocked: false });
    expect(events(dir)).toEqual(['start', 'czekam', 'pauza', 'czekam', 'odbior', 'wyjscie']);
    expect(readHookLog(dir).filter((line) => line.ev === 'czekam')[1]).toMatchObject({ bootId: BOOT_NEW, tryb: 'main' });
    expect(readHookLog(dir).find((line) => line.ev === 'pauza')).toMatchObject({ bootId: BOOT_OLD, szczegol: 'stop' });
    expect(hookExit(dir)).toMatchObject({ powod: 'odbior', czekal: true });
  }, TIMEOUT);

  it('`accepted` under the old `bootId` (the old socket still answers) → ignored and tried again in the pause; the'
    + ' next server resumes it', async () => {
    const { dir, project } = hookDataDir();
    const { old, entry, run } = await hookWaiting(dir, project);
    writeStop(dir, BOOT_OLD, G);
    await nthLine(dir, 'pauza', 1);
    writeHookAlive(dir, { bootId: BOOT_NEW, mode: 'main', sessions: [HOOK_SESSION] });
    await until(() => old.registry.stats().repeated >= 2 || null, 'two repeats on the old socket');
    expect(events(dir)).toEqual(['start', 'czekam', 'pauza']);

    await old.stop();
    const next = await startServer(dir, BOOT_NEW, 'main', G);
    next.listed.push(HOOK_SESSION);
    expectFrom(next, entry);
    await nthLine(dir, 'czekam', 2);
    const secret = next.registry.secretOf(HOOK_SESSION, entry.key);
    if (secret === null) throw new Error('registry without the secret');
    writeAllow(dir, project, entry.key, secret);
    expect(JSON.parse((await run.done).stdout)).toEqual(ALLOW_OUT);
  }, TIMEOUT);

  it.each([
    ['409: the recovered record expects another call', 'blocked', '409'],
    ['`accepted` without `resumed`: no record waits for the key', 'first', 'accepted'],
  ] as const)('%s → exit without a decision', async (_name, server, szczegol) => {
    const { dir, project } = hookDataDir();
    const { old, entry, run } = await hookWaiting(dir, project);
    await old.stop();
    writeStop(dir, BOOT_OLD, G);
    await nthLine(dir, 'pauza', 1);
    const next = await startServer(dir, BOOT_NEW, 'main', G);
    next.listed.push(HOOK_SESSION);
    if (server === 'blocked') expectFrom(next, entry, { cardSha256: '0'.repeat(64) });
    writeHookAlive(dir, { bootId: BOOT_NEW, mode: 'main', sessions: [HOOK_SESSION] });
    const outcome = await run.done;
    expect(outcome).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(events(dir)).toEqual(['start', 'czekam', 'pauza', 'wyjscie']);
    expect(hookExit(dir)).toMatchObject({ powod: 'restart', szczegol, bootId: BOOT_NEW, czekal: true });
  }, TIMEOUT);

  it('a second restart inside the pause does not lengthen it: no channel until the first `stop.ts` + G → exit'
    + ' `przerwa` without a decision', async () => {
    const { dir, project } = hookDataDir();
    const graceMs = 2_000;
    const { old, run } = await hookWaiting(dir, project);
    await old.stop();
    const stopTs = writeStop(dir, BOOT_OLD, graceMs);
    await nthLine(dir, 'pauza', 1);
    writeHookAlive(dir, { bootId: BOOT_NEW, mode: 'off', sessions: [], phase: HOOK_ALIVE_PHASE_STARTING });
    await polls(2);
    const secondStop = writeStop(dir, BOOT_NEW, graceMs);
    const outcome = await run.done;
    expect(outcome).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(events(dir)).toEqual(['start', 'czekam', 'pauza', 'wyjscie']);
    const exit = hookExit(dir);
    expect(exit).toMatchObject({ powod: 'przerwa', czekal: true });
    expect(exit?.at ?? 0).toBeGreaterThanOrEqual(stopTs + graceMs);
    expect(exit?.at ?? Infinity).toBeLessThanOrEqual(stopTs + graceMs + BREAK_EXIT_MAX_MS);
    expect(exit?.at ?? Infinity).toBeLessThan(secondStop + graceMs);
  }, TIMEOUT);

  it('pauses of one wait last 2G together: two pauses resumed after ~0.7 G each, the third ends before its G',
    async () => {
      const { dir, project } = hookDataDir();
      const graceMs = 2_000;
      const { old, entry, run } = await hookWaiting(dir, project);
      let current = old;
      for (const [n, bootId] of [[1, 'boot-b'], [2, 'boot-c']] as const) {
        await current.stop();
        writeStop(dir, n === 1 ? BOOT_OLD : 'boot-b', graceMs);
        await nthLine(dir, 'pauza', n);
        await new Promise((resolve) => { setTimeout(resolve, 0.7 * graceMs); });
        current = await startServer(dir, bootId, 'main', graceMs);
        current.listed.push(HOOK_SESSION);
        expectFrom(current, entry);
        writeHookAlive(dir, { bootId, mode: 'main', sessions: [HOOK_SESSION] });
        await nthLine(dir, 'czekam', n + 1);
      }
      await current.stop();
      const lastStop = writeStop(dir, 'boot-c', graceMs);
      const outcome = await run.done;
      expect(outcome).toMatchObject({ code: 0, stdout: '', stderr: '' });
      expect(events(dir)).toEqual(['start', 'czekam', 'pauza', 'czekam', 'pauza', 'czekam', 'pauza', 'wyjscie']);
      const lines = readHookLog(dir);
      const at = (ev: string, n: number): number => lines.filter((line) => line.ev === ev)[n - 1]?.at ?? NaN;
      const exit = hookExit(dir);
      expect(exit).toMatchObject({ powod: 'przerwa', czekal: true });
      const paused = (at('czekam', 2) - at('pauza', 1)) + (at('czekam', 3) - at('pauza', 2))
        + ((exit?.at ?? NaN) - at('pauza', 3));
      expect(paused).toBeLessThanOrEqual(2 * graceMs + HOOK_POLL_MS);
      expect(exit?.at ?? Infinity).toBeLessThan(lastStop + graceMs - HOOK_POLL_MS);
    }, TIMEOUT);
});

/** The break rules of `consent.mjs` (a JS module without types). */
interface AliveRead {
  readonly veto: string | null;
  readonly seen?: { readonly bootId: string; readonly aliveTs: number };
  readonly restart?: { readonly stop?: unknown; readonly phase?: unknown };
  readonly alive?: {
    readonly bootId: string; readonly mode: string; readonly send: boolean; readonly sessions: readonly string[];
  };
}
interface BreakModule {
  readonly PHASE_STARTING: string;
  readonly RESTART_GRACE_DEFAULT_MS: number;
  readonly RESTART_GRACE_MAX_MS: number;
  restartBreak(read: AliveRead, now: number): { until: number; cause: string } | null;
  breakState(read: AliveRead, sessionId: string, channel: (alive: NonNullable<AliveRead['alive']>) => boolean): string;
  waitThroughRestart(options: {
    readonly first: AliveRead;
    readonly read: () => AliveRead;
    readonly sessionId: string;
    readonly channel: (alive: NonNullable<AliveRead['alive']>) => boolean;
    readonly pollMs: number;
    readonly now: () => number;
    readonly monotonic: () => number;
    readonly sleep: (ms: number) => Promise<void>;
  }): Promise<{ outcome: string }>;
  signFields(secret: string, fields: Record<string, unknown>): string;
  waitResuming(options: ResumeOptions): Promise<{ readonly outcome: string; readonly powod?: string }>;
}
/** `waitResuming` with every clock, read, registration and disk operation injected. */
interface ResumeOptions {
  readonly base: string;
  readonly expected: Readonly<Record<string, unknown>>;
  readonly pollMs: number;
  readonly deadline: number;
  readonly bootId: string;
  readonly sessionId: string;
  readonly read: () => AliveRead;
  readonly channel: (alive: NonNullable<AliveRead['alive']>) => boolean;
  readonly register: (deadlineMs?: number) => Promise<
    { readonly accepted: boolean; readonly bootId?: string; readonly resumed?: boolean; readonly detail?: string }>;
  readonly veto: (bootId: string, read?: AliveRead) => { readonly powod: string } | null;
  readonly onLine: (ev: string) => void;
  readonly onRejected: () => void;
  readonly io: { readonly rename: (from: string, to: string) => void; readonly readClaimed: () => string };
  readonly now: () => number;
  readonly monotonic: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}
const breakModule = async (): Promise<BreakModule> => (await import(pathToFileURL(CONSENT).href)) as BreakModule;

const NOW = 1_767_225_600_000;
/** A file read as `readAlive` in the hook gives it: valid shape, `ts` and the break fields. */
function read(ts: number, restart: AliveRead['restart'], alive: Partial<NonNullable<AliveRead['alive']>> = {},
  veto: string | null = null): AliveRead {
  return {
    veto, seen: { bootId: 'b', aliveTs: ts }, restart,
    ...(veto === null ? { alive: { bootId: 'b', mode: 'off', send: true, sessions: [], ...alive } } : {}),
  };
}

describe('`consent.mjs`: the restart break a hook sees at its start (`restartBreak`)', () => {
  const G = HOOK_RESTART_GRACE_DEFAULT_MS;
  it.each([
    ['no break fields', read(NOW, {}), null],
    ['`stop` 1 s ago', read(NOW - 1_000, { stop: { ts: NOW - 1_000, graceMs: 45_000 } }),
      { until: NOW + 44_000, cause: 'stop' }],
    ['`stop` on a stale file, still within G', read(NOW - 40_000, { stop: { ts: NOW - 40_000, graceMs: 45_000 } }, {},
      'alive-ts'), { until: NOW + 5_000, cause: 'stop' }],
    ['`stop` past G', read(NOW - 46_000, { stop: { ts: NOW - 46_000, graceMs: 45_000 } }), null],
    ['`stop` from a clock ahead: at most G from now', read(NOW, { stop: { ts: NOW + 60_000, graceMs: 45_000 } }),
      { until: NOW + 45_000, cause: 'stop' }],
    ['`stop` with `graceMs` 0', read(NOW, { stop: { ts: NOW, graceMs: 0 } }), null],
    ['`stop` with `graceMs` over the ceiling', read(NOW, { stop: { ts: NOW, graceMs: HOOK_RESTART_GRACE_MAX_MS + 1 } }),
      null],
    ['`stop` with `graceMs` at the ceiling', read(NOW, { stop: { ts: NOW, graceMs: HOOK_RESTART_GRACE_MAX_MS } }),
      { until: NOW + HOOK_RESTART_GRACE_MAX_MS, cause: 'stop' }],
    ['`stop` with a fraction', read(NOW, { stop: { ts: NOW, graceMs: 1.5 } }), null],
    ['`stop` without `ts`', read(NOW, { stop: { graceMs: 45_000 } }), null],
    ['`stop` not an object', read(NOW, { stop: 45_000 }), null],
    ['`phase: "starting"` 5 s ago: the default G from the file\'s `ts`', read(NOW - 5_000, { phase: 'starting' }),
      { until: NOW - 5_000 + G, cause: 'starting' }],
    ['`phase: "starting"` past the default G', read(NOW - G, { phase: 'starting' }), null],
    ['another phase', read(NOW, { phase: 'stopping' }), null],
    ['`stop` and `phase`: `stop` counts', read(NOW, { stop: { ts: NOW - 1_000, graceMs: 2_000 }, phase: 'starting' }),
      { until: NOW + 1_000, cause: 'stop' }],
    ['no file', { veto: 'alive-brak' }, null],
  ] as const)('%s', async (_name, file, expected) => {
    expect((await breakModule()).restartBreak(file, NOW)).toEqual(expected);
  });
});

describe('`consent.mjs`: `alive.json` during the break (`breakState`)', () => {
  const S = HOOK_SESSION;
  /** The hook's rule: `all` for every request, `main` only for the main thread. */
  const mainThread = (alive: { mode: string }): boolean => alive.mode === 'all' || alive.mode === 'main';
  const subagent = (alive: { mode: string }): boolean => alive.mode === 'all';
  it.each([
    ['no file', 'wait', { veto: 'alive-brak' }, mainThread],
    ['a bad file', 'wait', { veto: 'alive-zly' }, mainThread],
    ['the stale stop file', 'wait',
      read(NOW - 40_000, { stop: { ts: NOW - 40_000, graceMs: 45_000 } }, {}, 'alive-ts'), mainThread],
    ['`off` + `stop`', 'wait', read(NOW, { stop: { ts: NOW, graceMs: 45_000 } }), mainThread],
    ['`phase: "starting"` at `off`', 'wait', read(NOW, { phase: 'starting' }), mainThread],
    ['`phase: "starting"` at `all` without sessions', 'wait', read(NOW, { phase: 'starting' }, { mode: 'all' }),
      mainThread],
    ['`all` without this session', 'wait', read(NOW, {}, { mode: 'all', sessions: ['other'] }), mainThread],
    ['`all` with this session', 'open', read(NOW, {}, { mode: 'all', sessions: [S] }), mainThread],
    ['`main` with this session, main thread', 'open', read(NOW, {}, { mode: 'main', sessions: [S] }), mainThread],
    ['`main` with this session, subagent', 'settled', read(NOW, {}, { mode: 'main', sessions: [S] }), subagent],
    ['`off` without the break fields (kill switch)', 'settled', read(NOW, {}, { mode: 'off', sessions: [S] }),
      mainThread],
    ['`shadow`', 'settled', read(NOW, {}, { mode: 'shadow', sessions: [S] }), mainThread],
    ['`all` with `send: false`', 'settled', read(NOW, {}, { mode: 'all', send: false, sessions: [S] }), mainThread],
  ] as const)('%s → %s', async (_name, expected, file, channel) => {
    expect((await breakModule()).breakState(file, S, channel)).toBe(expected);
  });
});

describe('`consent.mjs`: the end of the break (`waitThroughRestart`)', () => {
  const G = 45_000;
  const STOP = { stop: { ts: NOW, graceMs: G } };
  const allMode = (alive: { mode: string }): boolean => alive.mode === 'all';

  /**
   * One wait from the stop file at `NOW` with G = 45 s, on injected clocks. `step(ms, clocks)` is what one sleep of
   * `ms` does to the wall and monotonic clocks; `channelAt` is the monotonic time from which `alive.json` says the
   * channel is open for the session (`Infinity`: the stop file stays). Returns the outcome and the monotonic time
   * spent.
   */
  async function wait(step: (ms: number, clocks: { wall: number; mono: number }) => void, channelAt = Infinity):
    Promise<{ outcome: string; spent: number }> {
    const clocks = { wall: NOW, mono: 0 };
    const { outcome } = await (await breakModule()).waitThroughRestart({
      first: read(NOW, STOP),
      read: () => (clocks.mono >= channelAt
        ? read(clocks.wall, {}, { mode: 'all', sessions: [HOOK_SESSION] }) : read(clocks.wall, STOP)),
      sessionId: HOOK_SESSION, channel: allMode, pollMs: HOOK_POLL_MS,
      now: () => clocks.wall, monotonic: () => clocks.mono,
      sleep: (ms) => {
        step(ms, clocks);
        return Promise.resolve();
      },
    });
    return { outcome, spent: clocks.mono };
  }

  it('a wall clock set back 60 s during the wait does not stretch it past G', async () => {
    let back = false;
    const result = await wait((ms, clocks) => {
      clocks.wall += ms;
      clocks.mono += ms;
      if (!back && clocks.mono >= 10_000) [back, clocks.wall] = [true, clocks.wall - 60_000];
    });
    expect(result).toEqual({ outcome: 'expired', spent: G });
  });

  it('the channel opens within G → `open`', async () => {
    const result = await wait((ms, clocks) => { [clocks.wall, clocks.mono] = [clocks.wall + ms, clocks.mono + ms]; },
      5_000);
    expect(result).toEqual({ outcome: 'open', spent: 5_000 });
  });

  it.each([
    ['a stalled process (both clocks run on)', 60_000],
    ['a system sleep (the monotonic clock stands)', 0],
  ] as const)('woken after the deadline by %s, the channel open → `expired`, never `open`', async (_n, monoAdd) => {
    const result = await wait((ms, clocks) => {
      [clocks.wall, clocks.mono] = [clocks.wall + ms + 60_000, clocks.mono + ms + monoAdd];
    }, 0);
    expect(result.outcome).toBe('expired');
  });
});

describe('`consent.mjs`: a registered hook through a restart (`waitResuming`, injected clocks)', () => {
  const G = 1_000;
  const KEY = 'k-resume';
  const DIGEST = 'a'.repeat(64);
  const SECRET = 'b'.repeat(64);
  const mainThread = (alive: { mode: string }): boolean => alive.mode === 'all' || alive.mode === 'main';
  /** The stop write of the server `bootId` at `ts`. */
  const stopped = (ts: number, bootId: string, graceMs = G): AliveRead => ({
    veto: null, seen: { bootId, aliveTs: ts }, restart: { stop: { ts, graceMs } },
    alive: { bootId, mode: 'off', send: true, sessions: [] },
  });
  /** The server `bootId` with the channel open for the session, no break fields. */
  const open = (ts: number, bootId: string): AliveRead => ({
    veto: null, seen: { bootId, aliveTs: ts }, restart: {},
    alive: { bootId, mode: 'main', send: true, sessions: [HOOK_SESSION] },
  });
  /** The hook's veto on one read (`consentVeto` in `rarog-pending.mjs`). */
  const vetoOf = (read: AliveRead, bootId: string): { powod: string } | null => {
    if (read.veto !== null) return { powod: read.veto };
    if (read.alive?.bootId !== bootId) return { powod: 'restart' };
    return mainThread(read.alive) && read.alive.sessions.includes(HOOK_SESSION) ? null : { powod: 'tryb-nizszy' };
  };

  interface Scene {
    /** `alive.json` at the hook's `n`th read (from 0) and monotonic time `mono`; the wall clock runs with it. */
    readonly file: (n: number, mono: number) => AliveRead;
    /** How long each registration of a pause takes; it does not end at the deadline it is given. */
    readonly registerMs: readonly number[];
    /** The monotonic time from which the old server's signed `allow` lies in the hook's directory. */
    readonly fileAt: number;
  }

  /** One wait registered under `A`; returns its result, the log events and each registration's deadline. */
  async function resume(scene: Scene): Promise<{ exit: { outcome: string; powod?: string }; lines: string[];
    deadlines: (number | undefined)[]; }> {
    const consent = await breakModule();
    const clocks = { wall: NOW, mono: 0 };
    const advance = (ms: number): void => { [clocks.wall, clocks.mono] = [clocks.wall + ms, clocks.mono + ms]; };
    let reads = 0;
    const read = (): AliveRead => scene.file(reads++, clocks.mono);
    const lines: string[] = [];
    const deadlines: (number | undefined)[] = [];
    const fields = {
      sessionId: HOOK_SESSION, key: KEY, decision: 'allow', reasonId: 'allow', inputSha256: DIGEST, cardSha256: DIGEST,
      at: NOW,
    };
    const body = JSON.stringify({ ...fields, mac: consent.signFields(SECRET, fields) });
    const exit = await consent.waitResuming({
      base: 'unused', pollMs: HOOK_POLL_MS, deadline: NOW + 60_000, bootId: 'A', sessionId: HOOK_SESSION,
      expected: {
        secret: SECRET, sessionId: HOOK_SESSION, key: KEY, inputSha256: DIGEST, cardSha256: DIGEST,
        notBefore: NOW - 60_000, permissionsSha256: null,
      },
      read, channel: mainThread,
      register: (deadlineMs) => {
        const answering = scene.file(reads, clocks.mono).alive?.bootId;
        advance(scene.registerMs[deadlines.length] ?? 0);
        deadlines.push(deadlineMs);
        return Promise.resolve({ accepted: true, bootId: answering, resumed: true });
      },
      // A veto without its read is a module that reads the file once more for it.
      veto: (bootId, snapshot) => vetoOf(snapshot ?? read(), bootId),
      onLine: (ev) => { lines.push(ev); },
      onRejected: () => {},
      io: {
        rename: () => { if (clocks.mono < scene.fileAt) throw new Error('ENOENT'); },
        readClaimed: () => body,
      },
      now: () => clocks.wall, monotonic: () => clocks.mono,
      sleep: (ms) => {
        advance(ms);
        return Promise.resolve();
      },
    });
    return { exit: { outcome: exit.outcome, ...(exit.powod === undefined ? {} : { powod: exit.powod }) }, lines,
      deadlines };
  }

  it('the read that vetoed opens the pause: the new server\'s file in the next read does not end the wait', async () => {
    const result = await resume({
      file: (n, mono) => (n === 0 ? stopped(NOW, 'A') : open(NOW + mono, 'B')), registerMs: [0], fileAt: 0,
    });
    expect(result.exit).toEqual({ outcome: 'claimed' });
    expect(result.lines).toEqual(['pauza', 'czekam']);
    expect(result.deadlines).toHaveLength(1);
  });

  it('`resumed` that comes past the end of the pause is not taken (`przerwa`)', async () => {
    // G = 1 s from the stop at 0, the channel opens at 750 ms, the registration takes 400 ms.
    const result = await resume({
      file: (_n, mono) => (mono < 750 ? stopped(NOW, 'A') : open(NOW + mono, 'B')), registerMs: [400], fileAt: 0,
    });
    expect(result.exit).toEqual({ outcome: 'veto', powod: 'przerwa' });
    expect(result.lines).toEqual(['pauza']);
    // The registration got only the time left of the pause.
    expect(result.deadlines).toEqual([G - 750]);
  });

  it('`resumed` that comes past the 2G of pauses is not taken (`przerwa`)', async () => {
    // Pause 1: 750 ms. The second stop has a 5 s grace, so only the 2G budget (1.25 s left) ends pause 2; its
    // registration starts at 750 ms of it and takes 600 ms.
    const result = await resume({
      file: (_n, mono) => {
        if (mono < 750) return stopped(NOW, 'A');
        if (mono < 1_000) return open(NOW + mono, 'B');
        if (mono < 1_750) return stopped(NOW + 1_000, 'B', 5_000);
        return open(NOW + mono, 'C');
      },
      registerMs: [0, 600], fileAt: 1_900,
    });
    expect(result.exit).toEqual({ outcome: 'veto', powod: 'przerwa' });
    expect(result.lines).toEqual(['pauza', 'czekam', 'pauza']);
    expect(result.deadlines).toEqual([G - 750, 2 * G - 750 - 750]);
  });
});

describe('`consent.mjs`: break names = the contract', () => {
  it('the phase, the default grace and its ceiling', async () => {
    const consent = await breakModule();
    expect(consent.PHASE_STARTING).toBe(HOOK_ALIVE_PHASE_STARTING);
    expect(consent.RESTART_GRACE_DEFAULT_MS).toBe(HOOK_RESTART_GRACE_DEFAULT_MS);
    expect(consent.RESTART_GRACE_MAX_MS).toBe(HOOK_RESTART_GRACE_MAX_MS);
  });
});
