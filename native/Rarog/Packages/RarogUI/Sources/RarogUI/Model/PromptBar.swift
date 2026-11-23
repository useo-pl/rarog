import Foundation
import RarogContract
import RarogCore

// Pasek cytatu promptu nad transkryptem i lista tur: reguły testowane na macOS. Promptem jest
// wiadomość człowieka z tekstem — ta sama definicja co Esc (`AppState.promptText`): sam załącznik
// nie, notka harnessu nie. Właściciel: sterowanie sesją.

/// Prompt w transkrypcie: numer wiadomości, tekst i chwila wysłania.
public struct PromptEntry: Sendable, Equatable, Identifiable {
  public let seq: Int
  public let text: String
  public let at: String

  public var id: Int { seq }
}

/// Co cytuje pasek: indeks promptu na liście i jego tekst.
public struct PromptQuote: Sendable, Equatable {
  public let index: Int
  public let entry: PromptEntry
}

public enum PromptBar {
  /// Ile punktów poniżej krawędzi prompt liczy się już za miniony: prompt schowany pod paskiem jest
  /// nie do odczytania, więc to on ma stać w pasku.
  public static let grab: Double = 32
  /// Przy samej górze pasek przykrywałby pierwszą wiadomość, którą się właśnie czyta.
  public static let nearTop: Double = 48

  /// Prompty sesji od najstarszego.
  public static func entries(_ messages: [TranscriptMessage]) -> [PromptEntry] {
    messages.compactMap { message in
      AppState.promptText(message).map { PromptEntry(seq: message.seq, text: $0, at: message.at) }
    }
  }

  /// Kolejność listy „Prompty w tej sesji": od najnowszego na górze
  /// do najstarszego na dole. Wpisy (`entries`) i bieżący (`current`) zostają od
  /// najstarszego — pasek liczy bieżący po numerze wiersza na krawędzi ekranu.
  public static func listOrder(_ entries: [PromptEntry]) -> [PromptEntry] {
    entries.sorted { $0.seq > $1.seq }
  }

  /// Numer wiadomości wiersza transkryptu (`m<seq>.<blok>`, `m<seq>.a`, znacznik czasu `t<seq>`, rozwijak serii
  /// `r<seq>`); `nil` = wiersz spoza wiadomości (płynąca odpowiedź, kolejka, karty — czyli PO ostatniej wiadomości).
  public static func seq(rowId: String) -> Int? {
    if rowId.hasPrefix("m"), let dot = rowId.firstIndex(of: ".") {
      return Int(rowId[rowId.index(after: rowId.startIndex)..<dot])
    }
    guard let first = rowId.first, first == "t" || first == "r" else { return nil }
    return Int(rowId.dropFirst())
  }

  /// Prompt, którego wynik stoi na krawędzi ekranu: ostatni o numerze ≤ numerowi wiersza na
  /// krawędzi (`nil` = wiersz za ostatnią wiadomością → ostatni prompt). Nad pierwszym promptem —
  /// pierwszy: pasek stoi wtedy nad treścią, która do niego należy.
  public static func current(_ entries: [PromptEntry], edgeSeq: Int?) -> PromptQuote? {
    guard !entries.isEmpty else { return nil }
    let edge = edgeSeq ?? Int.max
    let index = entries.lastIndex { $0.seq <= edge } ?? 0
    return PromptQuote(index: index, entry: entries[index])
  }

  /// Pasek schowany: przypięty transkrypt (prompt widać tuż nad dnem), sam szczyt albo brak promptu.
  public static func hidden(pinned: Bool, offsetFromTop: Double, quote: PromptQuote?) -> Bool {
    pinned || offsetFromTop < nearTop || quote == nil
  }
}
