/**
 * Obciążenie Maca — CPU, RAM i dysk w procentach ZAJĘTYCH.
 *
 * JEDEN próbnik na proces, zakładany w `index.ts` (zamykany przy wyjściu serwera) i czytany przez dwóch
 * odbiorców: `GET /api/mac` (stopka listy apki natywnej) i Live Activity. Działa także przy
 * `RAROG_PUSH=0` i bez kanału APNs. Sam nikomu niczego nie wysyła: Live Activity bierze bieżące liczby
 * przy KAŻDEJ wysyłce, której powodem jest coś innego (zmiana liczników, workflow, limitów) albo
 * heartbeat. Zmiana samego obciążenia nie budzi wysyłki — CPU zmienia się co sekundę, a każda
 * aktualizacja kafla to push APNs z budżetu, którego Apple nie publikuje (stąd rytm 10/30/60 s,
 * bez natychmiastowego alarmu).
 *
 * Źródła (pomiar na tym Macu):
 * - CPU — różnica czasów `os.cpus()` między próbkami co 10 s, średnia z ostatniej minuty (6 próbek).
 *   Pojedyncza próbka skacze, a kafel może wisieć 10 min bez aktualizacji — średnia mniej kłamie;
 * - RAM — macOS: `sysctl -n kern.memorystatus_level` to procent pamięci WOLNEJ w rozumieniu systemu (to, co
 *   pokazuje Monitor aktywności jako presję). `os.freemem()` myli: 5,7 GB „wolnego" przy 72 % wolnego
 *   według jądra, bo nie liczy pamięci podręcznej, którą system odda na żądanie. Linux: `MemAvailable` /
 *   `MemTotal` from `/proc/meminfo` ({@link meminfoFreePercent});
 * - dysk — `fs.statfs` na woluminie danych (`/System/Volumes/Data`; poza macOS `/`), zajęte liczone jak
 *   `df`: (bloki − wolne) / (bloki − wolne + dostępne dla użytkownika).
 *
 * Wszystko zaokrąglone do 5 punktów: kafel pokazuje rząd wielkości, a drobne wahania i tak by zastygły
 * do następnej wysyłki. Błąd odczytu = pole nieobecne (kafel nie pokazuje liczby, której nie zna).
 * **Ten moduł nigdy nie rzuca** — timery są `unref`, zamknięcie serwera ich nie czeka.
 */
import { execFile } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import { cpus } from 'node:os';
import { readRegularFile } from './safe-read.ts';

/** Co ile próbka CPU. */
export const CPU_SAMPLE_MS = 10_000;
/** Co ile odczyt pamięci. */
export const RAM_SAMPLE_MS = 30_000;
/** Co ile odczyt dysku. */
export const DISK_SAMPLE_MS = 60_000;
/** Ile próbek CPU składa się na średnią (6 × 10 s = minuta). */
export const CPU_WINDOW = 6;
/** Krok zaokrąglenia procentów. */
export const MAC_STATS_STEP = 5;
/** Wolumin danych macOS — ten sam, który `df` pokazuje jako dysk użytkownika. */
export const DATA_VOLUME = '/System/Volumes/Data';
/** Sufit czasu `sysctl` — odczyt trwa milisekundy, dłużej znaczy „coś nie tak". */
const SYSCTL_TIMEOUT_MS = 2_000;

/** Zajęte w procentach (0–100, krok {@link MAC_STATS_STEP}); brak pola = brak odczytu. */
export interface MacStats {
  cpu?: number;
  ram?: number;
  disk?: number;
}

/** Suma czasów wszystkich rdzeni: zajęte i całość (ms). */
export interface CpuTimes {
  busy: number;
  total: number;
}

/** Bloki woluminu w kształcie `fs.statfs` (liczby — Node oddaje je jako `number`). */
export interface DiskBlocks {
  blocks: number;
  bfree: number;
  bavail: number;
}

/** Źródła odczytów — wstrzykiwane w testach. Każde może zawieść; wtedy oddaje `null`. */
export interface MacStatsSources {
  cpuTimes(): CpuTimes | null;
  /** Raw percent of free memory (`readMemoryLevel`). */
  memoryLevel(): Promise<string | null>;
  disk(): Promise<DiskBlocks | null>;
}

