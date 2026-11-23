/**
 * Zdania warstwy herdr: gniazdo, nadzorca, argumenty `claude` i załączniki mówią `say()`, a tekst herdr
 * i Node jedzie jako argument `text` albo `foreign()`. Każdy przypadek idzie drogą produkcyjną (atrapa gniazda jak
 * w `herdr-socket.test.ts`, prawdziwy klient i nadzorca nad nią) i sprawdza kod, argumenty i angielskie brzmienie
 * z rejestru.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SENTENCES, isForeignText, isServerSentence, textOf,
} from '@rarog/shared/sentences';
import type { AnyText, SentenceCode } from '@rarog/shared/sentences';
import { HERDR_RESYNC_MS } from '../src/config.ts';
import { AsyncEventQueue } from '../src/drivers/runtime.ts';
import type { Scheduler, TimerHandle } from '../src/drivers/runtime.ts';
import type { DecisionOutcome, SessionDriver } from '../src/drivers/types.ts';
import { HerdrArgvError, assertAllowedArgs, buildClaudeArgs } from '../src/herdr/argv.ts';
import { createHerdrClient } from '../src/herdr/client.ts';
import {
  CONNECT_TIMEOUT_MS, KNOWN_PROTOCOLS, LineSplitter, MUTATING_METHODS, REQUEST_TIMEOUT_MS,
  SUBSCRIBE_METHOD, SUBSCRIBE_START_TIMEOUT_MS, TESTED_PROTOCOL, assertMethodAllowed, createHerdrSocket,
} from '../src/herdr/socket.ts';
import type { HerdrConnectFn, HerdrStreamEvent, HerdrSubscription } from '../src/herdr/socket.ts';
import { createHerdrSupervisor } from '../src/herdr/supervisor.ts';
import type { HerdrSupervisorHandle } from '../src/herdr/supervisor.ts';
import type { HerdrLaunchRequest, HerdrLifecycleEvent } from '../src/herdr/types.ts';
import { UploadError, createUploads } from '../src/herdr/uploads.ts';

/** Przełącznik zapisu załącznika: reszta `node:fs/promises` zostaje prawdziwa. */
const fsState = vi.hoisted(() => ({ failWrite: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    writeFile: (...args: Parameters<typeof real.writeFile>) => (fsState.failWrite
      ? Promise.reject(new Error('EACCES: permission denied'))
      : real.writeFile(...args)),
  };
});

// ---------------------------------------------------------------------------
// Oczekiwane brzmienie z rejestru
// ---------------------------------------------------------------------------

/** Angielski szablon rejestru z argumentami w kolejności deklaracji (liczba mnoga według `one`/`other`). */
function english(code: SentenceCode, args: readonly string[] = []): string {
  const def = SENTENCES[code] as { en: string | { one: string; other: string }; args?: readonly string[] };
  const names = (def.args ?? []).map((spec) => spec.split(':')[0] ?? '');
  const pluralAt = (def.args ?? []).findIndex((spec) => spec.endsWith(':plural'));
  const template = typeof def.en === 'string' ? def.en : (args[pluralAt] === '1' ? def.en.one : def.en.other);
  return names.reduce((text, name, i) => text.replaceAll(`{${name}}`, args[i] ?? ''), template);
}

/** Zdanie z kodem, argumentami na drucie i angielskim tekstem rejestru. */
function expectSay(value: AnyText | undefined, code: SentenceCode, args: readonly string[] = []): void {
  expect(value !== undefined && isServerSentence(value), `${code}: źródło ma być zdaniem z say()`).toBe(true);
  if (value === undefined || !isServerSentence(value)) return;
  expect(value.ref.code).toBe(code);
  expect(value.ref.args ?? []).toEqual(args);
  expect(value.text).toBe(english(code, args));
}

/** Zdanie wyjątku rzuconego synchronicznie. */
function sentenceThrown(fn: () => unknown): AnyText | undefined {
  try {
    fn();
  } catch (err) {
    return (err as { sentence?: AnyText }).sentence;
  }
  return undefined;
}

