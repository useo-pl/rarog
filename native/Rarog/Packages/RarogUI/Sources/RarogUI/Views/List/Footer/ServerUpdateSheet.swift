#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI

// Popover of the list footer's "Server update available" row: how to update the server. One sentence with both
// versions and where to run the command (Mac or VPS), the command on its own selectable monospaced line with a copy
// button, and one sentence on what the command does. Beside the detail a popover sized to its content, in the stack a
// sheet with the title bar (`popoverSheetChrome`). Owner: list.

struct ServerUpdateSheet: View {
  let update: ServerUpdate
  let machine: ServerMachine
  /// The popover stands as a sheet (stacked window): the detent gives the height, not the content.
  var compact = false
  let dismiss: () -> Void
  @State private var contentHeight: CGFloat = 0
  @State private var copied = false

  var body: some View {
    ScrollView {
      content.onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
    }
    .scrollBounceBehavior(.basedOnSize)
    .popoverLayout(contentHeight: contentHeight, ceiling: compact ? nil : PopoverLayout.ceiling)
    .popoverSheetChrome(title: UICopy.serverUpdateSheetTitle)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("list.serverUpdate.sheet")
    .dismissOnEscape(dismiss)
  }

  private var content: some View {
    VStack(alignment: .leading, spacing: 12) {
      if !PopoverLayout.sheetBar {
        // The iPad popover has no title bar: the eyebrow carries the name.
        Text(UICopy.serverUpdateSheetTitle)
          .eyebrow()
          .accessibilityAddTraits(.isHeader)
      }
      Text(UICopy.serverUpdateSheetIntro(update, machine))
        .appFont(.footnote)
        .foregroundStyle(Color(uiColor: Palette.text))
        .fixedSize(horizontal: false, vertical: true)
      command
      Text(UICopy.serverUpdateSheetAfter)
        .appFont(.caption)
        .foregroundStyle(Color(uiColor: Palette.muted))
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(PopoverLayout.contentInset)
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  /// The command in a code block with the copy icon beside it; the check mark replaces the icon for a moment after
  /// a copy, like the transcript's code blocks (`Clipboard`).
  private var command: some View {
    HStack(alignment: .center, spacing: 8) {
      Text(update.command)
        .appFont(.footnote.monospaced())
        .foregroundStyle(Color(uiColor: Palette.text))
        .fixedSize(horizontal: false, vertical: true)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("list.serverUpdate.command")
      Button {
        guard Clipboard.copy(update.command) else { return }
        copied = true
        Task {
          try? await Task.sleep(for: Clipboard.hold)
          copied = false
        }
      } label: {
        Image(systemName: copied ? "checkmark" : "doc.on.doc")
          .foregroundStyle(Color(uiColor: Palette.muted))
          .frame(width: 44, height: 44)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(UICopy.copyCommand)
      .accessibilityIdentifier("list.serverUpdate.copy")
    }
    .padding(.leading, 12)
    .padding(.vertical, 2)
    .background(
      RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color(uiColor: Palette.codeBlockFill)))
  }
}
#endif
