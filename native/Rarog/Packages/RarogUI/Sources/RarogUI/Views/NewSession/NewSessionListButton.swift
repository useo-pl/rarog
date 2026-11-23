#if os(iOS)
import RarogContract
import RarogCore
import SwiftUI

// „Nowa sesja" w pasku listy. Prośbę o arkusz niesie `NewSessionPresenter` ze środowiska
// (`Model/AppSheet.swift`), pokazuje `SheetHost`. Właściciel: sterowanie sesją.

/// „Nowa sesja" w pasku listy, a za nią „Ustawienia” (`SettingsListButton`) — jednym elementem paska, cele co
/// `HeaderMetrics.iconSpacing` jak ikony prawego rogu nagłówka sesji. Dwa osobne elementy paska stałyby co odstęp
/// systemu, za daleko od siebie. Przy zakazie zakładania przycisk jest przygaszony,
/// ale klikalny: formularz mówi powód zdaniem serwera pod „Uruchom". Wygląd jak przyciski nagłówka sesji:
/// cichy glif `HeaderIconButtonStyle` z celem 44 pt, bez systemowej kapsuły szkła.
struct NewSessionListButton: ViewModifier {
  let store: RarogStore
  let navigation: RarogNavigation
  @Environment(NewSessionPresenter.self) private var presenter: NewSessionPresenter?

  /// The pencil glyph's shift from the centre of its target: level with the gear and 9 pt towards it. Moves only the
  /// drawing; the 44 pt target stays in place.
  static let glyphLift: CGFloat = 0
  static let glyphShift: CGFloat = 9
  /// The whole group's shift towards the trailing edge, targets included: the gear's ink stands in one column with
  /// the note glyph of the project headers below (`ProjectTreeHeaderRow`). Measured on an iPad with iOS 27: without
  /// it, the gear's ink centre stood 8.5 pt left of the note's.
  static let groupShift: CGFloat = 8.5

  func body(content: Content) -> some View {
    let blocked = store.state.launchBlocked ? UICopy.launchBlocked(store.state.launchBlockedDetail) : nil
    content
      .toolbar {
        ToolbarItem(placement: .primaryAction) {
          HStack(spacing: HeaderMetrics.iconSpacing) {
            Button {
              presenter?.openNewSession()
            } label: {
              Label(UICopy.newSessionTitle, systemImage: "square.and.pencil")
                .offset(x: Self.glyphShift, y: -Self.glyphLift)
            }
            .buttonStyle(HeaderIconButtonStyle())
            .shortcutTip(UICopy.newSessionTitle, .newSession)
            .opacity(blocked == nil ? 1 : 0.5)
            .accessibilityHint(blocked ?? "")
            .accessibilityIdentifier("list.newSession")
            // Settings: the server, pairing and devices, dictation, the voice agent, text size, language, About.
            SettingsListButton(navigation: navigation)
          }
          .offset(x: Self.groupShift)
        }
        // Cichy glif bez szklanej kapsuły paska — jak ikony w prawym rogu nagłówka sesji (`HeaderSessionSlot`).
        .sharedBackgroundVisibility(.hidden)
      }
  }
}
#endif
