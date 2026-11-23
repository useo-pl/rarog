#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI
import UIKit

// Wejście do notatki projektu w pasku zakładek: ostatni element przed „+", na ekranie sesji, terminala
// i projektu bez sesji — jedno wejście dla każdego stanu projektu. Bez znaku stanu i bez cyfry ⌘ (notatka nie jest
// miejscem; ma ⌘J). Kolor mówi stan: `note.text` w bursztynie `noteInk` = jest treść (stuknięcie:
// dymek do czytania), szary `note.text` = pusta albo nie wiadomo (stuknięcie: formularz od razu); kropka
// w kolorze błędu = tekst niezapisany na tym urządzeniu (przy „Rozróżniaj bez koloru" znak `!`). Ten sam glif
// (`NoteGlyph`) stoi przy każdym projekcie w drzewie. Właściciel: notatki (apka natywna).

struct NoteTabButton: View {
  let model: NoteTabModel
  let hardwareKeyboard: Bool
  /// Mikrofon w stopce dymka (`nil` = bez dyktowania).
  let voice: Bool
  @Environment(ProjectNotes.self) private var notes
  @Environment(RarogNavigation.self) private var navigation
  @Environment(\.horizontalSizeClass) private var sizeClass
  @State private var open = false
  /// Formularz do otwarcia po zejściu dymka (wzór `openPanelAfterDismiss`): system zdejmuje dymek, a arkusz staje
  /// dopiero na czystym ekranie — na telefonie dymek jest arkuszem, dwa naraz nie istnieją.
  @State private var then: NoteRequest.Start?

  var body: some View {
    Button(action: tap) { NoteTabLabel(model: model, open: open) }
      .buttonStyle(TabPressStyle())
      .accessibilityLabel(UICopy.noteProject)
      .accessibilityValue(model.spokenValue)
      .accessibilityHint(model.readable ? UICopy.noteTabReadHint : UICopy.noteTabWriteHint)
      .accessibilityIdentifier("tabs.note")
      .shortcutTip(UICopy.noteProject, .note)
      .popover(isPresented: $open, arrowEdge: .top) {
        NotePanel(
          doc: notes.document(model.cwd), compact: sizeClass != .regular, hardwareKeyboard: hardwareKeyboard,
          edit: { leave(to: .edit) }, dictate: voice ? { leave(to: .dictate) } : nil)
          .dismissOnEscape { open = false }
          .popoverSheetChrome(title: UICopy.noteTitle)
          .popoverSurface()
          .presentationCompactAdaptation(.sheet)
          .presentationBackgroundInteraction(.enabled(upThrough: .medium))
          .onDisappear {
            guard let start = then else { return }
            then = nil
            navigation.openNote(cwd: model.cwd, start: start)
          }
      }
  }

  private func tap() {
    if model.readable {
      open = true
    } else {
      navigation.openNote(cwd: model.cwd, start: .edit)
    }
  }

  private func leave(to start: NoteRequest.Start) {
    then = start
    open = false
  }
}

/// Glif notatki: kształt i kolor z modelu (`NoteGlyphTone`), nad nim znak tekstu niezapisanego. Pismo daje miejsce
/// użycia (`.font`). Wspólny dla paska zakładek (`NoteTabLabel`) i nagłówka projektu w drzewie (`TreeNoteButton`).
struct NoteGlyph: View {
  let model: NoteTabModel
  /// Pod wskaźnikiem albo przy otwartym dymku szary glif wraca do pełnego tekstu; bursztyn zostaje bursztynem.
  var lit = false
  @Environment(\.accessibilityDifferentiateWithoutColor) private var differentiateWithoutColor

  var body: some View {
    Image(systemName: model.glyph)
      .foregroundStyle(Color(uiColor: ink))
      .overlay(alignment: .topTrailing) {
        if model.unsaved {
          if differentiateWithoutColor {
            Image(systemName: "exclamationmark")
              .appFont(.caption.weight(.bold))
              .foregroundStyle(Color(uiColor: Palette.err))
              .offset(x: 8, y: -6)
          } else {
            Circle()
              .fill(Color(uiColor: Palette.err))
              .frame(width: 6, height: 6)
              .offset(x: 4, y: -3)
          }
        }
      }
  }

  private var ink: UIColor {
    switch model.tone {
    case .note: Palette.noteInk
    case .quiet: lit ? Palette.text : Palette.muted2
    }
  }
}

/// Treść przycisku notatki w celu 44 pt. Osobny widok, bo stan wskaźnika przychodzi środowiskiem od stylu
/// (`TabPressStyle` przez `RarogHoverReader`), a środowisko widzi dopiero etykieta przycisku. Pod wskaźnikiem glif
/// na płytce w połowie krycia, jak zakładka-siostra.
struct NoteTabLabel: View {
  let model: NoteTabModel
  /// Dymek notatki otwarty: szary glif w pełnym tekście.
  let open: Bool
  @Environment(\.rarogHovered) private var hovered
  /// Glif 14 pt przy domyślnym piśmie, rośnie z nim jak `caption`.
  /// Zostaje o punkt pod „+” (`subheadline`, 15 pt).
  @AppScaledMetric(relativeTo: .caption) private var glyphSize: CGFloat = 14

  var body: some View {
    NoteGlyph(model: model, lit: open || hovered)
      .font(.system(size: glyphSize))
      // W osi etykiet zakładek, które stoją `tabLabelDrop` niżej środka celu.
      .offset(y: HeaderMetrics.tabLabelDrop)
      .frame(minWidth: 44, minHeight: 44)
      .background { if hovered { TabPlate(opacity: HoverTokens.agentRowAlpha) } }
      .contentShape(Rectangle())
      .accessibilityHidden(true)
  }
}

#endif
