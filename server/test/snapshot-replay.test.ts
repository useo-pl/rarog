/**
 * PRAWDZIWY manager (demo, mock-driver): snapshot zamiast powtórki niesie te same `seq`,
 * które apka dostała wcześniej w ramkach `message` tej sesji.
 *
 * Apka buduje identyfikatory wierszy z `seq` (`m<seq>.<blok>`, `RarogUI/Model/TranscriptReading.swift`),
 * a reduktor podmienia listę snapshotem i dalej robi upsert po `seq`. Inne `seq` w snapshocie przebudowałoby
 * każdy wiersz i zgubiło miejsce czytania — dlatego to sprawdzamy na kodzie managera, nie na atrapie.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerEvent, TranscriptMessage } from '@rarog/shared';
import { PROTOCOL_VERSION, parseServerEvent } from '@rarog/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createManager } from '../src/sessions/manager.ts';
import { REPLAY_SNAPSHOT_LOG, SseHub, type SseResponse } from '../src/sse.ts';
import { demoContentPl } from '../src/demo/content/pl.ts';

const START = 'd111-start';
const SESSION = 'demo-willow';

/** Odbiornik ramek: zbiera zapisy i rozbija je na `{ id, event }` (id bez prefiksu procesu). */
class Sink implements SseResponse {
  chunks: string[] = [];
  writeHead(): unknown { return this; }
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  end(): unknown { return this; }
  on(): unknown { return this; }

  frames(): { id: number | null; event: ServerEvent }[] {
    return this.chunks.join('').split('\n\n').filter((raw) => raw.includes('data: ')).map((raw) => {
      const id = /^id: (?:[^\n:]*:)?(\d+)$/m.exec(raw);
      const event = parseServerEvent(/^data: (.*)$/m.exec(raw)?.[1] ?? '');
      if (event === null) throw new Error(`nieparsowalna ramka: ${raw}`);
      return { id: id === null ? null : Number(id[1]), event };
    });
  }
}

type MessageFrame = { id: number; message: TranscriptMessage };

function messageFrames(sink: Sink): MessageFrame[] {
  return sink.frames().flatMap((f) => (
    f.event.type === 'message' && f.id !== null ? [{ id: f.id, message: f.event.message }] : []
  ));
}

describe('prawdziwy manager: seq w snapshocie = seq z ramek message', () => {
  let dataDir: string;
  let manager: Awaited<ReturnType<typeof createManager>>;
  let hub: SseHub;
  let lines: string[];

  beforeEach(async () => {
    vi.useFakeTimers({ now: Date.parse('2026-10-18T09:00:00.000Z') });
    dataDir = await mkdtemp(join(tmpdir(), 'rarog-d111-'));
    manager = await createManager({ demo: true, demoContent: demoContentPl, dataDir });
    lines = [];
    hub = new SseHub({
      manager, serverStartId: START, protocolVersion: PROTOCOL_VERSION, heartbeatMs: 0,
      logger: (line) => { lines.push(line); },
    });
    await manager.ready;
    hub.start();
  });

  afterEach(async () => {
    hub.closeAll();
    await manager.dispose();
    vi.useRealTimers();
    await rm(dataDir, { force: true, recursive: true });
  });

  let live: Sink;

  /** Tura demo na żywo: zgoda, odpowiedź agenta, potem wiadomość z Raroga i jej tura. */
  async function liveTurn(): Promise<MessageFrame[]> {
    live = new Sink();
    hub.openSession(SESSION, live, null);
    await vi.advanceTimersByTimeAsync(0);
    await manager.resolvePermission(SESSION, 'demo-perm-willow', 'allow', 'iPhone');
    await vi.advanceTimersByTimeAsync(10_000);
    await manager.sendMessage(SESSION, 'Druga tura do testu seq.');
    await vi.advanceTimersByTimeAsync(10_000);
    const frames = messageFrames(live);
    // Ramka `message` niesie `id:` równe `message.seq` — to jest numer, którym apka adresuje wiersz.
    for (const frame of frames) expect(frame.message.seq).toBe(frame.id);
    return frames;
  }

  it('powtórka z ≥ 2 wiadomościami → snapshot z tymi samymi seq i tą samą treścią', async () => {
    const messages = await liveTurn();
    expect(messages.length).toBeGreaterThanOrEqual(2);
    const first = messages[0];
    if (first === undefined) throw new Error('brak wiadomości na żywo');

    // Powrót z kursorem sprzed pierwszej wiadomości tury: powtórka miałaby wszystkie `messages`.
    const back = new Sink();
    hub.openSession(SESSION, back, { seq: first.id - 1, startId: START });
    await vi.advanceTimersByTimeAsync(0);

    const frames = back.frames();
    expect(frames[0]?.event.type).toBe('transcript-snapshot');
    expect(frames[0]?.id).toBeNull();
    expect(frames.some((f) => f.event.type === 'message')).toBe(false);
    const snapshot = frames[0]?.event;
    if (snapshot?.type !== 'transcript-snapshot') throw new Error('brak snapshotu');
    const bySeq = new Map(snapshot.messages.map((m) => [m.seq, m]));
    for (const frame of messages) expect(bySeq.get(frame.id)).toEqual(frame.message);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(
      `^${REPLAY_SNAPSHOT_LOG} ${String(messages.length)} messages → snapshot \\d+\\.\\d kB \\(session ${SESSION}\\)$`,
    ));
  });

  /*
   * Snapshot zastępuje też `git-status`, który stał w powtórce. Poza demo dosyła go odczyt
   * gita przy `transcript()`; w demo gita nie ma (`#git === null`), więc manager ponawia ostatnią ramkę.
   */
  it('za snapshotem dochodzi ostatni git-status z powtórki, z id:', async () => {
    const messages = await liveTurn();
    const first = messages[0];
    const lastGit = live.frames().filter((f) => f.event.type === 'git-status').at(-1);
    if (first === undefined || lastGit === undefined) throw new Error('tura demo bez wiadomości albo bez gita');

    const back = new Sink();
    hub.openSession(SESSION, back, { seq: first.id - 1, startId: START });
    await vi.advanceTimersByTimeAsync(0);

    const frames = back.frames();
    expect(frames.map((f) => f.event.type)).toEqual(['transcript-snapshot', 'git-status']);
    expect(frames[1]?.event).toEqual(lastGit.event);
    expect(frames[1]?.id).toBeGreaterThan(lastGit.id ?? 0);
  });

  it('powtórka z 1 wiadomością → ramka message z tym samym seq, które niesie snapshot', async () => {
    const messages = await liveTurn();
    const last = messages.at(-1);
    if (last === undefined) throw new Error('brak wiadomości na żywo');

    const back = new Sink();
    hub.openSession(SESSION, back, { seq: last.id - 1, startId: START });
    const replayed = messageFrames(back);
    expect(replayed).toEqual([last]);
    expect(back.frames().some((f) => f.event.type === 'transcript-snapshot')).toBe(false);

    const cold = new Sink();
    hub.openSession(SESSION, cold, null);
    const snapshot = cold.frames()[0]?.event;
    if (snapshot?.type !== 'transcript-snapshot') throw new Error('brak snapshotu');
    expect(snapshot.messages.find((m) => m.seq === last.id)).toEqual(last.message);
    expect(lines).toEqual([]);
  });
});
