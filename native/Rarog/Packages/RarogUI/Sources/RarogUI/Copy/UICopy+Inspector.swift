import Foundation
import RarogContract
import RarogCore

// Prawy panel sesji na iPadzie: przycisk i skrót, nagłówki sekcji, stany pustki
// zmian w katalogu, wiersze zakończonych zadań i artefaktów. Właściciel: panel.
extension UICopy {
  // MARK: Przycisk i skrót

  public static var inspectorButton: String { L("inspector.button") }
  public static var shortcutShowInspector: String { L("inspector.shortcutShowInspector") }
  public static var shortcutHideInspector: String { L("inspector.shortcutHideInspector") }
  /// Cmd+I przy za wąskiej kolumnie: preferencja stoi, zdanie mówi, jak zrobić miejsce.
  public static var inspectorNoRoom: String { L("inspector.noRoom") }
  public static var inspectorLabel: String { L("inspector.label") }
  /// Telefon: tytuł arkusza z panelem sesji i podpowiedź czytnika linii statusu, która go otwiera.
  static var inspectorSheetTitle: String { L("inspector.sheetTitle") }
  static var inspectorSheetHint: String { L("inspector.sheetHint") }
  /// iPad: VoiceOver label and value of the width handle on the panel's left divider.
  static var inspectorWidthLabel: String { L("inspector.widthLabel") }
  static func inspectorWidthValue(_ points: Int) -> String { L("inspector.widthValue", points) }

  // MARK: W TLE

  /// „W TLE · 2" — sama etykieta, gdy nic nie leci.
  static func inspectorBackgroundTitle(_ count: Int) -> String {
    count > 0 ? L("inspector.backgroundTitle.count", count) : backgroundPanelTitle
  }

  static var inspectorNothingInBackground: String { L("inspector.nothingInBackground") }

  /// Stopka popovera „w tle" na iPadzie, gdy panel się mieści: przejście do tego samego widoku w panelu.
  static var backgroundOpenInPanel: String { L("inspector.backgroundOpenInPanel") }
  static let backgroundOpenInPanelShortcut = "⌘I"
  static var backgroundOpenInPanelSpoken: String { L("inspector.backgroundOpenInPanelSpoken") }

  // MARK: Skończone ostatnio

  static var inspectorFinishedTitle: String { L("inspector.finishedTitle") }

  /// Dopisek wyniku pod nazwą skończonego zadania („kod 1"): kod wyjścia przy niepowodzeniu, słowo
  /// przy zatrzymaniu i przy nieznanym wyniku (brak wyniku NIE znaczy sukcesu). Sukces dopisku nie ma.
  static func finishedTaskNote(outcome: NoticeOutcome?, exitCode: Int?) -> String? {
    switch outcome {
    case .done?, .waiting?: nil
    case .failed?: exitCode.map { L("inspector.finishedTaskNote.failed", $0) }
    case .halted?: L("inspector.finishedTaskNote.halted")
    case nil: L("inspector.finishedTaskNote.unknown")
    }
  }

  /// Wiersz na głos: rodzaj i nazwa, wynik, ile temu („2 godziny temu") i chwila („o 14:05", od doby „9 paź").
  static func finishedTaskSpoken(
    kind: String, name: String?, outcome: NoticeOutcome?, exitCode: Int?, ago: String?, stamp: String?
  ) -> String {
    let result: String =
      switch outcome {
      case .done?: L("inspector.finishedTaskSpoken.done")
      case .failed?: exitCode.map { L("inspector.finishedTaskSpoken.failedCode", $0) } ?? L("inspector.finishedTaskSpoken.failed")
      case .halted?: L("inspector.finishedTaskSpoken.halted")
      // Postój subagenta zakończeniem nie jest i `FinishedTasks.rows` go nie przepuszcza; gałąź domyka `switch`.
      case .waiting?: L("inspector.finishedTaskSpoken.waiting")
      case nil: L("inspector.finishedTaskSpoken.unknown")
      }
    let what = name.map { taskNamed(kind: kind, name: $0) } ?? kind
    return list([what, result, ago, stamp].compactMap { $0 }, .comma)
  }

