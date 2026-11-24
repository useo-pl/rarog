#if os(iOS)
import UIKit

// Select More… at the end of a message text's edit menu: it opens the Transcript Text window, because a system
// selection lives in one text view and does not cross cells. Owner: transcript.

/// Ekran, który otwiera okno tekstu transkryptu od wiersza `row` (zaznaczenie systemu nie wychodzi poza jedną
/// wiadomość). Wiersz szuka go w łańcuchu responderów.
@MainActor protocol TranscriptSelectionOpening: AnyObject {
  func openTranscriptSelection(row: String)
}

extension MessageContentView: UITextViewDelegate {
  /// Menu systemowe zaznaczenia i na końcu „Zaznacz więcej…”, gdy nad wierszem stoi ekran, który umie otworzyć okno.
  func textView(
    _ textView: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]
  ) -> UIMenu? {
    guard let opener = Self.opener(from: textView) else { return nil }
    let row = String(current.accessibilityIdentifier.trimmingPrefix("message."))
    let more = UIAction(
      title: UICopy.transcriptSelectMore, image: UIImage(systemName: "text.viewfinder"),
      identifier: Self.selectMoreAction
    ) { [weak opener] _ in
      opener?.openTranscriptSelection(row: row)
    }
    return UIMenu(children: suggestedActions + [more])
  }

  /// Identyfikator pozycji „Zaznacz więcej…” w menu edycji.
  static let selectMoreAction = UIAction.Identifier("transcript.selectMore")

  /// Pierwszy responder nad widokiem, który otwiera okno tekstu transkryptu.
  static func opener(from view: UIResponder) -> TranscriptSelectionOpening? {
    var next = view.next
    while let responder = next {
      if let opener = responder as? TranscriptSelectionOpening { return opener }
      next = responder.next
    }
    return nil
  }
}
#endif
