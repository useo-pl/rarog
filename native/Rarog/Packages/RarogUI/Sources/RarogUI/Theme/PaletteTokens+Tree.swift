import Foundation

/// Nagłówek projektu w drzewie listy — własne tokeny. Nagłówek stoi na tle kolumny (`background`), nie na karcie; plamy pod
/// wskaźnikiem i fokusem są te same co wiersza agenta (`surface2`, `HoverTokens.agentRow`). Kontrast w obu motywach:
/// `ProjectTreeTokensTests`. Właściciel: lista.
extension PaletteTokens {
  /// Nazwa projektu (pismo mono, półgrube).
  public static let treeHeaderName = text
  /// Gałąź i ścieżka — jak metadane karty, na tle kolumny ≥ 4,5:1.
  public static let treeHeaderMeta = muted2
  /// The agent count in brackets after the name, "(10)", dimmed relative to the project
  /// name: text, so ≥ 4.5:1 on the column, on the sidebar and on the header's plates; quiet like the branch below.
  /// The light value is a step darker than `muted2`: the first header's count stands in the fringe of the floating
  /// filter glass's shadow, where `muted2` fell to 4.49:1 on the sidebar.
  public static let treeHeaderCount = Pair(dark: muted2.dark, light: 0x66666E)
  /// Strzałka zwijania: grafika (≥ 3:1), cicha jak metadane.
  public static let treeChevron = muted2
  /// Prowadnica drzewa: kreska włoskowata od strzałki do ostatniego agenta projektu.
  /// Grafika DEKORACYJNA, jak `border`: grupę niosą też wcięcie agentów i oddech między projektami, więc reguła
  /// „grafika ≥ 3:1” jej nie dotyczy. Pasmo 1,15–1,40:1 na tle kolumny (≥ 1,10:1 na plamie `surface2` — dziś tylko
  /// plama wskaźnika nagłówka; plama agenta zaczyna się za kreską) pilnuje, żeby nikt jej nie podbił do kreski, która
  /// tnie listę, ani nie zgasił. Historia: #404046 / #C4C4CA (1,92:1 i 1,56:1 na tle) → „delikatniejsza
  /// linia” #303035 / #D1D1D6 → „linie pionowe zrób 30% mniej widoczne”: każdy kanał 30% bliżej tła kolumny
  /// (ciemny R: 10 + 0,7 × 38 = 37), 1,30:1 i 1,24:1 na tle.
  public static let treeGuide = Pair(dark: 0x252528, light: 0xDBDBE0)
  /// The active project's guide, the project on screen, brighter than the others. Still
  /// decoration: below 3:1, above `treeGuide`.
  public static let treeGuideActive = Pair(dark: 0x55555C, light: 0xA5A5AD)
}
