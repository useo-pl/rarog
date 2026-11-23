import RarogCore
@testable import RarogUI
import UIKit
import XCTest

/// The transcript density switched in Settings while the session screen is open: the content and the quote bar move
/// in by the extra side margin, the foot's cards line up with the content, prose ends at the density's narrower
/// measure, the turn gap takes the density's token, every cell is as tall as its content at the new width (no stale
/// heights from the wider column), and Standard brings the frames back. Owner: transcript.
@MainActor
final class TranscriptSpacingScreenTests: XCTestCase {
  func testDensityChangeRelaysOutSessionAtOnce() throws {
    let suite = "rarog-test-transcript-density-\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    let density = TranscriptDensity(defaults: defaults)
    // An iPad in landscape: the column is wide enough for Relaxed's widest margin.
    let (controller, window) = try TranscriptProseWidthTests.sessionScreen(
      size: CGSize(width: 1_376, height: 1_032), theme: .dark, density: density)
    defer { window.isHidden = true }
    let list = try XCTUnwrap(controller.collectionView)
    let column = Double(list.bounds.width - list.safeAreaInsets.left - list.safeAreaInsets.right)
    let extra = CGFloat(TranscriptSpacing.relaxed.side(column: column) - TranscriptSpacing.cellSide)
    XCTAssertGreaterThan(extra, 0, "Relaxed widens the margin in this column")

    let standard = try measure(controller, window)
    XCTAssertEqual(standard.turnTop, CGFloat(TranscriptSpacing.standard.turn), "Standard turn gap above a prompt")

    density.choose(.relaxed)
    settle(window)
    let relaxed = try measure(controller, window)
    XCTAssertEqual(relaxed.answer.minX, standard.answer.minX + extra, accuracy: 0.5, "content moves in on the left")
    XCTAssertEqual(relaxed.answer.maxX, standard.answer.maxX - extra, accuracy: 0.5, "and on the right")
    XCTAssertEqual(relaxed.turnTop, CGFloat(TranscriptSpacing.relaxed.turn), "Relaxed turn gap above a prompt")
    XCTAssertEqual(relaxed.barMinX, relaxed.answer.minX, accuracy: 0.5, "the quote bar stays in line with the content")
    XCTAssertEqual(relaxed.composer.minX, relaxed.answer.minX, accuracy: 0.5, "the field card lines up on the left")
    XCTAssertEqual(relaxed.composer.maxX, relaxed.answer.maxX, accuracy: 0.5, "and on the right")
    XCTAssertLessThan(relaxed.prose, standard.prose - 40, "prose ends at a narrower measure")
    let body = Fonts.text(MarkdownRenderer.transcriptStyle, traits: controller.traitCollection).pointSize
    let cap = CGFloat(TranscriptSpacing.relaxed.readableEm) * body
    XCTAssertLessThanOrEqual(relaxed.prose, cap + 0.5, "prose ends at Relaxed's readable measure")
    XCTAssertGreaterThan(relaxed.prose, cap - 80, "and wrapped prose reaches it")
    XCTAssertGreaterThan(standard.barWidth, cap, "the long quote runs past Relaxed's measure in Standard")
    XCTAssertLessThanOrEqual(relaxed.barWidth, cap + 0.5, "the quote bar ends at Relaxed's measure")

    density.choose(.standard)
    settle(window)
    let back = try measure(controller, window)
    XCTAssertEqual(back.answer.minX, standard.answer.minX, accuracy: 0.5, "Standard frames come back")
    XCTAssertEqual(back.answer.maxX, standard.answer.maxX, accuracy: 0.5)
    XCTAssertEqual(back.turnTop, standard.turnTop)
    XCTAssertEqual(back.barMinX, standard.barMinX, accuracy: 0.5)
    XCTAssertEqual(back.composer.minX, standard.composer.minX, accuracy: 0.5, "the field card comes back")
    XCTAssertEqual(back.composer.maxX, standard.composer.maxX, accuracy: 0.5)
    XCTAssertEqual(back.prose, standard.prose, accuracy: 0.5, "and the Standard measure")
    XCTAssertEqual(back.barWidth, standard.barWidth, accuracy: 0.5, "and the quote bar's width")
  }

