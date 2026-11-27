import Foundation
import RarogContract
import RarogCore
@testable import RarogTransport
import RarogTransportTesting
import Synchronization
import XCTest

/// Koordynator tunelu i adapter pracy w tle apki. Pliki apki `TunnelCoordinator.swift`, `BackgroundWorkUIKit.swift`
/// i `AppEnvironment.swift` wchodzą do tego celu testów wprost (wyjątek członkostwa folderu `Rarog`), bo testy UIKit
/// nie mają apki-gospodarza. System zadań w tle i transport iroh to atrapy: bez `UIApplication` i bez sieci.
@MainActor
final class TunnelCoordinatorTests: XCTestCase {
  // MARK: - Adapter pracy w tle

  func testExpiryFromSystemReportsExpiredForServerWork() {
    let system = FakeBackgroundSystem()
    let observer = RecordingWorkObserver()
    let work = UIKitBackgroundWork(system: system.system, observer: observer)
    let token = work.begin("rarog.live-activity", needsServer: true)
    XCTAssertNotNil(token)
    XCTAssertEqual(observer.events, ["start 1"])
    system.expire(1)
    XCTAssertEqual(observer.events, ["start 1", "expired 1"])
    XCTAssertEqual(system.stopped, [1], "wygaśnięcie zamyka zadanie systemu")
    // Koniec rdzenia po wygaśnięciu: bez drugiego zamknięcia i bez zdarzenia.
    work.end(token!)
    XCTAssertEqual(system.stopped, [1])
    XCTAssertEqual(observer.events, ["start 1", "expired 1"])
  }

  func testWorkWithoutServerDoesNotHoldGeneration() {
    let system = FakeBackgroundSystem()
    let observer = RecordingWorkObserver()
    let work = UIKitBackgroundWork(system: system.system, observer: observer)
    let dictation = work.begin("dyktowanie", needsServer: false)
    let note = work.begin("notatka", needsServer: true)
    work.end(dictation!)
    system.expire(1)
    work.end(note!)
    XCTAssertEqual(observer.events, ["start 2", "finished 2"], "kończenie dyktowania nie trafia do tunelu")
    XCTAssertEqual(system.stopped, [1, 2])
  }

  func testWorkDeadlineFollowsSystemTimeInBackground() {
    let system = FakeBackgroundSystem()
    let observer = RecordingWorkObserver()
    let start = ContinuousClock.now
    let work = UIKitBackgroundWork(system: system.system, observer: observer, now: { start })
    system.remainingTime = 25
    _ = work.begin("notatka", needsServer: true)
    // Na wierzchu system podaje czas bez ograniczenia: termin zastępczy, wygaśnięcie i tak przyjdzie zdarzeniem.
    system.remainingTime = .greatestFiniteMagnitude
    _ = work.begin("rarog.presence", needsServer: true)
    XCTAssertEqual(observer.deadlines, [start + .seconds(25), start + .seconds(UIKitBackgroundWork.foregroundAllowance)])
  }

  func testSystemRefusalGivesNoTokenAndNoEvent() {
    let system = FakeBackgroundSystem()
    system.refuse = true
    let observer = RecordingWorkObserver()
    let work = UIKitBackgroundWork(system: system.system, observer: observer)
    XCTAssertNil(work.begin("notatka", needsServer: true))
    XCTAssertEqual(observer.events, [])
  }

  func testExpiryOfWorkWithoutServerReachesOnlyItsHandler() {
    let system = FakeBackgroundSystem()
    let observer = RecordingWorkObserver()
    let work = UIKitBackgroundWork(system: system.system, observer: observer)
    let expired = LineRecorder()
    let token = work.begin(TunnelCoordinator.graceTaskName, needsServer: false) { expired.append("expired") }
    system.expire(1)
    XCTAssertEqual(expired.all, ["expired"])
    XCTAssertEqual(system.stopped, [1], "adapter zamyka zadanie przed wiadomością")
    XCTAssertEqual(observer.events, [], "praca bez serwera nie trafia do tunelu")
    work.end(token!)
    system.expire(1)
    XCTAssertEqual(expired.all, ["expired"], "po zamknięciu bez drugiej wiadomości")
    XCTAssertEqual(system.stopped, [1])
  }

  // MARK: - Łaska tła: zadanie systemu bez `needsServer`

  func testGraceHoldsOneSystemTaskUntilGenerationClosesAtDeadline() async throws {
    let rig = try await GraceRig.make()
    rig.coordinator.scene(.background)
    XCTAssertEqual(rig.system.started, [TunnelCoordinator.graceTaskName], "jedno zadanie systemu na zejście w tło")
    XCTAssertEqual(rig.coordinator.liveWorks, [], "zadanie bez needsServer nie jest pracą maszyny")
    try await rig.inGrace()
    rig.clock.advance(by: .milliseconds(7_900))
    try await Task.sleep(for: .milliseconds(100))
    XCTAssertEqual(rig.system.stopped, [], "przed terminem łaski zadanie trwa")
    let before = await rig.runtime.machineState
    guard case .backgroundGrace(1, _, _) = before else { return XCTFail("przed terminem: \(before)") }
    rig.clock.advance(by: .milliseconds(100))
    try await Self.eventually("generacja zamknięta w terminie łaski") { await rig.runtime.machineState == .idle }
    try await Self.eventually("zadanie systemu zakończone po zamknięciu") { rig.system.stopped == [1] }
    XCTAssertEqual(rig.system.started.count, 1)
    let works = await rig.runtime.machineWorks
    XCTAssertEqual(works, [])
  }

  func testReturnBeforeDeadlineEndsTaskAndKeepsGeneration() async throws {
    let rig = try await GraceRig.make()
    rig.coordinator.scene(.background)
    try await rig.inGrace()
    rig.clock.advance(by: .seconds(3))
    rig.coordinator.scene(.inactive)
    XCTAssertEqual(rig.system.stopped, [1], "powrót kończy zadanie od razu")
    rig.coordinator.scene(.active)
    guard case let .ready(generation) = await rig.runtime.generation() else { return XCTFail("bez generacji") }
    XCTAssertEqual(generation.number, 1, "powrót przed terminem: ta sama generacja")
    rig.clock.advance(by: .seconds(10))
    try await Task.sleep(for: .milliseconds(100))
    guard case let .ready(later) = await rig.runtime.generation() else { return XCTFail("bez generacji") }
    XCTAssertEqual(later.number, 1, "zaległy termin łaski po powrocie niczego nie zamyka")
    XCTAssertEqual(rig.system.started.count, 1)
    XCTAssertEqual(rig.system.stopped, [1])
  }

