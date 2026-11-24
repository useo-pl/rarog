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

/// The list bar's one `.principal` item: "AGENTS (N)" at the leading edge, in every state of the voice conversation
/// across sessions. It reads that conversation in its own body only for the room before New Session, where the
/// waveform glyph or the lit circle stands (`VoiceAgentSessionsListButton`), so a change of the state redraws this
/// line and not the list.
struct ListHeaderLine: View {
  let count: Int
  /// The list column's width (`ListColumnGeometry`).
  let columnWidth: CGFloat
  @Environment(\.voiceAgentSessionsFeed) private var feed
  @Environment(VoiceAgentSessionsConversation.self) private var owner: VoiceAgentSessionsConversation?

  var body: some View {
    let voiceButton = VoiceAgentSessionsListHeader.make(
      content: feed?.content, action: owner.map(VoiceAgentSessionsListAction.of)
    ).trailing != .none
    HStack(spacing: 0) {
      ListHeaderTitle(count: count)
      Spacer(minLength: 0)
    }
    // Bez systemowego uchwytu pasek centrował ten element, kiedy mieścił się symetrycznie, i „AGENCI”
    // odjeżdżało od lewej krawędzi (16 → 69 pt). Minimum szersze niż miejsce symetryczne trzyma go przy lewej.
    // The minimum leaves room for the target of the waveform glyph or the lit circle while either stands.
    .frame(
      minWidth: SessionListMetrics.headerMinWidth(columnWidth: columnWidth, voiceButton: voiceButton),
      idealWidth: 2_000,
      maxWidth: .infinity)
  }
}

#endif
