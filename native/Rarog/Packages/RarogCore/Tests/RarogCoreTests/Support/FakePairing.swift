import Foundation
import RarogContract
import RarogContractFixtures
@testable import RarogCore
import RarogTransport
import Synchronization

// Atrapa kluczy urządzeń i parowania: trasy `FakeTransport` dla `RarogStore+Pairing` i złącze serwera
// (`ServerConnector`) z Keychainem w pamięci, które oddaje atrapę transportu dla każdego punktu końcowego.

extension FakeTransport {
  var hasCredential: Bool { lock.withLock { $0.device || $0.credential } }

  var credentialRejection: CredentialRejection? { lock.withLock { $0.rejection } }

  func pair(_ body: PairBody) async throws(TransportError) -> PairResponse {
    try await check("POST", "/api/pair")
    let hook = lock.withLock { state in
      state.pairBodies.append(body)
      return state.onPair
    }
    await hook?()
    switch lock.withLock({ $0.pairResult }) ?? .success(PairingFixtures.response()) {
    case let .success(response): return response
    case let .failure(error): throw error
    }
  }

  func issuePairingCode() async throws(TransportError) -> PairingIssued {
    try await check("POST", "/api/pairings")
    let hook = lock.withLock { state in
      state.issueCalls += 1
      state.codeLog.append("POST")
      return state.onIssue
    }
    await hook?()
    let result = lock.withLock { state in
      state.codeLog.append("POST done")
      return state.issueResult
    }
    switch result ?? .success(PairingFixtures.issued()) {
    case let .success(issued): return issued
    case let .failure(error): throw error
    }
  }

  func devices() async throws(TransportError) -> DeviceList {
    let (list, error) = lock.withLock { state in
      state.devicesCalls += 1
      return (state.deviceList, state.devicesResult)
    }
    if let error { throw error }
    guard let list else { throw .http(APIFailure(status: 404)) }
    return list
  }

  func forgetDevice() async throws(TransportError) {
    try await check("POST", "/api/devices/forget")
    let (result, hook) = lock.withLock { state in
      state.forgetCalls += 1
      return (state.forgetResult, state.onForget)
    }
    await hook?()
    if let result { throw result }
  }

  func cancelPairingCode() async throws(TransportError) {
    try await check("DELETE", "/api/pairings")
    let hook = lock.withLock { state in
      state.cancelCodeCalls += 1
      state.codeLog.append("DELETE")
      return state.onCancelCode
    }
    await hook?()
    let result = lock.withLock { state in
      state.codeLog.append("DELETE done")
      return state.cancelCodeResult
    }
    if let result { throw result }
  }
}

/// Złote odpowiedzi parowania i list z `shared/fixtures/rest/` z podmienionymi polami.
enum PairingFixtures {
  static let code = "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ"
  static let server = URL(string: "https://rarog.example")!
  /// Schemat URL apki sprzed zmiany nazwy: apka go nie rejestruje, a link pod nim odpada.
  static let legacyScheme = "pilot" // stara-nazwa

  static func link(server: URL = server, code: String = code) -> PairingLink {
    PairingLink(server: server, code: code)
  }

  static func json(_ name: String) -> String {
    do {
      let url = try GoldenFrames.repoRoot().appending(path: "shared/fixtures/rest/\(name)")
      return try String(contentsOf: url, encoding: .utf8)
    } catch {
      fatalError("złota odpowiedź \(name): \(error)")
    }
  }

  static func response(deviceId: String = "03030303030303030303030303030303", serverId: String = "01010101010101010101010101010101")
    -> PairResponse
  {
    var text = json("pair.json")
    text = text.replacingOccurrences(of: "03030303030303030303030303030303", with: deviceId)
    text = text.replacingOccurrences(of: "01010101010101010101010101010101", with: serverId)
    return decode(PairResponse.self, text)
  }

