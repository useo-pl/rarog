import Foundation
import RarogContract

// Tolerancja ciała odmowy. Właściciel: łączność.
//
// Odpowiedź na akcję podlega tej samej regule co ramka: nieznany kod błędu to zdanie ogólne, nie
// awaria. Kod (`error`) zostaje łańcuchem — obszary rozpoznają swoje (`conflict`, `client-id-conflict`…),
// a każdy inny spada do zdania serwera albo zdania ogólnego obszaru (`message ?? …`). Tu pilnujemy,
// żeby zdanie serwera nie przepadło przez kształt ciała, którego ścisły `APIErrorBody` nie przyjmie
// (brak `error`, kod nie-łańcuch, `null`, uszkodzony `messageRef`), i żeby pusty łańcuch nie udawał zdania.
// Kod zdania (`messageRef`) czytany osobno i tak samo ściśle jak w kontrakcie: uszkodzony albo `null`
// wypada, a zdanie zostaje tekstem serwera.
enum APIErrorTolerance {
  /// Kod, zdanie, powód i kod zdania z ciała odmowy; czego nie da się przeczytać, to `nil`.
  static func read(_ body: Data) -> (code: String?, message: String?, reason: String?, messageRef: SentenceRef?) {
    if let strict = try? JSONDecoder().decode(APIErrorBody.self, from: body) {
      return (nonEmpty(strict.error), nonEmpty(strict.message), nonEmpty(strict.reason), strict.messageRef)
    }
    guard let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any] else {
      return (nil, nil, nil, nil)
    }
    return (
      nonEmpty(object["error"] as? String), nonEmpty(object["message"] as? String),
      nonEmpty(object["reason"] as? String), sentenceRef(object["messageRef"])
    )
  }

  /// `messageRef` z ciała spoza ścisłego kształtu: obiekt, który przyjmuje dekoder kontraktu, inaczej `nil`.
  private static func sentenceRef(_ value: Any?) -> SentenceRef? {
    guard let value = value as? [String: Any], JSONSerialization.isValidJSONObject(value),
      let data = try? JSONSerialization.data(withJSONObject: value)
    else { return nil }
    return try? JSONDecoder().decode(SentenceRef.self, from: data)
  }

  private static func nonEmpty(_ value: String?) -> String? {
    guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
    return value
  }
}
