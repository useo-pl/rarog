/**
 * Echo odroczone: prompt wysłany z Raroga w trakcie pracy agenta staje w transkrypcie
 * dopiero, gdy CLI go weźmie — w miejscu wpisu z pliku rozmowy, z `seq` chwili przetworzenia.
 *
 * Granica: atrapa nadzorcy herdr i driver sterowany z testu (zero gniazda,
 * zero pliku), prawdziwy manager. Driver atrapy mówi, czy umie odroczyć echo (`defersEcho`),
 * zapisuje token wysyłki, a test sam podaje zdarzenia, które w produkcji niesie follower:
 * wpis promptu z `echoToken`, `echo-refused`, `echo-dropped`, `turn-input lost`.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HerdrStatus, TranscriptMessage } from '@rarog/shared';
import { foreign } from '@rarog/shared/sentences';
import type { InternalBlock } from '../src/drivers/types.ts';
import type { DriverEvent, HeldLeftover, HeldLeftoverItem } from '../src/drivers/types.ts';
import type { HerdrAgent } from '../src/herdr/types.ts';
import { HELD_QUEUE_LOG, createManager } from '../src/sessions/manager.ts';
import type { HerdrManagerDeps, Manager } from '../src/sessions/manager.ts';
import { AtrapaDrivera, AtrapaNadzorcy } from './helpers/atrapa-sesji.ts';

const ROOT = '/Users/demo/Projects';
const KEY = 'w1:p1';
const CID = '3f2b8c1e-7a4d-4e9b-9c21-5d6e7f8a9b0c';
const T0 = Date.parse('2026-10-14T10:00:00.000Z');
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==';

class FixtureDriver extends AtrapaDrivera {
  /** Czy driver umie odroczyć echo (w produkcji: plik rozmowy, nie slash, niepusty klucz). */
  defers = true;

  push(...events: DriverEvent[]): void {
    for (const event of events) this.queue.push(event);
  }

  defersEcho(): boolean {
    return this.defers;
  }

  /**
   * Odczyt pola po turze: tu pole jest zawsze PUSTE, więc spłukanie wygląda jak przed odczytem — wyniki
   * tych testów mają się nie zmienić. Pole z tekstem: `prompt-blocked-in-turn.test.ts`.
   */
  checkHeldLeftover(
    items: readonly HeldLeftoverItem[], valid: () => boolean,
  ): Promise<ReadonlyMap<string, HeldLeftover> | null> {
    return Promise.resolve(valid() ? new Map(items.map((item) => [item.token, 'empty'] as const)) : null);
  }

  /** Wysyłki z tokenem echa, jeśli go niosły. */
  get wysylki(): { text: string; echo?: string }[] {
    return this.calls.flatMap((call) => {
      if (call.method !== 'send') return [];
      return [call.opts?.echo !== undefined ? { text: call.text, echo: call.opts.echo } : { text: call.text }];
    });
  }

  /** Token ostatniej wysyłki z echem odroczonym. */
  get lastToken(): string {
    const token = this.wysylki.at(-1)?.echo;
    if (token === undefined) throw new Error('ostatnia wysyłka nie niosła tokenu');
    return token;
  }
}

class FixtureSupervisor extends AtrapaNadzorcy<FixtureDriver> {
  readonly onAttach = new Map<string, DriverEvent[]>();

  override status(): HerdrStatus {
    return { available: true, agentCount: this.drivers.size, readOnly: false, canLaunch: false };
  }

  protected nowyDriver(key: string): FixtureDriver {
    return new FixtureDriver(key, { dziennik: this.log });
  }

  override attach(key: string): FixtureDriver {
    const driver = super.attach(key);
    driver.push(...(this.onAttach.get(key) ?? []));
    return driver;
  }

  appear(agent: HerdrAgent, onAttach: DriverEvent[]): void {
    this.onAttach.set(agent.key, onAttach);
    this.lifecycle.push({ type: 'appeared', agent });
  }
}

