/**
 * Integracja OFFLINE: manager × PRAWDZIWY driver herdr × prawdziwy strażnik,
 * uploady, dziennik i tożsamość. Atrapą jest wyłącznie to, co dotyka gniazda (`HerdrClient`)
 * i sam nadzorca (jego wnętrze ma własny plik testów).
 *
 * Po co osobny plik, skoro `manager-herdr.test.ts` i `herdr-driver.test.ts` już są:
 * tamte dwa pilnują swoich modułów na atrapach sąsiada, a najdroższe błędy tej integracji
 * mieszkają dokładnie NA STYKU — w kolejności „guard → throttle → uploady → echo lokalne →
 * `prompt`" i w tym, że echo z jsonl ma zgasnąć po drodze. Ten plik składa te elementy tak,
 * jak robi to `server/src/index.ts`, i sprawdza trzy zdania, których złamanie widać w CUDZYM
 * terminalu, a nie w teście jednostkowym:
 *
 *   (a) sprzątanie Raroga nie wysyła do paneli ANI JEDNEGO bajtu,
 *   (b) podyktowane zdanie jest w transkrypcie DOKŁADNIE RAZ (lokalne echo + `dropEcho`),
 *   (c) awaria herdr nie zmienia stanu żadnej sesji.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { foreign } from '@rarog/shared/sentences';
import { readFileSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HerdrStatus, ServerEvent, TranscriptMessage } from '@rarog/shared';
import { type CompanionTurnsReader, createCompanionTurns } from '../src/companion/turns.ts';
import { locateTranscript } from '../src/herdr/transcript-path.ts';
import {
  agentLine, blockedLine, localCommandLines, noticeLine, turnLines, userLine as fileUserLine,
} from './helpers/plik-rozmowy.ts';
import { createManager } from '../src/sessions/manager.ts';
import { managerErrorStatus } from '../src/router.ts';
import type { Manager } from '../src/sessions/manager.ts';
import { AsyncEventQueue } from '../src/drivers/runtime.ts';
import type { SessionDriver } from '../src/drivers/types.ts';
import { createHerdrDriver } from '../src/drivers/herdr-driver.ts';
import type { HerdrDriverDeps } from '../src/drivers/herdr-driver.ts';
import { createJsonlFollower } from '../src/herdr/jsonl-follow.ts';
import { createUploads } from '../src/herdr/uploads.ts';
import { createHerdrAuditLog, herdrAuditPath } from '../src/herdr/audit.ts';
import { assertSendable, createSendThrottle } from '../src/herdr/commands/guard.ts';
import { createCommandCatalogs } from '../src/herdr/commands/catalog.ts';
import type { CommandCatalog } from '../src/herdr/commands/catalog.ts';
import { createHiddenStore, sessionIdFor } from '../src/herdr/identity.ts';
import type {
  HerdrAgent, HerdrAgentHandle, HerdrClient, HerdrLifecycleEvent, HerdrPaneEvent, HerdrScreen,
  HerdrSupervisor,
} from '../src/herdr/types.ts';
import { projectSlug } from '../src/cli-store.ts';

const PANE = 'w9:p72';
const SESSION = '7d2dd80f-012c-5c17-b97d-cf436a305158';
const TIMING = {
  batchMs: 10, statTickMs: 8, missingFastMs: 8, missingWindowMs: 200, missingSlowMs: 16,
};

// ---------------------------------------------------------------------------
// Atrapa gniazda
// ---------------------------------------------------------------------------

/** Wszystko, co poszłoby do cudzego panelu, ląduje w `calls`. Nic tu nie rusza terminala. */
class FakeClient implements HerdrClient {
  readonly calls: { method: string; text?: string; keys?: readonly string[]; wait?: boolean }[] = [];

  get mutations(): number {
    return this.calls
      .filter((c) => c.method === 'prompt' || c.method === 'send_keys' || c.method === 'dialog_key'
        || c.method === 'take_back_key').length;
  }

  listAgents(): Promise<never> { return Promise.reject(new Error('nieużywane')); }
  getAgent(): Promise<never> { return Promise.reject(new Error('nieużywane')); }

