import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Branches of the shortcut, terminal and transcript copy (`UICopy+Shortcuts.swift`, `UICopy+Terminal.swift`,
// `UICopy+Transcript.swift`): the previous-project shortcut, the terminal tab for VoiceOver without a terminal and
// in slot 0, the tab label from the foreground process, the monitor event without a name, the exit code of a task
// with an unknown result, a photo that cannot be shown and the file chip. Each test checks the part that the input
// or the condition decides, not the wording around it.

private func terminal(slot: Int, proc: String, live: Bool) -> TerminalListEntry {
  Sample.decode(TerminalListEntry.self, #"""
    {"id":"00000000000000a1","cwd":"/Users/demo/Projects/willow","live":\#(live),"slot":\#(slot),"proc":"\#(proc)","role":"shell"}
    """#)
}

private func notice(_ json: String) -> TranscriptNotice {
  Sample.decode(TranscriptNotice.self, json)
}

@Suite("UICopy branches: shortcuts, terminal, transcript")
struct UICopyBranchesTerminalTests {
  // MARK: Shortcuts

  @Test("the previous-project shortcut names the project when it is known")
  func previousProjectShortcut() {
    #expect(UICopy.shortcutPreviousProject("⟦name⟧").hasSuffix("⟦name⟧"))
    #expect(UICopy.shortcutPreviousProject(nil) == UICopy.shortcutPreviousProject)
  }

  // MARK: Terminal tab

  @Test("without a terminal the tab invites to open one, unless it is the current screen")
  func terminalTabWithoutTerminal() {
    #expect(UICopy.terminalTabSpoken(nil, current: false) == UICopy.terminalInviteSpoken)
    #expect(UICopy.terminalTabSpoken(nil, current: true) != UICopy.terminalInviteSpoken)
  }

  @Test("a terminal in slot 0 has no number: the current tab reads like the empty one, another one says go")
  func terminalTabInSlotZero() {
    let entry = terminal(slot: 0, proc: "", live: false)
    let current = UICopy.terminalTabSpoken(entry, current: true)
    let other = UICopy.terminalTabSpoken(entry, current: false)
    #expect(current == UICopy.terminalTabSpoken(nil, current: true))
    #expect(other != current)
    #expect(other != UICopy.terminalInviteSpoken)
    let readsNumber = other.contains(where: \.isNumber)
    #expect(!readsNumber, "slot 0 is not a number to read: \(other)")
  }

  @Test("the tab label is the first word of the foreground process")
  func terminalTabLabelFirstWord() {
    #expect(UICopy.terminalTabLabel(terminal(slot: 1, proc: "nvim src/main.swift", live: true)) == "nvim")
  }

  // MARK: Transcript

  @Test("a monitor event without a name has a sentence with no quoted name")
  func unnamedMonitorEvent() {
    let result = UICopy.harnessNotice(notice(#"{"kind":"monitor-event","outcome":"done","exitCode":0}"#))
    #expect(!result.text.isEmpty)
    let quotesName = result.text.contains("„")
    #expect(!quotesName, "no name, no quotation: \(result.text)")
  }

  @Test("a task with an unknown result still reports its exit code")
  func unknownResultKeepsExitCode() {
    let result = UICopy.harnessNotice(notice(#"{"kind":"command","exitCode":0}"#))
    let withoutCode = UICopy.harnessNotice(notice(#"{"kind":"command"}"#))
    #expect(result.text.contains("0"))
    #expect(result.text != withoutCode.text)
    #expect(result.tone == .quiet)
  }

  @Test("a photo that cannot be shown adds its weight only when it has one")
  func photoGoneWeight() {
    #expect(UICopy.photoGone(bytes: 0) == UICopy.imagePlaceholder)
    let weighed = UICopy.photoGone(bytes: 1)
    #expect(weighed.hasPrefix(UICopy.imagePlaceholder))
    #expect(weighed.hasSuffix("0\u{00A0}kB"))
  }

  @Test("a file chip says the name and, when known, the size")
  func attachmentChipSize() {
    #expect(UICopy.attachmentChipSpoken(name: "⟦name⟧", size: "⟦size⟧") == "⟦name⟧, ⟦size⟧")
    #expect(UICopy.attachmentChipSpoken(name: "⟦name⟧", size: nil) == "⟦name⟧")
  }
}
