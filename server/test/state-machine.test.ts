/**
 * Testy maszyny stanów: pełna tabela przejść, nazwane wyścigi ze speca oraz własności
 * sprawdzane property-based (fast-check).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { SessionState } from '@rarog/shared';
import { MAX_TURNS_DETAIL, isTerminal, transition } from '../src/sessions/state-machine.ts';
import type { SmEvent } from '../src/sessions/state-machine.ts';

const ALL_STATES: SessionState[] = [
  'starting', 'running', 'waiting-input', 'waiting-permission', 'waiting-question',
  'limit-reached', 'error', 'interrupted', 'done', 'resumable',
];

/** Etykieta → zdarzenie. Etykiety są kolumnami tabeli przejść poniżej. */
const EVENTS = {
  'init': { type: 'driver-init' },
  'turn': { type: 'turn-start' },
  'result:success': { type: 'result', subtype: 'success' },
  'result:max-turns': { type: 'result', subtype: 'error_max_turns' },
  'result:error': { type: 'result', subtype: 'error' },
  'perm-req': { type: 'permission-requested' },
  'perm-res': { type: 'permission-resolved' },
  'q-req': { type: 'question-requested' },
  'q-res': { type: 'question-resolved' },
  'interrupt': { type: 'interrupt-requested' },
  'exit:ok': { type: 'driver-exit', ok: true },
  'exit:fail': { type: 'driver-exit', ok: false },
  'limit': { type: 'limit-reached', resetAt: '2026-08-21T20:00:00.000Z' },
  'restart': { type: 'backend-restart' },
  'closed': { type: 'closed' },
  'resumed': { type: 'resumed' },
  // Zdarzenia od zewnętrznego nadzorcy (herdr): turę odpala i domyka CZŁOWIEK w terminalu.
  'agent-working': { type: 'agent-working' },
  'agent-idle': { type: 'agent-idle' },
  'agent-blocked': { type: 'agent-blocked' },
  // Hook `UserPromptSubmit` zablokował prompt, którym Rarog otworzył turę: tury nie ma.
  'prompt-blocked': { type: 'prompt-blocked' },
} as const satisfies Record<string, SmEvent>;

type EventLabel = keyof typeof EVENTS;
const EVENT_LABELS = Object.keys(EVENTS) as EventLabel[];
const ALL_EVENTS: SmEvent[] = EVENT_LABELS.map((label) => EVENTS[label]);

/** `=` znaczy „identyczność" (zdarzenie nie pasuje do stanu). */
const SAME = '=' as const;
type Expected = SessionState | typeof SAME;

/**
 * Pełna tabela przejść. Wiersz = stan, kolumna = zdarzenie.
 * Wszystko, co nie jest wypisane jako konkretny stan, musi być identycznością.
 */
