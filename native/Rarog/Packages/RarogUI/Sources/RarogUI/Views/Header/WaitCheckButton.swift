#if os(iOS)
import RarogCore
import SwiftUI
import UIKit

// "Check" under the row of a subagent that has waited long on its own background command, in the "in the background"
// section (popover and inspector), aligned with the row's description. A tap sends the main agent the fixed message
// (`WaitCheckMessage`) once per wait; whether the button stands and what it shows comes from the store
// (`AppState.waitCheck(_:in:)`), so a closed popover and the inspector see the same guard. Once the server took the
// message, "Sent · 21:40" stands in its place. It stays outside the row's VoiceOver element, which ignores its children.
// Owner: header.

/// The store and the session of a Background section, for its Check buttons; the popover and the inspector set it.
struct WaitCheckScope {
  let store: RarogStore
  let sessionId: String
}

extension EnvironmentValues {
  @Entry var waitCheckScope: WaitCheckScope? = nil
}

struct WaitCheckButton: View {
  let check: WaitCheckMessage
  /// The subagent's task id, for the identifier.
  let task: String
  @Environment(\.waitCheckScope) private var scope
  @Environment(\.sectionPlace) private var place
  @AppScaledMetric(relativeTo: .subheadline) private var column = RowGrid.column

  var body: some View {
    if let scope, let model = WaitCheckButtonModel(scope.store.state.waitCheck(check.key, in: scope.sessionId)) {
      content(model, scope)
        .padding(.leading, column + RowGrid.gap)
        .padding(.bottom, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier(place.id("background.task.\(task).check"))
    }
  }

  @ViewBuilder
  private func content(_ model: WaitCheckButtonModel, _ scope: WaitCheckScope) -> some View {
    if model.sent {
      Text(model.title)
        .appFont(.caption.monospacedDigit())
        .foregroundStyle(Color(uiColor: Palette.muted))
        .accessibilityLabel(model.spoken)
    } else {
      Button {
        let (store, sessionId, key, text) = (scope.store, scope.sessionId, check.key, check.text)
        Task { await store.checkWait(key, text: text, in: sessionId) }
      } label: {
        HStack(spacing: 6) {
          if model.busy { ProgressView().controlSize(.small) }
          Text(model.title)
        }
      }
      .buttonStyle(NeutralButtonStyle())
      .disabled(!model.enabled)
      .accessibilityLabel(model.spoken)
      .accessibilityHint(UICopy.waitCheckHint)
    }
  }
}
#endif
