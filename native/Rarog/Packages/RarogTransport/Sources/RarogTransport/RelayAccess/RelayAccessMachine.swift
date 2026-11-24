import Foundation
import RarogContract

// Maszyna klienta rejestru relaya iroh: czysty `struct` bez zegara, bez losowości
// i bez efektów, wzór `TunnelMachine`. Chwila przychodzi z każdym zdarzeniem (`now`), skutki wychodzą jako polecenia
// dla actora `RelayAccess`: żądanie do rejestru, dowód bramki, zapis pamięci, zapis i kasowanie rezygnacji, status,
// wynik przygotowania parowania i `forget()`, linia logu. Polecenie z wynikiem niesie numer generacji, a wynik wraca
// zdarzeniem z tym numerem.
//
// - Jedno polecenie z wynikiem naraz: następne żądanie, dowód albo zapis rezygnacji wychodzi dopiero po wyniku
//   poprzedniego. Actor wykonuje polecenia magazynu od razu i oddaje wynik, zanim przyjmie inne zdarzenie.
// - Każda operacja (synchronizacja, przygotowanie parowania, `forget`) ma własny numer generacji. T-parowanie
//   i T-zapomnij podnoszą numer już w chwili wyzwalacza: operacja w toku dostaje jeszcze wynik polecenia
//   w drodze, ale niczego już nie wysyła ani nie zapisuje w pamięci podręcznej. Wynik magazynu rezygnacji zmienia stan
//   w pamięci także dla operacji zastąpionej, bo opisuje to, co już leży w Keychainie.
// - Wyzwalacze automatyczne w czasie operacji łączą się w jedną następną synchronizację z ostatnią listą;
//   T-parowanie i T-zapomnij idą przed nią, a nowszy z nich zastępuje starszy, który dostaje wynik od razu.
// - Rejestr nigdy nie blokuje iroh: każda porażka to status i przerwa, nie odmowa.
// - Problem jednego serwera przy `sponsor` (`serverQuota`, `serverDenied`, `internal`) nie wstrzymuje poręczeń
//   pozostałych; `unreachable`, `limited` i `clock` dotyczą apki i kończą synchronizację. Przy kilku problemach status
//   pokazuje najważniejszy (kolejność `RelayAccessProblem`), a przerwa trwa do najpóźniejszego terminu.
// - Parowanie dostaje wynik, gdy los s jest znany (reszta poręczeń idzie dalej). Nieudane kasowanie rezygnacji to
//   `.unavailable` bez rejestracji: zapis `pending`, który zostałby w Keychainie, po restarcie wysłałby `forget`.
// - `.ready` carries when this process got the server's sponsorship (a sync in the background counts too), so the core
//   can wait for the relay after a sponsorship from a moment ago; the moment is not saved in the Keychain.
// - Pamięć nieczytelna przy starcie (Keychain odmówił odczytu) to brak pamięci bez zapisu: maszyna pracuje w pamięci
//   procesu i nie nadpisuje wpisu, którego nie przeczytała.

/// Maszyna klienta rejestru: kiedy synchronizować, co wysłać, co zapisać i jaki status pokazać.
public struct RelayAccessMachine: Sendable, Equatable {
  public typealias Generation = UInt64
  /// Numer wywołania `prepareForPairing` albo `forget()` u actora; wynik wraca z tym numerem.
  public typealias Ticket = UInt64

  /// T-tunel uruchamia synchronizację najwyżej raz na tyle sekund.
  public static let tunnelCheckInterval: Int64 = 600
  /// Okres odnowienia: bez potrzeby synchronizacja najwyżej tak często.
  public static let defaultRenewEvery: Duration = .seconds(21_600)
  /// Przerwa po `unreachable` i `gateFailed`: `min(backoffMax, backoffBase · 2^(failures − 1))` sekund.
  public static let backoffBase: Int64 = 60
  public static let backoffMax: Int64 = 21_600
  /// Po `unsupported` wyzwalacze automatyczne nie pytają rejestru przez tyle sekund; tylko w pamięci procesu.
  public static let unsupportedPause: Int64 = 86_400

  public enum Event: Sendable, Equatable {
    /// Wyzwalacz automatyczny: T-start, T-front, T-tożsamość, T-tunel. `appId` = EndpointId podpisu, `nil` = tożsamość
    /// niedostępna.
    case trigger(RelayAccessTrigger, appId: String?)
    /// T-lista: ostatnia lista par iroh poświadczenia (`setServers`).
    case servers([TunnelTarget], appId: String?)
    /// T-parowanie(s) (`prepareForPairing`).
    case pair(TunnelTarget, ticket: Ticket, appId: String?)
    /// T-zapomnij (`forget()`).
    case forget(ticket: Ticket, appId: String?)
    /// Wynik polecenia `send` tej generacji.
    case replied(generation: Generation, RelayAuthReply)
    /// Wynik polecenia `proof` tej generacji.
    case proved(generation: Generation, Result<RelayAuthWire.Proof, RelayGateFailure>)
    /// Wynik polecenia `saveOptOut` tej generacji.
    case optOutSaved(generation: Generation, Bool)
    /// Wynik polecenia `deleteOptOut` tej generacji.
    case optOutDeleted(generation: Generation, Bool)
    /// Wynik polecenia `saveCache` (`false` = praca w pamięci procesu).
    case cacheSaved(Bool)
  }

