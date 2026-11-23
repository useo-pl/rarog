import Foundation
import RarogContract
@testable import RarogTransport
import RarogTransportTesting
import Synchronization
import Testing

// Runtime tunelu na atrapie transportu z usterkami, prawdziwej dzierżawie, prawdziwym proxy na pętli zwrotnej
// i prawdziwym `RarogClient`. Czas maszyny, dzierżawy i proxy płynie na jednym zegarze sztucznym, więc terminy
// (8 s tła, 15 s budżetu, 2 s przerwania i opróżnienia biletu) nie zależą od obciążenia maszyny. Stan ustalony
// to nie zero: poza żywą generacją zero połączeń, nasłuchów i sesji, endpointów najwyżej jeden; zero wszystkiego
// dopiero po `shutdown()`.

@Suite("runtime tunelu", .timeLimit(.minutes(5)))
struct TunnelRuntimeTests {
  @Test("200 cykli pierwszy plan ↔ tło w losowych odstępach: stan ustalony po każdym cyklu, szczyt endpointów 1")
  func foregroundBackgroundCycles() async throws {
    let rig = try await Rig.make(.irohOnly)
    var random = SplitMix64(seed: 0x5EED_2C)
    var requests = 0
    for cycle in 0 ..< 200 {
      await rig.runtime.scene(.active)
      let outcome = Task { await rig.runtime.generation() }
      try await rig.settle()
      if case let .ready(generation) = await outcome.value, cycle % 5 == 0 {
        try await rig.request(on: generation)
        requests += 1
      }
      try await rig.advance(by: random.gap(), settling: true)
      await rig.runtime.scene(.background)
      try await rig.settle()
      // Co któryś cykl tło trwa dłużej niż 8 s: generacja się zamyka, a endpoint wiąże od nowa.
      let extra: Duration = random.next() % 3 == 0 ? .seconds(9) : .zero
      try await rig.advance(by: random.gap() + extra, settling: true)
      try await rig.expectSteady("cykl \(cycle)")
    }
    #expect(requests == 40)
    #expect(rig.fake.endpoints.count > 20)  // generacje naprawdę się zamykały i wiązały endpoint od nowa
    try await rig.expectShutdownClean()
  }

  @Test("rebindOnReturn, tylko iroh: praca w tle idzie starą generacją, powrót w zamykaniu czeka na nowy endpoint")
  func rebindOnReturnIrohOnly() async throws {
    let rig = try await Rig.make(.irohOnly)
    let (old, next) = try await Self.returnDuringClosing(rig)
    #expect(next.choice == .iroh)
    #expect(next.number == old.number + 1)
    #expect(rig.fake.endpoints.count == 2)
    #expect(rig.fake.endpoints.first?.isClosed == true)  // endpoint zamknięty po pracy, nie wzięty po powrocie
    #expect(rig.fake.counters.endpointsPeak == 1)
    try await rig.request(on: next)
    try await rig.expectShutdownClean()
  }

  @Test("rebindOnReturn, HTTPS i iroh: powrót w trakcie zamykania idzie HTTPS, endpoint po pracy zamknięty")
  func rebindOnReturnWithHTTPS() async throws {
    let rig = try await Rig.make(.both)
    let (_, next) = try await Self.returnDuringClosing(rig)
    #expect(next.choice == .https)
    try await until("endpoint zamknięty po pracy") { rig.fake.counters.endpointsAlive == 0 }
    #expect(rig.fake.endpoints.count == 1)
    #expect(rig.fake.counters.endpointsPeak == 1)
    try await rig.expectShutdownClean()
  }

  @Test("dzierżawa unavailable przy konstrukcji, obie trasy: pierwsza generacja HTTPS bez próby iroh")
  func initialUnavailableLeaseGoesHTTPS() async throws {
    let rig = try await Rig.make(.both, scene: .active, readiness: .unavailable)
    let generation = try await rig.ready()
    #expect(generation.choice == .https)
    #expect(generation.number == 1)
    #expect(rig.fake.counters.bindStarted.isEmpty)
    #expect(rig.fake.counters.connectionsPeak == 0)  // zero `connect`
    try await rig.expectShutdownClean()
  }

  @Test("praca w tle przy konstrukcji: generacja jak po backgroundWorkStarted, koniec pracy ją zamyka")
  func initialBackgroundWorkOpensGeneration() async throws {
    let rig = try await Rig.make(.irohOnly, scene: .background, works: [.init(1): ContinuousClock.now + .seconds(30)])
    try await eventually("generacja pracy w tle") {
      if case .backgroundWork(_, .iroh) = await rig.runtime.machineState { return true }
      return false
    }
    #expect(await rig.runtime.machineWorks == [.init(1)])
    await rig.runtime.backgroundWorkFinished(.init(1))
    try await rig.settle()
    #expect(await rig.runtime.machineWorks.isEmpty)
    try await eventually("bez generacji po pracy") { await rig.runtime.machineState == .idle }
    try await rig.expectSteady("po pracy")
    try await rig.expectShutdownClean()
  }

  @Test("praca zakończona przed pierwszym krokiem runtime'u: bez generacji i bez pracy")
  func initialWorkFinishedImmediately() async throws {
    let rig = try await Rig.make(.irohOnly, scene: .background, works: [.init(1): ContinuousClock.now + .seconds(30)])
    await rig.runtime.backgroundWorkFinished(.init(1))
    try await rig.settle()
    #expect(await rig.runtime.machineWorks.isEmpty)
    let state = await rig.runtime.machineState
    if case .backgroundWork = state { Issue.record("generacja trzyma się jako praca w tle: \(state)") }
    try await rig.expectSteady("po pracy")
    try await rig.expectShutdownClean()
  }

  @Test("powrót w zamrożonym procesie: przed terminem łaski ta sama generacja, po nim nowa mimo zaległego ticka")
  func returnAfterFrozenGrace() async throws {
    let rig = try await Rig.make(.irohOnly)
    await rig.runtime.scene(.active)
    let old = try await rig.ready()
    await rig.runtime.scene(.background)
    try await rig.settle()
    // Proces stał 3 s: zegar ścienny poszedł, sen terminu łaski się nie skończył.
    rig.frozen.pass(.seconds(3))
    await rig.runtime.scene(.active)
    let same = try await rig.ready()
    #expect(same.number == old.number)

    await rig.runtime.scene(.background)
    try await rig.settle()
    rig.frozen.pass(.seconds(20))
    await rig.runtime.scene(.active)
    let next = try await rig.ready()
    #expect(next.number == old.number + 1, "powrót po terminie łaski nie oddaje starej generacji")
    try await rig.request(on: next)
    #expect(rig.fake.endpoints.count == 2)  // rebindOnReturn: stary endpoint zamknięty, nowy związany
    try await rig.expectShutdownClean()
  }

