import Foundation
import RarogContract
import RarogContractFixtures
import RarogCore
@testable import RarogUI
import Testing

// Renaming a session in place on the list row: the field's rules, when the row offers the item, and the pending name
// the row shows until the server's label arrives. Owner: list.

@MainActor
@Suite("session rename on the list row")
struct SessionRenameTests {
  /// Controlled waiting: every confirmation window waits until the test releases it.
  final class Waits: @unchecked Sendable {
    private let lock = NSLock()
    private var pending: [CheckedContinuation<Void, Never>] = []
    private(set) var durations: [Duration] = []

    var wait: @Sendable (Duration) async -> Void {
      { [self] duration in
        await withCheckedContinuation { continuation in
          lock.withLock {
            durations.append(duration)
            pending.append(continuation)
          }
        }
      }
    }

    var count: Int { lock.withLock { pending.count } }

    func release(_ index: Int) {
      let continuation = lock.withLock { pending[index] }
      continuation.resume()
    }
  }

  /// What the renamer did: the texts it sent and the sentences it posted.
  final class Log {
    var sent: [String] = []
    var notices: [String] = []
  }

  private func settle(_ condition: () -> Bool) async {
    for _ in 0..<200 where !condition() {
      try? await Task.sleep(for: .milliseconds(2))
    }
  }

  // MARK: Field and save

  @Test(
    "the save trims, folds line breaks into spaces and cancels an empty or unchanged name",
    arguments: [
      ("  Nowa  ", "zapis notatek", "/rename Nowa"),
      ("", "zapis notatek", nil),
      ("   ", "zapis notatek", nil),
      ("zapis notatek", "zapis notatek", nil),
      (" zapis   notatek ", "zapis notatek", nil),
      ("a\nb", "zapis notatek", "/rename a b"),
      ("a\r\n\tb", "zapis notatek", "/rename a b"),
    ] as [(String, String, String?)])
  func save(draft: String, current: String, command: String?) {
    let save = SessionRename.save(draft, current: current)
    switch save {
    case .cancel: #expect(command == nil, "\(draft.debugDescription) sends \(command ?? "-")")
    case let .send(name): #expect(SessionRename.command(name) == command, "\(draft.debugDescription)")
    }
  }

  @Test("the field takes 28 characters and refuses the 29th; a pasted line break becomes a space")
  func fieldLimit() {
    let full = String(repeating: "a", count: SessionRename.maxLength)
    #expect(SessionRename.fieldText(full) == full)
    #expect(SessionRename.fieldText(full + "b") == full)
    #expect(SessionRename.save(full, current: "x") == .send(name: full))
    #expect(SessionRename.fieldText("a\nb") == "a b")
    // A character outside the basic plane counts as two units, as the server counts the label length; the field
    // never cuts one in half.
    let emoji = String(repeating: "a", count: SessionRename.maxLength - 1) + "🦊"
    #expect(SessionRename.fieldText(emoji) == String(repeating: "a", count: SessionRename.maxLength - 1))
  }

  @Test(
    "a keystroke or paste takes only the room left and keeps the text after it",
    arguments: [
      // A full field refuses a character typed at the start; the end of the name stays.
      (String(repeating: "a", count: 28), 0, 0, "b", String(repeating: "a", count: 28), 0),
      // A paste into the middle of a 26-character name: two characters fit, the rest of the name stays after them.
      ("abcdefghijklmnopqrstuvwxyz", 13, 0, "XYZ", "abcdefghijklmXYnopqrstuvwxyz", 15),
      // A selection makes room: the paste replaces it as far as the room goes.
      (String(repeating: "a", count: 28), 0, 2, "xyz", "xy" + String(repeating: "a", count: 26), 2),
      // A pasted line break becomes a space.
      ("ad", 1, 0, "b\nc", "ab cd", 4),
      // A character outside the basic plane needs two units and is not cut in half.
      (String(repeating: "a", count: 27), 0, 0, "🦊", String(repeating: "a", count: 27), 0),
    ] as [(String, Int, Int, String, String, Int)])
  func edit(text: String, location: Int, length: Int, replacement: String, result: String, caret: Int) {
    let edited = SessionRename.edit(text, replacing: NSRange(location: location, length: length), with: replacement)
    #expect(edited.text == result, "\(replacement.debugDescription) at \(location)")
    #expect(edited.caret == caret, "\(replacement.debugDescription) at \(location)")
  }

