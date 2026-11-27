/**
 * Polityka powiadomień — CZYSTE reguły „czy o tym zawiadamiać i po jakim czasie".
 *
 * Moduł nie zna ani kanału wysyłki, ani obecności, ani zegara: dostaje fakty, oddaje werdykt. Cała
 * mechanika (timery, wysyłka, token) mieszka w `index.ts`, a obecność w `presence.ts`. Powód
 * podziału jest praktyczny — reguły są tu jedyną rzeczą, którą trzeba umieć przeczytać i obronić,
 * a każda z nich odpowiada na konkretny błąd powiadomień.
 *
 * Zasady, z których wynika reszta pliku:
 *
 * 1. **Powiadomienie opisuje STAN, KTÓRY SIĘ UTRZYMAŁ, nie zdarzenie.** Nie „właśnie skończył",
 *    tylko „ten panel od minuty czeka i nikt na niego nie spojrzał". Level-triggered.
 * 2. **Odkładamy decyzję, nie kasujemy alertu.** Obecność w oknie oczekiwania przesuwa
 *    sprawdzenie o kolejne okno. Jednorazowe „sprawdź po minucie" tłumiło alerty dokładnie
 *    wtedy, gdy człowiek zaglądał, czy przyszły.
 * 3. **Koniec tury ≠ koniec pracy.** Tura domknięta przy żywych subagentach albo workflow to
 *    cisza — agent oddał głos tylko po to, żeby czekać na własne tło. Co z listy zadań jest
 *    „żywe", liczy `herdr/background/work.ts` (subagent w postoju nie jest); tu wchodzi
 *    gotowa liczba, przy uzbrojeniu i drugi raz tuż przed wysyłką.
 * 4. **Koniec tury, w której nic się nie skończyło, to cisza.** Tura wywołana samym meldunkiem
 *    o postoju subagenta nie daje „gotowe", tak samo tura po samym meldunku o końcu
 *    obserwacji artefaktu, w której agent nie użył narzędzia, i tura po samej
 *    kompakcji kontekstu bez narzędzia; wszystkie rozpoznaje {@link noResultTurn}.
 * 5. **Wynik, o którym nie było banera, zostaje zaległy.** Zasady 3 i 4 razem potrafiły zgubić
 *    wynik zwykłej tury na całą noc; zaległe „gotowe" wychodzi po pierwszej turze, po której
 *    w tle nic nie pracuje, także po turze bez wyniku ({@link leavesResult}). Po takiej
 *    turze czeka jednak dalej, dopóki subagent w postoju czeka na własną komendę
 *    ({@link doneOrSilence}): etap, którego wynik jest zaległy, jeszcze trwa. Wychodzi
 *    też przy ciszy w tle bez końca tury (`Notifier.quiet` w `index.ts`);
 *    przy wysyłce sprawdza wtedy te same warunki co po turze bez wyniku
 *    ({@link DecideInput.owedRelease}).
 */
import type { SessionState } from '@rarog/shared';
import type { SmEvent } from '../sessions/state-machine.ts';
import type { NotifyKind } from '@rarog/shared/notify-copy';

/**
 * Klasa zdarzenia. Dobrana tak, żeby dało się ją usłyszeć bez patrzenia (inny dźwięk) i żeby
 * każda miała INNY warunek wygaszenia — patrz {@link stillHolds}.
 */
export type NotifyClass =
  /** Praca STOI i ruszy dopiero po Twojej decyzji. Minuta zwłoki kosztuje. */
  | 'blocking'
  /** Nikt nie czeka, ale bez Ciebie nie ruszy: błąd tury, limit planu, limit tur. */
  | 'failure'
  /** Jest co odebrać. Nigdy natychmiast — agent w pętli kończy turę co kilkanaście sekund. */
  | 'done';

/**
 * RODZAJ zdarzenia — to, co człowiek ma przeczytać w TYTULE banera. Klasa ({@link NotifyClass})
 * mówi harmonogramowi, jak długo czekać i kiedy wygasić; rodzaj mówi odbiorcy, CO się stało:
 * „czeka na zgodę" i „pyta" to ta sama klasa `blocking`, ale zupełnie inna decyzja do podjęcia.
 */
export type { NotifyKind } from '@rarog/shared/notify-copy';

