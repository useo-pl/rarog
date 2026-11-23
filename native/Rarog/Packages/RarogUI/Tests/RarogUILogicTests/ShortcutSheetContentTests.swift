import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// The shortcut sheet under a held Cmd: what it lists (`ShortcutSheetContent`) and where the focus is
// (`RarogNavigation.shortcutSheetPlace`). Owner: shortcuts.

private typealias Content = ShortcutSheetContent

private let everything = ShortcutSheetCapabilities(notes: true, terminal: true, voiceAgent: true, wideIPad: true)

private func items(_ content: Content) -> [Content.Item] {
  ([content.here].compactMap { $0 } + content.columns.flatMap { $0 }).flatMap { $0.rows.map(\.item) }
}

@Suite("shortcut sheet: content per place, capability and language (ShortcutSheetContent)")
struct ShortcutSheetContentTests {
  /// A new `AppShortcut` without a row would be missing from the sheet; this test fails then.
  @Test("every AppShortcut stands in the sheet when every capability is on")
  func coverage() {
    let content = Content(place: nil, capabilities: everything, language: .en)
    let listed = Set(items(content).flatMap(\.shortcuts))
    let missing = AppShortcut.allCases.filter { !listed.contains($0) }
    #expect(missing.isEmpty, "shortcuts without a row: \(missing)")
  }

  @Test(
    "place → the group under “You're here”; the rest in three columns without it",
    arguments: [
      (ShortcutSheetPlace?.some(.session), ShortcutSheetContent.GroupKind?.some(.messageAndVoice)),
      (.terminal, .terminal), (.window, .windows), (nil, nil),
    ])
  func here(place: ShortcutSheetPlace?, group: ShortcutSheetContent.GroupKind?) {
    let content = Content(place: place, capabilities: everything, language: .en)
    #expect(content.here?.kind == group)
    #expect(content.columns.count == 3)
    #expect(content.columns[0].map(\.kind) == [.sessionsAndProject])
    #expect(content.columns[1].map(\.kind) == [.tabsAndView])
    let rest: [Content.GroupKind] = [.messageAndVoice, .terminal, .windows]
    #expect(content.columns[2].map(\.kind) == rest.filter { $0 != group })
  }

  @Test("the same rows wherever the focus is: the here group moves out of the columns, nothing is lost")
  func placeMovesOnly() {
    let all = Set(items(Content(place: nil, capabilities: everything, language: .en)))
    for place in [ShortcutSheetPlace.session, .terminal, .window] {
      #expect(Set(items(Content(place: place, capabilities: everything, language: .en))) == all)
    }
  }

  @Test("a row without its capability drops; a group without rows drops with its title")
  func capabilityDropsRow() {
    let none = Content(place: .terminal, capabilities: ShortcutSheetCapabilities(), language: .en)
    let listed = Set(items(none))
    for item in [Content.Item.note, .newTerminal, .popupShell, .popupLazygit, .voiceAgent, .toggleList,
                 .toggleInspector, .terminalHistory, .closeTerminal, .copy, .paste] {
      #expect(!listed.contains(item), "\(item) without its capability")
    }
    #expect(none.here == nil, "the terminal group is empty without a terminal")
    #expect(!none.columns.joined().contains { $0.kind == .terminal })
    // Rows that only fall silent for a moment stay.
    for item in [Content.Item.newSession, .nextSession, .closeTab, .send, .stop, .dictation, .closeWindow] {
      #expect(listed.contains(item), "\(item) stays")
    }

    let notesOnly = Set(items(Content(
      place: nil, capabilities: ShortcutSheetCapabilities(notes: true), language: .en)))
    #expect(notesOnly.contains(.note) && !notesOnly.contains(.newTerminal))
    let wide = Set(items(Content(place: nil, capabilities: ShortcutSheetCapabilities(wideIPad: true), language: .en)))
    #expect(wide.contains(.toggleList) && wide.contains(.toggleInspector) && !wide.contains(.voiceAgent))
    let voice = Set(items(Content(place: nil, capabilities: ShortcutSheetCapabilities(voiceAgent: true), language: .en)))
    #expect(voice.contains(.voiceAgent) && !voice.contains(.toggleList))
  }

  @Test("combinations: from AppShortcut, the tab digits and Copy and Paste from the module's table; two joined by “or”")
  func combinations() {
    let content = Content(place: .window, capabilities: everything, language: .en)
    let rows = (content.columns.joined() + [content.here!]).flatMap(\.rows)
    func combos(_ item: Content.Item) -> [String]? { rows.first { $0.item == item }?.combos }
    #expect(combos(.newTerminal) == [AppShortcut.newTerminal.glyphs])
    #expect(combos(.closeWindow) == [AppShortcut.dismissSheet.glyphs, AppShortcut.closeSheet.glyphs])
    #expect(combos(.closeTerminal) == [AppShortcut.closeTab.glyphs])
    #expect(combos(.tabs) == ["⌘1–8"])
    #expect(combos(.lastTab) == ["⌘9"])
    #expect(combos(.copy) == ["⌘C"] && combos(.paste) == ["⌘V"])
    #expect(combos(.textBigger) == ["⌘+"] && combos(.textSmaller) == ["⌘-"] && combos(.textActualSize) == ["⌘0"])
    #expect(rows.allSatisfy { (1...2).contains($0.combos.count) })
    #expect(content.or == "or")
    #expect(Content(place: nil, capabilities: everything, language: .pl).or == "lub")
  }

