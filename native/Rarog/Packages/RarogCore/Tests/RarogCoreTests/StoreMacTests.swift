import Foundation
import RarogContract
@testable import RarogCore
import RarogTransport
import Testing

// Obciążenie Maca w stopce listy: reduktor (fazy, termin ważności, 404) i odczyty w harmonogramie limitów
// (`RarogStore+Mac`, `RarogStore+Usage`) — bramka zalogowania i wierzchu, podłoga, tap, wylogowanie, stary serwer.

private let load = MacLoad(cpu: 35, ram: 60, disk: 45)
private let other = MacLoad(cpu: 90, ram: 80, disk: 95)
private let notFound = TransportError.http(APIFailure(status: 404, code: "not-found"))
private let expired401 = TransportError.unauthorized(APIFailure(status: 401))

/// Rytm testów: Mac co 100 ms, termin ważności 300 ms; limity i sonda wersji rzadko, żeby nie budziły pętli.
private let macTiming = UsageTiming(
  refresh: .seconds(60), retry: .seconds(60), floor: .milliseconds(50), mac: .milliseconds(100),
  macTTL: .milliseconds(300))

@Suite("reduktor: obciążenie Maca")
struct ReducerMacTests {
  private let t0 = Date(timeIntervalSince1970: 1_790_000_000)

  @Test("ładuję → liczby → odświeżenie padło (nieświeże) → termin minął (szkielet) → 404 (brak funkcji)")
  func phases() {
    var state = AppState(clientBuild: 1)
    #expect(state.macLoad.phase == .loading)
    state.apply(.mac(.failed), now: t0)
    #expect(state.macLoad.phase == .unavailable, "porażka przed pierwszymi liczbami")
    state.apply(.mac(.loaded(load, at: t0)), now: t0)
    #expect(state.macLoad.phase == .ready && state.macLoad.load == load && state.macLoad.receivedAt == t0)
    state.apply(.mac(.failed), now: t0)
    #expect(state.macLoad.phase == .stale && state.macLoad.load == load, "liczby zostają do terminu")
    state.apply(.mac(.expired), now: t0)
    #expect(state.macLoad.phase == .unavailable && state.macLoad.load == nil, "po terminie szkielet, nie stare liczby")
    state.apply(.mac(.unsupported(serverStartId: "s")), now: t0)
    #expect(state.macLoad.phase == .unsupported && state.macLoad.unsupportedServer == "s")
    state.apply(.mac(.loaded(other, at: t0)), now: t0)
    #expect(state.macLoad.phase == .ready && !state.macLoad.unsupported, "nowy serwer z trasą")
  }

  @Test("pusty odczyt `{}` to „nic nie wiadomo” — szkielet; zero to liczba")
  func emptyAndZero() {
    var state = AppState(clientBuild: 1)
    state.apply(.mac(.loaded(MacLoad(), at: t0)), now: t0)
    #expect(state.macLoad.phase == .unavailable)
    state.apply(.mac(.loaded(MacLoad(cpu: 0), at: t0)), now: t0)
    #expect(state.macLoad.phase == .ready && state.macLoad.load?.cpu == 0)
  }

  @Test("logowanie i wylogowanie kasują liczby i znacznik starego serwera")
  func reset() {
    var state = AppState(clientBuild: 1)
    state.apply(.mac(.loaded(load, at: t0)), now: t0)
    state.apply(.loggedOut(.deviceUnknown), now: t0)
    #expect(state.macLoad == MacLoadState())
    state.apply(.mac(.unsupported(serverStartId: "s")), now: t0)
    state.apply(.loggedIn, now: t0)
    #expect(state.macLoad == MacLoadState())
  }
}

@MainActor
@Suite("magazyn: odczyty obciążenia Maca")
struct StoreMacTests {
  // Z liczbami na ekranie śpią DWA zadania: pętla i termin ważności (osobne zadanie), więc testy idą krokami
  // `advance` i czekają na stan, nie na `VirtualClock.step` (ten czeka na jeden sen).

