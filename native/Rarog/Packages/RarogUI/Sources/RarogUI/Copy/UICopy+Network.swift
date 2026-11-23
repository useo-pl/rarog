import Foundation
import RarogContract
import RarogCore

// Copy łączności: lista z pamięci podręcznej. Właściciel: łączność.
extension UICopy {
  // MARK: Lista z pamięci podręcznej

  /// Wiersz listy z pamięci podręcznej — dla czytnika (wzrok widzi wygaszenie i stojący zegar).
  public static var cachedRowSpoken: String { L("network.cachedRowSpoken") }
  /// Pole wiadomości do świeżego stanu: zero akcji na obrazie sprzed uśpienia.
  public static var staleComposer: String { L("network.staleComposer") }
  /// Kontrolka sesji przed świeżym stanem (pigułki modelu i trybu, „Ponów"): wyciszona, ale tap i czytnik
  /// mówią to zdanie — rdzeń i tak odmówiłby w bramce.
  public static var staleAction: String { L("network.staleAction") }

  // MARK: Dymek o innej sesji — słownik pushy (`shared/src/notify-copy.ts`)

  static func signalKind(_ kind: SessionSignal.Kind) -> String {
    switch kind {
    case .permission: L("network.signalKind.permission")
    case .question: L("network.signalKind.question")
    case .error: L("network.signalKind.error")
    case .limit: L("network.signalKind.limit")
    case .done: L("network.signalKind.done")
    }
  }

  /// „projekt · sesja" (bez etykiety sam projekt).
  static func signalPlace(_ session: SessionSummary) -> String {
    let label = (session.label ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    return label.isEmpty ? session.title : list([session.title, label], .dot)
  }

  /// Podpowiedź czytnika dla dymka z sesją.
  static var toastOpenHint: String { L("network.toastOpenHint") }
  /// Nazwa przycisku zamykającego komunikat apki.
  static var toastClose: String { L("network.toastClose") }

  // MARK: Banery

  /// „herdr niedostępny": wiek najświeższego znanego stanu, a bez
  /// niego zdanie serwera albo zdanie ogólne.
  static func herdrUnavailable(detail: String?, staleSince: String?, now: Date) -> String {
    if let since = staleSince.flatMap(ServerTime.parse) {
      return L("network.herdrUnavailable.staleSince", RelativeTime.short(since: since, now: now))
    }
    return detail.map { L("network.herdrUnavailable.detail", $0) } ?? L("network.herdrUnavailable")
  }
}
