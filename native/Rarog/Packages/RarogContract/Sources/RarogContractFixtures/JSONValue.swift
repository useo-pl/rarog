import Foundation

/// Dowolna wartość JSON — porównanie kanoniczne (klucze bez kolejności, liczby jako `Double`),
/// operacje JSON Pointer z manifestu i zapis zwarty jak `JSON.stringify`.
public enum JSONValue: Sendable, Hashable {
  case null
  case bool(Bool)
  case number(Double)
  case string(String)
  case array([JSONValue])
  case object([String: JSONValue])

  /// Parsuje dokument JSON (dowolna wartość na szczycie, także łańcuch).
  public static func parse(_ data: Data) throws -> JSONValue {
    try JSONDecoder().decode(JSONValue.self, from: data)
  }

  /// Zapis zwarty, klucze posortowane. Ucieczki jak `JSON.stringify`: tylko `"`, `\` i znaki
  /// sterujące < U+0020 — U+2028 i reszta Unicode zostają dosłownie (tak jedzie serwer).
  public var compact: String {
    var out = ""
    write(into: &out)
    return out
  }

  /// Dokument jako bajty UTF-8 (zapis zwarty).
  public var data: Data { Data(compact.utf8) }

  private func write(into out: inout String) {
    switch self {
    case .null: out += "null"
    case let .bool(value): out += value ? "true" : "false"
    case let .number(value):
      if value.rounded() == value, abs(value) < 1e15 {
        out += String(Int64(value))
      } else {
        out += String(value)
      }
    case let .string(value): Self.writeString(value, into: &out)
    case let .array(items):
      out += "["
      for (index, item) in items.enumerated() {
        if index > 0 { out += "," }
        item.write(into: &out)
      }
      out += "]"
    case let .object(fields):
      out += "{"
      for (index, key) in fields.keys.sorted().enumerated() {
        if index > 0 { out += "," }
        Self.writeString(key, into: &out)
        out += ":"
        fields[key]?.write(into: &out)
      }
      out += "}"
    }
  }

  private static func writeString(_ value: String, into out: inout String) {
    out += "\""
    for scalar in value.unicodeScalars {
      switch scalar {
      case "\"": out += "\\\""
      case "\\": out += "\\\\"
      case "\n": out += "\\n"
      case "\r": out += "\\r"
      case "\t": out += "\\t"
      case "\u{08}": out += "\\b"
      case "\u{0C}": out += "\\f"
      case _ where scalar.value < 0x20:
        out += String(format: "\\u%04x", scalar.value)
      default:
        out.unicodeScalars.append(scalar)
      }
    }
    out += "\""
  }
}

extension JSONValue: Codable {
  public init(from decoder: any Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let value = try? container.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? container.decode(Double.self) {
      self = .number(value)
    } else if let value = try? container.decode(String.self) {
      self = .string(value)
    } else if let value = try? container.decode([JSONValue].self) {
      self = .array(value)
    } else {
      self = .object(try container.decode([String: JSONValue].self))
    }
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .null: try container.encodeNil()
    case let .bool(value): try container.encode(value)
    case let .number(value): try container.encode(value)
    case let .string(value): try container.encode(value)
    case let .array(value): try container.encode(value)
    case let .object(value): try container.encode(value)
    }
  }
}

// MARK: - JSON Pointer (RFC 6901)

/// Jedna operacja z manifestu: `value` ustawia (dodaje albo podmienia), `remove` usuwa.
public struct JSONPatchOp: Sendable, Hashable, Decodable {
  public let path: String
  /// `nil` przy `remove`; `.null` to WARTOŚĆ null (np. `sessions/0/state: null`).
  public let value: JSONValue?
  public let remove: Bool

  enum CodingKeys: String, CodingKey { case path, value, remove }

