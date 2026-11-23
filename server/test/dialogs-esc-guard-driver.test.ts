/**
 * Osłona drivera po jego WŁASNEJ decyzji przy kartach `Edit`.
 *
 * Zdania, których pilnuje plik:
 *
 * - cyfra na dialog `Edit` (wpis w katalogu sesji, dowód pliku z ekranu) kasuje zrzut `Bash` subagenta;
 * - Esc na karcie bez przycisków (wpis i zrzut `Edit` bez dowodu pliku): ten sam dialog na ekranie nie wraca jako
 *   nowa karta, następny dialog `Edit` z inną ramką dostaje kartę.
 *
 * Atrapa klienta herdr i pomocnicy są tu kopią minimalną z `herdr-driver.test.ts` (wzorzec testów drivera:
 * każdy plik ma własną atrapę).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectSlug } from '../src/cli-store.ts';
import { createHerdrDriver } from '../src/drivers/herdr-driver.ts';
import type { HerdrDriverDeps } from '../src/drivers/herdr-driver.ts';
import type { DriverEvent, SessionDriver } from '../src/drivers/types.ts';
import { createAgentFileReader } from '../src/herdr/background/agent-file.ts';
import { HOOK_PENDING_DIRNAME } from '../src/herdr/dialogs/hook/contract.ts';
import type { PendingHookTool } from '../src/herdr/dialogs/hook/dump.ts';
import { clearPendingHook, readPendingHook } from '../src/herdr/dialogs/hook/dump.ts';
import { createJsonlFollower } from '../src/herdr/jsonl-follow.ts';
import type {
  HerdrAgent, HerdrAgentHandle, HerdrAgentInfo, HerdrClient, HerdrPaneEvent, HerdrPaneHistory, HerdrScreen,
} from '../src/herdr/types.ts';
import type { PulseSample, SessionPulse } from '../src/herdr/session-pulse.ts';
import { createUploads } from '../src/herdr/uploads.ts';

const SESSION = '7d2dd80f-012c-5c17-b97d-cf436a305158';
const PANE = 'w9:p72';
const FIXTURES = join(import.meta.dirname, 'fixtures', 'herdr');
const TIMING = { batchMs: 4, statTickMs: 3, missingFastMs: 3, missingWindowMs: 60, missingSlowMs: 6 };

// ---------------------------------------------------------------------------
// Driver: atrapa klienta herdr, prawdziwy follower (jak `herdr-driver.test.ts`)
// ---------------------------------------------------------------------------

interface Call {
  method: 'prompt' | 'send_keys' | 'form_submit' | 'mode_cycle' | 'trust_step' | 'dialog_key' | 'take_back_key' | 'read' | 'focus' | 'history';
  keys?: readonly string[];
}

class FakeClient implements HerdrClient {
  readonly calls: Call[] = [];
  screenText = '';
  sendFormSubmit = (): Promise<void> => {
    this.calls.push({ method: 'form_submit', keys: ['enter'] });
    return Promise.resolve();
  };
  sendModeCycle = (): Promise<void> => {
    this.calls.push({ method: 'mode_cycle', keys: ['shift+tab'] });
    return Promise.resolve();
  };
  sendTrustStep = (_paneId: string, key: string): Promise<void> => {
    this.calls.push({ method: 'trust_step', keys: [key] });
    return Promise.resolve();
  };
  sendDialogKey = (_paneId: string, key: string): Promise<void> => {
    this.calls.push({ method: 'dialog_key', keys: [key] });
    return Promise.resolve();
  };
  sendTakeBackKey = (_paneId: string, key: string): Promise<void> => {
    this.calls.push({ method: 'take_back_key', keys: [key] });
    return Promise.resolve();
  };
  pasteText = (): Promise<void> => Promise.resolve();
  sendPromptSubmit = (): Promise<void> => Promise.resolve();
  listAgents(): Promise<never> {
    return Promise.reject(new Error('driver nie woła agent.list'));
  }
  getAgent: () => Promise<HerdrAgentInfo> = () => Promise.reject(new Error('bez sondy przerwania'));
  readPaneHistory(): Promise<HerdrPaneHistory> {
    this.calls.push({ method: 'history' });
    return Promise.resolve({ text: '', truncated: false });
  }
  readScreen(): Promise<HerdrScreen> {
    this.calls.push({ method: 'read' });
    return Promise.resolve({ text: this.screenText });
  }
  prompt(): Promise<void> {
    this.calls.push({ method: 'prompt' });
    return Promise.resolve();
  }
  sendKeys = (_paneId: string, keys: readonly string[]): Promise<void> => {
    this.calls.push({ method: 'send_keys', keys });
    return Promise.resolve();
  };
  focus(): Promise<void> {
    this.calls.push({ method: 'focus' });
    return Promise.resolve();
  }
  ping(): Promise<{ version: string; protocol: number }> {
    return Promise.resolve({ version: '0.8.2', protocol: 20 });
  }
}

class FakePulse implements SessionPulse {
  start(): void {}
  stop(): void {}
  repoint(): void {}
  relocated(): void {}
  close(): void {}
  constructor(readonly onPulse: (sample: PulseSample) => void) {}
}

interface Fixture {
  driver: SessionDriver;
  client: FakeClient;
  events: DriverEvent[];
  emit: (ev: HerdrPaneEvent) => void;
}

let base = '';
let root = '';
const disposers: (() => void)[] = [];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'rarog-oslona-esc-'));
  root = join(base, 'store');
  await mkdir(root, { recursive: true });
});

afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose();
  await rm(base, { recursive: true, force: true });
});

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
};

const userLine = (text: string): string => `${JSON.stringify({
  type: 'user', message: { role: 'user', content: text }, isSidechain: false,
  timestamp: '2026-08-22T10:00:00.000Z', sessionId: SESSION,
})}\n`;

/** Wpis `assistant` z niedomkniętym `tool_use`. */
const toolUseLine = (id: string, name: string, input: unknown): string => `${JSON.stringify({
  type: 'assistant', isSidechain: false, timestamp: '2026-08-22T10:00:06.000Z', sessionId: SESSION,
  message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'tool_use', id, name, input }] },
})}\n`;