  public enum Command: Sendable, Equatable {
    /// Żądanie trasy apki do rejestru `registry` z chwilą `issuedAt` (sekundy epoki); wynik: `replied`.
    case send(RelayAuthWire.Fields, registry: URL, issuedAt: Int64, generation: Generation)
    /// Nowy dowód bramki; wynik: `proved`.
    case proof(generation: Generation)
    /// Zapis pamięci podręcznej; wynik: `cacheSaved`.
    case saveCache(RelayAccessCache)
    /// Zapis rezygnacji; wynik: `optOutSaved`.
    case saveOptOut(RelayOptOut, generation: Generation)
    /// Kasowanie rezygnacji (także wpisu nieczytelnego); wynik: `optOutDeleted`.
    case deleteOptOut(generation: Generation)
    /// Nowy status dla apki.
    case status(RelayAccessStatus)
    /// Wynik `prepareForPairing` o numerze `ticket`.
    case prepareResult(ticket: Ticket, RelayPrepareResult)
    /// Wynik `forget()` o numerze `ticket`.
    case forgetResult(ticket: Ticket, RelayAccessStatus)
    /// Linia do `client.log` (prefiks `relay-access:`), bez tokenu, podpisu i ciała.
    case log(String)
  }

  /// Polecenie w drodze: na jaki wynik maszyna czeka i dla której generacji.
  public struct Awaiting: Sendable, Equatable {
    public enum Kind: Sendable, Equatable {
      case reply, proof
      case optOutSaved(RelayOptOut)
      case optOutDeleted
    }

    public let generation: Generation
    public let kind: Kind
  }

  public private(set) var status: RelayAccessStatus = .inactive
  /// Numer ostatniej operacji (rośnie przy każdej nowej i przy T-parowaniu albo T-zapomnij).
  public private(set) var generation: Generation = 0
  /// EndpointId apki z ostatniego wyzwalacza; `nil` = tożsamość niedostępna.
  public private(set) var appId: String?
  /// Ostatnia lista z `setServers`.
  public private(set) var servers: [TunnelTarget] = []
  /// Pamięć podręczna w pamięci procesu (ta sama, którą zapisuje `saveCache`).
  public private(set) var cache: RelayAccessCache?
  /// Rezygnacja tak, jak leży w Keychainie.
  public private(set) var optOut: RelayStoredRead<RelayOptOut>
  public private(set) var awaiting: Awaiting?

  let gateSupported: Bool
  let registries: [String: URL]
  let renewEvery: Int64
  /// `false` = pamięć była nieczytelna przy starcie: bez zapisu w tym procesie.
  let cacheWritable: Bool
  private var operation: Operation?
  /// T-parowanie albo T-zapomnij, które czeka na wolną kolejkę.
  private var preempting: Queued?
  /// Wyzwalacze automatyczne złączone w następną synchronizację.
  private var queuedSync: Set<Reason> = []
  private var startupLogs: [String] = []
  private var cacheSaveFailing = false
  /// Koniec przerwy po `unsupported`; T-parowanie jej nie zna.
  private var unsupportedUntil: Int64?
  /// When this process got each server's sponsorship (seconds of the epoch), for `.ready(sponsoredAt:)`: the relay
  /// admits a sponsorship from a moment ago only after a while. Process memory only, like `unsupportedUntil`.
  private var sponsoredAt: [String: Int64] = [:]

  /// `cache` i `optOut` to odczyty magazynu, które actor `RelayAccess` robi przy pierwszej paczce wejść z tożsamością
  /// (przed pierwszym odblokowaniem urządzenia Keychain odmawia odczytu); `gateSupported` = `RelayGate.isSupported`
  /// z tej samej chwili.
  public init(
    cache: RelayStoredRead<RelayAccessCache>, optOut: RelayStoredRead<RelayOptOut>, gateSupported: Bool,
    registries: [String: URL] = RelayAuthWire.registries, renewEvery: Duration = RelayAccessMachine.defaultRenewEvery
  ) {
    self.gateSupported = gateSupported
    self.registries = registries
    self.renewEvery = renewEvery.components.seconds
    self.optOut = optOut
    switch cache {
    case let .found(value):
      self.cache = value
      cacheWritable = true
    case .none:
      cacheWritable = true
    case let .unreadable(reason):
      cacheWritable = false
      startupLogs.append("relay-access: cache unreadable (\(reason)), kept in memory")
    }
    if case let .unreadable(reason) = optOut {
      startupLogs.append("relay-access: opt-out unreadable (\(reason)), automatic registration paused")
    }
  }

  /// Przerwa po problemie w sekundach; `nil` dla problemów bez ponowienia (`storage`, `optOutNotSaved`).
  public static func delay(_ problem: RelayAccessProblem, failures: Int) -> Int64? {
    switch problem {
    case .unreachable, .gateFailed:
      let shift = Int64(min(max(failures - 1, 0), 20))
      return min(backoffMax, backoffBase << shift)
    case .limited, .clock, .proofRejected: return 3_600
    case .quota, .denied, .internal, .gateMismatch, .serverQuota, .serverDenied: return 86_400
    case .storage, .optOutNotSaved: return nil
    }
  }

