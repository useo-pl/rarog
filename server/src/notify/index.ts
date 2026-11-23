/**
 * Harmonogram powiadomień — jedyne miejsce ze STANEM i z zegarem.
 *
 * Spina trzy czyste kawałki: {@link classify}/{@link decide} (reguły), `Presence` (czy patrzysz)
 * i `ChannelSink` (wysyłka, `fanout.ts` — jedynym kanałem jest APNs apki natywnej). Sam nie
 * zna ani protokołu SSE, ani managera sesji — dostaje fakty przez {@link Notifier.note} (przejście
 * stanu) i {@link Notifier.quiet} (cisza w tle bez tury) i oddaje efekt przez sink oraz linię logu.
 *
 * Kształt pętli:
 *
 *     zdarzenie → klasyfikacja → uzbrój timer (okno per klasa)
 *                                     ↓
 *                                  werdykt: send | defer (kolejne okno) | drop
 *
 * Jedna sesja ma najwyżej JEDNO czekające powiadomienie. Nowsze zdarzenie na tej samej sesji
 * zastępuje starsze — to jest cały mechanizm składania zdarzeń nakładających się w oknie
 * i to on zastępuje throttle: nadmiar i niedomiar powiadomień były dwoma objawami tej samej
 * złej semantyki eventu.
 */
import type { SessionState, SessionSummary } from '@rarog/shared';
import type { AnyText } from '@rarog/shared/sentences';
import { tasksHoldingDonePush, waitingOnOwnCommand } from '../herdr/background/work.ts';
import type { SmEvent } from '../sessions/state-machine.ts';
import type { SendOutcome } from './content.ts';
import { buildContent } from './content.ts';
import type { ChannelReport, ChannelSink, SendReport } from './fanout.ts';
import type { Presence } from './presence.ts';
import type { ClassifyInput, DecideInput, NotifyClass, NotifyKind, TurnInput } from './policy.ts';
import {
  FIRST_CHECK_MS, classify, decide, doneStaysOwed, kindOf, leavesResult, noResultTurn,
} from './policy.ts';

/**
 * Ile porażek wysyłki Z RZĘDU do JEDNEGO tokenu APNs znaczy „pushe do tego urządzenia nie
 * docierają": próg `degradedSince` w rejestrze urządzeń (`apns-devices.ts`), o który apka pyta
 * `POST /api/push/apns/status` i z którego rysuje baner degradacji.
 *
 * Trzy, a nie jedna: APNs bywa chwilowo nieosiągalny przy przełączaniu sieci na Macu, a baner
 * „powiadomienia nie docierają" jest zdaniem tej samej wagi co „serwer nie odpowiada" — nie ma
 * prawa migać przy jednym nieudanym żądaniu.
 *
 * Liczą się WYŁĄCZNIE próby, które były (`apns-sink.ts`): porażka bez próby (środowisko
 * nadajnika wyłączone albo wstrzymane) licznika tokenu nie rusza, a realne 200 go zeruje.
 */
export const DEGRADED_AFTER_FAILURES = 3;

/** Fraza linii logu `push: quiet for <projekt> (<rodzaj>, <powód>)`: sprawa bez banera i powód ciszy. */
export const PUSH_QUIET_LOG = 'push: quiet for';

/** Słowo do logu per wynik wysyłki — log jest jedynym świadkiem, gdy nikt nie patrzy. */
const OUTCOME_LABEL: Readonly<Record<SendOutcome, string>> = {
  delivered: 'SENT',
  failed: 'FAILED',
  'no-receiver': 'NO RECEIVER',
};

/** Kanały w linii logu wysyłki, w stałej kolejności. */
type ChannelName = keyof ChannelReport;
const CHANNEL_LABEL: Readonly<Record<ChannelName, string>> = {
  apns: 'APNs',
};

/**
 * Linia logu wysyłki: RODZAJ, projekt i wynik per kanał — NIGDY treść banera.
 *
 * Linia nie niesie `title / body` (treści pytania ani zdania podsumowania tury) do
 * `server.log`. Log jest jedynym świadkiem wysyłki, ale do
 * odpowiedzi na „czemu push nie przyszedł" wystarczy, CO i DOKĄD poszło, nie co było napisane.
 * Przy „skończył” dochodzi liczba zleceń dźwięku z kafla (`Live Activity chime: N`)
 * — 0 znaczy, że żadne urządzenie nie miało żywego kafla ze zgodą na powiadomienia.
 */
function sendLogLine(kind: NotifyKind, project: string, report: SendReport): string {
  const { channels: perChannel } = report;
  const channels = (Object.keys(CHANNEL_LABEL) as ChannelName[])
    .filter((name) => perChannel[name] !== undefined)
    .map((name) => `${CHANNEL_LABEL[name]}: ${OUTCOME_LABEL[perChannel[name] as SendOutcome]}`);
  const chime = report.chime === undefined ? '' : `, Live Activity chime: ${String(report.chime)}`;
  return `push: ${kind} for ${project} — ${channels.length === 0 ? 'no channel' : channels.join(', ')}${chime}`;
}

