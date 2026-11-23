/**
 * Chaos-proxy — test odporności resyncu SSE (m1-plan krok 4, kryterium DoD nr 2).
 *
 * Układ:
 *   klient SSE  ──►  proxy TCP (zrywa KAŻDE połączenie co `CHAOS_MS`)  ──►  realny router + SseHub
 *
 * Wyrocznia (dosłownie z m1-plan): po N zerwaniach transkrypt u klienta to DOKŁADNA, CIĄGŁA
 * sekwencja `seq` domkniętych wiadomości — zero luk, zero duplikatów. Delty wolno gubić
 * (są ulotne, nie mają `id`, nie przesuwają kursora) i test tego nie sprawdza.
 *
 * Dlaczego to działa: kursor klienta przesuwa się WYŁĄCZNIE na kompletnej ramce SSE
 * (`\n\n`). Ramka ucięta w połowie przez zerwanie ląduje w porzuconym buforze, więc
 * `Last-Event-ID` wskazuje ostatnią w pełni odebraną wiadomość, a serwer odtwarza
 * wszystko po niej z ring buffera. To jedyny mechanizm, który tu testujemy end-to-end.
 *
 * Zamiast realnego managera stoi tu atrapa oparta na PRAWDZIWYM `RingBuffer` — bo to
 * właśnie ring buffer + `eventsSince` są maszynerią resyncu. Mock-driver wnosiłby tylko
 * niedeterminizm.
 */
import { FALLBACK_MODEL_CHOICES, MODEL_CHANGE_WARNING, PROTOCOL_VERSION } from '@rarog/shared';
import type {
  CommandList, DiffFileList, DiffFilePatch,
  ModelList, PermissionRequest, QuestionRequest, ServerEvent, SessionDiff, SessionModelResponse,
  SessionSummary, TranscriptMessage,
} from '@rarog/shared';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { type Logger, createRouter } from '../src/router.ts';
import type { ManagerApi } from '../src/sessions/manager-api.ts';
import type { ResolveResult } from '../src/permissions.ts';
import { RingBuffer } from '../src/sessions/ring-buffer.ts';
import { SseHub } from '../src/sse.ts';
import { makeSummary } from './fake-manager.ts';
import { createTestDevice } from './helpers/urzadzenie.ts';

const SESSION_ID = 'sess-chaos';

/** Ile wiadomości musi dojechać do klienta, zanim ogłosimy sukces. */
const TOTAL_MESSAGES = 60;
/** Odstęp między kolejnymi wiadomościami serwera. */
const EMIT_MS = 15;
/** Co ile proxy zrywa połączenie (skala testu, nie produkcji — w planie było „co N s"). */
const CHAOS_MS = 120;
/** Twardy limit całego przebiegu — po nim test pada z diagnostyką zamiast wisieć. */
const RUN_TIMEOUT_MS = 15_000;

const silentLogger: Logger = { info: () => {}, error: () => {} };

/**
 * Atrapa managera emitująca ponumerowane wiadomości do ring buffera sesji.
 * `eventsSince` i `transcript` czytają z tego samego bufora, więc replay jest prawdziwy.
 */
class ScriptedManager implements ManagerApi {
  readonly ring = new RingBuffer<ServerEvent>(500);
  readonly messages: TranscriptMessage[] = [];
  private listeners: ((scope: 'global' | string, seq: number | null, ev: ServerEvent) => void)[]
    = [];

  private readonly session: SessionSummary = makeSummary({ id: SESSION_ID });

  /** Emituje jedną domkniętą wiadomość: seq z ring buffera trafia do ramki jako `id:`. */
  emitMessage(n: number): number {
    const message: TranscriptMessage = {
      seq: 0, role: 'assistant', at: new Date().toISOString(),
      // Treść celowo długa: zwiększa szansę, że zerwanie utnie ramkę w połowie —
      // czyli że test naprawdę dotyka ścieżki „porzuć niekompletny bufor".
      blocks: [{ type: 'text', text: `wiadomość ${String(n)} ${'x'.repeat(400)}` }],
    };
    const event: ServerEvent = { type: 'message', sessionId: SESSION_ID, message };
    const seq = this.ring.push(event);
    message.seq = seq;
    this.messages.push(message);
    for (const cb of this.listeners) cb(SESSION_ID, seq, event);
    return seq;
  }

