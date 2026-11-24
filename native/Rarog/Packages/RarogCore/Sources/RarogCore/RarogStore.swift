import Foundation
import Observation
import RarogContract
import RarogTransport

/// Magazyn stanu apki: JEDNO źródło prawdy dla widoku (`@Observable`, główny aktor).
///
/// Stan zmienia wyłącznie czysty reduktor (``AppState/apply(_:now:timing:)``); magazyn prowadzi
/// to, co ma czas i skutki uboczne: pętle strumieni SSE, kolejkę wysyłki na dysku, obecność,
/// raport `kontrakt:` i odliczanie „Nie potwierdzono". Dekodowanie ramek biegnie w pętlach,
/// poza głównym aktorem.
@MainActor
@Observable
public final class RarogStore {
  public private(set) var state: AppState
  /// Rośnie przy każdej zmianie poświadczenia albo serwera (parowanie, „Zapomnij serwer”): interfejs buduje się
  /// od nowa, bo w pamięci trzymał obiekty starego transportu (ekran terminala z zatrzymaną sesją, szkice i notatki
  /// poprzedniego serwera). Osobna właściwość, nie pole `state`: korzeń sceny czyta tylko ją, więc nie przelicza się
  /// przy każdej ramce.
  public internal(set) var interfaceEpoch = 0

  // `internal`, nie `private`: czytają je rozszerzenia magazynu w innych plikach (`+Send`).
  /// Transport BIEŻĄCEGO poświadczenia. Podmienia go wyłącznie `RarogStore+Pairing` (parowanie, odpięcie,
  /// „Zapomnij serwer”) po zamknięciu wszystkiego, co należało do poprzedniego (`retire`); żądanie w drodze
  /// trzyma swoją kopię, a jego wynik odcina numer zalogowania.
  @ObservationIgnored var transport: any RarogTransporting
  /// Dysk kolejki bieżącej przestrzeni danych (`RarogStore+Spaces` podmienia go przy zmianie serwera).
  @ObservationIgnored var persistence: OutboxPersistence
  /// `internal`: nowy transport po parowaniu dostaje tę samą bramkę (`RarogStore+Pairing`).
  @ObservationIgnored let rules: MutationRules
  @ObservationIgnored let timing: CoreTiming
  @ObservationIgnored let clock: @Sendable () -> Date
  @ObservationIgnored let reporter = ContractReporter()
  /// Tłumacz zdań serwera: ramki SSE na wejściu reduktora i lista modeli (`RarogStore+Session`).
  @ObservationIgnored let renderer: SentenceRenderer
  /// Identyfikator obecności tej instancji apki (apka nie obsługuje wielu okien).
  @ObservationIgnored public let clientId = UUID().uuidString

  @ObservationIgnored private var phase: ScenePhase = .active
  /// `start()` got past the Keychain wait; a later call changes nothing, and a space entered from now on reads its
  /// queue itself (`RarogStore+Spaces`).
  @ObservationIgnored private(set) var started = false
  /// Strumienie zamknięte przez zejście w tło — wstają przy wejściu w `active`, z której fazy
  /// by nie przyszło (iOS wraca `background → inactive → active`).
  @ObservationIgnored private var suspendedInBackground = false
  /// Wpisy, których „Ponów" właśnie trwa — drugie tapnięcie nic nie wysyła. Właściciel: `+Send`.
  /// The value is the Retry's attempt from its start, the manifest write included; a voice agent's call joins it.
  @ObservationIgnored var retrying: [UUID: SendFlight] = [:]
  /// The delivery attempt in flight of each outbox entry, for the stop and against late results. Owner: `+Send`.
  @ObservationIgnored var sendFlights: [UUID: SendFlight] = [:]
  /// The voice agent's prompt sends running, by `clientMessageId`, with the prompt the id names: a second call with the
  /// same id and prompt shares the first. Owner: `+CompanionSend`.
  @ObservationIgnored
  var companionSends: [UUID: (prompt: CompanionPrompt, task: Task<CompanionSendOutcome, Never>)] = [:]
  /// Stall threshold of both streams: every `hello` of the global stream sets it, `retire` resets it.
  @ObservationIgnored let stallThreshold = StallThreshold()
  /// Clock and sleep of the stream loops (stall guard, retry backoff); tests swap it before `start()`.
  @ObservationIgnored var streamClock: TunnelRuntime.Timing = .system
  @ObservationIgnored private var globalLoop: Loop?
  @ObservationIgnored private var sessionLoop: Loop?
  @ObservationIgnored private var presenceTask: Task<Void, Never>?
  /// Łańcuch zapisów kolejki (po kolei). Właściciel: `+Send` i skutki reduktora tutaj.
  @ObservationIgnored var persistChain: Task<Void, Never>?
  @ObservationIgnored private var generation = 0
  /// Odpytywanie limitów planu i sonda wersji. Właściciel: `RarogStore+Usage`.
  @ObservationIgnored var usagePolling = UsagePolling()
  /// Login generation: every login and logout bumps it. Area code reads it only through the login guard below
  /// (`currentLogin`, `isCurrentLogin(_:)`, `handleUnauthorized(since:)`).
  @ObservationIgnored private(set) var loginGeneration = 0

