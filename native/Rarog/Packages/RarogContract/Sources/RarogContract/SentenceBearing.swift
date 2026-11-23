// Typ kontraktu z tekstami serwera do tłumaczenia. Tłumacz apki podaje renderer, a typ przepuszcza
// przez niego każde swoje pole tekstu: z parą `*Ref` jako `render(tekst, ref)`, bez pary jako
// `render(tekst, nil)`. Pola `*Ref` zostają bez zmian, więc tłumaczenie można powtórzyć w innym języku.

/// Renderer zdania: tekst z drutu i jego `ref` (albo `nil`) → tekst do pokazania.
public typealias SentenceRenderer = @Sendable (String, SentenceRef?) -> String

/// Typ, którego pola tekstu przechodzą przez renderer zdań serwera.
public protocol SentenceBearing {
  mutating func translate(_ render: (String, SentenceRef?) -> String)
}
