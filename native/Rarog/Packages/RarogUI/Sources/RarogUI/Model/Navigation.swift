import Foundation
import Observation
import RarogContract
import RarogCore

// Model nawigacji apki: co stoi w prawej kolumnie, pamięć zakładek i projektów TEGO urządzenia,
// zwinięcie listy, jej układ i zwinięte projekty drzewa, uzbrojenie „×" i zdanie pod paskiem zakładek
// (drzewo). Reguły (cel wejścia w projekt, cel
// Cmd+L, kto ma „×", co widać w zwiniętym projekcie) liczy rdzeń; tu jest stan widoku i jego zapis
// w preferencjach urządzenia. Trasa terminala, okna Cmd+F/Cmd+G i historia terminala:
// `Navigation+Terminal.swift`. Właściciel: projekty i zakładki.

/// Powiadomienie o drugim (albo pierwszym) Cmd+X z ekranu sesji: `cut:` dochodzi do kontrolera
/// transkryptu, a stan uzbrojenia żyje tutaj. `object` = identyfikator sesji.
public extension Notification.Name {
  static let rarogCloseTabShortcut = Notification.Name("pl.useo.rarog.closeTabShortcut")
}

@MainActor
@Observable
public final class RarogNavigation {
  public enum Detail: Hashable, Sendable {
    case session(String)
    /// Projekt bez żywej sesji: ekran z „Nową sesją w tym katalogu".
    case project(String)
    /// Terminal o znanym id: zakładka, cel powiadomienia, „Nowy terminal" po pierwszej odpowiedzi serwera.
    case terminal(String)
    /// Terminal, którego id jeszcze nie znamy (zaproszenie albo świadomy „Nowy terminal"). Pierwsza odpowiedź
    /// `POST /api/term` przepina trasę na ``terminal(_:)`` (``terminalIdentified(_:screen:state:)``).
    case openingTerminal(TerminalOpening)
    /// The Inbox: the last message of every agent that stopped, one card per session (`Navigation+Inbox.swift`).
    case inbox
  }

  /// Pierwsze naciśnięcie „×" (albo Cmd+X) uzbraja na 5 s; gaśnie wcześniej przy
  /// zmianie ekranu, utracie fokusu i dezaktywacji sceny (`disarmClose`).
  public struct CloseArm: Sendable, Equatable {
    public let sessionId: String
    public let until: Date
  }

  /// Zdanie pod paskiem zakładek (powód blokady „+", odmowa serwera); gaśnie samo.
  public struct Notice: Sendable, Equatable, Identifiable {
    public let id: UUID
    public let text: String
    public let lifetime: TimeInterval
  }

  /// Sesja założona z tego urządzenia, której lista jeszcze nie zna: nagłówek „Sesja · startuje"
  /// zamiast „Nie znam takiej sesji" (202 bywa szybsze niż ramka listy).
  public struct Launch: Sendable, Equatable {
    public let sessionId: String
    public let at: Date
  }

  public static let closeArmWindow: TimeInterval = 5
  public static let launchGrace: TimeInterval = 20

  /// Prawa kolumna; `nil` = „Wybierz sesję z listy obok.". Zmiana rozbraja „×", a zmiana
  /// EKRANU zamyka okno nad nim — terminal, historię i diff — przepięcie „Nowego terminala"
  /// na jego id ekranem nie jest. Formularz zostaje: ma stan, a zmiana ekranu z zewnątrz (powiadomienie) nie
  /// może go skasować.
  public var detail: Detail? {
    didSet {
      guard oldValue != detail else { return }
      screenChangedAt = Date()
      // Recorded here, at the change itself: on a system pop the list re-enters the window and lays out before any
      // SwiftUI `onChange` runs, and that layout is the last moment to scroll before the list appears.
      listReturn = ListReturnScroll.isReturn(from: oldValue, to: detail) ? oldValue : nil
      closeArm = nil
      if !adopting {
        if sheet?.isWindow == true { sheet = nil }
        // Arkusz panelu na telefonie jest oknem tego ekranu: zmiana ekranu go zamyka.
        if inspector.sheet != nil { inspector.sheet = nil }
        screenRevision += 1
      }
      if case .openingTerminal = detail {} else { openingOwners.removeAll() }
      inboxOrigin = inboxOrigin?.following(from: oldValue, to: detail, adopting: adopting)
    }
  }

