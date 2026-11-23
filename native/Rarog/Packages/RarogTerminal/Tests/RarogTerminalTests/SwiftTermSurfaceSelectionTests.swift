#if os(iOS)
@testable import RarogTerminal
import RarogUI
@preconcurrency import SwiftTerm
import Testing
import UIKit

// Selection on the real SwiftTerm surface: a click and a drag with the trackpad pressed select from the press point,
// without a menu. XCUITest cannot drive the pointer (`.indirectPointer`), so the gesture goes through the hooks
// `pointerDown(at:count:)`/`pointerDrag(to:)` on synthetic content; the look and feel are checked on an iPad.
// Właściciel: terminal.

@MainActor
@Suite("terminal: zaznaczanie na powierzchni SwiftTerm (iOS)")
struct SwiftTermSurfaceSelectionTests {
  private static let touch = [UITouch.TouchType.direct, .pencil].map { NSNumber(value: $0.rawValue) }

  /// Powierzchnia w oknie z „hello" i „world" w dwóch pierwszych wierszach.
  private func helloWorld() -> (SwiftTermSurface, UIWindow) {
    let surface = makeSurface()
    let window = host(surface)
    surface.feed(Data("\u{1B}[2J\u{1B}[Hhello\r\nworld".utf8))
    #expect(surface.visibleText == "hello\nworld")
    return (surface, window)
  }

  /// Środek komórki (od 0).
  private func cell(_ surface: SwiftTermSurface, col: Int, row: Int) -> CGPoint {
    let size = surface.cellSize
    return CGPoint(x: (CGFloat(col) + 0.5) * size.width, y: (CGFloat(row) + 0.5) * size.height)
  }

  /// Granica przed komórką `col` w wierszu `row`.
  private func boundary(_ surface: SwiftTermSurface, col: Int, row: Int) -> CGPoint {
    let size = surface.cellSize
    return CGPoint(x: CGFloat(col) * size.width, y: (CGFloat(row) + 0.5) * size.height)
  }

