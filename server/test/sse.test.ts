import type { ServerEvent, TranscriptMessage } from '@rarog/shared';
import { IMAGE_DATA_URL_PATTERN, PROTOCOL_VERSION, parseServerEvent } from '@rarog/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { installFolderGate } from '../src/folder-gate/install.ts';
import type { FolderBlock, FolderGate, FolderState } from '../src/folder-gate/types.ts';
import { RING_MAX_BYTES } from '../src/sessions/ring-buffer.ts';
import {
  REPLAY_SNAPSHOT_LOG, REPLAY_SNAPSHOT_MIN_MESSAGES, SNAPSHOT_IMAGE_BUDGET_BYTES, SNAPSHOT_IMAGE_PLACEHOLDER,
  SSE_WRITE_BUFFER_MAX, SseHub, type SseInbox, type SseResponse, WRITE_BUFFER_CUT_LOG, budgetSnapshotImages,
  formatSseEvent, parseLastEventId,
} from '../src/sse.ts';
import { FakeManager, makeSummary } from './fake-manager.ts';

/** Atrapa odpowiedzi HTTP: zbiera zapisane ramki i pozwala „zamknąć" połączenie. */
class FakeRes implements SseResponse {
  status = 0;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  ended = false;
  /** Ile bajtów „czeka w gnieździe" — atrapa backpressure (`http.ServerResponse`). */
  writableLength = 0;
  /** `write()` oddaje `false` (bufor pełny), ale ramkę i tak przyjmuje. */
  writeReturns = true;
  /** `write()` rzuca — gniazdo zerwane w locie. */
  throwOnWrite = false;
  private closeCbs: (() => void)[] = [];

  writeHead(status: number, headers: Record<string, string>): unknown {
    this.status = status;
    this.headers = headers;
    return this;
  }

  write(chunk: string): boolean {
    if (this.throwOnWrite) throw new Error('EPIPE');
    this.chunks.push(chunk);
    return this.writeReturns;
  }

  end(): unknown {
    this.ended = true;
    return this;
  }

  on(event: 'close', listener: () => void): unknown {
    if (event === 'close') this.closeCbs.push(listener);
    return this;
  }

  /** Symuluje zerwanie połączenia przez klienta. */
  fireClose(): void {
    for (const cb of this.closeCbs) cb();
  }

  /** Ramki danych (bez `retry:` i heartbeatów) rozbite na { id, event }. */
  frames(): { id: number | null; event: ServerEvent }[] {
    return this.chunks
      .join('')
      .split('\n\n')
      .filter((raw) => raw.includes('data: '))
      .map((raw) => {
        const idLine = /^id: (?:[^\n:]*:)?(\d+)$/m.exec(raw);
        const dataLine = /^data: (.*)$/m.exec(raw);
        const event = parseServerEvent(dataLine?.[1] ?? '');
        if (event === null) throw new Error(`nieparsowalna ramka: ${raw}`);
        return { id: idLine === null ? null : Number(idLine[1]), event };
      });
  }
}

function message(seq: number): TranscriptMessage {
  return { seq, role: 'assistant', blocks: [{ type: 'text', text: `m${String(seq)}` }],
    at: '2026-08-21T10:00:00.000Z' };
}

/** Hub z wyłączonym realnym heartbeatem — puls wywołujemy ręcznie. */
function makeHub(manager: FakeManager, heartbeatMs = 0): SseHub {
  const hub = new SseHub({
    manager, serverStartId: 'start-1', protocolVersion: PROTOCOL_VERSION, heartbeatMs,
  });
  hub.start();
  return hub;
}