  func testSystemExpiryClosesGraceGenerationAtOnce() async throws {
    let rig = try await GraceRig.make()
    rig.coordinator.scene(.background)
    try await rig.inGrace()
    rig.system.expire(1)
    try await Self.eventually("generacja zamknięta od razu") { await rig.runtime.machineState == .idle }
    XCTAssertEqual(rig.clock.now, .zero, "bez czekania na termin ani na powrót")
    XCTAssertEqual(rig.system.stopped, [1], "zadanie zamknięte raz, przez adapter")
    rig.coordinator.scene(.active)
    XCTAssertEqual(rig.system.stopped, [1])
    guard case let .ready(generation) = await rig.runtime.generation() else { return XCTFail("bez generacji") }
    XCTAssertEqual(generation.number, 2, "po wygaśnięciu nowa generacja")
  }

  func testSystemRefusalClosesGraceGenerationAtOnce() async throws {
    let rig = try await GraceRig.make()
    rig.system.refuse = true
    rig.coordinator.scene(.background)
    XCTAssertEqual(rig.system.started, [])
    try await Self.eventually("generacja zamknięta od razu") { await rig.runtime.machineState == .idle }
    XCTAssertEqual(rig.clock.now, .zero)
  }

  func testTwentyBackgroundCyclesEndEveryStartedTask() async throws {
    let rig = try await GraceRig.make()
    for cycle in 1 ... 20 {
      rig.coordinator.scene(.background)
      try await rig.inGrace()
      if cycle.isMultiple(of: 2) {
        rig.clock.advance(by: .seconds(9))
        try await Self.eventually("cykl \(cycle): generacja zamknięta") { await rig.runtime.machineState == .idle }
        try await Self.eventually("cykl \(cycle): zadanie zakończone") { rig.system.stopped.count == cycle }
      } else {
        rig.clock.advance(by: .seconds(3))
      }
      rig.coordinator.scene(.inactive)
      rig.coordinator.scene(.active)
      XCTAssertEqual(rig.system.stopped.count, cycle, "cykl \(cycle)")
      guard case .ready = await rig.runtime.generation() else { return XCTFail("cykl \(cycle): bez generacji") }
    }
    XCTAssertEqual(rig.system.started.count, 20)
    XCTAssertEqual(rig.system.stopped.count, 20)
    XCTAssertEqual(Set(rig.system.stopped).count, 20, "każde zadanie zamknięte dokładnie raz")
  }

  // MARK: - Voice hold (a recording kept in the background)
  // Without a hold the grace cases above hold as they are.

  /// Catches a hold that does not keep the generation past the 8 s grace (the server connection of a locked phone
  /// would close under a running conversation), and a release after the grace that leaves a work or the grace task.
  func testVoiceHoldKeepsGenerationPastGraceAndReleaseAfterItCloses() async throws {
    let rig = try await GraceRig.make()
    rig.coordinator.scene(.background)
    try await rig.inGrace()
    rig.coordinator.holdForVoice(true)
    try await rig.held()
    rig.clock.advance(by: .seconds(30))
    try await Task.sleep(for: .milliseconds(100))
    try await rig.expectHeld("30 s after entering the background")
    guard case let .ready(generation) = await rig.runtime.generation() else { return XCTFail("no generation") }
    XCTAssertEqual(generation.number, 1, "a request in the background gets the held generation")
    XCTAssertEqual(rig.system.stopped, [], "the grace task stays open while the generation is held")
    rig.coordinator.holdForVoice(false)
    try await Self.eventually("released after the grace: the generation closes") {
      await rig.runtime.machineState == .idle
    }
    try await rig.expectReleased()
  }

  /// Catches a hold set in the foreground that the background does not see (the generation would fall to the grace
  /// rule and close after 8 s).
  func testVoiceHoldSetBeforeBackgroundKeepsGeneration() async throws {
    let rig = try await GraceRig.make()
    rig.coordinator.holdForVoice(true)
    rig.coordinator.scene(.background)
    try await rig.held()
    XCTAssertEqual(rig.system.started, [TunnelCoordinator.graceTaskName])
    rig.clock.advance(by: .seconds(9))
    try await Task.sleep(for: .milliseconds(100))
    try await rig.expectHeld("past the grace deadline")
    rig.coordinator.holdForVoice(false)
    try await Self.eventually("the generation closes") { await rig.runtime.machineState == .idle }
    try await rig.expectReleased()
  }

  /// Catches a system expiry of the grace task that closes a held generation, and a release after that expiry that
  /// waits for a grace the stay no longer has (the machine's rule: the expiry takes the grace of this stay).
  func testSystemExpiryDuringVoiceHoldKeepsGenerationAndReleaseClosesAtOnce() async throws {
    let rig = try await GraceRig.make()
    rig.coordinator.scene(.background)
    try await rig.inGrace()
    rig.coordinator.holdForVoice(true)
    try await rig.held()
    rig.system.expire(1)
    try await Task.sleep(for: .milliseconds(100))
    try await rig.expectHeld("after the system expired the grace task")
    XCTAssertEqual(rig.system.stopped, [1], "the adapter closed the expired task")
    rig.coordinator.holdForVoice(false)
    try await Self.eventually("the generation closes at once") { await rig.runtime.machineState == .idle }
    XCTAssertEqual(rig.clock.now, .zero, "within the 8 s, without waiting for the deadline")
    try await rig.expectReleased()
  }

  /// Catches a release within the grace that closes the generation at once or keeps it past the deadline: the
  /// grace rule of this stay applies as if the hold never happened.
  func testVoiceHoldReleasedWithinGraceReturnsToGraceDeadline() async throws {
    let rig = try await GraceRig.make()
    rig.coordinator.scene(.background)
    try await rig.inGrace()
    rig.coordinator.holdForVoice(true)
    try await rig.held()
    rig.clock.advance(by: .seconds(3))
    rig.coordinator.holdForVoice(false)
    try await rig.inGrace()
    rig.clock.advance(by: .milliseconds(4_900))
    try await Task.sleep(for: .milliseconds(100))
    let before = await rig.runtime.machineState
    guard case .backgroundGrace(1, _, _) = before else { return XCTFail("before the deadline: \(before)") }
    XCTAssertEqual(rig.system.stopped, [], "the grace task lasts until the generation closes")
    rig.clock.advance(by: .milliseconds(100))
    try await Self.eventually("closed at the grace deadline") { await rig.runtime.machineState == .idle }
    try await rig.expectReleased()
  }

