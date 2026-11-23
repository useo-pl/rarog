import Observation
import RarogContract
import RarogCore
import RarogTransport
@testable import RarogUI
import UIKit
import XCTest

/// Parking ekranów terminala w oknie UIKit: kontener taba
/// (`TerminalScreenHolder`) i okno Cmd+F/Cmd+G (`TerminalPopupController`) oddają ekran do parkingu i biorą go
/// z powrotem — ta sama sesja, to samo gniazdo, bez drugiego `POST`. Dismantle SwiftUI udaje test: zdjęcie z okna
/// i `dismantle()`. Atrapy drutu i powierzchni z `TerminalScreenTests`, treść syntetyczna. Księgę
/// (zajęty klucz, sufit, wygaśnięcie, numer wpisu) liczy `TerminalParkingLedgerTests` na macOS.
@MainActor
final class TerminalParkingTests: XCTestCase {
  private static let cwd = "/Users/demo/Projects/rarog"
  private static let otherId = "fedcba9876543210"

  /// Zegar postoju i śladu: stoi, dopóki test go nie przesunie.
  private final class Ticks {
    let origin = ContinuousClock.now
    var elapsed: Duration = .zero
    var now: ContinuousClock.Instant { origin + elapsed }
  }

  @Observable
  fileprivate final class Auth {
    var loggedIn = true
  }

  /// Sen zegara wygaszenia: czeka, aż test go obudzi.
  @MainActor
  private final class Sleeper {
    private var waiting: [CheckedContinuation<Void, Never>] = []
    var count: Int { waiting.count }

    func wait() async { await withCheckedContinuation { waiting.append($0) } }

    func wakeAll() {
      let woken = waiting
      waiting.removeAll()
      woken.forEach { $0.resume() }
    }
  }

  private final class Box<Value> {
    var value: Value
    init(_ value: Value) { self.value = value }
  }

  private struct Rig {
    let parking: TerminalScreenParking
    let auth: Auth
    let ticks: Ticks
    let sleeper: Sleeper
    let sceneActive: Box<Bool>
    let lines: Box<[String]>
    let window: UIWindow
  }

