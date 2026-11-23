/**
 * The "always" option of a consent channel card through the manager and REST: the real cycle and registry
 * in `$TMPDIR`, the real manager and router on an ephemeral port, fakes of the herdr supervisor and driver.
 *
 * `allow-always` passes the same gates as `allow` before the cycle writes a file: a panel out of scope and the
 * read-only mode (`RAROG_HERDR_SEND=0`) refuse with 400, a card without the approve button with 409 `card-changed`.
 * A card that can be approved but has no "always" option answers 422 `allow-always`. The card on the wire carries the
 * updates with their destination (`PermissionRequest.always`).
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@rarog/shared';
import type { PermissionRequest } from '@rarog/shared';
import { loadConfig } from '../src/config.ts';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import type { HookCallDump } from '../src/herdr/dialogs/hook/contract.ts';
import { parseHookSuggestions } from '../src/herdr/dialogs/hook/suggestions.ts';
import { CONSENT_ALWAYS_VERSION } from '../src/herdr/dialogs/layer1/always.ts';
import { CONSENT_DIRNAME, CONSENT_SECRET_BYTES } from '../src/herdr/dialogs/layer1/contract.ts';
import type { ConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import { createConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import type { ConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import { consentCardSha256 } from '../src/herdr/dialogs/layer1/sign.ts';
import type { HerdrAgent } from '../src/herdr/types.ts';
import { createRouter } from '../src/router.ts';
import { createManager } from '../src/sessions/manager.ts';
import type { ConsentManagerChannel, HerdrManagerDeps, Manager } from '../src/sessions/manager.ts';
import { SseHub } from '../src/sse.ts';
import { AtrapaDrivera, AtrapaNadzorcy } from './helpers/atrapa-sesji.ts';
import { createCycleWithRead } from './helpers/dowod-z-odczytem.ts';
import { createTestDevice } from './helpers/urzadzenie.ts';

const PROJECT = '/Users/u/Projects/atlas';
const ENGINE = '33333333-3333-4333-8333-333333333333';
const PROMPT = '44444444-4444-4444-8444-444444444444';
const KEY = 'w9:p72';
const BOOT = 'boot-zawsze-1';
const ORIGIN = 'http://localhost:8930';
const RULES = [{
  type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'localSettings',
}];

class Supervisor extends AtrapaNadzorcy<AtrapaDrivera> {
  protected nowyDriver(key: string): AtrapaDrivera {
    const driver = new AtrapaDrivera(key, { ownsProcess: false });
    driver.queue.push({ type: 'agent-state', state: 'idle', seen: true });
    return driver;
  }

  appear(agent: HerdrAgent): void {
    this.lifecycle.push({ type: 'appeared', agent });
  }
}

function deps(): HerdrManagerDeps {
  return {
    sessionIdFor: (key: string) => `herdr-${key.replace(/[^a-z0-9]/gi, '-')}`,
    aliasFor: () => undefined, rememberAlias: () => {}, assertSendable: (text) => ({ text: text.trim(), slash: null }),
    takeSendSlot: () => true, writeUploads: async () => [], writeUploadFiles: async () => [],
    sweepUploads: async () => undefined,
  };
}

async function flush(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise<void>((resolve) => { setImmediate(resolve); });
}

interface Harness {
  readonly manager: Manager;
  readonly cycle: ConsentCycle;
  readonly reg: ConsentRegistry;
  readonly id: string;
  decide(permId: string, decision: string): Promise<{ status: number; body: unknown }>;
}

describe('"always" on a consent channel card through REST', () => {
  const closers: (() => Promise<void>)[] = [];
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rarog-zawsze-rest-'));
  });

  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
    await rm(dir, { recursive: true, force: true });
  });

  async function start(options: { inScope?: boolean; herdrSend?: boolean } = {}): Promise<Harness> {
    const reg = createConsentRegistry({ bootId: BOOT, send: () => true, sessions: () => [ENGINE], log: () => {} });
    reg.setScope('main');
    let managerRef: Manager | null = null;
    const cycle = createCycleWithRead({
      dataDir: dir, bootId: BOOT, registry: reg, always: true,
      onCard: (view) => { managerRef?.applyConsentCard?.(view, cycle.record(view.sessionId, view.permId)?.decision ?? null); },
    });
    const consent: ConsentManagerChannel = {
      cards: (engine) => cycle.cards(engine),
      decide: (engine, permId, decision) => cycle.decide(engine, permId, decision),
      release: (engine, permId) => cycle.release(engine, permId),
      revoke: (engine, cause) => cycle.revokeSession(engine, cause),
      retire: async (engine, permId) => { await cycle.retire(engine, permId); },
      turnEnded: async () => {},
      reattached: async () => {},
      ended: (engine) => { cycle.endPool(engine); },
    };
    const supervisor = new Supervisor();
    const manager = await createManager({
      demo: false, dataDir: dir, projects: [{ path: PROJECT, name: 'atlas' }], projectRoots: [], gitStatus: null,
      maxPanes: 6, herdrSupervisor: supervisor, herdrDeps: deps(), herdrRoots: [PROJECT],
      herdrSend: options.herdrSend ?? true, consent, logger: () => {},
    });
    await manager.ready;
    managerRef = manager;
    supervisor.appear({
      key: KEY, paneId: KEY, agentSessionId: ENGINE, engine: 'claude', termId: null, cwd: PROJECT, status: 'idle',
      title: 'zawsze', stateChangeSeq: 1, mode: 'auto', modeReadAt: 0, inScope: options.inScope ?? true, tabId: 'w9:t3',
      launchedByRarog: false, interactiveReady: true,
    });
    await flush();
    const id = manager.list().find((s) => s.paneId !== undefined)?.id ?? '';
    expect(id).not.toBe('');
    const config = loadConfig({ RAROG_DEMO: '1', RAROG_DATA_DIR: join(dir, 'router') });
    const device = createTestDevice(config.dataDir, { epoch: config.epoch });
    const hub = new SseHub({ manager, serverStartId: 'start-1', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0 });
    hub.start();
    const server = http.createServer(createRouter({
      config, manager, hub, serverStartId: 'start-1', startedAtMs: Date.now() - 5_000,
      logger: { info: () => {}, error: () => {} }, devices: device.identity,
    }));
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve(); }); });
    const { port } = server.address() as AddressInfo;
    closers.push(async () => {
      hub.closeAll();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
      await manager.dispose();
      supervisor.dispose();
    });
    const decide = async (permId: string, decision: string): Promise<{ status: number; body: unknown }> => {
      const res = await fetch(`http://127.0.0.1:${String(port)}/api/sessions/${id}/permissions/${encodeURIComponent(permId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: device.authorization, Origin: ORIGIN },
        body: JSON.stringify({ decision }),
      });
      return { status: res.status, body: await res.json() as unknown };
    };
    return { manager, cycle, reg, id, decide };
  }

  /** A card of `toolInput` with the suggestions {@link RULES} from a hook that knows "always". */
  async function card(h: Harness, seed: string, toolInput: unknown = { command: 'npm test' }): Promise<HookCallDump> {
    const nonce = createHash('sha256').update(seed).digest('hex').slice(0, 32);
    const startedAt = Date.now() - 1_000;
    const suggestions = parseHookSuggestions(RULES);
    const dump: HookCallDump = {
      key: `${PROMPT}-${nonce}`, sessionId: ENGINE, promptId: PROMPT, pid: process.pid, startedAt, toolName: 'Bash',
      toolInput, cwd: PROJECT, at: startedAt + 100, inputSha256: canonicalSha256({ command: 'npm test' }),
      permissionMode: 'default', ...(suggestions === undefined ? {} : { permissionSuggestions: suggestions }),
    };
    const cardSha256 = consentCardSha256({
      sessionId: ENGINE, toolName: 'Bash', toolInput, cwd: PROJECT, agentId: null, permissionMode: 'default',
    });
    expect(h.reg.register({
      key: dump.key, sessionId: ENGINE, promptId: PROMPT, secret: randomBytes(CONSENT_SECRET_BYTES).toString('hex'),
      inputSha256: dump.inputSha256, cardSha256, pid: dump.pid, startedAt, permissionSuggestions: RULES,
      alwaysVersion: CONSENT_ALWAYS_VERSION,
    }).status).toBe(200);
    await h.cycle.observe(ENGINE, dump.key, 'standing', dump);
    await flush();
    return dump;
  }

  const fileOf = (key: string): Record<string, unknown> | null => {
    const path = join(dir, CONSENT_DIRNAME, ENGINE, `${key}.json`);
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown> : null;
  };
  const wire = (h: Harness, permId: string): PermissionRequest | undefined =>
    h.manager.transcript(h.id).pendingPermissions.find((p) => p.permId === permId);

  it('a card with "always": the frame carries the updates, `allow-always` = 200 and a signed `allow-always`', async () => {
    const h = await start();
    const dump = await card(h, 'zawsze');
    expect(wire(h, dump.key)).toMatchObject({
      canAllow: true, always: [{ kind: 'rule', value: 'Bash(npm test)', destination: 'localSettings' }],
    });
    expect(await h.decide(dump.key, 'allow-always')).toMatchObject({ status: 200 });
    expect(fileOf(dump.key)).toMatchObject({
      decision: 'allow', reasonId: 'allow-always', permissionsSha256: canonicalSha256(RULES),
    });
  });

  it('`allow-always` on a truncated card = 409 `card-changed` without a file, as `allow`', async () => {
    const h = await start();
    const dump = await card(h, 'przyciety', { rarogTruncated: true, bytes: 2_000_000 });
    expect(wire(h, dump.key)).toMatchObject({ canAllow: false, unavailable: 'truncated' });
    for (const decision of ['allow', 'allow-always']) {
      expect(await h.decide(dump.key, decision), decision).toMatchObject({ status: 409, body: { error: 'card-changed' } });
    }
    expect(fileOf(dump.key)).toBeNull();
  });

  it.each([
    ['a panel out of scope', { inScope: false }],
    ['the read-only mode (`RAROG_HERDR_SEND=0`)', { herdrSend: false }],
  ])('`allow-always` on %s = 400 without a file, as `allow`', async (_name, options) => {
    const h = await start(options);
    const dump = await card(h, 'bramka');
    for (const decision of ['allow', 'allow-always']) {
      expect((await h.decide(dump.key, decision)).status, decision).toBe(400);
    }
    expect(fileOf(dump.key)).toBeNull();
  });
});
