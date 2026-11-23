import Foundation

// Ciało `PUT /api/notes` — lustro `notesPutBodySchema` z `shared/src/protocol.ts`, sufit i definicja pustki
// z tego samego pliku. Złote ciało: `shared/fixtures/requests/notes.put.json`. Właściciel: notatki (apka natywna).

/// Zapis CAŁEGO dokumentu. `updatedAt` to wersja, na której człowiek pisał: inna na serwerze = 409 z aktualnym
/// dokumentem. Pusty `text` jest skasowaniem treści (przycisku „Usuń” nie ma).
public struct NotesPutBody: Sendable, Equatable, Encodable {
  public var cwd: String
  public var text: String
  public var updatedAt: Double

  public init(cwd: String, text: String, updatedAt: Double) {
    self.cwd = cwd
    self.text = text
    self.updatedAt = updatedAt
  }
}

/// Reguły dokumentu wspólne z serwerem.
public enum NotesRules {
  /// `NOTES_MAX_CHARS` (48 × 1024): zod liczy `string.length`, czyli jednostki UTF-16 — tak liczy też apka.
  public static let maxUnits = 48 * 1024

  /// Znaki, które zdejmuje JS `String.prototype.trim` (WhiteSpace + LineTerminator ze specyfikacji ECMAScript).
  /// Jawna lista, nie `CharacterSet.whitespacesAndNewlines`: ten ma U+0085, którego JS nie zdejmuje, a nie ma
  /// U+FEFF, który JS zdejmuje — pustka liczona inaczej niż na serwerze gasiłaby ikonę po evencie `notes`
  /// i zapalała po odczycie tego samego dokumentu.
  public static let trimmed: Set<Unicode.Scalar> = {
    var set: Set<Unicode.Scalar> = [
      "\u{0009}", "\u{000A}", "\u{000B}", "\u{000C}", "\u{000D}", "\u{0020}", "\u{00A0}", "\u{1680}",
      "\u{2028}", "\u{2029}", "\u{202F}", "\u{205F}", "\u{3000}", "\u{FEFF}",
    ]
    for value in 0x2000...0x200A {
      if let scalar = Unicode.Scalar(value) { set.insert(scalar) }
    }
    return set
  }()

  /// Lustro `notesEmpty`: dokument z samymi białymi znakami to brak notatki.
  public static func isEmpty(_ text: String) -> Bool {
    text.unicodeScalars.allSatisfy { trimmed.contains($0) }
  }

  /// Długość tak, jak liczy ją serwer (jednostki UTF-16).
  public static func units(_ text: String) -> Int { text.utf16.count }
}
