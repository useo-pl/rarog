import Foundation
import RarogCore

// Glif notatki projektu jako dane: w pasku zakładek i przy każdym projekcie w drzewie.
// Kształt, kolor i zdanie dla czytnika z rejestru notatek i bitu w stanie apki. Widoki: `Views/Notes/NoteTabButton.swift`
// (pasek, `NoteGlyph`) i nagłówek drzewa (`ProjectTreeList.swift`). Logika bez UIKit — testy na macOS.
// Właściciel: notatki.

/// Note glyph color: grey without content (empty, unknown or an unsaved draft), amber with content. The shape is the
/// same in every state; VoiceOver hears the state from `spokenValue`.
enum NoteGlyphTone: Equatable {
  case quiet
  case note

  /// Para tokenów (`PaletteTokens`): `muted2` albo `noteInk`.
  var pair: PaletteTokens.Pair {
    switch self {
    case .quiet: PaletteTokens.muted2
    case .note: PaletteTokens.noteInk
    }
  }
}

/// Stan glifu notatki, policzony z rejestru notatek i bitu w stanie apki.
struct NoteTabModel: Equatable {
  let cwd: String
  /// Notatka ma treść (bit z serwera albo odczyt apki) i na urządzeniu nie leży nic niezapisanego.
  let readable: Bool
  let unsaved: Bool

  /// One shape for every state:
  /// the color alone tells content from none, and the unsaved dot stays on top.
  var glyph: String { "note.text" }

  /// Bursztyn tylko przy treści do przeczytania; niezapisany szkic ma szary glif i kropkę błędu (`unsaved`).
  var tone: NoteGlyphTone { readable ? .note : .quiet }

  var spokenValue: String {
    if unsaved { return UICopy.noteTabUnsaved }
    return readable ? UICopy.noteTabContent : UICopy.noteTabEmpty
  }
}

extension NoteTabModel {
  /// Glif dla projektu `cwd`; `nil`, gdy serwer notatek nie ma (żadnego wejścia, nic nie sugeruje zapisu).
  @MainActor
  static func make(cwd: String, state: AppState, notes: ProjectNotes) -> NoteTabModel? {
    guard state.notesAvailable else { return nil }
    let unsaved = notes.unsaved(cwd)
    return NoteTabModel(cwd: cwd, readable: !unsaved && state.hasNote(cwd) == true, unsaved: unsaved)
  }
}