/**
 * What triggered a turn without a result (`noResultTurn` in `policy.ts`), in two log-line forms:
 * `turn` after "quiet for … (done, …)" and `owed` after "owed after a turn …". Lines for a subagent
 * standby alone keep a fixed wording, because people and documents read them.
 */
function noResultCause(turn: TurnInput): { readonly turn: string; readonly owed: string } {
  // A context compaction, alone or joined with the other causes of the turn.
  if (turn.compactions > 0) {
    const cause = [
      turn.artifactWatch > 0 ? 'an artifact task notification' : '',
      'a context compaction',
      turn.standbyNotices > 0 ? 'a subagent standby' : '',
    ].filter((part) => part !== '').join(' and ');
    return { turn: `turn after ${cause} alone`, owed: `with ${cause} alone` };
  }
  if (turn.artifactWatch === 0) {
    return { turn: 'turn after a subagent standby alone', owed: 'with a subagent standby alone' };
  }
  if (turn.standbyNotices === 0) {
    return { turn: 'turn after an artifact task notification alone', owed: 'with an artifact task notification alone' };
  }
  return {
    turn: 'turn after an artifact task notification and a subagent standby alone',
    owed: 'with an artifact task notification and a subagent standby alone',
  };
}

/** Fakty o sesji, których harmonogram potrzebuje PONOWNIE w chwili sprawdzenia. */
export interface SessionLook {
  readonly state: SessionState;
  /** `SessionSummary.seen === true` — wynik BIEŻĄCEJ tury odebrany. */
  readonly seen: boolean;
  /**
   * Ile zadań w tle pracuje w chwili sprawdzenia (`tasksHoldingDonePush`, `herdr/background/
   * work.ts`) — ta sama liczba co `NoteInput.backgroundTasks`, tylko świeża. Gasi uzbrojone
   * „gotowe", gdy tło ruszyło po końcu tury (subagent wybudzony z postoju).
   */
  readonly backgroundTasks: number;
  /**
   * Subagent w postoju ma żywą własną komendę (`waitingOnOwnCommand`, `herdr/background/work.ts`)
   * w chwili sprawdzenia. Gasi zaległe „gotowe" wypuszczone turą bez wyniku, gdy komenda
   * trafiła na listę dopiero po końcu tury.
   */
  readonly waitingOnOwnCommand: boolean;
}

/**
 * Karta sesji → fakty do ponownej kontroli. Brak karty = sesji już nie ma.
 *
 * Jedna funkcja dla produkcji (`server/src/index.ts`) i testów z prawdziwym harmonogramem, żeby
 * obie strony liczyły to samo. Fakty o liście zadań bierze z TYCH SAMYCH reguł co uzbrojenie
 * (`#note` w managerze): `tasksHoldingDonePush` i `waitingOnOwnCommand`.
 */
export function sessionLook(summary: SessionSummary | undefined): SessionLook | undefined {
  if (summary === undefined) return undefined;
  return {
    state: summary.state,
    seen: summary.seen === true,
    backgroundTasks: tasksHoldingDonePush(summary.backgroundTasks),
    waitingOnOwnCommand: waitingOnOwnCommand(summary.backgroundTasks),
  };
}