  /// Odpowiedzi na karty pytań w drodze. Właściciel: `RarogStore+Answers`.
  @ObservationIgnored var answering = AnswerFlights()
  /// Żądania kart w drodze (decyzje, „Wznów"). Właściciel: `RarogStore+Decisions`.
  @ObservationIgnored var cardRequests = CardRequests()
  /// Żądania przerwania, „obejrzane" i formularza nowej sesji w drodze; wylogowanie je anuluje.
  /// Właściciel: `RarogStore+SessionControl`.
  @ObservationIgnored var turnRequests = TurnRequests()
  /// Zdjęcia do miniatur: pamięć, brakujące, odczyty w drodze. Właściciel: `RarogStore+Uploads`.
  @ObservationIgnored var uploadReads = UploadReads()
  /// Session file requests in flight; a logout cancels them. Owner: `RarogStore+Files`.
  @ObservationIgnored var sessionFileReads = SessionFileReads()
  /// The file tree of the session in the right panel. Owner: `RarogStore+FileTree`.
  public let fileTree: FileTreeStore
  /// Klucze dyktowania w drodze i numer zalogowania. Właściciel: `RarogStore+Voice`.
  @ObservationIgnored var voiceMinting = VoiceMinting()
  /// Pamięć podręczna listy na dysku i łańcuch jej operacji. Właściciel: `RarogStore+Cache`.
  @ObservationIgnored var listCacheDisk = ListCacheDisk()
  /// Sesje terminala na ekranie i odświeżanie listy terminali. Właściciel: `RarogStore+Terminal`.
  @ObservationIgnored var terminalArea = TerminalArea()
  /// System powiadomień, praca w tle, token urządzenia i rejestracja APNs. Właściciel: `RarogStore+Push`.
  @ObservationIgnored var pushRuntime = PushRuntime()
  /// Zbiorcza Live Activity: aktywność, token, zegar ciszy, rejestracja. Właściciel: `RarogStore+LiveActivity`.
  @ObservationIgnored var liveRuntime = LiveActivityRuntime()
  /// Sesje, których lista slash-komend jest właśnie czytana — drugi „/” nie wysyła drugiego żądania. Właściciel:
  /// `RarogStore+Commands`.
  @ObservationIgnored var commandReads: Set<String> = []
  /// Punkt końcowy, fabryki transportu i Keychain, zadania parowania. Właściciel: `RarogStore+Pairing`.
  @ObservationIgnored var serverRuntime = ServerRuntime()
  /// Inbox reads, the transcript read of a decision card and removals in flight. Owner: `RarogStore+Inbox`.
  @ObservationIgnored var inboxRuntime = InboxRuntime()
  /// Wybór dyktowania i flaga builda. Wybór należy do urządzenia: `retire` (wylogowanie, „Zapomnij serwer”,
  /// nowy serwer) go nie dotyka. Apka podpina ``DictationServices/live(sonioxAllowed:defaults:)``.
  public private(set) var dictation: DictationServices = .memory(sonioxAllowed: true, choice: nil)
  /// Ustawienia agenta głosowego: zgoda i głos. Należą do urządzenia: `retire` ich nie
  /// dotyka. Apka podpina ``VoiceAgentSettings/live(defaults:)`` (`RarogStore+VoiceAgent`).
  public internal(set) var voiceAgent: VoiceAgentSettings = .memory()

  private struct Loop {
    let id: Int
    let scope: StreamScope
    let task: Task<Void, Never>
  }

