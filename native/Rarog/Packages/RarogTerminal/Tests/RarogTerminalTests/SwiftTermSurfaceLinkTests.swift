#if os(iOS)
@testable import RarogTerminal
import RarogUI
@preconcurrency import SwiftTerm
import Testing
import UIKit

// Linki na prawdziwej powierzchni SwiftTerm: bajty takie, jakie herdr przysyła w ramkach (pomiar na
// herdr 0.9.5: każdy wiersz od pozycjonowania kursora, link OSC 8 bez zmian). Gestów palca XCUITest na tej powierzchni
// nie złoży, więc testy wołają haki `linkTapped(at:)`, `linkHeld(at:)` i `pointerUp(at:)`; otwarcie i schowek to
// atrapy. Odczucie stuknięcia i menu sprawdza się na urządzeniu. Właściciel: terminal.

@MainActor
@Suite("terminal: linki na powierzchni SwiftTerm (iOS)")
struct SwiftTermSurfaceLinkTests {
  private func cell(_ surface: SwiftTermSurface, col: Int, row: Int) -> CGPoint {
    let size = surface.cellSize
    return CGPoint(x: (CGFloat(col) + 0.5) * size.width, y: (CGFloat(row) + 0.5) * size.height)
  }

  /// Powierzchnia w oknie i lista otwartych adresów.
  private func hosted() -> (SwiftTermSurface, UIWindow, Box) {
    let surface = makeSurface()
    let window = host(surface)
    let box = Box()
    surface.openLink = { box.opened.append($0.absoluteString) }
    return (surface, window, box)
  }

  @MainActor
  final class Box {
    var opened: [String] = []
  }

  /// Adres złamany jak w Claude Code: pierwsza część do prawej krawędzi, dalszy ciąg po 2 spacjach wcięcia.
  private func feedClaudeWrapped(_ surface: SwiftTermSurface) -> String {
    let cols = surface.getTerminal().cols
    let lead = "* https://example.com/"
    let head = lead + String(repeating: "a", count: cols - lead.count)
    let tail = "dalszy/ciag.swift"
    surface.feed(Data("\u{1B}[2J\u{1B}[1;1H\(head)\u{1B}[2;1H  \(tail)\u{1B}[3;1H  koniec".utf8))
    return "https://example.com/" + String(repeating: "a", count: cols - lead.count) + tail
  }

  @Test("stuknięcie w adres złamany na dwa wiersze otwiera cały adres; obok adresu nic")
  func tapWrapped() throws {
    let (surface, window, box) = hosted()
    defer { window.isHidden = true }
    let full = feedClaudeWrapped(surface)
    surface.linkTapped(at: cell(surface, col: 5, row: 0))
    surface.linkTapped(at: cell(surface, col: 4, row: 1))
    #expect(box.opened == [full, full])
    surface.linkTapped(at: cell(surface, col: 0, row: 1))
    surface.linkTapped(at: cell(surface, col: 3, row: 2))
    #expect(box.opened.count == 2, "wcięcie i wiersz za adresem")
  }

  @Test("link OSC 8: otwiera adres z sekwencji, nie tekst; schemat inny niż http(s) zostaje tekstem")
  func explicitLink() throws {
    let (surface, window, box) = hosted()
    defer { window.isHidden = true }
    surface.feed(Data(
      "\u{1B}[2J\u{1B}[1;1HA1 \u{1B}]8;;https://example.com/osc8-target\u{1B}\\KLIK\u{1B}]8;;\u{1B}\\ x\r\n".utf8))
    surface.feed(Data("\u{1B}]8;;javascript:alert(1)\u{1B}\\ZLY\u{1B}]8;;\u{1B}\\".utf8))
    #expect(surface.link(at: cell(surface, col: 4, row: 0))?.absoluteString == "https://example.com/osc8-target")
    surface.linkTapped(at: cell(surface, col: 4, row: 0))
    #expect(box.opened == ["https://example.com/osc8-target"])
    #expect(surface.link(at: cell(surface, col: 1, row: 1)) == nil)
  }