function agent(key: string): HerdrAgent {
  return {
    key, paneId: key, tabId: 'w1:t1', agentSessionId: '4b7f0d2e-9c61-4a3b-8e15-2d9f6c0a7b31',
    engine: 'claude', termId: null, cwd: `${ROOT}/atlas`, status: 'idle', title: 'atlas',
    stateChangeSeq: 1, mode: 'auto', modeReadAt: 0, inScope: true, launchedByRarog: true,
    interactiveReady: true,
  };
}

const idOf = (key: string): string => `herdr-${key.replace(/[^a-z0-9]/gi, '-')}`;

async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}

interface Rig {
  manager: Manager;
  id: string;
  driver: FixtureDriver;
  logs: string[];
  close(): Promise<void>;
}

async function rig(dataDir: string, queueEcho = true): Promise<Rig> {
  const logs: string[] = [];
  const supervisor = new FixtureSupervisor();
  const deps: HerdrManagerDeps = {
    sessionIdFor: idOf,
    aliasFor: () => undefined,
    rememberAlias: () => undefined,
    assertSendable: (text) => ({ text: text.trim(), slash: null }),
    takeSendSlot: () => true,
    writeUploads: (cwd, images) => Promise.resolve(
      images.map((_, i) => `${cwd}/.rarog-uploads/1790000000-000000000000000${String(i)}.png`),
    ),
    writeUploadFiles: (cwd, files) => Promise.resolve(
      files.map((file) => `${cwd}/.rarog-uploads/1790000001-a1b2c3d4e5f60718-${file.name}`),
    ),
    sweepUploads: () => Promise.resolve(),
  };
  const manager = await createManager({
    demo: false, dataDir, herdrSupervisor: supervisor, herdrDeps: deps, herdrRoots: [ROOT],
    now: () => T0, gitStatus: null, gitWatcher: null, queueEcho,
    liveSessionsReader: () => Promise.resolve(null),
    logger: (line) => { logs.push(line); },
  });
  await manager.ready;
  supervisor.appear(agent(KEY), [
    { type: 'agent-state', state: 'idle', seen: true, mode: 'auto', stateChangeSeq: 1 },
  ]);
  await flush();
  const driver = supervisor.drivers.get(KEY);
  if (driver === undefined) throw new Error('driver nie został podpięty');
  return {
    manager, id: idOf(KEY), driver, logs,
    close: async () => {
      await manager.dispose();
      supervisor.dispose();
    },
  };
}

let dataDir: string;
const rigs: Rig[] = [];

async function open(queueEcho = true): Promise<Rig> {
  const r = await rig(dataDir, queueEcho);
  rigs.push(r);
  return r;
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'rarog-d100-'));
});

afterEach(async () => {
  vi.useRealTimers();
  for (const r of rigs.splice(0)) await r.close();
  await rm(dataDir, { recursive: true, force: true });
});

const text = (value: string): InternalBlock[] => [{ type: 'text', text: foreign(value) }];
const flat = (message: TranscriptMessage): string => message.blocks
  .map((block) => (block.type === 'text' ? block.text : `[${block.type}]`)).join(' ');
const messages = (r: Rig): TranscriptMessage[] => r.manager.transcript(r.id).messages;
const lines = (r: Rig): string[] => messages(r).map((m) => `${m.role}: ${flat(m)}`);

/** Panel w pracy — stan, w którym prompt idzie do kolejki CLI. */
async function working(r: Rig, seq = 2): Promise<void> {
  r.driver.push({ type: 'agent-state', state: 'working', seen: false, mode: 'auto', stateChangeSeq: seq });
  await flush();
}

/** Wysyłka z apki umiejącej czekać (`queueAware`) z nowym identyfikatorem. */
function sendQueued(r: Rig, value: string, cid: string = randomUUID()): ReturnType<Manager['sendMessage']> {
  return r.manager.sendMessage(r.id, value, undefined, undefined, cid, { queueAware: true });
}

// ---------------------------------------------------------------------------

