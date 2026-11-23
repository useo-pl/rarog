import Foundation

// Zwijanie długich promptów. Czyste reguły, testowane na macOS; rysuje
// `MessageContentView`. Właściciel: transkrypt.

/// Zwinięcie długiej wiadomości człowieka: ile ma linii i czy człowiek ją rozwinął.
public struct PromptFold: Sendable, Equatable {
  /// Linie tekstu według ``PromptFolds/lines(_:)`` — liczba na przycisku „Pokaż całość · N linii”.
  public let lines: Int
  public let expanded: Bool

  public init(lines: Int, expanded: Bool) {
    self.lines = lines
    self.expanded = expanded
  }
}

/// Kiedy prompt się zwija i ile ma linii. Kryterium to DŁUGOŚĆ wiadomości człowieka, nie rozpoznanie wklejki: serwer
/// zdejmuje znaczniki `pasted_content`, a Rarog wysyła przez wklejanie prawie wszystko. Linie liczy się z tekstu
/// wiadomości, nie z układu — decyzja i liczba nie zależą od szerokości kolumny, pisma ani obrotu, więc wiersz nie
/// zmienia się przy zmianie okna, a echo dostaje to samo co wpis w locie.
public enum PromptFolds {
  /// Prompt dłuższy niż tyle linii się zwija.
  public static let threshold = 15
  /// Zwinięty prompt pokazuje tyle linii prozy (wysokość: tyle odstępów linii pisma treści).
  public static let visible = 6
  /// Tyle znaków liczy się za jedną linię ekranu: dymek ma najwyżej 47,5 em (≈ 95–100 znaków prozy 16 pt), więc
  /// długa linia źródła zawija się w kilka.
  public static let lineWidth = 100

  /// Linie tekstu: każda linia źródła (między `\n`) to ⌈znaki / 100⌉, pusta — 1. Białe znaki na końcu tekstu się nie
  /// liczą; znakiem jest grafem (emoji i litera ze znakiem łączącym to jeden).
  public static func lines(_ text: String) -> Int {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return 0 }
    // `\r\n` to w Swifcie jeden grafem — podział po samym `\n` by go nie widział (jak w `MiniDiff`).
    return trimmed.split(omittingEmptySubsequences: false, whereSeparator: { $0 == "\n" || $0 == "\r\n" })
      .reduce(0) { sum, line in sum + max(1, (line.count + lineWidth - 1) / lineWidth) }
  }

  /// Zwinięcie tekstu wiadomości człowieka; `nil` = krótki, bez przycisku.
  public static func fold(_ text: String, expanded: Bool) -> PromptFold? {
    let count = lines(text)
    return count > threshold ? PromptFold(lines: count, expanded: expanded) : nil
  }
}
