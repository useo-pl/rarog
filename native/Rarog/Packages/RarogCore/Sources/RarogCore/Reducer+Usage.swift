import Foundation
import RarogContract

// Limity planu i sonda możliwości serwera (flagi `GET /api/version`).
// Właściciel: aktywność i lista. Gałęzie reduktora wołane z głównego `switch` w `Reducer.swift`.

/// Stan linii limitów planu. Linia nigdy nie znika i nie zmienia wysokości: szkielet przy
/// ładowaniu, „niedostępne" bez liczb, ostatnie liczby przygaszone po nieudanym odświeżeniu.
public struct PlanUsageState: Sendable, Equatable {
  public enum Phase: Sendable, Equatable {
    /// Pierwszy odczyt w drodze — szkielet.
    case loading
    /// Serwer nie wie (503) albo odczyt padł, zanim cokolwiek przyszło — szkielet, ponowienie co minutę.
    case unavailable
    /// Liczby świeże.
    case ready
    /// Liczby są, ale nie z tej chwili: serwer oddał ostatni dobry odczyt (`stale`) albo nasze
    /// odświeżenie padło na sieci.
    case stale
  }

  /// Ostatnie liczby z serwera; `nil` = żadnych (szkielet).
  public internal(set) var usage: PlanUsage?
  /// Kiedy liczby przyszły — godzina „Odczyt z", gdy serwer nie podał własnej (`fetchedAt`).
  public internal(set) var receivedAt: Date?
  /// Ostatnie odświeżenie padło na sieci; liczby zostają w pełnym kontraście ze znakiem zegara.
  public internal(set) var refreshFailed = false
  /// Bez liczb: serwer powiedział „nie wiem" (503) albo pierwsza próba padła.
  public internal(set) var unavailable = false

  public init() {}

  public var phase: Phase {
    guard let usage else { return unavailable ? .unavailable : .loading }
    return refreshFailed || usage.stale == true ? .stale : .ready
  }
}

/// Wynik jednego odczytu limitów.
public enum PlanUsageOutcome: Sendable, Equatable {
  case loaded(PlanUsage)
  /// 503 `usage-unavailable`: serwer nie wie — liczb nie zgadujemy, poprzednie znikają.
  case unavailable
  /// Sieć, limit czasu, odpowiedź nieczytelna: serwer mógł wiedzieć, ostatnie liczby zostają.
  case failed
}

extension PlanUsage {
  /// Odpowiedź bez żadnego okna nie ma czego pokazać — liczy się jak nieudany odczyt (PWA:
  /// `planUsageLine` → `null`).
  var hasWindows: Bool { fiveHour != nil || weekly != nil || weeklyModel != nil }
}

extension AppState {
  mutating func applyPlanUsage(_ outcome: PlanUsageOutcome, at: Date) {
    switch outcome {
    case let .loaded(usage) where usage.hasWindows:
      planUsage.usage = usage
      planUsage.receivedAt = at
      planUsage.refreshFailed = false
      planUsage.unavailable = false
    case .unavailable:
      planUsage = PlanUsageState()
      planUsage.unavailable = true
    case .loaded, .failed:
      if planUsage.usage == nil {
        planUsage.unavailable = true
      } else {
        planUsage.refreshFailed = true
      }
    }
  }

  /// Sonda wersji: flagi z ustalonym znaczeniem braku (``Capabilities``), nazwa tailnetu, system maszyny serwera
  /// (brak pola = serwer sprzed niego: zostaje ostatni znany, ``serverSystem``) i wersja serwera.
  mutating func applyVersion(_ info: VersionInfo) {
    capabilities = Capabilities(info)
    let name = info.tailnet?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    tailnet = name.isEmpty ? nil : name
    if let system = info.system { serverSystem = system }
    serverVersion = info.version
  }

  /// Logowanie i wylogowanie kasują to, co wiadomo o serwerze; woła `resetView`.
  mutating func resetServerInfo() {
    capabilities = nil
    // Odmowa przy mincie też jest wiedzą o serwerze; bez tego odmowa sprzed `hello` (proces nieznany) trzymałaby się
    // nowego serwera do jego `hello`.
    voice = VoiceAvailabilityState()
    tailnet = nil
    serverVersion = nil
    planUsage = PlanUsageState()
    macLoad = MacLoadState()
  }
}
