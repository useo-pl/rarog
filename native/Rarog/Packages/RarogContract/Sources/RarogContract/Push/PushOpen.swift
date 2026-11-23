import Foundation

// Cel tapnięcia, który rozszerzenie powiadomień (NSE) dopisuje do `userInfo` po odszyfrowaniu banera v3:
// klucz `rarogOpen = {kind?, sessionId?, termId?}` obok bloku `rarog` v3, który zostaje. Apka czyta go PIERWSZY
// (`PushRouting.note`), a nieczytelny pomija i odszyfrowuje `rarog` v3 sama. Przekaźnik push przepuszcza tylko
// `{aps, rarog}`, więc `rarogOpen` z sieci nie przyjdzie tą drogą; podrobiony (klucz APNs właściciela) daje najwyżej
// nawigację.
//
// Reguły jak w bloku `rarog` v1 (`ApnsRarogPayload`): rodzaj, którego ta wersja apki nie zna, zostaje `nil`, a cel
// przeżywa — NSE zapisuje wtedy wpis bez `kind`. Zły typ pola, pusty `sessionId` albo `termId` spoza `TERM_ID_RE`
// = wpis nieczytelny.

/// `rarogOpen` w `userInfo` powiadomienia: rodzaj i cel tapnięcia z odszyfrowanego banera v3.
public struct PushOpen: Sendable, Equatable {
  /// Klucz w `userInfo`.
  public static let userInfoKey = "rarogOpen"

  /// `nil` = rodzaj, którego ta wersja apki nie zna.
  public var kind: ApnsPushKind?
  /// Sesja, której dotyczy powiadomienie; push próbny i `device-paired` jej nie mają.
  public var sessionId: String?
  /// Terminal Raroga wpisu Codexa (`TERM_ID_RE`).
  public var termId: String?

  public init(kind: ApnsPushKind?, sessionId: String? = nil, termId: String? = nil) {
    self.kind = kind
    self.sessionId = sessionId
    self.termId = termId
  }

  /// Cel z odszyfrowanego tekstu jawnego (bez tytułu, treści i `exp`).
  public init(_ plaintext: PushPlaintext) {
    self.init(kind: plaintext.kind, sessionId: plaintext.sessionId, termId: plaintext.termId)
  }

  /// Wartość z `userInfo[rarogOpen]`; `nil` = brak albo wpis nieczytelny.
  public init?(userInfoValue value: Any?) {
    guard let object = value as? [String: Any] else { return nil }
    var kind: ApnsPushKind?
    if let raw = object["kind"] {
      guard let text = raw as? String else { return nil }
      kind = ApnsPushKind.wire(text)
    }
    if let raw = object["sessionId"] {
      guard let session = raw as? String, !session.isEmpty else { return nil }
      sessionId = session
    }
    if let raw = object["termId"] {
      guard let terminal = raw as? String, WireFormat.isTerminalId(terminal) else { return nil }
      termId = terminal
    }
    self.kind = kind
  }

  /// Wartość do `userInfo` (same napisy — `userInfo` przyjmuje typy listy właściwości).
  public var userInfoValue: [String: String] {
    var object: [String: String] = [:]
    object["kind"] = kind?.rawValue
    object["sessionId"] = sessionId
    object["termId"] = termId
    return object
  }

  /// `userInfo` z dopisanym `rarogOpen`; pozostałe klucze (`aps`, blok `rarog` v3) zostają bez zmian.
  public func adding(to userInfo: [AnyHashable: Any]) -> [AnyHashable: Any] {
    var result = userInfo
    result[Self.userInfoKey] = userInfoValue
    return result
  }
}