  // MARK: - Zdarzenia

  public mutating func handle(_ event: Event, now: Date) -> [Command] {
    let t = Int64(now.timeIntervalSince1970.rounded(.down))
    var out = Outbox()
    out.logs = startupLogs
    startupLogs = []
    let cacheBefore = cache
    let statusBefore = status
    switch event {
    case let .trigger(trigger, appId):
      self.appId = appId
      queuedSync.insert(Reason(trigger))
    case let .servers(list, appId):
      self.appId = appId
      servers = list
      queuedSync.insert(.list)
    case let .pair(target, ticket, appId):
      pairArrived(target, ticket: ticket, appId: appId, &out)
    case let .forget(ticket, appId):
      forgetArrived(ticket: ticket, appId: appId, &out)
    case let .replied(gen, reply):
      noteSponsorship(gen, reply, t)
      if accept(gen, { $0 == .reply }, &out) { replied(reply, t, &out) }
    case let .proved(gen, result):
      if accept(gen, { $0 == .proof }, &out) { proved(result, t, &out) }
    case let .optOutSaved(gen, saved):
      if saved, let awaiting, awaiting.generation == gen, case let .optOutSaved(record) = awaiting.kind {
        optOut = .found(record)  // Keychain ma już ten wpis, także gdy operację zastąpiono
      }
      if accept(gen, { if case .optOutSaved = $0 { true } else { false } }, &out) { optOutSaved(saved, t, &out) }
    case let .optOutDeleted(gen, deleted):
      if deleted, let awaiting, awaiting.generation == gen, awaiting.kind == .optOutDeleted { optOut = .none }
      if accept(gen, { $0 == .optOutDeleted }, &out) { optOutDeleted(deleted, t, &out) }
    case let .cacheSaved(saved):
      if !saved && !cacheSaveFailing { out.logs.append("relay-access: cache kept in memory (save failed)") }
      cacheSaveFailing = !saved
    }
    pump(t, &out)
    var commands = out.logs.map(Command.log)
    if cacheWritable, let cache, cache != cacheBefore { commands.append(.saveCache(cache)) }
    if status != statusBefore { commands.append(.status(status)) }
    commands += out.answers
    if let request = out.request { commands.append(request) }
    return commands
  }

  /// A sponsorship the registry gave also counts for an operation already superseded (a pairing that preempts a sync
  /// mid-`sponsor` then finds the server alive): like the opt-out store, the moment describes what already happened.
  private mutating func noteSponsorship(_ gen: Generation, _ reply: RelayAuthReply, _ t: Int64) {
    guard let awaiting, awaiting.generation == gen, awaiting.kind == .reply, let operation,
      operation.generation == gen, case let .sponsoring(server) = operation.phase,
      case let .sponsored(result) = reply, result.server == server
    else { return }
    sponsoredAt[server] = t
  }

  /// Wynik pasuje do polecenia w drodze i operacja jest bieżąca; inaczej wynik nie zmienia stanu (poza magazynem).
  private mutating func accept(_ gen: Generation, _ kind: (Awaiting.Kind) -> Bool, _ out: inout Outbox) -> Bool {
    guard let awaiting, awaiting.generation == gen, kind(awaiting.kind) else {
      out.logs.append("relay-access: unexpected result ignored (generation \(gen))")
      return false
    }
    self.awaiting = nil
    guard let operation, operation.generation == generation else {
      self.operation = nil
      out.logs.append("relay-access: result of superseded operation ignored (generation \(gen))")
      return false
    }
    return true
  }

  // MARK: - Kolejka

  private mutating func pump(_ t: Int64, _ out: inout Outbox) {
    while awaiting == nil {
      if operation != nil { end(&out) }  // operacja bez polecenia w drodze jest skończona
      if let next = preempting {
        preempting = nil
        switch next {
        case let .pair(target, registry, ticket, gen): startPair(target, registry, ticket, gen, t, &out)
        case let .forget(ticket, gen): startForget(ticket, gen, t, &out)
        }
      } else if !queuedSync.isEmpty {
        let reasons = queuedSync
        queuedSync = []
        startSync(reasons, t, &out)
      } else {
        return
      }
    }
  }

  /// T-parowanie albo T-zapomnij zastępuje operację w toku i czekającą: ich wywołujący dostaje wynik od razu.
  private mutating func supersede(_ out: inout Outbox) {
    if let queued = preempting {
      switch queued {
      case let .pair(_, _, ticket, _): out.answers.append(.prepareResult(ticket: ticket, .unavailable))
      case let .forget(ticket, _): out.answers.append(.forgetResult(ticket: ticket, status))
      }
      preempting = nil
    }
    guard var op = operation, op.generation == generation, !op.answered else { return }
    switch op.kind {
    case let .pair(_, _, ticket): out.answers.append(.prepareResult(ticket: ticket, .unavailable))
    case let .forget(ticket?, _): out.answers.append(.forgetResult(ticket: ticket, status))
    case .sync, .forget(nil, _): break
    }
    op.answered = true
    operation = op
  }