export interface NoteInput {
  readonly sessionId: string;
  /** Zdarzenie, które WYWOŁAŁO przejście stanu. */
  readonly event: SmEvent;
  /** Ile zadań w tle PRACUJE w tej sesji w chwili przejścia (subagent w postoju się nie liczy). */
  readonly backgroundTasks: number;
  /**
   * W chwili przejścia subagent w postoju ma żywą własną komendę (`waitingOnOwnCommand`,
   * `herdr/background/work.ts`). Wstrzymuje wyłącznie zaległe „gotowe" po turze bez wyniku;
   * regułę trzyma `policy.ts`. Nieobecne = nie.
   */
  readonly waitingOnOwnCommand?: boolean;
  /** `agent-idle` odtworzonej karty po restarcie serwera herdr — to nie koniec tury. */
  readonly afterHerdrRestore?: boolean;
  /**
   * Przejście sesji, która wstaje: wyjście wprost ze `starting` albo tura zerowa.
   * To nie koniec tury — „gotowe” milczy; regułę trzyma `policy.ts` (`ClassifyInput.afterStart`).
   */
  readonly afterStart?: boolean;
  /**
   * Rachunek tury od poprzedniego końca tury (liczy manager): wiadomości roli `user` i wywołania
   * narzędzi głównego agenta. Tura bez wyniku (sam postój subagenta albo sam meldunek o artefakcie
   * bez narzędzi) nie uzbraja „gotowe" — regułę trzyma `policy.ts` (`noResultTurn`).
   */
  readonly turnInput?: TurnInput;
  /**
   * Wynik POPRZEDNIEJ tury człowiek odebrał, zanim przyszło to zdarzenie: znacznik `seen` karty
   * sprzed zerowania na starcie tury. Gasi zaległe „gotowe" także wtedy, gdy odbiór poszedł
   * poza Rarogiem, fokusem panelu na Macu; odbiór w Rarogu zgłasza {@link NotifierLike.seen}.
   */
  readonly resultSeen?: boolean;
  /** Projekt (`basename(cwd)`) — grupowanie powiadomień na iOS. */
  readonly project: string;
  /** Człon sesji z tytułu `projekt · sesja`. */
  readonly label?: string;
  /**
   * Czego dotyczy: narzędzie, pytanie i zdanie wyniku (treść agenta, `foreign`) albo dopisek stanu (zdanie Raroga).
   * Jedzie bez zmian przez kolejkę i zaległy wynik do `buildContent`: `ref` zdania Raroga staje się `bodyRef` banera.
   */
  readonly detail?: AnyText;
  /**
   * `SessionSummary.termId` — terminal Raroga, w którym stoi panel (Codex albo Claude).
   * Decyduje o celu tapnięcia w baner (klucz `rarog.termId` ładunku APNs, `apns-payload.ts`),
   * a nie o treści.
   *
   * Brane z chwili ZDARZENIA, nie wysyłki, i to jest świadome: pole rusza się rzadko (powstanie
   * karty, reattach panelu, zmiana tokenu terminala), a gdyby mimo to
   * zwietrzało, ekran terminala sam mówi „tego terminala już nie ma" i daje „Uruchom ponownie"
   * — czyli najgorszy przypadek to jedno tapnięcie więcej, nie ślepy zaułek.
   */
  readonly termId?: string;
}

