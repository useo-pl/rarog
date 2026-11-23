/**
 * Harmonogram powiadomień (`notify/index.ts`) — jedyny kawałek ze stanem i zegarem.
 *
 * Zegar i timery są wstrzykiwane w całości, więc „minuta ciszy" trwa tu zero milisekund.
 * Testy opisują CAŁE scenariusze z życia (wyszedłem, wróciłem, obejrzałem, agent ruszył dalej),
 * bo dopiero na nich widać, czy reguły i mechanika grają razem.
 */
import { describe, expect, it } from 'vitest';
import type { SessionState } from '@rarog/shared';
import { foreign } from '@rarog/shared/sentences';
import type { SmEvent } from '../src/sessions/state-machine.ts';
import { Notifier, DEGRADED_AFTER_FAILURES, PUSH_QUIET_LOG } from '../src/notify/index.ts';
import type { SessionLook } from '../src/notify/index.ts';
import { FIRST_CHECK_MS } from '../src/notify/policy.ts';
import type { TurnInput } from '../src/notify/policy.ts';
import { PRESENCE_GRACE_MS, Presence } from '../src/notify/presence.ts';
import type { PushContent, SendOutcome } from '../src/notify/content.ts';
import { createFanoutSink } from '../src/notify/fanout.ts';
import type { ChannelReport, ChannelSink, SendReport } from '../src/notify/fanout.ts';

const SESSION = 's1';

/** Sterowany zegar + kolejka timerów. Odpowiednik `vi.useFakeTimers`, ale tylko dla modułu. */
class Clock {
  now = 1_700_000_000_000;
  #next = 1;
  readonly #jobs = new Map<number, { at: number; cb: () => void }>();

  readonly set = (cb: () => void, ms: number): unknown => {
    const id = this.#next++;
    this.#jobs.set(id, { at: this.now + ms, cb });
    return id;
  };

  readonly clear = (handle: unknown): void => {
    this.#jobs.delete(handle as number);
  };

  /** Przesuwa czas, odpalając po drodze wszystko, co się należy — z domknięciem mikrozadań. */
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      let dueId: number | undefined;
      let dueAt = Infinity;
      for (const [id, job] of this.#jobs) {
        if (job.at <= target && job.at < dueAt) {
          dueAt = job.at;
          dueId = id;
        }
      }
      if (dueId === undefined) break;
      const job = this.#jobs.get(dueId);
      this.#jobs.delete(dueId);
      this.now = dueAt;
      job?.cb();
      // `#check` jest async (wysyłka) — bez tego asercje biegłyby przed sinkiem.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    this.now = target;
  }
}

interface Harness {
  readonly notifier: Notifier;
  readonly presence: Presence;
  readonly clock: Clock;
  readonly sent: PushContent[];
  /** KAŻDA treść, która doszła do sinka — także ta, której sink nie dostarczył. */
  readonly attempted: PushContent[];
  /** Linie logu decyzji (`options.log`). */
  readonly logs: string[];
  setState(state: SessionState): void;
  setSeen(seen: boolean): void;
  /** Ile zadań w tle pracuje w chwili SPRAWDZENIA (`SessionLook.backgroundTasks`). */
  setBackground(tasks: number): void;
  /** Czy w chwili SPRAWDZENIA subagent w postoju ma żywą własną komendę (`SessionLook.waitingOnOwnCommand`). */
  setOwnCommand(waiting: boolean): void;
}

interface SetupOptions {
  /** Wynik każdej wysyłki APNs; domyślnie `delivered`. */
  readonly outcome?: SendOutcome;
  /**
   * Pełny raport per kanał — gdy test mówi o kształcie raportu (np. bez kanału). Ma pierwszeństwo
   * przed `outcome`; `sent` liczy wtedy wysyłki, które doręczył którykolwiek kanał.
   */
  readonly report?: () => ChannelReport;
  /** Plakietka podawana harmonogramowi (leniwie, jak `managerRef` w `index.ts`). */
  readonly badge?: () => number;
  /**
   * Dźwięk kafla (`FanoutOptions.chime`). Z nim sink to PRAWDZIWY
   * `createFanoutSink` (jak w `server/src/index.ts`), a atrapą zostaje tylko sink APNs.
   */
  readonly chime?: () => number;
}

const setup = (options: SetupOptions = {}): Harness => {
  const clock = new Clock();
  const sent: PushContent[] = [];
  const attempted: PushContent[] = [];
  const logs: string[] = [];
  let look: SessionLook = { state: 'waiting-permission', seen: false, backgroundTasks: 0, waitingOnOwnCommand: false };

  /*
   * `onActive` jest tu wpięte tak samo jak w produkcji (`server/src/index.ts`) i to jest
   * warunek sensowności tych testów: powrót do Raroga kasuje czekające wysyłki WYŁĄCZNIE
   * dlatego, że ktoś te dwa moduły ze sobą połączył.
   */
  let notifierRef: Notifier | null = null;
  const presence = new Presence({
    now: () => clock.now,
    onActive: () => { notifierRef?.clearAll(); },
  });
  const sink: ChannelSink = options.chime === undefined
    ? {
      send(content: PushContent): Promise<SendReport> {
        const report = options.report?.() ?? { apns: options.outcome ?? 'delivered' };
        attempted.push(content);
        if (Object.values(report).includes('delivered')) sent.push(content);
        return Promise.resolve({ channels: report });
      },
    }
    : createFanoutSink({
      apns: {
        send(content: PushContent): Promise<SendOutcome> {
          const outcome = options.outcome ?? 'delivered';
          attempted.push(content);
          if (outcome === 'delivered') sent.push(content);
          return Promise.resolve(outcome);
        },
      },
      chime: options.chime,
    });
  const notifier = new Notifier({
    presence,
    sink,
    ...(options.badge === undefined ? {} : { badge: options.badge }),
    look: (id) => (id === SESSION ? look : undefined),
    log: (line) => { logs.push(line); },
    setTimeout: clock.set,
    clearTimeout: clock.clear,
  });
  notifierRef = notifier;

  return {
    notifier, presence, clock, sent, attempted, logs,
    setState: (state) => { look = { ...look, state }; },
    setSeen: (seen) => { look = { ...look, seen }; },
    setBackground: (tasks) => { look = { ...look, backgroundTasks: tasks }; },
    setOwnCommand: (waiting) => { look = { ...look, waitingOnOwnCommand: waiting }; },
  };
};

/** Zgłoszenie zgody — najczęstszy przypadek blokujący. */
const askPermission = (h: Harness): void => {
  h.notifier.note({
    sessionId: SESSION,
    event: { type: 'permission-requested' },
    backgroundTasks: 0,
    project: 'rarog',
    label: 'visuals',
    detail: foreign('Bash: pnpm test'),
  });
};

/**
 * Sprawa się ruszyła: agent podjął pracę. Zdarzenie o niczym nie zawiadamia (`classify` → null),
 * ale KASUJE pamięć wysyłki — bez niego kolejna zgoda w tej samej sesji i tym samym stanie jest
 * wyciszona jako „baner o tej sprawie już poszedł". Testy, których tematem jest LICZNIK porażek,
 * a nie dedup, muszą więc przeplatać zgody tym zdarzeniem — tak jak robi to życie.
 */
const agentResumed = (h: Harness): void => {
  h.notifier.note({
    sessionId: SESSION,
    event: { type: 'agent-working' },
    backgroundTasks: 0,
    project: 'rarog',
  });
};

/*
 * A full herdr server restart restores sessions through `claude --resume`, and the first `idle` of a restored
 * card looks like a turn end; one restart could send ~25 banners at once.
 */
/*
 * A short exit from Rarog is not leaving it. On an iPad in fullscreen the user switches to the terminal with ⌘Tab
 * for 2–24 s several times a minute, and without a grace period every turn ending in such a gap would play the
 * live activity chime.
 */
describe('karencja po wyjściu z Raroga — „gotowe” czeka minutę od ostatniej widoczności', () => {
  const doneTurn = (h: Harness): void => {
    h.setState('waiting-input');
    h.notifier.note({ sessionId: SESSION, event: { type: 'agent-idle' }, backgroundTasks: 0, project: 'rarog' });
  };

  it('tura skończona 10 s po wyjściu: nic po 15 s, baner po minucie od wyjścia', async () => {
    const h = setup();
    h.presence.note('ipad', { visible: true });
    h.presence.note('ipad', { visible: false });
    await h.clock.advance(10_000);
    doneTurn(h);
    expect(h.logs).toContain('push: armed done for rarog (check in 50 s, grace after leaving Rarog)');

    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(h.attempted).toHaveLength(0);
    await h.clock.advance(PRESENCE_GRACE_MS - 10_000 - FIRST_CHECK_MS.done);
    expect(h.sent.map((content) => content.kind)).toEqual(['done']);
  });

  it('powrót w karencji kasuje czekające „gotowe”: bez banera i bez dźwięku kafla', async () => {
    let chimes = 0;
    const h = setup({ chime: () => { chimes += 1; return 1; }, badge: () => 0 });
    h.presence.note('ipad', { visible: true });
    h.presence.note('ipad', { visible: false });
    doneTurn(h);
    await h.clock.advance(20_000);
    h.presence.note('ipad', { visible: true });
    expect(h.notifier.pending).toBe(0);

    await h.clock.advance(PRESENCE_GRACE_MS);
    expect(h.attempted).toHaveLength(0);
    expect(chimes).toBe(0);
  });

  it('tura skończona po karencji: zwykłe okno 15 s', async () => {
    const h = setup();
    h.presence.note('ipad', { visible: true });
    h.presence.note('ipad', { visible: false });
    await h.clock.advance(PRESENCE_GRACE_MS + 5_000);
    doneTurn(h);
    expect(h.logs).toContain('push: armed done for rarog (check in 15 s)');
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(h.sent).toHaveLength(1);
  });

  it('koniec karencji blisko: okno nie schodzi poniżej 15 s', async () => {
    const h = setup();
    h.presence.note('ipad', { visible: true });
    h.presence.note('ipad', { visible: false });
    await h.clock.advance(PRESENCE_GRACE_MS - 5_000);
    doneTurn(h);
    expect(h.logs).toContain('push: armed done for rarog (check in 15 s)');
  });

  it('zgoda w karencji nie czeka: baner po oknie klasy blokującej', async () => {
    const h = setup();
    h.presence.note('ipad', { visible: true });
    h.presence.note('ipad', { visible: false });
    askPermission(h);
    await h.clock.advance(FIRST_CHECK_MS.blocking + 1);
    expect(h.sent).toHaveLength(1);
  });
});

