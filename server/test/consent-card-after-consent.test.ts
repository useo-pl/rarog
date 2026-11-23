/**
 * Karta kanału zgód schodzi z urządzeń przy `running` (zasada 3).
 *
 * `running` = odpowiedź oddana hookowi, a dialog karty zniknął. Skutek w transkrypcie (`applied`) przychodzi dopiero
 * po końcu tury, więc karta czekająca na niego sterczała na telefonie przez całą turę. Teraz manager przy `running`
 * zdejmuje kartę ramką `permission-resolved` z decyzją rekordu (`by: hook`) i zapisuje zdjęcie portem `retire`, tak
 * jak przy końcu sesji. Rekord idzie dalej za dowodem (audyt), ale urządzenia nie dostają już nic.
 *
 * Prawdziwy cykl (`layer1/cycle.ts`) z prawdziwym rejestrem w katalogu z `$TMPDIR`, prawdziwy manager, atrapy
 * nadzorcy i drivera herdr (jak `layer1-driver-cards.test.ts`). Decyzje idą przez manager (`resolve`),
 * bez routera.
 */
import { createHash, randomBytes } from 'node:crypto';
import { renameSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HerdrStatus, PermissionRequest, ServerEvent } from '@rarog/shared';
import { consentManagerCards } from '../src/bootstrap/consent.ts';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import type { HookCallDump } from '../src/herdr/dialogs/hook/contract.ts';
import { CONSENT_DIRNAME, CONSENT_SECRET_BYTES } from '../src/herdr/dialogs/layer1/contract.ts';
import { createConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import { retireRunningAfterRecover } from '../src/herdr/dialogs/layer1/frames.ts';
import type { ConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
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
const ENGINE = '33333333-3333-4333-8333-333333333333';
const PROMPT = '44444444-4444-4444-8444-444444444444';
const KEY = 'w9:p72';
const KEY_NEXT = 'w9:p80';
const BOOT = 'boot-po-zgodzie-1';

// ---------------------------------------------------------------------------
// Atrapy herdr
// ---------------------------------------------------------------------------

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

function makeAgent(key = KEY, tabId = 'w9:t3'): HerdrAgent {
  return {
    key, paneId: key, agentSessionId: ENGINE, engine: 'claude', termId: null, cwd: PROJECT, status: 'idle',
    title: 'po-zgodzie', stateChangeSeq: 1, mode: 'auto', modeReadAt: 0, inScope: true, tabId,
    launchedByRarog: false, interactiveReady: true,
  };
}

async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}

function dumpOf(seed: string, toolInput: unknown = { command: 'npm test' }, agentId?: string): HookCallDump {
  const nonce = createHash('sha256').update(seed).digest('hex').slice(0, 32);
  const startedAt = Date.now() - 1_000;
  return {
    key: `${PROMPT}-${nonce}`, sessionId: ENGINE, promptId: PROMPT, pid: process.pid, startedAt, toolName: 'Bash',
    toolInput, cwd: PROJECT, at: startedAt + 100, inputSha256: canonicalSha256(toolInput), permissionMode: 'default',
    ...(agentId === undefined ? {} : { agentId }),
  };
}

function register(reg: ConsentRegistry, dump: HookCallDump): void {
  const cardSha256 = consentCardSha256({
    sessionId: dump.sessionId, toolName: dump.toolName, toolInput: dump.toolInput, cwd: dump.cwd,
    agentId: dump.agentId ?? null, permissionMode: dump.permissionMode ?? null,
  });
  const outcome = reg.register({
    key: dump.key, sessionId: dump.sessionId, promptId: dump.promptId,
    secret: randomBytes(CONSENT_SECRET_BYTES).toString('hex'), inputSha256: dump.inputSha256, cardSha256,
    pid: dump.pid, startedAt: dump.startedAt, ...(dump.agentId === undefined ? {} : { agentId: dump.agentId }),
  });
  expect(outcome.status).toBe(200);
}

/** Koniec tury bez dowodów (jak port `turnEnded` w `index.ts` bez transkryptu): odebrane odpowiedzi = `unknown`. */
async function forcedTurnEnd(cycle: ConsentCycle): Promise<void> {
  for (const target of cycle.evidenceTargets()) {
    if (target.sessionId !== ENGINE) continue;
    await cycle.applyTurn(ENGINE, target.promptId, {
      promptId: target.promptId, ended: false, partial: true, toolUses: [], results: [],
    }, true);
  }
}

// ---------------------------------------------------------------------------

interface Harness {
  readonly dir: string;
  readonly manager: Manager;
  readonly driver: AtrapaDrivera;
  readonly supervisor: FakeSupervisor;
  readonly cycle: ConsentCycle;
  readonly reg: ConsentRegistry;
  readonly id: string;
  readonly events: ServerEvent[];
  /** Wywołania portu `retire` (`<sesja silnika>\n<permId>`), w kolejności. */
  readonly retires: string[];
  readonly logs: string[];
  /** `true` = zmiany kart z cyklu nie dochodzą do managera (jak `recover()` przed managerem w `index.ts`). */
  muted: boolean;
  close(): Promise<void>;
}

interface StartOptions {
  /** Odzyskanie rekordów z katalogu danych przed managerem (restart serwera, jak `index.ts`). */
  recover?: boolean;
  /** Port `retire` odrzuca (zapis pola zdjęcia padł). */
  retireError?: Error;
  /** Tryb efektywny kanału (zakres rejestru i tryb cyklu); domyślnie `main`. */
  mode?: 'main' | 'all';
}

describe('karta kanału zgód schodzi z urządzeń przy `running` (zasada 3)', () => {
  const closers: (() => Promise<void>)[] = [];
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rarog-po-zgodzie-'));
  });

  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
    await rm(dir, { recursive: true, force: true });
  });

  async function start(options: StartOptions = {}): Promise<Harness> {
    const reg = createConsentRegistry({ bootId: BOOT, send: () => true, sessions: () => [ENGINE], log: () => {} });
    const mode = options.mode ?? 'main';
    reg.setScope(mode);
    let managerRef: Manager | null = null;
    const gate = { muted: false };
    const retires: string[] = [];
    // W-d: krok `standing` bez odczytu dostaje odczyt dowodu bez terminu drogą produkcyjną (`helpers/dowod-z-odczytem.ts`).
    const cycle: ConsentCycle = standingWithRead(createConsentCycle({
      dataDir: dir, bootId: BOOT, registry: reg, mode: () => mode,
      onCard: (view) => {
        if (gate.muted) return;
        managerRef?.applyConsentCard?.(view, cycle.record(view.sessionId, view.permId)?.decision ?? null);
      },
    }));
    if (options.recover === true) {
      await cycle.recover();
      // Jak `index.ts`: zdjęcie odzyskanych kart `running` przed pierwszym przeglądem dowodów.
      await retireRunningAfterRecover(cycle, () => {});
    }
    // Port jak w `index.ts`: karta zdjęta niesie znacznik z rekordu cyklu.
    const consent: ConsentManagerChannel = {
      cards: (engine) => consentManagerCards(cycle, engine),
      decide: (engine, permId, decision) => cycle.decide(engine, permId, decision),
      release: (engine, permId) => cycle.release(engine, permId),
      revoke: (engine, cause) => cycle.revokeSession(engine, cause),
      retire: async (engine, permId) => {
        retires.push(`${engine}\n${permId}`);
        if (options.retireError !== undefined) throw options.retireError;
        await cycle.retire(engine, permId);
      },
      turnEnded: () => forcedTurnEnd(cycle),
      reattached: async (engines) => {
        await Promise.all(engines.map((engine) => cycle.markReattached(engine)));
      },
      ended: (engine) => { cycle.endPool(engine); },
    };
    const supervisor = new FakeSupervisor();
    const logs: string[] = [];
    const manager = await createManager({
      demo: false, dataDir: dir, projects: [{ path: PROJECT, name: 'atlas' }], projectRoots: [], gitStatus: null,
      maxPanes: 6, herdrSupervisor: supervisor, herdrDeps: makeDeps(), herdrRoots: [PROJECT],
      herdrSend: true, consent, logger: (line) => { logs.push(line); },
    });
    await manager.ready;
    managerRef = manager;
    const events: ServerEvent[] = [];
    manager.onEvent((_scope, _seq, event) => { events.push(event); });
    supervisor.appear(makeAgent());
    await flush();
    const id = manager.list().find((s) => s.paneId === KEY)?.id ?? '';
    expect(id).not.toBe('');
    const close = async (): Promise<void> => {
      await manager.dispose();
      supervisor.dispose();
    };
    closers.push(close);
    return {
      dir, manager, driver: supervisor.driver(KEY), supervisor, cycle, reg, id, events, retires, logs, close,
      get muted() { return gate.muted; },
      set muted(value: boolean) { gate.muted = value; },
    };
  }

  async function card(h: Harness, seed: string, agentId?: string): Promise<HookCallDump> {
    h.driver.queue.push({ type: 'agent-state', state: 'blocked' });
    await flush();
    const dump = dumpOf(seed, undefined, agentId);
    register(h.reg, dump);
    await h.cycle.observe(ENGINE, dump.key, 'standing', dump);
    await flush();
    return dump;
  }

  async function decide(h: Harness, dump: HookCallDump, decision: 'allow' | 'deny'): Promise<void> {
    expect(await h.manager.resolvePermission(h.id, dump.key, decision, 'iPad')).toMatchObject({ outcome: 'ok' });
    await flush();
    expect(h.cycle.record(ENGINE, dump.key)?.state).toBe('sent');
  }

  /** Hook przejmuje plik odpowiedzi (`rename` na `.claimed`): rekord `claimed`. */
  async function claim(h: Harness, dump: HookCallDump): Promise<void> {
    const base = join(h.dir, CONSENT_DIRNAME, ENGINE, dump.key);
    renameSync(`${base}.json`, `${base}.claimed`);
    await h.cycle.tick();
    await flush();
    expect(h.cycle.record(ENGINE, dump.key)?.state).toBe('claimed');
  }

  /** Dialog karty zniknął z panelu (zrzut `gone`): rekord `running`. */
  async function vanish(h: Harness, dump: HookCallDump): Promise<void> {
    await h.cycle.observe(ENGINE, dump.key, 'gone', dump);
    await flush();
    expect(h.cycle.record(ENGINE, dump.key)?.state).toBe('running');
  }

  async function toRunning(h: Harness, seed: string, decision: 'allow' | 'deny'): Promise<HookCallDump> {
    const dump = await card(h, seed);
    await decide(h, dump, decision);
    await claim(h, dump);
    await vanish(h, dump);
    return dump;
  }

  function channelCards(h: Harness, sessionId: string = h.id): PermissionRequest[] {
    return h.manager.transcript(sessionId).pendingPermissions.filter((p) => p.channel === 'hook');
  }

  function cardEvents(h: Harness, permId: string, sessionId?: string): ServerEvent[] {
    return h.events.filter((e) => {
      if (e.type === 'permission-pending') {
        return e.request.permId === permId && (sessionId === undefined || e.request.sessionId === sessionId);
      }
      return (e.type === 'permission-settled' || e.type === 'permission-resolved') && e.permId === permId
        && (sessionId === undefined || e.sessionId === sessionId);
    });
  }

  function resolvedOf(h: Harness, permId: string): ServerEvent[] {
    return h.events.filter((e) => e.type === 'permission-resolved' && e.permId === permId);
  }

  function retiredOnDisk(h: Harness, permId: string): unknown {
    return readConsentRecords(h.dir).find((r) => r.key === permId)?.retired;
  }

  it.each([
    { decision: 'allow' as const },
    { decision: 'deny' as const },
  ])('`pending` → `sent` → `claimed` → `running` ($decision): jeden `permission-resolved` z decyzją rekordu od hooka,'
    + ' karta znika z migawki, `retire` raz, pole zdjęcia na dysku', async ({ decision }) => {
    const h = await start();
    const dump = await toRunning(h, `running-${decision}`, decision);
    expect(resolvedOf(h, dump.key)).toEqual([{
      type: 'permission-resolved', sessionId: h.id, permId: dump.key, decision, by: 'hook',
    }]);
    expect(channelCards(h)).toEqual([]);
    expect(h.retires).toEqual([`${ENGINE}\n${dump.key}`]);
    expect(retiredOnDisk(h, dump.key)).toMatchObject({ at: expect.any(Number) as number });
    // Zdjęta karta: decyzja z urządzenia = 410 (`gone`), bez pliku.
    expect(await h.manager.resolvePermission(h.id, dump.key, 'release', 'iPad')).toMatchObject({ outcome: 'gone' });
    expect(h.driver.dziennik.of('respondPermission')).toEqual([]);
  });

  it.each([
    { decision: 'allow' as const },
    { decision: 'deny' as const },
  ])('karta prośby subagenta przy `all` ($decision): `claimed` → `running` zdejmuje ją tak samo, jeden'
    + ' `permission-resolved` od hooka, `retire` raz', async ({ decision }) => {
    const h = await start({ mode: 'all' });
    const dump = await card(h, `subagent-running-${decision}`, 'a0123456789abcdef');
    expect(channelCards(h).map((p) => p.permId)).toEqual([dump.key]);
    await decide(h, dump, decision);
    await claim(h, dump);
    await vanish(h, dump);
    expect(h.cycle.record(ENGINE, dump.key)).toMatchObject({ agentId: 'a0123456789abcdef', state: 'running' });
    expect(resolvedOf(h, dump.key)).toEqual([{
      type: 'permission-resolved', sessionId: h.id, permId: dump.key, decision, by: 'hook',
    }]);
    expect(channelCards(h)).toEqual([]);
    expect(h.retires).toEqual([`${ENGINE}\n${dump.key}`]);
    expect(retiredOnDisk(h, dump.key)).toMatchObject({ at: expect.any(Number) as number });
  });

  it('po zdjęciu przy `running`: wynik hooka bez potwierdzenia odbioru (`unknown`) nie wysyła nic,'
    + ' migawka bez karty', async () => {
    const h = await start();
    const dump = await toRunning(h, 'running-applied', 'allow');
    const before = cardEvents(h, dump.key).length;
    await h.cycle.applyTurn(ENGINE, PROMPT, {
      promptId: PROMPT, ended: true, partial: false,
      toolUses: [{ id: 'toolu_po_zgodzie', name: 'Bash', inputSha256: dump.inputSha256, line: 1 }],
      results: [{
        toolUseId: 'toolu_po_zgodzie', line: 2, at: Date.now(), decision: 'accept', source: 'hook', interrupted: false,
      }],
    });
    await flush();
    expect(h.cycle.record(ENGINE, dump.key)).toMatchObject({ state: 'unknown', cause: 'no-receipt' });
    expect(cardEvents(h, dump.key)).toHaveLength(before);
    expect(channelCards(h)).toEqual([]);
    expect(h.retires).toHaveLength(1);
  });

  it('po zdjęciu przy `running`: `unknown` (koniec tury bez skutku) nie wysyła nic, migawka bez karty', async () => {
    const h = await start();
    const dump = await toRunning(h, 'running-unknown', 'deny');
    const before = cardEvents(h, dump.key).length;
    await forcedTurnEnd(h.cycle);
    await flush();
    expect(h.cycle.record(ENGINE, dump.key)).toMatchObject({ state: 'unknown' });
    expect(cardEvents(h, dump.key)).toHaveLength(before);
    expect(channelCards(h)).toEqual([]);
  });

  it('karta pokazana tylko migawką, potem `running`: `permission-resolved` z decyzją rekordu', async () => {
    const h = await start();
    h.muted = true;
    const dump = await card(h, 'migawka-running');
    expect(channelCards(h).map((p) => p.permId)).toEqual([dump.key]);
    h.muted = false;
    await decide(h, dump, 'allow');
    await claim(h, dump);
    await vanish(h, dump);
    expect(h.events.filter((e) => e.type === 'permission-pending')).toEqual([]);
    expect(resolvedOf(h, dump.key)).toEqual([{
      type: 'permission-resolved', sessionId: h.id, permId: dump.key, decision: 'allow', by: 'hook',
    }]);
    expect(channelCards(h)).toEqual([]);
  });

  it('pierwszy widok karty w procesie w stanie `running` (zmiana z cyklu): nic na drucie, brak w migawce, zdjęcie'
    + ' zapisane', async () => {
    const h = await start();
    h.muted = true;
    const dump = await card(h, 'pierwszy-widok-running');
    expect(await h.manager.resolvePermission(h.id, dump.key, 'allow', 'iPad')).toMatchObject({ outcome: 'ok' });
    await flush();
    await claim(h, dump);
    h.muted = false;
    await vanish(h, dump);
    expect(cardEvents(h, dump.key)).toEqual([]);
    expect(channelCards(h)).toEqual([]);
    expect(h.retires).toEqual([`${ENGINE}\n${dump.key}`]);
    await forcedTurnEnd(h.cycle);
    await flush();
    expect(cardEvents(h, dump.key)).toEqual([]);
    expect(channelCards(h)).toEqual([]);
  });

  it('pierwszy widok karty w procesie w stanie `running` po `recover` (restart serwera): nic na drucie, brak'
    + ' w migawce, późniejsza zmiana rekordu też nie idzie', async () => {
    const h = await start();
    h.muted = true;
    const dump = await card(h, 'recover-running');
    expect(await h.manager.resolvePermission(h.id, dump.key, 'allow', 'iPad')).toMatchObject({ outcome: 'ok' });
    await flush();
    await claim(h, dump);
    await vanish(h, dump);
    expect(retiredOnDisk(h, dump.key)).toBeUndefined();
    await h.close();
    closers.splice(0);

    const t = await start({ recover: true });
    expect(t.cycle.record(ENGINE, dump.key)).toMatchObject({ state: 'running' });
    expect(channelCards(t)).toEqual([]);
    expect(cardEvents(t, dump.key)).toEqual([]);
    await flush();
    await forcedTurnEnd(t.cycle);
    await flush();
    expect(t.cycle.record(ENGINE, dump.key)).toMatchObject({ state: 'unknown' });
    expect(cardEvents(t, dump.key)).toEqual([]);
    expect(channelCards(t)).toEqual([]);
  });

  it('odzyskana karta `running` bez pola zdjęcia: koniec tury (`unknown`) przed pierwszą migawką nie przywraca'
    + ' karty', async () => {
    const h = await start();
    h.muted = true;
    const dump = await card(h, 'recover-unknown-first');
    expect(await h.manager.resolvePermission(h.id, dump.key, 'allow', 'iPad')).toMatchObject({ outcome: 'ok' });
    await flush();
    await claim(h, dump);
    await vanish(h, dump);
    expect(retiredOnDisk(h, dump.key)).toBeUndefined();
    await h.close();
    closers.splice(0);

    const t = await start({ recover: true });
    expect(retiredOnDisk(t, dump.key)).toMatchObject({ at: expect.any(Number) as number });
    await forcedTurnEnd(t.cycle);
    await flush();
    expect(t.cycle.record(ENGINE, dump.key)).toMatchObject({ state: 'unknown' });
    expect(cardEvents(t, dump.key)).toEqual([]);
    expect(channelCards(t)).toEqual([]);
  });

  it('karta zdjęta przy `running` (pole w rekordzie) nie wraca po restarcie: migawka pusta, decyzja 410, późny'
    + ' dowód nie idzie do urządzeń', async () => {
    const h = await start();
    const dump = await toRunning(h, 'restart-po-running', 'allow');
    expect(retiredOnDisk(h, dump.key)).toMatchObject({ at: expect.any(Number) as number });
    await h.close();
    closers.splice(0);

    const t = await start({ recover: true });
    expect(channelCards(t)).toEqual([]);
    expect(await t.manager.resolvePermission(t.id, dump.key, 'release', 'iPad')).toMatchObject({ outcome: 'gone' });
    await forcedTurnEnd(t.cycle);
    await flush();
    expect(cardEvents(t, dump.key)).toEqual([]);
    expect(channelCards(t)).toEqual([]);
    expect(t.retires).toEqual([]);
  });

  it('`claimed` → `unknown` bez `running`: `permission-settled` `unknown`, karta zostaje bez przycisków', async () => {
    const h = await start();
    const dump = await card(h, 'claimed-unknown');
    await decide(h, dump, 'allow');
    await claim(h, dump);
    await forcedTurnEnd(h.cycle);
    await flush();
    expect(h.cycle.record(ENGINE, dump.key)).toMatchObject({ state: 'unknown' });
    expect(h.events).toContainEqual(expect.objectContaining({
      type: 'permission-settled', permId: dump.key, state: 'unknown', canAllow: false,
    }));
    expect(resolvedOf(h, dump.key)).toEqual([]);
    expect(channelCards(h)).toEqual([expect.objectContaining({ permId: dump.key, state: 'unknown', canAllow: false })]);
    expect(h.retires).toEqual([]);
  });

  it('druga karta tej samej rozmowy (zmiana panelu) po zdjęciu przy `running` nie dostaje karty', async () => {
    const h = await start();
    const dump = await toRunning(h, 'zmiana-panelu', 'allow');
    h.supervisor.appear(makeAgent(KEY_NEXT, 'w9:t4'));
    await flush();
    const next = h.manager.list().find((s) => s.paneId === KEY_NEXT)?.id ?? '';
    expect(next).not.toBe('');
    expect(next).not.toBe(h.id);
    expect(channelCards(h, next)).toEqual([]);
    expect(channelCards(h)).toEqual([]);
    await forcedTurnEnd(h.cycle);
    await flush();
    expect(cardEvents(h, dump.key, next)).toEqual([]);
    expect(channelCards(h, next)).toEqual([]);
  });

  it('po zdjęciu karty kanału przy `running` następny dialog dostaje kartę z ekranu', async () => {
    const h = await start();
    const dump = await toRunning(h, 'running-potem-ekran', 'allow');
    h.driver.queue.push({ type: 'agent-state', state: 'blocked' });
    await flush();
    h.driver.queue.push({
      type: 'permission-request', reqId: 'tool-po-running', toolName: 'Bash', input: { command: 'ls' },
      displayText: 'ls',
    });
    await flush();
    expect(h.manager.transcript(h.id).pendingPermissions.map((p) => p.permId)).toEqual(['tool-po-running']);
    expect(resolvedOf(h, dump.key)).toHaveLength(1);
  });

  it('zapis pola zdjęcia pada (port `retire` odrzuca): karta i tak schodzi z urządzeń i nie wraca, błąd w logu',
    async () => {
      const h = await start({ retireError: new Error('pełny dysk') });
      const dump = await toRunning(h, 'retire-pada', 'allow');
      expect(resolvedOf(h, dump.key)).toHaveLength(1);
      expect(channelCards(h)).toEqual([]);
      expect(h.logs.some((line) => line.includes(dump.key) && line.includes('retire not saved'))).toBe(true);
      await forcedTurnEnd(h.cycle);
      await flush();
      expect(resolvedOf(h, dump.key)).toHaveLength(1);
      expect(cardEvents(h, dump.key).filter((e) => e.type === 'permission-settled' && e.state === 'unknown'))
        .toEqual([]);
      expect(channelCards(h)).toEqual([]);
    });
});