  @Test("klik wskaźnikiem w adres otwiera go po oknie dwukliku; dwuklik, przeciągnięcie i klik obok nie otwierają")
  func pointerClick() async throws {
    let (surface, window, box) = hosted()
    defer { window.isHidden = true }
    surface.linkClickDelay = .milliseconds(60)
    surface.feed(Data("\u{1B}[2J\u{1B}[1;1Hzobacz https://example.com/x teraz".utf8))
    let onLink = cell(surface, col: 10, row: 0)
    surface.pointerDown(at: onLink, count: 1)
    surface.pointerUp(at: onLink)
    #expect(box.opened.isEmpty, "czeka na okno dwukliku")
    await try #require(surface.pendingLinkOpen).value
    #expect(box.opened == ["https://example.com/x"])
    #expect(surface.pendingLinkOpen == nil)

    // Pełny dwuklik: ×1 w dół i w górę, potem ×2 w oknie — nic się nie otwiera, słowo jest zaznaczone.
    surface.pointerDown(at: onLink, count: 1)
    surface.pointerUp(at: onLink)
    let cancelled = try #require(surface.pendingLinkOpen)
    surface.pointerDown(at: onLink, count: 2)
    surface.pointerUp(at: onLink)
    await cancelled.value
    #expect(box.opened.count == 1, "dwuklik zaznacza słowo, nie otwiera")
    #expect(surface.selectedText != nil)
    #expect(surface.pendingLinkOpen == nil)

    surface.pointerDown(at: cell(surface, col: 8, row: 0), count: 1)
    surface.pointerDrag(to: cell(surface, col: 14, row: 0))
    surface.pointerUp(at: cell(surface, col: 14, row: 0))
    #expect(surface.pendingLinkOpen == nil, "przeciągnięcie zaznacza")
    surface.pointerDown(at: cell(surface, col: 2, row: 0), count: 1)
    surface.pointerUp(at: cell(surface, col: 2, row: 0))
    #expect(surface.pendingLinkOpen == nil, "klik obok adresu")

    // Zamknięcie terminala w oknie dwukliku odwołuje otwarcie.
    surface.pointerDown(at: onLink, count: 1)
    surface.pointerUp(at: onLink)
    let closing = try #require(surface.pendingLinkOpen)
    surface.close()
    await closing.value
    #expect(box.opened.count == 1)
    #expect(surface.pendingLinkOpen == nil)
  }

