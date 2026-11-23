import Foundation
@testable import RarogUI
import Testing

// The transcript's spacing tokens (`TranscriptSpacing`): Standard is the base and changes nothing, Relaxed scales
// every vertical gap by one factor and widens the side margin with the column, and the relations between the gaps
// hold in both. Owner: transcript.

@Suite("transcript spacing: one table, standard unchanged, relaxed by one rule")
struct TranscriptSpacingTests {
  typealias Base = TranscriptSpacing.Base

  /// Every vertical token with the Standard value it derives from.
  private static func tokens(_ spacing: TranscriptSpacing) -> [(name: String, value: Double, base: Double)] {
    [
      ("turn", spacing.turn, Base.turn), ("afterPrompt", spacing.afterPrompt, Base.afterPrompt),
      ("underPlate", spacing.underPlate, Base.underPlate), ("voiceChange", spacing.voiceChange, Base.voiceChange),
      ("runTop", spacing.runTop, Base.runTop), ("rowBottom", spacing.rowBottom, Base.rowBottom),
      ("marker", spacing.marker, Base.marker),
    ]
  }

  private static let markdownGaps: [MarkdownGap] = [.item, .paragraph, .block, .section]
  /// Column widths from a narrow split view to a 13" iPad in landscape without the list.
  private static let columns = stride(from: 0.0, through: 1400, by: 10).map { $0 }

  @Test("standard is today's look: every gap as its base, every markdown gap its own em, no inset around the cells")
  func standardChangesNothing() {
    for token in Self.tokens(.standard) {
      #expect(token.value == token.base, "\(token.name)")
    }
    for gap in Self.markdownGaps + [.none] {
      #expect(TranscriptSpacing.standard.em(gap) == gap.em, "\(gap)")
    }
    for column in Self.columns {
      #expect(TranscriptSpacing.standard.side(column: column) == TranscriptSpacing.cellSide, "column \(column)")
    }
  }

  @Test("relaxed scales every vertical gap by one factor, in whole points, and each grows")
  func relaxedFollowsOneRule() {
    let relaxed = TranscriptSpacing.relaxed
    #expect(relaxed.gapScale > 1)
    for token in Self.tokens(relaxed) {
      #expect(token.value == (token.base * relaxed.gapScale).rounded(), "\(token.name)")
      #expect(token.value > token.base, "\(token.name) grows")
    }
    for gap in Self.markdownGaps {
      #expect(relaxed.em(gap) == gap.em * relaxed.gapScale, "\(gap)")
      #expect(relaxed.em(gap) > gap.em, "\(gap) grows")
    }
    #expect(relaxed.em(.none) == 0)
  }

  @Test("in both densities a turn outweighs every gap inside it, and markdown gaps keep their order", arguments: [
    TranscriptSpacing.standard, TranscriptSpacing.relaxed,
  ])
  func relationsHold(_ spacing: TranscriptSpacing) {
    #expect(spacing.turn > spacing.voiceChange && spacing.voiceChange > spacing.runTop)
    #expect(spacing.afterPrompt < spacing.turn, "a reply keeps to its prompt")
    #expect(spacing.marker < spacing.turn)
    let ems = Self.markdownGaps.map(spacing.em)
    #expect(ems == ems.sorted() && Set(ems).count == ems.count, "item < paragraph < block < section")
    // At the default text size (16 pt) a section inside a reply stays closer than the next turn.
    #expect(spacing.em(.section) * 16 < spacing.turn)
  }

  @Test("relaxed paragraphs meet WCAG 1.4.8: across a paragraph break baselines stand at least 1.5 line pitches apart")
  func relaxedParagraphBreak() {
    // The prose line pitch in em (`ProseLeading.ratio`, iOS only); the density does not change it.
    let pitch = 1.5
    #expect(pitch + TranscriptSpacing.relaxed.em(.paragraph) >= 1.5 * pitch)
  }

  @Test("relaxed side margin grows with the column, never below standard, and costs a phone little of its line")
  func relaxedSides() {
    let relaxed = TranscriptSpacing.relaxed
    let margins = Self.columns.map { relaxed.side(column: $0) }
    #expect(margins == margins.sorted(), "never narrower in a wider column")
    #expect(margins.allSatisfy { $0 >= TranscriptSpacing.cellSide })
    #expect(Set(margins).count > 1, "a wide column gets more than a narrow one")
    // iPhone columns in portrait: the text keeps at least 97% of its standard width.
    for column in stride(from: 320.0, through: 440, by: 1) {
      let standard = column - 2 * TranscriptSpacing.standard.side(column: column)
      let text = column - 2 * relaxed.side(column: column)
      #expect(text >= 0.97 * standard, "column \(column)")
    }
  }

  @Test("readable width: relaxed prose ends at a narrower measure than standard; full width lifts the cap in both")
  func proseCapByDensityAndWidth() throws {
    let standard = try #require(TranscriptSpacing.standard.proseCap(fullWidth: false))
    let relaxed = try #require(TranscriptSpacing.relaxed.proseCap(fullWidth: false))
    #expect(relaxed < standard)
    #expect(TranscriptSpacing.standard.proseCap(fullWidth: true) == nil)
    #expect(TranscriptSpacing.relaxed.proseCap(fullWidth: true) == nil)
  }

  @Test("from an 840 pt column relaxed prose at the default size ends at its cap, so the widest margin costs no line")
  func relaxedWideColumnKeepsMeasure() {
    let relaxed = TranscriptSpacing.relaxed
    for column in stride(from: 840.0, through: 1400, by: 10) {
      #expect(column - 2 * relaxed.side(column: column) >= relaxed.readableEm * 16, "column \(column)")
    }
  }

  @Test("each density has its own tokens")
  func modesMapToTheirTables() {
    #expect(TranscriptDensityMode.standard.spacing == .standard)
    #expect(TranscriptDensityMode.relaxed.spacing == .relaxed)
    #expect(TranscriptSpacing.standard != TranscriptSpacing.relaxed)
  }
}
