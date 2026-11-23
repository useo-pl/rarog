import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Powiadomienia APNs w widoku: baner „Włącz powiadomienia" w kolumnie banerów globalnych,
// zdania dymków, baner degradacji tokenu i nawigacja z tapnięcia.

@MainActor
@Suite("powiadomienia: baner „Włącz”, dymki, cel tapnięcia")
struct PushPromptTests {
  private func failed() -> ConnectionMemory {
    var memory = ConnectionMemory()
    memory.observe(.connecting(since: Sample.now.addingTimeInterval(-5)), now: Sample.now.addingTimeInterval(-5))
    memory.observe(.offline(since: Sample.now), now: Sample.now)
    return memory
  }

  /// Zalogowany, serwer z kanałem APNs, zgoda jeszcze nieznana.
  private func state(apns: Bool = true, authorization: PushAuthorization = .notDetermined) -> AppState {
    var state = Sample.state(session: Sample.session())
    state.auth = .loggedIn
    state.apply(.versionProbed(Sample.decode(
      VersionInfo.self, #"{"version":"1","protocolVersion":3,"serverStartId":"s","apnsEnabled":\#(apns)}"#)), now: Sample.now)
    state.apply(.push(.authorization(authorization)), now: Sample.now)
    return state
  }

  @Test("baner „Włącz”: w kolumnie banerów globalnych; nie przy braku serwera, bez kanału, po zgodzie i po „×”")
  func promptSlot() {
    let live = ConnectionMemory()
    let ready = state()
    #expect(ready.pushPromptVisible(in: .list, global: live, now: Sample.now))
    #expect(!ready.pushPromptVisible(in: .detail(sessionId: "s1", listVisible: true), global: live, now: Sample.now),
            "przy widocznej liście prawa kolumna go nie powtarza")
    #expect(ready.pushPromptVisible(in: .detail(sessionId: "s1", listVisible: false), global: live, now: Sample.now))
    #expect(!ready.pushPromptVisible(in: .list, global: failed(), now: Sample.now), "jedna awaria = jeden baner")
    #expect(!state(apns: false).pushPromptVisible(in: .list, global: live, now: Sample.now))
    #expect(!state(authorization: .authorized).pushPromptVisible(in: .list, global: live, now: Sample.now))
    #expect(!state(authorization: .denied).pushPromptVisible(in: .list, global: live, now: Sample.now))
    var snoozed = state()
    snoozed.apply(.push(.snoozed(until: Sample.now.addingTimeInterval(60))), now: Sample.now)
    #expect(!snoozed.pushPromptVisible(in: .list, global: live, now: Sample.now))
    #expect(snoozed.pushPromptVisible(in: .list, global: live, now: Sample.now.addingTimeInterval(61)))
  }

  @Test("testy UI: udawany kanał pokazuje baner bez `apnsEnabled` serwera")
  func simulatedChannel() {
    var demo = state(apns: false)
    demo.apply(.push(.simulatedChannel), now: Sample.now)
    #expect(demo.pushPromptVisible(in: .list, global: ConnectionMemory(), now: Sample.now))
  }

  @Test("degradacja tokenu APNs to baner z godziną tokenu; bez statusu i bez kanału banera nie ma; zdrowy token go gasi")
  func degradedBanner() {
    var state = state()
    #expect(state.banners(in: .list, global: ConnectionMemory(), transcript: ConnectionMemory()).isEmpty,
            "status nieprzeczytany — o degradacji nic nie wiadomo")
    state.apply(.push(.status(enabled: false, degradedSince: Sample.iso(3600))), now: Sample.now)
    #expect(state.banners(in: .list, global: ConnectionMemory(), transcript: ConnectionMemory()).isEmpty,
            "serwer bez kanału APNs: status nic nie mówi")
    state.apply(.push(.status(enabled: true, degradedSince: Sample.iso(600))), now: Sample.now)
    let banners = state.banners(in: .list, global: ConnectionMemory(), transcript: ConnectionMemory())
    #expect(banners == [.pushDegraded(since: Sample.iso(600))])
    #expect(UICopy.banner(banners[0], now: Sample.now).hasPrefix("Powiadomienia nie działają od "))
    state.apply(.push(.status(enabled: true, degradedSince: nil)), now: Sample.now)
    #expect(state.banners(in: .list, global: ConnectionMemory(), transcript: ConnectionMemory()).isEmpty)
  }

