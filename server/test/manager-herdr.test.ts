/**
 * Manager × sesje herdr — testy na ATRAPACH nadzorcy i drivera.
 *
 * Zero gniazda, zero `~/.claude`, zero procesów: te testy pilnują reguł, które da się złamać
 * jedną linijką w managerze, a których cena jest płacona w CUDZYM terminalu:
 * - sprzątanie Raroga NIE wysyła nic do paneli (`ownsProcess: false`),
 * - awaria herdr nie jest przejściem stanu (`stale`, nigdy `error`),
 * - panele nie zjadają limitu sesji SDK i nie trafiają do rejestru,
 * - wysyłka przechodzi przez guard i throttle ZANIM cokolwiek zmieni stan sesji.
 *
 * Zegar jest realny (integracja jest sterowana zdarzeniami, nie czasem), a „teraz" managera
 * jest wstrzykiwane — throttle wysyłki testujemy przesuwając liczbę, nie czekając 3 s.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { ULTRACODE_CHANGE_NOTE, dataUrlBytes } from '@rarog/shared';
import type {
  BackgroundTask, ServerEvent, SessionSummary, TranscriptNotice,
} from '@rarog/shared';
import {
  BadRequestError, BadStateError, GIT_DIFF_FILE_LOG, GIT_DIFF_LIST_LOG, HERDR_PANE_CAP_MESSAGE, NotFoundError,
  TooManyRequestsError, UltracodeRefusedError, createManager, herdrInitialState,
} from '../src/sessions/manager.ts';
import {
  HERDR_ALLOW_MESSAGE, HERDR_MODEL_MESSAGE, HERDR_MODE_UNKNOWN_MESSAGE, HERDR_NO_DRIVER_INTERRUPT_MESSAGE,
  HERDR_OUT_OF_SCOPE_DIFF_MESSAGE, HERDR_OUT_OF_SCOPE_MESSAGE,
  HERDR_RESUME_MESSAGE, HERDR_TERMINAL_UNAVAILABLE_MESSAGE, INTERRUPT_DETAIL, RESUME_FOREIGN_CWD_MESSAGE,
  ULTRACODE_CLI_UNKNOWN_MESSAGE, ULTRACODE_EFFORT_MESSAGE, ultracodeCliTooOldMessage,
} from '../src/sessions/state-sentences.ts';
import type { ConsentManagerChannel, HerdrManagerDeps, Manager, ManagerConfig } from '../src/sessions/manager.ts';
import { type AnyText, foreign, say, textOf } from '@rarog/shared/sentences';
import { ULTRACODE_COMMANDS } from '../src/herdr/commands/registry.ts';
import type { CliVersionSnapshot } from '../src/cli-version.ts';
import { GIT_STATS_WINDOW_LOG } from '../src/git-stats.ts';
import { GitStatusWatcher, parseGitStatusV2 } from '../src/git-status.ts';
import type { GitRepoWatcher } from '../src/git-watch.ts';
import { SseHub } from '../src/sse.ts';
import type { DriverEvent, InternalBlock } from '../src/drivers/types.ts';
import { assertSendable } from '../src/herdr/commands/guard.ts';
import { commandListOf, createCommandCatalogs, registryCatalog } from '../src/herdr/commands/catalog.ts';
import type { CommandCatalog } from '../src/herdr/commands/catalog.ts';
import type { HerdrAgent } from '../src/herdr/types.ts';
import { HerdrGoneError } from '../src/herdr/types.ts';
import { HerdrUnavailableError, createHerdrSocket } from '../src/herdr/socket.ts';
import type { NoteInput, NotifierLike } from '../src/notify/index.ts';
import { Notifier, PUSH_QUIET_LOG, sessionLook } from '../src/notify/index.ts';
import { FIRST_CHECK_MS } from '../src/notify/policy.ts';
import { Presence } from '../src/notify/presence.ts';
import type { PushContent } from '../src/notify/content.ts';
import { parseImportLine } from '../src/transcript-import.ts';
import { MAX_LABEL_LENGTH, labelFromPrompt } from '../src/session-label.ts';
import {
  ENGINE_SESSION, FakeSupervisor, PROJECT, flush, makeAgent, makeDeps,
} from './helpers/manager-herdr-atrapy.ts';
import type { FakeDeps, FakeHerdrDriver } from './helpers/manager-herdr-atrapy.ts';

/** 1×1 px png — liczy się wyłącznie poprawny kształt data URL. */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==';
/** Załącznik plikowy — liczy się kształt data URL-a, nie treść. */
const PDF = 'data:application/pdf;base64,JVBERi0xLjQK';

// ---------------------------------------------------------------------------