  static func issued(expiresAt: String = "2026-10-04T10:05:00.000Z") -> PairingIssued {
    decode(PairingIssued.self, #"{"code":"\#(code)","expiresAt":"\#(expiresAt)"}"#)
  }

  static func devices(_ text: String = json("devices.json")) -> DeviceList {
    decode(DeviceList.self, text)
  }

  static func device(id: String, label: String, creator: String = "admin", current: Bool = false) -> String {
    #"{"id":"\#(id)","label":"\#(label)","createdAt":"2026-10-04T10:01:00.000Z","lastSeenAt":null,"#
      + #""creator":"\#(creator)","build":"1700","current":\#(current)}"#
  }

  static func decode<T: Decodable>(_ type: T.Type, _ text: String) -> T {
    do {
      return try JSONDecoder().decode(type, from: Data(text.utf8))
    } catch {
      fatalError("atrapa \(T.self): \(error)")
    }
  }

  static func credential(deviceId: String = "03030303030303030303030303030303", serverId: String = "01010101010101010101010101010101",
                         server: URL? = server, iroh: ServerIrohConfig? = nil) -> DeviceCredential {
    DeviceCredential(
      deviceId: deviceId, secret: "sekret", serverURL: server, serverId: serverId, serverName: "mac-demo",
      label: "iPhone·Rarog", kid: "f849d673", pairedAt: Date(timeIntervalSince1970: 1_792_000_000), iroh: iroh)
  }

  /// EndpointId i relay serwera iroh (wartości syntetyczne w postaci kanonicznej).
  static let endpointId = "523c7996bad77424e96786cf7a7205115337a5b4565cd25506a0f297b191a5ea"
  static let otherEndpointId = "6b1f0e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1"
  static let relay = "https://relay.rarog.ai/"

  static func iroh(_ endpointId: String = endpointId, relay: String = relay) -> ServerIrohConfig {
    guard let config = ServerIrohConfig(validating: endpointId, relay: relay) else {
      fatalError("atrapa pary iroh spoza postaci kanonicznej")
    }
    return config
  }

  /// Odpowiedź parowania z polem `server.iroh` (`null` przy `iroh == nil`, surowe wartości bez walidacji).
  static func response(
    deviceId: String = "03030303030303030303030303030303", serverId: String = "01010101010101010101010101010101",
    iroh: (endpointId: String, relay: String)?
  ) -> PairResponse {
    let field = iroh.map { #"{"endpointId":"\#($0.endpointId)","relay":"\#($0.relay)"}"# } ?? "null"
    var text = json("pair.json")
    text = text.replacingOccurrences(of: "03030303030303030303030303030303", with: deviceId)
    text = text.replacingOccurrences(of: "01010101010101010101010101010101", with: serverId)
    text = text.replacingOccurrences(of: #""iroh": null"#, with: #""iroh": "#  + field)
    return decode(PairResponse.self, text)
  }
}

/// Keychain złącza: ``MemoryKeychain`` testu z jednorazowym zaczepieniem po następnym udanym zapisie klucza. Test robi
/// w tej chwili coś z dyskiem, zanim magazyn ruszy dalej: zrzut stanu, który zostałby po procesie zabitym zaraz po
/// zapisie klucza, albo odmowa i powrót dysku.
final class KeychainProbe: DeviceKeychain {
  let memory: MemoryKeychain
  private let next = Mutex<(@Sendable () -> Void)?>(nil)

  init(_ memory: MemoryKeychain) {
    self.memory = memory
  }

  /// `hook` biegnie raz, zaraz po następnym udanym ``save(_:pushKey:)``.
  func afterNextSave(_ hook: @escaping @Sendable () -> Void) {
    next.withLock { $0 = hook }
  }

  func load() -> KeychainRead { memory.load() }

  func pushKey(kid: String) -> PushKeyRead { memory.pushKey(kid: kid) }

  @discardableResult
  func save(_ credential: DeviceCredential, pushKey: String) throws(KeychainFailure) -> Bool {
    let shared = try memory.save(credential, pushKey: pushKey)
    let hook = next.withLock { hook in
      defer { hook = nil }
      return hook
    }
    hook?()
    return shared
  }

  @discardableResult
  func delete(deviceId: String?) -> Bool { memory.delete(deviceId: deviceId) }

  @discardableResult
  func restoreSharedPushKey(kid: String, pushKey: String) -> Bool { memory.restoreSharedPushKey(kid: kid, pushKey: pushKey) }
}

/// Dysk pliku wskaźnika przestrzeni: zapisuje jak apka (plik atomowy), a wskaźnik spełniający `refuse` odrzuca jak
/// pełny dysk; reszta dysku (katalogi przestrzeni, kosz) działa. Każdy zapis zostawia ślad: wskaźnik, czy dysk go
/// przyjął, i katalogi w `servers/` w tej chwili.
final class PointerDisk: Sendable {
  struct Write: Sendable {
    let space: ServerSpace?
    let saved: Bool
    /// Katalogi w `servers/` w chwili zapisu (bez pliku wskaźnika).
    let spaceNames: [String]
  }

  private let root: URL
  private let state = Mutex<(refuse: (@Sendable (ServerSpace) -> Bool)?, writes: [Write])>((nil, []))

  init(root: URL) {
    self.root = root
  }

  /// Zapisy po kolei.
  var writes: [Write] { state.withLock { $0.writes } }

  /// Odmowa zapisu wskaźnika, dla którego `rule` daje prawdę; `nil` = dysk przyjmuje wszystko.
  func refuse(_ rule: (@Sendable (ServerSpace) -> Bool)?) {
    state.withLock { $0.refuse = rule }
  }

  func save(_ data: Data, to file: URL) throws {
    let space = try? JSONDecoder().decode(ServerSpace.self, from: data)
    let names = ((try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []).filter { !$0.hasPrefix(".") }.sorted()
    let refused = state.withLock { state in
      let refused = space.map { state.refuse?($0) ?? false } ?? false
      state.writes.append(Write(space: space, saved: !refused, spaceNames: names))
      return refused
    }
    if refused { throw CocoaError(.fileWriteOutOfSpace) }
    try data.write(to: file, options: .atomic)
  }
}

/// Złącze serwera z atrapami: każdy punkt końcowy dostaje świeżą (albo podaną z góry) atrapę transportu z bramką
/// magazynu. Test czyta zbudowane transporty i Keychain.
@MainActor
final class FakeServer {
  let keychain: MemoryKeychain
  /// Keychain, który widzi złącze (ten sam ``keychain`` z zaczepieniem po zapisie).
  let keychainProbe: KeychainProbe
  let preferences = MemoryPreferences()
  /// Transport parowania (pod adres z linku) — jeden na test, żeby test mógł ustawić jego odpowiedź.
  let pairing = FakeTransport(credential: false)
  private(set) var built: [(endpoint: ServerEndpoint, transport: FakeTransport)] = []
  /// Cele parowania w kolejności wywołań `ServerConnector.pairing`.
  private(set) var pairingTargets: [PairingTarget] = []
  /// Adresy HTTPS z celów parowania (cel `.iroh` nie ma adresu).
  var pairingURLs: [URL] {
    pairingTargets.compactMap { target in
      switch target {
      case let .https(url), let .both(url, _): url
      case .iroh: nil
      }
    }
  }
  /// Transporty jednorazowe do odpięcia poprzedniego klucza (`ServerConnector.forgetTransport`).
  private(set) var forgotten: [(endpoint: ServerEndpoint, transport: FakeTransport)] = []
  /// Punkty końcowe zakończone po przełączeniu (`ServerConnector.release`), po kolei.
  private(set) var released: [ServerEndpoint] = []
  /// Nowe trasy tego samego poświadczenia (`ServerConnector.credentialChanged`), po kolei.
  private(set) var routeChanges: [ServerEndpoint] = []
  /// Ile razy magazyn wszedł w inną przestrzeń danych (`ServerConnector.wipeAppData`).
  private(set) var wipes = 0
  /// Katalog testu: przestrzenie (`servers/`) i kosz.
  let base: URL
  /// Dysk pliku wskaźnika wszystkich magazynów testu.
  let pointerDisk: PointerDisk
  var spaces: ServerSpaces {
    let disk = pointerDisk
    return ServerSpaces(
      root: base.appending(path: "servers", directoryHint: .isDirectory),
      trash: base.appending(path: "trash", directoryHint: .isDirectory)
    ) { data, file in try disk.save(data, to: file) }
  }
  /// Następne transporty do wydania (po kolei); pusto = świeża atrapa.
  var queued: [FakeTransport] = []

  init(keychain: MemoryKeychain = MemoryKeychain()) {
    let base = FileManager.default.temporaryDirectory.appending(path: "rarog-spaces-\(UUID())", directoryHint: .isDirectory)
    self.base = base
    self.keychain = keychain
    keychainProbe = KeychainProbe(keychain)
    pointerDisk = PointerDisk(root: base.appending(path: "servers", directoryHint: .isDirectory))
  }

  var connector: ServerConnector {
    ServerConnector(
      keychain: keychainProbe, label: "iPhone·Rarog", build: 7,
      transport: { [unowned self] endpoint, rules in self.make(endpoint, rules) },
      pairing: { [unowned self] target in
        self.pairingTargets.append(target)
        return self.pairing
      },
      forgetTransport: { [unowned self] endpoint, rules in
        let transport = self.make(endpoint, rules)
        self.forgotten.append((endpoint, transport))
        return transport
      },
      release: { [unowned self] endpoint in self.released.append(endpoint) },
      credentialChanged: { [unowned self] endpoint in self.routeChanges.append(endpoint) },
      wipeAppData: { [unowned self] in self.wipes += 1 })
  }

  /// Ostatni zbudowany transport.
  var current: FakeTransport? { built.last?.transport }

  private func make(_ endpoint: ServerEndpoint, _ rules: MutationRules) -> FakeTransport {
    let transport = queued.isEmpty ? FakeTransport(credential: false) : queued.removeFirst()
    if case .device = endpoint { transport.set { $0.device = true } }
    transport.gate = MutationGate(policy: rules)
    built.append((endpoint, transport))
    return transport
  }

  /// Magazyn z tym złączem: punkt końcowy z Keychaina jak w apce (`RarogStore.live(connector:…)`), atrapy zamiast
  /// klienta HTTP.
  func store(build: Int = 7) -> RarogStore {
    let rules = MutationRules(timing: fastTiming)
    let read = keychain.load()
    let endpoint: ServerEndpoint
    switch read {
    case let .found(credential, _): endpoint = .device(credential)
    case .locked, .none, .failed: endpoint = .none
    }
    let transport = make(endpoint, rules)
    // Jedna instancja na magazyn, jak w apce: katalog roboczy sesji bez przestrzeni należy do niej.
    let spaces = spaces
    let store = RarogStore(
      transport: transport, rules: rules, outboxDirectory: spaces.scratch(), clientBuild: build, timing: fastTiming)
    store.attachServer(
      connector, endpoint: endpoint, preferences: preferences, spaces: spaces, keychainLocked: read == .locked)
    // Jak `live`: wpis współdzielony klucza push odtworzony z kopii prywatnej. Samo `live` sprawdza osobny test
    // (`StorePairingTests.liveRestoresSharedPushKey`), bo ta kopia zostałaby zielona przy regresji w `live`.
    store.restoreSharedPushKey(after: read)
    store.reportIgnoredIroh(after: read)
    pairing.gate = MutationGate(policy: rules)
    return store
  }

  /// Wskaźnik bieżącej przestrzeni z dysku (`ServerSpaces.pointerFile`).
  var pointer: ServerSpace? {
    (try? spaces.readPointer()) ?? nil
  }

  /// Kolejka wysyłki przestrzeni wskazanej przez wskaźnik — test pisze i czyta ją jak apka.
  func outbox(_ space: ServerSpace? = nil) -> OutboxPersistence? {
    (space ?? pointer).map { OutboxPersistence(directory: spaces.directory($0).appending(path: ServerSpaces.outbox)) }
  }

  /// Nazwy katalogów przestrzeni w `servers/` (bez pliku wskaźnika).
  var spaceNames: [String] {
    ((try? FileManager.default.contentsOfDirectory(atPath: spaces.root.path)) ?? []).filter { !$0.hasPrefix(".") }.sorted()
  }
}
