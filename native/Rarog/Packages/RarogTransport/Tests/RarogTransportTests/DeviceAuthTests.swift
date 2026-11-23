import Foundation
import RarogContract
import RarogContractFixtures
import RarogTransport
import Testing

// Klucz urządzenia w transporcie: nagłówek `Authorization: Rarog-Device` w REST, SSE, wysyłce,
// zdjęciach i upgrade'zie gniazda terminala, parowanie bez poświadczeń i poza bramką zgodności, zatrzask
// odmowy 401 i Keychain na atrapie. Odpowiedzi ze złotych plików `shared/fixtures/rest/`.

private let credential = DeviceCredential(
  deviceId: "03030303030303030303030303030303", secret: "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ",
  serverURL: URL(string: "http://127.0.0.1:1")!, serverId: "01010101010101010101010101010101",
  serverName: "mac-demo", label: "iPhone·Rarog", kid: "f849d673", pairedAt: Date(timeIntervalSince1970: 1_792_000_000))
private let header = "Rarog-Device 03030303030303030303030303030303.BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ"

private func golden(_ name: String) throws -> String {
  let url = try GoldenFrames.repoRoot().appending(path: "shared/fixtures/rest/\(name)")
  return try String(contentsOf: url, encoding: .utf8)
}

/// Bramka, która odmawia KAŻDEJ mutacji (apka „za stara”, brak `hello`) — parowanie ma ją ominąć.
private struct RefusingPolicy: MutationPolicy {
  func compatibilityRefusal() async -> PolicyRefusal? {
    PolicyRefusal("Brak połączenia z serwerem — spróbuj za chwilę.")
  }
  func sessionRefusal(sessionId: String, route: String) async -> PolicyRefusal? { nil }
}

/// Klient z kluczem urządzenia na atrapie (`device: nil` = klient bez poświadczenia).
private struct DeviceHarness {
  let port: Int
  let client: RarogClient

  init(device: DeviceCredential? = credential, policy: any MutationPolicy = AllowAllMutations(),
       handler: @escaping MockURLProtocol.Handler) {
    port = MockURLProtocol.register(handler)
    let config = RarogConfig.test(port: port, build: 42, clientLabel: "iPhone·Rarog")
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [MockURLProtocol.self]
    var bound = device
    bound?.serverURL = config.baseURL
    client = RarogClient(config: config, policy: policy, configuration: configuration, device: bound)
  }

  var requests: [MockURLProtocol.Recorded] { MockURLProtocol.requests(port: port) }
}

@Suite("klucz urządzenia w transporcie")
struct DeviceAuthTests {
  @Test("REST: Authorization z kluczem; Origin przy mutacji")
  func restHeader() async throws {
    let harness = DeviceHarness { _ in .json(204, "") }
    _ = try await harness.client.perform(.get("/api/version"))
    try await harness.client.presence(PresenceBody(clientId: "c", visible: true, sessionId: nil))
    #expect(harness.requests.count == 2)
    for request in harness.requests {
      #expect(request.header("Authorization") == header)
    }
    #expect(harness.requests.last?.header("Origin") == "http://127.0.0.1:\(harness.port)")
    #expect(harness.client.hasCredential)
  }