  /// - Parameters:
  ///   - rules: te same reguły, które dostał klient HTTP jako `MutationPolicy`.
  ///   - outboxDirectory: katalog kolejki (w apce `Application Support/outbox/`).
  ///   - listCacheDirectory: katalog pamięci podręcznej listy; `nil` = bez pamięci.
  ///   - renderer: tłumacz zdań serwera; domyślnie język apki, testy podają własny.
  public init(
    transport: any RarogTransporting,
    rules: MutationRules,
    outboxDirectory: URL,
    clientBuild: Int,
    timing: CoreTiming = .production,
    clock: @escaping @Sendable () -> Date = { Date() },
    listCacheDirectory: URL? = nil,
    renderer: @escaping SentenceRenderer = ServerText.renderer(language: .current)
  ) {
    self.transport = transport
    self.rules = rules
    self.timing = timing
    self.clock = clock
    self.renderer = renderer
    persistence = OutboxPersistence(directory: outboxDirectory)
    state = AppState(clientBuild: clientBuild)
    listCacheDisk.cache = listCacheDirectory.map { SnapshotCache(directory: $0) }
    fileTree = FileTreeStore(refreshGap: timing.fileTreeRefreshGap, indexGap: timing.fileIndexRefreshGap)
    rules.store = self
    fileTree.owner = self
  }

  /// Magazyn z prawdziwym klientem HTTP (reguły wpięte w bramkę transportu) i kluczem urządzenia, bez złącza
  /// serwera (integracje z demo). Apka buduje magazyn przez ``live(connector:preferences:outboxDirectory:listCacheDirectory:)``.
  public static func live(
    config: RarogConfig, device: DeviceCredential? = nil, outboxDirectory: URL, listCacheDirectory: URL? = nil
  ) -> RarogStore {
    let rules = MutationRules()
    let client = RarogClient(config: config, policy: rules, device: device)
    return RarogStore(
      transport: client, rules: rules, outboxDirectory: outboxDirectory, clientBuild: config.build,
      listCacheDirectory: listCacheDirectory)
  }

  // MARK: - Cykl życia

  /// Start apki: kolejka z dysku wraca na ekran, potem połączenie (albo ekran parowania).
  /// Z kluczem urządzenia pierwsza klatka rysuje listę z pamięci podręcznej jako
  /// nieświeżą (`RarogStore+Cache`). Keychain nieczytelny przed pierwszym odblokowaniem telefonu:
  /// ekran startowy zostaje, a start wraca przy wejściu na wierzch (`RarogStore+Pairing`).
  /// Takes effect once per store: the scene root runs its `.task` again whenever a full-screen cover over it closes,
  /// and a second `.loggedIn` would wipe what the store knows about the server (capabilities, plan limits, the list)
  /// until the next version probe. Every later login goes through `enterLoggedIn`, and a space entered after the start
  /// (pairing, unpairing) reads its own queue (`RarogStore+Spaces`) before a pairing logs in with its list cache.
  public func start() async {
    guard !serverRuntime.awaitingKeychain, !started else { return }
    // Set before the first `await`: the scene's `.task` and the Keychain retry can call it at the same time.
    started = true
    // Kolejka i lista z pamięci czytają się z przestrzeni bieżącego serwera (wybranej przy wpięciu, `RarogStore+Spaces`).
    await restoreOutbox()
    // A space entered during that read (pairing from a link at the start) reads its own queue: the login waits for it.
    await serverRuntime.spaceRestore?.value
    if transport.hasCredential {
      let cached = await readListCache()
      dispatch(.loggedIn)
      applyRestoredList(cached)
      resume()
      pushLoggedIn()
    } else {
      dispatch(.startedWithoutCredential(state.pairing.revoked == nil ? .notLoggedIn : .deviceRevoked))
    }
  }