  /// Side safe areas narrow the column once, and the section inset counts from the safe area's edge: the content and the
  /// quote bar stand at the same Relaxed margin. A width of 834 pt with 60 pt on each side is a 714 pt column (the
  /// 24 pt step); taking the safe areas off twice would land on 594 pt and the 20 pt step, and an inset counted from the
  /// list's edge would vanish in the cells' own safe-area inset, leaving the content at the safe area plus 16 pt.
  func testRelaxedMarginWithSideSafeAreasKeepsContentInLineWithQuoteBar() throws {
    let suite = "rarog-test-transcript-density-\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    let density = TranscriptDensity(defaults: defaults)
    density.choose(.relaxed)
    let (controller, window) = try TranscriptProseWidthTests.sessionScreen(
      size: CGSize(width: 834, height: 1_112), theme: .dark, density: density)
    defer { window.isHidden = true }
    controller.additionalSafeAreaInsets = UIEdgeInsets(top: 0, left: 60, bottom: 0, right: 60)
    settle(window)
    let list = try XCTUnwrap(controller.collectionView)
    XCTAssertEqual(list.safeAreaInsets.left, 60, accuracy: 0.5, "the list sees the side safe area")

    let measured = try measure(controller, window)
    XCTAssertEqual(measured.barMinX, measured.answer.minX, accuracy: 0.5, "the quote bar stays in line with the content")
    XCTAssertEqual(
      measured.answer.minX, list.safeAreaInsets.left + CGFloat(TranscriptSpacing.relaxed.side(column: 714)),
      accuracy: 0.5, "the content stands at the margin of the 714 pt column")
    XCTAssertEqual(measured.composer.minX, measured.answer.minX, accuracy: 0.5, "the field card lines up on the left")
    XCTAssertEqual(measured.composer.maxX, measured.answer.maxX, accuracy: 0.5, "and on the right")
  }

  /// A rotation changes the width and the side safe areas in one step, and the margin crosses a step of the column:
  /// 1 194 pt without safe areas is the 32 pt step, 834 pt with 60 pt on each side a 714 pt column and the 24 pt step.
  /// The section inset counts from the side safe areas only: nothing comes above the first row or below the last.
  func testRelaxedMarginFollowsRotationAcrossColumnStep() throws {
    let suite = "rarog-test-transcript-density-\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    let density = TranscriptDensity(defaults: defaults)
    density.choose(.relaxed)
    let (controller, window) = try TranscriptProseWidthTests.sessionScreen(
      size: CGSize(width: 1_194, height: 1_112), theme: .dark, density: density)
    defer { window.isHidden = true }
    let wide = try measure(controller, window)
    XCTAssertEqual(wide.answer.minX, CGFloat(TranscriptSpacing.relaxed.side(column: 1_194)), accuracy: 0.5)
    XCTAssertEqual(wide.barMinX, wide.answer.minX, accuracy: 0.5, "the quote bar stays in line with the content")
    XCTAssertEqual(wide.composer.minX, wide.answer.minX, accuracy: 0.5, "the field card lines up with the content")

    controller.additionalSafeAreaInsets = UIEdgeInsets(top: 20, left: 60, bottom: 20, right: 60)
    window.frame.size.width = 834
    settle(window)
    let list = try XCTUnwrap(controller.collectionView)
    let narrow = try measure(controller, window)
    XCTAssertEqual(
      narrow.answer.minX, list.safeAreaInsets.left + CGFloat(TranscriptSpacing.relaxed.side(column: 714)),
      accuracy: 0.5, "the content stands at the margin of the 714 pt column")
    XCTAssertEqual(narrow.barMinX, narrow.answer.minX, accuracy: 0.5, "the quote bar stays in line with the content")
    XCTAssertEqual(narrow.composer.minX, narrow.answer.minX, accuracy: 0.5, "the field card follows the rotation")
    XCTAssertEqual(narrow.composer.maxX, narrow.answer.maxX, accuracy: 0.5)
    let first = try XCTUnwrap(list.layoutAttributesForItem(at: IndexPath(item: 0, section: 0)))
    let last = try XCTUnwrap(
      list.layoutAttributesForItem(at: IndexPath(item: list.numberOfItems(inSection: 0) - 1, section: 0)))
    XCTAssertEqual(first.frame.minY, 0, accuracy: 0.5, "no inset above the first row")
    XCTAssertEqual(last.frame.maxY, list.contentSize.height, accuracy: 0.5, "no inset below the last row")
  }

