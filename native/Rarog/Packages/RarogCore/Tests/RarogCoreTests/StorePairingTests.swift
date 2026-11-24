import Foundation
import RarogContract
@testable import RarogCore
import RarogTransport
import Synchronization
import Testing

// Parowanie i klucz urządzenia w rdzeniu: link parowania, arkusz potwierdzenia,
// `POST /api/pair` przed `hello` (także przez PRAWDZIWY `RarogClient` z bramką), zapis w Keychainie, przełączenie
// transportu bez restartu, przestrzenie danych per serwer (`ServerSpaces`), 401 `device-revoked` → trwały ekran odpięcia (także po
// restarcie apki), 401 „nieznane” bez kasowania klucza, spóźnione 401 starego klucza, kod dla nowego urządzenia
// z terminem z serwera, trwały ślad nowego urządzenia, „Zapomnij serwer” i Keychain zablokowany przy starcie.

@Suite("pairing link")
struct PairingLinkTests {
  static let code = PairingFixtures.code

  @Test("link z CLI: adres zakodowany jak encodeURIComponent, kod we fragmencie; złożenie daje ten sam kształt")
  func roundTrip() throws {
    let text = "https://rarog.ai/pair#v=1&u=https%3A%2F%2Frarog.example.ts.net&c=\(Self.code)"
    let link = try PairingLink.parse(text).get()
    #expect(link.server.absoluteString == "https://rarog.example.ts.net")
    #expect(link.code == Self.code && link.host == "rarog.example.ts.net")
    #expect(link.url.absoluteString == text)
    #expect(link.url.host() == PairingLinkWire.host, "the built link takes its host from the constant, not a literal")
    // The custom-scheme link with the same fragment reads to the same link.
    #expect(try PairingLink.parse("rarog://pair#v=1&u=https%3A%2F%2Frarog.example.ts.net&c=\(Self.code)").get() == link)
    // Port i spacje z wklejenia; serwer demo na loopbacku po http.
    let demo = try PairingLink.parse("  rarog://pair#v=1&u=http%3A%2F%2F127.0.0.1%3A18930&c=\(Self.code)\n").get()
    #expect(demo.server.absoluteString == "http://127.0.0.1:18930")
    #expect(PushRouting.link(url: link.url) == .pair(link))
    // Link skopiowany z terminala bywa złamany na końcu linii ekranu (mosh, klient SSH na telefonie).
    let wrapped = "rarog://pair#v=1&u=https%3A%2F%2Frarog.example.ts\n.net&c=\(Self.code.prefix(20))\r\n\(Self.code.dropFirst(20))"
    #expect(try PairingLink.parse(wrapped).get() == link)
  }

  @Test("odmowy: inna wersja, http poza loopbackiem, ścieżka i użytkownik w adresie, ucięty kod, obcy adres")
  func rejections() {
    func error(_ text: String) -> PairingLinkError? {
      if case let .failure(error) = PairingLink.parse(text) { return error }
      return nil
    }
    #expect(error("rarog://pair#v=2&u=https%3A%2F%2Fa.example&c=\(Self.code)") == .unsupportedVersion)
    #expect(error("rarog://pair#v=1&u=http%3A%2F%2Fa.example&c=\(Self.code)") == .badAddress)
    #expect(error("rarog://pair#v=1&u=https%3A%2F%2Fa.example%2Fapi&c=\(Self.code)") == .badAddress)
    #expect(error("rarog://pair#v=1&u=https%3A%2F%2Fx%40a.example&c=\(Self.code)") == .badAddress)
    #expect(error("rarog://pair#v=1&u=https%3A%2F%2Fa.example&c=\(Self.code.dropLast())") == .badCode)
    #expect(error("rarog://pair?v=1&u=https%3A%2F%2Fa.example&c=\(Self.code)") == .notALink, "dane w zapytaniu, nie we fragmencie")
    #expect(error("https://a.example") == .notALink)
    #expect(error("zwykły tekst") == .notALink)
    #expect(PushRouting.link(url: URL(string: "rarog://pair#v=9")!) == .badPair(.unsupportedVersion))
    #expect(PushRouting.link(url: URL(string: "rarog://pair")!) == .badPair(.notALink))
  }

  @Test("link pod schematem sprzed zmiany nazwy to nie link parowania: wklejka i skan odpadają, trasa adresów go nie czyta")
  func otherSchemeRejected() throws {
    func error(_ text: String) -> PairingLinkError? {
      if case let .failure(error) = PairingLink.parse(text) { return error }
      return nil
    }
    let old = PairingFixtures.legacyScheme
    let pasted = "  \(old)://pair#v=1&u=https%3A%2F%2Frarog.example.ts\n.net&c=\(Self.code.prefix(20))\r\n\(Self.code.dropFirst(20))\n"
    for raw in ["\(old)://pair#v=1&u=https%3A%2F%2Frarog.example.ts.net&c=\(Self.code)",
      "\(old.uppercased())://PAIR#v=1&u=https%3A%2F%2Frarog.example.ts.net&c=\(Self.code)", pasted,
      "\(old)://session/x", "inny://pair#v=1&u=https%3A%2F%2Fa.example&c=\(Self.code)"] {
      #expect(error(raw) == .notALink, "\(raw)")
    }
    // System dostarcza tej apce tylko jej schemat (`CFBundleURLSchemes`); trasa adresów innych nie czyta.
    #expect(PushRouting.link(url: try #require(URL(string: "\(old)://pair#v=1&u=https%3A%2F%2Fa.example&c=\(Self.code)"))) == nil)
  }

  @Test("pola iroh `k=`/`r=`: złe pola to zły adres, duplikat to zepsuty link, bez nowych zdań")
  func irohFields() throws {
    let endpoint = "523c7996bad77424e96786cf7a7205115337a5b4565cd25506a0f297b191a5ea"
    let relay = "https%3A%2F%2Feuc1-1.relay.n0.iroh.link.%2F"
    func error(_ text: String) -> PairingLinkError? {
      if case let .failure(error) = PairingLink.parse(text) { return error }
      return nil
    }
    #expect(error("rarog://pair#v=1&u=https%3A%2F%2Fa.example&k=\(endpoint)&c=\(Self.code)") == .badAddress, "k bez r")
    #expect(error("rarog://pair#v=1&u=https%3A%2F%2Fa.example&k=\(endpoint.uppercased())&r=\(relay)&c=\(Self.code)") == .badAddress)
    #expect(error("rarog://pair#v=1&u=https%3A%2F%2Fa.example&u=https%3A%2F%2Fb.example&c=\(Self.code)") == .notALink, "duplikat")
    // Każdy kod kontraktu ma zdanie ekranu (mapowanie, nie nowy tekst).
    let mapped = PairingLinkWireError.allCases.map(PairingLinkError.init)
    #expect([PairingLinkError.notALink, .unsupportedVersion, .badAddress, .badCode].allSatisfy(mapped.contains))
  }

  @Test("adres z linku w brzmieniu serwera: `Origin` = wpis `RAROG_ORIGINS` (wielkie litery), link wraca ten sam")
  func originKeepsServerSpelling() throws {
    let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
    for origin in ["https://Rarog.Example.ts.net", "http://127.0.0.1:18930", "https://[2001:db8::1]:8930"] {
      let encoded = try #require(origin.addingPercentEncoding(withAllowedCharacters: allowed))
      let text = "https://rarog.ai/pair#v=1&u=\(encoded)&c=\(Self.code)"
      let link = try PairingLink.parse(text).get()
      #expect(link.server.absoluteString == origin && link.url.absoluteString == text, "\(origin)")
      // Serwer porównuje `Origin` dosłownie z `RAROG_ORIGINS` (`router.ts`, bramka `Origin`). Literał IPv6
      // `RarogConfig.origin(of:)` zapisuje bez nawiasów, więc tu go nie porównujemy.
      if !origin.contains("[") { #expect(RarogConfig.origin(of: link.server) == origin, "\(origin)") }
    }
  }

  @Test("kod dla nowego urządzenia: termin z serwera, nie od odebrania odpowiedzi; po uśpieniu apka widzi prawdę")
  func issuedExpiry() {
    let expires = Date(timeIntervalSince1970: 1_000)
    let issued = IssuedPairingCode(link: PairingFixtures.link(), expiresAt: expires)
    #expect(issued.remaining(now: Date(timeIntervalSince1970: 800)) == 200)
    #expect(!issued.isExpired(now: Date(timeIntervalSince1970: 999)))
    // Apka uśpiona przez 10 min: odliczanie nie zaczyna się od nowa.
    #expect(issued.isExpired(now: Date(timeIntervalSince1970: 1_600)))
    #expect(RarogStore.isoDate("2026-10-04T10:05:00.000Z") == Date(timeIntervalSince1970: 1_791_108_300))
  }
}

@MainActor
@Suite("magazyn: parowanie i klucz urządzenia")
struct StorePairingTests {
  /// Magazyn bez klucza: start na ekranie parowania. Transport startu oddany do porównań.
  private func unpaired(_ server: FakeServer) async -> (RarogStore, FakeTransport?) {
    let store = server.store()
    await store.start()
    return (store, server.current)
  }

