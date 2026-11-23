import Foundation
import RarogCore
import RarogTransport
@testable import RarogUI
import Testing

// The "Relay registry" section of the "Server" screen: every status of the registry client
// maps to its text, the section hides at `inactive`, the device row shows the first 8 characters of the app's
// EndpointId, "Remove Me from the Registry" hides at `optedOut` and `unsupported`, the button asks first and calls the
// removal once, and "Cancel" calls nothing. The process language is pinned to Polish (`RAROG_COPY_LANGUAGE=pl`).

@Suite("“Server” screen: relay registry section")
@MainActor
struct RelayRegistrySectionTests {
  static let appId = "9f8e7d6c" + String(repeating: "0a1b2c3d", count: 7)
  static let until = Date(timeIntervalSince1970: 1_790_000_000)
  static let zone = TimeZone(identifier: "Europe/Warsaw")!

  /// Counts calls of the removal closure.
  @MainActor final class Calls { var count = 0 }

  static func content(_ status: RelayAccessStatus) -> RelayRegistryContent? {
    RelayRegistryContent.make(status, timeZone: zone)
  }

  static func statusText(_ status: RelayAccessStatus) -> String? {
    content(status)?.rows.first { $0.identifier == "settings.relay.status" }?.text
  }

  @Test("inactive: no section")
  func inactiveHidesSection() {
    #expect(Self.content(.inactive) == nil)
  }

  @Test("every status maps to its text")
  func statusTexts() {
    let id = Self.appId
    let failed = "Rejestracja się nie udała. Połączenia działają dalej, apka spróbuje później."
    let denied = "Relay Rarog blokuje to urządzenie albo jego serwer. Napisz do nas przez rarog.ai."
    let retry = ServerTime.dayClock(Self.until, timeZone: Self.zone)
    let limit = "Limit rejestracji wyczerpany. Apka spróbuje ponownie \(retry)."
    let cases: [(RelayAccessStatus, String)] = [
      (.working, "Rejestruję…"),
      (.registered(appId: id, until: Self.until), "Zarejestrowane"),
      (.unsupported(appId: id),
       "To urządzenie nie może zarejestrować się w relayu. Rarog łączy się bezpośrednio albo przez HTTPS."),
      (.optedOut(appId: id, removal: .confirmed),
       "Usunięte z rejestru. Parowanie przez iroh zarejestruje urządzenie ponownie."),
      (.optedOut(appId: id, removal: .pending), "Usunięcie jeszcze niepotwierdzone. Apka ponowi próbę."),
      (.optedOut(appId: id, removal: .blockedByAdmin),
       "To urządzenie jest zablokowane, więc usunięcie wymaga prośby przez rarog.ai."),
      (.problem(.unreachable, appId: id, retryAt: nil),
       "Rejestr nie odpowiada. Połączenia działają dalej, apka spróbuje później."),
      (.problem(.limited, appId: id, retryAt: Self.until), limit),
      (.problem(.quota, appId: id, retryAt: Self.until), limit),
      (.problem(.serverQuota, appId: id, retryAt: Self.until), limit),
      (.problem(.clock, appId: id, retryAt: Self.until), "Sprawdź datę i godzinę na tym urządzeniu."),
      (.problem(.denied, appId: id, retryAt: Self.until), denied),
      (.problem(.serverDenied, appId: id, retryAt: Self.until), denied),
      (.problem(.gateFailed, appId: id, retryAt: Self.until), failed),
      (.problem(.gateMismatch, appId: id, retryAt: Self.until), failed),
      (.problem(.proofRejected, appId: id, retryAt: Self.until), failed),
      (.problem(.internal, appId: id, retryAt: Self.until), failed),
      (.problem(.storage, appId: id, retryAt: nil),
       "Nie da się odczytać ustawień rejestru na tym urządzeniu. Połączenia działają; parowanie przez iroh je odnowi."),
      (.problem(.optOutNotSaved, appId: id, retryAt: nil),
       "Nie udało się zapisać prośby o usunięcie. Spróbuj ponownie."),
    ]
    for (status, text) in cases {
      #expect(Self.statusText(status) == text, "\(status)")
    }
    // Every problem of the client has a case above.
    let covered = Set(cases.compactMap { status, _ -> RelayAccessProblem? in
      if case let .problem(problem, _, _) = status { return problem }
      return nil
    })
    #expect(covered == Set(RelayAccessProblem.allCases))
  }

