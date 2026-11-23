/**
 * Seen marks of a session card: the fields `seen`, `seenByHuman`, `seenBy`, `unseenByHuman` and
 * `herdrSeen` of {@link Session}, their durable store entry and the herdr `agent.focus` that clears `done`.
 * Functions over one session; the manager passes its configuration as {@link SeenMarksDeps} and keeps the session
 * lookup, the `focus()` gate and the adoption of a pane. This module does not import `manager.ts`.
 */
import type { SessionState } from '@rarog/shared';
import type { SeenBy } from '@rarog/shared/rest';
import { say } from '@rarog/shared/sentences';
import type { DriverEvent } from '../drivers/types.ts';
import type { HerdrAgent, HerdrSupervisor } from '../herdr/types.ts';
import type { NotifierLike } from '../notify/index.ts';
import { noResultTurn } from '../notify/policy.ts';
import { inReadConversation } from './companion-scope.ts';
import { BadStateError } from './errors.ts';
import type { Session } from './session.ts';
import type { SmEvent } from './state-machine.ts';
import { WORKING_STATES, inTurn, startsTurn } from './state-sentences.ts';

/** Durable store of seen marks (`HerdrManagerDeps.seen`); the contract is described at that field. */
export interface SeenMarkStore {
  seq(key: string, agentSessionId: string): number | undefined;
  /** `by` = who received when it was not a human; absent = a human. The entry keeps the last receipt's `by`. */
  mark(key: string, agentSessionId: string, stateChangeSeq: number, by?: SeenBy): void;
  /** `by` of the receipt entry at this address; `undefined` for a human receipt, an "unread" entry or none. */
  seenBy(key: string, agentSessionId: string): SeenBy | undefined;
  unseenSeq(key: string, agentSessionId: string): number | undefined;
  markUnseen(key: string, agentSessionId: string, stateChangeSeq: number): void;
}

/**
 * The voice agent's pick-up (`POST …/seen` with `by`, `stateSince` and `conversation`): who picks up, and the
 * `stateSince` and the engine conversation of the result it read.
 */
export interface SeenPickUp {
  readonly by: SeenBy;
  readonly stateSince: string;
  /**
   * The body's conversation token as a check of a conversation id; the route builds it as for a send
   * (`SendMessageOptions.conversation`).
   */
  readonly conversation: (agentSessionId: string | undefined) => boolean;
}

/** What the seen-mark functions read from the manager configuration. */
export interface SeenMarksDeps {
  readonly store: SeenMarkStore | undefined;
  readonly notifier: NotifierLike | undefined;
  readonly herdrSeenFocus: boolean | undefined;
  readonly herdrSend: boolean | undefined;
  readonly herdrSupervisor: HerdrSupervisor | undefined;
  readonly logger: ((line: string) => void) | undefined;
  readonly emitSessionChanged: (session: Session) => void;
  /** A permission card, a question or a consent channel card in `pending` waits on the session for a human. */
  readonly decisionStands: (session: Session) => boolean;
}

/**
 * „Obejrzałem to na telefonie" — znacznik lokalny PLUS zgaszenie `done` w herdr.
 *
 * herdr nie ma metody „oznacz obejrzane": `seen` jest tam polem do filtrowania panelu
 * agentów, a jedynym, co je zapala, jest FOKUS panelu (`herdr --skill`: „Focusing the tab or
 * targeting the pane or agent with a focus command marks it seen. CLI reads do not mark it
 * seen."). Znacznik wyłącznie lokalny ma za wysoką cenę: herdr na Macu pokazywałby kilkanaście
 * „ukończonych, nieobejrzanych" sesji, mimo że każdą obejrzano na telefonie.
 *
 * Znacznik jest więc DWUCZĘŚCIOWY i obie części są potrzebne:
 * 1. lokalny, trwały (przeżywa restart Raroga) i przebijany przez NOWSZY wynik — zapisujemy
 *    numer stanu, przy którym wynik obejrzano, a wyższy numer unieważnia go sam;
 * 2. `agent.focus`, ale WYŁĄCZNIE wtedy, gdy naprawdę jest co gasić (`seen === false`, czyli
 *    Rarog wie o stojącym `done`) — patrz {@link clearHerdrDone}.
 *
 * Idempotentne i ciche dla karty, która i tak nie stoi w sekcji uwagi — 17 kart otwieranych
 * po kolei nie ma prawa dać 17 ramek SSE bez żadnej zmiany ANI 17 przestawień widoku herdr.
 *
 * `pickUp` = the voice agent across sessions picks up the result it read (`docs/companion.md`, "Picking up a
 * result"). The same receipt with the same effects (the push goes, `agent.focus` for a standing `done`), plus
 * `seenBy`, but only for the result it read ({@link pickUpMeetsResult}): otherwise a {@link BadStateError} before any
 * effect, the push included. A result already received is left as it is. A human receipt after it (the session opened
 * in the app) takes `seenBy` away, with a frame and without `agent.focus`: the result is received already, so there is
 * no `done` badge to clear.
 */
