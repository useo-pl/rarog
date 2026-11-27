/**
 * Maszyna stanów sesji — czysta funkcja, jedyne miejsce, w którym zmienia się `SessionState`.
 *
 * Zasady (spec, sekcja „Maszyna stanów"):
 * - `transition()` jest CZYSTA: brak I/O, brak zegara, brak mutacji argumentów,
 * - zdarzenie niepasujące do bieżącego stanu = identyczność (zwracamy ten sam stan),
 * - NIGDY nie rzucamy wyjątku i nigdy nie zwracamy stanu spoza `SessionState`,
 * - stan terminalny jest dokładnie jeden: `done`. Z każdego stanu nieterminalnego istnieje
 *   wyjście (co najmniej przez `closed` → `done`).
 *
 * Efekty uboczne przejść (broadcast, wygaszanie pending, zapis rejestru) należą do managera —
 * tutaj wyłącznie tabela przejść.
 */
import type { SessionState } from '@rarog/shared';
import { say } from '@rarog/shared/sentences';

export type SmEvent =
  | { type: 'driver-init' }            // starting → running
  | { type: 'turn-start' }             // waiting-input|starting → running (user wysłał prompt)
  | { type: 'result'; subtype: 'success' | 'error_max_turns' | 'error' }
  | { type: 'permission-requested' } | { type: 'permission-resolved' }
  | { type: 'question-requested' }   | { type: 'question-resolved' }
  | { type: 'interrupt-requested' }  // → waiting-input (z running/waiting-*; Esc = „przerwij i pisz dalej")
  /**
   * Hook `UserPromptSubmit` zablokował prompt, którym Rarog otworzył turę (starting|running → waiting-input):
   * tury nie ma, sesja czeka na człowieka. Manager wysyła je wyłącznie przy blokadzie wysyłki z Raroga
   * rozstrzygniętej przez driver i przy znaczniku tury otwartej tą wysyłką (`docs/dialogs.md`).
   */
  | { type: 'prompt-blocked' }
  | { type: 'driver-exit'; ok: boolean }   // ok: done, nie-ok: error
  | { type: 'limit-reached'; resetAt?: string }
  | { type: 'backend-restart' }      // każdy nieterminalny → resumable
  | { type: 'closed' }               // → done
  | { type: 'resumed' }              // resumable|interrupted|limit-reached|error → running
  /**
   * Trzy zdarzenia od ZEWNĘTRZNEGO nadzorcy (herdr): turę odpalił, domknął albo zablokował
   * ktoś inny niż Rarog. Nie mają odpowiednika `detached`: awaria nadzorcy NIE jest przejściem
   * stanu (silnik w panelu żyje dalej) — manager ustawia wtedy `session.stale`.
   */
  | { type: 'agent-working' }        // zewnętrzny agent zaczął pracę
  | { type: 'agent-idle' }           // zewnętrzny agent skończył i czeka
  | { type: 'agent-blocked' };       // zewnętrzny agent stoi na dialogu w terminalu

/** Jedyny stan terminalny — nic z niego nie wychodzi. */
export const TERMINAL_STATE: SessionState = 'done';

/**
 * Stany, w których tura jest „w locie" i może przyjść `result` z drivera.
 * Świadomie obejmuje stany oczekiwania: SDK potrafi domknąć turę, zanim manager zdąży
 * rozstrzygnąć pending permission/question — bez tego sesja utknęłaby w `waiting-*`.
 */
const ACTIVE_TURN_STATES: readonly SessionState[] = [
  'running', 'waiting-permission', 'waiting-question',
];

/** Stany „żywej" sesji, w których limit planu ma sens (nie nadpisujemy nimi error/interrupted). */
const LIVE_STATES: readonly SessionState[] = [
  'starting', 'running', 'waiting-input', 'waiting-permission', 'waiting-question',
];

