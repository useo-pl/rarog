import Foundation
import RarogContract
import RarogCore

// Notatki projektu: pasek zakładek, dymek do czytania, formularz do pisania, konflikt i dymki po zamknięciu.
// Brzmienie z projektu burzy UX i UI (`docs/design.md` „Project note"). Zawsze „notatka PROJEKTU" tam, gdzie
// mogłaby się pomylić z notatką do opcji pytania, która jedzie do agenta — ta nie jedzie nigdzie.
// Właściciel: notatki (apka natywna).
extension UICopy {
  // MARK: Wejścia

  static var noteProject: String { L("notes.project") }
  /// Tytuł dymka na telefonie i rodzaj w tytule formularza.
  static var noteTitle: String { L("notes.title") }
  /// Etykieta maszynowa nad treścią (dymek iPada, sekcja ekranu projektu).
  static var noteEyebrow: String { L("notes.eyebrow") }
  static var noteTabEmpty: String { L("notes.tabEmpty") }
  static var noteTabContent: String { L("notes.tabContent") }
  static var noteTabUnsaved: String { L("notes.tabUnsaved") }
  static var noteTabReadHint: String { L("notes.tabReadHint") }
  static var noteTabWriteHint: String { L("notes.tabWriteHint") }
  /// Dopisek do zdania nagłówka projektu w drzewie.
  static var noteTreeSpoken: String { L("notes.treeSpoken") }
  static var noteShortcut: String { L("notes.shortcut") }

  // MARK: Dymek i sekcja ekranu projektu

  static var noteEdit: String { L("notes.edit") }
  static var noteEditSpoken: String { L("notes.editSpoken") }
  static var noteDictate: String { L("notes.dictate") }
  static func noteShowAll(lines: Int) -> String {
    L("notes.showAll", lines)
  }
  static var noteShowLess: String { L("notes.showLess") }

  // MARK: Formularz

  static var noteClose: String { L("notes.close") }
  static var notePlaceholder: String { L("notes.placeholder") }
  static var noteDone: String { L("notes.done") }
  static var noteDoneHint: String { L("notes.doneHint") }
  static var noteRetry: String { L("notes.retry") }
  static var noteRestore: String { L("notes.restore") }
  static var noteCopy: String { L("notes.copy") }
  static var noteLoadOffline: String { L("notes.loadOffline") }
  static var noteDisabled: String { L("notes.disabled") }
  static var noteDirectoryFallback: String { L("notes.directoryFallback") }
  static var noteFull: String { L("notes.full") }
  static var noteDictationFull: String { L("notes.dictationFull") }

