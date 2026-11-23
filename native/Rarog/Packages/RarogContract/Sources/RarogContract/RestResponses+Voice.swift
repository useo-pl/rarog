// Klucz tymczasowy dyktowania — lustro `voiceTokenSchema` z `shared/src/protocol.ts`. Ta sama tolerancja
// co reszta REST: nieznane klucze odcięte, `null` i zły typ odrzucają odpowiedź. Właściciel: dyktowanie.
import Foundation

/// `POST /api/voice/token` (200): klucz TYMCZASOWY Soniox (60 s na otwarcie strumienia,
/// `single_use`) i cała konfiguracja strumienia. Klient niczego nie zgaduje: host (region UE),
/// model i format audio podaje serwer, a stały klucz nie opuszcza Maca.
///
/// **`apiKey` nie trafia do żadnego logu ani opisu.** `description` i lustro (`dump`, `print`)
/// pokazują wyłącznie rzeczy bez sekretu.
public struct VoiceToken: Sendable, Equatable, Decodable, CustomStringConvertible, CustomDebugStringConvertible,
  CustomReflectable
{
  public let apiKey: String
  /// ISO 8601 z Soniox; dotyczy OTWARCIA strumienia, nie czasu trwania sesji.
  public let expiresAt: String
  /// Adres strumienia — wyłącznie `wss://`: klucz jedzie w pierwszej ramce, więc `ws://` wysłałby
  /// go czystym tekstem (obrona w głąb).
  public let webSocketURL: URL
  public let model: String
  /// Sufit długości jednej sesji dyktowania w sekundach (UI ostrzega od 13. minuty).
  public let maxSessionSeconds: Int
  public let config: VoiceStreamConfig

  enum CodingKeys: String, CodingKey {
    case apiKey, expiresAt, webSocketUri, model, maxSessionSeconds, config
  }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    apiKey = try c.nonEmpty(.apiKey)
    expiresAt = try c.required(.expiresAt)
    let uri: String = try c.required(.webSocketUri)
    guard uri.hasPrefix("wss://"), let url = URL(string: uri), url.host() != nil else {
      throw contractViolation(c.codingPath + [CodingKeys.webSocketUri], "adres strumienia musi być wss://")
    }
    webSocketURL = url
    model = try c.required(.model)
    maxSessionSeconds = try c.required(.maxSessionSeconds)
    config = try c.required(.config)
  }

  public var description: String { "VoiceToken(model: \(model), host: \(webSocketURL.host() ?? "?"), klucz ukryty)" }
  public var debugDescription: String { description }
  public var customMirror: Mirror { Mirror(self, children: ["model": model, "maxSessionSeconds": maxSessionSeconds]) }
}

/// Konfiguracja strumienia z serwera — klient przepisuje ją do ramki konfiguracyjnej Soniox.
public struct VoiceStreamConfig: Sendable, Equatable, Decodable {
  public let languageHints: [String]
  public let audioFormat: String
  public let sampleRate: Int
  public let numChannels: Int

  enum CodingKeys: String, CodingKey { case languageHints, audioFormat, sampleRate, numChannels }

  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    languageHints = try c.required(.languageHints)
    audioFormat = try c.nonEmpty(.audioFormat)
    sampleRate = try c.required(.sampleRate)
    numChannels = try c.required(.numChannels)
  }
}
