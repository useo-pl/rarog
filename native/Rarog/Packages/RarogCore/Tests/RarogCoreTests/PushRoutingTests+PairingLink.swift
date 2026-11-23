import Foundation
import RarogContract
@testable import RarogCore
import Testing

// The pairing link as an app address: `PushRouting.link(url:)` sends the universal link `https://<site>/pair#…`
// (the `applinks:` entitlement) to the same confirmation sheet as `rarog://pair#…`. The link rules themselves are
// `PairingLinkWire` and its shared golden cases; here only which address reaches them. Owner: push.

extension PushRoutingTests {
  @Test("universal link `https://<site>/pair#…`: the same pairing route as `rarog://pair#…`; other `https` = nothing")
  func universalPairingLink() throws {
    let host = PairingLinkWire.host
    let body = "v=1&u=https%3A%2F%2Frarog.example.ts.net&c=\(PairingFixtures.code)"
    func link(_ raw: String) throws -> AppLink? { PushRouting.link(url: try #require(URL(string: raw), "\(raw)")) }
    // The reference: the custom scheme link, unchanged by the universal link.
    let pairing = try PairingLink.parse("rarog://pair#\(body)").get()
    #expect(try link("rarog://pair#\(body)") == .pair(pairing))
    // The same text after either prefix opens the same confirmation sheet; the host is case-insensitive like DNS.
    #expect(try link("https://\(host)/pair#\(body)") == .pair(pairing))
    #expect(try link("HTTPS://\(host.uppercased())/pair#\(body)") == .pair(pairing))
    // The pairing path with a link the app does not understand: the sheet says what is wrong, as for `rarog://pair`.
    #expect(try link("https://\(host)/pair#v=2&u=https%3A%2F%2Frarog.example.ts.net&c=\(PairingFixtures.code)")
      == .badPair(.unsupportedVersion))
    #expect(try link("https://\(host)/pair") == .badPair(.notALink))
    // Any other `https` address is not the app's: no sheet, the app just opens.
    for raw in ["https://\(host)/", "https://\(host)/docs", "https://\(host)/docs#\(body)",
                "https://\(host)/pair/#\(body)", "https://www.\(host)/pair#\(body)",
                "https://evil.example/pair#\(body)", "http://\(host)/pair#\(body)"] {
      #expect(try link(raw) == nil, "\(raw)")
    }
  }
}
