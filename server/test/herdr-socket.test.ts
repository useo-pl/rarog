/**
 * Transport herdr: framing NDJSON, allow-lista metod, bramka protokołu, timeouty, sufit
 * równoległości i reconnect subskrypcji.
 *
 * DLACZEGO BEZ PRAWDZIWEGO GNIAZDA. Plan przewidywał fake serwer unix na `$TMPDIR`, ale
 * `net.createServer().listen()` dostaje w tym środowisku `listen EPERM` (sandbox) — dokładnie
 * tak samo jak testy routera. Zamiast zostawić najbardziej newralgiczny moduł integracji bez
 * testów, `socket.ts` przyjmuje wstrzykiwane `connect`, a tutaj podstawiamy pod nie atrapę
 * gniazda. Testowane jest DOKŁADNIE to, co miało być: bajty zapisane do gniazda, liczba
 * połączeń, kolejność i reakcje na urwane ramki. Nietestowane zostaje samo `net` (cudzy kod).
 *
 * Kształt ramek jest wzięty z żywego serwera (0.8.2 / protokół 20; bramkę mierzymy względem
 * `TESTED_PROTOCOL`, nie literału), nie z domysłu:
 * żądanie `{"id","method","params"}` — wszystkie trzy pola WYMAGANE, odpowiedź
 * `{"id","result"}` albo `{"id","error":{"code","message"}}`, a ramki subskrypcji przychodzą
 * jako `{"event":"pane_exited","data":{…,"type":"pane_exited"}}`.
 */
import { describe, expect, it } from 'vitest';
import type { Scheduler, TimerHandle } from '../src/drivers/runtime.ts';
import {
  ALLOWED_METHODS, HerdrMethodNotAllowedError, HerdrRemoteError, HerdrUnavailableError,
  LINE_MAX_CHARS, LineSplitter, MAX_INFLIGHT, MUTATING_METHODS, READ_METHODS,
  SUBSCRIBE_METHOD, SUBSCRIBE_START_TIMEOUT_MS, TESTED_PROTOCOL, createHerdrSocket,
  normalizeEventKind,
} from '../src/herdr/socket.ts';
import type { HerdrConnectFn, HerdrStreamEvent } from '../src/herdr/socket.ts';
import { HerdrReadOnlyError } from '../src/herdr/types.ts';

// ---------------------------------------------------------------------------
// Atrapy
// ---------------------------------------------------------------------------

class FakeConnection {
  readonly writes: string[] = [];
  destroyed = false;
  onWrite: ((conn: FakeConnection, chunk: string) => void) | null = null;
  readonly #listeners = new Map<string, ((arg?: unknown) => void)[]>();

  on(event: string, listener: (arg?: unknown) => void): void {
    const list = this.#listeners.get(event) ?? [];
    list.push(listener);
    this.#listeners.set(event, list);
  }