  // MARK: Scheduled tasks

  static var inspectorScheduledTitle: String { L("inspector.scheduledTitle") }

  /// "once": first part of the muted line under a task that runs once.
  static func scheduledOnce(language: CopyLanguage = .current) -> String {
    L("inspector.scheduledOnce", language: language)
  }

  /// "every 5 min" on screen, "every 5 minutes" for VoiceOver.
  static func scheduledEveryMinutes(_ minutes: Int, language: CopyLanguage = .current) -> String {
    L("inspector.scheduledEveryMinutes", language: language, minutes)
  }

  static func scheduledEveryMinutesSpoken(_ minutes: Int, language: CopyLanguage = .current) -> String {
    L("inspector.scheduledEveryMinutesSpoken", language: language, minutes)
  }

  /// "hourly at :05" on screen, "every hour at minute 5" for VoiceOver.
  static func scheduledHourly(_ minute: Int, language: CopyLanguage = .current) -> String {
    L("inspector.scheduledHourly", language: language, minute)
  }

  static func scheduledHourlySpoken(_ minute: Int, language: CopyLanguage = .current) -> String {
    L("inspector.scheduledHourlySpoken", language: language, minute)
  }

  /// "daily 09:05", "weekdays 09:05": the time already formatted by the device region.
  static func scheduledDaily(_ clock: String, language: CopyLanguage = .current) -> String {
    L("inspector.scheduledDaily", language: language, clock)
  }

  static func scheduledWeekdays(_ clock: String, language: CopyLanguage = .current) -> String {
    L("inspector.scheduledWeekdays", language: language, clock)
  }

  /// "next 22:14" and "last 22:12" after the schedule of a repeating task.
  static func scheduledNext(_ clock: String, language: CopyLanguage = .current) -> String {
    L("inspector.scheduledNext", language: language, clock)
  }

  static func scheduledLast(_ clock: String, language: CopyLanguage = .current) -> String {
    L("inspector.scheduledLast", language: language, clock)
  }

  /// Spoken row: "Scheduled task Check the CI run, every 5 minutes, next 22:14".
  static func scheduledTaskSpoken(prompt: String, schedule: [String], language: CopyLanguage = .current) -> String {
    L("inspector.scheduledSpoken", language: language, prompt,
      schedule.joined(separator: L("app.list.comma", language: language)))
  }

  // MARK: Artefakty

  static var inspectorArtifactsTitle: String { L("inspector.artifactsTitle") }
  /// Pierwszy człon linii czasu wiersza usuniętego artefaktu („usunięty · 2 h temu · 14:05").
  static var artifactGone: String { L("inspector.artifactGone") }

  /// Wiersz na głos: „Artefakt Raport, opublikowany 2 godziny temu, o 14:05. Otwiera przeglądarkę.” — usunięty
  /// mówi to wprost i nie obiecuje przeglądarki; czas, który nie jest czasem, nie daje „opublikowany”.
  static func artifactSpoken(title: String, gone: Bool, opens: Bool, ago: String?, stamp: String?) -> String {
    let parts = [L("inspector.artifactSpoken.title", title), gone ? artifactGone : nil, ago.map { L("inspector.artifactSpoken.published", $0) }, stamp]
    let sentence = L("inspector.artifactSpoken.sentence", list(parts.compactMap { $0 }, .comma))
    return opens ? L("inspector.artifactSpoken.opens", sentence) : sentence
  }

  // MARK: Pull requesty

  static var inspectorPullRequestsTitle: String { L("inspector.pullRequestsTitle") }

  /// Godzina utworzenia na głos („o 14:05”).
  static func pullRequestSpokenAt(_ clock: String) -> String { L("inspector.pullRequestSpoken.at", clock) }

