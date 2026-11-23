import Foundation
@testable import RarogUI
import Testing

// The transcript width chosen in Settings (`TranscriptWidth`): readable unless full width is stored on this device,
// and one call to the session screen per change. Owner: transcript.

@MainActor
@Suite("transcript width: readable or full, stored per device")
struct TranscriptWidthTests {
  typealias Scratch = AppShortcutSettingsTests.Scratch

  private final class Owner {}

  private func settle() async {
    for _ in 0..<5 { await Task.yield() }
  }

  @Test("nothing stored → readable; full width survives a new model; readable removes the entry")
  func storedPerDevice() {
    let scratch = Scratch()
    let width = TranscriptWidth(defaults: scratch.defaults)
    #expect(width.mode == .readable && !width.full)
    width.choose(.full)
    #expect(TranscriptWidth(defaults: scratch.defaults).full)
    width.choose(.readable)
    #expect(scratch.defaults.object(forKey: TranscriptWidth.key) == nil)
    #expect(TranscriptWidth(defaults: scratch.defaults).mode == .readable)
  }

  @Test("an unknown stored value reads as readable")
  func unknownValue() {
    let scratch = Scratch()
    scratch.defaults.set("wide", forKey: TranscriptWidth.key)
    #expect(TranscriptWidth(defaults: scratch.defaults).mode == .readable)
  }

  @Test("full, the same again, then readable: one call per real change, each sees the new mode")
  func followsChanges() async {
    let scratch = Scratch()
    let width = TranscriptWidth(defaults: scratch.defaults)
    let owner = Owner()
    var seen: [TranscriptWidthMode] = []
    TranscriptWidth.follow(owner, width: width) { seen.append(width.mode) }
    width.choose(.full)
    await settle()
    width.choose(.full)
    await settle()
    width.choose(.readable)
    await settle()
    #expect(seen == [.full, .readable])
    _ = owner
  }
}