  /// Catches a hold that changes the foreground: a new generation, a request that waits, a release that closes the
  /// ready generation, or a system task started without the background.
  func testVoiceHoldInForegroundChangesNothing() async throws {
    let rig = try await GraceRig.make()
    rig.coordinator.holdForVoice(true)
    try await TunnelCoordinatorTests.settle(rig.runtime)
    try await rig.expectReady("held in the foreground")
    XCTAssertEqual(rig.coordinator.liveWorks, [TunnelCoordinator.voiceHoldWork])
    rig.coordinator.holdForVoice(false)
    try await TunnelCoordinatorTests.settle(rig.runtime)
    try await rig.expectReady("released in the foreground")
    XCTAssertEqual(rig.coordinator.liveWorks, [])
    let works = await rig.runtime.machineWorks
    XCTAssertEqual(works, [])
    XCTAssertEqual(rig.system.started, [], "no system task in the foreground")
    rig.coordinator.scene(.background)
    try await rig.inGrace()
  }

  /// Catches a repeated hold that adds a second work (one release would leave the other holding the connection),
  /// and a reserved identifier a system task identifier could reach.
  func testRepeatedVoiceHoldIsOneWorkUnderTheReservedId() {
    let coordinator = Self.coordinator()
    coordinator.holdForVoice(true)
    coordinator.holdForVoice(true)
    XCTAssertEqual(coordinator.liveWorks, [TunnelCoordinator.voiceHoldWork])
    XCTAssertLessThan(UInt64(Int.max), TunnelCoordinator.voiceHoldWork.raw)
    coordinator.holdForVoice(false)
    coordinator.holdForVoice(false)
    XCTAssertEqual(coordinator.liveWorks, [])
  }

  // MARK: - Reset testów UI

  func testUITestResetDeletesIrohIdentity() {
    let identity = MemoryIrohIdentityKeychain(.init(data: Data(repeating: 7, count: 32)))
    AppEnvironment.resetForUITestsIfAsked(environment: [:], irohIdentity: identity)
    XCTAssertNotNil(identity.snapshot.data, "bez flagi resetu wpis zostaje")
    AppEnvironment.resetForUITestsIfAsked(environment: [AppEnvironment.testResetKey: "1"], irohIdentity: identity)
    XCTAssertNil(identity.snapshot.data, "reset testów UI kasuje wpis tożsamości iroh")
  }

  func testUITestResetDeletesRelayAccessItems() {
    let identity = MemoryIrohIdentityKeychain(.init(data: Data(repeating: 7, count: 32)))
    var resets = 0
    AppEnvironment.resetForUITestsIfAsked(environment: [:], irohIdentity: identity, relayAccess: { resets += 1 })
    XCTAssertEqual(resets, 0, "without the reset flag the registry items stay")
    AppEnvironment.resetForUITestsIfAsked(
      environment: [AppEnvironment.testResetKey: "1"], irohIdentity: identity, relayAccess: { resets += 1 })
    XCTAssertEqual(resets, 1, "the UI test reset deletes relay-access and relay-optout with the iroh identity")
  }

  // MARK: - Koordynator

  func testTransportPerEndpointAndPairingTarget() {
    let coordinator = Self.coordinator()
    let rules = MutationRules()
    XCTAssertTrue(coordinator.transport(.none, rules) is RarogClient, "bez klucza: klient bez serwera")
    XCTAssertFalse(coordinator.hasCurrent)
    XCTAssertTrue(coordinator.transport(.device(Self.credential(https: true)), rules) is SwitchingTransport)
    XCTAssertTrue(coordinator.hasCurrent)
    XCTAssertTrue(coordinator.pairing(.https(Self.server)) is RarogClient, "parowanie samym adresem jak bez tunelu")
    XCTAssertTrue(coordinator.pairing(.iroh(Self.iroh)) is SwitchingTransport)
    XCTAssertTrue(coordinator.pairing(.both(Self.server, Self.iroh)) is SwitchingTransport, "obie trasy: przez iroh")
    XCTAssertEqual(coordinator.liveRuntimes, 3)
  }

  func testReleaseRetiresOnlyMatchingIdentity() async {
    let coordinator = Self.coordinator()
    let rules = MutationRules()
    let credential = Self.credential(https: true)
    _ = coordinator.transport(.device(credential), rules)
    coordinator.release(.device(Self.credential(https: true, deviceId: "inne")))
    XCTAssertTrue(coordinator.hasCurrent, "inna tożsamość nie kończy bieżącej")
    coordinator.release(.device(credential))
    XCTAssertFalse(coordinator.hasCurrent)
  }

  func testWorksAreTrackedUntilFinishedOrExpired() {
    let coordinator = Self.coordinator()
    let now = ContinuousClock.now
    coordinator.workStarted(.init(1), expiresAt: now + .seconds(30))
    coordinator.workStarted(.init(2), expiresAt: now + .seconds(30))
    coordinator.workFinished(.init(1))
    coordinator.workExpired(.init(3))
    XCTAssertEqual(coordinator.liveWorks, [.init(2)])
    coordinator.workExpired(.init(2))
    XCTAssertEqual(coordinator.liveWorks, [])
  }

  // MARK: - Stan początkowy nowego runtime'u

  func testWorkFinishedRightAfterRuntimeCreationLeavesNoWork() async throws {
    try await expectNoWorkAfterEnd { coordinator, id in coordinator.workFinished(id) }
  }

  func testWorkExpiredRightAfterRuntimeCreationLeavesNoWork() async throws {
    try await expectNoWorkAfterEnd { coordinator, id in coordinator.workExpired(id) }
  }

  /// Praca w tle przed nowym runtime'em i jej koniec zaraz po nim: maszyna bez prac, generacja nie trzyma się
  /// jako praca w tle.
  private func expectNoWorkAfterEnd(_ end: (TunnelCoordinator, TunnelMachine.WorkID) -> Void) async throws {
    let coordinator = Self.coordinator()
    coordinator.scene(.background)
    coordinator.workStarted(.init(1), expiresAt: .now + .seconds(30))
    _ = coordinator.transport(.device(Self.credential(https: true)), MutationRules())
    end(coordinator, .init(1))
    let runtime = try XCTUnwrap(coordinator.currentRuntime)
    try await Self.settle(runtime)
    let works = await runtime.machineWorks
    XCTAssertEqual(works, [])
    let state = await runtime.machineState
    if case .backgroundWork = state { XCTFail("generacja trzyma się jako praca w tle: \(state)") }
  }

  func testWorkStartedRightAfterRuntimeCreationGivesOneWork() async throws {
    let coordinator = Self.coordinator()
    coordinator.scene(.background)
    _ = coordinator.transport(.device(Self.credential(https: true)), MutationRules())
    coordinator.workStarted(.init(1), expiresAt: .now + .seconds(30))
    let runtime = try XCTUnwrap(coordinator.currentRuntime)
    try await Self.settle(runtime)
    let works = await runtime.machineWorks
    XCTAssertEqual(works, [.init(1)])
    let state = await runtime.machineState
    guard case .backgroundWork(_, .https) = state else { return XCTFail("oczekiwana praca w tle HTTPS: \(state)") }
  }

