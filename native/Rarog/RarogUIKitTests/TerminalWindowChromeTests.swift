import RarogContract
import RarogCore
@testable import RarogUI
import UIKit
import XCTest

/// Okno terminala Cmd+F/Cmd+G w kontenerze nawigacji systemu: bez własnego tła i szkła, terminal zaczyna się
/// pod paskiem, 8 pt od boków okna, a dół przy łuku rogu.
/// Szerokości PREZENTOWANEGO arkusza ten cel nie zmierzy: proces testów nie ma `UIApplication`, a arkusz SwiftUI zawisa
/// w „presenter is not yet in the window" — wektory szerokości sprawdza
/// `TerminalWindowChromeSourceTests`, a arkusz na żywo `WindowsUITests`. Atrapy drutu
/// i powierzchni z `TerminalScreenTests`, treść syntetyczna.
@MainActor
final class TerminalWindowChromeTests: XCTestCase {
  func testTerminalFillsWindowUnderSystemBar() throws {
    let wire = FakeWire()
    let cwd = "/Users/demo/Projects/rarog"
    let target = try XCTUnwrap(TerminalTarget.popup(cwd: cwd, role: .popup))
    let session = TerminalSession(target: target, transport: wire, timing: TerminalTiming(backoff: [.milliseconds(20)]))
    let screen = TerminalScreenViewController(session: session, surface: FakeSurface()) { _ in .closed }
    screen.hardwareKeyboard = { true }
    screen.sceneIsActive = { true }
    screen.announcer = Announcer(sink: { _ in }, now: Date.init)
    let popup = TerminalPopupController(screen: screen, request: TerminalPopupRequest(cwd: cwd, role: .popup))
    let navigation = TerminalPopupController.window(popup)
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 1000, height: 700))
    window.rootViewController = navigation
    window.makeKeyAndVisible()
    defer {
      screen.shutdown()
      window.isHidden = true
    }
    navigation.view.layoutIfNeeded()

    XCTAssertEqual(popup.view.backgroundColor, Palette.background, "pas wokół siatki w kolorze terminala, bez szkła")
    let frame = screen.view.convert(screen.view.bounds, to: popup.view)
    let inset = WindowLayout.contentInset
    XCTAssertEqual(frame.minX, inset, accuracy: 0.5, "terminal 8 pt od lewej")
    XCTAssertEqual(popup.view.bounds.maxX - frame.maxX, inset, accuracy: 0.5, "terminal 8 pt od prawej")
    // Dół siatki dotyka łuku rogu: odstęp z promienia, który system podaje dla kształtu okna, bez
    // zapasu i bez minimum 8 pt. Okno testu nie jest arkuszem, więc promień mierzy ta sama sonda co okno. Dolny
    // obszar bezpieczny liczy się na poczet odstępu (ekran terminala omija go sam).
    let probe = UIView(frame: popup.view.bounds)
    probe.cornerConfiguration = .corners(radius: .containerConcentric())
    popup.view.addSubview(probe)
    popup.view.layoutIfNeeded()
    let radius = probe.effectiveRadius(corner: .bottomLeft)
    probe.removeFromSuperview()
    let safeBottom = popup.view.safeAreaInsets.bottom
    let expected = max(0, WindowLayout.terminalBottomInset(radius: radius) - safeBottom)
    XCTAssertLessThan(expected, WindowLayout.minimumBottomInset, "promień \(radius): pod minimum innych okien")
    XCTAssertEqual(
      popup.view.bounds.maxY - frame.maxY, expected, accuracy: 0.5,
      "terminal przy dolnej krawędzi (promień \(radius), obszar bezpieczny \(safeBottom))")
    let bar = navigation.navigationBar.convert(navigation.navigationBar.bounds, to: popup.view)
    XCTAssertGreaterThan(bar.height, 0, "pasek systemu")
    // Terminal zaczyna się pod paskiem: żaden wiersz nie leży pod szkłem paska.
    XCTAssertEqual(frame.minY, bar.maxY, accuracy: 0.5, "terminal tuż pod paskiem")
    let surface = screen.surface.view.convert(screen.surface.view.bounds, to: popup.view)
    XCTAssertEqual(surface.minY, bar.maxY, accuracy: 0.5, "siatka od dołu paska")
    XCTAssertEqual(screen.view.layer.cornerRadius, 0, "bez własnych rogów: kształt daje arkusz")
    XCTAssertNotEqual(screen.view.backgroundColor, .clear, "terminal nieprzezroczysty")
  }

  /// Ekran trasy w tym samym kontenerze nawigacji zaczyna się pod paskiem, jak okno.
  func testRouteScreenKeepsGridUnderSafeArea() throws {
    let wire = FakeWire()
    let target = try XCTUnwrap(TerminalTarget.shell(cwd: "/Users/demo/Projects/rarog"))
    let session = TerminalSession(target: target, transport: wire, timing: TerminalTiming(backoff: [.milliseconds(20)]))
    let screen = TerminalScreenViewController(session: session, surface: FakeSurface()) { _ in .closed }
    screen.hardwareKeyboard = { true }
    screen.sceneIsActive = { true }
    screen.announcer = Announcer(sink: { _ in }, now: Date.init)
    let navigation = UINavigationController(rootViewController: screen)
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 1000, height: 700))
    window.rootViewController = navigation
    window.makeKeyAndVisible()
    defer {
      screen.shutdown()
      window.isHidden = true
    }
    navigation.view.layoutIfNeeded()

    let bar = navigation.navigationBar.convert(navigation.navigationBar.bounds, to: screen.view)
    let surface = screen.surface.view.convert(screen.surface.view.bounds, to: screen.view)
    XCTAssertGreaterThanOrEqual(surface.minY, bar.maxY - 0.5, "siatka trasy pod paskiem")
    XCTAssertEqual(surface.minY, screen.view.safeAreaInsets.top, accuracy: 0.5, "od górnego obszaru bezpiecznego")
  }

  /// Pas w kolorze krawędzi: okno go włącza i podaje ekranowi swój odstęp, więc nakładka kryje pas od
  /// krawędzi do krawędzi arkusza pod paskiem, a ramka ekranu (i siatki) zostaje ta sama co bez pasa.
  func testEdgeBandReachesWindowEdges() throws {
    let wire = FakeWire()
    let cwd = "/Users/demo/Projects/rarog"
    let target = try XCTUnwrap(TerminalTarget.popup(cwd: cwd, role: .lazygit))
    let session = TerminalSession(target: target, transport: wire, timing: TerminalTiming(backoff: [.milliseconds(20)]))
    let surface = FakeSurface()
    let screen = TerminalScreenViewController(session: session, surface: surface) { _ in .closed }
    screen.hardwareKeyboard = { true }
    screen.sceneIsActive = { true }
    screen.announcer = Announcer(sink: { _ in }, now: Date.init)
    let navy = TerminalEdgeColor(red8: 0x1a, green8: 0x1b, blue8: 0x26)
    surface.edges = TerminalEdges(
      background: navy, leading: Array(repeating: navy, count: 60), trailing: Array(repeating: navy, count: 60),
      bottom: Array(repeating: navy, count: 120))
    let popup = TerminalPopupController(screen: screen, request: TerminalPopupRequest(cwd: cwd, role: .lazygit))
    let navigation = TerminalPopupController.window(popup)
    let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 1000, height: 700))
    window.rootViewController = navigation
    window.makeKeyAndVisible()
    defer {
      screen.shutdown()
      window.isHidden = true
    }
    navigation.view.layoutIfNeeded()

    XCTAssertTrue(screen.paintsEdges, "okno włącza pas")
    XCTAssertNotNil(surface.onEdgesChanged, "okno słucha krawędzi")
    let frame = screen.view.convert(screen.view.bounds, to: popup.view)
    XCTAssertEqual(frame.minX, WindowLayout.contentInset, accuracy: 0.5, "ramka ekranu bez zmian")
    let reach = screen.windowInsets
    XCTAssertEqual(reach.left, frame.minX, accuracy: 0.5)
    XCTAssertEqual(reach.right, popup.view.bounds.maxX - frame.maxX, accuracy: 0.5)
    XCTAssertEqual(reach.bottom, popup.view.bounds.maxY - frame.maxY, accuracy: 0.5)
    let fill = screen.edgeFill.convert(screen.edgeFill.bounds, to: popup.view)
    XCTAssertEqual(fill.minX, 0, accuracy: 0.5, "pas od lewej krawędzi arkusza")
    XCTAssertEqual(fill.maxX, popup.view.bounds.maxX, accuracy: 0.5, "do prawej")
    XCTAssertEqual(fill.maxY, popup.view.bounds.maxY, accuracy: 0.5, "i do dołu")
    // Nakładka od górnej krawędzi ekranu, czyli od dołu paska; nad siatką pasa nie ma (góra 0).
    XCTAssertEqual(fill.minY, frame.minY, accuracy: 0.5, "od górnej krawędzi ekranu")
    let grid = screen.surface.view.convert(screen.surface.gridFrame, to: popup.view)
    XCTAssertEqual(grid.minY, frame.minY, accuracy: 0.5, "siatka od górnej krawędzi ekranu")
    let painted = screen.edgeFill.bands.map { screen.edgeFill.convert($0.rect, to: popup.view) }
    XCTAssertFalse(painted.contains { $0.minY < grid.minY - 0.5 }, "nad siatką pasa nie ma")
    XCTAssertTrue(painted.contains { $0.contains(CGPoint(x: 2, y: grid.minY + 2)) }, "pas boczny od wiersza 0")
    XCTAssertTrue(painted.contains { $0.contains(CGPoint(x: 2, y: frame.minY + 5)) }, "pas okna z lewej")
    XCTAssertTrue(painted.contains { $0.contains(CGPoint(x: frame.midX, y: popup.view.bounds.maxY - 2)) }, "u dołu")
  }
}
