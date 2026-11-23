#if os(iOS)
import RarogCore
import SwiftUI

// Nagłówek listy „AGENCI (N)" w wierszu paska. Właściciel: lista. Łączenie z serwerem mówi
// tylko karta w pasie banerów.
// Kontener listy (`SessionListView`) wpina tytuł w JEDEN element `.principal` paska, który zastępuje
// widoczny tytuł systemu; `.navigationTitle` zostaje dla przełącznika
// okien. Dwa osobne elementy (`.topBarLeading` i `.topBarTrailing`) dzielą pasek na połowy (zmierzone),
// a `.toolbar(removing: .title)` zdejmuje też element `.principal`. Nazwa tailnetu Maca
// stoi w sekcji „Mac" panelu stopki, obok obciążenia Maca.

/// Lewy róg paska listy: „AGENCI (N)" w stylu etykiety sekcji (`Eyebrow`). Zastępuje systemowy duży
/// tytuł: zajmuje osobny wiersz, a jego zwijanie przy przewijaniu haczy na iPhonie.
/// Pasek ma jedną, stałą wysokość.
struct ListHeaderTitle: View {
  let count: Int

  var body: some View {
    Text(UICopy.listTitle(count: count))
      .eyebrow(Palette.listHeaderInk)
      .lineLimit(1)
      .fixedSize()
      // Kapitaliki są tylko dla oka: czytnik słyszy „Agenci (9)" jako nagłówek sekcji.
      .accessibilityLabel(UICopy.listTitle(count: count))
      .accessibilityAddTraits(.isHeader)
      // Identyfikator dla testów i audytu: sufit pisma w pasku nawigacji daje system.
      .accessibilityIdentifier("list.title")
  }
}

#endif