  func testUnavailableLeaseBeforeRuntimeGivesHTTPSFirst() async throws {
    let coordinator = Self.coordinator(keychain: MemoryIrohIdentityKeychain(.init(locked: true)))
    coordinator.scene(.active)
    let rules = MutationRules()
    _ = coordinator.transport(.device(Self.credential(https: true, iroh: true)), rules)
    let first = try XCTUnwrap(coordinator.currentRuntime)
    // Keychain zamknięty: pierwsza próba iroh nie dostaje tożsamości, dzierżawa przechodzi w `unavailable`.
    _ = await first.generation()
    try await Self.eventually("dzierżawa niedostępna") { await first.machineLease == .unavailable }
    // With both routes the HTTPS generation passes the probe first. Nothing listens on port 1, so the
    // probe fails at once and the test checks the attempt, not its result.
    let silent = URL(string: "http://127.0.0.1:1")!
    _ = coordinator.transport(.device(Self.credential(https: true, iroh: true, deviceId: "d2", url: silent)), rules)
    let runtime = try XCTUnwrap(coordinator.currentRuntime)
    let lease = await runtime.machineLease
    XCTAssertEqual(lease, .unavailable)
    let outcome = await runtime.generation()
    if case .ready = outcome { XCTFail("an HTTPS probe without a server must fail: \(outcome)") }
    let opened = await runtime.machineLastGeneration
    XCTAssertEqual(opened, 1, "pierwsza generacja nowego runtime'u bez próby iroh")
    let after = await runtime.machineLease
    XCTAssertEqual(after, .unavailable, "with the lease unavailable that generation could only go over HTTPS")
  }

  func testReadinessChangeDuringRegistrationReachesNewestValue() async throws {
    let registry = TunnelRegistry()
    let lease = EndpointLease(transport: RefusingTunnelTransport(), identity: { nil }, clock: ContinuousClock())
    let make: (LeaseReadiness) -> TunnelRuntime = { readiness in
      TunnelRuntime(
        target: nil, httpsClient: RarogClient(config: RarogConfig(baseURL: Self.server, clientLabel: "test", build: 1)),
        lease: lease, makeClient: { url in RarogClient(config: RarogConfig(baseURL: url, clientLabel: "test", build: 1)) },
        readiness: readiness)
    }
    // Zmiany gotowości z innego wątku w trakcie rejestracji; ostatnia wartość to `unavailable`.
    let changes = Task.detached {
      for index in 0 ..< 400 { registry.readinessChanged(index % 2 == 0 ? .rebinding : .ready) }
      registry.readinessChanged(.unavailable)
    }
    var runtimes: [TunnelRuntime] = []
    for _ in 0 ..< 40 {
      runtimes.append(registry.add(make))
      await Task.yield()
    }
    await changes.value
    runtimes.append(registry.add(make))
    XCTAssertEqual(registry.readiness, .unavailable)
    for (index, runtime) in runtimes.enumerated() {
      try await Self.eventually("runtime \(index) z najnowszą gotowością") { await runtime.machineLease == .unavailable }
    }
  }

  // MARK: - Parowanie: połączenie jednorazowe

  func testPairingRuntimeRetiresRightAfterPairResponse() async throws {
    let rig = PairingRig { request in request.path == "/api/pair" ? .json(200, PairingRig.pairJSON) : nil }
    let transport = rig.coordinator.pairing(.iroh(Self.iroh))
    let response = try await transport.pair(Self.pairBody)
    XCTAssertEqual(response.deviceId, "d-new")
    try await rig.expectRetiredWithoutLifetime()
  }

