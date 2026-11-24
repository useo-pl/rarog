import CoreGraphics
@testable import RarogUI
import Testing

// The tab bar's scroll offset with the current tab centred. Owner: projects and tabs.

/// A bar whose visible part, 300 pt wide, starts 100 pt in (on the iPad the bar reaches under the session list), with
/// 1000 pt of content. `containerWidth` is the visible part, as `ScrollGeometry` reports it.
private let bar = TabBarCentring.Viewport(contentWidth: 1000, containerWidth: 300, leadingInset: 100, trailingInset: 0)

@Suite("tab bar centring")
struct TabBarCentringTests {
  @Test("a middle tab stands in the middle of the visible part, not of the bar's frame")
  func middleTab() {
    let offset = TabBarCentring.offset(tab: 480...520, in: bar)
    // The tab's middle (500) at the visible part's middle: 100 pt of inset and half of 300 pt.
    #expect(offset == 250)
    #expect(500 - offset == bar.leadingInset + 150)
  }

  @Test("the first tab clamps to the content's start, the inset in front of it")
  func firstTab() {
    #expect(TabBarCentring.offset(tab: 8...80, in: bar) == -100)
  }

  @Test("the last tab clamps where the content’s end meets the end of the visible part")
  func lastTab() {
    let offset = TabBarCentring.offset(tab: 940...990, in: bar)
    #expect(offset == 600)
    // The content's end meets the visible part's end.
    #expect(offset + bar.leadingInset + bar.containerWidth == bar.contentWidth)
  }

  @Test("content narrower than the visible part stays at its start, whichever tab is current")
  func narrowContent() {
    let narrow = TabBarCentring.Viewport(contentWidth: 250, containerWidth: 300, leadingInset: 100, trailingInset: 0)
    #expect(TabBarCentring.offset(tab: 8...80, in: narrow) == -100)
    #expect(TabBarCentring.offset(tab: 180...240, in: narrow) == -100)
  }

  @Test("the iPad bar under the session list, as measured: the middle of the 890 pt after the list, then the end")
  func measuredPadBar() {
    // `ScrollGeometry` of a 1210 pt bar under a 320 pt list: the container is the visible part, without the inset.
    let pad = TabBarCentring.Viewport(contentWidth: 2117, containerWidth: 890, leadingInset: 320, trailingInset: 0)
    let offset = TabBarCentring.offset(tab: 769...842, in: pad)
    #expect(offset == 40.5)
    // On screen the bar starts at x = 0, so the tab stands at its span less the offset: centred on 320 + 890 / 2.
    #expect((769 + 842) / 2 - offset == 765)
    // The end: the content's end on the bar's right edge, 1210 pt from the bar's start.
    let end = TabBarCentring.offset(tab: 2000...2100, in: pad)
    #expect(end == 907)
    #expect(pad.contentWidth - end == 1210)
  }

  @Test("a tab's width from its content: the target's minimum, then the insets; the \"×\" room depends on the label")
  func widthFromContent() {
    let target = HeaderMetrics.tabTarget
    let inset = HeaderMetrics.tabLabelInset
    let close = TabTokens.closeDividerWidth + TabTokens.closeTarget
    // A one-character label: the target's width as a sibling and as the current label, so the room is the divider and
    // the "×" whole, more than a longer label's room.
    let short: CGFloat = 1
    #expect(TabBarCentring.width(content: short, closes: false) == target)
    #expect(TabBarCentring.width(content: short, closes: true) == target + close)
    #expect(TabBarCentring.room(content: short) == close)
    #expect(TabBarCentring.room(content: short) > TabTokens.closeSpace)
    // Between the two: the sibling is over the minimum, the current label (with the shorter divider gap) is not yet.
    let band = target - inset - TabTokens.closeDividerGap - 1
    #expect(TabBarCentring.width(content: band, closes: false) == band + 2 * inset)
    #expect(TabBarCentring.width(content: band, closes: true) == target + close)
    #expect(TabBarCentring.room(content: band) == target + close - (band + 2 * inset))
    // A longer label gives its trailing inset to the divider gap.
    let long: CGFloat = 200
    #expect(TabBarCentring.width(content: long, closes: false) == long + 2 * inset)
    #expect(TabBarCentring.room(content: long) == TabTokens.closeSpace)
  }

  @Test("the content less the current tab's room stays when the current tab moves, also from a one-character label")
  func restOfTheContent() {
    let contents: [CGFloat] = [200, 1, 200]
    func row(current: Int) -> CGFloat {
      TabBarCentring.span(of: 2, contentWidths: contents, current: current, spacing: 8, leading: 8).upperBound
    }
    // The row grows when the short label takes the "×": that change slides and does not recentre.
    #expect(row(current: 1) > row(current: 0))
    #expect(row(current: 1) - TabBarCentring.room(content: 1) == row(current: 0) - TabBarCentring.room(content: 200))
  }

  @Test("the new current tab's span: the tabs' widths from their content, the spacing, the room on the current one")
  func spanOfTheNewCurrentTab() {
    let contents: [CGFloat] = [60, 70, 80]
    func width(_ index: Int, current: Int?) -> CGFloat {
      TabBarCentring.width(content: contents[index], closes: index == current)
    }
    let current = TabBarCentring.span(of: 1, contentWidths: contents, current: 1, spacing: 8, leading: 8)
    #expect(current.lowerBound == 8 + width(0, current: 1) + 8)
    #expect(current.upperBound - current.lowerBound == width(1, current: 1))
    // The room on an earlier tab moves the later ones; a tab without the "×" adds nothing.
    let after = TabBarCentring.span(of: 2, contentWidths: contents, current: 0, spacing: 8, leading: 8)
    let invite = TabBarCentring.span(of: 2, contentWidths: contents, current: nil, spacing: 8, leading: 8)
    #expect(after.lowerBound - invite.lowerBound == TabBarCentring.room(content: contents[0]))
    #expect(invite.lowerBound == 8 + width(0, current: nil) + 8 + width(1, current: nil) + 8)
    #expect(after.upperBound - after.lowerBound == invite.upperBound - invite.lowerBound)
  }
}
