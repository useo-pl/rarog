import Foundation
import RarogContract
import RarogTransport
@testable import RarogCore
import Testing

// Ślady diagnostyczne: własny budżet obok sufitu `kontrakt:`. Właściciel: łączność.

@MainActor
@Suite("ślady diagnostyczne")
struct DiagnosticsTraceTests {
  let now = Date(timeIntervalSince1970: 1_790_000_000)

  @Test("ślady nie zjadają sufitu 50 linii `kontrakt:`; własny budżet 20 na godzinę")
  func budgets() {
    let reporter = ContractReporter()
    for index in 0..<30 { reporter.recordTrace("powrót do apki po \(index) s", now: now) }
    #expect(reporter.pending.count == ContractReporter.traceCap)
    reporter.record((0..<60).map { "kontrakt: /sessions/state=v\($0)" })
    #expect(reporter.pending.count == ContractReporter.traceCap + ContractReporter.cap)
    reporter.recordTrace("po godzinie", now: now.addingTimeInterval(ContractReporter.traceWindow))
    #expect(reporter.pending.last == "po godzinie", "nowe okno, nowy budżet")
    reporter.recordTrace("zegar cofnięty", now: now.addingTimeInterval(-60))
    #expect(reporter.pending.last == "zegar cofnięty")
  }

  @Test("ślad z magazynu: jedna linia, bez treści po złamaniu wiersza, poziom debug, po zalogowaniu")
  func storeTrace() async throws {
    let (store, transport) = makeStore()
    store.trace("przerwanie (Esc): klawisz doszedł po 120 ms\nsekret")
    try await Task.sleep(for: .milliseconds(30))
    #expect(transport.read { $0.clientLogs.isEmpty }, "przed zalogowaniem ślad czeka")
    await store.start()
    await until("ślad wyszedł") { !transport.read { $0.clientLogs.isEmpty } }
    let events = transport.read { $0.clientLogs.flatMap(\.events) }
    #expect(events.map(\.msg) == ["przerwanie (Esc): klawisz doszedł po 120 ms"])
    #expect(events.map(\.level) == ["debug"])
  }

  @Test("voice agent lines have their own budget: the 21st ordinary line drops, voice agent lines pass up to 240")
  func voiceAgentBudget() {
    let reporter = ContractReporter()
    for index in 0..<21 { reporter.recordTrace("ordinary \(index)", now: now) }
    #expect(reporter.pending.count == ContractReporter.traceCap)
    for index in 0..<250 { reporter.recordTrace("voice-agent: speech started \(index)", budget: .voiceAgent, now: now) }
    #expect(ContractReporter.voiceAgentTraceCap == 240)
    #expect(reporter.pending.filter { $0.hasPrefix("voice-agent:") }.count == ContractReporter.voiceAgentTraceCap)
    reporter.recordTrace("voice-agent: after an hour", budget: .voiceAgent, now: now.addingTimeInterval(ContractReporter.traceWindow))
    #expect(reporter.pending.last == "voice-agent: after an hour", "new window, new budget")
  }

  @Test("connectivity lines have their own budget: a spent shared budget does not drop a tunnel drop")
  func connectivityBudget() {
    let reporter = ContractReporter()
    for index in 0..<ContractReporter.traceCap + 5 { reporter.recordTrace("ordinary \(index)", now: now) }
    reporter.recordTrace("tunnel: generation 1 (iroh) closed in foreground", budget: .connectivity, now: now)
    #expect(reporter.pending.last == "tunnel: generation 1 (iroh) closed in foreground")
    for index in 0..<ContractReporter.connectivityTraceCap + 5 {
      reporter.recordTrace("connection: line \(index)", budget: .connectivity, now: now)
    }
    #expect(reporter.pending.filter { !$0.hasPrefix("ordinary") }.count == ContractReporter.connectivityTraceCap)
    reporter.recordTrace("ordinary after", now: now)
    #expect(reporter.pending.filter { $0.hasPrefix("ordinary") }.count == ContractReporter.traceCap, "nor the reverse")
  }

  @Test("the end line of a conversation passes after the voice agent budget is spent")
  func voiceAgentEndOutsideBudget() {
    let reporter = ContractReporter()
    for index in 0..<ContractReporter.voiceAgentTraceCap {
      reporter.recordTrace("voice-agent: response \(index)", budget: .voiceAgent, now: now)
    }
    reporter.recordTrace("voice-agent: over budget", budget: .voiceAgent, now: now)
    #expect(reporter.pending.last == "voice-agent: response \(ContractReporter.voiceAgentTraceCap - 1)")
    reporter.recordTrace("voice-agent: ended closed after 1.0 s", budget: .voiceAgentEnd, now: now)
    #expect(reporter.pending.last == "voice-agent: ended closed after 1.0 s")
  }

  @Test("ordinary lines and voice agent lines do not eat each other's budget")
  func budgetsApart() {
    let reporter = ContractReporter()
    for index in 0..<30 { reporter.recordTrace("ordinary \(index)", now: now) }
    for index in 0..<ContractReporter.voiceAgentTraceCap {
      reporter.recordTrace("voice-agent: line \(index)", budget: .voiceAgent, now: now)
    }
    #expect(reporter.pending.count == ContractReporter.traceCap + ContractReporter.voiceAgentTraceCap)

    let other = ContractReporter()
    for index in 0..<ContractReporter.voiceAgentTraceCap + 10 {
      other.recordTrace("voice-agent: line \(index)", budget: .voiceAgent, now: now)
    }
    for index in 0..<ContractReporter.traceCap { other.recordTrace("ordinary \(index)", now: now) }
    #expect(other.pending.filter { $0.hasPrefix("ordinary") }.count == ContractReporter.traceCap)
  }

  @Test("store trace with the voice agent budget: past the shared budget, still behind the login gate")
  func storeVoiceAgentTrace() async throws {
    let (store, transport) = makeStore()
    for index in 0..<25 { store.trace("ordinary \(index)") }
    for index in 0..<25 { store.trace("voice-agent: speech started \(index)", budget: .voiceAgent) }
    store.trace("voice-agent: ended closed after 2.0 s", budget: .voiceAgentEnd)
    try await Task.sleep(for: .milliseconds(30))
    #expect(transport.read { $0.clientLogs.isEmpty }, "before login the lines wait")
    await store.start()
    await until("all lines out") { transport.read { $0.clientLogs.flatMap(\.events).count } >= 46 }
    let messages = transport.read { $0.clientLogs.flatMap(\.events) }.map(\.msg)
    #expect(messages.filter { $0.hasPrefix("ordinary") }.count == ContractReporter.traceCap)
    #expect(messages.filter { $0.hasPrefix("voice-agent:") }.count == 26)
  }
}
