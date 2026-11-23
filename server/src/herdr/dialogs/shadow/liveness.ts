/**
 * Czy proces hooka ze zrzutu per wywołanie jeszcze żyje: pid i czas startu wobec `ps`
 * (`docs/dialogs.md`, „Server in shadow mode”).
 *
 * A pid alone is not enough (the system hands it to another process), so the process is alive when `ps` knows the pid
 * and its age (`etime`) puts its start at most {@link START_TOLERANCE_MS} after the dump's `startedAt` and at most
 * {@link EXEC_LAG_MAX_MS} before it. The hook measures `startedAt` from inside Node (`Date.now() - process.uptime()`),
 * so it trails the process start that `ps` reports by the time between exec and the start of the Node runtime,
 * seconds on a loaded Mac. A process that took over the pid of a dead hook started after that hook, so a start before
 * `startedAt` still belongs to the hook.
 *
 * Osobne `ps` na każdy pid, równolegle, każde z sufitem czasu: na macOS 27.0.1 `ps -p` z listą
 * dwóch albo trzech pidów trwa 240–300 ms wobec ~20 ms dla jednego, a sufit przed klawiszem to 200 ms. Odpowiedź per
 * pid: `true`, `false` (pidu nie ma albo to inny proces) albo `null` (nie wiem: `ps` padło, przekroczyło czas, wynik
 * nieczytelny).
 */
import { execFile } from 'node:child_process';

/** Zapas na rozdzielczość `etime` (pełne sekundy) i czas samego `ps`. */
export const START_TOLERANCE_MS = 2_000;

/**
 * How far before `startedAt` the process start from `ps` may lie: the exec and Node startup lag of the hook,
 * which reaches several seconds under full CPU load. Bounded, so a wall clock jump does not keep a stale entry alive.
 */
export const EXEC_LAG_MAX_MS = 30_000;

/** Sufit czasu `ps` — wywołanie stoi przed klawiszem zgody, więc nie wolno mu czekać dłużej. */
export const PS_TIMEOUT_MS = 200;

/** `ps` ze ścieżki bezwzględnej (macOS i Linux), bez `PATH` ze środowiska serwera. */
const PS_PATH = '/bin/ps';

export interface HookProcess {
  readonly pid: number;
  readonly startedAt: number;
}

/**
 * What `ps` said about one hook process: the verdict ({@link livenessFromPs}) with the facts it came from, for the log
 * line of a registration forgotten as dead. `leadMs` = the hook's `startedAt` minus the process start from `ps`.
 */
export type PsFinding = { readonly proc: HookProcess } & (
  | { readonly alive: false; readonly why: 'no-pid' }
  | { readonly alive: null; readonly why: 'etime-unreadable' }
  | {
    readonly alive: boolean;
    readonly why: 'in-window' | 'start-too-early' | 'start-too-late';
    readonly elapsedS: number;
    readonly psStartAt: number;
    readonly leadMs: number;
  }
);

/**
 * Verdicts per pid. `finding` (given by {@link psLiveness}) is what the same `ps` run said about the pid; no member =
 * a source without facts.
 */
export interface LivenessVerdicts extends ReadonlyMap<number, boolean | null> {
  readonly finding?: (pid: number) => PsFinding | undefined;
}

/** Życie procesów hooka w chwili `now` (ms epoki), per pid. */
export type ProcessLiveness = (
  processes: readonly HookProcess[], now: number,
) => Promise<LivenessVerdicts>;

