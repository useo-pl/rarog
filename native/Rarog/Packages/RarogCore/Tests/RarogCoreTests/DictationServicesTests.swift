import Foundation
import RarogContract
@testable import RarogCore
import RarogTransport
import Testing

// Wejście dyktowania dla UI: flaga builda z Info.plist, wybór i trasa z magazynu, a wybór przeżywa
// wylogowanie, „Zapomnij serwer” i nowy serwer.

private func version(voice: String?) -> VersionInfo {
  let field = voice.map { #","voiceEnabled":\#($0)"# } ?? ""
  let json = #"{"version":"0.1.0","protocolVersion":3,"serverStartId":"s","tailnet":null\#(field)}"#
  // swiftlint:disable:next force_try
  return try! JSONDecoder().decode(VersionInfo.self, from: Data(json.utf8))
}

private func hello(_ transport: FakeTransport, serverStartId: String) {
  transport.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"\#(serverStartId)"}"#)
}

@MainActor
@Suite("dyktowanie: usługi i trasa w magazynie")
struct DictationServicesTests {
  @Test("flaga z Info.plist: tylko \"YES\" włącza Soniox; NO, brak klucza i niepodstawiona zmienna — nie")
  func sonioxAllowedFromInfo() {
    #expect(DictationServices.sonioxAllowed(info: "YES"))
    #expect(!DictationServices.sonioxAllowed(info: "NO"))
    #expect(!DictationServices.sonioxAllowed(info: nil))
    #expect(!DictationServices.sonioxAllowed(info: "$(RAROG_VOICE_SONIOX)"))
    #expect(!DictationServices.sonioxAllowed(info: ""))
  }

  @Test("live: wybór w podanych UserDefaults; memory: wybór w pamięci; flaga taka, jak podana")
  func factories() {
    let scratch = ScratchDefaults()
    let live = DictationServices.live(sonioxAllowed: false, defaults: scratch.defaults)
    #expect(!live.sonioxAllowed)
    live.choices.save(.soniox)
    #expect(scratch.defaults.string(forKey: DictationChoiceStore.key) == "soniox")
    #expect(DictationServices.live(sonioxAllowed: true, defaults: scratch.defaults).choices.choice == .soniox)

    let memory = DictationServices.memory(sonioxAllowed: true, choice: .system)
    #expect(memory.sonioxAllowed)
    #expect(memory.choices.choice == .system)
    #expect(scratch.defaults.string(forKey: DictationChoiceStore.key) == "soniox", "pamięć nie dotyka UserDefaults")
  }

  @Test("magazyn bez podpięcia: flaga YES, brak wyboru → ekran")
  func storeDefault() {
    let store = RarogStore(
      transport: FakeTransport(credential: false), rules: MutationRules(timing: fastTiming),
      outboxDirectory: temporaryOutbox(), clientBuild: 7, timing: fastTiming)
    #expect(store.dictation.sonioxAllowed)
    #expect(store.dictation.choices.choice == nil)
    #expect(store.dictationRoute == .ask(.noChoice))
  }

  @Test("trasa magazynu idzie za wyborem, sondą wersji, odmową mintu i flagą")
  func routeFollowsState() async {
    let probe = VoiceProbe(base: FakeTransport())
    let rules = MutationRules(timing: fastTiming)
    probe.base.gate = MutationGate(policy: rules)
    let store = RarogStore(transport: probe, rules: rules, outboxDirectory: temporaryOutbox(), clientBuild: 7, timing: fastTiming)
    let services = DictationServices.memory(sonioxAllowed: true, choice: .soniox)
    store.attachDictation(services)
    await store.start()
    await until("online") { store.state.global == .online }
    hello(probe.base, serverStartId: "s")
    await until("hello") { store.state.compat == .ok }

    #expect(store.state.sonioxOnServer == .unknown)
    #expect(store.dictationRoute == .soniox, "sonda jeszcze nie odpowiedziała: Soniox")
    store.areaDispatch(.versionProbed(version(voice: "false")))
    #expect(store.dictationRoute == .ask(.sonioxUnavailable), "sonda: Soniox niedostępny")
    store.areaDispatch(.versionProbed(version(voice: "true")))
    #expect(store.dictationRoute == .soniox, "sonda: Soniox dostępny")

    // Zmiana wyboru działa od następnego odczytu trasy.
    services.choices.save(.system)
    #expect(store.dictationRoute == .system)
    services.choices.save(.soniox)

    // Mint dostaje 503 voice_unconfigured (klucz zdjęty po sondzie): następne stuknięcie = ekran.
    probe.set { $0.result = .failure(.http(APIFailure(status: 503, code: "voice_unconfigured", message: "Brak klucza."))) }
    #expect(await store.mintVoiceToken() == .disabled(message: "Brak klucza."))
    #expect(store.dictationRoute == .ask(.sonioxUnavailable))
    #expect(services.choices.choice == .soniox, "odmowa nie zmienia wyboru")

    // Flaga NO: ekran także przy dostępnym serwerze, wybór nietknięty.
    let blocked = DictationServices.memory(sonioxAllowed: false, choice: .soniox)
    store.attachDictation(blocked)
    hello(probe.base, serverStartId: "s2")
    await until("nowy proces serwera") { store.state.serverStartId == "s2" }
    #expect(store.state.sonioxOnServer == .available)
    #expect(store.dictationRoute == .ask(.sonioxUnavailable))
    #expect(blocked.choices.choice == .soniox)
  }

