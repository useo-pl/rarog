import Foundation
import RarogContract
import RarogContractFixtures
@testable import RarogCore
import Testing

@Suite("odstęp ponownego łączenia")
struct BackoffTests {
  @Test("0,5 → 8 s podwajane; reset po udanym połączeniu; `retry:` podnosi dolną granicę w przedziale")
  func backoff() {
    var backoff = Backoff(min: .milliseconds(500), max: .seconds(8))
    let delays = (0..<6).map { _ in backoff.nextDelay() }
    #expect(delays == [.milliseconds(500), .seconds(1), .seconds(2), .seconds(4), .seconds(8), .seconds(8)])
    backoff.reset()
    #expect(backoff.nextDelay() == .milliseconds(500))
    backoff.serverSuggested(.seconds(3))
    backoff.reset()
    #expect(backoff.nextDelay() == .seconds(3))
    backoff.serverSuggested(.seconds(60))
    backoff.reset()
    #expect(backoff.nextDelay() == .seconds(8))
    backoff.serverSuggested(.milliseconds(1))
    backoff.reset()
    #expect(backoff.nextDelay() == .milliseconds(500))
  }
}

@MainActor
@Suite("raport kontrakt:")
struct ContractReporterTests {
  @Test("linie: ścieżka bez indeksów, wartość ≤ 40 znaków, odrzucenie z typem albo „?”")
  func lines() throws {
    let degraded = EventDecoder.decode(try GoldenFrames.shared.dataField("sessions-snapshot.unknown-many.json"))
    #expect(Set(ContractReporter.lines(for: degraded, data: Data())) == [
      "kontrakt: /sessions/engine=gemini", "kontrakt: /sessions/state=paused",
    ])
    let broken = try GoldenFrames.shared.dataField("hello.broken-json.json")
    #expect(ContractReporter.lines(for: EventDecoder.decode(broken), data: broken) == ["kontrakt: odrzucona ?"])
    let numeric = try GoldenFrames.shared.dataField("state.numeric-state.json")
    #expect(ContractReporter.lines(for: EventDecoder.decode(numeric), data: numeric) == ["kontrakt: odrzucona state"])
    let long = String(repeating: "x", count: 60)
    let frame = Data(#"{"type":"state","sessionId":"s","state":"\#(long)","since":"t"}"#.utf8)
    #expect(ContractReporter.lines(for: EventDecoder.decode(frame), data: frame) == ["kontrakt: /state=\(long.prefix(40))"])
  }

  @Test("bufor przed zalogowaniem wychodzi po uzbrojeniu; dedup pamięta tylko linię, która WYSZŁA; sufit 50")
  func bufferDedupCap() async {
    let reporter = ContractReporter()
    let sent = SentLog()
    reporter.record(["kontrakt: a"])
    await reporter.flush({ body in await sent.add(body) }, now: Date())
    #expect(await sent.count == 0, "nieuzbrojony nie wysyła")
    reporter.bind(Self.serverA)
    reporter.armed = true
    await reporter.flush({ _ in false }, now: Date())
    #expect(reporter.pending == ["kontrakt: a"], "porażka zostawia linię w buforze")
    await reporter.flush({ body in await sent.add(body) }, now: Date())
    #expect(reporter.reported == ["kontrakt: a"])
    reporter.record(["kontrakt: a"])
    #expect(reporter.pending.isEmpty, "linia, która wyszła, nie wraca")
    reporter.record((0..<80).map { "kontrakt: \($0)" })
    #expect(reporter.pending.count + reporter.reported.count == ContractReporter.cap)
  }

  @Test("linia dopisana w trakcie wysyłki jedzie następną partią, bez kolejnej ramki")
  func lineRecordedDuringFlush() async {
    let reporter = ContractReporter()
    reporter.bind(Self.serverA)
    reporter.armed = true
    reporter.record(["kontrakt: a"])
    let sent = SentLog()
    await reporter.flush({ body in
      if await sent.count == 0 { await MainActor.run { reporter.record(["kontrakt: b"]) } }
      return await sent.add(body)
    }, now: Date())
    let batches = await sent.bodies.map { $0.events.map(\.msg) }
    #expect(batches == [["kontrakt: a"], ["kontrakt: b"]])
    #expect(reporter.pending.isEmpty)
  }

  /// `CLIENT_LOG_MAX_REQUEST_BYTES` of `server/src/client-log.ts` (`export const … = <a> * <b>;`).
  static func serverRequestLimit() throws -> Int {
    let source = try String(
      contentsOf: GoldenFrames.repoRoot().appending(path: "server/src/client-log.ts"), encoding: .utf8)
    let match = try #require(source.firstMatch(of: #/export const CLIENT_LOG_MAX_REQUEST_BYTES = (\d+) \* (\d+);/#))
    return try #require(Int(match.output.1)) * #require(Int(match.output.2))
  }

  /// Bytes the server checks for a body: each event as a line with its `receivedAt` and the newline.
  static func serverBytes(_ body: ClientLogBody) throws -> Int {
    let added = #","receivedAt":"2026-11-25T20:05:55.496Z""#.utf8.count + 1
    return try body.events.reduce(0) { $0 + (try JSONEncoder().encode($1).count) + added }
  }

  // A queue gathered without a connection can grow past the server's ceiling. Sent as one body, it is refused whole,
  // and every later flush sends the same body again, so `client.log` stays blocked for good.
  @Test("a queue over the server's ceiling goes in several bodies under it; a failed body keeps itself and the rest")
  func flushSplitsAtServerCeiling() async throws {
    let limit = try Self.serverRequestLimit()
    #expect(ContractReporter.serverRequestLimit == limit)
    let reporter = ContractReporter()
    reporter.bind(Self.serverA)
    reporter.armed = true
    let now = Date()
    for index in 0..<ContractReporter.voiceAgentTraceCap {
      reporter.recordTrace("voice-agent: \(index) " + String(repeating: "ż", count: 190), budget: .voiceAgent, now: now)
    }
    let queued = reporter.pending
    let whole = ClientLogBody(events: queued.map { .init(at: "2026-11-25T20:05:55.209", level: "debug", msg: $0) })
    #expect(try Self.serverBytes(whole) > limit, "the queue alone is over the ceiling")

    let sent = SentLog()
    await reporter.flush({ body in await sent.add(body) }, now: now)
    let bodies = await sent.bodies
    #expect(bodies.count > 1)
    for body in bodies {
      #expect(try JSONEncoder().encode(body).count < limit)
      #expect(try Self.serverBytes(body) < limit)
    }
    #expect(bodies.flatMap { $0.events.map(\.msg) } == queued, "every line once, in order")
    #expect(reporter.pending.isEmpty)

    let failing = ContractReporter()
    failing.bind(Self.serverA)
    failing.armed = true
    for line in queued { failing.recordTrace(line, budget: .voiceAgent, now: now) }
    let attempts = SentLog()
    await failing.flush({ body in
      guard await attempts.count == 0 else { return false }
      return await attempts.add(body)
    }, now: now)
    let first = await attempts.bodies.first?.events.map(\.msg) ?? []
    #expect(!first.isEmpty && first.count < queued.count)
    #expect(failing.pending == Array(queued.dropFirst(first.count)), "the failed body and the ones after it wait")
  }

  @Test("a line longer than the batch allows goes cut to its first characters instead of blocking the queue")
  func flushCutsOversizedLine() async throws {
    let reporter = ContractReporter()
    reporter.bind(Self.serverA)
    reporter.armed = true
    reporter.record(["błąd: " + String(repeating: "\"", count: try Self.serverRequestLimit())])
    let sent = SentLog()
    await reporter.flush({ body in await sent.add(body) }, now: Date())
    let msgs = await sent.bodies.flatMap { $0.events.map(\.msg) }
    #expect(msgs.count == 1 && msgs[0].count == ContractReporter.maxLineCharacters && msgs[0].hasPrefix("błąd: "))
    #expect(reporter.pending.isEmpty)
  }

  static let serverA = ServerKey(serverURL: URL(string: "https://a.example"), iroh: nil)!
  static let serverB = ServerKey(serverURL: URL(string: "https://b.example"), iroh: nil)!

  @Test("a flush sends only its recipient's lines: the same text of A and B both queue, a late A line waits")
  func flushSendsOnlyTheRecipientsLines() async {
    let reporter = ContractReporter()
    let now = Date()
    reporter.bind(Self.serverA)
    reporter.record(["kontrakt: x"])
    reporter.retire()
    reporter.record(["kontrakt: x"], owner: .server(Self.serverB))
    reporter.recordTrace("trace", now: now, owner: .server(Self.serverB))
    reporter.recordTrace("trace", now: now, owner: .server(Self.serverB))
    reporter.bind(Self.serverB)
    reporter.armed = true
    reporter.recordTrace("late line of A", now: now, owner: .server(Self.serverA))
    let sent = SentLog()
    await reporter.flush({ body in await sent.add(body) }, now: now)
    #expect(await sent.bodies.map { $0.events.map(\.msg) } == [["kontrakt: x", "trace", "trace"]])
    #expect(reporter.pending == ["late line of A"], "A's line waits and no empty batch goes out")
  }

  @Test("a line with no server goes to the first login of the process; after it, such a line is dropped")
  func lineWithoutServerOnlyBeforeFirstLogin() async {
    let reporter = ContractReporter()
    reporter.record(["kontrakt: before any login"])
    reporter.bind(Self.serverA)
    reporter.armed = true
    let sent = SentLog()
    await reporter.flush({ body in await sent.add(body) }, now: Date())
    #expect(await sent.bodies.map { $0.events.map(\.msg) } == [["kontrakt: before any login"]])
    reporter.retire()
    reporter.record(["kontrakt: after a login"])
    reporter.recordTrace("tunnel: shared lease", now: Date(), owner: .server(nil))
    #expect(reporter.pending.isEmpty)
  }

  @Test("a pairing offer's lines wait under the offer, go to the paired server, and go with a closed offer")
  func offerLines() {
    let reporter = ContractReporter()
    reporter.bind(Self.serverA)
    reporter.retire()
    let first = reporter.openOffer()
    reporter.record(["kontrakt: while offered"])
    reporter.bind(Self.serverA)
    #expect(reporter.entries.map(\.stamp) == [.offer(first)], "a login keeps the open offer's lines")
    reporter.retire()
    reporter.resolveOffer(first, as: Self.serverB)
    #expect(reporter.entries.map(\.stamp) == [.server(Self.serverB)])
    let second = reporter.openOffer()
    reporter.record(["kontrakt: cancelled"], owner: .offer(second))
    reporter.closeOffer()
    reporter.record(["kontrakt: closed offer"], owner: .offer(second))
    #expect(reporter.pending == ["kontrakt: while offered"])
  }

  @Test("a retried pairing attempt drops the lines of the failed one; the sheet's lines go with the first attempt")
  func retriedAttemptDropsFailedLines() {
    let reporter = ContractReporter()
    let sheet = reporter.openOffer()
    reporter.record(["kontrakt: sheet"], owner: .offer(sheet))
    let first = reporter.attemptOffer()
    #expect(first == sheet)
    reporter.record(["kontrakt: failed attempt"], owner: .offer(first))
    let second = reporter.attemptOffer()
    #expect(second != first)
    reporter.record(["kontrakt: second attempt"], owner: .offer(second))
    reporter.resolveOffer(second, as: Self.serverB)
    #expect(reporter.pending == ["kontrakt: second attempt"])
  }

  actor SentLog {
    var bodies: [ClientLogBody] = []
    var count: Int { bodies.count }
    func add(_ body: ClientLogBody) -> Bool {
      bodies.append(body)
      return true
    }
  }
}

