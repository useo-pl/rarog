import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Prawy panel na telefonie jako arkusz: kiedy linia statusu i pigułka „w tle” go
// otwierają, z jaką kotwicą, i że nic nie otwiera go samo. iPad zostaje przy dymku gita i stojącym panelu.

/// Sesja Claude `s1` (repo na gałęzi `main`), Claude bez repozytorium `nr`, wpis Codexa `cx`.
@MainActor
private func sheetState() -> AppState {
  var state = Sample.state(session: Sample.session(id: "s1", title: "rarog", extra: #""branch":"main""#))
  state.sessions["nr"] = Sample.session(id: "nr", title: "rarog")
  state.sessions["cx"] = Sample.session(id: "cx", title: "rarog", extra: #""engine":"codex","branch":"main""#)
  return state
}

/// Telefon na sesji `id`: panel obok nie wchodzi w grę (`eligible == false`).
@MainActor
private func phone(on id: String = "s1") -> RarogNavigation {
  let navigation = RarogNavigation(prefs: MemoryPreferences())
  navigation.detail = .session(id)
  navigation.inspector.noteLayout(columnWidth: 390, eligible: false)
  return navigation
}

/// iPad na sesji `s1` z miejscem na panel.
@MainActor
private func pad() -> RarogNavigation {
  let navigation = RarogNavigation(prefs: MemoryPreferences())
  navigation.detail = .session("s1")
  navigation.inspector.noteLayout(columnWidth: 1056, eligible: true)
  return navigation
}

@MainActor
@Suite("prawy panel na telefonie: wejścia i kotwice")
struct InspectorSheetEntryTests {
  @Test("telefon: linia gita bez pigułki „w tle” otwiera arkusz na GÓRZE panelu")
  func phoneGitWithRepo() throws {
    let state = sheetState()
    let session = try #require(state.sessions["s1"])
    let tap = phone().gitLineTap(state, session: session, isRepo: true, phone: true)
    #expect(tap == .panelSheet(anchor: InspectorModel.backgroundAnchor), "linia to jedyne wejście: góra, nie dno")
    #expect(tap.opensSheet, "podpowiedź czytnika mówi o panelu, nie o commicie")
    #expect(!GitLineTap.gitPopover.opensSheet && !GitLineTap.scrollPanel.opensSheet && !GitLineTap.none.opensSheet)
  }

  @Test("telefon: przy pigułce „w tle” (ona prowadzi na górę) linia gita otwiera arkusz na ZMIANACH W KATALOGU")
  func phoneGitBesidePill() throws {
    var state = sheetState()
    state.sessions["bg"] = Sample.session(
      id: "bg", title: "rarog", extra: #""branch":"main","backgroundTasks":[{"id":"t","kind":"command"}]"#)
    let session = try #require(state.sessions["bg"])
    let navigation = phone(on: "bg")
    #expect(navigation.gitLineTap(state, session: session, isRepo: true, phone: true)
      == .panelSheet(anchor: InspectorModel.changesAnchor))
    #expect(navigation.gitLineTap(state, session: session, isRepo: false, phone: true)
      == .panelSheet(anchor: InspectorModel.backgroundAnchor), "bez repo zmian nie ma: góra")
  }

  @Test("telefon: linia bez rozwinięcia gita (sam kontekst, brak repo) też jest przyciskiem — kotwica na górze panelu")
  func phoneLineWithoutGit() throws {
    let state = sheetState()
    let session = try #require(state.sessions["nr"])
    let tap = phone(on: "nr").gitLineTap(state, session: session, isRepo: false, phone: true)
    #expect(tap == .panelSheet(anchor: InspectorModel.backgroundAnchor))
  }

  @Test("telefon: dymka gita nie ma nigdy — Codex i agent w terminalu Raroga mają linię bez przycisku")
  func phoneNeverGitPopover() throws {
    let state = sheetState()
    let codex = try #require(state.sessions["cx"])
    #expect(phone(on: "cx").gitLineTap(state, session: codex, isRepo: true, phone: true) == .none)
    let terminal = phone()
    terminal.detail = .terminal("0123456789abcdef")
    let session = try #require(state.sessions["s1"])
    #expect(terminal.gitLineTap(state, session: session, isRepo: true, phone: true) == .none)
  }

  @Test("iPad bez zmian: dymek gita, przy stojącym panelu przewinięcie do zmian, bez repo linia nie jest przyciskiem")
  func padUnchanged() throws {
    let state = sheetState()
    let session = try #require(state.sessions["s1"])
    let navigation = pad()
    #expect(navigation.gitLineTap(state, session: session, isRepo: true, phone: false) == .gitPopover)
    #expect(navigation.gitLineTap(state, session: session, isRepo: false, phone: false) == .none)
    navigation.toggleInspector(state)
    #expect(navigation.inspectorVisible(state))
    #expect(navigation.gitLineTap(state, session: session, isRepo: true, phone: false) == .scrollPanel)
    // Wąskie okno iPada to nie telefon: dalej dymek, nie arkusz panelu.
    let narrow = phone()
    #expect(narrow.gitLineTap(state, session: session, isRepo: true, phone: false) == .gitPopover)
  }

  @Test("pigułka „w tle”: na telefonie arkusz panelu na górze, na iPadzie i przy Codexie dymek jak dotąd")
  func backgroundPill() {
    let state = sheetState()
    #expect(phone().backgroundPillTap(state, sessionId: "s1", phone: true) == .panelSheet(anchor: InspectorModel.backgroundAnchor))
    #expect(pad().backgroundPillTap(state, sessionId: "s1", phone: false) == .popover)
    #expect(phone(on: "cx").backgroundPillTap(state, sessionId: "cx", phone: true) == .popover)
  }
}

@MainActor
@Suite("prawy panel na telefonie: otwarcie, kotwica sesji i zamknięcie")
struct InspectorSheetStateTests {
  @Test("nic nie otwiera arkusza samo: świeża nawigacja i powrót do sesji go nie mają")
  func neverOpensByItself() {
    let state = sheetState()
    let navigation = phone()
    #expect(navigation.inspectorSheetSession(state) == nil)
    navigation.inspector.anchors["s1"] = InspectorModel.changesAnchor
    #expect(navigation.inspectorSheetSession(state) == nil, "sama kotwica nie stawia arkusza")
  }

  @Test("otwarcie stawia kotwicę TEJ sesji i arkusz przy niej; inna sesja zachowuje swoją kotwicę")
  func openSetsAnchor() {
    let state = sheetState()
    let navigation = phone()
    navigation.inspector.anchors["nr"] = InspectorModel.finishedAnchor
    navigation.openInspectorSheet(sessionId: "s1", anchor: InspectorModel.changesAnchor)
    #expect(navigation.inspectorSheetSession(state) == "s1")
    #expect(navigation.inspector.anchors["s1"] == InspectorModel.changesAnchor)
    #expect(navigation.inspector.anchors["nr"] == InspectorModel.finishedAnchor)
    navigation.closeInspectorSheet()
    #expect(navigation.inspectorSheetSession(state) == nil)
    #expect(navigation.inspector.anchors["s1"] == InspectorModel.changesAnchor, "kotwica zostaje na następne otwarcie")
  }

  @Test("zmiana sesji zamyka arkusz jak każde okno apki, a powrót do sesji go nie wskrzesza")
  func sessionChangeCloses() {
    let state = sheetState()
    let navigation = phone()
    navigation.openInspectorSheet(sessionId: "s1", anchor: InspectorModel.backgroundAnchor)
    navigation.detail = .session("nr")
    #expect(navigation.inspectorSheetSession(state) == nil)
    navigation.detail = .session("s1")
    #expect(navigation.inspectorSheetSession(state) == nil)
    navigation.openInspectorSheet(sessionId: "s1", anchor: InspectorModel.backgroundAnchor)
    navigation.detail = nil
    navigation.detail = .session("s1")
    #expect(navigation.inspectorSheetSession(state) == nil, "powrót do listy w stosie też zamyka")
  }

  @Test("wylogowanie zdejmuje arkusz: po ponownym zalogowaniu na tej samej sesji nie wraca sam")
  func logoutDrops() {
    let state = sheetState()
    let navigation = phone()
    navigation.openInspectorSheet(sessionId: "s1", anchor: InspectorModel.changesAnchor)
    navigation.dropSheet()
    #expect(navigation.detail == .session("s1"), "nawigacja przeżywa wylogowanie")
    #expect(navigation.inspectorSheetSession(state) == nil)
  }

  @Test("arkusz cudzej sesji nie stoi: prośba o sesję, której nie ma na ekranie, nic nie pokazuje")
  func onlyForScreenSession() {
    let state = sheetState()
    let navigation = phone()
    navigation.openInspectorSheet(sessionId: "nr", anchor: InspectorModel.backgroundAnchor)
    #expect(navigation.inspectorSheetSession(state) == nil)
  }
}

@MainActor
@Suite("przycisk panelu w nagłówku: telefon otwiera arkusz, iPad bez zmian")
struct InspectorHeaderButtonTests {
  @Test("telefon: przycisk stoi przy sesji z panelem; Codex i brak sesji — bez przycisku")
  func phoneShown() {
    let state = sheetState()
    #expect(phone().inspectorButtonShown(state, phone: true))
    #expect(!phone(on: "cx").inspectorButtonShown(state, phone: true), "Codex nie ma panelu")
    let none = phone()
    none.detail = nil
    #expect(!none.inspectorButtonShown(state, phone: true))
  }

  @Test("telefon: tap otwiera arkusz na górze panelu i jest zaznaczony, drugi tap zamyka; kotwica zostaje")
  func phoneToggle() {
    let state = sheetState()
    let navigation = phone()
    navigation.inspector.anchors["s1"] = InspectorModel.changesAnchor
    #expect(!navigation.inspectorButtonSelected(state, phone: true))
    navigation.toggleInspectorSheet(state)
    #expect(navigation.inspectorSheetSession(state) == "s1")
    #expect(navigation.inspector.anchors["s1"] == InspectorModel.backgroundAnchor, "przycisk otwiera na górze")
    #expect(navigation.inspectorButtonSelected(state, phone: true))
    #expect(!navigation.inspector.open, "preferencja stojącego panelu iPada bez zmian")
    navigation.toggleInspectorSheet(state)
    #expect(navigation.inspectorSheetSession(state) == nil)
    #expect(!navigation.inspectorButtonSelected(state, phone: true))
  }

  @Test("telefon: tap przy Codexie nic nie otwiera")
  func phoneCodexNoop() {
    let state = sheetState()
    let navigation = phone(on: "cx")
    navigation.toggleInspectorSheet(state)
    #expect(navigation.inspector.sheet == nil)
  }

  @Test("iPad bez zmian: przycisk tam, gdzie panel się mieści, zaznaczony przy stojącym panelu; wąskie okno — bez")
  func padUnchanged() {
    let state = sheetState()
    let navigation = pad()
    #expect(navigation.inspectorButtonShown(state, phone: false))
    #expect(!navigation.inspectorButtonSelected(state, phone: false))
    navigation.toggleInspector(state)
    #expect(navigation.inspectorButtonSelected(state, phone: false))
    let narrow = phone()
    #expect(!narrow.inspectorButtonShown(state, phone: false), "wąskie okno iPada zostaje bez przycisku")
  }
}
