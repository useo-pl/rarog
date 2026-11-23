// Kopia tolerancyjnego dekodera starej apki `TerminalServerFrame` (`TerminalFrames.swift`). Zasady kopii i typy
// współdzielone: `LegacyContract.swift`.
import Foundation

extension OldApp {
  /// Ramka tekstowa serwer → klient w kształcie starej apki: `.error(message:)` bez `ref`.
  enum TerminalServerFrame: Sendable, Hashable {
    case hello(backend: String)
    case exit
    case error(message: String)

    /// Zły JSON, nieznany typ i `err` bez niepustego `msg` dają `nil`; pole `msgRef` jest nieznane.
    static func decode(_ text: String) -> TerminalServerFrame? {
      guard let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)),
        let fields = object as? [String: Any], let type = fields["t"] as? String
      else { return nil }
      switch type {
      case "hello":
        return .hello(backend: fields["backend"] as? String ?? "")
      case "exit":
        return .exit
      case "err":
        guard let message = fields["msg"] as? String, !message.isEmpty else { return nil }
        return .error(message: message)
      default:
        return nil
      }
    }
  }
}
