import Foundation
@testable import RarogUI
import Testing

// UIKit code follows the app's text size through the model (`TextScaleObservation`): one call per change of the
// effective size, with the new value readable, and none after the owner is gone. Owner: text size.

@MainActor
@Suite("text size: UIKit follows the model")
struct TextScaleObservationTests {
  typealias Scratch = AppShortcutSettingsTests.Scratch

  private final class Owner {}

  /// Lets the main actor run the follow-up task of a change.
  private func settle() async {
    for _ in 0..<5 { await Task.yield() }
  }

  @Test("⌘+ twice, then ⌘0: one call per change, each sees the new effective size")
  func callsPerChange() async {
    let scratch = Scratch()
    let scale = TextScale(defaults: scratch.defaults, system: .large)
    let owner = Owner()
    var seen: [TextSizeCategory] = []
    TextScaleObservation.follow(owner, scale: scale) { seen.append(scale.effective) }
    await settle()
    #expect(seen.isEmpty)
    scale.grow()
    await settle()
    scale.grow()
    await settle()
    scale.reset()
    await settle()
    #expect(seen == [.extraLarge, .extraExtraLarge, .large])
    _ = owner
  }

  @Test("the owner is gone: a change calls nothing")
  func ownerGone() async {
    let scratch = Scratch()
    let scale = TextScale(defaults: scratch.defaults, system: .large)
    var calls = 0
    do {
      let owner = Owner()
      TextScaleObservation.follow(owner, scale: scale) { calls += 1 }
    }
    scale.grow()
    await settle()
    #expect(calls == 0)
  }
}
