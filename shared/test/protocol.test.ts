import { describe, expect, it } from 'vitest';
import {
  NOTES_BODY_MAX_BYTES,
  NOTES_MAX_CHARS,
  notesConflictBodySchema,
  notesDocSchema,
  notesEmpty,
  notesGetResponseSchema,
  notesPutBodySchema,
  notesPutResponseSchema,
  MAX_FILES_PER_MESSAGE,
  MAX_FILE_DATA_URL_BYTES,
  MAX_FILE_NAME_CHARS,
  MAX_IMAGES_PER_MESSAGE,
  MAX_IMAGE_DATA_URL_BYTES,
  MAX_MESSAGE_BODY_BYTES,
  fileAttachmentSchema,
  isSafeFileName,
  MAX_ANSWER_TEXT_CHARS,
  MAX_MESSAGE_TEXT_CHARS,
  MAX_HERDR_PROMPT_BYTES,
  herdrStatusSchema,
  PROTOCOL_VERSION,
  checkMessageImageLimits,
  MAX_FIRST_PROMPT_LENGTH,
  MAX_RESUMABLE_SESSIONS,
  clientLogBodySchema,
  FALLBACK_MODEL_CHOICES,
  DEFAULT_MODEL_CHOICE,
  MODEL_CHANGE_WARNING,
  ULTRACODE_CHANGE_NOTE,
  modelChoiceSchema,
  modelIdSchema,
  EFFORT_LEVELS,
  PERMISSION_MODES,
  formatModelLabel,
  modelAlias,
  sessionModelBodySchema,
  dirListingSchema,
  createSessionBodySchema,
  parseServerEvent,
  permissionDecisionBodySchema,
  resumableListSchema,
  resumableSessionSchema,
  closeBodySchema,
  contextLimitStateSchema,
  createSessionResponseSchema,
  KNOWN_CONTEXT_LIMITS,
  serverEventSchema,
  MAX_DIFF_PATCH_BYTES,
  diffFileSchema,
  sessionDiffSchema,
  DIFF_BAD_PATH_ERROR,
  DIFF_FILE_NOT_FOUND_ERROR,
  DIFF_GIT_FAILED_ERROR,
  DIFF_SESSION_NOT_FOUND_ERROR,
  diffFileListSchema,
  diffFilePatchSchema,
  diffListEntrySchema,
  backgroundTaskSchema,
  sessionSummarySchema,
  transcriptNoticeSchema,
  REFUSE_MESSAGES,
  REFUSE_REASONS,
} from '../src/protocol.ts';
import {
  MAX_ANSWER_NOTE_CHARS, MAX_ANSWERS_TOTAL_CHARS, answersBodySchema, messageBodySchema, seenBodySchema,
} from '../src/rest.ts';
import type {
  DiffFile, DiffFileList, DiffFilePatch, PermissionRequest, QuestionRequest, ResumableSession,
  ServerEvent, SessionDiff, SessionSummary, TranscriptMessage,
} from '../src/protocol.ts';

/** Najmniejszy poprawny data URL (1×1 px png) — używany wszędzie, gdzie treść nie ma znaczenia. */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==';

/** Data URL o zadanej długości (dokładnie `bytes` znaków) — do testów limitu rozmiaru. */
function dataUrlOfLength(bytes: number): string {
  const prefix = 'data:image/jpeg;base64,';
  return prefix + 'A'.repeat(bytes - prefix.length);
}

/** Załącznik plikowy: PDF-owy nagłówek w base64 — liczy się kształt, nie treść. */
const PDF = 'data:application/pdf;base64,JVBERi0xLjQK';

/** Data URL pliku o zadanej długości (dokładnie `bytes` znaków). */
function fileDataUrlOfLength(bytes: number): string {
  const prefix = 'data:application/pdf;base64,';
  return prefix + 'A'.repeat(bytes - prefix.length);
}

const summary: SessionSummary = {
  id: 'a1b2',
  cwd: '/Users/x/Projects/willow',
  title: 'willow',
  label: 'zapis notatek',
  state: 'waiting-permission',
  stateDetail: 'czeka na zgodę',
  stateSince: '2026-08-21T10:00:00.000Z',
  createdAt: '2026-08-21T09:50:00.000Z',
  lastActivityAt: '2026-08-21T10:00:00.000Z',
  branch: 'main',
  dirtyCount: 2,
  ahead: 2,
  behind: 1,
  fileKinds: { added: 1, modified: 1, deleted: 0 },
  usage: { contextTokens: 68_000, contextLimit: 200_000 },
  lastSummary: 'Testy zielone.',
};

/** Sesja przypięta do żywego panelu herdr — komplet pól, które niesie tylko ona. */
const herdrSummary: SessionSummary = {
  id: 'h1',
  cwd: '/Users/u/Projects/atlas',
  title: 'atlas',
  label: 's3-back',
  state: 'waiting-input',
  stateSince: '2026-08-22T09:00:00.000Z',
  createdAt: '2026-08-22T08:00:00.000Z',
  lastActivityAt: '2026-08-22T09:00:00.000Z',
  paneId: 'w9:p72',
  launchedByRarog: true,
  context: { kind: 'known', tokens: 68_000, limit: 200_000, source: 'compact-boundary' },
  seen: true,
  stale: false,
  herdrMode: 'auto',
  outOfScope: false,
};

const message: TranscriptMessage = {
  seq: 7,
  role: 'assistant',
  blocks: [
    { type: 'text', text: '## Wynik\n- ok' },
    { type: 'tool-call', toolName: 'Edit', summary: 'src/notes.ts', detail: '+3 −1' },
    { type: 'image', dataUrl: PNG, alt: 'zrzut ekranu' },
  ],
  at: '2026-08-21T10:00:01.000Z',
};

const permission: PermissionRequest = {
  permId: 'p1',
  sessionId: 'a1b2',
  toolName: 'Bash',
  displayText: 'npm test -- --run src/notes.test.ts',
  risk: 'normal',
  cwd: '/Users/x/Projects/willow',
  createdAt: '2026-08-21T09:56:00.000Z',
};

const question: QuestionRequest = {
  qId: 'q1',
  sessionId: 'a1b2',
  questions: [
    {
      question: 'Który wariant?',
      header: 'Wariant',
      multiSelect: false,
      options: [{ label: 'A', description: 'szybszy' }, { label: 'B' }],
    },
  ],
  createdAt: '2026-08-21T09:57:00.000Z',
};

// Po jednej reprezentatywnej instancji KAŻDEGO wariantu ServerEvent.
const events: ServerEvent[] = [
  { type: 'hello', protocolVersion: PROTOCOL_VERSION, serverStartId: 's-1' },
  {
    type: 'sessions-snapshot',
    sessions: [summary, herdrSummary],
    // Status herdr jedzie w ramce startowej, bo iOS zrywa SSE przy każdym uśpieniu —
    // bez tego baner po powrocie do apki pokazywałby stan sprzed dowolnie dawna.
    herdrStatus: {
      available: true, agentCount: 17, readOnly: false, canLaunch: true,
      version: '0.8.2', protocol: 20,
    },
  },
  { type: 'session-changed', session: summary },
  {
    type: 'transcript-snapshot',
    sessionId: 'a1b2',
    messages: [message],
    pendingPermissions: [permission],
    pendingQuestions: [question],
    // Aktywność jest ULOTNA (poza ring bufferem), więc snapshot jest jedynym sposobem, żeby
    // klient podłączający się w środku tury wiedział, że agent pracuje.
    activity: { kind: 'tool', toolName: 'Bash', elapsedSeconds: 148 },
  },
  { type: 'message', sessionId: 'a1b2', message },
  { type: 'delta', sessionId: 'a1b2', text: 'frag' },
  { type: 'activity', sessionId: 'a1b2', kind: 'thinking' },
  { type: 'permission-pending', request: permission },
  { type: 'permission-resolved', sessionId: 'a1b2', permId: 'p1', decision: 'allow', by: 'iPad' },
  {
    type: 'permission-settled', sessionId: 'a1b2', permId: 'p1', state: 'sent', canAllow: false,
    unavailable: 'no-proof', dialogVisible: true, at: '2026-10-03T08:02:05.000Z',
  },
  { type: 'question-pending', request: question },
  { type: 'question-resolved', sessionId: 'a1b2', qId: 'q1' },
  { type: 'state', sessionId: 'a1b2', state: 'running', detail: 'wznowiona', since: '2026-08-21T10:01:00.000Z' },
  {
    type: 'git-status', sessionId: 'a1b2', branch: 'main', dirtyCount: 3,
    files: ['src/notes.ts'], ahead: 2, behind: 0,
    fileKinds: { added: 0, modified: 3, deleted: 0 },
  },
  { type: 'usage', sessionId: 'a1b2', contextTokens: 68_000, contextLimit: 200_000 },
  {
    type: 'herdr-status', available: false, agentCount: 0, readOnly: false,
    detail: 'socket herdr nieosiągalny',
  },
  { type: 'notes', cwd: '/Users/d/Projects/rarog', empty: false },
];

describe('PROTOCOL_VERSION', () => {
  // 3: echo użytkownika niesie `attachments[]` zamiast bloków `image`
  // z pełnym `dataUrl`, a stary bundle liczy podpis echa po LICZBIE bloków `image` — więc
  // nigdy by go nie pogodził i każda wysyłka ze zdjęciem wisiałaby na „Nie potwierdzono".
  it('jest liczbą 3', () => {
    expect(PROTOCOL_VERSION).toBe(3);
  });
});

