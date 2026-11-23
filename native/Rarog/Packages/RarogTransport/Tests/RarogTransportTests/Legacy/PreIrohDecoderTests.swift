import Foundation
import RarogContract
@testable import RarogTransport
import Testing

// Wpis prywatny Keychaina między buildem sprzed pola `iroh` a buildem bieżącym, w obie strony. Złote bajty to wyjście
// `SystemKeychain.save` sprzed pola `iroh`, zapisane testem, zanim poświadczenie dostało pole `iroh`; kolejność kluczy
// JSON jest przypadkowa (`JSONEncoder` bez `.sortedKeys`), więc porównanie idzie na zdekodowanych wartościach.
// Zamrożony dekoder: `PreIrohStored.swift`.

@Suite("wpis Keychaina: build sprzed pola iroh i bieżący czytają się nawzajem")
struct PreIrohDecoderTests {
  /// Świeże parowanie, adres z portem niedomyślnym, bez `serverSystem` (sonda wersji jeszcze nie odpowiedziała).
  static let goldenFresh = Data(
    (#"{"credential":{"secret":"sekret-urzadzenia","serverId":"01010101010101010101010101010101","kid":"f849d673","#
      + #""pairedAt":813692800,"serverURL":"https:\/\/rarog.example:8443","deviceId":"03030303030303030303030303030303","#
      + #""serverName":"mac-demo","label":"iPhone·Rarog"},"version":1,"pushKey":"BQUF"}"#).utf8)

  /// Po sondzie wersji: `serverSystem` zapisany w miejscu (`rememberServerSystem`), adres bez portu.
  static let goldenProbed = Data(
    (#"{"credential":{"serverName":"mac-demo","secret":"sekret-urzadzenia","label":"iPhone·Rarog","#
      + #""serverURL":"https:\/\/rarog.example","serverSystem":"macos","kid":"f849d673","pairedAt":813692800,"#
      + #""deviceId":"03030303030303030303030303030303","serverId":"01010101010101010101010101010101"},"#
      + #""version":1,"pushKey":"BQUF"}"#).utf8)

  static let endpointId = "523c7996bad77424e96786cf7a7205115337a5b4565cd25506a0f297b191a5ea"
  static let iroh = ServerIrohConfig(endpointId: endpointId, relay: URL(string: "https://relay.rarog.ai/")!)

  /// Wpis bieżącego buildu z adresem HTTPS i parą iroh (link `u`+`k`+`r`).
  static let goldenBoth = Data(
    (#"{"pushKey":"BQUF","credential":{"iroh":{"relay":"https:\/\/relay.rarog.ai\/","#
      + #""endpointId":"523c7996bad77424e96786cf7a7205115337a5b4565cd25506a0f297b191a5ea"},"kid":"f849d673","#
      + #""serverURL":"https:\/\/rarog.example:8443","deviceId":"03030303030303030303030303030303","#
      + #""secret":"sekret-urzadzenia","serverSystem":"macos","serverId":"01010101010101010101010101010101","#
      + #""pairedAt":813692800,"label":"iPhone·Rarog","serverName":"mac-demo"},"version":1}"#).utf8)

  /// Wpis bieżącego buildu z serwerem tylko przez iroh (link `k`+`r`).
  static let goldenIrohOnly = Data(
    (#"{"version":1,"credential":{"label":"iPhone·Rarog","deviceId":"03030303030303030303030303030303","#
      + #""iroh":{"endpointId":"523c7996bad77424e96786cf7a7205115337a5b4565cd25506a0f297b191a5ea","#
      + #""relay":"https:\/\/relay.rarog.ai\/"},"pairedAt":813692800,"serverName":"mac-demo","kid":"f849d673","#
      + #""secret":"sekret-urzadzenia","serverId":"01010101010101010101010101010101"},"pushKey":"BQUF"}"#).utf8)

  static let pairedAt = Date(timeIntervalSince1970: 1_792_000_000)

  static func credential(_ server: String?, system: ServerSystem? = nil, iroh: ServerIrohConfig? = nil) -> DeviceCredential {
    DeviceCredential(
      deviceId: "03030303030303030303030303030303", secret: "sekret-urzadzenia", serverURL: server.map { URL(string: $0)! },
      serverId: "01010101010101010101010101010101", serverName: "mac-demo", label: "iPhone·Rarog", kid: "f849d673",
      pairedAt: pairedAt, serverSystem: system, iroh: iroh)
  }

  /// Wszystkie pola, które build sprzed pola `iroh` czyta z wpisu, i konto, pod którym go szuka.
  static func expectSame(
    _ old: PreIrohStored, _ current: SystemKeychain.Stored, sourceLocation: SourceLocation = #_sourceLocation
  ) {
    let (a, b) = (old.credential, current.credential)
    #expect(old.version == current.version && old.pushKey == current.pushKey, sourceLocation: sourceLocation)
    #expect(a.deviceId == b.deviceId && a.secret == b.secret && a.kid == b.kid, sourceLocation: sourceLocation)
    #expect(a.pairedAt == b.pairedAt && a.serverURL == b.serverURL && a.serverId == b.serverId, sourceLocation: sourceLocation)
    #expect(a.serverName == b.serverName && a.label == b.label, sourceLocation: sourceLocation)
    #expect(a.serverSystem == b.serverSystem, sourceLocation: sourceLocation)
    #expect(a.account == b.account, "konto wpisu", sourceLocation: sourceLocation)
  }

  @Test("złoty wpis main: dekoder main i bieżący dają te same wartości, konto i klucz push")
  func goldenEntries() throws {
    let cases: [(Data, DeviceCredential, String)] = [
      (Self.goldenFresh, Self.credential("https://rarog.example:8443"), "rarog.example:8443"),
      (Self.goldenProbed, Self.credential("https://rarog.example", system: .macos), "rarog.example"),
    ]
    for (golden, expected, account) in cases {
      let old = try #require(PreIrohStored.read(golden))
      let current = try JSONDecoder().decode(SystemKeychain.Stored.self, from: golden)
      Self.expectSame(old, current)
      #expect(current.credential == expected && current.pushKey == "BQUF")
      #expect(old.credential.account == account && current.credential.account == account)
    }
  }

  @Test("wpis zakodowany drogą `save` (HTTPS i HTTPS+iroh) czyta dekoder main: te same deviceId, sekret, kid, data, konto, push")
  func currentEncoderToPreIroh() throws {
    let credentials = [
      Self.credential("https://rarog.example"),
      Self.credential("https://RAROG.example:8443/", system: .linux),
      Self.credential("http://100.64.0.1:8930", system: .unsupported),
      Self.credential("https://rarog.example", iroh: Self.iroh),
      Self.credential("https://RAROG.example:8443/", system: .macos, iroh: Self.iroh),
    ]
    for credential in credentials {
      // Ta sama funkcja, której używa `SystemKeychain.save`.
      let data = try SystemKeychain.encode(credential, pushKey: "BQUF")
      let old = try #require(PreIrohStored.read(data), "\(credential)")
      let current = try #require(SystemKeychain.decode(data))
      Self.expectSame(old, current)
      #expect(current.credential == credential, "bieżący dekoder czyta to, co zapisał, z parą iroh")
      #expect(old.credential.deviceId == credential.deviceId && old.credential.secret == credential.secret)
      #expect(old.credential.kid == credential.kid && old.credential.pairedAt == credential.pairedAt)
      #expect(old.credential.account == credential.account && old.pushKey == "BQUF")
    }
    // Tylko iroh: dekoder main odrzuca (brak `serverURL`), więc starszy build skasuje wpis i pokaże parowanie.
    let irohOnly = try SystemKeychain.encode(Self.credential(nil, iroh: Self.iroh), pushKey: "BQUF")
    #expect(PreIrohStored.read(irohOnly) == nil)
    #expect(SystemKeychain.decode(irohOnly)?.credential == Self.credential(nil, iroh: Self.iroh))
  }

  @Test("złoty wpis HTTPS+iroh: dekoder main daje ten sam deviceId, sekret, kid, konto i push; bieżący czyta parę iroh")
  func goldenBoth() throws {
    let old = try #require(PreIrohStored.read(Self.goldenBoth), "nieznany klucz `iroh` pominięty")
    let current = try #require(SystemKeychain.decode(Self.goldenBoth))
    Self.expectSame(old, current)
    #expect(current.credential == Self.credential("https://rarog.example:8443", system: .macos, iroh: Self.iroh))
    #expect(old.credential.account == "rarog.example:8443" && current.credential.account == "rarog.example:8443")
    #expect(old.pushKey == "BQUF" && current.pushKey == "BQUF")
  }

  @Test("złoty wpis tylko-iroh: dekoder main rzuca (świadomie), bieżący czyta z kontem iroh:<id>")
  func goldenIrohOnly() throws {
    #expect(throws: DecodingError.self) { try JSONDecoder().decode(PreIrohStored.self, from: Self.goldenIrohOnly) }
    #expect(PreIrohStored.read(Self.goldenIrohOnly) == nil)
    let current = try #require(SystemKeychain.decode(Self.goldenIrohOnly))
    #expect(current.credential == Self.credential(nil, iroh: Self.iroh) && current.pushKey == "BQUF")
    #expect(current.credential.account == "iroh:\(Self.endpointId)")
  }

  @Test("wpis sprzed pola `serverSystem` czytają oba dekodery tak samo")
  func beforeServerSystem() throws {
    let golden = DeviceCredentialStoredTests.stored()
    let old = try #require(PreIrohStored.read(golden))
    Self.expectSame(old, try JSONDecoder().decode(SystemKeychain.Stored.self, from: golden))
  }

  @Test("dekoder main: nieznany klucz pominięty, wpis bez `serverURL` albo z `version` 2 nieczytelny")
  func preIrohRules() throws {
    var json = try #require(try JSONSerialization.jsonObject(with: Self.goldenProbed) as? [String: Any])
    var credential = try #require(json["credential"] as? [String: Any])
    credential["przyszlePole"] = ["a": 1]
    json["credential"] = credential
    json["przyszlePole"] = true
    let extra = try JSONSerialization.data(withJSONObject: json)
    let old = try #require(PreIrohStored.read(extra), "nieznane klucze pominięte")
    Self.expectSame(old, try JSONDecoder().decode(SystemKeychain.Stored.self, from: Self.goldenProbed))

    credential["serverURL"] = nil
    json["credential"] = credential
    #expect(PreIrohStored.read(try JSONSerialization.data(withJSONObject: json)) == nil, "bez adresu: nieczytelny")

    json = try #require(try JSONSerialization.jsonObject(with: Self.goldenProbed) as? [String: Any])
    json["version"] = 2
    #expect(PreIrohStored.read(try JSONSerialization.data(withJSONObject: json)) == nil, "inna wersja: nieczytelny")
  }
}
