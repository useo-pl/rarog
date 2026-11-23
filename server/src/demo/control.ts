/** Sterowanie wyłącznie lokalnym demo. Nie zmienia managera ani kontraktu SSE/REST. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import { notesEmpty } from '@rarog/shared';
import { type ServerSentence, say } from '@rarog/shared/sentences';
import { originAllowed } from '../auth/index.ts';
import type { RarogConfig } from '../config.ts';
import { readBody } from '../router.ts';
import type { RequestHandler } from '../router.ts';
import type { ManagerApi } from '../sessions/manager-api.ts';
import { SCENARIO_BLOCKED_PROMPT } from './scenarios.ts';
import type { ScenarioDriver, ScenarioPanels } from './scenarios.ts';
import { DEMO_NOTE_CWD } from './notes.ts';
import type { DemoNotes } from './notes.ts';

const gate = z.enum(['pass', 'hold']);
const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('reset') }).strict(),
  z.object({ action: z.literal('configure'), snapshot: gate.optional(), messageResponse: gate.optional(),
    echo: gate.optional(), unauthorized: z.boolean().optional(),
    // Trasy diffa per plik: lista jak na serwerze sprzed tych tras (405) i patch pliku wstrzymany,
    // z awarią gita (503) albo długi — stany okna diffa, których sam demo-diff nie wywoła.
    diffList: z.enum(['pass', 'outdated']).optional(),
    diffFile: z.enum(['pass', 'hold', 'fail', 'long']).optional() }).strict(),
  z.object({ action: z.literal('release'),
    target: z.enum(['snapshot', 'response', 'echo', 'diff', 'stream', 'all']) }).strict(),
  // The transcript stream of one session goes silent: no `retry:`, frames or pings, on open connections and on new
  // ones (headers only). The global stream and other sessions keep flowing, so the app sees a stalled session stream.
  z.object({ action: z.literal('freeze-stream'), sessionId: z.string().trim().min(1).max(200) }).strict(),
  z.object({ action: z.literal('create'),
    scenario: z.enum(['idle', 'stress500', 'question', 'cannot-allow', 'permission', 'workflow', 'standby',
      'artifacts', 'pull-requests', 'scheduled-tasks', 'prompt-blocked']),
    label: z.string().trim().min(1).max(80).optional(),
    // Katalog sesji zamiast `SCENARIO_CWD`: długa nazwa projektu w nagłówku (tytuł to nazwa katalogu, nie etykieta).
    cwd: z.string().startsWith('/').max(200).optional() }).strict(),
  // Notatka projektu zapisana „na innym urządzeniu": nowa wersja w magazynie demo i event `notes`.
  z.object({ action: z.literal('note-remote'), text: z.string().max(4096) }).strict(),
  z.object({ action: z.literal('emit'), sessionId: z.uuid(),
    event: z.enum(['delta', 'message', 'system', 'clear-question', 'detach', 'git-status',
      'workflow-agent', 'workflow-done', 'workflow-phase', 'workflow-end', 'agent-wake', 'title']),
    text: z.string().max(4096).optional() }).strict(),
]);

type GateKind = 'snapshots' | 'responses' | 'echoes' | 'diffs' | 'streams';
/** Trasy diffa sesji: stara (`…/diff`), lista (`…/diff/files`) i plik (`…/diff/file`). */
const DIFF_ROUTE = /^\/api\/sessions\/[^/]+\/diff(\/files|\/file)?$/;
/** Transcript stream of one session (`GET /api/sessions/:id/stream`); the group is the raw id segment. */
const SESSION_STREAM_ROUTE = /^\/api\/sessions\/([^/]+)\/stream$/;
/** Ile linii ma patch z bramki `diffFile: 'long'` — kilka ekranów iPada, żeby dało się czytać „w środku pliku". */
const LONG_PATCH_LINES = 400;