describe('formatSseEvent', () => {
  const delta: ServerEvent = { type: 'delta', sessionId: 's1', text: 'abc' };
  const msg: ServerEvent = { type: 'message', sessionId: 's1', message: message(7) };

  it('domknięta wiadomość dostaje id = seq', () => {
    expect(formatSseEvent(msg, 7)).toMatch(/^id: 7\ndata: \{/);
    // Z prefiksem procesu — tak jedzie KAŻDA ramka z huba.
    expect(formatSseEvent(msg, 7, 'srv-1')).toMatch(/^id: srv-1:7\ndata: \{/);
  });

  it('delta NIE ma id (nie przesuwa Last-Event-ID)', () => {
    const frame = formatSseEvent(delta, null);
    expect(frame.startsWith('data: ')).toBe(true);
    expect(frame).not.toContain('id:');
  });

  it('ramka kończy się pustą linią', () => {
    expect(formatSseEvent(delta, null).endsWith('\n\n')).toBe(true);
  });

  /*
   * `activity` jest ULOTNA dokładnie jak `delta` — po reconnekcie nie może
   * wrócić z replayu („uruchamia: Bash" sprzed pięciu minut byłoby kłamstwem). Stan odtwarza
   * pole `activity` w `transcript-snapshot`.
   */
  it('activity NIE ma id, a snapshot niesie ostatnią znaną aktywność', () => {
    const activity: ServerEvent = { type: 'activity', sessionId: 's1', kind: 'thinking' };
    expect(formatSseEvent(activity, null)).not.toContain('id:');

    const manager = new FakeManager([makeSummary({ id: 's1' })]);
    manager.transcriptResult = {
      messages: [], pendingPermissions: [], pendingQuestions: [],
      activity: { kind: 'tool', toolName: 'Bash', elapsedSeconds: 148 },
    };
    const hub = makeHub(manager);
    const res = new FakeRes();
    hub.openSession('s1', res, null);
    const snapshot = res.frames().at(-1)?.event;
    expect(snapshot?.type).toBe('transcript-snapshot');
    expect(snapshot?.type === 'transcript-snapshot' && snapshot.activity)
      .toEqual({ kind: 'tool', toolName: 'Bash', elapsedSeconds: 148 });
  });
});

describe('parseLastEventId', () => {
  it('czyta poprawną liczbę', () => {
    expect(parseLastEventId('12')).toEqual({ seq: 12, startId: null });
    expect(parseLastEventId(' 12 ')).toEqual({ seq: 12, startId: null });
    // Kursor z prefiksem procesu — hub porówna `startId` z własnym.
    expect(parseLastEventId('srv-1:12')).toEqual({ seq: 12, startId: 'srv-1' });
  });

  it('brak/śmieci → null', () => {
    expect(parseLastEventId(undefined)).toBeNull();
    expect(parseLastEventId('')).toBeNull();
    expect(parseLastEventId('abc')).toBeNull();
    expect(parseLastEventId('-3')).toBeNull();
    expect(parseLastEventId('1.5')).toBeNull();
  });

  it('bierze pierwszy element, gdy nagłówek powtórzony', () => {
    expect(parseLastEventId(['5', '9'])).toEqual({ seq: 5, startId: null });
  });
});

describe('strumień globalny', () => {
  let manager: FakeManager;

  beforeEach(() => {
    manager = new FakeManager([makeSummary({ id: 's1' }), makeSummary({ id: 's2' })]);
  });

  it('otwiera się nagłówkami SSE i wysyła hello + sessions-snapshot', () => {
    const hub = makeHub(manager);
    const res = new FakeRes();
    hub.openGlobal(res);

    expect(res.status).toBe(200);
    expect(res.headers['Content-Type']).toContain('text/event-stream');
    expect(res.headers['Cache-Control']).toContain('no-cache');

    const frames = res.frames();
    expect(frames[0]?.event).toEqual({
      type: 'hello', protocolVersion: PROTOCOL_VERSION, serverStartId: 'start-1',
    });
    const snapshot = frames[1]?.event;
    expect(snapshot?.type).toBe('sessions-snapshot');
    expect(snapshot?.type === 'sessions-snapshot' && snapshot.sessions).toHaveLength(2);
    expect(frames.every((f) => f.id === null)).toBe(true);
  });

  it('próg builda apki jedzie w hello; bez progu pola NIE ma', () => {
    // Brak pola = brak bramki (ani „0", ani `null`): stary front i tak by je odciął, a apka
    // bez pola zostaje w `ok` — tak samo jak przy serwerze sprzed tej zmiany.
    const bezProgu = new FakeRes();
    makeHub(manager).openGlobal(bezProgu);
    expect(bezProgu.frames()[0]?.event).not.toHaveProperty('minClientBuild');

    const hub = new SseHub({
      manager, serverStartId: 'start-1', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0,
      minClientBuild: 42,
    });
    hub.start();
    const zProgiem = new FakeRes();
    hub.openGlobal(zProgiem);
    expect(zProgiem.frames()[0]?.event).toEqual({
      type: 'hello', protocolVersion: PROTOCOL_VERSION, serverStartId: 'start-1', minClientBuild: 42,
    });
  });

  it('hello announces the default heartbeat interval; with the heartbeat off or out of range the field is absent', () => {
    const helloOf = (options: { heartbeatMs?: number }): ServerEvent | undefined => {
      const hub = new SseHub({
        manager, serverStartId: 'start-1', protocolVersion: PROTOCOL_VERSION, ...options,
        setInterval: () => 1, clearInterval: () => {},
      });
      hub.start();
      const res = new FakeRes();
      hub.openGlobal(res);
      return res.frames()[0]?.event;
    };
    expect(helloOf({})).toEqual({
      type: 'hello', protocolVersion: PROTOCOL_VERSION, serverStartId: 'start-1', heartbeatMs: 10_000,
    });
    // The app falls back to its own idle limit without the field; `0` or `null` would reject the frame.
    expect(helloOf({ heartbeatMs: 0 })).not.toHaveProperty('heartbeatMs');
    // A test hub with a tiny interval still pings, but announces only an interval the app treats as valid.
    expect(helloOf({ heartbeatMs: 5 })).not.toHaveProperty('heartbeatMs');
  });

  it('bez integracji herdr ramka startowa NIE ma pola herdrStatus', () => {
    const hub = makeHub(manager);
    const res = new FakeRes();
    hub.openGlobal(res);

    const snapshot = res.frames()[1]?.event;
    // Brak pola znaczy „integracja wyłączona" — a to co innego niż „herdr niedostępny".
    // Gdyby leciało tu `available: false`, baner kłamałby u każdego, kto herdr nie używa.
    expect(snapshot?.type === 'sessions-snapshot' && 'herdrStatus' in snapshot).toBe(false);
  });

  it('stan herdr jedzie w TEJ SAMEJ ramce co lista sesji', () => {
    /*
     * Osobnego endpointu REST na to nie ma świadomie: iOS zrywa SSE przy każdym uśpieniu
     * ekranu, więc ten strumień otwiera się kilkadziesiąt razy dziennie. Status w ramce
     * startowej znaczy, że baner jest prawdziwy natychmiast po powrocie do apki.
     */
    manager.herdrStatusResult = {
      available: false, agentCount: 17, readOnly: false, canLaunch: false,
      detail: 'socket nieosiągalny',
    };
    const hub = makeHub(manager);
    const res = new FakeRes();
    hub.openGlobal(res);

    const snapshot = res.frames()[1]?.event;
    expect(snapshot?.type === 'sessions-snapshot' && snapshot.herdrStatus).toEqual({
      available: false, agentCount: 17, readOnly: false, canLaunch: false,
      detail: 'socket nieosiągalny',
    });
  });

  /*
   * Web Push wycofany: ramka startowa nie niesie już stanu kanału pushy — degradację APNs
   * apka zna z `POST /api/push/apns/status`, per token.
   */
  it('ramka startowa nie niesie `pushDegradedSince`', () => {
    const hub = makeHub(manager);
    const res = new FakeRes();
    hub.openGlobal(res);
    const snapshot = res.frames()[1]?.event;
    expect(snapshot?.type).toBe('sessions-snapshot');
    expect(snapshot !== undefined && 'pushDegradedSince' in snapshot).toBe(false);
  });

  it('event herdr-status trafia do strumienia globalnego bez `id`', () => {
    const hub = makeHub(manager);
    const res = new FakeRes();
    hub.openGlobal(res);
    const before = res.frames().length;

    manager.emit('global', null, {
      type: 'herdr-status', available: true, agentCount: 17, readOnly: false,
    });

    const frames = res.frames().slice(before);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.event.type).toBe('herdr-status');
    // Ulotny: brak `id:` znaczy, że nie przesuwa `Last-Event-ID`.
    expect(frames[0]?.id).toBeNull();
  });

  it('dostaje eventy ze scope global i NIE dostaje eventów sesji', () => {
    const hub = makeHub(manager);
    const res = new FakeRes();
    hub.openGlobal(res);
    const before = res.frames().length;

    manager.emit('global', null, { type: 'session-changed', session: makeSummary({ id: 's1' }) });
    manager.emit('s1', null, { type: 'delta', sessionId: 's1', text: 'x' });

    const frames = res.frames().slice(before);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.event.type).toBe('session-changed');
  });
});

