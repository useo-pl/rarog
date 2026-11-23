#if os(iOS)
import SwiftUI
import UIKit

// Window "Full Request" of a permission card whose block shows a preview (logic
// `Model/ConsentInputPreview.swift`): the whole input up to the hook's 1 MiB in one read-only `UITextView`, which lays
// out lazily, scrolls and selects. The text is a snapshot from the moment the window opened; approve stays on the card.
// The content appearing is what unlocks the card's consent (`FullInputMarks`).
// Frame as the transcript text window (`Session/TranscriptSelectionSheet.swift`): "×", Esc and Cmd+W close it.
// Owner: cards.

/// Window with the whole input of one card.
struct ConsentInputSheet: View {
  let request: ConsentInputRequest
  /// Width of the app window (`appWindowWidth`), read outside the sheet.
  let windowWidth: CGFloat?
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    WindowSheet(
      kind: UICopy.consentFullInputTitle, name: request.toolName, titleIdentifier: "card.fullInput.title",
      close: SheetClose(label: UICopy.popoverClose, identifier: "card.fullInput.close") { dismiss() },
      windowWidth: windowWidth
    ) {
      EmptyView()
    } content: {
      ConsentInputTextView(text: request.text)
        .accessibilityIdentifier("card.fullInput.text")
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: Palette.background))
        // The whole input is on screen: the session screen that opened this window unlocks the card's consent. Not
        // the navigation state: a window closed or replaced before this point never reports.
        .onAppear { request.contentAppeared() }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("card.fullInput")
  }
}

/// Read-only, selectable, scrolling text in the card block's monospaced type; Cmd+A and Cmd+C work from the window's
/// anchor as in the terminal history (``HistoryTextView``).
struct ConsentInputTextView: UIViewRepresentable {
  let text: String

  func makeUIView(context: Context) -> UITextView {
    let view = HistoryTextView()
    view.isEditable = false
    view.isSelectable = true
    view.isScrollEnabled = true
    view.backgroundColor = Palette.background
    view.textColor = Palette.text
    view.font = Self.font(context.environment)
    view.adjustsFontForContentSizeCategory = true
    view.textContainerInset = UIEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)
    view.dataDetectorTypes = []
    view.smartInsertDeleteType = .no
    return view
  }

  /// Footnote at the default size is 13 pt, scaled with the text size of the view's environment.
  private static func font(_ environment: EnvironmentValues) -> UIFont {
    Fonts.scaled(
      .monospacedSystemFont(ofSize: 13, weight: .regular), relativeTo: .footnote,
      category: TextSizeCategory(environment.dynamicTypeSize))
  }

  func updateUIView(_ view: UITextView, context: Context) {
    // The flat path gets a step through the environment, not as a trait change of the view.
    if context.environment.textStyleFlat { view.font = Self.font(context.environment) }
    guard view.text != text else { return }
    view.text = text
    view.selectedRange = NSRange(location: 0, length: 0)
    (view as? HistoryTextView)?.takeKeyboard()
  }
}
#endif
