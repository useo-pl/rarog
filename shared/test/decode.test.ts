/**
 * Dekoder kliencki z tolerancją nieznanych wartości — `shared/src/decode.ts`.
 *
 * Granica, której ten plik pilnuje, ma dwie strony i obie są równie ważne:
 * - nieznany ŁAŃCUCH w polu wyliczeniowym degraduje jedno pole (wartość zapasowa albo brak pola),
 *   a `degradations` wskazuje DOKŁADNIE to pole — inaczej raport do `client.log` kłamie;
 * - uszkodzony kształt (`null`, brak pola, zły typ, uszkodzony znany blok, nieznana wartość
 *   NIE-łańcuch) dalej odrzuca ramkę. Tolerancja szersza niż „nieznany łańcuch" ukryłaby błąd
 *   producenta za kartą „nieobsługiwana".
 *
 * Ramki są syntetyczne i kształtem poprawne; semantycznie nie muszą (dialog, zgoda i aktywność
 * w jednym podsumowaniu) — każde pole wyliczeniowe ma tu po prostu mieć z czego się zdegradować.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  DEGRADATIONS,
  UNSUPPORTED,
  decodeServerEvent,
  type ClientBlock,
  type ClientSessionState,
} from '../src/decode.ts';
import {
  CLI_DIALOG_CLASSES, backgroundTaskSchema, helloEventSchema, parseServerEvent, sessionPullRequestSchema,
  sessionSummarySchema, transcriptMessageSchema, transcriptNoticeSchema,
} from '../src/protocol.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const AT = '2026-10-03T10:00:00.000Z';

const summary = {
  id: 's1', cwd: '/Users/demo/projekt', title: 'projekt', label: 'popraw testy', state: 'running',
  stateSince: AT, createdAt: AT, lastActivityAt: AT,
  effort: 'high', herdrMode: 'auto', herdrDialog: 'trust', herdrDialogReason: 'mismatch',
  cliDialog: 'dialog', engine: 'codex',
  context: { kind: 'known', tokens: 1_000, limit: 200_000, source: 'model' },
  activity: { kind: 'tool', toolName: 'Agent', summary: 'Przegląd', delegation: 'agents' },
  backgroundTasks: [{ id: 'b1', kind: 'command', command: 'sleep 9' }],
  waitingFor: { kind: 'permission', tool: 'Bash', text: 'pnpm test', subject: 'tool' },
  pullRequests: [
    {
      url: 'https://github.com/demo/projekt/pull/2', repo: 'demo/projekt', number: 2, createdAt: AT,
      title: 'Popraw testy', state: 'merged',
    },
    { url: 'https://github.com/demo/projekt/pull/1', repo: 'demo/projekt', number: 1, createdAt: AT },
  ],
};

const message = {
  seq: 1, role: 'assistant', at: AT,
  blocks: [
    { type: 'text', text: 'Gotowe.' },
    {
      type: 'tool-call', toolName: 'Edit', summary: 'a.ts', detail: '+x', detailKind: 'diff',
      inputKind: 'json',
    },
    { type: 'image', dataUrl: 'data:image/png;base64,AAAA' },
    {
      type: 'tool-call', toolName: 'Agent', summary: 'Przegląd', delegation: 'agents',
      inputKind: 'json',
    },
  ],
  attachments: [{ kind: 'image', name: '', bytes: 3, mime: 'image/png' }],
};

/** Notka harnessu: wpis `user` z surowym tekstem i polem `notice` z faktami. */
const noticeMessage = {
  seq: 2, role: 'user', at: AT,
  blocks: [{ type: 'text', text: '<task-notification>\n<status>failed</status>\n</task-notification>' }],
  notice: { kind: 'command', outcome: 'failed', name: 'pnpm test', exitCode: 1 },
};

const permission = {
  permId: 'p1', sessionId: 's1', toolName: 'Bash', displayText: 'pnpm test', risk: 'normal',
  cwd: '/Users/demo/projekt', createdAt: AT, subject: 'tool', inputKind: 'shell',
};

/** Karta kanału zgód: stan, powód braku zgody i uwaga prezentacji. */
const hookPermission = {
  ...permission, permId: 'k1', channel: 'hook', state: 'pending', canAllow: false, unavailable: 'no-proof',
  fields: [{ name: 'description', value: 'testy' }], notes: ['sandbox-disabled'],
};

const question = {
  qId: 'q1', sessionId: 's1', createdAt: AT, channel: 'hook', customAnswer: true,
  questions: [{
    question: 'Który wariant?', header: 'Wariant', multiSelect: false,
    options: [
      { label: 'A', role: 'answer' }, { label: 'B', description: 'wolniejszy', role: 'answer' },
      { label: 'Chat about this', role: 'exit' },
    ],
  }],
};

const inboxHeads = [
  {
    sessionId: 's1', turnId: 't1', version: 'v1', kind: 'decision', state: 'waiting-permission', at: AT,
    dialog: 'permission',
  },
  { sessionId: 's2', turnId: 't2', version: 'v2', kind: 'result', state: 'waiting-input', at: AT },
  { sessionId: 's3', turnId: 't3', version: 'v3', kind: 'failed', state: 'error', at: AT },
];

