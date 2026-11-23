/**
 * Wydanie Claude Code działającej sesji vs zainstalowane.
 *
 * Testy trzymają cztery rzeczy, które łatwo cicho zepsuć:
 * 1. pliki `<pid>.<hash>.key` (prawa `0600`) NIGDY nie są otwierane,
 * 2. nic nie rzuca — śmieci w rejestrze i dziwne dowiązanie to „nie wiem", nie wyjątek,
 * 3. znacznik tylko przy wydaniu zainstalowanym NOWSZYM (rollback = cisza),
 * 4. linia „nieznany kształt" leci raz, a jej treść nie cytuje rejestru.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLI_REGISTRY_MAX_BYTES, CLI_REGISTRY_UNKNOWN_SHAPE_LOG, DEFAULT_CLI_VERSION_IO, cliProcessStartOf, cliUpdateFor,
  compareCliVersions, createCliVersionReader, parseCliRegistryFile, readInstalledCliVersion, runningCliVersion,
} from '../src/cli-version.ts';
import type { CliRegistry, CliVersionIo } from '../src/cli-version.ts';
import { CHILD_TEST_TIMEOUT_MS, childJson, runInChild, serverModule } from './child-limit.ts';

const UUID_A = '8d5c7e65-abb8-4841-b17f-e98b1588b918';
const UUID_B = '6903789c-2cac-4a0f-92a8-2397f7827340';
const LINK = '/home/u/.local/bin/claude';
const DIR = '/home/u/.claude/sessions';

/** Start procesu w pliku rejestru: milisekundy epoki, 1–7 s po `procStart`. */
const STARTED_AT = 1790230811708;

/**
 * Plik rejestru w kształcie zmierzonym na CLI 2.1.281, z sekretami poza zasięgiem.
 * `startedAt` jest parametrem.
 */
function registryText(
  pid: number, sessionId: string, version: string, status = 'idle', startedAt: unknown = STARTED_AT,
): string {
  return JSON.stringify({
    pid, sessionId, cwd: '/Users/u/Projects/atlas', startedAt,
    procStart: 'Thu Sep 24 06:20:10 2026', version, peerProtocol: 1, kind: 'interactive',
    entrypoint: 'cli', messagingSocketPath: `/tmp/cc-socks/${String(pid)}.sock`, name: 'x',
    status, updatedAt: 1790243576879,
  });
}

interface FakeFs {
  links?: Record<string, string>;
  files?: Record<string, string>;
  existing?: readonly string[];
  alive?: readonly number[];
  /** Czytane przy KAŻDYM `readdir`, więc test może popsuć i naprawić katalog między odczytami. */
  failReaddir?: boolean;
}

/** Atrapa dysku, która liczy otwarcia plików — test 1 sprawdza, czego NIE czytamy. */
function fakeIo(fs: FakeFs): CliVersionIo & { opened: string[] } {
  const opened: string[] = [];
  const files = fs.files ?? {};
  return {
    opened,
    readlink: (path) => {
      const target = fs.links?.[path];
      return target === undefined ? Promise.reject(new Error('EINVAL')) : Promise.resolve(target);
    },
    exists: (path) => Promise.resolve((fs.existing ?? []).includes(path)),
    readdir: (path) => {
      if (fs.failReaddir === true || path !== DIR) return Promise.reject(new Error('ENOENT'));
      return Promise.resolve(Object.keys(files).map((file) => file.slice(DIR.length + 1)));
    },
    stat: (path) => {
      const text = files[path];
      return text === undefined
        ? Promise.reject(new Error('ENOENT'))
        : Promise.resolve({ size: text.length, mtimeMs: 1 });
    },
    readFile: (path) => {
      opened.push(path);
      const text = files[path];
      return text === undefined ? Promise.reject(new Error('ENOENT')) : Promise.resolve(text);
    },
    alive: (pid) => (fs.alive ?? []).includes(pid),
  };
}