describe('round-trip eventów', () => {
  it('pokrywa wszystkie warianty unii', () => {
    const types = new Set(events.map((e) => e.type));
    expect(types.size).toBe(events.length);
    expect(serverEventSchema.options.length).toBe(events.length);
  });

  for (const ev of events) {
    it(`round-trip: ${ev.type}`, () => {
      const parsed = parseServerEvent(JSON.parse(JSON.stringify(ev)) as unknown);
      expect(parsed).toEqual(ev);
    });

    it(`round-trip ze stringa JSON: ${ev.type}`, () => {
      expect(parseServerEvent(JSON.stringify(ev))).toEqual(ev);
    });
  }

  it('ramka `activity` ma w TYPIE wszystkie pola `Activity`, także `delegation`', () => {
    // Test kompilacyjny: osobna lista pól wariantu gubiła nowe pole (TS2353 przy tworzeniu,
    // TS2339 przy odczycie po zawężeniu) — dwukierunkowe `extends` brak opcjonalnego przepuszcza.
    const event: ServerEvent = { type: 'activity', sessionId: 'a1b2', kind: 'tool', delegation: 'workflow' };
    const parsed = parseServerEvent(JSON.stringify(event));
    expect(parsed?.type === 'activity' ? parsed.delegation : undefined).toBe('workflow');
  });

  it('pola opcjonalne mogą być pominięte', () => {
    const minimal = {
      type: 'state',
      sessionId: 'a1b2',
      state: 'done',
      since: '2026-08-21T10:03:00.000Z',
    };
    expect(parseServerEvent(minimal)).toEqual(minimal);
  });

  it('git-status bez upstreamu nie ma ahead/behind (i to jest poprawne)', () => {
    const bezUpstreamu = {
      type: 'git-status', sessionId: 'a1b2', branch: 'feat/x', dirtyCount: 0, files: [],
    };
    const parsed = parseServerEvent(bezUpstreamu);
    expect(parsed).toEqual(bezUpstreamu);
    expect(parsed && 'ahead' in parsed).toBe(false);
  });

  it('git-status bez trójki rodzajów przechodzi (ramka ze starszego serwera)', () => {
    const bezRodzajow = {
      type: 'git-status', sessionId: 'a1b2', branch: 'main', dirtyCount: 1, files: ['a.ts'],
    };
    const parsed = parseServerEvent(bezRodzajow);
    expect(parsed).toEqual(bezRodzajow);
    expect(parsed && 'fileKinds' in parsed).toBe(false);
  });

  it('usage wymaga obu liczb', () => {
    expect(parseServerEvent({ type: 'usage', sessionId: 'a1b2', contextTokens: 1 })).toBeNull();
    expect(parseServerEvent({
      type: 'usage', sessionId: 'a1b2', contextTokens: '1', contextLimit: 200_000,
    })).toBeNull();
  });

  it('sesja bez widgetu użycia przechodzi bez pola usage', () => {
    const bezUsage = {
      type: 'session-changed',
      session: {
        id: 'a1b2', cwd: '/p', title: 'p', state: 'running',
        stateSince: '2026-08-21T10:00:00.000Z',
        createdAt: '2026-08-21T10:00:00.000Z',
        lastActivityAt: '2026-08-21T10:00:00.000Z',
      },
    };
    const parsed = parseServerEvent(bezUsage);
    expect(parsed).toEqual(bezUsage);
    expect(parsed?.type === 'session-changed' && 'usage' in parsed.session).toBe(false);
  });

  it('niepoprawny kształt usage w podsumowaniu → null', () => {
    expect(parseServerEvent({
      type: 'session-changed',
      session: {
        id: 'a1b2', cwd: '/p', title: 'p', state: 'running',
        stateSince: 'x', createdAt: 'x', lastActivityAt: 'x',
        usage: { contextTokens: 10 },
      },
    })).toBeNull();
  });

  it('sesja bez wiersza gita przechodzi bez ahead/behind', () => {
    const bezGita = {
      type: 'session-changed',
      session: {
        id: 'a1b2', cwd: '/p', title: 'p', state: 'running',
        stateSince: '2026-08-21T10:00:00.000Z',
        createdAt: '2026-08-21T10:00:00.000Z',
        lastActivityAt: '2026-08-21T10:00:00.000Z',
      },
    };
    expect(parseServerEvent(bezGita)).toEqual(bezGita);
  });
});

describe('bloki obrazków', () => {
  it('blok image przechodzi round-trip razem z alt', () => {
    const ev = {
      type: 'message',
      sessionId: 'a1b2',
      message: {
        seq: 3, role: 'user', at: '2026-08-21T10:00:00.000Z',
        blocks: [{ type: 'text', text: 'co tu jest nie tak?' }, { type: 'image', dataUrl: PNG }],
      },
    };
    expect(parseServerEvent(JSON.stringify(ev))).toEqual(ev);
  });

  it('odrzuca data URL spoza png/jpeg (svg i html potrafią wykonać skrypt)', () => {
    for (const dataUrl of [
      'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'https://example.com/obrazek.png',
      'data:image/png,niebase64',
      'data:image/png;base64,ma spacje',
    ]) {
      expect(parseServerEvent({
        type: 'message',
        sessionId: 'a1b2',
        message: {
          seq: 1, role: 'user', at: 'now', blocks: [{ type: 'image', dataUrl }],
        },
      }), dataUrl).toBeNull();
    }
  });

  it('odrzuca obrazek ponad limit rozmiaru', () => {
    expect(parseServerEvent({
      type: 'message',
      sessionId: 'a1b2',
      message: {
        seq: 1, role: 'user', at: 'now',
        blocks: [{ type: 'image', dataUrl: dataUrlOfLength(MAX_IMAGE_DATA_URL_BYTES + 1) }],
      },
    })).toBeNull();
  });
});

describe('przypadki negatywne (forward-compat)', () => {
  it('nieznany type → null', () => {
    expect(parseServerEvent({ type: 'nowy-event-z-przyszłości', cokolwiek: 1 })).toBeNull();
  });

  it('brak type → null', () => {
    expect(parseServerEvent({ sessionId: 'a1b2' })).toBeNull();
  });

  it('brakujące pole wymagane → null', () => {
    expect(parseServerEvent({ type: 'delta', sessionId: 'a1b2' })).toBeNull();
    expect(parseServerEvent({ type: 'hello', protocolVersion: 1 })).toBeNull();
  });

  it('zły typ pola → null', () => {
    expect(parseServerEvent({ type: 'delta', sessionId: 'a1b2', text: 42 })).toBeNull();
    expect(parseServerEvent({
      type: 'git-status', sessionId: 'a1b2', branch: 'main', dirtyCount: '3', files: [],
    })).toBeNull();
  });

  it('nieznany stan sesji → null', () => {
    expect(parseServerEvent({
      type: 'state', sessionId: 'a1b2', state: 'teleportacja', since: 'now',
    })).toBeNull();
  });

  it('nieznany blok w wiadomości → null', () => {
    expect(parseServerEvent({
      type: 'message',
      sessionId: 'a1b2',
      message: { seq: 1, role: 'assistant', blocks: [{ type: 'obrazek', url: 'x' }], at: 'now' },
    })).toBeNull();
  });

  it('niepoprawny JSON w stringu → null', () => {
    expect(parseServerEvent('{nie-json')).toBeNull();
  });

  it('null / prymitywy → null', () => {
    expect(parseServerEvent(null)).toBeNull();
    expect(parseServerEvent(7)).toBeNull();
  });
});

