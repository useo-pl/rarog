import RarogActivity
import SwiftUI
import UIKit
import XCTest

/// The voice Live Activity's views from `RarogActivity`, rendered with `ImageRenderer` on black in the dark theme, as
/// the `RarogWidgets` extension shows them. The tests keep the Lock Screen tile under 90 pt at the default type size
/// (also with names at their ceiling and the prompt's answer), stop it growing past its type limit, and check it
/// carries its phase's colour; they also find the buttons each phase offers on the tile and in the expanded Dynamic
/// Island, by their VoiceOver labels in a window. With `RAROG_VOICE_LA_SNAPSHOT_DIR`
/// (`TEST_RUNNER_RAROG_VOICE_LA_SNAPSHOT_DIR` for `xcodebuild`) they write the tile of each state as a PNG; without
/// it they only check. Owner: voice agent.
@MainActor
final class VoiceActivityViewTests: XCTestCase {
  typealias State = VoiceActivityAttributes.ContentState

  /// The tile's states, each with the name of its PNG.
  static let states: [(State, String)] = {
    let started = Date(timeIntervalSinceNow: -42)
    func state(
      _ kind: State.Kind, _ phase: State.Phase, _ scope: State.Scope, _ names: (String, String)?,
      stoppedAt: Date? = nil
    ) -> State {
      State(
        kind: kind, phase: phase, scope: scope, project: names?.0, name: names?.1, startedAt: started,
        stoppedAt: stoppedAt)
    }
    // A send turns stale 30 s after its press; a failure stopped the timer at its outcome.
    let stale = Date(timeIntervalSinceNow: 30)
    let outcome = Date(timeIntervalSinceNow: -2)
    let long = String(repeating: "atlas ", count: 20)
    return [
      (state(.conversation, .listening, .allSessions, nil), "listening-all-sessions"),
      (state(.conversation, .answering, .session, ("atlas", "demo")), "answering-session"),
      (state(.conversation, .reading, .session, ("atlas", "demo")), "reading-session"),
      (state(.conversation, .prompt, .session, ("atlas", "demo")), "prompt-waiting"),
      (state(.dictation, .dictating, .session, ("atlas", "demo")), "dictation-session"),
      (state(.conversation, .answering, .session, nil), "answering-no-names"),
      (state(.conversation, .prompt, .session, (long, long)), "prompt-names-at-ceiling"),
      (state(.dictation, .sending, .session, ("atlas", "demo"), stoppedAt: stale), "dictation-sending"),
      (state(.dictation, .notSent, .session, ("atlas", "demo"), stoppedAt: outcome), "dictation-not-sent"),
      (state(.dictation, .unconfirmed, .session, ("atlas", "demo"), stoppedAt: outcome), "dictation-not-confirmed"),
    ]
  }()

  /// Catches a tile that leaves its row at the default type size (a wrapped word, a fourth line, a subject that
  /// wraps instead of truncating), in every state.
  func testTileStaysUnder90PointsAtTheDefaultTypeSize() throws {
    for (state, name) in Self.states {
      let tile = try render(lockScreen(VoiceActivityPresentation(state)), name: "voice-tile-\(name)")
      XCTAssertLessThanOrEqual(tile.height, 180, "\(name): \(tile.height / 2) pt > 90 pt")
      print("voice-activity: tile \(name) at .large = \(tile.height / 2) pt")
    }
  }

  /// Catches a tile whose type keeps growing past its limit: from `.xxLarge` up it has the height it has at the
  /// limit, which stays inside the 160 pt the system leaves a Lock Screen tile.
  func testTileStopsGrowingAtItsTypeLimit() throws {
    for (state, name) in Self.states {
      let presentation = VoiceActivityPresentation(state)
      let limit = try render(
        lockScreen(presentation).environment(\.dynamicTypeSize, VoiceActivityPresentation.maxTypeSize),
        name: "voice-tile-\(name)-limit")
      XCTAssertLessThanOrEqual(limit.height, 320, "\(name) at the limit: \(limit.height / 2) pt > 160 pt")
      for size in [DynamicTypeSize.xxLarge, .accessibility3] {
        let large = try render(
          lockScreen(presentation).environment(\.dynamicTypeSize, size), name: "voice-tile-\(name)")
        XCTAssertEqual(large.height, limit.height, "\(name) at \(size)")
      }
      print("voice-activity: tile \(name) at the limit = \(limit.height / 2) pt")
    }
  }