const FRAMES = {
  snapshot: { type: 'sessions-snapshot', sessions: [summary, { ...summary, id: 's2' }] },
  changed: { type: 'session-changed', session: summary },
  transcript: {
    type: 'transcript-snapshot', sessionId: 's1', messages: [message],
    pendingPermissions: [permission], pendingQuestions: [question], activity: { kind: 'thinking' },
  },
  message: { type: 'message', sessionId: 's1', message },
  notice: { type: 'message', sessionId: 's1', message: noticeMessage },
  permissionPending: { type: 'permission-pending', request: permission },
  hookPending: { type: 'permission-pending', request: hookPermission },
  settled: {
    type: 'permission-settled', sessionId: 's1', permId: 'k1', state: 'sent', canAllow: false,
    unavailable: 'no-proof', at: AT,
  },
  permissionResolved: {
    type: 'permission-resolved', sessionId: 's1', permId: 'p1', decision: 'allow', by: 'iPad',
  },
  questionPending: { type: 'question-pending', request: question },
  state: { type: 'state', sessionId: 's1', state: 'running', since: AT },
  activity: {
    type: 'activity', sessionId: 's1', kind: 'tool', toolName: 'Workflow', delegation: 'workflow',
  },
  hello: { type: 'hello', protocolVersion: 3, serverStartId: 'start-1' },
  gitStatus: {
    type: 'git-status', sessionId: 's1', branch: 'main', dirtyCount: 3,
    files: ['a.ts', 'logo.png', 'b.md'],
    fileDetails: [
      { path: 'a.ts', kind: 'modified', linesAdded: 4, linesDeleted: 1 },
      { path: 'logo.png', kind: 'deleted', binary: true },
      { path: 'b.md', kind: 'added' },
    ],
  },
  inboxHeads: { type: 'inbox-heads', heads: inboxHeads },
  inboxHead: { type: 'inbox-head', head: inboxHeads[0] },
} as const;

/** The `inbox-heads` frame with only the heads at `keep` (indices of {@link inboxHeads}). */
const headsOnly = (...keep: number[]) => ({ type: 'inbox-heads', heads: keep.map((index) => inboxHeads[index]) });

// ---------------------------------------------------------------------------
// Edycja ramek po JSON Pointer — tylko na potrzeby testu, zawsze na kopii.
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

/**
 * Kopia przez JSON, nie `structuredClone`: ten drugi zachowuje WSPÓŁDZIELONE obiekty (dwie sesje
 * z `{ ...summary }` mają jedno `activity`), więc edycja jednej sesji zmieniałaby obie. Na drucie
 * współdzielenia nie ma.
 */
const wire = (frame: unknown): Json => JSON.parse(JSON.stringify(frame)) as Json;

function edit(frame: unknown, pointer: string, op: (parent: Json, key: string) => void): Json {
  const copy = wire(frame);
  const keys = pointer.split('/').slice(1);
  const last = keys.pop();
  if (last === undefined) throw new Error(`pusty wskaźnik: ${pointer}`);
  let node: Json = copy;
  for (const key of keys) node = node[key] as Json;
  op(node, last);
  return copy;
}

function setAt(frame: unknown, pointer: string, value: unknown): Json {
  return edit(frame, pointer, (parent, key) => { parent[key] = value; });
}

function removeAt(frame: unknown, pointer: string): Json {
  return edit(frame, pointer, (parent, key) => { delete parent[key]; });
}

