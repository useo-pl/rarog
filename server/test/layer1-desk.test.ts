/**
 * Tryb `all` w cyklu kanału zgód i powrót prośby subagenta do biurka.
 *
 * Zdania, których pilnuje plik:
 *
 * - karta przy zakresie `all`: prośba subagenta nie ma powodu `terminal-only`; bez dowodu ma `no-proof`, a z dowodem
 *   „dialog stoi” przycisk zgody jak wątek główny (dowód z wierzchu pilnuje
 *   `layer1-subagent-top.test.ts`); odmowę i zwolnienie serwer podpisuje przy żywej rejestracji;
 * - rekord z `agentId` w `pending` bez dowodu przez {@link CONSENT_SUBAGENT_GRACE_MS} od rejestracji dostaje
 *   podpisane `release`; czas nie biegnie, gdy świeży rejestr mówi `waiting: permission`, także między rejestracją
 *   a pierwszym sprawdzeniem (odczyt starszy niż 5 s się nie liczy, a odczyt starszy niż najnowszy przyjęty nie
 *   otwiera wstrzymania drugi raz);
 * - rekord wątku głównego przy `all` nigdy go nie dostaje; wątek główny przy `all` ma te same wyniki co przy `main`;
 * - tylko `pending` (rekord w `deciding` albo `sent` z telefonu nie dostaje drugiego `release`);
 * - sygnał `gone` przy żywej rejestracji subagenta nie odwołuje rekordu, a rejestr `busy` go nie zdejmuje;
 * - bez sekretu (rejestracja odmówiona) serwer nie pisze `release`; błąd zapisu pliku = ponowienie przy
 *   następnej obserwacji i licznik `releaseFailed` w rekordzie, ten sam licznik przy zwolnieniu z urządzenia;
 * - `releaseCause: 'desk-fallback'` zostaje po odbiorze przez hook i po restarcie serwera;
 * - z pamięcią karty końcowej i zwolnieniem hooka: `gone` subagenta z żywą rejestracją nie pisze zwolnienia hooka,
 *   `endPool` zostawia kartę `pending` i `sent` z `release` (hook czeka), a karta `released` zwalnia treść w pamięci
 *   i schodzi z magazynu przy `endPool`;
 * - przy `main` prośba subagenta: rejestracja 503 `subagent`, karta `terminal-only`, bez `release`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import { HOOK_PENDING_DIRNAME } from '../src/herdr/dialogs/hook/contract.ts';
import type { HookCallDump } from '../src/herdr/dialogs/hook/contract.ts';
import { consentCardVerdict } from '../src/herdr/dialogs/layer1/card.ts';
import type { ConsentCardView } from '../src/herdr/dialogs/layer1/cards.ts';
import {
  CONSENT_DIRNAME, CONSENT_RELEASE_CAUSES, CONSENT_SECRET_BYTES, CONSENT_SUBAGENT_GRACE_MS,
} from '../src/herdr/dialogs/layer1/contract.ts';
import { createConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import type { ConsentCycle, ConsentCycleIo, ConsentCycleOptions } from '../src/herdr/dialogs/layer1/cycle.ts';
import type { ConsentEffectiveMode } from '../src/herdr/dialogs/layer1/mode.ts';
import { observeConsentSession } from '../src/herdr/dialogs/layer1/observe.ts';
import { readConsentRecords, writeConsentRecord } from '../src/herdr/dialogs/layer1/records.ts';
import { createConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import type { ConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import { consentCardSha256, verifyConsentFile } from '../src/herdr/dialogs/layer1/sign.ts';
import { writeAtomic } from '../src/herdr/dialogs/shadow/atomic.ts';
import { REGISTRY_MAX_AGE_MS } from '../src/herdr/dialogs/shadow/evidence.ts';
import type { RegistryEvidence } from '../src/herdr/dialogs/shadow/evidence.ts';
import type { ProcessLiveness } from '../src/herdr/dialogs/shadow/liveness.ts';
import { standingWithRead } from './helpers/dowod-z-odczytem.ts';

const SESSION = '00000000-0000-4000-9000-000000000001';
const BOOT = 'boot-biurko-1';
const NEXT_BOOT = 'boot-biurko-2';
const BASH = { command: 'npm test' };
type Tryb = Extract<ConsentEffectiveMode, 'main' | 'all'>;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rarog-biurko-'));
  dirs.push(dir);
  return dir;
}

let clock = Date.parse('2026-11-09T10:00:00.000Z');
const now = (): number => clock;

/** Zrzut per wywołanie (klucz z `seed`); `agentId` = prośba subagenta. */
function dumpOf(seed: string, over: Partial<HookCallDump> = {}): HookCallDump {
  const promptId = over.promptId ?? '00000000-0000-4000-9000-0000000000aa';
  const nonce = createHash('sha256').update(seed).digest('hex').slice(0, 32);
  const toolInput = over.toolInput ?? BASH;
  return {
    key: `${promptId}-${nonce}`, sessionId: SESSION, promptId, pid: process.pid, startedAt: clock - 1_000,
    toolName: 'Bash', toolInput, cwd: '/tmp/projekt', at: clock - 900, inputSha256: canonicalSha256(toolInput),
    permissionMode: 'default', ...over,
  };
}