  @Test("the hint names Esc only with a hardware keyboard; on touch it names the gestures that work")
  func hint() {
    #expect(SessionRename.hint(hardwareKeyboard: true) == UICopy.renameHint)
    #expect(SessionRename.hint(hardwareKeyboard: true).contains("Esc"))
    #expect(SessionRename.hint(hardwareKeyboard: false) == UICopy.renameHintTouch)
    #expect(!SessionRename.hint(hardwareKeyboard: false).contains("Esc"), "touch has no Esc")
  }

  @Test("the row shows the name the card will get: words past the server's limit fall away")
  func cardLabel() {
    #expect(SessionRename.cardLabel("a b c d e f") == "a b c d e")
    #expect(SessionRename.cardLabel("  a   b ") == "a b")
  }

  @Test("the field limits mirror the server's label rule in server/src/session-label.ts")
  func mirrorsServerLimits() throws {
    let file = try GoldenFrames.repoRoot().appending(path: "server/src/session-label.ts")
    let source = try String(contentsOf: file, encoding: .utf8)
    func constant(_ name: String) throws -> Int {
      let match = try #require(source.firstMatch(of: try Regex("const \(name) = (\\d+);")), "no \(name)")
      return try #require(match.output[1].substring.flatMap { Int($0) })
    }
    #expect(SessionRename.maxLength == (try constant("MAX_LABEL_LENGTH")))
    #expect(SessionRename.maxWords == (try constant("MAX_LABEL_WORDS")))
  }

  // MARK: When the row offers the item

  @Test("the item: Claude Code with a send channel, also in a turn; not Codex, a terminal, no channel, the cache")
  func availability() {
    func offered(_ session: SessionSummary, cached: Bool = false, readOnly: Bool = false) -> Bool {
      var state = Sample.state(session: session)
      if cached { state.listCache.staleSince = Sample.now }
      if readOnly {
        state.herdr = HerdrStatus(available: true, agentCount: 1, readOnly: true, canLaunch: false, detail: nil)
      }
      return SessionRename.available(session, state: state)
    }
    #expect(offered(Sample.session(state: "waiting-input")))
    #expect(offered(Sample.session(state: "running")), "during a turn")
    #expect(!offered(Sample.session(state: "running", extra: #""engine":"codex""#)), "Codex")
    #expect(!offered(Sample.session(state: "running", extra: #""engine":"codex","termId":"t1""#)), "terminal")
    #expect(!offered(Sample.session(state: "waiting-input", extra: #""termId":"t1""#)), "agent in a terminal")
    #expect(!offered(Sample.session(state: "waiting-input"), cached: true), "cached list")
    #expect(!offered(Sample.session(state: "waiting-input"), readOnly: true), "no send channel")
    #expect(!offered(Sample.session(state: "done")), "no send channel: the session ended")
  }

  // MARK: Pending name

  private func renamer(_ waits: Waits) -> SessionRenamer {
    SessionRenamer(wait: waits.wait)
  }

  @Test("Return sends /rename, the row shows the new name at once and keeps it when the server's label arrives")
  func confirmed() async {
    let waits = Waits()
    let log = Log()
    let renamer = renamer(waits)
    var label: String? = "zapis notatek"
    renamer.begin("s1", name: "zapis notatek")
    #expect(renamer.editing == "s1")
    let save = Task {
      await renamer.save(
        "  Nowa nazwa ", sessionId: "s1",
        send: { text in log.sent.append(text); return .accepted(UUID()) },
        label: { label }, notice: { log.notices.append($0) })
    }
    await settle { waits.count == 1 && !log.sent.isEmpty }
    #expect(renamer.editing == nil)
    #expect(log.sent == ["/rename Nowa nazwa"])
    #expect(renamer.pendingName("s1") == "Nowa nazwa")
    #expect(waits.durations == [SessionRename.confirmWithin])
    label = "Nowa nazwa"
    waits.release(0)
    await save.value
    #expect(renamer.pendingName("s1") == nil)
    #expect(log.notices.isEmpty)
  }

