import Foundation
import RarogContract
import RarogCore
@testable import RarogUI
import Testing

// Trasy serwera na ekranie „Serwer” i tytuł karty „Sparować z …?”: serwer tylko przez iroh
// pokazuje skrót EndpointId zamiast adresu, serwer z adresem i parą iroh — adres i drugi wiersz iroh; karta linku `k`+`r`
// nazywa serwer skrótem iroh. Zdania o sieci bez Tailscale jako jedynej drogi.

@Suite("ekran „Serwer”: trasy adres i iroh, tytuł karty parowania")
struct ServerRouteRowsTests {
  static let endpointId = "1a2b3c4d" + String(repeating: "5e6f7a8b", count: 7)
  static let relayField = "https%3A%2F%2Feuc1-1.relay.n0.iroh.link.%2F"
  static let code = "BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ"
  static let address = URL(string: "https://rarog.example.ts.net")!

  static func link(_ fragment: String) throws -> PairingLink {
    try PairingLink.parse("rarog://pair#v=1&\(fragment)&c=\(code)").get()
  }

  @Test("iroh-only credential: one row labelled “iroh” with the bare short EndpointId instead of an address")
  func irohOnly() {
    let rows = ServerRouteRows.rows(url: nil, irohEndpointId: Self.endpointId)
    #expect(rows == [ServerRouteRow(label: "iroh", value: "1a2b3c4d", identifier: "settings.iroh")])
    #expect(L("settings.irohLabel", language: .en) == "iroh", "a product name stays lowercase in English too")
  }

  @Test("address with an iroh pair: the address row, then the “iroh” row with the bare short EndpointId")
  func originWithPair() {
    let rows = ServerRouteRows.rows(url: Self.address, irohEndpointId: Self.endpointId)
    #expect(rows == [
      ServerRouteRow(label: "Adres", value: "https://rarog.example.ts.net", identifier: "settings.address"),
      ServerRouteRow(label: "iroh", value: "1a2b3c4d", identifier: "settings.iroh"),
    ])
    #expect(ServerRouteRows.rows(url: Self.address, irohEndpointId: nil).map(\.identifier) == ["settings.address"])
  }

  @Test("karta parowania: link `k`+`r` ma tytuł ze skrótem iroh, link z adresem — host adresu")
  func confirmTitle() throws {
    let iroh = try Self.link("k=\(Self.endpointId)&r=\(Self.relayField)")
    #expect(UICopy.pairConfirmTitle(iroh) == "Sparować z iroh · 1a2b3c4d?")
    #expect(UICopy.pairConfirmSubtitle(iroh) == Self.endpointId, "pełny EndpointId pod tytułem, nie `iroh:` URL")
    let both = try Self.link("u=https%3A%2F%2Frarog.example.ts.net&k=\(Self.endpointId)&r=\(Self.relayField)")
    #expect(UICopy.pairConfirmTitle(both) == "Sparować z rarog.example.ts.net?")
    #expect(UICopy.pairConfirmSubtitle(both) == "https://rarog.example.ts.net")
  }

  @Test("zdania o sieci nie każą włączać Tailscale jako jedynej drogi, zły adres bez „wyłącznie przez https”")
  func neutralNetworkSentences() {
    for language in [CopyLanguage.en, .pl] {
      for key in ["app.serverSilent", "pairing.failure.offline"] {
        #expect(!L(key, language: language).contains("Tailscale"), "\(key) \(language)")
      }
      #expect(!L("app.forbiddenBody", language: language).contains("Turn on Tailscale"))
      #expect(!L("app.forbiddenBody", language: language).contains("włącz Tailscale"))
      #expect(!L("pairing.linkError.badAddress", language: language).lowercased().contains("https"))
    }
  }
}