describe('readInstalledCliVersion', () => {
  it('instalator natywny: cel `…/versions/X.Y.Z`, który istnieje', async () => {
    const target = '/home/u/.local/share/claude/versions/2.1.283';
    const io = fakeIo({ links: { [LINK]: target }, existing: [target] });
    expect(await readInstalledCliVersion(LINK, io)).toBe('2.1.283');
  });

  it('dowiązanie względne liczy się od katalogu dowiązania', async () => {
    const io = fakeIo({
      links: { [LINK]: '../share/claude/versions/2.1.283' },
      existing: ['/home/u/.local/share/claude/versions/2.1.283'],
    });
    expect(await readInstalledCliVersion(LINK, io)).toBe('2.1.283');
  });

  it('wiszący cel, npm, brak dowiązania i śmieci to `null`, nigdy wyjątek', async () => {
    const dangling = fakeIo({ links: { [LINK]: '/home/u/.local/share/claude/versions/2.1.283' } });
    expect(await readInstalledCliVersion(LINK, dangling)).toBeNull();
    const npm = '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js';
    expect(await readInstalledCliVersion(LINK, fakeIo({ links: { [LINK]: npm }, existing: [npm] })))
      .toBeNull();
    expect(await readInstalledCliVersion(LINK, fakeIo({}))).toBeNull();
    const odd = '/home/u/elsewhere/2.1.283';
    expect(await readInstalledCliVersion(LINK, fakeIo({ links: { [LINK]: odd }, existing: [odd] })))
      .toBeNull();
    const garbage = '/home/u/.local/share/claude/versions/latest';
    expect(await readInstalledCliVersion(LINK, fakeIo({
      links: { [LINK]: garbage }, existing: [garbage],
    }))).toBeNull();
  });
});

describe('parseCliRegistryFile', () => {
  it('bierze pid, sessionId, version, status i czas startu procesu — nic więcej', () => {
    expect(parseCliRegistryFile(2142, registryText(2142, UUID_A, '2.1.281')))
      .toEqual([UUID_A, { pid: 2142, version: '2.1.281', status: 'idle', startedAt: STARTED_AT }]);
  });

  /**
   * `startedAt` jest polem DODATKOWYM, jak `waitingFor`. Jego brak albo zły typ nie odbiera
   * wpisu wydaniu ani wykryciu dialogu; wpis jest wtedy po prostu bez czasu startu.
   */
  it('`startedAt`: brak pola, zły typ, zero i liczba ujemna dają wpis BEZ czasu startu', () => {
    const bare = [UUID_A, { pid: 2142, version: '2.1.281', status: 'idle' }];
    const without = JSON.parse(registryText(2142, UUID_A, '2.1.281')) as Record<string, unknown>;
    delete without['startedAt'];
    expect(parseCliRegistryFile(2142, JSON.stringify(without))).toEqual(bare);
    for (const junk of ['1790230811708', '2026-09-24T06:20:11.708Z', null, true, { ms: 1 }, [1], 0, -5]) {
      expect(parseCliRegistryFile(2142, registryText(2142, UUID_A, '2.1.281', 'idle', junk))).toEqual(bare);
    }
    // `1e999` parsuje się z JSON-u do nieskończoności: liczba, ale nie chwila.
    expect(parseCliRegistryFile(2142, '{"pid":2142,"sessionId":"' + UUID_A
      + '","version":"2.1.281","status":"idle","startedAt":1e999}')).toEqual(bare);
  });

  it('pid z treści musi równać się pidowi z nazwy pliku', () => {
    expect(parseCliRegistryFile(2143, registryText(2142, UUID_A, '2.1.281'))).toBeNull();
  });

  it('zły uuid, zły numer wydania, brak statusu, nie-obiekt i nie-JSON to `null`', () => {
    expect(parseCliRegistryFile(1, registryText(1, 'nie-uuid', '2.1.281'))).toBeNull();
    expect(parseCliRegistryFile(1, registryText(1, UUID_A, '2.1'))).toBeNull();
    expect(parseCliRegistryFile(1, registryText(1, UUID_A, '2.1.281', 'Bardzo Długi Status')))
      .toBeNull();
    expect(parseCliRegistryFile(1, JSON.stringify({ pid: 1, sessionId: UUID_A, version: '2.1.1' })))
      .toBeNull();
    expect(parseCliRegistryFile(1, '[1,2]')).toBeNull();
    expect(parseCliRegistryFile(1, '{')).toBeNull();
  });
});