  @Test("no label from the server within 10 s: the old name comes back and a sentence says why")
  func timedOut() async {
    let waits = Waits()
    let log = Log()
    let renamer = renamer(waits)
    renamer.begin("s1", name: "zapis notatek")
    let save = Task {
      await renamer.save(
        "Nowa", sessionId: "s1", send: { _ in .accepted(UUID()) },
        label: { "zapis notatek" }, notice: { log.notices.append($0) })
    }
    await settle { waits.count == 1 }
    #expect(renamer.pendingName("s1") == "Nowa")
    waits.release(0)
    await save.value
    #expect(renamer.pendingName("s1") == nil)
    #expect(log.notices == [UICopy.renameTimedOut])
  }

  @Test("the 10 s window counts from Return and ends the wait itself while the send is still on its way")
  func windowEndsWhileSending() async {
    let waits = Waits()
    let sending = Waits()
    let log = Log()
    let renamer = renamer(waits)
    renamer.begin("s1", name: "zapis notatek")
    let save = Task {
      await renamer.save(
        "Nowa", sessionId: "s1",
        send: { _ in await sending.wait(.zero); return .accepted(UUID()) },
        label: { "zapis notatek" }, notice: { log.notices.append($0) })
    }
    await settle { sending.count == 1 && waits.count == 1 }
    #expect(waits.count == 1, "the window started before the send came back")
    guard waits.count == 1 else { sending.release(0); await save.value; return }
    waits.release(0)
    await settle { renamer.pendingName("s1") == nil }
    #expect(renamer.pendingName("s1") == nil, "the old name is back when the window ends, not when the send does")
    #expect(log.notices == [UICopy.renameTimedOut])
    sending.release(0)
    await save.value
    #expect(renamer.pendingName("s1") == nil)
    #expect(log.notices == [UICopy.renameTimedOut], "a send that comes back later adds nothing")
  }

  @Test("a refusal that comes back after the window still says why; the old name is already back")
  func refusedAfterWindow() async {
    let waits = Waits()
    let sending = Waits()
    let log = Log()
    let renamer = renamer(waits)
    renamer.begin("s1", name: "zapis notatek")
    let save = Task {
      await renamer.save(
        "Nowa", sessionId: "s1",
        send: { _ in await sending.wait(.zero); return .refused(UUID(), code: nil, message: "Sesja zajęta.") },
        label: { "zapis notatek" }, notice: { log.notices.append($0) })
    }
    await settle { sending.count == 1 && waits.count == 1 }
    guard waits.count == 1 else { sending.release(0); await save.value; Issue.record("no window"); return }
    waits.release(0)
    await settle { renamer.pendingName("s1") == nil }
    sending.release(0)
    await save.value
    #expect(renamer.pendingName("s1") == nil)
    #expect(log.notices == [UICopy.renameTimedOut, UICopy.renameRefused("Sesja zajęta.")])
  }

  @Test("the server's label with the new name ends the wait at once; a later label from the terminal shows")
  func labelSettles() async {
    let waits = Waits()
    let log = Log()
    let renamer = renamer(waits)
    var label: String? = "zapis notatek"
    renamer.begin("s1", name: "zapis notatek")
    let save = Task {
      await renamer.save(
        "Nowa  nazwa", sessionId: "s1", send: { _ in .accepted(UUID()) },
        label: { label }, notice: { log.notices.append($0) })
    }
    await settle { waits.count == 1 }
    renamer.labelChanged("s1", to: "inna")
    #expect(renamer.pendingName("s1") == "Nowa nazwa", "another label does not end the wait")
    label = "Nowa nazwa"
    renamer.labelChanged("s1", to: label)
    #expect(renamer.pendingName("s1") == nil, "the row shows the server's label")
    label = "z terminala"
    renamer.labelChanged("s1", to: label)
    #expect(renamer.pendingName("s1") == nil, "a rename from the terminal shows at once")
    waits.release(0)
    await save.value
    #expect(log.notices.isEmpty, "no sentence after the label came")
  }