describe('schematy komend POST', () => {
  it('CreateSessionBody', () => {
    expect(createSessionBodySchema.safeParse({ cwd: '/p', prompt: 'zrób' }).success).toBe(true);
    expect(createSessionBodySchema.safeParse({
      cwd: '/p', prompt: 'zrób', permissionMode: 'manual', model: 'sonnet',
    }).success).toBe(true);
    // Prompt jest OPCJONALNY (pusta sesja).
    expect(createSessionBodySchema.safeParse({ cwd: '/p' }).success).toBe(true);
    expect(createSessionBodySchema.safeParse({ cwd: '/p', prompt: 42 }).success).toBe(false);
    expect(createSessionBodySchema.safeParse({ prompt: 'zrób' }).success).toBe(false);
    // `cwd` musi być NIEPUSTE: pusty string przeszedłby `z.string()` i poleciałby do
    // `workspace.create`, gdzie herdr podstawia `$HOME` — czyli panel poza korzeniami.
    expect(createSessionBodySchema.safeParse({ cwd: '' }).success).toBe(false);
  });

  it('CreateSessionBody: resumeFrom i fork', () => {
    const uuid = '7d2dd80f-012c-5c17-b97d-cf436a305158';
    expect(createSessionBodySchema.safeParse({ cwd: '/p', resumeFrom: uuid }).success).toBe(true);
    expect(createSessionBodySchema.safeParse({ cwd: '/p', resumeFrom: uuid, fork: true }).success)
      .toBe(true);
    // `fork` bez `resumeFrom` nie ma czego rozwidlić — to błąd kształtu, nie stanu.
    expect(createSessionBodySchema.safeParse({ cwd: '/p', fork: true }).success).toBe(false);
    // `resumeFrom` wchodzi do `join()` przy szukaniu pliku transkryptu (granica bezpieczeństwa).
    for (const zly of ['../../etc/passwd', 'a/b', '', '.hidden']) {
      expect(createSessionBodySchema.safeParse({ cwd: '/p', resumeFrom: zly }).success)
        .toBe(false);
    }
  });

  it('CreateSessionResponse to 202 ze `starting`, nie gotowa sesja', () => {
    expect(createSessionResponseSchema.safeParse({ sessionId: 'h1', state: 'starting' }).success)
      .toBe(true);
    expect(createSessionResponseSchema.safeParse({ sessionId: 'h1', state: 'running' }).success)
      .toBe(false);
    expect(createSessionResponseSchema.safeParse({ state: 'starting' }).success).toBe(false);
  });

  it('CloseBody: brak ciała znaczy UKRYJ, nie zamknij panelu', () => {
    expect(closeBodySchema.safeParse(undefined).success).toBe(true);
    expect(closeBodySchema.safeParse({}).success).toBe(true);
    expect(closeBodySchema.safeParse({ closePanel: true }).success).toBe(true);
    expect(closeBodySchema.safeParse({ closePanel: 'tak' }).success).toBe(false);
  });

  /*
   * `permissionMode: z.string()` wpuściłoby dowolny tryb SDK, w tym
   * `dontAsk` i `auto` — czyli sesję, w której `canUseTool` NIGDY nie pyta, a to jest jedyna
   * granica bezpieczeństwa Raroga. `bypassPermissions` zostaje w schemacie, ale bramkuje go
   * serwer (`RAROG_YOLO_ROOTS`), bo to decyzja z konfiguracji, nie z ciała requestu.
   */
  it('CreateSessionBody: permissionMode i model mają allow-listy', () => {
    for (const mode of PERMISSION_MODES) {
      expect(createSessionBodySchema.safeParse({ cwd: '/p', permissionMode: mode }).success)
        .toBe(true);
    }
    expect(PERMISSION_MODES)
      .toEqual(['manual', 'acceptEdits', 'auto', 'plan', 'bypassPermissions']);
    for (const mode of ['dontAsk', 'default', 'cokolwiek', '']) {
      expect(createSessionBodySchema.safeParse({ cwd: '/p', permissionMode: mode }).success)
        .toBe(false);
    }
    for (const { value: model } of FALLBACK_MODEL_CHOICES) {
      expect(createSessionBodySchema.safeParse({ cwd: '/p', model }).success).toBe(true);
    }
    for (const effort of EFFORT_LEVELS) {
      expect(createSessionBodySchema.safeParse({ cwd: '/p', effort }).success).toBe(true);
    }
    expect(createSessionBodySchema.safeParse({ cwd: '/p', model: '../../etc' }).success)
      .toBe(false);
    expect(createSessionBodySchema.safeParse({ cwd: '/p', model: 'opus --yolo' }).success)
      .toBe(false);
    expect(createSessionBodySchema.safeParse({ cwd: '/p', effort: 'ultra' }).success)
      .toBe(false);
  });

  it('SessionModelBody: co najmniej jedno pole, effort null = domyślny', () => {
    expect(sessionModelBodySchema.safeParse({}).success).toBe(false);
    expect(sessionModelBodySchema.safeParse({ model: 'opus' }).success).toBe(true);
    expect(sessionModelBodySchema.safeParse({ effort: null }).success).toBe(true);
    expect(sessionModelBodySchema.safeParse({ effort: 'max', model: 'claude-fable-5-1' }).success)
      .toBe(true);
    expect(sessionModelBodySchema.safeParse({ model: 'Opus' }).success).toBe(false);
  });

  it('SessionModelBody: ultracode liczy się obecnością, także `false`', () => {
    expect(sessionModelBodySchema.safeParse({ ultracode: true }).success).toBe(true);
    expect(sessionModelBodySchema.safeParse({ ultracode: false }).success).toBe(true);
    expect(sessionModelBodySchema.safeParse({ model: 'opus', ultracode: false }).success).toBe(true);
    expect(sessionModelBodySchema.safeParse({ ultracode: null }).success).toBe(false);
    expect(sessionModelBodySchema.safeParse({ ultracode: 'on' }).success).toBe(false);
    const empty = sessionModelBodySchema.safeParse({});
    expect(empty.success ? null : empty.error.issues[0]?.message).toBe('Podaj model, effort albo ultracode.');
  });

  it('CreateSessionBody: ultracode tylko jako true i tylko z effortem nieobecnym albo xhigh', () => {
    expect(createSessionBodySchema.safeParse({ cwd: '/p', ultracode: true }).success).toBe(true);
    expect(createSessionBodySchema.safeParse({ cwd: '/p', ultracode: true, effort: 'xhigh' }).success).toBe(true);
    expect(createSessionBodySchema.safeParse({ cwd: '/p', ultracode: true, model: 'opus[1m]' }).success)
      .toBe(true);
    for (const effort of EFFORT_LEVELS.filter((level) => level !== 'xhigh')) {
      expect(createSessionBodySchema.safeParse({ cwd: '/p', ultracode: true, effort }).success, effort).toBe(false);
    }
    const jawneFalse = createSessionBodySchema.safeParse({ cwd: '/p', ultracode: false });
    expect(jawneFalse.success ? null : jawneFalse.error.issues[0]?.message)
      .toBe('ultracode w ciele startu tylko jako true; brak pola = bez flagi.');
    expect(createSessionBodySchema.safeParse({ cwd: '/p', ultracode: 'true' }).success).toBe(false);
    // Bez pola zostaje dzisiejsza ścieżka: każdy poziom effortu przechodzi.
    expect(createSessionBodySchema.safeParse({ cwd: '/p', effort: 'low' }).success).toBe(true);
  });

  it('ModelChoice.ultracode: jawnie przy fable, opus[1m] i sonnet; bez Haiku i modelu konta', () => {
    expect(FALLBACK_MODEL_CHOICES.filter((choice) => choice.ultracode === true).map((choice) => choice.value))
      .toEqual(['fable', 'opus[1m]', 'sonnet']);
    expect('ultracode' in DEFAULT_MODEL_CHOICE).toBe(false);
    for (const choice of [DEFAULT_MODEL_CHOICE, ...FALLBACK_MODEL_CHOICES]) {
      expect(modelChoiceSchema.parse(choice)).toEqual(choice);
    }
    // Wartość jest jedna: `false` niczego nie mówi ponad brak pola, więc nie przechodzi.
    expect(modelChoiceSchema.safeParse({ value: 'fable', label: 'Fable', effortLevels: [], ultracode: false })
      .success).toBe(false);
  });

  it('zdanie o ultracode to osobna stała, nie ostrzeżenie o `/model`', () => {
    expect(ULTRACODE_CHANGE_NOTE.ref.code).toBe('model.ultracode-note');
    expect(ULTRACODE_CHANGE_NOTE.text).not.toBe(MODEL_CHANGE_WARNING.text);
    expect(ULTRACODE_CHANGE_NOTE.text).toMatch(/only to this session/u);
    // The “Model and Effort” sheet turns it off with the “No” segment (the same sentence as the app's
    // `header.ultracodeHint`).
    expect(ULTRACODE_CHANGE_NOTE.text).toMatch(/choose “No” in the same “Model and Effort” sheet\.$/u);
    expect(ULTRACODE_CHANGE_NOTE.text).not.toMatch(/toggle|switch/iu);
    // Bez backticków, jak `MODEL_CHANGE_WARNING`: zdanie idzie do UI jako zwykły tekst.
    expect(ULTRACODE_CHANGE_NOTE.text).not.toContain('`');
    expect(MODEL_CHANGE_WARNING.text).not.toContain('`');
  });

  it('formatModelLabel: lista przed heurystyką, nieznany kształt bez zmian', () => {
    expect(formatModelLabel('opus[1m]', FALLBACK_MODEL_CHOICES)).toBe('Opus');
    // Goły `opus` nie jest na liście — zostaje heurystyka, a ta zna tylko `claude-…`.
    expect(formatModelLabel('opus', FALLBACK_MODEL_CHOICES)).toBe('opus');
    expect(formatModelLabel('claude-fable-5')).toBe('Fable 5');
    expect(formatModelLabel('claude-fable-5-1')).toBe('Fable 5.1');
    expect(formatModelLabel('claude-opus-4-6')).toBe('Opus 4.6');
    expect(formatModelLabel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(formatModelLabel('mock-model')).toBe('mock-model');
    /*
     * Wariant okna PRZEŻYWA: konto miewa ten sam model w dwóch wariantach kontekstu i nawias
     * jest jedynym miejscem, po którym da się je rozróżnić. Zjadanie go dawałoby dwa różne
     * modele pod jedną nazwą — ta sama pomyłka, przez którą okno fable liczyło się pięciokrotnie
     * za małe (`KNOWN_CONTEXT_LIMITS`).
     */
    expect(formatModelLabel('claude-opus-5[1m]')).toBe('Opus 5 (1M)');
    expect(formatModelLabel('claude-opus-4-8')).toBe('Opus 4.8');
  });

  it('DirListing: poziom korzeni ma path null, wpisy z flagami', () => {
    expect(dirListingSchema.safeParse({
      path: null, parent: null, truncated: false,
      entries: [{ name: 'Projects', path: '/Users/x/Projects', git: false, history: false }],
    }).success).toBe(true);
    expect(dirListingSchema.safeParse({
      path: '/Users/x/Projects', parent: null, truncated: true,
      entries: [{ name: '', path: '/Users/x/Projects/a', git: true, history: true }],
    }).success).toBe(false);
  });

  it('MessageBody', () => {
    expect(messageBodySchema.safeParse({ text: 'cześć' }).success).toBe(true);
    expect(messageBodySchema.safeParse({ text: null }).success).toBe(false);
  });

  it('MessageBody: source and expectedConversation come both or neither', () => {
    const source = 'voice-agent';
    const expectedConversation = 'c0nversat10nT0ken-abcd';
    expect(messageBodySchema.safeParse({ text: 'run' }).success).toBe(true);
    expect(messageBodySchema.safeParse({ text: 'run', source, expectedConversation }).success).toBe(true);
    expect(messageBodySchema.safeParse({ text: 'run', source }).success).toBe(false);
    expect(messageBodySchema.safeParse({ text: 'run', expectedConversation }).success).toBe(false);
  });

  it('SeenBody: `by`, `stateSince` and `conversation` come all three or none, `by` only `voice-agent`, '
    + '`stateSince` and `conversation` 1 to 64 long', () => {
    const by = 'voice-agent';
    const stateSince = '2026-10-03T10:00:00.000Z';
    const conversation = 'c0nversat10nT0ken-abcd';
    const pickUp = { by, stateSince, conversation };
    expect(seenBodySchema.safeParse({}).success).toBe(true);
    expect(seenBodySchema.safeParse(pickUp).success).toBe(true);
    for (const part of [
      { by }, { stateSince }, { conversation }, { by, stateSince }, { by, conversation }, { stateSince, conversation },
    ]) {
      expect(seenBodySchema.safeParse(part).success, JSON.stringify(part)).toBe(false);
    }
    for (const other of ['human', '', null]) {
      expect(seenBodySchema.safeParse({ ...pickUp, by: other }).success, String(other)).toBe(false);
    }
    for (const field of ['stateSince', 'conversation'] as const) {
      expect(seenBodySchema.safeParse({ ...pickUp, [field]: 'x'.repeat(64) }).success, field).toBe(true);
      expect(seenBodySchema.safeParse({ ...pickUp, [field]: 'x'.repeat(65) }).success, field).toBe(false);
      expect(seenBodySchema.safeParse({ ...pickUp, [field]: '' }).success, field).toBe(false);
      expect(seenBodySchema.safeParse({ ...pickUp, [field]: null }).success, field).toBe(false);
    }
  });

  it('MessageBody z obrazkami', () => {
    expect(messageBodySchema.safeParse({ text: 'zobacz', images: [PNG, PNG] }).success).toBe(true);
    expect(messageBodySchema.safeParse({ text: '', images: [] }).success).toBe(true);

    // Za dużo obrazków.
    const zaDuzo = Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, () => PNG);
    expect(messageBodySchema.safeParse({ text: '', images: zaDuzo }).success).toBe(false);
    // Dokładnie limit jeszcze przechodzi.
    expect(messageBodySchema.safeParse({
      text: '', images: zaDuzo.slice(0, MAX_IMAGES_PER_MESSAGE),
    }).success).toBe(true);

    // Za duży obrazek.
    expect(messageBodySchema.safeParse({
      text: '', images: [dataUrlOfLength(MAX_IMAGE_DATA_URL_BYTES + 1)],
    }).success).toBe(false);
    expect(messageBodySchema.safeParse({
      text: '', images: [dataUrlOfLength(MAX_IMAGE_DATA_URL_BYTES)],
    }).success).toBe(true);

    // Zły format.
    expect(messageBodySchema.safeParse({ text: '', images: ['nie-data-url'] }).success).toBe(false);
    expect(messageBodySchema.safeParse({ text: '', images: [PNG, 42] }).success).toBe(false);
  });

  it('MessageBody z plikami', () => {
    expect(messageBodySchema.safeParse({
      text: 'przejrzyj', files: [{ name: 'raport.pdf', dataUrl: PDF }],
    }).success).toBe(true);
    expect(messageBodySchema.safeParse({ text: '', files: [] }).success).toBe(true);

    // Zdjęcia i pliki są NIEZALEŻNE: jedna wiadomość może nieść oba komplety naraz.
    expect(messageBodySchema.safeParse({
      text: 'oba', images: [PNG], files: [{ name: 'log.txt', dataUrl: PDF }],
    }).success).toBe(true);

    const file = { name: 'a.txt', dataUrl: PDF };
    const zaDuzo = Array.from({ length: MAX_FILES_PER_MESSAGE + 1 }, () => file);
    expect(messageBodySchema.safeParse({ text: '', files: zaDuzo }).success).toBe(false);
    expect(messageBodySchema.safeParse({
      text: '', files: zaDuzo.slice(0, MAX_FILES_PER_MESSAGE),
    }).success).toBe(true);

    expect(messageBodySchema.safeParse({
      text: '', files: [{ name: 'a.txt', dataUrl: fileDataUrlOfLength(MAX_FILE_DATA_URL_BYTES + 1) }],
    }).success).toBe(false);
    expect(messageBodySchema.safeParse({
      text: '', files: [{ name: 'a.txt', dataUrl: fileDataUrlOfLength(MAX_FILE_DATA_URL_BYTES) }],
    }).success).toBe(true);
  });

  it('plik przyjmuje DOWOLNY typ MIME, ale wyłącznie base64', () => {
    const ok = (dataUrl: string): boolean => fileAttachmentSchema
      .safeParse({ name: 'a', dataUrl }).success;

    expect(ok('data:application/pdf;base64,JVBERi0=')).toBe(true);
    expect(ok('data:text/x-log;base64,YWJj')).toBe(true);
    expect(ok('data:application/vnd.ms-excel;base64,YWJj')).toBe(true);
    // Bez `;base64` (data URL z procentowym kodowaniem) parser serwera dostałby śmieć.
    expect(ok('data:text/plain,zwykly-tekst')).toBe(false);
    expect(ok('data:text/plain;charset=utf-8;base64,YWJj')).toBe(false);
    expect(ok('/Users/u/raport.pdf')).toBe(false);
    expect(ok('data:;base64,YWJj')).toBe(false);
  });

  it('nazwa pliku bez separatorów ścieżki i bez znaków sterujących', () => {
    const ok = (name: string): boolean => fileAttachmentSchema
      .safeParse({ name, dataUrl: PDF }).success;

    expect(ok('raport q3 (final).pdf')).toBe(true);
    expect(ok('ą-ż-Ω.txt')).toBe(true);
    expect(ok('')).toBe(false);
    expect(ok('x'.repeat(MAX_FILE_NAME_CHARS))).toBe(true);
    expect(ok('x'.repeat(MAX_FILE_NAME_CHARS + 1))).toBe(false);
    // Ścieżka zamiast nazwy — obrona przed „../../.ssh/id_rsa" zaczyna się już w kontrakcie.
    expect(ok('../../etc/passwd')).toBe(false);
    expect(ok('C:\\Users\\u\\tajne.txt')).toBe(false);
    // Znak sterujący w nazwie to sekwencja ANSI w cudzym terminalu.
    expect(ok(`log${String.fromCharCode(27)}[2J.txt`)).toBe(false);
    expect(ok(`log${String.fromCharCode(10)}.txt`)).toBe(false);
    expect(isSafeFileName('raport.pdf')).toBe(true);
  });
  it('PermissionDecisionBody', () => {
    expect(permissionDecisionBodySchema.safeParse({ decision: 'allow' }).success).toBe(true);
    expect(permissionDecisionBodySchema.safeParse({ decision: 'deny', message: 'nie' }).success)
      .toBe(true);
    // 'expired' pochodzi wyłącznie od serwera — klient nie może go wysłać.
    expect(permissionDecisionBodySchema.safeParse({ decision: 'expired' }).success).toBe(false);
  });

  it('AnswersBody', () => {
    expect(answersBodySchema.safeParse({ answers: [['A'], ['B', 'C']] }).success).toBe(true);
    expect(answersBodySchema.safeParse({ answers: ['A'] }).success).toBe(false);
  });

  it('AnswersBody ma sufit długości wartości — wolny tekst z kanału hooka', () => {
    // Wartością bywa zdanie z pola „Własna odpowiedź", a nie tylko etykieta
    // z ekranu. Bez sufitu tekst dowolnej długości jechałby plikiem do `updatedInput.answers`.
    expect(MAX_ANSWER_TEXT_CHARS).toBeLessThan(MAX_MESSAGE_TEXT_CHARS);
    expect(answersBodySchema.safeParse({
      answers: [['x'.repeat(MAX_ANSWER_TEXT_CHARS)]],
    }).success).toBe(true);
    expect(answersBodySchema.safeParse({
      answers: [['x'.repeat(MAX_ANSWER_TEXT_CHARS + 1)]],
    }).success).toBe(false);
  });

  it('AnswersBody niesie notatki RÓWNOLEGLE do odpowiedzi, z sufitem CLI', () => {
    expect(answersBodySchema.safeParse({ answers: [['A'], ['B']], notes: ['ale bez paska', null] }).success)
      .toBe(true);
    expect(answersBodySchema.safeParse({
      answers: [['A']], notes: ['n'.repeat(MAX_ANSWER_NOTE_CHARS)],
    }).success).toBe(true);
    expect(answersBodySchema.safeParse({
      answers: [['A']], notes: ['n'.repeat(MAX_ANSWER_NOTE_CHARS + 1)],
    }).success).toBe(false);
    expect(answersBodySchema.safeParse({ answers: [['A']], notes: [7] }).success).toBe(false);
    // Sufity jak w walidatorze `updatedInput` CLI 2.1.288–2.1.293.
    expect(MAX_ANSWER_NOTE_CHARS).toBe(8192);
    expect(MAX_ANSWERS_TOTAL_CHARS).toBe(32768);
  });

  it('ClientLogBody', () => {
    expect(clientLogBodySchema.safeParse({
      events: [{ at: '2026-08-21T10:00:00.000Z', level: 'warn', msg: 'SSE offline' }],
    }).success).toBe(true);
    expect(clientLogBodySchema.safeParse({ events: [{ at: 'x', msg: 'brak level' }] }).success)
      .toBe(false);
  });
});