/** Rodzaj dla zdarzeń, które {@link classify} uznaje za warte banera; `null` dla reszty. */
export function kindOf(event: SmEvent): NotifyKind | null {
  switch (event.type) {
    case 'permission-requested': return 'permission';
    case 'question-requested': return 'question';
    case 'agent-blocked': return 'blocked';
    case 'result': return event.subtype === 'success' ? 'done' : 'error';
    case 'limit-reached': return 'limit';
    case 'agent-idle': return 'done';
    // Prompt zablokowany przez hook — cisza (patrz `classify`), wymieniony z nazwy, nie przez `default`.
    case 'prompt-blocked': return null;
    default: return null;
  }
}

/**
 * Rachunek tury, która właśnie się kończy, od poprzedniego końca tury: wiadomości roli `user`,
 * czyli to, co mogło ją wywołać, i wywołania narzędzi przez głównego agenta, czyli to, czy coś
 * w niej zrobił. Liczy manager; tu zapada tylko decyzja.
 */
export interface TurnInput {
  /** Notki o POSTOJU subagenta (`notice.outcome === 'waiting'`). */
  readonly standbyNotices: number;
  /**
   * Notki o końcu obserwacji artefaktu (`notice.kind === 'artifact-watch'`): artefakt usunięty,
   * publiczny spoza organizacji albo zmiana konta. Liczone osobno od {@link other}.
   */
  readonly artifactWatch: number;
  /**
   * Każda inna wiadomość: prompt człowieka (z Raroga albo z terminala), notka o innym wyniku
   * (koniec komendy, koniec subagenta), wiadomość od subagenta, zaplanowane wybudzenie.
   */
  readonly other: number;
  /**
   * Wywołania narzędzi przez GŁÓWNEGO agenta: bloki `tool-call` jego wiadomości z pliku rozmowy
   * (subagent pisze do własnego pliku i tu się nie liczy). Ta sama granica co wiadomości wyżej.
   */
  readonly toolCalls: number;
  /**
   * Context compaction boundaries of the main thread (`system`/`compact_boundary`): Claude Code compacts an
   * idle conversation before the prompt cache expires, and that turn has no other input. Counted apart from
   * {@link other}; a manual `/compact` brings its prompt, so it counts in `other` too.
   */
  readonly compactions: number;
}

export interface ClassifyInput {
  /** Zdarzenie, które WYWOŁAŁO przejście — nie para stanów. Patrz komentarz w `classify`. */
  readonly event: SmEvent;
  /**
   * Ile zadań w tle (subagenci, workflow, `run_in_background`) PRACUJE w chwili przejścia —
   * `tasksHoldingDonePush` z `herdr/background/work.ts`. Subagent w postoju się nie liczy.
   */
  readonly backgroundTasks: number;
  /**
   * `agent-idle` karty ODTWORZONEJ po restarcie serwera herdr: herdr zabił proces,
   * `claude --resume` wstał w nowym panelu i się załadował — żadna tura się nie skończyła.
   */
  readonly afterHerdrRestore?: boolean;
  /**
   * Przejście SESJI, KTÓRA WSTAJE: wyjście wprost ze `starting` (pierwsze `idle`
   * panelu zastanego w `unknown`, sesji z Raroga przed gotowością) albo tura zerowa sesji bez promptu (nowa
   * pusta sesja, wznowienie). Żadna tura się nie skończyła, więc „gotowe” milczy; inne klasy bez zmian.
   * Liczy manager (`#applyTransition`).
   */
  readonly afterStart?: boolean;
  /**
   * A test session: its working directory lies in a temporary directory (`sessions/test-session.ts`), so another
   * agent runs it for tests or measurements. Its "done" is silent and leaves no owed result; other classes are
   * unchanged, because a dialog or an error of a helper session still stops work. Absent = no.
   */
  readonly testSession?: boolean;
  /**
   * Co wywołało kończącą się turę. Nieobecne = nie wiadomo, czyli zwykłe zachowanie: wołający
   * nie liczy albo jego rachunek jest niepełny (podpięcie w trakcie tury, wiadomość, która mogła
   * jeszcze nie dojść z pliku). Liczy się WYŁĄCZNIE dla klasy „gotowe" — {@link noResultTurn}.
   */
  readonly turnInput?: TurnInput;
  /**
   * „Gotowe" tej sesji jest ZALEGŁE: wcześniejsza zwykła tura zostawiła wynik, o którym baner nie
   * wyszedł, a człowiek go nie obejrzał ({@link leavesResult}). Pamięta to harmonogram
   * (`index.ts`); tu znosi tylko ciszę po turze bez wyniku ({@link noResultTurn}).
   */
  readonly doneOwed?: boolean;
  /**
   * Na liście zadań stoi subagent w postoju z żywą własną komendą: `waitingOnOwnCommand`
   * z `herdr/background/work.ts`, liczone przez managera w chwili przejścia. Nieobecne = nie.
   * Liczy się WYŁĄCZNIE dla zaległego „gotowe" po turze bez wyniku ({@link doneOrSilence}).
   */
  readonly waitingOnOwnCommand?: boolean;
}

