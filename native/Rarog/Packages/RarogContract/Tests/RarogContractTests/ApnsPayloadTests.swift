// Jawny blok `rarog` v1 w ładunku alertu APNs: cel tapnięcia i rozpoznanie pusha próbnego.
// Serwer wysyła banery w kopercie v3 (`ApnsFramesTests`), a apka dalej przyjmuje v1 (`PushRouting`). Próbki
// v1 są tu inline i czyta je typ PRODUKCYJNY apki (`ApnsAlertEnvelope`); reszta próbek sprawdza reguły tolerancji.
import Foundation
import RarogContract
import Testing

@Suite("kontrakt APNs: blok `rarog` w alercie")
struct ApnsPayloadTests {
  private func decode(_ json: String) throws -> ApnsAlertEnvelope {
    try JSONDecoder().decode(ApnsAlertEnvelope.self, from: Data(json.utf8))
  }

  /// Blok `rarog` z ładunku v1 — dokładnie to, co apka dostaje w `userInfo`.
  private func rarog(_ json: String) throws -> ApnsRarogPayload {
    try #require(try decode(json).rarog)
  }

  @Test("jawny v1: zgoda, błąd, Codex z terminalem, push próbny bez sesji, sparowane urządzenie")
  func plainV1() throws {
    let blocking = try rarog(#"""
      {"aps":{"alert":{"title":"⏳ Czeka na zgodę · willow","body":"Edit — zapis notatek"},"badge":2,"sound":"default",
       "thread-id":"demo-willow"},"rarog":{"v":1,"kind":"permission","sessionId":"demo-willow"}}
      """#)
    #expect(blocking.version == ApnsRarogPayload.supportedVersion)
    #expect(blocking.kind == .permission && blocking.sessionId == "demo-willow" && blocking.termId == nil)
    let failure = try rarog(#"""
      {"aps":{"alert":{"title":"❌ Błąd · map-view","body":"Tura padła: brak połączenia z API."},"badge":2,
       "sound":"default","thread-id":"demo-map-view"},"rarog":{"v":1,"kind":"error","sessionId":"demo-map-view"}}
      """#)
    #expect(failure.kind == .error && failure.sessionId == "demo-map-view")
    let codex = try rarog(#"""
      {"aps":{"badge":0},"rarog":{"v":1,"kind":"done","sessionId":"demo-codex","termId":"0123456789abcdef"}}
      """#)
    #expect(codex.kind == .done && codex.sessionId == "demo-codex" && codex.termId == "0123456789abcdef")
    let test = try rarog(#"""
      {"aps":{"alert":{"title":"🔔 Powiadomienia działają","body":"Tap otwiera Raroga."},"sound":"default"},
       "rarog":{"v":1,"kind":"test"}}
      """#)
    #expect(test.kind == .test && test.sessionId == nil && test.termId == nil)
    // Push bezpieczeństwa: rodzaj znany, sesji nie ma — tap bez celu sesji.
    let paired = try rarog(#"""
      {"aps":{"alert":{"title":"🔐 Sparowano nowe urządzenie","body":"iPad·Rarog"},"sound":"default"},
       "rarog":{"v":1,"kind":"device-paired"}}
      """#)
    #expect(paired.kind == .devicePaired && paired.sessionId == nil && paired.termId == nil)
    // Nowa wersja Claude Code albo herdr na serwerze: rodzaj znany, sesji nie ma.
    let version = try rarog(#"""
      {"aps":{"alert":{"title":"🔄 Zmiana wersji","body":"herdr 0.9.5 → 0.9.6"},"sound":"default"},
       "rarog":{"v":1,"kind":"version-changed"}}
      """#)
    #expect(version.kind == .versionChanged && version.sessionId == nil && version.termId == nil)
    // Weekly plan limit at 97%: a known kind without a session.
    let weekly = try rarog(#"""
      {"aps":{"alert":{"title":"⚠️ Weekly limit at 97%","body":"Resets Nov 18, 15:00."},"sound":"default"},
       "rarog":{"v":1,"kind":"weekly-limit"}}
      """#)
    #expect(weekly.kind == .weeklyLimit && weekly.sessionId == nil && weekly.termId == nil)
  }

  @Test("rodzaje = `NotifyKind` serwera i push próbny; `aps` nie jest czytane")
  func kinds() throws {
    #expect(ApnsPushKind.allCases.map(\.rawValue)
      == ["permission", "question", "blocked", "done", "error", "limit", "test", "device-paired", "version-changed",
        "weekly-limit", "stalled"])
    let rarog = try #require(try decode(#"""
      {"aps":{"alert":{"title":"⏳ Czeka na zgodę · rarog","body":"Bash — testy"},"badge":2,"thread-id":"s-1"},
       "rarog":{"v":1,"sessionId":"s-1","kind":"question"}}
      """#).rarog)
    #expect(rarog.kind == .question && rarog.sessionId == "s-1")
  }

  @Test("nieznany rodzaj (nowszy serwer) nie gubi celu tapnięcia; wersję czyta wołający")
  func unknownKind() throws {
    // Próbka nieznanej wersji: `v: 3` (wersja 2 to szyfrowana koperta — `PushEnvelope`, `PushCryptoTests`).
    let rarog = try #require(try decode(#"{"rarog":{"v":3,"sessionId":"s-9","kind":"nowy"}}"#).rarog)
    #expect(rarog.kind == nil && rarog.sessionId == "s-9" && rarog.version == 3)
  }

  @Test("cudzy push bez bloku `rarog` to brak celu, nie błąd")
  func foreign() throws {
    #expect(try decode(#"{"aps":{"alert":"cudzy"}}"#).rarog == nil)
  }

  @Test("`null`, pusta sesja, zły terminal, brak `v` i brak rodzaju odrzucają blok")
  func rejections() {
    for json in [
      #"{"rarog":{"v":1,"sessionId":null,"kind":"done"}}"#,
      #"{"rarog":{"v":1,"sessionId":"","kind":"done"}}"#,
      #"{"rarog":{"v":1,"sessionId":"s","termId":"XYZ","kind":"done"}}"#,
      #"{"rarog":{"sessionId":"s","kind":"done"}}"#,
      #"{"rarog":{"v":1,"sessionId":"s"}}"#,
      #"{"rarog":null}"#,
    ] {
      #expect(throws: (any Error).self, "\(json)") { _ = try decode(json) }
    }
  }
}
