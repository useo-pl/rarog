/**
 * The `PermissionRequest` hook (`scripts/hooks/rarog-pending.mjs`) as a child process against the real consent
 * channel: registry, cycle, claims and the registration socket in a temporary data directory with roots and
 * `alive.json` in mode `main`. Shared by the hook package tests (input ceiling, `permission_suggestions`, versions).
 *
 * Call {@link stopHookRuns} in `afterEach` and {@link removeHookDirs} in `afterAll`.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConsentHandler, startConsentSocket } from '../../src/auth/consent-socket.ts';
import type { ConsentSocket } from '../../src/auth/consent-socket.ts';
import { HOOK_ALIVE_FILENAME, HOOK_SHADOW_LOG_FILENAME } from '../../src/herdr/dialogs/hook/contract.ts';
import type { HookShadowLogEntry } from '../../src/herdr/dialogs/hook/contract.ts';
import { createConsentCycle } from '../../src/herdr/dialogs/layer1/cycle.ts';
import type { ConsentCycle } from '../../src/herdr/dialogs/layer1/cycle.ts';
import { createConsentClaims } from '../../src/herdr/dialogs/layer1/receipt.ts';
import { createConsentRegistry } from '../../src/herdr/dialogs/layer1/registry.ts';
import type { ConsentRegistry } from '../../src/herdr/dialogs/layer1/registry.ts';
import { standingWithRead } from './dowod-z-odczytem.ts';

/** The hook from this checkout. */
export const HOOK_SCRIPT = join(import.meta.dirname, '..', '..', '..', 'scripts', 'hooks', 'rarog-pending.mjs');
export const HOOK_SESSION = '550e8400-e29b-41d4-a716-446655440000';
export const HOOK_PROMPT = 'fb908934-26eb-4419-9e30-8adcd4ed356b';
export const HOOK_BOOT = 'boot-hook-kanal';

const dirs: string[] = [];
const children = new Set<ChildProcess>();
const sockets: ConsentSocket[] = [];

export async function stopHookRuns(): Promise<void> {
  for (const child of children) {
    child.kill('SIGCONT');
    child.kill('SIGKILL');
  }
  for (const socket of sockets.splice(0)) await socket.close();
}

export function removeHookDirs(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export interface HookScene {
  readonly dir: string;
  readonly project: string;
  readonly registry: ConsentRegistry;
  readonly cycle: ConsentCycle;
}

/** A data directory with roots and a project in them; no `alive.json`, no socket. */
export function hookDataDir(): { readonly dir: string; readonly project: string } {
  const dir = mkdtempSync(join(tmpdir(), 'rarog-hook-kanal-'));
  dirs.push(dir);
  const project = join(dir, 'roots', 'Projects', 'demo');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(dir, 'roots.json'), JSON.stringify({ roots: [join(dir, 'roots', 'Projects')] }));
  return { dir, project };
}

/**
 * A data directory with roots, `alive.json` in mode `main` and the registration socket with `/claim`. `always`: the
 * cycle offers the "always" option (`RAROG_CONSENT_ALWAYS=on`). `mode: 'all'` opens the channel for subagents in the
 * registry, the cycle and `alive.json`; `log` takes the cycle's log lines.
 */
export async function hookScene(
  options: { always?: boolean; mode?: 'main' | 'all'; log?: (line: string) => void } = {},
): Promise<HookScene> {
  const { dir, project } = hookDataDir();
  const mode = options.mode ?? 'main';
  const registry = createConsentRegistry({
    bootId: HOOK_BOOT, send: () => true, sessions: () => [HOOK_SESSION], log: () => {},
  });
  registry.setScope(mode);
  const cycle = standingWithRead(createConsentCycle({
    dataDir: dir, bootId: HOOK_BOOT, registry, mode: () => mode, always: options.always === true,
    ...(options.log === undefined ? {} : { log: options.log }),
  }));
  const claims = createConsentClaims({
    registry, confirm: (sessionId, key, at, inputSha256) => cycle.confirmReceipt(sessionId, key, at, inputSha256),
  });
  const socket = await startConsentSocket(dir, createConsentHandler(registry, claims), () => {});
  if (socket === null) throw new Error('registration socket did not start');
  sockets.push(socket);
  writeHookAlive(dir, { mode });
  return { dir, project, registry, cycle };
}

/**
 * `alive.json` in mode `main` for {@link HOOK_SESSION}, as the server writes it (atomically: a hook may read it at any
 * moment); `over` replaces or adds fields. Returns its `ts`.
 */
export function writeHookAlive(dir: string, over: Readonly<Record<string, unknown>> = {}): number {
  const ts = Date.now();
  const file = join(dir, HOOK_ALIVE_FILENAME);
  writeFileSync(`${file}.tmp`, JSON.stringify({
    ts, bootId: HOOK_BOOT, mode: 'main', send: true, sessions: [HOOK_SESSION], ...over,
  }));
  renameSync(`${file}.tmp`, file);
  return ts;
}

export interface HookOutcome {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface HookRun {
  readonly child: ChildProcess;
  readonly done: Promise<HookOutcome>;
}

/** What the CLI sends on stdin; `extra` adds fields such as `permission_suggestions`. */
export interface HookRequest {
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly extra?: Readonly<Record<string, unknown>>;
}

/** Starts the hook (`script`, by default this checkout's) with a `PermissionRequest` of the main thread. */
export function startHook(dir: string, project: string, request: HookRequest, script = HOOK_SCRIPT): HookRun {
  const env = { PATH: process.env['PATH'] ?? '', HOME: dir, RAROG_DATA_DIR: dir };
  const child = spawn(process.execPath, [script], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child);
  const done = new Promise<HookOutcome>((resolve, reject) => {
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
    session_id: HOOK_SESSION, cwd: project, prompt_id: HOOK_PROMPT, permission_mode: 'default',
    hook_event_name: 'PermissionRequest', tool_name: request.toolName, tool_input: request.toolInput,
    ...request.extra,
  }));
  return { child, done };
}

export async function until<T>(probe: () => T | null | undefined, what: string, ms = 5_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The lines of `shadow.jsonl`. */
export function readHookLog(dir: string): HookShadowLogEntry[] {
  const file = join(dir, HOOK_SHADOW_LOG_FILENAME);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((line) => line !== '')
    .map((line) => JSON.parse(line) as HookShadowLogEntry);
}

export const hookExit = (dir: string): HookShadowLogEntry | undefined =>
  readHookLog(dir).find((line) => line.ev === 'wyjscie');