  func testPairingRuntimeRetiresRightAfterPairFailure() async throws {
    let rig = PairingRig { request in
      request.path == "/api/pair" ? .json(409, #"{"error":"pairing-code-invalid"}"#) : nil
    }
    let transport = rig.coordinator.pairing(.iroh(Self.iroh))
    do {
      _ = try await transport.pair(Self.pairBody)
      XCTFail("409 bez błędu")
    } catch {}
    try await rig.expectRetiredWithoutLifetime()
  }

  func testPairingRuntimeRetiresRightAfterCancellation() async throws {
    let hold = Gate()
    let rig = PairingRig { request in
      guard request.path == "/api/pair" else { return nil }
      await hold.wait()
      return .json(200, PairingRig.pairJSON)
    }
    let transport = rig.coordinator.pairing(.iroh(Self.iroh))
    let pairing = Task { try await transport.pair(Self.pairBody) }
    try await Self.eventually("żądanie parowania u serwera") { rig.served("POST /api/pair") == 1 }
    pairing.cancel()
    _ = try? await pairing.value
    try await rig.expectRetiredWithoutLifetime()
    hold.open()
  }

  func testPairingRuntimeWithoutAnswerRetiresAfterLifetime() async throws {
    let hold = Gate()
    let rig = PairingRig { request in
      guard request.path == "/api/pair" else { return nil }
      await hold.wait()
      return .json(200, PairingRig.pairJSON)
    }
    let transport = rig.coordinator.pairing(.iroh(Self.iroh))
    let pairing = Task { try? await transport.pair(Self.pairBody) }
    try await Self.eventually("żądanie parowania u serwera") { rig.served("POST /api/pair") == 1 }
    let runtime = try XCTUnwrap(rig.coordinator.runtimes.last)
    try await Task.sleep(for: .milliseconds(200))
    let early = await runtime.machineState
    XCTAssertNotEqual(early, .retired, "bez odpowiedzi runtime żyje do limitu")
    rig.clock.advance(by: TunnelCoordinator.pairingLifetime)
    try await Self.eventually("wycofanie po pairingLifetime") { await runtime.machineState == .retired }
    hold.open()
    _ = await pairing.value
  }

  /// Each pairing retry is a new runtime, and the retries share one limit of iroh failure
  /// reports, so three quick failures do not rebind the endpoint the current server's tunnel uses.
  func testPairingRetriesShareIrohFailureReportLimit() async throws {
    var script = FakeTunnelScript()
    script.connect = { _ in .fail(.connectFailed("pairing target unreachable")) }
    let rig = PairingRig(script: script) { _ in nil }
    for retry in 0 ..< 3 {
      let transport = rig.coordinator.pairing(.iroh(Self.iroh))
      do {
        _ = try await transport.pair(Self.pairBody)
        XCTFail("retry \(retry): pair without an iroh connection succeeded")
      } catch {}
      let runtime = try XCTUnwrap(rig.coordinator.runtimes.last)
      try await Self.eventually("retry \(retry): runtime retired, its lease report sent") {
        guard await runtime.machineState == .retired else { return false }
        return await runtime.busyTasks == 0
      }
      rig.clock.advance(by: .seconds(10))
    }
    try await Task.sleep(for: .milliseconds(100))
    XCTAssertEqual(rig.fake.endpoints.count, 1)
    XCTAssertEqual(rig.fake.endpoints.first?.isClosed, false, "no rebind(.broken) of the shared endpoint")
  }

  // MARK: - Revoking the previous key (`forgetTransport`)

  /// Each pairing with another key builds a one-off runtime that revokes the previous key, like a pairing retry, so
  /// its iroh failures share the pairing limit: three quick failures send one report to the lease and do not rebind
  /// the endpoint the current server's tunnel uses, and a success still goes through.
  func testForgetTransportsShareIrohFailureReportLimit() async throws {
    let relay = RecordingRelayAccess()
    let failing = Flag(true)
    var script = FakeTunnelScript()
    script.connect = { _ in failing.value ? .fail(.connectFailed("previous server unreachable")) : .immediate }
    let rig = PairingRig(script: script, relayAccess: relay) { _ in nil }
    let previous = ServerEndpoint.device(Self.credential(https: false, deviceId: "d-old"))
    for retry in 0 ..< 3 {
      let transport = rig.coordinator.forgetTransport(previous, MutationRules())
      do {
        try await transport.forgetDevice()
        XCTFail("retry \(retry): forget without an iroh connection succeeded")
      } catch {}
      try await Self.settle(try XCTUnwrap(rig.coordinator.runtimes.last))
      rig.clock.advance(by: .seconds(10))
    }
    try await Task.sleep(for: .milliseconds(100))
    XCTAssertEqual(relay.calls.filter { $0 == .trigger(.tunnelFailed) }.count, 1, "one failure report to the lease")
    XCTAssertEqual(rig.fake.endpoints.count, 1)
    XCTAssertEqual(rig.fake.endpoints.first?.isClosed, false, "no rebind(.broken) of the shared endpoint")
    failing.set(false)
    try await rig.coordinator.forgetTransport(previous, MutationRules()).forgetDevice()
    XCTAssertEqual(rig.served("POST /api/devices/forget"), 1, "a success goes through after the failures")
  }

  /// The forget runtime lives through one iroh-only attempt and the request limit, like the pairing runtime.
  func testForgetLifetimeCoversIrohAttemptAndRequest() {
    let request = RarogConfig(baseURL: Self.server, clientLabel: "test·Rarog", build: 1).requestTimeout
    XCTAssertGreaterThanOrEqual(TunnelCoordinator.forgetLifetime, TunnelMachine.irohOnlyAttemptBudget + request)
  }

  // MARK: - Ślady tunelu w `client.log`

  /// 20 cykli tła w godzinie, w każdym dwie linie informacyjne tunelu (wycofanie runtime'u po dwóch przełączeniach
  /// tożsamości), w 20. cyklu porażka generacji iroh. Odbiorca udaje wspólny budżet śladów apki (20 na godzinę,
  /// `ContractReporter.traceCap`).
  func testIrohFailureLineSurvivesTwentyCyclesOfInfoLines() async throws {
    let clock = FakeTunnelClock()
    let sink = SharedTraceBudget(cap: 20)
    let coordinator = Self.coordinator(clock: clock, log: sink.offer)
    let rules = MutationRules()
    for cycle in 1 ... 20 {
      coordinator.scene(.background)
      clock.advance(by: .seconds(60))
      coordinator.scene(.active)
      for step in ["a", "b"] {
        let previous = coordinator.currentRuntime
        let iroh = cycle == 20 && step == "b"
        _ = coordinator.transport(.device(Self.credential(https: true, iroh: iroh, deviceId: "d\(cycle)\(step)")), rules)
        if let previous {
          try await Self.eventually("cykl \(cycle)\(step): poprzedni runtime wycofany") {
            await previous.machineState == .retired
          }
        }
      }
      clock.advance(by: .seconds(110))
    }
    let runtime = try XCTUnwrap(coordinator.currentRuntime)
    _ = await runtime.generation()
    try await Self.eventually("linia porażki iroh przeszła przez wspólny budżet") {
      sink.admitted.contains { $0.contains("(iroh) failed") }
    }
    let info = sink.offered.filter { !$0.contains("(iroh) failed") && !$0.hasPrefix("tunnel state:") }
    XCTAssertLessThanOrEqual(info.count, 4, "podbudżet linii informacyjnych tunelu: 4 na godzinę")
  }

  func testStateLineAtMostOncePerTenMinutesInSteadyState() async throws {
    let clock = FakeTunnelClock()
    let lines = LineRecorder()
    let coordinator = Self.coordinator(clock: clock, log: lines.append)
    _ = coordinator.transport(.device(Self.credential(https: true)), MutationRules())
    coordinator.scene(.active)
    coordinator.scene(.background)
    clock.advance(by: .seconds(120))
    coordinator.scene(.inactive)
    coordinator.scene(.active)
    try await Self.eventually("pierwsza linia stanu") { lines.state.count == 1 }
    let first = try XCTUnwrap(lines.state.first)
    XCTAssertTrue(first.hasPrefix("tunnel state: steady;"), first)
    coordinator.scene(.background)
    clock.advance(by: .seconds(240))
    coordinator.scene(.active)
    try await Task.sleep(for: .milliseconds(300))
    XCTAssertEqual(lines.state.count, 1, "drugi powrót w 10 min przy stanie ustalonym: bez linii")
    coordinator.scene(.background)
    clock.advance(by: .seconds(400))
    coordinator.scene(.active)
    try await Self.eventually("linia stanu po 10 min") { lines.state.count == 2 }
  }

  func testStateLineRightAwayOverSteadyState() async throws {
    let clock = FakeTunnelClock()
    let lines = LineRecorder()
    let counters = TunnelProxyCounters()
    let coordinator = Self.coordinator(clock: clock, proxyCounters: counters, log: lines.append)
    _ = coordinator.transport(.device(Self.credential(https: true)), MutationRules())
    coordinator.scene(.active)
    coordinator.scene(.background)
    clock.advance(by: .seconds(120))
    coordinator.scene(.active)
    try await Self.eventually("pierwsza linia stanu") { lines.state.count == 1 }
    // Nasłuch, który przeżył tło bez pracy: poza żywą generacją stan ustalony to zero nasłuchów.
    counters.listenerOpened()
    coordinator.scene(.background)
    clock.advance(by: .seconds(120))
    coordinator.scene(.active)
    try await Self.eventually("linia stanu od razu") { lines.state.count == 2 }
    let over = try XCTUnwrap(lines.state.dropFirst().first)
    XCTAssertTrue(over.hasPrefix("tunnel state: over listeners;"), over)
    XCTAssertTrue(over.contains(" listeners=1 "), over)
    // Ten sam nadmiar przy następnym powrocie w 10 min: bez powtórki.
    coordinator.scene(.background)
    clock.advance(by: .seconds(120))
    coordinator.scene(.active)
    try await Task.sleep(for: .milliseconds(300))
    XCTAssertEqual(lines.state.count, 2)
    counters.listenerClosed()
  }

  /// Ten sam nadmiar przy rosnącym `routeStamp` (nowa generacja po każdym powrocie), 20 powrotów w godzinie: linia
  /// stanu najwyżej raz na 10 min, więc alarm iroh na końcu godziny mieści się we wspólnym budżecie śladów. Większy
  /// nadmiar wychodzi od razu.
  func testSameExcessWithGrowingRouteDoesNotEatSharedBudget() {
    let start = ContinuousClock.now
    let sink = SharedTraceBudget(cap: 20)
    let trace = TunnelTrace(sink: sink.offer, now: { start + .seconds(3_590) })
    for cycle in 0 ..< 20 {
      let snapshot = TunnelSnapshot(route: UInt64(cycle + 1), runtimes: 1, endpoints: 1, listeners: 1,
        away: .seconds(120))
      trace.state(snapshot, at: start + .seconds(cycle * 180))
    }
    XCTAssertEqual(sink.offered.count, 5, "linie w 0, 720, 1440, 2160 i 2880 s")
    trace.state(TunnelSnapshot(route: 21, runtimes: 1, endpoints: 1, listeners: 2, away: .seconds(120)),
      at: start + .seconds(3_000))
    XCTAssertEqual(sink.offered.count, 6, "większy nadmiar od razu, 120 s po poprzedniej linii")
    XCTAssertTrue(sink.offered.last?.hasPrefix("tunnel state: over listeners;") == true, sink.offered.last ?? "")
    trace.send("tunnel: generation 21 (iroh) failed: test")
    XCTAssertTrue(sink.admitted.contains { $0.contains("(iroh) failed") }, "alarm przeszedł przez wspólny budżet")
  }

  /// A ready iroh generation closing in the foreground gives an alarm line with its number, its reason and
  /// the event time (a batch of lines gets the time it was sent); closes in the background give no alarm, and info
  /// lines carry no time.
  func testForegroundCloseOfIrohGenerationIsTimedAlarm() {
    let lines = LineRecorder()
    let trace = Self.timedTrace(lines)
    let events: [(TunnelMachine.Event, String)] = [
      (.networkChanged, "network"), (.connectionLost(generation: 1), "lost"),
      (.abortTimedOut(generation: 1), "abort timed out"),
    ]
    for (event, _) in events {
      var machine = Self.readyIrohMachine()
      Self.feed(machine.handle(event, now: Self.machineStart + .seconds(1)), to: trace)
    }
    XCTAssertEqual(lines.all, events.map {
      "tunnel: generation 1 (iroh) closed in foreground: \($0.1) at 10:27:06 UTC"
    })
    XCTAssertTrue(lines.all.allSatisfy(TunnelTrace.isAlert))

    for event in events.map(\.0) {
      var machine = Self.readyIrohMachine()
      _ = machine.handle(.scene(.background), now: Self.machineStart + .seconds(1))
      Self.feed(machine.handle(event, now: Self.machineStart + .seconds(2)), to: trace)
    }
    XCTAssertEqual(lines.all.count, 3, "zamknięcia w tle bez alarmu: \(lines.all)")
    trace.send("tunnel: generation 2 connection ended: closed")
    XCTAssertEqual(lines.all.last, "tunnel: generation 2 connection ended: closed", "linia informacyjna bez czasu")
  }

  /// Five failures of an iroh-only series, one of them a network change later, give two alarm lines: the first
  /// failure with its cause and the recovery.
  func testIrohOnlyFailureSeriesGivesTwoAlarmLines() {
    let lines = LineRecorder()
    let trace = Self.timedTrace(lines)
    var machine = TunnelMachine(routes: .init(hasHTTPS: false, hasIroh: true), scene: .active)
    var waiter: UInt64 = 0
    func at(_ seconds: Int) -> ContinuousClock.Instant { Self.machineStart + .seconds(seconds) }
    func handle(_ event: TunnelMachine.Event, _ seconds: Int) {
      Self.feed(machine.handle(event, now: at(seconds)), to: trace)
    }
    for seconds in [0, 1, 3, 7, 15] {
      if seconds == 7 { handle(.networkChanged, 6) }
      handle(.tick, seconds)
      waiter += 1
      handle(.demand(.init(waiter)), seconds)
      handle(.openFailed(generation: machine.lastGeneration, .connectFailed("relay")), seconds)
      handle(.closed(generation: machine.lastGeneration), seconds)
    }
    XCTAssertEqual(machine.lastGeneration, 5)
    handle(.tick, 17)
    waiter += 1
    handle(.demand(.init(waiter)), 17)
    handle(.opened(generation: 6), 17)
    handle(.probeFinished(generation: 6, .http(status: 200)), 18)
    XCTAssertEqual(lines.all, [
      "tunnel: generation 1 (iroh) failed: open: connectFailed(\"relay\") at 10:27:06 UTC",
      "tunnel: generation 6 (iroh) recovered after 5 attempts, 18 s at 10:27:06 UTC",
    ])
    XCTAssertTrue(lines.all.allSatisfy(TunnelTrace.isAlert))
  }

  /// A runtime retired by an unpairing (`install(.none)`) and a new pairing (`install(B)`) still writes its lines: they
  /// carry the key of the server it was built for, also through the relay's buffer, never the server current then.
  func testRetiredRuntimeLinesCarryTheirOwnServer() async throws {
    let lines = LineRecorder()
    let relay = TunnelLogRelay()
    let coordinator = Self.coordinator(log: relay.send)
    let serverA = Self.credential(https: true, deviceId: "dA", url: URL(string: "https://a.test")!)
    let serverB = Self.credential(https: true, deviceId: "dB", url: URL(string: "https://b.test")!)
    _ = coordinator.transport(.device(serverA), MutationRules())
    let first = try XCTUnwrap(coordinator.currentRuntime)
    _ = coordinator.transport(.none, MutationRules())
    _ = coordinator.transport(.device(serverB), MutationRules())
    try await Self.eventually("A's runtime retired") { await first.machineState == .retired }
    relay.attach(lines.append)
    try await Self.eventually("A's retired line") { lines.all.contains("tunnel: machine retired") }
    let retired = lines.stamped.filter { $0.line == "tunnel: machine retired" }
    XCTAssertEqual(Set(retired.map(\.server)), [ServerKey(serverA)], "\(lines.stamped)")
  }

  /// 10:27:06 UTC.
  nonisolated static let eventTime = Date(timeIntervalSince1970: 37_626)
  nonisolated static let machineStart = ContinuousClock.now

  static func timedTrace(_ lines: LineRecorder) -> TunnelTrace {
    TunnelTrace(sink: lines.append, now: { machineStart }, wallClock: { eventTime })
  }

  /// Ready iroh generation 1 of a credential with both routes, in the foreground.
  static func readyIrohMachine() -> TunnelMachine {
    var machine = TunnelMachine(routes: .init(hasHTTPS: true, hasIroh: true), scene: .active)
    _ = machine.handle(.demand(.init(1)), now: machineStart)
    _ = machine.handle(.opened(generation: 1), now: machineStart)
    _ = machine.handle(.probeFinished(generation: 1, .http(status: 200)), now: machineStart)
    return machine
  }

  /// Machine log lines the way the runtime writes them.
  static func feed(_ commands: [TunnelMachine.Command], to trace: TunnelTrace) {
    for case let .log(line) in commands { trace.send("tunnel: \(line)") }
  }

  // MARK: - Atrapy

  static let pairBody = PairBody(code: "ABCD-EFGH", label: "test·Rarog", build: 1)

  static let server = URL(string: "https://rarog.test")!
  static let iroh = ServerIrohConfig(
    endpointId: String(repeating: "ab", count: 32), relay: URL(string: "https://relay.example/")!)

  static func coordinator(
    keychain: MemoryIrohIdentityKeychain = MemoryIrohIdentityKeychain(), clock: FakeTunnelClock? = nil,
    proxyCounters: TunnelProxyCounters = TunnelProxyCounters(), relayAccess: (any RelayAccessControl)? = nil,
    log: @escaping @Sendable (String, ServerKey?) -> Void = { _, _ in }
  ) -> TunnelCoordinator {
    TunnelCoordinator(
      label: "test·Rarog", build: 1, transport: RefusingTunnelTransport(),
      identities: IrohIdentityStore(keychain: keychain), timing: clock.map(Self.timing) ?? .system,
      proxyCounters: proxyCounters, relayAccess: relayAccess, log: log)
  }

  /// Czas runtime'ów i koordynatora na zegarze sztucznym.
  static func timing(_ clock: FakeTunnelClock) -> TunnelRuntime.Timing {
    let base = ContinuousClock.now
    return TunnelRuntime.Timing(now: { base + clock.now }, sleep: clock.sleep)
  }

  static func credential(
    https: Bool, iroh withIroh: Bool? = nil, deviceId: String = "d1", url: URL = server
  ) -> DeviceCredential {
    DeviceCredential(
      deviceId: deviceId, secret: "sekret", serverURL: https ? url : nil, serverId: "srv", serverName: "mac-demo",
      label: "test·Rarog", kid: "k1", pairedAt: Date(timeIntervalSince1970: 1_792_000_000),
      iroh: (withIroh ?? !https) ? iroh : nil)
  }

  /// Runtime w spoczynku: chwila na zdarzenia w drodze, potem zero zadań pracy dwa razy z rzędu.
  static func settle(_ runtime: TunnelRuntime) async throws {
    try await Task.sleep(for: .milliseconds(100))
    try await eventually("runtime bez pracy") {
      guard await runtime.busyTasks == 0 else { return false }
      try? await Task.sleep(for: .milliseconds(20))
      return await runtime.busyTasks == 0
    }
  }

  /// Czeka w czasie rzeczywistym (do 5 s) na warunek.
  static func eventually(_ what: String, _ condition: () async -> Bool) async throws {
    let deadline = ContinuousClock.now + .seconds(5)
    while !(await condition()) {
      guard ContinuousClock.now < deadline else { return XCTFail("nie doczekano: \(what)") }
      try await Task.sleep(for: .milliseconds(5))
    }
  }
}

/// System zadań w tle bez `UIApplication`: identyfikatory od 1, wygaśnięcie na żądanie testu.
@MainActor
final class FakeBackgroundSystem {
  var refuse = false
  var remainingTime: TimeInterval = .greatestFiniteMagnitude
  /// Nazwy zadań, które system dał (bez odmów).
  private(set) var started: [String] = []
  private(set) var stopped: [Int] = []
  private var expirations: [Int: @MainActor () -> Void] = [:]
  private var next = 0