  @Test("czas systemu w tle: backgroundTimeReleased czeka do zamknięcia generacji, wygaśnięcie zamyka ją od razu")
  func backgroundTimeExpiredClosesGrace() async throws {
    let rig = try await Rig.make(.irohOnly)
    await rig.runtime.scene(.active)
    let old = try await rig.ready()
    await rig.runtime.backgroundTimeReleased()  // na wierzchu wraca od razu
    await rig.runtime.scene(.background)
    let released = Recorder<Bool>()
    let waiting = Task {
      await rig.runtime.backgroundTimeReleased()
      released.append(true)
    }
    try await rig.settle()
    #expect(released.all.isEmpty, "generacja w łasce trzyma czas systemu")
    await rig.runtime.backgroundTimeExpired()
    await waiting.value
    #expect(await rig.runtime.machineState == .idle)
    #expect(rig.clock.now < TunnelMachine.backgroundGrace, "zamknięcie przed terminem łaski")
    try await rig.expectSteady("po wygaśnięciu")
    await rig.runtime.scene(.active)
    let next = try await rig.ready()
    #expect(next.number == old.number + 1)
    try await rig.expectShutdownClean()
  }

  @Test("czas systemu w tle: retire w tle trzyma czas do końca zamykania generacji, nie do stanu retired")
  func retireInBackgroundHoldsTimeUntilTeardown() async throws {
    let rig = try await Rig.make(.irohOnly)
    await rig.runtime.scene(.active)
    let old = try await rig.ready()
    await rig.runtime.scene(.background)
    #expect(old.ticket.begin())  // żądanie w locie: zamykanie czeka na opróżnienie biletu
    let released = Recorder<Bool>()
    let waiting = Task {
      await rig.runtime.backgroundTimeReleased()
      released.append(true)
    }
    try await rig.settle()
    await rig.runtime.retire()
    try await rig.settleIgnoringDrain()
    #expect(await rig.runtime.machineState == .retired)
    #expect(released.all.isEmpty, "zamykanie generacji po retire trwa, czas systemu zostaje")
    old.ticket.end()
    await waiting.value
    #expect(await rig.runtime.counters.clients == 0)
    try await rig.expectShutdownClean()
  }

  /// Wspólna sekwencja: generacja na pierwszym planie, praca w tle `needsServer` na tej samej generacji, koniec
  /// pracy po terminie łaski zamyka generację przy trzymanym żądaniu (bilet), powrót na pierwszy plan
  /// w trakcie zamykania.
  static func returnDuringClosing(_ rig: Rig) async throws -> (old: TunnelGeneration, next: TunnelGeneration) {
    await rig.runtime.scene(.active)
    let old = try await rig.ready()
    #expect(old.choice == .iroh)
    await rig.runtime.backgroundWorkStarted(.init(1), expiresAt: rig.now + .seconds(30))
    await rig.runtime.scene(.background)
    let during = try await rig.ready()
    #expect(during.number == old.number)  // praca bez widocznego ekranu idzie starą generacją
    try await rig.request(on: during)
    // Praca dłuższa niż łaska: jej koniec zamyka generację.
    try await rig.advance(by: TunnelMachine.backgroundGrace + .seconds(1), settling: true)

    #expect(old.ticket.begin())  // żądanie w locie trzyma bilet
    let served = rig.served.all.count
    await rig.runtime.backgroundWorkFinished(.init(1))
    #expect(!old.ticket.begin())  // od początku zamykania nic nie startuje na tym kliencie
    try await until("nasłuch i połączenie zamknięte przed opróżnieniem biletu") {
      rig.fake.counters.listeners == 0 && rig.fake.counters.connections == 0
    }
    // Bilet nieopróżniony i termin nie minął: klient jeszcze nie unieważniony (błąd sieci, nie `.cancelled`).
    let early = await Self.version(old.client)
    #expect(early != .cancelled && early != nil)
    #expect(await rig.runtime.counters.clients == 1)
    #expect(rig.served.all.count == served)  // po zamknięciu biletu żadne żądanie nie doszło do serwera

    await rig.runtime.scene(.active)
    let back = Task { await rig.runtime.generation() }
    try await rig.settleIgnoringDrain()
    if case .closing = await rig.runtime.machineState {} else {
      Issue.record("maszyna nie czeka w zamykaniu: \(await rig.runtime.machineState)")
    }
    rig.clock.advance(by: TunnelRuntime.drainDeadline)
    guard case let .ready(next) = await back.value else {
      Issue.record("powrót bez generacji")
      throw CancellationError()
    }
    #expect(await Self.version(old.client) == .cancelled)  // unieważniony po terminie opróżnienia
    old.ticket.end()
    try await rig.settle()
    try await rig.expectSteady("po powrocie")
    return (old, next)
  }

  @Test("błąd w trakcie iteracji SSE przy zamknięciu generacji → .offline; klient unieważniony po opróżnieniu")
  func sseErrorOnClose() async throws {
    let rig = try await Rig.make(.irohOnly)
    await rig.runtime.scene(.active)
    let generation = try await rig.ready()
    #expect(generation.ticket.begin())
    let stream = try await generation.client.openStream(.global)
    var iterator = stream.makeAsyncIterator()
    #expect(try await iterator.next() == .comment(" ping"))
    await rig.runtime.networkChanged()
    var failure: (any Error)?
    do {
      while try await iterator.next() != nil {}
    } catch {
      failure = error
    }
    generation.ticket.end()
    guard let error = failure as? TransportError, case .offline = error else {
      Issue.record("oczekiwany .offline, jest \(String(describing: failure))")
      return
    }
    try await rig.settle()
    #expect(await Self.version(generation.client) == .cancelled)
    try await rig.expectSteady("po zamknięciu")
    try await rig.expectShutdownClean()
  }