/**
 * Stany, z których `interrupt-requested` prowadzi do `waiting-input` (running/waiting-*).
 *
 * Cel jest ten sam co Esc w terminalowym Claude Code: przerwij i PISZ DALEJ. Osobny stan
 * `interrupted` zamieniał świadome przerwanie w kartę „przerwana", która chowa composer —
 * a przecież to użytkownik zatrzymał agenta i wie o tym najlepiej. `interrupted` zostaje
 * wyłącznie dla `error_max_turns` (tam sesja faktycznie stanęła nie z ręki użytkownika).
 */
const INTERRUPTIBLE_STATES: readonly SessionState[] = [
  'running', 'waiting-input', 'waiting-permission', 'waiting-question',
];

/** Stany, z których `resumed` wraca do `running` (spec: wyjścia stanów nieterminalnych). */
const RESUMABLE_FROM: readonly SessionState[] = [
  'resumable', 'interrupted', 'error', 'limit-reached',
];

/**
 * Stany, z których zewnętrzny agent może zacząć pracę.
 *
 * Szeroka lista jest celowa: turę odpala CZŁOWIEK w terminalu, a nie Rarog, więc panel potrafi
 * ruszyć z każdego stanu, w którym Rarog go zostawił — także z `error` i `limit-reached`
 * (limit planu minął, użytkownik pisze dalej). `running` nie jest wymienione, bo przejście
 * i tak byłoby identycznością.
 */
const AGENT_WORKING_FROM: readonly SessionState[] = [
  'starting', 'waiting-input', 'waiting-permission', 'waiting-question',
  'resumable', 'interrupted', 'error', 'limit-reached',
];

/**
 * Stany, z których „agent skończył i czeka" prowadzi do `waiting-input`.
 *
 * Świadomie BEZ `error` i `limit-reached`: te niosą informację, której herdrowe `idle` nie
 * unieważnia (herdr widzi tylko, że ekran przestał się ruszać), a skasowanie ich zamieniłoby
 * kartę błędu w kartę „gotowe".
 */
const AGENT_IDLE_FROM: readonly SessionState[] = [
  'starting', 'running', 'waiting-permission', 'waiting-question', 'interrupted', 'resumable',
];

/**
 * Stany, z których dialog w terminalu prowadzi do `waiting-permission`.
 *
 * Lista jest tak szeroka jak `AGENT_WORKING_FROM` — i to celowo szerzej niż `AGENT_IDLE_FROM`.
 * `blocked` to OBSERWACJA herdr z ekranu (parser widzi stojący dialog), nie zgadywanie
 * z „ekran przestał się ruszać" jak przy `idle`: dialog stoi = ktoś przy biurku wznowił turę
 * i agent czeka na decyzję, niezależnie od tego, w jakim stanie Rarog tę sesję zostawił.
 * Dlatego `error`, `limit-reached` i `resumable` TEŻ tu są:
 * bez nich dialog po ponowieniu z błędu nie przestawiłby stanu, więc chip i push milczałyby,
 * a karta stałaby w terminalu. `AGENT_IDLE_FROM` tych trzech NADAL nie zawiera — herdrowe `idle`
 * jest za słabym dowodem, żeby skasować kartę błędu (komentarz przy tamtej tablicy).
 */
const AGENT_BLOCKED_FROM: readonly SessionState[] = [
  'starting', 'running', 'waiting-input', 'waiting-question', 'interrupted',
  'resumable', 'error', 'limit-reached',
];

/** Detail ustawiany przez managera przy `result: error_max_turns` (UI pokazuje „Wznów"). */
export const MAX_TURNS_DETAIL = say('state.max-turns');

/** `done` jest jedynym stanem terminalnym. */
export function isTerminal(state: SessionState): boolean {
  return state === TERMINAL_STATE;
}

/**
 * The zero turn of a session started without a prompt: `init` and a successful `result`, so the card waits for the
 * first message. A card that already stands on a decision (a start dialog whose card came before the launch result)
 * keeps it: the synthetic `result` would take it to a sendable `waiting-input` while the dialog stands in the terminal.
 * The pane's `idle` after the answer ends that dialog like any other.
 */