export function markSeen(session: Session, deps: SeenMarksDeps, pickUp?: SeenPickUp): void {
  if (pickUp !== undefined && !pickUpMeetsResult(session, deps, pickUp)) {
    throw new BadStateError(say('session.seen-result-changed'));
  }
  /*
   * Powiadomienie gasimy PRZED wszystkimi wyjściami niżej i to jest celowe.
   * „Obejrzałem" jest tu faktem o CZŁOWIEKU, a te wyjścia dotyczą znacznika: sesja bez
   * panelu herdr nie ma czego gasić w `done`, a `seen === true` znaczy tylko, że znacznik
   * już stoi. Żadne z tego nie zmienia tego, że właśnie otworzyłeś tę sesję — a to jest
   * najmocniejszy dowód „obsłużone", jaki ten system ma.
   */
  deps.notifier?.seen(session.id);
  /*
   * Zerknięcie w transkrypt W TRAKCIE tury nie odbiera wyniku, którego jeszcze nie ma.
   * Skoro `seen` znaczy „wynik BIEŻĄCEJ tury odebrany", zapis
   * znacznika w `starting`/`running` byłby kłamstwem na zapas: karta skończonej tury
   * wylądowałaby od razu w ogonie „bezczynni", a trwały wpis z `herdrSeq` sprzed końca
   * pracy chowałby wynik także po restarcie Raroga. Powiadomienie wyżej zostaje zgaszone
   * — ono dotyczy człowieka, który właśnie patrzy.
   */
  if (WORKING_STATES.includes(session.state)) return;
  // A real receipt, also of a result whose receipt was only carried over: a late tool call keeps it.
  if (session.seenCarry === 'restored') session.seenCarry = undefined;
  const key = session.herdrKey;
  // Sesja bez panelu nie ma znacznika `done` do zgaszenia (i nie ma jak go zapisać).
  if (key === undefined) return;
  if (session.seen === true) {
    if (pickUp === undefined && session.seenBy !== undefined) {
      session.seenBy = undefined;
      rememberSeenMark(session, deps.store);
      deps.emitSessionChanged(session);
    }
    return;
  }
  /*
   * `seen === false` (a NIE `undefined`) jest jedynym stanem, w którym Rarog WIE, że w herdr
   * stoi `done`: pole bierze się wprost ze statusu panelu (`herdrInitialState`) albo
   * ze zdarzenia `agent-state`. `undefined` znaczy „wynik czeka na odbiór,
   * ale badge'a w herdr nie widzieliśmy" (panel był na wierzchu w chwili końca tury) —
   * tam fokus niczego by nie zgasił, a przestawiłby widok na Macu za darmo.
   * Liczone PRZED zapisem, bo niżej `seen` jest już prawdą.
   */
  const clearsDone = session.seen === false;
  // Odbiór CZŁOWIEKA — w odróżnieniu od `seen: true` z adopcji panelu `idle`, którego nikt
  // nie czytał. Rozstrzyga o tym, czy spóźniony `done` z herdr cofnie ten odbiór (niżej,
  // `case 'agent-state'`). The voice agent's pick-up is such a receipt too, marked by `seenBy`.
  noteHumanReceipt(session);
  session.seenBy = pickUp?.by;
  rememberSeenMark(session, deps.store);
  deps.emitSessionChanged(session);
  if (clearsDone) clearHerdrDone(session, key, deps);
}

