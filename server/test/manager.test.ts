/**
 * Testy integracyjne managera — na ATRAPIE NADZORCY herdr (fake timery, zero realnego czekania).
 *
 * Sesja Raroga powstaje dokładnie jedną drogą: `supervisor.launch()` zakłada
 * panel, `supervisor.attach(key)` oddaje drivera. Testy chodzą więc tą samą ścieżką co produkcja
 * — atrapą jest wyłącznie to, co dotyka gniazda herdr. Driverem jest `MockDriver` (te same
 * triggery co w demo: „czerwone", „pytanie", „limit", „błąd") albo `ControlledDriver`, gdy test
 * musi wyreżyserować wyścig zdarzeń.
 *
 * Czego tu NIE MA: rejestru sesji (źródłem prawdy jest `agent.list`), importu historii przy
 * wznowieniu (historię wczytuje sam silnik przez `--resume`) i limitu sesji (sufit dotyczy
 * PANELI Raroga i ma testy w `manager-herdr.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDecipheriv, hkdfSync } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_MODEL_CHOICE, FALLBACK_MODEL_CHOICES, MAX_ANSWER_TEXT_CHARS, MAX_FIRST_PROMPT_LENGTH,
  dataUrlBytes,
} from '@rarog/shared';
import type { HerdrMode, HerdrStatus, ServerEvent, SessionState } from '@rarog/shared';
import { MAX_TURNS_DETAIL } from '../src/sessions/state-machine.ts';
import {
  BadRequestError, BadStateError, MAX_LABEL_LENGTH, NotFoundError, createManager, isKnownModel, labelFromPrompt,
} from '../src/sessions/manager.ts';
import { INTERRUPT_DETAIL } from '../src/sessions/state-sentences.ts';
import type {
  HerdrManagerDeps, Manager, ManagerConfig,
} from '../src/sessions/manager.ts';
import { createMockDriverFactory, demoGitStatus } from '../src/drivers/mock-driver.ts';
import type { DriverEvent, SessionDriver } from '../src/drivers/types.ts';
import type {
  HerdrLaunchHandle, HerdrLaunchRequest,
} from '../src/herdr/types.ts';
import type { NoteInput, NotifierLike } from '../src/notify/index.ts';
import { Notifier, sessionLook } from '../src/notify/index.ts';
import { Presence } from '../src/notify/presence.ts';
import type { PushContent } from '../src/notify/content.ts';
import { apnsAlertRequestE2e } from '../src/notify/apns-payload.ts';
import { PUSH_AAD_PREFIX_V3, PUSH_KEY_INFO_V3, createPushSealer } from '../src/notify/push-crypto.ts';
import { foreign } from '@rarog/shared/sentences';
import { degradedCard, screenQuestionCard } from '../src/herdr/dialogs/cards/build.ts';
import { demoContentPl } from '../src/demo/content/pl.ts';
import { AtrapaDrivera, AtrapaNadzorcy } from './helpers/atrapa-sesji.ts';

const PROJECT = '/Users/demo/Projects/willow';

/** Model raportowany przez drivery testowe w evencie `init` (kontrakt: `init` zawsze go niesie). */
const TEST_MODEL = 'claude-fable-5-1';

/** 1×1 px png — jedyne, co się liczy, to poprawny kształt data URL. */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==';

interface Recorded {
  scope: string;
  seq: number | null;
  event: ServerEvent;
}

// ---------------------------------------------------------------------------
// Atrapy
// ---------------------------------------------------------------------------

/** Driver sterowany z testu — pozwala odtworzyć wyścigi (event po interrupt/close). */
class ControlledDriver extends AtrapaDrivera {
  /**
   * Driver testowy udaje WŁASNY proces, żeby `#detachDriver` wołał `interrupt()`.
   *
   * To jest odwrotność drivera panelowego (`ownsProcess: false`) i celowo: testy wyścigów
   * chcą widzieć przerwanie, a test „sprzątanie nie dotyka cudzych paneli" mieszka w
   * `manager-herdr.test.ts`, gdzie driver jest panelowy. `interrupt()` celowo NIE domyka
   * kolejki — manager musi sam odrzucać eventy po przerwaniu.
   */
  constructor() {
    super('', { ownsProcess: true });
  }
}

/**
 * Nadzorca-atrapa: zakłada „panele" w pamięci i oddaje drivera z fabryki podanej przez test.
 *
 * `launch()` rozstrzyga `ready` NATYCHMIAST — opóźnienie startu agenta ma własne testy
 * (`manager-herdr.test.ts`), a tutaj interesuje nas to, co dzieje się PO gotowości.
 */
class TestSupervisor extends AtrapaNadzorcy<SessionDriver> {
  readonly launches: HerdrLaunchRequest[] = [];
  readonly closedTabs: string[] = [];
  readonly panes = new Map<string, string>();
  /** Fabryka drivera dla świeżo podpiętego panelu; test podmienia ją na `ControlledDriver`. */
  makeDriver: (cwd: string) => SessionDriver;
  mode: HerdrMode = 'auto';

  constructor(makeDriver: (cwd: string) => SessionDriver) {
    super();
    this.makeDriver = makeDriver;
  }

  override status(): HerdrStatus {
    return {
      available: true, agentCount: this.panes.size, readOnly: false, canLaunch: true,
    };
  }

  protected nowyDriver(key: string): SessionDriver {
    return this.makeDriver(this.panes.get(key) ?? PROJECT);
  }

  override ensureFreshMode(): Promise<HerdrMode> {
    return Promise.resolve(this.mode);
  }