/**
 * Tura BEZ WYNIKU: wywołał ją sam meldunek CLI, po którym nic się nie skończyło. Trzy rodzaje,
 * jedna reguła dla ciszy, zaległości i kontroli przy wysyłce.
 *
 * - **Subagent standby**: a subagent stops because it waits on its own command. The CLI reports this to the
 *   main agent with a `user`-role entry; the main agent writes a sentence ("still waiting") and ends the turn.
 *   One night can bring dozens of such notices, so a "done" for each would be noise. The agent's tool calls in
 *   such a turn change nothing.
 * - **Artifact watch ended**: deleting an artifact on claude.ai ends its watch in every session that published
 *   or read it; the model answers on its own within 2–5 s ("nothing to do"), also in a session finished long
 *   ago. Here the condition is also ZERO tool calls: an agent that did something after the notice (recreated
 *   the artifact, fixed a file) has a result to collect. A notice together with a standby falls under the same
 *   condition: with a tool call it gives "done".
 * - **Context compaction alone**: Claude Code compacts an idle conversation before the prompt cache
 *   expires; the pane works for under a minute and writes no reply (measured on CLI 2.1.325). Same condition as
 *   the artifact notification: no tool call.
 *
 * Wspólne: żadnej innej wiadomości `user` od poprzedniego końca tury. Cokolwiek innego — prompt
 * człowieka, notka o końcu komendy, raport subagenta — znaczy, że jest co odebrać. Tura bez żadnej
 * wiadomości `user` ma inną przyczynę, której Rarog nie zna, i daje zwykłe „gotowe",
 * a rachunek niepełny (`undefined`) też: brak pewności to zwykłe „gotowe".
 */
export function noResultTurn(turn: TurnInput | undefined): boolean {
  if (turn === undefined || turn.other > 0) return false;
  if (turn.artifactWatch > 0 || turn.compactions > 0) return turn.toolCalls === 0;
  return turn.standbyNotices > 0;
}

/**
 * Czy to zdarzenie jest końcem ZWYKŁEJ tury, czyli zostawia wynik do odebrania (zaległe
 * „gotowe").
 *
 * Od tej chwili „gotowe" jest zaległe, dopóki baner nie wyjdzie albo człowiek nie obejrzy sesji.
 * Bez tej pamięci dwie reguły ciszy gubiły wynik. Trzy przebiegi:
 *
 * - tura kończy się przy pracującym tle (cisza, zasada 3), potem subagent staje i każda kolejna
 *   tura jest turą po samym postoju (cisza, zasada 4), więc pierwsza cicha chwila może wypaść
 *   dopiero po turze z samym postojem, godziny później;
 * - tura kończy się przy cichym tle i uzbraja „gotowe", ale w oknie 15 s przychodzi meldunek
 *   o postoju. Start nowej tury zdejmuje uzbrojony baner, a sama jest turą po samym postoju;
 * - uzbrojone „gotowe" gaśnie przy sprawdzeniu, bo subagent ruszył ({@link doneStaysOwed}),
 *   a jego następny postój daje już tylko turę po samym postoju.
 *
 * Końcem zwykłej tury NIE jest: tura bez wyniku ({@link noResultTurn}: po samym postoju albo po
 * samym meldunku o artefakcie bez narzędzi), pierwsze `idle` karty odtworzonej po restarcie herdr
 * ani start sesji ({@link ClassifyInput.afterStart}) — w obu ostatnich żadna tura się nie skończyła.
 * Nor is the end of a turn of a test session ({@link ClassifyInput.testSession}): nobody owes the owner its result.
 */
