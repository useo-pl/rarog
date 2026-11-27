import Foundation
import RarogContract

// Live Activity widziana z listy bieżącego połączenia. Pełną treść kafla wysyła serwer
// (`server/src/notify/live-activity.ts`); apka składa sama stan STARTOWY — liczniki i cel tapnięcia — tą samą
// regułą co `aggregateState` (`server/src/notify/live-activity-state.ts`), a po starcie zapisuje na kaflu
// wyłącznie liczniki. Przebiegów workflow, limitów i Maca apka nie składa: serwer wysyła pełny stan zaraz po
// rejestracji tokenu aktywności, a zapis z apki to NAKŁADKA liczników na treść, którą system trzyma
// (``LiveActivityInput/overlay(displayed:local:)``), ze znacznikiem z zegara serwera (``AppState/liveActivityAsOf``).
// Liczniki i znacznik zapisu idą z obrazu listy samego strumienia globalnego (``AppState/globalList``), nie
// z ``AppState/sessions``; stan startowy i „zajęty" — z ``AppState/sessions``.
// Parytet liczników i `top` pilnuje `LiveActivityInputTests` na złotych ramkach (`shared/fixtures/apns/`).
//
// Drugi selektor to `isBusy` — warunek startu i zegara ciszy, też lustro serwera (`isBusy` tamże): coś
// czeka albo pracuje ALBO w tle mieli przebieg workflow, który się nie skończył.
//
// Czy lista zadań w tle jest pracą, żaden z nich nie rozstrzyga sam: pytają `BackgroundTaskRules`
// (`BackgroundTaskRules.swift`, jedno miejsce tych reguł) i tylko składają odpowiedź ze stanem sesji.
// Subagent w postoju pracą nie jest: sesja po turze, której całe tło czeka, liczy się do
// „skończyły", nie do „pracuje" (złota ramka `live-activity.update.waiting-agent.json`). Once its wait reaches
// `stuck` (`BackgroundTaskRules.stuckWait`), the session counts as waiting instead; the silence timer ignores it.
//
// Prywatność: z sesji wchodzą WYŁĄCZNIE stany (do
// liczników), `seen`, id sesji i `termId`. Nigdy `waitingFor`, `activity`, `lastSummary`, etykieta ani
// opis zadania — kontrakt stanu i tak nie ma na nie pól. Właściciel: Live Activity.

extension AppState {
  /// Stan STARTOWY kafla z listy bieżącego połączenia; `nil`, gdy lista nie jest świeża (z pamięci
  /// podręcznej, sprzed zejścia w tło, przed pełnym stanem) — wtedy kafla lepiej nie ruszać.
  public func liveActivityInput(now: Date) -> LiveActivityContentState? {
    guard listLive else { return nil }
    return LiveActivityInput.aggregate(Array(sessions.values), now: now)
  }

  /// „Coś czeka, pracuje albo mieli w tle" na świeżej liście (start aktywności i zegar ciszy); `nil`, gdy
  /// lista nie jest świeża.
  public var liveActivityBusy: Bool? {
    guard listLive else { return nil }
    return LiveActivityInput.isBusy(sessions.values)
  }

  /// Znacznik zapisu liczników z apki: najnowszy `stateSince` obrazu listy strumienia globalnego (``globalList``),
  /// ucięty do pełnej sekundy, MINUS 1 s — zegar SERWERA (przejście stanu stempluje serwer). Push niesie
  /// `aps.timestamp` z tego samego zegara w pełnych sekundach, nie mniejszy niż sekunda wysłania, więc:
  /// - każdy push wysłany PO tym przejściu ma znacznik ściśle większy od zapisu i system przyjmie go zamiast zapisu,
  ///   jakkolwiek ActivityKit traktuje znaczniki równe;
  /// - zapis przyjęty znaczy, że ostatni push wyszedł przed tym przejściem, a strumień globalny dowiózł wtedy, w swojej
  ///   kolejności, wszystko, co ten push niósł.
  ///
  /// Zegar telefonu tu nie wchodzi. `nil` przy liście nieświeżej albo bez czytelnego `stateSince` (zapisu nie ma).
  var liveActivityAsOf: Date? {
    guard listLive, let latest = globalList.values.compactMap({ ISOTime.parse($0.stateSince) }).max() else {
      return nil
    }
    return Date(timeIntervalSince1970: latest.timeIntervalSince1970.rounded(.down) - 1)
  }