  /// The session on screen was opened from the Inbox and the Inbox still stands behind it
  /// (``RarogNavigation/openSessionFromInbox(_:)``): the route moves with the screen when it takes its terminal's
  /// route (``settleHostedRoute(_:)``); any other change of the right column clears it.
  public internal(set) var inboxOrigin: InboxOrigin?
  /// The session of the Inbox card the voice agent talks about (`VoiceAgentInboxConversation`): its transcript stream
  /// stands while the Inbox is on screen (``transcriptSessionId``).
  public internal(set) var inboxVoiceTarget: String?

  /// The session or terminal screen the human just came back from to the list, until the list takes it
  /// (``takeListReturn()``) or another screen opens. Not observed: taking it must not redraw anything.
  @ObservationIgnored var listReturn: Detail?

  /// Chwila ostatniego przyjętego Cmd+L (`acceptsPreviousProject(at:)`).
  @ObservationIgnored var previousProjectJumpAt: Date?

  /// Zwinięcie listy (Cmd+B) — przeżywa obrót i ponowne uruchomienie.
  public private(set) var listCollapsed: Bool
  /// Projekty, które człowiek sam zwinął w drzewie; reszta jest rozwinięta.
  public private(set) var collapsedProjects: CollapsedProjects
  /// Projects the human pinned in the tree on this device: they stand on top. Observed, so a pin redraws the list also
  /// when the order of the rows stays (the glyph, the reader's value, the menu item).
  public private(set) var pinnedProjects: PinnedProjects
  /// The filter segment over the list, in memory only: the app always starts on All, because a forgotten filter
  /// would hide sessions without a trace (`Navigation+ListFilter.swift`).
  public internal(set) var listFilter: ListFilter = .all
  /// Rows shown under the current segment choice that stand after they leave the segment
  /// (`AppState.projectTree(collapsed:pinned:filter:held:)`).
  public internal(set) var listFilterHeld: Set<String> = []
  /// Prawy panel sesji na iPadzie (`Model/Inspector.swift`).
  public let inspector: RarogInspector
  public private(set) var tabMemory: ProjectTabMemory
  public private(set) var history: ProjectHistory
  /// Sessions visited on this device, newest last (``lastVisitedSession(_:)``, ``noteSessionVisit(_:)``).
  public private(set) var sessionHistory: SessionHistory
  public private(set) var closeArm: CloseArm?
  public private(set) var notice: Notice?
  public private(set) var creating = false
  /// Sesje, których zamknięcie jest w drodze.
  public private(set) var closing: Set<String> = []
  /// Sesje zamknięte, które lista jeszcze ma: odpowiedź HTTP bywa przed ramką SSE, która je zdejmuje.
  private var closedPendingList: Set<String> = []
  public private(set) var launch: Launch?
  /// Katalog notatki stojącej w dymku do czytania (dymek z paska albo z drzewa): ⌘J otwiera formularz TEJ
  /// notatki, nie notatki projektu z ekranu pod spodem. Ustawia i zdejmuje sam dymek.
  public var noteBubble: String?
  /// Arkusz nad ekranem: okno (terminal Cmd+F/Cmd+G, historia trasy, diff) albo formularz („Nowa sesja”,
  /// „Ostatnie sesje”) — jeden naraz (`Model/AppSheet.swift`). Zmienia się przez ``openSheet(_:)``,
  /// ``closeSheet(id:)`` i wejścia okien w `Navigation+Terminal.swift`.
  public internal(set) var sheet: AppSheet? {
    didSet {
      // The page belongs to the Settings presentation: any other sheet, or none, starts the next Settings on the list.
      if sheet?.id != oldValue?.id || settingsSheet == nil { settingsPage = nil }
    }
  }
  /// The page standing over the Settings list (`nil` = the list). Set by ``openSettings(page:)`` and by the sheet's
  /// navigation binding; cleared with the Settings sheet (`Model/SettingsPage.swift`).
  public internal(set) var settingsPage: SettingsPage?
  /// A page change waiting for its second step in ``openSettings(page:)``: requests made meanwhile only retarget it.
  @ObservationIgnored var pendingSettingsPage: PendingSettingsPage?
  /// Katalogi terminali, których lista `GET /api/term` jeszcze nie zna (świeży „Nowy terminal"): nagłówek
  /// i pasek wiedzą, w którym projekcie stoją, zanim dojedzie lista.
  public internal(set) var terminalCwds: [String: String] = [:]
  /// Ekran „Nowego terminala" przepięty na id terminala: ta sama tożsamość widoku (bez nowego połączenia).
  var adopted: AdoptedScreen?
  /// Przepięcie trasy na id terminala tego samego ekranu — nie zamyka okna ani historii.
  @ObservationIgnored var adopting = false
  /// Ujście czytnika dla zdania pod paskiem: `post` ogłasza je raz, w chwili powstania. Karta tego nie
  /// robi, bo w stosie to samo zdanie przechodzi ze szczegółu nad listę i druga karta ogłaszałaby je drugi raz.
  /// Testy podają własne ujście.
  @ObservationIgnored var announce: @MainActor (String) -> Void = { Announcer.shared.say($0) }
  /// Widok, który pierwszy narysował „Nowy terminal" (token → instancja widoku): tylko on prosi o `next`.
  @ObservationIgnored var openingOwners: [UUID: UUID] = [:]
  /// Numer EKRANU prawej kolumny: rośnie przy każdej zmianie ekranu, ale nie przy przepięciu „Nowego terminala" na
  /// jego id (ten sam ekran). Odłożone akcje (otwarcie sesji z dymka w następnej klatce, `ToastHandoff`) sprawdzają
  /// nim, czy człowiek nie przeszedł w międzyczasie gdzie indziej.
  @ObservationIgnored public private(set) var screenRevision = 0
  /// Chwila ostatniej zmiany prawej kolumny — tylko do śladu zmian zaznaczenia listy.
  @ObservationIgnored public private(set) var screenChangedAt: Date?

