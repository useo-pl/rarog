import Foundation
import RarogContract
import RarogTransport
import RarogTransportTesting
import Synchronization
import Testing

/// Artificial clock, a shared threshold and one guard; `watching()` starts ``StreamStallGuard/stalled()``.
private struct GuardRig {
  let clock = FakeTunnelClock()
  let threshold = StallThreshold()
  let watch: StreamStallGuard
  let timing: TunnelRuntime.Timing

  /// - Parameter hook: runs once inside the next clock reading after it is armed.
  init(hook: NowHook? = nil) {
    let base = ContinuousClock.now
    let clock = clock
    timing = TunnelRuntime.Timing(now: {
      hook?.fire()
      return base + clock.now
    }, sleep: clock.sleep)
    watch = StreamStallGuard(threshold: threshold, timing: timing)
  }

  /// The watch in a task; ``Watching/fired`` turns true when `stalled()` returns.
  func watching() -> Watching {
    Watching(watch)
  }

  /// Steps the clock once the watch sleeps again, then lets it run.
  func advance(_ duration: Duration) async throws {
    #expect(await clock.waitForSleepers(1), "the watch is not waiting")
    clock.advance(by: duration)
    try await Task.sleep(for: .milliseconds(20))
  }
}

/// Work that runs inside one clock reading: a byte or a new threshold landing right while the guard reads the time.
private final class NowHook: Sendable {
  private let pending = Mutex<(@Sendable () -> Void)?>(nil)

  func arm(_ work: @escaping @Sendable () -> Void) { pending.withLock { $0 = work } }

  func fire() {
    let work = pending.withLock { state -> (@Sendable () -> Void)? in
      defer { state = nil }
      return state
    }
    work?()
  }
}

/// ``StreamStallGuard/stalled()`` running in a task.
private final class Watching: Sendable {
  private let flag = Mutex(false)
  private let task = Mutex<Task<Void, Never>?>(nil)

  init(_ watch: StreamStallGuard) {
    let running = Task { [self] in
      guard (try? await watch.stalled()) != nil else { return }
      flag.withLock { $0 = true }
    }
    task.withLock { $0 = running }
  }

  var fired: Bool { flag.withLock { $0 } }

  /// Waits (real time, up to 10 s) for `stalled()` to return: a loaded test process can lag well behind the clock.
  func firedSoon() async -> Bool {
    let deadline = ContinuousClock.now + .seconds(10)
    while !fired {
      guard ContinuousClock.now < deadline else { return false }
      try? await Task.sleep(for: .milliseconds(5))
    }
    return true
  }

  func cancel() { task.withLock { $0?.cancel() } }
}

private func hello(_ heartbeat: String) throws -> HelloEvent {
  let json = #"{"protocolVersion":3,"serverStartId":"s"\#(heartbeat)}"#
  return try JSONDecoder().decode(HelloEvent.self, from: Data(json.utf8))
}

