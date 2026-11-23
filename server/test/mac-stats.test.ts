/**
 * Próbnik obciążenia Maca: czyste przeliczenia procentów
 * i rytm próbek na wstrzykniętych źródłach i timerach — bez `sysctl` i bez prawdziwego dysku.
 */
import { execFile } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import {
  CPU_SAMPLE_MS, CPU_WINDOW, DISK_SAMPLE_MS, RAM_SAMPLE_MS, busyPercent, createMacStats, diskUsedPercent,
  meminfoFreePercent, memoryUsedPercent, readMemoryLevel, roundStep, systemSources,
} from '../src/mac-stats.ts';
import type { CpuTimes, DiskBlocks, MacStatsSources } from '../src/mac-stats.ts';

/*
 * Atrapa `execFile`: odczyt pamięci z systemu ma się dać sprawdzić bez prawdziwego `sysctl`, a „bez
 * spawnu" znaczy tu dosłownie „bez wywołania `execFile`". Reszta testów jedzie na wstrzykniętych
 * źródłach i atrapy nie dotyka.
 */
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: vi.fn((
      _file: string, _args: readonly string[], _options: unknown,
      callback: (error: Error | null, stdout: string) => void,
    ) => { callback(null, '72\n'); }),
  };
});

describe('przeliczenia', () => {
  it('zaokrągla do 5 punktów w klamrze 0–100; nieskończoność = brak', () => {
    expect(roundStep(32.4)).toBe(30);
    expect(roundStep(32.5)).toBe(35);
    expect(roundStep(-3)).toBe(0);
    expect(roundStep(140)).toBe(100);
    expect(roundStep(Number.NaN)).toBeUndefined();
  });

  it('CPU: zajęte między próbkami; brak upływu czasu albo cofnięty licznik = brak', () => {
    expect(busyPercent({ busy: 100, total: 1000 }, { busy: 400, total: 2000 })).toBe(30);
    expect(busyPercent({ busy: 100, total: 1000 }, { busy: 100, total: 1000 })).toBeNull();
    expect(busyPercent({ busy: 500, total: 1000 }, { busy: 400, total: 2000 })).toBeNull();
  });

  it('RAM: `kern.memorystatus_level` to procent WOLNEJ; śmieci odrzucone', () => {
    expect(memoryUsedPercent('72\n')).toBe(28);
    expect(memoryUsedPercent('0')).toBe(100);
    expect(memoryUsedPercent('101')).toBeNull();
    expect(memoryUsedPercent('abc')).toBeNull();
    expect(memoryUsedPercent('')).toBeNull();
  });

  it('dysk liczony jak `df`: rezerwa roota poza zajętymi i dostępnymi', () => {
    // 1000 bloków, 300 wolnych, z czego 250 dostępnych: zajęte 700 / (700 + 250).
    expect(diskUsedPercent({ blocks: 1000, bfree: 300, bavail: 250 })).toBeCloseTo((700 / 950) * 100);
    expect(diskUsedPercent({ blocks: 0, bfree: 0, bavail: 0 })).toBeNull();
  });
});

/** Timery jako lista wywołań — test sam decyduje, który takt nadchodzi. */
function harness(sources: MacStatsSources): {
  tick: (ms: number) => Promise<void>;
  sampler: ReturnType<typeof createMacStats>;
  intervals: number[];
  cleared: number;
} {
  const timers: { cb: () => void; ms: number }[] = [];
  let cleared = 0;
  const sampler = createMacStats({
    sources,
    setInterval: (cb, ms) => {
      timers.push({ cb, ms });
      return timers.length - 1;
    },
    clearInterval: () => { cleared += 1; },
  });
  return {
    sampler,
    intervals: timers.map((t) => t.ms),
    get cleared() { return cleared; },
    tick: async (ms: number) => {
      for (const timer of timers) if (timer.ms === ms) timer.cb();
      await new Promise((resolve) => { setImmediate(resolve); });
    },
  };
}

