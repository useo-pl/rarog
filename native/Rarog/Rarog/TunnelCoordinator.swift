import Foundation
import RarogContract
import RarogCore
import RarogTransport
import Synchronization

// Koordynator tunelu: jeden na proces. Składa transport sparowanego serwera (`SwitchingTransport` nad runtime'em
// tunelu jednej tożsamości), transport parowania przez iroh i jednorazowy transport odpięcia poprzedniego klucza.
// Wszystkie runtime'y dzielą jedną dzierżawę endpointu (jeden klucz iroh urządzenia). Scena, sieć i prace w tle
// z `needsServer` trafiają tu przed magazynem, więc żądanie magazynu po powrocie na wierzch widzi już nową scenę.
//
// Reguły:
// - Każdy klient poświadczenia (HTTPS, generacje iroh, drzwi uploadu) ma ten sam klucz urządzenia, bramkę
//   i zatrzask odmowy; klienta pętli unieważnia runtime, klienta HTTPS koordynator po `retire` tożsamości.
// - Nowy transport poświadczenia kończy poprzednią tożsamość (start, odpięcie, ponowienie klucza); `release`
//   kończy ją jawnie po przełączeniu na nowy klucz.
// - Wybór drogi należy do maszyny generacji: koordynator nie zna platformy (strażnik `IrohBoundaryTests`).
// - One-off transports live until their limit (pairing and revoking a previous key: the iroh-only attempt budget
//   and the request limit), then `retire` closes their connection; a call in flight then gets `.cancelled`. Pairing
//   ends earlier: `retire` right after `pair` returns (answer, error, cancellation), because the connection is
//   one-off, and a foreign server should not hold the app's connection after a failed pairing.
// - Pairing and revoking runtimes share one limit of iroh failure reports to the lease (`IrohReportThrottle`, one
//   per `irohRetryDelay`): each builds a new runtime, and their failures must not rebind the shared endpoint.
// - Linie do `client.log` idą przez ``TunnelTrace`` (podbudżety, alarm porażki iroh, linia stanu przy wyjściu z tła).
//   A runtime's line carries the key of the server the runtime was built for (`ServerKey`), so it never reaches
//   another server; lines of the shared endpoint, the lease and the state line carry none.
// - The iroh relay registry client (`RelayAccessWiring.swift`) gets the current credential's iroh pair as the server
//   list (every new transport, a pair changed in place) and the triggers seen here: entering the active scene,
//   protected data available, a failed iroh attempt in the lease (its observer closure). Every call goes in a task:
//   the coordinator never waits for the registry (guard in `RelayAccessWiringTests`).
// - Łaska tła: iOS zamraża apkę bez zadania w tle ok. 1,5–2 s po zejściu w tło, więc `tick` terminu łaski
//   przychodził dopiero po wznowieniu. Od zejścia w tło koordynator trzyma jedno zadanie systemu bez `needsServer`
//   (adapter `UIKitBackgroundWork`), aż żaden runtime tej rundy nie ma generacji w tle albo scena wraca; wygaśnięcie
//   albo odmowa zadania zamyka generacje w łasce od razu.

/// Odbiorca prac w tle, które potrzebują serwera (adapter `UIKitBackgroundWork`).
@MainActor
protocol ServerWorkObserver: AnyObject {
  func workStarted(_ id: TunnelMachine.WorkID, expiresAt: ContinuousClock.Instant)
  func workFinished(_ id: TunnelMachine.WorkID)
  func workExpired(_ id: TunnelMachine.WorkID)
}

@MainActor
final class TunnelCoordinator: ServerWorkObserver {
  /// Górny limit życia transportu parowania przez iroh, gdy `pair` nie wraca: budżet próby i limit żądania
  /// `POST /api/pair`. The pairing runtime has only the iroh route, so its attempt gets the iroh-only budget.
  nonisolated static let pairingLifetime: Duration = TunnelMachine.irohOnlyAttemptBudget + .seconds(10)
  /// Upper limit of the one-off transport that revokes a previous key (`forgetTransport`), like `pairingLifetime`.
  static let forgetLifetime: Duration = TunnelMachine.irohOnlyAttemptBudget + .seconds(10)
  /// Jak długo wycofany runtime dostaje jeszcze zdarzenia dzierżawy (zamykanie generacji trwa do ~2 s).
  nonisolated static let retiredKept: Duration = .seconds(30)
  /// Nazwa zadania systemu w tle, które trzyma łaskę tunelu.
  static let graceTaskName = "rarog.tunnel-grace"
  /// Progi watchdoga: linia do `client.log` raz na proces.
  nonisolated static let listenerLimit = 3
  nonisolated static let endpointLimit = 1