  @Test("SSE i wysyłka: ten sam nagłówek")
  func streamAndSend() async throws {
    let harness = DeviceHarness { request in
      if request.path.hasPrefix("/api/stream") {
        return MockURLProtocol.Reply(
          status: 200, headers: ["Content-Type": "text/event-stream"],
          chunks: [Data("data: {}\n\n".utf8)])
      }
      return .json(202, #"{"ok":true}"#)
    }
    for try await _ in try await harness.client.openStream(.global) {}
    _ = try await harness.client.sendMessage(sessionId: "s1", MessageBody(text: "cześć"))
    #expect(harness.requests.map { $0.header("Authorization") } == [header, header])
  }

  @Test("gniazdo terminala: Authorization z kluczem; klient bez klucza bez poświadczenia")
  func terminalSocket() throws {
    let device = DeviceHarness { _ in .json(200, "{}") }
    let request = try device.client.terminalSocketRequest(id: "000284dd20c58f49", fresh: true, grid: nil)
    #expect(request.value(forHTTPHeaderField: "Authorization") == header)
    #expect(request.value(forHTTPHeaderField: "Origin") == "http://127.0.0.1:\(device.port)")
    let bare = DeviceHarness(device: nil) { _ in .json(200, "{}") }
    let unpaired = try bare.client.terminalSocketRequest(id: "000284dd20c58f49", fresh: true, grid: nil)
    #expect(unpaired.value(forHTTPHeaderField: "Authorization") == nil)
  }

  @Test("POST /api/pair: bez klucza, z Origin, poza bramką zgodności; odpowiedź ze złotego pliku")
  func pairWithoutCredentials() async throws {
    let reply = try golden("pair.json")
    for device in [credential, nil] as [DeviceCredential?] {
      let harness = DeviceHarness(device: device, policy: RefusingPolicy()) { _ in .json(200, reply) }
      let paired = try await harness.client.pair(PairBody(code: "kod", label: "iPhone·Rarog", build: 7))
      #expect(paired.deviceId == "03030303030303030303030303030303" && paired.server.id.count == 32)
      let request = try #require(harness.requests.first)
      #expect(request.method == "POST" && request.path == "/api/pair")
      #expect(request.header("Authorization") == nil)
      #expect(request.header("Origin") == "http://127.0.0.1:\(harness.port)")
      let sent = try JSONSerialization.jsonObject(with: try #require(request.body)) as? [String: AnyHashable]
      // Apka czyta format 3; serwer pole z parowania przyjmuje i nie używa (deklaracja idzie rejestracją
      // tokenu).
      #expect(sent == ["v": 1, "code": "kod", "label": "iPhone·Rarog", "build": "7", "pushFormats": [3]])
    }
    // Ta sama bramka zatrzymuje inne mutacje — wyjątek dotyczy wyłącznie parowania.
    let blocked = DeviceHarness(policy: RefusingPolicy()) { _ in .json(200, "{}") }
    await #expect(throws: TransportError.self) { _ = try await blocked.client.issuePairingCode() }
    #expect(blocked.requests.isEmpty)
  }

  @Test("POST /api/pair: 404 pair-unknown ze zdaniem serwera; odpowiedź spoza kontraktu bez treści w opisie")
  func pairRefusals() async throws {
    let unknown = try golden("error.pair-unknown.json")
    let refused = DeviceHarness(device: nil) { _ in .json(404, unknown) }
    do {
      _ = try await refused.client.pair(PairBody(code: "zly", label: "iPhone·Rarog", build: 7))
      Issue.record("oczekiwano odmowy")
    } catch {
      guard case let .http(failure) = error else { Issue.record("oczekiwano .http, jest \(error)"); return }
      #expect(failure.status == 404 && failure.code == "pair-unknown" && failure.message?.isEmpty == false)
    }
    // Odpowiedź z sekretem w złym kształcie: opis błędu nie cytuje ciała (sekret nie trafi do client.log).
    let broken = DeviceHarness(device: nil) { _ in .json(200, #"{"deviceId":"x","secret":"TAJNE"}"#) }
    do {
      _ = try await broken.client.pair(PairBody(code: "k", label: "iPhone·Rarog", build: 7))
      Issue.record("oczekiwano błędu kontraktu")
    } catch {
      #expect(!String(describing: error).contains("TAJNE"))
    }
  }

  @Test("trasy urządzenia: kod dla nowego urządzenia, lista, „Zapomnij serwer” — z kluczem i ze złotych plików")
  func deviceRoutes() async throws {
    let pairings = try golden("pairings.json")
    let devices = try golden("devices.json")
    let harness = DeviceHarness { request in
      switch request.path {
      case "/api/pairings": .json(200, pairings)
      case "/api/devices": .json(200, devices)
      default: .json(204, "")
      }
    }
    let issued = try await harness.client.issuePairingCode()
    #expect(!issued.code.isEmpty && !issued.expiresAt.isEmpty)
    let list = try await harness.client.devices()
    #expect(list.devices.map(\.label) == ["iPhone·Rarog", "iPad·Rarog"])
    try await harness.client.forgetDevice()
    #expect(harness.requests.map { "\($0.method) \($0.path)" }
      == ["POST /api/pairings", "GET /api/devices", "POST /api/devices/forget"])
    #expect(harness.requests.allSatisfy { $0.header("Authorization") == header })
    #expect(harness.requests.filter { $0.method == "POST" }.allSatisfy { $0.body == Data("{}".utf8) })
  }

  @Test("401 device-revoked → zatrzask z datą i przyczyną; późniejsze „nieznane” go nie nadpisuje")
  func revokedLatch() async throws {
    let revoked = try golden("error.device-revoked.json")
    let unknown = try golden("error.device-unknown.json")
    let first = DeviceHarness { _ in .json(401, revoked) }
    await #expect(throws: TransportError.self) { _ = try await first.client.version() }
    #expect(first.client.credentialRejection == .revoked(
      deviceId: "03030303030303030303030303030303", revokedAt: "2026-10-04T10:03:00.000Z", revokedBy: "admin"))
    let second = DeviceHarness { request in
      request.path == "/api/version" ? .json(401, unknown) : .json(401, revoked)
    }
    await #expect(throws: TransportError.self) { _ = try await second.client.usage() }
    await #expect(throws: TransportError.self) { _ = try await second.client.version() }
    guard case .revoked = second.client.credentialRejection else {
      Issue.record("revoked nadpisane przez \(String(describing: second.client.credentialRejection))")
      return
    }
  }

  @Test("401 device-unknown → „nieznane”, zdjęcie też zapisuje odmowę; klient bez klucza nie ma zatrzasku")
  func unknownLatch() async throws {
    let unknown = try golden("error.device-unknown.json")
    let harness = DeviceHarness { _ in .json(401, unknown) }
    await #expect(throws: TransportError.self) { _ = try await harness.client.uploadImage(sessionId: "s", file: "a.png") }
    #expect(harness.client.credentialRejection == .unknown(deviceId: "03030303030303030303030303030303"))
    let bare = DeviceHarness(device: nil) { _ in .json(401, #"{"error":"unauthorized","message":"x"}"#) }
    await #expect(throws: TransportError.self) { _ = try await bare.client.version() }
    #expect(bare.client.credentialRejection == nil)
    #expect(!bare.client.hasCredential)
  }

  @Test("opis poświadczenia i błędu nie zawiera sekretu")
  func noSecretInDescriptions() {
    #expect(!String(describing: credential).contains(credential.secret))
    #expect(!String(reflecting: credential).contains(credential.secret))
    #expect(credential.authorization == header)
    #expect(credential.account == "127.0.0.1:1")
  }

  @Test("poświadczenie tylko przez iroh: konto iroh:<id>, nagłówek ten sam, opis bez sekretu")
  func irohOnlyCredential() {
    let endpointId = "523c7996bad77424e96786cf7a7205115337a5b4565cd25506a0f297b191a5ea"
    var irohOnly = credential
    irohOnly.serverURL = nil
    irohOnly.iroh = ServerIrohConfig(endpointId: endpointId, relay: URL(string: "https://relay.rarog.ai/")!)
    #expect(irohOnly.account == "iroh:\(endpointId)")
    #expect(irohOnly.authorization == header)
    #expect(!String(describing: irohOnly).contains(irohOnly.secret) && String(describing: irohOnly).contains("iroh:"))
    var both = irohOnly
    both.serverURL = URL(string: "https://RAROG.example:8443")!
    #expect(both.account == "rarog.example:8443", "adres HTTPS wygrywa: konto jak przed iroh")
  }
}

@Suite("Keychain klucza urządzenia na atrapie")
struct MemoryKeychainTests {
  @Test("zapis i odczyt; kasowanie cudzego deviceId nie rusza bieżącego klucza; nil kasuje wszystko")
  func lifecycle() throws {
    let keychain = MemoryKeychain()
    #expect(keychain.load() == .none)
    #expect(try keychain.save(credential, pushKey: "BQUF"))
    #expect(keychain.load() == .found(credential, pushKey: "BQUF"))
    #expect(keychain.snapshot.shared == ["f849d673": "BQUF"])
    #expect(!keychain.delete(deviceId: "08080808080808080808080808080808"), "spóźnione 401 starego klucza")
    #expect(keychain.load() == .found(credential, pushKey: "BQUF"))
    #expect(keychain.delete(deviceId: credential.deviceId))
    #expect(keychain.load() == .none && keychain.snapshot.shared.isEmpty)
  }

  @Test("zablokowany telefon to nie brak klucza; odmowa zapisu rzuca; brak grupy współdzielonej nie przerywa")
  func failures() throws {
    let keychain = MemoryKeychain(.init(credential: credential, pushKey: "BQUF"))
    keychain.update { $0.locked = true }
    #expect(keychain.load() == .locked)
    keychain.update {
      $0.locked = false
      $0.saveFailure = -25_308
    }
    #expect(throws: KeychainFailure(status: -25_308)) { try keychain.save(credential, pushKey: "X") }
    keychain.update {
      $0.saveFailure = nil
      $0.sharedFailure = true
    }
    #expect(try !keychain.save(credential, pushKey: "Y"))
    #expect(keychain.load() == .found(credential, pushKey: "Y"), "kopia klucza push zostaje we wpisie apki")
  }

  @Test("zapis w miejscu: odmowa zostawia stary wpis; brak grupy współdzielonej — nowy wpis prywatny, false, bez wycofania")
  func inPlaceSave() throws {
    let keychain = MemoryKeychain(.init(credential: credential, pushKey: "BQUF"))
    var updated = credential
    updated.serverSystem = .linux
    updated.iroh = ServerIrohConfig(
      endpointId: "523c7996bad77424e96786cf7a7205115337a5b4565cd25506a0f297b191a5ea",
      relay: URL(string: "https://relay.rarog.ai/")!)
    keychain.update { $0.saveFailure = -25_308 }
    #expect(throws: KeychainFailure(status: -25_308)) { try keychain.save(updated, pushKey: "BQUF") }
    #expect(keychain.load() == .found(credential, pushKey: "BQUF"), "stary wpis prywatny")
    #expect(keychain.snapshot.shared == ["f849d673": "BQUF"])
    keychain.update {
      $0.saveFailure = nil
      $0.sharedFailure = true
      $0.sharedWrites = 0
    }
    #expect(try !keychain.save(updated, pushKey: "BQUF"))
    #expect(keychain.load() == .found(updated, pushKey: "BQUF"), "nowy wpis prywatny obowiązuje")
    #expect(keychain.snapshot.sharedWrites == 0, "grupa współdzielona nietknięta: klucz push z kopii prywatnej")
  }

  @Test("klucz push po `kid`: wpis współdzielony, bez niego kopia prywatna przy zgodnym `kid`; inny `kid` — nic")
  func pushKeyReader() {
    let keychain = MemoryKeychain(.init(credential: credential, pushKey: "BQUF"))
    #expect(keychain.pushKey(kid: "f849d673") == .found(Data("BQUF".utf8)))
    #expect(keychain.pushKey(kid: "00000000") == PushKeyRead.none)
    // Grupa współdzielona pusta (build bez uprawnienia, wpis jeszcze nie odtworzony): apka czyta kopię z wpisu prywatnego.
    keychain.update { $0.shared = [:] }
    #expect(keychain.pushKey(kid: "f849d673") == .found(Data("BQUF".utf8)))
    #expect(keychain.pushKey(kid: "00000000") == PushKeyRead.none, "kopia prywatna tylko przy zgodnym kid")
    keychain.update { $0.locked = true }
    #expect(keychain.pushKey(kid: "f849d673") == .locked, "przed pierwszym odblokowaniem to nie brak klucza")
  }

  @Test("odczyt klucza push bez skutków ubocznych: nieczytelny wpis prywatny zostaje (kasuje dopiero load)")
  func pushKeyReadHasNoSideEffects() {
    let keychain = MemoryKeychain(.init(credential: credential, pushKey: "BQUF"))
    keychain.update { $0.unreadable = true }
    let before = keychain.snapshot
    #expect(keychain.pushKey(kid: "f849d673") == .found(Data("BQUF".utf8)), "wpis współdzielony dalej czytelny")
    #expect(keychain.pushKey(kid: "00000000") == PushKeyRead.none)
    #expect(keychain.snapshot == before, "odczyt niczego nie skasował ani nie zapisał")
    keychain.update { $0.shared = [:] }
    #expect(keychain.pushKey(kid: "f849d673") == PushKeyRead.none, "nieczytelna kopia prywatna to brak klucza")
    #expect(keychain.snapshot.credential == credential)
    // `load()` (apka, nie NSE) kasuje nieczytelny wpis — razem z wpisem współdzielonym, jak `SystemKeychain`.
    #expect(keychain.load() == .none)
    #expect(keychain.snapshot.credential == nil && keychain.snapshot.shared.isEmpty)
  }

  @Test("odtworzenie wpisu współdzielonego z kopii prywatnej: idempotentne; grupa odmawia — false, kopia zostaje")
  func restoreShared() {
    let keychain = MemoryKeychain(.init(credential: credential, pushKey: "BQUF"))
    keychain.update {
      $0.shared = [:]
      $0.sharedWrites = 0
    }
    #expect(keychain.restoreSharedPushKey(kid: "f849d673", pushKey: "BQUF"))
    #expect(keychain.snapshot.shared == ["f849d673": "BQUF"] && keychain.snapshot.sharedWrites == 1)
    #expect(keychain.restoreSharedPushKey(kid: "f849d673", pushKey: "BQUF"))
    #expect(keychain.snapshot.sharedWrites == 1, "drugi raz bez zapisu")
    // Inny `kid` (ponowne parowanie): stary wpis znika jak przy parowaniu.
    #expect(keychain.restoreSharedPushKey(kid: "0a0b0c0d", pushKey: "CQkJ"))
    #expect(keychain.snapshot.shared == ["0a0b0c0d": "CQkJ"] && keychain.snapshot.sharedWrites == 2)

    let refusing = MemoryKeychain(.init(credential: credential, pushKey: "BQUF"))
    refusing.update {
      $0.shared = [:]
      $0.sharedFailure = true
    }
    #expect(!refusing.restoreSharedPushKey(kid: "f849d673", pushKey: "BQUF"))
    #expect(refusing.snapshot.shared.isEmpty && refusing.load() == .found(credential, pushKey: "BQUF"))
  }
}