describe('powrót herdr — odtworzenie to nie koniec tury', () => {
  it('`agent-idle` odtworzonej karty nie uzbraja, loguje powód i gasi czekające', async () => {
    const h = setup();
    h.setState('waiting-input');
    // Coś już czekało na tę sesję — nowsze zdarzenie zawsze je unieważnia, także ciche.
    h.notifier.note({
      sessionId: SESSION, event: { type: 'agent-idle' }, backgroundTasks: 0, project: 'rarog',
    });
    h.notifier.note({
      sessionId: SESSION,
      event: { type: 'agent-idle' },
      backgroundTasks: 0,
      project: 'rarog',
      afterHerdrRestore: true,
    });
    await h.clock.advance(FIRST_CHECK_MS.done + 1);

    expect(h.sent).toHaveLength(0);
    expect(h.logs).toContain(`${PUSH_QUIET_LOG} rarog (done, herdr restore)`);
  });

  it('ta sama karta bez znacznika dostaje zwykły baner „Skończył"', async () => {
    const h = setup();
    h.setState('waiting-input');
    h.notifier.note({
      sessionId: SESSION, event: { type: 'agent-idle' }, backgroundTasks: 0, project: 'rarog',
    });
    await h.clock.advance(FIRST_CHECK_MS.done + 1);

    expect(h.sent).toHaveLength(1);
    expect(h.logs.some((line) => line.includes('herdr restore'))).toBe(false);
  });
});

/*
 * A session that is only starting does not end a turn. Counted in one day of `server.log`: 55 of 307
 * `starting → waiting-input` transitions would arm "done", 10 of them reaching the phone with the chime.
 */
describe('start sesji — wstanie to nie koniec tury', () => {
  const START_LOG = `${PUSH_QUIET_LOG} rarog (done, session start)`;

  it('pierwsze `idle` i tura zerowa po starcie: bez banera, bez dźwięku kafla, z powodem w logu', async () => {
    let chimes = 0;
    const h = setup({ chime: () => { chimes += 1; return 1; }, badge: () => 0 });
    h.setState('waiting-input');
    const starts: SmEvent[] = [{ type: 'agent-idle' }, { type: 'result', subtype: 'success' }];
    for (const event of starts) {
      h.notifier.note({ sessionId: SESSION, event, backgroundTasks: 0, project: 'rarog', afterStart: true });
      expect(h.notifier.pending).toBe(0);
    }
    await h.clock.advance(FIRST_CHECK_MS.done + 1);

    expect(h.attempted).toHaveLength(0);
    expect(chimes).toBe(0);
    expect(h.logs.filter((line) => line === START_LOG)).toHaveLength(2);
  });

  it('start nie zostawia zaległego „gotowe”, a pierwsza prawdziwa tura daje zwykły baner', async () => {
    const h = setup();
    h.setState('waiting-input');
    h.notifier.note({
      sessionId: SESSION, event: { type: 'agent-idle' }, backgroundTasks: 0, project: 'rarog', afterStart: true,
    });
    // Tura po samym postoju subagenta: bez zaległości cicha, więc start niczego nie zostawił.
    h.setState('running');
    h.notifier.note({ sessionId: SESSION, event: { type: 'agent-working' }, backgroundTasks: 0, project: 'rarog' });
    h.setState('waiting-input');
    h.notifier.note({
      sessionId: SESSION, event: { type: 'agent-idle' }, backgroundTasks: 0, project: 'rarog',
      turnInput: { standbyNotices: 1, artifactWatch: 0, other: 0, toolCalls: 0, compactions: 0 },
    });
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(h.sent).toHaveLength(0);

    h.setState('running');
    h.notifier.note({ sessionId: SESSION, event: { type: 'agent-working' }, backgroundTasks: 0, project: 'rarog' });
    h.setState('waiting-input');
    h.notifier.note({ sessionId: SESSION, event: { type: 'agent-idle' }, backgroundTasks: 0, project: 'rarog' });
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(h.sent.map((content) => content.kind)).toEqual(['done']);
  });

  it('dialog prosto ze startu dalej idzie: „Czeka w terminalu” po oknie klasy blokującej', async () => {
    const h = setup();
    h.setState('waiting-permission');
    h.notifier.note({
      sessionId: SESSION, event: { type: 'agent-blocked' }, backgroundTasks: 0, project: 'rarog', afterStart: true,
    });
    expect(h.notifier.pending).toBe(1);
    await h.clock.advance(FIRST_CHECK_MS.blocking + 1);
    expect(h.sent.map((content) => content.kind)).toEqual(['blocked']);
  });
});

/*
 * Subagent w postoju nie wstrzymuje „gotowe", więc koniec tury przy samym czekającym uzbraja
 * push. Subagent potrafi ruszyć sam w oknie 15 s — skończyła się jego komenda — a wtedy główna
 * sesja dalej stoi w `waiting-input` i żadne zdarzenie stanu nie przychodzi. Ponowna kontrola musi
 * to zobaczyć sama.
 */
describe('tło ruszyło między uzbrojeniem a wysyłką', () => {
  const turnEnded = (h: Harness): void => {
    h.setState('waiting-input');
    h.notifier.note({
      sessionId: SESSION, event: { type: 'agent-idle' }, backgroundTasks: 0, project: 'rarog',
    });
  };

  it('subagent wybudzony 5 s po końcu tury kasuje uzbrojone „gotowe" — z powodem w logu', async () => {
    const h = setup();
    turnEnded(h);
    expect(h.notifier.pending).toBe(1);
    await h.clock.advance(5_000);
    h.setBackground(1);
    await h.clock.advance(FIRST_CHECK_MS.done);

    expect(h.sent).toHaveLength(0);
    expect(h.notifier.pending).toBe(0);
    expect(h.logs).toContain(`${PUSH_QUIET_LOG} rarog (done, state=waiting-input, working in the background: 1)`);
  });

  it('tło, które dalej tylko czeka, niczego nie kasuje', async () => {
    const h = setup();
    turnEnded(h);
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.kind).toBe('done');
  });

  it('skasowany push nie zostawia pamięci wysyłki: następny koniec tury uzbraja od nowa', async () => {
    const h = setup();
    turnEnded(h);
    h.setBackground(1);
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(h.sent).toHaveLength(0);

    // Subagent znów stanął, a główny agent skończył kolejną turę.
    h.setBackground(0);
    turnEnded(h);
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(h.sent).toHaveLength(1);
  });

  it('dialog stojący przy pracującym tle wychodzi normalnie — tło gasi tylko „gotowe"', async () => {
    const h = setup();
    h.setBackground(2);
    askPermission(h);
    await h.clock.advance(FIRST_CHECK_MS.blocking + 1);
    expect(h.sent).toHaveLength(1);
    expect(h.logs.some((line) => line.includes('working in the background'))).toBe(false);
  });
});

/*
 * Tura głównego agenta wywołana WYŁĄCZNIE meldunkiem o postoju subagenta nie kończy
 * się pushem „gotowe". Manager podaje rachunek wiadomości `user` od poprzedniego końca tury,
 * reguła stoi w `policy.ts`, a harmonogram ma po takiej turze nie uzbroić niczego i zostawić ślad.
 */