  /// Faza sceny z UI. Powrót na wierzch = świeży stan: strumienie od nowa, bez zaufania staremu;
  /// tło = obecność `visible: false` od razu i zamknięte strumienie.
  public func setScenePhase(_ next: ScenePhase) {
    let previous = phase
    phase = next
    switch next {
    case .active:
      retryKeychainIfAwaiting()
      if suspendedInBackground || globalLoop == nil { resume() }
    case .inactive:
      break
    case .background:
      // Ostatni świeży obraz na dysk, zanim system odbierze wątek.
      if previous != .background { persistListCache() }
      // Obejrzane wyniki wracają na miejsca swojej rangi, gdy nikt nie patrzy.
      if previous != .background { dispatch(.list(.appBackgrounded)) }
      suspendedInBackground = true
      stopLoops()
    }
    if (previous == .background) != (next == .background) { refreshPresence() }
    if previous == .background, next != .background {
      pushReturnedToForeground()
      fileTree.requestRefresh()
      fileTree.invalidateIndexes()
    }
    syncUsagePolling()
    syncTerminals()
    liveActivityScenePhaseChanged(from: previous, to: next)
  }

  /// Zmiana sieci (np. `NWPathMonitor`) albo „łącz teraz": strumienie od nowa, odstęp od zera.
  public func reconnectNow() {
    guard phase != .background else { return }
    resume()
  }

  /// Ekran sesji: otwiera strumień transkryptu (tylko dla sesji znanej z listy).
  public func openSession(_ id: String?) {
    guard id != state.viewedSessionId else { return }
    dispatch(.viewSession(id))
    syncSessionLoop(force: true)
    refreshPresence()
  }

  /// Zaznaczenie listy po zmianie trasy: wiersz, z którego się zeszło, zostaje w zwiniętym
  /// projekcie do spokojnej chwili. Bez strumieni — sama pamięć listy.
  public func selectListRow(_ id: String?) {
    guard id != state.listSelection else { return }
    dispatch(.list(.selected(id)))
  }

  /// Człowiek sam zwinął albo rozwinął projekty drzewa: ich ostatnio otwarte wiersze przestają być trzymane.
  public func projectsToggled(_ cwds: [String]) {
    dispatch(.list(.projectsToggled(cwds)))
  }

  // MARK: - Wysyłka (trwała kolejka)
  // `send`, `retry`, `discard`, dostarczenie i odtworzenie kolejki: `RarogStore+Send`.

  // MARK: - Decyzje
  // `decidePermission`, decyzja o dialogu w panelu i „Wznów": `RarogStore+Decisions`; przerwanie
  // i „obejrzane": `RarogStore+SessionControl`.

  // MARK: - Reduktor i skutki

  /// `internal`: akcje obszarów (`RarogStore+<Obszar>`) zmieniają stan tym samym reduktorem.
  func dispatch(_ event: CoreEvent) {
    let noticesBefore = state.notices.count
    let fileTreeBefore = fileTreeProbe()
    let now = clock()
    let effects = state.apply(event, now: now, timing: timing)
    for effect in effects { perform(effect) }
    // Echo odroczone: okres bezczynności sesji z wpisem w kolejce CLI — po KAŻDYM zdarzeniu.
    for effect in state.syncQueuedIdle(now: now) { perform(effect) }
    if state.notices.count > noticesBefore { schedulePruneNotices() }
    noteInboxEvent(event)
    noteFileTreeEvent(before: fileTreeBefore)
    syncInbox()
    syncPushBadge()
    syncLiveActivity()
  }

  private func perform(_ effect: CoreEffect) {
    switch effect {
    case let .forgetOutboxEntry(id):
      chainPersistence { await $0.delete(id) }
    case let .persistOutboxEntry(entry):
      chainPersistence { try? await $0.save(entry) }
    case .clearCaches:
      clearListCache()
    case .persistListCache:
      persistListCache()
    case let .scheduleQueuedIdleCheck(sessionId, since):
      let wait = timing.queuedIdleAfter
      Task { [weak self] in
        try? await Task.sleep(for: wait)
        self?.dispatch(.outboxQueuedIdle(sessionId: sessionId, since: since))
      }
    case let .scheduleUnconfirmedCheck(id, delay, openedAt):
      Task { [weak self] in
        try? await Task.sleep(for: delay)
        self?.dispatch(.outboxUnconfirmedAfterOpening(id, openedAt: openedAt))
      }
    case let .scheduleQueuedCeilingCheck(id, queuedAt):
      scheduleQueuedCeiling(id, queuedAt: queuedAt)
    case let .scheduleRestartGrace(sessionId, settledAt):
      Task { [weak self] in
        try? await Task.sleep(for: .seconds(SessionControlTiming.restartSettleGrace))
        self?.dispatch(.session(.restartGraceEnded(sessionId: sessionId, settledAt: settledAt)))
      }
    }
  }