export interface NotifierOptions {
  readonly presence: Presence;
  /** Sink kanału banerów (`fanout.ts`): treść → wynik per kanał i dźwięk kafla (do logu). */
  readonly sink: ChannelSink;
  /** Stan sesji w chwili SPRAWDZENIA — nie ten z chwili zdarzenia. */
  readonly look: (sessionId: string) => SessionLook | undefined;
  /**
   * Plakietka na ikonie apki: liczba sesji, które STOJĄ i czekają na człowieka
   * (`waiting-permission` / `waiting-question`) — ta sama definicja co bursztyn na liście.
   * Leniwa, bo harmonogram powstaje PRZED managerem (wzorzec `look`); czytana w chwili WYSYŁKI,
   * nie zdarzenia. Brak = push nie rusza plakietki.
   */
  readonly badge?: () => number;
  readonly setTimeout?: (cb: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  /**
   * Log decyzji — uzbrojenie, werdykt, wynik wysyłki.
   *
   * Nie diagnostyka „na wszelki wypadek": ten moduł z definicji działa wtedy, gdy nikt nie
   * patrzy, więc jedyne pytanie, jakie kiedykolwiek padnie („czemu push nie przyszedł?"),
   * bez logu byłoby rekonstrukcją z pamięci. Ta sama racja co przy logu korekt stanu z herdr.
   */
  readonly log?: (line: string) => void;
}

/**
 * To, czego z powiadomień potrzebuje manager — i nic więcej.
 *
 * Interfejs istnieje po to, żeby zależność szła w JEDNĄ stronę: manager zna cztery czasowniki,
 * a nie klasę, kanał APNs ani zegar. Test managera podstawia tu zwykły obiekt z tablicą.
 */
export interface NotifierLike {
  note(input: NoteInput): void;
  seen(sessionId: string): void;
  forget(sessionId: string): void;
  /**
   * Lista zadań sesji przestała wstrzymywać zaległe „gotowe" (`holdsOwedDone` w
   * `herdr/background/work.ts`: przed zmianą listy wstrzymywała, po niej nie). Woła manager przy
   * zdarzeniu `background-tasks`, raz na takie przejście.
   */
  quiet(sessionId: string): void;
  /**
   * Koniec tury, który właśnie zgłosił herdr (`agent-idle`), nie był końcem tury: hook `UserPromptSubmit`
   * zablokował prompt, którym Rarog ją otworzył (`docs/dialogs.md`, „Prompt blocked by a hook”).
   * Rozbraja uzbrojone „gotowe” i przywraca zaległe „gotowe” sprzed tego końca tury — wynik wcześniejszej,
   * prawdziwej tury nie ginie, a fałszywy nie zostaje. Opcjonalne: wołający bez harmonogramu go nie ma.
   */
  retractTurnEnd?(sessionId: string): void;
}

/**
 * Treść banera zaległego „gotowe", zapamiętana przy końcu zwykłej tury, która je zostawiła. Brana
 * z chwili tamtego zdarzenia, jak cała treść banera (`NoteInput.termId`): etykieta zmieniona
 * w międzyczasie zostaje stara, a wynik, o którym baner mówi, jest właśnie tamtej tury.
 */
interface OwedResult {
  readonly project: string;
  readonly label: string | undefined;
  readonly detail: AnyText | undefined;
  /** Adres banera dla agenta w terminalu Raroga — patrz `NoteInput.termId`. */
  readonly termId: string | undefined;
}

interface Waiting extends OwedResult {
  readonly cls: NotifyClass;
  readonly kind: NotifyKind;
  /**
   * „Gotowe" wypuszcza SAM zaległy wynik, bez zwykłego końca tury: turą bez wyniku (sam postój
   * subagenta albo sam meldunek o artefakcie) albo ciszą w tle ({@link Notifier.quiet}). Przy
   * sprawdzeniu gaśnie (i zostaje zaległe), gdy subagent w postoju ma wtedy żywą własną komendę
   * (`DecideInput.owedRelease`).
   */
  readonly owedRelease: boolean;
  timer: unknown;
}

export class Notifier implements NotifierLike {
  readonly #waiting = new Map<string, Waiting>();
  /**
   * Co już POSZŁO na telefon, per sesja — jedyna pamięć harmonogramu poza kolejką czekających.
   *
   * `#check()` usuwa wpis z `#waiting` ZANIM wyśle, więc po wysyłce nie zostawał żaden ślad
   * i kolejne `note()` uzbrajało od zera. Przy przejściu-tożsamości znaczyło to DRUGI
   * baner o TYM SAMYM stojącym dialogu: `agent-blocked` wysyłał po 3 s baner bez nazwy
   * narzędzia (pending był jeszcze pusty), a karta składana 1–2 s później uzbrajała następny.
   * Okno jest osiągalne bez egzotyki — karencja jsonl ↔ ekran to 2 × 800 ms, ponowna ocena
   * 500 ms, a nieudana pierwsza ocena czeka do zegara stojącego dialogu (4 s).
   */
  readonly #sent = new Map<string, { readonly cls: NotifyClass; readonly state: SessionState }>();
  /**
   * Sesje z ZALEGŁYM „gotowe": skończyła się zwykła tura,
   * a o jej wyniku baner nie wyszedł i człowiek go nie obejrzał.
   *
   * Zapala koniec każdej zwykłej tury (`leavesResult` w `policy.ts`, tam też oba przebiegi, które
   * gubiłyby wynik) i zapamiętuje treść jego banera (projekt, etykieta, zdanie wyniku, `termId`).
   * Gasi: wysłane „gotowe", sesja otwarta w Rarogu ({@link Notifier.seen}), wynik odebrany na
   * Macu (`NoteInput.resultSeen`), przerwanie z Raroga (`interrupt-requested`),
   * człowiek patrzący w Raroga przy cichej sesji (uzbrojenie, sprawdzenie, {@link Notifier.quiet},
   * {@link Notifier.clearAll}), zniknięcie sesji i zmiana jej rozmowy silnika ({@link Notifier.forget}).
   * NIE gasi: praca w tle w chwili sprawdzenia, subagent w postoju z żywą własną komendą
   * ani nowa tura, która zdjęła uzbrojony baner.
   *
   * Skutki zapalonej flagi są dwa. Koniec tury bez wyniku (`noResultTurn`) przy cichym tle idzie
   * zwykłą ścieżką „gotowe" zamiast w ciszę, o ile żaden subagent w postoju nie czeka na własną
   * komendę (wtedy cisza, a flaga zostaje). A gdy lista zadań przestaje
   * wstrzymywać wynik bez żadnej tury, {@link Notifier.quiet} uzbraja „gotowe" z zapamiętanej
   * treści. Pamięć jest w procesie; po restarcie serwera pierwsza tura i tak
   * nie jest wyciszana (rachunek tury jest wtedy niepełny).
   */
  readonly #owed = new Map<string, OwedResult>();
  /**
   * Zaległe „gotowe” sprzed OSTATNIEGO końca zwykłej tury (`leavesResult`) i wartość, którą ten koniec
   * zapisał — dla {@link Notifier.retractTurnEnd}. Przywrócenie działa tylko, gdy `#owed` dalej trzyma
   * wartość tego końca: odbiór, przerwanie albo nowszy koniec tury w międzyczasie mają pierwszeństwo.
   */
  readonly #owedBefore = new Map<string, { readonly before: OwedResult | undefined; readonly set: OwedResult }>();
  readonly #presence: Presence;
  readonly #sink: ChannelSink;
  readonly #look: (sessionId: string) => SessionLook | undefined;
  readonly #badge: (() => number) | undefined;
  readonly #setTimeout: (cb: () => void, ms: number) => unknown;
  readonly #clearTimeout: (handle: unknown) => void;
  readonly #log: ((line: string) => void) | undefined;