  public init(path: String, value: JSONValue?, remove: Bool) {
    self.path = path
    self.value = value
    self.remove = remove
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    path = try c.decode(String.self, forKey: .path)
    // `contains`, nie `decodeIfPresent`: `"value": null` jest wartością, a nie brakiem pola.
    value = c.contains(.value) ? try c.decode(JSONValue.self, forKey: .value) : nil
    remove = c.contains(.remove) ? try c.decode(Bool.self, forKey: .remove) : false
    guard (value != nil) != remove else {
      throw DecodingError.dataCorruptedError(
        forKey: .path, in: c, debugDescription: "operacja: albo value, albo remove (\(path))")
    }
  }
}

public enum JSONPointerError: Error, CustomStringConvertible {
  case missingParent(String)

  public var description: String {
    switch self {
    case let .missingParent(path): "ścieżka \(path): brak rodzica"
    }
  }
}

extension JSONValue {
  /// Klucze ścieżki po odkodowaniu `~1` i `~0`.
  static func pointerKeys(_ path: String) -> [String] {
    path.dropFirst().split(separator: "/", omittingEmptySubsequences: false).map {
      String($0).replacing("~1", with: "/").replacing("~0", with: "~")
    }
  }

  /// Kopia dokumentu z nałożonymi operacjami (semantyka `applyOps` z `sse-fixtures.test.ts`).
  public func applying(_ ops: [JSONPatchOp]) throws -> JSONValue {
    var out = self
    for op in ops {
      try out.apply(keys: Self.pointerKeys(op.path)[...], op: op)
    }
    return out
  }

  private mutating func apply(keys: ArraySlice<String>, op: JSONPatchOp) throws {
    guard let key = keys.first else { return }
    let last = keys.count == 1
    switch self {
    case var .object(fields):
      if last {
        if op.remove { fields[key] = nil } else { fields[key] = op.value }
      } else {
        guard var child = fields[key], child.isContainer else { throw JSONPointerError.missingParent(op.path) }
        try child.apply(keys: keys.dropFirst(), op: op)
        fields[key] = child
      }
      self = .object(fields)
    case var .array(items):
      guard let index = Int(key), index >= 0, index <= items.count else {
        throw JSONPointerError.missingParent(op.path)
      }
      if last {
        if op.remove {
          guard index < items.count else { throw JSONPointerError.missingParent(op.path) }
          items.remove(at: index)
        } else if let value = op.value {
          if index == items.count { items.append(value) } else { items[index] = value }
        }
      } else {
        guard index < items.count, items[index].isContainer else { throw JSONPointerError.missingParent(op.path) }
        try items[index].apply(keys: keys.dropFirst(), op: op)
      }
      self = .array(items)
    default:
      throw JSONPointerError.missingParent(op.path)
    }
  }

  private var isContainer: Bool {
    switch self {
    case .object, .array: true
    default: false
    }
  }

  /// Różnice dwóch dokumentów jako czytelne linie ze ścieżkami (pusta lista = równe).
  public static func differences(expected: JSONValue, actual: JSONValue, path: String = "") -> [String] {
    switch (expected, actual) {
    case let (.object(lhs), .object(rhs)):
      var out: [String] = []
      for key in Set(lhs.keys).union(rhs.keys).sorted() {
        let child = "\(path)/\(key)"
        switch (lhs[key], rhs[key]) {
        case let (left?, right?): out += differences(expected: left, actual: right, path: child)
        case (_?, nil): out.append("\(child): jest w wejściu, brak w wyniku Swift (pole nieznane typom Swift?)")
        case (nil, _?): out.append("\(child): nadmiarowe w wyniku Swift")
        case (nil, nil): break
        }
      }
      return out
    case let (.array(lhs), .array(rhs)):
      guard lhs.count == rhs.count else {
        return ["\(path): długość tablicy \(lhs.count) ≠ \(rhs.count)"]
      }
      return zip(lhs, rhs).enumerated().flatMap { index, pair in
        differences(expected: pair.0, actual: pair.1, path: "\(path)/\(index)")
      }
    default:
      return expected == actual ? [] : ["\(path): \(expected.compact) ≠ \(actual.compact)"]
    }
  }
}
