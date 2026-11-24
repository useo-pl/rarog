import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Prawy panel sesji na iPadzie: widoczność z histerezą, preferencja ruszana
// wyłącznie ręką, skrót Cmd+I, pigułka „w tle" przy widocznym panelu i dane sekcji SKOŃCZONE OSTATNIO i stan zmian
// sekcji PLIKI.

/// Sesja Claude `s1`, wpis Codexa bez terminala `cx` i wpis Codexa w terminalu Raroga `ct`.
@MainActor
private func inspectorState() -> AppState {
  var state = Sample.state(session: Sample.session(id: "s1", title: "rarog"))
  state.sessions["cx"] = Sample.session(id: "cx", title: "rarog", extra: #""engine":"codex""#)
  state.sessions["ct"] = Sample.session(id: "ct", title: "rarog", extra: #""engine":"codex","termId":"0123456789abcdef""#)
  return state
}

/// Nawigacja na sesji `s1`, z miejscem na panel (kolumna 1056 pt — 13" poziomo z listą).
@MainActor
private func roomy(_ prefs: MemoryPreferences = MemoryPreferences()) -> RarogNavigation {
  let navigation = RarogNavigation(prefs: prefs)
  navigation.detail = .session("s1")
  navigation.inspector.noteLayout(columnWidth: 1056, eligible: true)
  return navigation
}

@Suite("prawy panel: próg otwarcia i histereza stojącego panelu")
struct InspectorRoomTests {
  @Test("niestojący staje od 920 pt, stojący trzyma się do 880 pt; telefon i wąskie okno nigdy")
  func thresholds() {
    #expect(!InspectorModel.fits(columnWidth: 919, eligible: true, standing: false))
    #expect(InspectorModel.fits(columnWidth: 920, eligible: true, standing: false))
    #expect(!InspectorModel.fits(columnWidth: 900, eligible: true, standing: false), "zamknięty przy 900 pt nie staje")
    #expect(InspectorModel.fits(columnWidth: 880, eligible: true, standing: true), "stojący w paśmie zostaje")
    #expect(!InspectorModel.fits(columnWidth: 879, eligible: true, standing: true))
    #expect(!InspectorModel.fits(columnWidth: 2000, eligible: false, standing: true), "telefon, Split View")
  }

  @Test("macierz z planu: 13\" poziomo ✓, z listą 520 pt ✗, pionowo ✗ (po Cmd+B ✓), 11\" poziomo ✗ (po Cmd+B ✓)")
  @MainActor
  func matrix() {
    for (width, expected) in [(1056.0, true), (856, false), (712, false), (1032, true), (890, false), (1210, true)] {
      let inspector = RarogInspector(prefs: MemoryPreferences())
      inspector.noteLayout(columnWidth: width, eligible: true)
      #expect(inspector.canOpen == expected, "\(width) pt")
    }
  }

  @Test("stojący panel: 1056 → 900 zostaje, → 870 chowa się, z powrotem w paśmie nie staje, od 920 staje sam")
  @MainActor
  func standingFollowsLayout() {
    let inspector = RarogInspector(prefs: MemoryPreferences())
    inspector.noteLayout(columnWidth: 1056, eligible: true)
    #expect(!inspector.standing, "zamknięty nie stoi")
    inspector.setOpen(true)
    #expect(inspector.standing)
    inspector.noteLayout(columnWidth: 900, eligible: true)
    #expect(inspector.standing, "lista poszerzona o kilka punktów: panel stoi")
    inspector.noteLayout(columnWidth: 870, eligible: true)
    #expect(!inspector.standing, "poniżej 880 pt: panel się chowa")
    inspector.noteLayout(columnWidth: 900, eligible: true)
    #expect(!inspector.standing, "powrót w paśmie nie stawia panelu")
    inspector.noteLayout(columnWidth: 1056, eligible: true)
    #expect(inspector.standing, "od 920 pt otwarty panel wraca sam")
    inspector.noteLayout(columnWidth: 1056, eligible: false)
    #expect(!inspector.standing, "wąskie okno")
  }
}

@MainActor
@Suite("prawy panel: preferencja, przycisk i Cmd+I")
struct InspectorToggleTests {
  @Test("domyślnie zamknięty; jedno przełączenie = jedna zmiana; preferencja przeżywa zmianę sesji i restart")
  func toggleAndMemory() {
    let prefs = MemoryPreferences()
    let state = inspectorState()
    let navigation = roomy(prefs)
    #expect(!navigation.inspector.open, "panel nigdy nie pojawia się sam")
    #expect(navigation.inspectorAvailable(state) && !navigation.inspectorVisible(state))
    #expect(navigation.toggleInspector(state) == .opened)
    #expect(navigation.inspectorVisible(state))
    #expect(prefs.bool(forKey: NavigationPreferences.inspectorOpen))
    navigation.detail = .project("/Users/demo/Projects/rarog")
    #expect(!navigation.inspectorVisible(state), "ekran projektu bez panelu")
    navigation.detail = .session("s1")
    #expect(navigation.inspectorVisible(state), "powrót do sesji: preferencja stoi")

    let restarted = RarogNavigation(prefs: prefs)
    restarted.detail = .session("s1")
    #expect(restarted.inspector.open, "preferencja po ponownym uruchomieniu")
    #expect(!restarted.inspectorVisible(state), "do pierwszego pomiaru kolumny panelu nie ma")
    restarted.inspector.noteLayout(columnWidth: 1056, eligible: true)
    #expect(restarted.inspectorVisible(state))
    #expect(restarted.toggleInspector(state) == .closed)
    #expect(!restarted.inspector.open && !prefs.bool(forKey: NavigationPreferences.inspectorOpen))
  }

  @Test("drzewo zmian: zwinięte ręką zostaje zwinięte po zmianie sesji i restarcie, rozwinięte — rozwinięte")
  func changesCollapseIsDevicePreference() {
    let prefs = MemoryPreferences()
    let navigation = roomy(prefs)
    #expect(!navigation.inspector.changesCollapsed, "drzewo startuje rozwinięte")
    navigation.inspector.setChangesCollapsed(true)
    #expect(prefs.bool(forKey: NavigationPreferences.inspectorChangesCollapsed))
    navigation.detail = .session("s2")
    #expect(navigation.inspector.changesCollapsed, "jedna flaga urządzenia, nie sesji")

    let restarted = RarogNavigation(prefs: prefs)
    #expect(restarted.inspector.changesCollapsed, "zwinięte po ponownym uruchomieniu")
    restarted.inspector.setChangesCollapsed(false)
    #expect(!prefs.bool(forKey: NavigationPreferences.inspectorChangesCollapsed))
    #expect(!RarogNavigation(prefs: prefs).inspector.changesCollapsed, "rozwinięte też się pamięta")
    #expect(!restarted.inspector.open, "zwinięcie drzewa nie otwiera ani nie zamyka panelu")
  }

  @Test("the Files mode and the regex button are device preferences; an unknown stored mode reads as Files")
  func filesModeAndRegexAreDevicePreferences() {
    let prefs = MemoryPreferences()
    let navigation = roomy(prefs)
    #expect(navigation.inspector.filesMode == .all && !navigation.inspector.searchRegex, "Files, plain text")
    navigation.inspector.setFilesMode(.changed)
    navigation.inspector.setSearchRegex(true)
    navigation.detail = .session("s2")
    #expect(navigation.inspector.filesMode == .changed, "one choice for the device, not per session")

    let restarted = RarogNavigation(prefs: prefs)
    #expect(restarted.inspector.filesMode == .changed && restarted.inspector.searchRegex, "both kept after a relaunch")
    restarted.inspector.setFilesMode(.all)
    restarted.inspector.setSearchRegex(false)
    #expect(RarogNavigation(prefs: prefs).inspector.filesMode == .all)
    #expect(!RarogNavigation(prefs: prefs).inspector.searchRegex)

    prefs.set("tree", forKey: InspectorFilesPreferences.mode)
    #expect(RarogNavigation(prefs: prefs).inspector.filesMode == .all)
    prefs.set(7, forKey: InspectorFilesPreferences.mode)
    #expect(RarogNavigation(prefs: prefs).inspector.filesMode == .all)
  }

  @Test("the search text lives in memory per session; clearing it drops the folds of its result")
  func searchTextPerSession() throws {
    let prefs = MemoryPreferences()
    let inspector = roomy(prefs).inspector
    inspector.setSearchText("main", for: "s1")
    #expect(inspector.searchText(for: "s1") == "main")
    #expect(inspector.searchText(for: "s2").isEmpty, "another session has its own field")
    let src = FileTreeDirectoryRow(
      path: "src", name: "src", depth: 0, expanded: true, changes: 0, added: nil, deleted: nil, virtual: false,
      ignored: false, loading: false)
    inspector.toggleResultFold(src, in: "s1")
    #expect(inspector.resultFolds(for: "s1") == ["src"])
    inspector.setSearchText("main.ts", for: "s1")
    #expect(inspector.resultFolds(for: "s1") == ["src"], "typing on keeps the folds")
    inspector.setSearchText("  ", for: "s1")
    #expect(inspector.resultFolds(for: "s1").isEmpty, "the fold goes with the query")
    #expect(RarogNavigation(prefs: prefs).inspector.searchText(for: "s1").isEmpty, "the text is not saved")
  }

  @Test("a fold made in Changed Only hides no hit: a query that starts and a mode change drop it")
  func changedOnlyFoldsDoNotReachTheResult() throws {
    let inspector = roomy(MemoryPreferences()).inspector
    let src = FileTreeDirectoryRow(
      path: "src", name: "src", depth: 0, expanded: true, changes: 1, added: nil, deleted: nil, virtual: false,
      ignored: false, loading: false)
    inspector.setFilesMode(.changed)
    inspector.toggleResultFold(src, in: "s1")
    inspector.setSearchText("notes", for: "s1")
    #expect(inspector.resultFolds(for: "s1").isEmpty, "the query starts with every directory open")
    inspector.setSearchText("", for: "s1")
    inspector.toggleResultFold(src, in: "s1")
    inspector.setFilesMode(.all)
    #expect(inspector.resultFolds(for: "s1").isEmpty, "Files does not keep Changed Only's folds")
  }

  @Test("za wąska kolumna: Cmd+I mówi „nie mieści się” i NIE rusza preferencji — otwarty panel wraca sam")
  func noRoomKeepsPreference() {
    let state = inspectorState()
    let navigation = roomy()
    navigation.toggleInspector(state)
    navigation.inspector.noteLayout(columnWidth: 712, eligible: true)
    #expect(!navigation.inspectorVisible(state) && !navigation.inspectorAvailable(state))
    #expect(navigation.toggleInspector(state) == .noRoom)
    #expect(navigation.inspector.open, "preferencja stoi")
    navigation.inspector.noteLayout(columnWidth: 1032, eligible: true)
    #expect(navigation.inspectorVisible(state), "po Cmd+B panel wraca bez ręki")

    let closed = roomy()
    closed.inspector.noteLayout(columnWidth: 712, eligible: true)
    #expect(closed.toggleInspector(state) == .noRoom)
    #expect(!closed.inspector.open, "za wąsko: nie otwiera się zapisem na później")
  }

  /// Regresja: histereza zostawiała „miejsce” zamkniętemu panelowi, a Cmd+I otwierał go przy 900 pt
  /// (580 pt dla transkryptu), choć otwarcie wymaga 920 pt.
  @Test("zamknięty 1056 → 900: Cmd+I = brak miejsca bez zapisu; zamknięcie przy 900 i ponowne Cmd+I — to samo")
  func openingNeedsFullThreshold() {
    let prefs = MemoryPreferences()
    let state = inspectorState()
    let navigation = roomy(prefs)
    navigation.inspector.noteLayout(columnWidth: 900, eligible: true)
    #expect(!navigation.inspectorAvailable(state), "bez przycisku")
    #expect(navigation.toggleInspector(state) == .noRoom)
    #expect(!navigation.inspector.open && !prefs.bool(forKey: NavigationPreferences.inspectorOpen))

    navigation.inspector.noteLayout(columnWidth: 1056, eligible: true)
    #expect(navigation.toggleInspector(state) == .opened)
    navigation.inspector.noteLayout(columnWidth: 900, eligible: true)
    #expect(navigation.inspectorVisible(state), "stojący w paśmie zostaje")
    #expect(navigation.inspectorAvailable(state), "przycisk zamyka stojący panel")
    #expect(navigation.toggleInspector(state) == .closed)
    #expect(!navigation.inspectorAvailable(state), "zamknięcie przy 900 pt nie zostawia miejsca")
    #expect(navigation.toggleInspector(state) == .noRoom)
    #expect(!navigation.inspector.open && !prefs.bool(forKey: NavigationPreferences.inspectorOpen))
  }

  @Test("stojący panel nie zależy od trasy: terminal i powrót do sesji przy 900 pt — panel dalej stoi")
  func standingSurvivesRoute() {
    let state = inspectorState()
    let navigation = roomy()
    navigation.toggleInspector(state)
    navigation.inspector.noteLayout(columnWidth: 900, eligible: true)
    navigation.detail = .terminal("0123456789abcdef")
    #expect(!navigation.inspectorVisible(state))
    navigation.detail = .session("s1")
    #expect(navigation.inspectorVisible(state))
  }

  @Test("panel tylko przy sesji Claude: terminal, Codex, projekt i telefon — skrót milczy")
  func onlyClaudeSession() {
    let state = inspectorState()
    let navigation = roomy()
    #expect(navigation.inspectorSession(state) == "s1")
    for detail in [
      RarogNavigation.Detail.session("cx"), .session("ct"), .project("/Users/demo/Projects/rarog"),
      .terminal("0123456789abcdef"), .session("nieznana"),
    ] {
      navigation.detail = detail
      #expect(navigation.inspectorSession(state) == nil, "\(detail)")
      #expect(navigation.toggleInspector(state) == .unavailable, "\(detail)")
    }
    #expect(!navigation.inspector.open)
    let phone = RarogNavigation(prefs: MemoryPreferences())
    phone.detail = .session("s1")
    phone.inspector.noteLayout(columnWidth: 1200, eligible: false)
    #expect(phone.toggleInspector(state) == .unavailable, "telefon: bez dymka o szerokości")
  }

  @Test("menu skrótów: Cmd+I aktywne przy sesji Claude na iPadzie, tytuł mówi, co zrobi")
  func shortcutMenu() {
    let state = inspectorState()
    let navigation = roomy()
    var menu = navigation.shortcutMenu(state)
    #expect(menu.canToggleInspector && !menu.inspectorVisible)
    navigation.toggleInspector(state)
    menu = navigation.shortcutMenu(state)
    #expect(menu.inspectorVisible)
    navigation.inspector.noteLayout(columnWidth: 712, eligible: true)
    #expect(navigation.shortcutMenu(state).canToggleInspector, "za wąsko: naciśnięcie mówi dlaczego")
    navigation.detail = .session("cx")
    #expect(!navigation.shortcutMenu(state).canToggleInspector)
  }

  @Test("pigułka „w tle” znika przy widocznym panelu, a linia statusu bez innych powodów razem z nią")
  func pillHidesBesidePanel() {
    let session = Sample.session(extra: #""backgroundTasks":[{"id":"a","kind":"command","command":"x"}]"#)
    #expect(StatusPills.visible(session))
    #expect(!StatusPills.visible(session, backgroundInPanel: true))
    #expect(StatusPills.background(session, inPanel: false) && !StatusPills.background(session, inPanel: true))
    #expect(StatusLine.isShown(session, fresh: nil))
    #expect(!StatusLine.isShown(session, fresh: nil, backgroundInPanel: true))
    let update = Sample.session(extra: #""cliUpdate":{"running":"2.1.290","installed":"2.1.292"}"#)
    #expect(StatusPills.visible(update, backgroundInPanel: true), "pigułka nowszego CLI zostaje")
  }
}

@Suite("prawy panel: SKOŃCZONE OSTATNIO")
struct FinishedTasksTests {
  private func notice(_ seq: Int, _ json: String, at: String) -> TranscriptMessage {
    Sample.decode(TranscriptMessage.self, #"""
      {"seq":\#(seq),"role":"user","blocks":\#(Sample.text("wpis harnessu")),"at":"\#(at)","notice":\#(json)}
      """#)
  }

  @Test("recent ends up to three in the panel and the popover, newest first; a monitor event and an orphan do not count")
  func lastThree() {
    let utc = TimeZone(identifier: "UTC")!
    let messages = [
      notice(1, #"{"kind":"command","outcome":"done","name":"stare"}"#, at: "2026-10-09T10:00:00Z"),
      notice(2, #"{"kind":"agent","outcome":"done","name":"Burza: adwokat diabła"}"#, at: "2026-10-09T10:05:00Z"),
      Sample.message(seq: 3, role: "assistant", blocks: Sample.text("Odpowiedź.")),
      notice(4, #"{"kind":"monitor-event","name":"zdarzenie"}"#, at: "2026-10-09T10:06:00Z"),
      notice(5, #"{"kind":"command","outcome":"failed","name":"pnpm test","exitCode":1}"#, at: "2026-10-09T10:07:00Z"),
      notice(6, #"{"kind":"orphan"}"#, at: "2026-10-09T10:08:00Z"),
      notice(7, #"{"kind":"workflow","name":"Przegląd"}"#, at: "2026-10-09T10:09:00Z"),
    ]
    let rows = FinishedTasks.rows(messages, timeZone: utc)
    #expect(rows.map(\.id) == ["m7", "m5", "m2"], "four ends: the oldest one drops")
    #expect(rows.map(\.kind) == ["workflow", "komenda", "subagent"])
    #expect(rows.map(\.title) == ["Przegląd", "pnpm test", "Burza: adwokat diabła"], "wiersz niesie nazwę, rodzaju nie podpisuje")
    #expect(rows[0].outcome == nil, "brak wyniku nie znaczy sukcesu")
    #expect(rows[1].clock == "10:07")
    // Dopisek pod nazwą: kod przy niepowodzeniu, słowo przy nieznanym wyniku, sukces bez dopisku.
    #expect(rows.map(\.note) == ["wynik nieznany", "kod 1", nil])
    #expect(rows.map(\.failed) == [false, true, false])
    #expect(UICopy.finishedTaskNote(outcome: .halted, exitCode: nil) == "zatrzymane")
    #expect(UICopy.finishedTaskNote(outcome: .failed, exitCode: nil) == nil, "niepowodzenie bez kodu niesie sam znak ✗")
    // Dwa czasy: ile temu (liczone od chwili rysowania) i godzina.
    let now = ServerTime.parse("2026-10-09T12:10:00Z")!
    #expect(rows.map { $0.ago(now: now) } == ["2\u{00A0}h\u{00A0}temu", "2\u{00A0}h\u{00A0}temu", "2\u{00A0}h\u{00A0}temu"])
    #expect(rows[0].ago(now: ServerTime.parse("2026-10-09T10:13:00Z")!) == "4\u{00A0}min\u{00A0}temu")
    #expect(rows[1].spoken(now: now) == "komenda pnpm test, nie powiodło się, kod 1, 2 godziny temu, o 10:07")
    #expect(rows[0].spoken(now: now) == "workflow Przegląd, wynik nieznany, 2 godziny temu, o 10:09")
    #expect(FinishedTasks.rows([], timeZone: utc).isEmpty, "brak notek = brak sekcji")
  }

  @Test("notka bez nazwy: pierwszą linią jest rodzaj; czas, który nie jest czasem, nie daje ani godziny, ani „temu”")
  func namelessAndTimeless() {
    let utc = TimeZone(identifier: "UTC")!
    let rows = FinishedTasks.rows(
      [
        notice(1, #"{"kind":"command","outcome":"done"}"#, at: "2026-10-09T10:00:00Z"),
        notice(2, #"{"kind":"agent","outcome":"done","name":""}"#, at: "wczoraj"),
      ], timeZone: utc)
    #expect(rows.map(\.title) == ["subagent", "komenda"])
    #expect(rows[0].at == nil && rows[0].clock == nil && rows[0].ago(now: Sample.now) == nil)
    #expect(rows[0].stamp(now: Sample.now) == nil && rows[0].day == nil)
    #expect(rows[0].spoken(now: Sample.now) == "subagent, skończone")
    #expect(rows[1].clock == "10:00")
  }

  @Test("od doby wzwyż obok „ile temu” stoi dzień zamiast godziny — sama godzina nie mówiła, którego dnia")
  func dayInsteadOfClockFromOneDay() {
    let utc = TimeZone(identifier: "UTC")!
    let rows = FinishedTasks.rows(
      [notice(1, #"{"kind":"command","outcome":"failed","name":"pnpm test","exitCode":1}"#, at: "2026-10-09T10:07:00Z")],
      timeZone: utc)
    let row = rows[0]
    #expect(row.clock == "10:07" && row.day == "9 paź")
    let sameDay = ServerTime.parse("2026-10-10T10:06:59Z")!
    #expect(row.ago(now: sameDay) == "23\u{00A0}h\u{00A0}temu" && row.stamp(now: sameDay) == "10:07")
    #expect(row.spoken(now: sameDay) == "komenda pnpm test, nie powiodło się, kod 1, 23 godziny temu, o 10:07")
    // Granica jest ta sama, od której „ile temu” liczy w dniach.
    let nextDay = ServerTime.parse("2026-10-10T10:07:00Z")!
    #expect(row.ago(now: nextDay) == "1\u{00A0}d\u{00A0}temu" && row.stamp(now: nextDay) == "9 paź")
    let later = ServerTime.parse("2026-10-12T18:00:00Z")!
    #expect(row.ago(now: later) == "3\u{00A0}d\u{00A0}temu" && row.stamp(now: later) == "9 paź")
    #expect(row.spoken(now: later) == "komenda pnpm test, nie powiodło się, kod 1, 3 dni temu, 9 paź")
    #expect(ServerTime.day(ServerTime.parse("2026-12-31T23:30:00Z")!, timeZone: utc) == "31 gru")
  }

  @Test("postój subagenta (`waiting`) nie jest zakończeniem: sekcja go pomija i nie traci przez niego miejsca")
  func waitingIsNotFinished() {
    let utc = TimeZone(identifier: "UTC")!
    let messages = [
      notice(1, #"{"kind":"command","outcome":"done","name":"testy"}"#, at: "2026-10-09T10:00:00Z"),
      notice(2, #"{"kind":"agent","outcome":"waiting","name":"widoki panelu"}"#, at: "2026-10-09T10:01:00Z"),
      notice(3, #"{"kind":"command","outcome":"failed","name":"lint","exitCode":1}"#, at: "2026-10-09T10:02:00Z"),
      notice(4, #"{"kind":"agent","outcome":"waiting","name":"widoki panelu"}"#, at: "2026-10-09T10:03:00Z"),
      notice(5, #"{"kind":"agent","outcome":"done","name":"widoki panelu"}"#, at: "2026-10-09T10:04:00Z"),
      notice(6, #"{"kind":"agent","outcome":"waiting","name":"testy panelu"}"#, at: "2026-10-09T10:05:00Z"),
    ]
    let rows = FinishedTasks.rows(messages, timeZone: utc)
    #expect(rows.map(\.id) == ["m5", "m3", "m1"], "trzy zakończenia mimo trzech postojów między nimi")
    #expect(rows.allSatisfy { $0.outcome != .waiting })
    let now = ServerTime.parse("2026-10-09T10:04:20Z")!
    #expect(
      rows[0].spoken(now: now) == "subagent widoki panelu, skończone, przed chwilą, o 10:04",
      "prawdziwy koniec agenta po postojach zostaje")
    #expect(FinishedTasks.rows([messages[1], messages[5]], timeZone: utc).isEmpty, "same postoje = brak sekcji")
    // Gałąź domykająca `switch` nie mówi „skończone” ani „wynik nieznany”.
    #expect(
      UICopy.finishedTaskSpoken(kind: "subagent", name: "x", outcome: .waiting, exitCode: nil, ago: nil, stamp: "o 10:01")
        == "subagent x, czeka na własne zadanie, o 10:01")
  }

  @Test("koniec obserwacji artefaktu nie jest zakończeniem zadania: sekcja go pomija i nie traci miejsca")
  func artifactWatchIsNotFinished() {
    let utc = TimeZone(identifier: "UTC")!
    let messages = [
      notice(1, #"{"kind":"command","outcome":"done","name":"testy"}"#, at: "2026-10-09T10:00:00Z"),
      notice(2, #"{"kind":"artifact-watch","name":"Raport kwartalny"}"#, at: "2026-10-09T10:01:00Z"),
      notice(3, #"{"kind":"artifact-watch"}"#, at: "2026-10-09T10:02:00Z"),
    ]
    #expect(FinishedTasks.kindWord(.artifactWatch) == nil)
    #expect(FinishedTasks.rows(messages, timeZone: utc).map(\.id) == ["m1"])
    #expect(FinishedTasks.rows(Array(messages.dropFirst()), timeZone: utc).isEmpty, "same meldunki o artefaktach = brak sekcji")
  }
}

@Suite("right panel: the change state of the Files section from the git-status frame")
struct InspectorChangesTests {
  private func git(_ fields: String) -> GitStatusEvent {
    Sample.decode(GitStatusEvent.self, #"{"sessionId":"s1","branch":"main",\#(fields)}"#)
  }

  private let commit = #""lastCommit":{"hash":"7cdfbe4b","subject":"feat: x","at":"2026-10-09T10:00:00Z"}"#

  @Test("pliki z fileDetails: litera, nazwa, liczniki; binarny bez liczników")
  func detailedRows() {
    let fresh = git(#"""
      "dirtyCount":3,"files":["RarogUI/Views/List/SessionListView.swift","ProjectTree.swift","logo.png"],
      "fileDetails":[
        {"path":"RarogUI/Views/List/SessionListView.swift","kind":"modified","linesAdded":42,"linesDeleted":18},
        {"path":"ProjectTree.swift","kind":"added"},
        {"path":"logo.png","kind":"modified","linesAdded":0,"linesDeleted":0,"binary":true}]
      """#)
    let changes = InspectorChanges.make(meta: GitMeta(session: nil, fresh: fresh), fresh: fresh, stale: false)
    guard case let .files(rows) = changes.body else {
      Issue.record("lista plików: \(changes.body)")
      return
    }
    #expect(changes.count == 3)
    #expect(rows.map(\.status) == [.modified, .added, .modified])
    #expect(rows[0].name == "SessionListView.swift")
    #expect(rows[1].name == "ProjectTree.swift" && rows[1].added == nil, "plik nieśledzony: bez zgadywanych zer")
    #expect(rows[2].binary && rows[2].added == nil && rows[2].deleted == nil)
    #expect(rows[2].spoken == "logo.png, zmieniony, plik binarny")
    #expect(rows[0].spoken == "RarogUI/Views/List/SessionListView.swift, zmieniony, 42 dodane linie, 18 usuniętych linii")
  }

  @Test("without fileDetails only the names of files; the count is every change of the frame")
  func namesOnlyAndShown() {
    let files = (1...50).map { "\"f\($0).txt\"" }.joined(separator: ",")
    let fresh = git(#""dirtyCount":73,"files":[\#(files)]"#)
    let changes = InspectorChanges.make(meta: GitMeta(session: nil, fresh: fresh), fresh: fresh, stale: true)
    guard case let .files(rows) = changes.body else {
      Issue.record("lista plików: \(changes.body)")
      return
    }
    #expect(rows.count == 50 && rows.allSatisfy { $0.status == nil && $0.added == nil })
    #expect(changes.stale, "ostatni znany stan przy utracie strumienia")
    #expect(changes.count == 73)
  }

  @Test("trzy stany pustki: czysto od commita, brak danych (nic nie przyszło), czysto bez commita")
  func emptyStates() {
    let clean = Sample.session(extra: #""branch":"main","dirtyCount":0,\#(commit)"#)
    let fromList = InspectorChanges.make(meta: GitMeta(session: clean, fresh: nil), fresh: nil, stale: false)
    #expect(fromList.body == .clean(commit: "7cdfbe4b"))

    let dirty = Sample.session(extra: #""branch":"main","dirtyCount":2"#)
    let waiting = InspectorChanges.make(meta: GitMeta(session: dirty, fresh: nil), fresh: nil, stale: false)
    #expect(waiting.body == .noData, "ramka jeszcze nie przyszła")
    #expect(waiting.count == 2, "the count from the list, no frame yet")

    let unknown = InspectorChanges.make(meta: GitMeta(session: Sample.session(), fresh: nil), fresh: nil, stale: false)
    #expect(unknown.body == .noData && unknown.count == nil)

    let frame = git(#""dirtyCount":0,"files":[]"#)
    let fresh = InspectorChanges.make(meta: GitMeta(session: nil, fresh: frame), fresh: frame, stale: false)
    #expect(fresh.body == .clean(commit: nil))
  }
}

/// Chwilę zamrożenia zapisywał nagłówek W TLE w leniwym stosie panelu, więc po jego
/// przewinięciu poza ekran wiersze agentów tykały dalej mimo utraty strumienia. Zamrożenie to teraz wartość,
/// którą trzyma właściciel poza stosem (popover: `BackgroundClock`, panel: zegar w tle `InspectorPanel`).
@Suite("sekcja „w tle”: zamrożenie zegarów jako wartość właściciela")
struct BackgroundFreezeTests {
  private let t0 = Sample.now

  private func at(_ seconds: TimeInterval) -> Date { t0.addingTimeInterval(seconds) }

  /// Tyk zegara właściciela: reguła w tej chwili i zapis przy zmianie — jak `onChange` w widoku.
  private func tick(_ freeze: inout BackgroundFreeze, _ seconds: TimeInterval, stale: Bool = false) -> Bool {
    let frozen = freeze.isFrozen(sessionStale: stale, listStale: false, now: at(seconds))
    if frozen != (freeze.frozenAt != nil) { freeze.settle(frozen: frozen, now: at(seconds)) }
    return frozen
  }

  @Test("utrata strumienia: zegary stają od początku przerwy przez kolejne próby; powrót wznawia tykanie")
  func lossAndReturn() {
    var freeze = BackgroundFreeze()
    freeze.observe(.online, now: t0)
    #expect(!tick(&freeze, 5))
    #expect(freeze.clock(frozen: false, now: at(5)) == at(5), "żywy strumień: zegar tyka")
    freeze.observe(.offline(since: at(10)), now: at(10))
    #expect(tick(&freeze, 13), "próba padła: sekcja bez kontaktu")
    #expect(freeze.frozenAt == at(10), "zegary stoją od początku przerwy, nie od chwili tyku")
    freeze.observe(.connecting(since: at(14)), now: at(14))
    #expect(tick(&freeze, 20))
    #expect(freeze.clock(frozen: true, now: at(20)) == at(10), "kolejna próba nie rusza zegarów")
    freeze.observe(.online, now: at(30))
    #expect(!tick(&freeze, 31))
    #expect(freeze.frozenAt == nil && freeze.clock(frozen: false, now: at(31)) == at(31), "powrót: tykanie wraca")
  }

  @Test("samo łączenie dopiero po sekundzie; sesja bez kontaktu — od chwili, w której to widać")
  func connectingAndStaleSession() {
    var freeze = BackgroundFreeze()
    freeze.observe(.connecting(since: t0), now: t0)
    #expect(!tick(&freeze, 0.5), "krótkie łączenie nie zamraża")
    #expect(tick(&freeze, 1.5))
    #expect(freeze.frozenAt == t0)

    var stale = BackgroundFreeze()
    stale.observe(.online, now: t0)
    #expect(tick(&stale, 7, stale: true))
    #expect(stale.frozenAt == at(7))
    #expect(!tick(&stale, 9))
    #expect(stale.frozenAt == nil)
  }
}