/**
 * Whether the voice agent's pick-up meets the result it read, checked synchronously right before the receipt:
 * - a result stands: the session is in `waiting-input`. A turn that waits for a decision has no result yet, and the
 *   answer to that decision (`permission-resolved`, `question-resolved`) goes back to the turn without a turn start,
 *   so a receipt taken there would cover the turn's real result;
 * - no decision card waits on it: a permission card or a question that comes after the turn end moves no state, so it
 *   can stand over the result in `waiting-input`;
 * - the `stateSince` is the session's current one. Equality, not order: a history import can move `stateSince` back,
 *   and the agent read another result then;
 * - the session is in the engine conversation the agent read ({@link inReadConversation}): `/clear` and `/resume`
 *   change it with no change of state or `stateSince`. A session without a conversation yet has no result the agent
 *   could have read.
 */
function pickUpMeetsResult(session: Session, deps: SeenMarksDeps, pickUp: SeenPickUp): boolean {
  if (session.state !== 'waiting-input' || deps.decisionStands(session)) return false;
  if (pickUp.stateSince !== session.stateSince) return false;
  if (session.engineSessionId === undefined || session.engineSessionId === '') return false;
  return inReadConversation(session, pickUp.conversation);
}

/**
 * „Oznacz jako nieprzeczytane" z listy — odwrotność {@link markSeen}, tylko lokalnie.
 *
 * Działa wyłącznie na wyniku, który stoi (`waiting-input`) i jest odebrany; poza tym nic nie robi:
 * w stanach pracy wyniku jeszcze nie ma (start tury i tak zeruje `seen`), a karty błędu, przerwania
 * czy limitu stoją w uwadze niezależnie od `seen`.
 *
 * `seen` wraca do `undefined` („wynik czeka, badge'a w herdr nie ma"), NIE do `false`: `false`
 * znaczy „w herdr stoi `done`" i uprawnia `agent.focus`, a tu badge'a nie ma — późniejsze
 * otwarcie sesji przestawiałoby widok na Macu za darmo. herdr nie ma metody, która postawi `done`
 * z powrotem, więc ta ścieżka nie woła herdr wcale i nie podlega `RAROG_HERDR_SEND`.
 *
 * Zerowane są wszystkie trzy pola odbioru, jak na starcie tury. `herdrSeen` dlatego, że po
 * `markSeen()` z fokusem zostaje `false` do nadejścia `idle` z herdr, a takie spóźnione `idle`
 * (reguła `done → idle` w `agent-state`) cofnęłoby świeże „nieprzeczytane". Stojący `done` nic nie
 * traci: najbliższy resync ustawia `seen: false` i `herdrSeen: false` od nowa. To samo spóźnione
 * `idle` podnosi numer stanu, więc pamięć {@link Session.unseenByHuman} przepisuje wtedy wpis trwały.
 */
export function markUnseen(session: Session, deps: SeenMarksDeps): void {
  if (session.state !== 'waiting-input' || session.seen !== true) return;
  session.seen = undefined;
  session.seenByHuman = undefined;
  // A human put back a result the voice agent picked up: the result waits for a human now.
  session.seenBy = undefined;
  session.herdrSeen = undefined;
  session.unseenByHuman = true;
  rememberUnseenMark(session, deps.store);
  deps.emitSessionChanged(session);
}

/**
 * Seen fields of a session after an `agent-state` event from herdr; `applyAgentStateEvent` in `driver-events.ts`
 * calls it after updating `herdrSeq`.
 */