@Suite("stall guard: threshold from hello, silence counted from the request or the last byte", .timeLimit(.minutes(1)))
struct StreamStallGuardTests {
  @Test("hello with heartbeatMs 10000 → 15 s; no field, below or above the valid range → 60 s")
  func thresholdFromHello() throws {
    let threshold = StallThreshold()
    #expect(threshold.current == .seconds(60), "before the first hello")
    threshold.apply(try hello(#","heartbeatMs":10000"#))
    #expect(threshold.current == .seconds(15))
    for other in ["", #","heartbeatMs":999"#, #","heartbeatMs":60001"#] {
      threshold.apply(try hello(#","heartbeatMs":10000"#))
      threshold.apply(try hello(other))
      #expect(threshold.current == .seconds(60), "hello\(other)")
    }
    threshold.apply(try hello(#","heartbeatMs":60000"#))
    #expect(threshold.current == .seconds(90))
    threshold.reset()
    #expect(threshold.current == .seconds(60), "logout or another server")
  }

  @Test("silence after the request → stalled at 15 s, not before")
  func silenceAfterRequest() async throws {
    let rig = GuardRig()
    rig.threshold.apply(try hello(#","heartbeatMs":10000"#))
    rig.watch.sent()
    let watching = rig.watching()
    try await rig.advance(.milliseconds(14_900))
    #expect(!watching.fired)
    try await rig.advance(.milliseconds(200))
    #expect(await watching.firedSoon())
    watching.cancel()
  }

  @Test("before the request goes out the guard is not armed: waiting for a route is not silence")
  func notArmedBeforeRequest() async throws {
    let rig = GuardRig()
    let watching = rig.watching()
    try await Task.sleep(for: .milliseconds(20))
    rig.clock.advance(by: .seconds(120))
    try await Task.sleep(for: .milliseconds(20))
    #expect(!watching.fired)
    rig.watch.sent()
    try await rig.advance(.milliseconds(59_900))
    #expect(!watching.fired)
    try await rig.advance(.milliseconds(200))
    #expect(await watching.firedSoon())
    watching.cancel()
  }

  @Test("a ping every 10 s at a 15 s threshold → not stalled for 60 s")
  func pingsKeepAlive() async throws {
    let rig = GuardRig()
    rig.threshold.apply(try hello(#","heartbeatMs":10000"#))
    rig.watch.sent()
    let watching = rig.watching()
    for _ in 0..<6 {
      rig.clock.advance(by: .seconds(10))
      rig.watch.received()
      try await Task.sleep(for: .milliseconds(10))
    }
    #expect(!watching.fired)
    try await rig.advance(.milliseconds(15_100))
    #expect(await watching.firedSoon(), "silence after the last ping")
    watching.cancel()
  }

  @Test("bytes of one unfinished frame flowing for 20 s → not stalled")
  func slowFrameKeepsAlive() async throws {
    let rig = GuardRig()
    rig.threshold.apply(try hello(#","heartbeatMs":10000"#))
    rig.watch.sent()
    rig.watch.received()
    let watching = rig.watching()
    for _ in 0..<20 {
      rig.clock.advance(by: .seconds(1))
      rig.watch.received()
      try await Task.sleep(for: .milliseconds(5))
    }
    #expect(!watching.fired)
    watching.cancel()
  }

  @Test("open stream: hello 60 → 15 s applies at once to a 60 s wait, 15 → 60 s lifts the 15 s deadline")
  func thresholdChangesWhileWaiting() async throws {
    let lower = GuardRig()
    lower.watch.sent()
    let lowerWatching = lower.watching()
    try await lower.advance(.seconds(20))
    #expect(!lowerWatching.fired)
    lower.threshold.apply(try hello(#","heartbeatMs":10000"#))
    try await Task.sleep(for: .milliseconds(20))
    #expect(await lowerWatching.firedSoon(), "20 s of silence is past the new 15 s threshold")
    lowerWatching.cancel()

    let raise = GuardRig()
    raise.threshold.apply(try hello(#","heartbeatMs":10000"#))
    raise.watch.sent()
    let raiseWatching = raise.watching()
    try await raise.advance(.seconds(10))
    raise.threshold.apply(try hello(""))
    try await raise.advance(.milliseconds(5_100))
    #expect(!raiseWatching.fired, "15 s passed, the threshold is 60 s now")
    try await raise.advance(.seconds(45))
    #expect(await raiseWatching.firedSoon())
    raiseWatching.cancel()
  }

  @Test("a byte that lands while the guard reads the clock at the deadline keeps the stream")
  func byteDuringClockReading() async throws {
    let hook = NowHook()
    let rig = GuardRig(hook: hook)
    rig.threshold.apply(try hello(#","heartbeatMs":10000"#))
    rig.watch.sent()
    let watching = rig.watching()
    #expect(await rig.clock.waitForSleepers(1))
    let watch = rig.watch
    hook.arm { watch.received() }
    try await rig.advance(.seconds(15))
    try await Task.sleep(for: .milliseconds(50))
    #expect(!watching.fired, "the byte came before the guard compared the time")
    try await rig.advance(.milliseconds(15_100))
    #expect(await watching.firedSoon(), "silence after that byte")
    watching.cancel()
  }

  @Test("a threshold raised 15 → 60 s while the guard reads the clock at the old deadline keeps the stream")
  func raiseDuringClockReading() async throws {
    let hook = NowHook()
    let rig = GuardRig(hook: hook)
    rig.threshold.apply(try hello(#","heartbeatMs":10000"#))
    rig.watch.sent()
    let watching = rig.watching()
    #expect(await rig.clock.waitForSleepers(1))
    let threshold = rig.threshold
    let fallback = try hello("")
    hook.arm { threshold.apply(fallback) }
    try await rig.advance(.seconds(15))
    try await Task.sleep(for: .milliseconds(50))
    #expect(!watching.fired, "the 60 s threshold came before the guard compared the time")
    try await rig.advance(.milliseconds(45_100))
    #expect(await watching.firedSoon(), "60 s of silence")
    watching.cancel()
  }

  @Test("first byte: true after a byte, false when the source ends without one or the wait is cancelled")
  func firstByte() async throws {
    let got = StreamStallGuard()
    got.sent()
    got.received()
    #expect(await got.firstByte())

    let empty = StreamStallGuard()
    empty.sent()
    let waiting = Task { await empty.firstByte() }
    try await Task.sleep(for: .milliseconds(20))
    empty.ended()
    #expect(await waiting.value == false)

    let cancelled = Task { await StreamStallGuard().firstByte() }
    try await Task.sleep(for: .milliseconds(20))
    cancelled.cancel()
    #expect(await cancelled.value == false)
  }

  @Test("RarogClient: bytes of an unfinished data line reach the guard before any parser output")
  func clientStampsBodyBytes() async throws {
    let harness = MockHarness { _ in
      MockURLProtocol.Reply(
        status: 200, headers: ["Content-Type": "text/event-stream"],
        chunks: [Data(#"data: {"type":"transcript-snapshot","messages":["#.utf8)])
    }
    let rig = GuardRig()
    var outputs: [SSEParser.Output] = []
    for try await output in try await harness.client.openStream(.global, watch: rig.watch) {
      outputs.append(output)
    }
    #expect(outputs.isEmpty, "the line never ended")
    let first = Task { await rig.watch.firstByte() }
    try await Task.sleep(for: .milliseconds(100))
    first.cancel()
    #expect(await first.value, "the guard heard the body bytes")
    let watching = rig.watching()
    try await rig.advance(.milliseconds(60_100))
    #expect(await watching.firedSoon(), "the request armed the guard")
    watching.cancel()
  }
}
