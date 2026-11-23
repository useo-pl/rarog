// Odpowiedzi REST terminala — lustro `termOpenResponseSchema`, `termListResponseSchema`
// i `termHistoryResponseSchema` z `shared/src/protocol.ts` (re-eksport w `@rarog/shared/rest`).
// Ta sama tolerancja co reszta REST; id terminala wchodzi do ścieżki gniazda WS, więc jego
// kształt (`TERM_ID_RE`) jest sprawdzany tu, a nie dopiero przy budowaniu adresu.

/// Rola panelu terminala (`TERM_ROLES`): tab projektu albo panel w popupie.
public enum TerminalRole: String, ContractEnum {
  case shell
  case lazygit
  case popup

  /// Lustro `isPopupRole`: panel poza slotami projektu (`slot: 0`, slot zabroniony w ciele POST).
  public var isPopup: Bool { self != .shell }
}

/// `POST /api/term` (200) — id terminala, slot, który padł (przy `next` wybiera serwer), i rola.
/// `slot == 0` należy wyłącznie do ról popupowych. Nieznana rola odrzuca odpowiedź: apka prosiła
/// o konkretną rolę, więc inna znaczy złamany kontrakt, a nie nowość do przemilczenia.
public struct TerminalOpenResponse: Sendable, Equatable, Decodable {
  public var id: String
  public var slot: Int
  public var role: TerminalRole

  enum CodingKeys: String, CodingKey { case id, slot, role }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    id = try c.terminalId(.id)
    slot = try c.terminalSlot(.slot)
    role = try c.strict(.role)
  }
}

/// Wpis listy terminali (`GET /api/term`). `proc` = proces na pierwszym planie (`nvim`, `codex`);
/// pusty = serwer jeszcze nie wie. `live` = strumień chodzi teraz.
public struct TerminalListEntry: Sendable, Equatable, Decodable, TolerantDecodable {
  public var id: String
  public var cwd: String
  public var live: Bool
  public var slot: Int
  public var proc: String
  public var role: TerminalRole

  enum CodingKeys: String, CodingKey { case id, cwd, live, slot, proc, role }

  /// Nieznana rola → wpis znika (apka nie umie go otworzyć), reszta listy zostaje.
  static func decodeTolerant(from decoder: any Decoder) throws -> TerminalListEntry? {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    let raw: String = try c.required(.role)
    guard TerminalRole.wire(raw) != nil else {
      c.degrade(.role, raw: raw)
      return nil
    }
    return try TerminalListEntry(from: decoder)
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    id = try c.terminalId(.id)
    cwd = try c.nonEmpty(.cwd)
    live = try c.required(.live)
    slot = try c.terminalSlot(.slot)
    proc = try c.required(.proc)
    role = try c.strict(.role)
  }
}

/// `GET /api/term` (200): `{terminals: [...]}` — lista terminali dla zakładek projektu.
public struct TerminalList: Sendable, Equatable, Decodable {
  public var terminals: [TerminalListEntry]

  enum CodingKeys: String, CodingKey { case terminals }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    var items = try c.base.nestedUnkeyedContainer(forKey: .terminals)
    var out: [TerminalListEntry] = []
    while !items.isAtEnd {
      if let entry = try TerminalListEntry.decodeTolerant(from: items.superDecoder()) { out.append(entry) }
    }
    terminals = out
  }
}

/// `GET /api/term/:id/history?lines=N` (200) — scrollback panelu jako zwykły tekst. `truncated`
/// = historia była dłuższa niż `lines`. Treści nie wolno logować ani zapisywać.
public struct TerminalHistory: Sendable, Equatable, Decodable {
  public var text: String
  public var truncated: Bool

  enum CodingKeys: String, CodingKey { case text, truncated }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    text = try c.required(.text)
    truncated = try c.required(.truncated)
  }
}

extension ContractContainer {
  /// Id terminala w kształcie `TERM_ID_RE` (16 znaków małego hex) — inny kształt odrzuca.
  func terminalId(_ key: Key) throws -> String {
    let value: String = try required(key)
    guard WireFormat.isTerminalId(value) else {
      throw contractViolation(codingPath + [key], "id terminala spoza kształtu TERM_ID_RE")
    }
    return value
  }

  /// Slot w odpowiedzi terminala: 0…``TerminalSlot/max`` jak w schematach TS (0 = popup).
  func terminalSlot(_ key: Key) throws -> Int {
    let value: Int = try required(key)
    guard (0...TerminalSlot.max).contains(value) else {
      throw contractViolation(codingPath + [key], "slot terminala spoza 0…\(TerminalSlot.max)")
    }
    return value
  }
}
