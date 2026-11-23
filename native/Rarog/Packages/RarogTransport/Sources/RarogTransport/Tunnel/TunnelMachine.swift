import Foundation

// Maszyna generacji tunelu: czysty `struct` bez zegara systemowego, bez IrohLib i bez efektów ubocznych. Czas
// przychodzi z każdym zdarzeniem (`now`), a skutki wychodzą jako polecenia dla runtime tunelu (otwórz, sonduj,
// zamknij, odrzuć, zwolnij czekających, zaplanuj `tick`). Runtime dołącza numer generacji do każdego wyniku,
// a maszyna odrzuca wynik ze starym numerem. Reguły maszyny i wybór transportu mają testy
// w `TunnelMachineTests`, a każda para stan × zdarzenie wpis w `TunnelMachineMatrixTests`.
// An iroh-only credential has its own retry series, budget and failure reports (`TunnelMachine+IrohOnly.swift`,
// tests in `TunnelMachineTests`).

/// Maszyna generacji tunelu: jedna próba naraz, bramka czekających, życie generacji w tle i powrót z tła.
public struct TunnelMachine: Sendable, Equatable {
  public typealias Instant = ContinuousClock.Instant

  /// Jeden budżet próby: `bind` + `connect` + `openBi` + sonda (iroh-only in the foreground: `irohOnlyAttemptBudget`).
  public static let attemptBudget: Duration = .seconds(15)
  /// Ile generacja żyje po zejściu sceny w tło, gdy w tle nie ma pracy albo ostatnia praca kończy się wcześniej.
  public static let backgroundGrace: Duration = .seconds(8)
  /// Przerwa po nieudanej próbie, zanim popyt otworzy następną.
  public static let cooldown: Duration = .seconds(1)
  /// Iroh failure memory: for this long the next generations choose HTTPS, unless an HTTPS attempt fails first.
  /// An iroh-only credential gets the retry series instead (`irohOnlyRetryDelay(afterFailures:)`); every
  /// credential reports an iroh failure to the lease at most this often.
  public static let irohRetryDelay: Duration = .seconds(120)
  /// Polityka endpointu po powrocie z tła. Zmiana na `reuse` tylko po pomiarze na urządzeniu.
  public static let returnPolicy: ReturnPolicy = .rebindOnReturn

  /// Czekający na generację: jedno żądanie przełącznika transportu.
  public struct WaiterID: Hashable, Sendable, CustomStringConvertible {
    public let raw: UInt64
    public init(_ raw: UInt64) { self.raw = raw }
    public var description: String { "w\(raw)" }
  }

  /// Praca w tle z `needsServer` (np. zapis notatki, token Live Activity).
  public struct WorkID: Hashable, Sendable, CustomStringConvertible {
    public let raw: UInt64
    public init(_ raw: UInt64) { self.raw = raw }
    public var description: String { "p\(raw)" }
  }

  /// Trasy poświadczenia: czy ma adres HTTPS i czy ma serwer iroh.
  public struct Routes: Sendable, Equatable {
    public var hasHTTPS: Bool
    public var hasIroh: Bool
    public init(hasHTTPS: Bool, hasIroh: Bool) {
      self.hasHTTPS = hasHTTPS
      self.hasIroh = hasIroh
    }
  }

  public enum Scene: Sendable, Equatable { case active, inactive, background }

  /// `rebindOnReturn`: po zamknięciu z powodu tła albo sieci endpoint wiąże się od nowa, zanim ruszy następna
  /// generacja. `reuse`: następna generacja bierze żywy endpoint.
  public enum ReturnPolicy: Sendable, Equatable { case reuse, rebindOnReturn }

  public enum CloseReason: Sendable, Equatable { case background, network, lost, failed, retire }

  /// Wynik sondy `GET /api/version`: każda odpowiedź HTTP (także 401) to gotowość, błąd transportu to porażka.
  public enum ProbeOutcome: Sendable, Equatable { case http(status: Int), transport }

  /// Co dostaje czekający z bramki.
  public enum WaiterResult: Sendable, Equatable { case ready(generation: UInt64), offline, cancelled }