  @Test("start: odczyt od razu, potem co `mac`; liczby w stanie")
  func pollsOnStartAndPeriodically() async {
    let transport = ProbeTransport()
    transport.set { $0.mac = [.success(load), .success(other)] }
    let clock = VirtualClock()
    let store = makeVirtualStore(transport, timing: macTiming, clock: clock)
    await store.start()
    await until("pierwszy odczyt") { store.state.macLoad.phase == .ready }
    await until("pętla i termin ważności śpią") { clock.sleeping.count == 2 }
    #expect(transport.macCalls == 1 && store.state.macLoad.load == load)
    clock.advance(by: .milliseconds(50))
    try? await Task.sleep(for: .milliseconds(30))
    #expect(transport.macCalls == 1, "nie częściej niż co `mac`")
    clock.advance(by: .milliseconds(51))
    await until("drugi odczyt") { transport.macCalls == 2 }
    await until("drugi odczyt w stanie") { store.state.macLoad.load == other }
  }

  @Test("termin ważności: liczby znikają po `macTTL` od ostatniego UDANEGO odczytu — także gdy odczyt wisi")
  func expiresAfterLastSuccess() async {
    let transport = ProbeTransport()
    transport.set { $0.mac = [.success(load), .failure(.timedOut)] }
    let clock = VirtualClock()
    let store = makeVirtualStore(transport, timing: macTiming, clock: clock)
    await store.start()
    await until("liczby") { store.state.macLoad.phase == .ready }
    await until("pętla i termin ważności śpią") { clock.sleeping.count == 2 }
    clock.advance(by: .milliseconds(101))
    await until("porażka: liczby zostają, nieświeże") { store.state.macLoad.phase == .stale }
    #expect(store.state.macLoad.load == load)
    // Pętla po porażce musi znów zasnąć, zanim ruszy zegar: sen założony po kroku miałby termin 301 ms,
    // a nie 201 ms, i trzeci odczyt nigdy by nie wyszedł (bramka pod obciążeniem).
    await until("pętla znów śpi") { clock.sleeping.count == 2 }
    // Następny odczyt wisi na sieci, a pętla na niego czeka: termin i tak mija o czasie.
    transport.set { $0.macHold = true }
    clock.advance(by: .milliseconds(100))
    await until("odczyt w drodze") { transport.macCalls == 3 }
    #expect(store.state.macLoad.load == load, "201 ms < 300 ms — jeszcze w terminie")
    clock.advance(by: .milliseconds(100))
    await until("po terminie szkielet, choć odczyt wciąż wisi") { store.state.macLoad.load == nil }
    #expect(store.state.macLoad.phase == .unavailable && transport.macCalls == 3)
    transport.set { $0.macHold = false }
    transport.release()
    await until("odczyt doszedł") { store.usagePolling.macRead == nil }
    #expect(store.state.macLoad.load == nil, "porażka po terminie nie wskrzesza liczb")
  }

  @Test("powrót z tła po terminie: bez starych liczb, odczyt od razu; tło nie czyta")
  func backgroundExpiry() async {
    let transport = ProbeTransport()
    transport.set { $0.mac = [.success(load)] }
    let clock = VirtualClock()
    let store = makeVirtualStore(transport, timing: macTiming, clock: clock)
    await store.start()
    await until("liczby") { store.state.macLoad.phase == .ready }
    store.setScenePhase(.inactive)
    store.setScenePhase(.background)
    await until("pętla stoi") { store.usagePolling.loop == nil }
    clock.advance(by: .milliseconds(400))
    try? await Task.sleep(for: .milliseconds(30))
    #expect(transport.macCalls == 1, "w tle nikt nie pyta")
    transport.set { $0.macHold = true }
    store.setScenePhase(.inactive)
    store.setScenePhase(.active)
    #expect(store.state.macLoad.load == nil, "na wierzchu żadnych liczb sprzed terminu")
    await until("odczyt od razu po powrocie") { transport.macCalls == 2 }
    transport.set { $0.macHold = false }
    transport.release()
    await until("świeże liczby") { store.state.macLoad.phase == .ready }
  }