describe('lista sesji do wznowienia', () => {
  const entry: ResumableSession = {
    engineSessionId: 'e1d80687-b533-4ca2-9fab-6501df255f83',
    cwd: '/Users/x/Projects/willow',
    mtime: '2026-08-21T10:00:00.000Z',
    firstPrompt: 'Popraw zapis notatek — po restarcie gubi ostatnią zmianę.',
    gitBranch: 'fix/zapis-notatek',
    liveInHerdr: false,
  };

  it('round-trip wpisu i całej listy', () => {
    expect(resumableSessionSchema.parse(JSON.parse(JSON.stringify(entry)))).toEqual(entry);
    expect(resumableListSchema.parse({ sessions: [entry] })).toEqual({ sessions: [entry] });
    expect(resumableListSchema.parse({ sessions: [] })).toEqual({ sessions: [] });
  });

  it('gitBranch jest opcjonalne (API zna gałąź nie dla każdej sesji)', () => {
    const { gitBranch: _pominiete, ...bezGalezi } = entry;
    expect(resumableSessionSchema.parse(bezGalezi)).toEqual(bezGalezi);
  });

  it('odrzuca prompt ponad limit prezentacji i braki pól', () => {
    expect(resumableSessionSchema.safeParse({
      ...entry, firstPrompt: 'x'.repeat(MAX_FIRST_PROMPT_LENGTH + 1),
    }).success).toBe(false);
    expect(resumableSessionSchema.safeParse({ ...entry, engineSessionId: 42 }).success).toBe(false);
    expect(resumableSessionSchema.safeParse({ cwd: '/p' }).success).toBe(false);
  });

  it('limity kontraktu mają wartości ze speca', () => {
    expect(MAX_RESUMABLE_SESSIONS).toBe(20);
    expect(MAX_FIRST_PROMPT_LENGTH).toBe(120);
  });

  it('liveInHerdr jest WYMAGANE — „nie wiem" nie ma bezpiecznego zachowania', () => {
    const { liveInHerdr: _pominiete, ...bezFlagi } = entry;
    expect(resumableSessionSchema.safeParse(bezFlagi).success).toBe(false);
    const zywy = { ...entry, liveInHerdr: true };
    expect(resumableSessionSchema.parse(JSON.parse(JSON.stringify(zywy)))).toEqual(zywy);
  });
});