  /// Tożsamość serwera, dla której runtime pracuje.
  nonisolated private struct Entry: Sendable {
    let deviceId: String
    let runtime: TunnelRuntime
    let https: RarogClient?
    /// Przełącznik tożsamości (`routeStamp` do linii stanu); `nil` dla parowania.
    var switching: SwitchingTransport?
  }

  private let label: String
  private let build: Int
  private let identities: IrohIdentityStore
  private let registry: TunnelRegistry
  private let transport: WatchedTunnelTransport
  private let proxyCounters: TunnelProxyCounters
  /// The coordinator's clock; the voice hold (`TunnelCoordinator+VoiceHold.swift`) reads it for its deadline.
  let timing: TunnelRuntime.Timing
  private let log: @Sendable (String) -> Void
  private let lease: EndpointLease
  /// The limit of iroh failure reports shared by every pairing and revoking runtime: each is a new runtime, so the
  /// machine's own limit starts over, and three quick failures would rebind the endpoint under the current server.
  private let oneOffReports = IrohReportThrottle()
  private let trace: TunnelTrace
  /// The iroh relay registry client; `nil` = none (tests of the tunnel alone).
  private let relayAccess: (any RelayAccessControl)?

  private var current: Entry?
  private var scene: TunnelMachine.Scene = .inactive
  private var works: [TunnelMachine.WorkID: ContinuousClock.Instant] = [:]
  /// Początek bieżącego pobytu w tle (linia stanu przy wyjściu).
  private var backgroundSince: ContinuousClock.Instant?
  /// Adapter zadań w tle systemu; bez niego koordynator nie trzyma czasu systemu na łaskę.
  private var backgroundWork: UIKitBackgroundWork?
  /// Zadanie systemu bez `needsServer` bieżącej rundy łaski.
  private var graceToken: BackgroundWorkToken?
  /// Runda łaski: każde zejście w tło i każdy powrót ją zmienia, więc spóźniona odpowiedź runtime'u nie kończy
  /// zadania następnej rundy.
  private var graceRound: UInt64 = 0
  /// Runtime'y rundy, które mogą jeszcze mieć generację w tle.
  private var gracePending: Set<ObjectIdentifier> = []

  /// - Parameters:
  ///   - transport: transport iroh (`IrohTunnelTransport` w apce, atrapa w testach).
  ///   - identities: tożsamość iroh urządzenia (wpis Keychaina).
  ///   - proxyCounters: liczniki nasłuchów i par wszystkich proxy (testy: liczniki atrapy transportu).
  ///   - relayAccess: the iroh relay registry client of the process (`RelayAccessWiring.live` in the app).
  ///   - log: linia do `client.log` (bez sekretów) and the server it concerns: a runtime's lines carry the key of the
  ///     credential (or pairing target) the runtime was built for, the shared endpoint's lines none.
  init(
    label: String, build: Int, transport: any TunnelTransport, identities: IrohIdentityStore,
    timing: TunnelRuntime.Timing = .system, proxyCounters: TunnelProxyCounters = TunnelProxyCounters(),
    relayAccess: (any RelayAccessControl)? = nil, log: @escaping @Sendable (String, ServerKey?) -> Void
  ) {
    self.relayAccess = relayAccess
    self.label = label
    self.build = build
    self.identities = identities
    self.timing = timing
    self.proxyCounters = proxyCounters
    let trace = TunnelTrace(sink: log, now: timing.now)
    self.trace = trace
    // The shared endpoint, its lease and the watchdog serve every runtime: their lines have no single server.
    let log: @Sendable (String) -> Void = { line in trace.send(line) }
    self.log = log
    let registry = TunnelRegistry()
    let watched = WatchedTunnelTransport(base: transport, listeners: proxyCounters, log: log)
    self.registry = registry
    self.transport = watched
    lease = EndpointLease(
      transport: watched,
      identity: { [identities, registry, log] in
        switch await identities.identity() {
        case let .ready(identity):
          guard let relay = registry.homeRelay else {
            log("tunnel: no home relay for the iroh endpoint")
            return nil
          }
          return LeaseIdentity(secretKey: identity.secretKey, homeRelay: relay)
        case let .unavailable(reason):
          log("tunnel: iroh identity unavailable (\(reason))")
          return nil
        }
      },
      clock: ContinuousClock(),
      closeUsers: { [registry] users in
        for runtime in registry.runtimes { await runtime.closeUsers(users) }
      },
      onReadiness: { [registry] readiness in registry.readinessChanged(readiness) },
      onIrohFailure: { [relayAccess] in
        guard let relayAccess else { return }
        Task { await relayAccess.trigger(.tunnelFailed) }
      },
      log: log)
  }