  private mutating func pairArrived(_ target: TunnelTarget, ticket: Ticket, appId: String?, _ out: inout Outbox) {
    self.appId = appId
    guard let registry = registry(for: target.relay), RelayAuthWire.isEndpointId(target.endpointId) else {
      out.answers.append(.prepareResult(ticket: ticket, .skipped))
      return
    }
    guard appId != nil else {
      out.logs.append("relay-access: identity unavailable")
      out.answers.append(.prepareResult(ticket: ticket, .skipped))
      return
    }
    supersede(&out)
    generation += 1
    preempting = .pair(target.endpointId, registry, ticket, generation)
  }

  private mutating func forgetArrived(ticket: Ticket, appId: String?, _ out: inout Outbox) {
    self.appId = appId
    guard appId != nil else {
      out.logs.append("relay-access: identity unavailable")
      status = .inactive
      out.answers.append(.forgetResult(ticket: ticket, .inactive))
      return
    }
    supersede(&out)
    generation += 1
    preempting = .forget(ticket, generation)
  }

  // MARK: - Synchronizacja automatyczna

  private mutating func startSync(_ reasons: Set<Reason>, _ t: Int64, _ out: inout Outbox) {
    guard let appId else {
      status = .inactive
      out.logs.append("relay-access: identity unavailable")
      return
    }
    if case let .found(record) = optOut, record.removal == .pending {
      generation += 1  // sam `forget`, niezależnie od listy i mapy
      operation = Operation(generation: generation, appId: appId, kind: .forget(nil, record.registry),
                            phase: .forgetting)
      send(.forget, registry: record.registry, t, &out)
      return
    }
    guard let list = mapped(servers) else {
      status = .inactive
      return
    }
    switch optOut {
    case .unreadable:
      status = .problem(.storage, appId: appId, retryAt: nil)
      return
    case let .found(record):
      status = .optedOut(appId: appId, removal: record.removal)
      return
    case .none:
      break
    }
    if let until = unsupportedUntil, t < until {
      status = .unsupported(appId: appId)  // bez bramki do końca przerwy
      return
    }
    var cache = adopt(appId: appId, registry: list.registry, &out)
    var reasons = reasons
    if reasons.contains(.tunnel), let last = cache.lastTunnelCheckAt, t < last + Self.tunnelCheckInterval {
      reasons.remove(.tunnel)  // najwyżej raz na 10 min
      if reasons.isEmpty {
        self.cache = cache
        return
      }
    }
    let newServer = reasons.contains(.list) && list.servers.contains { !alive($0, cache, t) }
    if !newServer {
      if let retryAt = cache.retryAt, t < retryAt {
        self.cache = cache
        status = .problem(cache.problem ?? .internal, appId: appId, retryAt: Self.date(retryAt))
        return
      }
      if !reasons.contains(.tunnel), isFresh(cache, list.servers, t), let until = cache.registeredUntil {
        self.cache = cache
        status = .registered(appId: appId, until: Self.date(until))
        return
      }
    }
    if reasons.contains(.tunnel) { cache.lastTunnelCheckAt = t }
    self.cache = cache
    generation += 1
    operation = Operation(generation: generation, appId: appId, kind: .sync, phase: .renewing,
                          run: Run(registry: list.registry, servers: list.servers, target: nil))
    beginRun(t, &out)
  }

  /// Pamięć dla tej tożsamości i rejestru; inna tożsamość albo rejestr = nowa pamięć.
  private mutating func adopt(appId: String, registry: URL, _ out: inout Outbox) -> RelayAccessCache {
    if let cache, cache.appId == appId, cache.registry == registry { return cache }
    if cache != nil { out.logs.append("relay-access: cache of another identity or registry replaced") }
    sponsoredAt = [:]
    let fresh = RelayAccessCache(appId: appId, registry: registry)
    cache = fresh
    return fresh
  }

  private func isFresh(_ cache: RelayAccessCache, _ servers: [String], _ t: Int64) -> Bool {
    guard cache.retryAt == nil, let last = cache.lastSyncAt, t < last + renewEvery,
      let until = cache.registeredUntil, until > t
    else { return false }
    return servers.allSatisfy { alive($0, cache, t) }
  }

  private func alive(_ server: String, _ cache: RelayAccessCache, _ t: Int64) -> Bool {
    cache.sponsored[server].map { $0 > t } ?? false
  }

  // MARK: - T-zapomnij i T-parowanie

  private mutating func startForget(_ ticket: Ticket, _ gen: Generation, _ t: Int64, _ out: inout Outbox) {
    guard let appId else {
      status = .inactive
      out.answers.append(.forgetResult(ticket: ticket, .inactive))
      return
    }
    let fallback = mapped(servers)?.registry ?? registries.sorted { $0.key < $1.key }.first?.value
    guard let registry = cache?.registry ?? fallback else {
      out.logs.append("relay-access: forget without a registry")
      out.answers.append(.forgetResult(ticket: ticket, status))
      return
    }
    let record = RelayOptOut(appId: appId, registry: registry, at: t, removal: .pending)
    operation = Operation(generation: gen, appId: appId, kind: .forget(ticket, registry), phase: .savingOptOut)
    request(.saveOptOut(record, generation: gen), .optOutSaved(record), &out)
  }

