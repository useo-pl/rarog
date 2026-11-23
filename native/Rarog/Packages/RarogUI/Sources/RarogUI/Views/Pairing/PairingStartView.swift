#if os(iOS)
import RarogCore
import SwiftUI

// Ekran bez zalogowania. Apka nie ma logowania tokenem: jedyna droga do
// serwera to parowanie. Co stoi, rozstrzyga powód wylogowania:
// - odpięte urządzenie (401 `device-revoked`) → „To urządzenie odpięto <data> (<przez>)” — przeżywa restart apki;
// - klucz nieznany serwerowi → „Serwer nie rozpoznał tego urządzenia” z ponowieniem (klucz zostaje);
// - bez klucza → ekran parowania.
// Każdy wariant ma kontrolki parowania, kartę „Sparować z <host>?” (`PairingControls`) i pod nimi trzy linki
// produktu (`ProductLinksRow`: polityka prywatności, instrukcja serwera, wsparcie). W trakcie „Zapomnij serwer”
// (serwer odpina urządzenie przed odpowiedzią, więc ekran bez zalogowania staje wcześniej) — sam ekran „Zapominam
// serwer…”: parowanie albo ponowienie klucza przed końcem sprzątania zostałoby nim skasowane (rdzeń też odmawia).

struct PairingStartView: View {
  let store: RarogStore
  let reason: LogoutReason

  var body: some View {
    let pairing = store.state.pairing
    switch reason {
    case _ where pairing.forgetting:
      ForgettingScreen()
    case .deviceRevoked:
      PairingScreen(
        store: store, title: UICopy.revokedTitle,
        lead: pairing.revoked.map { UICopy.revokedBody($0, store.state.serverMachine) } ?? UICopy.pairLead, leadTone: Palette.wait,
        identifier: "pair.revoked")
    case .deviceUnknown:
      PairingScreen(
        store: store, title: UICopy.unknownTitle, lead: UICopy.unknownBody, leadTone: Palette.wait,
        identifier: "pair.unknown", retry: { store.retryDeviceKey() })
    case .notLoggedIn:
      PairingScreen(
        store: store, title: UICopy.pairTitle, lead: UICopy.pairLead, leadTone: Palette.muted,
        identifier: "pair.start")
    }
  }
}

/// The pairing screen column: logo, title, paragraph (the `rarog pair` command in code type), controls, product
/// links. No app name above the title: the screen is already inside the app, and the title says what to do here.
/// The logo is the app's only branding (HIG "Launching": a splash belongs at the start of onboarding, not on the
/// launch screen); hidden from VoiceOver.
private struct PairingScreen: View {
  let store: RarogStore
  let title: String
  let lead: String
  let leadTone: UIColor
  let identifier: String
  var retry: (() -> Void)?

  var body: some View {
    ZStack {
      Color(uiColor: Palette.background).ignoresSafeArea()
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          RarogLogo()
          Text(title)
            .appFont(.title2.weight(.semibold))
            .foregroundStyle(Color(uiColor: Palette.text))
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier("\(identifier).title")
          Text(UICopy.pairCommandCode(lead))
            .appFont(.body)
            .foregroundStyle(Color(uiColor: leadTone))
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("\(identifier).lead")
          if let retry {
            Button(UICopy.unknownRetry, action: retry)
              .buttonStyle(PrimaryButtonStyle())
              .accessibilityIdentifier("pair.retryKey")
          }
          PairingFlowCard(store: store)
          PairingActions(store: store)
          ProductLinksRow()
            .padding(.top, 8)
        }
        .padding(24)
        .frame(maxWidth: 416)
        .frame(maxWidth: .infinity)
      }
      .defaultScrollAnchor(.center, for: .alignment)
      .scrollBounceBehavior(.basedOnSize)
    }
    .accessibilityIdentifier(identifier)
  }
}

/// „Zapomnij serwer” w drodze: tytuł, zdanie i wskaźnik — bez kontrolek parowania i ponowienia.
private struct ForgettingScreen: View {
  var body: some View {
    ZStack {
      Color(uiColor: Palette.background).ignoresSafeArea()
      VStack(alignment: .leading, spacing: 16) {
        Text(UICopy.forgettingTitle)
          .appFont(.title2.weight(.semibold))
          .foregroundStyle(Color(uiColor: Palette.text))
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityAddTraits(.isHeader)
        Text(UICopy.forgettingBody)
          .appFont(.body)
          .foregroundStyle(Color(uiColor: Palette.muted))
          .fixedSize(horizontal: false, vertical: true)
        ProgressView()
      }
      .padding(24)
      .frame(maxWidth: 416)
      .frame(maxWidth: .infinity)
    }
    .accessibilityIdentifier("pair.forgetting")
  }
}

/// The app icon as a tile: the `RarogLogo` vector from the app's asset catalog (`Rarog/AppIcon.icon` flattened, with
/// the icon's dark background, so it reads in light and dark mode), continuous corners like the Home Screen icon.
private struct RarogLogo: View {
  private let side: CGFloat = 64

  var body: some View {
    Image("RarogLogo", bundle: .main)
      .resizable()
      .frame(width: side, height: side)
      .clipShape(RoundedRectangle(cornerRadius: side * 0.2237, style: .continuous))
      .accessibilityHidden(true)
  }
}

#endif