  @Test("a limit without a retry time falls back to the general failure text")
  func limitWithoutRetryAt() {
    #expect(Self.statusText(.problem(.limited, appId: Self.appId, retryAt: nil))
      == "Rejestracja się nie udała. Połączenia działają dalej, apka spróbuje później.")
  }

  @Test("device row: first 8 characters of the app's EndpointId; none while the client works")
  func deviceRow() throws {
    let content = try #require(Self.content(.registered(appId: Self.appId, until: Self.until)))
    #expect(content.rows.map(\.identifier) == ["settings.relay.device", "settings.relay.status"])
    #expect(content.rows.first?.text == "To urządzenie: 9f8e7d6c")
    #expect(Self.content(.working)?.rows.map(\.identifier) == ["settings.relay.status"])
  }

  @Test("device row as label and value: “This Device” | the short EndpointId; the status row has no label")
  func deviceRowLabelValue() throws {
    let content = try #require(Self.content(.problem(.clock, appId: Self.appId, retryAt: nil)))
    let device = try #require(content.rows.first)
    #expect(device.label == "To urządzenie")
    #expect(device.value == "9f8e7d6c")
    #expect(device.accessibilityLabel == "To urządzenie: 9f8e7d6c", "VoiceOver reads label and value as one row")
    let status = try #require(content.rows.last)
    #expect(status.label == nil)
    #expect(status.value == status.text)
  }

  @Test("needs attention: only states that do not heal by themselves")
  func needsAttention() {
    let id = Self.appId
    let attention: Set<RelayAccessProblem> = [.denied, .serverDenied, .clock, .storage, .optOutNotSaved]
    for problem in RelayAccessProblem.allCases {
      for retryAt in [nil, Self.until] {
        #expect(RelayRegistryContent.needsAttention(.problem(problem, appId: id, retryAt: retryAt))
          == attention.contains(problem), "\(problem) retryAt \(String(describing: retryAt))")
      }
    }
    #expect(RelayRegistryContent.needsAttention(.optedOut(appId: id, removal: .blockedByAdmin)))
    let calm: [RelayAccessStatus] = [
      .inactive, .working, .registered(appId: id, until: Self.until), .unsupported(appId: id),
      .optedOut(appId: id, removal: .confirmed), .optedOut(appId: id, removal: .pending),
      .problem(.unreachable, appId: id, retryAt: nil), .problem(.limited, appId: id, retryAt: Self.until),
      .problem(.gateFailed, appId: id, retryAt: nil),
    ]
    for status in calm { #expect(!RelayRegistryContent.needsAttention(status), "\(status)") }
  }

  @Test("VoiceOver labels of the rows: the row text, no empty label")
  func voiceOverLabels() {
    let statuses: [RelayAccessStatus] = [
      .working, .registered(appId: Self.appId, until: Self.until), .unsupported(appId: Self.appId),
      .optedOut(appId: Self.appId, removal: .pending),
      .problem(.limited, appId: Self.appId, retryAt: Self.until),
    ]
    for status in statuses {
      for row in Self.content(status)?.rows ?? [] {
        #expect(!row.accessibilityLabel.isEmpty, "\(status) \(row.identifier)")
        #expect(row.accessibilityLabel == row.text, "\(status) \(row.identifier)")
      }
    }
    #expect(Self.content(.registered(appId: Self.appId, until: Self.until))?.rows.first?.accessibilityLabel
      == "To urządzenie: 9f8e7d6c")
  }

  @Test("“Remove Me from the Registry”: hidden at optedOut and unsupported, shown otherwise")
  func removeVisibility() {
    let id = Self.appId
    let hidden: [RelayAccessStatus] = [
      .unsupported(appId: id), .optedOut(appId: id, removal: .confirmed), .optedOut(appId: id, removal: .pending),
      .optedOut(appId: id, removal: .blockedByAdmin),
    ]
    for status in hidden { #expect(Self.content(status)?.canRemove == false, "\(status)") }
    let shown: [RelayAccessStatus] = [
      .working, .registered(appId: id, until: Self.until),
    ] + RelayAccessProblem.allCases.map { .problem($0, appId: id, retryAt: nil) }
    for status in shown { #expect(Self.content(status)?.canRemove == true, "\(status)") }
  }

  @Test("button → confirmation → removal called once; “Cancel” calls nothing")
  func removalFlow() async {
    let calls = Calls()
    let removal = RelayRegistryRemoval()
    removal.ask()
    #expect(removal.confirming)
    #expect(calls.count == 0, "the button only asks")
    removal.cancel()
    #expect(!removal.confirming)
    #expect(calls.count == 0, "“Cancel” calls nothing")
    removal.ask()
    await removal.confirm { calls.count += 1 }
    #expect(calls.count == 1)
    #expect(!removal.confirming)
    #expect(!removal.inFlight)
  }

  @Test("a second confirmation while the removal is in flight calls nothing")
  func removalInFlight() async {
    let calls = Calls()
    let removal = RelayRegistryRemoval()
    let (gate, open) = AsyncStream.makeStream(of: Void.self)
    removal.ask()
    let first = Task { await removal.confirm { calls.count += 1; for await _ in gate { break } } }
    while calls.count == 0 { await Task.yield() }
    #expect(removal.inFlight)
    removal.ask()
    #expect(!removal.confirming, "no confirmation while a removal is in flight")
    await removal.confirm { calls.count += 1 }
    #expect(calls.count == 1)
    open.yield()
    open.finish()
    await first.value
    #expect(!removal.inFlight)
  }

  @Test("texts: section, button and confirmation; English source values exist")
  func sectionTexts() {
    #expect(UICopy.relaySection == "Rejestr relaya")
    #expect(UICopy.relayRemove == "Usuń mnie z rejestru")
    #expect(UICopy.relayRemoveConfirmBody
      == "Rejestr zapomni to urządzenie i jego poręczenia serwerów. Serwer poręczony przez inne Twoje urządzenie "
      + "zostaje. Połączenia przez relay mogą przestać działać, gdy relay zacznie sprawdzać dostęp.")
    #expect(UICopy.pairWaitingForRelay == "Czekam, aż relay wpuści serwer…")
    #expect(L("pairing.relaySection", language: .en) == "Relay registry")
    #expect(L("pairing.relayRemove", language: .en) == "Remove Me from the Registry")
    #expect(L("pairing.waitingForRelay", language: .en) == "Waiting for the relay to admit the server…")
  }
}