  /// Pamięć porażki iroh.
  public struct Memory: Sendable, Equatable {
    /// Iroh waits until then: 2 min with an HTTPS route (a failed HTTPS attempt ends it), the series pause without one.
    public var retryIrohAt: Instant?
    /// Failed attempts of the iroh-only retry series; a ready iroh generation and `networkChanged` start it over.
    public var seriesFailures: Int
    /// Last failure of the iroh-only series reported to the lease (`reportIroh(success: false)`).
    public var reportedAt: Instant?
    /// Iroh-only outage for the trace lines; only a ready iroh generation ends it.
    public var outage: Outage?
    /// Credential with both routes: routes whose failure line this outage already logged; a ready generation ends it.
    public var failedRoutes: Set<TransportChoice>
    public init(retryIrohAt: Instant? = nil, seriesFailures: Int = 0, reportedAt: Instant? = nil,
                outage: Outage? = nil, failedRoutes: Set<TransportChoice> = []) {
      self.retryIrohAt = retryIrohAt
      self.seriesFailures = seriesFailures
      self.reportedAt = reportedAt
      self.outage = outage
      self.failedRoutes = failedRoutes
    }
  }

  /// Próba generacji (`opening`, `probing`): termin budżetu i czekający.
  public struct Attempt: Sendable, Equatable {
    public var generation: UInt64
    public var since: Instant
    public var choice: TransportChoice
    public var deadline: Instant
    public var waiters: [WaiterID]
    public init(generation: UInt64, since: Instant, choice: TransportChoice, deadline: Instant, waiters: [WaiterID]) {
      self.generation = generation
      self.since = since
      self.choice = choice
      self.deadline = deadline
      self.waiters = waiters
    }
  }

  /// Termin łaski generacji, która zeszła w tło gotowa (także z pracą w tle): koniec ostatniej pracy przed
  /// nim wraca do `backgroundGrace` z tym terminem, w chwili terminu albo po nim zamyka generację.
  public struct Grace: Sendable, Equatable {
    public var generation: UInt64
    public var until: Instant
    public init(generation: UInt64, until: Instant) {
      self.generation = generation
      self.until = until
    }
  }

  /// Zamykana generacja: powód i czekający na następną.
  public struct Closing: Sendable, Equatable {
    public var generation: UInt64
    public var reason: CloseReason
    public var waiters: [WaiterID]
    public init(generation: UInt64, reason: CloseReason, waiters: [WaiterID]) {
      self.generation = generation
      self.reason = reason
      self.waiters = waiters
    }
  }

  public enum State: Sendable, Equatable {
    case idle
    case opening(Attempt)
    case probing(Attempt)
    case ready(generation: UInt64, choice: TransportChoice)
    case backgroundGrace(generation: UInt64, choice: TransportChoice, until: Instant)
    case backgroundWork(generation: UInt64, choice: TransportChoice)
    case closing(Closing)
    case cooldown(until: Instant)
    /// Koniec życia maszyny: żadna generacja już się nie otworzy.
    case retired
  }

  public enum Event: Sendable, Equatable {
    case demand(WaiterID)
    case cancelWaiter(WaiterID)
    case scene(Scene)
    case backgroundWorkStarted(WorkID, expiresAt: Instant)
    case backgroundWorkFinished(WorkID)
    case backgroundWorkExpired(WorkID)
    /// System zabrał apce czas w tle (wygasło zadanie łaski koordynatora albo system go odmówił): generacja
    /// w łasce zamyka się od razu, bez czekania na termin.
    case backgroundTimeExpired
    case networkChanged
    case opened(generation: UInt64)
    case probeFinished(generation: UInt64, ProbeOutcome)
    case openFailed(generation: UInt64, TunnelFailure)
    case connectionLost(generation: UInt64)
    case abortTimedOut(generation: UInt64)
    case closed(generation: UInt64)
    case leaseChanged(LeaseReadiness)
    case retire
    case credentialChanged(Routes)
    case tick

    /// Numer generacji wyniku runtime; `nil` dla zdarzeń bez numeru.
    public var generation: UInt64? {
      switch self {
      case .opened(let gen), .probeFinished(let gen, _), .openFailed(let gen, _), .connectionLost(let gen),
        .abortTimedOut(let gen), .closed(let gen):
        gen
      default:
        nil
      }
    }
  }