export function applyHerdrSeen(
  session: Session, event: Extract<DriverEvent, { type: 'agent-state' }>, store: SeenMarkStore | undefined,
): void {
  /*
   * `seen: false` z herdr znaczy „stoi znacznik `done`", a nie „nikt tego nie widział":
   * herdr gasi `done` WYŁĄCZNIE fokusem panelu w terminalu, więc wynik obejrzany na
   * telefonie wisiałby w sekcji uwagi do końca dnia. Własny znacznik Raroga
   * przebija tę wartość dopóty, dopóki nie przyjdzie NOWSZY stan (wyższy numer).
   *
   * `seen: true` z herdr NIE jest odbiorem wyniku. Herdrowe
   * `idle` znaczy tylko „panel nie ma badge'a `done`", a to zdarza się także wtedy, gdy
   * panel stał na wierzchu w chwili końca tury — wtedy `done` nie powstaje wcale
   * (zmierzone w `herdr agent list`: żaden skończony panel go nie miał) i resync
   * powtarza `idle` co 30 s, co trzymałoby świeży wynik w zwiniętym ogonie „bezczynni"
   * na zawsze. Odbiorem jest więc WYŁĄCZNIE przejście `done → idle`: ktoś sfokusował
   * panel, na którym stał badge. Stąd pamięć surowej wartości w `herdrSeen`.
   */
  if (event.seen === false) {
    /*
     * Odbiór z telefonu WYPRZEDZA `done` z herdr i to jest reguła, nie wyjątek: koniec
     * tury Rarog widzi najpierw z jsonl, a push `done` przychodzi po karencji albo
     * dopiero z resyncu (do 30 s). Gdyby `done` liczył się wtedy od zera, karta
     * przeczytana na telefonie wracałaby do głowy listy kilkanaście sekund później —
     * i już by tam została, bo front drugiego `POST …/seen` nie wyśle (dedup po
     * `id|stateSince`, a `stateSince` się nie zmienia). Stąd `seenByHuman`: zerowane
     * na starcie tury, więc `true` może tu znaczyć wyłącznie „człowiek odebrał wynik
     * TEJ tury". Przy okazji przepisujemy znacznik trwały na numer `done` — inaczej
     * odbiór ginie przy restarcie Raroga.
     */
    if (session.seenByHuman === true && !seenSeqWentBack(session, store)) {
      session.seen = true;
      rememberSeenMark(session, store);
    } else {
      // Licznik herdr cofnięty = Rarog nie wie już nic o tym panelu (patrz niżej):
      // pamięć odbioru jest wtedy tak samo bezwartościowa jak znacznik trwały.
      session.seenByHuman = undefined;
      session.seen = seenMarkCovers(session, store);
      // A result that is not received has no receiver.
      if (!session.seen) session.seenBy = undefined;
    }
  } else if (event.seen === true && session.herdrSeen === false) {
    session.seen = true;
    // Focus of the pane is a real receipt: a late tool call no longer takes it back.
    session.seenCarry = undefined;
    /*
     * After the voice agent's pick-up this `idle` is usually the answer to its own `agent.focus`, with a higher state
     * number. The pick-up stays, and its durable entry moves to that number: the adoption after a Rarog restart
     * restores `seenBy` only at an equal number ({@link seenByOf}).
     */
    if (session.seenBy !== undefined) rememberSeenMark(session, store);
  }
  if (event.seen !== undefined) session.herdrSeen = event.seen;
  /*
   * Ręczne „nieprzeczytane" idzie za numerem stanu TEGO SAMEGO wyniku: spóźnione `idle`
   * po fokusie z `markSeen` podnosi `herdrSeq` bez nowej tury, a wpisu pod starym numerem adopcja
   * po restarcie Raroga by nie poznała. Odbiór regułą `done → idle` kończy
   * „nieprzeczytane"; start tury zeruje pamięć sam.
   */
  if (session.unseenByHuman === true && event.state === 'idle') {
    if (session.seen === true) session.unseenByHuman = undefined;
    else rememberUnseenMark(session, store);
  }
}

/**
 * A turn start clears the receipt of the previous result: `seen`, the raw herdr badge memory `herdrSeen`, the
 * receipt `seenByHuman` and its receiver `seenBy`. `#applyTransition` calls it for the events that start a turn
 * (`startsTurn`). The receiver of a received result waits in `seenCarryBy` for {@link carrySeenAcrossTurn}; a turn
 * start inside a running turn (`agent-blocked`, nothing received by then) keeps the one from the turn's real start.
 */