describe('manager — sesje herdr', () => {
  let dataDir: string;
  const managers: Manager[] = [];
  const supervisors: FakeSupervisor[] = [];

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'rarog-herdr-'));
  });

  afterEach(async () => {
    for (const manager of managers.splice(0)) await manager.dispose();
    for (const supervisor of supervisors.splice(0)) supervisor.dispose();
    await rm(dataDir, { recursive: true, force: true });
  });

  function makeSupervisor(): FakeSupervisor {
    const supervisor = new FakeSupervisor();
    supervisors.push(supervisor);
    return supervisor;
  }

  async function build(
    supervisor: FakeSupervisor, deps: HerdrManagerDeps, overrides: Partial<ManagerConfig> = {},
  ): Promise<Manager> {
    const manager = await createManager({
      demo: false,
      dataDir,
      projects: [{ path: PROJECT, name: 'atlas' }],
      projectRoots: [],
      gitStatus: null,
      maxPanes: 6,
      herdrSupervisor: supervisor,
      herdrDeps: deps,
      herdrRoots: [PROJECT],
      herdrSend: true,
      ...overrides,
    });
    managers.push(manager);
    await manager.ready;
    return manager;
  }

  function record(manager: Manager): { scope: string; seq: number | null; event: ServerEvent }[] {
    const out: { scope: string; seq: number | null; event: ServerEvent }[] = [];
    manager.onEvent((scope, seq, event) => { out.push({ scope, seq, event }); });
    return out;
  }

  /** Manager + jedna widoczna sesja herdr gotowa do dalszych kroków. */
  async function withOneAgent(agent: HerdrAgent = makeAgent(), deps = makeDeps()): Promise<{
    manager: Manager; supervisor: FakeSupervisor; deps: FakeDeps; id: string;
  }> {
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, deps);
    supervisor.appear(agent);
    await flush();
    const id = manager.list().find((s) => s.paneId !== undefined)?.id ?? '';
    expect(id).not.toBe('');
    return { manager, supervisor, deps, id };
  }

  // -------------------------------------------------------------------------
  // Sprzątanie: NAJWAŻNIEJSZY test w tym pliku
  // -------------------------------------------------------------------------

  it('dispose() managera z 3 sesjami herdr nie wysyła do paneli ANI JEDNEGO wywołania', async () => {
    /*
     * Ten test istnieje, bo `manager.dispose()` woła `#detachDriver` dla WSZYSTKICH sesji,
     * a `#detachDriver` dla sesji SDK woła `interrupt()`. Gdyby zabrakło warunku
     * `driver.ownsProcess`, każdy restart Raroga (czyli każdy deploy) słałby przerwanie do
     * wszystkich paneli `claude` na Macu — ucinając pracę, której Rarog nie zaczął.
     */
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, makeDeps());
    for (const key of ['w1:p1', 'w1:p2', 'w2:p9']) {
      supervisor.appear(makeAgent({ key, paneId: key, agentSessionId: `${ENGINE_SESSION}${key}` }));
    }
    await flush();
    expect(manager.list().filter((s) => s.paneId !== undefined)).toHaveLength(3);

    await manager.dispose();

    expect(supervisor.log.calls).toEqual([]);
    for (const key of ['w1:p1', 'w1:p2', 'w2:p9']) {
      expect(supervisor.driver(key).disposals).toBe(1);
    }
  });

  it('17 CUDZYCH paneli nie zjada sufitu paneli RAROGA (liczą się tylko własne)', async () => {
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, makeDeps());
    for (let i = 0; i < 17; i += 1) {
      supervisor.appear(makeAgent({
        key: `w1:p${String(i)}`,
        paneId: `w1:p${String(i)}`,
        agentSessionId: `1111111${String(i).padStart(2, '0')}-1111-4111-8111-111111111111`,
      }));
    }
    await flush(8);
    expect(manager.list()).toHaveLength(17);

    // Sufit liczy WYŁĄCZNIE panele założone przez Raroga (`rarogPaneCount`), więc 17 cudzych
    // paneli nie ma prawa zablokować pierwszej sesji z telefonu.
    const created = await manager.create({ cwd: PROJECT, prompt: 'nowa sesja z telefonu' });
    expect(created.state).toBe('starting');
    expect(supervisor.launches).toHaveLength(1);
  });

  it('rejestr sesji NIE ISTNIEJE: `sessions.json` nie powstaje nawet po 60 sesjach', async () => {
    const { manager } = await withOneAgent();
    for (let i = 0; i < 60; i += 1) {
      manager.list();
    }
    await manager.flush();
    await expect(readFile(join(dataDir, 'sessions.json'), 'utf8')).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // Awaria herdr: `stale`, nigdy przejście stanu
  // -------------------------------------------------------------------------

  it('unavailable wygasza wszystkie karty herdr i NIE rusza ich stanów', async () => {
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, makeDeps());
    supervisor.appear(makeAgent({ key: 'w1:p1', paneId: 'w1:p1', status: 'working' }));
    supervisor.appear(makeAgent({
      key: 'w1:p2', paneId: 'w1:p2', status: 'blocked',
      agentSessionId: '22222222-2222-4222-8222-222222222222',
    }));
    await flush();
    const before = manager.list().map((s) => `${s.id}:${s.state}`).sort();

    const events = record(manager);
    supervisor.setStatus({ available: false, detail: 'socket padł' });
    supervisor.emit({ type: 'unavailable', reason: foreign('socket padł') });
    await flush();

    const after = manager.list();
    expect(after.map((s) => `${s.id}:${s.state}`).sort()).toEqual(before);
    expect(after.every((s) => s.stale === true)).toBe(true);
    expect(after.some((s) => s.state === 'error' || s.state === 'resumable')).toBe(false);

    const status = events.find((e) => e.event.type === 'herdr-status');
    expect(status?.scope).toBe('global');
    expect(status?.seq).toBeNull();
    expect(status?.event).toMatchObject({ available: false, detail: 'socket padł' });
  });

  it('`herdr-status`: zdanie gniazda z `detailRef`, tekst obcy bez kodu, powrót bez szczegółu', async () => {
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, makeDeps());
    const events = record(manager);
    const statuses = (): Extract<ServerEvent, { type: 'herdr-status' }>[] => events
      .map((e) => e.event)
      .filter((e): e is Extract<ServerEvent, { type: 'herdr-status' }> => e.type === 'herdr-status');

    // Zdanie z prawdziwego gniazda: komunikat Node jedzie dosłownie jako argument.
    let reason: AnyText = foreign('');
    try {
      await createHerdrSocket({
        socketPath: '/x/herdr.sock',
        connect: () => { throw new Error('connect ECONNREFUSED /x/herdr.sock'); },
      }).request('ping', {});
    } catch (err) {
      reason = (err as HerdrUnavailableError).sentence;
    }
    supervisor.setStatus({ available: false, detail: textOf(reason) });
    supervisor.emit({ type: 'unavailable', reason });
    await flush();
    expect(statuses().at(-1)).toMatchObject({
      available: false,
      detail: "Couldn't open the herdr socket: connect ECONNREFUSED /x/herdr.sock",
      detailRef: { code: 'herdr.socket-open-failed', args: ['connect ECONNREFUSED /x/herdr.sock'] },
    });

    // Następny powód to tekst obcy (ramka `error` herdr): stary kod nie zostaje przy nowym tekście.
    supervisor.emit({ type: 'unavailable', reason: foreign('herdr: coś poszło nie tak') });
    await flush();
    expect(statuses().at(-1)).toMatchObject({ available: false, detail: 'herdr: coś poszło nie tak' });
    expect(statuses().at(-1)).not.toHaveProperty('detailRef');

    // Powrót: nadzorca nie ma już szczegółu, więc `herdr-status` i `sessions-snapshot` go nie niosą.
    supervisor.setStatus({ available: true, detail: undefined });
    supervisor.emit({ type: 'available' });
    await flush();
    expect(statuses().at(-1)).toMatchObject({ available: true });
    expect(statuses().at(-1)).not.toHaveProperty('detail');
    expect(statuses().at(-1)).not.toHaveProperty('detailRef');
    expect(manager.herdrStatus?.()?.detail).toBeUndefined();
  });

  /*
   * The "may I start a session" answer must stay fresh: `canLaunch` also travels in the transient `herdr-status`, not
   * only in the `sessions-snapshot` frame (stream connect, session closed from Rarog). Otherwise a panel closed by hand
   * on the Mac frees a slot while the phone keeps the dimmed "+" and the limit sentence until a reconnect.
   */
  it('zniknięcie panelu ROZGŁASZA nową odpowiedź, nie czeka na reconnect', async () => {
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, makeDeps());
    // Najpierw dojazd do sufitu: panel dochodzi, a odpowiedź zmienia się na „nie wolno".
    supervisor.setStatus({ canLaunch: false, detail: 'limit' });
    supervisor.appear(makeAgent());
    await flush();

    // …a teraz miejsce zwalnia się PRZY MACU, poza Rarogiem: żadnego snapshotu tu nie ma.
    const events = record(manager);
    supervisor.setStatus({ canLaunch: true, detail: undefined });
    supervisor.emit({ type: 'gone', key: makeAgent().key });
    await flush();

    const status = events.filter((e) => e.event.type === 'herdr-status');
    expect(status).toHaveLength(1);
    expect(status[0]?.scope).toBe('global');
    expect(status[0]?.event).toMatchObject({ canLaunch: true });
  });

  it('pojawienie się panelu też odświeża odpowiedź — licznik rośnie u wszystkich', async () => {
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, makeDeps());
    const events = record(manager);

    supervisor.setStatus({ canLaunch: false, detail: 'limit' });
    supervisor.appear(makeAgent());
    await flush();

    const status = events.filter((e) => e.event.type === 'herdr-status');
    expect(status).toHaveLength(1);
    expect(status[0]?.event).toMatchObject({ canLaunch: false, detail: 'limit' });
  });

  it('resync NIE robi burzy: identyczna odpowiedź nie jest rozgłaszana drugi raz', async () => {
    /*
     * Powrót herdr sypie kilkunastoma `appeared`/`re-attached` naraz (zmierzone: 17). Gdyby
     * każde z nich rozgłaszało status, jedna informacja zamieniłaby się w burzę identycznych
     * ramek — dlatego porównujemy parę (odpowiedź, powód) i milczymy, gdy się nie zmieniła.
     */
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, makeDeps());
    supervisor.setStatus({ canLaunch: true });
    const events = record(manager);

    for (let i = 0; i < 5; i += 1) {
      supervisor.appear(makeAgent({
        key: `w9:p${String(i)}`,
        paneId: `w9:p${String(i)}`,
        agentSessionId: `3333333${String(i)}-3333-4333-8333-333333333333`,
      }));
    }
    await flush();

    // Pierwsze zdarzenie mówi coś nowego (nic jeszcze nie wysłaliśmy), reszta powtarza je
    // słowo w słowo — i ta reszta ma milczeć.
    expect(events.filter((e) => e.event.type === 'herdr-status')).toHaveLength(1);
  });

  it('powrót herdr: re-attached zostawia TĘ SAMĄ sesję i gasi `stale`', async () => {
    const { manager, supervisor, id } = await withOneAgent();
    supervisor.emit({ type: 'unavailable', reason: foreign('restart herdr') });
    await flush();
    expect(manager.get(id)?.stale).toBe(true);

    supervisor.setStatus({ available: true });
    supervisor.emit({ type: 'available' });
    supervisor.reattach(makeAgent());
    await flush();

    const herdrSessions = manager.list().filter((s) => s.paneId !== undefined);
    expect(herdrSessions).toHaveLength(1);
    expect(herdrSessions[0]?.id).toBe(id);
    expect(herdrSessions[0]?.stale).toBe(false);
    expect(supervisor.attachCount).toBe(2);
  });

  /** Wywołanie portu `reattached`: sesje i liczba odpięć starego drivera w chwili wywołania i po bieżącym kroku. */
  interface ReattachCall {
    ids: readonly string[];
    oldDisposals: number;
    /** Odpięcia starego drivera w pierwszym zadaniu mikro po wywołaniu: koniec bieżącego kroku synchronicznego. */
    oldDisposalsAfterStep?: number;
  }

  /** Kanał zgód, który zapisuje wywołania portu `reattached` ({@link ReattachCall}). */
  function reattachRecorder(supervisor: FakeSupervisor, key: string, calls: ReattachCall[]): ConsentManagerChannel {
    const refused = { ok: false, error: 'not-found', state: null } as const;
    return {
      cards: () => [],
      decide: async () => refused,
      release: async () => refused,
      revoke: async () => [],
      retire: async () => undefined,
      turnEnded: async () => undefined,
      reattached: async (ids) => {
        const old = supervisor.drivers.get(key);
        const call: ReattachCall = { ids: [...ids], oldDisposals: old?.disposals ?? -1 };
        calls.push(call);
        queueMicrotask(() => { call.oldDisposalsAfterStep = old?.disposals ?? -1; });
      },
    };
  }

  it('powrót herdr: `re-attached` znanego panelu woła port `reattached` kanału zgód z sesją silnika karty, zanim odepnie'
    + ' stary driver, i odpina go w tym samym kroku synchronicznym (stary driver nie zaczyna już obserwacji kanału);'
    + ' `appeared` i `re-attached` panelu bez sesji (droga `appeared`) go nie wołają', async () => {
    const calls: ReattachCall[] = [];
    const supervisor = makeSupervisor();
    await build(supervisor, makeDeps(), { consent: reattachRecorder(supervisor, 'w9:p72', calls) });
    supervisor.appear(makeAgent());
    await flush();
    expect(calls).toEqual([]);
    const old = supervisor.driver('w9:p72');
    supervisor.emit({ type: 'unavailable', reason: foreign('restart herdr') });
    await flush();
    supervisor.setStatus({ available: true });
    supervisor.emit({ type: 'available' });
    supervisor.reattach(makeAgent());
    await flush();
    expect(calls).toEqual([{ ids: [ENGINE_SESSION], oldDisposals: 0, oldDisposalsAfterStep: 1 }]);
    expect(old.disposals).toBe(1);
    expect(supervisor.driver('w9:p72')).not.toBe(old);
    supervisor.reattach(makeAgent({ key: 'w9:p73', paneId: 'w9:p73', title: 'inny', agentSessionId: `${ENGINE_SESSION}-b` }));
    await flush();
    expect(calls).toHaveLength(1);
  });

  it('powrót herdr: rozmowa zmieniona w przerwie gniazda (`/clear`, `/resume`) → port `reattached` dostaje sesję karty'
    + ' i sesję z migawki agenta; panel Codexa (uuid to nie sesja silnika) portu nie woła', async () => {
    const calls: ReattachCall[] = [];
    const supervisor = makeSupervisor();
    await build(supervisor, makeDeps(), { consent: reattachRecorder(supervisor, 'w9:p72', calls) });
    supervisor.appear(makeAgent());
    supervisor.appear(makeAgent({ key: 'w9:p74', paneId: 'w9:p74', title: 'codex', engine: 'codex', agentSessionId: 'codex-1' }));
    await flush();
    const next = '33333333-3333-4333-8333-333333333333';
    supervisor.reattach(makeAgent({ agentSessionId: next }));
    supervisor.reattach(makeAgent({ key: 'w9:p74', paneId: 'w9:p74', title: 'codex', engine: 'codex', agentSessionId: 'codex-2' }));
    await flush();
    expect(calls.map((c) => c.ids)).toEqual([[ENGINE_SESSION, next]]);
  });

  it('koniec strumienia drivera bez własnego procesu daje `stale`, a nie `error`', async () => {
    const { manager, supervisor, id } = await withOneAgent();
    // Urwany strumień to „Rarog stracił kontakt", a nie „silnik padł": panel żyje dalej.
    supervisor.driver('w9:p72').queue.close();
    await flush();

    expect(manager.get(id)?.stale).toBe(true);
    expect(manager.get(id)?.state).not.toBe('error');
  });

  it('detached z drivera ustawia `stale` bez zmiany stanu', async () => {
    const { manager, supervisor, id } = await withOneAgent();
    const stateBefore = manager.get(id)?.state;
    supervisor.driver('w9:p72').queue.push({ type: 'detached', reason: 'socket' });
    await flush();

    expect(manager.get(id)?.stale).toBe(true);
    expect(manager.get(id)?.state).toBe(stateBefore);
  });

  /**
   * Zadania w tle są METADANĄ karty, jak git: żadnego przejścia stanu, żadnego wpisu
   * w transkrypcie — sam `session-changed` z nowym polem.
   *
   * Druga połowa testu jest ważniejsza od pierwszej: PUSTA lista musi ZNIKNĄĆ z summary, a nie
   * pojechać jako `[]`. „Nic nie leci" i „nie wiem" znaczą dla telefonu to samo (plakietki nie
   * ma), a dwie reprezentacje jednego stanu to dwa warunki w każdym miejscu, które to czyta.
   */
  it('background-tasks ląduje w summary, a pusta lista kasuje pole', async () => {
    const { manager, supervisor, id } = await withOneAgent();
    const stateBefore = manager.get(id)?.state;
    const task = {
      id: 'b28xs0cd6', kind: 'command' as const, description: 'Testy', command: 'pnpm test',
    };

    supervisor.driver('w9:p72').queue.push({ type: 'background-tasks', tasks: [task] });
    await flush();
    expect(manager.get(id)?.backgroundTasks).toEqual([task]);
    expect(manager.get(id)?.state).toBe(stateBefore);

    supervisor.driver('w9:p72').queue.push({ type: 'background-tasks', tasks: [] });
    await flush();
    expect(manager.get(id)).not.toHaveProperty('backgroundTasks');
  });

  /**
   * Driver wysyła pierwszą listę po podpięciu także pustą (wymiana drivera zachowuje sesję z listą
   * poprzedniego). Pusta przy polu, którego i tak nie ma, nie jest zmianą: restart Raroga dawałby inaczej
   * ramkę `session-changed` na każdy panel bez zadań.
   */
  it('pusta lista zadań przy polu, którego nie ma, nie rozsyła karty', async () => {
    const { manager, supervisor, id } = await withOneAgent();
    const events = record(manager);
    const changes = (): number => events
      .filter((e) => e.scope === 'global' && e.event.type === 'session-changed').length;

    supervisor.driver('w9:p72').queue.push({ type: 'background-tasks', tasks: [] });
    await flush();
    expect(changes()).toBe(0);
    expect(manager.get(id)).not.toHaveProperty('backgroundTasks');
  });

  /**
   * Resync repeats the status on every pass, so the manager must broadcast a card only on a real change; otherwise
   * 17 panels would give 17 empty global SSE frames every 30 s and wake the phone with no new information.
   */
  it('powtórzony ten sam status nie rozgłasza karty, ale zmiana trybu tak', async () => {
    const { manager, supervisor, id } = await withOneAgent();
    const events = record(manager);
    const changes = (): number => events
      .filter((e) => e.scope === 'global' && e.event.type === 'session-changed').length;

    const state = manager.get(id)?.state;
    supervisor.driver('w9:p72').queue.push({ type: 'agent-state', state: 'idle', seen: true });
    await flush();
    const afterRepeat = changes();
    supervisor.driver('w9:p72').queue.push({ type: 'agent-state', state: 'idle', seen: true });
    await flush();
    expect(changes()).toBe(afterRepeat);
    expect(manager.get(id)?.state).toBe(state);

    // …a wiadomość, która NIESIE nowość (tryb panelu), rozgłasza się normalnie.
    supervisor.driver('w9:p72').queue.push({
      type: 'agent-state', state: 'idle', seen: true, mode: 'bypass',
    });
    await flush();
    expect(changes()).toBeGreaterThan(afterRepeat);
    expect(manager.get(id)?.herdrMode).toBe('bypass');
  });

  // -------------------------------------------------------------------------
  // Tożsamość i lista ukrytych
  // -------------------------------------------------------------------------

  it('ten sam panel dostaje ten sam sessionId po restarcie managera', async () => {
    const first = await withOneAgent();
    const idBefore = first.id;
    await first.manager.dispose();

    const supervisor = makeSupervisor();
    const manager = await build(supervisor, makeDeps());
    supervisor.appear(makeAgent());
    await flush();

    expect(manager.list().find((s) => s.paneId !== undefined)?.id).toBe(idBefore);
  });

  it('close() BEZ closePanel zdejmuje kartę bez dotykania panelu; żywy panel wraca resynciem',
    async () => {
      // Removing a card is not persistent: a live panel comes back on the next resync. The UI uses this path only
      // for `resumable` sessions (without a live panel).
      const { manager, supervisor, id } = await withOneAgent(makeAgent(), makeDeps());
      const events = record(manager);

      await manager.close(id);

      // 1. Do panelu nie poszło NIC — zdjęcie karty nie ma prawa dotknąć cudzego terminala.
      expect(supervisor.log.calls).toEqual([]);
      // 2. Klient dostaje `done` (protokół nie zna zdarzenia „sesja usunięta").
      const state = events.filter((e) => e.event.type === 'state').at(-1);
      expect(state?.event).toMatchObject({ state: 'done' });
      expect(manager.get(id)).toBeUndefined();
      // 2b. …ORAZ świeży `sessions-snapshot` bez tej sesji: bez niego karta
      //     i pigułka siostry stały na ekranie aż do najbliższego reconnectu SSE.
      const snapshot = events
        .filter((e) => e.scope === 'global' && e.event.type === 'sessions-snapshot')
        .at(-1);
      expect(snapshot).toBeDefined();
      expect(
        (snapshot?.event as Extract<ServerEvent, { type: 'sessions-snapshot' }>).sessions
          .some((s) => s.id === id),
      ).toBe(false);
      // 3. Żywy panel wraca przy resyncu — z TĄ SAMĄ tożsamością karty.
      supervisor.appear(makeAgent());
      await flush();
      expect(manager.list().find((s) => s.paneId !== undefined)?.id).toBe(id);
    });

  it('gone (panel zamknięty w terminalu) domyka kartę, ale JEJ NIE KASUJE', async () => {
    const { manager, supervisor, id } = await withOneAgent();
    supervisor.emit({ type: 'gone', key: 'w9:p72' });
    await flush();

    /*
     * Karta zostaje, bo to ona trzyma `engineSessionId` — czyli jedyną drogę powrotu do tej
     * rozmowy z telefonu (`POST /api/sessions/:id/resume`). Karta znikająca w chwili
     * zamknięcia panelu zabierałaby tę drogę ze sobą.
     */
    expect(manager.get(id)?.state).toBe('done');
    expect(manager.get(id)?.stateDetail).toBe('the pane disappeared from herdr');
  });

  // -------------------------------------------------------------------------
  // Blokada podwójnego pisarza
  // -------------------------------------------------------------------------

  it('wznowienie sesji żywej w herdr to 409, a `resumable()` oznacza ją liveInHerdr',
    async () => {
      const supervisor = makeSupervisor();
      // Magazyn CLI podstawiony: te testy nie dotykają `~/.claude` ani dysku użytkownika.
      const manager = await build(supervisor, makeDeps(), {
        resumableReader: async () => [
          {
            engineSessionId: ENGINE_SESSION, cwd: PROJECT, mtime: '2026-08-22T10:00:00.000Z',
            firstPrompt: 'napraw zapis notatki', liveInHerdr: false,
          },
          {
            engineSessionId: 'inna', cwd: PROJECT, mtime: '2026-08-21T10:00:00.000Z',
            firstPrompt: 'stara sesja', liveInHerdr: false,
          },
        ],
      });
      supervisor.appear(makeAgent());
      await flush();

      // Blokada podwójnego pisarza liczy się z `agent.list`, a nie z indeksu w RAM.
      supervisor.liveEngines = new Set([ENGINE_SESSION]);
      await expect(manager.create({ cwd: PROJECT, resumeFrom: ENGINE_SESSION }))
        .rejects.toBeInstanceOf(BadStateError);
      expect(supervisor.launches).toHaveLength(0);

      const entries = await manager.resumable(PROJECT);
      expect(entries.find((e) => e.engineSessionId === ENGINE_SESSION)?.liveInHerdr).toBe(true);
      expect(entries.find((e) => e.engineSessionId === 'inna')?.liveInHerdr).toBe(false);
    });

  it('resume() sesji herdr to 409 z komunikatem dla człowieka', async () => {
    const { manager, id } = await withOneAgent();
    await expect(manager.resume(id)).rejects.toThrow(HERDR_RESUME_MESSAGE.text);
  });

  it('setModel() sesji herdr to 400', async () => {
    const { manager, id } = await withOneAgent();
    await expect(manager.setModel(id, { model: 'claude-fable-5' }))
      .rejects.toThrow(HERDR_MODEL_MESSAGE.text);
  });

  // -------------------------------------------------------------------------
  // Stan agenta, `seen`, blokada w terminalu
  // -------------------------------------------------------------------------

  it('agent-blocked daje waiting-permission BEZ wpisu w pendingPermissions', async () => {
    const { manager, supervisor, id } = await withOneAgent();
    supervisor.driver('w9:p72').queue.push({ type: 'agent-state', state: 'blocked' });
    await flush();

    expect(manager.get(id)?.state).toBe('waiting-permission');
    // Rarog wie, że dialog stoi, ale nie zna jego treści — UI rysuje chip i „Odrzuć (Esc)",
    // a nie karty zgody. Pusta tablica jest tu KONTRAKTEM, nie przeoczeniem.
    expect(manager.transcript(id).pendingPermissions).toEqual([]);
  });

  it('dialog po ponowieniu z `error` przestawia stan i budzi kanał powiadomień', async () => {
    /*
     * A turn failed (`error`), the user retried it at the desk and the agent stopped on a consent dialog: the session
     * must leave `error`, or the header chip and the push stay silent over a standing dialog. `blocked` is a screen
     * observation, so it may override `error` (unlike `idle`, which still does not touch it).
     */
    const notes: NoteInput[] = [];
    const notifier: NotifierLike = {
      note: (input) => { notes.push(input); },
      seen: () => undefined,
      forget: () => undefined, quiet: () => undefined,
    };
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, makeDeps(), { notifier });
    supervisor.appear(makeAgent());
    await flush();
    const id = manager.list().find((s) => s.paneId !== undefined)?.id ?? '';
    const driver = supervisor.driver('w9:p72');

    driver.queue.push({ type: 'agent-state', state: 'working' });
    driver.queue.push({ type: 'result', subtype: 'error' });
    await flush();
    expect(manager.get(id)?.state).toBe('error');
    // Samo `idle` NIE kasuje błędu — ta asymetria zostaje (komentarz przy `AGENT_IDLE_FROM`).
    driver.queue.push({ type: 'agent-state', state: 'idle', seen: true });
    await flush();
    expect(manager.get(id)?.state).toBe('error');

    driver.queue.push({ type: 'agent-state', state: 'blocked' });
    await flush();
    expect(manager.get(id)?.state).toBe('waiting-permission');
    // Kanał powiadomień dostaje DOKŁADNIE to przejście — polityka zrobi z niego push „zgoda".
    expect(notes.map((n) => n.event.type)).toContain('agent-blocked');
    expect(notes.filter((n) => n.event.type === 'agent-blocked').map((n) => n.sessionId))
      .toEqual([id]);
  });

  it('`model-set` po przyjętym `/model`/`/effort` aktualizuje pigułkę od razu', async () => {
    // Komendy lokalne CLI nie zostawiają w jsonl wpisu asystenta, więc bez tego zdarzenia
    // pigułka pokazywała starą wartość (albo „model?") aż do następnej tury.
    const { manager, supervisor, id } = await withOneAgent();
    supervisor.driver('w9:p72').queue.push({ type: 'model-set', model: 'opus[1m]' });
    supervisor.driver('w9:p72').queue.push({ type: 'model-set', effort: 'high' });
    await flush();

    expect(manager.get(id)?.model).toBe('opus[1m]');
    expect(manager.get(id)?.effort).toBe('high');

    // `init` z meta jsonl pozostaje źródłem prawdy: rozwiązany identyfikator nadpisuje alias.
    supervisor.driver('w9:p72').queue.push({
      type: 'init', engineSessionId: ENGINE_SESSION, model: 'claude-opus-5',
    });
    await flush();
    expect(manager.get(id)?.model).toBe('claude-opus-5');
  });

  /*
   * `init` outside `starting` does not change the state, so the card refresh cannot hang on a MODEL change alone:
   * a panel where only the effort level changed (same resolved identifier) would keep the pill on the old value until
   * the next state transition.
   */
  it('`init` ze zmianą samego effortu odświeża kartę', async () => {
    const { manager, supervisor, id } = await withOneAgent();
    supervisor.driver('w9:p72').queue.push({
      type: 'init', engineSessionId: ENGINE_SESSION, model: 'claude-opus-5', effort: 'high',
    });
    await flush();
    expect(manager.get(id)?.effort).toBe('high');

    const events = record(manager);
    supervisor.driver('w9:p72').queue.push({
      type: 'init', engineSessionId: ENGINE_SESSION, model: 'claude-opus-5', effort: 'xhigh',
    });
    await flush();

    expect(manager.get(id)?.effort).toBe('xhigh');
    const changed = events.filter((e) => e.scope === 'global' && e.event.type === 'session-changed');
    expect(changed).toHaveLength(1);
  });

  it('`init` powtarzający ZNANY effort nie generuje ruchu', async () => {
    const { manager, supervisor, id } = await withOneAgent();
    supervisor.driver('w9:p72').queue.push({
      type: 'init', engineSessionId: ENGINE_SESSION, model: 'claude-opus-5', effort: 'xhigh',
    });
    await flush();

    const events = record(manager);
    supervisor.driver('w9:p72').queue.push({
      type: 'init', engineSessionId: ENGINE_SESSION, model: 'claude-opus-5', effort: 'xhigh',
    });
    await flush();

    expect(manager.get(id)?.effort).toBe('xhigh');
    expect(events.filter((e) => e.event.type === 'session-changed')).toHaveLength(0);
  });

  /*
   * Ultracode czyta się jak effort: znacznik z jsonl nadpisuje kartę, `init` bez pola niczego nie zmienia,
   * zmiana samego ultracode odświeża kartę, a powtórzenie znanej wartości nie robi ruchu.
   */
  it('`init` z ultracode nadpisuje kartę i ją odświeża; bez pola i z tą samą wartością — bez ruchu', async () => {
    const { manager, supervisor, id } = await withOneAgent();
    expect(manager.get(id)?.ultracode).toBeUndefined();
    const init = (ultracode?: boolean): DriverEvent => ({
      type: 'init', engineSessionId: ENGINE_SESSION, model: 'claude-opus-5', effort: 'xhigh',
      ...(ultracode === undefined ? {} : { ultracode }),
    });
    supervisor.driver('w9:p72').queue.push(init());
    await flush();
    expect(manager.get(id)?.ultracode).toBeUndefined();
    expect('ultracode' in (manager.get(id) ?? {})).toBe(false);

    let events = record(manager);
    supervisor.driver('w9:p72').queue.push(init(true));
    await flush();
    expect(manager.get(id)?.ultracode).toBe(true);
    expect(events.filter((e) => e.scope === 'global' && e.event.type === 'session-changed')).toHaveLength(1);

    events = record(manager);
    supervisor.driver('w9:p72').queue.push(init(true));
    supervisor.driver('w9:p72').queue.push(init());
    await flush();
    expect(manager.get(id)?.ultracode).toBe(true);
    expect(events.filter((e) => e.event.type === 'session-changed')).toHaveLength(0);

    supervisor.driver('w9:p72').queue.push(init(false));
    await flush();
    expect(manager.get(id)?.ultracode).toBe(false);
  });

  it('`model-set` z ultracode aktualizuje kartę od razu, bez ruszania modelu i effortu', async () => {
    const { manager, supervisor, id } = await withOneAgent();
    supervisor.driver('w9:p72').queue.push({ type: 'model-set', effort: 'high' });
    await flush();
    const before = manager.get(id);

    const events = record(manager);
    supervisor.driver('w9:p72').queue.push({ type: 'model-set', ultracode: true });
    await flush();
    expect(manager.get(id)?.ultracode).toBe(true);
    expect(manager.get(id)?.effort).toBe('high');
    expect(manager.get(id)?.model).toBe(before?.model);
    expect(events.filter((e) => e.scope === 'global' && e.event.type === 'session-changed')).toHaveLength(1);

    supervisor.driver('w9:p72').queue.push({ type: 'model-set', ultracode: false });
    await flush();
    expect(manager.get(id)?.ultracode).toBe(false);
  });

  it('zmiana trybu uprawnień panelu dociera do karty', async () => {
    const { manager, supervisor, id } = await withOneAgent();
    expect(manager.get(id)?.herdrMode).toBe('auto');
    supervisor.driver('w9:p72').queue.push({
      type: 'agent-state', state: 'idle', mode: 'bypass', seen: true,
    });
    await flush();
    expect(manager.get(id)?.herdrMode).toBe('bypass');
  });

  it('mapowanie statusu startowego: unknown nie udaje, że agent skończył', () => {
    expect(herdrInitialState('working')).toMatchObject({ state: 'running' });
    expect(herdrInitialState('idle')).toMatchObject({ state: 'waiting-input', seen: true });
    expect(herdrInitialState('done')).toMatchObject({ state: 'waiting-input', seen: false });
    expect(herdrInitialState('blocked')).toMatchObject({ state: 'waiting-permission' });
    expect(herdrInitialState('unknown').state).toBe('starting');
    expect(herdrInitialState('unknown').seen).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Historia przy podpięciu
  // -------------------------------------------------------------------------

  it('porcja historii to JEDEN session-changed i ZERO pytań do gita', async () => {
    const run = vi.fn(async () => ({ ok: true, stdout: '# branch.head main\n' }));
    const supervisor = makeSupervisor();
    supervisor.autoSettle = false;
    const manager = await build(supervisor, makeDeps(), {
      gitStatus: new GitStatusWatcher({ run, throttleMs: 0, now: () => 0 }),
    });
    supervisor.appear(makeAgent());
    await flush();
    const id = manager.list()[0]?.id ?? '';
    /*
     * Pojawienie się karty pyta gita RAZ — to zasiew wiersza projektu w sidebarze
     * (osobny test niżej). Ten test pilnuje czego innego: że HISTORIA nie
     * dokłada ani jednego pytania, więc liczymy PRZYROST, a nie wartość bezwzględną.
     */
    const afterAppear = run.mock.calls.length;
    expect(afterAppear).toBe(1);

    const events = record(manager);
    supervisor.driver('w9:p72').queue.push({
      type: 'history',
      messages: Array.from({ length: 60 }, (_v, i) => ({
        role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
        // Blok narzędzia w historii NIE MOŻE odpalić gita: to jest praca sprzed godzin.
        blocks: [{ type: 'tool-call' as const, toolName: 'Bash', summary: 'ls' }],
        at: new Date(1_700_000_000_000 + i * 1_000).toISOString(),
      })),
    });
    await flush();

    // SAMA porcja historii gita nie pyta — asercja stoi PRZED `transcript()`, bo otwarcie
    // transkryptu celowo wymusza odświeżenie gita (ktoś właśnie patrzy).
    expect(run).toHaveBeenCalledTimes(afterAppear);
    expect(manager.transcript(id).messages.length).toBeGreaterThan(0);
    // Liczy się strumień GLOBALNY: to on jedzie do każdego otwartego telefonu, a 17 paneli
    // po 60 wiadomości znaczyłoby ponad tysiąc ramek w pierwszych sekundach po starcie.
    const global = events.filter((e) => e.scope === 'global');
    expect(global.filter((e) => e.event.type === 'session-changed')).toHaveLength(1);
    expect(global.filter((e) => e.event.type === 'message')).toHaveLength(0);
    /*
     * The activity timestamp comes from the file, not from the attach time: otherwise after a Rarog restart a dozen
     * panels share one timestamp, the phone shows the SERVER's age instead of the session's, and idle sessions sort
     * by attach order.
     */
    const at = manager.get(id)?.lastActivityAt ?? '';
    expect(at).toBe(new Date(1_700_000_000_000 + 59 * 1_000).toISOString());
    /*
     * …and the same holds for the state timestamp. `stateSince` is set when the panel is adopted, i.e. "since Rarog
     * knows"; after a server restart the card and the header would count from zero although the file shows the agent
     * has been in this state for long. It goes back to the last sign of life in the file.
     */
    expect(manager.get(id)?.stateSince).toBe(at);
  });

  // -------------------------------------------------------------------------
  // Wysyłka: guard, throttle, uploady — WSZYSTKO przed zmianą stanu
  // -------------------------------------------------------------------------

  it('slash-komenda z deny-listy to 400 i ZERO wywołań prompt', async () => {
    const { manager, supervisor, id } = await withOneAgent();
    await expect(Promise.resolve(manager.sendMessage(id, '/hooks add')))
      .rejects.toBeInstanceOf(BadRequestError);

    expect(supervisor.log.of('send')).toEqual([]);
    // Odrzucona wiadomość nie zostawia po sobie ani wpisu w transkrypcie, ani `running`.
    expect(manager.transcript(id).messages).toEqual([]);
    expect(manager.get(id)?.state).toBe('waiting-input');
  });

  it('a second prompt in the same second goes to the pane in order, without a 429', async () => {
    const deps = makeDeps();
    const { manager, supervisor, id } = await withOneAgent(makeAgent(), deps);

    await manager.sendMessage(id, 'pierwsza');
    await manager.sendMessage(id, 'druga');
    expect(supervisor.log.of('send')).toEqual(['pierwsza', 'druga']);
  });

  it('an exhausted throttle refuses a prompt with 429 and sends nothing', async () => {
    const deps = makeDeps();
    const { manager, supervisor, id } = await withOneAgent(makeAgent(), deps);

    deps.refuseSlots(true);
    await expect(Promise.resolve(manager.sendMessage(id, 'pierwsza')))
      .rejects.toBeInstanceOf(TooManyRequestsError);
    expect(supervisor.log.of('send')).toEqual([]);
  });

  it('zdjęcia lądują na dysku, a do panelu idzie tekst ze ŚCIEŻKAMI', async () => {
    const deps = makeDeps();
    const { manager, supervisor, id } = await withOneAgent(makeAgent(), deps);

    await manager.sendMessage(id, 'zobacz ten zrzut', [PNG]);

    expect(deps.uploaded).toEqual([{ cwd: PROJECT, count: 1 }]);
    const prompt = supervisor.log.of('send')[0] ?? '';
    expect(prompt).toContain('zobacz ten zrzut');
    expect(prompt).toContain(`${PROJECT}/.rarog-uploads/`);
    /*
     * Ścieżka NIGDY nie zaczyna linii — to nie jest kosmetyka formatu, tylko warunek wysłania.
     * TUI `claude` zamienia ścieżkę pliku graficznego w załącznik `[Image #N]`, a gdy ścieżka
     * stoi w linii sama, prompt zostaje w polu wejściowym panelu NIEWYSŁANY (Rarog raportował wtedy „wysłano",
     * a zdjęcie nigdzie nie dotarło). Na CLI 2.1.302 zawisania nie ma, a format działa na obu.
     * Ten test stoi tutaj, bo to MANAGER skleja tekst dla sesji herdr, nie driver.
     */
    expect(prompt.split('\n').some((line) => line.trimStart().startsWith(PROJECT))).toBe(false);
    // W transkrypcie użytkownik widzi swoje zdanie i WIZYTÓWKĘ zdjęcia — nigdy jego bajtów
    // ani ścieżki na Macu (`docs/security-model.md`, „herdr sessions”, reguła 12). Wizytówka niesie
    // NAZWĘ pliku (sam `basename`), po której PWA prosi serwer o miniaturę.
    const echo = manager.transcript(id).messages[0];
    const blocks = echo?.blocks ?? [];
    expect(echo?.attachments).toEqual([
      { kind: 'image', name: '', bytes: dataUrlBytes(PNG), mime: 'image/png', file: '1700000000-abc0.png' },
    ]);
    expect(JSON.stringify(echo?.attachments)).not.toContain(PROJECT);
    expect(blocks.some((b) => b.type === 'image')).toBe(false);
    expect(blocks.some((b) => b.type === 'text' && b.text.includes('.rarog-uploads'))).toBe(false);
    expect(JSON.stringify(echo)).not.toContain(';base64,');
    expect(JSON.stringify(echo)).not.toContain('.rarog-uploads');
  });

  it('samo zdjęcie bez tekstu idzie do panelu ze stałym tekstem, echo bez tekstu', async () => {
    /*
     * Prawdziwa bramka, bo to ona odrzuca pusty tekst, a manager dokleja ścieżki przed nią (inaczej
     * apka dostawałaby 400 „Pusta wiadomość”). Stały tekst `(załącznik)` jest dla echa followera
     * (`uploads.ts`, komentarz do `appendAttachmentPaths`); dymek z wysyłki go nie pokazuje.
     */
    const deps = makeDeps();
    deps.assertSendable = assertSendable;
    const { manager, supervisor, id } = await withOneAgent(makeAgent(), deps);

    await expect(Promise.resolve(manager.sendMessage(id, '  \n'))).rejects.toThrow(/The message is empty/);
    expect(supervisor.log.of('send')).toEqual([]);

    await manager.sendMessage(id, '  \n', [PNG]);
    expect(supervisor.log.of('send')).toEqual([`(załącznik) ${PROJECT}/.rarog-uploads/1700000000-abc0.png`]);
    const echo = manager.transcript(id).messages[0];
    expect(echo?.blocks).toEqual([]);
    expect(echo?.attachments?.map((a) => a.file)).toEqual(['1700000000-abc0.png']);
  });

  it('pliki lądują na dysku tą samą drogą co zdjęcia, w JEDNYM bloku ścieżek', async () => {
    const deps = makeDeps();
    const { manager, supervisor, id } = await withOneAgent(makeAgent(), deps);

    await manager.sendMessage(id, 'przejrzyj', [PNG], [{ name: 'build.log', dataUrl: PDF }]);

    expect(deps.uploaded).toEqual([{ cwd: PROJECT, count: 1 }]);
    expect(deps.uploadedFiles).toEqual([{ cwd: PROJECT, names: ['build.log'] }]);
    const prompt = supervisor.log.of('send')[0] ?? '';
    // Zdjęcia przed plikami i wszystko w ostatniej linii — ta sama reguła, co przy samych zdjęciach.
    expect(prompt.startsWith('przejrzyj ')).toBe(true);
    expect(prompt.includes('\n')).toBe(false);
    expect(prompt.indexOf('.png')).toBeLessThan(prompt.indexOf('build.log'));
  });

  it('nieudany zapis pliku to wyjątek na POST, a NIE wysyłka samego tekstu', async () => {
    const deps = makeDeps();
    // Prawdziwy tryb awarii: dysk pełny albo katalog bez praw. Cicha wysyłka „przejrzyj ten log"
    // bez logu jest gorsza od braku wysyłki — agent odpowiedziałby na pytanie bez materiału.
    const failing = {
      ...deps,
      writeUploadFiles: () => Promise.reject(new BadRequestError(say('uploads.write-failed', { path: 'a.log', reason: 'ENOSPC' }))),
    };
    const { manager, supervisor, id } = await withOneAgent(makeAgent(), failing);

    await expect(Promise.resolve(
      manager.sendMessage(id, 'przejrzyj', undefined, [{ name: 'a.log', dataUrl: PDF }]),
    )).rejects.toBeInstanceOf(BadRequestError);
    expect(supervisor.log.calls).toEqual([]);
    expect(manager.transcript(id).messages).toEqual([]);
  });

  it('echo wiadomości z plikiem NIE ma bloku pliku (podpis pozostaje „tekst + zdjęcia")', async () => {
    /*
     * Kontrakt z klientem: podpis wysyłki liczy TEKST i LICZBĘ OBRAZKÓW,
     * bo tylko te dwie rzeczy serwer odbija w echu. Gdyby echo dostało blok pliku (albo gdyby
     * klient doliczył pliki do podpisu jednostronnie), wpis optymistyczny nie miałby czym się
     * pogodzić i każda wiadomość z załącznikiem wisiałaby jako „Nie potwierdzono".
     */
    const deps = makeDeps();
    const { manager, id } = await withOneAgent(makeAgent(), deps);

    await manager.sendMessage(id, 'przejrzyj', undefined, [{ name: 'a.log', dataUrl: PDF }]);

    const blocks = manager.transcript(id).messages[0]?.blocks ?? [];
    expect(blocks).toEqual([{ type: 'text', text: 'przejrzyj' }]);
  });

  it('panel poza zasięgiem pokazuje się na liście, ale nie przyjmuje wysyłki', async () => {
    const { manager, supervisor, id } = await withOneAgent(
      makeAgent({ inScope: false, cwd: '/Users/u/Prywatne/birch' }),
    );
    expect(manager.get(id)?.outOfScope).toBe(true);
    await expect(Promise.resolve(manager.sendMessage(id, 'cokolwiek')))
      .rejects.toBeInstanceOf(BadRequestError);
    expect(supervisor.log.calls).toEqual([]);
  });

  it('panel poza zasięgiem odmawia też przerwania i odrzucenia dialogu', async () => {
    /*
     * Odmowa musi paść w MANAGERZE, nie w driverze: driver rzuca `HerdrOutOfScopeError`,
     * którego `managerErrorStatus` nie zna, więc telefon dostawał na to 500 („Błąd serwera.")
     * zamiast zdania mówiącego, dlaczego Rarog nie dotyka tego panelu.
     */
    const { manager, supervisor, id } = await withOneAgent(
      makeAgent({ inScope: false, cwd: '/Users/u/Prywatne/birch' }),
    );
    expect(() => { manager.interrupt(id); }).toThrow(BadRequestError);
    // Dialog spoza jsonl adresuje się SAMĄ SESJĄ (`POST /api/sessions/:id/permission`).
    await expect(manager.resolvePermission(id, id, 'deny', 'iPhone'))
      .rejects.toThrow(BadRequestError);
    expect(supervisor.log.calls).toEqual([]);
  });

  /*
   * Diff roboczy to TREŚĆ katalogu. Bez bramki zasięgu przy `diff`
   * panel spoza korzeni bez transkryptu i linii gita oddawałby katalog przez `GET …/diff`.
   */
  it('panel poza zasięgiem nie oddaje diffa katalogu: 400, git nie rusza', async () => {
    const calls: string[][] = [];
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, makeDeps(), {
      diffRunner: (command) => { calls.push([command.sub, ...command.rest]); return Promise.resolve({ ok: true, stdout: '' }); },
    });
    supervisor.appear(makeAgent({ inScope: false, cwd: '/Users/u/Prywatne/birch' }));
    await flush();
    const id = manager.list()[0]?.id ?? '';
    expect(manager.get(id)?.outOfScope).toBe(true);

    await expect(manager.diff(id)).rejects.toThrow(HERDR_OUT_OF_SCOPE_DIFF_MESSAGE.text);
    await expect(manager.diff(id)).rejects.toBeInstanceOf(BadRequestError);
    expect(calls).toEqual([]);

    /*
     * `cd` pod korzeń: nadzorca melduje ten sam panel z nowym katalogiem i zasięgiem, a sesja
     * trzyma katalog z chwili pojawienia się. Bramka ma pytać o katalog, z którego pójdzie odczyt
     * (inaczej `outOfScope` gaśnie, a diff dalej czyta prywatny katalog).
     */
    supervisor.reattach(makeAgent({ inScope: true, cwd: PROJECT }));
    await flush();
    expect(manager.get(id)?.outOfScope).not.toBe(true);
    expect(manager.get(id)?.cwd).toBe('/Users/u/Prywatne/birch');
    await expect(manager.diff(id)).rejects.toThrow(HERDR_OUT_OF_SCOPE_DIFF_MESSAGE.text);
    expect(calls).toEqual([]);
  });

  it('panel w zasięgu dostaje diff swojego katalogu', async () => {
    const calls: string[] = [];
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, makeDeps(), {
      diffRunner: (_args, cwd) => { calls.push(cwd); return Promise.resolve({ ok: true, stdout: '' }); },
    });
    supervisor.appear(makeAgent());
    await flush();
    const id = manager.list()[0]?.id ?? '';

    expect(await manager.diff(id)).toEqual({ files: [], patch: '', truncated: false });
    expect(new Set(calls)).toEqual(new Set([PROJECT]));
  });

  /*
   * Diff per plik: obie nowe metody stoją za TĄ SAMĄ bramką co `diff` — sesja poza zasięgiem
   * nie dostaje ani listy plików (same nazwy też są treścią katalogu), ani patcha.
   */
  it('panel poza zasięgiem nie oddaje listy zmian ani patcha pliku: 400, git nie rusza', async () => {
    const calls: string[][] = [];
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, makeDeps(), {
      diffRunner: (command) => { calls.push([command.sub, ...command.rest]); return Promise.resolve({ ok: true, stdout: '' }); },
    });
    supervisor.appear(makeAgent({ inScope: false, cwd: '/Users/u/Prywatne/birch' }));
    await flush();
    const id = manager.list()[0]?.id ?? '';

    await expect(manager.diffFiles(id)).rejects.toThrow(HERDR_OUT_OF_SCOPE_DIFF_MESSAGE.text);
    await expect(manager.diffFiles(id)).rejects.toBeInstanceOf(BadRequestError);
    await expect(manager.diffFile(id, 'a.ts')).rejects.toThrow(HERDR_OUT_OF_SCOPE_DIFF_MESSAGE.text);
    // Bramka zasięgu stoi przed walidacją ścieżki: zła ścieżka nie zmienia odpowiedzi.
    await expect(manager.diffFile(id, '../x')).rejects.toBeInstanceOf(BadRequestError);

    // `cd` pod korzeń: zasięg wraca, a sesja dalej trzyma prywatny katalog — odczyt i tak odmawia.
    supervisor.reattach(makeAgent({ inScope: true, cwd: PROJECT }));
    await flush();
    expect(manager.get(id)?.outOfScope).not.toBe(true);
    await expect(manager.diffFiles(id)).rejects.toThrow(HERDR_OUT_OF_SCOPE_DIFF_MESSAGE.text);
    await expect(manager.diffFile(id, 'a.ts')).rejects.toThrow(HERDR_OUT_OF_SCOPE_DIFF_MESSAGE.text);
    expect(calls).toEqual([]);
  });

  it('panel w zasięgu: lista i patch pliku z katalogu SESJI, a log niesie czas bez ścieżki', async () => {
    const calls: { args: string[]; cwd: string }[] = [];
    const lines: string[] = [];
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, makeDeps(), {
      logger: (line) => { lines.push(line); },
      diffRunner: (command, cwd) => {
        const args = [command.sub, ...command.rest];
        calls.push({ args, cwd });
        if (args.includes('--name-status')) {
          return Promise.resolve({ ok: true, stdout: 'M\0src/tajna-nazwa.ts\0', exitCode: 0 });
        }
        if (args.includes('--numstat')) {
          return Promise.resolve({ ok: true, stdout: '3\t1\tsrc/tajna-nazwa.ts\0', exitCode: 0 });
        }
        if (command.sub === 'ls-files') return Promise.resolve({ ok: true, stdout: '', exitCode: 0 });
        return Promise.resolve({ ok: true, stdout: 'diff --git a/src/tajna-nazwa.ts b/src/tajna-nazwa.ts\n', exitCode: 0 });
      },
    });
    supervisor.appear(makeAgent());
    await flush();
    const id = manager.list()[0]?.id ?? '';

    expect(await manager.diffFiles(id)).toEqual({
      files: [{ path: 'src/tajna-nazwa.ts', status: 'M', linesAdded: 3, linesDeleted: 1 }], truncated: false,
    });
    expect(await manager.diffFile(id, 'src/tajna-nazwa.ts')).toEqual({
      path: 'src/tajna-nazwa.ts', patch: 'diff --git a/src/tajna-nazwa.ts b/src/tajna-nazwa.ts\n', truncated: false,
    });
    await expect(manager.diffFile(id, 'src/inna-tajna.ts')).rejects.toMatchObject({ code: 'diff-file-not-found' });
    await expect(manager.diffFile(id, '../poza/tajna.ts')).rejects.toMatchObject({ code: 'bad-path' });
    expect(new Set(calls.map((call) => call.cwd))).toEqual(new Set([PROJECT]));
    // Zła ścieżka nie uruchamia gita: 3 procesy listy, 3 patcha, 2 walidacji przy 404.
    expect(calls).toHaveLength(8);

    const diffLines = lines.filter((line) => line.startsWith('git: diff '));
    expect(diffLines.map((line) => line.replace(/\d+ ms/, 'N ms'))).toEqual([
      `${GIT_DIFF_LIST_LOG} N ms`, `${GIT_DIFF_FILE_LOG} N ms`, `${GIT_DIFF_FILE_LOG} N ms (diff-file-not-found)`,
    ]);
    for (const line of diffLines) expect(line).not.toMatch(/tajna|src\/|\.ts/);
  });

  it('awaria gita na nowych trasach to błąd z kodem `git-failed`, nie pusta lista', async () => {
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, makeDeps(), {
      diffRunner: () => Promise.resolve({ ok: false, stdout: '', timedOut: true }),
    });
    supervisor.appear(makeAgent());
    await flush();
    const id = manager.list()[0]?.id ?? '';

    await expect(manager.diffFiles(id)).rejects.toMatchObject({ code: 'git-failed' });
    await expect(manager.diffFile(id, 'a.ts')).rejects.toMatchObject({ code: 'git-failed' });
    // Stara trasa zostaje przy swoim zachowaniu: git bez odpowiedzi to pusty diff.
    expect(await manager.diff(id)).toEqual({ files: [], patch: '', truncated: false });
  });

  it('RAROG_HERDR_SEND=0 zostawia podgląd, ale odcina wysyłkę i przerwanie', async () => {
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, makeDeps(), { herdrSend: false });
    supervisor.appear(makeAgent());
    await flush();
    const id = manager.list()[0]?.id ?? '';

    await expect(Promise.resolve(manager.sendMessage(id, 'cokolwiek')))
      .rejects.toBeInstanceOf(BadRequestError);
    expect(() => { manager.interrupt(id); }).toThrow(BadRequestError);
    expect(supervisor.log.calls).toEqual([]);
    // Podgląd działa dalej — to jest cały sens tego przełącznika.
    expect(manager.get(id)?.paneId).toBe('w9:p72');
  });

  /*
   * A card WITHOUT a panel must not answer `delivered: 'no'` in a 202 body: the phone reads `'no'` as "the panel did
   * not take Esc" and sends the user to herdr on the Mac for a panel that is not there. The refusal is a GATE (4xx)
   * with a server sentence, and the state must not report "interrupted" when there was nothing to interrupt.
   */
  it('przerwanie sesji BEZ panelu to odmowa bramką, nie ciche „nie dostarczono"', async () => {
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, makeDeps());
    supervisor.appear(makeAgent());
    await flush();
    const id = manager.list()[0]?.id ?? '';

    // Panel znika z herdr — driver zostaje odpięty, karta zostaje na liście.
    supervisor.emit({ type: 'gone', key: 'w9:p72' });
    await flush();
    const stateBezPanelu = manager.get(id)?.state;
    // Karta MUSI tu żyć — inaczej porównania niżej byłyby `undefined` z `undefined`.
    expect(stateBezPanelu).toBe('done');

    expect(() => { manager.interrupt(id); }).toThrow(HERDR_NO_DRIVER_INTERRUPT_MESSAGE.text);
    // Ani jednego klawisza i ani jednego przejścia stanu: odmowa nie melduje „przerwana".
    expect(supervisor.log.sterowanie()).toEqual([]);
    expect(manager.get(id)?.state).toBe(stateBezPanelu);
    expect(manager.get(id)?.stateDetail).not.toBe(INTERRUPT_DETAIL.text);
  });

  // -------------------------------------------------------------------------
  // Decyzje: tylko odrzucenie
  // -------------------------------------------------------------------------

  it('odrzucenie dialogu wysyła escape, a próba zatwierdzenia to 409', async () => {
    const { manager, supervisor, id } = await withOneAgent();
    supervisor.driver('w9:p72').queue.push({ type: 'agent-state', state: 'blocked' });
    await flush();

    await expect(manager.resolvePermission(id, id, 'allow', 'iPhone'))
      .rejects.toThrow(HERDR_ALLOW_MESSAGE.text);
    expect(supervisor.log.calls).toEqual([]);

    await expect(manager.resolvePermission(id, id, 'deny', 'iPhone'))
      .resolves.toEqual({ outcome: 'ok' });
    expect(supervisor.log.sterowanie()).toEqual(['respondPermission:deny']);
  });

  it('interrupt sesji herdr to dokładnie jeden escape', async () => {
    const { manager, supervisor, id } = await withOneAgent();
    manager.interrupt(id);
    expect(supervisor.log.sterowanie()).toEqual(['interrupt']);
  });

  it('spóźniony `working` tuż po przerwaniu NIE wskrzesza „pracuje" (karencja)', async () => {
    /*
     * Esc half a second after sending can kill the turn before herdr detects it: herdr's `working` push then arrives
     * AFTER the move to `waiting-input` and would stay for good, because a killed turn produces no further push.
     */
    const { manager, supervisor, id } = await withOneAgent();
    const driver = supervisor.driver('w9:p72');
    driver.queue.push({ type: 'agent-state', state: 'working' });
    await flush();
    expect(manager.get(id)?.state).toBe('running');

    manager.interrupt(id);
    expect(manager.get(id)?.state).toBe('waiting-input');

    driver.queue.push({ type: 'agent-state', state: 'working' });
    await flush();
    expect(manager.get(id)?.state).toBe('waiting-input');

    // Prawdziwa nowa tura wchodzi normalnie: wysyłka ustawia `running` optymistycznie,
    // więc karencja (działająca tylko przy `waiting-input`) jej nie dotyka.
    await manager.sendMessage(id, 'nowa tura po przerwaniu');
    expect(manager.get(id)?.state).toBe('running');
  });

  // -------------------------------------------------------------------------
  // Idempotencja przerwania: dwa rozłączne okna, dwa własne pola
  // -------------------------------------------------------------------------

  /** Sesja herdr ze STEROWANYM zegarem managera — okna przerwania mierzą się w ms, nie w snach. */
  async function withClock(deps: FakeDeps = makeDeps()): Promise<{
    manager: Manager; supervisor: FakeSupervisor; driver: FakeHerdrDriver; id: string;
    advance: (ms: number) => void;
  }> {
    const supervisor = makeSupervisor();
    let now = 1_700_000_000_000;
    const manager = await build(supervisor, deps, { now: () => now });
    supervisor.appear(makeAgent());
    await flush();
    const id = manager.list().find((s) => s.paneId !== undefined)?.id ?? '';
    expect(id).not.toBe('');
    return {
      manager, supervisor, driver: supervisor.driver('w9:p72'), id,
      advance: (ms: number) => { now += ms; },
    };
  }

  it('dwa żądania w tym samym oknie to JEDEN escape (przerwanie w locie)', async () => {
    /*
     * Repeated `interrupt` POSTs (five in 0.8 s when the app showed nothing after Esc): the first `escape` may still be
     * in the driver queue, and another one on an already empty composer opens rewind in Claude Code.
     */
    const { manager, supervisor, driver, id } = await withClock();
    driver.holdInterrupt = true;

    const first = manager.interrupt(id);
    const second = manager.interrupt(id);
    expect(supervisor.log.sterowanie()).toEqual(['interrupt']);

    driver.settleInterrupt(true);
    await expect(first).resolves.toBe(true);
    // Powtórka dostaje TĘ SAMĄ prawdę co pierwsze żądanie: telefon nie ma prawa pokazać
    // błędu nad przerwaniem, które zadziałało.
    await expect(second).resolves.toBe(true);
    expect(supervisor.log.sterowanie()).toEqual(['interrupt']);
  });

  it('powtórka 200 ms po dostarczonym przerwaniu jest no-opem i melduje „dostarczone"',
    async () => {
      const { manager, supervisor, id, advance } = await withClock();
      await expect(manager.interrupt(id)).resolves.toBe(true);
      expect(supervisor.log.sterowanie()).toEqual(['interrupt']);

      advance(200);
      // `true` bez wysyłki nie jest uprzejmością: okno otwiera WYŁĄCZNIE klawisz, który
      // naprawdę poszedł, więc w tej chwili przerwanie faktycznie zostało dostarczone.
      await expect(manager.interrupt(id)).resolves.toBe(true);
      expect(supervisor.log.sterowanie()).toEqual(['interrupt']);
    });

  it('BRAMKA: żądanie 3 s po przerwaniu PRZECHODZI — świadome powtórzenie to nie mashowanie',
    async () => {
      /*
       * Obie liczby są z tego samego dziennika: mash zmieścił cztery tapnięcia w 0,79 s,
       * a pierwsze ŚWIADOME powtórzenie przyszło po 3,7 s. Okno, które zjadłoby i to drugie,
       * zostawia człowieka bez sposobu na przerwanie tury, której pierwszy Esc nie ubił.
       */
      const { manager, supervisor, id, advance } = await withClock();
      await manager.interrupt(id);

      advance(3_000);
      await expect(manager.interrupt(id)).resolves.toBe(true);
      expect(supervisor.log.sterowanie()).toEqual(['interrupt', 'interrupt']);
    });

  it('BRAMKA: Esc w oknie karencji przerywa turę wystartowaną W TERMINALU', async () => {
    /*
     * Dziura z pierwszej wersji planu: bramka idempotencji oparta na `interruptedAtMs`
     * i `waiting-input` byłaby przez 6 s spełniona PRZEZ KONSTRUKCJĘ, bo karencja sama trzyma
     * kartę w `waiting-input`. Przez te 6 s Rarog połykałby przerwania tury, która naprawdę
     * ruszyła — człowiek wystartował ją przy biurku, w panelu, a z telefonu nie miałby jak
     * jej zatrzymać.
     */
    const { manager, supervisor, driver, id, advance } = await withClock();
    await manager.interrupt(id);
    expect(manager.get(id)?.state).toBe('waiting-input');

    // Tura z terminala: herdr melduje `working`, ale karencja trzyma kartę w „czeka".
    driver.queue.push({ type: 'agent-state', state: 'working' });
    await flush();
    expect(manager.get(id)?.state).toBe('waiting-input');

    // Sekundę później — POZA oknem debounce'u, WEWNĄTRZ karencji — Esc musi pójść.
    advance(1_500);
    await expect(manager.interrupt(id)).resolves.toBe(true);
    expect(supervisor.log.sterowanie()).toEqual(['interrupt', 'interrupt']);
  });

  it('nieudany escape NIE otwiera okna debounce’u — druga próba idzie od razu', async () => {
    /*
     * Okno po dostarczeniu ma prawo połknąć żądanie wyłącznie wtedy, gdy klawisz naprawdę
     * poszedł. Inaczej odpowiedź „dostarczone" byłaby kłamstwem, a człowiek przez sekundę
     * nie miałby jak ponowić przerwania, które nie zadziałało.
     */
    const { manager, supervisor, driver, id, advance } = await withClock();
    driver.interruptSent = false;

    await expect(manager.interrupt(id)).resolves.toBe(false);
    advance(200);
    await expect(manager.interrupt(id)).resolves.toBe(false);
    expect(supervisor.log.sterowanie()).toEqual(['interrupt', 'interrupt']);
  });

  it('ponowienie klienta po jego timeoucie dopina się do przerwania w locie, nie wysyła drugiego',
    async () => {
      /*
       * Klient przerywa żądanie po 10 s i ponawia je po 400 ms — czyli
       * ponowienie przychodzi po ~10,4 s, DŁUŻEJ niż trwa okno debounce'u. Ratuje je tu
       * wyłącznie obietnica w locie: pierwszy `escape` wciąż stoi w kolejce drivera i to
       * właśnie dlatego klient nie doczekał się odpowiedzi.
       */
      const { manager, supervisor, driver, id, advance } = await withClock();
      driver.holdInterrupt = true;
      const first = manager.interrupt(id);

      advance(10_400);
      const retry = manager.interrupt(id);
      expect(supervisor.log.sterowanie()).toEqual(['interrupt']);

      driver.settleInterrupt(true);
      await expect(first).resolves.toBe(true);
      await expect(retry).resolves.toBe(true);
      expect(supervisor.log.sterowanie()).toEqual(['interrupt']);
    });

  it('wysyłka zeruje okno „w locie" — Esc PO niej wysyła WŁASNY escape', async () => {
    /*
     * Sekwencja „Esc → wysyłka → Esc" mieści się w oknie A, bo pierwszy `escape` potrafi stać
     * w kolejce sekundami. Bez wyzerowania okna drugie tapnięcie dopięłoby się do TAMTEGO
     * przerwania: żaden nowy klawisz by nie poszedł, wiadomość poleciałaby dalej, a telefon
     * usłyszałby „przerwane" — dokładnie w oknie, w którym nie ma innego wyjścia.
     */
    const { manager, supervisor, driver, id } = await withClock();
    driver.holdInterrupt = true;
    const before = manager.interrupt(id);

    await manager.sendMessage(id, 'jednak co innego');
    expect(supervisor.log.of('send')).toEqual(['jednak co innego']);
    const after = manager.interrupt(id);
    expect(supervisor.log.sterowanie()).toEqual(['interrupt', 'interrupt']);

    driver.settleInterrupt(true);
    driver.settleInterrupt(true);
    await expect(before).resolves.toBe(true);
    await expect(after).resolves.toBe(true);
  });

  it('wysyłka ze zdjęciem gasi karencję NA WEJŚCIU — `working` w trakcie zapisu nie ginie',
    async () => {
      /*
       * `writeUploads` przy zdjęciach to sekundy, a przez cały ten czas karta stoi jeszcze
       * w `waiting-input` ze znacznikiem przerwania. Gdyby znacznik gasł dopiero przy
       * `turn-start`, push `working` z tego okna wpadłby w karencję i zostawił kartę w „czeka"
       * nad panelem, który pracuje.
       */
      const supervisor = makeSupervisor();
      const base = makeDeps();
      let releaseUpload = (): void => {};
      const upload = new Promise<void>((resolve) => { releaseUpload = resolve; });
      const deps: FakeDeps = {
        ...base,
        writeUploads: async (cwd, images) => {
          await upload;
          return base.writeUploads(cwd, images);
        },
      };
      const manager = await build(supervisor, deps);
      supervisor.appear(makeAgent());
      await flush();
      const id = manager.list().find((s) => s.paneId !== undefined)?.id ?? '';
      const driver = supervisor.driver('w9:p72');

      await manager.interrupt(id);
      expect(manager.get(id)?.state).toBe('waiting-input');

      const sending = manager.sendMessage(id, 'zobacz ten zrzut', [PNG]);
      await flush();
      driver.queue.push({ type: 'agent-state', state: 'working' });
      await flush();
      expect(manager.get(id)?.state).toBe('running');

      releaseUpload();
      await sending;
      expect(supervisor.log.of('send')).toHaveLength(1);
    });

  it('prompt bez zdjęcia nie wyprzedza wcześniejszego ze zdjęciem — kolejność slotów = kolejność w panelu',
    async () => {
      // A prompt takes its throttle slot at once, and writing a picture can take longer.
      const supervisor = makeSupervisor();
      const base = makeDeps();
      let releaseUpload = (): void => {};
      const upload = new Promise<void>((resolve) => { releaseUpload = resolve; });
      const deps: FakeDeps = {
        ...base,
        writeUploads: async (cwd, images) => {
          await upload;
          return base.writeUploads(cwd, images);
        },
      };
      const manager = await build(supervisor, deps);
      supervisor.appear(makeAgent());
      await flush();
      const id = manager.list().find((s) => s.paneId !== undefined)?.id ?? '';

      const first = manager.sendMessage(id, 'zobacz ten zrzut', [PNG]);
      await flush();
      base.setNow(1_000);
      const second = manager.sendMessage(id, 'i jeszcze to');
      await flush();
      expect(supervisor.log.of('send')).toEqual([]);

      releaseUpload();
      await Promise.all([first, second]);
      expect(supervisor.log.of('send')).toEqual([expect.stringContaining('zobacz ten zrzut'), 'i jeszcze to']);
      const texts = manager.transcript(id).messages
        .map((m) => m.blocks.find((b) => b.type === 'text'));
      expect(texts).toEqual([
        expect.objectContaining({ text: 'zobacz ten zrzut' }),
        expect.objectContaining({ text: 'i jeszcze to' }),
      ]);
    });

  it('nieudany zapis zdjęcia zwalnia kolejkę wysyłek — następny prompt idzie do panelu', async () => {
    const supervisor = makeSupervisor();
    const base = makeDeps();
    const deps: FakeDeps = {
      ...base,
      writeUploads: () => Promise.reject(new BadRequestError(say('uploads.write-failed', { path: 'zrzut.png', reason: 'EACCES' }))),
    };
    const manager = await build(supervisor, deps);
    supervisor.appear(makeAgent());
    await flush();
    const id = manager.list().find((s) => s.paneId !== undefined)?.id ?? '';

    await expect(manager.sendMessage(id, 'zobacz ten zrzut', [PNG])).rejects.toBeInstanceOf(BadRequestError);
    base.setNow(1_000);
    await manager.sendMessage(id, 'bez zdjęcia');
    expect(supervisor.log.of('send')).toEqual(['bez zdjęcia']);
  });

  it('ODRZUCONA wysyłka nie gasi karencji ani okna debounce’u — nic przecież nie poszło',
    async () => {
      /*
       * Gaszenie znaczników na wejściu jest „na poczet" wysyłki, a bramek, które ją odrzucają,
       * jest w `#sendToHerdr` kilka. Sekwencja: tura pracuje → Esc → prompt wraca do pola →
       * „Wyślij" przy wyczerpanym sufcie throttle'a → 429. Do panelu nie poszło NIC,
       * żadna tura nie ruszyła — a bez przywrócenia znaczników spóźniony push `working`
       * z UBITEJ tury wskrzeszałby spinner na zawsze (awaria, dla której karencja powstała).
       */
      const deps = makeDeps();
      const { manager, supervisor, driver, id, advance } = await withClock(deps);
      await manager.sendMessage(id, 'pierwsza tura');
      deps.refuseSlots(true);
      await expect(manager.interrupt(id)).resolves.toBe(true);
      expect(manager.get(id)?.state).toBe('waiting-input');

      await expect(manager.sendMessage(id, 'oddany prompt'))
        .rejects.toBeInstanceOf(TooManyRequestsError);
      expect(supervisor.log.of('send')).toEqual(['pierwsza tura']);

      // Karencja żyje dalej: `working` z ubitej tury nie ma prawa wrócić w „pracuje".
      driver.queue.push({ type: 'agent-state', state: 'working' });
      await flush();
      expect(manager.get(id)?.state).toBe('waiting-input');

      // Okno debounce'u też: powtórka 200 ms po dostarczonym `escape` nadal jest no-opem.
      advance(200);
      await expect(manager.interrupt(id)).resolves.toBe(true);
      expect(supervisor.log.sterowanie()).toEqual(['interrupt']);
    });

  it('ODRZUCONA wysyłka nie zeruje okna „w locie" — powtórka nie dokłada drugiego escape',
    async () => {
      /*
       * Ta sama odmowa, ale w oknie PRZED dostarczeniem: `escape` stoi jeszcze w kolejce
       * drivera. Wyzerowane okno „w locie" wypuściłoby do panelu drugi klawisz na już pustym
       * composerze — czyli rewind w Claude Code, dokładnie to, przed czym stoi mechanizm A.
       */
      const deps = makeDeps();
      const { manager, supervisor, driver, id } = await withClock(deps);
      await manager.sendMessage(id, 'pierwsza tura');
      deps.refuseSlots(true);
      driver.holdInterrupt = true;
      const first = manager.interrupt(id);

      await expect(manager.sendMessage(id, 'oddany prompt'))
        .rejects.toBeInstanceOf(TooManyRequestsError);

      const second = manager.interrupt(id);
      expect(supervisor.log.sterowanie()).toEqual(['interrupt']);

      driver.settleInterrupt(true);
      await expect(first).resolves.toBe(true);
      await expect(second).resolves.toBe(true);
      expect(supervisor.log.sterowanie()).toEqual(['interrupt']);
    });

  it('wielokrotny wybór w pytaniu agenta jest odrzucany (jedna cyfra = jedna opcja)', async () => {
    const { manager, id } = await withOneAgent();
    await expect(manager.answerQuestion(id, 'q1', [['tak', 'nie']]))
      .rejects.toThrow(BadStateError);
    // Pojedyncza odpowiedź idzie normalną ścieżką: brak wpisu w pending daje `gone`,
    // a nie wyjątek — decyzja mogła zostać podjęta w terminalu chwilę wcześniej.
    await expect(manager.answerQuestion(id, 'q1', [['tak']]))
      .resolves.toEqual({ outcome: 'gone' });
  });

  // -------------------------------------------------------------------------
  // Zakładanie sesji z telefonu — najmłodsza i najgroźniejsza władza Raroga
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Allow-lista slash-komend: jedna klasyfikacja na wysyłkę, migawka per wersja CLI
  // -------------------------------------------------------------------------

  describe('allow-lista slash-komend w managerze', () => {
    /** Prawdziwy strażnik i fabryka katalogu-szpieg: kto pytał, o jaki katalog i wersję. */
    function d109Deps(): { deps: FakeDeps; asked: [string, string | null][]; catalog: CommandCatalog } {
      const asked: [string, string | null][] = [];
      const catalog = registryCatalog();
      const deps = makeDeps();
      deps.assertSendable = assertSendable;
      deps.commandCatalog = (cwd, cliVersion) => { asked.push([cwd, cliVersion]); return catalog; };
      return { deps, asked, catalog };
    }
    const cliVersionReader = (): Promise<CliVersionSnapshot> => Promise.resolve({
      installed: '2.1.302',
      registry: new Map([['11111111-1111-4111-8111-111111111111', [{ pid: 7, version: '2.1.290', status: 'idle' }]]]),
    });

    it('klasyfikuje RAZ i oddaje driverowi tę samą migawkę z wynikiem; wersja z rejestru procesu sesji', async () => {
      const { deps, asked, catalog } = d109Deps();
      const supervisor = makeSupervisor();
      const manager = await build(supervisor, deps, { cliVersionReader });
      supervisor.appear(makeAgent());
      await flush(8);
      const id = manager.list().find((s) => s.paneId !== undefined)?.id ?? '';

      await manager.sendMessage(id, '/compact');
      const opts = supervisor.driver('w9:p72').sendOpts.at(-1);
      expect(opts?.command?.catalog).toBe(catalog);
      expect(opts?.command?.slash).toEqual({ name: 'compact', kind: 'local' });
      expect(asked.at(-1)).toEqual([PROJECT, '2.1.290']);

      deps.setNow(60_000);
      await manager.sendMessage(id, 'zwykłe zdanie');
      expect(supervisor.driver('w9:p72').sendOpts.at(-1)?.command?.slash).toBeNull();
    });

    it('odmowa: 400 z podpowiedzią, driver nic nie dostaje, nadzorca zapisuje sam token', async () => {
      const { deps } = d109Deps();
      const supervisor = makeSupervisor();
      const manager = await build(supervisor, deps);
      supervisor.appear(makeAgent());
      await flush();
      const id = manager.list().find((s) => s.paneId !== undefined)?.id ?? '';

      await expect(manager.sendMessage(id, '/settings theme=dark')).rejects.toThrow(/is an alias of \/config/);
      expect(supervisor.log.of('send')).toEqual([]);
      expect(supervisor.commandRefusals).toEqual([['w9:p72', PROJECT, '/settings']]);
      // Odmowa nie zjada slotu throttle'a ani nie dopisuje wiadomości do transkryptu.
      expect(manager.transcript(id).messages.filter((m) => m.role === 'user')).toEqual([]);
    });

    it('prompt startowy: katalog dla wydania ZAINSTALOWANEGO, klasyfikacja jedzie z `driver.send`', async () => {
      const { deps, asked } = d109Deps();
      const supervisor = makeSupervisor();
      const manager = await build(supervisor, deps, { cliVersionReader });
      await flush(8);
      await manager.create({ cwd: PROJECT, prompt: '/init' });
      expect(asked.at(-1)).toEqual([PROJECT, '2.1.302']);
      supervisor.settleLaunch();
      await flush(8);
      const opts = supervisor.driver('w0:new1').sendOpts.at(-1);
      expect(opts?.command?.slash).toEqual({ name: 'init', kind: 'prompt' });
    });

    it('prompt startowy spoza katalogu: 400 PRZED `launch()` i wpis odmowy bez klucza panelu', async () => {
      const { deps } = d109Deps();
      const supervisor = makeSupervisor();
      const manager = await build(supervisor, deps);
      await expect(manager.create({ cwd: PROJECT, prompt: '/usa' })).rejects.toThrow(/\/usa/);
      expect(supervisor.launches).toEqual([]);
      expect(supervisor.commandRefusals).toEqual([[null, PROJECT, '/usa']]);
    });

    /*
     * Lista dla apki (`GET /api/sessions/:id/commands`): test równości — `commands(id)` używa TEJ
     * SAMEJ migawki co strażnik wysyłki tej sesji (katalog panelu, wersja procesu z rejestru CLI), więc ta sama
     * `revision`, ta sama lista, a każda pozycja przechodzi strażnika.
     */
    it('lista dla apki: ta sama migawka i `revision` co strażnik, każda pozycja przechodzi', async () => {
      const home = await mkdtemp(join(tmpdir(), 'rarog-komendy-lista-'));
      try {
        await mkdir(join(home, '.claude/skills/handoff'), { recursive: true });
        await writeFile(join(home, '.claude/skills/handoff/SKILL.md'),
          '---\ndescription: Przekazanie pracy\nargument-hint: "[cel]"\n---\n');
        const catalogs = createCommandCatalogs({ home, roots: [PROJECT] });
        const asked: [string, string | null][] = [];
        const deps = makeDeps();
        deps.assertSendable = assertSendable;
        deps.commandCatalog = (cwd, cliVersion) => {
          asked.push([cwd, cliVersion]);
          return catalogs.get(cwd, cliVersion);
        };
        const supervisor = makeSupervisor();
        const manager = await build(supervisor, deps, { cliVersionReader });
        supervisor.appear(makeAgent());
        await flush(8);
        const id = manager.list().find((s) => s.paneId !== undefined)?.id ?? '';

        const list = manager.commands(id);
        expect(asked.at(-1)).toEqual([PROJECT, '2.1.290']);
        const catalog = catalogs.get(PROJECT, '2.1.290');
        expect(list).toEqual(commandListOf(catalog));
        expect(list.revision).toBe(catalog.revision);
        expect(list.commands.find((entry) => entry.name === 'handoff')).toEqual({
          name: 'handoff', kind: 'prompt', source: 'skill', description: 'Przekazanie pracy', argumentHint: '[cel]',
        });
        for (const entry of list.commands) {
          const sendable = assertSendable(`/${entry.name}`, { mode: 'auto', cwd: PROJECT, yoloRoots: [], catalog });
          expect(sendable.slash, entry.name).toEqual({ name: entry.name, kind: entry.kind });
        }

        await manager.sendMessage(id, '/handoff na jutro');
        const sent = supervisor.driver('w9:p72').sendOpts.at(-1)?.command;
        expect(sent?.catalog.revision).toBe(list.revision);
        expect(sent?.slash).toEqual({ name: 'handoff', kind: 'prompt' });
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });

    it('lista dla apki: nieznana sesja 404, panel poza zasięgiem i katalog sesji spoza korzeni 400', async () => {
      const { deps, asked } = d109Deps();
      const supervisor = makeSupervisor();
      const manager = await build(supervisor, deps);
      expect(() => manager.commands('nie-ma')).toThrow(NotFoundError);
      supervisor.appear(makeAgent({ inScope: false, cwd: '/Users/u/Prywatne/birch' }));
      await flush();
      const id = manager.list()[0]?.id ?? '';
      expect(() => manager.commands(id)).toThrow(HERDR_OUT_OF_SCOPE_MESSAGE.text);
      expect(() => manager.commands(id)).toThrow(BadRequestError);
      // `cd` pod korzeń: zasięg wraca, a sesja dalej trzyma prywatny katalog, z którego `.claude/` liczy się lista.
      supervisor.reattach(makeAgent({ inScope: true, cwd: PROJECT }));
      await flush();
      expect(manager.get(id)?.outOfScope).not.toBe(true);
      expect(() => manager.commands(id)).toThrow(HERDR_OUT_OF_SCOPE_MESSAGE.text);
      expect(asked).toEqual([]);
    });

    it('lista dla apki: panel Codexa 400, także z zasięgiem w zgłoszeniu (Codex nie jest Claude Code)', async () => {
      const { deps, asked } = d109Deps();
      const supervisor = makeSupervisor();
      const manager = await build(supervisor, deps);
      supervisor.appear(makeAgent({ engine: 'codex', inScope: true }));
      await flush();
      const id = manager.list()[0]?.id ?? '';
      expect(manager.get(id)?.engine).toBe('codex');
      expect(() => manager.commands(id)).toThrow(BadRequestError);
      expect(asked).toEqual([]);
    });
  });

  it('create() oddaje 202 z sessionId ZANIM agent jest gotowy', async () => {
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, makeDeps());

    const created = await manager.create({ cwd: PROJECT, prompt: 'zrób X' });

    /*
     * Kolejność jest tu całym testem: odpowiedź istnieje, a `ready` jeszcze się nie
     * rozstrzygnęło. Blokujący POST na ~5 s startu agenta ginie przy zgaszeniu ekranu iOS
     * i zostawia telefon ze spinnerem przy ŻYWYM panelu.
     */
    expect(created.state).toBe('starting');
    // Karta istnieje i ma swój adres — telefon może na nią przejść OD RAZU, bez czekania.
    expect(manager.get(created.sessionId)).toBeDefined();
    expect(supervisor.launches).toHaveLength(1);
    // …a prompt startowy jeszcze NIE poszedł: `ready` się nie rozstrzygnęło.
    expect(supervisor.log.calls).toEqual([]);
  });

  it('prompt startowy idzie `driver.send` PO gotowości, a zlecenie launchera go NIE NIESIE',
    async () => {
      const supervisor = makeSupervisor();
      const manager = await build(supervisor, makeDeps());

      const created = await manager.create({ cwd: PROJECT, prompt: 'zrób X' });
      // Przed gotowością do panelu nie poszło ANI JEDNO wywołanie.
      expect(supervisor.log.calls).toEqual([]);

      supervisor.settleLaunch();
      await flush();

      // Zdanie człowieka jedzie `agent.prompt`, nigdy linią poleceń panelu.
      expect(supervisor.log.of('send')).toEqual(['zrób X']);
      expect(JSON.stringify(supervisor.launches[0])).not.toContain('zrób X');
      expect(manager.get(created.sessionId)?.state).toBe('running');
    });

  describe('wysyłka w `starting`', () => {
    it('sesja z telefonu przed gotowością: odmowa `session.not-accepting-messages`, prompt startowy dochodzi',
      async () => {
        const supervisor = makeSupervisor();
        // Driver nie melduje stanu sam: karta stoi w `starting` do gotowości, jak panel, w którym `claude` wstaje.
        supervisor.autoSettle = false;
        const manager = await build(supervisor, makeDeps());
        const created = await manager.create({ cwd: PROJECT, prompt: 'zrób X' });
        expect(manager.get(created.sessionId)?.state).toBe('starting');

        const err = await Promise.resolve()
          .then(() => manager.sendMessage(created.sessionId, 'druga wiadomość'))
          .then(() => null, (e: unknown) => e);
        expect(err).toBeInstanceOf(BadStateError);
        expect((err as BadStateError).sentence).toMatchObject({
          ref: { code: 'session.not-accepting-messages', args: [created.sessionId, 'starting'] },
        });

        supervisor.settleLaunch();
        await flush();
        // Prompt startowy idzie `#finishLaunch` jak dotąd; odrzucona wiadomość nie poszła nigdzie.
        expect(supervisor.log.of('send')).toEqual(['zrób X']);
        expect(manager.get(created.sessionId)?.state).toBe('running');
      });

    /*
     * Wznowienie z Raroga: follower czyta historię pliku i oddaje `init`, herdr potrafi zameldować `idle`
     * albo `working`, zanim panel jest gotowy. Karta stoi w `starting` do gotowości, bo `agent.prompt`
     * przed nią kończy się `agent_not_ready`, a manager przyjąłby już wiadomość i zrobił echo.
     */
    it('wznowienie: `init` z historii pliku i stan herdr przed gotowością zostawiają `starting`, wysyłka 409',
      async () => {
        const deps = makeDeps();
        deps.cwdByFile.set('/store/atlas.jsonl', PROJECT);
        const supervisor = makeSupervisor();
        supervisor.autoSettle = false;
        const manager = await build(supervisor, deps);
        const created = await manager.create({ cwd: PROJECT, resumeFrom: ENGINE_SESSION });
        await flush();
        const driver = supervisor.driver('w0:new1');
        const refused = async (): Promise<void> => {
          const err = await Promise.resolve()
            .then(() => manager.sendMessage(created.sessionId, 'za wcześnie'))
            .then(() => null, (e: unknown) => e);
          expect(err).toBeInstanceOf(BadStateError);
          expect((err as BadStateError).sentence).toMatchObject({
            ref: { code: 'session.not-accepting-messages', args: [created.sessionId, 'starting'] },
          });
        };

        driver.queue.push({ type: 'init', engineSessionId: ENGINE_SESSION, model: 'claude-opus-5-5' });
        await flush();
        expect(manager.get(created.sessionId)?.state).toBe('starting');
        // Model z `init` trafia na kartę mimo stojącego `starting`.
        expect(manager.get(created.sessionId)?.model).toBe('claude-opus-5-5');
        await refused();
        for (const state of ['idle', 'working'] as const) {
          driver.queue.push({ type: 'agent-state', state });
          await flush();
          expect(manager.get(created.sessionId)?.state).toBe('starting');
          await refused();
        }
        expect(supervisor.log.of('send')).toEqual([]);

        supervisor.settleLaunch();
        await flush();
        expect(manager.get(created.sessionId)?.state).toBe('waiting-input');
        await manager.sendMessage(created.sessionId, 'teraz');
        expect(supervisor.log.of('send')).toEqual(['teraz']);
      });

    it('porażka startu po `init` z historii: karta `error`, nie `running`', async () => {
      const deps = makeDeps();
      deps.cwdByFile.set('/store/atlas.jsonl', PROJECT);
      const supervisor = makeSupervisor();
      supervisor.autoSettle = false;
      const manager = await build(supervisor, deps);
      const created = await manager.create({ cwd: PROJECT, resumeFrom: ENGINE_SESSION });
      await flush();
      supervisor.driver('w0:new1').queue.push({ type: 'init', engineSessionId: ENGINE_SESSION, model: 'claude-opus-5-5' });
      await flush();
      supervisor.settleLaunch(new Error('panel nie wstał'));
      await flush();
      expect(manager.get(created.sessionId)?.state).toBe('error');
    });

    /*
     * Dialog startowy (zaufanie katalogu) przed gotowością panelu: `starting → waiting-permission`, a po
     * odpowiedzi herdr melduje `idle` albo `working`, zanim `ready` się rozstrzygnie. Bez reguły karta szła
     * do stanu wysyłki i wiadomość z telefonu trafiała do panelu przed gotowością. Karta wraca do `starting`,
     * a bramka wysyłki patrzy na `launchPending`, nie tylko na stan.
     */
    it.each(['idle', 'working'] as const)(
      'dialog startowy przed gotowością, potem `%s`: karta wraca do `starting`, wysyłka 409 bez echa i klawisza',
      async (after) => {
        const supervisor = makeSupervisor();
        supervisor.autoSettle = false;
        const manager = await build(supervisor, makeDeps());
        const created = await manager.create({ cwd: PROJECT });
        await flush();
        const id = created.sessionId;
        const driver = supervisor.driver('w0:new1');
        const refused = async (state: string): Promise<void> => {
          const err = await Promise.resolve()
            .then(() => manager.sendMessage(id, 'za wcześnie', undefined, undefined, `c-${state}`))
            .then(() => null, (e: unknown) => e);
          expect(err).toBeInstanceOf(BadStateError);
          expect((err as BadStateError).sentence).toMatchObject({
            ref: { code: 'session.not-accepting-messages', args: [id, state] },
          });
          expect(manager.transcript(id).messages.filter((m) => m.role === 'user')).toEqual([]);
          expect(supervisor.log.of('send')).toEqual([]);
        };

        driver.queue.push({ type: 'agent-state', state: 'blocked' });
        driver.queue.push({ type: 'screen-dialog', knownDialog: 'trust' });
        await flush();
        expect(manager.get(id)?.state).toBe('waiting-permission');
        expect(manager.list().find((s) => s.id === id)?.herdrDialog).toBe('trust');
        await refused('waiting-permission');
        // Sam dialog obsługiwany jak dotąd.
        await expect(manager.resolvePermission(id, id, 'allow', 'iPhone')).resolves.toEqual({ outcome: 'ok' });

        driver.queue.push({ type: 'agent-state', state: after });
        await flush();
        expect(manager.get(id)?.state).toBe('starting');
        await refused('starting');

        supervisor.settleLaunch();
        await flush();
        expect(manager.get(id)?.state).toBe('waiting-input');
        await manager.sendMessage(id, 'teraz');
        expect(supervisor.log.of('send')).toEqual(['teraz']);
      });

    it('dialog startowy z promptem startowym: po gotowości prompt idzie ze `starting`, karta `running`', async () => {
      const supervisor = makeSupervisor();
      supervisor.autoSettle = false;
      const manager = await build(supervisor, makeDeps());
      const created = await manager.create({ cwd: PROJECT, prompt: 'zrób X' });
      await flush();
      const driver = supervisor.driver('w0:new1');
      driver.queue.push({ type: 'screen-dialog', knownDialog: 'trust' });
      await flush();
      driver.queue.push({ type: 'agent-state', state: 'idle' });
      await flush();
      expect(manager.get(created.sessionId)?.state).toBe('starting');
      supervisor.settleLaunch();
      await flush();
      expect(supervisor.log.of('send')).toEqual(['zrób X']);
      expect(manager.get(created.sessionId)?.state).toBe('running');
    });

    it('panel zastany w `unknown` (karta `starting` z driverem): odmowa bez klawisza, po `idle` wysyłka idzie',
      async () => {
        const supervisor = makeSupervisor();
        supervisor.autoSettle = false;
        const manager = await build(supervisor, makeDeps());
        supervisor.appear(makeAgent({ status: 'unknown' }));
        await flush();
        const id = manager.list().find((s) => s.paneId !== undefined)?.id ?? '';
        expect(manager.get(id)?.state).toBe('starting');

        await expect(Promise.resolve().then(() => manager.sendMessage(id, 'za wcześnie')))
          .rejects.toBeInstanceOf(BadStateError);
        expect(supervisor.log.of('send')).toEqual([]);

        supervisor.driver('w9:p72').queue.push({ type: 'agent-state', state: 'idle' });
        await flush();
        expect(manager.get(id)?.state).toBe('waiting-input');
        await manager.sendMessage(id, 'teraz');
        expect(supervisor.log.of('send')).toEqual(['teraz']);
      });
  });

  /*
   * Prompt startowy a dialog zaufania. Launcher oddaje `ready` od razu, gdy panel wstaje na dialogu
   * (`{status: 'blocked', interactiveReady: false}`). Wzięte za gotowość zdejmowałoby rezerwację i wysyłało prompt,
   * który herdr odrzuca `agent_blocked`, a zdanie przepadało. Gotowość to dopiero `idle` panelu po dialogu; do niej
   * karta trzyma rezerwację (`launchPending`).
   */
  describe('prompt startowy przy dialogu zaufania', () => {
    const BLOCKED = { status: 'blocked', interactiveReady: false } as const;
    const NEW_KEY = 'w0:new1';
    const LOST = `system: ${textOf(say('session.prompt-lost'))}`;

    /** Nowa sesja z promptem, której start stanął na dialogu zaufania; driver nie melduje niczego sam. */
    async function startOnTrust(): Promise<{
      supervisor: FakeSupervisor; manager: Manager; deps: FakeDeps; id: string; driver: FakeHerdrDriver;
    }> {
      const supervisor = makeSupervisor();
      supervisor.autoSettle = false;
      const deps = makeDeps();
      const manager = await build(supervisor, deps);
      const created = await manager.create({ cwd: PROJECT, prompt: 'zrób X' });
      await flush();
      const driver = supervisor.driver(NEW_KEY);
      driver.queue.push({ type: 'agent-state', state: 'blocked' });
      driver.queue.push({ type: 'screen-dialog', knownDialog: 'trust' });
      await flush();
      return { supervisor, manager, deps, id: created.sessionId, driver };
    }

    /** Wiadomości transkryptu jako `rola: tekst` — do asercji o zdaniu, które zostało. */
    function lines(manager: Manager, id: string): string[] {
      return manager.transcript(id).messages.map((m) => `${m.role}: ${m.blocks.map((b) => (
        b.type === 'text' ? b.text : b.type)).join(' ')}`);
    }

    it('start na dialogu: zero wysyłki do gotowości, prompt idzie po zatwierdzeniu i `idle`', async () => {
      const { supervisor, manager, id, driver } = await startOnTrust();
      supervisor.settleLaunch(null, BLOCKED);
      await flush();
      expect(supervisor.log.of('send')).toEqual([]);
      expect(manager.get(id)?.state).toBe('waiting-permission');
      expect(lines(manager, id).filter((l) => l.startsWith('user:'))).toEqual([]);

      await expect(manager.resolvePermission(id, id, 'allow', 'iPhone')).resolves.toEqual({ outcome: 'ok' });
      // `claude` po decyzji wstaje od nowa: `working` to jeszcze nie gotowość.
      driver.queue.push({ type: 'agent-state', state: 'working' });
      await flush();
      expect(supervisor.log.of('send')).toEqual([]);
      expect(manager.get(id)?.state).toBe('starting');

      driver.queue.push({ type: 'agent-state', state: 'idle' });
      await flush();
      expect(supervisor.log.of('send')).toEqual(['zrób X']);
      expect(manager.get(id)?.state).toBe('running');
      expect(lines(manager, id).filter((l) => l.startsWith('user:'))).toEqual(['user: zrób X']);
      // Klasyfikacja komendy z bramki przed startem jedzie z wysyłką jak dotąd.
      expect(driver.sendOpts[0]?.command).toBeDefined();
    });

    it('rezerwacja: zwykła wysyłka w czasie oczekiwania dostaje odmowę i nie wyprzedza promptu startowego',
      async () => {
        const { supervisor, manager, deps, id, driver } = await startOnTrust();
        supervisor.settleLaunch(null, BLOCKED);
        await flush();
        await expect(manager.resolvePermission(id, id, 'allow', 'iPhone')).resolves.toEqual({ outcome: 'ok' });
        driver.queue.push({ type: 'agent-state', state: 'working' });
        await flush();

        const err = await Promise.resolve()
          .then(() => manager.sendMessage(id, 'druga'))
          .then(() => null, (e: unknown) => e);
        expect(err).toBeInstanceOf(BadStateError);
        expect((err as BadStateError).sentence).toMatchObject({
          ref: { code: 'session.not-accepting-messages', args: [id, 'starting'] },
        });
        expect(supervisor.log.of('send')).toEqual([]);

        driver.queue.push({ type: 'agent-state', state: 'idle' });
        await flush();
        deps.setNow(5_000);
        await manager.sendMessage(id, 'druga');
        expect(supervisor.log.of('send')).toEqual(['zrób X', 'druga']);
      });

    it('gotowość jako stan bieżący: `idle` przed założeniem oczekiwania nie gubi wysyłki', async () => {
      const { supervisor, manager, id, driver } = await startOnTrust();
      await expect(manager.resolvePermission(id, id, 'allow', 'iPhone')).resolves.toEqual({ outcome: 'ok' });
      driver.queue.push({ type: 'agent-state', state: 'idle' });
      await flush();
      // Nadzorca widzi już gotowy panel, a launcher oddaje stan ze swojego ostatniego odczytu (dialog).
      supervisor.live.set(NEW_KEY, makeAgent({
        key: NEW_KEY, paneId: NEW_KEY, status: 'idle', interactiveReady: true, launchedByRarog: true,
      }));
      supervisor.settleLaunch(null, BLOCKED);
      await flush();
      expect(supervisor.log.of('send')).toEqual(['zrób X']);
      expect(manager.get(id)?.state).toBe('running');
    });

    it('`idle` sprzed dialogu nie jest gotowością: nadzorca widzi `blocked`, prompt czeka', async () => {
      const supervisor = makeSupervisor();
      // Driver melduje `idle` od razu po podpięciu (`autoSettle`), zanim launcher zobaczy dialog.
      const manager = await build(supervisor, makeDeps());
      const created = await manager.create({ cwd: PROJECT, prompt: 'zrób X' });
      await flush();
      const driver = supervisor.driver(NEW_KEY);
      supervisor.live.set(NEW_KEY, makeAgent({
        key: NEW_KEY, paneId: NEW_KEY, status: 'blocked', interactiveReady: false, launchedByRarog: true,
      }));
      supervisor.settleLaunch(null, BLOCKED);
      await flush();
      expect(supervisor.log.of('send')).toEqual([]);
      driver.queue.push({ type: 'agent-state', state: 'blocked' });
      await flush();
      expect(manager.get(created.sessionId)?.state).toBe('waiting-permission');
      expect(supervisor.log.of('send')).toEqual([]);
    });

    it('`idle`, gdy nadzorca mówi „nie gotowy” (rekord startu herdr jeszcze żyje): prompt czeka na następne `idle`',
      async () => {
        const { supervisor, manager, id, driver } = await startOnTrust();
        supervisor.settleLaunch(null, BLOCKED);
        await flush();
        await expect(manager.resolvePermission(id, id, 'allow', 'iPhone')).resolves.toEqual({ outcome: 'ok' });
        const agent = makeAgent({
          key: NEW_KEY, paneId: NEW_KEY, status: 'idle', interactiveReady: false, launchedByRarog: true,
        });
        supervisor.live.set(NEW_KEY, agent);
        driver.queue.push({ type: 'agent-state', state: 'idle' });
        await flush();
        expect(supervisor.log.of('send')).toEqual([]);
        // Resync powtarza stan; tym razem `interactive_ready` już jest.
        supervisor.live.set(NEW_KEY, { ...agent, interactiveReady: true });
        driver.queue.push({ type: 'agent-state', state: 'idle' });
        await flush();
        expect(supervisor.log.of('send')).toEqual(['zrób X']);
        expect(manager.get(id)?.state).toBe('running');
      });

    it('`claude` po decyzji wstaje od nowa (`re-attached`, nowy driver): prompt idzie do nowego drivera',
      async () => {
        const { supervisor, manager, id } = await startOnTrust();
        supervisor.settleLaunch(null, BLOCKED);
        await flush();
        await expect(manager.resolvePermission(id, id, 'allow', 'iPhone')).resolves.toEqual({ outcome: 'ok' });
        const agent = makeAgent({
          key: NEW_KEY, paneId: NEW_KEY, status: 'idle', interactiveReady: true, launchedByRarog: true,
          agentSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001',
        });
        supervisor.live.set(NEW_KEY, agent);
        supervisor.autoSettle = true;
        supervisor.reattach(agent);
        await flush();
        expect(supervisor.attachCount).toBe(2);
        expect(supervisor.log.of('send')).toEqual(['zrób X']);
        expect(lines(manager, id)).not.toContain(LOST);
        expect(manager.get(id)?.state).toBe('running');
      });

    it.each([
      // „No, exit” kończy proces `claude`, herdr gubi agenta: nadzorca ogłasza `gone`.
      ['dialog odrzucony, panel znika (`gone`)', 'gone'],
      ['driver kończy się wyjściem (`exit`)', 'exit'],
    ] as const)('%s: prompt zostaje w transkrypcie drogą `#lostStartPrompt`, oczekiwanie unieważnione',
      async (_name, end) => {
        const { supervisor, manager, id, driver } = await startOnTrust();
        supervisor.settleLaunch(null, BLOCKED);
        await flush();
        if (end === 'gone') supervisor.emit({ type: 'gone', key: NEW_KEY });
        else driver.queue.push({ type: 'exit', ok: false });
        await flush();
        expect(lines(manager, id).slice(-2)).toEqual(['user: zrób X', LOST]);
        expect(supervisor.log.of('send')).toEqual([]);
        // Zdanie stoi raz: oczekiwanie jest unieważnione, a `#finishLaunch` nie dopisuje go drugi raz.
        await flush();
        expect(lines(manager, id).filter((l) => l === LOST)).toHaveLength(1);
      });

    it('driver wychodzi PRZED rozstrzygnięciem `ready` na dialogu: prompt w transkrypcie, bez oczekiwania',
      async () => {
        const { supervisor, manager, id, driver } = await startOnTrust();
        driver.queue.push({ type: 'exit', ok: false });
        await flush();
        supervisor.settleLaunch(null, BLOCKED);
        await flush();
        expect(lines(manager, id).slice(-2)).toEqual(['user: zrób X', LOST]);
        expect(lines(manager, id).filter((l) => l === LOST)).toHaveLength(1);
        expect(supervisor.log.of('send')).toEqual([]);
      });

    it.each([true, false])(
      'zamknięcie karty (`closePanel: %s`) w czasie oczekiwania: zdanie w transkrypcie, zero wysyłki',
      async (closePanel) => {
        const { supervisor, manager, id, driver } = await startOnTrust();
        supervisor.settleLaunch(null, BLOCKED);
        await flush();
        const events = record(manager);
        await manager.close(id, { closePanel });
        await flush();
        const said = events
          .filter((e) => e.scope === id && e.event.type === 'message')
          .map((e) => JSON.stringify(e.event));
        expect(said).toHaveLength(2);
        expect(said[0]).toContain('zrób X');
        expect(said[1]).toContain(textOf(say('session.prompt-lost')));
        // Spóźnione `idle` nie ma już dokąd wysłać.
        driver.queue.push({ type: 'agent-state', state: 'idle' });
        await flush();
        expect(supervisor.log.of('send')).toEqual([]);
      });
  });

  it('panel zniknął przed wysłaniem promptu → zdanie ZOSTAJE w transkrypcie z wyjaśnieniem',
    async () => {
      /*
       * The supervisor may announce `gone` for a panel that is still starting; the manager then detaches the driver,
       * and `#finishLaunch` must not silently LOSE the start prompt (the phone would show an empty, working session).
       * `awaitingAgent` in the supervisor prevents the early `gone`; this test covers the other half: even when the
       * panel really disappears in that window, the user's sentence stays VISIBLE.
       */
      const supervisor = makeSupervisor();
      const manager = await build(supervisor, makeDeps());
      const created = await manager.create({ cwd: PROJECT, prompt: 'zrób X' });

      supervisor.emit({ type: 'gone', key: 'w0:new1' });
      await flush();
      supervisor.settleLaunch();
      await flush();

      const messages = manager.transcript(created.sessionId).messages;
      expect(messages.map((m) => m.role)).toEqual(['user', 'system']);
      expect(JSON.stringify(messages[0])).toContain('zrób X');
      expect(JSON.stringify(messages[1])).toContain("It wasn't delivered.");
      // ZERO wysyłek do panelu — driver już nie istnieje, więc nie ma dokąd.
      expect(supervisor.log.calls).toEqual([]);
    });

  /*
   * Etykieta TABA w herdr idzie za etykietą KARTY. Manager ma na to JEDNO wyjście
   * (`#setLabel` → `syncTabLabel`) i cztery wejścia — każde z nich musi przez nie przejść,
   * z dokładnie tą etykietą, którą widzi karta. Piąta droga obok zostawiłaby tab ze starą nazwą.
   */
  describe('etykieta karty → `syncTabLabel` nadzorcy', () => {
    it('`#herdrAppeared`: panel zastany — etykieta z auto-tytułu', async () => {
      const { manager, supervisor, id } = await withOneAgent();

      expect(supervisor.tabLabelSyncs).toEqual([{ key: 'w9:p72', label: 's3-back' }]);
      expect(manager.get(id)?.label).toBe('s3-back');
    });

    it('`#herdrAppeared`: pusty tytuł — fallback nazwą katalogu, ta sama co na karcie', async () => {
      const { manager, supervisor, id } = await withOneAgent(makeAgent({ title: '' }));

      const label = manager.get(id)?.label;
      expect(label).toBe(basename(PROJECT));
      expect(supervisor.tabLabelSyncs).toEqual([{ key: 'w9:p72', label }]);
    });

    it('`#launch`: nowa sesja z promptem — etykieta z promptu, klucz z uchwytu launchera', async () => {
      const supervisor = makeSupervisor();
      const manager = await build(supervisor, makeDeps());

      const created = await manager.create({ cwd: PROJECT, prompt: 'napraw zapis notatek' });

      expect(manager.get(created.sessionId)?.label).toBe('napraw zapis notatek');
      expect(supervisor.tabLabelSyncs).toEqual([{ key: 'w0:new1', label: 'napraw zapis notatek' }]);
    });

    it('pierwsza wiadomość po fallbacku `session N` — etykieta z promptu', async () => {
      const supervisor = makeSupervisor();
      const manager = await build(supervisor, makeDeps());
      const created = await manager.create({ cwd: PROJECT });
      supervisor.settleLaunch();
      await flush();
      expect(supervisor.tabLabelSyncs).toEqual([{ key: 'w0:new1', label: 'session 1' }]);

      await manager.sendMessage(created.sessionId, 'Napraw eksport CSV w panelu klienta');

      expect(manager.get(created.sessionId)?.label).toBe('Napraw eksport CSV w panelu');
      expect(supervisor.tabLabelSyncs.at(-1))
        .toEqual({ key: 'w0:new1', label: 'Napraw eksport CSV w panelu' });
    });

    /*
     * Karta i tab mają nieść TEN SAM napis. Bez tego karta trzyma surowe
     * `session.label` (ESC zostaje), a tab dostaje osobno ucięte do 28 znaków.
     */
    it('fallback dłuższy niż 28 znaków — karta == tab, oba pełne', async () => {
      const { manager, supervisor, id } = await withOneAgent(makeAgent({
        title: '', cwd: '/Users/u/Projects/fjord-dashboard-settings-panel',
      }));

      expect(manager.get(id)?.label).toBe('fjord-dashboard-settings-panel');
      expect(supervisor.tabLabelSyncs)
        .toEqual([{ key: 'w9:p72', label: 'fjord-dashboard-settings-panel' }]);
    });

    it('tytuł ze znakiem sterującym — karta == tab, bez ESC', async () => {
      const { manager, supervisor, id } = await withOneAgent();

      supervisor.driver('w9:p72').queue.push({ type: 'title', title: 'zły\u001b[31m tytuł' });
      await flush();

      expect(manager.get(id)?.label).toBe('zły [31m tytuł');
      expect(supervisor.tabLabelSyncs.at(-1)).toEqual({ key: 'w9:p72', label: 'zły [31m tytuł' });
    });

    it('`title` z drivera — nowa etykieta raz; ten sam tytuł drugi raz nie woła nadzorcy', async () => {
      const { manager, supervisor, id } = await withOneAgent();

      supervisor.driver('w9:p72').queue.push({ type: 'title', title: 'nowy wątek rozmowy' });
      await flush();
      supervisor.driver('w9:p72').queue.push({ type: 'title', title: 'nowy wątek rozmowy' });
      await flush();

      expect(manager.get(id)?.label).toBe('nowy wątek rozmowy');
      expect(supervisor.tabLabelSyncs).toEqual([
        { key: 'w9:p72', label: 's3-back' },
        { key: 'w9:p72', label: 'nowy wątek rozmowy' },
      ]);
    });
  });

  /*
   * Nazwa z `/rename` przychodzi z pliku rozmowy (`title` z `source: 'custom-title'`)
   * i wygrywa z tytułem terminala herdr oraz z etykietą z pierwszego promptu, dopóki panel pisze tę samą rozmowę.
   */
  describe('etykieta z `custom-title`', () => {
    const customTitle = (title: string): DriverEvent => ({ type: 'title', title, source: 'custom-title' });

    it('nazwa z pliku rozmowy od razu na karcie i na tabie', async () => {
      const { manager, supervisor, id } = await withOneAgent();

      supervisor.driver('w9:p72').queue.push(customTitle('demo-eksport'));
      await flush();

      expect(manager.get(id)?.label).toBe('demo-eksport');
      expect(supervisor.tabLabelSyncs.at(-1)).toEqual({ key: 'w9:p72', label: 'demo-eksport' });
    });

    it('ostatnia nazwa wygrywa', async () => {
      const { manager, id, supervisor } = await withOneAgent();

      supervisor.driver('w9:p72').queue.push(customTitle('demo-eksport'));
      supervisor.driver('w9:p72').queue.push(customTitle('demo-eksport-csv'));
      await flush();

      expect(manager.get(id)?.label).toBe('demo-eksport-csv');
    });

    it('znana nazwa wygrywa z tytułem terminala herdr', async () => {
      const { manager, supervisor, id } = await withOneAgent();

      supervisor.driver('w9:p72').queue.push(customTitle('demo-eksport'));
      await flush();
      const syncs = supervisor.tabLabelSyncs.length;
      supervisor.driver('w9:p72').queue.push({ type: 'title', title: 'Claude Code' });
      await flush();

      expect(manager.get(id)?.label).toBe('demo-eksport');
      expect(supervisor.tabLabelSyncs).toHaveLength(syncs);
    });

    it('tytuł herdr działa jak dziś, gdy nazwa nieznana', async () => {
      const { manager, id, supervisor } = await withOneAgent();

      supervisor.driver('w9:p72').queue.push({ type: 'title', title: 'nowy wątek rozmowy' });
      await flush();

      expect(manager.get(id)?.label).toBe('nowy wątek rozmowy');
    });

    it('znana nazwa wygrywa z etykietą z pierwszego promptu, także gdy brzmi jak fallback', async () => {
      const supervisor = makeSupervisor();
      const manager = await build(supervisor, makeDeps());
      const created = await manager.create({ cwd: PROJECT });
      supervisor.settleLaunch();
      await flush();
      supervisor.driver('w0:new1').queue.push(customTitle('session 4'));
      await flush();
      expect(manager.get(created.sessionId)?.label).toBe('session 4');

      await manager.sendMessage(created.sessionId, 'Napraw eksport CSV w panelu klienta');

      expect(manager.get(created.sessionId)?.label).toBe('session 4');
      expect(supervisor.tabLabelSyncs.at(-1)).toEqual({ key: 'w0:new1', label: 'session 4' });
    });

    it('`/clear` — nazwa z nowego pliku po `init` z nowym uuid wraca na kartę', async () => {
      const { manager, supervisor, id } = await withOneAgent();
      const driver = supervisor.driver('w9:p72');

      driver.queue.push(customTitle('demo-eksport'));
      driver.queue.push({ type: 'init', engineSessionId: '0b8f8c02-5f0e-4a8e-9a39-3c1f0c7e2d11', model: '' });
      driver.queue.push(customTitle('demo-eksport'));
      driver.queue.push({ type: 'title', title: 'Claude Code' });
      await flush();

      expect(manager.get(id)?.label).toBe('demo-eksport');
    });

    it('`/resume` rozmowy bez nazwy — etykieta stoi, potem wraca reguła tytułu herdr', async () => {
      const { manager, supervisor, id } = await withOneAgent();
      const driver = supervisor.driver('w9:p72');

      driver.queue.push(customTitle('demo-eksport'));
      driver.queue.push({ type: 'init', engineSessionId: '0b8f8c02-5f0e-4a8e-9a39-3c1f0c7e2d11', model: '' });
      await flush();
      expect(manager.get(id)?.label).toBe('demo-eksport');

      driver.queue.push({ type: 'title', title: 'wznowiona rozmowa' });
      await flush();
      expect(manager.get(id)?.label).toBe('wznowiona rozmowa');
    });

    it('`init` tej samej rozmowy (meta, wymiana drivera) nie gasi nazwy', async () => {
      const { manager, supervisor, id } = await withOneAgent();
      const driver = supervisor.driver('w9:p72');

      driver.queue.push(customTitle('demo-eksport'));
      driver.queue.push({ type: 'init', engineSessionId: ENGINE_SESSION, model: 'claude-opus-5-5' });
      driver.queue.push({ type: 'title', title: 'Claude Code' });
      await flush();

      expect(manager.get(id)?.label).toBe('demo-eksport');
    });

    it('długą nazwę przycina `labelFromPrompt` (28 znaków)', async () => {
      const { manager, supervisor, id } = await withOneAgent();

      supervisor.driver('w9:p72').queue.push(customTitle('eksport raportów miesięcznych dla działu finansów'));
      await flush();

      const label = manager.get(id)?.label ?? '';
      expect(label).toBe(labelFromPrompt('eksport raportów miesięcznych dla działu finansów'));
      expect(label.length).toBeLessThanOrEqual(MAX_LABEL_LENGTH);
    });
  });

  it('sesja bez promptu ląduje w waiting-input, a nie wisi w „startuje"', async () => {
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, makeDeps());
    const created = await manager.create({ cwd: PROJECT });
    supervisor.settleLaunch();
    await flush();

    expect(manager.get(created.sessionId)?.state).toBe('waiting-input');
    expect(supervisor.log.calls).toEqual([]);
  });

  it('sesja bez `--model` dostaje pigułkę z domyślnego modelu konta (settings.json)', async () => {
    // To nie jest zgadywanie: argv składamy sami, więc brak flagi = panel wstaje na tym,
    // co stoi w ~/.claude/settings.json. `init` z jsonl i tak nadpisze prawdą.
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, makeDeps(), {
      accountDefaultModel: () => 'claude-fable-5',
    });
    const created = await manager.create({ cwd: PROJECT });
    supervisor.settleLaunch();
    await flush();

    expect(manager.get(created.sessionId)?.model).toBe('claude-fable-5');
  });

  it('jawny wybór modelu wygrywa z domyślnym konta, a brak czytnika = brak pigułki', async () => {
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, makeDeps(), {
      accountDefaultModel: () => 'claude-fable-5',
    });
    const created = await manager.create({ cwd: PROJECT, model: 'opus[1m]' });
    supervisor.settleLaunch();
    await flush();
    expect(manager.get(created.sessionId)?.model).toBe('opus[1m]');

    const bare = makeSupervisor();
    const bareManager = await build(bare, makeDeps());
    const bareCreated = await bareManager.create({ cwd: PROJECT });
    bare.settleLaunch();
    await flush();
    expect(bareManager.get(bareCreated.sessionId)?.model).toBeUndefined();
  });

  /*
   * A new session without `--effort` still shows the effort pill: the effort seed does not stop at what came from the
   * form, it falls back to the account default from the same settings file.
   */
  it('sesja bez `--effort` dostaje pigułkę z domyślnego effortu konta', async () => {
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, makeDeps(), {
      accountDefaultModel: () => 'claude-fable-5',
      accountDefaultEffort: () => 'medium',
    });
    const created = await manager.create({ cwd: PROJECT });
    supervisor.settleLaunch();
    await flush();

    expect(manager.get(created.sessionId)?.effort).toBe('medium');
  });

  it('domyślny effort pytany jest o MODEL, na którym panel naprawdę wstanie', async () => {
    // CLI trzyma effort per model, pod kluczem `modelSettings` (docs `model-config.md`, „Adjust effort level”),
    // więc czytnik dostaje model rozwiązany — ten z formularza, a gdy go nie ma,
    // domyślny konta.
    const supervisor = makeSupervisor();
    const asked: (string | undefined)[] = [];
    const manager = await build(supervisor, makeDeps(), {
      accountDefaultModel: () => 'claude-fable-5',
      accountDefaultEffort: (model) => { asked.push(model); return 'medium'; },
    });
    await manager.create({ cwd: PROJECT });
    supervisor.settleLaunch();
    await flush();
    expect(asked).toEqual(['claude-fable-5']);

    const second = makeSupervisor();
    const asked2: (string | undefined)[] = [];
    const withPick = await build(second, makeDeps(), {
      accountDefaultModel: () => 'claude-fable-5',
      accountDefaultEffort: (model) => { asked2.push(model); return 'medium'; },
    });
    await withPick.create({ cwd: PROJECT, model: 'opus[1m]' });
    second.settleLaunch();
    await flush();
    expect(asked2).toEqual(['opus[1m]']);
  });

  it('jawny wybór effortu wygrywa z domyślnym konta, a brak czytnika = brak pigułki', async () => {
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, makeDeps(), {
      accountDefaultEffort: () => 'medium',
    });
    const created = await manager.create({ cwd: PROJECT, effort: 'max' });
    supervisor.settleLaunch();
    await flush();
    expect(manager.get(created.sessionId)?.effort).toBe('max');

    const bare = makeSupervisor();
    const bareManager = await build(bare, makeDeps());
    const bareCreated = await bareManager.create({ cwd: PROJECT });
    bare.settleLaunch();
    await flush();
    expect(bareManager.get(bareCreated.sessionId)?.effort).toBeUndefined();
  });

  it('odrzucone `ready` przestawia sesję w `error` z powodem — karta nie wisi', async () => {
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, makeDeps());
    const created = await manager.create({ cwd: PROJECT, prompt: 'zrób X' });

    supervisor.settleLaunch(new Error('agent nie wstał w 20 s'));
    await flush();

    const session = manager.get(created.sessionId);
    expect(session?.state).toBe('error');
    expect(session?.stateDetail).toContain("couldn't create the pane");
  });

  it('odrzucone `ready` ze zdaniem własnym bez argumentów: `stateDetailRef` niesie jego kod jako podkod', async () => {
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, makeDeps());
    const created = await manager.create({ cwd: PROJECT, prompt: 'zrób X' });

    supervisor.settleLaunch(new HerdrGoneError(say('herdr.agent-vanished')));
    await flush();

    const session = manager.get(created.sessionId);
    expect(session?.state).toBe('error');
    expect(session?.stateDetailRef).toEqual({ code: 'state.herdr-launch-failed.code', args: ['herdr.agent-vanished'] });
  });

  it('drugie create() w tej samej sekundzie to 429, a panel NIE powstaje', async () => {
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, makeDeps(), { now: () => 1_000 });
    await manager.create({ cwd: PROJECT, prompt: 'pierwsza' });

    await expect(manager.create({ cwd: PROJECT, prompt: 'druga' }))
      .rejects.toBeInstanceOf(TooManyRequestsError);
    expect(supervisor.launches).toHaveLength(1);
  });

  it('sufit paneli Raroga to 409 i ZERO wywołań tworzących', async () => {
    const supervisor = makeSupervisor();
    supervisor.paneCount = 6;
    const manager = await build(supervisor, makeDeps(), { maxPanes: 6 });

    await expect(manager.create({ cwd: PROJECT, prompt: 'siódma' }))
      .rejects.toBeInstanceOf(BadStateError);
    expect(supervisor.launches).toHaveLength(0);
  });

  it('przy suficie komunikat mówi o LIMICIE, nawet gdy nadzorca zgasił też `canLaunch`',
    async () => {
      /*
       * The supervisor turns `canLaunch` off for several reasons at once (killswitches,
       * unavailable herdr, cap), a komunikat może być jeden. Przy odwrotnej kolejności sprawdzeń siódmy panel
       * dostawał „zakładanie wyłączone” z nazwą killswitcha zakładania — zdanie NIEPRAWDZIWE, które
       * kazałoby użytkownikowi szukać flagi w konfiguracji zamiast zamknąć jedną sesję.
       */
      const supervisor = makeSupervisor();
      supervisor.paneCount = 6;
      supervisor.setStatus({ canLaunch: false });
      const manager = await build(supervisor, makeDeps(), { maxPanes: 6 });

      await expect(manager.create({ cwd: PROJECT, prompt: 'siódma' }))
        .rejects.toThrow(HERDR_PANE_CAP_MESSAGE.text);
      expect(supervisor.launches).toHaveLength(0);
    });

  it('canLaunch:false (RAROG_HERDR_LAUNCH=0) to 409 i ZERO wywołań tworzących', async () => {
    const supervisor = makeSupervisor();
    supervisor.setStatus({ canLaunch: false });
    const manager = await build(supervisor, makeDeps());

    await expect(manager.create({ cwd: PROJECT, prompt: 'nowa' }))
      .rejects.toBeInstanceOf(BadStateError);
    expect(supervisor.launches).toHaveLength(0);
  });

  it('prompt odrzucony przez guard NIE zostawia po sobie panelu', async () => {
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, makeDeps());

    await expect(manager.create({ cwd: PROJECT, prompt: '/hooks add' }))
      .rejects.toBeInstanceOf(BadRequestError);
    // Reguła 11.9: cokolwiek Rarog stworzy i czego nie umie dokończyć, ma zostać posprzątane
    // — najtaniej przez nietworzenie tego wcale.
    expect(supervisor.launches).toHaveLength(0);
  });

  it('resumeFrom z transkryptu spoza katalogu to 400 i ZERO wywołań tworzących', async () => {
    const supervisor = makeSupervisor();
    const deps = makeDeps();
    // Transkrypt istnieje, ale należy do INNEGO katalogu: `--resume` międzykatalogowy DZIAŁA,
    // więc bez tej walidacji jedno pole w POST ładowałoby na telefon cudzą historię.
    deps.cwdByFile.set('/store/atlas.jsonl', '/Users/u/Projects/cudze');
    const manager = await build(supervisor, deps);

    await expect(manager.create({ cwd: PROJECT, resumeFrom: ENGINE_SESSION }))
      .rejects.toBeInstanceOf(BadRequestError);
    expect(supervisor.launches).toHaveLength(0);
  });

  /*
   * A conversation started in the project and `cd` moved it to an agent worktree. Every line of the conversation file
   * carries `cwd`, a new one after a directory change (after `/cd` in
   * `commands/measured/config-plugin-cd-2.1.302.jsonl`, CLI 2.1.302), so the file tail lies UNDER the project while
   * the SDK list puts the conversation under the project. Exact equality would give 400 on every "Resume".
   */
  it.each([
    ['worktree agenta', `${PROJECT}/.claude/worktrees/agent-a462323964696f07a`],
    ['podkatalog', `${PROJECT}/Packages/Core/Sources`],
  ])('resumeFrom z ogonem pliku pod katalogiem projektu (%s) przechodzi', async (_label, tail) => {
    const supervisor = makeSupervisor();
    const deps = makeDeps();
    deps.cwdByFile.set('/store/atlas.jsonl', tail);
    const manager = await build(supervisor, deps);

    const created = await manager.create({ cwd: PROJECT, resumeFrom: ENGINE_SESSION });
    expect(created.state).toBe('starting');
    // Panel wstaje w katalogu projektu, nie w katalogu z ogona pliku (worktree bywa już skasowany).
    expect(supervisor.launches[0]).toMatchObject({ cwd: PROJECT, resumeFrom: ENGINE_SESSION });
  });

  it.each([
    ['sąsiad o wspólnym przedrostku nazwy', `${PROJECT}-b`],
    ['katalog wyżej', '/Users/u/Projects'],
    ['wyjście przez `..`', `${PROJECT}/../cudze`],
    // Względne nie dostaje katalogu procesu serwera.
    ['ścieżka względna', 'server'],
    ['kropka', '.'],
  ])('resumeFrom z ogonem pliku poza projektem (%s) dalej to 400', async (_label, tail) => {
    const supervisor = makeSupervisor();
    const deps = makeDeps();
    deps.cwdByFile.set('/store/atlas.jsonl', tail);
    const manager = await build(supervisor, deps);

    await expect(manager.create({ cwd: PROJECT, resumeFrom: ENGINE_SESSION }))
      .rejects.toThrow(RESUME_FOREIGN_CWD_MESSAGE.text);
    expect(supervisor.launches).toHaveLength(0);
  });

  it('resumeFrom bez pliku w magazynie to 400 przed dotknięciem gniazda', async () => {
    const supervisor = makeSupervisor();
    const deps = makeDeps();
    deps.transcripts.clear();
    const manager = await build(supervisor, deps);

    await expect(manager.create({ cwd: PROJECT, resumeFrom: ENGINE_SESSION }))
      .rejects.toBeInstanceOf(BadRequestError);
    expect(supervisor.launches).toHaveLength(0);
  });

  it('UKRYTA, ale ŻYWA sesja blokuje wznowienie (dziura, którą zamyka blokada podwójnego pisarza)', async () => {
    const deps = makeDeps();
    const { manager, supervisor, id } = await withOneAgent(makeAgent(), deps);
    // Ukrycie zdejmuje sesję z indeksu pisarzy w RAM — ale panel ŻYJE i dalej pisze do jsonl.
    await manager.close(id);
    supervisor.liveEngines = new Set([ENGINE_SESSION]);

    await expect(manager.create({ cwd: PROJECT, resumeFrom: ENGINE_SESSION }))
      .rejects.toBeInstanceOf(BadStateError);
    expect(supervisor.launches).toHaveLength(0);
  });

  /*
   * `agent.list` sees ONLY herdr panels, so a `claude` started by hand in a bare tmux would pass this gate and Rarog
   * would add a second `--resume` process on the same jsonl file. `claude agents --json` sees both.
   */
  it('sesja żywa POZA herdr też blokuje wznowienie (rejestr CLI)', async () => {
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, makeDeps(), {
      liveSessionsReader: () => Promise.resolve(new Set([ENGINE_SESSION])),
    });
    // herdr o niej nie wie — i to jest cały sens tego testu.
    expect(supervisor.liveEngines.size).toBe(0);

    await expect(manager.create({ cwd: PROJECT, resumeFrom: ENGINE_SESSION }))
      .rejects.toBeInstanceOf(BadStateError);
    expect(supervisor.launches).toHaveLength(0);
  });

  it('cisza rejestru CLI („nie wiem") NIE blokuje wznowienia', async () => {
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, makeDeps(), {
      liveSessionsReader: () => Promise.resolve(null),
    });

    const created = await manager.create({ cwd: PROJECT, resumeFrom: ENGINE_SESSION });
    expect(created.state).toBe('starting');
  });

  it('`fork` przechodzi mimo żywego pisarza — nowy uuid, jeden pisarz', async () => {
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, makeDeps());
    supervisor.liveEngines = new Set([ENGINE_SESSION]);

    const created = await manager.create({
      cwd: PROJECT, resumeFrom: ENGINE_SESSION, fork: true,
    });
    expect(created.state).toBe('starting');
    expect(supervisor.launches[0]).toMatchObject({ resumeFrom: ENGINE_SESSION, fork: true });
  });

  describe('ultracode: start flagą i stan karty', () => {
    const versionReader = (installed: string | null) => (): Promise<CliVersionSnapshot> =>
      Promise.resolve({ installed, registry: null });

    it('start z ultracode: flaga w zleceniu, karta na xhigh z żądanym ultracode, driver dostaje chwilę żądania', async () => {
      const supervisor = makeSupervisor();
      const manager = await build(supervisor, makeDeps(), {
        cliVersionReader: versionReader('2.1.317'), accountDefaultEffort: () => 'medium',
      });
      await flush(8);
      const created = await manager.create({ cwd: PROJECT, model: 'opus[1m]', ultracode: true });

      expect(supervisor.launches[0]).toEqual({ cwd: PROJECT, model: 'opus[1m]', ultracode: true });
      expect(manager.get(created.sessionId)?.effort).toBe('xhigh');
      expect(manager.get(created.sessionId)?.ultracode).toBe(true);
      expect(supervisor.driver('w0:new1').ultracodeRequests.map(({ firstTurn }) => firstTurn)).toEqual([true]);
    });

    it('ultracode z jawnym xhigh przechodzi; z innym poziomem 400, zanim cokolwiek powstanie', async () => {
      const supervisor = makeSupervisor();
      const manager = await build(supervisor, makeDeps(), { cliVersionReader: versionReader('2.1.284') });
      await flush(8);
      await expect(manager.create({ cwd: PROJECT, effort: 'high', ultracode: true }))
        .rejects.toMatchObject({ code: 'ultracode-refused', message: ULTRACODE_EFFORT_MESSAGE.text });
      expect(supervisor.launches).toEqual([]);
      await manager.create({ cwd: PROJECT, effort: 'xhigh', ultracode: true });
      expect(supervisor.launches[0]).toEqual({ cwd: PROJECT, effort: 'xhigh', ultracode: true });
    });

    it('bramka wersji ZAINSTALOWANEJ: nieznana i za stara dają 400 bez panelu i bez spalonego slotu', async () => {
      const unknown = makeSupervisor();
      const blind = await build(unknown, makeDeps());
      const blindRefusal = blind.create({ cwd: PROJECT, ultracode: true });
      // Własny kod (`ultracode-refused`), nie `bad-request`: apka nie stawia tej odmowy przy polu ścieżki.
      await expect(blindRefusal).rejects.toBeInstanceOf(UltracodeRefusedError);
      await expect(blindRefusal).rejects.toMatchObject({ code: 'ultracode-refused' });
      await expect(blindRefusal).rejects.toThrow(ULTRACODE_CLI_UNKNOWN_MESSAGE.text);
      expect(unknown.launches).toEqual([]);
      // Slot startu (jeden na 5 s) nie poszedł na odrzucone żądanie.
      await blind.create({ cwd: PROJECT });
      expect(unknown.launches).toEqual([{ cwd: PROJECT }]);

      const old = makeSupervisor();
      const manager = await build(old, makeDeps(), { cliVersionReader: versionReader('2.1.283') });
      await flush(8);
      const refusal = manager.create({ cwd: PROJECT, ultracode: true });
      await expect(refusal).rejects.toBeInstanceOf(UltracodeRefusedError);
      await expect(refusal).rejects.toThrow(ultracodeCliTooOldMessage('2.1.283').text);
      expect(old.launches).toEqual([]);
    });

    /*
     * Zmiana w locie liczy wersję PROCESU (rejestr CLI) wobec progu 2.1.284 z docs (`ULTRACODE_MIN_CLI`). Świeży
     * panel od Raroga może jeszcze nie mieć wpisu w rejestrze: wtedy liczy się wersja zainstalowana z chwili startu
     * (`cliVersionAtLaunch`), a nie „nie znam wersji”.
     */
    async function createdWithCommands(installed: string): Promise<{
      manager: Manager; id: string; sent: string[];
    }> {
      const supervisor = makeSupervisor();
      const manager = await build(supervisor, makeDeps(), { cliVersionReader: versionReader(installed) });
      await flush(8);
      const created = await manager.create({ cwd: PROJECT, effort: 'high' });
      const driver = supervisor.driver('w0:new1');
      const sent: string[] = [];
      Object.assign(driver, { sendCommands: (commands: readonly string[]) => { sent.push(...commands); } });
      // Panel gotowy: do tego karta z Raroga stoi w `starting` i zmiana w locie nie ma czego dotknąć.
      supervisor.settleLaunch();
      driver.queue.push({ type: 'agent-state', state: 'idle', seen: true });
      await flush();
      return { manager, id: created.sessionId, sent };
    }

    it('zmiana w locie bez wpisu w rejestrze: zapasem wersja zainstalowana z chwili startu przez Raroga', async () => {
      const { manager, id, sent } = await createdWithCommands('2.1.317');
      await expect(manager.setModel(id, { ultracode: true })).resolves.toEqual({ ok: true, warning: ULTRACODE_CHANGE_NOTE.text, warningRef: ULTRACODE_CHANGE_NOTE.ref });
      expect(sent).toEqual([ULTRACODE_COMMANDS.on]);
    });

    it('zmiana w locie: zapasowa wersja z chwili startu niższa niż wymagana to 400 „za stare”', async () => {
      const { manager, id, sent } = await createdWithCommands('2.1.283');
      await expect(manager.setModel(id, { ultracode: false })).rejects.toThrow(ultracodeCliTooOldMessage('2.1.283').text);
      expect(sent).toEqual([]);
    });

    it('bez flagi karta nie ma pola, a driver nie dostaje żądania (decydują ustawienia Claude Code)', async () => {
      const supervisor = makeSupervisor();
      const manager = await build(supervisor, makeDeps(), { cliVersionReader: versionReader('2.1.317') });
      await flush(8);
      const created = await manager.create({ cwd: PROJECT, effort: 'xhigh' });

      expect(supervisor.launches[0]).toEqual({ cwd: PROJECT, effort: 'xhigh' });
      expect('ultracode' in (manager.get(created.sessionId) ?? {})).toBe(false);
      expect(supervisor.driver('w0:new1').ultracodeRequests).toEqual([]);
    });

    it('nowa rozmowa w panelu (`/clear`): pole znika do dowodu z jej pliku', async () => {
      const { manager, supervisor, id } = await withOneAgent();
      supervisor.driver('w9:p72').queue.push({
        type: 'init', engineSessionId: ENGINE_SESSION, model: 'claude-opus-5', ultracode: true,
      });
      await flush();
      expect(manager.get(id)?.ultracode).toBe(true);

      const events = record(manager);
      const next = '22222222-2222-4222-8222-222222222222';
      supervisor.driver('w9:p72').queue.push({ type: 'init', engineSessionId: next, model: '' });
      await flush();
      expect('ultracode' in (manager.get(id) ?? {})).toBe(false);
      expect(events.filter((e) => e.scope === 'global' && e.event.type === 'session-changed').length)
        .toBeGreaterThan(0);

      supervisor.driver('w9:p72').queue.push({ type: 'init', engineSessionId: next, model: '', ultracode: true });
      await flush();
      expect(manager.get(id)?.ultracode).toBe(true);
    });

    it('restart procesu CLI w panelu (`init` z `ultracode: null`, ta sama rozmowa): pole znika z karty', async () => {
      const { manager, supervisor, id } = await withOneAgent();
      supervisor.driver('w9:p72').queue.push({
        type: 'init', engineSessionId: ENGINE_SESSION, model: 'claude-opus-5', ultracode: true,
      });
      await flush();
      expect(manager.get(id)?.ultracode).toBe(true);

      const events = record(manager);
      supervisor.driver('w9:p72').queue.push({
        type: 'init', engineSessionId: ENGINE_SESSION, model: 'claude-opus-5', ultracode: null,
      });
      await flush();
      expect('ultracode' in (manager.get(id) ?? {})).toBe(false);
      expect(events.filter((e) => e.scope === 'global' && e.event.type === 'session-changed')).toHaveLength(1);
    });
  });

  it('resume() sesji z zamkniętym panelem daje TEN SAM sessionId', async () => {
    const deps = makeDeps();
    const { manager, supervisor, id } = await withOneAgent(makeAgent(), deps);
    supervisor.emit({ type: 'gone', key: 'w9:p72' });
    await flush();

    const resumed = await manager.resume(id);

    expect(resumed.id).toBe(id);
    expect(supervisor.launches[0]).toMatchObject({ resumeFrom: ENGINE_SESSION });
    /*
     * Alias `engineSessionId → sessionId` jest zapisany — i to ON trzyma tę obietnicę PO
     * restarcie Raroga, gdzie `sessionIdFor(key)` dałby nowy adres (nowy panel = nowy klucz).
     */
    expect(deps.aliases.get('aaaaaaaa-aaaa-4aaa-8aaa-000000000001')).toBe(id);
  });

  it('resume() sesji z ŻYWYM panelem to 409', async () => {
    const { manager, id } = await withOneAgent();
    await expect(manager.resume(id)).rejects.toBeInstanceOf(BadStateError);
  });

  it('close(closePanel) zamyka panel WŁASNY I CUDZY', async () => {
    // Decyzja użytkownika: „× ma zamykać, bez znaczenia czyja sesja". Odmowa została tylko
    // dla sesji bez panelu w herdr (nie ma czego adresować).
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, makeDeps());
    supervisor.appear(makeAgent());
    await flush();
    const cudzy = manager.list()[0]?.id ?? '';

    // Cudzy panel: dokładnie jedno zamknięcie, karta znika.
    await manager.close(cudzy, { closePanel: true });
    expect(supervisor.closeTabCalls).toEqual(['w9:p72']);
    expect(manager.get(cudzy)).toBeUndefined();

    // Własny (założony przez Raroga): tak samo.
    const created = await manager.create({ cwd: PROJECT });
    supervisor.settleLaunch();
    await flush();
    await manager.close(created.sessionId, { closePanel: true });
    expect(supervisor.closeTabCalls).toEqual(['w9:p72', 'w0:new1']);
    expect(manager.get(created.sessionId)).toBeUndefined();
  });

  it('close(closePanel) na SZAREJ karcie (panel już zniknął) zdejmuje kartę zamiast 410',
    async () => {
      /*
       * A Rarog panel closed by hand in the terminal (`gone`) leaves a `done` card with `launchedByRarog`, so the UI
       * sends `closePanel: true` and `closeTab` answers `HerdrGoneError`. `gone` while closing means "no panel, only
       * the card is left", and the card goes away instead of a 410 on every attempt until a server restart.
       */
      const supervisor = makeSupervisor();
      const manager = await build(supervisor, makeDeps());
      const created = await manager.create({ cwd: PROJECT });
      supervisor.settleLaunch();
      await flush();
      supervisor.emit({ type: 'gone', key: 'w0:new1' });
      await flush();
      supervisor.vanished.add('w0:new1');
      expect(manager.get(created.sessionId)?.state).toBe('done');

      await manager.close(created.sessionId, { closePanel: true });
      // Panelu nie było czego zamykać — liczy się zdjęcie karty, nie `tab.close`.
      expect(supervisor.closeTabCalls).toEqual([]);
      expect(manager.get(created.sessionId)).toBeUndefined();
    });

  it('focus() na padniętym gnieździe to 409 po polsku, nie 500 z gniazda', async () => {
    /*
     * `focus()` była — obok `close(closePanel)` — jedyną ścieżką MUTUJĄCĄ bez pre-checku
     * `status().available`. `HerdrUnavailableError` z gniazda ma kod `herdr-unavailable`,
     * którego `managerErrorStatus` nie zna, więc tapnięcie „Pokaż w herdr" w oknie awarii
     * kończyło się generycznym „Błąd serwera." zamiast zdania „poczekaj, aż herdr wróci".
     * Bramka stoi PRZED killswitchem zapisu, bo niedostępność jest stanem transportu:
     * `readOnly` przy padniętym gnieździe wciąż mówi „wolno pisać".
     */
    const { manager, supervisor, id } = await withOneAgent();
    supervisor.setStatus({ available: false });

    const err = await manager.focus(id).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(BadStateError);
    expect((err as Error).message).toBe(HERDR_TERMINAL_UNAVAILABLE_MESSAGE.text);
    // Zero bajtów w gnieździe: odmowa jest lokalna, nie odbita od martwego transportu.
    expect(supervisor.focusCalls).toEqual([]);

    // Po powrocie herdr ta sama akcja przechodzi — bramka nie jest trwałym zakazem.
    supervisor.setStatus({ available: true });
    await expect(manager.focus(id)).resolves.toBeUndefined();
    expect(supervisor.focusCalls).toEqual(['w9:p72']);
  });

  it('close(closePanel) na padniętym gnieździe odmawia PRZED pierwszą mutacją',
    async () => {
      /*
       * Tu bramka ma dwie robotki. Pierwsza jak w `focus()`: 409 zamiast 500. Druga jest
       * cięższa — `#expirePending` i `#detachDriver` biegły PRZED rzucającym `tab.close`,
       * więc nieudane „×" gasiło wiszącą decyzję (event `expired`) i zostawiało kartę bez
       * drivera do najbliższego obrotu resyncu. Odmowa przed czymkolwiek zostawia sesję
       * dokładnie taką, jaka była.
       */
      const { manager, supervisor, id } = await withOneAgent();
      const driver = supervisor.driver('w9:p72');
      driver.queue.push({
        type: 'permission-request',
        reqId: 'tool-1',
        toolName: 'Bash',
        input: { command: 'ls' },
        displayText: 'ls',
      });
      await flush();
      expect(manager.transcript(id).pendingPermissions).toHaveLength(1);

      supervisor.setStatus({ available: false });
      const err = await manager.close(id, { closePanel: true }).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(BadStateError);
      expect((err as Error).message).toBe(HERDR_TERMINAL_UNAVAILABLE_MESSAGE.text);

      // Nic nie zostało zmienione: karta, decyzja i driver są na miejscu.
      expect(manager.get(id)).not.toBeUndefined();
      expect(manager.transcript(id).pendingPermissions).toHaveLength(1);
      expect(driver.disposals).toBe(0);
      expect(supervisor.closeTabCalls).toEqual([]);

      // Po powrocie herdr „×" robi swoje — odmowa była na czas awarii, nie na zawsze.
      supervisor.setStatus({ available: true });
      await manager.close(id, { closePanel: true });
      expect(supervisor.closeTabCalls).toEqual(['w9:p72']);
      expect(manager.get(id)).toBeUndefined();
    });

  /*
   * Powiadomienie o karcie zgody/pytania w sesji herdr.
   *
   * Kolejność zdarzeń jest tu strukturalna, nie wyścigowa: driver melduje `blocked` NATYCHMIAST
   * (żeby composer zgasł i karta zrobiła się bursztynowa), a treść dialogu składa dopiero po
   * uzgodnieniu ekranu z jsonl — 1–2 s później. Sesja jest więc już w `waiting-permission`,
   * gdy powstaje karta, a `transition('waiting-permission', 'permission-requested')` to
   * TOŻSAMOŚĆ. `#applyTransition` wychodzi przed blokiem powiadomień, więc bez osobnej
   * ścieżki powstanie karty NIE zawiadamia o niczym: jedyny push leci z `agent-blocked`, w chwili
   * gdy pending jest pusty — czyli bez nazwy narzędzia i bez treści pytania. Jeśli tamten
   * wyciszy obecność, sprawa milknie na zawsze.
   */
  describe('powiadomienia o karcie decyzji w sesji herdr', () => {
    const spyNotes = (): { notifier: NotifierLike; notes: NoteInput[] } => {
      const notes: NoteInput[] = [];
      return {
        notes,
        notifier: {
          note: (input) => { notes.push(input); },
          seen: () => undefined,
          forget: () => undefined, quiet: () => undefined,
        },
      };
    };

    it('zgoda zgłoszona nad STOJĄCYM dialogiem zawiadamia — z nazwą narzędzia', async () => {
      const spy = spyNotes();
      const supervisor = makeSupervisor();
      const manager = await build(supervisor, makeDeps(), { notifier: spy.notifier });
      supervisor.appear(makeAgent());
      await flush();
      const id = manager.list().find((s) => s.paneId !== undefined)?.id ?? '';
      const driver = supervisor.driver('w9:p72');

      // 1. Panel staje na dialogu — sesja wchodzi w `waiting-permission`.
      driver.queue.push({ type: 'agent-state', state: 'blocked' });
      await flush();
      expect(manager.get(id)?.state).toBe('waiting-permission');

      // 2. Dopiero TERAZ driver wie, czego dialog dotyczy.
      driver.queue.push({
        type: 'permission-request',
        reqId: 'tool-1',
        toolName: 'Bash',
        input: { command: 'git push --force' },
        displayText: 'git push --force',
      });
      await flush();

      const note = spy.notes.find((n) => n.event.type === 'permission-requested');
      expect(note).not.toBeUndefined();
      // Nazwa narzędzia, nigdy komenda — baner ląduje na ekranie blokady.
      expect(note?.detail?.text).toBe('Bash');
    });

    it('pytanie zgłoszone nad stojącym dialogiem zawiadamia jego treścią', async () => {
      const spy = spyNotes();
      const supervisor = makeSupervisor();
      const manager = await build(supervisor, makeDeps(), { notifier: spy.notifier });
      supervisor.appear(makeAgent());
      await flush();
      const id = manager.list().find((s) => s.paneId !== undefined)?.id ?? '';
      const driver = supervisor.driver('w9:p72');

      driver.queue.push({ type: 'agent-state', state: 'blocked' });
      await flush();
      expect(manager.get(id)?.state).toBe('waiting-permission');

      driver.queue.push({
        type: 'question-request',
        reqId: 'q-1',
        questions: [{
          question: 'Który wariant zapisu wybrać?',
          header: 'Zapis pliku',
          multiSelect: false,
          options: [{ label: 'Atomowy' }, { label: 'W miejscu' }],
        }],
      });
      await flush();

      const note = spy.notes.find((n) => n.event.type === 'question-requested');
      expect(note?.detail?.text).toBe('Który wariant zapisu wybrać?');
    });
  });

  /*
   * A session that is only starting does not end a turn. Two ways out of `starting`: herdr's first `idle` (a panel
   * found in `unknown`, a Rarog session before it is ready) and the zero turn of a session without a prompt
   * (`#settleEmptyStart`: a new empty session, a resume). Neither may send "✅ Skończył" with the tile sound before
   * anyone sent a prompt.
   */
  describe('start sesji a push „gotowe”', () => {
    /** Prawdziwy harmonogram nad prawdziwym managerem; timery odpala test (`fire`). */
    async function startHarness(deps = makeDeps()): Promise<{
      manager: Manager; supervisor: FakeSupervisor; sent: PushContent[]; logs: string[];
      notifier: Notifier; timers: () => number[]; fire: () => Promise<void>;
    }> {
      const sent: PushContent[] = [];
      const logs: string[] = [];
      const timers = new Map<number, { ms: number; cb: () => void }>();
      let nextTimer = 1;
      let managerRef: Manager | null = null;
      const notifier = new Notifier({
        presence: new Presence(),
        sink: { send: (content) => { sent.push(content); return Promise.resolve({ channels: { apns: 'delivered' } }); } },
        look: (sessionId) => sessionLook(managerRef?.get(sessionId)),
        log: (line) => { logs.push(line); },
        setTimeout: (cb, ms) => {
          const handle = nextTimer++;
          timers.set(handle, { ms, cb });
          return handle;
        },
        clearTimeout: (handle) => { timers.delete(handle as number); },
      });
      const supervisor = makeSupervisor();
      const manager = await build(supervisor, deps, { notifier });
      managerRef = manager;
      const fire = async (): Promise<void> => {
        const due = [...timers.values()];
        timers.clear();
        for (const timer of due) timer.cb();
        await flush();
      };
      return {
        manager, supervisor, sent, logs, notifier, fire, timers: () => [...timers.values()].map((t) => t.ms),
      };
    }
    const START_LOG = `${PUSH_QUIET_LOG} atlas (done, session start)`;

    it('panel zastany w `unknown`: pierwsze `idle` ciche, następna tura daje „gotowe”', async () => {
      const h = await startHarness();
      h.supervisor.autoSettle = false;
      h.supervisor.appear(makeAgent({ status: 'unknown' }));
      await flush();
      const id = h.manager.list().find((s) => s.paneId !== undefined)?.id ?? '';
      expect(h.manager.get(id)?.state).toBe('starting');
      const driver = h.supervisor.driver('w9:p72');

      driver.queue.push({ type: 'agent-state', state: 'idle' });
      await flush();
      expect(h.manager.get(id)?.state).toBe('waiting-input');
      expect(h.notifier.pending).toBe(0);
      expect(h.logs).toContain(START_LOG);

      // Zwykły koniec tury (`running → waiting-input`) zostaje taki jak był.
      driver.queue.push({ type: 'agent-state', state: 'working' });
      await flush();
      driver.queue.push({ type: 'agent-state', state: 'idle' });
      await flush();
      expect(h.timers()).toEqual([FIRST_CHECK_MS.done]);
      await h.fire();
      expect(h.sent.map((content) => content.kind)).toEqual(['done']);
    });

    it.each([
      ['`idle` herdr przed gotowością panelu', true],
      ['tura zerowa po gotowości panelu', false],
    ])('nowa sesja z Raroga bez promptu: %s nie daje „gotowe”', async (_label, idleFirst) => {
      const h = await startHarness();
      h.supervisor.autoSettle = idleFirst;
      const created = await h.manager.create({ cwd: PROJECT });
      await flush();
      h.supervisor.settleLaunch();
      await flush();

      expect(h.manager.get(created.sessionId)?.state).toBe('waiting-input');
      expect(h.notifier.pending).toBe(0);
      expect(h.logs).toContain(START_LOG);
      await h.fire();
      expect(h.sent).toEqual([]);
    });

    /*
     * Dialog startowy przed gotowością panelu: stojący daje push „czeka na decyzję” jak dotąd, a jego
     * zamknięcie i wstanie panelu to wciąż start sesji, nie koniec tury. „Gotowe” daje dopiero prawdziwa tura.
     */
    it('nowa sesja z Raroga z dialogiem startowym: push dialogu, po nim wstanie bez „gotowe”', async () => {
      const h = await startHarness();
      h.supervisor.autoSettle = false;
      const created = await h.manager.create({ cwd: PROJECT });
      await flush();
      const id = created.sessionId;
      const driver = h.supervisor.driver('w0:new1');

      driver.queue.push({ type: 'screen-dialog', knownDialog: 'trust' });
      await flush();
      expect(h.timers()).toEqual([FIRST_CHECK_MS.blocking]);
      await h.fire();
      expect(h.sent.map((content) => content.kind)).toEqual(['blocked']);

      await h.manager.resolvePermission(id, id, 'allow', 'iPhone');
      driver.queue.push({ type: 'agent-state', state: 'idle' });
      await flush();
      expect(h.manager.get(id)?.state).toBe('starting');
      h.supervisor.settleLaunch();
      await flush();
      expect(h.manager.get(id)?.state).toBe('waiting-input');
      expect(h.notifier.pending).toBe(0);
      await h.fire();
      expect(h.sent.map((content) => content.kind)).toEqual(['blocked']);

      await h.manager.sendMessage(id, 'zrób coś');
      await flush();
      driver.queue.push({ type: 'agent-state', state: 'working' });
      await flush();
      driver.queue.push({ type: 'agent-state', state: 'idle' });
      await flush();
      await h.fire();
      expect(h.sent.map((content) => content.kind)).toEqual(['blocked', 'done']);
    });

    it('wznowienie rozmowy z Raroga (`resumeFrom`) wstaje bez „gotowe”', async () => {
      const deps = makeDeps();
      deps.cwdByFile.set('/store/atlas.jsonl', PROJECT);
      const h = await startHarness(deps);
      h.supervisor.autoSettle = false;
      const created = await h.manager.create({ cwd: PROJECT, resumeFrom: ENGINE_SESSION });
      h.supervisor.settleLaunch();
      await flush();

      expect(h.manager.get(created.sessionId)?.state).toBe('waiting-input');
      expect(h.notifier.pending).toBe(0);
      expect(h.sent).toEqual([]);
    });

    /*
     * Follower czyta przy podpięciu historię istniejącego pliku i oddaje jej model
     * jako `init`. Karta z Raroga stoi wtedy w `starting` do gotowości panelu, a pierwsze wyjście
     * z tury po gotowości to wstanie, nie koniec tury.
     */
    it('wznowienie: `init` z historii pliku przed pierwszym `idle` dalej bez „gotowe”, prawdziwa tura z nim', async () => {
      const deps = makeDeps();
      deps.cwdByFile.set('/store/atlas.jsonl', PROJECT);
      const h = await startHarness(deps);
      h.supervisor.autoSettle = false;
      const created = await h.manager.create({ cwd: PROJECT, resumeFrom: ENGINE_SESSION });
      await flush();
      const driver = h.supervisor.driver('w0:new1');
      driver.queue.push({ type: 'init', engineSessionId: ENGINE_SESSION, model: 'claude-opus-5-5' });
      await flush();
      expect(h.manager.get(created.sessionId)?.state).toBe('starting');
      driver.queue.push({ type: 'agent-state', state: 'idle' });
      await flush();
      h.supervisor.settleLaunch();
      await flush();

      expect(h.manager.get(created.sessionId)?.state).toBe('waiting-input');
      expect(h.notifier.pending).toBe(0);
      expect(h.logs).toContain(START_LOG);

      driver.queue.push({ type: 'agent-state', state: 'working' });
      await flush();
      driver.queue.push({ type: 'agent-state', state: 'idle' });
      await flush();
      await h.fire();
      expect(h.sent.map((content) => content.kind)).toEqual(['done']);
    });

    it('panel zastany w `unknown` z historią: `init`, potem praca przy biurku — jej koniec daje „gotowe”', async () => {
      const h = await startHarness();
      h.supervisor.autoSettle = false;
      h.supervisor.appear(makeAgent({ status: 'unknown' }));
      await flush();
      const id = h.manager.list().find((s) => s.paneId !== undefined)?.id ?? '';
      const driver = h.supervisor.driver('w9:p72');
      driver.queue.push({ type: 'init', engineSessionId: ENGINE_SESSION, model: 'claude-opus-5-5' });
      await flush();
      expect(h.manager.get(id)?.state).toBe('running');
      // `working` przy karcie już w `running` to przejście-tożsamość — i tak zaczyna turę.
      driver.queue.push({ type: 'agent-state', state: 'working' });
      await flush();
      driver.queue.push({ type: 'agent-state', state: 'idle' });
      await flush();
      expect(h.timers()).toEqual([FIRST_CHECK_MS.done]);
      await h.fire();
      expect(h.sent.map((content) => content.kind)).toEqual(['done']);
    });

    it('wysyłka z Raroga do karty w `running` po `init` z historii — koniec jej tury daje „gotowe”', async () => {
      const h = await startHarness();
      h.supervisor.autoSettle = false;
      h.supervisor.appear(makeAgent({ status: 'unknown' }));
      await flush();
      const id = h.manager.list().find((s) => s.paneId !== undefined)?.id ?? '';
      const driver = h.supervisor.driver('w9:p72');
      driver.queue.push({ type: 'init', engineSessionId: ENGINE_SESSION, model: 'claude-opus-5-5' });
      await flush();
      await h.manager.sendMessage(id, 'zrób coś');
      await flush();
      driver.queue.push({ type: 'agent-state', state: 'idle' });
      await flush();
      expect(h.timers()).toEqual([FIRST_CHECK_MS.done]);
    });

    it('dialog prosto ze `starting` (zaufanie katalogu, pytanie `--resume`) dalej daje push', async () => {
      const h = await startHarness();
      h.supervisor.autoSettle = false;
      h.supervisor.appear(makeAgent({ status: 'unknown' }));
      await flush();

      h.supervisor.driver('w9:p72').queue.push({ type: 'agent-state', state: 'blocked' });
      await flush();
      expect(h.timers()).toEqual([FIRST_CHECK_MS.blocking]);
      await h.fire();
      expect(h.sent.map((content) => content.kind)).toEqual(['blocked']);
    });
  });

  /*
   * Subagent w postoju (`waitingSince`) nie jest pracą. Manager sam niczego nie liczy:
   * liczbę zadań wstrzymujących „gotowe" bierze z `work.ts` przy uzbrojeniu (`#note`), a harmonogram
   * pyta o nią drugi raz tuż przed wysyłką (`sessionLook`).
   */
  describe('subagent w postoju a push „gotowe"', () => {
    const AT = '2026-10-10T06:00:00.000Z';
    const waitingAgent: BackgroundTask = {
      id: 'a52b91f105b002e8d', kind: 'agent', description: 'Shared views', startedAt: AT, waitingSince: AT,
      ownTasks: [{ id: 'bjvzo6rnl', command: 'until grep -q TEST log.txt; do sleep 5; done' }],
    };
    const { waitingSince: _since, ...awake } = waitingAgent;
    void _since;
    const workingAgent: BackgroundTask = awake;
    const command: BackgroundTask = { id: 'b28xs0cd6', kind: 'command', command: 'pnpm test' };

    /** Tura wpisana na Macu: `working`, potem `idle`. Lista zadań stoi od początku. */
    async function turnWith(tasks: BackgroundTask[]): Promise<NoteInput[]> {
      const notes: NoteInput[] = [];
      const notifier: NotifierLike = {
        note: (input) => { notes.push(input); }, seen: () => undefined, forget: () => undefined, quiet: () => undefined,
      };
      const supervisor = makeSupervisor();
      await build(supervisor, makeDeps(), { notifier });
      supervisor.appear(makeAgent());
      await flush();
      const driver = supervisor.driver('w9:p72');
      driver.queue.push({ type: 'background-tasks', tasks });
      driver.queue.push({ type: 'agent-state', state: 'working' });
      await flush();
      driver.queue.push({ type: 'agent-state', state: 'idle' });
      await flush();
      return notes.filter((n) => n.event.type === 'agent-idle');
    }

    it('uzbrojenie: sam czekający subagent nie wstrzymuje „gotowe"', async () => {
      const ends = await turnWith([waitingAgent]);
      expect(ends.map((n) => n.backgroundTasks)).toEqual([0]);
    });

    it('uzbrojenie: czekający obok pracującego subagenta albo komendy — wstrzymuje tylko to, co pracuje', async () => {
      expect((await turnWith([waitingAgent, workingAgent])).map((n) => n.backgroundTasks)).toEqual([1]);
      expect((await turnWith([waitingAgent, command])).map((n) => n.backgroundTasks)).toEqual([1]);
      expect((await turnWith([workingAgent, command])).map((n) => n.backgroundTasks)).toEqual([2]);
    });

    /** Prawdziwy harmonogram nad prawdziwym managerem; okno wysyłki odpala test (`fire`). */
    async function withRealNotifier(): Promise<{
      manager: Manager; driver: FakeHerdrDriver; id: string; sent: PushContent[]; logs: string[];
      notifier: Notifier; fire: () => Promise<void>;
    }> {
      const sent: PushContent[] = [];
      const logs: string[] = [];
      const timers = new Map<number, { ms: number; cb: () => void }>();
      let nextTimer = 1;
      let managerRef: Manager | null = null;
      const notifier = new Notifier({
        presence: new Presence(),
        sink: { send: (content) => { sent.push(content); return Promise.resolve({ channels: { apns: 'delivered' } }); } },
        look: (sessionId) => sessionLook(managerRef?.get(sessionId)),
        log: (line) => { logs.push(line); },
        setTimeout: (cb, ms) => {
          const handle = nextTimer++;
          timers.set(handle, { ms, cb });
          return handle;
        },
        clearTimeout: (handle) => { timers.delete(handle as number); },
      });
      const supervisor = makeSupervisor();
      const manager = await build(supervisor, makeDeps(), { notifier });
      managerRef = manager;
      supervisor.appear(makeAgent());
      await flush();
      const id = manager.list().find((s) => s.paneId !== undefined)?.id ?? '';
      const fire = async (): Promise<void> => {
        const due = [...timers.entries()];
        timers.clear();
        for (const [, timer] of due) {
          expect(timer.ms).toBe(FIRST_CHECK_MS.done);
          timer.cb();
        }
        await flush();
      };
      return { manager, driver: supervisor.driver('w9:p72'), id, sent, logs, notifier, fire };
    }

    it('subagent wybudzony między uzbrojeniem a wysyłką kasuje „gotowe", choć stan sesji stoi', async () => {
      const h = await withRealNotifier();
      h.driver.queue.push({ type: 'background-tasks', tasks: [waitingAgent] });
      h.driver.queue.push({ type: 'agent-state', state: 'working' });
      await flush();
      h.driver.queue.push({ type: 'agent-state', state: 'idle' });
      await flush();
      expect(h.notifier.pending).toBe(1);

      // Skończyła się komenda subagenta: plik subagenta ma nowy wpis, `merge.ts` zdejmuje `waitingSince`.
      h.driver.queue.push({ type: 'background-tasks', tasks: [workingAgent] });
      await flush();
      expect(h.manager.get(h.id)?.state).toBe('waiting-input');
      expect(h.notifier.pending).toBe(1);

      await h.fire();
      expect(h.sent).toHaveLength(0);
      expect(h.notifier.pending).toBe(0);
      expect(h.logs.some((line) => line.includes('(done, state=waiting-input, working in the background: 1)'))).toBe(true);
    });

    it('subagent, który dalej czeka, nie kasuje niczego — „gotowe" wychodzi', async () => {
      const h = await withRealNotifier();
      h.driver.queue.push({ type: 'background-tasks', tasks: [waitingAgent] });
      h.driver.queue.push({ type: 'agent-state', state: 'working' });
      await flush();
      h.driver.queue.push({ type: 'agent-state', state: 'idle' });
      await flush();

      await h.fire();
      expect(h.sent.map((content) => content.kind)).toEqual(['done']);
    });

    it('pracujący subagent wstrzymuje od razu: koniec tury niczego nie uzbraja', async () => {
      const h = await withRealNotifier();
      h.driver.queue.push({ type: 'background-tasks', tasks: [workingAgent] });
      h.driver.queue.push({ type: 'agent-state', state: 'working' });
      await flush();
      h.driver.queue.push({ type: 'agent-state', state: 'idle' });
      await flush();
      expect(h.notifier.pending).toBe(0);
    });

    /*
     * Manager podaje harmonogramowi, czy subagent w postoju czeka
     * na własną komendę (`waitingOnOwnCommand` z `work.ts`), a harmonogram pyta o to drugi raz
     * przed wysyłką (`sessionLook`). Sam niczego nie liczy.
     */
    it('uzbrojenie: subagent w postoju z własną komendą jedzie w `waitingOnOwnCommand`', async () => {
      const { ownTasks: _own, ...waitingBare } = waitingAgent;
      void _own;
      expect((await turnWith([waitingAgent])).map((n) => n.waitingOnOwnCommand)).toEqual([true]);
      expect((await turnWith([waitingBare])).map((n) => n.waitingOnOwnCommand)).toEqual([undefined]);
      expect((await turnWith([workingAgent])).map((n) => n.waitingOnOwnCommand)).toEqual([undefined]);
      expect((await turnWith([command])).map((n) => n.waitingOnOwnCommand)).toEqual([undefined]);
    });

    it('zaległe „gotowe" po turze z samym postojem czeka na agenta z komendą — na prawdziwym harmonogramie', async () => {
      const STANDBY: TranscriptNotice = { kind: 'agent', outcome: 'waiting', name: 'Shared views' };
      const standbyNotice: DriverEvent = {
        type: 'message', role: 'user', blocks: [{ type: 'text', text: foreign('<task-notification>…</task-notification>') }],
        notice: STANDBY,
      };
      const { ownTasks: _own, ...waitingBare } = waitingAgent;
      void _own;
      const h = await withRealNotifier();
      const turn = async (...events: DriverEvent[]): Promise<void> => {
        for (const event of [...events, { type: 'agent-state', state: 'working' } as const]) {
          h.driver.queue.push(event);
          await flush();
        }
        h.driver.queue.push({ type: 'agent-state', state: 'idle' });
        await flush();
      };
      // Tura przy pracującym subagencie: cisza, wynik zaległy. Po niej rachunek tury jest pełny.
      await turn({ type: 'background-tasks', tasks: [workingAgent] });
      expect(h.notifier.pending).toBe(0);

      // Subagent stanął przy własnej komendzie; meldunek budzi głównego agenta.
      await turn({ type: 'background-tasks', tasks: [waitingAgent] }, standbyNotice);
      expect(h.notifier.pending).toBe(0);
      expect(h.logs.some((line) =>
        line.endsWith('(done, turn after a subagent standby alone, owed waits: the subagent waits for its own command)'))).toBe(true);

      // Komenda się skończyła bez wybudzenia; następny meldunek o postoju wypuszcza zaległe.
      await turn({ type: 'background-tasks', tasks: [waitingBare] }, standbyNotice);
      expect(h.notifier.pending).toBe(1);
      await h.fire();
      expect(h.sent.map((content) => content.kind)).toEqual(['done']);
    });

    it('kontrola przy wysyłce: komenda agenta doszła po końcu tury — zaległe „gotowe" gaśnie', async () => {
      const STANDBY: TranscriptNotice = { kind: 'agent', outcome: 'waiting', name: 'Shared views' };
      const standbyNotice: DriverEvent = {
        type: 'message', role: 'user', blocks: [{ type: 'text', text: foreign('<task-notification>…</task-notification>') }],
        notice: STANDBY,
      };
      const { ownTasks: _own, ...waitingBare } = waitingAgent;
      void _own;
      const h = await withRealNotifier();
      const turn = async (...events: DriverEvent[]): Promise<void> => {
        for (const event of [...events, { type: 'agent-state', state: 'working' } as const]) {
          h.driver.queue.push(event);
          await flush();
        }
        h.driver.queue.push({ type: 'agent-state', state: 'idle' });
        await flush();
      };
      await turn({ type: 'background-tasks', tasks: [workingAgent] });
      await turn({ type: 'background-tasks', tasks: [waitingBare] }, standbyNotice);
      expect(h.notifier.pending).toBe(1);

      // Odczyt pliku subagenta przyniósł jego komendę dopiero po końcu tury.
      h.driver.queue.push({ type: 'background-tasks', tasks: [waitingAgent] });
      await flush();
      await h.fire();
      expect(h.sent).toHaveLength(0);
      expect(h.logs.some((line) =>
        line.endsWith('(done, state=waiting-input, owed waits: the subagent waits for its own command)'))).toBe(true);
    });

    /*
     * Cisza w tle bez końca tury. Manager porównuje listę
     * przed i po zmianie (`holdsOwedDone` z `work.ts`) i przy spadku woła `NotifierLike.quiet`.
     */
    describe('cisza w tle bez tury → `quiet`', () => {
      const { ownTasks: _own, ...waitingBare } = waitingAgent;
      void _own;
      const QUIET_ARMED = '(check in 15 s, owed after the background went quiet)';

      /** Tura wpisana na Macu przy podanej liście: `working`, potem `idle`. */
      const turnAt = async (h: { driver: FakeHerdrDriver }, tasks: BackgroundTask[]): Promise<void> => {
        h.driver.queue.push({ type: 'background-tasks', tasks });
        h.driver.queue.push({ type: 'agent-state', state: 'working' });
        await flush();
        h.driver.queue.push({ type: 'agent-state', state: 'idle' });
        await flush();
      };
      const frame = async (h: { driver: FakeHerdrDriver }, tasks: BackgroundTask[]): Promise<void> => {
        h.driver.queue.push({ type: 'background-tasks', tasks });
        await flush();
      };

      it('postój z komendą → ramka bez komendy → `quiet` → „gotowe" z prawdziwego harmonogramu', async () => {
        const h = await withRealNotifier();
        await turnAt(h, [workingAgent]);
        expect(h.notifier.pending).toBe(0);

        // Subagent stanął przy własnej komendzie; komenda skończyła się, agent nie wstał.
        await frame(h, [waitingAgent]);
        expect(h.notifier.pending).toBe(0);
        await frame(h, [waitingBare]);
        expect(h.manager.get(h.id)?.state).toBe('waiting-input');
        expect(h.notifier.pending).toBe(1);
        expect(h.logs.some((line) => line.endsWith(QUIET_ARMED))).toBe(true);

        await h.fire();
        expect(h.sent.map((content) => content.kind)).toEqual(['done']);
      });

      it('dwie ramki bez wstrzymania z rzędu → jedno uzbrojenie', async () => {
        const h = await withRealNotifier();
        await turnAt(h, [workingAgent]);
        await frame(h, [waitingBare]);
        await frame(h, [{ ...waitingBare, description: 'Shared views, po komendzie' }]);
        await frame(h, []);
        expect(h.logs.filter((line) => line.endsWith(QUIET_ARMED))).toHaveLength(1);
        await h.fire();
        expect(h.sent).toHaveLength(1);
      });

      it('manager woła `quiet` raz na przejście „wstrzymuje → nie wstrzymuje", nigdy przy innych ramkach', async () => {
        const quiets: string[] = [];
        const notifier: NotifierLike = {
          note: () => undefined, seen: () => undefined, forget: () => undefined,
          quiet: (sessionId) => { quiets.push(sessionId); },
        };
        const supervisor = makeSupervisor();
        const manager = await build(supervisor, makeDeps(), { notifier });
        supervisor.appear(makeAgent());
        await flush();
        const id = manager.list().find((s) => s.paneId !== undefined)?.id ?? '';
        const driver = supervisor.driver('w9:p72');
        const counts: number[] = [];
        for (const tasks of [
          [workingAgent], [waitingAgent], [waitingBare], [waitingBare], [], [command], [], [waitingAgent], [command],
        ]) {
          await frame({ driver }, tasks);
          counts.push(quiets.length);
        }
        // Spadki: [waitingAgent] → [waitingBare] i [command] → []. Reszta to wzrost albo brak zmiany warunku.
        expect(counts).toEqual([0, 0, 1, 1, 1, 1, 2, 2, 2]);
        expect(quiets).toEqual([id, id]);
      });

      it('`/clear` (nowa rozmowa silnika) gasi zaległość: pusta lista nowej rozmowy nie daje „gotowe"', async () => {
        const h = await withRealNotifier();
        await turnAt(h, [workingAgent]);
        h.driver.queue.push({ type: 'init', engineSessionId: '22222222-2222-4222-8222-222222222222', model: '' });
        await frame(h, []);
        expect(h.notifier.pending).toBe(0);
        await h.fire();
        expect(h.sent).toHaveLength(0);
      });

      it('`/clear`, gdy pusta lista doszła przed `init`: uzbrojenie z ciszy zdjęte', async () => {
        const h = await withRealNotifier();
        await turnAt(h, [workingAgent]);
        await frame(h, []);
        expect(h.notifier.pending).toBe(1);
        h.driver.queue.push({ type: 'init', engineSessionId: '22222222-2222-4222-8222-222222222222', model: '' });
        await flush();
        expect(h.notifier.pending).toBe(0);
        await h.fire();
        expect(h.sent).toHaveLength(0);
      });

      /*
       * Telefon pokazuje jeszcze turę, a serwer już stoi w `waiting-input`.
       * Esc z Raroga jest wtedy przejściem-tożsamością, które `#note` nie woła; harmonogram dostaje je
       * osobno i gasi zaległość.
       */
      it('Esc z Raroga w `waiting-input` (przejście-tożsamość) gasi zaległość: cisza potem nic nie uzbraja', async () => {
        const h = await withRealNotifier();
        await turnAt(h, [workingAgent]);
        expect(h.manager.get(h.id)?.state).toBe('waiting-input');
        void h.manager.interrupt(h.id);
        await flush();
        expect(h.manager.get(h.id)?.state).toBe('waiting-input');
        await frame(h, []);
        expect(h.notifier.pending).toBe(0);
        await h.fire();
        expect(h.sent).toHaveLength(0);
      });

      it('`init` z tą samą rozmową niczego nie gasi', async () => {
        const h = await withRealNotifier();
        await turnAt(h, [workingAgent]);
        h.driver.queue.push({ type: 'init', engineSessionId: ENGINE_SESSION, model: '' });
        await frame(h, []);
        expect(h.notifier.pending).toBe(1);
        await h.fire();
        expect(h.sent.map((content) => content.kind)).toEqual(['done']);
      });
    });
  });

  /*
   * Tura głównego agenta wywołana WYŁĄCZNIE meldunkiem o postoju subagenta nie kończy
   * się pushem „gotowe". Manager tylko LICZY wiadomości roli `user` od poprzedniego końca tury
   * i podaje rachunek harmonogramowi (`NoteInput.turnInput`); decyzja zapada w `notify/policy.ts`.
   *
   * Granica tury to wyjście sesji ze stanów tury (`running`, stojąca decyzja), czyli dla sesji
   * herdr `agent-state: idle` z nadzorcy. Liczenie idzie od końca do końca, nie od startu:
   * notka z jsonl i `working` z herdr przychodzą w dowolnej kolejności.
   *
   * Rachunek bywa NIEPEŁNY (brak pola `turnInput`) i wtedy harmonogram nie stosuje tej reguły: po podpięciu drivera
   * i po końcu tury z pustym rachunkiem, do następnego końca tury.
   */
  describe('rachunek wiadomości tury a „gotowe"', () => {
    const STANDBY: TranscriptNotice = { kind: 'agent', outcome: 'waiting', name: 'Shared views' };
    const COMMAND_DONE: TranscriptNotice = { kind: 'command', outcome: 'done', name: 'pnpm test', exitCode: 0 };
    const AGENT_DONE: TranscriptNotice = { kind: 'agent', outcome: 'done', name: 'Shared views' };
    const text = (value: string): InternalBlock[] => [{ type: 'text', text: foreign(value) }];
    const notice = (value: TranscriptNotice): DriverEvent => ({
      type: 'message', role: 'user', blocks: text('<task-notification>…</task-notification>'), notice: value,
    });
    const typed = (value: string): DriverEvent => ({ type: 'message', role: 'user', blocks: text(value) });
    const WORKING: DriverEvent = { type: 'agent-state', state: 'working' };
    const IDLE: DriverEvent = { type: 'agent-state', state: 'idle' };
    /** Echo promptu z Raroga zgaszone przez follower albo wejście spoza transkryptu. */
    const INPUT: DriverEvent = { type: 'turn-input' };

    interface Rig {
      manager: Manager; supervisor: FakeSupervisor; id: string; notes: NoteInput[];
      /** Podaje zdarzenia BIEŻĄCEGO drivera po kolei, każde w osobnym obrocie pętli. */
      feed(...events: DriverEvent[]): Promise<void>;
      /** Rachunki podane harmonogramowi przy kolejnych końcach tury (`agent-idle`). */
      turns(): (NoteInput['turnInput'])[];
    }

    /**
     * Manager z jedną sesją herdr. Domyślnie panel stoi bezczynny i ma za sobą jedną widzianą
     * turę: dopiero po niej rachunek jest pełny (po podpięciu drivera jest niepełny).
     */
    async function rig(
      overrides: Partial<ManagerConfig> = {}, opts: { agent?: HerdrAgent; warm?: boolean } = {},
    ): Promise<Rig> {
      const notes: NoteInput[] = [];
      const notifier: NotifierLike = {
        note: (input) => { notes.push(input); }, seen: () => undefined, forget: () => undefined, quiet: () => undefined,
      };
      const supervisor = makeSupervisor();
      const manager = await build(supervisor, makeDeps(), { notifier, ...overrides });
      const agent = opts.agent ?? makeAgent();
      // Panel podpięty w trakcie tury ma zostać w `running`: bez meldunku `idle` od atrapy.
      supervisor.autoSettle = agent.status !== 'working';
      supervisor.appear(agent);
      await flush();
      const id = manager.list().find((s) => s.paneId !== undefined)?.id ?? '';
      const feed: Rig['feed'] = async (...events) => {
        for (const event of events) {
          supervisor.driver('w9:p72').queue.push(event);
          await flush();
        }
      };
      if (opts.warm !== false) {
        expect(manager.get(id)?.state).toBe('waiting-input');
        await feed(WORKING, IDLE);
        notes.length = 0;
      }
      return {
        manager, supervisor, id, notes, feed,
        turns: () => notes.filter((n) => n.event.type === 'agent-idle').map((n) => n.turnInput),
      };
    }

    it('sama notka o postoju → rachunek „jedna notka o postoju, nic innego"', async () => {
      const r = await rig();
      await r.feed(notice(STANDBY), WORKING, IDLE);
      expect(r.turns()).toEqual([{ standbyNotices: 1, artifactWatch: 0, other: 0, toolCalls: 0, compactions: 0 }]);
    });

    it('kolejność notki i `working` nie ma znaczenia: herdr najpierw, notka potem', async () => {
      const r = await rig();
      await r.feed(WORKING, notice(STANDBY), IDLE);
      expect(r.turns()).toEqual([{ standbyNotices: 1, artifactWatch: 0, other: 0, toolCalls: 0, compactions: 0 }]);
    });

    it('dwie notki o postoju w jednej turze', async () => {
      const r = await rig();
      await r.feed(notice(STANDBY), WORKING, notice(STANDBY), IDLE);
      expect(r.turns()).toEqual([{ standbyNotices: 2, artifactWatch: 0, other: 0, toolCalls: 0, compactions: 0 }]);
    });

    it('notka o postoju i prompt człowieka wpisany w terminalu', async () => {
      const r = await rig();
      await r.feed(notice(STANDBY), WORKING, typed('co z tym subagentem?'), IDLE);
      expect(r.turns()).toEqual([{ standbyNotices: 1, artifactWatch: 0, other: 1, toolCalls: 0, compactions: 0 }]);
    });

    it('notka o postoju i prompt człowieka wysłany z Raroga: liczy się przy wysyłce i przy zapisie w pliku', async () => {
      const r = await rig();
      await r.feed(notice(STANDBY));
      await r.manager.sendMessage(r.id, 'co z tym subagentem?');
      // CLI zapisało prompt w pliku: follower zgasił echo i zgłosił samo wejście.
      await r.feed(INPUT, IDLE);
      expect(r.turns()).toEqual([{ standbyNotices: 1, artifactWatch: 0, other: 2, toolCalls: 0, compactions: 0 }]);
    });

    /*
     * Komenda lokalna i jej wynik przychodzą z pliku jako notki `system` — w transkrypcie
     * stoją, ale wejściem tury nie są (komenda turą nie jest). Tura z samym postojem zostaje „samym postojem”.
     */
    it('notki `system` komendy lokalnej z pliku nie zmieniają rachunku wejść tury', async () => {
      const r = await rig();
      const before = r.manager.transcript(r.id).messages.length;
      const note = (value: string): DriverEvent => ({ type: 'message', role: 'system', blocks: text(value) });
      await r.feed(notice(STANDBY), note('/context'), note('Context Usage'), WORKING, IDLE);
      expect(r.turns()).toEqual([{ standbyNotices: 1, artifactWatch: 0, other: 0, toolCalls: 0, compactions: 0 }]);
      expect(r.manager.transcript(r.id).messages.slice(before).map((m) => m.role)).toEqual(['user', 'system', 'system']);
    });

    it('notka o postoju i raport subagenta (wejście bez śladu w transkrypcie)', async () => {
      const r = await rig();
      const before = r.manager.transcript(r.id).messages.length;
      await r.feed(notice(STANDBY), WORKING, INPUT, IDLE);
      expect(r.turns()).toEqual([{ standbyNotices: 1, artifactWatch: 0, other: 1, toolCalls: 0, compactions: 0 }]);
      // Raport subagenta dalej nie jest wiadomością: w transkrypcie przybyła sama notka.
      expect(r.manager.transcript(r.id).messages).toHaveLength(before + 1);
    });

    it('notka o końcu komendy albo subagenta to „coś innego", także obok notki o postoju', async () => {
      const r = await rig();
      await r.feed(notice(COMMAND_DONE), WORKING, IDLE);
      await r.feed(notice(STANDBY), notice(AGENT_DONE), WORKING, IDLE);
      expect(r.turns()).toEqual([
        { standbyNotices: 0, artifactWatch: 0, other: 1, toolCalls: 0, compactions: 0 },
        { standbyNotices: 1, artifactWatch: 0, other: 1, toolCalls: 0, compactions: 0 },
      ]);
    });

    it('koniec tury zeruje rachunek: tura po mieszanej jest znów „sam postój"', async () => {
      const r = await rig();
      await r.feed(notice(STANDBY), typed('pytanie'), WORKING, IDLE);
      await r.feed(notice(STANDBY), WORKING, IDLE);
      await r.feed(notice(STANDBY), WORKING, IDLE);
      expect(r.turns()).toEqual([
        { standbyNotices: 1, artifactWatch: 0, other: 1, toolCalls: 0, compactions: 0 },
        { standbyNotices: 1, artifactWatch: 0, other: 0, toolCalls: 0, compactions: 0 },
        { standbyNotices: 1, artifactWatch: 0, other: 0, toolCalls: 0, compactions: 0 },
      ]);
    });

    /*
     * Tura po meldunku o postoju trwa około 2 s, a nadzorca stosuje `working` z kanału push
     * dopiero po 1,5 s (`HERDR_WORKING_GRACE_MS`). Krótszej tury manager nie widzi wcale: nie ma
     * przejścia stanu, więc nie ma też końca tury. Rachunek czeka wtedy na następny widziany
     * koniec i mówi o wszystkim, co przyszło od poprzedniego.
     */
    it('tura, której herdr nie zameldował, nie zeruje rachunku: notki sumują się do następnego końca', async () => {
      const r = await rig();
      await r.feed(notice(STANDBY));
      await r.feed(IDLE);
      expect(r.turns()).toEqual([]);

      await r.feed(notice(STANDBY), WORKING, IDLE);
      expect(r.turns()).toEqual([{ standbyNotices: 2, artifactWatch: 0, other: 0, toolCalls: 0, compactions: 0 }]);
    });

    it('…a gdy po niewidzianej turze przyjdzie coś innego, najbliższy koniec tury jest zwykłym „gotowe"', async () => {
      const r = await rig();
      await r.feed(notice(STANDBY));
      await r.feed(INPUT, WORKING, IDLE);
      expect(r.turns()).toEqual([{ standbyNotices: 1, artifactWatch: 0, other: 1, toolCalls: 0, compactions: 0 }]);
    });

    it('dialog w turze po postoju: zgoda dostaje rachunek, a koniec tury po decyzji dalej jest „samym postojem"', async () => {
      const r = await rig();
      await r.feed(notice(STANDBY), WORKING, { type: 'agent-state', state: 'blocked' });
      const blocked = r.notes.find((n) => n.event.type === 'agent-blocked');
      expect(blocked?.turnInput).toEqual({ standbyNotices: 1, artifactWatch: 0, other: 0, toolCalls: 0, compactions: 0 });
      // Stojąca decyzja to dalej ta sama tura: rachunek nie został wyzerowany.
      await r.feed(WORKING, IDLE);
      expect(r.turns()).toEqual([{ standbyNotices: 1, artifactWatch: 0, other: 0, toolCalls: 0, compactions: 0 }]);
    });

    /*
     * Zaległe „gotowe": harmonogram ma wiedzieć, że wynik poprzedniej tury odebrano, także
     * gdy odbiór poszedł poza `markSeen` (fokus panelu na Macu). Start tury zeruje znacznik `seen`,
     * więc manager podaje jego wartość SPRZED zerowania.
     */
    describe('znacznik odbioru poprzedniego wyniku (`resultSeen`)', () => {
      const starts = (r: Rig): NoteInput[] => r.notes.filter((n) => n.event.type === 'agent-working');

      it('wynik nieodebrany: start następnej tury go nie niesie', async () => {
        const r = await rig();
        await r.feed(typed('zrób'), WORKING, IDLE);
        await r.feed(notice(STANDBY), WORKING);
        expect(starts(r).at(-1)).not.toHaveProperty('resultSeen');
      });

      it('wynik odebrany w Rarogu: start następnej tury niesie znacznik, jej koniec już nie', async () => {
        const r = await rig();
        await r.feed(typed('zrób'), WORKING, IDLE);
        r.manager.markSeen(r.id);
        expect(r.manager.get(r.id)?.seen).toBe(true);

        await r.feed(notice(STANDBY), WORKING);
        expect(starts(r).at(-1)?.resultSeen).toBe(true);
        await r.feed(IDLE);
        expect(r.notes.filter((n) => n.event.type === 'agent-idle').at(-1)).not.toHaveProperty('resultSeen');
      });

      it('wynik odebrany na Macu (`done → idle` z herdr): start następnej tury niesie znacznik', async () => {
        const r = await rig();
        await r.feed(typed('zrób'), WORKING, { type: 'agent-state', state: 'idle', seen: false });
        expect(r.manager.get(r.id)?.seen).toBe(false);
        // Ktoś sfokusował panel, na którym stał badge `done`.
        await r.feed({ type: 'agent-state', state: 'idle', seen: true });
        expect(r.manager.get(r.id)?.seen).toBe(true);

        await r.feed(notice(STANDBY), WORKING);
        expect(starts(r).at(-1)?.resultSeen).toBe(true);
      });
    });

    it('przerwanie tury (Esc z Raroga) też ją kończy i zamyka rachunek', async () => {
      const clock = { value: 1_000_000 };
      const r = await rig({ now: () => clock.value });
      await r.feed(notice(STANDBY), WORKING);
      await r.manager.interrupt(r.id);
      await flush();
      expect(r.manager.get(r.id)?.state).toBe('waiting-input');
      // Po karencji przerwania (spóźniony `working` ubitej tury jest ignorowany) rusza nowa tura.
      clock.value += 60_000;
      await r.feed(typed('dalej'), WORKING, IDLE);
      expect(r.turns()).toEqual([{ standbyNotices: 0, artifactWatch: 0, other: 1, toolCalls: 0, compactions: 0 }]);
    });

    it('historia się nie liczy, a każda jej porcja czyni rachunek niepełnym', async () => {
      const r = await rig();
      await r.feed({
        type: 'history',
        messages: [
          { role: 'user', blocks: text('stare pytanie'), at: '2026-10-09T21:31:38.020Z' },
          { role: 'user', blocks: text('<task-notification>…'), at: '2026-10-09T21:51:18.208Z', notice: STANDBY },
        ],
      });
      // W historii bywa prompt tury, która jeszcze trwa: z rachunku nie wolno teraz wnioskować.
      await r.feed(notice(STANDBY), WORKING, IDLE);
      expect(r.turns()).toEqual([undefined]);
      // Po widzianym końcu tury rachunek jest pełny i historii w nim nie ma.
      await r.feed(notice(STANDBY), WORKING, IDLE);
      expect(r.turns()).toEqual([undefined, { standbyNotices: 1, artifactWatch: 0, other: 0, toolCalls: 0, compactions: 0 }]);
    });

    it('wiadomość asystenta i systemowa nie wchodzą do rachunku', async () => {
      const r = await rig();
      await r.feed(
        notice(STANDBY), WORKING,
        { type: 'message', role: 'assistant', blocks: text('Subagent czeka na swoją komendę.') },
        { type: 'message', role: 'system', blocks: text('notka Raroga') },
        IDLE,
      );
      expect(r.turns()).toEqual([{ standbyNotices: 1, artifactWatch: 0, other: 0, toolCalls: 0, compactions: 0 }]);
    });

    /*
     * Rachunek NIEPEŁNY. Wszystkie trzy przypadki mają ten sam kierunek
     * błędu, którego ta reguła nie może popełnić: cisza po turze, w której było co odebrać.
     */
    describe('rachunek niepełny: harmonogram nie dostaje go wcale', () => {
      /*
       * Rarog wstał (albo panel został adoptowany) w trakcie zadania człowieka. Prompt tej tury
       * stoi w historii, której manager nie liczy. Notka o postoju dopisana potem na żywo
       * wyglądałaby na jedyną przyczynę tury i wyciszyła „gotowe" po zadaniu człowieka.
       */
      it('podpięcie w trakcie tury: prompt w historii, potem żywa notka o postoju → bez rachunku', async () => {
        const r = await rig({}, { agent: makeAgent({ status: 'working' }), warm: false });
        expect(r.manager.get(r.id)?.state).toBe('running');
        await r.feed({
          type: 'history',
          messages: [{ role: 'user', blocks: text('zrób migrację'), at: '2026-10-09T21:31:38.020Z' }],
        });
        await r.feed(notice(STANDBY), IDLE);
        expect(r.turns()).toEqual([undefined]);
        expect(r.notes.find((n) => n.event.type === 'agent-idle')).not.toHaveProperty('turnInput');

        // Od pierwszego widzianego końca tury rachunek jest pełny.
        await r.feed(notice(STANDBY), WORKING, IDLE);
        expect(r.turns()).toEqual([undefined, { standbyNotices: 1, artifactWatch: 0, other: 0, toolCalls: 0, compactions: 0 }]);
      });

      it('panel podpięty jako bezczynny też zaczyna bez rachunku: pierwsza tura nie jest wyciszana', async () => {
        const r = await rig({}, { warm: false });
        await r.feed(notice(STANDBY), WORKING, IDLE);
        expect(r.turns()).toEqual([undefined]);
      });

      it('ponowne podpięcie drivera (powrót herdr) znów czyni rachunek niepełnym', async () => {
        const r = await rig();
        await r.feed(notice(STANDBY));
        r.supervisor.emit({ type: 'unavailable', reason: foreign('herdr zamknął strumień') });
        await flush();
        r.supervisor.emit({ type: 'available' });
        r.supervisor.reattach(makeAgent());
        await flush();
        // W przerwie mogło przyjść cokolwiek; nowy driver zaczyna od historii, której nie liczymy.
        await r.feed(WORKING, IDLE);
        expect(r.turns()).toEqual([undefined]);
        await r.feed(notice(STANDBY), WORKING, IDLE);
        expect(r.turns()).toEqual([undefined, { standbyNotices: 1, artifactWatch: 0, other: 0, toolCalls: 0, compactions: 0 }]);
      });

      /*
       * `/clear` albo `/resume` w tym samym panelu, skrócenie pliku, przeskok przyrostu: driver
       * zostaje ten sam, ale follower stracił ciągłość pliku i mówi o tym (`turn-input` z `lost`).
       * Prompt nowej rozmowy stoi w jej historii albo w pominiętym kawałku.
       */
      it('utrata ciągłości pliku rozmowy (`lost`): rachunek niepełny do następnego końca tury', async () => {
        const r = await rig();
        await r.feed({ type: 'turn-input', lost: true }, WORKING, notice(STANDBY), IDLE);
        expect(r.turns()).toEqual([undefined]);
        await r.feed(notice(STANDBY), WORKING, IDLE);
        expect(r.turns()).toEqual([undefined, { standbyNotices: 1, artifactWatch: 0, other: 0, toolCalls: 0, compactions: 0 }]);
      });

      /*
       * Sesja założona z Raroga z promptem. Nowy panel melduje `idle`, zanim prompt poleci:
       * `starting → waiting-input` nie jest końcem tury i nie może domknąć rachunku, bo prompt
       * startowy (echo bywa już w historii) nie doliczyłby się nigdzie, a notka o postoju
       * wyciszyłaby „gotowe" po pierwszym zadaniu.
       */
      it('nowa sesja z promptem: pierwsze `idle` panelu nie domyka rachunku, pierwsza tura nie jest wyciszana', async () => {
        const notes: NoteInput[] = [];
        const notifier: NotifierLike = {
          note: (input) => { notes.push(input); }, seen: () => undefined, forget: () => undefined, quiet: () => undefined,
        };
        const supervisor = makeSupervisor();
        const manager = await build(supervisor, makeDeps(), { notifier });
        const created = await manager.create({ cwd: PROJECT, prompt: 'napraw migrację' });
        // Atrapa melduje `idle` zaraz po podpięciu, PRZED gotowością panelu — jak prawdziwy herdr. Karta
        // stoi wtedy w `starting`, więc to `idle` nie dochodzi do harmonogramu wcale.
        await flush();
        expect(manager.get(created.sessionId)?.state).toBe('starting');
        supervisor.settleLaunch();
        await flush();
        expect(supervisor.log.of('send')).toEqual(['napraw migrację']);
        expect(manager.get(created.sessionId)?.state).toBe('running');

        const driver = supervisor.driver('w0:new1');
        driver.queue.push(notice(STANDBY));
        await flush();
        driver.queue.push(IDLE);
        await flush();
        const ends = notes.filter((n) => n.event.type === 'agent-idle');
        expect(ends).toHaveLength(1);
        for (const end of ends) expect(end).not.toHaveProperty('turnInput');

        // Dopiero od końca tej pierwszej prawdziwej tury rachunek jest pełny.
        driver.queue.push(notice(STANDBY));
        await flush();
        driver.queue.push(WORKING);
        await flush();
        driver.queue.push(IDLE);
        await flush();
        expect(notes.filter((n) => n.event.type === 'agent-idle').at(-1)?.turnInput)
          .toEqual({ standbyNotices: 1, artifactWatch: 0, other: 0, toolCalls: 0, compactions: 0 });
      });

      it('sesja założona bez promptu: „tura zerowa" nie domyka rachunku', async () => {
        const notes: NoteInput[] = [];
        const notifier: NotifierLike = {
          note: (input) => { notes.push(input); }, seen: () => undefined, forget: () => undefined, quiet: () => undefined,
        };
        const supervisor = makeSupervisor();
        supervisor.autoSettle = false;
        const manager = await build(supervisor, makeDeps(), { notifier });
        const created = await manager.create({ cwd: PROJECT });
        supervisor.settleLaunch();
        await flush();
        // Bez promptu manager sam domyka „turę zerową": `starting → running → waiting-input`.
        expect(manager.get(created.sessionId)?.state).toBe('waiting-input');

        const driver = supervisor.driver('w0:new1');
        driver.queue.push(notice(STANDBY));
        await flush();
        driver.queue.push(WORKING);
        await flush();
        driver.queue.push(IDLE);
        await flush();
        const ends = notes.filter((n) => n.event.type === 'agent-idle');
        expect(ends.at(-1)).not.toHaveProperty('turnInput');
      });

      /*
       * Prompt wysłany z Raroga W TRAKCIE tury CLI kolejkuje i wykonuje w następnej. Liczony
       * wyłącznie przy wysyłce trafiłby do rachunku tury, która się właśnie kończy, a jego własna
       * tura — z echem zgaszonym przez follower — zostałaby z samą notką o postoju.
       */
      it('prompt z Raroga zakolejkowany w turze wchodzi też do następnej, gdy CLI zapisze go w pliku', async () => {
        const r = await rig();
        await r.feed(typed('pierwsze zadanie'), WORKING);
        await r.manager.sendMessage(r.id, 'drugie zadanie');
        await r.feed(IDLE);
        // Druga tura: prompt wychodzi z kolejki do pliku (echo → samo wejście), w tej samej turze staje subagent.
        await r.feed(WORKING, INPUT, notice(STANDBY), IDLE);
        expect(r.turns()).toEqual([
          { standbyNotices: 0, artifactWatch: 0, other: 2, toolCalls: 0, compactions: 0 },
          { standbyNotices: 1, artifactWatch: 0, other: 1, toolCalls: 0, compactions: 0 },
        ]);
      });

      /*
       * Plik rozmowy czyta follower, koniec tury melduje herdr — niezależnie. Gdy notka dojdzie
       * PO końcu tury (zgubione zdarzenie systemu plików, odczyt awaryjny co 2 s), tura kończy się
       * z pustym rachunkiem i daje zwykłe „gotowe". Spóźniona notka nie może potem doliczyć się do
       * następnej tury: wyciszyłaby krótkie zadanie człowieka.
       */
      it('pusty rachunek przy końcu tury: spóźniona notka nie przechodzi na następną turę', async () => {
        const r = await rig();
        await r.feed(WORKING, IDLE);
        expect(r.turns()).toEqual([{ standbyNotices: 0, artifactWatch: 0, other: 0, toolCalls: 0, compactions: 0 }]);

        await r.feed(notice(STANDBY));
        await r.feed(WORKING, IDLE);
        expect(r.turns()).toEqual([{ standbyNotices: 0, artifactWatch: 0, other: 0, toolCalls: 0, compactions: 0 }, undefined]);

        // Po tym końcu tury rachunek jest znów pełny.
        await r.feed(notice(STANDBY), WORKING, IDLE);
        expect(r.turns().at(-1)).toEqual({ standbyNotices: 1, artifactWatch: 0, other: 0, toolCalls: 0, compactions: 0 });
      });
    });

    /** Prawdziwy harmonogram: co z tego rachunku wychodzi na telefon. */
    async function withRealNotifier(opts: { agent?: HerdrAgent; warm?: boolean } = {}): Promise<{
      feed: Rig['feed']; sent: PushContent[]; logs: string[]; fire: () => Promise<void>; pending: () => number;
      manager: Manager; id: string;
    }> {
      const sent: PushContent[] = [];
      const logs: string[] = [];
      const timers = new Map<number, () => void>();
      let nextTimer = 1;
      let managerRef: Manager | null = null;
      const notifier = new Notifier({
        presence: new Presence(),
        sink: { send: (content) => { sent.push(content); return Promise.resolve({ channels: { apns: 'delivered' } }); } },
        look: (sessionId) => sessionLook(managerRef?.get(sessionId)),
        log: (line) => { logs.push(line); },
        setTimeout: (cb) => {
          const handle = nextTimer++;
          timers.set(handle, cb);
          return handle;
        },
        clearTimeout: (handle) => { timers.delete(handle as number); },
      });
      // Atrapa harmonogramu z `rig` zostaje przykryta prawdziwym; `managerRef` czyta leniwie.
      const r = await rig({ notifier }, opts);
      managerRef = r.manager;
      const fire = async (): Promise<void> => {
        const due = [...timers.values()];
        timers.clear();
        for (const cb of due) cb();
        await flush();
      };
      // Tura rozgrzewkowa `rig` uzbroiła własne „gotowe": test zaczyna z czystym kontem.
      await fire();
      sent.length = 0;
      logs.length = 0;
      return { feed: r.feed, sent, logs, pending: () => notifier.pending, fire, manager: r.manager, id: r.id };
    }

    it('na telefon: tura po samym postoju milczy i zostawia ślad w logu; tura z promptem daje „gotowe"', async () => {
      const h = await withRealNotifier();
      await h.feed(notice(STANDBY), WORKING, IDLE);
      expect(h.pending()).toBe(0);
      await h.fire();
      expect(h.sent).toHaveLength(0);
      expect(h.logs.filter((line) => line.includes('turn after a subagent standby alone'))).toHaveLength(1);

      await h.feed(notice(STANDBY), typed('i co dalej?'), WORKING, IDLE);
      expect(h.pending()).toBe(1);
      await h.fire();
      expect(h.sent.map((content) => content.kind)).toEqual(['done']);
    });

    it('na telefon: po notce o postoju staje dialog, potem tura pada — obie sprawy wychodzą zwykłą klasą', async () => {
      const h = await withRealNotifier();
      await h.feed(notice(STANDBY), WORKING, { type: 'agent-state', state: 'blocked' });
      await h.fire();
      expect(h.sent.map((content) => content.kind)).toEqual(['blocked']);

      await h.feed(WORKING, { type: 'limit-reached' });
      await h.fire();
      expect(h.sent.map((content) => content.kind)).toEqual(['blocked', 'limit']);
    });

    /*
     * Meldunek o końcu obserwacji artefaktu liczy się osobno,
     * a manager liczy też wywołania narzędzi głównego agenta (bloki `tool-call` jego wiadomości).
     * Notka powstaje tu z ZMIERZONEJ linii pliku rozmowy (fixture pomiaru artefaktów, wariant „artifact
     * not found” wpisem `user`) prawdziwym parserem, tak jak w followerze.
     */
    describe('tura po samym meldunku o artefakcie', () => {
      const MEASURED = join(import.meta.dirname, 'fixtures/herdr/artifacts/measured/meldunki.jsonl');
      /** Wiadomość `message` z linii fixture'u: wpis `user` z pochodzeniem i wariantem „not found”. */
      const measuredNotice = async (): Promise<DriverEvent> => {
        const lines = (await readFile(MEASURED, 'utf8')).split('\n');
        const raw = lines.find((line) => line.includes('"type":"user"') && line.includes('(artifact not found)'));
        const parsed = parseImportLine(raw ?? '');
        const message = parsed?.message;
        if (message === undefined || message === null || message.notice === undefined) {
          throw new Error('fixture: brak meldunku „artifact not found” wpisem user');
        }
        expect(message.notice.kind).toBe('artifact-watch');
        return { type: 'message', role: 'user', blocks: message.blocks, notice: message.notice };
      };
      const reply = (value: string): DriverEvent => ({ type: 'message', role: 'assistant', blocks: text(value) });
      const toolCall = (toolName: string, summary: string): DriverEvent => ({
        type: 'message', role: 'assistant', blocks: [{ type: 'tool-call', toolName, summary }],
      });

      it('rachunek: meldunek osobno, narzędzia agenta w swojej turze, zerowane z końcem tury', async () => {
        const r = await rig();
        const artifact = await measuredNotice();
        await r.feed(artifact, WORKING, reply('Artefakt usunięty, nic do zrobienia.'), IDLE);
        await r.feed(
          artifact, WORKING, toolCall('Read', 'raport.html'),
          {
            type: 'message', role: 'assistant',
            blocks: [...text('Publikuję ponownie.'), { type: 'tool-call', toolName: 'Artifact', summary: 'publish' }],
          },
          IDLE,
        );
        await r.feed(artifact, WORKING, reply('Nic do zrobienia.'), IDLE);
        expect(r.turns()).toEqual([
          { standbyNotices: 0, artifactWatch: 1, other: 0, toolCalls: 0, compactions: 0 },
          { standbyNotices: 0, artifactWatch: 1, other: 0, toolCalls: 2, compactions: 0 },
          { standbyNotices: 0, artifactWatch: 1, other: 0, toolCalls: 0, compactions: 0 },
        ]);
      });

      it('na telefon: meldunek i odpowiedź bez narzędzi → cisza z powodem w logu', async () => {
        const h = await withRealNotifier();
        await h.feed(await measuredNotice(), WORKING, reply('Artefakt usunięty, nic do zrobienia.'), IDLE);
        expect(h.pending()).toBe(0);
        await h.fire();
        expect(h.sent).toHaveLength(0);
        expect(h.logs.filter((line) => line.endsWith('(done, turn after an artifact task notification alone)'))).toHaveLength(1);
      });

      it('na telefon: agent po meldunku użył narzędzia → „gotowe"', async () => {
        const h = await withRealNotifier();
        await h.feed(
          await measuredNotice(), WORKING, toolCall('Artifact', 'publish'), reply('Opublikowany ponownie.'), IDLE,
        );
        expect(h.pending()).toBe(1);
        await h.fire();
        expect(h.sent.map((content) => content.kind)).toEqual(['done']);
        expect(h.logs.some((line) => line.includes('meldunku o artefakcie'))).toBe(false);
      });

      it('na telefon: meldunek i prompt człowieka → „gotowe"', async () => {
        const h = await withRealNotifier();
        await h.feed(await measuredNotice(), typed('a co z tym artefaktem?'), WORKING, reply('Usunięty.'), IDLE);
        await h.fire();
        expect(h.sent.map((content) => content.kind)).toEqual(['done']);
      });

      /*
       * Wpis wywołania stoi w pliku przed końcem tury, ale do managera
       * dochodzi przez follower (0,1 s, po zgubionym zdarzeniu systemu plików do 2 s), a koniec tury
       * melduje herdr, niezależnie. Spóźnione wywołanie poprawia tamtą turę i nie wchodzi do następnej.
       */
      describe('wywołanie narzędzia doszło z pliku po końcu tury', () => {
        it('rachunek: koniec tury podany ponownie z narzędziem, następna tura bez spadku', async () => {
          const r = await rig();
          const artifact = await measuredNotice();
          await r.feed(artifact, WORKING, IDLE);
          await r.feed(toolCall('Artifact', 'publish'), reply('Opublikowany ponownie.'));
          await r.feed(artifact, WORKING, reply('Nic do zrobienia.'), IDLE);
          expect(r.turns()).toEqual([
            { standbyNotices: 0, artifactWatch: 1, other: 0, toolCalls: 0, compactions: 0 },
            { standbyNotices: 0, artifactWatch: 1, other: 0, toolCalls: 1, compactions: 0 },
            { standbyNotices: 0, artifactWatch: 1, other: 0, toolCalls: 0, compactions: 0 },
          ]);
        });

        it('na telefon: „gotowe" po spóźnionym wywołaniu; kolejna tura po meldunku bez narzędzi milczy', async () => {
          const h = await withRealNotifier();
          await h.feed(await measuredNotice(), WORKING, IDLE);
          expect(h.pending()).toBe(0);
          await h.feed(toolCall('Artifact', 'publish'), reply('Opublikowany ponownie.'));
          expect(h.pending()).toBe(1);
          await h.fire();
          expect(h.sent.map((content) => content.kind)).toEqual(['done']);

          await h.feed(await measuredNotice(), WORKING, reply('Nic do zrobienia.'), IDLE);
          expect(h.pending()).toBe(0);
          await h.fire();
          expect(h.sent).toHaveLength(1);
        });

        it('Esc z Raroga po końcu tury: spóźnione wywołanie nie uzbraja „gotowe" sprzed Esc', async () => {
          const h = await withRealNotifier();
          await h.feed(await measuredNotice(), WORKING, IDLE);
          await h.manager.interrupt(h.id);
          await flush();
          await h.feed(toolCall('Artifact', 'publish'), reply('Opublikowany ponownie.'));
          expect(h.pending()).toBe(0);
          await h.fire();
          expect(h.sent).toHaveLength(0);
        });

        it('po oknie spóźnienia wywołanie nie wraca do tamtej tury ani nie wchodzi do następnej', async () => {
          const clock = { value: 1_000_000 };
          const r = await rig({ now: () => clock.value });
          const artifact = await measuredNotice();
          await r.feed(artifact, WORKING, IDLE);
          clock.value += 10_001;
          await r.feed(toolCall('Bash', 'ls'));
          await r.feed(artifact, WORKING, IDLE);
          expect(r.turns()).toEqual([
            { standbyNotices: 0, artifactWatch: 1, other: 0, toolCalls: 0, compactions: 0 },
            { standbyNotices: 0, artifactWatch: 1, other: 0, toolCalls: 0, compactions: 0 },
          ]);
        });

        it('wywołanie po wejściu następnej tury liczy się do niej, bez ponownego końca poprzedniej', async () => {
          const r = await rig();
          await r.feed(await measuredNotice(), WORKING, IDLE);
          await r.feed(typed('a teraz popraw plik'), toolCall('Edit', 'raport.html'), WORKING, IDLE);
          expect(r.turns()).toEqual([
            { standbyNotices: 0, artifactWatch: 1, other: 0, toolCalls: 0, compactions: 0 },
            { standbyNotices: 0, artifactWatch: 0, other: 1, toolCalls: 1, compactions: 0 },
          ]);
        });
      });

      it('na telefon: rachunek niepełny (podpięcie bez widzianej tury) → zwykłe „gotowe"', async () => {
        const h = await withRealNotifier({ warm: false });
        await h.feed(await measuredNotice(), WORKING, reply('Nic do zrobienia.'), IDLE);
        await h.fire();
        expect(h.sent.map((content) => content.kind)).toEqual(['done']);
      });
    });

    it('na telefon: zadanie człowieka podpięte w trakcie tury dostaje „gotowe" mimo notki o postoju', async () => {
      const h = await withRealNotifier({ agent: makeAgent({ status: 'working' }), warm: false });
      await h.feed({
        type: 'history',
        messages: [{ role: 'user', blocks: text('zrób migrację'), at: '2026-10-09T21:31:38.020Z' }],
      });
      await h.feed(notice(STANDBY), IDLE);
      expect(h.pending()).toBe(1);
      await h.fire();
      expect(h.sent.map((content) => content.kind)).toEqual(['done']);
      expect(h.logs.some((line) => line.includes('turn after a subagent standby alone'))).toBe(false);
    });
  });

  /*
   * `allow-always` istnieje wyłącznie dla karty zgody z `alwaysLabel`. Dialog z zamkniętej
   * listy sygnatur (adresowany SESJĄ) takiej opcji nie ma — manager odmawia wprost, zanim
   * cokolwiek poleci do drivera.
   */
  describe('allow-always w managerze', () => {
    it('alwaysLabel z drivera wsiada do PermissionRequest', async () => {
      const { manager, supervisor, id } = await withOneAgent();
      supervisor.driver('w9:p72').queue.push({
        type: 'permission-request',
        reqId: 'tool-1',
        toolName: 'Bash',
        input: { command: 'pnpm test' },
        displayText: 'pnpm test',
        alwaysLabel: "Yes, and don't ask again for pnpm commands",
      });
      await flush();
      expect(manager.transcript(id).pendingPermissions[0]?.alwaysLabel)
        .toBe("Yes, and don't ask again for pnpm commands");
    });

    it('dialog adresowany sesją (trust/model) ODMAWIA allow-always', async () => {
      const { manager, supervisor, id } = await withOneAgent();
      supervisor.driver('w9:p72').queue.push({ type: 'screen-dialog', knownDialog: 'trust' });
      await flush();
      const err = await Promise.resolve()
        .then(() => manager.resolvePermission(id, id, 'allow-always', 'iphone'))
        .then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      // Driver nie dostał żadnej decyzji — zero klawiszy do panelu.
      expect(supervisor.log.sterowanie()).toEqual([]);
    });
  });

  /*
   * Powód odmowy jedzie na telefon RAZEM z kartą, tym samym polem, którym jedzie
   * rozpoznanie dialogu. Bez tego użytkownik widziałby jedno zdanie na wszystkie przyczyny
   * („Agent czeka na decyzję"), a powód znałby wyłącznie dziennik odmów na Macu.
   */
  describe('powód odmowy na karcie sesji', () => {
    const summaryOf = (manager: Manager, id: string): SessionSummary | undefined =>
      manager.list().find((s) => s.id === id);

    it('karta ekranowa bez przycisków niesie powód, rozpoznana go kasuje', async () => {
      const { manager, supervisor, id } = await withOneAgent();
      const driver = supervisor.driver('w9:p72');
      driver.queue.push({ type: 'screen-dialog', reason: 'multi-select' });
      await flush();
      expect(summaryOf(manager, id)?.herdrDialogReason).toBe('multi-select');
      expect(summaryOf(manager, id)?.herdrDialog).toBeUndefined();

      // Dialog rozpoznany = odmowy nie było; pole MUSI zniknąć, inaczej karta zaufania
      // katalogu odziedziczyłaby zdanie o poprzednim, nieodczytanym dialogu.
      driver.queue.push({ type: 'screen-dialog', knownDialog: 'trust' });
      await flush();
      expect(summaryOf(manager, id)?.herdrDialog).toBe('trust');
      expect(summaryOf(manager, id)?.herdrDialogReason).toBeUndefined();
    });

    it('karta zdegradowana (input: null) też niesie powód, zwykła zgoda — nie', async () => {
      const { manager, supervisor, id } = await withOneAgent();
      const driver = supervisor.driver('w9:p72');
      driver.queue.push({
        type: 'permission-request',
        reqId: 'tool-1',
        toolName: 'Bash',
        input: null,
        displayText: '(wycinek ekranu)',
        reason: 'mismatch',
      });
      await flush();
      expect(summaryOf(manager, id)?.herdrDialogReason).toBe('mismatch');

      driver.queue.push({
        type: 'permission-request',
        reqId: 'tool-2',
        toolName: 'Bash',
        input: { command: 'ls' },
        displayText: 'ls',
      });
      await flush();
      expect(summaryOf(manager, id)?.herdrDialogReason).toBeUndefined();
    });

    it('dialog znika (permission-cleared, wyjście z blokady) → powód znika razem z nim',
      async () => {
        const { manager, supervisor, id } = await withOneAgent();
        const driver = supervisor.driver('w9:p72');
        driver.queue.push({ type: 'screen-dialog', reason: 'unreadable' });
        await flush();
        driver.queue.push({ type: 'permission-cleared', reason: 'ekran ruszył' });
        await flush();
        expect(summaryOf(manager, id)?.herdrDialogReason).toBeUndefined();

        driver.queue.push({ type: 'screen-dialog', reason: 'unreadable' });
        await flush();
        expect(summaryOf(manager, id)?.herdrDialogReason).toBe('unreadable');
        driver.queue.push({ type: 'agent-state', state: 'working' });
        await flush();
        expect(summaryOf(manager, id)?.herdrDialogReason).toBeUndefined();
      });
  });

  /*
   * CO WIDAĆ w panelu jedzie tym samym kanałem co powód — polem karty sesji, a nie
   * wiadomością systemową do transkryptu. Reguła jest taka sama i sprawdzamy ją tak samo:
   * niesie je wyłącznie karta bez przycisków, a znikają razem z dialogiem.
   */
  describe('wycinek ekranu na karcie sesji', () => {
    const summaryOf = (manager: Manager, id: string): SessionSummary | undefined =>
      manager.list().find((s) => s.id === id);

    it('karta ekranowa i zdegradowana niosą ekran; rozpoznana i zwykła zgoda — nie', async () => {
      const { manager, supervisor, id } = await withOneAgent();
      const driver = supervisor.driver('w9:p72');
      driver.queue.push({
        type: 'screen-dialog', reason: 'multi-select', screen: 'Które dodatki?\n[ ] Posypka',
      });
      await flush();
      expect(summaryOf(manager, id)?.herdrDialogScreen).toContain('Posypka');

      driver.queue.push({ type: 'screen-dialog', knownDialog: 'trust' });
      await flush();
      expect(summaryOf(manager, id)?.herdrDialogScreen).toBeUndefined();

      driver.queue.push({
        type: 'permission-request',
        reqId: 'tool-1',
        toolName: 'Bash',
        input: null,
        displayText: '(nie umiem tego złożyć)',
        reason: 'mismatch',
        screen: 'Do you want to proceed?',
      });
      await flush();
      expect(summaryOf(manager, id)?.herdrDialogScreen).toBe('Do you want to proceed?');

      driver.queue.push({
        type: 'permission-request',
        reqId: 'tool-2',
        toolName: 'Bash',
        input: { command: 'ls' },
        displayText: 'ls',
      });
      await flush();
      expect(summaryOf(manager, id)?.herdrDialogScreen).toBeUndefined();
    });

    it('dialog znika → ekran znika razem z nim', async () => {
      const { manager, supervisor, id } = await withOneAgent();
      const driver = supervisor.driver('w9:p72');
      driver.queue.push({ type: 'screen-dialog', reason: 'unreadable', screen: 'ogon ekranu' });
      await flush();
      expect(summaryOf(manager, id)?.herdrDialogScreen).toBe('ogon ekranu');
      driver.queue.push({ type: 'agent-state', state: 'working' });
      await flush();
      expect(summaryOf(manager, id)?.herdrDialogScreen).toBeUndefined();
    });
  });

  /*
   * KLASA dialogu z rejestru sesji CLI jedzie na telefon tym samym kanałem co powód
   * i wycinek ekranu — polem karty sesji. Driver dokleja ją wyłącznie do karty bez decyzji;
   * manager ma ją przenieść do `SessionSummary.cliDialog` i skasować razem z kartą.
   */
  describe('klasa dialogu z rejestru CLI na karcie sesji', () => {
    const summaryOf = (manager: Manager, id: string): SessionSummary | undefined =>
      manager.list().find((s) => s.id === id);

    it('karta ekranowa i zdegradowana niosą klasę; rozpoznana i zwykła zgoda ją kasują', async () => {
      const { manager, supervisor, id } = await withOneAgent();
      const driver = supervisor.driver('w9:p72');
      const events = record(manager);
      driver.queue.push({ type: 'screen-dialog', reason: 'no-jsonl', cliDialog: 'dialog' });
      await flush();
      expect(summaryOf(manager, id)?.cliDialog).toBe('dialog');
      // Ramka listy niesie klasę w chwili, w której karta powstaje — sidebar nie czeka na resync.
      const changed = events.filter((e) => e.event.type === 'session-changed').at(-1)?.event;
      expect(changed?.type === 'session-changed' ? changed.session.cliDialog : null).toBe('dialog');

      // Dialog rozpoznany ma własną treść — klasa poprzedniego dialogu nie ma prawa przy nim zostać.
      driver.queue.push({ type: 'screen-dialog', knownDialog: 'trust' });
      await flush();
      expect(summaryOf(manager, id)?.cliDialog).toBeUndefined();

      driver.queue.push({
        type: 'permission-request', reqId: 'tool-1', toolName: 'Bash', input: null,
        displayText: '(nie umiem tego złożyć)', reason: 'mismatch', cliDialog: 'permission',
      });
      await flush();
      expect(summaryOf(manager, id)?.cliDialog).toBe('permission');

      driver.queue.push({
        type: 'permission-request', reqId: 'tool-2', toolName: 'Bash',
        input: { command: 'ls' }, displayText: 'ls',
      });
      await flush();
      expect(summaryOf(manager, id)?.cliDialog).toBeUndefined();
    });

    it('dialog znika (permission-cleared, wyjście z blokady) → klasa znika razem z nim', async () => {
      const { manager, supervisor, id } = await withOneAgent();
      const driver = supervisor.driver('w9:p72');
      driver.queue.push({ type: 'screen-dialog', reason: 'unreadable', cliDialog: 'input' });
      await flush();
      expect(summaryOf(manager, id)?.cliDialog).toBe('input');
      driver.queue.push({ type: 'permission-cleared', reason: 'ekran ruszył' });
      await flush();
      expect(summaryOf(manager, id)?.cliDialog).toBeUndefined();

      driver.queue.push({ type: 'screen-dialog', cliDialog: 'sandbox' });
      await flush();
      expect(summaryOf(manager, id)?.cliDialog).toBe('sandbox');
      // Powtórzony `blocked` (resync) nie rusza klasy ani nie daje pustej ramki.
      const events = record(manager);
      driver.queue.push({ type: 'agent-state', state: 'blocked' });
      await flush();
      expect(summaryOf(manager, id)?.cliDialog).toBe('sandbox');
      expect(events.filter((e) => e.event.type === 'session-changed')).toEqual([]);
      driver.queue.push({ type: 'agent-state', state: 'working' });
      await flush();
      expect(summaryOf(manager, id)?.cliDialog).toBeUndefined();
    });

    it('`cli-dialog` przy stojącej karcie: samo pole i ramka listy — bez pendingu, karty i pusha', async () => {
      const notes: NoteInput[] = [];
      const notifier: NotifierLike = {
        note: (input) => { notes.push(input); }, seen: () => undefined, forget: () => undefined, quiet: () => undefined,
      };
      const supervisor = makeSupervisor();
      const manager = await build(supervisor, makeDeps(), { notifier });
      supervisor.appear(makeAgent());
      await flush();
      const id = manager.list().find((s) => s.paneId !== undefined)?.id ?? '';
      const driver = supervisor.driver('w9:p72');
      driver.queue.push({ type: 'screen-dialog', reason: 'unreadable' });
      await flush();
      const notified = notes.length;
      const events = record(manager);

      driver.queue.push({ type: 'cli-dialog', cliDialog: 'dialog' });
      await flush();
      expect(summaryOf(manager, id)?.cliDialog).toBe('dialog');
      expect(summaryOf(manager, id)?.herdrDialogReason).toBe('unreadable');
      // Ramka listy (global) i ramka sesji — nic więcej: bez `permission-pending` i bez `state`.
      const types = (): string[] => [...new Set(events.map((e) => e.event.type))];
      const global = (): number => events.filter((e) => e.scope === 'global').length;
      expect(types()).toEqual(['session-changed']);
      expect(global()).toBe(1);
      // Ta sama klasa drugi raz to zdarzenie zerowe.
      driver.queue.push({ type: 'cli-dialog', cliDialog: 'dialog' });
      await flush();
      expect(global()).toBe(1);

      driver.queue.push({ type: 'cli-dialog' });
      await flush();
      expect(summaryOf(manager, id)?.cliDialog).toBeUndefined();
      expect(types()).toEqual(['session-changed']);
      expect(global()).toBe(2);
      expect(manager.transcript(id).pendingPermissions).toEqual([]);
      expect(notes, 'klasa nie budzi pusha').toHaveLength(notified);
    });

    it('spóźniony `cli-dialog` po wyjściu z blokady nie wskrzesza pola', async () => {
      const { manager, supervisor, id } = await withOneAgent();
      const driver = supervisor.driver('w9:p72');
      driver.queue.push({ type: 'screen-dialog', reason: 'unreadable', cliDialog: 'input' });
      await flush();
      driver.queue.push({ type: 'agent-state', state: 'working' });
      await flush();
      expect(summaryOf(manager, id)?.cliDialog).toBeUndefined();
      driver.queue.push({ type: 'cli-dialog', cliDialog: 'input' });
      await flush();
      expect(summaryOf(manager, id)?.cliDialog).toBeUndefined();
    });
  });

  it('resumable() RZUCA dla cwd spoza allow-listy, a awarię magazynu oddaje pustą listą',
    async () => {
      /*
       * Kontrakt `ManagerApi` mówił o `resumable()` „Nigdy nie rzuca", a metoda zaczyna od
       * `#assertAllowedCwd` — lista transkryptów zdradza treść pierwszych promptów, więc
       * bezwarunkowy `throw` jest tu WŁAŚCIWY, a kłamał docstring (naprawiony). Ten test
       * pilnuje, żeby nikt nie „naprawił" kodu pod stare zdanie: cichy `catch` zamieniłby
       * 400 z gotowym polskim copy w pustą listę, czyli w „nie ma czego wznawiać".
       */
      const supervisor = makeSupervisor();
      const manager = await build(supervisor, makeDeps(), {
        // Magazyn CLI, którego nie da się przeczytać — druga połowa zdania z kontraktu.
        resumableReader: () => Promise.reject(new Error('brak katalogu ~/.claude/projects')),
      });

      await expect(manager.resumable('/etc')).rejects.toBeInstanceOf(BadRequestError);
      // Katalog Z allow-listy przechodzi mimo padniętego magazynu: pusta lista, nie wyjątek.
      await expect(manager.resumable(PROJECT)).resolves.toEqual([]);
    });

  it('nieświeży tryb panelu poza RAROG_YOLO_ROOTS wstrzymuje wysyłkę (reguła 11.7)', async () => {
    const { manager, supervisor, id } = await withOneAgent();
    supervisor.freshMode = 'unknown';

    // Zdanie ma mówić, co zrobić (np. nieznany dialog CLI przy `--resume`).
    await expect(manager.sendMessage(id, 'zdanie z telefonu'))
      .rejects.toThrow(HERDR_MODE_UNKNOWN_MESSAGE.text);
    await expect(manager.sendMessage(id, 'zdanie z telefonu'))
      .rejects.toBeInstanceOf(BadRequestError);
    expect(HERDR_MODE_UNKNOWN_MESSAGE.text).toContain('Answer in the terminal');
    expect(supervisor.log.of('send')).toEqual([]);
    // Odczyt stopki NAPRAWDĘ się odbył — to jest różnica między „nie wiem" a „nie pytałem".
    expect(supervisor.modeReads).toBeGreaterThan(0);
  });

  it('karta BEZ inputu jest czerwona i nie da się jej ZATWIERDZIĆ (fail-closed)',
    async () => {
      const { manager, supervisor, id } = await withOneAgent();
      /*
       * `input: null` znaczy „Rarog nie wie, co to jest": rozjazd nazwy narzędzia między
       * jsonl a ekranem albo nieudane parsowanie opcji po ponowieniu. Klasyfikator nie ma
       * czego czytać, więc ryzyko jest czerwone Z DEFINICJI, a zatwierdzenia nie ma wcale.
       */
      supervisor.driver('w9:p72').queue.push({
        type: 'permission-request',
        reqId: 'tool-9',
        toolName: 'Bash',
        input: null,
        displayText: '(wycinek ekranu)',
      });
      await flush();

      expect(manager.transcript(id).pendingPermissions[0]?.risk).toBe('red');
      /*
       * `canAllow: false` jedzie na telefon RAZEM z kartą. Bez tego pola PWA rysowałaby
       * „Zatwierdź", które zawsze kończy się 409 — a przycisk bez pokrycia jest gorszy niż
       * jego brak (reguła 11.1). To jest ta sama prawda, co `#undecidable`, tylko podana
       * klientowi wprost, zamiast zostawiana mu do odgadnięcia po `risk === 'red'`.
       */
      expect(manager.transcript(id).pendingPermissions[0]?.canAllow).toBe(false);
      await expect(manager.resolvePermission(id, 'tool-9', 'allow', 'iPhone'))
        .rejects.toThrow(BadStateError);
      expect(supervisor.log.calls).toEqual([]);

      // „Odrzuć" przechodzi — `escape` jest bezpieczny z konstrukcji.
      await expect(manager.resolvePermission(id, 'tool-9', 'deny', 'iPhone'))
        .resolves.toEqual({ outcome: 'ok' });
      expect(supervisor.log.sterowanie()).toEqual(['respondPermission:deny']);
    });

  /*
   * Kontrakt `DecisionOutcome` po stronie MANAGERA: pending schodzi z mapy dopiero
   * po `applied`. Manager rozstrzygający first-wins PRZED wywołaniem drivera
   * przy każdej odmowie zjadałby kartę z telefonu, choć dialog stoi dalej w terminalu.
   */
  it('`refused` NIE zdejmuje karty — drugie urządzenie widzi ją dalej', async () => {
    const { manager, supervisor, id } = await withOneAgent();
    const driver = supervisor.driver('w9:p72');
    driver.queue.push({
      type: 'permission-request',
      reqId: 'tool-1',
      toolName: 'Bash',
      input: { command: 'ls' },
      displayText: 'ls',
    });
    await flush();
    expect(manager.transcript(id).pendingPermissions).toHaveLength(1);

    driver.decisionOutcome = { kind: 'refused', reason: 'no-digit' };
    await expect(manager.resolvePermission(id, 'tool-1', 'allow', 'iPhone'))
      .resolves.toEqual({ outcome: 'refused', reason: 'no-digit' });
    // Karta stoi dalej — dialog w terminalu też stoi, a odbudową zajmuje się driver.
    expect(manager.transcript(id).pendingPermissions).toHaveLength(1);
    // …i pierwsza próba niczego nie „zużyła": druga, udana, przechodzi normalnie.
    driver.decisionOutcome = { kind: 'applied' };
    await expect(manager.resolvePermission(id, 'tool-1', 'allow', 'iPad'))
      .resolves.toEqual({ outcome: 'ok' });
    expect(manager.transcript(id).pendingPermissions).toHaveLength(0);
  });

  it('interrupt W TRAKCIE decyzji: jeden escape i jedno rozstrzygnięcie karty', async () => {
    /*
     * Wyścig: telefon tapie „Zatwierdź", driver trzyma cyfrę na odczycie ekranu,
     * a w tym oknie leci `interrupt` (drugie urządzenie albo „×"). Wygaszenie NIE ma wtedy
     * dokładać driverowi `deny` — escape wylądowałby ZA cyfrą, na dokładkę do tego, który
     * wysyła sam `interrupt()`, a dwa Esc pod rząd to w Claude Code rewind, nie anulowanie.
     */
    const { manager, supervisor, id } = await withOneAgent();
    const driver = supervisor.driver('w9:p72');
    driver.queue.push({
      type: 'permission-request',
      reqId: 'tool-1', toolName: 'Bash', input: { command: 'rm -rf /tmp/x' },
      displayText: 'rm -rf /tmp/x',
    });
    await flush();
    const events = record(manager);

    driver.holdDecision = true;
    const decision = manager.resolvePermission(id, 'tool-1', 'allow', 'iPhone');
    await manager.interrupt(id);
    driver.settleDecision();

    // Karty już nie ma, więc udana wysyłka cyfry nie może wrócić jako 200.
    await expect(decision).resolves.toEqual({ outcome: 'gone' });
    await flush();

    expect(supervisor.log.sterowanie()).toEqual(['respondPermission:allow', 'interrupt']);
    // Jedno zdarzenie na permId i to `expired` — nigdy `allow` PO ogłoszonym `expired`.
    const resolved = events
      .map((e) => e.event)
      .filter((e) => e.type === 'permission-resolved' && e.permId === 'tool-1');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ decision: 'expired' });
    // Powtórka z drugiego urządzenia dostaje 410 „wygasło", a nie 409 „ktoś już zdecydował".
    await expect(manager.resolvePermission(id, 'tool-1', 'allow', 'iPad'))
      .resolves.toEqual({ outcome: 'gone' });
  });

  it('`stale` z drivera gasi kartę i daje 410 z eventem `expired`', async () => {
    const { manager, supervisor, id } = await withOneAgent();
    const driver = supervisor.driver('w9:p72');
    driver.queue.push({
      type: 'permission-request',
      reqId: 'tool-1', toolName: 'Bash', input: { command: 'ls' }, displayText: 'ls',
    });
    await flush();

    driver.decisionOutcome = { kind: 'stale' };
    await expect(manager.resolvePermission(id, 'tool-1', 'allow', 'iPhone'))
      .resolves.toEqual({ outcome: 'gone' });
    expect(manager.transcript(id).pendingPermissions).toHaveLength(0);
  });

  it('`refused` przy pytaniu agenta zostawia pytanie na ekranie', async () => {
    const { manager, supervisor, id } = await withOneAgent();
    const driver = supervisor.driver('w9:p72');
    driver.queue.push({
      type: 'question-request',
      reqId: 'q-1',
      questions: [{
        header: 'Wariant', question: 'Który wariant?', multiSelect: false,
        options: [{ label: 'A' }, { label: 'B' }],
      }],
    });
    await flush();
    expect(manager.transcript(id).pendingQuestions).toHaveLength(1);

    driver.answerOutcome = { kind: 'refused', reason: 'screen-changed' };
    await expect(manager.answerQuestion(id, 'q-1', [['A']]))
      .resolves.toEqual({ outcome: 'refused', reason: 'screen-changed' });
    expect(manager.transcript(id).pendingQuestions).toHaveLength(1);
  });

  it('wymiana drivera przy reattach gasi karty starego drivera', async () => {
    /*
     * Koniec strumienia drivera herdr zostawia karty ŚWIADOMIE (`#markStale` — mrugnięcie
     * socketa nie ma gasić decyzji), ale ich callbacki są domknięte na STARYM driverze.
     * Bez sprzątnięcia przy wymianie tapnięcie w taką kartę idzie w martwy obiekt i ginie
     * bez śladu: dialog stoi w terminalu, a decyzja z telefonu nie wychodzi.
     */
    const { manager, supervisor, id } = await withOneAgent();
    const driver = supervisor.driver('w9:p72');
    driver.queue.push({
      type: 'permission-request',
      reqId: 'tool-2',
      toolName: 'Bash',
      input: { command: 'rm -rf /tmp/x' },
      displayText: 'rm -rf /tmp/x',
    });
    await flush();
    expect(manager.transcript(id).pendingPermissions).toHaveLength(1);

    // Urwany strumień: karta zostaje (stale), decyzje wciąż możliwe do powrotu panelu…
    driver.queue.close();
    await flush();
    expect(manager.get(id)?.stale).toBe(true);
    expect(manager.transcript(id).pendingPermissions).toHaveLength(1);

    // …ale POWRÓT wymienia driver — stara karta gaśnie, a decyzja o niej dostaje `gone`,
    // nie ciche nic. Świeżą kartę wystawi nowy driver własną oceną panelu.
    supervisor.reattach(makeAgent());
    await flush();
    expect(manager.transcript(id).pendingPermissions).toHaveLength(0);
    await expect(manager.resolvePermission(id, 'tool-2', 'allow', 'iPhone'))
      .resolves.toEqual({ outcome: 'gone' });
  });

  it('permission-cleared gasi kartę, a decyzja po niej jest no-opem', async () => {
    const { manager, supervisor, id } = await withOneAgent();
    const driver = supervisor.driver('w9:p72');
    driver.queue.push({
      type: 'permission-request',
      reqId: 'tool-1',
      toolName: 'Bash',
      input: { command: 'ls' },
      displayText: 'ls',
    });
    await flush();
    expect(manager.transcript(id).pendingPermissions).toHaveLength(1);
    // Karta z PEŁNYM inputem z jsonl da się zatwierdzić — druga strona bramki `canAllow`.
    expect(manager.transcript(id).pendingPermissions[0]?.canAllow).toBe(true);

    driver.queue.push({ type: 'permission-cleared', reqId: 'tool-1' });
    await flush();

    expect(manager.transcript(id).pendingPermissions).toHaveLength(0);
    /*
     * Człowiek odpowiedział przy biurku — tapnięcie w kartę na telefonie nie ma prawa wysłać
     * cyfry do dialogu, którego już nie ma. Decyzja o WYGASZONEJ karcie to `gone` (410),
     * czyli „ta prośba się skończyła", a nie ciche `escape` do panelu, który ruszył dalej.
     */
    await expect(manager.resolvePermission(id, 'tool-1', 'deny', 'iPhone'))
      .resolves.toEqual({ outcome: 'gone' });
    expect(supervisor.log.calls).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Start Raroga i status
  // -------------------------------------------------------------------------

  it('start Raroga sprząta stare uploady, zanim podepnie pierwszy panel', async () => {
    const deps = makeDeps();
    const supervisor = makeSupervisor();
    await build(supervisor, deps);
    expect(deps.swept).toEqual([[PROJECT]]);
  });

  it('herdrStatus() oddaje stan nadzorcy do ramki startowej', async () => {
    const supervisor = makeSupervisor();
    supervisor.setStatus({ available: true, agentCount: 17, readOnly: false });
    const manager = await build(supervisor, makeDeps());
    expect(manager.herdrStatus?.()).toMatchObject({ agentCount: 17, available: true });
  });

  it('bez nadzorcy herdr nie ma ani statusu, ani sesji herdr', async () => {
    const manager = await createManager({
      demo: false, dataDir, projects: [{ path: PROJECT, name: 'atlas' }], projectRoots: [],
      gitStatus: null, maxPanes: 6,
    });
    managers.push(manager);
    await manager.ready;
    expect(manager.herdrStatus?.()).toBeUndefined();
    expect(manager.list()).toEqual([]);
  });

  it('nieudane podpięcie (panel zniknął w locie) nie wywraca listy', async () => {
    const supervisor = makeSupervisor();
    supervisor.attachThrows = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const manager = await build(supervisor, makeDeps());
    supervisor.appear(makeAgent());
    await flush();

    const session = manager.list()[0];
    expect(session?.paneId).toBe('w9:p72');
    expect(session?.stale).toBe(true);
    warn.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Git: koniec tury i obserwator `.git`
  // -------------------------------------------------------------------------

  /**
   * Seria Editów pod koniec tury wpadała w throttle, a wejście w sesję w ciągu 30 s od
   * ostatniego odczytu też — karta „gotowe" pokazywała liczby sprzed ostatnich edycji.
   * Koniec tury (`running` → nie-pracujący) pyta gita z pominięciem OBU throttle'i.
   */
  it('koniec tury odświeża gita mimo throttle 30 s', async () => {
    const run = vi.fn(async () => ({ ok: true, stdout: '# branch.head main\n' }));
    const supervisor = makeSupervisor();
    await build(supervisor, makeDeps(), {
      gitStatus: new GitStatusWatcher({ run, throttleMs: 3_000, now: () => 0 }),
      now: () => 0,
    });
    supervisor.appear(makeAgent());
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    const driver = supervisor.driver('w9:p72');

    driver.queue.push({ type: 'agent-state', state: 'working' });
    await flush();
    // Wejście w pracę NIE pyta — dopiero jej koniec.
    expect(run).toHaveBeenCalledTimes(1);

    driver.queue.push({ type: 'result', subtype: 'success' });
    await flush();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('dialog zgody w środku tury NIE odświeża gita; koniec tury ze stojącego dialogu — tak', async () => {
    const run = vi.fn(async () => ({ ok: true, stdout: '# branch.head main\n' }));
    const supervisor = makeSupervisor();
    await build(supervisor, makeDeps(), {
      gitStatus: new GitStatusWatcher({ run, throttleMs: 0, now: () => 0 }),
      now: () => 0,
    });
    supervisor.appear(makeAgent());
    await flush();
    const driver = supervisor.driver('w9:p72');
    driver.queue.push({ type: 'agent-state', state: 'working' });
    await flush();
    expect(run).toHaveBeenCalledTimes(1);

    // Dwadzieścia zgód w jednej turze nie ma prawa dać dwudziestu odczytów.
    driver.queue.push({ type: 'agent-state', state: 'blocked' });
    await flush();
    driver.queue.push({ type: 'agent-state', state: 'working' });
    await flush();
    driver.queue.push({ type: 'agent-state', state: 'blocked' });
    await flush();
    expect(run).toHaveBeenCalledTimes(1);

    // Tura kończy się ze stojącego dialogu (odmowa w terminalu) — to też koniec tury.
    driver.queue.push({ type: 'agent-state', state: 'idle', seen: false });
    await flush();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('start panelu (`starting` → bezczynny) nie dokłada odczytu ponad zasiew', async () => {
    const run = vi.fn(async () => ({ ok: true, stdout: '# branch.head main\n' }));
    const supervisor = makeSupervisor();
    await build(supervisor, makeDeps(), {
      gitStatus: new GitStatusWatcher({ run, throttleMs: 0, now: () => 0 }),
      now: () => 0,
    });
    supervisor.appear(makeAgent());
    await flush();
    supervisor.driver('w9:p72').queue.push({ type: 'agent-state', state: 'idle', seen: true });
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
  });

  /**
   * Commit w terminalu, lazygit albo nvim nie przechodzi przez sesję Claude — jedynym
   * świadkiem jest katalog `.git`. Manager rejestruje katalog sesji w obserwatorze przy
   * pojawieniu się karty, wyrejestrowuje przy zniknięciu, a zmiana pyta gita od razu.
   */
  it('obserwator `.git`: watch przy pojawieniu, odczyt po zmianie, unwatch po zniknięciu', async () => {
    const run = vi.fn(async () => ({ ok: true, stdout: '# branch.head main\n' }));
    const calls: string[] = [];
    const hook: { onChange: ((cwds: readonly string[]) => void) | null } = { onChange: null };
    const fake = {
      watch: (cwd: string) => { calls.push(`watch:${cwd}`); },
      unwatch: (cwd: string) => { calls.push(`unwatch:${cwd}`); },
      close: () => { calls.push('close'); },
    } as unknown as GitRepoWatcher;
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, makeDeps(), {
      gitStatus: new GitStatusWatcher({ run, throttleMs: 3_000, now: () => 0 }),
      gitWatcher: (cb) => { hook.onChange = cb; return fake; },
      now: () => 0,
    });
    supervisor.appear(makeAgent());
    await flush();
    const cwd = manager.list()[0]?.cwd ?? '';
    expect(calls).toEqual([`watch:${cwd}`]);
    expect(run).toHaveBeenCalledTimes(1);

    // Zmiana w `.git` w oknie throttle'a: odczyt i tak leci (force).
    expect(hook.onChange).not.toBeNull();
    hook.onChange?.([cwd]);
    await flush();
    expect(run).toHaveBeenCalledTimes(2);

    // Katalog bez sesji nie pyta o nic.
    hook.onChange?.(['/nie/ma/takiej/sesji']);
    await flush();
    expect(run).toHaveBeenCalledTimes(2);

    // `gone` zostawia kartę `done` (droga powrotu przez resume) — i zostawia obserwację:
    // gałąź projektu w sidebarze dalej ma być prawdziwa. Zdejmuje ją dopiero ukrycie karty.
    supervisor.emit({ type: 'gone', key: 'w9:p72' });
    await flush();
    expect(calls).toEqual([`watch:${cwd}`]);
    await manager.close(manager.list()[0]?.id ?? '');
    expect(calls).toEqual([`watch:${cwd}`, `unwatch:${cwd}`]);

    await manager.dispose();
    expect(calls.at(-1)).toBe('close');
  });

  /*
   * Wymuszony odczyt (watcher `.git`, koniec tury) potrafi lecieć kilka razy na minutę:
   * `git gc`, `git status` z nvima albo checkout gałęzi, która niczego nie zmieniła w drzewie.
   * Bez dedupu każdy taki odczyt rozgłaszałby `git-status` (strumień sesji) I `session-changed` (kanał
   * GLOBALNY, czyli do każdego urządzenia), choć wiersz gita wygląda identycznie.
   *
   * Granica dedupu jest cała w tym teście: pomijamy WYŁĄCZNIE odczyty wymuszone. Otwarcie
   * transkryptu emituje ZAWSZE, bo lista plików istnieje tylko w evencie `git-status`
   * (`SessionSummary` jej nie ma); bez tego nagłówek pokazałby „+1”, a rozwinięcie tej samej karty „Brak
   * zmienionych plików”.
   */
  it('trzy zmiany w `.git` bez zmiany treści = zero ramek; otwarcie transkryptu = ramka', async () => {
    const run = vi.fn(async () => ({
      ok: true, stdout: '# branch.head main\n1 .M N... 100644 100644 100644 a a src/x.ts\n',
    }));
    let clock = 0;
    const hook: { onChange: ((cwds: readonly string[]) => void) | null } = { onChange: null };
    const fake = {
      watch: () => undefined, unwatch: () => undefined, close: () => undefined,
    } as unknown as GitRepoWatcher;
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, makeDeps(), {
      gitStatus: new GitStatusWatcher({ run, throttleMs: 0, now: () => clock }),
      gitWatcher: (cb) => { hook.onChange = cb; return fake; },
      now: () => clock,
    });
    const events = record(manager);
    supervisor.appear(makeAgent());
    await flush();
    const id = manager.list()[0]?.id ?? '';
    const cwd = manager.list()[0]?.cwd ?? '';
    // Zasiew karty rozgłasza — klient dopiero co dostał wiersz.
    expect(events.filter((e) => e.event.type === 'git-status')).toHaveLength(1);
    const afterSeed = events.length;

    for (let i = 0; i < 3; i += 1) {
      hook.onChange?.([cwd]);
      await flush();
    }
    // Git pytany za każdym razem (watcher nie zgaduje, co się zmieniło)…
    expect(run).toHaveBeenCalledTimes(4);
    // …ale ANI JEDNEJ ramki: ani `git-status`, ani `session-changed` na kanale globalnym.
    expect(events).toHaveLength(afterSeed);

    // Wejście w sesję po tej ciszy MUSI dostać listę plików, choć treść się nie zmieniła.
    clock = 31_000;
    manager.transcript(id);
    await flush();
    expect(events.filter((e) => e.event.type === 'git-status')).toHaveLength(2);
  });

  it('zmiana treści po dedupie rozgłasza normalnie', async () => {
    let dirty = false;
    const run = vi.fn(async () => ({
      ok: true,
      stdout: dirty
        ? '# branch.head main\n1 .M N... 100644 100644 100644 a a src/x.ts\n'
        : '# branch.head main\n',
    }));
    const hook: { onChange: ((cwds: readonly string[]) => void) | null } = { onChange: null };
    const fake = {
      watch: () => undefined, unwatch: () => undefined, close: () => undefined,
    } as unknown as GitRepoWatcher;
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, makeDeps(), {
      gitStatus: new GitStatusWatcher({ run, throttleMs: 0, now: () => 0 }),
      gitWatcher: (cb) => { hook.onChange = cb; return fake; },
      now: () => 0,
    });
    const events = record(manager);
    supervisor.appear(makeAgent());
    await flush();
    const cwd = manager.list()[0]?.cwd ?? '';

    hook.onChange?.([cwd]);
    await flush();
    expect(events.filter((e) => e.event.type === 'git-status')).toHaveLength(1);

    // Zapis pliku w edytorze: podpis się zmienia, więc ramka leci mimo dedupu.
    dirty = true;
    hook.onChange?.([cwd]);
    await flush();
    const statuses = events.filter((e) => e.event.type === 'git-status');
    expect(statuses).toHaveLength(2);
    expect(statuses.at(-1)?.event).toMatchObject({ dirtyCount: 1, files: ['src/x.ts'] });
  });

  /*
   * Wejście w sesję W OKNIE throttle'a per sesja: odczytu nie ma (30 s od poprzedniego),
   * a `transcript-snapshot` listy plików nie niesie i replayu bez kursora nie ma. Klient dostaje
   * więc OSTATNI znany status ponownie (`#replayGitStatus`) — tę samą treść, którą Rarog już
   * rozgłosił. Dedup zostaje przy tej treści: najbliższy odczyt wymuszony bez zmiany nie dokłada
   * drugiej ramki.
   */
  it('wejście w sesję w oknie throttle’a: ostatni status jeszcze raz, wymuszony odczyt bez zmiany — nic', async () => {
    const run = vi.fn(async () => ({
      ok: true, stdout: '# branch.head main\n1 .M N... 100644 100644 100644 a a src/x.ts\n',
    }));
    let clock = 0;
    const hook: { onChange: ((cwds: readonly string[]) => void) | null } = { onChange: null };
    const fake = {
      watch: () => undefined, unwatch: () => undefined, close: () => undefined,
    } as unknown as GitRepoWatcher;
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, makeDeps(), {
      gitStatus: new GitStatusWatcher({ run, throttleMs: 0, now: () => clock }),
      gitWatcher: (cb) => { hook.onChange = cb; return fake; },
      now: () => clock,
    });
    const events = record(manager);
    supervisor.appear(makeAgent());
    await flush();
    const id = manager.list()[0]?.id ?? '';
    const cwd = manager.list()[0]?.cwd ?? '';
    expect(events.filter((e) => e.event.type === 'git-status')).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(1);

    // Otwarcie transkryptu 10 s po zasiewie — throttle per sesja odczytu NIE puszcza,
    // a klient i tak dostaje listę: tę samą ramkę, bez nowego procesu gita.
    clock = 10_000;
    manager.transcript(id);
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
    const statuses = events.filter((e) => e.event.type === 'git-status');
    expect(statuses).toHaveLength(2);
    expect(statuses.at(-1)?.event).toEqual(statuses[0]?.event);
    expect(statuses.at(-1)?.scope).toBe(id);

    // Zmiana w `.git` bez zmiany treści wiersza (np. `git gc`): klient tę treść już ma.
    hook.onChange?.([cwd]);
    await flush();
    expect(run).toHaveBeenCalledTimes(2);
    expect(events.filter((e) => e.event.type === 'git-status')).toHaveLength(2);
  });

  /*
   * To samo od strony KLIENTA: odczyt przed subskrypcją, wejście 10 s później,
   * żadnych dalszych zdarzeń. Strumień sesji bez kursora (snapshot, jak kursor obcego procesu)
   * ma nieść `transcript-snapshot`, a ZA nim ramkę `git-status` z plikami i ich
   * szczegółami — bez tego panel „zmiany w katalogu” stoi pusty do następnego wyzwalacza.
   */
  it('subskrybent wchodzący w oknie throttle’a dostaje pliki ZA snapshotem transkryptu', async () => {
    const run = vi.fn(async () => ({
      ok: true, stdout: '# branch.head main\n1 .M N... 100644 100644 100644 a a src/x.ts\n? nowy.md\n',
    }));
    let clock = 0;
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, makeDeps(), {
      gitStatus: new GitStatusWatcher({ run, throttleMs: 0, now: () => clock }),
      now: () => clock,
    });
    supervisor.appear(makeAgent());
    await flush();
    const id = manager.list()[0]?.id ?? '';
    const hub = new SseHub({ manager, serverStartId: 'start-1', protocolVersion: 3, heartbeatMs: 0 });
    hub.start();

    clock = 10_000;
    const chunks: string[] = [];
    hub.openSession(id, {
      writeHead: () => undefined, write: (chunk) => { chunks.push(chunk); return true; },
      end: () => undefined, on: () => undefined,
    }, null);
    await flush();
    hub.closeAll();

    const frames = chunks.join('').split('\n\n')
      .map((raw) => raw.split('\n').find((line) => line.startsWith('data: '))?.slice(6))
      .filter((data): data is string => data !== undefined)
      .map((data) => JSON.parse(data) as { type: string; files?: string[]; fileDetails?: unknown });
    expect(run).toHaveBeenCalledTimes(1);
    expect(frames.map((frame) => frame.type)).toEqual(['transcript-snapshot', 'git-status']);
    expect(frames[1]).toMatchObject({
      files: ['src/x.ts', 'nowy.md'],
      fileDetails: [{ path: 'src/x.ts', kind: 'modified' }, { path: 'nowy.md', kind: 'added' }],
    });
  });

  /*
   * Odczyt WYMUSZONY o tej samej treści (dedup, bez ramki) domyka się między
   * zaplanowaniem ponownej emisji a jej mikrozadaniem. Podmieniałby `lastGitEvent` na nowy obiekt,
   * a mikrozadanie porównuje obiekt — klient wchodzący w sesję dostawałby sam snapshot.
   *
   * Atrapa watchera oddaje wynik JUŻ rozstrzygnięty, więc kolejność jest pewna: `.then` odczytu
   * wymuszonego trafia do kolejki mikrozadań PRZED ponowną emisją z `openSession`.
   */
  it('odczyt wymuszony bez zmiany w oknie ponownej emisji nie kasuje ramki dla wchodzącego', async () => {
    const stdout = '# branch.head main\n1 .M N... 100644 100644 100644 a a src/x.ts\n';
    const reads: boolean[] = [];
    const fakeGit = {
      status: (_cwd: string, force = false) => {
        reads.push(force);
        return Promise.resolve(parseGitStatusV2(stdout));
      },
    } as unknown as GitStatusWatcher;
    let clock = 0;
    const hook: { onChange: ((cwds: readonly string[]) => void) | null } = { onChange: null };
    const fake = {
      watch: () => undefined, unwatch: () => undefined, close: () => undefined,
    } as unknown as GitRepoWatcher;
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, makeDeps(), {
      gitStatus: fakeGit, gitWatcher: (cb) => { hook.onChange = cb; return fake; }, now: () => clock,
    });
    supervisor.appear(makeAgent());
    await flush();
    const id = manager.list()[0]?.id ?? '';
    const cwd = manager.list()[0]?.cwd ?? '';
    const hub = new SseHub({ manager, serverStartId: 'start-1', protocolVersion: 3, heartbeatMs: 0 });
    hub.start();

    clock = 10_000;
    hook.onChange?.([cwd]);
    const chunks: string[] = [];
    hub.openSession(id, {
      writeHead: () => undefined, write: (chunk) => { chunks.push(chunk); return true; },
      end: () => undefined, on: () => undefined,
    }, null);
    await flush();
    hub.closeAll();

    // Zasiew i odczyt wymuszony; wejście w sesję odczytu nie robi (throttle 30 s po wymuszonym).
    expect(reads).toEqual([false, true]);
    const types = chunks.join('').split('\n\n')
      .map((raw) => raw.split('\n').find((line) => line.startsWith('data: '))?.slice(6))
      .filter((data): data is string => data !== undefined)
      .map((data) => (JSON.parse(data) as { type: string }).type);
    expect(types).toEqual(['transcript-snapshot', 'git-status']);
  });

  it('koszt gita: ramki `git-status` liczone w oknie, linia `git: okno …` w logu po jego końcu', async () => {
    let clock = 0;
    const lines: string[] = [];
    const supervisor = makeSupervisor();
    await build(supervisor, makeDeps(), { now: () => clock, logger: (line) => { lines.push(line); } });
    supervisor.appear(makeAgent());
    await flush();
    const push = async (dirty: number): Promise<void> => {
      supervisor.driver('w9:p72').queue.push({
        type: 'git-status', branch: 'main', dirtyCount: dirty, files: [],
      });
      await flush();
    };
    await push(1);
    await push(2);
    expect(lines.filter((line) => line.startsWith(GIT_STATS_WINDOW_LOG))).toEqual([]);
    clock = 5 * 60_000;
    await push(3);
    expect(lines.filter((line) => line.startsWith(GIT_STATS_WINDOW_LOG))).toEqual([
      expect.stringMatching(new RegExp(`^${GIT_STATS_WINDOW_LOG} 300 s — reads 0 .*git-status frames 2$`)),
    ]);
  });

  it('RAROG_GIT_FILE_DETAILS=0: ramka bez `fileDetails` — z odczytu gita i z drivera', async () => {
    const run = vi.fn(async () => ({
      ok: true, stdout: '# branch.head main\n1 .M N... 100644 100644 100644 a a src/x.ts\n',
    }));
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, makeDeps(), {
      gitStatus: new GitStatusWatcher({ run, throttleMs: 0, now: () => 0 }),
      gitFileDetails: false,
    });
    const events = record(manager);
    supervisor.appear(makeAgent());
    await flush();
    supervisor.driver('w9:p72').queue.push({
      type: 'git-status', branch: 'main', dirtyCount: 1, files: ['src/y.ts'],
      fileDetails: [{ path: 'src/y.ts', kind: 'added', linesAdded: 3, linesDeleted: 0 }],
    });
    await flush();
    const statuses = events.filter((e) => e.event.type === 'git-status');
    expect(statuses).toHaveLength(2);
    for (const { event } of statuses) expect(event).not.toHaveProperty('fileDetails');
    expect(manager.list()[0]?.dirtyCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Throttle gita
  // -------------------------------------------------------------------------

  it('git dla sesji herdr jest pytany nie częściej niż raz na 30 s', async () => {
    const run = vi.fn(async () => ({ ok: true, stdout: '# branch.head main\n' }));
    let clock = 0;
    const supervisor = makeSupervisor();
    await build(supervisor, makeDeps(), {
      // Throttle po stronie watchera wyłączony — mierzymy WYŁĄCZNIE limit per sesja.
      gitStatus: new GitStatusWatcher({ run, throttleMs: 0, now: () => clock }),
      now: () => clock,
    });
    supervisor.appear(makeAgent());
    await flush();
    const driver = supervisor.driver('w9:p72');
    // Zasiew przy pojawieniu się karty — od niego liczymy, bo mierzymy LIMIT,
    // a nie liczbę wywołań w ogóle.
    expect(run).toHaveBeenCalledTimes(1);

    const toolCall: DriverEvent = {
      type: 'message', role: 'assistant',
      blocks: [{ type: 'tool-call', toolName: 'Bash', summary: 'ls' }],
    };
    driver.queue.push(toolCall);
    await flush();
    driver.queue.push(toolCall);
    await flush();
    // Dwa tool-calle w oknie 30 s od zasiewu: ani jednego pytania więcej.
    expect(run).toHaveBeenCalledTimes(1);

    clock = 31_000;
    driver.queue.push(toolCall);
    await flush();
    expect(run).toHaveBeenCalledTimes(2);
  });

  /**
   * Git cannot run ONLY after a tool call and when the transcript opens: after a Rarog restart only the session someone
   * just entered would know its branch. The project row in the sidebar asks for the branch of EVERY project at once and
   * cannot wait for those events: a project idle for a week triggers none of them and is still on the list.
   */
  it('karta pojawiająca się na liście od razu zna gałąź — bez tool-calla i bez wejścia w nią', async () => {
    const run = vi.fn(async () => ({ ok: true, stdout: '# branch.head main\n# branch.ab +3 -1\n' }));
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, makeDeps(), {
      gitStatus: new GitStatusWatcher({ run, throttleMs: 0, now: () => 0 }),
    });
    supervisor.appear(makeAgent());
    await flush();

    const id = manager.list()[0]?.id ?? '';
    expect(manager.get(id)?.branch).toBe('main');
    expect(manager.get(id)?.ahead).toBe(3);
    expect(manager.get(id)?.behind).toBe(1);
  });

  /**
   * TEST OBOWIĄZKOWY. Zasiew nie ma prawa zamienić się w lawinę: przy dwudziestu panelach
   * w kilkunastu repo start Raroga odpaliłby tyle `git status`, ile jest paneli. Równoległe
   * pytania o TEN SAM katalog scala `#inFlight` w watcherze — jeden spawn na repo.
   */
  it('dwa panele w jednym repo dają JEDEN odczyt gita, nie dwa', async () => {
    const run = vi.fn(async () => ({ ok: true, stdout: '# branch.head main\n' }));
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, makeDeps(), {
      gitStatus: new GitStatusWatcher({ run, throttleMs: 0, now: () => 0 }),
    });
    supervisor.appear(makeAgent());
    supervisor.appear(makeAgent({
      key: 'w9:p73', paneId: 'w9:p73',
      agentSessionId: '22222222-2222-4222-8222-222222222222', tabId: 'w9:t4',
    }));
    await flush();

    expect(run).toHaveBeenCalledTimes(1);
    // …a gałąź mają OBIE karty: jeden odczyt zasila wszystkie sesje katalogu.
    expect(manager.list().map((s) => s.branch)).toEqual(['main', 'main']);
  });

  /*
   * Dwa taby w JEDNYM repo mają pokazywać te same liczniki gita: git jest prawdą o KATALOGU, nie o SESJI. Jeden odczyt
   * zasila wszystkie sesje tego cwd i ustawia im wspólny znacznik throttle'a (drugi tab nie robi drugiego spawna o to
   * samo).
   */
  it('świeży git-status zasila WSZYSTKIE sesje tego samego katalogu', async () => {
    const run = vi.fn(async () => ({ ok: true, stdout: '# branch.head main\n1 .M N... 100644 100644 100644 a a src/x.ts\n' }));
    let clock = 0;
    const supervisor = makeSupervisor();
    const manager = await build(supervisor, makeDeps(), {
      gitStatus: new GitStatusWatcher({ run, throttleMs: 0, now: () => clock }),
      now: () => clock,
    });
    supervisor.appear(makeAgent());
    supervisor.appear(makeAgent({ key: 'w9:p73', paneId: 'w9:p73', agentSessionId: '22222222-2222-4222-8222-222222222222', tabId: 'w9:t4' }));
    await flush();
    const [first, second] = manager.list();
    expect(second?.cwd).toBe(first?.cwd);

    // Tool-call TYLKO w pierwszej sesji…
    supervisor.driver('w9:p72').queue.push({
      type: 'message', role: 'assistant',
      blocks: [{ type: 'tool-call', toolName: 'Bash', summary: 'ls' }],
    });
    await flush();

    // …a branch i licznik brudnych mają OBIE karty; git spytany raz.
    expect(run).toHaveBeenCalledTimes(1);
    expect(manager.get(first?.id ?? '')?.branch).toBe('main');
    expect(manager.get(second?.id ?? '')?.branch).toBe('main');
    expect(manager.get(second?.id ?? '')?.dirtyCount).toBe(1);

    // Wspólny znacznik throttle'a: druga sesja nie odpala drugiego spawna od razu.
    supervisor.driver('w9:p73').queue.push({
      type: 'message', role: 'assistant',
      blocks: [{ type: 'tool-call', toolName: 'Bash', summary: 'ls' }],
    });
    await flush();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