  var system: UIKitBackgroundWork.System {
    UIKitBackgroundWork.System(
      start: { [unowned self] name, expired in
        guard !refuse else { return nil }
        started.append(name)
        next += 1
        expirations[next] = expired
        return next
      },
      stop: { [unowned self] id in stopped.append(id) },
      remaining: { [unowned self] in remainingTime })
  }

  func expire(_ id: Int) {
    expirations[id]?()
  }
}

@MainActor
final class RecordingWorkObserver: ServerWorkObserver {
  private(set) var events: [String] = []
  private(set) var deadlines: [ContinuousClock.Instant] = []

  func workStarted(_ id: TunnelMachine.WorkID, expiresAt: ContinuousClock.Instant) {
    events.append("start \(id.raw)")
    deadlines.append(expiresAt)
  }

  func workFinished(_ id: TunnelMachine.WorkID) { events.append("finished \(id.raw)") }
  func workExpired(_ id: TunnelMachine.WorkID) { events.append("expired \(id.raw)") }
}

/// Koordynator z adapterem pracy w tle nad atrapą systemu, zegar sztuczny i gotowa generacja HTTPS na wierzchu.
@MainActor
final class GraceRig {
  let clock: FakeTunnelClock
  let system = FakeBackgroundSystem()
  let coordinator: TunnelCoordinator
  let work: UIKitBackgroundWork
  let runtime: TunnelRuntime

