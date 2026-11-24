import RarogContract
@testable import RarogCore
import RarogTransport
@testable import RarogUI
import SwiftUI
import UIKit
import XCTest

/// The voice conversation across sessions over the real split view (`MainSplitView` with
/// `VoiceAgentSessionsBarSlot`, as the root mounts it), with a fixed state: on the list screen the header keeps
/// "AGENTS (N)" and the lit circle stands in place of the waveform glyph, in the state's tone with bars in the
/// background colour that follow the levels, so the list does not move; over a session screen and the Inbox at the
/// root of the iPhone's stack the lit circle stands in that screen's header
/// (`VoiceAgentSessionsBarTests+SessionHeader.swift`), and above the navigation bar stand only a waiting prompt's card
/// and the end sentence's line; the screen under them is not rebuilt when they or the strip under the header come and
/// go; the circle has a 44 pt target. With
/// `RAROG_VOICE_SESSIONS_SNAPSHOT_DIR` (`TEST_RUNNER_RAROG_VOICE_SESSIONS_SNAPSHOT_DIR` for `xcodebuild`)
/// `testScreenshots` writes the PNGs for review: the lit circle on an iPhone-wide list in both themes, the iPad list
/// column in each state (connecting, listening, answering, a waiting prompt, after the end), the strip with a
/// 1000-character waiting prompt (at its top and scrolled to its end), and the mode's consent page;
/// `testSessionHeaderScreenshots` writes the session screen's header. All data is synthetic
/// (`ProjectTreeListTests.store()`). Owner: voice agent.
@MainActor
final class VoiceAgentSessionsBarTests: XCTestCase {
  /// The split view of the app in a window, with the conversation's content set by the test.
  @MainActor
  final class Rig {
    let store: RarogStore
    let navigation = RarogNavigation(prefs: MemoryPreferences())
    let owner: VoiceAgentSessionsConversation
    let window: UIWindow
    let host: UIHostingController<AnyView>
    private let toasts = ToastCenter()
    private let drafts = ComposerDrafts()
    private let memory = ConnectionMemory()
    private let transcriptLink = TranscriptConnectionMemory()

