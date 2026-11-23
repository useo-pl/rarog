#if os(iOS)
import SwiftUI
import UIKit

// Okno „Zaznacz więcej…”: cały załadowany transkrypt w jednym `UITextView`, bo systemowe zaznaczenie żyje
// w jednym widoku tekstu i nie przechodzi przez komórki listy. Tu uchwyt ciągnie się przez wiele wiadomości, a widok
// przewija się sam przy przeciąganiu. Wzór okna historii terminala (`Terminal/TerminalHistorySheet.swift`)
// skopiowany, bez wspólnej abstrakcji: szkielet `WindowSheet` z „×” z lewej, rodzaj okna i projekt w tytule,
// „Kopiuj całość” ikoną z prawej; Esc, Cmd+W i „×” zamykają. Tekst to migawka z chwili otwarcia
// (``TranscriptTextRequest``, ``TranscriptSelectionText``): odpowiedź, która napływa w tle, go nie zmienia, a okno
// niczego nie pobiera z serwera. Do schowka wyłącznie gestem. Właściciel: transkrypt.

/// Okno tekstu transkryptu.
struct TranscriptSelectionSheet: View {
  let request: TranscriptTextRequest
  /// Szerokość okna apki (`appWindowWidth`), odczytana poza arkuszem.
  let windowWidth: CGFloat?
  @Environment(\.dismiss) private var dismiss
  @State private var copied = false

  var body: some View {
    WindowSheet(
      kind: UICopy.transcriptSelectionTitle, name: request.project, titleIdentifier: "transcript.selection.title",
      close: SheetClose(label: UICopy.popoverClose, identifier: "transcript.selection.close") { dismiss() },
      windowWidth: windowWidth
    ) {
      // Potwierdzenie kopii to podmiana ikony na ptaszek, bez koloru stanu (`docs/design.md`, „Anti-patterns").
      Button(action: copyAll) {
        Label(UICopy.terminalHistoryCopy, systemImage: copied ? "checkmark" : "doc.on.doc")
      }
      .disabled(request.text.isEmpty)
      .accessibilityIdentifier("transcript.selection.copy")
    } content: {
      TranscriptSelectionTextView(text: request.text, cursor: request.cursor)
        .accessibilityIdentifier("transcript.selection.text")
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: Palette.background))
        .task(id: copied) {
          // Ptaszek stoi 3 s, potem wraca ikona kopiowania.
          guard copied else { return }
          try? await Task.sleep(for: .seconds(3))
          copied = false
        }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("transcript.selection")
  }

  /// Cały tekst do schowka — jawny eksport na gest człowieka (to samo, co zaznaczenie i „Kopiuj”).
  private func copyAll() {
    guard Clipboard.copy(request.text) else {
      Announcer.shared.say(UICopy.copyFailed)
      return
    }
    copied = true
    Announcer.shared.say(UICopy.terminalCopyDone)
  }
}

/// Tekst okna: `UITextView` tylko do odczytu w piśmie treści, zaznaczalny i przewijalny, z kursorem przy wiadomości,
/// z której otwarto okno. Klawiaturę bierze od kotwicy okna jak tekst historii terminala (``HistoryTextView``), więc
/// Cmd+A zaznacza, a Cmd+C kopiuje bez dotykania tekstu.
struct TranscriptSelectionTextView: UIViewRepresentable {
  let text: String
  let cursor: Int

  func makeUIView(context: Context) -> UITextView {
    let view = HistoryTextView()
    view.isEditable = false
    view.isSelectable = true
    view.isScrollEnabled = true
    view.backgroundColor = Palette.background
    view.textColor = Palette.text
    view.font = Fonts.text(.body, category: TextSizeCategory(context.environment.dynamicTypeSize))
    view.adjustsFontForContentSizeCategory = true
    view.textContainerInset = UIEdgeInsets(top: 12, left: 12, bottom: 12, right: 12)
    view.dataDetectorTypes = []
    view.smartInsertDeleteType = .no
    return view
  }

  func updateUIView(_ view: UITextView, context: Context) {
    // The flat path gets a step through the environment, not as a trait change of the view.
    if context.environment.textStyleFlat {
      view.font = Fonts.text(.body, category: TextSizeCategory(context.environment.dynamicTypeSize))
    }
    guard view.text != text else { return }
    view.text = text
    let start = NSRange(location: min(max(0, cursor), (text as NSString).length), length: 0)
    view.selectedRange = start
    // Wiadomość, z której otwarto okno, u góry widoku — po pierwszym układzie, gdy pole zna swoją szerokość.
    DispatchQueue.main.async {
      view.layoutIfNeeded()
      Self.scroll(view, to: start)
    }
    (view as? HistoryTextView)?.takeKeyboard()
  }

  /// Przewija tak, żeby początek zakresu stał u góry widoku (w granicach treści).
  static func scroll(_ view: UITextView, to range: NSRange) {
    guard let position = view.position(from: view.beginningOfDocument, offset: range.location) else { return }
    let caret = view.caretRect(for: position)
    let maxY = max(0, view.contentSize.height + view.adjustedContentInset.bottom - view.bounds.height)
    let y = min(maxY, max(-view.adjustedContentInset.top, caret.minY - view.textContainerInset.top))
    view.setContentOffset(CGPoint(x: 0, y: y), animated: false)
  }
}
#endif
