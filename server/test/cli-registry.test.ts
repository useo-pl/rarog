/**
 * Rejestr sesji CLI jako źródło wykrycia dialogu.
 *
 * Pomiar na CLI 2.1.293 i herdr 0.9.3: plik `~/.claude/sessions/<pid>.json` dostaje
 * `status: waiting` i `waitingFor` w chwili pokazania dialogu i wraca do `busy`/`idle` w chwili
 * odpowiedzi — także nad formularzem z podglądem i „Exit plan mode?”, których herdr nie widzi.
 *
 * Ten plik pilnuje czytnika (pole `waitingFor`, pamięć `stat`, jedna kolejka, „nie wiem" zamiast
 * wyjątku) i managera (szybki tik, sygnał tylko przy jednym pidzie, zdanie bramki wysyłki,
 * `RAROG_CLI_WAITING=0`). Driver ma swój zestaw w `herdr-driver.test.ts`.
 *
 * Ten sam odczyt rejestru niesie drugi fakt: start jedynego procesu rozmowy, którym
 * maszyna stanów zadań w tle zamyka subagentów sprzed restartu CLI. Droga managera jest tutaj
 * (ostatni blok), parser w `cli-version.test.ts`, reguła w `herdr-jsonl-tasks.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HerdrMode, HerdrStatus } from '@rarog/shared';
import {
  CLI_REGISTRY_MAX_BYTES, CLI_REGISTRY_UNKNOWN_CLASS_LOG, cliWaitingOf, createCliVersionReader, parseCliRegistryFile,
} from '../src/cli-version.ts';
import type {
  CliFileStat, CliRegistry, CliRegistryEntry, CliVersionIo, CliVersionReadOptions,
  CliVersionSnapshot, CliWaitingSignal,
} from '../src/cli-version.ts';
import { loadConfig, parseCliWaiting } from '../src/config.ts';
import {
  createManager,
} from '../src/sessions/manager.ts';
import {
  HERDR_MODE_UNKNOWN_MESSAGE, cliDialogSentence, herdrDialogStandsMessage,
} from '../src/sessions/state-sentences.ts';
import type { HerdrManagerDeps, Manager, ManagerConfig } from '../src/sessions/manager.ts';
import type { CliProcessStart } from '../src/drivers/types.ts';
import type { HerdrAgent } from '../src/herdr/types.ts';
import { AtrapaDrivera, AtrapaNadzorcy } from './helpers/atrapa-sesji.ts';

const UUID_A = '8d5c7e65-abb8-4841-b17f-e98b1588b918';
const UUID_B = '6903789c-2cac-4a0f-92a8-2397f7827340';
const DIR = '/home/u/.claude/sessions';
const LINK = '/home/u/.local/bin/claude';
/** Start procesu w pliku rejestru (ms epoki); parser zachowuje go we wpisie. */
const STARTED_AT = 1790230811708;

/** Plik rejestru w kształcie zmierzonym na CLI 2.1.293, z polami spoza zasięgu. */
function registryText(
  pid: number, sessionId: string, status = 'busy', waitingFor?: unknown,
): string {
  return JSON.stringify({
    pid, sessionId, cwd: '/Users/u/Projects/atlas', startedAt: STARTED_AT, version: '2.1.293',
    peerProtocol: 1, kind: 'interactive', entrypoint: 'cli', status,
    statusUpdatedAt: 1790243576879,
    ...(waitingFor === undefined ? {} : { waitingFor }),
    messagingSocketPath: `/tmp/cc-socks/${String(pid)}.sock`,
  });
}

/**
 * Atrapa dysku z licznikami `stat` i `readFile` — testy pamięci liczą, czego NIE czytamy.
 * `mtime` pliku rośnie przy każdym `write`, jak przy prawdziwym przepisaniu pliku.
 */
class FakeDisk implements CliVersionIo {
  readonly files = new Map<string, { text: string; mtimeMs: number }>();
  readonly stats: string[] = [];
  readonly reads: string[] = [];
  alivePids = new Set<number>();
  failReaddir = false;
  /** Gdy ustawione — `readdir` czeka na tę obietnicę (odczyt „w locie"). */
  gate: Promise<void> | null = null;
  #clock = 1;