describe('strumień sesji', () => {
  let manager: FakeManager;

  beforeEach(() => {
    manager = new FakeManager([makeSummary({ id: 's1' })]);
  });

  it('bez Last-Event-ID wysyła transcript-snapshot', () => {
    manager.transcriptResult = {
      messages: [message(1), message(2)], pendingPermissions: [], pendingQuestions: [],
    };
    const hub = makeHub(manager);
    const res = new FakeRes();
    hub.openSession('s1', res, null);

    const first = res.frames()[0];
    expect(first?.event.type).toBe('transcript-snapshot');
    expect(first?.id).toBeNull();
    expect(first?.event.type === 'transcript-snapshot' && first.event.messages).toHaveLength(2);
  });

  it('z Last-Event-ID odtwarza ogon z ring buffera zachowując seq', () => {
    // Jedna wiadomość: poniżej progu snapshotu, więc powtórka jedzie ramka po ramce.
    manager.eventsSinceResult = {
      tooOld: false,
      events: [
        { seq: 4, event: { type: 'message', sessionId: 's1', message: message(4) } },
        { seq: 5, event: { type: 'session-changed', session: makeSummary({ id: 's1' }) } },
      ],
    };
    const hub = makeHub(manager);
    const res = new FakeRes();
    hub.openSession('s1', res, { seq: 3, startId: 'start-1' });

    expect(manager.calls.filter((c) => c.method === 'eventsSince')[0]?.args).toEqual(['s1', 3]);
    expect(res.frames().map((f) => f.id)).toEqual([4, 5]);
    expect(manager.calls.some((c) => c.method === 'transcript')).toBe(false);
  });

  /*
   * The client keeps its cursor across a backend restart (only a route change replaces the stream
   * instance, and `pnpm run restart` does not change the route). The new process rebuilds the same
   * session and passes the old number within seconds while importing history, so a check by number
   * alone (`tooOld`) would say "valid" and the client would get a replay INSTEAD of a snapshot,
   * losing everything the new process emitted below it (restored consent cards included).
   */
  it('kursor z INNEGO procesu → transcript-snapshot, nie replay', () => {
    manager.eventsSinceResult = {
      tooOld: false,
      events: [{ seq: 4, event: { type: 'message', sessionId: 's1', message: message(4) } }],
    };
    manager.transcriptResult = { messages: [message(1)], pendingPermissions: [], pendingQuestions: [] };
    const hub = makeHub(manager);
    const res = new FakeRes();
    hub.openSession('s1', res, { seq: 3, startId: 'poprzedni-proces' });

    expect(res.frames().map((f) => f.event.type)).toEqual(['transcript-snapshot']);
    expect(manager.calls.some((c) => c.method === 'eventsSince')).toBe(false);
  });

  /** Kursor BEZ prefiksu (stary klient, ręczne `?since=`) też jest obcy — patrz wyżej. */
  it('kursor bez prefiksu procesu → transcript-snapshot', () => {
    manager.eventsSinceResult = { tooOld: false, events: [] };
    manager.transcriptResult = { messages: [], pendingPermissions: [], pendingQuestions: [] };
    const hub = makeHub(manager);
    const res = new FakeRes();
    hub.openSession('s1', res, { seq: 3, startId: null });

    expect(res.frames().map((f) => f.event.type)).toEqual(['transcript-snapshot']);
  });

  it('kursor za stary → transcript-snapshot zamiast replayu', () => {
    manager.eventsSinceResult = { tooOld: true, events: [] };
    manager.transcriptResult = {
      messages: [message(90)],
      pendingPermissions: [{
        permId: 'p1', sessionId: 's1', toolName: 'Bash', displayText: 'npm test',
        risk: 'normal', cwd: '/tmp/x', createdAt: '2026-08-21T10:00:00.000Z',
      }],
      pendingQuestions: [],
    };
    const hub = makeHub(manager);
    const res = new FakeRes();
    hub.openSession('s1', res, { seq: 1, startId: 'start-1' });

    const frames = res.frames();
    expect(frames).toHaveLength(1);
    const ev = frames[0]?.event;
    expect(ev?.type).toBe('transcript-snapshot');
    expect(ev?.type === 'transcript-snapshot' && ev.pendingPermissions).toHaveLength(1);
  });

  it('delty lecą live BEZ id, wiadomości z id', () => {
    const hub = makeHub(manager);
    const res = new FakeRes();
    hub.openSession('s1', res, null);
    const before = res.frames().length;

    manager.emit('s1', null, { type: 'delta', sessionId: 's1', text: 'a' });
    manager.emit('s1', 6, { type: 'message', sessionId: 's1', message: message(6) });

    const frames = res.frames().slice(before);
    expect(frames.map((f) => [f.event.type, f.id])).toEqual([['delta', null], ['message', 6]]);
  });

  it('event innej sesji nie trafia do tego strumienia', () => {
    const hub = makeHub(manager);
    const res = new FakeRes();
    hub.openSession('s1', res, null);
    const before = res.frames().length;

    manager.emit('s2', null, { type: 'delta', sessionId: 's2', text: 'a' });
    expect(res.frames().slice(before)).toHaveLength(0);
  });
});

/*
 * A frame-by-frame replay reaches the phone in batches and each batch renders separately, so entering
 * a session after a break would "scroll down" in several jumps. From two missed messages on, the server
 * sends one `transcript-snapshot` frame, the same as on a cold start.
 */
