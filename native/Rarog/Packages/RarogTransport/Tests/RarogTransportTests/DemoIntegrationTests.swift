// Transport przeciw PRAWDZIWEMU serwerowi demo — domyślnie pominięty.
//
// Uruchomienie (port inny niż 8930 żywego Raroga; dataDir w katalogu tymczasowym):
//   P=18931; D=$(mktemp -d "$TMPDIR/rarog-demo.XXXXXX")
//   RAROG_DEMO=1 RAROG_PORT=$P RAROG_ORIGINS=http://127.0.0.1:$P RAROG_DATA_DIR=$D \
//     pnpm -C <repo> run demo:server &
//   RAROG_DEMO_PORT=$P swift test --package-path native/Rarog/Packages/RarogTransport
// Klucz urządzenia z parowania kodem z `POST /api/demo/pairing` (tylko `RAROG_DEMO=1`; odpina urządzenia demo,
// więc testy suity idą po kolei).
import Foundation
import RarogContract
import RarogTransport
import Testing

private let demoPort = ProcessInfo.processInfo.environment["RAROG_DEMO_PORT"].flatMap(Int.init)

@Suite("serwer demo: parowanie, wersja, SSE (RAROG_DEMO_PORT)", .serialized, .enabled(if: demoPort != nil))
struct DemoIntegrationTests {
  let config: RarogConfig
  /// Klient bez klucza: kod parowania z demo i `POST /api/pair`.
  let unpaired: RarogClient

  init() throws {
    let port = try #require(demoPort)
    #expect(port != 8930, "żywy Rarog — test celuje wyłącznie w demo")
    config = .test(port: port, build: 1, clientLabel: "test·Rarog")
    unpaired = RarogClient(config: config)
  }

  /// Kod z demo (`Origin` z konfiguracji, ciało `{}`) → `POST /api/pair` → klient z kluczem urządzenia.
  private func paired() async throws -> RarogClient {
    let issued = try await unpaired.perform(.post("/api/demo/pairing", json: [String: String]()))
    let fields = try JSONSerialization.jsonObject(with: issued.body) as? [String: Any]
    let code = try #require(fields?["code"] as? String, "odpowiedź demo bez kodu")
    let response = try await unpaired.pair(PairBody(code: code, label: config.clientLabel, build: 1))
    let device = DeviceCredential(pair: response, serverURL: config.baseURL, label: config.clientLabel, pairedAt: .now)
    return RarogClient(config: config, device: device)
  }

  @Test("zły kod → 404 pair-unknown; kod z demo → klucz; wersja z protokołem 3")
  func pairAndVersion() async throws {
    let error = await #expect(throws: TransportError.self) {
      _ = try await unpaired.pair(PairBody(code: "to-nie-kod", label: config.clientLabel, build: 1))
    }
    guard case let .http(failure)? = error else {
      Issue.record("oczekiwano 404, jest \(String(describing: error))")
      return
    }
    #expect(failure.status == 404 && failure.code == "pair-unknown")
    let client = try await paired()
    #expect(client.hasCredential)
    let version = try await client.version()
    #expect(version.protocolVersion == 3)
    // Mutacja z Origin z konfiguracji przechodzi bramkę serwera (RAROG_ORIGINS).
    try await client.presence(PresenceBody(clientId: "demo-it", visible: false))
  }

  @Test("SSE globalny: hello i sessions-snapshot bez degradacji; transkrypt pierwszej sesji też")
  func globalStream() async throws {
    let client = try await paired()
    let (hello, snapshot) = try await withTimeout(seconds: 15) { [client] in
      var hello: HelloEvent?
      var snapshot: SessionsSnapshotEvent?
      for try await output in try await client.openStream(.global) {
        guard case let .event(event) = output, event.type == "message" else { continue }
        let decoded = try EventDecoder.decode(Data(event.data.utf8)).get()
        #expect(decoded.degradations == [], "degradacje w \(decoded.event.wireType.rawValue)")
        switch decoded.event {
        case let .hello(value): hello = value
        case let .sessionsSnapshot(value): snapshot = value
        default: break
        }
        if let hello, let snapshot { return (hello, snapshot) }
      }
      throw DemoError("strumień skończył się przed hello i sessions-snapshot")
    }
    #expect(hello.protocolVersion == 3)
    #expect(!snapshot.sessions.isEmpty, "demo ma sesje z seedów")

    let first = try #require(snapshot.sessions.first { $0.outOfScope != true && $0.engine == nil })
    let transcript = try await withTimeout(seconds: 15) { [client] in
      for try await output in try await client.openStream(.session(id: first.id)) {
        guard case let .event(event) = output, event.type == "message" else { continue }
        let decoded = try EventDecoder.decode(Data(event.data.utf8)).get()
        #expect(decoded.degradations == [])
        if case let .transcriptSnapshot(value) = decoded.event { return value }
      }
      throw DemoError("brak transcript-snapshot")
    }
    #expect(transcript.sessionId == first.id)
  }
}

struct DemoError: Error, CustomStringConvertible {
  let description: String
  init(_ description: String) { self.description = description }
}

/// Wynik `body` albo błąd po `seconds` — strumień SSE z natury się nie kończy.
func withTimeout<T: Sendable>(
  seconds: Double, _ body: @escaping @Sendable () async throws -> T
) async throws -> T {
  try await withThrowingTaskGroup(of: T.self) { group in
    group.addTask { try await body() }
    group.addTask {
      try await Task.sleep(for: .seconds(seconds))
      throw DemoError("przekroczony czas \(seconds) s")
    }
    let result = try await group.next()!
    group.cancelAll()
    return result
  }
}
