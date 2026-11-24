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
  /// stays strict. The refusal does not know the server version, so the sentence carries the full chain with the
  /// install.
  @Test("serwer z niższym protokołem: zdanie podaje komendę aktualizacji serwera, nie samo rarog restart")
  func olderServerProtocolNamesUpdateCommand() throws {
    let compat = Compatibility.protocolMismatch(server: CoreLimits.protocolVersion - 1)
    #expect(compat.serverIsNewer == false)
    let refusal = try #require(compat.permanentRefusal(release: "1.0.1"))
    #expect(
      refusal == "Apka jest nowsza niż serwer — zaktualizuj serwer: npm i -g @rarog/server@latest && rarog update")
    #expect(refusal.hasSuffix(ServerRelease.installAndUpdateCommand))
    #expect(!refusal.contains("rarog restart"))
    #expect(CoreCopy.updateServer(release: "1.0.1") == refusal)
    let english = L("core.updateServer", language: .en, ServerRelease.installAndUpdateCommand)
    #expect(
      english == "The app is newer than the server. Update the server: npm i -g @rarog/server@latest && rarog update")
  }

  /// The release scripts rewrite ``ServerRelease/version`` to a beta or a stable version, so the default refusal is
  /// checked against an explicit call for that constant, not against the sentence of one channel.
  @Test("older server protocol without a release argument: the refusal follows the channel of the shipped release")
  func olderServerProtocolDefaultRelease() throws {
    let compat = Compatibility.protocolMismatch(server: CoreLimits.protocolVersion - 1)
    let refusal = try #require(compat.permanentRefusal)
    #expect(refusal == compat.permanentRefusal(release: ServerRelease.version))
    #expect(CoreCopy.updateServer == CoreCopy.updateServer(release: ServerRelease.version))
    #expect(refusal.hasSuffix(ServerRelease.unknownServerCommand(release: ServerRelease.version)))
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
      #expect(refusal == "Apka jest nowsza niż serwer — zaktualizuj serwer: \(betaChain)", "\(release)")
      #expect(CoreCopy.updateServer(release: release) == refusal)
    }
    #expect(
      L("core.updateServer", language: .en, betaChain)
        == "The app is newer than the server. Update the server: \(betaChain)")
    let stableRefusal =
      "Apka jest nowsza niż serwer — zaktualizuj serwer: npm i -g @rarog/server@latest && rarog update"
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
