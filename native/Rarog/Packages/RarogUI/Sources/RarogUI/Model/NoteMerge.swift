import Foundation
import RarogContract

// Konflikt notatki projektu: co da się zrobić z dwiema wersjami bez zgadywania, którą człowiek woli.
// Serwer nigdy nie scala; apka zna wspólnego przodka (wersję, na której człowiek pisał), więc umie rozpoznać
// najczęstszy konflikt — obie strony TYLKO dopisały na końcu — i złożyć go jednym tapnięciem bez straty.
// Czyste funkcje, testy na macOS. Właściciel: notatki (apka natywna).
enum NoteMerge {
  /// Wynik „Połącz”: przodek, dopisek tamtej wersji, potem mój dopisek — o ile obie wersje zaczynają się od przodka
  /// i wynik mieści się w suficie dokumentu. `nil` = to nie są same dopiski (albo za długie): zostaje porównanie.
  static func appended(base: String, theirs: String, mine: String) -> String? {
    guard theirs.hasPrefix(base), mine.hasPrefix(base) else { return nil }
    let mineTail = mine.dropFirst(base.count)
    let theirsTail = theirs.dropFirst(base.count)
    let merged: String
    if mineTail.isEmpty {
      merged = theirs
    } else if theirsTail.isEmpty {
      merged = mine
    } else {
      // Dopiski stykają się nową linią: dwa zdania z dwóch urządzeń nie sklejają się w jedno.
      let joint = theirs.hasSuffix("\n") || mineTail.hasPrefix("\n") ? "" : "\n"
      merged = theirs + joint + mineTail
    }
    return NotesRules.units(merged) <= NotesRules.maxUnits ? merged : nil
  }

  /// „Wstaw obie do pola”: moja wersja, pusta linia, tamta — człowiek scala ręcznie. `nil` ponad sufitem.
  static func both(mine: String, theirs: String) -> String? {
    let joined = mine + "\n\n" + theirs
    return NotesRules.units(joined) <= NotesRules.maxUnits ? joined : nil
  }

  /// Linie wersji `lines`, których druga wersja nie ma (kreska na stronie „Porównaj”). Liczy się krotność: linia
  /// powtórzona dwa razy w jednej wersji i raz w drugiej ma kreskę przy drugim wystąpieniu.
  static func lineMarks(_ lines: [String], against other: [String]) -> [Bool] {
    var available: [String: Int] = [:]
    for line in other { available[line, default: 0] += 1 }
    return lines.map { line in
      guard let count = available[line], count > 0 else { return true }
      available[line] = count - 1
      return false
    }
  }

  /// Linie dokumentu tak, jak stoją w polu (pusta linia też jest linią).
  static func lines(_ text: String) -> [String] {
    text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
  }
}
