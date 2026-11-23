import Foundation

// The transcript's spacing tokens, one table for both densities (`TranscriptDensity`). Standard is the base: the gaps
// between transcript elements as they stand by default. Relaxed scales every vertical gap BETWEEN elements by one
// factor, so all their relations stay, widens the side margin with the column width and narrows the readable
// measure; the insides of elements (bubble insets, tool rows, code boxes, tables, cards) and the prose line height
// stay. Owner: transcript.

/// How much space the transcript puts around its elements on this device; the raw value is what `UserDefaults` stores.
public enum TranscriptDensityMode: String, CaseIterable, Sendable {
  case standard, relaxed

  /// The spacing tokens of this density.
  public var spacing: TranscriptSpacing {
    switch self {
    case .standard: .standard
    case .relaxed: .relaxed
    }
  }
}

/// The spacing of one density: a factor on the vertical gaps, the side margin by column width and the readable
/// measure.
public struct TranscriptSpacing: Sendable, Hashable {
  /// The side margin of a column at least `from` points wide.
  public struct Side: Sendable, Hashable {
    public let from: Double
    public let margin: Double
  }

  /// Every vertical gap between transcript elements: turn boundaries, the row rule, markers and markdown blocks.
  public let gapScale: Double
  /// Side margins by column width, narrowest column first.
  public let sides: [Side]
  /// The longest prose line in em of the body text in the readable width mode (``TranscriptWidth``); the prompt
  /// bubble and the quote bar end at it in both width modes.
  public let readableEm: Double

  /// 47.5 em is 760 pt at 16 pt, where the widest prompt bubble ends.
  public static let standard = TranscriptSpacing(
    gapScale: 1, sides: [Side(from: 0, margin: Base.side)], readableEm: 47.5)
  /// 20 pt is Apple's margin on a large iPhone and an iPad, 24 pt Material's from 600 wide; from 840 pt prose ends at
  /// its readable cap anyway, so a wider margin takes nothing from the line. 38 em is 608 pt at 16 pt, about 82
  /// characters of average text, near the 80 of WCAG 1.4.8 and the 45–90 of book typography.
  public static let relaxed = TranscriptSpacing(
    gapScale: 1.25,
    sides: [Side(from: 0, margin: 20), Side(from: 600, margin: 24), Side(from: 840, margin: 32)],
    readableEm: 38)

  /// Standard's gaps in points; every density derives its own from these.
  enum Base {
    static let turn = 32.0
    static let afterPrompt = 10.0
    static let underPlate = 4.0
    static let voiceChange = 12.0
    static let runTop = 2.0
    static let rowBottom = 2.0
    static let marker = 14.0
    static let side = 16.0
  }

  /// The margin every transcript cell keeps on its own; the rest of ``side(column:)`` is an inset around the cells.
  public static let cellSide = Base.side

  /// A gap of Standard scaled by ``gapScale``, in whole points.
  func points(_ standard: Double) -> Double {
    (standard * gapScale).rounded()
  }

  /// Above a prompt: a new turn.
  public var turn: Double { points(Base.turn) }
  /// Above the first row after a prompt: the reply keeps to its prompt.
  public var afterPrompt: Double { points(Base.afterPrompt) }
  /// Above the photos under a prompt's bubble.
  public var underPlate: Double { points(Base.underPlate) }
  /// Above a row whose voice changes, outside a turn boundary.
  public var voiceChange: Double { points(Base.voiceChange) }
  /// Above a row in a run of one voice, outside a turn boundary.
  public var runTop: Double { points(Base.runTop) }
  /// Under every row.
  public var rowBottom: Double { points(Base.rowBottom) }
  /// Above a time gap or the NEW line that is not the first row of a message block.
  public var marker: Double { points(Base.marker) }

  /// The gap before a markdown paragraph, in em of the body text.
  public func em(_ gap: MarkdownGap) -> Double {
    gap.em * gapScale
  }

  /// Where prose ends, in em of its text: the readable measure, or `nil` in the full width mode, where prose runs to
  /// the container's edge.
  public func proseCap(fullWidth: Bool) -> Double? {
    fullWidth ? nil : readableEm
  }

  /// The side margin of transcript content in a column `column` points wide (the list without its safe area).
  public func side(column: Double) -> Double {
    sides.last { column >= $0.from }?.margin ?? sides.first?.margin ?? Base.side
  }
}