  @ObservationIgnored private let prefs: PreferenceStore

  public init(prefs: PreferenceStore = UserDefaults.standard) {
    self.prefs = prefs
    inspector = RarogInspector(prefs: prefs)
    listCollapsed = prefs.bool(forKey: NavigationPreferences.listCollapsed)
    collapsedProjects = NavigationPreferences.load(
      CollapsedProjects.self, key: NavigationPreferences.collapsedProjects, from: prefs) ?? CollapsedProjects()
    pinnedProjects = NavigationPreferences.load(
      PinnedProjects.self, key: NavigationPreferences.pinnedProjects, from: prefs) ?? PinnedProjects()
    tabMemory = NavigationPreferences.load(ProjectTabMemory.self, key: NavigationPreferences.projectTabs, from: prefs)
      ?? ProjectTabMemory()
    history = NavigationPreferences.load(ProjectHistory.self, key: NavigationPreferences.projectHistory, from: prefs)
      ?? ProjectHistory()
    sessionHistory = NavigationPreferences.load(
      SessionHistory.self, key: NavigationPreferences.sessionHistory, from: prefs) ?? SessionHistory()
  }

  // MARK: - Wybór

  public var selectedSessionId: String? {
    if case let .session(id) = detail { return id }
    return nil
  }

  /// Tap w powiadomienie albo adres `rarog://session/<id>`: ekran tej sesji. Wpis agenta
  /// stojącego w terminalu Raroga (`termId`) prowadzi do tego terminala: sesja znana liście rysuje go sama
  /// (``DetailView``), a nieznana — trasą terminala wprost.
  public func openPushTarget(_ target: PushTarget, state: AppState) {
    if let termId = target.termId, state.sessions[target.sessionId] == nil {
      open(.terminal(termId), state: state)
    } else {
      detail = .session(target.sessionId)
    }
  }

  /// Tło kafla Live Activity (`rarog://list`) albo liczba, której sesji już nie ma: lista agentów. Na
  /// iPhonie stos schodzi do listy, na iPadzie zwinięta lista wraca obok, a prawa kolumna nie trzyma żadnej trasy.
  public func openList() {
    setListCollapsed(false)
    detail = nil
  }

