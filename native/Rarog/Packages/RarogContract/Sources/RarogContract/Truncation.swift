// Ucięcie tekstu przez serwer — pole `truncation` przy `PermissionRequest.displayText`
// i `ToolCallBlock.detail`. Tekst na drucie niesie dalej angielską stopkę (stara apka pokazuje go wprost); nowa
// apka bierze `prefix(count − footer)` w skalarach Unicode i składa własną stopkę z `cut`.

/// `{cut, footer}`: `cut` = ile skalarów Unicode serwer uciął, `footer` = ile skalarów na końcu tekstu to stopka.
public struct Truncation: Sendable, Hashable, Codable {
  public var cut: Int
  public var footer: Int

  enum CodingKeys: String, CodingKey { case cut, footer }

  public init(cut: Int, footer: Int) {
    self.cut = cut
    self.footer = footer
  }

  /// Obie liczby całkowite ≥ 0 (zod `z.number().int().nonnegative()`); inaczej obiekt wypada.
  public init(from decoder: any Decoder) throws {
    let c = try ContractContainer(decoder, keyedBy: CodingKeys.self)
    cut = try c.required(.cut)
    footer = try c.required(.footer)
    for (key, value) in [(CodingKeys.cut, cut), (.footer, footer)] where value < 0 {
      throw contractViolation(c.codingPath + [key], "ujemna liczba w truncation")
    }
  }

  /// Stopka mieści się w ciętym tekście: `footer` ≤ liczba skalarów Unicode (JS `[...text].length`). Brak tekstu
  /// przy `truncation` to też błąd producenta — nie ma czego ucinać.
  static func check(_ truncation: Truncation?, against text: String?, at path: [any CodingKey]) throws {
    guard let truncation else { return }
    guard let text else { throw contractViolation(path, "truncation bez ciętego tekstu") }
    guard truncation.footer <= text.unicodeScalars.count else {
      throw contractViolation(path, "stopka dłuższa niż cięty tekst")
    }
  }
}