  @Test("odmowa mintu przed odpowiedzią sondy: następne stuknięcie = ekran (mint rozstrzyga)")
  func refusalBeforeProbe() async {
    let probe = VoiceProbe(base: FakeTransport())
    let rules = MutationRules(timing: fastTiming)
    probe.base.gate = MutationGate(policy: rules)
    let store = RarogStore(transport: probe, rules: rules, outboxDirectory: temporaryOutbox(), clientBuild: 7, timing: fastTiming)
    store.attachDictation(DictationServices.memory(sonioxAllowed: true, choice: .soniox))
    await store.start()
    await until("online") { store.state.global == .online }
    let errors = [TransportError.http(APIFailure(status: 503, code: "voice_unconfigured")), .http(APIFailure(status: 404))]
    for (index, error) in errors.enumerated() {
      // Nowy proces serwera na przypadek: odmowa poprzedniego nie zasłania wyniku.
      hello(probe.base, serverStartId: "s\(index)")
      await until("hello") { store.state.serverStartId == "s\(index)" }
      #expect(store.state.capabilities == nil, "sonda wersji jeszcze nie odpowiedziała")
      #expect(store.dictationRoute == .soniox, "\(error)")
      probe.set { $0.result = .failure(error) }
      _ = await store.mintVoiceToken()
      #expect(store.state.sonioxOnServer == .unavailable, "\(error)")
      #expect(store.dictationRoute == .ask(.sonioxUnavailable), "\(error)")
    }
  }

  // MARK: - Przypadek 12: wybór należy do urządzenia

  @Test("wylogowanie (401) nie zmienia wyboru")
  func logoutKeepsChoice() async {
    let scratch = ScratchDefaults()
    let (store, transport, server) = await pairedStore(scratch)
    // Złącze trzyma atrapę serwera bez własności (`unowned`): musi żyć do końca testu.
    defer { withExtendedLifetime(server) {} }
    hello(transport, serverStartId: "s1")
    await until("hello") { store.state.compat == .ok }
    store.areaDispatch(.versionProbed(version(voice: "true")))
    #expect(store.dictationRoute == .soniox)

    transport.end(.global, error: .unauthorized(APIFailure(status: 401)))
    await until("wylogowanie") { store.state.auth != .loggedIn }
    #expect(store.dictation.choices.choice == .soniox)
    #expect(scratch.defaults.string(forKey: DictationChoiceStore.key) == "soniox")
    #expect(store.state.sonioxOnServer == .unknown, "po wylogowaniu serwera nie znamy")
  }

  @Test("„Zapomnij serwer” nie zmienia wyboru")
  func forgetServerKeepsChoice() async {
    let scratch = ScratchDefaults()
    let (store, _, server) = await pairedStore(scratch)
    defer { withExtendedLifetime(server) {} }
    #expect(await store.forgetServer())
    #expect(store.state.auth == .loggedOut(.notLoggedIn))
    #expect(store.dictation.choices.choice == .soniox)
    #expect(scratch.defaults.string(forKey: DictationChoiceStore.key) == "soniox")
  }

  @Test("nowy serwer: wybór bez zmian, stan Soniox według sondy nowego serwera")
  func newServerKeepsChoice() async {
    let scratch = ScratchDefaults()
    let (store, first, server) = await pairedStore(scratch)
    defer { withExtendedLifetime(server) {} }
    hello(first, serverStartId: "s1")
    await until("hello") { store.state.compat == .ok }
    store.areaDispatch(.versionProbed(version(voice: "false")))
    #expect(store.dictationRoute == .ask(.sonioxUnavailable))

    store.offerPairing(PairingFixtures.link(server: URL(string: "https://inny.example")!))
    #expect(await store.confirmPairing(replacing: true) == .paired)
    guard let device = server.current, device !== first else {
      Issue.record("brak nowego transportu")
      return
    }
    #expect(store.dictation.choices.choice == .soniox)
    #expect(store.state.sonioxOnServer == .unknown, "stan poprzedniego serwera nie przechodzi na nowy")
    #expect(store.dictationRoute == .soniox)
    await until("strumień nowego serwera") { !device.streamCalls.isEmpty }
    hello(device, serverStartId: "s2")
    await until("hello nowego serwera") { store.state.serverStartId == "s2" }
    store.areaDispatch(.versionProbed(version(voice: "true")))
    #expect(store.state.sonioxOnServer == .available)
    #expect(store.dictationRoute == .soniox)
    #expect(scratch.defaults.string(forKey: DictationChoiceStore.key) == "soniox")
  }

  /// Magazyn z kluczem urządzenia (jak w apce), wyborem `soniox` w `UserDefaults` testu i żywym strumieniem.
  private func pairedStore(_ scratch: ScratchDefaults) async -> (RarogStore, FakeTransport, FakeServer) {
    let server = FakeServer(keychain: MemoryKeychain(.init(credential: PairingFixtures.credential(), pushKey: "BQUF")))
    let first = FakeTransport(credential: false)
    server.queued = [first]
    let store = server.store()
    let services = DictationServices.live(sonioxAllowed: true, defaults: scratch.defaults)
    services.choices.save(.soniox)
    store.attachDictation(services)
    await store.start()
    await until("strumień globalny") { store.state.global == .online }
    return (store, first, server)
  }
}