const TABLE: Record<SessionState, Record<EventLabel, Expected>> = {
  'starting': {
    'init': 'running', 'turn': 'running',
    'result:success': SAME, 'result:max-turns': SAME, 'result:error': SAME,
    'perm-req': SAME, 'perm-res': SAME, 'q-req': SAME, 'q-res': SAME,
    'interrupt': SAME, 'exit:ok': 'done', 'exit:fail': 'error',
    'limit': 'limit-reached', 'restart': 'resumable', 'closed': 'done', 'resumed': SAME,
    'agent-working': 'running', 'agent-idle': 'waiting-input',
    'agent-blocked': 'waiting-permission',
    'prompt-blocked': 'waiting-input',
  },
  'running': {
    'init': SAME, 'turn': SAME,
    'result:success': 'waiting-input', 'result:max-turns': 'interrupted',
    'result:error': 'error',
    'perm-req': 'waiting-permission', 'perm-res': SAME,
    'q-req': 'waiting-question', 'q-res': SAME,
    'interrupt': 'waiting-input', 'exit:ok': 'done', 'exit:fail': 'error',
    'limit': 'limit-reached', 'restart': 'resumable', 'closed': 'done', 'resumed': SAME,
    'agent-working': SAME, 'agent-idle': 'waiting-input',
    'agent-blocked': 'waiting-permission',
    'prompt-blocked': 'waiting-input',
  },
  'waiting-input': {
    'init': SAME, 'turn': 'running',
    'result:success': SAME, 'result:max-turns': SAME, 'result:error': SAME,
    'perm-req': SAME, 'perm-res': SAME, 'q-req': SAME, 'q-res': SAME,
    'interrupt': SAME, 'exit:ok': 'done', 'exit:fail': 'error',
    'limit': 'limit-reached', 'restart': 'resumable', 'closed': 'done', 'resumed': SAME,
    'agent-working': 'running', 'agent-idle': SAME, 'agent-blocked': 'waiting-permission',
    'prompt-blocked': SAME,
  },
  'waiting-permission': {
    'init': SAME, 'turn': SAME,
    'result:success': 'waiting-input', 'result:max-turns': 'interrupted',
    'result:error': 'error',
    'perm-req': SAME, 'perm-res': 'running', 'q-req': SAME, 'q-res': SAME,
    'interrupt': 'waiting-input', 'exit:ok': 'done', 'exit:fail': 'error',
    'limit': 'limit-reached', 'restart': 'resumable', 'closed': 'done', 'resumed': SAME,
    'agent-working': 'running', 'agent-idle': 'waiting-input', 'agent-blocked': SAME,
    'prompt-blocked': SAME,
  },
  'waiting-question': {
    'init': SAME, 'turn': SAME,
    'result:success': 'waiting-input', 'result:max-turns': 'interrupted',
    'result:error': 'error',
    'perm-req': SAME, 'perm-res': SAME, 'q-req': SAME, 'q-res': 'running',
    'interrupt': 'waiting-input', 'exit:ok': 'done', 'exit:fail': 'error',
    'limit': 'limit-reached', 'restart': 'resumable', 'closed': 'done', 'resumed': SAME,
    'agent-working': 'running', 'agent-idle': 'waiting-input',
    'agent-blocked': 'waiting-permission',
    'prompt-blocked': SAME,
  },
  'limit-reached': {
    'init': SAME, 'turn': SAME,
    'result:success': SAME, 'result:max-turns': SAME, 'result:error': SAME,
    'perm-req': SAME, 'perm-res': SAME, 'q-req': SAME, 'q-res': SAME,
    'interrupt': SAME, 'exit:ok': SAME, 'exit:fail': SAME,
    'limit': SAME, 'restart': 'resumable', 'closed': 'done', 'resumed': 'running',
    // Panel, który znowu pracuje albo stoi na dialogu, jest silniejszym dowodem niż
    // zapamiętany limit planu — dialog to obserwacja ekranu, nie zgadywanie. `idle`
    // już nie: herdr widzi wtedy tylko, że ekran przestał się ruszać.
    'agent-working': 'running', 'agent-idle': SAME, 'agent-blocked': 'waiting-permission',
    'prompt-blocked': SAME,
  },
  'error': {
    'init': SAME, 'turn': SAME,
    'result:success': SAME, 'result:max-turns': SAME, 'result:error': SAME,
    'perm-req': SAME, 'perm-res': SAME, 'q-req': SAME, 'q-res': SAME,
    'interrupt': SAME, 'exit:ok': SAME, 'exit:fail': SAME,
    'limit': SAME, 'restart': 'resumable', 'closed': 'done', 'resumed': 'running',
    'agent-working': 'running', 'agent-idle': SAME, 'agent-blocked': 'waiting-permission',
    'prompt-blocked': SAME,
  },
  'interrupted': {
    'init': SAME, 'turn': SAME,
    'result:success': SAME, 'result:max-turns': SAME, 'result:error': SAME,
    'perm-req': SAME, 'perm-res': SAME, 'q-req': SAME, 'q-res': SAME,
    'interrupt': SAME, 'exit:ok': SAME, 'exit:fail': SAME,
    'limit': SAME, 'restart': 'resumable', 'closed': 'done', 'resumed': 'running',
    'agent-working': 'running', 'agent-idle': 'waiting-input',
    'agent-blocked': 'waiting-permission',
    'prompt-blocked': SAME,
  },
  'done': {
    'init': SAME, 'turn': SAME,
    'result:success': SAME, 'result:max-turns': SAME, 'result:error': SAME,
    'perm-req': SAME, 'perm-res': SAME, 'q-req': SAME, 'q-res': SAME,
    'interrupt': SAME, 'exit:ok': SAME, 'exit:fail': SAME,
    'limit': SAME, 'restart': SAME, 'closed': SAME, 'resumed': SAME,
    'agent-working': SAME, 'agent-idle': SAME, 'agent-blocked': SAME,
    'prompt-blocked': SAME,
  },
  'resumable': {
    'init': SAME, 'turn': SAME,
    'result:success': SAME, 'result:max-turns': SAME, 'result:error': SAME,
    'perm-req': SAME, 'perm-res': SAME, 'q-req': SAME, 'q-res': SAME,
    'interrupt': SAME, 'exit:ok': SAME, 'exit:fail': SAME,
    'limit': SAME, 'restart': SAME, 'closed': 'done', 'resumed': 'running',
    'agent-working': 'running', 'agent-idle': 'waiting-input',
    'agent-blocked': 'waiting-permission',
    'prompt-blocked': SAME,
  },
};