describe('powtórka z kilkoma wiadomościami → snapshot', () => {
  let manager: FakeManager;
  let lines: string[];

  beforeEach(() => {
    manager = new FakeManager([makeSummary({ id: 's1' })]);
    lines = [];
  });

  function loggingHub(): SseHub {
    const hub = new SseHub({
      manager, serverStartId: 'start-1', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0,
      logger: (line) => { lines.push(line); },
    });
    hub.start();
    return hub;
  }

  const msgEvent = (seq: number): { seq: number; event: ServerEvent } => (
    { seq, event: { type: 'message', sessionId: 's1', message: message(seq) } }
  );
  const changed = (seq: number): { seq: number; event: ServerEvent } => (
    { seq, event: { type: 'session-changed', session: makeSummary({ id: 's1' }) } }
  );

  it('próg to nazwana stała równa 2', () => {
    expect(REPLAY_SNAPSHOT_MIN_MESSAGES).toBe(2);
  });

  it('2 wiadomości w powtórce → dokładnie jedna ramka transcript-snapshot bez id, zero ramek z powtórki', () => {
    manager.eventsSinceResult = {
      tooOld: false,
      events: [msgEvent(4), changed(5), msgEvent(6), changed(7)],
    };
    manager.transcriptResult = {
      messages: [message(1), message(2), message(3), message(4), message(6)],
      pendingPermissions: [{
        permId: 'p1', sessionId: 's1', toolName: 'Bash', displayText: 'npm test',
        risk: 'normal', cwd: '/tmp/x', createdAt: '2026-08-21T10:00:00.000Z',
      }],
      pendingQuestions: [],
      activity: { kind: 'thinking' },
    };
    const hub = loggingHub();
    const res = new FakeRes();
    hub.openSession('s1', res, { seq: 3, startId: 'start-1' });

    const frames = res.frames();
    expect(frames).toHaveLength(1);
    const only = frames[0];
    expect(only?.id).toBeNull();
    expect(only?.event.type).toBe('transcript-snapshot');
    if (only?.event.type !== 'transcript-snapshot') throw new Error('brak snapshotu');
    // Snapshot niesie to, co niosłaby powtórka dla transkryptu: wiadomości, karty i aktywność.
    expect(only.event.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4, 6]);
    expect(only.event.pendingPermissions.map((p) => p.permId)).toEqual(['p1']);
    expect(only.event.activity).toEqual({ kind: 'thinking' });
    expect(frames.some((f) => f.event.type === 'message' || f.event.type === 'session-changed')).toBe(false);
    expect(manager.calls.filter((c) => c.method === 'eventsSince')[0]?.args).toEqual(['s1', 3]);
  });

  it('linia logu przy zamianie: liczba wiadomości i waga, bez treści', () => {
    manager.eventsSinceResult = { tooOld: false, events: [msgEvent(4), msgEvent(5), msgEvent(6)] };
    manager.transcriptResult = {
      messages: [message(4), message(5), message(6)], pendingPermissions: [], pendingQuestions: [],
    };
    const hub = loggingHub();
    const res = new FakeRes();
    hub.openSession('s1', res, { seq: 3, startId: 'start-1' });

    expect(lines).toHaveLength(1);
    const bytes = Buffer.byteLength(res.chunks.at(-1) ?? '', 'utf8');
    expect(lines[0]).toBe(`${REPLAY_SNAPSHOT_LOG} 3 messages → snapshot ${(bytes / 1024).toFixed(1)} kB (session s1)`);
    // Treść wiadomości (`m4`…) nie trafia do `server.log`.
    expect(lines[0]).not.toMatch(/\bm[456]\b/);
  });

  it('0 wiadomości (same zmiany stanu) → powtórka jak dziś, z id, bez snapshotu i bez logu', () => {
    manager.eventsSinceResult = { tooOld: false, events: [changed(4), changed(5)] };
    const hub = loggingHub();
    const res = new FakeRes();
    hub.openSession('s1', res, { seq: 3, startId: 'start-1' });

    expect(res.frames().map((f) => [f.event.type, f.id])).toEqual([['session-changed', 4], ['session-changed', 5]]);
    expect(manager.calls.some((c) => c.method === 'transcript')).toBe(false);
    expect(lines).toEqual([]);
  });

  it('1 wiadomość → powtórka jak dziś, z id, bez snapshotu i bez logu', () => {
    manager.eventsSinceResult = { tooOld: false, events: [changed(4), msgEvent(5), changed(6)] };
    const hub = loggingHub();
    const res = new FakeRes();
    hub.openSession('s1', res, { seq: 3, startId: 'start-1' });

    expect(res.frames().map((f) => [f.event.type, f.id]))
      .toEqual([['session-changed', 4], ['message', 5], ['session-changed', 6]]);
    expect(manager.calls.some((c) => c.method === 'transcript')).toBe(false);
    expect(lines).toEqual([]);
  });

  it('pusta powtórka (kursor na bieżąco) → nic poza nagłówkiem, bez logu', () => {
    manager.eventsSinceResult = { tooOld: false, events: [] };
    const hub = loggingHub();
    const res = new FakeRes();
    hub.openSession('s1', res, { seq: 3, startId: 'start-1' });

    expect(res.frames()).toEqual([]);
    expect(lines).toEqual([]);
  });

  it('kursor z innego procesu i tooOld → snapshot jak dziś, bez linii logu zamiany', () => {
    manager.eventsSinceResult = { tooOld: false, events: [msgEvent(4), msgEvent(5)] };
    manager.transcriptResult = { messages: [message(1)], pendingPermissions: [], pendingQuestions: [] };
    const hub = loggingHub();
    const obcy = new FakeRes();
    hub.openSession('s1', obcy, { seq: 3, startId: 'poprzedni-proces' });
    expect(obcy.frames().map((f) => f.event.type)).toEqual(['transcript-snapshot']);

    manager.eventsSinceResult = { tooOld: true, events: [] };
    const stary = new FakeRes();
    hub.openSession('s1', stary, { seq: 1, startId: 'start-1' });
    expect(stary.frames().map((f) => f.event.type)).toEqual(['transcript-snapshot']);

    expect(lines).toEqual([]);
  });

  it('ramka na żywo po snapshocie dochodzi z id i przesuwa kursor jak dziś', () => {
    manager.eventsSinceResult = { tooOld: false, events: [msgEvent(4), msgEvent(5)] };
    manager.transcriptResult = {
      messages: [message(4), message(5)], pendingPermissions: [], pendingQuestions: [],
    };
    const hub = loggingHub();
    const res = new FakeRes();
    hub.openSession('s1', res, { seq: 3, startId: 'start-1' });

    manager.emit('s1', 6, { type: 'message', sessionId: 's1', message: message(6) });
    manager.emit('s1', null, { type: 'delta', sessionId: 's1', text: 'a' });

    expect(res.frames().map((f) => [f.event.type, f.id]))
      .toEqual([['transcript-snapshot', null], ['message', 6], ['delta', null]]);
    // Pełny kursor z prefiksem procesu — apka odeśle go dosłownie przy następnym wejściu.
    expect(res.chunks.join('')).toContain('id: start-1:6\n');
  });
});