  private mutating func startPair(
    _ target: String, _ registry: URL, _ ticket: Ticket, _ gen: Generation, _ t: Int64, _ out: inout Outbox
  ) {
    guard let appId else {
      out.answers.append(.prepareResult(ticket: ticket, .skipped))
      return
    }
    operation = Operation(generation: gen, appId: appId, kind: .pair(target, registry, ticket), phase: .renewing)
    switch optOut {
    case let .found(record) where record.removal == .pending:
      operation?.phase = .forgetting  // najpierw `forget` z zapisu rezygnacji
      send(.forget, registry: record.registry, t, &out)
    case .found, .unreadable:
      operation?.phase = .deletingOptOut  // parowanie przez iroh = zgoda
      request(.deleteOptOut(generation: gen), .optOutDeleted, &out)
    case .none:
      beginPairSync(t, &out)
    }
  }

  /// Synchronizacja listy ∪ {s} bez okresu odnowienia i przerwy do `retryAt`; s idzie pierwszy (budżet przygotowania).
  private mutating func beginPairSync(_ t: Int64, _ out: inout Outbox) {
    guard let op = operation, case let .pair(target, registry, _) = op.kind else { return end(&out) }
    var list = [target]
    if let mapped = mapped(servers), mapped.registry == registry {
      list += mapped.servers.filter { $0 != target }
    }
    cache = adopt(appId: op.appId, registry: registry, &out)
    operation?.run = Run(registry: registry, servers: Array(list.prefix(RelayAuthWire.serversMax)), target: target)
    operation?.phase = .renewing
    beginRun(t, &out)
  }

  private mutating func optOutSaved(_ saved: Bool, _ t: Int64, _ out: inout Outbox) {
    guard let op = operation else { return }
    switch op.phase {
    case .savingOptOut:
      guard saved, case let .found(record) = optOut else {
        status = .problem(.optOutNotSaved, appId: op.appId, retryAt: nil)  // rezygnacji nie ma: bez `forget`
        out.logs.append("relay-access: opt-out not saved, forget not sent")
        end(&out)
        return
      }
      cache = RelayAccessCache(appId: op.appId, registry: record.registry)  // pamięć wyczyszczona
      sponsoredAt = [:]
      status = .optedOut(appId: op.appId, removal: .pending)
      operation?.phase = .forgetting
      send(.forget, registry: record.registry, t, &out)
    case .savingRemoval:
      if !saved { out.logs.append("relay-access: opt-out removal state not saved") }
      end(&out)
    default:
      end(&out)
    }
  }

  private mutating func optOutDeleted(_ deleted: Bool, _ t: Int64, _ out: inout Outbox) {
    guard let op = operation else { return }
    guard deleted else {
      status = .problem(.storage, appId: op.appId, retryAt: nil)
      out.logs.append("relay-access: opt-out not deleted, pairing without registration")
      end(&out)
      return
    }
    beginPairSync(t, &out)
  }

  private mutating func forgetReplied(_ reply: RelayAuthReply, _ t: Int64, _ out: inout Outbox) {
    guard let op = operation, case let .found(record) = optOut else {
      end(&out)
      return
    }
    let removal: RelayRemoval
    switch reply {
    case let .forgotten(result) where result.forgotten: removal = .confirmed
    case .failure(_, .denied?, _): removal = .blockedByAdmin
    default:
      removal = .pending  // 200 bez walidacji i każda inna porażka: następny wyzwalacz ponawia sam `forget`
      out.logs.append("relay-access: forget failed (\(Self.describe(reply)))")
    }
    // Stan w pamięci zmienia dopiero udany zapis (`optOutSaved`) albo kasowanie: pamięć = Keychain.
    var updated = record
    updated.removal = removal
    if case .pair = op.kind, removal == .confirmed {
      operation?.phase = .deletingOptOut
      request(.deleteOptOut(generation: op.generation), .optOutDeleted, &out)
      return
    }
    status = .optedOut(appId: op.appId, removal: removal)
    if case .pair = op.kind { answerPrepare(.unavailable, &out) }  // porażka `forget` = bez rejestracji
    guard removal != record.removal else {
      end(&out)
      return
    }
    operation?.phase = .savingRemoval
    request(.saveOptOut(updated, generation: op.generation), .optOutSaved(updated), &out)
  }

  // MARK: - Przebieg synchronizacji

  private mutating func beginRun(_ t: Int64, _ out: inout Outbox) {
    guard let run = operation?.run else { return end(&out) }
    if case .registered = status {} else { status = .working }
    operation?.phase = .renewing
    send(.renew(servers: run.servers), registry: run.registry, t, &out)
  }

