import RarogCore

/// Stan nigdy samym kolorem: tam, gdzie stan sesji nie ma obok słowa (kafelek i kwadracik zakładki),
/// niesie go też KSZTAŁT znaku — barwa zostaje, ale nie jest jedynym nośnikiem. Znaki są dekoracją dla czytnika
/// (stan mówi zdanie zakładki). The project header has no state glyph and no counters: the agent rows under it carry
/// the state, and its screen reader sentence says the count and the state. Właściciel: dostępność.
public enum StateGlyph {
  /// Znak przy etykiecie zakładki; cisza nie ma znaku (sama szara kreska).
  public static func mark(_ tone: StatusTone) -> String? {
    switch tone {
    case .working: "ellipsis"
    case .waiting: "exclamationmark"
    case .failed: "xmark"
    case .unread: "checkmark"
    case .quiet: nil
    case .backgroundWait: "hourglass"
    case .backgroundWaitLong: "timer"
    }
  }
}
