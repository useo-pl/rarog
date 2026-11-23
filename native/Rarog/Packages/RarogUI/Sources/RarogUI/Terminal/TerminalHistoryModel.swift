import Foundation
import RarogContract
import RarogCore

// Historia terminala jako tekst do natywnego zaznaczania: stany arkusza
// i sufit wierszy, bez UIKit (testy na macOS). Scrollback żyje w panelu herdr, nie w emulatorze, więc
// „zaznacz i skopiuj" dłuższego fragmentu idzie przez `GET /api/term/<id>/history`. Treść żyje tylko w stanie
// arkusza — nie trafia do logów, na dysk ani do pamięci podręcznej. Właściciel: terminal.

/// Ile wierszy historii: 1000 na start (`TERM_HISTORY_DEFAULT_LINES`), 5000 to sufit serwera
/// (`TERM_HISTORY_MAX_LINES`, wartość ponad sufit serwer ścina).
public enum TerminalHistoryLimits {
  public static let initial = 1000
  public static let max = 5000

  /// „Wczytaj więcej": sufit, gdy historia była ucięta poniżej niego; `nil` = nie ma czego dociągać.
  public static func more(after lines: Int, truncated: Bool) -> Int? {
    truncated && lines < max ? max : nil
  }
}

/// Co pokazuje arkusz historii.
public enum TerminalHistoryPhase: Sendable, Equatable {
  case loading
  /// Tekst panelu; `truncated` = scrollback był dłuższy niż prośba.
  case loaded(text: String, truncated: Bool)
  case empty
  /// Zdanie do pokazania (serwera albo zapasowe).
  case failed(String)

  public init(_ outcome: TerminalHistoryOutcome) {
    switch outcome {
    case let .loaded(history):
      self = history.text.isEmpty ? .empty : .loaded(text: history.text, truncated: history.truncated)
    case .gone:
      self = .failed(UICopy.terminalHistoryGone)
    case let .failed(message):
      // Zdanie serwera, gdy je przysłał (503 gniazdo herdr) — on wie, dlaczego odmówił.
      self = .failed(message ?? UICopy.terminalHistoryFailed)
    }
  }

  /// Tekst do „Kopiuj całość"; `nil` = nie ma czego kopiować.
  public var text: String? {
    if case let .loaded(text, _) = self { return text }
    return nil
  }
}