describe('wstrzymanie i podstawienie', () => {
  it('wysyłka w trakcie pracy: echo czeka, 202 `queued`, driver dostaje token', async () => {
    const r = await open();
    await working(r);
    const before = messages(r).length;
    await expect(sendQueued(r, 'dopisek', CID)).resolves.toEqual({ replayed: false, queued: true });

    expect(messages(r)).toHaveLength(before);
    expect(r.driver.wysylki).toEqual([{ text: 'dopisek', echo: expect.any(String) as string }]);
  });

  it('wpis z tokenem z pliku: wiadomość wchodzi W TYM MIEJSCU, z `clientMessageId`', async () => {
    const r = await open();
    await working(r);
    await sendQueued(r, 'dopisek', CID);
    const token = r.driver.lastToken;

    r.driver.push(
      { type: 'message', role: 'assistant', blocks: text('pracuję') },
      { type: 'message', role: 'user', blocks: text('dopisek'), echoToken: token },
      { type: 'message', role: 'assistant', blocks: text('odpowiedź na dopisek') },
    );
    await flush();
    expect(lines(r).slice(-3)).toEqual(['assistant: pracuję', 'user: dopisek', 'assistant: odpowiedź na dopisek']);
    expect(messages(r).at(-2)?.clientMessageId).toBe(CID);
  });

  it('kilka naraz: każdy prompt staje przy swoim wpisie, w kolejności pliku', async () => {
    const r = await open();
    await working(r);
    await sendQueued(r, 'A');
    const a = r.driver.lastToken;
    await sendQueued(r, 'B');
    const b = r.driver.lastToken;

    r.driver.push(
      { type: 'message', role: 'assistant', blocks: text('reszta tury') },
      { type: 'message', role: 'user', blocks: text('A'), echoToken: a },
      { type: 'message', role: 'assistant', blocks: text('na A') },
      { type: 'message', role: 'user', blocks: text('B'), echoToken: b },
      { type: 'message', role: 'assistant', blocks: text('na B') },
    );
    await flush();
    expect(lines(r).slice(-5)).toEqual([
      'assistant: reszta tury', 'user: A', 'assistant: na A', 'user: B', 'assistant: na B',
    ]);
  });

  it('historia z tokenem: podstawienie na pozycji historii', async () => {
    const r = await open();
    await working(r);
    await sendQueued(r, 'z Raroga', CID);
    const token = r.driver.lastToken;

    r.driver.push({
      type: 'history',
      messages: [
        { role: 'assistant', blocks: text('Zaczynam.'), at: '2026-10-14T09:59:00.000Z' },
        { role: 'user', blocks: text('z Raroga'), at: '2026-10-14T09:59:30.000Z', echoToken: token },
        { role: 'assistant', blocks: text('Dobrze.'), at: '2026-10-14T09:59:40.000Z' },
      ],
    });
    await flush();
    expect(lines(r).slice(-3)).toEqual(['assistant: Zaczynam.', 'user: z Raroga', 'assistant: Dobrze.']);
    expect(messages(r).at(-2)?.clientMessageId).toBe(CID);
  });

  it('token nieznany (wiadomość już spłukana): wpis z pliku przepada, bez dubla', async () => {
    const r = await open();
    await working(r);
    await sendQueued(r, 'dopisek', CID);
    const token = r.driver.lastToken;
    r.driver.push({ type: 'echo-refused', token });
    await flush();
    r.driver.push({ type: 'message', role: 'user', blocks: text('dopisek'), echoToken: token });
    await flush();
    expect(messages(r).filter((m) => flat(m) === 'dopisek')).toHaveLength(1);
  });
});