describe('ścieżka szybka — ramka zgodna ze ścisłym kontraktem', () => {
  for (const [name, frame] of Object.entries(FRAMES)) {
    it(`${name}: wynik = parseServerEvent, degradations: []`, () => {
      const decoded = decodeServerEvent(wire(frame));
      expect(decoded).toStrictEqual({ event: parseServerEvent(frame), degradations: [] });
    });
  }

  it('surowy string JSON przechodzi tak samo jak wartość', () => {
    expect(decodeServerEvent(JSON.stringify(FRAMES.snapshot)))
      .toStrictEqual({ event: parseServerEvent(FRAMES.snapshot), degradations: [] });
  });

  it('nieznany KLUCZ to forward-compat, nie degradacja: odcięty, degradations: []', () => {
    const decoded = decodeServerEvent(setAt(FRAMES.changed, '/session/przyszlePole', 'x'));
    expect(decoded).toStrictEqual({ event: parseServerEvent(FRAMES.changed), degradations: [] });
  });

  it('notice: schemat sprzed pola (stary klient) odcina je, a rola i bloki zostają bez zmian', () => {
    const old = transcriptMessageSchema.omit({ notice: true }).parse(noticeMessage);
    expect(old).not.toHaveProperty('notice');
    expect(old.role).toBe('user');
    expect(old.blocks).toStrictEqual(noticeMessage.blocks);
  });

  /*
   * Postój subagenta: pola zadania i wynik notki są ADDYTYWNE i nie mają pozycji
   * w `DEGRADATIONS` — to łańcuchy i lista, nie wyliczenia, a `waiting` jest znaną wartością.
   * Schemat tolerancyjny powstaje ze ścisłego przez `.extend`, więc pola przechodzą też gałęzią
   * zapasową; ten test pilnuje, żeby przebudowa dekodera ich po drodze nie zgubiła.
   */
  it('postój subagenta: waitingSince i ownTasks przechodzą ściśle i gałęzią tolerancyjną', () => {
    const agent = {
      id: 'a1', kind: 'agent', description: 'Przegląd', waitingSince: AT,
      ownTasks: [{ id: 'b2', command: 'until [ -f wynik.txt ]; do sleep 5; done', startedAt: AT }, { id: 'b3' }],
    };
    const frame = setAt(FRAMES.changed, '/session/backgroundTasks/0', agent);
    expect(decodeServerEvent(frame)).toStrictEqual({ event: frame, degradations: [] });

    // Nieznany stan sesji zrzuca ramkę na gałąź tolerancyjną: zadanie wraca w całości.
    const degraded = decodeServerEvent(setAt(frame, '/session/state', 'zzz'));
    expect(degraded?.degradations).toStrictEqual([{ path: '/session/state', value: 'zzz' }]);
    expect(degraded?.event).toStrictEqual(setAt(frame, '/session/state', UNSUPPORTED));

    // Nieznany rodzaj TEGO zadania degraduje sam rodzaj; postój i własne komendy zostają.
    const unknownKind = decodeServerEvent(setAt(frame, '/session/backgroundTasks/0/kind', 'cron'));
    expect(unknownKind?.degradations)
      .toStrictEqual([{ path: '/session/backgroundTasks/0/kind', value: 'cron' }]);
    expect(unknownKind?.event)
      .toStrictEqual(setAt(frame, '/session/backgroundTasks/0/kind', UNSUPPORTED));

    // Klient sprzed pól odcina je i widzi zadanie takie, jakie znał.
    expect(backgroundTaskSchema.omit({ waitingSince: true, ownTasks: true }).parse(agent))
      .toStrictEqual({ id: 'a1', kind: 'agent', description: 'Przegląd' });
  });

  it('notice.outcome „waiting” (postój subagenta) przechodzi ściśle, bez degradacji', () => {
    const frame = setAt(
      setAt(FRAMES.notice, '/message/notice', { kind: 'agent', outcome: 'waiting', name: 'Przegląd' }),
      '/message/blocks/0/text', '<task-notification>\n<status>completed</status>\n</task-notification>',
    );
    expect(decodeServerEvent(frame)).toStrictEqual({ event: frame, degradations: [] });
  });

  /*
   * Artefakty sesji: pole addytywne bez pozycji w `DEGRADATIONS` — lista obiektów z łańcuchami i literałem
   * `gone: true`, nic wyliczeniowego. Schemat tolerancyjny powstaje ze ścisłego przez `.extend`, więc lista ma
   * przejść też gałęzią zapasową; klient sprzed pola je odcina.
   */
  it('artefakty sesji: lista przechodzi ściśle i gałęzią tolerancyjną; klient sprzed pola ją odcina', () => {
    const artifacts = [
      { url: 'https://claude.ai/artifact/ArtefaktTestowyH000001', title: 'Raport', publishedAt: AT },
      { url: 'https://claude.ai/artifact/ArtefaktTestowyB000002', title: 'Deck', publishedAt: AT, gone: true },
    ];
    const frame = setAt(FRAMES.changed, '/session/artifacts', artifacts);
    expect(decodeServerEvent(frame)).toStrictEqual({ event: frame, degradations: [] });
    const degraded = decodeServerEvent(setAt(frame, '/session/state', 'zzz'));
    expect(degraded?.event).toStrictEqual(setAt(frame, '/session/state', UNSUPPORTED));
    expect(sessionSummarySchema.omit({ artifacts: true }).parse(setAt(summary, '/artifacts', artifacts)))
      .not.toHaveProperty('artifacts');
  });

  it('notice.kind „artifact-watch” przechodzi ściśle; klient sprzed wartości czyta ją jak `unknown`', () => {
    const frame = setAt(FRAMES.notice, '/message/notice', { kind: 'artifact-watch', name: 'Raport' });
    expect(decodeServerEvent(frame)).toStrictEqual({ event: frame, degradations: [] });
    // Schemat starego klienta (enum bez wartości) + ta sama reguła tolerancji co `notice.kind` w dekoderze.
    const before = transcriptNoticeSchema.shape.kind.exclude(['artifact-watch']);
    const lenient = z.union([before, z.string().transform(() => DEGRADATIONS['notice.kind'])]);
    expect(lenient.parse('artifact-watch')).toBe('unknown');
  });

  it('cliDialog: każda klasa przechodzi ściśle; ramka bez pola też; stary bundle pole odcina', () => {
    for (const cliDialog of CLI_DIALOG_CLASSES) {
      const frame = setAt(FRAMES.changed, '/session/cliDialog', cliDialog);
      expect(decodeServerEvent(frame)).toStrictEqual({ event: frame, degradations: [] });
    }
    const without = removeAt(FRAMES.changed, '/session/cliDialog');
    expect(decodeServerEvent(without)).toStrictEqual({ event: without, degradations: [] });
    expect(sessionSummarySchema.omit({ cliDialog: true }).parse(summary)).not.toHaveProperty('cliDialog');
  });

  /*
   * PR status: an additive enum field with a `DEGRADATIONS` entry. A known state passes strictly, a missing field is
   * "state unknown", an unknown string drops only that field (the strict producer schema rejects it), and `null` or a
   * number rejects the frame in the rejection table below.
   */
  it('pullRequests.state: open, draft, merged, closed pass strictly; no field too; "queued" drops the field only', () => {
    for (const state of ['open', 'draft', 'merged', 'closed']) {
      const frame = setAt(FRAMES.changed, '/session/pullRequests/0/state', state);
      expect(decodeServerEvent(frame)).toStrictEqual({ event: frame, degradations: [] });
    }
    const merged = decodeServerEvent(FRAMES.changed)?.event;
    expect(merged?.type === 'session-changed' ? merged.session.pullRequests?.[0]?.state : null).toBe('merged');
    const without = removeAt(FRAMES.changed, '/session/pullRequests/0/state');
    expect(decodeServerEvent(without)).toStrictEqual({ event: without, degradations: [] });

    const queued = setAt(FRAMES.changed, '/session/pullRequests/0/state', 'queued');
    expect(parseServerEvent(queued)).toBeNull();
    expect(decodeServerEvent(queued)).toStrictEqual({
      event: without, degradations: [{ path: '/session/pullRequests/0/state', value: 'queued' }],
    });
    expect(sessionPullRequestSchema.omit({ state: true }).parse(summary.pullRequests[0])).not.toHaveProperty('state');
  });

  it('hello.minClientBuild: dekoder przepuszcza, schemat sprzed pola (stary klient) odcina', () => {
    const hello = { ...FRAMES.hello, minClientBuild: 12 };
    expect(decodeServerEvent(hello)).toStrictEqual({ event: hello, degradations: [] });
    expect(helloEventSchema.omit({ minClientBuild: true }).parse(hello)).toStrictEqual(FRAMES.hello);
  });
});

