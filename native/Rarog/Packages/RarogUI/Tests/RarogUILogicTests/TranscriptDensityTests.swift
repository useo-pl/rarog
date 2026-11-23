import Foundation
@testable import RarogUI
import Testing

// The transcript density chosen in Settings (`TranscriptDensity`): standard unless relaxed is stored on this device,
// and one call to the session screen per change. Owner: transcript.

@MainActor
@Suite("transcript density: standard or relaxed, stored per device")
struct TranscriptDensityTests {
  typealias Scratch = AppShortcutSettingsTests.Scratch

  private final class Owner {}

  private func settle() async {
    for _ in 0..<5 { await Task.yield() }
  }

  @Test("nothing stored → standard; relaxed survives a new model; standard removes the entry")
  func storedPerDevice() {
    let scratch = Scratch()
    let density = TranscriptDensity(defaults: scratch.defaults)
    #expect(density.mode == .standard && density.spacing == .standard)
    density.choose(.relaxed)
    #expect(TranscriptDensity(defaults: scratch.defaults).mode == .relaxed)
    #expect(TranscriptDensity(defaults: scratch.defaults).spacing == .relaxed)
    density.choose(.standard)
    #expect(scratch.defaults.object(forKey: TranscriptDensity.key) == nil)
    #expect(TranscriptDensity(defaults: scratch.defaults).mode == .standard)
  }

  @Test("an unknown stored value reads as standard")
  func unknownValue() {
    let scratch = Scratch()
    scratch.defaults.set("compact", forKey: TranscriptDensity.key)
    #expect(TranscriptDensity(defaults: scratch.defaults).mode == .standard)
  }

  @Test("relaxed, the same again, then standard: one call per real change, each sees the new mode")
  func followsChanges() async {
    let scratch = Scratch()
    let density = TranscriptDensity(defaults: scratch.defaults)
    let owner = Owner()
    var seen: [TranscriptDensityMode] = []
    TranscriptDensity.follow(owner, density: density) { seen.append(density.mode) }
    density.choose(.relaxed)
    await settle()
    density.choose(.relaxed)
    await settle()
    density.choose(.standard)
    await settle()
    #expect(seen == [.relaxed, .standard])
    _ = owner
  }
}