  private mutating func replied(_ reply: RelayAuthReply, _ t: Int64, _ out: inout Outbox) {
    guard let op = operation else { return }
    if case let .failure(status, code?, _) = reply, code.status != status {
      out.logs.append("relay-access: error \(code.rawValue) with status \(status) ignored")
    }
    let reply = Self.canonical(reply)
    switch op.phase {
    case .forgetting: forgetReplied(reply, t, &out)
    case .renewing: renewed(reply, t, &out)
    case let .registering(kind): registered(reply, kind, t, &out)
    case let .sponsoring(server): sponsored(reply, server, t, &out)
    case .savingOptOut, .savingRemoval, .deletingOptOut, .proving: end(&out)
    }
  }

  private mutating func renewed(_ reply: RelayAuthReply, _ t: Int64, _ out: inout Outbox) {
    guard var run = operation?.run else { return end(&out) }
    switch reply {
    case let .renewed(result):
      alive(until: result.expiresAt, t)
      run.confirmed = true
      let unsponsored = Set(result.unsponsored)
      for server in run.servers where !unsponsored.contains(server) { cache?.sponsored[server] = result.expiresAt }
      run.queue = run.servers.filter { unsponsored.contains($0) }
      operation?.run = run
      sponsorNext(t, &out)
    case .failure(_, .notRegistered?, _):
      notRegistered()
      registerOrUnsupported(.first, t, &out)
    default:
      stop(Self.problem(reply, route: .renew), t, &out)
    }
  }

  /// Bramka bez wsparcia: bez dowodu i `register`.
  private mutating func registerOrUnsupported(_ kind: RegisterKind, _ t: Int64, _ out: inout Outbox) {
    guard gateSupported, let gen = operation?.generation else {
      unsupported(t, &out)
      return
    }
    operation?.phase = .proving(kind)
    request(.proof(generation: gen), .proof, &out)
  }

  private mutating func proved(_ result: Result<RelayAuthWire.Proof, RelayGateFailure>, _ t: Int64,
                               _ out: inout Outbox) {
    guard let op = operation, case let .proving(kind) = op.phase, let run = op.run else { return end(&out) }
    switch result {
    case let .success(proof):
      operation?.run?.gate = proof.kind
      operation?.phase = .registering(kind)
      send(.register(proof: proof), registry: run.registry, t, &out)
    case .failure(.unsupported):
      unsupported(t, &out)
    case let .failure(.failed(reason)):
      out.logs.append("relay-access: gate failed (\(reason))")
      stop(.gateFailed, t, &out)
    }
  }

  private mutating func registered(_ reply: RelayAuthReply, _ kind: RegisterKind, _ t: Int64, _ out: inout Outbox) {
    guard var run = operation?.run else { return end(&out) }
    switch reply {
    case let .registered(result):
      alive(until: result.expiresAt, t)
      run.registered = true
      run.confirmed = true
      switch kind {
      case let .recover(server): run.queue.insert(server, at: 0)  // po 404: jeszcze jeden `sponsor(s)`
      case .first, .retry: run.queue = run.servers
      }
      operation?.run = run
      sponsorNext(t, &out)
    case .failure(_, .proofRejected?, _) where kind == .first:
      registerOrUnsupported(.retry, t, &out)  // od razu nowy dowód
    case let .failure(_, .gateMismatch?, gate):
      let app = run.gate?.rawValue ?? "unknown"
      out.logs.append("relay-access: gate mismatch (registry \(gate?.rawValue ?? "unknown"), app \(app))")
      stop(.gateMismatch, t, &out)
    default:
      if case .failure(_, .notRegistered?, _) = reply { notRegistered() }
      stop(Self.problem(reply, route: .register), t, &out)
    }
  }

  private mutating func sponsored(_ reply: RelayAuthReply, _ server: String, _ t: Int64, _ out: inout Outbox) {
    guard var run = operation?.run else { return end(&out) }
    switch reply {
    case let .sponsored(result) where result.server == server:
      cache?.sponsored[server] = result.expiresAt
      sponsoredAt[server] = t
      if server == run.target { run.sponsoredTarget = true }
      operation?.run = run
      sponsorNext(t, &out)
    case .failure(_, .notRegistered?, _):
      notRegistered()
      run.confirmed = false
      guard !run.registered, !run.recovered else {
        operation?.run = run
        return stop(.internal, t, &out)  // druga 404 albo 404 po udanym `register`
      }
      run.recovered = true
      operation?.run = run
      registerOrUnsupported(.recover(server), t, &out)
    default:
      let problem = Self.problem(reply, route: .sponsor)
      if server == run.target { run.targetFailed = true }
      operation?.run = run
      if [.unreachable, .limited, .clock].contains(problem) { return stop(problem, t, &out) }
      record(problem, t)  // problem serwera, następny serwer idzie dalej
      sponsorNext(t, &out)
    }
  }

  private mutating func sponsorNext(_ t: Int64, _ out: inout Outbox) {
    answerPairIfDecided(t, &out)
    guard var run = operation?.run else { return end(&out) }
    guard !run.queue.isEmpty else { return finish(t, &out) }
    let server = run.queue.removeFirst()
    operation?.run = run
    operation?.phase = .sponsoring(server)
    send(.sponsor(server: server), registry: run.registry, t, &out)
  }

