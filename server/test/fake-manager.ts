/**
 * Atrapa ManagerApi dla testów routera i SSE.
 *
 * Nie jest to plik testowy (nie pasuje do wzorca `*.test.ts`) — to wspólny helper.
 * Celowo bez żadnej logiki sesji: sterujemy nią wprost z testów, żeby testy warstwy HTTP
 * nie zależały od implementacji managera.
 */
import {
  DEFAULT_MODEL_CHOICE, FALLBACK_MODEL_CHOICES, MODEL_CHANGE_WARNING, ULTRACODE_CHANGE_NOTE,
} from '@rarog/shared';
import type {
  Activity,
  CommandList,
  CreateSessionResponse,
  DiffFileList,
  DiffFilePatch,
  EffortLevel,
  FileAttachment,
  HerdrStatus,
  ModelList,
  PermissionRequest,
  QuestionRequest,
  RecentProject, ResumableSession,
  ServerEvent,
  SessionDiff,
  ModeCycleTarget, SessionModeResponse, SessionModelResponse,
  SessionSummary,
  TranscriptMessage,
} from '@rarog/shared';
import type { QueueTakeBackResponse } from '@rarog/shared/rest';
import type { CompanionEntry } from '../src/companion/catalog.ts';
import { NOT_FOUND } from '../src/files/refusals.ts';
import type { FileDownloadAnswer } from '../src/files/session-download.ts';
import { demoFileEntries } from '../src/demo/files.ts';
import type { FileListingAnswer, SessionFilesPort } from '../src/files/session-files.ts';
import type {
  CreateSessionOptions, ManagerApi, RestartOptions, SendMessageAck, SendMessageOptions,
} from '../src/sessions/manager-api.ts';
import type { ResolveOutcome, ResolveResult } from '../src/permissions.ts';
import { Session } from '../src/sessions/session.ts';
import { type ForeignText, foreign } from '@rarog/shared/sentences';

/** Skrót zapisu w testach: sam kod wyniku albo pełny wynik z powodem odmowy. */
function asResolveResult(value: ResolveOutcome | ResolveResult | undefined): ResolveResult {
  if (value === undefined) return { outcome: 'gone' };
  return typeof value === 'string' ? { outcome: value } : value;
}

/**
 * Baza wyjątków atrapy. Testy podają napis (wygoda), a router czyta tylko `sentence` (`errorBodyOf`), więc
 * atrapa niesie go jako tekst obcy (`foreign()`) z tym samym tekstem co `message`: na drut idzie sam tekst, bez
 * `messageRef`.
 */
class FakeManagerError extends Error {
  readonly sentence: ForeignText;

  constructor(message: string) {
    super(message);
    this.sentence = foreign(message);
  }
}

/** Wyjątek rozpoznawany przez router jako 404. */
export class NotFoundError extends FakeManagerError {
  readonly code = 'not-found';
  override readonly name = 'NotFoundError';
}

/** Wyjątek rozpoznawany przez router jako 409. */
export class BadStateError extends FakeManagerError {
  readonly code = 'bad-state';
  override readonly name = 'BadStateError';
}

/** Wyjątek rozpoznawany przez router jako 400 (żądanie odrzucone przed dotknięciem stanu). */
export class BadRequestError extends FakeManagerError {
  readonly code = 'bad-request';
  override readonly name = 'BadRequestError';
}

/** Wyjątek rozpoznawany przez router jako 429 (throttle wysyłki do panelu herdr). */
export class TooManyRequestsError extends FakeManagerError {
  readonly code = 'too-many-requests';
  override readonly name = 'TooManyRequestsError';
}

/** Wyjątek rozpoznawany przez router jako 410 (sesja zamknięta). */
export class GoneError extends FakeManagerError {
  readonly code = 'gone';
  override readonly name = 'GoneError';
}

export interface EventsSinceResult {
  tooOld: boolean;
  events: { seq: number | null; event: ServerEvent }[];
}