  /// Magazyn z kluczem z Keychaina (``PairingFixtures/credential()``), zalogowany i z żywym strumieniem.
  func paired(_ server: FakeServer) async -> (RarogStore, FakeTransport) {
    if server.keychain.load() == .none { _ = try? server.keychain.save(PairingFixtures.credential(), pushKey: "BQUF") }
    let first = FakeTransport(credential: false)
    server.queued = [first]
    let store = server.store()
    await store.start()
    await until("strumień globalny") { store.state.global == .online }
    return (store, first)
  }

  /// Wpis kolejki serwera „A” zapisany na dysku przestrzeni — jak po wysyłce.
  func entryA(_ text: String = "do serwera A") -> OutboxEntry {
    OutboxEntry(sessionId: "sesja-a", text: text, createdAt: Date(), state: .unconfirmed)
  }

  private func online(_ store: RarogStore, _ transport: FakeTransport) async {
    await until("strumień nowego transportu") { !transport.streamCalls.isEmpty }
    transport.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s1"}"#)
    transport.push(.global, json: #"{"type":"sessions-snapshot","sessions":[]}"#)
    await until("świeża lista") { store.state.sessionsLoaded && store.state.compat == .ok }
  }

  @Test("bez klucza → klucz bez restartu: arkusz, POST /api/pair pod adres z linku, Keychain, zalogowanie")
  func pairFromScratch() async {
    let server = FakeServer()
    let (store, initial) = await unpaired(server)
    let link = PairingFixtures.link(server: URL(string: "https://inny.example")!)
    store.offerPairing(link)
    #expect(store.state.pairing.flow == .confirming(link))
    #expect(server.pairing.read { $0.pairBodies }.isEmpty, "bez potwierdzenia nic nie wychodzi")

    #expect(await store.confirmPairing() == .paired)
    #expect(server.pairingURLs == [link.server])
    #expect(server.pairing.read { $0.pairBodies } == [PairBody(code: link.code, label: "iPhone·Rarog", build: 7)])
    guard case let .found(saved, pushKey) = server.keychain.load() else {
      Issue.record("klucz nie trafił do Keychaina")
      return
    }
    #expect(saved.serverURL == link.server && saved.deviceId == "03030303030303030303030303030303")
    #expect(pushKey == "BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU")
    #expect(store.state.auth == .loggedIn && store.state.pairing.flow == .idle)
    #expect(store.state.pairing.paired?.deviceId == saved.deviceId)
    let device = try? #require(server.current)
    #expect(device !== initial)
    if let device { await online(store, device) }
    #expect(server.wipes == 0, "bez danych poprzedniego serwera nie ma czego kasować")
  }

  @Test("po ponownym parowaniu token APNs idzie od nowa NOWYM transportem; system go nie traci")
  func pushReRegistersWithKey() async {
    let server = FakeServer(keychain: MemoryKeychain(.init(credential: PairingFixtures.credential(), pushKey: "BQUF")))
    let first = FakeTransport(credential: false)
    server.queued = [first]
    let store = server.store()
    let system = FakePushSystem(status: .authorized)
    store.attachSystem(push: system, background: FakeBackgroundWork(log: EventLog()), preferences: server.preferences)
    store.deviceTokenReceived(PushRegistrationTests.tokenData)
    await store.start()
    await online(store, first)
    await until("rejestracja z pierwszym kluczem") { first.read { $0.apnsRegistrations.count } == 1 }

    // Ten sam `deviceId` (ponowne parowanie): bez transportu „forget” poprzedniego klucza, `server.current` = nowy.
    store.offerPairing(PairingFixtures.link())
    #expect(await store.confirmPairing() == .paired)
    guard let device = server.current, device !== first else {
      Issue.record("brak nowego transportu")
      return
    }
    await online(store, device)
    await until("rejestracja z nowym kluczem") { device.read { $0.apnsRegistrations.count } == 1 }
    #expect(device.read { $0.apnsRegistrations.first?.token } == PushRegistrationTests.tokenHex)
    #expect(system.unregisterCalls == 0, "przełączenie nie oddaje tokenu systemowi")
    #expect(first.read { $0.apnsRegistrations.count } == 1, "stary transport nic już nie wysyła")
  }

  @Test("POST /api/pair przed hello przez PRAWDZIWY RarogClient z bramką magazynu: nie czeka i nie odmawia")
  func pairThroughRealClientGate() async throws {
    let port = PairStub.register(status: 200, body: PairingFixtures.json("pair.json"))
    let rules = MutationRules(timing: CoreTiming(compatWait: .seconds(5)))
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [PairStub.self]
    let client = RarogClient(config: .test(port: port), policy: rules, configuration: configuration)
    let started = ContinuousClock.now
    let response = try await client.pair(PairBody(code: PairingFixtures.code, label: "iPhone·Rarog", build: 7))
    #expect(response.server.capabilities.contains("device-auth"))
    #expect(ContinuousClock.now - started < .seconds(2), "bramka zgodności nie trzyma parowania do `hello`")
    // Ta sama bramka trzyma zwykłą mutację (compatWait) i odmawia bez `hello`.
    let short = MutationRules(timing: CoreTiming(compatWait: .milliseconds(50)))
    let gated = RarogClient(config: .test(port: port), policy: short, configuration: configuration)
    await #expect(throws: TransportError.self) { _ = try await gated.issuePairingCode() }
  }

  @Test("odmowa serwera: 404 pair-unknown, 405 serwer sprzed parowania, sieć — klucz i transport bez zmian")
  func pairRefusals() async {
    let server = FakeServer()
    let (store, first) = await paired(server)
    let cases: [(TransportError, PairingFailure)] = [
      (.http(APIFailure(status: 404, code: "pair-unknown", message: "Kod parowania jest nieważny")), .codeRejected),
      (.http(APIFailure(status: 405)), .serverTooOld),
      (.offline(.notConnectedToInternet), .offline),
      (.forbidden(APIFailure(status: 403, code: "bad-origin", message: "Żądanie z niedozwolonego origin.")),
       .forbidden("Żądanie z niedozwolonego origin.")),
    ]
    for (error, failure) in cases {
      server.pairing.set { $0.pairResult = .failure(error) }
      let link = PairingFixtures.link()
      store.offerPairing(link)
      #expect(await store.confirmPairing() == .failed(failure))
      #expect(store.state.pairing.flow == .failed(link, failure))
      #expect(server.keychain.load() == .found(PairingFixtures.credential(), pushKey: "BQUF"))
      #expect(store.state.auth == .loggedIn && server.current === first)
      store.cancelPairing()
      #expect(store.state.pairing.flow == .idle)
    }
  }

  @Test("Keychain odmawia zapisu: parowanie kończy się błędem, apka zostaje na dotychczasowym kluczu")
  func keychainFailure() async {
    let server = FakeServer()
    let (store, first) = await paired(server)
    server.keychain.update { $0.saveFailure = -25_308 }
    store.offerPairing(PairingFixtures.link())
    #expect(await store.confirmPairing() == .failed(.keychain(-25_308)))
    #expect(server.current === first && store.state.auth == .loggedIn)
  }

  @Test("ten sam adres: ta sama przestrzeń danych; inny adres: nowa przestrzeń, poprzednia do kosza")
  func spaceSwitch() async throws {
    let server = FakeServer()
    let (store, _) = await paired(server)
    let first = try #require(server.pointer)
    try await #require(server.outbox()).save(entryA())
    store.offerPairing(PairingFixtures.link())
    #expect(await store.confirmPairing() == .paired)
    #expect(server.wipes == 0 && server.pointer?.name == first.name, "ten sam serwer: ta sama przestrzeń")
    // Interfejs i tak buduje się od nowa: widoki trzymały obiekty starego transportu (ekran terminala).
    #expect(store.interfaceEpoch == 1)

    server.pairing.set { $0.pairResult = .success(PairingFixtures.response(deviceId: "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a", serverId: "inny-serwer")) }
    let other = PairingFixtures.link(server: URL(string: "https://inny.example")!)
    store.offerPairing(other)
    #expect(await store.confirmPairing(replacing: true) == .paired)
    #expect(server.wipes == 1 && store.interfaceEpoch == 2)
    let pointer = try #require(server.pointer)
    #expect(pointer.origin == ServerOrigin(URL(string: "https://inny.example")!) && pointer.name != first.name)
    #expect(!server.spaceNames.contains(first.name), "przestrzeń poprzedniego serwera w koszu")
    #expect(store.dataSpaceDirectory == server.spaces.directory(pointer))
    // Poprzedni klucz odpina się sam na swoim serwerze (best-effort, transport starego klucza).
    let old = server.built.last { $0.endpoint.credential?.deviceId == "03030303030303030303030303030303" }?.transport
    await until("forget poprzedniego klucza") { old?.read { $0.forgetCalls } == 1 }
  }

  @Test("401 device-revoked: klucz skasowany, trwały ekran odpięcia — także po restarcie apki")
  func revoked() async {
    let keychain = MemoryKeychain(.init(credential: PairingFixtures.credential(), pushKey: "BQUF"))
    let server = FakeServer(keychain: keychain)
    let store = server.store()
    await store.start()
    #expect(store.state.auth == .loggedIn && store.state.pairing.paired != nil)
    let device = try? #require(server.current)
    guard let device else { return }
    await until("strumień") { store.state.global == .online }
    device.set {
      $0.rejection = .revoked(
        deviceId: "03030303030303030303030303030303", revokedAt: "2026-10-04T10:03:00.000Z", revokedBy: "admin")
    }
    device.end(.global, error: .unauthorized(APIFailure(status: 401, code: "device-revoked")))
    await until("ekran odpięcia") { store.state.auth == .loggedOut(.deviceRevoked) }
    #expect(keychain.load() == .none)
    let revocation = DeviceRevocation(
      deviceId: "03030303030303030303030303030303", server: "rarog.example", revokedAt: "2026-10-04T10:03:00.000Z",
      revokedBy: "admin")
    #expect(store.state.pairing.revoked == revocation)
    #expect(store.state.pairing.binding == .none)

    // Restart apki: ten sam Keychain (pusty) i te same preferencje → ekran odpięcia od razu.
    let restarted = server.store()
    await restarted.start()
    #expect(restarted.state.auth == .loggedOut(.deviceRevoked))
    #expect(restarted.state.pairing.revoked == revocation)
    // Następne parowanie zdejmuje ekran.
    restarted.offerPairing(PairingFixtures.link())
    #expect(await restarted.confirmPairing() == .paired)
    #expect(restarted.state.pairing.revoked == nil && server.preferences.data(forKey: RarogStore.revokedKey) == nil)
  }

  /// Sonda wersji serwera na Linuksie (złota odpowiedź z podmienionym systemem).
  private func linuxVersion() throws -> VersionInfo {
    let text = PairingFixtures.json("version.json").replacingOccurrences(of: #""system": "macos""#, with: #""system": "linux""#)
    let info = try JSONDecoder().decode(VersionInfo.self, from: Data(text.utf8))
    try #require(info.system == .linux)
    return info
  }

  @Test("system z sondy wersji trafia do poświadczenia w Keychainie; zimny start bez sieci mówi ostatnim znanym")
  func serverSystemRemembered() async throws {
    let keychain = MemoryKeychain(.init(credential: PairingFixtures.credential(), pushKey: "BQUF"))
    let server = FakeServer(keychain: keychain)
    let first = FakeTransport(credential: false)
    let linux = try linuxVersion()
    first.set { $0.version = linux }
    server.queued = [first]
    let store = server.store()
    #expect(store.state.serverSystem == nil && store.state.serverMachine == .mac, "zapis sprzed pola: nie wiadomo")
    await store.start()
    await until("system z sondy w Keychainie") {
      if case let .found(saved, _) = keychain.load() { return saved.serverSystem == .linux }
      return false
    }
    var remembered = PairingFixtures.credential()
    remembered.serverSystem = .linux
    #expect(keychain.load() == .found(remembered, pushKey: "BQUF"), "reszta wpisu i kopia klucza push bez zmian")
    #expect(store.state.serverSystem == .linux && store.state.serverMachine == .vps)
    #expect(store.serverEndpoint.credential == remembered && server.current === first, "ten sam transport")

    // Zimny start bez sieci (sonda pada): słowo z zapisu, zanim cokolwiek odpowie.
    let restarted = server.store()
    #expect(restarted.state.serverSystem == .linux && restarted.state.serverMachine == .vps)
    await restarted.start()
    #expect(restarted.state.serverSystem == .linux)

    // Parowanie z innym serwerem: jego system nieznany do jego sondy.
    restarted.offerPairing(PairingFixtures.link(server: URL(string: "https://inny.example")!))
    server.pairing.set { $0.pairResult = .success(PairingFixtures.response(deviceId: "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a")) }
    #expect(await restarted.confirmPairing(replacing: true) == .paired)
    #expect(restarted.state.serverSystem == nil && restarted.state.serverMachine == .mac)
  }

  /// Linie `client.log`, które wyszły przez transport.
  private func logLines(_ transport: FakeTransport?) -> [String] {
    transport?.read { $0.clientLogs.flatMap(\.events).map(\.msg) } ?? []
  }

  @Test("zapis w miejscu (system z sondy) odrzucony przez Keychain: stary wpis i ten sam transport, linia w client.log")
  func serverSystemSaveFailure() async throws {
    let keychain = MemoryKeychain(.init(credential: PairingFixtures.credential(), pushKey: "BQUF"))
    keychain.update { $0.saveFailure = -25_308 }
    let server = FakeServer(keychain: keychain)
    let first = FakeTransport(credential: false)
    let linux = try linuxVersion()
    first.set { $0.version = linux }
    server.queued = [first]
    let store = server.store()
    await store.start()
    await until("linia o odmowie zapisu") { self.logLines(first).contains { $0.contains("zapis systemu serwera nieudany") } }
    #expect(keychain.load() == .found(PairingFixtures.credential(), pushKey: "BQUF"), "stary wpis w Keychainie")
    #expect(server.current === first && store.state.auth == .loggedIn, "ten sam transport")
  }

  @Test("zapis w miejscu bez grupy współdzielonej: nowy wpis prywatny obowiązuje, klucz push zdegradowany, bez wycofania")
  func serverSystemSharedFailure() async throws {
    let keychain = MemoryKeychain(.init(credential: PairingFixtures.credential(), pushKey: "BQUF"))
    keychain.update {
      $0.sharedFailure = true
      $0.sharedWrites = 0
    }
    let server = FakeServer(keychain: keychain)
    let first = FakeTransport(credential: false)
    let linux = try linuxVersion()
    first.set { $0.version = linux }
    server.queued = [first]
    let store = server.store()
    await store.start()
    await until("linia o grupie współdzielonej") {
      self.logLines(first).contains { $0.contains("klucz push bez grupy współdzielonej") }
    }
    var remembered = PairingFixtures.credential()
    remembered.serverSystem = .linux
    #expect(keychain.load() == .found(remembered, pushKey: "BQUF"), "wpis prywatny z nowym systemem, bez wycofania")
    #expect(keychain.snapshot.sharedWrites == 0, "grupa współdzielona nietknięta: klucz push z kopii prywatnej")
    #expect(store.serverEndpoint.credential == remembered && server.current === first)
  }

  /// Poświadczenie z Keychaina z dobrym adresem i zepsutą parą iroh (EndpointId 63 znaki, relay bez schematu).
  private func credentialWithBrokenIroh() throws -> DeviceCredential {
    let json = #"{"deviceId":"03030303030303030303030303030303","secret":"sekret","serverURL":"https:\/\/rarog.example","#
      + #""serverId":"01010101010101010101010101010101","serverName":"mac-demo","label":"iPhone·Rarog","kid":"f849d673","#
      + #""pairedAt":813692800,"iroh":{"endpointId":"\#(String(GoldenPointers.endpointId.dropLast()))","#
      + #""relay":"relay.rarog.ai"}}"#
    let credential = try JSONDecoder().decode(DeviceCredential.self, from: Data(json.utf8))
    try #require(credential.iroh == nil && credential.ignoredIroh != nil)
    return credential
  }

  @Test("wpis z dobrym adresem i zepsutym iroh: start z kluczem, klucz urządzenia i push nietknięte, linia w client.log")
  func brokenIrohLogged() async throws {
    let credential = try credentialWithBrokenIroh()
    let keychain = MemoryKeychain(.init(credential: credential, pushKey: "BQUF"))
    let server = FakeServer(keychain: keychain)
    let store = server.store()
    await store.start()
    await until("linia o polu iroh") { self.logLines(server.current).contains { $0.contains("pole iroh pominięte") } }
    #expect(store.state.auth == .loggedIn && store.serverEndpoint.credential?.deviceId == credential.deviceId)
    #expect(keychain.load() == .found(credential, pushKey: "BQUF") && keychain.snapshot.shared == ["f849d673": "BQUF"])
    #expect(!logLines(server.current).contains { $0.contains(GoldenPointers.endpointId.prefix(16)) }, "bez wartości pola")

    // Prawdziwe `live` i odczyt po odblokowaniu mówią to samo.
    let locked = MemoryKeychain(.init(credential: credential, pushKey: "BQUF"))
    locked.update { $0.locked = true }
    let other = FakeServer(keychain: locked)
    let waiting = other.store()
    await waiting.start()
    locked.update { $0.locked = false }
    waiting.protectedDataBecameAvailable()
    await until("linia po odblokowaniu") { self.logLines(other.current).contains { $0.contains("pole iroh pominięte") } }
    let live = RarogStore.live(connector: other.connector, preferences: other.preferences, spaces: other.spaces)
    let liveTransport = other.current
    await live.start()
    await until("linia z `live`", timeout: .seconds(10)) {
      self.logLines(liveTransport).contains { $0.contains("pole iroh pominięte") }
    }
  }

  @Test("parowanie z innym serwerem kasuje wersję starego od razu: wiersz aktualizacji znika przed sondą nowego")
  func serverSwitchClearsServerVersion() async throws {
    let keychain = MemoryKeychain(.init(credential: PairingFixtures.credential(), pushKey: "BQUF"))
    let server = FakeServer(keychain: keychain)
    let first = FakeTransport(credential: false)
    let old = PairingFixtures.json("version.json").replacingOccurrences(
      of: #""version": "[^"]*""#, with: #""version": "0.0.1""#, options: .regularExpression)
    let info = try JSONDecoder().decode(VersionInfo.self, from: Data(old.utf8))
    try #require(info.version == "0.0.1")
    first.set { $0.version = info }
    server.queued = [first]
    let store = server.store()
    await store.start()
    await until("wiersz aktualizacji starego serwera") { store.state.serverUpdate?.server == "0.0.1" }
    store.offerPairing(PairingFixtures.link(server: URL(string: "https://inny.example")!))
    server.pairing.set { $0.pairResult = .success(PairingFixtures.response(deviceId: "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a")) }
    #expect(await store.confirmPairing(replacing: true) == .paired)
    #expect(server.current !== first, "nowy transport")
    #expect(store.state.serverVersion == nil && store.state.serverUpdate == nil, "wersja należy do starego serwera")
  }

  @Test("odpięcie niesie ostatni znany system: ekran odpięcia mówi o VPS-ie także po restarcie")
  func revokedKeepsServerSystem() async {
    var credential = PairingFixtures.credential()
    credential.serverSystem = .linux
    let keychain = MemoryKeychain(.init(credential: credential, pushKey: "BQUF"))
    let server = FakeServer(keychain: keychain)
    let store = server.store()
    await store.start()
    let device = try? #require(server.current)
    guard let device else { return }
    await until("strumień") { store.state.global == .online }
    device.set {
      $0.rejection = .revoked(
        deviceId: "03030303030303030303030303030303", revokedAt: "2026-10-04T10:03:00.000Z", revokedBy: "admin")
    }
    device.end(.global, error: .unauthorized(APIFailure(status: 401, code: "device-revoked")))
    await until("ekran odpięcia") { store.state.auth == .loggedOut(.deviceRevoked) }
    #expect(store.state.pairing.revoked?.serverSystem == .linux)
    #expect(store.state.serverSystem == nil && store.state.serverMachine == .vps, "bez klucza: system z odpięcia")
    let restarted = server.store()
    await restarted.start()
    #expect(restarted.state.pairing.revoked?.serverSystem == .linux && restarted.state.serverMachine == .vps)
  }

  @Test("odpięcie zapisane przed polem systemu czyta się dalej: system nieznany, słowo Mac")
  func revocationBeforeField() async {
    let server = FakeServer()
    let old = #"{"deviceId":"03030303030303030303030303030303","server":"rarog.example","#
      + #""revokedAt":"2026-10-04T10:03:00.000Z","revokedBy":"admin"}"#
    server.preferences.set(Data(old.utf8), forKey: RarogStore.revokedKey)
    let store = server.store()
    await store.start()
    #expect(store.state.auth == .loggedOut(.deviceRevoked))
    #expect(store.state.pairing.revoked == DeviceRevocation(
      deviceId: "03030303030303030303030303030303", server: "rarog.example", revokedAt: "2026-10-04T10:03:00.000Z",
      revokedBy: "admin"))
    #expect(store.state.serverMachine == .mac)
  }

  @Test("401 klucza bez device-revoked: klucz ZOSTAJE, „Spróbuj ponownie” loguje tym samym kluczem")
  func unknownKeepsKey() async {
    let keychain = MemoryKeychain(.init(credential: PairingFixtures.credential(), pushKey: "BQUF"))
    let server = FakeServer(keychain: keychain)
    let store = server.store()
    await store.start()
    let device = try? #require(server.current)
    guard let device else { return }
    await until("strumień") { store.state.global == .online }
    device.set { $0.rejection = .unknown(deviceId: "03030303030303030303030303030303") }
    device.end(.global, error: .unauthorized(APIFailure(status: 401, code: "device-unknown")))
    await until("ekran „nie rozpoznał”") { store.state.auth == .loggedOut(.deviceUnknown) }
    #expect(keychain.load() != .none, "samo 401 nie kasuje klucza")
    #expect(store.state.pairing.revoked == nil)
    store.retryDeviceKey()
    #expect(store.state.auth == .loggedIn)
    #expect(server.current !== device, "świeży transport, czysty zatrzask odmowy")
  }

  @Test("spóźnione 401 starego klucza po nowym parowaniu nie rusza nowego klucza ani zalogowania")
  func staleRevocationAfterRepair() async {
    let keychain = MemoryKeychain(.init(credential: PairingFixtures.credential(), pushKey: "BQUF"))
    let server = FakeServer(keychain: keychain)
    let store = server.store()
    await store.start()
    let staleLogin = store.loginGeneration
    server.pairing.set { $0.pairResult = .success(PairingFixtures.response(deviceId: "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b")) }
    store.offerPairing(PairingFixtures.link())
    #expect(await store.confirmPairing() == .paired)
    // Odpowiedź żądania starego klucza: wynik obszaru woła wylogowanie z numerem sprzed parowania.
    store.handleUnauthorized(since: staleLogin)
    #expect(store.state.auth == .loggedIn)
    guard case let .found(current, _) = keychain.load() else {
      Issue.record("nowy klucz zniknął")
      return
    }
    #expect(current.deviceId == "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b")
    // Kasowanie adresowane starym `deviceId` nie dotyka nowego wpisu.
    #expect(!keychain.delete(deviceId: "03030303030303030303030303030303"))
  }

  @Test("kod dla nowego urządzenia: link z adresem tego serwera, termin z serwera; bez klucza nic nie wychodzi")
  func issueCode() async {
    let keychain = MemoryKeychain(.init(credential: PairingFixtures.credential(), pushKey: "BQUF"))
    let server = FakeServer(keychain: keychain)
    let store = server.store()
    await store.start()
    if let device = server.current { await online(store, device) }
    store.issuePairingCode()
    await until("kod") { if case .issued = store.state.pairing.issue { true } else { false } }
    guard case let .issued(code) = store.state.pairing.issue else { return }
    #expect(code.link.server == PairingFixtures.server && code.link.code == PairingFixtures.code)
    #expect(code.expiresAt == Date(timeIntervalSince1970: 1_791_108_300))
    store.clearPairingCode()
    #expect(store.state.pairing.issue == .idle)

    // Magazyn bez klucza nie ma czego wydać — trasa wymaga klucza.
    let (bare, transport) = await unpaired(FakeServer())
    bare.issuePairingCode()
    #expect(bare.state.pairing.issue == .idle && transport?.read { $0.issueCalls } == 0)
  }

  @Test("trwały ślad: pierwsza lista tylko zapamiętana, nowe urządzenie daje notkę z twórcą; zamknięcie i restart")
  func newDeviceTrace() async {
    let keychain = MemoryKeychain(.init(credential: PairingFixtures.credential(), pushKey: "BQUF"))
    let server = FakeServer(keychain: keychain)
    let me = PairingFixtures.device(id: "03030303030303030303030303030303", label: "iPhone·Rarog", current: true)
    let device = FakeTransport(credential: false)
    device.set { $0.deviceList = PairingFixtures.devices(#"{"devices":[\#(me)]}"#) }
    server.queued = [device]
    let store = server.store()
    await store.start()
    await online(store, device)
    await until("pierwsza lista") { store.state.pairing.devices?.count == 1 }
    #expect(store.state.pairing.newDevices.isEmpty, "pierwszy odczyt niczego nie ogłasza")

    let iPad = PairingFixtures.device(
      id: "08080808080808080808080808080808", label: "iPad·Rarog", creator: "03030303030303030303030303030303")
    device.set { $0.deviceList = PairingFixtures.devices(#"{"devices":[\#(me),\#(iPad)]}"#) }
    // Następne `hello` (nowe połączenie) czyta listę znowu.
    device.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s1"}"#)
    await until("notka") { store.state.pairing.newDevices.count == 1 }
    let notice = store.state.pairing.newDevices[0]
    #expect(notice.label == "iPad·Rarog" && notice.creator == "iPhone·Rarog" && !notice.creatorIsAdmin)

    // Restart apki: notka czeka, aż człowiek ją zamknie.
    let restarted = server.store()
    #expect(restarted.state.pairing.newDevices == [notice])
    restarted.dismissDeviceNotice(notice.id)
    #expect(restarted.state.pairing.newDevices.isEmpty)
    #expect(server.store().state.pairing.newDevices.isEmpty)
  }

  @Test("push device-paired (v1 and v3): a tap opens the Pairing page without a session; received in the foreground it reads the list")
  func devicePairedPush() async throws {
    let keychain = MemoryKeychain(.init(credential: PairingFixtures.credential(), pushKey: FramesKey.pushKey))
    let server = FakeServer(keychain: keychain)
    let store = server.store()
    await store.start()
    let payload: [AnyHashable: Any] = [
      "aps": ["alert": ["title": "🔐 Sparowano nowe urządzenie", "body": "iPad·Rarog"]],
      "rarog": ["v": 1, "kind": "device-paired"],
    ]
    // v3: treść zaszyfrowana kluczem tego urządzenia — rodzaj z odszyfrowania w apce, gdy NSE nie zdążył.
    for userInfo in [payload, try apnsFrame("alert.device-paired.v3.json")] {
      let note = try #require(PushRouting.note(userInfo: userInfo, keys: keychain))
      #expect(note.target == nil && note.opensSettings == .pairing && note.showsBannerInForeground)
      let before = server.current?.read { $0.devicesCalls } ?? 0
      store.pushTapped(note)
      #expect(store.state.pairing.settingsScreenRequested == .pairing)
      store.consumeSettingsScreenRequest()
      #expect(store.state.pairing.settingsScreenRequested == nil)
      await until("odczyt listy po tapnięciu") { (server.current?.read { $0.devicesCalls } ?? 0) > before }
      try await Task.sleep(for: .milliseconds(30))
      let calls = server.current?.read { $0.devicesCalls } ?? 0
      store.pushReceived(note)
      await until("odczyt listy po pushu") { (server.current?.read { $0.devicesCalls } ?? 0) > calls }
      // Odczyt w drodze blokuje następny (`devicesRead`): koniec tego przed następną ramką.
      try await Task.sleep(for: .milliseconds(30))
    }
  }

  @Test("„Zapomnij serwer”: serwer odpina, Keychain i dane znikają, token APNs oddany systemowi")
  func forget() async {
    let keychain = MemoryKeychain(.init(credential: PairingFixtures.credential(), pushKey: "BQUF"))
    let server = FakeServer(keychain: keychain)
    let store = server.store()
    let system = FakePushSystem(status: .authorized)
    store.attachSystem(push: system, background: FakeBackgroundWork(log: EventLog()), preferences: server.preferences)
    await store.start()
    let device = server.current
    await store.forgetServer()
    #expect(device?.read { $0.forgetCalls } == 1)
    #expect(keychain.load() == .none && keychain.snapshot.shared.isEmpty)
    #expect(store.state.auth == .loggedOut(.notLoggedIn))
    #expect(store.state.pairing.binding == .none)
    #expect(server.wipes == 1 && system.unregisterCalls == 1)
    #expect(server.pointer == nil && server.spaceNames.isEmpty && store.dataSpaceDirectory == nil)

    // Martwy serwer nie trzyma „Zapomnij” dłużej niż limit — sprzątanie lokalne i tak idzie.
    let slow = MemoryKeychain(.init(credential: PairingFixtures.credential(), pushKey: "BQUF"))
    let offline = FakeServer(keychain: slow)
    let dead = offline.store()
    await dead.start()
    offline.current?.set { $0.forgetResult = .offline(.notConnectedToInternet) }
    await dead.forgetServer()
    #expect(slow.load() == .none && dead.state.pairing.binding == .none)
  }

  @Test("„Zapomnij serwer” w drodze wyklucza parowanie, parowanie w drodze wyklucza „Zapomnij”")
  func forgetAndPairExclusive() async {
    let keychain = MemoryKeychain(.init(credential: PairingFixtures.credential(), pushKey: "BQUF"))
    let server = FakeServer(keychain: keychain)
    let store = server.store()
    await store.start()
    let gate = AsyncGate()
    server.current?.set { $0.onForget = { await gate.wait() } }
    let forgetting = Task { await store.forgetServer() }
    await until("zapominanie w drodze") { store.state.pairing.forgetting }
    store.offerPairing(PairingFixtures.link())
    #expect(store.state.pairing.flow == .idle, "link w trakcie „Zapomnij” nie otwiera arkusza")
    #expect(await store.confirmPairing() == .ignored)
    await gate.open()
    _ = await forgetting.value
    #expect(keychain.load() == .none && store.state.pairing.binding == .none)

    // Odwrotnie: parowanie w drodze, „Zapomnij” nic nie robi (nowy klucz nie zniknie po odpowiedzi).
    let second = FakeServer(keychain: MemoryKeychain(.init(credential: PairingFixtures.credential(), pushKey: "BQUF")))
    let paired = second.store()
    await paired.start()
    let pairGate = AsyncGate()
    second.pairing.set {
      $0.pairResult = .success(PairingFixtures.response(deviceId: "0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c"))
      $0.onPair = { await pairGate.wait() }
    }
    paired.offerPairing(PairingFixtures.link())
    let pairing = Task { await paired.confirmPairing() }
    await until("parowanie w drodze") { if case .pairing = paired.state.pairing.flow { true } else { false } }
    let old = second.current
    await paired.forgetServer()
    #expect(old?.read { $0.forgetCalls } == 0)
    await pairGate.open()
    #expect(await pairing.value == .paired)
    guard case let .found(credential, _) = second.keychain.load() else {
      Issue.record("klucz nowego parowania zniknął")
      return
    }
    #expect(credential.deviceId == "0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c")
  }

  @Test("wpis kolejki zapisywany w trakcie „Zapomnij serwer” nie wraca do wyczyszczonej kolejki")
  func sendDuringWipe() async throws {
    let keychain = MemoryKeychain(.init(credential: PairingFixtures.credential(), pushKey: "BQUF"))
    let server = FakeServer(keychain: keychain)
    let store = server.store()
    await store.start()
    let device = try #require(server.current)
    await until("online") { store.state.global == .online }
    device.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s1"}"#)
    device.push(.global, json: #"{"type":"sessions-snapshot","sessions":[\#(Frames.summary("s1", state: "waiting-input"))]}"#)
    await until("lista") { store.state.sessionsLoaded }
    store.openSession("s1")
    await until("strumień sesji") { device.streamCalls.contains { $0.scope == .session(id: "s1") } }
    device.push(.session(id: "s1"), json: #"{"type":"transcript-snapshot","sessionId":"s1","messages":[],"pendingPermissions":[],"pendingQuestions":[]}"#)
    await until("transkrypt") { store.state.transcripts["s1"]?.snapshots == 1 }
    // Zapis kolejki stoi za zaworem: wysyłka czeka na dysk, a w tym czasie dane serwera znikają.
    let gate = AsyncGate()
    store.chainPersistence { _ in await gate.wait() }
    let sending = Task { await store.send(text: "do skasowanego serwera", to: "s1") }
    try await Task.sleep(for: .milliseconds(30))
    await store.forgetServer()
    await gate.open()
    #expect(await sending.value == .ignored)
    await store.flushPersistence()
    #expect(store.state.outbox.isEmpty)
    // Ten sam serwer sparowany od nowa dostaje nową, pustą przestrzeń; restart też niczego nie odtworzy.
    store.offerPairing(PairingFixtures.link())
    #expect(await store.confirmPairing() == .paired)
    #expect(store.state.outbox.isEmpty)
    let restarted = server.store()
    await restarted.start()
    #expect(restarted.state.outbox.isEmpty, "wpis zapisany w trakcie „Zapomnij” nie wraca")
  }

  /// `createPanel` czytał transport drugi raz po `await` — spóźnione 400 serwera A po
  /// sparowaniu z B wysyłało ponowienie na modelu domyślnym przez transport B, z katalogiem z A.
  @Test("400 model-unknown z serwera A po sparowaniu z B: ponowienie nie wychodzi przez transport B")
  func createRetryAfterSwitch() async {
    let server = FakeServer(keychain: MemoryKeychain(.init(credential: PairingFixtures.credential(), pushKey: "BQUF")))
    let first = FakeTransport(credential: false)
    server.queued = [first]
    let store = server.store()
    await store.start()
    await online(store, first)
    let gate = AsyncGate()
    first.set {
      $0.createResults = [.failure(.http(APIFailure(status: 400, code: "model-unknown", message: "Nieznany model.")))]
      $0.onCreate = { await gate.wait() }
    }
    let defaults = NewSessionDefaults(model: "opus[1m]", effort: .xhigh)
    let creating = Task { await store.createSession(in: "/Users/a/Projects/x", defaults: defaults) }
    await until("POST w drodze") { first.read { $0.created.count } == 1 }
    store.offerPairing(PairingFixtures.link(server: URL(string: "https://inny.example")!))
    #expect(await store.confirmPairing(replacing: true) == .paired)
    guard let device = server.current, device !== first else {
      Issue.record("brak transportu serwera B")
      return
    }
    // Nowy serwer zdąży z `hello`, zanim przyjdzie odpowiedź starego — bramka mutacji by go przepuściła.
    await online(store, device)
    await gate.open()
    _ = await creating.value
    #expect(device.read { $0.created }.isEmpty, "ponowienie nie idzie do serwera B")
    #expect(first.read { $0.created.count } == 1, "ani drugi raz do A")
  }

  /// Serwer odpina urządzenie PRZED odpowiedzią 204 i zamyka jego strumienie, więc ponowne
  /// połączenie dostaje `device-revoked`, zanim `forgetDevice()` się skończy — lokalne sprzątanie nie może przepaść.
  @Test("device-revoked w trakcie „Zapomnij serwer”: dane, przestrzeń i znacznik odpięcia i tak znikają")
  func revokedDuringForget() async throws {
    let keychain = MemoryKeychain(.init(credential: PairingFixtures.credential(), pushKey: "BQUF"))
    let server = FakeServer(keychain: keychain)
    let store = server.store()
    await store.start()
    guard let device = server.current else { return }
    await until("strumień") { store.state.global == .online }
    let gate = AsyncGate()
    device.set { $0.onForget = { await gate.wait() } }
    let forgetting = Task { await store.forgetServer() }
    await until("zapominanie w drodze") { device.read { $0.forgetCalls } == 1 }
    device.set {
      $0.rejection = .revoked(
        deviceId: "03030303030303030303030303030303", revokedAt: "2026-10-22T10:00:00.000Z", revokedBy: "forget")
    }
    device.end(.global, error: .unauthorized(APIFailure(status: 401, code: "device-revoked")))
    await until("401 obsłużone") { store.state.auth != .loggedIn }
    await gate.open()
    _ = await forgetting.value
    #expect(store.state.auth == .loggedOut(.notLoggedIn), "ekran startowy, nie „To urządzenie odpięto”")
    #expect(store.state.pairing.revoked == nil && server.preferences.data(forKey: RarogStore.revokedKey) == nil)
    #expect(server.pointer == nil && server.spaceNames.isEmpty)
    #expect(server.wipes == 1 && keychain.load() == .none && !store.state.pairing.forgetting)
  }

  /// Przełączenie na B wpuszczało interfejs B, zanim kasowanie A się
  /// skończyło, a ponowienie kasowania po restarcie zjadało dane B. Przestrzenie: nic B nie kasuje.
  @Test("dane B przeżywają restart w trakcie sprzątania A")
  func otherServerDataSurvivesRestart() async throws {
    let server = FakeServer()
    let (store, _) = await paired(server)
    try await #require(server.outbox()).save(entryA())
    server.pairing.set { $0.pairResult = .success(PairingFixtures.response(deviceId: "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a", serverId: "serwer-b")) }
    store.offerPairing(PairingFixtures.link(server: URL(string: "https://b.example")!))
    #expect(await store.confirmPairing(replacing: true) == .paired)
    // Interfejs B pisze od razu; proces ginie, zanim kosz z A zniknął z dysku.
    try await #require(server.outbox()).save(entryA("do serwera B"))
    let restarted = server.store()
    await restarted.start()
    #expect(restarted.state.outbox.map(\.text) == ["do serwera B"], "B: swoje dane, A: żadnych")
  }

  /// Szósta runda, uwaga 2: nieudane usunięcie (tu: kosz to zwykły plik, `rename` do niego pada) nie może pokazać danych
  /// A pod B — apka czyta wyłącznie przestrzeń ze wskaźnika.
  @Test("błąd usunięcia przestrzeni A nie pokazuje danych A po przejściu na B")
  func failedRemovalDoesNotExposeOldData() async throws {
    let server = FakeServer()
    let (store, _) = await paired(server)
    let first = try #require(server.pointer)
    try await #require(server.outbox()).save(entryA())
    try FileManager.default.createDirectory(at: server.base, withIntermediateDirectories: true)
    try? FileManager.default.removeItem(at: server.spaces.trash)
    try Data("nie katalog".utf8).write(to: server.spaces.trash)
    server.pairing.set { $0.pairResult = .success(PairingFixtures.response(deviceId: "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a", serverId: "serwer-b")) }
    store.offerPairing(PairingFixtures.link(server: URL(string: "https://b.example")!))
    #expect(await store.confirmPairing(replacing: true) == .paired)
    #expect(server.spaceNames.contains(first.name), "przestrzeń A została na miejscu (kosz nie przyjął)")
    #expect(store.state.outbox.isEmpty)
    let restarted = server.store()
    await restarted.start()
    #expect(restarted.state.outbox.isEmpty, "po restarcie też nic z A")
  }

  /// Szósta runda, uwaga 3: własne `device-revoked` w trakcie „Zapomnij” kasuje klucz, zanim „Zapomnij” skończy;
  /// proces zabity w tym oknie nie może zostawić danych do odczytu — wskaźnik przestrzeni znika jako PIERWSZY krok.
  @Test("restart po device-revoked w „Zapomnij serwer”, przed końcem sprzątania: nic do odczytu")
  func restartAfterRevokedDuringForgetShowsNothing() async throws {
    let keychain = MemoryKeychain(.init(credential: PairingFixtures.credential(), pushKey: "BQUF"))
    let server = FakeServer(keychain: keychain)
    let store = server.store()
    try await #require(server.outbox()).save(entryA())
    await store.start()
    #expect(store.state.outbox.count == 1)
    guard let device = server.current else { return }
    await until("strumień") { store.state.global == .online }
    let gate = AsyncGate()
    device.set { $0.onForget = { await gate.wait() } }
    let forgetting = Task { await store.forgetServer() }
    await until("zapominanie w drodze") { device.read { $0.forgetCalls } == 1 }
    device.set {
      $0.rejection = .revoked(
        deviceId: "03030303030303030303030303030303", revokedAt: "2026-10-22T10:00:00.000Z", revokedBy: "forget")
    }
    device.end(.global, error: .unauthorized(APIFailure(status: 401, code: "device-revoked")))
    await until("klucz skasowany") { keychain.load() == .none }
    // Proces ginie tutaj: „Zapomnij” nie skończyło sprzątania.
    let restarted = server.store()
    await restarted.start()
    #expect(restarted.state.outbox.isEmpty && server.pointer == nil, "bez klucza i bez przestrzeni")
    restarted.offerPairing(PairingFixtures.link())
    #expect(await restarted.confirmPairing() == .paired)
    #expect(restarted.state.outbox.isEmpty, "ponowne parowanie z tym samym serwerem: nowa, pusta przestrzeń")
    await gate.open()
    _ = await forgetting.value
  }

  /// Kolejka czytana przy starcie z przestrzeni A wracała
  /// do stanu, gdy magazyn w trakcie odczytu przeszedł na B (parowanie z linku przy starcie).
  @Test("przejście na inny serwer w trakcie odczytu kolejki przy starcie: kolejka A nie wraca do stanu B")
  func switchDuringOutboxRestore() async throws {
    let keychain = MemoryKeychain(.init(credential: PairingFixtures.credential(), pushKey: "BQUF"))
    let server = FakeServer(keychain: keychain)
    _ = server.store()
    try await #require(server.outbox()).save(entryA())
    let store = server.store()
    let starting = Task { await store.start() }
    await Task.yield()
    #expect(store.state.outbox.isEmpty, "odczyt kolejki w drodze")
    let other = PairingFixtures.credential(
      deviceId: "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a", serverId: "serwer-b", server: URL(string: "https://b.example")!)
    store.install(.device(other))
    await starting.value
    #expect(store.state.outbox.isEmpty, "kolejka A nie wraca pod B")
    #expect(server.pointer?.origin == ServerOrigin(URL(string: "https://b.example")!))
  }

  /// Druga recenzja, uwaga 2: wskaźnik w `UserDefaults` mógł nie dotrzeć na dysk. Wskaźnik to plik, więc utrata
  /// preferencji (proces zabity, zanim `UserDefaults` je utrwaliło) nie zmienia przestrzeni.
  @Test("utrata preferencji nie zmienia przestrzeni: o przestrzeni decyduje plik wskaźnika")
  func preferencesLossKeepsSpace() async throws {
    let keychain = MemoryKeychain(.init(credential: PairingFixtures.credential(), pushKey: "BQUF"))
    let server = FakeServer(keychain: keychain)
    _ = server.store()
    try await #require(server.outbox()).save(entryA())
    server.preferences.set(nil, forKey: RarogStore.preferencesSpaceKey)
    let restarted = server.store()
    await restarted.start()
    #expect(restarted.state.outbox.count == 1, "po restarcie ta sama przestrzeń")
  }

  /// Telefon przed pierwszym odblokowaniem nie oddaje plików: wskaźnik nieczytelny nie może posłać przestrzeni do kosza.
  @Test("wskaźnik nieczytelny (dysk go nie oddaje): sesja bez danych, przestrzenie zostają na dysku")
  func unreadablePointerKeepsSpaces() async throws {
    let keychain = MemoryKeychain(.init(credential: PairingFixtures.credential(), pushKey: "BQUF"))
    let server = FakeServer(keychain: keychain)
    _ = server.store()
    let space = try #require(server.pointer)
    try await #require(server.outbox()).save(entryA())
    try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: server.spaces.pointerFile.path)
    let store = server.store()
    await store.start()
    try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: server.spaces.pointerFile.path)
    #expect(store.state.outbox.isEmpty && store.dataSpaceDirectory == nil, "nie wiadomo, czyja przestrzeń: żadna")
    #expect(server.spaceNames == [space.name] && server.pointer == space, "nic do kosza")
    let restarted = server.store()
    await restarted.start()
    #expect(restarted.state.outbox.count == 1, "dysk oddał wskaźnik: dane wracają")
  }

  /// A session with a key and no space (the pointer unreadable at the start) whose space holds a queue entry
  /// (`entryA`) and a cached list with `s1`; the disk returns the pointer, and the pairing sheet for the same server is
  /// open.
  private func sessionWithoutSpaceBeforePairing() async throws -> (FakeServer, RarogStore, ServerSpace) {
    let keychain = MemoryKeychain(.init(credential: PairingFixtures.credential(), pushKey: "BQUF"))
    let server = FakeServer(keychain: keychain)
    _ = server.store()
    let space = try #require(server.pointer)
    try await #require(server.outbox()).save(entryA())
    let row = try JSONDecoder().decode(SessionSummary.self, from: Data(Frames.summary("s1").utf8))
    #expect(await SnapshotCache(directory: server.spaces.directory(space).appending(path: ServerSpaces.list)).save([row], at: Date()))
    let pointer = server.spaces.pointerFile.path
    try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: pointer)
    let store = server.store()
    await store.start()
    try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: pointer)
    #expect(store.dataSpaceDirectory == nil && store.state.outbox.isEmpty, "a session without a space")
    store.offerPairing(PairingFixtures.link())
    return (server, store, space)
  }

  @Test("session without a space (pointer unreadable at the start), the disk returns the pointer, pairing again with the same server: the pairing logs in with the space's queue and list already in the state")
  func pairingIntoPointerSpaceShowsItsData() async throws {
    let (server, store, space) = try await sessionWithoutSpaceBeforePairing()
    #expect(await store.confirmPairing() == .paired)
    #expect(store.dataSpaceDirectory == server.spaces.directory(space) && server.wipes == 1)
    // No wait: the login opens streams and lets messages out only after the space's queue and list are read.
    #expect(store.state.auth == .loggedIn)
    #expect(store.state.outbox.map(\.text) == ["do serwera A"] && store.state.sessions["s1"] != nil)
    #expect(store.state.listCache.staleSince != nil, "the list comes from the cache, stale until the first stream state")
  }

  @Test("an entry that reaches the outbox right after pairing into the pointer's space keeps its place and state")
  func entryAfterPairingKeepsItsPlace() async throws {
    let (server, store, _) = try await sessionWithoutSpaceBeforePairing()
    #expect(await store.confirmPairing() == .paired)
    // The state a send leaves once its write is done: the entry in the outbox, accepted by the server.
    let accepted = Date()
    let fresh = OutboxEntry(sessionId: "s1", text: "right after pairing", createdAt: accepted, state: .sent(acceptedAt: accepted))
    store.dispatch(.outboxEnqueued(fresh))
    await until("queue of the space") { store.state.outbox.contains { $0.text == "do serwera A" } }
    #expect(store.state.outbox.first { $0.id == fresh.id }?.state == .sent(acceptedAt: accepted))
    #expect(server.wipes == 1)
  }

  @Test("an echo that arrives right after pairing into the pointer's space settles the space's queue entry for good")
  func echoAfterPairingSettlesTheRestoredEntry() async throws {
    let (server, store, _) = try await sessionWithoutSpaceBeforePairing()
    #expect(await store.confirmPairing() == .paired)
    let at = ISOTime.string(Date().addingTimeInterval(1))
    store.dispatch(.frame(try Frames.transcript("sesja-a"), source: .session("sesja-a"), cursor: nil))
    let echo = try Frames.message("sesja-a", seq: 10, role: "user", text: "do serwera A", at: at)
    store.dispatch(.frame(echo, source: .session("sesja-a"), cursor: nil))
    // A read of the space's queue that ended after the echo would bring the settled entry back as pending.
    try await Task.sleep(for: .milliseconds(200))
    #expect(!store.state.outbox.contains { $0.text == "do serwera A" }, "the echo settled it")
    #expect(server.wipes == 1)
  }

  @Test("device-revoked, then pairing again with the same server: the space's queue is on screen in the same store, also when the start had no space")
  func repairAfterRevocationShowsQueue() async throws {
    for readable in [true, false] {
      let label = readable ? "pointer read at the start" : "pointer unreadable at the start"
      let keychain = MemoryKeychain(.init(credential: PairingFixtures.credential(), pushKey: "BQUF"))
      let server = FakeServer(keychain: keychain)
      _ = server.store()
      try await #require(server.outbox()).save(entryA())
      let pointer = server.spaces.pointerFile.path
      if !readable { try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: pointer) }
      let store = server.store()
      await store.start()
      try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: pointer)
      #expect(store.state.outbox.count == (readable ? 1 : 0), "\(label)")
      let device = try #require(server.current)
      await until("global stream") { store.state.global == .online }
      device.set {
        $0.rejection = .revoked(
          deviceId: "03030303030303030303030303030303", revokedAt: "2026-10-04T10:03:00.000Z", revokedBy: "admin")
      }
      device.end(.global, error: .unauthorized(APIFailure(status: 401, code: "device-revoked")))
      await until("revoked screen") { store.state.auth == .loggedOut(.deviceRevoked) }
      store.offerPairing(PairingFixtures.link())
      #expect(await store.confirmPairing() == .paired, "\(label)")
      let space = try #require(server.pointer)
      #expect(store.dataSpaceDirectory == server.spaces.directory(space), "\(label)")
      await until("queue of the space, \(label)") { store.state.outbox.map(\.text) == ["do serwera A"] }
    }
  }

  /// Sesja A bez przestrzeni na dysku (wskaźnik
  /// nieczytelny) i parowanie z B nie czyściły stanu A w pamięci ani półki załączników — czyszczenie zależało od
  /// przestrzeni, a nie od właściciela danych w pamięci.
  @Test("sesja A bez przestrzeni na dysku, potem parowanie z B: stan A w pamięci i półka znikają")
  func switchFromSessionWithoutSpaceWipesMemory() async throws {
    let keychain = MemoryKeychain(.init(credential: PairingFixtures.credential(), pushKey: "BQUF"))
    let server = FakeServer(keychain: keychain)
    _ = server.store()
    let pointer = server.spaces.pointerFile.path
    try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: pointer)
    let store = server.store()
    await store.start()
    try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: pointer)
    #expect(store.dataSpaceDirectory == nil && store.state.auth == .loggedIn, "A bez przestrzeni")
    store.dispatch(.outboxEnqueued(entryA()))
    server.pairing.set { $0.pairResult = .success(PairingFixtures.response(deviceId: "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a", serverId: "serwer-b")) }
    store.offerPairing(PairingFixtures.link(server: URL(string: "https://b.example")!))
    #expect(await store.confirmPairing(replacing: true) == .paired)
    #expect(store.state.outbox.isEmpty && server.wipes == 1, "stan A nie przechodzi pod B")
  }

