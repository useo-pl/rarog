/**
 * Agent głosowy od strony managera: cel pytania (`companionTarget`: katalog sesji i bieżąca rozmowa silnika)
 * i słuchacz zmiany rozmowy (`onConversationChange`), po którym trasa zabija pytanie o poprzednią rozmowę.
 *
 * Granica jak w pozostałych testach managera: atrapa nadzorcy herdr i driver sterowany z testu (zero gniazda, zero
 * pliku), prawdziwy manager. Rozmowę silnika niesie zdarzenie `init` drivera, jak w produkcji po `/clear` i `/resume`.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HerdrAgent } from '../src/herdr/types.ts';
import { NotFoundError, createManager } from '../src/sessions/manager.ts';
import type { HerdrManagerDeps, Manager } from '../src/sessions/manager.ts';
import { AtrapaDrivera, AtrapaNadzorcy } from './helpers/atrapa-sesji.ts';

const ROOT = '/Users/demo/Projects';
const PROJECT = `${ROOT}/atlas`;
const KEY = 'w1:p1';
const CONV_A = '4b7f0d2e-9c61-4a3b-8e15-2d9f6c0a7b31';
const CONV_B = '7c1e2d3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';

class Nadzorca extends AtrapaNadzorcy {
  protected nowyDriver(key: string): AtrapaDrivera {
    return new AtrapaDrivera(key, { dziennik: this.log });
  }

  appear(agent: HerdrAgent): void {
    this.lifecycle.push({ type: 'appeared', agent });
  }
}

function agent(overrides: Partial<HerdrAgent> = {}): HerdrAgent {
  return {
    key: KEY, paneId: KEY, tabId: 'w1:t1', agentSessionId: CONV_A, engine: 'claude', termId: null, cwd: PROJECT,
    status: 'idle', title: 'atlas', stateChangeSeq: 1, mode: 'auto', modeReadAt: 0, inScope: true,
    launchedByRarog: false, interactiveReady: true, ...overrides,
  };
}

const idOf = (key: string): string => `herdr-${key.replace(/[^a-z0-9]/gi, '-')}`;

async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}

let dataDir = '';
const closers: (() => Promise<void>)[] = [];

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'rarog-manager-companion-'));
});

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  await rm(dataDir, { recursive: true, force: true });
});

async function withAgent(overrides: Partial<HerdrAgent> = {}): Promise<{
  manager: Manager; driver: AtrapaDrivera; id: string;
}> {
  const supervisor = new Nadzorca();
  const deps: HerdrManagerDeps = {
    sessionIdFor: idOf,
    aliasFor: () => undefined,
    rememberAlias: () => undefined,
    assertSendable: (text) => ({ text: text.trim(), slash: null }),
    takeSendSlot: () => true,
    writeUploads: () => Promise.resolve([]),
    writeUploadFiles: () => Promise.resolve([]),
    sweepUploads: () => Promise.resolve(),
  };
  const manager = await createManager({
    demo: false, dataDir, herdrSupervisor: supervisor, herdrDeps: deps, herdrRoots: [ROOT],
    now: () => Date.parse('2026-11-10T10:00:00.000Z'), gitStatus: null, gitWatcher: null,
    liveSessionsReader: () => Promise.resolve(null),
  });
  await manager.ready;
  closers.push(async () => {
    await manager.dispose();
    supervisor.dispose();
  });
  supervisor.appear(agent(overrides));
  await flush();
  return { manager, driver: supervisor.driver(KEY), id: idOf(KEY) };
}

describe('manager: cel pytania agenta głosowego', () => {
  it('katalog i bieżąca rozmowa; `/clear` powiadamia słuchacza, sam effort nie; odpięty słuchacz milczy', async () => {
    const { manager, driver, id } = await withAgent();
    driver.queue.push({ type: 'init', engineSessionId: CONV_A, model: 'claude-opus-5' });
    await flush();
    expect(manager.companionTarget(id)).toMatchObject({ cwd: PROJECT, agentSessionId: CONV_A });

    const heard: [string, string][] = [];
    const off = manager.onConversationChange((sessionId, agentSessionId) => { heard.push([sessionId, agentSessionId]); });
    driver.queue.push({ type: 'init', engineSessionId: CONV_A, model: 'claude-opus-5', effort: 'high' });
    await flush();
    expect(heard).toEqual([]);

    driver.queue.push({ type: 'init', engineSessionId: CONV_B, model: 'claude-opus-5' });
    await flush();
    expect(heard).toEqual([[id, CONV_B]]);
    expect(manager.companionTarget(id)).toMatchObject({ cwd: PROJECT, agentSessionId: CONV_B });

    off();
    driver.queue.push({ type: 'init', engineSessionId: CONV_A, model: 'claude-opus-5' });
    await flush();
    expect(heard).toHaveLength(1);
  });

  it('Codex i panel poza zasięgiem nie mają celu; nieznana sesja to NotFound', async () => {
    const codex = await withAgent({ engine: 'codex' });
    expect(codex.manager.companionTarget(codex.id)).toBeNull();
    const outside = await withAgent({ inScope: false, cwd: '/Users/demo/Prywatne/birch' });
    expect(outside.manager.companionTarget(outside.id)).toBeNull();
    expect(() => outside.manager.companionTarget('nie-ma')).toThrow(NotFoundError);
  });
});