    /// - Parameter terminals: the server offers terminals, so the session header has Pop-Up Terminal.
    /// - Parameter transport: the routes the store calls (default: a client of a closed local port).
    init(
      style: UIUserInterfaceStyle = .light, regular: Bool = false, terminals: Bool = false,
      transport: UIKitTransport? = nil
    ) throws {
      store = try ProjectTreeListTests.store(transport: transport)
      // The server offers the voice agent with Soniox speech and the mode across sessions.
      let version = #"{"version":"0.1.0","protocolVersion":3,"serverStartId":"test","companionEnabled":true,"#
        + (terminals ? #""termEnabled":true,"# : "")
        + #""companionSpeech":true,"companionSessions":true,"capabilities":["companion-sessions"]}"#
      store.dispatch(.versionProbed(try JSONDecoder().decode(VersionInfo.self, from: Data(version.utf8))))
      owner = VoiceAgentSessionsConversation(
        backend: store, settings: store.voiceAgent, sonioxAllowed: true, microphone: DictationCenter(),
        dependencies: { keys in
          .production(
            keys: keys, audio: VoiceChatAudio(), scheduler: TaskVoiceScheduler(),
            speech: RealtimeConversation.Speech(keys: keys))
        })
      host = UIHostingController(rootView: AnyView(EmptyView()))
      let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
      window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow()
      window.frame = CGRect(x: 0, y: 0, width: regular ? 1180 : 402, height: regular ? 820 : 874)
      window.overrideUserInterfaceStyle = style
      window.traitOverrides.horizontalSizeClass = regular ? .regular : .compact
      window.rootViewController = host
      window.makeKeyAndVisible()
    }

    /// Shows the split view with the conversation's `content` (`nil` = none); `dismiss` stands for the owner's
    /// removal of the end sentence.
    func show(_ content: VoiceAgentSessionsBarContent?, dismiss: @escaping @MainActor @Sendable () -> Void = {}) {
      host.rootView = AnyView(
        MainSplitView(
          store: store, navigation: navigation, memory: memory, transcriptLink: transcriptLink, drafts: drafts)
          .modifier(VoiceAgentSessionsBarSlot(content: content, navigation: navigation, dismiss: dismiss))
          .environment(navigation)
          .environment(toasts)
          .environment(owner))
      ProjectTreeListTests.spin()
    }

    func close() { window.isHidden = true }

    /// The top of the highest visible navigation bar, in window coordinates.
    var barTop: CGFloat? { barTops.min() }

    /// The tops of the visible navigation bars (the list and, beside it, the detail), in window coordinates.
    var barTops: [CGFloat] {
      navigationBars.map { $0.convert($0.bounds, to: nil).minY }
    }

    var navigationBars: [UINavigationBar] {
      ProjectTreeListTests.views(UINavigationBar.self, in: window).filter { bar in
        !bar.isHidden && bar.window != nil && bar.convert(bar.bounds, to: nil).intersects(window.bounds)
      }
    }

    /// The hosts of the list bar's items, from the leading edge: the header line (`.principal`), then the group of
    /// the waveform or the lit circle, New Session and Settings. The accessibility tree of the navigation bar is not
    /// built in this window, so the test reads the hosts' frames. The list's bar is the one that ends first: on iPad
    /// the session screen's bar starts at the window's edge too, under the list column, and ends at the other edge.
    var barItemViews: [UIView] {
      let trailing = { (bar: UINavigationBar) in bar.convert(bar.bounds, to: nil).maxX }
      guard let bar = navigationBars.min(by: { trailing($0) < trailing($1) }) else { return [] }
      return ProjectTreeListTests.views(UIView.self, in: bar)
        .filter { String(describing: type(of: $0)).hasPrefix("UIKitBarItemHost") }
        .sorted { $0.convert($0.bounds, to: nil).minX < $1.convert($1.bounds, to: nil).minX }
    }

    var barItems: [CGRect] { barItemViews.map { $0.convert($0.bounds, to: nil) } }

    /// The session screen's navigation bar: the one that ends last (on iPad it reaches the window's far edge, beside
    /// the list's bar; on iPhone with a session on top it is the only one on screen).
    var sessionBar: UINavigationBar? {
      navigationBars.max { $0.convert($0.bounds, to: nil).maxX < $1.convert($1.bounds, to: nil).maxX }
    }

    /// The hosts of the session bar's items from the leading edge: the title (with the list toggle on iPad), then
    /// the icon group of the top right corner.
    var sessionItemViews: [UIView] {
      guard let bar = sessionBar else { return [] }
      return ProjectTreeListTests.views(UIView.self, in: bar)
        .filter { String(describing: type(of: $0)).hasPrefix("UIKitBarItemHost") }
        .sorted { $0.convert($0.bounds, to: nil).minX < $1.convert($1.bounds, to: nil).minX }
    }

    /// The session header's icon group (the last item host), in window coordinates.
    var sessionGroup: CGRect? { sessionItemViews.last.map { $0.convert($0.bounds, to: nil) } }

    /// The top of the session screen's navigation bar, in window coordinates.
    var sessionBarTop: CGFloat? { sessionBar.map { $0.convert($0.bounds, to: nil).minY } }

    /// The top of the list's first row, in window coordinates: it moves when something stands over the list.
    var firstRowTop: CGFloat? {
      ProjectTreeListTests.views(UICollectionViewCell.self, in: window)
        .filter { !$0.isHidden && $0.window != nil }
        .map { $0.convert($0.bounds, to: nil).minY }
        .min()
    }

    func image() -> UIImage {
      window.layoutIfNeeded()
      return UIGraphicsImageRenderer(bounds: window.bounds).image { context in
        window.layer.render(in: context.cgContext)
      }
    }

    /// The window's render as sRGB pixels.
    func rendered() throws -> RenderedPixels {
      let image = image()
      return try XCTUnwrap(image.cgImage.flatMap { RenderedPixels($0, scale: image.scale) }, "bitmap")
    }

    /// The window's pixels in `rect` (points), to compare two renders of one place.
    func pixels(_ rect: CGRect) throws -> Data {
      let image = image()
      let scaled = CGRect(
        x: rect.minX * image.scale, y: rect.minY * image.scale, width: rect.width * image.scale,
        height: rect.height * image.scale)
      let crop = try XCTUnwrap(image.cgImage?.cropping(to: scaled.integral), "crop")
      return try XCTUnwrap(UIImage(cgImage: crop).pngData(), "PNG")
    }
  }