  /// Zapis liczników z apki z obrazu listy strumienia globalnego: liczniki tą samą regułą co stan startowy
  /// (``LiveActivityInput/aggregate(_:now:)``) i znacznik ``liveActivityAsOf`` z TEGO SAMEGO obrazu.
  func liveActivityWrite(now: Date) -> LiveActivityWrite? {
    guard let asOf = liveActivityAsOf else { return nil }
    return LiveActivityWrite(local: LiveActivityInput.aggregate(Array(globalList.values), now: now), asOf: asOf)
  }

  /// Ramka strumienia GLOBALNEGO w obrazie ``globalList`` (woła reduktor przy każdej ramce tego źródła). Wchodzą
  /// tylko ramki, które zmieniają zbiór sesji albo pola liczników (stan, `seen`, `backgroundTasks`): pełny stan
  /// zastępuje obraz (to także jedyna droga usunięcia sesji), `session-changed` podmienia albo dodaje sesję,
  /// `state` zmienia stan znanej sesji (`stateSince` tylko przy innym stanie, jak w ``sessions``). Bez strażnika
  /// starszych przejść ``sessions``: jeden strumień ma jedną kolejność, a obraz ma być jej wiernym odbiciem.
  mutating func noteGlobalList(_ frame: ServerEvent) {
    switch frame {
    case let .sessionsSnapshot(snapshot):
      globalList = Dictionary(snapshot.sessions.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
    case let .sessionChanged(changed):
      globalList[changed.session.id] = changed.session
    case let .state(event):
      guard var session = globalList[event.sessionId] else { return }
      if event.state != session.state { session.stateSince = event.since }
      session.state = event.state
      globalList[event.sessionId] = session
    default:
      return
    }
  }
}

extension AppState {
  /// Pierwsza sesja danego rodzaju w kolejności listy (``listOrder``) — cel liczby na kaflu Live Activity. Rodzaj
  /// liczy się TYMI SAMYMI predykatami co liczniki kafla (``LiveActivityInput``, lustro serwera), nie tonem kropki:
  /// zakończony workflow w tle nie robi z „skończyło” pracy. `nil` = takiej już nie ma
  /// (kafel bywa spóźniony); wtedy link prowadzi na listę.
  public func firstSession(_ kind: SessionJump) -> SessionSummary? {
    listOrder.first { LiveActivityInput.matches($0, kind) }
  }
}

/// Czyste składanie stanu startowego kafla (lustro `aggregateState` bez przebiegów, limitów i Maca).
enum LiveActivityInput {
  static let waitingStates: Set<SessionState> = [.waitingPermission, .waitingQuestion]
  static let workingStates: Set<SessionState> = [.starting, .running]
  /// Stany, które zadanie w tle podnosi do „pracuje" — na liście tony spokojne (`statusTone`).
  static let quietStates: Set<SessionState> = [.waitingInput, .done, .resumable, .unsupported]

  /// Lista sesji → stan: `waiting` = zgoda + pytanie, `working` = start + praca ORAZ sesja po turze, w której
  /// coś mieli w tle („pracuje w tle"; reguła `BackgroundTaskRules.hasBackgroundWork`), `finished` = po
  /// turze z nieodebranym wynikiem (`seen != true`, lustro `isFinished` PWA) i bez pracy w tle; wiodąca =
  /// najdłużej czekająca, a bez czekających — najdłużej pracująca w turze (stabilna: zmienia się dopiero, gdy
  /// TA sesja zmieni stan). A session after a turn with a subagent stuck on its own command
  /// (`BackgroundTaskRules.stuckWait`) counts once, as waiting, and is not the lead: its turn is over.
  /// Counters come from ``matches(_:_:)``, so the number and its jump target never disagree.
  static func aggregate(_ sessions: [SessionSummary], now: Date) -> LiveActivityContentState {
    let lead = longest(sessions.filter { waitingStates.contains($0.state) })
      ?? longest(sessions.filter { workingStates.contains($0.state) })
    return LiveActivityContentState(
      waiting: sessions.count(where: { matches($0, .waiting) }),
      working: sessions.count(where: { matches($0, .working) }),
      finished: sessions.count(where: { matches($0, .finished) }),
      top: lead.map(top(of:)),
      updatedEpoch: Int(now.timeIntervalSince1970.rounded(.down)))
  }

