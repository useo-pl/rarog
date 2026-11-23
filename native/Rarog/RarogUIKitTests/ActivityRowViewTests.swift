import RarogContract
@testable import RarogCore
@testable import RarogUI
import UIKit
import XCTest

/// The activity row on screen: the clock and VoiceOver follow whether the row is actually visible, the
/// hold's wake-up repaints without another event, the glyph ticks only for new session events seen on screen, and the
/// clock survives a long description, a long MCP name and the largest text size. Real `ActivityRowView` in a window
/// with a state from the core. Owner: list.
@MainActor
final class ActivityRowViewTests: XCTestCase {
  private var window: UIWindow?

  override func tearDown() {
    window?.isHidden = true
    window = nil
    super.tearDown()
  }

  func testClockAndSpeechStopWhileRowIsNotVisible() throws {
    var said: [Announcer.Announcement] = []
    let (row, card) = host()
    row.announcer = Announcer(sink: { said.append($0) }, now: Date.init)

    card.isHidden = true
    row.render(state: Self.state(.starting), sessionId: "s1")
    XCTAssertTrue(row.isAccessibilityElement, "the row has content")
    XCTAssertFalse(row.isTicking, "hidden card: the clock stands")
    XCTAssertTrue(said.isEmpty, "hidden card: VoiceOver hears nothing: \(said)")

    card.isHidden = false
    row.visibilityChanged()
    XCTAssertTrue(row.isTicking, "shown: the clock runs")
    XCTAssertEqual(said.count, 1, "shown: one sentence for the content it now shows: \(said)")

    card.isHidden = true
    row.visibilityChanged()
    XCTAssertFalse(row.isTicking, "hidden again: the clock stands")
  }

  // MARK: - Hold wake-up

