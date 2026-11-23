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
}