  @Test("gesty: stuknięcia ×1/×2/×3 i przytrzymanie SwiftTerm tylko dla dotyku, wskaźnik ma własny rozpoznawacz")
  func gestureConfiguration() throws {
    let (surface, window) = helloWorld()
    defer { window.isHidden = true }
    let recognizers = surface.gestureRecognizers ?? []
    // Rozpoznawacze linku mają własny test w `SwiftTermSurfaceLinkTests`.
    let ours: [UIGestureRecognizer] = [
      surface.pointerSelection, surface.linkTap, surface.linkHold, surface.linkSecondaryClick, surface.linkHover,
    ]
    let taps = recognizers.filter { type(of: $0) == UITapGestureRecognizer.self && !ours.contains($0) }
    let holds = recognizers.filter { type(of: $0) == UILongPressGestureRecognizer.self && !ours.contains($0) }
    #expect(taps.count == 3, "×1, ×2, ×3 SwiftTerm")
    #expect(holds.count == 1, "przytrzymanie SwiftTerm")
    for recognizer in taps + holds { #expect(recognizer.allowedTouchTypes == Self.touch) }
    #expect(surface.scrollPan.allowedTouchTypes == Self.touch, "klik z przeciągnięciem gładzikiem nie przewija")
    #expect(surface.scrollPan.allowedScrollTypesMask == .all, "dwa palce na gładziku przewijają")
    #expect(surface.pointerSelection.allowedTouchTypes == [NSNumber(value: UITouch.TouchType.indirectPointer.rawValue)])
    #expect(surface.pointerSelection.minimumPressDuration == 0)
    #expect(recognizers.contains { $0 === surface.pointerSelection })

    // Pan zaznaczenia SwiftTerm dochodzi PÓŹNIEJ (po ×2/×3 palcem, `enableSelectionPanGesture`).
    let selectionPan = UIPanGestureRecognizer()
    surface.addGestureRecognizer(selectionPan)
    #expect(selectionPan.allowedTouchTypes == Self.touch)
    let hover = UIHoverGestureRecognizer()
    surface.addGestureRecognizer(hover)
    #expect(hover.allowedTouchTypes != Self.touch, "najechanie wskaźnikiem zostaje nietknięte")
  }

  @Test("przeciągnięcie wskaźnikiem zaznacza od punktu wciśnięcia; drżenie poniżej progu nie zaznacza")
  func dragSelectsFromPress() throws {
    let (surface, window) = helloWorld()
    defer { window.isHidden = true }
    surface.pointerDown(at: boundary(surface, col: 1, row: 0), count: 1)
    surface.pointerDrag(to: boundary(surface, col: 1, row: 0).applying(.init(translationX: 2, y: 1)))
    #expect(surface.selectedText == nil, "2 pt to drżenie, nie przeciągnięcie")
    surface.pointerGesture = nil

    surface.pointerDown(at: boundary(surface, col: 0, row: 0), count: 1)
    surface.pointerDrag(to: boundary(surface, col: 3, row: 0))
    #expect(surface.selectedText == "hel")
    surface.pointerDrag(to: boundary(surface, col: 3, row: 1))
    #expect(surface.selectedText == "hello\nwor", "przez wiersze")
    surface.pointerDrag(to: CGPoint(x: -50, y: -50))
    #expect(surface.selectedText == nil, "z powrotem do punktu wciśnięcia — puste")
    surface.pointerGesture = nil

    // Wstecz od punktu wciśnięcia.
    surface.pointerDown(at: boundary(surface, col: 4, row: 1), count: 1)
    surface.pointerDrag(to: boundary(surface, col: 1, row: 1))
    #expect(surface.selectedText == "orl")
  }

  @Test("×2 słowo i przeciąganie po słowach, ×3 wiersz i po wierszach, ×1 czyści")
  func wordAndRow() throws {
    let (surface, window) = helloWorld()
    defer { window.isHidden = true }
    surface.pointerDown(at: cell(surface, col: 1, row: 0), count: 2)
    #expect(surface.selectedText == "hello")
    surface.pointerDrag(to: cell(surface, col: 2, row: 1))
    #expect(surface.selectedText == "hello\nworld", "do końca słowa pod wskaźnikiem")
    surface.pointerGesture = nil

    surface.pointerDown(at: cell(surface, col: 3, row: 1), count: 3)
    #expect(surface.selectedText == "world")
    surface.pointerDrag(to: cell(surface, col: 0, row: 0))
    #expect(surface.selectedText == "hello\nworld")
    surface.pointerGesture = nil

    surface.pointerDown(at: cell(surface, col: 8, row: 3), count: 1)
    #expect(surface.selectedText == nil, "klik czyści zaznaczenie")
    #expect(!surface.hasActiveSelection)
  }

  @Test("zaznaczenie wierszy zachowuje znak w OSTATNIEJ kolumnie (koniec wyłączny = cols)")
  func rowSelectionKeepsLastColumn() throws {
    let surface = makeSurface()
    let window = host(surface)
    defer { window.isHidden = true }
    let cols = surface.getTerminal().cols
    let full = String(repeating: "A", count: cols - 1) + "Z"
    surface.feed(Data("\u{1B}[2J\u{1B}[H\(full)\r\nkoniec".utf8))
    surface.pointerDown(at: cell(surface, col: 3, row: 0), count: 3)
    #expect(surface.selectedText == full, "trzyklik: cały wiersz ze „Z” w kolumnie \(cols)")
    surface.pointerDrag(to: cell(surface, col: 0, row: 1))
    #expect(surface.selectedText == full + "\nkoniec", "po wierszach w dół")
    surface.pointerGesture = nil

    surface.pointerDown(at: cell(surface, col: 2, row: 1), count: 3)
    surface.pointerDrag(to: cell(surface, col: 5, row: 0))
    #expect(surface.selectedText == full + "\nkoniec", "po wierszach w górę")
    surface.pointerGesture = nil

    // Przeciągnięcie ×1 do prawej krawędzi też bierze ostatnią kolumnę.
    surface.pointerDown(at: boundary(surface, col: cols - 3, row: 0), count: 1)
    surface.pointerDrag(to: CGPoint(x: 10_000, y: boundary(surface, col: 0, row: 0).y))
    #expect(surface.selectedText == "AAZ")
  }

  @Test("Cmd+C zostawia zaznaczenie; nowy ekran (`reset`) i przewinięcie je czyszczą")
  func copyResetScroll() throws {
    let (surface, window) = helloWorld()
    defer { window.isHidden = true }
    var copies = 0
    surface.onCopy = { copies += 1 }
    surface.pointerDown(at: cell(surface, col: 0, row: 0), count: 2)
    surface.copy(nil)
    #expect(copies == 1)
    #expect(surface.selectedText == "hello", "po kopii zaznaczenie zostaje (jak na Macu)")

    surface.scrollBegan()
    #expect(surface.selectedText == nil, "przewinięcie czyści")

    surface.pointerDown(at: cell(surface, col: 0, row: 1), count: 3)
    #expect(surface.selectedText == "world")
    surface.reset()
    #expect(surface.selectedText == nil, "nowy pełny ekran czyści")
  }

  @Test("weto panów: palec przy zaznaczeniu ciągnie uchwyty (pan przewijania stoi), dwa palce przewijają zawsze; pan zaznaczenia SwiftTerm bez zaznaczenia nie rusza kursora")
  func panVetoes() throws {
    let (surface, window) = helloWorld()
    defer { window.isHidden = true }
    let selectionPan = UIPanGestureRecognizer()
    surface.addGestureRecognizer(selectionPan)
    #expect(!surface.gestureRecognizerShouldBegin(selectionPan), "bez zaznaczenia przesuwałby kursor strzałkami")
    #expect(surface.gestureRecognizerShouldBegin(surface.scrollPan))

    surface.pointerDown(at: cell(surface, col: 0, row: 0), count: 2)
    #expect(surface.gestureRecognizerShouldBegin(selectionPan), "przy zaznaczeniu ciągnie uchwyty")
    surface.scrollPanByScrollEvent = false
    #expect(!surface.gestureRecognizerShouldBegin(surface.scrollPan), "palec przy zaznaczeniu nie przewija")
    surface.scrollPanByScrollEvent = true
    #expect(surface.gestureRecognizerShouldBegin(surface.scrollPan), "dwa palce na gładziku przewijają")
  }
}
#endif