/*
 * Manager woła `broadcast` DWA razy na każde zdarzenie sesji (`#emitBoth`: zakres sesji + zakres
 * globalny), a otwarty bywa najwyżej jeden z nich — druga ramka powstawała po to, żeby ją
 * wyrzucić. Licznik jest getterem na polu eventu: `JSON.stringify` musi je odczytać, więc zero
 * odczytów znaczy „nikt nawet nie zaczął serializować".
 */
describe('serializacja ramki jest LENIWA', () => {
  const spyEvent = (counter: { n: number }): ServerEvent => ({
    type: 'delta',
    sessionId: 's1',
    get text(): string {
      counter.n += 1;
      return 'x';
    },
  } as unknown as ServerEvent);

  it('zakres bez klientów nie składa ramki w ogóle', () => {
    const manager = new FakeManager([makeSummary({ id: 's1' })]);
    const hub = makeHub(manager);
    hub.openGlobal(new FakeRes());
    const counter = { n: 0 };

    manager.emit('s1', 7, spyEvent(counter));

    expect(counter.n).toBe(0);
  });

  it('zakres z klientami składa ramkę RAZ, niezależnie od liczby odbiorców', () => {
    const manager = new FakeManager([makeSummary({ id: 's1' })]);
    const hub = makeHub(manager);
    const a = new FakeRes();
    const b = new FakeRes();
    hub.openSession('s1', a, null);
    hub.openSession('s1', b, null);
    const counter = { n: 0 };

    manager.emit('s1', 7, spyEvent(counter));

    expect(counter.n).toBe(1);
    expect(a.frames().at(-1)?.event.type).toBe('delta');
    expect(b.frames().at(-1)?.event.type).toBe('delta');
  });
});

describe('cykl życia klientów', () => {
  it('zamknięcie połączenia wyrejestrowuje klienta', () => {
    const manager = new FakeManager([makeSummary({ id: 's1' })]);
    const hub = makeHub(manager);
    const res = new FakeRes();
    hub.openGlobal(res);
    expect(hub.clientCount).toBe(1);

    res.fireClose();
    expect(hub.clientCount).toBe(0);

    manager.emit('global', null, { type: 'herdr-status', available: true, agentCount: 1, readOnly: false });
    expect(res.frames().some((f) => f.event.type === 'herdr-status')).toBe(false);
  });

  it('closeAll kończy wszystkie strumienie', () => {
    const manager = new FakeManager([makeSummary({ id: 's1' })]);
    const hub = makeHub(manager);
    const a = new FakeRes();
    const b = new FakeRes();
    hub.openGlobal(a);
    hub.openSession('s1', b, null);

    hub.closeAll();
    expect(a.ended).toBe(true);
    expect(b.ended).toBe(true);
    expect(hub.clientCount).toBe(0);
  });

  it('heartbeat wysyła komentarz co zadany odstęp (timery wstrzykiwane)', () => {
    const manager = new FakeManager([makeSummary({ id: 's1' })]);
    let tick: (() => void) | null = null;
    let requestedMs = 0;
    const hub = new SseHub({
      manager,
      serverStartId: 'start-1',
      protocolVersion: PROTOCOL_VERSION,
      heartbeatMs: 25_000,
      setInterval: (cb, ms) => { tick = cb; requestedMs = ms; return 1; },
      clearInterval: () => { tick = null; },
    });
    hub.start();
    const res = new FakeRes();
    hub.openGlobal(res);

    expect(requestedMs).toBe(25_000);
    expect(tick).not.toBeNull();
    (tick as unknown as () => void)();
    // Komentarz (dla proxy) + nazwane zdarzenie `ping` (dla watchdoga ciszy w kliencie —
    // komentarzy SSE przeglądarka nie pokazuje JS-owi wcale).
    const beat = res.chunks.find((c) => c.startsWith(': ping'));
    expect(beat).toBe(': ping\nevent: ping\ndata: {}\n\n');
  });
});

// ---------------------------------------------------------------------------
// Snapshot z granicą w bajtach i ramka końcowa, która nie ginie
// ---------------------------------------------------------------------------

/** Data URL o zadanej DŁUGOŚCI — musi przejść `IMAGE_DATA_URL_PATTERN` (base64 z protokołu). */
function imageOf(bytes: number): string {
  const head = 'data:image/png;base64,';
  return head + 'A'.repeat(Math.max(1, bytes - head.length));
}

function userWithImages(seq: number, images: string[]): TranscriptMessage {
  return {
    seq,
    role: 'user',
    blocks: [
      { type: 'text', text: `m${String(seq)}` },
      ...images.map((dataUrl): TranscriptMessage['blocks'][number] => ({ type: 'image', dataUrl })),
    ],
    at: '2026-08-21T10:00:00.000Z',
  };
}

/** Ile bloków `image` niesie wiadomość — podpis echa w PWA liczy dokładnie to. */
function imageCount(message: TranscriptMessage): number {
  return message.blocks.filter((b) => b.type === 'image').length;
}