async function makeDriver(opts: { deps: Partial<HerdrDriverDeps>; transcript: string }): Promise<Fixture> {
  const cwd = join(base, 'projekt');
  await mkdir(cwd, { recursive: true });
  const storeDir = join(root, projectSlug(cwd));
  await mkdir(storeDir, { recursive: true });
  await writeFile(join(storeDir, `${SESSION}.jsonl`), opts.transcript);
  const agent: HerdrAgent = {
    key: PANE, paneId: PANE, agentSessionId: SESSION, engine: 'claude', termId: null, cwd, status: 'idle',
    title: 'refaktor', stateChangeSeq: 7, mode: 'auto', modeReadAt: 0, inScope: true, tabId: 'w9:t3',
    launchedByRarog: false, interactiveReady: true,
  };
  const listeners = new Set<(ev: HerdrPaneEvent) => void>();
  const handle: HerdrAgentHandle = {
    agent,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const client = new FakeClient();
  const deps: HerdrDriverDeps = {
    pulse: (o) => new FakePulse(o.onPulse),
    client,
    audit: { log: () => {} },
    uploads: createUploads(),
    yoloRoots: [],
    now: () => Date.UTC(2026, 7, 22, 12, 0, 0),
    follow: (o) => createJsonlFollower({ ...o, root, watch: false, timing: TIMING }),
    agentFiles: (o) => createAgentFileReader({ ...o, root }),
    pendingDebounceMs: 10,
    pendingRetryMs: 4,
    escSettleMs: 5,
    system: 'macos',
    ...opts.deps,
  };
  const driver = createHerdrDriver(handle, deps);
  disposers.push(() => { driver.dispose(); });
  const events: DriverEvent[] = [];
  void (async () => {
    for await (const event of driver.events) events.push(event);
  })();
  return { driver, client, events, emit: (ev) => { for (const l of listeners) l(ev); } };
}

const permissions = (
  events: readonly DriverEvent[],
): Extract<DriverEvent, { type: 'permission-request' }>[] => events.filter(
  (e): e is Extract<DriverEvent, { type: 'permission-request' }> => e.type === 'permission-request',
);

const reads = (client: FakeClient): number => client.calls.filter((c) => c.method === 'read').length;

describe('zrzut zgody subagenta w kolejce przeżywa decyzję Raroga na dialogu przed nią', () => {
  const komenda = (name: string): string => (JSON.parse(readFileSync(
    join(FIXTURES, `${name}.command.json`), 'utf8',
  )) as { command: string }).command;
  const ekran = (name: string): string => readFileSync(join(FIXTURES, `${name}.txt`), 'utf8');
  /** Dialog subagenta: cała ramka komendy `S`. */
  const S = komenda('dialog-bash-subagent-naglowek-2.1.302');
  /** Zrzut subagenta minutę PRZED wpisem `tool_use` wątku głównego z `toolUseLine` (10:00:06), jak w incydencie. */
  const zrzutAt = Date.parse('2026-08-22T09:59:06.000Z');
  const MIN = 60_000;
  const plikZrzutu = (): string => join(base, 'dane', HOOK_PENDING_DIRNAME, `${SESSION}.json`);

  function zapiszZrzut(cmd: string, at: number): void {
    const path = plikZrzutu();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      sessionId: SESSION, toolName: 'Bash', toolInput: { command: cmd }, at,
      hookEventName: 'PermissionRequest', agentId: 'a0b1c2d3e4f5a6b7c',
    }));
  }

  /** Prawdziwy czytnik zrzutu (zegar `now`) i prawdziwe kasowanie po decyzji. */
  function czytnik(now: number): Partial<HerdrDriverDeps> {
    const dataDir = join(base, 'dane');
    return {
      readPendingHook: (sid) => readPendingHook(dataDir, sid, () => now),
      clearPendingHook: (sid, answerKey) => { clearPendingHook(dataDir, sid, answerKey); },
    };
  }

  /** Zrzut na dysku o generacji `at`, czytany `minuty` po zapisie. */
  function dysk(
    cmd: string, minuty: number, at = zrzutAt,
  ): Promise<{ path: string; deps: Partial<HerdrDriverDeps> }> {
    zapiszZrzut(cmd, at);
    return Promise.resolve({ path: plikZrzutu(), deps: czytnik(at + minuty * MIN) });
  }

  /** Blokada nad `screen` z wpisem wątku głównego `tool_use` (`toolName`, `input`) i zrzutem z `deps`. */
  async function blokada(
    deps: Partial<HerdrDriverDeps>, screen: string, toolName: string, input: unknown, reqId = 'toolu_main',
  ): Promise<Fixture> {
    const fx = await makeDriver({
      transcript: userLine('pracuj') + toolUseLine('toolu_main', toolName, input),
      deps: { ...deps, blockedPollMs: 20, screenCacheMs: 5 },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.client.screenText = screen;
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => permissions(fx.events).length > 0, 'karta dialogu wątku głównego');
    expect(permissions(fx.events).at(-1)?.reqId).toBe(reqId);
    expect(permissions(fx.events).at(-1)?.input).toEqual(input);
    return fx;
  }

  it('(4) cyfra na dialog `Edit`, zrzut `Bash` subagenta: skasowany', async () => {
    const zrzut = await dysk(S, 2);
    // Ścieżka w katalogu sesji (`<base>/projekt`): karta wpisu `Edit` ma przyciski tylko z dowodem pliku z ekranu.
    const fx = await blokada(zrzut.deps, ekran('measured/zgoda-edit-2.1.293'), 'Edit', {
      file_path: join(base, 'projekt', 'pomiar-dialogow.txt'), old_string: 'stara wartosc', new_string: 'nowa wartosc',
    });
    await expect(fx.driver.respondPermission('toolu_main', 'allow')).resolves.toEqual({ kind: 'applied' });
    expect(existsSync(zrzut.path)).toBe(false);
  });
});