  public enum Command: Sendable, Equatable {
    /// Opening a generation within the budget (`bind` + `connect` + `openBi` + probe, or the HTTPS client and, with an
    /// iroh route, its probe).
    case open(generation: UInt64, choice: TransportChoice, budget: Duration)
    case probe(generation: UInt64)
    /// Pełne zamknięcie żywej generacji; runtime odpowiada `closed`.
    case close(generation: UInt64)
    /// Zamknięcie częściowych albo spóźnionych zasobów (połączenie, nasłuch, klient, użytkownik lease).
    case discard(generation: UInt64)
    case rebindEndpoint(RebindReason)
    /// Wynik próby iroh do lease (licznik kolejnych porażek endpointu).
    case reportIroh(success: Bool)
    case release([WaiterID], WaiterResult)
    /// Runtime wysyła `tick` najpóźniej w tej chwili.
    case schedule(at: Instant)
    case log(String)
  }

  public private(set) var state: State = .idle
  public private(set) var routes: Routes
  /// Gotowość lease widziana przez maszynę (z `leaseChanged` i z własnego `rebindEndpoint`).
  public private(set) var lease: LeaseReadiness
  public private(set) var memory = Memory()
  public private(set) var scene: Scene = .inactive
  public private(set) var works: [WorkID: Instant] = [:]
  /// Termin łaski z ostatniego zejścia w tło z `ready`; obowiązuje tylko generację o tym numerze.
  public private(set) var grace: Grace?
  public private(set) var policy: ReturnPolicy
  /// Numer ostatnio otwartej generacji (rośnie przy każdym otwarciu).
  public private(set) var lastGeneration: UInt64 = 0

  /// Stan początkowy (`lease`, `scene`, `works`) obowiązuje przed pierwszym zdarzeniem, w stanie `idle`.
  public init(routes: Routes, lease: LeaseReadiness = .ready, scene: Scene = .inactive, works: [WorkID: Instant] = [:],
              policy: ReturnPolicy = TunnelMachine.returnPolicy) {
    self.routes = routes
    self.lease = lease
    self.scene = scene
    self.works = works
    self.policy = policy
  }

  /// Numer generacji bieżącego stanu; `nil` w `idle`, `cooldown` i `retired`.
  public var currentGeneration: UInt64? {
    switch state {
    case .opening(let attempt), .probing(let attempt): attempt.generation
    case .ready(let gen, _), .backgroundGrace(let gen, _, _), .backgroundWork(let gen, _): gen
    case .closing(let closing): closing.generation
    case .idle, .cooldown, .retired: nil
    }
  }

  /// Popyt: czekający stanu albo praca w tle z `needsServer`.
  public var hasDemand: Bool { !waiters.isEmpty || !works.isEmpty }

  /// Generacja żyje albo się zamyka przy scenie w tle: do tej chwili proces potrzebuje czasu systemu w tle, bo
  /// zamrożony proces nie dostaje `tick` terminu łaski. Koordynator apki trzyma na ten czas zadanie
  /// systemu bez `needsServer`.
  public var holdsBackgroundGeneration: Bool { scene == .background && currentGeneration != nil }

  private var waiters: [WaiterID] {
    switch state {
    case .opening(let attempt), .probing(let attempt): attempt.waiters
    case .closing(let closing): closing.waiters
    default: []
    }
  }

  /// Wybór transportu następnej generacji; `nil` znaczy `cooldown` (tylko iroh, a iroh teraz nie wolno).
  public func choice(now: Instant) -> TransportChoice? {
    let memoryAllows = memory.retryIrohAt.map { now >= $0 } ?? true
    if routes.hasIroh && memoryAllows {
      if lease == .ready { return .iroh }
      if lease == .rebinding && !routes.hasHTTPS { return .iroh }  // acquire czeka na nowy endpoint
    }
    if routes.hasHTTPS { return .https }  // after an iroh failure (2 min or until a failed HTTPS attempt) or without iroh
    return nil
  }

