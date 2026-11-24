#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI

/// Arkusz „Limity” komendy apki `/usage`, `/cost`, `/stats`: na iPadzie dymek przy „Wyślij”, na
/// telefonie arkusz z paskiem tytułu (`popoverSheetChrome`). Wiersze okien limitów:
/// pełna nazwa okna, procent z wagą i kolorem progu, pod spodem „reset 17:20 · za 2 h 44”;
/// nad nimi konto, pod nimi godzina odczytu i zdanie, czego brakuje. Reguły źródeł: ``UsageSheetModel``.
///
/// Odczyt przy każdym otwarciu, bez odpytywania: `GET /api/usage/details` raz (wynik trzyma arkusz) i odświeżenie
/// limitów z paska statusu (`refreshUsageNow`), żeby 5 h i tydzień były z tej chwili. Esc zamyka arkusz.
/// Ekran prezentuje go z `SessionViewController+UsageSheet`. Pod wierszami sekcja maszyny serwera; gdy serwer jest
/// starszy niż wydany z apką, niesie też komendę aktualizacji. The machine section also carries the load from the list footer card: what each
/// number means, no reading and the stale note with the machine's own reading time (`UsageSheet+Machine`).
/// Właściciel: lista.
struct UsageSheet: View {
  let store: RarogStore
  /// Dymek stoi jako arkusz (wąska klasa prezentującego): wysokość daje detent, nie treść.
  var compact = false
  /// Tło `popoverSurface()` stawia sam arkusz (host UIKit). Popover SwiftUI stawia je w swojej treści i podaje `false`
  /// (strażnik `PopoverSurfaceSourceTests`).
  var ownSurface = true
  let dismiss: () -> Void
  @State private var details: UsageDetailsPhase = .loading
  @State private var contentHeight: CGFloat = 0

  var body: some View {
    ScrollView {
      content.onGeometryChange(for: CGFloat.self) { $0.size.height } action: { contentHeight = $0 }
    }
    .scrollBounceBehavior(.basedOnSize)
    .popoverLayout(contentHeight: contentHeight, ceiling: compact ? nil : PopoverLayout.ceiling)
    .popoverSheetChrome(title: UICopy.usageSheetTitle)
    .modifier(OwnSurface(enabled: ownSurface))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("usage.sheet")
    .dismissOnEscape(dismiss)
    .task {
      store.refreshUsageNow()
      details = UsageDetailsPhase(await store.loadUsageDetails(), receivedAt: Date())
    }
    // The UIKit island presents this view as the hosting root (its tests read the root's type), so the text size
    // host stands here rather than around the root.
    .textScaleHost(Fonts.scale)
  }

  private var content: some View {
    TimelineView(.periodic(from: .now, by: 1)) { context in
      let model = UsageSheetModel.make(
        usage: store.state.planUsage, details: details, now: context.date, machine: store.state.serverMachine,
        update: store.state.serverUpdate,
        load: MacLoadModel.make(store.state.macLoad, tailnet: store.state.tailnet, machine: store.state.serverMachine))
      VStack(alignment: .leading, spacing: Self.rhythm) {
        if !PopoverLayout.sheetBar {
          // Dymek iPada nie ma paska tytułu: nazwę niesie etykieta sekcji (jak dymek promptów).
          Text(UICopy.usageSheetTitle)
            .eyebrow()
            .accessibilityAddTraits(.isHeader)
        }
        if let account = model.account {
          HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: "person.crop.circle").foregroundStyle(Color(uiColor: Palette.muted))
            Text(account)
              .foregroundStyle(Color(uiColor: Palette.text))
              .lineLimit(1)
              .truncationMode(.middle)
          }
          .appFont(.footnote)
          .accessibilityElement(children: .ignore)
          .accessibilityLabel("\(UICopy.usageAccountLabel): \(account)")
        }
        if model.loading {
          HStack(spacing: 8) {
            ProgressView()
            Text(UICopy.usagePanelLoading).appFont(.footnote).foregroundStyle(Color(uiColor: Palette.muted))
          }
        }
        ForEach(model.segments) { segment in
          row(segment, model: model, now: context.date)
        }
        ForEach(model.notes, id: \.self) { note in
          Text(note)
            .appFont(.caption)
            .foregroundStyle(Color(uiColor: Palette.muted))
            .fixedSize(horizontal: false, vertical: true)
        }
        if let section = model.machine {
          UsageMachineSection(section: section)
            // Section boundary: one and a half rhythms instead of a line (the sheet has no lines).
            .padding(.top, Self.rhythm / 2)
        }
      }
      .padding(PopoverLayout.contentInset)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  /// One vertical rhythm: between rows, notes and sections.
  static let rhythm: CGFloat = 12

  private func row(_ segment: UsageSegment, model: UsageSheetModel, now: Date) -> some View {
    VStack(alignment: .leading, spacing: 3) {
      HStack(alignment: .firstTextBaseline) {
        Text(segment.full).foregroundStyle(Color(uiColor: Palette.text))
        Spacer(minLength: 8)
        Text("\(segment.percent)%")
          .monospacedDigit()
          .fontWeight(UsageInk.weight(segment.tone))
          .foregroundStyle(Color(uiColor: UsageInk.color(segment.tone)))
      }
      .appFont(.footnote)
      if let reset = model.resetLine(segment, now: now) {
        Text(reset)
          .appFont(.caption.monospacedDigit())
          .foregroundStyle(Color(uiColor: Palette.muted))
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(model.rowSpoken(segment, now: now))
    .accessibilityIdentifier("usage.sheet.\(segment.id)")
  }
}

/// `popoverSurface()` tylko wtedy, gdy arkusz stawia tło sam (``UsageSheet/ownSurface``).
private struct OwnSurface: ViewModifier {
  let enabled: Bool

  func body(content: Content) -> some View {
    if enabled { content.popoverSurface() } else { content }
  }
}
#endif