describe('tura po samym postoju subagenta — cisza', () => {
  const turnEnded = (h: Harness, turnInput: TurnInput): void => {
    h.setState('waiting-input');
    h.notifier.note({
      sessionId: SESSION, event: { type: 'agent-idle' }, backgroundTasks: 0, project: 'rarog', turnInput,
    });
  };
  const STANDBY_LOG = `${PUSH_QUIET_LOG} rarog (done, turn after a subagent standby alone)`;

  it('sama notka o postoju: nic się nie uzbraja, nic nie wychodzi, log mówi dlaczego', async () => {
    const h = setup();
    turnEnded(h, { standbyNotices: 1, artifactWatch: 0, other: 0, toolCalls: 0, compactions: 0 });
    expect(h.notifier.pending).toBe(0);
    await h.clock.advance(FIRST_CHECK_MS.done + 1);

    expect(h.sent).toHaveLength(0);
    expect(h.logs).toEqual([STANDBY_LOG]);
  });

  it('dwie notki o postoju w jednej turze: dalej cisza', async () => {
    const h = setup();
    turnEnded(h, { standbyNotices: 2, artifactWatch: 0, other: 0, toolCalls: 0, compactions: 0 });
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(h.sent).toHaveLength(0);
    expect(h.logs).toContain(STANDBY_LOG);
  });

  it('27 takich tur z rzędu: zero pushy', async () => {
    const h = setup();
    for (let i = 0; i < 27; i += 1) {
      h.notifier.note({
        sessionId: SESSION, event: { type: 'agent-working' }, backgroundTasks: 0, project: 'rarog',
      });
      turnEnded(h, { standbyNotices: 1, artifactWatch: 0, other: 0, toolCalls: 0, compactions: 0 });
      await h.clock.advance(FIRST_CHECK_MS.done + 1);
    }
    expect(h.sent).toHaveLength(0);
    expect(h.logs.filter((line) => line === STANDBY_LOG)).toHaveLength(27);
  });

  it('notka o postoju i prompt człowieka (albo raport subagenta, albo koniec komendy): zwykłe „gotowe"', async () => {
    const h = setup();
    turnEnded(h, { standbyNotices: 1, artifactWatch: 0, other: 1, toolCalls: 0, compactions: 0 });
    expect(h.notifier.pending).toBe(1);
    await h.clock.advance(FIRST_CHECK_MS.done + 1);

    expect(h.sent.map((content) => content.kind)).toEqual(['done']);
    expect(h.logs).not.toContain(STANDBY_LOG);
  });

  it('notka o końcu komendy, bez postoju: zwykłe „gotowe"', async () => {
    const h = setup();
    turnEnded(h, { standbyNotices: 0, artifactWatch: 0, other: 1, toolCalls: 0, compactions: 0 });
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(h.sent).toHaveLength(1);
  });

  it('tura bez żadnej wiadomości `user` (zaplanowane wybudzenie): jak dotąd, „gotowe"', async () => {
    const h = setup();
    turnEnded(h, { standbyNotices: 0, artifactWatch: 0, other: 0, toolCalls: 0, compactions: 0 });
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(h.sent).toHaveLength(1);
    expect(h.logs).not.toContain(STANDBY_LOG);
  });

  it('notka o postoju, potem dialog zgody: push blokujący wychodzi normalnie', async () => {
    const h = setup();
    h.setState('waiting-permission');
    h.notifier.note({
      sessionId: SESSION, event: { type: 'permission-requested' }, backgroundTasks: 0, project: 'rarog',
      detail: foreign('Bash'), turnInput: { standbyNotices: 1, artifactWatch: 0, other: 0, toolCalls: 0, compactions: 0 },
    });
    await h.clock.advance(FIRST_CHECK_MS.blocking + 1);
    expect(h.sent.map((content) => content.kind)).toEqual(['permission']);
    expect(h.logs).not.toContain(STANDBY_LOG);
  });

  it('notka o postoju, potem błąd tury: push awaryjny wychodzi normalnie', async () => {
    const h = setup();
    h.setState('error');
    h.notifier.note({
      sessionId: SESSION, event: { type: 'result', subtype: 'error' }, backgroundTasks: 0, project: 'rarog',
      detail: foreign('Tura padła'), turnInput: { standbyNotices: 1, artifactWatch: 0, other: 0, toolCalls: 0, compactions: 0 },
    });
    await h.clock.advance(FIRST_CHECK_MS.failure + 1);
    expect(h.sent.map((content) => content.kind)).toEqual(['error']);
  });

  /*
   * A turn after a standby is still a NEWER event: its start clears what was waiting for this
   * session. The result of the real turn is not lost: it stays owed and goes out after the turn
   * with a standby alone.
   */
  it('meldunek o postoju w oknie 15 s zdejmuje uzbrojone „gotowe", a zaległość wychodzi po tej turze', async () => {
    const h = setup();
    turnEnded(h, { standbyNotices: 0, artifactWatch: 0, other: 1, toolCalls: 0, compactions: 0 });
    expect(h.notifier.pending).toBe(1);
    await h.clock.advance(5_000);
    h.notifier.note({
      sessionId: SESSION, event: { type: 'agent-working' }, backgroundTasks: 0, project: 'rarog',
    });
    expect(h.notifier.pending).toBe(0);
    turnEnded(h, { standbyNotices: 1, artifactWatch: 0, other: 0, toolCalls: 0, compactions: 0 });
    expect(h.notifier.pending).toBe(1);
    await h.clock.advance(FIRST_CHECK_MS.done + 1);

    expect(h.sent.map((content) => content.kind)).toEqual(['done']);
    expect(h.logs).not.toContain(STANDBY_LOG);
  });

  it('praca w tle ma pierwszeństwo jako powód ciszy: bez linii o postoju', async () => {
    const h = setup();
    h.setState('waiting-input');
    h.notifier.note({
      sessionId: SESSION, event: { type: 'agent-idle' }, backgroundTasks: 1, project: 'rarog',
      turnInput: { standbyNotices: 1, artifactWatch: 0, other: 0, toolCalls: 0, compactions: 0 },
    });
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(h.sent).toHaveLength(0);
    expect(h.logs).toEqual([]);
  });
});

/*
 * Owed "done". The rules "background work = silence" and "a turn after a standby alone = silence"
 * together would lose the result of an ordinary turn, with no banner for hours. The scheduler
 * remembers that a result is waiting and sends "done" after the first turn after which nothing
 * works in the background.
 */
describe('zaległe „gotowe"', () => {
  const STANDBY: TurnInput = { standbyNotices: 1, artifactWatch: 0, other: 0, toolCalls: 0, compactions: 0 };
  const HUMAN = { standbyNotices: 0, artifactWatch: 0, other: 1, toolCalls: 0, compactions: 0 };
  const STANDBY_LOG = `${PUSH_QUIET_LOG} rarog (done, turn after a subagent standby alone)`;
  const OWED_LOG = 'push: armed done for rarog (check in 15 s, owed after a turn with a subagent standby alone)';

  /** Start tury: zdarzenie ciche, zdejmuje to, co czekało. */
  const turnStarted = (h: Harness, resultSeen = false): void => {
    h.setState('running');
    h.notifier.note({
      sessionId: SESSION, event: { type: 'agent-working' }, backgroundTasks: 0, project: 'rarog',
      ...(resultSeen ? { resultSeen: true } : {}),
    });
  };
  /** Koniec tury z podanym rachunkiem i liczbą zadań pracujących w tle (także przy sprawdzeniu). */
  const turnEnded = (h: Harness, turnInput: typeof STANDBY, working = 0): void => {
    h.setState('waiting-input');
    h.setBackground(working);
    h.notifier.note({
      sessionId: SESSION, event: { type: 'agent-idle' }, backgroundTasks: working, project: 'rarog', turnInput,
    });
  };
  /** Cała tura po samym postoju: start, koniec, okno sprawdzenia. */
  const standbyTurn = async (h: Harness, working = 0): Promise<void> => {
    turnStarted(h);
    turnEnded(h, STANDBY, working);
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
  };

  it('tura przy pracującym tle, potem same postoje → jedno „gotowe" w pierwszej cichej chwili', async () => {
    const h = setup();
    // 21:18 — zwykła tura kończy się, w tle pracuje subagent: cisza, wynik zostaje zaległy.
    turnEnded(h, HUMAN, 1);
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    // Subagent staje i rusza na przemian; dopóki coś pracuje, cisza.
    await standbyTurn(h, 1);
    await standbyTurn(h, 1);
    expect(h.sent).toHaveLength(0);

    // 00:39 — pierwsza tura po postoju, po której w tle nic nie pracuje.
    await standbyTurn(h);
    expect(h.sent.map((content) => content.kind)).toEqual(['done']);
    expect(h.logs).toContain(OWED_LOG);

    // Kolejne postoje do rana: zaległość zgasła razem z wysyłką, więc znów cisza.
    for (let i = 0; i < 5; i += 1) await standbyTurn(h);
    expect(h.sent).toHaveLength(1);
    expect(h.logs.filter((line) => line === STANDBY_LOG)).toHaveLength(5);
  });

  it('sesja otwarta w Rarogu gasi zaległość: tura po postoju milczy', async () => {
    const h = setup();
    turnEnded(h, HUMAN, 1);
    h.notifier.seen(SESSION);
    await standbyTurn(h);

    expect(h.sent).toHaveLength(0);
    expect(h.logs).toContain(STANDBY_LOG);
  });

  it('wynik odebrany na Macu (znacznik sprzed startu tury) gasi zaległość', async () => {
    const h = setup();
    turnEnded(h, HUMAN, 1);
    turnStarted(h, true);
    turnEnded(h, STANDBY);
    await h.clock.advance(FIRST_CHECK_MS.done + 1);

    expect(h.sent).toHaveLength(0);
    expect(h.logs).toContain(STANDBY_LOG);
  });

  it('zaległe uzbrojone, a tło rusza przed wysyłką: zostaje zaległe do następnej cichej chwili', async () => {
    const h = setup();
    turnEnded(h, HUMAN, 1);
    turnStarted(h);
    turnEnded(h, STANDBY);
    expect(h.notifier.pending).toBe(1);
    h.setBackground(1);
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(h.sent).toHaveLength(0);

    await standbyTurn(h);
    expect(h.sent).toHaveLength(1);
  });

  it('patrzysz w Raroga w cichej chwili: cisza i zaległość gaśnie', async () => {
    const h = setup();
    turnEnded(h, HUMAN, 1);
    h.presence.note('ipad', { visible: true });
    await standbyTurn(h);
    expect(h.sent).toHaveLength(0);

    // Wyszedłeś z Raroga; kolejny postój nie ma już czego dosyłać.
    h.presence.note('ipad', { visible: false });
    await standbyTurn(h);
    expect(h.sent).toHaveLength(0);
    expect(h.logs).toContain(STANDBY_LOG);
  });

  it('zajrzenie do Raroga, gdy tło jeszcze pracuje, zaległości nie gasi', async () => {
    const h = setup();
    turnEnded(h, HUMAN, 1);
    // Lista pokazała sesję jako pracującą w tle; sesji nie otwarto.
    h.presence.note('ipad', { visible: true });
    h.presence.note('ipad', { visible: false });
    // Po karencji od wyjścia: to test zaległości, nie karencji.
    await h.clock.advance(PRESENCE_GRACE_MS);
    await standbyTurn(h);

    expect(h.sent).toHaveLength(1);
  });

  it('powrót do Raroga kasuje uzbrojone zaległe „gotowe" razem z zaległością', async () => {
    const h = setup();
    turnEnded(h, HUMAN, 1);
    turnStarted(h);
    turnEnded(h, STANDBY);
    expect(h.notifier.pending).toBe(1);
    h.presence.note('ipad', { visible: true });
    expect(h.notifier.pending).toBe(0);
    h.presence.note('ipad', { visible: false });

    await standbyTurn(h);
    expect(h.sent).toHaveLength(0);
  });

  /*
   * Uzbrojone „gotowe" nie dowodzi, że sesja jest cicha W CHWILI powrotu.
   * Subagent, który ruszył w oknie 15 s, nie zmienia stanu sesji; lista pokazuje ją jako pracującą.
   */
  it('powrót do Raroga, gdy tło ruszyło po uzbrojeniu: baner skasowany, zaległość zostaje', async () => {
    const h = setup();
    turnEnded(h, HUMAN);
    expect(h.notifier.pending).toBe(1);
    await h.clock.advance(5_000);
    h.setBackground(1);
    h.presence.note('ipad', { visible: true });
    expect(h.notifier.pending).toBe(0);
    h.presence.note('ipad', { visible: false });
    await h.clock.advance(PRESENCE_GRACE_MS);

    await standbyTurn(h);
    expect(h.sent.map((content) => content.kind)).toEqual(['done']);
  });

  it('pierwsze `idle` po powrocie herdr nie zostawia zaległości', async () => {
    const h = setup();
    h.setState('waiting-input');
    h.notifier.note({
      sessionId: SESSION, event: { type: 'agent-idle' }, backgroundTasks: 0, project: 'rarog',
      afterHerdrRestore: true,
    });
    await standbyTurn(h);
    expect(h.sent).toHaveLength(0);
  });

  it('zapomniana sesja nie zostawia zaległości', async () => {
    const h = setup();
    turnEnded(h, HUMAN, 1);
    h.notifier.forget(SESSION);
    await standbyTurn(h);
    expect(h.sent).toHaveLength(0);
  });

  it('wysłane „gotowe" zwykłej tury nie zostawia zaległości', async () => {
    const h = setup();
    turnEnded(h, HUMAN);
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(h.sent).toHaveLength(1);

    await standbyTurn(h);
    expect(h.sent).toHaveLength(1);
    expect(h.logs).toContain(STANDBY_LOG);
  });
});