export function leavesResult(input: ClassifyInput): boolean {
  if (kindOf(input.event) !== 'done') return false;
  if (input.afterHerdrRestore === true || input.afterStart === true || input.testSession === true) return false;
  return !noResultTurn(input.turnInput);
}

/**
 * Zdarzenie przejścia → klasa powiadomienia. `null` = cisza.
 *
 * Klasyfikujemy po ZDARZENIU, a nie po parze stanów, i to jest decyzja, nie wygoda: para stanów
 * gubi PRZYCZYNĘ. `waiting-input` osiągnięte przez `result: success` znaczy „agent skończył,
 * jest co odebrać", a to samo `waiting-input` osiągnięte przez `interrupt-requested` znaczy
 * „człowiek właśnie nacisnął Esc". Pierwsze zasługuje na push, drugie jest o człowieku, który
 * siedzi przy klawiaturze — i gdyby wyszedł zaraz po Esc, dostałby baner „gotowe" o czymś,
 * co sam przerwał.
 */
export function classify(input: ClassifyInput): NotifyClass | null {
  const { event } = input;
  switch (event.type) {
    // Praca stoi na Tobie — trzy drogi do tego samego: zgoda z SDK, pytanie i dialog,
    // który Rarog zobaczył w terminalu (`agent-blocked`) bez wpisu w jsonl.
    case 'permission-requested':
    case 'question-requested':
    case 'agent-blocked':
      return 'blocking';

    // Tura padła. `error_max_turns` jest tu razem z `error` świadomie: nikt nie czeka na
    // odpowiedź, ale sesja stanęła i nie ruszy, dopóki jej nie wznowisz.
    case 'result':
      if (event.subtype === 'success') return doneOrSilence(input);
      return 'failure';
    case 'limit-reached':
      return 'failure';

    // Skończył i czeka. `agent-idle` to ta sama treść co `result: success`, tylko widziana
    // przez herdr (turę odpalił człowiek w terminalu, nie Rarog).
    case 'agent-idle':
      if (input.afterHerdrRestore === true) return null;
      return doneOrSilence(input);

    /*
     * Reszta jest cicha, ale z RÓŻNYCH powodów — dlatego stoi wymieniona z nazwiska, a nie
     * pod `default`. Nowy wariant `SmEvent` ma tu wywalić kompilację i kazać się zaklasyfikować,
     * zamiast po cichu wpaść w ciszę.
     *
     * - `interrupt-requested` — to zrobił człowiek, wie o tym najlepiej,
     * - `driver-exit` — proces silnika odszedł; w Rarogu nie ma po tym żadnego następnego
     *   kroku do wykonania, karta schodzi do „zakończonych",
     * - `backend-restart` / `resumed` — cykl życia RAROGA, nie praca agenta,
     * - `closed` — sesję zamknął użytkownik,
     * - `driver-init` / `turn-start` / `agent-working` — praca właśnie RUSZA,
     * - `permission-resolved` / `question-resolved` — to Twoja własna decyzja przed chwilą,
     * - `prompt-blocked` — hook zablokował prompt wysłany z Raroga: wysyłający zwykle patrzy w apkę, notka
     *   stoi pod dymkiem, a klasa `blocking` trzyma się tylko stanów z dialogiem (`stillHolds`). Pusha
     *   o blokadzie nie ma (`docs/dialogs.md`, „Prompt blocked by a hook”).
     */
    case 'interrupt-requested':
    case 'prompt-blocked':
    case 'driver-exit':
    case 'backend-restart':
    case 'resumed':
    case 'closed':
    case 'driver-init':
    case 'turn-start':
    case 'agent-working':
    case 'permission-resolved':
    case 'question-resolved':
      return null;
  }
  // Nieznany wariant (nowszy manager w przyszłości) — cisza, nigdy wyjątek. Ta sama reguła
  // co w `transition()`: powiadomienia nie mają prawa wywrócić ścieżki zmiany stanu.
  return null;
}

