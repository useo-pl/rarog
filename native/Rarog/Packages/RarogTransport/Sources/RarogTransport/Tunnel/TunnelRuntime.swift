import Foundation
import RarogContract
import Synchronization

// Runtime tunelu: aktor, który wykonuje polecenia maszyny generacji (`TunnelMachine`) na dzierżawie endpointu
// (`EndpointLease`) i proxy pętli zwrotnej (`TunnelProxy`). Buduje klientów na porcie pętli fabryką właściciela
// (generacja iroh i drzwi uploadu), unieważnia ich po zamknięciu biletu i oddaje `TunnelGeneration` z biletem.
// Każdy wynik pracy w tle wraca do maszyny z numerem generacji, a po każdym `await` runtime sprawdza, czy zasób
// wciąż ma właściciela: spóźniony zasób (połączenie, nasłuch, użytkownik lease) zamyka ten, kto go dostał.
//
// Rejestr stałych tunelu (IrohLib 1.2.0 w pakiecie `RarogIroh`; wartości mieszkają przy swoich typach):
//
// 1. Budżet próby 15 s (`bind` + `connect` + strumień + sonda): `TunnelMachine.attemptBudget`; an iroh-only
//    credential in the foreground 30 s: `TunnelMachine.irohOnlyAttemptBudget`.
// 2. Życie generacji w tle bez pracy 8 s: `TunnelMachine.backgroundGrace`.
// 3. Przerwa po nieudanej próbie 1 s: `TunnelMachine.cooldown`; pamięć porażki iroh 2 min:
//    `TunnelMachine.irohRetryDelay`, ended early by a failed HTTPS attempt (an HTTPS generation with an iroh route
//    passes the same probe first). An iroh-only credential retries after 1, 2, 4, 8 s, then every 15 s
//    (`TunnelMachine.irohOnlyRetryDelays`, `irohOnlyRetryCeiling`). An iroh failure goes to the lease at most once
//    per `irohRetryDelay`; one-off pairing and revoke runtimes share that limit (`IrohReportThrottle`).
// 4. Termin przerwania par proxy 2 s: `TunnelProxy.abortDeadline`; ten sam termin opróżnienia biletu przed
//    `invalidate()` klienta: `TunnelRuntime.drainDeadline`.
// 5. Endpoint zepsuty po 3 kolejnych porażkach iroh: `EndpointLease.brokenAfterFailures`; sufit 2 niezakończonych
//    operacji natywnych: `EndpointLease.nativeOperationCeiling`.
// 6. Log wiszącego `bind` po 15 s, wiszącego `close` po 8 s, potem co 60 s: `EndpointLease.bindHangThreshold`,
//    `closeHangThreshold`, `hangLogInterval`.
// 7. Kod błędu zamknięcia apki: 0 = koniec generacji albo drzwi, 1 = anulowany upload (`UploadDoor.close`).
// 8. Polityka endpointu po powrocie z tła: `TunnelMachine.returnPolicy` (`rebindOnReturn`).
//
// Zamknięcie generacji i drzwi: bilet w zamykaniu (nowe żądania czekają na następną generację) → przerwanie par
// proxy (2 s) → `close` połączenia po stronie apki → opróżnienie biletu albo termin 2 s → `invalidate()` klienta
// pętli → zwolnienie użytkownika lease → `closed(gen)` do maszyny. Proxy połączenia nie zamyka: po `abortTimedOut`
// robi to runtime. Klient HTTPS należy do poświadczenia: runtime go pożycza i nigdy nie unieważnia.
// Closing also cancels the generation's probe still in flight, on both routes: the HTTPS client stays valid, so only
// the cancelled task ends its request before the HTTP limit.

/// Wynik czekania na generację.
public enum TunnelGenerationOutcome: Sendable {
  case ready(TunnelGeneration)
  /// Generacji teraz nie będzie (tło bez pracy, nieudana próba, przerwa): żądanie dostaje `.offline`.
  case offline
  /// Zadanie wołającego anulowane albo runtime wycofany.
  case cancelled
}

