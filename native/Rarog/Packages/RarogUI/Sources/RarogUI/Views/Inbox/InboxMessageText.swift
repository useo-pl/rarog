#if os(iOS)
import SwiftUI
import UIKit

// The agent's message on an Inbox card: the transcript's own text view (`MessageContentView`), so a card draws the
// markdown, the code blocks with their copy icons and the "To you:" stripe exactly as the transcript does, with the
// same selection and links. The text renders with the agent reply style of the transcript and its question
// recognition; the card spaces it (`bare`). Owner: Inbox.

struct InboxMessageText: UIViewRepresentable {
  let source: String
  /// VoiceOver identifier of the text view.
  let identifier: String

  @MainActor
  final class Coordinator {
    let cache = MarkdownCache()
    var key: (source: String, size: UIContentSizeCategory, style: UIUserInterfaceStyle, scale: TextSizeCategory)?
    var source = ""
    var identifier = ""

    func render(into view: MessageContentView) {
      let traits = view.traitCollection
      let key = (source, traits.preferredContentSizeCategory, traits.userInterfaceStyle, Fonts.category)
      guard self.key.map({ $0 != key }) ?? true else { return }
      self.key = key
      let style = MarkdownRenderer.Style(
        textColor: Palette.prose, strongColor: Palette.strong, base: MarkdownRenderer.transcriptStyle, traits: traits,
        questions: true)
      var config = MessageContentConfiguration(
        voice: nil, text: cache.text(source, style: style), plate: false, dimmed: false,
        accessibilityIdentifier: identifier, accessibilityPrefix: nil)
      config.bare = true
      view.configuration = config
      view.invalidateIntrinsicContentSize()
    }
  }

  func makeCoordinator() -> Coordinator { Coordinator() }

  func makeUIView(context: Context) -> MessageContentView {
    let empty = MessageContentConfiguration(
      voice: nil, text: NSAttributedString(), plate: false, dimmed: false, accessibilityIdentifier: identifier,
      accessibilityPrefix: nil)
    let view = MessageContentView(configuration: empty)
    view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    let coordinator = context.coordinator
    // SwiftUI does not update the view when only its traits change: the view renders again itself.
    view.registerForTraitChanges([UITraitPreferredContentSizeCategory.self, UITraitUserInterfaceStyle.self]) {
      (view: MessageContentView, _) in
      coordinator.render(into: view)
    }
    Fonts.follow(view) { [weak view, weak coordinator] in
      guard let view, let coordinator else { return }
      coordinator.render(into: view)
    }
    return view
  }

  func updateUIView(_ view: MessageContentView, context: Context) {
    context.coordinator.source = source
    context.coordinator.identifier = identifier
    context.coordinator.render(into: view)
  }

  func sizeThatFits(_ proposal: ProposedViewSize, uiView: MessageContentView, context: Context) -> CGSize? {
    guard let width = proposal.width, width.isFinite, width > 0 else { return nil }
    let size = uiView.systemLayoutSizeFitting(
      CGSize(width: width, height: UIView.layoutFittingCompressedSize.height),
      withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel)
    return CGSize(width: width, height: ceil(size.height))
  }
}
#endif