describe('transition — pełna tabela przejść', () => {
  for (const state of ALL_STATES) {
    for (const label of EVENT_LABELS) {
      const expected = TABLE[state][label];
      const target = expected === SAME ? state : expected;
      it(`${state} + ${label} → ${target}${expected === SAME ? ' (identyczność)' : ''}`, () => {
        expect(transition(state, EVENTS[label])).toBe(target);
      });
    }
  }

  it('tabela pokrywa wszystkie stany i wszystkie zdarzenia', () => {
    expect(Object.keys(TABLE).sort()).toEqual([...ALL_STATES].sort());
    for (const state of ALL_STATES) {
      expect(Object.keys(TABLE[state]).sort()).toEqual([...EVENT_LABELS].sort());
    }
  });
});

describe('transition — czystość i odporność', () => {
  it('nie mutuje argumentów', () => {
    const ev: SmEvent = { type: 'result', subtype: 'success' };
    const snapshot = JSON.stringify(ev);
    transition('running', ev);
    expect(JSON.stringify(ev)).toBe(snapshot);
  });

  it('jest deterministyczna', () => {
    for (const state of ALL_STATES) {
      for (const ev of ALL_EVENTS) {
        expect(transition(state, ev)).toBe(transition(state, ev));
      }
    }
  });

  it('nie rzuca na zdarzeniu spoza unii (forward-compat)', () => {
    const bogus = { type: 'z-przyszłości' } as unknown as SmEvent;
    for (const state of ALL_STATES) {
      expect(() => transition(state, bogus)).not.toThrow();
      expect(transition(state, bogus)).toBe(state);
    }
  });

  it('`done` jest jedynym stanem terminalnym', () => {
    expect(ALL_STATES.filter(isTerminal)).toEqual(['done']);
  });

  it('detail dla error_max_turns jest gotowy dla UI', () => {
    expect(transition('running', { type: 'result', subtype: 'error_max_turns' }))
      .toBe('interrupted');
    expect(MAX_TURNS_DETAIL.text).toBe('turn limit reached, resume the session');
    expect(MAX_TURNS_DETAIL.ref).toEqual({ code: 'state.max-turns' });
  });
});

describe('transition — nazwane wyścigi ze speca', () => {
  it('Esc = „przerwij i pisz dalej": interrupt prowadzi do waiting-input, spóźniony result nic nie rusza', () => {
    // Zamierzone zachowanie z terminalowego Claude Code: po Esc następnym ruchem JEST
    // wiadomość, a nie karta „przerwana" — sesja od razu czeka na prompt.
    const afterEsc = transition('running', { type: 'interrupt-requested' });
    expect(afterEsc).toBe('waiting-input');
    // Result umierającej tury (wyścig ctrl+c vs domknięcie) nie może przestawić sesji,
    // która już czeka na człowieka — ani na error, ani z powrotem w turę.
    for (const subtype of ['success', 'error_max_turns', 'error'] as const) {
      expect(transition(afterEsc, { type: 'result', subtype })).toBe('waiting-input');
    }
  });

  it('permission-resolved po error nie ożywia sesji', () => {
    const errored = transition('waiting-permission', { type: 'result', subtype: 'error' });
    expect(errored).toBe('error');
    expect(transition(errored, { type: 'permission-resolved' })).toBe('error');
  });

  it('cokolwiek po done zostawia done (delta po done odrzuca manager)', () => {
    for (const ev of ALL_EVENTS) {
      expect(transition('done', ev)).toBe('done');
    }
  });

  it('spóźnione permission-requested po interrupt nie wraca do oczekiwania', () => {
    const afterEsc = transition('waiting-permission', { type: 'interrupt-requested' });
    expect(afterEsc).toBe('waiting-input');
    expect(transition(afterEsc, { type: 'permission-requested' })).toBe('waiting-input');
  });

  it('driver-exit po limit-reached nie kasuje informacji o limicie', () => {
    expect(transition('limit-reached', { type: 'driver-exit', ok: false })).toBe('limit-reached');
  });
});

