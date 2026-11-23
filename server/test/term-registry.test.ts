/**
 * Terminal PTY — WSPÓŁBIEŻNOŚĆ rejestru na atrapach.
 *
 * Ani jednej prawdziwej powłoki i ani jednego procesu kontrolera: BACKEND i timer karencji są
 * wstrzykiwane (`TermRegistryOptions.backend` / `setTimer`), a gniazda to atrapy `TermClient`.
 * To jedyny sposób, żeby w ogóle dotknąć rzeczy, które w żywym terminalu zdarzają się raz na
 * tysiąc wejść i tylko na kiepskim łączu: powrót DOKŁADNIE w oknie planowego killa, zator
 * bufora ostatniego gniazda, spóźnione `onExit` starego strumienia.
 *
 * Bramki cyklu życia jako czyste funkcje mają własny plik (`term-lifecycle.test.ts`), HTTP
 * swój (`term-router.test.ts`), backend panelowy swój (`term-herdr-backend.test.ts`), a żywy
 * panel herdr — `term-integration.test.ts`.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { say } from '@rarog/shared/sentences';
import { TERM_SLOTS_MAX } from '@rarog/shared';
import { loadConfig } from '../src/config.ts';
import type { Logger } from '../src/router.ts';
import { TERM_SOCKET_BUFFER_LIMIT_BYTES, termIdFor } from '../src/term/lifecycle.ts';
import { TermHandleStaleError } from '../src/term/backend.ts';
import {
  TERM_LAZYGIT_START_FALLBACK_MS, TERM_LAZYGIT_START_INPUT, TermRegistry,
} from '../src/term/registry.ts';
import type { TermClient } from '../src/term/registry.ts';
import type {
  TermBackend, TermBackendSession, TermHistory, TermReconcileResult, TermReleaseOptions,
  TermSessionHandle, TermStream, TermStreamOptions,
} from '../src/term/backend.ts';

const CWD = '/Users/testowy/Projects/rarog';

/** Strumień backendu — notuje wywołania, nic nie robi. */
class FakeStream implements TermStream {
  readonly written: string[] = [];
  readonly resizes: { cols: number; rows: number }[] = [];
  readonly scrolls: number[] = [];
  /** Ile razy rejestr ZWOLNIŁ ten strumień (`release`) — planowo albo przy zamknięciu. */
  killed = 0;
  /** Opcje każdego `release` — przywrócenie rozmiaru wolno zamówić wyłącznie po karencji. */
  readonly releases: (TermReleaseOptions | undefined)[] = [];
  paused = 0;
  resumed = 0;
  refreshed = 0;

  constructor(readonly opts: TermStreamOptions) {}

  write(data: string): void { this.written.push(data); }
  resize(cols: number, rows: number): void { this.resizes.push({ cols, rows }); }
  scroll(lines: number): void { this.scrolls.push(lines); }
  refresh(): void { this.refreshed += 1; }
  pause(): void { this.paused += 1; }
  resume(): void { this.resumed += 1; }
  release(opts?: TermReleaseOptions): void {
    this.killed += 1;
    this.releases.push(opts);
  }

  /** Bajty z powłoki. */
  emitData(chunk: string): void { this.opts.onData(Buffer.from(chunk, 'utf8')); }
  /** Koniec życia TEGO strumienia — planowy albo pad, rejestr ma to rozróżnić sam. */
  emitExit(): void { this.opts.onExit({ detail: 'atrapa' }); }
}

/**
 * Backend-atrapa. `respawnOnAttach: false` jest tu ŚWIADOME: jedyny backend produkcyjny
 * (panel herdr) respawnuje strumień przy każdym gnieździe, więc bez tej atrapy druga gałąź
 * kontraktu (`refresh()` zamiast respawnu) nie miałaby czym być sprawdzona — a to ona
 * decyduje, czy rejestr nie gubi żywego strumienia przy powrocie klienta.
 */
class FakeBackend implements TermBackend {
  readonly streams: FakeStream[] = [];
  readonly killed: string[] = [];
  readonly respawnOnAttach = false;

  refusal(): null { return null; }

  /**
   * Role, z jakimi rejestr wołał `ensureSession` — kontrakt „rola jedzie do backendu"
   * (etykieta taba) jest tu asercją.
   */
  readonly ensured: { id: string; role: string }[] = [];
  /**
   * Tożsamości, które atrapa uznaje za JUŻ ISTNIEJĄCE panele — pierwszy `ensureSession` odda
   * dla nich `fresh: false`, czyli dokładnie to, co po restarcie Raroga widzi adopcja.
   */
  readonly known = new Set<string>();

  /** Katalogi, z którymi rejestr wołał `ensureSession` (pisownia, z której liczy się tożsamość). */
  readonly ensuredCwds: string[] = [];

  ensureSession(id: string, cwd: string, role = 'shell'): Promise<TermSessionHandle> {
    this.ensured.push({ id, role });
    this.ensuredCwds.push(cwd);
    const fresh = !this.known.has(id);
    this.known.add(id);
    return Promise.resolve({ ref: `panel-${id}`, id, fresh });
  }

  /** Odzyskiwanie paneli jest sprawą backendu herdr — rejestr go nie woła. */
  reconcile(): Promise<TermReconcileResult> {
    return Promise.resolve({
      ran: false, confirmed: new Map(), restored: [], migrated: [], unknown: new Set(), conflicts: new Set(),
    });
  }

  dispose(): void { /* atrapa nie ma czego zamykać */ }

  attach(_handle: TermSessionHandle, opts: TermStreamOptions): Promise<TermStream> {
    const stream = new FakeStream(opts);
    this.streams.push(stream);
    return Promise.resolve(stream);
  }

  listSessions(): Promise<TermBackendSession[]> { return Promise.resolve([]); }

  /** Uchwyty, o których nazwę procesu pytał rejestr — kolejność i liczba są tu asercją. */
  readonly procAsked: string[] = [];
  /** Co atrapa odda jako nazwę procesu; `''` = „backend jeszcze nie wie". */
  procName = '';

  processName(handle: TermSessionHandle): string {
    this.procAsked.push(handle.id);
    return this.procName;
  }

  killSession(handle: TermSessionHandle): Promise<void> {
    this.killed.push(handle.ref);
    return Promise.resolve();
  }

  /** Uchwyty, którym rejestr kazał odświeżyć token — kolejność jest asercją. */
  readonly refreshed: string[] = [];
  /** Tożsamości, dla których atrapa odpowie „panel nie jest już twój". */
  readonly lostTokens = new Set<string>();
  /** Gdy ustawione, KAŻDE odświeżenie pada (martwe gniazdo). */
  refreshError: Error | null = null;

  refreshSession(handle: TermSessionHandle): Promise<boolean> {
    this.refreshed.push(handle.id);
    if (this.refreshError !== null) return Promise.reject(this.refreshError);
    return Promise.resolve(!this.lostTokens.has(handle.id));
  }

  /** Wywołania `readHistory` — rejestr ma je tylko PRZEPUŚCIĆ, niczego nie trzymając. */
  readonly historyCalls: { ref: string; lines: number }[] = [];
  /** Co atrapa odda (albo rzuci) na `readHistory` — test podmienia. */
  historyResult: (() => Promise<TermHistory>) | null = null;

  readHistory(handle: TermSessionHandle, lines: number): Promise<TermHistory> {
    this.historyCalls.push({ ref: handle.ref, lines });
    if (this.historyResult !== null) return this.historyResult();
    return Promise.resolve({ text: 'historia', truncated: false });
  }
}

/** Gniazdo klienta wg kontraktu `TermClient`. */
class FakeClient implements TermClient {
  readonly data: string[] = [];
  readonly events: ({ t: 'exit' } | { t: 'err'; msg: string })[] = [];
  terminated = 0;
  buffered = 0;

  sendData(chunk: Buffer): void { this.data.push(chunk.toString('utf8')); }
  sendEvent(frame: { t: 'exit' } | { t: 'err'; msg: string }): void { this.events.push(frame); }
  bufferedAmount(): number { return this.buffered; }
  terminate(): void { this.terminated += 1; }
}

/**
 * Timery pod kontrolą testu — bez czekania 120 s i bez `vi.useFakeTimers`.
 *
 * WIELE slotów naraz, bo rejestr uzbraja dwa różne timery: karencję
 * i zapasowy termin wpisania startu lazygita. Jednoslotowa atrapa kasowałaby
 * jeden drugim i pokazywałaby wpis, którego w produkcji by nie było. `fire()` odpala
 * NAJSTARSZY uzbrojony, `fireMs(ms)` — ten o konkretnym opóźnieniu.
 */
class FakeTimers {
  private readonly timers = new Map<number, { cb: () => void; ms: number }>();
  private nextId = 1;
  armed = 0;
  cleared = 0;

  readonly set = (cb: () => void, ms: number): NodeJS.Timeout => {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.set(id, { cb, ms });
    this.armed += 1;
    return { unref: () => { /* atrapa */ }, id } as unknown as NodeJS.Timeout;
  };

  readonly clear = (timer: NodeJS.Timeout): void => {
    const id = (timer as unknown as { id?: number }).id;
    if (id === undefined || !this.timers.delete(id)) return;
    this.cleared += 1;
  };