describe('degradation keeps the rest of the frame', () => {
  it('nieznany stan JEDNEJ z dwóch sesji: ta „unsupported", druga nietknięta', () => {
    const decoded = decodeServerEvent(setAt(FRAMES.snapshot, '/sessions/0/state', 'zzz'));
    expect(decoded?.degradations).toStrictEqual([{ path: '/sessions/0/state', value: 'zzz' }]);
    expect(decoded?.event).toStrictEqual(setAt(FRAMES.snapshot, '/sessions/0/state', UNSUPPORTED));
  });

  it('nieznany typ bloku → blok zastępczy, reszta wiadomości zostaje', () => {
    const decoded = decodeServerEvent(
      setAt(FRAMES.message, '/message/blocks/1', { type: 'video', url: 'https://example.test/v.mp4', text: 9 }),
    );
    expect(decoded?.degradations).toStrictEqual([{ path: '/message/blocks/1/type', value: 'video' }]);
    expect(decoded?.event).toStrictEqual(setAt(FRAMES.message, '/message/blocks/1', { type: UNSUPPORTED }));
  });

  it('uszkodzony znany blok, state: null i brak id → null', () => {
    expect(decodeServerEvent(setAt(FRAMES.message, '/message/blocks/0', { type: 'text', text: 9 })))
      .toBeNull();
    expect(decodeServerEvent(setAt(FRAMES.snapshot, '/sessions/0/state', null))).toBeNull();
    expect(decodeServerEvent(removeAt(FRAMES.snapshot, '/sessions/1/id'))).toBeNull();
  });
});

/**
 * Po jednym przypadku (albo kilku — gdy pole żyje w kilku ramkach) na KAŻDĄ degradację.
 *
 * `Record<keyof typeof DEGRADATIONS, …>` sprawia, że nowa pozycja listy bez przypadku tutaj nie
 * przejdzie typecheck. `result` opisuje oczekiwany wynik względem ramki BAZOWEJ: wartość zapasowa
 * pod ścieżką albo usunięcie (czasem całego obiektu-rodzica, nie samego pola).
 */
interface DegradationCase {
  frame: unknown;
  path: string;
  result: { path: string; value: unknown } | { path: string; remove: true };
}