  // MARK: - Fabryki złącza (`ServerConnector`)

  /// Transport punktu końcowego magazynu. Kończy poprzednią tożsamość.
  func transport(_ endpoint: ServerEndpoint, _ rules: MutationRules) -> any RarogTransporting {
    finishCurrent()
    relayServers(endpoint.credential)
    guard case let .device(credential) = endpoint else {
      return RarogClient(config: RarogConfig(baseURL: Self.unpairedURL, clientLabel: label, build: build), policy: rules)
    }
    let (entry, switching) = makeEntry(credential, rules)
    current = entry
    return switching
  }

  /// Transport parowania: HTTPS jak bez tunelu, iroh (także przy obu trasach) przez jednorazowy runtime.
  func pairing(_ target: PairingTarget) -> any RarogTransporting {
    let iroh: ServerIrohConfig
    switch target {
    case let .https(url):
      return RarogClient(config: RarogConfig(baseURL: url, clientLabel: label, build: build))
    case let .iroh(config), let .both(_, config):
      iroh = config
    }
    let config = loopConfig(origin: IrohWire.origin)
    let runtime = makeRuntime(
      target: Self.target(iroh), https: nil, server: ServerKey(serverURL: nil, iroh: iroh),
      failureReports: oneOffReports
    ) { url in
      RarogClient(config: config(url))
    }
    let entry = Entry(deviceId: "", runtime: runtime, https: nil)
    let once = RetireOnce()
    let (registry, timing) = (registry, timing)
    Self.retire(entry, after: Self.pairingLifetime, once: once, registry: registry, timing: timing)
    return SwitchingTransport(
      runtime: runtime, rejections: CredentialRejectionLatch(),
      afterPair: { Self.retire(entry, after: .zero, once: once, registry: registry, timing: timing) })
  }

  /// One-off transport that revokes the previous key on its server, alive ``forgetLifetime``.
  func forgetTransport(_ endpoint: ServerEndpoint, _ rules: MutationRules) -> any RarogTransporting {
    guard case let .device(credential) = endpoint else { return transportWithoutServer(rules) }
    let (entry, switching) = makeEntry(credential, rules, failureReports: oneOffReports)
    retire(entry, after: Self.forgetLifetime)
    return switching
  }

  /// Koniec tożsamości po przełączeniu na nowy klucz.
  func release(_ endpoint: ServerEndpoint) {
    guard let current, current.deviceId == endpoint.credential?.deviceId else { return }
    finishCurrent()
  }

  /// Nowa para iroh poświadczenia w miejscu: obowiązuje od następnej generacji, bez nowego transportu.
  func credentialChanged(_ endpoint: ServerEndpoint) {
    guard let credential = endpoint.credential, let current, current.deviceId == credential.deviceId else { return }
    let target = credential.iroh.map(Self.target)
    if let target { registry.homeRelay = target.relay }
    let runtime = current.runtime
    Task.immediate { await runtime.credentialChanged(target: target) }
    relayServers(credential)
  }

  /// Adapter zadań w tle: koordynator trzyma nim czas systemu na łaskę tunelu. `RarogApp` podpina go zaraz po
  /// konstrukcji adaptera, który zna koordynatora jako odbiorcę prac z `needsServer`.
  func attach(_ backgroundWork: UIKitBackgroundWork) {
    self.backgroundWork = backgroundWork
  }