/*
 * Owed "done" waits while a subagent in standby waits for its own command. Otherwise a turn with
 * a stage report ends by starting the next stage's subagent (silence, result owed), the subagent
 * stops at its own command, the notice wakes the main agent, which writes "the stage is still
 * running", and the owed "done" would go out falsely. Two moments: the turn end (`NoteInput`) and
 * the check before sending (`SessionLook`), because the command reaches the list after a file read
 * every 5 s.
 */
describe('zaległe „gotowe" czeka na subagenta z własną komendą', () => {
  const STANDBY = { standbyNotices: 1, artifactWatch: 0, other: 0, toolCalls: 0, compactions: 0 };
  const HUMAN = { standbyNotices: 0, artifactWatch: 0, other: 1, toolCalls: 0, compactions: 0 };
  const REPORT = { standbyNotices: 1, artifactWatch: 0, other: 1, toolCalls: 0, compactions: 0 };
  const HELD_LOG = `${PUSH_QUIET_LOG} rarog (done, turn after a subagent standby alone, owed waits: the subagent waits for its own command)`;
  const CHECK_LOG = `${PUSH_QUIET_LOG} rarog (done, state=waiting-input, owed waits: the subagent waits for its own command)`;
  const OWED_LOG = 'push: armed done for rarog (check in 15 s, owed after a turn with a subagent standby alone)';

  const turnStarted = (h: Harness): void => {
    h.setState('running');
    h.notifier.note({ sessionId: SESSION, event: { type: 'agent-working' }, backgroundTasks: 0, project: 'rarog' });
  };
  /** Koniec tury: rachunek, praca w tle i komenda agenta w postoju z chwili końca (także przy sprawdzeniu). */
  const turnEnded = (
    h: Harness, turnInput: typeof STANDBY, opts: { working?: number; ownCommand?: boolean } = {},
  ): void => {
    const working = opts.working ?? 0;
    const ownCommand = opts.ownCommand ?? false;
    h.setState('waiting-input');
    h.setBackground(working);
    h.setOwnCommand(ownCommand);
    h.notifier.note({
      sessionId: SESSION, event: { type: 'agent-idle' }, backgroundTasks: working, project: 'rarog', turnInput,
      ...(ownCommand ? { waitingOnOwnCommand: true } : {}),
    });
  };
  /** Cała tura z podanym rachunkiem i okno sprawdzenia. */
  const fullTurn = async (h: Harness, turnInput: typeof STANDBY, opts: { working?: number; ownCommand?: boolean } = {}): Promise<void> => {
    turnStarted(h);
    turnEnded(h, turnInput, opts);
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
  };
  /** Raport etapu z startem subagenta następnego etapu: zwykła tura przy pracującym tle → wynik zaległy. */
  const stageHandedOver = async (h: Harness): Promise<void> => {
    await fullTurn(h, REPORT, { working: 1 });
    expect(h.sent).toHaveLength(0);
  };

  it('tura po postoju przy agencie z komendą: nic się nie uzbraja, log mówi dlaczego, zaległość zostaje', async () => {
    const h = setup();
    await stageHandedOver(h);
    turnStarted(h);
    turnEnded(h, STANDBY, { ownCommand: true });
    expect(h.notifier.pending).toBe(0);
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(h.sent).toHaveLength(0);
    expect(h.logs).toContain(HELD_LOG);

    // Komenda się skończyła, agent usnął bez raportu, kolejny meldunek o postoju: zaległość dalej jest.
    await fullTurn(h, STANDBY);
    expect(h.sent.map((content) => content.kind)).toEqual(['done']);
    expect(h.logs).toContain(OWED_LOG);
  });

  it('kilka postojów z komendą z rzędu: zero pushy; raport subagenta (zwykła tura) → jedno „gotowe"', async () => {
    const h = setup();
    await stageHandedOver(h);
    for (let i = 0; i < 4; i += 1) await fullTurn(h, STANDBY, { ownCommand: true });
    expect(h.sent).toHaveLength(0);
    expect(h.logs.filter((line) => line === HELD_LOG)).toHaveLength(4);

    await fullTurn(h, REPORT);
    expect(h.sent.map((content) => content.kind)).toEqual(['done']);
  });

  it('bez komendy agenta: zaległe „gotowe" wychodzi jak dotąd', async () => {
    const h = setup();
    await stageHandedOver(h);
    await fullTurn(h, STANDBY);
    expect(h.sent.map((content) => content.kind)).toEqual(['done']);
    expect(h.logs).not.toContain(HELD_LOG);
  });

  it('prompt człowieka przy agencie z komendą: „gotowe" jak dotąd', async () => {
    const h = setup();
    await stageHandedOver(h);
    await fullTurn(h, HUMAN, { ownCommand: true });
    expect(h.sent.map((content) => content.kind)).toEqual(['done']);
  });

  it('bez zaległości tura po postoju milczy jak dotąd, z dawną linią logu', async () => {
    const h = setup();
    await fullTurn(h, STANDBY, { ownCommand: true });
    expect(h.sent).toHaveLength(0);
    expect(h.logs).toEqual([`${PUSH_QUIET_LOG} rarog (done, turn after a subagent standby alone)`]);
  });

  it('komenda pojawia się na liście w oknie 15 s: cisza przy sprawdzeniu, zaległość zostaje', async () => {
    const h = setup();
    await stageHandedOver(h);
    turnStarted(h);
    turnEnded(h, STANDBY);
    expect(h.notifier.pending).toBe(1);
    await h.clock.advance(5_000);
    // Odczyt pliku subagenta przyniósł jego komendę dopiero teraz.
    h.setOwnCommand(true);
    await h.clock.advance(FIRST_CHECK_MS.done);
    expect(h.sent).toHaveLength(0);
    expect(h.notifier.pending).toBe(0);
    expect(h.logs).toContain(CHECK_LOG);

    // Agent zostawił komendę i stoi dalej: następny postój (już bez komendy) wypuszcza zaległe.
    await fullTurn(h, STANDBY);
    expect(h.sent.map((content) => content.kind)).toEqual(['done']);
  });

  it('komenda w oknie 15 s, potem zwykła tura (raport subagenta): jedno „gotowe"', async () => {
    const h = setup();
    await stageHandedOver(h);
    turnStarted(h);
    turnEnded(h, STANDBY);
    h.setOwnCommand(true);
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(h.sent).toHaveLength(0);

    await fullTurn(h, REPORT);
    expect(h.sent.map((content) => content.kind)).toEqual(['done']);
  });

  it('zwykłe „gotowe" przy sprawdzeniu bez zmian: komenda agenta, która pojawiła się w oknie, go nie gasi', async () => {
    const h = setup();
    turnStarted(h);
    turnEnded(h, HUMAN);
    h.setOwnCommand(true);
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(h.sent.map((content) => content.kind)).toEqual(['done']);
  });

  it('powrót do Raroga przy uzbrojonym zaległym, gdy agent ma już komendę: baner skasowany, zaległość zostaje', async () => {
    const h = setup();
    await stageHandedOver(h);
    turnStarted(h);
    turnEnded(h, STANDBY);
    expect(h.notifier.pending).toBe(1);
    h.setOwnCommand(true);
    h.presence.note('ipad', { visible: true });
    expect(h.notifier.pending).toBe(0);
    h.presence.note('ipad', { visible: false });
    await h.clock.advance(PRESENCE_GRACE_MS);

    await fullTurn(h, STANDBY);
    expect(h.sent.map((content) => content.kind)).toEqual(['done']);
  });
});

/*
 * A turn after a notice about the end of artifact observation alone, in which the agent used no
 * tool, is a turn without a result, like a turn after a standby alone. Removing an artifact on
 * claude.ai sends such a notice, and the agent only replies that there is nothing to do.
 */
