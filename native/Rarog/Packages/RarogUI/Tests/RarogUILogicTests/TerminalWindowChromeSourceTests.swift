import CoreGraphics
import Foundation
@testable import RarogUI
import Testing

// Rama okna terminala Cmd+F/Cmd+G: szerokość z okna apki (wektory wspólnego
// `WindowLayout`), pasek systemu bez przycisku zamknięcia, uchwyt arkusza na telefonie, dół siatki przy łuku rogu.
// Historia i diff stoją na wspólnym szkielecie okien — pilnuje ich `PresentationSourceTests`. Okno na żywo otwiera
// `WindowsUITests` (szew terminala w demo). Właściciel: terminal.

@Suite("terminal: rama okna Cmd+F i Cmd+G")
struct TerminalWindowChromeSourceTests {
  static let sources = URL(filePath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    .deletingLastPathComponent().appending(path: "Sources/RarogUI")

  /// Kod bez komentarzy `//`.
  static func code(_ relative: String) throws -> String {
    try String(contentsOf: sources.appending(path: relative), encoding: .utf8)
      .split(separator: "\n", omittingEmptySubsequences: false)
      .map { line in line.range(of: "//").map { String(line[..<$0.lowerBound]) } ?? String(line) }
      .joined(separator: "\n")
  }

  @Test("szerokość: 92% okna w 720…1400, nigdy szerzej niż okno minus 2 × 16; compact i brak pomiaru — system")
  func widthVectors() throws {
    let vectors: [(window: CGFloat, width: CGFloat)] = [
      (1366, 1256.72),  // iPad 13" poziomo
      (1194, 1098.48),  // iPad 11" poziomo
      (1024, 942.08),  // iPad 13" pionowo
      (834, 767.28),  // iPad 11" pionowo
      (760, 720),  // 92% = 699 → podłoga 720
      (700, 668),  // Stage Manager: podłoga 720 nie mieści się w oknie → okno − 32
      (1600, 1400),  // zewnętrzny monitor: sufit
      (2400, 1400),
    ]
    for vector in vectors {
      let width = try #require(WindowLayout.sheetWidth(window: vector.window, compact: false))
      #expect(abs(width - vector.width) < 0.01, "okno \(vector.window): \(width)")
      #expect(width <= vector.window - 2 * WindowLayout.windowMargin)
    }
    #expect(WindowLayout.sheetWidth(window: 1194, compact: true) == nil, "compact: rozmiar systemowy")
    #expect(WindowLayout.sheetWidth(window: nil, compact: false) == nil)
    #expect(WindowLayout.sheetWidth(window: 0, compact: false) == nil)
    #expect(WindowLayout.sheetWidth(window: .infinity, compact: false) == nil)
    #expect(WindowLayout.sheetWidth(window: 20, compact: false) == 0, "okno węższe niż marginesy")
    #expect(WindowLayout.contentInset == 8)
  }

  @Test("okno Cmd+F/Cmd+G: wspólna rama okien i pasek systemu; bez szkła, własnego tła i promienia")
  func window() throws {
    let code = try Self.code("Terminal/TerminalWindow.swift")
    #expect(code.contains(".windowFrame(width: windowWidth)"), "szerokość, obrys i odcień jak inne okna")
    #expect(code.contains("UINavigationController(rootViewController: popup)"), "pasek nawigacji systemu")
    #expect(!code.contains(": UINavigationBar"), "pasek bez podklasy: dotyku nie oddaje, bo pod nim nie ma siatki")
    #expect(code.contains("navigationItem.rightBarButtonItem = menuItem"), "akcje z prawej")
    #expect(code.contains("view.backgroundColor = Palette.background"), "pas wokół siatki w kolorze terminala")
    #expect(code.contains("WindowLayout.contentInset"), "siatka 16 pt od boków arkusza")
    #expect(code.contains("effectiveRadius(corner: .bottomLeft)"), "promień rogu z API systemu")
    #expect(code.contains("WindowLayout.terminalBottomInset(radius:"), "dół siatki dotyka łuku rogu")
    #expect(!code.contains("WindowLayout.bottomInset(radius:"), "bez zapasu 6 pt od łuku, który mają historia i diff")
    for banned in [
      "NavigationStack", ".presentationSizing(", "presentationBackground", "presentationCornerRadius", ".glassEffect(",
      ".dismissOnEscape", "closesOnEscapeAndCommandW", "roundCorners(", "backgroundColor = .clear", ".sheet(",
    ] {
      #expect(!code.contains(banned), "okno terminala bez `\(banned)`")
    }
  }

  /// „×” stoi z lewej strony paska, jak w każdym oknie apki; uchwyt
  /// arkusza na telefonie stoi obok.
  @Test("okno terminala z „×” z lewej, które tylko odpina; uchwyt arkusza tylko na telefonie (urządzenie, nie klasa)")
  func closeButtonOnLeading() throws {
    let code = try Self.code("Terminal/TerminalWindow.swift")
    #expect(code.contains("systemItem: .close, primaryAction: UIAction { [weak self] _ in self?.onDismiss?() })"),
            "„×” zamyka okno drogą `onDismiss` (odpina), nie zabija powłoki")
    #expect(code.contains("navigationItem.leftBarButtonItem = closeItem"), "„×” z lewej")
    #expect(code.contains("closeItem.accessibilityIdentifier = \"terminal.popup.close\""))
    #expect(code.contains(".presentationDragIndicator(TerminalPopupController.showsGrabber ? .visible : .hidden)"))
    #expect(code.contains("static var showsGrabber: Bool { UIDevice.current.userInterfaceIdiom == .phone }"))
    #expect(!code.contains("horizontalSizeClass") && !code.contains(".compact"), "uchwyt bez klasy szerokości")
    #expect(code.contains("override func accessibilityPerformEscape() -> Bool"), "gest „wstecz” czytnika zamyka okno")
    let copy = try Self.code("Copy/UICopy+Terminal.swift")
    #expect(copy.contains("public static func terminalPopupClose(_ role: TerminalRole) -> String"), "nazwa „×” okna")
  }

