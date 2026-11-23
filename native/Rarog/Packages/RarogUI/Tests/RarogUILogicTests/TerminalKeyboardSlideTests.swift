import CoreGraphics
@testable import RarogUI
import Testing

// The terminal surface while the on-screen keyboard slides (`TerminalKeyboardSlide`): held at its old height while
// the keyboard comes up, the container's height at once while it goes down, today's layout everywhere else.
// Owner: terminal.

@Suite("terminal: the surface while the on-screen keyboard slides")
struct TerminalKeyboardSlideTests {
  /// A container 390 pt wide; the surface fills 700 pt before the keyboard.
  private func pass(
    _ height: CGFloat, surface: CGFloat = 700, up: Bool, animated: Bool = true, eligible: Bool = true,
    width: CGFloat = 390
  ) -> TerminalKeyboardSlide.Pass {
    TerminalKeyboardSlide.Pass(
      container: CGSize(width: width, height: height), surfaceHeight: surface, keyboardUp: up, animated: animated,
      eligible: eligible)
  }

  /// One pass with a fixed rise.
  private func place(_ slide: inout TerminalKeyboardSlide, _ pass: TerminalKeyboardSlide.Pass, rise: CGFloat)
    -> TerminalKeyboardSlide.Placement
  {
    slide.place(pass) { _ in rise }
  }

  /// A slide that has seen one layout with the keyboard down.
  private func settled(up: Bool = false) -> TerminalKeyboardSlide {
    var slide = TerminalKeyboardSlide()
    _ = slide.place(pass(up ? 420 : 700, surface: up ? 420 : 700, up: up, animated: false)) { _ in 0 }
    return slide
  }

  @Test("keyboard up: the surface keeps its height and its top moves up by the rise, until the slide ends")
  func risingHolds() {
    var slide = settled()
    var asked: [CGFloat] = []
    let placement = slide.place(pass(420, up: true)) {
      asked.append($0)
      return 280
    }
    #expect(placement == .held(top: -280, height: 700))
    #expect(asked == [420], "the rise for the container's final height")
    // Another pass inside the same slide keeps the hold.
    #expect(place(&slide, pass(420, up: true), rise: 999) == .held(top: -280, height: 700))
    let released = slide.release()
    #expect(released)
    #expect(place(&slide, pass(420, surface: 700, up: true, animated: false), rise: 0) == .fill)
    let again = slide.release()
    #expect(!again, "nothing held any more")
  }

  @Test("the hold follows a second height change of the keyboard inside the slide")
  func holdFollowsNewHeight() {
    var slide = settled()
    _ = slide.place(pass(420, up: true)) { _ in 280 }
    #expect(place(&slide, pass(380, up: true), rise: 320) == .held(top: -320, height: 700))
  }

  @Test("the top never goes below the container's top nor above the whole surface")
  func topClamped() {
    var down = settled()
    #expect(place(&down, pass(420, up: true), rise: -15) == .held(top: 0, height: 700))
    var up = settled()
    #expect(place(&up, pass(420, up: true), rise: 5000) == .held(top: -700, height: 700))
  }

  @Test("keyboard down: the surface takes the container's height at once")
  func fallingFillsAtOnce() {
    var slide = settled(up: true)
    #expect(place(&slide, pass(700, surface: 420, up: false), rise: 0) == .fillAtOnce)
  }

  @Test("keyboard down in the middle of its slide up: the hold ends and the surface follows the container")
  func interruptedRise() {
    var slide = settled()
    _ = slide.place(pass(420, up: true)) { _ in 280 }
    #expect(place(&slide, pass(700, surface: 700, up: false), rise: 0) == .fill)
    let held = slide.release()
    #expect(!held)
  }

  /// Hardware keyboard, the stack held while a window closes, a grid without rows; a layout outside an animation;
  /// the keyboard already up (rotation, another keyboard type); no keyboard change at all (split view, rotation).
  @Test("everything else lays out as before: the surface fills the container in the pass's animation")
  func otherLayoutsFill() {
    var hardware = settled()
    #expect(place(&hardware, pass(420, up: true, eligible: false), rise: 280) == .fill)
    var instant = settled()
    #expect(place(&instant, pass(420, up: true, animated: false), rise: 280) == .fill)
    var already = settled(up: true)
    #expect(place(&already, pass(300, surface: 420, up: true), rise: 120) == .fill)
    var plain = settled()
    #expect(place(&plain, pass(500, up: false), rise: 200) == .fill)
    var growing = settled()
    #expect(place(&growing, pass(800, up: false), rise: 0) == .fill, "keyboard was not up: no fill at once")
    var first = TerminalKeyboardSlide()
    #expect(place(&first, pass(420, up: true), rise: 280) == .fill, "the first layout has no keyboard change")
  }

  @Test("a width change or a hardware keyboard during the hold ends it")
  func holdEnds() {
    var rotated = settled()
    _ = rotated.place(pass(420, up: true)) { _ in 280 }
    #expect(place(&rotated, pass(420, up: true, width: 844), rise: 280) == .fill)
    let held = rotated.release()
    #expect(!held)
    var hardware = settled()
    _ = hardware.place(pass(420, up: true)) { _ in 280 }
    #expect(place(&hardware, pass(420, up: true, eligible: false), rise: 280) == .fill)
  }
}
