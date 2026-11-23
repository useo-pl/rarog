#if os(iOS)
import SwiftUI
import UIKit

// Tekst notatki projektu do CZYTANIA: ten sam renderer markdownu co transkrypt (nagłówki, listy, kod w linii,
// działające linki), w `UITextView` bez edycji — przytrzymanie zaznacza, tap w link otwiera, tap w tekst nic nie
// robi (do pisania prowadzą „Edytuj", mikrofon i ⌘J). Wysokość z treści; przewija kontener (dymek, sekcja ekranu
// projektu). Właściciel: notatki (apka natywna).

/// Notatka wyrenderowana do czytania, w całości (podgląd sekcji ekranu projektu tnie tekst źródła przed renderem).
struct NoteReader: UIViewRepresentable {
  let text: String

  @MainActor
  final class Coordinator {
    /// Tekst i pismo ostatniego renderu — markdown liczy się tylko przy zmianie.
    /// `scale` is the app's text size on the flat path (`Fonts.category`, Large on the standard path).
    var rendered: (text: String, size: UIContentSizeCategory, style: UIUserInterfaceStyle, scale: TextSizeCategory)?
    /// The text of the last update, rendered again when the view's text size or theme changes.
    var text = ""

    func render(into view: UITextView) {
      let traits = view.traitCollection
      let key = (text, traits.preferredContentSizeCategory, traits.userInterfaceStyle, Fonts.category)
      guard rendered.map({ $0 != key }) ?? true else { return }
      let sameText = rendered?.text == text
      rendered = key
      let style = MarkdownRenderer.Style(textColor: Palette.text, base: .body, traits: traits)
      let selection = view.selectedRange
      view.attributedText = MarkdownRenderer.render(text, style: style)
      // The same text at a new size or theme keeps what was selected.
      if sameText, NSMaxRange(selection) <= view.attributedText.length { view.selectedRange = selection }
      view.invalidateIntrinsicContentSize()
    }
  }

  func makeCoordinator() -> Coordinator { Coordinator() }

  func makeUIView(context: Context) -> UITextView {
    let view = UITextView()
    view.isEditable = false
    view.isSelectable = true
    view.isScrollEnabled = false
    view.backgroundColor = .clear
    view.textContainerInset = .zero
    view.textContainer.lineFragmentPadding = 0
    view.linkTextAttributes = [.foregroundColor: Palette.linkInk, .underlineStyle: NSUnderlineStyle.single.rawValue]
    view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    view.setContentHuggingPriority(.required, for: .vertical)
    view.accessibilityIdentifier = "note.reader"
    // SwiftUI does not update the view when only its traits change (a text size set on the scene, the view put back
    // on a window): the view renders again itself.
    let coordinator = context.coordinator
    view.registerForTraitChanges([UITraitPreferredContentSizeCategory.self, UITraitUserInterfaceStyle.self]) {
      (view: UITextView, _) in
      coordinator.render(into: view)
    }
    // On the flat path (a Mac) a step of the app's text size changes no trait of a view outside a text size host.
    Fonts.follow(view) { [weak view, weak coordinator] in
      guard let view, let coordinator else { return }
      coordinator.render(into: view)
    }
    return view
  }

  func updateUIView(_ view: UITextView, context: Context) {
    context.coordinator.text = text
    context.coordinator.render(into: view)
  }

  func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
    guard let width = proposal.width, width.isFinite, width > 0 else { return nil }
    let size = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
    return CGSize(width: width, height: ceil(size.height))
  }
}

/// Szkielet tekstu w trakcie pierwszego odczytu: trzy belki, bez migotania.
struct NoteSkeleton: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      ForEach([0.92, 0.78, 0.6], id: \.self) { fraction in
        GeometryReader { proxy in
          RoundedRectangle.ghost
            .fill(Color(uiColor: Palette.surface2))
            .frame(width: proxy.size.width * fraction, height: 12)
        }
        .frame(height: 12)
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(UICopy.noteLoading)
  }
}

/// Liczba linii tekstu notatki tak, jak widzi je człowiek w polu (bez zawijania).
func noteLineCount(_ text: String) -> Int {
  text.isEmpty ? 0 : text.split(separator: "\n", omittingEmptySubsequences: false).count
}
#endif