  @Test("pas w kolorze krawędzi: włącza go wyłącznie okno, z zasięgiem do krawędzi arkusza; trasa bez pasa")
  func edgeFillOnlyInWindow() throws {
    let window = try Self.code("Terminal/TerminalWindow.swift")
    #expect(window.contains("screen.paintsEdges = true"), "okno włącza pas")
    #expect(window.contains("screen.windowInsets = UIEdgeInsets(top: 0, left: inset, bottom: -constant, right: inset)"),
            "pas sięga krawędzi arkusza: 8 pt z boków i dolny odstęp z łuku rogu")
    let root = Self.sources.appending(path: "Terminal")
    let files = try #require(FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil))
    var enabling: [String] = []
    for case let file as URL in files where file.pathExtension == "swift" {
      if try Self.code("Terminal/\(file.lastPathComponent)").contains("paintsEdges = true") {
        enabling.append(file.lastPathComponent)
      }
    }
    #expect(enabling == ["TerminalWindow.swift"], "trasa terminala bez pasa: \(enabling)")
    let screen = try Self.code("Terminal/TerminalScreenViewController.swift")
    #expect(screen.contains("public var paintsEdges = false"), "domyślnie wyłączony")
    let order = ["view.addSubview(stack)", "view.addSubview(edgeFill)", "view.addSubview(statusBar)"]
      .map { screen.range(of: $0)?.lowerBound }
    #expect(!order.contains(nil) && order == order.sorted { $0! < $1! }, "nakładka nad stosem, pod linią stanu")
  }

  /// Siatka zaczyna się pod paskiem, bo `clear` stawia prompt w wierszu 0, a wiersz pod
  /// szklanym paskiem jest nieczytelny. Opcji siatki pod paskiem ani efektu krawędzi nie ma.
  @Test("siatka pod paskiem okna, nie pod nim schowana; tytuł „RODZAJ projekt”")
  func gridBelowBar() throws {
    let window = try Self.code("Terminal/TerminalWindow.swift")
    #expect(window.contains("screenView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor)"),
            "ekran od dołu paska")
    #expect(!window.contains("screenView.topAnchor.constraint(equalTo: view.topAnchor)"))
    #expect(window.contains("kindLabel.attributedText = Eyebrow.text(kind)"), "tytuł „RODZAJ projekt” jak w oknach")
    #expect(window.contains("UIMenu(title: ProjectPath.name(request.cwd)"), "projekt w nagłówku menu „⋯”")
    let screen = try Self.code("Terminal/TerminalScreenViewController.swift")
    #expect(screen.contains("stack.topAnchor.constraint(equalTo: guide.topAnchor)"), "stos od górnego obszaru")
    #expect(screen.contains("statusBar.topAnchor.constraint(equalTo: container.topAnchor)"), "linia stanu na siatce")
    for banned in ["gridUnderBar", "topEdgeEffect"] {
      #expect(!screen.contains(banned) && !window.contains(banned), "bez `\(banned)`")
    }
  }

  @Test("katalog `Terminal/`: żadnego własnego szkła ani tła prezentacji")
  func noGlassInTerminal() throws {
    let root = Self.sources.appending(path: "Terminal")
    let files = try #require(FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil))
    for case let file as URL in files where file.pathExtension == "swift" {
      let code = try Self.code("Terminal/\(file.lastPathComponent)")
      for banned in [".glassEffect(", "presentationBackground", "presentationCornerRadius"] {
        #expect(!code.contains(banned), "\(file.lastPathComponent): bez `\(banned)`")
      }
    }
  }
}