  /// Zapisy na dysk po kolei: dwa szybkie przejścia wpisu nie mogą się zamienić miejscami.
  func chainPersistence(_ work: @escaping @Sendable (OutboxPersistence) async -> Void) {
    let previous = persistChain
    let persistence = persistence
    persistChain = Task {
      await previous?.value
      await work(persistence)
    }
  }

  /// Czeka, aż wszystkie zlecone zapisy kolejki trafią na dysk (testy, zamknięcie apki).
  public func flushPersistence() async {
    await persistChain?.value
  }

  private func schedulePruneNotices() {
    let lifetime = timing.noticeLifetime
    Task { [weak self] in
      try? await Task.sleep(for: lifetime)
      guard let self else { return }
      self.dispatch(.pruneNotices(olderThan: self.clock().addingTimeInterval(-lifetime.timeInterval)))
    }
  }

  // MARK: - Strumienie

  private func resume() {
    guard state.auth == .loggedIn, phase != .background else { return }
    // Jedno wznowienie po tle: `reconnectNow()` w fazie `inactive` nie zostawia drugiego na `active`.
    suspendedInBackground = false
    startLoop(.global, cursor: nil)
    syncSessionLoop(force: true)
    refreshPresence()
    syncUsagePolling()
    syncTerminals()
  }

  private func stopLoops() {
    for loop in [globalLoop, sessionLoop].compactMap({ $0 }) {
      loop.task.cancel()
      dispatch(.streamStopped(loop.scope))
    }
    globalLoop = nil
    sessionLoop = nil
    stopInboxLoads()
  }

  /// Strumień oglądanej sesji: tylko dla sesji znanej z listy, przy zalogowaniu i na wierzchu.
  func syncSessionLoop(force: Bool = false) {
    let wanted = state.viewedSessionId.flatMap { state.sessions[$0] == nil ? nil : $0 }
    // Lista z pamięci podręcznej to jeszcze nie „sesja znana": transkrypt (i jego karty decyzji)
    // dopiero po świeżej liście — ramka listy idzie zaraz po `hello`.
    let canRun = state.auth == .loggedIn && phase != .background && globalLoop != nil && !state.listStale
    guard let wanted, canRun else {
      if let loop = sessionLoop {
        loop.task.cancel()
        sessionLoop = nil
        dispatch(.streamStopped(loop.scope))
      }
      return
    }
    if !force, sessionLoop?.scope == .session(id: wanted) { return }
    // Status pętli poprzedniej sesji nie przechodzi na nową: pętla startuje asynchronicznie, a do jej
    // pierwszego `connecting` baner transkryptu nowej sesji czytałby awarię starej.
    if let loop = sessionLoop, loop.scope != .session(id: wanted) {
      loop.task.cancel()
      sessionLoop = nil
      dispatch(.streamStopped(loop.scope))
    }
    let view = state.transcripts[wanted]
    // A fresh transcript asked by the voice agent of an Inbox card (`refreshTranscript`): no cursor, so a snapshot.
    let fresh = inboxRuntime.freshTranscript == wanted
    if fresh { inboxRuntime.freshTranscript = nil }
    let cursor = !fresh && (view?.snapshots ?? 0) > 0 ? view?.cursor : nil
    startLoop(.session(id: wanted), cursor: cursor)
  }

  private func startLoop(_ scope: StreamScope, cursor: String?) {
    let existing = scope == .global ? globalLoop : sessionLoop
    existing?.task.cancel()
    generation += 1
    let id = generation
    let supervisor = StreamSupervisor(
      scope: scope, transport: transport, timing: timing, render: renderer, threshold: stallThreshold,
      clock: streamClock
    ) { [weak self] signal in
      await self?.handle(signal, loop: id, scope: scope)
    }
    let task = Task.detached { await supervisor.run(cursor: cursor) }
    let loop = Loop(id: id, scope: scope, task: task)
    if scope == .global { globalLoop = loop } else { sessionLoop = loop }
  }