describe('bramka echa odroczonego — echo od razu', () => {
  const cases: { name: string; prepare(r: Rig): Promise<void>; send(r: Rig): Promise<unknown> }[] = [
    {
      name: 'bez `queueAware` (stara apka)',
      prepare: working,
      send: (r) => r.manager.sendMessage(r.id, 'dopisek', undefined, undefined, CID),
    },
    {
      name: 'bez `clientMessageId`',
      prepare: working,
      send: (r) => r.manager.sendMessage(r.id, 'dopisek', undefined, undefined, undefined, { queueAware: true }),
    },
    { name: 'sesja bezczynna', prepare: () => Promise.resolve(), send: (r) => sendQueued(r, 'dopisek', CID) },
    {
      name: 'zdjęcie w wysyłce',
      prepare: working,
      send: (r) => r.manager.sendMessage(r.id, 'dopisek', [PNG], undefined, CID, { queueAware: true }),
    },
    {
      name: 'driver nie umie odroczyć (slash, brak pliku rozmowy)',
      prepare: async (r) => { r.driver.defers = false; await working(r); },
      send: (r) => sendQueued(r, 'dopisek', CID),
    },
  ];

  it.each(cases)('$name', async ({ prepare, send }) => {
    const r = await open();
    await prepare(r);
    const ack = await send(r);
    expect(ack).not.toHaveProperty('queued');
    expect(flat(messages(r).at(-1) as TranscriptMessage)).toContain('dopisek');
    expect(r.driver.wysylki.at(-1)).not.toHaveProperty('echo');
  });

  it('`RAROG_QUEUE_ECHO=0`: serwer ignoruje `queueAware`', async () => {
    const r = await open(false);
    await working(r);
    await expect(sendQueued(r, 'dopisek', CID)).resolves.toEqual({ replayed: false });
    expect(messages(r).at(-1)?.clientMessageId).toBe(CID);
  });

  it('sufit: dziewiąta wysyłka dostaje echo od razu', async () => {
    const r = await open();
    await working(r);
    for (let i = 0; i < 8; i += 1) await expect(sendQueued(r, `p${String(i)}`)).resolves.toHaveProperty('queued', true);
    await expect(sendQueued(r, 'dziewiąty')).resolves.not.toHaveProperty('queued');
    expect(flat(messages(r).at(-1) as TranscriptMessage)).toBe('dziewiąty');
  });
});

describe('`queued` a rejestr wysyłek', () => {
  it('dołączenie do wysyłki w toku: ta sama obietnica, z `queued`', async () => {
    const r = await open();
    await working(r);
    const first = sendQueued(r, 'raz', CID);
    const second = sendQueued(r, 'raz', CID);
    expect(second).toBe(first);
    await expect(first).resolves.toEqual({ replayed: false, queued: true });
  });

  it('powtórka: `queued`, póki echo czeka; po podstawieniu — sama `replayed`', async () => {
    const r = await open();
    await working(r);
    await sendQueued(r, 'raz', CID);
    await expect(sendQueued(r, 'raz', CID)).resolves.toEqual({ replayed: true, queued: true });

    r.driver.push({ type: 'message', role: 'user', blocks: text('raz'), echoToken: r.driver.lastToken });
    await flush();
    await expect(sendQueued(r, 'raz', CID)).resolves.toEqual({ replayed: true });
  });
});

