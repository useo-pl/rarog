import Foundation

/// Adresy produktu: polityka prywatności, instrukcja postawienia serwera, wsparcie i skrzynka pomocy. Ekran parowania
/// i strona „O apce” w Ustawieniach biorą je stąd; adresy nie są copy, więc nie mają wersji językowych.
/// Strażnik `server/test/product-identity-guard.test.ts` czyta ten plik: każda stała leży w domenie produktu.
public enum ProductLinks {
  public static let privacy = URL(string: "https://rarog.ai/privacy")!
  public static let setup = URL(string: "https://rarog.ai/setup")!
  public static let support = URL(string: "https://rarog.ai/support")!
  /// Akapit polityki prywatności o dyktowaniu (link z ekranu wyboru dyktowania).
  public static let privacyDictation = URL(string: "https://rarog.ai/privacy#dictation")!
  /// Adresat „Zgłoś problem” (`ProblemReport.mailURL`).
  public static let supportMail = "support@rarog.ai"
}
