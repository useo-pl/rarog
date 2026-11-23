/**
 * Driver herdr w trybie kanału zgód (warstwa 1).
 *
 * Zdania, których pilnuje plik:
 *
 * - przy efektywnym `main` klasa `permission`/`sandbox` nie dostaje cyfry na żadnej ścieżce: przycisk zgody
 *   (`respondPermission`, także `allow-always`) i odpowiedź na potwierdzenie z ekranu (`answerQuestion`); tryb
 *   nieznany (wyjątek źródła trybu) liczy się jak `main`;
 * - karta zgody z ekranu i jsonl przy `main` idzie bez przycisku zgody i bez „nie pytaj więcej”, a `escape`
 *   (odmowa) zostaje;
 * - dialog z zamkniętej listy (zaufanie katalogu) i formularz pytania przy `main` dalej dostają cyfrę;
 * - przy `off` i `shadow` cyfra idzie jak dotąd (strażnik, że testy wyżej nie są puste);
 * - kanał cienia idzie za trybem EFEKTYWNYM: plik cienia przed klawiszem i zwolnienie sierot przy `shadow` (także
 *   z konfiguracji `main` zdegradowanej do `shadow`), a przy `off` i `main` kanał nie dostaje ani jednego wywołania;
 * - transkrypt skrócony do zera dochodzi do obserwacji kanału jako znany i pusty, z utratą pokrycia z chwili skrócenia:
 *   karta prośby rozstrzygniętej przy biurku nie odzyskuje przycisku zgody;
 * - obserwacja kanału przy świeżym `waiting: permission` czyta ekran sama (`readScreen`, nie pamięć ekranu drivera)
 *   i podaje `{ text, readStartedAt }` z chwilą sprzed zapytania; przy innym rejestrze bez odczytu; po `dispose`
 *   w trakcie odczytu obserwacji nie ma; z prawdziwym cyklem przycisk zgody idzie za ekranem z odczytu tej obserwacji,
 *   a odczyt spóźniony ponad termin dowodu przycisku nie daje;
 * - klawisz decyzji z ekranu (`escape` odmowy, cyfra zgody) nie idzie do dialogu, który trzyma karta kanału, także
 *   gdy karta pojawia się w trakcie świeżego odczytu ekranu: wynik `stale`, bez klawisza;
 * - macierz korpusu: każdy ekran zgody z pliku złotego korpusu × zrzut × karta kanału × klasa z rejestru przy
 *   `main` = 0 cyfr przez wszystkie wejścia decyzji drivera (karta po `reqId`, dialog adresowany sesją, odpowiedź na
 *   potwierdzenie); strażnik: przy `off` ekrany z kartą po `reqId` dostają cyfrę;
 * - przy `all` i czekającej prośbie subagenta obserwacja kanału idzie co ≤1 s także bez
 *   odczytu rejestru managera, każda z własnym odczytem rejestru (chwila sprzed zapytania) i ekranem tylko przy
 *   świeżym `waiting: permission`; przy `main`, bez czekającej prośby i po `dispose` taktu nie ma, a wyjątek odczytu
 *   rejestru daje ostatni sygnał managera tej sesji; po `session-changed` takt poprzedniej sesji nie odpala (żywa karta
 *   wątku głównego nowej sesji zostaje `pending`), a sygnał managera sprzed zmiany sesji to rejestr nieznany.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLI_DIALOG_CLASSES } from '@rarog/shared';
import type { CliDialogClass } from '@rarog/shared';
import type { CliWaitingSignal } from '../src/cli-version.ts';
import { projectSlug } from '../src/cli-store.ts';
import { createHerdrDriver } from '../src/drivers/herdr-driver.ts';
import type { ConsentObserveRequest, HerdrAuditEntry, HerdrDriverDeps } from '../src/drivers/herdr-driver.ts';
import type { Scheduler } from '../src/drivers/runtime.ts';
import type { DriverEvent, SessionDriver } from '../src/drivers/types.ts';
import { createAgentFileReader } from '../src/herdr/background/agent-file.ts';
import { canonicalSha256 } from '../src/herdr/dialogs/hook/canon.ts';
import { HOOK_PENDING_DIRNAME } from '../src/herdr/dialogs/hook/contract.ts';
import type { HookCallDump } from '../src/herdr/dialogs/hook/contract.ts';
import type { PendingHookTool } from '../src/herdr/dialogs/hook/dump.ts';
import { CONSENT_PROOF_TTL_MS, CONSENT_SECRET_BYTES } from '../src/herdr/dialogs/layer1/contract.ts';
import { createConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import type { ConsentCycle } from '../src/herdr/dialogs/layer1/cycle.ts';
import type { ConsentEffectiveMode } from '../src/herdr/dialogs/layer1/mode.ts';
import { observeConsentSession } from '../src/herdr/dialogs/layer1/observe.ts';
import { createConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import type { ConsentRegistry } from '../src/herdr/dialogs/layer1/registry.ts';
import { consentCardSha256 } from '../src/herdr/dialogs/layer1/sign.ts';
import { consentDigitBlocked } from '../src/herdr/dialogs/router.ts';
import type { ShadowConsentChannel } from '../src/herdr/dialogs/shadow/channel.ts';
import type { ProcessLiveness } from '../src/herdr/dialogs/shadow/liveness.ts';
import { createJsonlFollower } from '../src/herdr/jsonl-follow.ts';
import type {
  HerdrAgent, HerdrAgentHandle, HerdrAgentInfo, HerdrClient, HerdrPaneEvent, HerdrPaneHistory, HerdrScreen,
} from '../src/herdr/types.ts';
import type { PulseSample, SessionPulse } from '../src/herdr/session-pulse.ts';
import { createUploads } from '../src/herdr/uploads.ts';

const SESSION = '7d2dd80f-012c-5c17-b97d-cf436a305158';
/** Tura zrzutu hooka w obserwacji kanału zgód. */
const CONSENT_PROMPT = '00000000-0000-4000-9000-0000000000cc';
const PANE = 'w9:p72';
const NOW = Date.UTC(2026, 7, 22, 12, 0, 0);
const FIXTURES = join(import.meta.dirname, 'fixtures', 'herdr');
const DIALOG_PERMISSION = readFileSync(join(FIXTURES, 'dialog-permission.txt'), 'utf8');
const DIALOG_QUESTION = readFileSync(join(FIXTURES, 'dialog-askuserquestion.txt'), 'utf8');
const BASH_MEASURED = readFileSync(join(FIXTURES, 'measured', 'zgoda-bash-2.1.293.txt'), 'utf8');

/** Dialog `Bash` z pomiaru (CLI 2.1.293, ramka 61 kolumn) z komendą `command` w całej ramce. */
function bashFrame(command: string): string {
  const lines = BASH_MEASURED.split('\n');
  const top = lines.findIndex((line) => line.startsWith('╌'));
  const bottom = lines.findIndex((line, index) => index > top && line.startsWith('╌'));
  return [...lines.slice(0, top + 1), ` ${command}`, ...lines.slice(bottom)].join('\n');
}
const TRUST_DIALOG = `${'─'.repeat(63)}\n Do you trust the files in this folder?\n\n ❯ 1. Yes, proceed\n   2. No, exit\n`;
const TIMING = { batchMs: 4, statTickMs: 3, missingFastMs: 3, missingWindowMs: 60, missingSlowMs: 6 };
const BASH_INPUT = {
  command: 'pnpm exec vitest run server/test/state-machine.test.ts',
  description: 'Uruchamia testy maszyny stanów',
};
const WAITING_PERMISSION = { kind: 'waiting', dialog: 'permission' } as const;
/** Sesja silnika po `session-changed` (nowa rozmowa w tym samym panelu). */
const SESSION_B = '9b1e5c3a-7d2f-4e8a-b6c1-0f3d2a1e5b7c';
const WAITING_INPUT = { kind: 'waiting', dialog: 'input' } as const;

// ---------------------------------------------------------------------------
// Reguła bramki (czysta funkcja)
// ---------------------------------------------------------------------------

const MODES: readonly (ConsentEffectiveMode | null)[] = ['off', 'shadow', 'main', 'all', null];
const CLASSES: readonly (CliDialogClass | null)[] = [...CLI_DIALOG_CLASSES, null];
/** Nazwy kart z każdej ścieżki: zgody z jsonl i zrzutu, karty z ekranu, pytania i dialogi z zamkniętej listy. */
const TOOLS = [
  'Bash', 'Write', 'Edit', 'Read', 'WebFetch', 'ExitPlanMode', 'SandboxNetwork', 'mcp__srv__tool', 'dialog',
  'dialog:confirm', 'dialog:tool', 'dialog:question', 'dialog:trust', 'dialog:model', 'AskUserQuestion',
] as const;