  // MARK: - Scena, sieć, prace w tle

  func scene(_ phase: ScenePhase) {
    let next: TunnelMachine.Scene =
      switch phase {
      case .active: .active
      case .inactive: .inactive
      case .background: .background
      }
    let now = timing.now()
    let entering = next == .background && scene != .background
    if entering {
      backgroundSince = now
    } else if next != .background, scene == .background, let since = backgroundSince {
      backgroundSince = nil
      reportState(away: now - since, at: now)
    }
    if next == .active, scene != .active { relayTrigger(.foreground) }
    scene = next
    let runtimes = registry.runtimes
    if next != .background { releaseGrace() }
    let round = entering ? startGraceRound(runtimes) : nil
    for runtime in runtimes {
      Task.immediate { [weak self] in
        await runtime.scene(next)
        guard let round else { return }
        await runtime.backgroundTimeReleased()
        self?.graceReleased(by: runtime, round: round)
      }
    }
    // Zadanie po zdarzeniach sceny: wygaśnięcie albo odmowa dochodzi do runtime'ów po `scene(background)`.
    if let round { holdGrace(round) }
    transport.watch()
  }

  // MARK: - Łaska tła

  private func startGraceRound(_ runtimes: [TunnelRuntime]) -> UInt64 {
    graceRound &+= 1
    gracePending = Set(runtimes.map(ObjectIdentifier.init))
    return graceRound
  }

  /// Jedno zadanie systemu bez `needsServer` na wszystkie runtime'y rundy. Odmowa systemu znaczy, że czasu w tle już
  /// nie ma: jak wygaśnięcie.
  private func holdGrace(_ round: UInt64) {
    guard let backgroundWork, !gracePending.isEmpty, graceToken == nil else { return }
    graceToken = backgroundWork.begin(Self.graceTaskName, needsServer: false) { [weak self] in
      self?.graceExpired(round)
    }
    if graceToken == nil { graceExpired(round) }
  }

  /// Runtime nie ma już generacji w tle; gdy żaden z rundy jej nie ma, zadanie systemu się kończy.
  private func graceReleased(by runtime: TunnelRuntime, round: UInt64) {
    guard round == graceRound, gracePending.remove(ObjectIdentifier(runtime)) != nil, gracePending.isEmpty else {
      return
    }
    endGrace()
  }

  /// Scena poza tłem: zadanie systemu niepotrzebne, odpowiedzi runtime'ów z tej rundy niczego już nie zmienią.
  private func releaseGrace() {
    graceRound &+= 1
    gracePending = []
    endGrace()
  }

  private func endGrace() {
    guard let token = graceToken else { return }
    graceToken = nil
    backgroundWork?.end(token)
  }

  /// System zabrał czas w tle (adapter zamknął już zadanie): generacje w łasce zamykają się od razu.
  private func graceExpired(_ round: UInt64) {
    guard round == graceRound else { return }
    graceToken = nil
    for runtime in registry.runtimes { Task.immediate { await runtime.backgroundTimeExpired() } }
  }

  /// Linia stanu przy wyjściu z tła (``TunnelTrace/state(_:at:)``): liczby czytane przed zdarzeniem sceny.
  private func reportState(away: Duration, at now: ContinuousClock.Instant) {
    let runtimes = registry.runtimes
    var snapshot = TunnelSnapshot(
      route: current?.switching?.routeStamp ?? 0, runtimes: runtimes.count, endpoints: transport.endpointsAlive,
      listeners: proxyCounters.listeners, pairs: proxyCounters.pairs, works: works.count, away: away)
    let trace = trace
    Task.immediate {
      for runtime in runtimes {
        let counters = await runtime.counters
        snapshot.connections += counters.connections
        snapshot.doors += counters.doors
      }
      trace.state(snapshot, at: now)
    }
  }

  func networkChanged() {
    for runtime in registry.runtimes { Task.immediate { await runtime.networkChanged() } }
    transport.watch()
  }