  #emit(event: string, arg?: unknown): void {
    for (const listener of [...(this.#listeners.get(event) ?? [])]) listener(arg);
  }

  write(chunk: string): void {
    this.writes.push(chunk);
    this.onWrite?.(this, chunk);
  }

  end(): void {
    this.#emit('close');
  }

  destroy(): void {
    this.destroyed = true;
  }

  /** Serwer przyjął połączenie. */
  fireConnect(): void {
    this.#emit('connect');
  }

  /** Fragment danych od serwera (może być kawałkiem linii). */
  push(text: string): void {
    this.#emit('data', Buffer.from(text, 'utf8'));
  }

  fail(message: string): void {
    this.#emit('error', new Error(message));
  }

  closeRemote(): void {
    this.#emit('close');
  }

  get frame(): { id: string; method: string; params: Record<string, unknown> } {
    return JSON.parse(this.writes[0] ?? '{}') as {
      id: string; method: string; params: Record<string, unknown>;
    };
  }

  get method(): string {
    return this.writes.length === 0 ? '' : this.frame.method;
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
      const due = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.#timers.delete(due[0]);
      this.#now = due[1].at;
      due[1].fn();
    }
    this.#now = target;
  }
}

/** Domyka mikro- i makrozadania (obietnice łańcuchowane w module). */
async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

interface Harness {
  conns: FakeConnection[];
  scheduler: FakeScheduler;
  socket: ReturnType<typeof createHerdrSocket>;
  /** Połączenia inne niż bramka protokołu — to o nie chodzi w asercjach. */
  requests(): FakeConnection[];
  /** Połączenia bramki protokołu — po nich widać, czy memo zostało unieważnione. */
  pings(): FakeConnection[];
  /** Podmienia wersję protokołu ODDAWANĄ przez atrapę (herdr zaktualizowany pod nami). */
  setProtocol(next: number | null): void;
  /**
   * SZCZYT liczby jednocześnie żywych gniazd — mierzony w chwili otwierania każdego z nich.
   *
   * Stan końcowy tego nie pokaże: gniazdo ponad sufit żyje przez kilka mikrozadań i zdąży się
   * zamknąć, zanim test cokolwiek policzy. Sufit równoległości jest właśnie o szczyt.
   */
  peakLive(): number;
}

/**
 * Atrapa gniazda + klient na niej.
 *
 * `protocol` domyślnie {@link TESTED_PROTOCOL}, a przypadki „obcego numeru" liczą się
 * arytmetyką `TESTED_PROTOCOL ± 1`. To jest poprawne DOPÓKI zbiór `KNOWN_PROTOCOLS` ma JEDEN
 * element: wtedy `−1` wpada pod minimum (integracja wyłączona), a `+1` jest nieznany (tylko
 * odczyt). Przy dołożeniu DRUGIEGO numeru arytmetyka przestaje trafiać (`max − 1` może być
 * numerem ZNANYM) i te testy trzeba przepiąć na jawne numery spoza zbioru.
 *
 * `capabilities` domyślnie NIE MA w pongu — tak wygląda odpowiedź serwera bez tego pola
 * (schemat 0.9.0: `capabilities` ma `default: null`, więc brak i `null` są oba normalne).
 */
function harness(opts: {
  protocol?: number | null; autoConnect?: boolean; sendEnabled?: boolean;
  capabilities?: Record<string, unknown> | null;
  onStatus?: (status: { available: boolean }) => void;
} = {}): Harness {
  const conns: FakeConnection[] = [];
  const scheduler = new FakeScheduler();
  // `null` znaczy „serwer nie odpowiada na ping" — dlatego NIE `??`, które zjadłoby null.
  let protocol = opts.protocol === undefined ? TESTED_PROTOCOL : opts.protocol;
  let peak = 0;

  const connect: HerdrConnectFn = () => {
    const conn = new FakeConnection();
    conn.onWrite = (target, chunk) => {
      const frame = JSON.parse(chunk) as { id: string; method: string };
      if (frame.method === 'ping' && protocol !== null) {
        queueMicrotask(() => {
          target.push(`${JSON.stringify({
            id: frame.id,
            result: {
              type: 'pong',
              version: '0.9.0',
              protocol,
              ...(opts.capabilities === undefined ? {} : { capabilities: opts.capabilities }),
            },
          })}\n`);
        });
      }
    };
    conns.push(conn);
    peak = Math.max(peak, conns.filter((c) => !c.destroyed).length);
    if (opts.autoConnect !== false) queueMicrotask(() => conn.fireConnect());
    return conn;
  };

  const socket = createHerdrSocket({
    socketPath: '/nie/istnieje/herdr.sock',
    connect,
    scheduler,
    random: () => 0.5, // jitter dokładnie w środku → mnożnik 1,0
    ...(opts.sendEnabled === undefined ? {} : { sendEnabled: opts.sendEnabled }),
    ...(opts.onStatus === undefined ? {} : { onStatus: opts.onStatus }),
  });

  return {
    conns,
    scheduler,
    socket,
    requests: () => conns.filter((c) => c.method !== 'ping'),
    pings: () => conns.filter((c) => c.method === 'ping'),
    peakLive: () => peak,
    setProtocol: (next) => {
      protocol = next;
    },
  };
}

// ---------------------------------------------------------------------------
// Testy
// ---------------------------------------------------------------------------

describe('LineSplitter', () => {
  it('skleja linię przyciętą w połowie', () => {
    const splitter = new LineSplitter();
    expect(splitter.push('{"a":1')).toEqual([]);
    expect(splitter.push('}\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}']);
    expect(splitter.pending).toBe('');
  });

  it('nie psuje znaku wielobajtowego przyciętego na granicy pakietu', () => {
    const splitter = new LineSplitter();
    const bytes = Buffer.from('{"t":"łąka"}\n', 'utf8');
    expect(splitter.push(bytes.subarray(0, 8))).toEqual([]);
    expect(splitter.push(bytes.subarray(8))).toEqual(['{"t":"łąka"}']);
  });

  it('ma SUFIT długości ramki — strumień bez `\\n` nie rośnie w nieskończoność', () => {
    // Bez sufitu bufor rósł tak długo, jak długo druga strona wysyłała bajty bez separatora:
    // awaria po stronie herdr zjadałaby pamięć Raroga bez żadnego ograniczenia.
    const splitter = new LineSplitter(64);
    expect(splitter.push('x'.repeat(64))).toEqual([]);
    expect(() => splitter.push('x')).toThrow(HerdrUnavailableError);
    // Po błędzie bufor jest pusty: trzymanie ogona po zerwaniu byłoby dokładnie tym,
    // czemu sufit ma zapobiec.
    expect(splitter.pending).toBe('');
  });

  it('sufit dotyczy POJEDYNCZEJ ramki, nie wielkości pakietu', () => {
    // Pakiet z wieloma kompletnymi liniami może być większy niż sufit i jest poprawny.
    const splitter = new LineSplitter(16);
    const linie = ['{"a":1}', '{"b":2}', '{"c":3}'];
    expect(splitter.push(`${linie.join('\n')}\n`)).toEqual(linie);
  });

  it('domyślny sufit to 4 MB — najdłuższa realna ramka ma rząd wielkości zapasu', () => {
    expect(LINE_MAX_CHARS).toBe(4 * 1024 * 1024);
  });
});

describe('normalizeEventKind', () => {
  it('sprowadza obie przestrzenie nazw herdr do wariantu z podkreśleniami', () => {
    expect(normalizeEventKind({ event: 'pane.agent_status_changed', data: {} }))
      .toBe('pane_agent_status_changed');
    expect(normalizeEventKind({ event: 'pane_exited', data: { type: 'pane_exited' } }))
      .toBe('pane_exited');
  });

  it('woli `data.type` niż `event` (ramka subskrypcji bywa opisana dwoma nazwami)', () => {
    expect(normalizeEventKind({ event: 'pane.output_matched', data: { type: 'pane_moved' } }))
      .toBe('pane_moved');
  });
});

describe('request — framing i jedno żądanie na połączenie', () => {
  it('wysyła jedną linię `{id, method, params}` i parsuje `result`', async () => {
    const h = harness();
    const pending = h.socket.request('agent.list', {});
    await flush();

    const conn = h.requests()[0];
    expect(conn).toBeDefined();
    expect(conn!.writes).toHaveLength(1);
    expect(conn!.writes[0]?.endsWith('\n')).toBe(true);
    expect(conn!.frame).toMatchObject({ method: 'agent.list', params: {} });
    expect(typeof conn!.frame.id).toBe('string');

    conn!.push(`${JSON.stringify({ id: conn!.frame.id, result: { type: 'agent_list', agents: [] } })}\n`);
    await expect(pending).resolves.toEqual({ type: 'agent_list', agents: [] });
    expect(conn!.destroyed).toBe(true);
  });

  it('każde żądanie dostaje WŁASNE połączenie (pipelining gubi drugie żądanie)', async () => {
    const h = harness();
    const first = h.socket.request('agent.list', {});
    await flush();
    const connA = h.requests()[0]!;
    connA.push(`${JSON.stringify({ id: connA.frame.id, result: { agents: [] } })}\n`);
    await first;

    const second = h.socket.request('agent.get', { target: 'w9:p72' });
    await flush();
    const connB = h.requests()[1]!;
    expect(connB).not.toBe(connA);
    expect(connB.writes).toHaveLength(1);
    connB.push(`${JSON.stringify({ id: connB.frame.id, result: { agent: null } })}\n`);
    await second;
  });

  it('mapuje `error.code` na HerdrRemoteError', async () => {
    const h = harness();
    const pending = h.socket.request('agent.prompt', { target: 'w9:p72', text: 'x' });
    await flush();
    const conn = h.requests()[0]!;
    conn.push(`${JSON.stringify({
      id: conn.frame.id,
      error: { code: 'agent_blocked', message: 'agent is blocked' },
    })}\n`);

    await expect(pending).rejects.toBeInstanceOf(HerdrRemoteError);
    await pending.catch((err: unknown) => {
      expect((err as HerdrRemoteError).remoteCode).toBe('agent_blocked');
    });
  });

  it('odpowiedź bez `result` i bez `error` → HerdrUnavailableError', async () => {
    const h = harness();
    const pending = h.socket.request('agent.list', {});
    await flush();
    h.requests()[0]!.push('{"id":"x"}\n');
    await expect(pending).rejects.toBeInstanceOf(HerdrUnavailableError);
  });

  it('odpowiedź niebędąca JSON-em → HerdrUnavailableError', async () => {
    const h = harness();
    const pending = h.socket.request('agent.list', {});
    await flush();
    h.requests()[0]!.push('to nie jest json\n');
    await expect(pending).rejects.toBeInstanceOf(HerdrUnavailableError);
  });

  it('zamknięcie połączenia bez odpowiedzi → HerdrUnavailableError', async () => {
    const h = harness();
    const pending = h.socket.request('agent.list', {});
    await flush();
    h.requests()[0]!.closeRemote();
    await expect(pending).rejects.toBeInstanceOf(HerdrUnavailableError);
  });

  it('odpowiedź z OBCYM `id` to błąd protokołu, a nie wynik żądania', async () => {
    /*
     * `id` jest jedynym potwierdzeniem, że czytamy odpowiedź na NASZE żądanie. Bez kontroli
     * korelacji spóźniona ramka poprzedniego żądania (albo cudzy ruch na gnieździe) wracała
     * jako wynik bieżącego wywołania — np. `result` z `agent.get` jako odpowiedź na
     * `agent.start`. Cicha akceptacja jest tu gorsza niż błąd: nikt jej nie zauważy.
     */
    const h = harness();
    const pending = h.socket.request('agent.list', {});
    await flush();
    h.requests()[0]!.push(`${JSON.stringify({ id: 'rarog-999', result: { agents: [] } })}\n`);
    await expect(pending).rejects.toMatchObject({ sentence: { ref: { code: 'herdr.response-foreign-id' } } });
  });

  it('ramka `error` z obcym `id` też nie przechodzi', async () => {
    // Korelacja jest sprawdzana PRZED `error`: cudzy błąd nie ma prawa przewrócić naszego
    // żądania kodem, który go nie dotyczy (`agent_blocked` z innej rozmowy).
    const h = harness();
    const pending = h.socket.request('agent.prompt', { target: 'w9:p72', text: 'x' });
    await flush();
    h.requests()[0]!.push(`${JSON.stringify({
      id: 'rarog-inny', error: { code: 'agent_blocked', message: 'agent is blocked' },
    })}\n`);
    await expect(pending).rejects.toMatchObject({ sentence: { ref: { code: 'herdr.response-foreign-id' } } });
  });

  it('KOMPLETNA odpowiedź bez końcowego `\\n` przed `close` jest wynikiem, nie awarią',
    async () => {
      /*
       * herdr odpowiada i zamyka gniazdo, a kolejność „ostatni bajt bez `\n`, potem FIN" jest
       * po stronie TCP normalna. Ogon bufora był dotąd wyrzucany, więc poprawna odpowiedź
       * wracała jako „herdr zamknął połączenie bez odpowiedzi" — czyli jako błąd transportu,
       * który dodatkowo gasił dostępność całej integracji.
       */
      const h = harness();
      const pending = h.socket.request('agent.list', {});
      await flush();
      const conn = h.requests()[0]!;
      conn.push(JSON.stringify({ id: conn.frame.id, result: { agents: [] } })); // BEZ `\n`
      conn.closeRemote();
      await expect(pending).resolves.toEqual({ agents: [] });
      expect(h.socket.status().available).toBe(true);
    });

  it('URWANY ogon przed `close` zostaje awarią zamknięcia', async () => {
    // Pół ramki to nie odpowiedź — powodem zostaje zamknięcie połączenia, a nie „nie-JSON".
    const h = harness();
    const pending = h.socket.request('agent.list', {});
    await flush();
    const conn = h.requests()[0]!;
    conn.push('{"id":"rarog-2","result":{"agen');
    conn.closeRemote();
    await expect(pending).rejects.toMatchObject({ sentence: { ref: { code: 'herdr.closed-without-response' } } });
  });

  it('ramka bez końca linii dłuższa niż sufit zrywa połączenie', async () => {
    const h = harness();
    const pending = h.socket.request('agent.read', { target: 'w9:p72', source: 'visible' });
    await flush();
    const conn = h.requests()[0]!;
    // Jeden „pakiet" o rozmiarze ponad sufit — bez ani jednego separatora.
    conn.push('x'.repeat(LINE_MAX_CHARS + 1));
    await expect(pending).rejects.toMatchObject({ sentence: { ref: { code: 'herdr.frame-too-long' } } });
    expect(conn.destroyed).toBe(true);
  });

  it('per-call timeout: `agent.start` czeka dłużej niż globalne 5 s', async () => {
    /*
     * NAJWAŻNIEJSZA z napraw transportu. Globalne 5 s jest dobrane pod metody odpowiadające
     * w ułamku milisekundy; `agent.start` bywa dłuższy o rząd wielkości i timeout gniazda
     * ubiegał wtedy odpowiedź herdr. Wynikiem było „nie wiem, co się stało" dla procesu,
     * który właśnie ruszył — a launcher zamykał na tej podstawie tab z żywym agentem.
     */
    const h = harness();
    const pending = h.socket.request(
      'agent.start', { name: 'rarog-abc', kind: 'claude', pane_id: 'w9:p9' },
      { timeoutMs: 13_000 },
    );
    await flush();
    let odrzucone = false;
    void pending.catch(() => { odrzucone = true; });

    h.scheduler.advance(5_000);
    await flush();
    // Globalny sufit minął, a wywołanie DALEJ czeka — o to w tej naprawie chodzi.
    expect(odrzucone).toBe(false);

    const conn = h.requests()[0]!;
    conn.push(`${JSON.stringify({ id: conn.frame.id, result: { agent_started: { argv: [] } } })}\n`);
    await expect(pending).resolves.toBeDefined();
  });

  it('per-call timeout ma KONIEC — po jego upływie żądanie i tak odpada', async () => {
    const h = harness();
    const pending = h.socket.request(
      'agent.start', { name: 'rarog-abc', kind: 'claude', pane_id: 'w9:p9' },
      { timeoutMs: 13_000 },
    );
    await flush();
    h.scheduler.advance(13_000);
    await expect(pending).rejects.toMatchObject({ sentence: { ref: { code: 'herdr.response-timeout' } } });
  });
});

describe('allow-lista metod', () => {
  it('zawiera dokładnie dwadzieścia trzy metody', () => {
    expect([...ALLOWED_METHODS].sort()).toEqual([
      'agent.focus', 'agent.get', 'agent.list', 'agent.prompt', 'agent.read', 'agent.send_keys',
      'agent.start', 'events.subscribe', 'pane.close', 'pane.layout', 'pane.list', 'pane.process_info',
      'pane.read', 'pane.rename', 'pane.report_metadata', 'pane.send_input', 'ping', 'tab.close', 'tab.create',
      'tab.get', 'tab.rename', 'workspace.create', 'workspace.list',
    ]);
  });

  it('każda metoda ma jawną klasę: ALLOWED = ODCZYTY ∪ ZAPISY, zbiory rozłączne', () => {
    /*
     * To jest DOZÓR nad granicą bezpieczeństwa, nie inwentaryzacja. `readOnly` (czyli
     * `RAROG_HERDR_SEND=0` ORAZ nieznany protokół) jest sprawdzany WYŁĄCZNIE po
     * `MUTATING_METHODS`, więc metoda zapisu, która wejdzie na allow-listę z pominięciem tej
     * listy, pisałaby do panelu przy zamkniętym kanale zapisu — runbook „kradzież telefonu"
     * byłby fikcją. Poprzednia wersja tego testu chodziła po SZTYWNEJ liście siedmiu nazw
     * i takiego rozjazdu nie widziała; asercje niżej wymuszają nazwanie KAŻDEJ nowej metody
     * po stronie odczytu albo zapisu — trzeciego miejsca nie ma, bo ALLOWED jest wyliczana.
     */
    expect([...MUTATING_METHODS].sort()).toEqual([
      'agent.focus', 'agent.prompt', 'agent.send_keys', 'agent.start',
      // `pane.close` weszło z terminalem na backendzie herdr i jest ZAPISEM:
      // przy `RAROG_HERDR_SEND=0` ma odpaść razem z resztą mutacji, a nie zamykać panele.
      'pane.close',
      // `pane.rename` i `tab.rename` są ZAPISAMI: etykieta panelu
      // to dowód pochodzenia, etykieta taba — to, co człowiek widzi w herdr. Przy
      // `RAROG_HERDR_SEND=0` ani jedna, ani druga nie ma prawa się zmienić.
      'pane.rename', 'pane.report_metadata',
      // `pane.send_input` weszło z wysyłką w trakcie tury i jest ZAPISEM: samo wklejenie
      // tekstu do panelu agenta (`HerdrClient.pasteText`). Przy `RAROG_HERDR_SEND=0` odpada razem z `agent.prompt`.
      'pane.send_input',
      'tab.close', 'tab.create', 'tab.rename', 'workspace.create',
    ]);
    expect([...READ_METHODS].sort()).toEqual([
      'agent.get', 'agent.list', 'agent.read', 'events.subscribe',
      // `pane.read` weszło z historią terminala do zaznaczenia i jest ODCZYTEM:
      // przy `RAROG_HERDR_SEND=0` ma DALEJ działać — „widzę, nie ruszam" to dokładnie ten tryb.
      // `pane.process_info` weszło z tabami terminala: nazwa procesu na pigułce
      // i ta sama zasada — etykieta ma się rysować także przy zamkniętym kanale zapisu.
      // `pane.layout` weszło z przywróceniem rozmiaru panelu terminala przed `terminal.release`
      // i jest ODCZYTEM: geometria taba, a rozmiar idzie strumieniem kontrolera.
      'pane.layout', 'pane.list', 'pane.process_info', 'pane.read', 'ping',
      // `tab.get` weszło z etykietami tabów i jest ODCZYTEM: etykieta i liczba
      // paneli taba przed decyzją o `tab.rename`. Sam zapis (`tab.rename`) zostaje w mutacjach.
      'tab.get',
      // `workspace.list` weszło z resolverem workspace'u projektu (commit 4) i jest ODCZYTEM:
      // etykiety i ścieżki checkoutu przed wyborem, gdzie założyć tab. Zakładanie zostaje zapisem.
      'workspace.list',
    ]);

    // Różnica zbiorów, a nie lista literałów: cokolwiek dojdzie do ALLOWED, musi być odczytem.
    const niemutujace = [...ALLOWED_METHODS].filter((m) => !MUTATING_METHODS.has(m)).sort();
    expect(niemutujace).toEqual([...READ_METHODS].sort());
    // Żadna metoda nie może być w obu — inaczej „odczyt" przemyciłby zapis pod killswitchem.
    for (const method of MUTATING_METHODS) {
      expect(READ_METHODS.has(method), method).toBe(false);
    }
    // `pane.list` to ODCZYT — przy `readOnly` ma dalej działać, bo „widzę stan" zostaje
    // wartością Raroga bez prawa pisania.
    expect(MUTATING_METHODS.has('pane.list')).toBe(false);
    // To samo pytanie o `pane.read`: gdyby wpadła do mutacji, historia terminala znikałaby
    // razem z prawem pisania — a jest to jedyna droga wyniesienia scrollbacku z telefonu.
    expect(MUTATING_METHODS.has('pane.read')).toBe(false);
    expect(READ_METHODS.has('pane.read')).toBe(true);
    expect(MUTATING_METHODS.has('pane.process_info')).toBe(false);
    expect(READ_METHODS.has('pane.process_info')).toBe(true);
    expect(MUTATING_METHODS.has('tab.get')).toBe(false);
    expect(READ_METHODS.has('tab.get')).toBe(true);
    expect(MUTATING_METHODS.has('workspace.list')).toBe(false);
    expect(READ_METHODS.has('workspace.list')).toBe(true);
    expect(MUTATING_METHODS.has('pane.layout')).toBe(false);
    expect(READ_METHODS.has('pane.layout')).toBe(true);
  });

  for (const method of ['server.stop', 'pane.split',
    'pane.send_text', 'pane.send_keys',
    'pane.move', 'pane.input.set',
    'workspace.close', 'agent.wait', 'session.snapshot',
    // Nazwa agenta to dowód własności: Rarog jej nie zmienia, nadaje ją tylko `agent.start`.
    'agent.rename']) {
    it(`odrzuca ${method} ZANIM otworzy gniazdo (zero bajtów)`, async () => {
      const h = harness();
      await expect(h.socket.request(method, {})).rejects.toBeInstanceOf(
        HerdrMethodNotAllowedError,
      );
      expect(h.conns).toHaveLength(0);
    });
  }
});

describe('bramka protokołu', () => {
  it('testowany protokół → wszystko działa', async () => {
    const h = harness({ protocol: TESTED_PROTOCOL });
    const pending = h.socket.request('agent.list', {});
    await flush();
    // `id` odbite z ramki żądania, a nie wymyślone: od kontroli korelacji obce `id` jest
    // błędem protokołu (patrz test „odpowiedź z obcym `id`…").
    const connOk = h.requests()[0]!;
    connOk.push(`${JSON.stringify({ id: connOk.frame.id, result: { agents: [] } })}\n`);
    await expect(pending).resolves.toBeDefined();
    expect(h.socket.status())
      .toMatchObject({ available: true, readOnly: false, protocol: TESTED_PROTOCOL });
  });

  it('znany protokół + `capabilities` z generacją → pełna integracja, generacja w statusie',
    async () => {
      const h = harness({
        protocol: TESTED_PROTOCOL,
        capabilities: { live_handoff: true, endpoint_protocol_generation: 1 },
      });
      const pending = h.socket.request('agent.list', {});
      await flush();
      const conn = h.requests()[0]!;
      conn.push(`${JSON.stringify({ id: conn.frame.id, result: { agents: [] } })}\n`);
      await expect(pending).resolves.toBeDefined();

      expect(h.socket.status()).toMatchObject({
        available: true, readOnly: false, protocol: TESTED_PROTOCOL, generation: 1,
      });
      // Generacja jest DIAGNOSTYKĄ: nie ma jej w powodzie, który zobaczyłby człowiek w banerze.
      expect(h.socket.status().detail).toBeUndefined();
    });

  it('znany protokół + `capabilities: null` → pełna integracja, status bez generacji', async () => {
    // `default: null` w schemacie 0.9.0 — brak zdolności NIE jest awarią i nie rusza bramki.
    const h = harness({ protocol: TESTED_PROTOCOL, capabilities: null });
    const pending = h.socket.request('agent.list', {});
    await flush();
    const conn = h.requests()[0]!;
    conn.push(`${JSON.stringify({ id: conn.frame.id, result: { agents: [] } })}\n`);
    await expect(pending).resolves.toBeDefined();

    expect(h.socket.status()).toMatchObject({ available: true, readOnly: false });
    expect(h.socket.status().generation).toBeUndefined();
  });

  it('generacja 0 przy znanym protokole → NADAL pełna integracja (generacja nie jest bramką)',
    async () => {
      /*
       * Test istnieje po to, żeby cofnięcie tej decyzji było widoczne: gdyby ktoś dorobił bramkę
       * na generacji, padłby TUTAJ, a nie na produkcji. Generacja opisuje endpoint klienta TUI
       * (attach/handoff), nie kształty JSON API, i na żywym 0.9.0 nie jest zmierzona — bramka
       * na niej byłaby zgadywaniem.
       */
      const h = harness({
        protocol: TESTED_PROTOCOL,
        capabilities: { live_handoff: true, endpoint_protocol_generation: 0 },
      });
      const pending = h.socket.request('agent.prompt', { target: 'w9:p72', text: 'x' });
      await flush();
      const conn = h.requests()[0]!;
      conn.push(`${JSON.stringify({ id: conn.frame.id, result: { ok: true } })}\n`);
      await expect(pending).resolves.toBeDefined();

      expect(h.socket.status()).toMatchObject({
        available: true, readOnly: false, generation: 0,
      });
    });

  it('protokół starszy o 1 → integracja nieaktywna, żadne żądanie nie idzie dalej', async () => {
    const h = harness({ protocol: TESTED_PROTOCOL - 1 });
    await expect(h.socket.request('agent.list', {})).rejects.toBeInstanceOf(
      HerdrUnavailableError,
    );
    // Poszedł WYŁĄCZNIE ping bramki.
    expect(h.requests()).toHaveLength(0);
    expect(h.socket.status()).toMatchObject({ available: false, readOnly: true });
  });

  it('protokół nowszy o 1 → `agent.list` przechodzi, `agent.prompt` jest blokowany', async () => {
    const h = harness({ protocol: TESTED_PROTOCOL + 1 });
    const pending = h.socket.request('agent.list', {});
    await flush();
    const conn = h.requests()[0]!;
    conn.push(`${JSON.stringify({ id: conn.frame.id, result: { agents: [] } })}\n`);
    await expect(pending).resolves.toBeDefined();

    const before = h.conns.length;
    await expect(h.socket.request('agent.prompt', { target: 'w9:p72', text: 'x' }))
      .rejects.toBeInstanceOf(HerdrReadOnlyError);
    // Mutacja nie otworzyła ANI JEDNEGO nowego połączenia.
    expect(h.conns).toHaveLength(before);
    expect(h.socket.status().readOnly).toBe(true);
    expect(h.socket.status().detail?.text).toContain(String(TESTED_PROTOCOL + 1));
  });

  it('RAROG_HERDR_SEND=0 → odczyty działają, mutacje rzucają', async () => {
    const h = harness({ protocol: TESTED_PROTOCOL, sendEnabled: false });
    const pending = h.socket.request('agent.read', { target: 'w9:p72', source: 'visible' });
    await flush();
    const conn = h.requests()[0]!;
    conn.push(`${JSON.stringify({ id: conn.frame.id, result: { read: { text: '' } } })}\n`);
    await expect(pending).resolves.toBeDefined();

    await expect(h.socket.request('agent.send_keys', { target: 'w9:p72', keys: ['escape'] }))
      .rejects.toBeInstanceOf(HerdrReadOnlyError);
  });

  it('RAROG_HERDR_SEND=0 → `agent.start` i `tab.close` rzucają, ZERO bajtów w gnieździe',
    async () => {
      // Bez tego testu killswitch „nie ruszam paneli" nie obejmowałby ich ZAKŁADANIA
      // i ZAMYKANIA — czyli dwóch władz, których Rarog dotąd w ogóle nie miał.
      const h = harness({ protocol: TESTED_PROTOCOL, sendEnabled: false });

      await expect(h.socket.request('agent.start', { name: 'rarog-abc', kind: 'claude' }))
        .rejects.toBeInstanceOf(HerdrReadOnlyError);
      await expect(h.socket.request('tab.close', { tab_id: 'w9:t3' }))
        .rejects.toBeInstanceOf(HerdrReadOnlyError);

      // `requests()` odsiewa bramkę protokołu — zostaje pustka, czyli ani jedna ramka
      // tworząca nie dotknęła gniazda.
      expect(h.requests()).toHaveLength(0);
    });

  it('RAROG_HERDR_SEND=0 i nieznany protokół → `pane.rename` i `tab.rename` rzucają',
    async () => {
      for (const opts of [
        { protocol: TESTED_PROTOCOL, sendEnabled: false },
        { protocol: TESTED_PROTOCOL + 1 },
      ]) {
        const h = harness(opts);
        await expect(h.socket.request('pane.rename', { pane_id: 'w9:p9', label: 'x' }))
          .rejects.toBeInstanceOf(HerdrReadOnlyError);
        await expect(h.socket.request('tab.rename', { tab_id: 'w9:t9', label: 'x' }))
          .rejects.toBeInstanceOf(HerdrReadOnlyError);
        expect(h.requests()).toHaveLength(0);
      }
    });

  it('RAROG_HERDR_SEND=0 → `workspace.list` przechodzi (odczyt etykiet workspace\'ów)', async () => {
    const h = harness({ protocol: TESTED_PROTOCOL, sendEnabled: false });
    const pending = h.socket.request('workspace.list', {});
    await flush();
    const conn = h.requests()[0]!;
    expect(conn.frame.method).toBe('workspace.list');
    conn.push(`${JSON.stringify({
      id: conn.frame.id, result: { type: 'workspace_list', workspaces: [] },
    })}\n`);
    await expect(pending).resolves.toBeDefined();
  });

  it('RAROG_HERDR_SEND=0 → `pane.layout` przechodzi (układ taba przed zwolnieniem terminala)', async () => {
    const h = harness({ protocol: TESTED_PROTOCOL, sendEnabled: false });
    const pending = h.socket.request('pane.layout', { pane_id: 'w9:p9' });
    await flush();
    const conn = h.requests()[0]!;
    expect(conn.frame.method).toBe('pane.layout');
    conn.push(`${JSON.stringify({
      id: conn.frame.id, result: { type: 'pane_layout', layout: { panes: [] } },
    })}\n`);
    await expect(pending).resolves.toBeDefined();
  });

  it('RAROG_HERDR_SEND=0 → `tab.get` przechodzi (odczyt etykiety taba)', async () => {
    const h = harness({ protocol: TESTED_PROTOCOL, sendEnabled: false });
    const pending = h.socket.request('tab.get', { tab_id: 'w9:t9' });
    await flush();
    const conn = h.requests()[0]!;
    expect(conn.frame.method).toBe('tab.get');
    conn.push(`${JSON.stringify({
      id: conn.frame.id,
      result: { type: 'tab_info', tab: { tab_id: 'w9:t9', label: 'x', pane_count: 1 } },
    })}\n`);
    await expect(pending).resolves.toBeDefined();
  });

  it('utrata gniazda unieważnia memo — herdr wznowiony na nowszym protokole blokuje mutację',
    async () => {
      /*
       * Scenariusz `herdr update --handoff`: bramka protokołu przeszła na testowany numer, potem gniazdo
       * padło, a wrócił serwer z INNYM numerem protokołu. Memo `probe` kasowała dotąd wyłącznie
       * pętla reconnectu subskrypcji — i to dopiero po backoffie (1–30 s), więc przez całe to
       * okno `request()` uważał nowy protokół za przetestowany i przepuszczał zapisy do panelu.
       * Tu nie ma subskrypcji w ogóle, więc bez naprawy memo nie kasuje NIC i `agent.prompt`
       * wysyła ramkę do serwera o niezweryfikowanej semantyce.
       */
      const h = harness({ protocol: TESTED_PROTOCOL });
      const first = h.socket.request('agent.list', {});
      await flush();
      const conn = h.requests()[0]!;
      conn.push(`${JSON.stringify({ id: conn.frame.id, result: { agents: [] } })}\n`);
      await first;
      expect(h.socket.status())
        .toMatchObject({ available: true, readOnly: false, protocol: TESTED_PROTOCOL });
      expect(h.pings()).toHaveLength(1);

      // herdr znika w trakcie żądania…
      const dropped = h.socket.request('agent.list', {});
      await flush();
      h.requests().at(-1)!.fail('ECONNRESET');
      await expect(dropped).rejects.toBeInstanceOf(HerdrUnavailableError);
      expect(h.socket.status().available).toBe(false);
      // …i wraca jako nowsza wersja.
      h.setProtocol(TESTED_PROTOCOL + 1);

      const before = h.requests().length;
      const blocked = h.socket.request('agent.prompt', { target: 'w9:p72', text: 'x' });
      // Asercję zakładamy OD RAZU: bez naprawy `blocked` nigdy się nie rozstrzyga (ramka poszła
      // do gniazda i czeka na odpowiedź), więc test ma paść na liczbie połączeń, nie na timeoucie.
      const rozstrzygniecie = expect(blocked).rejects.toBeInstanceOf(HerdrReadOnlyError);
      await flush();
      // Bramka poszła jeszcze raz (drugi ping) i zobaczyła nowszy numer — ramka promptu nie powstała.
      expect(h.pings()).toHaveLength(2);
      expect(h.requests()).toHaveLength(before);
      await rozstrzygniecie;
      expect(h.socket.status()).toMatchObject({ readOnly: true, protocol: TESTED_PROTOCOL + 1 });
    });

  it('nowszy protokół blokuje tworzenie, ale `pane.list` dalej działa', async () => {
    const h = harness({ protocol: TESTED_PROTOCOL + 1 });
    const pending = h.socket.request('pane.list', {});
    await flush();
    const conn = h.requests().at(-1)!;
    conn.push(`${JSON.stringify({ id: conn.frame.id, result: { panes: [] } })}\n`);
    await expect(pending).resolves.toBeDefined();

    await expect(h.socket.request('agent.start', { name: 'rarog-abc', kind: 'claude' }))
      .rejects.toBeInstanceOf(HerdrReadOnlyError);
  });
});

describe('timeouty', () => {
  it('timeout połączenia (2 s) odrzuca obietnicę', async () => {
    const h = harness({ autoConnect: false, protocol: null });
    const pending = h.socket.request('ping', {});
    await flush();
    h.scheduler.advance(1_999);
    h.scheduler.advance(1);
    await expect(pending).rejects.toMatchObject({ sentence: { ref: { code: 'herdr.connect-timeout' } } });
    expect(h.conns[0]?.destroyed).toBe(true);
  });

  it('timeout żądania (5 s) odrzuca obietnicę po nawiązaniu połączenia', async () => {
    const h = harness({ protocol: null });
    const pending = h.socket.request('ping', {});
    await flush();
    h.scheduler.advance(5_000);
    await expect(pending).rejects.toMatchObject({ sentence: { ref: { code: 'herdr.response-timeout' } } });
  });
});

describe('sufit równoległości', () => {
  it('trzyma najwyżej MAX_INFLIGHT połączeń, resztę kolejkuje FIFO', async () => {
    const h = harness();
    const pending = Array.from(
      { length: MAX_INFLIGHT + 1 },
      () => h.socket.request('agent.list', {}),
    );
    await flush();
    // `requests()` pomija połączenia bramki protokołu — liczymy same `agent.list`.
    expect(h.requests()).toHaveLength(MAX_INFLIGHT);

    const first = h.requests()[0]!;
    first.push(`${JSON.stringify({ id: first.frame.id, result: { agents: [] } })}\n`);
    await flush();
    expect(h.requests()).toHaveLength(MAX_INFLIGHT + 1);

    for (const conn of h.requests()) {
      if (conn.writes.length > 0 && !conn.destroyed) {
        conn.push(`${JSON.stringify({ id: conn.frame.id, result: { agents: [] } })}\n`);
      }
    }
    await Promise.allSettled(pending);
  });

  it('zwolniony slot jest przekazywany SYNCHRONICZNIE — sufit nie jest przekraczany',
    async () => {
      /*
       * Wyścig, którego ten test pilnuje: slot był oddawany przez `inflight -= 1` i dopiero
       * potem obudzony z kolejki robił `inflight += 1` — we WŁASNYM mikrozadaniu. Między tymi
       * dwoma zdarzeniami licznik pokazywał wolne miejsce, więc równoległy nowy wołający
       * wchodził w nie natychmiast i przez chwilę żyło MAX_INFLIGHT + 1 gniazd. Przy resyncu
       * 17 paneli oznaczało to kilkanaście połączeń naraz zamiast ośmiu — czyli dokładnie to,
       * przed czym ten sufit miał chronić.
       *
       * Nowego wołającego wpuszczamy przez `onStatus`: to jedyny hak wołany SYNCHRONICZNIE
       * w środku obsługi żądania, więc jego mikrozadanie ustawia się w kolejce PRZED
       * obudzeniem czekającego. Bez naprawy licznik jest wtedy o jeden za niski.
       */
      let socketRef: Harness | null = null;
      const h: Harness = harness({
        onStatus: (st) => {
          if (st.available) return;
          // Nowe żądanie tuż po zwolnieniu slotu — w mikrozadaniu, nie tu i teraz.
          queueMicrotask(() => {
            void socketRef?.socket.request('agent.list', {}).catch(() => undefined);
          });
        },
      });
      socketRef = h;

      const pending = Array.from(
        { length: MAX_INFLIGHT + 1 },
        () => h.socket.request('agent.list', {}).catch(() => undefined),
      );
      await flush();
      expect(h.requests()).toHaveLength(MAX_INFLIGHT);

      // Jedno żądanie pada: `setStatus(available:false)` → `onStatus` → nowy wołający,
      // a zaraz po nim obudzenie czekającego z kolejki.
      h.requests()[0]!.fail('ECONNRESET');
      await flush();

      // SZCZYT, nie stan końcowy: gniazdo ponad sufit żyje tylko kilka mikrozadań.
      expect(h.peakLive()).toBeLessThanOrEqual(MAX_INFLIGHT);
      const zywe = h.conns.filter((c) => !c.destroyed);

      for (const conn of zywe) {
        if (conn.writes.length > 0) {
          conn.push(`${JSON.stringify({ id: conn.frame.id, result: { agents: [] } })}\n`);
        }
      }
      await Promise.allSettled(pending);
    });
});

describe('dispose', () => {
  it('niszczy żywe gniazda zamiast zostawiać je z deskryptorem', async () => {
    const h = harness();
    const pending = h.socket.request('agent.list', {}).catch(() => undefined);
    await flush();
    expect(h.requests()[0]?.destroyed).toBe(false);

    h.socket.dispose();
    expect(h.conns.every((c) => c.destroyed)).toBe(true);
    await pending;
  });

  it('odrzuca WSZYSTKICH czekających w kolejce sufitu (nie zostawia wiszących obietnic)',
    async () => {
      // Bez naprawy obietnice w `waiting` nie rozwiązywały się nigdy: po `dispose()` wołający
      // stał w `await` do końca procesu, razem z całym łańcuchem, który na niego czekał.
      const h = harness();
      const pending = Array.from(
        { length: MAX_INFLIGHT + 2 },
        () => h.socket.request('agent.list', {}),
      );
      await flush();
      expect(h.requests()).toHaveLength(MAX_INFLIGHT);

      h.socket.dispose();
      const wyniki = await Promise.allSettled(pending);
      expect(wyniki.every((r) => r.status === 'rejected')).toBe(true);
      for (const r of wyniki) {
        if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(HerdrUnavailableError);
      }
    });

  it('kasuje trwający backoff — pętla reconnectu nie budzi się po zamknięciu', async () => {
    const h = harness();
    const sub = h.socket.subscribe([{ type: 'pane.created' }]);
    void (async () => {
      for await (const _ of sub.events) { /* konsumujemy */ }
    })();
    await flush();
    const stream = h.requests()[0]!;
    stream.push(`${JSON.stringify({ id: stream.frame.id, result: { type: 'subscription_started' } })}\n`);
    await flush();
    stream.fail('ECONNRESET');
    await flush();

    // Jesteśmy w środku backoffu (1 s) — `dispose()` ma go skasować I obudzić pętlę.
    const before = h.conns.length;
    h.socket.dispose();
    h.scheduler.advance(120_000);
    await flush();
    expect(h.conns).toHaveLength(before);
  });

  it('po `dispose()` żadne nowe żądanie nie dotyka gniazda', async () => {
    const h = harness();
    h.socket.dispose();
    await expect(h.socket.request('agent.list', {})).rejects.toBeInstanceOf(
      HerdrUnavailableError,
    );
    expect(h.conns).toHaveLength(0);
  });
});

describe('subskrypcja', () => {
  it('subskrybuje pełną listą, zwraca `connected` i ramki zdarzeń', async () => {
    const h = harness();
    const sub = h.socket.subscribe([{ type: 'pane.created' }, {
      type: 'pane.agent_status_changed', pane_id: 'w9:p72',
    }]);
    const seen: HerdrStreamEvent[] = [];
    void (async () => {
      for await (const ev of sub.events) seen.push(ev);
    })();
    await flush();

    const stream = h.requests()[0]!;
    expect(stream.frame.method).toBe('events.subscribe');
    expect(stream.frame.params).toEqual({
      subscriptions: [
        { type: 'pane.created' },
        { type: 'pane.agent_status_changed', pane_id: 'w9:p72' },
      ],
    });

    stream.push(`${JSON.stringify({ id: stream.frame.id, result: { type: 'subscription_started' } })}\n`);
    await flush();
    expect(seen).toEqual([{ type: 'connected' }]);

    // Ramka przycięta w połowie: obie połówki dają JEDNO zdarzenie.
    stream.push('{"event":"pane_exited","data":{"pane_id":"wF:p10","ty');
    await flush();
    expect(seen).toHaveLength(1);
    stream.push('pe":"pane_exited","workspace_id":"wF"}}\n');
    await flush();
    expect(seen[1]).toEqual({
      type: 'event',
      kind: 'pane_exited',
      data: { pane_id: 'wF:p10', type: 'pane_exited', workspace_id: 'wF' },
    });

    sub.close();
  });

  it('uszkodzona ramka w środku strumienia nie zabija strumienia', async () => {
    const h = harness();
    const sub = h.socket.subscribe([{ type: 'pane.created' }]);
    const seen: HerdrStreamEvent[] = [];
    void (async () => {
      for await (const ev of sub.events) seen.push(ev);
    })();
    await flush();
    const stream = h.requests()[0]!;
    stream.push(`${JSON.stringify({ id: stream.frame.id, result: { type: 'subscription_started' } })}\n`);
    stream.push('to nie jest json\n');
    stream.push('{"event":"pane_created","data":{"type":"pane_created"}}\n');
    await flush();

    expect(seen.map((ev) => ev.type)).toEqual(['connected', 'event']);
    sub.close();
  });

  it('rozłączenie → `disconnected` i reconnect po backoffie 1 s', async () => {
    const h = harness();
    const sub = h.socket.subscribe([{ type: 'pane.created' }]);
    const seen: HerdrStreamEvent[] = [];
    void (async () => {
      for await (const ev of sub.events) seen.push(ev);
    })();
    await flush();
    const stream = h.requests()[0]!;
    stream.push(`${JSON.stringify({ id: stream.frame.id, result: { type: 'subscription_started' } })}\n`);
    await flush();

    const before = h.conns.length;
    stream.fail('ECONNRESET');
    await flush();
    expect(seen.at(-1)?.type).toBe('disconnected');
    expect(h.conns).toHaveLength(before);

    h.scheduler.advance(999);
    await flush();
    expect(h.conns).toHaveLength(before);

    h.scheduler.advance(1);
    await flush();
    // Po backoffie: ponowna bramka protokołu + NOWE połączenie strumienia.
    expect(h.conns.length).toBeGreaterThan(before);
    const reopened = h.requests().at(-1)!;
    expect(reopened).not.toBe(stream);
    expect(reopened.frame.method).toBe('events.subscribe');

    reopened.push(`${JSON.stringify({
      id: reopened.frame.id, result: { type: 'subscription_started' },
    })}\n`);
    await flush();
    expect(seen.filter((ev) => ev.type === 'connected')).toHaveLength(2);

    sub.close();
  });

  it('błąd po potwierdzeniu (`events_lost`) zrywa strumień z kodem w powodzie', async () => {
    // herdr ≥ 0.9.2: czytelnik za daleko w tyle dostaje błąd z id subskrypcji i EOF.
    const h = harness();
    const sub = h.socket.subscribe([{ type: 'pane.created' }]);
    const seen: HerdrStreamEvent[] = [];
    void (async () => {
      for await (const ev of sub.events) seen.push(ev);
    })();
    await flush();
    const stream = h.requests()[0]!;
    stream.push(`${JSON.stringify({ id: stream.frame.id, result: { type: 'subscription_started' } })}\n`);
    stream.push(`${JSON.stringify({
      id: stream.frame.id, error: { code: 'events_lost', message: 'subscriber fell behind' },
    })}\n`);
    await flush();

    expect(seen.map((ev) => ev.type)).toEqual(['connected', 'disconnected']);
    expect(seen.at(-1)).toEqual({
      type: 'disconnected',
      reason: { text: 'herdr dropped the subscription: events_lost', ref: { code: 'herdr.subscription-broken', args: ['events_lost'] } },
    });
    sub.close();
  });

  it('idzie przez TĘ SAMĄ allow-listę co `request()` — nie omija bramki', () => {
    /*
     * Nazwa metody strumienia jest w `subscribe()` literałem, więc jedyny sposób, żeby POKAZAĆ,
     * że bramka na tej ścieżce w ogóle stoi, to na moment zabrać jej `events.subscribe`.
     * Bez tej asercji deklaracja z nagłówka socket.ts („cały ruch przez dwie bramki") była
     * opisowa: allow-lista nie była na ścieżce subskrypcji wołana ani razu, a przyszła ramka
     * dołożona obok `request()` (keepalive, drugi parametr metody) wypadłaby spod niej po cichu.
     * Zbiór wraca w `finally` — inne testy w tym pliku czytają go jako stan modułu.
     */
    const h = harness();
    const live = ALLOWED_METHODS as Set<string>;
    live.delete(SUBSCRIBE_METHOD);
    try {
      expect(() => h.socket.subscribe([{ type: 'pane.created' }]))
        .toThrow(HerdrMethodNotAllowedError);
      // Zero bajtów: odrzucenie ma nastąpić PRZED otwarciem gniazda, tak jak w `request()`.
      expect(h.conns).toHaveLength(0);
    } finally {
      live.add(SUBSCRIBE_METHOD);
    }
  });

  it('brak potwierdzenia subskrypcji w 5 s zrywa połączenie zamiast wisieć', async () => {
    /*
     * half-open po `herdr update --handoff`: nowy proces przejmuje gniazdo, więc `connect`
     * się udaje, ale odpowiedzi nie ma i nie będzie. Bez strażnika PIERWSZEJ ramki Rarog
     * zostawał w `available: true`, bez ani jednego zdarzenia i bez rozłączenia — czyli
     * w stanie „wszystko gra", który był nieprawdą aż do restartu serwera.
     */
    const h = harness();
    const sub = h.socket.subscribe([{ type: 'pane.created' }]);
    const seen: HerdrStreamEvent[] = [];
    void (async () => {
      for await (const ev of sub.events) seen.push(ev);
    })();
    await flush();
    const stream = h.requests()[0]!;
    expect(stream.frame.method).toBe('events.subscribe');

    // Cisza. Zegar gniazda leci, herdr milczy.
    h.scheduler.advance(SUBSCRIBE_START_TIMEOUT_MS - 1);
    await flush();
    expect(seen).toEqual([]);

    h.scheduler.advance(1);
    await flush();
    expect(seen.at(-1)).toMatchObject({ type: 'disconnected' });
    expect(seen.at(-1)?.type === 'disconnected' && seen.at(-1)).toMatchObject({
      reason: { ref: { code: 'herdr.subscribe-timeout' } },
    });
    expect(stream.destroyed).toBe(true);
    // Dostępność spada — supervisor ma zobaczyć, że strumienia NIE MA.
    expect(h.socket.status().available).toBe(false);

    // I wraca reconnect po backoffie — cisza nie jest stanem końcowym.
    h.scheduler.advance(1_000);
    await flush();
    expect(h.requests().length).toBeGreaterThan(1);

    sub.close();
  });

  it('pierwsza ramka MUSI być `subscription_started` — inna to błąd protokołu', async () => {
    /*
     * Fail-closed. Wcześniej sprawdzane było
     * WYŁĄCZNIE pole `error`, więc dowolna pierwsza ramka uchodziła za potwierdzenie: Rarog
     * ogłaszał `connected`, robił pełny resync i czekał na zdarzenia, których ten strumień
     * nie miał prawa mu przysłać.
     */
    const h = harness();
    const sub = h.socket.subscribe([{ type: 'pane.created' }]);
    const seen: HerdrStreamEvent[] = [];
    void (async () => {
      for await (const ev of sub.events) seen.push(ev);
    })();
    await flush();
    const stream = h.requests()[0]!;
    stream.push(`${JSON.stringify({ id: stream.frame.id, result: { type: 'pong' } })}\n`);
    await flush();

    expect(seen.map((ev) => ev.type)).toEqual(['disconnected']);
    expect(stream.destroyed).toBe(true);
    sub.close();
  });

  it('potwierdzenie z OBCYM `id` też nie jest potwierdzeniem', async () => {
    const h = harness();
    const sub = h.socket.subscribe([{ type: 'pane.created' }]);
    const seen: HerdrStreamEvent[] = [];
    void (async () => {
      for await (const ev of sub.events) seen.push(ev);
    })();
    await flush();
    const stream = h.requests()[0]!;
    stream.push(`${JSON.stringify({
      id: 'rarog-sub-999', result: { type: 'subscription_started' },
    })}\n`);
    await flush();
    expect(seen.map((ev) => ev.type)).toEqual(['disconnected']);
    sub.close();
  });

  it('`close()` przerywa strumień i nie łączy się ponownie', async () => {
    const h = harness();
    const sub = h.socket.subscribe([{ type: 'pane.created' }]);
    void (async () => {
      for await (const _ of sub.events) { /* konsumujemy */ }
    })();
    await flush();
    const before = h.conns.length;
    sub.close();
    h.scheduler.advance(60_000);
    await flush();
    expect(h.conns).toHaveLength(before);
  });
});
