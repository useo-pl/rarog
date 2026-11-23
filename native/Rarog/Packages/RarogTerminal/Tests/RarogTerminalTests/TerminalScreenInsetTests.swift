#if os(iOS)
@testable import RarogTerminal
import RarogContract
import RarogCore
@testable import RarogUI
@preconcurrency import SwiftTerm
import Testing
import UIKit

// Inset of the terminal content from the edges, so letters do not touch the border, on the real SwiftTerm surface in
// the screen: the view frame stands 8 pt from both sides of the container, columns count from the width minus the
// insets (also after rotation), and a pointer point from the container layout hits the cell it stands over. In the
// Cmd+F/Cmd+G window the surface starts below the bar, without a content inset: row 0 is visible. Synthetic content.
// Właściciel: terminal.

@MainActor
@Suite("terminal: odstęp treści od krawędzi ekranu (iOS)")
struct TerminalScreenInsetTests {
  @MainActor
  private struct Hosted {
    let screen: TerminalScreenViewController
    let surface: SwiftTermSurface
    let window: UIWindow

    func close() {
      screen.shutdown()
      window.isHidden = true
    }
  }

  private func hosted(size: CGSize) throws -> Hosted {
    let target = try #require(TerminalTarget.shell(cwd: "/Users/demo/Projects/rarog"))
    let session = TerminalSession(target: target, transport: FakeTerminalWire())
    let surface = makeSurface()
    let screen = TerminalScreenViewController(session: session, surface: surface) { _ in .closed }
    let window = UIWindow(frame: CGRect(origin: .zero, size: size))
    window.rootViewController = screen
    window.makeKeyAndVisible()
    window.layoutIfNeeded()
    return Hosted(screen: screen, surface: surface, window: window)
  }

  @Test("ramka SwiftTerm 8 pt od obu boków; kolumny z szerokości bez odstępów, także po obrocie")
  func insetAndColumns() throws {
    let hosted = try hosted(size: CGSize(width: 834, height: 600))
    defer { hosted.close() }
    let inset = TerminalScreenViewController.sideInset
    #expect(inset == 8)
    for size in [CGSize(width: 834, height: 600), CGSize(width: 1194, height: 700), CGSize(width: 600, height: 900)] {
      hosted.window.frame = CGRect(origin: .zero, size: size)
      hosted.window.layoutIfNeeded()
      let surface = hosted.surface
      let container = try #require(surface.superview)
      #expect(container.bounds.width == size.width, "kontener na całą szerokość ekranu (\(size))")
      #expect(surface.frame.minX == inset, "odstęp z lewej (\(size)): \(surface.frame)")
      #expect(container.bounds.width - surface.frame.maxX == inset, "odstęp z prawej (\(size)): \(surface.frame)")
      let cols = surface.getTerminal().cols
      let cell = surface.cellSize.width
      #expect(cell > 0)
      #expect(CGFloat(cols) * cell <= surface.bounds.width + 0.5, "kolumny mieszczą się w ramce (\(size))")
      #expect(CGFloat(cols + 1) * cell > surface.bounds.width, "kolumny z szerokości PO odstępach (\(size))")
    }
  }

  @Test("punkt wskaźnika z układu kontenera trafia w komórkę pod nim; odstęp z lewej to pierwsza kolumna")
  func pointerHitsCellsAfterInset() throws {
    let hosted = try hosted(size: CGSize(width: 834, height: 600))
    defer { hosted.close() }
    let surface = hosted.surface
    surface.feed(Data("\u{1B}[2J\u{1B}[Hhello world\r\nsecond".utf8))
    #expect(surface.visibleText == "hello world\nsecond")
    let container = try #require(surface.superview)
    let size = surface.cellSize
    let inset = TerminalScreenViewController.sideInset
    // Środek komórki w układzie KONTENERA, przeliczony do widoku SwiftTerm — jak `location(in:)` rozpoznawacza.
    func point(col: Int, row: Int) -> CGPoint {
      let inContainer = CGPoint(x: inset + (CGFloat(col) + 0.5) * size.width, y: (CGFloat(row) + 0.5) * size.height)
      return container.convert(inContainer, to: surface)
    }
    surface.pointerDown(at: point(col: 7, row: 0), count: 2)
    #expect(surface.selectedText == "world", "×2 nad „world” w kolumnie 8")
    surface.pointerGesture = nil
    surface.pointerDown(at: point(col: 0, row: 1), count: 3)
    #expect(surface.selectedText == "second", "×3 w drugim wierszu")
    surface.pointerGesture = nil
    let gap = container.convert(CGPoint(x: inset / 2, y: 0.5 * size.height), to: surface)
    #expect(gap.x < 0, "odstęp leży poza widokiem SwiftTerm")
    surface.pointerDown(at: gap, count: 2)
    #expect(surface.selectedText == "hello", "punkt w odstępie przyciśnięty do pierwszej kolumny")
  }

  /// Po `clear` prompt w wierszu 0 nie może leżeć pod szklanym paskiem, bo byłby nieczytelny.
  @Test("okno: powierzchnia zaczyna się pod paskiem, bez wstawki treści, więc wiersz 0 jest widoczny")
  func windowSurfaceBelowBar() throws {
    let cwd = "/Users/demo/Projects/rarog"
    let target = try #require(TerminalTarget.popup(cwd: cwd, role: .popup))
    let session = TerminalSession(target: target, transport: FakeTerminalWire())
    let surface = makeSurface()
    let screen = TerminalScreenViewController(session: session, surface: surface) { _ in .closed }
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
    surface.feed(Data("\u{1B}[2J\u{1B}[Hwiersz zero\r\nwiersz jeden".utf8))
    window.layoutIfNeeded()
    let bar = navigation.navigationBar.convert(navigation.navigationBar.bounds, to: window)
    let frame = surface.convert(surface.bounds, to: window)
    #expect(frame.minY >= bar.maxY - 0.5, "siatka pod paskiem, nie za nim: \(frame), pasek \(bar)")
    #expect(surface.safeAreaInsets.top == 0, "powierzchnia poza górnym obszarem bezpiecznym")
    #expect(surface.adjustedContentInset == .zero, "bez wstawki treści: \(surface.adjustedContentInset)")
    #expect(surface.contentOffset == .zero, "wiersz 0 na górze: \(surface.contentOffset)")
  }

  @Test("kliknięcie w bocznym odstępie trafia w powierzchnię terminala, nie w kontener")
  func gapHitTestsSurface() throws {
    let hosted = try hosted(size: CGSize(width: 834, height: 600))
    defer { hosted.close() }
    let surface = hosted.surface
    let container = try #require(surface.superview)
    let inset = TerminalScreenViewController.sideInset
    let y = container.bounds.midY
    for x in [inset / 2, container.bounds.width - inset / 2] {
      #expect(container.hitTest(CGPoint(x: x, y: y), with: nil) === surface, "odstęp x=\(x)")
    }
    #expect(container.hitTest(CGPoint(x: container.bounds.midX, y: y), with: nil) === surface, "środek")
    #expect(container.hitTest(CGPoint(x: -1, y: y), with: nil) == nil, "poza kontenerem nic")
  }
}
#endif
