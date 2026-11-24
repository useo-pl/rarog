import Foundation
import RarogContract
import RarogTransport
import RarogTransportTesting
import Synchronization
@testable import RarogCore
import Testing

// Stream loop: a stall ends the stream like a drop, `online` starts with the first body byte, and the threshold from
// `hello` reaches streams that are already open. Time runs on an artificial clock: no test waits real seconds.

private func helloJSON(_ heartbeat: String) -> String {
  #"{"type":"hello","protocolVersion":3,"serverStartId":"s"\#(heartbeat)}"#
}

private func hello(_ heartbeat: String) throws -> HelloEvent {
  let json = #"{"protocolVersion":3,"serverStartId":"s"\#(heartbeat)}"#
  return try JSONDecoder().decode(HelloEvent.self, from: Data(json.utf8))
}

/// Clock of the stream loops on an artificial clock.
private func streamTiming(_ clock: FakeTunnelClock) -> TunnelRuntime.Timing {
  let base = ContinuousClock.now
  return TunnelRuntime.Timing(now: { base + clock.now }, sleep: clock.sleep)
}

private func name(_ signal: SupervisorSignal) -> String {
  switch signal {
  case .connecting: "connecting"
  case .opened: "opened"
  case .frame: "frame"
  case .oversized: "oversized"
  case .dropped: "dropped"
  case .unauthorized: "unauthorized"
  case .sessionGone: "sessionGone"
  }
}

/// One supervisor over the fake transport, with an artificial clock, a shared threshold and a signal log.
private final class SupervisorRig: Sendable {
  let transport = FakeTransport()
  let clock = FakeTunnelClock()
  let threshold = StallThreshold()
  let timing: TunnelRuntime.Timing
  private let log = Mutex<[String]>([])

  init(silentOpen: Bool = false, hangOpen: Bool = false) {
    timing = streamTiming(clock)
    transport.set {
      $0.silentOpen = silentOpen
      $0.hangOpen = hangOpen
    }
  }

  var signals: [String] { log.withLock { $0 } }

  func count(_ signal: String) -> Int { signals.filter { $0 == signal }.count }

  func run(_ scope: StreamScope = .global) -> Task<Void, Never> {
    let supervisor = StreamSupervisor(
      scope: scope, transport: transport,
      timing: CoreTiming(backoffMin: .milliseconds(10), backoffMax: .milliseconds(40)),
      render: ServerText.renderer(language: .current), threshold: threshold, clock: timing
    ) { [self] signal in
      log.withLock { $0.append(name(signal)) }
    }
    return Task { await supervisor.run(cursor: nil) }
  }

  /// Steps the clock once something sleeps on it, then lets the loop run.
  func advance(_ duration: Duration, sourceLocation: SourceLocation = #_sourceLocation) async throws {
    #expect(await clock.waitForSleepers(1), "nothing waits on the clock", sourceLocation: sourceLocation)
    clock.advance(by: duration)
    try await Task.sleep(for: .milliseconds(30))
  }
}