  get pending(): boolean { return this.timers.size > 0; }

  /** Upływ NAJSTARSZEGO uzbrojonego timera (w praktyce: karencji). */
  fire(): void {
    const first = [...this.timers.keys()][0];
    if (first === undefined) throw new Error('żaden timer nie był uzbrojony');
    const entry = this.timers.get(first);
    this.timers.delete(first);
    entry?.cb();
  }

  /** Upływ timera o KONKRETNYM opóźnieniu — rozróżnia karencję od startu lazygita. */
  fireMs(ms: number): void {
    for (const [id, entry] of this.timers) {
      if (entry.ms !== ms) continue;
      this.timers.delete(id);
      entry.cb();
      return;
    }
    throw new Error(`nie było uzbrojonego timera na ${String(ms)} ms`);
  }
}

interface Harness {
  registry: TermRegistry;
  id: string;
  spawned: FakeStream[];
  backend: FakeBackend;
  timers: FakeTimers;
  logs: string[];
}

/** Pętla oczekiwania — spawn rozwiązuje się w obietnicy backendu, więc nie ma na co zrobić `await`. */
async function waitUntil(what: string, predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
  }
  throw new Error(`nie doczekano: ${what}`);
}

/**
 * Oddanie sterowania pętli zdarzeń — uchwyt backendu rozwiązuje się OBIETNICĄ, więc `list()`
 * tuż po `open()` z założenia jeszcze o nazwie procesu nie wie (to jest kontrakt, nie usterka:
 * pierwsza lista po starcie serwera niesie `proc: ''`).
 */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
}

function makeHarness(termMax = 4): Harness {
  const logs: string[] = [];
  const logger: Logger = {
    info: (msg: string) => { logs.push(msg); },
    error: (msg: string) => { logs.push(msg); },
  };
  const backend = new FakeBackend();
  const timers = new FakeTimers();
  const config = loadConfig({
    RAROG_DEMO: '1',
    RAROG_TERM: '1',
    RAROG_TERM_MAX: String(termMax),
    RAROG_PROJECT_ROOTS: '/Users/testowy/Projects',
  });
  const registry = new TermRegistry({
    config,
    logger,
    backend,
    // Ścieżka jest ZMYŚLONA — prawdziwy `realpathSync` wywaliłby ją na ENOENT, a tożsamość
    // terminala i tak liczy się z tego, co ta funkcja odda.
    realPath: (p) => p,
    setTimer: timers.set,
    clearTimer: timers.clear,
  });
  const opened = registry.open(CWD);
  if (!opened.ok) throw new Error(opened.sentence.text);
  return { registry, id: opened.id, spawned: backend.streams, backend, timers, logs };
}

describe('planowy kill vs powrót klienta', () => {
  it('powrót W OKNIE planowego killa nie gubi nowego PTY ani jego prawdziwego padu', async () => {
    const h = makeHarness();
    const pierwszy = new FakeClient();
    expect(h.registry.attach(h.id, pierwszy)).toBe('ok');
    await waitUntil('spawn P1', () => h.spawned.length === 1);

    // Karencja mija: rejestr zeruje `pty` i PLANUJE kill — ale samo `kill()` przyjdzie
    // dopiero po rozwiązaniu obietnicy spawnu, czyli po dwóch `set-option`.
    h.registry.detach(h.id, pierwszy);
    h.timers.fire();

    // Użytkownik wraca DOKŁADNIE teraz — powstaje drugie PTY.
    const drugi = new FakeClient();
    expect(h.registry.attach(h.id, drugi)).toBe('ok');
    await waitUntil('spawn P2', () => h.spawned.length === 2);

    // Spóźnione `onExit` PIERWSZEGO PTY nie ma prawa dotknąć wpisu.
    h.spawned[0]?.emitExit();
    h.registry.write(h.id, 'ls\n');
    await waitUntil('wejście trafia do P2', () => (h.spawned[1]?.written.length ?? 0) === 1);
    expect(h.spawned[1]?.written).toEqual(['ls\n']);
    expect(h.spawned[0]?.written).toEqual([]);
    // Planowy kill nie jest śmiercią powłoki — klient nie widzi `exit`…
    expect(drugi.events).toEqual([]);

    // …ale PRAWDZIWY pad żywego PTY nadal go wysyła (flaga nie została skonsumowana).
    h.spawned[1]?.emitExit();
    expect(drugi.events).toEqual([{ t: 'exit' }]);
    h.registry.dispose();
  });

  it('pad PTY wysyła `exit`, a planowe zamknięcie jest ciche i nie liczy się do bezpiecznika',
    async () => {
      const h = makeHarness();
      const klient = new FakeClient();
      h.registry.attach(h.id, klient);
      await waitUntil('spawn', () => h.spawned.length === 1);
      h.spawned[0]?.emitExit();
      expect(klient.events).toEqual([{ t: 'exit' }]);
      expect(h.logs.some((line) => line.includes('failed after'))).toBe(true);

      // Planowe zamknięcie tego samego terminala: żadnego `exit`, żadnego pada w logu.
      const drugi = new FakeClient();
      h.registry.attach(h.id, drugi);
      await waitUntil('spawn P2', () => h.spawned.length === 2);
      h.registry.detach(h.id, klient);
      h.registry.detach(h.id, drugi);
      h.timers.fire();
      h.spawned[1]?.emitExit();
      expect(drugi.events).toEqual([]);
      expect(h.logs.filter((line) => line.includes('failed after'))).toHaveLength(1);
      expect(h.logs.some((line) => line.includes('closed intentionally'))).toBe(true);
      h.registry.dispose();
    });

  it('nowe gniazdo w oknie karencji KASUJE timer — PTY zostaje przy życiu', async () => {
    const h = makeHarness();
    const pierwszy = new FakeClient();
    h.registry.attach(h.id, pierwszy);
    await waitUntil('spawn', () => h.spawned.length === 1);

    h.registry.detach(h.id, pierwszy);
    expect(h.timers.armed).toBe(1);
    expect(h.timers.pending).toBe(true);

    h.registry.attach(h.id, new FakeClient());
    expect(h.timers.cleared).toBe(1);
    expect(h.timers.pending).toBe(false);
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]?.killed).toBe(0);
    h.registry.dispose();
  });

  /*
   * A fresh xterm entering the terminal within the grace window needs the terminal modes (mouse,
   * DECCKM, 1049), and a repaint alone does not restore them. Hence `fresh`:
   * świeży xterm dostaje PEŁNY respawn strumienia także wtedy, gdy backend by go nie żądał.
   */
  it('ŚWIEŻY xterm w oknie karencji dostaje respawn strumienia — planowo, bez ramki `exit`', async () => {
    const h = makeHarness();
    const pierwszy = new FakeClient();
    h.registry.attach(h.id, pierwszy);
    await waitUntil('spawn', () => h.spawned.length === 1);
    h.registry.detach(h.id, pierwszy);

    const drugi = new FakeClient();
    expect(h.registry.attach(h.id, drugi, true)).toBe('ok');
    expect(h.timers.pending).toBe(false);
    await waitUntil('respawn', () => h.spawned.length === 2 && h.spawned[0]?.killed === 1);
    // Stary strumień ginie planowo: bezpiecznik go nie liczy, a klient nie widzi `exit`.
    h.spawned[0]?.emitExit();
    expect(drugi.events).toEqual([]);
    expect(h.registry.list()[0]?.live).toBe(true);
    // Nowy PTY karmi nowe gniazdo.
    h.spawned[1]?.emitData('po respawnie');
    expect(drugi.data).toEqual(['po respawnie']);
    h.registry.dispose();
  });

  it('xterm Z HISTORIĄ (reconnect bez `fresh`) zostaje przy starym strumieniu', async () => {
    const h = makeHarness();
    const pierwszy = new FakeClient();
    h.registry.attach(h.id, pierwszy);
    await waitUntil('spawn', () => h.spawned.length === 1);
    h.registry.detach(h.id, pierwszy);

    expect(h.registry.attach(h.id, new FakeClient(), false)).toBe('ok');
    await new Promise<void>((resolve) => { setTimeout(resolve, 50); });
    expect(h.spawned).toHaveLength(1);
    expect(h.spawned[0]?.killed).toBe(0);
    h.registry.dispose();
  });
});

