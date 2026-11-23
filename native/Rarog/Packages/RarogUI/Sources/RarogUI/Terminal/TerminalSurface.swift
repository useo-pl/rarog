import CoreGraphics
import Foundation

// Granica między ekranem terminala a rendererem. `RarogUI` NIE importuje
// SwiftTerm (strażnik `TerminalSurfaceSourceTests`): renderer mieszka w pakiecie `RarogTerminal`
// (`SwiftTermSurface`), a apka wstrzykuje jego fabrykę przez środowisko SwiftUI (`terminalSurfaceFactory`).
// Dzięki temu `swift test` pakietu `RarogUI` nie buduje SwiftTerm, a zapas renderera (rdzeń `Terminal`
// z własnym widokiem) wymieniłby jeden pakiet. Właściciel: terminal.
//
// Treść terminala nie trafia do logów, na dysk ani do pamięci podręcznej: powierzchnia oddaje
// bajty wyłącznie przez wywołania zwrotne, a schowek dostaje tekst tylko na gest człowieka.

/// Pismo terminala: 13 pt na iPadzie, 11 pt na telefonie (PWA `czcionka-terminala-telefon`); krój zostaje
/// Menlo.
public enum TerminalFontSize {
  public static let pad: CGFloat = 13
  public static let phone: CGFloat = 11

  public static func points(pad isPad: Bool) -> CGFloat { isPad ? pad : phone }
}

#if os(iOS)
import RarogContract
import SwiftUI
import UIKit

/// Powierzchnia terminala: emulator z widokiem. Ekran podpina wywołania zwrotne i karmi ją bajtami PTY.
///
/// Kontrakt wklejki: KAŻDA droga wklejki powierzchni (menu edycji, Cmd+V, `UIPasteControl`,
/// przeciągnięcie tekstu) oddaje SUROWY tekst schowka do ``onPaste`` — bez owijania w `ESC[200~…ESC[201~`,
/// bez zgadywania trybu 2004 i bez zamiany końców linii. Ani jeden bajt wklejki nie idzie przez ``onInput``
/// (ramki `in`): serwer skleja ramki `pa`, czyści je i owija, a herdr dopasowuje wklejkę do programu.
@MainActor
public protocol TerminalSurface: AnyObject {
  /// Widok do osadzenia; jego pierwszy respondent odbiera klawiaturę. Cel `UIPasteControl` paska.
  var view: UIView { get }
  /// Bajty od klawiatury (ekranowej i sprzętowej) jako tekst UTF-8 — do ramek `in`.
  var onInput: ((String) -> Void)? { get set }
  /// Surowy tekst schowka z każdej drogi wklejki — do ramek `pa`.
  var onPaste: ((String) -> Void)? { get set }
  /// Siatka po zmianie układu (surowa — ustala ją ``ResizeSettler``).
  var onResize: ((_ cols: Int, _ rows: Int) -> Void)? { get set }
  /// Przewinięcie palcem: pełne wiersze (dodatnie = w dół) i komórka pod palcem (`sc`).
  var onScroll: ((_ lines: Int, _ cell: TerminalCell?) -> Void)? { get set }
  /// Prośba o kopię z menu edycji przy zaznaczeniu (Cmd+C, „Kopiuj" z dymka) — kopiuje EKRAN i on zdejmuje potem
  /// zaznaczenie (``clearSelection()``).
  var onCopy: (() -> Void)? { get set }
  /// Powierzchnia dostała fokus klawiatury.
  var onFocus: (() -> Void)? { get set }
  /// Bieżąca siatka z układu (kolumny × wiersze; 0 przed układem).
  var gridSize: (cols: Int, rows: Int) { get }
  /// Zaznaczenie człowieka; `nil` = brak.
  var selectedText: String? { get }
  /// Zdejmuje zaznaczenie (po kopii).
  func clearSelection()
  /// Widoczny ekran jako tekst (wiersze bez końcowych spacji).
  var visibleText: String { get }
  /// Bajty PTY do emulatora.
  func feed(_ data: Data)
  /// Emulator od zera — nowe gniazdo zaczyna się pełną ramką serwera.
  func reset()
  /// Koniec życia powierzchni (ekran zszedł): zatrzymuje odświeżanie i odpina wywołania zwrotne. Bez tego
  /// `CADisplayLink` SwiftTerm (cel trzymany mocno przez pętlę) zostawiałby w pamięci widok z emulatorem po
  /// każdym zamkniętym terminalu. Wołana wielokrotnie nic nie psuje.
  func close()
  /// Puszczenie (`cancelled == false`) albo anulowanie klawiszy sprzętowych, które doszło do KONTENERA
  /// powierzchni: `pressesEnded` widoku SwiftTerm nie jest `open`, więc powierzchnia sama go nie zobaczy, a seria
  /// strzałki (``TerminalKeyRepeat``) musi stanąć w chwili puszczenia. Domyślnie nic.
  func hardwareKeysEnded(_ presses: Set<UIPress>, cancelled: Bool)
  /// Koniec serii strzałki — ślad diagnostyczny bez treści klawiszy (``TerminalKeyRepeatEnd``). Domyślnie brak.
  var onKeyRepeatEnded: ((TerminalKeyRepeatEnd) -> Void)? { get set }
  /// Kolory krawędzi siatki dla pasa wokół niej, liczone przy KAŻDYM odczycie. Odczyt liczy się jako wynik
  /// oddany słuchaczowi: ``onEdgesChanged`` przyjdzie dopiero przy innym. `nil` = powierzchnia ich nie zna, a pasa
  /// nie ma. Domyślnie `nil`.
  var edgeColors: TerminalEdges? { get }
  /// Ramka pełnych komórek siatki w układzie ``view`` (wiersze od góry; resztka szerokości i wysokości zostaje
  /// z prawej i u dołu). Domyślnie granice widoku.
  var gridFrame: CGRect { get }
  /// Krawędzie mogły się zmienić (nowe bajty, kolory, zaznaczenie) — sygnał zgłaszany tylko przy innym wyniku.
  /// Ustawienie WŁĄCZA liczenie krawędzi; trasa go nie ustawia, więc u niej powierzchnia niczego nie liczy.
  /// Domyślnie brak.
  var onEdgesChanged: (() -> Void)? { get set }
  /// Układ nie doszedł do renderera (scena nieaktywna albo widok mniejszy niż komórka): wysokość widoku w punktach.
  /// Siatka i treść zostają — sygnał tylko dla śladu powrotu z tła (``TerminalReturnTrace``). Domyślnie brak.
  var onLayoutSkipped: ((_ height: CGFloat) -> Void)? { get set }
  /// How many rows leave the top of the screen when the grid shrinks to `rows`; the rest of the shrink takes rows
  /// below the cursor. While the on-screen keyboard comes up the screen moves the surface up by exactly these rows, so
  /// the shrink at the end of the slide moves no text. Default: every dropped row (the cursor on the last row).
  func rowsLeavingTop(shrinkingTo rows: Int) -> Int
}

