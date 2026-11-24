/**
 * The relay thread of the folder gate: it starts one helper process per folder with the command it was given, writes
 * request lines to the helper's stdin and passes every answer line back to the server thread, tagged with the folder
 * and the generation. It never touches the disk and never decodes a value; ids, generations and timeouts belong to
 * the client (`client.ts`). After each message it bumps a shared counter, so a server thread blocked in
 * `Atomics.wait` wakes up, and it keeps the pid of each live helper in a shared table the server thread kills from.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { type MessagePort, workerData } from 'node:worker_threads';

/** How the relay starts a helper: the executable and its arguments, given by the bootstrap. */
export interface HelperCommand {
  readonly file: string;
  readonly args: readonly string[];
}

export interface RelayWorkerData {
  /** The relay's end of the channel to the server thread. */
  readonly port: MessagePort;
  /** One `Int32` the relay bumps and notifies after every message it posts. */
  readonly signal: SharedArrayBuffer;
  /** `Int32` slots with the pid of each live helper, `0` for a free slot. */
  readonly pids: SharedArrayBuffer;
  readonly helper: HelperCommand;
}

/** Messages from the server thread. */
export type RelayRequest =
  | { readonly type: 'call'; readonly folder: string; readonly gen: number; readonly id: number; readonly line: string }
  /** Kills the folder's helper; later calls carry `gen` or newer. */
  | { readonly type: 'restart'; readonly folder: string; readonly gen: number }
  | { readonly type: 'dispose' };

/** Messages to the server thread. */
export type RelayEvent =
  /** One answer line; `id` as the line names it. */
  | { readonly type: 'line'; readonly folder: string; readonly gen: number; readonly id: number; readonly line: string }
  /** The helper did not start, ended or was killed; `ids` were sent to it and got no answer. */
  | { readonly type: 'gone'; readonly folder: string; readonly gen: number; readonly ids: readonly number[] };

interface Helper {
  readonly gen: number;
  readonly child: ChildProcess | null;
  /** Ids written to the helper and not answered yet. */
  readonly open: Set<number>;
  slot: number;
  pid: number;
  ended: boolean;
}

/** The id of an answer line, without decoding its value; `null` for a line that names none. */
function idOf(line: string): number | null {
  try {
    const message: unknown = JSON.parse(line);
    if (typeof message !== 'object' || message === null) return null;
    const id = (message as { id?: unknown }).id;
    return Number.isSafeInteger(id) ? (id as number) : null;
  } catch {
    return null;
  }
}

function run(data: RelayWorkerData): void {
  const { port, helper: command } = data;
  const signal = new Int32Array(data.signal);
  const pids = new Int32Array(data.pids);
  const helpers = new Map<string, Helper>();
  const generations = new Map<string, number>();

  const post = (event: RelayEvent): void => {
    port.postMessage(event);
    Atomics.add(signal, 0, 1);
    Atomics.notify(signal, 0);
  };

  const end = (folder: string, helper: Helper): void => {
    if (helper.ended) return;
    helper.ended = true;
    if (helper.slot >= 0) Atomics.compareExchange(pids, helper.slot, helper.pid, 0);
    if (helpers.get(folder) === helper) helpers.delete(folder);
    post({ type: 'gone', folder, gen: helper.gen, ids: [...helper.open] });
    helper.open.clear();
  };

  const start = (folder: string, gen: number): Helper => {
    let child: ChildProcess | null = null;
    try {
      child = spawn(command.file, [...command.args], { cwd: '/', env: {}, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      child = null;
    }
    const helper: Helper = { gen, child, open: new Set(), slot: -1, pid: 0, ended: false };
    helpers.set(folder, helper);
    if (child === null) {
      // `end` runs once the caller has written its id into `open`, so that call gets `gone`.
      queueMicrotask(() => { end(folder, helper); });
      return helper;
    }
    if (child.pid !== undefined) {
      helper.pid = child.pid;
      for (let slot = 0; slot < pids.length; slot += 1) {
        if (Atomics.compareExchange(pids, slot, 0, child.pid) === 0) {
          helper.slot = slot;
          break;
        }
      }
    }
    child.stdin?.on('error', () => { /* a helper that ended reports through `exit` */ });
    let buffer = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
        const id = idOf(line);
        if (id === null || !helper.open.delete(id)) continue;
        post({ type: 'line', folder, gen, id, line });
      }
    });
    child.on('error', () => { end(folder, helper); });
    // `close` comes after stdout is drained, so every answer the helper wrote is posted before `gone`.
    child.on('close', () => { end(folder, helper); });
    child.on('exit', () => {
      if (helper.slot >= 0) Atomics.compareExchange(pids, helper.slot, helper.pid, 0);
    });
    return helper;
  };

  const kill = (helper: Helper): void => {
    try {
      helper.child?.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  };

  // The server thread closed the channel or asked to stop: kill every helper; the thread ends once they are reaped.
  const shutdown = (): void => {
    for (const helper of helpers.values()) kill(helper);
    helpers.clear();
    port.close();
  };
  port.on('close', shutdown);

  port.on('message', (request: RelayRequest) => {
    switch (request.type) {
      case 'call': {
        const { folder, gen, id, line } = request;
        if (gen < (generations.get(folder) ?? gen)) {
          post({ type: 'gone', folder, gen, ids: [id] });
          return;
        }
        generations.set(folder, gen);
        let helper = helpers.get(folder);
        if (helper !== undefined && helper.gen !== gen) {
          kill(helper);
          helpers.delete(folder);
          helper = undefined;
        }
        helper ??= start(folder, gen);
        helper.open.add(id);
        helper.child?.stdin?.write(`${line}\n`);
        return;
      }
      case 'restart': {
        generations.set(request.folder, Math.max(request.gen, generations.get(request.folder) ?? 0));
        const helper = helpers.get(request.folder);
        if (helper !== undefined) {
          helpers.delete(request.folder);
          kill(helper);
        }
        return;
      }
      case 'dispose':
        shutdown();
        return;
    }
  });
}

const data = workerData as RelayWorkerData | null | undefined;
if (data?.port !== undefined) run(data);