export function clearReceipt(session: Session): void {
  if (session.seen === true) session.seenCarryBy = session.seenBy;
  session.seen = undefined;
  session.seenByHuman = undefined;
  session.seenBy = undefined;
  session.herdrSeen = undefined;
  // Ręczne „nieprzeczytane" dotyczyło wyniku poprzedniej tury.
  session.unseenByHuman = undefined;
}

/**
 * A turn without a result keeps the received result of the previous turn. Such a turn (`noResultTurn`:
 * started by a subagent standby notice alone, or by an artifact notification or a context compaction alone with no
 * tool call) leaves nothing new to read, so its end must not light the card as a new result once the previous one
 * was received.
 *
 * `#applyTransition` calls this after the turn start has cleared the seen fields and before it sends the session
 * frame, so the restored receipt goes out in that frame. Received means `seen === true` before the clearing; a
 * result marked unread by hand is not received. An incomplete tally (`undefined`) restores nothing.
 * No `agent.focus`: the herdr view on the Mac stays as it is; a later `done` keeps the receipt through
 * `seenByHuman` ({@link applyHerdrSeen}). A result the voice agent received comes back as its receipt (`seenBy`).
 */
export function carrySeenAcrossTurn(
  session: Session, event: SmEvent, from: SessionState, leavesTurn: boolean, resultSeen: boolean,
  store: SeenMarkStore | undefined,
): void {
  // A decision inside a running turn (`agent-blocked`) is not a new turn: the mark from its real start stays.
  if (startsTurn(event) && !inTurn(from)) {
    session.seenCarry = resultSeen ? 'armed' : undefined;
    if (!resultSeen) session.seenCarryBy = undefined;
  }
  if (!leavesTurn) return;
  const restores = session.seenCarry === 'armed' && noResultTurn(session.turnInput);
  const by = session.seenCarryBy;
  session.seenCarry = restores ? 'restored' : undefined;
  session.seenCarryBy = undefined;
  if (!restores) return;
  session.seen = true;
  session.seenByHuman = true;
  session.seenBy = by;
  rememberSeenMark(session, store);
}

/**
 * A tool call reached the manager from the file after the end of an artifact-only turn: the turn had a
 * result after all, so the receipt restored by {@link carrySeenAcrossTurn} goes away. The durable store gets an
 * "unread" entry at the current state number, because the receipt entry written at the turn end would otherwise
 * cover the same `done` at the next resync and at the adoption after a Rarog restart. A real receipt in between
 * ({@link noteHumanReceipt}, `done → idle` in {@link applyHerdrSeen}) ends the carry, so nothing is taken back.
 */
export function dropCarriedSeen(session: Session, deps: SeenMarksDeps): void {
  if (session.seenCarry !== 'restored') return;
  session.seenCarry = undefined;
  session.seen = undefined;
  session.seenByHuman = undefined;
  session.seenBy = undefined;
  rememberUnseenMark(session, deps.store);
  deps.emitSessionChanged(session);
}

/**
 * The human received the result (`markSeen`, "Show in herdr" in `Manager.focus`): `seen` and `seenByHuman` go to
 * `true`, a manual "unread" ends, and so does a receipt carried over a turn without a result. The receipt is the
 * human's: `seenBy` goes.
 */
export function noteHumanReceipt(session: Session): void {
  session.seen = true;
  session.seenByHuman = true;
  session.seenBy = undefined;
  session.unseenByHuman = undefined;
  session.seenCarry = undefined;
}

