// Klucz tymczasowy dyktowania: kształt z `voiceTokenSchema` i reguły odczytu odpowiedzi.
import Foundation
import RarogContract
import Testing

@Suite("kontrakt REST: klucz tymczasowy dyktowania")
struct VoiceContractTests {
  static let valid = #"""
    {"apiKey":"tmp-key","expiresAt":"2026-08-23T12:00:00.000Z",
     "webSocketUri":"wss://stt-rt.eu.soniox.com/transcribe-websocket","model":"stt-rt-v6",
     "maxSessionSeconds":900,
     "config":{"languageHints":["pl","en"],"audioFormat":"pcm_s16le","sampleRate":16000,"numChannels":1},
     "nowe":"pole"}
    """#

  private func decode(_ json: String) throws -> VoiceToken {
    try JSONDecoder().decode(VoiceToken.self, from: Data(json.utf8))
  }

  @Test("przepuszcza kontrakt serwera, obce klucze odcięte")
  func valid() throws {
    let token = try decode(Self.valid)
    #expect(token.apiKey == "tmp-key")
    #expect(token.webSocketURL.absoluteString == "wss://stt-rt.eu.soniox.com/transcribe-websocket")
    #expect(token.model == "stt-rt-v6" && token.maxSessionSeconds == 900)
    #expect(token.config.languageHints == ["pl", "en"])
    #expect(token.config.audioFormat == "pcm_s16le" && token.config.sampleRate == 16000 && token.config.numChannels == 1)
  }

  @Test("pusty klucz, zły typ, null i brak konfiguracji odrzucają odpowiedź")
  func rejects() {
    for broken in [
      Self.valid.replacing(#""apiKey":"tmp-key""#, with: #""apiKey":"""#),
      Self.valid.replacing(#""maxSessionSeconds":900"#, with: #""maxSessionSeconds":"900""#),
      Self.valid.replacing(#""model":"stt-rt-v6""#, with: #""model":null"#),
      Self.valid.replacing(#""audioFormat":"pcm_s16le""#, with: #""audioFormat":"""#),
      #"{"apiKey":"tmp-key"}"#,
    ] {
      #expect(throws: DecodingError.self) { try decode(broken) }
    }
  }

  @Test("adres inny niż wss:// jest odrzucany — klucz leci w pierwszej ramce")
  func onlyWss() {
    for uri in ["ws://stt-rt.eu.soniox.com/x", "https://api.eu.soniox.com", "wss://"] {
      let json = Self.valid.replacing("wss://stt-rt.eu.soniox.com/transcribe-websocket", with: uri)
      #expect(throws: DecodingError.self) { try decode(json) }
    }
  }

  @Test("opis i lustro nie zdradzają klucza")
  func redacted() throws {
    let token = try decode(Self.valid)
    var dumped = ""
    dump(token, to: &dumped)
    for text in [String(describing: token), String(reflecting: token), "\(token)", dumped] {
      #expect(!text.contains("tmp-key"), "klucz w opisie: \(text)")
    }
  }
}