function cardShaOf(dump: HookCallDump): string {
  return consentCardSha256({
    sessionId: dump.sessionId, toolName: dump.toolName, toolInput: dump.toolInput, cwd: dump.cwd,
    agentId: dump.agentId ?? null, permissionMode: dump.permissionMode ?? null,
  });
}

function registry(tryb: Tryb): ConsentRegistry {
  const reg = createConsentRegistry({ bootId: BOOT, send: () => true, sessions: () => [SESSION], log: () => {}, now });
  reg.setScope(tryb);
  return reg;
}

/** Ciało rejestracji hooka dla zrzutu z nowym sekretem. */
function registrationOf(dump: HookCallDump): Record<string, unknown> {
  return {
    key: dump.key, sessionId: dump.sessionId, promptId: dump.promptId,
    secret: randomBytes(CONSENT_SECRET_BYTES).toString('hex'), inputSha256: dump.inputSha256,
    cardSha256: cardShaOf(dump), pid: dump.pid, startedAt: dump.startedAt,
    ...(dump.agentId === undefined ? {} : { agentId: dump.agentId }),
  };
}

/** Rejestracja przyjęta; zwraca sekret. */
function register(reg: ConsentRegistry, dump: HookCallDump): string {
  const body = registrationOf(dump);
  expect(reg.register(body).status).toBe(200);
  return String(body['secret']);
}

interface Harness {
  readonly dir: string;
  readonly reg: ConsentRegistry;
  readonly cycle: ConsentCycle;
  readonly events: ConsentCardView[];
  readonly logs: string[];
}

function harness(tryb: Tryb, options: {
  dir?: string; reg?: ConsentRegistry; io?: Partial<ConsentCycleIo>; bootId?: string;
} = {}): Harness {
  const dir = options.dir ?? dataDir();
  const reg = options.reg ?? registry(tryb);
  const events: ConsentCardView[] = [];
  const logs: string[] = [];
  const cycleOptions: ConsentCycleOptions = {
    dataDir: dir, bootId: options.bootId ?? BOOT, registry: reg, now, mode: () => tryb,
    log: (line) => { logs.push(line); }, onCard: (view) => { events.push(view); },
    ...(options.io === undefined ? {} : { io: options.io }),
  };
  // Krok `standing` bez odczytu dostaje odczyt dowodu bez terminu drogą produkcyjną (`helpers/dowod-z-odczytem.ts`).
  return { dir, reg, cycle: standingWithRead(createConsentCycle(cycleOptions), now), events, logs };
}

const consentPath = (dir: string, key: string, suffix: string): string =>
  join(dir, CONSENT_DIRNAME, SESSION, `${key}${suffix}`);

/** Hook przejmuje plik odpowiedzi (`rename` na `.claimed`) i oddaje jego treść. */
function hookClaims(dir: string, key: string): unknown {
  const to = consentPath(dir, key, '.claimed');
  renameSync(consentPath(dir, key, '.json'), to);
  return JSON.parse(readFileSync(to, 'utf8')) as unknown;
}

const waitingPermission = (at: number): RegistryEvidence => ({ kind: 'waiting', dialog: 'permission', at });
const busy = (at: number): RegistryEvidence => ({ kind: 'active', at });