  public mutating func handle(_ event: Event, now: Instant) -> [Command] {
    var out: [Command] = []
    if case .retired = state {
      handleRetired(event, &out)
      return out
    }
    if let gen = event.generation, gen != currentGeneration {
      out.append(.discard(generation: gen))
      return out
    }
    switch event {
    case .demand(let waiter): demand(waiter, now: now, &out)
    case .cancelWaiter(let waiter): cancelWaiter(waiter, &out)
    case .scene(let next): sceneChanged(next, now: now, &out)
    case .backgroundWorkStarted(let id, let expiresAt): workStarted(id, expiresAt: expiresAt, now: now, &out)
    case .backgroundWorkFinished(let id), .backgroundWorkExpired(let id): workEnded(id, now: now, &out)
    case .backgroundTimeExpired: backgroundTimeExpired(&out)
    case .networkChanged: networkChanged(now: now, &out)
    case .opened(let gen): opened(gen, now: now, &out)
    case .probeFinished(let gen, let outcome): probeFinished(gen, outcome, now: now, &out)
    case .openFailed(let gen, let failure): openFailed(gen, failure, now: now, &out)
    case .connectionLost(let gen): connectionLost(gen, now: now, &out)
    case .abortTimedOut(let gen): abortTimedOut(gen, &out)
    case .closed(let gen): closed(gen, now: now, &out)
    case .leaseChanged(let readiness): leaseChanged(readiness, now: now, &out)
    case .retire: retire(&out)
    case .credentialChanged(let next): routes = next
    case .tick: tick(now: now, &out)
    }
    return out
  }

  // MARK: - Zdarzenia

  private mutating func demand(_ waiter: WaiterID, now: Instant, _ out: inout [Command]) {
    switch state {
    case .idle:
      if scene != .background || !works.isEmpty {
        startAttempt(waiters: [waiter], now: now, &out)
      } else {
        out.append(.release([waiter], .offline))
      }
    case .opening(var attempt):
      if !attempt.waiters.contains(waiter) { attempt.waiters.append(waiter) }
      state = .opening(attempt)
    case .probing(var attempt):
      if !attempt.waiters.contains(waiter) { attempt.waiters.append(waiter) }
      state = .probing(attempt)
    case .ready(let gen, _), .backgroundWork(let gen, _):
      out.append(.release([waiter], .ready(generation: gen)))
    case .backgroundGrace:
      out.append(.release([waiter], .offline))  // w tle bez pracy żądanie dostaje od razu `.offline`
    case .closing(var closing):
      if closing.reason == .failed || (scene == .background && works.isEmpty) {
        out.append(.release([waiter], .offline))
      } else {
        if !closing.waiters.contains(waiter) { closing.waiters.append(waiter) }
        state = .closing(closing)
      }
    case .cooldown:
      out.append(.release([waiter], .offline))
    case .retired:
      break
    }
  }

  private mutating func cancelWaiter(_ waiter: WaiterID, _ out: inout [Command]) {
    switch state {
    case .opening(var attempt) where attempt.waiters.contains(waiter):
      attempt.waiters.removeAll { $0 == waiter }
      state = .opening(attempt)
      out.append(.release([waiter], .cancelled))
    case .probing(var attempt) where attempt.waiters.contains(waiter):
      attempt.waiters.removeAll { $0 == waiter }
      state = .probing(attempt)
      out.append(.release([waiter], .cancelled))
    case .closing(var closing) where closing.waiters.contains(waiter):
      closing.waiters.removeAll { $0 == waiter }
      state = .closing(closing)
      out.append(.release([waiter], .cancelled))
    default:
      break
    }
  }

