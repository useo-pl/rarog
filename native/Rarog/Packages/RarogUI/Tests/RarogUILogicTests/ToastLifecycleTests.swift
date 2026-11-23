import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

/// Cykl życia dymka w centrum: zegar 6 s i ogłoszenie czytnika należą do
/// `ToastCenter`, bo dymek ma dwa osadzenia (nakładka kolumny i ekran sesji nad promptem), a każde musi tak
/// samo gasnąć i mówić. Do tego reguła osadzenia `ToastPlacement`. Właściciel: łączność.
@MainActor
@Suite("dymek: zegar i czytnik w centrum, osadzenie na ekranie sesji albo u dołu kolumny")
struct ToastLifecycleTests {
  /// Sterowane czekanie: każde odliczanie dymka czeka, aż test je zwolni.
  final class Waits: @unchecked Sendable {
    private let lock = NSLock()
    private var pending: [CheckedContinuation<Void, Never>] = []
    private(set) var durations: [Duration] = []

    var wait: @Sendable (Duration) async -> Void {
      { [self] duration in
        await withCheckedContinuation { continuation in
          lock.withLock {
            durations.append(duration)
            pending.append(continuation)
          }
        }
      }
    }

    var count: Int { lock.withLock { pending.count } }

    func release(_ index: Int) {
      let continuation = lock.withLock { pending[index] }
      continuation.resume()
    }
  }

  final class Said {
    var lines: [String] = []
  }

  private func state() -> AppState {
    var state = Sample.state(session: Sample.session(id: "s1", state: "waiting-permission"))
    state.sessions["s2"] = Sample.session(id: "s2", title: "rarog", label: nil)
    return state
  }

  private func signal(_ sessionId: String, _ kind: SessionSignal.Kind, serial: Int = 1) -> SessionSignal {
    SessionSignal(sessionId: sessionId, kind: kind, serial: serial)
  }

  /// Czeka, aż odliczania (zadania na głównym aktorze) dojdą do czekania albo do końca.
  private func settle(_ condition: () -> Bool) async {
    for _ in 0..<200 where !condition() {
      try? await Task.sleep(for: .milliseconds(2))
    }
  }

  @Test("dymek mówi raz przy pojawieniu i gaśnie sam po `hold`, w każdym osadzeniu")
  func expiresAndAnnounces() async throws {
    let waits = Waits()
    let said = Said()
    let announcer = Announcer(sink: { said.lines.append($0.text) }, now: Date.init)
    let toasts = ToastCenter(announcer: announcer, wait: waits.wait)
    toasts.offer(signal("s1", .permission), state: state(), viewing: "s2")
    let toast = try #require(toasts.current)
    #expect(said.lines == [toast.text], "czytnik słyszy dymek raz, w chwili pojawienia")
    await settle { waits.count == 1 }
    #expect(waits.durations == [ToastCenter.hold])
    waits.release(0)
    await settle { toasts.current == nil }
    #expect(toasts.current == nil, "po 6 s dymek gaśnie bez widoku")
  }

  @Test("nowszy dymek zastępuje starszy; zegar starszego go nie zdejmuje, jego własny tak")
  func replacement() async throws {
    let waits = Waits()
    let toasts = ToastCenter(announcer: Announcer(sink: { _ in }, now: Date.init), wait: waits.wait)
    toasts.offer(signal("s1", .error), state: state(), viewing: "s2")
    toasts.notice("Powiadomienia działają")
    let newer = try #require(toasts.current)
    await settle { waits.count == 2 }
    waits.release(0)
    try await Task.sleep(for: .milliseconds(20))
    #expect(toasts.current == newer, "zegar starszego dymka nie zdejmuje nowszego")
    waits.release(1)
    await settle { toasts.current == nil }
    #expect(toasts.current == nil)
  }

  @Test("dojście do sesji gasi dymek od razu, a spóźniony zegar niczego nie rusza")
  func reachedCancels() async throws {
    let waits = Waits()
    let toasts = ToastCenter(announcer: Announcer(sink: { _ in }, now: Date.init), wait: waits.wait)
    toasts.offer(signal("s1", .limit), state: state(), viewing: "s2")
    await settle { waits.count == 1 }
    toasts.reached("s1")
    #expect(toasts.current == nil)
    toasts.notice("Kolejny komunikat")
    let next = try #require(toasts.current)
    waits.release(0)
    try await Task.sleep(for: .milliseconds(20))
    #expect(toasts.current == next, "zegar zgaszonego dymka nie zdejmuje następnego")
  }