  /// Wynik parowania od razu, gdy los s jest znany (pozostałe poręczenia idą dalej w tle).
  private mutating func answerPairIfDecided(_ t: Int64, _ out: inout Outbox) {
    guard let op = operation, case let .pair(target, _, _) = op.kind, !op.answered, let run = op.run,
      let cache, run.confirmed, !run.queue.contains(target)
    else { return }
    if run.targetFailed {
      answerPrepare(.unavailable, &out)
    } else if alive(target, cache, t) {
      let ready = RelayPrepareResult.ready(sponsoredAt: sponsoredAt[target].map(Self.date))
      answerPrepare(run.registered || run.sponsoredTarget ? .fresh : ready, &out)
    }
  }

  /// Wpis apki żywy do `until`: koniec przerwy i porażek.
  private mutating func alive(until: Int64, _ t: Int64) {
    cache?.registeredUntil = until
    cache?.lastSyncAt = t
    cache?.failures = 0
    cache?.retryAt = nil
    cache?.problem = nil
  }

  /// Rejestr nie zna apki: wpis i jego poręczenia w pamięci są nieaktualne.
  private mutating func notRegistered() {
    cache?.registeredUntil = nil
    cache?.lastSyncAt = nil
    cache?.sponsored = [:]
    sponsoredAt = [:]
  }

  private mutating func record(_ problem: RelayAccessProblem, _ t: Int64) {
    if problem == .unreachable || problem == .gateFailed { cache?.failures += 1 }
    let retryAt = t + (Self.delay(problem, failures: cache?.failures ?? 1) ?? 0)
    let earlier = operation?.run?.problems[problem] ?? retryAt
    operation?.run?.problems[problem] = max(retryAt, earlier)
  }

  private mutating func stop(_ problem: RelayAccessProblem, _ t: Int64, _ out: inout Outbox) {
    record(problem, t)
    finish(t, &out)
  }

  private mutating func finish(_ t: Int64, _ out: inout Outbox) {
    guard let op = operation, let run = op.run else { return end(&out) }
    let worst = RelayAccessProblem.allCases.first { run.problems[$0] != nil }
    if let worst, let retryAt = run.problems.values.max() {
      cache?.problem = worst
      cache?.retryAt = retryAt
      status = .problem(worst, appId: op.appId, retryAt: Self.date(retryAt))
      out.logs.append("relay-access: \(worst.rawValue), next attempt after \(retryAt)")
    } else if let until = cache?.registeredUntil {
      status = .registered(appId: op.appId, until: Self.date(until))
    }
    answerPairIfDecided(t, &out)
    answerPrepare(.unavailable, &out)
    end(&out)
  }

  /// Bramka bez wsparcia; wyzwalacze automatyczne czekają `unsupportedPause` (bramka urządzenia się nie zmieni, `renew` dałby 404).
  private mutating func unsupported(_ t: Int64, _ out: inout Outbox) {
    guard let op = operation else { return }
    unsupportedUntil = t + Self.unsupportedPause
    status = .unsupported(appId: op.appId)
    out.logs.append("relay-access: gate unsupported on this device")
    answerPrepare(.skipped, &out)
    end(&out)
  }

  // MARK: - Polecenia i wyniki

  private mutating func send(_ fields: RelayAuthWire.Fields, registry: URL, _ t: Int64, _ out: inout Outbox) {
    guard let gen = operation?.generation else { return }
    request(.send(fields, registry: registry, issuedAt: t, generation: gen), .reply, &out)
  }

  private mutating func request(_ command: Command, _ kind: Awaiting.Kind, _ out: inout Outbox) {
    guard let gen = operation?.generation, awaiting == nil, out.request == nil else {
      out.logs.append("relay-access: second request suppressed")
      return
    }
    awaiting = Awaiting(generation: gen, kind: kind)
    out.request = command
  }

  private mutating func answerPrepare(_ result: RelayPrepareResult, _ out: inout Outbox) {
    guard let op = operation, case let .pair(_, _, ticket) = op.kind, !op.answered else { return }
    out.answers.append(.prepareResult(ticket: ticket, result))
    operation?.answered = true
  }

  /// Koniec operacji: wywołujący `forget()` dostaje bieżący status.
  private mutating func end(_ out: inout Outbox) {
    if let op = operation, case let .forget(ticket?, _) = op.kind, !op.answered {
      out.answers.append(.forgetResult(ticket: ticket, status))
    }
    answerPrepare(.unavailable, &out)
    operation = nil
  }

  // MARK: - Mapa i klasyfikacja

  /// Rejestr relaya `relay` z mapy (klucz = postać kanoniczna `r`); `nil` = relay spoza mapy.
  func registry(for relay: URL) -> URL? {
    registries[PairingLinkWire.relayURL(relay.absoluteString) ?? relay.absoluteString]
  }