describe('spłukanie — wiadomość na koniec transkryptu, nic nie ginie', () => {
  it('`echo-refused`: ta jedna wiadomość, a ostrzeżenie drivera staje pod nią', async () => {
    const r = await open();
    await working(r);
    await sendQueued(r, 'pierwszy');
    const first = r.driver.lastToken;
    await sendQueued(r, 'drugi');

    r.driver.push(
      { type: 'echo-refused', token: first },
      { type: 'message', role: 'system', blocks: text('⚠ Wysyłka do panelu nie powiodła się') },
    );
    await flush();
    expect(lines(r).slice(-2)).toEqual(['user: pierwszy', 'system: ⚠ Wysyłka do panelu nie powiodła się']);
    expect(lines(r)).not.toContain('user: drugi');
    expect(r.logs.some((line) => line.includes(HELD_QUEUE_LOG))).toBe(true);
  });

  it('`echo-dropped` spłukuje swój prompt', async () => {
    const r = await open();
    await working(r);
    await sendQueued(r, 'wypadł', CID);
    r.driver.push({ type: 'echo-dropped', token: r.driver.lastToken });
    await flush();
    expect(messages(r).at(-1)).toMatchObject({ role: 'user', clientMessageId: CID });
  });

  it('`turn-input lost` spłukuje wszystkie, w kolejności wysyłki', async () => {
    const r = await open();
    await working(r);
    await sendQueued(r, 'A');
    await sendQueued(r, 'B');
    r.driver.push({ type: 'turn-input', lost: true });
    await flush();
    expect(lines(r).slice(-2)).toEqual(['user: A', 'user: B']);
  });

  /*
   * Zmierzone na CLI 2.1.299: Esc nad kolejką przerywa turę, a CLI od razu bierze
   * prompt z kolejki jako NOWĄ turę — w pliku `[Request interrupted by user]`, potem wpis `user` z promptem.
   */
  it('Esc nie spłukuje: prompt z kolejki przychodzi z pliku jako nowa tura, pod przerwaniem', async () => {
    const r = await open();
    await working(r);
    await sendQueued(r, 'przed Esc', CID);
    const token = r.driver.lastToken;
    await r.manager.interrupt(r.id);
    expect(messages(r).some((m) => m.clientMessageId === CID)).toBe(false);

    r.driver.push(
      { type: 'message', role: 'user', blocks: text('[Request interrupted by user]') },
      { type: 'message', role: 'user', blocks: text('przed Esc'), echoToken: token },
      { type: 'message', role: 'assistant', blocks: text('odpowiedź na prompt z kolejki') },
    );
    await flush();
    expect(lines(r).slice(-3)).toEqual([
      'user: [Request interrupted by user]', 'user: przed Esc', 'assistant: odpowiedź na prompt z kolejki',
    ]);
    expect(messages(r).at(-2)?.clientMessageId).toBe(CID);
  });

  it('wyjście z tury: spłukanie po 10 s; karta decyzji w trakcie tury nie spłukuje', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const r = await open();
    await working(r);
    await sendQueued(r, 'czekam', CID);

    // Karta zgody na minutę: to wciąż tura.
    r.driver.push({ type: 'agent-state', state: 'blocked', seen: false, mode: 'auto', stateChangeSeq: 3 });
    await flush();
    vi.advanceTimersByTime(60_000);
    await flush();
    expect(messages(r).some((m) => m.clientMessageId === CID)).toBe(false);

    // Koniec tury bez wzięcia promptu: 10 s zapasu, potem wiadomość na koniec.
    r.driver.push({ type: 'agent-state', state: 'idle', seen: false, mode: 'auto', stateChangeSeq: 4 });
    await flush();
    vi.advanceTimersByTime(9_000);
    await flush();
    expect(messages(r).some((m) => m.clientMessageId === CID)).toBe(false);
    vi.advanceTimersByTime(1_500);
    await flush();
    expect(messages(r).at(-1)).toMatchObject({ role: 'user', clientMessageId: CID });
  });

  it('powrót do tury kasuje spłukanie', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const r = await open();
    await working(r);
    await sendQueued(r, 'czekam', CID);
    r.driver.push({ type: 'agent-state', state: 'idle', seen: false, mode: 'auto', stateChangeSeq: 3 });
    await flush();
    await working(r, 4);
    vi.advanceTimersByTime(30_000);
    await flush();
    expect(messages(r).some((m) => m.clientMessageId === CID)).toBe(false);
  });

  it('koniec strumienia drivera: spłukanie, karta blednie', async () => {
    const r = await open();
    await working(r);
    await sendQueued(r, 'czekam', CID);
    r.driver.queue.close();
    await flush();
    expect(messages(r).at(-1)).toMatchObject({ role: 'user', clientMessageId: CID });
  });

  it('zamknięcie Raroga NIE spłukuje (wpis apki ma czekać na prompt z pliku po starcie)', async () => {
    const r = await open();
    await working(r);
    await sendQueued(r, 'czekam', CID);
    const count = messages(r).length;
    await r.manager.dispose();
    expect(messages(r)).toHaveLength(count);
  });
});