  @Test("komunikat z akcją: segment wykonuje akcję raz i gasi dymek; zgaszony albo zastąpiony dymek nic nie wykonuje")
  func action() async throws {
    let said = Said()
    let toasts = ToastCenter(
      announcer: Announcer(sink: { said.lines.append($0.text) }, now: Date.init), wait: Waits().wait)
    var undone = 0
    let undo = ToastAction(label: "Cofnij", identifier: "toast.note.undo")
    toasts.notice("Usunięto notatkę projektu rarog", action: undo) { undone += 1 }
    let toast = try #require(toasts.current)
    #expect(toast.action == undo && toast.sessionId == nil)
    #expect(said.lines == ["Usunięto notatkę projektu rarog. Cofnij"], "czytnik słyszy, że jest akcja")
    toasts.performAction(toast.id)
    toasts.performAction(toast.id)
    #expect(undone == 1 && toasts.current == nil, "akcja raz, dymek gaśnie")

    toasts.notice("Usunięto notatkę projektu rarog", action: undo) { undone += 1 }
    let replaced = try #require(toasts.current)
    toasts.notice("Powiadomienia działają")
    toasts.performAction(replaced.id)
    #expect(undone == 1, "dymek zastąpiony innym nie wykonuje akcji")
    toasts.performAction(try #require(toasts.current).id)
    #expect(undone == 1 && toasts.current != nil, "komunikat bez akcji nie gaśnie od segmentu, którego nie ma")
    toasts.notice("Bez domknięcia", action: undo)
    #expect(toasts.current?.action == nil, "akcja bez domknięcia nie staje — nigdy martwy przycisk")
  }

  @Test("dymek z akcją przy VoiceOver stoi 10 s, bez VoiceOver i bez akcji — 6 s")
  func actionHold() async throws {
    let waits = Waits()
    var voiceOver = true
    let toasts = ToastCenter(
      announcer: Announcer(sink: { _ in }, now: Date.init), wait: waits.wait, voiceOver: { voiceOver })
    let open = ToastAction(label: "Otwórz", identifier: "toast.note.open")
    toasts.notice("Notatka projektu rarog nie zapisana", action: open) {}
    await settle { waits.count == 1 }
    toasts.notice("Komunikat bez akcji")
    await settle { waits.count == 2 }
    voiceOver = false
    toasts.notice("Notatka projektu rarog nie zapisana", action: open) {}
    await settle { waits.count == 3 }
    #expect(waits.durations == [ToastCenter.actionHoldVoiceOver, ToastCenter.hold, ToastCenter.hold])
  }

  @Test("potwierdzenie (kopia w terminalu): stoi `hold` sekund, wariant „potwierdzenie”, czytnik słyszy je raz")
  func confirmationHold() async throws {
    let waits = Waits()
    let said = Said()
    let toasts = ToastCenter(announcer: Announcer(sink: { said.lines.append($0.text) }, now: Date.init), wait: waits.wait)
    toasts.notice("Skopiowano do schowka.", hold: 2)
    let toast = try #require(toasts.current)
    #expect(toast.style == .confirmation && toast.sessionId == nil && toast.action == nil)
    #expect(said.lines == ["Skopiowano do schowka."])
    await settle { waits.count == 1 }
    #expect(waits.durations == [.seconds(2)], "krótsze niż 6 s zwykłego dymka")
    waits.release(0)
    await settle { toasts.current == nil }
    #expect(toasts.current == nil)
    toasts.notice("Powiadomienia działają")
    #expect(toasts.current?.style == .standard, "zwykły komunikat apki bez zmian")
  }

  @Test("dymek o sesji stoi: potwierdzenie go nie wypiera, jego zegar ani czytnik go nie ruszają")
  func confirmationKeepsSessionToast() async throws {
    let waits = Waits()
    let said = Said()
    let toasts = ToastCenter(announcer: Announcer(sink: { said.lines.append($0.text) }, now: Date.init), wait: waits.wait)
    toasts.offer(signal("s1", .permission), state: state(), viewing: "s2")
    let session = try #require(toasts.current)
    toasts.notice("Skopiowano do schowka.", hold: 2)
    #expect(toasts.current == session, "dymek o sesji zostaje")
    #expect(said.lines == [session.text, "Skopiowano do schowka."], "czytnik i tak słyszy wynik kopii")
    await settle { waits.count == 1 }
    #expect(waits.durations == [ToastCenter.hold], "potwierdzenie nie stawia własnego zegara")
  }

  @Test("osadzenie: otwarte okno terminala Cmd+F/Cmd+G ma dymek u siebie, kolumna pod arkuszem milczy")
  func placementTerminalWindow() {
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.selectSession("s1")
    navigation.sheet = .terminal(TerminalPopupRequest(cwd: "/Users/demo/Projects/willow", role: .popup), token: UUID())
    #expect(ToastPlacement.resolve(navigation: navigation, state: state()) == .terminalWindow)
    navigation.sheet = .terminal(TerminalPopupRequest(cwd: "/Users/demo/Projects/willow", role: .lazygit), token: UUID())
    #expect(ToastPlacement.resolve(navigation: navigation, state: state()) == .terminalWindow, "lazygit tak samo")
    navigation.sheet = nil
    #expect(ToastPlacement.resolve(navigation: navigation, state: state()) == .sessionScreen, "okno zamknięte")
    // Zmiana ekranu zamyka okno, więc najpierw trasa terminala, potem okno nad nią.
    navigation.detail = .terminal("t1")
    navigation.sheet = .terminal(TerminalPopupRequest(cwd: "/Users/demo/Projects/willow", role: .popup), token: UUID())
    #expect(ToastPlacement.resolve(navigation: navigation, state: state()) == .terminalWindow, "także nad trasą terminala")
  }

  @Test("osadzenie: ekran sesji z transkryptem ma dymek u siebie; Codex, projekt, terminal i pusta kolumna — nakładka")
  func placement() {
    var state = state()
    state.sessions["c"] = Sample.session(id: "c", title: "inne", label: nil, extra: #""engine":"codex""#)
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    #expect(ToastPlacement.resolve(navigation: navigation, state: state) == .overlay, "pusta kolumna")
    navigation.selectSession("s1")
    #expect(ToastPlacement.resolve(navigation: navigation, state: state) == .sessionScreen, "ekran sesji")
    navigation.selectSession("c")
    #expect(ToastPlacement.resolve(navigation: navigation, state: state) == .overlay, "wpis Codexa bez transkryptu")
    navigation.selectSession("zniknęła")
    #expect(ToastPlacement.resolve(navigation: navigation, state: state) == .overlay, "sesji nie ma na liście")
    navigation.detail = .project("/Users/demo/Projects/willow")
    #expect(ToastPlacement.resolve(navigation: navigation, state: state) == .overlay, "ekran projektu")
    navigation.detail = .terminal("t1")
    #expect(ToastPlacement.resolve(navigation: navigation, state: state) == .overlay, "terminal")
  }
}