  /// Catches a view that draws in a fixed colour instead of its phase's (the glyph): each tile carries its own tone
  /// and none of the other tones of the voice agent's status.
  func testTileCarriesThePhaseColour() throws {
    let tones = [LiveActivityPalette.runPair.dark, LiveActivityPalette.newPair.dark, LiveActivityPalette.waitPair.dark]
    for (state, name) in Self.states {
      let presentation = VoiceActivityPresentation(state)
      let tile = try render(lockScreen(presentation), name: "voice-tile-\(name)")
      let own = tile.count(of: presentation.tint)
      XCTAssertGreaterThan(own, 40, "\(name): its colour")
      for other in tones where other != presentation.tint {
        XCTAssertEqual(tile.count(of: other), 0, "\(name): not another phase's colour")
      }
      print("voice-activity: tile \(name) has \(own) pixels of its colour")
    }
  }

  /// Catches a dictation tile that grows to make room for its second button: the dictation tile with Stop and Send
  /// is as tall as the conversation tile with its one End.
  func testDictationTileKeepsTheConversationTileHeight() throws {
    let started = Date(timeIntervalSinceNow: -42)
    let conversation = try render(
      lockScreen(VoiceActivityPresentation(
        State(kind: .conversation, phase: .answering, scope: .session, project: "atlas", name: "demo",
              startedAt: started))),
      name: "voice-tile-conversation")
    let dictation = try render(
      lockScreen(VoiceActivityPresentation(
        State(kind: .dictation, phase: .dictating, scope: .session, project: "atlas", name: "demo",
              startedAt: started))),
      name: "voice-tile-dictation")
    XCTAssertEqual(dictation.height, conversation.height)
  }

  /// Catches a dictation that offers only Stop, a conversation that gains Send, and a tile that keeps a button
  /// while it sends or after the send failed (the view used to draw its button in every phase): the buttons
  /// VoiceOver finds on the Lock Screen tile and in the expanded Dynamic Island, in their order.
  func testButtonsByPhase() async throws {
    let started = Date(timeIntervalSinceNow: -42)
    func presentation(_ kind: State.Kind, _ phase: State.Phase) -> VoiceActivityPresentation {
      VoiceActivityPresentation(
        State(kind: kind, phase: phase, scope: .session, project: "atlas", name: "demo", startedAt: started))
    }
    let dictating = presentation(.dictation, .dictating)
    let cases: [(VoiceActivityPresentation, [String], String)] = [
      (presentation(.conversation, .listening), [presentation(.conversation, .listening).endWord], "conversation"),
      (dictating, [dictating.endWord, dictating.sendWord], "dictating"),
      (presentation(.dictation, .sending), [], "sending"),
      (presentation(.dictation, .notSent), [], "not sent"),
      (presentation(.dictation, .unconfirmed), [], "not confirmed"),
    ]
    for (presentation, labels, name) in cases {
      let tile = try await buttonLabels(in: lockScreen(presentation))
      XCTAssertEqual(tile, labels, "\(name): Lock Screen tile")
      let island = try await buttonLabels(
        in: VoiceActivityExpandedBottom(presentation: presentation, activityID: "voice-1")
          .frame(width: 364).background(Color.black).environment(\.colorScheme, .dark))
      XCTAssertEqual(island, labels, "\(name): expanded Dynamic Island")
    }
  }

  /// Catches a send tile that keeps saying "Sending…" once its state is stale (the app's process stopped before the
  /// outcome): it reads and looks like "Not confirmed", in the error tone without the waiting amber, and has no
  /// button.
  func testStaleSendingTileShowsNotConfirmed() async throws {
    let started = Date(timeIntervalSinceNow: -42)
    func state(_ phase: State.Phase) -> State {
      State(kind: .dictation, phase: phase, scope: .session, project: "atlas", name: "demo", startedAt: started)
    }
    let stale = VoiceActivityPresentation(state(.sending), isStale: true)
    let unconfirmed = VoiceActivityPresentation(state(.unconfirmed))
    let labels = try await textLabels(in: lockScreen(stale))
    let unconfirmedLabels = try await textLabels(in: lockScreen(unconfirmed))
    XCTAssertEqual(labels, unconfirmedLabels)
    XCTAssertTrue(labels.contains(unconfirmed.spoken), "\(labels)")
    let buttons = try await buttonLabels(in: lockScreen(stale))
    XCTAssertEqual(buttons, [])
    let tile = try render(lockScreen(stale), name: "voice-tile-sending-stale")
    XCTAssertGreaterThan(tile.count(of: LiveActivityPalette.errPair.dark), 40, "the error tone")
    XCTAssertEqual(tile.count(of: LiveActivityPalette.waitPair.dark), 0, "not the waiting amber")
  }

