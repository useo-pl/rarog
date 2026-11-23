import Foundation

/// „Zgłoś problem” ze strony „O apce”: adres `mailto:` do ``ProductLinks/supportMail`` z tematem i zdaniem wstępnym
/// z copy oraz linią techniczną na końcu treści. Linia techniczna (wersja, build, system, rodzaj urządzenia) nie jest
/// copy: czyta ją człowiek ze wsparcia, w każdym języku apki tak samo.
public enum ProblemReport {
  /// Rodzaj urządzenia w linii technicznej; apka na Macu (Designed for iPad) to `mac`.
  public enum Device: String, Sendable, CaseIterable {
    case iPhone
    case iPad
    case mac = "Mac"
  }

  /// `Rarog 1.0 (123) · iOS 26.1 · iPad`.
  public static func technicalLine(version: String, build: String, system: String, device: Device) -> String {
    "Rarog \(version) (\(build)) · iOS \(system) · \(device.rawValue)"
  }

  /// `mailto:support@rarog.ai?subject=…&body=…`; treść to `body`, pusta linia i linia techniczna. Wartości koduje
  /// `URLComponents` (`queryItems` kodują też `&`, `=` i `#`); `+` zostaje w zapytaniu dosłownie, a klient poczty
  /// może wziąć go za spację, więc idzie jako `%2B`.
  public static func mailURL(
    subject: String, body: String, version: String, build: String, system: String, device: Device
  ) -> URL {
    let text = "\(body)\n\n\(technicalLine(version: version, build: build, system: system, device: device))"
    var parts = URLComponents()
    parts.scheme = "mailto"
    parts.path = ProductLinks.supportMail
    parts.queryItems = [URLQueryItem(name: "subject", value: subject), URLQueryItem(name: "body", value: text)]
    parts.percentEncodedQuery = parts.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
    // Stały adresat i zakodowane zapytanie zawsze dają adres; zapas to sam adresat.
    return parts.url ?? URL(string: "mailto:\(ProductLinks.supportMail)")!
  }
}