const CASES: Record<keyof typeof DEGRADATIONS, DegradationCase[]> = {
  state: [
    { frame: FRAMES.snapshot, path: '/sessions/1/state',
      result: { path: '/sessions/1/state', value: UNSUPPORTED } },
    { frame: FRAMES.state, path: '/state', result: { path: '/state', value: UNSUPPORTED } },
  ],
  effort: [
    { frame: FRAMES.changed, path: '/session/effort', result: { path: '/session/effort', value: UNSUPPORTED } },
  ],
  herdrMode: [
    { frame: FRAMES.changed, path: '/session/herdrMode', result: { path: '/session/herdrMode', value: 'unknown' } },
  ],
  herdrDialog: [
    { frame: FRAMES.changed, path: '/session/herdrDialog', result: { path: '/session/herdrDialog', remove: true } },
  ],
  herdrDialogReason: [
    { frame: FRAMES.changed, path: '/session/herdrDialogReason',
      result: { path: '/session/herdrDialogReason', remove: true } },
  ],
  cliDialog: [
    { frame: FRAMES.changed, path: '/session/cliDialog', result: { path: '/session/cliDialog', remove: true } },
  ],
  engine: [
    { frame: FRAMES.changed, path: '/session/engine', result: { path: '/session/engine', value: UNSUPPORTED } },
  ],
  'context.kind': [
    { frame: FRAMES.changed, path: '/session/context/kind', result: { path: '/session/context', remove: true } },
  ],
  'context.source': [
    { frame: FRAMES.changed, path: '/session/context/source',
      result: { path: '/session/context/source', value: UNSUPPORTED } },
  ],
  'activity.kind': [
    { frame: FRAMES.changed, path: '/session/activity/kind', result: { path: '/session/activity', remove: true } },
    { frame: FRAMES.transcript, path: '/activity/kind', result: { path: '/activity', remove: true } },
  ],
  'waitingFor.kind': [
    { frame: FRAMES.changed, path: '/session/waitingFor/kind',
      result: { path: '/session/waitingFor', remove: true } },
  ],
  'backgroundTasks.kind': [
    { frame: FRAMES.changed, path: '/session/backgroundTasks/0/kind',
      result: { path: '/session/backgroundTasks/0/kind', value: UNSUPPORTED } },
  ],
  'message.role': [
    { frame: FRAMES.message, path: '/message/role', result: { path: '/message/role', value: 'system' } },
    { frame: FRAMES.transcript, path: '/messages/0/role', result: { path: '/messages/0/role', value: 'system' } },
  ],
  'block.type': [
    { frame: FRAMES.message, path: '/message/blocks/0/type',
      result: { path: '/message/blocks/0', value: { type: UNSUPPORTED } } },
  ],
  'block.detailKind': [
    { frame: FRAMES.message, path: '/message/blocks/1/detailKind',
      result: { path: '/message/blocks/1/detailKind', remove: true } },
  ],
  'attachments.kind': [
    { frame: FRAMES.message, path: '/message/attachments/0/kind',
      result: { path: '/message/attachments/0/kind', value: 'file' } },
  ],
  risk: [
    { frame: FRAMES.permissionPending, path: '/request/risk', result: { path: '/request/risk', value: 'red' } },
    { frame: FRAMES.transcript, path: '/pendingPermissions/0/risk',
      result: { path: '/pendingPermissions/0/risk', value: 'red' } },
  ],
  channel: [
    { frame: FRAMES.questionPending, path: '/request/channel', result: { path: '/request/channel', remove: true } },
    { frame: FRAMES.transcript, path: '/pendingQuestions/0/channel',
      result: { path: '/pendingQuestions/0/channel', remove: true } },
  ],
  'permission-resolved.decision': [
    { frame: FRAMES.permissionResolved, path: '/decision', result: { path: '/decision', value: UNSUPPORTED } },
  ],
  subject: [
    { frame: FRAMES.permissionPending, path: '/request/subject', result: { path: '/request/subject', value: 'tool' } },
    { frame: FRAMES.transcript, path: '/pendingPermissions/0/subject',
      result: { path: '/pendingPermissions/0/subject', value: 'tool' } },
  ],
  'permission.inputKind': [
    { frame: FRAMES.permissionPending, path: '/request/inputKind',
      result: { path: '/request/inputKind', remove: true } },
    { frame: FRAMES.transcript, path: '/pendingPermissions/0/inputKind',
      result: { path: '/pendingPermissions/0/inputKind', remove: true } },
  ],
  'permission.state': [
    { frame: FRAMES.hookPending, path: '/request/state', result: { path: '/request/state', value: UNSUPPORTED } },
    { frame: FRAMES.settled, path: '/state', result: { path: '/state', value: UNSUPPORTED } },
  ],
  'permission.unavailable': [
    { frame: FRAMES.hookPending, path: '/request/unavailable',
      result: { path: '/request/unavailable', value: UNSUPPORTED } },
    { frame: FRAMES.settled, path: '/unavailable', result: { path: '/unavailable', value: UNSUPPORTED } },
  ],
  'permission.notes': [
    { frame: FRAMES.hookPending, path: '/request/notes/0', result: { path: '/request/notes/0', value: UNSUPPORTED } },
  ],
  'waitingFor.subject': [
    { frame: FRAMES.changed, path: '/session/waitingFor/subject',
      result: { path: '/session/waitingFor/subject', value: 'tool' } },
  ],
  'activity.delegation': [
    { frame: FRAMES.changed, path: '/session/activity/delegation',
      result: { path: '/session/activity/delegation', value: 'agents' } },
    // Ulotna ramka z nieznaną delegacją ZOSTAJE — w odróżnieniu od nieznanego `kind`.
    { frame: FRAMES.activity, path: '/delegation', result: { path: '/delegation', value: 'agents' } },
  ],
  'block.delegation': [
    { frame: FRAMES.message, path: '/message/blocks/3/delegation',
      result: { path: '/message/blocks/3/delegation', value: 'agents' } },
  ],
  'block.inputKind': [
    { frame: FRAMES.message, path: '/message/blocks/1/inputKind',
      result: { path: '/message/blocks/1/inputKind', remove: true } },
  ],
  'option.role': [
    { frame: FRAMES.questionPending, path: '/request/questions/0/options/2/role',
      result: { path: '/request/questions/0/options/2/role', value: 'answer' } },
    { frame: FRAMES.transcript, path: '/pendingQuestions/0/questions/0/options/0/role',
      result: { path: '/pendingQuestions/0/questions/0/options/0/role', value: 'answer' } },
  ],
  'notice.kind': [
    { frame: FRAMES.notice, path: '/message/notice/kind', result: { path: '/message/notice/kind', value: 'unknown' } },
  ],
  'notice.outcome': [
    { frame: FRAMES.notice, path: '/message/notice/outcome',
      result: { path: '/message/notice/outcome', remove: true } },
  ],
  'fileDetails.kind': [
    { frame: FRAMES.gitStatus, path: '/fileDetails/1/kind',
      result: { path: '/fileDetails/1/kind', value: 'modified' } },
  ],
  'pullRequests.state': [
    { frame: FRAMES.changed, path: '/session/pullRequests/0/state',
      result: { path: '/session/pullRequests/0/state', remove: true } },
    { frame: FRAMES.snapshot, path: '/sessions/1/pullRequests/0/state',
      result: { path: '/sessions/1/pullRequests/0/state', remove: true } },
  ],
  seenBy: [
    { frame: FRAMES.changed, path: '/session/seenBy', result: { path: '/session/seenBy', remove: true } },
    { frame: FRAMES.snapshot, path: '/sessions/1/seenBy', result: { path: '/sessions/1/seenBy', remove: true } },
  ],
  // The unreadable head drops out of the list; the other heads stay in order.
  'inbox.head': [
    { frame: FRAMES.inboxHeads, path: '/heads/1/kind', result: { path: '/heads', value: headsOnly(0, 2).heads } },
    { frame: FRAMES.inboxHeads, path: '/heads/2/state', result: { path: '/heads', value: headsOnly(0, 1).heads } },
    { frame: FRAMES.inboxHeads, path: '/heads/0/dialog', result: { path: '/heads', value: headsOnly(1, 2).heads } },
  ],
};

function applyResult(frame: unknown, result: DegradationCase['result']): Json {
  return 'remove' in result ? removeAt(frame, result.path) : setAt(frame, result.path, result.value);
}

const frameType = (frame: unknown): string => (frame as { type: string }).type;

describe('każda degradacja: wartość zapasowa albo brak pola + wskazanie w degradations', () => {
  it('lista przypadków pokrywa DOKŁADNIE listę DEGRADATIONS', () => {
    expect(Object.keys(CASES).sort()).toStrictEqual(Object.keys(DEGRADATIONS).sort());
    for (const cases of Object.values(CASES)) expect(cases.length).toBeGreaterThan(0);
  });

  for (const [id, cases] of Object.entries(CASES)) {
    for (const { frame, path: pointer, result } of cases) {
      it(`${id}: ${frameType(frame)} ${pointer} = 'zzz'`, () => {
        const decoded = decodeServerEvent(setAt(frame, pointer, 'zzz'));
        expect(decoded?.degradations).toStrictEqual([{ path: pointer, value: 'zzz' }]);
        // `toStrictEqual`: pole, które „znika", ma zniknąć naprawdę — nie zostać jako `undefined`.
        expect(decoded?.event).toStrictEqual(applyResult(frame, result));
      });
    }
  }
});