describe('backpressure — zerwane gniazdo idzie tą samą drogą co zamknięte', () => {
  it('zator OSTATNIEGO gniazda uzbraja karencję, a ta zabija PTY', async () => {
    const h = makeHarness();
    const klient = new FakeClient();
    h.registry.attach(h.id, klient);
    await waitUntil('spawn', () => h.spawned.length === 1);

    klient.buffered = TERM_SOCKET_BUFFER_LIMIT_BYTES + 1;
    h.spawned[0]?.emitData('dużo bajtów');

    expect(klient.terminated).toBe(1);
    expect(klient.data).toEqual([]);
    // Bez `detach` karencja nigdy by nie wystartowała: strumień wisiałby spauzowany, a żniwiarz
    // nie tknąłby powłoki, bo backend widziałby podłączonego klienta.
    expect(h.timers.armed).toBe(1);
    h.timers.fire();
    await waitUntil('kill PTY', () => h.spawned[0]?.killed === 1);
    h.registry.dispose();
  });

  it('wolne gniazdo jest zrywane, szybkie dostaje dane, pauza dopiero gdy wszystkie w zatorze',
    async () => {
      const h = makeHarness();
      const wolny = new FakeClient();
      const szybki = new FakeClient();
      h.registry.attach(h.id, wolny);
      h.registry.attach(h.id, szybki);
      await waitUntil('spawn', () => h.spawned.length === 1);

      wolny.buffered = TERM_SOCKET_BUFFER_LIMIT_BYTES + 1;
      h.spawned[0]?.emitData('abc');
      expect(wolny.terminated).toBe(1);
      expect(szybki.data).toEqual(['abc']);
      // Jedno gniazdo w zatorze nie zatrzymuje czytania z PTY — drugie nadal nadąża.
      expect(h.spawned[0]?.paused).toBe(0);
      // Zerwane gniazdo NIE było ostatnie, więc karencji nie ma.
      expect(h.timers.armed).toBe(0);

      szybki.buffered = TERM_SOCKET_BUFFER_LIMIT_BYTES + 1;
      h.registry.reviewBackpressure(h.id);
      await waitUntil('pauza PTY', () => h.spawned[0]?.paused === 1);

      szybki.buffered = 0;
      h.registry.reviewBackpressure(h.id);
      await waitUntil('wznowienie PTY', () => h.spawned[0]?.resumed === 1);
      h.registry.dispose();
    });
});

describe('DELETE /api/term/:id — zamknięcie przy żywych gniazdach', () => {
  it('terminuje gniazda, zabija PTY i kasuje wpis', async () => {
    const h = makeHarness();
    const a = new FakeClient();
    const b = new FakeClient();
    h.registry.attach(h.id, a);
    h.registry.attach(h.id, b);
    await waitUntil('spawn', () => h.spawned.length === 1);

    expect(h.registry.close(h.id)).toBe(true);
    expect(a.terminated).toBe(1);
    expect(b.terminated).toBe(1);
    expect(h.registry.has(h.id)).toBe(false);
    expect(h.registry.list()).toEqual([]);
    await waitUntil('kill PTY', () => h.spawned[0]?.killed === 1);
    // Zamknięcie jest planowe — nawet gdy `onExit` przyjdzie po skasowaniu wpisu.
    h.spawned[0]?.emitExit();
    expect(a.events).toEqual([]);
    expect(h.registry.close(h.id)).toBe(false);
  });
});

/*
 * Rozmiar panelu wraca do układu taba WYŁĄCZNIE przy zwolnieniu po karencji — wtedy
 * następca nie wstaje od razu. Respawn pod świeże gniazdo, zamknięcie terminala i zamknięcie serwera
 * zwalniają bez tej prośby (powód przy `TermReleaseOptions.restoreSize`).
 */
describe('przywrócenie rozmiaru zamawia tylko karencja', () => {
  it('karencja → `restoreSize`; respawn, DELETE i zamknięcie serwera → bez', async () => {
    const h = makeHarness();
    const klient = new FakeClient();
    h.registry.attach(h.id, klient);
    await waitUntil('spawn P1', () => h.spawned.length === 1);
    // Świeży xterm po drugiej stronie = respawn strumienia (ta sama gałąź co herdr przy każdym gnieździe).
    h.registry.attach(h.id, new FakeClient(), true);
    await waitUntil('spawn P2', () => h.spawned.length === 2);
    await waitUntil('release P1', () => h.spawned[0]?.killed === 1);
    expect(h.spawned[0]?.releases).toEqual([{}]);

    h.registry.close(h.id);
    await waitUntil('release P2', () => h.spawned[1]?.killed === 1);
    expect(h.spawned[1]?.releases).toEqual([{}]);

    const opened = h.registry.open(CWD);
    if (!opened.ok) throw new Error(opened.sentence.text);
    const wraca = new FakeClient();
    h.registry.attach(opened.id, wraca);
    await waitUntil('spawn P3', () => h.spawned.length === 3);
    h.registry.detach(opened.id, wraca);
    h.timers.fire();
    await waitUntil('release P3', () => h.spawned[2]?.killed === 1);
    expect(h.spawned[2]?.releases).toEqual([{ restoreSize: true }]);

    h.registry.attach(opened.id, new FakeClient());
    await waitUntil('spawn P4', () => h.spawned.length === 4);
    h.registry.dispose();
    await waitUntil('release P4', () => h.spawned[3]?.killed === 1);
    expect(h.spawned[3]?.releases).toEqual([{}]);
  });
});

describe('sufit żywych PTY', () => {
  it('attach ponad sufit oddaje `limit`, nie `failed` — klient dostaje inną instrukcję',
    async () => {
      const h = makeHarness(1);
      // Drugi wpis powstaje, ZANIM pierwszy ma żywe PTY — sufit w `open` liczy żywe PTY,
      // więc dopiero `attach` jest tu bramką (i to on musi powiedzieć, DLACZEGO odmawia).
      const drugi = h.registry.open('/Users/testowy/Projects/inny');
      expect(drugi.ok).toBe(true);
      h.registry.attach(h.id, new FakeClient());
      await waitUntil('spawn', () => h.spawned.length === 1);

      const klient = new FakeClient();
      expect(drugi.ok && h.registry.attach(drugi.id, klient)).toBe('limit');
      expect(h.spawned).toHaveLength(1);
      h.registry.dispose();
    });

  it('po `dispose()` rejestr nie przyjmuje już nowych wpisów (spóźniona adopcja)', () => {
    const h = makeHarness();
    h.registry.dispose();
    expect(h.registry.open(CWD).ok).toBe(false);
    expect(h.registry.list()).toEqual([]);
  });
});

describe('history() — rejestr PRZEPUSZCZA historię, niczego z niej nie trzymając', () => {
  it('oddaje tekst backendu razem z `truncated` i podaje mu ŚCIĘTE już `lines`', async () => {
    const h = makeHarness();
    h.backend.historyResult = () => Promise.resolve({ text: 'a\nb\n', truncated: true });

    expect(await h.registry.history(h.id, 2_500))
      .toEqual({ ok: true, text: 'a\nb\n', truncated: true });
    expect(h.backend.historyCalls).toEqual([{ ref: `panel-${h.id}`, lines: 2_500 }]);
  });

  it('id spoza rejestru to `not-found` — backend nie dostaje pytania', async () => {
    const h = makeHarness();
    expect(await h.registry.history('ffffffffffffffff', 100))
      .toMatchObject({ ok: false, error: 'not-found' });
    expect(h.backend.historyCalls).toEqual([]);
  });

  /*
   * `TermHandleStaleError` znaczy „adres z uchwytu nie jest już naszą powłoką" — z zewnątrz
   * to ma być 404, a nie awaria: Rarog nie zdradza, że pod tym adresem stoi CUDZY panel.
   * Uchwyt zostaje przy tym ZATRUTY, żeby najbliższy `POST /api/term` policzył go od nowa.
   */
  it('nieaktualny uchwyt to `not-found` i uchwyt do przeliczenia', async () => {
    const h = makeHarness();
    h.backend.historyResult = () => Promise.reject(new TermHandleStaleError('nie nasz panel'));

    expect(await h.registry.history(h.id, 100))
      .toMatchObject({ ok: false, error: 'not-found' });
    // Dowód zatrucia: `open()` liczy uchwyt OD NOWA i mówi o tym w logu.
    expect(h.registry.open(CWD).ok).toBe(true);
    expect(h.logs.some((line) => line.includes('handle recomputed'))).toBe(true);
  });

  it('padnięte gniazdo herdr to `unavailable`, a treść nie idzie do logu', async () => {
    const h = makeHarness();
    h.backend.historyResult = () => Promise.reject(new Error('SEKRET-Z-EKRANU-42'));

    expect(await h.registry.history(h.id, 100))
      .toMatchObject({ ok: false, error: 'unavailable' });
    // Do logu idzie POWÓD (`redact`), więc treść błędu tam być może — ale nigdy HISTORIA:
    // rejestr nie widzi jej wcale, gdy odczyt padł.
    expect(h.logs.some((line) => line.includes('history'))).toBe(true);
  });

  /*
   * Historia jest ODCZYTEM, nie cyklem życia strumienia: wolno jej zażądać także dla
   * terminala BEZ podłączonego gniazda (powłoka adoptowana po restarcie Raroga) — to często
   * dokładnie ten przypadek, w którym człowiek chce wyjąć, co tam wyszło.
   */
  it('działa bez ani jednego podłączonego gniazda i NIE spawnuje strumienia', async () => {
    const h = makeHarness();
    expect(await h.registry.history(h.id, 100)).toMatchObject({ ok: true });
    expect(h.spawned).toHaveLength(0);
  });
});