  /// GitHub state word, lowercase ("merged"): first part of the row's secondary line and a part of the spoken row.
  static func pullRequestState(_ state: PullRequestState, language: CopyLanguage = .current) -> String {
    switch state {
    case .open: L("inspector.pullRequestState.open", language: language)
    case .draft: L("inspector.pullRequestState.draft", language: language)
    case .merged: L("inspector.pullRequestState.merged", language: language)
    case .closed: L("inspector.pullRequestState.closed", language: language)
    }
  }

  /// Label of the row that folds merged and closed PRs at the end of the section.
  static var pullRequestsSettled: String { L("inspector.pullRequestsSettled") }

  /// Count beside that label, in brackets: "(3)".
  static func pullRequestsSettledCount(_ count: Int) -> String { L("inspector.pullRequestsSettledCount", count) }

  /// VoiceOver label of that row: "Merged and closed: 3".
  static func pullRequestsSettledSpoken(_ count: Int) -> String { L("inspector.pullRequestsSettledSpoken", count) }

  /// Spoken row: "Pull request acme/widget#42, Add export, merged, created 2 hours ago, at 14:05. Opens the
  /// browser." — without a title the reference alone, without a known state no state word; a time that is not a
  /// time gives no "created".
  static func pullRequestSpoken(
    ref: String, title: String?, state: String? = nil, opens: Bool, ago: String?, stamp: String?
  ) -> String {
    let created = ago.map { L("inspector.pullRequestSpoken.created", $0) }
    let parts = [L("inspector.pullRequestSpoken.ref", ref), title, state, created, stamp]
    let sentence = L("inspector.artifactSpoken.sentence", list(parts.compactMap { $0 }, .comma))
    return opens ? L("inspector.artifactSpoken.opens", sentence) : sentence
  }

  // MARK: Zmiany w katalogu

  /// „ZMIANY W KATALOGU · 3" — bez liczby, gdy jej nie znamy albo jest zerem.
  static func inspectorChangesTitle(_ count: Int?) -> String {
    let title = L("inspector.changesTitle")
    guard let count, count > 0 else { return title }
    return L("inspector.changesTitle.count", count)
  }

  /// „Czysto od 7cdfbe4b” — drzewo bez zmian względem commita.
  static func inspectorChangesClean(_ commit: String) -> String { L("inspector.changesClean", commit) }
  static var inspectorChangesCleanNoCommit: String { L("inspector.changesCleanNoCommit") }
  static var inspectorChangesNoData: String { L("inspector.changesNoData") }
  static func inspectorChangesShown(_ rows: Int, of total: Int) -> String { L("inspector.changesShown", rows, total) }
  static var inspectorBinary: String { L("inspector.binary") }

  /// Katalog drzewa zmian na głos: „katalog Sources/RarogUI/Switcher, 2 pliki".
  static func inspectorDirectorySpoken(label: String, files: Int) -> String {
    L("inspector.directorySpoken", label, files)
  }

  static var inspectorDirectoryExpanded: String { L("inspector.directoryExpanded") }
  static var inspectorDirectoryCollapsed: String { L("inspector.directoryCollapsed") }

  /// „+10 −10" przy zwiniętym katalogu (minus U+2212, jak przy pliku); zero i „nie wiem" nie tworzą członu.
  static func inspectorDirectorySum(added: Int?, deleted: Int?) -> String? {
    let parts = [added.flatMap { $0 > 0 ? "+\($0)" : nil }, deleted.flatMap { $0 > 0 ? "−\($0)" : nil }]
      .compactMap { $0 }
    // Same symbole i liczby („+10 −10”), nie zdanie: spacja nie jest tu rzeczą języka.
    return parts.isEmpty ? nil : parts.joined(separator: " ")
  }

  /// Wiersz pliku na głos: ścieżka, rodzaj i liczniki, a binarny — wprost, że linii git nie liczy.
  static func inspectorFileSpoken(
    path: String, status: DiffFileStatus?, added: Int?, deleted: Int?, binary: Bool
  ) -> String {
    let base = diffFileSpoken(path: path, status: status, added: added, deleted: deleted)
    return binary ? L("inspector.fileSpoken", base) : base
  }
}