  private func rig() -> Rig {
    let auth = Auth()
    let ticks = Ticks()
    let sleeper = Sleeper()
    let sceneActive = Box(true)
    let parking = TerminalScreenParking(
      isLoggedIn: { auth.loggedIn },
      observeAuth: { onChange in withObservationTracking { _ = auth.loggedIn } onChange: { onChange() } },
      sceneActive: { sceneActive.value }, clock: { ticks.now }, sleep: { [sleeper] _ in await sleeper.wait() })
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 900, height: 700))
    window.makeKeyAndVisible()
    addTeardownBlock { @MainActor in
      parking.shutdownAll()
      sleeper.wakeAll()
      window.isHidden = true
    }
    return Rig(
      parking: parking, auth: auth, ticks: ticks, sleeper: sleeper, sceneActive: sceneActive, lines: Box([]),
      window: window)
  }

  /// Ekran na atrapie drutu, z zegarem i śladem rigu.
  private func screen(
    _ rig: Rig, wire: FakeWire, transport: (any TerminalTransporting)? = nil, target: TerminalTarget
  ) -> TerminalScreenViewController {
    let session = TerminalSession(
      target: target, transport: transport ?? wire, timing: TerminalTiming(backoff: [.milliseconds(20)]),
      clock: { rig.ticks.now })
    let screen = TerminalScreenViewController(session: session, surface: FakeSurface()) { id in
      wire.closed.append(id)
      return wire.closeOutcome
    }
    screen.hardwareKeyboard = { true }
    screen.sceneIsActive = { true }
    screen.settleDelay = .milliseconds(60)
    screen.firstScreenWindow = .milliseconds(40)
    screen.announcer = Announcer(sink: { _ in }, now: Date.init)
    screen.clock = { rig.ticks.now }
    screen.trace = { rig.lines.value.append($0) }
    screen.admitOpenTrace = { _ in true }
    addTeardownBlock { @MainActor in screen.shutdown() }
    return screen
  }

  private func waitUntil(_ condition: () -> Bool) async {
    for _ in 0..<300 where !condition() {
      try? await Task.sleep(for: .milliseconds(10))
    }
  }

  /// Gniazdo `index` drutu otwarte → sesja `live`.
  private func open(_ wire: FakeWire, _ session: TerminalSession, socket index: Int = 0) async throws -> RecordingSocket {
    await waitUntil { wire.sockets.count > index }
    let socket = try XCTUnwrap(wire.sockets.count > index ? wire.sockets[index] : nil)
    socket.emit(.opened)
    await waitUntil { session.phase == .live }
    XCTAssertEqual(session.phase, .live)
    return socket
  }

  private func inputs(_ socket: RecordingSocket) -> [String] {
    socket.sent.compactMap { if case let .input(text) = $0 { text } else { nil } }
  }

  private func hasPaste(_ socket: RecordingSocket) -> Bool {
    socket.sent.contains { if case .paste = $0 { true } else { false } }
  }

  private func hasScroll(_ socket: RecordingSocket) -> Bool {
    socket.sent.contains { if case .scroll = $0 { true } else { false } }
  }

  // MARK: - Tab

  private func holder(
    _ rig: Rig, wire: FakeWire, target: TerminalTarget, built: Box<[TerminalScreenViewController]> = Box([])
  ) throws -> TerminalScreenHolder {
    let holder = TerminalScreenHolder.make(target: target, parking: rig.parking) {
      let screen = self.screen(rig, wire: wire, target: target)
      built.value.append(screen)
      return screen
    }
    return try XCTUnwrap(holder)
  }

  private func show(_ controller: UIViewController, in rig: Rig) {
    rig.window.rootViewController = controller
    controller.view.layoutIfNeeded()
  }

  /// Zejście z taba: kontener zdjęty z okna, potem dismantle SwiftUI.
  private func leave(_ holder: TerminalScreenHolder, in rig: Rig) {
    rig.window.rootViewController = UIViewController()
    holder.dismantle()
  }

  /// Powrót do taba w ciągu 2 min: TEN SAM ekran i TA SAMA sesja, bez drugiego gniazda; ślad „z parkingu"; pisanie,
  /// wklejka, przewijanie i „×" z paska nawigacji działają u nowego właściciela, a stary pasek jest odpięty.
  func testTabReturnTakesSameScreenAndSocket() async throws {
    let rig = rig()
    let wire = FakeWire()
    let target = try XCTUnwrap(TerminalTarget.id(FakeWire.id))
    let built = Box<[TerminalScreenViewController]>([])
    let first = try holder(rig, wire: wire, target: target, built: built)
    let screen = try XCTUnwrap(first.heldScreen)
    let oldChrome = TerminalChrome()
    screen.chrome = oldChrome
    show(first, in: rig)
    let socket = try await open(wire, screen.session)

    leave(first, in: rig)
    XCTAssertNil(screen.parent, "ekran wyjęty z kontenera")
    XCTAssertFalse(oldChrome.isAttached, "przyciski starego paska odpięte")
    XCTAssertTrue(screen.inputSuspended, "w parkingu nic nie wychodzi")
    XCTAssertEqual(rig.parking.count, 1)
    XCTAssertEqual(screen.session.phase, .live, "gniazdo żyje w parkingu")

    rig.ticks.elapsed += .seconds(34)
    let second = try holder(rig, wire: wire, target: target, built: built)
    XCTAssertTrue(second.heldScreen === screen, "ten sam ekran")
    XCTAssertEqual(built.value.count, 1, "nowego ekranu nie było")
    var closed = 0
    screen.onClose = { closed += 1 }
    let chrome = TerminalChrome()
    screen.chrome = chrome
    show(second, in: rig)
    XCTAssertEqual(rig.parking.count, 0)
    XCTAssertEqual(rig.lines.value, ["terminal: ekran z parkingu po 34 s (gniazdo żywe)"])
    try await Task.sleep(for: .milliseconds(80))
    XCTAssertEqual(wire.sockets.count, 1, "bez drugiego gniazda")
    XCTAssertEqual(wire.connects.count, 1, "bez drugiego upgrade'u")
    XCTAssertFalse(screen.inputSuspended)

    screen.sendInput("x")
    screen.surface.onPaste?("wklejka")
    screen.surface.onScroll?(3, nil)
    await waitUntil { !self.inputs(socket).isEmpty && self.hasPaste(socket) && self.hasScroll(socket) }
    XCTAssertEqual(inputs(socket), ["x"], "pisanie")
    XCTAssertTrue(hasPaste(socket), "wklejka")
    XCTAssertTrue(hasScroll(socket), "przewijanie")
    XCTAssertTrue(chrome.isAttached, "„×” i „⋯” nowego paska")
    chrome.tapClose()
    chrome.tapClose()
    await waitUntil { closed == 1 }
    XCTAssertEqual(wire.closed, [FakeWire.id], "„×” zamyka powłokę")
    XCTAssertEqual(closed, 1)
  }

  /// „Nowy terminal" przed odpowiedzią `POST` (ekran nie zna id): zejście kończy ekran, parking go nie bierze.
  func testTabWithoutIdShutsDown() async throws {
    let rig = rig()
    let wire = FakeWire()
    wire.holdOpen = true
    let target = try XCTUnwrap(TerminalTarget.newShell(cwd: Self.cwd))
    let first = try holder(rig, wire: wire, target: target)
    let screen = try XCTUnwrap(first.heldScreen)
    show(first, in: rig)
    await waitUntil { wire.opens.count == 1 }
    XCTAssertNil(screen.terminalId)
    leave(first, in: rig)
    XCTAssertTrue(screen.isShutDown, "bez id — koniec od razu")
    XCTAssertEqual(rig.parking.count, 0)
    wire.releaseOpen()
  }

  /// Ekran z rodzicem stoi już gdzie indziej: parking go nie wydaje i nie kończy; tab buduje nowy ekran.
  func testScreenWithParentIsNotTaken() async throws {
    let rig = rig()
    let wire = FakeWire()
    let target = try XCTUnwrap(TerminalTarget.id(FakeWire.id))
    let first = try holder(rig, wire: wire, target: target)
    let screen = try XCTUnwrap(first.heldScreen)
    show(first, in: rig)
    _ = try await open(wire, screen.session)
    leave(first, in: rig)
    let stranger = UIViewController()
    stranger.addChild(screen)
    defer { screen.removeFromParent() }
    let built = Box<[TerminalScreenViewController]>([])
    let second = try holder(rig, wire: wire, target: target, built: built)
    XCTAssertFalse(second.heldScreen === screen)
    XCTAssertEqual(built.value.count, 1, "nowy ekran")
    XCTAssertFalse(screen.isShutDown, "cudzego ekranu parking nie kończy")
  }

  /// Ekran przeniesiony na inny id w parkingu: tab pod starym id go nie bierze (koniec i nowy ekran), a ekran
  /// aktywowany po parkingu zgłasza nowemu właścicielowi BIEŻĄCY id — także gdy zapamiętał go już bez wywołania.
  func testRetargetWhileParkedReachesNewOwner() async throws {
    let rig = rig()
    let wire = FakeWire()
    let transport = RetargetingWire(base: wire)
    let target = try XCTUnwrap(TerminalTarget.shell(cwd: Self.cwd))
    let parked = screen(rig, wire: wire, transport: transport, target: target)
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 800, height: 600))
    window.rootViewController = parked
    window.makeKeyAndVisible()
    defer { window.isHidden = true }
    let first = try await open(wire, parked.session)
    XCTAssertEqual(parked.terminalId, FakeWire.id)
    window.rootViewController = UIViewController()
    parked.park()

    transport.forcedId = Self.otherId
    first.drop()
    await waitUntil { parked.terminalId == Self.otherId }
    try await Task.sleep(for: .milliseconds(50))  // obserwacja sesji zapamiętała id bez wywołania
    var ids: [String] = []
    parked.onTerminalIdentified = { ids.append($0) }
    parked.activate(parkedFor: .seconds(5), resumesInput: true)
    XCTAssertEqual(ids, [Self.otherId], "nawigacja dostaje id po przeniesieniu")

    // Tab pod starym id nie bierze ekranu, który jest już innym terminalem.
    let tab = try XCTUnwrap(TerminalTarget.id(FakeWire.id))
    rig.parking.park(parked, under: .terminal(FakeWire.id))
    let built = Box<[TerminalScreenViewController]>([])
    let holder = try holder(rig, wire: wire, target: tab, built: built)
    XCTAssertFalse(holder.heldScreen === parked)
    XCTAssertTrue(parked.isShutDown, "przeniesiony ekran kończy się")
    XCTAssertEqual(built.value.count, 1)
  }

  /// Ekran w parkingu milczy dla czytnika: błąd ukrytego terminala (np. przejęcie przez drugie urządzenie) nie
  /// przerywa człowieka, który patrzy gdzie indziej. Na ekranie ten sam stan się słyszy.
  func testParkedScreenIsSilentForVoiceOver() async throws {
    let rig = rig()
    let wire = FakeWire()
    let target = try XCTUnwrap(TerminalTarget.id(FakeWire.id))
    let spoken = Box<[String]>([])
    let first = try holder(rig, wire: wire, target: target)
    let screen = try XCTUnwrap(first.heldScreen)
    screen.announcer = Announcer(sink: { spoken.value.append($0.text) }, now: Date.init)
    show(first, in: rig)
    let socket = try await open(wire, screen.session)
    leave(first, in: rig)
    socket.emit(.frame(.error(message: "Terminal przejął inny kontroler.")))
    await waitUntil { screen.session.phase.isHalted }
    try await Task.sleep(for: .milliseconds(50))
    XCTAssertTrue(spoken.value.isEmpty, "w parkingu bez ogłoszeń: \(spoken.value)")

    let visible = try holder(rig, wire: wire, target: target)
    let other = try XCTUnwrap(visible.heldScreen)
    XCTAssertFalse(other === screen, "ekran z błędem nie wraca")
    other.announcer = Announcer(sink: { spoken.value.append($0.text) }, now: Date.init)
    show(visible, in: rig)
    let second = try await open(wire, other.session, socket: 1)
    second.emit(.frame(.error(message: "Terminal przejął inny kontroler.")))
    await waitUntil { !spoken.value.isEmpty }
    XCTAssertEqual(spoken.value, ["Terminal przejął inny kontroler."], "na ekranie czytnik słyszy błąd")
  }

  /// Sufit 4: piąty zaparkowany ekran kończy najstarszy.
  func testFifthParkedScreenEvictsOldest() throws {
    let rig = rig()
    let wire = FakeWire()
    let screens = try (1...5).map { index in
      let id = String(format: "%016x", index)
      let screen = self.screen(rig, wire: wire, target: try XCTUnwrap(TerminalTarget.id(id)))
      screen.loadViewIfNeeded()
      screen.session.start()
      return (id, screen)
    }
    for (index, (id, screen)) in screens.enumerated() {
      rig.ticks.elapsed += .seconds(1)
      rig.parking.park(screen, under: .terminal(id))
      XCTAssertEqual(rig.parking.count, min(index + 1, TerminalParkingLedger.capacity))
    }
    XCTAssertTrue(screens[0].1.isShutDown, "najstarszy wypadł")
    XCTAssertTrue(screens.dropFirst().allSatisfy { !$0.1.isShutDown })
  }

  /// Po 2 min zegar wygaszenia kończy ekran: gniazdo zamknięte, renderer zwolniony.
  func testExpiryShutsScreenDown() async throws {
    let rig = rig()
    let wire = FakeWire()
    let target = try XCTUnwrap(TerminalTarget.id(FakeWire.id))
    let first = try holder(rig, wire: wire, target: target)
    let screen = try XCTUnwrap(first.heldScreen)
    show(first, in: rig)
    _ = try await open(wire, screen.session)
    leave(first, in: rig)
    await waitUntil { rig.sleeper.count == 1 }
    XCTAssertEqual(rig.sleeper.count, 1, "zegar wygaszenia czeka")
    rig.ticks.elapsed += TerminalParkingLedger.lifetime
    rig.sleeper.wakeAll()
    await waitUntil { screen.isShutDown }
    XCTAssertTrue(screen.isShutDown)
    XCTAssertEqual(screen.session.phase, .idle, "gniazdo zamknięte")
    XCTAssertEqual((screen.surface as? FakeSurface)?.log.last, "close", "renderer zwolniony")
    XCTAssertEqual(rig.parking.count, 0)
  }

  /// Tło sceny kończy zaparkowane ekrany; dismantle spóźniony po tle (scena nieaktywna) parkingu nie odtwarza.
  func testBackgroundShutsParkedScreensInBothOrders() async throws {
    let rig = rig()
    let wire = FakeWire()
    let target = try XCTUnwrap(TerminalTarget.id(FakeWire.id))
    let first = try holder(rig, wire: wire, target: target)
    let parked = try XCTUnwrap(first.heldScreen)
    show(first, in: rig)
    _ = try await open(wire, parked.session)
    leave(first, in: rig)
    XCTAssertEqual(rig.parking.count, 1)
    NotificationCenter.default.post(name: UIScene.didEnterBackgroundNotification, object: nil)
    await waitUntil { parked.isShutDown }
    XCTAssertTrue(parked.isShutDown, "park → tło")
    XCTAssertEqual(rig.parking.count, 0)

    let second = try holder(rig, wire: wire, target: target)
    let late = try XCTUnwrap(second.heldScreen)
    show(second, in: rig)
    _ = try await open(wire, late.session, socket: 1)
    rig.sceneActive.value = false
    leave(second, in: rig)
    XCTAssertTrue(late.isShutDown, "tło → spóźniony dismantle")
    XCTAssertEqual(rig.parking.count, 0)
  }

  /// Wylogowanie kończy zaparkowane ekrany (obserwacja zalogowania); dismantle po wylogowaniu parkingu nie odtwarza.
  func testLogoutShutsParkedScreensInBothOrders() async throws {
    let rig = rig()
    let wire = FakeWire()
    let target = try XCTUnwrap(TerminalTarget.id(FakeWire.id))
    let first = try holder(rig, wire: wire, target: target)
    let parked = try XCTUnwrap(first.heldScreen)
    show(first, in: rig)
    _ = try await open(wire, parked.session)
    leave(first, in: rig)
    XCTAssertEqual(rig.parking.count, 1)
    rig.auth.loggedIn = false
    await waitUntil { parked.isShutDown }
    XCTAssertTrue(parked.isShutDown, "park → wylogowanie")
    XCTAssertEqual(rig.parking.count, 0)

    rig.auth.loggedIn = true
    let second = try holder(rig, wire: wire, target: target)
    let late = try XCTUnwrap(second.heldScreen)
    show(second, in: rig)
    _ = try await open(wire, late.session, socket: 1)
    rig.auth.loggedIn = false
    leave(second, in: rig)
    XCTAssertTrue(late.isShutDown, "wylogowanie → spóźniony dismantle")
    XCTAssertEqual(rig.parking.count, 0)
  }

  // MARK: - Okno Cmd+F/Cmd+G

  private final class Counter {
    var value = 0
  }

  private func popup(
    _ rig: Rig, wire: FakeWire, role: TerminalRole = .popup, dismissals: Counter,
    built: Box<[TerminalScreenViewController]> = Box([]), listed: () -> TerminalListEntry? = { nil }
  ) throws -> TerminalPopupController {
    let request = TerminalPopupRequest(cwd: Self.cwd, role: role)
    let popup = TerminalPopupController.make(request: request, parking: rig.parking, listed: listed) { target in
      let screen = self.screen(rig, wire: wire, target: target)
      built.value.append(screen)
      return screen
    }
    let made = try XCTUnwrap(popup)
    made.onDismiss = { dismissals.value += 1 }
    return made
  }

  private func show(_ popup: TerminalPopupController, in rig: Rig) {
    let navigation = TerminalPopupController.window(popup)
    rig.window.rootViewController = navigation
    navigation.view.layoutIfNeeded()
  }

  /// Zamknięcie okna: arkusz zdjęty z okna, potem dismantle SwiftUI.
  private func close(_ popup: TerminalPopupController, in rig: Rig) {
    rig.window.rootViewController = UIViewController()
    popup.dismantle()
  }

  /// Ponowne Cmd+F w ciągu 2 min: NOWE okno wokół tego samego ekranu i sesji, bez drugiego `POST` i gniazda; po
  /// przeniesieniu pisanie, wklejka i przewijanie idą do programu, a spóźnione zdarzenia starego okna ekranu nie
  /// ruszają.
  func testPopupReopenTakesSameScreenAndIgnoresOldWindow() async throws {
    let rig = rig()
    let wire = FakeWire()
    let oldDismissals = Counter()
    let built = Box<[TerminalScreenViewController]>([])
    let old = try popup(rig, wire: wire, dismissals: oldDismissals, built: built)
    show(old, in: rig)
    let socket = try await open(wire, old.screen.session)
    close(old, in: rig)
    XCTAssertNil(old.screen.parent)
    XCTAssertFalse(old.holdsScreen)
    XCTAssertEqual(rig.parking.count, 1)

    rig.ticks.elapsed += .seconds(3)
    let dismissals = Counter()
    let new = try popup(rig, wire: wire, dismissals: dismissals, built: built)
    XCTAssertTrue(new.screen === old.screen, "ten sam ekran")
    XCTAssertEqual(built.value.count, 1)
    show(new, in: rig)
    await waitUntil { !new.screen.inputSuspended }
    XCTAssertTrue(new.holdsScreen)
    XCTAssertEqual(rig.lines.value, ["terminal: ekran z parkingu po 3 s (gniazdo żywe)"])
    try await Task.sleep(for: .milliseconds(80))
    XCTAssertEqual(wire.opens.count, 1, "bez drugiego `POST`")
    XCTAssertEqual(wire.sockets.count, 1, "bez drugiego gniazda")

    // Spóźnione zdarzenia starego okna: wejście zostaje, Esc nie zamyka niczego i nie idzie do programu.
    old.viewWillDisappear(false)
    old.escapePressed()
    XCTAssertFalse(new.screen.inputSuspended, "stare okno nie wstrzymuje wejścia nowego")
    XCTAssertEqual(oldDismissals.value, 0)
    XCTAssertEqual(dismissals.value, 0)

    new.screen.sendInput("x")
    new.screen.surface.onPaste?("wklejka")
    new.screen.surface.onScroll?(3, nil)
    await waitUntil { !self.inputs(socket).isEmpty && self.hasPaste(socket) && self.hasScroll(socket) }
    XCTAssertEqual(inputs(socket), ["x"], "pisanie (Esc starego okna nie doszedł)")
    XCTAssertTrue(hasPaste(socket))
    XCTAssertTrue(hasScroll(socket))
    // Esc w nowym oknie powłoki zamyka JE.
    new.escapePressed()
    XCTAssertEqual(dismissals.value, 1)
    XCTAssertEqual(oldDismissals.value, 0)
  }

  /// Wpis listy terminali (`GET /api/term`) dla okna tego katalogu.
  private static func entry(role: TerminalRole, cwd: String = TerminalParkingTests.cwd) throws -> TerminalListEntry {
    let json = #"{"id":"\#(FakeWire.id)","cwd":"\#(cwd)","live":true,"slot":0,"proc":"zsh","role":"\#(role.rawValue)"}"#
    return try JSONDecoder().decode(TerminalListEntry.self, from: Data(json.utf8))
  }

  /// Cmd+F, gdy lista zna panel `popup` tego katalogu: NOWY ekran bierze cel z listy i łączy się gniazdem bez `POST`;
  /// ekran z parkingu listy nie pyta. Cmd+G z wpisem lazygita na liście — dalej `POST`.
  func testNewPopupScreenUsesListedEntry() async throws {
    let rig = rig()
    let wire = FakeWire()
    let listed = try Self.entry(role: .popup, cwd: Self.cwd + "/")
    var asked = 0
    let first = try popup(rig, wire: wire, dismissals: Counter(), listed: {
      asked += 1
      return listed
    })
    XCTAssertEqual(asked, 1)
    XCTAssertEqual(first.screen.session.terminalId, FakeWire.id, "cel z listy: id znane przed połączeniem")
    show(first, in: rig)
    _ = try await open(wire, first.screen.session)
    XCTAssertEqual(wire.opens.count, 0, "bez `POST`")
    XCTAssertEqual(wire.connects.map(\.direct), [true])
    close(first, in: rig)
    let again = try popup(rig, wire: wire, dismissals: Counter(), listed: {
      asked += 1
      return listed
    })
    XCTAssertTrue(again.screen === first.screen, "ekran z parkingu")
    XCTAssertEqual(asked, 1, "ekran z parkingu: cel nieliczony")
    XCTAssertEqual(wire.connects.count, 1)

    let lazyWire = FakeWire()
    let lazy = try popup(rig, wire: lazyWire, role: .lazygit, dismissals: Counter(), listed: {
      try? Self.entry(role: .lazygit)
    })
    show(lazy, in: rig)
    _ = try await open(lazyWire, lazy.screen.session)
    XCTAssertEqual(lazyWire.opens.map(\.role), [.lazygit], "lazygit przez `POST`")
    XCTAssertEqual(lazyWire.connects.map(\.direct), [false])

    // Wpis innej roli albo innego katalogu nie jest celem okna.
    let request = TerminalPopupRequest(cwd: Self.cwd, role: .popup)
    let elsewhere = try Self.entry(role: .popup, cwd: "/Users/demo/inny")
    XCTAssertNil(TerminalPopupController.target(for: request, listed: elsewhere)?.id)
    XCTAssertNil(TerminalPopupController.target(for: request, listed: try Self.entry(role: .lazygit))?.id)
    XCTAssertNil(TerminalPopupController.target(for: request, listed: nil)?.id)
  }

  /// `exit` w zaparkowanym oknie: nie woła `onClose` starego okna (ani żadnego), a ponowne Cmd+F buduje nowy ekran
  /// z nowym `POST` i gniazdem.
  func testExitInParkedPopupClosesNothingAndReopenBuildsNew() async throws {
    let rig = rig()
    let wire = FakeWire()
    let oldDismissals = Counter()
    let built = Box<[TerminalScreenViewController]>([])
    let old = try popup(rig, wire: wire, dismissals: oldDismissals, built: built)
    show(old, in: rig)
    let socket = try await open(wire, old.screen.session)
    close(old, in: rig)
    socket.emit(.frame(.exit))
    await waitUntil { old.screen.isShutDown }
    XCTAssertTrue(old.screen.isShutDown)
    XCTAssertEqual(oldDismissals.value, 0, "`exit` w parkingu nie zamyka cudzego okna")

    let dismissals = Counter()
    let new = try popup(rig, wire: wire, dismissals: dismissals, built: built)
    XCTAssertFalse(new.screen === old.screen, "zakończony ekran nie wraca")
    XCTAssertEqual(built.value.count, 2)
    show(new, in: rig)
    _ = try await open(wire, new.screen.session, socket: 1)
    XCTAssertEqual(wire.opens.count, 2, "nowy ekran: `POST`")
    XCTAssertEqual(dismissals.value, 0)
  }

  /// `exit` po wyjęciu z parkingu, a przed podpięciem nowego okna: zamyka nowe okno, gdy ono stanie, a stare nie.
  func testExitBeforeNewWindowIsWiredClosesNewWindow() async throws {
    let rig = rig()
    let wire = FakeWire()
    let oldDismissals = Counter()
    let old = try popup(rig, wire: wire, dismissals: oldDismissals)
    show(old, in: rig)
    let socket = try await open(wire, old.screen.session)
    close(old, in: rig)
    let dismissals = Counter()
    let new = try popup(rig, wire: wire, dismissals: dismissals)
    XCTAssertTrue(new.screen === old.screen)
    socket.emit(.frame(.exit))
    await waitUntil { new.screen.isShutDown }
    XCTAssertEqual(dismissals.value, 0, "okno jeszcze nie podpięte")
    show(new, in: rig)
    await waitUntil { dismissals.value > 0 }
    XCTAssertEqual(dismissals.value, 1, "`exit` zamyka okno, które wzięło ekran")
    XCTAssertEqual(oldDismissals.value, 0)
    XCTAssertTrue(rig.lines.value.isEmpty, "zakończony ekran to nie powrót z parkingu")
  }

  /// Okno zamknięte ze stroną historii na stosie: nowe okno wraca do terminala na wierzchu, wejście idzie do programu.
  func testPopupClosedWithHistoryOnStack() async throws {
    let rig = rig()
    let wire = FakeWire()
    let old = try popup(rig, wire: wire, role: .lazygit, dismissals: Counter())
    show(old, in: rig)
    let socket = try await open(wire, old.screen.session)
    old.makeHistoryPage = { _, _ in UIViewController() }
    old.screen.handleHistory()
    let oldNavigation = try XCTUnwrap(old.navigationController)
    await waitUntil { oldNavigation.transitionCoordinator == nil && old.screen.inputSuspended }
    XCTAssertTrue(old.historyShown)
    close(old, in: rig)

    let new = try popup(rig, wire: wire, role: .lazygit, dismissals: Counter())
    XCTAssertTrue(new.screen === old.screen)
    new.makeHistoryPage = { _, _ in UIViewController() }
    show(new, in: rig)
    await waitUntil { !new.screen.inputSuspended }
    XCTAssertFalse(new.historyShown, "nowe okno bez strony historii")
    XCTAssertFalse(new.screen.takeEscape(), "Esc lazygita idzie do programu, nie do strony starego okna")
    new.screen.sendInput("q")
    await waitUntil { !self.inputs(socket).isEmpty }
    XCTAssertEqual(inputs(socket), ["q"])
    // Historia nowego okna wchodzi na JEGO stos.
    new.screen.handleHistory()
    XCTAssertEqual(new.navigationController?.viewControllers.count, 2)
    XCTAssertEqual(oldNavigation.viewControllers.count, 2, "stary stos bez zmian")
  }

  /// Drugie Cmd+F w trakcie zamykania okna, w obu kolejnościach SwiftUI: zostaje JEDNO gniazdo terminala.
  func testSecondCommandFWhileClosingKeepsOneSocket() async throws {
    // Dismantle starego przed make nowego: nowe okno bierze ten sam ekran.
    do {
      let rig = rig()
      let wire = FakeWire()
      let old = try popup(rig, wire: wire, dismissals: Counter())
      show(old, in: rig)
      _ = try await open(wire, old.screen.session)
      close(old, in: rig)
      let new = try popup(rig, wire: wire, dismissals: Counter())
      XCTAssertTrue(new.screen === old.screen, "dismantle → make: ten sam ekran")
      XCTAssertEqual(wire.sockets.count, 1)
    }
    // Make nowego przed dismantle starego: stary ekran stoi jeszcze w starym oknie, więc nowe buduje swój,
    // a stary — starszy od żywego ekranu pod tym kluczem — kończy się zamiast czekać w parkingu.
    do {
      let rig = rig()
      let wire = FakeWire()
      let old = try popup(rig, wire: wire, dismissals: Counter())
      show(old, in: rig)
      _ = try await open(wire, old.screen.session)
      let new = try popup(rig, wire: wire, dismissals: Counter())
      XCTAssertFalse(new.screen === old.screen, "make → dismantle: ekran z rodzicem nie wychodzi")
      close(old, in: rig)
      XCTAssertTrue(old.screen.isShutDown, "starszy ekran nie czeka obok nowego")
      XCTAssertEqual(old.screen.session.phase, .idle, "jego gniazdo zamknięte")
      XCTAssertEqual(rig.parking.count, 0)
      show(new, in: rig)
      _ = try await open(wire, new.screen.session, socket: 1)
      XCTAssertEqual(old.screen.session.phase, .idle, "żyje jedno gniazdo: nowego okna")
    }
    // Ostrzeżenie o pamięci między make nowego a dismantle starego: czyszczenie parkingu
    // nie zapomina, że pod kluczem stoi już nowszy ekran — starszy dalej kończy się zamiast czekać.
    do {
      let rig = rig()
      let wire = FakeWire()
      let old = try popup(rig, wire: wire, dismissals: Counter())
      show(old, in: rig)
      _ = try await open(wire, old.screen.session)
      let new = try popup(rig, wire: wire, dismissals: Counter())
      NotificationCenter.default.post(name: UIApplication.didReceiveMemoryWarningNotification, object: nil)
      try await Task.sleep(for: .milliseconds(50))
      XCTAssertFalse(new.screen.isShutDown, "ekran w drodze do okna to nie parking")
      close(old, in: rig)
      XCTAssertTrue(old.screen.isShutDown, "ostrzeżenie o pamięci → dismantle: starszy ekran nie czeka")
      XCTAssertEqual(rig.parking.count, 0)
    }
  }

  // MARK: - Zejście okna

  /// Korzeń prezentacji okna, który test „zamyka”: proces testów nie prowadzi przejść UIKit, a ekran pyta korzeń
  /// swoich rodziców o `isBeingDismissed` — w apce to arkusz SwiftUI w `dismiss`, także w trakcie przeciągania.
  private final class SheetHost: UIViewController {
    var closing = false
    override var isBeingDismissed: Bool { closing }
    /// `false` = przejście wyglądu prowadzi test, jak UIKit przy prezentacji: `viewWillAppear`, pierwszy układ
    /// (`viewIsAppearing`) na starcie animacji, `viewDidAppear` dopiero na jej końcu.
    var forwardsAppearance = true
    override var shouldAutomaticallyForwardAppearanceMethods: Bool { forwardsAppearance }
  }

  /// Okno w udawanym arkuszu: kontener nawigacji jako dziecko korzenia, 62 pt pod górą okna apki (arkusz telefonu).
  private func present(_ popup: TerminalPopupController, in rig: Rig) -> (SheetHost, UINavigationController) {
    let host = SheetHost()
    let navigation = TerminalPopupController.window(popup)
    rig.window.rootViewController = host
    host.addChild(navigation)
    navigation.view.frame = host.view.bounds.inset(by: UIEdgeInsets(top: 62, left: 0, bottom: 0, right: 0))
    host.view.addSubview(navigation.view)
    navigation.didMove(toParent: host)
    host.view.layoutIfNeeded()
    return (host, navigation)
  }

  /// Arkusz przeciągnięty od uchwytu: ramka kontenera nawigacji `distance` pt niżej (tak przesuwa go UIKit — ramką,
  /// nie transformacją) i układ.
  private func drag(_ navigation: UINavigationController, by distance: CGFloat) {
    navigation.view.frame.origin.y = 62 + distance
    navigation.view.superview?.layoutIfNeeded()
    navigation.view.layoutIfNeeded()
  }

  private func resizes(_ socket: RecordingSocket) -> [TerminalGrid] {
    socket.sent.compactMap { if case let .resize(grid) = $0 { grid } else { nil } }
  }

  /// Closing the window (iPhone 17 Pro simulator, iOS 27.0): the screen's keyboard layout guide stands in the app
  /// window's layout, so a sheet dragged down holds it ever higher inside. A grid that followed it would shrink every
  /// frame (56 → 24 rows), the settler would send `rs` of a smaller size and the screen would park with the smaller
  /// grid, so the next Cmd+F would lay out the full size with empty rows at the bottom until `rs` and a redraw. The
  /// grid stands through the whole descent, no `rs` goes out, and the new window takes the screen at the same size
  /// without a grid change.
  func testClosingWindowKeepsGridIntoParking() async throws {
    let rig = rig()
    let wire = FakeWire()
    let first = try popup(rig, wire: wire, dismissals: Counter())
    let (host, navigation) = present(first, in: rig)
    let socket = try await open(wire, first.screen.session)
    let surface = try XCTUnwrap(first.screen.surface as? FakeSurface)
    let rows = surface.gridSize.rows
    XCTAssertGreaterThan(rows, 15)
    // Kontrola: poza zejściem przesunięty arkusz ściska siatkę — tak działa prowadnica także w procesie testów.
    drag(navigation, by: 100)
    XCTAssertLessThan(surface.gridSize.rows, rows, "kontrola: prowadnica stoi w układzie okna apki")
    drag(navigation, by: 0)
    XCTAssertEqual(surface.gridSize.rows, rows)
    try await Task.sleep(for: .milliseconds(150))
    let calls = surface.resizeCalls
    let sent = resizes(socket)

    host.closing = true
    for distance in [20.0, 100, 250] { drag(navigation, by: distance) }
    XCTAssertEqual(surface.gridSize.rows, rows, "przeciąganie w dół nie zmienia siatki")
    XCTAssertEqual(surface.resizeCalls, calls, "żadnego `onResize` w trakcie zejścia")
    close(first, in: rig)
    XCTAssertEqual(rig.parking.count, 1)
    try await Task.sleep(for: .milliseconds(150))
    XCTAssertEqual(resizes(socket), sent, "zejście okna nie wysyła `rs`")

    let second = try popup(rig, wire: wire, dismissals: Counter())
    XCTAssertTrue(second.screen === first.screen, "ten sam ekran z parkingu")
    _ = present(second, in: rig)
    XCTAssertEqual(surface.gridSize.rows, rows, "ekran z parkingu w rozmiarze sprzed zejścia")
    XCTAssertEqual(surface.resizeCalls, calls, "pierwszy układ nowego okna nie zmienia siatki")
    try await Task.sleep(for: .milliseconds(150))
    XCTAssertTrue(resizes(socket).allSatisfy { $0.rows == rows }, "same `rs` pełnego rozmiaru: \(resizes(socket))")
  }

  /// Ekran zaparkowany z blokadą, której nie zdjął koniec przejścia (dismantle przed completion koordynatora), wraca
  /// do NOWEGO okna innej wysokości (obrót telefonu, inna wysokość arkusza). Blokadę zdejmuje już pierwszy układ nowego
  /// okna, przed `viewDidAppear`: siatka idzie za nową prowadnicą klawiatury, a na drut idzie jeden `rs` z nowym
  /// rozmiarem — nie stary rozmiar z wymuszonego `rs` w `viewDidAppear`.
  func testParkedHeldScreenFollowsNewWindowHeight() async throws {
    let rig = rig()
    let wire = FakeWire()
    let first = try popup(rig, wire: wire, dismissals: Counter())
    let (host, navigation) = present(first, in: rig)
    let socket = try await open(wire, first.screen.session)
    let screen = first.screen
    let surface = try XCTUnwrap(screen.surface as? FakeSurface)
    let rows = surface.gridSize.rows
    try await Task.sleep(for: .milliseconds(150))
    host.closing = true
    drag(navigation, by: 100)
    XCTAssertEqual(surface.gridSize.rows, rows, "w trakcie zejścia blokada trzyma siatkę")
    // Dismantle bez końca przejścia: blokada zostaje na zaparkowanym ekranie.
    close(first, in: rig)
    XCTAssertEqual(rig.parking.count, 1)
    let sent = resizes(socket).count

    let second = try popup(rig, wire: wire, dismissals: Counter())
    XCTAssertTrue(second.screen === screen, "ten sam ekran z parkingu")
    // Nowe okno o 200 pt niższe; pokazanie jak w UIKit: `viewWillAppear`, pierwszy układ, `viewDidAppear` na końcu.
    let newHost = SheetHost()
    newHost.forwardsAppearance = false
    let newNavigation = TerminalPopupController.window(second)
    rig.window.rootViewController = newHost
    newHost.addChild(newNavigation)
    newNavigation.beginAppearanceTransition(true, animated: true)
    newNavigation.view.frame = newHost.view.bounds.inset(by: UIEdgeInsets(top: 262, left: 0, bottom: 0, right: 0))
    newHost.view.addSubview(newNavigation.view)
    newNavigation.didMove(toParent: newHost)
    newHost.view.layoutIfNeeded()
    newNavigation.view.layoutIfNeeded()
    XCTAssertTrue(screen.inputSuspended, "warunek testu: `viewDidAppear` nowego okna jeszcze nie przyszło")
    let guide = screen.view.keyboardLayoutGuide.layoutFrame
    XCTAssertEqual(screen.container.frame.maxY, guide.minY, accuracy: 0.5, "pierwszy układ: dół siatki na prowadnicy")
    let newRows = surface.gridSize.rows
    XCTAssertLessThan(newRows, rows, "niższe okno: mniej wierszy już w pierwszym układzie")

    newNavigation.endAppearanceTransition()
    await waitUntil { !screen.inputSuspended }
    try await Task.sleep(for: .milliseconds(150))
    let after = resizes(socket).dropFirst(sent).map(\.rows)
    XCTAssertEqual(after, [newRows], "jeden `rs` z nowym rozmiarem, bez starego")
    XCTAssertEqual(surface.gridSize.rows, newRows)
  }

  /// Anulowane przeciągnięcie (arkusz wraca na miejsce): UIKit odwraca przejście wyglądu (`viewWillDisappear`, potem
  /// `viewWillAppear` i `viewDidAppear`), blokada schodzi, siatka zostaje ta sama, a ekran znowu idzie za prowadnicą
  /// klawiatury — inaczej klawiatura terminala po anulowaniu przykryłaby pasek i dół siatki.
  func testCancelledCloseReleasesGrid() async throws {
    let rig = rig()
    let wire = FakeWire()
    let popup = try popup(rig, wire: wire, dismissals: Counter())
    let (host, navigation) = present(popup, in: rig)
    _ = try await open(wire, popup.screen.session)
    let surface = try XCTUnwrap(popup.screen.surface as? FakeSurface)
    let rows = surface.gridSize.rows
    host.closing = true
    navigation.beginAppearanceTransition(false, animated: true)
    drag(navigation, by: 200)
    XCTAssertEqual(surface.gridSize.rows, rows, "w trakcie zejścia siatka stoi")
    host.closing = false
    drag(navigation, by: 0)
    navigation.beginAppearanceTransition(true, animated: true)
    navigation.endAppearanceTransition()
    navigation.view.layoutIfNeeded()
    XCTAssertEqual(surface.gridSize.rows, rows, "arkusz na miejscu: ta sama siatka")
    drag(navigation, by: 100)
    XCTAssertLessThan(surface.gridSize.rows, rows, "po anulowaniu ekran znowu idzie za prowadnicą")
  }
}

