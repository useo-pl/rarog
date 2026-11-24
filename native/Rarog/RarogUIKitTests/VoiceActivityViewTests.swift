import RarogActivity
import SwiftUI
import UIKit
import XCTest

/// The voice Live Activity's views from `RarogActivity`, rendered with `ImageRenderer` on black in the dark theme, as
/// the `RarogWidgets` extension shows them. The tests keep the Lock Screen tile under 90 pt at the default type size
/// (also with names at their ceiling and the prompt's answer), stop it growing past its type limit, and check it
/// carries its phase's colour. With `RAROG_VOICE_LA_SNAPSHOT_DIR` (`TEST_RUNNER_RAROG_VOICE_LA_SNAPSHOT_DIR` for
/// `xcodebuild`) they write the tile of each state as a PNG; without it they only check. Owner: voice agent.
@MainActor
final class VoiceActivityViewTests: XCTestCase {
  typealias State = VoiceActivityAttributes.ContentState

  /// The tile's states, each with the name of its PNG.
  static let states: [(State, String)] = {
    let started = Date(timeIntervalSinceNow: -42)
    func state(_ kind: State.Kind, _ phase: State.Phase, _ scope: State.Scope, _ names: (String, String)?) -> State {
      State(kind: kind, phase: phase, scope: scope, project: names?.0, name: names?.1, startedAt: started)
    }
    let long = String(repeating: "atlas ", count: 20)
    return [
      (state(.conversation, .listening, .allSessions, nil), "listening-all-sessions"),
      (state(.conversation, .answering, .session, ("atlas", "demo")), "answering-session"),
      (state(.conversation, .reading, .session, ("atlas", "demo")), "reading-session"),
      (state(.conversation, .prompt, .session, ("atlas", "demo")), "prompt-waiting"),
      (state(.dictation, .dictating, .session, ("atlas", "demo")), "dictation-session"),
      (state(.conversation, .answering, .session, nil), "answering-no-names"),
      (state(.conversation, .prompt, .session, (long, long)), "prompt-names-at-ceiling"),
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
  private func lockScreen(_ presentation: VoiceActivityPresentation) -> some View {
    VoiceActivityLockScreenView(presentation: presentation)
      .frame(width: 364)
      .background(Color.black)
      .environment(\.colorScheme, .dark)
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