describe('budżet bajtów w `transcript-snapshot`', () => {
  const big = () => imageOf(1_200_000);

  it('budżet wydaje się od NAJNOWSZEJ wiadomości wstecz', () => {
    const nowy = big();
    const stary = big();
    const out = budgetSnapshotImages([userWithImages(1, [stary]), userWithImages(2, [nowy])]);

    const blockOf = (i: number) => out[i]?.blocks[1];
    expect(blockOf(1)?.type === 'image' ? blockOf(1) : null)
      .toEqual({ type: 'image', dataUrl: nowy });
    expect(blockOf(0)?.type === 'image' ? (blockOf(0) as { dataUrl: string }).dataUrl : null)
      .toBe(SNAPSHOT_IMAGE_PLACEHOLDER);
  });

  it('LICZBA bloków `image` zostaje nietknięta (podpis echa w PWA)', () => {
    /*
     * Podpis echa w kliencie liczy „tekst + LICZBA obrazków". Podmiana obrazka na
     * tekstowe `[obraz]` (jak w imporcie jsonl) rozjechałaby podpis i zostawiła wpis
     * optymistyczny jako „Nie potwierdzono. [Ponów]" — czyli zaproszenie do drugiej wysyłki.
     */
    const source = [userWithImages(1, [big(), big(), big()]), userWithImages(2, [big()])];
    const out = budgetSnapshotImages(source);
    expect(out.map(imageCount)).toEqual([3, 1]);
    expect(out.map((m) => m.blocks.map((b) => b.type)))
      .toEqual(source.map((m) => m.blocks.map((b) => b.type)));
  });

  it('nie tyka wejścia — `manager.transcript()` oddaje ŻYWE tablice sesji', () => {
    const stary = big();
    const source = [userWithImages(1, [stary]), userWithImages(2, [big()])];
    budgetSnapshotImages(source);
    const block = source[0]?.blocks[1];
    expect(block?.type === 'image' ? block.dataUrl : null).toBe(stary);
  });

  it('bez obrazków oddaje TĘ SAMĄ tablicę (zero kosztu w typowej sesji)', () => {
    const source = [message(1), message(2)];
    expect(budgetSnapshotImages(source)).toBe(source);
  });

  it('podmiennik jest legalnym obrazkiem protokołu (klient wkłada go w img[src])', () => {
    expect(SNAPSHOT_IMAGE_PLACEHOLDER).toMatch(IMAGE_DATA_URL_PATTERN);
  });

  it('ramka snapshotu z hubem trzyma się budżetu zamiast rosnąć o megabajty', () => {
    const manager = new FakeManager([makeSummary({ id: 's1' })]);
    manager.transcriptResult = {
      messages: [1, 2, 3, 4, 5].map((seq) => userWithImages(seq, [big(), big(), big()])),
      pendingPermissions: [],
      pendingQuestions: [],
    };
    const hub = makeHub(manager);
    const res = new FakeRes();

    hub.openSession('s1', res, null);

    const bytes = res.chunks.join('').length;
    // Przed naprawą: 15 obrazków × 1,2 MB = 18 MB w JEDNEJ ramce na LTE.
    expect(bytes).toBeLessThan(SNAPSHOT_IMAGE_BUDGET_BYTES * 2);
    const snapshot = res.frames().at(-1)?.event;
    expect(snapshot?.type).toBe('transcript-snapshot');
    if (snapshot?.type !== 'transcript-snapshot') throw new Error('brak snapshotu');
    // Kształt transkryptu bez zmian: 5 wiadomości po 3 obrazki, tylko bajty przycięte.
    expect(snapshot.messages.map(imageCount)).toEqual([3, 3, 3, 3, 3]);
    const najnowsza = snapshot.messages.at(-1);
    const pierwszy = najnowsza?.blocks[1];
    expect(pierwszy?.type === 'image' ? pierwszy.dataUrl.length : 0).toBe(1_200_000);
  });
});

describe('SseHub: number of open streams for the PR status', () => {
  it('reports every connect, disconnect, revoke and close; a second close of the same stream reports nothing', () => {
    const manager = new FakeManager();
    const counts: number[] = [];
    const hub = new SseHub({
      manager, serverStartId: 'start-1', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0,
      onClientCount: (count) => { counts.push(count); },
    });
    hub.start();
    const first = new FakeRes();
    const second = new FakeRes();
    hub.openGlobal(first);
    hub.openGlobal(second, 'device-1');
    expect(counts).toEqual([1, 2]);
    first.fireClose();
    first.fireClose();
    expect(counts).toEqual([1, 2, 1]);
    expect(hub.closeOwner('device-1')).toBe(1);
    expect(counts).toEqual([1, 2, 1, 0]);
    hub.openGlobal(new FakeRes());
    hub.closeAll();
    expect(counts).toEqual([1, 2, 1, 0, 1, 0]);
  });

  it('a throwing listener does not break opening a stream', () => {
    const hub = new SseHub({
      manager: new FakeManager(), serverStartId: 'start-1', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0,
      onClientCount: () => { throw new Error('listener'); },
    });
    hub.start();
    hub.openGlobal(new FakeRes());
    expect(hub.clientCount).toBe(1);
  });
});

/** A gate whose blocked list the test sets; `change` tells the listeners, as the real gate does on each change. */
class FakeFolderGate implements FolderGate {
  readonly enabled: boolean;
  readonly listeners = new Set<(folder: string, state: FolderState) => void>();
  list: FolderBlock[] = [];

  constructor(enabled = true) {
    this.enabled = enabled;
  }