/** Patch nowego pliku o {@link LONG_PATCH_LINES} liniach: pliki demo mają po kilka, a okno diffa trzeba przewinąć. */
function longPatch(path: string): string {
  const lines = Array.from({ length: LONG_PATCH_LINES }, (_, index) => `+  linia ${String(index + 1)} długiego pliku demo`);
  return [
    `diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null', `+++ b/${path}`,
    `@@ -0,0 +1,${String(LONG_PATCH_LINES)} @@`, ...lines, '',
  ].join('\n');
}
interface Held { kind: GateKind; res: ServerResponse; bytes: number; resume(): void }
interface MessageReceipt { sessionId: string; clientMessageId: string | null }
interface Accepted extends MessageReceipt { replayed: boolean }
interface AnswerReceipt { sessionId: string; qId: string }
interface DecisionReceipt { sessionId: string; permId: string | null }

function loopback(peer: string | undefined): boolean {
  return peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
}

function allowedControl(req: IncomingMessage, config: RarogConfig): boolean {
  if (!loopback(req.socket.remoteAddress) || req.headers['x-rarog-demo-token'] !== 'demo') return false;
  // Ta sama reguła `Origin` co router (`auth/origin.ts`), potem warunki demo: pętla i `http:`.
  if (!originAllowed(req, config)) return false;
  const origin = req.headers.origin ?? '';
  try {
    const url = new URL(origin);
    return url.origin === origin && url.protocol === 'http:'
      && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch { return false; }
}

function segment(raw: string): string {
  try { return decodeURIComponent(raw); } catch { return raw; }
}

/** Ciało błędu demo w kształcie routera (`errorBodyOf`): tekst i `messageRef` zdania z kodem. */
function demoError(
  error: string, sentence: ServerSentence,
): { error: string; message: string; messageRef: ServerSentence['ref'] } {
  return { error, message: sentence.text, messageRef: sentence.ref };
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

/** Notatki demo pod kontrolą testów: magazyn w pamięci i rozesłanie eventu `notes` (z `index.ts`, który zna hub). */
export interface DemoNotesControl {
  readonly store: DemoNotes;
  announce(cwd: string, empty: boolean): void;
}

/** Fabryka również bramkuje config: omyłkowe użycie poza demo oddaje oryginalny router. */
export function createDemoControl(
  router: RequestHandler, config: RarogConfig, manager: ManagerApi, panels: ScenarioPanels, notes?: DemoNotesControl,
): { handler: RequestHandler; dispose(): void } {
  if (!config.demo) return { handler: router, dispose() {} };

  const state = {
    snapshot: 'pass', messageResponse: 'pass', echo: 'pass', unauthorized: false, diffList: 'pass', diffFile: 'pass',
    frozenStream: null as string | null,
  };
  const held = new Set<Held>();
  const watchedResponses = new WeakSet<ServerResponse>();
  let heldBytes = 0;
  const receivedMessages: MessageReceipt[] = [];
  const acceptedMessages: Accepted[] = [];
  // Każdy POST odpowiedzi/decyzji sesji odbioru, zanim router go oceni: spóźniona cyfra po
  // zniknięciu karty dostaje 410 bez wywołania drivera, więc liczniki drivera jej nie widzą.
  const receivedAnswers: AnswerReceipt[] = [];
  const receivedDecisions: DecisionReceipt[] = [];
  // Odczyty diffa KAŻDEJ sesji: prawy panel apki nie pobiera diffa bez stuknięcia — test liczy żądania, które naprawdę doszły do serwera. `diffRequests` to SUMA wszystkich tras
  // diffa (stara `…/diff` i obie per plik), więc asercje „zero bez stuknięcia" pilnują każdej z nich.
  let diffRequests = 0;
  // Trasy per plik osobno: lista zmian, patch pliku i ŚCIEŻKI, o które poproszono — po nich test
  // dowodzi, że poszedł patch jednego, stukniętego pliku. Lista ścieżek z sufitem, jak reszta kontroli.
  let diffListRequests = 0;
  let diffFileRequests = 0;
  const diffFilePaths: string[] = [];
  // Notatki projektu: odczyty i zapisy trasy `/api/notes`, zanim router je oceni — test dowodzi nimi, że
  // dymek czyta, a zamknięcie formularza zapisuje.
  let notesGets = 0;
  let notesPuts = 0;
  let sessionId: string | null = null;
  let driver: ScenarioDriver | null = null;
  // Jedna operacja sterująca naraz: reset/create nie mogą zgubić właśnie dodanego panelu.
  let controlChain = Promise.resolve();

  function hold(kind: GateKind, res: ServerResponse, resume: () => void, bytes = 0): Held | null {
    // A closed response has already left the buffer (`close` below), so a late write would stay held forever.
    if (res.destroyed) return null;
    // Kontrola testowa nie może nieograniczenie buforować otwartego strumienia.
    if (held.size >= 512 || heldBytes + bytes > 16 * 1024 * 1024) { res.destroy(); return null; }
    const entry = { kind, res, bytes, resume };
    held.add(entry);
    heldBytes += bytes;
    if (!watchedResponses.has(res)) {
      watchedResponses.add(res);
      res.once('close', () => {
        for (const item of held) {
          if (item.res !== res) continue;
          held.delete(item);
          heldBytes -= item.bytes;
        }
      });
    }
    return entry;
  }

  /** Takes an entry out of the buffer; a second call for the same entry changes nothing. */
  function drop(entry: Held): void {
    if (held.delete(entry)) heldBytes -= entry.bytes;
  }

  /** Puts an entry that is still waiting back into the buffer under another gate. */
  function rehold(entry: Held, kind: GateKind): void {
    entry.kind = kind;
    if (held.has(entry)) return;
    held.add(entry);
    heldBytes += entry.bytes;
  }

  function release(kind?: GateKind): void {
    // A copy of the set: an entry that goes back under another gate is not visited twice in one pass.
    for (const entry of [...held]) {
      if (!held.has(entry) || (kind !== undefined && entry.kind !== kind)) continue;
      drop(entry);
      if (!entry.res.destroyed) entry.resume();
    }
  }

  function stats() {
    return {
      sessionId, config: { ...state }, receivedMessages: [...receivedMessages], acceptedMessages: [...acceptedMessages],
      receivedAnswers: [...receivedAnswers], receivedDecisions: [...receivedDecisions],
      driverSends: driver?.sends ?? 0, driverDecisions: driver?.decisions ?? 0, driverAnswers: driver?.answers ?? [],
      diffRequests, diffListRequests, diffFileRequests, diffFilePaths: [...diffFilePaths],
      notesGets, notesPuts, noteText: notes?.store.read(DEMO_NOTE_CWD).text ?? null,
      held: {
        snapshots: [...held].filter((entry) => entry.kind === 'snapshots').length,
        responses: [...held].filter((entry) => entry.kind === 'responses').length,
        echoes: [...held].filter((entry) => entry.kind === 'echoes').length,
        diffs: [...held].filter((entry) => entry.kind === 'diffs').length,
        streams: [...held].filter((entry) => entry.kind === 'streams').length,
      },
      // Obserwacja bez skutku otwarcia transkryptu: w demo ponawiałby ramkę `git-status`, a każda taka ramka
      // odświeża otwarte okno diffa apki — test odpytuje statystyki co 100 ms.
      transcriptMessages: sessionId === null || manager.get(sessionId) === undefined
        ? 0 : manager.transcript(sessionId, { peek: true }).messages.length,
    };
  }

  async function reset(): Promise<void> {
    Object.assign(state, {
      snapshot: 'pass', messageResponse: 'pass', echo: 'pass', unauthorized: false, diffList: 'pass', diffFile: 'pass',
      frozenStream: null,
    });
    release();
    if (sessionId !== null && manager.get(sessionId) !== undefined) await manager.close(sessionId, { closePanel: true });
    driver?.dispose();
    sessionId = null;
    driver = null;
    receivedMessages.length = 0;
    acceptedMessages.length = 0;
    receivedAnswers.length = 0;
    receivedDecisions.length = 0;
    diffRequests = 0;
    diffListRequests = 0;
    diffFileRequests = 0;
    diffFilePaths.length = 0;
    notesGets = 0;
    notesPuts = 0;
    notes?.store.reset();
  }

  async function control(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!allowedControl(req, config)) { json(res, 403, { error: 'demo-control-forbidden' }); return; }
    if (req.method === 'GET') { json(res, 200, stats()); return; }
    if (req.method !== 'POST') { json(res, 405, { error: 'method-not-allowed' }); return; }
    const body = await readBody(req, 8192, 5000);
    if (!body.ok) { json(res, body.reason === 'too-large' ? 413 : 400, { error: 'demo-control-body' }); return; }
    let raw: unknown;
    try { raw = JSON.parse(body.text); } catch { json(res, 400, { error: 'demo-control-json' }); return; }
    const parsed = actionSchema.safeParse(raw);
    if (!parsed.success) { json(res, 400, { error: 'demo-control-schema' }); return; }
    const action = parsed.data;
    if (action.action === 'reset') await reset();
    if (action.action === 'configure') {
      const { action: _, ...patch } = action;
      Object.assign(state, patch);
    }
    if (action.action === 'release') {
      if (action.target === 'snapshot' || action.target === 'all') { state.snapshot = 'pass'; release('snapshots'); }
      if (action.target === 'response' || action.target === 'all') { state.messageResponse = 'pass'; release('responses'); }
      if (action.target === 'echo' || action.target === 'all') { state.echo = 'pass'; release('echoes'); }
      if (action.target === 'diff' || action.target === 'all') { state.diffFile = 'pass'; release('diffs'); }
      if (action.target === 'stream' || action.target === 'all') { state.frozenStream = null; release('streams'); }
    }
    if (action.action === 'freeze-stream') state.frozenStream = action.sessionId;
    if (action.action === 'create') {
      const scenario = action.scenario;
      await reset();
      const pane = panels.create(scenario, action.label ?? `M1 ${scenario}`, action.cwd);
      sessionId = pane.sessionId;
      driver = pane.driver;
      // Adopcja i historia są asynchroniczne. Odpowiedź create daje gotowy scenariusz,
      // nie przybliżony czas, po którym runner ma zgadywać, czy pump już go przetworzył.
      const until = Date.now() + 5000;
      function ready(): boolean {
        if (sessionId === null || driver === null || manager.get(sessionId) === undefined || driver.events.pendingCount > 0) return false;
        const transcript = manager.transcript(sessionId, { peek: true });
        if (scenario === 'stress500') return transcript.messages.length === 500;
        if (scenario === 'question') return transcript.pendingQuestions.some((request) => request.qId === 'm1-question');
        if (scenario === 'cannot-allow' || scenario === 'permission') {
          return transcript.pendingPermissions.some((request) => request.permId === 'm1-permission');
        }
        const session = manager.get(sessionId);
        const inBackground = scenario === 'workflow' || scenario === 'standby';
        if (inBackground && (session?.backgroundTasks?.length ?? 0) === 0) return false;
        if (scenario === 'standby' && transcript.messages.length < 4) return false;
        if (scenario === 'artifacts' && ((session?.artifacts?.length ?? 0) < 2 || transcript.messages.length < 6)) {
          return false;
        }
        if (scenario === 'pull-requests'
          && ((session?.pullRequests?.length ?? 0) < 3 || transcript.messages.length < 4)) {
          return false;
        }
        if (scenario === 'scheduled-tasks'
          && ((session?.scheduledTasks?.length ?? 0) < 2 || transcript.messages.length < 4)) {
          return false;
        }
        return session?.state === 'waiting-input';
      }
      // Każde sprawdzenie następuje po ticku I/O: ostatni zdjęty event zdążył przejść
      // synchroniczny #handleDriverEvent, a gotowość potwierdzają rzeczywiste dane managera.
      await new Promise<void>((resolve) => { setImmediate(resolve); });
      while (!ready()) {
        if (Date.now() > until) throw new Error('M1 panel attachment timed out');
        await new Promise<void>((resolve) => { setImmediate(resolve); });
      }
      // `prompt-blocked`: prompt idzie zwykłą wysyłką managera, jak z apki (echo, pierścień wysyłek,
      // znacznik tury), a hook scenariusza go blokuje. Gotowe, gdy karta niesie blokadę z przyciskiem.
      if (scenario === 'prompt-blocked') {
        await manager.sendMessage(pane.sessionId, SCENARIO_BLOCKED_PROMPT);
        const blocked = (): boolean => {
          const session = manager.get(pane.sessionId);
          return session?.promptBlocked !== undefined && session.state === 'waiting-input'
            && pane.driver.events.pendingCount === 0;
        };
        while (!blocked()) {
          if (Date.now() > until) throw new Error('M1 prompt block timed out');
          await new Promise<void>((resolve) => { setImmediate(resolve); });
        }
      }
      json(res, 200, { sessionId });
      return;
    }
    if (action.action === 'note-remote') {
      if (notes === undefined) { json(res, 409, { error: 'demo-notes-off' }); return; }
      const saved = notes.store.writeRemote(DEMO_NOTE_CWD, action.text);
      notes.announce(DEMO_NOTE_CWD, notesEmpty(saved.text));
    }
    if (action.action === 'emit') {
      if (action.sessionId !== sessionId || driver === null) { json(res, 404, { error: 'demo-session-not-found' }); return; }
      // Zdarzenie spoza scenariusza (przebieg workflow bez scenariusza `workflow`) nie udaje sukcesu.
      if (!driver.emit(action.event, action.text)) { json(res, 409, { error: 'demo-scenario-mismatch' }); return; }
      await new Promise<void>((resolve) => { setImmediate(resolve); });
    }
    json(res, 200, stats());
  }

  /** Liczy żądanie GET którejkolwiek trasy diffa (stara, lista, plik) — zanim router je oceni. */
  function countDiff(url: URL): void {
    const route = DIFF_ROUTE.exec(url.pathname);
    if (route === null) return;
    diffRequests += 1;
    if (route[1] === '/files') diffListRequests += 1;
    if (route[1] !== '/file') return;
    diffFileRequests += 1;
    if (diffFilePaths.length < 512) diffFilePaths.push(url.searchParams.get('path') ?? '');
  }

  function intercept(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const pathname = url.pathname;
    // The gates below read SSE frames as text. The server gzips a stream for a client that accepts it
    // (`RAROG_SSE_GZIP`, on by default; the app's URLSession always accepts it), so this demo never offers
    // compression: the frames stay the same, only uncompressed.
    delete req.headers['accept-encoding'];
    const originalWrite = res.write.bind(res);
    const streamSession = SESSION_STREAM_ROUTE.exec(pathname)?.[1];
    let headersFlushed = false;
    /** Writes of this response waiting behind a gate, oldest first; each one is also an entry of `held`. */
    const queue: { entry: Held; data: string; args: unknown[] }[] = [];

    /** The gate that holds this write now, read on every call, so a freeze also silences an open stream. */
    function gateOf(data: string): GateKind | null {
      if (streamSession !== undefined && segment(streamSession) === state.frozenStream) return 'streams';
      const match = /^data: (.+)$/m.exec(data);
      let event: Record<string, unknown> | null = null;
      if (match?.[1] !== undefined) {
        try { event = JSON.parse(match[1]) as Record<string, unknown>; } catch { /* komentarze SSE nie mają JSON */ }
      }
      if (event === null || event.type === 'hello') return null;
      let kind: GateKind | null = null;
      if (pathname === '/api/stream' && state.snapshot === 'hold') kind = 'snapshots';
      if (event.sessionId === sessionId && state.echo === 'hold') {
        const message = event.message as { clientMessageId?: string } | undefined;
        const messages = event.messages as { clientMessageId?: string }[] | undefined;
        if (message?.clientMessageId !== undefined || messages?.some((item) => item.clientMessageId !== undefined)) kind = 'echoes';
      }
      return kind;
    }

    function flushIfFrozen(kind: GateKind): void {
      // A new frozen connection sends its headers and nothing else: a response without a first byte.
      if (kind === 'streams' && !headersFlushed) { headersFlushed = true; res.flushHeaders(); }
    }

    // A released write goes through the gates again: one still held by another gate stays at the head of the queue,
    // and the later writes of this connection wait behind it under that gate, so the order never changes.
    function drain(): void {
      while (queue.length > 0) {
        const head = queue[0];
        if (head === undefined) return;
        const kind = gateOf(head.data);
        if (kind !== null) {
          flushIfFrozen(kind);
          for (const item of queue) rehold(item.entry, kind);
          return;
        }
        queue.shift();
        drop(head.entry);
        Reflect.apply(originalWrite, res, head.args);
      }
    }

    res.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      const data = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      const kind = queue[0]?.entry.kind ?? gateOf(data);
      if (kind === null) return Reflect.apply(originalWrite, res, [chunk, ...rest]) as boolean;
      flushIfFrozen(kind);
      const entry = hold(kind, res, drain, Buffer.byteLength(data));
      if (entry !== null) queue.push({ entry, data, args: [chunk, ...rest] });
      return true;
    }) as typeof res.write;

    if (req.method === 'GET') countDiff(url);
    if (pathname === '/api/notes') {
      if (req.method === 'GET') notesGets += 1;
      if (req.method === 'PUT') notesPuts += 1;
    }
    if (req.method !== 'POST' || sessionId === null) return;
    const id = sessionId;
    const prefix = `/api/sessions/${id}/`;
    if (!pathname.startsWith(prefix)) return;
    const rest = pathname.slice(prefix.length).split('/');
    if (rest[0] === 'answers' && rest.length === 2) {
      receivedAnswers.push({ sessionId: id, qId: segment(rest[1] ?? '') });
      return;
    }
    if (rest[0] === 'permissions' && rest.length === 2) {
      receivedDecisions.push({ sessionId: id, permId: segment(rest[1] ?? '') });
      return;
    }
    if (rest[0] === 'permission' && rest.length === 1) {
      receivedDecisions.push({ sessionId: id, permId: null });
      return;
    }
    if (rest[0] !== 'messages' || rest.length !== 1) return;
    // The receipt counts the POST on arrival, so a request refused before its body is read still counts. The body
    // is observed through `emit`, not a `data` listener: a listener switches the stream to flowing mode on the next
    // tick, and the router, which reaches the body only after awaiting its route groups, would read an empty body.
    const receipt: MessageReceipt = { sessionId: id, clientMessageId: null };
    receivedMessages.push(receipt);
    const chunks: Buffer[] = [];
    let bytes = 0;
    const originalEmit = req.emit.bind(req);
    req.emit = ((event: string | symbol, ...args: unknown[]) => {
      if (event === 'data') {
        const chunk = args[0];
        const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer;
        bytes += buffer.length;
        if (bytes <= 8192) chunks.push(buffer);
      } else if (event === 'end' && bytes <= 8192) {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { clientMessageId?: unknown };
          if (typeof value.clientMessageId === 'string') receipt.clientMessageId = value.clientMessageId;
        } catch { /* router odpowie na wadliwe ciało; statystyka nie przechowuje treści */ }
      }
      return Reflect.apply(originalEmit, req, [event, ...args]) as boolean;
    }) as typeof req.emit;
    const originalEnd = res.end.bind(res);
    res.end = ((...args: unknown[]) => {
      if (res.statusCode === 202 && typeof args[0] === 'string') {
        const body = JSON.parse(args[0]) as { clientMessageId?: string; replayed?: boolean };
        acceptedMessages.push({ sessionId: id, clientMessageId: body.clientMessageId ?? null, replayed: body.replayed === true });
        if (state.messageResponse === 'hold') {
          hold('responses', res, () => { Reflect.apply(originalEnd, res, args); });
          return res;
        }
      }
      return Reflect.apply(originalEnd, res, args) as ServerResponse;
    }) as typeof res.end;
  }

  /**
   * Trasy diffa per plik pod kontrolą testu; `true` = odpowiedź należy do kontroli, router jej nie dostaje
   * (wstrzymane żądanie pliku dostaje go po `release`).
   *
   * - `diffList: 'outdated'` — lista odpowiada jak serwer sprzed tych tras: 405 `method-not-allowed`
   *   z `Allow: POST` (nieznany `GET` pod `/api/sessions/:id/…` wpadał tam w strażnika metody);
   * - `diffFile: 'fail'` — patch pliku odpowiada 503 `git-failed`, jak przy limicie czasu gita;
   * - `diffFile: 'hold'` — żądanie pliku czeka na `release` z celem `diff`;
   * - `diffFile: 'long'` — każda ścieżka dostaje patch o 400 liniach (pliki demo mają po kilka), więc test
   *   może przewinąć okno w głąb pliku.
   */
  function overrideDiff(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
    if (req.method !== 'GET') return false;
    const route = DIFF_ROUTE.exec(url.pathname)?.[1];
    if (route === '/files' && state.diffList === 'outdated') {
      res.setHeader('Allow', 'POST');
      json(res, 405, demoError('method-not-allowed', say('rest.method-not-allowed')));
      return true;
    }
    if (route !== '/file') return false;
    if (state.diffFile === 'fail') {
      json(res, 503, demoError('git-failed', say('rest.diff-git-failed')));
      return true;
    }
    if (state.diffFile === 'long') {
      const path = url.searchParams.get('path') ?? '';
      json(res, 200, { path, patch: longPatch(path), truncated: false });
      return true;
    }
    if (state.diffFile !== 'hold') return false;
    hold('diffs', res, () => { router(req, res); });
    return true;
  }

  const handler: RequestHandler = (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;
    if (pathname === '/api/demo/control') {
      controlChain = controlChain.then(() => control(req, res)).catch(() => {
        if (!res.destroyed && !res.writableEnded) json(res, 500, { error: 'demo-control-failed' });
      });
      return;
    }
    if (state.unauthorized && pathname.startsWith('/api/') && pathname !== '/api/login') {
      json(res, 401, demoError('unauthorized', say('demo.unauthorized')));
      return;
    }
    intercept(req, res, url);
    if (overrideDiff(req, res, url)) return;
    router(req, res);
  };
  return { handler, dispose() {
    for (const entry of held) entry.res.destroy();
    held.clear(); heldBytes = 0; driver?.dispose();
  } };
}
