import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// The warning line of a subagent that waits long on its own command, in the "in the background" section, and the
// warning mark of the background pill. The stage comes from the server's field; the line says how long the subagent
// has stood (from its standby) and on which tools (`CommandTools`), the mark and the reader say how bad it is.

extension BackgroundRowTests {
  /// One waiting subagent with the server's stage, its standby `ago` seconds back and two own commands.
  static func waiting(
    _ stage: String?, ago: TimeInterval = 47 * 60, since: String? = nil,
    own: String = #"[{"id":"c1","command":"pgrep -f 'demo-build'"},{"id":"c2","command":"sleep 30"}]"#
  ) -> String {
    let field = stage.map { #","ownCommandWait":"\#($0)""# } ?? ""
    return #"""
      {"id":"a","kind":"agent","description":"Coverage review","agentType":"general-purpose",
       "waitingSince":"\#(since ?? Sample.iso(ago))","ownTasks":\#(own)\#(field)}
      """#
  }

  static func session(_ tasks: String..., state: String = "waiting-input") -> SessionSummary {
    Sample.session(state: state, extra: #""backgroundTasks":[\#(tasks.joined(separator: ","))]"#)
  }

  static func row(_ session: SessionSummary) -> BackgroundTaskRow? {
    BackgroundPanel.lines(session.backgroundTasks ?? [], in: session.state, expansion: WorkflowExpansion())
      .compactMap { line -> BackgroundTaskRow? in if case let .task(row) = line { row } else { nil } }.first
  }

  @Test("long wait: the state line says minutes and tools, with the long-wait mark; the reader hears the long wait")
  func longWaitLine() throws {
    let row = try #require(Self.row(Self.session(Self.waiting("long"))))
    let warning = try #require(row.warning)
    #expect(warning.tone == .backgroundWaitLong && warning.mark == StateGlyph.mark(.backgroundWaitLong))
    #expect(warning.text(now: Sample.now) == "czeka 47\u{00A0}min na: pgrep, sleep")
    #expect(row.spoken(now: Sample.now)
      == "subagent Coverage review, długo czeka na: pgrep, sleep, od 47 minut, general-purpose")
    // Lines under the row stay as they were: the warning takes the place of the state line, it adds no line.
    let lines = BackgroundPanel.lines(
      Self.session(Self.waiting("long")).backgroundTasks ?? [], in: .waitingInput, expansion: WorkflowExpansion())
    #expect(lines.map(\.id) == ["task:a", "own:a:label", "own:a:task:c1", "own:a:task:c2"])
  }

  @Test("stuck wait: the same line with hours, in the waiting tone and its mark; the reader hears stuck")
  func stuckWaitLine() throws {
    let row = try #require(Self.row(Self.session(Self.waiting("stuck", ago: 75 * 60))))
    let warning = try #require(row.warning)
    #expect(warning.tone == .waiting && warning.mark == StateGlyph.mark(.waiting))
    #expect(warning.mark != StateGlyph.mark(.backgroundWaitLong), "the two stages differ by shape, not only by color")
    #expect(warning.text(now: Sample.now) == "czeka 1\u{00A0}h\u{00A0}15 na: pgrep, sleep")
    #expect(row.spoken(now: Sample.now)
      == "subagent Coverage review, wisi na: pgrep, sleep, od 1 godziny, general-purpose")
  }

  @Test("tools: each once, in list order; a command the list does not know is the word command")
  func warningTools() throws {
    let twice = #"[{"id":"c1","command":"sleep 30"},{"id":"c2","command":"sleep 60"},{"id":"c3","command":"pgrep x"}]"#
    let row = try #require(Self.row(Self.session(Self.waiting("long", own: twice))))
    #expect(row.warning?.text(now: Sample.now) == "czeka 47\u{00A0}min na: sleep, pgrep")
    let bare = try #require(Self.row(Self.session(Self.waiting("long", own: #"[{"id":"c1"}]"#))))
    #expect(bare.warning?.text(now: Sample.now) == "czeka 47\u{00A0}min na: komenda")
    // A command the summary does not recognize never puts its text into the line or the reader's sentence.
    let function = #"[{"id":"c1","command":"helper() { sleep 9999; }; helper"}]"#
    let odd = try #require(Self.row(Self.session(Self.waiting("long", own: function))))
    #expect(odd.warning?.text(now: Sample.now) == "czeka 47\u{00A0}min na: komenda")
    #expect(odd.spoken(now: Sample.now).contains("helper") == false)
  }

  @Test("a standby time that is not a time: the line and the reader without minutes")
  func untimedWarning() throws {
    let row = try #require(Self.row(Self.session(Self.waiting("stuck", since: "wczoraj"))))
    #expect(row.warning?.text(now: Sample.now) == "czeka na: pgrep, sleep")
    #expect(row.spoken(now: Sample.now) == "subagent Coverage review, wisi na: pgrep, sleep, general-purpose")
  }

  @Test("no warning: without the field, at short, in a session that ended, and without the session state")
  func noWarning() throws {
    for session in [
      Self.session(Self.waiting(nil)), Self.session(Self.waiting("short")),
      Self.session(Self.waiting("stuck", ago: 75 * 60), state: "done"),
      Self.session(Self.waiting("long"), state: "resumable"),
    ] {
      let row = try #require(Self.row(session))
      #expect(row.warning == nil, "\(session.state)")
      #expect(row.status(now: Sample.now).first == "czeka na własne zadanie", "the state line as before")
      #expect(BackgroundBadge(session)?.warning == nil)
    }
    let plain = BackgroundTaskRow(Sample.decode(BackgroundTask.self, Self.waiting("stuck", ago: 75 * 60)))
    #expect(plain.warning == nil, "a row built without the session state has no stage")
  }

  @Test("background pill: the warning mark of the strongest wait, also during a turn; the reader hears it")
  func badgeWarning() throws {
    let command = #"{"id":"b","kind":"command","command":"pnpm test"}"#
    let long = try #require(BackgroundBadge(Self.session(Self.waiting("long"), command)))
    #expect(long.warning == .backgroundWaitLong && long.working)
    #expect(long.spoken == "2 zadania w tle: subagent Coverage review długo czeka na własne zadanie, komenda pnpm test")
    let stuck = try #require(BackgroundBadge(Self.session(Self.waiting("stuck", ago: 75 * 60), state: "running")))
    #expect(stuck.warning == .waiting)
    #expect(stuck.spoken == "1 zadanie w tle: subagent Coverage review wisi na komendzie")
    let short = try #require(BackgroundBadge(Self.session(Self.waiting("short"))))
    #expect(short.warning == nil && short.spoken == "1 zadanie w tle: subagent Coverage review czeka na własne zadanie")
  }
}