describe('tura po samym meldunku o artefakcie — cisza', () => {
  const turn = (patch: Partial<TurnInput>): TurnInput => ({
    standbyNotices: 0, artifactWatch: 0, other: 0, toolCalls: 0, compactions: 0, ...patch,
  });
  const ARTIFACT = turn({ artifactWatch: 1 });
  const ARTIFACT_LOG = `${PUSH_QUIET_LOG} rarog (done, turn after an artifact task notification alone)`;
  const OWED_LOG = 'push: armed done for rarog (check in 15 s, owed after a turn with an artifact task notification alone)';

  const turnStarted = (h: Harness): void => {
    h.setState('running');
    h.notifier.note({ sessionId: SESSION, event: { type: 'agent-working' }, backgroundTasks: 0, project: 'rarog' });
  };
  const turnEnded = (h: Harness, turnInput: TurnInput, opts: { working?: number; ownCommand?: boolean } = {}): void => {
    const working = opts.working ?? 0;
    h.setState('waiting-input');
    h.setBackground(working);
    h.setOwnCommand(opts.ownCommand ?? false);
    h.notifier.note({
      sessionId: SESSION, event: { type: 'agent-idle' }, backgroundTasks: working, project: 'rarog', turnInput,
      ...(opts.ownCommand === true ? { waitingOnOwnCommand: true } : {}),
    });
  };
  const fullTurn = async (
    h: Harness, turnInput: TurnInput, opts: { working?: number; ownCommand?: boolean } = {},
  ): Promise<void> => {
    turnStarted(h);
    turnEnded(h, turnInput, opts);
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
  };

  it('sam meldunek, odpowiedź bez narzędzi: nic się nie uzbraja, log mówi dlaczego, bez zaległości', async () => {
    const h = setup();
    await fullTurn(h, ARTIFACT);
    expect(h.sent).toHaveLength(0);
    expect(h.logs).toEqual([ARTIFACT_LOG]);
    // Zaległości nie zapaliła: cisza w tle bez tury nie ma czego wypuścić.
    h.notifier.quiet(SESSION);
    expect(h.notifier.pending).toBe(0);
  });

  it('agent po meldunku użył narzędzia: zwykłe „gotowe"', async () => {
    const h = setup();
    await fullTurn(h, turn({ artifactWatch: 1, toolCalls: 2 }));
    expect(h.sent.map((content) => content.kind)).toEqual(['done']);
    expect(h.logs).not.toContain(ARTIFACT_LOG);
  });

  it('meldunek i prompt człowieka: zwykłe „gotowe"', async () => {
    const h = setup();
    await fullTurn(h, turn({ artifactWatch: 1, other: 1 }));
    expect(h.sent.map((content) => content.kind)).toEqual(['done']);
  });

  it('meldunek i postój subagenta bez narzędzi: cisza z linią o obu', async () => {
    const h = setup();
    await fullTurn(h, turn({ artifactWatch: 1, standbyNotices: 1 }));
    expect(h.sent).toHaveLength(0);
    expect(h.logs).toEqual([`${PUSH_QUIET_LOG} rarog (done, turn after an artifact task notification and a subagent standby alone)`]);
  });

  it('zaległe „gotowe" zwykłej tury wychodzi po takiej turze, jak po turze z samym postojem', async () => {
    const h = setup();
    // Zwykła tura przy pracującym tle: cisza, wynik zaległy.
    await fullTurn(h, turn({ other: 1 }), { working: 1 });
    expect(h.sent).toHaveLength(0);
    turnStarted(h);
    turnEnded(h, ARTIFACT);
    expect(h.logs).toContain(OWED_LOG);
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(h.sent.map((content) => content.kind)).toEqual(['done']);
  });

  it('…a przy subagencie z własną komendą czeka dalej, jak po turze z samym postojem', async () => {
    const h = setup();
    await fullTurn(h, turn({ other: 1 }), { working: 1 });
    await fullTurn(h, ARTIFACT, { ownCommand: true });
    expect(h.sent).toHaveLength(0);
    expect(h.logs).toContain(
      `${PUSH_QUIET_LOG} rarog (done, turn after an artifact task notification alone, owed waits: the subagent waits for its own command)`,
    );
    // Zaległość została: najbliższa zwykła tura ją wypuszcza.
    await fullTurn(h, turn({ standbyNotices: 1, other: 1 }));
    expect(h.sent.map((content) => content.kind)).toEqual(['done']);
  });

  it('rachunek niepełny (brak `turnInput`): zwykłe „gotowe"', async () => {
    const h = setup();
    turnStarted(h);
    h.setState('waiting-input');
    h.notifier.note({ sessionId: SESSION, event: { type: 'agent-idle' }, backgroundTasks: 0, project: 'rarog' });
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(h.sent.map((content) => content.kind)).toEqual(['done']);
  });
});

/*
 * Zaległe „gotowe" wychodzi też przy ciszy w tle bez
 * końca tury. Manager woła `quiet`, gdy lista zadań przestała je wstrzymywać (`holdsOwedDone`
 * w `work.ts`); harmonogram uzbraja z treści zapamiętanej przy końcu zwykłej tury, w oknie 15 s,
 * z kontrolą przy wysyłce jak po turze z samym postojem. Tu atrapa listy to `setBackground`
 * i `setOwnCommand` (co widzi `look`), a spadek warunku — samo wywołanie `quiet`.
 */
describe('zaległe „gotowe" przy ciszy w tle bez tury', () => {
  const STANDBY = { standbyNotices: 1, artifactWatch: 0, other: 0, toolCalls: 0, compactions: 0 };
  const REPORT = { standbyNotices: 1, artifactWatch: 0, other: 1, toolCalls: 0, compactions: 0 };
  // Bez etykiety sesji: przy braku szczegółu etykieta jest całą treścią banera.
  const ARMED_LOG = 'push: armed done for rarog (check in 15 s, owed after the background went quiet)';
  const WOKE_LOG = `${PUSH_QUIET_LOG} rarog (done, state=waiting-input, working in the background: 1)`;

  const turnStarted = (h: Harness): void => {
    h.setState('running');
    h.notifier.note({ sessionId: SESSION, event: { type: 'agent-working' }, backgroundTasks: 0, project: 'rarog' });
  };
  /** Koniec tury; lista z tej chwili zostaje też dla sprawdzenia (`look`). */
  const turnEnded = (
    h: Harness, turnInput: typeof STANDBY, opts: { working?: number; ownCommand?: boolean } = {},
  ): void => {
    const working = opts.working ?? 0;
    const ownCommand = opts.ownCommand ?? false;
    h.setState('waiting-input');
    h.setBackground(working);
    h.setOwnCommand(ownCommand);
    h.notifier.note({
      sessionId: SESSION, event: { type: 'agent-idle' }, backgroundTasks: working, project: 'rarog',
      label: 'visuals', detail: foreign('Etap 2 gotowy, etap 3 ruszył.'), termId: 'term-1', turnInput,
      ...(ownCommand ? { waitingOnOwnCommand: true } : {}),
    });
  };
  /** Raport etapu ze startem subagenta następnego etapu: zwykła tura przy pracującym tle → wynik zaległy. */
  const stageHandedOver = async (h: Harness): Promise<void> => {
    turnStarted(h);
    turnEnded(h, REPORT, { working: 1 });
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(h.sent).toHaveLength(0);
  };
  /** Lista przestała wstrzymywać: subagent stoi w postoju bez komendy, nic nie pracuje. */
  const listWentQuiet = (h: Harness): void => {
    h.setBackground(0);
    h.setOwnCommand(false);
    h.notifier.quiet(SESSION);
  };

  it('spadek warunku w karencji po wyjściu z Raroga: zaległe „gotowe” po minucie od wyjścia', async () => {
    const h = setup();
    await stageHandedOver(h);
    h.presence.note('ipad', { visible: true });
    h.presence.note('ipad', { visible: false });
    await h.clock.advance(20_000);
    listWentQuiet(h);
    expect(h.logs).toContain(
      'push: armed done for rarog (check in 40 s, grace after leaving Rarog, owed after the background went quiet)',
    );
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(h.sent).toHaveLength(0);
    await h.clock.advance(40_000 - FIRST_CHECK_MS.done);
    expect(h.sent.map((content) => content.kind)).toEqual(['done']);
  });

  it('spadek warunku przy zaległości → „gotowe" po 15 s, z treścią tury, która zostawiła wynik', async () => {
    const h = setup();
    await stageHandedOver(h);
    listWentQuiet(h);
    expect(h.notifier.pending).toBe(1);
    expect(h.logs).toContain(ARMED_LOG);
    await h.clock.advance(FIRST_CHECK_MS.done - 1);
    expect(h.sent).toHaveLength(0);
    await h.clock.advance(2);

    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ kind: 'done', sessionId: SESSION, termId: 'term-1' });
    expect(h.sent[0]?.body).toContain('Etap 2 gotowy');
    // Wysłane gasi zaległość: kolejna cisza i kolejna tura po postoju milczą.
    listWentQuiet(h);
    expect(h.notifier.pending).toBe(0);
    turnStarted(h);
    turnEnded(h, STANDBY);
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(h.sent).toHaveLength(1);
  });

  it('spadek, a subagent wstaje w oknie (wybudzenie po ticku) → cisza, zaległość zostaje; raport → jedno „gotowe"', async () => {
    const h = setup();
    await stageHandedOver(h);
    listWentQuiet(h);
    await h.clock.advance(5_000);
    h.setBackground(1);
    await h.clock.advance(FIRST_CHECK_MS.done);
    expect(h.sent).toHaveLength(0);
    expect(h.notifier.pending).toBe(0);
    expect(h.logs).toContain(WOKE_LOG);

    // Agent pracuje, oddaje raport, główny agent kończy zwykłą turę przy cichym tle.
    turnStarted(h);
    turnEnded(h, REPORT);
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(h.sent.map((content) => content.kind)).toEqual(['done']);
  });

  it('spadek, a w oknie subagent w postoju dostaje własną komendę → cisza z powodem, zaległość zostaje', async () => {
    const h = setup();
    await stageHandedOver(h);
    listWentQuiet(h);
    h.setOwnCommand(true);
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(h.sent).toHaveLength(0);
    expect(h.logs).toContain(
      `${PUSH_QUIET_LOG} rarog (done, state=waiting-input, owed waits: the subagent waits for its own command)`);

    // Komenda się skończyła, agent usnął: następny spadek wypuszcza zaległe.
    listWentQuiet(h);
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(h.sent.map((content) => content.kind)).toEqual(['done']);
  });

  it('spadek bez zaległości → nic, bez linii logu', () => {
    const h = setup();
    h.setState('waiting-input');
    listWentQuiet(h);
    expect(h.notifier.pending).toBe(0);
    expect(h.logs).toEqual([]);
  });

  it('spadek, gdy patrzysz w Raroga → nic i zaległość gaśnie (jak przy cichej sesji)', async () => {
    const h = setup();
    await stageHandedOver(h);
    h.presence.note('ipad', { visible: true });
    listWentQuiet(h);
    expect(h.notifier.pending).toBe(0);
    expect(h.logs).toContain(`${PUSH_QUIET_LOG} rarog (done, owed after the background went quiet, you are watching Rarog)`);

    h.presence.note('ipad', { visible: false });
    listWentQuiet(h);
    turnStarted(h);
    turnEnded(h, STANDBY);
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(h.sent).toHaveLength(0);
  });

  it('spadek przy odebranym wyniku (znacznik `seen` karty) → nic i zaległość gaśnie', async () => {
    const h = setup();
    await stageHandedOver(h);
    h.setSeen(true);
    listWentQuiet(h);
    expect(h.notifier.pending).toBe(0);
    expect(h.logs).toContain(`${PUSH_QUIET_LOG} rarog (done, owed after the background went quiet, result seen)`);
    h.setSeen(false);
    listWentQuiet(h);
    expect(h.notifier.pending).toBe(0);
  });

  it('spadek w trakcie tury → nic, bez linii logu; zaległość wychodzi po jej końcu', async () => {
    const h = setup();
    await stageHandedOver(h);
    const before = h.logs.length;
    turnStarted(h);
    listWentQuiet(h);
    expect(h.notifier.pending).toBe(0);
    expect(h.logs).toHaveLength(before);

    turnEnded(h, STANDBY);
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(h.sent.map((content) => content.kind)).toEqual(['done']);
  });

  it('start tury w oknie zdejmuje uzbrojenie; zaległość zostaje do jej końca', async () => {
    const h = setup();
    await stageHandedOver(h);
    listWentQuiet(h);
    expect(h.notifier.pending).toBe(1);
    await h.clock.advance(1_500);
    turnStarted(h);
    expect(h.notifier.pending).toBe(0);
    await h.clock.advance(FIRST_CHECK_MS.done);
    expect(h.sent).toHaveLength(0);

    turnEnded(h, STANDBY);
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(h.sent.map((content) => content.kind)).toEqual(['done']);
  });

  it('przerwanie z Raroga (Esc) gasi zaległość: późniejsza cisza w tle nic nie uzbraja', async () => {
    const h = setup();
    await stageHandedOver(h);
    turnStarted(h);
    h.setState('waiting-input');
    h.notifier.note({ sessionId: SESSION, event: { type: 'interrupt-requested' }, backgroundTasks: 1, project: 'rarog' });
    listWentQuiet(h);
    expect(h.notifier.pending).toBe(0);
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(h.sent).toHaveLength(0);
  });

  it('sesja zamknięta albo z nową rozmową silnika (`forget`) → nic', async () => {
    const h = setup();
    await stageHandedOver(h);
    h.notifier.forget(SESSION);
    listWentQuiet(h);
    expect(h.notifier.pending).toBe(0);
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(h.sent).toHaveLength(0);
  });

  it('sesji już nie ma (`look` bez karty) → nic i zaległość gaśnie', () => {
    const h = setup();
    h.notifier.note({
      sessionId: 'zniknela', event: { type: 'agent-idle' }, backgroundTasks: 1, project: 'rarog',
      turnInput: REPORT,
    });
    h.notifier.quiet('zniknela');
    expect(h.notifier.pending).toBe(0);
  });

  it('dwa spadki z rzędu → jedno uzbrojenie i jeden baner', async () => {
    const h = setup();
    await stageHandedOver(h);
    listWentQuiet(h);
    await h.clock.advance(3_000);
    listWentQuiet(h);
    expect(h.notifier.pending).toBe(1);
    expect(h.logs.filter((line) => line === ARMED_LOG)).toHaveLength(1);
    await h.clock.advance(FIRST_CHECK_MS.done);
    expect(h.sent).toHaveLength(1);
  });

  it('„gotowe" uzbrojone końcem tury już czeka → bez dubla i bez drugiej linii', async () => {
    const h = setup();
    turnStarted(h);
    turnEnded(h, REPORT);
    expect(h.notifier.pending).toBe(1);
    listWentQuiet(h);
    expect(h.notifier.pending).toBe(1);
    expect(h.logs.some((line) => line.includes('owed after the background went quiet'))).toBe(false);
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(h.sent).toHaveLength(1);
  });

  it('powrót do Raroga kasuje uzbrojenie z ciszy razem z zaległością', async () => {
    const h = setup();
    await stageHandedOver(h);
    listWentQuiet(h);
    h.presence.note('ipad', { visible: true });
    expect(h.notifier.pending).toBe(0);
    h.presence.note('ipad', { visible: false });
    listWentQuiet(h);
    expect(h.notifier.pending).toBe(0);
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(h.sent).toHaveLength(0);
  });
});

