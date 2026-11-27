#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI
import UIKit

/// The "Model and Effort" sheet of a live session: three rows instead of menus. Model and Effort are chips
/// (`RecentChip`) in rows that flow into further lines when the chips do not fit (`FlowLayout`), Ultracode is a
/// system segmented control Yes / No. A tap only CHOOSES; one Apply sends the difference of model, effort and
/// ultracode in one request.
/// On iPad a popover at the pill in the row under the message field (`Session/ComposerPills`), on a phone a sheet as
/// tall as its content.
///
/// Rules: without a change Apply is dimmed; closing asks nothing (an unapplied choice is not a change); a refusal
/// keeps the sheet with the server's sentence and drops the choice, and the new pill value comes with the stream;
/// a blocked session gets one sentence why and Dismiss; there is no "auto" effort; the warning about the global
/// effect (and, with ultracode alone, the cost sentence) is heard by VoiceOver, not drawn. Owner: header.
struct ModelSheet: View {
  let store: RarogStore
  let sessionId: String
  /// This presentation still stands (`SheetPresentation`) — the reply to a request sent before the sheet was closed
  /// and opened again goes nowhere.
  let isCurrent: () -> Bool
  /// Closes THIS presentation; a newer one stays.
  let dismiss: () -> Void
  /// The popover stands as a sheet (narrow class of the PRESENTER): its height is a detent fitted to the content.
  var compact = false
  @State private var contentHeight: CGFloat = 0
  /// The title bar over the content in the phone sheet: part of the detent height (the system adds the home indicator).
  @State private var barHeight: CGFloat = 0
  @Environment(\.dynamicTypeSize) private var typeSize

  /// Fields chosen by hand; untouched ones follow the session state.
  @State private var draft = ModelDraft()
  /// This sheet's own Apply is on its way. It stays set after a 202 while the sheet closes, so the closing sheet does
  /// not flash the in-flight sentence of its own change.
  @State private var sending = false
  @State private var error: String?
  @State private var loadFailed = false

  /// Space between the last row and Apply.
  private static let applyGap: CGFloat = 18

  var body: some View {
    // When the content does not fit (accessibility text, keyboard) it scrolls instead of cutting off Apply. The ideal
    // scroll height is the content height, so a popover with room looks as if it did not scroll. Not `ViewThatFits`:
    // swapping the view on a text size change confused the Dynamic Type audit.
    ScrollView {
      content.onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
    }
    .scrollBounceBehavior(.basedOnSize)
    .onGeometryChange(for: CGFloat.self) { $0.safeAreaInsets.top } action: {
      barHeight = $0
    }
    // The pill's popover stands in a UIKit hierarchy — the achromatic tint comes from here.
    .tint(Color(uiColor: Palette.text))
    .popoverLayout(contentHeight: contentHeight, ceiling: compact ? nil : PopoverLayout.ceiling)
    .presentationDetents(compact ? [.height(sheetHeight)] : [.medium, .large])
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("model.sheet")
    .dismissOnEscape(dismiss)
    .task { await reload() }
  }

  /// The phone sheet is as tall as its content: no empty band under Apply. Before the first measurement the content
  /// is 0, so the sheet starts at the floor and grows.
  private var sheetHeight: CGFloat {
    max(contentHeight + barHeight, PopoverLayout.minHeight * 3)
  }