describe('createCliVersionReader — rejestr', () => {
  it('pliki `.key` nie są otwierane, martwe pidy pomijane, `status` zachowany', async () => {
    const io = fakeIo({
      files: {
        [`${DIR}/2142.json`]: registryText(2142, UUID_A, '2.1.281'),
        [`${DIR}/2142.221b900b4d5cd9ffd327d9546abe75f18f7bc57ef90e85e4403e0a26d5e7e4bb.key`]: 'SEKRET',
        [`${DIR}/3003.json`]: registryText(3003, UUID_B, '2.1.280', 'shell'),
        [`${DIR}/4444.json`]: registryText(4444, UUID_B, '2.1.200'),
      },
      alive: [2142, 3003],
    });
    const snapshot = await createCliVersionReader({ binLink: LINK, registryDir: DIR, io })();
    expect(io.opened.some((path) => path.endsWith('.key'))).toBe(false);
    // Martwy pid nie jest nawet czytany — jego plik to śmieć po awarii procesu.
    expect(io.opened).not.toContain(`${DIR}/4444.json`);
    expect(snapshot.registry?.get(UUID_A))
      .toEqual([{ pid: 2142, version: '2.1.281', status: 'idle', startedAt: STARTED_AT }]);
    expect(snapshot.registry?.get(UUID_B))
      .toEqual([{ pid: 3003, version: '2.1.280', status: 'shell', startedAt: STARTED_AT }]);
    expect(snapshot.installed).toBeNull();
  });

  it('plik większy niż limit nie jest czytany', async () => {
    const big = registryText(7, UUID_A, '2.1.281') + ' '.repeat(CLI_REGISTRY_MAX_BYTES);
    const io = fakeIo({ files: { [`${DIR}/7.json`]: big }, alive: [7] });
    const snapshot = await createCliVersionReader({ binLink: LINK, registryDir: DIR, io })();
    expect(io.opened).toEqual([]);
    expect(snapshot.registry?.size).toBe(0);
  });

  it('dwa pidy z jednym uuid zostają OBA — to sygnał dwóch pisarzy, nie do uśrednienia', async () => {
    const io = fakeIo({
      files: {
        [`${DIR}/10.json`]: registryText(10, UUID_A, '2.1.283'),
        [`${DIR}/11.json`]: registryText(11, UUID_A, '2.1.280'),
      },
      alive: [10, 11],
    });
    const snapshot = await createCliVersionReader({ binLink: LINK, registryDir: DIR, io })();
    expect(snapshot.registry?.get(UUID_A)).toHaveLength(2);
    expect(runningCliVersion(snapshot.registry, UUID_A)).toBe('2.1.280');
  });

  it('brak katalogu rejestru to `null` („nie wiem"), a nie pusta mapa', async () => {
    const io = fakeIo({ failReaddir: true });
    expect((await createCliVersionReader({ binLink: LINK, registryDir: DIR, io })()).registry)
      .toBeNull();
  });

  it('„nieznany kształt" leci RAZ i nie cytuje treści rejestru', async () => {
    const lines: string[] = [];
    const io = fakeIo({
      files: { [`${DIR}/12.json`]: JSON.stringify({ pid: 12, sesja: 'SEKRETNY-TEKST' }) },
      alive: [12],
    });
    const reader = createCliVersionReader({
      binLink: LINK, registryDir: DIR, io, logger: (line) => { lines.push(line); },
    });
    await reader();
    await reader();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(CLI_REGISTRY_UNKNOWN_SHAPE_LOG);
    expect(lines[0]).not.toContain('SEKRETNY');
  });

  it('pusty rejestr bez żywych procesów nie jest „nieznanym kształtem"', async () => {
    const lines: string[] = [];
    const io = fakeIo({ files: {} });
    await createCliVersionReader({
      binLink: LINK, registryDir: DIR, io, logger: (line) => { lines.push(line); },
    })();
    expect(lines).toEqual([]);
  });
});