describe('transition — zdarzenia zewnętrznego nadzorcy (herdr)', () => {
  it('waiting-permission BEZ pending: agent-blocked to jedyne wejście, esc wraca do pracy', () => {
    // Sesja herdr trafia do `waiting-permission`, ale `PendingInteractions` nie dostaje wpisu:
    // Rarog wie, że dialog stoi w terminalu, i nie zna jego opcji. Cała reszta systemu musi to
    // znieść — `#expirePending`/`resolvePermission` są no-opami na pustej liście, a UI renderuje
    // karty zgody z tablicy `pendingPermissions`, więc pusta tablica = brak kart, nie błąd.
    const blocked = transition('running', { type: 'agent-blocked' });
    expect(blocked).toBe('waiting-permission');
    // Odrzucenie dialogu (`escape`) widzimy w herdr jako powrót do bezczynności...
    expect(transition(blocked, { type: 'agent-idle' })).toBe('waiting-input');
    // ...a zatwierdzenie w terminalu jako wznowienie pracy.
    expect(transition(blocked, { type: 'agent-working' })).toBe('running');
    // Drugie `blocked` (migotanie detekcji) niczego nie przestawia.
    expect(transition(blocked, { type: 'agent-blocked' })).toBe('waiting-permission');
  });

  it('agent-idle nie kasuje ani błędu, ani limitu planu', () => {
    // herdr widzi wyłącznie „ekran przestał się ruszać" — to za mało, żeby unieważnić
    // informację, którą Rarog ma z pierwszej ręki i którą użytkownik już widzi na karcie.
    expect(transition('error', { type: 'agent-idle' })).toBe('error');
    expect(transition('limit-reached', { type: 'agent-idle' })).toBe('limit-reached');
  });

  it('agent-working ożywia sesję z każdego stanu, w którym Rarog ją zostawił', () => {
    // Turę odpala CZŁOWIEK w terminalu, więc panel potrafi ruszyć także po błędzie i limicie.
    for (const state of ['error', 'limit-reached', 'interrupted', 'resumable'] as const) {
      expect(transition(state, { type: 'agent-working' })).toBe('running');
    }
  });

  it('agent-blocked przestawia także sesję po błędzie, limicie i restarcie backendu', () => {
    /*
     * Człowiek ponawia turę przy biurku po `error`, agent staje na zgodzie — gdyby Rarog
     * został w `error`, chip i push milczałyby nad stojącym dialogiem.
     * `blocked` jest obserwacją ekranu (parser widzi dialog), nie zgadywaniem jak `idle`, więc
     * wolno mu przebić stan, którego `idle` przebić nie może.
     */
    for (const state of ['error', 'limit-reached', 'resumable'] as const) {
      expect(transition(state, { type: 'agent-blocked' })).toBe('waiting-permission');
    }
    // Asymetria jest ŚWIADOMA: to samo `idle` dalej NIE kasuje ani błędu, ani limitu.
    expect(transition('error', { type: 'agent-idle' })).toBe('error');
    expect(transition('limit-reached', { type: 'agent-idle' })).toBe('limit-reached');
  });

  it('zdarzenia nadzorcy nie ruszają sesji zamkniętej', () => {
    for (const ev of ['agent-working', 'agent-idle', 'agent-blocked'] as const) {
      expect(transition('done', { type: ev })).toBe('done');
    }
  });

  it('awaria nadzorcy NIE jest zdarzeniem maszyny stanów', () => {
    // Świadomy brak `detached` w `SmEvent` (reguła 11.4): padnięcie socketu herdr znaczy
    // „Rarog stracił kontakt", a nie „silnik przestał żyć". Manager ustawia `session.stale`,
    // stan zostaje ostatni znany. Gdyby ktoś dopisał tu przejście, 17 kart zmieniłoby sekcję
    // przy każdym restarcie herdr — dokładnie to migotanie, którego wymaganie nr 1 zabrania.
    const bogus = { type: 'detached' } as unknown as SmEvent;
    for (const state of ALL_STATES) {
      expect(transition(state, bogus)).toBe(state);
    }
  });
});