  @Test("5 kolejnych nieudanych sond: po każdej zero nasłuchów, połączeń i sesji próby, użytkownicy lease bez zmian")
  func fiveFailedProbes() async throws {
    var script = FakeTunnelScript()
    script.probeFails = { _ in true }
    let rig = try await Rig.make(.irohOnly, script: script)
    await rig.runtime.scene(.active)
    let users = await rig.lease.userCount
    for attempt in 0 ..< 5 {
      let outcome = await rig.runtime.generation()
      guard case .offline = outcome else {
        Issue.record("próba \(attempt): oczekiwane .offline, jest \(outcome)")
        return
      }
      try await rig.settle()
      try await until("próba \(attempt): zero nasłuchów, połączeń i sesji") {
        let counters = rig.fake.counters
        return counters.listeners == 0 && counters.connections == 0 && counters.sessions == 0 && counters.pairs == 0
      }
      #expect(await rig.runtime.counters.connections == 0)
      #expect(await rig.runtime.counters.clients == 0)
      #expect(await rig.lease.userCount == users)
      #expect(rig.fake.counters.endpointsPeak == 1)
      // Pamięć porażki iroh (2 min) bez HTTPS: następna próba dopiero po terminie.
      try await rig.advance(by: TunnelMachine.irohRetryDelay + .seconds(2), settling: true)
    }
    #expect(rig.fake.counters.probes >= 5)
    #expect(rig.fake.endpoints.count == 2)  // po 3 porażkach endpoint zepsuty i związany od nowa
    try await rig.expectShutdownClean()
  }

  @Test("tylko-iroh na wierzchu: connect po 22 s daje gotową generację w budżecie 30 s")
  func a2SlowConnectWithinBudget() async throws {
    var script = FakeTunnelScript()
    script.connect = { _ in .late(.seconds(22)) }
    let rig = try await Rig.make(.irohOnly, script: script)
    await rig.runtime.scene(.active)
    let outcome = Task { await rig.runtime.generation() }
    try await until("connect w toku") { rig.fake.endpoints.first?.targets.count == 1 }
    try await rig.advance(by: .seconds(22), settling: false)
    guard case let .ready(generation) = await outcome.value else {
      Issue.record("generacja nie gotowa po 22 s: \(await rig.runtime.machineState)")
      return
    }
    try await rig.request(on: generation)
    #expect(!rig.log.all.contains { $0.contains("late connection") })
    try await rig.expectShutdownClean()
  }

  @Test("tylko-iroh na wierzchu: connect po 35 s → late connection zamknięte raz, następna próba z serii")
  func a2LateConnectionAfterBudget() async throws {
    var script = FakeTunnelScript()
    script.connect = { $0 == 0 ? .late(.seconds(35)) : .immediate }
    let rig = try await Rig.make(.irohOnly, script: script)
    await rig.runtime.scene(.active)
    let outcome = Task { await rig.runtime.generation() }
    try await until("connect w toku") { rig.fake.endpoints.first?.targets.count == 1 }
    try await rig.advance(by: .seconds(20), settling: false)
    guard case .opening = await rig.runtime.machineState else {
      Issue.record("po 20 s próba już skończona: \(await rig.runtime.machineState)")
      return
    }
    try await rig.advance(by: .seconds(10), settling: false)
    guard case .offline = await outcome.value else {
      Issue.record("po budżecie 30 s czekający bez .offline")
      return
    }
    try await rig.advance(by: .seconds(5), settling: false)
    try await rig.settle()
    try await until("spóźnione połączenie zamknięte") { rig.fake.counters.connections == 0 }
    #expect(await rig.runtime.counters.connections == 0)
    #expect(rig.log.all.filter { $0.contains("late connection") }.count == 1)
    // The pause after the failure at 30 s is the first of the series (1 s), long over by now.
    let generation = try await rig.ready()
    try await rig.request(on: generation)
    #expect(rig.fake.endpoints.count == 1)
    #expect(rig.fake.endpoints.first?.targets.count == 2)
    try await rig.expectShutdownClean()
  }

  @Test("tylko-iroh z otwartymi drzwiami: trzy porażki generacji w 60 s nie wiążą endpointu od nowa, drzwi żyją")
  func a3FailureSeriesKeepsDoor() async throws {
    var script = FakeTunnelScript()
    script.probeFails = { _ in true }
    let rig = try await Rig.make(.irohOnly, script: script)
    await rig.runtime.scene(.active)
    let door = try await rig.runtime.openUploadDoor(budget: .seconds(15))
    for attempt in 0 ..< 3 {
      guard case .offline = await rig.runtime.generation() else {
        Issue.record("próba \(attempt): oczekiwane .offline")
        return
      }
      try await rig.settle()
      try await rig.advance(by: .seconds(5), settling: true)
    }
    #expect(rig.fake.endpoints.count == 1, "bez rebind(.broken)")
    #expect(rig.fake.endpoints.first?.targets.count == 4, "połączenie drzwi i trzy próby generacji")
    #expect(rig.closedUsers.all.isEmpty)
    #expect(await rig.runtime.counters.doors == 1)
    #expect(door.ticket.begin())
    _ = try await door.client.perform(APIRequest(method: "POST", path: "/api/upload", body: Data("zdjęcie".utf8)))
    door.ticket.end()
    try await rig.expectShutdownClean()
  }

  @Test("closeTakes(.never): endpointów nigdy więcej niż jeden, zero po zwolnieniu i shutdown")
  func closeNeverReturns() async throws {
    var script = FakeTunnelScript()
    script.endpointClose = { _ in .never }
    let rig = try await Rig.make(.irohOnly, script: script)
    await rig.runtime.scene(.active)
    _ = try await rig.ready()
    for cycle in 0 ..< 4 {
      await rig.runtime.scene(.background)
      try await rig.advance(by: TunnelMachine.backgroundGrace + .seconds(1), settling: false)
      await rig.runtime.scene(.active)
      let outcome = Task { await rig.runtime.generation() }
      try await rig.advance(by: TunnelMachine.irohOnlyAttemptBudget + .seconds(1), settling: false)
      if case .ready = await outcome.value { Issue.record("cykl \(cycle): generacja mimo wiszącego close") }
      #expect(rig.fake.counters.endpointsPeak == 1)
      #expect(rig.fake.counters.bindStarted.values.reduce(0, +) == 1)
      try await rig.advance(by: TunnelMachine.irohRetryDelay, settling: false)
    }
    rig.fake.releaseHanging()
    try await until("endpoint zamknięty po zwolnieniu") { rig.fake.counters.endpointsAlive == 0 }
    #expect(rig.fake.counters.endpointsPeak == 1)
    try await rig.expectShutdownClean()
  }