  /// Catches swapped intents (the square that sends, the arrow that stops) and a button that does not say which
  /// activity it stands on (the app would act on a recording started since): VoiceOver's activation of each button
  /// of a recording dictation, and of a conversation's End, reaches only its own intent's handler, with the id of the
  /// tile's activity.
  func testEachButtonRunsItsOwnIntentForItsActivity() async throws {
    let (end, send) = (EndVoiceActivityIntent.handler, SendDictationActivityIntent.handler)
    defer { (EndVoiceActivityIntent.handler, SendDictationActivityIntent.handler) = (end, send) }
    let runs = Runs()
    EndVoiceActivityIntent.handler = { id in runs.names.append("stop \(id ?? "-")") }
    SendDictationActivityIntent.handler = { id in runs.names.append("send \(id ?? "-")") }
    func presentation(_ kind: State.Kind, _ phase: State.Phase) -> VoiceActivityPresentation {
      VoiceActivityPresentation(
        State(kind: kind, phase: phase, scope: .session, project: "atlas", name: "demo", startedAt: .now))
    }
    let dictating = presentation(.dictation, .dictating)
    let conversation = presentation(.conversation, .listening)
    let cases = [
      (dictating, dictating.sendWord, "send voice-7"), (dictating, dictating.endWord, "stop voice-7"),
      (conversation, conversation.endWord, "stop voice-7"),
    ]
    for (presentation, label, run) in cases {
      runs.names = []
      try await withElements(of: lockScreen(presentation, activityID: "voice-7")) { elements in
        let button = try XCTUnwrap(
          elements.first { $0.accessibilityTraits.contains(.button) && $0.accessibilityLabel == label }, label)
        XCTAssertTrue(button.accessibilityActivate(), "\(label) activates")
        for _ in 0..<40 where runs.names.isEmpty { try await Task.sleep(for: .milliseconds(50)) }
      }
      XCTAssertEqual(runs.names, [run], label)
    }
  }

  /// Catches a Send intent that skips the app's handler, runs it twice, loses its activity's id, or fails without a
  /// handler (no app wiring).
  func testSendIntentRunsTheHandlerOnce() async throws {
    let saved = SendDictationActivityIntent.handler
    defer { SendDictationActivityIntent.handler = saved }
    let runs = Runs()
    SendDictationActivityIntent.handler = { id in runs.names.append("send \(id ?? "-")") }
    _ = try await SendDictationActivityIntent(activityID: "voice-3").perform()
    XCTAssertEqual(runs.names, ["send voice-3"])
    SendDictationActivityIntent.handler = nil
    _ = try await SendDictationActivityIntent(activityID: "voice-3").perform()
  }

  /// Catches a failure tile whose timer keeps counting after the send failed: rendered twice a second and a half
  /// apart, a tile stopped at its outcome (also a stale send, stopped at its stale date) looks the same, while the
  /// timer of a recording dictation moved.
  func testTimerStopsAtTheStateStop() async throws {
    let started = Date(timeIntervalSinceNow: -42)
    func state(_ phase: State.Phase, stoppedAt: Date?) -> State {
      State(
        kind: .dictation, phase: phase, scope: .session, project: "atlas", name: "demo", startedAt: started,
        stoppedAt: stoppedAt)
    }
    let stopped = Date(timeIntervalSinceNow: -5)
    let tiles: [(VoiceActivityPresentation, String, Bool)] = [
      (VoiceActivityPresentation(state(.notSent, stoppedAt: stopped)), "not sent", false),
      (VoiceActivityPresentation(state(.unconfirmed, stoppedAt: stopped)), "not confirmed", false),
      (VoiceActivityPresentation(state(.sending, stoppedAt: stopped), isStale: true), "stale send", false),
      (VoiceActivityPresentation(state(.dictating, stoppedAt: nil)), "dictating", true),
    ]
    let before = try tiles.map { try render(lockScreen($0.0), name: "voice-tile-timer-\($0.1)").bytes }
    try await Task.sleep(for: .milliseconds(1500))
    for ((presentation, name, runs), earlier) in zip(tiles, before) {
      let later = try render(lockScreen(presentation), name: "voice-tile-timer-\(name)").bytes
      XCTAssertEqual(later != earlier, runs, runs ? "\(name): the timer runs" : "\(name): the timer stays")
    }
  }

  @MainActor private final class Runs {
    var names: [String] = []
  }