extension TerminalSurface {
  public func hardwareKeysEnded(_ presses: Set<UIPress>, cancelled: Bool) {}

  public var onKeyRepeatEnded: ((TerminalKeyRepeatEnd) -> Void)? {
    get { nil }
    set {}
  }

  public var edgeColors: TerminalEdges? { nil }

  public var gridFrame: CGRect { view.bounds }

  public var onEdgesChanged: (() -> Void)? {
    get { nil }
    set {}
  }

  public var onLayoutSkipped: ((_ height: CGFloat) -> Void)? {
    get { nil }
    set {}
  }

  public func rowsLeavingTop(shrinkingTo rows: Int) -> Int { max(0, gridSize.rows - rows) }
}

/// Ustawienia powierzchni z ekranu: pismo i kolory motywu (PWA: `--bg`, `--text`).
public struct TerminalSurfaceConfiguration {
  /// The font size at the system's text size (``TerminalFontSize``).
  public var fontSize: CGFloat
  public var background: UIColor
  public var foreground: UIColor
  /// The app's text size the font follows live (``TerminalFontSize/points(_:scale:)``); `nil` = `fontSize` as is.
  public var textScale: TextScale?

  public init(fontSize: CGFloat, background: UIColor, foreground: UIColor, textScale: TextScale? = nil) {
    self.fontSize = fontSize
    self.background = background
    self.foreground = foreground
    self.textScale = textScale
  }

  /// The font by the device's idiom, following the app's text size; colours from the app's palette (dynamic: dark
  /// and light theme).
  @MainActor
  public static func standard(idiom: UIUserInterfaceIdiom) -> TerminalSurfaceConfiguration {
    TerminalSurfaceConfiguration(
      fontSize: TerminalFontSize.points(pad: idiom == .pad), background: Palette.background,
      foreground: Palette.text, textScale: .shared)
  }
}

/// Fabryka powierzchni — wstrzykuje ją apka (`SwiftTermSurface.factory` z `RarogTerminal`).
public struct TerminalSurfaceFactory: Sendable {
  private let make: @MainActor @Sendable (TerminalSurfaceConfiguration) -> any TerminalSurface

  public init(_ make: @escaping @MainActor @Sendable (TerminalSurfaceConfiguration) -> any TerminalSurface) {
    self.make = make
  }

  @MainActor
  public func callAsFunction(_ configuration: TerminalSurfaceConfiguration) -> any TerminalSurface {
    make(configuration)
  }
}

extension EnvironmentValues {
  /// Fabryka powierzchni terminala; `nil` = apka bez renderera (ekran mówi „niedostępny").
  @Entry public var terminalSurfaceFactory: TerminalSurfaceFactory? = nil
}
#endif