  @Test("bindTakes(.never): jedno niezakończone bind, endpointów nigdy więcej niż jeden, zero po shutdown")
  func bindNeverReturns() async throws {
    var script = FakeTunnelScript()
    script.bind = { _ in .never }
    let rig = try await Rig.make(.irohOnly, script: script)
    await rig.runtime.scene(.active)
    for cycle in 0 ..< 4 {
      let outcome = Task { await rig.runtime.generation() }
      try await rig.advance(by: TunnelMachine.irohOnlyAttemptBudget + .seconds(1), settling: false)
      if case .ready = await outcome.value { Issue.record("cykl \(cycle): generacja mimo wiszącego bind") }
      let counters = rig.fake.counters
      #expect(counters.bindStarted.values.reduce(0, +) == 1)
      #expect(counters.bindsInFlightPeak.values.allSatisfy { $0 <= 1 })
      #expect(counters.endpointsAlive == 0)
      try await rig.advance(by: TunnelMachine.irohRetryDelay, settling: false)
    }
    rig.fake.releaseHanging()
    try await until("bind zakończone") { rig.fake.counters.bindsSettled }
    #expect(rig.fake.counters.endpointsPeak == 0)
    try await rig.expectShutdownClean()
  }

  @Test("praca w tle z connect opóźnionym o 11 s → generacja gotowa przed terminem pracy")
  func backgroundWorkWithSlowConnect() async throws {
    var script = FakeTunnelScript()
    script.connect = { _ in .delay(.seconds(11)) }
    let rig = try await Rig.make(.irohOnly, script: script)
    await rig.runtime.scene(.background)
    let expires = rig.now + .seconds(25)
    await rig.runtime.backgroundWorkStarted(.init(7), expiresAt: expires)
    try await until("connect w toku") { rig.fake.endpoints.first?.targets.count == 1 }
    try await rig.advance(by: .seconds(11), settling: false)
    try await rig.settle()
    guard case .backgroundWork = await rig.runtime.machineState else {
      Issue.record("generacja nie gotowa: \(await rig.runtime.machineState)")
      return
    }
    #expect(rig.now < expires)
    let generation = try await rig.ready()
    try await rig.request(on: generation)
    await rig.runtime.backgroundWorkFinished(.init(7))
    try await rig.settle()
    try await rig.expectSteady("po pracy")
    #expect(rig.fake.counters.endpointsAlive == 0)  // rebindOnReturn: endpoint zamknięty po pracy w tle
    try await rig.expectShutdownClean()
  }

  @Test("spóźniony wynik po retire zamknięty; stary runtime po retire nie otwiera generacji")
  func lateResultAfterRetire() async throws {
    var script = FakeTunnelScript()
    script.connect = { _ in .late(.seconds(5)) }
    let rig = try await Rig.make(.irohOnly, script: script)
    await rig.runtime.scene(.active)
    let outcome = Task { await rig.runtime.generation() }
    try await until("connect w toku") { rig.fake.endpoints.first?.targets.count == 1 }
    await rig.runtime.retire()
    guard case .cancelled = await outcome.value else {
      Issue.record("czekający po retire bez .cancelled")
      return
    }
    try await rig.advance(by: .seconds(5), settling: false)
    try await rig.settle()
    try await until("spóźnione połączenie zamknięte") { rig.fake.counters.connections == 0 }
    #expect(await rig.runtime.counters.connections == 0)
    guard case .cancelled = await rig.runtime.generation() else {
      Issue.record("popyt po retire bez .cancelled")
      return
    }
    try await rig.advance(by: .seconds(30), settling: true)
    #expect(rig.fake.endpoints.first?.targets.count == 1)  // zero nowych prób
    #expect(rig.fake.counters.bindStarted.values.reduce(0, +) == 1)
    await #expect(throws: TunnelFailure.self) { try await rig.runtime.openUploadDoor(budget: .seconds(15)) }
    try await rig.expectShutdownClean()
  }

  @Test("drzwi uploadu: własne połączenie i klient, zamknięcie nie rusza generacji; anulowanie zamyka spóźnione")
  func uploadDoor() async throws {
    var script = FakeTunnelScript()
    script.connect = { $0 == 2 ? .late(.seconds(3)) : .immediate }
    let rig = try await Rig.make(.irohOnly, script: script)
    await rig.runtime.scene(.active)
    let generation = try await rig.ready()
    let door = try await rig.runtime.openUploadDoor(budget: .seconds(15))
    #expect(door.ticket.begin())
    _ = try await door.client.perform(APIRequest(method: "POST", path: "/api/upload", body: Data("zdjęcie".utf8)))
    door.ticket.end()
    #expect(rig.fake.counters.connections == 2)
    #expect(await rig.runtime.counters.doors == 1)
    await door.close(1)
    #expect(rig.fake.liveConnections.count == 1)
    #expect(rig.fake.counters.listeners == 1)
    #expect(await Self.version(door.client) == .cancelled)
    try await rig.request(on: generation)  // generacja główna nietknięta

    let cancelled = Task { try await rig.runtime.openUploadDoor(budget: .seconds(15)) }
    try await until("connect drzwi w toku") { rig.fake.endpoints.first?.targets.count == 3 }
    cancelled.cancel()
    await #expect(throws: CancellationError.self) { try await cancelled.value }
    try await rig.advance(by: .seconds(3), settling: false)
    try await rig.settle()
    try await until("spóźnione połączenie drzwi zamknięte") { rig.fake.counters.connections == 1 }
    #expect(await rig.runtime.counters.doors == 0)

    _ = try await rig.runtime.openUploadDoor(budget: .seconds(15))  // otwarte drzwi zamyka shutdown
    try await rig.expectShutdownClean()
  }

  @Test("drzwi z wiszącym żądaniem: shutdown w trakcie door.close(1) wraca po końcu zamykania, lease.release przed shutdown")
  func shutdownDuringDoorClose() async throws {
    let rig = try await Rig.make(.irohOnly)
    let door = try await rig.runtime.openUploadDoor(budget: .seconds(15))
    #expect(door.ticket.begin())  // żądanie w locie: bilet nieopróżniony
    let closing = Task { await door.close(1) }
    try await until("połączenie drzwi zamknięte") { rig.fake.counters.connections == 0 }
    try await rig.settleIgnoringDrain()  // zamykanie czeka na termin opróżnienia biletu

    let afterShutdown = Recorder<TunnelRuntime.Counters>()
    let shutdown = Task {
      await rig.runtime.shutdown()
      afterShutdown.append(await rig.runtime.counters)
    }
    try await rig.settleIgnoringDrain()
    #expect(afterShutdown.all.isEmpty, "shutdown wrócił przed końcem zamykania drzwi")
    rig.clock.advance(by: TunnelRuntime.drainDeadline)
    await shutdown.value
    await closing.value
    #expect(afterShutdown.all == [TunnelRuntime.Counters()])
    // Dzierżawa przy shutdown nie ma już użytkownika drzwi, więc nie zamyka niczyich połączeń.
    #expect(rig.closedUsers.all.isEmpty, "użytkownicy przy shutdown dzierżawy: \(rig.closedUsers.all)")
    door.ticket.end()
    try await rig.expectShutdownClean()
  }