  private var content: some View {
    let state = store.state
    // No header in the content: the rows have their own labels, and on a phone the sheet bar carries the title.
    return VStack(alignment: .leading, spacing: 16) {
      if let reason = state.modelSheetReason(for: sessionId, ownRequest: sending) {
        blocked(reason)
      } else if let choices = state.sessionControls.models {
        form(session: state.sessions[sessionId], choices: choices)
      } else if loadFailed {
        Text(UICopy.modelsFailed).appFont(.subheadline).foregroundStyle(Color(uiColor: Palette.err))
        Button(UICopy.diffRetry) { Task { await reload() } }
          .buttonStyle(NeutralButtonStyle())
      } else {
        HStack(spacing: 8) {
          ProgressView()
          Text(UICopy.modelsLoading).appFont(.subheadline).foregroundStyle(Color(uiColor: Palette.muted))
        }
      }
    }
    .padding(PopoverLayout.contentInset)
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func reload() async {
    loadFailed = false
    if await store.loadModels() == nil { loadFailed = true }
  }

  @ViewBuilder
  private func blocked(_ reason: String) -> some View {
    Text(reason)
      .appFont(.subheadline)
      .foregroundStyle(Color(uiColor: Palette.text))
      .fixedSize(horizontal: false, vertical: true)
      .accessibilityIdentifier("model.blocked")
    Button(UICopy.modelDismiss, action: dismiss)
      .buttonStyle(NeutralButtonStyle())
      .frame(maxWidth: .infinity)
      .accessibilityIdentifier("model.dismiss")
  }

  private func form(session: SessionSummary?, choices: [ModelChoice]) -> some View {
    let current = ModelSelection.current(session, choices: choices)
    let options = ModelSheetModel.options(current: current.model, choices: choices)
    let selected = draft.selection(current: current, options: options)
    let levels = ModelSheetModel.efforts(for: selected.model, options: options)
    let patch = ModelSheetModel.patch(current: current, draft: draft, options: options)

    return VStack(alignment: .leading, spacing: 0) {
      VStack(alignment: .leading, spacing: 14) {
        row(UICopy.modelGroup) {
          chips(options.map(\.value), selected: selected.model, identifier: "model.chip") { value in
            (options.first { $0.value == value }?.label ?? value, UICopy.modelChangeWarning)
          } pick: { value in
            draft.pick(model: value, options: options)
          }
        }
        // Effort does not dim with ultracode (unlike at start): in a live session a level does not turn it off.
        // An unknown model (no choice selected) hides the row: an empty level list then means "not known", not
        // "this model has no levels".
        if options.contains(where: { $0.value == selected.model }) {
          row(UICopy.effortGroup) {
            if levels.isEmpty {
              Text(UICopy.effortNone)
                .appFont(.subheadline)
                .foregroundStyle(Color(uiColor: Palette.muted))
                .fixedSize(horizontal: false, vertical: true)
                .frame(minHeight: RecentChip.hitHeight, alignment: .leading)
                .accessibilityIdentifier("model.effortNone")
            } else {
              chips(levels.map(\.rawValue), selected: selected.effort?.rawValue, identifier: "model.effort") { value in
                (value, nil)
              } pick: { value in
                if let level = EffortLevel(rawValue: value) { draft.pick(effort: level) }
              }
            }
          }
        }
        // Ultracode only for a model the server announced it for. Without proof on the card (`nil`) no segment is
        // selected, and No sends an explicit `false`.
        if ModelSheetModel.ultracodeAvailable(for: selected.model, options: options) {
          row(UICopy.ultracodeGroup) {
            Picker(UICopy.ultracodeGroup, selection: ultracodeBinding(selected.ultracode)) {
              Text(UICopy.ultracodeYes).tag(Bool?.some(true))
              Text(UICopy.ultracodeNo).tag(Bool?.some(false))
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
            .frame(minHeight: RecentChip.hitHeight)
            .accessibilityLabel(UICopy.ultracodeGroup)
            .accessibilityHint(UICopy.ultracodeHint)
            .accessibilityIdentifier("model.ultracode")
          }
        }
      }
      Button {
        apply(patch)
      } label: {
        HStack(spacing: 8) {
          if sending { ProgressView().controlSize(.small) }
          Text(UICopy.modelApply)
        }
      }
      .buttonStyle(PrimaryButtonStyle())
      .disabled(patch == nil || sending)
      .accessibilityHint(ModelSheetModel.applyHint(patch))
      .accessibilityIdentifier("model.apply")
      .padding(.top, Self.applyGap)
      if let error {
        Text(error)
          .appFont(.footnote)
          .foregroundStyle(Color(uiColor: Palette.err))
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("model.error")
          .onAppear { Announcer.shared.say(error, priority: .urgent) }
          .padding(.top, 12)
      }
    }
  }

  /// A row: the field name above its control. VoiceOver hears the name as a header before the chips.
  private func row(_ title: String, @ViewBuilder control: () -> some View) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(title)
        .appFont(.subheadline)
        .foregroundStyle(Color(uiColor: Palette.text))
        .accessibilityAddTraits(.isHeader)
      control()
    }
  }

  /// Chips in a row that flows into further lines when they do not fit, so every chip stays whole and in view at any
  /// text size. `describe` gives a chip its label and VoiceOver hint.
  private func chips(
    _ values: [String], selected: String?, identifier: String,
    describe: @escaping (String) -> (label: String, hint: String?), pick: @escaping (String) -> Void
  ) -> some View {
    FlowLayout(spacing: 8) {
      ForEach(values, id: \.self) { value in
        let pressed = value == selected
        let text = describe(value)
        Button {
          pick(value)
          error = nil
        } label: {
          RecentChip(label: text.label, pressed: pressed)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(pressed ? .isSelected : [])
        .accessibilityHint(text.hint ?? String())
        .accessibilityIdentifier("\(identifier).\(value)")
      }
    }
  }

  private func ultracodeBinding(_ value: Bool?) -> Binding<Bool?> {
    Binding(get: { value }, set: { on in
      guard let on else { return }
      draft.pick(ultracode: on)
      error = nil
    })
  }

  private func apply(_ patch: ModelSelection?) {
    guard let patch, !sending else { return }
    sending = true
    error = nil
    Task {
      let outcome = await store.setModel(
        sessionId, model: patch.model, effort: patch.effort, ultracode: patch.ultracode)
      // The sheet was closed during the request (it may be open again): this reply has no recipient here — the new
      // model comes with the list stream anyway.
      guard isCurrent() else { return }
      if outcome == .accepted {
        dismiss()
        return
      }
      sending = false
      // Drop the choice back to the session state — otherwise the sheet would show a choice that did not arrive.
      draft = ModelDraft()
      error = UICopy.controlMessage(outcome, fallback: UICopy.modelChangeFailed) ?? UICopy.modelChangeFailed
    }
  }
}
#endif