  override launch(req: HerdrLaunchRequest): Promise<HerdrLaunchHandle> {
    this.launches.push(req);
    const n = this.launches.length;
    const key = `w0:p${String(n)}`;
    const agentSessionId = `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
    this.panes.set(key, req.cwd);
    const result = {
      key,
      paneId: key,
      tabId: `${key}:tab`,
      agentSessionId,
      createdWorkspace: false,
      argv: ['--session-id', agentSessionId],
      status: 'idle' as const,
      interactiveReady: true,
    };
    return Promise.resolve({
      key,
      paneId: result.paneId,
      tabId: result.tabId,
      agentSessionId,
      ready: Promise.resolve(result),
    });
  }

  override closeTab(key: string): Promise<void> {
    this.closedTabs.push(key);
    this.panes.delete(key);
    return Promise.resolve();
  }

  override rarogPaneCount(): number {
    return this.panes.size;
  }
}

/** Zależności herdr w wersji „nic nie robi poza tym, co test sprawdza". */
function testDeps(): HerdrManagerDeps {
  const aliases = new Map<string, string>();
  return {
    sessionIdFor: (key) => `sesja-${key.replace(/[^a-z0-9]/gi, '-')}`,
    aliasFor: (engine) => aliases.get(engine),
    rememberAlias: (engine, id) => { aliases.set(engine, id); },
    // Guard w tych testach jest przezroczysty: pełne reguły mają `herdr-commands-guard.test.ts`.
    assertSendable: (text) => ({ text, slash: null }),
    takeSendSlot: () => true,
    writeUploads: (cwd, images) => Promise.resolve(images.map((_i, n) => `${cwd}/up-${String(n)}`)),
    writeUploadFiles: (cwd, files) => Promise.resolve(
      files.map((f, n) => `${cwd}/up-${String(n)}-${f.name}`),
    ),
    sweepUploads: () => Promise.resolve(),
  };
}

describe('manager', () => {
  let dataDir: string;
  const managers: Manager[] = [];
  const supervisors: TestSupervisor[] = [];

  beforeEach(async () => {
    vi.useFakeTimers();
    dataDir = await mkdtemp(join(tmpdir(), 'rarog-test-'));
  });

  afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.dispose();
    for (const supervisor of supervisors.splice(0)) supervisor.dispose();
    vi.useRealTimers();
    await rm(dataDir, { recursive: true, force: true });
  });

  /** Manager + nadzorca-atrapa. Domyślny driver to `MockDriver` (triggery ze speca). */
  async function build(overrides: Partial<ManagerConfig> = {}, makeDriver?: (cwd: string) => SessionDriver)
    : Promise<{ manager: Manager; supervisor: TestSupervisor }> {
    const factory = createMockDriverFactory({ content: demoContentPl });
    const supervisor = new TestSupervisor(
      makeDriver ?? ((cwd) => factory.startScenario({ kind: 'idle' }, { cwd })),
    );
    supervisors.push(supervisor);
    const manager = await createManager({
      demo: false,
      dataDir,
      projects: [{ path: PROJECT, name: 'willow' }],
      // Pusta lista korzeni = test nie ogląda się na prawdziwe `~/Projects` tej maszyny.
      projectRoots: [],
      // Poza demo git jest realny — w teście wyłączamy go twardo (żaden spawn).
      gitStatus: null,
      herdrSupervisor: supervisor,
      herdrDeps: testDeps(),
      herdrRoots: [PROJECT],
      herdrSend: true,
      // Throttle zakładania (5 s) jest bezpiecznikiem produkcyjnym, nie regułą testu.
      launchThrottle: { minIntervalMs: 0 },
      ...overrides,
    });
    managers.push(manager);
    await manager.ready;
    return { manager, supervisor };
  }

  /** Manager z driverem sterowanym z testu (wyścigi, spóźnione eventy). */
  async function buildControlled(overrides: Partial<ManagerConfig> = {}): Promise<{
    manager: Manager; supervisor: TestSupervisor; drivers: ControlledDriver[];
  }> {
    const drivers: ControlledDriver[] = [];
    const { manager, supervisor } = await build(overrides, () => {
      const driver = new ControlledDriver();
      drivers.push(driver);
      return driver;
    });
    return { manager, supervisor, drivers };
  }

  /**
   * Zakłada sesję i czeka na domknięcie startu panelu.
   *
   * `create()` oddaje 202 z samym `sessionId` (reszta jedzie po SSE), więc test musi jeszcze
   * przepuścić mikrozadania — dokładnie tak, jak robi to prawdziwy klient czekający na SSE.
   */
  async function newSession(
    manager: Manager, opts: { cwd: string; prompt?: string; permissionMode?: string;
      model?: string; effort?: import('@rarog/shared').EffortLevel },
  ): Promise<{ id: string; state: SessionState }> {
    const created = await manager.create(opts);
    await vi.advanceTimersByTimeAsync(0);
    const session = manager.get(created.sessionId);
    if (session === undefined) throw new Error('sesja nie powstała');
    return { id: session.id, state: session.state };
  }

  function record(manager: Manager): Recorded[] {
    const out: Recorded[] = [];
    manager.onEvent((scope, seq, event) => { out.push({ scope, seq, event }); });
    return out;
  }

  const stateOf = (manager: Manager, id: string): SessionState | undefined =>
    manager.get(id)?.state;

  // -------------------------------------------------------------------------
  // Zdania z kodem na drucie: stan, etykieta, karty
  // -------------------------------------------------------------------------

  describe('zdania z kodem na drucie', () => {
    const RESET = '2026-11-12T10:00:00.000Z';
    const LIMIT_REF = { code: 'state.limit-reached', args: [RESET] };

    it('limit: ten sam token `resetAt=` i ten sam `stateDetailRef` w podsumowaniu, `session-changed` i `state`; po wyjściu oba znikają', async () => {
      const { manager, drivers } = await buildControlled();
      const created = await newSession(manager, { cwd: PROJECT, prompt: 'limit planu' });
      const events = record(manager);
      drivers[0]!.queue.push({ type: 'init', engineSessionId: 'eng-limit', model: TEST_MODEL });
      drivers[0]!.queue.push({ type: 'limit-reached', resetAt: RESET });
      await vi.advanceTimersByTimeAsync(1);

      expect(manager.get(created.id)).toMatchObject({ stateDetail: `resetAt=${RESET}`, stateDetailRef: LIMIT_REF });
      const changed = events.map((r) => r.event).filter((e) => e.type === 'session-changed' && e.session.id === created.id);
      expect(changed.at(-1)).toMatchObject({ session: { stateDetail: `resetAt=${RESET}`, stateDetailRef: LIMIT_REF } });
      const state = events.map((r) => r.event).filter((e) => e.type === 'state' && e.sessionId === created.id);
      expect(state.at(-1)).toMatchObject({ state: 'limit-reached', detail: `resetAt=${RESET}`, detailRef: LIMIT_REF });

      drivers[0]!.queue.push({ type: 'agent-state', state: 'working' });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(manager.get(created.id)?.state).toBe('running');
      const summary = manager.get(created.id);
      expect(summary?.stateDetail).toBeUndefined();
      expect(summary?.stateDetailRef).toBeUndefined();
      const last = events.map((r) => r.event).filter((e) => e.type === 'state' && e.sessionId === created.id).at(-1);
      expect(last).toMatchObject({ state: 'running' });
      expect(last).not.toHaveProperty('detail');
      expect(last).not.toHaveProperty('detailRef');
      const lastChanged = events.map((r) => r.event)
        .filter((e) => e.type === 'session-changed' && e.session.id === created.id).at(-1);
      expect(lastChanged?.type === 'session-changed' ? lastChanged.session : null).not.toHaveProperty('stateDetailRef');
    });

    it('etykieta zapasowa `session N` niesie `labelRef`, etykieta z pierwszego promptu już nie', async () => {
      const { manager } = await buildControlled();
      await newSession(manager, { cwd: PROJECT });
      const second = await newSession(manager, { cwd: PROJECT });
      expect(manager.get(second.id)).toMatchObject({
        label: 'session 2', labelRef: { code: 'session.fallback-label', args: ['2'] },
      });
      await manager.sendMessage(second.id, 'napraw logowanie');
      expect(manager.get(second.id)?.label).not.toBe('session 2');
      expect(manager.get(second.id)).not.toHaveProperty('labelRef');
    });

    it('prompt o treści `session N` dostaje `labelRef` jak numeracja: etykieta niesie tylko tekst', async () => {
      const { manager } = await buildControlled();
      const created = await newSession(manager, { cwd: PROJECT, prompt: 'session 7' });
      expect(manager.get(created.id)).toMatchObject({
        label: 'session 7', labelRef: { code: 'session.fallback-label', args: ['7'] },
      });
    });

    it('karta zdegradowana niesie `displayTextRef`, karta z tekstem agenta nie; ryzyko obu bez zmian', async () => {
      const { manager, drivers } = await buildControlled();
      await newSession(manager, { cwd: PROJECT, prompt: 'dwie karty' });
      const events = record(manager);
      drivers[0]!.queue.push({ type: 'init', engineSessionId: 'eng-cards', model: TEST_MODEL });
      drivers[0]!.queue.push({ ...degradedCard('p-deg', null, 'mismatch').event } as DriverEvent);
      drivers[0]!.queue.push({
        type: 'permission-request', reqId: 'p-agent', toolName: 'Bash',
        input: { command: 'git push --force origin main' }, displayText: 'git push --force origin main',
      });
      await vi.advanceTimersByTimeAsync(1);
      const pending = events.map((r) => r.event).filter((e) => e.type === 'permission-pending');
      const degraded = pending.find((e) => e.type === 'permission-pending' && e.request.permId === 'p-deg');
      const agent = pending.find((e) => e.type === 'permission-pending' && e.request.permId === 'p-agent');
      expect(degraded?.type === 'permission-pending' ? degraded.request : null).toMatchObject({
        displayTextRef: { code: 'dialogs.degraded-display' }, risk: 'red', canAllow: false,
      });
      const agentRequest = agent?.type === 'permission-pending' ? agent.request : null;
      expect(agentRequest).not.toHaveProperty('displayTextRef');
      // Ryzyko z tego samego wejścia co przed polami `*Ref` (pełny input i `displayText`).
      expect(agentRequest?.risk).toBe('red');
    });

    it('pytanie zapasowe karty z ekranu dochodzi do ramki z `questionRef`', async () => {
      const { manager, drivers } = await buildControlled();
      const created = await newSession(manager, { cwd: PROJECT, prompt: 'pytanie bez treści' });
      const events = record(manager);
      const card = screenQuestionCard({
        kind: 'question', header: 'Wybór', question: '', options: [{ label: 'A', digit: '1' }, { label: 'B', digit: '2' }],
        dialogIdentity: { kind: 'none' },
      } as unknown as Parameters<typeof screenQuestionCard>[0], 1);
      drivers[0]!.queue.push({ type: 'init', engineSessionId: 'eng-q', model: TEST_MODEL });
      drivers[0]!.queue.push(card.event);
      await vi.advanceTimersByTimeAsync(1);
      const pending = events.map((r) => r.event).find((e) => e.type === 'question-pending');
      expect(pending?.type === 'question-pending' ? pending.request.questions[0] : null).toMatchObject({
        questionRef: { code: 'dialogs.fallback-question.question' },
      });
      expect(created.id).toBe(pending?.type === 'question-pending' ? pending.request.sessionId : '');
    });
  });

  // -------------------------------------------------------------------------
  // Pełna pętla użytkownika
  // -------------------------------------------------------------------------

  it('create → running → permission-pending → allow → result → waiting-input', async () => {
    const { manager } = await build();
    const events = record(manager);

    const created = await newSession(manager, { cwd: PROJECT, prompt: 'zrób coś czerwone' });
    // Prompt startowy poszedł `driver.send()` PO gotowości panelu — tura właśnie ruszyła.
    expect(created.state).toBe('running');
    expect(manager.get(created.id)?.title).toBe('willow');

    // Po 400 ms mock prosi o zgodę (komenda czerwona wg klasyfikatora).
    await vi.advanceTimersByTimeAsync(500);
    expect(stateOf(manager, created.id)).toBe('waiting-permission');

    const pending = manager.transcript(created.id).pendingPermissions;
    expect(pending).toHaveLength(1);
    const request = pending[0]!;
    expect(request.risk).toBe('red');
    expect(request.cwd).toBe(PROJECT);
    expect(request.displayText).toContain('git push --force');

    // First-wins: pierwsza decyzja 'ok', kolejne 'conflict'.
    await expect(manager.resolvePermission(created.id, request.permId, 'allow', 'iphone'))
      .resolves.toEqual({ outcome: 'ok' });
    await expect(manager.resolvePermission(created.id, request.permId, 'deny', 'ipad'))
      .resolves.toEqual({ outcome: 'conflict' });
    expect(stateOf(manager, created.id)).toBe('running');

    const resolved = events.filter((e) => e.event.type === 'permission-resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.event).toMatchObject({ decision: 'allow', by: 'iphone' });

    // Reszta tury: tool-call, delty, domknięta wiadomość, result.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stateOf(manager, created.id)).toBe('waiting-input');
    expect(manager.get(created.id)?.lastSummary).toBeTruthy();

    const transcript = manager.transcript(created.id);
    expect(transcript.pendingPermissions).toHaveLength(0);
    expect(transcript.messages[0]).toMatchObject({ role: 'user' });
    expect(transcript.messages.some((m) => m.blocks.some((b) => b.type === 'tool-call')))
      .toBe(true);
    expect(events.some((e) => e.event.type === 'delta')).toBe(true);
  });

  it('resolvePermission: „widzę, nie ruszam" blokuje `allow`, a `deny` sprząta kartę', async () => {
    // Bramka jak w #decideHerdrDialog, ale TYLKO dla `allow` — `deny` jest także lokalnym
    // sprzątnięciem karty i przy killswitchu musi przechodzić, inaczej RAROG_HERDR_SEND=0
    // zostawia telefon z kartami nie do zdjęcia do końca awarii.
    const { manager } = await build({ herdrSend: false });
    const created = await newSession(manager, { cwd: PROJECT, prompt: 'zrób coś czerwone' });
    await vi.advanceTimersByTimeAsync(500);
    const request = manager.transcript(created.id).pendingPermissions[0]!;
    await expect(manager.resolvePermission(created.id, request.permId, 'allow', 'iphone'))
      .rejects.toThrow(/herdr is read-only/);
    await expect(manager.resolvePermission(created.id, request.permId, 'deny', 'iphone'))
      .resolves.toEqual({ outcome: 'ok' });
    expect(manager.transcript(created.id).pendingPermissions).toHaveLength(0);
  });

  it('delty nie mają seq i nie wchodzą do ring buffera; wiadomości mają', async () => {
    const { manager } = await build();
    const events = record(manager);

    const created = await newSession(manager, { cwd: PROJECT, prompt: 'opowiedz coś' });
    await vi.advanceTimersByTimeAsync(10_000);

    const deltas = events.filter((e) => e.event.type === 'delta');
    expect(deltas.length).toBeGreaterThan(0);
    for (const delta of deltas) {
      expect(delta.seq).toBeNull();
      expect(delta.scope).toBe(created.id);
    }

    const messages = events.filter((e) => e.event.type === 'message');
    for (const message of messages) expect(typeof message.seq).toBe('number');

    // Replay z bufora nie zawiera delt.
    const replay = manager.eventsSince(created.id, 0);
    expect(replay.tooOld).toBe(false);
    expect(replay.events.some((entry) => entry.event.type === 'delta')).toBe(false);
    // `seq` wiadomości i `seq` eventu to ta sama numeracja.
    const first = replay.events.find((entry) => entry.event.type === 'message');
    expect(first?.event.type === 'message' && first.event.message.seq).toBe(first?.seq);
  });

  it('state i session-changed idą do scope global ORAZ sesji', async () => {
    const { manager } = await build();
    const events = record(manager);

    const created = await newSession(manager, { cwd: PROJECT, prompt: 'cześć' });

    const states = events.filter((e) => e.event.type === 'state');
    expect(states.some((e) => e.scope === 'global')).toBe(true);
    expect(states.some((e) => e.scope === created.id)).toBe(true);
    // Kopia globalna nie przesuwa kursora sesji.
    for (const entry of states) {
      if (entry.scope === 'global') expect(entry.seq).toBeNull();
      else expect(typeof entry.seq).toBe('number');
    }

    const changed = events.filter((e) => e.event.type === 'session-changed');
    expect(changed.some((e) => e.scope === 'global')).toBe(true);
    expect(changed.some((e) => e.scope === created.id)).toBe(true);
  });

  it('interrupt przy pending zgodzie wygasza ją i rozgłasza expired', async () => {
    const { manager } = await build();
    const events = record(manager);

    const created = await newSession(manager, { cwd: PROJECT, prompt: 'czerwone rzeczy' });
    await vi.advanceTimersByTimeAsync(500);
    const request = manager.transcript(created.id).pendingPermissions[0]!;

    manager.interrupt(created.id);

    const expired = events.filter(
      (e) => e.event.type === 'permission-resolved' && e.event.decision === 'expired',
    );
    expect(expired).toHaveLength(1);
    expect(expired[0]!.event).toMatchObject({ permId: request.permId, by: 'system' });
    // Esc = „przerwij i pisz dalej": sesja od razu czeka na wiadomość, bez karty „przerwana".
    expect(stateOf(manager, created.id)).toBe('waiting-input');
    expect(manager.get(created.id)?.stateDetail).toBe(INTERRUPT_DETAIL.text);
    // Decyzja po wygaśnięciu schodzi na ścieżkę „odrzuć dialog" — nie na wyjątek.
    expect(manager.transcript(created.id).pendingPermissions).toHaveLength(0);
  });

  it('close() UKRYWA kartę: sesja znika z listy, panel nie dostaje ani jednego bajtu', async () => {
    const { manager, supervisor } = await buildControlled();
    const created = await newSession(manager, { cwd: PROJECT, prompt: 'czerwone' });

    await manager.close(created.id);

    // „Zamknij" bez `closePanel` znaczy „ukryj w Rarogu" — panel żyje dalej w terminalu.
    expect(manager.get(created.id)).toBeUndefined();
    expect(supervisor.closedTabs).toEqual([]);
  });

  it('close({closePanel}) zamyka tab Raroga i domyka sesję', async () => {
    const { manager, supervisor } = await buildControlled();
    const created = await newSession(manager, { cwd: PROJECT, prompt: 'coś' });

    await manager.close(created.id, { closePanel: true });

    expect(supervisor.closedTabs).toEqual(['w0:p1']);
    expect(manager.get(created.id)).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Triggery mock-drivera
  // -------------------------------------------------------------------------

  it('trigger „pytanie": question-pending → odpowiedź → running → waiting-input', async () => {
    const { manager } = await build();
    const events = record(manager);

    const created = await newSession(manager, { cwd: PROJECT, prompt: 'mam pytanie o zapis' });
    await vi.advanceTimersByTimeAsync(500);
    expect(stateOf(manager, created.id)).toBe('waiting-question');

    const question = manager.transcript(created.id).pendingQuestions[0]!;
    expect(question.questions).toHaveLength(2);
    expect(question.questions[1]?.multiSelect).toBe(true);

    // Jedna cyfra = jedna opcja: wielokrotny wybór odrzuca manager.
    await expect(
      manager.answerQuestion(created.id, question.qId, [['JSON + rename'], ['Jednostkowe']]),
    ).resolves.toEqual({ outcome: 'ok' });
    await expect(manager.answerQuestion(created.id, question.qId, [['x']]))
      .resolves.toEqual({ outcome: 'conflict' });
    expect(stateOf(manager, created.id)).toBe('running');
    expect(events.some((e) => e.event.type === 'question-resolved')).toBe(true);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(stateOf(manager, created.id)).toBe('waiting-input');
  });

  it('trigger „limit": stan limit-reached z detalem resetAt', async () => {
    const { manager } = await build();
    const created = await newSession(manager, { cwd: PROJECT, prompt: 'sprawdź limit planu' });
    await vi.advanceTimersByTimeAsync(500);

    expect(stateOf(manager, created.id)).toBe('limit-reached');
    expect(manager.get(created.id)?.stateDetail).toMatch(/^resetAt=/);
  });

  it('trigger „błąd": exit ok=false → stan error', async () => {
    const { manager } = await build();
    const created = await newSession(manager, { cwd: PROJECT, prompt: 'zasymuluj błąd silnika' });
    await vi.advanceTimersByTimeAsync(500);

    expect(stateOf(manager, created.id)).toBe('error');
    // Atrapa silnika kończy się zdaniem rejestru (`state.driver-error`), tym samym co prawdziwy driver.
    expect(manager.get(created.id)?.stateDetail).toBe('the engine finished with an error');
  });

  it('sendMessage dopisuje wiadomość użytkownika i wznawia turę', async () => {
    const { manager } = await build();
    const created = await newSession(manager, { cwd: PROJECT, prompt: 'pierwszy prompt' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stateOf(manager, created.id)).toBe('waiting-input');

    await manager.sendMessage(created.id, 'a teraz dopisz testy');
    expect(stateOf(manager, created.id)).toBe('running');
    const userMessages = manager.transcript(created.id).messages.filter((m) => m.role === 'user');
    expect(userMessages).toHaveLength(2);
    expect(userMessages[1]?.blocks[0]).toEqual({ type: 'text', text: 'a teraz dopisz testy' });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(stateOf(manager, created.id)).toBe('waiting-input');
  });

  /**
   * Bramka wielokrotnego wyboru pyta o KANAŁ karty, a nie o samą liczbę wartości.
   *
   * Cyfra zamyka jedną opcję, więc dwie wartości byłyby zgadywaniem, jak dialog zareaguje na
   * drugą cyfrę. Odpowiedź przez plik hooka to zwykły tekst („Orzechy, Wiórki", zmierzone),
   * więc ta sama bramka odcinałaby tam funkcję, którą CLI przyjmuje bez mrugnięcia.
   */
  it('wielokrotny wybór: 409 na karcie `keys`, przechodzi na karcie `hook`', async () => {
    const { manager, drivers } = await buildControlled();
    const created = await newSession(manager, { cwd: PROJECT, prompt: 'start' });
    const driver = drivers[0]!;
    driver.queue.push({ type: 'init', engineSessionId: 'engine-1', model: TEST_MODEL });
    const pytanie = {
      question: 'Co dosypać?', header: 'Wierzch', multiSelect: true,
      options: [{ label: 'Orzechy' }, { label: 'Wiórki' }],
    };
    driver.queue.push({
      type: 'question-request', reqId: 'q-keys', questions: [pytanie], channel: 'keys',
    });
    await vi.advanceTimersByTimeAsync(1);

    await expect(manager.answerQuestion(created.id, 'q-keys', [['Orzechy', 'Wiórki']]))
      .rejects.toThrow(BadStateError);

    driver.queue.push({
      type: 'question-request', reqId: 'q-hook', questions: [pytanie], channel: 'hook',
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(manager.transcript(created.id).pendingQuestions.at(-1)?.channel).toBe('hook');

    await expect(manager.answerQuestion(created.id, 'q-hook', [['Orzechy', 'Wiórki']]))
      .resolves.toEqual({ outcome: 'ok' });
  });

  /**
   * Wolny tekst z pola „Własna odpowiedź" — kanał hooka go dowozi, kanał cyfry nie.
   *
   * Na kanale `hook` wartość jedzie plikiem i CLI nie waliduje jej względem `options[].label`
   * (zmierzone), więc dowolne zdanie jest uczciwą odpowiedzią. Na kanale `keys` odpowiedzią jest
   * CYFRA jednej z opcji z ekranu — wartości spoza tej listy nie ma czym wysłać, więc bramka
   * odrzuca ją od razu (400), zamiast puszczać żądanie po odmowę drivera.
   */
  it('wolny tekst: przechodzi na karcie `hook`, 400 na karcie `keys`', async () => {
    const { manager, drivers } = await buildControlled();
    const created = await newSession(manager, { cwd: PROJECT, prompt: 'start' });
    const driver = drivers[0]!;
    driver.queue.push({ type: 'init', engineSessionId: 'engine-1', model: TEST_MODEL });
    const pytanie = {
      question: 'Jaki smak?', header: 'Smak', multiSelect: false,
      options: [{ label: 'Wanilia' }, { label: 'Czekolada' }],
    };
    driver.queue.push({
      type: 'question-request', reqId: 'q-keys', questions: [pytanie], channel: 'keys',
    });
    await vi.advanceTimersByTimeAsync(1);

    await expect(manager.answerQuestion(created.id, 'q-keys', [['Truskawkowy, poproszę']]))
      .rejects.toThrow(BadRequestError);
    // Etykieta Z LISTY przechodzi tą samą drogą — bramka pyta o wartość, nie o kanał samego POST-a.
    await expect(manager.answerQuestion(created.id, 'q-keys', [['Czekolada']]))
      .resolves.toEqual({ outcome: 'ok' });

    driver.queue.push({
      type: 'question-request', reqId: 'q-hook', questions: [pytanie], channel: 'hook',
    });
    await vi.advanceTimersByTimeAsync(1);

    await expect(manager.answerQuestion(created.id, 'q-hook', [['Truskawkowy, poproszę']]))
      .resolves.toEqual({ outcome: 'ok' });
  });

  it('sufit długości odpowiedzi obowiązuje w OBU kanałach', async () => {
    const { manager, drivers } = await buildControlled();
    const created = await newSession(manager, { cwd: PROJECT, prompt: 'start' });
    const driver = drivers[0]!;
    driver.queue.push({ type: 'init', engineSessionId: 'engine-1', model: TEST_MODEL });
    driver.queue.push({
      type: 'question-request',
      reqId: 'q-hook',
      channel: 'hook',
      questions: [{
        question: 'Jaki smak?', header: 'Smak', multiSelect: false, options: [{ label: 'Wanilia' }],
      }],
    });
    await vi.advanceTimersByTimeAsync(1);

    const zaDlugi = 'x'.repeat(MAX_ANSWER_TEXT_CHARS + 1);
    await expect(manager.answerQuestion(created.id, 'q-hook', [[zaDlugi]]))
      .rejects.toThrow(BadRequestError);
    // Dokładnie sufit jeszcze przechodzi — granica jest granicą, nie strefą.
    await expect(manager.answerQuestion(created.id, 'q-hook', [['x'.repeat(MAX_ANSWER_TEXT_CHARS)]]))
      .resolves.toEqual({ outcome: 'ok' });
  });

  it('sendMessage z obrazkami: WIZYTÓWKI w transkrypcie, a do panelu idą ŚCIEŻKI', async () => {
    const { manager, drivers } = await buildControlled();
    const created = await newSession(manager, { cwd: PROJECT, prompt: 'pierwszy prompt' });
    drivers[0]!.queue.push({ type: 'init', engineSessionId: 'engine-1', model: TEST_MODEL });
    await vi.advanceTimersByTimeAsync(1);

    await manager.sendMessage(created.id, 'popraw ten układ', [PNG, PNG]);

    const last = manager.transcript(created.id).messages.at(-1)!;
    expect(last.role).toBe('user');
    // Bajty zdjęcia leżą w `.rarog-uploads`, transkrypt niesie samą wizytówkę
    // z NAZWĄ pliku (`basename` ścieżki z `writeUploads`), po której PWA prosi o miniaturę.
    expect(last.blocks).toEqual([{ type: 'text', text: 'popraw ten układ' }]);
    expect(last.attachments).toEqual([
      { kind: 'image', name: '', bytes: dataUrlBytes(PNG), mime: 'image/png', file: 'up-0' },
      { kind: 'image', name: '', bytes: dataUrlBytes(PNG), mime: 'image/png', file: 'up-1' },
    ]);
    expect(JSON.stringify(last)).not.toContain(';base64,');
    /*
     * Do PANELU idzie tekst ze ścieżkami zapisanych plików i ZERO obrazków: uploady robi
     * manager PRZED przejściem stanu, a drugi zapis tych samych zdjęć w driverze byłby
     * cichym duplikatem na dysku.
     */
    expect(drivers[0]!.sent.at(-1)).toContain('popraw ten układ');
    expect(drivers[0]!.sent.at(-1)).toContain('/up-0');
    expect(drivers[0]!.sentImages.at(-1)).toBeUndefined();
  });

  it('sam obrazek bez tekstu nie tworzy pustego bloku tekstowego', async () => {
    const { manager, drivers } = await buildControlled();
    const created = await newSession(manager, { cwd: PROJECT, prompt: 'start' });
    drivers[0]!.queue.push({ type: 'init', engineSessionId: 'engine-1', model: TEST_MODEL });
    await vi.advanceTimersByTimeAsync(1);

    await manager.sendMessage(created.id, '', [PNG]);
    const last = manager.transcript(created.id).messages.at(-1)!;
    expect(last.blocks).toEqual([]);
    expect(last.attachments).toHaveLength(1);
  });

  it('snapshot z 5 zdjęciami waży poniżej 64 kB — bajtów zdjęć w nim nie ma', async () => {
    const { manager, drivers } = await buildControlled();
    const created = await newSession(manager, { cwd: PROJECT, prompt: 'start' });
    drivers[0]!.queue.push({ type: 'init', engineSessionId: 'engine-1', model: TEST_MODEL });
    await vi.advanceTimersByTimeAsync(1);

    // Pięć zdjęć „pełnowymiarowych" (limit protokołu) w jednej wiadomości — najgorszy
    // dopuszczalny przypadek, ten, przy którym snapshot ważył megabajty.
    const big = `data:image/png;base64,${'A'.repeat(1_400_000)}`;
    await manager.sendMessage(created.id, 'zobacz', [big, big, big, big, big]);

    const snapshot = JSON.stringify(manager.transcript(created.id));
    expect(snapshot).not.toContain(';base64,');
    expect(Buffer.byteLength(snapshot, 'utf8')).toBeLessThan(64 * 1024);
  });

  // -------------------------------------------------------------------------
  // Ryzyko liczone na pełnym inpucie
  // -------------------------------------------------------------------------

  it('czerwona fraza za progiem prezentacji nadal daje risk red', async () => {
    const { manager, drivers } = await buildControlled();
    const created = await newSession(manager, { cwd: PROJECT, prompt: 'start' });
    const driver = drivers[0]!;
    driver.queue.push({ type: 'init', engineSessionId: 'engine-1', model: TEST_MODEL });
    await vi.advanceTimersByTimeAsync(1);

    // Komenda dłuższa niż stary limit 2 kB, z `rm -rf` dopiero na końcu.
    const command = `echo ${'a'.repeat(3_000)} && rm -rf ./dist`;
    driver.queue.push({
      type: 'permission-request',
      reqId: 'perm-dlugi',
      toolName: 'Bash',
      input: { command },
      // Karta zgody dostaje SKRÓT — klasyfikator nie może na nim polegać, bo czerwona fraza
      // jest poza skrótem.
      displayText: `${command.slice(0, 2_000)}\n… (ucięto ${String(command.length - 2_000)} znaków)`,
    });
    await vi.advanceTimersByTimeAsync(1);

    const [request] = manager.transcript(created.id).pendingPermissions;
    expect(request?.displayText).not.toContain('rm -rf');
    expect(request?.risk).toBe('red');
  });

  // -------------------------------------------------------------------------
  // Aktywność (kanał ULOTNY)
  // -------------------------------------------------------------------------

  it('activity: bez seq, poza ring bufferem, ale w transcript-snapshot żywej sesji', async () => {
    const { manager, drivers } = await buildControlled();
    const events = record(manager);

    const created = await newSession(manager, { cwd: PROJECT, prompt: 'zrób coś' });
    const driver = drivers[0]!;
    driver.queue.push({ type: 'init', engineSessionId: 'engine-1', model: TEST_MODEL });
    driver.queue.push({ type: 'activity', kind: 'tool', toolName: 'Bash', elapsedSeconds: 148 });
    await vi.advanceTimersByTimeAsync(1);

    // Filtr po `scope`: ten sam event leci DWOMA kanałami (sesja + globalny dla listy),
    // a ten test pilnuje wyłącznie strumienia sesji.
    const activity = events.filter((e) => e.event.type === 'activity' && e.scope === created.id);
    expect(activity).toHaveLength(1);
    expect(activity[0]!.seq).toBeNull();
    // Poza ring bufferem: replay po reconnekcie nie może powtórzyć „uruchamia: Bash".
    const replay = manager.eventsSince(created.id, 0);
    expect(replay.events.some((e) => e.event.type === 'activity')).toBe(false);
    // Ale telefon wchodzący w ŚRODKU tury dostaje stan w snapshocie.
    expect(manager.transcript(created.id).activity)
      .toEqual({ kind: 'tool', toolName: 'Bash', elapsedSeconds: 148 });

    // Domknięta wiadomość zastępuje wskaźnik.
    driver.queue.push({
      type: 'message', role: 'assistant', blocks: [{ type: 'text', text: foreign('ok') }],
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(manager.transcript(created.id).activity).toBeUndefined();
  });

  it('wyjście ze stanów żywych gasi wskaźnik aktywności (idle)', async () => {
    const { manager, drivers } = await buildControlled();
    const events = record(manager);

    const created = await newSession(manager, { cwd: PROJECT, prompt: 'zrób coś' });
    const driver = drivers[0]!;
    driver.queue.push({ type: 'init', engineSessionId: 'engine-1', model: TEST_MODEL });
    driver.queue.push({ type: 'activity', kind: 'thinking' });
    driver.queue.push({ type: 'result', subtype: 'success' });
    await vi.advanceTimersByTimeAsync(1);

    const kinds = events
      .filter((e) => e.event.type === 'activity' && e.scope === created.id)
      .map((e) => (e.event as Extract<ServerEvent, { type: 'activity' }>).kind);
    expect(kinds).toEqual(['thinking', 'idle']);
    expect(manager.transcript(created.id).activity).toBeUndefined();
  });

  it('podwójne „idle" (driver + wyjście ze stanu żywego) schodzi do jednego eventu', async () => {
    const { manager, drivers } = await buildControlled();
    const events = record(manager);

    const created = await newSession(manager, { cwd: PROJECT, prompt: 'zrób coś' });
    const driver = drivers[0]!;
    driver.queue.push({ type: 'init', engineSessionId: 'engine-1', model: TEST_MODEL });
    driver.queue.push({ type: 'activity', kind: 'tool', toolName: 'Read' });
    driver.queue.push({ type: 'activity', kind: 'idle' });
    driver.queue.push({ type: 'result', subtype: 'success' });
    await vi.advanceTimersByTimeAsync(1);

    const kinds = events
      .filter((e) => e.event.type === 'activity' && e.scope === created.id)
      .map((e) => (e.event as Extract<ServerEvent, { type: 'activity' }>).kind);
    expect(kinds).toEqual(['tool', 'idle']);
    expect(manager.transcript(created.id).activity).toBeUndefined();
  });

  /*
   * Aktywność musi dojść do LISTY, nie tylko do otwartego transkryptu.
   *
   * Lista słucha wyłącznie kanału globalnego (nie subskrybuje sesji z osobna), więc dopóki
   * `activity` szła samym strumieniem sesji, wiersz pracującej sesji nie miał skąd wiedzieć,
   * CO się dzieje — treść widział tylko ten, kto miał sesję otwartą.
   */
  it('activity dociera także kanałem GLOBALNYM (lista bez subskrypcji transkryptu)', async () => {
    const { manager, drivers } = await buildControlled();
    const events = record(manager);

    const created = await newSession(manager, { cwd: PROJECT, prompt: 'zrób coś' });
    const driver = drivers[0]!;
    driver.queue.push({ type: 'init', engineSessionId: 'engine-1', model: TEST_MODEL });
    driver.queue.push({ type: 'activity', kind: 'tool', toolName: 'Bash', elapsedSeconds: 148 });
    await vi.advanceTimersByTimeAsync(1);

    const global = events.filter((e) => e.event.type === 'activity' && e.scope === 'global');
    expect(global).toHaveLength(1);
    // Kanał globalny nie numeruje: `seq` należy do strumienia sesji i tylko tam ma sens.
    expect(global[0]!.seq).toBeNull();
    expect(global[0]!.event).toMatchObject({
      type: 'activity', sessionId: created.id, kind: 'tool', toolName: 'Bash',
    });
    // Replay po reconnekcie dalej NIE powtarza aktywności — kanał globalny niczego nie buforuje.
    expect(manager.eventsSince(created.id, 0).events.some((e) => e.event.type === 'activity'))
      .toBe(false);
  });

  it('summary pracującej sesji NIESIE activity, a po końcu tury już nie', async () => {
    const { manager, drivers } = await buildControlled();
    const created = await newSession(manager, { cwd: PROJECT, prompt: 'zrób coś' });
    const driver = drivers[0]!;
    driver.queue.push({ type: 'init', engineSessionId: 'engine-1', model: TEST_MODEL });
    driver.queue.push({ type: 'activity', kind: 'tool', toolName: 'Bash', elapsedSeconds: 148 });
    await vi.advanceTimersByTimeAsync(1);

    const working = manager.get(created.id);
    expect(working?.state).toBe('running');
    expect(working?.activity).toEqual({ kind: 'tool', toolName: 'Bash', elapsedSeconds: 148 });
    // Ta sama prawda w ramce, którą telefon dostaje po reconnekcie.
    expect(manager.list().find((s) => s.id === created.id)?.activity?.toolName).toBe('Bash');

    // Koniec tury gasi wskaźnik: karta ma stracić pole, a nie zostać z „uruchamia: Bash".
    driver.queue.push({ type: 'result', subtype: 'success' });
    await vi.advanceTimersByTimeAsync(1);
    const idle = manager.get(created.id);
    expect(idle?.state).toBe('waiting-input');
    expect(idle?.activity).toBeUndefined();
    expect('activity' in idle!).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Wyścigi (driver sterowany z testu)
  // -------------------------------------------------------------------------

  it('delta po przerwaniu sesji jest odrzucana', async () => {
    const { manager, drivers } = await buildControlled();
    const events = record(manager);

    const created = await newSession(manager, { cwd: PROJECT, prompt: 'cokolwiek' });
    const driver = drivers[0]!;
    driver.queue.push({ type: 'init', engineSessionId: 'engine-1', model: TEST_MODEL });
    await vi.advanceTimersByTimeAsync(1);
    expect(stateOf(manager, created.id)).toBe('running');

    manager.interrupt(created.id);
    driver.queue.push({ type: 'delta', text: 'spóźniona delta' });
    await vi.advanceTimersByTimeAsync(1);

    expect(events.some((e) => e.event.type === 'delta')).toBe(false);
    expect(driver.interrupts).toBe(1);
  });

  it('result po przerwaniu nie zmienia stanu (maszyna stanów wygrywa)', async () => {
    const { manager, drivers } = await buildControlled();
    const created = await newSession(manager, { cwd: PROJECT, prompt: 'cokolwiek' });
    const driver = drivers[0]!;
    driver.queue.push({ type: 'init', engineSessionId: 'engine-1', model: TEST_MODEL });
    await vi.advanceTimersByTimeAsync(1);

    manager.interrupt(created.id);
    driver.queue.push({ type: 'result', subtype: 'success', summary: 'za późno' });
    await vi.advanceTimersByTimeAsync(1);

    expect(stateOf(manager, created.id)).toBe('waiting-input');
  });

  it('result error_max_turns → interrupted z detalem „limit tur"', async () => {
    const { manager, drivers } = await buildControlled();
    const created = await newSession(manager, { cwd: PROJECT, prompt: 'cokolwiek' });
    const driver = drivers[0]!;
    driver.queue.push({ type: 'init', engineSessionId: 'engine-1', model: TEST_MODEL });
    driver.queue.push({ type: 'result', subtype: 'error_max_turns' });
    await vi.advanceTimersByTimeAsync(1);

    expect(stateOf(manager, created.id)).toBe('interrupted');
    expect(manager.get(created.id)?.stateDetail).toBe(MAX_TURNS_DETAIL.text);
  });

  // -------------------------------------------------------------------------
  // Git i kontekst
  // -------------------------------------------------------------------------

  it('git-status z drivera aktualizuje branch i licznik zmian', async () => {
    const { manager, drivers } = await buildControlled();
    const events = record(manager);

    const created = await newSession(manager, { cwd: PROJECT, prompt: 'cokolwiek' });
    const driver = drivers[0]!;
    driver.queue.push({ type: 'init', engineSessionId: 'engine-1', model: TEST_MODEL });
    driver.queue.push({
      type: 'git-status', branch: 'feat/x', dirtyCount: 2, files: ['a.ts', 'b.ts'],
    });
    await vi.advanceTimersByTimeAsync(1);

    expect(manager.get(created.id)).toMatchObject({ branch: 'feat/x', dirtyCount: 2 });
    expect(events.some((e) => e.event.type === 'git-status' && e.scope === created.id)).toBe(true);
  });

  it('ahead/behind z git-status trafiają do eventu i do podsumowania sesji', async () => {
    const { manager, drivers } = await buildControlled();
    const events = record(manager);

    const created = await newSession(manager, { cwd: PROJECT, prompt: 'cokolwiek' });
    const driver = drivers[0]!;
    driver.queue.push({ type: 'init', engineSessionId: 'engine-1', model: TEST_MODEL });
    driver.queue.push({
      type: 'git-status', branch: 'main', dirtyCount: 1, files: ['a.ts'], ahead: 2, behind: 0,
    });
    await vi.advanceTimersByTimeAsync(1);

    expect(manager.get(created.id)).toMatchObject({ ahead: 2, behind: 0 });
    const git = events.find((e) => e.event.type === 'git-status')?.event;
    expect(git).toMatchObject({ ahead: 2, behind: 0 });

    // Odczyt bez upstreamu CZYŚCI poprzednie wartości (gałąź bez remote'a).
    driver.queue.push({ type: 'git-status', branch: 'wip', dirtyCount: 1, files: ['a.ts'] });
    await vi.advanceTimersByTimeAsync(1);

    const summary = manager.get(created.id)!;
    expect(summary.branch).toBe('wip');
    expect('ahead' in summary).toBe(false);
    const lastGit = events.filter((e) => e.event.type === 'git-status').at(-1)?.event;
    expect(lastGit && 'ahead' in lastGit).toBe(false);
  });

  it('trójka rodzajów z git-status trafia do eventu i do podsumowania', async () => {
    const { manager, drivers } = await buildControlled();
    const events = record(manager);

    const created = await newSession(manager, { cwd: PROJECT, prompt: 'x' });
    const driver = drivers[0]!;
    driver.queue.push({ type: 'init', engineSessionId: 'engine-1', model: TEST_MODEL });
    driver.queue.push({
      type: 'git-status', branch: 'main', dirtyCount: 2, files: ['a.ts'],
      fileKinds: { added: 1, modified: 1, deleted: 0 },
    });
    await vi.advanceTimersByTimeAsync(1);

    const kinds = { added: 1, modified: 1, deleted: 0 };
    expect(manager.get(created.id)).toMatchObject({ fileKinds: kinds });
    expect(events.find((e) => e.event.type === 'git-status')?.event)
      .toMatchObject({ fileKinds: kinds });

    // Odczyt bez trójki CZYŚCI poprzednią (driver, który rodzajów nie zna).
    driver.queue.push({ type: 'git-status', branch: 'main', dirtyCount: 2, files: ['a.ts'] });
    await vi.advanceTimersByTimeAsync(1);
    expect('fileKinds' in manager.get(created.id)!).toBe(false);
  });

  it('usage ze ZNANYM limitem daje pasek (event `usage`) i pole `context`', async () => {
    const { manager, drivers } = await buildControlled();
    const events = record(manager);

    const created = await newSession(manager, { cwd: PROJECT, prompt: 'x' });
    const driver = drivers[0]!;
    driver.queue.push({ type: 'init', engineSessionId: 'engine-1', model: TEST_MODEL });
    driver.queue.push({
      type: 'usage',
      context: { kind: 'known', tokens: 64_000, limit: 200_000, source: 'compact-boundary' },
    });
    await vi.advanceTimersByTimeAsync(1);

    expect(manager.get(created.id)?.usage)
      .toEqual({ contextTokens: 64_000, contextLimit: 200_000 });
    expect(manager.get(created.id)?.context)
      .toMatchObject({ kind: 'known', tokens: 64_000, limit: 200_000 });
    const usage = events.find((e) => e.event.type === 'usage');
    expect(usage?.scope).toBe(created.id);
    expect(usage?.event).toMatchObject({ sessionId: created.id, contextTokens: 64_000 });
  });

  it('usage z NIEZNANYM limitem niesie liczbę tokenów, ale NIE rysuje paska', async () => {
    const { manager, drivers } = await buildControlled();
    const events = record(manager);

    const created = await newSession(manager, { cwd: PROJECT, prompt: 'x' });
    const driver = drivers[0]!;
    driver.queue.push({ type: 'init', engineSessionId: 'engine-1', model: TEST_MODEL });
    driver.queue.push({ type: 'usage', context: { kind: 'unknown', tokens: 184_000 } });
    await vi.advanceTimersByTimeAsync(1);

    /*
     * W jsonl nie ma limitu okna, a identyfikator modelu nie
     * odróżnia wariantu 1M. Zmyślony limit pokazywałby sesji 1M ~92 % przy 185k — czyli alarm
     * bez powodu. Karta dostaje samą liczbę, event `usage` (który z kontraktu WYMAGA limitu)
     * nie leci wcale.
     */
    expect(manager.get(created.id)?.context).toEqual({ kind: 'unknown', tokens: 184_000 });
    expect(manager.get(created.id)?.usage).toBeUndefined();
    expect(events.some((e) => e.event.type === 'usage')).toBe(false);
    const changed = events.filter((e) => e.event.type === 'session-changed').at(-1)?.event;
    expect(changed?.type === 'session-changed' && changed.session.context?.tokens).toBe(184_000);
  });

  // -------------------------------------------------------------------------
  // Walidacje i replay
  // -------------------------------------------------------------------------

  it('cwd spoza allow-listy jest odrzucany i NIE zakłada panelu', async () => {
    const { manager, supervisor } = await build();
    await expect(manager.create({ cwd: '/etc', prompt: 'x' }))
      .rejects.toThrow(/isn't in the project list/);
    expect(supervisor.launches).toHaveLength(0);
  });

  it('sendMessage do nieznanej sesji rzuca NotFound, a do ukrytej — NotFound', async () => {
    const { manager } = await build();
    expect(() => manager.sendMessage('nie-ma', 'x')).toThrow(/That session doesn't exist/);

    const created = await newSession(manager, { cwd: PROJECT, prompt: 'x' });
    await manager.close(created.id);
    expect(() => manager.sendMessage(created.id, 'x')).toThrow(/That session doesn't exist/);
  });

  it('eventsSince: brak kursora → pusto, kursor za stary → tooOld', async () => {
    const { manager } = await buildControlled();
    const created = await newSession(manager, { cwd: PROJECT, prompt: 'x' });

    expect(manager.eventsSince(created.id, null)).toEqual({ tooOld: false, events: [] });
    expect(manager.eventsSince(created.id, 9_999).tooOld).toBe(true);
    expect(manager.eventsSince('nie-ma', 1).tooOld).toBe(true);

    const tail = manager.eventsSince(created.id, 1);
    expect(tail.tooOld).toBe(false);
    expect(tail.events.every((entry) => (entry.seq ?? 0) > 1)).toBe(true);
  });

  it('projects() zwraca skonfigurowaną allow-listę', async () => {
    const { manager } = await build();
    expect(manager.projects()).toEqual([{ path: PROJECT, name: 'willow' }]);
  });

  it('create bez promptu: pusty transkrypt i od razu waiting-input', async () => {
    const { manager, drivers } = await buildControlled();
    const events = record(manager);

    const created = await newSession(manager, { cwd: PROJECT });
    // Panel stoi i czeka na człowieka — `starting` bez końca byłoby UI, które kłamie.
    expect(created.state).toBe('waiting-input');
    expect(manager.transcript(created.id).messages).toHaveLength(0);

    // Sesja jest normalnie sterowalna — pierwsza wiadomość rusza turę.
    await manager.sendMessage(created.id, 'zaczynamy');
    expect(stateOf(manager, created.id)).toBe('running');
    expect(events.some((e) => e.event.type === 'state')).toBe(true);

    // Spóźniony `init` z jsonl nie cofa tury.
    drivers[0]!.queue.push({ type: 'init', engineSessionId: 'engine-1', model: TEST_MODEL });
    await vi.advanceTimersByTimeAsync(1);
    expect(stateOf(manager, created.id)).toBe('running');
    expect(manager.transcript(created.id).messages).toHaveLength(1);
  });

  it('pusty prompt jest traktowany jak brak promptu', async () => {
    const { manager, supervisor } = await buildControlled();
    const created = await newSession(manager, { cwd: PROJECT, prompt: '' });

    expect(created.state).toBe('waiting-input');
    expect(manager.transcript(created.id).messages).toHaveLength(0);
    expect(supervisor.launches).toHaveLength(1);
  });

  it('resumable pyta czytnik magazynu i nie przepuszcza cudzych katalogów', async () => {
    const wpis = {
      engineSessionId: 'e1', cwd: PROJECT, mtime: '2026-08-21T10:00:00.000Z',
      firstPrompt: 'Popraw zapis notatek.', liveInHerdr: false,
    };
    const reader = vi.fn(async () => [wpis]);
    const { manager } = await build({ resumableReader: reader });

    expect(await manager.resumable(PROJECT)).toEqual([wpis]);
    // `limit` jedzie jawnie: to kontrakt listy (20), a nie sufit pobrania czytnika.
    expect(reader).toHaveBeenCalledWith({ dir: PROJECT, limit: 20 });
    await expect(manager.resumable('/etc')).rejects.toThrow(BadRequestError);
  });

  it('recentResumable: sufit i kolejność API, katalog spoza allow-listy odrzucony', async () => {
    const entries = Array.from({ length: 13 }, (_, i) => ({
      engineSessionId: `e${String(i)}`, cwd: PROJECT, mtime: '2026-08-21T10:00:00.000Z',
      firstPrompt: `prompt ${String(i)}`, liveInHerdr: false,
    }));
    const { manager } = await build({ resumableReader: () => Promise.resolve(entries) });

    expect((await manager.recentResumable(PROJECT)).map((e) => e.engineSessionId))
      .toEqual(['e0', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7', 'e8', 'e9']);
    await expect(manager.recentResumable('/etc')).rejects.toThrow(BadRequestError);
  });

  it('recentResumable pyta czytnik z ZAPASEM — otwarte odpadają dopiero po odczycie', async () => {
    const reader = vi.fn(async () => []);
    const { manager } = await build({ resumableReader: reader });
    await manager.recentResumable(PROJECT, 5);
    expect(reader).toHaveBeenCalledWith({ dir: PROJECT, limit: 20 });
  });

  it('recentResumable odrzuca wpis z INNEGO katalogu, gdyby API go przysłało', async () => {
    const { manager } = await build({
      resumableReader: () => Promise.resolve([
        { engineSessionId: 'obcy', cwd: '/etc', mtime: '2026-08-21T10:00:00.000Z',
          firstPrompt: 'x', liveInHerdr: false },
        { engineSessionId: 'swoj', cwd: PROJECT, mtime: '2026-08-21T09:00:00.000Z',
          firstPrompt: 'y', liveInHerdr: false },
      ]),
    });
    expect((await manager.recentResumable(PROJECT)).map((e) => e.engineSessionId)).toEqual(['swoj']);
  });

  /*
   * Rozstrzygnięcie użytkownika: sesji OTWARTYCH na tej liście nie ma w ogóle. Źródłem prawdy
   * jest `claude agents --json` (widzi też `claude` w gołym tmuxie), a `null` znaczy „nie wiem"
   * i nie może odsiać niczego — inaczej cisza czytnika ukrywałaby całą listę.
   */
  it('recentResumable: wpis żywy wypada, a „nie wiem" nie odsiewa nikogo', async () => {
    const entries = [
      { engineSessionId: 'zywa', cwd: PROJECT, mtime: '2026-08-21T10:00:00.000Z',
        firstPrompt: 'x', liveInHerdr: false },
      { engineSessionId: 'martwa', cwd: PROJECT, mtime: '2026-08-21T09:00:00.000Z',
        firstPrompt: 'y', liveInHerdr: false },
    ];
    const odsiana = await build({
      resumableReader: () => Promise.resolve(entries),
      liveSessionsReader: () => Promise.resolve(new Set(['zywa'])),
    });
    expect((await odsiana.manager.recentResumable(PROJECT)).map((e) => e.engineSessionId))
      .toEqual(['martwa']);

    const niewiedza = await build({
      resumableReader: () => Promise.resolve(entries),
      liveSessionsReader: () => Promise.resolve(null),
    });
    expect(await niewiedza.manager.recentResumable(PROJECT)).toHaveLength(2);
  });

  it('awaria czytnika magazynu daje pustą listę zamiast 500', async () => {
    const { manager } = await build({
      resumableReader: () => Promise.reject(new Error('EACCES')),
    });
    expect(await manager.resumable(PROJECT)).toEqual([]);
  });

  it('resumable dokłada etykietę ŻYWEGO panelu (`title`) — z RAM, bez pytania herdr', async () => {
    // Identyfikator sesji silnika, który `MockDriver` zgłasza w `init` jako pierwszy.
    const engine = 'mock-engine-1';
    const { manager } = await build({
      resumableReader: () => Promise.resolve([{
        engineSessionId: engine, cwd: PROJECT, mtime: '2026-08-21T10:00:00.000Z',
        firstPrompt: 'Pierwszy prompt z magazynu.', liveInHerdr: false,
      }]),
    });
    const created = await newSession(manager, { cwd: PROJECT, prompt: 'Popraw zapis notatek.' });

    const [entry] = await manager.resumable(PROJECT);
    expect(entry?.liveInHerdr).toBe(true);
    expect(entry?.title).toBe(manager.get(created.id)?.label);
    expect(entry?.title).not.toBe('');
  });

  it('sesja BEZ żywego panelu nie dostaje `title` (nie ma skąd go wziąć)', async () => {
    const { manager } = await build({
      resumableReader: () => Promise.resolve([{
        engineSessionId: 'nieznana', cwd: PROJECT, mtime: '2026-08-21T10:00:00.000Z',
        firstPrompt: 'Pierwszy prompt z magazynu.', liveInHerdr: false,
      }]),
    });
    const [entry] = await manager.resumable(PROJECT);
    expect(entry?.liveInHerdr).toBe(false);
    expect(entry?.title).toBeUndefined();
  });

  it('odbita walidacja `resumeFrom` NIE pali slotu uruchomień', async () => {
    // Throttle produkcyjny (5 s) włączony na sztywno: gdyby odrzucone żądanie zabrało slot,
    // następny — poprawny — klik dostałby 429 zamiast sesji.
    const { manager, supervisor } = await build({ launchThrottle: { minIntervalMs: 60_000 } });

    // `testDeps()` nie ma `resumeSource`, więc walidacja odbija wznowienie fail-closed (400).
    const odbite = manager.create({
      cwd: PROJECT, resumeFrom: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000009',
    });
    await expect(odbite).rejects.toThrow(/Couldn't verify which directory/);
    expect(supervisor.launches).toHaveLength(0);

    const created = await newSession(manager, { cwd: PROJECT });
    expect(created.state).not.toBe(undefined);
    expect(supervisor.launches).toHaveLength(1);
  });

  it('wznowienie karty z ROZWIĄZANYM modelem nie umiera na allow-liście', async () => {
    // Sesja wstała na aliasie, `init` nadpisał go pełnym identyfikatorem (jak w produkcji).
    const { manager, supervisor, drivers } = await buildControlled();
    const created = await newSession(manager, { cwd: PROJECT, prompt: 'x', model: 'opus[1m]' });
    drivers[0]!.queue.push({ type: 'init', engineSessionId: 'mock-engine-1', model: 'claude-opus-5[1m]' });
    await vi.advanceTimersByTimeAsync(1);
    expect(manager.get(created.id)?.model).toBe('claude-opus-5[1m]');

    supervisor.lifecycle.push({ type: 'gone', key: 'w0:p1' });
    await vi.advanceTimersByTimeAsync(0);

    // Odbija dopiero `#assertResumable` (brak `resumeSource` w atrapie) — czyli DALEJ niż
    // `#assertKnownModel`, który przed poprawką kończył wznowienie na „nie jest na liście".
    await expect(manager.resume(created.id)).rejects.toThrow(/Couldn't verify which directory/);
    expect(manager.get(created.id)?.id).toBe(created.id);
  });

