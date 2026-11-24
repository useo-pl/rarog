import CryptoKit
import Foundation
import RarogContract
@testable import RarogCore
import RarogTransport
import Synchronization
import Testing

// Parowanie i aktualizacja w miejscu z serwerem iroh: cel parowania z linku (`u`, `u`+`k`+`r`,
// `k`+`r`), para iroh z odpowiedzi albo z linku, kod dla nowego urządzenia z polami iroh, para z sondy wersji
// zapisana w tym samym wpisie tylko przy tej samej drodze i parze, przestrzeń danych serwera tylko przez iroh
// i ponowne parowanie z dowodem klucza serwera.

/// Zawór wstrzymanej odpowiedzi atrapy: `wait()` czeka do `open()`; `entered` liczy wejścia.
private final class ResponseValve: Sendable {
  private let state = Mutex<(open: Bool, waiting: [CheckedContinuation<Void, Never>], entered: Int)>((false, [], 0))

  var entered: Int { state.withLock { $0.entered } }

  func wait() async {
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      let open = state.withLock { state in
        state.entered += 1
        if !state.open { state.waiting.append(continuation) }
        return state.open
      }
      if open { continuation.resume() }
    }
  }

  func open() {
    let waiting = state.withLock { state in
      state.open = true
      defer { state.waiting = [] }
      return state.waiting
    }
    for continuation in waiting { continuation.resume() }
  }
}

/// Zrzut pliku wskaźnika w wybranej chwili (z zaczepienia Keychaina): treść, która zostałaby na dysku po procesie
/// zabitym w tym miejscu.
final class PointerSnapshot: Sendable {
  private let state = Mutex<Data?>(nil)

  var data: Data? { state.withLock { $0 } }

  func take(_ file: URL) {
    let data = try? Data(contentsOf: file)
    state.withLock { $0 = data }
  }
}

/// Chwila zapisu klucza w Keychainie (z zaczepienia po zapisie): plik wskaźnika, który zostałby na dysku po procesie
/// zabitym tuż przed zapisem klucza (między zapowiedzią a Keychainem nic nie pisze wskaźnika), i liczba zapisów
/// wskaźnika do tej chwili. `nil` = Keychain nie dostał klucza.
private final class KeySaveMoment: Sendable {
  private let state = Mutex<(pointer: Data?, writes: Int)?>(nil)

  var pointer: Data? { state.withLock { $0?.pointer } }
  var writes: Int? { state.withLock { $0?.writes } }

  func take(_ file: URL, _ disk: PointerDisk) {
    let moment = (pointer: try? Data(contentsOf: file), writes: disk.writes.count)
    state.withLock { $0 = moment }
  }
}

/// Keychain złącza z odczytem podanym przez test (błąd `OSStatus`, którego atrapa w pamięci nie daje); zapis,
/// kasowanie i klucz push idą do Keychaina pod spodem.
private final class ReadOverrideKeychain: DeviceKeychain {
  private let base: any DeviceKeychain
  private let read: KeychainRead

  init(_ base: any DeviceKeychain, read: KeychainRead) {
    self.base = base
    self.read = read
  }

  func load() -> KeychainRead { read }

  func pushKey(kid: String) -> PushKeyRead { base.pushKey(kid: kid) }

  @discardableResult
  func save(_ credential: DeviceCredential, pushKey: String) throws(KeychainFailure) -> Bool {
    try base.save(credential, pushKey: pushKey)
  }

  @discardableResult
  func delete(deviceId: String?) -> Bool { base.delete(deviceId: deviceId) }

  @discardableResult
  func restoreSharedPushKey(kid: String, pushKey: String) -> Bool { base.restoreSharedPushKey(kid: kid, pushKey: pushKey) }
}

extension PairingLinkTests {
  static let endpoint = PairingFixtures.endpointId
  static let relayField = "https%3A%2F%2Feuc1-1.relay.n0.iroh.link.%2F"
  static let relay = PairingFixtures.iroh(relay: "https://euc1-1.relay.n0.iroh.link./")

  @Test("pola iroh `k=`/`r=`: `u` → .https, `u`+`k`+`r` → .both, `k`+`r` → .iroh; złożenie wraca ten sam link")
  func irohTargets() throws {
    let plain = "https://rarog.ai/pair#v=1&u=https%3A%2F%2Frarog.example.ts.net&c=\(Self.code)"
    let both = "https://rarog.ai/pair#v=1&u=https%3A%2F%2Frarog.example.ts.net&k=\(Self.endpoint)&r=\(Self.relayField)&c=\(Self.code)"
    let only = "https://rarog.ai/pair#v=1&k=\(Self.endpoint)&r=\(Self.relayField)&c=\(Self.code)"
    let url = try #require(URL(string: "https://rarog.example.ts.net"))
    #expect(try PairingLink.parse(plain).get().target == .https(url))
    let full = try PairingLink.parse(both).get()
    #expect(full.target == .both(url, Self.relay) && full.host == "rarog.example.ts.net")
    #expect(full.url.absoluteString == both && full.serverURL == url && full.iroh == Self.relay)
    let iroh = try PairingLink.parse(only).get()
    #expect(iroh.target == .iroh(Self.relay) && iroh.serverURL == nil)
    #expect(iroh.host == "iroh · 523c7996" && iroh.url.absoluteString == only)
    #expect(iroh.server.absoluteString == "iroh:\(Self.endpoint)", "adres do pokazania bez sieci")
    #expect(PushRouting.link(url: try #require(URL(string: only))) == .pair(iroh))
  }

  @Test("link iroh spoza zasad: `k` bez `r`, wielkie litery w `k`, duplikat; `k`+`r` bez kodu odrzucony jak dziś")
  func irohRejections() {
    func error(_ text: String) -> PairingLinkError? {
      if case let .failure(error) = PairingLink.parse(text) { return error }
      return nil
    }
    #expect(error("rarog://pair#v=1&k=\(Self.endpoint)&c=\(Self.code)") == .badAddress, "k bez r")
    #expect(error("rarog://pair#v=1&k=\(Self.endpoint.uppercased())&r=\(Self.relayField)&c=\(Self.code)") == .badAddress)
    #expect(error("rarog://pair#v=1&k=\(Self.endpoint)&k=\(Self.endpoint)&r=\(Self.relayField)&c=\(Self.code)") == .notALink)
    #expect(error("rarog://pair#v=1&r=\(Self.relayField)&c=\(Self.code)") == .badAddress, "r bez k")
    // Link aktualizacji relaya (`k`+`r` bez `c`) to nie link parowania.
    #expect(error("rarog://pair#v=1&k=\(Self.endpoint)&r=\(Self.relayField)") == .badCode)
  }
}

extension StorePairingTests {
  private var iroh: ServerIrohConfig { PairingFixtures.iroh() }

  private func irohLink(server: URL? = nil, iroh: ServerIrohConfig = PairingFixtures.iroh()) -> PairingLink {
    PairingLink(target: server.map { .both($0, iroh) } ?? .iroh(iroh), code: PairingFixtures.code)
  }

  /// Linie `client.log`, które wyszły przez transport.
  private func logs(_ transport: FakeTransport?) -> [String] {
    transport?.read { $0.clientLogs.flatMap(\.events).map(\.msg) } ?? []
  }

  /// Linie `client.log` ze wszystkich transportów złącza (linia przed przełączeniem idzie starym).
  private func allLogs(_ server: FakeServer) -> [String] {
    server.built.flatMap { logs($0.transport) }
  }

  /// Magazyn z poświadczeniem w Keychainie, zalogowany, z żywym strumieniem i `hello`; `prepare` ustawia atrapę
  /// przed startem.
  private func started(
    _ credential: DeviceCredential, prepare: (FakeTransport) -> Void = { _ in }
  ) async -> (FakeServer, RarogStore, FakeTransport) {
    let server = FakeServer(keychain: MemoryKeychain(.init(credential: credential, pushKey: "BQUF")))
    let first = FakeTransport(credential: false)
    prepare(first)
    server.queued = [first]
    let store = server.store()
    await store.start()
    await until("strumień globalny") { !first.streamCalls.isEmpty }
    first.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"s1"}"#)
    first.push(.global, json: #"{"type":"sessions-snapshot","sessions":[]}"#)
    await until("świeża lista") { store.state.sessionsLoaded && store.state.compat == .ok }
    return (server, store, first)
  }