/** `etime` z `ps` (`[[dd-]hh:]mm:ss`) w sekundach; `null` = inny kształt. */
export function parseElapsed(etime: string): number | null {
  const match = /^(?:(?:(\d+)-)?(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(etime.trim());
  if (match === null) return null;
  const [, days, hours, minutes, seconds] = match;
  return ((Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes)) * 60 + Number(seconds);
}

/** Wynik `ps -o pid=,etime=` → życie per pid. Pid bez linii = `false`; linia nieczytelna = `null`. */
export function livenessFromPs(
  output: string, processes: readonly HookProcess[], now: number,
): Map<number, boolean | null> {
  return new Map([...psFindings(output, processes, now)].map(([pid, finding]) => [pid, finding.alive]));
}

/** {@link livenessFromPs} with the facts of each verdict, per pid (a later process with the same pid wins). */
export function psFindings(output: string, processes: readonly HookProcess[], now: number): Map<number, PsFinding> {
  const elapsed = new Map<number, number | null>();
  for (const line of output.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 2) continue;
    const pid = Number(fields[0]);
    if (!Number.isInteger(pid)) continue;
    elapsed.set(pid, parseElapsed(fields[1] ?? ''));
  }
  const out = new Map<number, PsFinding>();
  for (const proc of processes) {
    if (!elapsed.has(proc.pid)) {
      out.set(proc.pid, { proc, alive: false, why: 'no-pid' });
      continue;
    }
    const seconds = elapsed.get(proc.pid) ?? null;
    if (seconds === null) {
      out.set(proc.pid, { proc, alive: null, why: 'etime-unreadable' });
      continue;
    }
    const psStartAt = now - seconds * 1_000;
    const lead = proc.startedAt - psStartAt;
    const alive = lead >= -START_TOLERANCE_MS && lead <= EXEC_LAG_MAX_MS + START_TOLERANCE_MS;
    const why = alive ? 'in-window' : lead < -START_TOLERANCE_MS ? 'start-too-late' : 'start-too-early';
    out.set(proc.pid, { proc, alive, why, elapsedS: seconds, psStartAt, leadMs: lead });
  }
  return out;
}

/**
 * One-line English text of a finding: pid, the hook's `startedAt`, the process start from `ps` with its `etime`, the
 * difference and the bound it crossed. Log only; no program reads it.
 */
export function describePsFinding(finding: PsFinding): string {
  const hook = describeHookProcess(finding.proc);
  if (finding.why === 'no-pid') return `${hook}: ps has no such pid`;
  if (finding.why === 'etime-unreadable') return `${hook}: ps etime unreadable`;
  const ps = `ps start ${isoOf(finding.psStartAt)} (etime ${String(finding.elapsedS)} s)`;
  const diff = finding.leadMs < 0 ? `${String(-finding.leadMs)} ms after startedAt`
    : `${String(finding.leadMs)} ms before startedAt`;
  const bound = finding.why === 'start-too-late'
    ? `start too late, another process took the pid (limit ${String(START_TOLERANCE_MS)} ms after)`
    : finding.why === 'start-too-early'
      ? `start too early (limit ${String(EXEC_LAG_MAX_MS + START_TOLERANCE_MS)} ms before)`
      : 'start in window';
  return `${hook}, ${ps}, ${diff}: ${bound}`;
}

/** `pid <pid>, hook startedAt <ISO 8601>` for a log line. */
export function describeHookProcess(proc: HookProcess): string {
  return `pid ${String(proc.pid)}, hook startedAt ${isoOf(proc.startedAt)}`;
}

/** Epoch ms as ISO 8601; a value outside the date range as the number. */
function isoOf(at: number): string {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? String(at) : date.toISOString();
}

/** Wszystkie procesy `null` — odpowiedź „nie wiem”. */
function unknownAll(processes: readonly HookProcess[]): Map<number, boolean | null> {
  return new Map(processes.map((proc) => [proc.pid, null]));
}

/** Jedno `ps -o pid=,etime= -p <pid>`: wyjście albo `null` (nie wiem). */
export type PsRun = (pid: number, timeoutMs: number) => Promise<string | null>;

/**
 * Kod wyjścia `1` bez innego błędu to „tego pidu nie ma” (tak `ps -p` mówi o brakującym procesie); każdy inny błąd,
 * sygnał albo przekroczony czas = `null`.
 */
const runPs: PsRun = (pid, timeoutMs) => new Promise((resolve) => {
  execFile(PS_PATH, ['-o', 'pid=,etime=', '-p', String(pid)], {
    timeout: timeoutMs, killSignal: 'SIGKILL', env: { LC_ALL: 'C' },
  }, (err, stdout) => {
    if (err === null) {
      resolve(String(stdout));
      return;
    }
    const code = (err as { code?: unknown }).code;
    const killed = (err as { killed?: unknown }).killed === true;
    resolve(code === 1 && !killed ? String(stdout) : null);
  });
});

/** Życie procesów z `ps`, jedno wywołanie na pid; `null` jednego pidu nie zabiera odpowiedzi pozostałym. */
export function psLiveness(timeoutMs: number = PS_TIMEOUT_MS, run: PsRun = runPs): ProcessLiveness {
  return async (processes, now) => {
    const pids = [...new Set(processes.map((proc) => proc.pid))]
      .filter((pid) => Number.isInteger(pid) && pid > 0);
    const outputs = await Promise.all(pids.map((pid) => run(pid, timeoutMs).catch(() => null)));
    const out = new Map<number, boolean | null>();
    const findings = new Map<number, PsFinding>();
    pids.forEach((pid, index) => {
      const own = processes.filter((proc) => proc.pid === pid);
      const output = outputs[index] ?? null;
      if (output === null) {
        for (const [key, value] of unknownAll(own)) out.set(key, value);
        return;
      }
      for (const [key, finding] of psFindings(output, own, now)) {
        out.set(key, finding.alive);
        findings.set(key, finding);
      }
    });
    return Object.assign(out, { finding: (pid: number) => findings.get(pid) });
  };
}