  /// The list hands a row's label to `labelChanged` as soon as the row starts to wait, with the label it already
  /// has. A new name whose card label is the current one ("a b c d e" → "a b c d e f") must not read that as the
  /// server's confirmation.
  @Test("a new name with the current card label: the label already there confirms nothing and a refusal says why")
  func sameCardLabelRefused() async {
    let waits = Waits()
    let sending = Waits()
    let log = Log()
    let renamer = renamer(waits)
    let label: String? = "a b c d e"
    renamer.begin("s1", name: "a b c d e")
    let save = Task {
      await renamer.save(
        "a b c d e f", sessionId: "s1",
        send: { _ in await sending.wait(.zero); return .refused(UUID(), code: nil, message: "Sesja zajęta.") },
        label: { label }, notice: { log.notices.append($0) })
    }
    await settle { sending.count == 1 && waits.count == 1 }
    renamer.labelChanged("s1", to: label)
    #expect(renamer.pendingName("s1") == "a b c d e", "the row still waits")
    sending.release(0)
    await save.value
    #expect(renamer.pendingName("s1") == nil)
    #expect(log.notices == [UICopy.renameRefused("Sesja zajęta.")])
  }

  @Test("a new name with the current card label and no refusal: the row waits out the window, then no sentence")
  func sameCardLabelAccepted() async {
    let waits = Waits()
    let log = Log()
    let renamer = renamer(waits)
    let label: String? = "a b c d e"
    renamer.begin("s1", name: "a b c d e")
    let save = Task {
      await renamer.save(
        "a b c d e f", sessionId: "s1", send: { _ in .accepted(UUID()) },
        label: { label }, notice: { log.notices.append($0) })
    }
    await settle { waits.count == 1 }
    renamer.labelChanged("s1", to: label)
    #expect(renamer.pendingName("s1") == "a b c d e", "the label already there ends no wait")
    waits.release(0)
    await save.value
    #expect(renamer.pendingName("s1") == nil)
    #expect(log.notices.isEmpty, "the server's label is the card label of the new name")
  }

  @Test("a refused send: the old name comes back at once and the sentence carries the server's reason")
  func refused() async {
    let waits = Waits()
    let log = Log()
    let renamer = renamer(waits)
    renamer.begin("s1", name: "zapis notatek")
    await renamer.save(
      "Nowa", sessionId: "s1",
      send: { _ in .refused(UUID(), code: "CLI_DIALOG_SEND_MESSAGE", message: "Wiadomość czeka w kolejce.") },
      label: { "zapis notatek" }, notice: { log.notices.append($0) })
    #expect(renamer.pendingName("s1") == nil)
    #expect(log.notices == [UICopy.renameRefused("Wiadomość czeka w kolejce.")])
    // Without a reason the sentence still says what happened.
    renamer.begin("s1", name: "zapis notatek")
    await renamer.save(
      "Nowa", sessionId: "s1", send: { _ in .refused(UUID(), code: nil, message: nil) },
      label: { "zapis notatek" }, notice: { log.notices.append($0) })
    #expect(log.notices.last == UICopy.renameRefused(nil))
  }

  @Test("an empty or unchanged name and Esc send nothing")
  func cancelled() async {
    let waits = Waits()
    let log = Log()
    let renamer = renamer(waits)
    renamer.begin("s1", name: "zapis notatek")
    renamer.cancel("s1")
    #expect(renamer.editing == nil)
    for draft in ["", "   ", "zapis notatek"] {
      renamer.begin("s1", name: "zapis notatek")
      await renamer.save(
        draft, sessionId: "s1", send: { text in log.sent.append(text); return .empty },
        label: { "zapis notatek" }, notice: { log.notices.append($0) })
      #expect(renamer.editing == nil)
    }
    #expect(log.sent.isEmpty && log.notices.isEmpty && renamer.pendingName("s1") == nil)
  }