  @Test("title, hint and one label in English and in Polish")
  func languages() {
    let english = Content(place: .session, capabilities: everything, language: .en)
    let polish = Content(place: .session, capabilities: everything, language: .pl)
    #expect(english.title == "Keyboard Shortcuts")
    #expect(polish.title == "Skróty klawiszowe")
    #expect(english.releaseHint == "Release ⌘ to close")
    #expect(polish.releaseHint == "Puść ⌘, żeby zamknąć")
    #expect(english.hereTitle == "You're here" && polish.hereTitle == "Tu jesteś")
    #expect(english.here?.title == "Message and Voice" && polish.here?.title == "Wiadomość i głos")
    let toggle = Content.Item.toggleList
    func label(_ content: Content) -> String? {
      content.columns.joined().flatMap(\.rows).first { $0.item == toggle }?.label
    }
    #expect(label(english) == "Show or Hide Session List")
    #expect(label(polish) == "Pokaż albo ukryj listę sesji")
    #expect(label(english) == L("shortcutSheet.toggleList", language: .en))
  }

  @Test("every row and group has a label in both languages, and no two rows of one language share it")
  func labelsPresent() {
    for language in [CopyLanguage.en, .pl] {
      let content = Content(place: nil, capabilities: everything, language: language)
      let groups = Array(content.columns.joined())
      #expect(groups.allSatisfy { !$0.title.isEmpty })
      let labels = groups.flatMap(\.rows).map(\.label)
      #expect(labels.allSatisfy { !$0.isEmpty })
      // Close Tab and Close Terminal share ⌘X but not the label.
      #expect(Set(labels).count == labels.count, "\(language): \(labels)")
    }
  }
}

private let willow = "/Users/demo/Projects/willow"
private let termA = "00000000000000a1"

@MainActor
private func state(notes: Bool = false, term: Bool = false, companion: Bool = false) -> AppState {
  var state = AppState(clientBuild: 1)
  let session = Sample.session(id: "s1", title: "willow")
  state.sessions[session.id] = session
  state.sessionsLoaded = true
  state.global = .online
  state.compat = .ok
  let fields = #""notesEnabled":\#(notes),"termEnabled":\#(term),"companionEnabled":\#(companion),"companionSpeech":\#(companion)"#
  state.capabilities = Capabilities(Sample.decode(
    VersionInfo.self, #"{"version":"1","protocolVersion":3,"serverStartId":"s",\#(fields)}"#))
  return state
}

@MainActor
@Suite("shortcut sheet: where the focus is and what the app offers (RarogNavigation)")
struct ShortcutSheetPlaceTests {
  @Test("form → window, also over a terminal; terminal window or terminal route → terminal; other sheet → window")
  func sheets() {
    let state = state(term: true)
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    navigation.detail = .terminal(termA)
    navigation.openSheet(.newSession(NewSessionRequest(cwd: willow)))
    #expect(navigation.shortcutSheetPlace(state) == .window)

    navigation.sheet = nil
    #expect(navigation.shortcutSheetPlace(state) == .terminal)

    // The history window over a terminal tab owns the keys, not the terminal under it.
    navigation.showTerminalHistory(termA)
    #expect(navigation.shortcutSheetPlace(state) == .window)
    navigation.sheet = nil

    navigation.detail = .session("s1")
    navigation.openSheet(.terminal(TerminalPopupRequest(cwd: willow, role: .popup), token: UUID()))
    #expect(navigation.shortcutSheetPlace(state) == .terminal)

    navigation.openSheet(.diff(DiffRequest(sessionId: "s1", path: nil)))
    #expect(navigation.shortcutSheetPlace(state) == .window)
  }

  @Test("session on screen → session; project screen or nothing → no place")
  func screens() {
    let state = state()
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    #expect(navigation.shortcutSheetPlace(state) == nil)
    navigation.detail = .session("s1")
    #expect(navigation.shortcutSheetPlace(state) == .session)
    navigation.detail = .project(willow)
    #expect(navigation.shortcutSheetPlace(state) == nil)
  }

  @Test("capabilities: notes and terminal from the server, the voice agent by its rule, ⌘B and ⌘I on a wide iPad")
  func capabilities() {
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    let off = navigation.shortcutSheetCapabilities(state(), voiceAgentEnabled: true, sonioxAllowed: true)
    #expect(off == ShortcutSheetCapabilities())

    let on = state(notes: true, term: true, companion: true)
    navigation.inspector.noteLayout(columnWidth: 1000, eligible: true)
    #expect(
      navigation.shortcutSheetCapabilities(on, voiceAgentEnabled: true, sonioxAllowed: true)
        == ShortcutSheetCapabilities(notes: true, terminal: true, voiceAgent: true, wideIPad: true))
    #expect(!navigation.shortcutSheetCapabilities(on, voiceAgentEnabled: false, sonioxAllowed: true).voiceAgent)
    #expect(!navigation.shortcutSheetCapabilities(on, voiceAgentEnabled: true, sonioxAllowed: false).voiceAgent)
  }
}