  @Test("wejście na wierzch po terminie kasuje liczby w tej samej klatce, zanim ruszy pętla")
  func resumeExpiresSynchronously() async {
    let transport = ProbeTransport()
    transport.set { $0.mac = [.success(load)] }
    let clock = VirtualClock()
    // Termin dłuższy niż krok: zadanie ważności jeszcze śpi, liczby kasuje wyłącznie wejście na wierzch.
    let timing = UsageTiming(
      refresh: .seconds(60), retry: .seconds(60), floor: .milliseconds(50), mac: .milliseconds(100),
      macTTL: .milliseconds(300))
    let store = makeVirtualStore(transport, timing: timing, clock: clock)
    await store.start()
    await until("liczby") { store.state.macLoad.phase == .ready }
    store.setScenePhase(.inactive)
    store.setScenePhase(.background)
    await until("pętla stoi") { store.usagePolling.loop == nil }
    store.usagePolling.macExpiry?.cancel()
    // Zawieszony proces: zegar idzie, a zadanie terminu nie zdążyło się obudzić.
    clock.advance(by: .milliseconds(400))
    #expect(store.state.macLoad.load == load)
    store.setScenePhase(.active)
    #expect(store.state.macLoad.load == nil, "synchronicznie w `setScenePhase(.active)`")
  }

  @Test("szybkie wznowienie (pod podłogą) nie czyta drugi raz; liczby w terminie zostają")
  func quickResume() async {
    let transport = ProbeTransport()
    transport.set { $0.mac = [.success(load)] }
    let clock = VirtualClock()
    let store = makeVirtualStore(transport, timing: macTiming, clock: clock)
    await store.start()
    await until("liczby") { store.state.macLoad.phase == .ready }
    await until("pętla i termin ważności śpią") { clock.sleeping.count == 2 }
    store.setScenePhase(.inactive)
    store.setScenePhase(.active)
    await until("pętla śpi po wznowieniu") { clock.sleeping.count == 2 && !store.usagePolling.entering }
    #expect(transport.macCalls == 1, "podłoga 50 ms")
    #expect(store.state.macLoad.load == load)
  }

  @Test("współbieżne tapnięcia dołączają do odczytu w drodze — jedno żądanie")
  func concurrentTap() async {
    let transport = ProbeTransport()
    transport.set { $0.mac = [.success(load)] }
    let clock = VirtualClock()
    let store = makeVirtualStore(transport, timing: macTiming, clock: clock)
    await store.start()
    await until("liczby") { store.state.macLoad.phase == .ready }
    await until("pętla i termin ważności śpią") { clock.sleeping.count == 2 }
    transport.set {
      $0.macHold = true
      $0.mac = [.success(other)]
    }
    store.refreshUsageNow()
    store.refreshUsageNow()
    store.refreshUsageNow()
    await until("odczyt w drodze") { transport.macCalls == 2 }
    try? await Task.sleep(for: .milliseconds(30))
    #expect(transport.macCalls == 2, "trzy tapnięcia, jeden odczyt")
    transport.set { $0.macHold = false }
    transport.release()
    await until("wynik tapnięcia") { store.state.macLoad.load == other }
  }

  @Test("tap tuż przed zejściem w tło: odczyt nie wychodzi z tła")
  func tapThenBackground() async {
    let transport = ProbeTransport()
    transport.set { $0.mac = [.success(load)] }
    let clock = VirtualClock()
    let store = makeVirtualStore(transport, timing: macTiming, clock: clock)
    await store.start()
    await until("liczby") { store.state.macLoad.phase == .ready }
    store.refreshUsageNow()
    store.setScenePhase(.inactive)
    store.setScenePhase(.background)
    try? await Task.sleep(for: .milliseconds(40))
    #expect(transport.macCalls == 1)
  }