/**
 * Druga degradacja w tej samej ramce, kolejne kandydatki na wypadek, gdyby pierwsza była polem
 * samego przypadku. Ramki `state`, `permission-resolved` i ulotna `activity` mają JEDNO pole
 * degradowalne — drugiej degradacji obok nie da się w nich ułożyć.
 */
const COMPANIONS: Record<string, DegradationCase['result'][]> = {
  'sessions-snapshot': [{ path: '/sessions/0/herdrMode', value: 'unknown' }],
  'session-changed': [
    { path: '/session/herdrMode', value: 'unknown' },
    { path: '/session/effort', value: UNSUPPORTED },
  ],
  'transcript-snapshot': [
    { path: '/pendingPermissions/0/risk', value: 'red' },
    { path: '/messages/0/role', value: 'system' },
  ],
  message: [
    { path: '/message/role', value: 'system' },
    { path: '/message/attachments/0/kind', value: 'file' },
  ],
  'permission-pending': [
    { path: '/request/risk', value: 'red' },
    { path: '/request/subject', value: 'tool' },
  ],
  'question-pending': [
    { path: '/request/channel', remove: true },
    { path: '/request/questions/0/options/2/role', value: 'answer' },
  ],
  'git-status': [{ path: '/fileDetails/2/kind', value: 'modified' }],
};

const byPath = <T extends { path: string }>(list: readonly T[] | undefined): T[] =>
  [...(list ?? [])].sort((a, b) => a.path.localeCompare(b.path));

describe('nieznany łańcuch RÓWNY wartości zapasowej też jest degradacją', () => {
  // Serwer `'unsupported'` nadać nie może (strażnik niżej), ale gdyby nadał, ramka przeszłaby
  // ścieżką wolną bez śladu: wynik równa się wartości zapasowej. Znacznik widoku surowego
  // zgłasza każde pole, które przeszło gałąź zapasową, bez porównywania z wynikiem.
  for (const [id, cases] of Object.entries(CASES)) {
    for (const { frame, path: pointer, result } of cases) {
      it(`${id}: ${frameType(frame)} ${pointer} = 'unsupported'`, () => {
        const decoded = decodeServerEvent(setAt(frame, pointer, UNSUPPORTED));
        expect(decoded?.degradations).toStrictEqual([{ path: pointer, value: UNSUPPORTED }]);
        expect(decoded?.event).toStrictEqual(applyResult(frame, result));
      });

      const companion = COMPANIONS[frameType(frame)]?.find((c) => c.path !== pointer);
      if (companion === undefined) continue;
      it(`${id}: ${frameType(frame)} ${pointer} = 'unsupported' obok ${companion.path} = 'zzz'`, () => {
        const decoded = decodeServerEvent(setAt(setAt(frame, pointer, UNSUPPORTED), companion.path, 'zzz'));
        expect(byPath(decoded?.degradations)).toStrictEqual(byPath([
          { path: pointer, value: UNSUPPORTED },
          { path: companion.path, value: 'zzz' },
        ]));
        expect(decoded?.event).toStrictEqual(applyResult(applyResult(frame, result), companion));
      });
    }
  }

  it('pola z towarzyszem mają przypadek z drugą degradacją, gdzie ramka ją dopuszcza', () => {
    const withCompanion = Object.values(CASES).flat()
      .filter(({ frame, path: pointer }) => COMPANIONS[frameType(frame)]?.some((c) => c.path !== pointer))
      .map(({ path: pointer }) => pointer);
    expect(withCompanion).toEqual(expect.arrayContaining([
      '/sessions/1/state', '/session/effort', '/session/engine', '/session/context/source',
      '/session/backgroundTasks/0/kind', '/message/blocks/0/type',
      '/session/context/kind', '/session/activity/kind', '/session/waitingFor/kind',
    ]));
  });
});

describe('kilka degradacji w jednej ramce', () => {
  it('wszystkie degradacje ramki; nieznany klucz obok nie jest degradacją', () => {
    let frame = setAt(FRAMES.snapshot, '/sessions/0/state', 'zzz');
    frame = setAt(frame, '/sessions/0/przyszlePole', 'nowe');
    frame = setAt(frame, '/sessions/1/herdrMode', 'qqq');
    frame = setAt(frame, '/sessions/1/activity/kind', 'www');
    const decoded = decodeServerEvent(frame);
    expect(decoded?.degradations).toStrictEqual([
      { path: '/sessions/0/state', value: 'zzz' },
      { path: '/sessions/1/herdrMode', value: 'qqq' },
      { path: '/sessions/1/activity/kind', value: 'www' },
    ]);
    let expected = setAt(FRAMES.snapshot, '/sessions/0/state', UNSUPPORTED);
    expected = setAt(expected, '/sessions/1/herdrMode', 'unknown');
    expected = removeAt(expected, '/sessions/1/activity');
    expect(decoded?.event).toStrictEqual(expected);
  });

  it('usunięty obiekt zgłasza SAM wyróżnik, nie każdy swój łańcuch', () => {
    const frame = setAt(FRAMES.changed, '/session/activity', {
      kind: 'zzz', toolName: 'Bash', summary: 'pnpm test', przyszlePole: 'x',
    });
    expect(decodeServerEvent(frame)?.degradations)
      .toStrictEqual([{ path: '/session/activity/kind', value: 'zzz' }]);
  });

  it('obiekt o nieznanym wyróżniku nie jest dalej walidowany — jego kształtu nie znamy', () => {
    const frame = setAt(FRAMES.changed, '/session/context', { kind: 'zzz', tokens: 'dużo' });
    expect(decodeServerEvent(frame)?.event).toStrictEqual(removeAt(FRAMES.changed, '/session/context'));
  });

  it('wynik jest punktem stałym: ponowne dekodowanie nie zmienia ramki, ale ZNÓW ją wykazuje', () => {
    let frame = setAt(FRAMES.message, '/message/blocks/0/type', 'video');
    frame = setAt(frame, '/message/role', 'narrator');
    const once = decodeServerEvent(frame);
    expect(once?.degradations).toHaveLength(2);
    const twice = decodeServerEvent(once?.event);
    expect(twice?.event).toStrictEqual(once?.event);
    // `role: 'system'` jest wartością ZNANĄ, a blok zastępczy nie: `'unsupported'` nadal przechodzi
    // tylko gałęzią zapasową, więc pusta lista skłamałaby, że ramka zgadza się z kontraktem.
    expect(twice?.degradations).toStrictEqual([{ path: '/message/blocks/0/type', value: UNSUPPORTED }]);
  });

  it('ścieżka wolna przyjmuje też surowy string JSON', () => {
    const frame = setAt(FRAMES.state, '/state', 'zzz');
    expect(decodeServerEvent(JSON.stringify(frame))).toStrictEqual(decodeServerEvent(frame));
  });
});