/**
 * „Skończone" ma jeden warunek dodatkowy: nic nie może pracować w tle.
 *
 * `Stop` znaczy „główny agent skończył odpowiadać", a nie „sesja skończyła pracę". Agent, który
 * odpalił subagentów albo workflow, kończy turę i CZEKA — powiadomienie o końcu zadania obudzi
 * go ponownie, a każda taka tura to osobny koniec, choć workflow dalej liczy.
 *
 * Subagent w postoju pracą nie jest i w `backgroundTasks` go nie ma: sesja, której całe
 * tło tylko czeka, dostaje „gotowe" jak sesja bez tła.
 *
 * Drugi warunek: tura nie może być turą bez wyniku ({@link noResultTurn}: sam meldunek o postoju
 * subagenta albo sam meldunek o artefakcie, po którym agent nie użył narzędzia). Dotyczy tylko tej
 * klasy: dialog i błąd w takiej turze stoją na człowieku jak każde inne. Wyjątek: „gotowe" zaległe
 * po wcześniejszej zwykłej turze (`doneOwed`, {@link leavesResult}) wychodzi także po turze bez
 * wyniku.
 *
 * Trzeci warunek: zaległe
 * „gotowe" po turze bez wyniku czeka, dopóki subagent w postoju czeka na własną komendę
 * (`waitingOnOwnCommand`). Przebieg, który bez niego daje fałszywe „gotowe": tura z raportem
 * etapu kończy się startem subagenta następnego etapu (cisza, wynik zaległy), subagent staje
 * przy własnej komendzie (review, testy), a meldunek o postoju budzi głównego agenta, który
 * pisze „etap jeszcze trwa" i kończy turę. Zaległość zostaje zapalona; wychodzi po zwykłej
 * turze, np. po raporcie subagenta. Tura po prompcie człowieka albo po raporcie zostawia zwykły wynik,
 * także przy takim subagencie na liście.
 *
 * Przed wszystkimi trzema: start sesji ({@link ClassifyInput.afterStart})
 * to cisza, także przy zaległym „gotowe” — sesja wstała, a żadna tura się nie skończyła.
 * A test session ({@link ClassifyInput.testSession}) is silent too: its result is for the agent that started it.
 */
function doneOrSilence(input: ClassifyInput): NotifyClass | null {
  if (input.afterStart === true || input.testSession === true) return null;
  if (input.backgroundTasks > 0) return null;
  if (noResultTurn(input.turnInput) && (input.doneOwed !== true || input.waitingOnOwnCommand === true)) {
    return null;
  }
  return 'done';
}

/**
 * Ile czekamy PRZED wysyłką, osobno dla każdej klasy (ms).
 *
 * **Thresholds only wait out a state that reverts on its own.** Rarog knows presence at once, so waiting to
 * make up for uncertain presence would only be delay.
 *
 * Co zostało i dlaczego akurat tyle:
 *
 * - `blocking` / `failure` — próg symboliczny, ale NIEZEROWY. Rarog potrafi auto-potwierdzić
 *   komendę, więc dialog bywa migawką; przy zerze push byłby alarmem o czymś, co samo
 *   rozstrzygnęło się sekundę później. Trzy sekundy są dla człowieka nieodróżnialne od „od razu".
 * - `done` — **jedyny stan, który sam się cofa**. Agent kończy turę i po chwili zaczyna
 *   następną: prompt z kolejki, wybudzenie `/loop`, powiadomienie od zadania w tle. Zadania
 *   w tle mają własny guard w {@link classify}, ale ZAPLANOWANYCH WYBUDZEŃ Rarog nie widzi —
 *   i te 15 s jest właśnie na nie: to czas, w którym agent
 *   w pętli zdąży wrócić do pracy i unieważnić powiadomienie sam.
 */
export const FIRST_CHECK_MS: Readonly<Record<NotifyClass, number>> = {
  blocking: 3_000,
  failure: 3_000,
  done: 15_000,
};

export type Verdict =
  /** Wyślij teraz. */
  | 'send'
  /** Zamilcz na dobre. */
  | 'drop';

