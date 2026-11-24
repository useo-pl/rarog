import RarogContract
@testable import RarogCore
import RarogTransport
@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// The voice conversation across sessions in the session screen's header and in the Inbox's header, over the real
/// split view of the class's rig: where the list header is off screen (a session pushed on iPhone, the list column
/// hidden on iPad) the lit circle stands first in the session header's icon group, and on the Inbox at the root of
/// the iPhone's stack after its title, in the state's tone with bars in the background colour, and the screen does not
/// move; a waiting prompt's card and the end sentence's line stand above the screen, and a tap removes the line;
/// beside the list column the circle stands in the list header only. Owner: voice agent.
extension VoiceAgentSessionsBarTests {
  /// Stands for the owner's removal of the end sentence.
  @MainActor
  final class Dismissals {
    var count = 0
  }

  /// The lit circle of `indicator` in the session header's icon group `group`, measured on the window's pixels:
  /// its size, a bar pixel in the background colour, and a touch on it that lands in the group's item.
  @discardableResult
  func assertSessionHeaderCircle(
    _ rig: Rig, _ indicator: VoiceAgentIndicator, _ place: String, file: StaticString = #filePath, line: UInt = #line
  ) throws -> CGRect {
    let group = try XCTUnwrap(rig.sessionGroup, "\(place): the session header's icon group", file: file, line: line)
    let pixels = try rig.rendered()
    let tone = Self.rgb(VoiceStatusView.color(indicator.tone), in: rig.window)
    let circle = try XCTUnwrap(
      Self.circle(in: pixels, around: group, tone: tone), "\(place): the state's tone in the session header \(group)",
      file: file, line: line)
    let diameter = VoiceAgentSessionsLitCircle.diameter
    XCTAssertEqual(
      circle.width, diameter, accuracy: 1.5, "\(place): the circle's width \(circle)", file: file, line: line)
    XCTAssertEqual(
      circle.height, diameter, accuracy: 1.5, "\(place): the circle's height \(circle)", file: file, line: line)
    XCTAssertEqual(
      circle.minX, group.minX + (HeaderMetrics.iconTarget - diameter) / 2, accuracy: 1.5,
      "\(place): the circle is the group's first icon \(circle) in \(group)", file: file, line: line)
    let bar = pixels.color(at: CGPoint(x: circle.midX, y: circle.midY))
    let background = Self.rgb(Palette.background, in: rig.window)
    XCTAssertLessThanOrEqual(
      RenderedPixels.distance(bar, background), 12,
      "\(place): the middle bar in the background colour, "
        + "\(String(bar, radix: 16)) vs \(String(background, radix: 16))",
      file: file, line: line)
    let host = try XCTUnwrap(rig.sessionItemViews.last, file: file, line: line)
    let touched = try XCTUnwrap(rig.window.hitTest(CGPoint(x: circle.midX, y: circle.midY), with: nil))
    XCTAssertTrue(
      touched.isDescendant(of: host), "\(place): a touch on the circle lands in the icon group", file: file, line: line)
    return circle
  }

  /// Catches a running conversation shown in a bar that pushes the session screen down at every start, a circle
  /// missing from the session header or drawn white by its navigation bar, a circle that does not stand first, and
  /// a group that moves its other icons or the title when the circle comes and goes.
  func testOnIPhoneTheLitCircleStandsInTheSessionHeaderAndTheScreenStays() throws {
    let rig = try Rig(style: .dark)
    defer { rig.close() }
    rig.navigation.openPushTarget(PushTarget(sessionId: "p1-a"), state: rig.store.state)
    rig.show(nil)
    XCTAssertTrue(rig.navigation.compactShowsDetail, "the session screen on top")
    let top = try XCTUnwrap(rig.sessionBarTop, "the session screen's navigation bar")
    let quiet = rig.sessionItemViews.map { $0.convert($0.bounds, to: nil) }
    let title = try XCTUnwrap(quiet.first, "the title's item: \(quiet)")

    for indicator in [VoiceAgentIndicator.connecting, .listening, .answering] {
      rig.show(VoiceAgentSessionsBarContent(indicator: indicator, running: true))
      XCTAssertEqual(try XCTUnwrap(rig.sessionBarTop), top, accuracy: 0.5, "\(indicator): the screen does not move")
      let items = rig.sessionItemViews.map { $0.convert($0.bounds, to: nil) }
      let group = try XCTUnwrap(items.last)
      XCTAssertEqual(try XCTUnwrap(items.first), title, "\(indicator): the title keeps its frame")
      if quiet.count > 1, let before = quiet.last {
        XCTAssertEqual(group.maxX, before.maxX, accuracy: 1, "\(indicator): the other icons keep their places")
        XCTAssertEqual(
          group.width, before.width + HeaderMetrics.iconTarget + HeaderMetrics.iconSpacing, accuracy: 1.5,
          "\(indicator): the circle adds one icon to the group: \(before) → \(group)")
      }
      try assertSessionHeaderCircle(rig, indicator, "iPhone, \(indicator)")
    }

    rig.show(nil)
    XCTAssertEqual(
      rig.sessionItemViews.map { $0.convert($0.bounds, to: nil) }, quiet, "after the end the header is as before")
  }