  private mutating func sceneChanged(_ next: Scene, now: Instant, _ out: inout [Command]) {
    scene = next
    switch next {
    case .inactive:
      break
    case .active:
      switch state {
      case .backgroundGrace(let gen, let choice, let until):
        if now < until {
          state = .ready(generation: gen, choice: choice)
        } else {
          // Termin minął, gdy proces stał, a zaległy `tick` jeszcze nie doszedł. Stara generacja się
          // zamyka jak na końcu łaski; popyt po powrocie czeka na następną generację.
          closeGrace(gen, &out)
        }
      case .backgroundWork(let gen, let choice):
        state = .ready(generation: gen, choice: choice)  // praca trzymała generację
      default:
        break  // otwierana próba trwa, bez drugiego `open`
      }
    case .background:
      switch state {
      case .opening(let attempt), .probing(let attempt):
        guard works.isEmpty else { return }  // wynik próby rozstrzyga gotowość
        state = .closing(Closing(generation: attempt.generation, reason: .background, waiters: []))
        out.append(.discard(generation: attempt.generation))
        release(attempt.waiters, .offline, &out)
      case .ready(let gen, let choice):
        let until = now + Self.backgroundGrace  // termin łaski także przy niepustych `works`
        grace = Grace(generation: gen, until: until)
        if works.isEmpty {
          state = .backgroundGrace(generation: gen, choice: choice, until: until)
          out.append(.schedule(at: until))
        } else {
          state = .backgroundWork(generation: gen, choice: choice)
        }
      case .closing(var closing):
        guard works.isEmpty, !closing.waiters.isEmpty else { return }
        release(closing.waiters, .offline, &out)
        closing.waiters = []
        state = .closing(closing)
      default:
        break
      }
    }
  }

  private mutating func workStarted(_ id: WorkID, expiresAt: Instant, now: Instant, _ out: inout [Command]) {
    works[id] = expiresAt
    switch state {
    case .idle, .cooldown:
      if scene == .background { startAttempt(waiters: [], now: now, &out) }
    case .backgroundGrace(let gen, let choice, _):
      state = .backgroundWork(generation: gen, choice: choice)
    default:
      break  // praca rozpoczęta w zamykaniu, w otwieraniu albo na pierwszym planie
    }
  }

  private mutating func workEnded(_ id: WorkID, now: Instant, _ out: inout [Command]) {
    guard works.removeValue(forKey: id) != nil else { return }
    guard works.isEmpty, scene == .background else { return }  // nieostatnia praca
    switch state {
    case .backgroundWork(let gen, let choice):
      if let grace, grace.generation == gen, now < grace.until {
        state = .backgroundGrace(generation: gen, choice: choice, until: grace.until)  // łaska trwa
        out.append(.schedule(at: grace.until))
      } else {
        state = .closing(Closing(generation: gen, reason: .background, waiters: []))
        out.append(.close(generation: gen))
      }
    case .opening(let attempt), .probing(let attempt):
      state = .closing(Closing(generation: attempt.generation, reason: .background, waiters: []))
      out.append(.discard(generation: attempt.generation))
      release(attempt.waiters, .offline, &out)
    case .closing(var closing):
      release(closing.waiters, .offline, &out)
      closing.waiters = []
      state = .closing(closing)
    default:
      break
    }
  }

  private mutating func networkChanged(now: Instant, _ out: inout [Command]) {
    memory.retryIrohAt = nil
    memory.seriesFailures = 0  // a new series, the outage goes on
    memory.reportedAt = nil
    switch state {
    case .ready(let gen, let choice):
      foregroundCloseAlarm(gen, choice, reason: "network", &out)
      state = .closing(Closing(generation: gen, reason: .network, waiters: []))
      out.append(.close(generation: gen))
    case .backgroundGrace(let gen, _, _), .backgroundWork(let gen, _):
      state = .closing(Closing(generation: gen, reason: .network, waiters: []))
      out.append(.close(generation: gen))
    case .cooldown:
      leaveCooldown(now: now, &out)  // następna generacja próbuje iroh od razu
    default:
      break
    }
  }

  private mutating func opened(_ gen: UInt64, now: Instant, _ out: inout [Command]) {
    switch state {
    case .opening(let attempt):
      if attempt.choice == .iroh || routes.hasIroh {
        // Iroh, and HTTPS of a credential with both routes, prove the route before the generation is ready.
        state = .probing(attempt)
        out.append(.probe(generation: gen))
      } else {
        becomeReady(gen, choice: .https, waiters: attempt.waiters, &out)  // HTTPS-only, ready without a probe
      }
    case .closing:
      out.append(.discard(generation: gen))  // spóźniony wynik zamykanej generacji
    default:
      break
    }
  }