  /// Wybór z listy agentów. Odznaczenie (`nil`) zdejmuje tylko sesję, nie ekran projektu.
  public func selectSession(_ id: String?) {
    if let id {
      detail = .session(id)
    } else if selectedSessionId != nil {
      detail = nil
    }
  }

  /// Katalog projektu na ekranie: sesji, terminala albo ekranu projektu bez sesji.
  public func currentProjectCwd(_ state: AppState) -> String? {
    switch detail {
    case let .session(id): state.projectCwd(ofSession: id)
    case let .project(cwd): ProjectPath.normalized(cwd)
    case let .terminal(id): terminalCwd(id, state: state)
    case let .openingTerminal(opening): ProjectPath.normalized(opening.cwd)
    case .inbox, nil: nil
    }
  }

  /// Projekt, w którym się STOI (Cmd+L, pamięć): sesja albo terminal o znanym id — ekran nowej sesji
  /// i terminal, którego jeszcze nie ma, nie są miejscami, do których się wraca.
  public func standingProjectCwd(_ state: AppState) -> String? {
    switch detail {
    case let .session(id): state.projectCwd(ofSession: id)
    case let .terminal(id): terminalCwd(id, state: state)
    case .project, .openingTerminal, .inbox, nil: nil
    }
  }

  /// Zakładka „tu jesteś" paska: sesja albo terminal; wpis agenta w terminalu Raroga stoi na zakładce
  /// tego terminala (własnej nie ma).
  public func currentTab(_ state: AppState) -> ProjectTabRef? {
    switch detail {
    case let .session(id):
      if let termId = state.hostTerminal(ofSession: id) { return .terminal(termId) }
      return .session(id)
    case let .terminal(id): return .terminal(id)
    case .project, .openingTerminal, .inbox, nil: return nil
    }
  }

  /// Wiersz zaznaczony na liście agentów: sesja na ekranie, a na trasie terminala — wpis agenta, który
  /// w nim stoi (inaczej wejście z wiersza gasiłoby jego zaznaczenie). Ta sama sesja niesie linię statusu
  /// nad terminalem i odbiór wyniku (`DetailView`).
  public func listSelection(_ state: AppState) -> String? {
    if let id = selectedSessionId { return id }
    guard case let .terminal(termId) = detail else { return nil }
    return state.hostedSession(inTerminal: termId)
  }

  /// Notuje zakładkę i projekt, w którym stoi człowiek. Wołane przy każdej zmianie ekranu
  /// i przy pojawieniu się katalogu sesji albo terminala; zapis tylko przy realnej zmianie.
  public func noteVisit(_ state: AppState) {
    guard let tab = currentTab(state), let cwd = standingProjectCwd(state) else { return }
    // Terminal otwarty, zanim lista go znała (powiadomienie): katalog z listy zostaje, bo udany `DELETE` zdejmie
    // wpis przed `onClose`, a powrót po „×" ma trafić do sesji TEGO projektu.
    if case let .terminal(id) = detail, terminalCwds[id] != cwd { terminalCwds[id] = cwd }
    if tabMemory.note(cwd: cwd, tab: tab) {
      NavigationPreferences.save(tabMemory, key: NavigationPreferences.projectTabs, to: prefs)
    }
    if history.note(cwd) {
      NavigationPreferences.save(history, key: NavigationPreferences.projectHistory, to: prefs)
    }
    if let id = selectedSessionId, launch?.sessionId == id { launch = nil }
  }

  // MARK: - Session history (the mark of the last visit on the list)

  /// Records the visited session: the list selection (``listSelection(_:)``), i.e. the session screen or the agent
  /// standing in the watched Rarog terminal. Called on every change of the list selection, also when an agent
  /// appears in the watched terminal; needs no known project directory. Saves only on a real change.
  public func noteSessionVisit(_ state: AppState) {
    guard let id = listSelection(state), sessionHistory.note(id) else { return }
    NavigationPreferences.save(sessionHistory, key: NavigationPreferences.sessionHistory, to: prefs)
  }