describe('inbox-heads: an unreadable head drops only itself', () => {
  it('two unreadable heads: both drop, each reported at its own index, the readable head stays', () => {
    let frame = setAt(FRAMES.inboxHeads, '/heads/0/kind', 'summary');
    frame = setAt(frame, '/heads/2/state', 'paused');
    const decoded = decodeServerEvent(frame);
    expect(decoded?.degradations).toStrictEqual([
      { path: '/heads/0/kind', value: 'summary' },
      { path: '/heads/2/state', value: 'paused' },
    ]);
    expect(decoded?.event).toStrictEqual(headsOnly(1));
  });

  it('a head with several unknown values drops once and reports every value', () => {
    let frame = setAt(FRAMES.inboxHeads, '/heads/0/kind', 'summary');
    frame = setAt(frame, '/heads/0/dialog', 'browser');
    const decoded = decodeServerEvent(frame);
    expect(byPath(decoded?.degradations)).toStrictEqual(byPath([
      { path: '/heads/0/kind', value: 'summary' },
      { path: '/heads/0/dialog', value: 'browser' },
    ]));
    expect(decoded?.event).toStrictEqual(headsOnly(1, 2));
  });

  it('every head unreadable: the frame stays with an empty list', () => {
    let frame: unknown = FRAMES.inboxHeads;
    for (const index of [0, 1, 2]) frame = setAt(frame, `/heads/${index}/kind`, 'summary');
    expect(decodeServerEvent(frame)?.event).toStrictEqual(headsOnly());
  });

  it('a single inbox-head with an unknown value is ignored whole', () => {
    const unknown: Array<[string, string]> = [
      ['/head/kind', 'summary'], ['/head/state', 'paused'], ['/head/dialog', 'browser'],
    ];
    for (const [pointer, value] of unknown) {
      expect(decodeServerEvent(setAt(FRAMES.inboxHead, pointer, value)), pointer).toBeNull();
    }
  });
});