  @Test("drugie door.close w trakcie pierwszego dołącza do tego samego zamykania i wraca po jego końcu")
  func secondDoorCloseJoins() async throws {
    let rig = try await Rig.make(.irohOnly)
    let door = try await rig.runtime.openUploadDoor(budget: .seconds(15))
    #expect(door.ticket.begin())
    let first = Task { await door.close(1) }
    try await until("połączenie drzwi zamknięte") { rig.fake.counters.connections == 0 }
    try await rig.settleIgnoringDrain()

    let afterSecond = Recorder<TunnelRuntime.Counters>()
    let second = Task {
      await door.close(1)
      afterSecond.append(await rig.runtime.counters)
    }
    try await rig.settleIgnoringDrain()
    #expect(afterSecond.all.isEmpty, "drugie close wróciło przed końcem pierwszego")
    rig.clock.advance(by: TunnelRuntime.drainDeadline)
    await second.value
    await first.value
    let counters = afterSecond.all.first
    #expect(counters?.doors == 0 && counters?.clients == 0, "\(String(describing: counters))")
    #expect(await Self.version(door.client) == .cancelled)
    door.ticket.end()
    try await rig.expectShutdownClean()
  }

  @Test("anulowany upload zamyka połączenie drzwi kodem 1, zwykłe zamknięcie generacji kodem 0")
  func closeCodes() async throws {
    let rig = try await Rig.make(.irohOnly)
    await rig.runtime.scene(.active)
    _ = try await rig.ready()
    let generationConnections = rig.fake.liveConnections
    #expect(generationConnections.count == 1)
    _ = try await rig.runtime.openUploadDoor(budget: .seconds(15))
    let door = try await rig.runtime.openUploadDoor(budget: .seconds(15))
    let opened = rig.fake.liveConnections
    #expect(opened.count == 3)
    // Drzwi zamykane kodem 1 to ostatnie otwarte połączenie atrapy.
    let doorConnection = opened.filter { connection in
      !generationConnections.contains { $0 === connection }
    }
    await door.close(1)
    let closedByDoor = doorConnection.filter(\.isClosed)
    #expect(closedByDoor.count == 1)
    #expect(closedByDoor.first?.closedByApp?.code == 1)
    #expect(closedByDoor.first?.closedByApp?.reason == "upload cancelled")

    await rig.runtime.networkChanged()
    try await rig.settle()
    #expect(generationConnections.first?.closedByApp?.code == 0)
    #expect(generationConnections.first?.closedByApp?.reason == "generation closed")
    try await rig.expectShutdownClean()
    // Drzwi zamknięte przez shutdown (koniec, nie anulowanie) też kodem 0.
    let closedByShutdown = doorConnection.filter { $0 !== closedByDoor.first }
    #expect(closedByShutdown.first?.closedByApp?.code == 0)
  }

  /// `GET /api/version` na kliencie: `nil` = odpowiedź, inaczej błąd.
  static func version(_ client: RarogClient) async -> TransportError? {
    do {
      _ = try await client.perform(.get("/api/version"))
      return nil
    } catch {
      return error
    }
  }
}

// MARK: - Stanowisko

/// Runtime z atrapą tunelu, dzierżawą i zegarem sztucznym; serwer atrapy odpowiada HTTP.
struct Rig {
  enum Routes { case irohOnly, both }

  static let relay = URL(string: "https://relay.example/")!
  static let target = TunnelTarget(endpointId: String(repeating: "ab", count: 32), relay: relay)
  static let secret = Data(repeating: 9, count: 32)

  let clock: FakeTunnelClock
  let fake: FakeTunnelTransport
  let lease: EndpointLease
  let runtime: TunnelRuntime
  let base: ContinuousClock.Instant
  let served: Recorder<String>
  let log: Recorder<String>
  /// Niepuste listy użytkowników, których połączenia dzierżawa kazała zamknąć przed `close()` endpointu.
  let closedUsers: Recorder<[LeaseUser]>
  /// Czas runtime'u ponad zegarem sztucznym: proces zamrożony przez system (sny stoją, czas ścienny idzie).
  let frozen: FrozenTime
  /// Port of the HTTPS route's fake server (`MockURLProtocol`); `nil` without an HTTPS route.
  let httpsPort: Int?

  var now: ContinuousClock.Instant { base + clock.now + frozen.passed }