  /// The most recently visited session the app still knows: the stacked list marks it (`ListRowHighlight`). A gone
  /// session hands the mark to the newest one still known; no history, no mark.
  public func lastVisitedSession(_ state: AppState) -> String? {
    sessionHistory.recent(limit: 1) { state.sessions[$0] != nil }.first
  }

  // MARK: - Projekty

  /// Tap w wiersz projektu: zapamiętana żywa zakładka (sesja albo terminal) → ostatnio aktywna → ekran
  /// projektu.
  public func openProject(_ cwd: String, state: AppState) {
    switch state.projectTarget(cwd, remembered: tabMemory.remembered(cwd: ProjectPath.normalized(cwd))) {
    case let .session(id): detail = .session(id)
    case let .terminal(id): open(.terminal(id), state: state)
    case let .empty(cwd): detail = .project(cwd)
    }
  }

  /// Katalog celu Cmd+L — ta sama funkcja daje „cel Cmd+L” w etykiecie czytnika nagłówka drzewa.
  public func previousProjectCwd(_ state: AppState) -> String? {
    history.previous(current: standingProjectCwd(state)) { cwd in
      state.projectJumpTarget(cwd, remembered: tabMemory.remembered(cwd: cwd)) != nil
    }
  }

  /// Cmd+L: skok do zakładki poprzedniego projektu; `false` = brak celu (skrót milczy).
  @discardableResult
  public func openPreviousProject(_ state: AppState) -> Bool {
    guard let cwd = previousProjectCwd(state),
      let tab = state.projectJumpTarget(cwd, remembered: tabMemory.remembered(cwd: cwd))
    else { return false }
    open(tab, state: state)
    return true
  }

  // MARK: - Zakładki

  /// Zakładki bieżącego projektu w kolejności paska: sesje, potem terminale — TA SAMA lista, którą rysuje pasek
  /// (także bieżący terminal, którego lista `GET /api/term` jeszcze nie zna), więc numer i tap się nie rozjadą.
  public func tabRefs(_ state: AppState) -> [ProjectTabRef] {
    stripTabs(state).compactMap(\.target)
  }

  /// Modele zakładek paska bieżącego projektu (bez „+"); zaproszenie i terminal w zakładaniu nie mają celu.
  func stripTabs(_ state: AppState) -> [ProjectTabModel] {
    guard let cwd = currentProjectCwd(state) else { return [] }
    var opening = false
    if case .openingTerminal = detail { opening = true }
    return state.projectTabModels(cwd: cwd, current: currentTab(state), opening: opening)
  }

  /// Tap w zakładkę i Cmd+1…9: cel to identyfikator z chwili rysowania (`ShortcutMenu`). Zakładki, której
  /// w bieżącym projekcie już nie ma (zamknięta, na ekranie inny projekt), skrót nie zastępuje sąsiadką
  /// — nic nie robi; nawiguje, nigdy nie tworzy.
  @discardableResult
  public func openTab(_ tab: ProjectTabRef, state: AppState) -> Bool {
    guard tabRefs(state).contains(tab) else { return false }
    if tab != currentTab(state) { open(tab, state: state) }
    return true
  }

  /// Zakładka na ekran. Terminal z listy zostawia katalog — nagłówek wie, gdzie stoi, nawet gdy lista
  /// za chwilę go zgubi (zamknięcie na Macu).
  func open(_ tab: ProjectTabRef, state: AppState) {
    switch tab {
    case let .session(id):
      detail = .session(id)
    case let .terminal(id):
      if let cwd = state.projectCwd(ofTerminal: id) { terminalCwds[id] = cwd }
      detail = .terminal(id)
    }
  }

  // MARK: - Lista

  /// Na ekranie listy (bez szczegółu) skrót nic nie robi: zwinięta lista obok zaproszenia
  /// „Wybierz sesję z listy obok." byłaby pułapką.
  public var canToggleList: Bool { detail != nil }

  public var listHidden: Bool { listCollapsed && detail != nil }

  public func setListCollapsed(_ collapsed: Bool) {
    guard collapsed != listCollapsed else { return }
    listCollapsed = collapsed
    prefs.set(collapsed, forKey: NavigationPreferences.listCollapsed)
  }

  public func toggleList() {
    guard canToggleList else { return }
    setListCollapsed(!listCollapsed)
  }

