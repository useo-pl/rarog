import Foundation
@testable import RarogTransport
import Testing

// Jedna tożsamość serwera po adresie: właściciel danych apki
// porównuje znormalizowany ``ServerOrigin``, nie tekst adresu.

@Suite("tożsamość serwera po adresie: ServerOrigin")
struct ServerOriginTests {
  private func origin(_ text: String) -> ServerOrigin? {
    URL(string: text).flatMap(ServerOrigin.init)
  }

  @Test("równoważne adresy to ten sam serwer: wielkość liter, port domyślny, ukośnik, ścieżka i zapytanie", arguments: [
    "https://rarog.example", "https://RAROG.example", "HTTPS://rarog.example:443", "https://rarog.example/",
    "https://rarog.example:443/", "https://Rarog.Example/sciezka?x=1",
  ])
  func equivalent(text: String) throws {
    let base = try #require(origin("https://rarog.example"))
    #expect(origin(text) == base, "\(text)")
    #expect(origin(text)?.description == "https://rarog.example:443")
  }

  @Test("inny schemat, port niedomyślny albo host to inny serwer", arguments: [
    "http://rarog.example", "https://rarog.example:8443", "http://rarog.example:443", "https://inny.example",
    "https://rarog.example.inny",
  ])
  func different(text: String) throws {
    let base = try #require(origin("https://rarog.example"))
    #expect(try #require(origin(text)) != base, "\(text)")
  }

  @Test("http bez portu to port 80; adres bez hosta albo z obcym schematem nie ma tożsamości")
  func defaultsAndInvalid() {
    #expect(origin("http://Rarog.Example") == origin("http://rarog.example:80"))
    #expect(origin("http://rarog.example:80")?.port == 80)
    #expect(origin("rarog://pair") == nil)
    #expect(origin("file:///tmp/x") == nil)
    #expect(origin("https://") == nil)
  }

  @Test("kodowanie to rekord pola `origin` właściciela danych (scheme, host, port)")
  func codableShape() throws {
    let value = try #require(origin("https://RAROG.example/"))
    let json = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as? [String: Any])
    #expect(Set(json.keys) == ["scheme", "host", "port"])
    #expect(json["host"] as? String == "rarog.example" && json["port"] as? Int == 443)
    #expect(try JSONDecoder().decode(ServerOrigin.self, from: JSONEncoder().encode(value)) == value)
  }
}