  /// Catches a waiting prompt with no card on the session screen, a card with a state's row beside the header's
  /// circle, and a card without the question the user answers.
  func testOnIPhoneAWaitingPromptsCardStandsAboveTheSessionScreen() throws {
    InboxScreenTests.enableAccessibility()
    let rig = try Rig()
    defer { rig.close() }
    rig.navigation.openPushTarget(PushTarget(sessionId: "p1-a"), state: rig.store.state)
    rig.show(nil)
    let top = try XCTUnwrap(rig.sessionBarTop)
    let content = Self.prompting(Self.threeLinePrompt)
    rig.show(content)
    let card = barHeight(content, width: rig.window.bounds.width)
    XCTAssertGreaterThanOrEqual(try XCTUnwrap(rig.sessionBarTop), top + card - 0.5, "the card above the screen")
    try assertSessionHeaderCircle(rig, .listening, "iPhone, a waiting prompt")
    let prompt = try XCTUnwrap(InboxScreenTests.element("voiceAgent.sessions.bar.prompt", in: rig.window))
    XCTAssertEqual(prompt.accessibilityValue, Self.threeLinePrompt, "the card's text")
    XCTAssertNil(InboxScreenTests.element("voiceAgent.sessions.bar.state", in: rig.window), "no state's row")
  }

  /// Catches the circle twice on iPad (in the list header and in the session header beside it) and no circle at all
  /// with the list column hidden. The two halves read the session header with the same helper, so the "none" half
  /// cannot pass by looking in the wrong place.
  func testOnIPadTheSessionHeaderCarriesTheCircleOnlyWithTheListColumnHidden() throws {
    let rig = try Rig(style: .dark, regular: true)
    defer { rig.close() }
    rig.navigation.openPushTarget(PushTarget(sessionId: "p1-a"), state: rig.store.state)
    rig.show(nil)
    let quiet = try XCTUnwrap(rig.sessionGroup, "the session header's icon group")
    rig.show(Self.listening)
    let tone = Self.rgb(VoiceStatusView.color(VoiceAgentIndicator.listening.tone), in: rig.window)
    let pixels = try rig.rendered()
    let group = try XCTUnwrap(rig.sessionGroup)
    XCTAssertEqual(group, quiet, "both columns: the session header's group unchanged")
    XCTAssertNil(Self.circle(in: pixels, around: group, tone: tone), "both columns: no circle in the session header")
    let list = try XCTUnwrap(rig.barItems.last, "the list bar's buttons")
    XCTAssertNotNil(Self.circle(in: pixels, around: list, tone: tone), "both columns: the circle in the list header")
    let tops = rig.barTops

    rig.navigation.setListCollapsed(true)
    ProjectTreeListTests.spin()
    XCTAssertTrue(rig.navigation.listHidden)
    XCTAssertEqual(
      try XCTUnwrap(rig.sessionBarTop), try XCTUnwrap(tops.min()), accuracy: 0.5,
      "the list column hidden: no bar above the session screen")
    try assertSessionHeaderCircle(rig, .listening, "iPad, the list column hidden")
  }

  /// Catches bars in the session header's circle that stand still while the levels change: the root's owner does not
  /// reach the item of the detail column's toolbar, and then its tap would not end the conversation either.
  func testTheSessionHeaderCircleFollowsTheLevels() throws {
    let rig = try Rig()
    defer { rig.close() }
    rig.navigation.openPushTarget(PushTarget(sessionId: "p1-a"), state: rig.store.state)
    rig.show(Self.listening)
    let group = try XCTUnwrap(rig.sessionGroup)
    let quiet = try rig.pixels(group)
    rig.owner.levels = RealtimeLevels(input: 0.4, output: 0)
    ProjectTreeListTests.spin()
    XCTAssertNotEqual(try rig.pixels(group), quiet, "a louder microphone raises the bars in the session header")
  }