describe('transition — ścieżki szczęśliwe', () => {
  const run = (start: SessionState, evs: SmEvent[]): SessionState =>
    evs.reduce<SessionState>((s, ev) => transition(s, ev), start);

  it('start → permission → allow → result → kolejna tura', () => {
    expect(run('starting', [
      { type: 'driver-init' },
      { type: 'permission-requested' },
      { type: 'permission-resolved' },
      { type: 'result', subtype: 'success' },
    ])).toBe('waiting-input');
  });

  it('restart backendu → resumable → resume → running', () => {
    expect(run('waiting-permission', [
      { type: 'backend-restart' },
      { type: 'resumed' },
    ])).toBe('running');
  });

  it('limit planu → wznowienie po resecie', () => {
    expect(run('running', [
      { type: 'limit-reached', resetAt: '2026-08-21T22:00:00.000Z' },
      { type: 'resumed' },
    ])).toBe('running');
  });

  it('limit tur → interrupted → resume', () => {
    expect(run('running', [
      { type: 'result', subtype: 'error_max_turns' },
      { type: 'resumed' },
    ])).toBe('running');
  });
});

describe('transition — własności (fast-check)', () => {
  const stateArb = fc.constantFrom(...ALL_STATES);
  const eventArb: fc.Arbitrary<SmEvent> = fc.oneof(
    fc.constant<SmEvent>({ type: 'driver-init' }),
    fc.constant<SmEvent>({ type: 'turn-start' }),
    fc.constantFrom('success', 'error_max_turns', 'error')
      .map((subtype): SmEvent => ({ type: 'result', subtype })),
    fc.constant<SmEvent>({ type: 'permission-requested' }),
    fc.constant<SmEvent>({ type: 'permission-resolved' }),
    fc.constant<SmEvent>({ type: 'question-requested' }),
    fc.constant<SmEvent>({ type: 'question-resolved' }),
    fc.constant<SmEvent>({ type: 'interrupt-requested' }),
    fc.boolean().map((ok): SmEvent => ({ type: 'driver-exit', ok })),
    fc.option(fc.constant('2026-08-21T20:00:00.000Z'), { nil: undefined })
      .map((resetAt): SmEvent => ({ type: 'limit-reached', resetAt })),
    fc.constant<SmEvent>({ type: 'backend-restart' }),
    fc.constant<SmEvent>({ type: 'closed' }),
    fc.constant<SmEvent>({ type: 'resumed' }),
    fc.constant<SmEvent>({ type: 'agent-working' }),
    fc.constant<SmEvent>({ type: 'agent-idle' }),
    fc.constant<SmEvent>({ type: 'agent-blocked' }),
  );

  it('dowolna sekwencja zdarzeń kończy się stanem z SessionState', () => {
    fc.assert(fc.property(stateArb, fc.array(eventArb, { maxLength: 60 }), (start, evs) => {
      let state = start;
      for (const ev of evs) {
        state = transition(state, ev);
        expect(ALL_STATES).toContain(state);
      }
    }), { numRuns: 500 });
  });

  it('z każdego stanu nieterminalnego istnieje wyjście', () => {
    fc.assert(fc.property(stateArb, fc.array(eventArb, { maxLength: 40 }), (start, evs) => {
      const state = evs.reduce<SessionState>((s, ev) => transition(s, ev), start);
      if (isTerminal(state)) return;
      expect(ALL_EVENTS.some((ev) => transition(state, ev) !== state)).toBe(true);
    }), { numRuns: 500 });
  });

  it('done jest pochłaniający (absorbing) dla dowolnej sekwencji', () => {
    fc.assert(fc.property(fc.array(eventArb, { maxLength: 40 }), (evs) => {
      expect(evs.reduce<SessionState>((s, ev) => transition(s, ev), 'done')).toBe('done');
    }), { numRuns: 200 });
  });

  it('closed z dowolnego stanu daje done', () => {
    fc.assert(fc.property(stateArb, (state) => {
      expect(transition(state, { type: 'closed' })).toBe('done');
    }));
  });
});