  @Test("przytrzymanie adresu: menu „Otwórz link” i „Kopiuj link”; kopia to cały adres bez spacji")
  func holdMenu() throws {
    let (surface, window, box) = hosted()
    defer { window.isHidden = true }
    let full = feedClaudeWrapped(surface)
    surface.linkHeld(at: cell(surface, col: 3, row: 2))
    #expect(surface.menuLink == nil, "obok adresu menu linku nie ma")
    surface.linkHeld(at: cell(surface, col: 6, row: 1))
    #expect(surface.menuLink?.absoluteString == full)
    let actions = surface.linkMenuActions(try #require(surface.menuLink))
    #expect(actions.map(\.title) == [UICopy.terminalLinkOpen, UICopy.terminalLinkCopy])
    #expect(actions.map(\.title) == ["Otwórz link", "Kopiuj link"])
    #expect(!full.contains(" "))
    surface.close()
    #expect(surface.menuLink == nil, "zamknięcie zdejmuje menu")
    #expect(box.opened.isEmpty)
  }

  @Test("najechanie wskaźnikiem: przerywane podkreślenie pod wszystkimi wierszami adresu; obok, po wyjściu i po zmianie ekranu znika")
  func hoverUnderline() throws {
    let (surface, window, _) = hosted()
    defer { window.isHidden = true }
    let full = feedClaudeWrapped(surface)
    let cols = surface.getTerminal().cols
    surface.hoverMoved(to: cell(surface, col: 4, row: 1))
    let underline = try #require(surface.linkUnderline)
    #expect(underline.url.absoluteString == full)
    #expect(underline.rows == [0: 2...(cols - 1), 1: 2...(2 + "dalszy/ciag.swift".count - 1)])
    #expect(surface.linkUnderlineLayer.path != nil)
    #expect(surface.linkUnderlineLayer.lineDashPattern == [2, 2])

    surface.hoverMoved(to: cell(surface, col: 3, row: 2))
    #expect(surface.linkUnderline == nil, "obok adresu")
    #expect(surface.linkUnderlineLayer.path == nil)

    surface.hoverMoved(to: cell(surface, col: 4, row: 0))
    #expect(surface.linkUnderline?.url.absoluteString == full)
    surface.feed(Data("\u{1B}[2J\u{1B}[1;1Hnic tu nie ma".utf8))
    #expect(surface.linkUnderline == nil, "nowy ekran pod nieruchomym wskaźnikiem")

    _ = feedClaudeWrapped(surface)
    #expect(surface.linkUnderline?.url.absoluteString == full, "adres wraca pod wskaźnik")
    surface.hoverEnded()
    #expect(surface.linkUnderline == nil)
    #expect(surface.linkUnderlineLayer.path == nil)

    surface.hoverMoved(to: cell(surface, col: 4, row: 0))
    #expect(surface.linkUnderline != nil)
    surface.reset()
    #expect(surface.linkUnderline == nil, "reset czyści ekran i podkreślenie")
    _ = feedClaudeWrapped(surface)
    #expect(surface.linkUnderline != nil)
    surface.close()
    #expect(surface.linkUnderline == nil, "zamknięcie zdejmuje podkreślenie")
    #expect(surface.linkUnderlineLayer.path == nil)
  }

  @Test("link OSC 8 łamany przez herdr na wiersze: podkreślenie pod wszystkimi; SwiftTerm bez własnego; ścieżka i inny schemat bez podkreślenia")
  func explicitUnderline() throws {
    let (surface, window, _) = hosted()
    defer { window.isHidden = true }
    #expect(surface.linkHighlightMode == .alwaysWithModifier)
    let cols = surface.getTerminal().cols
    // Kształt z pomiaru (`claude auth login` w panelu herdr): sekwencja otwarta przez wiersze, każdy od CUP.
    // Wiersz 0: „Sign in: ” i adres od kolumny 9 do krawędzi; wiersz 1 pełny; wiersz 2: 30 znaków.
    let target = "https://example.com/oauth?x=" + String(repeating: "q", count: 2 * cols + 30 - 9 - 28)
    let row0 = target.prefix(cols - 9)
    let row1 = target.dropFirst(cols - 9).prefix(cols)
    let row2 = target.dropFirst(2 * cols - 9)
    #expect(row2.count == 30)
    surface.feed(Data((
      "\u{1B}[2J\u{1B}[1;1HSign in: \u{1B}]8;;\(target)\u{1B}\\\(row0)\u{1B}[2;1H\(row1)\u{1B}[3;1H\(row2)"
        + "\u{1B}]8;;\u{1B}\\ /Users/x/plik.txt"
        + "\u{1B}[4;1H\u{1B}]8;;javascript:alert(1)\u{1B}\\ZLY\u{1B}]8;;\u{1B}\\").utf8))
    let lastRow = 30
    surface.hoverMoved(to: cell(surface, col: 3, row: 1))
    let underline = try #require(surface.linkUnderline)
    #expect(underline.url.absoluteString == target)
    #expect(underline.rows == [0: 9...(cols - 1), 1: 0...(cols - 1), 2: 0...(lastRow - 1)])
    #expect(surface.linkUnderlineLayer.path != nil)
    surface.hoverMoved(to: cell(surface, col: 9, row: 0))
    #expect(surface.linkUnderline?.rows.count == 3, "z pierwszego wiersza też całość")

    surface.hoverMoved(to: cell(surface, col: lastRow + 3, row: 2))
    #expect(surface.linkUnderline == nil, "ścieżka pliku nie jest linkiem")
    surface.hoverMoved(to: cell(surface, col: 1, row: 3))
    #expect(surface.linkUnderline == nil, "OSC 8 z innym schematem zostaje tekstem")

    // Osobne linki z tym samym celem: podkreślony tylko odcinek pod wskaźnikiem, bez tekstu między odcinkami.
    // Z sąsiednim wierszem łączy się tylko odcinek, który dochodzi do prawej krawędzi (tu ostatni w wierszu 1).
    let cols2 = surface.getTerminal().cols
    let open = "\u{1B}]8;;https://example.com/a\u{1B}\\"
    let close = "\u{1B}]8;;\u{1B}\\"
    let pad = String(repeating: " ", count: cols2 - 19)
    surface.feed(Data((
      "\u{1B}[2J\u{1B}[1;1H\(open)AAA\(close)"
        + "\u{1B}[2;1H\(open)BBB\(close) plain \(open)CCC\(close)\(pad)\(open)DDDDDD\(close)"
        + "\u{1B}[3;1H  \(open)EEE\(close)").utf8))
    let dStart = 13 + pad.count
    surface.hoverMoved(to: cell(surface, col: 1, row: 1))
    #expect(surface.linkUnderline?.rows == [1: 0...2], "AAA wyżej nie dochodzi do krawędzi")
    surface.hoverMoved(to: cell(surface, col: 11, row: 1))
    #expect(surface.linkUnderline?.rows == [1: 10...12], "odcinek w środku: tylko on, bez „plain”")
    surface.hoverMoved(to: cell(surface, col: dStart + 1, row: 1))
    #expect(surface.linkUnderline?.rows == [1: dStart...(cols2 - 1), 2: 2...4], "przy krawędzi ciągnie się w dół")
    surface.hoverMoved(to: cell(surface, col: 3, row: 2))
    #expect(surface.linkUnderline?.rows == [1: dStart...(cols2 - 1), 2: 2...4], "i z dołu w górę")
    surface.hoverMoved(to: cell(surface, col: 6, row: 1))
    #expect(surface.linkUnderline == nil, "tekst między linkami")
  }

  @Test("koszt: podkreślenie linku OSC 8 na pełnym ekranie liczy się w jednym przejściu po komórkach")
  func explicitUnderlineCost() throws {
    let (surface, window, _) = hosted()
    defer { window.isHidden = true }
    let terminal = surface.getTerminal()
    let target = "https://example.com/" + String(repeating: "q", count: terminal.cols * terminal.rows)
    surface.feed(Data((
      "\u{1B}[2J\u{1B}[1;1H\u{1B}]8;;\(target)\u{1B}\\"
        + (0..<terminal.rows).map { "\u{1B}[\($0 + 1);1H" + String(repeating: "q", count: terminal.cols) }.joined()
        + "\u{1B}]8;;\u{1B}\\").utf8))
    let clock = ContinuousClock()
    let elapsed = clock.measure {
      for row in 0..<20 { surface.hoverMoved(to: cell(surface, col: row % terminal.cols, row: row % terminal.rows)) }
    }
    #expect(surface.linkUnderline?.rows.count == terminal.rows)
    #expect(elapsed < .milliseconds(500), "\(elapsed) za 20 ruchów wskaźnika")
  }

  @Test("prawy klik na adresie: to samo menu co przytrzymanie; obok adresu nic")
  func secondaryClick() throws {
    let (surface, window, _) = hosted()
    defer { window.isHidden = true }
    #expect(surface.linkSecondaryClick.buttonMaskRequired == .secondary)
    #expect(surface.linkSecondaryClick.allowedTouchTypes == [NSNumber(value: UITouch.TouchType.indirectPointer.rawValue)])
    #expect((surface.gestureRecognizers ?? []).contains { $0 === surface.linkSecondaryClick })
    #expect((surface.gestureRecognizers ?? []).contains { $0 === surface.linkHover })
    #expect(surface.gestureRecognizer(surface.linkHover, shouldRecognizeSimultaneouslyWith: surface.scrollPan))
    #expect(!surface.gestureRecognizer(surface.scrollPan, shouldRecognizeSimultaneouslyWith: surface.linkTap))
    let full = feedClaudeWrapped(surface)
    surface.linkHeld(at: cell(surface, col: 3, row: 2))
    #expect(surface.menuLink == nil)
    surface.linkHeld(at: cell(surface, col: 3, row: 1))
    #expect(surface.menuLink?.absoluteString == full)
  }

  @Test("rozpoznawacze linku: tylko dotyk, przytrzymanie przed menu SwiftTerm, gesty SwiftTerm czekają na nie")
  func gestureWiring() throws {
    let (surface, window, _) = hosted()
    defer { window.isHidden = true }
    let touch = [UITouch.TouchType.direct, .pencil].map { NSNumber(value: $0.rawValue) }
    #expect(surface.linkTap.allowedTouchTypes == touch)
    #expect(surface.linkHold.allowedTouchTypes == touch)
    #expect(surface.linkTap.numberOfTapsRequired == 1)
    #expect(surface.linkHold.minimumPressDuration < 0.7, "menu SwiftTerm rusza po 0,7 s")
    let recognizers = surface.gestureRecognizers ?? []
    #expect(recognizers.contains { $0 === surface.linkTap })
    #expect(recognizers.contains { $0 === surface.linkHold })
    // Bez adresu pod punktem (0, 0) pusty ekran nie ma linku, więc rozpoznawacze padają.
    #expect(!surface.gestureRecognizerShouldBegin(surface.linkTap))
    #expect(!surface.gestureRecognizerShouldBegin(surface.linkHold))
  }
}
#endif
