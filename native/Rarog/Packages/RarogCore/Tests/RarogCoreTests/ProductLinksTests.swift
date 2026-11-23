import Foundation
@testable import RarogCore
import Testing

// Adresy produktu: polityka prywatności, instrukcja serwera, wsparcie i adres pomocy. Ekran parowania i sekcja
// „O apce” biorą je z jednego miejsca; strażnik `server/test/product-identity-guard.test.ts` czyta ten sam plik.
@Suite("adresy produktu: każda stała pod rarog.ai")
struct ProductLinksTests {
  @Test("strony: https, host rarog.ai, ścieżka z kontraktu; dyktowanie to kotwica polityki prywatności")
  func pages() {
    let pages: [(URL, String)] = [
      (ProductLinks.privacy, "/privacy"), (ProductLinks.setup, "/setup"), (ProductLinks.support, "/support"),
      (ProductLinks.privacyDictation, "/privacy"),
    ]
    for (url, path) in pages {
      #expect(url.scheme == "https", "\(url)")
      #expect(url.host() == "rarog.ai", "\(url)")
      #expect(url.path() == path, "\(url)")
      #expect(url.absoluteString.hasPrefix("https://rarog.ai/"), "\(url)")
    }
    #expect(ProductLinks.privacy.absoluteString == "https://rarog.ai/privacy")
    #expect(ProductLinks.setup.absoluteString == "https://rarog.ai/setup")
    #expect(ProductLinks.support.absoluteString == "https://rarog.ai/support")
    #expect(ProductLinks.privacyDictation.absoluteString == "https://rarog.ai/privacy#dictation")
    #expect(ProductLinks.privacyDictation.fragment() == "dictation")
  }

  @Test("adres pomocy: jedna skrzynka w domenie rarog.ai")
  func mail() {
    #expect(ProductLinks.supportMail == "support@rarog.ai")
    #expect(ProductLinks.supportMail.hasSuffix("@rarog.ai"))
    #expect(ProductLinks.supportMail.split(separator: "@").count == 2)
  }
}