  constructor(options: NotifierOptions) {
    this.#presence = options.presence;
    this.#sink = options.sink;
    this.#look = options.look;
    this.#badge = options.badge;
    this.#setTimeout = options.setTimeout
      ?? ((cb, ms): unknown => {
        const handle = setTimeout(cb, ms);
        // Czekające powiadomienie nie może trzymać procesu przy zamykaniu serwera.
        if (typeof handle.unref === 'function') handle.unref();
        return handle;
      });
    this.#clearTimeout = options.clearTimeout
      ?? ((handle): void => { clearTimeout(handle as NodeJS.Timeout); });
    this.#log = options.log;
  }

  /**
   * Przejście stanu sesji → ewentualne uzbrojenie powiadomienia.
   *
   * Wołane z JEDYNEGO miejsca zmiany stanu (`#applyTransition` w managerze) i musi być tanie
   * oraz nierzucające: leży na ścieżce każdej zmiany stanu każdej z kilkunastu sesji.
   */
  note(input: NoteInput): void {
    const facts: ClassifyInput = {
      event: input.event,
      backgroundTasks: input.backgroundTasks,
      ...(input.afterHerdrRestore === true ? { afterHerdrRestore: true } : {}),
      ...(input.afterStart === true ? { afterStart: true } : {}),
      ...(input.turnInput === undefined ? {} : { turnInput: input.turnInput }),
      ...(input.waitingOnOwnCommand === true ? { waitingOnOwnCommand: true } : {}),
    };
    // Zaległe „gotowe". Kolejność jest wiążąca: najpierw odbiór STAREGO wyniku, potem
    // ewentualny NOWY wynik tego zdarzenia, dopiero na końcu klasyfikacja.
    if (input.resultSeen === true) this.#owed.delete(input.sessionId);
    // Przerwanie idzie wyłącznie z Raroga (`manager.interrupt`): nacisnął je człowiek, który ma
    // tę sesję przed sobą, więc wynik sprzed niego nie jest już nowiną. Bez
    // tego cisza w tle po wyjściu z Raroga dosłałaby „gotowe" o turze sprzed Esc (`quiet` niżej).
    if (input.event.type === 'interrupt-requested') this.#owed.delete(input.sessionId);
    if (leavesResult(facts)) {
      const owed: OwedResult = {
        project: input.project, label: input.label, detail: input.detail, termId: input.termId,
      };
      this.#owedBefore.set(input.sessionId, { before: this.#owed.get(input.sessionId), set: owed });
      this.#owed.set(input.sessionId, owed);
    }
    const cls = classify(this.#owed.has(input.sessionId) ? { ...facts, doneOwed: true } : facts);
    // Nowsze zdarzenie ZAWSZE unieważnia starsze czekające — także wtedy, gdy samo jest ciche.
    // To jest ten sam token co w hookach: bez niego odroczenie sprzed tury obudziłoby się
    // w środku następnej i zawiadomiło o stanie, którego już nie ma.
    this.#disarm(input.sessionId);
    const kind = kindOf(input.event);
    if (cls === null || kind === null) {
      if (input.afterHerdrRestore === true && input.event.type === 'agent-idle') {
        this.#log?.(`${PUSH_QUIET_LOG} ${input.project} (done, herdr restore)`);
      } else if (input.afterStart === true && kind === 'done') {
        this.#log?.(`${PUSH_QUIET_LOG} ${input.project} (done, session start)`);
      } else if (kind === 'done' && input.backgroundTasks === 0 && input.turnInput !== undefined
        && noResultTurn(input.turnInput)) {
        // A reason visible neither in the session state nor in the task list: the turn was triggered
        // by a CLI report alone, after which nothing finished. With background work running the
        // silence keeps its usual reason and no line. An owed "done" waiting for a subagent with its
        // own command gets its own wording in the log.
        const held = this.#owed.has(input.sessionId) && input.waitingOnOwnCommand === true
          ? ', owed waits: the subagent waits for its own command' : '';
        this.#log?.(`${PUSH_QUIET_LOG} ${input.project} (done, ${noResultCause(input.turnInput).turn}${held})`);
      }
      // Zdarzenie, które o niczym nie zawiadamia, znaczy „sprawa się ruszyła" — pamięć wysyłki
      // przestaje opisywać cokolwiek stojącego i musi zniknąć, inaczej blokada po powrocie
      // z `running` byłaby wyciszona jako „już wysłane".
      this.#sent.delete(input.sessionId);
      return;
    }

    /*
     * Baner o TEJ SAMEJ sprawie już poszedł — drugi byłby powtórzeniem, nie nowiną.
     * „Ta sama sprawa" = ta sama klasa i ten sam, NIEPRZERWANY stan sesji: każde zdarzenie
     * spoza klas powiadomień czyści pamięć wyżej, więc `waiting-permission` osiągnięte
     * ponownie po `running` liczy się jako nowa sprawa. Świadomy koszt: dialog, który
     * podmienia się w miejscu bez ani jednej klatki `working`, nie dosyła drugiego
     * banera — użytkownik ma na ekranie blokady stojące „czeka na decyzję", którego jeszcze
     * nie obsłużył, a bogatsza treść nie zmienia wezwania do działania.
     */
    const sent = this.#sent.get(input.sessionId);
    if (sent !== undefined && sent.cls === cls && sent.state === this.#look(input.sessionId)?.state) {
      this.#log?.(`${PUSH_QUIET_LOG} ${input.project} (${cls}, a banner about this matter already went out)`);
      if (cls === 'done') this.#owed.delete(input.sessionId);
      return;
    }

    /*
     * Patrzysz w Raroga — nie uzbrajamy niczego (reguła użytkownika).
     *
     * Wcześniej powiadomienie uzbrajało się zawsze i dopiero po oknie sprawdzało obecność.
     * Różnica jest widoczna w jednym scenariuszu i tylko w nim: pracujesz w apce, sesja prosi
     * o zgodę, po chwili odkładasz telefon. Stary model wysłałby wtedy push o sprawie, którą
     * WIDZIAŁEŚ na ekranie; nowy milczy, bo skoro widziałeś, to nie ma o czym zawiadamiać.
     */
    if (this.#presence.active()) {
      this.#log?.(`${PUSH_QUIET_LOG} ${input.project} (${cls}, you are watching Rarog)`);
      // „Gotowe" dochodzi tu tylko przy cichym tle: lista pokazuje stan końcowy sesji.
      if (cls === 'done') this.#owed.delete(input.sessionId);
      return;
    }

    // Tura bez wyniku dochodzi tu wyłącznie z zaległym „gotowe" — log ma to nazwać,
    // a sprawdzenie przed wysyłką ma je odróżnić od zwykłego (`Waiting.owedRelease`).
    const owedRelease = cls === 'done' && noResultTurn(input.turnInput);
    this.#waiting.set(input.sessionId, {
      cls,
      kind,
      project: input.project,
      label: input.label,
      detail: input.detail,
      termId: input.termId,
      owedRelease,
      timer: null,
    });
    const owedNote = owedRelease && input.turnInput !== undefined
      ? `, owed after a turn ${noResultCause(input.turnInput).owed}` : '';
    const check = this.#firstCheck(cls);
    // Bez etykiety sesji: przy braku szczegółu etykieta jest całą treścią banera (`content.ts`, `bodyFor`).
    this.#log?.(`push: armed ${cls} for ${input.project} (${check.note}${owedNote})`);
    this.#arm(input.sessionId, check.ms);
  }