describe('karta przy zakresie `all`', () => {
  it('subagent bez `terminal-only`: z dowodem przycisk zgody, bez dowodu `no-proof`, odmowa przy żywej rejestracji;'
    + ' przy `main` `terminal-only`; wątek główny jak przy `main`', () => {
    clock = Date.parse('2026-11-09T10:00:00.000Z');
    const reg = registry('all');
    const sub = dumpOf('karta-sub', { agentId: 'agent-1' });
    register(reg, sub);
    const registration = reg.entry(SESSION, sub.key);
    expect(consentCardVerdict({ dump: sub, registration, signable: true, scope: 'all', standing: 'standing' }))
      .toMatchObject({ unavailable: null, canAllow: true, canSign: true });
    expect(consentCardVerdict({ dump: sub, registration, signable: true, scope: 'all', standing: 'unknown' }))
      .toMatchObject({ unavailable: 'no-proof', canAllow: false, canSign: true });
    for (const standing of ['standing', 'unknown'] as const) {
      expect(consentCardVerdict({ dump: sub, registration, signable: true, scope: 'main', standing }), standing)
        .toMatchObject({ unavailable: 'terminal-only', canAllow: false, canSign: false });
    }
    expect(consentCardVerdict({ dump: sub, registration, signable: true, scope: 'all', standing: 'dead' }))
      .toMatchObject({ unavailable: 'hook-dead', canAllow: false });
    expect(consentCardVerdict({ dump: sub, registration: null, signable: false, scope: 'all', standing: 'standing' }))
      .toMatchObject({ unavailable: 'no-channel', canAllow: false });

    const main = dumpOf('karta-main');
    register(reg, main);
    const mainEntry = reg.entry(SESSION, main.key);
    for (const standing of ['standing', 'unknown', 'dead'] as const) {
      expect(consentCardVerdict({ dump: main, registration: mainEntry, signable: true, scope: 'all', standing }), standing)
        .toEqual(consentCardVerdict({ dump: main, registration: mainEntry, signable: true, scope: 'main', standing }));
    }
  });
});