/**
 * Trwały znacznik „ten wynik obejrzałem z telefonu" pod BIEŻĄCYM numerem stanu panelu.
 *
 * Osobna metoda, bo zapis ma dziś DWA momenty. Tapnięcie karty wyprzedza `done`
 * z herdr: koniec tury Rarog widzi najpierw z jsonl, więc `herdrSeq` jest wtedy numerem
 * zdarzenia `working`, a `seenMarkCovers` porównuje RÓWNOŚCIĄ — taki znacznik przestałby
 * pokrywać stan panelu w chwili, w której herdr dośle `done` z numerem wyższym, i karta
 * wracałaby do głowy listy kilkanaście sekund po przeczytaniu (a po restarcie Raroga
 * na stałe). Dlatego ten sam zapis leci drugi raz przy tym `done`; magazyn ignoruje zapis
 * numerem NIŻSZYM albo równym, więc powtórka nic nie kosztuje.
 *
 * Adres znacznika to uuid sesji SILNIKA — dla Codexa mieszka on w osobnym polu, bo
 * indeksu pisarzy jsonl nie dotyczy. Bez uuidu albo bez numeru stanu znacznik byłby
 * zgadywaniem (po restarcie serwera herdr numery startują od nowa), więc wtedy nie
 * zapisujemy nic: karta i tak schodzi z sekcji uwagi, tyle że tylko w tym procesie.
 */
export function rememberSeenMark(session: Session, store: SeenMarkStore | undefined): void {
  const key = session.herdrKey;
  const engineSessionId = session.engineSessionId ?? session.observedSessionId;
  const seq = session.herdrSeq;
  if (key === undefined || engineSessionId === undefined || seq === undefined) return;
  store?.mark(key, engineSessionId, seq, session.seenBy);
}

/** Ręczne „nieprzeczytane" pod tym samym adresem i numerem co {@link rememberSeenMark}. */
export function rememberUnseenMark(session: Session, store: SeenMarkStore | undefined): void {
  const key = session.herdrKey;
  const engineSessionId = session.engineSessionId ?? session.observedSessionId;
  const seq = session.herdrSeq;
  if (key === undefined || engineSessionId === undefined || seq === undefined) return;
  store?.markUnseen(key, engineSessionId, seq);
}

/**
 * Gasi znacznik `done` PO STRONIE HERDR po obejrzeniu wyniku na telefonie.
 *
 * `agent.focus` jest jedyną dźwignią, jaką herdr na to daje, więc ta metoda ma dokładnie
 * jedno zadanie: zapłacić za nią możliwie rzadko. Stąd wołanie WYŁĄCZNIE z `markSeen()`
 * i wyłącznie dla panelu, o którym Rarog wie, że stoi na `done` — czyli tyle razy, ile jest
 * nieodebranych wyników, a nie tyle razy, ile razy ktoś wszedł w transkrypt.
 *
 * Cztery rzeczy, które są tu świadome:
 * 1. **Nie rzuca i nie czeka.** `POST …/seen` to porządkowanie listy, a nie akcja
 *    użytkownika: nieudany `agent.focus` kosztuje tylko tyle, że badge zostaje w herdr,
 *    i ani jednego czerwonego zdania na telefonie.
 * 2. **Znacznik lokalny zostaje** niezależnie od wyniku — on jest prawdą o CZŁOWIEKU,
 *    a nie o tym, czy gniazdo herdr odpowiedziało.
 * 3. **Ta sama bramka co „Pokaż w herdr"** (`focus()`): `RAROG_HERDR_SEND=0` i `readOnly`
 *    z nadzorcy. `agent.focus` przestawia CUDZY terminal, więc nie ma tu taryfy ulgowej
 *    za to, że wywołanie jest mimochodem — jest odwrotnie.
 * 4. **Cisza przy niedostępnym gnieździe.** `focus()` mapuje to na 409 dla człowieka;
 *    tutaj 409 nie miałoby adresata, więc zostaje linia w logu.
 */
export function clearHerdrDone(session: Session, key: string, deps: SeenMarksDeps): void {
  if (deps.herdrSeenFocus === false) return;
  if (deps.herdrSend === false) return;
  const supervisor = deps.herdrSupervisor;
  if (supervisor === undefined) return;
  const status = supervisor.status();
  if (!status.available || status.readOnly) return;
  void supervisor.focus(key).catch((err: unknown) => {
    deps.logger?.(
      `seen ${session.id}: agent.focus failed (${describeError(err)}) — `
      + 'badge `done` stays in herdr',
    );
  });
}