  private func handle(_ signal: SupervisorSignal, loop id: Int, scope: StreamScope) async {
    // Sygnał anulowanej pętli (zmiana sesji, tło) nie ma prawa zmienić stanu.
    let current = scope == .global ? globalLoop : sessionLoop
    guard current?.id == id else { return }
    switch signal {
    case .connecting:
      dispatch(.connecting(scope))
    case let .opened(resumed):
      dispatch(.streamOpened(scope, resumedWithCursor: resumed))
      if scope == .global {
        pushConnectionOpened()
        liveActivityConnectionOpened()
      }
      if scope == .global {
        reporter.armed = true
        flushReport()
      }
    case let .frame(outcome, data, cursor):
      reporter.record(ContractReporter.lines(for: outcome, data: data))
      flushReport()
      guard case let .success(decoded) = outcome else { return }
      let source: FrameSource = if case let .session(sessionId) = scope { .session(sessionId) } else { .global }
      let compatBefore = state.compat
      let staleBefore = state.listStale
      dispatch(.frame(decoded.event, source: source, cursor: cursor))
      if state.compat != compatBefore || state.listStale != staleBefore { rules.compatibilityChanged() }
      if state.compat != compatBefore { blockTerminalsIfIncompatible() }
      if scope == .global { syncSessionLoop() }
      if scope == .global, case let .hello(hello) = decoded.event {
        // Both streams, also the ones already open, take the threshold of the server's ping interval.
        stallThreshold.apply(hello)
        probeVersionAfterHello()
        // Trwały ślad nowego urządzenia: lista urządzeń po każdym `hello`, tylko z kluczem.
        readDevicesAfterHello()
      }
      // Rejestracja APNs czeka na żywy strumień i świeżą listę (`RarogStore+Push`).
      if scope == .global { attemptPushRegistration() }
    case .dropped:
      dispatch(.streamDropped(scope))
    case .unauthorized:
      handleUnauthorized()
    case .sessionGone:
      sessionLoop = nil
      dispatch(.streamStopped(scope))
    }
  }

  /// `internal`: 401 z akcji obszaru wylogowuje tą samą drogą co strumień. Przy kluczu urządzenia powód wybiera
  /// odmowa serwera (`credentialRejection`): `device-revoked` kasuje klucz i zostawia trwały ekran odpięcia,
  /// inne 401 klucz zostawia (`RarogStore+Pairing`).
  func handleUnauthorized() {
    let rejection = transport.credentialRejection
    retire(.loggedOut(logoutReason(after: rejection)), unregisterPush: true)
    deviceRejected(rejection)
  }

  /// Zamyka wszystko, co należy do bieżącego zalogowania: strumienie, obecność, żądania w drodze, terminale,
  /// klucze dyktowania, rejestrację push i Live Activity. `event` (wylogowanie albo przełączenie serwera) idzie
  /// w tym samym miejscu co dawniej `loggedOut` — po zatrzymaniu strumieni, przed odpytywaniem. Numer
  /// zalogowania rośnie, więc spóźniony wynik starego transportu nic już nie zmieni. `unregisterPush: false`
  /// przy przełączeniu: token APNs zostaje w systemie, nowy transport rejestruje go od nowa (z kluczem).
  func retire(_ event: CoreEvent, unregisterPush: Bool) {
    loginGeneration += 1
    forgetCardRequests()
    forgetInbox()
    stopLoops()
    // The next login (maybe another server) starts from the fallback until its own `hello`.
    stallThreshold.reset()
    presenceTask?.cancel()
    presenceTask = nil
    reporter.armed = false
    cancelTurnRequests()
    dispatch(event)
    syncUsagePolling()
    stopTerminals()
    forgetAnswers()
    forgetUploadReads()
    forgetSessionFileReads()
    fileTree.reset()
    forgetVoiceMints()
    forgetPush(unregister: unregisterPush)
    forgetLiveActivity()
    forgetPairingRequests()
  }

  /// Zalogowanie nowym transportem (parowanie, ponowienie klucza): nowy numer zalogowania, strumienie, push.
  func enterLoggedIn() {
    loginGeneration += 1
    dispatch(.loggedIn)
    resume()
    pushLoggedIn()
  }

  // MARK: - Login guard

  /// The current login. Every network action in `RarogStore+<Area>` takes it BEFORE the request
  /// (`let login = currentLogin`), checks ``isCurrentLogin(_:)`` after each `await` before it changes state,
  /// and hands a 401 to ``handleUnauthorized(since:)``. Reading and comparing the generation happens only here.
  var currentLogin: Int { loginGeneration }

