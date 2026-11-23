import Foundation

// Powtarzanie strzałek klawiatury sprzętowej w terminalu. SwiftTerm 1.19.0 powtarza strzałki własnym zegarem
// 0,4 s + co 0,1 s (10/s), wolniej niż Backspace, a
// Backspace idzie systemowym `deleteBackward` w tempie systemu. Powierzchnia (`SwiftTermSurface`) przejmuje więc
// strzałkę sama: pierwsze bajty od razu, seria po ``delay`` w takcie ``interval`` (~30/s). Puszczenie klawisza
// dochodzi do KONTENERA powierzchni (`pressesEnded` SwiftTerm nie jest `open`, ale woła `super`), a reszta dróg
// zatrzymania to zapasy — ``TerminalKeyRepeatStop``. Ślad końca serii idzie do `client.log` BEZ treści klawiszy:
// sam powód, liczba powtórzeń i czas. Logika bez UIKit testuje się na macOS.
// Właściciel: terminal.

/// Stałe powtarzania strzałek.
public enum TerminalKeyRepeat {
  /// Pauza przed serią — krócej niż 0,4 s SwiftTerm, tyle co klawiatura systemowa przy szybkim ustawieniu.
  public static let delay: Duration = .milliseconds(300)
  /// Takt serii: ~30 strzałek na sekundę.
  public static let interval: Duration = .milliseconds(33)
  /// Sufit przytrzymania: ostatnia linia obrony, gdy żadna droga puszczenia nie doszła — nie obsługa puszczenia.
  public static let ceiling: Duration = .seconds(20)
}

/// Dlaczego seria strzałki stanęła.
public enum TerminalKeyRepeatStop: String, Sendable, CaseIterable {
  /// `pressesEnded` z tym samym kodem klawisza doszedł do kontenera powierzchni — droga główna.
  case released
  /// `pressesCancelled` (system zabrał zdarzenie, np. skrót systemowy).
  case cancelled
  /// Naciśnięty inny klawisz (SwiftTerm nie woła `super` dla obsłużonych klawiszy, więc kontener go nie widzi).
  case newKey
  /// Powierzchnia oddała fokus klawiatury.
  case resigned
  /// Powierzchnia zeszła z okna.
  case detached
  /// Ekran zwolnił renderer (`close()`).
  case closed
  /// Scena traci aktywność (inna apka, tło, przełącznik apek).
  case sceneInactive
  /// Klawiatura sprzętowa odłączona.
  case keyboardDisconnected
  /// Zapas: `GCKeyboard` mówi „puszczony" po wcześniejszym „wciśnięty" w tym samym przytrzymaniu.
  case gameController
  /// Zapas ostateczny: sufit ``TerminalKeyRepeat/ceiling``.
  case ceiling

  /// Droga zapasowa: przy niej kontener NIE dostał puszczenia (sprawdzane na iPadzie).
  public var isFallback: Bool { self == .gameController || self == .ceiling }

  var phrase: String {
    switch self {
    case .released: "klawisz puszczony (pressesEnded kontenera)"
    case .cancelled: "zdarzenie anulowane (pressesCancelled)"
    case .newKey: "inny klawisz"
    case .resigned: "fokus odszedł"
    case .detached: "powierzchnia zeszła z okna"
    case .closed: "ekran zamknięty"
    case .sceneInactive: "scena nieaktywna"
    case .keyboardDisconnected: "klawiatura odłączona"
    case .gameController: "zapas GCKeyboard — kontener nie dostał puszczenia"
    case .ceiling: "sufit 20 s — kontener nie dostał puszczenia"
    }
  }
}

/// Koniec jednej serii strzałki: powód, liczba powtórzeń po pierwszych bajtach i czas trzymania.
public struct TerminalKeyRepeatEnd: Sendable, Equatable {
  public var reason: TerminalKeyRepeatStop
  public var repeats: Int
  public var heldMilliseconds: Int

  public init(reason: TerminalKeyRepeatStop, repeats: Int, heldMilliseconds: Int) {
    self.reason = reason
    self.repeats = repeats
    self.heldMilliseconds = heldMilliseconds
  }

  /// „terminal: seria strzałki stanęła — klawisz puszczony (pressesEnded kontenera); 812 ms, 16 powtórzeń" — bez
  /// klawisza i bez kierunku.
  public var traceLine: String {
    "terminal: seria strzałki stanęła — \(reason.phrase); \(max(0, heldMilliseconds)) ms, \(max(0, repeats)) powtórzeń"
  }
}

/// Które końce serii trafiają do `client.log`: budżet śladów jest wspólny dla apki (20 na godzinę), więc
/// tylko to, co rozstrzyga hipotezę z iPada. Każdy koniec drogą zapasową (kontener NIE dostał puszczenia)
/// i pierwsze ``confirmations`` serii z powtórzeniami zakończonych drogą główną; reszta milczy.
public struct TerminalKeyRepeatTraceBudget: Sendable, Equatable {
  public static let confirmations = 3
  public static let fallbacks = 5
  private var confirmed = 0
  private var fellBack = 0

  public init() {}

  /// `true` = zapisać ślad tego końca (i odliczyć go z budżetu).
  public mutating func admit(_ end: TerminalKeyRepeatEnd) -> Bool {
    if end.reason.isFallback {
      guard fellBack < Self.fallbacks else { return false }
      fellBack += 1
      return true
    }
    guard end.reason == .released, end.repeats > 0, confirmed < Self.confirmations else { return false }
    confirmed += 1
    return true
  }
}
