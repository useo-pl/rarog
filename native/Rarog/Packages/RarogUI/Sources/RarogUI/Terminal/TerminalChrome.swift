#if os(iOS)
import Foundation
import Observation

/// The terminal screen's buttons in the header: "⋯" (Copy, Paste, History) in the icon group of the top right corner
/// (`HeaderSessionSlot`), and "×" in the current tab (`HeaderTabsSlot`, in the corner only without a tab bar), without
/// a row of their own over the surface. The screen (UIKit) holds the state and the actions, also the arming of the
/// "×" and its 5 s; the header (SwiftUI) reads and calls them, and draws the arming card from ``closeState``.
///
/// One screen is attached at a time: the last attached wins, and an old screen (leaving the route, a rebuilt view)
/// neither takes down nor overwrites the new one's state. The Cmd+F/Cmd+G window has its own bar ("⋯" only, no "×")
/// and only detaches; its screen has no `TerminalChrome`. Owner: terminal.
@MainActor
@Observable
public final class TerminalChrome {
  /// „×": spoczynek, uzbrojone (drugie naciśnięcie zamyka powłokę), `DELETE` w drodze.
  public enum Close: Equatable, Sendable {
    case idle, armed, closing
  }

  /// Ekran terminala stoi na trasie — pasek pokazuje jego przyciski.
  public private(set) var isAttached = false
  public private(set) var close: Close = .idle
  /// The end of the arming's window while ``close`` is `.armed`: with the terminal on the route, the arming card's
  /// identity.
  public private(set) var armedUntil: Date?
  /// Historia czynna: ekran ma punkt wpięcia i zna id terminala.
  public private(set) var historyAvailable = false
  @ObservationIgnored private weak var screen: TerminalScreenViewController?

  public init() {}

  /// The "×" as the tab bar and the arming card read it.
  public var closeState: TerminalCloseState {
    guard isAttached else { return .detached }
    switch close {
    case .idle: return .idle
    case .closing: return .closing
    case .armed: return .armed(until: armedUntil ?? .distantPast)
    }
  }

  func attach(_ screen: TerminalScreenViewController) {
    self.screen = screen
    isAttached = true
  }

  func detach(_ screen: TerminalScreenViewController) {
    guard self.screen === screen else { return }
    self.screen = nil
    isAttached = false
    close = .idle
    armedUntil = nil
    historyAvailable = false
  }

  /// Stan przycisków od podpiętego ekranu; inny ekran jest ignorowany. `armedUntil` only with `.armed`.
  func show(close: Close, armedUntil: Date?, history: Bool, from screen: TerminalScreenViewController) {
    guard self.screen === screen else { return }
    let until = close == .armed ? armedUntil : nil
    if self.close != close { self.close = close }
    if self.armedUntil != until { self.armedUntil = until }
    if historyAvailable != history { historyAvailable = history }
  }

  public func tapClose() { screen?.closeTapped() }
  public func copy() { screen?.handleCopy() }
  public func paste() { screen?.handlePasteCommand() }
  public func history() { screen?.handleHistory() }
}
#endif