  private mutating func probeFinished(_ gen: UInt64, _ outcome: ProbeOutcome, now: Instant, _ out: inout [Command]) {
    switch state {
    case .probing(let attempt):
      switch outcome {
      case .http where attempt.choice == .https:
        becomeReady(gen, choice: .https, waiters: attempt.waiters, &out)  // the iroh failure memory stays
      case .http:
        let outage = memory.outage
        memory = Memory()  // the series and the outage end
        out.append(.reportIroh(success: true))
        if let outage { out.append(.log(Self.recoveryLine(gen, outage, now: now))) }
        becomeReady(gen, choice: attempt.choice, waiters: attempt.waiters, &out)
      case .transport:
        failAttempt(attempt, now: now, why: "probe: transport error", &out)
      }
    case .closing:
      out.append(.discard(generation: gen))
    default:
      break
    }
  }

  private mutating func openFailed(_ gen: UInt64, _ failure: TunnelFailure, now: Instant, _ out: inout [Command]) {
    switch state {
    case .opening(let attempt), .probing(let attempt):
      failAttempt(attempt, now: now, why: "open: \(failure)", &out)
    case .closing:
      out.append(.discard(generation: gen))
    default:
      break
    }
  }

  private mutating func connectionLost(_ gen: UInt64, now: Instant, _ out: inout [Command]) {
    switch state {
    case .ready(_, let choice):
      foregroundCloseAlarm(gen, choice, reason: "lost", &out)
      state = .closing(Closing(generation: gen, reason: .lost, waiters: []))
      out.append(.close(generation: gen))
    case .backgroundGrace, .backgroundWork:
      state = .closing(Closing(generation: gen, reason: .lost, waiters: []))
      out.append(.close(generation: gen))
    case .opening(let attempt), .probing(let attempt):
      failAttempt(attempt, now: now, why: "connection lost during attempt", &out)
    default:
      break
    }
  }

  private mutating func abortTimedOut(_ gen: UInt64, _ out: inout [Command]) {
    switch state {
    case .ready(_, let choice):
      foregroundCloseAlarm(gen, choice, reason: "abort timed out", &out)
      state = .closing(Closing(generation: gen, reason: .lost, waiters: []))
      out.append(.close(generation: gen))
    case .backgroundGrace, .backgroundWork:
      state = .closing(Closing(generation: gen, reason: .lost, waiters: []))
      out.append(.close(generation: gen))
    default:
      break
    }
  }

  private mutating func closed(_ gen: UInt64, now: Instant, _ out: inout [Command]) {
    switch state {
    case .closing(let closing):
      finishClosing(closing, now: now, &out)
    case .ready, .backgroundGrace, .backgroundWork:
      // Generacja skończyła się bez polecenia maszyny: jak utrata połączenia, która już się zamknęła.
      if case .ready(_, .iroh) = state {
        foregroundCloseAlarm(gen, .iroh, reason: "lost, without a close command", &out)
      } else {
        out.append(.log("generation \(gen) closed without a close command"))
      }
      finishClosing(Closing(generation: gen, reason: .lost, waiters: []), now: now, &out)
    case .opening(let attempt), .probing(let attempt):
      failAttempt(attempt, now: now, why: "closed during attempt", &out)
    default:
      break
    }
  }

  private mutating func leaseChanged(_ readiness: LeaseReadiness, now: Instant, _ out: inout [Command]) {
    lease = readiness
    // Lease readiness ends a cooldown the lease caused; the pause of the iroh-only series keeps its deadline.
    let pauseOver = memory.retryIrohAt.map { now >= $0 } ?? true
    if case .cooldown = state, readiness == .ready, irohOnly, pauseOver {
      leaveCooldown(now: now, &out)
    }
  }

  private mutating func retire(_ out: inout [Command]) {
    switch state {
    case .opening(let attempt), .probing(let attempt):
      release(attempt.waiters, .cancelled, &out)
      out.append(.discard(generation: attempt.generation))
    case .ready(let gen, _), .backgroundGrace(let gen, _, _), .backgroundWork(let gen, _):
      out.append(.close(generation: gen))
    case .closing(let closing):
      release(closing.waiters, .cancelled, &out)
    case .idle, .cooldown, .retired:
      break
    }
    works = [:]
    state = .retired
    out.append(.log("machine retired"))
  }

