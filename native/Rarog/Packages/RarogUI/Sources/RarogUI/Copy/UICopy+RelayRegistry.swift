import Foundation
import RarogContract
import RarogTransport

// Copy of the iroh relay registry: the "Relay registry" section of the "Server" screen (`RelayRegistrySection`) and the
// pairing card while the relay has not admitted the server yet. Owner: pairing. Status and removal:
// `RarogCore/RarogStore+RelayAccess.swift`; the statuses come from the registry client (`RelayAccessStatus`).

extension UICopy {
  static var relaySection: String { L("pairing.relaySection") }
  /// "This device: 1a2b3c4d": the first 8 characters of the app's EndpointId (the same short as the iroh row).
  static func relayThisDevice(_ appId: String) -> String { L("pairing.relayThisDevice", irohShort(appId)) }
  static var relayRemove: String { L("pairing.relayRemove") }
  static var relayRemoveConfirmBody: String { L("pairing.relayRemoveConfirmBody") }
  /// The pairing card in `PairingFlow.waitingForRelay`.
  static var pairWaitingForRelay: String { L("pairing.waitingForRelay") }

  /// The status line of the section; `nil` at `inactive` (no section). A limit without a retry time gets the general
  /// failure sentence, because its sentence needs the time.
  static func relayStatus(
    _ status: RelayAccessStatus, timeZone: TimeZone = .current, locale: Locale = CopyLocale.current
  ) -> String? {
    switch status {
    case .inactive: nil
    case .working: L("pairing.relayStatus.working")
    case .registered: L("pairing.relayStatus.registered")
    case .unsupported: L("pairing.relayStatus.unsupported")
    case .optedOut(_, .confirmed): L("pairing.relayStatus.removed")
    case .optedOut(_, .pending): L("pairing.relayStatus.removalPending")
    case .optedOut(_, .blockedByAdmin): L("pairing.relayStatus.removalBlocked")
    case let .problem(problem, _, retryAt): relayProblem(problem, retryAt: retryAt, timeZone: timeZone, locale: locale)
    }
  }

  private static func relayProblem(
    _ problem: RelayAccessProblem, retryAt: Date?, timeZone: TimeZone, locale: Locale
  ) -> String {
    switch problem {
    case .unreachable: L("pairing.relayStatus.unreachable")
    case .limited, .quota, .serverQuota:
      if let retryAt {
        L("pairing.relayStatus.limit", ServerTime.dayClock(retryAt, timeZone: timeZone, locale: locale))
      } else {
        L("pairing.relayStatus.failed")
      }
    case .clock: L("pairing.relayStatus.clock")
    case .denied, .serverDenied: L("pairing.relayStatus.denied")
    case .gateFailed, .gateMismatch, .proofRejected, .internal: L("pairing.relayStatus.failed")
    case .storage: L("pairing.relayStatus.storage")
    case .optOutNotSaved: L("pairing.relayStatus.optOutNotSaved")
    }
  }
}