describe('prośba subagenta bez dowodu wraca do biurka podpisanym `release`', () => {
  it('przy `all`: rekord `pending`, karta `no-proof` (pole `buttonless`); po 10 s podpisane `release`, hook je'
    + ' przejmuje, rekord `released` z `releaseCause: desk-fallback`', async () => {
    const h = harness('all');
    const dump = dumpOf('d1-all', { agentId: 'agent-1' });
    const secret = register(h.reg, dump);
    const t0 = clock;
    const view = await h.cycle.observe(SESSION, dump.key, 'unknown', dump);
    expect(view).toMatchObject({
      state: 'pending', agentId: 'agent-1', canAllow: false, canDeny: true, canRelease: true, unavailable: 'no-proof',
    });
    expect(h.cycle.record(SESSION, dump.key)?.buttonless).toEqual({ reason: 'no-proof', at: t0 });
    // Zgoda z telefonu bez dowodu: odmowa, nic nie powstaje.
    expect(await h.cycle.decide(SESSION, dump.key, 'allow')).toEqual({ ok: false, error: 'card-changed', state: 'pending' });

    clock = t0 + CONSENT_SUBAGENT_GRACE_MS - 1;
    await h.cycle.tick();
    expect(h.cycle.record(SESSION, dump.key)?.state).toBe('pending');
    expect(existsSync(consentPath(h.dir, dump.key, '.json'))).toBe(false);

    clock = t0 + CONSENT_SUBAGENT_GRACE_MS;
    await h.cycle.tick();
    expect(h.cycle.record(SESSION, dump.key)).toMatchObject({
      state: 'sent', decision: 'release', reasonId: 'release', releaseCause: 'desk-fallback',
    });
    const file = hookClaims(h.dir, dump.key);
    expect(verifyConsentFile(file, {
      secret, sessionId: SESSION, key: dump.key, inputSha256: dump.inputSha256, cardSha256: cardShaOf(dump),
      notBefore: dump.startedAt - 60_000,
    })).toMatchObject({ ok: true, file: { decision: 'release', reasonId: 'release' } });
    await h.cycle.tick();
    expect(h.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'released', cause: null, releaseCause: 'desk-fallback' });
    expect(readConsentRecords(h.dir).find((r) => r.key === dump.key))
      .toMatchObject({ state: 'released', releaseCause: 'desk-fallback' });
    expect(h.cycle.card(SESSION, dump.key)?.state).toBe('released');
    expect(CONSENT_RELEASE_CAUSES).toContain('desk-fallback');
  });

  it('przy `main`: rejestracja subagenta 503 `subagent`, karta `terminal-only`, po 20 s bez `release`', async () => {
    const h = harness('main');
    const dump = dumpOf('d1-main', { agentId: 'agent-1' });
    expect(h.reg.register(registrationOf(dump))).toMatchObject({ status: 503, body: { error: 'subagent' } });
    const t0 = clock;
    expect(await h.cycle.observe(SESSION, dump.key, 'unknown', dump))
      .toMatchObject({ state: 'pending', unavailable: 'terminal-only', canAllow: false, canDeny: false });
    clock = t0 + 2 * CONSENT_SUBAGENT_GRACE_MS;
    await h.cycle.tick();
    await h.cycle.observe(SESSION, dump.key, 'unknown', dump);
    const record = h.cycle.record(SESSION, dump.key);
    expect(record).toMatchObject({ state: 'pending', decision: null });
    expect(record?.releaseCause).toBeUndefined();
    expect(record?.buttonless).toBeUndefined();
    expect(existsSync(consentPath(h.dir, dump.key, '.json'))).toBe(false);
  });

  it('przy `all` bez rejestracji (hook nie czeka na kanale) serwer nie pisze `release`', async () => {
    const h = harness('all');
    const dump = dumpOf('d6-bez-sekretu', { agentId: 'agent-1' });
    const t0 = clock;
    expect(await h.cycle.observe(SESSION, dump.key, 'unknown', dump)).toMatchObject({ unavailable: 'no-channel' });
    clock = t0 + 2 * CONSENT_SUBAGENT_GRACE_MS;
    await h.cycle.tick();
    expect(h.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'pending', decision: null });
    expect(existsSync(join(h.dir, CONSENT_DIRNAME))).toBe(false);
  });

  it('rejestr `waiting: permission` przez 20 s od rejestracji: czas karencji stoi, `release` dopiero 10 s po zmianie'
    + ' rejestru', async () => {
    const h = harness('all');
    const dump = dumpOf('d1-waiting', { agentId: 'agent-1' });
    register(h.reg, dump);
    const t0 = clock;
    await h.cycle.observe(SESSION, dump.key, 'unknown', dump);
    // Odczyt rejestru co sekundę (driver czyta co 1,5 s), takt cyklu po każdym.
    for (let t = 0; t < 20_000; t += 1_000) {
      clock = t0 + t;
      h.cycle.notePool(SESSION, [dump], waitingPermission(clock), clock);
      await h.cycle.tick();
    }
    expect(h.cycle.record(SESSION, dump.key)?.state).toBe('pending');
    let releasedAt: number | null = null;
    for (let t = 20_000; t <= 32_000; t += 500) {
      clock = t0 + t;
      h.cycle.notePool(SESSION, [dump], busy(clock), clock);
      await h.cycle.tick();
      if (releasedAt === null && h.cycle.record(SESSION, dump.key)?.state === 'sent') releasedAt = t;
    }
    expect(releasedAt).toBe(20_000 + CONSENT_SUBAGENT_GRACE_MS);
  });

  it('wstrzymanie między przyjęciem rejestracji a pierwszym sprawdzeniem też stoi: rejestracja w t=0, rejestr'
    + ' `waiting: permission` przez 20 s, pierwsza obserwacja w t=1 s → `release` w t=30 s', async () => {
    const h = harness('all');
    const dump = dumpOf('d1-przed-sprawdzeniem', { agentId: 'agent-1' });
    const t0 = clock;
    register(h.reg, dump);
    let releasedAt: number | null = null;
    for (let t = 0; t <= 32_000; t += 500) {
      clock = t0 + t;
      h.cycle.notePool(SESSION, [dump], t < 20_000 ? waitingPermission(clock) : busy(clock), clock);
      if (t === 1_000) await h.cycle.observe(SESSION, dump.key, 'unknown', dump);
      await h.cycle.tick();
      if (releasedAt === null && h.cycle.record(SESSION, dump.key)?.state === 'sent') releasedAt = t;
    }
    expect(releasedAt).toBe(20_000 + CONSENT_SUBAGENT_GRACE_MS);
  });

  it('odczyt `waiting` starszy niż najnowszy przyjęty (dostarczony po nowszym `busy`) nie otwiera wstrzymania'
    + ' drugi raz: wstrzymanie 0–1,5 s, `release` w t=11,5 s', async () => {
    const h = harness('all');
    const dump = dumpOf('d1-opozniony-odczyt', { agentId: 'agent-1' });
    register(h.reg, dump);
    const t0 = clock;
    await h.cycle.observe(SESSION, dump.key, 'unknown', dump);
    h.cycle.notePool(SESSION, [dump], waitingPermission(t0), t0);
    clock = t0 + 1_500;
    h.cycle.notePool(SESSION, [dump], busy(clock), clock);
    // Driver wziął rejestr z t=0 przed `await` odczytu ekranu, a obserwacja dostarcza go dopiero teraz.
    clock = t0 + 2_000;
    h.cycle.notePool(SESSION, [dump], waitingPermission(t0), clock);
    clock = t0 + 3_000;
    h.cycle.notePool(SESSION, [dump], busy(clock), clock);
    let releasedAt: number | null = null;
    for (let t = 3_000; t <= 16_000; t += 500) {
      clock = t0 + t;
      await h.cycle.tick();
      if (releasedAt === null && h.cycle.record(SESSION, dump.key)?.state === 'sent') releasedAt = t;
    }
    expect(releasedAt).toBe(1_500 + CONSENT_SUBAGENT_GRACE_MS);
  });

  it('rejestr `waiting: permission` starszy niż 5 s się nie liczy: czas karencji biegnie dalej', async () => {
    const h = harness('all');
    const dump = dumpOf('d1-stary-rejestr', { agentId: 'agent-1' });
    register(h.reg, dump);
    const t0 = clock;
    await h.cycle.observe(SESSION, dump.key, 'unknown', dump);
    h.cycle.notePool(SESSION, [dump], waitingPermission(t0), t0);
    let releasedAt: number | null = null;
    for (let t = 0; t <= 20_000; t += 500) {
      clock = t0 + t;
      await h.cycle.tick();
      if (releasedAt === null && h.cycle.record(SESSION, dump.key)?.state === 'sent') releasedAt = t;
    }
    // Jeden odczyt `waiting` wstrzymuje czas tylko na swoją świeżość.
    expect(releasedAt).toBe(REGISTRY_MAX_AGE_MS + CONSENT_SUBAGENT_GRACE_MS);
  });

  it('zrzut subagenta z żywym hookiem, rejestr `busy` przez 3 s (obserwacja sesji): rekord zostaje `pending`,'
    + ' bez `gone` i `revoked`; sygnał `gone` go nie odwołuje; potem `release` po terminie łaski subagenta', async () => {
    const h = harness('all');
    const dump = dumpOf('d5-busy', { agentId: 'agent-1' });
    register(h.reg, dump);
    const t0 = clock;
    mkdirSync(join(h.dir, HOOK_PENDING_DIRNAME, SESSION), { recursive: true });
    writeFileSync(join(h.dir, HOOK_PENDING_DIRNAME, SESSION, `${dump.key}.json`), JSON.stringify(dump));
    const liveness: ProcessLiveness = async (processes) => new Map(processes.map((p) => [p.pid, true]));
    const observeAt = async (at: number): Promise<void> => {
      clock = at;
      await observeConsentSession(h.cycle, {
        dataDir: h.dir, sessionId: SESSION, liveness, registry: busy(at), transcript: null, screen: null, now,
      });
    };
    for (let t = 0; t <= 3_000; t += 1_000) await observeAt(t0 + t);
    expect(h.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'pending', cause: null, decision: null });
    expect(h.cycle.card(SESSION, dump.key)).toMatchObject({ state: 'pending', unavailable: 'no-proof' });

    await h.cycle.observe(SESSION, dump.key, 'gone', dump);
    expect(h.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'pending', cause: null });

    await observeAt(t0 + CONSENT_SUBAGENT_GRACE_MS);
    expect(h.cycle.record(SESSION, dump.key)).toMatchObject({
      state: 'sent', decision: 'release', releaseCause: 'desk-fallback',
    });
  });

  it('`release` przyjęty przez hook, potem restart serwera: odczytany rekord niesie `releaseCause`', async () => {
    const h = harness('all');
    const claimedFirst = dumpOf('d7-po-tiku', { agentId: 'agent-1' });
    const claimedLate = dumpOf('d7-przed-tikiem', { agentId: 'agent-2' });
    register(h.reg, claimedFirst);
    register(h.reg, claimedLate);
    const t0 = clock;
    await h.cycle.observe(SESSION, claimedFirst.key, 'unknown', claimedFirst);
    await h.cycle.observe(SESSION, claimedLate.key, 'unknown', claimedLate);
    clock = t0 + CONSENT_SUBAGENT_GRACE_MS;
    await h.cycle.tick();
    hookClaims(h.dir, claimedFirst.key);
    await h.cycle.tick();
    expect(h.cycle.record(SESSION, claimedFirst.key)).toMatchObject({ state: 'released', releaseCause: 'desk-fallback' });
    // Drugi hook przejmuje plik, zanim serwer to zobaczy: odbiór rozlicza dopiero odzyskiwanie nowego procesu.
    hookClaims(h.dir, claimedLate.key);

    clock += 1_000;
    const next = harness('all', { dir: h.dir, bootId: NEXT_BOOT });
    await next.cycle.recover();
    for (const dump of [claimedFirst, claimedLate]) {
      expect(next.cycle.record(SESSION, dump.key), dump.key)
        .toMatchObject({ state: 'released', decision: 'release', releaseCause: 'desk-fallback' });
      expect(readConsentRecords(h.dir).find((r) => r.key === dump.key), dump.key)
        .toMatchObject({ state: 'released', releaseCause: 'desk-fallback' });
    }
  });

  it('zapis pliku `release` pada → rekord zostaje `pending` z licznikiem `releaseFailed`, ponowienie przy'
    + ' następnej obserwacji', async () => {
    let failures = 1;
    const writes: string[] = [];
    const io: Partial<ConsentCycleIo> = {
      writeFile: (dir, name, body, options) => {
        writes.push(name);
        if (failures > 0) {
          failures -= 1;
          throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
        }
        writeAtomic(dir, name, body, options);
      },
    };
    const h = harness('all', { io });
    const dump = dumpOf('d6-zapis', { agentId: 'agent-1' });
    register(h.reg, dump);
    const t0 = clock;
    await h.cycle.observe(SESSION, dump.key, 'unknown', dump);
    clock = t0 + CONSENT_SUBAGENT_GRACE_MS;
    await h.cycle.tick();
    expect(writes).toEqual([`${dump.key}.json`]);
    expect(h.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'pending', decision: null, releaseFailed: 1 });
    expect(h.cycle.record(SESSION, dump.key)?.releaseCause).toBeUndefined();
    expect(readConsentRecords(h.dir).find((r) => r.key === dump.key)).toMatchObject({ state: 'pending', releaseFailed: 1 });
    expect(existsSync(consentPath(h.dir, dump.key, '.json'))).toBe(false);
    expect(h.logs.some((line) => line.includes(`answer file ${dump.key} not written`))).toBe(true);

    clock += 500;
    await h.cycle.observe(SESSION, dump.key, 'unknown', dump);
    expect(writes).toEqual([`${dump.key}.json`, `${dump.key}.json`]);
    expect(h.cycle.record(SESSION, dump.key)).toMatchObject({
      state: 'sent', decision: 'release', releaseCause: 'desk-fallback', releaseFailed: 1,
    });
    expect(existsSync(consentPath(h.dir, dump.key, '.json'))).toBe(true);
  });

  it('zwolnienie z `pending` z urządzenia albo `rarog dialogs release`, którego zapis pada (plik `release`,'
    + ' potem rekord `deciding`) → `write-failed`, rekord `pending` z licznikiem `releaseFailed` na dysku; udane'
    + ' ponowienie licznik zachowuje', async () => {
    let fail: 'file' | 'record' | null = 'file';
    const enospc = (): Error => Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    const io: Partial<ConsentCycleIo> = {
      writeFile: (dir, name, body, options) => {
        if (fail === 'file') {
          fail = null;
          throw enospc();
        }
        writeAtomic(dir, name, body, options);
      },
      writeRecord: (dir, record, options) => {
        if (fail === 'record' && options.fsync) {
          fail = null;
          throw enospc();
        }
        writeConsentRecord(dir, record, options);
      },
    };
    const h = harness('main', { io });
    const dump = dumpOf('d6-zwolnienie');
    register(h.reg, dump);
    await h.cycle.observe(SESSION, dump.key, 'unknown', dump);
    const onDisk = (): unknown => readConsentRecords(h.dir).find((r) => r.key === dump.key);

    expect(await h.cycle.release(SESSION, dump.key)).toEqual({ ok: false, error: 'write-failed', state: 'pending' });
    expect(onDisk()).toMatchObject({ state: 'pending', decision: null, releaseFailed: 1 });
    expect(existsSync(consentPath(h.dir, dump.key, '.json'))).toBe(false);

    fail = 'record';
    expect(await h.cycle.release(SESSION, dump.key)).toEqual({ ok: false, error: 'write-failed', state: 'pending' });
    expect(onDisk()).toMatchObject({ state: 'pending', decision: null, releaseFailed: 2 });

    expect(await h.cycle.release(SESSION, dump.key)).toEqual({ ok: true, state: 'sent' });
    expect(h.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'sent', decision: 'release', releaseFailed: 2 });
    expect(h.cycle.record(SESSION, dump.key)?.releaseCause).toBeUndefined();
    expect(onDisk()).toMatchObject({ state: 'sent', releaseFailed: 2 });
    expect(existsSync(consentPath(h.dir, dump.key, '.json'))).toBe(true);
  });
});