  @Test(
    "odczyt sprzed wylogowania: spóźnione 200 i 401 nie ruszają nowego logowania",
    arguments: [
      LateRead(result: .success(other), arrived: false, testDescription: "200"),
      LateRead(result: .failure(expired401), arrived: false, testDescription: "401"),
      LateRead(result: .success(other), arrived: true, testDescription: "200 już w drodze"),
      LateRead(result: .failure(notFound), arrived: true, testDescription: "404 już w drodze"),
    ])
  func lateReadAcrossRelogin(_ late: LateRead<MacLoad>) async {
    let transport = ProbeTransport()
    transport.set { $0.mac = [.success(load)] }
    let store = makeProbeStore(transport, timing: UsageTiming(refresh: .seconds(60), retry: .seconds(60), floor: .zero,
      mac: .seconds(60), macTTL: .seconds(120)))
    await store.start()
    await until("liczby i online") { store.state.macLoad.phase == .ready && store.state.global == .online }
    transport.set {
      $0.macHold = true
      $0.holdIgnoresCancel = late.arrived
      $0.mac = [late.result]
    }
    store.refreshUsageNow()
    await until("odczyt w drodze") { transport.macCalls == 2 }
    transport.base.end(.global, error: expired401)
    await until("wylogowanie") { store.state.auth == .loggedOut(.deviceUnknown) }
    #expect(store.state.macLoad == MacLoadState())
    transport.set {
      $0.macHold = false
      $0.mac = [.success(load)]
    }
    store.enterLoggedIn()
    await until("odczyt nowego logowania") { transport.macCalls == 3 && store.state.macLoad.phase == .ready }
    transport.set { $0.mac = [.failure(.timedOut)] }
    transport.release()
    try? await Task.sleep(for: .milliseconds(80))
    #expect(store.state.auth == .loggedIn, "stary 401 nie wylogowuje nowego")
    #expect(store.state.macLoad.load == load && store.state.macLoad.phase == .ready, "stary wynik nie wraca")
  }

  @Test("stary serwer (404): linia znika, bez ponowień; nowy start serwera (`hello` z innym id) pyta raz")
  func oldServerIsSilent() async {
    let transport = ProbeTransport()
    transport.set { $0.mac = [.failure(notFound)] }
    let clock = VirtualClock()
    let store = makeVirtualStore(transport, timing: macTiming, clock: clock)
    await store.start()
    await connected(store, transport)
    await until("brak funkcji") { store.state.macLoad.phase == .unsupported }
    await until("pętla śpi") { clock.sleeping.count == 1 }
    // Odczyt mógł wyprzedzić `hello` (serwer nieznany) — wtedy jedno potwierdzenie po nim, potem cisza.
    for _ in 0..<5 { await clock.stepPast(.milliseconds(100)) }
    let calls = transport.macCalls
    #expect(calls <= 2, "bez pętli błędów: \(calls)")
    for _ in 0..<5 { await clock.stepPast(.milliseconds(100)) }
    #expect(transport.macCalls == calls, "cisza do innego startu serwera")
    #expect(store.state.macLoad.phase == .unsupported)
    transport.set { $0.mac = [.success(load)] }
    transport.base.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"t"}"#)
    await until("nowy serwer zna trasę") { store.state.macLoad.phase == .ready }
    #expect(transport.macCalls == calls + 1)
  }

  @Test("spóźnione 404 starego serwera po `hello` nowego nie wyłącza odczytów nowego")
  func late404AcrossServerRestart() async {
    let transport = ProbeTransport()
    transport.set { $0.mac = [.success(load)] }
    let clock = VirtualClock()
    let store = makeVirtualStore(transport, timing: macTiming, clock: clock)
    await store.start()
    await connected(store, transport)
    await until("liczby") { store.state.macLoad.phase == .ready && store.state.serverStartId == "s" }
    transport.set {
      $0.macHold = true
      $0.mac = [.failure(notFound)]
    }
    store.refreshUsageNow()
    await until("odczyt do starego serwera w drodze") { transport.macCalls == 2 }
    transport.set {
      $0.macHold = false
      $0.mac = [.success(other)]
    }
    transport.base.push(.global, json: #"{"type":"hello","protocolVersion":3,"serverStartId":"t"}"#)
    await until("nowy serwer") { store.state.serverStartId == "t" }
    transport.release()
    await until("404 należy do starego serwera — nowy dostaje odczyt") { store.state.macLoad.load == other }
    #expect(store.state.macLoad.phase == .ready && transport.macCalls == 3)
  }

  @Test("401 z odczytu Maca wylogowuje jak 401 strumienia")
  func unauthorized() async {
    let transport = ProbeTransport()
    transport.set { $0.mac = [.failure(expired401)] }
    let store = makeProbeStore(transport, timing: macTiming)
    await store.start()
    await until("wylogowanie") { store.state.auth == .loggedOut(.deviceUnknown) }
  }
}