describe('cliUpdateFor i porównanie wydań', () => {
  it('porównuje liczbowo, nie leksykalnie', () => {
    expect(compareCliVersions('2.1.283', '2.1.280')).toBeGreaterThan(0);
    expect(compareCliVersions('2.1.99', '2.1.100')).toBeLessThan(0);
    expect(compareCliVersions('2.10.0', '2.9.9')).toBeGreaterThan(0);
    expect(compareCliVersions('2.1.283', '2.1.283')).toBe(0);
  });

  it('znacznik tylko przy wydaniu zainstalowanym NOWSZYM', () => {
    expect(cliUpdateFor('2.1.280', '2.1.283')).toEqual({ running: '2.1.280', installed: '2.1.283' });
    expect(cliUpdateFor('2.1.283', '2.1.283')).toBeUndefined();
    // Ręczny rollback instalacji: restart byłby cofnięciem, więc cisza.
    expect(cliUpdateFor('2.1.283', '2.1.280')).toBeUndefined();
    expect(cliUpdateFor(undefined, '2.1.283')).toBeUndefined();
    expect(cliUpdateFor('2.1.280', null)).toBeUndefined();
  });

  it('runningCliVersion: brak rejestru albo sesji to `undefined`', () => {
    const registry: CliRegistry = new Map([[UUID_A, [{ pid: 1, version: '2.1.281', status: 'idle' }]]]);
    expect(runningCliVersion(null, UUID_A)).toBeUndefined();
    expect(runningCliVersion(registry, undefined)).toBeUndefined();
    expect(runningCliVersion(registry, UUID_B)).toBeUndefined();
    expect(runningCliVersion(registry, UUID_A)).toBe('2.1.281');
  });
});

/**
 * Czas startu procesu jako dowód dla maszyny stanów zadań w tle. Liczy się WYŁĄCZNIE przy
 * jednym żywym procesie rozmowy: przy dwóch pisarzach nie wiadomo, w którym żyje subagent.
 */
