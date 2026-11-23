import Foundation
import RarogCore

// Pages of the Settings sheet and the routes that open them from outside the sheet: a push tap (the core's
// ``SettingsScreen`` request) and the pairing link (the card on the Settings list). The page is navigation state
// (``RarogNavigation/settingsPage``) changed by ``RarogNavigation/openSettings(page:)``; `RarogRootView` only calls
// the two `follow…` entries below. Logic without UIKit, tested on macOS. Owner: settings.

/// A page pushed over the Settings list; `nil` in ``RarogNavigation/settingsPage`` is the list itself.
public enum SettingsPage: String, Hashable, Identifiable, CaseIterable, Sendable {
  case server, pairing, dictation, voiceAgent, textSize, about

  public var id: String { rawValue }

  /// The accessibility identifier of the page's container.
  var identifier: String { "settings.page.\(rawValue)" }

  /// The page's navigation title: the title of its row on the list.
  var title: String {
    switch self {
    case .server: UICopy.serverSection
    case .pairing: UICopy.pairIssueSection
    case .dictation: UICopy.dictationTitle()
    case .voiceAgent: UICopy.voiceAgentTitle()
    case .textSize: UICopy.textSizeLabel
    case .about: UICopy.aboutSection
    }
  }

  /// The page for a Settings screen the core asks for.
  public init(_ screen: SettingsScreen) {
    switch screen {
    case .server: self = .server
    case .pairing: self = .pairing
    }
  }
}

/// The second step of a page change in ``RarogNavigation/openSettings(page:)``: the Settings sheet it belongs to and
/// the page to show after the main queue turn.
struct PendingSettingsPage: Equatable {
  let step = UUID()
  let sheet: UUID
  var page: SettingsPage?
}

/// What routes Settings from outside the sheet, observed as one value so that a push request and a pairing link
/// arriving together (both wait for login) resolve in one place: the pairing card on the list (its link, or the
/// rejected address) and the core's request for a Settings screen.
struct SettingsRoute: Equatable {
  enum Card: Equatable {
    case link(PairingLink)
    case rejected(PairingLinkError)
  }

  var card: Card?
  var screen: SettingsScreen?
}

extension PairingState {
  /// The route once logged in: both inputs survive logout and a cold start and wait for the logged-in interface.
  /// Logged out, the start screen draws the card itself (`PairingStartView`).
  func settingsRoute(loggedIn: Bool) -> SettingsRoute {
    guard loggedIn else { return SettingsRoute() }
    let card: SettingsRoute.Card? = switch flow {
    case .idle: nil
    case let .rejected(error): .rejected(error)
    default: flow.link.map { .link($0) }
    }
    return SettingsRoute(card: card, screen: settingsScreenRequested)
  }
}

extension AppState {
  /// ``PairingState/settingsRoute(loggedIn:)`` for the current login.
  var settingsRoute: SettingsRoute { pairing.settingsRoute(loggedIn: auth == .loggedIn) }
}

extension RarogNavigation {
  /// Follows a change of the route; `previous` is `nil` on the first call. A newly shown card (a new link or a
  /// rejected address; the same link moving from confirming to the request is not new) wins: Settings on the list,
  /// where the card stands, popping any page, and a push request that arrived with it is dropped, because the card
  /// waits for a decision and the list's Pairing row still shows the devices. Otherwise the core's request opens
  /// its page, also over open Settings and an active card. Returns the request handled, so the caller consumes it
  /// in the store; `nil` = nothing to consume.
  func followSettingsRoute(_ route: SettingsRoute, previous: SettingsRoute?) -> SettingsScreen? {
    if let card = route.card, card != previous?.card {
      openSettings(page: nil)
      return route.screen
    }
    guard let screen = route.screen else { return nil }
    openSettings(page: SettingsPage(screen))
    return screen
  }
}