describe('nie ma mnie w Rarogu — powiadomienie wychodzi', () => {
  it('zgoda czeka, minęło okno, cisza → push', async () => {
    const h = setup();
    askPermission(h);
    expect(h.sent).toHaveLength(0);

    await h.clock.advance(FIRST_CHECK_MS.blocking + 1);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.title).toBe('⏳ Waiting for permission · rarog');
    expect(h.sent[0]?.body).toBe('Bash: pnpm test — visuals');
    // Tap w baner = TA sesja (cała wartość pusha); adres składa już kanał.
    expect(h.sent[0]).toMatchObject({ kind: 'permission', sessionId: SESSION });
  });

  /**
   * TEST OBOWIĄZKOWY. `termId` musi przejść CAŁY łańcuch — `note()`
   * → kolejka czekających → `buildContent` — bo baner wpisu Codexa ma prowadzić tam, gdzie
   * prowadzi jego wiersz w sidebarze. Adres składa się w chwili wysyłki, czyli o kilka sekund
   * później niż zdarzenie: gdyby pole gubiło się w kolejce, test treści tego nie zobaczyłby.
   */
  it('`termId` przechodzi przez kolejkę i przestawia adres banera na terminal', async () => {
    const h = setup();
    const term = 'a1b2c3d4e5f60718';
    h.notifier.note({
      sessionId: SESSION,
      event: { type: 'permission-requested' },
      backgroundTasks: 0,
      project: 'rarog',
      termId: term,
    });
    await h.clock.advance(FIRST_CHECK_MS.blocking + 1);
    expect(h.sent[0]).toMatchObject({ sessionId: SESSION, termId: term });
  });

  /*
   * Plakietka jest czytana w chwili WYSYŁKI, nie zdarzenia: w oknie 3 s mogła dojść druga
   * sprawa, a plakietka ma pokazywać to, co człowiek zastanie po otwarciu apki.
   */
  it('plakietka na ikonie liczona jest w chwili wysyłki, przez leniwe wywołanie', async () => {
    let waiting = 1;
    const h = setup({ badge: () => waiting });
    askPermission(h);
    waiting = 2;
    await h.clock.advance(FIRST_CHECK_MS.blocking + 1);
    expect(h.sent[0]?.badge).toBe(2);
  });

  it('bez źródła plakietki push jej nie rusza', async () => {
    const h = setup();
    askPermission(h);
    await h.clock.advance(FIRST_CHECK_MS.blocking + 1);
    expect(h.sent[0]).not.toHaveProperty('badge');
  });

  it('żadna klasa nie dzwoni natychmiast', () => {
    const h = setup();
    askPermission(h);
    expect(h.sent).toHaveLength(0);
    expect(h.notifier.pending).toBe(1);
  });
});

describe('patrzę w Raroga — cisza', () => {
  /*
   * To jest cały powód przeprowadzki z hooków. Hook liczył obecność z atime tty, więc praca
   * w PWA na telefonie była dla niego NIEOBECNOŚCIĄ i push leciał do kogoś, kto patrzył na tę
   * samą sesję na ekranie.
   */
  it('apka otwarta w chwili zdarzenia → nic się nawet nie uzbraja', () => {
    const h = setup();
    h.presence.note('telefon', { visible: true });
    askPermission(h);

    // Not "arm and check later" but "you see it, so silence".
    expect(h.notifier.pending).toBe(0);
  });

  it('obecność na iPADZIE ucisza telefon — liczy się łącznie', () => {
    const h = setup();
    h.presence.note('ipad', { visible: true });
    h.presence.note('telefon', { visible: false });
    askPermission(h);
    expect(h.notifier.pending).toBe(0);
  });

  /*
   * Opening Rarog shows a list with the state of EVERY session at once, so there is nothing to
   * send later.
   */
  it('POWRÓT do Raroga kasuje wszystkie czekające wysyłki', async () => {
    const h = setup();
    askPermission(h);
    expect(h.notifier.pending).toBe(1);

    h.presence.note('telefon', { visible: true });
    expect(h.notifier.pending).toBe(0);

    await h.clock.advance(FIRST_CHECK_MS.blocking + 1);
    expect(h.sent).toHaveLength(0);
  });

  it('samo odświeżenie obecności nie kasuje niczego — kasuje POWRÓT', async () => {
    const h = setup();
    h.presence.note('telefon', { visible: false });
    askPermission(h);
    // Klient dalej melduje „w tle": to nie jest powrót, więc sprawa ma przeżyć.
    h.presence.note('telefon', { visible: false });
    expect(h.notifier.pending).toBe(1);

    await h.clock.advance(FIRST_CHECK_MS.blocking + 1);
    expect(h.sent).toHaveLength(1);
  });

  it('wróciłeś i znowu wyszedłeś — stara sprawa NIE wraca', async () => {
    const h = setup();
    askPermission(h);
    h.presence.note('telefon', { visible: true });
    h.presence.note('telefon', { visible: false });

    await h.clock.advance(FIRST_CHECK_MS.blocking + 1);
    expect(h.sent).toHaveLength(0);
  });
});

describe('sprawa przestała być aktualna', () => {
  it('zgoda rozstrzygnięta w terminalu, zanim minęło okno → cisza', async () => {
    const h = setup();
    askPermission(h);
    h.setState('running');

    await h.clock.advance(FIRST_CHECK_MS.blocking + 1);
    expect(h.sent).toHaveLength(0);
    expect(h.notifier.pending).toBe(0);
  });

  it('otwarty transkrypt tej sesji gasi jej powiadomienie', async () => {
    const h = setup();
    askPermission(h);
    h.presence.note('telefon', { visible: true, sessionId: SESSION });

    await h.clock.advance(FIRST_CHECK_MS.blocking + 1);
    expect(h.sent).toHaveLength(0);
    expect(h.notifier.pending).toBe(0);
  });

  /*
   * OPENING Rarog anywhere clears everything, because the list shows the state of every session
   * at once.
   */
  it('otwarcie Raroga na INNEJ sesji też kasuje tę sprawę', async () => {
    const h = setup();
    askPermission(h);
    h.presence.note('telefon', { visible: true, sessionId: 'inna' });

    expect(h.notifier.pending).toBe(0);
    await h.clock.advance(FIRST_CHECK_MS.blocking + 1);
    expect(h.sent).toHaveLength(0);
  });

  /*
   * `SessionLook.seen` is a STICKY herdr marker "the previous RESULT was received in the
   * terminal", not "this matter is handled". It lights up when the pane goes from `done` to
   * `idle` and stays on for the whole next turn, so a dialog that stopped in that turn would be
   * cleared silently. It counts only for the "done" class.
   */
  it('„wynik odebrany w terminalu" NIE gasi stojącego dialogu', async () => {
    const h = setup();
    askPermission(h);
    h.setSeen(true);

    await h.clock.advance(FIRST_CHECK_MS.blocking + 1);
    expect(h.sent).toHaveLength(1);
  });

  it('„wynik odebrany w terminalu" gasi za to samo „gotowe"', async () => {
    const h = setup();
    h.setState('waiting-input');
    h.notifier.note({
      sessionId: SESSION,
      event: { type: 'agent-idle' },
      backgroundTasks: 0,
      project: 'rarog',
      label: 'visuals',
    });
    h.setSeen(true);

    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(h.sent).toHaveLength(0);
  });

  it('potwierdzenie z Raroga gasi sprawę natychmiast, bez czekania na okno', () => {
    const h = setup();
    askPermission(h);
    h.notifier.seen(SESSION);
    expect(h.notifier.pending).toBe(0);
  });

  it('zniknięcie sesji nie zostawia wiszącego timera', async () => {
    const h = setup();
    askPermission(h);
    h.notifier.forget(SESSION);
    await h.clock.advance(FIRST_CHECK_MS.done + 2);
    expect(h.sent).toHaveLength(0);
  });
});