  @Test("degradacja z przyczyną od serwera: zdanie z przyczyną zamiast ogólnego, bez godziny; bez przyczyny jak dotąd")
  func degradedBannerReason() {
    var state = state()
    state.apply(.push(.status(enabled: true, degradedSince: Sample.iso(600), reason: .passMissing)), now: Sample.now)
    let banners = state.banners(in: .list, global: ConnectionMemory(), transcript: ConnectionMemory())
    #expect(banners == [.pushDegraded(since: Sample.iso(600), reason: .passMissing)])
    #expect(UICopy.banner(banners[0], now: Sample.now)
      == "Powiadomienia jeszcze nie działają — serwer czeka na przepustkę przekaźnika i ponawia sam.")
    #expect(UICopy.banner(.pushDegraded(since: Sample.iso(600), reason: .envMismatch), now: Sample.now)
      == "Powiadomienia nie działają — Apple nie przyjmuje tokenu tej wersji apki. Pomoże aktualizacja apki.")
    // Bez przyczyny: dotychczasowe zdanie z godziną, a bez czytelnej godziny — ogólne.
    #expect(UICopy.banner(.pushDegraded(since: Sample.iso(600)), now: Sample.now).hasPrefix("Powiadomienia nie działają od "))
    #expect(UICopy.banner(.pushDegraded(since: "zła data"), now: Sample.now)
      == "Powiadomienia nie działają — zaglądaj tu ręcznie.")
    #expect(UICopy.banner(.pushDegraded(since: "zła data", reason: .passMissing), now: Sample.now).hasPrefix("Powiadomienia jeszcze"))
  }

  @Test("zdania: baner jak w PWA, dymek sukcesu tylko „Powiadomienia działają”, porażki mówią, co dalej")
  func copy() {
    #expect(UICopy.pushPrompt == "Włącz powiadomienia na tym urządzeniu")
    #expect(UICopy.pushEnable == "Włącz")
    #expect(UICopy.pushSnooze == "Nie teraz — odłóż na tydzień")
    #expect(UICopy.pushNotice(.working) == "Powiadomienia działają")
    #expect(UICopy.pushNotice(.testMissing) == "Push próbny nie dotarł — powiadomienia mogą nie działać")
    #expect(UICopy.pushNotice(.denied) == "Powiadomienia zablokowane — włącz je w Ustawieniach")
    #expect(UICopy.pushNotice(.failed) == "Nie udało się włączyć powiadomień — spróbuj za chwilę")
  }

  @Test("liczba z kafla Live Activity: pierwsza sesja rodzaju w kolejności listy; bez niej i tło kafla — lista")
  func liveActivityLinks() {
    var state = AppState(clientBuild: 1)
    state.sessions["w"] = Sample.session(id: "w", state: "waiting-permission")
    state.sessions["r"] = Sample.session(id: "r", state: "running")
    state.sessions["f"] = Sample.session(id: "f", state: "waiting-input")
    state.sessions["q"] = Sample.session(id: "q", state: "waiting-input", extra: #""seen":true"#)
    #expect(state.firstSession(.waiting)?.id == "w")
    #expect(state.firstSession(.working)?.id == "r")
    #expect(state.firstSession(.finished)?.id == "f", "odebrany wynik (q) to nie „skończyło”")
    state.sessions["r"] = nil
    state.sessions["b"] = Sample.session(
      id: "b", state: "waiting-input", extra: #""seen":true,"backgroundTasks":[{"id":"t","kind":"command"}]"#)
    #expect(state.firstSession(.working)?.id == "b", "zadanie w tle po turze liczy się jak praca")
    state.sessions["w"] = nil
    #expect(state.firstSession(.waiting) == nil, "kafel spóźniony: czekającej już nie ma")

    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.setListCollapsed(true)
    navigation.detail = .session("b")
    navigation.openList()
    #expect(navigation.detail == nil && !navigation.listCollapsed, "lista wraca, prawa kolumna bez trasy")
  }

  @Test("tap w powiadomienie: sesja; Codex z terminalem — sesja znana liście (rysuje terminal), nieznana — terminal")
  func openTarget() {
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    var state = AppState(clientBuild: 1)
    navigation.detail = .project("/Users/demo/Projects/willow")
    navigation.openPushTarget(PushTarget(sessionId: "s1"), state: state)
    #expect(navigation.detail == .session("s1"))
    navigation.openPushTarget(PushTarget(sessionId: "c1", termId: "cafecafecafecafe"), state: state)
    #expect(navigation.detail == .terminal("cafecafecafecafe"), "sesji nie ma na liście: terminal wprost")
    state.sessions["c1"] = Sample.session(
      id: "c1", title: "rarog", extra: #""engine":"codex","termId":"cafecafecafecafe""#)
    navigation.openPushTarget(PushTarget(sessionId: "c1", termId: "cafecafecafecafe"), state: state)
    #expect(navigation.detail == .session("c1"), "wpis znany: wiersz zaznaczony, ekran to jego terminal")
    #expect(navigation.terminalRoute(state)?.key == "cafecafecafecafe")
  }
}
