import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Branches of the copy registry: session header, inspector, list, network banners, notes. Each test pins the part
// of the sentence chosen by data or a condition, not the wording around it. Polish is the test language of the
// package (`RAROG_COPY_LANGUAGE=pl`).
@Suite("copy branches: header, inspector, list, network, notes")
struct UICopyBranchesHeaderTests {
  /// 22 Oct 2025, 12:00:00 UTC, 14:00 in Warsaw.
  static let now = Date(timeIntervalSince1970: 1_761_134_400)
  static let zone = TimeZone(identifier: "Europe/Warsaw")!

  /// A session waiting on the given `waitingFor` object (JSON as the server sends it).
  static func waiting(_ state: String, _ json: String) -> SessionSummary {
    Sample.session(state: state, extra: #""waitingFor":\#(json)"#)
  }

  // MARK: Session header

  @Test("last commit: the time joins the subject only when known")
  func commitSpokenWhen() {
    #expect(UICopy.commitSpoken(subject: "⟦subject⟧", when: "⟦when⟧").hasSuffix("⟦subject⟧, ⟦when⟧"))
    let without = UICopy.commitSpoken(subject: "⟦subject⟧", when: nil)
    #expect(without.hasSuffix("⟦subject⟧"))
    #expect(!without.contains(","))
  }

  @Test("changed file without status: the bare path, a status word only next to added lines")
  func diffFileWithoutStatus() {
    #expect(UICopy.diffFileSpoken(path: "⟦path⟧", status: nil, added: nil, deleted: nil) == "⟦path⟧")
    #expect(UICopy.diffFileSpoken(path: "⟦path⟧", status: nil, added: nil, deleted: 5) == "⟦path⟧, 5 usuniętych linii")
    #expect(UICopy.diffFileSpoken(path: "⟦path⟧", status: nil, added: 1, deleted: nil) == "⟦path⟧, zmiana, 1 dodana linia")
  }

  @Test("mode pill: a target other than plan is announced as auto")
  func modePillAutoTarget() {
    #expect(UICopy.modePillSpoken(.bypass, target: .auto, busy: false).hasSuffix("na auto"))
  }

  // MARK: Inspector

  @Test("background title: the count only when something runs")
  func backgroundTitleCount() {
    #expect(UICopy.inspectorBackgroundTitle(0) == UICopy.backgroundPanelTitle)
    #expect(UICopy.inspectorBackgroundTitle(1) == "\(UICopy.backgroundPanelTitle) · 1")
  }

  @Test("finished task that failed without an exit code names no code")
  func finishedTaskFailedWithoutCode() {
    let spoken = UICopy.finishedTaskSpoken(
      kind: "⟦kind⟧", name: "⟦name⟧", outcome: .failed, exitCode: nil, ago: "⟦ago⟧", stamp: nil)
    #expect(spoken.hasPrefix("⟦kind⟧ ⟦name⟧, "))
    #expect(spoken.hasSuffix(", ⟦ago⟧"))
    let namesCode = spoken.contains(where: \.isNumber)
    #expect(!namesCode, "no exit code, no number: \(spoken)")
  }

  // MARK: List

  @Test("waiting line for a question: number out of count (missing count = one), text after a colon")
  func waitingLineQuestion() {
    let two = Self.waiting("waiting-question", #"{"kind":"question","count":2,"text":"⟦text⟧"}"#)
    #expect(UICopy.waitingLine(two) == "pytanie 1/2: ⟦text⟧")
    let noCount = Self.waiting("waiting-question", #"{"kind":"question","text":"⟦text⟧"}"#)
    #expect(UICopy.waitingLine(noCount) == "pytanie: ⟦text⟧")
    let noText = Self.waiting("waiting-question", #"{"kind":"question","count":1,"text":""}"#)
    #expect(UICopy.waitingLine(noText) == "pytanie")
  }

  @Test("waiting line for a permission without a tool name: the bare word, text after a dot")
  func waitingLinePermissionWithoutTool() {
    let noTool = Self.waiting("waiting-permission", #"{"kind":"permission","subject":"tool","text":"⟦text⟧"}"#)
    #expect(UICopy.waitingLine(noTool) == "zgoda · ⟦text⟧")
    let emptyTool = Self.waiting("waiting-permission", #"{"kind":"permission","subject":"tool","tool":"","text":""}"#)
    #expect(UICopy.waitingLine(emptyTool) == "zgoda")
  }

  @Test("waiting line: a known herdr dialog wins over the CLI class and the refusal reason")
  func waitingLineKnownDialog() {
    var session = Sample.session()
    session.herdrDialog = .model
    session.cliDialog = .permission
    session.herdrDialogReason = .noJsonl
    #expect(UICopy.waitingLine(session) == "dialog: zmiana modelu")
  }

  // MARK: Network

  @Test("signal place trims spaces and line breaks around the session label")
  func signalPlaceTrimsNewlines() {
    var session = Sample.session(title: "willow", label: nil)
    session.label = "  ⟦label⟧ \n"
    #expect(UICopy.signalPlace(session) == "willow · ⟦label⟧")
  }

  @Test("herdr unavailable: the server detail follows the dash")
  func herdrUnavailableDetail() {
    #expect(UICopy.herdrUnavailable(detail: "⟦detail⟧", staleSince: nil, now: Self.now).hasSuffix(" — ⟦detail⟧"))
    #expect(UICopy.banner(.herdrUnavailable(detail: "⟦detail⟧", staleSince: nil), now: Self.now).hasSuffix(" — ⟦detail⟧"))
  }

  @Test("herdr read-only banner: the server detail replaces the general explanation")
  func herdrReadOnlyDetail() {
    let general = UICopy.banner(.herdrReadOnly(detail: nil), now: Self.now)
    let detailed = UICopy.banner(.herdrReadOnly(detail: "⟦detail⟧"), now: Self.now)
    #expect(detailed.hasSuffix(" — ⟦detail⟧"))
    #expect(!general.contains("⟦detail⟧"))
    #expect(general != detailed)
  }

  // MARK: Notes

  @Test("note time: a save from today shows the clock alone, without a day")
  func noteTimeToday() {
    let today = Self.now.timeIntervalSince1970 * 1000
    #expect(UICopy.noteTime(today, now: Self.now, timeZone: Self.zone) == "14:00")
  }

  @Test("note counter appears from 90 % of the ceiling, not one unit earlier")
  @MainActor
  func noteCounterThreshold() throws {
    let threshold = NotesRules.maxUnits * 9 / 10
    func counter(units: Int) throws -> (text: String, full: Bool)? {
      let cwd = "/Users/demo/Projects/rarog"
      let drafts = NoteDrafts()
      drafts.save(NoteDrafts.Draft(
        cwd: cwd, text: String(repeating: "x", count: units), ancestor: NotesDoc(text: "", updatedAt: 1),
        savedAt: Self.now))
      let notes = ProjectNotes(
        io: NoteIO(fetch: { _ in .failed(.offline) }, save: { _, _, _ in .failed(.offline) }), drafts: drafts)
      return try #require(notes.existing(cwd)).counter
    }
    #expect(try counter(units: threshold - 1) == nil)
    let shown = try #require(try counter(units: threshold))
    #expect(shown.text == UICopy.noteCounter(threshold))
    #expect(!shown.full)
  }
}