/** Zdanie wyjątku z obietnicy. */
async function sentenceRejected(promise: Promise<unknown>): Promise<AnyText | undefined> {
  try {
    await promise;
  } catch (err) {
    return (err as { sentence?: AnyText }).sentence;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Atrapy gniazda (kształt jak w `herdr-socket.test.ts`)
// ---------------------------------------------------------------------------

class FakeConnection {
  readonly writes: string[] = [];
  onWrite: ((conn: FakeConnection, frame: { id: string; method: string }) => void) | null = null;
  readonly #listeners = new Map<string, ((arg?: unknown) => void)[]>();

  on(event: string, listener: (arg?: unknown) => void): void {
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), listener]);
  }

  emit(event: string, arg?: unknown): void {
    for (const listener of [...(this.#listeners.get(event) ?? [])]) listener(arg);
  }

  write(chunk: string): void {
    this.writes.push(chunk);
    this.onWrite?.(this, JSON.parse(chunk) as { id: string; method: string });
  }

  end(): void {
    this.emit('close');
  }

  destroy(): void {}

  reply(line: unknown): void {
    this.emit('data', Buffer.from(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`, 'utf8'));
  }
}

class FakeScheduler implements Scheduler {
  #now = 0;
  #seq = 0;
  readonly #timers = new Map<number, { at: number; fn: () => void }>();

  setTimeout(fn: () => void, ms: number): TimerHandle {
    this.#seq += 1;
    this.#timers.set(this.#seq, { at: this.#now + ms, fn });
    return this.#seq;
  }

  clearTimeout(handle: TimerHandle): void {
    this.#timers.delete(handle as number);
  }

  now(): number {
    return this.#now;
  }

  advance(ms: number): void {
    const target = this.#now + ms;
    for (;;) {
      const due = [...this.#timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.#timers.delete(due[0]);
      this.#now = due[1].at;
      due[1].fn();
    }
    this.#now = target;
  }
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
}

/** Zachowanie kolejnego połączenia: rzut przy otwarciu, cisza (bez `connect`) albo zwykłe. */
type Opening = { kind: 'throw'; message: string } | { kind: 'silent' } | { kind: 'normal' };

type Reply = (conn: FakeConnection, frame: { id: string; method: string }) => void;

interface SocketHarness {
  socket: ReturnType<typeof createHerdrSocket>;
  scheduler: FakeScheduler;
  /** Kolejne otwarcia (pierwsze to zwykle bramka protokołu `ping`). */
  openings: Opening[];
  /** Odpowiedź na ramkę inną niż `ping`; brak = cisza. */
  reply: { fn: Reply | null };
}

function socketHarness(opts: { protocol?: number | 'missing'; sendEnabled?: boolean } = {}): SocketHarness {
  const scheduler = new FakeScheduler();
  const openings: Opening[] = [];
  const reply: { fn: Reply | null } = { fn: null };
  const connect: HerdrConnectFn = () => {
    const opening = openings.shift() ?? { kind: 'normal' };
    if (opening.kind === 'throw') throw new Error(opening.message);
    const conn = new FakeConnection();
    conn.onWrite = (target, frame) => {
      if (frame.method === 'ping') {
        const protocol = opts.protocol ?? TESTED_PROTOCOL;
        queueMicrotask(() => target.reply({
          id: frame.id,
          result: { type: 'pong', version: '0.9.0', ...(protocol === 'missing' ? {} : { protocol }) },
        }));
        return;
      }
      reply.fn?.(target, frame);
    };
    if (opening.kind === 'normal') queueMicrotask(() => conn.emit('connect'));
    return conn as never;
  };
  const socket = createHerdrSocket({
    socketPath: '/x/herdr.sock', connect, scheduler, random: () => 0.5,
    ...(opts.sendEnabled === undefined ? {} : { sendEnabled: opts.sendEnabled }),
  });
  return { socket, scheduler, openings, reply };
}

/** Pierwsze `disconnected` strumienia subskrypcji. */
async function firstDisconnect(sub: HerdrSubscription): Promise<AnyText | undefined> {
  for await (const ev of sub.events as AsyncIterable<HerdrStreamEvent>) {
    if (ev.type === 'disconnected') return ev.reason;
  }
  return undefined;
}

const sockets: { dispose(): void }[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.dispose();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  fsState.failWrite = false;
});

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

const SESSION = '0f5e1c2a-3b4d-4e6f-8a9b-0c1d2e3f4a5b';
const OTHER = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const req = (patch: Partial<HerdrLaunchRequest> = {}): HerdrLaunchRequest => ({ cwd: '/p', ...patch });
const argvError = (fn: () => unknown): AnyText | undefined => {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(HerdrArgvError);
  return (thrown as HerdrArgvError).sentence;
};

describe('zdania argv `claude`', () => {
  it('allow-lista po budowie: każda odmowa ma własny kod', () => {
    expectSay(argvError(() => assertAllowedArgs([])), 'herdr.argv-empty');
    expectSay(argvError(() => assertAllowedArgs(['--model', 'opus', undefined as unknown as string])),
      'herdr.argv-missing-position', ['2']);
    expectSay(argvError(() => assertAllowedArgs(['--fork-session', '--fork-session'])),
      'herdr.argv-repeated.quoted', ['--fork-session', '1']);
    expectSay(argvError(() => assertAllowedArgs(['--continue'])), 'herdr.argv-not-allowed.quoted', ['0', '--continue']);
    expectSay(argvError(() => assertAllowedArgs(['--model']), ), 'herdr.argv-no-value.quoted', ['--model']);
    expectSay(argvError(() => assertAllowedArgs(['--model', '-x'])), 'herdr.argv-value-like-flag.quoted', ['--model']);
    expectSay(argvError(() => assertAllowedArgs(['--model', 'a b'])), 'herdr.argv-value-charset.quoted', ['--model']);
  });

  it('element spoza schematu nie jest cytowany: zdanie mówi tylko pozycję i długość', () => {
    const sentence = argvError(() => assertAllowedArgs(['zrób coś z /tmp/zażółć']));
    expectSay(sentence, 'herdr.argv-not-allowed.by-length', ['0', String('zrób coś z /tmp/zażółć'.length)]);
    expect(textOf(sentence as AnyText)).not.toContain('zażółć');
  });

  it('budowa z zlecenia: kształty i wykluczenia', () => {
    expectSay(argvError(() => buildClaudeArgs(req(), 'nie uuid')), 'herdr.argv-session-id-shape');
    expectSay(argvError(() => buildClaudeArgs(req({ fork: true }), SESSION)), 'herdr.argv-fork-without-resume');
    expectSay(argvError(() => buildClaudeArgs(req({ resumeFrom: SESSION }), SESSION)), 'herdr.argv-resume-same');
    expectSay(argvError(() => buildClaudeArgs(req({ resumeFrom: 'zły' }), SESSION)), 'herdr.argv-resume-shape');
    expectSay(argvError(() => buildClaudeArgs(req({ model: 'zły model' }), SESSION)), 'herdr.argv-model-shape');
    expectSay(argvError(() => buildClaudeArgs(req({ effort: 'max2' as never }), SESSION)), 'herdr.argv-effort');
    expectSay(argvError(() => buildClaudeArgs(req({ ultracode: true, effort: 'low' }), SESSION)),
      'herdr.argv-ultracode-effort');
    expectSay(argvError(() => buildClaudeArgs(req({ permissionMode: 'yolo' }), SESSION)), 'herdr.argv-permission-mode');
    // Poprawne zlecenie dalej przechodzi bez zmian.
    expect(buildClaudeArgs(req({ resumeFrom: OTHER, fork: true }), SESSION)).toEqual([
      '--session-id', SESSION, '--resume', OTHER, '--fork-session',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Gniazdo: żądanie
// ---------------------------------------------------------------------------

describe('zdania gniazda herdr: żądanie', () => {
  it('metoda spoza allow-listy', () => {
    expectSay(sentenceThrown(() => { assertMethodAllowed('pane.kill'); }), 'herdr.method-not-allowed', ['pane.kill']);
  });

  it('ramka bez końca linii: liczba mnoga według sufitu', () => {
    expectSay(sentenceThrown(() => new LineSplitter(64).push('x'.repeat(65))), 'herdr.frame-too-long', ['64']);
    expectSay(sentenceThrown(() => new LineSplitter(1).push('xx')), 'herdr.frame-too-long', ['1']);
    expect(textOf(sentenceThrown(() => new LineSplitter(1).push('xx')) as AnyText)).toContain('1 character with');
  });

  it.each([
    ['nie-json', 'herdr.response-not-json'],
    ['7', 'herdr.response-not-object'],
  ] as const)('odpowiedź %s → %s', async (line, code) => {
    const h = socketHarness();
    sockets.push(h.socket);
    h.reply.fn = (conn) => { queueMicrotask(() => conn.reply(line)); };
    expectSay(await sentenceRejected(h.socket.request('agent.list', {})), code);
  });

  it('odpowiedź z obcym identyfikatorem i bez `result`', async () => {
    const h = socketHarness();
    sockets.push(h.socket);
    let seen = '';
    h.reply.fn = (conn, frame) => {
      seen = frame.id;
      queueMicrotask(() => conn.reply({ id: 'cudzy', result: {} }));
    };
    expectSay(await sentenceRejected(h.socket.request('agent.list', {})), 'herdr.response-foreign-id', [seen]);
    h.reply.fn = (conn, frame) => { queueMicrotask(() => conn.reply({ id: frame.id })); };
    expectSay(await sentenceRejected(h.socket.request('agent.list', {})), 'herdr.response-no-result');
  });

  it('odpowiedź `error` herdr: dosłowny komunikat jako tekst obcy, bez kodu', async () => {
    const h = socketHarness();
    sockets.push(h.socket);
    h.reply.fn = (conn, frame) => {
      queueMicrotask(() => conn.reply({ id: frame.id, error: { code: 'zagadka', message: 'Coś poszło nie tak' } }));
    };
    const sentence = await sentenceRejected(h.socket.request('agent.list', {}));
    expect(isForeignText(sentence)).toBe(true);
    expect(textOf(sentence as AnyText)).toBe('Coś poszło nie tak');
  });

  it('kanał zapisu wyłączony: status i odmowa mutacji', async () => {
    const h = socketHarness({ sendEnabled: false });
    sockets.push(h.socket);
    expectSay(h.socket.status().detail, 'herdr.send-off');
    const mutating = [...MUTATING_METHODS][0] ?? '';
    expectSay(await sentenceRejected(h.socket.request(mutating, {})), 'herdr.send-off');
  });

  it('klient zamknięty', async () => {
    const h = socketHarness();
    h.socket.dispose();
    expectSay(await sentenceRejected(h.socket.request('agent.list', {})), 'herdr.client-closed');
  });

  it('gniazdo się nie otwiera: komunikat Node dosłownie w argumencie', async () => {
    const h = socketHarness();
    sockets.push(h.socket);
    h.openings.push({ kind: 'throw', message: 'connect ECONNREFUSED /x/herdr.sock' });
    const sentence = await sentenceRejected(h.socket.request('ping', {}));
    expectSay(sentence, 'herdr.socket-open-failed', ['connect ECONNREFUSED /x/herdr.sock']);
    // Status gniazda niesie to samo zdanie (baner).
    expectSay(h.socket.status().detail, 'herdr.socket-open-failed', ['connect ECONNREFUSED /x/herdr.sock']);
  });

  it('przekroczony czas łączenia i odpowiedzi', async () => {
    const h = socketHarness();
    sockets.push(h.socket);
    h.openings.push({ kind: 'silent' });
    const connecting = sentenceRejected(h.socket.request('ping', {}));
    await flush();
    h.scheduler.advance(CONNECT_TIMEOUT_MS);
    expectSay(await connecting, 'herdr.connect-timeout');

    const answering = sentenceRejected(h.socket.request('agent.list', {}));
    await flush();
    h.scheduler.advance(REQUEST_TIMEOUT_MS);
    expectSay(await answering, 'herdr.response-timeout', ['agent.list']);
  });

  it('błąd gniazda z komunikatem Node i bez niego', async () => {
    const h = socketHarness();
    sockets.push(h.socket);
    h.reply.fn = (conn) => { queueMicrotask(() => conn.emit('error', new Error('read ECONNRESET'))); };
    expectSay(await sentenceRejected(h.socket.request('agent.list', {})), 'herdr.socket-error', ['read ECONNRESET']);
    h.reply.fn = (conn) => { queueMicrotask(() => conn.emit('error', undefined)); };
    expectSay(await sentenceRejected(h.socket.request('agent.list', {})), 'herdr.socket-error.unknown');
  });

  it('zamknięcie bez odpowiedzi: pusto i urwany ogon', async () => {
    const h = socketHarness();
    sockets.push(h.socket);
    h.reply.fn = (conn) => { queueMicrotask(() => conn.emit('close')); };
    expectSay(await sentenceRejected(h.socket.request('agent.list', {})), 'herdr.closed-without-response');
    h.reply.fn = (conn) => {
      queueMicrotask(() => {
        conn.emit('data', Buffer.from('{"id":'));
        conn.emit('close');
      });
    };
    expectSay(await sentenceRejected(h.socket.request('agent.list', {})), 'herdr.closed-without-response');
  });
});

// ---------------------------------------------------------------------------
// Gniazdo: bramka protokołu
// ---------------------------------------------------------------------------

describe('zdania bramki protokołu herdr', () => {
  const oldest = Math.min(...KNOWN_PROTOCOLS);

  it('brak numeru protokołu: status i wyjątek, ten sam kod', async () => {
    const h = socketHarness({ protocol: 'missing' });
    sockets.push(h.socket);
    expectSay(await sentenceRejected(h.socket.request('agent.list', {})), 'herdr.protocol-missing');
    expectSay(h.socket.status().detail, 'herdr.protocol-missing');
  });

  it('protokół za stary: integracja wyłączona, zapis zablokowany', async () => {
    const h = socketHarness({ protocol: oldest - 1 });
    sockets.push(h.socket);
    const thrown = await sentenceRejected(h.socket.request('agent.list', {}));
    expectSay(thrown, 'herdr.protocol-too-old.disabled', [String(oldest - 1), String(oldest)]);
    const status = h.socket.status();
    expectSay(status.detail, 'herdr.protocol-too-old', [String(oldest - 1), String(oldest)]);
    expect(status).toMatchObject({ available: false, readOnly: true });
  });

  it('protokół nieznany nowszy: tylko odczyt, mutacja odbita tym samym zdaniem', async () => {
    const h = socketHarness({ protocol: TESTED_PROTOCOL + 1 });
    sockets.push(h.socket);
    h.reply.fn = (conn, frame) => { queueMicrotask(() => conn.reply({ id: frame.id, result: { agents: [] } })); };
    await h.socket.request('agent.list', {});
    const tested = [...KNOWN_PROTOCOLS].join(', ');
    const status = h.socket.status();
    expectSay(status.detail, 'herdr.protocol-unknown', [String(TESTED_PROTOCOL + 1), tested]);
    expect(status).toMatchObject({ available: true, readOnly: true });
    const mutating = [...MUTATING_METHODS][0] ?? '';
    expectSay(await sentenceRejected(h.socket.request(mutating, {})), 'herdr.protocol-unknown',
      [String(TESTED_PROTOCOL + 1), tested]);
  });
});

// ---------------------------------------------------------------------------
// Gniazdo: strumień subskrypcji
// ---------------------------------------------------------------------------

describe('zdania strumienia subskrypcji herdr', () => {
  const sub = (h: SocketHarness): HerdrSubscription => h.socket.subscribe([{ type: 'pane.agent_status_changed' }]);
  const started = (conn: FakeConnection, frame: { id: string }): void => {
    queueMicrotask(() => conn.reply({ id: frame.id, result: { type: 'subscription_started' } }));
  };

  it('otwarcie, czas łączenia i czas potwierdzenia', async () => {
    let h = socketHarness();
    sockets.push(h.socket);
    h.openings.push({ kind: 'normal' }, { kind: 'throw', message: 'connect ENOENT /x/herdr.sock' });
    expectSay(await firstDisconnect(sub(h)), 'herdr.stream-open-failed', ['connect ENOENT /x/herdr.sock']);

    h = socketHarness();
    sockets.push(h.socket);
    h.openings.push({ kind: 'normal' }, { kind: 'silent' });
    const silent = firstDisconnect(sub(h));
    await flush();
    h.scheduler.advance(CONNECT_TIMEOUT_MS);
    expectSay(await silent, 'herdr.stream-connect-timeout');

    h = socketHarness();
    sockets.push(h.socket);
    const quiet = firstDisconnect(sub(h));
    await flush();
    h.scheduler.advance(SUBSCRIBE_START_TIMEOUT_MS);
    expectSay(await quiet, 'herdr.subscribe-timeout');
  });

  it('odmowa, obca pierwsza ramka i zerwanie niosą kod herdr dosłownie', async () => {
    let h = socketHarness();
    sockets.push(h.socket);
    h.reply.fn = (conn, frame) => { queueMicrotask(() => conn.reply({ id: frame.id, error: { code: 'bad_sub' } })); };
    expectSay(await firstDisconnect(sub(h)), 'herdr.subscribe-refused', ['bad_sub']);

    h = socketHarness();
    sockets.push(h.socket);
    h.reply.fn = (conn, frame) => { queueMicrotask(() => conn.reply({ id: frame.id, result: { type: 'pong' } })); };
    expectSay(await firstDisconnect(sub(h)), 'herdr.subscribe-foreign-frame');

    h = socketHarness();
    sockets.push(h.socket);
    h.reply.fn = (conn, frame) => {
      started(conn, frame);
      queueMicrotask(() => { queueMicrotask(() => conn.reply({ error: { code: 'events_lost' } })); });
    };
    const subscription = sub(h);
    expectSay(await firstDisconnect(subscription), 'herdr.subscription-broken', ['events_lost']);
    // Status gniazda dostaje ten sam powód (baner).
    expectSay(h.socket.status().detail, 'herdr.subscription-broken', ['events_lost']);
  });

  it('błąd gniazda strumienia z komunikatem i bez, zamknięcie strumienia', async () => {
    const cases: [(conn: FakeConnection) => void, SentenceCode, string[]][] = [
      [(conn) => { conn.emit('error', new Error('read EPIPE')); }, 'herdr.stream-socket-error', ['read EPIPE']],
      [(conn) => { conn.emit('error', undefined); }, 'herdr.stream-socket-error.unknown', []],
      [(conn) => { conn.emit('close'); }, 'herdr.stream-closed', []],
    ];
    for (const [act, code, args] of cases) {
      const h = socketHarness();
      sockets.push(h.socket);
      h.reply.fn = (conn, frame) => {
        started(conn, frame);
        queueMicrotask(() => { queueMicrotask(() => { act(conn); }); });
      };
      expectSay(await firstDisconnect(sub(h)), code, args);
    }
  });
});

// ---------------------------------------------------------------------------
// Nadzorca nad prawdziwym gniazdem i klientem
// ---------------------------------------------------------------------------

const RAW_AGENT = {
  agent: 'claude',
  agent_session: { agent: 'claude', kind: 'id', source: 'herdr:claude', value: 'e3759b2c-2275-565c-8f49-4e2707bb0231' },
  agent_status: 'idle', cwd: '/Users/u/Projects/atlas', focused: false, foreground_cwd: '/Users/u/Projects/atlas',
  pane_id: 'w9:p72', revision: 3, state_change_seq: 23, tab_id: 'w9:t1H', terminal_id: 'term_0000000000000000',
  terminal_title: 'refaktor', workspace_id: 'w9',
};

interface SupervisorHarness {
  supervisor: HerdrSupervisorHandle;
  scheduler: FakeScheduler;
  lifecycle: HerdrLifecycleEvent[];
  /** Odpowiedź na `agent.list`: lista agentów, błąd gniazda Node albo ramka `error` herdr. */
  list: { mode: 'ok' | 'node-error' | 'remote-error'; agents: Record<string, unknown>[] };
}

async function supervisorHarness(agents: Record<string, unknown>[] = [RAW_AGENT]): Promise<SupervisorHarness> {
  const scheduler = new FakeScheduler();
  const list: SupervisorHarness['list'] = { mode: 'ok', agents };
  const connect: HerdrConnectFn = () => {
    const conn = new FakeConnection();
    conn.onWrite = (target, frame) => {
      queueMicrotask(() => {
        if (frame.method === 'ping') {
          target.reply({ id: frame.id, result: { type: 'pong', version: '0.9.0', protocol: TESTED_PROTOCOL } });
        } else if (frame.method === SUBSCRIBE_METHOD) {
          target.reply({ id: frame.id, result: { type: 'subscription_started' } });
        } else if (frame.method === 'agent.list' && list.mode === 'node-error') {
          target.emit('error', new Error('connect ECONNREFUSED /x/herdr.sock'));
        } else if (frame.method === 'agent.list' && list.mode === 'remote-error') {
          target.reply({ id: frame.id, error: { code: 'zagadka', message: 'coś poszło nie tak' } });
        } else if (frame.method === 'agent.list') {
          target.reply({ id: frame.id, result: { agents: list.agents } });
        } else {
          target.reply({ id: frame.id, result: {} });
        }
      });
    };
    queueMicrotask(() => conn.emit('connect'));
    return conn as never;
  };
  const socket = createHerdrSocket({ socketPath: '/x/herdr.sock', connect, scheduler, random: () => 0.5 });
  sockets.push(socket);
  const dataDir = await mkdtemp(join(tmpdir(), 'rarog-zdania-herdr-'));
  dirs.push(dataDir);
  const lifecycle: HerdrLifecycleEvent[] = [];
  const supervisor = createHerdrSupervisor({
    socketPath: '/x/herdr.sock', roots: ['/Users/u/Projects'], yoloRoots: [], sendEnabled: true, dataDir,
  }, {
    client: createHerdrClient(socket, { codexStatus: true }),
    transport: socket,
    scheduler,
    createDriver: (): SessionDriver => ({
      ownsProcess: false,
      events: new AsyncEventQueue(),
      send: () => {},
      respondPermission: async (): Promise<DecisionOutcome> => ({ kind: 'applied' }),
      answerQuestion: async (): Promise<DecisionOutcome> => ({ kind: 'applied' }),
      interrupt: async () => true,
      dispose: () => {},
    }),
    audit: { log: () => {}, flush: async () => {} },
    hidden: {
      aliasFor: () => undefined, rememberAlias: async () => {}, seenSeq: () => undefined, markSeen: async () => {},
      unseenSeq: () => undefined, markUnseen: async () => {}, flush: async () => {}, seenBy: () => undefined,
    },
  });
  sockets.push(supervisor);
  void (async () => {
    for await (const ev of supervisor.events) lifecycle.push(ev);
  })();
  await supervisor.ready;
  await flush(10);
  return { supervisor, scheduler, lifecycle, list };
}

describe('zdania nadzorcy herdr', () => {
  it('odmowy nadzorcy: nieznany agent, Codex, brak adresu taba, kanał tworzenia wyłączony', async () => {
    const codex = {
      ...RAW_AGENT, agent: 'codex', pane_id: 'w9:p80', tab_id: 'w9:t80',
      agent_session: { agent: 'codex', kind: 'id', source: 'herdr:codex', value: '0198f0c4-1f2a-7c31-9a44-6f2b5d0e7a10' },
    };
    const noTab = {
      ...RAW_AGENT, pane_id: 'w9:p81', tab_id: null,
      agent_session: { ...RAW_AGENT.agent_session, value: '5c0f2a9e-1d3b-4c5e-8f7a-9b0c1d2e3f4a' },
    };
    const h = await supervisorHarness([RAW_AGENT, codex, noTab]);
    expectSay(await sentenceRejected(h.supervisor.closeTab('w9:nikt')), 'herdr.agent-gone', ['w9:nikt']);
    expectSay(await sentenceRejected(h.supervisor.focus('w9:nikt')), 'herdr.agent-gone', ['w9:nikt']);
    expectSay(await sentenceRejected(h.supervisor.ensureFreshMode('w9:nikt')), 'herdr.agent-gone', ['w9:nikt']);
    expectSay(sentenceThrown(() => h.supervisor.attach('w9:nikt')), 'herdr.agent-gone', ['w9:nikt']);
    expectSay(await sentenceRejected(h.supervisor.closeTab('w9:p80')), 'session.codex-close');
    expectSay(await sentenceRejected(h.supervisor.closeTab('w9:p81')), 'herdr.tab-unknown');
    // Bez własnego gniazda nadzorca nie ma kanału tworzenia: zamknięcie i założenie odmawiają tym samym zdaniem.
    expectSay(await sentenceRejected(h.supervisor.closeTab('w9:p72')), 'herdr.launch-off-panels');
    expectSay(await sentenceRejected(h.supervisor.launch({ cwd: '/Users/u/Projects/atlas' })), 'herdr.launch-off-panels');
  });

  it('awaria i powrót: `detailRef` statusu ze zdania gniazda, potem bez szczegółu', async () => {
    const h = await supervisorHarness();
    expect(h.supervisor.status()).not.toHaveProperty('detail');

    h.list.mode = 'node-error';
    h.scheduler.advance(HERDR_RESYNC_MS);
    await flush(10);
    const down = h.supervisor.status();
    // Ten sam status niesie `sessions-snapshot` (`manager.herdrStatus()`), a `herdr-status` bierze z niego bazę.
    expect(down.detail).toBe(english('herdr.socket-error', ['connect ECONNREFUSED /x/herdr.sock']));
    expect(down.detailRef).toEqual({ code: 'herdr.socket-error', args: ['connect ECONNREFUSED /x/herdr.sock'] });
    const unavailable = h.lifecycle.find((ev) => ev.type === 'unavailable');
    expectSay(unavailable?.type === 'unavailable' ? unavailable.reason : undefined, 'herdr.socket-error',
      ['connect ECONNREFUSED /x/herdr.sock']);

    h.list.mode = 'ok';
    h.scheduler.advance(HERDR_RESYNC_MS);
    await flush(10);
    const up = h.supervisor.status();
    expect(up).not.toHaveProperty('detail');
    expect(up).not.toHaveProperty('detailRef');
    expect(h.lifecycle.some((ev) => ev.type === 'available')).toBe(true);
  });

  it('błąd `error` herdr z nieznanym kodem: powód jako tekst obcy, bez `detailRef`', async () => {
    const h = await supervisorHarness();
    h.list.mode = 'remote-error';
    h.scheduler.advance(HERDR_RESYNC_MS);
    await flush(10);
    const unavailable = h.lifecycle.find((ev) => ev.type === 'unavailable');
    const reason = unavailable?.type === 'unavailable' ? unavailable.reason : undefined;
    expect(isForeignText(reason)).toBe(true);
    expect(textOf(reason as AnyText)).toBe('herdr: coś poszło nie tak');
    expect(h.supervisor.status()).not.toHaveProperty('detailRef');
  });
});

// ---------------------------------------------------------------------------
// Załączniki
// ---------------------------------------------------------------------------

const PNG = `data:image/png;base64,${Buffer.from('\x89PNG\r\n\x1a\nxx').toString('base64')}`;

describe('zdania załączników', () => {
  const project = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'rarog-zdania-uploads-'));
    dirs.push(dir);
    return dir;
  };

  it('katalog załączników zajęty przez plik, dowiązanie i inny wpis: osobne kody, odmowa przed zapisem', async () => {
    const uploads = createUploads();
    const asFile = await project();
    await writeFile(join(asFile, '.rarog-uploads'), 'x');
    const asLink = await project();
    await mkdir(join(asLink, 'cel'));
    await symlink(join(asLink, 'cel'), join(asLink, '.rarog-uploads'));
    const asFifo = await project();
    execFileSync('mkfifo', [join(asFifo, '.rarog-uploads')]);

    for (const [cwd, code] of [
      [asFile, 'uploads.dir-not-directory.file'],
      [asLink, 'uploads.dir-not-directory.symlink'],
      [asFifo, 'uploads.dir-not-directory.other'],
    ] as const) {
      const thrown = await sentenceRejected(uploads.write(cwd, [PNG]));
      expectSay(thrown, code, [join(cwd, '.rarog-uploads')]);
    }
    // Odmowa przed zapisem: cel dowiązania został pusty.
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(join(asLink, 'cel'))).toEqual([]);
  });

  it('zła treść zdjęcia i pliku', async () => {
    const uploads = createUploads();
    const cwd = await project();
    expectSay(await sentenceRejected(uploads.write(cwd, ['data:text/plain;base64,eA=='])), 'uploads.not-image');
    expectSay(await sentenceRejected(uploads.writeFiles(cwd, [{ name: 'raport.txt', dataUrl: 'zly' }])),
      'uploads.bad-content', ['raport.txt']);
  });

  it('katalog nie powstaje i zapis pada: ścieżka i komunikat Node dosłownie', async () => {
    const uploads = createUploads();
    const root = await project();
    const notDir = join(root, 'zażółć');
    await writeFile(notDir, 'x');
    const mk = await sentenceRejected(uploads.write(notDir, [PNG]));
    expect(mk !== undefined && isServerSentence(mk) ? mk.ref.code : '').toBe('uploads.mkdir-failed');
    if (mk !== undefined && isServerSentence(mk)) {
      expect(mk.ref.args?.[0]).toBe(join(notDir, '.rarog-uploads'));
      expect(mk.ref.args?.[1]).toMatch(/ENOTDIR/);
      expectSay(mk, 'uploads.mkdir-failed', [...(mk.ref.args ?? [])]);
    }

    const cwd = await project();
    fsState.failWrite = true;
    const wr = await sentenceRejected(uploads.write(cwd, [PNG]));
    expect(wr !== undefined && isServerSentence(wr) ? wr.ref.code : '').toBe('uploads.write-failed');
    if (wr !== undefined && isServerSentence(wr)) {
      expect(wr.ref.args?.[0]).toMatch(/\.rarog-uploads\/\d+-[0-9a-f]{16}\.png$/u);
      expect(wr.ref.args?.[1]).toBe('EACCES: permission denied');
      expectSay(wr, 'uploads.write-failed', [...(wr.ref.args ?? [])]);
    }
  });

  it('`UploadError` niesie zdanie dla ciała REST', async () => {
    const thrown = await createUploads().write(await project(), ['nie-data-url']).catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(UploadError);
  });
});