describe('tylko `pending`', () => {
  it('rekord subagenta w `deciding` (zwolnienie z telefonu w trakcie zapisu) po 10 s: bez drugiego `release`, bez'
    + ' `releaseCause`', async () => {
    const writes: string[] = [];
    let during: (() => void) | null = null;
    const io: Partial<ConsentCycleIo> = {
      writeFile: (dir, name, body, options) => {
        writes.push(name);
        const hook = during;
        during = null;
        hook?.();
        writeAtomic(dir, name, body, options);
      },
    };
    const h = harness('all', { io });
    const dump = dumpOf('d3-deciding', { agentId: 'agent-1' });
    register(h.reg, dump);
    const t0 = clock;
    await h.cycle.observe(SESSION, dump.key, 'unknown', dump);
    let queued: Promise<unknown>[] = [];
    let seen: string | undefined;
    during = (): void => {
      seen = h.cycle.record(SESSION, dump.key)?.state;
      clock = t0 + CONSENT_SUBAGENT_GRACE_MS + 1_000;
      queued = [h.cycle.tick(), h.cycle.observe(SESSION, dump.key, 'unknown', dump)];
    };
    expect(await h.cycle.release(SESSION, dump.key)).toEqual({ ok: true, state: 'sent' });
    await Promise.all(queued);
    expect(seen).toBe('deciding');
    clock += CONSENT_SUBAGENT_GRACE_MS;
    await h.cycle.tick();
    expect(writes).toEqual([`${dump.key}.json`]);
    const record = h.cycle.record(SESSION, dump.key);
    expect(record).toMatchObject({ state: 'sent', decision: 'release', reasonId: 'release' });
    expect(record?.releaseCause).toBeUndefined();
  });
});