  func workStarted(_ id: TunnelMachine.WorkID, expiresAt: ContinuousClock.Instant) {
    works[id] = expiresAt
    for runtime in registry.runtimes { Task.immediate { await runtime.backgroundWorkStarted(id, expiresAt: expiresAt) } }
  }

  func workFinished(_ id: TunnelMachine.WorkID) {
    guard works.removeValue(forKey: id) != nil else { return }
    for runtime in registry.runtimes { Task.immediate { await runtime.backgroundWorkFinished(id) } }
  }

  func workExpired(_ id: TunnelMachine.WorkID) {
    guard works.removeValue(forKey: id) != nil else { return }
    for runtime in registry.runtimes { Task.immediate { await runtime.backgroundWorkExpired(id) } }
  }

  /// Keychain czytelny po pierwszym odblokowaniu: dzierżawa niedostępna z powodu tożsamości wiąże przy następnym
  /// popycie, a maszyny dostają nową gotowość.
  func protectedDataBecameAvailable() {
    let lease = lease
    Task.immediate {
      guard await lease.readiness == .unavailable else { return }
      await lease.rebind(.keyChanged)
    }
    relayTrigger(.identityAvailable)
  }

  // MARK: - Relay registry client (in a task, without waiting)

  /// Server list: the iroh pair of `credential`, or an empty list (no credential, HTTPS only).
  private func relayServers(_ credential: DeviceCredential?) {
    guard let relayAccess else { return }
    let servers = credential?.iroh.map { [Self.target($0)] } ?? []
    Task.immediate { await relayAccess.setServers(servers) }
  }

  private func relayTrigger(_ reason: RelayAccessTrigger) {
    guard let relayAccess else { return }
    Task.immediate { await relayAccess.trigger(reason) }
  }

  // MARK: - Do testów

  var liveRuntimes: Int { registry.runtimes.count }
  var liveWorks: [TunnelMachine.WorkID] { Array(works.keys) }
  var hasCurrent: Bool { current != nil }
  var currentRuntime: TunnelRuntime? { current?.runtime }
  /// Runtime'y w rejestrze dzierżawy, w kolejności powstania (także wycofane, do ``retiredKept``).
  var runtimes: [TunnelRuntime] { registry.runtimes }

  // MARK: - Składanie

  static let unpairedURL = URL(string: "https://unpaired.invalid")!

  static func target(_ iroh: ServerIrohConfig) -> TunnelTarget {
    TunnelTarget(endpointId: iroh.endpointId, relay: iroh.relay)
  }

  private func transportWithoutServer(_ rules: MutationRules) -> RarogClient {
    RarogClient(config: RarogConfig(baseURL: Self.unpairedURL, clientLabel: label, build: build), policy: rules)
  }

  /// Konfiguracja klienta pętli: adres portu proxy, `Origin` iroh.
  private func loopConfig(origin: String) -> @Sendable (URL) -> RarogConfig {
    let label = label
    let build = build
    return { url in RarogConfig(baseURL: url, origin: origin, clientLabel: label, build: build) }
  }

  private func makeEntry(
    _ credential: DeviceCredential, _ rules: MutationRules, failureReports: IrohReportThrottle? = nil
  ) -> (Entry, SwitchingTransport) {
    let latch = CredentialRejectionLatch()
    let https = credential.serverURL.map { url in
      RarogClient(
        config: RarogConfig(baseURL: url, clientLabel: label, build: build), policy: rules, device: credential,
        rejections: latch)
    }
    let config = loopConfig(origin: IrohWire.origin)
    let runtime = makeRuntime(
      target: credential.iroh.map(Self.target), https: https, server: ServerKey(credential),
      failureReports: failureReports
    ) { url in
      RarogClient(config: config(url), policy: rules, device: credential, rejections: latch)
    }
    let switching = SwitchingTransport(runtime: runtime, rejections: latch)
    return (Entry(deviceId: credential.deviceId, runtime: runtime, https: https, switching: switching), switching)
  }