export function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  const at = '2026-08-21T10:00:00.000Z';
  return {
    id: 'sess-1',
    cwd: '/tmp/rarog-demo/willow',
    title: 'willow',
    state: 'running',
    stateSince: at,
    createdAt: at,
    lastActivityAt: at,
    // Domyślnie sesja BEZ panelu (własny proces silnika) — testy sesji panelowej podają
    // `paneId` jawnie (`makeSummary({ paneId: 'w9:p72', … })`), bo to one opisują ten wariant.
    ...overrides,
  };
}

export class FakeManager implements ManagerApi {
  readonly sessions = new Map<string, SessionSummary>();
  readonly allowedProjects: { path: string; name: string }[] = [
    { path: '/tmp/rarog-demo/willow', name: 'willow' },
    { path: '/tmp/rarog-demo/rarog', name: 'rarog' },
  ];

  /** Zapisane wywołania — asercje w testach. */
  readonly calls: { method: string; args: unknown[] }[] = [];

  /** Wynik `eventsSince` sterowany z testu. */
  eventsSinceResult: EventsSinceResult = { tooOld: false, events: [] };

  transcriptResult: {
    messages: TranscriptMessage[];
    pendingPermissions: PermissionRequest[];
    pendingQuestions: QuestionRequest[];
    activity?: Activity;
  } = { messages: [], pendingPermissions: [], pendingQuestions: [] };

  /**
   * Kolejne wyniki decyzji o zgodzie (first-wins: 'ok', potem 'conflict').
   *
   * Sam kod wyniku wystarcza w większości testów; pełny {@link ResolveResult} jest potrzebny
   * wyłącznie dla `refused`, które niesie jeszcze powód (422).
   */
  permissionOutcomes: (ResolveOutcome | ResolveResult)[] = [];
  answerOutcomes: (ResolveOutcome | ResolveResult)[] = [];

  /** Błędy do rzucenia z konkretnych metod. */
  throwOn: Partial<Record<string, Error>> = {};

  private listeners: ((scope: 'global' | string, seq: number | null, ev: ServerEvent) => void)[]
    = [];

  constructor(sessions: SessionSummary[] = [makeSummary()]) {
    for (const s of sessions) this.sessions.set(s.id, s);
  }