  static func make(_ routes: Routes, script: FakeTunnelScript = FakeTunnelScript(),
                   scene: TunnelMachine.Scene = .inactive,
                   works: [TunnelMachine.WorkID: ContinuousClock.Instant] = [:],
                   readiness: LeaseReadiness = .ready, httpsAnswers: Bool = true,
                   httpsHangs: Bool = false) async throws -> Rig {
    let clock = FakeTunnelClock()
    let served = Recorder<String>()
    let log = Recorder<String>()
    let closedUsers = Recorder<[LeaseUser]>()
    var script = script
    script.server = .http { request in
      served.append("\(request.method) \(request.path)")
      if request.path == "/api/stream" {
        // Kodowanie `chunked` jak serwer Raroga: urwane połączenie to błąd, nie koniec ciała.
        let headers = [("Content-Type", "text/event-stream"), ("Transfer-Encoding", "chunked")]
        return FakeHTTPResponse(headers: headers) { stream in
          try await stream.write(Data("8\r\n: ping\n\n\r\n".utf8))
          _ = try await stream.readToEnd()
        }
      }
      return .json(200, #"{"ok":true}"#)
    }
    let fake = FakeTunnelTransport(clock: clock, script: script)
    let box = RuntimeBox()
    let lease = EndpointLease(
      transport: fake,
      identity: { LeaseIdentity(secretKey: secret, homeRelay: relay) },
      clock: FakeLeaseClock(fake: clock),
      closeUsers: { users in
        closedUsers.append(users)
        await box.runtime?.closeUsers(users)
      },
      onReadiness: { readiness in box.runtime?.leaseChanged(readiness) },
      log: { log.append($0) })
    let base = ContinuousClock.now
    let frozen = FrozenTime()
    // The HTTPS route answers every request with 200, fails every one like an unreachable host, or (`httpsHangs`)
    // never answers, like a server that accepts the connection and stalls.
    let httpsPort = routes == .both
      ? MockURLProtocol.register { _ in
        if httpsHangs { return .held }
        return httpsAnswers ? .json(200, #"{"ok":true}"#) : MockURLProtocol.Reply(error: URLError(.cannotFindHost))
      }
      : nil
    let https = httpsPort.map { port in
      let configuration = URLSessionConfiguration.ephemeral
      configuration.protocolClasses = [MockURLProtocol.self]
      return RarogClient(config: .test(port: port), configuration: configuration)
    }
    let runtime = TunnelRuntime(
      target: target, httpsClient: https, lease: lease,
      makeClient: { url in
        RarogClient(config: RarogConfig(baseURL: url, origin: IrohWire.origin, clientLabel: "test·Rarog", build: 1))
      },
      timing: .init(now: { base + clock.now + frozen.passed }, sleep: clock.sleep),
      proxyCounters: fake.proxyCounters,
      scene: scene, works: works, readiness: readiness,
      log: { log.append($0) })
    box.set(runtime)
    return Rig(clock: clock, fake: fake, lease: lease, runtime: runtime, base: base, served: served, log: log,
               closedUsers: closedUsers, frozen: frozen, httpsPort: httpsPort)
  }

  /// Generacja gotowa dla żądania.
  func ready(sourceLocation: SourceLocation = #_sourceLocation) async throws -> TunnelGeneration {
    let outcome = await runtime.generation()
    guard case let .ready(generation) = outcome else {
      Issue.record("oczekiwana generacja, jest \(outcome)", sourceLocation: sourceLocation)
      throw CancellationError()
    }
    return generation
  }

  /// Żądanie przez generację między `begin()` i `end()` biletu.
  func request(on generation: TunnelGeneration, sourceLocation: SourceLocation = #_sourceLocation) async throws {
    #expect(generation.ticket.begin(), sourceLocation: sourceLocation)
    defer { generation.ticket.end() }
    _ = try await generation.client.perform(.get("/api/version"))
  }

  /// Runtime bez pracy w toku i dzierżawa bez operacji natywnych (dwa odczyty z rzędu).
  func settle(sourceLocation: SourceLocation = #_sourceLocation) async throws {
    try await eventually("runtime bez pracy", sourceLocation: sourceLocation) {
      guard await runtime.busyTasks == 0, await lease.unfinishedNativeOperations == 0 else { return false }
      try? await Task.sleep(for: .milliseconds(3))
      let busy = await runtime.busyTasks
      let native = await lease.unfinishedNativeOperations
      return busy == 0 && native == 0
    }
  }

  /// Jak `settle`, ale zamykanie może czekać na termin opróżnienia biletu (sen na zegarze sztucznym).
  func settleIgnoringDrain(sourceLocation: SourceLocation = #_sourceLocation) async throws {
    try await eventually("runtime czeka tylko na termin", sourceLocation: sourceLocation) {
      let sleepers = clock.sleepers
      try? await Task.sleep(for: .milliseconds(20))
      let native = await lease.unfinishedNativeOperations
      return clock.sleepers == sleepers && native == 0
    }
  }

  /// Czas naprzód krokami po 250 ms; z `settling` po każdym kroku runtime dochodzi do spoczynku.
  func advance(by total: Duration, settling: Bool) async throws {
    var left = total
    let step: Duration = .milliseconds(250)
    while left > .zero {
      let next = min(step, left)
      clock.advance(by: next)
      left -= next
      if settling { try await settle() } else { await Task.yield() }
      if !settling { try? await Task.sleep(for: .milliseconds(1)) }
    }
  }

  /// Stan ustalony: poza żywą generacją zero połączeń, nasłuchów, par i sesji; endpointów najwyżej jeden.
  func expectSteady(_ label: String, sourceLocation: SourceLocation = #_sourceLocation) async throws {
    let live: Bool = switch await runtime.machineState {
    case .ready, .backgroundGrace, .backgroundWork: true
    default: false
    }
    let limit = live ? 1 : 0
    try await until("\(label): stan ustalony", sourceLocation: sourceLocation) {
      let counters = fake.counters
      return counters.connections <= limit && counters.listeners <= limit && (live || counters.sessions == 0)
        && (live || counters.pairs == 0)
    }
    let counters = fake.counters
    #expect(counters.endpointsAlive <= 1, "\(label)", sourceLocation: sourceLocation)
    #expect(counters.endpointsPeak <= 1, "\(label)", sourceLocation: sourceLocation)
    #expect(counters.bindsInFlightPeak.values.allSatisfy { $0 <= 1 }, "\(label)", sourceLocation: sourceLocation)
    let own = await runtime.counters
    #expect(own.connections <= limit && own.clients <= limit, "\(label): \(own)", sourceLocation: sourceLocation)
  }

  /// Po `shutdown()` wszystkie liczniki są zerem.
  func expectShutdownClean(sourceLocation: SourceLocation = #_sourceLocation) async throws {
    await runtime.shutdown()
    try await until("zero sesji po shutdown", sourceLocation: sourceLocation) { fake.counters.sessions == 0 }
    let counters = fake.counters
    #expect(counters.endpointsAlive == 0, sourceLocation: sourceLocation)
    #expect(counters.connections == 0, sourceLocation: sourceLocation)
    #expect(counters.listeners == 0, sourceLocation: sourceLocation)
    #expect(counters.pairs == 0, sourceLocation: sourceLocation)
    #expect(counters.bindsSettled, sourceLocation: sourceLocation)
    #expect(counters.hanging == 0, sourceLocation: sourceLocation)
    #expect(await runtime.counters == TunnelRuntime.Counters(), sourceLocation: sourceLocation)
    #expect(await lease.unfinishedNativeOperations == 0, sourceLocation: sourceLocation)
  }
}

/// Czas, który minął, gdy proces stał: przesuwa chwilę runtime'u bez budzenia snów zegara sztucznego.
final class FrozenTime: Sendable {
  private let offset = Mutex<Duration>(.zero)
  var passed: Duration { offset.withLock { $0 } }
  func pass(_ duration: Duration) { offset.withLock { $0 += duration } }
}

/// Runtime dla domknięć dzierżawy, które powstają przed nim.
final class RuntimeBox: Sendable {
  private let state = Mutex<TunnelRuntime?>(nil)
  var runtime: TunnelRuntime? { state.withLock { $0 } }
  func set(_ runtime: TunnelRuntime) { state.withLock { $0 = runtime } }
}

/// Zegar dzierżawy na czasie ``FakeTunnelClock``: ten sam czas co maszyna i proxy.
struct FakeLeaseClock: Clock {
  struct Instant: InstantProtocol {
    var offset: Duration
    func advanced(by duration: Duration) -> Instant { Instant(offset: offset + duration) }
    func duration(to other: Instant) -> Duration { other.offset - offset }
    static func < (lhs: Instant, rhs: Instant) -> Bool { lhs.offset < rhs.offset }
  }

  let fake: FakeTunnelClock
  var now: Instant { Instant(offset: fake.now) }
  var minimumResolution: Duration { .zero }

  func sleep(until deadline: Instant, tolerance: Duration?) async throws {
    try await fake.sleep(for: deadline.offset - fake.now)
  }
}

/// Generator z ziarnem: ten sam przebieg cykli przy każdym uruchomieniu.
struct SplitMix64: RandomNumberGenerator {
  private var state: UInt64
  init(seed: UInt64) { state = seed }

  mutating func next() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var z = state
    z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
    z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
    return z ^ (z >> 31)
  }

  /// Odstęp 0–3 s co 250 ms.
  mutating func gap() -> Duration {
    .milliseconds(Int(next() % 13) * 250)
  }
}

/// Czeka w czasie rzeczywistym (do `limit`) na warunek asynchroniczny; po terminie zgłasza porażkę.
func eventually(
  _ what: String,
  limit: Duration = .seconds(10),
  sourceLocation: SourceLocation = #_sourceLocation,
  _ condition: () async -> Bool
) async throws {
  let deadline = ContinuousClock.now + limit
  while !(await condition()) {
    guard ContinuousClock.now < deadline else {
      Issue.record("nie doczekano: \(what)", sourceLocation: sourceLocation)
      return
    }
    try await Task.sleep(for: .milliseconds(2))
  }
}

// MARK: - Server restart with the app in the foreground

extension TunnelRuntimeTests {
  /// The measured restart on the runtime with the real lease: generation 1 over iroh, the server closes the connection
  /// at 10 s, the next `connect` (restart window) hangs past the attempt budget, every HTTPS request fails (Tailscale
  /// off), and a consumer asks for a generation like the SSE supervisor (1 s doubling to 8 s after each failed stream).
  @Test("server restart in the foreground, HTTPS and iroh, HTTPS dead: the failed HTTPS probe ends the iroh pause, iroh is back within 40 s on the same endpoint")
  func serverRestartInForeground() async throws {
    var script = FakeTunnelScript()
    script.connect = { $0 == 1 ? .delay(.seconds(600)) : .immediate }
    let rig = try await Rig.make(.both, script: script, httpsAnswers: false)
    var trace = RestartTrace()
    await rig.runtime.scene(.active)
    let first = try await rig.ready()
    #expect(first.choice == .iroh)
    try await rig.advance(by: .seconds(10), settling: true)
    await trace.observe(rig, note: "server closes its endpoint (restart)")
    rig.fake.dropConnections(reason: "closed by peer: 0")
    try await rig.settleIgnoringDrain()
    await trace.observe(rig)

    let outcomes = Recorder<TunnelGenerationOutcome>()
    var delay: Duration = .seconds(1)
    // Next request of the consumer; `nil` while it waits for an answer or holds an open iroh stream.
    var next: Duration? = rig.clock.now + .milliseconds(500)
    var waiting = false
    var irohBack: Duration?
    while rig.clock.now < .seconds(60), irohBack == nil {
      let answered = outcomes.all
      if waiting, answered.count == trace.answers + 1, let last = answered.last {
        waiting = false
        trace.answers = answered.count
        await trace.observe(rig, note: "answer: \(Self.describe(last))")
        if case let .ready(generation) = last, generation.choice == .iroh {
          irohBack = rig.clock.now
          next = nil  // the stream stays open
        } else {
          // HTTPS generation: the stream request fails (Tailscale off); offline: no generation.
          next = rig.clock.now + delay
          delay = min(delay * 2, .seconds(8))
        }
      }
      if !waiting, let due = next, rig.clock.now >= due {
        waiting = true
        next = nil
        let runtime = rig.runtime
        Task { outcomes.append(await runtime.generation()) }
        try await rig.settleIgnoringDrain()
        await trace.observe(rig, note: "consumer asks for a generation")
        continue
      }
      rig.clock.advance(by: .milliseconds(500))
      try await rig.settleIgnoringDrain()
      await trace.observe(rig)
    }
    try await rig.settle()
    let timeline = trace.lines.joined(separator: "\n")

    #expect(irohBack.map { $0 <= .seconds(40) } == true, "iroh ready at \(String(describing: irohBack))\n\(timeline)")
    guard case .ready(_, .iroh) = await rig.runtime.machineState else {
      Issue.record("not ready over iroh\n\(timeline)")
      try await rig.expectShutdownClean()
      return
    }
    #expect(rig.log.all.contains("tunnel: generation 2 (iroh) failed: attempt budget elapsed"), "\(timeline)")
    #expect(rig.log.all.contains("tunnel: generation 3 (https) failed: probe: transport error"), "\(timeline)")
    let binds = rig.fake.counters.bindStarted.values.reduce(0, +)
    #expect(binds == 1, "the endpoint from before the restart reconnects\n\(timeline)")
    try await rig.expectShutdownClean()
  }