  /// Lista do synchronizacji: serwery na relayu z mapy, jeden rejestr (pierwszego takiego serwera), bez powtórzeń.
  func mapped(_ targets: [TunnelTarget]) -> (registry: URL, servers: [String])? {
    var registry: URL?
    var servers: [String] = []
    for target in targets where RelayAuthWire.isEndpointId(target.endpointId) && target.endpointId != appId {
      guard let found = self.registry(for: target.relay) else { continue }
      if registry == nil { registry = found }
      if found == registry && !servers.contains(target.endpointId) { servers.append(target.endpointId) }
    }
    guard let registry, !servers.isEmpty else { return nil }
    return (registry, Array(servers.prefix(RelayAuthWire.serversMax)))
  }

  /// Kod błędu liczy się tylko ze swoim statusem z kontraktu (`ErrorCode.status`; Worker bierze status z tej samej
  /// tabeli). Inna para, np. 503 z `denied` od pośrednika, to odpowiedź bez znanego kodu: ≥ 500 → `unreachable`,
  /// reszta → `internal`, przy `forget` → `pending`.
  static func canonical(_ reply: RelayAuthReply) -> RelayAuthReply {
    guard case let .failure(status, code?, gate) = reply, code.status != status else { return reply }
    return .failure(status: status, code: nil, gate: gate)
  }

  /// Problem z odpowiedzi trasy `route`; `forget` ma własne reguły.
  static func problem(_ reply: RelayAuthReply, route: RelayAuthWire.Route) -> RelayAccessProblem {
    guard case let .failure(status, code, _) = reply else {
      if case .unreachable = reply { return .unreachable }
      return .internal  // wynik innej trasy
    }
    if status >= 500 { return .unreachable }
    switch code {
    case .limited?: return .limited
    case .quotaExceeded? where route == .register: return .quota
    case .quotaExceeded? where route == .sponsor: return .serverQuota
    case .clockSkew?: return .clock
    case .denied? where route == .sponsor: return .serverDenied
    case .denied?: return .denied
    case .gateMismatch? where route == .register: return .gateMismatch
    case .proofRejected? where route == .register: return .proofRejected
    default: return .internal
    }
  }

  /// Opis wyniku do logu: status i kod, bez ciała.
  static func describe(_ reply: RelayAuthReply) -> String {
    switch reply {
    case let .failure(status, code, _): "\(status) \(code?.rawValue ?? "unknown")"
    case let .unreachable(reason): reason
    case .registered, .renewed, .sponsored, .forgotten: "result of another route"
    }
  }

  static func date(_ seconds: Int64) -> Date { Date(timeIntervalSince1970: TimeInterval(seconds)) }

  // MARK: - Typy wewnętrzne

  enum Reason: Hashable, Sendable {
    case start, foreground, identity, tunnel, list

    init(_ trigger: RelayAccessTrigger) {
      switch trigger {
      case .start: self = .start
      case .foreground: self = .foreground
      case .identityAvailable: self = .identity
      case .tunnelFailed: self = .tunnel
      }
    }
  }

  /// Po co ten `register`: pierwszy, powtórka po 422, odbudowa przy `sponsor` 404.
  enum RegisterKind: Equatable, Sendable {
    case first, retry
    case recover(String)
  }

  enum Phase: Equatable, Sendable {
    case savingOptOut, forgetting, savingRemoval, deletingOptOut, renewing
    case proving(RegisterKind)
    case registering(RegisterKind)
    case sponsoring(String)
  }

  enum Kind: Equatable, Sendable {
    case sync
    /// Parowanie: serwer s, jego rejestr, numer wywołania.
    case pair(String, URL, Ticket)
    /// `forget`: numer wywołania (`nil` = ponowienie samego `forget`) i rejestr z zapisu rezygnacji.
    case forget(Ticket?, URL)
  }

  /// Jedna synchronizacja: lista, kolejka poręczeń, liczniki limitu żądań i zebrane problemy.
  struct Run: Equatable, Sendable {
    let registry: URL
    let servers: [String]
    let target: String?
    var queue: [String] = []
    /// Bramka ostatniego dowodu (do linii logu przy `gate-mismatch`).
    var gate: RelayAuthWire.Gate?
    /// Wpis apki potwierdzony w tej synchronizacji (`renew` albo `register` 200, bez późniejszego 404).
    var confirmed = false
    /// Udany `register` w tej synchronizacji.
    var registered = false
    /// Powtórka sponsora po 404 użyta.
    var recovered = false
    var sponsoredTarget = false
    var targetFailed = false
    /// Problem → najbliższa próba (sekundy epoki).
    var problems: [RelayAccessProblem: Int64] = [:]
  }

  struct Operation: Equatable, Sendable {
    let generation: Generation
    let appId: String
    let kind: Kind
    var phase: Phase
    var run: Run?
    /// Wywołujący dostał już wynik.
    var answered = false

    init(generation: Generation, appId: String, kind: Kind, phase: Phase, run: Run? = nil) {
      self.generation = generation
      self.appId = appId
      self.kind = kind
      self.phase = phase
      self.run = run
    }
  }

  enum Queued: Equatable, Sendable {
    case pair(String, URL, Ticket, Generation)
    case forget(Ticket, Generation)
  }

  struct Outbox {
    var logs: [String] = []
    var answers: [Command] = []
    var request: Command?
  }
}
