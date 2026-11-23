#if os(iOS)
import RarogCore
import SwiftUI

/// Nagłówek prawej kolumny (ekran sesji). Składa się ze slotów w osobnych plikach, każdy ma
/// jednego właściciela i dokłada swoje elementy paska nawigacji sam (pozycja, `toolbar`, wstawki):
/// - `HeaderTitleSlot` — tytuł: projekt · nazwa sesji;
/// - `HeaderStatusSlot` — linia statusu: kontekst, git, pigułki CLI i „w tle";
/// - `HeaderTabsSlot` — zakładki projektu;
/// - `HeaderSessionSlot` — grupa ikon w prawym górnym rogu: „Terminal w oknie",
///   przełącznik prawego panelu, „⋯" i „×" terminala (`TerminalChrome`) i „×" sesji (przycisk projektów), jednym
///   elementem paska
///   (`Views/SessionControl/`).
/// Wstawka dołożona później stoi wyżej: linia statusu jest pod paskiem zakładek, bo mówi o sesji
/// wybranej na pasku. Slot bez treści zwraca widok bez zmian, więc pusty slot nie dotyka układu.
struct SessionHeader: ViewModifier {
  let store: RarogStore
  let selection: String?
  let terminal: TerminalChrome

  func body(content: Content) -> some View {
    content
      .modifier(HeaderTitleSlot(store: store, selection: selection, terminal: terminal))
      .modifier(HeaderStatusSlot(store: store, selection: selection))
      .modifier(HeaderTabsSlot(store: store, selection: selection))
      .modifier(HeaderSessionSlot(store: store, terminal: terminal))
  }
}
#endif