  private init(clock: FakeTunnelClock, coordinator: TunnelCoordinator, runtime: TunnelRuntime) {
    self.clock = clock
    self.coordinator = coordinator
    self.runtime = runtime
    work = UIKitBackgroundWork(system: system.system, observer: coordinator)
    coordinator.attach(work)
  }

  static func make() async throws -> GraceRig {
    let clock = FakeTunnelClock()
    let coordinator = TunnelCoordinatorTests.coordinator(clock: clock)
    _ = coordinator.transport(.device(TunnelCoordinatorTests.credential(https: true)), MutationRules())
    coordinator.scene(.active)
    let runtime = try XCTUnwrap(coordinator.currentRuntime)
    let rig = GraceRig(clock: clock, coordinator: coordinator, runtime: runtime)
    guard case let .ready(generation) = await runtime.generation() else {
      XCTFail("bez pierwszej generacji")
      throw CancellationError()
    }
    XCTAssertEqual(generation.number, 1)
    return rig
  }

  /// Maszyna w łasce, a sen jej terminu już czeka na zegarze sztucznym (przesunięcie zegara go obudzi).
  func inGrace() async throws {
    try await TunnelCoordinatorTests.eventually("łaska tła") {
      if case .backgroundGrace = await runtime.machineState { return true }
      return false
    }
    let napping = await clock.waitForSleepers(1)
    XCTAssertTrue(napping, "sen terminu łaski")
  }