@Suite("stream loop: stall guard and online from the first byte", .timeLimit(.minutes(1)))
struct StreamSupervisorTests {
  @Test("after hello with heartbeatMs 10000 a silent stream drops at 15 s, then the next attempt goes out")
  func silentStreamDrops() async throws {
    let rig = SupervisorRig()
    rig.threshold.apply(try hello(#","heartbeatMs":10000"#))
    let loop = rig.run()
    try await eventually("opened") { rig.count("opened") == 1 }
    try await rig.advance(.milliseconds(14_900))
    #expect(rig.count("dropped") == 0)
    try await rig.advance(.milliseconds(200))
    try await eventually("dropped") { rig.count("dropped") == 1 }
    try await rig.advance(.milliseconds(50))
    try await eventually("next attempt") { rig.transport.streamCalls.count == 2 }
    loop.cancel()
  }

  @Test("a ping every 10 s → no drop for 60 s")
  func pingsKeepStream() async throws {
    let rig = SupervisorRig()
    rig.threshold.apply(try hello(#","heartbeatMs":10000"#))
    let loop = rig.run()
    try await eventually("opened") { rig.count("opened") == 1 }
    for _ in 0..<6 {
      rig.clock.advance(by: .seconds(10))
      rig.transport.emit(.global, .comment(" ping"))
      try await Task.sleep(for: .milliseconds(10))
    }
    #expect(rig.count("dropped") == 0)
    #expect(rig.transport.streamCalls.count == 1)
    loop.cancel()
  }

  @Test("bytes of an unfinished frame flowing for 20 s → no drop")
  func slowFrameKeepsStream() async throws {
    let rig = SupervisorRig()
    rig.threshold.apply(try hello(#","heartbeatMs":10000"#))
    let loop = rig.run()
    try await eventually("opened") { rig.count("opened") == 1 }
    for _ in 0..<20 {
      rig.clock.advance(by: .seconds(1))
      rig.transport.trickle(.global)
      try await Task.sleep(for: .milliseconds(5))
    }
    #expect(rig.count("dropped") == 0)
    #expect(rig.count("frame") == 0, "the frame is not complete")
    loop.cancel()
  }

  @Test("hello without the field or with a value outside the range → threshold 60 s", arguments: [
    "", #","heartbeatMs":999"#, #","heartbeatMs":60001"#,
  ])
  func fallbackThreshold(heartbeat: String) async throws {
    let rig = SupervisorRig()
    rig.threshold.apply(try hello(#","heartbeatMs":10000"#))
    rig.threshold.apply(try hello(heartbeat))
    let loop = rig.run()
    try await eventually("opened") { rig.count("opened") == 1 }
    try await rig.advance(.milliseconds(59_900))
    #expect(rig.count("dropped") == 0)
    try await rig.advance(.milliseconds(200))
    try await eventually("dropped at 60 s") { rig.count("dropped") == 1 }
    loop.cancel()
  }

  @Test("open session stream: hello 60 → 15 s drops it at 15 s, 15 → 60 s keeps it past 15 s")
  func openSessionStreamTakesNewThreshold() async throws {
    let scope = StreamScope.session(id: "s1")
    let lower = SupervisorRig()
    let lowerLoop = lower.run(scope)
    try await eventually("opened") { lower.count("opened") == 1 }
    try await lower.advance(.seconds(5))
    lower.threshold.apply(try hello(#","heartbeatMs":10000"#))
    try await lower.advance(.milliseconds(9_900))
    #expect(lower.count("dropped") == 0)
    try await lower.advance(.milliseconds(200))
    try await eventually("dropped at 15 s") { lower.count("dropped") == 1 }
    lowerLoop.cancel()

    let raise = SupervisorRig()
    raise.threshold.apply(try hello(#","heartbeatMs":10000"#))
    let raiseLoop = raise.run(scope)
    try await eventually("opened") { raise.count("opened") == 1 }
    try await raise.advance(.seconds(10))
    raise.threshold.apply(try hello(""))
    try await raise.advance(.milliseconds(5_100))
    #expect(raise.count("dropped") == 0, "15 s passed, the threshold is 60 s now")
    try await raise.advance(.seconds(45))
    try await eventually("dropped at 60 s") { raise.count("dropped") == 1 }
    raiseLoop.cancel()
  }

  @Test("headers without a body byte: the stream stays connecting, then drops at the threshold")
  func headersOnlyStaysConnecting() async throws {
    let rig = SupervisorRig(silentOpen: true)
    let loop = rig.run()
    try await eventually("stream call") { rig.transport.streamCalls.count == 1 }
    try await Task.sleep(for: .milliseconds(50))
    #expect(rig.signals == ["connecting"])
    try await rig.advance(.milliseconds(60_100))
    try await eventually("dropped") { rig.count("dropped") == 1 }
    #expect(rig.count("opened") == 0)
    loop.cancel()
  }

  @Test("the first body byte opens the stream: `retry:` or a part of a frame")
  func firstByteOpens() async throws {
    let retry = SupervisorRig(silentOpen: true)
    let retryLoop = retry.run()
    try await eventually("stream call") { retry.transport.streamCalls.count == 1 }
    try await Task.sleep(for: .milliseconds(30))
    #expect(retry.count("opened") == 0)
    retry.transport.emit(.global, .retry(3000))
    try await eventually("opened after retry:") { retry.signals == ["connecting", "opened"] }
    retryLoop.cancel()

    let partial = SupervisorRig(silentOpen: true)
    let partialLoop = partial.run()
    try await eventually("stream call") { partial.transport.streamCalls.count == 1 }
    partial.transport.trickle(.global)
    try await eventually("opened after the first byte") { partial.signals == ["connecting", "opened"] }
    partialLoop.cancel()
  }

  @Test("the guard interrupts, the transport then throws .cancelled → dropped and the next attempt")
  func guardInterruptIsDrop() async throws {
    let rig = SupervisorRig(hangOpen: true)
    let loop = rig.run()
    try await eventually("stream call") { rig.transport.streamCalls.count == 1 }
    try await rig.advance(.milliseconds(60_100))
    try await eventually("dropped") { rig.count("dropped") == 1 }
    try await rig.advance(.milliseconds(50))
    try await eventually("next attempt") { rig.transport.streamCalls.count == 2 }
    loop.cancel()
  }

  @Test("loop cancelled during the countdown → it ends without a retry and without a late frame")
  func cancelDuringCountdown() async throws {
    let rig = SupervisorRig()
    let loop = rig.run()
    try await eventually("opened") { rig.count("opened") == 1 }
    #expect(await rig.clock.waitForSleepers(1))
    loop.cancel()
    await loop.value
    rig.transport.push(.global, json: helloJSON(""))
    rig.clock.advance(by: .seconds(120))
    try await Task.sleep(for: .milliseconds(50))
    #expect(rig.signals == ["connecting", "opened"])
    #expect(rig.transport.streamCalls.count == 1)
  }
}

@MainActor
@Suite("stream loop in the store: hello sets the threshold of both streams", .timeLimit(.minutes(1)))
struct StreamSupervisorStoreTests {
  static let viewed = "herdr-w4-p9"

  /// Store on the artificial stream clock, logged in, with the list known and the session stream of `viewed` open.
  private func openStore() async throws -> (RarogStore, FakeTransport, FakeTunnelClock) {
    let (store, transport) = makeStore()
    let clock = FakeTunnelClock()
    store.streamClock = streamTiming(clock)
    await store.start()
    await until("online") { store.state.global == .online }
    try transport.pushGolden(.global, "sessions-snapshot.max.json")
    store.openSession(Self.viewed)
    await until("session stream online") { store.state.sessionStream == .online }
    return (store, transport, clock)
  }

  private func step(_ clock: FakeTunnelClock, _ duration: Duration) async throws {
    #expect(await clock.waitForSleepers(2), "both stream guards wait")
    clock.advance(by: duration)
    try await Task.sleep(for: .milliseconds(30))
  }

  @Test("hello with heartbeatMs 10000 on the global stream → both silent streams drop at 15 s")
  func helloSetsBothStreams() async throws {
    let (store, transport, clock) = try await openStore()
    transport.push(.global, json: helloJSON(#","heartbeatMs":10000"#))
    await until("threshold 15 s") { store.stallThreshold.current == .seconds(15) }
    try await step(clock, .milliseconds(14_900))
    #expect(store.state.global == .online && store.state.sessionStream == .online)
    clock.advance(by: .milliseconds(200))
    await until("both dropped") {
      if case .offline = store.state.global, case .offline = store.state.sessionStream { return true }
      return false
    }
  }

  @Test("open session stream: a later hello lowers its threshold 60 → 15 s")
  func laterHelloReachesSessionStream() async throws {
    let (store, transport, clock) = try await openStore()
    try await step(clock, .seconds(5))
    transport.push(.global, json: helloJSON(#","heartbeatMs":10000"#))
    await until("threshold 15 s") { store.stallThreshold.current == .seconds(15) }
    try await step(clock, .milliseconds(9_900))
    #expect(store.state.sessionStream == .online)
    clock.advance(by: .milliseconds(200))
    await until("session stream dropped at 15 s") {
      if case .offline = store.state.sessionStream { return true }
      return false
    }
  }

  @Test("a stream cut at the parser's ceiling leaves a kontrakt line in client.log, not only a drop")
  func oversizedReachesClientLog() async throws {
    let (store, transport, _) = try await openStore()
    let session = StreamScope.session(id: Self.viewed)
    transport.emit(session, .oversized(.event))
    transport.end(session)
    let line = ContractReporter.line(for: .event)
    #expect(line.hasPrefix("kontrakt: "))
    await until("the line in client.log") {
      transport.read { $0.clientLogs.flatMap(\.events).map(\.msg) }.contains(line)
    }
    await until("the session stream dropped") {
      if case .offline = store.state.sessionStream { return true }
      return false
    }
  }

  enum Interruption: String, CaseIterable, Sendable {
    case background, otherSession, logout
  }

  @Test("background, another session or logout during the countdown → no retry, no late frame", arguments:
    Interruption.allCases)
  func interruptionDuringCountdown(_ interruption: Interruption) async throws {
    let (store, transport, clock) = try await openStore()
    transport.push(.global, json: helloJSON(#","heartbeatMs":10000"#))
    await until("threshold 15 s") { store.stallThreshold.current == .seconds(15) }
    #expect(await clock.waitForSleepers(2))
    let before = transport.streamCalls
    switch interruption {
    case .background: store.setScenePhase(.background)
    case .otherSession: store.openSession("herdr-w3-p6")
    case .logout: store.handleUnauthorized()
    }
    // A late hello on a stopped global stream would set a 30 s threshold.
    if interruption != .otherSession { transport.push(.global, json: helloJSON(#","heartbeatMs":20000"#)) }
    clock.advance(by: .seconds(120))
    try await Task.sleep(for: .milliseconds(80))
    switch interruption {
    case .background:
      #expect(transport.streamCalls == before)
      #expect(store.state.global == .idle && store.state.sessionStream == .idle)
      #expect(store.stallThreshold.current == .seconds(15))
    case .otherSession:
      #expect(transport.streamCalls.filter { $0.scope == .session(id: Self.viewed) }.count == 1)
      #expect(transport.streamCalls.contains { $0.scope == .session(id: "herdr-w3-p6") }, "the new session streams")
      #expect(store.stallThreshold.current == .seconds(15))
    case .logout:
      #expect(transport.streamCalls == before)
      #expect(store.stallThreshold.current == .seconds(60), "logout resets the threshold")
    }
  }
}

@Suite("stream loop over the iroh tunnel: the stall guard counts bytes of the shared client", .timeLimit(.minutes(2)))
struct StreamSupervisorTunnelTests {
  @Test("silent SSE through the tunnel → dropped at the threshold and a second GET on the same route")
  func silentTunnelStream() async throws {
    let rig = SwitchRig.make(respond: { request in
      guard request.path == "/api/stream" else { return nil }
      let headers = [("Content-Type", "text/event-stream"), ("Transfer-Encoding", "chunked")]
      return FakeHTTPResponse(headers: headers) { stream in
        try await stream.write(Data("d\r\nretry: 3000\n\n\r\n".utf8))
        _ = try await stream.readToEnd()
      }
    })
    await rig.runtime.scene(.active)
    // The guard runs on its own clock, so the drop cannot come from tunnel timers.
    let clock = FakeTunnelClock()
    let signals = Mutex<[String]>([])
    let supervisor = StreamSupervisor(
      scope: .global, transport: rig.switching,
      timing: CoreTiming(backoffMin: .milliseconds(10), backoffMax: .milliseconds(40)),
      render: ServerText.renderer(language: .current), clock: streamTiming(clock)
    ) { signal in
      signals.withLock { $0.append(name(signal)) }
    }
    let loop = Task { await supervisor.run(cursor: nil) }
    try await eventually("opened") { signals.withLock { $0.contains("opened") } }
    #expect(await clock.waitForSleepers(1))
    clock.advance(by: .milliseconds(59_900))
    try await Task.sleep(for: .milliseconds(50))
    #expect(!signals.withLock { $0.contains("dropped") })
    clock.advance(by: .milliseconds(200))
    try await eventually("dropped") { signals.withLock { $0.contains("dropped") } }
    #expect(await clock.waitForSleepers(1))
    clock.advance(by: .seconds(4))
    try await eventually("second GET") { rig.served.count("GET /api/stream") == 2 }
    #expect(rig.switching.routeStamp == 1, "the same tunnel generation")
    loop.cancel()
    try await rig.shutdown()
  }
}