  stateOf(): null { return null; }
  report(): void {}
  check(): Promise<FolderState> { return Promise.resolve('unknown'); }
  blocked(): FolderBlock[] { return this.list.map((block) => ({ ...block })); }
  onChange(listener: (folder: string, state: FolderState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  dispose(): void {}

  change(folder: string, state: FolderState, list: FolderBlock[]): void {
    this.list = list;
    for (const listener of [...this.listeners]) listener(folder, state);
  }
}

const DESKTOP = '/Users/demo/Desktop';
const DESKTOP_WAITING: FolderBlock = {
  name: 'Desktop', path: DESKTOP, state: 'waiting', since: '2026-11-24T08:14:00.000Z',
};
const DOCUMENTS_DENIED: FolderBlock = {
  name: 'Documents', path: '/Users/demo/Documents', state: 'denied', since: '2026-11-24T08:15:00.000Z',
};

describe('folder-access: blocked macOS folders on the global stream', () => {
  const types = (res: FakeRes): string[] => res.frames().map((frame) => frame.event.type);
  const folderFrames = (res: FakeRes) => res.frames().filter((frame) => frame.event.type === 'folder-access');

  function gateHub(gate: FolderGate | undefined, extra: { inbox?: SseInbox } = {}): SseHub {
    const hub = new SseHub({
      manager: new FakeManager([makeSummary({ id: 's1' })]), serverStartId: 'start-1',
      protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0, ...(gate === undefined ? {} : { folderGate: gate }), ...extra,
    });
    hub.start();
    return hub;
  }

  it('with the gate on, a global stream opens with hello, sessions-snapshot, folder-access, then inbox-heads', () => {
    const gate = new FakeFolderGate();
    const hub = gateHub(gate, { inbox: { heads: () => [], onEvent: () => () => undefined } });
    const res = new FakeRes();
    hub.openGlobal(res, undefined, undefined, true);
    expect(types(res)).toEqual(['hello', 'sessions-snapshot', 'folder-access', 'inbox-heads']);
    // Nothing blocked is an answer too: it clears a banner the app kept from before the reconnect.
    expect(res.frames()[2]).toEqual({ id: null, event: { type: 'folder-access', blocked: [] } });

    gate.list = [DESKTOP_WAITING, DOCUMENTS_DENIED];
    const later = new FakeRes();
    hub.openGlobal(later);
    expect(types(later)).toEqual(['hello', 'sessions-snapshot', 'folder-access']);
    expect(later.frames()[2]?.event).toEqual({ type: 'folder-access', blocked: [DESKTOP_WAITING, DOCUMENTS_DENIED] });
  });

  it('a change of the blocked list goes to every global stream without `id:`; a session stream gets none', () => {
    const gate = new FakeFolderGate();
    const hub = gateHub(gate);
    const first = new FakeRes();
    const second = new FakeRes();
    const session = new FakeRes();
    hub.openGlobal(first);
    hub.openGlobal(second, 'device-1');
    hub.openSession('s1', session, null);
    const sessionBefore = session.frames().length;

    gate.change(DESKTOP, 'waiting', [DESKTOP_WAITING]);

    for (const res of [first, second]) {
      expect(folderFrames(res).slice(1)).toEqual([
        { id: null, event: { type: 'folder-access', blocked: [DESKTOP_WAITING] } },
      ]);
      expect(res.chunks.join('').split('\n\n').filter((raw) => raw.includes('"folder-access"')).at(-1))
        .not.toMatch(/^id:/m);
    }
    expect(session.frames().length).toBe(sessionBefore);
  });

  it('a state change that leaves the blocked list as it was sends nothing', () => {
    const gate = new FakeFolderGate();
    const hub = gateHub(gate);
    const res = new FakeRes();
    hub.openGlobal(res);
    const sent = (): number => folderFrames(res).length - 1;

    // unknown → open: the gate tells about it, the list stays empty.
    gate.change(DESKTOP, 'open', []);
    expect(sent()).toBe(0);
    gate.change(DESKTOP, 'waiting', [DESKTOP_WAITING]);
    expect(sent()).toBe(1);
    // A missing folder is closed, but it is not in the list, so the list is the same.
    gate.change('/Users/demo/Downloads', 'absent', [DESKTOP_WAITING]);
    expect(sent()).toBe(1);
    gate.change(DESKTOP, 'open', []);
    expect(sent()).toBe(2);
    expect(folderFrames(res).at(-1)?.event).toEqual({ type: 'folder-access', blocked: [] });
  });

  it('the list a change sends is compared with the last one sent, also while no stream is open', () => {
    const gate = new FakeFolderGate();
    const hub = gateHub(gate);
    gate.change(DESKTOP, 'waiting', [DESKTOP_WAITING]);
    const res = new FakeRes();
    hub.openGlobal(res);
    gate.change(DESKTOP, 'waiting', [DESKTOP_WAITING]);
    expect(folderFrames(res)).toHaveLength(1);
  });

  it('with the gate off a stream gets no folder-access frame and the hub does not listen to the gate', () => {
    const gate = new FakeFolderGate(false);
    const hub = gateHub(gate);
    const res = new FakeRes();
    hub.openGlobal(res);
    expect(types(res)).toEqual(['hello', 'sessions-snapshot']);
    expect(gate.listeners.size).toBe(0);

    // No option: the gate of a process that installed none is the disabled one.
    const plain = new FakeRes();
    gateHub(undefined).openGlobal(plain);
    expect(types(plain)).toEqual(['hello', 'sessions-snapshot']);
  });

  it('without the option the hub reads the gate the process installed when it starts', () => {
    const gate = new FakeFolderGate();
    gate.list = [DOCUMENTS_DENIED];
    const remove = installFolderGate(gate);
    try {
      const hub = gateHub(undefined);
      const res = new FakeRes();
      hub.openGlobal(res);
      expect(res.frames()[2]?.event).toEqual({ type: 'folder-access', blocked: [DOCUMENTS_DENIED] });
      gate.change(DESKTOP, 'waiting', [DESKTOP_WAITING, DOCUMENTS_DENIED]);
      expect(folderFrames(res)).toHaveLength(2);
    } finally {
      remove();
    }
  });
});

// ---------------------------------------------------------------------------
// Write buffer ceiling: a stalled client does not grow server memory
// ---------------------------------------------------------------------------

/** Response whose socket never drains: every byte written stays counted in `writableLength`. */
class StalledRes extends FakeRes {
  destroyed = false;

  override write(chunk: string): boolean {
    super.write(chunk);
    this.writableLength += Buffer.byteLength(chunk, 'utf8');
    return false;
  }

  destroy(): unknown {
    this.destroyed = true;
    return this;
  }
}

/** A `session-changed` frame of roughly `bytes` bytes; the title is a marker the log line must not carry. */
function bulkyChange(bytes: number): ServerEvent {
  return { type: 'session-changed', session: makeSummary({ id: 's1', title: `SECRET-TITLE-${'x'.repeat(bytes)}` }) };
}

describe('write buffer ceiling', () => {
  it('is twice the transcript ring limit plus the snapshot image budget', () => {
    expect(SSE_WRITE_BUFFER_MAX).toBe(2 * (RING_MAX_BYTES + SNAPSHOT_IMAGE_BUDGET_BYTES));
  });

  it('a stream that never drains is cut on the first write over the ceiling plus twice its largest frame, with one'
    + ' log line', () => {
    const manager = new FakeManager([makeSummary({ id: 's1' })]);
    const lines: string[] = [];
    const hub = new SseHub({
      manager, serverStartId: 'start-1', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0,
      logger: (line) => { lines.push(line); },
    });
    hub.start();
    const res = new StalledRes();
    hub.openGlobal(res, 'device-1');
    let before = 0;
    for (let i = 0; i < 40 && !res.destroyed; i += 1) {
      before = res.writableLength;
      manager.emit('global', null, bulkyChange(1024 * 1024));
    }
    expect(res.destroyed).toBe(true);
    const largest = Math.max(...res.chunks.map((chunk) => Buffer.byteLength(chunk, 'utf8')));
    expect(before).toBeLessThanOrEqual(SSE_WRITE_BUFFER_MAX + 2 * largest);
    expect(res.writableLength).toBeGreaterThan(SSE_WRITE_BUFFER_MAX + 2 * largest);
    expect(hub.clientCount).toBe(0);
    const cut = lines.filter((line) => line.startsWith(WRITE_BUFFER_CUT_LOG));
    expect(cut).toHaveLength(1);
    expect(cut[0]).toContain('device-1');
    expect(lines.join('\n')).not.toContain('SECRET-TITLE');

    // Nothing more reaches the cut stream: neither live frames nor the heartbeat.
    const written = res.chunks.length;
    manager.emit('global', null, bulkyChange(16));
    hub.sendHeartbeat();
    expect(res.chunks).toHaveLength(written);
    expect(lines.filter((line) => line.startsWith(WRITE_BUFFER_CUT_LOG))).toHaveLength(1);
  });

  it('a stream opened over a stalled socket stops writing as soon as it is cut', () => {
    const manager = new FakeManager([makeSummary({ id: 's1' })]);
    const lines: string[] = [];
    const hub = new SseHub({
      manager, serverStartId: 'start-1', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0,
      logger: (line) => { lines.push(line); },
    });
    hub.start();
    const res = new StalledRes();
    // The socket is already full when the stream opens: `retry:` crosses the ceiling, nothing after it is written.
    res.writableLength = SSE_WRITE_BUFFER_MAX + 1024 * 1024;
    hub.openGlobal(res);
    expect(res.destroyed).toBe(true);
    expect(hub.clientCount).toBe(0);
    expect(res.chunks.some((chunk) => chunk.includes('"hello"'))).toBe(false);
    expect(res.chunks.some((chunk) => chunk.includes('sessions-snapshot'))).toBe(false);
    expect(lines.filter((line) => line.startsWith(WRITE_BUFFER_CUT_LOG))).toHaveLength(1);
  });

  it('a maximum-size snapshot to a slowly draining client, then a heartbeat, is not cut', () => {
    const manager = new FakeManager([makeSummary({ id: 's1' })]);
    manager.transcriptResult = {
      messages: [
        { ...message(1), blocks: [{ type: 'text', text: 'a'.repeat(RING_MAX_BYTES) }] },
        userWithImages(2, [imageOf(SNAPSHOT_IMAGE_BUDGET_BYTES)]),
      ],
      pendingPermissions: [], pendingQuestions: [],
    };
    const lines: string[] = [];
    const hub = new SseHub({
      manager, serverStartId: 'start-1', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0,
      logger: (line) => { lines.push(line); },
    });
    hub.start();
    const res = new StalledRes();
    hub.openSession('s1', res, null);
    expect(res.writableLength).toBeGreaterThan(RING_MAX_BYTES + SNAPSHOT_IMAGE_BUDGET_BYTES);
    // The client drains a little, then the heartbeat comes.
    res.writableLength = Math.floor(res.writableLength * 0.9);
    hub.sendHeartbeat();
    expect(res.destroyed).toBe(false);
    expect(hub.clientCount).toBe(1);
    expect(res.chunks.at(-1)).toBe(': ping\nevent: ping\ndata: {}\n\n');
    expect(lines.filter((line) => line.startsWith(WRITE_BUFFER_CUT_LOG))).toHaveLength(0);
  });

  it('one valid snapshot larger than the ceiling is not cut, a heartbeat after it neither; a stall after it is', () => {
    const manager = new FakeManager([makeSummary({ id: 's1' })]);
    // Many large pending consent cards can make a valid snapshot bigger than the ceiling on their own.
    manager.transcriptResult = {
      messages: [{ ...message(1), blocks: [{ type: 'text', text: 'a'.repeat(SSE_WRITE_BUFFER_MAX + 1024 * 1024) }] }],
      pendingPermissions: [], pendingQuestions: [],
    };
    const lines: string[] = [];
    const hub = new SseHub({
      manager, serverStartId: 'start-1', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0,
      logger: (line) => { lines.push(line); },
    });
    hub.start();
    const res = new StalledRes();
    hub.openSession('s1', res, null);
    hub.sendHeartbeat();
    expect(res.writableLength).toBeGreaterThan(SSE_WRITE_BUFFER_MAX);
    expect(res.destroyed).toBe(false);
    expect(lines.filter((line) => line.startsWith(WRITE_BUFFER_CUT_LOG))).toHaveLength(0);

    for (let i = 0; i < 60 && !res.destroyed; i += 1) manager.emit('s1', null, bulkyChange(1024 * 1024));
    expect(res.destroyed).toBe(true);
    expect(lines.filter((line) => line.startsWith(WRITE_BUFFER_CUT_LOG))).toHaveLength(1);
  });

  it('reconnecting after a cut gets a snapshot', () => {
    const manager = new FakeManager([makeSummary({ id: 's1' })]);
    manager.transcriptResult = { messages: [message(1)], pendingPermissions: [], pendingQuestions: [] };
    const hub = makeHub(manager);
    const stalled = new StalledRes();
    hub.openSession('s1', stalled, null);
    for (let i = 0; i < 60 && !stalled.destroyed; i += 1) manager.emit('s1', null, bulkyChange(1024 * 1024));
    expect(stalled.destroyed).toBe(true);

    const session = new FakeRes();
    const global = new FakeRes();
    hub.openSession('s1', session, null);
    hub.openGlobal(global);
    expect(session.frames().map((f) => f.event.type)).toEqual(['transcript-snapshot']);
    expect(global.frames().map((f) => f.event.type)).toEqual(['hello', 'sessions-snapshot']);
    expect(hub.clientCount).toBe(2);
  });
});

describe('closeAll detaches what start attached', () => {
  function fakeInbox(): SseInbox & { listeners: number } {
    const inbox = {
      listeners: 0,
      heads: () => [],
      onEvent: () => {
        inbox.listeners += 1;
        return () => { inbox.listeners -= 1; };
      },
    };
    return inbox;
  }

  it('the Inbox listener is detached', () => {
    const inbox = fakeInbox();
    const hub = new SseHub({
      manager: new FakeManager(), serverStartId: 'start-1', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0, inbox,
    });
    hub.start();
    expect(inbox.listeners).toBe(1);
    hub.closeAll();
    expect(inbox.listeners).toBe(0);
  });

  it('start after closeAll delivers each manager event once', () => {
    const manager = new FakeManager([makeSummary({ id: 's1' })]);
    const inbox = fakeInbox();
    const hub = new SseHub({
      manager, serverStartId: 'start-1', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0, inbox,
    });
    hub.start();
    hub.closeAll();
    hub.start();
    expect(inbox.listeners).toBe(1);
    const res = new FakeRes();
    hub.openGlobal(res);
    manager.emit('global', null, { type: 'herdr-status', available: true, agentCount: 1, readOnly: false });
    expect(res.frames().filter((f) => f.event.type === 'herdr-status')).toHaveLength(1);
  });
});