  /// A decision in the dock on an iPad in landscape: in Relaxed the "1 of N" header and the card stand at the
  /// transcript's margin, and Standard brings back the cards' own 10 pt.
  func testRelaxedDockStandsAtTranscriptMargin() throws {
    let suite = "rarog-test-transcript-density-\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    let density = TranscriptDensity(defaults: defaults)
    let store = try DecisionDockTests.makeStore(
      messages: 20, state: "waiting-permission", permissions: ["p1", "p2"])
    let controller = SessionViewController(store: store, sessionId: "s1", drafts: ComposerDrafts())
    controller.decisionMode = .dock
    controller.transcriptDensity = density
    let window = UIWindow(frame: CGRect(origin: .zero, size: CGSize(width: 1_376, height: 1_032)))
    window.overrideUserInterfaceStyle = .dark
    window.rootViewController = controller
    window.isHidden = false
    defer { window.isHidden = true }
    settle(window)
    XCTAssertFalse(controller.decisionSlot.isHidden, "the decision stands in the dock")

    func dock() throws -> (header: CGFloat, cardMaxX: CGFloat) {
      let slot = controller.decisionSlot
      let header = try XCTUnwrap(DecisionDockTests.find(slot, id: "dock.position.surface"), "the \"1 of N\" surface")
      let card = try XCTUnwrap(DecisionDockTests.find(slot, id: "dock.card"), "the card's frame")
      // The card keeps the cards' own side inside its frame, like the header.
      let cardMaxX = card.convert(card.bounds, to: controller.view).maxX - ListFooterMetrics.cardSide
      return (header.convert(header.bounds, to: controller.view).minX, cardMaxX)
    }
    let width = controller.view.bounds.width
    let standard = try dock()
    XCTAssertEqual(standard.header, ListFooterMetrics.cardSide, accuracy: 0.5, "Standard: the cards' own side")

    density.choose(.relaxed)
    settle(window)
    let side = CGFloat(TranscriptSpacing.relaxed.side(column: Double(width)))
    let relaxed = try dock()
    XCTAssertEqual(relaxed.header, side, accuracy: 0.5, "the header stands at the transcript's margin")
    XCTAssertEqual(relaxed.cardMaxX, width - side, accuracy: 0.5, "the card ends at the transcript's margin")

    density.choose(.standard)
    settle(window)
    let back = try dock()
    XCTAssertEqual(back.header, standard.header, accuracy: 0.5, "Standard frames come back")
    XCTAssertEqual(back.cardMaxX, standard.cardMaxX, accuracy: 0.5)
  }

  // MARK: - Helpers

  private struct Measure {
    /// The first reply's text view in the screen's coordinates.
    let answer: CGRect
    /// The top margin of the second prompt's row: the turn gap.
    let turnTop: CGFloat
    /// The quote bar's leading edge in the screen's coordinates.
    let barMinX: CGFloat
    /// The quote bar's width.
    let barWidth: CGFloat
    /// The field card in the screen's coordinates.
    let composer: CGRect
    /// The end of the first reply's widest prose line, from the text's leading edge.
    let prose: CGFloat
  }

  private func settle(_ window: UIWindow) {
    RunLoop.main.run(until: Date().addingTimeInterval(0.3))
    window.layoutIfNeeded()
  }

  /// Scrolls to the first reply, then to the second prompt, and checks on both stops that no visible cell keeps a
  /// height from another width.
  private func measure(_ controller: SessionViewController, _ window: UIWindow) throws -> Measure {
    let answerView = try textView(controller, window, row: "m2.0")
    let answer = answerView.convert(answerView.bounds, to: controller.view)
    let bar = try XCTUnwrap(controller.turnChrome.promptBar)
    let barMinX = bar.convert(bar.bounds, to: controller.view).minX
    let prose = TranscriptProseWidthTests.paragraphs(answerView).filter { $0.kind == .prose }.map(\.maxX).max() ?? 0
    XCTAssertFalse(controller.composer.isHidden, "the screen shows the field")
    let card = try XCTUnwrap(controller.composer.textView.superview, "the field card")
    let composer = card.convert(card.bounds, to: controller.view)
    checkHeights(controller.collectionView)
    let promptView = try textView(controller, window, row: "m3.0")
    let content = try XCTUnwrap(
      sequence(first: promptView as UIView, next: \.superview).first { $0 is MessageContentView }, "message content")
    checkHeights(controller.collectionView)
    return Measure(
      answer: answer, turnTop: content.directionalLayoutMargins.top, barMinX: barMinX, barWidth: bar.bounds.width,
      composer: composer, prose: prose)
  }

  private func textView(_ controller: SessionViewController, _ window: UIWindow, row: String) throws -> UITextView {
    let list = try XCTUnwrap(controller.collectionView)
    let index = try XCTUnwrap(controller.dataSource.indexPath(for: row), "row \(row)")
    let attributes = try XCTUnwrap(list.layoutAttributesForItem(at: index))
    controller.pinned = false
    controller.setClampedOffset(attributes.frame.minY - 120 - list.adjustedContentInset.top)
    settle(window)
    return try XCTUnwrap(
      TranscriptProseWidthTests.textViews(in: list).first { $0.accessibilityIdentifier == "message.\(row)" },
      "text view of \(row)")
  }

  /// Every visible cell is as tall as its content at its current width.
  private func checkHeights(_ list: UICollectionView) {
    for cell in list.visibleCells {
      let fitting = cell.systemLayoutSizeFitting(
        CGSize(width: cell.bounds.width, height: UIView.layoutFittingCompressedSize.height),
        withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel)
      XCTAssertEqual(cell.bounds.height, fitting.height, accuracy: 1, "cell height at its width: \(cell)")
    }
  }
}