  /**
   * Pierwsze sprawdzenie: {@link FIRST_CHECK_MS}, a „gotowe” najwcześniej po karencji od zejścia z Raroga
   * (`PRESENCE_GRACE_MS`). Blokujące i awaryjne karencji nie mają: sesja stoi, dopóki
   * ktoś nie odpowie.
   */
  #firstCheck(cls: NotifyClass): { ms: number; note: string } {
    const base = FIRST_CHECK_MS[cls];
    const grace = cls === 'done' ? this.#presence.graceLeftMs() : 0;
    if (grace <= base) return { ms: base, note: `check in ${String(base / 1_000)} s` };
    return { ms: grace, note: `check in ${String(Math.ceil(grace / 1_000))} s, grace after leaving Rarog` };
  }

  /**
   * Sesja obejrzana w Rarogu — gasi czekające powiadomienie NATYCHMIAST.
   *
   * Wołane z `POST /api/sessions/:id/seen`. Osobno od `Presence.watching`, bo to dwa różne
   * fakty: `watching` mówi „ma otwarty transkrypt teraz", a to — „potwierdził, że widział".
   */
  seen(sessionId: string): void {
    this.#disarm(sessionId);
    this.#sent.delete(sessionId);
    this.#owed.delete(sessionId);
  }

  /**
   * Sesja zniknęła (zamknięta, wygaszona) albo jej panel pisze już inną rozmowę (`/clear`,
   * `/resume`; manager przy `init` z nowym `engineSessionId`) — nie ma o czym zawiadamiać.
   */
  forget(sessionId: string): void {
    this.#disarm(sessionId);
    this.#sent.delete(sessionId);
    this.#owed.delete(sessionId);
  }

  /**
   * Background silence without an end of turn → the owed "done" is armed as at an end of turn.
   *
   * `note()` only runs on a state transition, but the task list changes without one: a subagent at
   * rest whose command finished without a wake-up goes to sleep, a background command ends, and the
   * CLI does not wake the agent. Without this verb the result would wait for the next end of turn,
   * and while the owed "done" waits for a subagent with its own command it might never go out. The
   * manager calls this verb when the list stops holding the owed "done" (`holdsOwedDone` in
   * `herdr/background/work.ts`: held before the change, not after it).
   *
   * Arms from the content remembered at the end of a plain turn (`#owed`), in the same window
   * (`FIRST_CHECK_MS.done`) and with the same check at send time as a "done" after an idle-only
   * turn (`owedRelease`): a fresh `look`, background work and a subagent with its own command drop
   * the banner and keep the debt. A turn starting in the window disarms it (`note()`), as always.
   *
   * Does nothing: without a debt; when something already waits for its window (no duplicate, also
   * after several drops in a row); when the session is not quiet (turn in progress, dialog,
   * background work — the debt keeps waiting). Clears the debt without a banner: a result already
   * seen (open transcript, receipt mark) and looking at Rarog while the session is quiet, like
   * `note()`.
   *
   * Accepted cost: the end of a subagent's own command leaves the list at once, while Rarog sees the
   * agent's wake-up after the read tick of its file (up to 5 s). The condition drops for a moment,
   * this method arms, and the check after 15 s sees a working agent and keeps the debt
   * (`push: quiet for … working in the background: N`).
   */
  quiet(sessionId: string): void {
    const owed = this.#owed.get(sessionId);
    if (owed === undefined) return;
    if (this.#waiting.has(sessionId)) return;
    const look = this.#look(sessionId);
    if (look === undefined) {
      this.#owed.delete(sessionId);
      return;
    }
    const entry: Waiting = { ...owed, cls: 'done', kind: 'done', owedRelease: true, timer: null };
    const facts = this.#facts(sessionId, entry, look);
    if (decide(facts) === 'drop') {
      if (doneStaysOwed(facts)) return;
      this.#owed.delete(sessionId);
      const why = facts.seen || facts.resultSeen ? 'result seen' : 'you are watching Rarog';
      this.#log?.(`${PUSH_QUIET_LOG} ${owed.project} (done, owed after the background went quiet, ${why})`);
      return;
    }
    this.#waiting.set(sessionId, entry);
    const check = this.#firstCheck('done');
    this.#log?.(`push: armed done for ${owed.project} (${check.note}, owed after the background went quiet)`);
    this.#arm(sessionId, check.ms);
  }

  /**
   * Koniec tury, który nie był końcem tury (prompt zablokowany przez hook) — patrz
   * {@link NotifierLike.retractTurnEnd}.
   *
   * Uzbrojone „gotowe” gaśnie (inne klasy zostają: dialog i błąd stoją niezależnie), a zaległość wraca do
   * wartości sprzed tego końca tury, o ile od niego nic jej nie zmieniło. Baner, który już poszedł, nie wraca.
   */
  retractTurnEnd(sessionId: string): void {
    const waiting = this.#waiting.get(sessionId);
    const disarmed = waiting?.cls === 'done';
    if (disarmed) this.#disarm(sessionId);
    const record = this.#owedBefore.get(sessionId);
    this.#owedBefore.delete(sessionId);
    if (record !== undefined && this.#owed.get(sessionId) === record.set) {
      if (record.before === undefined) this.#owed.delete(sessionId);
      else this.#owed.set(sessionId, record.before);
    }
    if (disarmed) {
      this.#log?.(`${PUSH_QUIET_LOG} ${waiting.project} (done, turn end retracted: prompt blocked by a hook)`);
    }
  }

  /**
   * **Wróciłeś do Raroga — kasujemy WSZYSTKIE czekające wysyłki.**
   *
   * Uzasadnienie jest po stronie ekranu, nie kodu: otwierając Raroga, dostajesz listę ze stanem
   * KAŻDEJ sesji naraz. Dosyłanie po tym banerów o sprawach, które są na tej liście, byłoby
   * powiadamianiem o rzeczach już pokazanych.
   *
   * **Świadomy koszt.** Sesja zablokowana, o której push jeszcze nie zdążył wyjść, po powrocie
   * do apki nie odezwie się ponownie, dopóki coś się w niej nie ZMIENI — a zablokowana sesja
   * z definicji stoi. Jeśli otworzysz Raroga na ekranie terminala i wyjdziesz, nie zaglądając
   * na listę, taka sprawa ucichnie. Wariant „kasuj tylko to, co widać na liście" jest możliwy,
   * ale wymagałby, żeby serwer wiedział, na który EKRAN patrzysz — dziś wie tylko o otwartym
   * transkrypcie.
   *
   * Zaległe „gotowe" gaśnie tu tylko razem z uzbrojonym „gotowe" sesji, która W TEJ
   * CHWILI jest cicha: lista pokazuje wtedy jej stan końcowy. Sesja, w której tle coś pracuje,
   * zostaje z zaległością — także ta z uzbrojonym „gotowe", gdy subagent ruszył w oknie 15 s
   * (świeży odczyt, `doneStaysOwed`). Lista pokazała ją jako pracującą,
   * a cicha chwila dopiero przyjdzie.
   */
  clearAll(): void {
    const count = this.#waiting.size;
    // Pamięć wysyłki gaśnie ZAWSZE, także gdy kolejka jest pusta: powrót do Raroga pokazuje
    // listę ze stanem każdej sesji, więc żaden baner nie jest już „ostatnim słowem".
    this.#sent.clear();
    if (count === 0) return;
    for (const [id, entry] of [...this.#waiting]) {
      if (entry.cls === 'done') {
        const look = this.#look(id);
        if (look === undefined || !doneStaysOwed(this.#facts(id, entry, look))) this.#owed.delete(id);
      }
      this.#disarm(id);
    }
    this.#log?.(`push: back in Rarog — cancelled pending sends (${String(count)})`);
  }

  /** Ile powiadomień czeka na swoje okno (diagnostyka i testy). */
  get pending(): number {
    return this.#waiting.size;
  }

  /** Zatrzymuje wszystkie timery (graceful shutdown). */
  close(): void {
    for (const id of [...this.#waiting.keys()]) this.#disarm(id);
  }

  #arm(sessionId: string, ms: number): void {
    const entry = this.#waiting.get(sessionId);
    if (entry === undefined) return;
    entry.timer = this.#setTimeout(() => {
      void this.#check(sessionId);
    }, ms);
  }

  #disarm(sessionId: string): void {
    const entry = this.#waiting.get(sessionId);
    if (entry === undefined) return;
    if (entry.timer !== null) this.#clearTimeout(entry.timer);
    this.#waiting.delete(sessionId);
  }

  async #check(sessionId: string): Promise<void> {
    const entry = this.#waiting.get(sessionId);
    if (entry === undefined) return;
    const look = this.#look(sessionId);
    // Sesji już nie ma — nie ma też czego pilnować.
    if (look === undefined) {
      this.#waiting.delete(sessionId);
      this.#owed.delete(sessionId);
      return;
    }

    const facts = this.#facts(sessionId, entry, look);
    const verdict = decide(facts);

    if (verdict === 'drop') {
      if (entry.cls === 'done' && !doneStaysOwed(facts)) this.#owed.delete(sessionId);
      // Praca w tle i subagent czekający na własną komendę gaszą tylko „gotowe" i nie widać ich
      // w stanie sesji — log ma je nazwać.
      const background = entry.cls === 'done' && look.backgroundTasks > 0
        ? `, working in the background: ${String(look.backgroundTasks)}`
        : entry.owedRelease && look.waitingOnOwnCommand
          ? ', owed waits: the subagent waits for its own command' : '';
      this.#log?.(`${PUSH_QUIET_LOG} ${entry.project} (${entry.cls}, state=${look.state}${background})`);
      this.#waiting.delete(sessionId);
      return;
    }

    this.#waiting.delete(sessionId);
    this.#sent.set(sessionId, { cls: entry.cls, state: look.state });
    if (entry.cls === 'done') this.#owed.delete(sessionId);
    await this.#send(sessionId, entry);
  }

  /** Fakty do werdyktu, z chwili wywołania: wspólne dla `#check` i `clearAll`. */
  #facts(sessionId: string, entry: Waiting, look: SessionLook): DecideInput {
    return {
      cls: entry.cls,
      state: look.state,
      presentNow: this.#presence.active(),
      /*
       * Dwa dowody na „obsłużone" i DWA RÓŻNE pytania, na które odpowiadają:
       * `watching` — transkrypt tej sesji jest OTWARTY na telefonie, czyli człowiek patrzy
       * na sprawę teraz; `look.seen` — WYNIK bieżącej tury już odebrano, co dla dialogu
       * stojącego od minuty nie znaczy nic, więc nie sumujemy ich jednym `||`:
       * `seen` kasowałoby wtedy pushe blokujące bez śladu poza logiem
       * (start tury zeruje ten znacznik).
       */
      seen: this.#presence.watching(sessionId),
      resultSeen: look.seen,
      backgroundTasks: look.backgroundTasks,
      ...(entry.owedRelease ? { owedRelease: true } : {}),
      ...(look.waitingOnOwnCommand ? { waitingOnOwnCommand: true } : {}),
    };
  }

  async #send(sessionId: string, entry: Waiting): Promise<void> {
    const content = buildContent({
      cls: entry.cls,
      kind: entry.kind,
      project: entry.project,
      sessionId,
      ...(entry.label === undefined ? {} : { label: entry.label }),
      ...(entry.detail === undefined ? {} : { detail: entry.detail }),
      ...(entry.termId === undefined ? {} : { termId: entry.termId }),
      ...(this.#badge === undefined ? {} : { badge: this.#badge() }),
    });
    /*
     * Wynik idzie WYŁĄCZNIE do logu. Degradację harmonogram nie liczy: APNs liczy ją PER TOKEN
     * w rejestrze urządzeń (`DEGRADED_AFTER_FAILURES`, `apns-sink.ts`), a apka pyta o nią
     * `POST /api/push/apns/status`.
     */
    const report = await this.#sink.send(content);
    this.#log?.(sendLogLine(entry.kind, entry.project, report));
  }
}
