import Foundation
import RarogContract
@testable import RarogActivity
import Testing

// Branches of the Live Activity tile: clamping of counters, percentages and segments, "+N workflows", the current
// phase and the phase title. The decoder of `LiveActivityContentState` refuses out-of-range values, so the states here come
// from the public initialisers: the presentation must still clamp what reaches it. Polish is the test language of
// the package (`RAROG_COPY_LANGUAGE=pl`).
@Suite("Live Activity: clamping, extra workflows and phases")
struct LiveActivityBranchesTests {
  static let epoch = 1_761_134_400

  static func state(
    _ waiting: Int, _ working: Int, _ finished: Int, workflows: [LiveActivityContentState.Workflow]? = nil,
    more: Int? = nil, limits: LiveActivityContentState.Limits? = nil, mac: LiveActivityContentState.Mac? = nil
  ) -> LiveActivityContentState {
    LiveActivityContentState(
      waiting: waiting, working: working, finished: finished, workflows: workflows, moreWorkflows: more, limits: limits,
      mac: mac, updatedEpoch: epoch)
  }

  static func workflow(
    name: String = "audyt-ux", phase: (Int, Int, String)? = nil, segments: [Int] = [40]
  ) -> LiveActivityContentState.Workflow {
    LiveActivityContentState.Workflow(
      sessionId: "demo-rarog", project: "rarog", name: name, agents: 7, done: 3,
      phase: phase.map { LiveActivityContentState.Phase(index: $0.0, count: $0.1, title: $0.2) }, segments: segments)
  }

  static let phased = workflow(phase: (2, 4, "Weryfikacja"), segments: [100, 60, 0, 0])

  // MARK: Counters

  @Test("negative counters read as zero, so the tile is quiet and shows the quiet note")
  func negativeCountersClamp() {
    let presentation = LiveActivityPresentation(Self.state(-1, -2, -3), machine: .mac)
    #expect(presentation.waiting == 0)
    #expect(presentation.working == 0)
    #expect(presentation.finished == 0)
    #expect(presentation.quietNote != nil)
  }

  // MARK: Extra workflows

  @Test("more workflows: \"+N\" and a spoken sentence only above zero")
  func moreWorkflows() {
    let two = [Self.phased, Self.workflow(name: "b")]
    let one = LiveActivityPresentation(Self.state(0, 1, 0, workflows: two, more: 1), machine: .mac)
    #expect(one.more == "+1 workflow")
    #expect(one.spoken.hasSuffix(" Jeszcze 1 workflow."))
    let zero = LiveActivityPresentation(Self.state(0, 1, 0, workflows: two, more: 0), machine: .mac)
    #expect(zero.more == nil)
    #expect(!zero.spoken.contains("Jeszcze"))
  }

  @Test("spoken sentence: the extra workflows close the sentence only when there are any")
  func spokenMoreWorkflows() {
    let rows = [LiveActivityPresentation.row(Self.phased), LiveActivityPresentation.row(Self.workflow(name: "b"))]
    let withMore = LiveActivityPresentation.spoken(
      waiting: 0, working: 0, finished: 0, quiet: false, workflows: rows, more: 1, limits: [], mac: [], machine: .mac)
    #expect(withMore.hasSuffix("rarog, b: agenci 3 z 7. Jeszcze 1 workflow."))
    let bare = LiveActivityPresentation.spoken(
      waiting: 0, working: 0, finished: 0, quiet: false, workflows: [], more: 0, limits: [], mac: [], machine: .mac)
    #expect(bare == "Rarog: nic nie czeka na decyzję.")
  }

  // MARK: Limits and machine

  @Test("limit percent is clamped to 0…100 and the bar fraction follows the clamped value")
  func limitClamp() {
    let over = LiveActivityPresentation.limit(.fiveHour, "⟦short⟧", 101)
    #expect(over.percent == 100)
    #expect(over.percentText == "100%")
    #expect(over.fraction == 1.0)
    let presentation = LiveActivityPresentation(
      Self.state(0, 1, 0, limits: .init(fiveHour: -5, weekly: 140)), machine: .mac)
    #expect(presentation.limits.map(\.percent) == [0, 100])
    #expect(presentation.limits.map(\.fraction) == [0.0, 1.0])
  }

  @Test("machine metrics are clamped to 0…100 and the bar fraction follows the clamped value")
  func macClamp() {
    let presentation = LiveActivityPresentation(Self.state(0, 1, 0, mac: .init(cpu: -3, ram: 120, disk: 0)), machine: .mac)
    #expect(presentation.mac.map(\.value) == ["0%", "100%", "0%"])
    #expect(presentation.mac.map(\.fraction) == [0.0, 1.0, 0.0])
  }

  // MARK: Workflow rows

  @Test("segments outside 0…100 are clamped, and the overall progress with them")
  func segmentsClamp() {
    let row = LiveActivityPresentation.row(Self.workflow(segments: [-10, 150]))
    #expect(row.segments == [0.0, 1.0])
    #expect(row.overall == 0.5)
  }

  @Test("phase title is trimmed of spaces and line breaks")
  func phaseTitleTrimmed() {
    let presentation = LiveActivityPresentation(
      Self.state(0, 1, 0, workflows: [Self.workflow(phase: (1, 2, "  Plan \n"), segments: [5, 0])]), machine: .mac)
    #expect(presentation.workflows.first?.progress == "faza 1/2 · Plan")
  }

  @Test("current phase: the segment of the phase number, none for a phase beyond the segments")
  func currentPhase() {
    let last = LiveActivityPresentation.row(
      Self.workflow(phase: (3, 3, String(repeating: "x", count: 25)), segments: [100, 100, 20]))
    #expect(last.current == 2)
    let beyond = LiveActivityPresentation.row(Self.workflow(phase: (5, 2, "Za daleko"), segments: [100, 0]))
    #expect(beyond.current == nil)
    #expect(beyond.progress == "faza 5/2 · Za daleko")
    #expect(beyond.segments == [1.0, 0.0])
    #expect(beyond.overall == 0.5)
  }
}
