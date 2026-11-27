import RarogCore
@testable import RarogUI
import Testing

// Stan nie samym kolorem. Właściciel: dostępność.

@Suite("stan nie samym kolorem")
struct StateGlyphTests {
  @Test("każdy stan sesji ma własny kształt znaku zakładki, nie tylko barwę")
  func distinctGlyphs() {
    let tones: [StatusTone] = [.working, .waiting, .failed, .unread, .quiet, .backgroundWait, .backgroundWaitLong]
    #expect(Set(tones.compactMap(StateGlyph.mark)).count == tones.count - 1, "cisza bez znaku")
    #expect(StateGlyph.mark(.quiet) == nil)
  }

  @Test("czekanie na zadanie w tle: klepsydra przy zakładce")
  func backgroundWaitGlyphs() {
    #expect(StateGlyph.mark(.backgroundWait) == "hourglass")
    #expect(StateGlyph.mark(.backgroundWait) != StateGlyph.mark(.working), "pracę odróżnia kształt, nie tylko barwa")
  }

  /// The long wait shares its color with a decision, so only the mark tells the two apart without color; it is no
  /// hourglass variant either, or it would read as the plain wait.
  @Test("long wait: a mark of its own, unlike the decision's and the plain wait's")
  func backgroundWaitLongGlyph() throws {
    let mark = try #require(StateGlyph.mark(.backgroundWaitLong))
    let waiting = try #require(StateGlyph.mark(.waiting))
    #expect(!mark.hasPrefix(waiting), "not a variant of the decision's mark")
    #expect(!mark.hasPrefix("hourglass"), "not a variant of the plain wait's mark")
  }
}
