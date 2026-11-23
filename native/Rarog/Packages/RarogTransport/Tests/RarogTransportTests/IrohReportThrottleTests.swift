import Foundation
import RarogContract
@testable import RarogTransport
import RarogTransportTesting
import Testing

// The shared iroh failure report limit of one-off pairing runtimes: every pairing retry gets a new runtime
// on the one endpoint lease, so the limit must live outside the runtime. The current server's runtime is the `Rig`
// runtime; pairing runtimes are built next to it on the same lease and the same fake clock.

@Suite("iroh failure reports of pairing runtimes", .timeLimit(.minutes(5)))
struct IrohReportThrottleTests {
  static let failingConnect = TunnelFailure.connectFailed("pairing target unreachable")

  @Test("the first failure goes, the next ones within irohRetryDelay do not, the first one after it goes again")
  func throttleWindow() {
    let throttle = IrohReportThrottle()
    let start = ContinuousClock.now
    #expect(throttle.admitFailure(at: start))
    #expect(!throttle.admitFailure(at: start + .seconds(10)))
    #expect(!throttle.admitFailure(at: start + TunnelMachine.irohRetryDelay - .milliseconds(1)))
    #expect(throttle.admitFailure(at: start + TunnelMachine.irohRetryDelay))
    #expect(!throttle.admitFailure(at: start + TunnelMachine.irohRetryDelay + .seconds(1)))
  }

  @Test("three pairing runtimes failing within 60 s: one failure report, no rebind, the current server's tunnel stays")
  func pairingSeriesKeepsCurrentTunnel() async throws {
    var script = FakeTunnelScript()
    script.connect = { $0 == 0 ? .immediate : .fail(Self.failingConnect) }
    let rig = try await Rig.make(.irohOnly, script: script)
    await rig.runtime.scene(.active)
    let current = try await rig.ready()
    #expect(await rig.lease.userCount == 1)
    let throttle = IrohReportThrottle()
    for retry in 0 ..< 3 {
      let pairing = Self.pairingRuntime(rig, throttle)
      #expect(await Self.offline(pairing), "retry \(retry)")
      try await Self.settle(pairing, rig)
      await pairing.retire()
      try await rig.advance(by: .seconds(10), settling: true)
    }
    #expect(await rig.lease.irohFailures == 1, "one report for the whole pairing series")
    #expect(rig.closedUsers.all.isEmpty, "no rebind(.broken) closing the current user's connection")
    #expect(rig.fake.endpoints.count == 1)
    #expect(rig.fake.endpoints.first?.isClosed == false)
    #expect(rig.fake.liveConnections.count == 1)
    try await rig.request(on: current)
    try await rig.expectShutdownClean()
  }

  @Test("after irohRetryDelay the next pairing failure is reported again")
  func reportAgainAfterRetryDelay() async throws {
    var script = FakeTunnelScript()
    script.connect = { $0 == 0 ? .immediate : .fail(Self.failingConnect) }
    let rig = try await Rig.make(.irohOnly, script: script)
    await rig.runtime.scene(.active)
    let current = try await rig.ready()
    let throttle = IrohReportThrottle()
    try await Self.failPairing(rig, throttle)
    #expect(await rig.lease.irohFailures == 1)
    try await rig.advance(by: .seconds(10), settling: true)
    try await Self.failPairing(rig, throttle)
    #expect(await rig.lease.irohFailures == 1, "within irohRetryDelay")
    try await rig.advance(by: TunnelMachine.irohRetryDelay - .seconds(10), settling: true)
    try await Self.failPairing(rig, throttle)
    #expect(await rig.lease.irohFailures == 2, "irohRetryDelay after the first report")
    #expect(rig.closedUsers.all.isEmpty)
    try await rig.request(on: current)
    try await rig.expectShutdownClean()
  }

  @Test("a success of a pairing runtime still reaches the lease and resets its failures")
  func successIsNotThrottled() async throws {
    var script = FakeTunnelScript()
    script.connect = { $0 == 1 ? .fail(Self.failingConnect) : .immediate }
    let rig = try await Rig.make(.irohOnly, script: script)
    await rig.runtime.scene(.active)
    _ = try await rig.ready()
    let throttle = IrohReportThrottle()
    try await Self.failPairing(rig, throttle)
    #expect(await rig.lease.irohFailures == 1)
    try await rig.advance(by: .seconds(10), settling: true)
    let pairing = Self.pairingRuntime(rig, throttle)
    guard case .ready = await pairing.generation() else {
      Issue.record("the second pairing runtime has no generation")
      return
    }
    try await Self.settle(pairing, rig)
    #expect(await rig.lease.irohFailures == 0, "the success report reset the lease's failures")
    await pairing.retire()
    try await Self.settle(pairing, rig)
    try await rig.expectShutdownClean()
  }

  // MARK: - Pairing runtime next to the rig

  /// A one-off pairing runtime like `TunnelCoordinator.pairing`: iroh only, no HTTPS client, the rig's lease and clock.
  static func pairingRuntime(_ rig: Rig, _ throttle: IrohReportThrottle) -> TunnelRuntime {
    let (base, clock) = (rig.base, rig.clock)
    return TunnelRuntime(
      target: Rig.target, httpsClient: nil, lease: rig.lease,
      makeClient: { url in
        RarogClient(config: RarogConfig(baseURL: url, origin: IrohWire.origin, clientLabel: "test·Rarog", build: 1))
      },
      timing: .init(now: { base + clock.now }, sleep: clock.sleep),
      proxyCounters: rig.fake.proxyCounters, scene: .active, failureReports: throttle)
  }

  /// A pairing runtime whose iroh attempt fails, retired once it has settled.
  static func failPairing(_ rig: Rig, _ throttle: IrohReportThrottle,
                          sourceLocation: SourceLocation = #_sourceLocation) async throws {
    let pairing = pairingRuntime(rig, throttle)
    #expect(await offline(pairing), sourceLocation: sourceLocation)
    try await settle(pairing, rig, sourceLocation: sourceLocation)
    await pairing.retire()
    try await settle(pairing, rig, sourceLocation: sourceLocation)
  }

  static func offline(_ runtime: TunnelRuntime) async -> Bool {
    if case .offline = await runtime.generation() { return true }
    return false
  }

  /// The pairing runtime has no work in flight (its lease report included) and the lease no native operation.
  static func settle(_ runtime: TunnelRuntime, _ rig: Rig,
                     sourceLocation: SourceLocation = #_sourceLocation) async throws {
    try await eventually("pairing runtime settled", sourceLocation: sourceLocation) {
      guard await runtime.busyTasks == 0, await rig.lease.unfinishedNativeOperations == 0 else { return false }
      try? await Task.sleep(for: .milliseconds(3))
      let busy = await runtime.busyTasks
      let native = await rig.lease.unfinishedNativeOperations
      return busy == 0 && native == 0
    }
    try await rig.settle(sourceLocation: sourceLocation)
  }
}