/// Drut, który po ``forcedId`` odpowiada na `POST` innym id (terminal przeniesiony przez serwer).
private final class RetargetingWire: TerminalTransporting, @unchecked Sendable {
  let base: FakeWire
  private let lock = NSLock()
  private var id: String?

  init(base: FakeWire) { self.base = base }

  var forcedId: String? {
    get { lock.withLock { id } }
    set { lock.withLock { id = newValue } }
  }

  func openTerminal(_ body: TerminalOpenBody) async throws(TransportError) -> TerminalOpenResponse {
    let response = try await base.openTerminal(body)
    guard let id = forcedId else { return response }
    do {
      return try JSONDecoder().decode(
        TerminalOpenResponse.self, from: Data(#"{"id":"\#(id)","slot":\#(response.slot),"role":"shell"}"#.utf8))
    } catch {
      throw .invalidResponse("atrapa")
    }
  }

  func terminals() async throws(TransportError) -> TerminalList { try await base.terminals() }

  func terminalHistory(id: String, lines: Int) async throws(TransportError) -> TerminalHistory {
    try await base.terminalHistory(id: id, lines: lines)
  }

  func closeTerminal(id: String) async throws(TransportError) { try await base.closeTerminal(id: id) }

  func checkTerminalInput() async throws(MutationRefusal) { try await base.checkTerminalInput() }

  func terminalSocket(
    id: String, fresh: Bool, direct: Bool, grid: TerminalGrid?
  ) throws(TransportError) -> any TerminalSocketing {
    try base.terminalSocket(id: id, fresh: fresh, direct: direct, grid: grid)
  }
}