  // MARK: - Drzewo projektów

  /// Zwija albo rozwija projekty drzewa (strzałka, „Zwiń wszystkie”, „Rozwiń wszystkie”); `true` = zmiana. Ostatnio
  /// otwarte wiersze tych projektów zwalnia rdzeń (`RarogStore.projectsToggled`) — woła go ten sam gest. `present` =
  /// katalogi nagłówków stojących w drzewie: sufit pamięci ich nie wypycha (``CollapsedProjects``).
  @discardableResult
  public func setProjectsCollapsed(_ cwds: [String], collapsed: Bool, present: Set<String> = []) -> Bool {
    guard collapsedProjects.set(cwds, collapsed: collapsed, present: present) else { return false }
    NavigationPreferences.save(collapsedProjects, key: NavigationPreferences.collapsedProjects, to: prefs)
    return true
  }

  /// Pins or unpins a project of the tree (the header's menu and reader action); `true` = a change, saved only then.
  /// `present` = directories of the headers standing in the tree: the memory's cap does not unpin them
  /// (``PinnedProjects``).
  @discardableResult
  public func setProjectPinned(_ cwd: String, pinned: Bool, present: Set<String> = []) -> Bool {
    guard pinnedProjects.set(cwd, pinned: pinned, present: present) else { return false }
    NavigationPreferences.save(pinnedProjects, key: NavigationPreferences.pinnedProjects, to: prefs)
    return true
  }

  // MARK: - Stos (iPhone, wąskie okno)

  /// W stosie (`compact`) na wierzchu stoi szczegół, dopóki jest w nim trasa — także taka, której lista nie
  /// zaznacza: terminal, „Nowy terminal", projekt bez sesji. Samo zaznaczenie listy (``listSelection(_:)``)
  /// cofałoby stos do listy przy każdej trasie bez wiersza.
  public var compactShowsDetail: Bool { detail != nil }

  /// System zszedł w stosie do listy („wstecz", gest krawędzi): trasa szczegółu znika — każda, nie tylko sesja,
  /// inaczej następna zmiana stanu wepchnęłaby zostawiony terminal z powrotem na wierzch.
  public func compactReturnedToList() {
    detail = inboxBehindSession ? .inbox : nil
  }

  // MARK: - Zamknięcie

  public enum CloseStep: Sendable, Equatable {
    /// Pierwsze naciśnięcie: „Na pewno?" na 5 s.
    case armed
    /// Drugie naciśnięcie w oknie: zamykamy.
    case confirmed
    /// „×" tu nie istnieje (Codex, nieznany silnik, nieobsługiwana, zamykanie w toku).
    case unavailable
  }

  public func requestClose(_ sessionId: String, state: AppState, now: Date) -> CloseStep {
    // Lista z pamięci podręcznej: zero akcji do świeżego stanu — także Cmd+X.
    guard let session = state.sessions[sessionId], session.canClose, !closing.contains(sessionId), !state.listStale else {
      return .unavailable
    }
    if let arm = closeArm, arm.sessionId == sessionId, arm.until > now {
      closeArm = nil
      return .confirmed
    }
    closeArm = CloseArm(sessionId: sessionId, until: now.addingTimeInterval(Self.closeArmWindow))
    announceArming(session)
    return .armed
  }

  public func isCloseArmed(_ sessionId: String, now: Date) -> Bool {
    guard let arm = closeArm else { return false }
    return arm.sessionId == sessionId && arm.until > now
  }

  /// Rozbraja konkretne uzbrojenie (upływ czasu, zniknięcie „×") — nowsze zostaje.
  public func disarm(_ arm: CloseArm) {
    if closeArm == arm { closeArm = nil }
  }

  /// Rozbraja każde uzbrojenie: fokus zszedł z „×" albo przeszedł do pola wiadomości, scena
  /// przestała być aktywna. Kolejne naciśnięcie „×" albo Cmd+X uzbraja od nowa.
  public func disarmClose() {
    closeArm = nil
  }

