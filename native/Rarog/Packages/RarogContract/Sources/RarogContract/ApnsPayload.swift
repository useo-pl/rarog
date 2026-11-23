import Foundation

// Ładunek alertu APNs widziany z apki — WYŁĄCZNIE blok `rarog`, który serwer kładzie poza
// `aps` (klucze własne w `aps` system ignoruje): `rarog {v, sessionId?, termId?, kind}`. Z niego apka
// bierze cel tapnięcia i rozpoznaje push próbny. `aps` (tytuł, treść, plakietkę) rysuje system — apka go
// nie czyta. Kształt jawnego bloku v1; serwer wysyła banery wyłącznie w kopercie v3 (`PushEnvelope`),
// a apka dalej przyjmuje v1 (`PushRouting`), bo blokiem v1 wysyłają pushe testy UI (`simctl push`). Formatu 1
// apka nie deklaruje. Próbki: `ApnsPayloadTests`.

/// Rodzaj powiadomienia — `NotifyKind` z `shared/src/notify-copy.ts`, push próbny albo push bezpieczeństwa.
public enum ApnsPushKind: String, ContractEnum {
  case permission
  case question
  case blocked
  case done
  case error
  case limit
  /// Push próbny po „Włącz" — jedyne źródło dymka „Powiadomienia działają".
  case test
  /// Sparowano nowe urządzenie z tym serwerem — bez sesji; apka pokazuje baner, tap i trwały ślad.
  case devicePaired = "device-paired"
  /// Na serwerze stoi nowa wersja Claude Code albo herdr (`server/src/version-watch.ts`) — bez sesji; baner także
  /// na wierzchu, tap otwiera ekran „Serwer”.
  case versionChanged = "version-changed"
  /// A weekly plan window reached 97% (`server/src/notify/weekly-limit.ts`): no session; a banner also in the
  /// foreground, a tap opens the session list.
  case weeklyLimit = "weekly-limit"
}

/// Blok `rarog` alertu.
///
/// Reguły tolerancji jak reszta kontraktu: `null` i zły typ odrzucają blok (tap otwiera wtedy samą
/// apkę), nieznany RODZAJ zostaje `nil`, ale cel tapnięcia przeżywa (nowszy serwer z nową klasą).
/// Wersji innej niż ``supportedVersion`` apka nie interpretuje wcale (`PushRouting`).
public struct ApnsRarogPayload: Sendable, Equatable, Decodable {
  /// Jedyna wersja bloku, którą ta apka zna (`APNS_BLOCK_VERSION`).
  public static let supportedVersion = 1

  /// Wersja bloku (`v`).
  public var version: Int
  /// `nil` = rodzaj, którego ta wersja apki nie zna.
  public var kind: ApnsPushKind?
  /// Sesja, której dotyczy powiadomienie; push próbny jej nie ma.
  public var sessionId: String?
  /// Terminal Raroga wpisu Codexa (`TERM_ID_RE`) — tap prowadzi na terminal.
  public var termId: String?

  enum CodingKeys: String, CodingKey {
    case version = "v"
    case kind, sessionId, termId
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    version = try c.required(.version)
    let rawKind: String = try c.required(.kind)
    kind = ApnsPushKind.wire(rawKind)
    if c.contains(.sessionId) {
      sessionId = try c.nonEmpty(.sessionId)
    }
    termId = try c.optional(.termId)
    if let termId, !WireFormat.isTerminalId(termId) {
      throw contractViolation(c.codingPath + [CodingKeys.termId], "termId spoza TERM_ID_RE")
    }
  }
}

/// `userInfo` powiadomienia zdekodowane z JSON — z całego ładunku apka czyta tylko `rarog`.
public struct ApnsAlertEnvelope: Sendable, Equatable, Decodable {
  /// `nil` = push bez bloku Raroga (nie nasz kształt) — tap otwiera samą apkę.
  public var rarog: ApnsRarogPayload?

  enum CodingKeys: String, CodingKey { case rarog }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    rarog = try c.optional(.rarog)
  }
}