  func testScreenshots() throws {
    guard let dir = ProcessInfo.processInfo.environment["RAROG_VOICE_LA_SNAPSHOT_DIR"], !dir.isEmpty else {
      throw XCTSkip("RAROG_VOICE_LA_SNAPSHOT_DIR not set")
    }
    for (state, name) in Self.states {
      let tile = try render(lockScreen(VoiceActivityPresentation(state)), name: name)
      let url = URL(filePath: dir).appending(path: "voice-activity-lock-screen-\(name).png")
      try XCTUnwrap(UIImage(cgImage: tile.image).pngData(), name).write(to: url)
    }
  }

  // MARK: - Render

  /// The tile as the widget sets it: dark theme on translucent black, here on black (the Lock Screen's blur).
  private func lockScreen(_ presentation: VoiceActivityPresentation, activityID: String = "voice-1") -> some View {
    VoiceActivityLockScreenView(presentation: presentation, activityID: activityID)
      .frame(width: 364)
      .background(Color.black)
      .environment(\.colorScheme, .dark)
  }

  /// The labels of the buttons VoiceOver finds in `view`, from left to right.
  private func buttonLabels(in view: some View) async throws -> [String] {
    try await accessibility(of: view).filter { $0.button }.map(\.label)
  }

  /// The labels of the elements VoiceOver finds in `view` that are not buttons.
  private func textLabels(in view: some View) async throws -> [String] {
    try await accessibility(of: view).filter { !$0.button }.map(\.label)
  }

  /// The labelled accessibility elements of `view` hosted in a window of the app's scene, from left to right.
  private func accessibility(of view: some View) async throws -> [(label: String, button: Bool)] {
    try await withElements(of: view) { elements in
      elements.map { ($0.accessibilityLabel ?? "", $0.accessibilityTraits.contains(.button)) }
    }
  }

  /// Runs `body` with the labelled accessibility elements of `view`, from left to right, while it stands in a window
  /// of the app's scene. SwiftUI builds them only for an accessibility client, so the test process turns automation
  /// on first.
  private func withElements<T>(
    of view: some View, _ body: @MainActor ([NSObject]) async throws -> T
  ) async throws -> T {
    InboxScreenTests.enableAccessibility()
    let host = UIHostingController(rootView: view)
    host.safeAreaRegions = []
    let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
    let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow()
    window.frame = CGRect(x: 0, y: 0, width: 364, height: 200)
    window.rootViewController = host
    window.isHidden = false
    defer { window.isHidden = true }
    host.view.frame = window.bounds
    host.view.layoutIfNeeded()
    try await Task.sleep(for: .milliseconds(150))
    host.view.layoutIfNeeded()
    var seen = Set<String>()
    let elements = InboxScreenTests.elements(in: window)
      .filter { !($0 is UIView) && ($0.accessibilityLabel ?? "").isEmpty == false }
      .sorted { $0.accessibilityFrame.minX < $1.accessibilityFrame.minX }
      .filter { element in
        let label = element.accessibilityLabel ?? ""
        return seen.insert("\(label)|\(element.accessibilityTraits.rawValue)|\(element.accessibilityFrame)").inserted
      }
    return try await body(elements)
  }

  private struct Bitmap {
    let image: CGImage
    let bytes: [UInt8]
    var height: Int { image.height }

    /// Pixels in the colour `hex` (±12 per channel: smoothed edges mix with the background).
    func count(of hex: UInt32) -> Int {
      let target = [Int((hex >> 16) & 0xFF), Int((hex >> 8) & 0xFF), Int(hex & 0xFF)]
      var hits = 0
      for index in stride(from: 0, to: bytes.count, by: 4)
      where zip(target, bytes[index..<index + 3]).allSatisfy({ abs($0 - Int($1)) <= 12 }) {
        hits += 1
      }
      return hits
    }
  }

  /// Render at scale 2 into an RGBA bitmap.
  private func render(_ view: some View, name: String) throws -> Bitmap {
    let renderer = ImageRenderer(content: view)
    renderer.scale = 2
    let image = try XCTUnwrap(renderer.cgImage, "\(name): render")
    let space = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
    var bytes = [UInt8](repeating: 0, count: image.width * image.height * 4)
    let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
      guard let context = CGContext(
        data: buffer.baseAddress, width: image.width, height: image.height, bitsPerComponent: 8,
        bytesPerRow: image.width * 4, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
      else { return false }
      context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
      return true
    }
    XCTAssertTrue(drawn, "\(name): bitmap")
    return Bitmap(image: image, bytes: bytes)
  }
}
