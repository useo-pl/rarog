// Esc w arkuszu zamyka arkusz: popover i arkusz z klawiaturą sprzętową schodzą
// klawiszem, nie tylko stuknięciem obok. Skrót systemowy „anuluj" (`cancelAction` = Esc) na
// niewidocznym przycisku — arkusz nie dostaje drugiego przycisku zamykania. Przycisk ma rozmiar
// i krycie różne od zera: SwiftUI nie rejestruje skrótów widoków bez ramki. Właściciel: karty.
//
// Wyjątek: okno lazygita (Cmd+G) NIE schodzi Esc-iem — Esc należy do programu (w lazygicie
// to „wróć"). Okno powłoki (Cmd+F) schodzi;
// bajt ESC dla programu w tym oknie dają Cmd+. i klawisz „esc"
// paska. Historia terminala to zwykły arkusz tekstu — Esc ją zamyka, także gdy klawiaturę trzyma terminal pod nią
// (`TerminalScreenViewController.takeEscape`).

import Foundation
import RarogContract

/// Prezentacje, w których Esc ma znaczenie.
public enum EscapePresentation: Sendable, Equatable {
  /// Arkusze i popovery apki (model, git, diff, pigułki, historia terminala).
  case sheet
  /// Okno terminala nad ekranem: rola `popup` (Cmd+F, goła powłoka) albo `lazygit` (Cmd+G) i to, czy program
  /// w oknie żyje (sesja terminala w fazie `live`).
  case terminalPopup(TerminalRole, programAlive: Bool)
}

/// Dokąd idzie Esc.
public enum EscapeRoute: Sendable, Equatable {
  /// Zamyka prezentację.
  case dismiss
  /// Do programu w terminalu (bajt ESC ramką `in`).
  case program
}

public enum EscapePolicy {
  public static func route(for presentation: EscapePresentation) -> EscapeRoute {
    switch presentation {
    case .sheet, .terminalPopup(.popup, _): .dismiss
    // Lazygit: Esc to „wróć" w programie. Bez żywego programu (łączenie, zerwane połączenie) nie ma komu go
    // wysłać, więc Esc zamyka okno, zamiast zostawić człowieka bez wyjścia z klawiatury.
    case let .terminalPopup(_, programAlive): programAlive ? .program : .dismiss
    }
  }
}

/// Okno łaski po zamknięciu prezentacji klawiszem Esc: przez ``window`` kolejny Esc nie przerywa tury
/// i nie odrzuca karty na ekranie pod spodem. Dwa szybkie naciśnięcia miały zamknąć okno, a nie zamknąć okno
/// i przerwać pracę agenta. Stan procesu, nie widoku: zamknięcie i następny Esc obsługują różne ekrany.
@MainActor
public enum EscapeGrace {
  public static let window: TimeInterval = 0.3
  private static var closedAt: Date?

  /// Prezentacja właśnie zeszła po Esc.
  public static func closedByEscape(now: Date = Date()) {
    closedAt = now
  }

  /// Czy Esc w chwili `now` należy jeszcze do zamkniętej prezentacji.
  public static func swallows(now: Date = Date()) -> Bool {
    guard let closedAt else { return false }
    let elapsed = now.timeIntervalSince(closedAt)
    return elapsed >= 0 && elapsed < window
  }

  /// Tylko testy: stan sprzed pierwszego zamknięcia.
  static func reset() {
    closedAt = nil
  }
}

#if os(iOS)
import SwiftUI

extension View {
  /// Esc z klawiatury sprzętowej wywołuje `action` (zwykle zamknięcie tej prezentacji). Okno terminala go
  /// NIE używa: Esc rozstrzyga tam kontroler okna według ``EscapePolicy``.
  func dismissOnEscape(_ action: @escaping () -> Void) -> some View {
    background(alignment: .topLeading) {
      Button {
        EscapeGrace.closedByEscape()
        action()
      } label: {
        Color.clear.frame(width: 1, height: 1)
      }
        .keyboardShortcut(AppShortcut.dismissSheet.keyboardShortcut)
        .buttonStyle(.plain)
        .opacity(0.011)
        .accessibilityHidden(true)
        .allowsHitTesting(false)
    }
  }

  /// Esc i Cmd+W wywołują `action` (zamknięcie arkusza). Cmd+W to systemowe „zamknij okno": bez tego skrótu przy
  /// otwartym arkuszu zamykało scenę apki (iPad, iOS 26.2 i 27), a dla człowieka oknem na
  /// wierzchu jest arkusz. Okno terminala tego nie używa — tam Cmd+W należy do programu.
  func closesOnEscapeAndCommandW(_ action: @escaping () -> Void) -> some View {
    dismissOnEscape(action)
      .background(alignment: .topLeading) {
        Button(action: action) { Color.clear.frame(width: 1, height: 1) }
          .keyboardShortcut(AppShortcut.closeSheet.keyboardShortcut)
          .buttonStyle(.plain)
          .opacity(0.011)
          .accessibilityHidden(true)
          .allowsHitTesting(false)
      }
  }
}
#endif
