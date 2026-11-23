#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI
import UIKit

// Dymek notatki projektu: CZYTANIE nad bieżącym ekranem — spod ikony w pasku zakładek albo przy nagłówku
// projektu w drzewie. Dymek nie ma pola, więc nic w nim nie ginie (utrata dymka nic nie kosztuje); pisanie
// prowadzi do formularza („Edytuj", mikrofon, ⌘J). iPad: popover na pełnym `surface`, wysokość z treści do sufitu;
// telefon: arkusz połowa/cały, a na połowie ekran pod spodem zostaje do obsłużenia (karta pytania). Właściciel:
// notatki (apka natywna).

/// Treść dymka: wiersz meta (iPad), tekst do czytania i stopka „Edytuj" + mikrofon.
struct NotePanel: View {
  let doc: NoteDocument
  /// Dymek stoi jako arkusz (wąska klasa PREZENTUJĄCEGO): wysokość daje detent, nie treść.
  let compact: Bool
  /// Klawiatura sprzętowa: przy „Edytuj" stoi „⌘J".
  let hardwareKeyboard: Bool
  let edit: () -> Void
  /// Mikrofon w stopce; `nil` = dyktowania nie ma (serwer bez klucza; martwego przycisku nie ma).
  let dictate: (() -> Void)?
  @State private var presentation = UUID()
  @Environment(RarogNavigation.self) private var navigation: RarogNavigation?
  @State private var contentHeight: CGFloat = 0
  @State private var footerHeight: CGFloat = 0

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 12) {
        meta
        if doc.ancestor == nil, doc.text.isEmpty {
          if doc.loadFailure != nil {
            Text(UICopy.noteLoadOffline)
              .appFont(.body)
              .foregroundStyle(Color(uiColor: Palette.muted))
          } else {
            NoteSkeleton()
          }
        } else {
          NoteReader(text: doc.readingText)
        }
      }
      .padding(PopoverLayout.contentInset)
      .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
    }
    .scrollBounceBehavior(.basedOnSize)
    .safeAreaInset(edge: .bottom, spacing: 0) {
      NotePanelFooter(hardwareKeyboard: hardwareKeyboard, edit: edit, dictate: doc.editable ? dictate : nil)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { footerHeight = $0 }
    }
    .popoverLayout(
      contentHeight: contentHeight, footerHeight: footerHeight, ceiling: compact ? nil : PopoverLayout.ceiling)
    .onAppear {
      doc.attach(presentation)
      navigation?.noteBubble = doc.cwd
    }
    .onDisappear {
      doc.detach(presentation)
      if navigation?.noteBubble == doc.cwd { navigation?.noteBubble = nil }
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("note.panel")
  }

  /// Etykieta NOTATKA (tylko iPad: na telefonie tytuł stoi w pasku arkusza) i czas zapisu z prawej.
  @ViewBuilder private var meta: some View {
    let saved = doc.server.flatMap { $0.updatedAt > 0 ? UICopy.noteSavedAt($0.updatedAt) : nil }
    if !PopoverLayout.sheetBar || saved != nil {
      HStack(alignment: .firstTextBaseline) {
        if !PopoverLayout.sheetBar {
          Text(UICopy.noteEyebrow)
            .eyebrow()
            .accessibilityAddTraits(.isHeader)
        }
        Spacer(minLength: 8)
        if let saved {
          Text(saved)
            .appFont(.caption.monospaced())
            .foregroundStyle(Color(uiColor: Palette.muted2))
        }
      }
    }
  }
}

/// Stopka dymka i sekcji ekranu projektu: „Edytuj" (przejście do formularza) z lewej, mikrofon z prawej. Kreska nad
/// nią i cichy atrament — to przejście do większego widoku, nie główna akcja (wzór `PopoverFooterRow`).
struct NotePanelFooter: View {
  let hardwareKeyboard: Bool
  let edit: () -> Void
  let dictate: (() -> Void)?
  var background: UIColor = Palette.surface

  var body: some View {
    VStack(spacing: 0) {
      Rectangle()
        .fill(Color(uiColor: Palette.border))
        .frame(height: 1)
        .accessibilityHidden(true)
      HStack(spacing: 10) {
        Button(action: edit) {
          HStack(spacing: 10) {
            Image(systemName: "square.and.pencil")
            Text(UICopy.noteEdit)
              .fixedSize(horizontal: false, vertical: true)
            if hardwareKeyboard {
              Text("⌘J")
                .appFont(.caption.monospaced())
                .foregroundStyle(Color(uiColor: Palette.muted2))
            }
            Spacer(minLength: 8)
          }
          .appFont(.footnote)
          .foregroundStyle(Color(uiColor: Palette.muted))
          .frame(minHeight: 44)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(UICopy.noteEditSpoken)
        .accessibilityIdentifier("note.panel.edit")
        if let dictate {
          NoteMicButton(recording: false, action: dictate)
            .accessibilityIdentifier("note.panel.mic")
        }
      }
      .padding(.horizontal, PopoverLayout.contentInset)
    }
    .background(Color(uiColor: background))
  }
}

/// Mikrofon notatki: kółko 32 pt z kreską w celu 44 pt (jak w polu wiadomości); w nagraniu kreska i ikona
/// w kolorze błędu (`docs/design.md`: kolor niesie stan nagrania).
struct NoteMicButton: View {
  let recording: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Image(systemName: recording ? "mic.fill" : "mic")
        .font(.system(size: 15, weight: .medium))
        .foregroundStyle(Color(uiColor: recording ? Palette.err : Palette.muted))
        .frame(width: 32, height: 32)
        .overlay(Circle().strokeBorder(Color(uiColor: recording ? Palette.err : Palette.border)))
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(UICopy.noteDictate)
    .accessibilityHint(recording ? UICopy.voiceMicStopHint : UICopy.voiceMicHint)
    .accessibilityAddTraits(recording ? .isSelected : [])
  }
}
#endif