describe('cliProcessStartOf — start JEDYNEGO procesu rozmowy', () => {
  const entry = (pid: number, startedAt?: number) => ({
    pid, version: '2.1.296', status: 'idle', ...(startedAt === undefined ? {} : { startedAt }),
  });

  it('jeden żywy proces ze znanym czasem → ten czas', () => {
    const registry: CliRegistry = new Map([[UUID_A, [entry(1, STARTED_AT)]]]);
    expect(cliProcessStartOf({ registry }, UUID_A)).toBe(STARTED_AT);
    expect(cliProcessStartOf({ registry, unreadablePids: 0 }, UUID_A)).toBe(STARTED_AT);
  });

  it('dwóch pisarzy, wpis bez czasu, brak wpisu, brak rejestru i brak uuid to „nie wiem”', () => {
    const two: CliRegistry = new Map([[UUID_A, [entry(1, STARTED_AT), entry(2, STARTED_AT + 60_000)]]]);
    expect(cliProcessStartOf({ registry: two }, UUID_A)).toBeUndefined();
    expect(cliProcessStartOf({ registry: two }, UUID_B)).toBeUndefined();
    expect(cliProcessStartOf({ registry: new Map([[UUID_A, [entry(1)]]]) }, UUID_A)).toBeUndefined();
    expect(cliProcessStartOf({ registry: new Map([[UUID_A, []]]) }, UUID_A)).toBeUndefined();
    expect(cliProcessStartOf({ registry: null }, UUID_A)).toBeUndefined();
    expect(cliProcessStartOf({ registry: two }, undefined)).toBeUndefined();
  });

  /**
   * „Jeden wpis rozmowy” to nie to samo co „jeden proces rozmowy”:
   * rejestr liczy wpisy, które się SPARSOWAŁY. Żywy proces z nieczytelnym plikiem może być drugim
   * pisarzem tej rozmowy, a jego subagent żyje. Wniosek „jedyny” zamknąłby go na dobre.
   */
  it('żywy pid z nieczytelnym plikiem rejestru to „nie wiem” dla KAŻDEJ rozmowy', () => {
    const registry: CliRegistry = new Map([[UUID_A, [entry(11, STARTED_AT + 7_200_000)]]]);
    expect(cliProcessStartOf({ registry, unreadablePids: 1 }, UUID_A)).toBeUndefined();
  });

  it('żywy proces bez pliku rejestru to „nie wiem” dla SWOJEJ rozmowy', () => {
    const registry: CliRegistry = new Map([
      [UUID_A, [entry(11, STARTED_AT + 60_000)]], [UUID_B, [entry(12, STARTED_AT)]],
    ]);
    const read = { registry, unlistedSessions: new Set([UUID_A]) };
    expect(cliProcessStartOf(read, UUID_A)).toBeUndefined();
    expect(cliProcessStartOf(read, UUID_B)).toBe(STARTED_AT);
  });

  it('czytnik liczy żywe pidy bez wpisu: plik w pół zapisu, nieznany kształt, plik ponad limit', async () => {
    // Pid 10 wystartował wcześniej i pisze tę samą rozmowę co pid 11, ale jego plik jest w pół zapisu.
    const files: Record<string, string> = {
      [`${DIR}/10.json`]: '{"pid":10,"sessionId":"',
      [`${DIR}/11.json`]: registryText(11, UUID_A, '2.1.296', 'idle', STARTED_AT + 7_200_000),
    };
    const io = fakeIo({ files, alive: [10, 11] });
    const read = createCliVersionReader({ binLink: LINK, registryDir: DIR, io });
    const partial = await read();
    expect(partial.registry?.get(UUID_A)).toHaveLength(1);
    expect(partial.unreadablePids).toBe(1);
    expect(cliProcessStartOf(partial, UUID_A)).toBeUndefined();

    // Poprawny odczyt obu plików: dwóch pisarzy, dalej „nie wiem”, ale już z innego powodu.
    files[`${DIR}/10.json`] = registryText(10, UUID_A, '2.1.296', 'idle', STARTED_AT);
    const both = await read();
    expect(both.unreadablePids).toBe(0);
    expect(both.registry?.get(UUID_A)).toHaveLength(2);
    expect(cliProcessStartOf(both, UUID_A)).toBeUndefined();

    // Nieznany kształt (brak `status`) i plik ponad limit liczą się tak samo; martwy pid nie.
    const odd = fakeIo({
      files: {
        [`${DIR}/20.json`]: JSON.stringify({ pid: 20, sessionId: UUID_B, version: '2.1.296' }),
        [`${DIR}/21.json`]: registryText(21, UUID_B, '2.1.296') + ' '.repeat(CLI_REGISTRY_MAX_BYTES),
        [`${DIR}/22.json`]: '{',
        [`${DIR}/23.json`]: registryText(23, UUID_A, '2.1.296'),
      },
      alive: [20, 21, 23],
    });
    const snapshot = await createCliVersionReader({ binLink: LINK, registryDir: DIR, io: odd })();
    expect(snapshot.unreadablePids).toBe(2);
    expect(cliProcessStartOf(snapshot, UUID_A)).toBeUndefined();
  });

  /**
   * Plik rejestru potrafi zniknąć PRZED procesem (po
   * `/exit` wpis znika z rejestru, zmierzone na 2.1.312; ktoś posprzątał katalog). Proces bez pliku dalej
   * może pisać rozmowę, więc dopóki żyje, wpis drugiego procesu tej rozmowy nie dowodzi, że pisze ją jeden.
   */
  it('plik rejestru zniknął, a proces żyje: „nie wiem” dla JEGO rozmowy, dopóki żyje', async () => {
    const files: Record<string, string> = {
      [`${DIR}/10.json`]: registryText(10, UUID_A, '2.1.296', 'idle', STARTED_AT),
      [`${DIR}/11.json`]: registryText(11, UUID_A, '2.1.296', 'idle', STARTED_AT + 60_000),
      [`${DIR}/12.json`]: registryText(12, UUID_B, '2.1.296', 'idle', STARTED_AT + 5_000),
    };
    const alive = [10, 11, 12];
    const io = fakeIo({ files, alive });
    const read = createCliVersionReader({ binLink: LINK, registryDir: DIR, io });
    const both = await read();
    expect(both.unlistedSessions).toEqual(new Set());
    expect(cliProcessStartOf(both, UUID_A)).toBeUndefined();

    // Plik starszego pisarza znika, pid żyje: młodszy NIE jest przez to jedynym pisarzem.
    delete files[`${DIR}/10.json`];
    const vanished = await read();
    expect(vanished.registry?.get(UUID_A)).toHaveLength(1);
    expect(vanished.unlistedSessions).toEqual(new Set([UUID_A]));
    expect(cliProcessStartOf(vanished, UUID_A)).toBeUndefined();
    // Inna rozmowa nie płaci za cudzy zniknięty plik.
    expect(cliProcessStartOf(vanished, UUID_B)).toBe(STARTED_AT + 5_000);
    // Stan trwa tak długo, jak żyje proces, także przy szybkim odczycie z pamięcią `stat`.
    expect((await read({ registryOnly: true })).unlistedSessions).toEqual(new Set([UUID_A]));

    // Proces się skończył: zostaje jeden pisarz i jego start jest już dowodem.
    alive.splice(alive.indexOf(10), 1);
    const gone = await read();
    expect(gone.unlistedSessions).toEqual(new Set());
    expect(cliProcessStartOf(gone, UUID_A)).toBe(STARTED_AT + 60_000);
  });

  it('zwykłe wyjście z CLI (plik i proces znikają razem) nie zostawia śladu; plik, który wrócił, też', async () => {
    const files: Record<string, string> = {
      [`${DIR}/10.json`]: registryText(10, UUID_A, '2.1.296', 'idle', STARTED_AT),
    };
    const alive = [10];
    const io = fakeIo({ files, alive });
    const read = createCliVersionReader({ binLink: LINK, registryDir: DIR, io });
    await read();

    // `/exit` i `claude --resume`: stary pid i jego plik znikają, nowy proces pisze tę samą rozmowę.
    delete files[`${DIR}/10.json`];
    files[`${DIR}/20.json`] = registryText(20, UUID_A, '2.1.296', 'idle', STARTED_AT + 90_000);
    alive.splice(0, 1, 20);
    const resumed = await read();
    expect(resumed.unlistedSessions).toEqual(new Set());
    expect(cliProcessStartOf(resumed, UUID_A)).toBe(STARTED_AT + 90_000);

    // Plik żywego procesu zniknął na jeden odczyt i wrócił: rozmowa znów ma zwykły wpis.
    delete files[`${DIR}/20.json`];
    expect((await read()).unlistedSessions).toEqual(new Set([UUID_A]));
    files[`${DIR}/20.json`] = registryText(20, UUID_A, '2.1.296', 'busy', STARTED_AT + 90_000);
    const back = await read();
    expect(back.unlistedSessions).toEqual(new Set());
    expect(cliProcessStartOf(back, UUID_A)).toBe(STARTED_AT + 90_000);
  });

  it('błąd `readdir` nie kasuje pamięci pisarzy: po powrocie katalogu żywy pid bez pliku dalej blokuje', async () => {
    const files: Record<string, string> = {
      [`${DIR}/10.json`]: registryText(10, UUID_A, '2.1.296', 'idle', STARTED_AT),
      [`${DIR}/11.json`]: registryText(11, UUID_A, '2.1.296', 'idle', STARTED_AT + 60_000),
    };
    const fs: FakeFs = { files, alive: [10, 11] };
    const read = createCliVersionReader({ binLink: LINK, registryDir: DIR, io: fakeIo(fs) });
    expect((await read()).registry?.get(UUID_A)).toHaveLength(2);

    // Katalog na chwilę nieczytelny, a w tym czasie znika plik starszego pisarza.
    fs.failReaddir = true;
    delete files[`${DIR}/10.json`];
    const broken = await read();
    expect(broken.registry).toBeNull();
    expect(cliProcessStartOf(broken, UUID_A)).toBeUndefined();

    fs.failReaddir = false;
    const back = await read();
    expect(back.registry?.get(UUID_A)).toHaveLength(1);
    expect(back.unlistedSessions).toEqual(new Set([UUID_A]));
    expect(cliProcessStartOf(back, UUID_A)).toBeUndefined();
  });

  it('brak katalogu rejestru: zero nieczytelnych pidów i „nie wiem” z braku rejestru', async () => {
    const snapshot = await createCliVersionReader({
      binLink: LINK, registryDir: DIR, io: fakeIo({ failReaddir: true }),
    })();
    expect(snapshot.registry).toBeNull();
    expect(snapshot.unreadablePids).toBe(0);
    expect(cliProcessStartOf(snapshot, UUID_A)).toBeUndefined();
  });

  it('czytnik oddaje czas z pliku: po restarcie procesu (nowy pid) wartość jest nowa', async () => {
    const files: Record<string, string> = {
      [`${DIR}/2142.json`]: registryText(2142, UUID_A, '2.1.296', 'idle', STARTED_AT),
    };
    const alive = [2142];
    const io = fakeIo({ files, alive });
    const read = createCliVersionReader({ binLink: LINK, registryDir: DIR, io });
    expect(cliProcessStartOf(await read(), UUID_A)).toBe(STARTED_AT);

    // `/exit` i `claude --resume`: stary pid znika, nowy proces pisze tę samą rozmowę.
    delete files[`${DIR}/2142.json`];
    files[`${DIR}/2200.json`] = registryText(2200, UUID_A, '2.1.296', 'idle', STARTED_AT + 90_000);
    alive.splice(0, 1, 2200);
    expect(cliProcessStartOf(await read(), UUID_A)).toBe(STARTED_AT + 90_000);
  });
});