  /// Czas zapisu w wierszu stanu: „14:07" dziś, „wczoraj 21:40", dawniej „9 paź 21:40".
  static func noteTime(_ version: Double, now: Date = Date(), timeZone: TimeZone = .current) -> String {
    let date = Date(timeIntervalSince1970: version / 1000)
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = timeZone
    let clock = ServerTime.clock(date, timeZone: timeZone)
    if calendar.isDate(date, inSameDayAs: now) { return clock }
    if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) {
      return L("notes.time", clock)
    }
    return ServerTime.dayClock(date, timeZone: timeZone)
  }

  static func noteSavedAt(_ version: Double, now: Date = Date()) -> String { L("notes.savedAt", noteTime(version, now: now)) }
  static var noteSaving: String { L("notes.saving") }
  static var noteLoading: String { L("notes.loading") }
  static func noteRefreshed(_ version: Double, now: Date = Date()) -> String {
    L("notes.refreshed", noteTime(version, now: now))
  }
  static func noteOffline(_ machine: ServerMachine) -> String {
    machine == .mac ? L("notes.offline") : L("notes.offline.vps")
  }
  static var noteServerFailed: String { L("notes.serverFailed") }
  static var noteRefusedFallback: String { L("notes.refusedFallback") }
  static var noteLoggedOut: String { L("notes.loggedOut") }
  static var noteDiskFailed: String { L("notes.diskFailed") }
  static var noteEmptyWillDelete: String { L("notes.emptyWillDelete") }
  static var noteDeletedStatus: String { L("notes.deletedStatus") }
  static func noteRestored(_ at: Date, timeZone: TimeZone = .current) -> String {
    L("notes.restored", ServerTime.clock(at, timeZone: timeZone))
  }
  static var noteNew: String { L("notes.new") }

  /// Licznik od 90 % sufitu: „45 120 / 49 152" (jednostki UTF-16, jak liczy serwer).
  static func noteCounter(_ units: Int) -> String {
    L("notes.counter", grouped(units), grouped(NotesRules.maxUnits))
  }

  /// Od ilu jednostek stoi licznik.
  static let noteCounterFrom = NotesRules.maxUnits * 9 / 10

  static func notePasteTooLong(paste: Int, left: Int) -> String {
    L("notes.pasteTooLong", grouped(paste), grouped(left))
  }

  /// Tysiące oddzielone separatorem języka (`notes.groupSeparator`, po polsku twarda spacja): „49 152", od 1000 —
  /// licznik stoi obok sufitu, więc obie liczby grupują się tak samo (locale `pl` grupuje dopiero od 10 000).
  static func grouped(_ value: Int) -> String {
    let separator = L("notes.groupSeparator")
    let digits = String(value)
    var out = ""
    for (index, char) in digits.enumerated() {
      if index > 0, (digits.count - index) % 3 == 0 { out += separator }
      out.append(char)
    }
    return out
  }

  // MARK: Konflikt

  static func noteConflict(_ version: Double, now: Date = Date()) -> String {
    L("notes.conflict", noteTime(version, now: now))
  }
  static var noteConflictStatus: String { L("notes.conflictStatus") }
  static var noteConflictSpoken: String { L("notes.conflictSpoken") }
  static var noteLineOnlyHere: String { L("notes.lineOnlyHere") }
  static var noteMerge: String { L("notes.merge") }
  static var noteCompare: String { L("notes.compare") }
  static var noteCompareTitle: String { L("notes.compareTitle") }
  static func noteServerVersion(_ version: Double, now: Date = Date()) -> String {
    L("notes.serverVersion", noteTime(version, now: now))
  }
  static var noteMineVersion: String { L("notes.mineVersion") }
  static var noteCompareAppended: String { L("notes.compareAppended") }
  static var noteCompareDiverged: String { L("notes.compareDiverged") }
  static var noteKeepMine: String { L("notes.keepMine") }
  static var noteTakeTheirs: String { L("notes.takeTheirs") }
  static var noteInsertBoth: String { L("notes.insertBoth") }
  static func noteKeepMineEffect(_ version: Double, now: Date = Date()) -> String {
    L("notes.keepMineEffect", noteTime(version, now: now))
  }
  static var noteTakeTheirsEffect: String { L("notes.takeTheirsEffect") }
  static func noteMerged(_ version: Double, now: Date = Date()) -> String {
    L("notes.merged", noteTime(version, now: now))
  }
  static func noteTook(_ version: Double, now: Date = Date()) -> String {
    L("notes.took", noteTime(version, now: now))
  }
  static var noteUndo: String { L("notes.undo") }
  static var noteOpen: String { L("notes.open") }

  // MARK: Dymki po zamknięciu

  static func noteDeletedToast(_ cwd: String) -> String {
    L("notes.deletedToast", ProjectPath.name(cwd))
  }
  static func noteNotSavedToast(_ cwd: String) -> String {
    L("notes.notSavedToast", ProjectPath.name(cwd))
  }

  /// Zdanie dymka po zdarzeniu dokumentu.
  static func noteEvent(_ event: NoteEvent) -> String {
    switch event {
    case let .deleted(cwd): noteDeletedToast(cwd)
    case let .notSaved(cwd): noteNotSavedToast(cwd)
    }
  }
}
