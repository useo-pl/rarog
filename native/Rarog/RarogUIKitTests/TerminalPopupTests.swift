import RarogContract
import RarogCore
import RarogTransport
@testable import RarogUI
import UIKit
import XCTest

/// Okno terminala (Cmd+F, Cmd+G) w oknie UIKit, z prawdziwą sesją na atrapie
/// drutu (`FakeWire`) i atrapą powierzchni (`FakeSurface`) z `TerminalScreenTests`. Treść syntetyczna.
@MainActor
final class TerminalPopupTests: XCTestCase {
  private struct Harness {
    let popup: TerminalPopupController
    let navigation: UINavigationController
    let wire: FakeWire
    let session: TerminalSession
    let window: UIWindow
    let dismissals: Counter
  }

  private final class Counter {
    var value = 0
  }

  private func harness(role: TerminalRole = .lazygit) throws -> Harness {
    let wire = FakeWire()
    let cwd = "/Users/demo/Projects/rarog"
    let target = try XCTUnwrap(TerminalTarget.popup(cwd: cwd, role: role))
    let session = TerminalSession(target: target, transport: wire, timing: TerminalTiming(backoff: [.milliseconds(20)]))
    let screen = TerminalScreenViewController(session: session, surface: FakeSurface()) { id in
      wire.closed.append(id)
      return .closed
    }
    screen.hardwareKeyboard = { true }
    screen.sceneIsActive = { true }
    screen.announcer = Announcer(sink: { _ in }, now: Date.init)
    let popup = TerminalPopupController(screen: screen, request: TerminalPopupRequest(cwd: cwd, role: role))
    let dismissals = Counter()
    popup.onDismiss = { dismissals.value += 1 }
    let navigation = TerminalPopupController.window(popup)
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 900, height: 700))
    window.rootViewController = navigation
    window.makeKeyAndVisible()
    // Kontener ładuje widok korzenia dopiero przy układzie: bez tego pasek i reguła Esc jeszcze nie istnieją.
    navigation.view.layoutIfNeeded()
    addTeardownBlock { @MainActor in
      screen.shutdown()
      window.isHidden = true
    }
    return Harness(
      popup: popup, navigation: navigation, wire: wire, session: session, window: window, dismissals: dismissals)
  }

  private func connect(_ h: Harness) async throws -> RecordingSocket {
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

  private func inputs(_ socket: RecordingSocket) -> [String] {
    socket.sent.compactMap { if case let .input(text) = $0 { text } else { nil } }
  }

  /// Treść terminala w oknie stoi 16 pt od boków arkusza (8 pt ekran od okna i 8 pt siatka od ekranu): litery
  /// nie dotykają brzegu, a siatka liczy się z szerokości bez odstępów.
  func testSurfaceStandsInsetInsideWindow() throws {
    let h = try harness()
    h.navigation.view.layoutIfNeeded()
    let screenView = try XCTUnwrap(h.popup.screen.view)
    let surface = h.popup.screen.surface.view
    let inner = surface.convert(surface.bounds, to: screenView)
    let inset = TerminalScreenViewController.sideInset
    XCTAssertEqual(inner.minX, inset, accuracy: 0.5, "odstęp z lewej: \(inner)")
    XCTAssertEqual(screenView.bounds.width - inner.maxX, inset, accuracy: 0.5, "odstęp z prawej: \(inner)")
    let outer = screenView.convert(screenView.bounds, to: h.popup.view)
    XCTAssertEqual(outer.minX, WindowLayout.contentInset, accuracy: 0.5, "ekran terminala 8 pt od boku okna")
    XCTAssertEqual(h.popup.screen.surface.gridSize.cols, Int(inner.width / 10), "kolumny z szerokości bez odstępów")
  }

  /// Okno stoi w pasku nawigacji systemu jak każde okno apki: „×” z lewej (tylko odpina),
  /// tytuł „RODZAJ projekt”, „⋯" z prawej. Nagłówek ekranu — z „×", który ZABIJA powłokę — znika.
  func testSystemBarReplacesScreenHeader() throws {
    let h = try harness()
    h.navigation.view.layoutIfNeeded()
    XCTAssertNil(h.popup.screen.chrome, "„×” ekranu (DELETE) nie istnieje w oknie")
    XCTAssertTrue(TerminalPopupController.root(of: h.navigation) === h.popup)
    XCTAssertFalse(h.navigation.isNavigationBarHidden, "pasek systemu")
    XCTAssertTrue(h.popup.navigationItem.leftBarButtonItem === h.popup.closeItem, "„×” z lewej")
    XCTAssertEqual(h.popup.closeItem.accessibilityLabel, "Zamknij okno lazygita", "nazywa okno, nie powłokę")
    XCTAssertEqual(h.popup.navigationItem.rightBarButtonItems?.count, 1, "jeden przycisk: menu z prawej")
    XCTAssertTrue(h.popup.navigationItem.rightBarButtonItem === h.popup.menuItem, "menu z prawej")
    let title = try XCTUnwrap(h.popup.navigationItem.titleView)
    XCTAssertTrue(title === h.popup.titleView)
    XCTAssertEqual(title.accessibilityLabel, "lazygit: rarog", "czytnik słyszy rodzaj i projekt")
    XCTAssertTrue(title.isAccessibilityElement)
    XCTAssertTrue(title.accessibilityTraits.contains(.header))
    XCTAssertEqual(h.popup.kindLabel.attributedText?.string, "LAZYGIT", "rodzaj etykietą maszynową")
    XCTAssertEqual(h.popup.titleLabel.text, "rarog", "nazwa projektu w pasku")
    XCTAssertEqual(h.popup.menuItem.menu?.title, "rarog", "nazwa projektu w nagłówku menu „⋯”")
    let shell = try harness(role: .popup)
    XCTAssertEqual(shell.popup.titleView.accessibilityLabel, "terminal: rarog")
    XCTAssertEqual(shell.popup.closeItem.accessibilityLabel, "Zamknij okno terminala")
    XCTAssertTrue(h.popup.screen.closesOnExit, "`q` w lazygicie zamyka okno")
    XCTAssertEqual(h.navigation.view.tintColor, Palette.text, "achromatyczny odcień paska")
  }

  /// Linia stanu leży POD paskiem okna, nie pod jego przyciskami, i nakłada się na górę siatki. Zdanie czytelne, a przycisk akcji (w oknie „Spróbuj od nowa": koniec programu zamyka okno, więc
  /// „Uruchom ponownie" się tu nie pojawia) trafialny — także przy największym rozmiarze tekstu.
  func testStatusLineStandsUnderBar() async throws {
    for size in [UIContentSizeCategory.large, .accessibilityExtraExtraExtraLarge] {
      let h = try harness()
      h.window.traitOverrides.preferredContentSizeCategory = size
      let socket = try await connect(h)
      socket.emit(.frame(.error(message: "Terminal przejął inny kontroler.")))
      let screen = h.popup.screen
      await waitUntil { !screen.statusButton.isHidden }
      h.navigation.view.layoutIfNeeded()
      XCTAssertFalse(screen.statusBar.isHidden, "\(size): linia stanu widoczna")
      let bar = h.navigation.navigationBar.convert(h.navigation.navigationBar.bounds, to: h.window)
      let status = screen.statusBar.convert(screen.statusBar.bounds, to: h.window)
      let surface = screen.surface.view.convert(screen.surface.view.bounds, to: h.window)
      XCTAssertEqual(status.minY, bar.maxY, accuracy: 0.5, "\(size): linia stanu tuż pod paskiem")
      XCTAssertEqual(surface.minY, status.minY, accuracy: 0.5, "\(size): na górze siatki, nie nad nią")
      let button = screen.statusButton.convert(screen.statusButton.bounds, to: h.window)
      XCTAssertTrue(status.insetBy(dx: -0.5, dy: -0.5).contains(button), "\(size): przycisk w linii stanu: \(button)")
      let hit = h.window.hitTest(CGPoint(x: button.midX, y: button.midY), with: nil)
      XCTAssertTrue(
        hit.map { $0 === screen.statusButton || $0.isDescendant(of: screen.statusButton) } ?? false,
        "\(size): „\(UICopy.terminalRetry)” trafialne, trafiony: \(String(describing: hit))")
      h.window.isHidden = true
    }
  }

  /// Pasek jak w innych oknach: „×” z lewej, „⋯” z prawej, oba trafialne. Pod paskiem
  /// nie ma siatki, więc pasek nie oddaje dotyku niżej. Uchwyt arkusza tylko na telefonie.
  func testBarButtonsOnBothSides() async throws {
    let h = try harness(role: .popup)
    h.navigation.view.layoutIfNeeded()
    let bar = h.navigation.navigationBar
    let barFrame = bar.convert(bar.bounds, to: h.window)
    XCTAssertEqual(TerminalPopupController.showsGrabber, UIDevice.current.userInterfaceIdiom == .phone)
    // Zewnętrzne kontrolki paska: systemowy przycisk ma w sobie drugą kontrolkę, a dotyk bierze zewnętrzna; kontrolka
    // tytułu przyciskiem nie jest.
    let buttons = Self.views(in: bar).compactMap { $0 as? UIControl }.filter { control in
      let outer = !sequence(first: control as UIView, next: { $0.superview }).dropFirst().prefix { $0 !== bar }
        .contains { $0 is UIControl }
      guard outer, !h.popup.titleView.isDescendant(of: control) else { return false }
      return !control.isHidden && control.bounds.width >= 20 && control.bounds.width < bar.bounds.width / 2
    }
    let frames = buttons.map { $0.convert($0.bounds, to: h.window) }
    XCTAssertTrue(frames.contains { $0.midX < barFrame.midX }, "„×” z lewej: \(frames)")
    XCTAssertTrue(frames.contains { $0.midX > barFrame.midX }, "„⋯” z prawej: \(frames)")
    for (button, frame) in zip(buttons, frames) {
      let hit = h.window.hitTest(CGPoint(x: frame.midX, y: frame.midY), with: nil)
      XCTAssertTrue(hit.map { $0 === button || $0.isDescendant(of: button) } ?? false, "przycisk trafialny: \(frame)")
    }
  }

  private static func views(in root: UIView) -> [UIView] { [root] + root.subviews.flatMap { views(in: $0) } }

  /// Okno bierze klawiaturę: z klawiaturą sprzętową pierwszym respondentem jest powierzchnia terminala, a zanim
  /// ją weźmie — kontroler okna. Nigdy nikt spoza okna.
  func testWindowTakesKeyboard() async throws {
    let h = try harness(role: .popup)
    await waitUntil { h.popup.screen.surface.view.isFirstResponder || h.popup.isFirstResponder }
    XCTAssertTrue(
      h.popup.screen.surface.view.isFirstResponder || h.popup.isFirstResponder, "klawiaturę trzyma okno terminala")
  }

  /// „×” paska zamyka okno i tylko odpina, jak tap obok: bez `DELETE`, bez potwierdzenia, jednym tapem, także
  /// w lazygicie z żywym programem.
  func testCloseButtonClosesAndOnlyDetaches() async throws {
    for role in [TerminalRole.popup, .lazygit] {
      let h = try harness(role: role)
      _ = try await connect(h)
      let action = try XCTUnwrap(h.popup.closeItem.primaryAction)
      // Tak, jak pasek systemu (UIAction nie ma publicznego wywołania obsługi).
      action.perform(NSSelectorFromString("performWithSender:target:"), with: nil, with: nil)
      XCTAssertEqual(h.dismissals.value, 1, "\(role): jeden tap, bez „Na pewno?”")
      try await Task.sleep(for: .milliseconds(100))
      XCTAssertTrue(h.wire.closed.isEmpty, "\(role): panel w herdr żyje dalej")
    }
  }

  /// Gest „wstecz” czytnika (VoiceOver) zamyka okno jak „×” paska — i tylko odpina: bez `DELETE`, bez potwierdzenia,
  /// jednym gestem, także w lazygicie z żywym programem. Przy stronie historii na wierzchu okna nie zamyka: stronę
  /// zdejmuje kontener nawigacji.
  func testAccessibilityEscapeClosesAndOnlyDetaches() async throws {
    for role in [TerminalRole.popup, .lazygit] {
      let h = try harness(role: role)
      _ = try await connect(h)
      XCTAssertTrue(h.popup.accessibilityPerformEscape(), "\(role): gest wzięty")
      XCTAssertEqual(h.dismissals.value, 1, "\(role): jeden gest, bez „Na pewno?”")
      try await Task.sleep(for: .milliseconds(100))
      XCTAssertTrue(h.wire.closed.isEmpty, "\(role): panel w herdr żyje dalej")
    }
    let h = try harness(role: .popup)
    _ = try await connect(h)
    _ = await openHistory(h)
    XCTAssertFalse(h.popup.accessibilityPerformEscape(), "historia na wierzchu: gest nie jest okna")
    XCTAssertEqual(h.dismissals.value, 0, "okno zostaje")
  }

  /// Lazygit bez żywego programu (łączenie, zerwane połączenie): Esc nie ma komu trafić, więc zamyka okno —
  /// z kontrolera okna i z terminala.
  func testEscapeClosesLazygitWindowWithoutLiveProgram() throws {
    let h = try harness()
    XCTAssertNotEqual(h.session.phase, .live)
    h.popup.escapePressed()
    XCTAssertEqual(h.dismissals.value, 1, "Esc z okna")
    h.popup.screen.handleKey(Self.escapeKey)
    XCTAssertEqual(h.dismissals.value, 2, "Esc z terminala")
  }

  private static let escapeKey = TerminalHardwareKey(TerminalKeyMap.escape)

  /// W oknie LAZYGITA Esc idzie do programu („wróć"), nie zamyka okna — z terminala i gdy fokus w nim nie stoi.
  func testEscapeGoesToProgramInLazygit() async throws {
    let h = try harness()
    let socket = try await connect(h)
    XCTAssertTrue(h.popup.keyCommands?.contains { $0.input == UIKeyCommand.inputEscape } == true)
    h.popup.escapePressed()
    await waitUntil { self.inputs(socket).count == 1 }
    h.popup.screen.handleKey(Self.escapeKey)
    await waitUntil { self.inputs(socket).count == 2 }
    XCTAssertEqual(inputs(socket), ["\u{1B}", "\u{1B}"])
    XCTAssertEqual(h.dismissals.value, 0, "Esc nie zamyka okna")
  }

  /// W oknie POWŁOKI Esc zamyka okno — z terminala i gdy fokus w nim nie stoi — a do
  /// programu nie idzie. Bajt ESC dla programu daje dalej Cmd+.
  func testEscapeClosesShellWindow() async throws {
    let h = try harness(role: .popup)
    let socket = try await connect(h)
    h.popup.screen.handleKey(Self.escapeKey)
    XCTAssertEqual(h.dismissals.value, 1, "Esc z terminala zamyka okno")
    h.popup.escapePressed()
    XCTAssertEqual(h.dismissals.value, 2, "Esc bez fokusu w terminalu też")
    h.popup.screen.handleKey(TerminalHardwareKey(".", command: true))
    await waitUntil { !self.inputs(socket).isEmpty }
    XCTAssertEqual(inputs(socket), ["\u{1B}"], "do programu doszedł tylko Esc z Cmd+.")
    XCTAssertEqual(h.dismissals.value, 2, "Cmd+. okna nie zamyka")
  }

  /// Arkusz nad terminalem (historia) schodzi Esc-em pierwszy: program pod nim nie dostaje bajtu, okno zostaje.
  /// Klawiaturę trzyma wtedy terminal, więc skrót samego arkusza (`dismissOnEscape`) klawisza nie widzi.
  /// Proces testów arkusza nie prezentuje (README, „presenter is not yet in the window"), więc arkusz nad
  /// terminalem podstawia atrapa szwów ekranu.
  func testEscapeClosesSheetAboveTerminalFirst() async throws {
    for role in [TerminalRole.lazygit, .popup] {
      let h = try harness(role: role)
      let socket = try await connect(h)
      let sheet = UIViewController()
      var above = PresentedSheet.Above.dismissable(sheet)
      var dismissed: [UIViewController] = []
      h.popup.screen.sheetAbove = { _ in above }
      h.popup.screen.dismissSheet = {
        dismissed.append($0)
        // Arkusz schodzi: jeszcze stoi nad terminalem, ale drugiego zamknięcia nie przyjmuje.
        above = .held
      }
      h.popup.screen.handleKey(Self.escapeKey)
      XCTAssertTrue(dismissed.count == 1 && dismissed.first === sheet, "\(role): arkusz zamknięty")
      XCTAssertEqual(h.dismissals.value, 0, "\(role): okno zostaje")
      // Drugi szybki Esc, gdy arkusz jeszcze schodzi (albo zamknięcia nie przyjmuje): nic pod nim się nie rusza.
      h.popup.escapePressed()
      h.popup.screen.handleKey(Self.escapeKey)
      XCTAssertEqual(h.dismissals.value, 0, "\(role): okno pod schodzącym arkuszem zostaje")
      XCTAssertEqual(dismissed.count, 1)
      // Esc już bez arkusza: okno powłoki schodzi, lazygit dostaje bajt. Wcześniejsze do programu nie doszły.
      above = .nothing
      h.popup.escapePressed()
      if role == .popup {
        XCTAssertEqual(h.dismissals.value, 1, "\(role): Esc bez arkusza zamyka okno")
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertTrue(inputs(socket).isEmpty, "\(role): program nie dostał żadnego Esc")
      } else {
        await waitUntil { !self.inputs(socket).isEmpty }
        XCTAssertEqual(inputs(socket), ["\u{1B}"], "\(role): do programu doszedł tylko Esc bez arkusza")
        XCTAssertEqual(h.dismissals.value, 0)
      }
      XCTAssertEqual(dismissed.count, 1)
    }
  }

  /// Terminal nie bierze WŁASNEGO okna za arkusz nad sobą (inaczej Esc w lazygicie zamykałby okno): arkuszem nad
  /// widokiem jest tylko taki, którego ten widok nie jest częścią.
  func testOwnWindowIsNotASheetAboveTerminal() throws {
    let h = try harness()
    h.navigation.view.layoutIfNeeded()
    let terminal = try XCTUnwrap(h.popup.screen.view)
    XCTAssertFalse(PresentedSheet.covers(h.popup, terminal), "okno, w którym stoi terminal")
    XCTAssertFalse(PresentedSheet.covers(h.navigation, terminal), "kontener nawigacji tego okna")
    XCTAssertTrue(PresentedSheet.covers(UIViewController(), terminal), "arkusz historii nad oknem")
    XCTAssertNil(PresentedSheet.top(above: terminal), "nic nad terminalem w oknie testu")
    guard case .nothing = PresentedSheet.above(terminal) else { return XCTFail("okno testu nie ma arkusza") }
  }

  /// Przytrzymany Esc nie jest drugą decyzją: nie zamyka kolejnej warstwy ani nie sypie bajtami do programu pod
  /// zamkniętym arkuszem. Inne klawisze terminala powtarzają się jak dotąd.
  func testHeldEscapeDoesNotRepeat() throws {
    let h = try harness(role: .popup)
    let isEscape: (UIKeyCommand) -> Bool = { $0.input == UIKeyCommand.inputEscape && $0.modifierFlags.isEmpty }
    XCTAssertEqual(h.popup.keyCommands?.first(where: isEscape)?.repeatBehavior, .nonRepeatable, "okno")
    let terminal = try XCTUnwrap(h.popup.screen.container.keyCommands)
    XCTAssertEqual(terminal.first(where: isEscape)?.repeatBehavior, .nonRepeatable, "terminal")
    let tab = try XCTUnwrap(terminal.first { $0.input == "\t" && $0.modifierFlags.isEmpty })
    XCTAssertNotEqual(tab.repeatBehavior, .nonRepeatable, "Tab dalej się powtarza")
    // Ekran sesji pod zamkniętym oknem: przytrzymany Esc nie przerywa tury i nie odrzuca karty.
    let session = try SessionLayoutTests.makeSession(safeBottom: 0)
    defer { session.window.isHidden = true }
    let field = session.controller.composer.textView.keyCommands
    XCTAssertEqual(field?.first(where: isEscape)?.repeatBehavior, .nonRepeatable, "pole wiadomości")
    XCTAssertEqual(session.controller.cardKeyCommands.first(where: isEscape)?.repeatBehavior, .nonRepeatable, "karta")
  }

  // MARK: - Strona historii w oknie

  private func openHistory(_ h: Harness) async -> UIViewController {
    let page = UIViewController()
    h.popup.makeHistoryPage = { _, _ in page }
    h.popup.screen.handleHistory()
    await waitUntil { h.navigation.transitionCoordinator == nil && h.popup.screen.inputSuspended }
    return page
  }

  /// Historia to STRONA okna: wchodzi na stos kontenera, terminal zostaje korzeniem z tą samą sesją. Esc — także
  /// gdy klawiaturę wciąż trzyma terminal — wraca o stopień: okno zostaje, program nie dostaje bajtu.
  func testHistoryIsPageOfWindowAndEscapeReturns() async throws {
    for role in [TerminalRole.popup, .lazygit] {
      let h = try harness(role: role)
      let socket = try await connect(h)
      XCTAssertFalse(h.popup.historyShown)
      let page = await openHistory(h)
      XCTAssertTrue(h.navigation.topViewController === page, "\(role): strona na wierzchu stosu")
      XCTAssertTrue(h.navigation.viewControllers.first === h.popup, "\(role): terminal zostaje korzeniem")
      XCTAssertTrue(h.popup.historyShown)
      XCTAssertEqual(h.session.phase, .live, "\(role): to samo połączenie")
      h.popup.screen.handleKey(Self.escapeKey)
      XCTAssertEqual(h.navigation.viewControllers.count, 1, "\(role): Esc z terminala zdejmuje stronę")
      XCTAssertEqual(h.dismissals.value, 0, "\(role): okno zostaje")
      // Esc w trakcie powrotu jest połykany: nie zamyka okna i nie idzie do programu.
      h.popup.screen.handleKey(Self.escapeKey)
      h.popup.escapePressed()
      XCTAssertEqual(h.dismissals.value, 0, "\(role): Esc w trakcie powrotu nie zamyka okna")
      await waitUntil { h.navigation.transitionCoordinator == nil && !h.popup.screen.inputSuspended }
      try await Task.sleep(for: .milliseconds(80))
      XCTAssertTrue(inputs(socket).isEmpty, "\(role): program nie dostał żadnego Esc")
    }
  }

  /// Przy stronie na wierzchu terminal niczego nie wysyła programowi; po powrocie wejście wraca.
  func testTerminalUnderHistoryPageSendsNothing() async throws {
    let h = try harness(role: .popup)
    let socket = try await connect(h)
    _ = await openHistory(h)
    h.popup.screen.sendInput("x")
    h.popup.screen.paste("wklejka")
    h.popup.screen.handleKey(TerminalHardwareKey("a"))
    try await Task.sleep(for: .milliseconds(80))
    XCTAssertTrue(inputs(socket).isEmpty, "litery spod strony nie wychodzą na drut")
    XCTAssertFalse(socket.sent.contains { if case .paste = $0 { true } else { false } }, "wklejka też nie")
    // Bezwładność przewijania trwa jeszcze przez przejście do strony: ramki `sc` też nie wychodzą.
    h.popup.screen.surface.onScroll?(3, nil)
    try await Task.sleep(for: .milliseconds(80))
    XCTAssertFalse(socket.sent.contains { if case .scroll = $0 { true } else { false } }, "przewijanie też nie")
    // Cmd+Y przy stronie na wierzchu wraca (ten sam przełącznik co wejście).
    h.popup.screen.handleHistory()
    XCTAssertEqual(h.navigation.viewControllers.count, 1, "drugie „Historia” wraca do terminala")
    await waitUntil { h.navigation.transitionCoordinator == nil && !h.popup.screen.inputSuspended }
    h.popup.screen.sendInput("y")
    await waitUntil { !self.inputs(socket).isEmpty }
    XCTAssertEqual(inputs(socket), ["y"], "po powrocie pisanie idzie do programu")
    h.popup.screen.surface.onScroll?(3, nil)
    await waitUntil { socket.sent.contains { if case .scroll = $0 { true } else { false } } }
    XCTAssertTrue(socket.sent.contains { if case .scroll = $0 { true } else { false } }, "i przewijanie też")
  }

  /// `exit` w terminalu przy otwartej stronie historii zamyka całe okno.
  func testExitUnderHistoryPageClosesWindow() async throws {
    let h = try harness()
    let socket = try await connect(h)
    _ = await openHistory(h)
    socket.emit(.frame(.exit))
    await waitUntil { h.dismissals.value > 0 }
    XCTAssertEqual(h.dismissals.value, 1)
  }

  /// Bez strony do pokazania (okno zbudowane bez magazynu) „Historia” jest wygaszona.
  func testHistoryDisabledWithoutPageFactory() async throws {
    let h = try harness()
    _ = try await connect(h)
    h.popup.makeHistoryPage = nil
    let children = h.popup.screen.headerMenu().children.compactMap { $0 as? UIAction }
    XCTAssertTrue(children[2].attributes.contains(.disabled))
  }

  /// Ramka `exit` (`q` w lazygicie, `exit` w powłoce): okno schodzi samo, bez „Uruchom ponownie".
  func testExitClosesWindow() async throws {
    let h = try harness()
    let socket = try await connect(h)
    socket.emit(.frame(.exit))
    await waitUntil { h.dismissals.value > 0 }
    XCTAssertEqual(h.dismissals.value, 1)
    XCTAssertTrue(h.wire.closed.isEmpty)
  }

  /// „⋯" okna: Kopiuj, Wklej, Historia z ekranu — Historia czynna, gdy znany jest id terminala.
  func testMenuOffersCopyPasteHistory() async throws {
    let h = try harness()
    h.popup.makeHistoryPage = { _, _ in UIViewController() }
    _ = try await connect(h)
    let children = h.popup.screen.headerMenu().children.compactMap { $0 as? UIAction }
    XCTAssertEqual(children.map(\.title), [UICopy.terminalCopy, UICopy.terminalPaste, UICopy.terminalSelectOutput])
    XCTAssertFalse(children[2].attributes.contains(.disabled))
    XCTAssertEqual(h.popup.menuItem.menu?.children.count, 1, "menu budowane przy otwarciu (stan Historii)")
  }
}
