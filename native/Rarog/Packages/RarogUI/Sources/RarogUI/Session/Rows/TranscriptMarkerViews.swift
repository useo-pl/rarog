#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI

// Metadane transkryptu: rozwijak serii narzędzi, godzina po przerwie, linia „NOWE".
// Wyglądają jak podpis, nie jak przycisk; tylko linia „NOWE" mówi błękitem „nieodebrane", jak lista.
// Właściciel: transkrypt.

/// Rozwijak zwiniętej serii: „⋯ wcześniejsze kroki (N)" nad najnowszym krokiem. To wiersz karty
/// sąsiednich narzędzi — ta sama plama, kreska na styku, bez odstępu od kroków pod nim i (rozwinięty) nad nim.
struct ToolRunChipView: View {
  let model: ToolRunModel
  let toggle: () -> Void

  var body: some View {
    RowFrame(voice: model.voice, gap: model.turn.gap, chain: model.chain) {
      Button(action: toggle) {
        HStack(spacing: 6) {
          Image(systemName: model.expanded ? "chevron.down" : "ellipsis")
            .imageScale(.small)
            .frame(width: 14)
          Text(verbatim: UICopy.toolRunLabel(hidden: model.hidden, expanded: model.expanded))
        }
        .appFont(.footnote.monospaced())
        .padding(.horizontal, 12)
        .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
        .contentShape(Rectangle())
      }
      .buttonStyle(ToolRunPressStyle())
      .accessibilityLabel(UICopy.toolRunLabel(hidden: model.hidden, expanded: model.expanded))
      .accessibilityValue(model.expanded ? UICopy.disclosureExpanded : UICopy.disclosureCollapsed)
      .accessibilityIdentifier("transcript.toolRun")
      .toolCardBackground(model.chain)
    }
  }
}

/// Separator czasu nad wiadomością: `— HH:MM —` po przerwie albo `— pt. 9 paź —` przy
/// zmianie dnia. Tło informacji, bez interakcji.
struct TimeGapView: View {
  let mark: TimeMark
  var gap: TurnGap = .flow
  @Environment(\.transcriptSpacing) private var spacing

  var body: some View {
    Text(verbatim: UICopy.timeGap(mark))
      .appFont(.caption.monospaced())
      .foregroundStyle(Color(uiColor: Palette.muted2))
      .frame(maxWidth: .infinity, alignment: .center)
      .padding(.top, markerTop(gap, spacing))
      .padding(.bottom, spacing.rowBottom)
      .accessibilityLabel(UICopy.timeGapSpoken(mark))
      .accessibilityIdentifier("transcript.timeGap")
  }
}

/// Linia „NOWE": błękit `new` — ten sam, którym lista mówi „nieodebrane",
/// bo szarej linii po przerwie nie widać. Kreska w kryciu `newMarkerRuleAlpha`, napis w pełnym kolorze i o stopień
/// grubiej niż godzina po przerwie, bo tej linii się SZUKA. Bez ruchu i bez godziny: mówi, gdzie skończyło się czytanie.
struct NewMarkerView: View {
  var gap: TurnGap = .flow
  @Environment(\.transcriptSpacing) private var spacing

  var body: some View {
    HStack(spacing: 8) {
      rule
      Text(verbatim: UICopy.newMarker.uppercased())
        .appFont(.caption.monospaced().weight(.semibold))
        .tracking(0.8)
        .foregroundStyle(Color(uiColor: Palette.new))
      rule
    }
    .padding(.top, markerTop(gap, spacing))
    .padding(.bottom, spacing.rowBottom)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(UICopy.newMarker)
    .accessibilityIdentifier("transcript.new")
  }

  private var rule: some View {
    Rectangle().fill(Color(uiColor: Palette.new).opacity(PaletteTokens.newMarkerRuleAlpha)).frame(height: 1)
      .frame(maxWidth: .infinity)
  }
}

/// The gap above a marker: the turn boundary when the marker is the first row of a message block, otherwise the
/// density's marker gap.
private func markerTop(_ gap: TurnGap, _ spacing: TranscriptSpacing) -> CGFloat {
  gap.points(spacing) ?? spacing.marker
}

/// Wyciszony napis-przycisk: pod palcem i wskaźnikiem pełny kontrast (reakcją jest kolor, nie geometria), jak
/// `.tool-call > summary:hover` w PWA.
private struct ToolRunPressStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .rarogHover(.ink(rest: configuration.isPressed ? Palette.text : Palette.muted2))
  }
}
#endif
