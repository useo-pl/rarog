import Foundation
import RarogContract
@testable import RarogTransport
import Security
import Testing

// Wpis prywatny Keychaina (`SystemKeychain.Stored`, JSON z `DeviceCredential` i kopią klucza push) a pola
// `serverSystem` (ostatni znany system maszyny serwera) i `iroh` (trasa przez iroh obok albo zamiast adresu
// HTTPS). Nieczytelny wpis `load()` kasuje, a z nim parowanie, więc zapis sprzed pola, zapis nowszej wersji apki
// i zepsuta para iroh przy dobrym adresie muszą się dalej dekodować.

@Suite("poświadczenie w Keychainie: system maszyny serwera i trasy HTTPS i iroh")
struct DeviceCredentialStoredTests {
  /// Wpis tak, jak go zapisuje `SystemKeychain.save` (`JSONEncoder` bez ustawień: data jako `timeIntervalSinceReferenceDate`);
  /// bez `extra` — build sprzed pola `serverSystem`.
  static func stored(_ extra: String = "") -> Data {
    let credential = #"{"deviceId":"03030303030303030303030303030303","secret":"sekret","#
      + #""serverURL":"https:\/\/rarog.example","serverId":"01010101010101010101010101010101","#
      + #""serverName":"mac-demo","label":"iPhone·Rarog","kid":"f849d673","pairedAt":813692800\#(extra)}"#
    return Data(#"{"version":1,"credential":\#(credential),"pushKey":"BQUF"}"#.utf8)
  }

  static let pairedAt = Date(timeIntervalSince1970: 1_792_000_000)

  @Test("zapis sprzed pola: poświadczenie całe, system nieznany")
  func beforeField() throws {
    let entry = try JSONDecoder().decode(SystemKeychain.Stored.self, from: Self.stored())
    #expect(entry.version == 1 && entry.pushKey == "BQUF")
    #expect(entry.credential.deviceId == "03030303030303030303030303030303" && entry.credential.secret == "sekret")
    #expect(entry.credential.serverURL == URL(string: "https://rarog.example")!)
    #expect(entry.credential.pairedAt == Self.pairedAt && entry.credential.kid == "f849d673")
    #expect(entry.credential.serverSystem == nil)
  }

  @Test("system zapisany wraca; nieznany z nowszej apki = unsupported; null i zły typ = nieznany, klucz zostaje")
  func values() throws {
    for system in ServerSystem.allCases {
      let entry = try JSONDecoder().decode(
        SystemKeychain.Stored.self, from: Self.stored(#","serverSystem":"\#(system.rawValue)""#))
      #expect(entry.credential.serverSystem == system)
    }
    let future = try JSONDecoder().decode(SystemKeychain.Stored.self, from: Self.stored(#","serverSystem":"freebsd""#))
    #expect(future.credential.serverSystem == .unsupported && future.credential.secret == "sekret")
    for bad in ["null", "7", #"["linux"]"#] {
      let entry = try JSONDecoder().decode(SystemKeychain.Stored.self, from: Self.stored(#","serverSystem":\#(bad)"#))
      #expect(entry.credential.serverSystem == nil && entry.credential.deviceId == "03030303030303030303030303030303")
    }
  }

  @Test("zapis i odczyt przez kodowanie wpisu: bez systemu klucza nie ma, z systemem wraca ten sam")
  func roundTrip() throws {
    var credential = DeviceCredential(
      deviceId: "03030303030303030303030303030303", secret: "sekret", serverURL: URL(string: "https://rarog.example")!,
      serverId: "01010101010101010101010101010101", serverName: "mac-demo", label: "iPhone·Rarog", kid: "f849d673",
      pairedAt: Self.pairedAt)
    let bare = try JSONEncoder().encode(SystemKeychain.Stored(credential: credential, pushKey: "BQUF"))
    #expect(!String(decoding: bare, as: UTF8.self).contains("serverSystem"), "starszy build czyta ten sam kształt")
    #expect(try JSONDecoder().decode(SystemKeychain.Stored.self, from: bare).credential == credential)
    credential.serverSystem = .linux
    let data = try JSONEncoder().encode(SystemKeychain.Stored(credential: credential, pushKey: "BQUF"))
    #expect(String(decoding: data, as: UTF8.self).contains(#""serverSystem":"linux""#))
    #expect(try JSONDecoder().decode(SystemKeychain.Stored.self, from: data).credential == credential)
  }

  static let endpointId = "523c7996bad77424e96786cf7a7205115337a5b4565cd25506a0f297b191a5ea"
  static let iroh = #","iroh":{"endpointId":"523c7996bad77424e96786cf7a7205115337a5b4565cd25506a0f297b191a5ea","#
    + #""relay":"https:\/\/relay.rarog.ai\/"}"#

  /// Wpis bez adresu HTTPS; `extra` dokłada pola na końcu poświadczenia.
  static func storedWithoutURL(_ extra: String) -> Data {
    let credential = #"{"deviceId":"03030303030303030303030303030303","secret":"sekret","#
      + #""serverId":"01010101010101010101010101010101","serverName":"mac-demo","label":"iPhone·Rarog","#
      + #""kid":"f849d673","pairedAt":813692800\#(extra)}"#
    return Data(#"{"version":1,"credential":\#(credential),"pushKey":"BQUF"}"#.utf8)
  }

  @Test("trasy z zapisu: HTTPS+iroh i tylko-iroh wracają; konto host albo iroh:<id>")
  func routes() throws {
    let both = try #require(SystemKeychain.decode(Self.stored(Self.iroh)))
    let pair = ServerIrohConfig(endpointId: Self.endpointId, relay: URL(string: "https://relay.rarog.ai/")!)
    #expect(both.credential.serverURL == URL(string: "https://rarog.example")! && both.credential.iroh == pair)
    #expect(both.credential.account == "rarog.example" && both.credential.ignoredIroh == nil)
    let irohOnly = try #require(SystemKeychain.decode(Self.storedWithoutURL(Self.iroh)))
    #expect(irohOnly.credential.serverURL == nil && irohOnly.credential.iroh == pair && irohOnly.pushKey == "BQUF")
    #expect(irohOnly.credential.account == "iroh:\(Self.endpointId)")
    #expect(irohOnly.credential.secret == "sekret" && irohOnly.credential.kid == "f849d673")
    // `null` to brak pola, jak przy `serverSystem`.
    let nullURL = try #require(SystemKeychain.decode(Self.storedWithoutURL(#","serverURL":null"# + Self.iroh)))
    #expect(nullURL.credential.serverURL == nil && nullURL.credential.iroh == pair)
    let nullIroh = try #require(SystemKeychain.decode(Self.stored(#","iroh":null"#)))
    #expect(nullIroh.credential.iroh == nil && nullIroh.credential.ignoredIroh == nil, "null to nie zepsuta para")
  }

  @Test("wpis bez adresu i bez poprawnego iroh odrzucony: dekoder rzuca, odczyt `Stored` daje nil")
  func noRouteRejected() {
    let bad = #","iroh":{"endpointId":"523c","relay":"https:\/\/relay.rarog.ai\/"}"#
    for extra in ["", #","serverURL":null"#, #","iroh":null"#, bad] {
      let data = Self.storedWithoutURL(extra)
      #expect(SystemKeychain.decode(data) == nil, "\(extra)")
      #expect(throws: DecodingError.self) { try JSONDecoder().decode(SystemKeychain.Stored.self, from: data) }
    }
  }

  @Test("zepsute iroh przy dobrym adresie: wpis czytelny bez iroh, klucz urządzenia i push nietknięte, powód do logu")
  func brokenIrohIgnored() throws {
    let shortId = String(Self.endpointId.dropLast())
    let cases: [(String, String)] = [
      (#","iroh":{"endpointId":"\#(shortId)","relay":"https:\/\/relay.rarog.ai\/"}"#, "EndpointId"),
      (#","iroh":{"endpointId":"\#(Self.endpointId.uppercased())","relay":"https:\/\/relay.rarog.ai\/"}"#, "EndpointId"),
      (#","iroh":{"endpointId":"\#(Self.endpointId)","relay":"relay.rarog.ai"}"#, "relay"),
      (#","iroh":{"endpointId":"\#(Self.endpointId)","relay":"http:\/\/relay.rarog.ai\/"}"#, "relay"),
      (#","iroh":{"endpointId":"\#(Self.endpointId)"}"#, "shape"),
      (#","iroh":"523c""#, "shape"),
    ]
    for (extra, reason) in cases {
      let entry = try #require(SystemKeychain.decode(Self.stored(extra)), "\(extra)")
      #expect(entry.credential.iroh == nil && entry.credential.ignoredIroh?.contains(reason) == true, "\(extra)")
      #expect(entry.credential.deviceId == "03030303030303030303030303030303" && entry.credential.secret == "sekret")
      #expect(entry.credential.serverURL == URL(string: "https://rarog.example")! && entry.credential.account == "rarog.example")
      #expect(entry.pushKey == "BQUF" && entry.credential.kid == "f849d673")
      #expect(!(entry.credential.ignoredIroh ?? "").contains(Self.endpointId), "powód bez wartości pola")
    }
  }

  @Test("relay w postaci niekanonicznej czytany w kanonicznej (jak pole `r` linku)")
  func relayCanonical() throws {
    let extra = #","iroh":{"endpointId":"\#(Self.endpointId)","relay":"HTTPS:\/\/Relay.Rarog.AI:443"}"#
    let entry = try #require(SystemKeychain.decode(Self.stored(extra)))
    #expect(entry.credential.iroh?.relay == URL(string: "https://relay.rarog.ai/")!)
    #expect(ServerIrohConfig(validating: Self.endpointId, relay: "https://relay.rarog.ai:8443") != nil)
    #expect(ServerIrohConfig(validating: Self.endpointId, relay: "https://[::1]/") == nil, "IPv6 jak w linku: nie")
    #expect(ServerIrohConfig(validating: "", relay: "https://relay.rarog.ai/") == nil)
  }

  @Test("zapis poświadczenia bez żadnej trasy odmawia (errSecParam), zamiast zostawić wpis, który odczyt skasuje")
  func saveWithoutRouteRefused() throws {
    var credential = DeviceCredential(
      deviceId: "03030303030303030303030303030303", secret: "sekret", serverURL: nil,
      serverId: "01010101010101010101010101010101", serverName: "mac-demo", label: "iPhone·Rarog", kid: "f849d673",
      pairedAt: Self.pairedAt)
    #expect(throws: KeychainFailure(status: errSecParam)) { try SystemKeychain.encode(credential, pushKey: "BQUF") }
    let keychain = MemoryKeychain()
    #expect(throws: KeychainFailure(status: errSecParam)) { try keychain.save(credential, pushKey: "BQUF") }
    #expect(keychain.load() == .none)
    credential.iroh = ServerIrohConfig(endpointId: Self.endpointId, relay: URL(string: "https://relay.rarog.ai/")!)
    #expect(try keychain.save(credential, pushKey: "BQUF"))
    #expect(keychain.load() == .found(credential, pushKey: "BQUF"))
  }

  @Test("zapis tylko-iroh ze złym EndpointId albo relayem odmawia przed zmianą wpisu: poprzednie poświadczenie i push zostają")
  func saveWithInvalidIrohRefused() throws {
    let relay = URL(string: "https://relay.rarog.ai/")!
    var previous = DeviceCredential(
      deviceId: "03030303030303030303030303030303", secret: "sekret", serverURL: nil,
      serverId: "01010101010101010101010101010101", serverName: "mac-demo", label: "iPhone·Rarog", kid: "f849d673",
      pairedAt: Self.pairedAt)
    previous.iroh = ServerIrohConfig(endpointId: Self.endpointId, relay: relay)
    let keychain = MemoryKeychain()
    #expect(try keychain.save(previous, pushKey: "BQUF"))
    let broken = [
      ServerIrohConfig(endpointId: "x", relay: relay),
      ServerIrohConfig(endpointId: Self.endpointId.uppercased(), relay: relay),
      ServerIrohConfig(endpointId: Self.endpointId, relay: URL(string: "http://relay.rarog.ai/")!),
    ]
    for iroh in broken {
      var next = previous
      next.iroh = iroh
      #expect(throws: KeychainFailure(status: errSecParam), "\(iroh)") {
        try SystemKeychain.encode(next, pushKey: "CCCC")
      }
      #expect(throws: KeychainFailure(status: errSecParam), "\(iroh)") { try keychain.save(next, pushKey: "CCCC") }
      #expect(keychain.load() == .found(previous, pushKey: "BQUF"), "\(iroh)")
    }
  }
}