  @Test("HTTPS and iroh, HTTPS answers: after a failed iroh attempt the HTTPS generation passes the probe and stays for 5 min")
  func httpsProbeReadyStays() async throws {
    var script = FakeTunnelScript()
    script.connect = { _ in .fail(.connectFailed("test")) }
    let rig = try await Rig.make(.both, script: script)
    await rig.runtime.scene(.active)
    let failed = Task { await rig.runtime.generation() }
    try await rig.settle()
    if case .ready = await failed.value { Issue.record("the iroh attempt should fail") }
    try await rig.advance(by: .seconds(2), settling: true)
    let https = try await rig.ready()
    #expect(https.choice == .https)
    let port = try #require(rig.httpsPort)
    #expect(MockURLProtocol.requests(port: port).map(\.path) == ["/api/version"], "the probe went over HTTPS")
    for _ in 0 ..< 10 {
      rig.clock.advance(by: .seconds(30))
      try await rig.settle()
    }
    let later = try await rig.ready()
    #expect(later.number == https.number)
    #expect(await rig.runtime.machineState == .ready(generation: https.number, choice: .https))
    #expect(rig.fake.endpoints.map(\.targets.count).reduce(0, +) == 1, "no iroh attempt after the first one")
    try await rig.expectShutdownClean()
  }