  /// Zamyka sesję; cel powrotu liczony W CHWILI decyzji: ostatnio aktywna siostra, bez niej lista. Zamknięcia RÓŻNYCH
  /// sesji idą równolegle (lista zamyka od razu, bez pytania), to samo drugi raz nie wychodzi.
  public func close(_ sessionId: String, store: RarogStore) async {
    guard !closing.contains(sessionId) else { return }
    let returnTo = store.state.closeReturnSession(sessionId)
    // Sesja na ekranie to także agent stojący w oglądanym terminalu: jego „×" zamyka panel razem z powłoką.
    // Terminal zapamiętany PRZED żądaniem, bo zamknięta karta znika z listy razem ze swoim `termId`.
    let hostTerminal = store.state.hostTerminal(ofSession: sessionId)
    closing.insert(sessionId)
    defer { closing.remove(sessionId) }
    let outcome = await store.closeSession(sessionId)
    closedPendingList = closedPendingList.filter { store.state.sessions[$0] != nil }
    if outcome == .closed {
      closedPendingList.insert(sessionId)
      // Ekran z chwili ODPOWIEDZI: w trakcie żądania człowiek mógł przejść gdzie indziej. Siostra, która w tym czasie
      // zniknęła, sama jest zamykana albo już zamknięta, nie jest celem — wtedy lista.
      let onScreen = selectedSessionId == sessionId || (hostTerminal != nil && currentTerminalId == hostTerminal)
      let gone = closing.union(closedPendingList)
      let target = returnTo.flatMap { store.state.sessions[$0] != nil && !gone.contains($0) ? $0 : nil }
      if onScreen { detail = target.map(Detail.session) }
    } else if let message = UICopy.closeMessage(outcome) {
      post(message)
    }
  }

  // MARK: - Nowa sesja

  /// Zapamiętany model i effort (pisze je formularz nowej sesji po udanym starcie).
  public var newSessionDefaults: NewSessionDefaults {
    NavigationPreferences.load(NewSessionDefaults.self, key: NavigationPreferences.newSession, from: prefs)
      ?? NewSessionDefaults()
  }

  /// „+" i Cmd+N: te same bramki; blokada mówi powód zdaniem serwera, sukces otwiera nową sesję.
  public func createSession(in cwd: String, store: RarogStore, now: Date = Date()) async {
    guard !creating else { return }
    if store.state.launchBlocked {
      post(UICopy.launchBlocked(store.state.launchBlockedDetail))
      return
    }
    creating = true
    defer { creating = false }
    let outcome = await store.createSession(in: cwd, defaults: newSessionDefaults)
    if case let .created(id, _) = outcome {
      // Ostrzeżenie o zaufaniu katalogu stoi w transkrypcie nowej sesji.
      openLaunched(id, now: now)
    } else if let message = UICopy.createMessage(outcome) {
      post(message)
    }
  }

  /// Sesja założona z tego urządzenia („+", Cmd+N, formularz nowej sesji): od razu wejście w nią
  /// w stanie „startuje" — lista bywa wolniejsza od odpowiedzi 202. Ostrzeżenie o zaufaniu
  /// katalogu (`trustPrompt` w 202) stawia rdzeń w transkrypcie tej sesji, nie tu.
  public func openLaunched(_ sessionId: String, now: Date = Date()) {
    launch = Launch(sessionId: sessionId, at: now)
    detail = .session(sessionId)
  }

  /// Model i effort z formularza nowej sesji — zapis WYŁĄCZNIE po udanym starcie.
  public func rememberNewSessionDefaults(_ defaults: NewSessionDefaults) {
    NavigationPreferences.save(defaults, key: NavigationPreferences.newSession, to: prefs)
  }

  /// Czy nieznana jeszcze sesja to ta, którą to urządzenie właśnie założyło.
  public func isLaunching(_ sessionId: String, now: Date) -> Bool {
    guard let launch, launch.sessionId == sessionId else { return false }
    return now.timeIntervalSince(launch.at) < Self.launchGrace
  }

  // MARK: - Zdanie pod paskiem

  public func post(_ text: String, lifetime: TimeInterval = 5) {
    notice = Notice(id: UUID(), text: text, lifetime: lifetime)
    announce(text)
  }

  public func clearNotice(_ id: UUID) {
    if notice?.id == id { notice = nil }
  }
}
