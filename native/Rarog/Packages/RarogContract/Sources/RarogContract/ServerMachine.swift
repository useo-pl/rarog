import Foundation

// Słowo, którym apka nazywa maszynę serwera Raroga: „Mac” albo „VPS” według
// systemu z `GET /api/version` (``VersionInfo/system``). Polski odmienia słowo (na Macu, na VPS-ie), więc zdanie
// z wariantem VPS to osobny klucz katalogu `<baza>.vps`, nie podstawienie. Reguła mieszka TU, bo czytają ją apka
// (RarogCore, RarogUI) i kafel Live Activity (RarogActivity, rozszerzenie bez RarogCore).

/// Maszyna serwera słowem: `.mac` albo `.vps`.
public enum ServerMachine: Sendable, Equatable {
  case mac
  case vps

  /// JEDYNA reguła słowa. „Mac” jest prawdziwe tylko na macOS: Linux, inny system i system spoza listy tej apki
  /// (``ServerSystem/unsupported``) to VPS. `nil` (przed pierwszą sondą wersji i bez zapamiętanego systemu, serwer
  /// sprzed pola `system`) = Mac.
  public init(_ system: ServerSystem?) {
    switch system {
    case .macos, nil: self = .mac
    case .linux, .other, .unsupported: self = .vps
    }
  }
}

extension KeyedDecodingContainer {
  /// System serwera z zapisu APKI (poświadczenie w Keychainie, odpięcie w preferencjach, atrybuty kafla Live
  /// Activity). Brak klucza (zapis sprzed pola), `null` i zły typ = nie wiadomo; wartość spoza listy tej wersji apki
  /// (zapis nowszej wersji po cofnięciu apki) = ``ServerSystem/unsupported``. Nigdy nie rzuca: zepsute pole słowa nie
  /// może zgubić całego zapisu (nieczytelne poświadczenie Keychain kasuje, a z nim parowanie). To nie dekoder
  /// kontraktu (tam `null` ≠ brak pola): w zapisie apki oba znaczą „nie wiadomo”, więc każdy błąd odczytu też.
  public func storedServerSystem(forKey key: Key) -> ServerSystem? {
    guard let raw = try? decode(String.self, forKey: key) else { return nil }
    return ServerSystem(rawValue: raw) ?? .unsupported
  }
}