  /// Whether the login from the moment of the gesture (`login` = ``currentLogin`` before the request) still holds.
  /// False after a logout, unpairing, re-pairing or server switch in flight: the result goes to the bin.
  func isCurrentLogin(_ login: Int) -> Bool { login == loginGeneration }

  /// A 401 from a network action logs out ONLY when the action went out in the current login (`login` =
  /// ``currentLogin`` before the request). A late refusal of a request from before a new login speaks about
  /// the old credential, so the new login stays. The shared path of every `RarogStore+<Area>`.
  func handleUnauthorized(since login: Int) {
    guard isCurrentLogin(login), state.auth == .loggedIn else { return }
    handleUnauthorized()
  }

  // MARK: - Obecność i raport

  /// Obecność: przy zmianie od razu, przy widocznej apce co `presenceInterval`, zejście w tło
  /// od razu `visible: false`. Otwarte połączenie nie jest dowodem obecności.
  private func refreshPresence() {
    presenceTask?.cancel()
    presenceTask = nil
    guard state.auth == .loggedIn else { return }
    let visible = phase != .background
    let body = PresenceBody(clientId: clientId, visible: visible, sessionId: visible ? state.viewedSessionId : nil)
    let transport = transport
    let interval = timing.presenceInterval
    // Zejście w tło: czas od systemu PRZED żądaniem, koniec po nim (także po anulowaniu) — bez tego iOS
    // usypia apkę w połowie i serwer przez ~40 s myśli, że ktoś patrzy, a pushe z tego okna przepadają.
    let work = visible ? nil : beginPresenceWork()
    presenceTask = Task {
      defer { endPresenceWork(work) }
      repeat {
        try? await transport.presence(body)
        guard visible else { return }
        try? await Task.sleep(for: interval)
      } while !Task.isCancelled
    }
  }

  /// Nieobsłużony błąd apki: JEDNA linia `błąd: <opis>` w `client.log`, poziom
  /// `error`. Opis składa wołający i nie wolno w nim treści rozmowy, terminala ani notatek
  /// Ten sam bufor co raport `kontrakt:` — przed zalogowaniem linia czeka i wychodzi
  /// po zalogowaniu; dedup po treści i wspólny sufit 50 linii na życie procesu.
  public func reportUnhandled(_ summary: String) {
    let line = summary.split(whereSeparator: \.isNewline).joined(separator: " ")
    guard !line.isEmpty else { return }
    reporter.record([ContractReporter.problemPrefix + String(line.prefix(200))])
    flushReport()
  }

  /// `internal`: ślady diagnostyczne (`RarogStore+Diagnostics`) wychodzą tym samym buforem.
  func flushReport() {
    let transport = transport
    let now = clock()
    Task {
      await reporter.flush({ body in
        (try? await transport.clientLog(body)) != nil
      }, now: now)
    }
  }
}

// MARK: - Szew dla obszarów (`RarogStore+<Obszar>.swift`)

// Rozszerzenia magazynu w innych plikach nie widzą `private`; ten blok wystawia im dokładnie to,
// czego potrzebują, bez zmiany widoczności rdzenia.
extension RarogStore {
  var areaTransport: any RarogTransporting { transport }
  /// Faza sceny z ostatniego `setScenePhase`.
  var areaPhase: ScenePhase { phase }
  /// Czas z wstrzykniętego zegara magazynu.
  var areaNow: Date { clock() }
  func areaDispatch(_ event: CoreEvent) { dispatch(event) }
  // 401 z akcji obszaru: `handleUnauthorized(since:)` z numerem zalogowania sprzed żądania. Szew nie
  // wystawia wylogowania bez warunku — spóźnione 401 wylogowałoby nowe logowanie.
}

// MARK: - Dyktowanie

extension RarogStore {
  /// Wybór i flaga z apki (produkcja: `UserDefaults` i Info.plist; testy UI: pamięć).
  public func attachDictation(_ services: DictationServices) {
    dictation = services
  }

  /// Trasa następnego stuknięcia mikrofonu: wybór z ``dictation``, stan Soniox z ostatniej sondy i odmowy mintu.
  public var dictationRoute: DictationRoute {
    DictationPolicy.route(
      choice: dictation.choices.choice, server: state.sonioxOnServer, sonioxAllowed: dictation.sonioxAllowed)
  }
}
