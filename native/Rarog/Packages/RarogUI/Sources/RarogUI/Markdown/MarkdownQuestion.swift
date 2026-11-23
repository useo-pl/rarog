import Foundation

// Pytanie do użytkownika w odpowiedzi agenta: akapit, który zaczyna się od pogrubionego znacznika
// („Do Ciebie:” albo angielskiego „To you:”), i wszystko pod nim do końca bloku tekstu. Jedna definicja reguły —
// czyta ją układ (``MarkdownLayout``, akapity z `question`). Każde pytanie ze znacznikiem wygląda tak samo: apka
// nie śledzi, czy już padła odpowiedź. Liczy się tylko akapit NAJWYŻSZEGO poziomu:
// znacznik w cytacie, w pozycji listy, w nagłówku i w bloku kodu to cytowanie albo przykład, nie pytanie.
// Właściciel: transkrypt, markdown.
public enum MarkdownQuestion {
  /// Znaczniki dosłownie, z dwukropkiem i wielkością liter: polski z reguły stylu odpowiedzi agentów
  /// (instrukcje Claude Code) i angielski dla agentów piszących
  /// po angielsku. Oba podlegają tym samym regułom.
  public static let markers = ["Do Ciebie:", "To you:"]

  /// Indeks bloku, od którego zaczyna się pytanie: pierwszy akapit najwyższego poziomu, którego pierwszy fragment
  /// w linii jest pogrubiony i zaczyna się od znacznika (`**Do Ciebie:** …`, `**To you:** …` i cała pogrubiona
  /// linia `**Do Ciebie: …?**`). Po pojedynczym łamaniu linii znacznik jest w środku akapitu, więc się nie liczy.
  /// `nil` = wiadomość bez pytania.
  public static func start(in blocks: [MarkdownBlock]) -> Int? {
    blocks.firstIndex { block in
      // Literał przed parserem w linii: znacznik stoi dosłownie na początku źródła akapitu, zaraz za znakami
      // pogrubienia. Parser w linii zdejmuje ucieczki, więc `**Do Ciebie\:**` dałby pogrubione „Do Ciebie:”;
      // sam filtr `contains` przepuszczał go, gdy dosłowny znacznik stał dalej w akapicie.
      // Pierwszy fragment musi zaczynać się od tego samego znacznika, który stoi dosłownie w źródle.
      guard case let .paragraph(text) = block else { return false }
      let source = text.drop(while: { $0 == "*" || $0 == "_" })
      guard let marker = markers.first(where: { source.hasPrefix($0) }),
        let first = MarkdownInlineParser.spans(text).first
      else { return false }
      return first.style.contains(.bold) && first.text.hasPrefix(marker)
    }
  }

  /// Czy tekst wiadomości ma pytanie do użytkownika. Tani filtr przed parserem: prawie żadna wiadomość nie niesie
  /// znacznika, więc zwykle kończy się na jednym przeszukaniu tekstu.
  public static func contains(_ source: String) -> Bool {
    guard markers.contains(where: { source.contains($0) }) else { return false }
    return start(in: MarkdownParser.blocks(source)) != nil
  }
}