  /** Delta — ulotna, bez `seq`, nie wchodzi do bufora (kontrakt z architektury). */
  emitDelta(text: string): void {
    const event: ServerEvent = { type: 'delta', sessionId: SESSION_ID, text };
    for (const cb of this.listeners) cb(SESSION_ID, null, event);
  }

  list(): SessionSummary[] { return [this.session]; }
  get(id: string): SessionSummary | undefined {
    return id === SESSION_ID ? this.session : undefined;
  }
  async create(): Promise<{ sessionId: string; state: 'starting' }> {
    return { sessionId: this.session.id, state: 'starting' };
  }
  async sendMessage(): Promise<{ replayed: boolean }> { return { replayed: false }; }
  async resolvePermission(): Promise<ResolveResult> { return { outcome: 'gone' }; }
  async answerQuestion(): Promise<ResolveResult> { return { outcome: 'gone' }; }
  async interrupt(): Promise<boolean> { return true; }
  async takeBackQueue(): Promise<{ items: never[] }> { return { items: [] }; }
  async close(): Promise<void> { /* nieużywane */ }
  async resume(): Promise<SessionSummary> { return this.session; }
  async restart(): Promise<{ sessionId: string }> { return { sessionId: this.session.id }; }
  async resumable(): Promise<never[]> { return []; }
  async recentResumable(): Promise<never[]> { return []; }
  async recentProjects(): Promise<never[]> { return []; }
  models(): ModelList { return { models: [...FALLBACK_MODEL_CHOICES] }; }
  commands(): CommandList { return { revision: 'r-chaos', commands: [] }; }
  companionTarget(): null { return null; }
  onConversationChange(): () => void { return () => { /* nieużywane w tym teście */ }; }
  async setModel(): Promise<SessionModelResponse> {
    return { ok: true, warning: MODEL_CHANGE_WARNING.text };
  }

  async setMode(): Promise<{ ok: true }> {
    return { ok: true };
  }

  async focus(): Promise<void> { /* nieużywane w tym teście */ }
  markSeen(): void { /* nieużywane w tym teście */ }
  markUnseen(): void { /* nieużywane w tym teście */ }
  hiddenList(): [] { return []; }
  restoreHidden(): boolean { return false; }
  async diff(): Promise<SessionDiff> { return { files: [], patch: '', truncated: false }; }
  async diffFiles(): Promise<DiffFileList> { return { files: [], truncated: false }; }
  async diffFile(_id: string, path: string): Promise<DiffFilePatch> { return { path, patch: '', truncated: false }; }

  transcript(): {
    messages: TranscriptMessage[];
    pendingPermissions: PermissionRequest[];
    pendingQuestions: QuestionRequest[];
  } {
    return { messages: [...this.messages], pendingPermissions: [], pendingQuestions: [] };
  }

  eventsSince(_id: string, seq: number | null): {
    tooOld: boolean; events: { seq: number | null; event: ServerEvent }[];
  } {
    if (seq === null) return { tooOld: true, events: [] };
    if (this.ring.tooOld(seq)) return { tooOld: true, events: [] };
    return {
      tooOld: false,
      events: this.ring.entriesSince(seq).map((e) => ({ seq: e.seq, event: e.value })),
    };
  }

  onEvent(cb: (scope: 'global' | string, seq: number | null, ev: ServerEvent) => void): void {
    this.listeners.push(cb);
  }

  projects(): { path: string; name: string }[] { return []; }
}

