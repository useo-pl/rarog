import Foundation
import RarogContract
import RarogCore

// The "×" of the current tab and the card under the tab bar while that close is armed: the session's, and the
// terminal screen's on a terminal route. Pure values: the tab bar (`Views/Projects/TabCloseButton`,
// `Views/Projects/CloseArmCard`) only draws them. Owner: projects and tabs.

/// What the "×" of the current tab shows. The place for it depends only on the tab (``ProjectTabModel/closes``), so
/// every state here changes the glyph and never the tab's width.
public enum TabCloseGlyph: Sendable, Equatable {
  /// "×" in the muted ink: a press arms the close for 5 s.
  case idle
  /// "×" in `err` on an `err` wash: a press within the window closes.
  case armed
  /// A spinner: the close is on its way.
  case closing
  /// A dimmed "×" without an action: the list from the cache, a session the app cannot close (Codex, an unknown
  /// engine, an unsupported session), or a terminal route whose screen is not attached yet.
  case dimmed
}

/// The "×" of the current tab.
public struct TabCloseModel: Sendable, Equatable {
  /// The tab the "×" stands in and whose close it runs (``ProjectTabModel/target``): a session runs
  /// ``RarogNavigation/requestClose(_:state:now:)`` and ``RarogNavigation/close(_:store:)``; a terminal, also with an
  /// agent inside it, runs the terminal screen's close (`TerminalChrome.tapClose`); `nil` is a terminal being opened
  /// ("New Terminal" before the server's answer), whose close abandons the opening.
  public let tab: ProjectTabRef?
  public let glyph: TabCloseGlyph
  /// The effect, for VoiceOver and the pointer tip: "Close Pane in herdr", for a finished session "Remove from List",
  /// on a terminal "Close Terminal".
  public let label: String

  /// The session whose close the "×" runs; `nil` on a terminal route.
  public var sessionId: String? {
    if case let .session(id)? = tab { return id }
    return nil
  }

  /// The button's VoiceOver label: armed, the question comes before the effect.
  public var spoken: String {
    glyph == .armed ? UICopy.list([UICopy.confirmQuestion, label], .sentence) : label
  }

  /// A press does something (arms or closes); a spinner and a dimmed "×" are disabled buttons.
  public var acts: Bool { glyph == .idle || glyph == .armed }

  /// The accessibility identifier: the session's "×" and the terminal's keep their own, wherever they stand.
  public var accessibilityId: String { sessionId == nil ? "terminal.close" : "header.close" }

  /// The "×" belongs to this tab of the bar.
  public func stands(in tab: ProjectTabModel) -> Bool { tab.closes && tab.target == self.tab }
}

/// How the room for the divider and the "×" follows a change of the current tab: the old current tab's room closes
/// while the new one's opens, so the siblings between them slide instead of jumping. Only a change of the current
/// tab within the same list slides; a tab that comes or goes (New Terminal, a closed current tab) lays the bar out at
/// once, as does the system "Reduce Motion".
public enum TabCloseRoomMotion: Sendable, Equatable {
  /// The bar takes its new layout at once.
  case jump
  /// The rooms' widths ease out over `duration` seconds.
  case slide(duration: TimeInterval)

  /// `tabsBefore` and `tabsAfter` are the bar's tab identifiers, in order, before and after the change.
  public init(reduceMotion: Bool, tabsBefore: [String], tabsAfter: [String]) {
    self = reduceMotion || tabsBefore != tabsAfter ? .jump : .slide(duration: TabTokens.closeRoomSlide)
  }
}

/// The close of the terminal screen on the route, as the screen reports it to the header (`TerminalChrome`). A plain
/// value, so the rules of the tab's "×" and of the arming card are tested without a screen.
public enum TerminalCloseState: Sendable, Equatable {
  /// No terminal screen is attached (the route's view is being built, or no terminal stands on the route).
  case detached
  case idle
  /// Armed by the screen's own 5 s window (`TerminalCloseArm`) until `until`.
  case armed(until: Date)
  /// The `DELETE` of the shell is on its way.
  case closing
}