  private record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args });
    const err = this.throwOn[method];
    if (err !== undefined) throw err;
  }

  /** Wypycha event do wszystkich zarejestrowanych subskrybentów (symuluje manager). */
  emit(scope: 'global' | string, seq: number | null, ev: ServerEvent): void {
    for (const cb of this.listeners) cb(scope, seq, ev);
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()];
  }

  get(id: string): SessionSummary | undefined {
    return this.sessions.get(id);
  }

  /** Lista zwracana przez `resumable()` — sterowana z testu. */
  resumableResult: ResumableSession[] = [];

  /** Lista modeli oddawana przez `models()` — sterowana z testu (domyślnie wbudowana). */
  modelList: ModelList = { models: [DEFAULT_MODEL_CHOICE, ...FALLBACK_MODEL_CHOICES] };

  models(): ModelList {
    return this.modelList;
  }

  /** Lista komend sesji oddawana przez `commands()` — sterowana z testu. */
  commandList: CommandList = {
    revision: 'r-fake', commands: [{ name: 'compact', kind: 'local', source: 'builtin' }],
  };

  commands(id: string): CommandList {
    this.requireSession(id);
    this.record('commands', id);
    return this.commandList;
  }

  /**
   * Zmiana modelu oddaje OSTRZEŻENIE, nie migawkę sesji (nowa wartość przychodzi
   * z jsonl po następnej turze). Atrapa mimo to przestawia pola u siebie — testy routera
   * sprawdzają dzięki temu, że endpoint dowiózł patch dokładnie takim, jaki dostał.
   */
  async setModel(
    id: string, patch: { model?: string; effort?: EffortLevel | null; ultracode?: boolean },
  ): Promise<SessionModelResponse> {
    const session = this.requireSession(id);
    this.record('setModel', id, patch);
    const updated: SessionSummary = { ...session };
    if (patch.model !== undefined) updated.model = patch.model;
    if (patch.effort !== undefined && patch.effort !== null) updated.effort = patch.effort;
    if (patch.effort === null) delete updated.effort;
    if (patch.ultracode !== undefined) updated.ultracode = patch.ultracode;
    this.sessions.set(id, updated);
    // Ostrzeżenie po paczce jak w managerze: sam ultracode to zdanie o koszcie, reszta — o ustawieniach konta.
    const ultracodeOnly = patch.ultracode !== undefined && (patch.model === undefined || patch.model === '')
      && (patch.effort === undefined || patch.effort === null);
    return { ok: true, warning: (ultracodeOnly ? ULTRACODE_CHANGE_NOTE : MODEL_CHANGE_WARNING).text };
  }

  /** Zmiana trybu: atrapa przestawia chip od razu — router sprawdza tylko dowóz patcha. */
  async setMode(id: string, patch: { mode: ModeCycleTarget }): Promise<SessionModeResponse> {
    const session = this.requireSession(id);
    this.record('setMode', id, patch);
    this.sessions.set(id, { ...session, herdrMode: patch.mode });
    return { ok: true };
  }

  /** „Pokaż w herdr" (`agent.focus`). Atrapa tylko notuje wywołanie. */
  async focus(id: string): Promise<void> {
    this.requireSession(id);
    this.record('focus', id);
  }

  /** „Obejrzałem to na telefonie". Notujemy wywołanie — 404 sprawdza `requireSession`. */
  markSeen(id: string): void {
    this.requireSession(id);
    this.record('markSeen', id);
  }

  /** „Oznacz jako nieprzeczytane". Notujemy wywołanie — 404 sprawdza `requireSession`. */
  markUnseen(id: string): void {
    this.requireSession(id);
    this.record('markUnseen', id);
  }

  /** `POST /api/sessions` oddaje 202 z samym `sessionId` — reszta startu jedzie po SSE. */
  async create(opts: CreateSessionOptions): Promise<CreateSessionResponse> {
    this.record('create', opts);
    const session = makeSummary({
      id: opts.sessionId ?? `sess-${String(this.sessions.size + 1)}`,
      cwd: opts.cwd,
      state: 'starting',
    });
    this.sessions.set(session.id, session);
    return { sessionId: session.id, state: 'starting' };
  }

  async resumable(cwd: string): Promise<ResumableSession[]> {
    this.record('resumable', cwd);
    return this.resumableResult;
  }

  /** Lista zwracana przez `recentResumable()` — sterowana z testu, domyślnie ta sama. */
  recentResumableResult: ResumableSession[] | null = null;

  async recentResumable(cwd: string, limit?: number): Promise<ResumableSession[]> {
    this.record('recentResumable', cwd, String(limit ?? ''));
    return this.recentResumableResult ?? this.resumableResult;
  }

  /** Lista zwracana przez `recentProjects()` — sterowana z testu. */
  recentProjectsResult: RecentProject[] = [];

  async recentProjects(limit?: number): Promise<RecentProject[]> {
    this.record('recentProjects', String(limit ?? ''));
    return this.recentProjectsResult;
  }

  /** Wynik `sendMessage` sterowany z testu (`replayed: true` = powtórka przyjętej). */
  sendResult: SendMessageAck = { replayed: false };

  async sendMessage(
    id: string, text: string, images?: readonly string[], files?: readonly FileAttachment[],
    clientMessageId?: string, opts?: SendMessageOptions,
  ): Promise<SendMessageAck> {
    this.requireSession(id);
    // Bez załączników nie zapisujemy dalszych argumentów — asercje na `args` zostają czytelne.
    // Pliki dopisujemy dopiero, gdy są: inaczej KAŻDA asercja na zwykłą wiadomość musiałaby
    // wymieniać dwa `undefined`. Identyfikator wysyłki i `queueAware` — z tego samego
    // powodu tylko, gdy są.
    if (opts?.queueAware === true) {
      this.record('sendMessage', id, text, images ?? [], files ?? [], clientMessageId, { queueAware: true });
    } else if (clientMessageId !== undefined) {
      this.record('sendMessage', id, text, images ?? [], files ?? [], clientMessageId);
    } else if (files !== undefined) this.record('sendMessage', id, text, images ?? [], files);
    else if (images !== undefined) this.record('sendMessage', id, text, images);
    else this.record('sendMessage', id, text);
    return this.sendResult;
  }

  resolvePermission(
    id: string, permId: string, decision: 'allow' | 'allow-always' | 'deny', by: string, message?: string,
  ): Promise<ResolveResult> {
    this.requireSession(id);
    this.record('resolvePermission', id, permId, decision, by, message);
    return Promise.resolve(asResolveResult(this.permissionOutcomes.shift()));
  }

  answerQuestion(id: string, qId: string, answers: string[][]): Promise<ResolveResult> {
    this.requireSession(id);
    this.record('answerQuestion', id, qId, answers);
    return Promise.resolve(asResolveResult(this.answerOutcomes.shift()));
  }

  interrupt(id: string): Promise<boolean> {
    this.requireSession(id);
    this.record('interrupt', id);
    return Promise.resolve(true);
  }

  /** Result of `returnedPrompt()`, set by the test. */
  returnedPromptResult: string | null = null;

  returnedPrompt(id: string): Promise<string | null> {
    this.record('returnedPrompt', id);
    return Promise.resolve(this.returnedPromptResult);
  }

  /** Result of `takeBackQueue()`, set by the test. */
  takeBackResult: QueueTakeBackResponse = { items: [] };

  takeBackQueue(id: string, operationId: string): Promise<QueueTakeBackResponse> {
    this.requireSession(id);
    this.record('takeBackQueue', id, operationId);
    return Promise.resolve(this.takeBackResult);
  }

  /** Diff zwracany przez `diff()` — sterowany z testu. */
  diffResult: SessionDiff = { files: [], patch: '', truncated: false };

  async diff(id: string): Promise<SessionDiff> {
    this.requireSession(id);
    this.record('diff', id);
    return this.diffResult;
  }

  /** Lista zmian zwracana przez `diffFiles()` — sterowana z testu. */
  diffFilesResult: DiffFileList = { files: [], truncated: false };

  async diffFiles(id: string): Promise<DiffFileList> {
    this.requireSession(id);
    this.record('diffFiles', id);
    return this.diffFilesResult;
  }

  /**
   * Patch pliku: atrapa odsyła ścieżkę TAKĄ, jaką dostała — testy routera sprawdzają
   * dzięki temu, że parametr `path` doszedł do managera co do znaku.
   */
  diffFilePatch = '';

  async diffFile(id: string, path: string): Promise<DiffFilePatch> {
    this.requireSession(id);
    this.record('diffFile', id, path);
    return { path, patch: this.diffFilePatch, truncated: false };
  }

  /** The answer of `listFiles()`, set by the test. */
  listFilesResult: FileListingAnswer = {
    ok: true, value: { dir: '', entries: [], truncated: false, maxBytes: 1024 * 1024 },
  };
  /** Set: `listFiles()` answers only once it settles (a test unpairs the device meanwhile). */
  listFilesWait: Promise<void> | undefined;

  async listFiles(id: string, dir: string, maxBytes: number): Promise<FileListingAnswer> {
    this.requireSession(id);
    this.record('listFiles', id, dir, maxBytes);
    await this.listFilesWait;
    return this.listFilesResult;
  }

  /**
   * The port of the file reads: a demo port over the fake's sessions (an unknown id throws its 404) and the demo data;
   * git is never asked. A test puts its own port here.
   */
  filesPortValue: SessionFilesPort | undefined;

  filesPort(): SessionFilesPort {
    this.record('filesPort');
    return this.filesPortValue ?? {
      require: (id) => {
        const summary = this.requireSession(id);
        return new Session({
          id: summary.id, cwd: summary.cwd, title: summary.title, state: summary.state,
          stateSince: summary.lastActivityAt, createdAt: summary.createdAt, lastActivityAt: summary.lastActivityAt,
        });
      },
      config: { demo: true },
      run: () => Promise.reject(new Error('the fake manager runs no git')),
      demoEntries: demoFileEntries,
    };
  }

  /**
   * The answer of `openFile()`, set by the test: by default 404 `not-found`; a test that sends real bytes puts the
   * download module over its own directory here.
   */
  openFileAnswer: (id: string, rel: string, maxBytes: number) => Promise<FileDownloadAnswer> =
    () => Promise.resolve({ ok: false, refusal: NOT_FOUND });
  /** Set: `openFile()` answers only once it settles (a test unpairs the device meanwhile). */
  openFileWait: Promise<void> | undefined;

  async openFile(id: string, rel: string, maxBytes: number): Promise<FileDownloadAnswer> {
    this.requireSession(id);
    this.record('openFile', id, rel, maxBytes);
    const answer = await this.openFileAnswer(id, rel, maxBytes);
    await this.openFileWait;
    return answer;
  }

  async close(id: string, opts: { closePanel?: boolean } = {}): Promise<void> {
    this.requireSession(id);
    this.record('close', id, opts);
  }

  async resume(id: string): Promise<SessionSummary> {
    const session = this.requireSession(id);
    this.record('resume', id);
    return session;
  }

  async restart(id: string, opts?: RestartOptions): Promise<{ sessionId: string }> {
    this.requireSession(id);
    this.record('restart', id, opts);
    return { sessionId: id };
  }

  transcript(id: string): {
    messages: TranscriptMessage[];
    pendingPermissions: PermissionRequest[];
    pendingQuestions: QuestionRequest[];
    activity?: Activity;
  } {
    this.record('transcript', id);
    return this.transcriptResult;
  }

  eventsSince(id: string, seq: number | null): EventsSinceResult {
    this.record('eventsSince', id, seq);
    return this.eventsSinceResult;
  }

  onEvent(cb: (scope: 'global' | string, seq: number | null, ev: ServerEvent) => void): void {
    this.listeners.push(cb);
  }

  projects(): { path: string; name: string }[] {
    return this.allowedProjects;
  }

  /**
   * Stan integracji herdr oddawany w ramce `sessions-snapshot`.
   *
   * `undefined` (domyślnie) znaczy „integracja wyłączona" — i to jest coś innego niż
   * „herdr niedostępny": przy wyłączonej integracji baner ma w ogóle nie istnieć.
   */
  herdrStatusResult: HerdrStatus | undefined = undefined;

  herdrStatus(): HerdrStatus | undefined {
    return this.herdrStatusResult;
  }

  // --- agent głosowy ---

  /** Bieżąca rozmowa silnika każdej sesji (`engineSessionId`) — sterowana z testu. */
  readonly conversations = new Map<string, string>();

  private conversationListeners: ((sessionId: string, agentSessionId: string) => void)[] = [];

  /** The newest message of each session in memory (`lastMessage` of the voice agent's entry), set by the test. */
  readonly lastMessages = new Map<string, TranscriptMessage>();

  /** The read mark of each session's memory (`Session.readMark`), set by the test; default `memory.0`. */
  readonly readMarks = new Map<string, string>();

  /**
   * As the manager: a Codex session and a pane out of scope are `null`, an unknown session is NotFound. The directory
   * outside the work area is not checked here: tests of that case go through the real gate.
   */
  companionTarget(id: string): CompanionEntry | null {
    const session = this.requireSession(id);
    if (session.engine === 'codex' || session.outOfScope === true) return null;
    return {
      cwd: session.cwd, agentSessionId: this.conversations.get(id), lastMessage: this.lastMessages.get(id),
      readMark: this.readMarks.get(id) ?? 'memory.0',
    };
  }

  onConversationChange(cb: (sessionId: string, agentSessionId: string) => void): () => void {
    this.conversationListeners.push(cb);
    return () => { this.conversationListeners = this.conversationListeners.filter((one) => one !== cb); };
  }

  /** Symuluje `/clear` albo `/resume` w panelu: nowa rozmowa silnika i powiadomienie słuchaczy. */
  changeConversation(id: string, agentSessionId: string): void {
    this.conversations.set(id, agentSessionId);
    for (const cb of this.conversationListeners) cb(id, agentSessionId);
  }

  // --- taby TERMINALOWE  ---

  private requireSession(id: string): SessionSummary {
    const session = this.sessions.get(id);
    if (session === undefined) throw new NotFoundError(`brak sesji ${id}`);
    return session;
  }
}
