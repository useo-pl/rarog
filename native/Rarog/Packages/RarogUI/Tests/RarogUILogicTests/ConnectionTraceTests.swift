import Foundation
import RarogCore
@testable import RarogUI
import Testing

// Trace of a stream's connection gap in `client.log`: tells which path lit the connecting card.
// Owner: connectivity.

@Suite("connection gap trace")
struct ConnectionTraceTests {
  private let t0 = Date(timeIntervalSince1970: 1_000_000)

  private func memory(_ steps: [(ConnectionStatus, TimeInterval)]) -> ConnectionMemory {
    var memory = ConnectionMemory()
    for (status, at) in steps { memory.observe(status, now: t0.addingTimeInterval(at)) }
    return memory
  }

  @Test("a return slower than the card delay: the gap, its cause and how long the gray card stood")
  func slowReturn() {
    let before = memory([(.connecting(since: t0), 0)])
    let line = DiagnosticsTrace.connection(.global, before: before, card: before.connectionCard, now: t0.addingTimeInterval(3.4))
    #expect(line == "connection: global online after 3400 ms, start or return, card gray 400 ms")
  }

  @Test("a short reconnect without a card gives no line; a visible card always does")
  func floor() {
    let before = memory([(.online, -10), (.connecting(since: t0), 0)])
    #expect(DiagnosticsTrace.connection(.global, before: memory([(.connecting(since: t0), 0)]), card: nil,
      now: t0.addingTimeInterval(0.9)) == nil)
    #expect(DiagnosticsTrace.connection(.global, before: before, card: before.connectionCard, now: t0.addingTimeInterval(0.3))
      == "connection: global online after 300 ms, dropped in use, card gray 300 ms")
    #expect(DiagnosticsTrace.connection(.global, before: memory([(.online, 0)]), card: nil, now: t0) == nil, "not away")
  }

  @Test("the session gap card: stalled transcript only while the global stream is online, else the delayed gray card")
  func sessionGapCard() {
    let failed = memory([(.connecting(since: t0), 0), (.offline(since: t0), 0.5)])
    #expect(failed.sessionGapCard(globalOnlineSince: t0.addingTimeInterval(-60)) == .transcriptStalled)
    #expect(failed.sessionGapCard(globalOnlineSince: nil) == nil, "the global stream is down: the banner was hidden")
    let slow = memory([(.connecting(since: t0), 0)])
    #expect(slow.sessionGapCard(globalOnlineSince: t0.addingTimeInterval(1))
      == .connecting(visibleFrom: t0.addingTimeInterval(1 + ConnectionMemory.sessionCardDelay)), "from the later moment")
  }

  @Test("a failed attempt names the red card; the session stream goes by the end of its id")
  func failedAndSession() {
    let failed = memory([(.connecting(since: t0), 0), (.offline(since: t0), 3.5)])
    #expect(DiagnosticsTrace.connection(.global, before: failed, card: failed.connectionCard, now: t0.addingTimeInterval(4))
      == "connection: global online after 4000 ms, after a failed attempt, card red")
    let quick = memory([(.connecting(since: t0), 0), (.offline(since: t0), 0.2), (.connecting(since: t0), 0.7)])
    #expect(DiagnosticsTrace.connection(.global, before: quick, card: quick.connectionCard, now: t0.addingTimeInterval(1.1))
      == "connection: global online after 1100 ms, start or return, a quick failed attempt, card none")
    let blink = memory([(.online, -60), (.connecting(since: t0), 0), (.offline(since: t0), 0.4), (.connecting(since: t0), 0.9)])
    #expect(DiagnosticsTrace.connection(.global, before: blink, card: blink.connectionCard, now: t0.addingTimeInterval(2.4))
      == "connection: global online after 2400 ms, dropped in use, a quick failed attempt, card gray 2400 ms")
    let retried = memory([(.online, -60), (.offline(since: t0), 0), (.connecting(since: t0), 0.5)])
    #expect(DiagnosticsTrace.connection(.global, before: retried, card: retried.connectionCard, now: t0.addingTimeInterval(1.2))
      == "connection: global online after 1200 ms, dropped in use, card gray 1200 ms", "the drop itself is no failed attempt")
    let session = memory([(.connecting(since: t0), 0)])
    #expect(DiagnosticsTrace.connection(.session("2f79c970-7119-5a77-aaea-f374c172714d"), before: session, card: nil,
      now: t0.addingTimeInterval(1.5)) == "connection: session …72714d online after 1500 ms, start or return, card none")
  }
}