  /// Catches a running conversation on the Inbox at the root of the iPhone's stack shown in a bar that pushes the
  /// Inbox down at every start, a circle missing from the Inbox's own header or drawn white by its navigation bar, a
  /// title that moves when the circle comes, and a circle whose tap does not end the owner's conversation.
  func testOnIPhoneTheInboxAtTheStacksRootCarriesTheLitCircleInItsHeader() async throws {
    InboxScreenTests.enableAccessibility()
    // The opening list's read waits in the hold until the test releases it, so the end comes while it is read.
    let reached = expectation(description: "the opening list is read")
    let hold = ReadHold { reached.fulfill() }
    let catalog = try JSONDecoder().decode(CompanionSessions.self, from: Data(#"{"sessions":[]}"#.utf8))
    let transport = UIKitTransport(onCompanionSessions: { () throws(TransportError) -> CompanionSessions in
      await hold.pause()
      return catalog
    })
    let rig = try Rig(style: .dark, transport: transport)
    defer { rig.close() }
    rig.store.voiceAgent.acceptConsent()
    rig.store.voiceAgent.acceptSessionsConsent()
    rig.navigation.openInbox()
    rig.show(nil)
    XCTAssertTrue(rig.navigation.compactShowsDetail, "the Inbox on top")
    let top = try XCTUnwrap(rig.sessionBarTop, "the Inbox's navigation bar")
    let title = try XCTUnwrap(rig.sessionItemViews.first, "the Inbox's title").convert(CGPoint.zero, to: nil)

    rig.show(Self.listening)
    XCTAssertEqual(
      try XCTUnwrap(rig.sessionBarTop), top, accuracy: 0.5, "nothing above the Inbox while the conversation runs")
    XCTAssertEqual(rig.sessionItemViews.count, 2, "the title and the circle in the Inbox's header")
    XCTAssertEqual(
      try XCTUnwrap(rig.sessionItemViews.first).convert(CGPoint.zero, to: nil), title, "the title keeps its place")
    try assertSessionHeaderCircle(rig, .listening, "the Inbox")

    // A start whose opening list is read runs; the circle's tap ends it through the owner.
    let started = Task { await rig.owner.start() }
    await fulfillment(of: [reached], timeout: 5)
    XCTAssertTrue(rig.owner.isActive, "the owner's conversation runs")
    try InboxScreenTests.activate("inbox.voiceAgentSessions.end", in: rig.window)
    XCTAssertFalse(rig.owner.isActive, "the circle in the Inbox's header ends the conversation")
    await hold.release()
    let outcome = await started.value
    XCTAssertEqual(outcome, .cancelled, "the end came while the opening list was read")
  }

  /// The spans of `tone` drawn in the navigation bars on screen (one per bar that shows the tone: two circles in one
  /// bar make one span wider than a circle), and the waiting prompt's cards.
  private func shown(_ rig: Rig, tone indicator: VoiceAgentIndicator) throws -> (circles: [CGRect], cards: Int) {
    let pixels = try rig.rendered()
    let tone = Self.rgb(VoiceStatusView.color(indicator.tone), in: rig.window)
    let circles = rig.navigationBars.compactMap { bar in
      Self.circle(in: pixels, around: bar.convert(bar.bounds, to: nil), tone: tone)
    }
    let getter = #selector(getter: UIAccessibilityIdentification.accessibilityIdentifier)
    let cards = InboxScreenTests.elements(in: rig.window).filter { element in
      element.responds(to: getter)
        && element.value(forKey: "accessibilityIdentifier") as? String == "voiceAgent.sessions.bar.prompt"
    }.count
    return (circles, cards)
  }

  /// Catches the circle missing or twice on the way from the Inbox to a session opened from a card and back (the
  /// Inbox's header under the pushed session's, or neither after the pop), and a waiting prompt's card lost or shown
  /// twice.
  func testOnIPhoneTheCircleAndThePromptCardStandOnceFromTheInboxToASessionAndBack() throws {
    InboxScreenTests.enableAccessibility()
    let rig = try Rig(style: .dark)
    defer { rig.close() }
    rig.navigation.openInbox()
    rig.show(Self.prompting(Self.threeLinePrompt))
    let steps: [(String, () -> Void)] = [
      ("the Inbox", {}),
      ("a session opened from a card", { rig.navigation.openSessionFromInbox("p1-a") }),
      ("back on the Inbox", { rig.navigation.compactInboxPopped() }),
    ]
    for (step, move) in steps {
      move()
      ProjectTreeListTests.spin()
      let shown = try shown(rig, tone: .listening)
      XCTAssertEqual(shown.circles.count, 1, "\(step): the circle in one navigation bar: \(shown.circles)")
      XCTAssertLessThanOrEqual(
        shown.circles.first?.width ?? .infinity, VoiceAgentSessionsLitCircle.diameter + 1.5,
        "\(step): one lit circle in that bar, no second beside it: \(shown.circles)")
      XCTAssertEqual(shown.cards, 1, "\(step): one prompt card")
    }
    XCTAssertEqual(rig.navigation.detail, .inbox, "the pop put the Inbox back on the route")
  }

  /// Catches an end sentence over the session screen or the Inbox that stands in a framed bar with a label row
  /// instead of the list header's line, a line under the 44 pt target, a long sentence cut short, and a tap that
  /// does not reach the owner's removal.
  func testOnIPhoneAfterTheEndTheLineStandsAboveTheSessionScreenAndTheInbox() throws {
    InboxScreenTests.enableAccessibility()
    for inbox in [false, true] {
      let place = inbox ? "the Inbox" : "a session screen"
      let rig = try Rig()
      defer { rig.close() }
      if inbox {
        rig.navigation.openInbox()
      } else {
        rig.navigation.openPushTarget(PushTarget(sessionId: "p1-a"), state: rig.store.state)
      }
      rig.show(nil)
      let top = try XCTUnwrap(rig.sessionBarTop, "\(place): the navigation bar")
      let quiet = rig.sessionItemViews.map { $0.convert($0.bounds, to: nil).width }
      let dismissals = Dismissals()
      rig.show(Self.ended) { dismissals.count += 1 }
      let after = rig.sessionItemViews.map { $0.convert($0.bounds, to: nil).width }
      XCTAssertEqual(after.count, quiet.count, "\(place): no circle in the header after the end")
      XCTAssertEqual(
        after.last ?? 0, quiet.last ?? 0, accuracy: 0.5, "\(place): the header's last item as before the conversation")
      let line = try XCTUnwrap(
        InboxScreenTests.element("voiceAgent.sessions.bar.state", in: rig.window), "\(place): the end sentence")
      let frame = line.accessibilityFrame
      let short = frame.height
      XCTAssertGreaterThanOrEqual(short, 43.5, "\(place): the line is a full touch target")
      XCTAssertLessThanOrEqual(short, HeaderMetrics.iconTarget + 0.5, "\(place): one line, no label row over it")
      // The line starts no lower than the navigation bar stood, with no frame's margin over it; the bar stands under
      // it, with the top margin the navigation bar keeps where no status bar stands over it.
      XCTAssertLessThanOrEqual(frame.minY, top + 0.5, "\(place): the line at the top, no frame around it")
      XCTAssertGreaterThanOrEqual(
        try XCTUnwrap(rig.sessionBarTop), frame.maxY - 0.5, "\(place): the screen under the line")
      try InboxScreenTests.activate("voiceAgent.sessions.bar.state", in: rig.window)
      XCTAssertEqual(dismissals.count, 1, "\(place): the tap removes the sentence")

      rig.show(VoiceAgentSessionsBarContent(indicator: .ended(.speechOff), running: false))
      let long = try XCTUnwrap(InboxScreenTests.element("voiceAgent.sessions.bar.state", in: rig.window))
      XCTAssertGreaterThan(long.accessibilityFrame.height, short + 8, "\(place): the long sentence stands whole")
      rig.show(nil)
      XCTAssertEqual(try XCTUnwrap(rig.sessionBarTop), top, accuracy: 0.5, "\(place): the screen back where it was")
    }
  }

  /// Catches a title at the ceiling that, with the circle standing, pushes the whole icon group into the bar's
  /// overflow "⋯", which does not show it: the ceiling reserves three icons and the circle takes one of them.
  func testALongTitleKeepsTheGroupWithTheCircleInTheBar() throws {
    // The phone's bar margins and the right panel's sheet button (the third icon) stand only on an iPhone; run it
    // with `RAROG_IOS_SIMULATOR="iPhone 17 Pro"`, whose screen is the rig's 402 pt window.
    try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .phone, "the phone's navigation bar needs an iPhone")
    let rig = try Rig(terminals: true)
    defer { rig.close() }
    let project = "a-long-project-directory-name-for-the-title-ceiling"
    let session = ProjectTreeListTests.summary("long-a", project, minute: 0)
    let json = #"{"type":"sessions-snapshot","sessions":[\#(session)]}"#
    let event = try EventDecoder.decode(Data(json.utf8)).get().event
    rig.store.dispatch(.frame(event, source: .global, cursor: nil))
    rig.navigation.openPushTarget(PushTarget(sessionId: "long-a"), state: rig.store.state)
    rig.show(nil)
    let quiet = rig.sessionItemViews.map { $0.convert($0.bounds, to: nil) }
    let before = try XCTUnwrap(quiet.last, "the icon group without a conversation: \(quiet)")
    rig.show(Self.listening)
    let items = rig.sessionItemViews.map { $0.convert($0.bounds, to: nil) }
    let title = try XCTUnwrap(items.first)
    let group = try XCTUnwrap(items.last)
    XCTAssertEqual(
      group.width, before.width + HeaderMetrics.iconTarget + HeaderMetrics.iconSpacing, accuracy: 1.5,
      "the whole group stands in the bar with the circle: \(before) → \(group), items \(items)")
    XCTAssertEqual(
      group.width, HeaderMetrics.trailingIconsWidth, accuracy: 1.5,
      "three icons: the circle, Pop-Up Terminal, the panel")
    XCTAssertLessThanOrEqual(
      title.maxX + HeaderMetrics.barItemSpacing, group.minX + 0.5, "the title ends before the group: \(title) \(group)")
    XCTAssertLessThanOrEqual(group.maxX, rig.window.bounds.maxX, "the group inside the window")
    try assertSessionHeaderCircle(rig, .listening, "iPhone, a long title")
  }

  /// The snapshot directory, or a skip without it.
  private func snapshotDirectory() throws -> String {
    guard let dir = ProcessInfo.processInfo.environment["RAROG_VOICE_SESSIONS_SNAPSHOT_DIR"], !dir.isEmpty else {
      throw XCTSkip("RAROG_VOICE_SESSIONS_SNAPSHOT_DIR not set")
    }
    return dir
  }

  private func save(_ rig: Rig, _ name: String, in dir: String) throws {
    try XCTUnwrap(rig.image().pngData(), name).write(to: URL(filePath: dir).appending(path: "\(name).png"))
  }

  /// A session screen with the voice agent and the mode consented, as the user meets it.
  private func consented(regular: Bool = false) throws -> Rig {
    let rig = try Rig(style: .dark, regular: regular, terminals: true)
    rig.store.voiceAgent.acceptConsent()
    rig.store.voiceAgent.acceptSessionsConsent()
    rig.navigation.openPushTarget(PushTarget(sessionId: "p1-a"), state: rig.store.state)
    return rig
  }

  /// The iPhone session screen while the conversation runs, with a waiting prompt, and after the end (a phone
  /// picture with `RAROG_IOS_SIMULATOR="iPhone 17 Pro"`).
  func testSessionHeaderScreenshotsPhone() throws {
    let dir = try snapshotDirectory()
    let phone = try consented()
    phone.owner.levels = RealtimeLevels(input: 0.3, output: 0)
    phone.show(Self.listening)
    try save(phone, "session-header-running-dark", in: dir)
    phone.show(Self.prompting(Self.threeLinePrompt))
    try save(phone, "session-header-prompt-dark", in: dir)
    phone.show(VoiceAgentSessionsBarContent(indicator: .ended(.speechOff), running: false))
    try save(phone, "session-header-ended-dark", in: dir)
    phone.close()
  }

  /// The Inbox at the root of the iPhone's stack while the conversation runs, with a waiting prompt, and after the end
  /// with the long sentence (a phone picture with `RAROG_IOS_SIMULATOR="iPhone 17 Pro"`).
  func testInboxHeaderScreenshotsPhone() throws {
    let dir = try snapshotDirectory()
    let phone = try Rig(style: .dark, terminals: true)
    defer { phone.close() }
    phone.store.voiceAgent.acceptConsent()
    phone.store.voiceAgent.acceptSessionsConsent()
    phone.navigation.openInbox()
    phone.owner.levels = RealtimeLevels(input: 0.3, output: 0)
    phone.show(Self.listening)
    try save(phone, "inbox-header-running-dark", in: dir)
    phone.show(Self.prompting(Self.threeLinePrompt))
    try save(phone, "inbox-header-prompt-dark", in: dir)
    phone.show(VoiceAgentSessionsBarContent(indicator: .ended(.speechOff), running: false))
    try save(phone, "inbox-header-ended-dark", in: dir)
  }

  /// iPad: the list column hidden (the circle in the session header), then both columns (in the list header only).
  func testSessionHeaderScreenshotsPad() throws {
    let dir = try snapshotDirectory()
    // One rig per picture: the list column shown again after a hide slides in and misses the render.
    for hidden in [true, false] {
      let pad = try consented(regular: true)
      defer { pad.close() }
      pad.owner.levels = RealtimeLevels(input: 0.3, output: 0)
      pad.navigation.setListCollapsed(hidden)
      pad.show(Self.listening)
      try save(pad, hidden ? "session-header-ipad-list-hidden-dark" : "session-header-ipad-both-columns-dark", in: dir)
    }
  }
}