describe('sloty: cztery taby na projekt', () => {
  /*
   * Slot 1 MUSI dawać goły hash, bez sufiksu. Nie jest to estetyka: ta wartość siedzi
   * w tokenach `rarog-term` żywych paneli herdr i w kluczach `term-herdr.json` — sufiks dla
   * slotu 1 unieważniłby je naraz.
   */
  it('slot 1 to niezmieniony `sha256(realpath(cwd))`, slot ≥ 2 ma sufiks `#N`', () => {
    expect(termIdFor(CWD, 1)).toBe(termIdFor(CWD));
    expect(termIdFor(CWD, 2)).not.toBe(termIdFor(CWD));
    expect(termIdFor(CWD, 2)).not.toBe(termIdFor(CWD, 3));
    // Sufiks jest częścią WEJŚCIA hasha, a nie doklejką do wyniku — inaczej id nie
    // przechodziłoby `TERM_ID_RE` (16 hex) i wypadałoby z tras oraz z tokenu panelu.
    expect(termIdFor(CWD, 4)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('brak slotu w wywołaniu = slot 1 (zgodność wstecz)', () => {
    const h = makeHarness();
    // `makeHarness` otworzył już terminal bez slotu — musi to być ten sam wpis co `slot: 1`.
    const jawny = h.registry.open(CWD, 1);
    expect(jawny).toEqual({ ok: true, id: h.id, slot: 1, role: 'shell' });
    expect(h.registry.list()).toHaveLength(1);
  });

  it('kolejne sloty to OSOBNE wpisy z własnymi id', () => {
    const h = makeHarness();
    const drugi = h.registry.open(CWD, 2);
    expect(drugi).toEqual({ ok: true, id: termIdFor(CWD, 2), slot: 2, role: 'shell' });
    expect(h.registry.list().map((e) => e.slot).sort()).toEqual([1, 2]);
    // Oba wpisy niosą TEN SAM katalog — to jest cały sens tabów w projekcie.
    expect(new Set(h.registry.list().map((e) => e.cwd))).toEqual(new Set([CWD]));
  });

  it('`next` wybiera NAJNIŻSZY wolny numer, także po zamknięciu dziury', () => {
    const h = makeHarness();
    expect(h.registry.open(CWD, 'next')).toMatchObject({ slot: 2 });
    expect(h.registry.open(CWD, 'next')).toMatchObject({ slot: 3 });
    // Dziura po zamkniętym tabie 2 ma się ZAPEŁNIĆ, a nie zostać pominięta: przy stałym
    // suficie czterech numery uciekałyby w górę i „+" gasłoby przy dwóch otwartych tabach.
    expect(h.registry.close(termIdFor(CWD, 2))).toBe(true);
    expect(h.registry.open(CWD, 'next')).toMatchObject({ slot: 2 });
  });

  it('powrót do istniejącego slotu jest IDEMPOTENTNY i nie tworzy wpisu', () => {
    const h = makeHarness();
    const pierwszy = h.registry.open(CWD, 3);
    const powrot = h.registry.open(CWD, 3);
    expect(powrot).toEqual(pierwszy);
    expect(h.registry.list()).toHaveLength(2); // slot 1 z harnessu + slot 3
  });

  it('sufit slotów liczy WPISY per katalog, nie żywe strumienie', () => {
    // `termMax` (żywe PTY) jest tu wysoki, żeby o odmowie decydował WYŁĄCZNIE sufit slotów.
    const h = makeHarness(99);
    for (let slot = 2; slot <= TERM_SLOTS_MAX; slot += 1) {
      expect(h.registry.open(CWD, slot).ok).toBe(true);
    }
    expect(h.registry.list()).toHaveLength(TERM_SLOTS_MAX);
    // Ani jeden z tych wpisów nie ma strumienia — a mimo to projekt jest „pełny".
    expect(h.spawned).toHaveLength(0);
    const ponad = h.registry.open(CWD, 'next');
    expect(ponad).toMatchObject({ ok: false, error: 'limit' });
    if (!ponad.ok) expect(ponad.sentence.text).toContain(String(TERM_SLOTS_MAX));
  });

  it('sufit slotów jest PER PROJEKT — inny katalog dalej dostaje swoje cztery', () => {
    const h = makeHarness(99);
    for (let slot = 2; slot <= TERM_SLOTS_MAX; slot += 1) h.registry.open(CWD, slot);
    expect(h.registry.open(CWD, 'next').ok).toBe(false);

    const inny = '/Users/testowy/Projects/inny';
    expect(h.registry.open(inny, 'next')).toMatchObject({ ok: true, slot: 1 });
    expect(h.registry.open(inny, 'next')).toMatchObject({ ok: true, slot: 2 });
  });

  /*
   * POWRÓT do otwartego terminala NIGDY nie dostaje 409 — nawet przy komplecie tabów
   * i przy wyczerpanym globalnym suficie żywych PTY. To jest wejście do czegoś, co już
   * istnieje, a nie prośba o coś nowego (kolejność pytań w `open()`).
   */
  it('powrót przechodzi mimo kompletu slotów i mimo globalnego sufitu', () => {
    const h = makeHarness(1);
    const drugi = h.registry.open(CWD, 2);
    expect(drugi.ok).toBe(true);
    for (let slot = 3; slot <= TERM_SLOTS_MAX; slot += 1) h.registry.open(CWD, slot);
    // Globalny sufit wyczerpany JEDNYM żywym strumieniem (`termMax = 1`).
    expect(h.registry.attach(h.id, new FakeClient())).toBe('ok');

    expect(h.registry.open(CWD, 1)).toMatchObject({ ok: true, slot: 1 });
    expect(h.registry.open(CWD, 2)).toMatchObject({ ok: true, slot: 2 });
    // Ale NOWY slot w tym stanie już nie wchodzi — sufit slotów odpowiada przed globalnym.
    expect(h.registry.open('/Users/testowy/Projects/inny', 1))
      .toMatchObject({ ok: false, error: 'limit' });
  });

  it('globalny sufit żywych PTY odmawia NOWEMU slotowi, choć projekt ma miejsce', async () => {
    const h = makeHarness(1);
    expect(h.registry.attach(h.id, new FakeClient())).toBe('ok');
    await waitUntil('spawn P1', () => h.spawned.length === 1);

    const odmowa = h.registry.open(CWD, 2);
    expect(odmowa).toMatchObject({ ok: false, error: 'limit' });
    // Zdanie ma mówić o TYM suficie (1), a nie o slotach — dwie różne instrukcje dla człowieka.
    if (!odmowa.ok) expect(odmowa.sentence).toMatchObject({ ref: { code: 'term.open-limit', args: ['1'] } });
  });

  it('numer spoza zakresu odpada, zanim powstanie wpis', () => {
    const h = makeHarness(99);
    expect(h.registry.open(CWD, 0)).toMatchObject({ ok: false, error: 'limit' });
    expect(h.registry.open(CWD, TERM_SLOTS_MAX + 1)).toMatchObject({ ok: false, error: 'limit' });
    expect(h.registry.list()).toHaveLength(1);
  });
});

describe('`proc` na liście — nazwa procesu z cache\'u backendu', () => {
  it('`list()` pyta backend o KAŻDY wpis i oddaje to, co dostał', async () => {
    const h = makeHarness();
    h.registry.open(CWD, 2);
    h.backend.procName = 'nvim';
    await settle(); // uchwyty backendu muszą się rozwiązać — patrz `settle`

    const lista = h.registry.list();
    expect(lista.map((e) => e.proc)).toEqual(['nvim', 'nvim']);
    expect(h.backend.procAsked).toEqual([termIdFor(CWD), termIdFor(CWD, 2)]);
  });

  /*
   * Pusty `proc` znaczy „backend jeszcze nie wie" (pierwsza lista po starcie serwera), a nie
   * „brak procesu" — klient rysuje wtedy samą pigułkę `>_`. Wpis, którego uchwyt jeszcze nie
   * powstał, nie ma nawet o co zapytać.
   */
  it('wpis bez rozwiązanego uchwytu oddaje pusty `proc` i NIE pyta backendu', async () => {
    const logs: string[] = [];
    const logger: Logger = { info: (m) => logs.push(m), error: (m) => logs.push(m) };
    const backend = new FakeBackend();
    // Uchwyt, który nigdy się nie rozwiąże — dokładnie stan „gniazdo herdr nie odpowiada".
    backend.ensureSession = () => new Promise<TermSessionHandle>(() => { /* nigdy */ });
    const registry = new TermRegistry({
      config: loadConfig({
        RAROG_DEMO: '1', RAROG_TERM: '1', RAROG_PROJECT_ROOTS: '/Users/testowy/Projects',
      }),
      logger,
      backend,
      realPath: (p) => p,
    });
    expect(registry.open(CWD).ok).toBe(true);
    await settle(); // gdyby uchwyt miał się rozwiązać, zdążyłby — ta obietnica NIGDY nie kończy

    expect(registry.list()[0]?.proc).toBe('');
    expect(backend.procAsked).toEqual([]);
  });

  it('`list()` jest SYNCHRONICZNE — kontrakt `GET /api/term` nie czeka na herdr', async () => {
    const h = makeHarness();
    h.backend.procName = 'codex';
    await settle();
    // Gdyby `list()` było obietnicą, to wyrażenie nie byłoby tablicą — a router woła je
    // w tym samym bloku co `sendJson`.
    expect(Array.isArray(h.registry.list())).toBe(true);
    expect(h.registry.list()[0]).toMatchObject({ proc: 'codex', slot: 1 });
  });
});

/*
 * Rozmiar z upgrade'u: klient mierzy PRZED otwarciem gniazda i podaje `c`/`r`
 * w URL — kontroler ma wstać OD RAZU we właściwych wymiarach, zamiast w zapamiętanych
 * (świeży wpis: 80×24) i dostawać drugą szerokość ramką `rs` po ficie. Każda taka para
 * szerokości to SIGWINCH i „schodek" promptu.
 */
describe('attach z rozmiarem klienta', () => {
  it('spawn kontrolera bierze rozmiar z attach, nie zapamiętany', async () => {
    const h = makeHarness();
    expect(h.registry.attach(h.id, new FakeClient(), true, { cols: 143, rows: 31 })).toBe('ok');
    await waitUntil('spawn', () => h.backend.streams.length > 0);
    expect(h.backend.streams.at(-1)?.opts).toMatchObject({ cols: 143, rows: 31 });
  });

  it('bez rozmiaru w upgrade zostaje zapamiętany (zgodność wstecz)', async () => {
    const h = makeHarness();
    expect(h.registry.attach(h.id, new FakeClient(), true)).toBe('ok');
    await waitUntil('spawn', () => h.backend.streams.length > 0);
    expect(h.backend.streams.at(-1)?.opts).toMatchObject({ cols: 80, rows: 24 });
  });
});

/*
 * ROLA `lazygit`: OSOBNY panel herdr, w którym zamiast powłoki chodzi lazygit,
 * otwierany przez front w popupie. Trzy rzeczy różnią go od taba projektu i każda ma tu swój
 * test: nie zajmuje slotu, dostaje wpisane `exec lazygit` (raz na życie wpisu, tylko do świeżego
 * panelu) i po `q` ZNIKA z rejestru, zamiast lądować w `failed`.
 */
describe('rola lazygit — panel poza slotami', () => {
  it('otwiera się bez slotu, dostaje `slot: 0` i własne id', () => {
    const h = makeHarness();
    const otwarty = h.registry.open(CWD, 1, 'lazygit');
    expect(otwarty).toEqual({ ok: true, id: termIdFor(CWD, 0, 'lazygit'), slot: 0, role: 'lazygit' });
    // Rola jedzie do backendu, bo to ona rozstrzyga ETYKIETĘ zakładanego taba w herdr.
    expect(h.backend.ensured.at(-1)).toEqual({ id: termIdFor(CWD, 0, 'lazygit'), role: 'lazygit' });
    h.registry.dispose();
  });

  it('jest idempotentny: drugi `open` oddaje ten sam wpis, a panelu nie zakłada od nowa', () => {
    const h = makeHarness();
    const pierwszy = h.registry.open(CWD, 1, 'lazygit');
    const powrot = h.registry.open(CWD, 'next', 'lazygit');
    expect(powrot).toEqual(pierwszy);
    expect(h.registry.list().filter((e) => e.role === 'lazygit')).toHaveLength(1);
    h.registry.dispose();
  });

  /*
   * Pigułki paska mają zostać nietknięte: lazygit nie zabiera projektowi ani jednego z czterech
   * tabów, a jego wpis nie przesuwa numeracji `'next'`.
   */
  it('NIE zajmuje slotu projektu — komplet tabów wchodzi obok niego', () => {
    const h = makeHarness(99);
    h.registry.open(CWD, 1, 'lazygit');
    for (let slot = 2; slot <= TERM_SLOTS_MAX; slot += 1) {
      expect(h.registry.open(CWD, slot).ok).toBe(true);
    }
    expect(h.registry.list().filter((e) => e.role === 'shell')).toHaveLength(TERM_SLOTS_MAX);
    expect(h.registry.list().find((e) => e.role === 'lazygit')).toMatchObject({ slot: 0 });
    // Sufit slotów liczy WYŁĄCZNIE powłoki — dopiero one wyczerpują projekt.
    expect(h.registry.open(CWD, 'next')).toMatchObject({ ok: false, error: 'limit' });
    h.registry.dispose();
  });

  /*
   * ...ale do sufitu ŻYWYCH strumieni liczy się normalnie: to jest ten sam proces kontrolera
   * herdr co przy powłoce, więc `RAROG_TERM_MAX` musi go widzieć (stąd sufit wyższy niż liczba tabów).
   */
  it('liczy się do sufitu `RAROG_TERM_MAX`', async () => {
    const h = makeHarness(1);
    expect(h.registry.attach(h.id, new FakeClient())).toBe('ok');
    await waitUntil('spawn powłoki', () => h.spawned.length === 1);
    expect(h.registry.open(CWD, 1, 'lazygit')).toMatchObject({ ok: false, error: 'limit' });
    h.registry.dispose();
  });

  it('`list()` niesie rolę każdego wpisu', async () => {
    const h = makeHarness();
    h.registry.open(CWD, 1, 'lazygit');
    await settle();
    expect(h.registry.list().map((e) => [e.role, e.slot]))
      .toEqual([['shell', 1], ['lazygit', 0]]);
    h.registry.dispose();
  });
});

describe('start lazygita wpisywany do PTY', () => {
  /** Otwiera panel lazygit i podpina do niego gniazdo — wspólny wstęp wszystkich testów niżej. */
  async function withLazygit(
    prepare: (h: Harness) => void = () => { /* domyślnie świeży panel */ },
  ): Promise<{ h: Harness; id: string; client: FakeClient; stream: FakeStream }> {
    const h = makeHarness();
    prepare(h);
    const otwarty = h.registry.open(CWD, 1, 'lazygit');
    if (!otwarty.ok) throw new Error(otwarty.sentence.text);
    const client = new FakeClient();
    expect(h.registry.attach(otwarty.id, client)).toBe('ok');
    await waitUntil('spawn kontrolera lazygita', () => h.spawned.length === 1);
    const stream = h.spawned[0];
    if (stream === undefined) throw new Error('brak strumienia');
    return { h, id: otwarty.id, client, stream };
  }

  /*
   * `tab.create` w herdr 0.8.2 nie przyjmuje komendy (schemat zna `cwd`, `env`, `label`,
   * `focus`, `workspace_id`), więc jedyną drogą uruchomienia lazygita jest WEJŚCIE do PTY.
   * Moment: pierwsza porcja wyjścia = „prompt stoi, powłoka czyta".
   */
  it('wpisuje ` exec lazygit\\r` po PIERWSZYM wyjściu i dokładnie raz', async () => {
    const { h, stream } = await withLazygit();
    expect(stream.written).toEqual([]);

    stream.emitData('testowy@Mac ~/rarog %');
    await waitUntil('wpis startu', () => stream.written.length === 1);
    expect(stream.written).toEqual([TERM_LAZYGIT_START_INPUT]);

    // Kolejne bajty niczego nie dopisują — inaczej każda linia wyjścia byłaby nową komendą.
    stream.emitData('cokolwiek');
    stream.emitData('jeszcze coś');
    await settle();
    expect(stream.written).toEqual([TERM_LAZYGIT_START_INPUT]);
    // Fakt wpisu wolno zalogować, treści — nigdy (reguła zero logów terminala).
    expect(h.logs.some((line) => line.includes('lazygit start typed'))).toBe(true);
    expect(h.logs.some((line) => line.includes('exec lazygit'))).toBe(false);
    h.registry.dispose();
  });

  it('milczący panel dostaje wpis z zapasowego timera, i to też tylko raz', async () => {
    const { h, stream } = await withLazygit();
    h.timers.fireMs(TERM_LAZYGIT_START_FALLBACK_MS);
    await waitUntil('wpis startu z timera', () => stream.written.length === 1);
    expect(stream.written).toEqual([TERM_LAZYGIT_START_INPUT]);

    // Wyjście, które przyszło PO timerze, nie ma już czego uzbrajać.
    stream.emitData('cokolwiek');
    await settle();
    expect(stream.written).toEqual([TERM_LAZYGIT_START_INPUT]);
    h.registry.dispose();
  });

  /*
   * RESPAWN (drugie urządzenie, powrót po karencji) zakłada nowy strumień do TEGO SAMEGO
   * panelu, w którym lazygit już chodzi. Wpisanie komendy poszłoby wtedy prosto w jego
   * klawiaturę — `e`, `x`, `e`, `c` to w lazygicie żywe skróty.
   */
  it('respawn strumienia NIE wpisuje startu po raz drugi', async () => {
    const { h, id, stream } = await withLazygit();
    stream.emitData('prompt');
    await waitUntil('wpis startu', () => stream.written.length === 1);

    const drugi = new FakeClient();
    expect(h.registry.attach(id, drugi, true)).toBe('ok');
    await waitUntil('respawn', () => h.spawned.length === 2);
    const nowy = h.spawned[1];
    nowy?.emitData('pełna ramka lazygita');
    await settle();
    expect(nowy?.written).toEqual([]);
    h.registry.dispose();
  });

  /*
   * ADOPCJA po restarcie Raroga: panel ISTNIEJE i chodzi w nim lazygit, więc uchwyt wraca
   * z `fresh: false` i wpisu nie ma. Bez tej bramki restart serwera wysyłałby `exec lazygit`
   * w klawiaturę żywego lazygita każdego adoptowanego panelu.
   */
  it('panel ODNALEZIONY (adopcja) nie dostaje wpisu w ogóle', async () => {
    const { h, stream } = await withLazygit((harness) => {
      harness.backend.known.add(termIdFor(CWD, 0, 'lazygit'));
    });
    stream.emitData('lazygit rysuje ekran');
    // Zapasowy timer NIE jest tu nawet uzbrojony — jedyny pending to karencja.
    expect(() => { h.timers.fireMs(TERM_LAZYGIT_START_FALLBACK_MS); }).toThrow();
    await settle();
    expect(stream.written).toEqual([]);
    h.registry.dispose();
  });

  it('rola `shell` nie dostaje wpisu nigdy — to pełna powłoka człowieka', async () => {
    const h = makeHarness();
    const client = new FakeClient();
    h.registry.attach(h.id, client);
    await waitUntil('spawn powłoki', () => h.spawned.length === 1);
    h.spawned[0]?.emitData('prompt');
    await settle();
    expect(h.spawned[0]?.written).toEqual([]);
    h.registry.dispose();
  });
});

/*
 * KONIEC lazygita (`q`): `exec` zastąpił powłokę, więc po wyjściu z lazygita ginie cały panel
 * herdr, a kontroler kończy się NIEPLANOWO. Dla wpisu roli `lazygit` to nie jest awaria do
 * wskrzeszania, tylko normalny koniec życia popupu.
 */
describe('koniec panelu lazygit', () => {
  it('pad strumienia daje klientowi `exit` i KASUJE wpis, bez stanu `failed`', async () => {
    const h = makeHarness();
    const otwarty = h.registry.open(CWD, 1, 'lazygit');
    if (!otwarty.ok) throw new Error(otwarty.sentence.text);
    const client = new FakeClient();
    h.registry.attach(otwarty.id, client);
    await waitUntil('spawn', () => h.spawned.length === 1);

    h.spawned[0]?.emitExit();

    expect(client.events).toEqual([{ t: 'exit' }]);
    expect(h.registry.has(otwarty.id)).toBe(false);
    expect(h.registry.list().some((e) => e.role === 'lazygit')).toBe(false);
    // Żadnego „Spróbuj od nowa" w martwym stanie: wpisu po prostu nie ma.
    expect(h.logs.some((line) => line.includes('in failed state'))).toBe(false);
    expect(h.logs.some((line) => line.includes('entry deleted'))).toBe(true);
    h.registry.dispose();
  });

  it('po skasowaniu wpisu następny `open` zakłada panel OD NOWA (i znów wpisze start)',
    async () => {
      const h = makeHarness();
      const pierwszy = h.registry.open(CWD, 1, 'lazygit');
      if (!pierwszy.ok) throw new Error(pierwszy.sentence.text);
      h.registry.attach(pierwszy.id, new FakeClient());
      await waitUntil('spawn', () => h.spawned.length === 1);
      h.spawned[0]?.emitData('prompt');
      await waitUntil('wpis startu', () => (h.spawned[0]?.written.length ?? 0) === 1);
      h.spawned[0]?.emitExit();

      // W produkcji panel zginął razem z powłoką, więc `ensureSession` widzi ŚWIEŻY panel;
      // atrapa naśladuje to, zapominając tożsamość zamkniętego terminala.
      h.backend.known.delete(pierwszy.id);
      const drugi = h.registry.open(CWD, 1, 'lazygit');
      expect(drugi).toEqual(pierwszy);
      const klient = new FakeClient();
      h.registry.attach(pierwszy.id, klient);
      await waitUntil('drugi spawn', () => h.spawned.length === 2);
      h.spawned[1]?.emitData('prompt');
      await waitUntil('drugi wpis startu', () => (h.spawned[1]?.written.length ?? 0) === 1);
      expect(h.spawned[1]?.written).toEqual([TERM_LAZYGIT_START_INPUT]);
      h.registry.dispose();
    });

  it('`DELETE` panelu lazygit zabija powłokę tak samo jak przy tabie projektu', async () => {
    const h = makeHarness();
    const otwarty = h.registry.open(CWD, 1, 'lazygit');
    if (!otwarty.ok) throw new Error(otwarty.sentence.text);
    const client = new FakeClient();
    h.registry.attach(otwarty.id, client);
    await waitUntil('spawn', () => h.spawned.length === 1);

    expect(h.registry.close(otwarty.id)).toBe(true);
    expect(client.terminated).toBe(1);
    expect(h.registry.has(otwarty.id)).toBe(false);
    await waitUntil('kill sesji', () => h.backend.killed.includes(`panel-${otwarty.id}`));
    // Zamknięcie jest PLANOWE — spóźniony `onExit` nie ma prawa wysłać ramki `exit`.
    h.spawned[0]?.emitExit();
    expect(client.events).toEqual([]);
  });
});

/*
 * The panel was created (`fresh: true`), but the first stream attach failed before the registry typed
 * `exec lazygit`. Deleting only the entry would leave a panel with a bare shell in herdr, which the next
 * `open` would adopt with `fresh: false` — and the popup would show the shell instead of lazygit.
 */
describe('panel lazygit bez wystartowanego lazygita ginie razem z wpisem', () => {
  it('nieudany pierwszy `attach` zabija świeży panel, więc następny `open` zakłada go od nowa',
    async () => {
      const h = makeHarness();
      const attachOk = h.backend.attach.bind(h.backend);
      h.backend.attach = () => Promise.reject(new Error('gniazdo herdr padło'));
      const pierwszy = h.registry.open(CWD, 1, 'lazygit');
      if (!pierwszy.ok) throw new Error(pierwszy.sentence.text);
      const klient = new FakeClient();
      h.registry.attach(pierwszy.id, klient);
      await waitUntil('wpis skasowany', () => !h.registry.has(pierwszy.id));
      await waitUntil('kill panelu', () => h.backend.killed.length === 1);
      expect(h.backend.killed).toEqual([`panel-${pierwszy.id}`]);
      expect(klient.events).toEqual([{ t: 'exit' }]);

      // Backend odzwierciedla zabity panel: `ensureSession` zakłada świeży i start jedzie znowu.
      h.backend.known.delete(pierwszy.id);
      h.backend.attach = attachOk;
      const drugi = h.registry.open(CWD, 1, 'lazygit');
      expect(drugi).toEqual(pierwszy);
      h.registry.attach(pierwszy.id, new FakeClient());
      await waitUntil('spawn', () => h.spawned.length === 1);
      h.spawned[0]?.emitData('prompt');
      await waitUntil('wpis startu', () => (h.spawned[0]?.written.length ?? 0) === 1);
      expect(h.spawned[0]?.written).toEqual([TERM_LAZYGIT_START_INPUT]);
      h.registry.dispose();
    });

  it('po `q` (start wpisany) ani panel adoptowany NIE dostają `killSession`', async () => {
    const h = makeHarness();
    const otwarty = h.registry.open(CWD, 1, 'lazygit');
    if (!otwarty.ok) throw new Error(otwarty.sentence.text);
    h.registry.attach(otwarty.id, new FakeClient());
    await waitUntil('spawn', () => h.spawned.length === 1);
    h.spawned[0]?.emitData('prompt');
    await waitUntil('wpis startu', () => (h.spawned[0]?.written.length ?? 0) === 1);
    h.spawned[0]?.emitExit();
    await waitUntil('wpis skasowany', () => !h.registry.has(otwarty.id));
    expect(h.backend.killed).toEqual([]);

    // Adopcja: panel istniał przed nami, pad strumienia przed wpisem startu go nie zabija.
    const adoptowany = h.registry.open(CWD, 1, 'lazygit');
    if (!adoptowany.ok) throw new Error(adoptowany.sentence.text);
    h.registry.attach(adoptowany.id, new FakeClient());
    await waitUntil('drugi spawn', () => h.spawned.length === 2);
    h.spawned[1]?.emitExit();
    await waitUntil('wpis skasowany', () => !h.registry.has(adoptowany.id));
    await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
    expect(h.backend.killed).toEqual([]);
    h.registry.dispose();
  });
});

/*
 * ROLA `popup`: TA SAMA konstrukcja co `lazygit` — panel poza slotami,
 * otwierany przez front w popupie (Cmd+F) — z jedną różnicą, o którą prosił użytkownik: Rarog NIE
 * WPISUJE do niej żadnej komendy. Testy niżej pilnują obu stron tej równości: co ma być wspólne
 * (slot 0, własne id, kasowanie wpisu zamiast `failed`) i co ma być inne (zero bajtów wejścia).
 */
describe('rola popup — goła powłoka poza slotami', () => {
  it('otwiera się bez slotu, dostaje `slot: 0` i WŁASNE id, inne niż lazygit', () => {
    const h = makeHarness();
    const otwarty = h.registry.open(CWD, 1, 'popup');
    expect(otwarty).toEqual({ ok: true, id: termIdFor(CWD, 0, 'popup'), slot: 0, role: 'popup' });
    expect(otwarty).not.toMatchObject({ id: termIdFor(CWD, 0, 'lazygit') });
    // Rola jedzie do backendu, bo to ona rozstrzyga ETYKIETĘ zakładanego taba w herdr.
    expect(h.backend.ensured.at(-1)).toEqual({ id: termIdFor(CWD, 0, 'popup'), role: 'popup' });
    h.registry.dispose();
  });

  /*
   * Lazygit i terminal tego samego projektu mają stać OBOK SIEBIE: to dwa różne panele i dwa
   * różne wpisy, więc Cmd+F nad otwartym Cmd+G nie ma prawa przejąć cudzego panelu.
   */
  it('stoi obok panelu lazygita tego samego katalogu, nie zamiast niego', () => {
    const h = makeHarness();
    const lazy = h.registry.open(CWD, 1, 'lazygit');
    const popup = h.registry.open(CWD, 1, 'popup');
    expect(lazy.ok && popup.ok && lazy.id !== popup.id).toBe(true);
    expect(h.registry.list().map((e) => [e.role, e.slot]))
      .toEqual([['shell', 1], ['lazygit', 0], ['popup', 0]]);
    h.registry.dispose();
  });

  it('NIE zajmuje slotu projektu — komplet tabów wchodzi obok niego', () => {
    const h = makeHarness(99);
    h.registry.open(CWD, 1, 'popup');
    for (let slot = 2; slot <= TERM_SLOTS_MAX; slot += 1) {
      expect(h.registry.open(CWD, slot).ok).toBe(true);
    }
    expect(h.registry.list().filter((e) => e.role === 'shell')).toHaveLength(TERM_SLOTS_MAX);
    expect(h.registry.open(CWD, 'next')).toMatchObject({ ok: false, error: 'limit' });
    h.registry.dispose();
  });

  /*
   * SEDNO tej roli: ani jednego bajtu do PTY. Sprawdzamy OBIE drogi, którymi lazygit dostaje
   * swój start — pierwszą porcję wyjścia i zapasowy timer — bo wystarczy, żeby jedna z nich nie
   * pytała o rolę, i człowiek dostaje w swojej powłoce cudzą komendę.
   */
  it('nie wpisuje NICZEGO ani po pierwszym wyjściu, ani po zapasowym timerze', async () => {
    const h = makeHarness();
    const otwarty = h.registry.open(CWD, 1, 'popup');
    if (!otwarty.ok) throw new Error(otwarty.sentence.text);
    h.registry.attach(otwarty.id, new FakeClient());
    await waitUntil('spawn kontrolera', () => h.spawned.length === 1);
    const stream = h.spawned[0];

    // Zapasowego timera startu nie ma czym odpalić — dla tej roli NIE JEST uzbrajany w ogóle;
    // to mocniejsza gwarancja niż „odpalony timer nic nie wpisał".
    expect(() => { h.timers.fireMs(TERM_LAZYGIT_START_FALLBACK_MS); })
      .toThrow(/nie było uzbrojonego timera/);
    stream?.emitData('testowy@Mac ~/rarog %');
    await settle();

    expect(stream?.written).toEqual([]);
    expect(h.logs.some((line) => line.includes('lazygit start typed'))).toBe(false);
    h.registry.dispose();
  });

  /*
   * Koniec powłoki (`exit`) kończy panel razem z nią, więc kontroler pada NIEPLANOWO — i to nie
   * jest awaria do wskrzeszania, tylko zamknięcie popupu. Wpis znika z rejestru zamiast czekać
   * w `failed`, inaczej następny Cmd+F odnajdywałby wpis-widmo bez panelu.
   */
  it('pad strumienia daje klientowi `exit` i KASUJE wpis, bez stanu `failed`', async () => {
    const h = makeHarness();
    const otwarty = h.registry.open(CWD, 1, 'popup');
    if (!otwarty.ok) throw new Error(otwarty.sentence.text);
    const client = new FakeClient();
    h.registry.attach(otwarty.id, client);
    await waitUntil('spawn', () => h.spawned.length === 1);

    h.spawned[0]?.emitExit();

    expect(client.events).toEqual([{ t: 'exit' }]);
    expect(h.registry.has(otwarty.id)).toBe(false);
    expect(h.logs.some((line) => line.includes('in failed state'))).toBe(false);
    expect(h.logs.some((line) => line.includes('entry deleted'))).toBe(true);
    h.registry.dispose();
  });

  /*
   * ŚWIEŻY panel, którego wpis skasowaliśmy, ginie razem z nim (ta sama reguła co przy lazygicie):
   * panel założony przed chwilą wyłącznie pod ten popup nie ma bez wpisu po co stać
   * na Macu. Panel ADOPTOWANY (`fresh: false`) jest cudzy do zabijania i zostaje.
   */
  it('osierocony ŚWIEŻY panel jest zabijany, adoptowany — nie', async () => {
    const h = makeHarness();
    h.backend.attach = () => Promise.reject(new Error('gniazdo herdr padło'));
    const pierwszy = h.registry.open(CWD, 1, 'popup');
    if (!pierwszy.ok) throw new Error(pierwszy.sentence.text);
    h.registry.attach(pierwszy.id, new FakeClient());
    await waitUntil('wpis skasowany', () => !h.registry.has(pierwszy.id));
    await waitUntil('kill panelu', () => h.backend.killed.length === 1);
    expect(h.backend.killed).toEqual([`panel-${pierwszy.id}`]);

    // Panel, który ISTNIAŁ przed nami (adopcja po restarcie Raroga), nie jest nasz do zabijania.
    const adoptowany = h.registry.open(CWD, 1, 'popup');
    if (!adoptowany.ok) throw new Error(adoptowany.sentence.text);
    h.registry.attach(adoptowany.id, new FakeClient());
    await waitUntil('wpis skasowany po adopcji', () => !h.registry.has(adoptowany.id));
    await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
    expect(h.backend.killed).toEqual([`panel-${pierwszy.id}`]);
    h.registry.dispose();
  });

  /*
   * Kryterium dla `popup` jest WĘŻSZE niż dla lazygita: „strumień nigdy nie wstał", a nie „nic
   * nie wpisano". W panelu od pierwszej chwili chodzi prawdziwa powłoka z pracą człowieka, więc
   * pad TRANSPORTU po udanym podpięciu (kontroler herdr padł, panel żyje) nie ma prawa jej zabić.
   */
  it('pad strumienia PO udanym podpięciu nie zabija świeżego panelu z żywą powłoką', async () => {
    const h = makeHarness();
    const otwarty = h.registry.open(CWD, 1, 'popup');
    if (!otwarty.ok) throw new Error(otwarty.sentence.text);
    const klient = new FakeClient();
    h.registry.attach(otwarty.id, klient);
    await waitUntil('spawn', () => h.spawned.length === 1);
    h.spawned[0]?.emitData('prompt');
    h.spawned[0]?.emitExit();
    await waitUntil('wpis skasowany', () => !h.registry.has(otwarty.id));
    await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
    expect(h.backend.killed).toEqual([]);
    expect(klient.events).toEqual([{ t: 'exit' }]);
    h.registry.dispose();
  });
});

/*
 * The `rarog-term` token expires in herdr after a day; stamped only on open and attach, a terminal not
 * visited for a day would become foreign and Rarog would stop seeing it while it lives in herdr. So the
 * registry refreshes the ownership mark periodically (timer in `index.ts`, called directly here).
 */
describe('refreshTokens — cykliczne odświeżanie znaku własności', () => {
  it('odświeża KAŻDY wpis z rozwiązanym uchwytem, także bez gniazda', async () => {
    const h = makeHarness();
    const drugi = h.registry.open(CWD, 'next');
    if (!drugi.ok) throw new Error(drugi.sentence.text);
    await settle();

    const wynik = await h.registry.refreshTokens();

    expect(wynik).toEqual({ refreshed: 2, lost: 0 });
    expect(h.backend.refreshed.sort()).toEqual([h.id, drugi.id].sort());
    h.registry.dispose();
  });

  it('pomija wpis, którego uchwyt jeszcze nie powstał albo jest do przeliczenia', async () => {
    const h = makeHarness();
    h.backend.ensureSession = () => new Promise<TermSessionHandle>(() => { /* nigdy */ });
    const wLocie = h.registry.open(`${CWD}-drugi`);
    if (!wLocie.ok) throw new Error(wLocie.sentence.text);
    await settle();

    const wynik = await h.registry.refreshTokens();

    expect(wynik).toEqual({ refreshed: 1, lost: 0 });
    expect(h.backend.refreshed).toEqual([h.id]);
    h.registry.dispose();
  });

  it('utracony token liczy jako `lost`, NIE zmienia wpisu i nie przerywa reszty', async () => {
    const h = makeHarness();
    const drugi = h.registry.open(CWD, 'next');
    if (!drugi.ok) throw new Error(drugi.sentence.text);
    await settle();
    h.backend.lostTokens.add(h.id);

    const wynik = await h.registry.refreshTokens();

    expect(wynik).toEqual({ refreshed: 1, lost: 1 });
    // Wpis zostaje jak był: o tym, że panel przestał być nasz, rozstrzyga `attach`.
    expect(h.registry.list().map((t) => t.id).sort()).toEqual([h.id, drugi.id].sort());
    expect(h.logs.some((line) => line.includes(`no longer carries token ${h.id}`))).toBe(true);
    h.registry.dispose();
  });

  it('martwe gniazdo (odrzucenie) nie wywraca pętli ani rejestru', async () => {
    const h = makeHarness();
    await settle();
    h.backend.refreshError = new Error('gniazdo herdr nie odpowiada');

    const wynik = await h.registry.refreshTokens();

    expect(wynik).toEqual({ refreshed: 0, lost: 0 });
    expect(h.logs.some((line) => line.includes(`token refresh ${h.id} failed`))).toBe(true);
    expect(h.registry.has(h.id)).toBe(true);
    h.registry.dispose();
  });
});

/*
 * Wielkość liter na macOS. System plików jest bez wielkości liter,
 * `validateProjectCwd` przepuszcza `…/RAROG` dla katalogu `…/rarog`, a `realpathSync` w JS zachowuje
 * pisownię WEJŚCIA — tożsamość terminala liczyła się więc z innej pisowni niż klucz projektu
 * i resolver workspace'u (natywny `realpath`, pisownia z DYSKU). Od poprawki NOWE tożsamości liczą
 * się z pisowni z dysku, a wpis sprzed niej (adopcja z pisownią z pliku stanu) dalej się odnajduje.
 */
describe('tożsamość terminala z pisowni z DYSKU, stare wpisy dalej rozpoznawane', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length > 0) rmSync(dirs.pop() ?? '', { recursive: true, force: true });
  });

  /** Katalog `Projekt` na dysku i jego ścieżka w innej wielkości liter; `null` = FS czuły na litery. */
  function caseDir(): { disk: string; other: string } | null {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'rarog-term-case-')));
    dirs.push(root);
    mkdirSync(join(root, 'Projekt'));
    const other = join(root, 'PROJEKT');
    return existsSync(other) ? { disk: join(root, 'Projekt'), other } : null;
  }

  function registryOn(backend: FakeBackend): TermRegistry {
    return new TermRegistry({
      config: loadConfig({
        RAROG_DEMO: '1', RAROG_TERM: '1', RAROG_TERM_MAX: '8',
        RAROG_PROJECT_ROOTS: '/Users/testowy/Projects',
      }),
      logger: { info: () => {}, error: () => {} },
      backend,
    });
  }

  it('nowy terminal otwarty pisownią inną niż na dysku liczy tożsamość z pisowni dysku', () => {
    const dir = caseDir();
    if (dir === null) return; // FS czuły na wielkość liter — przypadek nie istnieje
    const backend = new FakeBackend();
    const registry = registryOn(backend);

    const opened = registry.open(dir.other);

    expect(opened.ok && opened.id).toBe(termIdFor(dir.disk));
    expect(backend.ensuredCwds).toEqual([dir.disk]);
    registry.dispose();
  });

  it('wpis zaadoptowany z pisownią sprzed poprawki: POST tą samą ALBO dyskową pisownią go odnajduje', () => {
    const dir = caseDir();
    if (dir === null) return;
    const backend = new FakeBackend();
    const registry = registryOn(backend);
    // Adopcja: tożsamość panelu policzona dawniej z pisowni wejścia, plik stanu ma tę pisownię.
    const adopted = registry.open(dir.other, 1, 'shell', { adopt: true });
    if (!adopted.ok) throw new Error(adopted.sentence.text);
    expect(adopted.id).toBe(termIdFor(dir.other));

    const sameSpelling = registry.open(dir.other);
    const diskSpelling = registry.open(dir.disk);

    expect(sameSpelling.ok && sameSpelling.id).toBe(adopted.id);
    expect(diskSpelling.ok && diskSpelling.id).toBe(adopted.id);
    expect(backend.ensured).toHaveLength(1);
    registry.dispose();
  });
});

