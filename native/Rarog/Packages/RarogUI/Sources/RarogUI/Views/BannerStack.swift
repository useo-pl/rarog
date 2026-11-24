#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI

// Banery listy i transkryptu. Właściciel: łączność. Co stoi w której
// kolumnie i w jakiej kolejności: `Model/BannerSlots`. The macOS folder card is drawn by `Banners/MacFolderBanner`.

/// Banery jako karty, nigdy modal ani blokada ekranu; jedna awaria = jeden baner.
/// Pusty pas nie zajmuje miejsca.
struct BannerStack: View {
  /// The cards in their order: app banners and macOS folder cards (`bannerSlots(in:)`).
  let slots: [BannerSlot]
  /// Zaproszenie „Włącz powiadomienia" na końcu pasa (`Banners/PushBanner`); `nil` = nie stoi.
  var pushPrompt: RarogStore?
  /// Notki „Nowe urządzenie: …” (trwały ślad parowania) — tylko w kolumnie listy; `nil` = nie stoją.
  var deviceNotices: RarogStore?

  /// The moment of the last repaint by the strip's own clock: changing it evaluates the body again.
  @State private var clock = Date()

  var body: some View {
    // The connecting card waits for its moment (start, return from the background, the viewed session's stream): one
    // task sleeps until then and repaints the strip once; with no card waiting there is no task. A `TimelineView`
    // with an explicit schedule never advanced to the card's entry on the iOS 27 simulator (the card came in only
    // with another change of the input), and a running ticker would keep repainting while the card stands.
    // The task lives on a zero-size view that always stands: while the card waits, the strip itself may be empty.
    let due = slots.pendingUntil(Date())
    VStack(spacing: 0) {
      Color.clear.frame(width: 0, height: 0)
        .accessibilityHidden(true)
        .task(id: due) {
          guard let due else { return }
          try? await Task.sleep(for: .seconds(max(0, due.timeIntervalSinceNow)))
          guard !Task.isCancelled else { return }
          clock = max(Date(), due)
        }
      strip(slots.visible(at: max(clock, Date())))
    }
  }

  @ViewBuilder
  private func strip(_ slots: [BannerSlot]) -> some View {
    let notices = deviceNotices?.state.pairing.newDevices ?? []
    if !slots.isEmpty || pushPrompt != nil || !notices.isEmpty {
      VStack(spacing: 8) {
        // Tożsamość po miejscu: szara karta łączenia i czerwona „Serwer nie odpowiada” stoją w tym samym miejscu,
        // więc po nieudanej próbie zmienia się kolor i zdanie tej samej karty, a nie wchodzi druga.
        ForEach(Array(slots.enumerated()), id: \.offset) { _, slot in
          switch slot {
          case let .banner(banner): BannerCard(banner: banner)
          case let .macFolders(card): MacFolderBanner(card: card)
          }
        }
        if let deviceNotices {
          ForEach(notices) { notice in NewDeviceBanner(store: deviceNotices, notice: notice) }
        }
        if let pushPrompt { PushPromptBanner(store: pushPrompt) }
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
    }
  }
}

struct BannerCard: View {
  let banner: Banner

  var body: some View {
    // Zdanie z wiekiem („stany sprzed 4 min") odświeża się samo; reszta banerów stoi.
    TimelineView(.periodic(from: .now, by: 15)) { timeline in
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Circle().fill(Color(uiColor: banner.tone.color)).frame(width: 8, height: 8).accessibilityHidden(true)
        Text(UICopy.banner(banner, now: timeline.date))
          .appFont(.callout)
          .foregroundStyle(Color(uiColor: Palette.text))
          .fixedSize(horizontal: false, vertical: true)
        Spacer(minLength: 0)
      }
    }
    .padding(12)
    .background(Color(uiColor: Palette.surface), in: .block)
    .overlay(RoundedRectangle.block.strokeBorder(Color(uiColor: Palette.border)))
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(.isStaticText)
    .accessibilityIdentifier("banner")
  }
}

extension BannerTone {
  /// The dot's colour (`Banner.tone`, `MacFolderCard.tone`, `Model/BannerSlots`): red = something does not arrive or
  /// the version blocks changes; gray = information, the connecting card too; amber = something waits for the human,
  /// as the Mac waits for a click in the macOS folder card.
  var color: UIColor {
    switch self {
    case .failure: Palette.err
    case .info: Palette.done
    case .wait: Palette.wait
    }
  }
}
#endif