describe('nowsze zdarzenie przejmuje sprawę', () => {
  /*
   * Bez tego pętla, która się skończyła, dałaby tyle powiadomień, ile odroczeń zdążyło
   * wystartować — każde obudziłoby się po niej i każde zobaczyłoby ten sam stan końcowy.
   * W hookach wymagało to jawnego tokenu; tutaj jest własnością struktury (jeden wpis na sesję).
   */
  it('jedna sesja ma najwyżej jedno czekające powiadomienie', () => {
    const h = setup();
    askPermission(h);
    askPermission(h);
    askPermission(h);
    expect(h.notifier.pending).toBe(1);
  });

  it('ciche zdarzenie też unieważnia starsze czekające', async () => {
    const h = setup();
    askPermission(h);
    // Człowiek rozstrzygnął zgodę w terminalu — zdarzenie samo w sobie ciche.
    h.notifier.note({
      sessionId: SESSION,
      event: { type: 'permission-resolved' },
      backgroundTasks: 0,
      project: 'rarog',
    });
    expect(h.notifier.pending).toBe(0);

    await h.clock.advance(FIRST_CHECK_MS.blocking + 1);
    expect(h.sent).toHaveLength(0);
  });

  it('nowsze zdarzenie zastępuje klasę i restartuje okno', async () => {
    const h = setup();
    h.notifier.note({
      sessionId: SESSION,
      event: { type: 'result', subtype: 'success' },
      backgroundTasks: 0,
      project: 'rarog',
    });
    h.setState('waiting-input');

    // Zanim minie długie okno „skończonego", agent prosi o zgodę.
    await h.clock.advance(FIRST_CHECK_MS.done - 5_000);
    askPermission(h);
    h.setState('waiting-permission');

    await h.clock.advance(FIRST_CHECK_MS.blocking + 1);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.title).toBe('⏳ Waiting for permission · rarog');
  });
});

describe('koniec tury ≠ koniec pracy', () => {
  it('tura domknięta przy żywym workflow nie uzbraja niczego', () => {
    const h = setup();
    h.notifier.note({
      sessionId: SESSION,
      event: { type: 'result', subtype: 'success' },
      backgroundTasks: 2,
      project: 'rarog',
    });
    expect(h.notifier.pending).toBe(0);
  });

  it('„skończone" bez tła czeka DŁUŻEJ niż sprawa blokująca', async () => {
    const h = setup();
    h.notifier.note({
      sessionId: SESSION,
      event: { type: 'agent-idle' },
      backgroundTasks: 0,
      project: 'rarog',
      detail: foreign('Poprawiłem layout nagłówka.'),
    });
    h.setState('waiting-input');

    await h.clock.advance(FIRST_CHECK_MS.blocking + 1);
    expect(h.sent).toHaveLength(0);

    await h.clock.advance(FIRST_CHECK_MS.done);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.title).toBe('✅ Done · rarog');
  });

  /**
   * Tura zaczęta na panelu SFOKUSOWANYM w herdr.
   *
   * herdr nie stawia wtedy badge'a `done`, tylko zostaje na `idle`. Gdyby manager przepisywał
   * to wprost na `seen: true`, w oknie `FIRST_CHECK_MS.done` (15 s) `look` oddawałby
   * harmonogramowi „wynik odebrany" i baner „Skończył" NIGDY by nie wyszedł.
   *
   * Harmonogram czyta `look` DOPIERO przy sprawdzeniu, więc test pokazuje obie strony tej
   * pary: co robi `seen` zapalony w oknie odroczenia (gałąź a) i co robi jego brak (gałąź b —
   * dzisiejszy manager). Że manager `seen` po
   * herdrowym `idle` nie zapala, pilnuje `manager-herdr.test.ts` („herdrowe `idle` PO turze
   * … nie odbiera wyniku”) — tam jest maszyna, tutaj kontrakt z harmonogramem.
   */
  it('wynik tury z panelu sfokusowanego w herdr WYCHODZI banerem', async () => {
    const note = (h: Harness): void => {
      h.notifier.note({
        sessionId: SESSION,
        event: { type: 'result', subtype: 'success' },
        backgroundTasks: 0,
        project: 'rarog',
        detail: foreign('Poprawiłem layout nagłówka.'),
      });
    };

    // a) `seen` zapalony ZANIM minie okno „skończonego" gasi baner — to była cena lustra herdr.
    const lustro = setup();
    lustro.setState('waiting-input');
    note(lustro);
    await lustro.clock.advance(FIRST_CHECK_MS.done - 1_000);
    lustro.setSeen(true);
    await lustro.clock.advance(2_000);
    expect(lustro.sent).toHaveLength(0);

    // b) …a dziś `seen` zostaje `false` przez całe okno, więc baner wychodzi.
    const h = setup();
    h.setState('waiting-input');
    note(h);
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.title).toBe('✅ Done · rarog');
  });
});

/*
 * Degradację liczy rejestr urządzeń APNs PER TOKEN (`apns-devices.ts`, test w
 * `notify-apns-sink.test.ts`), a apka pyta o nią `POST /api/push/apns/status`. Harmonogram wyniku
 * nie interpretuje: porażka idzie do logu i nie wstrzymuje następnych spraw.
 */
describe('wynik wysyłki', () => {
  it('porażki APNs idą do logu i nie zatrzymują kolejnych wysyłek', async () => {
    const h = setup({ outcome: 'failed' });
    const rounds = DEGRADED_AFTER_FAILURES + 2;
    for (let i = 0; i < rounds; i += 1) {
      agentResumed(h);
      askPermission(h);
      await h.clock.advance(FIRST_CHECK_MS.blocking + 1);
    }
    expect(h.attempted).toHaveLength(rounds);
    expect(h.logs.filter((l) => l === 'push: permission for rarog — APNs: FAILED')).toHaveLength(rounds);
  });
});

/*
 * Log Notifiera to jedyny świadek wysyłki, ale `server.log` czyta się na Macu i wkleja do zgłoszeń:
 * treść pytania i zdanie wyniku nie mają tam czego szukać. Do
 * odpowiedzi na „czemu push nie przyszedł" wystarczy rodzaj, projekt i wynik per kanał.
 */
describe('log wysyłki', () => {
  it('niesie rodzaj, projekt i wynik per kanał — nigdy tytułu ani treści banera', async () => {
    const h = setup();
    h.notifier.note({
      sessionId: SESSION,
      event: { type: 'question-requested' },
      backgroundTasks: 0,
      project: 'rarog',
      detail: foreign('Czy skasować sekretny-katalog?'),
    });
    await h.clock.advance(FIRST_CHECK_MS.blocking + 1);
    expect(h.sent[0]?.body).toBe('Czy skasować sekretny-katalog?');
    const line = h.logs.find((l) => l.includes('APNs:'));
    expect(line).toBe('push: question for rarog — APNs: SENT');
    expect(h.logs.join('\n')).not.toContain('sekretny-katalog');
    expect(h.logs.join('\n')).not.toContain(h.sent[0]?.title ?? '∅');
  });

  it('brak odbiorcy to osobne słowo, nie porażka', async () => {
    const h = setup({ outcome: 'no-receiver' });
    askPermission(h);
    await h.clock.advance(FIRST_CHECK_MS.blocking + 1);
    expect(h.logs).toContain('push: permission for rarog — APNs: NO RECEIVER');
  });

  it('bez żadnego kanału mówi to wprost', async () => {
    const h = setup({ report: () => ({}) });
    askPermission(h);
    await h.clock.advance(FIRST_CHECK_MS.blocking + 1);
    expect(h.logs).toContain('push: permission for rarog — no channel');
  });
});

