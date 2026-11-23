// Ciało `POST /api/term` — lustro `termOpenBodySchema` z `shared/src/protocol.ts`
// (re-eksport w `@rarog/shared/rest`). Serwer waliduje ściśle i odrzuca slot przy roli
// popupowej, więc takie ciało w ogóle nie powstaje (inicjalizator zwraca `nil`).

/// Slot terminala w ciele POST: konkretny numer (1…) albo `next` — „załóż KOLEJNY", numer wybiera
/// serwer. Brak slotu w ciele znaczy slot 1.
public enum TerminalSlot: Sendable, Equatable, Encodable {
  case number(Int)
  case next

  /// `TERM_SLOTS_MAX`: najwyższy numer slotu terminala projektu. W ciele 1…max, w odpowiedziach
  /// 0…max (0 = panel w popupie).
  public static let max = 4

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case let .number(value): try c.encode(value)
    case .next: try c.encode("next")
    }
  }
}

/// `POST /api/term {cwd, slot?, role?}` → `{id, slot, role}`. Idempotentne: ta sama trójka
/// (katalog, slot, rola) daje ten sam terminal — reconnect wysyła TO SAMO ciało, nie `next`.
public struct TerminalOpenBody: Sendable, Equatable, Encodable {
  public var cwd: String
  public var slot: TerminalSlot?
  public var role: TerminalRole?

  /// `nil`, gdy serwer i tak odrzuciłby ciało: pusty katalog, slot spoza 1…``TerminalSlot/max``
  /// albo slot przy roli popupowej (`lazygit`, `popup` nie mają slotów).
  public init?(cwd: String, slot: TerminalSlot? = nil, role: TerminalRole? = nil) {
    guard !cwd.isEmpty else { return nil }
    if case let .number(value) = slot, !(1...TerminalSlot.max).contains(value) { return nil }
    if role?.isPopup == true, slot != nil { return nil }
    self.cwd = cwd
    self.slot = slot
    self.role = role
  }
}