const MEMINFO = [
  'MemTotal:        3940000 kB',
  'MemFree:          120000 kB',
  'MemAvailable:    2955000 kB',
  'Buffers:           50000 kB',
  'Cached:          2600000 kB',
  '',
].join('\n');

describe('memory on Linux (`/proc/meminfo`)', () => {
  it('free = MemAvailable / MemTotal, page cache counts as free', () => {
    expect(meminfoFreePercent(MEMINFO)).toBe('75');
    expect(memoryUsedPercent(meminfoFreePercent(MEMINFO) ?? '')).toBe(25);
  });

  it('bounds: nothing available = 0 % free, all available = 100 % free', () => {
    expect(meminfoFreePercent('MemTotal: 1000 kB\nMemAvailable: 0 kB\n')).toBe('0');
    expect(meminfoFreePercent('MemTotal: 1000 kB\nMemAvailable: 1000 kB\n')).toBe('100');
  });

  it('a missing or nonsensical counter gives `null`', () => {
    const without = (name: string): string => MEMINFO.split('\n').filter((l) => !l.startsWith(`${name}:`)).join('\n');
    expect(meminfoFreePercent(without('MemAvailable'))).toBeNull();
    expect(meminfoFreePercent(without('MemTotal'))).toBeNull();
    expect(meminfoFreePercent('MemTotal: 0 kB\nMemAvailable: 0 kB\n')).toBeNull();
    expect(meminfoFreePercent('MemTotal: 100 kB\nMemAvailable: 200 kB\n')).toBeNull();
    expect(meminfoFreePercent('')).toBeNull();
  });

  it('`readMemoryLevel` on Linux reads `/proc/meminfo` without a spawn; an unreadable file gives `null`', async () => {
    expect(await readMemoryLevel('linux', () => Promise.resolve(MEMINFO))).toBe('75');
    expect(await readMemoryLevel('linux', () => Promise.resolve(null))).toBeNull();
    expect(vi.mocked(execFile)).not.toHaveBeenCalled();
  });
});

describe('odczyt pamięci z systemu (`kern.memorystatus_level`)', () => {
  it('outside macOS and Linux `null` without a `sysctl` spawn', async () => {
    for (const platform of ['freebsd', 'win32'] as const) {
      expect(await readMemoryLevel(platform), platform).toBeNull();
    }
    expect(vi.mocked(execFile)).not.toHaveBeenCalled();
  });

  it('źródło systemowe próbnika na `process.platform` innym niż `darwin` i `linux`: `null` bez spawnu', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'freebsd', configurable: true });
    try {
      expect(await systemSources.memoryLevel()).toBeNull();
    } finally {
      if (original !== undefined) Object.defineProperty(process, 'platform', original);
    }
    expect(process.platform).toBe(original?.value);
    expect(vi.mocked(execFile)).not.toHaveBeenCalled();
  });

  it('na macOS jedno `/usr/sbin/sysctl -n kern.memorystatus_level`', async () => {
    expect(await readMemoryLevel('darwin')).toBe('72\n');
    expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(execFile).mock.calls[0]?.slice(0, 2))
      .toEqual(['/usr/sbin/sysctl', ['-n', 'kern.memorystatus_level']]);
  });
});