  private mutating func tick(now: Instant, _ out: inout [Command]) {
    switch state {
    case .opening(let attempt), .probing(let attempt):
      if now >= attempt.deadline { failAttempt(attempt, now: now, why: "attempt budget elapsed", &out) }
    case .backgroundGrace(let gen, _, let until):
      guard now >= until else { return }
      closeGrace(gen, &out)
    case .cooldown(let until):
      if now >= until { leaveCooldown(now: now, &out) }
    default:
      break
    }
  }

  /// Bez czasu systemu w tle łaska nie trwa. Praca w tle trzyma generację dalej, ale łaska tego pobytu
  /// w tle przepada: koniec ostatniej pracy zamyka generację, zamiast wracać do łaski bez zadania systemu.
  /// Następne zejście w tło z `ready` daje nową łaskę. Pozostałe stany nie mają łaski.
  private mutating func backgroundTimeExpired(_ out: inout [Command]) {
    switch state {
    case .backgroundGrace(let gen, _, _): closeGrace(gen, &out)
    case .backgroundWork: grace = nil
    default: break
    }
  }

  /// Po `retire` żadna generacja się nie otwiera, popyt dostaje `.cancelled`, wyniki idą do `discard`.
  private func handleRetired(_ event: Event, _ out: inout [Command]) {
    if case .demand(let waiter) = event {
      out.append(.release([waiter], .cancelled))
    } else if let gen = event.generation {
      out.append(.discard(generation: gen))
    }
  }

  // MARK: - Przejścia wspólne

  /// Nowa próba: wybór trasy i budżet; bez wyboru `cooldown`, bez budżetu w tle czekający dostają `.offline`.
  private mutating func startAttempt(waiters: [WaiterID], now: Instant, _ out: inout [Command]) {
    guard let budget = attemptBudget(now: now) else {
      state = .idle
      release(waiters, .offline, &out)
      return
    }
    guard let choice = choice(now: now) else {
      let until = memory.retryIrohAt.flatMap { $0 > now ? $0 : nil } ?? now + Self.cooldown
      state = .cooldown(until: until)
      out.append(.schedule(at: until))
      release(waiters, .offline, &out)
      out.append(.log("iroh unavailable and no HTTPS route: cooldown"))
      return
    }
    lastGeneration += 1
    let gen = lastGeneration
    let deadline = now + budget
    state = .opening(Attempt(generation: gen, since: now, choice: choice, deadline: deadline, waiters: waiters))
    out.append(.open(generation: gen, choice: choice, budget: budget))
    out.append(.schedule(at: deadline))
  }

  /// Budżet próby: 15 s (iroh-only in the foreground 30 s), a w tle nie dłużej niż do terminu najdłuższej pracy;
  /// `nil`, gdy w tle nie ma po co.
  private func attemptBudget(now: Instant) -> Duration? {
    guard scene == .background else { return irohOnly ? Self.irohOnlyAttemptBudget : Self.attemptBudget }
    guard let latest = works.values.max() else { return nil }
    let left = now.duration(to: latest)
    guard left > .zero else { return nil }
    return min(Self.attemptBudget, left)
  }

  /// Koniec łaski: `closing(background)` i pełne zamknięcie generacji.
  private mutating func closeGrace(_ gen: UInt64, _ out: inout [Command]) {
    state = .closing(Closing(generation: gen, reason: .background, waiters: []))
    out.append(.close(generation: gen))
  }

  /// Gotowość G: wspólna dla gotowej sondy i otwartej generacji HTTPS. A ready generation ends the
  /// outage of a credential with both routes, so its next failures log again.
  private mutating func becomeReady(_ gen: UInt64, choice: TransportChoice, waiters: [WaiterID],
                                    _ out: inout [Command]) {
    memory.failedRoutes = []
    if scene != .background {
      state = .ready(generation: gen, choice: choice)
      release(waiters, .ready(generation: gen), &out)
    } else if !works.isEmpty {
      state = .backgroundWork(generation: gen, choice: choice)
      release(waiters, .ready(generation: gen), &out)
    } else {
      state = .closing(Closing(generation: gen, reason: .background, waiters: []))
      out.append(.close(generation: gen))
      release(waiters, .offline, &out)
    }
  }