/** Proxy TCP przepuszczające ruch i mordujące każde połączenie po `chaosMs`. */
interface ChaosProxy {
  port: number;
  /** Liczba zerwań — asercja „naprawdę było chaotycznie". */
  readonly drops: () => number;
  close(): Promise<void>;
}

async function startChaosProxy(targetPort: number, chaosMs: number): Promise<ChaosProxy> {
  let drops = 0;
  const open = new Set<net.Socket>();

  const server = net.createServer((client) => {
    const upstream = net.connect(targetPort, '127.0.0.1');
    open.add(client);
    open.add(upstream);

    const kill = (): void => {
      if (client.destroyed && upstream.destroyed) return;
      drops += 1;
      client.destroy();
      upstream.destroy();
    };
    const timer = setTimeout(kill, chaosMs);
    timer.unref();

    const cleanup = (): void => {
      clearTimeout(timer);
      open.delete(client);
      open.delete(upstream);
      client.destroy();
      upstream.destroy();
    };
    client.on('error', cleanup);
    upstream.on('error', cleanup);
    client.on('close', cleanup);
    upstream.on('close', cleanup);
    client.pipe(upstream);
    upstream.pipe(client);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });

  return {
    port: (server.address() as AddressInfo).port,
    drops: () => drops,
    close: async () => {
      for (const s of open) s.destroy();
      open.clear();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    },
  };
}

interface ClientResult {
  /** `seq` domkniętych wiadomości w kolejności odbioru (z duplikatami, jeśli wystąpią). */
  received: number[];
  reconnects: number;
  snapshots: number;
  deltas: number;
}

/**
 * Minimalny klient SSE: parsuje ramki, trzyma `Last-Event-ID`, po zerwaniu łączy się od nowa.
 * Odpowiednik `EventSource` z przeglądarki, ale bez backoffu (test ma być szybki).
 */
function runSseClient(
  port: number, auth: string, until: (r: ClientResult) => boolean,
): Promise<ClientResult> {
  const result: ClientResult = { received: [], reconnects: 0, snapshots: 0, deltas: 0 };
  let cursor: number | null = null;
  let stopped = false;

  return new Promise<ClientResult>((resolve, reject) => {
    const deadline = setTimeout(() => {
      stopped = true;
      reject(new Error(
        `chaos-proxy: klient nie zebrał kompletu w ${String(RUN_TIMEOUT_MS)} ms `
        + `(odebrane=${String(result.received.length)}, reconnecty=${String(result.reconnects)})`,
      ));
    }, RUN_TIMEOUT_MS);
    deadline.unref();

    const finish = (): void => {
      if (stopped) return;
      stopped = true;
      clearTimeout(deadline);
      resolve(result);
    };

    const connect = (): void => {
      if (stopped) return;
      const headers: Record<string, string> = { Authorization: auth, Accept: 'text/event-stream' };
      if (cursor !== null) headers['Last-Event-ID'] = String(cursor);

      // Jedno zerwanie odpala 'end', 'close' I 'error' — bez tej blokady każdy z nich
      // wystartowałby osobne połączenie i klient rozmnożyłby się wykładniczo.
      let retried = false;
      const retry = (): void => {
        if (stopped || retried) return;
        retried = true;
        result.reconnects += 1;
        setImmediate(connect);
      };

      const req = http.request({
        host: '127.0.0.1', port, path: `/api/sessions/${SESSION_ID}/stream`, headers,
      }, (res) => {
        if (res.statusCode !== 200) {
          stopped = true;
          clearTimeout(deadline);
          reject(new Error(`chaos-proxy: strumień odpowiedział ${String(res.statusCode)}`));
          return;
        }
        // Bufor ramek. Zerwanie w połowie ramki = bufor przepada wraz z połączeniem,
        // a kursor zostaje na ostatniej KOMPLETNEJ ramce — o to w tym teście chodzi.
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buf += chunk;
          let idx = buf.indexOf('\n\n');
          while (idx !== -1) {
            handleFrame(buf.slice(0, idx));
            buf = buf.slice(idx + 2);
            idx = buf.indexOf('\n\n');
          }
          if (until(result)) {
            retried = true; // sukces — żadnego kolejnego połączenia już nie chcemy
            req.destroy();
            res.destroy();
            finish();
          }
        });
        res.on('end', retry);
        res.on('error', retry);
        res.on('close', retry);
      });
      req.on('error', retry);
      req.end();
    };

    const handleFrame = (frame: string): void => {
      let id: number | null = null;
      const dataLines: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('id: ')) id = Number(line.slice(4));
        else if (line.startsWith('data: ')) dataLines.push(line.slice(6));
      }
      if (dataLines.length === 0) return; // `retry:` albo komentarz-heartbeat
      let ev: ServerEvent;
      try {
        ev = JSON.parse(dataLines.join('\n')) as ServerEvent;
      } catch {
        throw new Error('chaos-proxy: niekompletny JSON w KOMPLETNEJ ramce SSE');
      }
      if (ev.type === 'transcript-snapshot') {
        result.snapshots += 1;
        // Snapshot jest autorytatywny: zastępuje dotychczasową listę (tak robi klient).
        result.received.length = 0;
        for (const m of ev.messages) result.received.push(m.seq);
        const last = ev.messages.at(-1);
        if (last !== undefined) cursor = last.seq;
        return;
      }
      if (ev.type === 'delta') {
        result.deltas += 1;
        // Delty NIE mają `id` — gdyby miały, kursor przeskoczyłby ponad domkniętą wiadomość.
        expect(id).toBeNull();
        return;
      }
      if (ev.type === 'message') {
        expect(id).not.toBeNull();
        result.received.push(ev.message.seq);
        cursor = id;
      }
    };

    connect();
  });
}

let cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

describe('chaos-proxy: ciągłość seq przy zrywanych połączeniach SSE', () => {
  it('po wielu zerwaniach klient ma pełną, ciągłą sekwencję wiadomości bez duplikatów',
    async () => {
      const config = loadConfig({ RAROG_DEMO: '1' });
      const device = createTestDevice(config.dataDir, { epoch: config.epoch });
      const manager = new ScriptedManager();
      const hub = new SseHub({
        manager, serverStartId: 'chaos-1', protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0,
      });
      hub.start();

      const server = http.createServer(createRouter({
        config, manager, hub, serverStartId: 'chaos-1', startedAtMs: Date.now(),
        logger: silentLogger, devices: device.identity,
      }));
      server.requestTimeout = 0;
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.removeListener('error', reject); resolve();
        });
      });
      cleanup.push(async () => {
        hub.closeAll();
        await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
      });

      const backendPort = (server.address() as AddressInfo).port;
      const proxy = await startChaosProxy(backendPort, CHAOS_MS);
      cleanup.push(() => proxy.close());

      // Producent: wiadomość co EMIT_MS, przeplatana deltą (ma być gubiona bezkarnie).
      let emitted = 0;
      const producer = setInterval(() => {
        if (emitted >= TOTAL_MESSAGES) { clearInterval(producer); return; }
        emitted += 1;
        manager.emitDelta(`fragment ${String(emitted)} `);
        manager.emitMessage(emitted);
      }, EMIT_MS);
      producer.unref();
      cleanup.push(async () => { clearInterval(producer); });

      const result = await runSseClient(
        proxy.port, device.authorization, (r) => r.received.includes(TOTAL_MESSAGES),
      );

      // Chaos musiał się faktycznie wydarzyć — inaczej test niczego nie dowodzi.
      expect(result.reconnects).toBeGreaterThan(2);
      expect(proxy.drops()).toBeGreaterThan(2);

      // WYROCZNIA: dokładnie 1..TOTAL_MESSAGES, w kolejności, bez luk i bez duplikatów.
      const expected = Array.from({ length: TOTAL_MESSAGES }, (_, i) => i + 1);
      expect(result.received).toEqual(expected);
      expect(new Set(result.received).size).toBe(result.received.length);
    });
});
