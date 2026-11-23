import Foundation
import RarogContract
import Testing

// Słowo maszyny serwera: jedna reguła dla apki i kafla oraz odczyt systemu z zapisu apki, który nigdy nie psuje
// całego zapisu (poświadczenie, odpięcie, atrybuty kafla).

@Suite("słowo maszyny serwera: Mac albo VPS")
struct ServerMachineTests {
  @Test("reguła: macOS i system nieznany (nil) = Mac; Linux, inny i spoza listy apki = VPS")
  func rule() {
    #expect(ServerMachine(.macos) == .mac)
    #expect(ServerMachine(nil) == .mac, "przed pierwszą sondą i serwer sprzed pola `system`")
    #expect(ServerMachine(.linux) == .vps)
    #expect(ServerMachine(.other) == .vps)
    #expect(ServerMachine(.unsupported) == .vps, "system nowszego serwera spoza listy: Mac byłby nieprawdą")
    // Każdy przypadek systemu ma słowo (nowy przypadek bez decyzji nie przejdzie po cichu).
    #expect(ServerSystem.allCases.map { ServerMachine($0) } == [.mac, .vps, .vps, .vps])
  }

  private struct Record: Decodable {
    let system: ServerSystem?
    let name: String

    enum CodingKeys: String, CodingKey { case system, name }

    init(from decoder: any Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      system = c.storedServerSystem(forKey: .system)
      name = try c.decode(String.self, forKey: .name)
    }
  }

  private func read(_ json: String) throws -> Record {
    try JSONDecoder().decode(Record.self, from: Data(json.utf8))
  }

  @Test("zapis apki: brak klucza, null i zły typ = nieznany; znane wartości; spoza listy = unsupported; reszta zapisu cała")
  func stored() throws {
    #expect(try read(#"{"name":"a"}"#).system == nil, "zapis sprzed pola")
    for bad in ["null", "1", #"["linux"]"#, #"{"x":1}"#] {
      let record = try read(#"{"name":"a","system":\#(bad)}"#)
      #expect(record.system == nil && record.name == "a", "\(bad)")
    }
    for system in ServerSystem.allCases {
      #expect(try read(#"{"name":"a","system":"\#(system.rawValue)"}"#).system == system)
    }
    #expect(try read(#"{"name":"a","system":"freebsd"}"#).system == .unsupported, "zapis nowszej wersji apki")
  }
}