  /// A tool line held over a thinking candidate: the row names the moment the hold lets thinking in and repaints
  /// then by itself, without a new store state and before the next second of the clock.
  func testHoldWakeUpShowsTheNextLineWithoutAnotherEvent() throws {
    let (row, _) = host()
    let t0 = Date()
    var clock = t0
    row.now = { clock }
    let tool = Self.state(activity: #"{"kind":"tool","toolName":"Frobnicate"}"#, at: t0)
    row.render(state: tool, sessionId: "s1")
    let toolLabel = try XCTUnwrap(row.label.text)

    clock = t0.addingTimeInterval(0.1)
    let thinking = Self.state(activity: #"{"kind":"thinking"}"#, at: clock)
    row.render(state: thinking, sessionId: "s1")
    let due = clock.addingTimeInterval(ActivityLineHold.thinkingAfterTool)
    XCTAssertEqual(row.label.text, toolLabel, "the tool line is held")
    XCTAssertEqual(row.wakeAt, due, "the row waits for the moment the hold names")

    // The same state again just before the moment: still held, the wake-up 0.3 s of real time away.
    clock = due.addingTimeInterval(-0.3)
    row.render(state: thinking, sessionId: "s1")
    XCTAssertEqual(row.label.text, toolLabel)
    XCTAssertEqual(row.wakeAt, due)

    // No render from here on: only the wake-up timer can repaint (the second clock fires 1 s after the first render).
    // The run loop spins in the tracking mode, as while a finger drags the transcript: the wake-up fires there too.
    // The app's run loop counts that mode among the common ones; the test host has not met a scroll yet, so the
    // test adds it as the app has it.
    let tracking = RunLoop.Mode(rawValue: "UITrackingRunLoopMode")
    CFRunLoopAddCommonMode(CFRunLoopGetMain(), CFRunLoopMode(tracking.rawValue as CFString))
    clock = due
    let deadline = Date().addingTimeInterval(0.6)
    while Date() < deadline { _ = RunLoop.main.run(mode: tracking, before: deadline) }
    XCTAssertEqual(row.label.text, UICopy.activityLineThinking, "the wake-up showed thinking without another event")
    XCTAssertNil(row.wakeAt, "nothing waits any more")
  }

  // MARK: - Motion from data

  func testNewSessionEventTicksTheGlyphOnceAndRestartsIt() throws {
    let (row, _) = host()
    row.reduceMotion = { false }
    var state = Self.state(activity: #"{"kind":"thinking"}"#, at: Date())
    row.render(state: state, sessionId: "s1")
    XCTAssertNil(row.glyph.layer.animation(forKey: ActivityRowView.tickKey), "no event yet: no motion")

    row.render(state: state, sessionId: "s1")
    XCTAssertNil(row.glyph.layer.animation(forKey: ActivityRowView.tickKey), "a render without an event: no motion")

    state.transcripts["s1"]?.turnEvents += 1
    row.render(state: state, sessionId: "s1")
    let first = try XCTUnwrap(row.glyph.layer.animation(forKey: ActivityRowView.tickKey) as? CAAnimationGroup)
    XCTAssertEqual(Set(first.animations?.compactMap { ($0 as? CAKeyframeAnimation)?.keyPath } ?? []),
      ["opacity", "transform.scale"], "a tick scales and fades")

    state.transcripts["s1"]?.turnEvents += 1
    row.render(state: state, sessionId: "s1")
    let second = try XCTUnwrap(row.glyph.layer.animation(forKey: ActivityRowView.tickKey))
    XCTAssertFalse(second === first, "a new event restarts the tick")
    XCTAssertEqual(row.glyph.layer.animationKeys()?.count, 1, "one tick at a time, no queue")
  }

  func testReduceMotionTicksWithOpacityOnly() throws {
    let (row, _) = host()
    row.reduceMotion = { true }
    var state = Self.state(activity: #"{"kind":"thinking"}"#, at: Date())
    row.render(state: state, sessionId: "s1")
    state.transcripts["s1"]?.turnEvents += 1
    row.render(state: state, sessionId: "s1")
    let tick = try XCTUnwrap(row.glyph.layer.animation(forKey: ActivityRowView.tickKey) as? CAAnimationGroup)
    XCTAssertEqual(tick.animations?.compactMap { ($0 as? CAKeyframeAnimation)?.keyPath }, ["opacity"])
  }

  func testEventsWhileHiddenDoNotTickWhenTheRowComesBack() {
    let (row, card) = host()
    row.reduceMotion = { false }
    var state = Self.state(activity: #"{"kind":"thinking"}"#, at: Date())
    row.render(state: state, sessionId: "s1")
    card.isHidden = true
    row.visibilityChanged()
    state.transcripts["s1"]?.turnEvents += 3
    row.render(state: state, sessionId: "s1")
    XCTAssertNil(row.glyph.layer.animation(forKey: ActivityRowView.tickKey), "hidden: no tick")

    card.isHidden = false
    row.visibilityChanged()
    row.render(state: state, sessionId: "s1")
    XCTAssertNil(row.glyph.layer.animation(forKey: ActivityRowView.tickKey), "back on screen: no backlog replay")
  }

  /// The glyph breathes and a band runs over the label only while the line says the agent works, the row is on screen
  /// and Reduce Motion is off; the next paint stops both when that ends.
  func testGlyphBreathesAndLabelShimmersOnlyWhileTheAgentWorks() {
    let cases: [(String, String, TimeInterval, Bool, Bool)] = [
      ("thinking", #"{"kind":"thinking"}"#, 0, false, true),
      ("thinking quiet for 100 s", #"{"kind":"thinking"}"#, 100, false, false),
      ("a running tool", #"{"kind":"tool","toolName":"Frobnicate"}"#, 0, false, true),
      ("waiting", #"{"kind":"waiting"}"#, 0, false, false),
      ("thinking with Reduce Motion", #"{"kind":"thinking"}"#, 0, true, false),
    ]
    for (name, json, ago, reduce, moves) in cases {
      let (row, _) = host()
      row.reduceMotion = { reduce }
      row.render(state: Self.state(activity: json, at: Date().addingTimeInterval(-ago)), sessionId: "s1")
      XCTAssertEqual(row.isBreathing, moves, "\(name): breath")
      XCTAssertEqual(row.label.isShimmering, moves, "\(name): shimmer")
      XCTAssertEqual(row.label.layer.mask?.animation(forKey: ShimmerLabel.shimmerKey) != nil, moves, "\(name): sweep")
      if moves {
        // A mask that leaves part of the label uncovered would cut the text off.
        window?.layoutIfNeeded()
        XCTAssertGreaterThan(row.label.bounds.width, 0, "\(name): the label has room")
        let mask = row.label.layer.mask?.frame ?? .zero
        XCTAssertTrue(mask.contains(row.label.bounds), "\(name): the mask \(mask) covers the label \(row.label.bounds)")
      }
    }

    let (row, card) = host()
    var reduce = false
    row.reduceMotion = { reduce }
    row.render(state: Self.state(activity: #"{"kind":"thinking"}"#, at: Date()), sessionId: "s1")
    card.isHidden = true
    row.visibilityChanged()
    XCTAssertFalse(row.isBreathing || row.label.isShimmering, "hidden: no motion")
    card.isHidden = false
    row.visibilityChanged()
    XCTAssertTrue(row.isBreathing && row.label.isShimmering, "shown again: the motion is back")
    reduce = true
    row.visibilityChanged()
    XCTAssertFalse(row.isBreathing || row.label.isShimmering, "Reduce Motion switched on: the next paint stops it")
  }

  // MARK: - Layout

  /// The clock never truncates and stays inside the row; the detail gives way before the label.
  func testClockStaysVisibleWithLongTextsAndTheLargestTextSize() throws {
    let description = String(repeating: "Run the whole suite of checks ", count: 4).prefix(120)
    let described = #"{"kind":"tool","toolName":"Frobnicate","description":"\#(description)","summary":"x --all"}"#
    let mcp = "mcp__firecrawl__firecrawl_search_across_every_known_source_with_a_long_tool_name"
    let cases: [(String, String, UIContentSizeCategory)] = [
      ("description", described, .large),
      ("MCP name", #"{"kind":"tool","toolName":"\#(mcp)","summary":"query"}"#, .large),
      ("largest text", described, .accessibilityExtraExtraExtraLarge),
    ]
    for (name, json, category) in cases {
      let (row, _) = host()
      window?.traitOverrides.preferredContentSizeCategory = category
      row.render(state: Self.state(activity: json, at: Date(), turnAgo: 754), sessionId: "s1")
      window?.layoutIfNeeded()
      let clock = row.clock
      XCTAssertFalse(clock.isHidden, "\(name): the clock shows")
      XCTAssertGreaterThanOrEqual(
        clock.bounds.width + 0.5, clock.intrinsicContentSize.width, "\(name): the clock is whole")
      let frame = clock.convert(clock.bounds, to: row)
      XCTAssertGreaterThanOrEqual(frame.minX, 0, "\(name): the clock starts inside the row")
      XCTAssertLessThanOrEqual(frame.maxX, row.bounds.maxX + 0.5, "\(name): the clock ends inside the row")
      XCTAssertGreaterThan(row.label.bounds.width, 0, "\(name): the label keeps some room")
      if !row.detail.isHidden, row.label.bounds.width + 0.5 < row.label.intrinsicContentSize.width {
        XCTAssertLessThanOrEqual(row.detail.bounds.width, 0.5, "\(name): the detail gives way before the label")
      }
    }
  }

  // MARK: - Fixtures

  private func host() -> (ActivityRowView, UIView) {
    let row = ActivityRowView()
    let card = UIView(frame: CGRect(x: 0, y: 0, width: 390, height: 120))
    row.frame = card.bounds
    row.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    card.addSubview(row)
    let host = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 300))
    host.addSubview(card)
    host.isHidden = false
    window?.isHidden = true
    window = host
    return (row, card)
  }

  private static func state(_ sessionState: SessionState) -> AppState {
    var state = AppState(clientBuild: 1)
    let json = #"""
      {"id":"s1","cwd":"/tmp/p","title":"p","state":"\#(sessionState.rawValue)",
       "stateSince":"2026-10-03T07:00:00.000Z","createdAt":"2026-10-03T07:00:00.000Z",
       "lastActivityAt":"2026-10-03T07:00:00.000Z"}
      """#
    // swiftlint:disable:next force_try
    state.sessions["s1"] = try! JSONDecoder().decode(SessionSummary.self, from: Data(json.utf8))
    state.sessionsLoaded = true
    state.global = .online
    return state
  }

  /// A working session in a turn that started `turnAgo` seconds before `at`, one prompt, and the activity `json` that
  /// arrived at `at`.
  private static func state(activity json: String, at: Date, turnAgo: TimeInterval = 300) -> AppState {
    var state = AppState(clientBuild: 1)
    let turn = iso(at.addingTimeInterval(-turnAgo))
    let session = #"""
      {"id":"s1","cwd":"/tmp/p","title":"p","state":"running","stateSince":"\#(turn)","turnSince":"\#(turn)",
       "createdAt":"\#(turn)","lastActivityAt":"\#(turn)"}
      """#
    let message = #"{"seq":1,"role":"user","blocks":[{"type":"text","text":"go"}],"at":"\#(turn)"}"#
    // swiftlint:disable force_try
    state.sessions["s1"] = try! JSONDecoder().decode(SessionSummary.self, from: Data(session.utf8))
    var view = TranscriptState()
    view.messages = [try! JSONDecoder().decode(TranscriptMessage.self, from: Data(message.utf8))]
    view.snapshots = 1
    view.activity = try! JSONDecoder().decode(Activity.self, from: Data(json.utf8))
    // swiftlint:enable force_try
    view.activityAt = at
    state.transcripts["s1"] = view
    state.sessionsLoaded = true
    state.global = .online
    state.sessionStream = .online
    return state
  }

  private static func iso(_ date: Date) -> String {
    let format = ISO8601DateFormatter()
    format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return format.string(from: date)
  }
}