  /// `color` as the window draws it, in the 0xRRGGBB form of `RenderedPixels`.
  static func rgb(_ color: UIColor, in window: UIWindow) -> UInt32 {
    var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
    color.resolvedColor(with: window.traitCollection).getRed(&r, green: &g, blue: &b, alpha: &a)
    let byte = { (value: CGFloat) in UInt32(min(255, max(0, (value * 255).rounded()))) }
    return byte(r) << 16 | byte(g) << 8 | byte(b)
  }

  /// The lit circle around the buttons' item `group`: the run of `tone` pixels through the item's middle row gives
  /// its width and centre, the run through that centre's column its height (the middle bar inside is skipped, since
  /// only the outermost tone pixels count). `nil` = no pixel of the tone there.
  static func circle(in pixels: RenderedPixels, around group: CGRect, tone: UInt32) -> CGRect? {
    let margin: CGFloat = 12
    let step = 1 / pixels.scale
    func hits(_ points: [CGPoint]) -> [CGPoint] {
      points.filter { RenderedPixels.distance(pixels.color(at: $0), tone) <= 12 }
    }
    let row = hits(stride(from: max(0, group.minX - margin), to: group.maxX + margin, by: step)
      .map { CGPoint(x: $0, y: group.midY) })
    guard let left = row.first?.x, let right = row.last?.x else { return nil }
    let centre = (left + right + step) / 2
    let column = hits(stride(from: max(0, group.minY - margin), to: group.maxY + margin, by: step)
      .map { CGPoint(x: centre, y: $0) })
    guard let top = column.first?.y, let bottom = column.last?.y else { return nil }
    return CGRect(x: left, y: top, width: right - left + step, height: bottom - top + step)
  }

  /// Catches a circle in another colour than the state's (the iPad list column's bar draws a filled SwiftUI shape
  /// white whatever its colour, iOS 27), bars that lose the background colour the same way, a circle squeezed or
  /// grown by the bar, and a touch on it that does not reach the buttons' item.
  func testTheLitCircleTakesTheStatesToneWithBarsInTheBackground() throws {
    for regular in [false, true] {
      let place = regular ? "iPad list column" : "iPhone"
      let rig = try Rig(style: .dark, regular: regular)
      defer { rig.close() }
      if regular { rig.navigation.openPushTarget(PushTarget(sessionId: "p1-a"), state: rig.store.state) }
      rig.show(VoiceAgentSessionsBarContent(indicator: .connecting, running: true))
      let group = try XCTUnwrap(rig.barItems.last, "\(place): the buttons' item")
      let pixels = try rig.rendered()
      let tone = Self.rgb(VoiceStatusView.color(VoiceAgentIndicator.connecting.tone), in: rig.window)
      let circle = try XCTUnwrap(
        Self.circle(in: pixels, around: group, tone: tone), "\(place): the state's tone in the buttons' item")
      let diameter = VoiceAgentSessionsLitCircle.diameter
      XCTAssertEqual(circle.width, diameter, accuracy: 1.5, "\(place): the circle's width \(circle)")
      XCTAssertEqual(circle.height, diameter, accuracy: 1.5, "\(place): the circle's height \(circle)")
      let bar = pixels.color(at: CGPoint(x: circle.midX, y: circle.midY))
      let background = Self.rgb(Palette.background, in: rig.window)
      XCTAssertLessThanOrEqual(
        RenderedPixels.distance(bar, background), 12,
        "\(place): the middle bar in the background colour, "
          + "\(String(bar, radix: 16)) vs \(String(background, radix: 16))")
      let host = try XCTUnwrap(rig.barItemViews.last)
      let touched = try XCTUnwrap(rig.window.hitTest(CGPoint(x: circle.midX, y: circle.midY), with: nil))
      XCTAssertTrue(touched.isDescendant(of: host), "\(place): a touch on the circle lands in the buttons' item")
    }
  }