/// The card under the tab bar while a close is armed: the sentence of what the next press does. Its identity is the
/// arming (whose, and its deadline), so a new arming is a new card.
public struct CloseArmCardModel: Sendable, Equatable {
  public enum Arm: Sendable, Equatable {
    case session(RarogNavigation.CloseArm)
    /// The terminal on the route (`nil` = being opened) and the end of the screen's window.
    case terminal(String?, until: Date)
  }

  public let arm: Arm
  public let text: String
}

extension ProjectTabModel {
  /// The current session or terminal tab has the divider and the "×" after its label; siblings and the invite do
  /// not. Only lasting traits decide, so the tab's width never follows the close's state.
  public var closes: Bool { current && (kind == .session || kind == .terminal) }
}

extension RarogNavigation {
  /// The "×" of the current tab: a session, or the terminal on the route (also an agent inside a Rarog terminal and a
  /// terminal being opened), whose glyph follows `terminal`. `nil` on a project without a session, the Inbox and the
  /// list.
  public func tabClose(_ state: AppState, terminal: TerminalCloseState = .detached) -> TabCloseModel? {
    if terminalRoute(state) != nil {
      let glyph: TabCloseGlyph =
        switch terminal {
        case .detached: .dimmed
        case .idle: .idle
        case .armed: .armed
        case .closing: .closing
        }
      return TabCloseModel(tab: currentTab(state), glyph: glyph, label: UICopy.terminalClose)
    }
    guard case let .session(id)? = currentTab(state), let session = state.sessions[id] else { return nil }
    let glyph: TabCloseGlyph =
      if closing.contains(id) {
        .closing
      } else if !session.canClose || state.listStale {
        .dimmed
      } else if closeArm?.sessionId == id {
        .armed
      } else {
        .idle
      }
    return TabCloseModel(tab: .session(id), glyph: glyph, label: UICopy.closeLabel(session))
  }

  /// The terminal's "×" stands in the header's icon group instead of a tab: a terminal route without a known project
  /// directory (a terminal opened from a link before the list knows it) has no tab bar.
  public func terminalCloseInCorner(_ state: AppState) -> Bool {
    terminalRoute(state) != nil && currentProjectCwd(state) == nil
  }

  /// The arming card, derived from the arming itself: the session's (it goes with the disarming: 5 s, another tab,
  /// the message field taking focus, a screen change, the scene going inactive; and with the confirmation), or on a
  /// terminal route the terminal screen's (`terminal`, which the screen disarms after its 5 s, on leaving the screen
  /// and when the scene goes inactive). While an error notice (``post(_:lifetime:)``) stands, it shows instead of the
  /// card, and the card never takes the notice down. The card says nothing itself: the arming spoke when it armed
  /// (``announceArming(_:)``, and the terminal screen when its close arms).
  public func closeArmCard(_ state: AppState, terminal: TerminalCloseState = .detached) -> CloseArmCardModel? {
    guard notice == nil else { return nil }
    if let arm = closeArm, let session = state.sessions[arm.sessionId] {
      return CloseArmCardModel(arm: .session(arm), text: UICopy.closeArmed(session))
    }
    guard case let .armed(until) = terminal, terminalRoute(state) != nil else { return nil }
    let id: String? = if case let .terminal(id)? = currentTab(state) { id } else { nil }
    return CloseArmCardModel(
      arm: .terminal(id, until: until), text: UICopy.terminalCloseConfirmSpoken(state.serverMachine))
  }

  /// Tells the screen reader what the next press does, once per arming: ``requestClose(_:state:now:)`` calls it
  /// where it creates the arming, so the sentence is heard also while a newer error notice shows instead of the card,
  /// and a card view drawn again (rotation, a split change) says nothing. The callers that arm (the tab's "×", Cmd+X,
  /// the state card's button) say nothing themselves.
  func announceArming(_ session: SessionSummary) {
    announce(UICopy.closeArmed(session))
  }
}