  /// A failed attempt closes its partial resources. A failed iroh attempt sets the failure memory and
  /// reports to the lease; with both routes a failed HTTPS attempt ends the iroh pause instead, without a report.
  private mutating func failAttempt(_ attempt: Attempt, now: Instant, why: String, _ out: inout [Command]) {
    state = .closing(Closing(generation: attempt.generation, reason: .failed, waiters: []))
    out.append(.discard(generation: attempt.generation))
    release(attempt.waiters, .offline, &out)
    let line = Command.log("generation \(attempt.generation) (\(attempt.choice)) failed: \(why)")
    guard attempt.choice == .iroh, irohOnly else {
      switch attempt.choice {
      case .iroh:
        memory.retryIrohAt = now + Self.irohRetryDelay
        reportIrohFailure(now: now, &out)
      case .https:
        if routes.hasIroh { memory.retryIrohAt = nil }  // the next generation tries iroh after the cooldown
      }
      // While both routes are down the attempts alternate: one failure line per route and outage.
      let bothRoutes = routes.hasHTTPS && routes.hasIroh
      if !bothRoutes || memory.failedRoutes.insert(attempt.choice).inserted { out.append(line) }
      return
    }
    // The series pause, one report per `irohRetryDelay`, one line per outage.
    memory.seriesFailures += 1
    memory.retryIrohAt = now + Self.irohOnlyRetryDelay(afterFailures: memory.seriesFailures)
    reportIrohFailure(now: now, &out)
    if var outage = memory.outage {
      outage.failures += 1
      memory.outage = outage
    } else {
      memory.outage = Outage(since: now, failures: 1)
      out.append(line)
    }
  }

  /// An iroh failure goes to the lease at most once per `irohRetryDelay`, so quick retries do not rebind the
  /// endpoint (`rebind(.broken)` after `EndpointLease.brokenAfterFailures` reports).
  private mutating func reportIrohFailure(now: Instant, _ out: inout [Command]) {
    guard memory.reportedAt.map({ $0.duration(to: now) >= Self.irohRetryDelay }) ?? true else { return }
    memory.reportedAt = now
    out.append(.reportIroh(success: false))
  }

  /// A ready iroh generation that closes in the foreground leaves an alarm line; HTTPS generations and closes
  /// in the background do not.
  private func foregroundCloseAlarm(_ gen: UInt64, _ choice: TransportChoice, reason: String,
                                    _ out: inout [Command]) {
    guard choice == .iroh else { return }
    out.append(.log(Self.foregroundCloseLine(gen, reason: reason)))
  }

  /// `closed` zamykanej generacji: cooldown po porażce, nowa próba dla popytu albo `idle`.
  private mutating func finishClosing(_ closing: Closing, now: Instant, _ out: inout [Command]) {
    switch closing.reason {
    case .failed:
      // Cooldown; an iroh-only credential waits for the end of the series pause.
      let pause = irohOnly ? memory.retryIrohAt : nil
      let until = max(now + Self.cooldown, pause ?? now)
      state = .cooldown(until: until)
      out.append(.schedule(at: until))
      release(closing.waiters, .offline, &out)
    case .retire:
      state = .retired
      release(closing.waiters, .cancelled, &out)
    case .background, .network, .lost:
      if policy == .rebindOnReturn && (closing.reason == .background || closing.reason == .network) {
        out.append(.rebindEndpoint(.policy))  // przed następnym `open`
        if lease != .unavailable { lease = .rebinding }
      }
      var waiters = closing.waiters
      if scene == .background && works.isEmpty {
        release(waiters, .offline, &out)
        waiters = []
      }
      if !waiters.isEmpty || !works.isEmpty {
        startAttempt(waiters: waiters, now: now, &out)
      } else {
        state = .idle
      }
    }
  }

  /// Koniec przerwy: `idle`, a w tle z pracą od razu nowa próba.
  private mutating func leaveCooldown(now: Instant, _ out: inout [Command]) {
    state = .idle
    if scene == .background && !works.isEmpty { startAttempt(waiters: [], now: now, &out) }
  }

  private func release(_ waiters: [WaiterID], _ result: WaiterResult, _ out: inout [Command]) {
    guard !waiters.isEmpty else { return }
    out.append(.release(waiters, result))
  }
}