/*
 * `~/.claude/sessions/` jest zapisywalny z sandboksa sesji (pomiar na CLI 2.1.311), więc
 * plik rejestru podmieniony na FIFO zajmowałby wątek puli libuv bez końca. Domyślne wejście czyta wyłącznie plik
 * zwykły w sufit {@link CLI_REGISTRY_MAX_BYTES}; reprodukcja w procesie potomnym (`child-limit.ts`).
 */
describe('DEFAULT_CLI_VERSION_IO.readFile — tylko zwykły plik', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rarog-cli-rejestr-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('FIFO pod nazwą pliku rejestru: odczyt odmawia, bez zawieszenia', async () => {
    const fifo = join(dir, '2142.json');
    execFileSync('mkfifo', [fifo]);
    const result = childJson<{ refused: boolean }>(await runInChild(dir, `
import { DEFAULT_CLI_VERSION_IO } from ${serverModule('cli-version.ts')};
const refused = await DEFAULT_CLI_VERSION_IO.readFile(${JSON.stringify(fifo)}).then(() => false, () => true);
console.log(JSON.stringify({ refused }));
process.exit(0);
`));
    expect(result).toEqual({ refused: true });
  }, CHILD_TEST_TIMEOUT_MS);

  it('zwykły plik ponad sufit też jest odmową, a plik w sufit wraca jako tekst', async () => {
    await writeFile(join(dir, 'duzy.json'), 'x'.repeat(CLI_REGISTRY_MAX_BYTES + 1));
    await expect(DEFAULT_CLI_VERSION_IO.readFile(join(dir, 'duzy.json'))).rejects.toThrow();
    await writeFile(join(dir, 'maly.json'), '{"pid":1}');
    expect(await DEFAULT_CLI_VERSION_IO.readFile(join(dir, 'maly.json'))).toBe('{"pid":1}');
  });
});