/**
 * Czy licznik `state_change_seq` COFNĄŁ się od chwili zapisania znacznika?
 *
 * Jedyna przyczyna: `herdr update --handoff` restartuje serwer, a ten startuje numerację od
 * zera (zmierzone). Po takiej przerwie Rarog nie widział panelu przez jakiś czas,
 * więc tura mogła się w nim zacząć i skończyć bez ani jednego zdarzenia — i dlatego cofnięty
 * licznik unieważnia nie tylko znacznik trwały, ale i pamięć odbioru z RAM. Ta sama zasada co
 * w {@link seenMarkCovers}: zbędny badge kosztuje jedno spojrzenie, zgubiony —
 * przegapioną turę.
 */
export function seenSeqWentBack(session: Session, store: SeenMarkStore | undefined): boolean {
  const key = session.herdrKey;
  const engineSessionId = session.engineSessionId ?? session.observedSessionId;
  const current = session.herdrSeq;
  if (store === undefined || key === undefined || engineSessionId === undefined) return false;
  if (current === undefined) return false;
  const stored = store.seq(key, engineSessionId);
  return stored !== undefined && stored > current;
}

/**
 * Czy trwały znacznik „widziane" opisuje DOKŁADNIE ten stan panelu?
 *
 * Porównanie jest RÓWNOŚCIĄ, nie „nie nowszy niż", i to jest cała jego ostrożność:
 * `state_change_seq` rośnie monotonicznie przez całe życie serwera herdr, więc numer WYŻSZY
 * znaczy nowy wynik (badge wraca), a numer NIŻSZY znaczy, że herdr wystartował od nowa
 * i wyzerował licznik (zmierzone). W tym drugim przypadku zapamiętany numer nie
 * opisuje już niczego — a wtedy lepiej pokazać badge zbędnie niż schować prawdziwy wynik.
 */
export function seenMarkCovers(session: Session, store: SeenMarkStore | undefined): boolean {
  const key = session.herdrKey;
  // Ta sama para adresów co w `markSeen()` — inaczej znacznik Codexa dałoby się zapisać,
  // ale nigdy odczytać.
  const engineSessionId = session.engineSessionId ?? session.observedSessionId;
  const current = session.herdrSeq;
  if (store === undefined || key === undefined || engineSessionId === undefined) return false;
  // Brak numeru bieżącego = nie wiadomo, czy wynik jest nowszy od obejrzanego. Ta sama
  // reguła: zbędny „nowy wynik" kosztuje jedno spojrzenie, zgubiony — przegapioną turę.
  if (current === undefined) return false;
  return store.seq(key, engineSessionId) === current;
}

/**
 * To samo pytanie dla panelu, który dopiero staje się kartą (`appeared`).
 *
 * Bez rozgałęzienia na silnik i to jest poprawne: `agentSessionId` wpisu z herdr niesie uuid
 * TEGO silnika, który w panelu siedzi (dla Codexa — rollout), a znacznik jest zapisany
 * dokładnie pod tym uuidem. Rozejście się pól zaczyna się dopiero w `Session`.
 */
export function wasSeen(agent: HerdrAgent, store: SeenMarkStore | undefined): boolean {
  if (store === undefined) return false;
  return store.seq(agent.key, agent.agentSessionId) === agent.stateChangeSeq;
}

/**
 * Who received the result of a pane that becomes a card, when it was not a human: the `by` of the durable receipt
 * entry, only at exactly the pane's state number (the same address and equality as {@link wasSeen}). Another number
 * may be another result, which nobody picked up.
 */
export function seenByOf(agent: HerdrAgent, store: SeenMarkStore | undefined): SeenBy | undefined {
  if (store === undefined || store.seq(agent.key, agent.agentSessionId) !== agent.stateChangeSeq) return undefined;
  return store.seenBy(agent.key, agent.agentSessionId);
}

/** Ręczne „nieprzeczytane" przy tym samym numerze stanu — ten sam adres co {@link wasSeen}. */
export function wasMarkedUnseen(agent: HerdrAgent, store: SeenMarkStore | undefined): boolean {
  if (store === undefined) return false;
  return store.unseenSeq(agent.key, agent.agentSessionId) === agent.stateChangeSeq;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