  /// Catches bars that stand still while the conversation's levels change: the owner's levels do not reach the view
  /// inside the toolbar item.
  func testTheBarsInTheCircleFollowTheLevels() throws {
    let rig = try Rig()
    defer { rig.close() }
    rig.show(Self.listening)
    let group = try XCTUnwrap(rig.barItems.last)
    let quiet = try rig.pixels(group)
    ProjectTreeListTests.spin()
    XCTAssertEqual(try rig.pixels(group), quiet, "the same levels draw the same bars")
    rig.owner.levels = RealtimeLevels(input: 0.4, output: 0)
    ProjectTreeListTests.spin()
    XCTAssertNotEqual(try rig.pixels(group), quiet, "a louder microphone raises the bars")
  }

  func testTheLitCircleHasAFullTouchTarget() {
    let circle = UIHostingController(rootView: VoiceAgentSessionsLitCircle(indicator: .listening, owner: nil) {})
    let size = circle.sizeThatFits(in: CGSize(width: 1000, height: 1000))
    XCTAssertGreaterThanOrEqual(min(size.width, size.height), 44, "the circle's target: \(size)")
    XCTAssertLessThan(VoiceAgentSessionsLitCircle.diameter, min(size.width, size.height), "the circle inside it")
  }

  static let listening = VoiceAgentSessionsBarContent(indicator: .listening, running: true)
  static let ended = VoiceAgentSessionsBarContent(indicator: .closed(.background), running: false)

  /// The waiting prompt's card's own height above the screen at the window's width (a hosting controller of the card
  /// alone).
  func barHeight(_ content: VoiceAgentSessionsBarContent, width: CGFloat) -> CGFloat {
    let bar = UIHostingController(rootView: VoiceAgentSessionsBar(content: content))
    return bar.sizeThatFits(in: CGSize(width: width, height: 1000)).height
  }

  /// Catches an end sentence cut short in the narrow list column: a sentence that says how to fix the end (the
  /// speech key) takes more than two lines there, and the tap that would show the rest removes the line.
  func testALongEndSentenceStandsWholeUnderTheHeader() throws {
    let rig = try Rig(regular: true)
    defer { rig.close() }
    rig.show(Self.ended)
    let shortTop = try XCTUnwrap(rig.firstRowTop)
    rig.show(VoiceAgentSessionsBarContent(indicator: .ended(.speechOff), running: false))
    XCTAssertGreaterThan(try XCTUnwrap(rig.firstRowTop), shortTop + 8, "the third line moves the list down")
    if let dir = ProcessInfo.processInfo.environment["RAROG_VOICE_SESSIONS_SNAPSHOT_DIR"], !dir.isEmpty {
      try XCTUnwrap(rig.image().pngData())
        .write(to: URL(filePath: dir).appending(path: "list-header-ended-long-ipad.png"))
    }
  }