describe('createMacStats', () => {
  it('rytm 10/30/60 s; CPU dopiero po pierwszym takcie, potem średnia z minuty', async () => {
    let cpu: CpuTimes = { busy: 0, total: 0 };
    const h = harness({
      cpuTimes: () => cpu,
      memoryLevel: () => Promise.resolve('60'),
      disk: () => Promise.resolve({ blocks: 100, bfree: 50, bavail: 50 }),
    });
    expect(h.intervals.sort((a, b) => a - b)).toEqual([CPU_SAMPLE_MS, RAM_SAMPLE_MS, DISK_SAMPLE_MS]);
    await new Promise((resolve) => { setImmediate(resolve); });
    // Pierwsze odczyty RAM i dysku od razu; CPU jeszcze bez punktu odniesienia.
    expect(h.sampler.current()).toEqual({ ram: 40, disk: 50 });

    cpu = { busy: 900, total: 1000 }; // 90 %
    await h.tick(CPU_SAMPLE_MS);
    expect(h.sampler.current().cpu).toBe(90);
    // Pięć cichych próbek (10 %) — średnia z sześciu: (90 + 5 × 10) / 6 ≈ 23,3 → 25.
    for (let i = 0; i < 5; i += 1) {
      cpu = { busy: cpu.busy + 100, total: cpu.total + 1000 };
      await h.tick(CPU_SAMPLE_MS);
    }
    expect(h.sampler.current().cpu).toBe(25);
    // Siódma cicha próbka wypycha szczyt z okna: sześć razy 10 %.
    cpu = { busy: cpu.busy + 100, total: cpu.total + 1000 };
    await h.tick(CPU_SAMPLE_MS);
    expect(CPU_WINDOW).toBe(6);
    expect(h.sampler.current().cpu).toBe(10);
  });

  it('błąd odczytu zdejmuje pole; źródło, które rzuca, nie wywraca próbnika', async () => {
    let level: string | null = '50';
    let disk: DiskBlocks | null = { blocks: 100, bfree: 20, bavail: 20 };
    const h = harness({
      cpuTimes: () => { throw new Error('brak'); },
      memoryLevel: () => Promise.resolve(level),
      disk: () => (disk === null ? Promise.reject(new Error('EIO')) : Promise.resolve(disk)),
    });
    await new Promise((resolve) => { setImmediate(resolve); });
    expect(h.sampler.current()).toEqual({ ram: 50, disk: 80 });
    level = null;
    disk = null;
    await h.tick(RAM_SAMPLE_MS);
    await h.tick(DISK_SAMPLE_MS);
    await h.tick(CPU_SAMPLE_MS);
    expect(h.sampler.current()).toEqual({});
  });

  it('niepoprawna próbka CPU (czas stoi, licznik się cofnął) kasuje liczbę i okno — bez starej średniej', async () => {
    let cpu: CpuTimes = { busy: 0, total: 0 };
    const h = harness({
      cpuTimes: () => cpu,
      memoryLevel: () => Promise.resolve('60'),
      disk: () => Promise.resolve({ blocks: 100, bfree: 50, bavail: 50 }),
    });
    cpu = { busy: 800, total: 1000 }; // 80 %
    await h.tick(CPU_SAMPLE_MS);
    expect(h.sampler.current().cpu).toBe(80);
    // Licznik cofnięty (np. po uśpieniu) — średnia z okna opisywałaby minutę sprzed próbki.
    cpu = { busy: 100, total: 500 };
    await h.tick(CPU_SAMPLE_MS);
    expect(h.sampler.current()).toEqual({ ram: 40, disk: 50 });
    // Następny takt liczy od cofniętej próbki i od pustego okna: 10 %, nie (80 + 10) / 2.
    cpu = { busy: 200, total: 1500 };
    await h.tick(CPU_SAMPLE_MS);
    expect(h.sampler.current().cpu).toBe(10);
    // Czas stoi (ta sama próbka) — to samo: brak liczby do następnego taktu.
    await h.tick(CPU_SAMPLE_MS);
    expect(h.sampler.current().cpu).toBeUndefined();
    // Zero to poprawna wartość (Mac w spoczynku), nie brak — i znów tylko z tej próbki.
    cpu = { busy: 200, total: 2500 };
    await h.tick(CPU_SAMPLE_MS);
    expect(h.sampler.current().cpu).toBe(0);
  });

  it('`close` zatrzymuje wszystkie trzy timery i jest idempotentne', () => {
    const h = harness({
      cpuTimes: () => null, memoryLevel: () => Promise.resolve(null), disk: () => Promise.resolve(null),
    });
    h.sampler.close();
    h.sampler.close();
    expect(h.cleared).toBe(3);
  });
});
