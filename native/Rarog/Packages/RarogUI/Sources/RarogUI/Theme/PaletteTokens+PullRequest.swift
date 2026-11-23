import Foundation
import RarogContract

/// PR state label in the inspector (`docs/pull-requests.md`): a filled capsule in GitHub's state colours, with
/// the state word in `ink`. The fills start from the Primer "emphasis" colours of GitHub's own PR state label (open
/// `success`, draft `neutral`, merged `done`, closed `danger`) and are muted, because the pure ones glared in the
/// panel (twice: "przydymiłbym trochę kolory", then "jeszcze bardziej stonuj"): dark theme 50 %
/// colour + 50 % #2A2A2A, light theme 60 % colour + 40 % `muted2` (#6B6B73). The word on every fill ≥ 4.5:1
/// (`PaletteContrastTests`). Colour never carries the state alone: the word stays. Owner: panel.
public enum PullRequestStateTokens {
  public static let open = PaletteTokens.Pair(dark: 0x265830, light: 0x3D7C53)
  /// GitHub's grey draft label (`neutral` emphasis #656C76 dark, #59636E light), muted the same way.
  public static let draft = PaletteTokens.Pair(dark: 0x484B50, light: 0x606670)
  public static let merged = PaletteTokens.Pair(dark: 0x5A4088, light: 0x795BB4)
  public static let closed = PaletteTokens.Pair(dark: 0x82302E, light: 0xA73F4A)
  /// The word on the fill: white in the light theme, a softer grey-white in the dark one next to the muted fills.
  public static let ink = PaletteTokens.Pair(dark: 0xE6E6E6, light: 0xFFFFFF)

  public static func fill(_ state: PullRequestState) -> PaletteTokens.Pair {
    switch state {
    case .open: open
    case .draft: draft
    case .merged: merged
    case .closed: closed
    }
  }
}