/// Aktor tunelu jednej tożsamości serwera: maszyna generacji, jej zasoby i drzwi uploadu.
public actor TunnelRuntime {
  /// Termin opróżnienia biletu przed `invalidate()` klienta pętli.
  public static let drainDeadline: Duration = .seconds(2)

  /// Czas runtime: chwila dla maszyny i sen terminów. Testy podają zegar sztuczny.
  public struct Timing: Sendable {
    public var now: @Sendable () -> ContinuousClock.Instant
    public var sleep: @Sendable (Duration) async throws -> Void

    public init(now: @escaping @Sendable () -> ContinuousClock.Instant,
                sleep: @escaping @Sendable (Duration) async throws -> Void) {
      self.now = now
      self.sleep = sleep
    }

    public static let system = Timing(now: { ContinuousClock.now }, sleep: { try await Task.sleep(for: $0) })
  }

  /// Liczniki do kryteriów stanu ustalonego. Endpointy i `bind` liczy dzierżawa (i atrapa transportu).
  public struct Counters: Sendable, Equatable {
    /// Połączenia tunelu, które runtime dostał i jeszcze nie zamknął.
    public var connections = 0
    /// Nasłuchy i pary proxy (z ``TunnelProxyCounters``).
    public var listeners = 0
    public var pairs = 0
    /// Klienci pętli zbudowani fabryką i jeszcze nieunieważnieni.
    public var clients = 0
    /// Otwarte albo otwierane drzwi uploadu.
    public var doors = 0
    /// Zadania runtime (otwieranie, sonda, zamykanie, obserwatory połączeń i proxy, zegar).
    public var tasks = 0
  }

  /// Fabryka klienta pętli: ten sam klucz urządzenia, bramka i zatrzask odmowy, nowa sesja URL pod `baseURL`.
  public typealias ClientFactory = @Sendable (_ baseURL: URL) -> RarogClient

  private enum PipeKey: Hashable {
    case generation(UInt64)
    case door(UInt64)
  }

  /// Zasoby jednej generacji albo jednych drzwi. Zasób trafia tu tylko w fazie `opening`; po przejściu w `closing`
  /// zamyka go ten, kto go dostał.
  private struct Pipe {
    enum Phase { case opening, open, closing }
    var phase: Phase = .opening
    let choice: TransportChoice
    let ticket = GenerationTicket()
    var user: LeaseUser?
    var connection: (any TunnelConnection)?
    var proxy: TunnelProxy?
    var client: RarogClient?
    var ownsClient = false
    var task: Task<Void, Never>?
    /// The probe `GET /api/version` of a generation; closing cancels it like the opening task.
    var probe: Task<Void, Never>?
    /// Zadanie zamykania (praca runtime'u): kolejne zamknięcia i `shutdown()` czekają na nie.
    var teardown: Task<Void, Never>?
    var doorWaiter: CheckedContinuation<UploadDoor, any Error>?
    var doorTimer: Task<Void, Never>?
  }

  private enum TaskKind { case work, watcher }

  private let lease: EndpointLease
  private let httpsClient: RarogClient?
  private var target: TunnelTarget?
  private let makeClient: ClientFactory
  private let timing: Timing
  private let proxyCounters: TunnelProxyCounters
  private let failureReports: IrohReportThrottle?
  private let log: @Sendable (String) -> Void

  private var machine: TunnelMachine
  private var pipes: [PipeKey: Pipe] = [:]
  private var waiters: [TunnelMachine.WaiterID: CheckedContinuation<TunnelGenerationOutcome, Never>] = [:]
  /// Czekający na koniec generacji w tle (``backgroundTimeReleased()``).
  private var backgroundTimeWaiters: [CheckedContinuation<Void, Never>] = []
  private var nextWaiter: UInt64 = 0
  private var nextDoor: UInt64 = 0
  private var tasks: [Int: (kind: TaskKind, task: Task<Void, Never>)] = [:]
  private var nextTask = 0
  private var deadlines: [ContinuousClock.Instant] = []
  private var timer: (at: ContinuousClock.Instant, task: Task<Void, Never>)?
  private var leaseChain: Task<Void, Never>?
  private var connectionsHeld = 0
  private var clientsAlive = 0
  private var shutDown = false
  private nonisolated let leaseSequence = Mutex<UInt64>(0)
  private var leaseApplied: UInt64 = 0

  /// - Parameters:
  ///   - target: serwer iroh poświadczenia; `nil` = poświadczenie bez trasy iroh.
  ///   - httpsClient: klient poświadczenia (HTTPS); `nil` = poświadczenie tylko-iroh.
  ///   - lease: dzierżawa endpointu, wspólna dla runtime'ów kolejnych tożsamości. Jej `onReadiness` woła
  ///     ``leaseChanged(_:)``, a `closeUsers` ``closeUsers(_:)`` każdego runtime'u.
  ///   - makeClient: fabryka klienta pętli (generacja iroh i drzwi uploadu); runtime jest jego właścicielem.
  ///   - proxyCounters: liczniki nasłuchów i par wszystkich proxy runtime'u.
  ///   - scene, works, readiness: stan właściciela w chwili konstrukcji (scena, prace w tle z `needsServer`,
  ///     ostatnia gotowość dzierżawy); maszyna ma go przed pierwszym zdarzeniem, a zmiany przychodzą zdarzeniami.
  ///   - failureReports: a limit of iroh failure reports shared with other short-lived runtimes (pairing); `nil` =
  ///     only the machine's own limit.
  public init(target: TunnelTarget?,
              httpsClient: RarogClient?,
              lease: EndpointLease,
              makeClient: @escaping ClientFactory,
              timing: Timing = .system,
              proxyCounters: TunnelProxyCounters = TunnelProxyCounters(),
              policy: TunnelMachine.ReturnPolicy = TunnelMachine.returnPolicy,
              scene: TunnelMachine.Scene = .inactive,
              works: [TunnelMachine.WorkID: ContinuousClock.Instant] = [:],
              readiness: LeaseReadiness = .ready,
              failureReports: IrohReportThrottle? = nil,
              log: @escaping @Sendable (String) -> Void = { _ in }) {
    self.target = target
    self.httpsClient = httpsClient
    self.lease = lease
    self.makeClient = makeClient
    self.timing = timing
    self.proxyCounters = proxyCounters
    self.failureReports = failureReports
    self.log = log
    machine = TunnelMachine(
      routes: .init(hasHTTPS: httpsClient != nil, hasIroh: target != nil), lease: readiness, scene: scene,
      works: works, policy: policy)
    // Praca w tle od startu: próba jak po `backgroundWorkStarted` w `idle`, jeśli praca dalej trwa.
    if scene == .background, !works.isEmpty {
      Task { await self.startInitialWork() }
    }
  }

  // MARK: - API

  /// Generacja dla jednego żądania (bramka gotowości). Anulowanie zadania wołającego zdejmuje tylko jego
  /// czekającego i daje `.cancelled`.
  public func generation() async -> TunnelGenerationOutcome {
    nextWaiter += 1
    let id = TunnelMachine.WaiterID(nextWaiter)
    return await withTaskCancellationHandler {
      await withCheckedContinuation { (continuation: CheckedContinuation<TunnelGenerationOutcome, Never>) in
        waiters[id] = continuation
        event(.demand(id))
      }
    } onCancel: {
      Task { await self.cancelWaiter(id) }
    }
  }

  public func scene(_ scene: TunnelMachine.Scene) {
    event(.scene(scene))
  }

  public func networkChanged() {
    event(.networkChanged)
  }

  public func backgroundWorkStarted(_ id: TunnelMachine.WorkID, expiresAt: ContinuousClock.Instant) {
    event(.backgroundWorkStarted(id, expiresAt: expiresAt))
  }

  public func backgroundWorkFinished(_ id: TunnelMachine.WorkID) {
    event(.backgroundWorkFinished(id))
  }

  public func backgroundWorkExpired(_ id: TunnelMachine.WorkID) {
    event(.backgroundWorkExpired(id))
  }

  /// Wraca, gdy w tle nie ma już generacji (zamknięta razem z zasobami, scena inna niż tło): do tej chwili koordynator
  /// apki trzyma zadanie systemu w tle. Bez generacji w tle wraca od razu.
  public func backgroundTimeReleased() async {
    guard !shutDown, holdsBackgroundTime else { return }
    await withCheckedContinuation { backgroundTimeWaiters.append($0) }
  }

  /// System zabrał apce czas w tle: generacja w łasce zamyka się od razu.
  public func backgroundTimeExpired() {
    event(.backgroundTimeExpired)
  }

  /// Nowa para iroh poświadczenia w miejscu (albo jej usunięcie); obowiązuje od następnej generacji.
  public func credentialChanged(target: TunnelTarget?) {
    self.target = target
    event(.credentialChanged(.init(hasHTTPS: httpsClient != nil, hasIroh: target != nil)))
  }

  /// Koniec tożsamości: czekający dostają `.cancelled`, generacja i drzwi się zamykają, nowa generacja już nie
  /// powstanie. Endpointu nie zamyka (dzierżawa liczy użytkowników).
  public func retire() {
    event(.retire)
    closeDoors()
  }

  /// Gotowość dzierżawy z jej `onReadiness`. Wołane synchronicznie w kolejności zmian; do maszyny dochodzi
  /// najnowsza wartość, starsza, która dotrze później, jest pomijana.
  public nonisolated func leaseChanged(_ readiness: LeaseReadiness) {
    let sequence = leaseSequence.withLock { value -> UInt64 in
      value += 1
      return value
    }
    Task { await self.applyLease(readiness, sequence: sequence) }
  }

  /// Dzierżawa zamyka endpoint (`rebind`): najpierw połączenia jego użytkowników. Runtime zamyka połączenia
  /// swoich użytkowników, a maszyna dostaje `connectionLost` z obserwatora połączenia.
  public func closeUsers(_ users: [LeaseUser]) {
    let set = Set(users)
    for (key, pipe) in pipes {
      guard let user = pipe.user, set.contains(user), let connection = pipe.connection else { continue }
      log("tunnel: closing \(describe(key)) before endpoint rebind")
      connection.close(code: 0, reason: "endpoint rebind")
    }
  }

  /// Drzwi uploadu: własne połączenie iroh, nasłuch i klient pętli na jedną wysyłkę z załącznikiem. Anulowanie
  /// zadania wołającego albo budżet kończą czekanie, a spóźnione zasoby zamyka runtime.
  public func openUploadDoor(budget: Duration) async throws -> UploadDoor {
    guard !shutDown, machine.state != .retired else { throw TunnelFailure.unavailable("tunnel runtime retired") }
    guard target != nil else { throw TunnelFailure.unavailable("no iroh route") }
    nextDoor += 1
    let id = nextDoor
    let key = PipeKey.door(id)
    pipes[key] = Pipe(choice: .iroh)
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<UploadDoor, any Error>) in
        pipes[key]?.doorWaiter = continuation
        pipes[key]?.task = spawn(.work) { runtime in await runtime.runDoor(id, budget: budget) }
        let timing = self.timing
        pipes[key]?.doorTimer = spawn(.watcher) { runtime in
          do { try await timing.sleep(budget) } catch { return }
          runtime.abandonDoor(id, TunnelFailure.timedOut)
        }
      }
    } onCancel: {
      Task { await self.abandonDoor(id, CancellationError()) }
    }
  }

  /// Zamyka generację, drzwi, endpoint dzierżawy i zadania. Po powrocie liczniki są zerem. Dzierżawa jest wspólna:
  /// po `shutdown()` żaden runtime na niej nie dostanie endpointu (koniec procesu albo testu).
  public func shutdown() async {
    if machine.state != .retired { event(.retire) }
    closeDoors()
    shutDown = true
    while let entry = tasks.first(where: { $0.value.kind == .work })?.value {
      await entry.task.value
    }
    timer?.task.cancel()
    timer = nil
    deadlines = []
    while let entry = tasks.first?.value {
      await entry.task.value
    }
    for (_, continuation) in waiters { continuation.resume(returning: .cancelled) }
    waiters = [:]
    releaseBackgroundTime()
    await lease.shutdown()
  }

  public var counters: Counters {
    Counters(
      connections: connectionsHeld, listeners: proxyCounters.listeners, pairs: proxyCounters.pairs,
      clients: clientsAlive, doors: pipes.keys.filter { if case .door = $0 { true } else { false } }.count,
      tasks: tasks.count)
  }

  // MARK: - Do testów

  var machineState: TunnelMachine.State { machine.state }
  var machineWorks: [TunnelMachine.WorkID] { Array(machine.works.keys) }
  var machineLease: LeaseReadiness { machine.lease }
  var machineLastGeneration: UInt64 { machine.lastGeneration }
  /// Zadania pracy (bez obserwatorów i zegara): zero = runtime czeka na zdarzenie albo czas.
  var busyTasks: Int { tasks.values.filter { $0.kind == .work }.count }

  // MARK: - Maszyna

  private func event(_ event: TunnelMachine.Event) {
    apply(machine.handle(event, now: timing.now()))
    if !holdsBackgroundTime { releaseBackgroundTime() }
  }

  /// Generacja w tle według maszyny albo, po `retire` w tle, jej zasoby jeszcze w zamykaniu: stan `retired` przychodzi
  /// przed końcem `finishTeardown` (proxy, połączenie, opróżnienie biletu).
  private var holdsBackgroundTime: Bool {
    machine.holdsBackgroundGeneration
      || (machine.scene == .background && pipes.keys.contains { if case .generation = $0 { true } else { false } })
  }

  private func releaseBackgroundTime() {
    guard !backgroundTimeWaiters.isEmpty else { return }
    let released = backgroundTimeWaiters
    backgroundTimeWaiters = []
    for continuation in released { continuation.resume() }
  }

  private func apply(_ commands: [TunnelMachine.Command]) {
    for command in commands {
      switch command {
      case let .open(gen, choice, budget):
        open(gen, choice: choice, budget: budget)
      case let .probe(gen):
        probe(gen)
      case let .close(gen), let .discard(gen):
        // Pełne zamknięcie i odrzucenie częściowych zasobów to ta sama sekwencja na tym, co generacja ma.
        teardown(.generation(gen), code: 0)
      case let .rebindEndpoint(reason):
        chainLease { lease in await lease.rebind(reason) }
      case let .reportIroh(success):
        // The iroh failure report limit across pairing runtimes: a failure the shared limit holds back does not reach the lease.
        guard success || failureReports?.admitFailure(at: timing.now()) ?? true else { break }
        chainLease { lease in await lease.reportIroh(success: success) }
      case let .release(ids, result):
        for id in ids { waiters.removeValue(forKey: id)?.resume(returning: outcome(result)) }
      case let .schedule(at):
        schedule(at)
      case let .log(line):
        log("tunnel: \(line)")
      }
    }
  }

  private func outcome(_ result: TunnelMachine.WaiterResult) -> TunnelGenerationOutcome {
    switch result {
    case .offline: return .offline
    case .cancelled: return .cancelled
    case let .ready(gen):
      guard let pipe = pipes[.generation(gen)], pipe.phase == .open, let client = pipe.client else {
        log("tunnel: generation \(gen) released as ready without resources")
        return .offline
      }
      return .ready(TunnelGeneration(number: gen, choice: pipe.choice, client: client, ticket: pipe.ticket))
    }
  }

  private func cancelWaiter(_ id: TunnelMachine.WaiterID) {
    guard waiters[id] != nil else { return }
    event(.cancelWaiter(id))
    // Czekający, którego maszyna nie trzyma, nie dostałby już niczego.
    waiters.removeValue(forKey: id)?.resume(returning: .cancelled)
  }

  /// Próba dla prac z konstrukcji, gdy maszyna wciąż stoi w `idle` w tle z pracą: zdarzenie powtarza termin pracy,
  /// którą maszyna jeszcze trzyma, więc praca zakończona w międzyczasie nie wraca.
  private func startInitialWork() {
    guard case .idle = machine.state, machine.scene == .background,
          let (id, expiresAt) = machine.works.max(by: { $0.value < $1.value }) else { return }
    event(.backgroundWorkStarted(id, expiresAt: expiresAt))
  }

  private func applyLease(_ readiness: LeaseReadiness, sequence: UInt64) {
    guard sequence > leaseApplied else { return }
    leaseApplied = sequence
    event(.leaseChanged(readiness))
  }

  /// Operacje dzierżawy z poleceń maszyny idą po kolei (`rebind` przed `acquire` następnej generacji).
  private func chainLease(_ body: @escaping @Sendable (EndpointLease) async -> Void) {
    let previous = leaseChain
    let lease = self.lease
    leaseChain = spawn(.work) { _ in
      await previous?.value
      await body(lease)
    }
  }

  // MARK: - Zegar

  private func schedule(_ at: ContinuousClock.Instant) {
    guard !shutDown else { return }
    deadlines.append(at)
    armTimer()
  }

  private func armTimer() {
    guard let next = deadlines.min() else {
      timer?.task.cancel()
      timer = nil
      return
    }
    if let timer, timer.at == next { return }
    timer?.task.cancel()
    let delay = max(.zero, timing.now().duration(to: next))
    let timing = self.timing
    let task = spawn(.watcher) { runtime in
      do { try await timing.sleep(delay) } catch { return }
      runtime.timerFired(next)
    }
    timer = (next, task)
  }

  private func timerFired(_ at: ContinuousClock.Instant) {
    guard let timer, timer.at == at else { return }
    self.timer = nil
    let now = timing.now()
    deadlines.removeAll { $0 <= now }
    event(.tick)
    armTimer()
  }

  // MARK: - Otwieranie

  private func open(_ gen: UInt64, choice: TransportChoice, budget: Duration) {
    let key = PipeKey.generation(gen)
    pipes[key] = Pipe(choice: choice)
    pipes[key]?.task = spawn(.work) { runtime in await runtime.runOpen(gen, choice: choice, budget: budget) }
  }

  private func runOpen(_ gen: UInt64, choice: TransportChoice, budget: Duration) async {
    let key = PipeKey.generation(gen)
    switch choice {
    case .https:
      guard isOpening(key) else { return }
      guard let httpsClient else {
        event(.openFailed(generation: gen, .unavailable("no HTTPS client")))
        return
      }
      pipes[key]?.client = httpsClient
      pipes[key]?.phase = .open
      event(.opened(generation: gen))
    case .iroh:
      do {
        guard try await buildIroh(key, budget: budget) else { return }
        event(.opened(generation: gen))
      } catch {
        guard isOpening(key) else { return }
        event(.openFailed(generation: gen, Self.failure(error)))
      }
    }
  }

  /// Połączenie, nasłuch i klient pętli dla `key`. Fałsz = zasoby porzucone w trakcie (spóźnione zamknięte tu);
  /// prawda = wszystko na miejscu i faza `open`.
  private func buildIroh(_ key: PipeKey, budget: Duration) async throws -> Bool {
    guard let target else { throw TunnelFailure.unavailable("no iroh route") }
    let user = Self.newUser()
    guard isOpening(key) else { return false }
    pipes[key]?.user = user
    await leaseChain?.value
    guard isOpening(key) else { return false }
    let endpoint: any TunnelEndpoint
    do {
      endpoint = try await lease.acquire(user, budget: budget)
    } catch {
      if !isOpening(key) { await lease.release(user) }
      throw error
    }
    guard isOpening(key) else {
      await lease.release(user)
      return false
    }
    let connection: any TunnelConnection
    do {
      try await endpoint.ensureRelay(target.relay)
      guard isOpening(key) else {
        await lease.release(user)
        return false
      }
      connection = try await endpoint.connect(to: target, alpn: IrohWire.alpnBytes)
    } catch {
      if !isOpening(key) { await lease.release(user) }
      throw error
    }
    connectionsHeld += 1
    guard isOpening(key) else {
      log("tunnel: late connection for \(describe(key)), closing it")
      closeConnection(connection, code: 0, reason: "late connection")
      await lease.release(user)
      return false
    }
    pipes[key]?.connection = connection
    watch(connection, key)
    let proxy = TunnelProxy(connection: connection, counters: proxyCounters, sleep: timing.sleep)
    let port: Int
    do {
      port = try await proxy.start()
    } catch {
      _ = await proxy.close(code: 0)
      throw error
    }
    guard isOpening(key), let base = URL(string: "http://127.0.0.1:\(port)") else {
      // Połączenie należy już do generacji i zamyka je jej zamknięcie; nasłuch zamykamy tu.
      _ = await proxy.close(code: 0)
      return false
    }
    let client = makeClient(base)
    clientsAlive += 1
    pipes[key]?.proxy = proxy
    pipes[key]?.client = client
    pipes[key]?.ownsClient = true
    pipes[key]?.phase = .open
    watch(proxy, key)
    return true
  }

  private func probe(_ gen: UInt64) {
    guard let pipe = pipes[.generation(gen)], pipe.phase == .open, let client = pipe.client else {
      event(.probeFinished(generation: gen, .transport))
      return
    }
    let ticket = pipe.ticket
    pipes[.generation(gen)]?.probe = spawn(.work) { runtime in
      let outcome = await Self.probe(client, ticket: ticket)
      runtime.event(.probeFinished(generation: gen, outcome))
    }
  }

  /// Probe `GET /api/version` with the device key (iroh, and HTTPS of a credential with an iroh route): any HTTP
  /// answer (401 too) means ready, a transport error means failure.
  private static func probe(_ client: RarogClient, ticket: GenerationTicket) async -> TunnelMachine.ProbeOutcome {
    guard ticket.begin() else { return .transport }
    defer { ticket.end() }
    do {
      let response = try await client.perform(.get("/api/version"))
      return .http(status: response.status)
    } catch {
      switch error {
      case let .unauthorized(failure), let .forbidden(failure), let .rateLimited(failure), let .http(failure):
        return .http(status: failure.status)
      case .refused, .timedOut, .offline, .cancelled, .invalidResponse:
        return .transport
      }
    }
  }

  // MARK: - Obserwatory

  private func watch(_ connection: any TunnelConnection, _ key: PipeKey) {
    spawn(.watcher) { runtime in
      let reason = await connection.closed()
      runtime.connectionEnded(key, connection, reason: reason)
    }
  }

  private func connectionEnded(_ key: PipeKey, _ connection: any TunnelConnection, reason: TunnelFailure) {
    guard let pipe = pipes[key], pipe.connection === connection, pipe.phase != .closing else { return }
    log("tunnel: \(describe(key)) connection ended: \(reason)")
    if case let .generation(gen) = key { event(.connectionLost(generation: gen)) }
  }

  private func watch(_ proxy: TunnelProxy, _ key: PipeKey) {
    spawn(.watcher) { runtime in
      for await event in proxy.events where event == .abortTimedOut {
        runtime.abortTimedOut(key, proxy)
      }
    }
  }

  /// Przerwana para nie skończyła się w terminie: połączenie zamyka apka, bez udziału serwera.
  private func abortTimedOut(_ key: PipeKey, _ proxy: TunnelProxy) {
    guard let pipe = pipes[key], pipe.proxy === proxy else { return }
    log("tunnel: \(describe(key)) abort timed out, closing the connection")
    pipe.connection?.close(code: 0, reason: "abort timed out")
    if case let .generation(gen) = key, pipe.phase == .open { event(.abortTimedOut(generation: gen)) }
  }

  // MARK: - Zamykanie

  /// Zamykanie `key` jako zadanie pracy runtime'u (``shutdown()`` czeka na nie). Początek jest synchroniczny:
  /// faza `closing`, bilet w zamykaniu, zadanie otwierania anulowane. Zasoby w zamykaniu dają to samo zadanie
  /// (`code` pierwszego zamknięcia obowiązuje), zasoby już zamknięte `nil`.
  @discardableResult
  private func teardown(_ key: PipeKey, code: UInt64) -> Task<Void, Never>? {
    guard var pipe = pipes[key] else { return nil }
    if pipe.phase == .closing { return pipe.teardown }
    pipe.phase = .closing
    pipe.ticket.startClosing()
    pipe.task?.cancel()
    pipe.probe?.cancel()
    pipe.doorTimer?.cancel()
    pipe.teardown = spawn(.work) { runtime in await runtime.finishTeardown(key, code: code) }
    pipes[key] = pipe
    return pipe.teardown
  }

  private func finishTeardown(_ key: PipeKey, code: UInt64) async {
    guard let pipe = pipes[key] else { return }
    if let proxy = pipe.proxy { _ = await proxy.close(code: code) }
    if let connection = pipe.connection {
      closeConnection(connection, code: code, reason: closeReason(key, code: code))
    }
    if pipe.ownsClient, let client = pipe.client {
      _ = await Self.drained(pipe.ticket, within: Self.drainDeadline, sleep: timing.sleep)
      client.invalidate()
      clientsAlive -= 1
    }
    if let user = pipe.user { await lease.release(user) }
    pipes[key] = nil
    if case let .generation(gen) = key { event(.closed(generation: gen)) }
  }

  private func closeConnection(_ connection: any TunnelConnection, code: UInt64, reason: String) {
    connection.close(code: code, reason: reason)
    connectionsHeld -= 1
  }

  private func closeReason(_ key: PipeKey, code: UInt64) -> String {
    switch key {
    case .generation: "generation closed"
    case .door: code == 1 ? "upload cancelled" : "upload door closed"
    }
  }

  /// Opróżnienie biletu na zegarze runtime: prawda, gdy licznik zszedł do zera przed terminem.
  private static func drained(_ ticket: GenerationTicket, within limit: Duration,
                              sleep: @escaping @Sendable (Duration) async throws -> Void) async -> Bool {
    await withTaskGroup(of: Bool.self) { group in
      // Termin biletu daleko: kończy go anulowanie po terminie runtime.
      group.addTask { await ticket.drained(within: .seconds(86_400)) }
      group.addTask {
        try? await sleep(limit)
        return false
      }
      let first = await group.next() ?? false
      group.cancelAll()
      return first
    }
  }

  // MARK: - Drzwi uploadu

  private func runDoor(_ id: UInt64, budget: Duration) async {
    let key = PipeKey.door(id)
    do {
      guard try await buildIroh(key, budget: budget), let pipe = pipes[key], let client = pipe.client else { return }
      pipes[key]?.doorTimer?.cancel()
      pipes[key]?.doorTimer = nil
      let door = UploadDoor(client: client, ticket: pipe.ticket) { [weak self] code in
        await self?.closeDoor(id, code: code)
      }
      pipes[key]?.doorWaiter = nil
      pipe.doorWaiter?.resume(returning: door)
    } catch {
      abandonDoor(id, Self.failure(error))
    }
  }

  /// Czekanie na drzwi skończone porażką, budżetem albo anulowaniem: wołający dostaje błąd, zasoby się zamykają.
  private func abandonDoor(_ id: UInt64, _ error: any Error) {
    let key = PipeKey.door(id)
    guard let waiter = pipes[key]?.doorWaiter else { return }
    pipes[key]?.doorWaiter = nil
    waiter.resume(throwing: error)
    teardown(key, code: 0)
  }

  /// `UploadDoor.close`: wraca po końcu zamykania drzwi, także gdy dołącza do zamykania w toku.
  private func closeDoor(_ id: UInt64, code: UInt64) async {
    await teardown(.door(id), code: code)?.value
  }

  private func closeDoors() {
    for key in pipes.keys {
      guard case let .door(id) = key else { continue }
      if pipes[key]?.doorWaiter != nil {
        abandonDoor(id, TunnelFailure.unavailable("tunnel runtime retired"))
      } else {
        teardown(key, code: 0)
      }
    }
  }

  // MARK: - Pomocnicze

  private func isOpening(_ key: PipeKey) -> Bool {
    pipes[key]?.phase == .opening
  }

  private func describe(_ key: PipeKey) -> String {
    switch key {
    case let .generation(gen): "generation \(gen)"
    case let .door(id): "upload door \(id)"
    }
  }

  @discardableResult
  private func spawn(_ kind: TaskKind,
                     _ body: @escaping @Sendable (isolated TunnelRuntime) async -> Void) -> Task<Void, Never> {
    nextTask += 1
    let id = nextTask
    let task = Task {
      await body(self)
      self.taskEnded(id)
    }
    tasks[id] = (kind, task)
    return task
  }

  private func taskEnded(_ id: Int) {
    tasks[id] = nil
  }

  private static func failure(_ error: any Error) -> TunnelFailure {
    if let failure = error as? TunnelFailure { return failure }
    if error is CancellationError { return .unavailable("cancelled") }
    return .connectFailed(String(describing: error))
  }

  /// Użytkownicy lease są unikalni w procesie: dzierżawa jest wspólna dla runtime'ów kolejnych tożsamości.
  private static let userCounter = Mutex<UInt64>(0)

  private static func newUser() -> LeaseUser {
    LeaseUser(userCounter.withLock { value -> UInt64 in
      value += 1
      return value
    })
  }
}