  /// Runtime nowej tożsamości: w rejestrze dzierżawy, z bieżącą sceną, pracami w tle i gotowością dzierżawy od
  /// konstrukcji. Budowa i rejestracja idą synchronicznie, więc każde późniejsze zdarzenie sceny, pracy i dzierżawy
  /// trafia do niego przez rejestr, po stanie początkowym.
  ///
  /// Every line of the runtime carries `server`, the key it was built for, taken here and not when the line arrives: a
  /// retired runtime still writes after the store moved to another server, and those lines must not reach it. A key
  /// changed in place (``credentialChanged(_:)``) does not reach the runtime's lines, so they are lost until the next
  /// transport rather than sent to the new key.
  private func makeRuntime(
    target: TunnelTarget?, https: RarogClient?, server: ServerKey?, failureReports: IrohReportThrottle? = nil,
    makeClient: @escaping TunnelRuntime.ClientFactory
  ) -> TunnelRuntime {
    if let target, current == nil || registry.homeRelay == nil { registry.homeRelay = target.relay }
    let (lease, timing, proxyCounters, trace, scene, works) = (lease, timing, proxyCounters, trace, scene, works)
    return registry.add { readiness in
      TunnelRuntime(
        target: target, httpsClient: https, lease: lease, makeClient: makeClient, timing: timing,
        proxyCounters: proxyCounters, scene: scene, works: works, readiness: readiness, failureReports: failureReports,
        log: { line in trace.send(line, server: server) })
    }
  }

  private func finishCurrent() {
    guard let entry = current else { return }
    current = nil
    retire(entry, after: .zero)
  }

  private func retire(_ entry: Entry, after delay: Duration) {
    Self.retire(entry, after: delay, once: nil, registry: registry, timing: timing)
  }

  /// `retire` tożsamości po `delay`, potem unieważnienie klienta HTTPS; runtime zostaje w rejestrze dzierżawy
  /// jeszcze przez ``retiredKept``, bo jego generacja może się dalej zamykać. Z `once` wycofuje tylko pierwsze
  /// z wywołań (parowanie: po powrocie `pair` albo po limicie).
  private nonisolated static func retire(
    _ entry: Entry, after delay: Duration, once: RetireOnce?, registry: TunnelRegistry, timing: TunnelRuntime.Timing
  ) {
    Task.immediate {
      if delay > .zero { try? await timing.sleep(delay) }
      if let once, !once.claim() { return }
      await entry.runtime.retire()
      entry.https?.invalidate()
      try? await timing.sleep(retiredKept)
      registry.remove(entry.runtime)
    }
  }
}

/// Jedno wycofanie z kilku wyzwalaczy.
nonisolated final class RetireOnce: Sendable {
  private let done = Mutex(false)

  /// `true` tylko przy pierwszym wywołaniu.
  func claim() -> Bool {
    done.withLock { done in
      defer { done = true }
      return !done
    }
  }
}

/// Linie tunelu do `client.log`: koordynator powstaje przed magazynem, więc linie sprzed podpięcia czekają w buforze.
/// Each line keeps the server it concerns (`nil` = no single server) from its producer to the sink, also through the
/// buffer: the sink hops to the main actor later, when the store may serve another server.
nonisolated final class TunnelLogRelay: Sendable {
  typealias Sink = @Sendable (String, ServerKey?) -> Void
  static let bufferLimit = 32
  private let state = Mutex<(sink: Sink?, buffer: [(line: String, server: ServerKey?)])>((nil, []))

  func send(_ line: String, server: ServerKey?) {
    let sink = state.withLock { state -> Sink? in
      if state.sink == nil, state.buffer.count < Self.bufferLimit { state.buffer.append((line, server)) }
      return state.sink
    }
    sink?(line, server)
  }

  func attach(_ sink: @escaping Sink) {
    let buffered = state.withLock { state -> [(line: String, server: ServerKey?)] in
      state.sink = sink
      defer { state.buffer = [] }
      return state.buffer
    }
    for entry in buffered { sink(entry.line, entry.server) }
  }
}