  write(pid: number, text: string): void {
    this.#clock += 1;
    this.files.set(`${DIR}/${String(pid)}.json`, { text, mtimeMs: this.#clock });
    this.alivePids.add(pid);
  }

  readlink(): Promise<string> {
    return Promise.reject(new Error('EINVAL'));
  }

  exists(): Promise<boolean> {
    return Promise.resolve(false);
  }

  async readdir(path: string): Promise<string[]> {
    if (this.gate !== null) await this.gate;
    if (this.failReaddir || path !== DIR) throw new Error('ENOENT');
    return [...this.files.keys()].map((file) => file.slice(DIR.length + 1));
  }

  stat(path: string): Promise<CliFileStat> {
    this.stats.push(path);
    const file = this.files.get(path);
    return file === undefined
      ? Promise.reject(new Error('ENOENT'))
      : Promise.resolve({ size: file.text.length, mtimeMs: file.mtimeMs });
  }

  readFile(path: string): Promise<string> {
    this.reads.push(path);
    const file = this.files.get(path);
    return file === undefined ? Promise.reject(new Error('ENOENT')) : Promise.resolve(file.text);
  }

  alive(pid: number): boolean {
    return this.alivePids.has(pid);
  }
}

const reader = (disk: FakeDisk, lines: string[] = []): ReturnType<typeof createCliVersionReader> =>
  createCliVersionReader({
    binLink: LINK, registryDir: DIR, io: disk, logger: (line) => { lines.push(line); },
  });

const FAST: CliVersionReadOptions = { registryOnly: true };

// ---------------------------------------------------------------------------
// Piąte pole: `waitingFor`
// ---------------------------------------------------------------------------

describe('`waitingFor` z zamkniętej listy', () => {
  it('klasy z docs (`agent-view.md`) i z pomiaru dostają krótkie nazwy Raroga', () => {
    const cases: [string, string][] = [
      ['input needed', 'input'], ['permission prompt', 'permission'],
      ['sandbox request', 'sandbox'], ['worker request', 'worker'],
      ['dialog open', 'dialog'],
    ];
    for (const [raw, expected] of cases) {
      expect(parseCliRegistryFile(7, registryText(7, UUID_A, 'waiting', raw))?.[1])
        .toEqual({ pid: 7, version: '2.1.293', status: 'waiting', waitingFor: expected, startedAt: STARTED_AT });
    }
  });

  it('`goal proposal` bez dowodu (goły `/goal` dał `dialog open`) to `other` z linią logu', () => {
    const unknown: string[] = [];
    expect(parseCliRegistryFile(
      7, registryText(7, UUID_A, 'waiting', 'goal proposal'), (raw) => { unknown.push(raw); },
    )?.[1].waitingFor).toBe('other');
    expect(unknown).toEqual(['goal proposal']);
  });

  it('nieznana klasa to `other` z nazwą dla logu; śmieć w polu nie odbiera wpisu wydaniu', () => {
    const unknown: string[] = [];
    expect(parseCliRegistryFile(
      7, registryText(7, UUID_A, 'waiting', 'quantum prompt'), (raw) => { unknown.push(raw); },
    )?.[1].waitingFor).toBe('other');
    expect(unknown).toEqual(['quantum prompt']);
    // Liczba, pusty napis i obiekt w `waitingFor` to „pola nie ma", a reszta wpisu zostaje.
    for (const junk of [42, '', { a: 1 }]) {
      expect(parseCliRegistryFile(7, registryText(7, UUID_A, 'busy', junk)))
        .toEqual([UUID_A, { pid: 7, version: '2.1.293', status: 'busy', startedAt: STARTED_AT }]);
    }
  });

  it('linia „nieznana klasa dialogu" leci RAZ i cytuje tylko nazwę o kształcie klasy', async () => {
    const disk = new FakeDisk();
    disk.write(10, registryText(10, UUID_A, 'waiting', 'quantum prompt'));
    disk.write(11, registryText(11, UUID_B, 'waiting', 'SEKRET sk-ant-123'));
    const lines: string[] = [];
    const read = reader(disk, lines);
    await read();
    await read();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(CLI_REGISTRY_UNKNOWN_CLASS_LOG);
    expect(lines[0]).toContain('"quantum prompt"');

    const otherDisk = new FakeDisk();
    otherDisk.write(11, registryText(11, UUID_B, 'waiting', 'SEKRET sk-ant-123'));
    const otherLines: string[] = [];
    await reader(otherDisk, otherLines)();
    expect(otherLines).toHaveLength(1);
    expect(otherLines[0]).not.toContain('SEKRET');
  });
});

describe('cliWaitingOf — sygnał dla JEDNEJ sesji', () => {
  const entry = (pid: number, status: string, waitingFor?: CliRegistryEntry['waitingFor']) => ({
    pid, version: '2.1.293', status, ...(waitingFor === undefined ? {} : { waitingFor }),
  });

  it('jeden pid na `waiting` → klasa; bez klasy → `other`; `busy`/`idle` → `active`, `busy` z polem', () => {
    const registry: CliRegistry = new Map([
      [UUID_A, [entry(1, 'waiting', 'permission')]],
      [UUID_B, [entry(2, 'waiting')]],
    ]);
    expect(cliWaitingOf(registry, UUID_A)).toEqual({ kind: 'waiting', dialog: 'permission', version: '2.1.293' });
    expect(cliWaitingOf(registry, UUID_B)).toEqual({ kind: 'waiting', dialog: 'other', version: '2.1.293' });
    // The paste queue reads `busy` as a turn herdr may not report yet; other statuses carry no field.
    expect(cliWaitingOf(new Map([[UUID_A, [entry(1, 'busy', 'input')]]]), UUID_A))
      .toStrictEqual({ kind: 'active', version: '2.1.293', busy: true });
    for (const status of ['idle', 'shell']) {
      expect(cliWaitingOf(new Map([[UUID_A, [entry(1, status)]]]), UUID_A), status)
        .toStrictEqual({ kind: 'active', version: '2.1.293' });
    }
  });

  it('dwóch pisarzy, brak wpisu, brak rejestru i brak uuid to „nie wiem"', () => {
    const two: CliRegistry = new Map([
      [UUID_A, [entry(1, 'waiting', 'input'), entry(2, 'busy')]],
    ]);
    expect(cliWaitingOf(two, UUID_A)).toEqual({ kind: 'unknown' });
    expect(cliWaitingOf(two, UUID_B)).toEqual({ kind: 'unknown' });
    expect(cliWaitingOf(null, UUID_A)).toEqual({ kind: 'unknown' });
    expect(cliWaitingOf(two, undefined)).toEqual({ kind: 'unknown' });
  });
});

// ---------------------------------------------------------------------------
// Świeżość, pamięć `stat`, jedna kolejka
// ---------------------------------------------------------------------------

describe('szybki odczyt z pamięcią `stat`', () => {
  it('niezmieniony plik nie jest czytany drugi raz; zmieniony — tak; pełna migawka czyta wszystko',
    async () => {
      const disk = new FakeDisk();
      disk.write(10, registryText(10, UUID_A));
      disk.write(11, registryText(11, UUID_B));
      const read = reader(disk);
      await read(FAST);
      expect(disk.reads).toHaveLength(2);

      await read(FAST);
      expect(disk.reads, 'bez zmian — sam `stat`').toHaveLength(2);

      disk.write(10, registryText(10, UUID_A, 'waiting', 'input needed'));
      const snapshot = await read(FAST);
      expect(disk.reads.slice(2)).toEqual([`${DIR}/10.json`]);
      expect(cliWaitingOf(snapshot.registry, UUID_A)).toEqual({ kind: 'waiting', dialog: 'input', version: '2.1.293' });

      // Migawka wydań jest siatką pod pamięcią: czyta każdy plik od nowa.
      await read();
      expect(disk.reads.slice(3).sort()).toEqual([`${DIR}/10.json`, `${DIR}/11.json`]);
    });

  it('`.key` nie dostaje ani `stat`, ani odczytu; plik większy niż limit nie jest czytany', async () => {
    const disk = new FakeDisk();
    disk.files.set(`${DIR}/10.221b900b4d5cd9ffd327d9546abe75f18f7bc57ef90e85e4403e0a26d5e7e4bb.key`,
      { text: 'SEKRET', mtimeMs: 1 });
    disk.write(12, registryText(12, UUID_A) + ' '.repeat(CLI_REGISTRY_MAX_BYTES));
    disk.alivePids.add(10);
    const read = reader(disk);
    await read(FAST);
    await read();
    expect([...disk.stats, ...disk.reads].some((path) => path.endsWith('.key'))).toBe(false);
    expect(disk.reads).toEqual([]);
  });

  it('plik zniknięty w trakcie, martwy pid i brak katalogu to „nie wiem", nie wyjątek', async () => {
    const disk = new FakeDisk();
    disk.write(10, registryText(10, UUID_A, 'waiting', 'permission prompt'));
    const read = reader(disk);
    await read(FAST);

    // `readdir` widzi plik, `stat` już nie (proces skończył się w środku odczytu).
    const original = disk.stat.bind(disk);
    disk.stat = (path) => {
      disk.files.delete(path);
      return original(path);
    };
    const gone = await read(FAST);
    expect(gone.registry?.has(UUID_A)).toBe(false);

    disk.stat = original;
    disk.write(10, registryText(10, UUID_A, 'waiting', 'permission prompt'));
    disk.alivePids.delete(10);
    expect((await read(FAST)).registry?.size).toBe(0);

    disk.failReaddir = true;
    expect((await read(FAST)).registry).toBeNull();
  });

  it('plik w trakcie zapisu: jeden odczyt oddaje ostatni dobry wpis, drugi — już nie', async () => {
    const disk = new FakeDisk();
    disk.write(10, registryText(10, UUID_A, 'waiting', 'input needed'));
    const read = reader(disk);
    await read(FAST);

    disk.write(10, '{"pid":10,"sessionId":"8d5c');
    const first = await read(FAST);
    expect(cliWaitingOf(first.registry, UUID_A)).toEqual({ kind: 'waiting', dialog: 'input', version: '2.1.293' });
    // Ten sam (zepsuty) stan pliku drugi raz to już wiedza: wpisu nie ma.
    const second = await read(FAST);
    expect(second.registry?.has(UUID_A)).toBe(false);
  });

  it('odczyty idą PO KOLEI, a `generation` rośnie w kolejności zleceń', async () => {
    const disk = new FakeDisk();
    disk.write(10, registryText(10, UUID_A));
    const read = reader(disk);
    let release: () => void = () => undefined;
    disk.gate = new Promise<void>((resolve) => { release = resolve; });

    const order: number[] = [];
    const slow = read().then((snapshot) => { order.push(snapshot.generation ?? -1); return snapshot; });
    const fast = read(FAST).then((snapshot) => {
      order.push(snapshot.generation ?? -1);
      return snapshot;
    });
    // Drugi odczyt nie wystartował: `readdir` pierwszego wciąż czeka.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual([]);
    disk.gate = null;
    release();
    const [a, b] = await Promise.all([slow, fast]);
    expect(order).toEqual([1, 2]);
    expect((a.generation ?? 0) < (b.generation ?? 0)).toBe(true);
  });
});

describe('`RAROG_CLI_WAITING`', () => {
  it('domyślnie WŁĄCZONE, `0`/`false` wyłącza, demo zawsze `false`', () => {
    expect(parseCliWaiting(undefined)).toBe(true);
    expect(parseCliWaiting('')).toBe(true);
    expect(parseCliWaiting('1')).toBe(true);
    expect(parseCliWaiting('0')).toBe(false);
    expect(parseCliWaiting('false')).toBe(false);
    const env = { RAROG_ORIGINS: 'https://rarog.example' };
    expect(loadConfig(env).cliWaiting).toBe(true);
    expect(loadConfig({ ...env, RAROG_CLI_WAITING: '0' }).cliWaiting).toBe(false);
    // Demo nie czyta rejestru procesów Maca — jego sesje są fikcyjne.
    expect(loadConfig({ RAROG_DEMO: '1', RAROG_CLI_WAITING: '1' }).cliWaiting).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Manager — szybki tik, sygnał i bramka wysyłki
// ---------------------------------------------------------------------------

const PROJECT = '/Users/u/Projects/atlas';
const KEY = 'w9:p72';

class SignalDriver extends AtrapaDrivera {
  readonly signals: CliWaitingSignal[] = [];
  readonly starts: CliProcessStart[] = [];

  noteCliWaiting(signal: CliWaitingSignal): void {
    this.signals.push(signal);
  }

  noteCliProcessStart(start: CliProcessStart): void {
    this.starts.push(start);
  }
}

class FakeSupervisor extends AtrapaNadzorcy<SignalDriver> {
  mode: HerdrMode = 'auto';

  override status(): HerdrStatus {
    return { available: true, agentCount: 0, readOnly: false, canLaunch: false };
  }

  protected nowyDriver(key: string): SignalDriver {
    const driver = new SignalDriver(key);
    driver.queue.push({ type: 'agent-state', state: 'idle', seen: true });
    return driver;
  }

  override ensureFreshMode(): Promise<HerdrMode> {
    return Promise.resolve(this.mode);
  }

  appear(agent: HerdrAgent): void {
    this.lifecycle.push({ type: 'appeared', agent });
  }
}

function makeDeps(): HerdrManagerDeps {
  return {
    sessionIdFor: (key: string) => `herdr-${key.replace(/[^a-z0-9]/gi, '-')}`,
    aliasFor: () => undefined,
    rememberAlias: () => undefined,
    assertSendable: (text) => ({ text: text.trim(), slash: null }),
    takeSendSlot: () => true,
    writeUploads: async () => [],
    writeUploadFiles: async () => [],
    sweepUploads: async () => undefined,
  };
}

function makeAgent(overrides: Partial<HerdrAgent> = {}): HerdrAgent {
  return {
    key: KEY, paneId: KEY, agentSessionId: UUID_A, engine: 'claude', termId: null,
    cwd: PROJECT, status: 'idle', title: 'atlas', stateChangeSeq: 1, mode: 'auto', modeReadAt: 0,
    inScope: true, tabId: 'w9:t3', launchedByRarog: false, interactiveReady: true, ...overrides,
  };
}

async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}

const POLL_MS = 100;

describe('manager: szybki tik rejestru', () => {
  let dataDir: string;
  const managers: Manager[] = [];
  const supervisors: FakeSupervisor[] = [];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'rarog-rejestr-cli-'));
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const manager of managers.splice(0)) await manager.dispose();
    for (const supervisor of supervisors.splice(0)) supervisor.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });

  interface Built {
    manager: Manager; supervisor: FakeSupervisor; driver: SignalDriver; id: string;
    calls: (CliVersionReadOptions | undefined)[];
  }

  async function build(opts: {
    registry: () => CliRegistry | null;
    agent?: HerdrAgent;
    overrides?: Partial<ManagerConfig>;
    generation?: () => number | undefined;
    /** Odczyt „w locie": czytnik czeka na tę obietnicę, zanim odda wynik. */
    gate?: () => Promise<void> | null;
    /** Ile żywych pidów miało w tym odczycie plik rejestru bez wpisu. */
    unreadablePids?: () => number;
    /** Rozmowy żywych procesów, których plik rejestru zniknął. */
    unlistedSessions?: () => ReadonlySet<string>;
  }): Promise<Built> {
    const supervisor = new FakeSupervisor();
    supervisors.push(supervisor);
    const calls: (CliVersionReadOptions | undefined)[] = [];
    const manager = await createManager({
      demo: false,
      dataDir,
      projects: [{ path: PROJECT, name: 'atlas' }],
      projectRoots: [],
      gitStatus: null,
      herdrSupervisor: supervisor,
      herdrDeps: makeDeps(),
      herdrRoots: [PROJECT],
      herdrSend: true,
      cliWaiting: true,
      cliWaitingPollMs: POLL_MS,
      cliVersionReader: async (readOpts) => {
        calls.push(readOpts);
        const gate = opts.gate?.() ?? null;
        if (gate !== null) await gate;
        const generation = opts.generation?.();
        const snapshot: CliVersionSnapshot = {
          installed: null, registry: opts.registry(),
          ...(generation === undefined ? {} : { generation }),
          ...(opts.unreadablePids === undefined ? {} : { unreadablePids: opts.unreadablePids() }),
          ...(opts.unlistedSessions === undefined ? {} : { unlistedSessions: opts.unlistedSessions() }),
        };
        return snapshot;
      },
      ...opts.overrides,
    });
    managers.push(manager);
    await manager.ready;
    const agent = opts.agent ?? makeAgent();
    supervisor.appear(agent);
    await flush();
    const id = manager.list().find((s) => s.paneId !== undefined)?.id ?? '';
    expect(id).not.toBe('');
    const driver = supervisor.drivers.get(agent.key);
    if (driver === undefined) throw new Error('brak drivera');
    return { manager, supervisor, driver, id, calls };
  }

  async function tick(): Promise<void> {
    vi.advanceTimersByTime(POLL_MS);
    await flush();
  }

  const waiting = (dialog: CliRegistryEntry['waitingFor'], pid = 4242): CliRegistry => new Map([
    [UUID_A, [{ pid, version: '2.1.293', status: 'waiting', ...(dialog === undefined ? {} : { waitingFor: dialog }) }]],
  ]);

  it('tik czyta sam rejestr i oddaje driverowi sygnał PRZY KAŻDYM odczycie', async () => {
    let registry: CliRegistry | null = waiting('input');
    const built = await build({ registry: () => registry });
    await tick();
    await tick();
    expect(built.calls.some((call) => call?.registryOnly === true)).toBe(true);
    const signals = built.driver.signals.slice(-2);
    const input = { kind: 'waiting', dialog: 'input', version: '2.1.293' };
    expect(signals).toEqual([input, input]);

    registry = new Map([[UUID_A, [{ pid: 4242, version: '2.1.293', status: 'busy' }]]]);
    await tick();
    expect(built.driver.signals.at(-1)).toEqual({ kind: 'active', version: '2.1.293', busy: true });
  });

  it('dwa pidy jednej rozmowy → „nie wiem" (sygnał ignorowany)', async () => {
    const two: CliRegistry = new Map([[UUID_A, [
      { pid: 1, version: '2.1.293', status: 'waiting', waitingFor: 'permission' },
      { pid: 2, version: '2.1.293', status: 'busy' },
    ]]]);
    const built = await build({ registry: () => two });
    await tick();
    expect(built.driver.signals.length).toBeGreaterThan(0);
    expect(built.driver.signals.every((signal) => signal.kind === 'unknown')).toBe(true);
  });

  it('Codex i panel poza zasięgiem dostają „nie wiem"', async () => {
    const codex = await build({ registry: () => waiting('input'), agent: makeAgent({ engine: 'codex' }) });
    await tick();
    expect(codex.driver.signals.every((signal) => signal.kind === 'unknown')).toBe(true);
  });

  it('odczyt starszy niż przyjęty (`generation`) nie nadpisuje nowszego', async () => {
    let generation = 10;
    let registry: CliRegistry | null = waiting('permission');
    const built = await build({ registry: () => registry, generation: () => (generation += 1) });
    await tick();
    expect(built.driver.signals.at(-1)).toEqual({ kind: 'waiting', dialog: 'permission', version: '2.1.293' });
    const before = built.driver.signals.length;

    generation = 4;
    registry = new Map();
    await tick();
    expect(built.driver.signals).toHaveLength(before);
  });

  it('bramka wysyłki nazywa przyczynę, gdy rejestr mówi `waiting`; bez niego zdanie stare', async () => {
    let registry: CliRegistry | null = waiting('dialog');
    const built = await build({ registry: () => registry });
    built.supervisor.mode = 'unknown';
    await tick();
    await expect(built.manager.sendMessage(built.id, 'hej'))
      .rejects.toThrow(herdrDialogStandsMessage('dialog').text);
    expect(herdrDialogStandsMessage('dialog').ref).toEqual({ code: 'session.dialog-stands', args: ['session.cli-dialog.open'] });
    expect(herdrDialogStandsMessage('dialog').text).toContain('a dialog is waiting in the terminal (open CLI dialog');

    registry = new Map([[UUID_A, [{ pid: 4242, version: '2.1.293', status: 'idle' }]]]);
    await tick();
    await expect(built.manager.sendMessage(built.id, 'hej')).rejects.toThrow(HERDR_MODE_UNKNOWN_MESSAGE.text);
  });

  it('`RAROG_CLI_WAITING=0`: zero szybkich odczytów, zero sygnałów, stare zdanie bramki', async () => {
    const built = await build({ registry: () => waiting('permission'), overrides: { cliWaiting: false } });
    built.supervisor.mode = 'unknown';
    await tick();
    await tick();
    expect(built.calls.some((call) => call?.registryOnly === true)).toBe(false);
    expect(built.driver.signals).toEqual([]);
    await expect(built.manager.sendMessage(built.id, 'hej')).rejects.toThrow(HERDR_MODE_UNKNOWN_MESSAGE.text);
  });

  it('`dispose` w trakcie odczytu: wynik przepada po cichu, bez sygnału i bez wyjątku', async () => {
    let gate: Promise<void> | null = null;
    let release: () => void = () => undefined;
    const built = await build({ registry: () => waiting('input'), gate: () => gate });
    await tick();
    const before = built.driver.signals.length;
    expect(before).toBeGreaterThan(0);

    // Następny odczyt wisi — jak `readdir` nad wolnym dyskiem — a manager w tym czasie znika.
    gate = new Promise<void>((resolve) => { release = resolve; });
    vi.advanceTimersByTime(POLL_MS);
    await flush();
    await built.manager.dispose();
    managers.splice(managers.indexOf(built.manager), 1);
    release();
    await flush();
    vi.advanceTimersByTime(POLL_MS * 3);
    await flush();
    expect(built.driver.signals).toHaveLength(before);
  });

  it('zdania klas: zmierzone klasy mają własne, reszta wspólne', () => {
    expect(cliDialogSentence('permission')).toBe('session.cli-dialog.permission');
    expect(cliDialogSentence('input')).toBe('session.cli-dialog.input');
    expect(cliDialogSentence('sandbox')).toBe('session.cli-dialog.sandbox');
    expect(cliDialogSentence('dialog')).toBe('session.cli-dialog.open');
    for (const other of ['worker', 'goal', 'other'] as const) {
      expect(cliDialogSentence(other)).toBe('session.cli-dialog.other');
    }
  });

  // -------------------------------------------------------------------------
  // Start jedynego procesu rozmowy jako fakt dla zadań w tle
  // -------------------------------------------------------------------------

  /** Zegar managera stoi godzinę po starcie procesu: czas z rejestru nie jest „z przyszłości”. */
  const CLOCK = { now: () => STARTED_AT + 3_600_000 };
  const idle = (pid: number, startedAt?: number): CliRegistryEntry => ({
    pid, version: '2.1.296', status: 'idle', ...(startedAt === undefined ? {} : { startedAt }),
  });

  it('jeden żywy proces: driver dostaje start z uuid rozmowy; po restarcie CLI nową chwilę', async () => {
    let registry: CliRegistry | null = new Map([[UUID_A, [idle(4242, STARTED_AT)]]]);
    const built = await build({ registry: () => registry, overrides: CLOCK });
    await tick();
    expect(built.driver.starts.at(-1)).toEqual({ sessionId: UUID_A, startedAt: STARTED_AT });
    // Rarog wstał przy już działającym CLI: fakt dociera bez żadnej zmiany w rejestrze, a każda
    // powtórka niesie tę samą chwilę (powtórki gasi follower, nie manager).
    await tick();
    expect(new Set(built.driver.starts.map((start) => start.startedAt))).toEqual(new Set([STARTED_AT]));

    // `/exit`: procesu nie ma. Brak wpisu to „nie wiem”, czyli brak wywołania.
    registry = new Map();
    const before = built.driver.starts.length;
    await tick();
    await tick();
    expect(built.driver.starts).toHaveLength(before);

    // `claude --resume`: nowy pid, ta sama rozmowa, późniejszy start.
    registry = new Map([[UUID_A, [idle(5001, STARTED_AT + 120_000)]]]);
    await tick();
    expect(built.driver.starts.at(-1)).toEqual({ sessionId: UUID_A, startedAt: STARTED_AT + 120_000 });
  });

  it('dwóch pisarzy, wpis bez czasu startu i brak rejestru: brak wywołania', async () => {
    let registry: CliRegistry | null = new Map([[UUID_A, [
      idle(1, STARTED_AT), idle(2, STARTED_AT + 60_000),
    ]]]);
    const built = await build({ registry: () => registry, overrides: CLOCK });
    await tick();
    registry = new Map([[UUID_A, [idle(1)]]]);
    await tick();
    registry = null;
    await tick();
    // Sygnał dialogu szedł przez cały czas, więc cisza niżej nie jest ciszą martwego tiku.
    expect(built.driver.signals.length).toBeGreaterThan(0);
    expect(built.driver.starts).toEqual([]);
  });

  /**
   * Żywy proces z nieczytelnym plikiem rejestru może być drugim pisarzem
   * tej rozmowy. Dopóki taki jest, start „jedynego” procesu niczego nie dowodzi; po pełnym
   * odczycie fakt idzie normalnie.
   */
  it('żywy pid z nieczytelnym plikiem rejestru: brak wywołania do pierwszego pełnego odczytu', async () => {
    let unreadable = 1;
    const registry: CliRegistry = new Map([[UUID_A, [idle(4242, STARTED_AT)]]]);
    const built = await build({
      registry: () => registry, unreadablePids: () => unreadable, overrides: CLOCK,
    });
    await tick();
    await tick();
    expect(built.driver.signals.length).toBeGreaterThan(0);
    expect(built.driver.starts).toEqual([]);

    unreadable = 0;
    await tick();
    expect(built.driver.starts.at(-1)).toEqual({ sessionId: UUID_A, startedAt: STARTED_AT });
  });

  it('żywy proces tej rozmowy bez pliku rejestru: brak wywołania, dopóki żyje', async () => {
    let unlisted: ReadonlySet<string> = new Set([UUID_A]);
    const registry: CliRegistry = new Map([[UUID_A, [idle(4242, STARTED_AT)]]]);
    const built = await build({
      registry: () => registry, unlistedSessions: () => unlisted, overrides: CLOCK,
    });
    await tick();
    await tick();
    expect(built.driver.starts).toEqual([]);

    // Cudza rozmowa z takim procesem tej nie blokuje.
    unlisted = new Set([UUID_B]);
    await tick();
    expect(built.driver.starts.at(-1)).toEqual({ sessionId: UUID_A, startedAt: STARTED_AT });
  });

  it('czas startu z przyszłości nie jest startem procesu: brak wywołania', async () => {
    // Np. inna jednostka w nowym CLI: mikrosekundy dałyby rok 58 tysięcy i zamknęły każdego agenta.
    const registry: CliRegistry = new Map([[UUID_A, [idle(4242, STARTED_AT * 1000)]]]);
    const built = await build({ registry: () => registry, overrides: CLOCK });
    await tick();
    expect(built.driver.starts).toEqual([]);
  });

  it('Codex nie dostaje startu procesu', async () => {
    const registry: CliRegistry = new Map([[UUID_A, [idle(4242, STARTED_AT)]]]);
    const built = await build({
      registry: () => registry, agent: makeAgent({ engine: 'codex' }), overrides: CLOCK,
    });
    await tick();
    expect(built.driver.starts).toEqual([]);
  });

  it('`RAROG_CLI_WAITING=0`: start procesu nie idzie wcale, także z pełnej migawki co 30 s', async () => {
    const registry: CliRegistry = new Map([[UUID_A, [idle(4242, STARTED_AT)]]]);
    const built = await build({
      registry: () => registry, overrides: { ...CLOCK, cliWaiting: false },
    });
    await tick();
    await tick();
    // Pełna migawka wydań poszła przy starcie managera i też niczego nie podała.
    expect(built.calls.length).toBeGreaterThan(0);
    expect(built.driver.starts).toEqual([]);
  });
});