@Suite("zgodność: ocena po hello")
struct CompatibilityTests {
  @Test("protokół wygrywa z progiem; próg równy buildowi przepuszcza")
  func evaluate() throws {
    func hello(_ json: String) throws -> HelloEvent {
      try JSONDecoder().decode(HelloEvent.self, from: Data(json.utf8))
    }
    #expect(Compatibility.evaluate(try hello(#"{"protocolVersion":4,"serverStartId":"s","minClientBuild":99}"#), build: 7)
      == .protocolMismatch(server: 4))
    #expect(Compatibility.evaluate(try hello(#"{"protocolVersion":3,"serverStartId":"s","minClientBuild":7}"#), build: 7) == .ok)
    #expect(Compatibility.evaluate(try hello(#"{"protocolVersion":3,"serverStartId":"s","minClientBuild":8}"#), build: 7)
      == .tooOld(minClientBuild: 8))
    #expect(Compatibility.evaluate(try hello(#"{"protocolVersion":3,"serverStartId":"s"}"#), build: 1) == .ok)
  }

  /// With the app newer than the server `rarog restart` does not help, a server update does. The protocol comparison
  /// stays strict. The refusal does not know the server version, so the sentence names `rarog update` first (the
  /// update that checks the package's provenance) and the full chain with the install only for a server without it.
  @Test("older server protocol: the refusal names rarog update first, the install chain after it, never rarog restart")
  func olderServerProtocolNamesUpdateCommand() throws {
    let compat = Compatibility.protocolMismatch(server: CoreLimits.protocolVersion - 1)
    #expect(compat.serverIsNewer == false)
    let refusal = try #require(compat.permanentRefusal(release: "1.0.1"))
    #expect(
      refusal == "Apka jest nowsza niż serwer — zaktualizuj serwer: rarog update "
        + "(serwer bez tej komendy: npm i -g @rarog/server@latest && rarog update)")
    #expect(refusal.hasSuffix(ServerRelease.installAndUpdateCommand + ")"))
    #expect(!refusal.contains("rarog restart"))
    #expect(CoreCopy.updateServer(release: "1.0.1") == refusal)
    let english = L("core.updateServer", language: .en, "rarog update", ServerRelease.installAndUpdateCommand)
    #expect(
      english == "The app is newer than the server. Update the server: rarog update "
        + "(a server without this command: npm i -g @rarog/server@latest && rarog update)")
  }

  /// The release scripts rewrite ``ServerRelease/version`` to a beta or a stable version, so the default refusal is
  /// checked against an explicit call for that constant, not against the sentence of one channel.
  @Test("older server protocol without a release argument: the refusal follows the channel of the shipped release")
  func olderServerProtocolDefaultRelease() throws {
    let compat = Compatibility.protocolMismatch(server: CoreLimits.protocolVersion - 1)
    let refusal = try #require(compat.permanentRefusal)
    #expect(refusal == compat.permanentRefusal(release: ServerRelease.version))
    #expect(CoreCopy.updateServer == CoreCopy.updateServer(release: ServerRelease.version))
    #expect(refusal.hasSuffix(ServerRelease.unknownServerCommand(release: ServerRelease.version) + ")"))
    let commands = try #require(refusal.split(separator: ":", maxSplits: 1).last)
    #expect(commands.hasPrefix(" rarog update"), "the first command is rarog update in both channels")
  }

  /// A beta app ships with a beta server, which `@latest` does not install, so the refusal names the beta channel.
  @Test("older server protocol and a beta app: the refusal names the `@beta` chain with `--finish`")
  func olderServerProtocolBetaApp() throws {
    let compat = Compatibility.protocolMismatch(server: CoreLimits.protocolVersion - 1)
    let betaChain = "npm i -g @rarog/server@beta && rarog update --finish"
    let releases = ReleaseVersionCases.shared.beta
    #expect(!releases.isEmpty)
    for release in releases {
      let refusal = try #require(compat.permanentRefusal(release: release))
      #expect(
        refusal == "Apka jest nowsza niż serwer — zaktualizuj serwer: rarog update --beta "
          + "(serwer bez tej komendy: \(betaChain))", "\(release)")
      #expect(CoreCopy.updateServer(release: release) == refusal)
    }
    #expect(
      L("core.updateServer", language: .en, "rarog update --beta", betaChain)
        == "The app is newer than the server. Update the server: rarog update --beta "
        + "(a server without this command: \(betaChain))")
    let stableRefusal =
      "Apka jest nowsza niż serwer — zaktualizuj serwer: rarog update "
      + "(serwer bez tej komendy: npm i -g @rarog/server@latest && rarog update)"
    for release in ReleaseVersionCases.shared.stable {
      #expect(compat.permanentRefusal(release: release) == stableRefusal, "\(release)")
    }
    let newer = Compatibility.protocolMismatch(server: CoreLimits.protocolVersion + 1)
    #expect(newer.permanentRefusal(release: "1.2.0-beta.1") == CoreCopy.updateApp)
    #expect(Compatibility.ok.permanentRefusal(release: "1.2.0-beta.1") == nil)
  }

  @Test("serwer z wyższym protokołem i próg buildu: „zaktualizuj apkę” jak dotąd; równy protokół: ok bez odmowy")
  func otherDirectionsUnchanged() throws {
    let newer = Compatibility.protocolMismatch(server: CoreLimits.protocolVersion + 1)
    #expect(newer.serverIsNewer)
    #expect(newer.permanentRefusal == CoreCopy.updateApp)
    let hello = try JSONDecoder().decode(
      HelloEvent.self, from: Data(#"{"protocolVersion":3,"serverStartId":"s","minClientBuild":8}"#.utf8))
    let tooOld = Compatibility.evaluate(hello, build: 7)
    #expect(tooOld == .tooOld(minClientBuild: 8))
    #expect(tooOld.permanentRefusal == CoreCopy.updateApp)
    let equal = try JSONDecoder().decode(HelloEvent.self, from: Data(#"{"protocolVersion":3,"serverStartId":"s"}"#.utf8))
    #expect(Compatibility.evaluate(equal, build: 1) == .ok)
    #expect(Compatibility.ok.permanentRefusal == nil)
  }
}