describe('wątek główny przy `all` ma te same wyniki co przy `main`', () => {
  /** Przebieg wątku głównego: karta, zgoda, przejęcie, dialog zniknął; druga karta odwołana `gone`; trzecia 20 s. */
  async function przebieg(tryb: Tryb): Promise<unknown[]> {
    clock = Date.parse('2026-11-09T11:00:00.000Z');
    const h = harness(tryb);
    const trace: unknown[] = [];
    const zgoda = dumpOf('main-zgoda');
    const znika = dumpOf('main-znika');
    const czeka = dumpOf('main-czeka');
    for (const dump of [zgoda, znika, czeka]) register(h.reg, dump);
    trace.push(await h.cycle.observe(SESSION, zgoda.key, 'unknown', zgoda));
    trace.push(await h.cycle.observe(SESSION, zgoda.key, 'standing', zgoda));
    trace.push(await h.cycle.decide(SESSION, zgoda.key, 'allow'));
    hookClaims(h.dir, zgoda.key);
    await h.cycle.tick();
    trace.push(await h.cycle.observe(SESSION, zgoda.key, 'gone'));
    trace.push(await h.cycle.observe(SESSION, znika.key, 'unknown', znika));
    trace.push(await h.cycle.observe(SESSION, znika.key, 'gone', znika));
    trace.push(await h.cycle.observe(SESSION, czeka.key, 'unknown', czeka));
    for (let t = 0; t <= 2 * CONSENT_SUBAGENT_GRACE_MS; t += 1_000) {
      clock += 1_000;
      await h.cycle.tick();
    }
    trace.push(await h.cycle.observe(SESSION, czeka.key, 'unknown', czeka));
    for (const dump of [zgoda, znika, czeka]) trace.push(h.cycle.record(SESSION, dump.key));
    trace.push(h.events);
    return trace;
  }

  it('ta sama sekwencja kart, decyzji i rekordów (bez `release` dla rekordu bez dowodu)', async () => {
    const main = await przebieg('main');
    const all = await przebieg('all');
    expect(all).toEqual(main);
    expect(main.slice(-4, -1)).toEqual([
      expect.objectContaining({ state: 'running', decision: 'allow' }),
      expect.objectContaining({ state: 'revoked', cause: 'dialog-gone' }),
      expect.objectContaining({ state: 'pending', decision: null }),
    ]);
  });
});