/*
 * Gniazdo BEZ `POST` (`?direct=1`): apka, która zna id, łączy
 * się od razu. Rejestr odmawia mu wszędzie tam, gdzie naprawić coś umie wyłącznie `open()`, i NIC
 * przy tym nie zmienia — gniazdo bez znacznika dalej zna tylko `has()` (dzisiejsza ścieżka).
 */
describe('attachableDirect — gniazdo bez `POST` (`?direct=1`)', () => {
  it('zdrowy wpis `shell` i `popup`: zgoda, bez spawnu i bez śladu w rejestrze', () => {
    const h = makeHarness();
    const popup = h.registry.open(CWD, 1, 'popup');
    if (!popup.ok) throw new Error(popup.sentence.text);
    const before = h.logs.length;

    expect(h.registry.attachableDirect(h.id)).toBe('ok');
    expect(h.registry.attachableDirect(popup.id)).toBe('ok');
    expect(h.spawned).toHaveLength(0);
    expect(h.logs).toHaveLength(before);
    h.registry.dispose();
  });

  it('id spoza rejestru, także okno skasowane po `exit`: `unknown`', async () => {
    const h = makeHarness();
    expect(h.registry.attachableDirect('ffffffffffffffff')).toBe('unknown');

    const popup = h.registry.open(CWD, 1, 'popup');
    if (!popup.ok) throw new Error(popup.sentence.text);
    h.registry.attach(popup.id, new FakeClient());
    await waitUntil('spawn', () => h.spawned.length === 1);
    h.spawned[0]?.emitExit();

    expect(h.registry.attachableDirect(popup.id)).toBe('unknown');
    h.registry.dispose();
  });

  it('wpis `failed`: odmowa do `POST`, który jako jedyny zdejmuje bezpiecznik', async () => {
    const h = makeHarness();
    const client = new FakeClient();
    h.registry.attach(h.id, client);
    await waitUntil('spawn', () => h.spawned.length === 1);
    // Przejęcie panelu przez obcy kontroler — `failed` bez uchwytu do przeliczenia.
    h.spawned[0]?.opts.onExit({ detail: 'atrapa: taken over', fatal: true, sentence: say('term.taken-over') });
    expect(client.events).toEqual([{ t: 'err', msg: say('term.taken-over').text, msgRef: { code: 'term.taken-over' } }]);

    expect(h.registry.attachableDirect(h.id)).toBe('failed');
    // Bez znacznika gniazdo dalej wchodzi do upgrade'u i dostaje odmowę RAMKĄ (`attach`).
    expect(h.registry.has(h.id)).toBe(true);
    expect(h.registry.attach(h.id, new FakeClient())).toBe('failed');

    expect(h.registry.open(CWD).ok).toBe(true);
    expect(h.registry.attachableDirect(h.id)).toBe('ok');
    h.registry.dispose();
  });

  it('przejęcie bez zdania backendu → domyślna ramka `err` po angielsku (`term.taken-over`)', async () => {
    const h = makeHarness();
    const client = new FakeClient();
    h.registry.attach(h.id, client);
    await waitUntil('spawn', () => h.spawned.length === 1);
    h.spawned[0]?.opts.onExit({ detail: 'atrapa: taken over', fatal: true });
    expect(client.events).toEqual([
      { t: 'err', msg: 'The terminal was taken over. Open it again.', msgRef: { code: 'term.taken-over' } },
    ]);
    h.registry.dispose();
  });

  /*
   * Strażnik uchwytu ustawia `handleStale` ASYNCHRONICZNIE, po odpowiedzi `POST`.
   * Werdykt idzie za stanem wpisu w chwili pytania, a wyjściem jest kolejny `POST`.
   */
  it('uchwyt do przeliczenia (odrzucony `ensureSession`): `stale` do najbliższego `POST`', async () => {
    const h = makeHarness();
    const ensure = h.backend.ensureSession.bind(h.backend);
    h.backend.ensureSession = () => Promise.reject(new Error('gniazdo herdr padło'));
    const inny = h.registry.open('/Users/testowy/Projects/inny');
    if (!inny.ok) throw new Error(inny.sentence.text);

    // Odpowiedź `POST` już poszła, a odmowa backendu jeszcze nie przyszła.
    expect(h.registry.attachableDirect(inny.id)).toBe('ok');
    await settle();
    expect(h.registry.attachableDirect(inny.id)).toBe('stale');
    expect(h.registry.has(inny.id)).toBe(true);

    h.backend.ensureSession = ensure;
    expect(h.registry.open('/Users/testowy/Projects/inny').ok).toBe(true);
    expect(h.logs.some((line) => line.includes('handle recomputed'))).toBe(true);
    expect(h.registry.attachableDirect(inny.id)).toBe('ok');
    h.registry.dispose();
  });

  it('nieaktualny uchwyt z odczytu historii: `stale`', async () => {
    const h = makeHarness();
    h.backend.historyResult = () => Promise.reject(new TermHandleStaleError('nie nasz panel'));
    await h.registry.history(h.id, 100);

    expect(h.registry.attachableDirect(h.id)).toBe('stale');
    h.registry.dispose();
  });

  it('rola `lazygit`: zawsze przez `POST`, bo tylko on sprawdza zastany panel', () => {
    const h = makeHarness();
    const lazygit = h.registry.open(CWD, 1, 'lazygit');
    if (!lazygit.ok) throw new Error(lazygit.sentence.text);

    expect(h.registry.attachableDirect(lazygit.id)).toBe('lazygit');
    h.registry.dispose();
  });
});