export interface DecideInput {
  readonly cls: NotifyClass;
  /** Stan sesji TERAZ — nie ten z chwili zdarzenia. */
  readonly state: SessionState;
  /**
   * Czy PATRZYSZ w Raroga.
   *
   * Hooki miały obok tego drugi warunek — „czy byłeś obecny KIEDYKOLWIEK w tym oknie" — i był
   * on tam konieczny, bo obecność liczona z `atime` tty migała: znikała między naciśnięciami
   * klawiszy. Tutaj jest zbędna, i to nie przez uproszczenie, tylko dlatego, że `presentNow`
   * ma już wbudowaną karencję: `Presence.active()` jest prawdziwe, dopóki którykolwiek klient
   * zgłosił widoczność w ciągu `PRESENCE_TTL_MS` (40 s). „Nieobecny" znaczy więc „przez 40 s
   * nikt nie potwierdził, że patrzy" — czyli dokładnie to, co tamten warunek próbował ustalić.
   */
  readonly presentNow: boolean;
  /** Czy ta konkretna sesja została obejrzana PO zdarzeniu (wejście w transkrypt albo `seen`). */
  readonly seen: boolean;
  /**
   * `SessionSummary.seen === true` — wynik BIEŻĄCEJ tury odebrał człowiek.
   *
   * This is NOT "the human saw this matter": a sticky flag that lit when herdr went from `done` to `idle`
   * and stayed lit through the next turn would silently drop a blocking dialog raised in that turn. Hence
   * two separate fields.
   *
   * Lepkości nie ma: start tury zeruje `seen`, a herdrowe `idle` liczy się jako
   * odbiór tylko po `done` — tura zaczęta na sfokusowanym panelu kończy się więc banerem
   * „Skończył", zamiast wpadać tu w `drop`. Pole odpowiada wyłącznie na pytanie klasy
   * `done`: „czy ten WYNIK już odebrano".
   */
  readonly resultSeen: boolean;
  /**
   * Ile zadań w tle pracuje TERAZ — ta sama liczba co `ClassifyInput.backgroundTasks`, tylko
   * z chwili sprawdzenia, nie zdarzenia.
   *
   * Między uzbrojeniem a wysyłką „gotowe" mija 15 s, a lista zadań zmienia się bez zmiany stanu
   * sesji: subagent w postoju rusza sam, gdy skończy się jego komenda, i główna sesja dalej
   * stoi w `waiting-input`. Bez tej liczby push „gotowe" wychodził wtedy przy pracującym tle,
   * czyli wbrew regule „koniec tury ≠ koniec pracy". Liczy się WYŁĄCZNIE dla klasy `done`.
   */
  readonly backgroundTasks: number;
  /**
   * To „gotowe" wypuszcza SAM zaległy wynik, bez zwykłego końca tury: po turze bez wyniku
   * ({@link noResultTurn}) albo przy ciszy w tle bez tury (`Notifier.quiet`).
   * Pamięta to harmonogram przy uzbrojeniu. Nieobecne = zwykłe „gotowe".
   */
  readonly owedRelease?: boolean;
  /**
   * `waitingOnOwnCommand` z chwili SPRAWDZENIA: subagent w postoju ma żywą własną komendę.
   * Gasi wyłącznie „gotowe" z {@link owedRelease}: komenda
   * trafia na listę dopiero po odczycie pliku subagenta, który idzie co 5 s, więc w chwili końca
   * tury mogło jej tam jeszcze nie być. Nieobecne = nie.
   */
  readonly waitingOnOwnCommand?: boolean;
}

/**
 * Werdykt po upływie okna. Trzy powody ciszy, jeden warunek wysyłki.
 *
 * **Presence CANCELS the matter instead of postponing it.** Presence here is a fact, and the rule is plain:
 * **coming back to Rarog cancels every pending send**, because opening Rarog shows the state of EVERY
 * session, so there is nothing left to deliver. Hence no postponements, no postponement ceiling and no
 * "how many times we postponed" state.
 *
 * Czego tu NIE MA: warunku „nowsze zdarzenie przejęło sprawę". Hooki potrzebowały na to jawnego
 * tokenu, bo każde odroczenie było osobnym procesem i wszystkie budziły się niezależnie. Tutaj
 * jest to własność STRUKTURY: harmonogram trzyma najwyżej jedno czekające powiadomienie na
 * sesję i nowsze zdarzenie po prostu je zastępuje, więc do `decide` nie ma jak dojść
 * powiadomienie, które ktoś już przejął.
 */
