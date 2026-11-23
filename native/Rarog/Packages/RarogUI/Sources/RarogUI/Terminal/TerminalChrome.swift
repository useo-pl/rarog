#if os(iOS)
import Observation

/// Przyciski ekranu terminala w pasku nawigacji: „⋯" (Kopiuj, Wklej, Historia) i „×" stoją w grupie ikon prawego
/// górnego rogu, tam gdzie „×" sesji (`HeaderSessionSlot`), bez osobnego wiersza nad powierzchnią.
/// Stan i akcje ma ekran (UIKit), pasek (SwiftUI) je czyta i woła.
///
/// Podpięty jest jeden ekran naraz: ostatni podpięty wygrywa, a stary ekran (zejście z trasy, odtworzenie widoku)
/// nie zdejmuje i nie nadpisuje stanu nowego. Okno Cmd+F/Cmd+G ma własny pasek (samo „⋯”, bez „×”)
/// i tylko odpina — jego ekran nie ma `TerminalChrome`. Właściciel: terminal.
@MainActor
@Observable
public final class TerminalChrome {
  /// „×": spoczynek, uzbrojone („Na pewno?", drugie naciśnięcie zamyka powłokę), `DELETE` w drodze.
  public enum Close: Equatable, Sendable {
    case idle, armed, closing
  }

  /// Ekran terminala stoi na trasie — pasek pokazuje jego przyciski.
  public private(set) var isAttached = false
  public private(set) var close: Close = .idle
  /// Historia czynna: ekran ma punkt wpięcia i zna id terminala.
  public private(set) var historyAvailable = false
  @ObservationIgnored private weak var screen: TerminalScreenViewController?

  public init() {}

  func attach(_ screen: TerminalScreenViewController) {
    self.screen = screen
    isAttached = true
  }

  func detach(_ screen: TerminalScreenViewController) {
    guard self.screen === screen else { return }
    self.screen = nil
    isAttached = false
    close = .idle
    historyAvailable = false
  }

  /// Stan przycisków od podpiętego ekranu; inny ekran jest ignorowany.
  func show(close: Close, history: Bool, from screen: TerminalScreenViewController) {
    guard self.screen === screen else { return }
    if self.close != close { self.close = close }
    if historyAvailable != history { historyAvailable = history }
  }

  public func tapClose() { screen?.closeTapped() }
  public func copy() { screen?.handleCopy() }
  public func paste() { screen?.handlePasteCommand() }
  public func history() { screen?.handleHistory() }
}
#endif