describe('karta nie wraca po WŁASNEJ decyzji (osłona po cyfrze i Esc)', () => {
  /** Krótkie czasy: cache 1 ms, zegar ponownej oceny 8 ms (produkcja: 1 s i 4 s). */
  const fresh = { screenCacheMs: 1, blockedPollMs: 8 } as const;

  /** Zrzut hooka, który Rarog kasuje po decyzji (`clearPendingHook`), jak w produkcji. */
  const kasowalny = (initial: PendingHookTool | null): { deps: Partial<HerdrDriverDeps> } => {
    let hook = initial;
    return { deps: { readPendingHook: () => hook, clearPendingHook: () => { hook = null; } } };
  };
  const stechlaKomenda = (JSON.parse(readFileSync(
    join(FIXTURES, 'dialog-bash-stechly-read-2.1.295.command.json'), 'utf8',
  )) as { command: string }).command;
  const zrzutBash: PendingHookTool = {
    toolName: 'Bash', toolInput: { command: stechlaKomenda }, at: Date.parse('2026-08-22T10:00:07.000Z'),
    hookEventName: 'PermissionRequest',
  };

  it('Esc na karcie bez przycisków (wpis i zrzut `Edit` bez dowodu pliku): ten sam dialog nie wraca, inny dostaje kartę (karta 0d)',
    async () => {
      const EDIT_A = readFileSync(join(FIXTURES, 'measured', 'zgoda-edit-2.1.322.txt'), 'utf8');
      const EDIT_B = readFileSync(join(FIXTURES, 'measured', 'zgoda-drugi-edit-2.1.322.txt'), 'utf8');
      // Zrzut `Edit` innego pliku, kasowany po decyzji: po Esc tożsamość oceny traci zrzut, a karta, która stoi,
      // przestaje ją trzymać, więc dialog na ekranie zatrzymuje tylko osłona po decyzji.
      const hook = kasowalny({ ...zrzutBash, toolName: 'Edit', toolInput: { file_path: '/current/pomiar-dialogow.txt' } });
      const fx = await makeDriver({
        transcript: userLine('zrób to')
          + toolUseLine('t-1', 'Edit', { file_path: join(base, 'projekt', 'inny.txt'), old_string: 'a', new_string: 'b' }),
        deps: { ...fresh, ...hook.deps },
      });
      await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
      fx.client.screenText = EDIT_A;
      fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
      await waitFor(() => permissions(fx.events).length > 0, 'karta bez przycisków');
      expect(permissions(fx.events)).toHaveLength(1);
      expect(permissions(fx.events)[0]?.input).toBeNull();

      await expect(fx.driver.respondPermission(permissions(fx.events)[0]?.reqId ?? '', 'deny'))
        .resolves.toEqual({ kind: 'applied' });
      // Przemalowanie po `escape` jeszcze nie doszło: ten sam dialog na ekranie, wpis dalej bez wyniku.
      const odczyty = reads(fx.client);
      await waitFor(() => reads(fx.client) >= odczyty + 4, 'obroty zegara nad odrzuconym dialogiem');
      expect(permissions(fx.events)).toHaveLength(1);

      // Następny dialog `Edit` przy tym samym wpisie: inna treść ramki, więc nowa karta.
      fx.client.screenText = EDIT_B;
      await waitFor(() => permissions(fx.events).length > 1, 'karta następnego dialogu');
    });
});
