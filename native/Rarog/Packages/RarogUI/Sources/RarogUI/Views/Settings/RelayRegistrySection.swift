import Foundation
import Observation
import RarogContract
import RarogCore
import RarogTransport
#if os(iOS)
import SwiftUI
#endif

// The "Relay registry" section of the "Server" page (`SettingsServerPage`): the app's short EndpointId, its
// status in the iroh relay registry with a hint, and "Remove Me from the Registry" behind a confirmation. Owner:
// pairing. The rows and the removal flow are plain types, so `swift test` checks them on macOS
// (`RelayRegistrySectionTests`); the SwiftUI view below draws from them. The status is the registry client's
// (`AppState.relayAccess`); the removal goes through `RarogStore.forgetRelayRegistration()`.

/// One row of the section. The device row is a label and a value ("This Device" | short EndpointId); the status row
/// is a sentence without a label, so its value is its text.
struct RelayRegistryRow: Equatable, Sendable {
  enum Tone: Equatable, Sendable { case plain, muted, warning }

  let text: String
  let accessibilityLabel: String
  let identifier: String
  let tone: Tone
  var label: String?
  var value: String

  init(text: String, accessibilityLabel: String, identifier: String, tone: Tone, label: String? = nil,
       value: String? = nil) {
    self.text = text
    self.accessibilityLabel = accessibilityLabel
    self.identifier = identifier
    self.tone = tone
    self.label = label
    self.value = value ?? text
  }
}

/// What the section shows for one status; no value at `inactive` (no section).
struct RelayRegistryContent: Equatable, Sendable {
  let rows: [RelayRegistryRow]
  /// "Remove Me from the Registry": hidden once the device has asked to leave and where it cannot register.
  let canRemove: Bool

  static func make(
    _ status: RelayAccessStatus, timeZone: TimeZone = .current, locale: Locale = CopyLocale.current
  ) -> RelayRegistryContent? {
    guard let text = UICopy.relayStatus(status, timeZone: timeZone, locale: locale) else { return nil }
    var rows: [RelayRegistryRow] = []
    if let appId = appId(status) {
      let device = UICopy.relayThisDevice(appId)
      rows.append(RelayRegistryRow(text: device, accessibilityLabel: device, identifier: "settings.relay.device",
                                   tone: .plain, label: UICopy.serverThisDevice, value: UICopy.irohShort(appId)))
    }
    rows.append(RelayRegistryRow(text: text, accessibilityLabel: text, identifier: "settings.relay.status",
                                 tone: tone(status)))
    return RelayRegistryContent(rows: rows, canRemove: canRemove(status))
  }

  /// Whether the relay needs the person: the state does not heal by itself (a block, the clock, unreadable registry
  /// storage, an unsaved or blocked removal). States the app retries on its own, a limit with a retry time and a
  /// pending removal do not count. Narrower than the warning tone of the status row.
  static func needsAttention(_ status: RelayAccessStatus) -> Bool {
    switch status {
    case .inactive, .working, .registered, .unsupported: false
    case let .optedOut(_, removal):
      switch removal {
      case .blockedByAdmin: true
      case .confirmed, .pending: false
      }
    case let .problem(problem, _, _):
      switch problem {
      case .denied, .serverDenied, .clock, .storage, .optOutNotSaved: true
      case .quota, .serverQuota, .limited, .gateMismatch, .proofRejected, .gateFailed, .internal, .unreachable: false
      }
    }
  }

  private static func appId(_ status: RelayAccessStatus) -> String? {
    switch status {
    case .inactive, .working: nil
    case let .registered(appId, _), let .unsupported(appId), let .optedOut(appId, _), let .problem(_, appId, _): appId
    }
  }

  private static func tone(_ status: RelayAccessStatus) -> RelayRegistryRow.Tone {
    switch status {
    case .problem, .optedOut(_, .blockedByAdmin): .warning
    case .inactive, .working, .registered, .unsupported, .optedOut: .muted
    }
  }

  private static func canRemove(_ status: RelayAccessStatus) -> Bool {
    switch status {
    case .optedOut, .unsupported: false
    case .inactive, .working, .registered, .problem: true
    }
  }
}

/// "Remove Me from the Registry": the button only asks, the confirmation calls the removal once, "Cancel" calls
/// nothing. A confirmation while a removal is in flight does nothing.
@MainActor
@Observable
final class RelayRegistryRemoval {
  /// The confirmation is on screen (bound to the dialog).
  var confirming = false
  private(set) var inFlight = false

  func ask() {
    guard !inFlight else { return }
    confirming = true
  }

  func cancel() { confirming = false }

  func confirm(_ remove: @MainActor () async -> Void) async {
    confirming = false
    guard !inFlight else { return }
    inFlight = true
    defer { inFlight = false }
    await remove()
  }
}

#if os(iOS)
/// The section on the "Server" page; nothing at `inactive`.
struct RelayRegistrySection: View {
  let store: RarogStore
  @State private var removal = RelayRegistryRemoval()

  var body: some View {
    if let content = RelayRegistryContent.make(store.state.relayAccess) {
      Section {
        ForEach(content.rows, id: \.identifier) { row in
          rowView(row)
            .accessibilityIdentifier(row.identifier)
        }
        if content.canRemove { removeButton }
      } header: {
        // The identifier sits on the header: on the `Section` it would replace the rows' own identifiers.
        Text(UICopy.relaySection)
          .accessibilityIdentifier("settings.relay")
      }
    }
  }

  /// The device row as a label and a monospaced value; the status row as a sentence, led by an amber warning glyph
  /// while its tone is warning, so the warning does not rest on colour alone.
  @ViewBuilder
  private func rowView(_ row: RelayRegistryRow) -> some View {
    if let label = row.label {
      LabeledContent(label) {
        Text(verbatim: row.value)
          .appFont(.callout.monospaced())
          .foregroundStyle(Color(uiColor: Palette.muted))
          .textSelection(.enabled)
      }
      .accessibilityElement(children: .combine)
    } else {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        if row.tone == .warning {
          Image(systemName: "exclamationmark.triangle.fill")
            .foregroundStyle(Color(uiColor: Palette.wait))
            .accessibilityHidden(true)
        }
        Text(verbatim: row.text)
          .appFont(.callout)
          .foregroundStyle(Color(uiColor: color(row.tone)))
          .fixedSize(horizontal: false, vertical: true)
          .textSelection(.enabled)
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(row.accessibilityLabel)
    }
  }

  private var removeButton: some View {
    @Bindable var removal = removal
    return Button(UICopy.relayRemove, role: .destructive) { removal.ask() }
      .disabled(removal.inFlight)
      .accessibilityIdentifier("settings.relay.remove")
      .confirmationDialog(UICopy.relayRemove, isPresented: $removal.confirming, titleVisibility: .hidden) {
        Button(UICopy.relayRemove, role: .destructive) {
          Task { await removal.confirm { await store.forgetRelayRegistration() } }
        }
        .accessibilityIdentifier("settings.relay.remove.confirm")
        Button(UICopy.pairCancel, role: .cancel) { removal.cancel() }
      } message: {
        Text(UICopy.relayRemoveConfirmBody)
      }
  }

  private func color(_ tone: RelayRegistryRow.Tone) -> UIColor {
    switch tone {
    case .plain: Palette.text
    case .muted: Palette.muted
    case .warning: Palette.wait
    }
  }
}
#endif