  @Test("HTTPS and iroh, the HTTPS probe hangs and the scene goes to the background without work: closing the generation cancels the probe request, no busy task is left, shutdown does not wait for the HTTP limit")
  func hungHTTPSProbeInBackground() async throws {
    let hung = try await Self.hungHTTPSProbe()
    let rig = hung.rig
    await rig.runtime.scene(.background)
    await hung.waiter.value
    #expect(hung.outcomes.all.map(Self.describe) == ["offline"])
    // The HTTP limit of the probe request is 10 s (`RarogConfig.requestTimeout`); 2 s leaves room for a busy machine.
    try await eventually("the probe request cancelled", limit: .seconds(2)) {
      MockURLProtocol.held(port: hung.port) == 0
    }
    try await eventually("no busy task", limit: .seconds(2)) { await rig.runtime.busyTasks == 0 }
    await rig.runtime.backgroundTimeReleased()
    let started = ContinuousClock.now
    try await rig.expectShutdownClean()
    let took = ContinuousClock.now - started
    #expect(took < .seconds(2), "shutdown took \(took)")
  }

  @Test("HTTPS and iroh, the HTTPS probe hangs until the attempt budget: the probe request is cancelled, the waiter gets offline once, after the cooldown iroh opens the next generation")
  func hungHTTPSProbeBudget() async throws {
    let hung = try await Self.hungHTTPSProbe()
    let rig = hung.rig
    try await rig.advance(by: TunnelMachine.attemptBudget, settling: false)
    await hung.waiter.value
    #expect(hung.outcomes.all.map(Self.describe) == ["offline"])
    try await eventually("the probe request cancelled", limit: .seconds(2)) {
      MockURLProtocol.held(port: hung.port) == 0
    }
    try await eventually("no busy task", limit: .seconds(2)) { await rig.runtime.busyTasks == 0 }
    #expect(rig.log.all.contains("tunnel: generation \(hung.generation) (https) failed: attempt budget elapsed"))
    // The failed HTTPS attempt ends the iroh pause: after the cooldown the next demand goes to iroh.
    try await rig.advance(by: TunnelMachine.cooldown, settling: true)
    let next = try await rig.ready()
    #expect(next.choice == .iroh)
    #expect(next.number == hung.generation + 1)
    try await rig.settle()
    #expect(await rig.runtime.machineState == .ready(generation: next.number, choice: .iroh))
    #expect(hung.outcomes.all.count == 1, "the waiter of the closed generation is answered once")
    try await rig.expectShutdownClean()
  }

  /// Both routes; the first iroh `connect` fails, and after the cooldown a waiter's HTTPS generation hangs in its
  /// probe: the HTTPS server takes `GET /api/version` and never answers.
  private static func hungHTTPSProbe(
    sourceLocation: SourceLocation = #_sourceLocation
  ) async throws -> (rig: Rig, port: Int, generation: UInt64, waiter: Task<Void, Never>,
                     outcomes: Recorder<TunnelGenerationOutcome>) {
    var script = FakeTunnelScript()
    script.connect = { $0 == 0 ? .fail(.connectFailed("test")) : .immediate }
    let rig = try await Rig.make(.both, script: script, httpsHangs: true)
    let port = try #require(rig.httpsPort, sourceLocation: sourceLocation)
    await rig.runtime.scene(.active)
    let failed = await rig.runtime.generation()
    #expect(Self.describe(failed) == "offline", "the first iroh attempt fails", sourceLocation: sourceLocation)
    try await rig.advance(by: .seconds(2), settling: true)
    let outcomes = Recorder<TunnelGenerationOutcome>()
    let runtime = rig.runtime
    let waiter = Task { outcomes.append(await runtime.generation()) }
    try await eventually("the HTTPS probe hangs", sourceLocation: sourceLocation) {
      guard case let .probing(attempt) = await runtime.machineState, attempt.choice == .https else { return false }
      return MockURLProtocol.held(port: port) == 1
    }
    return (rig, port, await runtime.machineLastGeneration, waiter, outcomes)
  }

  static func describe(_ outcome: TunnelGenerationOutcome) -> String {
    switch outcome {
    case let .ready(generation): "ready g\(generation.number) \(generation.choice)"
    case .offline: "offline"
    case .cancelled: "cancelled"
    }
  }
}

/// Changes seen after each step of the restart test: machine state and lease, endpoint binds, iroh connects, log.
private struct RestartTrace {
  var lines: [String] = []
  var answers = 0
  private var last = ""
  private var logged = 0

  mutating func observe(_ rig: Rig, note: String? = nil) async {
    let at = String(format: "%7.2f  ", Double(rig.clock.now / .milliseconds(1)) / 1000)
    let state = await rig.runtime.machineState
    let lease = await rig.runtime.machineLease
    let binds = rig.fake.counters.bindStarted.values.reduce(0, +)
    let connects = rig.fake.endpoints.map(\.targets.count).reduce(0, +)
    let snapshot = "state \(Self.describe(state)), lease \(lease), binds \(binds), iroh connects \(connects)"
    if let note { lines.append(at + note) }
    let log = rig.log.all
    for line in log.dropFirst(logged) { lines.append(at + "log: " + line) }
    logged = log.count
    if snapshot != last {
      lines.append(at + snapshot)
      last = snapshot
    }
  }

  private static func describe(_ state: TunnelMachine.State) -> String {
    switch state {
    case let .opening(attempt): "opening g\(attempt.generation) \(attempt.choice)"
    case let .probing(attempt): "probing g\(attempt.generation) \(attempt.choice)"
    case let .closing(closing): "closing g\(closing.generation) \(closing.reason)"
    case .cooldown: "cooldown"
    case let .backgroundGrace(gen, choice, _): "backgroundGrace g\(gen) \(choice)"
    default: "\(state)"
    }
  }
}