  /// Wskaźnik zapisany przez starszy build może nieść pole `migrating: true`. Dekoder je pomija: apka wchodzi do tej
  /// przestrzeni jak do każdej innej, czyta jej dane i nie wysyła jej do kosza.
  @Test("wskaźnik z polem `migrating: true`: ta sama przestrzeń, jej dane na ekranie, nic do kosza")
  func pointerWithMigratingFieldEntersSpace() async throws {
    let keychain = MemoryKeychain(.init(credential: PairingFixtures.credential(), pushKey: "BQUF"))
    let server = FakeServer(keychain: keychain)
    let space = server.spaces.newSpace(for: try #require(ServerOrigin(PairingFixtures.server)))
    var json = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(space)) as? [String: Any])
    json["migrating"] = true
    try FileManager.default.createDirectory(at: server.spaces.root, withIntermediateDirectories: true)
    try JSONSerialization.data(withJSONObject: json).write(to: server.spaces.pointerFile)
    try await #require(server.outbox(space)).save(entryA())
    let store = server.store()
    await store.start()
    #expect(store.dataSpaceDirectory == server.spaces.directory(space) && store.state.outbox.count == 1)
    #expect(server.pointer == space && server.spaceNames == [space.name], "ta sama przestrzeń, nie w koszu")
  }

  /// Trzecia recenzja, uwaga 3: „Zapomnij serwer” przy dysku, który nie dał skasować ani wskaźnika, ani przestrzeni,
  /// kasowało klucz — po restarcie i ponownym parowaniu zapomniane dane wracały. Teraz „Zapomnij” przerywa się.
  @Test("„Zapomnij serwer” przy servers/ bez prawa zapisu: przerwane, klucz i dane zostają; po naprawie dysku działa")
  func forgetAbortsWhenDiskRefuses() async throws {
    let keychain = MemoryKeychain(.init(credential: PairingFixtures.credential(), pushKey: "BQUF"))
    let server = FakeServer(keychain: keychain)
    _ = server.store()
    try await #require(server.outbox()).save(entryA())
    let store = server.store()
    await store.start()
    let root = server.spaces.root.path
    try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: root)
    let forgotten = await store.forgetServer()
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: root)
    #expect(!forgotten && store.state.pairing.forgetFailed && !store.state.pairing.forgetting)
    #expect(keychain.load() != .none && store.state.outbox.count == 1, "klucz i dane zostały")
    #expect(await store.forgetServer() && !store.state.pairing.forgetFailed)
    let restarted = server.store()
    await restarted.start()
    restarted.offerPairing(PairingFixtures.link())
    #expect(await restarted.confirmPairing() == .paired)
    #expect(restarted.state.outbox.isEmpty, "zapomniane dane nie wracają")
  }

  /// Czwarta recenzja, uwaga 2: ponowne parowanie z tym samym serwerem w sesji bez przestrzeni zakładało nowy katalog
  /// roboczy kolejki — wpisy w stanie traciły pliki załączników („Ponów” = brak załącznika).
  @Test("ponowne parowanie z tym samym serwerem w sesji bez przestrzeni: ta sama kolejka")
  func samePairingKeepsOutboxWithoutSpace() async throws {
    let keychain = MemoryKeychain(.init(credential: PairingFixtures.credential(), pushKey: "BQUF"))
    let server = FakeServer(keychain: keychain)
    // Dysk, który nie przyjmuje wskaźnika: sesja bez przestrzeni. Wskaźnik, którego dysk nie oddaje, parowania nie
    // dopuszcza (odmowa przed żądaniem, `StorePairingTests+Iroh`).
    server.pointerDisk.refuse { _ in true }
    let store = server.store()
    await store.start()
    #expect(store.dataSpaceDirectory == nil && store.state.auth == .loggedIn, "sesja bez przestrzeni")
    let before = store.persistence
    store.offerPairing(PairingFixtures.link())
    #expect(await store.confirmPairing() == .paired)
    #expect(store.persistence === before && server.wipes == 0)
  }

  @Test("ten sam serwer pod równoważnym adresem (wielkość liter, :443, ukośnik) zachowuje dane; inny port i schemat — nie")
  func equivalentOrigins() async throws {
    let cases: [(URL, Bool)] = [
      (URL(string: "https://RAROG.example:443")!, true),
      (URL(string: "https://rarog.example:8443")!, false),
    ]
    for (link, kept) in cases {
      let current = URL(string: "https://rarog.example/")!
      let keychain = MemoryKeychain(.init(credential: PairingFixtures.credential(server: current), pushKey: "BQUF"))
      let server = FakeServer(keychain: keychain)
      _ = server.store()
      try await #require(server.outbox()).save(entryA())
      let store = server.store()
      await store.start()
      #expect(store.state.outbox.count == 1)
      store.offerPairing(PairingFixtures.link(server: link))
      #expect(await store.confirmPairing(replacing: !kept) == .paired)
      #expect(server.wipes == (kept ? 0 : 1), "\(link)")
      #expect(store.state.outbox.count == (kept ? 1 : 0), "\(link)")
    }
  }

  @Test("Keychain zablokowany przy starcie (przed pierwszym odblokowaniem): ekran startowy czeka, po odblokowaniu start")
  func lockedKeychain() async {
    let keychain = MemoryKeychain(.init(credential: PairingFixtures.credential(), pushKey: "BQUF"))
    keychain.update { $0.locked = true }
    let server = FakeServer(keychain: keychain)
    let store = server.store()
    await store.start()
    #expect(store.state.auth == .unknown, "zablokowany Keychain to nie „brak klucza”")
    keychain.update { $0.locked = false }
    store.protectedDataBecameAvailable()
    await until("start z kluczem") { store.state.auth == .loggedIn }
    #expect(store.state.pairing.paired?.deviceId == "03030303030303030303030303030303")
    // Przed odblokowaniem apka nie miała przestrzeni (szkice w pamięci); klucz ją wybrał — interfejs od nowa.
    #expect(store.dataSpaceDirectory != nil && store.interfaceEpoch == 1)
  }

  @Test("start z kluczem odtwarza wpis współdzielony klucza push z kopii prywatnej: idempotentnie")
  func restoresSharedPushKey() async {
    let keychain = MemoryKeychain(.init(credential: PairingFixtures.credential(), pushKey: "BQUF"))
    keychain.update {
      $0.shared = [:]
      $0.sharedWrites = 0
    }
    let server = FakeServer(keychain: keychain)
    let store = server.store()
    #expect(keychain.snapshot.shared == ["f849d673": "BQUF"] && keychain.snapshot.sharedWrites == 1)
    await store.start()
    // Drugi start (ponowne uruchomienie apki): wpis już jest — bez zapisu.
    _ = server.store()
    #expect(keychain.snapshot.sharedWrites == 1)
  }

  @Test("fabryka apki `RarogStore.live(connector:…)` odtwarza wpis współdzielony klucza push: idempotentnie, grupa odmawia — start i tak")
  func liveRestoresSharedPushKey() {
    // Prawdziwe `live`, nie kopia w `FakeServer.store()`. Bez `start()`: domyślne `MutationRules()` tylko by spowolniły.
    let keychain = MemoryKeychain(.init(credential: PairingFixtures.credential(), pushKey: "BQUF"))
    keychain.update {
      $0.shared = [:]
      $0.sharedWrites = 0
    }
    let server = FakeServer(keychain: keychain)
    _ = RarogStore.live(connector: server.connector, preferences: server.preferences, spaces: server.spaces)
    #expect(keychain.snapshot.shared == ["f849d673": "BQUF"] && keychain.snapshot.sharedWrites == 1)
    _ = RarogStore.live(connector: server.connector, preferences: server.preferences, spaces: server.spaces)
    #expect(keychain.snapshot.sharedWrites == 1, "drugi start: wpis już jest — bez zapisu")

    let refusing = MemoryKeychain(.init(credential: PairingFixtures.credential(), pushKey: "BQUF"))
    refusing.update {
      $0.shared = [:]
      $0.sharedFailure = true
    }
    let other = FakeServer(keychain: refusing)
    let store = RarogStore.live(connector: other.connector, preferences: other.preferences, spaces: other.spaces)
    #expect(refusing.snapshot.shared.isEmpty)
    #expect(store.serverEndpoint.credential?.deviceId == "03030303030303030303030303030303", "klucz urządzenia zostaje")
  }

  @Test("odtworzenie po odblokowaniu (Keychain zablokowany przy starcie) i linia client.log, gdy grupa odmawia")
  func restoresAfterUnlockAndReportsFailure() async {
    let keychain = MemoryKeychain(.init(credential: PairingFixtures.credential(), pushKey: "BQUF"))
    keychain.update {
      $0.shared = [:]
      $0.locked = true
    }
    let server = FakeServer(keychain: keychain)
    let store = server.store()
    #expect(keychain.snapshot.shared.isEmpty, "zablokowany Keychain: nic do odtworzenia")
    await store.start()
    keychain.update { $0.locked = false }
    store.protectedDataBecameAvailable()
    await until("start z kluczem") { store.state.auth == .loggedIn }
    #expect(keychain.snapshot.shared == ["f849d673": "BQUF"])

    let refusing = MemoryKeychain(.init(credential: PairingFixtures.credential(), pushKey: "BQUF"))
    refusing.update {
      $0.shared = [:]
      $0.sharedFailure = true
    }
    let other = FakeServer(keychain: refusing)
    let failing = other.store()
    await failing.start()
    await until("linia o grupie") {
      (other.current?.read { $0.clientLogs.flatMap(\.events).map(\.msg) } ?? []).contains {
        $0.contains("klucz push bez grupy współdzielonej")
      }
    }
    #expect(failing.state.auth == .loggedIn, "porażka grupy nie zatrzymuje startu")
  }

  @Test("bez klucza: ekran parowania, link z rarog:// trafia do arkusza")
  func unpaired() async {
    let server = FakeServer()
    let store = server.store()
    await store.start()
    #expect(store.state.auth == .loggedOut(.notLoggedIn) && store.state.pairing.binding == .none)
    let link = PairingFixtures.link()
    store.openLink(.pair(link))
    #expect(store.state.pairing.flow == .confirming(link))
    store.openLink(.badPair(.unsupportedVersion))
    #expect(store.state.pairing.flow == .rejected(.unsupportedVersion))
    #expect(store.offerPairing(text: "nie link") == .notALink)
  }
}

/// Atrapa serwera dla prawdziwego `RarogClient` (parowanie przez bramkę): odpowiedź per port.
final class PairStub: URLProtocol, @unchecked Sendable {
  private static let replies = Mutex<[Int: (Int, String)]>([:])
  private static let nextPort = Atomic<Int>(47_000)

  static func register(status: Int, body: String) -> Int {
    let port = nextPort.add(1, ordering: .relaxed).newValue
    replies.withLock { $0[port] = (status, body) }
    return port
  }

  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    guard let url = request.url, let port = url.port, let (status, body) = Self.replies.withLock({ $0[port] }) else {
      client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
      return
    }
    let response = HTTPURLResponse(
      url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
    client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(body.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {}
}