  /** What the pane shows to every read. */
  screenText = 'Do you want to proceed?\n1. Yes\n2. No';

  readScreen(): Promise<HerdrScreen> {
    this.calls.push({ method: 'read' });
    return Promise.resolve({ text: this.screenText });
  }
  /** Historia panelu — te testy jej nie czytają; pusta = brak wstępu dialogu. */
  readPaneHistory(): Promise<{ text: string; truncated: boolean }> {
    return Promise.resolve({ text: '', truncated: false });
  }

  prompt(_paneId: string, text: string, wait?: boolean): Promise<void> {
    // `wait` mówi, czy driver wybrał stall-guard (zwykły prompt) czy ścieżkę komendy.
    this.calls.push(wait === undefined ? { method: 'prompt', text } : { method: 'prompt', text, wait });
    return Promise.resolve();
  }

  sendFormSubmit(_paneId: string): Promise<void> {
    this.calls.push({ method: 'form_submit', keys: ['enter'] });
    return Promise.resolve();
  }

  sendModeCycle(_paneId: string): Promise<void> {
    this.calls.push({ method: 'send_keys', keys: ['shift+tab'] });
    return Promise.resolve();
  }

  /** Wklejenie w trakcie tury liczy się jak `prompt`: tekst idzie do panelu. */
  pasteText(_paneId: string, text: string): Promise<void> {
    this.calls.push({ method: 'prompt', text });
    return Promise.resolve();
  }

  sendPromptSubmit(_paneId: string): Promise<void> {
    this.calls.push({ method: 'send_keys', keys: ['enter'] });
    return Promise.resolve();
  }

  sendTrustStep(_paneId: string, key: string): Promise<void> {
    this.calls.push({ method: 'send_keys', keys: [key] });
    return Promise.resolve();
  }
  sendDialogKey(_paneId: string, key: string): Promise<void> {
    this.calls.push({ method: 'dialog_key', keys: [key] });
    return Promise.resolve();
  }
  sendTakeBackKey(_paneId: string, key: string): Promise<void> {
    this.calls.push({ method: 'take_back_key', keys: [key] });
    return Promise.resolve();
  }

  sendKeys(_paneId: string, keys: readonly string[]): Promise<void> {
    this.calls.push({ method: 'send_keys', keys });
    return Promise.resolve();
  }

  focus(): Promise<void> { return Promise.resolve(); }
  ping(): Promise<{ version: string; protocol: number }> {
    return Promise.resolve({ version: '0.8.2', protocol: 20 });
  }
}

// ---------------------------------------------------------------------------

const flush = async (rounds = 4): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
};

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
};

const quiet = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 80));

const userLine = (text: string): string => `${JSON.stringify({
  type: 'user',
  message: { role: 'user', content: text },
  isSidechain: false,
  timestamp: '2026-08-22T10:00:00.000Z',
  sessionId: SESSION,
})}\n`;