/// Runtime'y na wspólnej dzierżawie, ostatnia gotowość dzierżawy i relay domowy endpointu; czytane z zamknięć
/// dzierżawy poza głównym aktorem. Gotowość i lista runtime'ów są pod jednym zamkiem: zmiana gotowości trafia do
/// nowego runtime'u albo przy konstrukcji, albo przez `leaseChanged`.
nonisolated final class TunnelRegistry: Sendable {
  private struct State {
    var runtimes: [ObjectIdentifier: TunnelRuntime] = [:]
    var order: [ObjectIdentifier] = []
    var homeRelay: URL?
    /// Początek jak w `EndpointLease`: endpoint bez wiązania jest gotowy.
    var readiness: LeaseReadiness = .ready
  }

  private let state = Mutex(State())

  var runtimes: [TunnelRuntime] {
    state.withLock { state in state.order.compactMap { state.runtimes[$0] } }
  }

  var homeRelay: URL? {
    get { state.withLock { $0.homeRelay } }
    set { state.withLock { $0.homeRelay = newValue } }
  }

  var readiness: LeaseReadiness { state.withLock { $0.readiness } }

  /// Buduje runtime z ostatnią gotowością dzierżawy i rejestruje go pod tym samym zamkiem.
  func add(_ make: (LeaseReadiness) -> TunnelRuntime) -> TunnelRuntime {
    state.withLock { state in
      let runtime = make(state.readiness)
      let id = ObjectIdentifier(runtime)
      state.runtimes[id] = runtime
      state.order.append(id)
      return runtime
    }
  }

  /// `onReadiness` dzierżawy: nowa gotowość dla przyszłych runtime'ów i `leaseChanged` dla zarejestrowanych.
  func readinessChanged(_ readiness: LeaseReadiness) {
    state.withLock { state in
      state.readiness = readiness
      for id in state.order { state.runtimes[id]?.leaseChanged(readiness) }
    }
  }

  func remove(_ runtime: TunnelRuntime) {
    let id = ObjectIdentifier(runtime)
    state.withLock { state in
      state.runtimes[id] = nil
      state.order.removeAll { $0 == id }
    }
  }
}

/// Transport iroh z licznikiem żywych endpointów i watchdogiem: nasłuchów > 3 albo endpointów > 1 to jedna linia
/// do `client.log` na proces (stan ustalony to najwyżej jeden endpoint).
nonisolated final class WatchedTunnelTransport: TunnelTransport {
  private let base: any TunnelTransport
  private let listeners: TunnelProxyCounters
  private let log: @Sendable (String) -> Void
  private let state = Mutex((endpoints: 0, logged: false))

  init(base: any TunnelTransport, listeners: TunnelProxyCounters, log: @escaping @Sendable (String) -> Void) {
    self.base = base
    self.listeners = listeners
    self.log = log
  }

  var endpointsAlive: Int { state.withLock { $0.endpoints } }

  func bind(secretKey: Data, homeRelay: URL) async throws -> any TunnelEndpoint {
    let endpoint = try await base.bind(secretKey: secretKey, homeRelay: homeRelay)
    state.withLock { $0.endpoints += 1 }
    watch()
    return WatchedEndpoint(base: endpoint) { [self] in endpointClosed() }
  }

  private func endpointClosed() {
    state.withLock { $0.endpoints -= 1 }
  }

  /// Sprawdzenie progów (po `bind` i przy zdarzeniach sceny i sieci).
  func watch() {
    let listeners = listeners.listeners
    let line = state.withLock { state -> String? in
      guard !state.logged, listeners > TunnelCoordinator.listenerLimit || state.endpoints > TunnelCoordinator.endpointLimit
      else { return nil }
      state.logged = true
      return "tunnel watchdog: listeners \(listeners), endpoints \(state.endpoints)"
    }
    if let line { log(line) }
  }
}

nonisolated private final class WatchedEndpoint: TunnelEndpoint {
  private let base: any TunnelEndpoint
  private let onClose: @Sendable () -> Void
  private let closed = Mutex(false)

  init(base: any TunnelEndpoint, onClose: @escaping @Sendable () -> Void) {
    self.base = base
    self.onClose = onClose
  }

  var endpointId: String { base.endpointId }

  func connect(to target: TunnelTarget, alpn: Data) async throws -> any TunnelConnection {
    try await base.connect(to: target, alpn: alpn)
  }

  func ensureRelay(_ relay: URL) async throws {
    try await base.ensureRelay(relay)
  }

  func close() async {
    await base.close()
    let first = closed.withLock { done -> Bool in
      defer { done = true }
      return !done
    }
    if first { onClose() }
  }
}
