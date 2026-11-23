import RarogCore
@testable import RarogUI
import Testing

// Stan nie samym kolorem. Właściciel: dostępność.

@Suite("stan nie samym kolorem")
struct StateGlyphTests {
  @Test("każdy stan sesji ma własny kształt znaku zakładki, nie tylko barwę")
  func distinctGlyphs() {
    let tones: [StatusTone] = [.working, .waiting, .failed, .unread, .quiet, .backgroundWait]
    #expect(Set(tones.compactMap(StateGlyph.mark)).count == tones.count - 1, "cisza bez znaku")
    #expect(StateGlyph.mark(.quiet) == nil)
  }

  @Test("czekanie na zadanie w tle: klepsydra przy zakładce")
  func backgroundWaitGlyphs() {
    #expect(StateGlyph.mark(.backgroundWait) == "hourglass")
    #expect(StateGlyph.mark(.backgroundWait) != StateGlyph.mark(.working), "pracę odróżnia kształt, nie tylko barwa")
  }
}
