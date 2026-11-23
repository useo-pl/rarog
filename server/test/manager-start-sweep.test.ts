/**
 * Manager start and the cleanup of `.rarog-uploads`: `ready` (and so the server's `listen`) does not wait for
 * `sweepUploads`. The cleanup walks the project roots on disk; a read that hangs (a macOS privacy prompt nobody
 * answers) must not keep the port closed. A failed cleanup stays one log line.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HerdrAgent } from '../src/herdr/types.ts';
import { createManager } from '../src/sessions/manager.ts';
import type { HerdrManagerDeps } from '../src/sessions/manager.ts';
import { AtrapaDrivera, AtrapaNadzorcy } from './helpers/atrapa-sesji.ts';

const ROOT = '/Users/demo/Projects';
const KEY = 'w1:p1';

class Supervisor extends AtrapaNadzorcy {
  protected nowyDriver(key: string): AtrapaDrivera {
    return new AtrapaDrivera(key, { dziennik: this.log });
  }

  appear(agent: HerdrAgent): void {
    this.lifecycle.push({ type: 'appeared', agent });
  }
}

const agent: HerdrAgent = {
  key: KEY, paneId: KEY, tabId: 'w1:t1', agentSessionId: '4b7f0d2e-9c61-4a3b-8e15-2d9f6c0a7b31', engine: 'claude',
  termId: null, cwd: `${ROOT}/atlas`, status: 'idle', title: 'atlas', stateChangeSeq: 1, mode: 'auto', modeReadAt: 0,
  inScope: true, launchedByRarog: false, interactiveReady: true,
};

async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}

let dataDir = '';
const closers: (() => Promise<void>)[] = [];

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'rarog-manager-sweep-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of closers.splice(0)) await close();
  await rm(dataDir, { recursive: true, force: true });
});

async function build(sweepUploads: HerdrManagerDeps['sweepUploads']) {
  const supervisor = new Supervisor();
  const deps: HerdrManagerDeps = {
    sessionIdFor: (key) => `herdr-${key.replace(/[^a-z0-9]/gi, '-')}`,
    aliasFor: () => undefined,
    rememberAlias: () => undefined,
    assertSendable: (text) => ({ text: text.trim(), slash: null }),
    takeSendSlot: () => true,
    writeUploads: () => Promise.resolve([]),
    writeUploadFiles: () => Promise.resolve([]),
    sweepUploads,
  };
  const manager = await createManager({
    demo: false, dataDir, herdrSupervisor: supervisor, herdrDeps: deps, herdrRoots: [ROOT],
    now: () => Date.parse('2026-11-12T10:00:00.000Z'), gitStatus: null, gitWatcher: null,
    liveSessionsReader: () => Promise.resolve(null),
  });
  closers.push(async () => {
    await manager.dispose();
    supervisor.dispose();
  });
  return { manager, supervisor };
}

describe('manager start does not wait for the uploads cleanup', () => {
  it('a cleanup that never ends: ready settles and panes still appear', async () => {
    const calls: (readonly string[])[] = [];
    const { manager, supervisor } = await build((roots) => {
      calls.push(roots);
      return new Promise<void>(() => undefined);
    });
    let timer: NodeJS.Timeout | undefined;
    const outcome = await Promise.race([
      manager.ready.then(() => 'ready'),
      new Promise<string>((resolve) => { timer = setTimeout(() => { resolve('stuck'); }, 1000); }),
    ]);
    clearTimeout(timer);
    expect(outcome).toBe('ready');
    expect(calls).toEqual([[ROOT]]);

    supervisor.appear(agent);
    await flush();
    expect(manager.list().map((s) => s.paneId)).toEqual([KEY]);
  });

  it('a failed cleanup is one log line, start goes on', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { manager } = await build(() => Promise.reject(new Error('EACCES')));
    await manager.ready;
    await flush();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('herdr uploads sweep failed: EACCES'));
  });
});