  @Test("every opening of a field is a new edit, also the next one of the same row")
  func editNumbers() {
    let renamer = renamer(Waits())
    renamer.begin("s1", name: "zapis notatek")
    let first = renamer.edit
    renamer.cancel("s1")
    renamer.begin("s1", name: "zapis notatek")
    #expect(renamer.edit != first, "the list may hand the second field the first one's view: it must start over")
  }

  @Test("Return decides before the send suspends: a cancel right after it does not drop the save")
  func decidesBeforeSending() async {
    let waits = Waits()
    let log = Log()
    let renamer = renamer(waits)
    renamer.begin("s1", name: "zapis notatek")
    let save = Task.immediate {
      await renamer.save(
        "Nowa", sessionId: "s1",
        send: { text in
          await Task.yield()
          log.sent.append(text)
          return .accepted(UUID())
        },
        label: { "Nowa" }, notice: { log.notices.append($0) })
    }
    #expect(renamer.editing == nil, "the field is closed before anything suspends")
    #expect(renamer.pendingName("s1") == "Nowa")
    renamer.cancel("s1")
    await settle { waits.count == 1 }
    waits.release(0)
    await save.value
    #expect(log.sent == ["/rename Nowa"], "the cancel after Return did not drop the save")
  }

  @Test("a second rename of the same row replaces the first: the first window ends without a word")
  func secondRename() async {
    let waits = Waits()
    let log = Log()
    let renamer = renamer(waits)
    var label: String? = "zapis notatek"
    renamer.begin("s1", name: "zapis notatek")
    let first = Task {
      await renamer.save(
        "Pierwsza", sessionId: "s1", send: { _ in .accepted(UUID()) },
        label: { label }, notice: { log.notices.append($0) })
    }
    await settle { waits.count == 1 }
    renamer.begin("s1", name: "Pierwsza")
    let second = Task {
      await renamer.save(
        "Druga", sessionId: "s1", send: { _ in .accepted(UUID()) },
        label: { label }, notice: { log.notices.append($0) })
    }
    await settle { waits.count == 2 }
    #expect(renamer.pendingName("s1") == "Druga")
    waits.release(0)
    await first.value
    #expect(renamer.pendingName("s1") == "Druga" && log.notices.isEmpty)
    label = "Druga"
    waits.release(1)
    await second.value
    #expect(renamer.pendingName("s1") == nil && log.notices.isEmpty)
  }

  @Test("Return compares with the name the field started with, even when the row's name changed meanwhile")
  func unchangedAfterExpiry() async throws {
    let waits = Waits()
    let log = Log()
    let renamer = renamer(waits)
    renamer.begin("s1", name: "zapis notatek")
    let first = Task {
      await renamer.save(
        "Pierwsza", sessionId: "s1", send: { text in log.sent.append(text); return .accepted(UUID()) },
        label: { "zapis notatek" }, notice: { log.notices.append($0) })
    }
    await settle { waits.count == 1 }
    // The field opens on the pending name; its window then ends and the row goes back to the old label.
    renamer.begin("s1", name: try #require(renamer.pendingName("s1")))
    waits.release(0)
    await first.value
    #expect(renamer.pendingName("s1") == nil)
    await renamer.save(
      "Pierwsza", sessionId: "s1", send: { text in log.sent.append(text); return .accepted(UUID()) },
      label: { "zapis notatek" }, notice: { log.notices.append($0) })
    #expect(log.sent == ["/rename Pierwsza"], "an unchanged Return sends nothing")
    #expect(renamer.editing == nil && waits.count == 1)
    // Return from a field that is no longer open sends nothing either.
    await renamer.save(
      "Inna", sessionId: "s1", send: { text in log.sent.append(text); return .accepted(UUID()) },
      label: { "zapis notatek" }, notice: { log.notices.append($0) })
    #expect(log.sent == ["/rename Pierwsza"])
  }

  @Test("the row model takes the pending name as its session name")
  func rowModel() {
    let row = SessionRowModel(Sample.session(), ordinal: nil, showsProject: false)
    #expect(row.renamed("Nowa").treeTitle == "Nowa")
    #expect(row.renamed("Nowa").label == "Nowa")
  }
}
