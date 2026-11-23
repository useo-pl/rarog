import Foundation

/// Adres linku z treści, zanim pójdzie do systemu. Apka Claude przejmuje adresy `https://claude.ai/…` jako
/// universal links (plik `https://claude.ai/.well-known/apple-app-site-association`: m.in. `/artifact/*`, `/code/*`,
/// `/share/*`), więc stuknięty link do artefaktu otwierał apkę Claude zamiast przeglądarki. Ten sam plik zaczyna
/// grupy apek Claude od wykluczenia `{"#": "no_universal_links", "exclude": true}`: adres z DOKŁADNIE takim
/// fragmentem iOS oddaje przeglądarce domyślnej. Dlatego adres `https` na hoście `claude.ai` (bez subdomen) i bez
/// fragmentu dostaje `#no_universal_links`; każdy inny wraca bez zmian, także adres z fragmentem (pustym `#` też).
/// Zmienia się tylko adres, który dostaje system; widoczny tekst linku zostaje. Właściciel: transkrypt.
public enum BrowserLinks {
  /// Fragment wykluczenia z pliku AASA claude.ai.
  static let fragment = "no_universal_links"

  public static func outside(_ url: URL) -> URL {
    guard url.scheme?.lowercased() == "https", url.host(percentEncoded: false)?.lowercased() == "claude.ai",
      url.fragment == nil,
      // Dopisek do napisu, nie przez `URLComponents`: ten potrafi przekodować resztę adresu.
      let marked = URL(string: url.absoluteString + "#" + fragment)
    else { return url }
    return marked
  }
}