export function decide(input: DecideInput): Verdict {
  // Najmocniejszy sygnał „obsłużone", jakiego hooki mieć nie mogły: Rarog WIE, czy otworzyłeś
  // tę sesję. Nie „panel zszedł do idle", tylko „człowiek na to spojrzał".
  if (input.seen) return 'drop';

  // Znacznik odbioru mówi TYLKO o odebranym WYNIKU — patrz `DecideInput.resultSeen`.
  // Dla sprawy blokującej i awaryjnej nie znaczy nic: dialog, który stanął po tym, jak ktoś
  // zajrzał do panelu, jest dalej dialogiem, na który nikt nie odpowiedział.
  if (input.resultSeen && input.cls === 'done') return 'drop';

  // Stan minął — zgoda rozstrzygnięta, błąd ponowiony, nowa tura ruszyła, w tle znów coś
  // pracuje albo zaległe „gotowe" czeka na subagenta z własną komendą.
  if (!stillHolds(input)) return 'drop';

  // Patrzysz w Raroga — na telefonie albo na iPadzie, wszystko jedno. Obecność jest liczona
  // ŁĄCZNIE dla wszystkich urządzeń, więc otwarty iPad ucisza też telefon.
  if (input.presentNow) return 'drop';

  return 'send';
}

/**
 * Czy „gotowe" skasowane przy sprawdzeniu ZOSTAJE zaległe ({@link leavesResult}).
 *
 * Zostaje, gdy powodem ciszy jest sprawa, która minęła bez udziału człowieka: w tle znów coś
 * pracuje albo zaległe „gotowe" ({@link DecideInput.owedRelease}) czeka na subagenta z własną komendą.
 * Znika, gdy człowiek wynik widział: ma otwarty transkrypt, odebrał wynik tury albo patrzy
 * w Raroga przy cichej sesji (lista pokazuje wtedy jej stan końcowy). Wołać wyłącznie dla
 * werdyktu `drop`.
 */
export function doneStaysOwed(input: DecideInput): boolean {
  if (input.cls !== 'done') return false;
  if (input.seen || input.resultSeen) return false;
  return !stillHolds(input);
}

/**
 * Czy sprawa, o której chcemy zawiadomić, JEST JESZCZE aktualna.
 *
 * Każda klasa ma inny warunek i każdy jest tu z konkretnego powodu:
 * - blokujące gaśnie, gdy dialog zniknął (rozstrzygnięty w terminalu albo w Rarogu),
 * - awaryjne gaśnie dopiero, gdy sesja WRÓCIŁA do pracy — czyli gdy ponowiłeś,
 * - „skończone" gaśnie, gdy ruszyła kolejna tura; `done` (sesja zamknięta) je PRZEPUSZCZA,
 *   bo wynik ostatniej tury dalej czeka na odebranie. Gaśnie też, gdy w tle znów coś pracuje:
 *   to ten sam warunek co przy uzbrojeniu (`doneOrSilence`), sprawdzony drugi raz, bo zadanie
 *   w tle potrafi ruszyć bez żadnego zdarzenia sesji (subagent wybudzony z postoju).
 *   Zaległe „gotowe" wypuszczone bez zwykłego końca tury (turą bez wyniku albo ciszą w tle,
 *   {@link DecideInput.owedRelease}) gaśnie też, gdy subagent w postoju ma teraz żywą własną
 *   komendę — drugie sprawdzenie warunku z `doneOrSilence` i warunku ciszy
 *   (`holdsOwedDone` w `herdr/background/work.ts`). Blokujących i awaryjnych tło nie gasi: dialog
 *   i błąd stoją niezależnie od niego.
 */
function stillHolds(input: DecideInput): boolean {
  const { state } = input;
  switch (input.cls) {
    case 'blocking':
      return state === 'waiting-permission' || state === 'waiting-question';
    case 'failure':
      return state === 'error' || state === 'limit-reached' || state === 'interrupted';
    case 'done':
      return (state === 'waiting-input' || state === 'done') && input.backgroundTasks === 0
        && !(input.owedRelease === true && input.waitingOnOwnCommand === true);
  }
}