  /// Lustro serwerowego `isBusy`: liczy się z SESJI, nie ze stanu kafla. Poza decyzją i turą kafel trzyma
  /// tylko otwarty przebieg workflow (`BackgroundTaskRules.hasOpenWorkflow`). Inne zadania w tle go nie
  /// trzymają, choć licznik „pracuje" je liczy: serwer deweloperski w tle mieli bez końca, a kafel ma zejść
  /// po 30 min bez decyzji, tury i workflow.
  static func isBusy(_ sessions: some Sequence<SessionSummary>) -> Bool {
    sessions.contains { session in
      if waitingStates.contains(session.state) || workingStates.contains(session.state) { return true }
      return BackgroundTaskRules.hasOpenWorkflow(session.backgroundTasks)
    }
  }

  /// Sesja liczy się do licznika `kind` (i jest celem jego liczby na kaflu, ``AppState/firstSession(_:)``).
  /// „Coś jeszcze mieli w tle" to `BackgroundTaskRules.hasBackgroundWork`, jak w ``aggregate(_:now:)``. A stuck wait
  /// after a turn (`BackgroundTaskRules.stuckWait`) makes the session waiting and takes it out of the other two.
  static func matches(_ session: SessionSummary, _ kind: SessionJump) -> Bool {
    let stuck = BackgroundTaskRules.stuckWait(session.state, session.backgroundTasks)
    switch kind {
    case .waiting:
      return waitingStates.contains(session.state) || stuck
    case .working:
      return workingStates.contains(session.state)
        || (quietStates.contains(session.state) && !stuck
          && BackgroundTaskRules.hasBackgroundWork(session.backgroundTasks))
    case .finished:
      return session.state == .waitingInput && session.seen != true && !stuck
        && !BackgroundTaskRules.hasBackgroundWork(session.backgroundTasks)
    }
  }

  /// Najstarszy `stateSince`; czas nieczytelny idzie na koniec, remis rozstrzyga id.
  static func longest(_ sessions: [SessionSummary]) -> SessionSummary? {
    sessions.min { a, b in
      let at = ISOTime.parse(a.stateSince)?.timeIntervalSince1970 ?? .infinity
      let bt = ISOTime.parse(b.stateSince)?.timeIntervalSince1970 ?? .infinity
      return at != bt ? at < bt : a.id < b.id
    }
  }

  /// Cel tapnięcia: sesja (albo terminal wpisu Codexa) — nic, co kafel by pokazywał.
  static func top(of session: SessionSummary) -> LiveActivityContentState.Top {
    LiveActivityContentState.Top(
      sessionId: session.id,
      termId: session.termId.flatMap { LiveActivityContentState.Top.acceptsTermId($0) ? $0 : nil })
  }

  /// Zapis z apki: z listy WYŁĄCZNIE `waiting`, `working`, `finished`; wszystko inne z treści, którą system trzyma
  /// (ostatni push serwera): `top`, przebiegi, „+N”, limity, Mac, `updatedEpoch` (detektor zatrzymanego kafla mierzy
  /// dalej wiek treści serwera) i `staleDate`, także `nil` (zapis nie przedłuża daty nieświeżości). `top` zostaje
  /// z pusha, bo kafel go nie czyta — sesję wybiera apka po otwarciu.
  static func overlay(displayed: LiveActivityContent, local: LiveActivityContentState) -> LiveActivityContent {
    var state = displayed.state
    state.waiting = local.waiting
    state.working = local.working
    state.finished = local.finished
    return LiveActivityContent(state: state, staleDate: displayed.staleDate)
  }
}

/// Liczniki kafla, które apka zapisuje sama — jedyna część treści, którą zna z listy.
struct LiveActivityCounts: Equatable {
  let waiting: Int
  let working: Int
  let finished: Int

  init(_ state: LiveActivityContentState) {
    waiting = state.waiting
    working = state.working
    finished = state.finished
  }
}