describe('sesje herdr w kontrakcie', () => {
  /*
   * `origin` zszedł z kontraktu: po wycięciu SDK sesja jest jedna, a pole z jedną
   * możliwą wartością to szum na telefonie. Test pilnuje, że nie wróciło tylnymi drzwiami —
   * `sessionSummarySchema` nie jest `strictObject`, więc sam parse by tego nie złapał.
   */
  it('origin NIE istnieje w kontrakcie sesji', () => {
    expect(Object.keys(sessionSummarySchema.shape)).not.toContain('origin');
    expect('origin' in sessionSummarySchema.parse(herdrSummary)).toBe(false);
  });

  /*
   * `ultracode` jest w schemacie jawnie: `sessionSummarySchema` nie jest `strictObject`, więc pole tylko
   * w typie ręcznym parse by po cichu zdejmował, a klient nigdy by go nie zobaczył.
   */
  it('ultracode istnieje w kontrakcie sesji jako opcjonalny bool', () => {
    expect(Object.keys(sessionSummarySchema.shape)).toContain('ultracode');
    for (const ultracode of [true, false]) {
      expect(sessionSummarySchema.parse({ ...herdrSummary, ultracode }).ultracode).toBe(ultracode);
    }
    expect('ultracode' in sessionSummarySchema.parse(herdrSummary)).toBe(false);
    expect(sessionSummarySchema.safeParse({ ...herdrSummary, ultracode: null }).success).toBe(false);
  });

  it('sesja panelowa przechodzi z kompletem swoich pól', () => {
    expect(sessionSummarySchema.parse(herdrSummary)).toEqual(herdrSummary);
  });

  /*
   * Powód odmowy karty: pole ADDYTYWNE obok `herdrDialog`, więc kontrakt musi przyjąć
   * sesję i z nim, i bez niego. Lista jest ta sama, którą liczy dziennik odmów — wartość spoza
   * `REFUSE_REASONS` nie ma prawa przejść, bo po drugiej stronie indeksuje `REFUSE_MESSAGES`.
   */
  it('herdrDialogReason: pole opcjonalne, powody zamknięte, każdy ma zdanie', () => {
    const withReason = { ...herdrSummary, herdrDialog: undefined, herdrDialogReason: 'multi-select' };
    expect(sessionSummarySchema.parse(JSON.parse(JSON.stringify(withReason))))
      .toMatchObject({ herdrDialogReason: 'multi-select' });
    expect('herdrDialogReason' in sessionSummarySchema.parse(herdrSummary)).toBe(false);
    expect(
      sessionSummarySchema.safeParse({ ...herdrSummary, herdrDialogReason: 'nie-ma-takiego' })
        .success,
    ).toBe(false);
    for (const reason of REFUSE_REASONS) expect(REFUSE_MESSAGES[reason].length).toBeGreaterThan(0);
  });

  /*
   * Wycinek ekranu na karcie: tak samo ADDYTYWNY jak powód i tak samo obecny WYŁĄCZNIE
   * przy karcie bez przycisków. Starszy serwer pola nie niesie i to jest wariant poprawny —
   * klient rysuje wtedy kartę bez bloku „Co widać w terminalu", a nie pusty blok.
   */
  it('herdrDialogScreen: pole opcjonalne, tekstowe, przechodzi w komplecie z powodem', () => {
    const zEkranem = {
      ...herdrSummary,
      herdrDialog: undefined,
      herdrDialogReason: 'multi-select',
      herdrDialogScreen: 'Które dodatki?\n[ ] Posypka\n[ ] Polewa',
    };
    expect(sessionSummarySchema.parse(JSON.parse(JSON.stringify(zEkranem))))
      .toMatchObject({ herdrDialogScreen: 'Które dodatki?\n[ ] Posypka\n[ ] Polewa' });
    expect('herdrDialogScreen' in sessionSummarySchema.parse(herdrSummary)).toBe(false);
    expect(
      sessionSummarySchema.safeParse({ ...herdrSummary, herdrDialogScreen: 42 }).success,
    ).toBe(false);
  });

  /*
   * Zadania w tle (`docs/background-tasks.md`): pole ADDYTYWNE, więc kontrakt musi
   * przyjąć sesję ZARÓWNO z nim, jak i bez niego — inaczej pierwszy panel bez ani jednego zadania
   * przestałby się parsować. Lista rodzajów jest ZAMKNIĘTA: wynik narzędzia, którego reduktor nie
   * rozpozna, nie jest startem zadania i na drut nie trafia ani on, ani nowa wartość rodzaju.
   */
  it('BackgroundTask: pole opcjonalne, rodzaje zamknięte, opis i czas startu opcjonalne', () => {
    const task = {
      id: 'b28xs0cd6',
      kind: 'command' as const,
      description: 'Run full RSpec suite',
      command: 'bundle exec rspec',
      startedAt: '2026-08-25T14:00:00.000Z',
    };
    expect(backgroundTaskSchema.parse(JSON.parse(JSON.stringify(task)))).toEqual(task);
    // Samo id i rodzaj wystarczą: zadanie sprzed okna ogona nie ma ani opisu, ani startu.
    expect(backgroundTaskSchema.parse({ id: 'a1', kind: 'agent' }))
      .toEqual({ id: 'a1', kind: 'agent' });
    expect(backgroundTaskSchema.safeParse({ id: 'x', kind: 'proces' }).success).toBe(false);
    expect(backgroundTaskSchema.safeParse({ id: '', kind: 'command' }).success).toBe(false);

    const withTasks = { ...herdrSummary, backgroundTasks: [task] };
    expect(sessionSummarySchema.parse(JSON.parse(JSON.stringify(withTasks)))).toEqual(withTasks);
    expect('backgroundTasks' in sessionSummarySchema.parse(herdrSummary)).toBe(false);
  });

  /*
   * Postój subagenta: `waitingSince` i `ownTasks` są ADDYTYWNE. Schemat MUSI je znać,
   * bo `z.object` odcina nieznane klucze. Kształt jest ścisły jak reszta zadania: `null` to nie
   * brak pola, a własna komenda bez identyfikatora nie ma klucza na liście.
   */
  it('BackgroundTask: waitingSince i ownTasks opcjonalne, round-trip, uszkodzony kształt odrzucony', () => {
    const agent = {
      id: 'a52b91f105b002e8d',
      kind: 'agent' as const,
      description: 'Shared views of panel sections',
      startedAt: '2026-10-09T21:39:58.000Z',
      waitingSince: '2026-10-09T21:51:18.000Z',
      ownTasks: [
        { id: 'bjvzo6rnl', command: 'until grep -q "TEST" log; do sleep 5; done',
          startedAt: '2026-10-09T22:29:07.000Z' },
        { id: 'b7' },
      ],
    };
    expect(backgroundTaskSchema.parse(JSON.parse(JSON.stringify(agent)))).toEqual(agent);
    const withAgent = { ...herdrSummary, backgroundTasks: [agent] };
    expect(sessionSummarySchema.parse(JSON.parse(JSON.stringify(withAgent)))).toEqual(withAgent);
    // Agent pracujący z własną komendą i agent w postoju bez znanych komend: pola są niezależne.
    expect(backgroundTaskSchema.parse({ id: 'a1', kind: 'agent', ownTasks: [{ id: 'b1' }] }))
      .toEqual({ id: 'a1', kind: 'agent', ownTasks: [{ id: 'b1' }] });
    expect(backgroundTaskSchema.parse({ id: 'a1', kind: 'agent', waitingSince: agent.waitingSince }))
      .toEqual({ id: 'a1', kind: 'agent', waitingSince: agent.waitingSince });

    const broken: Record<string, unknown>[] = [
      { waitingSince: null },
      { waitingSince: 1_790_000_000 },
      { ownTasks: null },
      { ownTasks: 'bjvzo6rnl' },
      { ownTasks: [{ command: 'sleep 9' }] },
      { ownTasks: [{ id: '' }] },
      { ownTasks: [{ id: 'b1', command: 9 }] },
      { ownTasks: [{ id: 'b1', startedAt: null }] },
    ];
    for (const fields of broken) {
      expect(backgroundTaskSchema.safeParse({ id: 'a1', kind: 'agent', ...fields }).success,
        JSON.stringify(fields)).toBe(false);
    }
    // Nieznany klucz własnej komendy to forward-compat: odcięty, pozycja zostaje.
    expect(backgroundTaskSchema.parse({ id: 'a1', kind: 'agent', ownTasks: [{ id: 'b1', pid: 7 }] }))
      .toEqual({ id: 'a1', kind: 'agent', ownTasks: [{ id: 'b1' }] });
  });

  it('TranscriptNotice: wynik `waiting` (postój subagenta) jest wartością kontraktu, nieznany nie', () => {
    const notice = { kind: 'agent' as const, outcome: 'waiting' as const, name: 'Shared views' };
    expect(transcriptNoticeSchema.parse(JSON.parse(JSON.stringify(notice)))).toEqual(notice);
    for (const outcome of ['done', 'failed', 'halted', 'waiting']) {
      expect(transcriptNoticeSchema.safeParse({ kind: 'agent', outcome }).success, outcome).toBe(true);
    }
    expect(transcriptNoticeSchema.safeParse({ kind: 'agent', outcome: 'paused' }).success).toBe(false);
  });

  /*
   * The Claude Code release pair travels only when an update is available. Additive field — absence means
   * "current or unknown" and the client stays silent. The schema MUST know it, because `z.object` strips
   * unknown keys and the server would send a pill the client never sees.
   */
  it('cliUpdate: round-trip, brak pola przy braku aktualizacji, zły typ odrzucony', () => {
    const withUpdate = { ...herdrSummary, cliUpdate: { running: '2.1.280', installed: '2.1.283' } };
    expect(sessionSummarySchema.parse(JSON.parse(JSON.stringify(withUpdate)))).toEqual(withUpdate);
    expect('cliUpdate' in sessionSummarySchema.parse(herdrSummary)).toBe(false);
    expect(sessionSummarySchema.safeParse({ ...herdrSummary, cliUpdate: '2.1.283' }).success)
      .toBe(false);
    expect(sessionSummarySchema.safeParse({ ...herdrSummary, cliUpdate: { running: '2.1.280' } })
      .success).toBe(false);
  });

  /*
   * Okno kontekstu jest ZNANE albo NIEZNANE. Trzeciego wariantu nie ma, bo
   * zgadywany próg pokazywałby sesji 1M ~92 % przy 185k, a potem skok na 18 % — alarm bez
   * powodu. Test pilnuje, że `unknown` nie umie przemycić `limit`.
   */
  it('ContextLimitState: unknown nie niesie limitu, known niesie źródło', () => {
    expect(contextLimitStateSchema.safeParse({ kind: 'unknown', tokens: 185_000 }).success)
      .toBe(true);
    expect(contextLimitStateSchema.parse({ kind: 'unknown', tokens: 1, limit: 200_000 }))
      .toEqual({ kind: 'unknown', tokens: 1 });
    expect(contextLimitStateSchema.safeParse({
      kind: 'known', tokens: 1, limit: 200_000, source: 'compact-boundary',
    }).success).toBe(true);
    expect(contextLimitStateSchema.safeParse({
      kind: 'known', tokens: 1, limit: 200_000, source: 'zgadywanie',
    }).success).toBe(false);
    expect(contextLimitStateSchema.safeParse({ kind: 'known', tokens: 1, limit: 1 }).success)
      .toBe(false);
    expect(contextLimitStateSchema.safeParse({ kind: 'byle-co', tokens: 1 }).success).toBe(false);
  });

  it('KNOWN_CONTEXT_LIMITS: fable = 1M (5.1 z dokumentacji API), reszta flag = 200k', () => {
    for (const { value } of FALLBACK_MODEL_CHOICES) {
      expect(KNOWN_CONTEXT_LIMITS[value]).toBe(value === 'fable' || value === 'opus[1m]' ? 1_000_000 : 200_000);
    }
    // Alias `fable` NIE zastępuje pełnych identyfikatorów: te niesie jsonl sesji spoza Raroga.
    expect(KNOWN_CONTEXT_LIMITS['claude-fable-5']).toBe(1_000_000);
    expect(KNOWN_CONTEXT_LIMITS['claude-fable-5-1']).toBe(1_000_000);
    // Klucz `[1m]` nie istnieje — wariant siedzi w ustawieniu konta, a jsonl niesie czysty id.
    expect(KNOWN_CONTEXT_LIMITS['claude-fable-5[1m]']).toBeUndefined();
    // Opus 5.5: goły `opus` i rozwiązany `claude-opus-5-5` to okno 1M.
    expect(KNOWN_CONTEXT_LIMITS['opus']).toBe(1_000_000);
    expect(KNOWN_CONTEXT_LIMITS['claude-opus-5-5']).toBe(1_000_000);
    expect(KNOWN_CONTEXT_LIMITS['claude-opus-5-5[1m]']).toBeUndefined();
  });

  /*
   * One Fable and one Opus, always the newest. The list holds ONLY family aliases that the CLI resolves to
   * the newest version — no full id, because every such entry would need a Rarog change for a new version.
   * The list is the allow-list of the `--model` flag (`isKnownModel`), so this one place decides what Rarog
   * may START. Reading is separate: the jsonl of sessions started outside Rarog carries full ids, so their
   * window and label STAY.
   */
  it('lista modeli to same aliasy rodzin — jeden fable, jeden opus', () => {
    expect(FALLBACK_MODEL_CHOICES.map((choice) => choice.value))
      .toEqual(['fable', 'opus[1m]', 'sonnet', 'haiku']);
    for (const { value } of FALLBACK_MODEL_CHOICES) expect(value.startsWith('claude-')).toBe(false);
    expect(formatModelLabel('fable', FALLBACK_MODEL_CHOICES)).toBe('Fable');
    // „Opus" na liście to wariant 1M: wybór Opusa ustawia okno 1M.
    expect(formatModelLabel('opus[1m]', FALLBACK_MODEL_CHOICES)).toBe('Opus');
    expect(KNOWN_CONTEXT_LIMITS['opus[1m]']).toBe(1_000_000);
  });

  it('pełne identyfikatory Fable zniknęły z WYBORU, ale nie z ODCZYTU', () => {
    expect(KNOWN_CONTEXT_LIMITS['claude-fable-5']).toBe(1_000_000);
    expect(formatModelLabel('claude-fable-5')).toBe('Fable 5');
    expect(formatModelLabel('claude-fable-5-1')).toBe('Fable 5.1');
  });

  it('modelAlias: rozwiązany identyfikator zwija się do aliasu SWOJEJ rodziny z listy', () => {
    expect(modelAlias('claude-fable-5-1', FALLBACK_MODEL_CHOICES)).toBe('fable');
    expect(modelAlias('claude-haiku-4-5-20251001', FALLBACK_MODEL_CHOICES)).toBe('haiku');
    // Wariant okna jest CZĘŚCIĄ dopasowania: rodzina + ten sam sufiks.
    expect(modelAlias('claude-opus-5[1m]', FALLBACK_MODEL_CHOICES)).toBe('opus[1m]');
    // Świadomy koszt: starsza wersja rodziny też podpada pod alias.
    expect(modelAlias('claude-opus-4-8[1m]', FALLBACK_MODEL_CHOICES)).toBe('opus[1m]');
    // Goła rodzina łapie tylko identyfikator bez sufiksu.
    const plain = [{ value: 'opus', label: 'Opus', effortLevels: [] }];
    expect(modelAlias('claude-opus-5', plain)).toBe('opus');
    expect(modelAlias('claude-opus-5[1m]', plain)).toBe('claude-opus-5[1m]');
  });

  it('modelAlias: 200k Opus NIE zwija się do „Opus" 1M — to inne okno, arkusz ma dać przejść', () => {
    expect(modelAlias('claude-opus-5', FALLBACK_MODEL_CHOICES)).toBe('claude-opus-5');
  });

  it('modelAlias: alias, obca rodzina i nieznany kształt wracają bez zmian', () => {
    expect(modelAlias('opus[1m]', FALLBACK_MODEL_CHOICES)).toBe('opus[1m]');
    expect(modelAlias('claude-mythos-1', FALLBACK_MODEL_CHOICES)).toBe('claude-mythos-1');
    expect(modelAlias('mock-model', FALLBACK_MODEL_CHOICES)).toBe('mock-model');
    expect(modelAlias('claude-opus-5', [])).toBe('claude-opus-5');
  });

  it('MODEL_ID_PATTERN: sufiks `[1m]` przechodzi, inne nawiasy nie', () => {
    for (const ok of ['opus[1m]', 'claude-opus-5[1m]', 'opus', 'claude-fable-5-1']) {
      expect(modelIdSchema.safeParse(ok).success).toBe(true);
    }
    for (const bad of ['opus[2m]', 'opus[1m', 'opus[1m]x', '[1m]', 'opus[1m][1m]', 'opus [1m]']) {
      expect(modelIdSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('launchedByRarog i paneId są opcjonalne, ale typowane', () => {
    expect(sessionSummarySchema.safeParse({ ...summary, launchedByRarog: 'tak' }).success)
      .toBe(false);
    expect(sessionSummarySchema.safeParse({ ...summary, paneId: 7 }).success).toBe(false);
  });

  it('pola panelu są opcjonalne — sesja bez panelu ich nie niesie', () => {
    const parsed = sessionSummarySchema.parse(JSON.parse(JSON.stringify(summary)));
    expect('seen' in parsed).toBe(false);
    expect('stale' in parsed).toBe(false);
    expect('herdrMode' in parsed).toBe(false);
    expect('outOfScope' in parsed).toBe(false);
    // Aktywność też: summary sesji, która nie pracuje, NIE ma tego pola (a nie ma `kind: 'idle'`).
    expect('activity' in parsed).toBe(false);
  });

  /*
   * Aktywność w summary jest ULOTNA: serwer dokłada ją tylko sesji, która naprawdę pracuje,
   * żeby wiersz listy miał treść bez subskrypcji transkryptu. Kontrakt musi ją znać, inaczej
   * `parseServerEvent` wycinałby ją po drodze i lista dalej dostawałaby sam stan.
   */
  it('summary sesji pracującej przenosi activity przez kontrakt', () => {
    const working: SessionSummary = {
      ...summary,
      state: 'running',
      activity: { kind: 'tool', toolName: 'Bash', summary: 'pnpm test', elapsedSeconds: 148 },
    };
    expect(sessionSummarySchema.parse(JSON.parse(JSON.stringify(working)))).toEqual(working);
    // I ta sama droga, którą jedzie naprawdę: przez `sessions-snapshot`.
    const snapshot = { type: 'sessions-snapshot', sessions: [working] };
    expect(parseServerEvent(snapshot)).toEqual(snapshot);
  });

  it('zły kształt activity w summary jest odrzucany, a nie przepuszczany po cichu', () => {
    expect(sessionSummarySchema.safeParse({ ...summary, activity: { kind: 'mieli' } }).success)
      .toBe(false);
    expect(sessionSummarySchema.safeParse({ ...summary, activity: 'myśli…' }).success).toBe(false);
    expect(sessionSummarySchema.safeParse({
      ...summary, activity: { kind: 'tool', elapsedSeconds: '148' },
    }).success).toBe(false);
  });

  it('herdrMode ma cztery realne tryby plus unknown', () => {
    for (const mode of ['manual', 'plan', 'auto', 'bypass', 'unknown']) {
      expect(sessionSummarySchema.safeParse({ ...herdrSummary, herdrMode: mode }).success)
        .toBe(true);
    }
    expect(sessionSummarySchema.safeParse({ ...herdrSummary, herdrMode: 'yolo' }).success)
      .toBe(false);
  });

  it('herdrStatus w ramce snapshotu jest opcjonalny (integracja wyłączona)', () => {
    const bezStatusu = { type: 'sessions-snapshot', sessions: [summary] };
    const parsed = parseServerEvent(bezStatusu);
    expect(parsed).toEqual(bezStatusu);
    expect(parsed?.type === 'sessions-snapshot' && 'herdrStatus' in parsed).toBe(false);
  });

  it('herdrStatus wymaga kompletu czterech pól', () => {
    expect(herdrStatusSchema.safeParse({ available: true, agentCount: 3 }).success).toBe(false);
    const pelny = { available: true, agentCount: 0, readOnly: true, canLaunch: false };
    expect(herdrStatusSchema.parse(pelny)).toEqual(pelny);
  });

  it('event herdr-status jest globalny — nie ma w nim sessionId', () => {
    const ev = { type: 'herdr-status', available: true, agentCount: 17, readOnly: true };
    const parsed = parseServerEvent(ev);
    expect(parsed).toEqual(ev);
    expect(parsed && 'sessionId' in parsed).toBe(false);
    expect(parseServerEvent({ type: 'herdr-status', available: true })).toBeNull();
  });

  it('limit promptu do panelu jest osobny i mniejszy niż limit ciała wiadomości', () => {
    expect(MAX_HERDR_PROMPT_BYTES).toBe(512 * 1024);
    expect(MAX_HERDR_PROMPT_BYTES).toBeLessThan(MAX_MESSAGE_TEXT_CHARS);
  });

  it('messageBodySchema ucina tekst ponad 1 M znaków', () => {
    expect(messageBodySchema.safeParse({ text: 'x'.repeat(MAX_MESSAGE_TEXT_CHARS) }).success)
      .toBe(true);
    expect(messageBodySchema.safeParse({ text: 'x'.repeat(MAX_MESSAGE_TEXT_CHARS + 1) }).success)
      .toBe(false);
  });
});

describe('checkMessageImageLimits (wejście routera → 413)', () => {
  it('brak obrazków albo zachowane limity → null', () => {
    expect(checkMessageImageLimits({ text: 'hej' })).toBeNull();
    expect(checkMessageImageLimits({ text: 'hej', images: [PNG] })).toBeNull();
    expect(checkMessageImageLimits({
      text: '', images: Array.from({ length: MAX_IMAGES_PER_MESSAGE }, () => PNG),
    })).toBeNull();
  });

  it('rozpoznaje przekroczone limity na SUROWYM ciele (przed schematem)', () => {
    expect(checkMessageImageLimits({
      images: Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, () => PNG),
    })).toBe('too-many');
    expect(checkMessageImageLimits({
      images: [PNG, dataUrlOfLength(MAX_IMAGE_DATA_URL_BYTES + 1)],
    })).toBe('too-large');
  });

  it('śmieciowe wejście nie jest jego problemem (od tego jest schemat)', () => {
    expect(checkMessageImageLimits(null)).toBeNull();
    expect(checkMessageImageLimits('tekst')).toBeNull();
    expect(checkMessageImageLimits({ images: 'nie tablica' })).toBeNull();
    expect(checkMessageImageLimits({ images: [42, null] })).toBeNull();
    expect(checkMessageImageLimits({ files: 'nie tablica' })).toBeNull();
    expect(checkMessageImageLimits({ files: [42, null, {}] })).toBeNull();
  });

  it('pliki mają WŁASNE powody odrzucenia, nie te od obrazków', () => {
    const file = { name: 'a.txt', dataUrl: PDF };
    expect(checkMessageImageLimits({ files: [file] })).toBeNull();
    expect(checkMessageImageLimits({
      files: Array.from({ length: MAX_FILES_PER_MESSAGE }, () => file),
    })).toBeNull();

    expect(checkMessageImageLimits({
      files: Array.from({ length: MAX_FILES_PER_MESSAGE + 1 }, () => file),
    })).toBe('files-too-many');
    expect(checkMessageImageLimits({
      files: [file, { name: 'b.bin', dataUrl: fileDataUrlOfLength(MAX_FILE_DATA_URL_BYTES + 1) }],
    })).toBe('file-too-large');
  });

  it('gdy przekroczone są oba komplety, wygrywa powód od obrazków', () => {
    // Komunikat 413 ma dotyczyć tego, co użytkownik dokłada najczęściej — nie obu naraz.
    expect(checkMessageImageLimits({
      images: Array.from({ length: MAX_IMAGES_PER_MESSAGE + 1 }, () => PNG),
      files: Array.from({ length: MAX_FILES_PER_MESSAGE + 1 }, () => ({ name: 'a', dataUrl: PDF })),
    })).toBe('too-many');
  });

  it('limit ciała wiadomości mieści komplet obrazków I komplet plików', () => {
    expect(MAX_MESSAGE_BODY_BYTES).toBeGreaterThan(
      MAX_IMAGES_PER_MESSAGE * MAX_IMAGE_DATA_URL_BYTES
      + MAX_FILES_PER_MESSAGE * MAX_FILE_DATA_URL_BYTES,
    );
  });
});

describe('label sesji (człon `sesja` w tytule `projekt · sesja`)', () => {
  it('przechodzi round-trip razem z resztą podsumowania', () => {
    const parsed = sessionSummarySchema.parse(JSON.parse(JSON.stringify(summary)));
    expect(parsed.label).toBe('zapis notatek');
    expect(parsed).toEqual(summary);
  });

  it('jest opcjonalny — starsza sesja bez pola nadal się parsuje', () => {
    const { label: _bezLabela, ...stara } = summary;
    const parsed = sessionSummarySchema.parse(stara);
    expect('label' in parsed).toBe(false);
    expect(parsed).toEqual(stara);
  });

  it('odrzuca label innego typu niż string', () => {
    expect(sessionSummarySchema.safeParse({ ...summary, label: 42 }).success).toBe(false);
  });

  it('`title` (projekt) i `label` (sesja) to dwa osobne pola', () => {
    expect(summary.title).toBe('willow');
    expect(summary.label).not.toBe(summary.title);
  });
});

describe('git: diff sesji', () => {
  const diff: SessionDiff = {
    files: [
      { path: 'src/notes.ts', status: 'M', linesAdded: 8, linesDeleted: 4 },
      { path: 'src/notes.test.ts', status: 'A', linesAdded: 26, linesDeleted: 0 },
      { path: 'src/stary.ts', status: 'D', linesAdded: 0, linesDeleted: 31 },
    ],
    patch: 'diff --git a/src/notes.ts b/src/notes.ts\n@@\n-stare\n+nowe\n',
    truncated: false,
  };

  it('round-trip pełnej odpowiedzi', () => {
    expect(sessionDiffSchema.parse(JSON.parse(JSON.stringify(diff)))).toEqual(diff);
  });

  it('pusty diff (czyste repo) jest poprawny', () => {
    expect(sessionDiffSchema.parse({ files: [], patch: '', truncated: false }))
      .toEqual({ files: [], patch: '', truncated: false });
  });

  it('status pliku to wyłącznie A/M/D', () => {
    const file: DiffFile = { path: 'a.ts', status: 'A', linesAdded: 1, linesDeleted: 0 };
    expect(diffFileSchema.parse(file)).toEqual(file);
    expect(diffFileSchema.safeParse({ ...file, status: 'R' }).success).toBe(false);
    expect(diffFileSchema.safeParse({ ...file, status: '?' }).success).toBe(false);
  });

  it('odrzuca braki pól i złe typy', () => {
    expect(sessionDiffSchema.safeParse({ files: [], patch: '' }).success).toBe(false);
    expect(sessionDiffSchema.safeParse({ files: [], patch: 12, truncated: false }).success)
      .toBe(false);
    expect(sessionDiffSchema.safeParse({
      files: [{ path: 'a.ts', status: 'M', linesAdded: '3', linesDeleted: 0 }],
      patch: '', truncated: false,
    }).success).toBe(false);
  });

  it('limit patcha ze speca to 512 kB', () => {
    expect(MAX_DIFF_PATCH_BYTES).toBe(512 * 1024);
  });
});

describe('git: diff sesji per plik', () => {
  const list: DiffFileList = {
    files: [
      { path: 'src/notes.ts', status: 'M', linesAdded: 8, linesDeleted: 4 },
      { path: 'assets/logo.png', status: 'M', binary: true },
      // Nieśledzony: bez liczników — brak znaczy „nie wiem", nie zero.
      { path: 'docs/za ż+%&#.md', status: 'A' },
      { path: 'src/stary.ts', status: 'D', linesAdded: 0, linesDeleted: 31 },
    ],
    truncated: false,
  };
  const patch: DiffFilePatch = {
    path: 'src/notes.ts', patch: 'diff --git a/src/notes.ts b/src/notes.ts\n@@\n-stare\n+nowe\n', truncated: false,
  };

  it('round-trip listy i patcha pliku; pusta lista i ucięcie są poprawne', () => {
    expect(diffFileListSchema.parse(JSON.parse(JSON.stringify(list)))).toEqual(list);
    expect(diffFilePatchSchema.parse(JSON.parse(JSON.stringify(patch)))).toEqual(patch);
    expect(diffFileListSchema.parse({ files: [], truncated: true })).toEqual({ files: [], truncated: true });
    expect(diffFilePatchSchema.parse({ ...patch, truncated: true }).truncated).toBe(true);
  });

  it('liczniki są opcjonalne, ale nie ujemne ani ułamkowe; `binary` to literał true', () => {
    const entry = { path: 'a.ts', status: 'M' };
    expect(diffListEntrySchema.parse(entry)).toEqual(entry);
    expect(diffListEntrySchema.safeParse({ ...entry, linesAdded: -1 }).success).toBe(false);
    expect(diffListEntrySchema.safeParse({ ...entry, linesDeleted: 1.5 }).success).toBe(false);
    expect(diffListEntrySchema.safeParse({ ...entry, linesAdded: null }).success).toBe(false);
    expect(diffListEntrySchema.safeParse({ ...entry, binary: false }).success).toBe(false);
    expect(diffListEntrySchema.safeParse({ ...entry, status: 'R' }).success).toBe(false);
  });

  it('odrzuca braki pól i złe typy; nieznany klucz odcina', () => {
    expect(diffFileListSchema.safeParse({ files: [] }).success).toBe(false);
    expect(diffFileListSchema.safeParse({ files: [{ path: 'a.ts' }], truncated: false }).success).toBe(false);
    expect(diffFilePatchSchema.safeParse({ path: 'a.ts', patch: 'x' }).success).toBe(false);
    expect(diffFilePatchSchema.safeParse({ path: 'a.ts', patch: null, truncated: false }).success).toBe(false);
    expect(diffFilePatchSchema.parse({ ...patch, przyszlePole: 1 })).toEqual(patch);
  });

  it('kody błędów tras są częścią kontraktu', () => {
    expect([
      DIFF_BAD_PATH_ERROR, DIFF_FILE_NOT_FOUND_ERROR, DIFF_SESSION_NOT_FOUND_ERROR, DIFF_GIT_FAILED_ERROR,
    ]).toEqual(['bad-path', 'diff-file-not-found', 'session-not-found', 'git-failed']);
    // `not-found` zostaje dla routera („nie ma takiego endpointu") — brak sesji ma własny kod.
    expect(DIFF_SESSION_NOT_FOUND_ERROR).not.toBe('not-found');
  });
});

describe('notatki projektu', () => {
  const doc = { text: 'deploy wymaga restartu herdr', updatedAt: 1_756_800_000_000 };

  it('event `notes` niesie katalog i bit `empty` — bez treści i bez sessionId', () => {
    const parsed = parseServerEvent({ type: 'notes', cwd: '/Users/d/Projects/rarog', empty: false });
    expect(parsed).toEqual({ type: 'notes', cwd: '/Users/d/Projects/rarog', empty: false });
    // Pusty katalog nie jest adresem projektu — ramka bez `cwd` nie miałaby czego odświeżyć.
    expect(parseServerEvent({ type: 'notes', cwd: '', empty: false })).toBeNull();
    expect(parseServerEvent({ type: 'notes' })).toBeNull();
    // Bit „pusty po zapisie" jest OBOWIĄZKOWY: to on zapala i gasi kolor pigułki ✎,
    // a ramka bez niego kazałaby klientowi zgadywać albo robić GET po każdym autosave.
    expect(parseServerEvent({ type: 'notes', cwd: '/p' })).toBeNull();
    // Treść notatek w ramce GLOBALNEJ byłaby wyciekiem do klientów w zupełnie innym projekcie.
    expect(parseServerEvent({ type: 'notes', cwd: '/p', empty: true, text: 'sekret' }))
      .toEqual({ type: 'notes', cwd: '/p', empty: true });
  });

  it('`notesEmpty` — pustka to także sam biały znak, jedna definicja dla obu stron', () => {
    expect(notesEmpty('')).toBe(true);
    expect(notesEmpty(' \n\t')).toBe(true);
    expect(notesEmpty('a')).toBe(false);
  });

  it('odczyt oddaje CAŁY dokument, a pustka jest jego poprawną wartością', () => {
    expect(notesGetResponseSchema.safeParse(doc).success).toBe(true);
    // Projekt bez pliku — `updatedAt: 0` znaczy „na dysku nie ma jeszcze niczego".
    expect(notesGetResponseSchema.safeParse({ text: '', updatedAt: 0 }).success).toBe(true);
    expect(notesGetResponseSchema.safeParse({ text: 'x' }).success).toBe(false);
    expect(notesDocSchema.safeParse({ text: 1, updatedAt: 0 }).success).toBe(false);
  });

  it('zapis niesie WERSJĘ, a pusty tekst jest zamiarem, nie błędem klienta', () => {
    const body = { cwd: '/p', text: 'x', updatedAt: doc.updatedAt };
    expect(notesPutBodySchema.safeParse(body).success).toBe(true);
    // Wyczyszczenie pola to jedyna droga do skasowania treści — `min(1)` by ją zamknęło.
    expect(notesPutBodySchema.safeParse({ ...body, text: '' }).success).toBe(true);
    // Bez wersji nie ma czym wykryć rozjazdu dwóch urządzeń — to jest pole WYMAGANE.
    expect(notesPutBodySchema.safeParse({ cwd: '/p', text: 'x' }).success).toBe(false);
    expect(notesPutBodySchema.safeParse({ ...body, text: 'x'.repeat(NOTES_MAX_CHARS) }).success)
      .toBe(true);
    expect(notesPutBodySchema.safeParse({ ...body, text: 'x'.repeat(NOTES_MAX_CHARS + 1) }).success)
      .toBe(false);
  });

  it('odpowiedź zapisu to SAM znacznik, a 409 niesie treść z dysku', () => {
    expect(notesPutResponseSchema.safeParse({ updatedAt: 1 }).success).toBe(true);
    expect(notesConflictBodySchema.safeParse({
      error: 'conflict', message: 'Notatki zmieniły się na innym urządzeniu.', current: doc,
    }).success).toBe(true);
    // 409 BEZ treści z dysku byłby loterią: człowiek nie ma jak zobaczyć, co właśnie nadpisuje.
    expect(notesConflictBodySchema.safeParse({ error: 'conflict', message: 'x' }).success)
      .toBe(false);
  });

  it('sufity są liczbami, na które da się wskazać palcem', () => {
    expect(NOTES_MAX_CHARS).toBe(48 * 1024);
    /*
     * Sufit ciała musi zmieścić NAJGORSZY przypadek kodowania: znak UTF-8 waży do czterech
     * bajtów, więc dokument w granicach kontraktu odbijałby się od globalnych 64 kB jako 413.
     */
    expect(NOTES_BODY_MAX_BYTES).toBeGreaterThanOrEqual(NOTES_MAX_CHARS * 4);
  });
});
