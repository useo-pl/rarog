#if os(iOS)
import RarogCore
import SwiftUI

// Zastępnik karty decyzji w okresie łaski (`DecisionGraceTiming`): sesja już czeka, a karta z treścią
// jeszcze idzie strumieniem sesji (kanał hooka mediana 614 ms, driver ok. 1,3 s). Zamiast karty zapasowej z „Odrzuć
// dialog”, która migała i pod przypadkowym tapnięciem przerywała turę (Esc), stoi spokojna powierzchnia karty bez
// przycisków: kółko postępu i jedno zdanie. Czytnik go nie ogłasza ani nie czyta — ogłasza dopiero kartę, która go
// zastąpi. Właściciel: karty.
//
// Gdzie stoi: bez doku (tryb `.transcript` i `.readOnlyComposer`, `DecisionDock.mode`) ostatni wiersz ogona transkryptu
// (`TranscriptRow.decisionPending`); w doku (tryb `.dock`) — przy pustej kolejce `.decision([])` z `FootContent.make`,
// gdy `AppState.decisionLoading(for:now:)` mówi `true`.
struct DecisionPendingView: View {
  /// Wysokość zbliżona do karty decyzji w spoczynku (karta zapasowa: nagłówek, zdanie, stopka z przyciskami), żeby
  /// przyjście karty nie przesuwało transkryptu o całą jej wysokość.
  static let minHeight: CGFloat = 120

  var body: some View {
    HStack(spacing: 10) {
      ProgressView()
        .controlSize(.small)
        .tint(Color(uiColor: Palette.muted))
      Text(UICopy.decisionPending)
        .appFont(.subheadline)
        .foregroundStyle(Color(uiColor: Palette.muted))
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(.horizontal, 12)
    .frame(maxWidth: .infinity, minHeight: Self.minHeight)
    .cardSurface()
    .padding(.vertical, 8)
    .accessibilityHidden(true)
  }
}
#endif
