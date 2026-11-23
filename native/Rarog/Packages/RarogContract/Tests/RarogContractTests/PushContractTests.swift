// Kontrakt APNs i Live Activity apki natywnej — ciała tras i status tokenu. Kształt
// z `shared/src/rest.ts` (`apnsRegisterBodySchema`, `apnsStatusResponseSchema`,
// `liveActivityRegisterBodySchema`, `liveActivityEndBodySchema`); serwer waliduje ciała tym samym
// schematem, więc klient nie wysyła niczego spoza niego. Złote odpowiedzi statusu:
// `shared/fixtures/rest/push.apns.status*.json` (`RestFixturesTests`).
import Foundation
import RarogContract
import Testing

@Suite("kontrakt REST: APNs i Live Activity")
struct PushContractTests {
  static let token = String(repeating: "a1b2c3d4", count: 8)

  private func encode(_ value: some Encodable) throws -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return String(decoding: try encoder.encode(value), as: UTF8.self)
  }

  private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSONDecoder().decode(type, from: Data(json.utf8))
  }

  @Test("rejestracja tokenu: komplet pól; `test` i `topic` lecą tylko, gdy są; `pushFormats` [3] i `locKeys` zawsze")
  func register() throws {
    // `locKeys: true`: katalog apki ma klucze `push.placeholder.*` i `push.chime.*`, więc serwer może wysłać
    // tekst zastępczy banera i dzwonek kafla kluczami zamiast polskich literałów.
    let formats = #""locKeys":true,"pushFormats":[3]"#
    let plain = ApnsRegisterBody(token: Self.token, environment: .development, label: "iPad·Rarog", alerts: true)
    #expect(try encode(plain)
      == #"{"alerts":true,"environment":"development","label":"iPad·Rarog",\#(formats),"token":"\#(Self.token)"}"#)
    let probe = ApnsRegisterBody(
      token: Self.token, environment: .production, label: "iPhone·Rarog", alerts: false, test: true)
    #expect(try encode(probe) == #"{"alerts":false,"environment":"production","label":"iPhone·Rarog",\#(formats),"#
      + #""test":true,"token":"\#(Self.token)"}"#)
    let declared = ApnsRegisterBody(
      token: Self.token, environment: .development, label: "iPad·Rarog", alerts: true, topic: "ai.example.app")
    #expect(try encode(declared) == #"{"alerts":true,"environment":"development","label":"iPad·Rarog",\#(formats),"#
      + #""token":"\#(Self.token)","topic":"ai.example.app"}"#)
    #expect(ApnsRegisterBody.supportedPushFormats == [3])
    #expect(ApnsRegisterBody.supportedPushFormats == [PushEnvelope.version])
    #expect(ApnsEnvironment.allCases.map(\.rawValue) == ["development", "production"])
  }

  @Test("status tokenu: zdrowy (`degradedSince: null`) i zdegradowany; obce klucze odcięte")
  func status() throws {
    let healthy = try decode(ApnsStatus.self,
      #"{"enabled":true,"registered":true,"alerts":true,"degradedSince":null,"nowe":1}"#)
    #expect(healthy.enabled && healthy.registered && healthy.alerts && healthy.degradedSince == nil)
    let degraded = try decode(ApnsStatus.self,
      #"{"enabled":true,"registered":true,"alerts":false,"degradedSince":"2026-10-07T10:00:00.000Z"}"#)
    #expect(degraded.degradedSince == "2026-10-07T10:00:00.000Z" && !degraded.alerts)
  }

  @Test("status tokenu: przyczyna degradacji — obie wartości czytane; brak, `null` i nieznana = brak przyczyny")
  func statusReason() throws {
    let base = #""enabled":true,"registered":true,"alerts":true,"degradedSince":"2026-10-07T10:00:00.000Z""#
    #expect(ApnsDegradedReason.allCases.map(\.rawValue) == ["pass-missing", "env-mismatch"])
    for (raw, reason) in [("pass-missing", ApnsDegradedReason.passMissing), ("env-mismatch", .envMismatch)] {
      let status = try decode(ApnsStatus.self, #"{\#(base),"degradedReason":"\#(raw)"}"#)
      #expect(status.degradedReason == reason, "\(raw)")
      #expect(status.degradedSince == "2026-10-07T10:00:00.000Z" && status.enabled && status.alerts, "\(raw)")
    }
    // Serwer sprzed pola, jawne `null` i przyczyna z nowszego serwera: reszta odpowiedzi czytana dalej.
    for extra in ["", #","degradedReason":null"#, #","degradedReason":"relay-down""#, #","degradedReason":"""#] {
      let status = try decode(ApnsStatus.self, "{\(base)\(extra)}")
      #expect(status.degradedReason == nil, "\(extra)")
      #expect(status.degradedSince == "2026-10-07T10:00:00.000Z" && status.registered, "\(extra)")
    }
    let healthy = try decode(ApnsStatus.self, #"{"enabled":true,"registered":true,"alerts":true,"degradedSince":null}"#)
    #expect(healthy.degradedReason == nil)
  }

  @Test("status tokenu: brak pola (także `degradedSince`), `null` w flagach i zły typ odrzucają odpowiedź")
  func statusRejections() {
    for json in [
      #"{"enabled":true,"registered":true,"degradedSince":null}"#,
      #"{"enabled":true,"registered":true,"alerts":true}"#,
      #"{"enabled":null,"registered":true,"alerts":true,"degradedSince":null}"#,
      #"{"enabled":true,"registered":true,"alerts":true,"degradedSince":5}"#,
      // Przyczyna złego typu: jak każde pole REST (`tailnet`, `status` w diffie) — nie łańcuch, to nie kontrakt.
      #"{"enabled":true,"registered":true,"alerts":true,"degradedSince":"t","degradedReason":5}"#,
      #"{"enabled":true,"registered":true,"alerts":true,"degradedSince":"t","degradedReason":["pass-missing"]}"#,
    ] {
      #expect(throws: (any Error).self, "\(json)") { _ = try decode(ApnsStatus.self, json) }
    }
  }

  @Test("wersja: `apnsEnabled` czytane, brak = starszy serwer; `webPushMutedClasses` starszego serwera odcięte")
  func version() throws {
    let base = #""version":"1","protocolVersion":3,"serverStartId":"s""#
    let old = try decode(VersionInfo.self, "{\(base)}")
    #expect(old.apnsEnabled == nil)
    let fresh = try decode(VersionInfo.self, #"{\#(base),"apnsEnabled":true}"#)
    #expect(fresh.apnsEnabled == true)
    let withMutedClasses = try decode(VersionInfo.self, #"{\#(base),"apnsEnabled":true,"webPushMutedClasses":["iPad"]}"#)
    #expect(withMutedClasses == fresh)
    #expect(throws: (any Error).self) {
      _ = try decode(VersionInfo.self, #"{\#(base),"apnsEnabled":null}"#)
    }
  }
}