describe('manager × prawdziwy driver herdr', () => {
  let base = '';
  let dataDir = '';
  let storeRoot = '';
  let cwd = '';
  let transcript = '';
  let client: FakeClient;
  let manager: Manager | null = null;
  let lifecycle: AsyncEventQueue<HerdrLifecycleEvent>;
  let listeners: Set<(ev: HerdrPaneEvent) => void>;
  let now = Date.UTC(2026, 7, 22, 12, 0, 0);
  /** Extra driver dependencies of one test, and the driver the supervisor attached. */
  let driverDeps: Partial<HerdrDriverDeps> = {};
  let attached: SessionDriver | null = null;

  /** Nadzorca-atrapa, która oddaje PRAWDZIWEGO drivera — dokładnie jak `index.ts`. */
  function makeSupervisor(agent: HerdrAgent): HerdrSupervisor {
    const audit = createHerdrAuditLog({ dataDir });
    return {
      events: lifecycle,
      status: (): HerdrStatus => ({
        available: true, agentCount: 1, readOnly: false, canLaunch: false,
      }),
      attach: (): SessionDriver => {
        const handle: HerdrAgentHandle = {
          agent,
          subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        };
        attached = createHerdrDriver(handle, {
          client,
          audit: { log: (entry) => { audit.log({ ...entry, sessionId: sessionIdFor(agent.key) }); } },
          guard: assertSendable,
          yoloRoots: [],
          now: () => now,
          sessionId: sessionIdFor(agent.key),
          follow: (o) => createJsonlFollower({ ...o, root: storeRoot, watch: false, timing: TIMING }),
          ...driverDeps,
        });
        return attached;
      },
      // Karencja `idle` po wysyłce należy do nadzorcy — tu wystarczy, że driver ma co wołać.
      markSent: () => { /* stan karencji testujemy w `herdr-supervisor.test.ts` */ },
      // Wpis odmowy komendy tym samym dziennikiem; kształt wpisu pilnuje `herdr-supervisor.test.ts`.
      logCommandRefusal: (key, dir, command) => {
        audit.log({
          key: key ?? '', paneId: agent.paneId, cwd: dir, method: 'refuse', reason: 'command-not-allowed',
          mode: agent.mode, command,
        });
      },
      // Tryb panelu w tym teście jest znany i stały: bramkę świeżości ma własny plik testów.
      ensureFreshMode: () => Promise.resolve(agent.mode),
      focus: () => Promise.resolve(),
      // Kanał TWORZENIA ma własny plik testów; tutaj sprawdzamy warstwę TREŚCI.
      launch: () => Promise.reject(new Error('launch: nieużywane w tym teście')),
      closeTab: () => Promise.reject(new Error('closeTab: nieużywane w tym teście')),
      rarogPaneCount: () => 0,
      liveEngineSessions: () => Promise.resolve(new Set([agent.agentSessionId])),
      dispose: () => { lifecycle.close(); },
    };
  }

  async function build(
    agent: HerdrAgent, commandCatalog?: (cwd: string, cliVersion: string | null) => CommandCatalog,
  ): Promise<{ manager: Manager; id: string }> {
    const uploads = createUploads();
    const throttle = createSendThrottle({ now: () => now });
    const hidden = await createHiddenStore({ dataDir });
    const supervisor = makeSupervisor(agent);
    const built = await createManager({
      demo: false,
      dataDir,
      projects: [{ path: cwd, name: 'atlas' }],
      projectRoots: [],
      gitStatus: null,
      herdrSupervisor: supervisor,
      herdrRoots: [cwd],
      herdrSend: true,
      herdrDeps: {
        sessionIdFor,
        aliasFor: (engine) => hidden.aliasFor(engine),
        rememberAlias: (engine, id) => { void hidden.rememberAlias(engine, id); },
        assertSendable,
        ...(commandCatalog === undefined ? {} : { commandCatalog }),
        takeSendSlot: (key, opts) => throttle.takeSendSlot(key, opts),
        writeUploads: (dir, images) => uploads.write(dir, images),
        writeUploadFiles: (dir, files) => uploads.writeFiles(dir, files),
        sweepUploads: (roots) => uploads.sweepAll(roots),
      },
    });
    manager = built;
    await built.ready;
    lifecycle.push({ type: 'appeared', agent });
    await flush();
    const id = built.list().find((s) => s.paneId !== undefined)?.id ?? '';
    expect(id).not.toBe('');
    return { manager: built, id };
  }

  function makeAgent(): HerdrAgent {
    return {
      key: PANE, paneId: PANE, agentSessionId: SESSION, cwd, status: 'idle',
      title: 's3-back', stateChangeSeq: 1, mode: 'auto', modeReadAt: 0, inScope: true,
      engine: 'claude', termId: null,
      tabId: 'w9:t3', launchedByRarog: false, interactiveReady: true,
    };
  }

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'rarog-herdr-int-'));
    dataDir = join(base, 'data');
    storeRoot = join(base, 'store');
    cwd = join(base, 'projekt');
    await mkdir(dataDir, { recursive: true });
    await mkdir(cwd, { recursive: true });
    const storeDir = join(storeRoot, projectSlug(cwd));
    await mkdir(storeDir, { recursive: true });
    transcript = join(storeDir, `${SESSION}.jsonl`);
    await writeFile(transcript, userLine('stary wpis'));
    client = new FakeClient();
    lifecycle = new AsyncEventQueue<HerdrLifecycleEvent>();
    listeners = new Set();
    now = Date.UTC(2026, 7, 22, 12, 0, 0);
    driverDeps = {};
    attached = null;
  });

  afterEach(async () => {
    if (manager !== null) await manager.dispose();
    manager = null;
    await rm(base, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------

  it('(b) podyktowane zdanie jest w transkrypcie DOKŁADNIE RAZ', async () => {
    /*
     * Dwie ścieżki dopisują tę samą wiadomość: manager (lokalne echo, jedyne, które gasi
     * optymistyczny „wpis w locie" w PWA) i silnik przez plik jsonl. Bez `dropEcho`
     * w followerze użytkownik widzi swoje zdanie dwa razy, ~100 ms po wysłaniu.
     */
    const { manager: mgr, id } = await build(makeAgent());
    const events: ServerEvent[] = [];
    mgr.onEvent((_scope, _seq, event) => { events.push(event); });
    // Porcja historii wchodzi asynchronicznie — bez odczekania na nią liczylibyśmy do
    // „ile razy widać moje zdanie" także wiadomości sprzed podpięcia.
    await waitFor(() => events.some((e) => e.type === 'message'), 'porcja historii');
    events.splice(0);

    await mgr.sendMessage(id, 'zrób refaktor');
    await waitFor(() => client.calls.some((c) => c.method === 'prompt'), 'prompt do panelu');
    // Silnik zapisuje echo do jsonl chwilę po wysyłce.
    await appendFile(transcript, userLine('zrób refaktor'));
    await quiet();

    const userTexts = events
      .filter((e): e is Extract<ServerEvent, { type: 'message' }> => e.type === 'message')
      .filter((e) => e.message.role === 'user')
      .flatMap((e) => e.message.blocks.map((b) => (b.type === 'text' ? b.text : '')));
    expect(userTexts).toEqual(['zrób refaktor']);
  });

  it('(b2) świeży panel bez pliku transkryptu też pokazuje zdanie RAZ', async () => {
    /*
     * Regresja znaleziona NA ŻYWO.
     *
     * Panel ze świeżo uruchomionym `claude` (albo po `/clear`) nie ma jeszcze pliku jsonl.
     * Tworzy go dopiero PIERWSZY prompt — czyli ten wysłany z Raroga. Follower widzi wtedy
     * cały plik jako HISTORIĘ, a nie jako tail, więc filtr echa stojący wyłącznie na tailu
     * przepuściłby własne zdanie użytkownika drugi raz.
     */
    await rm(transcript, { force: true });
    const { manager: mgr, id } = await build(makeAgent());
    const events: ServerEvent[] = [];
    mgr.onEvent((_scope, _seq, event) => { events.push(event); });

    await mgr.sendMessage(id, 'ile jest 2+2');
    await waitFor(() => client.calls.some((c) => c.method === 'prompt'), 'prompt do panelu');
    // Silnik zakłada plik i zapisuje do niego prompt — dokładnie tak jak w terminalu.
    await writeFile(transcript, userLine('ile jest 2+2'));
    await quiet();

    const userTexts = events
      .filter((e): e is Extract<ServerEvent, { type: 'message' }> => e.type === 'message')
      .filter((e) => e.message.role === 'user')
      .flatMap((e) => e.message.blocks.map((b) => (b.type === 'text' ? b.text : '')));
    expect(userTexts).toEqual(['ile jest 2+2']);
  });

  it('(a) dispose() managera nie wysyła do panelu ANI JEDNEGO wywołania', async () => {
    const { manager: mgr, id } = await build(makeAgent());
    await mgr.sendMessage(id, 'popraw testy');
    await waitFor(() => client.calls.some((c) => c.method === 'prompt'), 'prompt');
    const before = client.mutations;

    await mgr.dispose();
    manager = null;
    await quiet();

    expect(client.mutations).toBe(before);
  });

  it('(c) unavailable wygasza karty, ale nie rusza stanu żadnej sesji', async () => {
    const { manager: mgr, id } = await build(makeAgent());
    const before = mgr.get(id)?.state;

    lifecycle.push({ type: 'unavailable', reason: foreign('socket padł') });
    await flush();

    expect(mgr.get(id)?.stale).toBe(true);
    expect(mgr.get(id)?.state).toBe(before);
    expect(client.mutations).toBe(0);
  });

  it('allow-lista działa na PEŁNEJ ścieżce: 400 i zero bajtów do panelu', async () => {
    const { manager: mgr, id } = await build(makeAgent());
    await expect(mgr.sendMessage(id, '/hooks add')).rejects.toThrow(/hooks/i);
    await expect(mgr.sendMessage(id, '!rm -rf /')).rejects.toThrow(/!/);
    expect(client.mutations).toBe(0);
  });

  describe('allow-lista komend — manager × driver na jednej migawce katalogu', () => {
    /** Katalog domowy testu ze skillem użytkownika; prawdziwego `~/.claude` test nie czyta. */
    async function catalogs(): Promise<(dir: string, cli: string | null) => CommandCatalog> {
      const home = join(base, 'home');
      await mkdir(join(home, '.claude', 'skills', 'handoff'), { recursive: true });
      await writeFile(join(home, '.claude', 'skills', 'handoff', 'SKILL.md'), '---\ndescription: x\n---\n');
      const factory = createCommandCatalogs({ home, roots: [cwd] });
      return (dir, cli) => factory.get(dir, cli);
    }
    const prompts = (): typeof client.calls => client.calls.filter((c) => c.method === 'prompt');

    it('skill z katalogu przechodzi managera I drivera i jedzie bez stall-guarda', async () => {
      const { manager: mgr, id } = await build(makeAgent(), await catalogs());
      await mgr.sendMessage(id, '/handoff dalej');
      await waitFor(() => prompts().length === 1, 'prompt do panelu');
      expect(prompts()[0]).toEqual({ method: 'prompt', text: '/handoff dalej' });
      // Dziennik pisze w tle — bez ciszy sprzątanie katalogu danych ściga się z zapisem.
      await quiet();
    });

    it('wbudowana komenda z listy też, a zwykły prompt i `/tmp x` jadą stall-guardem (`wait`)', async () => {
      const { manager: mgr, id } = await build(makeAgent(), await catalogs());
      await mgr.sendMessage(id, '/compact');
      await waitFor(() => prompts().length === 1, 'komenda');
      now += 10_000;
      await mgr.sendMessage(id, '/tmp przeczytaj log');
      await waitFor(() => prompts().length === 2, 'ścieżka');
      expect(prompts().map((c) => [c.text, c.wait])).toEqual([
        ['/compact', undefined], ['/tmp przeczytaj log', true],
      ]);
      await quiet();
    });

    it('two prompts in the same second both reach the pane, in order, through the real throttle', async () => {
      const { manager: mgr, id } = await build(makeAgent(), await catalogs());
      await mgr.sendMessage(id, '/compact');
      await mgr.sendMessage(id, '/handoff dalej');
      await waitFor(() => prompts().length === 2, 'both prompts');
      expect(prompts().map((c) => c.text)).toEqual(['/compact', '/handoff dalej']);
      await quiet();
    });

    it('odmowa nie dochodzi do drivera: 400 z podpowiedzią, zero bajtów, `refuse` bez treści w dzienniku', async () => {
      const { manager: mgr, id } = await build(makeAgent(), await catalogs());
      await expect(mgr.sendMessage(id, '/usa sekretne-zdanie')).rejects.toThrow(/\/usa.*\/usage/);
      await expect(mgr.sendMessage(id, '/new')).rejects.toThrow(/Type \/clear instead/);
      await expect(mgr.sendMessage(id, 'quit')).rejects.toThrow(/End the session/);
      await quiet();
      expect(client.mutations).toBe(0);
      const log = await readFile(herdrAuditPath(dataDir), 'utf8');
      const refusals = log.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => entry['method'] === 'refuse');
      expect(refusals.map((entry) => [entry['reason'], entry['command']])).toEqual([
        ['command-not-allowed', '/usa'], ['command-not-allowed', '/new'], ['command-not-allowed', 'quit'],
      ]);
      expect(log).not.toContain('sekretne-zdanie');
    });
  });

  it('dziennik notuje wysyłkę, ale NIE zapisuje pełnej treści', async () => {
    const secret = `zapamiętaj ten token ${'x'.repeat(400)} KONIEC`;
    const { manager: mgr, id } = await build(makeAgent());
    await mgr.sendMessage(id, secret);
    await waitFor(() => client.calls.some((c) => c.method === 'prompt'), 'prompt');
    await quiet();

    const log = await readFile(herdrAuditPath(dataDir), 'utf8');
    expect(log).toContain('"method":"prompt"');
    expect(log).toContain(`"sessionId":"${sessionIdFor(PANE)}"`);
    expect(log).not.toContain('KONIEC');
  });

  it('odrzucenie dialogu idzie pełną ścieżką jako dokładnie jeden `escape`', async () => {
    const { manager: mgr, id } = await build(makeAgent());
    for (const listener of listeners) {
      listener({ type: 'status', status: 'blocked', stateChangeSeq: 5, title: 's3-back' });
    }
    await waitFor(() => mgr.get(id)?.state === 'waiting-permission', 'blokada');
    // Dialog stojący w terminalu nie ma `permId` — sesja herdr ma PUSTĄ listę pending.
    expect(mgr.transcript(id).pendingPermissions).toEqual([]);

    await expect(mgr.resolvePermission(id, id, 'deny', 'iPhone'))
      .resolves.toEqual({ outcome: 'ok' });
    await quiet();
    expect(client.calls.filter((c) => c.method === 'send_keys').map((c) => c.keys))
      .toEqual([['escape']]);
  });

  /** A pane blocked on the effort picker with its layer 2 card standing (`docs/dialog-card.md`, "Answer"). */
  async function layer2Pane(): Promise<{ mgr: Manager; id: string; layer2: () => string[] }> {
    const raw = readFileSync(join(import.meta.dirname, 'fixtures/herdr/kontrolny/picker-effort-2.1.322.txt'), 'utf8');
    const mark = '\n--- ekran ---\n';
    client.screenText = raw.includes(mark) ? raw.slice(raw.indexOf(mark) + mark.length) : raw;
    driverDeps = {
      // The card stands after the debounce twice, one retry and the 800 ms between its two screen reads: with the
      // default debounce and retry that is 2.9 s, at the deadline of `waitFor`.
      dialogLayer2: true, screenCacheMs: 0, pendingDebounceMs: 10, pendingRetryMs: 4,
      consentRegistryRead: () => Promise.resolve({ kind: 'waiting', dialog: 'dialog' }),
    };
    const { manager: mgr, id } = await build(makeAgent());
    attached?.noteCliWaiting?.({ kind: 'waiting', dialog: 'dialog' });
    for (const listener of listeners) {
      listener({ type: 'status', status: 'blocked', stateChangeSeq: 5, title: 's3-back' });
    }
    const layer2 = (): string[] => mgr.transcript(id).pendingQuestions.map((q) => q.qId).filter((q) => q.startsWith('l2:'));
    await waitFor(() => layer2().length === 1, 'layer 2 card');
    return { mgr, id, layer2 };
  }

  it('layer 2 card: an old id is 410, allow 409, two taps at once one key and 422, a late tap 409', async () => {
    const { mgr, id, layer2 } = await layer2Pane();
    const [card = ''] = layer2();

    await expect(mgr.answerQuestion(id, 'l2:0123456789ab', [['→ to adjust']])).resolves.toEqual({ outcome: 'gone' });
    const allow = await mgr.resolvePermission(id, id, 'allow', 'iPhone').then(() => null, (err: unknown) => err);
    expect(managerErrorStatus(allow)).toBe(409);
    await quiet();
    expect(client.mutations).toBe(0);
    expect(layer2()).toEqual([card]);

    const taps = await Promise.all([
      mgr.answerQuestion(id, card, [['→ to adjust']]), mgr.answerQuestion(id, card, [['→ to adjust']]),
    ]);
    expect(taps).toEqual([{ outcome: 'ok' }, { outcome: 'refused', reason: 'in-flight' }]);
    await expect(mgr.answerQuestion(id, card, [['→ to adjust']])).resolves.toEqual({ outcome: 'conflict' });
    await quiet();
    expect(client.calls.filter((c) => c.method !== 'read')).toEqual([{ method: 'dialog_key', keys: ['right'] }]);
  });

  it('deny addressed by the session over a layer 2 card: one `escape` after the layer 2 step', async () => {
    const { mgr, id } = await layer2Pane();
    await expect(mgr.resolvePermission(id, id, 'deny', 'iPhone')).resolves.toEqual({ outcome: 'ok' });
    await quiet();
    expect(client.calls.filter((c) => c.method !== 'read')).toEqual([{ method: 'send_keys', keys: ['escape'] }]);
  });

  it.each(['deny', 'label'] as const)(
    'layer 2 card: after the key of a %s the question leaves the manager with `question-resolved`, no herdr status',
    async (how) => {
      const { mgr, id, layer2 } = await layer2Pane();
      const [card = ''] = layer2();
      const resolved: string[] = [];
      mgr.onEvent((_scope, _seq, event) => { if (event.type === 'question-resolved') resolved.push(event.qId); });
      const result = how === 'deny'
        ? await mgr.resolvePermission(id, id, 'deny', 'iPhone')
        : await mgr.answerQuestion(id, card, [['→ to adjust']]);
      expect(result).toEqual({ outcome: 'ok' });
      await waitFor(() => layer2().length === 0, 'question settled');
      expect(resolved).toEqual([card]);
      expect(mgr.transcript(id).pendingQuestions).toEqual([]);
      // The verify read writes its audit line after the key; the test ends after it, not during the cleanup.
      const verified = (): boolean => {
        try {
          return readFileSync(herdrAuditPath(dataDir), 'utf8').includes('"method":"layer2-verify"');
        } catch {
          return false;
        }
      };
      await waitFor(verified, 'verify read');
    },
  );

  /*
   * The voice agent's turns route reads the file of the conversation the card writes now: the same messages as the
   * session's history on the way to the phone, and nothing from before `/clear`, whatever the server's memory holds.
   */
  describe('voice agent turns × the real history path', () => {
    const NEW = '8e3f1c2a-1111-4c5d-9e6f-0a1b2c3d4e5f';
    const reader = (): CompanionTurnsReader => createCompanionTurns({
      locate: (dir, conversation) => locateTranscript(storeRoot, dir, conversation), promptBlock: true,
    });
    const turnsOf = async (mgr: Manager, id: string, count = 3) => {
      const target = mgr.companionTarget(id);
      if (target === null) throw new Error('session out of scope');
      return reader().read({ ...target, stateSince: mgr.get(id)?.stateSince ?? '' }, count);
    };
    const texts = (ms: readonly { blocks: readonly { type: string; text?: string }[] }[]): string[] =>
      ms.map((m) => m.blocks.map((b) => b.text ?? '').join(''));
    const paneEvent = (ev: HerdrPaneEvent): void => { for (const listener of listeners) listener(ev); };
    const historyIn = async (mgr: Manager, id: string, text: string): Promise<void> => {
      await waitFor(() => texts(mgr.transcript(id).messages).includes(text), `history with ${text}`);
    };

    it('the same file gives the same messages through the route and through the session history', async () => {
      const big = 'y'.repeat(300 * 1024);
      const untimed = `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'untimed' }] } })}\n`;
      await writeFile(transcript, turnLines(1) + noticeLine('Background command finished', 2) + blockedLine('rm it', 3)
        + localCommandLines('cost', 'Total cost: 0.01', 4) + fileUserLine('prompt 2', 5) + agentLine(big, 5) + untimed
        + turnLines(3, 6));
      const { manager: mgr, id } = await build(makeAgent());
      await historyIn(mgr, id, 'answer 3');
      const phone = mgr.transcript(id).messages;
      const route = await turnsOf(mgr, id);
      expect(route.complete).toBe(true);
      // `seq` numbers each side on its own; an entry without `timestamp` gets the reader's clock on each side.
      const comparable = (ms: readonly TranscriptMessage[]) => ms.map(({ seq: _seq, ...m }) => (
        texts([m]).join('') === 'untimed' ? { ...m, at: 'no time' } : m));
      const from = texts(phone).indexOf('prompt 1');
      expect(from).toBeGreaterThanOrEqual(0);
      expect(comparable(route.messages)).toEqual(comparable(phone.slice(from)));
      expect(route.messages.some((m) => m.promptBlocked !== undefined)).toBe(true);
      expect(route.messages.some((m) => m.notice !== undefined)).toBe(true);
    });

    it('a re-attached pane appends history again, the route has no repeats', async () => {
      await writeFile(transcript, turnLines(1) + turnLines(2));
      const agent = makeAgent();
      const { manager: mgr, id } = await build(agent);
      await historyIn(mgr, id, 'answer 2');
      const before = await turnsOf(mgr, id);
      lifecycle.push({ type: 're-attached', agent });
      await waitFor(() => texts(mgr.transcript(id).messages).filter((t) => t === 'answer 2').length === 2, 'second history');
      const after = await turnsOf(mgr, id);
      expect(texts(after.messages)).toEqual(['prompt 1', 'answer 1', 'prompt 2', 'answer 2']);
      expect(after.messages).toEqual(before.messages);
    });

    it('/clear without a new prompt gives an empty list and another conversation', async () => {
      await writeFile(transcript, turnLines(1) + turnLines(2));
      const { manager: mgr, id } = await build(makeAgent());
      await historyIn(mgr, id, 'answer 2');
      const before = await turnsOf(mgr, id);
      paneEvent({ type: 'session-changed', agentSessionId: NEW });
      await waitFor(() => mgr.companionTarget(id)?.agentSessionId === NEW, 'new conversation on the card');
      const after = await turnsOf(mgr, id);
      expect(after.messages).toEqual([]);
      expect(after.conversation).not.toBe(before.conversation);
    });

    it('/clear, then two turns: count=3 gives the two, nothing from before', async () => {
      await writeFile(transcript, turnLines(1) + turnLines(2));
      const { manager: mgr, id } = await build(makeAgent());
      await historyIn(mgr, id, 'answer 2');
      const fresh = join(storeRoot, projectSlug(cwd), `${NEW}.jsonl`);
      await writeFile(fresh, localCommandLines('clear', ''));
      paneEvent({ type: 'session-changed', agentSessionId: NEW });
      await waitFor(() => mgr.companionTarget(id)?.agentSessionId === NEW, 'new conversation on the card');
      await appendFile(fresh, turnLines(7) + turnLines(8));
      expect(texts((await turnsOf(mgr, id)).messages)).toEqual(['prompt 7', 'answer 7', 'prompt 8', 'answer 8']);
    });

    it('/clear with an immediate prompt (the resume sentence) gives nothing from before', async () => {
      await writeFile(transcript, turnLines(1) + turnLines(2));
      const { manager: mgr, id } = await build(makeAgent());
      await historyIn(mgr, id, 'answer 2');
      const before = await turnsOf(mgr, id);
      // The new file already holds a prompt when the pane reports it, so the follower reads it as `/resume`.
      await writeFile(join(storeRoot, projectSlug(cwd), `${NEW}.jsonl`), localCommandLines('clear', '') + turnLines(9));
      paneEvent({ type: 'session-changed', agentSessionId: NEW });
      const resumed = (): boolean => mgr.transcript(id).messages.some((m) => m.blocks.some((b) => (
        b.type === 'text' && b.ref?.code === 'transcript.repoint-resume')));
      await waitFor(resumed, 'the resume sentence');
      const after = await turnsOf(mgr, id);
      expect(texts(after.messages)).toEqual(['prompt 9', 'answer 9']);
      expect(after.conversation).not.toBe(before.conversation);
    });
  });
});