  /// Catches a bar stacked over the list whose header carries the conversation (the list pushed down, the state
  /// twice), a title swapped for the state, a lit circle that widens the buttons' item over New Session or moves New
  /// Session and Settings, and a bar over a session pushed over the list, whose header carries the lit circle.
  func testTheListHeaderKeepsItsTitleAndNoBarStandsOverASession() throws {
    let rig = try Rig()
    defer { rig.close() }
    rig.show(nil)
    let listTop = try XCTUnwrap(rig.barTop, "the list's navigation bar")
    let rowTop = try XCTUnwrap(rig.firstRowTop, "the list's first row")
    let glyphs = try XCTUnwrap(rig.barItems.last, "the list bar's buttons with the waveform glyph")
    let line = try XCTUnwrap(rig.barItems.first, "the header line")
    let title = try rig.pixels(line)

    rig.show(Self.listening)
    XCTAssertEqual(try XCTUnwrap(rig.barTop), listTop, accuracy: 0.5, "no bar over the list")
    XCTAssertEqual(try XCTUnwrap(rig.firstRowTop), rowTop, accuracy: 0.5, "the list does not move down")
    let items = rig.barItems
    XCTAssertEqual(items.count, 2, "the header line and the buttons: \(items)")
    let running = try XCTUnwrap(items.first)
    let group = try XCTUnwrap(items.last)
    XCTAssertEqual(group.width, glyphs.width, accuracy: 1, "the circle takes the glyph's target")
    XCTAssertEqual(group.maxX, glyphs.maxX, accuracy: 1, "New Session and Settings keep their places")
    XCTAssertEqual(running, line, "the header line keeps its frame")
    XCTAssertEqual(try rig.pixels(running), title, "AGENTS (N) stands unchanged while the conversation runs")

    rig.navigation.openPushTarget(PushTarget(sessionId: "p1-a"), state: rig.store.state)
    ProjectTreeListTests.spin()
    XCTAssertTrue(rig.navigation.compactShowsDetail, "the session screen on top")
    XCTAssertEqual(
      try XCTUnwrap(rig.barTop), listTop, accuracy: 0.5, "no bar over the session screen while it only runs")

    rig.navigation.compactReturnedToList()
    ProjectTreeListTests.spin()
    XCTAssertEqual(try XCTUnwrap(rig.barTop), listTop, accuracy: 1, "back on the list the header carries it again")
  }

  /// Catches an end sentence with no place on the list screen, a waiting prompt whose card does not stand over the
  /// list, and a strip that rebuilds the list under it.
  func testTheStripUnderTheHeaderShowsTheEndSentenceAndTheWaitingPrompt() throws {
    let rig = try Rig()
    defer { rig.close() }
    rig.show(nil)
    let list = try XCTUnwrap(ProjectTreeListTests.views(UICollectionView.self, in: rig.window).first)
    let listTop = try XCTUnwrap(rig.barTop)
    let rowTop = try XCTUnwrap(rig.firstRowTop)
    let glyphs = try XCTUnwrap(rig.barItems.last)

    rig.show(Self.ended)
    XCTAssertEqual(try XCTUnwrap(rig.barTop), listTop, accuracy: 0.5, "no bar over the list")
    let endedTop = try XCTUnwrap(rig.firstRowTop)
    // The tap on the line removes it, so the line is a full touch target.
    XCTAssertGreaterThanOrEqual(endedTop, rowTop + 43.5, "the end sentence's line stands over the list, 44 pt high")
    XCTAssertEqual(try XCTUnwrap(rig.barItems.last).width, glyphs.width, accuracy: 1, "the glyph is back")

    rig.show(Self.prompting(Self.threeLinePrompt))
    XCTAssertGreaterThan(try XCTUnwrap(rig.firstRowTop), endedTop + 40, "the prompt's card stands over the list")
    XCTAssertTrue(
      ProjectTreeListTests.views(UICollectionView.self, in: rig.window).contains { $0 === list },
      "the same list under the strip")
  }

  func testTheSessionScreenIsNotRebuiltWhenTheBarComesAndGoes() throws {
    let rig = try Rig()
    defer { rig.close() }
    rig.navigation.openPushTarget(PushTarget(sessionId: "p1-a"), state: rig.store.state)
    rig.show(nil)
    let navigationBar = try XCTUnwrap(rig.navigationBars.first)
    for content in [Self.prompting(Self.threeLinePrompt), nil, Self.listening, Self.ended, nil] {
      rig.show(content)
      XCTAssertTrue(
        ProjectTreeListTests.views(UINavigationBar.self, in: rig.window).contains { $0 === navigationBar },
        "the same session screen with \(String(describing: content))")
    }
  }

  static func prompting(_ text: String) -> VoiceAgentSessionsBarContent {
    VoiceAgentSessionsBarContent(
      indicator: .listening, running: true, prompt: VoiceAgentShownPrompt(project: "atlas", name: "demo", text: text))
  }

  static let threeLinePrompt = "Run the **unit tests** for the parser\nthen list the failing cases\nand stop there"

  static func longPrompt(_ count: Int) -> String {
    String(String(repeating: "Check the export settings and write a short summary of each option. ", count: 40)
      .prefix(count))
  }

