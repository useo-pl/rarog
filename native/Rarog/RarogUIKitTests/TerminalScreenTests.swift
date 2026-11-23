import RarogContract
import RarogCore
import RarogTransport
@testable import RarogUI
import UIKit
import XCTest

/// Ekran terminala w oknie, z prawdziwą sesją `TerminalSession` na atrapie drutu i atrapą
/// powierzchni (renderer SwiftTerm testuje pakiet `RarogTerminal`). Treść to wyłącznie próbki syntetyczne.
/// Bez hosta apki i sieci.
@MainActor
final class TerminalScreenTests: XCTestCase {
  private static let cwd = "/Users/demo/Projects/rarog"

  struct Harness {
    let screen: TerminalScreenViewController
    let surface: FakeSurface
    let wire: FakeWire
    let session: TerminalSession
    let window: UIWindow
    let clipboard: ClipboardBox
    let ticks: Ticks
  }

  /// Zegar monotoniczny śladu otwarcia, wspólny dla sesji i ekranu: stoi, dopóki test go nie przesunie.
  final class Ticks {
    let origin = ContinuousClock.now
    var elapsed: Duration = .zero
    var now: ContinuousClock.Instant { origin + elapsed }
  }

  final class ClipboardBox {
    var text: String?
    var written: [String] = []
  }

  /// Zdania dla czytnika z atrapy `Announcer`.
  private final class SpokenBox {
    var lines: [String] = []
  }

  func harness(
    hardware: Bool = false, closeOutcome: TerminalCloseOutcome = .closed, target: TerminalTarget? = nil,
    holdOpen: Bool = false
  ) throws -> Harness {
    try Self.harness(in: self, hardware: hardware, closeOutcome: closeOutcome, target: target, holdOpen: holdOpen)
  }

