#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI

// Sekcja NOTATKA na ekranie projektu bez sesji: tam notatka jest jedyną treścią, więc stoi od razu, bez
// stuknięcia. Tylko gdy ma treść — pustej sekcji nie ma, bo ikona notatki stoi w pasku tuż nad ekranem. Ten sam
// czytnik co w dymku, do 12 linii, potem „Pokaż całość" w miejscu; stopka jak w dymku. Właściciel: notatki.

struct NoteProjectSection: View {
  let doc: NoteDocument
  let hardwareKeyboard: Bool
  let edit: () -> Void
  let dictate: (() -> Void)?
  @State private var presentation = UUID()
  @State private var expanded = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  static let previewLines = 12

  var body: some View {
    let text = doc.readingText
    let lines = noteLineCount(text)
    // Podgląd tnie po liniach ŹRÓDŁA, nie po liniach układu: długi akapit stoi w całości, a „Pokaż całość" pojawia
    // się dokładnie wtedy, gdy czegoś nie widać.
    let preview = expanded || lines <= Self.previewLines
      ? text
      : text.split(separator: "\n", omittingEmptySubsequences: false).prefix(Self.previewLines).joined(separator: "\n")
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .firstTextBaseline) {
        Text(UICopy.noteEyebrow)
          .eyebrow()
          .accessibilityAddTraits(.isHeader)
        Spacer(minLength: 8)
        if let version = doc.server?.updatedAt, version > 0 {
          Text(UICopy.noteSavedAt(version))
            .appFont(.caption.monospaced())
            .foregroundStyle(Color(uiColor: Palette.muted2))
        }
      }
      NoteReader(text: preview)
      if lines > Self.previewLines {
        Button {
          withAnimation(reduceMotion ? nil : .snappy(duration: 0.22)) { expanded.toggle() }
        } label: {
          HStack(spacing: 6) {
            Text(expanded ? UICopy.noteShowLess : UICopy.noteShowAll(lines: lines))
            Image(systemName: expanded ? "chevron.up" : "chevron.down")
              .appFont(.caption)
          }
          .appFont(.footnote)
          .foregroundStyle(Color(uiColor: Palette.muted))
          .frame(minHeight: 44)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("project.note.more")
      }
      NotePanelFooter(
        hardwareKeyboard: hardwareKeyboard, edit: edit, dictate: doc.editable ? dictate : nil,
        background: Palette.background)
        .padding(.horizontal, -PopoverLayout.contentInset)
    }
    .padding(.top, 16)
    .overlay(alignment: .top) {
      Rectangle().fill(Color(uiColor: Palette.border)).frame(height: 1).accessibilityHidden(true)
    }
    .frame(maxWidth: 560, alignment: .leading)
    .onAppear { doc.attach(presentation) }
    .onDisappear { doc.detach(presentation) }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("project.note")
  }
}
#endif
