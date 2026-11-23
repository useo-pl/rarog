// Obciążenie Maca: odpowiedź `GET /api/mac` i progi koloru — JEDNO źródło dla stopki listy apki
// (`RarogUI`) i kafla Live Activity (`RarogActivity`), które od siebie nie zależą, a oba widzą kontrakt.

/// `GET /api/mac` (200) — CPU (średnia z minuty), RAM (presja) i dysk (zajęte) w procentach, krok 5; brak pola =
/// brak odczytu, `{}` = żadnego. Ten sam typ co `mac` w stanie Live Activity: serwer czyta jeden próbnik
/// (`server/src/mac-stats.ts`), a schemat to `liveActivityMacSchema` (`null`, ułamek i wartość spoza 0…100
/// odrzucają odpowiedź).
public typealias MacLoad = LiveActivityContentState.Mac

/// Poziom obciążenia: zwykły atrament, uwaga (bursztyn, pogrubienie), czerwień (pogrubienie). Próg niesie też
/// waga pisma, nie sam kolor.
public enum MacLoadLevel: Int, Sendable, Comparable, CaseIterable {
  case normal
  case warning
  case critical

  public static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }
}

/// Jedna metryka Maca z progami. Progi liczy się na JUŻ ZAOKRĄGLONYCH procentach (krok 5 z serwera), więc granica
/// jest liczbą, którą człowiek widzi: „70%" przy CPU to już uwaga.
public enum MacMetric: String, Sendable, CaseIterable {
  case cpu
  case ram
  case disk

  /// Od ilu procent uwaga i od ilu czerwień:
  /// - CPU: średnia z MINUTY ≥ 70 % to długa, ciężka praca (build, testy), a nie chwilowy skok; ≥ 90 % — Mac
  ///   chodzi na pełnych obrotach i wszystko inne zwalnia;
  /// - RAM (100 − `kern.memorystatus_level`, czyli presja w rozumieniu systemu): ≥ 75 % zostaje ćwierć pamięci
  ///   dostępnej, ≥ 90 % — dziesiąta część;
  /// - dysk (zajęte jak `df`): ≥ 85 % czas sprzątać, ≥ 95 % — kilka buildów do zapchania (same symulatory iOS
  ///   potrafią zająć 193 GB).
  public var thresholds: (warning: Int, critical: Int) {
    switch self {
    case .cpu: (70, 90)
    case .ram: (75, 90)
    case .disk: (85, 95)
    }
  }

  /// Poziom zaokrąglonego procentu (wartości spoza 0…100 przycięte).
  public func level(_ percent: Int) -> MacLoadLevel {
    let value = min(100, max(0, percent))
    let limits = thresholds
    return value >= limits.critical ? .critical : value >= limits.warning ? .warning : .normal
  }
}

extension LiveActivityContentState.Mac {
  /// Wartość metryki; `nil` = brak odczytu.
  public func value(_ metric: MacMetric) -> Int? {
    switch metric {
    case .cpu: cpu
    case .ram: ram
    case .disk: disk
    }
  }

  /// Żadnej metryki — „Mac nic nie wie" (tuż po starcie serwera albo wszystkie odczyty padły).
  public var isEmpty: Bool { cpu == nil && ram == nil && disk == nil }
}
