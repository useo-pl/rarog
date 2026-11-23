import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Kolor glifu notatki projektu w drzewie i w pasku zakładek oraz znak wiersza „w tle”
// (klepsydra subagenta w postoju w przydymionej zieleni).

@MainActor
private func project(notes: Bool = true) throws -> AppState {
  var state = AppState(clientBuild: 1)
  let session = Sample.session(id: "p1", title: "rarog", label: "resync", state: "waiting-input", createdAgo: 600, activityAgo: 10)
  state.sessions[session.id] = session
  state.sessionsLoaded = true
  state.global = .online
  state.compat = .ok
  let version = try JSONDecoder().decode(
    VersionInfo.self, from: Data(#"{"version":"1","protocolVersion":3,"serverStartId":"s","notesEnabled":\#(notes)}"#.utf8))
  state.capabilities = Capabilities(version)
  return state
}

@MainActor
@Suite("glif notatki: szary bez notatki, bursztyn z notatką, przy każdym projekcie")
struct NoteGlyphToneTests {
  private let cwd = "/Users/demo/Projects/rarog"

  private func notes(drafts: NoteDrafts? = nil) -> ProjectNotes {
    let io = NoteIO(fetch: { _ in .loaded(.empty) }, save: { _, _, _ in .saved(1) })
    guard let drafts else { return ProjectNotes(io: io) }
    return ProjectNotes(io: io, drafts: drafts)
  }

  @Test("unknown state (`nil`) → grey `note.text`, the glyph stands")
  func unknownIsQuiet() throws {
    let state = try project()
    #expect(state.hasNote(cwd) == nil)
    let model = try #require(NoteTabModel.make(cwd: cwd, state: state, notes: notes()))
    #expect(model.tone == .quiet && model.tone.pair == PaletteTokens.muted2)
    #expect(model.glyph == "note.text", "one shape for every state (revision 2026-11-13): color carries the content")
    #expect(!model.unsaved)
  }

  @Test("brak notatki → szary; notatka → `noteInk`")
  func emptyAndPresent() throws {
    var state = try project()
    state.notesPresent[cwd] = false
    let empty = try #require(NoteTabModel.make(cwd: cwd, state: state, notes: notes()))
    #expect(empty.tone == .quiet && empty.tone.pair == PaletteTokens.muted2)
    state.notesPresent[cwd] = true
    let present = try #require(NoteTabModel.make(cwd: cwd, state: state, notes: notes()))
    #expect(present.tone == .note && present.tone.pair == PaletteTokens.noteInk)
    #expect(present.glyph == "note.text" && empty.glyph == "note.text", "the same shape, grey or amber")
  }

  @Test("serwer bez notatek (`notesAvailable == false`) → brak glifu, nic nie sugeruje zapisu")
  func noNotesNoGlyph() throws {
    var state = try project(notes: false)
    state.notesPresent[cwd] = true
    #expect(!state.notesAvailable)
    #expect(NoteTabModel.make(cwd: cwd, state: state, notes: notes()) == nil)
  }

  @Test("niezapisany szkic → ostrzeżenie zostaje (kropka błędu), glif szary do pisania")
  func unsavedKeepsWarning() throws {
    var state = try project()
    state.notesPresent[cwd] = true
    let drafts = NoteDrafts()
    drafts.save(NoteDrafts.Draft(
      cwd: cwd, text: "niezapisane", ancestor: NotesDoc(text: "", updatedAt: 1), savedAt: Date()))
    let model = try #require(NoteTabModel.make(cwd: cwd, state: state, notes: notes(drafts: drafts)))
    #expect(model.unsaved, "znak niezapisanego tekstu stoi")
    #expect(model.tone == .quiet && !model.readable, "stuknięcie: formularz ze szkicem, nie dymek")
    #expect(model.glyph == "note.text", "grey `note.text` under the unsaved dot")
  }
}

@Suite("znak wiersza „w tle”: klepsydra postoju w przydymionej zieleni")
struct BackgroundTaskMarkTests {
  @Test("postój subagenta → klepsydra `runSmoked`; bez kontaktu ze źródłem → `done`")
  func hourglass() {
    let standing = BackgroundTaskMark.make(working: false, frozen: false)
    #expect(standing.hourglass && PaletteTokens.tone(standing.tone) == PaletteTokens.runSmoked)
    let frozen = BackgroundTaskMark.make(working: false, frozen: true)
    #expect(frozen.hourglass && PaletteTokens.tone(frozen.tone) == PaletteTokens.done)
  }

  @Test("praca → kropka `run`; bez kontaktu ze źródłem → kropka `done`")
  func dot() {
    let working = BackgroundTaskMark.make(working: true, frozen: false)
    #expect(!working.hourglass && PaletteTokens.tone(working.tone) == PaletteTokens.run)
    let frozen = BackgroundTaskMark.make(working: true, frozen: true)
    #expect(!frozen.hourglass && PaletteTokens.tone(frozen.tone) == PaletteTokens.done)
  }
}
