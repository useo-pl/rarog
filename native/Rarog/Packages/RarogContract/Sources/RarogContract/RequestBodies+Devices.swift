// Ciała tras kluczy urządzeń — lustro `pairBodySchema` z `shared/src/rest.ts`. Złote ciało:
// `shared/fixtures/requests/pair.json` (producent `RequestFixturesTests`, czyta je schemat serwera).
// `POST /api/pairings` i `POST /api/devices/forget` niosą pusty obiekt (``EmptyBody``).

/// `POST /api/pair` — parowanie kodem z linku `https://rarog.ai/pair#v=1&u=…&c=…` (trasa publiczna, poświadczeniem jest
/// kod).
/// `label` to nazwa urządzenia (`iPhone·Rarog`), `build` — numer builda apki tekstem (diagnostyka listy urządzeń),
/// `pushFormats` — formaty ładunku push, które apka umie czytać (format 3). Serwer pole przyjmuje i NIE używa:
/// deklaracja, od której zależy format banera, idzie rejestracją tokenu (`ApnsRegisterBody.pushFormats`).
public struct PairBody: Sendable, Equatable, Encodable {
  /// Wersja protokołu parowania — ta sama co `v` w linku.
  public static let protocolVersion = 1

  public var v: Int
  public var code: String
  public var label: String
  public var build: String?
  public var pushFormats: [Int]?

  public init(code: String, label: String, build: Int?, pushFormats: [Int] = ApnsRegisterBody.supportedPushFormats) {
    v = Self.protocolVersion
    self.code = code
    // Serwer odcina etykietę dłuższą niż 64 znaki (`PUSH_LABEL_MAX_CHARS`) błędem 400 — przycinamy przed wysyłką.
    self.label = String(label.prefix(64))
    self.build = build.map(String.init)
    self.pushFormats = pushFormats.isEmpty ? nil : pushFormats
  }
}