describe('powrót do biurka razem z pamięcią karty końcowej i zwolnieniem hooka', () => {
  it('subagent przy `all`: `gone` bez pliku `release`; `endPool` zostawia kartę `pending` i `sent` z `release`;'
    + ' `released` zwalnia treść w pamięci, a `endPool` zdejmuje już tylko kartę końcową, rekord zostaje',
  async () => {
    const h = harness('all');
    const dump = dumpOf('biurko-pamiec', { agentId: 'agent-1' });
    register(h.reg, dump);
    const t0 = clock;
    await h.cycle.observe(SESSION, dump.key, 'unknown', dump);
    await h.cycle.observe(SESSION, dump.key, 'gone', dump);
    expect(h.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'pending', cause: null });
    // Zwolnienie hooka nie dotyczy rekordu, który czeka na powrót do biurka.
    expect(existsSync(consentPath(h.dir, dump.key, '.json'))).toBe(false);

    h.cycle.endPool(SESSION);
    expect(h.cycle.card(SESSION, dump.key)).toMatchObject({ state: 'pending', unavailable: 'no-proof' });
    expect(h.cycle.diagnosticMemory(SESSION).dumps).toEqual([dump.key]);

    clock = t0 + CONSENT_SUBAGENT_GRACE_MS;
    await h.cycle.tick();
    expect(h.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'sent', decision: 'release' });
    h.cycle.endPool(SESSION);
    expect(h.cycle.card(SESSION, dump.key)?.state).toBe('sent');

    hookClaims(h.dir, dump.key);
    await h.cycle.tick();
    expect(h.events.at(-1)).toMatchObject({ state: 'released', presentation: expect.anything() });
    expect(h.cycle.card(SESSION, dump.key)).toMatchObject({ state: 'released', presentation: null });
    expect(h.cycle.diagnosticMemory(SESSION)).toEqual({
      dumps: [], verdicts: [], proofs: [], seenAt: [], createdAt: [], cards: [dump.key], records: [dump.key],
      proofMisses: [], proofNotes: [],
    });

    h.cycle.endPool(SESSION);
    expect(h.cycle.card(SESSION, dump.key)).toBeNull();
    expect(h.cycle.record(SESSION, dump.key)).toMatchObject({ state: 'released', releaseCause: 'desk-fallback' });
  });
});