  /// Odpowiedź `GET /api/version` z polem `iroh` (surowe wartości, `nil` = `null`).
  private func version(iroh: (endpointId: String, relay: String)?, termEnabled: Bool = false) throws -> VersionInfo {
    let field = iroh.map { #"{"endpointId":"\#($0.endpointId)","relay":"\#($0.relay)"}"# } ?? "null"
    let text = PairingFixtures.json("version.json")
      .replacingOccurrences(of: #""iroh": null"#, with: #""iroh": "# + field)
      .replacingOccurrences(of: #""termEnabled": false"#, with: #""termEnabled": \#(termEnabled)"#)
    return try JSONDecoder().decode(VersionInfo.self, from: Data(text.utf8))
  }

  private func saved(_ server: FakeServer) -> (DeviceCredential, String)? {
    if case let .found(credential, pushKey) = server.keychain.load() { return (credential, pushKey) }
    return nil
  }

  // MARK: Cel parowania i zapis tras

  @Test("link `u`: parowanie przez adres; para iroh z odpowiedzi po walidacji, zła pominięta z linią, `null` bez pary")
  func httpsLink() async throws {
    for (reply, expected) in [
      ((PairingFixtures.endpointId, "https://relay.rarog.ai"), Optional(iroh)),
      ((String(PairingFixtures.endpointId.dropLast()), PairingFixtures.relay), nil),
    ] as [((String, String), ServerIrohConfig?)] {
      let server = FakeServer()
      let store = server.store()
      await store.start()
      server.pairing.set { $0.pairResult = .success(PairingFixtures.response(iroh: reply)) }
      store.offerPairing(PairingFixtures.link())
      #expect(await store.confirmPairing() == .paired)
      #expect(server.pairingTargets == [.https(PairingFixtures.server)])
      let (credential, _) = try #require(saved(server))
      #expect(credential.serverURL == PairingFixtures.server && credential.iroh == expected)
      #expect(store.state.pairing.paired?.iroh == expected)
      if expected == nil {
        await until("linia o parze z odpowiedzi") { self.allLogs(server).contains { $0.contains("pairing reply") } }
        #expect(!allLogs(server).contains { $0.contains(PairingFixtures.endpointId.prefix(16)) }, "bez wartości")
      }
    }
    let server = FakeServer()
    let store = server.store()
    await store.start()
    server.pairing.set { $0.pairResult = .success(PairingFixtures.response(iroh: nil)) }
    store.offerPairing(PairingFixtures.link())
    #expect(await store.confirmPairing() == .paired)
    #expect(try #require(saved(server)).0.iroh == nil)
  }

  @Test("link `u`+`k`+`r`: cel .both; zapis adresu i pary z odpowiedzi, a bez niej (także złej) z linku")
  func bothLink() async throws {
    let other = PairingFixtures.iroh(relay: "https://euc1-1.relay.n0.iroh.link./")
    for (reply, expected) in [
      (Optional((PairingFixtures.endpointId, "https://euc1-1.relay.n0.iroh.link./")), other),
      (nil, iroh),
      (Optional((PairingFixtures.endpointId, "relay.rarog.ai")), iroh),
    ] as [((String, String)?, ServerIrohConfig)] {
      let server = FakeServer()
      let store = server.store()
      await store.start()
      server.pairing.set { $0.pairResult = .success(PairingFixtures.response(iroh: reply)) }
      let link = irohLink(server: PairingFixtures.server)
      store.offerPairing(link)
      #expect(await store.confirmPairing() == .paired)
      #expect(server.pairingTargets == [.both(PairingFixtures.server, iroh)])
      let (credential, pushKey) = try #require(saved(server))
      #expect(credential.serverURL == PairingFixtures.server && credential.iroh == expected)
      #expect(credential.account == "rarog.example" && pushKey == "BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU")
    }
  }

  @Test("link `k`+`r`: cel .iroh; zapis samej pary, konto `iroh:<id>`, zalogowanie i serwer bez adresu")
  func irohOnlyLink() async throws {
    let server = FakeServer()
    let store = server.store()
    await store.start()
    server.pairing.set { $0.pairResult = .success(PairingFixtures.response(iroh: nil)) }
    store.offerPairing(irohLink())
    #expect(store.state.pairing.flow == .confirming(irohLink()))
    #expect(await store.confirmPairing() == .paired)
    #expect(server.pairingTargets == [.iroh(iroh)])
    let (credential, _) = try #require(saved(server))
    #expect(credential.serverURL == nil && credential.iroh == iroh)
    #expect(credential.account == "iroh:\(PairingFixtures.endpointId)")
    #expect(store.state.auth == .loggedIn && store.state.pairing.paired?.url == nil)
    #expect(store.state.pairing.paired?.iroh == iroh)
  }

  // MARK: Porażki

  @Test("parowanie przez iroh z drugim serwerem pada przy żywym REST, SSE i terminalu: stary transport bez zmian")
  func failureKeepsLiveTransport() async throws {
    let valve = ResponseValve()
    let reply = try version(iroh: nil, termEnabled: true)
    let (server, store, first) = await started(PairingFixtures.credential()) { transport in
      transport.set {
        $0.version = reply
        $0.onVersion = { await valve.wait() }
      }
    }
    await until("sonda wersji w drodze") { valve.entered >= 1 }
    store.dispatch(.versionProbed(reply))
    let target = try #require(TerminalTarget.shell(cwd: "/Users/demo/Projects/rarog"))
    let session = try #require(store.terminalSession(target))
    session.start()
    await until("gniazdo") { first.terminal.sockets.count == 1 }
    let socket = try #require(first.terminal.lastSocket)
    socket.emit(.opened)
    await until("terminal żywy") { session.phase == .live }

    server.pairing.set { $0.pairResult = .failure(.offline(.notConnectedToInternet)) }
    let link = irohLink(iroh: PairingFixtures.iroh(PairingFixtures.otherEndpointId))
    store.offerPairing(link)
    #expect(await store.confirmPairing(replacing: true) == .failed(.offline))
    #expect(server.pairingTargets == [.iroh(link.iroh!)])
    #expect(server.current === first && store.state.global == .online && store.state.auth == .loggedIn)
    #expect(session.phase == .live && !socket.closedByClient, "terminal starego transportu żyje")
    #expect(server.released.isEmpty && server.forgotten.isEmpty && server.routeChanges.isEmpty)
    #expect(server.keychain.load() == .found(PairingFixtures.credential(), pushKey: "BQUF"))
    // Żądanie REST w drodze kończy się na starym transporcie.
    valve.open()
    await until("sonda wersji zapisana") { self.saved(server)?.0.serverSystem == .macos }
    #expect(server.current === first)
  }

  @Test("parowanie przez iroh: `saveFailure` zostawia stary wpis i transport; `sharedFailure` paruje z linią")
  func keychainFailures() async throws {
    let (server, store, first) = await started(PairingFixtures.credential())
    server.keychain.update { $0.saveFailure = -25_308 }
    store.offerPairing(irohLink(server: PairingFixtures.server))
    #expect(await store.confirmPairing(replacing: true) == .failed(.keychain(-25_308)))
    #expect(server.current === first && server.released.isEmpty)
    #expect(server.keychain.load() == .found(PairingFixtures.credential(), pushKey: "BQUF"))

    server.keychain.update {
      $0.saveFailure = nil
      $0.sharedFailure = true
      $0.sharedWrites = 0
    }
    store.offerPairing(irohLink(server: PairingFixtures.server))
    #expect(await store.confirmPairing(replacing: true) == .paired)
    #expect(try #require(saved(server)).0.iroh == iroh, "nowy wpis prywatny obowiązuje")
    #expect(server.keychain.snapshot.sharedWrites == 0 && server.released.count == 1)
    await until("linia o grupie współdzielonej") {
      self.allLogs(server).contains { $0.contains("klucz push bez grupy współdzielonej") }
    }
  }

  // MARK: Kod dla nowego urządzenia

  @Test("kod dla nowego urządzenia: tylko-iroh → link `k`+`r`, adres i iroh → `u`+`k`+`r`")
  func issuedLinks() async throws {
    for (credential, expected) in [
      (PairingFixtures.credential(server: nil, iroh: iroh), "https://rarog.ai/pair#v=1&k=\(PairingFixtures.endpointId)&r=https%3A%2F%2Frelay.rarog.ai%2F&c=\(PairingFixtures.code)"),
      (PairingFixtures.credential(iroh: iroh), "https://rarog.ai/pair#v=1&u=https%3A%2F%2Frarog.example&k=\(PairingFixtures.endpointId)&r=https%3A%2F%2Frelay.rarog.ai%2F&c=\(PairingFixtures.code)"),
    ] {
      let (server, store, first) = await started(credential)
      defer { withExtendedLifetime(server) {} }
      store.issuePairingCode()
      await until("kod") { if case .issued = store.state.pairing.issue { true } else { false } }
      guard case let .issued(code) = store.state.pairing.issue else { continue }
      #expect(code.link.url.absoluteString == expected)
      #expect(code.link.target == PairingTarget(serverURL: credential.serverURL, iroh: credential.iroh))
      #expect(first.read { $0.issueCalls } == 1)
    }
  }

  // MARK: Para z sondy wersji

  @Test("sonda z nową parą przy otwartym ekranie „Serwer”: zapis w miejscu, trasy, kod i lista urządzeń zostają")
  func inPlaceKeepsServerScreen() async throws {
    let valve = ResponseValve()
    let reply = try version(iroh: (PairingFixtures.endpointId, PairingFixtures.relay))
    let me = PairingFixtures.device(id: "03030303030303030303030303030303", label: "iPhone·Rarog", current: true)
    let (server, store, first) = await started(PairingFixtures.credential()) { transport in
      transport.set {
        $0.version = reply
        $0.onVersion = { await valve.wait() }
        $0.deviceList = PairingFixtures.devices(#"{"devices":[\#(me)]}"#)
      }
    }
    await until("lista urządzeń") { store.state.pairing.devices?.count == 1 }
    store.issuePairingCode()
    await until("kod") { if case .issued = store.state.pairing.issue { true } else { false } }
    let issue = store.state.pairing.issue
    let devices = store.state.pairing.devices
    let deviceRefresh = first.read { $0.devicesCalls }

    valve.open()
    await until("para iroh w Keychainie") { self.saved(server)?.0.iroh == self.iroh }
    let (credential, pushKey) = try #require(saved(server))
    #expect(credential.account == "rarog.example" && pushKey == "BQUF", "to samo konto i ten sam klucz push")
    #expect(credential.deviceId == "03030303030303030303030303030303" && credential.secret == "sekret")
    #expect(server.routeChanges.map(\.credential?.iroh) == [iroh])
    #expect(store.serverEndpoint.credential?.iroh == iroh && server.current === first, "ten sam transport")
    #expect(store.state.pairing.paired?.iroh == iroh)
    #expect(store.state.pairing.issue == issue && store.state.pairing.devices == devices, "kod i lista na ekranie")
    #expect(first.read { $0.devicesCalls } == deviceRefresh)
  }

  @Test("zła para z sondy: pominięta, linia w client.log bez wartości, Keychain i trasy bez zmian")
  func badPairIgnored() async throws {
    let reply = try version(iroh: (String(PairingFixtures.endpointId.dropLast()), PairingFixtures.relay))
    let (server, store, first) = await started(PairingFixtures.credential()) { $0.set { $0.version = reply } }
    await until("linia o parze z sondy") { self.logs(first).contains { $0.contains("version probe") } }
    #expect(saved(server)?.0.iroh == nil && server.routeChanges.isEmpty)
    #expect(store.state.pairing.paired?.iroh == nil)
    #expect(!logs(first).contains { $0.contains(PairingFixtures.endpointId.prefix(16)) })
  }

  @Test("`iroh: null` przy adresie: para usunięta w miejscu; przy tylko-iroh zignorowana")
  func nullRemovesPairOnlyWithAddress() async throws {
    let reply = try version(iroh: nil)
    let (server, store, _) = await started(PairingFixtures.credential(iroh: iroh)) { $0.set { $0.version = reply } }
    await until("para usunięta") { self.saved(server)?.0.iroh == nil }
    #expect(saved(server)?.1 == "BQUF" && server.routeChanges.map(\.credential?.iroh) == [nil])
    #expect(store.state.pairing.paired?.iroh == nil && store.state.pairing.paired?.url == PairingFixtures.server)

    let onlyIroh = PairingFixtures.credential(server: nil, iroh: iroh)
    let (other, irohStore, _) = await started(onlyIroh) { $0.set { $0.version = reply } }
    await until("sonda zapisała system") { self.saved(other)?.0.serverSystem == .macos }
    #expect(saved(other)?.0.iroh == iroh && other.routeChanges.isEmpty && irohStore.state.pairing.paired?.iroh == iroh)
  }

  @Test("stare `null` z generacji sprzed zmiany drogi dochodzi po zapisie nowej pary: Keychain i trasy zostają nowe")
  func staleNullAfterNewPair() async throws {
    let valve = ResponseValve()
    let stale = try version(iroh: nil)
    let (server, store, first) = await started(PairingFixtures.credential(iroh: iroh)) { transport in
      transport.set {
        $0.routeStamp = 1
        $0.version = stale
        $0.onVersion = { await valve.wait() }
      }
    }
    await until("sonda starej drogi w drodze") { valve.entered >= 1 }
    // Nowa generacja i sonda po jej `hello` z nową parą.
    first.set { $0.routeStamp = 2 }
    let next = PairingFixtures.iroh(PairingFixtures.otherEndpointId)
    store.adoptServerIroh(ServerIroh(endpointId: next.endpointId, relay: next.relay.absoluteString), sent: store.versionProbeStamp())
    #expect(saved(server)?.0.iroh == next && server.routeChanges.map(\.credential?.iroh) == [next])

    valve.open()
    await until("stara sonda doszła") { self.saved(server)?.0.serverSystem == .macos }
    #expect(saved(server)?.0.iroh == next, "Keychain z nową parą")
    #expect(server.routeChanges.map(\.credential?.iroh) == [next], "trasy bez starego `null`")
    #expect(store.serverEndpoint.credential?.iroh == next && store.state.pairing.paired?.iroh == next)
  }

  @Test("pieczątka sondy: inna droga albo inna para przy wysłaniu → wynik pominięty; ta sama → zapis")
  func probeStampGuards() async throws {
    let (server, store, first) = await started(PairingFixtures.credential(iroh: iroh))
    let next = ServerIroh(endpointId: PairingFixtures.otherEndpointId, relay: PairingFixtures.relay)
    let before = store.versionProbeStamp()
    first.set { $0.routeStamp = 5 }
    store.adoptServerIroh(next, sent: before)
    #expect(saved(server)?.0.iroh == iroh && server.routeChanges.isEmpty, "inna droga")

    let otherPair = VersionProbeStamp(
      route: 5, deviceId: before.deviceId, iroh: PairingFixtures.iroh(relay: "https://euc1-1.relay.n0.iroh.link./"))
    store.adoptServerIroh(next, sent: otherPair)
    #expect(saved(server)?.0.iroh == iroh && server.routeChanges.isEmpty, "inna para przy wysłaniu")

    store.adoptServerIroh(next, sent: store.versionProbeStamp())
    #expect(saved(server)?.0.iroh == PairingFixtures.iroh(PairingFixtures.otherEndpointId) && server.routeChanges.count == 1)
  }

  @Test("zapis w miejscu: `saveFailure` → stary wpis, bez tras; `sharedFailure` → nowy wpis prywatny i trasy, linia")
  func inPlaceKeychainFailures() async throws {
    let (server, store, first) = await started(PairingFixtures.credential())
    let next = ServerIroh(endpointId: PairingFixtures.endpointId, relay: PairingFixtures.relay)
    server.keychain.update { $0.saveFailure = -25_308 }
    store.adoptServerIroh(next, sent: store.versionProbeStamp())
    #expect(saved(server)?.0.iroh == nil && server.routeChanges.isEmpty && store.serverEndpoint.credential?.iroh == nil)
    #expect(store.state.pairing.paired?.iroh == nil && server.current === first)
    await until("linia o odmowie zapisu") { self.logs(first).contains { $0.contains("iroh pair") && $0.contains("OSStatus") } }

    server.keychain.update {
      $0.saveFailure = nil
      $0.sharedFailure = true
    }
    store.adoptServerIroh(next, sent: store.versionProbeStamp())
    #expect(saved(server)?.0.iroh == iroh && server.routeChanges.count == 1 && store.state.pairing.paired?.iroh == iroh)
    await until("linia o grupie współdzielonej") {
      self.logs(first).contains { $0.contains("push key without the shared group") }
    }
  }

  @Test("tylko-iroh: inny EndpointId z sondy nie zmienia pary; ten sam EndpointId z innym relayem — zapis w miejscu")
  func otherEndpointIdIgnored() async throws {
    let (server, store, _) = await started(PairingFixtures.credential(server: nil, iroh: iroh))
    store.adoptServerIroh(
      ServerIroh(endpointId: PairingFixtures.otherEndpointId, relay: PairingFixtures.relay), sent: store.versionProbeStamp())
    #expect(saved(server)?.0.iroh == iroh && server.routeChanges.isEmpty)
    let moved = PairingFixtures.iroh(relay: "https://euc1-1.relay.n0.iroh.link./")
    store.adoptServerIroh(
      ServerIroh(endpointId: PairingFixtures.endpointId, relay: moved.relay.absoluteString), sent: store.versionProbeStamp())
    #expect(saved(server)?.0.iroh == moved && saved(server)?.0.account == "iroh:\(PairingFixtures.endpointId)")
    #expect(server.routeChanges.count == 1)
  }

  // MARK: Przestrzeń serwera tylko przez iroh, odpięcie i ponowne parowanie z dowodem klucza

  /// Przestrzeń `.iroh` ze złotym wskaźnikiem (albo podanym), kolejką (jeden wpis) i szkicami pola oraz notatki.
  private func seedIrohSpace(_ server: FakeServer, pointer: Data = GoldenPointers.iroh) async throws -> (ServerSpace, [URL]) {
    let space = try JSONDecoder().decode(ServerSpace.self, from: pointer)
    let directory = server.spaces.directory(space)
    try FileManager.default.createDirectory(at: server.spaces.root, withIntermediateDirectories: true)
    try pointer.write(to: server.spaces.pointerFile)
    try await OutboxPersistence(directory: directory.appending(path: ServerSpaces.outbox))
      .save(OutboxEntry(sessionId: "sesja-a", text: "z kolejki iroh", createdAt: Date(), state: .unconfirmed))
    var drafts: [URL] = []
    for folder in [ServerSpaces.drafts, ServerSpaces.noteDrafts] {
      let file = directory.appending(path: folder, directoryHint: .isDirectory).appending(path: "szkic.json")
      try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
      try Data(#"{"text":"szkic"}"#.utf8).write(to: file)
      drafts.append(file)
    }
    return (space, drafts)
  }

  /// Wpisy kosza z `servers/` (katalog roboczy procesu się nie liczy).
  private func trashed(_ server: FakeServer) -> [String] {
    ((try? FileManager.default.contentsOfDirectory(atPath: server.spaces.trash.path)) ?? []).filter { !$0.hasPrefix("scratch-") }
  }

  /// Magazyn tylko-iroh na przestrzeni `.iroh` z danymi.
  private func irohOnlyStore() async throws -> (FakeServer, RarogStore, ServerSpace, [URL]) {
    let credential = PairingFixtures.credential(server: nil, iroh: PairingFixtures.iroh(GoldenPointers.endpointId))
    let server = FakeServer(keychain: MemoryKeychain(.init(credential: credential, pushKey: "BQUF")))
    let (space, drafts) = try await seedIrohSpace(server)
    let store = server.store()
    await store.start()
    #expect(store.dataSpaceDirectory == server.spaces.directory(space) && store.state.outbox.count == 1)
    return (server, store, space, drafts)
  }

  @Test("przestrzeń serwera tylko przez iroh: parowanie `k`+`r` od zera → wskaźnik `iroh:<id>`, nazwa ze skrótu napisu")
  func irohSpaceName() async throws {
    let server = FakeServer()
    let store = server.store()
    await store.start()
    store.offerPairing(irohLink())
    #expect(await store.confirmPairing() == .paired)
    let pointer = try #require(server.pointer)
    #expect(pointer.identity == .iroh(endpointId: PairingFixtures.endpointId) && pointer.origin == nil)
    let digest = SHA256.hash(data: Data("iroh:\(PairingFixtures.endpointId)".utf8)).map { String(format: "%02x", $0) }.joined()
    #expect(pointer.name.hasPrefix("\(digest.prefix(16))-"))
    let json = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: server.spaces.pointerFile)) as? [String: Any])
    #expect(json["identity"] as? String == "iroh:\(PairingFixtures.endpointId)" && json["origin"] == nil)
  }

  @Test("nowy EndpointId tylko-iroh przy parowaniu: nowa przestrzeń, stara do kosza po zapisie wskaźnika")
  func newEndpointIdNewSpace() async throws {
    let (server, store, space, _) = try await irohOnlyStore()
    store.offerPairing(irohLink(iroh: PairingFixtures.iroh(PairingFixtures.otherEndpointId)))
    #expect(await store.confirmPairing(replacing: true) == .paired)
    let pointer = try #require(server.pointer)
    #expect(pointer.identity == .iroh(endpointId: PairingFixtures.otherEndpointId) && pointer.name != space.name)
    #expect(!server.spaceNames.contains(space.name) && store.state.outbox.isEmpty && server.wipes == 1)
    #expect(server.released.count == 1)
  }

  @Test("odpięcie serwera tylko przez iroh: ekran odpięcia ze skrótem EndpointId")
  func irohRevocationShortId() async throws {
    let (server, store, first) = await started(PairingFixtures.credential(server: nil, iroh: iroh))
    defer { withExtendedLifetime(server) {} }
    first.set {
      $0.rejection = .revoked(
        deviceId: "03030303030303030303030303030303", revokedAt: "2026-10-04T10:03:00.000Z", revokedBy: "admin")
    }
    first.end(.global, error: .unauthorized(APIFailure(status: 401, code: "device-revoked")))
    await until("ekran odpięcia") { store.state.auth == .loggedOut(.deviceRevoked) }
    #expect(store.state.pairing.revoked?.server == "iroh · 523c7996")
  }

  @Test("dowód klucza: tylko-iroh, link `u`+`k`+`r` z tym samym serverId i `k`: ta sama przestrzeń, kolejka i szkice, kosz pusty")
  func sameKeyKeepsSpace() async throws {
    let (server, store, space, drafts) = try await irohOnlyStore()
    server.pairing.set {
      $0.pairResult = .success(PairingFixtures.response(deviceId: "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a", iroh: nil))
    }
    store.offerPairing(irohLink(server: PairingFixtures.server, iroh: PairingFixtures.iroh(GoldenPointers.endpointId)))
    #expect(await store.confirmPairing() == .paired)
    let pointer = try #require(server.pointer)
    #expect(pointer.name == space.name && pointer.identity == .origin(GoldenPointers.rarog), "wskaźnik z nową tożsamością")
    #expect(store.dataSpaceDirectory == server.spaces.directory(space) && store.state.outbox.map(\.text) == ["z kolejki iroh"])
    for file in drafts { #expect(FileManager.default.fileExists(atPath: file.path), "\(file.lastPathComponent)") }
    #expect(trashed(server).isEmpty && server.wipes == 0, "kosz pusty")
    #expect(server.released.count == 1, "release poprzedniego punktu końcowego raz")

    // Restart: nowe poświadczenie z adresem wchodzi w tę samą przestrzeń.
    let restarted = server.store()
    await restarted.start()
    #expect(restarted.dataSpaceDirectory == server.spaces.directory(space))
  }

  @Test("bez dowodu klucza: samo `u` albo inny serverId → nowa przestrzeń, stara do kosza")
  func withoutProofNewSpace() async throws {
    for (link, serverId) in [
      (PairingFixtures.link(), "01010101010101010101010101010101"),
      (irohLink(server: PairingFixtures.server, iroh: PairingFixtures.iroh(GoldenPointers.endpointId)), "inny-serwer"),
    ] {
      let (server, store, space, _) = try await irohOnlyStore()
      server.pairing.set {
        $0.pairResult = .success(PairingFixtures.response(deviceId: "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a", serverId: serverId, iroh: nil))
      }
      store.offerPairing(link)
      #expect(await store.confirmPairing(replacing: link.iroh == nil) == .paired)
      let pointer = try #require(server.pointer)
      #expect(pointer.name != space.name && !server.spaceNames.contains(space.name), "\(link.target)")
      #expect(store.state.outbox.isEmpty && server.wipes == 1 && server.released.count == 1)
    }
  }

  // MARK: Przejście z dowodem klucza przerwane w połowie: wskaźnik z następcą

  /// Wskaźnik z dysku jako słownik JSON (pole `successor` widać bez dekodera).
  private func pointerJSON(_ data: Data) throws -> [String: Any] {
    try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
  }

  private func pointerJSON(_ server: FakeServer) throws -> [String: Any] {
    try pointerJSON(Data(contentsOf: server.spaces.pointerFile))
  }

  /// Napis tożsamości serwera z adresu `PairingFixtures.server` (nowy klucz po przejściu z dowodem).
  private static let addressIdentity = "https://rarog.example:443"
  private static let irohIdentity = "iroh:\(GoldenPointers.endpointId)"

  /// Wskaźnik złotej przestrzeni `.iroh` w połowie przejścia na klucz z adresem.
  private static let successorPointer = Data(
    #"{"name":"5f1d0c2e7a9b3c41-1a2b3c4d","identity":"\#(irohIdentity)","successor":"\#(addressIdentity)"}"#.utf8)

  /// Magazyn tylko-iroh z danymi i arkusz przejścia z dowodem klucza: link `u`+`k`+`r` z tym samym `k`, odpowiedź z tym samym serverId.
  private func keyProofSheetOffered() async throws -> (FakeServer, RarogStore, ServerSpace, [URL]) {
    let (server, store, space, drafts) = try await irohOnlyStore()
    server.pairing.set {
      $0.pairResult = .success(PairingFixtures.response(deviceId: "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a", iroh: nil))
    }
    store.offerPairing(irohLink(server: PairingFixtures.server, iroh: PairingFixtures.iroh(GoldenPointers.endpointId)))
    return (server, store, space, drafts)
  }

  /// Ta sama przestrzeń z kolejką i szkicami, nic z `servers/` w koszu.
  private func expectSameSpace(
    _ store: RarogStore, _ server: FakeServer, _ space: ServerSpace, _ drafts: [URL],
    sourceLocation: SourceLocation = #_sourceLocation
  ) {
    #expect(store.dataSpaceDirectory == server.spaces.directory(space), sourceLocation: sourceLocation)
    #expect(store.state.outbox.map(\.text) == ["z kolejki iroh"], sourceLocation: sourceLocation)
    for file in drafts {
      #expect(FileManager.default.fileExists(atPath: file.path), "\(file.lastPathComponent)", sourceLocation: sourceLocation)
    }
    #expect(trashed(server).isEmpty, "kosz pusty", sourceLocation: sourceLocation)
  }

  @Test("przejście z dowodem klucza przerwane: proces zabity po zapisie Keychaina, przed ostatnim wskaźnikiem → ta sama przestrzeń po restarcie")
  func killedAfterKeychainSave() async throws {
    let (server, store, space, drafts) = try await keyProofSheetOffered()
    let file = server.spaces.pointerFile
    let left = PointerSnapshot()
    server.keychainProbe.afterNextSave { left.take(file) }
    #expect(await store.confirmPairing() == .paired)
    let bytes = try #require(left.data)
    let announced = try pointerJSON(bytes)
    #expect(announced["identity"] as? String == Self.irohIdentity, "wskaźnik przed zapisem klucza: stara tożsamość")
    #expect(announced["successor"] as? String == Self.addressIdentity, "i następca, zanim Keychain dostał nowy klucz")
    // Proces ginie tutaj: na dysku wskaźnik z tej chwili, w Keychainie nowy klucz z adresem.
    try bytes.write(to: file)
    let restarted = server.store()
    await restarted.start()
    expectSameSpace(restarted, server, space, drafts)
    let pointer = try pointerJSON(server)
    #expect(pointer["identity"] as? String == Self.addressIdentity && pointer["name"] as? String == space.name)
    #expect(pointer["successor"] == nil, "wybór przestrzeni kończy przejście")
  }

  @Test("dowód klucza: dysk odmawia wskaźnika z następcą → parowanie bez przejścia, nowa przestrzeń; stara do kosza po zapisie nowej")
  func firstPointerRefused() async throws {
    let (server, store, space, _) = try await keyProofSheetOffered()
    // Wskaźnik ze starą tożsamością to zapowiedź następcy: ten zapis dysk odrzuca, każdy inny przyjmuje.
    server.pointerDisk.refuse { $0.identity == .iroh(endpointId: GoldenPointers.endpointId) }
    #expect(await store.confirmPairing() == .paired)
    let pointer = try #require(server.pointer)
    #expect(pointer.name != space.name && pointer.identity == .origin(GoldenPointers.rarog), "nowa przestrzeń")
    #expect(store.state.outbox.isEmpty && server.wipes == 1 && !server.spaceNames.contains(space.name))
    let writes = server.pointerDisk.writes
    #expect(writes.contains { !$0.saved }, "odmowa zapisu zapowiedzi")
    let fresh = try #require(writes.first { $0.saved && $0.space?.name == pointer.name })
    #expect(fresh.spaceNames.contains(space.name), "stara przestrzeń w servers/ do chwili zapisu nowego wskaźnika")
    #expect(try #require(saved(server)).0.deviceId == "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a", "klucz zapisany")
  }

  @Test("dysk odmawia ostatniego wskaźnika → ta sama przestrzeń w sesji i po restarcie, start kończy przejście")
  func lastPointerRefused() async throws {
    let (server, store, space, drafts) = try await keyProofSheetOffered()
    server.pointerDisk.refuse { $0.identity == .origin(GoldenPointers.rarog) }
    #expect(await store.confirmPairing() == .paired)
    expectSameSpace(store, server, space, drafts)
    #expect(server.wipes == 0)
    let left = try pointerJSON(server)
    #expect(left["identity"] as? String == Self.irohIdentity && left["successor"] as? String == Self.addressIdentity)
    server.pointerDisk.refuse(nil)
    let restarted = server.store()
    await restarted.start()
    expectSameSpace(restarted, server, space, drafts)
    let pointer = try pointerJSON(server)
    #expect(pointer["identity"] as? String == Self.addressIdentity && pointer["name"] as? String == space.name)
    #expect(pointer["successor"] == nil)
  }

  @Test("dowód klucza: dysk odmawia każdego wskaźnika → sesja bez danych na dysku, stara przestrzeń zostaje; restart bez przejścia")
  func everyPointerRefused() async throws {
    let (server, store, space, _) = try await keyProofSheetOffered()
    server.pointerDisk.refuse { _ in true }
    #expect(await store.confirmPairing() == .paired)
    #expect(store.dataSpaceDirectory == nil && store.state.outbox.isEmpty && server.wipes == 1)
    #expect(server.spaceNames == [space.name] && trashed(server).isEmpty, "nic do kosza bez nowego wskaźnika")
    #expect(try Data(contentsOf: server.spaces.pointerFile) == GoldenPointers.iroh, "dysk dalej wskazuje starą")
    server.pointerDisk.refuse(nil)
    let restarted = server.store()
    await restarted.start()
    let pointer = try #require(server.pointer)
    #expect(pointer.name != space.name && !server.spaceNames.contains(space.name) && restarted.state.outbox.isEmpty)
  }

  @Test("Keychain odmawia zapisu klucza → wskaźnik bez następcy, stary klucz w tej samej przestrzeni")
  func keychainRefusedWithdrawsSuccessor() async throws {
    let (server, store, space, drafts) = try await keyProofSheetOffered()
    server.keychain.update { $0.saveFailure = -25_308 }
    #expect(await store.confirmPairing() == .failed(.keychain(-25_308)))
    expectSameSpace(store, server, space, drafts)
    let pointer = try pointerJSON(server)
    #expect(pointer["identity"] as? String == Self.irohIdentity && pointer["successor"] == nil)
    #expect(pointer["name"] as? String == space.name)
  }

  @Test("wskaźnik z następcą i stary klucz (proces zabity przed zapisem klucza): ta sama przestrzeń, następca skreślony")
  func successorPointerWithOldKey() async throws {
    let credential = PairingFixtures.credential(server: nil, iroh: PairingFixtures.iroh(GoldenPointers.endpointId))
    let server = FakeServer(keychain: MemoryKeychain(.init(credential: credential, pushKey: "BQUF")))
    let (space, drafts) = try await seedIrohSpace(server, pointer: Self.successorPointer)
    let store = server.store()
    await store.start()
    expectSameSpace(store, server, space, drafts)
    let pointer = try pointerJSON(server)
    #expect(pointer["identity"] as? String == Self.irohIdentity && pointer["name"] as? String == space.name)
    #expect(pointer["successor"] == nil, "klucz nie przeszedł, więc następca nie dostaje przestrzeni")
  }

  @Test("wskaźnik z następcą i klucz innego serwera (adres, inny EndpointId): nowa przestrzeń, stara do kosza")
  func successorPointerOtherServer() async throws {
    for credential in [
      PairingFixtures.credential(server: URL(string: "https://b.example")!),
      PairingFixtures.credential(server: nil, iroh: PairingFixtures.iroh(PairingFixtures.otherEndpointId)),
    ] {
      let server = FakeServer(keychain: MemoryKeychain(.init(credential: credential, pushKey: "BQUF")))
      let (space, _) = try await seedIrohSpace(server, pointer: Self.successorPointer)
      let store = server.store()
      await store.start()
      let pointer = try #require(server.pointer)
      #expect(pointer.name != space.name && !server.spaceNames.contains(space.name), "\(credential.account)")
      #expect(store.state.outbox.isEmpty && pointer.identity == ServerIdentity(credential), "\(credential.account)")
      #expect(try pointerJSON(server)["successor"] == nil, "\(credential.account)")
    }
  }

  // MARK: Następca tylko dla klucza z dowodem

  /// Arkusz ponownego parowania po przejściu, którego ostatni wskaźnik dysk odrzucił: Keychain trzyma klucz z adresem (urządzenie
  /// `0a0a…`), a wskaźnik na dysku i w pamięci to `{identity: iroh:k, successor: adres}`.
  private func lastPointerLeftAfterTransition() async throws -> (FakeServer, RarogStore, ServerSpace, [URL]) {
    let (server, store, space, drafts) = try await keyProofSheetOffered()
    server.pointerDisk.refuse { $0.identity == .origin(GoldenPointers.rarog) }
    #expect(await store.confirmPairing() == .paired)
    let left = try pointerJSON(server)
    #expect(left["identity"] as? String == Self.irohIdentity && left["successor"] as? String == Self.addressIdentity)
    #expect(try #require(saved(server)).0.deviceId == "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a")
    return (server, store, space, drafts)
  }

  @Test("ostatni wskaźnik odrzucony, ponowne parowanie przez to samo `k` z odmową Keychaina → ta sama przestrzeń po restarcie")
  func keychainRefusedAfterLastPointerRefused() async throws {
    // (adres w linku, dysk dalej odmawia wskaźnika z adresem `rarog.example`, wynik). Inny adres przy wiszącym
    // następcy kończy się odmową, zanim parowanie dojdzie do Keychaina.
    for (address, refusing, outcome) in [
      (PairingFixtures.server, false, .failed(.keychain(-25_308))),
      (PairingFixtures.server, true, .failed(.keychain(-25_308))),
      (URL(string: "https://b.example")!, true, .failed(.failed(nil))),
    ] as [(URL, Bool, PairingOutcome)] {
      let (server, store, space, drafts) = try await lastPointerLeftAfterTransition()
      if !refusing { server.pointerDisk.refuse(nil) }
      server.keychain.update { $0.saveFailure = -25_308 }
      server.pairing.set {
        $0.pairResult = .success(PairingFixtures.response(deviceId: "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b", iroh: nil))
      }
      store.offerPairing(irohLink(server: address, iroh: PairingFixtures.iroh(GoldenPointers.endpointId)))
      #expect(await store.confirmPairing() == outcome, "\(address) \(refusing)")
      #expect(try #require(saved(server)).0.deviceId == "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a", "klucz z adresem w Keychainie")
      expectSameSpace(store, server, space, drafts)
      let pointer = try pointerJSON(server)
      if refusing {
        // Dysk nie dał skończyć przejścia: wskaźnik dokładnie sprzed zapowiedzi, z następcą, którego klucz trzyma Keychain.
        #expect(pointer["identity"] as? String == Self.irohIdentity, "\(address)")
        #expect(pointer["successor"] as? String == Self.addressIdentity, "\(address)")
      } else {
        #expect(pointer["identity"] as? String == Self.addressIdentity && pointer["successor"] == nil, "przejście skończone")
      }
      #expect(pointer["name"] as? String == space.name)

      server.pointerDisk.refuse(nil)
      server.keychain.update { $0.saveFailure = nil }
      let restarted = server.store()
      await restarted.start()
      expectSameSpace(restarted, server, space, drafts)
      #expect(server.wipes == 0, "\(address) \(refusing)")
    }
  }

  @Test("start parowania przy wskaźniku z następcą i kluczu następcy → wskaźnik z nową tożsamością przed zapowiedzią")
  func pairingSettlesPointerFirst() async throws {
    let (server, store, space, drafts) = try await lastPointerLeftAfterTransition()
    server.pointerDisk.refuse(nil)
    let mark = server.pointerDisk.writes.count
    server.pairing.set {
      $0.pairResult = .success(PairingFixtures.response(deviceId: "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b", iroh: nil))
    }
    store.offerPairing(irohLink(server: PairingFixtures.server, iroh: PairingFixtures.iroh(GoldenPointers.endpointId)))
    #expect(await store.confirmPairing() == .paired)
    let writes = Array(server.pointerDisk.writes.dropFirst(mark))
    let first = try #require(writes.first?.space)
    #expect(first == ServerSpace(identity: .origin(GoldenPointers.rarog), name: space.name), "pierwszy zapis parowania")
    #expect(!writes.contains { $0.space?.successor != nil }, "bez nowej zapowiedzi")
    expectSameSpace(store, server, space, drafts)
    #expect(server.wipes == 0)
    #expect(try #require(saved(server)).0.deviceId == "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b")
  }

  @Test("zapowiedź nie cofnięta (dysk odmówił), parowanie linkiem z samym `u` z innym serverId: odmowa albo nowa przestrzeń")
  func unprovenPairingWithLeftoverSuccessor() async throws {
    for refusing in [true, false] {
      let (server, store, space, drafts) = try await keyProofSheetOffered()
      // Keychain odmawia nowego klucza, a dysk — cofnięcia zapowiedzi.
      server.pointerDisk.refuse { $0.identity == .iroh(endpointId: GoldenPointers.endpointId) && $0.successor == nil }
      server.keychain.update { $0.saveFailure = -25_308 }
      #expect(await store.confirmPairing() == .failed(.keychain(-25_308)))
      let left = try pointerJSON(server)
      #expect(left["identity"] as? String == Self.irohIdentity && left["successor"] as? String == Self.addressIdentity)

      server.keychain.update { $0.saveFailure = nil }
      if !refusing { server.pointerDisk.refuse(nil) }
      server.pairing.set {
        $0.pairResult = .success(
          PairingFixtures.response(deviceId: "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b", serverId: "inny-serwer", iroh: nil))
      }
      let before = try Data(contentsOf: server.spaces.pointerFile)
      let keychain = server.keychain.load()
      store.offerPairing(PairingFixtures.link())
      let outcome = await store.confirmPairing(replacing: true)
      if refusing {
        #expect(outcome == .failed(.failed(nil)), "parowanie bez dowodu przy następcy we wskaźniku")
        #expect(server.keychain.load() == keychain, "Keychain bez zmian")
        #expect(try Data(contentsOf: server.spaces.pointerFile) == before, "wskaźnik bez zmian")
        expectSameSpace(store, server, space, drafts)
        #expect(server.released.isEmpty && server.wipes == 0)
        // A refused pairing's line waits under its offer: it is about the link's server, not the logged-in one.
        #expect(logged(store, server).contains { $0.contains("pairing without proof") })
      } else {
        #expect(outcome == .paired)
        let pointer = try #require(server.pointer)
        #expect(pointer.identity == .origin(GoldenPointers.rarog) && pointer.successor == nil && pointer.name != space.name)
        #expect(store.state.outbox.isEmpty && server.wipes == 1 && !server.spaceNames.contains(space.name))
        let fresh = try #require(server.pointerDisk.writes.first { $0.saved && $0.space?.name == pointer.name })
        #expect(fresh.spaceNames.contains(space.name), "stara przestrzeń w servers/ do chwili zapisu nowego wskaźnika")
        #expect(try #require(saved(server)).0.deviceId == "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b")
      }
    }
  }

  // MARK: Wiszący następca nie ustępuje innej tożsamości

  /// Wskaźnik dopuszcza klucz z tą tożsamością (`identity` albo `successor`).
  private func admits(_ space: ServerSpace?, _ identity: ServerIdentity?) -> Bool {
    guard let space, let identity else { return false }
    return space.identity == identity || space.successor == identity
  }

  /// Proces zabity w dowolnej chwili parowania: wskaźnik na dysku dopuszcza każdy klucz, który Keychain wtedy może
  /// trzymać — przed zapisem klucza poprzedni, w trakcie zapisu oba (wpis nowego konta powstaje przed skasowaniem
  /// innych), po nim nowy. `start` = wskaźnik na dysku i liczba zapisów wskaźnika przed parowaniem; `new == nil` =
  /// parowanie do nowej przestrzeni (nowy klucz nie potrzebuje tego wskaźnika, sprawdzany jest tylko poprzedni).
  private func expectPointerAdmitsKeychain(
    _ server: FakeServer, start: (pointer: ServerSpace?, writes: Int), moment: KeySaveMoment,
    old: ServerIdentity, new: ServerIdentity?, sourceLocation: SourceLocation = #_sourceLocation
  ) {
    let accepted = server.pointerDisk.writes.enumerated().dropFirst(start.writes).filter(\.element.saved)
    let states = [(index: -1, space: start.pointer)] + accepted.map { (index: $0.offset, space: $0.element.space) }
    let saved = moment.writes ?? .max
    for (position, state) in states.enumerated() {
      let next = position + 1 < states.count ? states[position + 1].index : .max
      let label = state.space.map { "\($0.identity) → \(String(describing: $0.successor))" } ?? "brak"
      if state.index < saved {
        #expect(admits(state.space, old), "poprzedni klucz, wskaźnik \(label)", sourceLocation: sourceLocation)
      }
      if let new, moment.writes != nil, next >= saved {
        #expect(admits(state.space, new), "nowy klucz, wskaźnik \(label)", sourceLocation: sourceLocation)
      }
    }
  }

  /// Żaden zapis wskaźnika od `start` nie niesie następcy innego niż następca wskaźnika na początku parowania.
  private func expectSuccessorKept(
    _ server: FakeServer, start: (pointer: ServerSpace?, writes: Int), sourceLocation: SourceLocation = #_sourceLocation
  ) {
    let replaced = server.pointerDisk.writes.dropFirst(start.writes).compactMap(\.space?.successor)
      .filter { $0 != start.pointer?.successor }
    #expect(replaced.isEmpty, "zapowiedź nie zamienia następcy: \(replaced)", sourceLocation: sourceLocation)
  }

  @Test("wiszący następca, parowanie z dowodem przez `k` pod innym adresem: odmowa, Keychain i wskaźnik bez zmian, po restarcie ta sama przestrzeń; dysk, który przyjmuje uzgodnienie → nowa przestrzeń jak dotąd")
  func hangingSuccessorRefusesOtherIdentity() async throws {
    for refusing in [true, false] {
      // Keychain trzyma klucz `rarog.example`, wskaźnik `{identity: iroh:k, successor: rarog.example}`.
      let (server, store, space, drafts) = try await lastPointerLeftAfterTransition()
      if !refusing { server.pointerDisk.refuse(nil) }
      server.pairing.set {
        $0.pairResult = .success(PairingFixtures.response(deviceId: "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b", iroh: nil))
      }
      let other = try #require(URL(string: "https://b.example"))
      let file = server.spaces.pointerFile
      let before = try Data(contentsOf: file)
      let keychain = server.keychain.snapshot
      let released = server.released.count
      let start = (pointer: server.pointer, writes: server.pointerDisk.writes.count)
      let moment = KeySaveMoment()
      let disk = server.pointerDisk
      server.keychainProbe.afterNextSave { moment.take(file, disk) }
      store.offerPairing(irohLink(server: other, iroh: PairingFixtures.iroh(GoldenPointers.endpointId)))
      let outcome = await store.confirmPairing()
      expectPointerAdmitsKeychain(server, start: start, moment: moment, old: .origin(GoldenPointers.rarog), new: nil)
      expectSuccessorKept(server, start: start)
      guard refusing else {
        // Uzgodnienie przeszło (wskaźnik `{identity: rarog.example}`), więc parowanie z innym adresem to inny serwer.
        #expect(outcome == .paired)
        let pointer = try #require(server.pointer)
        #expect(pointer.identity == ServerOrigin(other).map { ServerIdentity.origin($0) } && pointer.name != space.name)
        let fresh = try #require(server.pointerDisk.writes.first { $0.saved && $0.space?.name == pointer.name })
        #expect(fresh.spaceNames.contains(space.name), "stara przestrzeń w servers/ do chwili zapisu nowego wskaźnika")
        #expect(try #require(saved(server)).0.deviceId == "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b")
        continue
      }
      #expect(outcome == .failed(.failed(nil)), "parowanie pod inną tożsamością przy wiszącym następcy")
      #expect(server.keychain.snapshot == keychain, "Keychain bez zmian")
      #expect(try Data(contentsOf: file) == before, "wskaźnik bez zmian")
      expectSameSpace(store, server, space, drafts)
      #expect(server.released.count == released && server.wipes == 0)
      // A refused pairing's line waits under its offer: it is about the link's server, not the logged-in one.
      #expect(logged(store, server).contains { $0.contains("pairing under another server identity") })

      // Proces zabity tuż przed zapisem klucza (gdyby parowanie doszło do Keychaina): na dysku wskaźnik z tej chwili,
      // w Keychainie poprzedni klucz. Nowy magazyn na tym samym katalogu, dysk znowu przyjmuje zapisy.
      try (moment.pointer ?? before).write(to: file)
      server.keychain.update { $0 = keychain }
      server.pointerDisk.refuse(nil)
      let restarted = server.store()
      await restarted.start()
      expectSameSpace(restarted, server, space, drafts)
      #expect(server.wipes == 0)
      #expect(try #require(saved(server)).0.deviceId == "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a")
    }
  }

  @Test("wiszący następca, parowanie z dowodem do tożsamości `identity` (`k`+`r`) albo `successor` (adres następcy): ta sama przestrzeń")
  func hangingSuccessorKeepsOwnIdentities() async throws {
    let link = irohLink(iroh: PairingFixtures.iroh(GoldenPointers.endpointId))
    let successorLink = irohLink(server: PairingFixtures.server, iroh: PairingFixtures.iroh(GoldenPointers.endpointId))
    for (link, identity) in [
      (link, ServerIdentity.iroh(endpointId: GoldenPointers.endpointId)), (successorLink, .origin(GoldenPointers.rarog)),
    ] {
      // Dysk dalej odmawia uzgodnienia (wskaźnika z adresem `rarog.example`).
      let (server, store, space, drafts) = try await lastPointerLeftAfterTransition()
      server.pairing.set {
        $0.pairResult = .success(PairingFixtures.response(deviceId: "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b", iroh: nil))
      }
      let start = (pointer: server.pointer, writes: server.pointerDisk.writes.count)
      let moment = KeySaveMoment()
      let (file, disk) = (server.spaces.pointerFile, server.pointerDisk)
      server.keychainProbe.afterNextSave { moment.take(file, disk) }
      store.offerPairing(link)
      #expect(await store.confirmPairing() == .paired, "\(identity)")
      expectSameSpace(store, server, space, drafts)
      #expect(server.wipes == 0, "\(identity)")
      let (credential, _) = try #require(saved(server))
      #expect(credential.deviceId == "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b" && ServerIdentity(credential) == identity)
      expectPointerAdmitsKeychain(server, start: start, moment: moment, old: .origin(GoldenPointers.rarog), new: identity)
      expectSuccessorKept(server, start: start)
      #expect(admits(server.pointer, identity), "\(identity)")

      server.pointerDisk.refuse(nil)
      let restarted = server.store()
      await restarted.start()
      expectSameSpace(restarted, server, space, drafts)
      #expect(server.wipes == 0, "\(identity)")
    }
  }

  // MARK: Wiszący następca bez klucza urządzenia

  /// Link `k`+`r` do złotego EndpointId (tożsamość `identity` wskaźnika).
  private var pointerKeyLink: PairingLink { irohLink(iroh: PairingFixtures.iroh(GoldenPointers.endpointId)) }

  /// Linie `client.log`: wysłane i czekające na zalogowanie (magazyn bez klucza nie wysyła).
  private func logged(_ store: RarogStore, _ server: FakeServer) -> [String] {
    allLogs(server) + store.reporter.pending
  }

  /// Odpięcie przy wiszącym następcy: ostatni wskaźnik przejścia z dowodem klucza odrzucony (`{identity: iroh:k, successor:
  /// rarog.example}`), potem `device-revoked` klucza `rarog.example`. Keychain pusty, sesja bez klucza, wskaźnik
  /// z następcą na dysku i w pamięci; dysk znowu przyjmuje zapisy. Odpowiedź parowania: urządzenie `0b0b…`.
  private func revokedWithHangingSuccessor() async throws -> (FakeServer, RarogStore, ServerSpace, [URL]) {
    let (server, store, space, drafts) = try await lastPointerLeftAfterTransition()
    // Transport klucza z adresem (ostatni zbudowany to jednorazowy transport odpięcia poprzedniego klucza).
    let current = try #require(
      server.built.last { $0.endpoint.credential?.deviceId == "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a" }?.transport)
    await until("strumień globalny klucza z adresem") { !current.streamCalls.isEmpty }
    current.set {
      $0.rejection = .revoked(
        deviceId: "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a", revokedAt: "2026-10-04T10:03:00.000Z", revokedBy: "admin")
    }
    current.end(.global, error: .unauthorized(APIFailure(status: 401, code: "device-revoked")))
    await until("ekran odpięcia") { store.state.auth == .loggedOut(.deviceRevoked) }
    #expect(server.keychain.load() == .none && store.serverEndpoint.credential == nil, "Keychain pusty")
    let left = try pointerJSON(server)
    #expect(left["identity"] as? String == Self.irohIdentity && left["successor"] as? String == Self.addressIdentity)
    expectSameSpace(store, server, space, drafts)
    server.pointerDisk.refuse(nil)
    server.pairing.set {
      $0.pairResult = .success(PairingFixtures.response(deviceId: "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b", iroh: nil))
    }
    return (server, store, space, drafts)
  }

  @Test("wiszący następca po odpięciu, Keychain na pewno pusty: następca skreślony przed parowaniem; samo `u` do następcy → nowa przestrzeń, stara do kosza po zapisie wskaźnika; `k`+`r` → ta sama przestrzeń")
  func hangingSuccessorWithoutKeyPairs() async throws {
    for (link, same) in [(PairingFixtures.link(), false), (pointerKeyLink, true)] {
      let (server, store, space, drafts) = try await revokedWithHangingSuccessor()
      let mark = server.pointerDisk.writes.count
      store.offerPairing(link)
      #expect(await store.confirmPairing() == .paired, "\(link.target)")
      let writes = server.pointerDisk.writes.dropFirst(mark)
      let settled = ServerSpace(identity: .iroh(endpointId: GoldenPointers.endpointId), name: space.name)
      #expect(writes.first?.space == settled && writes.first?.saved == true, "najpierw wskaźnik bez następcy")
      #expect(!writes.contains { $0.space?.successor != nil }, "bez nowej zapowiedzi")
      #expect(try #require(saved(server)).0.deviceId == "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b", "\(link.target)")
      let pointer = try #require(server.pointer)
      #expect(pointer.successor == nil, "\(link.target)")
      if same {
        #expect(pointer == settled)
        expectSameSpace(store, server, space, drafts)
        #expect(server.wipes == 0)
      } else {
        #expect(pointer.identity == .origin(GoldenPointers.rarog) && pointer.name != space.name, "nowa przestrzeń")
        #expect(store.state.outbox.isEmpty && server.wipes == 1 && !server.spaceNames.contains(space.name))
        let fresh = try #require(server.pointerDisk.writes.first { $0.saved && $0.space?.name == pointer.name })
        #expect(fresh.spaceNames.contains(space.name), "stara przestrzeń w servers/ do chwili zapisu nowego wskaźnika")
      }

      // Restart: ta sama przestrzeń co w sesji.
      let restarted = server.store()
      await restarted.start()
      #expect(restarted.dataSpaceDirectory == store.dataSpaceDirectory, "\(link.target)")
      if same { expectSameSpace(restarted, server, space, drafts) }
    }
  }

  @Test("wiszący następca po odpięciu, Keychain zablokowany albo nieczytelny: odmowa, wskaźnik i Keychain bez zmian, linia z powodem")
  func hangingSuccessorWithoutKeyKeychainInDoubt() async throws {
    let cases: [(String, @MainActor (FakeServer, RarogStore) -> Void)] = [
      ("the Keychain is locked", { server, _ in server.keychain.update { $0.locked = true } }),
      ("OSStatus -25300", { server, store in
        store.serverRuntime.connector?.keychain = ReadOverrideKeychain(server.keychainProbe, read: .failed(-25_300))
      }),
    ]
    for (reason, prepare) in cases {
      let (server, store, space, drafts) = try await revokedWithHangingSuccessor()
      prepare(server, store)
      let before = try Data(contentsOf: server.spaces.pointerFile)
      let keychain = server.keychain.snapshot
      let (mark, released) = (server.pointerDisk.writes.count, server.released.count)
      for link in [PairingFixtures.link(), pointerKeyLink] {
        store.offerPairing(link)
        #expect(await store.confirmPairing() == .failed(.failed(nil)), "\(reason) \(link.target)")
      }
      #expect(server.pointerDisk.writes.count == mark, "\(reason): nic nie pisze wskaźnika")
      #expect(try Data(contentsOf: server.spaces.pointerFile) == before, "\(reason): wskaźnik bez zmian")
      #expect(server.keychain.snapshot == keychain, "\(reason): Keychain bez zmian")
      expectSameSpace(store, server, space, drafts)
      #expect(server.released.count == released && server.wipes == 0, "\(reason)")
      let lines = logged(store, server)
      #expect(lines.contains { $0.contains("successor kept") && $0.contains(reason) }, "\(reason): \(lines)")
      #expect(lines.contains { $0.contains("pairing without proof") }, "\(reason)")
    }
  }

  @Test("wiszący następca po odpięciu, Keychain pusty, dysk odmawia skreślenia: odmowa, wskaźnik bez zmian; dysk znowu przyjmuje → `k`+`r` w tej samej przestrzeni")
  func hangingSuccessorWithoutKeyDiskRefuses() async throws {
    let (server, store, space, drafts) = try await revokedWithHangingSuccessor()
    server.pointerDisk.refuse { _ in true }
    let before = try Data(contentsOf: server.spaces.pointerFile)
    let mark = server.pointerDisk.writes.count
    store.offerPairing(pointerKeyLink)
    #expect(await store.confirmPairing() == .failed(.failed(nil)))
    let refused = server.pointerDisk.writes.dropFirst(mark)
    #expect(refused.map(\.saved) == [false] && refused.first?.space?.successor == nil, "jedna próba skreślenia")
    #expect(try Data(contentsOf: server.spaces.pointerFile) == before, "wskaźnik bez zmian")
    #expect(server.keychain.load() == .none, "Keychain bez klucza")
    expectSameSpace(store, server, space, drafts)
    #expect(server.wipes == 0)
    let lines = logged(store, server)
    #expect(lines.contains { $0.contains("pointer without the successor identity not saved") }, "\(lines)")

    server.pointerDisk.refuse(nil)
    store.offerPairing(pointerKeyLink)
    #expect(await store.confirmPairing() == .paired)
    #expect(server.pointer == ServerSpace(identity: .iroh(endpointId: GoldenPointers.endpointId), name: space.name))
    expectSameSpace(store, server, space, drafts)
    #expect(server.wipes == 0)
  }

  @Test("wiszący następca po odpięciu, Keychain z kluczem, którego sesja nie używa: odmowa, wskaźnik i Keychain bez zmian, linia z powodem")
  func hangingSuccessorWithoutKeyKeychainFound() async throws {
    let (server, store, space, drafts) = try await revokedWithHangingSuccessor()
    let stray = PairingFixtures.credential(deviceId: "0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c")
    store.serverRuntime.connector?.keychain = ReadOverrideKeychain(server.keychainProbe, read: .found(stray, pushKey: "BQUF"))
    let before = try Data(contentsOf: server.spaces.pointerFile)
    let keychain = server.keychain.snapshot
    let (mark, released) = (server.pointerDisk.writes.count, server.released.count)
    for link in [PairingFixtures.link(), pointerKeyLink] {
      store.offerPairing(link)
      #expect(await store.confirmPairing() == .failed(.failed(nil)), "\(link.target)")
    }
    #expect(server.pointerDisk.writes.count == mark, "nic nie pisze wskaźnika")
    #expect(try Data(contentsOf: server.spaces.pointerFile) == before, "wskaźnik bez zmian")
    #expect(server.keychain.snapshot == keychain, "Keychain bez zmian")
    expectSameSpace(store, server, space, drafts)
    #expect(server.released.count == released && server.wipes == 0)
    let lines = logged(store, server)
    #expect(lines.contains { $0.contains("successor kept") && $0.contains("does not use") }, "\(lines)")
    #expect(lines.contains { $0.contains("pairing without proof") }, "\(lines)")
  }

  @Test("odpięcie w trakcie wstrzymanego `pair`: wskaźnik uzgodniony według stanu po wznowieniu (Keychain pusty skreśla następcę), samo `u` → nowa przestrzeń")
  func revocationDuringSuspendedPair() async throws {
    // Keychain trzyma klucz `rarog.example` (`0a0a…`), wskaźnik `{identity: iroh:k, successor: rarog.example}`.
    let (server, store, space, _) = try await lastPointerLeftAfterTransition()
    // Dysk odmawia tylko końca przejścia: ze stanem sprzed wstrzymania (klucz następcy w sesji) następca zostaje
    // i parowanie samym `u` kończy się odmową.
    let name = space.name
    server.pointerDisk.refuse { $0.name == name && $0.identity == .origin(GoldenPointers.rarog) }
    let current = try #require(
      server.built.last { $0.endpoint.credential?.deviceId == "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a" }?.transport)
    await until("strumień globalny klucza z adresem") { !current.streamCalls.isEmpty }
    let valve = ResponseValve()
    server.pairing.set {
      $0.pairResult = .success(PairingFixtures.response(deviceId: "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b", iroh: nil))
      $0.onPair = { await valve.wait() }
    }
    let mark = server.pointerDisk.writes.count
    store.offerPairing(PairingFixtures.link())
    let pairing = Task { await store.confirmPairing() }
    await until("`pair` wstrzymany") { valve.entered == 1 }
    current.set {
      $0.rejection = .revoked(
        deviceId: "0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a", revokedAt: "2026-10-04T10:03:00.000Z", revokedBy: "admin")
    }
    current.end(.global, error: .unauthorized(APIFailure(status: 401, code: "device-revoked")))
    await until("ekran odpięcia") { store.state.auth == .loggedOut(.deviceRevoked) }
    #expect(server.keychain.load() == .none && store.serverEndpoint.credential == nil, "Keychain pusty")
    valve.open()
    #expect(await pairing.value == .paired, "po wznowieniu sesja bez klucza i Keychain pusty")
    let writes = server.pointerDisk.writes.dropFirst(mark)
    let settled = ServerSpace(identity: .iroh(endpointId: GoldenPointers.endpointId), name: space.name)
    #expect(writes.first?.space == settled && writes.first?.saved == true, "najpierw wskaźnik bez następcy")
    #expect(!writes.contains { $0.space?.successor != nil }, "bez nowej zapowiedzi")
    let pointer = try #require(server.pointer)
    #expect(pointer.identity == .origin(GoldenPointers.rarog) && pointer.name != space.name && pointer.successor == nil)
    #expect(store.state.outbox.isEmpty && !server.spaceNames.contains(space.name), "stara przestrzeń do kosza")
    let fresh = try #require(server.pointerDisk.writes.first { $0.saved && $0.space?.name == pointer.name })
    #expect(fresh.spaceNames.contains(space.name), "stara przestrzeń w servers/ do chwili zapisu nowego wskaźnika")
    #expect(try #require(saved(server)).0.deviceId == "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b")
  }

  // MARK: Parowanie dopiero po odczycie wskaźnika

  /// Plik wskaźnika, którego dysk nie oddaje (`false`, np. telefon przed pierwszym odblokowaniem), albo oddaje.
  private func pointerReadable(_ server: FakeServer, _ readable: Bool) throws {
    let mode = readable ? 0o644 : 0o000
    try FileManager.default.setAttributes([.posixPermissions: mode], ofItemAtPath: server.spaces.pointerFile.path)
  }

  /// Złota przestrzeń `.iroh` z danymi i wskaźnikiem `{identity: iroh:k, successor: rarog.example}`, którego dysk nie
  /// oddaje od startu: sesja bez danych na dysku. `credential` = klucz w Keychainie (`nil` = Keychain pusty).
  private func unreadableHangingSuccessor(
    _ credential: DeviceCredential?
  ) async throws -> (FakeServer, RarogStore, ServerSpace, [URL]) {
    let keychain = credential.map { MemoryKeychain(.init(credential: $0, pushKey: "BQUF")) } ?? MemoryKeychain()
    let server = FakeServer(keychain: keychain)
    let (space, drafts) = try await seedIrohSpace(server, pointer: Self.successorPointer)
    try pointerReadable(server, false)
    let store = server.store()
    await store.start()
    #expect(store.dataSpaceDirectory == nil && store.state.outbox.isEmpty, "sesja bez danych na dysku")
    return (server, store, space, drafts)
  }

  @Test("wskaźnik nieczytelny przy parowaniu: odmowa bez żądania `pair`, Keychain i wskaźnik bez zmian; dysk oddaje wskaźnik przy drugiej próbie → zwykłe parowanie (następca skreślony, samo `u` → nowa przestrzeń)")
  func unreadablePointerRefusesPairing() async throws {
    let keyed = PairingFixtures.credential(server: nil, iroh: PairingFixtures.iroh(GoldenPointers.endpointId))
    for credential in [nil, keyed] as [DeviceCredential?] {
      let label = credential == nil ? "bez klucza" : "klucz iroh:k"
      let (server, store, space, drafts) = try await unreadableHangingSuccessor(credential)
      defer { try? pointerReadable(server, true) }
      // Dysk oddaje wskaźnik dopiero w trakcie żądania `pair`: wybór przestrzeni po parowaniu przeczytałby wtedy
      // następcę i dał jego przestrzeń kluczowi z linku z samym `u`, bez dowodu klucza serwera.
      let file = server.spaces.pointerFile.path
      server.pairing.set {
        $0.pairResult = .success(PairingFixtures.response(deviceId: "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b", iroh: nil))
        $0.onPair = { try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: file) }
      }
      let keychain = server.keychain.snapshot
      let (mark, released) = (server.pointerDisk.writes.count, server.released.count)
      store.offerPairing(PairingFixtures.link())
      #expect(await store.confirmPairing(replacing: credential != nil) == .failed(.failed(nil)), "\(label)")
      #expect(server.pairing.read { $0.pairBodies }.isEmpty, "\(label): bez żądania `pair`")
      #expect(server.keychain.snapshot == keychain, "\(label): Keychain bez zmian")
      #expect(server.pointerDisk.writes.count == mark, "\(label): nic nie pisze wskaźnika")
      #expect(server.released.count == released && server.wipes == 0, "\(label)")
      try pointerReadable(server, true)
      #expect(try Data(contentsOf: server.spaces.pointerFile) == Self.successorPointer, "\(label): wskaźnik bez zmian")
      #expect(server.spaceNames == [space.name] && trashed(server).isEmpty, "\(label): nic do kosza")
      for file in drafts { #expect(FileManager.default.fileExists(atPath: file.path), "\(label) \(file.lastPathComponent)") }
      await until("linia o odmowie parowania") {
        self.logged(store, server).contains { $0.contains("space pointer is unreadable") }
      }

      // Druga próba: dysk oddaje wskaźnik, a uzgodnienie skreśla następcę (Keychain pusty albo klucz z tożsamością
      // `identity`), więc link z samym `u` to nowa przestrzeń, stara do kosza dopiero po zapisie nowego wskaźnika.
      server.pairing.set { $0.onPair = nil }
      store.offerPairing(PairingFixtures.link())
      #expect(await store.confirmPairing(replacing: credential != nil) == .paired, "\(label)")
      #expect(server.pairing.read { $0.pairBodies }.count == 1, "\(label): jedno żądanie `pair`")
      let writes = server.pointerDisk.writes.dropFirst(mark)
      let settled = ServerSpace(identity: .iroh(endpointId: GoldenPointers.endpointId), name: space.name)
      #expect(writes.first?.space == settled && writes.first?.saved == true, "\(label): najpierw wskaźnik bez następcy")
      #expect(!writes.contains { $0.space?.successor != nil }, "\(label): bez nowej zapowiedzi")
      let pointer = try #require(server.pointer)
      #expect(pointer.identity == .origin(GoldenPointers.rarog) && pointer.name != space.name, "\(label): nowa przestrzeń")
      #expect(pointer.successor == nil && store.state.outbox.isEmpty && !server.spaceNames.contains(space.name), "\(label)")
      let fresh = try #require(server.pointerDisk.writes.first { $0.saved && $0.space?.name == pointer.name })
      #expect(fresh.spaceNames.contains(space.name), "\(label): stara przestrzeń w servers/ do chwili zapisu wskaźnika")
      #expect(try #require(saved(server)).0.deviceId == "0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b", "\(label)")
    }
  }

  @Test("pointer unreadable at the start, returned by the disk at pairing through `k`: the same space, and its queue and list show on the same store")
  func pointerReadAtPairingKeepsSpace() async throws {
    let (server, store, space, drafts) = try await unreadableHangingSuccessor(nil)
    let row = try JSONDecoder().decode(SessionSummary.self, from: Data(Frames.summary("s1").utf8))
    let list = SnapshotCache(directory: server.spaces.directory(space).appending(path: ServerSpaces.list))
    #expect(await list.save([row], at: Date()))
    try pointerReadable(server, true)
    store.offerPairing(pointerKeyLink)
    #expect(await store.confirmPairing() == .paired)
    #expect(server.pointer == ServerSpace(identity: .iroh(endpointId: GoldenPointers.endpointId), name: space.name))
    #expect(server.wipes == 0)
    // The start read the queue from the process's scratch directory; entering the space reads the space's own.
    await until("queue and list of the space") { !store.state.outbox.isEmpty && store.state.sessions["s1"] != nil }
    expectSameSpace(store, server, space, drafts)
    #expect(store.state.listCache.staleSince != nil, "the list comes from the cache, stale until the first stream state")
    let restarted = server.store()
    await restarted.start()
    expectSameSpace(restarted, server, space, drafts)
  }
}
