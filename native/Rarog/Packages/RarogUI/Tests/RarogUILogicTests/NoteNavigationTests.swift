import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Notatka projektu w nawigacji i wierszach: ⌘J pod arkuszami, formularz notatki trzyma przy zmianie ekranu,
// glif i zdanie nagłówka w drzewie, element paska zakładek i wiersz stanu formularza.

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
@Suite("notatka projektu: ⌘J, arkusz, drzewo, pasek")
struct NoteNavigationTests {
  private let cwd = "/Users/demo/Projects/rarog"

  @Test("⌘J: bez notatek na serwerze milczy; z projektem otwiera formularz, drugie ⌘J go zamyka")
  func commandJ() throws {
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.detail = .session("p1")
    #expect(!navigation.shortcutMenu(try project(notes: false)).canNote)
    let state = try project()
    #expect(navigation.shortcutMenu(state).canNote)
    navigation.toggleNote(state)
    #expect(navigation.noteSheet?.cwd == cwd && navigation.noteSheet?.start == .edit)
    #expect(navigation.accepts(.note), "pod formularzem notatki ⌘J działa")
    #expect(!navigation.accepts(.newSession), "reszta skrótów zmieniających ekran milczy")
    #expect(navigation.shortcutMenu(state).canNote)
    navigation.toggleNote(state)
    #expect(navigation.sheet == nil)
  }

  @Test("⌘J nad innym formularzem milczy; nad oknem staje zamiast niego")
  func commandJUnderSheets() throws {
    let state = try project()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.detail = .session("p1")
    navigation.openSheet(.newSession(NewSessionRequest(cwd: cwd)))
    #expect(!navigation.shortcutMenu(state).canNote)
    navigation.toggleNote(state)
    #expect(navigation.noteSheet == nil, "„Nowa sesja” z wpisanymi danymi zostaje")
    navigation.dropSheet()
    navigation.openDiff(sessionId: "p1", path: nil)
    navigation.toggleNote(state)
    #expect(navigation.noteSheet?.cwd == cwd, "okno ustępuje formularzowi")
  }

  @Test("⌘J przy dymku notatki z drzewa otwiera formularz TEJ notatki, nie projektu z ekranu; bez ekranu też")
  func commandJFromBubble() throws {
    let state = try project()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.noteBubble = "/Users/demo/Projects/inny"
    #expect(navigation.shortcutMenu(state).canNote, "bez projektu na ekranie: dymek wystarcza")
    navigation.detail = .session("p1")
    navigation.toggleNote(state)
    #expect(navigation.noteSheet?.cwd == "/Users/demo/Projects/inny" && navigation.noteBubble == nil)
  }

  @Test("formularz notatki trzyma przy zmianie ekranu; ⌘J zamyka TĘ prezentację, także nad innym projektem")
  func formHoldsAcrossScreens() throws {
    let state = try project()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.detail = .session("p1")
    navigation.openNote(cwd: cwd + "/")
    #expect(AppSheet.note(NoteRequest(cwd: cwd)).isForm)
    let request = try #require(navigation.noteSheet)
    #expect(request.cwd == cwd, "katalog znormalizowany")
    navigation.detail = .project("/Users/demo/Projects/inny")
    #expect(navigation.noteSheet == request, "zmiana ekranu z zewnątrz nie zamyka formularza")
    navigation.toggleNote(state)
    #expect(navigation.sheet == nil)
  }

  @Test("drzewo: glif i „ma notatkę projektu” w zdaniu nagłówka tylko przy notatce i tylko z notatkami na serwerze")
  func treeRow() throws {
    var state = try project()
    #expect(state.projectRows(openCwd: nil, jumpCwd: nil).first { $0.cwd == cwd }?.hasNote == false)
    state.notesPresent[cwd] = true
    let row = try #require(state.projectRows(openCwd: nil, jumpCwd: nil).first { $0.cwd == cwd })
    #expect(row.hasNote && row.spoken.hasSuffix(", ma notatkę projektu"))
    state.capabilities = Capabilities(try JSONDecoder().decode(
      VersionInfo.self, from: Data(#"{"version":"1","protocolVersion":3,"serverStartId":"s"}"#.utf8)))
    #expect(state.projectRows(openCwd: nil, jumpCwd: nil).first { $0.cwd == cwd }?.hasNote == false)
  }

  @Test("pasek: bez notatek na serwerze nic; treść = do czytania; niezapisany szkic = do pisania ze znakiem")
  func tabModel() async throws {
    var state = try project()
    let notes = ProjectNotes(io: NoteIO(fetch: { _ in .loaded(.empty) }, save: { _, _, _ in .saved(1) }))
    #expect(NoteTabModel.make(cwd: cwd, state: try project(notes: false), notes: notes) == nil)
    #expect(NoteTabModel.make(cwd: cwd, state: state, notes: notes)?.readable == false, "nie wiadomo = do pisania")
    state.notesPresent[cwd] = true
    let model = try #require(NoteTabModel.make(cwd: cwd, state: state, notes: notes))
    #expect(model.readable && model.glyph == "note.text" && model.spokenValue == "jest treść")
    let drafts = NoteDrafts()
    drafts.save(NoteDrafts.Draft(
      cwd: cwd, text: "niezapisane", ancestor: NotesDoc(text: "", updatedAt: 1), savedAt: Date()))
    let restored = ProjectNotes(io: NoteIO(fetch: { _ in .loaded(.empty) }, save: { _, _, _ in .saved(1) }), drafts: drafts)
    let unsaved = try #require(NoteTabModel.make(cwd: cwd, state: state, notes: restored))
    #expect(!unsaved.readable && unsaved.unsaved && unsaved.glyph == "note.text")
    #expect(unsaved.spokenValue == "nie zapisana na tym urządzeniu")
  }

  @Test("wiersz stanu: czas zapisu, pusta przed skasowaniem, konflikt, bez sieci, szkic z dysku, licznik od 90 %")
  func statusLine() async throws {
    let now = Date(timeIntervalSince1970: 1_792_006_800)
    let version = 1_792_006_800_000.0
    let drafts = NoteDrafts()
    drafts.save(NoteDrafts.Draft(
      cwd: cwd, text: "dopisek", ancestor: NotesDoc(text: "start", updatedAt: version),
      savedAt: Date(timeIntervalSince1970: 1_792_000_000)))
    let notes = ProjectNotes(
      io: NoteIO(fetch: { _ in .failed(.offline) }, save: { _, _, _ in .failed(.offline) }), drafts: drafts)
    let doc = try #require(notes.existing(cwd))
    #expect(doc.statusLine(now: now, machine: .mac)?.action == .retry, "szkic z dysku: „nie zapisano (…)” i ponowienie")
    #expect(doc.statusLine(now: now, machine: .mac)?.text.hasPrefix("nie zapisano (") == true)
    doc.edit("")
    #expect(doc.statusLine(now: now, machine: .mac) == NoteStatusLine("pusta — zamknięcie usunie notatkę", action: .restore))
    doc.restore()
    #expect(doc.text == "start")
    #expect(UICopy.noteSavedAt(version, now: now).hasPrefix("zapisano "))
    #expect(UICopy.noteTime(version - 86_400_000, now: now).hasPrefix("wczoraj "))
    #expect(UICopy.noteCounter(45_120) == "45\u{00A0}120 / 49\u{00A0}152")
    doc.edit(String(repeating: "x", count: NotesRules.maxUnits))
    #expect(doc.counter?.full == true)
  }
}