  /// Catches a prompt card that grows with its text: a long prompt would push the screen under the card off an
  /// iPhone, so past its visible lines the card scrolls inside instead of getting taller.
  func testThePromptCardStopsGrowingPastItsVisibleLines() {
    let short = barHeight(Self.prompting(Self.threeLinePrompt), width: 402)
    let long = barHeight(Self.prompting(Self.longPrompt(1000)), width: 402)
    let longer = barHeight(Self.prompting(Self.longPrompt(2000)), width: 402)
    XCTAssertGreaterThan(long, short, "a long prompt shows more lines than a three-line one")
    XCTAssertEqual(longer, long, accuracy: 0.5, "past the visible lines the card keeps its height")
  }

  func testScreenshots() throws {
    guard let dir = ProcessInfo.processInfo.environment["RAROG_VOICE_SESSIONS_SNAPSHOT_DIR"], !dir.isEmpty else {
      throw XCTSkip("RAROG_VOICE_SESSIONS_SNAPSHOT_DIR not set")
    }
    func save(_ image: UIImage, _ name: String) throws {
      try XCTUnwrap(image.pngData(), name).write(to: URL(filePath: dir).appending(path: "\(name).png"))
    }
    // The lit circle on an iPhone-wide list in both themes, the microphone at a speaking level.
    for style in [UIUserInterfaceStyle.dark, .light] {
      let phone = try Rig(style: style)
      phone.store.voiceAgent.acceptConsent()
      phone.store.voiceAgent.acceptSessionsConsent()
      phone.owner.levels = RealtimeLevels(input: 0.3, output: 0)
      phone.show(Self.listening)
      try save(phone.image(), "list-header-listening-\(style == .dark ? "dark" : "light")")
      phone.close()
    }
    // The list column beside a session on iPad, in each state.
    let pad = try Rig(regular: true)
    pad.store.voiceAgent.acceptConsent()
    pad.store.voiceAgent.acceptSessionsConsent()
    pad.navigation.openPushTarget(PushTarget(sessionId: "p1-a"), state: pad.store.state)
    let states: [(String, VoiceAgentSessionsBarContent, RealtimeLevels)] = [
      ("connecting", VoiceAgentSessionsBarContent(indicator: .connecting, running: true), .zero),
      ("listening", Self.listening, RealtimeLevels(input: 0.3, output: 0)),
      ("answering", VoiceAgentSessionsBarContent(indicator: .answering, running: true),
       RealtimeLevels(input: 0, output: 0.3)),
      ("prompt", Self.prompting(Self.threeLinePrompt), RealtimeLevels(input: 0.2, output: 0)),
      ("ended", Self.ended, .zero),
    ]
    for (name, content, levels) in states {
      pad.owner.levels = levels
      pad.show(content)
      try save(pad.image(), "list-header-ipad-\(name)")
    }
    pad.close()

    let rig = try Rig()
    rig.show(Self.prompting(Self.longPrompt(1000)))
    try save(rig.image(), "list-header-prompt-long")
    // The same card scrolled to the end: the fade lies over the empty margin under the last line.
    let rowTop = rig.firstRowTop ?? 0
    let card = ProjectTreeListTests.views(UIScrollView.self, in: rig.window)
      .filter { !($0 is UICollectionView) && $0.convert($0.bounds, to: nil).maxY < rowTop }
    for scroll in card {
      let end = scroll.contentSize.height + scroll.adjustedContentInset.bottom - scroll.bounds.height
      scroll.setContentOffset(CGPoint(x: 0, y: max(0, end)), animated: false)
    }
    ProjectTreeListTests.spin()
    try save(rig.image(), "list-header-prompt-long-end")
    rig.close()

    let consent = try Rig()
    consent.store.voiceAgent.acceptConsent()
    consent.host.rootView = AnyView(
      VoiceAgentSessionsConsentSheet(
        settings: consent.store.voiceAgent, request: VoiceAgentSessionsConsentRequest(), close: {}, start: {}))
    ProjectTreeListTests.spin()
    try save(consent.image(), "voice-sessions-consent")
    consent.close()
  }
}