/** Oczekiwanie wypisane wprost (nie z kodu): kiedy cyfra przy danym trybie MA przejść. */
function digitAllowed(
  mode: ConsentEffectiveMode | null, cliDialog: CliDialogClass | null, toolName: string, consent: boolean,
): boolean {
  if (mode === 'off' || mode === 'shadow') return true;
  if (cliDialog === 'permission' || cliDialog === 'sandbox') return false;
  if (toolName === 'dialog:trust' || toolName === 'dialog:model') return true;
  if (consent) return false;
  if (toolName === 'AskUserQuestion' || toolName === 'dialog:question') return true;
  return cliDialog === 'input' || cliDialog === 'dialog';
}

describe('bramka cyfry trybu kanału: tabela tryb × klasa × karta × ścieżka', () => {
  const rows = MODES.flatMap((mode) => CLASSES.flatMap((cliDialog) => TOOLS.flatMap((toolName) =>
    [true, false].map((consent) => ({ mode, cliDialog, toolName, consent })))));

  it.each(rows)('%o', (row) => {
    expect(consentDigitBlocked(row)).toBe(!digitAllowed(row.mode, row.cliDialog, row.toolName, row.consent));
  });

  it('przy `main`, `all` i trybie nieznanym zgoda (`permission`, `sandbox`) nie przechodzi dla ŻADNEJ karty i ścieżki', () => {
    for (const mode of ['main', 'all', null] as const) {
      for (const cliDialog of ['permission', 'sandbox'] as const) {
        for (const toolName of TOOLS) {
          for (const consent of [true, false]) {
            expect(consentDigitBlocked({ mode, cliDialog, toolName, consent }), `${String(mode)} ${cliDialog} ${toolName}`)
              .toBe(true);
          }
        }
      }
    }
  });

  it('przy `off` i `shadow` bramka nic nie zmienia', () => {
    for (const row of rows.filter((r) => r.mode === 'off' || r.mode === 'shadow')) {
      expect(consentDigitBlocked(row)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Driver: atrapa klienta herdr, prawdziwy follower
// ---------------------------------------------------------------------------

interface Call {
  method: 'prompt' | 'send_keys' | 'form_submit' | 'mode_cycle' | 'trust_step' | 'dialog_key' | 'take_back_key' | 'read' | 'focus' | 'history'
    | 'paste' | 'prompt_submit';
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
  pasteText = (): Promise<void> => {
    this.calls.push({ method: 'paste' });
    return Promise.resolve();
  };
  sendPromptSubmit = (): Promise<void> => {
    this.calls.push({ method: 'prompt_submit', keys: ['enter'] });
    return Promise.resolve();
  };
  /** Krok dialogu zaufania bez cyfr: osobna metoda klienta, zapisana jak w `herdr-driver.test.ts`. */
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
  audit: HerdrAuditEntry[];
  emit: (ev: HerdrPaneEvent) => void;
}

let base = '';
let root = '';
const disposers: (() => void)[] = [];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'rarog-layer1-driver-'));
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

const quiet = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 15));

const userLine = (text: string): string => `${JSON.stringify({
  type: 'user', message: { role: 'user', content: text }, isSidechain: false,
  timestamp: '2026-08-22T10:00:00.000Z', sessionId: SESSION,
})}\n`;

const toolUseLine = (id: string, name: string, input: unknown): string => `${JSON.stringify({
  type: 'assistant', isSidechain: false, timestamp: '2026-08-22T10:00:06.000Z', sessionId: SESSION,
  message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'tool_use', id, name, input }] },
})}\n`;

async function makeDriver(opts: {
  deps?: Partial<HerdrDriverDeps>; transcript?: string; noTranscript?: boolean; screen: string;
  agent?: Partial<HerdrAgent>;
}): Promise<Fixture> {
  const cwd = join(base, 'projekt');
  await mkdir(cwd, { recursive: true });
  const storeDir = join(root, projectSlug(cwd));
  await mkdir(storeDir, { recursive: true });
  if (opts.noTranscript !== true) await writeFile(join(storeDir, `${SESSION}.jsonl`), opts.transcript ?? '');
  const agent: HerdrAgent = {
    key: PANE, paneId: PANE, agentSessionId: SESSION, engine: 'claude', termId: null, cwd, status: 'idle',
    title: 'refaktor', stateChangeSeq: 7, mode: 'auto', modeReadAt: 0, inScope: true, tabId: 'w9:t3',
    launchedByRarog: false, interactiveReady: true, ...opts.agent,
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
  client.screenText = opts.screen;
  const audit: HerdrAuditEntry[] = [];
  const deps: HerdrDriverDeps = {
    pulse: (o) => new FakePulse(o.onPulse),
    client,
    audit: { log: (entry) => audit.push(entry) },
    uploads: createUploads(),
    yoloRoots: [],
    now: () => NOW,
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
  return { driver, client, events, audit, emit: (ev) => { for (const l of listeners) l(ev); } };
}

const permissions = (events: readonly DriverEvent[]): Extract<DriverEvent, { type: 'permission-request' }>[] =>
  events.filter((e): e is Extract<DriverEvent, { type: 'permission-request' }> => e.type === 'permission-request');

const questions = (events: readonly DriverEvent[]): Extract<DriverEvent, { type: 'question-request' }>[] =>
  events.filter((e): e is Extract<DriverEvent, { type: 'question-request' }> => e.type === 'question-request');

const keysSent = (fx: Fixture): (readonly string[])[] =>
  fx.client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys ?? []);

/** Same cyfry wysłane do panelu (zgoda albo odpowiedź), bez `escape`. */
const digitsSent = (fx: Fixture): string[] => keysSent(fx).flat().filter((key) => /^\d$/.test(key));

/** Zrzut hooka per sesja dla karty `Bash` (świeży albo starszy niż 10 min). */
function bashDump(ageMs: number): PendingHookTool {
  return {
    toolName: 'Bash', toolInput: BASH_INPUT, at: NOW - ageMs, hookEventName: 'PermissionRequest', promptId: 'p1',
  };
}

type Dump = 'none' | 'live' | 'stale';
const DUMPS: readonly Dump[] = ['none', 'live', 'stale'];

function dumpDeps(dump: Dump): Partial<HerdrDriverDeps> {
  if (dump === 'none') return {};
  const tool = bashDump(dump === 'live' ? 5_000 : 11 * 60_000);
  return { readPendingHook: () => tool, clearPendingHook: () => {} };
}

async function bashCard(
  deps: Partial<HerdrDriverDeps>, signal: typeof WAITING_PERMISSION | null,
): Promise<{ fx: Fixture; reqId: string }> {
  const fx = await makeDriver({
    transcript: userLine('zbuduj') + toolUseLine('toolu_bash', 'Bash', BASH_INPUT),
    screen: DIALOG_PERMISSION,
    deps,
  });
  await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
  if (signal !== null) fx.driver.noteCliWaiting?.(signal);
  fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
  await waitFor(() => permissions(fx.events).length > 0, 'karta');
  return { fx, reqId: permissions(fx.events).at(-1)?.reqId ?? '' };
}

describe('driver przy efektywnym `main` i `all`: zgoda na narzędzie bez cyfry', { timeout: 10_000 }, () => {
  const combos = (['main', 'all'] as const).flatMap((mode) => DUMPS.flatMap((dump) =>
    [WAITING_PERMISSION, null].map((signal) => ({ mode, dump, signal }))));

  it.each(combos)('tryb $mode, zrzut $dump, rejestr $signal: 0 cyfr przez `allow` i `allow-always`, karta bez zgody',
    async ({ mode, dump, signal }) => {
      const { fx, reqId } = await bashCard({ ...dumpDeps(dump), consentMode: () => mode }, signal);
      const card = permissions(fx.events).at(-1);
      expect(card?.canAllow).toBe(false);
      expect(card?.alwaysLabel).toBeUndefined();
      const allow = await fx.driver.respondPermission(reqId, 'allow');
      const always = await fx.driver.respondPermission(reqId, 'allow-always');
      expect(allow).toMatchObject({ kind: 'refused', reason: 'terminal-only' });
      // Pierwsza odmowa zdejmuje kartę u drivera, więc druga próba bywa `stale`; nigdy `applied`.
      expect(always.kind).not.toBe('applied');
      await quiet();
      expect(digitsSent(fx)).toEqual([]);
    });

  it('tryb nieznany (źródło trybu rzuca) liczy się jak `main`: 0 cyfr', async () => {
    const { fx, reqId } = await bashCard({ consentMode: () => { throw new Error('tryb'); } }, WAITING_PERMISSION);
    expect(permissions(fx.events).at(-1)?.canAllow).toBe(false);
    await expect(fx.driver.respondPermission(reqId, 'allow')).resolves.toMatchObject({ kind: 'refused' });
    expect(digitsSent(fx)).toEqual([]);
  });

  it('`deny` przy `main` idzie `escape`, nie cyfrą', async () => {
    const { fx, reqId } = await bashCard({ consentMode: () => 'main' }, WAITING_PERMISSION);
    await expect(fx.driver.respondPermission(reqId, 'deny')).resolves.toEqual({ kind: 'applied' });
    expect(keysSent(fx)).toEqual([['escape']]);
  });

  it.each(['off', 'shadow'] as const)('strażnik: przy `%s` ta sama karta dostaje cyfrę i przycisk zgody', async (mode) => {
    const { fx, reqId } = await bashCard({ consentMode: () => mode }, WAITING_PERMISSION);
    expect(permissions(fx.events).at(-1)?.canAllow).toBeUndefined();
    await expect(fx.driver.respondPermission(reqId, 'allow')).resolves.toEqual({ kind: 'applied' });
    expect(digitsSent(fx)).toEqual(['1']);
  });

  it('dialog zaufania katalogu przy `main` dalej dostaje cyfrę (to nie zgoda na narzędzie)', async () => {
    const fx = await makeDriver({
      noTranscript: true, agent: { status: 'blocked' }, screen: TRUST_DIALOG, deps: { consentMode: () => 'main' },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'screen-dialog'), 'karta zaufania');
    await expect(fx.driver.respondPermission('sesja', 'allow')).resolves.toEqual({ kind: 'applied' });
    expect(digitsSent(fx)).toEqual(['1']);
  });

  async function questionCard(deps: Partial<HerdrDriverDeps>, signal: typeof WAITING_INPUT | typeof WAITING_PERMISSION) {
    const fx = await makeDriver({ transcript: userLine('zapytaj'), screen: DIALOG_QUESTION, deps });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.driver.noteCliWaiting?.(signal);
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => questions(fx.events).length > 0, 'karta pytania');
    const card = questions(fx.events).at(-1);
    const label = card?.questions[0]?.options[0]?.label ?? '';
    return { fx, reqId: card?.reqId ?? '', label };
  }

  it('formularz pytania przy `main` i klasie `input`: odpowiedź cyfrą przechodzi', async () => {
    const { fx, reqId, label } = await questionCard({ consentMode: () => 'main' }, WAITING_INPUT);
    await fx.driver.answerQuestion(reqId, [[label]]);
    await quiet();
    expect(digitsSent(fx).length).toBe(1);
  });

  it('odpowiedź przy `main` i klasie `permission` z rejestru: 0 cyfr (fail-closed)', async () => {
    const { fx, reqId, label } = await questionCard({ consentMode: () => 'main' }, WAITING_PERMISSION);
    await expect(fx.driver.answerQuestion(reqId, [[label]])).resolves.toMatchObject({ kind: 'refused' });
    await quiet();
    expect(digitsSent(fx)).toEqual([]);
  });
});

describe('kanał cienia idzie za trybem efektywnym', { timeout: 10_000 }, () => {
  function spyChannel(): { channel: ShadowConsentChannel; prepares: string[]; releases: number } {
    const state = { prepares: [] as string[], releases: 0 };
    const channel: ShadowConsentChannel = {
      prepare: (request) => {
        state.prepares.push(request.decision);
        return Promise.resolve({ result: 'no-dump' });
      },
      keySent: () => {},
      release: () => {
        state.releases += 1;
        return Promise.resolve(0);
      },
    };
    return {
      channel,
      get prepares() { return state.prepares; },
      get releases() { return state.releases; },
    };
  }

  it('efektywny `shadow` (np. konfiguracja `main` bez progu buildu): krok cienia przed cyfrą i zwolnienie sierot',
    async () => {
      const spy = spyChannel();
      const { fx, reqId } = await bashCard({ shadow: spy.channel, consentMode: () => 'shadow' }, WAITING_PERMISSION);
      fx.driver.noteCliWaiting?.(WAITING_PERMISSION);
      await expect(fx.driver.respondPermission(reqId, 'allow')).resolves.toEqual({ kind: 'applied' });
      expect(spy.prepares).toEqual(['allow']);
      expect(spy.releases).toBeGreaterThan(0);
      expect(digitsSent(fx)).toEqual(['1']);
    });

  it.each(['off', 'main'] as const)('efektywny `%s`: kanał cienia bez ani jednego wywołania', async (mode) => {
    const spy = spyChannel();
    const { fx, reqId } = await bashCard({ shadow: spy.channel, consentMode: () => mode }, WAITING_PERMISSION);
    fx.driver.noteCliWaiting?.(WAITING_PERMISSION);
    await fx.driver.respondPermission(reqId, 'allow');
    await fx.driver.respondPermission(reqId, 'deny');
    await quiet();
    expect(spy.prepares).toEqual([]);
    expect(spy.releases).toBe(0);
  });

  it('zmiana trybu w biegu: `off` → `shadow` włącza krok cienia przy następnej decyzji', async () => {
    const spy = spyChannel();
    let mode: ConsentEffectiveMode = 'off';
    const { fx, reqId } = await bashCard({ shadow: spy.channel, consentMode: () => mode }, WAITING_PERMISSION);
    mode = 'shadow';
    await fx.driver.respondPermission(reqId, 'allow');
    expect(spy.prepares).toEqual(['allow']);
    expect(digitsSent(fx)).toEqual(['1']);
  });
});

/** Zegar prawdziwego cyklu w testach z obserwacją: domyślnie `NOW`, test może go przesuwać. */
let consentClock = NOW;

/**
 * Prawdziwy rejestr sekretów i cykl, jak w serwerze. Proces wstał 10 s przed `NOW`, a blokadę startu zdjął rejestr
 * bez `waiting` 5 s po starcie; zegar cyklu to {@link consentClock}.
 */
async function unlockedCycle(): Promise<{
  dataDir: string; registry: ConsentRegistry; cycle: ConsentCycle; liveness: ProcessLiveness;
}> {
  const dataDir = join(base, 'dane');
  consentClock = NOW - 10_000;
  const now = (): number => consentClock;
  const registry = createConsentRegistry({ bootId: 'boot-drv', send: () => true, sessions: () => [SESSION], log: () => {}, now });
  registry.setScope('main');
  const cycle = createConsentCycle({ dataDir, bootId: 'boot-drv', registry, now });
  const liveness: ProcessLiveness = async (processes) => new Map(processes.map((p) => [p.pid, true]));
  consentClock = NOW - 5_000;
  await observeConsentSession(cycle, {
    dataDir, sessionId: SESSION, liveness, registry: { kind: 'active', at: consentClock }, transcript: null, screen: null,
    now,
  });
  consentClock = NOW;
  return { dataDir, registry, cycle, liveness };
}

/** Zrzut per wywołanie prośby `Bash` na dysku i rejestracja jej sekretu (hook czeka). */
async function consentDump(dataDir: string, registry: ConsentRegistry, startedAt = NOW - 1_900): Promise<HookCallDump> {
  const dump: HookCallDump = {
    key: `${CONSENT_PROMPT}-${randomBytes(16).toString('hex')}`, sessionId: SESSION, promptId: CONSENT_PROMPT, pid: 61_000,
    startedAt, toolName: 'Bash', toolInput: BASH_INPUT, cwd: '/tmp/projekt', at: startedAt + 100,
    inputSha256: canonicalSha256(BASH_INPUT), permissionMode: 'default',
  };
  await mkdir(join(dataDir, HOOK_PENDING_DIRNAME, SESSION), { recursive: true });
  await writeFile(join(dataDir, HOOK_PENDING_DIRNAME, SESSION, `${dump.key}.json`), JSON.stringify(dump));
  expect(registry.register({
    key: dump.key, sessionId: SESSION, promptId: CONSENT_PROMPT, secret: randomBytes(CONSENT_SECRET_BYTES).toString('hex'),
    inputSha256: dump.inputSha256, pid: dump.pid, startedAt: dump.startedAt,
    cardSha256: consentCardSha256({
      sessionId: SESSION, toolName: 'Bash', toolInput: BASH_INPUT, cwd: dump.cwd, agentId: null, permissionMode: 'default',
    }),
  }).status).toBe(200);
  return dump;
}

describe('kanał zgód przy `main`: obserwacja rejestru i jedna karta na dialog', { timeout: 10_000 }, () => {
  it('odczyt rejestru przy `main` woła obserwację kanału z sesją silnika; drugi odczyt w toku nie dubluje przebiegu', async () => {
    const requests: ConsentObserveRequest[] = [];
    let release: () => void = () => {};
    const fx = await makeDriver({
      transcript: userLine('zbuduj'),
      screen: DIALOG_PERMISSION,
      deps: {
        consentMode: () => 'main',
        consentObserve: (request) => {
          requests.push(request);
          return new Promise<void>((resolve) => { release = resolve; });
        },
      },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.driver.noteCliWaiting?.(WAITING_PERMISSION);
    fx.driver.noteCliWaiting?.(WAITING_PERMISSION);
    // Przy `waiting: permission` obserwacja najpierw czyta ekran, więc port dostaje prośbę po odczycie.
    await waitFor(() => requests.length === 1, 'obserwacja');
    await quiet();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ engineSessionId: SESSION, registry: { kind: 'waiting', dialog: 'permission' } });
    release();
    await quiet();
    fx.driver.noteCliWaiting?.(WAITING_PERMISSION);
    await waitFor(() => requests.length === 2, 'druga obserwacja');
  });

  it('obserwacja dostaje z followera otwarte i zamknięte `tool_use` (skrót wejścia, chwila wpisu, który je zamknął)', async () => {
    const requests: ConsentObserveRequest[] = [];
    const resultLine = `${JSON.stringify({
      type: 'user', isSidechain: false, timestamp: '2026-08-22T10:00:09.500Z', sessionId: SESSION,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bash', content: 'ok' }] },
    })}\n`;
    const readInput = { file_path: '/tmp/a.txt' };
    const fx = await makeDriver({
      transcript: userLine('zbuduj') + toolUseLine('toolu_bash', 'Bash', BASH_INPUT) + resultLine
        + toolUseLine('toolu_read', 'Read', readInput),
      screen: DIALOG_PERMISSION,
      deps: { consentMode: () => 'main', consentObserve: async (request) => { requests.push(request); } },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.driver.noteCliWaiting?.(WAITING_PERMISSION);
    await quiet();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.transcript).toEqual({
      open: [expect.objectContaining({ toolName: 'Read', input: readInput })],
      closed: [expect.objectContaining({
        toolName: 'Bash', inputSha256: canonicalSha256(BASH_INPUT), closedAt: Date.parse('2026-08-22T10:00:09.500Z'),
      })],
      lostAt: null,
    });
  });

  it('skrócenie transkryptu do pustego pliku przed upływem 5 s: utrata pokrycia dociera przez driver do cyklu,'
    + ' karta prośby rozstrzygniętej przy biurku bez przycisku, `decide(allow)` odrzucone', async () => {
    const { dataDir, registry, cycle, liveness } = await unlockedCycle();
    // Prośba rozstrzygnięta przy biurku: wynik `tool_use` po starcie hooka, hook dalej żyje.
    const dump: HookCallDump = {
      key: `${CONSENT_PROMPT}-${'a'.repeat(32)}`, sessionId: SESSION, promptId: CONSENT_PROMPT, pid: 61_000,
      startedAt: NOW - 1_900, toolName: 'Bash', toolInput: BASH_INPUT, cwd: '/tmp/projekt', at: NOW - 1_800,
      inputSha256: canonicalSha256(BASH_INPUT), permissionMode: 'default',
    };
    await mkdir(join(dataDir, HOOK_PENDING_DIRNAME, SESSION), { recursive: true });
    await writeFile(join(dataDir, HOOK_PENDING_DIRNAME, SESSION, `${dump.key}.json`), JSON.stringify(dump));
    expect(registry.register({
      key: dump.key, sessionId: SESSION, promptId: CONSENT_PROMPT, secret: randomBytes(CONSENT_SECRET_BYTES).toString('hex'),
      inputSha256: dump.inputSha256, pid: dump.pid, startedAt: dump.startedAt,
      cardSha256: consentCardSha256({
        sessionId: SESSION, toolName: 'Bash', toolInput: BASH_INPUT, cwd: dump.cwd, agentId: null, permissionMode: 'default',
      }),
    }).status).toBe(200);
    const requests: ConsentObserveRequest[] = [];
    const at = (ms: number): string => new Date(ms).toISOString();
    const entry = (fields: Record<string, unknown>): string => `${JSON.stringify({ isSidechain: false, sessionId: SESSION, ...fields })}\n`;
    const fx = await makeDriver({
      transcript: entry({ type: 'user', timestamp: at(NOW - 6_000), message: { role: 'user', content: 'zbuduj' } })
        + entry({
          type: 'assistant', timestamp: at(NOW - 2_000),
          message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_biurko', name: 'Bash', input: BASH_INPUT }] },
        })
        + entry({
          type: 'user', timestamp: at(NOW - 1_000),
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_biurko', content: 'ok' }] },
        }),
      // Cała ramka `Bash` z komendą prośby: przycisk zabierają wyłącznie fakty transkryptu.
      screen: bashFrame(BASH_INPUT.command),
      deps: {
        consentMode: () => 'main',
        follow: (o) => createJsonlFollower({ ...o, root, watch: false, timing: TIMING, now: () => NOW }),
        consentObserve: async (request) => {
          requests.push(request);
          await observeConsentSession(cycle, {
            dataDir, sessionId: request.engineSessionId, liveness, registry: request.registry, transcript: request.transcript,
            screen: request.screen, now: () => NOW,
          });
        },
      },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    const card = (): unknown => {
      const view = cycle.card(SESSION, dump.key);
      return view === null ? null : { state: view.state, canAllow: view.canAllow };
    };
    fx.driver.noteCliWaiting?.(WAITING_PERMISSION);
    await waitFor(() => requests.length === 1 && card() !== null, 'pierwsza obserwacja');
    expect(card()).toEqual({ state: 'pending', canAllow: false });
    // CLI skraca plik do zera: follower wie, że plik jest pusty i że zamknięcia sprzed skrócenia przepadły.
    await writeFile(join(root, projectSlug(join(base, 'projekt')), `${SESSION}.jsonl`), '');
    await waitFor(() => fx.events.some((e) => e.type === 'message' && e.role === 'system'), 'notka o skróceniu');
    await quiet();
    fx.driver.noteCliWaiting?.(WAITING_PERMISSION);
    await waitFor(() => requests.length === 2, 'druga obserwacja');
    await quiet();
    expect(requests[1]?.transcript).toEqual({ open: [], closed: [], lostAt: NOW });
    expect(card()).toEqual({ state: 'pending', canAllow: false });
    expect(await cycle.decide(SESSION, dump.key, 'allow')).toEqual({ ok: false, error: 'card-changed', state: 'pending' });
  });

  it('przy `all` odczyt rejestru woła obserwację kanału jak przy `main`: `busy` bez odczytu ekranu, `waiting:'
    + ' permission` z odczytem (S3b-1a)', async () => {
    const requests: ConsentObserveRequest[] = [];
    const fx = await makeDriver({
      transcript: userLine('zbuduj'),
      screen: DIALOG_PERMISSION,
      deps: { consentMode: () => 'all', consentObserve: async (request) => { requests.push(request); } },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.driver.noteCliWaiting?.({ kind: 'active' });
    await waitFor(() => requests.length === 1, 'obserwacja przy `busy`');
    await quiet();
    expect(requests[0]).toMatchObject({ engineSessionId: SESSION, registry: { kind: 'active' }, screen: null });
    fx.driver.noteCliWaiting?.(WAITING_PERMISSION);
    await waitFor(() => requests.length === 2, 'obserwacja przy `waiting: permission`');
    expect(requests[1]).toMatchObject({ registry: { kind: 'waiting', dialog: 'permission' } });
    expect(requests[1]?.screen).not.toBeNull();
  });

  it.each<ConsentEffectiveMode>(['off', 'shadow'])('przy `%s` obserwacji kanału nie ma', async (mode) => {
    const requests: ConsentObserveRequest[] = [];
    const fx = await makeDriver({
      transcript: userLine('zbuduj'),
      screen: DIALOG_PERMISSION,
      deps: { consentMode: () => mode, consentObserve: async (request) => { requests.push(request); } },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.driver.noteCliWaiting?.(WAITING_PERMISSION);
    await quiet();
    expect(requests).toEqual([]);
  });

  it('driver odpięty (`dispose`, stary driver przy `re-attached`) nie zaczyna obserwacji kanału: odczyt rejestru po'
    + ' odpięciu nie woła portu, więc pierwsza obserwacja po granicy w cyklu należy do nowego drivera', async () => {
    const requests: ConsentObserveRequest[] = [];
    const fx = await makeDriver({
      transcript: userLine('zbuduj'),
      screen: DIALOG_PERMISSION,
      deps: { consentMode: () => 'main', consentObserve: async (request) => { requests.push(request); } },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.driver.noteCliWaiting?.(WAITING_PERMISSION);
    await quiet();
    expect(requests).toHaveLength(1);
    fx.driver.dispose();
    fx.driver.noteCliWaiting?.(WAITING_PERMISSION);
    await quiet();
    expect(requests).toHaveLength(1);
  });

  it('żywa karta kanału: karta zgody z ekranu i jsonl nie idzie do managera, 0 cyfr', async () => {
    const fx = await makeDriver({
      transcript: userLine('zbuduj') + toolUseLine('toolu_bash', 'Bash', BASH_INPUT),
      screen: DIALOG_PERMISSION,
      deps: { consentMode: () => 'main', consentCardLive: (engine) => engine === SESSION },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.driver.noteCliWaiting?.(WAITING_PERMISSION);
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await quiet();
    await quiet();
    expect(permissions(fx.events)).toEqual([]);
    expect(digitsSent(fx)).toEqual([]);
  });

  it('bez żywej karty kanału (albo gdy odczyt rzuca) karta z ekranu idzie, nadal bez zgody', async () => {
    for (const live of [() => false, () => { throw new Error('cykl'); }]) {
      const { fx, reqId } = await bashCard({ consentMode: () => 'main', consentCardLive: live }, WAITING_PERMISSION);
      expect(permissions(fx.events).at(-1)?.canAllow).toBe(false);
      await expect(fx.driver.respondPermission(reqId, 'allow')).resolves.toMatchObject({ kind: 'refused' });
      await quiet();
      expect(digitsSent(fx)).toEqual([]);
    }
  });
});

/** Sterowany zegar drivera (wzór: `herdr-driver.test.ts`): timery odpalają się tylko w `advance`, w kolejności terminów. */
function drivenClock(): { scheduler: Scheduler; advance: (ms: number) => Promise<void> } {
  let at = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const scheduler: Scheduler = {
    setTimeout: (fn, ms) => {
      seq += 1;
      timers.set(seq, { at: at + ms, fn });
      return seq;
    },
    clearTimeout: (handle) => { timers.delete(handle as number); },
    now: () => at,
  };
  // Obserwacja drivera jest asynchroniczna (odczyt rejestru, ekranu, port): po każdym timerze oddać pętli zdarzeń.
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 30; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
  };
  const advance = async (ms: number): Promise<void> => {
    const target = at + ms;
    for (;;) {
      await flush();
      let id: number | null = null;
      let due = Number.POSITIVE_INFINITY;
      for (const [key, timer] of timers) {
        if (timer.at <= target && timer.at < due) { id = key; due = timer.at; }
      }
      if (id === null) break;
      const timer = timers.get(id);
      timers.delete(id);
      at = due;
      timer?.fn();
    }
    at = target;
    await flush();
  };
  return { scheduler, advance };
}

describe('kanał zgód przy `all`: prośba subagenta w `pending`, obserwacja co ≤1 s', { timeout: 10_000 }, () => {
  interface Watch {
    readonly fx: Fixture;
    readonly advance: (ms: number) => Promise<void>;
    /** Zegar drivera w ms od startu. */
    readonly now: () => number;
    /** Obserwacje z chwilą zegara drivera (ms od startu) przy wywołaniu portu. */
    readonly seen: { readonly request: ConsentObserveRequest; readonly at: number }[];
    /** Chwile zegara drivera (ms od startu) przy odczytach rejestru portem `consentRegistryRead`. */
    readonly reads: number[];
  }

  /**
   * Driver na sterowanym zegarze: `now` drivera = `NOW` + zegar; czekająca prośba subagenta według `pending` (domyślnie
   * tylko w sesji `SESSION`), port rejestru odpowiada `registry(sesja)`, a `observe` dostaje każdą obserwację po zapisie.
   */
  async function watch(opts: {
    mode?: () => ConsentEffectiveMode; pending?: (engineSessionId: string) => boolean;
    registry?: (engineSessionId: string) => CliWaitingSignal | Promise<CliWaitingSignal>; screen?: string;
    observe?: (request: ConsentObserveRequest) => Promise<void>;
  } = {}): Promise<Watch> {
    const clock = drivenClock();
    const seen: { request: ConsentObserveRequest; at: number }[] = [];
    const reads: number[] = [];
    const fx = await makeDriver({
      transcript: userLine('zbuduj'),
      screen: opts.screen ?? '',
      deps: {
        scheduler: clock.scheduler,
        now: () => NOW + clock.scheduler.now(),
        consentMode: opts.mode ?? (() => 'all'),
        consentSubagentPending: (engineSessionId) => (opts.pending ?? ((one) => one === SESSION))(engineSessionId),
        consentRegistryRead: async (engineSessionId) => {
          reads.push(clock.scheduler.now());
          return (opts.registry ?? ((): CliWaitingSignal => ({ kind: 'active' })))(engineSessionId);
        },
        consentObserve: async (request) => {
          seen.push({ request, at: clock.scheduler.now() });
          await opts.observe?.(request);
        },
      },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    return { fx, advance: clock.advance, now: () => clock.scheduler.now(), seen, reads };
  }

  it('rejestr `busy`, bez dialogu wątku głównego, prośba subagenta w `pending`: obserwacja co ≤1 s, każda ze świeżym'
    + ' odczytem rejestru (chwila sprzed zapytania) i `screen: null`, choć manager przeczytał rejestr raz', async () => {
    const w = await watch();
    w.fx.driver.noteCliWaiting?.({ kind: 'active' });
    await w.advance(0);
    for (let i = 0; i < 5; i += 1) await w.advance(1_000);
    const at = w.seen.map((one) => one.at);
    expect(at.length).toBeGreaterThanOrEqual(6);
    for (let i = 1; i < at.length; i += 1) expect((at[i] ?? 0) - (at[i - 1] ?? 0)).toBeLessThanOrEqual(1_000);
    expect(at.at(-1)).toBeGreaterThanOrEqual(4_000);
    expect(w.reads).toEqual(at);
    for (const one of w.seen) {
      expect(one.request).toMatchObject({ engineSessionId: SESSION, registry: { kind: 'active', at: NOW + one.at } });
      expect(one.request.screen).toBeNull();
    }
    // Ekranu w takcie nikt nie czytał: obserwacja bez `waiting: permission` nie pyta herdr o ekran.
    expect(w.fx.client.calls.filter((call) => call.method === 'read')).toEqual([]);
  });

  it('świeży odczyt `waiting: permission` w takcie: obserwacja czyta ekran sama, z chwilą sprzed zapytania', async () => {
    let signal: CliWaitingSignal = { kind: 'active' };
    const screen = bashFrame(BASH_INPUT.command);
    const w = await watch({ registry: () => signal, screen });
    w.fx.driver.noteCliWaiting?.({ kind: 'active' });
    await w.advance(0);
    expect(w.seen.map((one) => one.request.screen)).toEqual([null]);
    signal = WAITING_PERMISSION;
    await w.advance(1_000);
    await waitFor(() => w.seen.length === 2, 'obserwacja z ekranem');
    expect(w.seen[1]?.request).toMatchObject({
      registry: { kind: 'waiting', dialog: 'permission', at: NOW + 1_000 },
      screen: { text: screen, readStartedAt: NOW + 1_000 },
    });
  });

  it('odczyt rejestru managera w trakcie taktu kasuje zaplanowaną obserwację: następna ≤1 s od początku tej z odczytu'
    + ' managera, bez dubla', async () => {
    const w = await watch();
    w.fx.driver.noteCliWaiting?.({ kind: 'active' });
    await w.advance(400);
    w.fx.driver.noteCliWaiting?.({ kind: 'active' });
    await w.advance(600);
    await w.advance(400);
    expect(w.seen.map((one) => one.at)).toEqual([0, 400, 1_400]);
  });

  it('przy `main` taktu nie ma i port rejestru milczy: obserwacja tylko z odczytu managera, z jego chwilą', async () => {
    const w = await watch({ mode: () => 'main' });
    w.fx.driver.noteCliWaiting?.({ kind: 'active' });
    await w.advance(0);
    await w.advance(3_000);
    expect(w.seen).toHaveLength(1);
    expect(w.seen[0]?.request).toMatchObject({ registry: { kind: 'active', at: NOW }, screen: null });
    expect(w.reads).toEqual([]);
  });

  it('bez czekającej prośby subagenta (także gdy port rzuca) taktu nie ma; prośba rozstrzygnięta zatrzymuje takt',
    async () => {
      for (const pending of [() => false, () => { throw new Error('cykl'); }]) {
        const w = await watch({ pending });
        w.fx.driver.noteCliWaiting?.({ kind: 'active' });
        await w.advance(0);
        await w.advance(3_000);
        expect(w.seen).toHaveLength(1);
        expect(w.reads).toEqual([]);
      }
      let open = true;
      const w = await watch({ pending: () => open });
      w.fx.driver.noteCliWaiting?.({ kind: 'active' });
      await w.advance(0);
      await w.advance(1_000);
      expect(w.seen).toHaveLength(2);
      open = false;
      await w.advance(1_000);
      await w.advance(3_000);
      // Takt zaplanowany przed rozstrzygnięciem sprawdza prośbę przy odpaleniu: bez niej obserwacji nie wyzwala.
      expect(w.seen.map((one) => one.at)).toEqual([0, 1_000]);
      expect(w.reads).toEqual([0, 1_000]);
    });

  it('wyjątek odczytu rejestru: obserwacja z ostatnim sygnałem managera i jego chwilą, takt trwa', async () => {
    const w = await watch({ registry: () => { throw new Error('rejestr'); } });
    w.fx.driver.noteCliWaiting?.({ kind: 'active' });
    await w.advance(0);
    await w.advance(1_000);
    await w.advance(1_000);
    expect(w.seen.map((one) => one.at)).toEqual([0, 1_000, 2_000]);
    for (const one of w.seen) expect(one.request.registry).toEqual({ kind: 'active', at: NOW });
  });

  it('szturchnięcie kanału w trakcie obserwacji: następna zaraz po jej końcu, a takt ≤1 s liczy się od początku tej'
    + ' następnej, bez dubla', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const w = await watch({
      observe: async () => {
        calls += 1;
        if (calls === 1) await gate;
      },
    });
    w.fx.driver.noteCliWaiting?.({ kind: 'active' });
    await w.advance(0);
    expect(w.seen.map((one) => one.at)).toEqual([0]);
    await w.advance(300);
    w.fx.driver.noteConsentNudge?.(WAITING_PERMISSION);
    await w.advance(0);
    // Obserwacja w toku: szturchnięcie nie zaczyna drugiej równolegle.
    expect(w.seen.map((one) => one.at)).toEqual([0]);
    release();
    await w.advance(0);
    expect(w.seen.map((one) => one.at)).toEqual([0, 300]);
    await w.advance(1_000);
    expect(w.seen.map((one) => one.at)).toEqual([0, 300, 1_300]);
    expect(w.reads).toEqual([0, 300, 1_300]);
  });

  it('`dispose` zatrzymuje takt', async () => {
    const w = await watch();
    w.fx.driver.noteCliWaiting?.({ kind: 'active' });
    await w.advance(0);
    w.fx.driver.dispose();
    await w.advance(3_000);
    expect(w.seen).toHaveLength(1);
  });

  it('`session-changed` kasuje takt sesji A: żywa karta wątku głównego sesji B bez czekającego subagenta zostaje'
    + ' `pending`, a obserwacji ze starym sygnałem rejestru A nie ma', async () => {
    const dataDir = join(base, 'dane-b');
    let driven: Watch | null = null;
    /** Zegar cyklu = zegar drivera. */
    const at = (): number => NOW + (driven?.now() ?? 0);
    const registry = createConsentRegistry({
      bootId: 'boot-drv', send: () => true, sessions: () => [SESSION, SESSION_B], log: () => {}, now: at,
    });
    registry.setScope('all');
    const cycle = createConsentCycle({ dataDir, bootId: 'boot-drv', registry, now: at, mode: () => 'all' });
    const liveness: ProcessLiveness = async (processes) => new Map(processes.map((p) => [p.pid, true]));
    const observe = async (request: ConsentObserveRequest): Promise<void> => {
      await observeConsentSession(cycle, {
        dataDir, sessionId: request.engineSessionId, liveness, registry: request.registry,
        transcript: request.transcript, screen: request.screen, now: at, subagentTurns: async (r) => r.map(() => null),
      });
    };
    const w = await watch({ observe });
    driven = w;
    // Prośba wątku głównego sesji B: zrzut sprzed ponad 2 s, hook żyje, rejestracja przyjęta.
    const dump: HookCallDump = {
      key: `${CONSENT_PROMPT}-${'b'.repeat(32)}`, sessionId: SESSION_B, promptId: CONSENT_PROMPT, pid: 61_100,
      startedAt: NOW - 4_000, toolName: 'Bash', toolInput: BASH_INPUT, cwd: '/tmp/projekt', at: NOW - 3_900,
      inputSha256: canonicalSha256(BASH_INPUT), permissionMode: 'default',
    };
    await mkdir(join(dataDir, HOOK_PENDING_DIRNAME, SESSION_B), { recursive: true });
    await writeFile(join(dataDir, HOOK_PENDING_DIRNAME, SESSION_B, `${dump.key}.json`), JSON.stringify(dump));
    expect(registry.register({
      key: dump.key, sessionId: SESSION_B, promptId: CONSENT_PROMPT,
      secret: randomBytes(CONSENT_SECRET_BYTES).toString('hex'), inputSha256: dump.inputSha256, pid: dump.pid,
      startedAt: dump.startedAt, cardSha256: consentCardSha256({
        sessionId: SESSION_B, toolName: 'Bash', toolInput: BASH_INPUT, cwd: dump.cwd, agentId: null,
        permissionMode: 'default',
      }),
    }).status).toBe(200);

    // Sesja A: odczyt managera `active` i takt prośby subagenta uzbrojony na 1 s.
    w.fx.driver.noteCliWaiting?.({ kind: 'active' });
    await w.advance(500);
    expect(w.seen.map((one) => one.request.engineSessionId)).toEqual([SESSION]);
    w.fx.emit({ type: 'session-changed', agentSessionId: SESSION_B });
    // Karta sesji B z obserwacji przy jej dialogu (rejestr `waiting: permission`, bez ekranu: bez przycisku).
    await observeConsentSession(cycle, {
      dataDir, sessionId: SESSION_B, liveness, registry: { kind: 'waiting', dialog: 'permission', at: at() },
      transcript: null, screen: null, now: at, subagentTurns: async (r) => r.map(() => null),
    });
    expect(cycle.card(SESSION_B, dump.key)?.state).toBe('pending');
    await w.advance(500);
    await w.advance(2_000);
    expect(cycle.card(SESSION_B, dump.key)?.state).toBe('pending');
    expect(cycle.record(SESSION_B, dump.key)?.decision).toBeNull();
    expect(w.seen.filter((one) => one.request.engineSessionId === SESSION_B)).toEqual([]);
  });

  it('obserwacja sesji B z czekającym subagentem i odczytem rejestru, który rzuca: rejestr nieznany, nie sygnał A',
    async () => {
      let answerA: (signal: CliWaitingSignal) => void = () => {};
      const w = await watch({
        pending: () => true,
        registry: (engineSessionId) => {
          if (engineSessionId === SESSION) return new Promise<CliWaitingSignal>((resolve) => { answerA = resolve; });
          throw new Error('rejestr');
        },
      });
      // Odczyt managera sesji A, obserwacja A czeka na własny odczyt rejestru; w tym czasie nowa rozmowa w panelu.
      w.fx.driver.noteCliWaiting?.({ kind: 'active' });
      await w.advance(0);
      w.fx.emit({ type: 'session-changed', agentSessionId: SESSION_B });
      answerA({ kind: 'active' });
      await w.advance(0);
      expect(w.seen).toEqual([]);
      // Po końcu obserwacji A takt idzie już za sesją B.
      await w.advance(1_000);
      const b = w.seen.filter((one) => one.request.engineSessionId === SESSION_B);
      expect(b.length).toBeGreaterThan(0);
      for (const one of b) expect(one.request.registry).toEqual({ kind: 'unknown', why: 'unread' });
    });
});

describe('ekran obserwacji kanału zgód: własny odczyt przy `waiting: permission`', { timeout: 10_000 }, () => {
  /**
   * Odczyty ekranu, które test kończy sam (`answer` kończy wszystkie czekające); `reads` = chwile zegara drivera przy
   * zapytaniach. Przy pierwszym `waiting` epizodu ekran czyta też ocena dialogu, więc odczytów bywa więcej niż jeden.
   */
  function heldRead(fx: Fixture): { reads: number[]; answer: (text: string) => void } {
    const pending: ((text: string) => void)[] = [];
    const held = {
      reads: [] as number[],
      answer: (text: string): void => { for (const resolve of pending.splice(0)) resolve(text); },
    };
    fx.client.readScreen = () => {
      held.reads.push(consentClock);
      fx.client.calls.push({ method: 'read' });
      return new Promise<HerdrScreen>((resolve) => { pending.push((text) => { resolve({ text }); }); });
    };
    return held;
  }

  it('`waiting: permission` → obserwacja czyta ekran sama i podaje `{ text, readStartedAt }` z chwilą sprzed'
    + ' zapytania; rejestr wysłany z tą samą chwilą', async () => {
    consentClock = NOW;
    const requests: ConsentObserveRequest[] = [];
    const fx = await makeDriver({
      transcript: userLine('zbuduj'), screen: bashFrame(BASH_INPUT.command),
      deps: { now: () => consentClock, consentMode: () => 'main', consentObserve: async (request) => { requests.push(request); } },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    const held = heldRead(fx);
    fx.driver.noteCliWaiting?.(WAITING_PERMISSION);
    expect(held.reads.length).toBeGreaterThan(0);
    expect(held.reads.every((at) => at === NOW)).toBe(true);
    expect(requests).toEqual([]);
    consentClock = NOW + 700;
    held.answer('ekran z odczytu obserwacji');
    await waitFor(() => requests.length === 1, 'obserwacja');
    expect(requests[0]).toMatchObject({
      registry: { kind: 'waiting', dialog: 'permission', at: NOW },
      screen: { text: 'ekran z odczytu obserwacji', readStartedAt: NOW },
    });
  });

  it.each([
    ['`active`', { kind: 'active' }],
    ['`waiting: input`', WAITING_INPUT],
  ] as const)('rejestr %s → obserwacja bez ekranu (`screen: null`)', async (_name, signal) => {
    const requests: ConsentObserveRequest[] = [];
    const fx = await makeDriver({
      transcript: userLine('zbuduj'), screen: bashFrame(BASH_INPUT.command),
      deps: { consentMode: () => 'main', consentObserve: async (request) => { requests.push(request); } },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.driver.noteCliWaiting?.(signal);
    await waitFor(() => requests.length === 1, 'obserwacja');
    expect(requests[0]?.screen).toBeNull();
  });

  it('`dispose` w trakcie odczytu ekranu → obserwacji nie ma', async () => {
    const requests: ConsentObserveRequest[] = [];
    const fx = await makeDriver({
      transcript: userLine('zbuduj'), screen: bashFrame(BASH_INPUT.command),
      deps: { consentMode: () => 'main', consentObserve: async (request) => { requests.push(request); } },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    const held = heldRead(fx);
    fx.driver.noteCliWaiting?.(WAITING_PERMISSION);
    expect(held.reads.length).toBeGreaterThan(0);
    fx.driver.dispose();
    held.answer(bashFrame(BASH_INPUT.command));
    await quiet();
    expect(requests).toEqual([]);
  });

  /** Driver z prawdziwą obserwacją i cyklem; `observed` = liczba skończonych obserwacji. */
  async function realDriver(): Promise<{
    fx: Fixture; cycle: ConsentCycle; dump: HookCallDump; observed: () => number;
  }> {
    const { dataDir, registry, cycle, liveness } = await unlockedCycle();
    const dump = await consentDump(dataDir, registry, NOW - 1_000);
    let observed = 0;
    const fx = await makeDriver({
      transcript: userLine('zbuduj'), screen: bashFrame(BASH_INPUT.command),
      deps: {
        now: () => consentClock,
        consentMode: () => 'main',
        consentObserve: async (request) => {
          await observeConsentSession(cycle, {
            dataDir, sessionId: request.engineSessionId, liveness, registry: request.registry,
            transcript: request.transcript, screen: request.screen, now: () => consentClock,
          });
          observed += 1;
        },
      },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    return { fx, cycle, dump, observed: () => observed };
  }

  it('prawdziwy cykl, takt rejestru 1,5 s: przycisk zgody w każdym takcie z ekranu przeczytanego w tej obserwacji;'
    + ' ekran z inną komendą → bez przycisku w następnym takcie, z powrotem ta komenda → przycisk', async () => {
    const { fx, cycle, dump, observed } = await realDriver();
    const card = (): unknown => {
      const view = cycle.card(SESSION, dump.key);
      return view === null ? null : { state: view.state, canAllow: view.canAllow };
    };
    const tick = async (): Promise<unknown> => {
      const before = observed();
      consentClock += 1_500;
      fx.driver.noteCliWaiting?.(WAITING_PERMISSION);
      await waitFor(() => observed() === before + 1, 'obserwacja taktu');
      return card();
    };
    const seen: unknown[] = [];
    for (let n = 0; n < 6; n += 1) seen.push(await tick());
    expect(seen).toEqual(seen.map(() => ({ state: 'pending', canAllow: true })));
    fx.client.screenText = bashFrame('pnpm exec vitest run server/test/inny-plik.test.ts');
    expect(await tick()).toEqual({ state: 'pending', canAllow: false });
    fx.client.screenText = bashFrame(BASH_INPUT.command);
    expect(await tick()).toEqual({ state: 'pending', canAllow: true });
  });

  it('prawdziwy cykl: odpowiedź `readScreen` spóźniona ponad termin dowodu → bez przycisku zgody', async () => {
    const { fx, cycle, dump, observed } = await realDriver();
    const read = fx.client.readScreen.bind(fx.client);
    fx.client.readScreen = async () => {
      const screen = await read();
      consentClock += CONSENT_PROOF_TTL_MS + 100;
      return screen;
    };
    fx.driver.noteCliWaiting?.(WAITING_PERMISSION);
    await waitFor(() => observed() === 1, 'obserwacja');
    expect(cycle.card(SESSION, dump.key)).toMatchObject({ state: 'pending', canAllow: false });
  });
});

describe('klawisz decyzji z ekranu, gdy dialog przejęła karta kanału', { timeout: 10_000 }, () => {
  /** Karta kanału (`pending`) pojawia się w trakcie świeżego odczytu ekranu przed klawiszem decyzji. */
  function channelCardDuringRead(fx: Fixture, live: { value: boolean }): void {
    const read = fx.client.readScreen.bind(fx.client);
    fx.client.readScreen = () => {
      live.value = true;
      return read();
    };
  }

  it('`deny` na karcie z ekranu: karta kanału pojawia się w trakcie odczytu ekranu → 0 `escape`, wynik `stale`'
    + ' (410 u managera)', async () => {
    const live = { value: false };
    const { fx, reqId } = await bashCard(
      { consentMode: () => 'main', consentCardLive: () => live.value }, WAITING_PERMISSION,
    );
    channelCardDuringRead(fx, live);
    await expect(fx.driver.respondPermission(reqId, 'deny')).resolves.toEqual({ kind: 'stale' });
    await quiet();
    expect(live.value).toBe(true);
    expect(keysSent(fx)).toEqual([]);
  });

  it('zgoda cyfrą na karcie z ekranu: karta kanału pojawia się w trakcie odczytu ekranu → 0 cyfr, wynik `stale`',
    async () => {
      const live = { value: false };
      const { fx, reqId } = await bashCard(
        { consentMode: () => 'off', consentCardLive: () => live.value }, WAITING_PERMISSION,
      );
      channelCardDuringRead(fx, live);
      await expect(fx.driver.respondPermission(reqId, 'allow')).resolves.toEqual({ kind: 'stale' });
      await quiet();
      expect(live.value).toBe(true);
      expect(keysSent(fx)).toEqual([]);
    });

  it('odczyt kart kanału rzuca: cyfra zgody nie idzie (przy wątpliwości bez zgody), `escape` odmowy idzie', async () => {
    const broken = (): boolean => { throw new Error('cykl'); };
    const allowed = await bashCard({ consentMode: () => 'off', consentCardLive: broken }, WAITING_PERMISSION);
    await expect(allowed.fx.driver.respondPermission(allowed.reqId, 'allow')).resolves.toEqual({ kind: 'stale' });
    await quiet();
    expect(keysSent(allowed.fx)).toEqual([]);
    const denied = await bashCard({ consentMode: () => 'main', consentCardLive: broken }, WAITING_PERMISSION);
    await expect(denied.fx.driver.respondPermission(denied.reqId, 'deny')).resolves.toEqual({ kind: 'applied' });
    expect(keysSent(denied.fx)).toEqual([['escape']]);
  });

  it('bez karty kanału odmowa idzie `escape`, a zgoda cyfrą jak dotąd', async () => {
    const denied = await bashCard({ consentMode: () => 'main', consentCardLive: () => false }, WAITING_PERMISSION);
    await expect(denied.fx.driver.respondPermission(denied.reqId, 'deny')).resolves.toEqual({ kind: 'applied' });
    expect(keysSent(denied.fx)).toEqual([['escape']]);
    const allowed = await bashCard({ consentMode: () => 'off', consentCardLive: () => false }, WAITING_PERMISSION);
    await expect(allowed.fx.driver.respondPermission(allowed.reqId, 'allow')).resolves.toEqual({ kind: 'applied' });
    expect(digitsSent(allowed.fx)).toEqual(['1']);
  });
});

// ---------------------------------------------------------------------------
// Macierz korpusu: ekrany zgody × zrzut × karta kanału × rejestr, wszystkie wejścia decyzji
// ---------------------------------------------------------------------------

interface CorpusShot {
  readonly event: string;
  readonly dialogKind: string | null;
  readonly knownDialog: string | null;
}
const CORPUS = JSON.parse(readFileSync(join(FIXTURES, 'karty-korpusu-pelne.json'), 'utf8')) as {
  screens: Record<string, CorpusShot>;
};
const SCREEN_MARK = '\n--- ekran ---\n';

/** Ekran fixture'u korpusu; zrzut odmowy (`refusals/`) ma nad ekranem nagłówek. */
function corpusScreen(name: string): string {
  const raw = readFileSync(join(FIXTURES, name), 'utf8');
  const at = raw.indexOf(SCREEN_MARK);
  return at < 0 ? raw : raw.slice(at + SCREEN_MARK.length);
}

/** Ekrany zgody korpusu: dialog narzędzia albo potwierdzenie spoza zamkniętej listy dialogów. */
const CONSENT_SCREENS = Object.entries(CORPUS.screens)
  .filter(([, shot]) => (shot.dialogKind === 'tool' || shot.dialogKind === 'confirm') && shot.knownDialog === null)
  .map(([name]) => name);

const MATRIX = DUMPS.flatMap((dump) => [true, false].flatMap((live) => [WAITING_PERMISSION, null]
  .map((signal) => ({ dump, live, signal }))));

type CardEvent = Extract<DriverEvent, { type: 'permission-request' | 'question-request' | 'screen-dialog' }>;
const cardsOf = (events: readonly DriverEvent[]): CardEvent[] => events.filter((e): e is CardEvent =>
  e.type === 'permission-request' || e.type === 'question-request' || e.type === 'screen-dialog');

/** Ekran korpusu w driverze: historia, opcjonalnie klasa z rejestru, panel `blocked`, karta albo odczyt ekranu. */
async function corpusDriver(name: string, deps: Partial<HerdrDriverDeps>, signal: typeof WAITING_PERMISSION | null,
  cardExpected: boolean): Promise<Fixture> {
  const fx = await makeDriver({ transcript: userLine('zbuduj'), screen: corpusScreen(name), deps });
  await waitFor(() => fx.events.some((e) => e.type === 'history'), `historia ${name}`);
  if (signal !== null) fx.driver.noteCliWaiting?.(signal);
  fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
  await waitFor(() => (cardExpected ? cardsOf(fx.events).length > 0 : fx.client.calls.some((c) => c.method === 'read')),
    `karta ${name}`);
  await quiet();
  return fx;
}

/**
 * Wszystkie wejścia decyzji, którymi manager rusza driver: karta po `reqId` (`POST …/permissions/:permId`, także
 * „nie pytaj więcej”), dialog adresowany sesją (`POST …/permission`, `respondPermission` z id sesji) i odpowiedź na
 * potwierdzenie z ekranu (endpoint pytań).
 */
async function decideEverywhere(fx: Fixture): Promise<void> {
  const reqIds = new Set<string>(['sesja']);
  for (const card of cardsOf(fx.events)) if ('reqId' in card) reqIds.add(card.reqId);
  for (const reqId of reqIds) {
    await fx.driver.respondPermission(reqId, 'allow');
    await fx.driver.respondPermission(reqId, 'allow-always');
  }
  for (const question of questions(fx.events)) {
    await fx.driver.answerQuestion(question.reqId, [[question.questions[0]?.options[0]?.label ?? '']]);
  }
  await quiet();
}

describe('macierz korpusu przy `main`: zgoda z ekranu nie dostaje cyfry przez żadne wejście', { timeout: 30_000 }, () => {
  it('korpus daje ekrany zgody wszystkich trzech rodzajów kart', () => {
    const events = new Set(CONSENT_SCREENS.map((name) => CORPUS.screens[name]?.event));
    expect(events).toEqual(new Set(['permission-request', 'question-request', 'screen-dialog']));
    expect(CONSENT_SCREENS.length).toBeGreaterThanOrEqual(58);
  });

  it.each(CONSENT_SCREENS)('%s: zrzut × karta kanału × rejestr → 0 cyfr', async (name) => {
    for (const { dump, live, signal } of MATRIX) {
      const fx = await corpusDriver(name, {
        ...dumpDeps(dump), consentMode: () => 'main', consentCardLive: () => live,
      }, signal, !live);
      await decideEverywhere(fx);
      expect(digitsSent(fx), `${name} zrzut ${dump} kanał ${String(live)} rejestr ${String(signal?.dialog ?? null)}`)
        .toEqual([]);
      fx.driver.dispose();
    }
  });

  it('strażnik: przy `off` ekrany zgody z kartą po `reqId` dostają cyfrę', async () => {
    let withDigit = 0;
    for (const name of CONSENT_SCREENS.filter((n) => CORPUS.screens[n]?.event === 'permission-request')) {
      const fx = await corpusDriver(name, { consentMode: () => 'off' }, null, true);
      await decideEverywhere(fx);
      if (digitsSent(fx).length > 0) withDigit += 1;
      fx.driver.dispose();
    }
    expect(withDigit).toBeGreaterThan(0);
  });
});

describe('kanał zgód bez czekania na takt: szturchnięcie i karta zgody czekająca na kartę kanału', {
  timeout: 10_000,
}, () => {
  const ACTIVE = { kind: 'active' } as const;
  const UNKNOWN = { kind: 'unknown' } as const;
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  it('szturchnięcie z `waiting: permission` zaczyna obserwację od razu, z własnym odczytem ekranu', async () => {
    const requests: ConsentObserveRequest[] = [];
    const fx = await makeDriver({
      transcript: userLine('zbuduj'),
      screen: DIALOG_PERMISSION,
      deps: { consentMode: () => 'main', consentObserve: async (request) => { requests.push(request); } },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.driver.noteConsentNudge?.(WAITING_PERMISSION);
    await waitFor(() => requests.length === 1, 'obserwacja ze szturchnięcia');
    expect(requests[0]).toMatchObject({ engineSessionId: SESSION, registry: { kind: 'waiting', dialog: 'permission' } });
    expect(requests[0]?.screen).not.toBeNull();
  });

  it('szturchnięcie w trakcie obserwacji: zaraz po niej idzie jeszcze jedna (zrzut prośby mógł dojść po odczycie)',
    async () => {
      const requests: ConsentObserveRequest[] = [];
      const releases: (() => void)[] = [];
      const fx = await makeDriver({
        transcript: userLine('zbuduj'),
        screen: DIALOG_PERMISSION,
        deps: {
          consentMode: () => 'main',
          consentObserve: (request) => {
            requests.push(request);
            return new Promise<void>((resolve) => { releases.push(resolve); });
          },
        },
      });
      await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
      fx.driver.noteCliWaiting?.(WAITING_PERMISSION);
      await waitFor(() => requests.length === 1, 'obserwacja z taktu');
      fx.driver.noteConsentNudge?.(WAITING_PERMISSION);
      await quiet();
      expect(requests).toHaveLength(1);
      releases[0]?.();
      await waitFor(() => requests.length === 2, 'obserwacja po szturchnięciu');
      releases[1]?.();
      await quiet();
      expect(requests).toHaveLength(2);
    });

  it('szturchnięcie bez `waiting: permission`: bez obserwacji i bez odczytu ekranu', async () => {
    const requests: ConsentObserveRequest[] = [];
    const fx = await makeDriver({
      transcript: userLine('zbuduj'),
      screen: DIALOG_PERMISSION,
      deps: { consentMode: () => 'main', consentObserve: async (request) => { requests.push(request); } },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    const reads = fx.client.calls.filter((call) => call.method === 'read').length;
    for (const signal of [ACTIVE, UNKNOWN, WAITING_INPUT]) fx.driver.noteConsentNudge?.(signal);
    await quiet();
    expect(requests).toEqual([]);
    expect(fx.client.calls.filter((call) => call.method === 'read')).toHaveLength(reads);
  });

  /** Zgoda `Bash` z jsonl przy `main`, z rejestracją hooka sesji bez karty kanału (`awaited`) i zegarem ściany. */
  async function awaitedCard(opts: {
    awaited: () => number | null; live?: () => boolean; waitMs: number;
  }): Promise<Fixture> {
    const fx = await makeDriver({
      transcript: userLine('zbuduj') + toolUseLine('toolu_bash', 'Bash', BASH_INPUT),
      screen: DIALOG_PERMISSION,
      deps: {
        now: () => Date.now(),
        consentMode: () => 'main',
        consentCardLive: opts.live ?? (() => false),
        consentCardAwaited: (engine) => (engine === SESSION ? opts.awaited() : null),
        consentCardWaitMs: opts.waitMs,
      },
    });
    await waitFor(() => fx.events.some((e) => e.type === 'history'), 'historia');
    fx.driver.noteCliWaiting?.(WAITING_PERMISSION);
    fx.emit({ type: 'status', status: 'blocked', stateChangeSeq: 8, title: '' });
    await waitFor(() => fx.events.some((e) => e.type === 'agent-state' && e.state === 'blocked'), 'blokada');
    return fx;
  }

  it('uwaga poboczna: rejestracja hooka bez karty kanału — karta zgody z jsonl czeka do sufitu, potem idzie sama',
    async () => {
      const registeredAt = Date.now();
      const fx = await awaitedCard({ awaited: () => registeredAt, waitMs: 400 });
      // Debounce oceny w tym pliku to 10 ms: bez czekania karta „tylko Odrzuć” stałaby już na telefonie.
      await sleep(150);
      expect(permissions(fx.events)).toEqual([]);
      await waitFor(() => permissions(fx.events).length > 0, 'karta po suficie');
      expect(Date.now() - registeredAt).toBeGreaterThanOrEqual(390);
      expect(permissions(fx.events)).toHaveLength(1);
      expect(permissions(fx.events)[0]?.canAllow).toBe(false);
      expect(digitsSent(fx)).toEqual([]);
    });

  it('karta kanału przychodzi w trakcie czekania: karta z jsonl nie wychodzi wcale, także po suficie', async () => {
    let live = false;
    const registeredAt = Date.now();
    const fx = await awaitedCard({ awaited: () => (live ? null : registeredAt), live: () => live, waitMs: 300 });
    await sleep(100);
    live = true;
    await sleep(450);
    expect(permissions(fx.events)).toEqual([]);
    expect(digitsSent(fx)).toEqual([]);
  });

  it('bez rejestracji, z rejestracją starszą niż sufit albo gdy port rzuca: karta zgody idzie od razu', async () => {
    const cases: (() => number | null)[] = [
      () => null,
      () => Date.now() - 10_000,
      () => { throw new Error('rejestr'); },
    ];
    for (const awaited of cases) {
      const fx = await awaitedCard({ awaited, waitMs: 5_000 });
      await waitFor(() => permissions(fx.events).length > 0, 'karta od razu');
      expect(permissions(fx.events)[0]?.canAllow).toBe(false);
      fx.driver.dispose();
    }
  });
});