  /// Ten sam ekran dla klas testów obok (`TerminalFocusResizeTests`); sprzątanie idzie do testu `test`.
  static func harness(
    in test: XCTestCase, hardware: Bool = false, closeOutcome: TerminalCloseOutcome = .closed,
    target: TerminalTarget? = nil, holdOpen: Bool = false
  ) throws -> Harness {
    let wire = FakeWire()
    wire.closeOutcome = closeOutcome
    wire.holdOpen = holdOpen
    let target = try XCTUnwrap(target ?? TerminalTarget.shell(cwd: cwd))
    let ticks = Ticks()
    let session = TerminalSession(
      target: target, transport: wire, timing: TerminalTiming(backoff: [.milliseconds(20)]), clock: { ticks.now })
    let surface = FakeSurface()
    let screen = TerminalScreenViewController(session: session, surface: surface) { id in
      wire.closed.append(id)
      await wire.waitIfHeld()
      return wire.closeOutcome
    }
    screen.clock = { ticks.now }
    let clipboard = ClipboardBox()
    screen.hardwareKeyboard = { hardware }
    screen.sceneIsActive = { true }
    screen.settleDelay = .milliseconds(60)
    screen.firstScreenWindow = .milliseconds(40)
    screen.noticeHold = .seconds(30)
    screen.announcer = Announcer(sink: { _ in }, now: Date.init)
    screen.clipboard = TerminalClipboard(read: { clipboard.text }, write: { clipboard.written.append($0) })
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 800, height: 600))
    window.rootViewController = screen
    window.makeKeyAndVisible()
    test.addTeardownBlock { @MainActor in
      screen.shutdown()
      window.isHidden = true
    }
    return Harness(
      screen: screen, surface: surface, wire: wire, session: session, window: window, clipboard: clipboard, ticks: ticks)
  }

  /// Ekran wystartował sesję: `POST`, gniazdo, `opened` → `live`.
  func connect(_ h: Harness) async throws -> RecordingSocket {
    await waitUntil { h.wire.sockets.count > 0 }
    let socket = try XCTUnwrap(h.wire.sockets.last)
    socket.emit(.opened)
    await waitUntil { h.session.phase == .live }
    XCTAssertEqual(h.session.phase, .live)
    return socket
  }

  private func waitUntil(_ condition: () -> Bool) async {
    for _ in 0..<300 where !condition() {
      try? await Task.sleep(for: .milliseconds(10))
    }
  }

  private func resizes(_ socket: RecordingSocket) -> [TerminalGrid] {
    socket.sent.compactMap { if case let .resize(grid) = $0 { grid } else { nil } }
  }

  /// Warstwy z zaokrąglonymi rogami w poddrzewie.
  private func roundedLayers(_ layer: CALayer) -> [CALayer] {
    (layer.cornerRadius > 0 ? [layer] : []) + (layer.sublayers ?? []).flatMap(roundedLayers)
  }

  func inputs(_ socket: RecordingSocket) -> [String] {
    socket.sent.compactMap { if case let .input(text) = $0 { text } else { nil } }
  }

  // MARK: - Rozmiar

  /// Seria zmian kontenera (obrót: 2–3 zmiany w ~70 ms) → JEDEN `rs` z ostatnim rozmiarem, po ustaleniu.
  /// Zmiany przychodzą z odstępem (jak przy obrocie), więc pętla zdąży obrócić się między nimi: bez ciszy
  /// przed `rs` wyszłyby trzy.
  func testSeriesOfContainerResizesSendsOneRs() async throws {
    let h = try harness()
    h.screen.settleDelay = .milliseconds(250)
    let socket = try await connect(h)
    await waitUntil { !self.resizes(socket).isEmpty }
    let baseline = resizes(socket).count  // `rs` po otwarciu gniazda (sesja synchronizuje rozmiar)
    for size in [CGSize(width: 700, height: 500), CGSize(width: 1000, height: 400), CGSize(width: 900, height: 640)] {
      h.window.frame = CGRect(origin: .zero, size: size)
      h.window.layoutIfNeeded()
      try await Task.sleep(for: .milliseconds(25))
    }
    XCTAssertGreaterThanOrEqual(h.surface.resizeCalls, 3, "powierzchnia zgłasza każdą zmianę siatki")
    try await Task.sleep(for: .milliseconds(700))
    let sent = Array(resizes(socket).dropFirst(baseline))
    XCTAssertEqual(sent.count, 1, "jeden `rs` na ustalony układ: \(sent)")
    let grid = h.surface.gridSize
    XCTAssertEqual(sent.last, TerminalGrid(cols: grid.cols, rows: grid.rows))
  }

  /// Odstęp treści 8 pt z obu stron robi ramka
  /// powierzchni: siatka i `rs` liczą się z szerokości PO odjęciu odstępów, także po obrocie.
  func testSurfaceInsetFromBothSidesAndGridFollowsIt() async throws {
    let h = try harness(hardware: true)
    let socket = try await connect(h)
    let inset = TerminalScreenViewController.sideInset
    for size in [CGSize(width: 800, height: 600), CGSize(width: 600, height: 800)] {
      h.window.frame = CGRect(origin: .zero, size: size)
      h.window.layoutIfNeeded()
      let container = h.screen.container
      XCTAssertEqual(h.surface.frame.minX, inset, accuracy: 0.5, "z lewej (\(size)): \(h.surface.frame)")
      XCTAssertEqual(container.bounds.width - h.surface.frame.maxX, inset, accuracy: 0.5, "z prawej (\(size))")
      XCTAssertEqual(h.surface.gridSize.cols, Int((size.width - 2 * inset) / 10), "kolumny bez odstępów (\(size))")
      await waitUntil { self.resizes(socket).last?.cols == h.surface.gridSize.cols }
      XCTAssertEqual(resizes(socket).last?.cols, h.surface.gridSize.cols, "`rs` z siatki po odstępach (\(size))")
    }
  }

  /// Fokus wraca do terminala: `rs` z `force` (po odejściu drugiego klienta panel trzyma JEGO rozmiar).
  func testFocusReassertsSizeEvenWhenUnchanged() async throws {
    let h = try harness()
    let socket = try await connect(h)
    try await Task.sleep(for: .milliseconds(200))
    let before = resizes(socket).count
    h.surface.onFocus?()
    await waitUntil { self.resizes(socket).count > before }
    XCTAssertEqual(resizes(socket).count, before + 1)
    XCTAssertEqual(resizes(socket).last, resizes(socket).dropLast().last, "ten sam rozmiar, wysłany jeszcze raz")
  }

  // MARK: - Pasek klawiszy

  /// Bez klawiatury sprzętowej pasek stoi na `keyboardLayoutGuide`, a powierzchnia nad nim; z klawiaturą znika.
  func testKeyBarStandsOnKeyboardGuideOnlyWithoutHardwareKeyboard() throws {
    let h = try harness(hardware: false)
    let view = h.screen.view!
    view.layoutIfNeeded()
    let bar = h.screen.keyBar
    XCTAssertFalse(bar.isHidden)
    let guide = view.keyboardLayoutGuide.layoutFrame
    let barFrame = bar.convert(bar.bounds, to: view)
    XCTAssertEqual(barFrame.maxY, guide.minY, accuracy: 0.5, "pasek tuż nad klawiaturą (albo dołem ekranu)")
    XCTAssertGreaterThanOrEqual(barFrame.height, TerminalKeyBarMetrics.target)
    let surfaceFrame = h.surface.convert(h.surface.bounds, to: view)
    XCTAssertEqual(surfaceFrame.maxY, barFrame.minY, accuracy: 0.5, "powierzchnia kończy się na pasku")
    for key in [TerminalBarKey.esc, .tab, .ctrl, .cmd, .copy, .history] {
      let button = try XCTUnwrap(bar.button(key))
      XCTAssertGreaterThanOrEqual(button.bounds.width, 44, "\(key)")
      XCTAssertGreaterThanOrEqual(button.bounds.height, 44, "\(key)")
      // Tło klawisza: promień ze skali i krzywa ciągła jak reszta apki.
      let rounded = roundedLayers(button.layer)
      XCTAssertFalse(rounded.isEmpty, "\(key): tło bez rogów")
      for layer in rounded {
        XCTAssertEqual(layer.cornerRadius, Radius.inner, "\(key)")
        XCTAssertEqual(layer.cornerCurve, .continuous, "\(key)")
      }
    }
    // „Wklej": kontrolka wielkości widocznego klawisza, w tle klawiszy — przezroczyste system rysuje na czarno na
    // całej kontrolce. Komórka ma szerokość celu jak sąsiedzi.
    let paste = bar.pasteControl
    let cell = try XCTUnwrap(paste.superview as? TerminalPasteKeyCell)
    XCTAssertGreaterThanOrEqual(cell.bounds.width, 44)
    let tab = try XCTUnwrap(bar.button(.tab))
    XCTAssertEqual(paste.bounds.height, tab.bounds.height - 2 * TerminalKeyBarMetrics.keyInsetY, accuracy: 0.5)
    XCTAssertEqual(paste.bounds.width, cell.bounds.width - 2 * TerminalKeyBarMetrics.keyInsetX, accuracy: 0.5)
    XCTAssertEqual(paste.configuration.baseBackgroundColor, Palette.surface2, "tło jak u klawiszy, nie przezroczyste")

    h.screen.hardwareKeyboard = { true }
    h.screen.updateKeyBar()
    view.layoutIfNeeded()
    XCTAssertTrue(bar.isHidden)
    XCTAssertEqual(h.surface.convert(h.surface.bounds, to: view).maxY, guide.minY, accuracy: 0.5)
  }

  /// Ctrl jednorazowy: tap uzbraja (stan dla czytnika), pierwszy klawisz leci jako C0 i rozbraja.
  func testArmedCtrlTurnsNextKeyIntoControlByte() async throws {
    let h = try harness()
    let socket = try await connect(h)
    let ctrl = try XCTUnwrap(h.screen.keyBar.button(.ctrl))
    ctrl.sendActions(for: .primaryActionTriggered)
    XCTAssertTrue(ctrl.isSelected)
    XCTAssertEqual(ctrl.accessibilityValue, UICopy.terminalKeyArmed)
    h.surface.onInput?("c")
    h.surface.onInput?("c")
    await waitUntil { self.inputs(socket).count == 2 }
    XCTAssertEqual(inputs(socket), ["\u{03}", "c"])
    XCTAssertFalse(ctrl.isSelected)
    h.screen.keyBar.button(.esc)?.sendActions(for: .primaryActionTriggered)
    await waitUntil { self.inputs(socket).count == 3 }
    XCTAssertEqual(inputs(socket).last, "\u{1B}")
  }

  /// Podpięcie klawiatury sprzętowej chowa pasek i gasi uzbrojony modyfikator (inaczej Ctrl zostałby „w powietrzu").
  func testHardwareKeyboardDisarmsModifiers() async throws {
    let h = try harness()
    let socket = try await connect(h)
    h.screen.keyBar.button(.cmd)?.sendActions(for: .primaryActionTriggered)
    XCTAssertTrue(h.screen.modifiers.cmd)
    h.screen.hardwareKeyboard = { true }
    h.screen.updateKeyBar()
    XCTAssertFalse(h.screen.modifiers.isArmed)
    h.surface.onInput?("b")
    await waitUntil { !self.inputs(socket).isEmpty }
    XCTAssertEqual(inputs(socket), ["b"])
  }

  // MARK: - Wklejka

  /// Wklejka z powierzchni i z menu „⋯": ramki `pa` z SUROWYM tekstem, zero ramek `in`; uzbrojony Ctrl gaśnie.
  func testPasteGoesAsPasteFramesNeverInput() async throws {
    let h = try harness()
    let socket = try await connect(h)
    h.screen.keyBar.button(.ctrl)?.sendActions(for: .primaryActionTriggered)
    h.surface.onPaste?("c")
    h.clipboard.text = "echo raz\r\necho dwa\n"
    h.screen.handlePasteCommand()
    await waitUntil { socket.sent.filter { if case .paste = $0 { true } else { false } }.count == 2 }
    let pastes = socket.sent.filter { if case .paste = $0 { true } else { false } }
    XCTAssertEqual(pastes, [.paste("c", end: true), .paste("echo raz\r\necho dwa\n", end: true)])
    XCTAssertTrue(inputs(socket).isEmpty, "wklejka nigdy jako `in`")
    XCTAssertFalse(h.screen.modifiers.isArmed, "wklejka to nie klawisz — Ctrl zgasł")
  }

  /// Za duża wklejka: nic nie wychodzi, zdanie na linii stanu; pusty schowek — zdanie zamiast ciszy.
  func testPasteRefusalsSpeak() async throws {
    let h = try harness()
    let socket = try await connect(h)
    let before = socket.sent.count
    h.surface.onPaste?(String(repeating: "x", count: TerminalWire.maxPasteBytes + 1))
    XCTAssertEqual(h.screen.noticeText, UICopy.terminalPasteTooBig)
    XCTAssertEqual(h.screen.statusLabel.text, UICopy.terminalPasteTooBig)
    XCTAssertFalse(h.screen.statusBar.isHidden)
    h.clipboard.text = nil
    h.screen.handlePasteCommand()
    XCTAssertEqual(h.screen.noticeText, UICopy.terminalPasteEmpty)
    try await Task.sleep(for: .milliseconds(50))
    XCTAssertEqual(socket.sent.count, before, "nic nie poszło")
  }

  // MARK: - Kopiuj, menu, klawiatura sprzętowa

  /// Menu „⋯" przy klawiaturze sprzętowej (okno i pasek nawigacji): trzy pozycje; Historia czynna dopiero
  /// z punktem wpięcia i id.
  func testHeaderMenuHasCopyPasteHistory() async throws {
    let h = try harness(hardware: true)
    XCTAssertTrue(h.screen.keyBar.isHidden)
    let menu = h.screen.headerMenu()
    XCTAssertEqual(menu.children.map(\.title), [UICopy.terminalCopy, UICopy.terminalPaste, UICopy.terminalHistory])
    XCTAssertEqual((menu.children[2] as? UIAction)?.attributes.contains(.disabled), true, "bez punktu wpięcia")
    let chrome = TerminalChrome()
    h.screen.chrome = chrome
    XCTAssertFalse(chrome.historyAvailable, "„⋯” w pasku nawigacji: Historia wygaszona")
    var opened: [String] = []
    h.screen.onHistory = { opened.append($0) }
    _ = try await connect(h)
    let ready = h.screen.headerMenu()
    XCTAssertEqual((ready.children[2] as? UIAction)?.attributes.contains(.disabled), false)
    XCTAssertTrue(chrome.historyAvailable)
    chrome.history()
    XCTAssertEqual(opened, [FakeWire.id], "Historia z „⋯” w pasku nawigacji")
    opened = []
    h.screen.handleKey(TerminalHardwareKey("y", command: true))
    XCTAssertEqual(opened, [FakeWire.id], "Cmd+Y = Historia tego terminala")
  }

  /// Kopiuj: zaznaczenie, a bez niego widoczny ekran; pusty ekran mówi „Nie ma czego skopiować.".
  func testCopyTakesSelectionThenScreen() throws {
    let h = try harness()
    h.surface.selection = "zaznaczone"
    h.surface.screenText = "cały ekran"
    h.screen.handleCopy()
    h.surface.selection = nil
    h.screen.handleKey(TerminalHardwareKey("c", command: true))
    XCTAssertEqual(h.clipboard.written, ["zaznaczone", "cały ekran"])
    XCTAssertEqual(h.screen.noticeText, UICopy.terminalCopyDone)
    h.surface.screenText = "  \n "
    h.screen.handleCopy()
    XCTAssertEqual(h.clipboard.written.count, 2)
    XCTAssertEqual(h.screen.noticeText, UICopy.terminalCopyEmpty)
  }

  /// Cmd+C przy zaznaczeniu (droga powierzchni: `copy:` SwiftTerm → `onCopy`): wynik idzie do dymka apki raz,
  /// zaznaczenie znika, linia stanu milczy.
  func testCopyOfSelectionGoesToToastAndClearsSelection() throws {
    let h = try harness()
    var copied: [String] = []
    h.screen.onCopied = { copied.append($0) }
    h.surface.selection = "zaznaczone"
    h.surface.screenText = "cały ekran"
    h.surface.onCopy?()
    XCTAssertEqual(h.clipboard.written, ["zaznaczone"])
    XCTAssertEqual(copied, [UICopy.terminalCopyDone], "dymek raz")
    XCTAssertEqual(h.surface.selectionCleared, 1, "zaznaczenie znika po kopii")
    XCTAssertNil(h.surface.selection)
    XCTAssertNil(h.screen.noticeText, "linia stanu bez „Skopiowano”")
    h.screen.view.layoutIfNeeded()
    XCTAssertNotEqual(h.screen.statusLabel.text, UICopy.terminalCopyDone)
  }

  /// Kopia ekranu bez zaznaczenia (Cmd+C kontenera, „Kopiuj” z paska): dymek, a czyścić nie ma czego.
  func testCopyOfScreenGoesToToastWithoutClearing() throws {
    let h = try harness()
    var copied: [String] = []
    h.screen.onCopied = { copied.append($0) }
    h.surface.screenText = "cały ekran"
    h.screen.handleKey(TerminalHardwareKey("c", command: true))
    XCTAssertEqual(h.clipboard.written, ["cały ekran"])
    XCTAssertEqual(copied, [UICopy.terminalCopyDone])
    XCTAssertEqual(h.surface.selectionCleared, 0, "bez zaznaczenia nic się nie czyści")
    XCTAssertNil(h.screen.noticeText)
    // Pusty ekran: zdanie w linii stanu, bez dymka.
    h.surface.screenText = " \n"
    h.screen.handleCopy()
    XCTAssertEqual(copied.count, 1)
    XCTAssertEqual(h.screen.noticeText, UICopy.terminalCopyEmpty)
  }

  /// Okno Cmd+F/Cmd+G: kopia daje dymek-potwierdzenie w centrum (stoi nad arkuszem, `ToastPlacement.terminalWindow`);
  /// ekran oddany do parkingu nie trzyma wyjścia do dymków starego okna.
  func testWindowCopyGoesToToastCenter() throws {
    let wire = FakeWire()
    let cwd = Self.cwd
    let target = try XCTUnwrap(TerminalTarget.popup(cwd: cwd, role: .popup))
    let session = TerminalSession(target: target, transport: wire, timing: TerminalTiming(backoff: [.milliseconds(20)]))
    let surface = FakeSurface()
    let screen = TerminalScreenViewController(session: session, surface: surface) { _ in .closed }
    screen.hardwareKeyboard = { true }
    screen.sceneIsActive = { true }
    screen.announcer = Announcer(sink: { _ in }, now: Date.init)
    screen.clipboard = TerminalClipboard(read: { nil }, write: { _ in })
    let popup = TerminalPopupController(screen: screen, request: TerminalPopupRequest(cwd: cwd, role: .popup))
    // Zegar dymka stoi (czas `hold` sprawdza `ToastLifecycleTests`).
    let toasts = ToastCenter(
      announcer: Announcer(sink: { _ in }, now: Date.init), wait: { _ in try? await Task.sleep(for: .seconds(60)) })
    popup.toasts = toasts
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 900, height: 700))
    window.rootViewController = TerminalPopupController.window(popup)
    window.makeKeyAndVisible()
    addTeardownBlock { @MainActor in
      screen.shutdown()
      window.isHidden = true
    }
    window.rootViewController?.view.layoutIfNeeded()
    surface.selection = "zaznaczone"
    surface.onCopy?()
    let toast = try XCTUnwrap(toasts.current)
    XCTAssertEqual(toast.text, UICopy.terminalCopyDone)
    XCTAssertEqual(toast.style, .confirmation)
    XCTAssertEqual(surface.selectionCleared, 1)
    XCTAssertNil(screen.noticeText, "w oknie też bez linii stanu")
    screen.park()
    XCTAssertNil(screen.onCopied, "parking odpina wyjście starego okna")
  }

  /// Skróty kontenera: bajty z mapy idą ramką `in`; Cmd+C i Cmd+V NIE są skrótami kontenera (idą akcjami
  /// `copy:`/`paste:`, które kontener przyjmuje, gdy powierzchnia nie bierze); stałe UIKit = stałe mapy.
  func testContainerShortcuts() async throws {
    let h = try harness(hardware: true)
    let socket = try await connect(h)
    h.screen.handleKey(TerminalHardwareKey(".", command: true))
    h.screen.handleKey(TerminalHardwareKey(TerminalKeyMap.leftArrow, command: true))
    h.screen.handleKey(TerminalHardwareKey("d", command: true))
    h.screen.handleKey(TerminalHardwareKey("b", command: true))
    await waitUntil { self.inputs(socket).count == 3 }
    XCTAssertEqual(inputs(socket), ["\u{1B}", "\u{1B}OH", "\u{1B}d"], "Cmd+B zostaje apce")

    let commands = try XCTUnwrap(h.screen.container.keyCommands)
    XCTAssertFalse(commands.contains { $0.input == "c" && $0.modifierFlags == .command })
    XCTAssertFalse(commands.contains { $0.input == "v" && $0.modifierFlags == .command })
    XCTAssertTrue(commands.allSatisfy(\.wantsPriorityOverSystemBehavior))
    XCTAssertEqual(
      commands.compactMap(\.discoverabilityTitle).filter { !$0.isEmpty }, [UICopy.terminalHistory, UICopy.terminalClose])
    XCTAssertTrue(h.screen.container.canPerformAction(#selector(UIResponderStandardEditActions.paste(_:)), withSender: nil))
    XCTAssertEqual(UIKeyCommand.inputUpArrow, TerminalKeyMap.upArrow)
    XCTAssertEqual(UIKeyCommand.inputDownArrow, TerminalKeyMap.downArrow)
    XCTAssertEqual(UIKeyCommand.inputLeftArrow, TerminalKeyMap.leftArrow)
    XCTAssertEqual(UIKeyCommand.inputRightArrow, TerminalKeyMap.rightArrow)
    XCTAssertEqual(UIKeyCommand.inputEscape, TerminalKeyMap.escape)
    XCTAssertEqual(UIKeyCommand.inputHome, TerminalKeyMap.home)
    XCTAssertEqual(UIKeyCommand.inputEnd, TerminalKeyMap.end)
    XCTAssertEqual(UIKeyCommand.inputPageUp, TerminalKeyMap.pageUp)
    XCTAssertEqual(UIKeyCommand.inputPageDown, TerminalKeyMap.pageDown)
  }

  // MARK: - Seria strzałki

  /// Puszczenie i anulowanie klawisza dochodzą do kontenera (`pressesEnded` SwiftTerm woła `super`), a kontener
  /// oddaje je powierzchni — inaczej seria strzałki nie stanęłaby w chwili puszczenia.
  func testContainerHandsKeyReleaseToSurface() throws {
    let h = try harness(hardware: true)
    h.screen.container.pressesEnded([], with: nil)
    h.screen.container.pressesCancelled([], with: nil)
    XCTAssertEqual(h.surface.keysEnded, [false, true], "puszczenie, potem anulowanie")
  }

  /// Koniec serii idzie do śladu `client.log` tylko w budżecie i jako zdanie bez treści klawiszy.
  func testKeyRepeatEndTracesWithinBudget() throws {
    let h = try harness(hardware: true)
    var lines: [String] = []
    var admit = true
    h.screen.trace = { lines.append($0) }
    h.screen.admitKeyRepeatTrace = { _ in admit }
    let end = TerminalKeyRepeatEnd(reason: .ceiling, repeats: 600, heldMilliseconds: 20_000)
    h.surface.onKeyRepeatEnded?(end)
    admit = false
    h.surface.onKeyRepeatEnded?(TerminalKeyRepeatEnd(reason: .released, repeats: 3, heldMilliseconds: 400))
    XCTAssertEqual(lines, [end.traceLine])
  }

  // MARK: - Stany i nowe gniazdo

  /// Każde nowe gniazdo zaczyna się pełną ramką: emulator zerowany dokładnie raz, przed jej pierwszymi bajtami.
  func testNewSocketResetsEmulatorBeforeFirstBytes() async throws {
    let h = try harness()
    let first = try await connect(h)
    first.emit(.bytes(Data("a".utf8)))
    first.emit(.bytes(Data("b".utf8)))
    await waitUntil { h.surface.log.count >= 3 }
    XCTAssertEqual(h.surface.log, ["reset", "feed", "feed"])
    first.drop()
    await waitUntil { h.wire.sockets.count == 2 }
    let second = try XCTUnwrap(h.wire.sockets.last)
    second.emit(.opened)
    second.emit(.bytes(Data("c".utf8)))
    await waitUntil { h.surface.log.count >= 5 }
    XCTAssertEqual(h.surface.log, ["reset", "feed", "feed", "reset", "feed"])
  }

  // MARK: - Pierwszy ekran naraz

  /// Pierwsze połączenie ekranu: do końca okna stoi stary obraz (ani `reset`, ani `feed`), potem `reset` i cały
  /// zebrany ekran naraz; bajty po oknie idą od razu, bez nowego okna.
  func testFirstScreenComesAtOnceAfterWindow() async throws {
    let h = try harness()
    let socket = try await connect(h)
    socket.emit(.bytes(Data("a".utf8)))
    socket.emit(.bytes(Data("b".utf8)))
    try await Task.sleep(for: .milliseconds(15))
    XCTAssertEqual(h.surface.log, [], "w oknie stoi stary obraz")
    await waitUntil { h.surface.log.count >= 3 }
    XCTAssertEqual(h.surface.log, ["reset", "feed", "feed"], "jeden obrót: reset i cały ekran")
    h.screen.firstScreenWindow = .seconds(30)  // gdyby kolejne bajty otwierały okno, czekałyby 30 s
    socket.emit(.bytes(Data("c".utf8)))
    await waitUntil { h.surface.log.count >= 4 }
    XCTAssertEqual(h.surface.log, ["reset", "feed", "feed", "feed"], "po oknie bez opóźnienia")
  }

  /// Ponowienie w trakcie okna: bajty martwego gniazda przepadają, ekran rysuje dopiero pełna ramka nowego.
  func testReconnectInsideWindowDropsOldBytes() async throws {
    let h = try harness()
    h.screen.firstScreenWindow = .milliseconds(300)
    let first = try await connect(h)
    first.emit(.bytes(Data("a".utf8)))
    try await Task.sleep(for: .milliseconds(20))
    first.drop()
    await waitUntil { h.wire.sockets.count == 2 }
    let second = try XCTUnwrap(h.wire.sockets.last)
    second.emit(.opened)
    second.emit(.bytes(Data("b".utf8)))
    await waitUntil { h.surface.log.count >= 2 }
    try await Task.sleep(for: .milliseconds(100))
    XCTAssertEqual(h.surface.log, ["reset", "feed"], "tylko ekran nowego gniazda")
  }

  /// Uśpienie (tło) i błąd serwera w oknie: zebrane bajty przepadają bez rysowania, stary obraz zostaje.
  func testSuspendOrErrorInsideWindowDiscards() async throws {
    let h = try harness()
    h.screen.firstScreenWindow = .milliseconds(150)
    let socket = try await connect(h)
    socket.emit(.bytes(Data("a".utf8)))
    try await Task.sleep(for: .milliseconds(20))
    h.session.suspend()
    try await Task.sleep(for: .milliseconds(250))
    XCTAssertEqual(h.surface.log, [], "uśpienie w oknie: nic nie narysowane")
    h.session.resume()
    await waitUntil { h.wire.sockets.count == 2 }
    let second = try XCTUnwrap(h.wire.sockets.last)
    second.emit(.opened)
    await waitUntil { h.session.phase == .live }
    second.emit(.bytes(Data("b".utf8)))
    try await Task.sleep(for: .milliseconds(20))
    second.emit(.frame(.error(message: "Terminal przejął inny kontroler.")))
    await waitUntil { h.session.phase.isHalted }
    try await Task.sleep(for: .milliseconds(250))
    XCTAssertEqual(h.surface.log, [], "błąd w oknie: nic nie narysowane")
  }

  /// `exit` w oknie: ostatnie wyjście programu widać od razu (okno się kończy), a okno z `closesOnExit` schodzi.
  func testExitInsideWindowFlushes() async throws {
    let h = try harness()
    h.screen.firstScreenWindow = .seconds(30)
    h.screen.closesOnExit = true
    var closed = 0
    h.screen.onClose = { closed += 1 }
    let socket = try await connect(h)
    socket.emit(.bytes(Data("bye".utf8)))
    socket.emit(.frame(.exit))
    await waitUntil { closed == 1 }
    XCTAssertEqual(Array(h.surface.log.prefix(2)), ["reset", "feed"], "ostatnie wyjście narysowane przed zamknięciem")
    XCTAssertEqual(closed, 1)
  }

  // MARK: - Ślad czasu otwarcia

  /// Kształt linii: same liczby i słowa stałe — żadnego bajtu treści terminala.
  private func assertOpenTraceShape(_ text: String, file: StaticString = #filePath, line: UInt = #line) throws {
    let shape = try Regex(
      #"terminal: pierwszy ekran \d+ ms \((nowy ekran|powrót z tła); "#
        + #"(POST \d+ ms|POST pominięty|POST po odmowie \d+ ms), gniazdo \d+ ms, bajty \d+ ms, okno \d+ ms\)"#)
    XCTAssertNotNil(text.wholeMatch(of: shape), text, file: file, line: line)
  }

  /// Podpina się pod bajty sesji ZA ekranem: licznik mówi, że bajty doszły do okna pierwszego ekranu.
  private func countBytes(_ h: Harness) -> () -> Int {
    let screenBytes = h.session.onBytes
    var count = 0
    h.session.onBytes = { data in
      screenBytes?(data)
      count += 1
    }
    return { count }
  }

  /// Nowy ekran: jedna linia z czasem od `viewIsAppearing` do narysowania i jego składowymi (`POST`, gniazdo, bajty,
  /// okno) — liczby z zegara wspólnego dla sesji i ekranu, bez treści; kolejne bajty nie dają drugiej linii.
  func testFirstScreenTracesOpeningTime() async throws {
    let h = try harness(holdOpen: true)
    var lines: [String] = []
    h.screen.trace = { lines.append($0) }
    h.screen.admitOpenTrace = { _ in true }
    h.screen.firstScreenWindow = .milliseconds(200)
    let bytes = countBytes(h)
    await waitUntil { h.wire.opens.count == 1 }
    h.ticks.elapsed += .milliseconds(118)
    h.wire.releaseOpen()
    let socket = try await connectAfter(h, socketAt: .milliseconds(205))
    h.ticks.elapsed += .milliseconds(9)
    socket.emit(.bytes(Data("echo SEKRET\r\n".utf8)))
    await waitUntil { bytes() == 1 }
    h.ticks.elapsed += .milliseconds(80)
    await waitUntil { h.surface.log.contains("reset") }
    XCTAssertEqual(lines, [
      "terminal: pierwszy ekran 412 ms (nowy ekran; POST 118 ms, gniazdo 205 ms, bajty 9 ms, okno 80 ms)",
    ])
    socket.emit(.bytes(Data("SEKRET".utf8)))
    await waitUntil { bytes() == 2 }
    XCTAssertEqual(lines.count, 1, "jedna linia na otwarcie")
    for line in lines {
      try assertOpenTraceShape(line)
      XCTAssertFalse(line.contains("SEKRET"), "treść terminala w śladzie")
    }
  }

  /// Ekran z `POST` wstrzymanym: gniazdo otwiera się po `socketAt` od odpowiedzi (zegar śladu stoi w miejscu).
  private func connectAfter(_ h: Harness, socketAt delay: Duration) async throws -> RecordingSocket {
    await waitUntil { h.wire.sockets.count > 0 }
    h.ticks.elapsed += delay
    return try await connect(h)
  }

  /// Odrzucony pierwszy ekran (uśpienie w oknie) nie raportuje; powrót z tła raportuje od wznowienia sesji.
  /// Ostatnie wyjście programu przy `exit` rysuje się, ale otwarciem nie jest.
  func testDiscardedOrExitingFirstScreenDoesNotTrace() async throws {
    let h = try harness()
    var lines: [String] = []
    h.screen.trace = { lines.append($0) }
    h.screen.admitOpenTrace = { _ in true }
    h.screen.firstScreenWindow = .milliseconds(150)
    let bytes = countBytes(h)
    let first = try await connect(h)
    first.emit(.bytes(Data("a".utf8)))
    await waitUntil { bytes() == 1 }
    h.session.suspend()
    try await Task.sleep(for: .milliseconds(250))
    XCTAssertEqual(h.surface.log, [], "uśpienie w oknie: nic nie narysowane")
    XCTAssertEqual(lines, [], "odrzucony pierwszy ekran nie raportuje")

    // Powrót po 5 s: ślad liczy od wznowienia sesji, nie od dawnego pojawienia się ekranu.
    h.ticks.elapsed += .seconds(5)
    h.session.resume()
    await waitUntil { h.wire.sockets.count == 2 }
    let second = try XCTUnwrap(h.wire.sockets.last)
    second.emit(.opened)
    await waitUntil { h.session.phase == .live }
    second.emit(.bytes(Data("b".utf8)))
    await waitUntil { h.surface.log.contains("reset") }
    XCTAssertEqual(lines, [
      "terminal: pierwszy ekran 0 ms (powrót z tła; POST pominięty, gniazdo 0 ms, bajty 0 ms, okno 0 ms)",
    ], "id znane: powrót bez `POST`")
    for line in lines { try assertOpenTraceShape(line) }

    let popup = try harness()
    var popupLines: [String] = []
    popup.screen.trace = { popupLines.append($0) }
    popup.screen.admitOpenTrace = { _ in true }
    popup.screen.firstScreenWindow = .seconds(30)
    popup.screen.closesOnExit = true
    var closed = 0
    popup.screen.onClose = { closed += 1 }
    let socket = try await connect(popup)
    socket.emit(.bytes(Data("bye".utf8)))
    socket.emit(.frame(.exit))
    await waitUntil { closed == 1 }
    XCTAssertEqual(Array(popup.surface.log.prefix(2)), ["reset", "feed"], "ostatnie wyjście narysowane")
    XCTAssertEqual(popupLines, [], "`exit` w oknie to nie otwarcie")
  }

  /// Ponowienie po zerwaniu i łączenie po odmowie `DELETE` rysują pierwszy ekran bez śladu otwarcia.
  func testRetryAndReconnectAfterRefusedCloseDoNotTrace() async throws {
    let h = try harness(closeOutcome: .failed("Nie wolno."))
    var lines: [String] = []
    h.screen.trace = { lines.append($0) }
    h.screen.admitOpenTrace = { _ in true }
    await waitUntil { h.wire.sockets.count == 1 }
    h.wire.sockets[0].drop()  // zerwanie przed otwarciem: próba świeża porzucona
    await waitUntil { h.wire.sockets.count == 2 }
    h.wire.sockets[1].emit(.opened)
    await waitUntil { h.session.phase == .live }
    h.wire.sockets[1].emit(.bytes(Data("a".utf8)))
    await waitUntil { h.surface.log.contains("reset") }
    XCTAssertEqual(lines, [], "ponowienie po zerwaniu bez śladu")

    h.session.stop()  // magazyn zatrzymuje sesję przed `DELETE`
    h.screen.closeTapped()
    h.screen.closeTapped()
    await waitUntil { h.wire.sockets.count == 3 }
    h.wire.sockets[2].emit(.opened)
    await waitUntil { h.session.phase == .live }
    h.wire.sockets[2].emit(.bytes(Data("b".utf8)))
    await waitUntil { h.surface.log.filter { $0 == "reset" }.count == 2 }
    XCTAssertEqual(lines, [], "łączenie po odmowie `DELETE` to nie pojawienie się ekranu")
  }

  /// Zerwanie po pierwszych bajtach, a przed końcem okna: ekran porzucony bez śladu, a jego czasy nie przechodzą
  /// na pierwszy ekran ponowienia.
  func testDropInsideWindowDoesNotCarryTimingToRetry() async throws {
    let h = try harness()
    var lines: [String] = []
    h.screen.trace = { lines.append($0) }
    h.screen.admitOpenTrace = { _ in true }
    h.screen.firstScreenWindow = .milliseconds(300)
    let bytes = countBytes(h)
    let first = try await connect(h)
    first.emit(.bytes(Data("a".utf8)))
    await waitUntil { bytes() == 1 }
    first.drop()
    await waitUntil { h.wire.sockets.count == 2 }
    let second = try XCTUnwrap(h.wire.sockets.last)
    second.emit(.opened)
    await waitUntil { h.session.phase == .live }
    second.emit(.bytes(Data("b".utf8)))
    await waitUntil { h.surface.log.contains("reset") }
    try await Task.sleep(for: .milliseconds(350))  // okno pierwszego gniazda minęło
    XCTAssertEqual(h.surface.log, ["reset", "feed"], "tylko ekran ponowienia")
    XCTAssertEqual(lines, [], "czasy porzuconego ekranu nie przechodzą na ponowienie")
  }

  /// Podbudżet śladów otwarcia (6 na godzinę) rozstrzyga, czy linia idzie — pytany chwilą narysowania.
  func testOpeningTraceWithinBudget() async throws {
    let h = try harness()
    var lines: [String] = []
    var asked: [ContinuousClock.Instant] = []
    h.screen.trace = { lines.append($0) }
    h.screen.admitOpenTrace = { now in
      asked.append(now)
      return false
    }
    let socket = try await connect(h)
    h.ticks.elapsed += .milliseconds(7)
    socket.emit(.bytes(Data("a".utf8)))
    await waitUntil { h.surface.log.contains("reset") }
    XCTAssertEqual(lines, [], "poza budżetem bez linii")
    XCTAssertEqual(asked, [h.ticks.now], "budżet pytany raz, chwilą narysowania")
  }

  /// Powrót z tła (magazyn usypia sesję w tle i budzi ją na wierzchu): TEN SAM terminal — „Nowy terminal"
  /// (`slot: next`) wraca do id, które dostał, gniazdem bez `POST`, a nie zakłada drugiej powłoki — nowym
  /// gniazdem `fresh=1` z rozmiarem z układu, a emulator zeruje się przed pełną ramką serwera.
  func testReturnFromBackgroundReconnectsSameTerminal() async throws {
    let h = try harness(target: TerminalTarget.newShell(cwd: Self.cwd))
    var ids: [String] = []
    h.screen.onTerminalIdentified = { ids.append($0) }
    let first = try await connect(h)
    first.emit(.bytes(Data("a".utf8)))
    await waitUntil { h.surface.log.count >= 2 }

    h.session.suspend()
    XCTAssertEqual(h.session.phase, .suspended)
    h.session.resume()
    await waitUntil { h.wire.sockets.count == 2 }
    let second = try XCTUnwrap(h.wire.sockets.last)
    second.emit(.opened)
    second.emit(.bytes(Data("b".utf8)))
    await waitUntil { h.surface.log.count >= 4 }

    XCTAssertEqual(h.wire.opens.map(\.slot), [.next], "powrót bez `POST`, a już na pewno bez drugiego `next`")
    let connects = h.wire.connects
    XCTAssertEqual(connects.map(\.id), [FakeWire.id, FakeWire.id], "to samo id terminala")
    XCTAssertEqual(connects.map(\.fresh), [true, true], "nowe gniazdo = pełna ramka")
    XCTAssertEqual(connects.map(\.direct), [false, true], "powrót: gniazdo bez `POST`")
    let grid = h.surface.gridSize
    XCTAssertEqual(connects.last?.grid, TerminalGrid(cols: grid.cols, rows: grid.rows), "rozmiar z układu w upgrade'zie")
    XCTAssertEqual(h.surface.log, ["reset", "feed", "reset", "feed"])
    XCTAssertEqual(h.session.phase, .live)
    XCTAssertEqual(ids, [FakeWire.id], "nawigacja nie dostaje nowego id")
  }

  /// Powrót z tła, a serwer odmawia gniazda bez `POST` (zamknięcie przed otwarciem): od razu `POST` i zwykłe
  /// gniazdo, bez „ponawiam” i bez budzika; ekran rysuje pełną ramkę drugiego gniazda, ślad mówi „POST po odmowie”.
  func testRefusedDirectSocketFallsBackToPost() async throws {
    let h = try harness()
    let first = try await connect(h)
    first.emit(.bytes(Data("a".utf8)))
    await waitUntil { h.surface.log.count >= 2 }
    var lines: [String] = []
    h.screen.trace = { lines.append($0) }
    h.screen.admitOpenTrace = { _ in true }

    h.session.suspend()
    h.session.resume()
    await waitUntil { h.wire.sockets.count == 2 }
    XCTAssertEqual(h.wire.opens.count, 1, "powrót bez `POST`")
    h.wire.sockets[1].drop()
    await waitUntil { h.wire.sockets.count == 3 }
    XCTAssertEqual(h.wire.opens.count, 2, "`POST` po odmowie")
    XCTAssertEqual(h.wire.connects.map(\.direct), [false, true, false])
    XCTAssertEqual(h.wire.connects.map(\.fresh), [true, true, true], "ta sama próba świeża")
    XCTAssertEqual(h.session.phase, .connecting, "odmowa to nie zerwanie")
    let third = h.wire.sockets[2]
    third.emit(.opened)
    await waitUntil { h.session.phase == .live }
    third.emit(.bytes(Data("b".utf8)))
    await waitUntil { h.surface.log.count >= 4 }
    XCTAssertEqual(h.surface.log, ["reset", "feed", "reset", "feed"])
    XCTAssertEqual(lines.count, 1, lines.joined(separator: "\n"))
    for line in lines {
      XCTAssertTrue(line.contains("powrót z tła; POST po odmowie"), line)
      try assertOpenTraceShape(line)
    }
  }

  /// Linia stanu („Łączę…", zdanie Kopiuj/Wklej) nakłada się na górę powierzchni: siatka i panel zostają
  /// w tym samym rozmiarze, kiedy się pojawia i znika.
  func testStatusLineDoesNotResizeTerminal() async throws {
    let h = try harness()
    let socket = try await connect(h)
    try await Task.sleep(for: .milliseconds(200))
    let calls = h.surface.resizeCalls
    let sent = resizes(socket).count
    // Zdanie w linii stanu daje pusta wklejka (kopia mówi wynik dymkiem apki).
    h.clipboard.text = nil
    h.screen.handlePasteCommand()
    h.screen.view.layoutIfNeeded()
    XCTAssertEqual(h.screen.noticeText, UICopy.terminalPasteEmpty)
    XCTAssertFalse(h.screen.statusBar.isHidden)
    let view = h.screen.view!
    let status = h.screen.statusBar.convert(h.screen.statusBar.bounds, to: view)
    let surface = h.surface.convert(h.surface.bounds, to: view)
    XCTAssertEqual(status.minY, surface.minY, accuracy: 0.5, "linia stanu leży na górze powierzchni")
    h.screen.session.suspend()
    h.screen.session.resume()
    await waitUntil { h.wire.sockets.count == 2 }
    h.screen.view.layoutIfNeeded()
    try await Task.sleep(for: .milliseconds(200))
    XCTAssertEqual(h.surface.resizeCalls, calls, "siatka bez zmian przy zdaniu i przy „Łączę…”")
    XCTAssertEqual(resizes(socket).count, sent, "bez `rs`")
    let grid = h.surface.gridSize
    XCTAssertEqual(h.wire.connects.last?.grid, TerminalGrid(cols: grid.cols, rows: grid.rows))
  }

  /// `err` (np. obcy kontroler przejął terminal): zdanie serwera i „Spróbuj od nowa" bez samoczynnego łączenia;
  /// gest łączy od nowa.
  func testServerErrorShowsSentenceAndRetry() async throws {
    let h = try harness()
    let socket = try await connect(h)
    socket.emit(.frame(.error(message: "Terminal przejął inny kontroler.")))
    await waitUntil { h.session.phase.isHalted }
    await waitUntil { h.screen.statusLabel.text == "Terminal przejął inny kontroler." }
    XCTAssertFalse(h.screen.statusBar.isHidden)
    XCTAssertFalse(h.screen.statusButton.isHidden)
    XCTAssertEqual(h.screen.statusButton.title(for: .normal), UICopy.terminalRetry)
    try await Task.sleep(for: .milliseconds(100))
    XCTAssertEqual(h.wire.sockets.count, 1, "bez samoczynnego łączenia")
    h.screen.statusButton.sendActions(for: .primaryActionTriggered)
    await waitUntil { h.wire.sockets.count == 2 }
    XCTAssertEqual(h.wire.sockets.count, 2)
  }

  /// Id terminala trafia do nawigacji raz (trasa „Nowy terminal" nie może założyć drugiej powłoki).
  func testTerminalIdentifiedOnce() async throws {
    let h = try harness()
    var ids: [String] = []
    h.screen.onTerminalIdentified = { ids.append($0) }
    _ = try await connect(h)
    await waitUntil { !ids.isEmpty }
    XCTAssertEqual(ids, [FakeWire.id])
    XCTAssertEqual(h.screen.terminalId, FakeWire.id)
  }

  // MARK: - „×"

  /// Przyciski w pasku nawigacji idą za OSTATNIM podpiętym ekranem (odtworzony widok, inna trasa), w obu
  /// kolejnościach podpięcia i zejścia: zejście ani spóźniony stan starego ekranu nie ruszają nowego, „×" trafia
  /// do nowego.
  func testChromeFollowsLastAttachedScreen() throws {
    for oldGoesFirst in [true, false] {
      let old = try harness()
      let new = try harness()
      let chrome = TerminalChrome()
      old.screen.chrome = chrome
      if oldGoesFirst { old.screen.shutdown() }
      new.screen.chrome = chrome
      if !oldGoesFirst { old.screen.shutdown() }
      XCTAssertTrue(chrome.isAttached, "\(oldGoesFirst)")
      old.screen.closeTapped()
      XCTAssertEqual(chrome.close, .idle, "\(oldGoesFirst): stan starego ekranu nie wchodzi do paska")
      chrome.tapClose()
      XCTAssertEqual(chrome.close, .armed, "\(oldGoesFirst): „×” nowego ekranu")
      new.screen.shutdown()
      XCTAssertFalse(chrome.isAttached, "\(oldGoesFirst): bez ekranu bez przycisków")
    }
  }

  /// Pierwsze „×" uzbraja (zdanie zamiast ikony), drugie zamyka powłokę (`DELETE`) i ekran znika.
  func testCloseNeedsTwoPressesThenScreenCloses() async throws {
    let h = try harness()
    _ = try await connect(h)
    var closed = 0
    h.screen.onClose = { closed += 1 }
    let chrome = TerminalChrome()
    h.screen.chrome = chrome
    XCTAssertTrue(chrome.isAttached)
    XCTAssertEqual(chrome.close, .idle)
    chrome.tapClose()
    XCTAssertEqual(chrome.close, .armed, "„×” w pasku nawigacji pokazuje „Na pewno?”")
    try await Task.sleep(for: .milliseconds(100))
    XCTAssertTrue(h.wire.closed.isEmpty, "pierwsze „×” niczego nie zamyka")
    XCTAssertEqual(closed, 0)
    chrome.tapClose()
    await waitUntil { closed == 1 }
    XCTAssertEqual(h.wire.closed, [FakeWire.id])
    XCTAssertEqual(closed, 1)
    XCTAssertEqual(h.session.phase, .idle, "gniazdo zamknięte")
    XCTAssertFalse(chrome.isAttached, "ekran zszedł — pasek bez przycisków terminala")
  }

  /// Cmd+X to „×" z klawiatury: pierwsze uzbraja i mówi to czytnikowi, drugie zamyka powłokę. Bez
  /// „×" w pasku nawigacji (okno Cmd+F/Cmd+G) i pod arkuszem skrót jest wyłączony i niczego nie uzbraja.
  func testCommandXArmsThenClosesOnlyWithCloseButtonOnScreen() async throws {
    let h = try harness(hardware: true)
    _ = try await connect(h)
    var closed = 0
    h.screen.onClose = { closed += 1 }
    let spoken = SpokenBox()
    h.screen.announcer = Announcer(sink: { spoken.lines.append($0.text) }, now: Date.init)
    let commandX = TerminalHardwareKey("x", command: true)
    let command = try XCTUnwrap(h.screen.container.keyCommands?.first { $0.input == "x" && $0.modifierFlags == .command })
    let action = try XCTUnwrap(command.action)

    XCTAssertFalse(h.screen.container.canPerformAction(action, withSender: command), "okno Cmd+F/Cmd+G: bez „×”")
    h.screen.handleKey(commandX)
    h.screen.handleKey(commandX)
    try await Task.sleep(for: .milliseconds(100))
    XCTAssertTrue(h.wire.closed.isEmpty, "bez „×” w pasku nawigacji Cmd+X niczego nie zamyka")

    let chrome = TerminalChrome()
    h.screen.chrome = chrome
    h.screen.sheetAbove = { _ in .held }
    XCTAssertFalse(h.screen.container.canPerformAction(action, withSender: command), "arkusz nad terminalem")
    h.screen.handleKey(commandX)
    XCTAssertEqual(chrome.close, .idle, "pod arkuszem skrót milczy")

    h.screen.sheetAbove = { _ in .nothing }
    XCTAssertTrue(h.screen.container.canPerformAction(action, withSender: command))
    h.screen.handleKey(commandX)
    XCTAssertEqual(chrome.close, .armed, "pierwsze Cmd+X uzbraja „×”")
    XCTAssertEqual(spoken.lines, [UICopy.terminalCloseConfirmSpoken(.mac)])
    try await Task.sleep(for: .milliseconds(100))
    XCTAssertTrue(h.wire.closed.isEmpty, "pierwsze Cmd+X niczego nie zamyka")
    h.screen.handleKey(commandX)
    await waitUntil { closed == 1 }
    XCTAssertEqual(h.wire.closed, [FakeWire.id])
    XCTAssertEqual(closed, 1)
  }

  /// `DELETE` odrzucony: zdanie serwera, ekran zostaje, a sesja łączy się z powłoką z powrotem.
  func testCloseFailureKeepsScreenAndReconnects() async throws {
    let h = try harness(closeOutcome: .failed("Nie wolno."))
    _ = try await connect(h)
    var closed = 0
    h.screen.onClose = { closed += 1 }
    h.session.stop()  // magazyn zatrzymuje sesję przed `DELETE`
    h.screen.closeTapped()
    h.screen.closeTapped()
    await waitUntil { h.screen.noticeText == "Nie wolno." }
    XCTAssertEqual(closed, 0)
    await waitUntil { h.wire.sockets.count == 2 }
    XCTAssertEqual(h.wire.sockets.count, 2, "powłoka żyje — ekran łączy się z nią znowu")
  }

  /// `DELETE` bez odpowiedzi (sieć, limit czasu): powłoka mogła się zakończyć, więc ekran NIE łączy się sam
  /// (`POST` założyłby nową) — zdanie i „Spróbuj od nowa"; gest łączy, a „×" próbuje zamknąć jeszcze raz.
  func testCloseWithoutAnswerWaitsForGesture() async throws {
    let h = try harness(closeOutcome: .failed(nil))
    _ = try await connect(h)
    var closed = 0
    h.screen.onClose = { closed += 1 }
    h.session.stop()  // magazyn zatrzymuje sesję przed `DELETE`
    h.screen.closeTapped()
    h.screen.closeTapped()
    await waitUntil { h.screen.statusLabel.text == UICopy.terminalCloseUnknown }
    XCTAssertEqual(h.screen.statusLabel.text, UICopy.terminalCloseUnknown)
    XCTAssertEqual(h.screen.statusButton.title(for: .normal), UICopy.terminalRetry)
    XCTAssertFalse(h.screen.statusButton.isHidden)
    try await Task.sleep(for: .milliseconds(150))
    XCTAssertEqual(h.wire.sockets.count, 1, "bez samoczynnego łączenia")
    XCTAssertEqual(h.wire.opens.count, 1, "bez `POST`")
    XCTAssertEqual(closed, 0)

    h.screen.statusButton.sendActions(for: .primaryActionTriggered)
    await waitUntil { h.wire.sockets.count == 2 }
    XCTAssertEqual(h.wire.sockets.count, 2, "gest łączy z powrotem")
    XCTAssertNotEqual(h.screen.statusLabel.text, UICopy.terminalCloseUnknown)
  }

  /// Ekran zszedł (zmiana trasy) w trakcie `DELETE`: spóźniony wynik nie woła `onClose` i nie łączy się znowu.
  func testLateCloseResultAfterShutdownIsIgnored() async throws {
    for outcome in [TerminalCloseOutcome.closed, .failed("Nie wolno.")] {
      let h = try harness(closeOutcome: outcome)
      _ = try await connect(h)
      var closed = 0
      h.screen.onClose = { closed += 1 }
      h.wire.holdClose = true
      h.screen.closeTapped()
      h.screen.closeTapped()
      await waitUntil { !h.wire.closed.isEmpty }
      h.screen.shutdown()
      h.wire.release()
      try await Task.sleep(for: .milliseconds(150))
      XCTAssertEqual(closed, 0, "\(outcome): onClose po zejściu ekranu")
      XCTAssertNil(h.screen.noticeText, "\(outcome): ogłoszenie po zejściu ekranu")
      XCTAssertEqual(h.wire.sockets.count, 1, "\(outcome): łączenie po zejściu ekranu")
      XCTAssertEqual(h.surface.log.last, "close", "\(outcome): renderer zwolniony")
    }
  }

  /// Odmowa `DELETE` przyszła w tle: gniazdo dopiero po powrocie sceny na wierzch, nie w tle.
  func testRefusedCloseInBackgroundReconnectsOnActivation() async throws {
    let h = try harness(closeOutcome: .failed("Nie wolno."))
    _ = try await connect(h)
    h.session.stop()  // magazyn zatrzymuje sesję przed `DELETE`
    h.wire.holdClose = true
    h.screen.closeTapped()
    h.screen.closeTapped()
    await waitUntil { !h.wire.closed.isEmpty }
    var active = false
    h.screen.sceneIsActive = { active }
    h.wire.release()
    await waitUntil { h.screen.noticeText == "Nie wolno." }
    try await Task.sleep(for: .milliseconds(150))
    XCTAssertEqual(h.wire.sockets.count, 1, "w tle bez gniazda")
    active = true
    NotificationCenter.default.post(name: UIScene.didActivateNotification, object: nil)
    await waitUntil { h.wire.sockets.count == 2 }
    XCTAssertEqual(h.wire.sockets.count, 2, "po powrocie łączy z powrotem")
  }

  // MARK: - Ślad powrotu z tła

  /// Tło → siatki z tła; aktywacja → próbki układu, pierwszy ekran nowego gniazda i porcje bajtów po nim; po oknie
  /// linie z samych liczb (tło, ekran i bajty; układ), jeden `admit` na powrót (bajty pierwszego ekranu należą do
  /// niego, treść nie trafia do śladu).
  func testReturnFromBackgroundTracesLayoutOnce() async throws {
    let h = try harness()
    var lines: [String] = []
    h.screen.trace = { lines.append($0) }
    h.screen.admitOpenTrace = { _ in false }
    var admits = 0
    h.screen.admitReturnTrace = { _ in
      admits += 1
      return true
    }
    h.screen.returnTraceWindow = .seconds(1)
    let first = try await connect(h)
    first.emit(.bytes(Data("a".utf8)))
    await waitUntil { h.surface.log.contains("reset") }
    let grid = h.surface.gridSize
    var state = UIScene.ActivationState.background
    h.screen.sceneIsActive = nil
    h.screen.sceneActivation = { state }
    NotificationCenter.default.post(name: UIScene.didEnterBackgroundNotification, object: nil)
    try await Task.sleep(for: .milliseconds(30))
    h.session.suspend()
    h.window.frame = CGRect(x: 0, y: 0, width: 400, height: 300)
    h.window.layoutIfNeeded()
    let small = h.surface.gridSize
    h.window.frame = CGRect(x: 0, y: 0, width: 800, height: 600)
    h.window.layoutIfNeeded()
    XCTAssertNotEqual(small.cols, grid.cols)

    state = .foregroundActive
    NotificationCenter.default.post(name: UIScene.didActivateNotification, object: nil)
    try await Task.sleep(for: .milliseconds(30))
    h.session.resume()
    await waitUntil { h.wire.sockets.count == 2 }
    let second = try XCTUnwrap(h.wire.sockets.last)
    second.emit(.opened)
    await waitUntil { h.session.phase == .live }
    h.ticks.elapsed += .milliseconds(100)
    second.emit(.bytes(Data("SEKRET".utf8)))
    await waitUntil { h.surface.log.filter { $0 == "reset" }.count == 2 }
    h.ticks.elapsed += .milliseconds(50)
    second.emit(.bytes(Data("SEKRET2".utf8)))
    await waitUntil { lines.count >= 2 }

    let height = Int(h.screen.container.bounds.height.rounded())
    let guide = h.screen.view.keyboardLayoutGuide.layoutFrame.minY
    let keyboard = Int((h.screen.view.bounds.maxY - guide).rounded())
    let corner = h.screen.container.convert(h.screen.container.bounds.origin, to: nil)
    let position = "x\(Int(corner.x.rounded())) y\(Int(corner.y.rounded()))"
    XCTAssertEqual(lines, [
      "terminal: powrót z tła; tło t\(small.cols)×\(small.rows) t\(grid.cols)×\(grid.rows); ekran +100 ms; bajty +150 7B",
      "terminal: powrót z tła; układ +0 \(height)pt \(position) \(grid.cols)×\(grid.rows) p0 w0 k\(keyboard) bez fokusu",
    ])
    try await Task.sleep(for: .milliseconds(300))
    XCTAssertEqual(lines.count, 2, "jeden ślad na powrót")
    XCTAssertEqual(admits, 1, "podbudżet liczy powroty, nie linie")
  }

  /// Nagranie iPada (build 3549): chwilowy układ przyszedł, zanim zadanie z powiadomienia sceny dostało głównego aktora,
  /// więc ślad go nie widział. Teraz zbieranie rusza synchronicznie od `willDeactivate`: zmiana siatki i pominięty
  /// układ przed tłem i w tle trafiają do sekcji „tło” ze stanem sceny w chwili układu.
  func testReturnTraceCollectsFromDeactivationWithSceneState() async throws {
    let h = try harness()
    var lines: [String] = []
    h.screen.trace = { lines.append($0) }
    h.screen.admitOpenTrace = { _ in false }
    h.screen.admitReturnTrace = { _ in true }
    h.screen.returnTraceWindow = .milliseconds(200)
    _ = try await connect(h)
    let grid = h.surface.gridSize
    var state = UIScene.ActivationState.foregroundActive
    h.screen.sceneIsActive = nil
    h.screen.sceneActivation = { state }
    let center = NotificationCenter.default
    func layout(height: CGFloat) -> CGFloat {
      h.window.frame = CGRect(x: 0, y: 0, width: 800, height: height)
      h.window.layoutIfNeeded()
      return h.surface.bounds.height.rounded()
    }

    // Między powiadomieniem a układem żadnego `await`: zadanie nie zdąży ruszyć.
    state = .foregroundInactive
    center.post(name: UIScene.willDeactivateNotification, object: nil)
    _ = layout(height: 300)
    let half = h.surface.gridSize
    XCTAssertNotEqual(half.rows, grid.rows)
    h.surface.skipsLayout = true
    let skippedInactive = layout(height: 600)
    _ = layout(height: 600)  // ten sam układ jeszcze raz: zlewa się
    state = .background
    center.post(name: UIScene.didEnterBackgroundNotification, object: nil)
    let skippedBackground = layout(height: 400)
    state = .foregroundInactive
    h.surface.skipsLayout = false
    _ = layout(height: 600)
    state = .foregroundActive
    center.post(name: UIScene.didActivateNotification, object: nil)
    await waitUntil { lines.count >= 2 }

    XCTAssertEqual(
      lines.first,
      "terminal: powrót z tła; tło n\(half.cols)×\(half.rows) n~\(Int(skippedInactive))pt "
        + "t~\(Int(skippedBackground))pt n\(grid.cols)×\(grid.rows); ekran brak; bajty brak")
    XCTAssertEqual(lines.count, 2, "\(lines)")
    for line in lines { XCTAssertLessThanOrEqual(line.count, 200, line) }
  }

  /// Samo `willDeactivate` → `didActivate` (bez tła) nie zbiera; ponowne tło w oknie kasuje je bez linii;
  /// zamknięcie ekranu w oknie też.
  func testReturnTraceOnlyAfterBackgroundAndDiesWithNextBackground() async throws {
    let h = try harness()
    var lines: [String] = []
    h.screen.trace = { lines.append($0) }
    h.screen.admitOpenTrace = { _ in false }
    h.screen.admitReturnTrace = { _ in true }
    h.screen.returnTraceWindow = .milliseconds(200)
    _ = try await connect(h)
    let center = NotificationCenter.default
    center.post(name: UIScene.willDeactivateNotification, object: nil)
    center.post(name: UIScene.didActivateNotification, object: nil)
    try await Task.sleep(for: .milliseconds(350))
    XCTAssertEqual(lines, [], "bez tła bez śladu")

    center.post(name: UIScene.didEnterBackgroundNotification, object: nil)
    center.post(name: UIScene.didActivateNotification, object: nil)
    try await Task.sleep(for: .milliseconds(60))
    center.post(name: UIScene.didEnterBackgroundNotification, object: nil)
    try await Task.sleep(for: .milliseconds(350))
    XCTAssertEqual(lines, [], "ponowne tło w oknie kasuje zbieranie")

    center.post(name: UIScene.didActivateNotification, object: nil)
    await waitUntil { lines.count >= 2 }
    XCTAssertEqual(lines.count, 2, "powrót po drugim tle: jeden ślad (tło i układ)")

    center.post(name: UIScene.didEnterBackgroundNotification, object: nil)
    center.post(name: UIScene.didActivateNotification, object: nil)
    try await Task.sleep(for: .milliseconds(60))
    h.screen.shutdown()
    try await Task.sleep(for: .milliseconds(350))
    XCTAssertEqual(lines.count, 2, "zamknięty ekran nie pisze")
  }

  /// Okno nad ekranem (Cmd+F/Cmd+G): koniec programu zamyka okno.
  func testExitClosesPopupScreen() async throws {
    let h = try harness()
    h.screen.closesOnExit = true
    var closed = 0
    h.screen.onClose = { closed += 1 }
    let socket = try await connect(h)
    socket.emit(.frame(.exit))
    await waitUntil { closed == 1 }
    XCTAssertEqual(closed, 1)
  }

  // MARK: - Pas w kolorze krawędzi

  private static let navy = TerminalEdgeColor(red8: 0x1a, green8: 0x1b, blue8: 0x26)
  private static let status = TerminalEdgeColor(red8: 0x3b, green8: 0x42, blue8: 0x61)
  private static let side = TerminalEdgeColor(red8: 0x16, green8: 0x16, blue8: 0x1e)

  /// Ekran z pasem jak w oknie (8 pt z boków, 12 pt u dołu) i krawędziami programu pełnoekranowego.
  private func edgeHarness(hardware: Bool) throws -> Harness {
    let h = try harness(hardware: hardware)
    h.surface.edges = TerminalEdges(
      background: Self.navy, leading: Array(repeating: Self.side, count: 100),
      trailing: Array(repeating: Self.navy, count: 100), bottom: Array(repeating: Self.status, count: 200))
    h.screen.paintsEdges = true
    h.screen.windowInsets = UIEdgeInsets(top: 0, left: 8, bottom: 12, right: 8)
    h.screen.view.layoutIfNeeded()
    return h
  }

  private func color(_ fill: TerminalEdgeFill, _ point: CGPoint) -> TerminalEdgeColor? {
    fill.bands.last { $0.rect.contains(point) }?.color
  }

  /// Trasa terminala: pasa nie ma, a powierzchnia nie ma słuchacza krawędzi (niczego nie liczy).
  func testRouteHasNoEdgeFill() throws {
    let h = try harness()
    h.screen.view.layoutIfNeeded()
    XCTAssertFalse(h.screen.paintsEdges)
    XCTAssertTrue(h.screen.edgeFill.isHidden)
    XCTAssertTrue(h.screen.edgeFill.bands.isEmpty)
    XCTAssertNil(h.surface.onEdgesChanged, "trasa nie słucha krawędzi")
  }

  /// Okno: nakładka sięga pasa okna, leży nad stosem i pod linią stanu, bez dotyku; maluje boki i dół poza siatką.
  func testEdgeFillPaintsBandOutsideGrid() throws {
    let h = try edgeHarness(hardware: true)
    let view = h.screen.view!
    let fill = h.screen.edgeFill
    XCTAssertNotNil(h.surface.onEdgesChanged, "okno słucha krawędzi")
    XCTAssertEqual(fill.frame, CGRect(x: -8, y: 0, width: view.bounds.width + 16, height: view.bounds.height + 12))
    XCTAssertFalse(fill.isUserInteractionEnabled)
    XCTAssertTrue(fill.accessibilityElementsHidden)
    let order = view.subviews
    let fillIndex = try XCTUnwrap(order.firstIndex { $0 === fill })
    XCTAssertLessThan(fillIndex, try XCTUnwrap(order.firstIndex { $0 === h.screen.statusBar }), "linia stanu nad pasem")
    let stackIndex = try XCTUnwrap(order.firstIndex { $0 === h.screen.container.superview })
    XCTAssertLessThan(stackIndex, fillIndex, "pas nad stosem")
    let grid = h.surface.convert(h.surface.gridFrame, to: fill)
    // Jeden przebieg układu wystarcza: przy pierwszym siatka powstaje dopiero po układzie ekranu (zmiana siatki).
    XCTAssertEqual(color(fill, CGPoint(x: 2, y: grid.minY + 10)), Self.side, "pas okna z lewej")
    XCTAssertEqual(color(fill, CGPoint(x: fill.bounds.maxX - 2, y: grid.minY + 10)), Self.navy, "pas okna z prawej")
    XCTAssertEqual(color(fill, CGPoint(x: grid.midX, y: fill.bounds.maxY - 2)), Self.status, "pas okna u dołu")
    for band in fill.bands {
      XCTAssertTrue(band.rect.intersection(grid.insetBy(dx: 1, dy: 1)).isEmpty, "pas w siatce: \(band.rect)")
    }
    // Atrapa bez krawędzi: pasa nie ma.
    h.surface.edges = nil
    h.surface.onEdgesChanged?()
    XCTAssertTrue(fill.bands.isEmpty)
  }

  /// Zmiana rozmiaru BEZ zmiany liczby komórek (SwiftTerm nie daje wtedy sygnału) przesuwa pas razem z układem.
  func testEdgeFillFollowsLayoutWithoutGridChange() throws {
    let h = try edgeHarness(hardware: true)
    let fill = h.screen.edgeFill
    let grid = h.surface.gridSize
    let calls = h.surface.resizeCalls
    h.window.frame = CGRect(x: 0, y: 0, width: 804, height: 600)
    h.window.layoutIfNeeded()
    XCTAssertTrue(h.surface.gridSize == grid, "ta sama siatka: \(h.surface.gridSize)")
    XCTAssertEqual(h.surface.resizeCalls, calls)
    XCTAssertEqual(fill.bounds.width, 804 + 16)
    let right = try XCTUnwrap(fill.bands.first { $0.rect.contains(CGPoint(x: fill.bounds.maxX - 1, y: 30)) })
    XCTAssertEqual(right.rect.maxX, fill.bounds.maxX, "pas z prawej sięga nowej krawędzi")
    let cell = h.surface.convert(h.surface.gridFrame, to: fill)
    XCTAssertEqual(right.rect.minX, cell.maxX, accuracy: 1, "i zaczyna się na siatce (z pikselem zakładki)")
  }

  /// Pasek klawiszy i pas pod nim zostają tłem ekranu; schowany pasek (klawiatura sprzętowa) oddaje dół pasowi.
  func testEdgeFillLeavesKeyBarAndFollowsIt() throws {
    let h = try edgeHarness(hardware: false)
    let fill = h.screen.edgeFill
    let bar = h.screen.keyBar
    XCTAssertFalse(bar.isHidden)
    let barFrame = bar.convert(bar.bounds, to: fill)
    for x in [CGFloat(2), barFrame.midX, fill.bounds.maxX - 2] {
      XCTAssertNil(color(fill, CGPoint(x: x, y: barFrame.midY)), "pasek klawiszy w x=\(x)")
      XCTAssertNil(color(fill, CGPoint(x: x, y: fill.bounds.maxY - 2)), "pas pod paskiem w x=\(x)")
    }
    h.screen.hardwareKeyboard = { true }
    h.screen.updateKeyBar()
    h.screen.view.layoutIfNeeded()
    XCTAssertTrue(bar.isHidden)
    XCTAssertEqual(color(fill, CGPoint(x: barFrame.midX, y: fill.bounds.maxY - 2)), Self.status, "dół pod siatką")
  }

  /// Sygnał powierzchni („krawędzie się zmieniły”) maluje pas od nowa.
  func testEdgeFillRepaintsOnSignal() throws {
    let h = try edgeHarness(hardware: true)
    let fill = h.screen.edgeFill
    XCTAssertEqual(color(fill, CGPoint(x: 2, y: 10)), Self.side)
    h.surface.edges?.leading[0] = Self.status
    h.surface.onEdgesChanged?()
    XCTAssertEqual(color(fill, CGPoint(x: 2, y: 10)), Self.status)
  }
}

// MARK: - Atrapy

/// Powierzchnia bez renderera: siatka z rozmiaru (komórka 10×20 pt), zapis wywołań.
@MainActor
final class FakeSurface: UIView, TerminalSurface {
  var onInput: ((String) -> Void)?
  var onPaste: ((String) -> Void)?
  var onResize: ((Int, Int) -> Void)?
  var onScroll: ((Int, TerminalCell?) -> Void)?
  var onCopy: (() -> Void)?
  var onFocus: (() -> Void)?
  var onKeyRepeatEnded: ((TerminalKeyRepeatEnd) -> Void)?
  var onLayoutSkipped: ((CGFloat) -> Void)?
  /// Układ nie dochodzi do „renderera” (jak `SwiftTermSurface` na nieaktywnej scenie): siatka zostaje.
  var skipsLayout = false
  var view: UIView { self }
  var selection: String?
  var screenText = ""
  private(set) var grid = (cols: 0, rows: 0)
  private(set) var resizeCalls = 0
  private(set) var log: [String] = []
  /// `hardwareKeysEnded` z kontenera: `cancelled` każdego wywołania.
  private(set) var keysEnded: [Bool] = []
  /// Krawędzie do pasa; `nil` = atrapa ich nie zna.
  var edges: TerminalEdges?
  var onEdgesChanged: (() -> Void)?
  var edgeColors: TerminalEdges? { edges }
  var gridFrame: CGRect { CGRect(x: 0, y: 0, width: CGFloat(grid.cols * 10), height: CGFloat(grid.rows * 20)) }

  /// Ile razy ekran zdjął zaznaczenie.
  private(set) var selectionCleared = 0

  var gridSize: (cols: Int, rows: Int) { grid }
  var selectedText: String? { selection }
  var visibleText: String { screenText }

  func clearSelection() {
    selectionCleared += 1
    selection = nil
  }

  func feed(_ data: Data) { log.append("feed") }
  func reset() { log.append("reset") }
  func close() { log.append("close") }
  func hardwareKeysEnded(_ presses: Set<UIPress>, cancelled: Bool) { keysEnded.append(cancelled) }

  override func layoutSubviews() {
    super.layoutSubviews()
    if skipsLayout {
      onLayoutSkipped?(bounds.height)
      return
    }
    let next = (cols: Int(bounds.width / 10), rows: Int(bounds.height / 20))
    guard next != grid else { return }
    grid = next
    resizeCalls += 1
    onResize?(next.cols, next.rows)
  }
}

final class RecordingSocket: TerminalSocketing, @unchecked Sendable {
  let events: AsyncStream<TerminalSocketEvent>
  private let continuation: AsyncStream<TerminalSocketEvent>.Continuation
  private let lock = NSLock()
  private var frames: [TerminalClientFrame] = []

  init() { (events, continuation) = AsyncStream<TerminalSocketEvent>.makeStream() }

  var sent: [TerminalClientFrame] { lock.withLock { frames } }

  func emit(_ event: TerminalSocketEvent) { continuation.yield(event) }

  /// Serwer zrywa gniazdo.
  func drop() {
    continuation.yield(.closed)
    continuation.finish()
  }

  func send(_ frame: TerminalClientFrame) async -> Bool {
    lock.withLock { frames.append(frame) }
    return true
  }

  func close() { drop() }
}

/// Atrapa drutu jak rejestr serwera: slot 1 to terminal ``id``, każdy `slot: next` zakłada KOLEJNĄ powłokę.
final class FakeWire: TerminalTransporting, @unchecked Sendable {
  static let id = "0123456789abcdef"
  struct Connect: Equatable {
    let id: String
    let fresh: Bool
    let grid: TerminalGrid?
    /// Gniazdo bez `POST` (`direct=1`).
    var direct = false
  }

  private let lock = NSLock()
  private var opened: [RecordingSocket] = []
  private var bodies: [TerminalOpenBody] = []
  private var upgrades: [Connect] = []
  private var allocated = 0
  @MainActor var closed: [String] = []
  @MainActor var closeOutcome: TerminalCloseOutcome = .closed
  /// `DELETE` czeka na ``release()`` (test: ekran schodzi albo scena idzie w tło w trakcie żądania).
  @MainActor var holdClose = false
  @MainActor private var held: [CheckedContinuation<Void, Never>] = []

  @MainActor func waitIfHeld() async {
    guard holdClose else { return }
    await withCheckedContinuation { held.append($0) }
  }

  @MainActor func release() {
    holdClose = false
    held.forEach { $0.resume() }
    held.removeAll()
  }

  /// `POST` czeka na ``releaseOpen()`` (test: czas odpowiedzi w śladzie otwarcia).
  @MainActor var holdOpen = false
  @MainActor private var heldOpens: [CheckedContinuation<Void, Never>] = []

  @MainActor func waitIfOpenHeld() async {
    guard holdOpen else { return }
    await withCheckedContinuation { heldOpens.append($0) }
  }

  @MainActor func releaseOpen() {
    holdOpen = false
    heldOpens.forEach { $0.resume() }
    heldOpens.removeAll()
  }

  var sockets: [RecordingSocket] { lock.withLock { opened } }
  var opens: [TerminalOpenBody] { lock.withLock { bodies } }
  var connects: [Connect] { lock.withLock { upgrades } }

  func openTerminal(_ body: TerminalOpenBody) async throws(TransportError) -> TerminalOpenResponse {
    let slot: Int = lock.withLock {
      bodies.append(body)
      switch body.slot {
      case let .number(value)?: return value
      case .next?:
        allocated += 1
        return allocated
      case nil: return 1
      }
    }
    await waitIfOpenHeld()
    let id = slot == 1 ? Self.id : String(format: "%016lx", slot)
    do {
      return try JSONDecoder().decode(
        TerminalOpenResponse.self, from: Data(#"{"id":"\#(id)","slot":\#(slot),"role":"shell"}"#.utf8))
    } catch {
      throw .invalidResponse("atrapa")
    }
  }

  func terminals() async throws(TransportError) -> TerminalList { throw .invalidResponse("atrapa") }

  func terminalHistory(id: String, lines: Int) async throws(TransportError) -> TerminalHistory {
    throw .invalidResponse("atrapa")
  }

  func closeTerminal(id: String) async throws(TransportError) {}

  func checkTerminalInput() async throws(MutationRefusal) {}

  func terminalSocket(
    id: String, fresh: Bool, direct: Bool, grid: TerminalGrid?
  ) throws(TransportError) -> any TerminalSocketing {
    let socket = RecordingSocket()
    lock.withLock {
      opened.append(socket)
      upgrades.append(Connect(id: id, fresh: fresh, grid: grid, direct: direct))
    }
    return socket
  }
}
