#if os(iOS)
import UIKit

// Static measures of a message row: the bubble cap, the folded prompt window and its button row, the time label
// and whether it fits beside the bubble. Pure functions of traits and text, shared by the row and the session
// screen (`placePromptClock`). Owner: transcript, markdown.
extension MessageContentView {
  /// The widest bubble: the density's readable measure (``TranscriptSpacing/readableEm``, where readable prose ends)
  /// in the body text at the current text size, in both width modes.
  static func plateCap(_ traits: UITraitCollection, spacing: TranscriptSpacing) -> CGFloat {
    CGFloat(spacing.readableEm) * Fonts.text(MarkdownRenderer.transcriptStyle, traits: traits).pointSize
  }

  /// Wysokość okna zwiniętego promptu: ``PromptFolds/visible`` odstępów linii prozy w piśmie treści.
  static func foldHeight(_ traits: UITraitCollection) -> CGFloat {
    CGFloat(PromptFolds.visible) * prosePitch(traits)
  }

  /// Odstęp linii prozy w piśmie treści: 1,5 stopnia albo naturalny, gdy większy (``ProseLeading``).
  static func prosePitch(_ traits: UITraitCollection) -> CGFloat {
    let font = Fonts.text(MarkdownRenderer.transcriptStyle, traits: traits)
    return max(ProseLeading.naturalPitch(font), font.pointSize * ProseLeading.ratio)
  }

  /// Linia napisu „Pokaż całość” / „Zwiń” na dole dymka; rośnie z pismem. Cel dotyku (≥ 44 pt) wystaje poza nią.
  static func foldLineHeight(_ traits: UITraitCollection) -> CGFloat {
    Fonts.text(.footnote, traits: traits).lineHeight.rounded(.up)
  }

  /// Zanik dolnej pół linii okna zwiniętego promptu.
  static func fadeHeight(_ traits: UITraitCollection) -> CGFloat {
    prosePitch(traits) / 2
  }

  /// Wiersz przycisku zwinięcia w dymku pod oknem tekstu: odstęp nad linią napisu, linia napisu i o ile cel
  /// dotyku (≥ 44 pt) wystaje nad nią i pod nią.
  struct FoldRow: Equatable {
    var gap: CGFloat
    var line: CGFloat
    var above: CGFloat
    var below: CGFloat
    /// Miejsce w dymku pod oknem tekstu.
    var reserve: CGFloat { gap + line }
    static let none = FoldRow(gap: 0, line: 0, above: 0, below: 0)
  }

  /// Cel dotyku sięga najpierw w dół, na `room` pod linią napisu, potem w górę: przy zwiniętym prompcie najwyżej na
  /// zanik ostatniej linii, przy rozwiniętym wcale — tam rośnie odstęp nad napisem. Cel nie nachodzi więc na widoczny
  /// tekst, który ma zostać do zaznaczania i linków.
  static func foldRow(traits: UITraitCollection, collapsed: Bool, room: CGFloat) -> FoldRow {
    let line = foldLineHeight(traits)
    let spare = max(0, foldTarget - line)
    let below = min(max(0, room), spare)
    let above = spare - below
    let overlap = collapsed ? fadeHeight(traits) : 0
    return FoldRow(gap: max(foldGap, above - overlap), line: line, above: above, below: below)
  }

  /// Pismo godziny przy dymku: jak znacznik czasu (`caption`, stała szerokość), rośnie z Dynamic Type.
  static func clockFont(_ traits: UITraitCollection) -> UIFont {
    Fonts.mono(.caption1, traits: traits)
  }

  /// Whether the time fits BESIDE the bubble in a row `rowWidth` wide (after the side margins). A wide column (iPad in
  /// landscape) always has room; a narrower one when the widest text line leaves the gap and the label at the current
  /// text size on the right. Measured with the same TextKit 2 as the field, in a container of min(column, the bubble's
  /// cap at the density `spacing`) minus the insets. A long prompt (`fold`) has a bubble at least as wide as the
  /// button label at its bottom (``PromptFoldButton/showWidth(lines:traits:)``).
  static func clockFitsBeside(
    text: NSAttributedString, clock: String, rowWidth: CGFloat, traits: UITraitCollection, spacing: TranscriptSpacing,
    fold: PromptFold? = nil
  ) -> Bool {
    guard rowWidth > 0 else { return true }
    let clockWidth = (clock as NSString).size(withAttributes: [.font: clockFont(traits)]).width.rounded(.up)
    let cap = plateCap(traits, spacing: spacing)
    if rowWidth >= cap + clockGap + clockWidth { return true }
    let container = min(rowWidth, cap) - 2 * plateHorizontal
    let floor = fold.map { PromptFoldButton.showWidth(lines: $0.lines, traits: traits) } ?? 0
    let used = needsFullWidth(text) ? container : min(container, max(floor, measuredWidth(text, container: container)))
    return used + 2 * plateHorizontal + clockGap + clockWidth <= rowWidth
  }

  /// Najszersza linia tekstu w kontenerze `container` (TextKit 2, `usageBoundsForTextContainer`).
  static func measuredWidth(_ text: NSAttributedString, container: CGFloat) -> CGFloat {
    let storage = NSTextContentStorage()
    let manager = NSTextLayoutManager()
    storage.addTextLayoutManager(manager)
    let box = NSTextContainer(size: CGSize(width: container, height: 0))
    box.lineFragmentPadding = 0
    manager.textContainer = box
    storage.attributedString = text
    manager.ensureLayout(for: manager.documentRange)
    return manager.usageBoundsForTextContainer.maxX.rounded(.up)
  }
}
#endif