describe('odrzucenia — uszkodzony kształt dalej daje null', () => {
  const rejected: Array<[string, unknown]> = [
    ['nieznany type ramki', { type: 'teleport', sessionId: 's1' }],
    ['nieznany type ramki obok degradowalnego pola', { type: 'teleport', state: 'zzz' }],
    ['uszkodzony JSON', '{"type":"state",'],
    ['null zamiast ramki', null],
    ['liczba zamiast ramki', 7],
    ['tablica zamiast ramki', [FRAMES.state]],
    ['state: null w ramce state', setAt(FRAMES.state, '/state', null)],
    ['brak wymaganego pola (since)', removeAt(FRAMES.state, '/since')],
    ['zły typ pola nieenumowego', setAt(FRAMES.changed, '/session/title', 5)],
    ['nieznana wartość NIE-łańcuch: state', setAt(FRAMES.state, '/state', 5)],
    ['nieznana wartość NIE-łańcuch: risk', setAt(FRAMES.permissionPending, '/request/risk', true)],
    ['nieznana wartość NIE-łańcuch: kind kontekstu', setAt(FRAMES.changed, '/session/context/kind', 7)],
    ['nieznana wartość NIE-łańcuch: typ bloku', setAt(FRAMES.message, '/message/blocks/0/type', 3)],
    ['null w opcjonalnym polu wyliczeniowym', setAt(FRAMES.changed, '/session/effort', null)],
    // `null` to NIE brak pola — także poza enumami (Swift `decodeIfPresent` czytałby je jak brak).
    ['null w opcjonalnym polu nieenumowym', setAt(FRAMES.changed, '/session/label', null)],
    ['activity: null zamiast obiektu', setAt(FRAMES.changed, '/session/activity', null)],
    ['blok bez type', setAt(FRAMES.message, '/message/blocks/0', { text: 'x' })],
    ['uszkodzony znany kontekst (brak limit)', removeAt(FRAMES.changed, '/session/context/limit')],
    ['uszkodzony znany tool-call (brak summary)', removeAt(FRAMES.message, '/message/blocks/1/summary')],
    ['ulotna ramka activity z nieznanym kind', setAt(FRAMES.activity, '/kind', 'zzz')],
    ['nieznana wartość NIE-łańcuch: rola opcji',
      setAt(FRAMES.questionPending, '/request/questions/0/options/0/role', 1)],
    ['customAnswer jako łańcuch (pole logiczne, nie wyliczeniowe)',
      setAt(FRAMES.questionPending, '/request/customAnswer', 'true')],
    ['nieznana wartość NIE-łańcuch: delegacja bloku', setAt(FRAMES.message, '/message/blocks/3/delegation', 2)],
    // `null` i zły typ w notce dalej odrzucają ramkę — degraduje wyłącznie nieznany łańcuch.
    ['notice: null zamiast obiektu', setAt(FRAMES.notice, '/message/notice', null)],
    ['nieznana wartość NIE-łańcuch: rodzaj notki', setAt(FRAMES.notice, '/message/notice/kind', 4)],
    ['kod wyjścia notki jako łańcuch', setAt(FRAMES.notice, '/message/notice/exitCode', '1')],
    ['kod wyjścia notki ułamkowy', setAt(FRAMES.notice, '/message/notice/exitCode', 1.5)],
    ['notka bez rodzaju', removeAt(FRAMES.notice, '/message/notice/kind')],
    // Szczegóły plików w `git-status`: degraduje wyłącznie nieznany łańcuch w `kind`.
    ['fileDetails: null zamiast tablicy', setAt(FRAMES.gitStatus, '/fileDetails', null)],
    ['nieznana wartość NIE-łańcuch: rodzaj zmiany pliku', setAt(FRAMES.gitStatus, '/fileDetails/0/kind', 1)],
    ['licznik linii jako łańcuch', setAt(FRAMES.gitStatus, '/fileDetails/0/linesAdded', '4')],
    ['licznik linii ujemny', setAt(FRAMES.gitStatus, '/fileDetails/0/linesDeleted', -1)],
    ['licznik linii ułamkowy', setAt(FRAMES.gitStatus, '/fileDetails/0/linesAdded', 1.5)],
    ['binary: null w szczególe pliku', setAt(FRAMES.gitStatus, '/fileDetails/1/binary', null)],
    ['szczegół pliku bez ścieżki', removeAt(FRAMES.gitStatus, '/fileDetails/0/path')],
    // Lista artefaktów — `null`, element bez adresu i `gone: false` (literał `true` albo brak pola).
    ['artifacts: null zamiast tablicy', setAt(FRAMES.changed, '/session/artifacts', null)],
    ['artefakt bez adresu', setAt(FRAMES.changed, '/session/artifacts', [{ title: 'x', publishedAt: AT }])],
    ['artefakt z gone: false', setAt(FRAMES.changed, '/session/artifacts', [
      { url: 'https://claude.ai/artifact/ArtefaktTestowyH000001', title: 'x', publishedAt: AT, gone: false },
    ])],
    // PR status: only an unknown string degrades; `null` and a number reject the frame.
    ['pullRequests.state: null', setAt(FRAMES.changed, '/session/pullRequests/0/state', null)],
    ['pullRequests.state: a number', setAt(FRAMES.changed, '/session/pullRequests/0/state', 7)],
    // Inbox heads: only an unknown string drops a head; a broken head still rejects the whole list.
    ['inbox-heads: kind null', setAt(FRAMES.inboxHeads, '/heads/1/kind', null)],
    ['inbox-heads: kind a number', setAt(FRAMES.inboxHeads, '/heads/1/kind', 3)],
    ['inbox-heads: head without version', removeAt(FRAMES.inboxHeads, '/heads/1/version')],
    ['inbox-heads: empty version', setAt(FRAMES.inboxHeads, '/heads/1/version', '')],
    ['inbox-heads: unknown kind next to an empty version',
      setAt(setAt(FRAMES.inboxHeads, '/heads/1/kind', 'summary'), '/heads/1/version', '')],
    ['inbox-heads: heads null', setAt(FRAMES.inboxHeads, '/heads', null)],
  ];

  for (const [name, frame] of rejected) {
    it(name, () => {
      expect(decodeServerEvent(frame)).toBeNull();
    });
  }
});

describe('typy klienta', () => {
  it('znają wartownika tam, gdzie degradacja go wstawia', () => {
    // Przypisania kompilują się tylko, gdy typy klienta (`z.output` schematów tolerancyjnych)
    // dopuszczają wartownika — `tsc -b` sprawdza ten plik razem z resztą pakietu.
    const state: ClientSessionState = UNSUPPORTED;
    const block: ClientBlock = { type: UNSUPPORTED };
    expect([state, block.type]).toStrictEqual([UNSUPPORTED, UNSUPPORTED]);
  });

  it('nie rozszerzają się do string — `switch` po stanie zostaje ekshaustywny', () => {
    // Gdyby typ klienta stał się `string`, te linie przestałyby być błędem, a `@ts-expect-error`
    // bez błędu sam jest błędem `tsc -b`. Zmienne są czytane niżej, żeby błędem nie było „unused".
    // @ts-expect-error — nieznany łańcuch nie jest wartością typu klienta
    const unknownState: ClientSessionState = 'zzz';
    // @ts-expect-error — blok zastępczy ma JEDEN typ, nie dowolny
    const unknownBlock: ClientBlock = { type: 'video' };
    expect([unknownState, unknownBlock.type]).toStrictEqual(['zzz', 'video']);
  });
});

describe('rezerwacja słowa „unsupported" (zna je wyłącznie klient)', () => {
  // Serwer z tym literałem na drucie zamieniłby degradację w „poprawną" wartość i ścieżka szybka
  // przepuściłaby ramkę, której ścisły kontrakt nie zna. Strażnik: protokół i cały `server/src`.
  const LITERAL = /(['"])unsupported\1/;

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) return sources(full);
      return entry.endsWith('.ts') ? [full] : [];
    });
  }

  it('protocol.ts (z plikami obszarów `shared/src/protocol/`) i server/src nie zawierają literału', () => {
    const files = [
      path.join(REPO_ROOT, 'shared/src/protocol.ts'),
      ...sources(path.join(REPO_ROOT, 'shared/src/protocol')),
      ...sources(path.join(REPO_ROOT, 'server/src')),
    ];
    expect(files.length).toBeGreaterThan(20);
    const offenders = files.filter((file) => LITERAL.test(readFileSync(file, 'utf8')));
    expect(offenders.map((file) => path.relative(REPO_ROOT, file))).toStrictEqual([]);
  });
});