  it('nieudane wznowienie PRZYWRACA kartę — sesja nie znika z listy', async () => {
    // Identyfikator sesji silnika PO `init` z drivera (mock-fabryka numeruje deterministycznie),
    // bo to on trafia do indeksu — magazyn CLI ma opowiadać dokładnie o tej karcie, inaczej
    // `resumable()` nie ma czego z nią zestawić.
    const engineSessionId = 'mock-engine-1';
    const { manager, supervisor } = await build({
      resumableReader: () => Promise.resolve([{
        engineSessionId,
        cwd: PROJECT,
        mtime: '2026-08-24T10:00:00.000Z',
        firstPrompt: 'Popraw zapis notatek.',
        liveInHerdr: false,
      }]),
    });
    const created = await newSession(manager, { cwd: PROJECT, prompt: 'Popraw zapis notatek.' });
    // Póki panel żyje, lista wznawiania musi mówić „otwarta w herdr" — to jest ta sama karta.
    expect((await manager.resumable(PROJECT))[0]?.liveInHerdr).toBe(true);

    // Panel zniknął z herdr → driver odpięty, karta czeka na „Wznów".
    supervisor.lifecycle.push({ type: 'gone', key: 'w0:p1' });
    await vi.advanceTimersByTimeAsync(0);

    // Wznowienie odbija się o `#assertResumable` (brak `resumeSource` w atrapie zależności).
    await expect(manager.resume(created.id)).rejects.toThrow(/Couldn't verify which directory/);

    // Przed rollbackiem karta ginęła bezpowrotnie: `resume()` skasował ją z map, a `create()`
    // nie zdążył postawić nowej — jedynym odzyskaniem był restart serwera.
    expect(manager.get(created.id)?.id).toBe(created.id);
    expect(manager.list().map((s) => s.id)).toContain(created.id);
    expect(supervisor.launches).toHaveLength(1);
    /*
     * Lista wznawiania po rollbacku: wpis ZOSTAJE, ale jako martwy.
     *
     * `liveInHerdr` liczy `#liveSession`, czyli `#byEngineSession` ORAZ żywy driver — a `resume()`
     * z definicji dotyczy karty bez drivera, więc `true` nie ma tu prawa paść i asercja na nie
     * byłaby asercją na niemożliwe. Broniona jest rzecz odwrotna i realna: rollback nie zostawia
     * po sobie WPISU-WIDMA (indeks wskazujący na kartę usuniętą z `#sessions` zgłosiłby tu żywy
     * panel, którego nie ma) ani drugiego wiersza tej samej sesji silnika.
     */
    const after = await manager.resumable(PROJECT);
    expect(after.map((s) => s.engineSessionId)).toEqual([engineSessionId]);
    expect(after[0]?.liveInHerdr).toBe(false);
  });

  it('korzeń projektów wpuszcza dowolny istniejący podkatalog (pole „inna ścieżka")',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'rarog-roots-'));
      const nested = join(root, 'grupa', 'projekt');
      await mkdir(nested, { recursive: true });
      try {
        const { manager } = await build({ projects: [], projectRoots: [root] });

        const created = await newSession(manager, { cwd: nested });
        expect(manager.get(created.id)?.cwd).toBe(nested);

        // Poza korzeniem, katalog ukryty i nieistniejący — wszystkie odrzucone.
        await expect(manager.create({ cwd: tmpdir(), prompt: 'x' }))
          .rejects.toThrow(BadRequestError);
        await expect(manager.create({ cwd: join(root, '.ukryty'), prompt: 'x' }))
          .rejects.toThrow(/Hidden directories/);
        await expect(manager.create({ cwd: join(root, 'nie-ma'), prompt: 'x' }))
          .rejects.toThrow(/directory doesn't exist/);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

  // -------------------------------------------------------------------------
  // Model i effort
  // -------------------------------------------------------------------------

  it('model i effort z formularza jadą do launchera i widać je w karcie', async () => {
    // Driver sterowany: bez `init` z silnika karta pokazuje to, co WYBRAŁ użytkownik —
    // nadpisanie identyfikatorem rozwiązanym ma osobny test niżej.
    const { manager, supervisor } = await buildControlled();

    const created = await newSession(manager, {
      cwd: PROJECT, prompt: 'x', model: 'sonnet', effort: 'high',
    });

    expect(supervisor.launches[0]).toMatchObject({ model: 'sonnet', effort: 'high' });
    expect(manager.get(created.id)).toMatchObject({ model: 'sonnet', effort: 'high' });
  });

  it('BRAK modelu = „model domyślny konta": zero flagi w zleceniu launchera', async () => {
    const { manager, supervisor } = await build();
    await newSession(manager, { cwd: PROJECT, prompt: 'x' });

    /*
     * Ustawienie konta to wariant w nawiasie kwadratowym (`claude-fable-5[1m]`), a
     * `MODEL_ID_PATTERN` nawiasów nie przepuszcza. Wysłanie identyfikatora BEZ wariantu
     * znaczyłoby więc okno 200k zamiast 1M — po cichu. Brak flagi jest jedyną wartością,
     * która na pewno nie kłamie.
     */
    expect(supervisor.launches[0]).not.toHaveProperty('model');
    expect(supervisor.launches[0]).not.toHaveProperty('effort');
  });

  it('init z silnika nadpisuje alias identyfikatorem rozwiązanym i rozgłasza zmianę', async () => {
    const { manager, drivers } = await buildControlled();
    const created = await newSession(manager, { cwd: PROJECT, prompt: 'x', model: 'sonnet' });
    const events = record(manager);

    drivers[0]!.queue.push({
      type: 'init', engineSessionId: 'engine-1', model: 'claude-sonnet-4-6-20260101',
    });
    await vi.advanceTimersByTimeAsync(1);

    expect(manager.get(created.id)?.model).toBe('claude-sonnet-4-6-20260101');
    expect(events.some((e) => e.event.type === 'session-changed')).toBe(true);
  });

  it('init z effortem nadpisuje effort sesji; init bez niego niczego nie rusza', async () => {
    const { manager, drivers } = await buildControlled();
    const created = await newSession(manager, { cwd: PROJECT, prompt: 'x', effort: 'low' });

    drivers[0]!.queue.push({ type: 'init', engineSessionId: 'e1', model: TEST_MODEL });
    await vi.advanceTimersByTimeAsync(1);
    // Ramka `init` bez `effort` (wpis bez pola albo z `null`) NIE jest zmianą.
    expect(manager.get(created.id)?.effort).toBe('low');

    drivers[0]!.queue.push({
      type: 'init', engineSessionId: 'e1', model: TEST_MODEL, effort: 'xhigh',
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(manager.get(created.id)?.effort).toBe('xhigh');
  });

  it('lista modeli jest wbudowana i zaczyna się od „modelu domyślnego konta"', async () => {
    const { manager } = await build();
    const values = manager.models().models.map((m) => m.value);
    expect(values[0]).toBe('');
    expect(values).toEqual([DEFAULT_MODEL_CHOICE, ...FALLBACK_MODEL_CHOICES].map((m) => m.value));
  });

  /*
   * Pole `ultracode` z listy wbudowanej serwer ogłasza od chwili, w której wykonuje oba gesty: start flagą
   * i zmianę w żywej sesji. Przełącznik dostają te same pozycje co w kontrakcie, bez modelu domyślnego konta.
   */
  it('lista modeli ogłasza ultracode przy pozycjach z listy wbudowanej', async () => {
    const { manager } = await build();
    const withUltracode = manager.models().models.filter((m) => m.ultracode === true).map((m) => m.value);
    expect(withUltracode).toEqual(FALLBACK_MODEL_CHOICES.filter((m) => m.ultracode === true).map((m) => m.value));
    expect(withUltracode).toHaveLength(3);
    expect(manager.models().models[0]).not.toHaveProperty('ultracode');
  });

  it('model spoza listy odpada już przy zakładaniu sesji', async () => {
    const { manager, supervisor } = await build();
    await expect(manager.create({ cwd: PROJECT, prompt: 'x', model: 'gpt-9' }))
      .rejects.toThrow(/isn't in the list of available models/);
    expect(supervisor.launches).toHaveLength(0);
  });

  /*
   * Jeden fable i jeden opus, zawsze najnowsze: lista to same aliasy. Pełny identyfikator poza listą MA znaczyć odmowę
   * uruchomienia, a nie samo zniknięcie wiersza z arkusza — inaczej stary klient (albo zapamiętany wybór z
   * `localStorage`) wysłałby go dalej i przypiął sesję do konkretnej wersji.
   */
  it('do uruchomienia jest alias `fable`, nie pełny identyfikator wersji', async () => {
    const { manager, supervisor } = await build();
    expect(isKnownModel('fable')).toBe(true);
    expect(isKnownModel('claude-fable-5')).toBe(false);
    expect(isKnownModel('claude-fable-5-1')).toBe(false);
    await expect(manager.create({ cwd: PROJECT, prompt: 'x', model: 'claude-fable-5-1' }))
      .rejects.toThrow(/isn't in the list of available models/);
    expect(supervisor.launches).toHaveLength(0);
  });

  it('setModel w środku tury to 409 (`/model` czeka na koniec tury)', async () => {
    const { manager } = await build();
    const created = await newSession(manager, { cwd: PROJECT, prompt: 'x' });
    /*
     * Sesja tuż po `create` z promptem jest w turze. Komenda `/model` wysłana teraz wpadłaby
     * w kolejkę promptów panelu, czyli „nic się nie stało" bez śladu — a użytkownik ma prawo
     * wiedzieć, dlaczego arkusz nic nie zmienił. Pełna ścieżka zmiany modelu (dozwolone stany, guard,
     * throttle, dialog potwierdzenia) ma własny plik: `manager-model-focus.test.ts`.
     */
    await expect(manager.setModel(created.id, { model: 'opus[1m]' }))
      .rejects.toThrow(/when it finishes its turn/);
  });

  // -------------------------------------------------------------------------
  // Bezpieczniki trybu zgód i wielokrotne pending
  // -------------------------------------------------------------------------

  it('bypassPermissions odpada poza RAROG_YOLO_ROOTS i nie zakłada panelu', async () => {
    const YOLO = '/Users/demo/Projects/scratch';
    const { manager, supervisor } = await build({
      projects: [{ path: PROJECT, name: 'willow' }, { path: YOLO, name: 'scratch' }],
      yoloRoots: [YOLO],
      // Ścieżki fixture są zmyślone — bramka yolo liczy po realpath,
      // więc test wstrzykuje tożsamość; produkcja rozwiązuje prawdziwe dowiązania.
      realPath: (p: string) => p,
    });

    await expect(manager.create({
      cwd: PROJECT, prompt: 'bez pytania', permissionMode: 'bypassPermissions',
    })).rejects.toThrow(/RAROG_YOLO_ROOTS/);
    expect(supervisor.launches).toHaveLength(0);

    const created = await newSession(manager, {
      cwd: YOLO, prompt: 'scratchpad', permissionMode: 'bypassPermissions',
    });
    expect(manager.get(created.id)).toBeDefined();
    expect(supervisor.launches[0]).toMatchObject({ permissionMode: 'bypassPermissions' });
  });

  it('brak listy yolo = tryb bypassPermissions jest niedostępny wszędzie', async () => {
    const { manager } = await build();
    await expect(manager.create({
      cwd: PROJECT, prompt: 'scratchpad', permissionMode: 'bypassPermissions',
    })).rejects.toThrow(/RAROG_YOLO_ROOTS/);
  });

  it('tryby z UI (manual/acceptEdits/plan) przechodzą bez listy yolo', async () => {
    const { manager, supervisor } = await build();

    for (const mode of ['manual', 'acceptEdits', 'plan']) {
      await newSession(manager, { cwd: PROJECT, prompt: mode, permissionMode: mode });
    }
    expect(supervisor.launches.map((l) => l.permissionMode))
      .toEqual(['manual', 'acceptEdits', 'plan']);
  });

  it('druga nierozstrzygnięta zgoda trzyma sesję w waiting-permission', async () => {
    const { manager, drivers } = await buildControlled();
    const created = await newSession(manager, { cwd: PROJECT, prompt: 'dwa narzędzia naraz' });
    const driver = drivers[0]!;
    driver.queue.push({ type: 'init', engineSessionId: 'eng-1', model: TEST_MODEL });
    driver.queue.push({
      type: 'permission-request', reqId: 'p1', toolName: 'Bash', input: {}, displayText: 'ls',
    });
    driver.queue.push({
      type: 'permission-request', reqId: 'p2', toolName: 'Bash', input: {}, displayText: 'pwd',
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(manager.transcript(created.id).pendingPermissions).toHaveLength(2);
    expect(manager.get(created.id)?.state).toBe('waiting-permission');

    await expect(manager.resolvePermission(created.id, 'p1', 'allow', 'iphone'))
      .resolves.toEqual({ outcome: 'ok' });
    // Druga zgoda wisi — sesja NADAL czegoś ode mnie chce.
    expect(manager.get(created.id)?.state).toBe('waiting-permission');

    await expect(manager.resolvePermission(created.id, 'p2', 'allow', 'iphone'))
      .resolves.toEqual({ outcome: 'ok' });
    expect(manager.get(created.id)?.state).toBe('running');
  });

  it('to samo dla pytań: ostatnia odpowiedź odblokowuje stan', async () => {
    const { manager, drivers } = await buildControlled();
    const created = await newSession(manager, { cwd: PROJECT, prompt: 'dwa pytania' });
    const driver = drivers[0]!;
    driver.queue.push({ type: 'init', engineSessionId: 'eng-2', model: TEST_MODEL });
    const question = {
      header: '', question: 'Który wariant?', multiSelect: false,
      options: [{ label: 'A' }, { label: 'B' }],
    };
    driver.queue.push({ type: 'question-request', reqId: 'q1', questions: [question] });
    driver.queue.push({ type: 'question-request', reqId: 'q2', questions: [question] });
    await vi.advanceTimersByTimeAsync(1);
    expect(manager.get(created.id)?.state).toBe('waiting-question');

    await expect(manager.answerQuestion(created.id, 'q1', [['A']]))
      .resolves.toEqual({ outcome: 'ok' });
    expect(manager.get(created.id)?.state).toBe('waiting-question');

    await expect(manager.answerQuestion(created.id, 'q2', [['B']]))
      .resolves.toEqual({ outcome: 'ok' });
    expect(manager.get(created.id)?.state).toBe('running');
  });

  // -------------------------------------------------------------------------
  // Powiadomienia — wpięcie w JEDYNE miejsce zmiany stanu
  // -------------------------------------------------------------------------

  describe('powiadomienia', () => {
    /** Atrapa kanału: manager zna cztery czasowniki, więc tyle wystarczy do sprawdzenia wpięcia. */
    const spyNotifier = (): { notifier: NotifierLike; notes: NoteInput[]; seen: string[];
      forgot: string[]; } => {
      const notes: NoteInput[] = [];
      const seen: string[] = [];
      const forgot: string[] = [];
      return {
        notes, seen, forgot,
        notifier: {
          note: (input) => { notes.push(input); },
          seen: (id) => { seen.push(id); },
          forget: (id) => { forgot.push(id); },
          quiet: () => undefined,
        },
      };
    };

    const kinds = (notes: readonly NoteInput[]): string[] => notes.map((n) => n.event.type);

    it('każde przejście stanu dociera do kanału — także ciche', async () => {
      const spy = spyNotifier();
      const { manager } = await build({ notifier: spy.notifier });

      const created = await newSession(manager, { cwd: PROJECT, prompt: 'zrób coś czerwone' });
      await vi.advanceTimersByTimeAsync(500);
      expect(stateOf(manager, created.id)).toBe('waiting-permission');
      expect(kinds(spy.notes)).toContain('permission-requested');

      const request = manager.transcript(created.id).pendingPermissions[0]!;
      await manager.resolvePermission(created.id, request.permId, 'allow', 'iphone');
      /*
       * `permission-resolved` jest CICHE, ale musi dojść: to ono unieważnia czekające
       * powiadomienie o zgodzie, którą człowiek właśnie rozstrzygnął. Kanał, do którego
       * docierają tylko zdarzenia „głośne", dzwoniłby o sprawach już załatwionych.
       */
      expect(kinds(spy.notes)).toContain('permission-resolved');
    });

    it('przejście, które NIE zmienia stanu, nie zawiadamia o niczym', async () => {
      const spy = spyNotifier();
      const { manager } = await build({ notifier: spy.notifier });
      const created = await newSession(manager, { cwd: PROJECT, prompt: 'zrób coś czerwone' });
      await vi.advanceTimersByTimeAsync(500);

      const before = spy.notes.length;
      // Druga decyzja to `conflict` — stan się nie rusza, więc kanał ma milczeć.
      const request = manager.transcript(created.id).pendingPermissions[0]!;
      await manager.resolvePermission(created.id, request.permId, 'allow', 'iphone');
      const after = spy.notes.length;
      await manager.resolvePermission(created.id, request.permId, 'deny', 'ipad');
      expect(spy.notes).toHaveLength(after);
      expect(after).toBeGreaterThan(before);
    });

    /*
     * GRANICA PRYWATNOŚCI. `displayText` to pełna komenda — czyli ten string w całym systemie,
     * który najczęściej niesie sekret. Baner ląduje na ekranie blokady, więc idzie na
     * niego wyłącznie nazwa narzędzia; po szczegóły trzeba wejść do apki.
     */
    it('sprawa blokująca niesie NAZWĘ NARZĘDZIA, nigdy treści komendy', async () => {
      const spy = spyNotifier();
      const { manager } = await build({ notifier: spy.notifier });

      const created = await newSession(manager, { cwd: PROJECT, prompt: 'zrób coś czerwone' });
      await vi.advanceTimersByTimeAsync(500);

      const request = manager.transcript(created.id).pendingPermissions[0]!;
      expect(request.displayText).toContain('git push --force');

      const note = spy.notes.find((n) => n.event.type === 'permission-requested');
      expect(note?.detail?.text).toBe(request.toolName);
      expect(note?.detail?.text).not.toContain('git push --force');
    });

    it('powiadomienie wie, z jakiego projektu pochodzi — iOS grupuje po nim baner', async () => {
      const spy = spyNotifier();
      const { manager } = await build({ notifier: spy.notifier });
      const created = await newSession(manager, { cwd: PROJECT, prompt: 'zrób coś czerwone' });
      await vi.advanceTimersByTimeAsync(500);

      const note = spy.notes.find((n) => n.event.type === 'permission-requested');
      expect(note?.project).toBe('willow');
      expect(note?.sessionId).toBe(created.id);
    });

    it('„obejrzałem" gasi kanał także wtedy, gdy znacznik i tak by nie drgnął', async () => {
      const spy = spyNotifier();
      const { manager } = await build({ notifier: spy.notifier });
      const created = await newSession(manager, { cwd: PROJECT, prompt: 'zrób coś czerwone' });
      await vi.advanceTimersByTimeAsync(500);

      manager.markSeen(created.id);
      manager.markSeen(created.id);
      /*
       * DWA razy, i to jest sedno tego testu: `markSeen` ma wcześniejsze wyjścia (brak panelu
       * herdr, znacznik już postawiony), a powiadomienie musi gasnąć PRZED nimi. Otwarcie
       * sesji jest faktem o człowieku, nie o znaczniku.
       */
      expect(spy.seen).toEqual([created.id, created.id]);
    });

    it('brak kanału jest stanem normalnym — manager działa bez niego', async () => {
      const { manager } = await build();
      const created = await newSession(manager, { cwd: PROJECT, prompt: 'zrób coś czerwone' });
      await vi.advanceTimersByTimeAsync(500);
      expect(stateOf(manager, created.id)).toBe('waiting-permission');
    });

    /*
     * STRAŻNIK TREŚCI BANERA NA RZECZYWISTYCH ŚCIEŻKACH `#note`.
     *
     * Atrapa kanału wyżej sprawdza, co manager PODAJE harmonogramowi; ten test idzie dalej, przez
     * PRAWDZIWY harmonogram (`Notifier`), treść (`buildContent`) i ładunek APNs — czyli dokładnie
     * tę drogę, którą tekst przechodzi na ekran blokady. Sesja ma
     * w sobie wszystkie trzy niebezpieczne stringi naraz: komendę w `displayText`, skrót komendy
     * w `activity.summary` i treść wejścia narzędzia. Żaden nie ma prawa trafić na baner ani do
     * logu harmonogramu; zgoda niesie nazwę narzędzia i etykietę, pytanie — treść pytania, wynik —
     * zdanie podsumowania, błąd — powód.
     */
    describe('strażnik treści banera na rzeczywistych ścieżkach', () => {
      const SECRET_COMMAND = 'export API_KEY=sk-tajny-123 && curl -H "Authorization: Bearer x"';
      const ACTIVITY_SUMMARY = 'uruchamia komendę: export API_KEY=sk-tajny-123';

      async function withRealNotifier(): Promise<{
        manager: Manager; driver: () => ControlledDriver; sent: PushContent[]; logs: string[];
      }> {
        const sent: PushContent[] = [];
        const logs: string[] = [];
        let managerRef: Manager | null = null;
        const notifier = new Notifier({
          presence: new Presence(),
          sink: { send: (content) => { sent.push(content); return Promise.resolve({ channels: { apns: 'delivered' } }); } },
          look: (id) => sessionLook(managerRef?.get(id)),
          log: (line) => { logs.push(line); },
        });
        const { manager, drivers } = await buildControlled({ notifier });
        managerRef = manager;
        return { manager, driver: () => drivers[drivers.length - 1]!, sent, logs };
      }

      /**
       * Ładunek APNs, który dla tej treści wyszedłby z Maca, razem z tekstem jawnym banera v2, który odszyfruje
       * urządzenie — to on ląduje na ekranie blokady.
       */
      const wire = (content: PushContent): string => {
        let plaintext = '';
        const request = apnsAlertRequestE2e(content, {
          topic: 'ai.rarog.app', nowMs: 0, key: { pushKey: '', kid: '00000000' },
          sealer: { seal: (_key, text) => { plaintext = text; return { kid: '00000000', n: '', c: '' }; } },
        });
        return `${request?.body ?? ''}\n${plaintext}`;
      };

      const expectClean = (text: string): void => {
        expect(text).not.toContain('sk-tajny-123');
        expect(text).not.toContain('API_KEY');
        expect(text).not.toContain('Authorization');
        expect(text).not.toContain(ACTIVITY_SUMMARY);
      };

      it('zgoda: nazwa narzędzia i etykieta — nigdy `displayText`, komenda ani `activity.summary`', async () => {
        const h = await withRealNotifier();
        const created = await newSession(h.manager, { cwd: PROJECT, prompt: 'napraw wdrożenie' });
        const driver = h.driver();
        driver.queue.push({ type: 'init', engineSessionId: 'engine-1', model: TEST_MODEL });
        driver.queue.push({ type: 'activity', kind: 'tool', toolName: 'Bash', summary: ACTIVITY_SUMMARY });
        driver.queue.push({
          type: 'permission-request', reqId: 'p1', toolName: 'Bash',
          input: { command: SECRET_COMMAND }, displayText: SECRET_COMMAND,
        });
        await vi.advanceTimersByTimeAsync(5_000);

        expect(stateOf(h.manager, created.id)).toBe('waiting-permission');
        const label = h.manager.get(created.id)?.label;
        expect(label).toBeDefined();
        const banner = h.sent.find((c) => c.kind === 'permission');
        expect(banner?.body).toBe(`Bash — ${label ?? ''}`);
        expectClean(h.sent.map(wire).join('\n'));
        expectClean(h.logs.join('\n'));
      });

      it('pytanie niesie treść pytania; wynik — zdanie podsumowania; log nie niesie żadnego', async () => {
        const h = await withRealNotifier();
        await newSession(h.manager, { cwd: PROJECT, prompt: 'zaplanuj zapis' });
        const driver = h.driver();
        driver.queue.push({ type: 'init', engineSessionId: 'engine-1', model: TEST_MODEL });
        driver.queue.push({ type: 'activity', kind: 'tool', toolName: 'Bash', summary: ACTIVITY_SUMMARY });
        driver.queue.push({
          type: 'question-request', reqId: 'q1',
          questions: [{ question: 'Czy zapisać rejestr atomowo?', header: 'Zapis', multiSelect: false, options: [
            { label: 'Tak', description: 'rename' }, { label: 'Nie', description: 'wprost' },
          ] }],
        });
        await vi.advanceTimersByTimeAsync(5_000);
        const question = h.sent.find((c) => c.kind === 'question');
        expect(question?.body).toBe('Czy zapisać rejestr atomowo?');

        await h.manager.answerQuestion(h.manager.list()[0]!.id, 'q1', [['Tak']]);
        driver.queue.push({ type: 'activity', kind: 'tool', toolName: 'Bash', summary: ACTIVITY_SUMMARY });
        driver.queue.push({ type: 'result', subtype: 'success', summary: 'Rejestr zapisany, testy zielone.' });
        await vi.advanceTimersByTimeAsync(20_000);
        const done = h.sent.find((c) => c.kind === 'done');
        expect(done?.body).toBe('Rejestr zapisany, testy zielone.');

        expectClean(h.sent.map(wire).join('\n'));
        const logs = h.logs.join('\n');
        expectClean(logs);
        expect(logs).not.toContain('Czy zapisać rejestr atomowo?');
        expect(logs).not.toContain('Rejestr zapisany');
        expect(h.logs).toContain('push: question for willow — APNs: SENT');
      });

      it('pytanie zapasowe karty z ekranu jedzie do banera z własnym kodem, nie jako tekst agenta', async () => {
        const h = await withRealNotifier();
        await newSession(h.manager, { cwd: PROJECT, prompt: 'pytanie bez treści' });
        const driver = h.driver();
        const card = screenQuestionCard({
          kind: 'question', header: 'Wybór', question: '', options: [{ label: 'A', digit: '1' }, { label: 'B', digit: '2' }],
          dialogIdentity: { kind: 'none' },
        } as unknown as Parameters<typeof screenQuestionCard>[0], 1);
        driver.queue.push({ type: 'init', engineSessionId: 'engine-q', model: TEST_MODEL });
        driver.queue.push(card.event);
        await vi.advanceTimersByTimeAsync(5_000);
        const question = h.sent.find((c) => c.kind === 'question');
        expect(question?.body).toBe('The agent asked a question in the terminal.');
        expect(question?.bodyRef).toEqual({ code: 'dialogs.fallback-question.question' });
      });

      it('błąd niesie powód z drivera, nie komendę z aktywności', async () => {
        const h = await withRealNotifier();
        await newSession(h.manager, { cwd: PROJECT, prompt: 'uruchom' });
        const driver = h.driver();
        driver.queue.push({ type: 'init', engineSessionId: 'engine-1', model: TEST_MODEL });
        driver.queue.push({ type: 'activity', kind: 'tool', toolName: 'Bash', summary: ACTIVITY_SUMMARY });
        driver.queue.push({ type: 'result', subtype: 'error' });
        await vi.advanceTimersByTimeAsync(5_000);
        const error = h.sent.find((c) => c.kind === 'error');
        expect(error).toBeDefined();
        expectClean(h.sent.map(wire).join('\n'));
        expectClean(h.logs.join('\n'));
      });

      /*
       * Limit planu: prawdziwe zdarzenie `limit-reached` → harmonogram → tekst jawny banera po odszyfrowaniu.
       * Treść to zdanie `state.limit-reached`, a `bodyRef` niesie chwilę resetu, z której apka składa godzinę; token
       * `resetAt=<ISO>` zostaje wyłącznie na drucie stanu.
       */
      it('limit: tekst jawny banera niesie zdanie `state.limit-reached` z `bodyRef`, nie token `resetAt=`', async () => {
        const reset = '2026-11-12T10:00:00.000Z';
        const h = await withRealNotifier();
        await newSession(h.manager, { cwd: PROJECT, prompt: 'limit planu' });
        const driver = h.driver();
        driver.queue.push({ type: 'init', engineSessionId: 'engine-1', model: TEST_MODEL });
        driver.queue.push({ type: 'limit-reached', resetAt: reset });
        await vi.advanceTimersByTimeAsync(20_000);
        const limit = h.sent.find((c) => c.kind === 'limit');
        expect(limit).toBeDefined();
        const key = { pushKey: Buffer.alloc(32, 5).toString('base64url'), kid: 'f849d673' };
        const request = apnsAlertRequestE2e(limit!, { topic: 'ai.rarog.app', nowMs: 0, key, sealer: createPushSealer() });
        const { rarog } = JSON.parse(request?.body ?? '{}') as { rarog: { kid: string; n: string; c: string } };
        const bannerKey = Buffer.from(hkdfSync(
          'sha256', Buffer.from(key.pushKey, 'base64url'), Buffer.alloc(0), Buffer.from(PUSH_KEY_INFO_V3), 32,
        ));
        const sealed = Buffer.from(rarog.c, 'base64url');
        const data = sealed.subarray(0, sealed.length - 16);
        const decipher = createDecipheriv('chacha20-poly1305', bannerKey, Buffer.from(rarog.n, 'base64url'), { authTagLength: 16 });
        decipher.setAAD(Buffer.from(`${PUSH_AAD_PREFIX_V3}${rarog.kid}`, 'utf8'), { plaintextLength: data.length });
        decipher.setAuthTag(sealed.subarray(sealed.length - 16));
        const plain = JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')) as unknown;
        expect(plain).toMatchObject({
          kind: 'limit', body: `Plan limit reached. Try again after ${reset}.`,
          bodyRef: { code: 'state.limit-reached', args: [reset] }, titleRef: { code: 'push.title.limit' },
        });
        expect(JSON.stringify(plain)).not.toContain('resetAt=');
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Demo mode
// ---------------------------------------------------------------------------

describe('manager — seedy demo', () => {
  let dataDir: string;
  let manager: Manager;

  beforeEach(async () => {
    vi.useFakeTimers();
    dataDir = await mkdtemp(join(tmpdir(), 'rarog-demo-test-'));
    // Bez gniazda, bez `RAROG_HERDR_SOCKET` i bez `~/.claude`: demo dostaje MOCK NADZORCY.
    manager = await createManager({ demo: true, demoContent: demoContentPl, dataDir });
    await manager.ready;
  });

  afterEach(async () => {
    await manager.dispose();
    vi.useRealTimers();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('zakłada 8 sesji o stanach ze speca', () => {
    const byId = new Map(manager.list().map((session) => [session.id, session]));
    expect(byId.size).toBe(8);

    expect(byId.get('demo-willow')?.state).toBe('waiting-permission');
    expect(byId.get('demo-rarog')?.state).toBe('running');
    expect(byId.get('demo-fleet-ops')?.state).toBe('waiting-permission');
    expect(byId.get('demo-data-loader')).toMatchObject({
      state: 'done',
      lastSummary: 'Zaimportowano 214 rekordów, testy zielone.',
    });
    expect(byId.get('demo-pipe-link')).toMatchObject({
      state: 'resumable',
      stateDetail: 'interrupted — backend restarted',
      stateDetailRef: { code: 'demo.seed-backend-restarted' },
    });
    expect(byId.get('demo-map-view')?.state).toBe('limit-reached');
    expect(byId.get('demo-rarog-stop')?.state).toBe('running');
  });

  it('karty zgody seedów z komendą powłoki niosą `inputKind: shell` (kolor w apce)', () => {
    for (const id of ['demo-willow', 'demo-fleet-ops']) {
      const [request] = manager.transcript(id).pendingPermissions;
      expect(request, id).toMatchObject({ toolName: 'Bash', inputKind: 'shell' });
    }
  });

  it('demo: tura do przerwania stoi bez strumienia, a przerwanie przestawia ją od razu (2F apki)', async () => {
    await vi.advanceTimersByTimeAsync(5_000);
    expect(manager.get('demo-rarog-stop')?.state).toBe('running');
    expect(await manager.interrupt('demo-rarog-stop')).toBe(true);
    expect(manager.get('demo-rarog-stop')?.state).toBe('waiting-input');
  });

  it('seedy niosą różne modele i efforty (pigułka w composerze ma co pokazywać)', () => {
    const sessions = manager.list();
    const models = new Set(sessions.map((session) => session.model));
    expect(models.size).toBeGreaterThan(2);
    expect(models.has(undefined)).toBe(false);
    // „auto" (brak effortu) też musi być w demo widoczne.
    expect(sessions.some((session) => session.effort === undefined)).toBe(true);
    expect(new Set(sessions.map((session) => session.effort)).size).toBeGreaterThan(2);
  });

  it('ultracode w demo: jedno ziarno z xhigh je ma, reszta bez pola', () => {
    const sessions = manager.list();
    expect(sessions.filter((session) => session.ultracode !== undefined).map((session) => session.id))
      .toEqual(['demo-rarog']);
    expect(manager.get('demo-rarog')).toMatchObject({ effort: 'xhigh', ultracode: true });
  });

  it('start z ultracode w demo: bramka wersji jawnie pominięta (demo nie ma czytnika wersji)', async () => {
    const created = await manager.create({ cwd: '/Users/demo/Projects/rarog', ultracode: true });
    expect(manager.get(created.sessionId)).toMatchObject({ effort: 'xhigh', ultracode: true });
  });

  it('demo oddaje wbudowaną listę modeli (innej nie ma)', () => {
    expect(manager.models().models.map((m) => m.value))
      .toEqual([DEFAULT_MODEL_CHOICE, ...FALLBACK_MODEL_CHOICES].map((m) => m.value));
    // Ultracode demo ogłasza tak samo jak tryb realny: XCUITest i serwer demo pokazują przełącznik.
    expect(manager.models().models).toEqual([DEFAULT_MODEL_CHOICE, ...FALLBACK_MODEL_CHOICES]);
  });

  it('map-view: limit planu z resetem za ~2 h (UI ma z czego zrobić godzinę)', () => {
    const session = manager.get('demo-map-view')!;
    const resetAt = /resetAt=(\S+)/.exec(session.stateDetail ?? '')?.[1];
    expect(resetAt).toBeDefined();
    const inMs = Date.parse(resetAt!) - Date.now();
    expect(inMs).toBeGreaterThan(115 * 60_000);
    expect(inMs).toBeLessThanOrEqual(120 * 60_000);
  });

  it('wiersz gita seedów ma ahead/behind ze speca (willow 2/0, rarog 0/1)', () => {
    expect(manager.get('demo-willow')).toMatchObject({
      branch: 'main', dirtyCount: 2, ahead: 2, behind: 0,
    });
    expect(manager.get('demo-rarog')).toMatchObject({
      branch: 'main', dirtyCount: 3, ahead: 0, behind: 1,
    });
    // Reszta seedów nie ma upstreamu — pola po prostu nie istnieją.
    const inne = manager.get('demo-pipe-link')!;
    expect(inne.branch).toBe('feat/bridge');
    expect('ahead' in inne).toBe(false);
  });

  it('dwie sesje czekają na człowieka (pas uwagi pokazuje 2)', () => {
    const waiting = manager.list().filter((session) => session.state === 'waiting-permission');
    expect(waiting).toHaveLength(2);
  });

  it('willow: transkrypt i karta zgody czekająca od ~4 minut', () => {
    const transcript = manager.transcript('demo-willow');
    expect(transcript.messages).toHaveLength(4);
    expect(transcript.messages[0]?.role).toBe('user');
    expect(transcript.messages.at(-1)?.blocks[0]).toMatchObject({
      type: 'tool-call', toolName: 'Edit', summary: 'src/notes.ts',
    });

    const [permission] = transcript.pendingPermissions;
    expect(permission).toMatchObject({ toolName: 'Bash', risk: 'normal' });
    expect(permission?.displayText).toBe('npm test -- --run src/notes.test.ts');
    // Seedy demo nadają pola semantyczne tą samą drogą co produkcja.
    expect(permission?.subject).toBe('tool');
    expect(transcript.messages.at(-1)?.blocks[0]).toMatchObject({ inputKind: 'json' });
    expect(transcript.messages.at(-1)?.blocks[0]).not.toHaveProperty('delegation');

    const session = manager.get('demo-willow')!;
    const waitingMs = Date.now() - Date.parse(session.stateSince);
    expect(waitingMs).toBeGreaterThanOrEqual(4 * 60_000);
    expect(waitingMs).toBeLessThan(5 * 60_000);
  });

  it('fleet-ops: zgoda sklasyfikowana jako czerwona', () => {
    const [permission] = manager.transcript('demo-fleet-ops').pendingPermissions;
    expect(permission?.risk).toBe('red');
    expect(permission?.displayText).toBe('rm -rf ./dist && git push --force origin main');
  });

  it('rarog: streamuje delty bez końca', async () => {
    const events: ServerEvent[] = [];
    manager.onEvent((_scope, _seq, event) => { events.push(event); });

    await vi.advanceTimersByTimeAsync(20_000);

    const deltas = events.filter((e) => e.type === 'delta' && e.sessionId === 'demo-rarog');
    expect(deltas.length).toBeGreaterThan(10);
    // Po ~15 s otwarta wiadomość zostaje domknięta i zaczyna się następna.
    expect(events.some((e) => e.type === 'message' && e.sessionId === 'demo-rarog')).toBe(true);
    expect(manager.get('demo-rarog')?.state).toBe('running');
  });

  it('zgoda w sesji seeda prowadzi turę dalej (allow → tool-call → result)', async () => {
    const permission = manager.transcript('demo-willow').pendingPermissions[0]!;
    await expect(manager.resolvePermission('demo-willow', permission.permId, 'allow', 'demo'))
      .resolves.toEqual({ outcome: 'ok' });
    expect(manager.get('demo-willow')?.state).toBe('running');

    await vi.advanceTimersByTimeAsync(10_000);
    expect(manager.get('demo-willow')?.state).toBe('waiting-input');
    expect(manager.transcript('demo-willow').messages.length).toBeGreaterThan(4);
    // Tool-call mock-drivera niesie rodzaj inputu policzony wspólną regułą.
    const toolCall = manager.transcript('demo-willow').messages
      .flatMap((message) => message.blocks).filter((block) => block.type === 'tool-call').at(-1);
    expect(toolCall).toMatchObject({ toolName: 'Edit', inputKind: 'json' });
  });

  it('lista projektów demo nie dotyka prawdziwego ~/Projects', () => {
    const projects = manager.projects();
    expect(projects).toHaveLength(6);
    for (const project of projects) expect(project.path.startsWith('/Users/demo/')).toBe(true);
  });

  it('demo: 4 fake sesje do wznowienia, bez czytania ~/.claude; najnowsza żyje w karcie', async () => {
    const cwd = '/Users/demo/Projects/willow';
    const sessions = await manager.resumable(cwd);

    expect(sessions).toHaveLength(4);
    // Wiersz „otwarta” z „Rozwidl” musi być w demie, inaczej bramka iOS go nie zobaczy.
    expect(sessions[0]).toMatchObject({ liveInHerdr: true, sessionId: 'demo-willow' });
    expect(sessions.slice(1).every((s) => !s.liveInHerdr && s.sessionId === undefined)).toBe(true);
    for (const session of sessions) {
      expect(session.cwd).toBe(cwd);
      expect(session.engineSessionId).toMatch(/^demo-engine-willow-/);
      expect(session.firstPrompt.length).toBeLessThanOrEqual(MAX_FIRST_PROMPT_LENGTH);
      expect(Number.isNaN(Date.parse(session.mtime))).toBe(false);
    }
    // Od najnowszej do najstarszej — tak samo jak realny magazyn.
    const czasy = sessions.map((s) => Date.parse(s.mtime));
    expect(czasy[0]).toBeGreaterThan(czasy[1]!);
    expect(czasy[1]).toBeGreaterThan(czasy[2]!);
    expect(czasy[2]).toBeGreaterThan(czasy[3]!);
  });

  it('demo: resumable dla katalogu spoza allow-listy jest odrzucone', async () => {
    await expect(manager.resumable('/etc')).rejects.toThrow(/isn't on the list of allowed projects/);
  });

  it('demo: usage i licznik linii lecą z mock-drivera po turze', async () => {
    const events: ServerEvent[] = [];
    manager.onEvent((_scope, _seq, event) => { events.push(event); });

    const permission = manager.transcript('demo-willow').pendingPermissions[0]!;
    manager.resolvePermission('demo-willow', permission.permId, 'allow', 'demo');
    await vi.advanceTimersByTimeAsync(10_000);

    // W demo limit okna jest ZNANY (mock sam go wymyślił), więc pasek ma prawo się pojawić.
    const usage = manager.get('demo-willow')?.usage;
    expect(usage?.contextLimit).toBe(200_000);
    expect(usage?.contextTokens).toBeGreaterThan(0);
    expect(manager.get('demo-willow')?.context).toMatchObject({ kind: 'known' });
    expect(events.some((e) => e.type === 'usage' && e.sessionId === 'demo-willow')).toBe(true);

    const git = events.filter((e) => e.type === 'git-status').at(-1);
    expect(git).toMatchObject({
      fileKinds: {
        added: expect.any(Number), modified: expect.any(Number), deleted: expect.any(Number),
      },
    });
    const kinds = manager.get('demo-willow')?.fileKinds;
    // Suma trójki jest w demo tym samym, co licznik brudnych plików — jak w parserze.
    expect((kinds?.added ?? 0) + (kinds?.modified ?? 0) + (kinds?.deleted ?? 0))
      .toBe(manager.get('demo-willow')?.dirtyCount);
  });

  it('drugi start na tym samym dataDir daje te same 8 sesji (bez rejestru, bez duplikatów)',
    async () => {
      await manager.flush();
      const again = await createManager({ demo: true, demoContent: demoContentPl, dataDir });
      await again.ready;
      try {
        /*
         * Rejestru nie ma, więc seedy powstają od nowa przy każdym starcie — i to jest
         * poprawne: w produkcji listę sesji odtwarza `agent.list`, a nie plik sprzed restartu.
         */
        expect(again.list()).toHaveLength(8);
        expect(again.get('demo-rarog')?.state).toBe('running');
      } finally {
        await again.dispose();
      }
    });
});

// ---------------------------------------------------------------------------
// Etykieta sesji, git pull/push, diff
// ---------------------------------------------------------------------------

describe('etykieta sesji (człon `sesja` w tytule)', () => {
  const PROJECT_B = '/Users/demo/Projects/rarog';
  let dataDir: string;
  const managers: Manager[] = [];
  const supervisors: TestSupervisor[] = [];

  beforeEach(async () => {
    vi.useFakeTimers();
    dataDir = await mkdtemp(join(tmpdir(), 'rarog-label-test-'));
  });

  afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.dispose();
    for (const supervisor of supervisors.splice(0)) supervisor.dispose();
    vi.useRealTimers();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function build(): Promise<Manager> {
    const factory = createMockDriverFactory({ content: demoContentPl });
    const supervisor = new TestSupervisor((cwd) => factory.startScenario({ kind: 'idle' }, { cwd }));
    supervisors.push(supervisor);
    const manager = await createManager({
      demo: false,
      dataDir,
      projects: [{ path: PROJECT, name: 'willow' }, { path: PROJECT_B, name: 'rarog' }],
      projectRoots: [],
      gitStatus: null,
      herdrSupervisor: supervisor,
      herdrDeps: testDeps(),
      herdrRoots: [PROJECT, PROJECT_B],
      herdrSend: true,
      launchThrottle: { minIntervalMs: 0 },
    });
    managers.push(manager);
    await manager.ready;
    return manager;
  }

  /** Zakłada sesję i oddaje jej kartę (202 + domknięcie startu panelu). */
  async function make(manager: Manager, cwd: string, prompt?: string): Promise<string> {
    const created = await manager.create(prompt === undefined ? { cwd } : { cwd, prompt });
    await vi.advanceTimersByTimeAsync(0);
    return created.sessionId;
  }

  it('bierze pierwsze słowa promptu i mieści się w 28 znakach', async () => {
    const manager = await build();
    const id = await make(
      manager, PROJECT, 'Popraw zapis notatek po restarcie i dopisz test regresji.',
    );

    const label = manager.get(id)?.label;
    expect(label).toBeDefined();
    expect(label!.length).toBeLessThanOrEqual(MAX_LABEL_LENGTH);
    expect(label!.startsWith('Popraw zapis notatek')).toBe(true);
    // `title` to nadal projekt — label go nie zastępuje.
    expect(manager.get(id)?.title).toBe('willow');
  });

  it('nie tnie w środku słowa; jednosłowny gigant dostaje wielokropek', () => {
    // Pięć słów mieści się w limicie — szóste („managera") już nie wchodzi.
    expect(labelFromPrompt('Zrób refaktor modułu sesji i managera'))
      .toBe('Zrób refaktor modułu sesji i');
    // Tu piąte słowo przekroczyłoby 28 znaków, więc odpada CAŁE.
    expect(labelFromPrompt('Zrób refaktor modułu sesji oraz managera'))
      .toBe('Zrób refaktor modułu sesji');
    expect(labelFromPrompt('   ')).toBeNull();
    expect(labelFromPrompt('a\n\nb   c')).toBe('a b c');
    const long = labelFromPrompt('x'.repeat(60));
    expect(long).toHaveLength(MAX_LABEL_LENGTH);
    expect(long!.endsWith('…')).toBe(true);
  });

  it('pusty prompt → `session N`, a ukrycie środkowej NIE przenumerowuje reszty', async () => {
    const manager = await build();

    const first = await make(manager, PROJECT);
    const second = await make(manager, PROJECT);
    const third = await make(manager, PROJECT);
    expect([first, second, third].map((id) => manager.get(id)?.label))
      .toEqual(['session 1', 'session 2', 'session 3']);

    await manager.close(second);

    const fourth = await make(manager, PROJECT);
    expect(manager.get(fourth)?.label).toBe('session 4');
  });

  it('numeracja jest per projekt', async () => {
    const manager = await build();

    await make(manager, PROJECT);
    await make(manager, PROJECT);
    const other = await make(manager, PROJECT_B);

    expect(manager.get(other)?.label).toBe('session 1');
  });

  it('pierwsza wiadomość w pustej sesji przejmuje etykietę; kolejne już nie', async () => {
    const manager = await build();
    const id = await make(manager, PROJECT);
    expect(manager.get(id)?.label).toBe('session 1');

    await manager.sendMessage(id, 'Napraw eksport CSV w panelu klienta');
    expect(manager.get(id)?.label).toBe('Napraw eksport CSV w panelu');

    await vi.advanceTimersByTimeAsync(20_000);
    await manager.sendMessage(id, 'A teraz zupełnie coś innego');
    expect(manager.get(id)?.label).toBe('Napraw eksport CSV w panelu');
  });

  it('sesja z promptem NIE zmienia etykiety po kolejnej wiadomości', async () => {
    const manager = await build();
    const id = await make(manager, PROJECT, 'Przejrzyj testy managera');
    await vi.advanceTimersByTimeAsync(20_000);

    await manager.sendMessage(id, 'Zmień temat na coś innego');
    expect(manager.get(id)?.label).toBe('Przejrzyj testy managera');
  });
});

describe('diff sesji', () => {
  let dataDir: string;
  const managers: Manager[] = [];
  const supervisors: TestSupervisor[] = [];

  beforeEach(async () => {
    vi.useFakeTimers();
    dataDir = await mkdtemp(join(tmpdir(), 'rarog-diff-test-'));
  });

  afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.dispose();
    for (const supervisor of supervisors.splice(0)) supervisor.dispose();
    vi.useRealTimers();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('pyta gita w katalogu SESJI i zwraca kontraktowy kształt', async () => {
    const seen: { args: readonly string[]; cwd: string }[] = [];
    const factory = createMockDriverFactory({ content: demoContentPl });
    const supervisor = new TestSupervisor((cwd) => factory.startScenario({ kind: 'idle' }, { cwd }));
    supervisors.push(supervisor);
    const manager = await createManager({
      demo: false,
      dataDir,
      projects: [{ path: PROJECT, name: 'willow' }],
      projectRoots: [],
      gitStatus: null,
      herdrSupervisor: supervisor,
      herdrDeps: testDeps(),
      herdrRoots: [PROJECT],
      herdrSend: true,
      diffRunner: (command, cwd) => {
        seen.push({ args: [command.sub, ...command.rest], cwd });
        // Nieśledzonych brak — gałąź `ls-files` dostaje pustą listę.
        if (command.sub === 'ls-files') return Promise.resolve({ ok: true, stdout: '' });
        if (command.rest.includes('--numstat')) {
          return Promise.resolve({ ok: true, stdout: '3\t1\tsrc/notes.ts\n' });
        }
        if (command.rest.includes('--name-status')) {
          return Promise.resolve({ ok: true, stdout: 'M\tsrc/notes.ts\n' });
        }
        return Promise.resolve({ ok: true, stdout: 'diff --git a/src/notes.ts\n' });
      },
    });
    managers.push(manager);
    await manager.ready;

    const created = await manager.create({ cwd: PROJECT, prompt: 'coś' });
    await vi.advanceTimersByTimeAsync(0);
    const diff = await manager.diff(created.sessionId);

    expect(diff.files).toEqual([
      { path: 'src/notes.ts', status: 'M', linesAdded: 3, linesDeleted: 1 },
    ]);
    expect(diff.truncated).toBe(false);
    expect(seen.every((call) => call.cwd === PROJECT)).toBe(true);
  });

  it('nieznana sesja to NotFound', async () => {
    const supervisor = new TestSupervisor(() => new ControlledDriver());
    supervisors.push(supervisor);
    const manager = await createManager({
      demo: false, dataDir, projects: [], projectRoots: [], gitStatus: null,
      herdrSupervisor: supervisor, herdrDeps: testDeps(),
    });
    managers.push(manager);
    await manager.ready;

    await expect(manager.diff('nie-ma')).rejects.toThrow(/That session doesn't exist/);
    // Trasy per plik mają tę samą bramkę: brak sesji przed walidacją ścieżki.
    await expect(manager.diffFiles('nie-ma')).rejects.toBeInstanceOf(NotFoundError);
    await expect(manager.diffFile('nie-ma', 'a.ts')).rejects.toBeInstanceOf(NotFoundError);
    await expect(manager.diffFile('nie-ma', '../x')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('demo — git bez ani jednego procesu potomnego', () => {
  let dataDir: string;
  let manager: Manager;

  beforeEach(async () => {
    vi.useFakeTimers();
    dataDir = await mkdtemp(join(tmpdir(), 'rarog-demo-git-'));
    manager = await createManager({ demo: true, demoContent: demoContentPl, dataDir });
    await manager.ready;
  });

  afterEach(async () => {
    await manager.dispose();
    vi.useRealTimers();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('diff zwraca realistyczny mock 3 plików', async () => {
    const diff = await manager.diff('demo-willow');

    // Trzy litery, trzy segmenty nagłówka — tabela wspólna z `git-status` mocka (`fileDetails`).
    expect(diff.files.map((f) => f.status)).toEqual(['M', 'A', 'D']);
    expect(diff.files.map((f) => f.path)).toEqual([
      'src/notes.ts', 'src/notes.test.ts', 'src/notes-legacy.ts',
    ]);
    expect(diff.patch).toContain('diff --git a/src/notes.ts b/src/notes.ts');
    expect(diff.truncated).toBe(false);
  });

  /*
   * Liczby listy i patch tego samego diffu nie mogą sobie przeczyć: panel „zmiany w katalogu"
   * rysuje `+a −b` z `fileDetails` mocka, a „Pokaż diff" ten patch.
   */
  it('liczniki `demoDiff` zgadzają się z patchem, a `git-status` mocka niesie te same pliki', async () => {
    const diff = await manager.diff('demo-willow');
    for (const file of diff.files) {
      const start = diff.patch.indexOf(`diff --git a/${file.path} `);
      expect(start, file.path).toBeGreaterThan(-1);
      const next = diff.patch.indexOf('\ndiff --git ', start + 1);
      const body = diff.patch.slice(start, next === -1 ? undefined : next).split('\n')
        .filter((line) => !line.startsWith('+++') && !line.startsWith('---'));
      expect(body.filter((line) => line.startsWith('+')).length, file.path).toBe(file.linesAdded);
      expect(body.filter((line) => line.startsWith('-')).length, file.path).toBe(file.linesDeleted);
    }
    expect(demoGitStatus('/Users/demo/Projects/willow', diff.files.length).fileDetails).toEqual(
      diff.files.map((file) => ({
        path: file.path,
        kind: ({ A: 'added', M: 'modified', D: 'deleted' } as const)[file.status],
        linesAdded: file.linesAdded,
        linesDeleted: file.linesDeleted,
      })),
    );
  });

  /*
   * Diff per plik w demo: lista to te same trzy pliki co `demoDiff`, a patch pliku to jego
   * blok z tego samego mocka — okno z nagłówkami nie może przeczyć panelowi ani starej trasie.
   */
  it('lista zmian demo i patch każdego pliku zgadzają się z `demoDiff`', async () => {
    const whole = await manager.diff('demo-willow');
    const list = await manager.diffFiles('demo-willow');
    expect(list).toEqual({ files: whole.files, truncated: false });

    let joined = '';
    for (const entry of list.files) {
      const file = await manager.diffFile('demo-willow', entry.path);
      expect(file.path).toBe(entry.path);
      expect(file.truncated).toBe(false);
      // Jeden blok tego pliku, z licznikami z listy.
      expect(file.patch.startsWith(`diff --git a/${entry.path} b/${entry.path}\n`), entry.path).toBe(true);
      expect(file.patch.match(/^diff --git /gm), entry.path).toHaveLength(1);
      const body = file.patch.split('\n').filter((line) => !line.startsWith('+++') && !line.startsWith('---'));
      expect(body.filter((line) => line.startsWith('+')).length, entry.path).toBe(entry.linesAdded);
      expect(body.filter((line) => line.startsWith('-')).length, entry.path).toBe(entry.linesDeleted);
      joined += file.patch;
    }
    // Bloki plików złożone z powrotem to patch starej trasy bez pustych linii między blokami.
    expect(joined).toBe(whole.patch.replace(/\n\n/g, '\n'));
  });

  it('demo odmawia jak produkcja: nieznana ścieżka to 404, zła to 400', async () => {
    await expect(manager.diffFile('demo-willow', 'src/nie-ma.ts')).rejects.toMatchObject({
      code: 'diff-file-not-found',
    });
    await expect(manager.diffFile('demo-willow', 'src/notes')).rejects.toMatchObject({
      code: 'diff-file-not-found',
    });
    for (const bad of ['../x', '/etc/hosts', 'src/', '']) {
      await expect(manager.diffFile('demo-willow', bad), bad).rejects.toMatchObject({ code: 'bad-path' });
    }
  });

  it('seedy mają etykiety, a projekt willow ma dwie sesje (pigułki sióstr)', () => {
    const willow = manager.list().filter((s) => s.cwd.endsWith('/willow'));
    expect(willow).toHaveLength(2);
    expect(willow.every((s) => (s.label ?? '') !== '')).toBe(true);
    expect(manager.list().every((s) => (s.label ?? '') !== '')).toBe(true);
  });
});