export interface MacStatsOptions {
  readonly sources?: MacStatsSources;
  readonly setInterval?: (cb: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
}

export interface MacStatsSampler {
  /** Ostatnie znane wartości (kopia). */
  current(): MacStats;
  /** Zatrzymuje timery (graceful shutdown). */
  close(): void;
}

/** Procent → krok {@link MAC_STATS_STEP}, w klamrze 0–100; liczba nieskończona = brak. */
export function roundStep(percent: number): number | undefined {
  if (!Number.isFinite(percent)) return undefined;
  const clamped = Math.min(100, Math.max(0, percent));
  return Math.round(clamped / MAC_STATS_STEP) * MAC_STATS_STEP;
}

/** Zajęte procent CPU między dwiema próbkami; `null`, gdy czas nie płynął (albo licznik się cofnął). */
export function busyPercent(previous: CpuTimes, next: CpuTimes): number | null {
  const total = next.total - previous.total;
  const busy = next.busy - previous.busy;
  if (!(total > 0) || busy < 0) return null;
  return Math.min(100, (busy / total) * 100);
}

/** `kern.memorystatus_level` (procent WOLNEJ) → procent zajętej; śmieci = `null`. */
export function memoryUsedPercent(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d{1,3}$/.test(text)) return null;
  const free = Number(text);
  return free > 100 ? null : 100 - free;
}

/** Zajęte procent woluminu jak `df` (wolne dla roota nie liczą się ani do zajętych, ani do dostępnych). */
export function diskUsedPercent(blocks: DiskBlocks): number | null {
  const used = blocks.blocks - blocks.bfree;
  const size = used + blocks.bavail;
  if (!(size > 0) || used < 0) return null;
  return (used / size) * 100;
}

function systemCpuTimes(): CpuTimes | null {
  const cores = cpus();
  if (cores.length === 0) return null;
  let busy = 0;
  let total = 0;
  for (const { times } of cores) {
    const working = times.user + times.nice + times.sys + times.irq;
    busy += working;
    total += working + times.idle;
  }
  return { busy, total };
}

/** Linux kernel memory counters; `MemAvailable` is the kernel's estimate of memory free for new work. */
export const PROC_MEMINFO = '/proc/meminfo';

/** Ceiling of the `/proc/meminfo` read: the file is about 1.5 kB. */
const MEMINFO_MAX_BYTES = 16_384;

/**
 * `/proc/meminfo` → percent FREE as an integer string, the shape of `kern.memorystatus_level`, so the rest of
 * the sampler does not care which system it came from. Free = `MemAvailable` / `MemTotal` (page cache the kernel
 * gives back on demand counts as free, as on macOS); a missing or nonsensical counter = `null`.
 */
export function meminfoFreePercent(text: string): string | null {
  const kib = (name: string): number | null => {
    const match = new RegExp(`^${name}:\\s+(\\d+) kB$`, 'm').exec(text);
    return match === null ? null : Number(match[1]);
  };
  const total = kib('MemTotal');
  const available = kib('MemAvailable');
  if (total === null || available === null || !(total > 0) || available > total) return null;
  return String(Math.round((available / total) * 100));
}

async function readProcMeminfo(): Promise<string | null> {
  try {
    const read = await readRegularFile(PROC_MEMINFO, { maxBytes: MEMINFO_MAX_BYTES, followSymlink: false });
    return read === null || read.truncated ? null : read.bytes.toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Percent of FREE memory as a raw integer string, or `null`.
 *
 * macOS: `sysctl -n kern.memorystatus_level`. Linux: computed from `/proc/meminfo` ({@link meminfoFreePercent}).
 * Any other system returns at once without a spawn; RAM then drops out of the reading like any failure.
 *
 * @param platform injectable system (tests); production takes `process.platform`.
 * @param meminfo injectable `/proc/meminfo` reader (tests).
 */
export function readMemoryLevel(
  platform: NodeJS.Platform = process.platform,
  meminfo: () => Promise<string | null> = readProcMeminfo,
): Promise<string | null> {
  if (platform === 'linux') return meminfo().then((text) => (text === null ? null : meminfoFreePercent(text)));
  if (platform !== 'darwin') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      execFile(
        '/usr/sbin/sysctl', ['-n', 'kern.memorystatus_level'],
        { timeout: SYSCTL_TIMEOUT_MS, encoding: 'utf8' },
        (error, stdout) => { resolve(error === null ? stdout : null); },
      );
    } catch {
      resolve(null);
    }
  });
}

