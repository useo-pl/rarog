import CoreGraphics
@testable import RarogUI
import Testing

// Odstępy kolumny listy. Właściciel: kontener listy.

@Suite("kolumna listy: nagłówek projektu i nagłówek listy")
struct SessionListMetricsTests {
  /// Nagłówek projektu w drzewie ma miarę wiersza projektu: cel dotyku co najmniej 44 pt.
  @Test("nagłówek projektu: cel dotyku co najmniej 44 pt, wiersz z gałęzią rośnie ponad podłogę")
  func projectRowHeight() {
    #expect(SessionListMetrics.projectRowMinHeight >= 44)
    // Wiersz z gałęzią (dwie linie: ~20 + 2 + ~16 pt) rośnie z odstępem ponad podłogę, bez gałęzi trzyma ją podłoga.
    let withMeta: CGFloat = 20 + 2 + 16
    #expect(withMeta + SessionListMetrics.projectRowPadding + SessionListMetrics.projectRowBottomPadding
            > SessionListMetrics.projectRowMinHeight)
  }

  /// Pasek listy bez systemowego uchwytu: nagłówek ma minimum większe niż miejsce symetryczne wokół środka
  /// paska (inaczej pasek go centrował, „AGENCI” od 69 pt zamiast 16), ale mieści się przed „Nową sesją”.
  @Test("nagłówek listy przy lewej krawędzi: minimum z szerokości kolumny, nigdy pod przyciskiem")
  func headerMinWidth() {
    // iPad Pro 11": kolumna 320 pt, nagłówek od 16 pt.
    // Przycisk „Nowa sesja” to glif w celu 44 pt bez kapsuły, a przed nim „Ustawienia” (drugi cel
    // 44 pt, od ~226 pt). Położenie na żywo pilnuje `SplitChromeUITests`.
    let width = SessionListMetrics.headerMinWidth(columnWidth: 320)
    #expect(width == 192)
    #expect(16 + width <= 226 - 8, "przed pierwszym przyciskiem z odstępem")
    // Środek paska 160 pt, prawa granica miejsca 218 pt: symetrycznie mieści się najwyżej 2 × 58 pt.
    #expect(width > 2 * (218 - 160), "szerzej niż miejsce symetryczne — pasek nie centruje")
    #expect(SessionListMetrics.headerMinWidth(columnWidth: 0) == 0, "kolumna niezmierzona")
    #expect(SessionListMetrics.headerMinWidth(columnWidth: 460) == 332, "największe pismo: kolumna szersza")
  }

  /// The waveform glyph of the voice conversation across sessions is a third 44 pt target before New Session: the
  /// header's minimum leaves it room, or "AGENCI" slides past the left edge, and stays wider than the symmetric room.
  @Test("list header with the voice button: room for one more target, still at the leading edge")
  func headerMinWidthWithVoiceButton() {
    for column in [CGFloat(320), 402] {
      let two = SessionListMetrics.headerMinWidth(columnWidth: column)
      let three = SessionListMetrics.headerMinWidth(columnWidth: column, voiceButton: true)
      let target = HeaderMetrics.iconTarget + HeaderMetrics.iconSpacing
      #expect(three <= two - target, "\(column): one more target and its spacing")
      // The first button starts one target earlier; the bar centres the header only when it fits symmetrically.
      let firstButton = 16 + two + 8 - target
      #expect(16 + three <= firstButton - 8, "\(column): before the voice button with a gap")
      #expect(three > 2 * (firstButton - 8 - column / 2), "\(column): wider than the symmetric room")
    }
  }
}