export function zeroTurnEvents(state: SessionState): readonly SmEvent[] {
  if (state === 'waiting-permission' || state === 'waiting-question') return [];
  return [{ type: 'driver-init' }, { type: 'result', subtype: 'success' }];
}

/**
 * Czysta funkcja przejścia.
 *
 * @param state stan bieżący
 * @param ev    zdarzenie z drivera / managera / cyklu życia backendu
 * @returns stan po przejściu; identyczność, gdy zdarzenie nie pasuje do stanu
 */
export function transition(state: SessionState, ev: SmEvent): SessionState {
  // `done` jest terminalny — żadne zdarzenie go nie rusza.
  if (isTerminal(state)) return state;

  switch (ev.type) {
    case 'driver-init':
      return state === 'starting' ? 'running' : state;

    case 'turn-start':
      return state === 'waiting-input' || state === 'starting' ? 'running' : state;

    case 'result': {
      if (!ACTIVE_TURN_STATES.includes(state)) return state;
      switch (ev.subtype) {
        // Streaming input zostaje otwarty — czekamy na kolejny prompt użytkownika.
        case 'success': return 'waiting-input';
        // Limit tur to NIE limit planu: sesja jest przerwana i wznawialna.
        case 'error_max_turns': return 'interrupted';
        case 'error': return 'error';
      }
      return state;
    }

    case 'permission-requested':
      return state === 'running' ? 'waiting-permission' : state;

    case 'permission-resolved':
      return state === 'waiting-permission' ? 'running' : state;

    case 'question-requested':
      return state === 'running' ? 'waiting-question' : state;

    case 'question-resolved':
      return state === 'waiting-question' ? 'running' : state;

    case 'interrupt-requested':
      return INTERRUPTIBLE_STATES.includes(state) ? 'waiting-input' : state;

    case 'prompt-blocked':
      return state === 'starting' || state === 'running' ? 'waiting-input' : state;

    // Wyjście procesu drivera liczy się tylko dla sesji żywej. Po `interrupted` / `error` /
    // `limit-reached` / `resumable` driver i tak zwykle wychodzi — nie kasujemy nim wyniku,
    // który użytkownik już widzi (ta sama reguła co „result po interrupted").
    case 'driver-exit':
      if (!LIVE_STATES.includes(state)) return state;
      return ev.ok ? 'done' : 'error';

    case 'limit-reached':
      return LIVE_STATES.includes(state) ? 'limit-reached' : state;

    // Restart backendu: pending przepada fizycznie, więc każdy stan nieterminalny → resumable.
    case 'backend-restart':
      return 'resumable';

    case 'closed':
      return 'done';

    case 'resumed':
      return RESUMABLE_FROM.includes(state) ? 'running' : state;

    // Stan `unknown` z herdr NIE ma tu odpowiednika: driver go nie emituje, bo zgadywanie
    // „skończył" na podstawie nieczytelnego ekranu byłoby UI, które kłamie (reguła 11.3).
    case 'agent-working':
      return AGENT_WORKING_FROM.includes(state) ? 'running' : state;

    case 'agent-idle':
      return AGENT_IDLE_FROM.includes(state) ? 'waiting-input' : state;

    // `waiting-permission` sesji herdr istnieje BEZ wpisu w `PendingInteractions` — Rarog wie,
    // że dialog stoi w terminalu, ale nie zna jego treści ani opcji. UI renderuje wtedy chip
    // i „Odrzuć dialog (Esc)" zamiast kart zgody (pusta tablica `pendingPermissions`).
    case 'agent-blocked':
      return AGENT_BLOCKED_FROM.includes(state) ? 'waiting-permission' : state;
  }

  // Nieznany wariant zdarzenia (np. nowszy serwer w przyszłości) — identyczność, nigdy wyjątek.
  return state;
}
