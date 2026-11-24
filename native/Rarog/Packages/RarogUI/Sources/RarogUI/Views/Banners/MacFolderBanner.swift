#if os(iOS)
import SwiftUI

// The macOS folder card of the banner strip: the app's banner card with an amber dot, a bold title and a muted second
// line. Which card stands in which column and in what order: `bannerSlots(in:)` in `Model/BannerSlots`; the texts:
// `Copy/UICopy+MacFolders`. Owner: macOS folders (native app).

struct MacFolderBanner: View {
  let card: MacFolderCard

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Circle().fill(Color(uiColor: card.tone.color)).frame(width: 8, height: 8).accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 4) {
        Text(card.title)
          .appFont(.callout.weight(.semibold))
          .foregroundStyle(Color(uiColor: Palette.text))
        Text(card.detail)
          .appFont(.subheadline)
          .foregroundStyle(Color(uiColor: Palette.muted))
      }
      .fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 0)
    }
    .padding(12)
    .background(Color(uiColor: Palette.surface), in: .block)
    .overlay(RoundedRectangle.block.strokeBorder(Color(uiColor: Palette.border)))
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(.isStaticText)
    .accessibilityIdentifier("banner")
  }
}
#endif