  /// The machine keeps generation 1 as a background work (the voice hold).
  func held() async throws {
    try await TunnelCoordinatorTests.eventually("held as a background work") {
      if case .backgroundWork(1, _) = await runtime.machineState { return true }
      return false
    }
  }

  func expectHeld(_ when: String) async throws {
    let state = await runtime.machineState
    guard case .backgroundWork(1, _) = state else { return XCTFail("\(when): \(state)") }
  }

  /// Generation 1 ready, and a request gets it.
  func expectReady(_ when: String) async throws {
    let state = await runtime.machineState
    guard case .ready(1, _) = state else { return XCTFail("\(when): \(state)") }
    guard case let .ready(generation) = await runtime.generation() else { return XCTFail("\(when): no generation") }
    XCTAssertEqual(generation.number, 1, when)
  }

  /// After a release: no work in the coordinator or the machine, and the one grace task ended once.
  func expectReleased() async throws {
    XCTAssertEqual(coordinator.liveWorks, [])
    let works = await runtime.machineWorks
    XCTAssertEqual(works, [])
    try await TunnelCoordinatorTests.eventually("the grace task ended") { system.stopped == [1] }
    XCTAssertEqual(system.started.count, 1)
  }
}

/// Koordynator nad atrapą tunelu z serwerem HTTP: parowanie przez iroh bez sieci, czas na zegarze sztucznym.
@MainActor
final class PairingRig {
  /// Odpowiedź `POST /api/pair` (200) w kształcie `shared/fixtures/rest/pair.json`.
  nonisolated static let pairJSON = #"{"deviceId":"d-new","secret":"s","pushKey":"cHVzaA==","kid":"0a1b2c3d","#
    + #""server":{"id":"srv","name":"mac-demo","version":"1.0.0","capabilities":[],"iroh":null}}"#

  let clock = FakeTunnelClock()
  let fake: FakeTunnelTransport
  let coordinator: TunnelCoordinator
  private let requests: LineRecorder

  init(script: FakeTunnelScript = FakeTunnelScript(), relayAccess: (any RelayAccessControl)? = nil,
       respond: @escaping @Sendable (FakeHTTPRequest) async -> FakeHTTPResponse?) {
    var script = script
    let requests = LineRecorder()
    self.requests = requests
    script.server = .http { request in
      requests.append("\(request.method) \(request.path)")
      return await respond(request) ?? .json(200, "{}")
    }
    fake = FakeTunnelTransport(clock: clock, script: script)
    coordinator = TunnelCoordinator(
      label: "test·Rarog", build: 1, transport: fake, identities: IrohIdentityStore(keychain: MemoryIrohIdentityKeychain()),
      timing: TunnelCoordinatorTests.timing(clock), proxyCounters: fake.proxyCounters, relayAccess: relayAccess,
      log: { _, _ in })
  }

  func served(_ line: String) -> Int { requests.all.filter { $0 == line }.count }

  /// Jedyny runtime (parowania) wycofany, a zegar nie doszedł do ``TunnelCoordinator/pairingLifetime``.
  func expectRetiredWithoutLifetime() async throws {
    let runtime = try XCTUnwrap(coordinator.runtimes.last)
    try await TunnelCoordinatorTests.eventually("runtime parowania wycofany zaraz po pair") {
      await runtime.machineState == .retired
    }
    XCTAssertLessThan(clock.now, TunnelCoordinator.pairingLifetime)
    try await TunnelCoordinatorTests.eventually("połączenie parowania zamknięte") { fake.counters.connections == 0 }
  }
}

/// Bramka do zatrzymania odpowiedzi serwera atrapy.
final class Gate: Sendable {
  private let state = Mutex<(open: Bool, waiters: [CheckedContinuation<Void, Never>])>((false, []))

  func wait() async {
    await withCheckedContinuation { continuation in
      let resume = state.withLock { state -> Bool in
        if state.open { return true }
        state.waiters.append(continuation)
        return false
      }
      if resume { continuation.resume() }
    }
  }

  func open() {
    let waiters = state.withLock { state -> [CheckedContinuation<Void, Never>] in
      state.open = true
      defer { state.waiters = [] }
      return state.waiters
    }
    for waiter in waiters { waiter.resume() }
  }
}

/// A switch the fake tunnel script reads from its closures.
final class Flag: Sendable {
  private let state: Mutex<Bool>

  init(_ value: Bool) { state = Mutex(value) }

  var value: Bool { state.withLock { $0 } }

  func set(_ value: Bool) { state.withLock { $0 = value } }
}

/// Linie do `client.log` w kolejności.
final class LineRecorder: Sendable {
  private let lines = Mutex<[(line: String, server: ServerKey?)]>([])

  var all: [String] { lines.withLock { $0.map(\.line) } }
  var state: [String] { all.filter { $0.hasPrefix("tunnel state:") } }
  /// Lines with the server each concerns.
  var stamped: [(line: String, server: ServerKey?)] { lines.withLock { $0 } }

  func append(_ line: String, _ server: ServerKey? = nil) { lines.withLock { $0.append((line, server)) } }
}

/// Wspólny budżet śladów apki jak `ContractReporter.recordTrace` w jednej godzinie: pierwsze `cap` linii wychodzi.
final class SharedTraceBudget: Sendable {
  private let cap: Int
  private let state = Mutex<(offered: [String], admitted: [String])>(([], []))

  init(cap: Int) { self.cap = cap }

  var offered: [String] { state.withLock { $0.offered } }
  var admitted: [String] { state.withLock { $0.admitted } }

  func offer(_ line: String, _ server: ServerKey?) {
    state.withLock { state in
      state.offered.append(line)
      if state.admitted.count < cap { state.admitted.append(line) }
    }
  }
}

/// Transport iroh, który nie wiąże: koordynator bez sieci.
struct RefusingTunnelTransport: TunnelTransport {
  func bind(secretKey: Data, homeRelay: URL) async throws -> any TunnelEndpoint {
    throw TunnelFailure.bindFailed("test")
  }
}
