#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI

// Ekran projektu bez żywej sesji (trzecie wyjście). Właściciel: nowa sesja.

/// Projekt z historii CLI albo po zamknięciu ostatniej sesji: nazwa, ścieżka i „Nowa sesja…" —
/// formularz nowej sesji z TYM katalogiem, więc od razu widać „Wznów istniejącą" tego
/// projektu i ustawienia startu. Szybki start z zapamiętanym modelem zostaje pod „+" w pasku
/// zakładek i pod Cmd+N. Wejście w projekt nigdy nie jest ślepym zaułkiem.
struct ProjectEmptyView: View {
  let cwd: String
  let store: RarogStore
  let navigation: RarogNavigation
  @Environment(NewSessionPresenter.self) private var presenter: NewSessionPresenter?
  /// Notatki projektów: sekcja NOTATKA pod „Nową sesją…", gdy notatka ma treść.
  @Environment(ProjectNotes.self) private var notes: ProjectNotes?

  var body: some View {
    let note = noteDocument
    if let note {
      // Z notatką stos staje u góry i przewija się: długa notatka nie wypycha „Nowej sesji…" pod zgięcie.
      ScrollView {
        VStack(spacing: 32) {
          head
          NoteProjectSection(
            doc: note, hardwareKeyboard: TerminalKeyboard.isConnected(),
            edit: { navigation.openNote(cwd: cwd) },
            dictate: { navigation.openNote(cwd: cwd, start: .dictate) })
            // Tożsamość katalogu: przejście projekt A → projekt B to nowa prezentacja (podpięcie, odczyt, zwinięcie).
            .id(cwd)
            .padding(.horizontal, 16)
        }
        .padding(.top, 24)
        .padding(.bottom, 24)
        .frame(maxWidth: .infinity)
      }
    } else {
      head
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
  }

  /// Dokument notatki do sekcji: serwer ma notatki, projekt ma treść (bit albo odczyt) i nie leży niezapisana.
  private var noteDocument: NoteDocument? {
    let state = store.state
    guard state.notesAvailable, let notes, state.hasNote(cwd) == true else { return nil }
    let doc = notes.document(cwd)
    return NotesRules.isEmpty(doc.readingText) && doc.ancestor != nil ? nil : doc
  }

  private var head: some View {
    let blocked = store.state.launchBlocked ? UICopy.launchBlocked(store.state.launchBlockedDetail) : nil
    return VStack(spacing: 16) {
      Text(ProjectPath.name(cwd))
        .appFont(.title2.weight(.semibold))
        .foregroundStyle(Color(uiColor: Palette.text))
      Text(PathText.shortPath(cwd))
        .appFont(.footnote.monospaced())
        .foregroundStyle(Color(uiColor: Palette.muted2))
      Text(UICopy.projectEmpty)
        .appFont(.body)
        .foregroundStyle(Color(uiColor: Palette.muted))
        .multilineTextAlignment(.center)
      Button(UICopy.newSessionOpen) {
        presenter?.openNewSession(cwd: cwd)
      }
      .buttonStyle(NeutralButtonStyle())
      .controlSize(.large)
      .opacity(blocked == nil ? 1 : 0.6)
      .accessibilityHint(blocked ?? "")
      .accessibilityIdentifier("project.new-session")
      if let blocked {
        Text(blocked)
          .appFont(.footnote)
          .foregroundStyle(Color(uiColor: Palette.muted))
          .multilineTextAlignment(.center)
      }
    }
  }
}
#endif