describe('baner o tej samej sprawie nie idzie dwa razy', () => {
  /*
   * `#check()` usuwa wpis z `#waiting` ZANIM wyśle, więc po wysyłce nie zostawał ślad i każde
   * kolejne `note()` uzbrajało od zera. Przy przejściu-tożsamości dawało to DRUGI baner
   * o tym samym stojącym dialogu: `agent-blocked` wysyłał po 3 s baner bez nazwy narzędzia
   * (pending był jeszcze pusty), a karta składana 1–2 s później — drugi, bogatszy. Okno jest
   * osiągalne bez egzotyki: karencja jsonl ↔ ekran to 2 × 800 ms, ponowna ocena 500 ms,
   * a nieudana pierwsza ocena czeka do zegara stojącego dialogu (4 s).
   */
  const blocked = (h: Harness): void => {
    h.notifier.note({
      sessionId: SESSION,
      event: { type: 'agent-blocked' },
      backgroundTasks: 0,
      project: 'rarog',
    });
  };

  it('karta, która doszła PO wysłanym banerze, nie dosyła drugiego', async () => {
    const h = setup();
    blocked(h);
    await h.clock.advance(FIRST_CHECK_MS.blocking + 1);
    expect(h.sent).toHaveLength(1);
    // Baner z `agent-blocked` nie zna jeszcze narzędzia — to ta uboższa treść, o którą chodzi.
    expect(h.sent[0]?.body).not.toBe('Bash: pnpm test — visuals');

    // Karta złożyła się o sekundę za późno — treść byłaby bogatsza, ale wezwanie to samo.
    askPermission(h);
    await h.clock.advance(FIRST_CHECK_MS.blocking + 1);
    expect(h.sent).toHaveLength(1);
  });

  it('karta, która zdążyła PRZED oknem, dalej wzbogaca jedyny baner', async () => {
    const h = setup();
    blocked(h);
    // Jeszcze nic nie poszło — nowsze zdarzenie przejmuje sprawę, tak jak dotąd.
    askPermission(h);
    await h.clock.advance(FIRST_CHECK_MS.blocking + 1);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.body).toBe('Bash: pnpm test — visuals');
  });

  it('sprawa, która się ruszyła i wróciła, dostaje własny baner', async () => {
    const h = setup();
    askPermission(h);
    await h.clock.advance(FIRST_CHECK_MS.blocking + 1);
    expect(h.sent).toHaveLength(1);

    // Zgoda obsłużona przy biurku, agent mieli dalej — pamięć wysyłki gaśnie…
    h.setState('running');
    agentResumed(h);
    // …więc następna blokada jest NOWĄ sprawą, nie powtórką.
    h.setState('waiting-permission');
    askPermission(h);
    await h.clock.advance(FIRST_CHECK_MS.blocking + 1);
    expect(h.sent).toHaveLength(2);
  });

  it('powrót do Raroga kasuje pamięć wysyłki — po wyjściu sesja znów może zawołać', async () => {
    const h = setup();
    askPermission(h);
    await h.clock.advance(FIRST_CHECK_MS.blocking + 1);
    expect(h.sent).toHaveLength(1);

    // Wejście do apki (lista pokazuje stan każdej sesji) i wyjście z niej.
    h.presence.note('telefon', { visible: true });
    await h.clock.advance(1);
    h.presence.note('telefon', { visible: false });
    await h.clock.advance(60_000);

    askPermission(h);
    await h.clock.advance(FIRST_CHECK_MS.blocking + 1);
    expect(h.sent).toHaveLength(2);
  });
});

/*
 * Dźwięk „skończył” gra aktualizacja kafla Live Activity, a zleca ją sink
 * harmonogramu (`fanout.ts`) przy wysłanym „gotowe”. Przebieg Notifier → prawdziwy `createFanoutSink`
 * z atrapą `chime`: dźwięk dziedziczy WSZYSTKIE reguły ciszy „gotowe” (obecność, praca w tle, tura
 * z samego postoju subagenta), bo nie ma własnej ścieżki.
 */
describe('dźwięk „skończył” z kafla — tylko tam, gdzie wychodzi „gotowe”', () => {
  const HUMAN = { standbyNotices: 0, artifactWatch: 0, other: 1, toolCalls: 0, compactions: 0 };
  const STANDBY = { standbyNotices: 1, artifactWatch: 0, other: 0, toolCalls: 0, compactions: 0 };

  const chimed = (): { calls: number; chime: () => number } => {
    const counter = {
      calls: 0,
      chime: (): number => {
        counter.calls += 1;
        return 1;
      },
    };
    return counter;
  };
  const turnEnded = (h: Harness, turnInput: typeof HUMAN, working = 0): void => {
    h.setState('waiting-input');
    h.setBackground(working);
    h.notifier.note({
      sessionId: SESSION, event: { type: 'agent-idle' }, backgroundTasks: working, project: 'rarog', turnInput,
    });
  };
  const turnStarted = (h: Harness): void => {
    h.setState('running');
    h.notifier.note({ sessionId: SESSION, event: { type: 'agent-working' }, backgroundTasks: 0, project: 'rarog' });
  };

  it('zwykłe „gotowe”: jedno zlecenie dźwięku w chwili wysyłki plakietki; linia logu niesie liczbę', async () => {
    const c = chimed();
    const h = setup({ chime: c.chime, badge: () => 0 });
    turnEnded(h, HUMAN);
    await h.clock.advance(FIRST_CHECK_MS.done - 1);
    expect(c.calls).toBe(0);
    await h.clock.advance(1);
    expect(c.calls).toBe(1);
    expect(h.sent.map((content) => content.kind)).toEqual(['done']);
    expect(h.logs).toContain('push: done for rarog — APNs: SENT, Live Activity chime: 1');
  });

  it('bez żywego kafla: zero zleceń i linia z „dźwięk kafla: 0”', async () => {
    const h = setup({ chime: () => 0, badge: () => 0 });
    turnEnded(h, HUMAN);
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(h.logs).toContain('push: done for rarog — APNs: SENT, Live Activity chime: 0');
  });

  it('zaległe „gotowe” po pracy w tle: cisza przy pracy, jedno zlecenie w pierwszej cichej chwili', async () => {
    const c = chimed();
    const h = setup({ chime: c.chime, badge: () => 0 });
    turnEnded(h, HUMAN, 1);
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(c.calls).toBe(0);
    turnStarted(h);
    turnEnded(h, STANDBY);
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(c.calls).toBe(1);
    expect(h.sent.map((content) => content.kind)).toEqual(['done']);
  });

  it('tura z samego postoju subagenta bez zaległości: zero zleceń', async () => {
    const c = chimed();
    const h = setup({ chime: c.chime, badge: () => 0 });
    turnEnded(h, STANDBY);
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(c.calls).toBe(0);
    expect(h.sent).toHaveLength(0);
  });

  it('patrzysz w Raroga: zero zleceń; powrót do Raroga przed oknem też', async () => {
    const c = chimed();
    const h = setup({ chime: c.chime, badge: () => 0 });
    h.presence.note('telefon', { visible: true });
    turnEnded(h, HUMAN);
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(c.calls).toBe(0);

    const later = setup({ chime: c.chime, badge: () => 0 });
    turnEnded(later, HUMAN);
    later.presence.note('telefon', { visible: true });
    await later.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(c.calls).toBe(0);
  });

  it('sprawy pilne (zgoda, błąd) dźwięku z kafla nie zlecają — mają własny baner z dźwiękiem', async () => {
    const c = chimed();
    const h = setup({ chime: c.chime, badge: () => 1 });
    askPermission(h);
    await h.clock.advance(FIRST_CHECK_MS.blocking + 1);
    expect(h.sent.map((content) => content.kind)).toEqual(['permission']);
    expect(c.calls).toBe(0);
    expect(h.logs).toContain('push: permission for rarog — APNs: SENT');
  });
});

/*
 * Prompt zablokowany przez hook `UserPromptSubmit`. herdr potrafi zgłosić
 * `idle`/`done` po wpisie blokady, zanim manager zobaczy samą blokadę — wtedy `agent-idle` uzbraja fałszywe
 * „gotowe”. Manager cofa taki koniec tury (`retractTurnEnd`).
 */
describe('cofnięty koniec tury — prompt zablokowany przez hook', () => {
  const turnStarted = (h: Harness, event: 'turn-start' | 'agent-working' = 'turn-start'): void => {
    h.setState('running');
    h.notifier.note({ sessionId: SESSION, event: { type: event }, backgroundTasks: 0, project: 'rarog' });
  };
  const turnEnded = (h: Harness, detail: string, working = 0): void => {
    h.setState('waiting-input');
    h.setBackground(working);
    h.notifier.note({
      sessionId: SESSION, event: { type: 'agent-idle' }, backgroundTasks: working, project: 'rarog', detail: foreign(detail),
    });
  };

  it('koniec tury po zablokowanym prompcie: uzbrojone „gotowe” gaśnie, zaległości nie zostaje', async () => {
    const h = setup();
    turnStarted(h);
    turnEnded(h, 'fałszywy koniec');
    expect(h.notifier.pending).toBe(1);
    h.notifier.retractTurnEnd(SESSION);
    expect(h.notifier.pending).toBe(0);
    expect(h.logs).toContain(`${PUSH_QUIET_LOG} rarog (done, turn end retracted: prompt blocked by a hook)`);
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    // Cisza w tle nie ma czego wypuścić: zaległość sprzed tego końca tury nie istniała.
    h.notifier.quiet(SESSION);
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(h.sent).toHaveLength(0);
  });

  it('zaległe „gotowe” WCZEŚNIEJSZEJ, prawdziwej tury wraca — z jej treścią', async () => {
    const h = setup();
    // Prawdziwa tura kończy się przy pracującym tle: cisza, wynik zaległy.
    turnStarted(h, 'agent-working');
    turnEnded(h, 'prawdziwy wynik', 1);
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(h.sent).toHaveLength(0);
    // Prompt z Raroga, hook go blokuje, herdr melduje `idle` pierwszy: zaległość nadpisana fałszywym końcem.
    turnStarted(h);
    turnEnded(h, 'fałszywy koniec');
    h.notifier.retractTurnEnd(SESSION);
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(h.sent).toHaveLength(0);
    // Tło ucichło: wychodzi zaległe „gotowe” PRAWDZIWEJ tury.
    h.setBackground(0);
    h.notifier.quiet(SESSION);
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.body).toContain('prawdziwy wynik');
  });

  it('odbiór wyniku po końcu tury ma pierwszeństwo: cofnięcie nie wskrzesza zaległości; inne klasy zostają', async () => {
    const h = setup();
    turnStarted(h, 'agent-working');
    turnEnded(h, 'prawdziwy wynik', 1);
    turnStarted(h);
    turnEnded(h, 'fałszywy koniec');
    h.notifier.seen(SESSION);
    h.notifier.retractTurnEnd(SESSION);
    h.setBackground(0);
    h.notifier.quiet(SESSION);
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(h.sent).toHaveLength(0);

    // Uzbrojona zgoda (inna klasa) nie gaśnie od cofnięcia końca tury.
    h.setState('waiting-permission');
    askPermission(h);
    h.notifier.retractTurnEnd(SESSION);
    await h.clock.advance(FIRST_CHECK_MS.blocking + 1);
    expect(h.sent.map((content) => content.kind)).toEqual(['permission']);
  });

  it('`prompt-blocked` jest cichy i zdejmuje to, co czekało', async () => {
    const h = setup();
    turnStarted(h);
    turnEnded(h, 'koniec');
    h.notifier.note({ sessionId: SESSION, event: { type: 'prompt-blocked' }, backgroundTasks: 0, project: 'rarog' });
    expect(h.notifier.pending).toBe(0);
    await h.clock.advance(FIRST_CHECK_MS.done + 1);
    expect(h.sent).toHaveLength(0);
  });
});