async function systemDisk(): Promise<DiskBlocks | null> {
  for (const path of [DATA_VOLUME, '/']) {
    try {
      const info = await statfs(path);
      return { blocks: Number(info.blocks), bfree: Number(info.bfree), bavail: Number(info.bavail) };
    } catch {
      // Poza macOS woluminu danych nie ma — wtedy korzeń.
    }
  }
  return null;
}

export const systemSources: MacStatsSources = {
  cpuTimes: systemCpuTimes,
  memoryLevel: () => readMemoryLevel(),
  disk: systemDisk,
};

export function createMacStats(options: MacStatsOptions = {}): MacStatsSampler {
  const sources = options.sources ?? systemSources;
  const startTimer = options.setInterval
    ?? ((cb, ms): unknown => {
      const handle = setInterval(cb, ms);
      if (typeof handle.unref === 'function') handle.unref();
      return handle;
    });
  const stopTimer = options.clearInterval ?? ((handle): void => { clearInterval(handle as NodeJS.Timeout); });

  const stats: MacStats = {};
  const cpuSamples: number[] = [];
  let previousCpu: CpuTimes | null = null;
  let closed = false;

  const sampleCpu = (): void => {
    let next: CpuTimes | null;
    try {
      next = sources.cpuTimes();
    } catch {
      next = null;
    }
    if (next === null) {
      previousCpu = null;
      cpuSamples.length = 0;
      delete stats.cpu;
      return;
    }
    const first = previousCpu === null;
    const percent = previousCpu === null ? null : busyPercent(previousCpu, next);
    previousCpu = next;
    if (percent === null) {
      // Próbka bez upływu czasu albo z cofniętym licznikiem (uśpienie, przepełnienie): średnia z okna
      // opisywałaby minutę sprzed niej, a apka i kafel pokazałyby starą liczbę jak świeżą. Okno liczy
      // się od nowa od tej próbki; do następnego taktu CPU nie ma (to samo co przy starcie).
      if (!first) {
        cpuSamples.length = 0;
        delete stats.cpu;
      }
      return;
    }
    cpuSamples.push(percent);
    if (cpuSamples.length > CPU_WINDOW) cpuSamples.shift();
    const average = cpuSamples.reduce((sum, value) => sum + value, 0) / cpuSamples.length;
    const rounded = roundStep(average);
    if (rounded === undefined) delete stats.cpu;
    else stats.cpu = rounded;
  };

  const sampleRam = async (): Promise<void> => {
    let raw: string | null;
    try {
      raw = await sources.memoryLevel();
    } catch {
      raw = null;
    }
    if (closed) return;
    const used = raw === null ? null : memoryUsedPercent(raw);
    const rounded = used === null ? undefined : roundStep(used);
    if (rounded === undefined) delete stats.ram;
    else stats.ram = rounded;
  };

  const sampleDisk = async (): Promise<void> => {
    let blocks: DiskBlocks | null;
    try {
      blocks = await sources.disk();
    } catch {
      blocks = null;
    }
    if (closed) return;
    const used = blocks === null ? null : diskUsedPercent(blocks);
    const rounded = used === null ? undefined : roundStep(used);
    if (rounded === undefined) delete stats.disk;
    else stats.disk = rounded;
  };

  // Pierwsza próbka CPU to tylko punkt odniesienia — liczba pojawi się po pierwszym takcie.
  sampleCpu();
  void sampleRam();
  void sampleDisk();
  const timers = [
    startTimer(sampleCpu, CPU_SAMPLE_MS),
    startTimer(() => { void sampleRam(); }, RAM_SAMPLE_MS),
    startTimer(() => { void sampleDisk(); }, DISK_SAMPLE_MS),
  ];

  return {
    current: () => ({ ...stats }),
    close(): void {
      if (closed) return;
      closed = true;
      for (const timer of timers) stopTimer(timer);
    },
  };
}
