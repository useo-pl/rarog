import Foundation
import RarogContract
import RarogCore

// Pasek cytatu promptu z listą tur. Przerwanie tury mówi w `UICopy+Composer` (linia pod polem).
// Właściciel: sterowanie sesją.
extension UICopy {
  // MARK: Pasek promptu i lista tur

  public static var promptsTitle: String { L("sessionControl.promptsTitle") }
  static var promptsEmpty: String { L("sessionControl.promptsEmpty") }
  static var promptsCurrent: String { L("sessionControl.promptsCurrent") }
  static var promptsNewest: String { L("sessionControl.promptsNewest") }
  static var promptBarHint: String { L("sessionControl.promptBarHint") }

  /// Pasek dla czytnika: co cytuje.
  static func promptBarSpoken(_ text: String) -> String { L("sessionControl.promptBarSpoken", text) }

  /// Wiersz listy dla czytnika: „Prompt N z M" (numer w sesji, od najstarszego), „najnowszy" przy pierwszym
  /// wierszu listy, godzina, tekst i znacznik bieżącego.
  static func promptRowSpoken(_ entry: PromptEntry, number: Int, count: Int, current: Bool) -> String {
    var parts = [L("sessionControl.promptRowSpoken", number, count)]
    if number == count { parts.append(promptsNewest) }
    if let clock = ServerTime.clock(entry.at) { parts.append(clock) }
    parts.append(entry.text)
    if current { parts.append(promptsCurrent) }
    return list(parts, .comma)
  }
}
